'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MqttHistory, KEY } = require('../lib/mqtt-history');
const clone = v => JSON.parse(JSON.stringify(v));
const fields = { monitor: 1, generation: 1, attempt: 1 };
function harness() {
  const data = {}, writes = [], device = {};
  const settings = { get: key => data[key], set: async (key, value) => {
    writes.push(key); data[key] = clone(value);
  } };
  return { data, writes, device, settings, history: new MqttHistory(settings) };
}

test('history is independent, bounded to newest 50 and restored across app restarts', async () => {
  const h = harness(); h.data.diagnosticLog = ['unchanged'];
  for (let i = 1; i <= 120; i++) h.history.record(h.device, 'connected', { ...fields, generation: i });
  await h.history.flush();
  assert.equal(h.data[KEY].events.length, 50);
  assert.equal(h.data[KEY].events[0].generation, 71);
  assert.equal(h.data[KEY].events.at(-1).generation, 120);
  assert.deepEqual(h.data.diagnosticLog, ['unchanged']);
  const restarted = new MqttHistory(h.settings);
  assert.equal(restarted.lines.length, 50);
  restarted.record({}, 'monitor.start', fields); await restarted.flush();
  assert.notEqual(h.data[KEY].events.at(-1).run, h.data[KEY].events[0].run);
  assert.equal(h.data[KEY].events.length, 50);
  h.data.diagnosticLog = []; assert.equal(restarted.lines.length, 50);
});

test('closed schema drops all secrets, error text, payloads, identifiers and invalid records', async () => {
  const h = harness();
  h.history.record(h.device, 'error', { ...fields, token: 'SECRET', cookies: 'SECRET',
    payload: 'SECRET', topic: 'SECRET', message: 'SECRET', device: 'SECRET', run: 'SECRET', time: 'SECRET' });
  h.history.record(h.device, 'SECRET', fields);
  h.history.record(h.device, 'connected', { ...fields, generation: 'SECRET' });
  await h.history.flush();
  assert.equal(h.data[KEY].events.length, 1);
  assert.ok(!JSON.stringify(h.data).includes('SECRET'));
  const saved = h.data[KEY].events[0];
  assert.deepEqual(Object.keys(saved).sort(), ['time','run','event','device','monitor','generation','attempt'].sort());
  h.data[KEY].events.push({ ...saved, token: 'SECRET' }, { ...saved, run: 'SECRET' }, { ...saved, time: 'SECRET' });
  const restarted = new MqttHistory(h.settings);
  assert.equal(restarted.lines.length, 2); assert.ok(!JSON.stringify(restarted.lines).includes('SECRET'));
});

test('malformed or unsupported persisted history is ignored without touching authentication', () => {
  for (const value of [null, false, 'SECRET', [], { schema: 99, events: [] }, { schema: 1, events: 'SECRET' }]) {
    const reads = [];
    const history = new MqttHistory({ get: key => { reads.push(key); return value; } });
    assert.equal(history.lines.length, 0); assert.deepEqual(reads, [KEY]);
  }
});

test('read and write failures cannot escape and a later event retries the complete bounded snapshot', async () => {
  let fail = true, stored;
  const h = new MqttHistory({ get() { throw Error('SECRET'); }, set: async (_, value) => {
    if (fail) throw Error('SECRET'); stored = clone(value);
  } });
  const device = {};
  h.record(device, 'offline', fields); await h.flush(); assert.equal(h.failed, true);
  fail = false; h.record(device, 'close', fields); await h.flush();
  assert.equal(h.failed, false); assert.deepEqual(stored.events.map(e => e.event), ['offline', 'close']);
});

test('event storm with delayed storage has one writer and coalesces to a bounded latest snapshot', async () => {
  let release, active = 0, max = 0, writes = 0, saved;
  const gate = new Promise(r => { release = r; });
  const h = new MqttHistory({ get() {}, set: async (_, value) => {
    writes++; active++; max = Math.max(max, active); await gate; saved = clone(value); active--;
  } });
  const device = {};
  for (let i = 0; i < 5000; i++) h.record(device, 'reconnect', { ...fields, attempt: i });
  assert.equal(h.lines.length, 50); assert.equal(writes, 1);
  release(); await h.flush(); assert.equal(max, 1); assert.equal(writes, 2);
  assert.equal(saved.events.at(-1).attempt, 4999);
});

test('multiple devices have anonymous run-scoped numbers without physical identifiers', async () => {
  const h = harness(); const other = {};
  h.history.record(h.device, 'connected', fields); h.history.record(other, 'connected', fields);
  h.history.record(h.device, 'ready', fields); await h.history.flush();
  assert.deepEqual(h.data[KEY].events.map(e => e.device), [1,2,1]);
});

test('event arriving between write completion and finalizer is persisted without needing another event', async () => {
  const h = harness();
  h.history.record(h.device, 'connected', fields);
  await Promise.resolve();
  h.history.record(h.device, 'ready', fields);
  await h.history.flush();
  assert.deepEqual(h.data[KEY].events.map(e => e.event), ['connected', 'ready']);
});

test('actual app stores history separately, preserves it when diagnosticLog is reset and flushes on shutdown', async () => {
  const h = harness();
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { App: class {} }
    : require('../lib/mqtt-history'), Date, Promise };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), box);
  const app = new box.module.exports(); app.homey = { settings: h.settings };
  app.recordMqttEvent(h.device, 'connected', fields); app.recordDiag('test');
  await app.diagnosticWrite; await app.onUninit();
  h.data.diagnosticLog = []; app.recordMqttEvent(h.device, 'ready', fields); await app.onUninit();
  assert.equal(h.data[KEY].events.length, 2);
});

test('settings view refresh and copy only read MQTT history; diagnostic reset targets only diagnosticLog', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', focus() {}, select() {} });
    return elements.get(id);
  };
  const reads = [], writes = [], copies = [];
  const homey = { ready() {}, alert() {}, get(key, cb) { reads.push(key); cb(null, key === KEY ? { schema: 1, events: [] } : []); },
    set(key, value, cb) { writes.push(key); cb(null); } };
  const box = { document: { getElementById: element }, navigator: { clipboard: { writeText: async text => copies.push(text) } } };
  vm.runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], box);
  box.onHomeyReady(homey); element('mqtt-refresh').onclick(); await element('mqtt-copy').onclick();
  assert.equal(reads.filter(key => key === KEY).length, 2); assert.equal(writes.length, 0);
  assert.equal(JSON.parse(copies[0]).schema, 1);
  element('clear').onclick(); assert.deepEqual(writes, ['diagnosticLog']);
});
