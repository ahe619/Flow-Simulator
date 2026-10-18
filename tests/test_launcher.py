"""Launcher regressions: job identity, diagnostic names and safe reuse."""
from argparse import Namespace
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import run


def arguments(**updates):
    values = dict(experiment="stadium", full=False, seeds=[1], methods=["off", "on"],
                  tunnels=["E"], inflows=[6], duration=None)
    values.update(updates)
    return Namespace(**values)


class LauncherTests(unittest.TestCase):
    def test_full_study_has_unique_declared_pairs(self):
        stadium = run.job_list(arguments(full=True))
        bottleneck = run.job_list(arguments(experiment="bottleneck", full=True))
        self.assertEqual((len(stadium), len({job["id"] for job in stadium})), (120, 120))
        self.assertEqual((len(bottleneck), len({job["id"] for job in bottleneck})), (80, 80))

    def test_repeated_cli_values_do_not_schedule_duplicate_files(self):
        jobs = run.job_list(arguments(tunnels=["E", "E"], methods=["off", "off"], seeds=[1, 1]))
        self.assertEqual(len(jobs), 1)

    def test_fractional_duration_keeps_worker_filename_precision(self):
        jobs = run.job_list(arguments(duration=14.123456789))
        self.assertTrue(all(job["id"].startswith("diagnostic__14.123456789__") for job in jobs))

    def test_valid_receipt_cannot_substitute_another_seed(self):
        with tempfile.TemporaryDirectory(prefix="stadium-launcher-test-") as directory:
            output = Path(directory)
            (output / "runs").mkdir()
            job = run.job_list(arguments(methods=["off"]))[0]
            result = {"camera": "E", "seed": 2, "method": "feedback_off",
                      "status": "scored", "gate": {"passed": True}}
            filename = output / "runs" / f"{job['id']}.json"
            payload = json.dumps(result).encode("utf-8")
            filename.write_bytes(payload)
            Path(str(filename) + ".receipt.json").write_text(json.dumps({
                "status": "scored", "sha256": hashlib.sha256(payload).hexdigest()
            }), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                run.valid_result(output, job)

    def test_checksum_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory(prefix="stadium-launcher-test-") as directory:
            output = Path(directory)
            (output / "runs").mkdir()
            job = run.job_list(arguments(methods=["off"]))[0]
            filename = output / "runs" / f"{job['id']}.json"
            filename.write_text('{"gate":{"passed":true}}', encoding="utf-8")
            Path(str(filename) + ".receipt.json").write_text(
                '{"status":"scored","sha256":"wrong"}', encoding="utf-8")
            with self.assertRaises(RuntimeError):
                run.valid_result(output, job)

    def test_memory_budget_cannot_force_one_oversized_worker(self):
        import psutil
        with patch.object(psutil, "virtual_memory", return_value=Namespace(available=100)):
            with self.assertRaises(RuntimeError):
                run.worker_limit(4, 100)


if __name__ == "__main__":
    unittest.main()
