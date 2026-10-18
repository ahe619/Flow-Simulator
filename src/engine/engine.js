/* Deterministic, dimensionless pedestrian demonstration. Not a calibrated
 * social-force model, a fluid solver, or a prediction of the stadium footage. */
(function (root) {
  'use strict';
  const DEFAULTS = Object.freeze({ seed: 23, arrivalRate: 1.4, doorWidth: 1,
    desiredSpeed: 0.4, maxAgents: 180, radius: 0.07, arrivalDuration: 60,
    maxTime: 150 });
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class CrowdEngine {
    constructor(options) { this.reset(options); }

    reset(options) {
      const cfg = Object.assign({}, DEFAULTS, this.config || {}, options || {});
      for (const key of ['arrivalRate', 'doorWidth', 'desiredSpeed', 'radius', 'arrivalDuration', 'maxTime']) {
        if (!Number.isFinite(cfg[key]) || cfg[key] <= 0) throw new RangeError(key + ' must be positive and finite');
      }
      if (cfg.doorWidth < 0.6 || cfg.doorWidth > 1.6) throw new RangeError('doorWidth must be between 0.6 and 1.6');
      if (cfg.radius < 0.025 || cfg.radius > 0.15) throw new RangeError('radius must be between 0.025 and 0.15');
      if (!Number.isInteger(cfg.maxAgents) || cfg.maxAgents < 1) throw new RangeError('maxAgents must be a positive integer');
      if (!Number.isFinite(cfg.seed)) throw new RangeError('seed must be finite');
      if (cfg.maxTime < cfg.arrivalDuration) throw new RangeError('maxTime must cover arrivalDuration');
      this.config = cfg;
      this.geometry = { approach: { minX: -2.7, maxX: 2.7, minY: 0, maxY: 2.3 },
        tunnel: { minX: -cfg.doorWidth / 2, maxX: cfg.doorWidth / 2, minY: -1.8, maxY: 0 },
        unit: 'W0', radius: cfg.radius };
      this.agents = [];
      this.time = this.exited = this.spawned = this.pending = this.requested = 0;
      this.finished = false;
      this._rng = cfg.seed >>> 0;
      this._queue = [];
      this._exitTimes = [];
      this._travelTotal = this._systemTotal = 0;
      return this;
    }

    _random() {
      let n = this._rng = (this._rng + 0x6D2B79F5) >>> 0;
      n = Math.imul(n ^ (n >>> 15), n | 1);
      n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
      return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
    }

    // Exact disk clearance for the union of the approach and the open tunnel.
    // The two doorway corners are circular in disk-centre configuration space.
    isContained(x, y, radius) {
      const r = radius === undefined ? this.config.radius : radius;
      const half = this.config.doorWidth / 2;
      const eps = 1e-8;
      if (!Number.isFinite(x) || !Number.isFinite(y) ||
          Math.abs(x) > 2.7 - r + eps || y > 2.3 - r + eps || y < -1.8 - eps) return false;
      if (y >= r - eps) return true;
      if (y <= 0) return Math.abs(x) <= half - r + eps;
      return Math.abs(x) <= half - Math.sqrt(Math.max(0, r * r - y * y)) + eps;
    }

    _project(p) {
      const r = p.r, half = this.config.doorWidth / 2;
      p.x = clamp(p.x, -2.7 + r, 2.7 - r);
      p.y = Math.min(p.y, 2.3 - r);
      if (p.y >= r || (p.y <= 0 && Math.abs(p.x) <= half - r) ||
          (p.y > 0 && Math.abs(p.x) <= half - Math.sqrt(Math.max(0, r * r - p.y * p.y)))) return;
      const x = p.x, y = p.y;
      // Nearest point in either rectangular interior or on either rounded corner.
      const candidates = [
        { x, y: Math.max(r, y) },
        { x: clamp(x, -half + r, half - r), y }
      ];
      for (const sign of [-1, 1]) {
        const cx = sign * half;
        const a = sign > 0 ? clamp(Math.atan2(y, x - cx), Math.PI / 2, Math.PI)
          : clamp(Math.atan2(y, x - cx), 0, Math.PI / 2);
        candidates.push({ x: cx + r * Math.cos(a), y: r * Math.sin(a) });
      }
      let best = candidates[0], score = Infinity;
      for (const c of candidates) {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < score) { score = d; best = c; }
      }
      p.x = best.x; p.y = best.y;
    }

    _demand() {
      const cfg = this.config;
      const total = Math.floor(Math.min(this.time, cfg.arrivalDuration) * cfg.arrivalRate + 1e-9);
      while (this.requested < total) {
        const id = ++this.requested;
        this._queue.push({ id, side: id % 2 ? -1 : 1,
          y: 0.6 + 1.2 * this._random(),
          lane: (this._random() * 2 - 1) * (cfg.doorWidth / 2 - cfg.radius - 0.035),
          speed: cfg.desiredSpeed * (0.9 + 0.2 * this._random()),
          requestedAt: id / cfg.arrivalRate });
      }
      this.pending = this._queue.length;
    }

    _admit() {
      const r = this.config.radius;
      while (this._queue.length && this.agents.length < this.config.maxAgents) {
        const q = this._queue[0];
        const x = q.side * (2.7 - r - 0.006);
        let chosen = null;
        for (const offset of [0, 0.19, -0.19, 0.38, -0.38, 0.57, -0.57, 0.76, -0.76]) {
          const y = clamp(q.y + offset, 0.32, 2.3 - r - 0.03);
          if (this.agents.every(a => (a.x - x) ** 2 + (a.y - y) ** 2 >= (2 * r + 0.012) ** 2)) {
            chosen = y; break;
          }
        }
        if (chosen === null) break; // Demand remains in the external FIFO queue.
        this._queue.shift();
        this.agents.push({ id: q.id, x, y: chosen, vx: -q.side * q.speed * 0.15, vy: 0,
          r, lane: q.lane, speed: q.speed, enteredAt: this.time, requestedAt: q.requestedAt });
        this.spawned++;
      }
      this.pending = this._queue.length;
    }

    step(dt) {
      if (!Number.isFinite(dt) || dt < 0) throw new RangeError('dt must be nonnegative and finite');
      // Small substeps prevent tunnelling through the finite-radius walls.
      const cap = Math.min(0.04, this.config.radius / (this.config.desiredSpeed * 2));
      let left = dt;
      while (left > 1e-10 && !this.finished) {
        const h = Math.min(cap, left, this.config.maxTime - this.time);
        if (h <= 1e-10) { this.finished = true; break; }
        this._advance(h);
        left -= h;
      }
      return this;
    }

    _advance(h) {
      const cfg = this.config, half = cfg.doorWidth / 2;
      this.time = Math.round((this.time + h) * 1e12) / 1e12;
      this._demand();
      this._admit();
      const agents = this.agents;
      const forces = agents.map(a => {
        let tx = a.lane, ty = -2.0;
        if (a.y > 0) {
          const crossX = (a.x * 0.6 + a.lane * a.y) / (a.y + 0.6);
          if (Math.abs(crossX) > half - a.r - 0.025) {
            tx = Math.sign(a.x) * (half - a.r - 0.055); ty = a.r + 0.12;
          } else { ty = -0.6; }
        }
        const dx = tx - a.x, dy = ty - a.y, d = Math.max(1e-9, Math.hypot(dx, dy));
        return { x: (a.speed * dx / d - a.vx) / 0.32,
          y: (a.speed * dy / d - a.vy) / 0.32 };
      });
      const pairs = [];
      for (let i = 0; i < agents.length; i++) {
        for (let j = i + 1; j < agents.length; j++) {
          const a = agents[i], b = agents[j], dx = a.x - b.x, dy = a.y - b.y;
          if (Math.abs(dx) > 0.55 || Math.abs(dy) > 0.55) continue;
          pairs.push([i, j]);
          const d = Math.hypot(dx, dy);
          if (d > 0.45) continue;
          const nx = d > 1e-9 ? dx / d : (a.id % 2 ? 1 : -1), ny = d > 1e-9 ? dy / d : 0;
          const force = Math.min(4, 0.8 * Math.exp((a.r + b.r - d) / 0.055));
          forces[i].x += nx * force; forces[i].y += ny * force;
          forces[j].x -= nx * force; forces[j].y -= ny * force;
        }
      }
      const previous = agents.map(a => ({ x: a.x, y: a.y }));
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        a.vx += forces[i].x * h; a.vy += forces[i].y * h;
        const speed = Math.hypot(a.vx, a.vy), limit = cfg.desiredSpeed * 1.55;
        if (speed > limit) { a.vx *= limit / speed; a.vy *= limit / speed; }
      }
      this._beforeAdvection(agents, h);
      for (const a of agents) {
        a.x += a.vx * h; a.y += a.vy * h;
        this._project(a);
      }
      // Position-based disk contact correction. Residual overlap is reported.
      for (let iteration = 0; iteration < 14; iteration++) {
        let largest = 0;
        for (const [i, j] of pairs) {
          const a = agents[i], b = agents[j], dx = a.x - b.x, dy = a.y - b.y;
          const rr = a.r + b.r, dsq = dx * dx + dy * dy;
          if (dsq >= rr * rr) continue;
          const d = Math.sqrt(dsq), overlap = rr - d;
          largest = Math.max(largest, overlap);
          const nx = d > 1e-9 ? dx / d : (a.id % 2 ? 1 : -1), ny = d > 1e-9 ? dy / d : 0;
          const shift = (overlap + 1e-6) * 0.5;
          a.x += nx * shift; a.y += ny * shift;
          b.x -= nx * shift; b.y -= ny * shift;
          this._project(a); this._project(b);
        }
        if (largest < 0.0001) break;
      }
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        a.vx = (a.x - previous[i].x) / h; a.vy = (a.y - previous[i].y) / h;
        const speed = Math.hypot(a.vx, a.vy), limit = cfg.desiredSpeed * 1.55;
        if (speed > limit) { a.vx *= limit / speed; a.vy *= limit / speed; }
      }
      this.agents = agents.filter(a => {
        if (a.y > -1.8) return true;
        this.exited++;
        this._travelTotal += this.time - a.enteredAt;
        this._systemTotal += this.time - a.requestedAt;
        this._exitTimes.push(this.time);
        return false;
      });
      const drained = this.time >= cfg.arrivalDuration && this.agents.length === 0 && this.pending === 0;
      this.finished = drained || this.time >= cfg.maxTime - 1e-9;
    }

    // Protected extension point. The default is deliberately an exact no-op.
    // Velocities include local forces; positions have not yet been advanced.
    _beforeAdvection(agents, h) {}

    metrics() {
      let overlaps = 0, maxOverlap = 0;
      for (let i = 0; i < this.agents.length; i++) {
        for (let j = i + 1; j < this.agents.length; j++) {
          const a = this.agents[i], b = this.agents[j];
          const overlap = a.r + b.r - Math.hypot(a.x - b.x, a.y - b.y);
          if (overlap > 0.001) overlaps++;
          maxOverlap = Math.max(maxOverlap, overlap);
        }
      }
      const windowCount = this._exitTimes.filter(t => t > this.time - 10).length;
      return { time: this.time, active: this.agents.length, exited: this.exited,
        requested: this.requested, admitted: this.spawned, spawned: this.spawned, pending: this.pending,
        meanTravelTime: this.exited ? this._travelTotal / this.exited : null,
        meanSystemTime: this.exited ? this._systemTotal / this.exited : null,
        throughputWindow: windowCount / Math.min(10, Math.max(this.time, 1e-9)),
        throughputWindowSeconds: Math.min(10, this.time),
        overlaps, maxOverlap, finished: this.finished,
        termination: !this.finished ? null : this.agents.length + this.pending === 0 ? 'drained' : 'timeout',
        units: { length: 'W0', time: 'provisional simulation second', speed: 'W0 / simulation second' } };
    }
  }
  CrowdEngine.DEFAULTS = DEFAULTS;
  root.CrowdEngine = CrowdEngine;
  if (typeof module !== 'undefined' && module.exports) module.exports = CrowdEngine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
