'use strict';

const path = require('node:path');
const {performance} = require('node:perf_hooks');
const Engine = require('./engine/stadium-macro-engine.js');
const {configFor} = require('./configuration.cjs');
const validation = require('./validation.cjs');
const summary = require('./summary.cjs');
const measure = require('./measurements.cjs');
const io = require('./io.cjs');
const read = io.readJSON;
const sha = io.sha256;
const save = io.writeNewJSON;
const key = time => time.toFixed(7);

function runOne({data, output, camera, seed, method, durationSeconds}) {
  const protocolPath = path.resolve(data, 'protocols', camera + '.json');
  const inputFile = path.resolve(data, 'calibrated_inputs', camera + '.json');
  const refFile = path.resolve(data, 'observed_measurements', camera + '.json');
  const p = read(protocolPath);
  io.verifyCore(p.coreHashes);
  if (!p.cameras.includes(camera) || !p.seeds.includes(seed) || !p.methods.includes(method)) {
    throw new Error('Case is outside the saved protocol');
  }
  const input = read(inputFile);
  const ref = read(refFile);
  if (ref.protocolSha256 !== sha(protocolPath)) throw new Error('Reference protocol hash mismatch');
  const diagnostic = durationSeconds !== undefined;
  const duration = diagnostic ? durationSeconds : input.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0 || duration > input.durationSeconds) {
    throw new Error('Duration must be positive and no longer than the recording');
  }
  const prefix = diagnostic ? `diagnostic__${duration}__` : '';
  const dest = path.resolve(output, 'runs', `${prefix}${camera}__${method}__seed${String(seed).padStart(2, '0')}.json`);
  const receipt = dest + '.receipt.json';
  const release = io.reserveOutput(dest);
  try {
    return execute({p, input, ref, camera, seed, method, duration, diagnostic, dest, receipt,
      protocolPath, inputFile, refFile, codeHashes: io.sourceHashes()});
  } finally {
    release();
  }
}

function execute({p, input, ref, camera, seed, method, duration, diagnostic, dest, receipt,
  protocolPath, inputFile, refFile, codeHashes}) {
  if (diagnostic) {
    // Cropping affects reporting only; the original input horizon and seed
    // draws remain intact so the integration follows the full-run prefix.
    ref.referenceCrossings = ref.referenceCrossings.filter(event => event.time <= duration);
    for (const name of ['timeseries', 'fdPoints', 'counts10s']) {
      ref.measurement[name] = ref.measurement[name].filter(row => row.time <= duration);
    }
  }
  const off = configFor(input, seed, 'feedback_off');
  const on = configFor(input, seed, 'feedback_on');
  const onComparable=structuredClone(on);onComparable.feedbackOn=false;
  if(JSON.stringify(off)!==JSON.stringify(onComparable))throw Error('Paired configuration mismatch');
  class MonitoredEngine extends Engine {
    _advance(h){this._recordProjectedOverlap=true;try{return super._advance(h);}finally{this._recordProjectedOverlap=false;}}
    _overlap(){const value=super._overlap();if(this._recordProjectedOverlap)this.postProjectionOverlapPeak=Math.max(this.postProjectionOverlapPeak??0,value);return value;}
  }
  const config=method==='feedback_off'?off:on,engine=new MonitoredEngine(config),begin=performance.now(),dt=input.sampleIntervalSeconds;
  const phaseTimes=[0,...p.phasesVivian.slice(1).map(s=>s.start*dt).filter(t=>t<duration),duration];
  const times=new Map(),nativeTimes=[];
  for(let i=0;i<=Math.round(duration/dt);i++){const t=Math.min(duration,i*dt);times.set(key(t),t);nativeTimes.push(t);}
  for(let t=0;t<duration;t+=10)times.set(key(t),t);for(const t of phaseTimes)times.set(key(t),t);
  const states=[],samples=[],phaseDiagnostics=[];let nextProgress=120;
  for(const target of [...times.values()].sort((a,b)=>a-b)){
    while(engine.time<target-1e-9){const before=engine.time;engine.step(Math.min(config.dtMax,target-engine.time));if(!(engine.time>before))throw Error('Engine did not advance');}
    const d=engine.metrics();if(Math.abs(engine.time-target)>1e-7)throw Error('Time alignment');
    states.push({time:target,agents:engine.agents.map(a=>({id:a.id,x:a.x,y:a.y,vx:a.vx,vy:a.vy,routeId:a.routeId}))});
    samples.push({time:target,occupancy:d.occupancy,active:d.active,pending:d.pending,requested:d.requested,admitted:d.admitted,exited:d.exited,meanSpeed:d.meanSpeed,agentSubsteps:d.agentSubsteps,feedbackApplied:d.feedbackApplied});
    if(phaseTimes.some(t=>key(t)===key(target)))phaseDiagnostics.push({time:target,agentSubsteps:d.agentSubsteps,feedbackApplied:d.feedbackApplied});
    if(target>=nextProgress){console.log(JSON.stringify({camera,seed,method,elapsedSimulationSeconds:target,percent:Math.round(target/duration*100),wallSeconds:(performance.now()-begin)/1000,active:d.active,pending:d.pending}));nextProgress+=120;}
  }
  const byId=new Map([...config.initialAgents,...config.arrivals].map(a=>[a.id,a]));
  const run={camera,windowId:input.windowId,seed,method,status:'unscored',config,states,samples,phaseDiagnostics,
    elapsedSeconds:(performance.now()-begin)/1000,crossingEvents:engine.crossingEvents,exitEvents:engine.exitEvents,
    admissionEvents:engine.admissionEvents.map(e=>({...e,sourceId:byId.get(e.id)?.sourceId??e.id})),
    initialEvents:config.initialAgents.map(a=>({id:a.id,sourceId:a.sourceId,time:0,x:a.x,y:a.y})),diagnostics:engine.metrics(),
    provenance:{createdAt:new Date().toISOString(),protocolSha256:sha(protocolPath),inputSha256:sha(inputFile),referenceSha256:sha(refFile),runnerSha256:sha(__filename),coreHashes:p.coreHashes,sourceHashes:codeHashes,runType:diagnostic?'diagnostic':'paper_reproduction',requestedDurationSeconds:duration}};
  if(diagnostic){run.runType='diagnostic';run.paperResult=false;}
  run.gate=validation.gateRun(run,method==='feedback_on',0);
  const d=run.diagnostics;d.postProjectionOverlapPeak=engine.postProjectionOverlapPeak??0;
  run.gate.overlapPassed=d.postProjectionOverlapPeak<=p.numericGates.maxOverlapW;
  run.gate.wallPassed=d.maxWallPenetrationAfterProjection<=p.numericGates.maxWallPenetrationW;
  run.gate.supportPassed=d.unsupportedParticlePeak===0;
  run.gate.passed=run.gate.passed&&run.gate.overlapPassed&&run.gate.wallPassed&&run.gate.supportPassed;
  if(!run.gate.passed){run.status='numerical_gate_failed';save(dest,run);save(receipt,{sha256:sha(dest),status:run.status});throw Error('Numerical gate failed; run retained, no tuning');}
  const stateMap=new Map(states.map(f=>[key(f.time),f]));
  run.measurements=measure.measureFrames(nativeTimes.map(t=>stateMap.get(key(t))),input.scene,{dtSeconds:dt,durationSeconds:duration});
  run.measurements.counts10s=measure.countFramesAtTimes(states,input.scene,{durationSeconds:duration,mode:'simulation_exact'});
  run.metrics=measure.compareMeasurements(run.measurements,ref.measurement,run.crossingEvents,ref.referenceCrossings,{durationSeconds:duration,binSeconds:10});
  run.metrics.crossings.bins.forEach((b,i)=>b.referenceComplete=ref.crossingBinCoverage[i].referenceComplete);
  const validBins=run.metrics.crossings.bins.filter(b=>b.referenceComplete);
  for(const direction of ['into','out']){
    run.metrics.crossings.binCountRMSE[direction]=validBins.length?Math.sqrt(validBins.reduce((s,b)=>s+b.signedError[direction]**2,0)/validBins.length):null;
    run.metrics.crossings.binCountMAE[direction]=validBins.length?validBins.reduce((s,b)=>s+b.absoluteError[direction],0)/validBins.length:null;
  }
  run.metrics.crossings.completeReferenceBins=validBins.length;
  run.metrics.crossings.missingnessRule='Crossing-bin error excludes bins touching missing native intervals. Cumulative strict event totals retain only recorded crossings and are not gap-filled.';
  run.summary=summary.summarizeRun(input.windowId,method,seed,run,run.measurements,ref.measurement,run.metrics);
  run.status='scored';save(dest,run);save(receipt,{sha256:sha(dest),status:run.status,createdAt:new Date().toISOString(),elapsedSeconds:run.elapsedSeconds});
  console.log(JSON.stringify({camera,seed,method,status:'complete',elapsedSeconds:run.elapsedSeconds,pressureActivation:d.feedbackAppliedFraction,roiRMSE:run.metrics.wholeRoi.rmse,file:dest}));
  return run;
}

function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    console.log('node src/run_continuous.cjs --data DATA --output OUT --camera A --seed 1 --method feedback_off [--duration SECONDS]');
    console.log('--duration creates a marked diagnostic run, not a paper result. Existing outputs are never overwritten.');
    return;
  }
  const args = io.parseArgs(argv, ['data', 'output', 'camera', 'seed', 'method'], ['duration']);
  if (!/^[A-F]$/.test(args.camera)) throw new Error('Camera must be A, B, C, D, E, or F');
  const seed = Number(args.seed);
  if (!Number.isSafeInteger(seed)) throw new Error('Seed must be an integer');
  runOne({data: args.data, output: args.output, camera: args.camera, seed, method: args.method,
    durationSeconds: args.duration === undefined ? undefined : Number(args.duration)});
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}
module.exports = {runOne, configFor};
