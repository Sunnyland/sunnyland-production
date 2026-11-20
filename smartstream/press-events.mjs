/** Offline app-owner hook candidate. No HTTP, storage, sender or outbox access. */
import {createHash} from 'node:crypto';

export const CANDIDATE_STATUS = Object.freeze({enabled:false,readyToSend:false,
  mappingStatus:'actual-DFE-fields-unverified',senderPresent:false});
export const VERIFIED_DFE_CONTRACTS = Object.freeze({});
const SHA = /^[a-f0-9]{64}$/;
const PURPOSES = ['hardcopy_proof','production'];
const STATUSES = ['progress','success','failed','cancelled','attention'];
class Held extends Error {}
const need=(ok,code)=>{if(!ok)throw new Held(code);};
const text=x=>typeof x==='string'&&x.length>0&&x.length<=180&&!/[\x00-\x1f]/.test(x);
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const positive=x=>integer(x)&&x>0;
const exact=(value,keys,code)=>need(value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join('|')===[...keys].sort().join('|'),code);
const canonical=value=>JSON.stringify(value,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?
  Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const copy=value=>JSON.parse(JSON.stringify(value));
function instant(value){
  need(typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value)),
    'UNZONED_OR_INVALID_TIME');
  return Date.parse(value);
}
export const emptyState=()=>({schemaVersion:1,events:{},runs:{}});
const runKey=(c,s,p,purpose,executionId)=>canonical([c.jobNo,c.acceptedProductKey,c.generationId,
  c.pressId,s.sectionKey,p.partId,purpose,executionId]);

function inventory(c){
  exact(c,['schemaVersion','jobNo','acceptedProductKey','generationId','pressId','generationStartedAt',
    'asOf','inventoryEvidence','sections'],'INVALID_CONTEXT');
  need(c.schemaVersion===1&&/^J\d+(?:-\d+)?$/.test(c.jobNo)&&positive(c.acceptedProductKey)&&
    SHA.test(c.generationId)&&text(c.pressId),'INVALID_ACCEPTED_PRODUCT_IDENTITY');
  need(instant(c.generationStartedAt)<=instant(c.asOf),'FUTURE_GENERATION');
  exact(c.inventoryEvidence,['kind','complete','current','acceptanceSha256','runManifestSha256'],
    'INVENTORY_EVIDENCE_MISSING');
  const e=c.inventoryEvidence;
  need(e.kind==='accepted-product-and-bound-run-manifest'&&e.complete===true&&e.current===true&&
    SHA.test(e.acceptanceSha256)&&SHA.test(e.runManifestSha256),'CURRENT_COMPLETE_INVENTORY_UNVERIFIED');
  need(Array.isArray(c.sections)&&c.sections.length>0,'REQUIRED_SECTIONS_MISSING');
  const sections=new Set(),operations=new Set();
  for(const s of c.sections){
    exact(s,['sectionKey','printingOperationKey','parts'],'INVALID_SECTION_INVENTORY');
    need(positive(s.sectionKey)&&positive(s.printingOperationKey)&&!sections.has(s.sectionKey)&&
      !operations.has(s.printingOperationKey),'AMBIGUOUS_SECTION_OR_PRINTING_OPERATION');
    sections.add(s.sectionKey);operations.add(s.printingOperationKey);
    need(Array.isArray(s.parts)&&s.parts.length>0,'REQUIRED_PARTS_MISSING');
    const ids=new Set();
    for(const p of s.parts){
      exact(p,['partId','unit','production','hardcopy_proof'],'INVALID_PART_INVENTORY');
      need(text(p.partId)&&text(p.unit)&&!ids.has(p.partId),'AMBIGUOUS_PART_IDENTITY');ids.add(p.partId);
      for(const purpose of PURPOSES){
        const run=p[purpose];
        if(run===null&&purpose==='hardcopy_proof')continue;
        exact(run,['executionId','requiredGoodQuantity'],'RUN_BINDING_MISSING');
        need(text(run.executionId)&&positive(run.requiredGoodQuantity),'RUN_BINDING_OR_QUANTITY_INVALID');
      }
      need(!p.hardcopy_proof||p.hardcopy_proof.executionId!==p.production.executionId,
        'PROOF_AND_PRODUCTION_EXECUTIONS_NOT_DISTINCT');
    }
  }
  return c;
}

function receipt(c,r,contracts){
  exact(r,['schemaVersion','eventId','executionId','jobNo','acceptedProductKey','generationId',
    'pressId','sectionKey','partId','purpose','purposeMarker','phase','status','final','sequence',
    'observedAt','quantity','provenance'],'INVALID_RECEIPT');
  exact(r.provenance,['contractId','rawSha256','physicalMarker'],'PROVENANCE_MISSING');
  need(text(r.provenance.contractId)&&SHA.test(r.provenance.rawSha256),'PROVENANCE_MISSING');
  const profile=contracts[r.provenance.contractId];
  need(profile?.verified===true,'DFE_SOURCE_MAPPING_UNVERIFIED');
  need(text(profile.physicalPhase)&&text(profile.physicalMarker)&&
    text(profile.purposeMarkers?.hardcopy_proof)&&text(profile.purposeMarkers?.production)&&
    profile.purposeMarkers.hardcopy_proof!==profile.purposeMarkers.production,
    'SOURCE_CONTRACT_MARKERS_INCOMPLETE');
  need(r.schemaVersion===1&&text(r.eventId)&&text(r.executionId)&&integer(r.sequence),
    'EVENT_OR_EXECUTION_ID_MISSING');
  need(r.jobNo===c.jobNo&&r.acceptedProductKey===c.acceptedProductKey,'CROSS_PRODUCT_RECEIPT');
  need(r.generationId===c.generationId,'OLD_OR_DIFFERENT_GENERATION');
  need(r.pressId===c.pressId&&r.pressId===profile.pressId,'CROSS_PRESS_RECEIPT');
  need(text(r.phase)&&text(r.provenance.physicalMarker)&&
    r.phase===profile.physicalPhase&&r.provenance.physicalMarker===profile.physicalMarker,
    'VERIFIED_PHYSICAL_OUTPUT_PHASE_MISSING');
  need(PURPOSES.includes(r.purpose)&&text(r.purposeMarker)&&
    r.purposeMarker===profile.purposeMarkers?.[r.purpose],'EXPLICIT_JOB_PURPOSE_MISSING');
  need(STATUSES.includes(r.status)&&typeof r.final==='boolean'&&
    (r.status!=='success'||r.final===true),'FINAL_SUCCESS_MARKER_MISSING');
  need(instant(r.observedAt)>=instant(c.generationStartedAt)&&instant(r.observedAt)<=instant(c.asOf),
    'STALE_OR_FUTURE_RECEIPT');
  const section=c.sections.find(s=>s.sectionKey===r.sectionKey);
  need(section,'UNKNOWN_SECTION');
  const part=section.parts.find(p=>p.partId===r.partId);
  need(part&&part[r.purpose],'UNKNOWN_PART_OR_PURPOSE');
  need(part[r.purpose].executionId===r.executionId,'UNBOUND_OR_OLD_EXECUTION');
  exact(r.quantity,['goodCumulative','sourceUnit','mappingId'],'ACTUAL_GOOD_QUANTITY_MISSING');
  const mapping=profile.quantityMappings?.[r.quantity.mappingId];
  need(text(r.quantity.mappingId)&&text(r.quantity.sourceUnit)&&mapping?.verified===true&&
    text(mapping.sourceUnit)&&text(mapping.targetUnit)&&mapping.sourceUnit===r.quantity.sourceUnit&&
    mapping.targetUnit===part.unit&&positive(mapping.numerator)&&positive(mapping.denominator),
    'QUANTITY_UNIT_MAPPING_UNVERIFIED');
  need(integer(r.quantity.goodCumulative),'ACTUAL_GOOD_QUANTITY_MISSING');
  const converted=r.quantity.goodCumulative*mapping.numerator;
  need(Number.isSafeInteger(converted)&&converted%mapping.denominator===0,'UNMAPPED_FRACTIONAL_QUANTITY');
  return {section,part,good:converted/mapping.denominator,
    key:runKey(c,section,part,r.purpose,r.executionId)};
}

function complete(run,required){
  return Boolean(run&&!run.blocked&&run.status==='success'&&run.final===true&&run.good>=required);
}
export function projectPrintMilestones(state,context){
  const c=inventory(context),proofRecords=[],sectionCandidates=[];
  let proofRequired=0,proofDone=0,productionRequired=0,productionDone=0;
  for(const s of c.sections){
    let sectionDone=0;
    for(const p of s.parts){
      productionRequired++;
      const prod=state.runs[runKey(c,s,p,'production',p.production.executionId)];
      if(complete(prod,p.production.requiredGoodQuantity)){productionDone++;sectionDone++;}
      if(p.hardcopy_proof){
        proofRequired++;
        const proof=state.runs[runKey(c,s,p,'hardcopy_proof',p.hardcopy_proof.executionId)];
        if(complete(proof,p.hardcopy_proof.requiredGoodQuantity)){
          proofDone++;
          proofRecords.push({kind:'hardcopy_proof_printed',jobNo:c.jobNo,acceptedProductKey:c.acceptedProductKey,
            generationId:c.generationId,sectionKey:s.sectionKey,partId:p.partId,
            executionId:p.hardcopy_proof.executionId,printedAt:proof.observedAt,
            actualGoodQuantity:proof.good,unit:p.unit,sourceEventId:proof.eventId,
            approvalChanged:false,operationTimerChanged:false,qualityCheckCreated:false,candidateOnly:true});
        }
      }
    }
    if(sectionDone===s.parts.length)sectionCandidates.push({kind:'printing_operation_completion_candidate',
      jobNo:c.jobNo,acceptedProductKey:c.acceptedProductKey,generationId:c.generationId,
      sectionKey:s.sectionKey,printingOperationKey:s.printingOperationKey,
      requiredPartIds:s.parts.map(p=>p.partId),candidateOnly:true,readyToSend:false});
  }
  return {...CANDIDATE_STATUS,hardcopyProofPrinted:proofRequired>0&&proofDone===proofRequired,
    hardcopyProofRecords:proofRecords,productionPrinted:productionDone===productionRequired,
    coveredProductionParts:productionDone,requiredProductionParts:productionRequired,
    sectionCompletionCandidates:sectionCandidates};
}

export function reducePrintReceipt(state,context,event,{sourceContracts=VERIFIED_DFE_CONTRACTS}={}){
  const previous=state??emptyState();
  try{
    const c=inventory(context);
    need(previous.schemaVersion===1&&previous.events&&previous.runs,'INVALID_LOCAL_STATE');
    const binding=receipt(c,event,sourceContracts);
    const id=canonical([event.pressId,event.eventId]),fingerprint=hash(event);
    if(previous.events[id]){
      need(previous.events[id]===fingerprint,'CONFLICTING_REPLAYED_EVENT_ID');
      return {...CANDIDATE_STATUS,outcome:'duplicate',state:previous,projection:projectPrintMilestones(previous,c)};
    }
    const next=copy(previous),old=next.runs[binding.key];
    next.events[id]=fingerprint;
    if(old&&event.sequence<old.sequence)
      return {...CANDIDATE_STATUS,outcome:'stale_sequence',state:next,projection:projectPrintMilestones(next,c)};
    if(old&&(event.sequence===old.sequence||binding.good<old.good||
      (old.status==='success'&&event.status==='progress'))){
      next.runs[binding.key]={...old,blocked:true};
      return {...CANDIDATE_STATUS,outcome:'held',heldReason:'CONFLICTING_OR_REGRESSING_EXECUTION',
        state:next,projection:projectPrintMilestones(next,c)};
    }
    next.runs[binding.key]={good:binding.good,status:event.status,final:event.final,
      sequence:event.sequence,observedAt:event.observedAt,eventId:event.eventId,
      rawSha256:event.provenance.rawSha256,blocked:old?.blocked??false};
    return {...CANDIDATE_STATUS,outcome:'accepted',state:next,projection:projectPrintMilestones(next,c)};
  }catch(error){
    if(!(error instanceof Held))throw error;
    return {...CANDIDATE_STATUS,outcome:'held',heldReason:error.message,state:previous,projection:null};
  }
}
