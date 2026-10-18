# MOT20 short-horizon check

This optional experiment checks individual motion against annotated MOT20-03
trajectories. It uses four processed windows, two seconds of history and a
four-second prediction horizon. All 385 scored person-windows (346 identities)
are evaluated with the same cohort across four methods:

| Method | Motion rule | Mean ADE (U) | Mean FDE (U) |
|---|---|---:|---:|
| `cv_2s` | Constant velocity, two-second history | 0.614998 | 1.226292 |
| `agent` | Agent motion with pair repulsion | 0.601776 | 1.189887 |
| `agent_stage1` | Agent motion with congestion feedback | 0.601733 | 1.189807 |
| `cv_1s` | Constant velocity, last second of history | 0.580052 | 1.168324 |

ADE (average displacement error) measures the distance between a simulated
position and its annotated reference, averaged over the prediction steps.
FDE (final displacement error) measures that distance at the last step. Lower
values mean closer trajectories. A person-window is one person evaluated in
one time window; the same identity can appear in more than one window.

The table gives equal-window means, so each of the four windows has the same
weight regardless of how many people it contains. GT means ground truth:
here, the manually annotated reference trajectories. Pressure activation ranges from 1.3% to
3.8%, below the recorded 5% target in every window. These results provide a
limited short-horizon check; they do not establish ground truth for Stadium
occupancy, egress flow or the density–speed relationship.

## Run

From the package root, with Node.js 24:

```sh
node auxiliary/mot20/run.cjs --output outputs/mot20
```

The output directory must be new. A complete run writes four `window_*.json`
files, `summary.csv`, `aggregate.csv`, `summary.json` and a completion receipt.
Each window JSON includes agent states at 25 Hz, per-person errors, pressure
diagnostics and the initialization/scoring cohort. Window 51 retains its
original registration failure and appears as four failed rows with empty
scores. It is not replaced by another window.

The command checks the frozen input and engine hashes, rebuilds the initial
conditions from the processed observations, and verifies every output frame
and score against the archived results. On the development machine, the full
check took about three seconds. `reference/reproduction_check.json` records
the verification: all 16 method/window comparisons passed, and both output
CSVs were byte-identical to the archived versions.

## What is included

- `data/window_*/`: normalized GT footpoints, image-space GT footpoints,
  saved homographies and per-frame camera registration.
- `data/initial_inputs.json`: the frozen initial positions and velocity
  estimates; two-second and one-second variants use the same identities.
- `data/calibration.json`: pressure thresholds derived from strictly prior
  frames. The runner uses these frozen values without recalibration.
- `data/protocol.json`: all motion, timing and scoring settings.
- `rollout.cjs`, `stage1_adapter.cjs`: open-plane motion and the shared Stage1
  pressure hook from `../../src/engine/`.
- `windows.cjs`, `metrics.cjs`: contiguous-history initialization and ADE/FDE
  scoring, including backprojection to the original image coordinates.
- `reference/`: archived summary CSVs and numerical frame/score hashes.
- `manifest.json`: source mappings and SHA256 hashes. Paths are relative to
  the archived project or this module, with no machine-specific user paths.

The processed windows are sufficient to rerun the saved experiment; videos,
detector inference and camera-registration estimation are not needed. The
module preserves the numerical settings of this auxiliary experiment, which
are listed in its protocol. It uses the Stadium pressure implementation and
historical threshold rule, but does not equate their parameter magnitudes or
coordinate scales.

`U` is a provisional ground-coordinate length defined separately for each
window from the median historical speed. It is not a metre or Stadium tunnel
width `W`. The manual MOT annotations provide the trajectory reference;
camera projection and normalization remain estimated. Consult the original
[MOT20 dataset](https://motchallenge.net/data/MOT20/) for its data terms before
redistributing the processed annotations.

Run the focused checks with:

```sh
node --test auxiliary/mot20/tests.test.cjs
```
