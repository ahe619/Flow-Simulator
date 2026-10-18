'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Pressure = require('../src/engine/pressure-field.js');
const Stage1 = require('../src/engine/stage1-engine.js');
const Stadium = require('../src/engine/stadium-macro-engine.js');

const particle = (id, x, y) => ({ id, x, y, vx: .1, vy: -.2 });
const tinyThreshold = { h: .28, dt: .02, rho0: 1e-10, stiffness: .3 };
const phases = [[0, 0], [.037, .093], [.14, .14], [.279999999, .219], [-.3, .5]];
const close = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance,
  `${a} differs from ${b}`);
function zeroFeedback(result, count) {
  assert.equal(result.metrics.unsupportedParticleCount, 0);
  close(result.metrics.representedOccupancy, count);
  assert.ok(result.metrics.maxPressure > 0, 'tiny threshold activates descriptive self pressure');
  assert.equal(result.metrics.maxNeighborDensity, 0);
  assert.equal(result.metrics.maxNeighborPressure, 0);
  assert.equal(result.metrics.neighborPressurePositiveParticleCount, 0);
  assert.equal(result.metrics.rawFeedbackNonzeroParticleCount, 0);
  for (const c of result.corrections) for (const key of ['fx', 'fy', 'dvx', 'dvy']) {
    assert.ok(c[key] === 0, `${c.id}.${key} must be exactly zero, got ${c[key]}`);
  }
  assert.equal(result.semantics.densityIncludesSelf, true);
  assert.equal(result.semantics.feedbackExcludesSelf, true);
}
function wallOptions(engine) {
  return { ...tinyThreshold, origin: engine.config.pressureGridOrigin, areaWeightedStencil: true,
    accessibleFraction: (x, y, h) => engine._accessibleFraction(x, y, h),
    isVisible: (px, py, gx, gy) => engine._isVisible(px, py, gx, gy) };
}

test('singleton feedback is exactly zero at arbitrary open positions and grid phases even at tiny rho0', () => {
  const positions = [[0, 0], [.14, .14], [.28, -.28], [.037, -.041], [-1.829, 2.137]];
  for (let i = 0; i <= 32; i++) positions.push([-.6 + i * .041, .4 * Math.sin(i)]);
  for (const origin of phases) for (const [x, y] of positions) {
    zeroFeedback(Pressure.computeCrowdPressure([particle(1, x, y)], { ...tinyThreshold, origin }), 1);
  }
});

test('singleton self exclusion also holds at walls, corners, cut cells and either side of a gate', () => {
  const positions = [[2.63, 1.1], [-2.63, 1.1], [0, 2.23], [.37, .07], [-.37, .07],
    [.23, -.4], [-.23, -1.73], [0, -.58], [0, -.72]];
  let partialCells = 0, outsideCentres = 0;
  for (const open of [0, 18]) for (let i = 0; i <= 32; i++) {
    const engine = new Stage1({ gateOpenTime: open, pressureGridOrigin: [.28 * i / 32, .071] });
    for (const [x, y] of positions) {
      assert.ok(engine.isContained(x, y));
      const result = Pressure.computeCrowdPressure([particle(1, x, y)], wallOptions(engine));
      zeroFeedback(result, 1);
      partialCells += result.nodes.filter(n => n.area < tinyThreshold.h ** 2).length;
      outsideCentres += result.nodes.filter(n => !engine._floorContains(n.x, n.y)).length;
    }
  }
  assert.ok(partialCells > 0, 'fixtures exercise positive-area cut cells');
  assert.ok(outsideCentres > 0, 'fixtures retain partially accessible cells whose centres are outside');
});

test('two distant people with disjoint grid supports have zero feedback for every tested grid phase', () => {
  for (const origin of phases) {
    zeroFeedback(Pressure.computeCrowdPressure([particle('a', -.7, .31), particle('b', 1.6, -.77)],
      { ...tinyThreshold, origin }), 2);
    const engine = new Stage1({ gateOpenTime: 0, pressureGridOrigin: origin });
    zeroFeedback(Pressure.computeCrowdPressure([particle('a', -2.63, 1.1), particle('b', 2.63, 1.1)],
      wallOptions(engine)), 2);
  }
});

test('a close pair has the exact independently calculated neighbor-only spline force', () => {
  // For x=(-1/4,+1/4), h=1: weights along x are (9,22,1)/32 and
  // (1,22,9)/32; dN_a/dx=(-3/4,1/2,1/4). y weights=(1,6,1)/8.
  // All nine neighbor deposits exceed rho0, so constant -k cancels.
  // sum_g grad(N_a)*N_b = (25/64)*(19/32) = 475/2048 in x.
  const options = { h: 1, origin: [0, 0], dt: .02, rho0: .001, stiffness: .3 };
  const result = Pressure.computeCrowdPressure([particle('a', -.25, 0), particle('b', .25, 0)], options);
  const magnitude = options.stiffness / options.rho0 * 475 / 2048;
  close(result.corrections[0].fx, -magnitude);
  close(result.corrections[1].fx, magnitude);
  close(result.corrections[0].fy, 0); close(result.corrections[1].fy, 0);
  close(result.corrections[0].dvx, -options.dt * magnitude);
  close(result.corrections[1].dvx, options.dt * magnitude);
  assert.equal(result.metrics.neighborPressurePositiveParticleCount, 2);
  assert.equal(result.metrics.rawFeedbackNonzeroParticleCount, 2);
  close(result.metrics.maxNeighborDensity, 22 / 32 * 3 / 4);
});

test('a thin wall blocks neighbor feedback despite overlapping supports and tiny threshold', () => {
  const result = Pressure.computeCrowdPressure([particle('left', -.08, .03), particle('right', .08, .03)], {
    ...tinyThreshold, origin: [.017, .03], accessibleFraction: x => Math.abs(x) < 1e-12 ? 0 : 1,
    isVisible: (px, py, gx, gy) => px * gx > 0
  });
  zeroFeedback(result, 2);
});

test('zero correction is an identity in the Stage1 hook even for an overspeed singleton', () => {
  for (const origin of phases) for (const individualSpeedLimit of [false, true]) {
    const engine = new Stage1({ pressureGridOrigin: origin, pressureRho0: tinyThreshold.rho0,
      individualSpeedLimit, gateOpenTime: 0 });
    const agents = [{ ...particle('single', 2.63, 1.1), vx: 7.123, vy: -3.789, speed: .03 }];
    const before = structuredClone(agents);
    engine._beforeAdvection(agents, .02);
    assert.deepEqual(agents, before);
    const m = engine.metrics();
    assert.ok(m.pressureMax > 0);
    assert.equal(m.pressureMaxNeighborPressure, 0);
    assert.equal(m.feedbackApplied, 0); assert.equal(m.feedbackClipped, 0);
    assert.equal(m.pressureSpeedClampCount, 0); assert.equal(m.feedbackDeltaSpeedTotal, 0);
  }
});

test('pressure speed cap still uses each agent limit when neighbor feedback is nonzero', () => {
  const engine = new Stage1({ pressureRho0: .1, individualSpeedLimit: true, gateOpenTime: 0 });
  const agents = [{ ...particle('a', -.08, 1.1), vx: 0, vy: 0, speed: .001 },
    { ...particle('b', .08, 1.1), vx: 0, vy: 0, speed: .001 }];
  engine._beforeAdvection(agents, .02);
  assert.ok(engine.metrics().feedbackApplied > 0);
  assert.ok(engine.metrics().pressureSpeedClampCount > 0);
  for (const a of agents) assert.ok(Math.hypot(a.vx, a.vy) <= 1.55 * a.speed + 1e-15);
});

test('singleton Stadium trajectories and events are exactly identical with feedback on and off', () => {
  const scene = { domainPolygon: [[-2,-2],[2,-2],[2,2],[-2,2]],
    floorPolygon: [[-2,-2],[2,-2],[2,2],[-2,2]], walls: [{p0:[2,-2],p1:[2,2]}],
    mouth: {p0:[-1,0],p1:[1,0]}, routes:{ in:{waypoints:[[0,-3]]} } };
  for (const origin of phases) {
    const config = { scene, maxTime: 2, individualSpeedLimit: true, pressureRho0: tinyThreshold.rho0,
      pressureGridOrigin: origin, initialAgents: [{...particle('a',1.93,1),speed:.4,routeId:'in'}] };
    const off = new Stadium({...config,feedbackOn:false}), on = new Stadium({...config,feedbackOn:true});
    for (let step = 0; step < 100; step++) {
      off.step(.02); on.step(.02);
      assert.deepEqual(on.agents,off.agents);
      assert.deepEqual(on.crossingEvents,off.crossingEvents);
      assert.deepEqual(on.exitEvents,off.exitEvents);
    }
    assert.equal(on.metrics().feedbackApplied,0);
    assert.equal(on.metrics().pressureSpeedClampCount,0);
  }
});
