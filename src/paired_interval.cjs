'use strict';
const CRITICAL_VALUE=2.2621571628540993;
const INTERPRETATION='Conditional simulation-seed uncertainty under the frozen demand, geometry, model and calibration; not a ground-truth accuracy or cross-video generalization interval.';
function pairedCI(differences){
  if(!Array.isArray(differences)||differences.length!==10||!differences.every(Number.isFinite))throw new RangeError('exactly ten finite paired differences required');
  const n=10,mean=differences.reduce((a,b)=>a+b,0)/n;
  const sampleSd=Math.sqrt(differences.reduce((s,d)=>s+(d-mean)**2,0)/(n-1));
  const standardError=sampleSd/Math.sqrt(n),halfWidth=CRITICAL_VALUE*standardError;
  return {n,mean,sampleSd,standardError,degreesOfFreedom:9,criticalValue:CRITICAL_VALUE,
    confidenceLevel:.95,ci95Lower:mean-halfWidth,ci95Upper:mean+halfWidth,interpretation:INTERPRETATION};
}
module.exports={CRITICAL_VALUE,INTERPRETATION,pairedCI};
