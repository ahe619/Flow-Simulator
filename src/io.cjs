'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function valueHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function writeNewJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) throw new Error(`Output already exists: ${file}`);
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {flag: 'wx'});
  fs.renameSync(temporary, file);
}

function reserveOutput(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  for (const suffix of ['', '.tmp', '.receipt.json', '.receipt.json.tmp']) {
    if (fs.existsSync(file + suffix)) {
      throw new Error(`Existing output retained: ${file + suffix}. Choose another output directory.`);
    }
  }
  const lock = file + '.lock';
  const handle = fs.openSync(lock, 'wx');
  fs.writeSync(handle, JSON.stringify({pid: process.pid, createdAt: new Date().toISOString()}));
  return () => {
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  };
}

function verifyCore(coreHashes) {
  for (const [name, expected] of Object.entries(coreHashes)) {
    if (name !== path.basename(name)) throw new Error(`Invalid engine filename: ${name}`);
    if (sha256(path.join(__dirname, 'engine', name)) !== expected) {
      throw new Error(`Engine hash mismatch: ${name}`);
    }
  }
}

function parseArgs(argv, required, optional = []) {
  const args = {};
  const allowed = new Set([...required, ...optional]);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!name.startsWith('--') || !allowed.has(name.slice(2)) || value === undefined || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${name}`);
    }
    if (name.slice(2) in args) throw new Error(`Repeated argument: ${name}`);
    args[name.slice(2)] = value;
  }
  for (const name of required) {
    if (!(name in args)) throw new Error(`Missing --${name}`);
  }
  return args;
}

function sourceHashes() {
  const files = fs.readdirSync(__dirname).filter(name => name.endsWith('.cjs'));
  for (const name of fs.readdirSync(path.join(__dirname, 'engine'))) {
    if (name.endsWith('.js')) files.push(`engine/${name}`);
  }
  return Object.fromEntries(files.sort().map(name => [name, sha256(path.join(__dirname, name))]));
}

module.exports = {readJSON, sha256, valueHash, writeNewJSON, reserveOutput, verifyCore, parseArgs, sourceHashes};
