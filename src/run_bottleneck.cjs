'use strict';

const path = require('node:path');
const {runCase} = require('./bottleneck.cjs');
const {gridPhase} = require('./grid_phase.cjs');
const io = require('./io.cjs');

function runOne({output, inflow, seed, method, durationSeconds}) {
  const protocolPath = path.join(__dirname, '..', 'configs', 'bottleneck.json');
  const protocol = io.readJSON(protocolPath);
  io.verifyCore(protocol.coreHashes);
  if (!protocol.arrivalRates.includes(inflow) || !protocol.seeds.includes(seed) || !protocol.methods.includes(method)) {
    throw new Error('Case is outside the bottleneck protocol');
  }
  const diagnostic = durationSeconds !== undefined;
  const duration = diagnostic ? durationSeconds : protocol.fixedConfig.maxTime;
  if (!Number.isFinite(duration) || duration <= 0 || duration > protocol.fixedConfig.maxTime) {
    throw new Error('Duration must be positive and no longer than the protocol horizon');
  }
  const caseId = `rate_${inflow}_seed_${String(seed).padStart(2, '0')}_${method}`;
  const prefix = diagnostic ? `diagnostic__${duration}__` : '';
  const destination = path.resolve(output, 'runs', `${prefix}s1_rate_${inflow}__${method}__seed${String(seed).padStart(2, '0')}.json`);
  const release = io.reserveOutput(destination);
  try {
    const config = {...protocol.fixedConfig, arrivalRate: inflow, seed,
      feedbackOn: method === 'feedback_on',
      pressureGridOrigin: gridPhase(seed, protocol.fixedConfig.pressureGridSize)};
    if (diagnostic) {
      config.maxTime = duration;
      // The base engine requires demand to end within its horizon. Short
      // diagnostics stop arrivals at the same time they stop integration.
      config.arrivalDuration = Math.min(duration, config.arrivalDuration);
    }
    const run = runCase({caseId, method, config}, protocol);
    if (diagnostic) {
      run.runType = 'diagnostic';
      run.paperResult = false;
    } else {
      run.parentDemandIdentityPassed = io.valueHash(run.requestedDemand) === protocol.expectedDemandSha256[caseId];
      if (!run.parentDemandIdentityPassed) throw new Error('Requested demand differs from the archived paper run');
    }
    run.provenance = {createdAt: new Date().toISOString(), protocolSha256: io.sha256(protocolPath),
      runnerSha256: io.sha256(__filename), sourceHashes: io.sourceHashes(), coreHashes: protocol.coreHashes,
      runType: diagnostic ? 'diagnostic' : 'paper_reproduction'};
    io.writeNewJSON(destination, run);
    io.writeNewJSON(destination + '.receipt.json', {sha256: io.sha256(destination),
      status: run.implementationGatePassed ? 'scored' : 'numerical_gate_failed',
      runType: run.provenance.runType, createdAt: new Date().toISOString()});
    console.log(JSON.stringify({caseId, status: run.implementationGatePassed ? 'complete' : 'numerical_gate_failed',
      elapsedSeconds: run.elapsedSeconds, drainTimeSeconds: run.drainTimeSeconds,
      pressureActivation: run.diagnostics.feedbackAppliedFraction, file: destination}));
    if (!run.implementationGatePassed) throw new Error('Numerical checks failed; output retained for review');
    return run;
  } finally {
    release();
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('node src/run_bottleneck.cjs --output OUT --inflow 6 --seed 1 --method feedback_on [--duration SECONDS]');
    console.log('--duration creates a diagnostic run. The paper protocol uses a 0.01 s integration step.');
    return;
  }
  const args = io.parseArgs(argv, ['output', 'inflow', 'seed', 'method'], ['duration']);
  runOne({output: args.output, inflow: Number(args.inflow), seed: Number(args.seed), method: args.method,
    durationSeconds: args.duration === undefined ? undefined : Number(args.duration)});
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = {runOne};
