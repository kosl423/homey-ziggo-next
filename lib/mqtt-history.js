'use strict';
const { randomUUID } = require('node:crypto');

const KEY = 'mqttEventHistory';
const LIMIT = 50;
const EVENTS = new Set(['monitor.start', 'reconnect', 'connected', 'subscribe', 'ready',
  'offline', 'error', 'close', 'connection.lost', 'connection.restored', 'monitor.failed']);
const NUMBERS = ['device', 'monitor', 'generation', 'attempt'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Reconstruct records from a closed schema: never persist arbitrary error fields,
// topics, device identifiers, payloads or authentication material.
function clean(record) {
  if (!record || !EVENTS.has(record.event) || typeof record.run !== 'string'
    || !uuid.test(record.run) || typeof record.time !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(record.time)
    || !Number.isFinite(Date.parse(record.time))) return null;
  const safe = { time: record.time, run: record.run, event: record.event };
  for (const key of NUMBERS) {
    if (!Number.isSafeInteger(record[key]) || record[key] < 0) return null;
    safe[key] = record[key];
  }
  return safe;
}

class MqttHistory {
  constructor(settings) {
    this.settings = settings;
    this.run = randomUUID();
    this.devices = new WeakMap();
    this.deviceSequence = 0;
    this.lines = [];
    this.failed = false;
    try {
      const saved = settings.get(KEY);
      if (saved?.schema === 1 && Array.isArray(saved.events)) {
        this.lines = saved.events.slice(-LIMIT).map(clean).filter(Boolean);
      }
    } catch (_) { this.failed = true; }
  }

  record(device, event, fields = {}) {
    if (!EVENTS.has(event)) return;
    if (!this.devices.has(device)) this.devices.set(device, ++this.deviceSequence);
    const entry = clean({ ...fields, event, device: this.devices.get(device),
      time: new Date().toISOString(), run: this.run });
    if (!entry) return;
    this.lines.push(entry);
    this.lines = this.lines.slice(-LIMIT);
    this.dirty = true;
    this.flush();
  }

  flush() {
    if (this.pending) return this.pending;
    // One active write and one bounded in-memory snapshot, even during a storm.
    this.pending = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await this.settings.set(KEY, { schema: 1, events: this.lines.map(e => ({ ...e })) });
          this.failed = false;
        } catch (_) {
          this.failed = true;
          this.dirty = false;
          // Retry on the next event; diagnostics must never block MQTT recovery.
          break;
        }
      }
    })().finally(() => {
      this.pending = null;
      // An event can arrive after the loop finishes but before this finalizer.
      if (this.dirty) return this.flush();
    });
    return this.pending;
  }
}

module.exports = { MqttHistory, KEY, LIMIT };
