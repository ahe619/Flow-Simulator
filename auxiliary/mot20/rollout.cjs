'use strict';

// Open-plane MOT20 rollout using the shared Stage1 congestion feedback.
const { OpenPlaneStage1Pressure } = require('./stage1_adapter.cjs');

// A deliberately small free-plane control, not a complete implementation of
// the social-force model. Parameters are loaded from the archived MOT20 protocol.
const DEFAULTS = Object.freeze({
  method: 'cv', fps: 7, steps: 28, dtMax: 0.02,
  tau: 0.5, repulsionA: 2, repulsionB: 0.2, repulsionCutoff: 2,
  radius: 0.25, overlapIterations: 14,
  pressureGridSize: 0.6, pressureGridOrigin: Object.freeze([0, 0]),
  pressureKernelH: 1.5,
  pressureRho0: 2, pressureStiffness: 0.5,
  pressureAccelerationLimit: 4, speedLimit: 3
});

function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function configuration(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const cfg = { ...DEFAULTS, ...options };
  if (!['cv', 'agent', 'agent_stage1'].includes(cfg.method)) {
    throw new RangeError('method must be cv, agent, or agent_stage1');
  }
  for (const key of ['fps', 'dtMax', 'tau', 'repulsionB', 'repulsionCutoff',
    'pressureGridSize', 'pressureKernelH', 'pressureRho0', 'speedLimit']) {
    if (finite(cfg[key], key) <= 0) throw new RangeError(`${key} must be positive`);
  }
  for (const key of ['repulsionA', 'radius', 'pressureStiffness', 'pressureAccelerationLimit']) {
    if (finite(cfg[key], key) < 0) throw new RangeError(`${key} must be nonnegative`);
  }
  for (const key of ['steps', 'overlapIterations']) {
    if (!Number.isSafeInteger(cfg[key]) || cfg[key] < 0) {
      throw new RangeError(`${key} must be a nonnegative safe integer`);
    }
  }
  if (!Array.isArray(cfg.pressureGridOrigin) || cfg.pressureGridOrigin.length !== 2) {
    throw new TypeError('pressureGridOrigin must be [x, y]');
  }
  cfg.pressureGridOrigin = cfg.pressureGridOrigin.map((v, i) => finite(v, `pressureGridOrigin[${i}]`));
  finite(cfg.steps / cfg.fps, 'duration');
  return cfg;
}

function copyAgents(initialAgents) {
  if (!Array.isArray(initialAgents)) throw new TypeError('initialAgents must be an array');
  const ids = new Set();
  return initialAgents.map((a, i) => {
    if (!a || typeof a !== 'object') throw new TypeError(`agent ${i} must be an object`);
    if (!(typeof a.id === 'string' || typeof a.id === 'number' && Number.isFinite(a.id))) {
      throw new TypeError(`agent ${i} id must be a string or finite number`);
    }
    if (ids.has(a.id)) throw new RangeError('agent ids must be unique');
    ids.add(a.id);
    const copy = { id: a.id };
    for (const key of ['x', 'y', 'vx', 'vy']) copy[key] = finite(a[key], `agent ${i}.${key}`);
    return copy;
  });
}

function snapshot(agents) {
  return agents.map(({ id, x, y, vx, vy }) => ({ id, x, y, vx, vy }));
}

// Exactly coincident agents need a deterministic normal. It is antisymmetric
// under exchanging the two ids and introduces no random state or future data.
function pairGeometry(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  const distance = Math.hypot(dx, dy);
  if (distance > 0) return { distance, nx: dx / distance, ny: dy / distance };
  const ka = `${typeof a.id}:${a.id}`, kb = `${typeof b.id}:${b.id}`;
  const key = ka < kb ? `${ka}\0${kb}` : `${kb}\0${ka}`;
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  const angle = (hash >>> 0) / 4294967296 * 2 * Math.PI;
  const sign = ka < kb ? 1 : -1;
  return { distance: 0, nx: sign * Math.cos(angle), ny: sign * Math.sin(angle) };
}

function maximumOverlap(agents, diameter) {
  let max = 0;
  for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
    max = Math.max(max, diameter - Math.hypot(agents[i].x - agents[j].x, agents[i].y - agents[j].y));
  }
  return max;
}

// Minimum pair distance over a simultaneous straight displacement, including
// interior points. This avoids missing a CV encounter between sampled frames.
function sweptPairOverlap(a, b, ax, ay, bx, by, diameter) {
  const rx = a.x - b.x, ry = a.y - b.y, dx = ax - bx, dy = ay - by;
  const length = Math.hypot(dx, dy);
  const u = length === 0 ? 0 : Math.max(0, Math.min(1,
    -(rx * (dx / length) + ry * (dy / length)) / length));
  return Math.max(0, diameter - Math.hypot(rx + u * dx, ry + u * dy));
}

/**
 * rollout(initialAgents, options) -> {frames, diagnostics}
 * Input agents are {id,x,y,vx,vy}, with consistent length units and unit/s
 * velocities (U and U/s in the normalized MOT20 pilot). Only these initial
 * estimates are used. Preferred velocity remains the
 * initial velocity throughout: no walls, goals, future observations, spawning,
 * or removal. frames[0] is an unchanged copy; frames[k] samples k/fps seconds.
 *
 * cv: exact x0+v0*t, without speed clipping or contact correction.
 * agent: dv = dt*((vPreferred-v)/tau + sum A*exp((2r-distance)/B)*normal)
 * for unordered pairs within repulsionCutoff. Pair forces are equal/opposite.
 * agent_stage1: identical agent step plus CURRENT Stage1._beforeAdvection;
 * both agent arms first use the legacy local speed cap; the inherited hook
 * applies its acceleration cap and the same total-speed cap again.
 * This file contains no particle/SPH force implementation.
 * All agent methods use semi-implicit Euler advection then symmetric disk
 * overlap projection. Projection changes positions only; its displacement is
 * recorded separately and never hidden inside the velocity-speed cap.
 */
function rollout(initialAgents, options = {}) {
  const cfg = configuration(options);
  const agents = copyAgents(initialAgents), initial = snapshot(agents);
  const preferred = initial.map(a => ({ vx: a.vx, vy: a.vy }));
  const pressureService = cfg.method === 'agent_stage1' ? new OpenPlaneStage1Pressure(cfg) : null;
  const diameter = 2 * cfg.radius;
  const initialOverlap = maximumOverlap(agents, diameter);
  const d = {
    config: cfg, finite: true, initialCount: agents.length, finalCount: agents.length,
    minCount: agents.length, maxCount: agents.length, removedCount: 0, addedCount: 0,
    populationConserved: true, sampleTimes: [0], endTime: cfg.steps / cfg.fps,
    substeps: 0, maxSubstep: 0, minSubstep: 0,
    maxInitialOverlap: initialOverlap, maxFinalOverlap: initialOverlap,
    maxOverlap: initialOverlap, maxOverlapAfterContact: 0,
    overlapSampling: 'Exact closest approach along CV, each advection segment and each contact projection segment.',
    pairRepulsionCount: 0, pairRepulsionVelocityCorrectionTotal: 0,
    pressureEvaluations: 0, pressureAppliedAgentSubsteps: 0,
    pressureVelocityCorrectionTotal: 0, pressureMaxDeltaSpeed: 0,
    pressureVelocityCorrectionStage: 'Actual pressure velocity difference after acceleration and Stage1 speed caps; local common speed cap occurs before hook.',
    pressureAccelerationClampCount: 0, pressureAccelerationClipTotal: 0,
    pressureNetForceBeforeCapMax: 0, pressureNetForceAfterCapMax: 0,
    pressureNetImpulseBeforeCapX: 0, pressureNetImpulseBeforeCapY: 0,
    pressureNetImpulseAfterCapX: 0, pressureNetImpulseAfterCapY: 0,
    pressureNetForceAccountingStage: 'Raw pressure gradient versus actual hook increment after acceleration/speed caps; local speed cap precedes hook.',
    pressureMaxDensity: 0, pressureMaxPressure: 0, pressureMaxEnergy: 0,
    unsupportedParticleCount: 0,
    speedClampCount: 0, speedClampDeltaSpeedTotal: 0,
    contactCorrectionCount: 0, contactDisplacementTotal: 0,
    maxContactDisplacementPerAgentSubstep: 0, maxDisplacementSpeed: 0,
    maxVelocitySpeed: initial.reduce((m, a) => Math.max(m, Math.hypot(a.vx, a.vy)), 0),
    assumptions: 'Fixed initial preferred velocity; free plane; fixed population; no future destinations; fixed uncalibrated parameters.'
  };
  const frames = [snapshot(agents)];
  if (cfg.method === 'cv') {
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      d.maxOverlap = Math.max(d.maxOverlap, sweptPairOverlap(agents[i], agents[j],
        agents[i].vx * d.endTime, agents[i].vy * d.endTime,
        agents[j].vx * d.endTime, agents[j].vy * d.endTime, diameter));
    }
  }

  function audit() {
    for (const a of agents) for (const key of ['x', 'y', 'vx', 'vy']) {
      finite(a[key], `nonfinite rollout state: ${key}`);
    }
    d.minCount = Math.min(d.minCount, agents.length);
    d.maxCount = Math.max(d.maxCount, agents.length);
  }

  function advance(dt) {
    const oldPositions = agents.map(a => ({ x: a.x, y: a.y }));
    const ax = agents.map((a, i) => (preferred[i].vx - a.vx) / cfg.tau);
    const ay = agents.map((a, i) => (preferred[i].vy - a.vy) / cfg.tau);
    if (cfg.repulsionA > 0) {
      for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
        const g = pairGeometry(agents[i], agents[j]);
        if (g.distance >= cfg.repulsionCutoff) continue;
        const force = finite(cfg.repulsionA * Math.exp((diameter - g.distance) / cfg.repulsionB), 'pair acceleration');
        ax[i] += force * g.nx; ay[i] += force * g.ny;
        ax[j] -= force * g.nx; ay[j] -= force * g.ny;
        d.pairRepulsionCount++;
        // Additive pair budget, before cancellation across different pairs.
        d.pairRepulsionVelocityCorrectionTotal += 2 * force * dt;
      }
    }
    for (let i = 0; i < agents.length; i++) {
      agents[i].vx += ax[i] * dt; agents[i].vy += ay[i] * dt;
    }
    for (const a of agents) {
      const speed = Math.hypot(a.vx, a.vy);
      finite(speed, 'velocity speed');
      if (speed > cfg.speedLimit) {
        const scale = cfg.speedLimit / speed;
        a.vx *= scale; a.vy *= scale;
        d.speedClampCount++;
        d.speedClampDeltaSpeedTotal += speed - cfg.speedLimit;
      }
      d.maxVelocitySpeed = Math.max(d.maxVelocitySpeed, Math.hypot(a.vx, a.vy));
    }
    if (pressureService) {
      const before = agents.map(a => ({ vx: a.vx, vy: a.vy }));
      const field = pressureService.apply(agents, dt);
      d.pressureEvaluations++;
      d.pressureMaxDensity = Math.max(d.pressureMaxDensity, field.metrics.maxDensity);
      d.pressureMaxPressure = Math.max(d.pressureMaxPressure, field.metrics.maxPressure);
      d.pressureMaxEnergy = Math.max(d.pressureMaxEnergy, field.metrics.energy);
      d.unsupportedParticleCount += field.metrics.unsupportedParticleCount ?? 0;
      d.pressureAppliedAgentSubsteps = pressureService._feedbackApplied;
      d.pressureVelocityCorrectionTotal = pressureService._feedbackDeltaSpeedTotal;
      d.pressureAccelerationClampCount = pressureService._feedbackClipped;
      d.pressureMaxDeltaSpeed = pressureService._peakDv;
      let rawX = field.metrics.totalForceX * dt, rawY = field.metrics.totalForceY * dt, appliedX = 0, appliedY = 0;
      d.pressureAccelerationClipTotal = null; // Hook exports counts, not summed clipped magnitudes.
      d.pressureSpeedClampCount = pressureService._speedClipped;
      // Diagnostic accounting only; the inherited Stage1 hook already mutated velocities.
      for (let i = 0; i < agents.length; i++) {
        appliedX += agents[i].vx - before[i].vx; appliedY += agents[i].vy - before[i].vy;
        d.maxVelocitySpeed = Math.max(d.maxVelocitySpeed, Math.hypot(agents[i].vx, agents[i].vy));
      }
      d.pressureNetForceBeforeCapMax = Math.max(d.pressureNetForceBeforeCapMax, Math.hypot(rawX, rawY) / dt);
      d.pressureNetForceAfterCapMax = Math.max(d.pressureNetForceAfterCapMax, Math.hypot(appliedX, appliedY) / dt);
      d.pressureNetImpulseBeforeCapX += rawX; d.pressureNetImpulseBeforeCapY += rawY;
      d.pressureNetImpulseAfterCapX += appliedX; d.pressureNetImpulseAfterCapY += appliedY;
    }
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      d.maxOverlap = Math.max(d.maxOverlap, sweptPairOverlap(agents[i], agents[j],
        dt * agents[i].vx, dt * agents[i].vy, dt * agents[j].vx, dt * agents[j].vy, diameter));
    }
    for (const a of agents) { a.x += dt * a.vx; a.y += dt * a.vy; }
    audit();
    d.maxOverlap = Math.max(d.maxOverlap, maximumOverlap(agents, diameter));
    const contactBudgets = agents.map(() => 0);
    for (let iteration = 0; iteration < cfg.overlapIterations; iteration++) {
      let changed = false;
      for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i], b = agents[j], g = pairGeometry(a, b);
        const overlap = diameter - g.distance;
        if (overlap <= 0) continue;
        const shift = 0.5 * overlap;
        // Only pairs touching a moved disk can gain overlap. Check their
        // entire projection segments before applying the symmetric motion.
        for (let k = 0; k < agents.length; k++) {
          if (k === i || k === j) continue;
          d.maxOverlap = Math.max(d.maxOverlap,
            sweptPairOverlap(a, agents[k], shift * g.nx, shift * g.ny, 0, 0, diameter),
            sweptPairOverlap(b, agents[k], -shift * g.nx, -shift * g.ny, 0, 0, diameter));
        }
        a.x += shift * g.nx; a.y += shift * g.ny;
        b.x -= shift * g.nx; b.y -= shift * g.ny;
        d.contactCorrectionCount++; d.contactDisplacementTotal += overlap;
        contactBudgets[i] += shift; contactBudgets[j] += shift;
        changed = true;
      }
      if (!changed) break;
    }
    audit();
    d.maxOverlapAfterContact = Math.max(d.maxOverlapAfterContact, maximumOverlap(agents, diameter));
    for (let i = 0; i < agents.length; i++) {
      d.maxContactDisplacementPerAgentSubstep = Math.max(d.maxContactDisplacementPerAgentSubstep, contactBudgets[i]);
      d.maxDisplacementSpeed = Math.max(d.maxDisplacementSpeed,
        Math.hypot(agents[i].x - oldPositions[i].x, agents[i].y - oldPositions[i].y) / dt);
    }
    d.substeps++;
    d.maxSubstep = Math.max(d.maxSubstep, dt);
    d.minSubstep = d.substeps === 1 ? dt : Math.min(d.minSubstep, dt);
  }

  for (let sample = 1; sample <= cfg.steps; sample++) {
    const target = sample / cfg.fps;
    if (cfg.method === 'cv') {
      for (let i = 0; i < agents.length; i++) {
        agents[i].x = initial[i].x + initial[i].vx * target;
        agents[i].y = initial[i].y + initial[i].vy * target;
      }
      audit();
      d.maxOverlap = Math.max(d.maxOverlap, maximumOverlap(agents, diameter));
      d.maxDisplacementSpeed = d.maxVelocitySpeed;
    } else {
      // Use the exact declared interval, not subtraction of two rounded sample
      // times: 25 Hz / .02 s must always use two steps, never alternating 2/3.
      // Output sample labels remain derived independently as sample / fps.
      const duration = 1 / cfg.fps;
      const count = Math.ceil(duration / cfg.dtMax);
      if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('dtMax requires an invalid substep count');
      const dt = duration / count;
      for (let step = 0; step < count; step++) advance(dt);
    }
    frames.push(snapshot(agents));
    d.sampleTimes.push(target);
  }
  d.agentSubsteps = d.substeps * agents.length;
  d.pressureAppliedFraction = d.agentSubsteps ? d.pressureAppliedAgentSubsteps / d.agentSubsteps : 0;
  d.pressureHook = cfg.method === 'agent_stage1' ? 'Stage1Engine.prototype._beforeAdvection (inherited, unchanged)' : null;
  d.openPlane = true;
  d.commonSpeedCapStage = 'Legacy local total-speed cap before Stage1 hook in both agent arms; pressure hook then applies same speed cap and counts its actual increment';
  d.maxFinalOverlap = maximumOverlap(agents, diameter);
  d.finalCount = agents.length;
  d.populationConserved = d.initialCount === d.finalCount && d.minCount === d.maxCount;
  for (const [name, value] of Object.entries(d)) {
    if (typeof value === 'number') finite(value, `diagnostics.${name}`);
  }
  return { frames, diagnostics: d };
}

module.exports = { rollout, DEFAULTS };
