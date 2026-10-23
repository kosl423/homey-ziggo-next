'use strict';
const Homey = require('homey');
const Ziggo = require('../../lib/ziggo');
const PowerController = require('../../lib/power-controller');

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
    this.startStatusMonitor().catch(() => { this.diag('STATUS start.failed'); this.scheduleStatusRestart(); });

    // Runs on Homey itself, so laptop standby does not interrupt the lifecycle test.
    this.sessionWatchdogTimer = setInterval(() => {
      this.runSessionWatchdog().catch(err => this.diag(`WATCHDOG failed: ${err.message}`));
    }, 10 * 60 * 1000);
  }

  getStoredSession() {
    return {
      username: this.getStoreValue('username'),
      householdId: this.getStoreValue('householdId'),
      accessToken: this.getStoreValue('accessToken'),
      refreshToken: this.getStoreValue('refreshToken'),
      refreshTokenExpiry: this.getStoreValue('refreshTokenExpiry'),
      hashedCustomerId: this.getStoreValue('hashedCustomerId'),
      cookieHeader: this.getStoreValue('cookieHeader') || '',
    };
  }

  async persistSession(session, cookies = '') {
    await Promise.all([
      this.setStoreValue('username', session.username),
      this.setStoreValue('householdId', session.householdId),
      this.setStoreValue('accessToken', session.accessToken),
      this.setStoreValue('refreshToken', session.refreshToken),
      this.setStoreValue('refreshTokenExpiry', session.refreshTokenExpiry || null),
      this.setStoreValue('hashedCustomerId', session.hashedCustomerId || this.getStoreValue('hashedCustomerId') || null),
      this.setStoreValue('cookieHeader', cookies || this.getStoreValue('cookieHeader') || ''),
    ]);
    this.log(`SESSIE persist: ${JSON.stringify({...Ziggo.tokenMeta(this.getStoredSession()), cookies: Ziggo.cookieMeta(this.getStoreValue('cookieHeader') || '')})}`);
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


  async ensureSessionLocked(config) {
    // A Ziggo refresh token may be rotated/one-shot. Never allow the status
    // monitor and a key command to refresh the same stored token concurrently.
    if (this.sessionRefreshPromise) {
      this.log('Sessiediagnose: wacht op reeds lopende sessievernieuwing.');
      return this.sessionRefreshPromise;
    }
    const seq = ++this.sessionDiagSeq;
    const diag = (event, data = {}) => {
      // Fingerprints are one-way SHA-256 prefixes: enough to compare token rotation,
      // never enough to reconstruct or use a Ziggo token.
      this.log(`SESSIE[${seq}] ${event}: ${JSON.stringify(data)}`);
    };
    const stored = this.getStoredSession();
    diag('ensure.begin', {...Ziggo.tokenMeta(stored), cookies: Ziggo.cookieMeta(stored.cookieHeader)});
    this.sessionRefreshPromise = Ziggo.ensureSession(config, stored, stored.cookieHeader, diag)
      .then(result => {
        diag('ensure.success', { refreshed: result.refreshed, session: Ziggo.tokenMeta(result.session), cookies: Ziggo.cookieMeta(result.cookies) });
        return result;
      })
      .catch(async err => {
  const now = this.getStoredSession();

  diag('ensure.failed', {
    error: 'session_failed',
    stored: Ziggo.tokenMeta(now),
    cookies: Ziggo.cookieMeta(now.cookieHeader)
  });

  if (/invalid token/i.test(err.message || '')) {
    const message = 'Ziggo-sessie verlopen. Repareer het apparaat om opnieuw in te loggen.';

    this.diag(`SESSIE ongeldig: ${message}`);

    try {
      await this.setUnavailable(message);
    } catch (setUnavailableError) {
      this.error(`Apparaat op Ongeschikbaar zetten mislukt: ${setUnavailableError.message}`);
    }

    throw new Error(message);
  }

  throw err;
})
      .finally(() => { this.sessionRefreshPromise = null; });
    return this.sessionRefreshPromise;
  }

  async runSessionWatchdog() {
    const config = await Ziggo.getConfig();
    const { session, cookies, refreshed } = await this.ensureSessionLocked(config);
    if (refreshed) {
      await this.persistSession(session, cookies);
      this.diag('WATCHDOG: Ziggo-sessie vernieuwd en tokens/cookies opgeslagen.');
    }
  }

  async startStatusMonitor() {
    if (this.deleted) return;
    const epoch = ++this.monitorEpoch;
    this.power.disconnect(this.connectionSequence);
    if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
    this.statusReconnectTimer = null;
    if (this.statusClient) {
      try { this.statusClient.end(true); } catch (_) {}
      this.statusClient = null;
    }
    const config = await Ziggo.getConfig();
    const { session, mqttToken, cookies, refreshed } = await this.ensureSessionLocked(config);
    if (refreshed) {
      await this.persistSession(session, cookies);
      this.log('Statusmonitor: Ziggo-sessie vernieuwd en nieuwe tokens opgeslagen.');
    }
    if (this.deleted || epoch !== this.monitorEpoch) return;
    this.statusClient = Ziggo.monitorStatus(config, session, this.getData().id, mqttToken, {
      onConnect: () => {
        if (epoch !== this.monitorEpoch || this.deleted) return;
        ++this.connectionSequence;
        this.diag(`STATUS connected generation=${this.connectionSequence}`);
      },
      onSubscribed: () => {
        if (epoch === this.monitorEpoch && !this.deleted) {
          if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
          this.statusReconnectTimer = null;
          this.power.connect(this.connectionSequence);
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
      onReconnect: () => { if (epoch === this.monitorEpoch) this.diag('STATUS reconnect'); },
      onOffline: () => this.statusDisconnected(epoch),
      onError: () => this.statusDisconnected(epoch),
      onClose: () => this.statusDisconnected(epoch),
    });
  }

  statusDisconnected(epoch) {
    if (epoch !== this.monitorEpoch || this.deleted) return;
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
      this.startStatusMonitor().catch(() => { this.diag('STATUS restart.failed'); this.scheduleStatusRestart(); });
    }, 10000);
  }

  async onDeleted() {
    this.deleted = true;
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
