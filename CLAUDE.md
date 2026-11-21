# Sunnyland Production: notes for Claude Code

Sunnyland Press, Mildura VIC (Australia/Melbourne time). Owner: Paul Cocks.

## What's where
- **This repo** (`~/Development/sunnyland-production`): the Node 24 production service (`server.mjs`, SQLite via `node:sqlite`)
  and its Python helpers in `deploy/`. Tests: `npm test` (Node) and `cd test && python3 -m unittest discover -p "test_*.py"`.
- **iOS app** (SwiftUI): `~/Documents/Codex/2026-11-18/new-chat-2/outputs/SunnylandProduction/ios/SunnylandProduction/`.
  Built and run from Xcode by Paul.
- **Installers** for the server: `~/Documents/Codex/2026-11-18/new-chat-2/outputs/SunnylandProduction/PrintCRM/*-deploy.txt`.
- **PrintCRM server**: Debian, `192.168.0.35` (printcrm.sunnyland.com.au). `ssh slp@192.168.0.35` works by key.
  `slp` has no sudo; root is `su -` and only Paul does that.
  - App: `/opt/sunnyland-production/app`, Node at `/opt/sunnyland-production/node/bin/node`, unit `sunnyland-production`, port 5180.
  - Data (never touch): `/var/lib/sunnyland-production`. Secrets (never print): `/etc/sunnyland-production`.
  - Python workers: `/opt/sunnyland-indigo-hourly` (hourly scan, 10-min watch, 10-min printed check).
  - printIQ requirements reader: `/opt/sunnyland-printiq-requirements` (`requirements_cache.AcceptanceReader`).
- **Other systems** (LAN): HP Production Pro / SmartStream Production Center `http://192.168.0.12:8080`
  (press tickets: `/prodflow/jdf/returnJDFTicket?QueueEntryID=…`); Prinect Cockpit on PPMS (`//PPMS/PTConfig` journal,
  `//PPMS/PTJobs/Jobs/<day>/<job>/RendererReports/*/D7_<queue ID>_in.jdf` imposition); printIQ `https://sunnyland.printiq.com`
  (OData read-only; SOAP `ProductionIntegration.asmx RunTimingEvent` to finish operations).

## Rules (agreed with Paul, keep them)
1. **Never change the live server directly.** Build an installer (`bash <<'NAME' … NAME` with a gzip+base64 patch, sha256 check,
   staged copy + full test run, `backup_state.py`, rollback trap, health check: `/health` 200 and `/api/state` 401).
   Copy it with `scp … slp@192.168.0.35:/tmp/`; Paul runs `bash /tmp/<file>` as root. Read-only checks over `ssh slp@…` are fine.
2. **Never print or copy secrets.** Show config keys as "(set)" / "(empty)" only. Never enter passwords; Paul signs in himself.
3. **printIQ writes**: dry run first. A RunTimingEvent adds a time entry, so it is **never sent twice**; an unclear answer is held
   for a manager, never retried. Finishes stay pending unless `PRINTIQ_FINISH_ENABLED=true`.
4. **Don't probe printIQ endpoints in bulk** (blocked as unauthorised access; don't work around it). Use documented calls.
5. Tests must never read live files under `/var/lib/sunnyland-production` (pass stub readers).
6. Job numbers: prepress often omits the J (`064238` = `J064238`); normalise with `printIQJobKey` / `directory_key`.
7. Don't mirror the iPhone in Device Hub while testing the camera (it blacks out the scanner).

## Indigo agent: rules from production
- Plan by due date, more finishing first; group same paper, then same finishing. Indigo press key 64 ("HP Indigo 7900").
- Not approved in Cockpit: remind the rep (printIQ account manager) at one working day of slack; escalate when the date can't be met.
  Approved but not in the Indigo queue after 30 min: alert prepress list + production managers (+ push).
- **Printed check** (`deploy/indigo_printed.py` → `indigo-printed.mjs`): sheets = paper count in the press ticket (NOT the
  ComponentLink counter); sheets needed = printIQ quantity ÷ number-up from the Cockpit imposition; ≤5 sheets while the job needs
  more = proof; production batches add up; overs are normal. Colour separations ≈ sheets × sides is a cross-check.
  Only an Indigo section is finished automatically, and only when printIQ, Cockpit and the press agree; anything else goes to
  managers to confirm in the app (printed + choose section / proof / not this job). Note in printIQ with the sheets, then finish
  the Printing operation as "Paul". When one section is finished and another isn't (Indigo/Ryobi), email production.
- Cockpit asks for 1 copy; operators set the real run in SmartStream. The board must never change SmartStream.

## State on 21 Nov 2026
- Installed on PrintCRM: state sync, Indigo planner, **Indigo agent alerts** (10-min watch).
- **Printed check: NOT installed yet.** Latest installer: `PrintCRM/Indigo-Printed-Check-deploy.txt` (patch 0b9b6dc → 2323efb).
  The first attempt rolled back on a TypeError in a real job (now caught per job/entry, and failures name the line).
  After install, verify: `journalctl -u sunnyland-indigo-printed.service -n 5`, and
  `python3 -B /opt/sunnyland-indigo-hourly/indigo_printed.py --check 82f36c7615b14a0f9cadc4b3be1de4af`
  (J064238: 870 sheets on 113gsm Sovereign Silk, 2-up, 850 needed, printIQ routes it to the Ryobi W/T → needs confirming).
- iOS: "Needs confirming" screen added to `PrintPlanning.swift` (IndigoPrintedSections, PrintedConfirmView): **not yet compiled**.

## Next (agreed)
1. **Production board** for a Raspberry Pi screen at the press (Debian, Chromium kiosk; IP not known yet) + the same statuses in
   the app. Read-only. Colours: grey Not approved · amber Approved, not imposed · yellow Imposed, not on the press ·
   blue On the press (queued) · bright blue Printing now · teal Part printed (x of y) · green Printed → Done today ·
   purple tag Needs stock · orange outline Needs confirming. Auto-completes from the printed check.
2. **Live replanning**: re-sort every minute (printing/part-printed runs stay put), Rush = print today, manager moves win,
   **rollover at 5:30pm** of unprinted runs to the top of the next working day.
3. **Part printed → printIQ in progress**: RunTimingEvent with Finish=false once (no time), finish when complete.
4. **Stock**: equivalent stocks learned and approved by a manager (e.g. Ball & Doggett Sovereign Silk ≈ Spicers Pacesetter Silk);
   sizes either orientation; cut-down yields (650×455 → 2 SRA3, 650×910 → 4); grain check for folded jobs; follow existing
   cut rules. Short stock for today: email dispatch@sunnyland.com.au, answer needed by **11am**; keep watching stock scans;
   "Arriving on <date>" moves the run.
