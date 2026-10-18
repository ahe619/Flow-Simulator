'use strict';
// Calibration arithmetic retained for inspection and new input preparation.
// Continuous runs use the saved first-minute threshold; this function does not
// re-estimate it during a simulation. Negative snapshot times are relative to
// the calibration interval's end, as recorded in the original prepared data.
const Engine = require('./engine/stadium-macro-engine.js');
const Pressure = require('./engine/pressure-field.js');

function weightedQuantile(rows,q){
  if(!rows.length)throw Error('No calibration nodes');
  const ordered=[...rows].sort((a,b)=>a.value-b.value);
  const target=q*ordered.reduce((s,r)=>s+r.weight,0);let cumulative=0;
  for(const r of ordered){cumulative+=r.weight;if(cumulative>=target)return r.value;}
  return ordered.at(-1).value;
}
function calibrate(input){
  const observed=[],isolated=[],frames=[];
  for(const frame of input.calibration.snapshots){
    if(!(frame.timeRelativeToStart<0 && frame.timeRelativeToStart>=-60))throw Error('Calibration sample is not in preceding60s');
    const engine=new Engine({...input.parameters,pressureRho0:1,feedbackOn:false,
      scene:input.scene,initialAgents:frame.agents,arrivals:[],maxTime:input.durationSeconds});
    const options={h:engine.config.pressureGridSize,origin:engine.config.pressureGridOrigin,rho0:1,
      stiffness:0,dt:0,areaWeightedStencil:true,
      accessibleFraction:(x,y,h)=>engine._accessibleFraction(x,y,h),
      isVisible:(x,y,gx,gy)=>engine._isVisible(x,y,gx,gy)};
    const field=Pressure.computeCrowdPressure(engine.agents,options);
    for(const n of field.nodes)observed.push({value:n.density,weight:n.occupancy});
    for(const a of engine.agents){
      const self=Pressure.computeCrowdPressure([a],options);
      for(const n of self.nodes)isolated.push({value:n.density,weight:n.occupancy});
    }
    frames.push({timeRelativeToStart:frame.timeRelativeToStart,sourceSample:frame.sourceSample,
      agents:engine.agents.length,unsupported:field.metrics.unsupportedParticleCount,
      maximumNodeDensity:field.metrics.maxDensity});
  }
  const observedQ75=weightedQuantile(observed,.75),isolatedQ99=weightedQuantile(isolated,.99);
  const rho0=Math.max(observedQ75,isolatedQ99);
  return {pressureRho0:rho0,observedQ75,isolatedQ99,frames,
    selectionRule:'max(occupancy-weighted75th-percentile grid density in preceding60s, occupancy-weighted99th-percentile isolated-agent grid density at same historical positions); fixed before simulation scoring',
    weights:'Node occupancy, not area: each represented person has total weight1 per snapshot',
    meaning:'Exploratory operational onset; not identified physical jam density, not calibrated against validation counts',
    feedbackLaw:'Unchanged original Stage1 grid occupancy energy and agent feedback; corrected cut-cell deposition',
    observedWeightedFractionAboveThreshold:observed.filter(r=>r.value>rho0).reduce((s,r)=>s+r.weight,0)/observed.reduce((s,r)=>s+r.weight,0),
    isolatedWeightedFractionAboveThreshold:isolated.filter(r=>r.value>rho0).reduce((s,r)=>s+r.weight,0)/isolated.reduce((s,r)=>s+r.weight,0)};
}

module.exports = {weightedQuantile, calibrate};
