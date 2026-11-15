'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Controller = require('../lib/power-controller'), ui = require('../lib/ui');
const lookup = (language, key) => key.split('.').reduce((v,k) => v?.[k], require('../locales/' + language + '.json'));
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
global.fetch = () => { throw Error('Live network forbidden'); };

const messages = {
  'Powercontroller gestopt.': 'errors.stopped',
  'Ongeldige Power-doelstatus.': 'errors.invalidPower',
  'Uitkomst vorige Power-opdracht onbekend; wacht op live status.': 'status.uncertain',
  'Geen betrouwbare actuele Powerstatus. Wacht op live Ziggo-status.': 'status.waiting',
  'Power-verzoek vervangen door een tegengesteld verzoek.': 'errors.superseded',
  'Geen betrouwbare beginstatus ontvangen; Power is niet verstuurd.': 'status.expired',
  'Power-knop geblokkeerd: opdracht loopt of status is onbekend.': 'errors.toggleBlocked',
  'Statusverbinding vervangen.': 'status.disconnected',
  'Statusverbinding verbroken.': 'status.disconnected',
  'Statusverbinding verbroken tijdens initialisatie.': 'status.disconnected',
  'Power-voorbereiding duurde te lang.': 'errors.preparationTimeout',
  'Powerstatus niet meer betrouwbaar.': 'status.waiting',
  'Geen betrouwbare Power-statusbevestiging ontvangen.': 'status.uncertain',
  'Power-voorbereiding of verzending mislukt.': 'errors.commandFailed',
  'Power-journal kon niet worden vrijgegeven.': 'status.uncertain',
  'Powerstatus onbekend.': 'status.waiting',
};

async function harness(language) {
  const listeners = {}, store = {}, logs = [], warnings = [], sends = [], timers = new Map(); let sequence = 0;
  class Device {
    log() {} hasCapability() { return true; }
    registerCapabilityListener(key, listener) { listeners[key] = listener; }
    getStoreValue(key) { return store[key]; }
    async setStoreValue(key, value) { store[key] = value; }
    getData() { return { id: 'synthetic-box' }; }
    async setWarning(message) { warnings.push(message); }
    async unsetWarning() { warnings.push(null); }
  }
  const ziggo = { getConfig: async () => ({}), sendKey: async (...args) => {
    const options = args.at(-1); if (options.onPublish() !== false) sends.push(args[4]);
  } };
  const box = { module: { exports: {} }, require: id => id === 'homey' ? { Device }
    : id === '../../lib/ui' ? ui : id.includes('power-controller') ? Controller
      : id.includes('/auth') ? require('../lib/auth') : ziggo,
    setInterval: () => 1, clearInterval() {}, setTimeout() { throw Error('Unexpected device timer'); }, clearTimeout() {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../drivers/ziggo_next/device.js'), 'utf8'), box);
  const device = new box.module.exports();
  device.homey = { __: key => lookup(language, key), app: { recordDiag: message => logs.push(message) } };
  device.startStatusMonitor = async () => {};
  device.ensureSessionLocked = async () => ({ session: {}, mqttToken: 'SYNTHETIC' });
  await device.onInit();
  device.power.timers = { setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  return { device, listeners, sends, logs, warnings, store,
    ready(value = false) { device.power.connect(1); device.power.observe(value, { generation: 1 }); },
    fire(delay) { const entry = [...timers].find(([,value]) => value.delay === delay);
      assert.ok(entry, 'Missing timer ' + delay); timers.delete(entry[0]); entry[1].fn(); } };
}

for (const language of ['en','nl']) {
  test('all fixed controller failure reasons translate without changing the original error: ' + language, async () => {
    const h = await harness(language);
    for (const [message,key] of Object.entries(messages)) {
      const original = new Error(message);
      await assert.rejects(h.device.runPowerRequest(() => Promise.reject(original)), e => e.message === lookup(language,key));
      assert.equal(original.message,message);
    }
    // Fail coverage if the controller gains another fixed failure reason.
    const source = fs.readFileSync(path.join(__dirname, '../lib/power-controller.js'), 'utf8');
    const reasons = [...source.matchAll(/new Error\('([^']+)'\)|this\.fail\([^,]+, '([^']+)'|this\.cancelInitialization\('([^']+)'/g)]
      .map(m => m[1] || m[2] || m[3]);
    for (const reason of reasons) assert.ok(messages[reason], 'Untranslated reason: ' + reason);
    assert.equal(h.sends.length,0); await h.device.onDeleted();
  });

  test('registered onoff and raw Power listener return localized validation/blocking errors: ' + language, async () => {
    const h = await harness(language);
    await assert.rejects(h.listeners.onoff('invalid'), e => e.message === lookup(language,'errors.invalidPower'));
    await assert.rejects(h.listeners.ziggo_power(), e => e.message === lookup(language,'errors.toggleBlocked'));
    assert.equal(h.sends.length,0); await h.device.onDeleted();
  });

  test('an expired initial request is localized and cannot publish or replay after live status: ' + language, async () => {
    const h = await harness(language); h.device.power.connect(1);
    h.device.power.observe(false,{ generation:1, retain:true });
    const request = h.listeners.onoff(true);
    const rejected = assert.rejects(request, e => e.message === lookup(language,'status.expired'));
    h.fire(10000); await rejected;
    h.device.power.observe(false,{generation:1}); await flush();
    assert.equal(h.sends.length,0); assert.equal(h.device.power.desired,null);
    await h.device.onDeleted();
  });

  test('simultaneous equal Homey requests still publish once and complete on live confirmation: ' + language, async () => {
    const h = await harness(language); h.ready();
    const first = h.listeners.onoff(true), second = h.listeners.onoff(true);
    await flush(); assert.deepEqual(h.sends,['Power']);
    h.device.power.observe(true,{generation:1}); await Promise.all([first,second]);
    assert.equal(h.store.pendingPower,null); assert.equal(h.device.power.state,'ready');
    await h.device.onDeleted();
  });

  test('superseded requests return a translated error and preserve cancellation before publish: ' + language, async () => {
    const h = await harness(language); h.ready();
    const first = h.listeners.onoff(true);
    const rejected = assert.rejects(first,e => e.message === lookup(language,'errors.superseded'));
    const second = h.listeners.onoff(false); await rejected; await second; await flush();
    assert.equal(h.sends.length,0); assert.equal(h.device.power.state,'ready');
    await h.device.onDeleted();
  });

  test('confirmation timeout remains uncertain, translated, and never retries Power: ' + language, async () => {
    const h = await harness(language); h.ready();
    const request = h.listeners.onoff(true);
    const rejected = assert.rejects(request,e => e.message === lookup(language,'status.uncertain'));
    await flush(); assert.equal(h.sends.length,1); h.fire(20000); await rejected;
    await assert.rejects(h.listeners.onoff(true),e => e.message === lookup(language,'status.uncertain'));
    assert.equal(h.sends.length,1); assert.equal(h.device.power.state,'uncertain');
    assert.ok(h.logs.some(line => line.includes('Geen betrouwbare Power-statusbevestiging ontvangen.')));
    await h.device.onDeleted();
  });

  test('raw Power sending route and queued deletion errors are translated: ' + language, async () => {
    const h = await harness(language); h.ready();
    const raw = h.listeners.ziggo_power();
    const rejected = assert.rejects(raw,e => e.message === lookup(language,'errors.stopped'));
    await flush(); assert.equal(h.sends.length,1); await h.device.onDeleted(); await rejected;
    assert.equal(h.sends.length,1);
  });

  test('unexpected error text is hidden without changing diagnostics or sending a command: ' + language, async () => {
    const h = await harness(language);
    h.device.power.request = () => Promise.reject(Error('PRIVATE_TOKEN_COOKIE_PAYLOAD'));
    const before = [...h.logs];
    await assert.rejects(h.listeners.onoff(true),e => e.message === lookup(language,'errors.commandFailed') && !e.message.includes('PRIVATE'));
    assert.deepEqual(h.logs,before); assert.equal(h.sends.length,0); await h.device.onDeleted();
  });
}

test('missing language keys fall back to English at the Power UI boundary', async () => {
  const h = await harness('en'); h.device.homey.__ = key => key;
  await assert.rejects(h.listeners.ziggo_power(),e => e.message === lookup('en','errors.toggleBlocked'));
  assert.equal(h.sends.length,0); await h.device.onDeleted();
});
