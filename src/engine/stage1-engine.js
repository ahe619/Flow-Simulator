/* S1: an intentionally controlled gate with shared grid pressure feedback.
 * Dimensionless CPU demonstration, not a calibrated fluid or human-flow model.
 * Pressure is a soft velocity increment. Disk/wall constraints remain separate. */
(function (root) {
  'use strict';
  const Base = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.CrowdEngine;
  const Pressure = typeof module !== 'undefined' && module.exports ? require('./pressure-field.js') : root.CrowdPressure;
  const DEFAULTS = Object.freeze({ ...Base.DEFAULTS,
    feedbackOn: true, doorWidth: 0.6, arrivalRate: 4, arrivalDuration: 24,
    maxTime: 100, gateY: -0.65, gateOpenTime: 18, dtMax: 0.02,
    pressureGridSize: 0.28, pressureGridOrigin: [0, 0], pressureRho0: 12, pressureStiffness: 0.3,
    pressureAccelerationLimit: 0.8, individualSpeedLimit: false });

  class Stage1Engine extends Base {
    reset(options) {
      const cfg = { ...DEFAULTS, ...(this.config || {}), ...(options || {}) };
      // arrivalEnd is only a convenience alias for drivers using a demand window.
      if (options && options.arrivalEnd !== undefined) cfg.arrivalDuration = options.arrivalEnd;
      for (const key of ['dtMax', 'pressureGridSize', 'pressureRho0', 'pressureAccelerationLimit']) {
        if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) throw new RangeError(key + ' must be positive and finite');
      }
      for (const key of ['gateOpenTime', 'pressureStiffness']) {
        if (!Number.isFinite(cfg[key]) || cfg[key] < 0) throw new RangeError(key + ' must be nonnegative and finite');
      }
      if (!Number.isFinite(cfg.gateY) || cfg.gateY <= -1.8 + 2 * cfg.radius || cfg.gateY >= -2 * cfg.radius) {
        throw new RangeError('gateY must leave disk clearance inside the tunnel');
      }
      if (cfg.dtMax > 0.02) throw new RangeError('dtMax must not exceed 0.02');
      if (typeof cfg.feedbackOn !== 'boolean') throw new TypeError('feedbackOn must be boolean');
      if (typeof cfg.individualSpeedLimit !== 'boolean') throw new TypeError('individualSpeedLimit must be boolean');
      if (!Array.isArray(cfg.pressureGridOrigin) || cfg.pressureGridOrigin.length !== 2 ||
          !cfg.pressureGridOrigin.every(Number.isFinite)) throw new TypeError('pressureGridOrigin must contain two finite numbers');
      cfg.pressureGridOrigin = cfg.pressureGridOrigin.slice();
      super.reset(cfg);
      this.geometry.gate = { y: cfg.gateY, minX: -cfg.doorWidth / 2, maxX: cfg.doorWidth / 2,
        openTime: cfg.gateOpenTime, artificialControl: true };
      this._areaCache = new Map();
      this._field = { nodes: [], metrics: {}, h: cfg.pressureGridSize, origin: cfg.pressureGridOrigin.slice() };
      this._feedbackApplied = this._feedbackDeltaSpeedTotal = this._feedbackClipped = 0;
      this._speedClipped = 0;
      this._lastMaxDv = this._lastMeanDv = this._peakDv = this._maxOverlapObserved = 0;
      this._pressurePeak = this._lastPressureMax = this._lastPressureMean = 0;
      this._unsupportedParticleCount = this._unsupportedParticlePeak = this._unrepresentedOccupancy = 0;
      this._maxDisplacementSpeed = this._lastMaxDisplacementSpeed = 0;
      this._constraintDisplacement = this._wallDisplacement = this._contactDisplacement = 0;
      this._wallCorrectionVectors = null;
      this._stepMotion = [];
      this._gateClosedDuringStep = null;
      return this;
    }

    get gateClosed() { return this.time < this.config.gateOpenTime - 1e-10; }
    _gateIsBlocking() { return this._gateClosedDuringStep === null ? this.gateClosed : this._gateClosedDuringStep; }

    isContained(x, y, radius) {
      const r = radius === undefined ? this.config.radius : radius;
      return super.isContained(x, y, r) && (!this._gateIsBlocking() || Math.abs(y - this.config.gateY) >= r - 1e-8);
    }

    _project(p) {
      const oldX = p.x, oldY = p.y;
      super._project(p);
      if (this._gateIsBlocking()) {
        // Remember the side before motion, so a disk cannot cross the gate and be
        // projected onto its far side. Agents already below it can leave normally.
        const side = p._gateSide === undefined ? (p.y >= this.config.gateY ? 1 : -1) : p._gateSide;
        if (side > 0) p.y = Math.max(p.y, this.config.gateY + p.r);
        else p.y = Math.min(p.y, this.config.gateY - p.r);
      }
      if (this._wallCorrectionVectors) {
        const dx = p.x - oldX, dy = p.y - oldY;
        const previous = this._wallCorrectionVectors.get(p.id) || { x: 0, y: 0 };
        this._wallCorrectionVectors.set(p.id, { x: previous.x + dx, y: previous.y + dy });
        this._wallDisplacement += Math.hypot(dx, dy);
      }
    }

    _floorContains(x, y) {
      if (y >= 0 && y <= 2.3) return Math.abs(x) <= 2.7;
      return y >= -1.8 && y <= 0 && Math.abs(x) <= this.config.doorWidth / 2;
    }

    _pressureCell(x, y, h) {
      const key = x + ',' + y + ',' + h;
      if (this._areaCache.has(key)) return this._areaCache.get(key);
      let count = 0, closestDistance = Infinity, targetX = x, targetY = y;
      // Fixed area quadrature; units are W0 squared, never square metres.
      // A positive-area cut cell can have its grid centre outside the floor.
      // Keep such cells and end visibility rays on their interior support.
      // The B-spline remains centred on the original grid point.
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        const sx = x + ((i + 0.5) / 6 - 0.5) * h;
        const sy = y + ((j + 0.5) / 6 - 0.5) * h;
        if (!this._floorContains(sx, sy)) continue;
        count++;
        const distance = (sx - x) ** 2 + (sy - y) ** 2;
        if (distance < closestDistance) {
          closestDistance = distance; targetX = sx; targetY = sy;
        }
      }
      if (this._floorContains(x, y)) { targetX = x; targetY = y; }
      const cell = { fraction: count / 36, targetX, targetY };
      this._areaCache.set(key, cell);
      return cell;
    }

    _accessibleFraction(x, y, h) {
      return this._pressureCell(x, y, h).fraction;
    }

    _isVisible(px, py, gx, gy) {
      const cell = this._pressureCell(gx, gy, this.config.pressureGridSize);
      if (!cell.fraction) return false;
      gx = cell.targetX; gy = cell.targetY;
      // The floor is a union of two rectangles. Only y=0 can connect them.
      if ((py >= 0 && gy < 0) || (py < 0 && gy >= 0)) {
        const u = py / (py - gy), x = px + u * (gx - px);
        if (Math.abs(x) > this.config.doorWidth / 2 + 1e-10) return false;
      }
      const barrier = this.config.gateY;
      if (this._gateIsBlocking() && (py - barrier) * (gy - barrier) <= 0 && Math.abs(py - gy) > 1e-10) return false;
      return true;
    }

    _beforeAdvection(agents, h) {
      const cfg = this.config;
      const field = Pressure.computeCrowdPressure(agents, {
        h: cfg.pressureGridSize, origin: cfg.pressureGridOrigin, rho0: cfg.pressureRho0,
        stiffness: cfg.pressureStiffness, dt: h,
        areaWeightedStencil: true,
        accessibleFraction: (x, y, gridH) => this._accessibleFraction(x, y, gridH),
        isVisible: (px, py, gx, gy) => this._isVisible(px, py, gx, gy) });
      this._field = { nodes: field.nodes, metrics: field.metrics, semantics: field.semantics, h: cfg.pressureGridSize,
        origin: cfg.pressureGridOrigin.slice(), sampleTime: this.time - h,
        evaluation: 'positions before advection; one substep behind displayed positions' };
      this._lastPressureMax = field.metrics.maxPressure || 0;
      this._lastPressureMean = field.metrics.meanPressure || 0;
      this._pressurePeak = Math.max(this._pressurePeak, this._lastPressureMax);
      this._unsupportedParticleCount = field.metrics.unsupportedParticleCount || 0;
      this._unsupportedParticlePeak = Math.max(this._unsupportedParticlePeak, this._unsupportedParticleCount);
      this._unrepresentedOccupancy = field.metrics.unrepresentedOccupancy || 0;
      this._lastMaxDv = this._lastMeanDv = 0;
      const byId = new Map(field.corrections.map(c => [c.id, c]));
      let total = 0;
      for (const a of cfg.feedbackOn ? agents : []) {
        const correction = byId.get(a.id);
        if (!correction) continue;
        let dx = correction.dvx, dy = correction.dvy;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error('Nonfinite pressure correction for agent ' + a.id);
        const raw = Math.hypot(dx, dy), max = cfg.pressureAccelerationLimit * h;
        // A post-feedback speed cap must not become an independent force when
        // pressure contributes no increment (including singleton self exclusion).
        // Baseline/local-motion speed handling remains in the common integrator.
        if (raw === 0) continue;
        if (raw > max) { dx *= max / raw; dy *= max / raw; this._feedbackClipped++; }
        const oldX = a.vx, oldY = a.vy;
        a.vx += dx; a.vy += dy;
        const speed = Math.hypot(a.vx, a.vy), limit = this._agentSpeedLimit(a);
        if (speed > limit) { a.vx *= limit / speed; a.vy *= limit / speed; this._speedClipped++; }
        const applied = Math.hypot(a.vx - oldX, a.vy - oldY);
        total += applied;
        if (applied > 1e-12) this._feedbackApplied++;
        this._lastMaxDv = Math.max(this._lastMaxDv, applied);
      }
      this._lastMeanDv = agents.length ? total / agents.length : 0;
      this._feedbackDeltaSpeedTotal += total;
      this._peakDv = Math.max(this._peakDv, this._lastMaxDv);
      this._stepMotion = agents.map(a => ({ agent: a, x: a.x, y: a.y, vx: a.vx, vy: a.vy }));
    }

    _agentSpeedLimit(agent) {
      if (!this.config.individualSpeedLimit) return this.config.desiredSpeed * 1.55;
      if (!Number.isFinite(agent.speed) || agent.speed < 0) throw new RangeError('individual speed must be nonnegative and finite');
      return agent.speed * 1.55;
    }

    step(dt) {
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be nonnegative and finite');
      let left = dt;
      const cap = Math.min(this.config.dtMax, this.config.radius / (this.config.desiredSpeed * 2));
      while (left > 1e-10 && !this.finished) {
        // Split exactly at the one-way gate-opening event. The gate remains
        // closed during the interval ending at its opening time.
        const untilGate = this.gateClosed ? this.config.gateOpenTime - this.time : Infinity;
        const untilArrivalEnd = this.time < this.config.arrivalDuration - 1e-10
          ? this.config.arrivalDuration - this.time : Infinity;
        const h = Math.min(cap, left, this.config.maxTime - this.time, untilGate, untilArrivalEnd);
        if (h <= 1e-10) { this.finished = true; break; }
        this._gateClosedDuringStep = this.gateClosed;
        this._wallCorrectionVectors = new Map();
        for (const a of this.agents) a._gateSide = a.y >= this.config.gateY ? 1 : -1;
        super._advance(h);
        this._lastMaxDisplacementSpeed = 0;
        for (const p of this._stepMotion) {
          const dx = p.agent.x - p.x, dy = p.agent.y - p.y;
          const constraintX = dx - p.vx * h, constraintY = dy - p.vy * h;
          const wall = this._wallCorrectionVectors.get(p.agent.id) || { x: 0, y: 0 };
          this._constraintDisplacement += Math.hypot(constraintX, constraintY);
          this._contactDisplacement += Math.hypot(constraintX - wall.x, constraintY - wall.y);
          this._lastMaxDisplacementSpeed = Math.max(this._lastMaxDisplacementSpeed, Math.hypot(dx, dy) / h);
        }
        this._maxDisplacementSpeed = Math.max(this._maxDisplacementSpeed, this._lastMaxDisplacementSpeed);
        this._wallCorrectionVectors = null;
        this._gateClosedDuringStep = null;
        for (const a of this.agents) delete a._gateSide;
        const current = super.metrics();
        this._maxOverlapObserved = Math.max(this._maxOverlapObserved, current.maxOverlap);
        if (this.agents.length === 0) {
          this._field = { nodes: [], metrics: { energy: 0, maxDensity: 0, maxPressure: 0,
            meanPressure: 0, particleCount: 0, unsupportedParticleCount: 0, unrepresentedOccupancy: 0 },
            h: this.config.pressureGridSize, origin: this.config.pressureGridOrigin.slice(), sampleTime: this.time };
          this._lastPressureMax = this._lastPressureMean = 0;
          this._unsupportedParticleCount = this._unrepresentedOccupancy = 0;
        }
        left -= h;
      }
      return this;
    }

    getField() { return this._field; }
    getMetrics() { return this.metrics(); }

    metrics() {
      const m = super.metrics();
      return { ...m, feedbackOn: this.config.feedbackOn, gateClosed: this.gateClosed,
        gateOpenTime: this.config.gateOpenTime, gateY: this.config.gateY,
        artificialGateControl: true, pressureMax: this._lastPressureMax,
        pressureMean: this._lastPressureMean, pressurePeak: this._pressurePeak,
        maxDeltaSpeed: this._lastMaxDv, meanDeltaSpeed: this._lastMeanDv,
        peakDeltaSpeed: this._peakDv, feedbackApplied: this._feedbackApplied,
        feedbackClipped: this._feedbackClipped, feedbackDeltaSpeedTotal: this._feedbackDeltaSpeedTotal,
        pressureClampCount: this._feedbackClipped,
        pressureSpeedClampCount: this._speedClipped,
        maxDisplacementSpeed: this._maxDisplacementSpeed,
        lastMaxDisplacementSpeed: this._lastMaxDisplacementSpeed,
        constraintDisplacementTotal: this._constraintDisplacement,
        wallProjectionDisplacementTotal: this._wallDisplacement,
        netContactDisplacementTotal: this._contactDisplacement,
        maxOverlapObserved: this._maxOverlapObserved,
        unsupportedParticleCount: this._unsupportedParticleCount,
        unsupportedParticlePeak: this._unsupportedParticlePeak,
        unrepresentedOccupancy: this._unrepresentedOccupancy,
        conservationError: m.requested - m.active - m.exited - m.pending,
        admissionConservationError: m.admitted - m.active - m.exited,
        pressureLaw: 'neighbor-only normalized grid feedback; self deposit excluded; no density projection',
        pressureFieldRole: 'total density/pressure/energy describe occupancy; not applied-force activation or a global force potential',
        pressureMaxNeighborDensity: this._field.metrics.maxNeighborDensity || 0,
        pressureMaxNeighborPressure: this._field.metrics.maxNeighborPressure || 0,
        pressureNeighborPositiveParticleCount: this._field.metrics.neighborPressurePositiveParticleCount || 0,
        pressureRawNonzeroParticleCount: this._field.metrics.rawFeedbackNonzeroParticleCount || 0,
        fluxDefinition: 'one-way count of agent centres crossing y=-1.8 out of the tunnel' };
    }
  }
  Stage1Engine.DEFAULTS = DEFAULTS;
  root.Stage1Engine = Stage1Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Stage1Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
