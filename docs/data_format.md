# Data format

## Prepared stadium bundle

Each A–F tunnel has four JSON files:

| Directory | Contents | Used by |
|---|---|---|
| `calibrated_inputs/` | Scene, initial agents, arrival brackets, rolling speed samples, parameters, fixed threshold | Simulation |
| `observations/` | Projected tracker frames and strict crossing events | Evaluation and input audit |
| `observed_measurements/` | Counts, density/speed samples, valid crossing-bin mask | Evaluation |
| `protocols/` | Clocks, seeds, phases, numerical checks and parameter rules | Simulation and evaluation |

`manifest.json` maps each portable file to its archived source hash. Personal directory prefixes have been removed from provenance strings; numerical arrays and identity strings are retained. Historical `version`, `windowId` and seed-domain strings remain because some of them form the deterministic randomization key.

### Scene

`scene.domainPolygon`, `floorPolygon` and `occupancyPolygon` contain `[x, y]` vertices in W. `walls` contains finite `p0`–`p1` segments. `mouth` defines its endpoints and inward direction. `routes` supplies waypoint arrays and whether an agent exits on reaching its goal. The usual normalized mouth is `[-0.5, 0]`–`[0.5, 0]`, with the plaza at positive y.

### Agents and arrivals

An agent includes `id`, `sourceId`, `x`, `y`, `vx`, `vy`, `speed`, `routeId`, `waypointIndex` and `lane`. `speed: null` requests a seeded draw from eligible historical speeds. An arrival additionally has `timeBracket: [start, end]`, `sourceSample`, `historyEndSample` and `demandSource`. Times are elapsed source-video seconds from the recording's first tracked sample.

`rollingSpeedObservations` contains timestamped consecutive displacements ending inside the ROI. The configuration generator uses only the allowed pre-arrival interval. Do not replace this table with future positions or observed egress.

### Observations

Frames contain `time`, `sourceSample` and `agents`, whose points have `id`, `x` and `y`. `agents: null` means an unavailable observation. An available empty ROI has `agents: []`. These cases must remain distinct.

## Rebuild from tracker CSV

Install `requirements-prepare.txt` only if this step is needed. The CSV is read without modification:

```bash
python prepare.py --tracks /path/to/tracking_df_stadium_2023_1fps.csv --output outputs/prepared
python run.py stadium --data outputs/prepared --full --output outputs/rebuilt_runs
```

Required columns are `cam_name`, `frame_number`, `person_id`, `img_x` and `img_y`; camera values are `Tunnel A` through `Tunnel F`. Coordinates follow the original 3840 × 2160 tracking convention. The adapter retains the original 8 px vertical point adjustment before homography projection. It uses the supplied homography, scene and lane-clearance records in `data/geometry/preparation/`.

This entry point prepares the existing study geometry. A new site needs its own homography, observed floor, mouth, physical walls and route definitions; simply changing a camera letter is insufficient. The detector and tracker are not rerun here.

## Run files

`runs/E__feedback_on__seed01.json` contains configuration, saved states, sampled counters, crossings, admissions, numerical diagnostics, measurements and summary scores. Its receipt contains a SHA256 checksum. Run provenance binds code, prepared inputs and protocol hashes.

`--duration` produces a separate diagnostic filename and marks `paperResult: false`. Evaluation excludes diagnostic runs from the experiment tables.

The historical CSV suffix `_agents` counts people or crossing events. `W`, `W0`, source-video seconds, model seconds and dataset time remain distinct. No physical metre scale is implied.
