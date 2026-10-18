# Ziggo Next for Homey

Community integration for controlling a Ziggo Mediabox Next or Next Mini from Homey Pro through Ziggo's online services.

Home Assistant, Homebridge, a separate bridge, and a smart plug are not required for normal power control. An internet connection and access to Ziggo's services are required; this is not an offline or local-network-only integration.

This is a community project, not an official Ziggo or Athom application.

## Status and compatibility

This README is prepared for v0.0.23. At the time of this documentation update, the public repository's app manifest and package metadata still identify v0.0.22. Check the version in `app.json` in the source you download; replacing this README does not update the app itself.

The integration has been developed and tested with:

- Homey Pro
- Ziggo Netherlands
- Ziggo Mediabox Next Mini

A community user has also reported successful use with a Mediabox Next. This is a user report, not confirmation that every Next model or configuration is supported.

The public app manifest requires Homey software v10.0.0 or newer and targets the local Homey platform. The installation instructions below are for Homey Pro, not Homey Cloud or Homey Bridge.

## Features

- Power on and standby through Homey's standard on/off control
- Power-state updates from Ziggo's MQTT status service
- A separate Power button for manual toggling
- Channel up and down
- Direct channel selection from Homey Flows
- Numeric keys 0–9
- OK / Enter and Back
- Navigation up, down, left, and right
- Automatic Ziggo session renewal
- Automatic reconnection attempts for the MQTT status connection
- Device Repair to sign in again without removing the Homey device

Homey's standard on/off control uses the last power state received from Ziggo. If that state already matches the requested state, the app does not send another Power command. If no power state has been received yet, the command is rejected until a state becomes available.

The separate Power button sends a toggle command. Use the standard on/off control in Flows when you want to request a specific state.

Changes made with the physical Ziggo remote can also update Homey's power state while the status connection is working. Updates may be delayed or become stale during connection problems. Sending a command does not guarantee that the Mediabox has completed the requested action.

## Homey Flows

The device uses Homey's standard `onoff` capability, which provides the normal power Flow cards.

The app also provides a custom action:

`Go to channel [channel]` / `Ga naar zender [zender]`

Whole channel numbers from 1 through 9999 are accepted. The app sends the corresponding numeric key presses to the Mediabox. The number must be available in your Ziggo channel lineup; accepting a number does not confirm that the channel exists or that tuning succeeded.

## Installation

Manual installation uses the Homey command-line interface (CLI) on your computer. These instructions do not require an existing CLI installation.

### 1. Prepare your computer and Homey

You need:

- A Homey Pro running compatible Homey software
- A computer with internet access, connected to the same local network as Homey Pro
- Access to the Athom account associated with that Homey
- A working Ziggo account with exactly one assigned Mediabox, as required by the current pairing implementation
- Node.js and npm installed on your computer

Install a supported Node.js LTS release from [nodejs.org](https://nodejs.org/). The public app package declares Node.js 18 or newer, but the current Homey CLI may have a higher requirement. Use a supported LTS release that meets both requirements; you do not need to install an obsolete Node.js release just because its version matches an older Homey runtime.

After installing Node.js, open a new terminal: PowerShell or Command Prompt on Windows, or Terminal on macOS/Linux. Check that Node.js and npm are available:

```sh
node --version
npm --version
```

### 2. Install the Homey CLI

```sh
npm install --global homey
homey --version
```

Sign in with your Athom account and select your Homey Pro:

```sh
homey login
homey select
```

Follow the browser login and terminal prompts. These credentials are separate from the Ziggo credentials used later during device pairing.

### 3. Download the app source

Open the [GitHub repository](https://github.com/kosl423/homey-ziggo-next), choose **Code → Download ZIP**, and extract the ZIP completely.

Open a terminal in the extracted project folder. This is the folder containing `package.json`, `app.json`, and `app.js`, not the parent folder or the unopened ZIP.

Alternatively, if Git is installed:

```sh
git clone https://github.com/kosl423/homey-ziggo-next.git
cd homey-ziggo-next
```

These commands download the current default branch. Check `app.json` if you need a particular app version.

### 4. Install dependencies and upload to Homey

Run these commands from the project folder:

```sh
npm install
homey app install
```

Wait for a successful installation message. The app runs on Homey Pro after installation; you can close the terminal and turn off your computer.

Use `homey app install` for this installation procedure. `homey app run` starts a development session, and stopping that session uninstalls the development app.

### Windows PowerShell: blocked scripts

If PowerShell reports that `npm.ps1` or `homey.ps1` cannot run because script execution is disabled, use the `.cmd` commands instead. You do not need to change the PowerShell execution policy for these commands:

```powershell
npm.cmd --version
npm.cmd install --global homey
homey.cmd --version
homey.cmd login
homey.cmd select
```

Then, from the extracted project folder:

```powershell
npm.cmd install
homey.cmd app install
```

### Installation warnings and errors

Dependency deprecation warnings and npm vulnerability summaries can appear during installation. A warning is not necessarily an installation failure, but successful installation does not establish that every dependency is secure.

If installation fails, check the actual error and whether you are in the correct project folder. Repeating the same commands is not a reliable fix. Do not run `npm audit fix --force` blindly: it can introduce incompatible dependency changes.

For CLI setup and command details, see the official [Homey getting started guide](https://apps.developer.homey.app/the-basics/getting-started) and [Homey CLI reference](https://apps.developer.homey.app/the-basics/getting-started/homey-cli).

## Pairing

After installing the app:

1. Open Homey and choose to add a new device.
2. Select the **Ziggo Next** app and its **Ziggo Next Mini** device entry. This is the driver name in the current public source, including when testing a Next.
3. Enter your Ziggo username and password.
4. The app signs in to Ziggo and discovers the Mediabox assigned to your account.
5. Add the discovered Mediabox to Homey.

The current pairing implementation requires exactly one discovered Mediabox. It stops if none or more than one are found.

The Ziggo password is used for authentication and is not persisted by the app. The resulting session information is stored in the Homey device store so the connection can be renewed without repeatedly asking for the password.

## Repair

If the Ziggo session becomes invalid, the device may become unavailable and request a repair.

Open the existing device's maintenance options in Homey, choose **Repair**, and sign in to Ziggo again. The wording and location of this option may vary between Homey interfaces.

A successful Repair stores the new session, restarts the status monitor, and makes the device available again. It checks that the discovered Mediabox matches the existing device. Because Repair keeps the same Homey device, existing Flow references can be preserved.

## Session handling

Ziggo authentication uses rotating tokens and cookies. The app attempts to renew the session automatically and stores the updated session information on Homey.

Automatic session renewal and MQTT reconnection depend on Ziggo accepting the session and its services being reachable. If renewal can no longer recover the connection, use Repair to authenticate again.

## Diagnostics

A diagnostic page is available in the app settings. The persistent diagnostic history records operational events, including app startup, pairing, Repair, and some session-renewal events and failures. More detailed diagnostics are written to the runtime log.

Diagnostic coverage is limited; the absence of an error in the history does not prove that a command succeeded or that the connection is healthy.

Review and redact diagnostic information before sharing it. When reporting a problem, include the app version, Homey software version, Mediabox model, the action you tried, and the relevant error message.

## Privacy and security

- The app does not persist your Ziggo password.
- The Homey device store contains the Ziggo username, authentication tokens, session cookies, and account/device-related identifiers needed for the connection.
- These stored session credentials are sensitive and must be protected.
- The diagnostic code uses token metadata and fingerprints rather than deliberately recording complete tokens. Always review logs before sharing them; this is not a guarantee that every error message is free of sensitive information.
- Never publish passwords, authentication tokens, cookies, household identifiers, or device identifiers in issues, screenshots, or logs.

## Limitations

- Development testing has focused on Ziggo Netherlands and a Next Mini. Other models and account configurations are not comprehensively verified.
- Pairing and Repair currently expect exactly one assigned Mediabox.
- Power-state information depends on the Ziggo status connection and may become stale.
- Remote power control requires the Mediabox to remain powered and reachable through Ziggo's services. It cannot restore mains power to an unplugged device.
- This app controls the Mediabox. It does not independently confirm the TV's power state or the selected input on a TV or AV receiver.
- The integration relies on Ziggo services rather than an officially supported public API for this Homey app. Backend or authentication changes may break it.
- This is a community project without official Ziggo or Athom support. Continued maintenance and compatibility are not guaranteed.

## Protocol reference

The Ziggo authentication and set-top-box protocol implementation was developed with reference to the open-source [homebridge-eosstb](https://github.com/jsiegenthaler/homebridge-eosstb) project by Jan Siegenthaler.

According to this repository's attribution notice, no source file from that project is bundled here. See [NOTICE.txt](NOTICE.txt) for additional attribution information.

## Contributing

Issues, technical findings, and pull requests are welcome through the [GitHub repository](https://github.com/kosl423/homey-ziggo-next).

Please describe your setup and provide steps to reproduce a problem, with sensitive information removed. The project is shared for community testing and development; personal support and long-term maintenance are not guaranteed.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
