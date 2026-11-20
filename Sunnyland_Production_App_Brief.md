# Sunnyland Production — app build brief

Updated 18 November 2026. Requirements captured from Paul Cocks.

Status: agreed objectives and proposed implementation rules. The native iPhone app, shared inventory service and sample-approval workflow have not yet been built or installed. The existing stocktake prototype uses Scriptable and has a recurring JavaScript error. This brief carries the requirements into a native replacement.

## Purpose

Give Sunnyland staff one signed-in iPhone app for counting and issuing stock, recording physical proofs and folding samples, checking quality, tracking production and finding the approved production reference for a job. A shared server holds the authoritative balances, media, quality checks and approval history. The Mac is needed for the native iPhone build and device testing; preparation can continue on the PC.

## 1. Staff access and shared information

- Each operator, creator and rep signs in under their own identity.
- Record who counted, received, issued, returned, corrected or approved an item, with a timestamp.
- Operators can count stock, issue it to jobs, upload samples and view approved references. Reps can review samples for jobs assigned to them. Managers can resolve mappings, assignments and corrections.
- All production staff can access approved photos and videos for a job. Access requires staff sign-in; media links are not public.
- Show whether information is current from the server, cached with a last-sync time, or still waiting to upload. Never present an old cached count as a live balance.
- Initial implementation should require a server connection to confirm a stock issue or approval. Photos and videos can remain local drafts until successfully uploaded. This prevents two phones from independently confirming the same available stock.

## 2. Scan and count stock

Evaluate every decoded barcode in the captured frame. Multiple occurrences of the same exact value identify one stock code. Two or more different values cause a clear mixed-barcode error. No decoded value means retry or manual entry. Keep leading zeroes. Do not infer the number of packs from the number of visible labels.

After identifying a stock code, show:

| Information | Meaning |
| --- | --- |
| Stock code, grade, weight and dimensions | Exact catalogue identity |
| Physical sheets on hand | Counted opening stock plus subsequent receipts, cuts, issues, returns and waste |
| Sunnyland-owned sheets | Physical balance in owned lots |
| Consignment sheets | Physical balance in consignment lots |
| Ownership unknown | Existing or imported balances awaiting classification |
| Reserved and available sheets | Commitments reconciled against physical stock |
| Locations and pallet/lot IDs | Which physical stock the operator should use |
| Counted/updated time and sync status | Freshness and source of the displayed balance |
| Consignment count | Supplier-reportable unopened pallets, kept separate from physical sheets |

The same product barcode may be present on both owned and consignment stock. Ownership belongs to the pallet or lot, not just the product code. The operator selects or identifies the lot before changing its balance. Unknown ownership must not default to Sunnyland-owned or consignment.

Support wrapped packs, flagged pallets and loose sheets. Record the confirmed sheets per pack or flag interval, full units, remaining loose sheets and location. A partial stocktake is marked incomplete rather than treated as the full balance for that code. Uncounted stock is unknown, not zero.

### Flagged pallets and consignment

| Pallet state | Production physical count | Consignment pallet count |
| --- | --- | --- |
| Unopened consignment pallet | All confirmed sheets | 1 unopened pallet |
| Opened consignment pallet | Actual sheets remaining | 0 unopened pallets |
| Empty consignment pallet | 0 sheets | 0 unopened pallets |
| Sunnyland-owned pallet | Actual sheets remaining | Excluded from consignment |

Example: a flagged consignment pallet originally contains 20,000 sheets. After opening, 6,000 remain. Show 6,000 physical sheets and zero unopened consignment pallets. The zero is a reporting rule; it must not remove the remaining sheets from production availability.

Opening a pallet records its opened state and timestamp. It does not automatically change legal ownership or create a purchase/invoice. Whether supplier billing transfers ownership when opened remains to be confirmed against Sunnyland's supplier process.

## 3. Operator takes stock for a job

1. Enter or scan the job number; confirm the current active job and relevant section/component.
2. Scan the stock and identify the pallet/lot and location.
3. Show the stock requirement, current balance, ownership and proposed source. Check grade, dimensions and compatibility with the job.
4. Enter packs and pack quantity, flag intervals and sheets per interval, or a direct sheet quantity. Show the resulting sheet total before saving.
5. Confirm the quantity taken. Save one stock issue linked to job, section, operator, lot and time. Reduce the physical balance and reconcile the corresponding reservation in one transaction.
6. Display the updated balance and confirmation. A repeated tap or retried network request must return the original issue, not deduct twice.

Use eligible Sunnyland-owned stock before consignment stock. Check eligible owned cut-down alternatives before proposing consignment. Any larger-sheet alternative must have an approved compatibility match, grain direction, trimming allowance and yield. Never allocate the same source sheets twice. Unverified ownership, sizes, units or compatibility block automatic allocation.

Returns go back to their original lot/ownership where identifiable and are recorded against the job. Stock taken is deducted at issue: production completion must not deduct it again. Waste from already-issued sheets is a job usage classification, not a second warehouse deduction. Waste from stock still in the warehouse is a separate physical deduction. Corrections retain an audit trail rather than rewriting history silently.

Cuts record parent sheets consumed and child sheets produced together, preserving ownership and lineage. Job reservations and issues must be reconciled so remaining requirements are not counted twice.

## 4. Proof photos, folding samples and videos

1. The signed-in creator chooses the job and sample type, records photos or a video, and adds notes explaining what needs approval.
2. The app shows the assigned rep and uploads the files. A draft is not submitted until the server has stored and can play/view the complete media.
3. Submitting creates a numbered sample version and a pending approval request. Notify the assigned rep that the sample is available, with the job number, creator, sample type and a secure review link.
4. The rep opens the request and approves or requests changes, with a comment where changes are needed.
5. While a request remains pending, send reminders at the configured interval. Cancel future reminders when it is approved, withdrawn, superseded or returned for changes. Suppress duplicate notifications and log delivery outcomes.
6. On approval, record approver, time and the exact media version. Email the creator once and make that approved version available to everyone in production.
7. A replacement photo or video creates a new pending version. It never inherits the previous approval. Retain earlier versions and decisions; clearly flag a pending replacement beside any previous approval.

Proposed interpretation: the assigned rep approves the physical sample. This is separate from final customer artwork approval in Cockpit. If the customer must approve the sample directly, add a separate customer review step and access rules before building that part.

Reminder timing and escalation are configurable; no specific frequency has been selected yet. A missing or ambiguous rep assignment requires correction before submission. Email notifications use Sunnyland's existing mail service, with a durable queue and recorded server acceptance. Acceptance means the mail server accepted the message, not proof that the recipient read it.

## 5. App screens

| Screen | Main actions |
| --- | --- |
| Sign in / Home | Identify staff member; open stock, job or approvals |
| Scan stock | Identify stock; see balance, ownership and locations |
| Count stock | Record/recount a specific lot; packs, flags, loose sheets and opened state |
| Take / return stock | Choose job and section; confirm issue or return |
| Job | See requirements, issued stock, samples and approved references |
| Capture sample | Take photos/video, add notes and submit to rep |
| My approvals | Review pending samples; approve or request changes |
| Approved production references | Search by job; view approved versions and decision details |
| My work / Production board | Start, pause and finish operations; show location, next step and blockers |
| Quality check | Complete the relevant check, attach evidence and sign off or place on hold |
| Issues and rework | Record defects, segregate affected quantities and track the resolution |
| Packing and dispatch | Verify components, quantities, carton labels and release status |

## 6. Existing systems and delivery stages

Use the existing printIQ Switch API application for catalogue/job references and shop-wide supplier POs, lines and inventory transactions. Jobs and section demand also come from the current Switch XML/JSON intake. Confirm current status; deduplicate by job and section, and reconcile picked/reserved stock. Supplier orders are not assumed to belong to individual jobs.

Begin the inventory ledger from physically verified opening counts and dated movements in Sunnyland_Stock_List.xlsx. Import historical counts without inventing ownership or pallet detail. Reconcile before making the shared service authoritative. There must be one authoritative balance, not independent workbook and phone balances.

The stock shortage report retains Sally as the recipient. stock@sunnyland.com.au is not active. Before recommending purchases, include valid owned-first allocations, approved cuts, outstanding confirmed PO quantities, pack conversions and due dates. The previously configured daily check is paused after its source-access failure. This app brief neither resumes it nor creates another schedule.

Build in these stages (expanded with quality and tracking objectives):

1. Native scanner, named staff access, shared stock/lot records, ownership and flagged-pallet counts.
2. Job issues, returns, reservation reconciliation, approved cut transactions and scan-to-start/pause/finish tracking.
3. Sample capture/upload, rep review, creator email, reminders, approved production library, first-off checks and production holds.
4. Product-specific finishing/packing checks, rework records, handovers and management reporting.
5. Reconciled printIQ/Switch integrations and the existing stock shortage report; machine feeds only where supported and verified.

## 7. Print quality control

Add short checklists based on the actual product and operation. A flyer must not require book-binding questions. Pre-fill job specifications and previous approved references; ask the operator for the observations, measurements and exceptions that matter. Do not pre-tick checks as passed. Record the checklist version and job/artwork revision used.

| Checkpoint | Relevant checks | Recorded evidence |
| --- | --- | --- |
| Before production | Correct job/section, latest approved artwork, required sample approval, stock grade/weight/size/grain, print sides, quantities and finishing instructions | Source revision, operator and start checks |
| First printed sheet | Front/back orientation, position and registration, trim/bleed, visible defects, required spots/finishing separations and colour against the agreed physical reference | Signed first-off reference, notes and any actual instrument readings |
| During the run | Compare a new sample to the approved first-off; check for drift, marking, scratches, set-off or other applicable defects | Sample time, run count, result and evidence |
| Cutting and folding | Finished dimensions, squareness, fold direction, panel allowance, crease position and cracking; comparison with approved folding video | Measured dimensions and folded-sample photo |
| Binding and assembly | Page/signature order, pagination, orientation, covers, missing/duplicate sheets, staples/glue and the required finished quantity | Assembly check and photos where useful |
| Die cutting and special finishes | Correct die/form ID, position and orientation; crease/perforation/foil/lamination/spot finish as specified; fit or function where applicable | Die/form reference and approved first sample |
| Wide format and signage | Material, dimensions, orientation, contour cut, bleed, finishing, supplied parts and installation identifiers where applicable | Dimensions and finished-item photos |
| Variable data and mail | Correct authorised data/version, representative content/layout, numbering or barcode readability and sequence where required | Check outcome and minimally necessary evidence; avoid exposing personal data in general production photos |
| Packing and dispatch | Correct job and component, good quantity, bundles/cartons, addresses, labels, accessories and required approvals/holds | Packer, checker where required, carton counts and release record |

The actual checklist, tolerances and sampling interval are configured per product/machine/customer requirement. Do not invent a universal colour, cutting or sampling tolerance. Recheck after a relevant setup, artwork or material change and after a corrective action. A photo/video supports an approval record but does not replace calibrated colour measurement, PDF preflight/overprint checks or testing that requires a physical sample.

### First-off approval and production holds

- For operations configured to require first-off approval, record the first acceptable sample and authorised sign-off before marking the production run released.
- Keep customer artwork approval, rep sample approval, press first-off approval and final QC as separate decisions. One does not automatically grant the others.
- Allow a named second checker for selected high-risk operations or customer requirements; do not require two people for every routine step.
- Provide a prominent Hold job action with reason, affected batch/quantity, photo, location and owner responsible for resolution.
- Show the hold to downstream operators and prevent the app from releasing affected batches to the next required step or dispatch. This is an application workflow gate, not a physical machine stop.
- Distinguish an approval only needed before finishing from one needed before printing. Hold only the affected operations unless the issue affects the whole job.
- Resolve through an authorised release, rework or scrap decision with a reason and audit trail. Never clear a failed check simply because the screen was reopened.
- When artwork, stock or approved sample changes, flag dependent checks for revalidation. Preserve earlier records and clearly label superseded references.

### Defects, reprints and learning

Record defect type, discovery operation, machine, affected quantity/unit, stock lot, photos, suspected cause and confirmed disposition. Distinguish observed cause from an unverified assumption.

Keep good output, work awaiting rework, quarantined stock and confirmed scrap separate. A defect photo alone must not subtract stock. An authorised scrap or replacement issue creates the corresponding inventory event once. Rework cannot count as new good output twice. A reprint is a linked child operation/job with a reason and fresh material allocation, while the original history remains intact.

Show repeat defects and scrap/rework by process, material, machine and reason. Estimate rework cost only when actual time, stock and rate data are available; label estimates. Use trends to improve the process, without treating incomplete entries as operator fault.

## 8. Job tracking on the production floor

Scan the existing job-ticket barcode or enter the number to open the correct job and section. New labels, if later needed, are an explicit action; scanning does not print a ticket.

Provide large Start, Pause, Resume, Finish and Hold actions. Capture operator, operation, machine/work centre, time, quantity and unit. Suggested pause reasons include waiting for stock, approval, tooling, maintenance or another operation. Operators can correct a forgotten timer with a reason and an audit trail. These are production timings, not automatic payroll attendance records.

Track the route by job section and batch, with states such as Ready, Setup, Running, Paused, On hold, Completed and Awaiting next operation. Support parallel cover/text production, outsourced operations, partial quantities and split deliveries. Completing one section or one batch does not mark the whole job completed.

Display a shared production board with job number, description, rep, due date, next operation, current location, good quantity, remaining quantity and blocker. Flag overdue or at-risk work using confirmed due dates and recorded progress; show missing dates/status as unknown. Do not invent completion predictions from unavailable machine capacity data.

### Handover and location

- Record where the batch physically sits: machine, rack, shelf, drying area, finishing bench, quarantine or dispatch.
- Provide handover notes with the approved sample, special instructions and outstanding issues at the next operator's scan.
- For outsourced work, record quantity sent, supplier, due date and quantity received. Do not show it as available in-house before receipt.
- Let staff search a job and answer: where is it, what has passed QC, what remains, who is handling it and what is stopping it?

### Quantities, integration and reporting

- Keep press sheets, impressions, signatures, finished pieces and cartons as explicit units. Use verified imposition/assembly yields before converting them.
- Record input, good output, held/rework quantity and scrap per operation. Material issue remains the stock deduction event; a tracking event cannot deduct it again.
- Match imported machine events and manual entries by operation/batch identifiers. A manual finish plus an imported finish must not double the output or runtime.
- Confirm actual printIQ, Switch, Cockpit and any machine interface capabilities before promising automatic status or writeback. Begin with read-only job references and app-owned tracking; no unapproved changes to the MIS.
- Provide management views for jobs due/late, waiting approvals, held work, stock shortages, setup/run time, waste and rework. Show the timestamp and completeness of each metric.
- Combine routine notifications and stop reminders after resolution. Immediate alerts should be limited to actionable holds or urgent approval requests to the responsible staff. Notification cadence and escalation remain configurable.

## 9. Practical first-release priorities

Prioritise six additions to the already requested stock and sample functions:

1. Scan a job and see its instructions, stock and approved references.
2. Start/pause/finish the current operation with minimal taps.
3. First-off sign-off and a short product-specific checklist.
4. Hold a batch with a photo and a clear resolution owner.
5. Record good output, waste/rework and returns without duplicate stock deductions.
6. Finish with a packing/dispatch check and a visible job history.

Advanced machine telemetry, automated visual defect detection, measured colour analysis and detailed scheduling optimisation are later options, not claimed first-release capabilities. The app can capture evidence and route human decisions without implying automated inspection of every sheet.

## Design references

These primary sources inform the integration direction, not a claim that Sunnyland's installed machines already expose these features:

- CIP4, [What is (X)JDF](https://www.cip4.org/print-automation/jdf): product/process information and operational data for job/device tracking.
- CIP4, [What is an ICS](https://www.cip4.org/print-automation/ics): defined interfaces for communication and quality-control data exchange.
- Heidelberg, [Packaging printing 4.0 — increasing quality demands](https://www.heidelberg.com/global/media/global_media/company___press_lounge/press_kits_1/press_kits_2020/innovationweek_2020/press_releases_innovationweek/20201015_E_White_Paper_Packaging4-0.pdf): examples of production inspection against a PDF or approved sheet. Dedicated inspection equipment is separate from the proposed iPhone evidence workflow.

References reviewed 18 November 2026. The checkpoints and priorities above are proposed specifically for Sunnyland's app.

## Acceptance checks before production use

- Three identical barcodes are accepted as one stock identity; two different values block the scan.
- No barcode results or incomplete reads cannot silently select an arbitrary product.
- A product with both owned and consignment lots shows both balances; unknown ownership remains explicit.
- Owned sheets are selected first, including eligible approved cut options before consignment.
- An opened consignment pallet with 6,000 sheets contributes 6,000 physical sheets and zero unopened consignment pallets.
- Issuing 500 sheets from a 2,000-sheet lot leaves 1,500. Retrying the same request still leaves 1,500. Returning 100 leaves 1,600.
- Two concurrent stock issues cannot consume the same available sheets, and a matching reservation is not deducted a second time.
- Recounting a pallet replaces its balance through an auditable adjustment; it does not add a second pallet.
- New media, failed uploads and unapproved versions never appear as approved production references.
- Approval is tied to the actual media version and approver; a replacement requires a new decision.
- Approval stops reminders and queues one creator email. Delivery failures remain visible and retry without creating duplicate accepted messages.
- An unrelated staff member cannot approve another rep's request without an explicit authorised role.
- Camera scanning, photo/video playback, interrupted uploads, restart recovery, sign-in and mail acceptance are verified on the actual iPhone/server setup.
- A failed first-off blocks the affected operation's app release; an unrelated section can continue when permitted by the route.
- A held batch cannot be dispatched until an authorised release is recorded, including on a second operator's phone.
- A new artwork/sample revision cannot silently retain dependent approvals.
- Completing a cover section does not complete unfinished text sections or the whole book job.
- A press-sheet count cannot be shown as a finished-piece count without a verified conversion.
- A manual finish followed by a matching machine event does not double quantities, elapsed time or stock deductions.
- Recording a defect does not change inventory; confirmed disposition updates the right stock once.
- An operator can find the batch location, next step and current approved reference from one job scan.
