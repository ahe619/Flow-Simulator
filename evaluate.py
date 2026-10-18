"""Evaluate saved Stadium or bottleneck runs without advancing the simulator."""
from __future__ import annotations

import argparse
import json
import math
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from src.evaluation import (
    METHODS, clean, clock, covered_events, crossing_rows, digest, ensemble_rows,
    events_between, load, make_paired, measure_rows, paired_interval, phase_ranges,
    summarize_phase, summed_rows, write_csv,
)


def data_file_hashes(path, data, hashes):
    """Verify a prepared data file and return its current/original digests."""
    actual = hashes[str(path.resolve())]
    allowed = {actual}
    manifest_path = data / 'manifest.json'
    if manifest_path.exists():
        manifest = load(manifest_path, hashes)
        relative = path.relative_to(data).as_posix()
        matched = False
        for record in manifest.get('files', []):
            name = record['file'].replace('\\', '/')
            if name == relative or name.endswith('/' + relative):
                matched = True
                if record['sha256'] != actual:
                    raise ValueError(f'Input differs from its data manifest: {path}')
                if record.get('originalSha256'):
                    allowed.add(record['originalSha256'])
        if not matched:
            raise ValueError(f'Prepared file is absent from the data manifest: {path}')
    return allowed


def verify_binding(provenance, key, path, data, hashes):
    """Accept current input bytes or an explicitly recorded original digest."""
    allowed = data_file_hashes(path, data, hashes)
    if provenance.get(key) not in allowed:
        raise ValueError(f'Run {key} does not match its input: {path}')


def evaluate_stadium(runs, data, hashes):
    if data is None:
        raise ValueError('--data is required for Stadium evaluation')
    run_paths = {}
    for path in sorted((runs / 'runs').glob('*.json')):
        match = re.fullmatch(r'([ABCDEF])__(feedback_off|feedback_on)__seed(\d+)\.json', path.name)
        if match:
            camera, method, seed = match.groups()
            run_paths[camera, int(seed), method] = path
    if not run_paths:
        raise ValueError('No complete Stadium run filenames found in RUNS/runs')
    cameras = sorted({camera for camera, seed, method in run_paths})
    summaries, phase_rows, native_rows, count_rows, coverage_rows, directional_rows = [], [], [], [], [], []
    items, omitted = {}, []
    for camera in cameras:
        camera_result = data
        camera_protocol_path = data / "protocols" / f"{camera}.json"
        camera_protocol = load(camera_protocol_path, hashes)
        input_file = camera_result/'calibrated_inputs'/f'{camera}.json'; obs_file = camera_result/'observations'/f'{camera}.json'
        measured_file = camera_result/'observed_measurements'/f'{camera}.json'
        if not all(p.exists() for p in [input_file, obs_file, measured_file]):
            omitted.append({'camera': camera, 'reason': 'Input or observed measurements not prepared'}); continue
        input_ = load(input_file, hashes); observation = load(obs_file, hashes); measured = load(measured_file, hashes)
        for prepared_file in [input_file, obs_file, measured_file, camera_protocol_path]:
            data_file_hashes(prepared_file, data, hashes)
        obs_measure = measured['measurement']; events = measured.get('referenceCrossings', observation['referenceCrossings'])
        bin_coverage = {round(r['start'], 7): bool(r['referenceComplete']) for r in measured.get('crossingBinCoverage', [])}
        if not bin_coverage:
            raise ValueError(f'{camera}: crossingBinCoverage required; missing-reference bins must not silently become zeros')
        dt, first, duration = clock(input_, camera_protocol, camera); phases = phase_ranges(camera_protocol, dt, first, duration)
        observed_bins = []; cumulative = {'into': 0, 'out': 0}
        for coverage_bin in measured['crossingBinCoverage']:
            b = dict(coverage_bin)
            b['observed'] = {d: len(events_between(events, b['start'], b['end'], d)) for d in ['into', 'out']}
            for d in ['into', 'out']:
                cumulative[d] += b['observed'][d]
            b['cumulativeObserved'] = dict(cumulative); observed_bins.append(b)
        directional_rows += crossing_rows(camera, 'observation_proxy', '', observed_bins, dt, first, phases, observation=True)
        seeds = sorted({seed for c, seed, method in run_paths if c == camera and all((c, seed, m) in run_paths for m in METHODS)})
        items[camera] = item = {'input': input_, 'clock': (dt, first, duration), 'phases': phases, 'paired_seeds': seeds,
                               'observation_measurement': obs_measure, 'plot_counts': {'observation_proxy': {0: []}},
                               'native': {'observation_proxy': {0: obs_measure['timeseries']}}, 'coverage_by_seed': {}}
        nominal_covered = covered_events(events, input_['initialAgents'], input_['arrivals'], conservative=True)
        for phase in [{'name':'all','start':0.,'end':duration}]+phases:
            for direction in ['into', 'out']:
                total = len(events_between(events, phase['start'], phase['end'], direction))
                covered = len(events_between(nominal_covered, phase['start'], phase['end'], direction))
                coverage_rows.append({'camera': camera, 'seed': '', 'method': 'input_nominal', 'phase_reference': phase['name'], 'direction': direction,
                                      'reference_crossings_agents': total, 'covered_reference_crossings_agents': covered,
                                      'coverage_fraction': covered/total if total else None,
                                      'definition': 'Initial sourceID or arrival bracketEND<=reference crossing; conservative nominal schedule, not simulated success.'})
        obs_counts = []
        for r in obs_measure['counts10s']:
            row = dict(r); row['cumulative_into'] = len(events_between(events, 0, r['time'], 'into')); obs_counts.append(row)
        item['plot_counts']['observation_proxy'][0] = obs_counts
        native_rows += measure_rows(camera, 'observation_proxy', '', obs_measure, dt, first, phases, native=True)
        count_rows += measure_rows(camera, 'observation_proxy', '', obs_measure, dt, first, phases)
        for (c, seed, method), path in sorted(run_paths.items()):
            if c != camera:
                continue
            receipt_file = Path(str(path)+'.receipt.json')
            if not receipt_file.exists():
                omitted.append({'file': path.name, 'reason': 'Missing completion receipt'})
                continue
            run = load(path, hashes)
            if run.get('runType') == 'diagnostic' or run.get('paperResult') is False:
                omitted.append({'file': path.name, 'reason': 'Diagnostic run excluded from experiment tables'})
                continue
            receipt = load(receipt_file, hashes)
            if receipt.get('sha256') != hashes[str(path.resolve())]:
                raise ValueError(f'Run hash differs from completion receipt: {path}')
            pv = run.get('provenance', {})
            verify_binding(pv, 'protocolSha256', camera_protocol_path, data, hashes)
            verify_binding(pv, 'inputSha256', input_file, data, hashes)
            if run.get('gate', {}).get('passed') is False:
                summaries.append({'camera': camera, 'method': method, 'seed': seed, 'phase_reference': 'all',
                                  **run.get('summary', {}), 'numerically_valid': False,
                                  'numerical_failure': run.get('gate')})
                omitted.append({'file': str(path), 'reason': 'Numerical failure retained; excluded from valid ensemble and marked'}); continue
            if run.get('status') != 'scored' or not run.get('measurements') or not run.get('summary'):
                omitted.append({'file': str(path), 'reason': 'Not scored yet'}); continue
            if run.get('camera') != camera or run.get('method') != method or int(run.get('seed', -1)) != seed:
                raise ValueError('Run filename and metadata differ')
            run['method'], run['seed'] = method, seed
            summaries.append({'camera': camera, **run['summary'], 'phase_reference': 'all', 'numerically_valid': True})
            phase_rows += [summarize_phase(camera, run, obs_measure, events, p, dt, first, bin_coverage) for p in phases]
            native_rows += measure_rows(camera, method, seed, run['measurements'], dt, first, phases, native=True)
            count_rows += measure_rows(camera, method, seed, run['measurements'], dt, first, phases)
            directional_rows += crossing_rows(camera, method, seed, run['metrics']['crossings']['bins'], dt, first, phases)
            item['native'].setdefault(method, {})[seed] = run['measurements']['timeseries']
            simulated_counts = []
            for r in run['measurements']['counts10s']:
                row = dict(r); row['cumulative_into'] = len(events_between(run['crossingEvents'], 0, r['time'], 'into')); simulated_counts.append(row)
            item['plot_counts'].setdefault(method, {})[seed] = simulated_counts
            scheduled = covered_events(events, run['config']['initialAgents'], run['config']['arrivals'])
            admitted = covered_events(events, run['config']['initialAgents'], run['config']['arrivals'], admissions=run['admissionEvents'])
            item['coverage_by_seed'][seed] = [{'time': r['time'], 'count': len(events_between(scheduled, 0, r['time'], 'into'))} for r in obs_counts]
            for phase in [{'name':'all','start':0.,'end':duration}]+phases:
                for direction in ['into', 'out']:
                    total = len(events_between(events, phase['start'], phase['end'], direction))
                    cov = len(events_between(scheduled, phase['start'], phase['end'], direction))
                    actual = len(events_between(admitted, phase['start'], phase['end'], direction))
                    coverage_rows.append({'camera': camera, 'seed': seed, 'method': method, 'phase_reference': phase['name'], 'direction': direction,
                                          'reference_crossings_agents': total, 'covered_reference_crossings_agents': cov, 'coverage_fraction': cov/total if total else None,
                                          'actually_admitted_reference_identity_count': actual, 'definition': 'Initial sourceID or seeded scheduled time<=reference crossing; actual admission exported separately.'})
            del run
        item['paired_seeds'] = [s for s in seeds if all(s in item['native'].get(m, {}) for m in METHODS)]
        if item['paired_seeds']:
            shown = item['paired_seeds'][0]
            item['coverage_curve'] = item['coverage_by_seed'][shown]
        obs_measure.pop('fdPoints', None)
    paired = make_paired(summaries+phase_rows)
    tables = {'run_summary.csv': summaries, 'phase_summary.csv': phase_rows, 'paired_effects.csv': paired,
              'ensemble_summary.csv': ensemble_rows(summaries+phase_rows),
              'native_timeseries.csv': native_rows, 'timeseries_10s.csv': count_rows, 'demand_coverage.csv': coverage_rows,
              'crossings_10s.csv': directional_rows,
              'total_visible_roi_timeseries.csv': summed_rows(items)[0]}
    return tables, {'paired_seeds': {c: item['paired_seeds'] for c, item in items.items()}, 'omitted_or_failed': omitted, 'phases': {c: item['phases'] for c, item in items.items()}}


def bottleneck_run_summary(run):
    """Use saved 1 s occupancy samples and the existing 5 s exit bins."""
    series = run['timeseries']
    diagnostics = run['diagnostics']
    return {
        'arrival_rate_agents_per_model_s': run['arrivalRate'],
        'method': run['method'],
        'seed': run['seed'],
        'numerically_valid': bool(run['implementationGatePassed']),
        'censored': bool(run['censored']),
        'completion_time_model_s': run['drainTimeSeconds'],
        'peak_gate_front_count_people': max(r['gate_front_count'] for r in series),
        'peak_mouth_front_count_people': max(r['mouth_front_count'] for r in series),
        'peak_5s_exit_flux_people_per_model_s': max(
            r['exit_throughput_agents_per_s'] for r in run['throughputDensity']),
        'horizon_mean_exit_flux_people_per_model_s': diagnostics['exited'] / run['config']['maxTime'],
        'final_exit_count_people': diagnostics['exited'],
        'feedback_applied_fraction': diagnostics['feedbackAppliedFraction'],
        'maximum_overlap_W0': diagnostics['maxOverlapObserved'],
    }


def evaluate_bottleneck(runs, hashes):
    summaries, timeseries, throughput, omitted = [], [], [], []
    identities = {}
    for path in sorted((runs / 'runs').glob('s1_rate_*__feedback_*__seed*.json')):
        match = re.fullmatch(r's1_rate_([0-9.]+)__(feedback_off|feedback_on)__seed(\d+)\.json', path.name)
        if not match:
            continue
        receipt_path = Path(str(path) + '.receipt.json')
        if not receipt_path.exists():
            omitted.append({'file': path.name, 'reason': 'Missing completion receipt'})
            continue
        run = load(path, hashes)
        rate, method, seed = match.groups()
        if float(run['arrivalRate']) != float(rate) or run['method'] != method or int(run['seed']) != int(seed):
            raise ValueError(f'Run filename and metadata differ: {path}')
        if run.get('runType') == 'diagnostic' or run.get('paperResult') is False:
            omitted.append({'file': path.name, 'reason': 'Diagnostic run'})
            continue
        receipt = load(receipt_path, hashes)
        if receipt.get('sha256') != hashes[str(path.resolve())]:
            raise ValueError(f'Run hash differs from completion receipt: {path}')
        row = bottleneck_run_summary(run)
        identity = (run['arrivalRate'], run['seed'], run['method'])
        if identity in identities:
            raise ValueError(f'Duplicate bottleneck run: {identity}')
        identities[identity] = (row, run['requestedDemand'], run['config']['pressureGridOrigin'])
        summaries.append(row)
        tags = {'arrival_rate_agents_per_model_s': run['arrivalRate'],
                'method': run['method'], 'seed': run['seed']}
        timeseries.extend({**tags, **r} for r in run['timeseries'])
        throughput.extend({**tags, **r} for r in run['throughputDensity'])
    if not summaries:
        raise ValueError('No complete bottleneck runs found in RUNS/runs')
    groups = defaultdict(list)
    for row in summaries:
        if row['numerically_valid']:
            groups[row['arrival_rate_agents_per_model_s'], row['method']].append(row)
        else:
            omitted.append({'arrival_rate': row['arrival_rate_agents_per_model_s'],
                            'method': row['method'], 'seed': row['seed'],
                            'reason': 'Numerical failure retained in run_summary'})
    metrics = [key for key in summaries[0]
               if key not in {'arrival_rate_agents_per_model_s', 'method', 'seed',
                              'numerically_valid', 'censored'}]
    ensemble = []
    for (rate, method), rows in sorted(groups.items()):
        for metric in metrics:
            values = [r[metric] for r in rows if r[metric] is not None]
            if values:
                ensemble.append({'arrival_rate_agents_per_model_s': rate, 'method': method,
                                 'metric': metric, 'run_count': len(values),
                                 'mean': float(np.mean(values)),
                                 'sample_sd': float(np.std(values, ddof=1)) if len(values) > 1 else None,
                                 'minimum': min(values), 'maximum': max(values)})
    differences = defaultdict(list)
    for (rate, seed, method), (off, demand, origin) in sorted(identities.items()):
        other = identities.get((rate, seed, 'feedback_on'))
        if method != 'feedback_off' or other is None:
            continue
        on, on_demand, on_origin = other
        if demand != on_demand or origin != on_origin:
            raise ValueError(f'Paired bottleneck inputs differ at rate {rate}, seed {seed}')
        if not (off['numerically_valid'] and on['numerically_valid']):
            continue
        for metric in metrics:
            if off[metric] is not None and on[metric] is not None:
                differences[rate, metric].append((seed, on[metric] - off[metric]))
    paired = [{'arrival_rate_agents_per_model_s': rate, 'metric': metric,
               **paired_interval([value for _, value in values]),
               'seeds': [seed for seed, _ in values]}
              for (rate, metric), values in sorted(differences.items())]
    return {'run_summary.csv': summaries, 'ensemble_summary.csv': ensemble,
            'paired_effects.csv': paired, 'timeseries.csv': timeseries,
            'throughput_density.csv': throughput}, {'omitted_or_failed': omitted}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runs', type=Path, required=True, help='Directory containing runs/')
    parser.add_argument('--data', type=Path, help='Prepared Stadium data directory')
    parser.add_argument('--output', type=Path, required=True, help='New evaluation directory')
    parser.add_argument('--experiment', choices=['stadium', 'bottleneck'], default='stadium')
    args = parser.parse_args(argv)
    runs = args.runs.resolve()
    data = args.data.resolve() if args.data else None
    output = args.output.resolve()
    if output.exists():
        parser.error(f'Output already exists; choose a new directory: {output}')
    hashes = {}
    if args.experiment == 'stadium':
        tables, details = evaluate_stadium(runs, data, hashes)
        phase_series = None
        paired_seeds = details['paired_seeds']
        if sorted(paired_seeds) == list('ABCDEF') and all(len(seeds) == 10 for seeds in paired_seeds.values()):
            import pandas as pd
            from phase_timing import PROTOCOL, compute_metrics
            timing, phase_series = compute_metrics(pd.DataFrame(tables['total_visible_roi_timeseries.csv']))
            tables['phase_timing_metrics.csv'] = timing
            details['phase_timing'] = 'Six-ROI total, ten seed means; published definitions.'
        else:
            details['phase_timing'] = 'Not computed: published timing requires all six ROIs and ten paired seeds. Use phase_timing.py with an explicit smaller seed count for a separate analysis.'
    else:
        tables, details = evaluate_bottleneck(runs, hashes)
    (output / 'figure_data').mkdir(parents=True, exist_ok=False)
    for name, rows in tables.items():
        write_csv(output / 'figure_data' / name, rows)
    if args.experiment == 'stadium' and phase_series is not None:
        phase_series.to_csv(output / 'figure_data' / 'total_roi_metric_series.csv')
        (output / 'metrics_protocol.txt').write_text(PROTOCOL, encoding='utf-8')
    source_hashes = {}
    for name, value in hashes.items():
        path = Path(name)
        if path.is_relative_to(runs):
            name = 'runs/' + path.relative_to(runs).as_posix()
        elif data and path.is_relative_to(data):
            name = 'data/' + path.relative_to(data).as_posix()
        source_hashes[name] = value
    manifest = {
        'experiment': args.experiment,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'source_sha256': source_hashes,
        'code_sha256': {'evaluate.py': digest(__file__),
                        'src/evaluation.py': digest(Path(__file__).parent / 'src/evaluation.py'),
                        'phase_timing.py': digest(Path(__file__).parent / 'phase_timing.py')},
        'output_sha256': {p.relative_to(output).as_posix(): digest(p)
                          for p in sorted(output.rglob('*')) if p.is_file()},
        **details,
        'definitions': {
            'reference': 'Automatic detection and tracking; missing samples remain missing.',
            'time': 'Stadium: source-video seconds except dataset_time_tV columns. S1: model seconds.',
            'units': 'W is each tunnel mouth width; W0 is the synthetic reference length.',
            'legacy_columns': 'Stadium CSV columns ending _agents count people in the ROI or crossing events.',
            'counts': 'Occupancy RMSE uses matched 10 s samples. Egress flow uses complete 10 s bins.',
            'coverage': 'Nominal coverage requires initial presence or arrival bracket end before crossing; seeded schedule and actual admission are separate.',
            'interval': 'Unadjusted two-sided Student t 95% interval of paired ON minus OFF differences; n=1 has no interval.',
            'sum': 'Fixed available-tunnel subset at common dataset times; any missing member makes the total missing.',
            's1_peaks': 'Occupancy maxima over saved 1 s samples; exit flux maximum over saved 5 s bins.',
            's1_horizon_mean_flux': 'Final exit count divided by config.maxTime, including closed-gate and post-drain exposure; not a mean over the drain interval.',
        },
    }
    (output / 'manifest.json').write_text(json.dumps(clean(manifest), indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(output), 'tables': list(tables), **details}, indent=2))


if __name__ == '__main__':
    main()
