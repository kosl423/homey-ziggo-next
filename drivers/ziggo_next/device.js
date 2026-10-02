'use strict';
const Homey = require('homey');
const Ziggo = require('../../lib/ziggo');

class ZiggoNextDevice extends Homey.Device {
  async onInit() {
    this.log('Ziggo Next Mini gestart.');
    this.statusClient = null;
    this.statusReconnectTimer = null;
    this.actualPowerState = null;
    this.sessionRefreshPromise = null;
    this.sessionDiagSeq = 0;

    for (const capability of ['onoff', 'ziggo_power', 'ziggo_channel_up', 'ziggo_channel_down', 'ziggo_digit_1', 'ziggo_digit_2', 'ziggo_digit_3', 'ziggo_digit_4', 'ziggo_digit_5', 'ziggo_digit_6', 'ziggo_digit_7', 'ziggo_digit_8', 'ziggo_digit_9', 'ziggo_digit_0', 'ziggo_ok', 'ziggo_back', 'ziggo_nav_up', 'ziggo_nav_down', 'ziggo_nav_left', 'ziggo_nav_right']) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
        this.log(`Capability toegevoegd: ${capability}`);
      }
    }

    // Native Homey power state. This is state-aware: never blindly toggle when
    // Ziggo already reports the requested state.
    this.registerCapabilityListener('onoff', async value => {
      const desired = Boolean(value);
      if (this.actualPowerState === null) {
        throw new Error('Powerstatus is nog niet bekend. Probeer het over enkele seconden opnieuw.');
      }
      if (this.actualPowerState === desired) {
        this.log(`Aan/uit: gewenste status is al ${desired ? 'aan' : 'uit'}; geen Power-commando nodig.`);
        return;
      }
      await this.sendKey('Power');
      this.log(`Aan/uit: Power verzonden voor gewenste status ${desired ? 'aan' : 'uit'}; wacht op Ziggo-statusbevestiging.`);
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
    this.startStatusMonitor().catch(err => this.error(`Statusmonitor starten mislukt: ${err.message}`));

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
    error: err.message,
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
    this.statusClient = Ziggo.monitorStatus(config, session, this.getData().id, mqttToken, {
      onConnect: () => this.log('Statusmonitor: MQTT verbonden; luister naar powerstatus.'),
      onStatus: message => {
        const state = message?.state || '(geen state)';
        const sourceMatches = !message?.source || message.source === this.getData().id;
        if (!sourceMatches) return;

        if (state === 'ONLINE_RUNNING' || state === 'ONLINE_STANDBY') {
          const isOn = state === 'ONLINE_RUNNING';
          this.actualPowerState = isOn;
          this.setCapabilityValue('onoff', isOn)
            .catch(err => this.error(`Powerstatus bijwerken mislukt: ${err.message}`));
        }
      },
      onReconnect: () => this.log('Statusmonitor: MQTT opnieuw verbinden...'),
      onOffline: () => this.log('Statusmonitor: MQTT offline.'),
      onError: err => this.error(`Statusmonitor: MQTT-fout: ${err.message}`),
      onClose: () => this.log('Statusmonitor: MQTT-verbinding gesloten.'),
    });
  }

  async onDeleted() {
    if (this.statusReconnectTimer) clearTimeout(this.statusReconnectTimer);
    if (this.sessionWatchdogTimer) clearInterval(this.sessionWatchdogTimer);
    if (this.statusClient) {
      try { this.statusClient.end(true); } catch (_) {}
      this.statusClient = null;
    }
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
