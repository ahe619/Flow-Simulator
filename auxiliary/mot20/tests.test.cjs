'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildWindows } = require('./windows.cjs');
const { rollout } = require('./rollout.cjs');
const { verifyInputs, run } = require('./run.cjs');

test('all bundled inputs and shared engines match the frozen manifest', () => {
  assert.ok(verifyInputs() >= 30);
});

test('a missing historical observation breaks the velocity history', () => {
  const records = [1, 2, 4, 5, 6].map(frame => [frame, 1, frame - 1, frame, 0, 0]);
  const [window] = buildWindows({ records }, {
    fps: 1, sequenceFrames: 6, firstAnchor: 4, historySteps: 3,
    futureSteps: 2, strideFrames: 6
  });
  assert.equal(window.initialAgents.length, 0);
  assert.equal(window.targets.length, 0);
  assert.equal(window.diagnostics.excludedAtAnchor[0].reason, 'fewer_than_two_consecutive_observations');
});

test('future coordinates do not change initialization', () => {
  const records = Array.from({ length: 6 }, (_, index) => {
    const frame = index + 1;
    return [frame, 1, frame - 1, frame, 0, 0];
  });
  const options = { fps: 1, sequenceFrames: 6, firstAnchor: 4,
    historySteps: 3, futureSteps: 2, strideFrames: 6 };
  const [original] = buildWindows({ records }, options);
  const changed = records.map(row => row[0] > 4 ? [row[0], row[1], row[2], 1000, -1000, 0] : row);
  const [altered] = buildWindows({ records: changed }, options);
  assert.deepEqual(altered.initialAgents, original.initialAgents);
  assert.notDeepEqual(altered.targets, original.targets);
});

test('an isolated constant-speed agent has zero congestion feedback', () => {
  const initial = [{ id: 1, x: 0.2, y: 0.1, vx: 1, vy: 0 }];
  const options = { method: 'agent_stage1', fps: 25, steps: 10,
    pressureRho0: 1.5, pressureStiffness: 0.5 };
  const simulated = rollout(initial, options);
  assert.equal(simulated.diagnostics.pressureAppliedAgentSubsteps, 0);
  for (const frame of simulated.frames) assert.equal(frame[0].vx, 1);
});

test('an existing output directory is rejected before any files change', () => {
  const directory = path.join(__dirname, 'reference');
  const before = fs.readdirSync(directory).map(name => [name, fs.statSync(path.join(directory, name)).mtimeMs]);
  assert.throws(() => run(directory), { code: 'EEXIST' });
  const after = fs.readdirSync(directory).map(name => [name, fs.statSync(path.join(directory, name)).mtimeMs]);
  assert.deepEqual(after, before);
});
