'use strict';

// One controller per device. No network dependencies: all I/O is injected.
class PowerController {
  constructor({ prepare, journal, log = () => {}, now = () => performance.now(),
    timers = { setTimeout, clearTimeout }, preparationMs = 15000,
    confirmationMs = 20000, freshnessMs = Infinity, initializationMs = 10000 }) {
    Object.assign(this, { prepare, journal, log, now, timers, preparationMs, confirmationMs, freshnessMs, initializationMs });
    this.state = 'unknown'; this.observed = null; this.connected = false;
    this.generation = 0; this.sequence = 0; this.tx = null;
    this.desired = null; this.waiters = []; this.closed = false;
    this.initialCandidate = null; this.initializationTimer = null;
  }

  restore(record) {
    if (record && typeof record.target === 'boolean') {
      this.tx = { id: record.id, target: record.target, published: true, transportDone: true,
        restored: true, generation: -1, baseline: this.sequence, abort: new AbortController() };
      this.state = 'uncertain';
      this.emit('restore.uncertain');
    }
  }

  emit(event, fields = {}) {
    this.log(event, { state: this.state, transaction: this.tx?.id ?? null,
      target: this.tx?.target ?? null, desired: this.desired, ...fields });
  }

  connect(generation) {
    if (this.closed || generation <= this.generation) return;
    if (this.tx && this.state !== 'uncertain') this.fail(this.tx, 'Statusverbinding vervangen.', this.tx.published);
    this.generation = generation; this.connected = true; this.observed = null;
    this.initialCandidate = null;
    this.emit('connection.ready', { generation });
  }

  disconnect(generation) {
    if (this.closed || generation !== this.generation) return;
    this.connected = false; this.observed = null;
    this.initialCandidate = null;
    this.cancelInitialization('Statusverbinding verbroken tijdens initialisatie.');
    this.emit('connection.lost', { generation });
    if (this.tx) this.fail(this.tx, 'Statusverbinding verbroken.', this.tx.published);
    else this.state = 'unknown';
  }

  fresh() {
    return this.connected && this.observed && this.observed.generation === this.generation
      && this.now() - this.observed.at <= this.freshnessMs;
  }

  observe(value, meta = {}) {
    // A snapshot is useful diagnostic evidence, never authority to toggle or confirm.
    if (meta.retain && typeof value === 'boolean' && this.connected && !this.closed
      && meta.generation === this.generation && !meta.dup && !meta.stale) {
      if (!this.observed && !this.tx) {
        this.initialCandidate = { value, generation: meta.generation, at: this.now() };
        this.emit('status.initialCandidate', { value, confidence: 'unverified_retained' });
      } else this.emit('status.ignored', { reason: 'retained' });
      return false;
    }
    if (this.closed || typeof value !== 'boolean' || !this.connected || meta.generation !== this.generation
      || meta.retain || meta.dup || meta.stale) {
      this.emit('status.ignored', { reason: meta.retain ? 'retained' : meta.dup ? 'duplicate' : 'invalid_or_old_connection' });
      return false;
    }
    const seq = ++this.sequence;
    this.observed = { value, at: this.now(), generation: meta.generation, seq };
    this.initialCandidate = null;
    this.emit('status.accepted', { value, sequence: seq, generation: meta.generation });
    const tx = this.tx;
    if (tx?.published && value !== tx.target) tx.confirmed = false;
    if (tx?.published && !meta.buffered && value === tx.target && seq > tx.baseline
      && (tx.generation === meta.generation || this.state === 'uncertain')) {
      tx.confirmed = true;
      if (tx.transportDone) void this.complete(tx);
    } else if (!tx) {
      this.state = 'ready';
      // Let a complete subscription buffer drain before evaluating queued goals.
      if (this.desired !== null) Promise.resolve().then(() => {
        if (!this.closed && !this.tx && this.fresh()) {
          this.clearInitializationTimer();
          this.resume();
        }
      });
    }
    return true;
  }

  request(target, source = 'onoff') {
    if (this.closed) return Promise.reject(new Error('Powercontroller gestopt.'));
    if (typeof target !== 'boolean') return Promise.reject(new Error('Ongeldige Power-doelstatus.'));
    this.emit('request', { requested: target, source });
    if (this.state === 'uncertain' || this.state === 'recovering') return Promise.reject(new Error('Uitkomst vorige Power-opdracht onbekend; wacht op live status.'));
    if (!this.tx && !this.fresh() && this.observed) return Promise.reject(new Error('Geen betrouwbare actuele Powerstatus. Wacht op live Ziggo-status.'));
    if (!this.tx && this.fresh() && this.observed.value === target) {
      this.emit('request.noop'); return Promise.resolve();
    }
    this.desired = target;
    // Latest desired state wins. Superseded callers receive an explicit failure.
    const same = [];
    for (const waiter of this.waiters) {
      if (waiter.target === target) same.push(waiter);
      else waiter.reject(new Error('Power-verzoek vervangen door een tegengesteld verzoek.'));
    }
    this.waiters = same;
    const result = new Promise((resolve, reject) => this.waiters.push({ target, resolve, reject }));
    if (!this.tx) {
      if (this.fresh()) {
        this.clearInitializationTimer();
        this.start(); // reservation happens synchronously, before any await
      } else {
        this.state = 'initializing';
        if (this.initializationTimer === null) {
          this.initializationTimer = this.timers.setTimeout(() => {
            this.cancelInitialization('Geen betrouwbare beginstatus ontvangen; Power is niet verstuurd.');
          }, this.initializationMs);
        }
        this.emit('initialization.waiting');
      }
    }
    return result;
  }

  clearInitializationTimer() {
    if (this.initializationTimer !== null) this.timers.clearTimeout(this.initializationTimer);
    this.initializationTimer = null;
  }

  cancelInitialization(message) {
    if (this.tx) return;
    this.clearInitializationTimer();
    for (const w of this.waiters) w.reject(new Error(message));
    this.waiters = []; this.desired = null;
    this.state = this.fresh() ? 'ready' : 'unknown';
    this.emit('initialization.cancelled', { reason: message });
  }

  toggle() {
    if (this.tx || !this.fresh()) return Promise.reject(new Error('Power-knop geblokkeerd: opdracht loopt of status is onbekend.'));
    return this.request(!this.observed.value, 'ziggo_power');
  }

  start() {
    const tx = { id: require('node:crypto').randomUUID(), target: this.desired,
      published: false, transportDone: false, abort: new AbortController() };
    this.tx = tx; this.state = 'preparing';
    tx.timer = this.timers.setTimeout(() => this.fail(tx, 'Power-voorbereiding duurde te lang.', tx.published), this.preparationMs);
    this.emit('transition.reserved');
    void this.run(tx);
  }

  async run(tx) {
    try {
      const send = await this.prepare(tx.abort.signal);
      if (this.tx !== tx || this.closed || tx.abort.signal.aborted) return;
      if (!this.fresh()) return this.fail(tx, 'Powerstatus niet meer betrouwbaar.', false);
      tx.target = this.desired;
      if (this.observed.value === tx.target) return this.complete(tx);
      // Persist before any network publication; restart must never replay this intent.
      await this.journal({ id: tx.id, target: tx.target, createdAt: new Date().toISOString() });
      if (this.tx !== tx || this.closed || tx.abort.signal.aborted) return;
      if (!this.fresh()) return this.fail(tx, 'Powerstatus niet meer betrouwbaar.', false);
      // A contradictory request during journal I/O must not send the old target.
      if (this.desired !== tx.target || this.observed.value === tx.target) {
        await this.journal(null);
        if (this.tx !== tx || this.closed || tx.abort.signal.aborted) return;
        this.timers.clearTimeout(tx.timer); this.tx = null; this.state = 'ready';
        this.resume(); return;
      }
      await send({ signal: tx.abort.signal, onPublish: () => {
        if (this.tx !== tx || this.closed || !this.fresh() || this.desired !== tx.target
          || this.observed.value === tx.target) { this.emit('publish.cancelled'); return false; }
        tx.published = true; tx.baseline = this.sequence; tx.generation = this.generation;
        this.state = 'waiting'; this.timers.clearTimeout(tx.timer);
        tx.timer = this.timers.setTimeout(() => this.fail(tx, 'Geen betrouwbare Power-statusbevestiging ontvangen.', true), this.confirmationMs);
        this.emit('publish.begin');
        return true;
      } });
      if (this.tx !== tx || this.closed) return;
      tx.transportDone = true; this.emit('publish.ack');
      if (!tx.published) return this.complete(tx);
      if (tx.confirmed) await this.complete(tx);
    } catch (err) {
      if (this.tx === tx && !this.closed && !tx.abort.signal.aborted) this.fail(tx, 'Power-voorbereiding of verzending mislukt.', tx.published);
    }
  }

  fail(tx, message, uncertain) {
    if (this.tx !== tx || tx.completing) return;
    this.timers.clearTimeout(tx.timer);
    this.state = uncertain ? 'uncertain' : 'recovering';
    tx.transportDone = true;
    tx.abort.abort();
    this.emit('transition.failed', { reason: message, uncertain });
    for (const w of this.waiters) w.reject(new Error(message));
    this.waiters = []; this.desired = null;
    if (uncertain) return; // retain journal and original target; never retry
    tx.completing = true;
    void this.journal(null).then(() => {
      if (this.tx === tx && !this.closed) { this.tx = null; this.state = this.fresh() ? 'ready' : 'unknown'; }
    }).catch(() => {
      if (this.tx !== tx || this.closed) return;
      tx.completing = false; tx.published = true; tx.baseline = this.sequence; tx.generation = -1;
      this.state = 'uncertain'; this.emit('journal.failed');
    });
  }

  async complete(tx) {
    if (this.tx !== tx || tx.completing || this.closed) return;
    tx.completing = true; this.timers.clearTimeout(tx.timer);
    try {
      await this.journal(null);
      if (this.tx !== tx || this.closed) return;
      this.emit('transition.complete', { recovery: this.state === 'uncertain' });
      this.tx = null; this.state = this.fresh() ? 'ready' : 'unknown';
      this.resume();
    } catch (err) {
      tx.completing = false;
      this.fail(tx, 'Power-journal kon niet worden vrijgegeven.', true);
    }
  }

  resume() {
    if (this.desired === null) return;
    if (!this.fresh()) {
      for (const w of this.waiters) w.reject(new Error('Powerstatus onbekend.'));
      this.waiters = []; this.desired = null; return;
    }
    if (this.observed.value !== this.desired) { this.start(); return; }
    for (const w of this.waiters) w.resolve();
    this.waiters = []; this.desired = null;
  }

  close() {
    this.closed = true;
    this.clearInitializationTimer();
    if (this.tx) { this.timers.clearTimeout(this.tx.timer); this.tx.abort.abort(); }
    for (const w of this.waiters) w.reject(new Error('Powercontroller gestopt.'));
    this.waiters = []; this.desired = null;
  }
}

module.exports = PowerController;
