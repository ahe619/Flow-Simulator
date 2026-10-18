"""Checks for missing-data handling, paired statistics and observation coverage."""
import importlib.util
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from src.evaluation import (covered_events, make_paired, paired_interval,
                            phase_ranges, rmse, summed_rows)
from phase_timing import compute_metrics
import pandas as pd

spec = importlib.util.spec_from_file_location('evaluate_cli', ROOT / 'evaluate.py')
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)


class EvaluationTests(unittest.TestCase):
    def test_rmse_uses_only_matched_finite_samples(self):
        value, count = rmse([1, 99, math.nan, 7], [3, math.nan, 8, 3])
        self.assertEqual(count, 2)
        self.assertAlmostEqual(value, math.sqrt(10))

    def test_empty_reference_has_no_score(self):
        self.assertEqual(rmse([1], [math.nan]), (None, 0))

    def test_single_pair_has_no_confidence_interval(self):
        row = paired_interval([2])
        self.assertEqual(row['paired_n'], 1)
        self.assertEqual(row['mean_on_minus_off'], 2)
        self.assertIsNone(row['ci95_lower'])
        self.assertIsNone(row['sample_sd'])

    def test_t_interval_uses_sample_sd_and_pair_count(self):
        row = paired_interval([0, 2])
        self.assertAlmostEqual(row['sample_sd'], math.sqrt(2))
        self.assertAlmostEqual(row['ci95_lower'], 1 - 12.7062047364)

    def test_coverage_requires_identity_before_crossing(self):
        events = [{'sourceId': 1, 'time': 1}, {'sourceId': 2, 'time': 4},
                  {'sourceId': 2, 'time': 5}, {'sourceId': 3, 'time': 9}]
        arrivals = [{'id': 'two', 'sourceId': 2, 'time': 4, 'timeBracket': [3, 5]}]
        nominal = covered_events(events, [{'id': 'one', 'sourceId': 1}], arrivals, conservative=True)
        seeded = covered_events(events, [{'id': 'one', 'sourceId': 1}], arrivals)
        self.assertEqual([e['time'] for e in nominal], [1, 5])
        self.assertEqual([e['time'] for e in seeded], [1, 4, 5])

    def test_interval_supports_more_than_ten_pairs(self):
        row = paired_interval(list(range(11)))
        self.assertEqual(row['paired_n'], 11)
        self.assertAlmostEqual(row['ci95_lower'], 5 - 2.2281388519649385)
        self.assertAlmostEqual(row['ci95_upper'], 5 + 2.2281388519649385)

    def test_actual_admission_is_separate_from_scheduled_coverage(self):
        events = [{'sourceId': 1, 'time': 4}, {'sourceId': 1, 'time': 7}]
        arrivals = [{'id': 'one', 'sourceId': 1, 'time': 2}]
        admissions = [{'id': 'one', 'sourceId': 1, 'time': 6}]
        admitted = covered_events(events, [], arrivals, admissions=admissions)
        self.assertEqual([e['time'] for e in admitted], [7])

    def test_phase_times_use_camera_sample_interval(self):
        protocol = {'phasesVivian': [{'name': 'pre-event', 'start': 0, 'end': 600},
                                    {'name': 'a', 'start': 600, 'end': None}]}
        phases = phase_ranges(protocol, .5, 3, 500)
        self.assertEqual(phases[0]['end'], 300)
        self.assertEqual(phases[1]['start_tV'], 600)
        self.assertEqual(phases[1]['end_tV'], 1000)

    def test_invalid_and_unpaired_runs_do_not_enter_paired_intervals(self):
        rows = [{'camera': 'E', 'method': 'feedback_off', 'seed': 1, 'whole_roi_rmse_agents': 7},
                {'camera': 'E', 'method': 'feedback_on', 'seed': 1, 'whole_roi_rmse_agents': 6},
                {'camera': 'E', 'method': 'feedback_off', 'seed': 2, 'whole_roi_rmse_agents': 20},
                {'camera': 'E', 'method': 'feedback_on', 'seed': 2, 'whole_roi_rmse_agents': 1, 'numerically_valid': False},
                {'camera': 'E', 'method': 'feedback_on', 'seed': 3, 'whole_roi_rmse_agents': 1}]
        result = make_paired(rows)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['paired_n'], 1)
        self.assertEqual(result[0]['mean_on_minus_off'], -1)

    def test_total_is_missing_if_any_selected_tunnel_is_missing(self):
        def item(values):
            rows = [{'time': i, 'whole_roi_count': value} for i, value in enumerate(values)]
            return {'clock': (1, 3, 1), 'paired_seeds': [1],
                    'native': {'observation_proxy': {0: rows}, 'feedback_off': {1: rows}, 'feedback_on': {1: rows}}}
        rows, cameras = summed_rows({'A': item([2, 3]), 'E': item([5, None])})
        self.assertEqual(cameras, ['A', 'E'])
        reference = [r for r in rows if r['method'] == 'observation_proxy']
        self.assertEqual(reference[0]['sum_visible_roi_count_agents'], 7)
        self.assertIsNone(reference[1]['sum_visible_roi_count_agents'])
        self.assertEqual(reference[1]['missing_cameras'], 'E')

    def test_bottleneck_peak_flux_does_not_sum_duplicated_regions(self):
        run = {'arrivalRate': 6, 'method': 'feedback_off', 'seed': 1,
               'implementationGatePassed': True, 'censored': False, 'drainTimeSeconds': 40,
               'config': {'maxTime': 150},
               'timeseries': [{'gate_front_count': 3, 'mouth_front_count': 5},
                              {'gate_front_count': 4, 'mouth_front_count': 2}],
               'throughputDensity': [{'exit_throughput_agents_per_s': 2}, {'exit_throughput_agents_per_s': 2}],
               'diagnostics': {'exited': 144, 'feedbackAppliedFraction': 0, 'maxOverlapObserved': .0001}}
        row = evaluate.bottleneck_run_summary(run)
        self.assertEqual(row['peak_5s_exit_flux_people_per_model_s'], 2)
        self.assertEqual(row['peak_gate_front_count_people'], 4)
        self.assertEqual(row['peak_mouth_front_count_people'], 5)
        self.assertEqual(row['horizon_mean_exit_flux_people_per_model_s'], .96)

    def test_data_manifest_rejects_changed_observations(self):
        import json
        from src.evaluation import load
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'observations' / 'E.json'
            source.parent.mkdir()
            source.write_text('{"frames": []}', encoding='utf-8')
            (root / 'manifest.json').write_text(json.dumps({'files': [
                {'file': 'data/stadium/observations/E.json', 'sha256': 'incorrect'}]}), encoding='utf-8')
            hashes = {}
            load(source, hashes)
            with self.assertRaisesRegex(ValueError, 'differs from its data manifest'):
                evaluate.data_file_hashes(source, root, hashes)

    def test_timing_does_not_fill_missing_seed_samples(self):
        rows = []
        for time in range(1000):
            value = 10 + max(0, time - 500) / 10
            rows.append({'dataset_time_tV': time, 'method': 'observation_proxy',
                         'seed': None, 'sum_visible_roi_count_agents': value})
            for method in ['feedback_off', 'feedback_on']:
                rows.append({'dataset_time_tV': time, 'method': method, 'seed': 1,
                             'sum_visible_roi_count_agents': None if time == 600 else value})
        metrics, series = compute_metrics(pd.DataFrame(rows), expected_seeds=1)
        self.assertFalse(series.loc[600, 'common_valid'])
        self.assertTrue(pd.isna(series.loc[600, 'feedback_on_metric_smoothed']))
        self.assertEqual(metrics[0]['n_paired_instants'], 999)
        with self.assertRaisesRegex(ValueError, 'expected 10 seeds'):
            compute_metrics(pd.DataFrame(rows))


if __name__ == '__main__':
    unittest.main()
