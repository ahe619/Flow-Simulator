'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Stage1Engine = require('../src/engine/stage1-engine.js');
const CrowdEngine = require('../src/engine/engine.js');

function verify(e, before) {
  const m = e.metrics();
  assert.equal(m.conservationError, 0, 'demand = active + exited + external queue');
  assert.equal(m.admissionConservationError, 0, 'admitted = active + exited');
  assert.equal(m.unsupportedParticleCount, 0, 'each agent has accessible grid support');
  for (const a of e.agents) {
    assert.ok(['x', 'y', 'vx', 'vy'].every(k => Number.isFinite(a[k])), 'finite state');
    assert.ok(e.isContained(a.x, a.y, a.r), 'finite-radius containment: ' + JSON.stringify(a));
    if (before && before.has(a.id)) {
      const p = before.get(a.id);
      assert.ok(Math.hypot(a.x - p.x, a.y - p.y) < 0.07, 'no large per-substep teleport');
    }
  }
  assert.ok(m.maxOverlap < 0.012, 'bounded residual contact overlap: ' + m.maxOverlap);
  assert.ok(Number.isFinite(m.maxDisplacementSpeed));
  assert.doesNotThrow(() => JSON.stringify(m));
}

test('controlled gate blocks initial crowd, then both feedback arms drain with identical demand', () => {
  const off = new Stage1Engine({ feedbackOn: false });
  const on = new Stage1Engine({ feedbackOn: true });
  for (const e of [off, on]) {
    while (!e.finished) {
      const before = new Map(e.agents.map(a => [a.id, { x: a.x, y: a.y }]));
      e.step(0.02);
      verify(e, before);
      if (e.time <= e.config.gateOpenTime + 1e-9) {
        assert.equal(e.exited, 0, 'closed gate has no upstream crossings');
        for (const a of e.agents) assert.ok(a.y >= e.config.gateY + a.r - 1e-8);
      }
    }
    assert.equal(e.requested, 96);
    assert.equal(e.exited, 96);
    assert.equal(e.pending, 0);
    assert.equal(e.metrics().termination, 'drained');
    assert.ok(e.time <= 100);
  }
  assert.equal(off.metrics().feedbackApplied, 0);
  assert.equal(off.metrics().feedbackDeltaSpeedTotal, 0);
  assert.ok(on.metrics().feedbackApplied > 0, 'nonzero feedback actually applied');
  assert.ok(on.metrics().feedbackDeltaSpeedTotal > 0);
  assert.ok(on.metrics().pressurePeak > 0, 'pressure became active');
  assert.notEqual(on.metrics().meanTravelTime, off.metrics().meanTravelTime, 'closed loop changes motion');
});

test('S1 replays exactly after reset and retains grid origin', () => {
  const e = new Stage1Engine({ pressureGridOrigin: [0.14, 0.14] });
  for (let k = 0; k < 1200; k++) e.step(0.02);
  const state = JSON.stringify({ agents: e.agents, metrics: e.metrics(), field: e.getField() });
  e.reset();
  for (let k = 0; k < 1200; k++) e.step(0.02);
  assert.equal(JSON.stringify({ agents: e.agents, metrics: e.metrics(), field: e.getField() }), state);
  assert.deepEqual(e.getField().origin, [0.14, 0.14]);
});

test('disabled pressure and an always-open gate preserve the base movement exactly', () => {
  const cfg = { ...Stage1Engine.DEFAULTS, feedbackOn: false, gateOpenTime: 0 };
  const base = new CrowdEngine(cfg), s1 = new Stage1Engine(cfg);
  for (let k = 0; k < 600; k++) { base.step(0.02); s1.step(0.02); }
  assert.deepEqual(s1.agents, base.agents);
  for (const key of ['time', 'exited', 'spawned', 'pending', 'requested']) assert.equal(s1[key], base[key]);
});

test('external queue is retained under admission limits and all event times are split exactly', () => {
  const e = new Stage1Engine({ maxAgents: 2, gateOpenTime: 0.031, arrivalDuration: 0.079,
    arrivalRate: 100, maxTime: 0.137, feedbackOn: false });
  const times = [];
  const original = e._beforeAdvection.bind(e);
  e._beforeAdvection = (agents, dt) => { times.push({ time: e.time, dt }); original(agents, dt); };
  e.step(1);
  verify(e);
  assert.equal(e.time, 0.137);
  for (const event of [0.031, 0.079, 0.137]) assert.ok(times.some(s => Math.abs(s.time - event) < 1e-10));
  assert.ok(times.every(s => s.dt <= 0.02 + 1e-12));
  assert.equal(e.requested, 7);
  assert.equal(e.pending, 5);
  assert.equal(e.metrics().termination, 'timeout');
});

test('agents already below the initially closed gate can continue to the one-way exit', () => {
  const e = new Stage1Engine({ arrivalRate: 0.01, feedbackOn: false });
  e.agents = [{ id: 100, x: 0, y: -1.65, vx: 0, vy: -0.4, r: 0.07,
    lane: 0, speed: 0.4, enteredAt: 0, requestedAt: 0 }];
  e.requested = e.spawned = 1;
  while (e.time < 1) { e.step(0.02); verify(e); }
  assert.equal(e.exited, 1);
  assert.equal(e.agents.length, 0);
  assert.equal(e.gateClosed, true);
  e.step(1);
  assert.equal(e.exited, 1, 'one agent contributes exactly one exit');
});

test('wall visibility and controls reject invalid configurations', () => {
  const e = new Stage1Engine();
  assert.equal(e._isVisible(1, 0.2, 0.25, -0.2), false, 'cannot transmit through doorway wall');
  assert.equal(e._isVisible(0.2, -0.1, 0.56, 0), false, 'endpoint on shoulder plane cannot bypass wall');
  assert.equal(e._isVisible(0.56, 0, 0.2, -0.1), false, 'shoulder visibility is symmetric');
  assert.equal(e._isVisible(0.2, -0.1, 0.28, 0), true, 'doorway-plane endpoint in aperture is visible');
  assert.equal(e._isVisible(0, -0.5, 0, -0.8), false, 'cannot transmit through closed gate');
  assert.equal(e.isContained(0, e.config.gateY), false);
  assert.throws(() => e.step(NaN), RangeError);
  assert.throws(() => new Stage1Engine({ dtMax: 0.03 }), RangeError);
  assert.throws(() => new Stage1Engine({ pressureGridOrigin: [NaN, 0] }), TypeError);
});

test('sparse open-gate control has only a small discretization effect and drains both arms', () => {
  const arms = [false, true].map(feedbackOn => new Stage1Engine({ feedbackOn,
    gateOpenTime: 0, arrivalRate: 0.4, arrivalDuration: 10 }));
  for (const e of arms) {
    while (!e.finished) { e.step(0.02); verify(e); }
    assert.equal(e.exited, 4);
    assert.equal(e.metrics().unsupportedParticlePeak, 0);
    assert.deepEqual(e.getField().nodes, [], 'drained display has no stale pressure');
  }
  assert.ok(Math.abs(arms[0].metrics().meanTravelTime - arms[1].metrics().meanTravelTime) <= 0.04);
  // This discretized occupancy law is not claimed to eliminate self-force.
  assert.ok(arms[1].metrics().feedbackDeltaSpeedTotal < 0.1);
  assert.ok(arms[1].metrics().peakDeltaSpeed < 0.005);
});
