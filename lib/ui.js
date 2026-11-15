'use strict';
const english = require('../locales/en.json');
const lookup = key => key.split('.').reduce((value, part) => value?.[part], english);

function text(homey, key) {
  const translated = homey?.__?.(key);
  return typeof translated === 'string' && translated !== key ? translated : lookup(key) || key;
}

// Translate only at the user-facing boundary. The controller, authentication
// categories and diagnostics keep their existing behavior and internal messages.
const powerMessages = {
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
  'Zendernummer moet een geheel getal tussen 1 en 9999 zijn.': 'errors.invalidChannel',
};

function userError(homey, error) {
  // Minimal injected Homey doubles need not implement internationalization.
  if (typeof homey?.__ !== 'function') return error;
  const authKey = typeof error?.kind === 'string' ? 'auth.' + error.kind : null;
  const key = authKey && lookup(authKey) ? authKey : powerMessages[error?.message] || 'errors.commandFailed';
  const safe = new Error(text(homey, key));
  for (const field of ['kind', 'phase', 'requiresRepair', 'status']) {
    if (error?.[field] !== undefined) safe[field] = error[field];
  }
  return safe;
}

module.exports = { text, userError };
