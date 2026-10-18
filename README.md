# Stadium egress simulation

Code and prepared inputs for **Video-Driven Agent-Based Simulation of Stadium Egress**, by Ao He and Vivian W. H. Wong.

The simulator moves individual pedestrians through an observed floor region. Each agent has a route and a desired speed. Agents deposit density on a grid and receive a bounded congestion correction, with their own deposit excluded. The experiments compare feedback OFF and ON under the same recorded arrivals and random seeds.

This package reproduces the final **six-tunnel, full-recording study** and the **controlled bottleneck experiment (S1)**. The six-tunnel inputs are included, so the main workflow does not need the source videos or an object detector.

## Setup

Use Python 3.11+ and Node.js 20+; the reference simulation ran on Node.js 24.19.0. No npm packages are required. From this directory:

```bash
python -m pip install -r requirements.txt
node --version
python run.py --help
```

If Node is not on PATH, add `--node /path/to/node` to a run command or set `NODE_BINARY`. The simulation uses CPU workers. A GPU is not used.

## First run

The following runs one paired S1 case at inflow 6, then makes tables and figures:

```bash
python run.py bottleneck --inflows 6 --seeds 1 --output outputs/s1_demo
python evaluate.py --experiment bottleneck --runs outputs/s1_demo --output outputs/s1_demo_eval
python render.py --evaluation outputs/s1_demo_eval --output outputs/s1_demo_figures
```

For a stadium example, run tunnel E with one paired seed:

```bash
python run.py stadium --tunnels E --seeds 1 --output outputs/e_demo
python evaluate.py --runs outputs/e_demo --data data/stadium --output outputs/e_demo_eval
python render.py --evaluation outputs/e_demo_eval --output outputs/e_demo_figures --animate
```

The animation uses saved counts at 10 s intervals and 12 frames/s. If an existing FFmpeg executable is available, it writes MP4; otherwise it writes GIF. `quickstart.ipynb` runs the same commands from a notebook.

For a notebook environment, install `requirements-notebook.txt` and open `quickstart.ipynb` in JupyterLab or your existing notebook editor.

Output directories must be new. To resume a batch, repeat its run command with `--resume`; completed files are checked and reused. A change to inputs, numerical code, job selection or diagnostic duration requires a new directory.

## Reproduce the study

```bash
python run.py stadium --full --workers 22 --output outputs/stadium_full
python evaluate.py --runs outputs/stadium_full --data data/stadium --output outputs/stadium_eval
python render.py --evaluation outputs/stadium_eval --output outputs/stadium_figures --animate

python run.py bottleneck --full --workers 8 --output outputs/s1_full
python evaluate.py --experiment bottleneck --runs outputs/s1_full --output outputs/s1_eval
python render.py --evaluation outputs/s1_eval --output outputs/s1_figures
```

The stadium batch contains 120 runs: six tunnels, ten seeds and two feedback conditions. S1 contains 80 runs: four inflows, ten seeds and two conditions. The launcher measures memory on the first job and may reduce the requested worker count. Each worker is a single Node process.

The archived stadium batch took 20.2 min on 22 CPU workers, including one previously completed benchmark. Runtime depends on the machine. Full stadium run files occupy about 3.3 GB; allow at least 6 GB for runs, evaluation and figures. `reference/` contains compact archived tables for comparison.

To reproduce the phase-time table directly from the bundled six-ROI totals:

```bash
python phase_timing.py --input reference/stadium/total_visible_roi_timeseries.csv --output outputs/reference_timing
```

The optional MOT20 short-horizon check is under `auxiliary/mot20/`.

## Files

```text
run.py                 Run and resume paired experiments
prepare.py             Rebuild inputs from the original tracking CSV
evaluate.py            Scores, paired intervals, phases and input coverage
render.py              Time series, overview snapshots and count animation
phase_timing.py        Onset, half-rise, half-decline and correlation
quickstart.ipynb       Small end-to-end example
src/engine/            Four original numerical engine files
src/inputs/            Projection, arrivals and motion-history extraction
src/*.cjs              Configuration, calibration, measurements and workers
data/stadium/          Prepared inputs and automatic tracking reference
data/geometry/         Frozen homographies, walls, mouth lines and ROIs
configs/               Bottleneck protocol
reference/             Archived summary tables and release verification
tests/                 Numerical, preparation and evaluation checks
docs/                  Method, data format and reproduction details
outputs/               New runs and figures; excluded from version control
```

`stadium-macro-engine.js` is the historical filename of the **agent-based** stadium engine. It does not implement the event-level queueing model. All four engine files are retained byte-for-byte to preserve the reported numerical behavior.

## Checks

Install `requirements-prepare.txt` to include the OpenCV-dependent preparation tests.

```bash
node --test tests/*.test.cjs
node --test auxiliary/mot20/tests.test.cjs
python -m unittest discover -s tests -p "test_*.py" -v
python run.py verify outputs/stadium_full
python verify_package.py
```

Tests cover isolated-agent zero feedback, walls, conservation, seed pairing, missing observations, arrival timing and paired statistics. The release verification also compares regenerated inputs and selected complete runs with the archived experiment.

## Interpretation

Stadium positions use each tunnel's mouth width, `W`; S1 uses its synthetic reference length, `W0`. These are normalized lengths. Stadium reference counts come from automatic detection and tracking. D uses fixed geometry after a one-time registration of its annotation. Phases organize measurement and display; recorded demand and the motion rules drive the simulation.

The paper reports channel-dependent feedback effects and incomplete input coverage. Reproduction should retain those differences. See [method](docs/method.md), [data format](docs/data_format.md) and [reproduction](docs/reproduction.md) for the definitions and expected results.

This distribution contains the authors' simulation and analysis code, prepared numeric data and aggregate reference tables. Source videos, paper drafts, correspondence and previous experiment versions are outside the package. AI-assisted code development and its verification are recorded in [provenance](docs/provenance.md).
