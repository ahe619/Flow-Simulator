'use strict';
const measurement = require('./measurements.cjs');

function sampleStats(values) {
  const finite = values.filter(Number.isFinite), n = finite.length;
  if (!n) return {n: 0, mean: null, sampleSd: null, min: null, max: null};
  const mean = finite.reduce((a, b) => a + b, 0) / n;
  return {n, mean, sampleSd: n > 1 ? Math.sqrt(finite.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null,
    min: Math.min(...finite), max: Math.max(...finite)};
}

function flattenMetrics(windowId, method, seed, metrics, diagnostics, gate) {
  const c = metrics.crossings;
  return {window: windowId, method, seed,
    whole_roi_mae_agents: metrics.wholeRoi.mae, whole_roi_rmse_agents: metrics.wholeRoi.rmse,
    queue_region_mae_agents: metrics.queueRegion.mae, queue_region_rmse_agents: metrics.queueRegion.rmse,
    crossing_bin_rmse_into_agents: c.binCountRMSE.into, crossing_bin_rmse_out_agents: c.binCountRMSE.out,
    crossing_total_observed_into_agents: c.totals.observed.into, crossing_total_observed_out_agents: c.totals.observed.out,
    crossing_total_predicted_into_agents: c.totals.predicted.into, crossing_total_predicted_out_agents: c.totals.predicted.out,
    crossing_endpoint_signed_error_into_agents: c.endpointSignedError.into, crossing_endpoint_signed_error_out_agents: c.endpointSignedError.out,
    crossing_endpoint_absolute_error_into_agents: c.endpointAbsoluteError.into, crossing_endpoint_absolute_error_out_agents: c.endpointAbsoluteError.out,
    feedback_applied_agent_substeps: diagnostics.feedbackApplied, total_agent_substeps: diagnostics.agentSubsteps,
    feedback_applied_fraction: gate.appliedAgentSubstepFraction, pressure_positive_evaluations: diagnostics.pressurePositiveSubsteps,
    pressure_evaluations: diagnostics.pressureEvaluations, pressure_positive_evaluation_fraction: diagnostics.pressureActiveFraction,
    pending_at_end_agents: diagnostics.pending, gate_status: gate.status,
    units: 'counts:agents; time:source seconds; length:camera-local W'};
}

function summarizeRun(windowId,method,seed,run,predicted,observed,metrics){
  const row=flattenMetrics(windowId,method,seed,metrics,run.diagnostics,run.gate),d=run.diagnostics;
  const speeds=[...run.config.initialAgents,...run.config.arrivals].map(a=>a.speed),stats=sampleStats(speeds);
  row.initial_agents=d.initialCount;row.scheduled_arrivals_agents=d.scheduledArrivalCount;row.admitted_arrivals_agents=d.arrivalAdmitted;
  row.requested_arrivals_agents=d.arrivalRequested;row.initial_and_arrival_distinct_sources=new Set([...run.config.initialAgents,...run.config.arrivals].map(a=>a.sourceId??a.id)).size;
  row.individual_v0_mean_W_per_s=stats.mean;row.individual_v0_min_W_per_s=stats.min;row.individual_v0_max_W_per_s=stats.max;
  row.individual_v0_sample_sd_W_per_s=stats.sampleSd;
  row.empirical_speed_draw_count=run.config.randomization.empiricalSpeedDrawCount;row.sparse_speed_fallback_count=run.config.randomization.sparsePoolFallbackCount;
  row.feedback_acceleration_clip_count=d.pressureClampCount;row.feedback_acceleration_clip_fraction=d.feedbackApplied?d.pressureClampCount/d.feedbackApplied:0;
  row.feedback_speed_clip_count=d.pressureSpeedClampCount;row.feedback_speed_clip_fraction=d.feedbackApplied?d.pressureSpeedClampCount/d.feedbackApplied:0;
  row.observed_mean_displacement_speed_W_per_s=measurement.mean(observed.fdPoints.map(p=>p.speed).filter(Number.isFinite));
  row.predicted_mean_displacement_speed_W_per_s=measurement.mean(predicted.fdPoints.map(p=>p.speed).filter(Number.isFinite));
  row.observed_valid_speed_agent_samples=observed.fdPoints.filter(p=>Number.isFinite(p.speed)).length;
  row.predicted_valid_speed_agent_samples=predicted.fdPoints.filter(p=>Number.isFinite(p.speed)).length;
  row.count_comparison_times=metrics.wholeRoi.count;
  row.pressure_grid_origin_x_W=run.config.pressureGridOrigin[0];row.pressure_grid_origin_y_W=run.config.pressureGridOrigin[1];
  row.pressure_rho0_agents_per_W2=run.config.pressureRho0;
  return row;
}

module.exports = {sampleStats, flattenMetrics, summarizeRun};
