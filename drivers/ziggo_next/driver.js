'use strict';
const Homey = require('homey');
const Ziggo = require('../../lib/ziggo');
const { emit } = require('../../lib/auth');

class ZiggoNextDriver extends Homey.Driver {
  authDiagnostic(event, fields) {
    emit((name, safe) => this.homey.app.recordDiag(`AUTH ${name} ${JSON.stringify(safe)}`), event, fields);
  }

  async onInit() {
    this.log('Ziggo Next-driver v0.0.26 gestart.');
  }

  async onPair(session) {
    this.log('Pairing: sessie gestart; handlers registreren...');

    session.setHandler('showView', async viewId => {
      this.log(`Pairing: view geopend: ${viewId}`);
    });

    session.setHandler('pair_ziggo', async data => {
      this.log('Pairing: pair_ziggo event ontvangen.');

      const username = String(data?.username || '').trim();
      const password = String(data?.password || '');

      if (!username || !password) {
        throw new Error('Vul je Ziggo-gebruikersnaam en wachtwoord in.');
      }

      this.log('Pairing: Ziggo-login en Mediabox-detectie gestart...');

      const {
        session: ziggoSession,
        config,
        cookies
      } = await Ziggo.login(username, password, { diagnostic: (event, fields) => this.authDiagnostic(event, fields) });

      this.homey.app.recordDiag('PAIR succesvol');
      
      const { devices, customer } =
        await Ziggo.getDevices(config, ziggoSession, cookies, { diagnostic: (event, fields) => this.authDiagnostic(event, fields) });

      if (devices.length !== 1) {
        throw new Error(
          `Veiligheidsstop: verwacht precies 1 Mediabox, maar vond ${devices.length}.`
        );
      }

      const d = devices[0];

      if (!d?.deviceId) {
        throw new Error('Geen bruikbare device-ID gevonden.');
      }

      // Password is deliberately NOT persisted.
      // Only Ziggo session tokens/cookies are stored on Homey.
      return {
        name:
          d?.settings?.deviceName ||
          d?.settings?.name ||
          d?.name ||
          'Ziggo Next Mini',

        data: {
          id: d.deviceId
        },

        store: {
          username: ziggoSession.username || username,
          householdId: ziggoSession.householdId,
          accessToken: ziggoSession.accessToken,
          refreshToken: ziggoSession.refreshToken,
          refreshTokenExpiry: ziggoSession.refreshTokenExpiry || null,
          hashedCustomerId: customer?.hashedCustomerId || null,
          cookieHeader: cookies || ''
        }
      };
    });
  }

  async onRepair(session, device) {
    this.log('Repair: sessie gestart; handler registreren...');

    session.setHandler('repair_ziggo', async data => {
      const username = String(data?.username || '').trim();
      const password = String(data?.password || '');

      if (!username || !password) {
        throw new Error('Vul je Ziggo-gebruikersnaam en wachtwoord in.');
      }

      this.log('Repair: opnieuw inloggen bij Ziggo...');

      await device.repairSession(async () => {
        const {
          session: ziggoSession,
          config,
          cookies
        } = await Ziggo.login(username, password, { diagnostic: (event, fields) => this.authDiagnostic(event, fields) });

        const { devices, customer } =
          await Ziggo.getDevices(config, ziggoSession, cookies, { diagnostic: (event, fields) => this.authDiagnostic(event, fields) });

        if (devices.length !== 1) {
          throw new Error(
            `Veiligheidsstop: verwacht precies 1 Mediabox, maar vond ${devices.length}.`
          );
        }

        const d = devices[0];

        if (!d?.deviceId) {
          throw new Error('Geen bruikbare device-ID gevonden.');
        }

        // Extra veiligheidscontrole:
        // Repair mag niet per ongeluk een andere Mediabox aan dit
        // bestaande Homey-apparaat koppelen.
        if (d.deviceId !== device.getData().id) {
          throw new Error(
            'De gevonden Mediabox komt niet overeen met het bestaande Homey-apparaat.'
          );
        }

        return { session: {
          username: ziggoSession.username || username,
          householdId: ziggoSession.householdId,
          accessToken: ziggoSession.accessToken,
          refreshToken: ziggoSession.refreshToken,
          refreshTokenExpiry: ziggoSession.refreshTokenExpiry || null,
          hashedCustomerId: customer?.hashedCustomerId || null
        }, cookies };
      });

      this.homey.app.recordDiag('REPAIR succesvol');
      
      // Oude MQTT-verbinding gebruikt mogelijk nog de oude sessie.
      // Bouw hem daarom opnieuw op met de zojuist opgeslagen sessie.
      await device.startStatusMonitor();
      // Availability is restored by the authenticated subscription callback,
      // after SUBACK; creating a client alone does not prove connectivity.

      this.log('Repair: Ziggo-verbinding succesvol hersteld.');

      return true;
    });
  }
}

module.exports = ZiggoNextDriver;
