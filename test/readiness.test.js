'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const PowerController = require('../lib/power-controller');
const ui = require('../lib/ui');
const api = require('../api');
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const lookup = (locale, key) => key.split('.').reduce((v, k) => v?.[k], require('../locales/' + locale + '.json'));

function appHarness() {
  const data = { diagnosticLog: ['OLD'], mqttEventHistory: { schema: 1, events: ['keep'] }, unrelated: 'keep' };
  const writes = []; let beforeWrite;
  const settings = { get: key => data[key], set: async (key, value) => {
    if (beforeWrite) await beforeWrite(key, value);
    data[key] = copy(value); writes.push(key);
  } };
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { App: class { log() {} } }
    : id.includes('mqtt-history') ? require('../lib/mqtt-history')
    : id.includes('diagnostic-compactor') ? require('../lib/diagnostic-compactor') : ui, Date, Promise };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), box);
  const create = () => { const app = new box.module.exports(); app.homey = { settings, __: key => lookup('en', key) }; return app; };
  return { app: create(), create, data, writes, set beforeWrite(fn) { beforeWrite = fn; } };
}

test('clearing resets saved diagnostics and cached lines; the next entry never restores old messages', async () => {
  const h = appHarness(); h.app.recordDiag('before'); await h.app.diagnosticWrite;
  await api.clearDiagnostics({ homey: { app: h.app } });
  assert.deepEqual(h.data.diagnosticLog, []);
  h.app.recordDiag('after'); await h.app.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length, 1); assert.match(h.data.diagnosticLog[0], /after$/);
  assert.deepEqual(h.data.mqttEventHistory, { schema: 1, events: ['keep'] });
  assert.equal(h.data.unrelated, 'keep'); assert.ok(h.writes.every(k => k === 'diagnosticLog'));
});

test('clear waits behind an in-flight write and older queued messages, then retains only post-clear events', async () => {
  const h = appHarness(), gate = deferred(); let first = true, completed = false;
  h.beforeWrite = async () => { if (first) { first = false; await gate.promise; } };
  h.app.recordDiag('old one'); h.app.recordDiag('old two'); await flush();
  const clear = h.app.clearDiagnostics().then(() => { completed = true; });
  h.app.recordDiag('new one'); h.app.recordDiag('new two'); await flush();
  assert.equal(completed, false); gate.resolve(); await clear; await h.app.diagnosticWrite;
  assert.deepEqual(h.data.diagnosticLog.map(s => s.slice(25)), ['new one', 'new two']);
});

test('multiple clears serialize, including a clear before the cache is loaded', async () => {
  const h = appHarness(); const a = h.app.clearDiagnostics(); h.app.recordDiag('between');
  const b = h.app.clearDiagnostics(); h.app.recordDiag('last'); await Promise.all([a,b,h.app.diagnosticWrite]);
  assert.equal(h.data.diagnosticLog.length, 1); assert.match(h.data.diagnosticLog[0], /last$/);
});

test('a failed clear reports failure without exposing storage details and a later clear succeeds', async () => {
  const h = appHarness(); h.beforeWrite = async () => { throw Error('PRIVATE_STORAGE_TOKEN'); };
  await assert.rejects(api.clearDiagnostics({ homey: { app: h.app, __: k => lookup('nl', k) } }),
    e => /niet worden gewist/.test(e.message) && !e.message.includes('PRIVATE'));
  assert.deepEqual(h.data.diagnosticLog, ['OLD']);
  h.beforeWrite = null; await h.app.clearDiagnostics();
  h.app.recordDiag('after recovery'); await h.app.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length, 1);
});

test('a failed diagnostic write cannot poison the following clear or later app restart', async () => {
  const h = appHarness(); let fail = true;
  h.beforeWrite = async () => { if (fail) { fail = false; throw Error('PRIVATE'); } };
  h.app.recordDiag('failed'); await h.app.diagnosticWrite; await h.app.clearDiagnostics();
  const restarted = h.create(); restarted.recordDiag('new run'); await restarted.diagnosticWrite;
  assert.equal(h.data.diagnosticLog.length, 1); assert.match(h.data.diagnosticLog[0], /new run$/);
});

test('shutdown waits for the final diagnostic clear to finish', async () => {
  const h = appHarness(), gate = deferred(); let done = false;
  h.beforeWrite = async () => gate.promise;
  const clear = h.app.clearDiagnostics(); const stop = h.app.onUninit().then(() => { done = true; });
  await flush(); assert.equal(done, false); gate.resolve(); await Promise.all([clear, stop]);
  assert.deepEqual(h.data.diagnosticLog, []);
});

function deviceHarness(locale = 'en') {
  const warnings = [];
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { Device: class {} }
    : id === '../../lib/ui' ? ui : id.includes('power-controller') ? PowerController
      : id.includes('/auth') ? require('../lib/auth') : {}, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next/device.js'), 'utf8'), box);
  const device = new box.module.exports(); device.warningQueue = Promise.resolve();
  device.diag = () => {}; device.homey = { __: key => lookup(locale, key) };
  device.setWarning = async message => { warnings.push(message); };
  device.unsetWarning = async () => { warnings.push(null); };
  device.power = { connected: true, tx: null };
  return { device, warnings };
}

for (const locale of ['en','nl']) test('begin-status warning is localized and gives a concrete safe next step: ' + locale, async () => {
  const h = deviceHarness(locale); h.device.powerDiagnostic('connection.ready', {});
  await h.device.warningQueue;
  assert.equal(h.warnings.at(-1), lookup(locale, 'status.waiting'));
  assert.match(h.warnings.at(-1), /Ziggo/);
  h.device.powerDiagnostic('status.initialCandidate', {}); await h.device.warningQueue;
  assert.equal(h.warnings.at(-1), lookup(locale, 'status.waiting'));
  h.device.powerDiagnostic('status.accepted', {}); await h.device.warningQueue;
  assert.equal(h.warnings.at(-1), null);
});

test('disconnected, expired and uncertain states have distinct warnings and ignore raw failure details', async () => {
  const h = deviceHarness();
  for (const [event, key] of [['connection.lost','disconnected'],['initialization.waiting','pending'],
    ['initialization.cancelled','expired'],['restore.uncertain','uncertain'],['transition.failed','commandFailed']]) {
    h.device.powerDiagnostic(event, { reason: 'PRIVATE_RAW_ERROR' }); await h.device.warningQueue;
    assert.equal(h.warnings.at(-1), lookup('en', 'status.' + key));
    assert.ok(!h.warnings.at(-1).includes('PRIVATE'));
  }
});

test('clearer warnings do not permit Power on retained status or replay an expired request', async () => {
  const h = deviceHarness('nl'); let timeout, sends = 0;
  h.device.power = new PowerController({ timers: { setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {} },
    prepare: async () => async () => { sends++; }, journal: async () => {},
    log: (event, fields) => h.device.powerDiagnostic(event, fields) });
  const power = h.device.power; power.connect(1); power.observe(false, { generation: 1, retain: true });
  const request = power.request(true); const rejected = assert.rejects(request, /Power is niet verstuurd/);
  await flush(); assert.equal(sends, 0); timeout(); await rejected; await h.device.warningQueue;
  assert.equal(h.warnings.at(-1), lookup('nl', 'status.expired'));
  power.observe(false, { generation: 1 }); await flush();
  assert.equal(sends, 0); assert.equal(h.warnings.at(-1), null); power.close();
});

test('a late warning cannot overwrite accepted live status; deleted devices receive no new warnings', async () => {
  const h = deviceHarness(); h.device.powerDiagnostic('connection.ready', {});
  h.device.powerDiagnostic('status.accepted', {}); await h.device.warningQueue;
  assert.equal(h.warnings.at(-1), null);
  const count = h.warnings.length; h.device.deleted = true; h.device.powerDiagnostic('connection.lost', {});
  await h.device.warningQueue; assert.equal(h.warnings.length, count);
});

test('protected clear endpoint awaits completion and cannot mutate other app data', async () => {
  const manifest = require('../.homeycompose/app.json');
  assert.deepEqual(manifest.api.clearDiagnostics, { method: 'POST', path: '/diagnostics/clear', public: false });
  const gate = deferred(); let completed = false;
  const request = api.clearDiagnostics({ homey: { app: { clearDiagnostics: () => gate.promise } } }).then(v => { completed = true; return v; });
  await flush(); assert.equal(completed, false); gate.resolve(); assert.deepEqual(await request, { cleared: true });
});

test('English and Dutch translation keys match and all UI translation references resolve', () => {
  const en = require('../locales/en.json'), nl = require('../locales/nl.json');
  const flatten = (value, prefix = '') => Object.entries(value).flatMap(([k,v]) =>
    typeof v === 'string' ? [prefix + k] : flatten(v, prefix + k + '.'));
  assert.deepEqual(flatten(en).sort(), flatten(nl).sort());
  for (const file of ['settings/index.html','drivers/ziggo_next/pair/ziggo_login.html','drivers/ziggo_next/repair/ziggo_repair.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const keys = [...html.matchAll(/data-i18n="([^"]+)"|(?:Homey\.__|tr)\('([^']+)'\)/g)].map(m => m[1] || m[2]);
    assert.ok(keys.length > 5);
    for (const key of keys) for (const locale of ['en','nl']) assert.equal(typeof lookup(locale, key), 'string', file + ': ' + key);
  }
});

test('user-facing error translation preserves authentication categories and hides unexpected raw messages', () => {
  const homey = { __: key => lookup('en', key) };
  const translated = ui.userError(homey, Object.assign(Error('PRIVATE_TOKEN'), { kind: 'refresh_uncertain', phase: 'refresh', requiresRepair: true }));
  assert.equal(translated.kind, 'refresh_uncertain'); assert.equal(translated.requiresRepair, true);
  assert.equal(translated.message, lookup('en', 'auth.refresh_uncertain'));
  assert.ok(!ui.userError(homey, Error('PRIVATE_TOKEN')).message.includes('PRIVATE'));
});

test('settings clear disables repeated clicks, waits for API success and shows a localized failure', () => {
  const elements = new Map(), calls = [], alerts = [];
  const element = id => { if (!elements.has(id)) elements.set(id, { value: '', focus() {}, select() {} }); return elements.get(id); };
  const box = { document: { getElementById: element }, navigator: {} };
  const homey = { ready() {}, __: key => lookup('nl', key), alert: message => alerts.push(message),
    get: (_, cb) => cb(null, []), api: (...args) => calls.push(args) };
  const html = fs.readFileSync(path.join(__dirname, '../settings/index.html'), 'utf8');
  vm.runInNewContext(html.match(/<script>\s*([\s\S]*?)<\/script>/)[1], box); box.onHomeyReady(homey);
  element('clear').onclick(); element('clear').onclick(); assert.equal(calls.length, 1);
  assert.equal(element('clear').disabled, true);
  calls[0][3](Error('PRIVATE_STORAGE')); assert.equal(element('clear').disabled, false);
  assert.deepEqual(alerts, [lookup('nl', 'settings.clearFailed')]);
});

for (const locale of ['en','nl']) for (const mode of ['pair','repair']) {
  test(mode + ' view validates input, completes the mocked flow and clears its password: ' + locale, async () => {
    const elements = new Map(), requests = [], titles = []; let done = 0, added = 0, click;
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', addEventListener: (_, fn) => { click = fn; } });
      return elements.get(id);
    };
    const homey = { __: key => lookup(locale, key), setTitle: title => titles.push(title),
      emit: async (event, body) => { requests.push({ event, body }); return { data: { id: 'synthetic' } }; },
      createDevice: async () => { added++; }, done: async () => { done++; } };
    const file = mode === 'pair' ? 'pair/ziggo_login.html' : 'repair/ziggo_repair.html';
    const html = fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next', file), 'utf8');
    const box = { Homey: homey, document: { getElementById: element } };
    vm.runInNewContext(html.match(/<script type="application\/javascript">([\s\S]*?)<\/script>/)[1], box);
    click(); assert.equal(requests.length, 0); assert.equal(element('status').textContent, lookup(locale, 'login.required'));
    element('username').value = 'synthetic@example.invalid'; element('password').value = 'SYNTHETIC_PASSWORD';
    click(); await flush();
    assert.equal(requests.length, 1); assert.equal(requests[0].event, mode + '_ziggo');
    assert.equal(done, 1); assert.equal(added, mode === 'pair' ? 1 : 0);
    assert.equal(element('password').value, ''); assert.equal(titles[0], lookup(locale, mode + '.title'));
    assert.equal(element('status').textContent, lookup(locale, mode + '.done'));
  });
  test(mode + ' view hides raw errors and clears its password after failure: ' + locale, async () => {
    const elements = new Map(); let click;
    const element = id => {
      if (!elements.has(id)) elements.set(id, { value: '', addEventListener: (_, fn) => { click = fn; } });
      return elements.get(id);
    };
    const homey = { __: key => lookup(locale, key), setTitle() {}, emit: async () => { throw Error('PRIVATE_SERVER_TOKEN'); } };
    const file = mode === 'pair' ? 'pair/ziggo_login.html' : 'repair/ziggo_repair.html';
    const html = fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next', file), 'utf8');
    vm.runInNewContext(html.match(/<script type="application\/javascript">([\s\S]*?)<\/script>/)[1], { Homey: homey, document: { getElementById: element } });
    element('username').value = 'synthetic@example.invalid'; element('password').value = 'SYNTHETIC_PASSWORD';
    click(); await flush();
    assert.equal(element('password').value, ''); assert.equal(element(mode).disabled, false);
    assert.equal(element('status').textContent, lookup(locale, mode + '.failed'));
    assert.ok(!element('status').textContent.includes('PRIVATE'));
  });
}
