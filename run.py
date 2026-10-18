"""Run the stadium or bottleneck experiments with independent Node workers."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import threading

ROOT = Path(__file__).resolve().parent
METHODS = {"off": "feedback_off", "on": "feedback_on"}


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_new(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def find_node(explicit=None):
    candidate = explicit or os.environ.get("NODE_BINARY") or shutil.which("node")
    if not candidate:
        raise RuntimeError("Node.js was not found. Put Node on PATH or pass --node /path/to/node.")
    candidate = str(Path(candidate).resolve()) if Path(candidate).is_file() else shutil.which(str(candidate))
    if not candidate:
        raise RuntimeError("The requested Node executable could not be resolved.")
    result = subprocess.run([str(candidate), "--version"], capture_output=True, text=True, check=True)
    major = int(result.stdout.strip().lstrip("v").split(".")[0])
    if major < 20:
        raise RuntimeError("Node.js 20 or newer is required; the reference runs use Node 24.")
    return str(candidate), result.stdout.strip()


@contextmanager
def output_lock(directory):
    """An OS lock is released even if the launcher exits unexpectedly."""
    lock = (directory / ".run.lock").open("a+b")
    lock.seek(0, os.SEEK_END)
    if lock.tell() == 0:
        lock.write(b"0")
        lock.flush()
    lock.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        lock.close()
        raise RuntimeError(f"Another launcher is using {directory}") from exc
    try:
        yield
    finally:
        lock.seek(0)
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def job_list(args):
    seeds = list(range(1, 11)) if args.full else sorted(set(args.seeds))
    methods = ["off", "on"] if args.full else list(dict.fromkeys(args.methods))
    if any(s not in range(1, 11) for s in seeds):
        raise ValueError("The frozen study uses seeds 1 through 10.")
    values = (list("ABCDEF") if args.full else args.tunnels) if args.experiment == "stadium" else ([1, 2, 4, 6] if args.full else args.inflows)
    result = []
    for value in dict.fromkeys(values):
        for seed in seeds:
            for short_method in methods:
                method = METHODS[short_method]
                prefix = value if args.experiment == "stadium" else f"s1_rate_{value}"
                if args.duration is not None:
                    prefix = f"diagnostic__{duration_token(args.duration)}__{prefix}"
                result.append({"id": f"{prefix}__{method}__seed{seed:02}", "value": value,
                               "seed": seed, "method": method})
    return result


def duration_token(value):
    """Match JavaScript's decimal filenames over the supported short horizons."""
    if float(value).is_integer():
        return str(int(value))
    if abs(value) >= 1e-6:
        return format(Decimal(str(value)), "f")
    mantissa, exponent = str(value).split("e")
    return f"{mantissa}e{int(exponent):+d}"


def science_manifest(args, jobs):
    files = sorted((ROOT / "src").rglob("*.cjs")) + sorted((ROOT / "src/engine").glob("*.js"))
    files += [ROOT / "configs/bottleneck.json"] if args.experiment == "bottleneck" else []
    code = {str(p.relative_to(ROOT)).replace("\\", "/"): digest(p) for p in files}
    inputs = {}
    if args.experiment == "stadium":
        for camera in sorted({job["value"] for job in jobs}):
            for group in ["calibrated_inputs", "observed_measurements", "protocols"]:
                name = f"{group}/{camera}.json"
                path = args.data / name
                if not path.is_file():
                    raise FileNotFoundError(f"Missing prepared input: {path}")
                inputs[name] = digest(path)
    return {"experiment": args.experiment, "jobs": jobs, "duration_override_s": args.duration,
            "scientific_source_hashes": code, "input_hashes": inputs}


def valid_result(output, job):
    path = output / "runs" / f"{job['id']}.json"
    receipt = Path(str(path) + ".receipt.json")
    if not path.exists() and not receipt.exists():
        return False
    if not path.is_file() or not receipt.is_file():
        raise RuntimeError(f"Incomplete result {job['id']}; keep it for inspection and use a new output directory.")
    record = json.loads(receipt.read_text(encoding="utf-8"))
    if record.get("sha256") != digest(path):
        raise RuntimeError(f"Result checksum mismatch: {path}")
    result = json.loads(path.read_text(encoding="utf-8"))
    if record.get("status") != "scored":
        raise RuntimeError(f"Result is not scored: {job['id']}")
    if result.get("seed") != job["seed"] or result.get("method") != job["method"]:
        raise RuntimeError(f"Result identity differs from requested job: {job['id']}")
    identity = result.get("camera", result.get("arrivalRate"))
    if identity != job["value"]:
        raise RuntimeError(f"Result tunnel/inflow differs from requested job: {job['id']}")
    passed = result.get("gate", {}).get("passed", result.get("implementationGatePassed", False))
    if not passed:
        raise RuntimeError(f"Numerical checks failed for {job['id']}; its result has been retained.")
    return True


def run_job(args, job, node, cancelled=None):
    if cancelled is not None and cancelled.is_set():
        raise RuntimeError(f"Cancelled before starting {job['id']}")
    worker = "run_continuous.cjs" if args.experiment == "stadium" else "run_bottleneck.cjs"
    cmd = [node, str(ROOT / "src" / worker), "--output", str(args.output),
           "--seed", str(job["seed"]), "--method", job["method"]]
    if args.experiment == "stadium":
        cmd += ["--data", str(args.data), "--camera", str(job["value"])]
    else:
        cmd += ["--inflow", str(job["value"])]
    if args.duration is not None:
        cmd += ["--duration", str(args.duration)]
    try:
        import psutil
    except ImportError:
        psutil = None
    begin, peak = time.monotonic(), 0
    log = args.output / "logs" / f"{job['id']}.log"
    # A new log is used if a previous attempt failed before producing a result.
    if log.exists():
        log = log.with_name(f"{job['id']}_{time.time_ns()}.log")
    with log.open("x", encoding="utf-8") as stream:
        proc = subprocess.Popen(cmd, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
        try:
            while proc.poll() is None:
                if cancelled is not None and cancelled.is_set():
                    raise RuntimeError(f"Cancelled {job['id']} after another worker stopped")
                if psutil:
                    try:
                        peak = max(peak, psutil.Process(proc.pid).memory_info().rss)
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                time.sleep(0.1)
        except BaseException:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            raise
    elapsed = time.monotonic() - begin
    if proc.returncode != 0:
        raise RuntimeError(f"{job['id']} failed (exit {proc.returncode}); see {log}")
    if not valid_result(args.output, job):
        raise RuntimeError(f"Worker did not write a completed result: {job['id']}")
    record = {"job": job["id"], "seconds": elapsed, "peak_rss_bytes": peak}
    write_new(args.output / "logs" / f"{job['id']}_{time.time_ns()}.json", record)
    print(f"Completed {job['id']} in {elapsed:.1f} s", flush=True)
    return record


def worker_limit(requested, peak):
    limit = min(requested, os.cpu_count() or 1, 32)
    try:
        import psutil
        free = psutil.virtual_memory().available
        if peak:
            # Keep 30% free and allow twice the observed peak for larger tunnels.
            memory_workers = int(0.7 * free / (2 * peak))
            if memory_workers < 1:
                raise RuntimeError("Available memory is below the reserve for one worker; close other jobs and resume.")
            limit = min(limit, memory_workers)
        return limit, free
    except ImportError:
        return min(limit, 2), None


def verify(directory):
    manifest = json.loads((directory / "batch.json").read_text(encoding="utf-8"))
    jobs = manifest["science"]["jobs"]
    done = sum(valid_result(directory, job) for job in jobs)
    print(f"Verified {done}/{len(jobs)} completed results in {directory}")
    return 0 if done == len(jobs) else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="experiment", required=True)
    for name in ["stadium", "bottleneck"]:
        command = sub.add_parser(name, help=f"Run the {name} experiment")
        command.add_argument("--output", type=Path, help="New output directory; defaults to a timestamped directory")
        command.add_argument("--node", help="Node executable (or set NODE_BINARY)")
        command.add_argument("--seeds", nargs="+", type=int, default=[1])
        command.add_argument("--methods", nargs="+", choices=METHODS, default=["off", "on"])
        command.add_argument("--workers", type=int, default=4, help="Maximum concurrent workers; memory may reduce it")
        command.add_argument("--full", action="store_true", help="Run the complete frozen study (10 seeds, both conditions)")
        command.add_argument("--duration", type=float, help="Diagnostic shortened run in source/model seconds; not a paper result")
        command.add_argument("--resume", action="store_true", help="Reuse verified completed jobs from the same batch")
        if name == "stadium":
            command.add_argument("--data", type=Path, default=ROOT / "data/stadium")
            command.add_argument("--tunnels", nargs="+", choices=list("ABCDEF"), default=["E"])
        else:
            command.add_argument("--inflows", nargs="+", type=int, choices=[1, 2, 4, 6], default=[6])
    check = sub.add_parser("verify", help="Check completed results against their receipts")
    check.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.experiment == "verify":
        return verify(args.output.resolve())
    if not 1 <= args.workers <= 32:
        parser.error("--workers must be between 1 and 32")
    if args.duration is not None and (not math.isfinite(args.duration) or args.duration <= 0 or args.full):
        parser.error("--duration must be positive and cannot be used with --full")
    node, version = find_node(args.node)
    if args.experiment == "stadium":
        args.data = args.data.resolve()
    jobs = job_list(args)
    science = science_manifest(args, jobs)
    if args.output is None:
        if args.resume:
            parser.error("--resume requires --output")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S_%fZ")
        args.output = ROOT / "outputs" / f"{args.experiment}_{stamp}"
    args.output = args.output.resolve()
    if args.output.exists() and not args.resume:
        raise FileExistsError(f"Output already exists: {args.output}. Choose a new directory or --resume.")
    if args.resume and not (args.output / "batch.json").is_file():
        raise ValueError("Resume requires an existing batch.json")
    args.output.mkdir(parents=True, exist_ok=True)
    with output_lock(args.output):
        manifest_path = args.output / "batch.json"
        if args.resume:
            stored = json.loads(manifest_path.read_text(encoding="utf-8"))
            if stored["science"] != science:
                raise ValueError("The code, inputs, job list or duration differs from this batch. Use a new directory.")
        else:
            write_new(manifest_path, {"created_utc": datetime.now(timezone.utc).isoformat(), "science": science,
                                     "python": sys.version, "node": version})
        (args.output / "logs").mkdir(exist_ok=True)
        pending = [job for job in jobs if not valid_result(args.output, job)]
        print(f"Output: {args.output}\nJobs: {len(jobs)}; remaining: {len(pending)}", flush=True)
        if not pending:
            return 0
        # The first pending job measures memory and is part of the requested batch.
        first = run_job(args, pending.pop(0), node)
        workers, free = worker_limit(args.workers, first["peak_rss_bytes"])
        execution = {"requested_workers": args.workers, "workers": workers,
                     "available_memory_bytes": free, "measured_peak_bytes": first["peak_rss_bytes"],
                     "memory_rule": "0.70 * available / (2 * measured peak), capped by CPU count and 32"}
        write_new(args.output / "logs" / f"execution_{time.time_ns()}.json", execution)
        print(f"Using {workers} workers after the memory check.", flush=True)
        cancelled = threading.Event()
        pool = ThreadPoolExecutor(max_workers=workers)
        futures = {}
        try:
            futures = {pool.submit(run_job, args, job, node, cancelled): job for job in pending}
            for future in as_completed(futures):
                future.result()
        except BaseException:
            cancelled.set()
            for future in futures:
                future.cancel()
            raise
        finally:
            pool.shutdown(wait=True, cancel_futures=True)
        return verify(args.output)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, FileNotFoundError, FileExistsError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
