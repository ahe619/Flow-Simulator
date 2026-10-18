'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { computeCrowdPressure, quadraticBSpline, quadraticBSplineDerivative } = require('../src/engine/pressure-field.js');

function close(a, b, label, tolerance = 1e-9) {
  assert.ok(Number.isFinite(a) && Number.isFinite(b), label + ': nonfinite');
  assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} vs ${b}`);
}
function particle(id, x, y, vx = 0, vy = 0) { return { id, x, y, vx, vy }; }
function symmetricCluster() {
  const particles = [];
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    particles.push(particle(particles.length, i * 0.065, j * 0.065));
  }
  return particles;
}
const defaults = { h: 0.28, rho0: 12, stiffness: 0.3, dt: 0.02 };
// Hold neighbors fixed while moving only the receiving interpolation stencil.
// This local potential is distinct from the displayed total-occupancy energy.
function fixedNeighborPotential(particles, index, options) {
  const nodes = computeCrowdPressure(particles.filter((_, i) => i !== index), options).nodes;
  const potentials = new Map(nodes.map(n => [n.ix + ',' + n.iy, n.potential]));
  return p => computeCrowdPressure([p], options).nodes.reduce((sum, n) =>
    sum + n.occupancy * (potentials.get(n.ix + ',' + n.iy) || 0), 0);
}

test('quadratic spline derivative matches centered finite differences', () => {
  for (const x of [-1.7, -1.2, -0.7, -0.21, 0, 0.37, 0.81, 1.31, 1.7]) {
    const eps = 1e-6;
    close(quadraticBSplineDerivative(x), (quadraticBSpline(x + eps) - quadraticBSpline(x - eps)) / (2 * eps), 'kernel derivative');
  }
});

test('sparse subthreshold occupancy produces exactly zero pressure and velocity increment', () => {
  const particles = [particle('a', 0.037, -0.041), particle('b', 3.1, 2.2, 0.4, -0.2)];
  const result = computeCrowdPressure(particles, defaults);
  assert.ok(result.metrics.maxDensity < defaults.rho0);
  assert.equal(result.metrics.energy, 0);
  assert.equal(result.metrics.maxPressure, 0);
  for (const c of result.corrections) { assert.ok(c.dvx === 0); assert.ok(c.dvy === 0); }
  close(result.metrics.representedOccupancy, particles.length, 'occupancy');
});

test('dense shared occupancy produces feedback with outward force and symmetric cancellation', () => {
  const particles = symmetricCluster();
  const result = computeCrowdPressure(particles, defaults);
  assert.ok(result.metrics.maxPressure > 0);
  assert.ok(result.metrics.energy > 0);
  assert.ok(result.metrics.maxDeltaSpeed > 0);
  close(result.metrics.totalForceX, 0, 'symmetric total force x');
  close(result.metrics.totalForceY, 0, 'symmetric total force y');
  const radialWork = result.corrections.reduce((sum, c, i) => sum + c.fx * particles[i].x + c.fy * particles[i].y, 0);
  assert.ok(radialWork > 0, 'compression energy must push the cluster outward');
  result.corrections.forEach(c => { close(c.dvx, defaults.dt * c.fx, 'dvx = dt fx'); close(c.dvy, defaults.dt * c.fy, 'dvy = dt fy'); });
});

test('direction labels and agent velocities do not split shared occupancy', () => {
  const particles = symmetricCluster();
  const baseline = computeCrowdPressure(particles, defaults);
  const counterflow = computeCrowdPressure(particles.map((p, i) => ({ ...p, vx: i % 2 ? 3 : -3, stream: i % 2 })), defaults);
  assert.deepEqual(counterflow, baseline);
});

test('feedback differentiates the receiving stencil in a fixed neighbor potential', () => {
  const particles = symmetricCluster().map((p, i) => ({ ...p, x: p.x + 0.017 + 0.002 * Math.sin(i), y: p.y - 0.023 }));
  const result = computeCrowdPressure(particles, defaults);
  const eps = 1e-6;
  for (const index of [0, 7, 12, 20]) for (const [coordinate, force] of [['x', 'fx'], ['y', 'fy']]) {
    const potential = fixedNeighborPotential(particles, index, defaults);
    const a = { ...particles[index] }, b = { ...particles[index] };
    a[coordinate] += eps; b[coordinate] -= eps;
    const derivative = (potential(a) - potential(b)) / (2 * eps);
    close(result.corrections[index][force], -derivative, 'fixed-neighbor force ' + coordinate, 3e-7);
  }
});

test('masked normalized stencil differentiates fixed neighbor potential and preserves occupancy', () => {
  const particles = symmetricCluster().map(p => ({ ...p, x: p.x + 0.19 }));
  const options = { ...defaults, accessibleFraction: x => x > 0 ? 0.7 : 0 };
  const result = computeCrowdPressure(particles, options);
  close(result.metrics.representedOccupancy, particles.length, 'masked occupancy');
  assert.equal(result.metrics.unsupportedParticleCount, 0);
  const eps = 1e-6, index = 3;
  const potential = fixedNeighborPotential(particles, index, options);
  const a = { ...particles[index] }, b = { ...particles[index] };
  a.x += eps; b.x -= eps;
  const derivative = (potential(a) - potential(b)) / (2 * eps);
  close(result.corrections[index].fx, -derivative, 'normalized masked force', 3e-7);
});

test('visibility blocks exchange across a thin wall even when particle supports overlap', () => {
  const left = [particle('l1', -0.08, -0.04), particle('l2', -0.09, 0.03), particle('l3', -0.12, 0.01)];
  const right = [particle('r1', 0.08, -0.02), particle('r2', 0.1, 0.04), particle('r3', 0.12, 0.01)];
  const options = {
    ...defaults, rho0: 4,
    accessibleFraction: x => Math.abs(x) < 1e-10 ? 0 : 1,
    isVisible: (px, py, gx, gy) => px * gx > 0
  };
  const together = computeCrowdPressure([...left, ...right], options);
  const separate = [...computeCrowdPressure(left, options).corrections, ...computeCrowdPressure(right, options).corrections];
  assert.equal(together.metrics.unsupportedParticleCount, 0);
  together.corrections.forEach((c, i) => { close(c.fx, separate[i].fx, 'wall-isolated fx'); close(c.fy, separate[i].fy, 'wall-isolated fy'); });
});

test('pressure uses the stated energy relation and usable area affects density', () => {
  const particles = symmetricCluster();
  const normal = computeCrowdPressure(particles, defaults);
  const reduced = computeCrowdPressure(particles, { ...defaults, accessibleFraction: () => 0.5 });
  close(reduced.metrics.maxDensity, normal.metrics.maxDensity * 2, 'usable area density');
  normal.nodes.forEach(n => close(n.pressure, n.density * n.potential - n.energy / n.area, 'p = rho mu - e'));
});

test('stiffness and dt scale feedback without a hidden cap; zero values work', () => {
  const particles = symmetricCluster();
  const a = computeCrowdPressure(particles, defaults);
  const b = computeCrowdPressure(particles, { ...defaults, stiffness: defaults.stiffness * 2, dt: defaults.dt * 3 });
  a.corrections.forEach((c, i) => { close(b.corrections[i].dvx, 6 * c.dvx, 'scaled dvx'); close(b.corrections[i].dvy, 6 * c.dvy, 'scaled dvy'); });
  const zeroK = computeCrowdPressure(particles, { ...defaults, stiffness: 0 });
  assert.equal(zeroK.metrics.energy, 0); assert.equal(zeroK.metrics.maxDeltaSpeed, 0);
  const zeroDt = computeCrowdPressure(particles, { ...defaults, dt: 0 });
  assert.ok(zeroDt.metrics.maxPressure > 0); assert.equal(zeroDt.metrics.maxDeltaSpeed, 0);
});

test('input remains unchanged; unsupported geometry is explicit and empty input is finite', () => {
  const particles = symmetricCluster();
  const copy = structuredClone(particles);
  particles.forEach(Object.freeze); Object.freeze(particles);
  computeCrowdPressure(particles, defaults);
  assert.deepEqual(particles, copy);
  const unsupported = computeCrowdPressure(particles, { ...defaults, accessibleFraction: () => 0 });
  assert.equal(unsupported.metrics.unsupportedParticleCount, particles.length);
  assert.equal(unsupported.metrics.unrepresentedOccupancy, particles.length);
  assert.equal(unsupported.metrics.representedOccupancy, 0);
  assert.equal(unsupported.metrics.maxDeltaSpeed, 0);
  const empty = computeCrowdPressure([], defaults);
  assert.deepEqual(empty.nodes, []); assert.deepEqual(empty.corrections, []);
  Object.values(empty.metrics).forEach(v => assert.ok(Number.isFinite(v)));
});

test('invalid and nonfinite parameters or callback results are rejected', () => {
  const particles = [particle(0, 0, 0)];
  for (const value of [NaN, Infinity, -Infinity, '1']) {
    for (const key of ['h', 'rho0', 'stiffness', 'dt']) assert.throws(() => computeCrowdPressure(particles, { ...defaults, [key]: value }));
    for (const key of ['x', 'y', 'vx', 'vy']) assert.throws(() => computeCrowdPressure([{ ...particles[0], [key]: value }], defaults));
    assert.throws(() => computeCrowdPressure(particles, { ...defaults, origin: [value, 0] }));
  }
  for (const key of ['h', 'rho0', 'stiffness', 'dt']) assert.throws(() => computeCrowdPressure(particles, { ...defaults, [key]: -1 }));
  for (const key of ['h', 'rho0']) assert.throws(() => computeCrowdPressure(particles, { ...defaults, [key]: 0 }));
  for (const value of [-0.1, 1.1, NaN]) assert.throws(() => computeCrowdPressure(particles, { ...defaults, accessibleFraction: () => value }));
  assert.throws(() => computeCrowdPressure(particles, { ...defaults, isVisible: () => 1 }));
  assert.throws(() => computeCrowdPressure([particles[0], particles[0]], defaults));
  assert.throws(() => computeCrowdPressure(particles, { ...defaults, accessibleFraction: true }));
});

test('UMD module runs without CommonJS and exposes the same browser calculation', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/engine/pressure-field.js'), 'utf8'), context);
  assert.equal(typeof context.CrowdPressure.computeCrowdPressure, 'function');
  const browser = context.CrowdPressure.computeCrowdPressure(symmetricCluster(), defaults);
  const node = computeCrowdPressure(symmetricCluster(), defaults);
  assert.equal(JSON.stringify(browser), JSON.stringify(node));
});
