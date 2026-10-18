'use strict';

// Post-hoc measurement only: no simulator forces, goals, demand, or parameters
// are changed here. Observation and simulation call the identical estimator.
// Inclusive geometry tolerance shared by observed and simulated positions;
// homography floating-point round-off must not drop a boundary observation.
const EPS = 1e-6;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
function finite(v, name) { if (!Number.isFinite(v)) throw new TypeError(`${name} must be finite`); return v; }
function timeKey(time) { return finite(time, 'time').toFixed(7); }
function point(p, name) {
  if (!Array.isArray(p) || p.length !== 2) throw new TypeError(`${name} must be [x,y]`);
  return p.map(v => finite(v, name));
}
function polygon(p, name) {
  if (!Array.isArray(p) || p.length < 3) throw new TypeError(`${name} needs three or more vertices`);
  return p.map(q => point(q, name));
}
function segmentDistance(x, y, p0, p1) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], d2 = dx * dx + dy * dy;
  const t = d2 ? Math.max(0, Math.min(1, ((x - p0[0]) * dx + (y - p0[1]) * dy) / d2)) : 0;
  return Math.hypot(x - p0[0] - t * dx, y - p0[1] - t * dy);
}
function polygonBoundaryDistance(x, y, p) {
  let d = Infinity;
  for (let i = 0; i < p.length; i++) d = Math.min(d, segmentDistance(x, y, p[i], p[(i + 1) % p.length]));
  return d;
}
function pointInPolygon(x, y, p) {
  if (polygonBoundaryDistance(x, y, p) <= EPS) return true;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[j], b = p[i];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function makeQueueRegion(scene, { widthW = 1.5, depthW = 1 } = {}) {
  if (!(widthW > 0 && depthW > 0)) throw new RangeError('queue region width/depth must be positive');
  const p0 = point(scene.mouth?.p0, 'mouth.p0'), p1 = point(scene.mouth?.p1, 'mouth.p1');
  const sign = scene.mouth.inboundSign ?? -1;
  if (![-1, 1].includes(sign)) throw new RangeError('mouth.inboundSign must be -1 or 1');
  const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  if (length <= EPS) throw new RangeError('mouth has zero length');
  const tangent = [(p1[0] - p0[0]) / length, (p1[1] - p0[1]) / length];
  const approachNormal = [sign * tangent[1], -sign * tangent[0]];
  const centre = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const localPoint = (along, depth) => [centre[0] + along * tangent[0] + depth * approachNormal[0],
    centre[1] + along * tangent[1] + depth * approachNormal[1]];
  return { widthW, depthW, centre, tangent, approachNormal,
    corners: [localPoint(-widthW / 2, 0), localPoint(widthW / 2, 0), localPoint(widthW / 2, depthW), localPoint(-widthW / 2, depthW)],
    intersectionRule: 'mouth-front rectangle intersected with occupancyPolygon and current domain membership',
    interpretation: 'queue_region_count is a spatial queue proxy, not a behavioral queue classification' };
}
function inQueue(x, y, region, occupancyPolygon) {
  const dx = x - region.centre[0], dy = y - region.centre[1];
  const along = dx * region.tangent[0] + dy * region.tangent[1];
  const depth = dx * region.approachNormal[0] + dy * region.approachNormal[1];
  return Math.abs(along) <= region.widthW / 2 + EPS && depth >= -EPS && depth <= region.depthW + EPS && pointInPolygon(x, y, occupancyPolygon);
}

function gaussianKernel(distanceW, sigmaW = .28, cutoffSigma = 3) {
  finite(distanceW, 'distanceW'); finite(sigmaW, 'sigmaW'); finite(cutoffSigma, 'cutoffSigma');
  if (distanceW < 0 || sigmaW <= 0 || cutoffSigma <= 0) throw new RangeError('invalid kernel argument');
  if (distanceW > sigmaW * cutoffSigma) return 0;
  const normalization = 1 - Math.exp(-.5 * cutoffSigma ** 2);
  return Math.exp(-.5 * (distanceW / sigmaW) ** 2) / (2 * Math.PI * sigmaW ** 2 * normalization);
}
function ols(points) {
  const mt = mean(points.map(p => p.time)), mx = mean(points.map(p => p.x)), my = mean(points.map(p => p.y));
  const denominator = points.reduce((sum, p) => sum + (p.time - mt) ** 2, 0);
  if (!(denominator > 0)) throw new RangeError('OLS needs distinct times');
  const vx = points.reduce((sum, p) => sum + (p.time - mt) * (p.x - mx), 0) / denominator;
  const vy = points.reduce((sum, p) => sum + (p.time - mt) * (p.y - my), 0) / denominator;
  return { vx, vy, speed: Math.hypot(vx, vy) };
}

function measureFrames(frames, scene, options = {}) {
  if (!Array.isArray(frames)) throw new TypeError('frames must be an array');
  const sigmaW = options.sigmaW ?? .28, cutoffSigma = options.cutoffSigma ?? 3;
  const historyPoints = options.historyPoints ?? 3, dtSeconds = options.dtSeconds;
  gaussianKernel(0, sigmaW, cutoffSigma);
  if (!(Number.isFinite(dtSeconds) && dtSeconds > 0)) throw new RangeError('explicit positive dtSeconds is required');
  if (!Number.isInteger(historyPoints) || historyPoints < 2) throw new RangeError('historyPoints must be an integer at least 2');
  const domain = polygon(scene.domainPolygon, 'domainPolygon');
  const occupancy = polygon(scene.occupancyPolygon ?? domain, 'occupancyPolygon');
  const queueRegion = makeQueueRegion(scene);
  const ordered = frames.map(frame => {
    const time = finite(frame.time, 'frame.time');
    if (frame.agents === null) return { time, byId: null };
    if (!Array.isArray(frame.agents)) throw new TypeError('frame.agents must be an array or null for missing observation');
    const byId = new Map();
    for (const a of frame.agents) {
      if (!(typeof a.id === 'string' || typeof a.id === 'number' && Number.isFinite(a.id)) || byId.has(a.id)) throw new RangeError('each frame requires valid unique IDs');
      byId.set(a.id, { id: a.id, x: finite(a.x, 'agent.x'), y: finite(a.y, 'agent.y') });
    }
    return { time, byId };
  }).sort((a, b) => a.time - b.time);
  if (new Set(ordered.map(f => timeKey(f.time))).size !== ordered.length) throw new RangeError('duplicate frame times');
  const timeseries = [], fdPoints = [];
  const gapTolerance = Math.max(1e-7, dtSeconds * 1e-6);
  const evaluationEnd = options.durationSeconds ?? Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const frame = ordered[i];
    if (frame.time < 0 || frame.time > evaluationEnd) continue;
    if (frame.byId === null) {
      timeseries.push({ time: frame.time, whole_roi_count: null, queue_region_count: null, mean_speed: null,
        speed_sample_count: 0, fd_point_count: 0, missing_frame: true });
      continue;
    }
    const current = [...frame.byId.values()].filter(a => pointInPolygon(a.x, a.y, domain));
    const currentPoints = [];
    for (const a of current) {
      let rho = 0;
      for (const b of current) rho += gaussianKernel(Math.hypot(a.x - b.x, a.y - b.y), sigmaW, cutoffSigma);
      const history = [];
      let stopReason = 'history_window_complete';
      for (let j = i; j >= Math.max(0, i - historyPoints + 1); j--) {
        if (j < i && Math.abs(ordered[j + 1].time - ordered[j].time - dtSeconds) > gapTolerance) { stopReason = 'non_native_time_gap'; break; }
        if (ordered[j].byId === null) { stopReason = 'missing_frame'; break; }
        const p = ordered[j].byId.get(a.id);
        if (!p) { stopReason = 'missing_id'; break; }
        history.push({ time: ordered[j].time, x: p.x, y: p.y });
      }
      if (history.length < historyPoints && stopReason === 'history_window_complete') stopReason = 'start_of_available_history';
      const velocity = history.length >= 2 ? ols(history) : null;
      const boundaryDistance = polygonBoundaryDistance(a.x, a.y, domain);
      currentPoints.push({ time: frame.time, id: a.id, x: a.x, y: a.y, rho,
        speed: velocity?.speed ?? null, q: velocity ? rho * velocity.speed : null,
        vx_ols: velocity?.vx ?? null, vy_ols: velocity?.vy ?? null,
        history_count: history.length, history_stop_reason: stopReason,
        inside_occupancy: pointInPolygon(a.x, a.y, occupancy), inside_queue_region: inQueue(a.x, a.y, queueRegion, occupancy),
        boundary_distance: boundaryDistance, boundary_bias: boundaryDistance < sigmaW * cutoffSigma });
    }
    fdPoints.push(...currentPoints);
    const roi = currentPoints.filter(a => a.inside_occupancy), validSpeed = roi.filter(a => a.speed !== null);
    timeseries.push({ time: frame.time, whole_roi_count: roi.length,
      queue_region_count: currentPoints.filter(a => a.inside_queue_region).length,
      mean_speed: mean(validSpeed.map(a => a.speed)), speed_sample_count: validSpeed.length,
      fd_point_count: currentPoints.length, missing_frame: false });
  }
  return { timeseries, fdPoints, queueRegion,
    units: { time: 'source seconds', position: 'W', sigmaW: 'W', boundary_distance: 'W',
      rho: 'persons/W^2', speed: 'W/s', vx_ols: 'W/s', vy_ols: 'W/s', q: 'persons/(W*s)',
      whole_roi_count: 'persons', queue_region_count: 'persons' },
    metadata: { sigmaW, cutoffSigma, kernelRadiusW: sigmaW * cutoffSigma,
      kernelNormalization: 1 - Math.exp(-.5 * cutoffSigma ** 2), kernelIncludesSelf: true,
      kernel: 'isotropic 2D Gaussian truncated at cutoffSigma*sigmaW and normalized over its retained disk',
      currentMembership: 'only current inside-domain agents contribute density and receive FD points',
      pointInPolygonToleranceW: EPS,
      boundaryCorrection: false, boundaryBiasFlag: 'true when the truncated kernel reaches beyond domainPolygon; no missing-mass correction',
      wallVisibilityCorrection: false,
      historyPoints, minHistoryPoints: 2, dtSeconds, speedEstimator: 'past-only OLS of same-ID positions over consecutive native samples; never input vx/vy',
      historyCanPrecedeEvaluation: true, historyCanBeOutsideDomain: true,
      missingSpeedRetained: true, evaluationStartSeconds: 0, evaluationEndSeconds: Number.isFinite(evaluationEnd) ? evaluationEnd : null,
      qMeaning: 'rho times speed magnitude; a local flow proxy, not directional crossing flow',
      queueMeaning: queueRegion.interpretation } };
}

function compareCountSeries(pred, obs, field, durationSeconds) {
  const p = new Map(pred.timeseries.map(row => [timeKey(row.time), row]));
  const o = new Map(obs.timeseries.map(row => [timeKey(row.time), row]));
  if (p.size !== pred.timeseries.length || o.size !== obs.timeseries.length) throw new RangeError('duplicate measurement times');
  const rows = [], skipped = [];
  for (const row of obs.timeseries) {
    if (row.time < 0 || row.time > durationSeconds) continue;
    const prediction = p.get(timeKey(row.time));
    if (!prediction) { skipped.push({ time: row.time, reason: 'no_common_predicted_native_time' }); continue; }
    if (row[field] === null || prediction[field] === null) { skipped.push({ time: row.time, reason: 'missing_count' }); continue; }
    const observed = finite(row[field], `observed.${field}`), predicted = finite(prediction[field], `predicted.${field}`);
    if (observed < 0 || predicted < 0) throw new RangeError('negative count');
    rows.push({ time: row.time, observed, predicted, error: predicted - observed });
  }
  const values = rows.map(row => row.error);
  return { field, samples: rows, count: rows.length, skipped, skippedCount: skipped.length,
    rmse: values.length ? Math.sqrt(mean(values.map(e => e * e))) : null,
    mae: mean(values.map(Math.abs)), bias: mean(values),
    predictedNativeTimesWithoutReference: pred.timeseries.filter(row => row.time >= 0 && row.time <= durationSeconds && !o.has(timeKey(row.time))).map(row => row.time),
    aggregation: 'equal weight for each common available native sampling time; no temporal interpolation' };
}
function crossingBins(events, durationSeconds, binSeconds = 10) {
  if (!(Number.isFinite(durationSeconds) && durationSeconds > 0 && Number.isFinite(binSeconds) && binSeconds > 0)) throw new RangeError('positive finite duration/bin required');
  const bins = Array.from({ length: Math.ceil(durationSeconds / binSeconds) }, (_, i) => ({ start: i * binSeconds,
    end: Math.min((i + 1) * binSeconds, durationSeconds), into: 0, out: 0 }));
  const excluded = { beforeStart: 0, atOrAfterEnd: 0 };
  for (const event of events) {
    finite(event.time, 'crossing.time');
    if (!['into', 'out'].includes(event.direction)) throw new RangeError('crossing.direction must be into or out');
    if (event.time < 0) { excluded.beforeStart++; continue; }
    if (event.time >= durationSeconds) { excluded.atOrAfterEnd++; continue; }
    bins[Math.floor(event.time / binSeconds)][event.direction]++;
  }
  return { bins, excluded };
}
function compareMeasurements(pred, obs, crossingEvents, referenceCrossings, options = {}) {
  const durationSeconds = options.durationSeconds ?? 120, binSeconds = options.binSeconds ?? 10;
  const predicted = crossingBins(crossingEvents, durationSeconds, binSeconds), observed = crossingBins(referenceCrossings, durationSeconds, binSeconds);
  const cumulativePredicted = { into: 0, out: 0 }, cumulativeObserved = { into: 0, out: 0 };
  const bins = predicted.bins.map((p, k) => {
    const o = observed.bins[k];
    const row = { start: p.start, end: p.end, predicted: {}, observed: {}, signedError: {}, absoluteError: {},
      cumulativePredicted: {}, cumulativeObserved: {}, cumulativeSignedError: {}, cumulativeAbsoluteError: {} };
    for (const direction of ['into', 'out']) {
      row.predicted[direction] = p[direction]; row.observed[direction] = o[direction];
      row.signedError[direction] = p[direction] - o[direction]; row.absoluteError[direction] = Math.abs(row.signedError[direction]);
      cumulativePredicted[direction] += p[direction]; cumulativeObserved[direction] += o[direction];
      row.cumulativePredicted[direction] = cumulativePredicted[direction]; row.cumulativeObserved[direction] = cumulativeObserved[direction];
      row.cumulativeSignedError[direction] = cumulativePredicted[direction] - cumulativeObserved[direction];
      row.cumulativeAbsoluteError[direction] = Math.abs(row.cumulativeSignedError[direction]);
    }
    return row;
  });
  const directionalMetric = fn => Object.fromEntries(['into', 'out'].map(d => [d, fn(d)]));
  const wholeRoi = compareCountSeries(pred, obs, 'whole_roi_count', durationSeconds);
  const queueRegion = compareCountSeries(pred, obs, 'queue_region_count', durationSeconds);
  return { wholeRoi, queueRegion,
    crossings: { bins, binSeconds, durationSeconds, totals: { predicted: cumulativePredicted, observed: cumulativeObserved },
      endpointSignedError: directionalMetric(d => cumulativePredicted[d] - cumulativeObserved[d]),
      endpointAbsoluteError: directionalMetric(d => Math.abs(cumulativePredicted[d] - cumulativeObserved[d])),
      binCountRMSE: directionalMetric(d => Math.sqrt(mean(bins.map(b => b.signedError[d] ** 2)))),
      binCountMAE: directionalMetric(d => mean(bins.map(b => b.absoluteError[d]))),
      excluded: { predicted: predicted.excluded, observed: observed.excluded },
      eventWindow: '[0,durationSeconds), left-inclusive/right-exclusive bins; directions never cancel', units: 'persons' },
    alignment: { timeMatching: 'native sample times rounded to 1e-7 seconds; no interpolation',
      wholeRoiCommonSamples: wholeRoi.count, queueRegionCommonSamples: queueRegion.count },
    referenceStatus: 'automatic tracking proxy, not human ground truth' };
}

module.exports = { measureFrames, compareMeasurements, makeQueueRegion, gaussianKernel, crossingBins,
  pointInPolygon, polygonBoundaryDistance, timeKey };
