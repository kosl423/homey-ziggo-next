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

function cookieMeta(cookieString = '') {
  const names = String(cookieString || '').split(/;\s*/).filter(Boolean).map(v => v.split('=', 1)[0]).sort();
  return { count: names.length, names, fingerprint: tokenFingerprint(cookieString) };
}

const { AuthClient, AuthError } = require('./auth');

function getConfig(options = {}) { return new AuthClient(options).getConfig(); }
function login(username, password, options = {}) { return new AuthClient(options).login(username, password); }
function getDevices(config, session, cookies = '', options = {}) { return new AuthClient(options).getDevices(config, session, cookies); }

// Authentication without durable storage is deliberately refused. Device callers
// use SessionManager, which owns the complete refresh-and-persist transaction.
function ensureSession(config, stored, cookies, diagnostic, { manager } = {}) {
  if (!manager) return Promise.reject(new AuthError('storage', 'session'));
  return manager.ensure(config);
}

function sendKey(config, session, deviceId, mqttToken, w3cKey, options = {}) {
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
      options.signal?.removeEventListener('abort', onAbort);
      try { client.end(true); } catch (_) {}
      err ? reject(err) : resolve();
    };
    const timer = setTimeout(() => finish(new Error('MQTT-verbinding gaf binnen 12 seconden geen resultaat.')), 12000);
    const onAbort = () => finish(new Error('Toetscommando geannuleerd.'));
    // Keep an error handler even after cancellation: a closing socket can emit late errors.
    client.on('error', e => finish(new Error(`MQTT-fout: ${e.message}`)));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    client.once('connect', () => {
      if (settled) return;
      try {
        if (options.onPublish?.() === false) { finish(); return; }
      } catch (err) { finish(err); return; }
      const topic = `${session.householdId}/${deviceId}`;
      const payload = JSON.stringify({
        source: clientId, type: 'CPE.KeyEvent', runtimeType: 'key', id: randomUUID(),
        status: { w3cKey, uniCodeChar: null, eventType: 'keyDownUp' },
      });
      // retain remains unchanged until Ziggo compatibility is established.
      try {
        client.publish(topic, payload, { qos: 2, retain: true }, err => finish(err ? new Error(`${w3cKey} publiceren mislukt: ${err.message}`) : null));
      } catch (err) { finish(err); }
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
  let generation = 0;
  let subscribed = false;
  let pendingStatuses = [];
  let overflow = false;
  const reset = () => { subscribed = false; pendingStatuses = []; overflow = false; };
  client.on('connect', () => {
    reset();
    const current = ++generation;
    handlers.onConnect?.(topic);
    client.subscribe(topic, { qos: 0 }, (err, granted) => {
      if (current !== generation) return;
      if (granted?.some(item => item.qos === 128)) err = new Error('Status-subscription geweigerd.');
      if (err) handlers.onError?.(new Error(`Status-subscribe mislukt: ${err.message}`));
      else if (overflow) handlers.onError?.(new Error('Statusbuffer vol; initialisatie afgebroken.'));
      else {
        // onSubscribed makes the controller ready to consume this generation.
        handlers.onSubscribed?.();
        const early = pendingStatuses;
        pendingStatuses = [];
        for (const entry of early) {
          if (current !== generation) return;
          handlers.onStatus?.(entry.message, { ...entry.metadata, buffered: true });
        }
        subscribed = true;
      }
      if (err || overflow) reset();
    });
  });
  client.on('message', (receivedTopic, buffer, packet = {}) => {
    if (receivedTopic !== topic) return;
    try {
      const message = JSON.parse(buffer.toString());
      const metadata = { retain: Boolean(packet.retain), dup: Boolean(packet.dup), qos: packet.qos };
      if (!subscribed) {
        if (pendingStatuses.length >= 100) { overflow = true; return; }
        pendingStatuses.push({ message, metadata });
      } else handlers.onStatus?.(message, metadata);
    } catch (err) {
      ++generation;
      reset();
      handlers.onError?.(new Error(`Ongeldig statusbericht: ${err.message}`));
    }
  });
  client.on('reconnect', () => handlers.onReconnect?.());
  client.on('offline', () => { ++generation; reset(); handlers.onOffline?.(); });
  client.on('error', err => { ++generation; reset(); handlers.onError?.(err); });
  client.on('close', () => { ++generation; reset(); handlers.onClose?.(); });
  return client;
}

module.exports = { getConfig, login, getDevices, ensureSession, sendKey, monitorStatus, tokenMeta, cookieMeta };
