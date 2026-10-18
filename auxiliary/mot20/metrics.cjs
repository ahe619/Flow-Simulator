'use strict';
// Scoring copied unchanged from the frozen MOT multiwindow evaluator.
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
function project(H, x, y) {
  const z = H[2][0] * x + H[2][1] * y + H[2][2];
  if (!Number.isFinite(z) || z <= 0) return null;
  const p = [(H[0][0] * x + H[0][1] * y + H[0][2]) / z,
    (H[1][0] * x + H[1][1] * y + H[1][2]) / z];
  return p.every(Number.isFinite) ? p : null;
}

// Integral of two normalized Gaussian kernels is a Gaussian in their
// separation. The common factor 1/(4*pi*sigma^2) cancels in the relative L2.
function relativeDensityL2(predicted, observed, sigma = 0.75) {
  if (predicted.length !== observed.length || !observed.length) throw Error('Density cohorts differ or empty');
  const inner = (a, b) => {
    let sum = 0;
    for (const p of a) for (const q of b) {
      const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      sum += Math.exp(-d2 / (4 * sigma * sigma));
    }
    return sum;
  };
  const pp = inner(predicted, predicted), tt = inner(observed, observed), pt = inner(predicted, observed);
  const numerator = pp + tt - 2 * pt;
  if (numerator < -1e-8 * tt) throw Error('Negative squared density distance');
  return Math.sqrt(Math.max(0, numerator) / tt);
}

function evaluate(run, window, geometry, registration, rawIndex) {
  const maps = run.frames.map(frame => new Map(frame.map(a => [a.id, a])));
  const visible = [], occluded = [];
  let invalidBackprojections = 0;
  const perPerson = window.targets.map(target => {
    const errors = [], pixels = [];
    for (let k = 0; k < target.points.length; k++) {
      const truth = target.points[k], predicted = maps[k + 1].get(target.id);
      if (!predicted) throw Error('Model lost a scored agent');
      const e = Math.hypot(predicted.x - truth.x, predicted.y - truth.y);
      const raw = rawIndex.get(truth.frame + ':' + target.id);
      const anchorPixel = project(geometry.H_U_to_image, predicted.x, predicted.y);
      const pixel = anchorPixel && project(registration.frames[truth.frame].anchor_to_frame, ...anchorPixel);
      const pe = pixel ? Math.hypot(pixel[0] - raw[3], pixel[1] - raw[4]) : null;
      if (pe === null) invalidBackprojections++;
      errors.push(e); pixels.push(pe);
      (raw[5] < 0.5 ? occluded : visible).push(e);
    }
    return { id: target.id, ade: mean(errors), fde: errors.at(-1),
      adePixels: pixels.every(Number.isFinite) ? mean(pixels) : null, fdePixels: pixels.at(-1),
      error1s: errors[24], error2s: errors[49], errors, pixelErrors: pixels };
  });
  const densityBySecond = [1, 2, 3, 4].map(t => {
    const predicted = window.targets.map(p => maps[t * 25].get(p.id));
    const observed = window.targets.map(p => p.points[t * 25 - 1]);
    return { second: t, relativeL2: relativeDensityL2(predicted, observed) };
  });
  return { perPerson, densityBySecond, summary: {
    ade: mean(perPerson.map(p => p.ade)), fde: mean(perPerson.map(p => p.fde)),
    adePixels: perPerson.every(p => p.adePixels !== null) ? mean(perPerson.map(p => p.adePixels)) : null,
    fdePixels: perPerson.every(p => p.fdePixels !== null) ? mean(perPerson.map(p => p.fdePixels)) : null,
    error1s: mean(perPerson.map(p => p.error1s)), error2s: mean(perPerson.map(p => p.error2s)),
    densityRelativeL2: mean(densityBySecond.map(p => p.relativeL2)),
    highVisibilityADE: mean(visible), lowVisibilityADE: mean(occluded),
    highVisibilitySamples: visible.length, lowVisibilitySamples: occluded.length, invalidBackprojections
  } };
}

module.exports={evaluate,project,relativeDensityL2};
