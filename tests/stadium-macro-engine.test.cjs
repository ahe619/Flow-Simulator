'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine/stadium-macro-engine.js');
const scene = () => ({ domainPolygon: [[-2,-2],[2,-2],[2,2],[-2,2]],
  floorPolygon: [[-3,-3],[3,-3],[3,3],[-3,3]], walls: [], mouth: { p0: [-1,0], p1: [1,0] },
  routes: { in: { waypoints: [[0,-3]] }, out: { waypoints: [[0,3]] },
    right: { waypoints: [[3,0]] }, stay: { waypoints: [[0,0]] } } });
const person = (id, extra = {}) => ({ id, x: 0, y: 1, vx: 0, vy: -.4, speed: .4, routeId: 'in', ...extra });
const run = (engine, duration) => { for (let t = 0; t < duration - 1e-9; t += .1) engine.step(Math.min(.1, duration - t)); return engine; };
const config = (extra = {}) => ({ scene: scene(), maxTime: 10, feedbackOn: false, ...extra });

test('scheduled demand is never admitted early and open boundary preserves mass', () => {
  const engine = new Engine(config({ arrivals: [person('a', { time: 1, y: -1.8 })] }));
  engine.step(.9); assert.equal(engine.metrics().requested, 0);
  engine.step(.1); assert.equal(engine.admissionEvents[0].time, 1);
  assert.equal(engine.agents[0].y, -1.8);
  run(engine, 1); const m = engine.metrics();
  assert.equal(m.exited, 1); assert.equal(m.active, 0); assert.equal(m.conservationError, 0);
  assert.equal(engine.exitEvents[0].reason, 'open-domain-boundary');
  assert.equal(m.finished, false); // Future horizon continues after drain.
});
test('pending scheduled arrivals remain counted and never disappear', () => {
  const engine = new Engine(config({ maxAgents: 1, initialAgents: [person('initial', { speed: 0, vx: 0, vy: 0 })],
    arrivals: [person('later', { time: .25 })] }));
  engine.step(1); const m = engine.metrics();
  assert.equal(m.initialCount, 1); assert.equal(m.requested, 2); assert.equal(m.pending, 1);
  assert.equal(m.admitted, 1); assert.equal(m.conservationError, 0);
  assert.equal(m.admissionConservationError, 0); assert.equal(m.futureScheduled, 0);
});
test('repeated source-ID entry episodes wait until the prior live agent exits', () => {
  const engine = new Engine(config({ initialAgents: [person('episode1', { sourceId: 42, y: -1.8 })],
    arrivals: [person('episode2', { sourceId: 42, time: .1, y: 1 })] }));
  engine.step(.2);
  assert.equal(engine.agents.length, 1); assert.equal(engine.agents[0].id, 'episode1');
  assert.equal(engine.metrics().pending, 1);
  assert.ok(engine.metrics().blockedSourceIdentityAttempts > 0);
  engine.step(.5);
  assert.equal(engine.agents.length, 1); assert.equal(engine.agents[0].id, 'episode2');
  assert.equal(engine.metrics().pending, 0); assert.equal(engine.metrics().exited, 1);
  assert.equal(engine.metrics().conservationError, 0);
});
test('entry positions without physical wall clearance are counted and retained pending', () => {
  const sc = scene(); sc.walls = [{ p0: [-1,0], p1: [1,0] }];
  const engine = new Engine(config({ scene: sc, arrivals: [person('bad-entry', { time: .1, y: .01 })] }));
  engine.step(1);
  assert.equal(engine.metrics().infeasibleEntryCount, 1);
  assert.deepEqual(engine.metrics().infeasibleEntryIds, ['bad-entry']);
  assert.equal(engine.metrics().pending, 1); assert.equal(engine.metrics().active, 0);
  assert.equal(engine.metrics().conservationError, 0);
});
test('finite mouth crossing is distinct from retirement and counts both directions', () => {
  const sc = scene();
  sc.routes.in.waypoints = [[-.5,-3]]; sc.routes.out.waypoints = [[.5,3]];
  const engine = new Engine(config({ scene: sc, repulsionA: 0,
    initialAgents: [person('in', { x: -.5, y: .4 }), person('out', { x: .5, y: -.4, vy: .4, routeId: 'out' })] }));
  run(engine, 2);
  assert.equal(engine.metrics().mouthInto, 1); assert.equal(engine.metrics().mouthOut, 1);
  assert.equal(engine.metrics().exited, 0); assert.equal(engine.agents.length, 2);
  assert.ok(engine.crossingEvents.every(e => Math.abs(e.time - 1) < 1e-7));
});
test('crossing extension beyond finite mouth does not count as a tunnel crossing', () => {
  const sc = scene(); sc.routes.in.waypoints = [[1.5,-3]];
  const engine = new Engine(config({ scene: sc, initialAgents: [person('outside-line', { x: 1.5, y: .2 })] }));
  run(engine, 1); assert.equal(engine.crossingEvents.length, 0);
});
test('real scene has no synthetic gate and finite wall blocks its segment only', () => {
  const sc = scene(); sc.walls = [{ p0: [-.5,0], p1: [.5,0] }];
  sc.routes.edge = { waypoints: [[1,-3]] };
  const engine = new Engine(config({ scene: sc, initialAgents: [person('blocked', { y: .1 }), person('past-end', { x: 1, y: .1, routeId: 'edge' })] }));
  run(engine, 2);
  const a = engine.agents.find(a => a.id === 'blocked'), b = engine.agents.find(a => a.id === 'past-end');
  assert.ok(a.y >= engine.config.radius - 1e-8); assert.ok(b.y < -.6);
  assert.equal(engine.metrics().artificialGateControl, false);
  assert.ok(engine.metrics().maxWallPenetrationAfterProjection < 1e-7);
});
test('zero stiffness gives identical on/off motion with the same demand', () => {
  const cfg = config({ pressureStiffness: 0,
    initialAgents: [person(1, { x: -.04 }), person(2, { x: .04 })],
    arrivals: [person(3, { time: .3, x: .4 })] });
  const off = run(new Engine({ ...cfg, feedbackOn: false }), 2);
  const on = run(new Engine({ ...cfg, feedbackOn: true }), 2);
  assert.deepEqual(on.agents, off.agents); assert.deepEqual(on.crossingEvents, off.crossingEvents);
  assert.equal(on.metrics().feedbackApplied, 0);
});
test('active pressure is measured independently from enabled feedback and respects cap', () => {
  const cfg = config({ pressureRho0: .1, pressureGridSize: .28, pressureStiffness: .3, pressureAccelerationLimit: .2,
    initialAgents: [person('p', { x: -.08, y: .02 }), person('neighbor', { x: .08, y: .02 })] });
  const off = new Engine({ ...cfg, feedbackOn: false }), on = new Engine({ ...cfg, feedbackOn: true });
  off.step(.02); on.step(.02);
  assert.equal(off.metrics().pressureActiveFraction, 1); assert.equal(on.metrics().pressureActiveFraction, 1);
  assert.equal(off.metrics().feedbackApplied, 0); assert.ok(on.metrics().feedbackApplied > 0);
  assert.ok(on.metrics().pressurePeakDeltaSpeed <= .2 * .02 + 1e-12);
});
test('routes progress through waypoints and only explicitly requested goals retire agents', () => {
  const sc = scene(); sc.routes.turn = { waypoints: [[0,0],[1,0]], exitOnGoal: true };
  const engine = new Engine(config({ scene: sc, maxTime: 12, initialAgents: [person('turn', { y: .2, routeId: 'turn' })] }));
  run(engine, 5); assert.equal(engine.exitEvents.length, 1); assert.equal(engine.exitEvents[0].reason, 'route-goal');
});
test('observed per-agent lane offsets route goals without forcing everyone to centre', () => {
  const sc = scene(); sc.routes.in = { waypoints: [[0,.2],[0,-3]], useAgentLane: true };
  const engine = new Engine(config({ scene: sc, repulsionA: 0, initialAgents: [person('lane', { x: .25, lane: .25, y: .4 })] }));
  run(engine, 2);
  assert.ok(Math.abs(engine.agents[0].x - .25) < 1e-12);
  assert.equal(engine.agents[0].waypointIndex, 1);
  assert.equal(engine.metrics().mouthInto, 1);
});
test('validation rejects duplicated IDs and agents outside open observation domain', () => {
  assert.throws(() => new Engine(config({ initialAgents: [person('a')], arrivals: [person('a', { time: 1 })] })), /unique/);
  assert.throws(() => new Engine(config({ initialAgents: [person('a', { x: 3 })] })), /outside domain/);
});
test('individual speed cap is applied during local motion while default preserves global cap', () => {
  const cfg = config({ initialAgents: [person('slow', { vx: 0, vy: -3, speed: .1 })] });
  const individual = new Engine({...cfg, individualSpeedLimit:true});
  const legacy = new Engine(cfg);
  individual.step(.02); legacy.step(.02);
  assert.ok(Math.hypot(individual.agents[0].vx,individual.agents[0].vy) <= 1.55*.1 + 1e-12);
  assert.ok(Math.hypot(legacy.agents[0].vx,legacy.agents[0].vy) > 1.55*.1);
  assert.equal(legacy.config.individualSpeedLimit,false);
});
test('zero pressure increment does not invoke an independent post-feedback speed cap', () => {
  const engine = new Engine(config({feedbackOn:true,individualSpeedLimit:true,pressureStiffness:0,
    initialAgents:[person('slow',{speed:.03})]}));
  const agent = engine.agents[0]; agent.vx=1; agent.vy=0;
  engine._beforeAdvection(engine.agents,.02);
  assert.equal(agent.vx,1); assert.equal(agent.vy,0);
  assert.equal(engine.metrics().pressureSpeedClampCount,0);
  assert.equal(engine.metrics().feedbackApplied,0);
});
test('fast future individual speed controls substep bound before admission', () => {
  const engine = new Engine(config({individualSpeedLimit:true,desiredSpeed:.1,
    initialAgents:[person('slow',{speed:.1})],arrivals:[person('fast',{time:1,x:1,speed:10})]}));
  const steps=[]; const advance=engine._advance.bind(engine);
  engine._advance=h=>{steps.push(h);return advance(h);};
  engine.step(.02);
  assert.equal(engine.metrics().maxConfiguredPreferredSpeed,10);
  assert.ok(steps.length>1); assert.ok(Math.max(...steps) <= engine.config.radius/(10*2)+1e-12);
});
