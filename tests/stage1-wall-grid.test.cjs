'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Stage1 = require('../src/engine/stage1-engine.js');
const Pressure = require('../src/engine/pressure-field.js');

const particle = (id, x, y) => ({ id, x, y, vx: 0, vy: 0 });
function field(engine, particles, options = {}) {
  return Pressure.computeCrowdPressure(particles, {
    h: engine.config.pressureGridSize, origin: engine.config.pressureGridOrigin,
    dt: 0.02, rho0: 12, stiffness: 0.3, areaWeightedStencil: true,
    accessibleFraction: (x, y, h) => engine._accessibleFraction(x, y, h),
    isVisible: (px, py, gx, gy) => engine._isVisible(px, py, gx, gy), ...options
  });
}
function close(a, b, tolerance = 1e-9) {
  assert.ok(Math.abs(a - b) <= tolerance, `${a} differs from ${b}`);
}

test('positive-area cells outside the floor retain an interior visibility target and occupancy', () => {
  const engine = new Stage1({ gateOpenTime: 0, pressureGridOrigin: [0, 0] });
  const cell = engine._pressureCell(2.8, 1.12, 0.28);
  assert.equal(engine._floorContains(2.8, 1.12), false);
  assert.ok(cell.fraction > 0 && cell.fraction < 1);
  assert.equal(engine._floorContains(cell.targetX, cell.targetY), true);
  assert.equal(engine._isVisible(2.63, 1.1, 2.8, 1.12), true);
  const result = field(engine, [particle(1, 2.63, 1.1)]);
  assert.ok(result.nodes.some(n => n.x > 2.7 && n.occupancy > 0));
  close(result.metrics.representedOccupancy, 1);
  assert.equal(result.metrics.unsupportedParticleCount, 0);
  assert.equal(engine._isVisible(2.63, 1.1, 3.08, 1.12), false);
});

test('crossing a wall with a grid centre no longer abruptly drops half the boundary stencil', () => {
  const particles = [particle(1, 2.63, 1.1)];
  const engines = [-1e-7, 1e-7].map(offset => new Stage1({ gateOpenTime: 0,
    pressureGridOrigin: [-0.1 + offset, 0.071] }));
  const fixed = engines.map(e => field(e, particles, { rho0: 4 }));
  const old = engines.map(e => field(e, particles, { rho0: 4, areaWeightedStencil: false,
    isVisible: (px, py, gx, gy) => e._floorContains(gx, gy) }));
  assert.ok(Math.abs(old[0].metrics.maxDensity - old[1].metrics.maxDensity) > 3,
    'regression fixture reproduces the centre-rejection discontinuity');
  assert.equal(fixed[0].nodes.length, fixed[1].nodes.length);
  close(fixed[0].metrics.maxDensity, fixed[1].metrics.maxDensity, 2e-5);
  close(fixed[0].corrections[0].fx, fixed[1].corrections[0].fx, 3e-6);
});

test('isolated wall-adjacent person remains subthreshold throughout an origin sweep', () => {
  const oldDensity = [], fixedDensity = [];
  for (let index = 0; index <= 40; index++) {
    const engine = new Stage1({ gateOpenTime: 0, pressureGridOrigin: [0.28 * index / 40, 0.071] });
    const people = [particle(1, 2.63, 1.1)];
    const fixed = field(engine, people);
    const old = field(engine, people, { areaWeightedStencil: false,
      isVisible: (px, py, gx, gy) => engine._floorContains(gx, gy) });
    oldDensity.push(old.metrics.maxDensity); fixedDensity.push(fixed.metrics.maxDensity);
    assert.equal(fixed.metrics.unsupportedParticleCount, 0);
    close(fixed.metrics.representedOccupancy, 1);
    assert.equal(fixed.metrics.maxPressure, 0);
  }
  assert.ok(Math.max(...oldDensity) > 12, 'legacy wall-centre mask spuriously activates pressure');
  const range = values => Math.max(...values) - Math.min(...values);
  assert.ok(range(fixedDensity) < range(oldDensity));
  assert.ok(range(fixedDensity) > 1, 'finite-grid density variation is not claimed eliminated');
});

test('boundary quadrature differentiates fixed neighbor potential for a fixed geometry mask', () => {
  const engine = new Stage1({ gateOpenTime: 0, pressureGridOrigin: [0.021, 0.043] });
  const people = [particle(1, 2.61, 1.09), particle(2, 2.6, 1.13), particle(3, 2.55, 1.17)];
  const result = field(engine, people, { rho0: 4 });
  const potentials = new Map(field(engine, people.slice(1), { rho0: 4 }).nodes.map(n =>
    [n.ix + ',' + n.iy, n.potential]));
  const potential = p => field(engine, [p], { rho0: 4 }).nodes.reduce((sum, n) =>
    sum + n.occupancy * (potentials.get(n.ix + ',' + n.iy) || 0), 0);
  const epsilon = 1e-6;
  for (const [coordinate, force] of [['x', 'fx'], ['y', 'fy']]) {
    const left = structuredClone(people), right = structuredClone(people);
    left[0][coordinate] -= epsilon; right[0][coordinate] += epsilon;
    const derivative = (potential(right[0]) - potential(left[0])) / (2 * epsilon);
    close(result.corrections[0][force], -derivative, 1e-7);
  }
});

test('closed gate continues to isolate pressure on either side with overlapping stencils', () => {
  const engine = new Stage1({ pressureGridOrigin: [0.017, 0.032] });
  const above = [particle(1, -0.08, -0.55), particle(2, 0.07, -0.56)];
  const below = [particle(3, -0.05, -0.75), particle(4, 0.08, -0.76)];
  const together = field(engine, [...above, ...below], { rho0: 3 });
  const separate = [...field(engine, above, { rho0: 3 }).corrections,
    ...field(engine, below, { rho0: 3 }).corrections];
  for (let i = 0; i < separate.length; i++) {
    close(together.corrections[i].fx, separate[i].fx);
    close(together.corrections[i].fy, separate[i].fy);
  }
});

test('area-weighted deposition rejects a nonboolean option', () => {
  assert.throws(() => Pressure.computeCrowdPressure([], { dt: 0, areaWeightedStencil: 1 }), /boolean/);
});
