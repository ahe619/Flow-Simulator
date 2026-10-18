'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CrowdEngine = require('../src/engine/engine.js');

function verify(engine, before) {
  const m = engine.metrics();
  assert.equal(m.requested, m.admitted + m.pending, 'demand must stay counted');
  assert.equal(m.admitted, m.active + m.exited, 'admitted agents must stay counted');
  for (const a of engine.agents) {
    for (const k of ['x', 'y', 'vx', 'vy']) assert.ok(Number.isFinite(a[k]), 'finite ' + k);
    assert.ok(engine.isContained(a.x, a.y, a.r), 'disk outside walkable geometry: ' + JSON.stringify(a));
    if (before && before.has(a.id)) {
      const p = before.get(a.id);
      assert.ok(Math.hypot(a.x - p.x, a.y - p.y) < 0.07, 'no large per-step teleport');
      // Any centre crossing the doorway plane must lie in its finite-radius opening.
      if (a.y * p.y < 0) {
        const ratio = p.y / (p.y - a.y), x = p.x + ratio * (a.x - p.x);
        assert.ok(Math.abs(x) < engine.config.doorWidth / 2 - a.r + 0.001, 'wall crossing');
      }
    }
  }
  assert.ok(m.maxOverlap < 0.012, 'no gross contact overlap: ' + m.maxOverlap);
  assert.doesNotThrow(() => JSON.stringify(m));
}

test('fixed seed and fixed steps replay exactly; reset reproduces the run', () => {
  const a = new CrowdEngine(), b = new CrowdEngine();
  for (let k = 0; k < 900; k++) { a.step(0.04); b.step(0.04); }
  assert.deepEqual(a.agents, b.agents);
  assert.deepEqual(a.metrics(), b.metrics());
  a.reset();
  for (let k = 0; k < 900; k++) a.step(0.04);
  assert.deepEqual(a.agents, b.agents);
  assert.deepEqual(a.metrics(), b.metrics());
});

test('low demand completes and drains through the tunnel', () => {
  const e = new CrowdEngine({ arrivalRate: 0.4 });
  while (!e.finished) {
    const before = new Map(e.agents.map(a => [a.id, { x: a.x, y: a.y }]));
    e.step(0.04); verify(e, before);
  }
  assert.equal(e.requested, 24);
  assert.equal(e.exited, 24);
  assert.equal(e.metrics().termination, 'drained');
  assert.ok(e.metrics().meanTravelTime > 7 && e.metrics().meanTravelTime < 35);
});

test('width and arrival extremes remain finite, contained, and conserved', () => {
  for (const doorWidth of [0.6, 1, 1.6]) {
    const e = new CrowdEngine({ doorWidth, arrivalRate: 3.6, seed: 902 });
    for (let k = 0; k < 2500 && !e.finished; k++) {
      const before = new Map(e.agents.map(a => [a.id, { x: a.x, y: a.y }]));
      e.step(0.04); verify(e, before);
    }
    assert.equal(e.requested, 216);
    assert.ok(e.exited > 30, 'substantial actual outflow at width ' + doorWidth);
  }
});

test('demonstration loads 6–10 remain contained and conserved across supported widths', () => {
  for (const arrivalRate of [6, 8, 10]) {
    for (const doorWidth of [0.6, 1, 1.6]) {
      const e = new CrowdEngine({ doorWidth, arrivalRate, seed: 902 });
      while (!e.finished) {
        const before = new Map(e.agents.map(a => [a.id, { x: a.x, y: a.y }]));
        e.step(0.04); verify(e, before);
      }
      assert.equal(e.requested, arrivalRate * 60);
      assert.equal(e.exited, e.requested, 'these demonstration loads should drain');
      assert.equal(e.metrics().termination, 'drained');
    }
  }
});

test('narrow doorway at maximum demonstration load is robust to the default seed', () => {
  const e = new CrowdEngine({ doorWidth: 0.6, arrivalRate: 10, seed: 23 });
  while (!e.finished) { e.step(0.04); verify(e); }
  assert.equal(e.exited, 600);
  assert.equal(e.pending, 0);
});

test('capacity limit queues demand rather than silently dropping it', () => {
  const e = new CrowdEngine({ maxAgents: 2, arrivalRate: 3.6 });
  for (let k = 0; k < 1600; k++) {
    e.step(0.04);
    assert.ok(e.agents.length <= 2);
    verify(e);
  }
  assert.equal(e.requested, 216);
  assert.ok(e.pending > 150);
  while (!e.finished) e.step(0.04);
  verify(e);
  assert.equal(e.metrics().termination, 'timeout');
  assert.ok(e.pending > 0);
  const previous = e.metrics();
  e.step(1);
  assert.deepEqual(e.metrics(), previous, 'finished simulation is stable');
});

test('rounded corner containment rejects points hidden inside doorway walls', () => {
  const e = new CrowdEngine();
  assert.equal(e.isContained(0, 0), true);
  assert.equal(e.isContained(0.49, 0.02), false);
  assert.equal(e.isContained(0.4, 0.02), true);
  assert.equal(e.isContained(1, -0.1), false);
  assert.equal(e.isContained(2.7, 1), false);
  assert.throws(() => e.step(NaN), RangeError);
  assert.throws(() => new CrowdEngine({ doorWidth: 0.1 }), RangeError);
});
