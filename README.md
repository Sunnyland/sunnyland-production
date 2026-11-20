# Sunnyland Production — pilot 0.1

Prepared for Sunnyland Press, 18 November 2026 (Melbourne).

This package contains a native iPhone/iPad app project and a runnable shared service. It is an initial pilot, **not a live deployment or a signed iPhone installation**. The service has been tested on Windows with Node 24.22.3. Paul has now reported reaching the staff sign-in screen in the Mac's iPhone simulator. Camera tests remain to be performed on a physical iPhone. No live printIQ updates or emails were sent by this build.

## Included

| Area | Pilot behaviour |
| --- | --- |
| Sign-in | Individual staff accounts, operator / rep / manager roles, hashed passwords and revocable 12-hour sessions. No default credentials. |
| Camera | A captured frame is passed to Apple's Vision barcode detector. Repeated identical decoded values become one identity; differing values reject the scan. Leading zeros stay intact. Detection cannot guarantee decoding every damaged, hidden or distant label. Label count never becomes pack count. |
| Catalogue | 1,862 Sunnyland catalogue identities from the existing export. These are not live inventory balances or confirmed pack conversions. |
| Physical counts | Per-pallet/lot opening counts and recounts, sheet balances, ownership, locations and audit trail. An item with no recorded lots is unknown. Recorded totals do not prove every storage location has been counted. |
| Consignment | Owned lots are picked before consignment. Opening a flagged consignment pallet makes it zero unopened pallets for the supplier count, while its remaining physical sheets stay available. Ownership is unchanged. |
| Taking stock | Job and section, approved stock barcode, whole-sheet quantity, owned-first lot plan, confirmation, reservation reconciliation and single deduction. Different operators cannot overspend a lot. |
| Returns / waste | Return to the original lot. Waste from an issue is classified without a second deduction and cannot later be returned as usable stock. |
| Receipts / cuts | Receive a new delivery with confirmed units and unique delivery-line reference. Record an approved cut as one parent-to-child transfer with ownership retained. Managers approve size, grade identity, grain, edge trim and yield through the administrative API. |
| Job activity | Start, pause, resume and finish a section operation; machine/location, elapsed seconds, explicit quantity unit, good and waste output. Finishing does not deduct paper again or complete the whole job. |
| Quality | Pass/fail observations. Failure creates a section hold. Only a manager releases it with a reason. The most recent QC result must pass before completion. |
| Samples | Camera photos/videos, private uploads, assigned rep review, exact-version decisions, replacement versions and approved media visible to production. Older approvals are retired after a replacement is approved. |
| Notifications | Rep-ready messages, configurable pending reminders and creator decision messages. Durable outbox, accepted SMTP response and uncertain delivery tracking. Requires configuration and a worker invocation. |
| printIQ feedback | Job lookup and activity-note adapter using Sunnyland's documented OData Notes endpoint. Unique markers and readback prevent blind duplicate posting. Direct inventory/status writes are not enabled. |
| Restart recovery | The iPhone retains one unfinished action locally. Signing into the same account/server or using Account → Refresh / recover resubmits its original ID, so a completed deduction is replayed rather than repeated. This still needs device testing. |

## Deliberate pilot limits / remaining work

- **The shared workbook has not been migrated into this new ledger.** The existing `\\PPMS\PTTransfer\Sunnyland-Stock\Sunnyland_Stock_List.xlsx` remains the working source until a deliberate cutover. Do not operate two independent live stock ledgers. Opening balances, dated movements, existing picks and reservations must be reconciled at cutover; no balance from printIQ's historical export is assumed.
- Switch intake XML/JSON and shop-wide purchase orders are not yet continuously imported. Pilot jobs are explicitly entered/verified or imported using the administrative action format. Section and stock mappings require validation against the actual job payload. No cancelled job is inferred active just because its file remains in intake.
- The daily consolidated purchasing report, outstanding PO reconciliation, automatic demand aggregation and supplier pack/due-date mapping remain separate integration work. This build sends **no stock-order report**, orders nothing and installs no schedule. Sally remains the intended stock-report recipient; `stock@sunnyland.com.au` is not in use.
- The cut calculator handles an approved rectangular grid, including a 90-degree rotation and grain check. It does not optimise mixed layouts or prove press suitability. A manager must verify the full grade identity (weight, coating, colour and certification) and the relevant press/finishing requirements. An approved owned parent option blocks consignment picking until that cut is performed or the rule is corrected.
- First-off QC currently records observations, rather than enforcing product-specific checklist templates. Batch labels, multi-stage routing, dispatch packing checks and external machine events are not implemented. Holds apply inside this app, not directly to machines or printIQ.
- Quality checks are not yet bound automatically to artwork revisions or sample dependencies. Before a changed approved sample/artwork is used, a manager must hold the affected work and require a fresh check. Do not treat the pilot as an automatic revision-release interlock.
- Media requires an online upload; offline media drafts, resumable uploads, durable background uploads, push notifications, single sign-on and automated retention are not included. Videos are limited to two minutes and uploads to 100 MB. Server access is required to view media.
- No production staff passwords, API tokens, mail passwords or real opening balances are in this package. Credentials live only on the configured server, never in the iPhone app.

## Run the shared service

For installation on the verified Debian 13 x86_64 PrintCRM server at `192.168.0.35`, see `deploy/PRINTCRM_DEPLOYMENT.md`. The included installer verifies a dedicated Node 24.22.3 runtime, source and private snapshot, tests the app, creates its own service, and checks health, authentication, restart and preserved account/ledger data before enabling startup. It has not yet been run on PrintCRM. The source package never includes the live database or migration snapshot.

Requirements: Node.js 24 and Python 3. Standard libraries only; `npm install` is not required.

The first manager can alternatively be prepared with `node provision.mjs prepare EMAIL NAME`. This creates a **disabled** manager awaiting private password entry, and never supplies a usable default password. Run `python3 activate_manager.py --email EMAIL` on the server console to choose the password; it is not echoed or passed in command arguments. The Windows `Set-Manager-Password.ps1` form provides the same one-time activation. It will not reset an existing active account. `Start-Manager-Setup.ps1` starts the local pilot service and opens that form; it does not install a Windows service, a schedule, a firewall rule or an HTTPS route. The package contains no live account database or password.

1. Extract this folder onto the intended server. Store its `data` directory on a local disk, **not an SMB share**. SQLite WAL is for a single host with multiple workers/processes, not separate database copies.
2. Create the first manager with `python3 setup_staff.py` (Windows: `python setup_staff.py`). It prompts for the password without putting it in shell history. The first account is a manager. Repeat for operators and reps. The script finds `node`; set `NODE_BINARY` if necessary.
3. Run `node server.mjs`. By default it listens only on `127.0.0.1:5180`. `http://127.0.0.1:5180/health` is a status check.
4. For phones, provision the selected internal **HTTPS** address through Sunnyland's existing reverse proxy with a certificate trusted by the phones. The iPhone app rejects plain HTTP. A phone cannot use the PC's loopback address. DNS, proxy route and certificate are not provisioned by this package. Keep the service on the LAN/VPN and restrict the service account's data directory.
5. Back up the database and media together. With the service and worker stopped, copy the complete data directory; for an online database backup use SQLite's backup facilities. Test restoration before relying on it for live stock.

`SUNNYLAND_DATA` selects the shared data directory. `HOST` and `PORT` select binding; leave the default loopback when the proxy runs on the same server. Do not expose an unencrypted listener to phones or the Internet.

`SUNNYLAND_ALLOWED_PEERS` optionally restricts the actual TCP peer to an explicit comma-separated IP list. The PrintCRM service enables this for HAProxy and local health checks. Forwarded headers cannot bypass it; an explicitly empty or invalid list fails startup. The default development service remains bound to loopback.

## Open on the Mac / install on iPhone

1. Open `ios/SunnylandProduction.xcodeproj` in Xcode (iOS 17 or later deployment target).
2. Select the SunnylandProduction target, then Signing & Capabilities. Choose your Apple development team and a valid bundle identifier.
3. Connect the iPhone, select it as the run destination and build/run. Complete Apple's device trust / Developer Mode steps if prompted. A simulator can exercise forms, but a physical phone is required for camera testing.
4. Enter the provisioned HTTPS service address with **no trailing slash**, and sign in with the staff account created above.
5. Validate scanning, stock balances, interrupted requests, sign-out, media capture/playback and approval on at least two staff accounts before live use.

This is an Xcode source project, not an IPA, App Store release or TestFlight build. No Apple account or signing team was available on the connected Windows environment.

## printIQ configuration

Observed in Sunnyland's tenant Swagger UI on 18 November 2026:

- `GET /api/v1/odata/Jobs`, including `Id`, `JobNo`, `ProductionStatusId`, `CompletedDate` and `AccountManagerId`.
- `GET /api/v1/odata/Notes` and `POST /api/v1/odata/Notes`, including `NoteValue`, `NoteDate`, `CreatedUserId`, `NoteTypeId`, `JobId` and `Active`.
- Documentation: https://sunnyland.printiq.com/swagger/ui/index

Endpoint documentation is **not** verification of the existing Switch API application's write privileges or required tenant values. Configure the existing authorized credential on the server using:

```
PRINTIQ_TOKEN=<existing Switch API credential>
PRINTIQ_NOTE_TYPE=<verified numeric note type>
PRINTIQ_NOTE_USER=<verified integration user GUID>
PRINTIQ_NOTES_ENABLED=true
PRINTIQ_ACTIVE_STATUSES=<verified comma-separated active status IDs>
```

Keep these in the service's protected environment or secret file, outside the project/source package. Node can read a protected file using `node --env-file=/path/to/private.env server.mjs` and the same option for `worker.mjs`. Never commit it.

When `PRINTIQ_ACTIVE_STATUSES` is configured, a fresh job lookup precedes issue/reserve/start/hold/sample actions. Without it, the manager must explicitly verify current job activity; local verification expires after 24 hours. It is a pilot fallback, not an automatic production-status feed.

First validate a real, identified pilot event and its resulting note with the existing API application's permissions. Stock activity notes include quantities, lots, job/section and staff audit context. They do **not** deduct printIQ stock, modify POs, approve customer proofs or set printIQ job status. Direct transaction/status feedback requires confirmed transaction types, units, locations, operation IDs and reconciliation with existing Switch events.

## Mail and worker

Use Sunnyland's existing mail service. Set the following server environment values only after the actual settings and sending account are verified:

```
SMTP_ENABLED=true
SMTP_HOST=<existing mail host>
SMTP_PORT=587
SMTP_TLS=starttls
SMTP_FROM=<existing authorized sender>
SMTP_USERNAME=<existing account if required>
SMTP_PASSWORD=<existing password if required>
REMINDER_HOURS=<chosen interval, at least 1 hour>
```

Implicit TLS is available with `SMTP_TLS=tls` and the service's confirmed port. Python is selected with `PYTHON` (default `python3`; set `PYTHON=python` on Windows if needed). No reminder interval is silently chosen.

Run `node worker.mjs` to process one batch. It also adds due pending-sample reminders when an interval is configured. Integrate this invocation into the **existing** approved Switch timer/service after configuration. It does not install or activate another schedule.

Manager Account → Feedback & mail status displays outbox states and receipts. `accepted` means the SMTP server returned success after message DATA; it does not prove the recipient read it or that it escaped a downstream filter. A timeout after DATA is `uncertain`, not automatically resent. An old in-flight event becomes uncertain after ten minutes.

For printIQ uncertainty, `node worker.mjs --reconcile` looks for the unique event marker and only records acceptance when the matching note is found; it does not POST again. An uncertain email needs reconciliation with the mail service's log using its deterministic Message-ID. Accepted/uncertain events cannot be requeued by the provided administrator command. Blocked or explicitly rejected events can be requeued after the underlying problem is corrected.

## Administrative actions / imports

Set `SUNNYLAND_ADMIN_EMAIL` to an existing manager. These commands require trusted server filesystem access:

- `node admin.mjs action input.json` applies one audited action with an optional stable `requestId`.
- `node admin.mjs refresh-job J123456` verifies a known job against printIQ once the status mapping is configured.
- `node admin.mjs outbox` lists delivery states and receipts.
- `node admin.mjs requeue EVENT_ID` only requeues blocked/rejected events.
- `node admin.mjs export new-export.json` creates an audit/stock export; it does not overwrite a file or edit the shared workbook.

An input file is `{ "requestId": "unique-source-event-id", "type": "job", "data": { ... } }`. Every action uses the same transaction/idempotency logic as the phone. A job action carries `id`, `name`, an existing rep user ID, explicit `active`, and `sections: [{id,name,stocks:[inventoryCode]}]`. Do not collapse multiple sections into one when importing.

Other manager actions: `specs` (`stock,w,h,grain,gradeKey`), `cutrule` (`source,target,trim,gap,rotated,reason`), `alias` (`code,stock`). Grain is `width` or `height` relative to the supplied dimensions. Replacing specifications invalidates prior approved cuts. `reserve` takes `job,section,lot,sheets`; zero releases a reservation even if the job is no longer active.

Normal phone actions are `count`, `receipt`, `cut`, `issue`, `return`, `waste`, `hold`, `release`, `operation`, `qc`, `sample`, `decision`. The tests show complete representative payloads. Inventory and audit exports exclude password hashes and sessions.

## Verification performed

- 23 Node tests passed: inventory rules, reservations, retries, JSON key-order replay, cuts and grain/trim rejection, receipts, waste/returns, QC holds, sample version permissions, HTTP authentication and private-media validation, mocked printIQ note readback and timeout handling, concurrent worker claims, first-manager activation and backend peer restrictions.
- 3 Python mail-transport tests passed: SMTP acceptance receipt, ambiguous timeout and disabled configuration. These use a fake SMTP transport and do not send mail.
- 5 Python migration checks cover live WAL/account/media preservation, rejected overwrites and unsafe paths, source/snapshot tampering and installed account/ledger comparison. The Linux service unit and full installation still require validation on PrintCRM.
- All service JavaScript files passed Node syntax checks.
- **Not verified:** Xcode compilation, iPhone camera behaviour, real network/TLS route, workbook migration, Switch intake mapping, tenant write permissions, real note creation or Sunnyland SMTP acceptance.

The broader app objectives remain in `Sunnyland_Production_App_Brief.md`; this README distinguishes the initial implementation from those future requirements.
