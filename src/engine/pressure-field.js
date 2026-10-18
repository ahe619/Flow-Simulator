(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrowdPressure = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // S1 demonstration: neighbor-only soft congestion feedback on a shared grid.
  // These are explicit discrete operators, not a new method, a
  // unilateral incompressibility solve, or a Navier-Stokes solver.
  // Unit agent occupancy: rho_g = sum_i w_ig / A_g; r_g = max(rho_g/rho0-1, 0).
  // E = sum_g A_g * rho0 * stiffness * r_g^2 / 2.
  // Total-density mu_g, E and pressure remain descriptive grid quantities.
  // Feedback excludes the receiving agent's OWN NORMALIZED deposit:
  // rho_g^(-i) = max(sum_j w_jg - w_ig, 0) / A_g;
  // mu_g^(-i) = stiffness * max(rho_g^(-i)/rho0 - 1, 0);
  // f_i = -sum_g mu_g^(-i) grad_x_i(w_ig), dv_i = dt * f_i.
  // This modified feedback is NOT -dE/dx_i for the displayed total energy.
  // With neighbors fixed, it differentiates sum_g mu_g^(-i) w_ig locally.
  // Displayed pressure uses p = rho * mu - E/A = rho0*k*(r + r^2/2).
  // These are normalized demo quantities, not measured human contact forces.
  // Stencils may be visibility-masked and normalized; their quotient-rule
  // gradients are used consistently. This derivative assumes a fixed mask:
  // visibility changes at walls/corners are piecewise geometric events.
  // Grid quadrature can cause residual total force on asymmetric layouts;
  // no hidden momentum correction or velocity clipping is applied.

  function finite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(name + ' must be a finite number');
    }
    return value;
  }

  function quadraticBSpline(q) {
    var a = Math.abs(finite(q, 'q'));
    if (a < 0.5) return 0.75 - a * a;
    if (a < 1.5) return 0.5 * (1.5 - a) * (1.5 - a);
    return 0;
  }

  // Derivative with respect to q, not physical x. Physical gradient is N'/h.
  function quadraticBSplineDerivative(q) {
    var a = Math.abs(finite(q, 'q'));
    if (a < 0.5) return -2 * q;
    if (a < 1.5) return -Math.sign(q) * (1.5 - a);
    return 0;
  }

  /**
   * computeCrowdPressure(particles, options) -> { corrections, nodes, metrics }
   * options: h=0.28, origin=[0,0], rho0=12, stiffness=0.3, required dt>=0.
   * particles: unique id (string/finite number), x,y,vx,vy; unit occupancy.
   * All directions share occupancy. Input particles are never modified.
   * accessibleFraction(gx,gy,h) -> [0,1], for node-centered usable cell area.
   * isVisible(px,py,gx,gy) -> boolean, to exclude exchange through a wall.
   * areaWeightedStencil=true weights each retained basis and its gradient by
   * the fixed usable cell fraction before quotient normalization. This avoids
   * depositing a full-cell weight into a vanishing boundary sliver. The same
   * normalized weight is subtracted for self exclusion. Default false.
   * A floor mask alone does not prevent exchange through thin walls.
   * Nodes have positions and occupied areas; only occupied nodes are returned.
   * corrections have {id,dvx,dvy,fx,fy}, in input order. fx/fy are unit-mass
   * accelerations from the neighbor-potential interpolation, not force
   * measurements in newtons or the gradient of the total descriptive energy.
   * An agent with no accessible stencil receives zero dv and is explicitly
   * counted in unsupportedParticleCount/unrepresentedOccupancy. The engine
   * must report/fix such a geometry/grid mismatch rather than infer pressure.
   * No hard density bound, collision handling, advection, or CFL control.
   */
  function computeCrowdPressure(particles, options) {
    if (!Array.isArray(particles)) throw new TypeError('particles must be an array');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('options must include dt');
    }
    var h = finite(options.h === undefined ? 0.28 : options.h, 'h');
    var rho0 = finite(options.rho0 === undefined ? 12 : options.rho0, 'rho0');
    var stiffness = finite(options.stiffness === undefined ? 0.3 : options.stiffness, 'stiffness');
    var dt = finite(options.dt, 'dt');
    if (h <= 0 || rho0 <= 0) throw new RangeError('h and rho0 must be positive');
    if (stiffness < 0 || dt < 0) throw new RangeError('stiffness and dt must be nonnegative');
    if (options.areaWeightedStencil !== undefined && typeof options.areaWeightedStencil !== 'boolean') {
      throw new TypeError('areaWeightedStencil must be boolean');
    }
    var baseArea = h * h;
    if (!Number.isFinite(baseArea) || baseArea <= 0 || !Number.isFinite(1 / h)) {
      throw new RangeError('h is outside the representable range');
    }
    var origin = options.origin === undefined ? [0, 0] : options.origin;
    if (!Array.isArray(origin) || origin.length !== 2) throw new TypeError('origin must be [ox,oy]');
    finite(origin[0], 'origin[0]'); finite(origin[1], 'origin[1]');
    for (var callback of ['accessibleFraction', 'isVisible']) {
      if (options[callback] !== undefined && typeof options[callback] !== 'function') {
        throw new TypeError(callback + ' must be a function');
      }
    }
    var seen = new Set();
    particles.forEach(function (p, index) {
      if (!p || typeof p !== 'object') throw new TypeError('particle must be an object');
      if (!(typeof p.id === 'string' || typeof p.id === 'number' && Number.isFinite(p.id))) {
        throw new TypeError('particle ' + index + ' must have a string or finite numeric id');
      }
      if (seen.has(p.id)) throw new RangeError('particle ids must be unique');
      seen.add(p.id);
      for (var field of ['x', 'y', 'vx', 'vy']) finite(p[field], 'particle ' + index + '.' + field);
    });

    var candidates = new Map(), stencils = [], unsupported = 0;
    particles.forEach(function (p) {
      var qx = (p.x - origin[0]) / h, qy = (p.y - origin[1]) / h;
      var bx = Math.floor(qx - 0.5), by = Math.floor(qy - 0.5);
      if (![bx, by, bx + 2, by + 2].every(Number.isSafeInteger)) {
        throw new RangeError('particle coordinates exceed safe grid index range');
      }
      var raw = [], sum = 0, sumDx = 0, sumDy = 0;
      for (var j = 0; j < 3; j++) for (var i = 0; i < 3; i++) {
        var ix = bx + i, iy = by + j;
        var nx = quadraticBSpline(qx - ix), ny = quadraticBSpline(qy - iy);
        var weight = nx * ny;
        if (weight === 0) continue;
        var key = ix + ',' + iy, node = candidates.get(key);
        if (!node) {
          var x = finite(origin[0] + ix * h, 'grid x'), y = finite(origin[1] + iy * h, 'grid y');
          var fraction = options.accessibleFraction ? options.accessibleFraction(x, y, h) : 1;
          finite(fraction, 'accessibleFraction result');
          if (fraction < 0 || fraction > 1) throw new RangeError('accessibleFraction must lie in [0,1]');
          var area = baseArea * fraction;
          if (fraction > 0 && area === 0) throw new RangeError('accessible area underflow');
          node = { ix: ix, iy: iy, x: x, y: y, area: area, occupancy: 0 };
          candidates.set(key, node);
        }
        if (node.area === 0) continue;
        if (options.isVisible) {
          var visible = options.isVisible(p.x, p.y, node.x, node.y);
          if (typeof visible !== 'boolean') throw new TypeError('isVisible must return a boolean');
          if (!visible) continue;
        }
        var areaWeight = options.areaWeightedStencil ? node.area / baseArea : 1;
        weight *= areaWeight;
        var dx = quadraticBSplineDerivative(qx - ix) * ny / h * areaWeight;
        var dy = nx * quadraticBSplineDerivative(qy - iy) / h * areaWeight;
        raw.push({ node: node, weight: weight, dx: dx, dy: dy });
        sum += weight; sumDx += dx; sumDy += dy;
      }
      if (sum === 0) { unsupported++; stencils.push([]); return; }
      // Differentiate the normalized masked interpolation itself: merely
      // dividing raw gradients by sum misses the quotient-rule contribution.
      raw.forEach(function (s) {
        var w = s.weight / sum;
        s.dx = finite((s.dx - w * sumDx) / sum, 'normalized stencil dx');
        s.dy = finite((s.dy - w * sumDy) / sum, 'normalized stencil dy');
        s.weight = w;
        s.node.occupancy += w;
      });
      stencils.push(raw);
    });

    var nodes = Array.from(candidates.values()).filter(function (n) { return n.occupancy > 0; });
    nodes.sort(function (a, b) { return a.iy - b.iy || a.ix - b.ix; });
    var energy = 0, maxDensity = 0, maxPressure = 0, pressureIntegral = 0, activeArea = 0, occupancy = 0;
    nodes.forEach(function (n) {
      n.density = finite(n.occupancy / n.area, 'node density');
      var excess = Math.max(n.density / rho0 - 1, 0);
      n.potential = finite(stiffness * excess, 'node potential');
      n.pressure = finite(rho0 * stiffness * (excess + 0.5 * excess * excess), 'node pressure');
      n.energy = finite(n.area * rho0 * stiffness * 0.5 * excess * excess, 'node energy');
      energy += n.energy; activeArea += n.area; occupancy += n.occupancy;
      pressureIntegral += n.area * n.pressure;
      maxDensity = Math.max(maxDensity, n.density); maxPressure = Math.max(maxPressure, n.pressure);
    });
    finite(energy, 'total energy'); finite(pressureIntegral, 'pressure integral');
    var totalForceX = 0, totalForceY = 0, maxDeltaSpeed = 0;
    var maxNeighborDensity = 0, maxNeighborPressure = 0;
    var neighborPressurePositiveParticleCount = 0, rawFeedbackNonzeroParticleCount = 0;
    var corrections = particles.map(function (p, index) {
      var fx = 0, fy = 0, hasNeighborPressure = false;
      stencils[index].forEach(function (s) {
        // node.occupancy and s.weight use the exact same normalized deposit.
        // A node containing only this agent therefore subtracts to exactly 0,
        // including masked/area-weighted cut cells and arbitrary grid phase.
        var neighborOccupancy = Math.max(s.node.occupancy - s.weight, 0);
        var neighborDensity = finite(neighborOccupancy / s.node.area, 'neighbor density');
        var neighborExcess = Math.max(neighborDensity / rho0 - 1, 0);
        var neighborPotential = finite(stiffness * neighborExcess, 'neighbor potential');
        var neighborPressure = finite(rho0 * stiffness * (neighborExcess + 0.5 * neighborExcess * neighborExcess), 'neighbor pressure');
        maxNeighborDensity = Math.max(maxNeighborDensity, neighborDensity);
        maxNeighborPressure = Math.max(maxNeighborPressure, neighborPressure);
        hasNeighborPressure = hasNeighborPressure || neighborPotential > 0;
        fx -= neighborPotential * s.dx; fy -= neighborPotential * s.dy;
      });
      finite(fx, 'particle fx'); finite(fy, 'particle fy');
      var dvx = finite(dt * fx, 'particle dvx'), dvy = finite(dt * fy, 'particle dvy');
      if (hasNeighborPressure) neighborPressurePositiveParticleCount++;
      if (dvx !== 0 || dvy !== 0) rawFeedbackNonzeroParticleCount++;
      totalForceX += fx; totalForceY += fy;
      maxDeltaSpeed = Math.max(maxDeltaSpeed, Math.hypot(dvx, dvy));
      return { id: p.id, dvx: dvx, dvy: dvy, fx: fx, fy: fy };
    });
    return {
      corrections: corrections, nodes: nodes,
      semantics: { densityIncludesSelf: true, feedbackExcludesSelf: true,
        energyRole: 'descriptive total-occupancy energy, not a potential for the applied neighbor-only force',
        activation: 'Actual engine velocity increments after caps; positive descriptive grid pressure alone is not feedback activation' },
      metrics: {
        energy: energy, maxDensity: maxDensity, maxPressure: maxPressure,
        meanPressure: activeArea > 0 ? pressureIntegral / activeArea : 0,
        meanDensity: activeArea > 0 ? occupancy / activeArea : 0,
        maxDeltaSpeed: maxDeltaSpeed,
        maxNeighborDensity: maxNeighborDensity, maxNeighborPressure: maxNeighborPressure,
        neighborPressurePositiveParticleCount: neighborPressurePositiveParticleCount,
        rawFeedbackNonzeroParticleCount: rawFeedbackNonzeroParticleCount,
        totalForceX: finite(totalForceX, 'totalForceX'), totalForceY: finite(totalForceY, 'totalForceY'),
        particleCount: particles.length, representedOccupancy: occupancy,
        unsupportedParticleCount: unsupported, unrepresentedOccupancy: unsupported,
        activeNodeCount: nodes.length, activeArea: activeArea
      }
    };
  }

  return {
    computeCrowdPressure: computeCrowdPressure,
    quadraticBSpline: quadraticBSpline,
    quadraticBSplineDerivative: quadraticBSplineDerivative
  };
});
