import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {CANDIDATE_STATUS, VERIFIED_DFE_CONTRACTS, emptyState, projectPrintMilestones, reducePrintReceipt} from './press-events.mjs';
import {readPressSnapshot, canonicalPressJob, pressJobStatus} from '../press-status.mjs';

const {proofs} = JSON.parse(readFileSync(new URL('./historical-proofs.json', import.meta.url), 'utf8'));
const machine = {id: 'machine:smartstream'};
const jobNumber = /^J\d+(?:-\d+)?$/;
const validID = value => typeof value === 'string' && value.length > 0 && value.length <= 180 && !/[\x00-\x1f]/.test(value);
const scope = r => JSON.stringify([r.jobNo, r.acceptedProductKey, r.generationId, r.pressId]);
const held = reason => ({outcome: 'held', heldReason: reason});
const summary = result => ({...CANDIDATE_STATUS, outcome: result.outcome, heldReason: result.heldReason ?? null});

function stableHash(value) {
  const content = JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
  return createHash('sha256').update(content).digest('hex');
}

function digest(receipt) {
  // A fresh JDF fetch can regenerate XML audit IDs. Preserve the first raw hash
  // as provenance while comparing all normalized physical and identity fields.
  const provenance = {...receipt.provenance};
  const validHash = typeof provenance.rawSha256 === 'string' && /^[0-9a-f]{64}$/.test(provenance.rawSha256);
  if (validHash) delete provenance.rawSha256;
  return stableHash([validHash, {...receipt, provenance}]);
}

function atomic(store, mode, work) {
  store.db.exec(mode);
  try {
    const result = work();
    store.db.exec('COMMIT');
    return result;
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

// These dependencies belong to the service. The shipped real-source registry is empty.
// A future inventory reader must return a freshly verified exact current manifest on every call.
export function pressStatusHook(store, {currentInventory = () => null, sourceContracts = VERIFIED_DFE_CONTRACTS,
  statusFile = process.env.SUNNYLAND_PRESS_STATUS_FILE, now = () => Date.now()} = {}) {
  // Changing a counter mapping or either inventory document invalidates previous totals.
  const manifestScope = c => JSON.stringify([scope(c), c.inventoryEvidence?.acceptanceSha256,
    c.inventoryEvidence?.runManifestSha256, stableHash(sourceContracts)]);
  function state(context) {
    return store.get('pressRunState', manifestScope(context))?.state ?? emptyState();
  }

  function ingest(receipt) {
    if (!validID(receipt?.pressId) || !validID(receipt.eventId) || !validID(receipt.jobNo) || !jobNumber.test(receipt.jobNo))
      throw new Error('A normalized receipt requires an exact job number, press ID and event ID.');
    const id = JSON.stringify([receipt.pressId, receipt.eventId]);
    const fingerprint = digest(receipt);
    return atomic(store, 'BEGIN IMMEDIATE', () => {
      const first = store.get('pressEvent', id);
      if (first && first.fingerprint !== fingerprint) {
        const disputed = summary(held('CONFLICTING_REPLAYED_EVENT_ID'));
        const conflictID = JSON.stringify([id, fingerprint]);
        if (!store.get('pressEventConflict', conflictID)) {
          store.put('pressEventConflict', {id: conflictID, receipt, at: new Date().toISOString()});
          for (const variant of [first.receipt, receipt]) store.put('pressDispute', {id: scope(variant)});
          store.audit(machine, 'pressEventConflict', id, disputed);
        }
        return disputed;
      }
      const original = first?.receipt ?? receipt;
      let result;
      if (store.get('pressDispute', scope(original))) result = held('EVENT_ID_RECONCILIATION_REQUIRED');
      else if (proofs.some(p => p.canonicalMISJobNo === original.jobNo && p.queueEntryID === original.executionId))
        result = held('HISTORICAL_PROOF_ONLY');
      else {
        const context = currentInventory(original.jobNo);
        if (!context || context.jobNo !== original.jobNo) result = held('CURRENT_INVENTORY_UNVERIFIED');
        else {
          const before = state(context);
          result = reducePrintReceipt(before, context, original, {sourceContracts});
          if (result.outcome === 'duplicate') {
            return first?.result.heldReason === 'CONFLICTING_OR_REGRESSING_EXECUTION' ? first.result : summary(result);
          }
          if (result.state !== before) store.put('pressRunState', {id: manifestScope(context), state: result.state});
        }
      }
      const outcome = summary(result);
      if (!first || first.result.outcome !== outcome.outcome || first.result.heldReason !== outcome.heldReason) {
        store.put('pressEvent', {id, fingerprint, receipt: original, firstSeen: first?.firstSeen ?? new Date().toISOString(), result: outcome});
        store.audit(machine, 'pressEvent', id, outcome);
      }
      return outcome;
    });
  }

  function jobStatus(jobNo, snapshot) {
    const canonicalJob = canonicalPressJob(jobNo);
    const observations = canonicalJob ? pressJobStatus(snapshot,canonicalJob) : null;
    const historicalProofs = proofs.filter(p => p.canonicalMISJobNo === canonicalJob).map(p => ({
      id: p.queueEntryID, name: p.name, printedAt: p.physicalPrintingEndUTC,
      actualOutput:Number(p.reportedOutputQuantity),unitLabel:'reported output units'
    }));
    for (const observation of observations?.results ?? []) {
      if (observation.purpose==='proof' && observation.state==='observedPrinted'
          && observation.historical===true && !observation.currentGenerationVerified && !historicalProofs.some(p=>Date.parse(p.printedAt)===Date.parse(observation.printedAt))) {
        historicalProofs.push({id:observation.id,name:'Earlier hardcopy proof',printedAt:observation.printedAt,
          actualOutput:observation.actualOutput,unitLabel:observation.unitLabel});
      }
    }
    const base = {...CANDIDATE_STATUS, candidateOnly: true, id: jobNo, currentEvidence: 'unverified',
      hardcopyProofPrinted: null, productionPrinted: null, hardcopyProofRecords: [], sectionCompletionCandidates: [], historicalProofs, operations: [],
      sourceStatus:snapshot.sourceStatus,sourceGeneratedAt:snapshot.generatedAt,
      observedRuns:observations?.results ?? []};
    const context = currentInventory(jobNo);
    if (context?.jobNo !== jobNo || !Object.values(sourceContracts).some(p => p.verified === true && p.pressId === context.pressId)) return base;
    if (store.get('pressDispute', scope(context))) return {...base, currentEvidence: 'under_review'};
    const currentState = state(context);
    let projected;
    try { projected = projectPrintMilestones(currentState, context); }
    catch { return base; } // Invalid/incomplete inventory cannot identify current work.
    const records = projected.hardcopyProofRecords;
    const operations = context.sections.map(section => {
      const required = section.parts.filter(p => p.hardcopy_proof).length;
      const covered = records.filter(r => r.sectionKey === section.sectionKey).length;
      return {id: String(section.printingOperationKey), sectionKey: section.sectionKey,
        hardcopyProofPrinted: required ? covered === required : null,
        productionPrinted: projected.sectionCompletionCandidates.some(r => r.printingOperationKey === section.printingOperationKey)};
    });
    return {...base, currentEvidence: 'bound', acceptedProductKey: context.acceptedProductKey, generationId: context.generationId,
      hardcopyProofPrinted: operations.some(o => o.hardcopyProofPrinted !== null) ? projected.hardcopyProofPrinted : null,
      hardcopyProofRecords: records, sectionCompletionCandidates: projected.sectionCompletionCandidates,
      productionPrinted: projected.productionPrinted, coveredProductionParts: projected.coveredProductionParts,
      requiredProductionParts: projected.requiredProductionParts, operations};
  }

  // Use one SQLite read snapshot across conflict flags and run evidence.
  return {ingest, statuses: (jobs,{includeObserved=false}={}) => {
    const snapshot=readPressSnapshot(statusFile,{now:now()});
    const numbers=[...new Set([...jobs,...(includeObserved?snapshot.jobs.map(job=>job.jobNo):[])])];
    return atomic(store, 'BEGIN', () => numbers.map(jobNo=>jobStatus(jobNo,snapshot)));
  }};
}
