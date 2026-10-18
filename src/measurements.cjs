'use strict';
// Reuse unchanged geometric/KDE primitives. With exactly two samples, OLS is
// exactly the observed displacement divided by the native elapsed seconds.
const previous = require('./measurement_primitives.cjs');
const mean = values => values.length ? values.reduce((s,x)=>s+x,0)/values.length : null;
const EPS = 1e-6;

function inQueue(a, region, occupancy) {
  const dx=a.x-region.centre[0],dy=a.y-region.centre[1];
  const along=dx*region.tangent[0]+dy*region.tangent[1],depth=dx*region.approachNormal[0]+dy*region.approachNormal[1];
  return Math.abs(along)<=.5+EPS && depth>=-EPS && depth<=1+EPS && previous.pointInPolygon(a.x,a.y,occupancy);
}

function measureFrames(frames,scene,options) {
  const measured=previous.measureFrames(frames,scene,{...options,sigmaW:.25,cutoffSigma:3,historyPoints:2});
  const region=previous.makeQueueRegion(scene,{widthW:1,depthW:1}),occupancy=scene.occupancyPolygon??scene.domainPolygon;
  const queueCounts=new Map();
  for(const p of measured.fdPoints){
    p.inside_queue_region=inQueue(p,region,occupancy);
    p.vx_displacement=p.vx_ols;p.vy_displacement=p.vy_ols;delete p.vx_ols;delete p.vy_ols;
    if(p.inside_queue_region)queueCounts.set(previous.timeKey(p.time),(queueCounts.get(previous.timeKey(p.time))||0)+1);
  }
  for(const row of measured.timeseries)row.queue_region_count=row.missing_frame?null:(queueCounts.get(previous.timeKey(row.time))||0);
  measured.queueRegion=region;
  measured.metadata.speedEstimator='Two consecutive native positions: Euclidean displacement / actual source seconds; no three-point smoothing';
  measured.metadata.queueWidthW=1;measured.metadata.queueDepthW=1;
  return measured;
}

function countFramesAtTimes(frames,scene,{durationSeconds,binSeconds=10,mode}) {
  if(!['observed_preceding','simulation_exact'].includes(mode))throw new Error('unknown count sampling mode');
  const ordered=[...frames].sort((a,b)=>a.time-b.time),map=new Map(ordered.map(f=>[previous.timeKey(f.time),f]));
  const region=previous.makeQueueRegion(scene,{widthW:1,depthW:1}),occupancy=scene.occupancyPolygon??scene.domainPolygon;
  const rows=[];
  for(let time=0;time<=durationSeconds+1e-8;time+=binSeconds){
    const f=mode==='simulation_exact'?map.get(previous.timeKey(time)):ordered.filter(f=>f.time<=time+1e-9).at(-1);
    if(!f)throw new Error(`no ${mode} count frame at ${time}`);
    const members=f.agents===null?null:f.agents.filter(a=>previous.pointInPolygon(a.x,a.y,scene.domainPolygon)&&previous.pointInPolygon(a.x,a.y,occupancy));
    rows.push({time,sourceTime:f.time,sourceSample:f.sourceSample??null,lagSeconds:time-f.time,
      whole_roi_count:members===null?null:members.length,queue_region_count:members===null?null:members.filter(a=>inQueue(a,region,occupancy)).length,
      samplingMode:mode});
  }
  return rows;
}

function compareMeasurements(predicted,observed,predCrossings,obsCrossings,options){
  const result=previous.compareMeasurements({timeseries:predicted.counts10s},{timeseries:observed.counts10s},predCrossings,obsCrossings,options);
  result.alignment={...result.alignment,definition:'At t=0,10,...,duration, simulation is sampled exactly; observed count uses nearest preceding native sample without future interpolation.',
    observedSampling:observed.counts10s.map(r=>({time:r.time,sourceTime:r.sourceTime,sourceSample:r.sourceSample,lagSeconds:r.lagSeconds}))};
  return result;
}

function quantile(values,q){
  if(!values.length)return null;
  const sorted=[...values].sort((a,b)=>a-b),index=(sorted.length-1)*q,lo=Math.floor(index),hi=Math.ceil(index);
  return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);
}

function fdBins(rows){
  const groups=new Map();
  for(const r of rows){
    if(!Number.isFinite(r.speed_W_per_source_s)||!Number.isFinite(r.rho_agents_per_W2)||!Number.isFinite(r.q_agents_per_W_source_s))continue;
    const bin=Math.floor(r.rho_agents_per_W2),key=JSON.stringify([r.method,bin]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);
  }
  return [...groups].map(([key,group])=>{
    const [method,bin]=JSON.parse(key),speed=group.map(r=>r.speed_W_per_source_s),flow=group.map(r=>r.q_agents_per_W_source_s);
    return {method,density_bin_min_agents_per_W2:bin,density_bin_max_agents_per_W2:bin+1,sample_count:group.length,
      included_window_count:new Set(group.map(r=>r.window)).size,included_seed_count:new Set(group.filter(r=>r.seed!=='').map(r=>r.seed)).size,
      speed_median_W_per_s:quantile(speed,.5),speed_q25_W_per_s:quantile(speed,.25),speed_q75_W_per_s:quantile(speed,.75),
      q_median_agents_per_W_s:quantile(flow,.5),q_q25_agents_per_W_s:quantile(flow,.25),q_q75_agents_per_W_s:quantile(flow,.75),
      pooling:'All included windows; simulation seeds pooled as dependent agent-time samples, not independent observations'};
  }).sort((a,b)=>a.method.localeCompare(b.method)||a.density_bin_min_agents_per_W2-b.density_bin_min_agents_per_W2);
}

module.exports={measureFrames,countFramesAtTimes,compareMeasurements,quantile,fdBins,mean};
