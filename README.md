# Ziggo Next for Homey

Community-integratie voor het bedienen van een Ziggo Mediabox Next of Next Mini vanuit Homey Pro via de online diensten van Ziggo.

Voor normale aan/uit-bediening zijn geen Home Assistant, Homebridge, aparte bridge of slimme stekker nodig. Een internetverbinding en bereikbare Ziggo-diensten zijn wel vereist. Dit is een communityproject, geen officiële app van Ziggo of Athom.

## Status en compatibiliteit

Deze release bevat **v0.0.23** van Ziggo Next for Homey, met centrale aan/uit-bewaking, verbeterde statusinitialisatie en een kleiner installatiepakket.

Getest met Homey Pro, Ziggo Nederland en een Next Mini. Alle **56 offline tests** slagen. Dit is geen algemene compatibiliteitsgarantie voor andere Mediabox-modellen of accountconfiguraties.

Het appmanifest vereist Homey-software **10.0.0 of nieuwer** en de lokale Homey-platformomgeving. De installatie hieronder is bedoeld voor Homey Pro.

De eerdere versie blijft beschikbaar via de tag [v0.0.22](https://github.com/kosl423/homey-ziggo-next/tree/v0.0.22). Controleer de versie in `app.json` wanneer je broncode downloadt.

## Nieuw in v0.0.23

- Centrale aan/uit-bewaking per apparaat beschermt zowel de standaardbediening als de losse Power-knop.
- Gelijktijdige gelijke verzoeken delen één overgang. Bij tegenstrijdige verzoeken telt het laatste gewenste doel.
- Een mogelijk verzonden Power-opdracht wordt bij een timeout of verbindingsverlies niet automatisch herhaald.
- Vroege statusberichten worden verwerkt voordat wachtende aan/uit-verzoeken worden beoordeeld.
- Bij onbevestigde Powerstatus verschijnt een apparaatwaarschuwing.
- De diagnosegeschiedenis bevat maximaal 250 regels, inclusief Power-gebeurtenissen.
- Het installatiepakket is sterk verkleind door ontwikkelhulpmiddelen buiten de productieafhankelijkheden te houden. Er is geen procentuele omvangreductie vastgesteld.

Zie [RELEASE-0.0.23.txt](RELEASE-0.0.23.txt) voor de release notes.

## Bediening en Homey Flows

De app biedt aan/uit, zender omhoog/omlaag, cijfertoetsen 0–9, OK/Enter, Terug en navigatie in vier richtingen. Sessievernieuwing, herstelpogingen voor de statusverbinding en opnieuw aanmelden via Repareren zijn beschikbaar.

Gebruik Homey's standaard aan/uit-bediening wanneer je een specifieke toestand wilt aanvragen. De losse Power-knop vraagt een wisseling van de laatst bevestigde toestand aan en gebruikt dezelfde bewaking. Hij is geblokkeerd zolang de status onbekend is of een opdracht loopt.

Na opstarten of verbindingsherstel kunnen aan/uit-verzoeken maximaal tien seconden op een bruikbare live beginstatus wachten. Een verlopen of geannuleerd verzoek wordt niet later alsnog uitgevoerd. Alleen een bewaard statusbericht geeft geen toestemming om Power te versturen.

De standaard `onoff`-mogelijkheid levert de normale Homey-Flowkaarten. Daarnaast is er de actie **Ga naar zender [zender]**. Gehele zendernummers van 1 tot en met 9999 worden als cijfertoetsen verstuurd. Het nummer moet beschikbaar zijn in je Ziggo-zenderaanbod; verzending bevestigt niet dat het afstemmen is gelukt.

Wijzigingen via de fysieke Ziggo-afstandsbediening kunnen via live status in Homey verschijnen. Bij verbindingsproblemen kan die informatie vertraagd of verouderd zijn. Een AAN-melding bewijst niet wie of wat de Mediabox heeft aangezet.

## Handmatige installatie

### 1. Voorbereiden

Je hebt nodig:

- Een Homey Pro met geschikte Homey-software.
- Een computer met internet, verbonden met hetzelfde lokale netwerk als Homey.
- Toegang tot het Athom-account van die Homey.
- Een werkend Ziggo-account met precies één toegewezen Mediabox.
- Node.js en npm. Gebruik een ondersteunde Node.js LTS-versie die voldoet aan de projecteis Node.js 18 of nieuwer.

Controleer in een terminal:

```text
node --version
npm --version
```

### 2. De bron downloaden

Download de gewenste bronversie van de [GitHub-repository](https://github.com/kosl423/homey-ziggo-next) via **Code → Download ZIP** en pak die volledig uit. Controleer de versie in `app.json`: de standaardbranch kan een andere versie bevatten dan deze lokale voorbereiding.

Open een terminal in de uitgepakte map met `package.json`, `package-lock.json` en `app.js`.

### 3. Afhankelijkheden installeren en aanmelden

```text
npm ci
npx --no-install homey --version
npx --no-install homey login
npx --no-install homey select
```

`npm ci` gebruikt de meegeleverde lockfile met Homey CLI **3.0.0** als ontwikkelafhankelijkheid. De opdrachten met `npx --no-install` gebruiken die lokale installatie; een aparte globale installatie is hiervoor niet nodig.

Volg de aanmeldprocedure en selecteer de bedoelde Homey Pro. De Athom-aanmelding staat los van het Ziggo-account dat je later bij het koppelen gebruikt.

### 4. Op Homey installeren

Deze opdracht wijzigt de app-installatie op de geselecteerde Homey:

```text
npx --no-install homey app install
```

Wacht op de bevestiging dat de installatie is geslaagd. De app draait daarna op Homey; de computer hoeft niet aan te blijven. Gebruik voor deze procedure `app install`. `app run` start een ontwikkelsessie; stoppen daarvan verwijdert de ontwikkelapp.

### Windows PowerShell

Als PowerShell scripts blokkeert, gebruik je de `.cmd`-varianten zonder het uitvoeringsbeleid te wijzigen:

```text
npm.cmd ci
npx.cmd --no-install homey --version
npx.cmd --no-install homey login
npx.cmd --no-install homey select
npx.cmd --no-install homey app install
```

Bij een installatiefout: controleer de concrete foutmelding en of je in de juiste map staat. Voer niet blind `npm audit fix --force` uit; dat kan onverenigbare afhankelijkheden introduceren.

Zie ook de officiële [Homey CLI-documentatie](https://apps.developer.homey.app/the-basics/getting-started/homey-cli).

## Koppelen en repareren

Kies in Homey voor het toevoegen van een apparaat, selecteer Ziggo Next en de apparaatvermelding Ziggo Next Mini, en meld je aan met je Ziggo-gebruikersnaam en wachtwoord. De huidige implementatie stopt wanneer nul of meer dan één Mediabox wordt gevonden.

Bij een ongeldige sessie kun je het bestaande apparaat via **Repareren** opnieuw aanmelden. Repareren controleert of de gevonden Mediabox bij het bestaande apparaat hoort, bewaart de nieuwe sessie en start de statusverbinding opnieuw. Het apparaat hoeft daarvoor niet te worden verwijderd; bestaande Flow-verwijzingen kunnen behouden blijven.

## Diagnose en privacy

De appinstellingen bevatten de diagnosegeschiedenis en de knop **Diagnose wissen**. De geschiedenis is begrensd op 250 regels. Naast opstarten, koppelen, repareren en sessievernieuwing bevat deze nu Power-gebeurtenissen, waarschuwingen en herstelmeldingen. Meer sessiedetails kunnen in het runtime-log staan.

Bekende beperking: de knop **Diagnose wissen** wist de opgeslagen regels, maar oude regels kunnen bij een volgende logmelding terugkomen doordat de app ze nog in het geheugen heeft. Een correctie hierop is niet opgenomen in deze release.

Het Ziggo-wachtwoord wordt gebruikt voor aanmelden en niet opgeslagen door de app. De Homey-apparaatopslag bevat wel de gebruikersnaam, sessietokens, cookies en account-/apparaatidentificatie die nodig zijn voor de verbinding. Behandel die gegevens als gevoelig.

De diagnose gebruikt tokenfingerprints en metadata. Dat is geen garantie dat iedere foutmelding vrij is van gevoelige informatie. Controleer logs vóór delen en verwijder inloggegevens, tokens, cookies en persoonlijke identificatie.

## Beperkingen

- Praktijkervaring richt zich op Ziggo Nederland, Homey Pro en een Next Mini.
- Koppelen en repareren verwachten precies één toegewezen Mediabox.
- Alleen bewaarde statusberichten zijn onvoldoende om Power vrij te geven. Herstel kan een nieuwe live status, bijvoorbeeld na fysieke bediening, vereisen.
- Een onzekere Power-uitvoering wordt niet automatisch opnieuw geprobeerd.
- De bestaande MQTT-toetsverzending met `qos: 2` en `retain: true` blijft behouden. Hiermee is niet gegarandeerd dat een opdracht over de hele Ziggo-keten precies één keer fysiek wordt uitgevoerd.
- De app bewaakt opdrachten uit deze app; gelijktijdige bediening via andere clients of de fysieke afstandsbediening blijft mogelijk.
- De app bevestigt niet zelfstandig de toestand van je tv of receiver en kan geen netspanning herstellen.
- Wijzigingen aan Ziggo-diensten of authenticatie kunnen de integratie verstoren. Doorlopende compatibiliteit en ondersteuning zijn niet gegarandeerd.

## Offline ontwikkeling en controles

```text
node --test test/power-controller.test.js test/integration.test.js
```

De 56 tests gebruiken nagebootste Homey- en MQTT-omgevingen en vereisen geen verbinding met Homey of Ziggo. Ze behandelen onder meer gelijktijdige Power-verzoeken, annulering, verbindingsverlies, herstart zonder herhaling en statusinitialisatie.

De statusinitialisatierevisie heeft op 14 oktober 2026 offline Homey CLI-debugvalidatie doorlopen. Dat is geen App Store-goedkeuring of brede hardwaretest.

De 45 productieafhankelijkheden hebben dezelfde versies en integriteitscontrolesommen als de onderzochte v0.0.22-bron. Homey CLI staat in de ontwikkelafhankelijkheden en wordt niet als CLI in het installatiepakket meegenomen. Houd `node_modules`, `.homeybuild` en reservebestanden buiten een bronrelease.

[STATUSINITIALISATIE-0.0.23.txt](STATUSINITIALISATIE-0.0.23.txt) beschrijft de ontwikkeling en controles van 14 oktober 2026. De actuele release-informatie staat in deze README en de release notes.

## Protocolreferentie en bijdragen

De protocolimplementatie is ontwikkeld met [homebridge-eosstb van Jan Siegenthaler](https://github.com/jsiegenthaler/homebridge-eosstb) als referentie. Zie [NOTICE.txt](NOTICE.txt) voor de toelichting.

Probleemmeldingen en bijdragen zijn welkom via de repository. Vermeld appversie, Homey-softwareversie, Mediabox-model, de uitgevoerde handeling en de relevante foutmelding, met gevoelige gegevens verwijderd.

## Licentie

MIT. Zie [LICENSE](LICENSE).
