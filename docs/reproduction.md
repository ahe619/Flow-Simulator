# Reproduction

Start with the commands in the README. The bundled inputs are sufficient for both feedback conditions across the complete recordings. `prepare.py` is an optional route back to the original tracking CSV.

## Expected checks

After a full stadium run, `evaluate.py` exports the following files under `figure_data/`:

- `run_summary.csv`, `ensemble_summary.csv`, `paired_effects.csv`: per-run metrics and paired effects.
- `phase_summary.csv`: scores within the annotated phases.
- `demand_coverage.csv`: conservative arrival-bracket coverage, seeded schedule coverage and actual admission.
- `timeseries_10s.csv`, `native_timeseries.csv`, `crossings_10s.csv`: measured curves.
- `total_visible_roi_timeseries.csv`: six-ROI totals on the shared dataset-time grid.
- `phase_timing_metrics.csv`: onset, half-rise, half-decline and raw Pearson correlation when all six tunnels and ten paired seeds are available.

Rounded ROI occupancy RMSE values from the archived full-recording study are:

| Tunnel | Feedback OFF | Feedback ON | ON − OFF |
|---|---:|---:|---:|
| A | 9.42 | 15.69 | +6.27 |
| B | 3.60 | 3.35 | −0.25 |
| C | 21.73 | 25.44 | +3.71 |
| D | 7.99 | 7.77 | −0.22 |
| E | 32.71 | 28.81 | −3.90 |
| F | 5.44 | 5.32 | −0.13 |

The full precision values and intervals are in `reference/stadium/`. Minor differences in displayed differences can arise from rounding the means separately.

The six-ROI phase-time check should return:

| Series | Onset | Half-rise | Half-decline |
|---|---:|---:|---:|
| Tracking reference | 665 | 1054 | 1986 |
| Feedback OFF | 694 | 1113 | 2332 |
| Feedback ON | 719 | 1110 | 2332 |

Times are dataset seconds. Raw correlations are approximately 0.9166 and 0.9124, using 2,000 common valid instants. The protocol retains the time grid and excludes 477 missing or out-of-record instants.

At S1 inflow 6, the mean peak gate-front count changes from 39.0 to 35.3 and clearance takes about 4.48 model s longer with feedback. At inflow 2, the separate mouth-front peak rises from 5.0 to 8.4. Compare the saved tables rather than expecting a uniformly beneficial feedback effect.

## Repeatability

Worker count changes scheduling, not seed draws. For an exact regression, use the reference Node major version and compare scientific arrays, configuration and scores. Whole-file hashes change with provenance timestamps and elapsed runtime.

The first job of a batch supplies the measured worker-memory estimate. A 70% available-memory budget, with twice that observed per-worker peak, limits subsequent concurrency. Completed files are retained if a worker fails. A changed or incomplete result is reported rather than silently replaced.

For a quick installation check, use a new output directory:

```bash
python run.py stadium --tunnels D --methods off on --duration 10 --workers 2 --output outputs/smoke
python run.py verify outputs/smoke
```

This verifies execution and numerical checks only. Its shortened results are excluded from study tables.

## Scope of the rendering

The portable renderer uses saved tables for time-series figures, counts in six tunnel tiles and a whole-event timeline. It records its source hashes. Native agent states are retained in run JSON for spatial animation or inspection. The manuscript's hand-composed scene/map panels and Overleaf layout remain separate from numerical reproduction.
