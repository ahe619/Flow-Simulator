# Reproduce the study

Run these commands from the repository root after completing the [first-run guide](getting-started.md). The bundled numeric inputs are sufficient for the stadium and S1 experiments.

## Reproduce six full recordings

```bash
python run.py stadium --full --workers 22 --output outputs/stadium_full
python run.py verify outputs/stadium_full
python evaluate.py --runs outputs/stadium_full --data data/stadium --output outputs/stadium_eval
python render.py --evaluation outputs/stadium_eval --output outputs/stadium_figures --animate
```

`--full` selects A–F, seeds 1–10 and both feedback conditions: 120 runs. The original batch used 22 CPU workers; lower `--workers` for another machine. Worker count changes scheduling, not the seeded simulation.

Each worker is a single Node process. The first pending job measures memory and counts as part of the batch. Later concurrency is limited to 70% of available memory, divided by twice that observed worker peak, and capped by the requested worker count, CPU count and 32.

Run files occupy about 3.3 GB. Allow at least 6 GB for runs and analysis. The archived batch took 20.2 min on 22 workers, including one completed benchmark reused from an earlier run. This timing is a reference, not a runtime guarantee.

## Reproduce the bottleneck experiment

```bash
python run.py bottleneck --full --workers 8 --output outputs/s1_full
python run.py verify outputs/s1_full
python evaluate.py --experiment bottleneck --runs outputs/s1_full --output outputs/s1_eval
python render.py --evaluation outputs/s1_eval --output outputs/s1_figures
```

S1 uses four inflows, ten seeds and two conditions: 80 runs. The figure contains all four inflow levels. `configs/bottleneck.json` contains the final `0.01` model s step and the archived demand hashes.

## Select a smaller batch

```bash
python run.py stadium --tunnels C E --seeds 1 2 --workers 4 --output outputs/ce_subset
```

This selects two tunnels, two seeds and both conditions, giving eight runs. It still runs each selected recording for its complete duration.

| Option | Meaning |
|---|---|
| `--tunnels A B C D E F` | Select stadium tunnels; default is E |
| `--inflows 1 2 4 6` | Select S1 inflows; default is 6 |
| `--seeds 1 2` | Select from the frozen seeds 1–10; default is 1 |
| `--methods off on` | Select conditions; default is both |
| `--workers 4` | Maximum concurrent processes; default is 4, allowed range 1–32 |
| `--full` | Select the full study's tunnels or inflows, ten seeds and both conditions |
| `--output PATH` | New output directory; omitting it creates a timestamped directory |
| `--node PATH` | Node executable; otherwise use `NODE_BINARY` or PATH |
| `--data PATH` | Stadium input bundle; default is `data/stadium` |
| `--duration SECONDS` | A shortened diagnostic, excluded from experiment tables |
| `--resume` | Continue a compatible existing simulation batch |

`PATH` and `SECONDS` in this table describe arguments to replace with your own values. Do not combine `--duration` with `--full`. The [README](../README.md) contains complete example commands.

## Resume an interrupted batch

Repeat the original simulation command, preserving its output path and job selection, and add `--resume`:

```bash
python run.py stadium --full --workers 22 --output outputs/stadium_full --resume
```

The launcher checks completed files and receipts before reusing them. You can change worker count, but input files, numerical code, selected jobs and diagnostic duration must match the batch.

An incomplete run file or checksum mismatch stops the launcher. Keep that batch for inspection and use a new output directory. The launcher does not silently overwrite damaged results.

Evaluation and rendering also require new output directories. Their commands do not have a resume option.

## Check the installation without a full recording

```bash
python run.py stadium --tunnels D --methods off on --duration 10 --workers 2 --output outputs/smoke
python run.py verify outputs/smoke
```

This checks execution and numerical gates over a short interval. Its filenames start with `diagnostic__`, and evaluation excludes it from paper-result tables.

## Recalculate phase timing from the saved reference table

```bash
python phase_timing.py --input reference/stadium/total_visible_roi_timeseries.csv --output outputs/reference_timing
```

This calculation uses the included full-study totals and requires no new simulation. Compare onset, half-rise and half-decline with [the expected values](results.md#phase-timing).

The main evaluator automatically adds this table only when all six tunnels and ten paired seeds are present.

## Rebuild inputs from the original tracking CSV

This optional step requires the original CSV, which is not bundled. Place your copy at `inputs/tracking_df_stadium_2023_1fps.csv` under the repository root, or change the path in the command. Leave the supplied geometry unchanged for this reproduction.

```bash
python -m pip install -r requirements-prepare.txt
python prepare.py --tracks inputs/tracking_df_stadium_2023_1fps.csv --output outputs/prepared
python run.py stadium --data outputs/prepared --full --output outputs/rebuilt_runs
python evaluate.py --runs outputs/rebuilt_runs --data outputs/prepared --output outputs/rebuilt_eval
```

The adapter reads the CSV without modifying it. It performs the existing geometry projection, arrival construction, speed-history extraction and threshold calibration. It does not rerun the detector or tracker. See [data format](data_format.md#original-tracking-csv) for required fields.

## Run MOT20 and the tests

The optional annotated-trajectory check is independent of the stadium launch command:

```bash
node auxiliary/mot20/run.cjs --output outputs/mot20
```

Install the preparation dependencies before running the full Python test suite, because it includes OpenCV-dependent projection tests:

```bash
python -m pip install -r requirements-prepare.txt
node --test tests/*.test.cjs
node --test auxiliary/mot20/tests.test.cjs
python -m unittest discover -s tests -p "test_*.py" -v
python verify_package.py
```

The release check passed 60 engine/configuration tests, 25 Python tests and five MOT20 tests. [release_verification.json](../reference/release_verification.json) records additional comparisons: rebuilt six-tunnel inputs, complete E and S1 seed-1 pairs, all 16 valid MOT20 method/window combinations, and postprocessing of the archived 120 stadium runs.

These checks did not rerun all 120 stadium simulations during packaging. They verified the saved full-study tables and selected complete numerical reruns.

## Figures and animations

`render.py` reads evaluation tables and checks their hashes before drawing. It creates PDF and PNG time series, overview snapshots, and an optional count animation. The default animation takes a frame every 10 dataset seconds and plays at 12 frames/s.

An existing FFmpeg executable produces MP4. If FFmpeg is unavailable, the renderer writes GIF. Supply `--ffmpeg PATH` to use an executable outside PATH, or `--animation-seed 2` to display a different seed present in the batch.

Static stadium time series omit phase backgrounds by default. Add `--phase-bands` when you want them; the overview retains the event timeline. Fonts use embedded TrueType output. `render.py` records table and script hashes in its output manifest.

The portable renderer covers numerical plots and count animations. Saved run JSON also contains agent positions, but the manuscript's spatial animations, scene/map panels and Overleaf layout are separate assets.

## Compare a reproduction

Compare scientific arrays, configurations and metrics with the reference outputs. Use Node.js 24.19.0 for the closest match to the checked environment. Whole-run JSON hashes can differ because elapsed runtime and provenance timestamps change.

The [results guide](results.md) gives expected metrics and interpretations. [environment.json](../environment.json) and [requirements-tested.txt](../requirements-tested.txt) record the checked dependency versions.
