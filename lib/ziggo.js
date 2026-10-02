'use strict';

const mqtt = require('mqtt');
const WebSocket = require('ws');
const { randomUUID, createHash } = require('node:crypto');

const CONFIG_URL = 'https://prod.spark.ziggogo.tv/nl/en/config-service/conf/web/backoffice.json';
const REFERER = 'https://www.ziggogo.tv/';

function tokenFingerprint(value) {
  if (!value) return 'none';
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function tokenMeta(session) {
  return {
    access: tokenFingerprint(session?.accessToken),
    refresh: tokenFingerprint(session?.refreshToken),
    refreshExpiry: session?.refreshTokenExpiry || null,
    tracking: session?.hashedCustomerId ? 'present' : 'missing',
  };
}

function safeErrorDetail(data) {
  // Only expose diagnostic fields by name. Never dump the full Ziggo response,
  // because it could contain session material.
  const allowed = new Set(['error', 'errorCode', 'code', 'reason', 'message', 'description', 'status', 'type', 'title']);
  const parts = [];
  const seen = new Set();

  const redact = value => {
    let text = String(value).replace(/[\r\n]+/g, ' ').trim();
    text = text.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
    text = text.replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}/g, '[REDACTED_TOKEN]');
    // Long opaque strings are more likely to be IDs/tokens than useful errors.
    text = text.replace(/\b[A-Za-z0-9_=-]{80,}\b/g, '[REDACTED_OPAQUE]');
    if (text.length > 220) text = `${text.slice(0, 220)}...`;
    return text;
  };

  const walk = (value, path = '', depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.slice(0, 8).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (allowed.has(key) && ['string', 'number', 'boolean'].includes(typeof child)) {
        const text = redact(child);
        if (text) parts.push(`${childPath}=${text}`);
      }
      if (child && typeof child === 'object') walk(child, childPath, depth + 1);
      if (parts.length >= 12) return;
    }
  };
  walk(data);
  return parts.slice(0, 12).join(', ');
}

async function readJson(response, label) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (_) {
    const contentType = response.headers.get('content-type') || 'onbekend';
    throw new Error(`${label}: HTTP ${response.status}; niet-JSON antwoord (content-type=${contentType}, lengte=${text.length})`);
  }
  if (!response.ok) {
    const detail = safeErrorDetail(data);
    const shape = data && typeof data === 'object'
      ? `velden=${Array.isArray(data) ? '[array]' : Object.keys(data).slice(0, 12).join('|') || '(geen)'}`
      : `type=${typeof data}`;
    throw new Error(`${label}: HTTP ${response.status}${detail ? ` (${detail})` : ` (${shape})`}`);
  }
  return data;
}

function cookieHeader(response) {
  const h = response.headers;
  const all = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
  const raw = all.length ? all : (h.get('set-cookie') ? [h.get('set-cookie')] : []);
  return raw.map(v => v.split(';', 1)[0]).filter(Boolean).join('; ');
}


function parseSetCookies(response) {
  const h = response.headers;
  const raw = typeof h.getSetCookie === 'function' ? h.getSetCookie() : (h.get('set-cookie') ? [h.get('set-cookie')] : []);
  return raw.map(v => v.split(';', 1)[0]).filter(v => v.includes('='));
}

function mergeCookies(existing = '', response) {
  const jar = new Map();
  for (const part of String(existing || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const part of parseSetCookies(response)) {
    const i = part.indexOf('=');
    const name = part.slice(0, i);
    const value = part.slice(i + 1);
    if (value) jar.set(name, value); else jar.delete(name);
  }
  return [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
}

function cookieMeta(cookieString = '') {
  const names = String(cookieString || '').split(/;\s*/).filter(Boolean).map(v => v.split('=',1)[0]).sort();
  return { count: names.length, names, fingerprint: tokenFingerprint(cookieString) };
}

async function getConfig() {
  const r = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } });
  return readJson(r, 'Endpointconfig');
}

async function login(username, password) {
  const config = await getConfig();
  const authBase = config?.authorizationService?.URL;
  if (!authBase) throw new Error('authorizationService.URL ontbreekt in Ziggo-config.');
  const r = await fetch(`${authBase}/v1/authorization`, {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/json; charset=utf-8', 'x-device-code': 'web' },
    body: JSON.stringify({ username, password, stayLoggedIn: false }),
  });
  const cookies = mergeCookies('', r);
  let session;
  try { session = await r.json(); } catch (_) { session = null; }
  if (!r.ok) throw new Error(`Ziggo-login geweigerd (HTTP ${r.status}).`);
  if (!session?.householdId) throw new Error('Login gaf geen householdId terug.');
  if (!session.username) session.username = username;
  return { config, session, cookies };
}

async function getDevices(config, session, cookies = '') {
  const base = config?.personalizationService?.URL;
  if (!base) throw new Error('personalizationService.URL ontbreekt in Ziggo-config.');
  const url = new URL(`${base}/v1/customer/${encodeURIComponent(session.householdId)}`);
  url.searchParams.set('with', 'profiles,devices');
  const headers = { accept: 'application/json', 'x-oesp-username': session.username, Referer: REFERER };
  if (cookies) headers.Cookie = cookies;
  const r = await fetch(url, { headers });
  const customer = await readJson(r, 'Apparaatdetectie');
  return { devices: Array.isArray(customer?.assignedDevices) ? customer.assignedDevices : [], customer };
}

async function refreshSession(config, stored, cookies = '', diag = () => {}) {
  const base = config?.authorizationService?.URL;
  if (!base) throw new Error('authorizationService.URL ontbreekt.');
  if (!stored?.refreshToken || !stored?.username) throw new Error('Geen opgeslagen Ziggo-sessie beschikbaar. Koppel het apparaat opnieuw.');
  diag('refresh.request', { ...tokenMeta(stored), cookies: cookieMeta(cookies) });
  const r = await fetch(`${base}/v1/authorization/refresh`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json; charset=UTF-8',
      'x-oesp-username': stored.username,
      ...(stored.hashedCustomerId ? { 'x-tracking-id': stored.hashedCustomerId } : {}),
      ...(cookies ? { Cookie: cookies } : {}),
    },
    body: JSON.stringify({ refreshToken: stored.refreshToken, username: stored.username }),
  });
  const nextCookies = mergeCookies(cookies, r);
  diag('refresh.cookies', { before: cookieMeta(cookies), after: cookieMeta(nextCookies) });
  let session;
  try {
    session = await readJson(r, 'Sessievernieuwing');
  } catch (err) {
    diag('refresh.failed', { ...tokenMeta(stored), httpError: err.message });
    throw err;
  }
  if (!session?.accessToken || !session?.householdId) throw new Error('Ziggo gaf geen bruikbare vernieuwde sessie terug.');
  if (!session.username) session.username = stored.username;
  // Ziggo may omit unchanged fields. Never erase still-valid session material.
  session.householdId = session.householdId || stored.householdId;
  session.refreshToken = session.refreshToken || stored.refreshToken;
  session.refreshTokenExpiry = session.refreshTokenExpiry || stored.refreshTokenExpiry || null;
  session.hashedCustomerId = stored.hashedCustomerId || null;
  diag('refresh.success', { before: tokenMeta(stored), after: tokenMeta(session), refreshRotated: tokenFingerprint(stored.refreshToken) !== tokenFingerprint(session.refreshToken) });
  return { session, cookies: nextCookies };
}

async function getMqttToken(config, session, cookies = '') {
  const base = config?.authorizationService?.URL;
  if (!base) throw new Error('authorizationService.URL ontbreekt.');
  const r = await fetch(`${base}/v1/mqtt/token`, {
    headers: { 'X-OESP-Token': session.accessToken, 'X-OESP-Username': session.username, ...(cookies ? { Cookie: cookies } : {}) },
  });
  return readJson(r, 'MQTT-token');
}

async function ensureSession(config, stored, cookies = '', diag = () => {}) {
  if (stored?.accessToken) {
    try {
      const tokenData = await getMqttToken(config, stored, cookies);
      if (tokenData?.token) {
        diag('access.accepted', tokenMeta(stored));
        return { session: stored, mqttToken: tokenData.token, cookies, refreshed: false };
      }
    } catch (err) {
      diag('access.rejected', { ...tokenMeta(stored), error: err.message });
      // Access token may be expired. Try refresh token next.
    }
  }
  const refreshedResult = await refreshSession(config, stored, cookies, diag);
  const session = refreshedResult.session;
  const nextCookies = refreshedResult.cookies;
  const tokenData = await getMqttToken(config, session, nextCookies);
  if (!tokenData?.token) throw new Error('Ziggo gaf geen MQTT-token terug.');
  return { session, mqttToken: tokenData.token, cookies: nextCookies, refreshed: true };
}

function sendKey(config, session, deviceId, mqttToken, w3cKey) {
  return new Promise((resolve, reject) => {
    const broker = config?.mqttBroker?.URL;
    if (!broker) return reject(new Error('mqttBroker.URL ontbreekt in Ziggo-config.'));
    const clientId = randomUUID();
    let settled = false;
    const createWebsocket = url => new WebSocket(url, ['mqtt', 'mqttv3.1', 'mqttv3.11']);
    const client = mqtt.connect(broker, {
      createWebsocket, clientId, connectTimeout: 10000,
      username: session.householdId, password: mqttToken, reconnectPeriod: 0,
    });
    const finish = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(true); } catch (_) {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('MQTT-verbinding gaf binnen 12 seconden geen resultaat.')), 12000);
    client.once('error', e => finish(new Error(`MQTT-fout: ${e.message}`)));
    client.once('connect', () => {
      const topic = `${session.householdId}/${deviceId}`;
      const payload = JSON.stringify({
        source: clientId, type: 'CPE.KeyEvent', runtimeType: 'key', id: randomUUID(),
        status: { w3cKey, uniCodeChar: null, eventType: 'keyDownUp' },
      });
      client.publish(topic, payload, { qos: 2, retain: true }, err => finish(err ? new Error(`${w3cKey} publiceren mislukt: ${err.message}`) : null));
    });
  });
}


function monitorStatus(config, session, deviceId, mqttToken, handlers = {}) {
  const broker = config?.mqttBroker?.URL;
  if (!broker) throw new Error('mqttBroker.URL ontbreekt in Ziggo-config.');
  const clientId = randomUUID();
  const createWebsocket = url => new WebSocket(url, ['mqtt', 'mqttv3.1', 'mqttv3.11']);
  const client = mqtt.connect(broker, {
    createWebsocket, clientId, connectTimeout: 10000,
    username: session.householdId, password: mqttToken,
    reconnectPeriod: 10000,
  });
  const topic = `${session.householdId}/${deviceId}/status`;
  client.on('connect', () => {
    handlers.onConnect?.(topic);
    client.subscribe(topic, { qos: 0 }, err => {
      if (err) handlers.onError?.(new Error(`Status-subscribe mislukt: ${err.message}`));
    });
  });
  client.on('message', (receivedTopic, buffer) => {
    if (receivedTopic !== topic) return;
    try {
      const message = JSON.parse(buffer.toString());
      handlers.onStatus?.(message);
    } catch (err) {
      handlers.onError?.(new Error(`Ongeldig statusbericht: ${err.message}`));
    }
  });
  client.on('reconnect', () => handlers.onReconnect?.());
  client.on('offline', () => handlers.onOffline?.());
  client.on('error', err => handlers.onError?.(err));
  client.on('close', () => handlers.onClose?.());
  return client;
}

module.exports = { getConfig, login, getDevices, ensureSession, sendKey, monitorStatus, tokenMeta, cookieMeta };
