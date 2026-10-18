'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildWindows } = require('./windows.cjs');
const { lastSecondInitial } = require('./stage1_adapter.cjs');
const { rollout } = require('./rollout.cjs');
const { evaluate, project } = require('./metrics.cjs');

const base = __dirname;
const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const objectHash = value => hash(JSON.stringify(value));
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const csvValue = value => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
};
function csv(rows) {
  const keys = Object.keys(rows[0]);
  return [keys.join(','), ...rows.map(row => keys.map(key => csvValue(row[key])).join(','))].join('\n') + '\n';
}

function verifyInputs() {
  const manifest = read('manifest.json');
  for (const entry of manifest.files) {
    if (hash(fs.readFileSync(path.join(base, entry.file))) !== entry.sha256) {
      throw Error('Bundled input or helper has changed: ' + entry.file);
    }
  }
  for (const [name, expected] of Object.entries(manifest.engine_hashes)) {
    if (hash(fs.readFileSync(path.join(base, '../../src/engine', name))) !== expected) {
      throw Error('Frozen engine has changed: ' + name);
    }
  }
  return manifest.files.length + Object.keys(manifest.engine_hashes).length;
}

function run(output) {
  const checkedFiles = verifyInputs();
  const protocol = read('data/protocol.json');
  const calibration = read('data/calibration.json');
  const inputs = read('data/initial_inputs.json');
  const expected = read('reference/expected_hashes.json');
  const expectedFailures = read('data/expected_failures.json');
  // A fresh directory makes concurrent runs and accidental overwrites fail early.
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const write = (name, value) => fs.writeFileSync(path.join(output, name),
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  write('run_started.json', { started_at: new Date().toISOString(), node: process.version,
    protocol_sha256: hash(fs.readFileSync(path.join(base, 'data/protocol.json'))), checkedFiles });
  const windows = [], rows = [], ids = new Map(), activationFailures = [];
  for (const anchor of protocol.validAnchors) {
    const prefix = `data/window_${String(anchor).padStart(4, '0')}/`;
    const dataset = read(prefix + 'observations.json');
    const [window] = buildWindows(dataset, { fps: 25, sequenceFrames: anchor + 100,
      firstAnchor: anchor, historySteps: 50, futureSteps: 100, strideFrames: 151 });
    const input = inputs.find(item => item.anchor === anchor);
    const cal = calibration.windows.find(item => item.anchor === anchor);
    if (!input || !cal || !window?.targets.length) throw Error('Missing frozen window ' + anchor);
    if (JSON.stringify(window.initialAgents) !== JSON.stringify(input.initialAgents)) {
      throw Error('Two-second initialization differs at ' + anchor);
    }
    if (JSON.stringify(lastSecondInitial(window)) !== JSON.stringify(input.cv1sInitialAgents)) {
      throw Error('One-second initialization differs at ' + anchor);
    }
    const raw = read(prefix + 'raw_observations.json');
    const geometry = read(prefix + 'geometry.json');
    const registration = read(prefix + 'registration.json');
    if (!registration.passed || !geometry.registration_applied) throw Error('Geometry gate failed');
    const rawIndex = new Map(raw.records.map(row => [row[0] + ':' + row[1], row]));
    let roundtripMaxPixels = 0;
    for (const row of dataset.records) {
      const projected = project(geometry.H_U_to_image, row[3], row[4]);
      const pixel = projected && project(registration.frames[row[0]].anchor_to_frame, ...projected);
      const truth = rawIndex.get(row[0] + ':' + row[1]);
      if (!pixel || !truth) throw Error('Invalid observed backprojection');
      roundtripMaxPixels = Math.max(roundtripMaxPixels, Math.hypot(pixel[0] - truth[3], pixel[1] - truth[4]));
    }
    if (roundtripMaxPixels > 1e-7) throw Error('Observed backprojection roundtrip failed');
    const runs = {}, scores = {}, runtimeMilliseconds = {}, equivalence = {};
    for (const method of protocol.methods) {
      const begin = performance.now();
      const simulation = rollout(method === 'cv_1s' ? input.cv1sInitialAgents : input.initialAgents,
        { ...protocol.modelOptions, pressureRho0: cal.pressureRho0,
          method: method === 'agent_stage1' ? 'agent_stage1' : method === 'agent' ? 'agent' : 'cv' });
      runtimeMilliseconds[method] = performance.now() - begin;
      const d = simulation.diagnostics;
      if (!d.finite || !d.populationConserved || simulation.frames.length !== 101) {
        throw Error('Numerical invariant failed');
      }
      const score = evaluate(simulation, window, geometry, registration, rawIndex);
      const reference = expected.windows[anchor][method];
      equivalence[method] = { frames: objectHash(simulation.frames) === reference.frames_sha256,
        scores: objectHash(score) === reference.scores_sha256 };
      if (!equivalence[method].frames || !equivalence[method].scores) {
        throw Error(`Archived result differs: window ${anchor}, ${method}`);
      }
      const denominator = d.substeps * input.initialAgents.length;
      const applied = method === 'agent_stage1' ? d.pressureAppliedAgentSubsteps : 0;
      const fraction = denominator ? applied / denominator : 0;
      const activationPassed = method !== 'agent_stage1' || fraction >= protocol.activation.targetFraction;
      if (!activationPassed) activationFailures.push({ anchor, fraction, target: protocol.activation.targetFraction });
      runs[method] = simulation; scores[method] = score;
      const e = score.summary;
      rows.push({ anchor_frame: anchor, method, status: 'complete', failure_reason: '',
        initial_agents: input.initialAgents.length, scored_agents: window.targets.length,
        ADE_U: e.ade, FDE_U: e.fde, ADE_px: e.adePixels, FDE_px: e.fdePixels,
        pressure_applied_fraction: fraction, pressure_applied_agent_substeps: applied,
        total_agent_substeps: denominator, activation_target_passed: activationPassed,
        finite: d.finite, population_conserved: d.populationConserved });
      console.log(`${anchor} ${method}: ADE=${e.ade.toFixed(6)} U, FDE=${e.fde.toFixed(6)} U, activation=${(100 * fraction).toFixed(3)}%; exact frames/scores PASS`);
    }
    write(`window_${anchor}.json`, { anchor, initialCount: input.initialAgents.length,
      scoredCount: window.targets.length, roundtripMaxPixels, geometryUnits: geometry.units,
      L: geometry.L, calibration: cal, initialAgents: input.initialAgents,
      cv1sInitialAgents: input.cv1sInitialAgents, targets: window.targets,
      initializationDiagnostics: window.diagnostics, runs, scores, runtimeMilliseconds, equivalence });
    windows.push({ anchor, initialCount: input.initialAgents.length, scoredCount: window.targets.length,
      summaries: Object.fromEntries(protocol.methods.map(method => [method, scores[method].summary])),
      diagnostics: Object.fromEntries(protocol.methods.map(method => [method, runs[method].diagnostics])) });
    for (const target of window.targets) ids.set(target.id, (ids.get(target.id) || 0) + 1);
  }
  const count = windows.reduce((sum, window) => sum + window.scoredCount, 0);
  const metrics = ['ade', 'fde', 'adePixels', 'fdePixels'];
  const aggregate = Object.fromEntries(protocol.methods.map(method => [method, {
    equalWindow: Object.fromEntries(metrics.map(key => [key, mean(windows.map(window => window.summaries[method][key]))])),
    personWindowWeighted: Object.fromEntries(metrics.map(key => [key,
      windows.reduce((sum, window) => sum + window.scoredCount * window.summaries[method][key], 0) / count]))
  }]));
  for (const failure of expectedFailures) for (const method of protocol.methods) {
    const row = Object.fromEntries(Object.keys(rows[0]).map(key => [key, null]));
    Object.assign(row, { anchor_frame: failure.anchor_frame, method,
      status: 'preparation_failed', failure_reason: failure.failure });
    rows.push(row);
  }
  const aggregateRows = [];
  for (const method of protocol.methods) for (const weighting of ['equalWindow', 'personWindowWeighted']) {
    const e = aggregate[method][weighting];
    aggregateRows.push({ method, weighting, windows: windows.length, scored_agent_windows: count,
      ADE_U: e.ade, FDE_U: e.fde, ADE_px: e.adePixels, FDE_px: e.fdePixels });
  }
  const summary = { createdAt: new Date().toISOString(), protocol,
    status: activationFailures.length ? 'complete_activation_target_unmet' : 'complete',
    plannedWindows: 5, expectedPreparationFailures: expectedFailures,
    completeComparisonWindows: windows.length, scoredPersonWindows: count,
    uniqueScoredIdentities: ids.size,
    identitiesScoredInMultipleWindows: [...ids.values()].filter(number => number > 1).length,
    activationFailures, windows, aggregate, exactFrameAndScoreParity: true,
    integrity: { checkedBefore: checkedFiles, checkedAfter: verifyInputs() } };
  write('summary.json', summary);
  write('summary.csv', csv(rows));
  write('aggregate.csv', csv(aggregateRows));
  const outputs = fs.readdirSync(output).filter(name => name !== 'run_started.json');
  write('receipt.json', { status: 'complete', exactFrameAndScoreParity: true,
    output_sha256: Object.fromEntries(outputs.map(name => [name, hash(fs.readFileSync(path.join(output, name)))])) });
  return summary;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') {
      console.log('Usage: node auxiliary/mot20/run.cjs --output OUT\nOUT must be a new directory. Runs four frozen MOT20-03 windows and four methods.');
    } else {
      if (args.length !== 2 || args[0] !== '--output' || !args[1] || args[1].startsWith('--')) {
        throw Error('Usage: node auxiliary/mot20/run.cjs --output OUT');
      }
      run(path.resolve(args[1]));
    }
  } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
}
module.exports = { run, verifyInputs };
