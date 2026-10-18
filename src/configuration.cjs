'use strict';
// Configuration and seed draws used by the recorded six-tunnel experiment.
const crypto = require('node:crypto');
const {gridPhase} = require('./grid_phase.cjs');

function engineConfig(input, feedbackOn, shift = false) {
  if (!(input.durationSeconds > 0)) throw new RangeError('durationSeconds required');
  const cfg = {...structuredClone(input.parameters || {}), scene: structuredClone(input.scene),
    initialAgents: structuredClone(input.initialAgents), arrivals: structuredClone(input.arrivals),
    maxTime: input.durationSeconds, feedbackOn, stopWhenDrained: false};
  if (shift) {
    if (!(cfg.pressureGridSize > 0)) throw new RangeError('explicit positive pressureGridSize required for origin check');
    const origin = cfg.pressureGridOrigin || [0, 0];
    cfg.pressureGridOrigin = origin.map(x => x + cfg.pressureGridSize / 2);
  }
  return cfg;
}

function uniform(windowId, seed, agent, purpose) {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new RangeError('invalid seed');
  const identity = agent.sourceId ?? agent.id;
  if (identity === undefined || identity === null) throw new TypeError('missing source identity');
  const bytes = crypto.createHash('sha256').update(JSON.stringify(['stadium-macro-v3', windowId, seed, typeof identity, identity, purpose])).digest();
  return bytes.readUInt32LE(0) / 4294967296;
}

function configFor(input,seed,method){
  const cfg=engineConfig(input,method==='feedback_on');cfg.individualSpeedLimit=true;cfg.seed=seed;
  cfg.pressureGridOrigin=gridPhase(seed,cfg.pressureGridSize);
  const observations=input.rollingSpeedObservations,draws=[];
  for(const list of [cfg.initialAgents,cfg.arrivals])for(const a of list){
    const isArrival=list===cfg.arrivals,nominal=a.time;
    if(isArrival){const [lo,hi]=a.timeBracket;if(!(lo>=0&&hi>=lo&&hi<=input.durationSeconds+1e-8))throw Error('Invalid bracket');
      a.time=lo+uniform(input.windowId,seed,a,'arrival-time')*(hi-lo);}
    let source='individual_history',poolIndex=null,eligible=[];
    if(a.speed===null||a.speed===undefined){
      if(isArrival)eligible=observations.filter(r=>r.time>=a.time-60&&r.time<=a.timeBracket[0]);
      poolIndex=eligible.length?Math.floor(uniform(input.windowId,seed,a,'empirical-speed')*eligible.length):null;
      a.speed=poolIndex===null?.03:eligible[poolIndex].speed;
      source=poolIndex===null?'sparse_pool_floor_fallback':'sampled_rolling_pre60s_empirical';
    }
    if(!(a.speed>=.03&&Number.isFinite(a.speed)))throw Error('Invalid v0');
    const chosen=poolIndex===null?null:eligible[poolIndex];
    if(chosen&&(chosen.time>a.timeBracket[0]||chosen.time<a.time-60))throw Error('Speed lookahead');
    draws.push({id:a.id,sourceId:a.sourceId,speed:a.speed,speedSource:source,poolIndex,poolSize:eligible.length,
      selectedObservation:chosen,nominalArrivalTime:nominal,jitteredArrivalTime:a.time,timeBracket:a.timeBracket});
  }
  cfg.arrivals.sort((a,b)=>a.time-b.time||String(a.id).localeCompare(String(b.id)));
  cfg.randomization={version:'continuous_v1',seed,pairedAcrossMethods:true,draws,
    empiricalSpeedDrawCount:draws.filter(d=>d.speedSource==='sampled_rolling_pre60s_empirical').length,
    sparsePoolFallbackCount:draws.filter(d=>d.speedSource==='sparse_pool_floor_fallback').length};
  return cfg;
}

module.exports = {engineConfig, uniform, configFor};
