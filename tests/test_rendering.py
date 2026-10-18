"""Rendering a single condition should not require a paired-effects table."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from render import bottleneck_figures
from src.evaluation import write_csv


class RenderingTests(unittest.TestCase):
    def test_single_condition_has_a_figure_without_paired_statistics(self):
        metrics = ['completion_time_model_s', 'peak_gate_front_count_people',
                   'peak_5s_exit_flux_people_per_model_s']
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            rows = [{'method': 'feedback_off', 'metric': metric,
                     'arrival_rate_agents_per_model_s': 6, 'mean': 10,
                     'sample_sd': 0} for metric in metrics]
            write_csv(folder / 'ensemble_summary.csv', rows)
            bottleneck_figures(folder, folder, plt)
            self.assertTrue((folder / 'bottleneck_metrics.pdf').is_file())
            self.assertTrue((folder / 'bottleneck_metrics.png').is_file())


if __name__ == '__main__':
    unittest.main()
