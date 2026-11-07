'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { SessionManager, AuthClient, AuthError, STORE_KEY } = require('../lib/auth');
global.fetch = () => { throw Error('Live authentication prohibited'); };
const base = { username: 'SYNTHETIC_USER', householdId: 'SYNTHETIC_HOME', accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH', hashedCustomerId: null, cookieHeader: 'sid=SYNTHETIC_COOKIE' };
const newer = { ...base, accessToken: 'SYNTHETIC_NEW_ACCESS', refreshToken: 'SYNTHETIC_NEW_REFRESH', refreshTokenExpiry: 1800000000000 };
function harness(expiry = 1800000000) {
  const data = { ...base, refreshTokenExpiry: expiry }, calls = [], writes = [], events = [];
  const h = { data, calls, writes, events, rejectOld: false };
  h.storage = { get: key => data[key], set: async (key, value) => { if (h.beforeWrite) await h.beforeWrite(value); data[key] = JSON.parse(JSON.stringify(value)); writes.push(key); } };
  h.client = {
    mqtt: async (_, session, cookies) => { calls.push('mqtt'); if (h.rejectOld && session.accessToken === base.accessToken) throw new AuthError('access_rejected', 'mqtt_token', 401); return { token: 'SYNTHETIC_MQTT', cookies }; },
    refresh: async () => { calls.push('refresh'); return { session: newer, cookies: 'sid=SYNTHETIC_NEW_COOKIE' }; },
  };
  h.manager = () => new SessionManager({ storage: h.storage, client: h.client, diagnostic: (event, fields) => events.push({ event, ...fields }) });
  h.savedRecord = () => {
    const { cookieHeader, ...session } = data;
    return { schema: 1, revision: 0, session, cookies: cookieHeader ?? '', refreshState: null, legacyFingerprint: h.manager().fingerprint(session, cookieHeader ?? '') };
  };
  return h;
}

for (const expiry of [null, undefined, 0, 1800000000, 1800000000000, 1800000000.5, '1800000000', '2027-01-15T00:00:00Z']) {
  test('legacy migration preserves expiry representation: ' + String(expiry), async () => {
    const h = harness(); h.data.refreshTokenExpiry = expiry; const legacy = structuredClone(h.data);
    await h.manager().ensure({});
    assert.equal(h.data[STORE_KEY].session.refreshTokenExpiry, expiry);
    for (const key of Object.keys(legacy)) assert.deepEqual(h.data[key], legacy[key]);
    assert.deepEqual(h.calls, ['mqtt']); assert.deepEqual(h.writes, [STORE_KEY]);
    assert.ok(!JSON.stringify(h.events).includes('SYNTHETIC_'));
  });
}

test('previously persisted v24 numeric-expiry record loads without rewriting or token rotation', async () => {
  const h = harness(); const saved = h.savedRecord(); h.data[STORE_KEY] = structuredClone(saved);
  const result = await h.manager().ensure({});
  assert.deepEqual(h.data[STORE_KEY], saved); assert.equal(result.authRevision, 0);
  assert.deepEqual(h.writes, []); assert.deepEqual(h.calls, ['mqtt']);
});

test('numeric expiry and legacy comparison baseline remain stable across repeated restarts', async () => {
  const h = harness(); await h.manager().ensure({}); const record = structuredClone(h.data[STORE_KEY]);
  for (let i = 0; i < 3; i++) await h.manager().ensure({});
  assert.deepEqual(h.data[STORE_KEY], record); assert.equal(h.writes.length, 1); assert.equal(h.calls.includes('refresh'), false);
});

test('rotation persists numeric expiry before MQTT and loads the new session after restart', async () => {
  const h = harness(); h.rejectOld = true;
  h.client.mqtt = async (_, session, cookies) => {
    h.calls.push('mqtt');
    if (session.accessToken === base.accessToken) throw new AuthError('access_rejected', 'mqtt_token', 401);
    assert.equal(h.data[STORE_KEY].session.refreshTokenExpiry, newer.refreshTokenExpiry);
    assert.equal(h.data[STORE_KEY].session.refreshToken, newer.refreshToken);
    return { token: 'SYNTHETIC_MQTT', cookies };
  };
  await h.manager().ensure({}); const fingerprint = h.data[STORE_KEY].legacyFingerprint;
  await h.manager().ensure({});
  assert.equal(h.data[STORE_KEY].revision, 1); assert.equal(h.data[STORE_KEY].legacyFingerprint, fingerprint);
  assert.equal(h.calls.filter(call => call === 'refresh').length, 1);
});

for (const expiry of [true, {}, [], -1, NaN, Infinity, -Infinity]) {
  test('invalid legacy expiry is rejected before persistence: ' + String(expiry), async () => {
    const h = harness(); h.data.refreshTokenExpiry = expiry;
    await assert.rejects(h.manager().ensure({}), error => error.kind === 'storage');
    assert.equal(h.data[STORE_KEY], undefined); assert.deepEqual(h.writes, []); assert.deepEqual(h.calls, []);
  });
}

test('damaged existing records do not fall back to apparently valid legacy credentials', async () => {
  for (const mutate of [r => { r.session.refreshTokenExpiry = {}; }, r => { r.session.accessToken = {}; }, r => { r.schema = 2; }, r => { r.legacyFingerprint = [r.legacyFingerprint]; }, r => { r.refreshState = { kind: 'unexpected' }; }]) {
    const h = harness(), record = h.savedRecord(); mutate(record); h.data[STORE_KEY] = record;
    await assert.rejects(h.manager().ensure({}), error => error.kind === 'storage'); assert.deepEqual(h.calls, []); assert.deepEqual(h.writes, []);
  }
});

test('required identity/token types, optional metadata and cookie types remain guarded during migration', async () => {
  for (const [field, value] of [['username', null], ['householdId', 42], ['accessToken', ''], ['refreshToken', {}], ['hashedCustomerId', 17], ['cookieHeader', false], ['cookieHeader', 0], ['cookieHeader', {}]]) {
    const h = harness(); h.data[field] = value;
    await assert.rejects(h.manager().ensure({}), error => error.kind === 'storage'); assert.deepEqual(h.writes, []); assert.deepEqual(h.calls, []);
  }
});

test('legacy conflict and pending-rotation fence survive acceptance of numeric expiry', async () => {
  const h = harness(); h.data[STORE_KEY] = h.savedRecord(); h.data[STORE_KEY].refreshState = { kind: 'pending', startedAt: '2026-10-30T00:00:00Z' };
  h.rejectOld = true; await assert.rejects(h.manager().ensure({}), error => error.kind === 'refresh_uncertain');
  assert.equal(h.data[STORE_KEY].refreshState.kind, 'uncertain'); assert.equal(h.calls.includes('refresh'), false);
  const count = h.calls.length; h.data.refreshToken = 'SYNTHETIC_DIFFERENT';
  await assert.rejects(h.manager().ensure({}), error => error.kind === 'session_conflict'); assert.equal(h.calls.length, count);
});

test('concurrent requests wait for numeric-expiry migration persistence', async () => {
  const h = harness(); let release; const gate = new Promise(resolve => { release = resolve; }); h.beforeWrite = async () => gate;
  const manager = h.manager(), callers = Array.from({ length: 20 }, () => manager.ensure({}));
  await Promise.resolve(); await Promise.resolve(); assert.deepEqual(h.calls, []); assert.ok(callers.every(call => call === callers[0]));
  release(); await Promise.all(callers); assert.deepEqual(h.calls, ['mqtt']); assert.equal(h.writes.length, 1);
});

test('HTTP refresh preserves zero and numeric expiry metadata without coercion', async () => {
  for (const value of [0, 1800000000, 1800000000000]) {
    const client = new AuthClient({ fetch: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ ...newer, refreshTokenExpiry: value }), headers: { getSetCookie: () => [], get: () => null } }) });
    const result = await client.refresh({ authorizationService: { URL: 'https://example.invalid' } }, { ...base, refreshTokenExpiry: 'older-expiry' }, '');
    assert.equal(result.session.refreshTokenExpiry, value);
  }
});
