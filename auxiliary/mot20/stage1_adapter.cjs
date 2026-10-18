'use strict';
// Open-plane adapter for the CURRENT Stage1 hook. No gate, wall, spawning,
// navigation, or pressure-force implementation is introduced here.
const Stage1Engine = require('../../src/engine/stage1-engine.js');

class OpenPlaneStage1Pressure extends Stage1Engine {
  // Base.reset validates its synthetic tunnel/radius, which is irrelevant to
  // this service. Only the pressure hook runs; the old MOT integrator owns motion.
  reset(options = {}) {
    this.config = { ...Stage1Engine.DEFAULTS, ...options, feedbackOn: true };
    for (const key of ['pressureGridSize', 'pressureRho0', 'pressureAccelerationLimit']) {
      if (!(Number.isFinite(this.config[key]) && this.config[key] > 0)) throw Error('Invalid ' + key);
    }
    if (!(Number.isFinite(this.config.pressureStiffness) && this.config.pressureStiffness >= 0)) throw Error('Invalid stiffness');
    this.config.pressureGridOrigin = this.config.pressureGridOrigin.slice();
    this.time = 0;
    this._feedbackApplied = this._feedbackDeltaSpeedTotal = this._feedbackClipped = this._speedClipped = 0;
    this._lastMaxDv = this._lastMeanDv = this._peakDv = this._pressurePeak = 0;
    this._unsupportedParticleCount = this._unsupportedParticlePeak = this._unrepresentedOccupancy = 0;
    this._lastPressureMax = this._lastPressureMean = 0;
    this._field = null;
    return this;
  }
  _floorContains() { return true; }
  _accessibleFraction() { return 1; }
  _isVisible() { return true; }
  // Both local-agent arms already receive this common cap before the hook.
  // Stage1 measures its own after-cap increment, exactly as in Stadium.
  _agentSpeedLimit() { return this.config.speedLimit; }
  apply(agents, dt) {
    const previous = agents.map(a => [a.vx, a.vy]);
    const prior = { applied: this._feedbackApplied, total: this._feedbackDeltaSpeedTotal,
      clipped: this._speedClipped, peak: this._peakDv };
    this.time += dt;
    // Intentionally inherited: this is the same function used by Stadium/S1.
    this._beforeAdvection(agents, dt);
    // A second norm/cap can round a previously capped 3U/s vector by an ULP
    // even when the entire field is inactive. Preserve exact legacy neutral
    // motion, rather than calling that roundoff a pressure effect.
    if (this._field.metrics.maxPressure === 0) {
      agents.forEach((a, i) => { [a.vx, a.vy] = previous[i]; });
      this._feedbackApplied = prior.applied; this._feedbackDeltaSpeedTotal = prior.total;
      this._speedClipped = prior.clipped; this._peakDv = prior.peak;
      this._lastMaxDv = this._lastMeanDv = 0;
    }
    return this._field;
  }
}

// The two CV variants differ only in the historical OLS span. All initial
// agents remain, including shorter available histories; no gap is bridged.
function lastSecondInitial(window, fps = 25) {
  const histories = new Map(window.history.map(h => [h.id, h.points]));
  return window.initialAgents.map(a => {
    const points = histories.get(a.id).slice(-(fps + 1)), last = points.at(-1);
    if (points.length < 2) throw Error('Missing consecutive history');
    const center = (points[0].frame + last.frame) / 2;
    let denominator = 0, nx = 0, ny = 0;
    for (const p of points) { const t = p.frame - center; denominator += t * t; nx += t * (p.x - last.x); ny += t * (p.y - last.y); }
    return { ...a, vx: fps * nx / denominator, vy: fps * ny / denominator, historyCount: points.length };
  });
}

module.exports = { OpenPlaneStage1Pressure, lastSecondInitial };
