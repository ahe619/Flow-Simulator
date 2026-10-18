# Read the results

Compare occupancy and crossings separately. A simulation can keep roughly the right number of people in an ROI while moving them through the mouth at the wrong rate. A lower occupancy error alone does not establish better agreement on both.

The values below come from the archived [stadium tables](../reference/stadium/) and [S1 tables](../reference/bottleneck/). They are the targets for numerical reproduction.

## Start with the curves

The stadium renderer writes `tunnel_A.png` through `tunnel_F.png` for the tunnels included in the run. Each compares ROI occupancy, mouth-front occupancy and cumulative egress. It also writes `occupancy_all_tunnels.png` and, where available, `total_occupancy.png`.

The tracking-reference curve comes from automatic detection and tracking. The OFF and ON curves summarize simulated runs. The shaded range is the minimum to maximum across seeds at that time. It shows run-to-run spread; it is not a 95% confidence band.

Missing reference frames remain gaps. A zero count means the available observation contains no people in the region. A gap means the observation is unavailable.

The overview snapshots and animation show counts in A–F tiles plus a timeline. They use one selected simulated seed, default seed 1. The other static time series summarize the available seeds. The tiles count people within local ROIs and are not full-frame crowd counts.

## RMSE

Root mean square error, or RMSE, summarizes the differences between simulated and reference counts at matched samples:

```text
RMSE = square root of the mean squared count difference
```

For a made-up example, reference counts of `[10, 20, 30]` and simulated counts of `[12, 18, 34]` give differences of `[2, -2, 4]`. Their RMSE is about `2.83` people. Squaring makes larger mismatches contribute more.

The same calculation applies to 10 s egress counts, using only reference-valid bins. An occupancy RMSE has units of people; an egress-flow RMSE concerns people counted per 10 s bin. These are count errors, not errors in individual trajectory coordinates.

## Read a paired comparison

Each seed supplies one OFF run and one ON run. For every pair, the analysis subtracts the OFF metric from the ON metric, then averages the differences across seeds.

For an error such as RMSE:

- A negative ON − OFF difference means feedback reduced that error.
- A positive difference means feedback increased it.
- A 95% interval spanning zero leaves the direction unresolved at that interval level.

Ten pairs use a two-sided Student t interval with nine degrees of freedom. These are unadjusted intervals over seeds for the same recording. They do not measure uncertainty across different events, tracking systems or venues. A one-pair demonstration has no paired confidence interval.

## Six-tunnel occupancy results

| Tunnel | OFF RMSE (people) | ON RMSE (people) | ON − OFF | Paired 95% interval |
|---|---:|---:|---:|---:|
| A | 9.42 | 15.69 | +6.27 | [5.04, 7.49] |
| B | 3.60 | 3.35 | −0.25 | [−0.45, −0.05] |
| C | 21.73 | 25.44 | +3.71 | [1.46, 5.96] |
| D | 7.99 | 7.77 | −0.22 | [−0.34, −0.11] |
| E | 32.71 | 28.81 | −3.90 | [−4.75, −3.05] |
| F | 5.44 | 5.32 | −0.13 | [−1.23, 0.98] |

Feedback reduces occupancy error in B, D and E and increases it in A and C. F's interval spans zero. The table reports separately rounded means and paired differences, so subtracting the displayed means can differ by 0.01 from the displayed difference.

The full values are in [ensemble_summary.csv](../reference/stadium/ensemble_summary.csv) and [paired_effects.csv](../reference/stadium/paired_effects.csv). Use rows with `phase_reference = all` and `metric = whole_roi_rmse_agents` for this comparison.

## Egress counts and input coverage

A cumulative endpoint error is the simulated egress count minus the strict reference count at the end of the interval. A negative value means the simulation counted fewer crossings; a positive value means it counted more.

Input coverage asks whether each reference crossing belongs to a track that had already supplied model input. The conservative version requires the identity to be initially present or its arrival bracket to have ended by the crossing time. This is an event-based proportion, not the fraction of every visible person that the detector found.

A person first detected near the mouth may contribute a reference crossing without ever providing a confirmed boundary arrival. Low coverage therefore identifies a gap between the reference population and the population supplied to the model. It does not say how accurately an injected person will move.

The output separates conservative bracket coverage, coverage under the seeded arrival schedule, and actual admission. Someone can be scheduled but still waiting for entry space. Their admission time is later.

Use `demand_coverage.csv` alongside the crossing errors. Reading only the cumulative curves can mix missing input demand with motion-model error.

## Phase timing

The phase-time analysis uses the total count across all six ROIs. The analysis smooths the reference with a centered 15-sample mean, then both reference and simulated totals with a centered 60-sample mean. Each simulated curve first averages the ten seed totals. The baseline is the median over the first 400 dataset seconds.

| Metric | Meaning |
|---|---|
| Onset | First pre-peak crossing of 10% of the baseline-to-peak rise |
| Half-rise | First pre-peak crossing of 50% of that rise |
| Half-decline | First available post-peak return to 50% |
| Pearson correlation | Similarity of the unsmoothed time variation at common valid instants |

Expected times, in dataset seconds:

| Series | Onset | Half-rise | Half-decline |
|---|---:|---:|---:|
| Tracking reference | 665 | 1054 | 1986 |
| Feedback OFF | 694 | 1113 | 2332 |
| Feedback ON | 719 | 1110 | 2332 |

Raw correlations are approximately 0.9166 for OFF and 0.9124 for ON, using 2,000 common valid instants and excluding 477. Missing observations retain their positions in the time grid during smoothing, and their mask is restored after each pass.

The simulated rise follows the broad event progression, but half-decline is late. A high correlation can coexist with an occupancy bias: the curves can rise together while one remains much higher.

## Controlled bottleneck

At S1 inflow 6, mean peak gate-front count decreases from 39.0 to 35.3 with feedback, while clearance takes about 4.48 model s longer. This shows a change in crowd accumulation and clearance under controlled demand.

Region choice matters. At inflow 2, the separate mouth-front peak increases from 5.0 to 8.4. The gate-front and mouth-front areas measure different parts of the crowd; neither should be substituted for the other.

In the S1 metrics figure, bars show sample standard deviations. A star marks a paired ON − OFF 95% interval excluding zero. A single-seed demo has no standard deviation or interval to estimate.

The S1 output also reports `horizon_mean_exit_flux_people_per_model_s`. It divides completed exits by the configured simulation horizon, not by clearance time. Peak exit flux uses five-second bins.

## What remains uncertain

The stadium reference comes from automatic tracking in one event. Incomplete arrivals and desired speeds taken from slow historical movement both affect the result. The simulation retains about twice the reference occupancy during congestion in the reported six-ROI totals. Changing those input estimates would be a separate experiment.

E's slowdown is similar with feedback OFF and ON, while desired speeds come from the observations. It cannot be used as evidence that congestion feedback independently reproduced an emergent merging effect.

D uses fixed geometry after a one-time registration. Later camera movement is not corrected. The MOT20 auxiliary check uses annotated individual trajectories but has low feedback activation; it does not supply ground truth for Stadium crowd counts. Its [README](../auxiliary/mot20/README.md) gives the separate error definitions and coordinate scale.

## Find the underlying numbers

| File under `figure_data/` | Use it for |
|---|---|
| `run_summary.csv` | One run's metrics, seed and condition |
| `ensemble_summary.csv` | Mean, standard deviation and range across runs |
| `paired_effects.csv` | ON − OFF differences and paired intervals |
| `phase_summary.csv` | Metrics within annotated event phases |
| `timeseries_10s.csv` | Counts at the measurement grid |
| `native_timeseries.csv` | Counts at the saved native times |
| `crossings_10s.csv` | Binned crossings and cumulative counts |
| `demand_coverage.csv` | Reference crossing coverage and admission |
| `total_visible_roi_timeseries.csv` | ROI totals on the common dataset clock |
| `phase_timing_metrics.csv` | Timing and correlation for the complete six-tunnel, ten-pair study |

The historical suffix `_agents` counts people or crossing events, depending on the field. It does not turn a count into a trajectory-distance metric.
