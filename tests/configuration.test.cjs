'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {configFor} = require('../src/configuration.cjs');
const {gridPhase} = require('../src/grid_phase.cjs');
const {readJSON, verifyCore} = require('../src/io.cjs');

function fixture() {
  return {
    windowId: 'C_full', durationSeconds: 120,
    parameters: {pressureGridSize: 0.28, pressureRho0: 20, dtMax: 0.02},
    scene: {domainPolygon: [[-2, -2], [2, -2], [2, 2], [-2, 2]]},
    initialAgents: [{id: 'initial', sourceId: 1, speed: 0.2}],
    arrivals: [
      {id: 'measured', sourceId: 2, speed: 0.15, time: 5.5, timeBracket: [5, 6]},
      {id: 'sampled', sourceId: 3, speed: null, time: 5.5, timeBracket: [5, 6]}
    ],
    rollingSpeedObservations: [
      {time: -70, speed: 0.99},
      {time: 4, speed: 0.12},
      {time: 5, speed: 0.18},
      {time: 5.1, speed: 0.88}
    ]
  };
}

test('paired configurations differ only in feedback and retain measured speeds', () => {
  const input = fixture();
  const before = structuredClone(input);
  for (let seed = 1; seed <= 10; seed++) {
    const off = configFor(input, seed, 'feedback_off');
    const on = configFor(input, seed, 'feedback_on');
    on.feedbackOn = false;
    assert.deepStrictEqual(on, off);
    assert.equal(off.initialAgents[0].speed, 0.2);
    assert.equal(off.arrivals.find(agent => agent.id === 'measured').speed, 0.15);
    assert.equal(off.pressureRho0, 20);
  }
  assert.deepStrictEqual(input, before);
});

test('arrival speed draws never use observations after the arrival bracket starts', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const config = configFor(fixture(), seed, 'feedback_on');
    const agent = config.arrivals.find(value => value.id === 'sampled');
    const draw = config.randomization.draws.find(value => value.id === 'sampled');
    assert.ok(agent.time >= 5 && agent.time < 6);
    assert.equal(draw.poolSize, 2);
    assert.ok(draw.selectedObservation.time <= agent.timeBracket[0]);
    assert.ok(draw.selectedObservation.time >= agent.time - 60);
    assert.ok([0.12, 0.18].includes(agent.speed));
  }
});

test('missing history and an empty speed pool use the saved noise floor', () => {
  const input = fixture();
  input.initialAgents[0].speed = null;
  input.rollingSpeedObservations = [];
  const config = configFor(input, 1, 'feedback_off');
  assert.equal(config.initialAgents[0].speed, 0.03);
  assert.equal(config.arrivals.find(agent => agent.id === 'sampled').speed, 0.03);
  assert.equal(config.randomization.sparsePoolFallbackCount, 2);
});

test('saved seed salt retains the original grid origin', () => {
  assert.deepStrictEqual(gridPhase(1, 0.28), [0.06728932119905949, 0.10082014623098076]);
});

test('paper bottleneck configuration uses the selected integration step and frozen core', () => {
  const protocol = readJSON(path.join(__dirname, '..', 'configs', 'bottleneck.json'));
  assert.equal(protocol.fixedConfig.dtMax, 0.01);
  assert.equal(protocol.fixedConfig.gateOpenTime, 18);
  assert.deepStrictEqual(protocol.arrivalRates, [1, 2, 4, 6]);
  assert.equal(Object.keys(protocol.expectedDemandSha256).length, 80);
  verifyCore(protocol.coreHashes);
});
