'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { SessionManager, AuthError, STORE_KEY } = require('../lib/auth');
const LegacyStore = require('./legacy-v0.0.23-store.fixture')({ tokenMeta: () => ({}), cookieMeta: () => ({}) });
global.fetch = () => { throw Error('Live requests prohibited'); };
const copy = value => JSON.parse(JSON.stringify(value));
const old = { username: 'PRIVATE_USER', householdId: 'PRIVATE_HOME', accessToken: 'PRIVATE_A0', refreshToken: 'PRIVATE_R0', cookieHeader: 'sid=PRIVATE_C0' };
const fresh = { ...old, accessToken: 'PRIVATE_A1', refreshToken: 'PRIVATE_R1' };
const repaired = { ...old, accessToken: 'PRIVATE_A2', refreshToken: 'PRIVATE_R2' };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function harness() {
  const data = { ...old, pendingPower: null, unrelatedSetting: 'keep' }, calls = [], events = [], writes = [];
  const h = { data, calls, events, writes, validAccess: old.accessToken };
  h.storage = { get: key => data[key], set: async (key, value) => { if (h.beforeWrite) await h.beforeWrite(value); data[key] = copy(value); writes.push(key); } };
  const client = {
    mqtt: async (_, session, cookies) => { calls.push('mqtt'); if (session.accessToken !== h.validAccess) throw new AuthError('access_rejected', 'mqtt_token', 401); return { token: 'PRIVATE_MQTT', cookies }; },
    refresh: async () => { calls.push('refresh'); h.validAccess = fresh.accessToken; return { session: fresh, cookies: 'sid=PRIVATE_C1' }; },
  };
  h.manager = () => new SessionManager({ storage: h.storage, client, diagnostic: (event, fields) => events.push({ event, ...fields }) });
  h.legacy = new LegacyStore();
  Object.assign(h.legacy, { getStoreValue: key => data[key], setStoreValue: async (key, value) => { data[key] = copy(value); }, log() {} });
  return h;
}

for (const [name, damaged] of Object.entries({ falseValue: false, number: 4, string: 'PRIVATE_DAMAGED', array: [], wrongSchema: { schema: 99 }, missingSession: { schema: 1 }, malformedTokens: { schema: 1, revision: 1, session: { ...old, accessToken: {} }, cookies: '' } })) {
  test(`corrupt record ${name} blocks automatic use but explicit Repair replaces it`, async () => {
    const h = harness(); h.data[STORE_KEY] = copy(damaged); const manager = h.manager();
    await assert.rejects(manager.ensure({}), error => error.kind === 'storage'); assert.equal(h.calls.length, 0);
    await manager.repair(async () => ({ session: repaired, cookies: 'sid=PRIVATE_C2' }));
    h.validAccess = repaired.accessToken; await manager.ensure({});
    assert.equal(h.data[STORE_KEY].session.refreshToken, repaired.refreshToken);
    assert.deepEqual(h.calls, ['mqtt']); assert.equal(h.data.pendingPower, null); assert.equal(h.data.unrelatedSetting, 'keep');
    assert.ok(!JSON.stringify(h.events).includes('PRIVATE_'));
  });
}

test('failed login leaves damaged record untouched and permits a later Repair', async () => {
  const h = harness(); h.data[STORE_KEY] = { schema: 99 }; const manager = h.manager();
  await assert.rejects(manager.repair(async () => { throw new AuthError('refresh_rejected', 'login', 401); }));
  assert.deepEqual(h.data[STORE_KEY], { schema: 99 }); assert.equal(h.writes.length, 0);
  await manager.repair(async () => ({ session: repaired, cookies: '' }));
  assert.equal(h.data[STORE_KEY].session.accessToken, repaired.accessToken);
});

test('actual v23 persistence after rollback is detected on re-upgrade; explicit Repair resolves conflict', async () => {
  const h = harness(); const first = h.manager(); h.validAccess = null; await first.ensure({});
  assert.equal(h.data[STORE_KEY].session.refreshToken, fresh.refreshToken);
  assert.equal(h.legacy.getStoredSession().refreshToken, old.refreshToken);
  const record = copy(h.data[STORE_KEY]); await h.legacy.persistSession(repaired, 'sid=PRIVATE_C2');
  assert.deepEqual(h.data[STORE_KEY], record); assert.equal(h.legacy.getStoredSession().refreshToken, repaired.refreshToken);
  const count = h.calls.length, next = h.manager();
  await assert.rejects(next.ensure({}), error => error.kind === 'session_conflict' && error.requiresRepair);
  assert.equal(h.calls.length, count); assert.deepEqual(h.data[STORE_KEY], record);
  await next.repair(async () => ({ session: repaired, cookies: 'sid=PRIVATE_C2' }));
  h.validAccess = repaired.accessToken; await next.ensure({});
  assert.equal(h.calls.filter(call => call === 'refresh').length, 1);
  assert.equal(h.data[STORE_KEY].session.refreshToken, repaired.refreshToken);
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE_'));
});

test('rollback without legacy writes does not falsely invalidate the rotated v24 session', async () => {
  const h = harness(); h.validAccess = null; await h.manager().ensure({});
  assert.equal(h.legacy.getStoredSession().refreshToken, old.refreshToken);
  const result = await h.manager().ensure({}); assert.equal(result.session.refreshToken, fresh.refreshToken);
  assert.equal(h.calls.filter(call => call === 'refresh').length, 1);
});

test('partial legacy writes and a different household both require Repair before any token use', async () => {
  for (const field of ['accessToken', 'refreshToken', 'cookieHeader', 'householdId']) {
    const h = harness(), manager = h.manager(); await manager.ensure({}); const count = h.calls.length;
    h.data[field] = 'PRIVATE_CHANGED';
    await assert.rejects(manager.ensure({}), error => error.kind === 'session_conflict');
    assert.equal(h.calls.length, count); assert.equal(h.data[STORE_KEY].session.accessToken, old.accessToken);
  }
});

test('earlier v24 record without baseline is accepted only when legacy session exactly matches', async () => {
  for (const same of [true, false]) {
    const h = harness(); await h.manager().ensure({}); delete h.data[STORE_KEY].legacyFingerprint;
    if (!same) h.data.accessToken = repaired.accessToken;
    if (same) { await h.manager().ensure({}); assert.match(h.data[STORE_KEY].legacyFingerprint, /^[a-f0-9]{64}$/); }
    else { const count = h.calls.length; await assert.rejects(h.manager().ensure({}), error => error.kind === 'session_conflict'); assert.equal(h.calls.length, count); }
  }
});

test('concurrent callers during recovery wait for login and complete persistence', async () => {
  const h = harness(); h.data[STORE_KEY] = 'PRIVATE_CORRUPT'; const manager = h.manager();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const repair = manager.repair(async () => { await gate; return { session: repaired, cookies: '' }; });
  const callers = Array.from({ length: 25 }, () => manager.ensure({})); await flush(); assert.equal(h.calls.length, 0);
  h.validAccess = repaired.accessToken; release(); await Promise.all([repair, ...callers]);
  assert.deepEqual(h.calls, ['mqtt']); assert.equal(h.data[STORE_KEY].session.accessToken, repaired.accessToken);
});

test('failed storage after Repair retries only the complete replacement record', async () => {
  const h = harness(); h.data[STORE_KEY] = { schema: 99 }; const manager = h.manager(); let fail = true;
  h.beforeWrite = async () => { if (fail) throw Error('PRIVATE_STORAGE_DETAIL'); };
  await assert.rejects(manager.repair(async () => ({ session: repaired, cookies: '' })), error => error.kind === 'storage');
  assert.equal(h.calls.length, 0); fail = false; h.validAccess = repaired.accessToken; await manager.ensure({});
  assert.equal(h.data[STORE_KEY].session.refreshToken, repaired.refreshToken); assert.deepEqual(h.calls, ['mqtt']);
  assert.ok(!JSON.stringify(h.events).includes('PRIVATE_'));
});

test('invalid replacement response cannot overwrite damaged storage', async () => {
  const h = harness(); h.data[STORE_KEY] = { schema: 99 };
  await assert.rejects(h.manager().repair(async () => ({ session: { ...repaired, accessToken: {} }, cookies: '' })), error => error.kind === 'invalid_response');
  assert.deepEqual(h.data[STORE_KEY], { schema: 99 }); assert.equal(h.writes.length, 0);
});

test('real Repair handler retains Mediabox identity check even with damaged session storage', async () => {
  for (const matching of [true, false]) {
    const h = harness(); h.data[STORE_KEY] = { schema: 99 }; const manager = h.manager(); let handler, reconnects = 0;
    const device = { repairSession: fn => manager.repair(fn), getData: () => ({ id: 'same-box' }), startStatusMonitor: async () => { reconnects++; assert.equal(h.data[STORE_KEY].session.accessToken, repaired.accessToken); } };
    const ziggo = { login: async () => ({ session: repaired, config: {}, cookies: '' }), getDevices: async () => ({ devices: [{ deviceId: matching ? 'same-box' : 'other-box' }], customer: {} }) };
    const box = { module: { exports: {} }, require: id => id === 'homey' ? { Driver: class { log() {} } } : id === '../../lib/ziggo' ? ziggo : require('../lib/auth') };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next/driver.js'), 'utf8'), box);
    const driver = new box.module.exports(); driver.homey = { app: { recordDiag() {} } };
    await driver.onRepair({ setHandler: (_, fn) => { handler = fn; } }, device);
    if (matching) { await handler({ username: old.username, password: 'PRIVATE_PASSWORD' }); assert.equal(reconnects, 1); }
    else { await assert.rejects(handler({ username: old.username, password: 'PRIVATE_PASSWORD' }), /komt niet overeen/); assert.deepEqual(h.data[STORE_KEY], { schema: 99 }); assert.equal(reconnects, 0); }
  }
});
