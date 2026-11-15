'use strict';
const Homey = require('homey');
const { MqttHistory } = require('./lib/mqtt-history');
const { text, userError } = require('./lib/ui');
const { DiagnosticCompactor } = require('./lib/diagnostic-compactor');

class ZiggoNextApp extends Homey.App {
  async onInit() {
    this.log('Ziggo Next v0.0.28 gestart.');
    this.recordDiag('APP v0.0.28 gestart');
    const goToChannel = this.homey.flow.getActionCard('go_to_channel');
    goToChannel.registerRunListener(async args => {
      const channel = Number(args.channel);
      if (!args.device) throw new Error(text(this.homey, 'errors.noDevice'));
      try { await args.device.goToChannel(channel); } catch (error) { throw userError(this.homey, error); }
      return true;
    });
  }

  recordMqttEvent(device, event, fields) {
    if (!this.mqttHistory) this.mqttHistory = new MqttHistory(this.homey.settings);
    this.mqttHistory.record(device, event, fields);
  }

  async onUninit() {
    await Promise.all([this.mqttHistory?.flush(), this.diagnosticWrite]);
  }

  clearDiagnostics() {
    // Reset memory synchronously so messages accepted after this call use a fresh
    // buffer. The clear itself follows older writes in the same serialized queue.
    this.diagnosticLines = [];
    this.diagnosticCompactor?.reset();
    const write = (this.diagnosticWrite || Promise.resolve())
      .then(() => this.homey.settings.set('diagnosticLog', []));
    this.diagnosticWrite = write.catch(() => {});
    return write;
  }

  recordDiag(message) {
    const now = new Date().toISOString();
    if (!this.diagnosticLines) {
      const current = this.homey.settings.get('diagnosticLog');
      this.diagnosticLines = Array.isArray(current) ? [...current] : [];
    }
    const lines = this.diagnosticLines;
    if (!this.diagnosticCompactor) this.diagnosticCompactor = new DiagnosticCompactor();
    this.diagnosticCompactor.append(lines, message, now);
    while (lines.length > 250) lines.shift();
    const snapshot = [...lines];
    this.diagnosticWrite = (this.diagnosticWrite || Promise.resolve())
      .then(() => this.homey.settings.set('diagnosticLog', snapshot))
      .catch(() => {});
  }
}
module.exports = ZiggoNextApp;
