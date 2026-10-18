"""Prepare stadium inputs from the original tracker CSV and saved geometry."""
from __future__ import annotations

import argparse
from copy import deepcopy
import csv
import json
from pathlib import Path
import subprocess

from run import ROOT, digest, find_node, write_new
from src.inputs import tracking, lanes
from src.inputs.history import extra_tables


def build_camera(camera, raw, geometry, protocol, source_hash):
    first, last = min(raw), max(raw)
    dt = protocol["sampleIntervalSecondsByCamera"][camera]
    if dt != tracking.camera_dt(camera):
        raise ValueError("Sample interval differs from the frozen camera clock")
    nominal, duration = (first - 1) * dt, (last - first) * dt
    if camera == "D":
        document, reference = tracking.prepare_window(camera, nominal, duration, raw, geometry)
        document["geometryLaneGuard"] = deepcopy(geometry["laneGuard"])
    else:
        document, reference = lanes.prepare_window(camera, nominal, duration, raw, geometry, geometry["laneGuard"])
    rolling, snapshots, candidates = extra_tables(tracking, document, raw, geometry, first, last, dt)
    version = "continuous_D_v1" if camera == "D" else "continuous_v1"
    common = {"version": version, "windowId": f"{camera}_continuous", "firstSourceSample": first,
              "lastSourceSample": last, "actualStartSeconds": nominal, "actualEndSeconds": (last - 1) * dt,
              "sources": {"trackerSha256": source_hash, "geometry": f"{camera}.json"}}
    document.update(common, rollingSpeedObservations=rolling, demandCandidateAudit=candidates)
    document["calibration"].update(
        snapshots=snapshots, intervalSeconds=60,
        pressureCalibrationAvailable=any(s["agents"] for s in snapshots),
        pressureCalibrationMode="retrospective_first_60_seconds",
        pressureCalibrationActualElapsedIntervalSeconds=[0, 60], snapshotStrideNativeSamples=5,
        compatibilityTimeShiftSeconds=-60, empiricalSpeedPool=[.03], empiricalSpeedPoolRecords=[],
        empiricalSpeedPoolFallback=True, rollingSpeedObservationCount=len(rolling))
    document["quality"].update(
        rawFirstSample=first, rawLastSample=last, rawNativeFrameCount=len(raw),
        rawTrackerRowCount=sum(map(len, raw.values())), expectedNativeSampleCount=last-first+1,
        missingNativeSamples=[sample for sample in range(first, last+1) if sample not in raw],
        rawUniqueSourceIds=len({pid for frame in raw.values() for pid in frame}),
        finalSampleCandidates=[row for row in candidates if row["sourceSample"] == last],
        calibrationUsesFutureFirstMinute=True)
    reference.update(common)
    for frame in reference["frames"]:
        available = frame["sourceSample"] in raw
        frame.update(isObserved=available, observationMissing=not available)
        if not available:
            assert frame["agents"] == []
            frame["agents"] = None
    for row in document["observation"]["occupancy"]:
        available = row["sourceSample"] in raw
        row.update(isObserved=available, observationMissing=not available)
        if not available:
            row.update(count=None, meanSpeed=None, density=None, speedSampleCount=0)
    for rows in [document["observation"]["counts10s"], reference["counts10s"]]:
        for row in rows:
            available = row["sourceSample"] in raw
            row.update(isObserved=available, observationMissing=not available)
            if not available:
                row["count"] = None
    for row in document["observation"]["trackContinuity"]:
        sample = first + round(row["time"] / dt)
        row["observationMissing"] = sample not in raw or sample - 1 not in raw
        row["validContinuityMeasurement"] = not row["observationMissing"]
    reference["missingFramePolicy"] = "Missing tracker frames have agents:null. Displacements and crossings never bridge a missing frame."
    return document, reference


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tracks", required=True, type=Path, help="Original 1 Hz tracking CSV (read only)")
    parser.add_argument("--output", required=True, type=Path, help="New prepared-data directory")
    parser.add_argument("--tunnels", nargs="+", choices=list("ABCDEF"), default=list("ABCDEF"))
    parser.add_argument("--geometry", type=Path, default=ROOT / "data/geometry/preparation")
    parser.add_argument("--protocols", type=Path, default=ROOT / "data/stadium/protocols")
    parser.add_argument("--node")
    args = parser.parse_args()
    node, _ = find_node(args.node)
    if args.output.exists():
        parser.error("Output exists; choose a new directory.")
    source_hash = digest(args.tracks)
    raw = {camera: {} for camera in args.tunnels}
    with args.tracks.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"cam_name", "frame_number", "person_id", "img_x", "img_y"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError("Expected cam_name, frame_number, person_id, img_x and img_y columns")
        for row in reader:
            camera = row["cam_name"].removeprefix("Tunnel ")
            if camera not in raw:
                continue
            sample, identity = int(row["frame_number"]), int(row["person_id"])
            frame = raw[camera].setdefault(sample, {})
            if identity in frame:
                raise ValueError(f"Duplicate identity at {camera}/{sample}/{identity}")
            frame[identity] = row
    if any(not values for values in raw.values()):
        raise ValueError("One requested tunnel has no samples in the CSV")
    for folder in ["inputs", "observations", "protocols"]:
        (args.output / folder).mkdir(parents=True, exist_ok=False)
    summary = []
    for camera in args.tunnels:
        geometry = json.loads((args.geometry / f"{camera}.json").read_text(encoding="utf-8"))
        protocol = json.loads((args.protocols / f"{camera}.json").read_text(encoding="utf-8"))
        document, reference = build_camera(camera, raw[camera], geometry, protocol, source_hash)
        write_new(args.output / "inputs" / f"{camera}.json", document)
        write_new(args.output / "observations" / f"{camera}.json", reference)
        write_new(args.output / "protocols" / f"{camera}.json", protocol)
        subprocess.run([node, str(ROOT / "src/finalize_inputs.cjs"), str(args.output.resolve()), camera], check=True)
        row = {"camera": camera, "initial": len(document["initialAgents"]), "arrivals": len(document["arrivals"]),
               "duration_source_s": document["durationSeconds"], "missing_samples": len(document["quality"]["missingNativeSamples"])}
        summary.append(row)
        print(json.dumps(row), flush=True)
    if digest(args.tracks) != source_hash:
        raise RuntimeError("Tracker source changed during preparation")
    write_new(args.output / "preparation.json", {"tracker_sha256": source_hash, "tunnels": summary,
                                                "geometry_hashes": {c: digest(args.geometry / f"{c}.json") for c in args.tunnels}})


if __name__ == "__main__":
    main()
