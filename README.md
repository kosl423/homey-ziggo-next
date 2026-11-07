# Ziggo Next for Homey

Community integration for controlling a Ziggo Mediabox Next or Next Mini directly from Homey Pro.

This project connects Homey directly to Ziggo's online services. It does not require Home Assistant, Homebridge, a separate bridge, or a smart plug for normal power control. An internet connection and access to Ziggo's services are required.

## Status

Version 0.0.26 is a prerelease with persistent MQTT connection history and improved session recovery. It has been tested with:

- Homey Pro
- Ziggo Netherlands
- Ziggo Next Mini

Homey software 10.0.0 or newer is required. Support for other Mediabox models and account configurations has not been comprehensively verified.

All 152 automated offline tests pass. Local Homey debug validation also passes. On November 7, 2026, v0.0.26 was installed on a Homey Pro without removing the existing device or clearing its settings. MQTT subscription readiness and history persistence across an app restart were verified. Live status changes from the physical Ziggo remote were verified in both directions; the owner also confirmed successful on/off control from Homey.

Long-term stability and overnight reconnect recovery remain under evaluation. Offline tests and this limited field test do not establish compatibility with every installation.

Earlier releases remain available through the [v0.0.23 tag](https://github.com/kosl423/homey-ziggo-next/tree/v0.0.23) and [v0.0.22 tag](https://github.com/kosl423/homey-ziggo-next/tree/v0.0.22).

This is a community project and is not an official Ziggo or Athom application.

## Features

The current version supports:

- Power on and standby
- Power-state updates in Homey through Ziggo's MQTT status service
- A separate Power button
- Channel up and down
- Direct channel selection from Homey Flows
- Numeric keys 0-9
- OK / Enter
- Back
- Navigation up, down, left and right
- Homey Flow support
- Automatic Ziggo session renewal
- Automatic reconnection attempts for the MQTT status connection
- Persistent history of the latest 50 MQTT connection events, with read-only JSON viewing and copying in app settings
- Device Repair for signing in again without removing the Homey device

Version 0.0.23 introduces centralized power control. Concurrent requests for the same state share one transition; conflicting requests use the latest requested state. Outdated commands can be cancelled before transmission. A possibly transmitted Power command is not automatically retried after a timeout, connection loss, or restart.

Early status messages are processed before pending power requests are evaluated. Standard on/off requests can wait up to 10 seconds for a valid live initial state. Expired requests are cancelled and will not execute later. Retained status messages alone do not enable Power commands.

Use Homey's standard on/off control to request a specific state. The Power button requests a toggle through the same controller and is blocked while the state is unknown or another transition is pending.

The installation package is significantly smaller because development tools are excluded from production dependencies.

Changes made with the physical Ziggo remote can update the Homey power state while the status connection is working. Updates may be delayed or become stale during connection problems.

See [RELEASE-0.0.26.txt](RELEASE-0.0.26.txt) for the current changes and validation limits. [RELEASE-0.0.23.txt](RELEASE-0.0.23.txt) and [STATUSINITIALISATIE-0.0.23.txt](STATUSINITIALISATIE-0.0.23.txt) describe the earlier power-control changes.

## Homey Flows

Because the device uses Homey's standard `onoff` capability, the normal Homey power Flow cards are available.

The app also provides the custom action:

`Go to channel [channel]`

Whole channel numbers from 1 through 9999 are accepted. The app sends the corresponding numeric key presses to the Mediabox. The channel must be available in the Ziggo channel lineup; accepting a number does not confirm that tuning succeeded.

App ID, driver ID, capabilities, and Flow card definitions remain unchanged from v0.0.22.

## Installation

This version is intended for manual installation with the Homey CLI.

Requirements:

- Homey Pro running compatible Homey software
- A computer with internet access on the same local network as Homey
- Access to the Athom account associated with that Homey
- A working Ziggo account with exactly one assigned Mediabox
- Node.js and npm; use a supported Node.js LTS release meeting the project requirement of Node.js 18 or newer

Check that Node.js and npm are available:

```text
node --version
npm --version
```

Download the desired source version from the [GitHub repository](https://github.com/kosl423/homey-ziggo-next) using **Code → Download ZIP**, then extract the ZIP completely. Check the version in `app.json`.

Open a terminal in the extracted folder containing `package.json`, `package-lock.json`, and `app.js`.

Install dependencies using the lockfile, then sign in and select Homey:

```text
npm ci
npx --no-install homey --version
npx --no-install homey login
npx --no-install homey select
```

The lockfile includes Homey CLI 3.0.0 as a development dependency. These `npx --no-install` commands use that local installation; a separate global CLI installation is not required.

Install the app on the selected Homey:

```text
npx --no-install homey app install
```

Wait for a successful installation message. The app then runs on Homey; the computer does not need to remain powered on. Use `app install` for this procedure. `app run` starts a development session, and stopping that session uninstalls the development app.

On Windows PowerShell, systems that block npm/homey scripts can use the `.cmd` commands without changing the execution policy:

```text
npm.cmd ci
npx.cmd --no-install homey --version
npx.cmd --no-install homey login
npx.cmd --no-install homey select
npx.cmd --no-install homey app install
```

If installation fails, check the actual error and the working directory. Do not run `npm audit fix --force` blindly; it can introduce incompatible dependency changes.

The bundled Homey CLI 3.0.0 has a reproduced upload-retry defect: after HTTP 401, its SDK may resend a consumed multipart upload incorrectly and report `Missing File`. The same behavior was reproduced in CLI 4.6.2; upgrading the CLI alone is not a demonstrated fix. If upload fails, inspect the installed app version and state before retrying. A successful exit code alone does not prove installation. The owner's v0.0.26 installation used the official upload method with automatic retry disabled; that installation safeguard is not part of this app's runtime code.

See the official [Homey CLI documentation](https://apps.developer.homey.app/the-basics/getting-started/homey-cli) for further details.

## Pairing

After installation:

1. Open Homey and add a new device.
2. Select Ziggo Next and its Ziggo Next Mini device entry.
3. Enter the Ziggo username and password.
4. The app signs in to Ziggo and discovers the assigned Mediabox.
5. Add the discovered Mediabox to Homey.

The current implementation stops if none or more than one Mediabox is found.

The Ziggo password is used for authentication and is not stored by the app. The resulting session information is stored in the Homey device store so the connection can be renewed without repeatedly asking for the password.

## Repair

If Ziggo invalidates the stored session, the device may become unavailable and request a repair.

Use the existing Homey device's Repair function and sign in to Ziggo again.

A successful Repair checks that the discovered Mediabox matches the existing device, replaces the stored session, and restarts the status connection. The device does not need to be removed, so existing Flow references can be preserved.

## Session handling

Ziggo authentication uses rotating tokens and cookies. Validation, refresh, persistence and Repair share a per-device lock. Session data, cookies, revision and refresh outcome are stored together in one versioned device-store record. New session data is persisted before requesting an MQTT token; concurrent callers share the same operation.

The app checks the current access token before requesting a refresh. Temporary configuration or MQTT-token service failures do not by themselves cause token rotation. A watchdog checks the session every 10 minutes; temporary failures use bounded retry delays. An ambiguous refresh response is recorded and is not blindly replayed with a possibly consumed refresh token. Repair can be required when the existing access token no longer works.

Legacy v0.0.23 session fields migrate on first use and remain in place. Numeric, textual and absent refresh-token expiry metadata are supported without changing their representation or guessing units. A local digest detects changes to legacy fields; conflicting or malformed records require explicit recovery rather than guessing which session is current. A successful Repair can replace an invalid record after login and verification of the existing Mediabox identity.

Downgrading to v0.0.23 can require Repair because it does not read the new record. Upgrading again after legacy fields have changed can require Repair again. Seamless rollback is not guaranteed. Versions 0.0.24 and 0.0.25 were local development stages; their session-handling improvements are included in this release.

Authentication-related device availability is restored only after session verification and acknowledgment of the corresponding MQTT status subscription. This does not bypass the separate requirement for a valid live power status.

## Diagnostics

A diagnostic page is available in the app settings.

The persistent diagnostic history records app startup, pairing, Repair, session renewal, and power-control events, including warnings and recovery information. Storage is serialized and limited to 250 entries. More detailed session diagnostics may appear in the runtime log.

Device warnings indicate an unconfirmed power state or expired initialization. A valid live state or completed transition can clear the warning.

Known issue: cleared diagnostic entries may reappear when another message is recorded.

### MQTT connection history

Version 0.0.26 adds an independent persistent history of up to 50 connection events across all devices. App settings can refresh the read-only JSON view and copy it, with manual selection if clipboard access is unavailable. No MQTT-history reset button is provided; clearing the ordinary diagnostic log does not clear this history.

Events include monitor start/failure, reconnect, connected, subscription request/readiness, separate offline/error/close callbacks, connection loss and restoration. Each record has a UTC timestamp, a random app-run identifier, an anonymous device number, a monitor number, a connected-session generation and an attempt counter. The attempt counter includes monitor starts and native MQTT reconnects since the last ready event. Counters must be interpreted within their run and device.

Records use a closed schema: no tokens, cookies, credentials, device/account identifiers, topics, raw error text or MQTT payloads are stored in this history. Its `error` event can also describe a subscription or status-processing failure; it does not expose the underlying error message.

The newest events replace the oldest. There is no expiry by age, and 50 events do not guarantee a full night's coverage during repeated failures. History survives app restarts; a new run identifier distinguishes the new lifecycle. Restoration is recorded after a previously observed loss within the same device lifecycle, rather than inferred across an app restart. Ready/restored means the subscription is ready, not that live power status has been confirmed. Shutdown or intentional monitor replacement does not synthesize a loss event.

Storage failures do not block connection or power handling. Recent events can be lost after a crash or storage failure; the next event retries the in-memory history. Removing the app removes its settings. Externally clearing the history while the app is running is unsupported because the in-memory history can repopulate it.

Review and redact diagnostic information before sharing it. When reporting a problem, include the app version, Homey software version, Mediabox model, the attempted action, and the relevant error message.

## Privacy and security

- The Ziggo password is not stored by the app.
- The Homey device store contains the Ziggo username, authentication tokens, session cookies, and account/device identifiers required for the connection.
- Stored session credentials are sensitive and must be protected.
- General diagnostics may include metadata and operational error messages; review them before sharing. The separate MQTT history uses the restricted schema described above.
- Never publish credentials, tokens, cookies, household identifiers, or device identifiers in issues, screenshots, or logs.

## Limitations

- Testing has focused on Ziggo Netherlands, Homey Pro, and a Next Mini.
- Pairing and Repair require exactly one assigned Mediabox.
- Power control can remain blocked after startup or reconnection until a valid live status arrives.
- An uncertain command outcome may require a new live target status before further power commands are accepted.
- MQTT key commands retain QoS 2 and `retain: true`. These settings do not guarantee exactly one physical execution across the complete Ziggo service chain.
- Protection covers commands from this app; other clients and the physical remote can still change the device state.
- A power-state update does not identify what caused the Mediabox to switch on.
- The app does not independently confirm the state of a TV or receiver and cannot restore mains power.
- Changes to Ziggo authentication or backend services may break the integration.
- This community project has no official Ziggo or Athom support. Continued maintenance and compatibility are not guaranteed.

## Protocol reference

The Ziggo authentication and set-top-box protocol implementation was developed with reference to the open-source [homebridge-eosstb](https://github.com/jsiegenthaler/homebridge-eosstb) project by Jan Siegenthaler.

See [NOTICE.txt](NOTICE.txt) for attribution information.

## Contributing

Issues, technical findings, and pull requests are welcome through the repository.

Describe the setup and provide steps to reproduce a problem, with sensitive information removed. Long-term maintenance is not guaranteed.

To run the offline tests:

```text
npm test
```

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Known issues

### v0.0.23: Power control times out after Repair

Reported October 30, 2026, with Homey Pro, Ziggo Netherlands, and a Next Mini.

After a successful Device Repair, switching the Mini on through Homey may fail with:

```text
Timeout after 10000 ms
```

The status connection can be established while the app has received only a retained status snapshot. Until a valid live status arrives, the power controller waits for an initial state and cancels the request after 10 seconds. In the reported incident, no Power command was transmitted during these attempts.

**Workaround**

1. Turn the Mini on once using the physical Ziggo remote.
2. Wait until the Homey device shows the Mini as ON.
3. Switch the Mini off and on again through the Homey device controls to confirm that control and status updates have recovered.

This restored normal operation in the reported incident. No additional Repair or restart was required.

**Investigation status**

The original session-renewal failure remains under investigation. Configuration requests returned HTTP 500 before the session was reported as invalid, but a causal link has not been established. Session renewal succeeded again after Repair; power control resumed after the live status update triggered by the physical remote.

This workaround addresses the missing initial live status after Repair. It does not resolve or explain the preceding authentication failure.
