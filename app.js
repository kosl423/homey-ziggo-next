'use strict';
const Homey = require('homey');

class ZiggoNextApp extends Homey.App {
  async onInit() {
    this.log('Ziggo Next v0.0.23 gestart.');
    this.recordDiag('APP v0.0.23 gestart');
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
    if (!this.diagnosticLines) {
      const current = this.homey.settings.get('diagnosticLog');
      this.diagnosticLines = Array.isArray(current) ? [...current] : [];
    }
    const lines = this.diagnosticLines;
    lines.push(`${now} ${message}`);
    while (lines.length > 250) lines.shift();
    const snapshot = [...lines];
    this.diagnosticWrite = (this.diagnosticWrite || Promise.resolve())
      .then(() => this.homey.settings.set('diagnosticLog', snapshot))
      .catch(() => {});
  }
}
module.exports = ZiggoNextApp;
