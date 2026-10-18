'use strict';

function gateRun(run, feedbackOn, minimumFraction) {
  const d = run.diagnostics;
  const finite = run.states.every(frame => frame.agents.every(a => [a.x, a.y, a.vx, a.vy].every(Number.isFinite)));
  const fraction = d.agentSubsteps ? d.feedbackApplied / d.agentSubsteps : 0;
  const validDenominator = Number.isInteger(d.agentSubsteps) && d.agentSubsteps >= 0 && Number.isInteger(d.feedbackApplied) && d.feedbackApplied >= 0 && d.feedbackApplied <= d.agentSubsteps;
  const correctReportedFraction = Number.isFinite(d.feedbackAppliedFraction) && Math.abs(fraction - d.feedbackAppliedFraction) < 1e-12;
  const conservation = d.conservationError === 0 && d.admissionConservationError === 0;
  const sufficient = !feedbackOn || fraction >= minimumFraction;
  const offSilent = feedbackOn || d.feedbackApplied === 0;
  const passed = finite && validDenominator && correctReportedFraction && conservation && sufficient && offSilent;
  return {passed, status: !finite || !validDenominator || !correctReportedFraction || !conservation || !offSilent ? 'implementation_failure' :
    !sufficient ? 'feedback_below_predefined_minimum' : feedbackOn ? 'feedback_gate_passed' : 'feedback_off_exempt',
    minimumAppliedAgentSubstepFraction: feedbackOn ? minimumFraction : null, feedbackApplied: d.feedbackApplied, agentSubsteps: d.agentSubsteps,
    appliedAgentSubstepFraction: fraction, pressurePositiveSubsteps: d.pressurePositiveSubsteps, pressureEvaluations: d.pressureEvaluations,
    pressureActiveFraction: d.pressureActiveFraction, finite, conservation,
    note: 'This is a predeclared mechanism-activation gate, not evidence of empirical benefit.'};
}

module.exports = {gateRun};
