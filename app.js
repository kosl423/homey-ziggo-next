'use strict';
const Homey = require('homey');

class ZiggoNextApp extends Homey.App {
  async onInit() {
    this.log('Ziggo Next v0.0.22 gestart.');
    this.recordDiag('APP v0.0.22 gestart');
    const goToChannel = this.homey.flow.getActionCard('go_to_channel');
    goToChannel.registerRunListener(async args => {
      const channel = Number(args.channel);
      if (!args.device) throw new Error('Geen Ziggo Next Mini geselecteerd.');
      await args.device.goToChannel(channel);
      return true;
    });
  }

  recordDiag(message) {
    const now = new Date().toISOString();
    const current = this.homey.settings.get('diagnosticLog');
    const lines = Array.isArray(current) ? current : [];
    lines.push(`${now} ${message}`);
    while (lines.length > 250) lines.shift();
    Promise.resolve(this.homey.settings.set('diagnosticLog', lines)).catch(() => {});
  }
}
module.exports = ZiggoNextApp;
