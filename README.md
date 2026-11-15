# Ziggo Next for Homey

Independent community integration connecting Homey Pro to Ziggo Netherlands services. No additional bridge is required. This is not an official Ziggo app; no Ziggo or Athom endorsement is claimed.

## v0.0.28 experimental prerelease

The corresponding [App Store Test version](https://homey.app/nl-nl/app/nl.koos.ziggonextpoc/test/) was submitted for certification with automatic Live publication disabled. Certification approval is not claimed. This GitHub release does not update your installed app or publish to Athom Live.

Compared with v0.0.26: clearer initial-status warnings; corrected diagnostic clearing; English/Dutch UI and error-handling improvements; original icons and new photographs; dependency maintenance; compact authentication diagnostics. See [release notes](RELEASE-0.0.28.txt).

## Requirements and tested models

- Homey Pro with Homey 10+, internet and a Ziggo Netherlands account with exactly one assigned Mediabox.
- **Next Mini:** primary field-tested model for v0.0.28.
- **Regular Next:** a user reports power control, remote status, channel selection/navigation and daily connectivity with the older CLI v0.0.23. Later morning startup channel selection was not consistently successful. This is not regular-Next v0.0.28 field-test evidence.
- Homey Cloud, multiple-box accounts and other hardware/configurations are outside the validated scope.

## Install from the App Store Test page

Installing the app and adding the box are separate steps. Installation does not automatically create a device tile or open Ziggo sign-in. Use your own Homey app or [web app](https://my.homey.app/); ChatGPT is not required.

1. Open the [Test page](https://homey.app/nl-nl/app/nl.koos.ziggonextpoc/test/), sign in to Homey, select the correct Homey Pro and install the app.
2. Choose **Devices → Add device → Ziggo Next → Ziggo Next Mini → Connect**. Tested Dutch web path: **Apparaten → Voeg toe… → Nieuw Apparaat → Ziggo Next → Ziggo Next Mini → Verbinden**. Labels may differ by client/language. If searching only shows the other Ziggo app, clear the search and select **Ziggo Next** under installed brands. Check the selected Homey Pro, particularly if the web app initially shows an empty Cloud profile.
3. Enter your Ziggo username/password in the pairing screen and choose **Pair my Ziggo Next Mini**. Complete the Homey dialogue. The password is not stored by this app; session tokens/cookies are kept on Homey. Never share credentials in a chat/forum.
4. Switch the box once with the Ziggo remote and wait for Homey to follow the live state. Until then, the waiting warning is expected and Power control may be blocked.

### Existing CLI users

CLI and Store builds share app ID nl.koos.ziggonextpoc and are not independent parallel installations. A working CLI version can remain in use. **Do not uninstall as a routine update step.** Direct same-version CLI-to-Store replacement with automatic device/settings/Flow preservation has not been separately tested.

One explicitly chosen clean transition was tested on November 14: uninstalling removed the old Mini; Store installation required adding/signing in again and created a new Homey device ID. All existing Flows remained, but ten Ziggo card references in four Advanced Flows still referenced the deleted device. They required deliberate manual replacement while preserving arguments, conditions and connections. Physical Mini/TV ON/OFF and automatic RTL4 then passed one supervised cycle.

A matching device name does not restore references. A Flow may appear intact despite a deleted device. Before choosing a clean reinstall, record affected cards, device tokens, arguments, conditions and connections and allow time for manual repair. This is not an automatic migration guarantee. Installing old code does not by itself restore deleted devices/settings. Investigate unexpected errors before repeating sign-in, Repair or installation.

## Manual CLI installation and development

Use **Node.js 24+** for the pinned development tools. The runtime declaration remains Node.js>=18; the Homey firmware requirement above also applies. Download/extract the v0.0.28 source or check out the tag, then open a terminal in the folder containing package.json.

Run these commands in order:

    npm ci
    npm test
    npx --no-install homey --version
    npx --no-install homey login
    npx --no-install homey select
    npx --no-install homey app install

Homey CLI 4.6.2 is pinned; no global CLI is needed. Confirm the target Homey before installing. On Windows use npm.cmd/npx.cmd if PowerShell blocks script wrappers; changing execution policy is unnecessary. Use app install for persistent installation; app run is a temporary development session with a different lifecycle.

A CLI authorization/upload-retry problem has been observed, including a subsequent Missing File error. After any failed or uncertain upload, first check which version actually reached Homey and retain the error. Do not blindly repeat, remove the device or apply npm audit fix --force. The runtime package excludes the CLI program/test tools. See the dated [security review](SECURITY-REVIEW.md) for unresolved development-tool advisories.

## Features and retention

- State-aware ON/standby and a separate Power button, protected by live initial status; uncertain Power transmissions are not blindly replayed.
- Ziggo MQTT power updates, automatic session renewal and reconnect attempts.
- Channel up/down, digits, navigation, OK/Back; channel-number Flow action accepting integers1–9999.
- English/Dutch pairing, Repair, settings, warnings and user-facing errors.
- Persistent MQTT connection history capped at 50 events with read-only viewing/copying.
- Ordinary diagnostics capped at 250 entries; routine authentication summarized per ten-minute UTC window, unexpected errors/Power/status kept separate.

Clear diagnostics resets the ordinary log and summary counters, not MQTT history or session credentials. There is no separate MQTT reset button. Both histories survive normal app restarts; oldest entries are overwritten at the limits. No expiry by age or fixed hours of retention is promised. [Privacy details](PRIVACY.md).

## Known limitations and open checks

**Startup channel selection:** ON does not prove channel-input readiness. The action sends digits sequentially, with 350 ms between digits, but does not wait for box readiness, verify tuning or automatically repeat a successfully published digit. MQTT publication is not proof that the box processed the key. Compared v0.0.23/v0.0.28 channel, key transport and Power-controller code is identical. Session recovery differs, but no version-specific cause or fix for the regular-Next startup report is established. A12-second delay was not consistently successful; a proposed 30-second trial has no reported outcome. No delay is universally guaranteed and upgrading is not a proven fix.

**Power initialization:** after app startup, Repair or connection loss, a current live state is required; a retained snapshot or subscription-ready message is insufficient. Use the physical remote once and wait for Homey to follow. Repeated toggling/Repair is not a remedy for missing live status.

**TV/receiver:** the app tracks the Mediabox, not independent picture/sound or receiver readiness. Behavior depends on connected equipment, HDMI-CEC and user Flows. Dependent commands may need sequencing and setup-specific waits. Unrelated Homey Flows are not globally serialized by this app.

**Remaining validation:** explicit network loss/recovery; complete EN/NL mobile/web/Repair/error-path review; direct CLI-to-Store preservation; regular-Next v0.0.28 field testing. Ziggo service changes/outages can affect operation. Athom certification, artwork and separate-listing review are not presumed complete.

## Validation and field observations

233 offline application tests pass. Next Mini checks include upgrades, physical remote/Homey power, initial warnings, diagnostic viewing/copying/clearing, icon recognition and clean Store Test installation with Dutch web sign-in. After manual Flow-reference repair, one supervised ON/OFF/TV-follow/visible-RTL4 cycle passed. This is not a guarantee for every installation.

The November 15 read-only check found v0.0.28 enabled/not crashed and the Mini available without warning. Retained records contained 158 watchdog successes,158 successful refreshes, seven completed Power transitions and the same four MQTT startup events as after pairing, with no later registered reconnect/restart/outage. Diagnostics retained 233/250 entries and approximately 26h35m, including the whole night. Earlier observations reached36h10m. Retention varies with activity. These observations do not independently prove picture/sound/channel correctness or uninterrupted uptime over all prior days; one log row was not classified by the inspection parser.

## Privacy, licensing and support

See [PRIVACY.md](PRIVACY.md), [ASSETS.md](ASSETS.md), [NOTICE.txt](NOTICE.txt) and [LICENSE](LICENSE). Photographs/third-party marks are not automatically covered by the code's MIT license. No automatic diagnostic upload to the developer is included.

Report version, Homey firmware, box model, steps, expected/actual behavior, time and redacted errors through [GitHub issues](https://github.com/kosl423/homey-ziggo-next/issues) or the [community topic](https://community.homey.app/t/160299). Never share passwords, tokens, cookies, device stores or raw MQTT payloads. Community maintenance has no guaranteed response time or service availability.

Previous [v0.0.26](https://github.com/kosl423/homey-ziggo-next/releases/tag/v0.0.26), [v0.0.23](https://github.com/kosl423/homey-ziggo-next/releases/tag/v0.0.23) and [v0.0.22](https://github.com/kosl423/homey-ziggo-next/releases/tag/v0.0.22) remain available. Historical notes describe their own version. See [remaining review checks](STORE-PREPARATION.md).

Security snapshot, November 15, 2026: production audit zero known findings; development tree one low/five moderate, no high/critical. These are the documented deepmerge/parseuri issues; no forced fixes or dependency changes were applied for publication.
