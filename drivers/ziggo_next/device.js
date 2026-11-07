'use strict';
const Homey = require('homey');
const Ziggo = require('../../lib/ziggo');
const PowerController = require('../../lib/power-controller');
const { AuthClient, SessionManager, AuthError, asAuthError, emit } = require('../../lib/auth');

class ZiggoNextDevice extends Homey.Device {
  async onInit() {
    this.log('Ziggo Next Mini gestart.');
    this.statusClient = null;
    this.statusReconnectTimer = null;
    this.actualPowerState = null;
    this.sessionRefreshPromise = null;
    this.sessionDiagSeq = 0;
    this.monitorEpoch = 0;
    this.connectionSequence = 0;
    this.statusWriteQueue = Promise.resolve();
    this.journalQueue = Promise.resolve();
    this.warningQueue = Promise.resolve();
    this.deleted = false;
    this.authRetryAt = 0;
    this.authRetryAttempt = 0;
    this.authRetryTimer = null;
    this.authUnavailable = false;
    this.authConnectionReady = false;
    this.authAvailabilityQueue = Promise.resolve();
    this.authRecoveryEpoch = 0;
    this.authRepairEpoch = 0;
    this.power = new PowerController({
      prepare: async signal => {
        const config = await Ziggo.getConfig();
        const { session, mqttToken, cookies, refreshed } = await this.ensureSessionLocked(config);
        if (refreshed) await this.persistSession(session, cookies);
        if (signal.aborted) throw new Error('Power-voorbereiding geannuleerd.');
        return options => Ziggo.sendKey(config, session, this.getData().id, mqttToken, 'Power', options);
      },
      journal: record => {
        const write = this.journalQueue.then(() => this.setStoreValue('pendingPower', record));
        this.journalQueue = write.catch(() => {});
        return write;
      },
      log: (event, fields) => this.powerDiagnostic(event, fields),
    });
    this.power.restore(this.getStoreValue('pendingPower'));

    for (const capability of ['onoff', 'ziggo_power', 'ziggo_channel_up', 'ziggo_channel_down', 'ziggo_digit_1', 'ziggo_digit_2', 'ziggo_digit_3', 'ziggo_digit_4', 'ziggo_digit_5', 'ziggo_digit_6', 'ziggo_digit_7', 'ziggo_digit_8', 'ziggo_digit_9', 'ziggo_digit_0', 'ziggo_ok', 'ziggo_back', 'ziggo_nav_up', 'ziggo_nav_down', 'ziggo_nav_left', 'ziggo_nav_right']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
        this.log(`Capability toegevoegd: ${capability}`);
      }
    }

    // Native Homey power state. This is state-aware: never blindly toggle when
    // Ziggo already reports the requested state.
    this.registerCapabilityListener('onoff', async value => {
      await this.power.request(value);
    });

    // Keep the proven raw Power button for now as a fallback/manual toggle.
    this.registerCapabilityListener('ziggo_power', async () => {
      await this.sendKey('Power');
    });
    this.registerCapabilityListener('ziggo_channel_up', async () => {
      await this.sendKey('ChannelUp');
    });
    this.registerCapabilityListener('ziggo_channel_down', async () => {
      await this.sendKey('ChannelDown');
    });

    // Numeric keys use the confirmed EOS KeyEvents "0" through "9".
    for (let digit = 0; digit <= 9; digit++) {
      this.registerCapabilityListener(`ziggo_digit_${digit}`, async () => {
        await this.sendKey(String(digit));
      });
    }
    this.registerCapabilityListener('ziggo_ok', async () => {
      await this.sendKey('Enter');
    });
    this.registerCapabilityListener('ziggo_back', async () => {
      await this.sendKey('Escape');
    });
    this.registerCapabilityListener('ziggo_nav_up', async () => {
      await this.sendKey('ArrowUp');
    });
    this.registerCapabilityListener('ziggo_nav_down', async () => {
      await this.sendKey('ArrowDown');
    });
    this.registerCapabilityListener('ziggo_nav_left', async () => {
      await this.sendKey('ArrowLeft');
    });
    this.registerCapabilityListener('ziggo_nav_right', async () => {
      await this.sendKey('ArrowRight');
    });

    // Keep Homey's native on/off state synchronized with Ziggo's realtime status.
    this.startStatusMonitor().catch(() => { this.mqttEvent('monitor.failed'); this.diag('STATUS start.failed'); this.scheduleStatusRestart(); });

    // Runs on Homey itself, so laptop standby does not interrupt the lifecycle test.
    this.sessionWatchdogTimer = setInterval(() => {
      this.runSessionWatchdog().catch(err => this.diag(`WATCHDOG failed: ${err.message}`));
    }, 10 * 60 * 1000);
  }

  mqttEvent(event) {
    try {
      this.homey.app.recordMqttEvent(this, event, {
        monitor: this.monitorEpoch || 0,
        generation: this.connectionSequence || 0,
        attempt: this.mqttReconnectAttempt || 0,
      });
    } catch (_) {} // Diagnostic failures must not change device behavior.
  }

  getStoredSession() {
    return this.getAuth().snapshot();
  }

  async persistSession(session, cookies = '') {
    return this.repairSession(async () => ({ session, cookies }));
  }

  repairSession(authenticate) {
    if (this.authRepairPromise) return Promise.reject(new AuthError('repair_busy', 'repair'));
    this.authRepairEpoch = (this.authRepairEpoch || 0) + 1;
    const previous = this.sessionRefreshPromise;
    const work = (async () => {
      if (previous) await previous.catch(() => {});
      await this.getAuth().repair(authenticate);
      this.resetAuthRetry();
    })().finally(() => { if (this.authRepairPromise === work) this.authRepairPromise = null; });
    this.authRepairPromise = work;
    return work;
  }


  diag(message) {
    this.log(message);
    try { this.homey.app.recordDiag(message); } catch (_) {}
  }

  powerDiagnostic(event, fields) {
    this.diag(`POWER ${event} ${JSON.stringify(fields)}`);
    const unavailableStatus = ['connection.ready', 'connection.lost', 'status.initialCandidate',
      'initialization.waiting', 'initialization.cancelled', 'restore.uncertain', 'transition.failed'];
    if (unavailableStatus.includes(event) && typeof this.setWarning === 'function') {
      const message = event === 'initialization.cancelled' ? fields.reason
        : 'Powerstatus nog niet bevestigd. Power wacht op live status; er wordt niet blind getoggeld.';
      this.warningQueue = this.warningQueue.then(() => {
        if (!this.deleted) return this.setWarning(message);
      }).catch(() => {});
    } else if ((event === 'transition.complete' || (event === 'status.accepted' && !this.power?.tx))
      && typeof this.unsetWarning === 'function') {
      this.warningQueue = this.warningQueue.then(() => {
        if (!this.deleted) return this.unsetWarning();
      }).catch(() => {});
    }
  }


  getAuth() {
    if (!this.auth) {
      const diagnostic = (event, fields) => this.authDiagnostic(event, fields);
      this.auth = new SessionManager({
        storage: { get: key => this.getStoreValue(key), set: (key, value) => this.setStoreValue(key, value) },
        client: new AuthClient({ diagnostic }), diagnostic,
      });
    }
    return this.auth;
  }

  authDiagnostic(event, fields = {}) {
    emit((name, safe) => this.diag(`AUTH ${name} ${JSON.stringify(safe)}`), event, fields);
  }

  resetAuthRetry() {
    this.authRetryAt = 0;
    this.authRetryAttempt = 0;
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = null;
  }

  async handleAuthFailure(error) {
    const safe = asAuthError(error);
    if (this.deleted) return new AuthError('stopped', 'session');
    this.authDiagnostic('auth.failure', safe);
    if (safe.requiresRepair) {
      this.authUnavailable = true;
      this.authConnectionReady = false;
      this.authRecoveryEpoch = (this.authRecoveryEpoch || 0) + 1;
      const write = (this.authAvailabilityQueue || Promise.resolve()).then(() => {
        if (!this.deleted) return this.setUnavailable(safe.message);
      }).catch(() => this.authDiagnostic('auth.availability.failed', { phase: 'unavailable' }));
      this.authAvailabilityQueue = write;
      await write;
    }
    if (!this.deleted && !this.authRetryTimer) {
      this.authRetryAttempt = (this.authRetryAttempt || 0) + 1;
      const base = safe.requiresRepair || safe.kind === 'refresh_uncertain' ? 600000
        : Math.min(600000, 30000 * 2 ** Math.min(this.authRetryAttempt - 1, 5));
      const delay = Math.min(600000, Math.round(base * (0.9 + Math.random() * 0.2)));
      this.authRetryAt = Date.now() + delay;
      this.authDiagnostic('auth.retry.scheduled', { phase: safe.phase, attempt: this.authRetryAttempt, delayMs: delay });
      this.authRetryTimer = setTimeout(() => {
        this.authRetryTimer = null;
        this.runSessionWatchdog().catch(() => {});
      }, delay);
    }
    return safe;
  }

  ensureSessionLocked(config) {
    if (this.deleted) return Promise.reject(new AuthError('stopped', 'session'));
    if (this.authRepairPromise) return this.authRepairPromise.then(() => this.ensureSessionLocked(config));
    if (this.sessionRefreshPromise) return this.sessionRefreshPromise;
    if ((this.authRetryAt || 0) > Date.now()) return Promise.reject(new AuthError('server', 'backoff'));
    const epoch = this.authRepairEpoch || 0;
    const flight = this.getAuth().ensure(config)
      .then(result => { if (epoch === (this.authRepairEpoch || 0)) this.resetAuthRetry(); return result; })
      .catch(async error => { throw epoch === (this.authRepairEpoch || 0) ? await this.handleAuthFailure(error) : asAuthError(error); })
      .finally(() => { if (this.sessionRefreshPromise === flight) this.sessionRefreshPromise = null; });
    this.sessionRefreshPromise = flight;
    return flight;
  }

  runSessionWatchdog() {
    if (this.deleted || (this.authRetryAt || 0) > Date.now()) return Promise.resolve();
    if (this.authRepairPromise) return this.authRepairPromise.then(() => this.runSessionWatchdog());
    if (this.watchdogPromise) return this.watchdogPromise;
    const epoch = this.authRepairEpoch || 0;
    const work = (async () => {
      try {
        const config = await Ziggo.getConfig({ diagnostic: (event, fields) => this.authDiagnostic(event, fields) });
        const authentication = await this.ensureSessionLocked(config);
        if (this.deleted || epoch !== (this.authRepairEpoch || 0)) return;
        if (this.authUnavailable) await this.startStatusMonitor(authentication);
        this.authDiagnostic('auth.watchdog.succeeded', { phase: 'watchdog' });
      } catch (error) {
        // ensureSessionLocked already schedules its failures. Config failures
        // reach this catch before that method is called.
        const safe = this.authRetryTimer || epoch !== (this.authRepairEpoch || 0) ? asAuthError(error) : await this.handleAuthFailure(error);
        throw safe;
      }
    })().finally(() => { if (this.watchdogPromise === work) this.watchdogPromise = null; });
    this.watchdogPromise = work;
    return work;
  }

  async restoreAuthAvailability() {
    const epoch = this.authRecoveryEpoch || 0;
    const write = (this.authAvailabilityQueue || Promise.resolve()).then(async () => {
      if (this.deleted || !this.authUnavailable || !this.authConnectionReady || epoch !== (this.authRecoveryEpoch || 0)) return;
      const auth = this.getAuth();
      if (auth.verifiedRevision === null || auth.verifiedRevision !== this.authConnectionRevision) return;
      await this.setAvailable();
      if (this.deleted || epoch !== (this.authRecoveryEpoch || 0)) return;
      this.authUnavailable = false;
      this.authDiagnostic('auth.availability.restored', { phase: 'status_subscription', revision: auth.verifiedRevision });
    });
    this.authAvailabilityQueue = write.catch(() => {});
    return write;
  }

  async startStatusMonitor(authentication = null) {
    if (this.deleted) return;
    if (!authentication && (this.authRetryAt || 0) > Date.now()) throw new AuthError('server', 'backoff');
    this.authConnectionReady = false;
    const epoch = ++this.monitorEpoch;
    this.mqttReconnectAttempt = (this.mqttReconnectAttempt || 0) + 1;
    this.mqttEvent('monitor.start');
    this.power.disconnect(this.connectionSequence);
    if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
    this.statusReconnectTimer = null;
    if (this.statusClient) {
      try { this.statusClient.end(true); } catch (_) {}
      this.statusClient = null;
    }
    const config = authentication?.config || await Ziggo.getConfig({ diagnostic: (event, fields) => this.authDiagnostic(event, fields) });
    const { session, mqttToken, cookies, refreshed, authRevision } = authentication || await this.ensureSessionLocked(config);
    if (refreshed) {
      await this.persistSession(session, cookies);
      this.log('Statusmonitor: Ziggo-sessie vernieuwd en nieuwe tokens opgeslagen.');
    }
    if (this.deleted || epoch !== this.monitorEpoch) return;
    this.statusClient = Ziggo.monitorStatus(config, session, this.getData().id, mqttToken, {
      onConnect: () => {
        if (epoch !== this.monitorEpoch || this.deleted) return;
        ++this.connectionSequence;
        this.mqttEvent('connected');
        this.mqttEvent('subscribe');
        this.diag(`STATUS connected generation=${this.connectionSequence}`);
      },
      onSubscribed: () => {
        if (epoch === this.monitorEpoch && !this.deleted) {
          if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
          this.statusReconnectTimer = null;
          this.mqttEvent('ready');
          if (this.mqttConnectionLost) this.mqttEvent('connection.restored');
          this.mqttConnectionLost = false;
          this.mqttReconnectAttempt = 0;
          this.power.connect(this.connectionSequence);
          this.authConnectionReady = true;
          this.authConnectionRevision = authRevision;
          this.restoreAuthAvailability().catch(() => this.authDiagnostic('auth.availability.failed', { phase: 'available' }));
        }
      },
      onStatus: (message, metadata) => {
        if (epoch !== this.monitorEpoch || this.deleted) return;
        const state = message?.state || '(geen state)';
        const sourceMatches = !message?.source || message.source === this.getData().id;
        if (!sourceMatches) return;

        if (state === 'ONLINE_RUNNING' || state === 'ONLINE_STANDBY') {
          const isOn = state === 'ONLINE_RUNNING';
          if (!this.power.observe(isOn, { ...metadata, generation: this.connectionSequence })) return;
          this.actualPowerState = isOn;
          this.statusWriteQueue = this.statusWriteQueue.then(async () => {
            if (this.deleted || epoch !== this.monitorEpoch) return;
            if (this.getCapabilityValue('onoff') !== isOn) await this.setCapabilityValue('onoff', isOn);
          }).catch(() => this.diag('STATUS capability.write.failed'));
        }
      },
      onReconnect: () => {
        if (epoch !== this.monitorEpoch || this.deleted) return;
        ++this.mqttReconnectAttempt;
        this.mqttEvent('reconnect');
        this.diag('STATUS reconnect');
      },
      onOffline: () => this.statusDisconnected(epoch, 'offline'),
      onError: () => this.statusDisconnected(epoch, 'error'),
      onClose: () => this.statusDisconnected(epoch, 'close'),
    });
  }

  statusDisconnected(epoch, type = 'close') {
    if (epoch !== this.monitorEpoch || this.deleted) return;
    this.mqttEvent(type);
    if (!this.mqttConnectionLost) this.mqttEvent('connection.lost');
    this.mqttConnectionLost = true;
    this.authConnectionReady = false;
    this.actualPowerState = null;
    // A socket can close before SUBACK, before the controller knows its generation.
    this.power.cancelInitialization('Statusverbinding verbroken tijdens initialisatie.');
    this.power.disconnect(this.connectionSequence);
    this.scheduleStatusRestart();
  }

  scheduleStatusRestart() {
    if (this.deleted || this.statusReconnectTimer) return;
    this.statusReconnectTimer = setTimeout(() => {
      this.statusReconnectTimer = null;
      this.startStatusMonitor().catch(() => { this.mqttEvent('monitor.failed'); this.diag('STATUS restart.failed'); this.scheduleStatusRestart(); });
    }, 10000);
  }

  async onDeleted() {
    this.deleted = true;
    if (this.authRetryTimer) clearTimeout(this.authRetryTimer);
    this.authRetryTimer = null;
    ++this.monitorEpoch;
    this.power?.close();
    if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
    if (this.sessionWatchdogTimer) clearInterval(this.sessionWatchdogTimer);
    if (this.statusClient) {
      try { this.statusClient.end(true); } catch (_) {}
      this.statusClient = null;
    }
  }

  async onUninit() {
    await this.onDeleted();
  }


  async goToChannel(channel) {
    if (!Number.isInteger(channel) || channel < 1 || channel > 9999) {
      throw new Error('Zendernummer moet een geheel getal tussen 1 en 9999 zijn.');
    }
    const digits = String(channel).split('');
    this.log(`Flow: ga naar zender ${channel}.`);
    for (let i = 0; i < digits.length; i++) {
      await this.sendKey(digits[i]);
      if (i < digits.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
  }

  async sendKey(w3cKey) {
    if (w3cKey === 'Power') return this.power.toggle();
    const config = await Ziggo.getConfig();
    const { session, mqttToken, cookies, refreshed } = await this.ensureSessionLocked(config);
    if (refreshed) {
      await this.persistSession(session, cookies);
      this.log('Ziggo-sessie vernieuwd en nieuwe tokens opgeslagen.');
    }
    await Ziggo.sendKey(config, session, this.getData().id, mqttToken, w3cKey);
    this.log(`${w3cKey} verzonden.`);
  }
}
module.exports = ZiggoNextDevice;
