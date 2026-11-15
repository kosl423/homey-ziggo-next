# Local dependency review — November 7, 2026

This records the local v0.0.27 preparation. It is not a claim of complete security, Athom certification or live testing. No Homey installation or publication was performed.

## Production dependencies

The npm production audit reports zero known findings. The earlier `ip-address` correction to 10.7.4 remains in place. This review makes no further changes to production packages, application source, authentication, MQTT, power control or stored data handling.

## Targeted development updates

The pinned Homey CLI remains 4.6.2, with the previously selected sharp/tmp/body-parser/qs patches. Two additional overrides are scoped under Homey:

- `dockerode` uses `uuid` 11.1.1 instead of 10.0.0. Its actual call site uses the CommonJS `v4()` export to generate a session ID. An offline test exercises this call with a stubbed Docker transport and verifies the session header. A separate check verifies rejection of an undersized UUID output buffer. No Docker daemon or Homey was contacted.
- `update-notifier` uses `package-json` 7.0.0 instead of 6.5.0, resolving `got` 11.8.6 instead of 9.6.0. Tests exercise the real package-json/got/latest-version/update-notifier chain against a synthetic loopback registry: latest and exact versions, missing package/version errors and update classification. Registry credentials and external network access are disabled in these tests.

These changes remove the UUID and Got advisory chains without replacing the CLI's top-level API or forcing an ESM-only Got release. The complete audit falls from 12 package findings to six: one low and five moderate, with no high or critical findings. Package counts include propagated findings, not six independent vulnerabilities. The audit is not suppressed or filtered to conceal the remaining issues.

## Remaining findings

| Underlying issue | Affected development packages in the audit | Assessment and decision |
| --- | --- | --- |
| deepmerge returned-object prototype poisoning, GHSA-gcqx-w48m-w2h4 | deepmerge (low); also contributes to the aggregate Homey finding | Latest published release remains 4.3.1, with no patched release identified. The issue is reproducible in an isolated test object. In this CLI, the observed call sites merge local locale files in HomeyCompose. This candidate has no `.homeycompose/locales` overrides; its own EN/NL locale files were checked for dangerous prototype keys. This reduces exposure for this reviewed source, but does not repair the package or make arbitrary third-party source trees safe. Keep the advisory open pending an upstream fix or separately reviewed replacement. |
| parseuri regular-expression denial of service, GHSA-6fx8-h7jm-663j | parseuri, engine.io-client, socket.io-client, homey-api and aggregate homey (moderate) | The CLI API client still uses older Engine.IO/Socket.IO code expecting a callable CommonJS parser. parseuri 3.0.2 instead exposes named ESM exports; direct substitution fails this API contract. Older browser bundles also embed parser code. Replacing whole Socket.IO generations can change wire-protocol compatibility and requires upstream/API testing. Retain the existing parser and keep the advisory open rather than claim an unsafe override is a fix. No claim that every possible CLI input is safe or that the vulnerability is unreachable. |

These packages belong to development tooling rather than the production dependency tree. The app package includes Homey's small SDK import shim, not the Homey CLI program. Future use of CLI account, upload, remote-session or Docker features still requires its own testing; this review does not authorize or validate those operations.

## Verification and remaining release work

All 192 application tests pass. Ten additional local compatibility/security checks cover the targeted updates and remaining issues. A fresh isolated build and technical publish validation must also pass for the final source snapshot. Source and package hashes, raw audit output, the rejected parser compatibility result and local test scripts are retained under `v0.0.27-controle/beoordeling-2026-11-07/`, outside this repository.

Before public release, review the remaining development risks and any upstream fixes, perform the v0.0.27 on-device upgrade/UI/recovery/soak tests, finalize image permissions and obtain Athom's review. Do not apply `npm audit fix --force` or downgrade the CLI solely to obtain a clean audit count.

## Primary references

- [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
- [Got advisory](https://github.com/advisories/GHSA-pfrx-2q88-qq97)
- [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)
- [parseuri advisory](https://github.com/advisories/GHSA-6fx8-h7jm-663j)

Versions and installed call sites were checked against the actual npm lockfile and installed packages. The local npm registry audit remains the recorded scan result for this date.

## v0.0.28 prerelease audit — November 15, 2026

The unchanged v0.0.28 lockfile was audited again against the registry for this GitHub prerelease. Production: zero known findings. Full development tree: one low/five moderate package findings, no high/critical, from the same deepmerge and parseuri issues described above. No dependency overrides or runtime packages were changed during this publication. The earlier compatibility/risk assessment remains applicable to the pinned dependency tree. The suggested CLI downgrade is not adopted as a safe fix. This scan is a dated advisory snapshot, not a guarantee of security. The prerelease passes233 offline application tests and source/build technical validation; raw audit output is retained privately outside the repository.
