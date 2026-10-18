# Method and measurements

## Individual motion and congestion feedback

Each agent follows route waypoints with a desired speed, relaxation and pairwise repulsion. Physical wall segments constrain motion. Open ROI edges remove agents when they leave the observed region.

At each integration substep, quadratic B-spline weights deposit agent occupancy on a grid. The receiving agent's own deposit is subtracted before its local congestion coefficient is computed. Above the fixed density threshold, the grid sends a bounded velocity correction back to that agent. An isolated agent receives zero congestion feedback. `src/engine/pressure-field.js` defines the stencil, accessible cell areas and correction.

For the stadium experiments, the grid spacing is 0.28 W, the gain is 0.3, the acceleration cap is 0.8 W/s², the body radius is 0.07 W and integration steps are at most 0.02 source-video seconds. The pressure threshold is fixed from the first 60 s of each recording. Its rule takes the larger of the occupancy-weighted 75th percentile of observed node density and the weighted 99th percentile of isolated-agent density.

The first-minute calibration is retrospective and overlaps the beginning of the evaluated recording. Agents with a usable motion history retain the speed from their last consecutive displacement, floored at 0.03 W/s. Other arrivals draw from eligible speed observations in the preceding 60 s. Seeds control these draws, the arrival time within its sampling bracket and the grid origin. OFF and ON share those draws.

## Geometry and recorded demand

ROIs, mouth lines and physical walls are supplied in ground coordinates normalized by each tunnel's mouth width W. Different camera units are not treated as a common metric scale. D uses a once-registered annotation and fixed geometry throughout the recording; later camera motion is uncorrected.

Agents initially visible inside the ROI form the initial population. A boundary arrival needs an outside-to-inside track segment and two consecutive inside samples. A newly visible track in a visible tunnel strip can supply an outbound arrival at the deep boundary. Other tracks first detected in the interior remain absent from the input demand. Each source identity is admitted at most once.

Future recorded boundary arrivals supply demand throughout the run. Reference occupancy and reference egress do not reset the population or determine its later positions.

## Counts and time

- ROI occupancy and mouth-front occupancy are measured every 10 source-video seconds. The mouth-front area is 1 W wide and 1 W deep, intersected with the visible floor.
- Egress count is the cumulative number of plaza-to-tunnel mouth crossings. Egress flow counts them in 10 s bins. The reverse direction is also retained.
- Strict reference crossings require the same ID in consecutive available samples, valid projection, one endpoint inside the ROI, and intersection with the finite mouth segment.
- Missing tracker samples remain missing. Crossing-error bins that touch a missing interval are excluded; cumulative strict crossings remain observed-event totals.
- Native tracking intervals are 1 s for A and 29/29.97 s for B–F. Figures use dataset time tV. The first tracked sample is tV = 0.

Paired effects are ON minus OFF across matching seeds. The reported 95% intervals use Student's t distribution with nine degrees of freedom for ten pairs. They describe seed variability under the same recording. The shaded time-series range is the seed minimum–maximum.

Input coverage counts reference crossing events whose identity was already supplied as an initial agent or whose arrival bracket had ended before crossing. Scheduled coverage and actual admission are separate fields in the output.

## S1

S1 is a controlled bottleneck: two inflows enter a plaza connected to a 0.6 W0-wide tunnel. The gate opens at 18 model s; arrivals end at 24 model s. W0 is a synthetic reference length. The final runs use dt = 0.01 model s and four inflows, 1, 2, 4 and 6 agents/model s. The primary crowding measure is the gate-front count. Mouth-front count is retained separately because the two areas can respond differently.

The paper's high-inflow result is a lower gate-front peak and a longer clearance time with feedback. The stadium results vary by tunnel. The input-speed and coverage limitations remain part of the findings, rather than being corrected during reproduction.
