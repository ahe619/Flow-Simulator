"""Measurements and paired statistics for saved simulation runs.

The numerical definitions match the published continuous-recording analysis.
Times are source-video seconds unless a column explicitly uses dataset time tV.
"""
from __future__ import annotations

import csv
import hashlib
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np

CAMERAS = list("ABCDEF")
METHODS = ["feedback_off", "feedback_on"]
T95 = {2: 12.7062047364, 3: 4.3026527297, 4: 3.1824463053, 5: 2.7764451052,
       6: 2.5705818356, 7: 2.4469118511, 8: 2.3646242516, 9: 2.3060041352,
       10: 2.2621571629}


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def load(path, hashes):
    data = Path(path).read_bytes()
    hashes[str(Path(path).resolve())] = hashlib.sha256(data).hexdigest()
    return json.loads(data)


def number(value):
    return float(value) if value is not None and np.isfinite(value) else np.nan


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    if isinstance(value, (float, np.floating)) and not math.isfinite(value):
        return None
    if isinstance(value, np.generic):
        return value.item()
    return value


def write_csv(path, rows):
    if not rows:
        return
    fields = list(dict.fromkeys(k for row in rows for k in row))
    with Path(path).open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader()
        for row in rows:
            w.writerow({k: json.dumps(clean(v), ensure_ascii=False) if isinstance(v, (list, dict)) else clean(v) for k, v in row.items()})


def mean(values):
    a = np.asarray([number(v) for v in values], dtype=float)
    return float(np.nanmean(a)) if np.any(np.isfinite(a)) else None


def rmse(predicted, observed):
    a, b = np.asarray(predicted, dtype=float), np.asarray(observed, dtype=float)
    keep = np.isfinite(a) & np.isfinite(b)
    return (float(np.sqrt(np.mean((a[keep]-b[keep])**2))) if keep.any() else None, int(keep.sum()))


def paired_interval(values):
    a = np.asarray([x for x in values if x is not None and math.isfinite(x)], dtype=float)
    n = len(a)
    if n == 0:
        return {'paired_n': 0, 'mean_on_minus_off': None, 'sample_sd': None, 'ci95_lower': None, 'ci95_upper': None}
    m = float(a.mean())
    if n == 1:
        return {'paired_n': 1, 'mean_on_minus_off': m, 'sample_sd': None, 'ci95_lower': None, 'ci95_upper': None}
    if n in T95:
        critical = T95[n]
    else:
        from scipy.stats import t
        critical = float(t.ppf(.975, n-1))
    sd = float(a.std(ddof=1)); half = critical*sd/math.sqrt(n)
    return {'paired_n': n, 'mean_on_minus_off': m, 'sample_sd': sd, 'ci95_lower': m-half, 'ci95_upper': m+half}


def clock(input_, protocol, camera):
    dt = float(input_.get('sampleIntervalSeconds', protocol['sampleIntervalSecondsByCamera'][camera]))
    first = int(input_.get('startSample', 3))
    return dt, first, float(input_['durationSeconds'])


def phase_ranges(protocol, dt, first, duration):
    rows = []
    for p in protocol['phasesVivian']:
        a = (float(p['start'])+3-first)*dt
        b = duration if p.get('end') is None else (float(p['end'])+3-first)*dt
        lo, hi = max(0., a), min(duration, b)
        if hi > lo:
            rows.append({'name': p['name'], 'start': lo, 'end': hi,
                         'start_tV': lo/dt+first-3, 'end_tV': hi/dt+first-3})
    return rows


def phase_at(t, phases):
    return next((p['name'] for p in phases if p['start'] <= t < p['end']), phases[-1]['name'])


def events_between(events, start, end, direction):
    return [e for e in events if start <= e['time'] < end and e['direction'] == direction]


def source_identity(agent):
    return str(agent.get('sourceId', agent.get('id')))


def covered_events(events, initial, arrivals, conservative=False, admissions=None):
    first = {source_identity(a): 0. for a in initial}
    byid = {str(a['id']): source_identity(a) for a in arrivals}
    for a in arrivals:
        t = a['timeBracket'][1] if conservative and 'timeBracket' in a else a['time']
        first[source_identity(a)] = min(first.get(source_identity(a), math.inf), t)
    if admissions is not None:
        first = {source_identity(a): 0. for a in initial}
        for e in admissions:
            sid = str(e.get('sourceId', byid.get(str(e['id']), e['id'])))
            first[sid] = min(first.get(sid, math.inf), e['time'])
    return [e for e in events if first.get(source_identity(e), math.inf) <= e['time']+1e-9]


def measure_rows(camera, method, seed, measurement, dt, first, phases, native=False):
    rows = []
    for r in measurement['timeseries' if native else 'counts10s']:
        t = float(r['time'])
        rows.append({'camera': camera, 'method': method, 'seed': seed, 'elapsed_s': t,
                     'dataset_time_tV': t/dt+first-3, 'source_video_clock_s': t+(first-1)*dt,
                     'phase_reference': phase_at(t, phases), 'first60s_calibration': t < 60,
                     'whole_roi_count_agents': r.get('whole_roi_count'),
                     'mouth_front_count_agents': r.get('queue_region_count'),
                     'mean_displacement_speed_W_per_s': r.get('mean_speed') if native else None,
                     'speed_sample_count': r.get('speed_sample_count') if native else None,
                     'observation_missing': bool(r.get('missing_frame', False) or r.get('whole_roi_count') is None),
                     'reference_source_elapsed_s': r.get('sourceTime', t), 'reference_lag_s': r.get('lagSeconds', 0)})
    return rows


def crossing_rows(camera, method, seed, bins, dt, first, phases, observation=False):
    rows = []
    kind = 'observed' if observation else 'predicted'
    cumulative = 'cumulativeObserved' if observation else 'cumulativePredicted'
    for b in bins:
        row = {'camera': camera, 'method': method, 'seed': seed,
               'bin_start_elapsed_s': b['start'], 'bin_end_elapsed_s': b['end'],
               'bin_duration_s': b['end']-b['start'], 'bin_start_tV': b['start']/dt+first-3,
               'bin_end_tV': b['end']/dt+first-3,
               'phase_reference_at_bin_start': phase_at(b['start'], phases),
               'reference_complete': b['referenceComplete']}
        for direction in ['into', 'out']:
            row[f'crossing_{direction}_agents'] = b[kind][direction]
            row[f'cumulative_{direction}_agents'] = b[cumulative][direction]
            if not observation:
                row[f'observed_strict_crossing_{direction}_agents'] = b['observed'][direction]
                row[f'crossing_signed_error_{direction}_agents'] = b['signedError'][direction] if b['referenceComplete'] else None
        rows.append(row)
    return rows


def summarize_phase(camera, run, observed, events, phase, dt, first, bin_coverage):
    a, b = phase['start'], phase['end']
    obs_map = {round(r['time'], 7): r for r in observed['counts10s']}
    rows = [r for r in run['measurements']['counts10s'] if a <= r['time'] < b]
    if b == run['config']['maxTime']:
        rows += [r for r in run['measurements']['counts10s'] if abs(r['time']-b) < 1e-7]
    reference = [obs_map.get(round(r['time'], 7), {}) for r in rows]
    whole, count = rmse([number(r['whole_roi_count']) for r in rows], [number(r.get('whole_roi_count')) for r in reference])
    queue, qcount = rmse([number(r['queue_region_count']) for r in rows], [number(r.get('queue_region_count')) for r in reference])
    native = [r for r in run['measurements']['timeseries'] if a <= r['time'] < b]
    ref_native = [r for r in observed['timeseries'] if a <= r['time'] < b]
    diagnostics = {round(r['time'], 7): r for r in run.get('phaseDiagnostics', [])}
    begin, end = diagnostics.get(round(a, 7)), diagnostics.get(round(b, 7))
    applied = end['feedbackApplied']-begin['feedbackApplied'] if begin and end else None
    steps = end['agentSubsteps']-begin['agentSubsteps'] if begin and end else None
    out = {'camera': camera, 'method': run['method'], 'seed': run['seed'], 'phase_reference': phase['name'],
           'phase_start_elapsed_s': a, 'phase_end_elapsed_s': b, 'phase_start_tV': a/dt+first-3,
           'phase_end_tV': b/dt+first-3, 'count_sample_pairs': count, 'queue_sample_pairs': qcount,
           'whole_roi_rmse_agents': whole, 'mouth_front_rmse_agents': queue,
           'observed_whole_roi_mean_agents': mean([r.get('whole_roi_count') for r in ref_native]),
           'simulated_whole_roi_mean_agents': mean([r.get('whole_roi_count') for r in native]),
           'observed_mouth_front_mean_agents': mean([r.get('queue_region_count') for r in ref_native]),
           'simulated_mouth_front_mean_agents': mean([r.get('queue_region_count') for r in native]),
           'simulated_mean_frame_speed_W_per_s': mean([r.get('mean_speed') for r in native]),
           'observed_mean_frame_speed_W_per_s': mean([r.get('mean_speed') for r in ref_native]),
           'feedback_applied_agent_substeps': applied, 'agent_substeps': steps,
           'feedback_applied_fraction': applied/steps if steps else (0. if steps == 0 else None),
           'phase_activation_exact_boundary_counters': begin is not None and end is not None}
    for direction in ['into', 'out']:
        obs = len(events_between(events, a, b, direction)); pred = len(events_between(run['crossingEvents'], a, b, direction))
        out[f'observed_crossings_{direction}_agents'] = obs
        out[f'simulated_crossings_{direction}_agents'] = pred
        out[f'crossing_endpoint_signed_error_{direction}_agents'] = pred-obs
        # Fixed global10s bins wholly contained in the phase; partial bins excluded.
        all_starts = np.arange(math.ceil((a-1e-9)/10)*10, b-10+1e-8, 10)
        starts = [t for t in all_starts if bin_coverage.get(round(float(t), 7), False)]
        delta = [len(events_between(run['crossingEvents'], t, t+10, direction))-len(events_between(events, t, t+10, direction)) for t in starts]
        out[f'crossing_10s_rmse_{direction}_agents'] = float(np.sqrt(np.mean(np.square(delta)))) if delta else None
        out['crossing_complete_10s_bins'] = len(delta)
        out['crossing_10s_bins_excluded_for_missing_reference'] = len(all_starts)-len(starts)
    return out


def make_paired(rows):
    groups = defaultdict(dict)
    for r in rows:
        if r.get('numerically_valid') is False:
            continue
        groups[(r['camera'], r.get('phase_reference', 'all'), r['seed'])][r['method']] = r
    wanted = ['whole_roi_rmse_agents', 'mouth_front_rmse_agents', 'queue_region_rmse_agents',
              'crossing_10s_rmse_into_agents', 'crossing_10s_rmse_out_agents',
              'crossing_bin_rmse_into_agents', 'crossing_bin_rmse_out_agents',
              'crossing_endpoint_signed_error_into_agents', 'crossing_endpoint_signed_error_out_agents']
    deltas = defaultdict(list)
    for (camera, phase, seed), pair in groups.items():
        if not all(method in pair for method in METHODS):
            continue
        for metric in wanted:
            a, b = pair[METHODS[0]].get(metric), pair[METHODS[1]].get(metric)
            if a is not None and b is not None:
                deltas[(camera, phase, metric)].append((seed, b-a))
    return [{'camera': c, 'phase_reference': p, 'metric': m, **paired_interval([v for _, v in pairs]),
             'seeds': [s for s, _ in pairs], 'interval_meaning': 'Conditional paired-seed t interval; one pair has no CI.'}
            for (c, p, m), pairs in sorted(deltas.items())]


def ensemble_rows(rows):
    groups = defaultdict(list)
    for r in rows:
        if r.get('numerically_valid') is False:
            continue
        for metric, value in r.items():
            if metric in ['seed', 'numerically_valid'] or isinstance(value, bool):
                continue
            if isinstance(value, (int, float)) and math.isfinite(value):
                groups[r['camera'], r.get('phase_reference', 'all'), r['method'], metric].append(value)
    return [{'camera': c, 'phase_reference': p, 'method': m, 'metric': metric, 'run_count': len(values),
             'mean': float(np.mean(values)), 'sample_sd': float(np.std(values, ddof=1)) if len(values)>1 else None,
             'minimum': min(values), 'maximum': max(values)} for (c,p,m,metric),values in sorted(groups.items())]


def clock_values(item, rows):
    dt, first, _ = item['clock']
    return np.asarray([r['time']/dt+first-3 for r in rows], dtype=float)


def native_index(item, method, seed):
    rows = item['native'].get(method, {}).get(seed, [])
    result = {}
    for tv, row in zip(clock_values(item, rows), rows):
        key = int(round(tv))
        if abs(tv-key) > 1e-5:
            raise ValueError(f'Native saved clock is not an exact tV sample: {tv}')
        result[key] = row
    return result


def summed_rows(items, *, cameras=None, seeds=None):
    cameras = list(items) if cameras is None else cameras
    cameras = [c for c in CAMERAS if c in cameras and c in items and items[c]['paired_seeds']]
    if not cameras:
        return [], []
    common = sorted(set.intersection(*(set(items[c]['paired_seeds']) for c in cameras)))
    if seeds is not None:
        common = [s for s in seeds if s in common]
    if not common:
        return [], cameras
    indexed = {(c, m, s): native_index(items[c], m, s) for c in cameras
               for m in ['observation_proxy']+METHODS for s in ([0] if m == 'observation_proxy' else common)}
    end = max(max(indexed[c, 'observation_proxy', 0]) for c in cameras)
    rows = []
    for tv in range(end+1):
        for method in ['observation_proxy']+METHODS:
            for seed in ([0] if method == 'observation_proxy' else common):
                values = [indexed[c, method, seed].get(tv, {}).get('whole_roi_count') for c in cameras]
                missing = [c for c, v in zip(cameras, values) if v is None]
                rows.append({'dataset_time_tV': tv, 'method': method,
                             'seed': '' if method == 'observation_proxy' else seed,
                             'sum_visible_roi_count_agents': sum(values) if not missing else None,
                             'included_cameras': ','.join(cameras), 'missing_cameras': ','.join(missing),
                             'meaning': 'Fixed available-camera subset; missing or out-of-record camera makes subtotal missing; not unique attendance.'})
    return rows, cameras
