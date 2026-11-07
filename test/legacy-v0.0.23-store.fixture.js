'use strict';
// Exact session-store methods from the original v0.0.23 device adapter.
module.exports = Ziggo => class LegacySessionStore {
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


};
