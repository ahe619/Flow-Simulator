'use strict';
const {performance} = require('node:perf_hooks');
const Stage1 = require('./engine/stage1-engine.js');
const Measurements = require('./measurements.cjs');
const {pointInPolygon} = require('./measurement_primitives.cjs');
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function sceneFor(config) {
  const half=config.doorWidth/2;
  const domainPolygon=[[-2.7,0],[-half,0],[-half,-1.8],[half,-1.8],[half,0],[2.7,0],[2.7,2.3],[-2.7,2.3]];
  return {domainPolygon,occupancyPolygon:domainPolygon,mouth:{p0:[-half,0],p1:[half,0],inboundSign:-1}};
}
function regionArea(region,doorWidth) {
  const approachHeight=Math.max(0,Math.min(region.yMax,2.3)-Math.max(region.yMin,0));
  const approachWidth=Math.max(0,Math.min(region.xMax,2.7)-Math.max(region.xMin,-2.7));
  const tunnelHeight=Math.max(0,Math.min(region.yMax,0)-Math.max(region.yMin,-1.8));
  const tunnelWidth=Math.max(0,Math.min(region.xMax,doorWidth/2)-Math.max(region.xMin,-doorWidth/2));
  return approachHeight*approachWidth+tunnelHeight*tunnelWidth;
}
function countRegion(agents,region,scene) {
  return agents.filter(a=>a.x>=region.xMin-1e-9&&a.x<=region.xMax+1e-9&&a.y>=region.yMin-1e-9&&a.y<=region.yMax+1e-9&&pointInPolygon(a.x,a.y,scene.domainPolygon)).length;
}
function phase(start,end,gateOpenTime) { return end<=gateOpenTime?'closed':start>=gateOpenTime?'open':'mixed'; }

class InstrumentedS1 extends Stage1 {
  constructor(config) { super(config); this.agentSubsteps=0;this.pressureEvaluations=0;this.pressurePositiveSubsteps=0;this.recordedDemand=[]; }
  _demand() {
    const prior=this.requested;super._demand();
    for(const q of this._queue)if(q.id>prior)this.recordedDemand.push({...q});
  }
  _beforeAdvection(agents,h) {
    this.agentSubsteps+=agents.length;super._beforeAdvection(agents,h);this.pressureEvaluations++;
    if(this.getField().metrics.maxPressure>0)this.pressurePositiveSubsteps++;
  }
}
function runCase(item,protocol) {
  const start=performance.now(),engine=new InstrumentedS1(item.config),scene=sceneFor(engine.config);
  const regions=Object.fromEntries(Object.entries(protocol.regions).map(([key,r])=>[key,{...r,accessibleAreaW02:regionArea(r,engine.config.doorWidth)}]));
  const states=[],timeseries=[],mouthCrossings=[],mouthState=new Map();
  const checks={nonfinite:0,outsideFloor:0,crossedClosedGate:0,counterErrors:0,nonmonotoneExits:0,maxUnsupported:0,maxDensity:0};
  let lastExited=0,lastRecord=-1;
  const record=(time,postDrain=false)=>{
    const m=engine.metrics(),agents=postDrain?[]:engine.agents.map(a=>({id:a.id,x:a.x,y:a.y,vx:a.vx,vy:a.vy,speed:a.speed,r:a.r,lane:a.lane}));
    states.push({time,postDrain,agents});
    const row={time,postDrain,active:agents.length,requested:m.requested,admitted:m.admitted,pending:m.pending,exited:m.exited,
      gate_phase:time<engine.config.gateOpenTime?'closed':'open'};
    for(const [name,region] of Object.entries(regions)) { row[name+'_count']=countRegion(agents,region,scene);row[name+'_density_agents_per_W02']=row[name+'_count']/region.accessibleAreaW02; }
    timeseries.push(row);lastRecord=time;
  };
  record(0);
  while(!engine.finished) {
    const nextSample=Math.min(Math.floor(engine.time+1e-8)+1,engine.config.maxTime);
    const wasClosed=engine.gateClosed;
    engine.step(Math.min(engine.config.dtMax,nextSample-engine.time));
    const m=engine.metrics(),field=engine.getField();
    for(const a of engine.agents) {
      if(![a.x,a.y,a.vx,a.vy].every(Number.isFinite))checks.nonfinite++;
      if(!engine.isContained(a.x,a.y,a.r))checks.outsideFloor++;
      if(wasClosed&&a.y<engine.config.gateY+a.r-1e-8)checks.crossedClosedGate++;
      const sign=Math.abs(a.y)<1e-10?0:Math.sign(a.y),previous=mouthState.get(a.id);
      if(sign&&previous?.sign&&sign!==previous.sign) {
        const t=previous.y/(previous.y-a.y),x=previous.x+t*(a.x-previous.x);
        if(Math.abs(x)<=engine.config.doorWidth/2+1e-9)mouthCrossings.push({id:a.id,time:previous.time+t*(engine.time-previous.time),direction:sign<0?'into':'out',x,y:0});
      }
      if(sign)mouthState.set(a.id,{x:a.x,y:a.y,time:engine.time,sign});
    }
    if(m.conservationError!==0||m.admissionConservationError!==0)checks.counterErrors++;
    if(m.exited<lastExited)checks.nonmonotoneExits++;
    lastExited=m.exited;checks.maxUnsupported=Math.max(checks.maxUnsupported,field.metrics.unsupportedParticleCount||0);checks.maxDensity=Math.max(checks.maxDensity,field.metrics.maxDensity||0);
    if(Math.abs(engine.time-nextSample)<1e-8&&engine.time>lastRecord+1e-8)record(nextSample);
  }
  const final=engine.metrics(),drained=final.active===0&&final.pending===0&&engine.time>=engine.config.arrivalDuration-1e-9;
  const terminalState={time:engine.time,agents:engine.agents.map(a=>({...a}))};
  if(drained)for(let time=Math.floor(lastRecord)+1;time<=engine.config.maxTime;time++)record(time,true);
  const measurements=Measurements.measureFrames(states,scene,{dtSeconds:1,durationSeconds:engine.config.maxTime});
  const perTime=new Map(measurements.timeseries.map(r=>[r.time,r]));
  for(const row of timeseries) {const measured=perTime.get(row.time);row.mean_displacement_speed_W0_per_s=measured.mean_speed;row.speed_sample_count=measured.speed_sample_count;}
  const fdPoints=measurements.fdPoints;
  const exitEvents=engine._exitTimes.map((time,i)=>({time,eventIndex:i+1}));
  const throughputDensity=[];
  for(let t=0;t<engine.config.maxTime;t+=protocol.throughputBinSeconds) {
    const end=Math.min(engine.config.maxTime,t+protocol.throughputBinSeconds),samples=timeseries.filter(r=>r.time>=t&&r.time<end);
    const exitCount=exitEvents.filter(e=>e.time>=t&&e.time<end).length;
    for(const [region,definition] of Object.entries(regions)) throughputDensity.push({start:t,end,region,gate_phase:phase(t,end,engine.config.gateOpenTime),
      sample_count:samples.length,mean_region_count:mean(samples.map(r=>r[region+'_count'])),
      mean_region_density_agents_per_W02:mean(samples.map(r=>r[region+'_density_agents_per_W02'])),accessible_area_W02:definition.accessibleAreaW02,
      exit_count:exitCount,exit_throughput_agents_per_s:exitCount/(end-t),
      mouth_into_count:mouthCrossings.filter(e=>e.time>=t&&e.time<end&&e.direction==='into').length,
      mouth_out_count:mouthCrossings.filter(e=>e.time>=t&&e.time<end&&e.direction==='out').length});
  }
  const diagnostics={...final,agentSubsteps:engine.agentSubsteps,pressureEvaluations:engine.pressureEvaluations,pressurePositiveSubsteps:engine.pressurePositiveSubsteps,
    feedbackAppliedFraction:engine.agentSubsteps?final.feedbackApplied/engine.agentSubsteps:0,
    pressureActiveSubstepFraction:engine.pressureEvaluations?engine.pressurePositiveSubsteps/engine.pressureEvaluations:0,
    accelerationClippedAgentSubstepFraction:engine.agentSubsteps?final.pressureClampCount/engine.agentSubsteps:0,
    pressureSpeedClippedAgentSubstepFraction:engine.agentSubsteps?final.pressureSpeedClampCount/engine.agentSubsteps:0};
  const implementationGatePassed=checks.nonfinite===0&&checks.outsideFloor===0&&checks.crossedClosedGate===0&&checks.counterErrors===0&&checks.nonmonotoneExits===0&&checks.maxUnsupported===0&&final.maxOverlapObserved<.001;
  return {caseId:item.caseId,arrivalRate:engine.config.arrivalRate,seed:engine.config.seed,method:item.method,config:engine.config,
    elapsedSeconds:(performance.now()-start)/1000,scene,regions,checks,implementationGatePassed,
    drainTimeSeconds:drained?engine.time:null,censored:!drained,censorTimeSeconds:drained?null:engine.time,
    diagnostics,requestedDemand:engine.recordedDemand,states,terminalState,timeseries,exitEvents,mouthCrossings,throughputDensity,fdPoints,
    measurementMetadata:{...measurements.metadata,units:{length:'W0',time:'provisional simulation second',density:'agents/W0^2',speed:'W0/s',q:'agents/(W0*s)'},
      note:'Measurement sigma .25 W0 is separate from pressure-grid h .28 W0; pressure mechanism is unchanged.'}};
}

module.exports = {runCase, sceneFor, regionArea, countRegion, InstrumentedS1};
