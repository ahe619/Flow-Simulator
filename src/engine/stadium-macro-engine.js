'use strict';

// Scene/demand adapter for the original Stage1 agent + shared grid-pressure
// model. Geometry, measured boundary arrivals and routes replace the synthetic
// two-sided source and artificial gate. Coordinates remain normalized units.
const Stage1 = require('./stage1-engine.js');
const EPS = 1e-9;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
function finite(v, name) {
  if (!Number.isFinite(v)) throw new TypeError(`${name} must be finite`);
  return v;
}
function point(p, name) {
  if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${name} must be [x,y]`);
  return p.map((v) => finite(v, name));
}
function polygon(p, name) {
  if (!Array.isArray(p) || p.length < 3) throw new TypeError(`${name} needs at least three vertices`);
  const q = p.map((v) => point(v, name));
  if (polygonArea(q) <= EPS) throw new RangeError(`${name} has zero area`);
  return q;
}
function segment(s, name) {
  const q = { p0: point(s.p0, `${name}.p0`), p1: point(s.p1, `${name}.p1`) };
  if (Math.hypot(q.p0[0] - q.p1[0], q.p0[1] - q.p1[1]) <= EPS) throw new RangeError(`${name} has zero length`);
  return q;
}
function wallGeometry(p, w) {
  const dx = w.p1[0] - w.p0[0], dy = w.p1[1] - w.p0[1], length = Math.hypot(dx, dy);
  const tx = dx / length, ty = dy / length;
  const along = (p.x - w.p0[0]) * tx + (p.y - w.p0[1]) * ty;
  const q = clamp(along, 0, length), x = w.p0[0] + q * tx, y = w.p0[1] + q * ty;
  const ex = p.x - x, ey = p.y - y, distance = Math.hypot(ex, ey);
  return { x, y, distance, along, length, tx, ty,
    signed: (p.x - w.p0[0]) * -ty + (p.y - w.p0[1]) * tx,
    nx: distance > EPS ? ex / distance : -ty, ny: distance > EPS ? ey / distance : tx };
}
function polygonArea(p) {
  return Math.abs(p.reduce((sum, q, i) => {
    const r = p[(i + 1) % p.length]; return sum + q[0] * r[1] - r[0] * q[1];
  }, 0)) / 2;
}
function pointInPolygon(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j], b = p[i];
    if (wallGeometry({ x, y }, { p0: a, p1: b }).distance < EPS) return true;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function crossing(a, b, wall) {
  const ga = wallGeometry(a, wall), gb = wallGeometry(b, wall);
  if (ga.signed * gb.signed >= 0 || Math.abs(ga.signed - gb.signed) < EPS) return null;
  const fraction = ga.signed / (ga.signed - gb.signed);
  const along = ga.along + fraction * (gb.along - ga.along);
  return along >= -EPS && along <= ga.length + EPS ? { fraction, from: Math.sign(ga.signed), to: Math.sign(gb.signed) } : null;
}
function pairNormal(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
  if (d > EPS) return { d, nx: dx / d, ny: dy / d };
  // String IDs are permitted. Deterministic tie break without ID modulo/NaN.
  return { d: 0, nx: String(a.id) < String(b.id) ? -1 : 1, ny: 0 };
}

class StadiumMacroEngine extends Stage1 {
  reset(options = {}) {
    const cfg = { ...(this.config || {}), ...options };
    const inputScene = cfg.scene;
    if (!inputScene) throw new TypeError('scene is required');
    const domainPolygon = polygon(inputScene.domainPolygon, 'domainPolygon');
    const floorPolygon = polygon(inputScene.floorPolygon || domainPolygon, 'floorPolygon');
    const occupancyPolygon = polygon(inputScene.occupancyPolygon || domainPolygon, 'occupancyPolygon');
    const routes = {};
    for (const [key, value] of Object.entries(inputScene.routes || {})) {
      const waypoints = (Array.isArray(value) ? value : value.waypoints).map((p) => point(p, `route ${key}`));
      if (!waypoints.length) throw new RangeError(`route ${key} is empty`);
      routes[key] = { waypoints, exitOnGoal: value.exitOnGoal === true, useAgentLane: value.useAgentLane === true };
    }
    const scene = { ...inputScene, domainPolygon, floorPolygon, occupancyPolygon, routes,
      walls: (inputScene.walls || []).map((w, i) => segment(w, `wall ${i}`)),
      mouth: inputScene.mouth ? { ...segment(inputScene.mouth, 'mouth'), inboundSign: inputScene.mouth.inboundSign ?? -1 } : null };
    if (scene.mouth && ![-1, 1].includes(scene.mouth.inboundSign)) throw new RangeError('mouth.inboundSign must be -1 or 1');
    const maxTime = cfg.maxTime ?? 120;
    // These original synthetic-scene settings only satisfy the inherited reset;
    // custom step, demand, geometry and projection never use them.
    super.reset({ ...cfg, scene, maxTime, radius: cfg.radius ?? .035,
      desiredSpeed: cfg.desiredSpeed ?? .4, maxAgents: cfg.maxAgents ?? 1000,
      gateOpenTime: 0, gateY: -.65, doorWidth: 1, arrivalRate: 1,
      arrivalDuration: maxTime, stopWhenDrained: cfg.stopWhenDrained ?? false,
      waypointRadius: cfg.waypointRadius ?? .07, relaxationTime: cfg.relaxationTime ?? .32,
      repulsionA: cfg.repulsionA ?? .8, repulsionB: cfg.repulsionB ?? .055,
      repulsionCutoff: cfg.repulsionCutoff ?? .45, overlapIterations: cfg.overlapIterations ?? 14 });
    for (const key of ['waypointRadius', 'relaxationTime', 'repulsionB', 'repulsionCutoff']) {
      if (finite(this.config[key], key) <= 0) throw new RangeError(`${key} must be positive`);
    }
    if (finite(this.config.repulsionA, 'repulsionA') < 0) throw new RangeError('repulsionA must be nonnegative');
    if (!Number.isInteger(this.config.overlapIterations) || this.config.overlapIterations < 0) throw new RangeError('overlapIterations must be a nonnegative integer');
    this.scene = scene;
    this.geometry = { ...scene, unit: 'W', radius: this.config.radius, artificialGateControl: false };
    this._domainArea = polygonArea(domainPolygon);
    this._occupancyArea = polygonArea(occupancyPolygon);
    const ids = new Set();
    const parseAgent = (a, initial) => {
      if (!(typeof a.id === 'string' || typeof a.id === 'number' && Number.isFinite(a.id)) || ids.has(a.id)) throw new RangeError('all initial and arrival IDs must be valid and unique');
      ids.add(a.id);
      const p = { ...a, x: finite(a.x, 'agent.x'), y: finite(a.y, 'agent.y'),
        vx: finite(a.vx ?? 0, 'agent.vx'), vy: finite(a.vy ?? 0, 'agent.vy'),
        speed: finite(a.speed ?? this.config.desiredSpeed, 'agent.speed'), r: this.config.radius,
        routeId: a.routeId, waypointIndex: a.waypointIndex ?? 0, lane: finite(a.lane ?? 0, 'agent.lane'),
        enteredAt: initial ? 0 : null, requestedAt: initial ? 0 : finite(a.time, 'arrival.time') };
      if (p.speed < 0 || p.requestedAt < 0 || p.requestedAt > maxTime) throw new RangeError('speed/time outside allowed range');
      if (!routes[p.routeId]) throw new RangeError(`unknown route ${p.routeId}`);
      if (!Number.isInteger(p.waypointIndex) || p.waypointIndex < 0 || p.waypointIndex >= routes[p.routeId].waypoints.length) throw new RangeError('waypointIndex outside route');
      if (!pointInPolygon(p.x, p.y, domainPolygon)) throw new RangeError(`agent ${a.id} begins outside domain`);
      return p;
    };
    this.agents = (cfg.initialAgents || []).map(a => parseAgent(a, true));
    this._schedule = (cfg.arrivals || []).map(a => parseAgent(a, false)).sort((a, b) => a.requestedAt - b.requestedAt);
    this._maxConfiguredPreferredSpeed = this.config.individualSpeedLimit
      ? Math.max(0, ...this.agents.map(a => a.speed), ...this._schedule.map(a => a.speed))
      : this.config.desiredSpeed;
    this._scheduleIndex = 0;
    this.initialCount = this.agents.length;
    this.requested = this.spawned = this.initialCount;
    this.crossingEvents = [];
    this.exitEvents = [];
    this.admissionEvents = [];
    this._substeps = this._agentSubsteps = this._pressurePositiveSubsteps = this._pressureEvaluations = 0;
    this._pressureMaxDensity = this._wallProjectionCount = this._wallCrossingPreventedCount = 0;
    this._localSpeedClipped = this._peakActive = this._initialWallPenetration = 0;
    this._blockedSourceIdentityAttempts = 0;
    this._infeasibleEntryIds = this._schedule.filter(a => !this.isContained(a.x, a.y, a.r)).map(a => a.id);
    this._maxWallPenetration = this._maxOverlapObserved = 0;
    this._mouthStates = new Map();
    for (const a of this.agents) {
      if (scene.mouth) this._mouthStates.set(a.id, { x: a.x, y: a.y, time: 0, sign: Math.sign(wallGeometry(a, scene.mouth).signed) });
      for (const wall of scene.walls) this._initialWallPenetration = Math.max(this._initialWallPenetration, a.r - wallGeometry(a, wall).distance);
    }
    this._initialOverlap = this._overlap();
    this._maxOverlapObserved = this._initialOverlap;
    this._peakActive = this.agents.length;
    this._demand(); this._admit();
    return this;
  }

  get gateClosed() { return false; }
  _gateIsBlocking() { return false; }
  _floorContains(x, y) { return pointInPolygon(x, y, this.scene.floorPolygon); }
  _isVisible(px, py, gx, gy) {
    // Stage1's shared cut-cell correction provides an accessible ray endpoint.
    // Numerical grid centres outside the floor are not automatically dropped.
    if (typeof this._pressureCell === 'function') {
      const cell = this._pressureCell(gx, gy, this.config.pressureGridSize);
      if (!cell.fraction) return false;
      gx = cell.targetX; gy = cell.targetY;
    } else if (!this._floorContains(gx, gy)) return false;
    if (this.scene.walls.some(w => crossing({ x: px, y: py }, { x: gx, y: gy }, w))) return false;
    for (const t of [.25, .5, .75]) if (!this._floorContains(px + t * (gx - px), py + t * (gy - py))) return false;
    return true;
  }
  isContained(x, y, radius = this.config.radius) {
    return pointInPolygon(x, y, this.scene.domainPolygon) && this.scene.walls.every(w => wallGeometry({ x, y }, w).distance >= radius - EPS);
  }
  _project(a, previous = a) {
    for (let iteration = 0; iteration < 3; iteration++) for (const wall of this.scene.walls) {
      const g = wallGeometry(a, wall), before = wallGeometry(previous, wall), crossed = crossing(previous, a, wall);
      if (!crossed && g.distance >= a.r - EPS) continue;
      let nx = g.nx, ny = g.ny, x = g.x, y = g.y;
      if (crossed || g.distance < EPS) {
        const sign = before.signed < 0 ? -1 : 1;
        nx = -g.ty * sign; ny = g.tx * sign;
        if (crossed && (g.along < 0 || g.along > g.length)) {
          x = previous.x + crossed.fraction * (a.x - previous.x);
          y = previous.y + crossed.fraction * (a.y - previous.y);
        }
      }
      const newX = x + nx * (a.r + 1e-10), newY = y + ny * (a.r + 1e-10);
      this._wallDisplacement += Math.hypot(newX - a.x, newY - a.y);
      this._wallProjectionCount++;
      if (crossed) this._wallCrossingPreventedCount++;
      a.x = newX; a.y = newY;
      const vn = a.vx * nx + a.vy * ny;
      if (vn < 0) { a.vx -= vn * nx; a.vy -= vn * ny; }
    }
  }
  _demand() {
    while (this._scheduleIndex < this._schedule.length && this._schedule[this._scheduleIndex].requestedAt <= this.time + EPS) {
      this._queue.push({ ...this._schedule[this._scheduleIndex++] }); this.requested++;
    }
    this.pending = this._queue.length;
  }
  _admit() {
    const remaining = [];
    // Separate observation-boundary entries do not block each other's queues.
    for (const a of this._queue) {
      // A fragmented observation may produce several boundary-entry episodes for
      // one source ID. Preserve its demand, but never duplicate that person live.
      if (a.sourceId !== undefined && a.sourceId !== null &&
          this.agents.some(b => b.sourceId === a.sourceId)) {
        this._blockedSourceIdentityAttempts++;
        remaining.push(a); continue;
      }
      const clear = this.agents.length < this.config.maxAgents && this.isContained(a.x, a.y, a.r) &&
        this.agents.every(b => Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r + .002);
      if (!clear) { remaining.push(a); continue; }
      a.enteredAt = this.time; this.agents.push(a); this.spawned++;
      this.admissionEvents.push({ id: a.id, time: this.time, requestedAt: a.requestedAt, delay: this.time - a.requestedAt });
      if (this.scene.mouth) this._mouthStates.set(a.id, { x: a.x, y: a.y, time: this.time, sign: Math.sign(wallGeometry(a, this.scene.mouth).signed) });
    }
    this._queue = remaining; this.pending = remaining.length;
    this._peakActive = Math.max(this._peakActive, this.agents.length);
  }
  _overlap() {
    let largest = 0;
    for (let i = 0; i < this.agents.length; i++) for (let j = i + 1; j < this.agents.length; j++) {
      largest = Math.max(largest, this.agents[i].r + this.agents[j].r - Math.hypot(this.agents[i].x - this.agents[j].x, this.agents[i].y - this.agents[j].y));
    }
    return largest;
  }
  _capSpeed(a) {
    const speed = Math.hypot(a.vx, a.vy), cap = this._agentSpeedLimit(a);
    if (speed > cap) { a.vx *= cap / speed; a.vy *= cap / speed; this._localSpeedClipped++; }
  }
  _routeGoal(a, index = a.waypointIndex) {
    const route = this.scene.routes[a.routeId], goal = route.waypoints[index];
    return [goal[0] + (route.useAgentLane ? a.lane : 0), goal[1]];
  }
  _advance(h) {
    const agents = this.agents, cfg = this.config, previous = agents.map(a => ({ x: a.x, y: a.y }));
    const t0 = this.time; this.time = Math.round((this.time + h) * 1e12) / 1e12;
    const forces = agents.map(a => {
      const route = this.scene.routes[a.routeId];
      while (a.waypointIndex < route.waypoints.length - 1 && Math.hypot(a.x - this._routeGoal(a)[0], a.y - this._routeGoal(a)[1]) < cfg.waypointRadius) a.waypointIndex++;
      const goal = this._routeGoal(a), dx = goal[0] - a.x, dy = goal[1] - a.y, d = Math.hypot(dx, dy);
      return { x: ((d > EPS ? a.speed * dx / d : 0) - a.vx) / cfg.relaxationTime,
        y: ((d > EPS ? a.speed * dy / d : 0) - a.vy) / cfg.relaxationTime };
    });
    const pairs = [];
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j], g = pairNormal(a, b);
      if (g.d > Math.max(cfg.repulsionCutoff + .1, 2 * cfg.radius + 2 * this._maxConfiguredPreferredSpeed * h * 1.55)) continue;
      if (this.scene.walls.some(w => crossing(a, b, w))) continue;
      pairs.push([i, j]);
      if (g.d > cfg.repulsionCutoff) continue;
      const force = Math.min(4, cfg.repulsionA * Math.exp((a.r + b.r - g.d) / cfg.repulsionB));
      forces[i].x += g.nx * force; forces[i].y += g.ny * force;
      forces[j].x -= g.nx * force; forces[j].y -= g.ny * force;
    }
    for (let i = 0; i < agents.length; i++) {
      agents[i].vx += forces[i].x * h; agents[i].vy += forces[i].y * h; this._capSpeed(agents[i]);
    }
    // Exact original Stage1 grid energy, deposition, feedback and clipping.
    super._beforeAdvection(agents, h);
    this._pressureEvaluations++; this._agentSubsteps += agents.length;
    if (this._field.metrics.maxPressure > 0) this._pressurePositiveSubsteps++;
    this._pressureMaxDensity = Math.max(this._pressureMaxDensity, this._field.metrics.maxDensity || 0);
    const velocityBeforeProjection = agents.map(a => ({ vx: a.vx, vy: a.vy }));
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i]; a.x += a.vx * h; a.y += a.vy * h; this._project(a, previous[i]);
    }
    for (let iteration = 0; iteration < cfg.overlapIterations; iteration++) {
      let largest = 0;
      for (const [i, j] of pairs) {
        const a = agents[i], b = agents[j], g = pairNormal(a, b), overlap = a.r + b.r - g.d;
        if (overlap <= 0) continue;
        const oldA = { x: a.x, y: a.y }, oldB = { x: b.x, y: b.y }, shift = .5 * (overlap + 1e-6);
        a.x += shift * g.nx; a.y += shift * g.ny; b.x -= shift * g.nx; b.y -= shift * g.ny;
        this._project(a, oldA); this._project(b, oldB); largest = Math.max(largest, overlap);
      }
      if (largest < .0001) break;
    }
    this._lastMaxDisplacementSpeed = 0;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i], old = previous[i], dx = a.x - old.x, dy = a.y - old.y;
      this._constraintDisplacement += Math.hypot(dx - velocityBeforeProjection[i].vx * h, dy - velocityBeforeProjection[i].vy * h);
      this._lastMaxDisplacementSpeed = Math.max(this._lastMaxDisplacementSpeed, Math.hypot(dx, dy) / h);
      a.vx = dx / h; a.vy = dy / h; this._capSpeed(a);
      for (const k of ['x', 'y', 'vx', 'vy']) finite(a[k], `agent ${a.id}.${k}`);
      for (const w of this.scene.walls) this._maxWallPenetration = Math.max(this._maxWallPenetration, a.r - wallGeometry(a, w).distance);
      if (this.scene.mouth) {
        const signed = wallGeometry(a, this.scene.mouth).signed;
        const sign = Math.abs(signed) < 1e-10 ? 0 : Math.sign(signed);
        const last = this._mouthStates.get(a.id);
        // Preserve the last nonzero side when a sampled step lands on the line.
        const c = sign && last?.sign && sign !== last.sign ? crossing(last, a, this.scene.mouth) : null;
        if (c) this.crossingEvents.push({ id: a.id, time: last.time + c.fraction * (this.time - last.time),
          direction: c.to === this.scene.mouth.inboundSign ? 'into' : 'out',
          x: last.x + c.fraction * (a.x - last.x), y: last.y + c.fraction * (a.y - last.y) });
        if (sign) this._mouthStates.set(a.id, { x: a.x, y: a.y, time: this.time, sign });
      }
    }
    this._maxDisplacementSpeed = Math.max(this._maxDisplacementSpeed, this._lastMaxDisplacementSpeed);
    this._maxOverlapObserved = Math.max(this._maxOverlapObserved, this._overlap());
    this.agents = agents.filter(a => {
      const route = this.scene.routes[a.routeId], final = this._routeGoal(a, route.waypoints.length - 1);
      const outside = !pointInPolygon(a.x, a.y, this.scene.domainPolygon);
      const goalReached = route.exitOnGoal && a.waypointIndex === route.waypoints.length - 1 && Math.hypot(a.x - final[0], a.y - final[1]) <= cfg.waypointRadius;
      if (!outside && !goalReached) return true;
      this.exited++; this._exitTimes.push(this.time);
      this._travelTotal += this.time - a.enteredAt; this._systemTotal += this.time - a.requestedAt;
      this.exitEvents.push({ id: a.id, time: this.time, reason: outside ? 'open-domain-boundary' : 'route-goal', x: a.x, y: a.y });
      return false;
    });
    this._substeps++; this._demand(); this._admit();
    const drained = this._scheduleIndex === this._schedule.length && this.agents.length === 0 && this.pending === 0;
    this.finished = this.time >= cfg.maxTime - EPS || cfg.stopWhenDrained && drained;
  }
  step(dt) {
    if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be nonnegative and finite');
    const cap = Math.min(this.config.dtMax, this.config.radius / (this._maxConfiguredPreferredSpeed * 2));
    let left = dt;
    while (left > 1e-10 && !this.finished) {
      this._demand(); this._admit();
      const nextArrival = this._schedule[this._scheduleIndex]?.requestedAt ?? Infinity;
      const h = Math.min(cap, left, this.config.maxTime - this.time, nextArrival - this.time);
      if (h <= 1e-10) { this.finished = this.time >= this.config.maxTime - EPS; if (this.finished) break; throw new Error('time failed to advance'); }
      this._advance(h); left -= h;
    }
    return this;
  }
  metrics() {
    const occupied = this.agents.filter(a => pointInPolygon(a.x, a.y, this.scene.occupancyPolygon));
    const into = this.crossingEvents.filter(e => e.direction === 'into').length, out = this.crossingEvents.length - into;
    return { time: this.time, active: this.agents.length, occupancy: occupied.length,
      meanSpeed: occupied.length ? occupied.reduce((s, a) => s + Math.hypot(a.vx, a.vy), 0) / occupied.length : null,
      domainArea: this._domainArea, occupancyArea: this._occupancyArea, density: occupied.length / this._occupancyArea,
      initialCount: this.initialCount, requested: this.requested, admitted: this.spawned, spawned: this.spawned,
      arrivalRequested: this.requested - this.initialCount, arrivalAdmitted: this.spawned - this.initialCount,
      scheduledArrivalCount: this._schedule.length, futureScheduled: this._schedule.length - this._scheduleIndex,
      blockedSourceIdentityAttempts: this._blockedSourceIdentityAttempts,
      blockedSourceIdentityAttemptDefinition: 'Repeated admission attempts, not a count of distinct people or episodes',
      infeasibleEntryCount: this._infeasibleEntryIds.length,
      infeasibleEntryIds: this._infeasibleEntryIds.slice(),
      infeasibleEntryDefinition: 'Scheduled entry positions without static disk clearance from a physical wall; retained pending, never relocated or dropped',
      pending: this.pending, exited: this.exited, peakActive: this._peakActive, mouthInto: into, mouthOut: out,
      conservationError: this.requested - this.agents.length - this.exited - this.pending,
      admissionConservationError: this.spawned - this.agents.length - this.exited,
      finished: this.finished, termination: this.finished ? (this.time >= this.config.maxTime - EPS ? 'horizon' : 'drained') : null,
      feedbackOn: this.config.feedbackOn, artificialGateControl: false,
      individualSpeedLimit: this.config.individualSpeedLimit,
      maxConfiguredPreferredSpeed: this._maxConfiguredPreferredSpeed,
      speedLimitDefinition: this.config.individualSpeedLimit ? '1.55 times each agent preferred speed' : '1.55 times global desiredSpeed',
      pressureMax: this._lastPressureMax, pressurePeak: this._pressurePeak, pressureMaxDensity: this._pressureMaxDensity,
      pressureEvaluations: this._pressureEvaluations, pressurePositiveSubsteps: this._pressurePositiveSubsteps,
      pressureActiveFraction: this._pressureEvaluations ? this._pressurePositiveSubsteps / this._pressureEvaluations : 0,
      agentSubsteps: this._agentSubsteps, feedbackApplied: this._feedbackApplied,
      feedbackAppliedFraction: this._agentSubsteps ? this._feedbackApplied / this._agentSubsteps : 0,
      feedbackDeltaSpeedTotal: this._feedbackDeltaSpeedTotal, pressureClampCount: this._feedbackClipped,
      pressureSpeedClampCount: this._speedClipped, localSpeedClampCount: this._localSpeedClipped,
      pressurePeakDeltaSpeed: this._peakDv, unsupportedParticlePeak: this._unsupportedParticlePeak,
      unrepresentedOccupancy: this._unrepresentedOccupancy, initialOverlap: this._initialOverlap,
      maxOverlap: this._overlap(), maxOverlapObserved: this._maxOverlapObserved,
      initialWallPenetration: this._initialWallPenetration, maxWallPenetrationAfterProjection: this._maxWallPenetration,
      wallProjectionCount: this._wallProjectionCount, wallCrossingPreventedCount: this._wallCrossingPreventedCount,
      wallProjectionDisplacementTotal: this._wallDisplacement, constraintDisplacementTotal: this._constraintDisplacement,
      maxDisplacementSpeed: this._maxDisplacementSpeed, substeps: this._substeps,
      fluxDefinition: 'bidirectional centre crossings of the finite observed mouth segment; domain exits are separate',
      units: { length: 'camera-local normalized W', time: 'seconds', density: 'agents/W^2', speed: 'W/s' } };
  }
}
StadiumMacroEngine.geometry = { pointInPolygon, polygonArea, wallGeometry, crossing };
module.exports = StadiumMacroEngine;
