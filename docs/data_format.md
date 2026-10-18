# Data format

The stadium bundle separates inputs that drive movement from observations used to measure agreement. All six tunnels use the same file layout.

For concepts such as ROI and mouth crossings, read [model and measurements](method.md). For commands that rebuild these files, use [the reproduction guide](reproduction.md#rebuild-inputs-from-the-original-tracking-csv).

## Prepared stadium files

Paths are relative to `data/stadium/`.

| File group | Contents | Main use |
|---|---|---|
| `calibrated_inputs/A.json` through `F.json` | Scene, initial agents, arrival brackets, rolling speeds, parameters and fixed threshold | Simulation |
| `observations/A.json` through `F.json` | Projected tracking frames and strict crossing events | Reference measurements and input audit |
| `observed_measurements/A.json` through `F.json` | Counts, density/speed samples and valid crossing-bin masks | Evaluation |
| `protocols/A.json` through `F.json` | Clocks, seeds, phases, parameter rules and numerical checks | Simulation and evaluation |
| `manifest.json` | Portable and archived source hashes | File identity checks |

Personal directory prefixes were removed from provenance strings. Numeric arrays and identity strings remain unchanged. Some historical `version`, `windowId` and seed-domain strings form the randomization keys; changing them can change the seed draws.

## Geometry

The scene defines the coordinates in which agents move.

| Field | Meaning |
|---|---|
| `scene.domainPolygon` | Boundary of the local simulation domain |
| `scene.floorPolygon` | Floor geometry |
| `scene.occupancyPolygon` | Region used to count occupancy |
| `scene.walls` | Finite physical wall segments, with `p0` and `p1` endpoints |
| `scene.mouth` | Mouth endpoints and inward direction |
| `scene.routes` | Waypoint sequences and whether reaching the goal removes an agent |

Polygon vertices are `[x, y]` pairs in tunnel-width units, `W`. The usual mouth spans `[-0.5, 0]` to `[0.5, 0]`, with the plaza at positive y. An ROI edge does not become a wall merely because it appears in a polygon.

The original image-to-ground transformations and frozen scene records are in `data/geometry/`. D uses the final once-registered, fixed geometry in W units.

## Initial agents and arrival records

| Field | Meaning |
|---|---|
| `id` | Simulation identifier for the input agent |
| `sourceId` | Identity in the source camera's tracking record |
| `x`, `y` | Ground position in W |
| `vx`, `vy` | Velocity components in W per source-video s |
| `speed` | Desired speed; null requests the configured fallback or draw |
| `routeId` | Assigned route |
| `waypointIndex` | Current target along that route |
| `lane` | The route's lateral offset input |
| `timeBracket` | Earliest and latest arrival time allowed by the sampled track |
| `sourceSample` | Native tracking sample supporting the arrival |
| `historyEndSample` | End of the available history used for input construction |
| `demandSource` | Boundary-confirmed arrival or inferred tunnel birth |

Arrival fields occur in addition to the position and route fields. Times are elapsed source-video seconds from the first tracked sample.

`rollingSpeedObservations` stores timestamped consecutive displacements ending inside the ROI. Configuration draws use only the allowed pre-arrival interval. Reference egress totals and later observed positions are not substituted into this table.

An arrival's sampled time and its actual admission time can differ when entry space is occupied. Both are retained so demand coverage and admission can be analyzed separately.

## Reference frames and missing observations

Frames contain `time`, `sourceSample` and `agents`. Each observed point has `id`, `x` and `y`.

| Value | Interpretation |
|---|---|
| `agents: []` | A valid observation with no people in the region |
| `agents: null` | An unavailable observation |
| Nonempty `agents` array | Available observed positions |

Do not turn null into zero when analyzing these files. That would turn missing frames into an artificial empty crowd. Crossing-bin coverage flags identify intervals suitable for comparison; strict cumulative crossing counts retain observed events without filling missing intervals.

## Original tracking CSV

The optional adapter expects these columns:

| Column | Meaning |
|---|---|
| `cam_name` | `Tunnel A` through `Tunnel F` |
| `frame_number` | Frame/sample field from the original tracking export, interpreted by the frozen clock mapping |
| `person_id` | Camera-local tracking identity |
| `img_x`, `img_y` | Image coordinates in the original 3840 × 2160 convention |

The adapter retains the original 8 px vertical point adjustment before homography projection. It uses the supplied homography, ROI, walls, mouth and lane-clearance data in `data/geometry/preparation/`.

A new site needs its own geometry and calibration. Changing a camera letter or swapping the CSV does not establish compatible units or routes. The supplied reconstruction command is for this recorded study.

## Saved simulation files

A full stadium run such as `runs/E__feedback_on__seed01.json` contains:

| Content | Purpose |
|---|---|
| Configuration and seeded draws | Reconstruct which inputs and random choices drove the run |
| Native saved states | Inspect individual positions and velocities |
| Sampled counts and mouth crossings | Form occupancy and flow curves |
| Admissions and pending-population diagnostics | Distinguish supplied demand from people already inside |
| Numerical checks | Inspect finite values, conservation, overlap and wall constraints |
| Measurements, metrics and summary | Read the run's scores |
| Provenance hashes | Identify the code, inputs and protocol used |

The adjacent `.json.receipt.json` stores a checksum and status. A batch has `batch.json` plus execution and per-run logs in `logs/`.

Shortened `--duration` runs use a `diagnostic__` filename and `paperResult: false`. The evaluator excludes them from experiment tables.

## Units and output column names

| Unit or convention | Use |
|---|---|
| `W` | Each stadium tunnel's mouth width |
| `W0` | S1's synthetic reference length |
| `U` | MOT20's window-specific provisional ground length |
| Source-video s | Stadium integration and measurement-bin time |
| Dataset time `tV` | Shared plotting clock and annotated phases |
| Model s | Time in the controlled S1 experiment |
| Historical `_agents` suffix | People or crossing events in count fields |

These lengths are normalized, not measured metres. The column names are retained for compatibility with the saved results. See [results](results.md) for error definitions and the table index.
