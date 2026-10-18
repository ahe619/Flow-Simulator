'use strict';
const crypto=require('node:crypto');
const DOMAIN='stadium-grid-phase-v4';
function hashWord(seed,axis){
  if(!Number.isSafeInteger(seed)||seed<0)throw new RangeError('seed must be a nonnegative safe integer');
  if(!['x','y'].includes(axis))throw new RangeError('axis must be x or y');
  return crypto.createHash('sha256').update(JSON.stringify([DOMAIN,seed,axis])).digest().readUInt32LE(0);
}
function gridPhase(seed,h){
  if(!Number.isFinite(h)||h<=0)throw new RangeError('grid size must be finite and positive');
  return ['x','y'].map(axis=>hashWord(seed,axis)/4294967296*h);
}
module.exports={DOMAIN,hashWord,gridPhase};
