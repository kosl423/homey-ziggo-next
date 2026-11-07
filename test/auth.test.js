'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { AuthClient, SessionManager, AuthError, STORE_KEY } = require('../lib/auth');
global.fetch = () => { throw new Error('Live HTTP forbidden in authentication tests'); };
const copy = value => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const old = { username: 'PRIVATE_USERNAME', householdId: 'PRIVATE_HOUSEHOLD', accessToken: 'PRIVATE_ACCESS_OLD', refreshToken: 'PRIVATE_REFRESH_OLD', hashedCustomerId: 'PRIVATE_CUSTOMER', cookieHeader: 'sid=PRIVATE_COOKIE_OLD' };
const fresh = { username: old.username, householdId: old.householdId, accessToken: 'PRIVATE_ACCESS_NEW', refreshToken: 'PRIVATE_REFRESH_NEW' };
const config = { authorizationService: { URL: 'https://auth.example.invalid' }, personalizationService: { URL: 'https://devices.example.invalid' } };
const reply = (status, data, cookies = []) => ({ status, ok: status >= 200 && status < 300,
  text: async () => typeof data === 'string' ? data : JSON.stringify(data),
  headers: { getSetCookie: () => cookies, get: name => name === 'content-type' ? 'application/json' : null },
});

function harness(responder, seed = old) {
  const data = copy(seed), events = [], calls = [], writes = [], timers = new Map();
  let serial = 0, clock = 0;
  const diagnostic = (event, fields) => events.push({ event, ...fields });
  const timerApi = { setTimeout: (fn, ms) => { const id = ++serial; timers.set(id, { fn, at: clock + ms, ms }); return id; }, clearTimeout: id => timers.delete(id) };
  const h = { data, events, calls, writes, timers, timerApi, diagnostic,
    now: () => clock, setClock: value => { clock = value; },
    advance: async ms => { clock += ms; for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } await flush(); },
  };
  h.storage = { get: key => data[key], set: async (key, value) => {
    if (h.beforeWrite) await h.beforeWrite(key, value);
    data[key] = copy(value); writes.push({ key, value: copy(value) });
  } };
  h.client = new AuthClient({ timers: timerApi, diagnostic, fetch: async (url, options) => {
    const phase = url.endsWith('backoffice.json') ? 'config' : url.endsWith('/v1/authorization/refresh') ? 'refresh'
      : url.endsWith('/v1/mqtt/token') ? 'mqtt' : url.endsWith('/v1/authorization') ? 'login' : 'devices';
    assert.ok(url.includes('example.invalid') || url.endsWith('/config-service/conf/web/backoffice.json'));
    calls.push({ phase, options }); return responder(phase, options, h);
  } });
  h.manager = new SessionManager({ client: h.client, storage: h.storage, diagnostic, now: () => '2026-10-30T00:00:00.000Z' });
  return h;
}

function normal(phase, options) {
  if (phase === 'config') return reply(200, config);
  if (phase === 'refresh') return reply(200, fresh, ['sid=PRIVATE_COOKIE_NEW; Path=/']);
  if (phase === 'mqtt') return options.headers['X-OESP-Token'] === old.accessToken
    ? reply(401, { error: 'invalid_token' }) : reply(200, { token: 'PRIVATE_MQTT_TOKEN' });
  throw new Error('Unexpected synthetic request');
}

test('normal rotation persists one complete session record before MQTT request', async () => {
  const h = harness((phase, options, state) => {
    if (phase === 'mqtt' && options.headers['X-OESP-Token'] === fresh.accessToken) {
      assert.equal(state.data[STORE_KEY].session.refreshToken, fresh.refreshToken);
      assert.equal(state.data[STORE_KEY].cookies, 'sid=PRIVATE_COOKIE_NEW');
      assert.equal(state.data[STORE_KEY].refreshState, null);
    }
    return normal(phase, options);
  });
  const result = await h.manager.ensure(config);
  assert.equal(result.persisted, true); assert.equal(result.refreshed, false);
  assert.equal(h.data[STORE_KEY].revision, 1);
  assert.ok(h.writes.every(write => write.key === STORE_KEY));
  assert.deepEqual(h.calls.map(call => call.phase), ['mqtt', 'refresh', 'mqtt']);
  assert.equal(h.data.refreshToken, old.refreshToken); // Legacy fields are not partially overwritten.
});

test('MQTT 500 does not rotate tokens and a subsequent GET recovers', async () => {
  let fail = true;
  const h = harness(() => fail ? reply(500, 'PRIVATE_SERVER_BODY') : reply(200, { token: 'PRIVATE_MQTT_TOKEN' }));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'server' && !error.requiresRepair);
  assert.equal(h.data[STORE_KEY].refreshState, null);
  fail = false; await h.manager.ensure(config);
  assert.deepEqual(h.calls.map(call => call.phase), ['mqtt', 'mqtt']);
});

test('rotated credentials survive a failed MQTT request and recover without another refresh', async () => {
  let failNewMqtt = true;
  const h = harness((phase, options) => phase === 'mqtt' && options.headers['X-OESP-Token'] === fresh.accessToken && failNewMqtt
    ? reply(503, { message: 'PRIVATE_SERVER_BODY' }) : normal(phase, options));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'server' && error.phase === 'mqtt_token');
  assert.equal(h.data[STORE_KEY].session.refreshToken, fresh.refreshToken);
  failNewMqtt = false; await h.manager.ensure(config);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
});

test('concurrent requests share refresh, storage, and final MQTT verification', async () => {
  const gate = deferred(); let writeStarted = false;
  const h = harness(normal);
  h.beforeWrite = async (key, value) => { if (value.revision === 1) { writeStarted = true; await gate.promise; } };
  const first = h.manager.ensure(config); await flush(); assert.equal(writeStarted, true);
  assert.equal(h.data[STORE_KEY].session.refreshToken, old.refreshToken);
  const callers = Array.from({ length: 25 }, () => h.manager.ensure(config));
  assert.ok(callers.every(promise => promise === first));
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
  assert.equal(h.calls.filter(call => call.phase === 'mqtt').length, 1);
  gate.resolve(); await Promise.all([first, ...callers]);
  assert.equal(h.calls.filter(call => call.phase === 'mqtt').length, 2);
});

test('valid access token avoids refresh entirely', async () => {
  const h = harness(() => reply(200, { token: 'PRIVATE_MQTT_TOKEN' }));
  await h.manager.ensure(config);
  assert.deepEqual(h.calls.map(call => call.phase), ['mqtt']);
});

test('definitively invalid refresh token requires Repair and is not repeatedly submitted', async () => {
  const h = harness((phase, options) => phase === 'refresh' ? reply(401, { error: 'invalid_token' }) : normal(phase, options));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_rejected' && error.requiresRepair);
  assert.equal(h.data[STORE_KEY].refreshState.kind, 'rejected');
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_rejected');
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
});

test('refresh timeout is durable uncertainty and never blindly retried after restart', async () => {
  const never = deferred();
  const h = harness((phase, options) => phase === 'refresh' ? never.promise : normal(phase, options));
  const attempt = h.manager.ensure(config);
  const rejected = assert.rejects(attempt, error => error.kind === 'timeout' && error.phase === 'refresh');
  await flush(); assert.equal(h.calls.at(-1).phase, 'refresh');
  await h.advance(8000); await rejected;
  assert.equal(h.data[STORE_KEY].refreshState.kind, 'uncertain');
  const restarted = new SessionManager({ storage: h.storage, client: h.client, diagnostic: h.diagnostic });
  await assert.rejects(restarted.ensure(config), error => error.kind === 'refresh_uncertain' && !error.requiresRepair);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
  never.resolve(reply(200, fresh)); await flush();
  assert.equal(h.data[STORE_KEY].session.accessToken, old.accessToken);
});

test('interrupted pending refresh at boot blocks replay even when access temporarily works', async () => {
  const seed = { ...old, [STORE_KEY]: { schema: 1, revision: 4, session: old, cookies: old.cookieHeader, refreshState: { kind: 'pending' } } };
  let accept = true;
  const h = harness(() => accept ? reply(200, { token: 'PRIVATE_MQTT_TOKEN' }) : reply(401, { error: 'invalid_token' }), seed);
  await h.manager.ensure(config);
  assert.equal(h.data[STORE_KEY].refreshState.kind, 'uncertain');
  accept = false;
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_uncertain');
  assert.ok(h.calls.every(call => call.phase === 'mqtt'));
});

test('storage failure after rotation blocks MQTT and retries only the pending record', async () => {
  const h = harness(normal); let rejectWrite = true;
  h.beforeWrite = async (key, record) => { if (record.revision === 1 && rejectWrite) throw new Error('PRIVATE_STORAGE_ERROR'); };
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'storage');
  assert.equal(h.calls.filter(call => call.phase === 'mqtt').length, 1);
  rejectWrite = false; await h.manager.ensure(config);
  assert.equal(h.data[STORE_KEY].session.accessToken, fresh.accessToken);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
});

test('failure to persist refresh intent sends no refresh request', async () => {
  const h = harness(normal);
  h.beforeWrite = async (key, record) => { if (record.refreshState?.kind === 'pending') throw new Error('PRIVATE_STORAGE_ERROR'); };
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'storage');
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 0);
});

test('refresh server error stays distinguishable but its possible rotation is fenced', async () => {
  const h = harness((phase, options) => phase === 'refresh' ? reply(500, { message: 'invalid token PRIVATE_SERVER_BODY' }) : normal(phase, options));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'server' && !error.requiresRepair && error.status === 500);
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_uncertain' && !error.requiresRepair);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
});

test('malformed successful refresh cannot trigger a second refresh', async () => {
  const h = harness((phase, options) => phase === 'refresh' ? reply(200, '{PRIVATE_INVALID_JSON') : normal(phase, options));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'invalid_response');
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_uncertain');
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
});

test('manual Repair replaces the whole record and clears refresh uncertainty', async () => {
  const seed = { [STORE_KEY]: { schema: 1, revision: 2, session: old, cookies: old.cookieHeader, refreshState: { kind: 'uncertain' } } };
  const h = harness(normal, seed);
  await h.manager.replace({ ...fresh, password: 'PRIVATE_PASSWORD' }, 'sid=PRIVATE_COOKIE_NEW');
  await h.manager.ensure(config);
  assert.equal(h.data[STORE_KEY].refreshState, null);
  assert.equal(h.data[STORE_KEY].revision, 3);
  assert.equal(h.data[STORE_KEY].session.password, undefined);
  assert.ok(h.calls.every(call => call.phase === 'mqtt'));
});

for (const status of [500, 502, 503, 504, 429]) test(`HTTP ${status} is temporary even when the response mentions invalid token`, async () => {
  const h = harness(() => reply(status, { message: 'invalid token PRIVATE_SERVER_BODY' }));
  await assert.rejects(h.client.mqtt(config, old, old.cookieHeader), error => error.kind === 'server' && error.status === status && !error.requiresRepair);
});

test('network failure is categorized without retaining its raw message', async () => {
  const h = harness(() => { throw new Error('PRIVATE_NETWORK_ERROR'); });
  await assert.rejects(h.client.getConfig(), error => error.kind === 'network' && error.phase === 'config' && !error.message.includes('PRIVATE'));
});

test('unexpected successful MQTT response is not treated as expired access', async () => {
  const h = harness(() => reply(200, { unexpected: 'PRIVATE_SERVER_BODY' }));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'invalid_response' && !error.requiresRepair);
  assert.ok(h.calls.every(call => call.phase === 'mqtt'));
});

test('403 from MQTT does not trigger rotation and config 401 is not token expiry', async () => {
  const h = harness(() => reply(403, { message: 'invalid token' }));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'authorization_denied' && !error.requiresRepair);
  assert.equal(h.calls.length, 1);
  const other = harness(() => reply(401, { error: 'invalid_token' }));
  await assert.rejects(other.client.getConfig(), error => error.kind === 'authorization_denied' && !error.requiresRepair);
});

test('explicit invalid_grant refresh response is a permanent refresh rejection', async () => {
  const h = harness((phase, options) => phase === 'refresh' ? reply(400, { error: 'invalid_grant' }) : normal(phase, options));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'refresh_rejected' && error.status === 400 && error.requiresRepair);
});

test('new cookies from an otherwise valid MQTT check are durably merged', async () => {
  const h = harness(() => reply(200, { token: 'PRIVATE_MQTT_TOKEN' }, ['sid=PRIVATE_COOKIE_NEW; Path=/']));
  const result = await h.manager.ensure(config);
  assert.equal(result.cookies, 'sid=PRIVATE_COOKIE_NEW');
  assert.equal(h.data[STORE_KEY].cookies, result.cookies);
});

test('corrupt atomic record refuses fallback to potentially obsolete legacy credentials', async () => {
  const h = harness(normal, { ...old, [STORE_KEY]: { schema: 99 } });
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'storage');
  assert.equal(h.calls.length, 0);
});

function deviceHarness(h) {
  const monitors = [], states = [], logs = []; let available = true;
  class Device {
    log() {} error() {}
    getStoreValue(key) { return h.data[key]; }
    setStoreValue(key, value) { return h.storage.set(key, value); }
    async setUnavailable() { available = false; states.push(false); }
    async setAvailable() { available = true; states.push(true); }
    getData() { return { id: 'synthetic-box' }; }
  }
  const ziggo = { getConfig: () => h.client.getConfig(),
    monitorStatus: (...args) => { monitors.push(args.at(-1)); return { end() {} }; },
    sendKey: () => { throw new Error('Power commands forbidden in authentication tests'); },
  };
  class Clock extends Date { static now() { return h.now(); } }
  const math = Object.create(Math); math.random = () => 0.5;
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { Device } : id === '../../lib/ziggo' ? ziggo
    : id === '../../lib/auth' ? require('../lib/auth') : id === '../../lib/power-controller' ? class {} : (() => { throw Error('Forbidden import'); })(),
    Date: Clock, Math: math, setTimeout: h.timerApi.setTimeout, clearTimeout: h.timerApi.clearTimeout,
    clearInterval() {},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next/device.js'), 'utf8'), box);
  const d = new box.module.exports();
  Object.assign(d, { auth: h.manager, deleted: false, monitorEpoch: 0, connectionSequence: 0,
    authRetryAttempt: 0, authRetryAt: 0, authRetryTimer: null, authUnavailable: false,
    authConnectionReady: false, sessionRefreshPromise: null, statusClient: null, statusReconnectTimer: null,
    power: { disconnect() {}, connect() {}, close() {} }, homey: { app: { recordDiag: line => logs.push(line) } } });
  return { d, monitors, states, logs, available: () => available };
}

test('watchdog automatically recovers from config 500 after its scheduled backoff', async () => {
  let fail = true;
  const h = harness((phase) => phase === 'config' ? fail ? reply(500, 'PRIVATE_SERVER_BODY') : reply(200, config)
    : reply(200, { token: 'PRIVATE_MQTT_TOKEN' }));
  const { d, available, logs } = deviceHarness(h);
  await assert.rejects(d.runSessionWatchdog(), error => error.kind === 'server');
  assert.equal(available(), true); assert.equal(d.authRetryAt, 30000);
  await d.runSessionWatchdog(); assert.equal(h.calls.length, 1);
  fail = false; await h.advance(30000);
  assert.equal(d.authRetryTimer, null); assert.equal(d.authRetryAt, 0);
  assert.ok(logs.some(line => line.includes('auth.watchdog.succeeded')));
  assert.deepEqual(h.calls.map(call => call.phase), ['config', 'config', 'mqtt']);
});

test('watchdog backoff grows and concurrent watchdog invocations share one request', async () => {
  const h = harness(() => reply(503, 'PRIVATE_SERVER_BODY'));
  const { d } = deviceHarness(h);
  await assert.rejects(d.runSessionWatchdog()); await h.advance(30000);
  assert.equal(d.authRetryAttempt, 2); assert.equal(d.authRetryAt, 90000);
  const gate = deferred(); const other = harness(() => gate.promise);
  const { d: second } = deviceHarness(other);
  const a = second.runSessionWatchdog(), b = second.runSessionWatchdog();
  assert.equal(a, b); assert.equal(other.calls.length, 1);
  const rejected = assert.rejects(a); gate.resolve(reply(503, 'PRIVATE_SERVER_BODY')); await rejected;
});

test('availability returns only after successful authentication AND status subscription', async () => {
  let reject = true;
  const h = harness((phase, options) => phase === 'config' ? reply(200, config) : phase === 'refresh'
    ? reply(401, { error: 'invalid_token' }) : reject ? reply(401, { error: 'invalid_token' }) : reply(200, { token: 'PRIVATE_MQTT_TOKEN' }));
  const state = deviceHarness(h);
  await assert.rejects(state.d.runSessionWatchdog(), error => error.requiresRepair);
  assert.equal(state.available(), false);
  reject = false; await h.advance(600000);
  assert.equal(state.monitors.length, 1); assert.equal(state.available(), false);
  state.monitors[0].onConnect(); assert.equal(state.available(), false);
  state.monitors[0].onSubscribed(); await flush();
  assert.equal(state.available(), true); assert.deepEqual(state.states, [false, true]);
  assert.ok(state.logs.some(line => line.includes('auth.availability.restored')));
});

test('deleted device cancels authentication retry and cannot restore availability', async () => {
  const h = harness(() => reply(500, 'PRIVATE_SERVER_BODY'));
  const state = deviceHarness(h);
  await assert.rejects(state.d.runSessionWatchdog());
  await state.d.onDeleted(); await h.advance(600000);
  assert.equal(h.calls.length, 1); assert.equal(state.d.authRetryTimer, null);
});

test('safe diagnostics contain phases and statuses but no authentication or server material', async () => {
  const h = harness((phase, options) => phase === 'refresh' ? reply(500, { message: 'PRIVATE_SERVER_BODY invalid token' }) : normal(phase, options));
  const state = deviceHarness(h);
  await assert.rejects(state.d.ensureSessionLocked(config));
  const serialized = JSON.stringify({ events: h.events, logs: state.logs });
  assert.ok(!serialized.includes('PRIVATE_'));
  assert.ok(serialized.includes('refresh'));
  assert.ok(serialized.includes('500'));
  assert.ok(!serialized.includes('https://'));
});

test('an intent storage failure can recover without fencing a refresh that was never sent', async () => {
  const h = harness(normal); let fail = true;
  h.beforeWrite = async (key, record) => { if (fail && record.refreshState?.kind === 'pending') throw Error('PRIVATE_STORAGE_ERROR'); };
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'storage');
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 0);
  fail = false; await h.manager.ensure(config);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 1);
  assert.equal(h.data[STORE_KEY].refreshState, null);
});

test('response-body network failure preserves phase and status without triggering refresh', async () => {
  const h = harness(() => ({ ...reply(200, {}), text: async () => { throw Error('PRIVATE_NETWORK_ERROR'); } }));
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'network' && error.phase === 'mqtt_token' && error.status === 200);
  assert.equal(h.calls.filter(call => call.phase === 'refresh').length, 0);
});

test('config deadline also covers a body that never finishes', async () => {
  const never = deferred();
  const h = harness(() => ({ ...reply(200, {}), text: () => never.promise }));
  const request = h.client.getConfig();
  const rejected = assert.rejects(request, error => error.kind === 'timeout' && error.phase === 'config');
  await flush(); await h.advance(8000); await rejected;
  assert.equal(h.calls.length, 1);
  never.resolve(JSON.stringify(config)); await flush();
});

test('unexpected HTTP 400 is distinguishable from a rejected refresh token', async () => {
  const h = harness(() => reply(400, { message: 'PRIVATE_SERVER_BODY' }));
  await assert.rejects(h.client.mqtt(config, old, old.cookieHeader), error => error.kind === 'invalid_response' && error.status === 400 && !error.requiresRepair);
});

test('storage read errors are sanitized and cannot cause any HTTP request', async () => {
  const h = harness(normal);
  h.storage.get = () => { throw Error('PRIVATE_STORAGE_ERROR'); };
  await assert.rejects(h.manager.ensure(config), error => error.kind === 'storage' && error.phase === 'load' && !error.message.includes('PRIVATE'));
  assert.equal(h.calls.length, 0);
});

test('a cookie deletion is persisted rather than replaced with the previous cookie', async () => {
  const h = harness(() => reply(200, { token: 'PRIVATE_MQTT_TOKEN' }, ['sid=; Max-Age=0']));
  await h.manager.ensure(config);
  assert.equal(h.data[STORE_KEY].cookies, '');
});

test('manual Repair is serialized behind in-flight refresh and cannot be overwritten', async () => {
  const gate = deferred();
  const h = harness((phase, options) => phase === 'refresh' ? gate.promise : normal(phase, options));
  const ongoing = h.manager.ensure(config); await flush();
  const repaired = { ...fresh, accessToken: 'PRIVATE_REPAIR_ACCESS', refreshToken: 'PRIVATE_REPAIR_REFRESH' };
  const repair = h.manager.replace(repaired, 'sid=PRIVATE_REPAIR_COOKIE');
  assert.equal(h.data[STORE_KEY].revision, 0);
  gate.resolve(reply(200, fresh)); await Promise.all([ongoing, repair]);
  assert.equal(h.data[STORE_KEY].session.accessToken, repaired.accessToken);
  assert.equal(h.data[STORE_KEY].session.refreshToken, repaired.refreshToken);
  assert.equal(h.data[STORE_KEY].revision, 2);
});

test('an old subscription cannot restore availability for a newer authentication revision', async () => {
  const h = harness(normal); const state = deviceHarness(h);
  await state.d.setUnavailable(); state.d.authUnavailable = true; h.manager.verifiedRevision = 5;
  const prepared = { config, session: fresh, mqttToken: 'PRIVATE_MQTT_TOKEN', refreshed: false, authRevision: 4 };
  await state.d.startStatusMonitor(prepared);
  state.monitors[0].onConnect(); state.monitors[0].onSubscribed(); await flush();
  assert.equal(state.available(), false);
  await state.d.startStatusMonitor({ ...prepared, authRevision: 5 });
  state.monitors[1].onConnect(); state.monitors[1].onSubscribed(); await flush();
  assert.equal(state.available(), true);
});

test('a new authentication failure wins over an availability write already in flight', async () => {
  const h = harness(normal); const state = deviceHarness(h); const gate = deferred();
  state.d.authUnavailable = true; state.d.authConnectionReady = true; state.d.authConnectionRevision = 1;
  h.manager.verifiedRevision = 1;
  const original = state.d.setAvailable.bind(state.d);
  state.d.setAvailable = async () => { await gate.promise; await original(); };
  const recovering = state.d.restoreAuthAvailability(); await flush();
  const failing = state.d.handleAuthFailure(new AuthError('refresh_rejected', 'refresh', 401));
  gate.resolve(); await Promise.all([recovering, failing]);
  assert.equal(state.available(), false); assert.equal(state.d.authUnavailable, true);
  assert.deepEqual(state.states, [true, false]);
});

test('an in-flight failure superseded by Repair cannot mark the new session unavailable', async () => {
  const gate = deferred();
  const h = harness((phase, options) => phase === 'refresh' ? gate.promise : normal(phase, options));
  const state = deviceHarness(h);
  const ongoing = state.d.ensureSessionLocked(config); const rejected = assert.rejects(ongoing);
  await flush();
  const repair = state.d.persistSession(fresh, 'sid=PRIVATE_REPAIR_COOKIE');
  gate.resolve(reply(401, { error: 'invalid_token' }));
  await Promise.all([rejected, repair]);
  assert.equal(state.available(), true); assert.deepEqual(state.states, []);
  assert.equal(state.d.authRetryTimer, null);
  assert.equal(h.data[STORE_KEY].session.accessToken, fresh.accessToken);
});

test('login and discovery diagnostics report status without exposing credentials or response data', async () => {
  const h = harness(phase => phase === 'config' ? reply(200, config) : phase === 'login'
    ? reply(200, fresh, ['sid=PRIVATE_COOKIE_NEW; Path=/']) : reply(200, { assignedDevices: [{ deviceId: 'PRIVATE_BOX' }] }));
  const loggedIn = await h.client.login(old.username, 'PRIVATE_PASSWORD');
  await h.client.getDevices(config, loggedIn.session, loggedIn.cookies);
  assert.ok(h.events.some(event => event.phase === 'login' && event.status === 200));
  assert.ok(h.events.some(event => event.phase === 'devices' && event.status === 200));
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE_'));
});

test('retry delay remains bounded and no new requests run during backoff', async () => {
  const h = harness(() => reply(503, 'PRIVATE_SERVER_BODY')); const state = deviceHarness(h);
  await assert.rejects(state.d.runSessionWatchdog());
  for (let i = 0; i < 8; i++) {
    const delay = state.d.authRetryAt - h.now();
    assert.ok(delay > 0 && delay <= 600000);
    const count = h.calls.length; await state.d.runSessionWatchdog(); assert.equal(h.calls.length, count);
    await h.advance(delay);
  }
  assert.ok(state.d.authRetryAttempt >= 9);
});

test('automatic authentication waits for the complete manual login and persistence transaction', async () => {
  const h = harness(normal); const gate = deferred();
  const repair = h.manager.repair(async () => { await gate.promise; return { session: fresh, cookies: 'sid=PRIVATE_COOKIE_NEW' }; });
  await flush(); const automatic = h.manager.ensure(config); await flush();
  assert.equal(h.calls.length, 0);
  gate.resolve(); await Promise.all([repair, automatic]);
  assert.deepEqual(h.calls.map(call => call.phase), ['mqtt']);
  assert.equal(h.data[STORE_KEY].session.refreshToken, fresh.refreshToken);
});

test('device coalesces automatic checks behind Repair and rejects a second simultaneous Repair', async () => {
  const h = harness(normal); const state = deviceHarness(h); const gate = deferred();
  const repair = state.d.repairSession(async () => { await gate.promise; return { session: fresh, cookies: '' }; });
  const automatic = state.d.ensureSessionLocked(config); await flush();
  await assert.rejects(state.d.repairSession(async () => { throw Error('Must not execute'); }), error => error.kind === 'repair_busy');
  assert.equal(h.calls.length, 0);
  gate.resolve(); await Promise.all([repair, automatic]);
  assert.deepEqual(h.calls.map(call => call.phase), ['mqtt']);
});

test('Repair handler preserves device identity checks and commits the new session before reconnecting', async () => {
  for (const correctDevice of [true, false]) {
    const h = harness(normal); const state = deviceHarness(h); let handler;
    await state.d.setUnavailable(); state.d.authUnavailable = true;
    class Driver { log() {} }
    const ziggo = {
      login: async (username, password, options) => { assert.ok(state.d.authRepairPromise); options.diagnostic('auth.request.succeeded', { phase: 'login', status: 200 }); return { session: fresh, config, cookies: 'sid=PRIVATE_COOKIE_NEW' }; },
      getDevices: async () => ({ devices: [{ deviceId: correctDevice ? 'synthetic-box' : 'other-box' }], customer: {} }),
    };
    const box = { module: { exports: {} }, require: id => id === 'homey' ? { Driver } : id === '../../lib/ziggo' ? ziggo : require('../lib/auth') };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next/driver.js'), 'utf8'), box);
    const driver = new box.module.exports(); driver.homey = state.d.homey;
    await driver.onRepair({ setHandler: (id, fn) => { handler = fn; } }, state.d);
    const attempt = handler({ username: old.username, password: 'PRIVATE_PASSWORD' });
    if (correctDevice) {
      await attempt;
      assert.equal(h.data[STORE_KEY].session.accessToken, fresh.accessToken);
      assert.equal(h.data[STORE_KEY].session.password, undefined);
      assert.equal(state.monitors.length, 1);
      assert.equal(state.available(), false);
      state.monitors[0].onConnect(); state.monitors[0].onSubscribed(); await flush();
      assert.equal(state.available(), true);
    } else {
      await assert.rejects(attempt, /komt niet overeen/);
      assert.equal(h.data[STORE_KEY], undefined); // Failed identity check must not migrate or replace storage.
      assert.equal(h.data.accessToken, old.accessToken);
      assert.equal(state.monitors.length, 0);
    }
    assert.ok(!JSON.stringify(state.logs).includes('PRIVATE_'));
  }
});

test('protected v0.0.23 Power controller, Flow definitions and capabilities retain exact hashes', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'protected-v0.0.23.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const [file, expected] of Object.entries(fixture.files)) {
    const actual = createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', file))).digest('hex').toUpperCase();
    assert.equal(actual, expected, file);
  }
  for (const [name, section] of Object.entries(fixture.segments)) {
    const text = fs.readFileSync(path.join(__dirname, '..', section.file), 'utf8');
    const start = text.indexOf(section.start), end = text.indexOf(section.end, start);
    assert.ok(start >= 0 && end > start, name);
    const hash = createHash('sha256').update(text.slice(start, end)).digest('hex').toUpperCase();
    assert.equal(hash, section.sha256, name);
  }
});
