'use strict';

const WINDOW_MS = 10 * 60 * 1000;
const PHASES = new Set(['config', 'mqtt_token', 'refresh']);
const savedPhases = new Set(['refresh_intent', 'refresh', 'mqtt_cookies']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const only = (data, keys) => Object.keys(data).every(key => keys.includes(key));

// A closed allowlist: unknown events/fields and unexpected failures remain full
// ordinary entries. No input message or arbitrary field is copied to a summary.
function routine(message) {
  if (typeof message !== 'string' || !message.startsWith('AUTH ')) return null;
  const match = /^AUTH (auth\.[a-z.]+) (\{.*\})$/.exec(message);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[2]); } catch (_) { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const event = match[1];
  if (event === 'auth.request' && only(data, ['phase']) && PHASES.has(data.phase)) {
    return { counter: 'request.' + data.phase };
  }
  if (event === 'auth.request.succeeded' && only(data, ['phase', 'status'])
    && PHASES.has(data.phase) && [200, 201, 204].includes(data.status)) {
    return { counter: 'success.' + data.phase + '.' + data.status };
  }
  if (['auth.request.failed', 'auth.access.rejected'].includes(event)
    && only(data, ['phase', 'kind', 'status', 'requiresRepair'])
    && data.phase === 'mqtt_token' && data.kind === 'access_rejected'
    && data.status === 401 && data.requiresRepair === false) {
    return { counter: event === 'auth.request.failed' ? 'request401' : 'accessRejected' };
  }
  if (event === 'auth.session.persisted' && only(data, ['phase', 'revision'])
    && savedPhases.has(data.phase) && integer(data.revision)) {
    return { counter: 'sessionSaved.' + data.phase, revision: data.revision };
  }
  if (event === 'auth.refresh.received' && only(data, ['phase']) && data.phase === 'refresh') {
    return { counter: 'refreshReceived' };
  }
  if (event === 'auth.session.verified' && only(data, ['phase', 'revision'])
    && data.phase === 'mqtt_token' && integer(data.revision)) {
    return { counter: 'sessionVerified', revision: data.revision };
  }
  if (event === 'auth.watchdog.succeeded' && only(data, ['phase']) && data.phase === 'watchdog') {
    return { counter: 'watchdogSucceeded' };
  }
  return null;
}

class DiagnosticCompactor {
  reset() { this.group = null; }

  append(lines, message, time) {
    const item = routine(message), stamp = Date.parse(time);
    if (!item || !Number.isFinite(stamp)) {
      lines.push(`${time} ${message}`);
      return;
    }
    const bucket = Math.floor(stamp / WINDOW_MS);
    let index = this.group ? lines.lastIndexOf(this.group.line) : -1;
    if (!this.group || this.group.bucket !== bucket || index < 0 || stamp < this.group.lastStamp) {
      this.group = { bucket, lastStamp: stamp, from: time, to: time, counts: {} };
      index = lines.length;
    }
    const group = this.group;
    group.to = time;
    group.lastStamp = stamp;
    group.counts[item.counter] = (group.counts[item.counter] || 0) + 1;
    if (item.revision !== undefined) {
      group.revisionMin = Math.min(group.revisionMin ?? item.revision, item.revision);
      group.revisionMax = Math.max(group.revisionMax ?? item.revision, item.revision);
    }
    const summary = { schema: 1, from: group.from, to: group.to, counts: { ...group.counts } };
    if (group.revisionMin !== undefined) Object.assign(summary, { revisionMin: group.revisionMin, revisionMax: group.revisionMax });
    group.line = `${group.from} AUTH summary ${JSON.stringify(summary)}`;
    lines[index] = group.line;
  }
}

module.exports = { DiagnosticCompactor, WINDOW_MS };
