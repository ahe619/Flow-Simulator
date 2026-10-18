"""Track-to-input tests for clocks, missing samples and arrival confirmation."""
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from prepare import build_camera
from src.inputs import tracking


def geometry():
    floor = [[-1, 0], [-.5, 0], [-.5, -.8], [.5, -.8], [.5, 0], [1, 0], [1, 1], [-1, 1]]
    image_floor = [[100 + 100*x, 100 + 100*y] for x, y in floor]
    scene = {
        "domainPolygon": floor, "floorPolygon": floor, "occupancyPolygon": floor,
        "domainImage": image_floor, "domainArea": 2.8,
        "mouth": {"p0": [-.5, 0], "p1": [.5, 0], "inboundSign": -1},
        "deepCut": {"p0": [-.5, -.8], "p1": [.5, -.8]},
        "tunnelPolygon": [[-.5, 0], [-.5, -.8], [.5, -.8], [.5, 0]],
        "walls": [{"p0": [-.5, 0], "p1": [-.5, -.8]}, {"p0": [.5, 0], "p1": [.5, -.8]}],
        "routes": {
            "inbound": {"waypoints": [[0, .18], [0, -.18], [0, -1]], "exitOnGoal": True},
            "outbound": {"waypoints": [[0, .25], [0, 1.2]], "exitOnGoal": True},
            "left": {"waypoints": [[-1.2, .5]], "exitOnGoal": True},
            "right": {"waypoints": [[1.2, .5]], "exitOnGoal": True}
        }
    }
    return {"HimageToU": [[.01, 0, -1], [0, .01, -1], [0, 0, 1]],
            "supportPolygonImage": [[0, 0], [300, 0], [300, 300], [0, 300]],
            "scene": scene, "laneGuard": {"intervalW": [-.25, .25]}}


def row(x, y):
    # The saved tracker convention projects img_y - 8 pixels.
    return {"img_x": str(100 + 100*x), "img_y": str(108 + 100*y)}


def prepare(camera, raw):
    dt = 1.0 if camera == "A" else 29/29.97
    protocol = {"sampleIntervalSecondsByCamera": {camera: dt}}
    return build_camera(camera, raw, geometry(), protocol, "fixture")


class PreparationTests(unittest.TestCase):
    def test_camera_clocks_use_source_seconds(self):
        raw = {sample: {1: row(0, .6)} for sample in range(3, 8)}
        for camera, dt in [("A", 1.0), ("B", 29/29.97), ("D", 29/29.97)]:
            document, reference = prepare(camera, raw)
            self.assertEqual(document["startSample"], 3)
            self.assertAlmostEqual(document["durationSeconds"], 4*dt)
            self.assertAlmostEqual(document["actualStartSeconds"], 2*dt)
            self.assertAlmostEqual(reference["frames"][-1]["time"], 4*dt)

    def test_missing_native_frame_is_unknown_and_does_not_bridge_a_crossing(self):
        raw = {3: {1: row(0, .2)}, 4: {1: row(0, .1)},
               6: {1: row(0, -.1)}, 7: {1: row(0, -.2)}}
        document, reference = prepare("A", raw)
        missing = next(frame for frame in reference["frames"] if frame["sourceSample"] == 5)
        self.assertIsNone(missing["agents"])
        count = next(point for point in document["observation"]["occupancy"] if point["sourceSample"] == 5)
        self.assertIsNone(count["count"])
        self.assertEqual(reference["referenceCrossings"], [])
        self.assertFalse(any(point["sourceSample"] == 6 for point in document["rollingSpeedObservations"]))
        self.assertEqual(document["arrivals"], [])

    def test_reentry_of_one_identity_does_not_duplicate_demand(self):
        raw = {3: {1: row(1.1, .5)}, 4: {1: row(.9, .5)}, 5: {1: row(.8, .5)},
               6: {1: row(1.1, .5)}, 7: {1: row(.9, .5)}, 8: {1: row(.8, .5)}}
        document, _ = prepare("A", raw)
        self.assertEqual(len(document["arrivals"]), 1)
        self.assertEqual(document["arrivals"][0]["timeBracket"], [0, 1])
        self.assertEqual(document["quality"]["rejectedCounts"]["source_identity_already_accepted"], 1)

    def test_last_frame_entry_without_confirmation_is_not_admitted(self):
        raw = {3: {1: row(1.2, .5)}, 4: {1: row(1.1, .5)}, 5: {1: row(.9, .5)}}
        document, _ = prepare("A", raw)
        self.assertEqual(document["arrivals"], [])
        self.assertEqual(document["quality"]["rejectedCounts"]["two_inside_samples_not_confirmed"], 1)

    def test_arrival_speed_uses_history_ending_before_the_arrival_bracket(self):
        raw = {3: {1: row(1.3, .5)}, 4: {1: row(1.1, .5)},
               5: {1: row(.9, .5)}, 6: {1: row(.2, .5)}}
        document, _ = prepare("B", raw)
        arrival = document["arrivals"][0]
        self.assertEqual(arrival["historyEndSample"], 4)
        self.assertEqual(arrival["confirmationSample"], 6)
        self.assertAlmostEqual(arrival["speed"], .2/(29/29.97))
        self.assertLessEqual(arrival["historyEndTime"], arrival["timeBracket"][0])


if __name__ == "__main__":
    unittest.main()
