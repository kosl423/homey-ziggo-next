'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { DiagnosticCompactor } = require('../lib/diagnostic-compactor');
const epoch = Date.parse('2026-11-08T18:01:00.000Z');
const auth = (event, data) => 'AUTH ' + event + ' ' + JSON.stringify(data);
function cycle(revision = 2) {
  const rejection = { phase: 'mqtt_token', kind: 'access_rejected', status: 401, requiresRepair: false };
  return [
    auth('auth.request', { phase: 'config' }), auth('auth.request.succeeded', { phase: 'config', status: 200 }),
    auth('auth.request', { phase: 'mqtt_token' }), auth('auth.request.failed', rejection), auth('auth.access.rejected', rejection),
    auth('auth.session.persisted', { phase: 'refresh_intent', revision: revision - 1 }),
    auth('auth.request', { phase: 'refresh' }), auth('auth.request.succeeded', { phase: 'refresh', status: 200 }),
    auth('auth.refresh.received', { phase: 'refresh' }), auth('auth.session.persisted', { phase: 'refresh', revision }),
    auth('auth.request', { phase: 'mqtt_token' }), auth('auth.request.succeeded', { phase: 'mqtt_token', status: 200 }),
    auth('auth.session.verified', { phase: 'mqtt_token', revision }), auth('auth.watchdog.succeeded', { phase: 'watchdog' }),
  ];
}
const summary = line => JSON.parse(line.slice(line.indexOf('{')));
function add(compactor, lines, message, milliseconds = epoch) {
  compactor.append(lines, message, new Date(milliseconds).toISOString());
  while (lines.length > 250) lines.shift();
}
function harness(seed = []) {
  let now = epoch, hook;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } }
  const data = { diagnosticLog: seed, mqttEventHistory: { schema: 1, events: ['keep'] }, unrelated: 'keep' };
  const writes = [];
  const settings = { get: key => data[key], set: async (key, value) => { if (hook) await hook(); data[key] = JSON.parse(JSON.stringify(value)); writes.push(key); } };
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { App: class { log() {} } } : require(path.join(__dirname, '..', id)), Date: Clock, Promise };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), box);
  const create = () => { const app = new box.module.exports(); app.homey = { settings }; return app; };
  return { app: create(), create, data, writes, time: value => { now = value; }, hook: fn => { hook = fn; } };
}

test('a complete recovered watchdog cycle preserves all event counts in one durable summary', async () => {
  const h = harness(); for (const message of cycle()) h.app.recordDiag(message);
  await h.app.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length, 1);
  const value = summary(h.data.diagnosticLog[0]);
  assert.equal(Object.values(value.counts).reduce((a,b) => a+b), 14);
  assert.equal(value.counts.request401, 1); assert.equal(value.counts.accessRejected, 1);
  assert.equal(value.counts.refreshReceived, 1); assert.equal(value.counts.sessionVerified, 1);
  assert.equal(value.counts.watchdogSucceeded, 1); assert.equal(value.counts['request.mqtt_token'], 2);
  assert.equal(value.revisionMin, 1); assert.equal(value.revisionMax, 2);
  assert.deepEqual(h.data.mqttEventHistory, { schema: 1, events: ['keep'] });
  assert.ok(h.writes.every(key => key === 'diagnosticLog'));
});

test('partial or failed refresh cannot be mistaken for a completed successful cycle', async () => {
  const h = harness(); for (const message of cycle().slice(0, 7)) h.app.recordDiag(message);
  h.app.recordDiag(auth('auth.request.failed', { phase: 'refresh', kind: 'timeout', status: null, requiresRepair: false }));
  h.app.recordDiag(auth('auth.refresh.uncertain', { phase: 'refresh', kind: 'timeout', requiresRepair: false }));
  await h.app.diagnosticWrite;
  const value = summary(h.data.diagnosticLog[0]);
  assert.equal(value.counts.request401, 1); assert.equal(value.counts.watchdogSucceeded, undefined);
  assert.equal(value.counts.refreshReceived, undefined); assert.equal(h.data.diagnosticLog.length, 3);
  assert.match(h.data.diagnosticLog[1], /"timeout"/); assert.match(h.data.diagnosticLog[2], /auth.refresh.uncertain/);
});

test('critical, unexpected, malformed and new-schema events remain individual unchanged entries', () => {
  const c = new DiagnosticCompactor(), lines = [];
  const inputs = [
    'POWER transition.failed {"reason":"timeout"}', 'STATUS close', 'WATCHDOG failed', 'APP started',
    auth('auth.request.failed', { phase:'mqtt_token',kind:'server',status:503,requiresRepair:false }),
    auth('auth.request.failed', { phase:'refresh',kind:'refresh_rejected',status:401,requiresRepair:true }),
    auth('auth.storage.failed', { phase:'refresh',revision:4 }),
    auth('auth.request', { phase:'config',diagnosticTag:'new information' }),
    auth('auth.request.succeeded', { phase:'mqtt_token',status:202 }),
    auth('auth.request', { phase:'repair' }), 'AUTH auth.request {bad json}', 'AUTH auth.request []',
  ];
  for(const message of inputs)add(c,lines,message);
  assert.deepEqual(lines.map(line=>line.slice(25)),inputs);
});

test('same bucket counts multiple checks; a UTC boundary starts a separate summary', () => {
  const c = new DiagnosticCompactor(), lines = [];
  for(const message of cycle())add(c,lines,message,epoch);
  for(const message of cycle(4))add(c,lines,message,epoch+60000);
  assert.equal(lines.length,1); assert.equal(summary(lines[0]).counts.watchdogSucceeded,2);
  add(c,lines,cycle()[0],Date.parse('2026-11-08T18:10:00Z'));
  assert.equal(lines.length,2); assert.equal(summary(lines[1]).counts['request.config'],1);
  assert.equal(summary(lines[0]).from,new Date(epoch).toISOString());
  assert.equal(summary(lines[0]).to,new Date(epoch+60000).toISOString());
});

test('Power events interleaved with auth remain intact and chronological by first occurrence', () => {
  const c=new DiagnosticCompactor(),lines=[];
  add(c,lines,cycle()[0]);add(c,lines,'POWER status.accepted {"value":false}',epoch+20);
  for(const message of cycle().slice(1))add(c,lines,message,epoch+30);
  assert.equal(lines.length,2);assert.match(lines[1],/POWER status.accepted/);
  assert.equal(summary(lines[0]).counts.watchdogSucceeded,1);assert.equal(summary(lines[0]).to,new Date(epoch+30).toISOString());
});

test('an incomplete group is already persisted before shutdown; shutdown waits for its write', async () => {
  const h=harness();let release,done=false;const gate=new Promise(r=>{release=r;});h.hook(()=>gate);
  h.app.recordDiag(cycle()[0]);const stop=h.app.onUninit().then(()=>{done=true;});
  await Promise.resolve();assert.equal(done,false);release();await stop;
  assert.equal(summary(h.data.diagnosticLog[0]).counts['request.config'],1);
});

test('clear serializes existing summaries and resets counts before subsequent entries', async () => {
  const h=harness(['OLD']);let release;const gate=new Promise(r=>{release=r;});let first=true;
  h.hook(()=>{if(first){first=false;return gate;}});
  for(const message of cycle())h.app.recordDiag(message);
  const clear=h.app.clearDiagnostics();h.app.recordDiag(cycle()[0]);release();await clear;await h.app.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length,1);const value=summary(h.data.diagnosticLog[0]);
  assert.equal(value.counts['request.config'],1);assert.equal(value.counts.watchdogSucceeded,undefined);
  assert.equal(h.data.unrelated,'keep');assert.deepEqual(h.data.mqttEventHistory,{schema:1,events:['keep']});
});

test('restart retains old/compact records but never merges into a previous app instance', async () => {
  const h=harness(['LEGACY']);for(const message of cycle())h.app.recordDiag(message);await h.app.diagnosticWrite;
  const old=h.data.diagnosticLog[1],next=h.create();next.recordDiag(cycle()[0]);await next.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length,3);assert.equal(h.data.diagnosticLog[0],'LEGACY');assert.equal(h.data.diagnosticLog[1],old);
  assert.equal(summary(h.data.diagnosticLog[2]).counts.watchdogSucceeded,undefined);
});

test('failed writes do not poison clearing or later summary persistence', async () => {
  const h=harness();let fail=true;h.hook(()=>{if(fail){fail=false;throw Error('synthetic storage failure');}});
  h.app.recordDiag(cycle()[0]);await h.app.diagnosticWrite;await h.app.clearDiagnostics();
  h.app.recordDiag(cycle()[0]);await h.app.diagnosticWrite;assert.equal(h.data.diagnosticLog.length,1);
  assert.equal(summary(h.data.diagnosticLog[0]).counts['request.config'],1);
});

test('identical partial summaries at the same timestamp after restart never rewrite the earlier record', async () => {
  const h=harness();h.app.recordDiag(cycle()[0]);await h.app.diagnosticWrite;
  const first=h.data.diagnosticLog[0],next=h.create();next.recordDiag(cycle()[0]);next.recordDiag(cycle()[1]);await next.diagnosticWrite;
  assert.equal(h.data.diagnosticLog[0],first);assert.equal(h.data.diagnosticLog.length,2);
  assert.equal(summary(h.data.diagnosticLog[1]).counts['success.config.200'],1);
});

test('busy logs remain bounded and evicted summary references cannot overwrite later events', () => {
  const c=new DiagnosticCompactor(),lines=[];add(c,lines,cycle()[0]);
  for(let i=0;i<300;i++)add(c,lines,'POWER event '+i,epoch+10);
  const last=lines.at(-1);add(c,lines,cycle()[0],epoch+20);
  assert.equal(lines.length,250);assert.equal(lines.at(-2),last);
  assert.equal(summary(lines.at(-1)).counts['request.config'],1);
});

test('a clock rollback creates a new range instead of a backwards or misleading interval', () => {
  const c=new DiagnosticCompactor(),lines=[];add(c,lines,cycle()[0],epoch+10);add(c,lines,cycle()[0],epoch);
  assert.equal(lines.length,2);for(const line of lines){const s=summary(line);assert.ok(s.from<=s.to);}
});

test('16 simulated overnight hours keep all 96 recovered checks and 64 Power events within 250 entries', async () => {
  const h=harness();
  for(let i=0;i<96;i++){
    h.time(epoch+i*600000);for(const message of cycle(i*2+2))h.app.recordDiag(message);
    if(i%6===0)for(let j=0;j<4;j++)h.app.recordDiag('POWER status.accepted '+JSON.stringify({value:j%2===0}));
  }
  await h.app.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length,160);
  const summaries=h.data.diagnosticLog.filter(s=>s.includes('AUTH summary '));assert.equal(summaries.length,96);
  assert.equal(summaries.reduce((n,s)=>n+(summary(s).counts.watchdogSucceeded||0),0),96);
  assert.equal(summaries.reduce((n,s)=>n+(summary(s).counts.request401||0),0),96);
  assert.equal(h.data.diagnosticLog.filter(s=>s.includes('POWER status.accepted')).length,64);
  assert.equal(summary(summaries[0]).from,new Date(epoch).toISOString());
});
