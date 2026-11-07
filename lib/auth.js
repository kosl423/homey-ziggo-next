'use strict';
const { createHash } = require('node:crypto');

const STORE_KEY = 'ziggoAuthSessionV1';
const CONFIG_URL = 'https://prod.spark.ziggogo.tv/nl/en/config-service/conf/web/backoffice.json';
const REFERER = 'https://www.ziggogo.tv/';
const clone = value => JSON.parse(JSON.stringify(value));
const messages = {
  server: 'Ziggo-dienst tijdelijk niet beschikbaar. Automatisch herstel wordt geprobeerd.',
  network: 'Ziggo niet bereikbaar. Automatisch herstel wordt geprobeerd.',
  timeout: 'Ziggo-aanvraag duurde te lang. Automatisch herstel wordt geprobeerd.',
  invalid_response: 'Ziggo gaf een onverwacht antwoord. Automatisch herstel wordt geprobeerd.',
  access_rejected: 'Ziggo-toegangstoken niet geaccepteerd.',
  refresh_rejected: 'Ziggo-sessie ongeldig. Repareer het apparaat om opnieuw in te loggen.',
  authorization_denied: 'Ziggo heeft deze aanvraag geweigerd.',
  refresh_uncertain: 'Uitkomst sessievernieuwing onzeker. Vernieuwing wordt niet blind herhaald.',
  storage: 'Ziggo-sessie kon niet veilig worden opgeslagen. Automatisch herstel wordt geprobeerd.',
  session_missing: 'Geen bruikbare Ziggo-sessie. Repareer het apparaat om opnieuw in te loggen.',
  stopped: 'Ziggo-sessieafhandeling gestopt.',
  repair_busy: 'Er wordt al een Ziggo-reparatie uitgevoerd.',
  session_conflict: 'Ziggo-sessieopslag gewijzigd sinds eerder gebruik. Repareer het apparaat om veilig opnieuw in te loggen.',
};

class AuthError extends Error {
  constructor(kind, phase, status = null) {
    super(messages[kind] || 'Ziggo-authenticatie mislukt.');
    this.name = 'AuthError';
    this.kind = kind;
    this.phase = phase;
    this.status = Number.isInteger(status) ? status : null;
    this.requiresRepair = ['refresh_rejected', 'session_missing', 'session_conflict'].includes(kind);
    this.retryable = ['server', 'network', 'timeout', 'invalid_response', 'storage'].includes(kind);
  }
}

function asAuthError(error, phase = 'session') {
  return error instanceof AuthError ? error : new AuthError('network', phase);
}

// Diagnostics accept only fixed metadata, never response bodies or credentials.
function emit(diagnostic, event, fields = {}) {
  const safe = {};
  for (const key of ['phase', 'kind', 'status', 'revision', 'attempt', 'delayMs', 'requiresRepair']) {
    if (Object.hasOwn(fields, key)) safe[key] = fields[key];
  }
  try { diagnostic(event, safe); } catch (_) {}
}

function mergeCookies(existing, headers) {
  const jar = new Map();
  for (const part of String(existing || '').split(/;\s*/)) {
    const at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at), part.slice(at + 1));
  }
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie() : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
  for (const raw of values) {
    const part = raw.split(';', 1)[0];
    const at = part.indexOf('=');
    if (at < 1) continue;
    const key = part.slice(0, at), value = part.slice(at + 1);
    if (value) jar.set(key, value); else jar.delete(key);
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
}

function endpoint(config, field, path, phase) {
  try {
    const base = new URL(config?.[field]?.URL);
    if (base.protocol !== 'https:') throw new Error();
    return `${base.toString().replace(/\/$/, '')}${path}`;
  } catch (_) { throw new AuthError('invalid_response', phase); }
}

class AuthClient {
  constructor({ fetch = globalThis.fetch, timeoutMs = 8000, timers = { setTimeout, clearTimeout }, diagnostic = () => {} } = {}) {
    Object.assign(this, { fetch, timeoutMs, timers, diagnostic });
  }

  async request(phase, url, options = {}, cookies = '') {
    const controller = new AbortController();
    let timer;
    emit(this.diagnostic, 'auth.request', { phase });
    try {
      const timeout = new Promise((_, reject) => {
        timer = this.timers.setTimeout(() => {
          controller.abort();
          reject(new AuthError('timeout', phase));
        }, this.timeoutMs);
      });
      // The deadline covers receiving and decoding the body, even if a mock or
      // transport ignores abort. Late completion cannot cause a second request.
      const operation = (async () => {
        const response = await this.fetch(url, { ...options, signal: controller.signal });
        let text, data;
        try { text = await response.text(); } catch (_) {
          throw new AuthError(controller.signal.aborted ? 'timeout' : 'network', phase, response.status);
        }
        try { data = JSON.parse(text); } catch (_) {
          if (response.status >= 500) throw new AuthError('server', phase, response.status);
          if (response.status === 401) throw new AuthError(['refresh', 'login'].includes(phase) ? 'refresh_rejected' : phase === 'mqtt_token' ? 'access_rejected' : 'authorization_denied', phase, 401);
          throw new AuthError('invalid_response', phase, response.status);
        }
        if (!response.ok) {
          const invalidGrant = ['invalid_grant', 'invalid_token'].includes(data?.error)
            || ['invalid_grant', 'invalid_token'].includes(data?.code);
          if (response.status >= 500 || response.status === 429) throw new AuthError('server', phase, response.status);
          if (response.status === 401 || (phase === 'refresh' && [400, 403].includes(response.status) && invalidGrant)) {
            throw new AuthError(['refresh', 'login'].includes(phase) ? 'refresh_rejected' : phase === 'mqtt_token' ? 'access_rejected' : 'authorization_denied', phase, response.status);
          }
          throw new AuthError(response.status === 403 ? 'authorization_denied' : 'invalid_response', phase, response.status);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new AuthError('invalid_response', phase, response.status);
        return { data, cookies: mergeCookies(cookies, response.headers), status: response.status };
      })();
      const result = await Promise.race([operation, timeout]);
      emit(this.diagnostic, 'auth.request.succeeded', { phase, status: result.status });
      return result;
    } catch (error) {
      const safe = error instanceof AuthError ? error : new AuthError(controller.signal.aborted ? 'timeout' : 'network', phase);
      emit(this.diagnostic, 'auth.request.failed', safe);
      throw safe;
    } finally { this.timers.clearTimeout(timer); }
  }

  async getConfig() {
    const { data } = await this.request('config', CONFIG_URL, { headers: { accept: 'application/json' } });
    endpoint(data, 'authorizationService', '', 'config');
    return data;
  }

  async mqtt(config, session, cookies) {
    const result = await this.request('mqtt_token', endpoint(config, 'authorizationService', '/v1/mqtt/token', 'mqtt_token'), {
      headers: { 'X-OESP-Token': session.accessToken, 'X-OESP-Username': session.username, ...(cookies ? { Cookie: cookies } : {}) },
    }, cookies);
    if (typeof result.data.token !== 'string' || !result.data.token) throw new AuthError('invalid_response', 'mqtt_token', 200);
    return { token: result.data.token, cookies: result.cookies };
  }

  async refresh(config, stored, cookies) {
    const result = await this.request('refresh', endpoint(config, 'authorizationService', '/v1/authorization/refresh', 'refresh'), {
      method: 'POST',
      headers: { accept: '*/*', 'content-type': 'application/json; charset=UTF-8', 'x-oesp-username': stored.username,
        ...(stored.hashedCustomerId ? { 'x-tracking-id': stored.hashedCustomerId } : {}), ...(cookies ? { Cookie: cookies } : {}) },
      body: JSON.stringify({ refreshToken: stored.refreshToken, username: stored.username }),
    }, cookies);
    if (typeof result.data.accessToken !== 'string' || !result.data.accessToken) throw new AuthError('invalid_response', 'refresh', 200);
    const session = {
      username: result.data.username || stored.username,
      householdId: result.data.householdId || stored.householdId,
      accessToken: result.data.accessToken,
      refreshToken: result.data.refreshToken || stored.refreshToken,
      refreshTokenExpiry: result.data.refreshTokenExpiry ?? stored.refreshTokenExpiry ?? null,
      hashedCustomerId: stored.hashedCustomerId || null,
    };
    if (!['username', 'householdId', 'refreshToken'].every(key => typeof session[key] === 'string' && session[key])) throw new AuthError('invalid_response', 'refresh', 200);
    return { session, cookies: result.cookies };
  }

  async login(username, password) {
    const config = await this.getConfig();
    const result = await this.request('login', endpoint(config, 'authorizationService', '/v1/authorization', 'login'), {
      method: 'POST', headers: { accept: '*/*', 'content-type': 'application/json; charset=utf-8', 'x-device-code': 'web' },
      body: JSON.stringify({ username, password, stayLoggedIn: false }),
    });
    if (!result.data.householdId || !result.data.accessToken) throw new AuthError('invalid_response', 'login', 200);
    return { config, session: { ...result.data, username: result.data.username || username }, cookies: result.cookies };
  }

  async getDevices(config, session, cookies = '') {
    const url = new URL(endpoint(config, 'personalizationService', `/v1/customer/${encodeURIComponent(session.householdId)}`, 'devices'));
    url.searchParams.set('with', 'profiles,devices');
    const { data } = await this.request('devices', url.toString(), {
      headers: { accept: 'application/json', 'x-oesp-username': session.username, Referer: REFERER, ...(cookies ? { Cookie: cookies } : {}) },
    }, cookies);
    return { devices: Array.isArray(data.assignedDevices) ? data.assignedDevices : [], customer: data };
  }
}

class SessionManager {
  constructor({ storage, client = new AuthClient(), diagnostic = () => {}, now = () => new Date().toISOString() }) {
    Object.assign(this, { storage, client, diagnostic, now });
    this.queue = Promise.resolve();
    this.flight = null;
    this.record = null;
    this.pendingCommit = null;
    this.verifiedRevision = null;
    this.refreshNotDispatched = false;
  }

  exclusive(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }

  snapshot() {
    const record = this.record || this.read(STORE_KEY);
    if (record !== undefined && record !== null) {
      this.validateRecord(record);
      return { ...clone(record.session), cookieHeader: record.cookies || '' };
    }
    return this.readLegacy();
  }

  readLegacy() {
    return Object.fromEntries(['username', 'householdId', 'accessToken', 'refreshToken', 'refreshTokenExpiry', 'hashedCustomerId', 'cookieHeader']
      .map(key => [key, this.read(key)]));
  }

  fingerprint(session, cookies = session.cookieHeader || '') {
    // Local comparison only: never emit this digest or the underlying values.
    const values = ['username', 'householdId', 'accessToken', 'refreshToken', 'refreshTokenExpiry', 'hashedCustomerId']
      .map(key => session[key] ?? null);
    return createHash('sha256').update(JSON.stringify([...values, cookies])).digest('hex');
  }

  validateRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema !== 1
      || !record.session || typeof record.session !== 'object' || Array.isArray(record.session)
      || !['username', 'householdId', 'accessToken'].every(key => typeof record.session[key] === 'string' && record.session[key])
      || !['refreshToken', 'hashedCustomerId'].every(key => record.session[key] == null || typeof record.session[key] === 'string')
      // Expiry is opaque metadata: legacy Ziggo sessions may contain a number.
      // Preserve its representation/units so the legacy fingerprint stays valid.
      || !(record.session.refreshTokenExpiry == null || typeof record.session.refreshTokenExpiry === 'string'
        || (typeof record.session.refreshTokenExpiry === 'number' && Number.isFinite(record.session.refreshTokenExpiry) && record.session.refreshTokenExpiry >= 0))
      || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.cookies !== 'string'
      || (record.legacyFingerprint !== undefined && (typeof record.legacyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.legacyFingerprint)))
      || (record.refreshState != null && (typeof record.refreshState !== 'object' || Array.isArray(record.refreshState)
        || !['pending', 'uncertain', 'rejected'].includes(record.refreshState.kind)))) throw new AuthError('storage', 'load');
  }

  async checkLegacy() {
    const fingerprint = this.fingerprint(this.readLegacy());
    if (this.record.legacyFingerprint === fingerprint) return;
    // Earlier local v24 candidates had no baseline. Only an exact match is
    // unambiguous; do not infer freshness from JWT dates or rotate either token.
    if (this.record.legacyFingerprint === undefined && this.fingerprint(this.record.session, this.record.cookies) === fingerprint) {
      await this.commit({ ...this.record, legacyFingerprint: fingerprint }, 'legacy_baseline');
      return;
    }
    emit(this.diagnostic, 'auth.session.conflict', { phase: 'legacy_check', requiresRepair: true });
    throw new AuthError('session_conflict', 'legacy_check');
  }

  read(key) {
    try { return this.storage.get(key); } catch (_) { throw new AuthError('storage', 'load'); }
  }

  async commit(record, phase) {
    // Reject bad input before JSON cloning can turn NaN/Infinity into null and
    // before any invalid migration record can reach persistent storage.
    this.validateRecord(record);
    this.pendingCommit = { record: clone(record), phase };
    try {
      await this.storage.set(STORE_KEY, clone(record));
      this.record = clone(record);
      this.pendingCommit = null;
      emit(this.diagnostic, 'auth.session.persisted', { phase, revision: record.revision });
    } catch (_) {
      emit(this.diagnostic, 'auth.storage.failed', { phase, revision: record.revision });
      throw new AuthError('storage', phase);
    }
  }

  async load() {
    if (this.pendingCommit) await this.commit(this.pendingCommit.record, this.pendingCommit.phase);
    if (!this.record) {
      const saved = this.read(STORE_KEY);
      if (saved !== undefined && saved !== null) {
        this.snapshot(); // Validate before accepting an existing record.
        this.record = clone(saved);
      } else {
        const { cookieHeader, ...session } = this.snapshot();
        await this.commit({ schema: 1, revision: 0, session, cookies: cookieHeader ?? '', refreshState: null,
          legacyFingerprint: this.fingerprint(session, cookieHeader ?? '') }, 'migration');
      }
    }
    this.validateRecord(this.record);
    await this.checkLegacy();
    if (this.record.refreshState?.kind === 'pending') {
      if (this.refreshNotDispatched) {
        // A failed local intent write prevented dispatch in this process. It is
        // safe to clear that fence; a restarted process cannot make this claim.
        await this.commit({ ...this.record, refreshState: null }, 'refresh_not_dispatched');
        this.refreshNotDispatched = false;
      } else {
        await this.commit({ ...this.record, refreshState: { ...this.record.refreshState, kind: 'uncertain' } }, 'refresh_recovery');
        emit(this.diagnostic, 'auth.refresh.uncertain', { phase: 'refresh' });
      }
    }
  }

  ensure(config) {
    if (this.flight) return this.flight;
    const flight = this.exclusive(() => this.run(config)).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight;
    return flight;
  }

  async run(config) {
    await this.load();
    let { session, cookies } = this.record;
    if (!session.username || !session.householdId) throw new AuthError('session_missing', 'session');
    if (session.accessToken) {
      try { return await this.acceptMqtt(config, session, cookies); } catch (error) {
        if (!(error instanceof AuthError) || error.kind !== 'access_rejected') throw error;
        emit(this.diagnostic, 'auth.access.rejected', error);
      }
    }
    if (!session.refreshToken) throw new AuthError('session_missing', 'refresh');
    if (this.record.refreshState?.kind === 'rejected') throw new AuthError('refresh_rejected', 'refresh', this.record.refreshState.status);
    if (this.record.refreshState) throw new AuthError('refresh_uncertain', 'refresh', this.record.refreshState.status);

    // Persist the intent BEFORE dispatch: a crash or lost response must never
    // replay a possibly consumed, rotating refresh token after restart.
    this.refreshNotDispatched = true;
    await this.commit({ ...this.record, refreshState: { kind: 'pending', startedAt: this.now() } }, 'refresh_intent');
    this.refreshNotDispatched = false;
    let refreshed;
    try {
      refreshed = await this.client.refresh(config, session, cookies);
    } catch (error) {
      const safe = asAuthError(error, 'refresh');
      const kind = safe.kind === 'refresh_rejected' ? 'rejected' : 'uncertain';
      await this.commit({ ...this.record, refreshState: { kind, status: safe.status, startedAt: this.record.refreshState.startedAt } }, 'refresh_outcome');
      emit(this.diagnostic, kind === 'rejected' ? 'auth.refresh.rejected' : 'auth.refresh.uncertain', safe);
      throw safe;
    }
    emit(this.diagnostic, 'auth.refresh.received', { phase: 'refresh' });
    await this.commit({ schema: 1, revision: this.record.revision + 1, session: refreshed.session, cookies: refreshed.cookies, refreshState: null,
      legacyFingerprint: this.record.legacyFingerprint }, 'refresh');
    // No MQTT request is made until the entire new session record is durable.
    return this.acceptMqtt(config, this.record.session, this.record.cookies);
  }

  async acceptMqtt(config, session, cookies) {
    const mqtt = await this.client.mqtt(config, session, cookies);
    if (mqtt.cookies !== cookies) await this.commit({ ...this.record, cookies: mqtt.cookies }, 'mqtt_cookies');
    this.verifiedRevision = this.record.revision;
    emit(this.diagnostic, 'auth.session.verified', { phase: 'mqtt_token', revision: this.record.revision });
    // All callers receive an already-persisted session. Keep the legacy flag
    // false so unchanged Power preparation cannot re-save an obsolete snapshot.
    return { config, session: clone(this.record.session), cookies: this.record.cookies, mqttToken: mqtt.token, refreshed: false, persisted: true, authRevision: this.record.revision };
  }

  replace(session, cookies = '') {
    return this.exclusive(() => this.replaceInsideLock(session, cookies));
  }

  repair(authenticate) {
    return this.exclusive(async () => {
      // Explicit login replaces unusable state; it must not depend on loading,
      // migrating or committing an old record (including a failed pending save).
      const result = await authenticate();
      await this.replaceInsideLock(result.session, result.cookies);
    });
  }

  async replaceInsideLock(session, cookies = '') {
    const allowed = {};
    for (const key of ['username', 'householdId', 'accessToken', 'refreshToken', 'refreshTokenExpiry', 'hashedCustomerId']) {
      if (session[key] !== undefined) allowed[key] = session[key];
    }
    let revision = 0;
    const previous = this.record || this.read(STORE_KEY);
    try { this.validateRecord(previous); revision = previous.revision < Number.MAX_SAFE_INTEGER ? previous.revision : 0; }
    catch (_) { emit(this.diagnostic, 'auth.repair.replacing_unusable_record', { phase: 'repair' }); }
    const record = { schema: 1, revision: revision + 1, session: allowed, cookies, refreshState: null,
      legacyFingerprint: this.fingerprint(this.readLegacy()) };
    try { this.validateRecord(record); } catch (_) { throw new AuthError('invalid_response', 'repair'); }
    this.verifiedRevision = null;
    await this.commit(record, 'repair');
    this.refreshNotDispatched = false;
  }
}

module.exports = { AuthClient, SessionManager, AuthError, asAuthError, emit, STORE_KEY };
