# Ziggo Next for Homey

Community integration for controlling a Ziggo Mediabox Next or Next Mini directly from Homey Pro.

This project connects Homey directly to the Ziggo services used by the Mediabox. It does not require Home Assistant, Homebridge, a separate bridge, or a smart plug for normal power control.

## Status

Version 0.0.22 is currently tested with:

- Homey Pro
- Ziggo Netherlands
- Ziggo Next Mini

The integration has been developed and tested against a real Ziggo Next Mini. Support for other Ziggo Next models has not yet been verified.

This is a community project and is not an official Ziggo or Athom application.

## Features

The current version supports:

- Power on and standby
- Real-time power state in Homey
- Channel up and down
- Direct channel selection from Homey Flows
- Numeric keys 0-9
- OK / Enter
- Back
- Navigation up, down, left and right
- Homey Flow support
- Automatic Ziggo session renewal
- Automatic reconnection of the MQTT status connection
- Device Repair for signing in again without removing the Homey device

Power control is state-aware. Homey receives the actual running or standby state from the Mediabox and does not blindly send another Power command when the requested state is already active.

Changes made with the physical Ziggo remote are also reflected in the Homey power state.

## Homey Flows

Because the device uses Homey's standard `onoff` capability, the normal Homey power Flow cards are available.

The app also provides the custom action:

`Go to channel [channel]`

Channel numbers from 1 through 9999 are accepted. The app sends the required numeric key presses to the Mediabox.

## Installation

This version is currently intended for manual installation with the Homey CLI.

Requirements:

- Homey Pro
- Node.js
- Homey CLI
- A working Ziggo account with an assigned Mediabox Next or Next Mini

Clone or download this repository and open a terminal in the project directory.

Install the dependencies:

```text
npm install
```

Install the app on Homey:

```text
homey app install
```

On Windows PowerShell, systems that block the PowerShell npm/homey scripts can use:

```text
npm.cmd install
homey.cmd app install
```

Follow the Homey CLI instructions to sign in and select your Homey Pro when required.

## Pairing

After installation:

1. Open Homey and add a new device.
2. Select Ziggo Next.
3. Enter your Ziggo username and password.
4. The app signs in to Ziggo and discovers the Mediabox assigned to the account.
5. Add the discovered Mediabox to Homey.

The Ziggo password is used only to perform the login and is not stored by the app.

The resulting Ziggo session information is stored in the Homey device store so the connection can be renewed without repeatedly asking for the password.

## Repair

If Ziggo invalidates the stored session, Homey can mark the device as unavailable and ask for the connection to be repaired.

Use the Homey device Repair function and sign in to Ziggo again.

A successful Repair replaces the Ziggo session and reconnects the status monitor without requiring the device to be removed from Homey. Existing Homey Flows can therefore remain attached to the same device.

## Session handling

Ziggo authentication uses rotating session information. Both authentication tokens and the associated cookie state must be preserved when a session is renewed.

The app automatically checks the session, renews it when necessary, stores the rotated session state, and reconnects to the Mediabox status service.

No password or complete authentication token is written to the diagnostic log.

## Diagnostics

A diagnostic page is available in the app settings.

The persistent diagnostic history contains only operational events such as:

- App start
- Successful pairing
- Successful Repair
- Successful automatic session renewal
- Session renewal failures

Detailed development diagnostics are written only to the normal runtime log.

Do not publish diagnostic information without checking it first.

## Privacy and security

- The Ziggo password is not stored.
- Authentication tokens and session cookies are stored locally in the Homey device store because they are required to maintain the Ziggo session.
- Complete authentication tokens are not written to the persistent diagnostic history.
- Never publish Ziggo credentials, authentication tokens, cookies, household identifiers, or device identifiers when reporting an issue.

## Limitations

- Currently tested only with Ziggo Netherlands and a Ziggo Next Mini.
- The current pairing implementation expects exactly one assigned Mediabox.
- Ziggo does not provide this integration as a public Homey API. Changes to Ziggo authentication or backend services may therefore break the integration.
- This project is community maintained and comes without official support from Ziggo or Athom.

## Protocol reference

The Ziggo authentication and set-top-box protocol implementation was developed with reference to the open-source `homebridge-eosstb` project by Jan Siegenthaler:

https://github.com/jsiegenthaler/homebridge-eosstb

No source file from that project is bundled in this repository.

See `NOTICE.txt` for additional attribution information.

## Contributing

This project is shared so that other Homey users and developers can test, improve, and maintain the integration.

Issues, technical findings, and pull requests are welcome. Long-term maintenance is not guaranteed.

## License

This project is licensed under the MIT License. See `LICENSE` for details.
