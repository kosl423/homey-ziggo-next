# Privacy and data handling

This is an independent community integration. The app communicates from Homey to Ziggo's authentication, configuration and MQTT services to sign in, discover the assigned Mediabox, receive status and send remote-control commands. These external services are necessary for operation; this is not a local-only integration.

## Credentials and session storage

The password is used for sign-in and is not deliberately persisted by the app. Pairing and Repair views clear their password input after completion or failure. This does not claim secure erasure from browser or runtime memory.

Homey's device store contains the username, account/device identifiers, session tokens, cookies and refresh state needed to maintain the connection. A pending power-transition record can also be stored to prevent unsafe replay after restart. Existing legacy session fields are retained for migration compatibility. These records are sensitive and should not be shared.

## Diagnostics

The app's ordinary diagnostic log stores up to 250 entries. Routine authentication events are summarized per ten-minute UTC window, with first/last timestamps, fixed event counters and session revision ranges. Expected access-token 401 rejections remain visible as counters; they are not assumed to have recovered. Separate refresh/session-verification/watchdog-success counters show what subsequently completed. A partial summary is saved immediately rather than waiting for a successful result or a timer.

Unexpected failures, repair requirements, storage errors, Power/status events and unknown diagnostic schemas remain separate entries. Only a closed allowlist of routine auth metadata is summarized; no tokens, cookies, request bodies or arbitrary text are added to summaries. Existing operational errors elsewhere can still contain contextual information; review and redact the ordinary log before sharing it.

MQTT history stores at most 50 events across devices: timestamps, fixed event types, random app-run IDs and anonymous numeric connection/device counters. It excludes passwords, tokens, cookies, physical device/account IDs, topics, raw error messages and MQTT payloads. An anonymous counter only identifies a device within the corresponding app run.

No separate analytics or advertising service is included. The app does not automatically send diagnostics to the developer. Copying a history only places the text on the user's clipboard; the user decides whether and where to share it.

## Retention and clearing

Diagnostic entries and MQTT history survive normal app restarts. New entries replace the oldest at their respective limits; there is no expiry by age. Storage failures or crashes can lose recent entries.

Summary timestamps identify the first event in a window; `to` identifies its latest event. A summary can therefore span separate Power/error entries. After an app restart, a fresh summary is created even within the same UTC window; old records are retained without being rewritten. Existing v0.0.27 log entries are not retroactively compacted. A busy log or error storm can still exhaust 250 entries before a whole night is covered. There is no guaranteed minimum retention in hours. Summarization reduces entries, not the number of per-event storage writes.

The settings action Clear diagnostics clears the ordinary saved log, its in-memory buffer and current summary counters through an authenticated endpoint. It does not clear session credentials, the pending power record or MQTT history. Older queued writes finish before acknowledgment; entries recorded after the clear request can legitimately appear afterward. Failed clearing is reported. External direct modification of the setting is unsupported.

There is no MQTT reset control in this candidate. Removing the app removes its app settings; removing the Homey device removes that device's store through Homey's normal lifecycle. This does not claim deletion of old Homey backups or data held by Ziggo. Ziggo's own data practices are outside this app's control.

## Reporting issues

Use the repository issue tracker or community topic linked in the app metadata. Include the version, platform, Mediabox model and a short description. Never include passwords, tokens, cookies, complete device stores or identifiable account information. The developer does not require these secrets for routine reports.
