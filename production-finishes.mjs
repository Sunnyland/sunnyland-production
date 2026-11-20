import {openSync, closeSync, fstatSync, readSync, constants} from 'node:fs';
import {finishDay} from './print-planning.mjs';
import {need} from './core.mjs';

export const requirementsPath='/var/lib/sunnyland-production/smartstream/printiq-requirements.json';
const positive=n=>Number.isSafeInteger(n) && n>0;
const jobNo=/^J\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?$/;
const maxBytes=2_000_000;
const within=(stamp,now,limit)=>Number.isFinite(Date.parse(stamp)) && Date.parse(stamp)<=now && now-Date.parse(stamp)<=limit;
export function routingFacts(cache,now=Date.now()) {
  const facts={available:false,jobs:new Map(),operations:[]};
  if(cache?.schemaVersion!==1 || cache.source!=='PrintIQ.GetAcceptanceDetails' || !Array.isArray(cache.jobs) || !Array.isArray(cache.failures))return facts;
  facts.available=within(cache.generatedAt,now,900000);
  const failed=new Set(cache.failures.map(f=>f.jobNo));
  for(const job of cache.jobs){
    if(!jobNo.test(job?.jobNo) || facts.jobs.has(job.jobNo))return {available:false,jobs:new Map(),operations:[]};
    const keys=new Set(), rows=[];
    let valid=job.source===cache.source && job.refreshStatus==='ok' && positive(job.acceptanceProductKey) && positive(job.productKey) &&
      Array.isArray(job.issues) && !job.issues.length && Array.isArray(job.printingOperations) && job.printingOperations.length>0 &&
      Array.isArray(job.acceptedSections);
    for(const op of valid?job.printingOperations:[]){
      const section=job.acceptedSections.filter(s=>s.SectionKey===op.acceptedSectionKey && s.QuotedSectionKey===op.quotedSectionKey);
      if(![op.operationKey,op.acceptedSectionKey,op.quotedSectionKey,op.pressKey].every(positive) || section.length!==1 ||
         keys.has(op.operationKey) || typeof op.pressName!=='string' || !op.pressName.trim()){valid=false;break;}
      keys.add(op.operationKey);
      const id=[job.jobNo,job.acceptanceProductKey,job.productKey,op.acceptedSectionKey,op.quotedSectionKey,op.operationKey,op.pressKey].join('/');
      rows.push({id,job:job.jobNo,operationKey:String(op.operationKey),sectionKey:op.acceptedSectionKey,
        section:section[0].SectionTypeName||'Section',pressKey:op.pressKey,press:op.pressName,asOf:job.fetchedAt});
    }
    const fresh=valid && facts.available && !failed.has(job.jobNo) && within(job.fetchedAt,now,300000);
    const operations=valid?rows.map(r=>({...r,fresh})):[];
    facts.jobs.set(job.jobNo,{fresh,operations,closed:/^(complete|completed|cancelled|canceled)$/i.test(job.productStatus)});
    facts.operations.push(...operations);
  }
  for(const job of failed)if(!facts.jobs.has(job))facts.jobs.set(job,{fresh:false,operations:[]});
  return facts;
}
export function readRouting(file=requirementsPath,now=Date.now()) {
  let fd;
  try {
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st=fstatSync(fd);
    if(!st.isFile() || ![0,process.geteuid()].includes(st.uid) || ![0o600,0o640].includes(st.mode&0o777) || st.size<2 || st.size>maxBytes)return routingFacts(null);
    const bytes=Buffer.alloc(st.size);let size=0;
    while(size<bytes.length){const count=readSync(fd,bytes,size,bytes.length-size,null);if(!count)break;size+=count;}
    return routingFacts(JSON.parse(bytes.subarray(0,size).toString('utf8')),now);
  }catch{return routingFacts(null);}finally{if(fd!==undefined)closeSync(fd);}
}

// An operation key uniquely identifies an accepted Printing operation. Never match
// a local timer by its display name, a press observation or a whole-job status.
export function operationEvidence(store,facts){
  const completed=new Map(),confirmed=new Map(store.all('checkedPrintFinish').map(row=>[row.id,row]));
  const users=new Map(store.db.prepare("SELECT id,json_extract(doc,'$.name') AS name FROM records WHERE kind='user'").all().map(u=>[u.id,u.name]));
  for(const op of store.all('operation')){
    if(!op.printiqOperationKey)continue;
    const key=op.job+'/'+op.printiqOperationKey;
    completed.set(key,!completed.has(key) && op.state==='completed' && op.updatedAt?op:null);
  }
  const known=new Set(facts.operations.map(r=>r.id));
  const earlier=[...confirmed.values()].filter(r=>r.active && r.binding && !known.has(r.id)).map(r=>({...r.binding,fresh:false,earlier:true}));
  return [...facts.operations,...earlier].map(row=>{
    const local=!row.earlier && completed.get(row.job+'/'+row.operationKey),check=confirmed.get(row.id);
    const source=local?'appFinish':check?.active?'staffCheck':null;
    const actorId=local?.actor??(check?.active?check.actor:null);
    return {...row,source,at:local?.updatedAt??(source?check.at:null),by:users.get(actorId)??null, actorId,
      printedOn:check?.active?check.printedOn:null, finishedOn:local?finishDay(local.updatedAt):(check?.active?check.finishedOn:null),revision:check?.revision??0};
  });
}
export function checkFinish(store,actor,key,body,facts){
  need(['manager','operator'].includes(actor.role),'A production operator or manager must record this check.',403);
  return store.transaction(actor,key,{checkedPrintFinish:body},()=>{
    const op=operationEvidence(store,facts).find(r=>r.id===body.operation && r.job===body.job);
    need(op && (body.action==='withdraw'||op.fresh),'Refresh the exact accepted Printing operation before recording a check.',409);
    need(op.source!=='appFinish','The app already has the operator’s Finish for this operation.',409);
    need(op.revision===body.revision,'This confirmation changed. Refresh it first.',409);
    const old=store.get('checkedPrintFinish',op.id);
    const active=body.action==='confirm';
    need(active || body.action==='withdraw','Choose a valid action.');
    need(active?!old?.active:old?.active,'The confirmation has already changed.',409);
    if(!active)need(actor.role==='manager'||old.actor===actor.id,'Only its author or a manager can withdraw this check.',403);
    const at=new Date().toISOString();
    const validDay=d=>typeof d==='string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && finishDay(d)===d && d<=finishDay(at);
    const finishedOn=active?body.finishedOn:null,printedOn=active?(body.printedOn??null):null;
    if(active){
      need(validDay(finishedOn),'Choose the day the operator recorded Finish in printIQ.');
      need(printedOn===null || (validDay(printedOn) && printedOn<=finishedOn),'Choose a valid print date on or before the operator Finish.');
    }
    const record={id:op.id,job:op.job,operationKey:op.operationKey,active,binding:facts.operations.find(r=>r.id===op.id)??old.binding,actor:actor.id,at,finishedOn,printedOn,revision:op.revision+1};
    store.put('checkedPrintFinish',record);
    store.audit(actor,active?'checked_print_finish':'withdrawn_print_finish',op.id,record);
    return record;
  });
}
