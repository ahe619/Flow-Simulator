'use strict';

// Observation preparation only: no interpolation, simulation, or future-derived
// initialization. Coordinates retain the dataset's units without rescaling.
const DEFAULTS = Object.freeze({
  fps: 7, sequenceFrames: 795, historySteps: 14, futureSteps: 28,
  strideFrames: 43, firstAnchor: 15
});

function integer(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  }
}

function readOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }
  const config = { ...DEFAULTS, ...options };
  if (!Number.isFinite(config.fps) || config.fps <= 0 || !Number.isFinite(1 / config.fps)) {
    throw new RangeError('fps must be finite and positive with a finite frame interval');
  }
  for (const key of ['sequenceFrames', 'historySteps', 'futureSteps', 'strideFrames', 'firstAnchor']) {
    integer(config[key], key, 1);
  }
  if (config.firstAnchor <= config.historySteps) {
    throw new RangeError('firstAnchor must allow the requested history starting at frame >= 1');
  }
  if (!Number.isFinite((config.sequenceFrames - 1) / config.fps)) {
    throw new RangeError('sequence time must be finite');
  }
  return config;
}

function indexRecords(dataset, config) {
  if (!dataset || typeof dataset !== 'object' || !Array.isArray(dataset.records)) {
    throw new TypeError('dataset.records must be an array');
  }
  const tracks = new Map();
  const frames = new Map();
  for (let i = 0; i < dataset.records.length; i++) {
    const record = dataset.records[i];
    if (!Array.isArray(record) || record.length !== 6 || !Array.from(record).every(Number.isFinite)) {
      throw new TypeError(`record ${i} must contain six finite numbers [frame,id,time_s,x_m,y_m,z_m]`);
    }
    const [frame, id, time, x, y] = record;
    integer(frame, `record ${i} frame`, 1);
    integer(id, `record ${i} id`, 0);
    if (frame > config.sequenceFrames) throw new RangeError(`record ${i} frame exceeds sequenceFrames`);
    const expectedTime = (frame - 1) / config.fps;
    // Permit only floating-point roundoff, not rounded timestamps or shifted time origins.
    const tolerance = 16 * Number.EPSILON * Math.max(1, Math.abs(expectedTime));
    if (Math.abs(time - expectedTime) > tolerance) {
      throw new RangeError(`record ${i} time_s must equal (frame - 1) / fps`);
    }
    if (!tracks.has(id)) tracks.set(id, new Map());
    const track = tracks.get(id);
    if (track.has(frame)) throw new RangeError(`duplicate frame/id (${frame},${id})`);
    // Canonical frame-derived time avoids dependence on insignificant serialization roundoff.
    const point = { frame, t: expectedTime, x, y };
    track.set(frame, point);
    if (!frames.has(frame)) frames.set(frame, []);
    frames.get(frame).push(id);
  }
  return { tracks, frames };
}

function copyPoint(point) {
  return { frame: point.frame, t: point.t, x: point.x, y: point.y };
}

function estimateVelocity(points, fps) {
  const last = points[points.length - 1];
  const meanFrame = (points[0].frame + last.frame) / 2;
  let denominator = 0;
  let numeratorX = 0;
  let numeratorY = 0;
  for (const point of points) {
    const centeredFrame = point.frame - meanFrame;
    denominator += centeredFrame * centeredFrame;
    // Subtracting the last position improves numerical conditioning. This is a
    // free-intercept least-squares slope, not a fit forced through the last point.
    numeratorX += centeredFrame * (point.x - last.x);
    numeratorY += centeredFrame * (point.y - last.y);
  }
  const vx = fps * numeratorX / denominator;
  const vy = fps * numeratorY / denominator;
  if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
    throw new RangeError('history velocity estimate must be finite');
  }
  return { vx, vy };
}

/**
 * Build fixed-anchor windows from { records: [[frame,id,time_s,x,y,z], ...] }.
 *
 * All point.t and anchorTime values are absolute seconds from sequence frame 1.
 * Each initialAgent has {id,x,y,vx,vy,historyCount}; membership and every value
 * depend ONLY on observations at or before the anchor. At least two consecutive
 * observations (a-1,a) are required. History is the consecutive suffix ending at
 * a, capped at historySteps+1 observations; a gap is never interpolated or crossed.
 *
 * targets contains ONLY scoring-eligible initial agents: complete capped history
 * plus every future frame a+1..a+futureSteps. All initial agents must be simulated,
 * including agents missing from targets. Future arrivals appear only in diagnostics.
 */
function buildWindows(dataset, options = {}) {
  const config = readOptions(options);
  const { fps, sequenceFrames, historySteps, futureSteps, strideFrames, firstAnchor } = config;
  const { tracks, frames } = indexRecords(dataset, config);
  const windows = [];
  const lastAnchor = sequenceFrames - futureSteps;
  for (let anchor = firstAnchor; anchor <= lastAnchor;) {
    const historyStart = anchor - historySteps;
    const futureEnd = anchor + futureSteps;
    const presentIds = [...(frames.get(anchor) || [])].sort((a, b) => a - b);
    const initialAgents = [];
    const history = [];
    const targets = [];
    const diagnostics = {
      historyStartFrame: historyStart,
      futureEndFrame: futureEnd,
      presentAtAnchorIds: presentIds,
      initialCount: 0,
      eligibleCount: 0,
      eligibleIds: [],
      excludedAtAnchor: [],
      historyTruncations: [],
      unscoredInitialAgents: [],
      futureUnsimulatedAgents: []
    };

    for (const id of presentIds) {
      const track = tracks.get(id);
      const points = [];
      let frame = anchor;
      while (frame >= historyStart && track.has(frame)) {
        points.push(copyPoint(track.get(frame)));
        frame--;
      }
      points.reverse();
      if (frame >= historyStart) {
        const discardedEarlierFrames = [];
        for (let earlier = historyStart; earlier < frame; earlier++) {
          if (track.has(earlier)) discardedEarlierFrames.push(earlier);
        }
        diagnostics.historyTruncations.push({
          id, retainedStartFrame: points[0].frame, retainedCount: points.length,
          firstMissingFrame: frame, discardedEarlierFrames
        });
      }
      if (points.length < 2) {
        diagnostics.excludedAtAnchor.push({ id, reason: 'fewer_than_two_consecutive_observations', historyCount: points.length });
        continue;
      }
      const last = points[points.length - 1];
      const velocity = estimateVelocity(points, fps);
      initialAgents.push({ id, x: last.x, y: last.y, ...velocity, historyCount: points.length });
      history.push({ id, points });

      // Scoring eligibility is deliberately evaluated AFTER pure-history initialization.
      const future = [];
      const missingFutureFrames = [];
      for (let futureFrame = anchor + 1; futureFrame <= futureEnd; futureFrame++) {
        if (track.has(futureFrame)) future.push(copyPoint(track.get(futureFrame)));
        else missingFutureFrames.push(futureFrame);
      }
      const completeHistory = points.length === historySteps + 1;
      if (completeHistory && missingFutureFrames.length === 0) {
        targets.push({ id, points: future });
        diagnostics.eligibleIds.push(id);
      } else {
        const reasons = [];
        if (!completeHistory) reasons.push('short_contiguous_history');
        if (missingFutureFrames.length > 0) reasons.push('missing_future_observations');
        diagnostics.unscoredInitialAgents.push({ id, reasons, historyCount: points.length, missingFutureFrames });
      }
    }

    const initialIds = new Set(initialAgents.map(agent => agent.id));
    const presentIdSet = new Set(presentIds);
    for (const [id, track] of [...tracks.entries()].sort((a, b) => a[0] - b[0])) {
      if (initialIds.has(id)) continue;
      let firstFutureFrame = null;
      let observationCount = 0;
      for (let frame = anchor + 1; frame <= futureEnd; frame++) {
        if (track.has(frame)) {
          if (firstFutureFrame === null) firstFutureFrame = frame;
          observationCount++;
        }
      }
      if (observationCount > 0) {
        diagnostics.futureUnsimulatedAgents.push({
          id, firstFutureFrame, observationCount, presentAtAnchor: presentIdSet.has(id),
          seenBeforeAnchor: [...track.keys()].some(frame => frame < anchor)
        });
      }
    }
    diagnostics.initialCount = initialAgents.length;
    diagnostics.eligibleCount = targets.length;
    windows.push({ anchorFrame: anchor, anchorTime: (anchor - 1) / fps, initialAgents, history, targets, diagnostics });
    // Avoid integer overflow for otherwise valid but very large strideFrames.
    if (strideFrames > lastAnchor - anchor) break;
    anchor += strideFrames;
  }
  return windows;
}

module.exports = { buildWindows };
