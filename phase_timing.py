"""Reproduce phase timing and correlation from a saved total-occupancy CSV."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

from src.evaluation import clean, digest


PROTOCOL = """Timing is measured on the integer dataset-time grid tV, retaining gaps.
The reference and both complete seed means must be present at an instant.
Reference counts first receive a centered 15-sample mean (min_periods=1).
All three curves then receive a centered 60-sample mean (min_periods=1).
Restore the common-valid mask after each smoothing pass.
Baseline: median smoothed count at tV 0..399. Peak: first global maximum.
Onset/half-rise/full-rise: first valid pre-peak crossing of 10/50/90 percent
of the baseline-to-peak increase. Half-decline/end: first valid post-peak
return to 50/10 percent. Return missing if no crossing was recorded.
Pearson correlation uses raw reference and raw complete-seed simulation means
at the same common-valid instants, without smoothing or temporal alignment.
The published analysis uses six ROIs and exactly ten seeds per condition.
"""


def crossings(raw, valid, reference=False):
    values = raw.copy()
    if reference:
        values = values.rolling(15, center=True, min_periods=1).mean().where(valid)
    smoothed = values.rolling(60, center=True, min_periods=1).mean().where(valid).to_numpy()
    if not np.isfinite(smoothed).any() or not np.isfinite(smoothed[:400]).any():
        raise ValueError('Timing requires valid baseline samples and a recorded peak')
    peak = int(np.nanargmax(smoothed))
    baseline = float(np.nanmedian(smoothed[:400]))
    height = float(smoothed[peak])
    result = {}
    for name, fraction, rising in [('onset_10', .1, True), ('half_up', .5, True),
                                  ('full_90', .9, True), ('half_down', .5, False),
                                  ('end_10', .1, False)]:
        level = baseline + fraction * (height - baseline)
        if rising:
            candidates = np.where(smoothed[:peak] >= level)[0]
        else:
            candidates = np.where(smoothed[peak:] <= level)[0] + peak
        result[name + '_tV_s'] = int(candidates[0]) if len(candidates) else None
    result.update(peak_tV_s=peak, baseline_count_agents=baseline,
                  peak_smoothed_count_agents=height)
    return result, smoothed


def compute_metrics(table, expected_seeds=10):
    if table.empty:
        raise ValueError('No total-occupancy records')
    times = table.dataset_time_tV.to_numpy(dtype=float)
    if not np.all(np.isfinite(times)) or not np.allclose(times, np.round(times)) or times.min() != 0:
        raise ValueError('Timing requires a dataset-time grid beginning at zero with integer samples')
    grid = pd.RangeIndex(0, int(times.max()) + 1)
    reference = table[table.method.eq('observation_proxy')].set_index('dataset_time_tV').sum_visible_roi_count_agents.reindex(grid)
    curves = {'observation_proxy': reference}
    for method in ['feedback_off', 'feedback_on']:
        matrix = table[table.method.eq(method)].pivot(index='dataset_time_tV', columns='seed', values='sum_visible_roi_count_agents').reindex(grid)
        if matrix.shape[1] != expected_seeds:
            raise ValueError(f'{method}: expected {expected_seeds} seeds, found {matrix.shape[1]}')
        curves[method] = matrix.mean(axis=1).where(matrix.notna().sum(axis=1).eq(expected_seeds))
    frame = pd.DataFrame(curves)
    valid = frame.notna().all(axis=1)
    frame = frame.where(valid, axis=0)
    export = frame.rename_axis('dataset_time_tV').copy()
    export['common_valid'] = valid
    rows = []
    for method in curves:
        result, smoothed = crossings(frame[method], valid, method == 'observation_proxy')
        result.update(method=method, n_paired_instants=int(valid.sum()),
                      n_excluded_instants=int((~valid).sum()),
                      pearson_r_raw_reference=1.0 if method == 'observation_proxy' else float(frame.observation_proxy.corr(frame[method])))
        rows.append(result)
        export[method + '_metric_smoothed'] = smoothed
    return rows, export


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='total_visible_roi_timeseries.csv')
    parser.add_argument('--output', type=Path, required=True, help='New output directory')
    parser.add_argument('--expected-seeds', type=int, default=10,
                        help='Explicit seed count; published study uses 10')
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error('Output exists; choose a new directory')
    if args.expected_seeds < 1:
        parser.error('--expected-seeds must be positive')
    rows, series = compute_metrics(pd.read_csv(args.input), args.expected_seeds)
    args.output.mkdir(parents=True, exist_ok=False)
    pd.DataFrame(rows).to_csv(args.output / 'phase_timing_metrics.csv', index=False)
    series.to_csv(args.output / 'total_roi_metric_series.csv')
    (args.output / 'metrics_protocol.txt').write_text(PROTOCOL, encoding='utf-8')
    manifest = {'input_sha256': digest(args.input), 'script_sha256': digest(__file__),
                'expected_seeds': args.expected_seeds, 'results': rows,
                'output_sha256': {p.name: digest(p) for p in args.output.iterdir() if p.is_file()}}
    (args.output / 'manifest.json').write_text(json.dumps(clean(manifest), indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(pd.DataFrame(rows).to_string(index=False))


if __name__ == '__main__':
    main()
