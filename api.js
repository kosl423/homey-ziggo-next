'use strict';
const { text } = require('./lib/ui');

module.exports = {
  async clearDiagnostics({ homey }) {
    try {
      await homey.app.clearDiagnostics();
      return { cleared: true };
    } catch (_) {
      // Never expose storage exceptions or device credentials through the API.
      throw new Error(text(homey, 'settings.clearFailed'));
    }
  },
};
