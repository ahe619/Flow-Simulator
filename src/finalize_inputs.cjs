'use strict';

const path = require('node:path');
const {calibrate} = require('./calibration.cjs');
const measure = require('./measurements.cjs');
const io = require('./io.cjs');

function crossingCoverage(frames, duration) {
  const bins = Array.from({length: Math.ceil(duration / 10)}, (_, i) => ({
    start: i * 10, end: Math.min(duration, (i + 1) * 10), referenceComplete: true
  }));
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].agents === null || frames[i - 1].agents === null) {
      const a = Math.max(0, frames[i - 1].time), b = Math.min(duration, frames[i].time);
      for (const bin of bins) {
        if (a < bin.end - 1e-9 && b > bin.start + 1e-9) bin.referenceComplete = false;
      }
    }
  }
  return bins;
}

function finalize(directory, camera) {
  const protocolPath = path.join(directory, 'protocols', camera + '.json');
  const protocol = io.readJSON(protocolPath);
  io.verifyCore(protocol.coreHashes);
  const input = io.readJSON(path.join(directory, 'inputs', camera + '.json'));
  const reference = io.readJSON(path.join(directory, 'observations', camera + '.json'));
  const pressure = input.calibration.snapshots.some(s => s.agents.length)
    ? calibrate(input) : {pressureRho0: 12, emptyCalibration: true};
  pressure.selectionRule = protocol.pressure.thresholdPolicy;
  pressure.calibrationOverlap = protocol.pressure.calibrationOverlap;
  pressure.feedbackLaw = 'Frozen Stage1 receiver-self-excluded pressure feedback';
  input.parameters.pressureRho0 = pressure.pressureRho0;
  input.calibration.pressure = pressure;
  io.writeNewJSON(path.join(directory, 'calibrated_inputs', camera + '.json'), input);
  const measurement = measure.measureFrames(reference.frames, input.scene, {
    dtSeconds: input.sampleIntervalSeconds, durationSeconds: input.durationSeconds
  });
  measurement.counts10s = measure.countFramesAtTimes(reference.frames, input.scene, {
    durationSeconds: input.durationSeconds, mode: 'observed_preceding'
  });
  io.writeNewJSON(path.join(directory, 'observed_measurements', camera + '.json'), {
    measurement, referenceCrossings: reference.referenceCrossings,
    crossingBinCoverage: crossingCoverage(reference.frames, input.durationSeconds),
    referenceStatus: 'Automatic tracker proxy; strict cumulative crossings are observed-event totals, with missing intervals unfilled',
    protocolSha256: io.sha256(protocolPath)
  });
  console.log(JSON.stringify({camera, pressureRho0: pressure.pressureRho0}));
}

if (require.main === module) {
  const [directory, camera] = process.argv.slice(2);
  if (!directory || !/^[A-F]$/.test(camera || '')) throw Error('Usage: node src/finalize_inputs.cjs DATA CAMERA');
  finalize(path.resolve(directory), camera);
}
module.exports = {crossingCoverage, finalize};
