// Read-only projection of the server-owned collector snapshot. No event sender.
import {constants, openSync, fstatSync, readSync, closeSync} from 'node:fs';
import {isAbsolute} from 'node:path';

const MAX_BYTES=2*1024*1024, MAX_RESULTS=10000;
const jobPattern=/^(?:J)?([0-9]{1,12}(?:[A-Za-z])?(?:-[0-9]{1,4}[A-Za-z]?)?)$/;
const isoPattern=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const allowed=(value,list)=>list.includes(value);
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const bool=value=>typeof value==='boolean';
const timestamp=value=>typeof value==='string' && isoPattern.test(value) && Number.isFinite(Date.parse(value));
const quantity=value=>value===null || (typeof value==='number' && Number.isFinite(value) && value>=0 && value<=1e12);
const reject=()=>{throw new Error('Invalid press snapshot');};

export function canonicalPressJob(value) {
  if(typeof value!=='string')return null;
  const match=jobPattern.exec(value);
  return match ? 'J'+match[1] : null;
}

function publicResult(row) {
  const classification=row?.quantityClassification ?? 'unverified';
  const required=row?.requiredOutput ?? null;
  const mapped=row?.quantityUnitMappingVerified ?? false;
  if(!object(row) || typeof row.id!=='string' || !/^[a-f0-9]{64}$/.test(row.id)
      || !allowed(row.purpose,['proof','production','unknown'])
      || !allowed(row.state,['observedPrinted','inProgress','unmatched'])
      || !(row.printedAt===null || timestamp(row.printedAt))
      || !quantity(row.actualOutput) || !quantity(row.targetOutput)
      || typeof row.unitLabel!=='string' || row.unitLabel.length<1 || row.unitLabel.length>48
      || !/^[A-Za-z][A-Za-z0-9 /()-]*$/.test(row.unitLabel)
      || !bool(row.currentGenerationVerified) || !bool(row.coverageVerified)
      || !(row.historical===undefined || bool(row.historical))
      || !allowed(row.nativePrintingStatus,['pending','completed','review'])
      || !allowed(classification,['fullRequired','proof','partial','unverified'])
      || !quantity(required) || !bool(mapped))reject();
  if(row.state==='observedPrinted' && (row.printedAt===null || row.actualOutput===null || row.actualOutput<=0))reject();
  if(row.state!=='observedPrinted' && row.printedAt!==null)reject();
  if(row.coverageVerified && !row.currentGenerationVerified)reject();
  if(row.historical===true && (row.purpose!=='proof' || row.currentGenerationVerified || row.coverageVerified))reject();
  if(mapped && !(required>0))reject();
  if(!mapped && (classification!=='unverified' || required!==null))reject();
  if(mapped && row.state==='observedPrinted' && classification==='unverified')reject();
  if(classification==='fullRequired' && !(mapped && row.state==='observedPrinted' && row.purpose==='production' && row.actualOutput>=required))reject();
  if(classification==='proof' && !(mapped && row.state==='observedPrinted' && row.purpose==='proof' && [1,2].includes(row.actualOutput) && row.actualOutput<required))reject();
  if(classification==='partial' && !(mapped && row.state==='observedPrinted' && row.purpose==='production' && row.actualOutput>0 && row.actualOutput<required && ![1,2].includes(row.actualOutput)))reject();
  if(row.nativePrintingStatus==='completed' && !(row.purpose==='production' && row.state==='observedPrinted'
      && row.currentGenerationVerified && row.coverageVerified && classification==='fullRequired'))reject();
  // Explicit allowlist: never expose queue/JDF/operation IDs, paths, URLs or raw source data.
  return {id:row.id,purpose:row.purpose,state:row.state,printedAt:row.printedAt,
    actualOutput:row.actualOutput,targetOutput:row.targetOutput,unitLabel:row.unitLabel,
    currentGenerationVerified:row.currentGenerationVerified,coverageVerified:row.coverageVerified,
    nativePrintingStatus:row.nativePrintingStatus,historical:row.historical ?? false,
    quantityClassification:classification,requiredOutput:required,quantityUnitMappingVerified:mapped};
}

export function validatePressSnapshot(input,{now=Date.now(),staleAfterMs=15*60*1000}={}) {
  if(!object(input) || input.schemaVersion!==1 || !timestamp(input.generatedAt)
      || Date.parse(input.generatedAt)>now+5*60*1000 || !Array.isArray(input.jobs) || input.jobs.length>5000)reject();
  let sourceStatus={state:'unknown',lastSuccessfulAt:null};
  if(input.sourceStatus!==undefined) {
    const source=input.sourceStatus;
    if(!object(source) || !allowed(source.state,['connected','stale','error'])
        || !(source.lastSuccessfulAt===null || timestamp(source.lastSuccessfulAt))
        || (source.state==='connected' && source.lastSuccessfulAt===null)
        || (source.lastSuccessfulAt!==null && Date.parse(source.lastSuccessfulAt)>now+5*60*1000))reject();
    sourceStatus={state:source.state,lastSuccessfulAt:source.lastSuccessfulAt};
    if(sourceStatus.state==='connected' && (now-Date.parse(sourceStatus.lastSuccessfulAt)>staleAfterMs
        || now-Date.parse(input.generatedAt)>staleAfterMs))sourceStatus.state='stale';
  }
  const jobs=[],seenJobs=new Set(),seenResults=new Set();let count=0;
  for(const job of input.jobs) {
    const jobNo=canonicalPressJob(job?.jobNo);
    if(!object(job) || !jobNo || seenJobs.has(jobNo) || !Array.isArray(job.results)
        || job.results.length>100 || (count+=job.results.length)>MAX_RESULTS)reject();
    seenJobs.add(jobNo);
    const results=job.results.map(publicResult);
    for(const result of results){if(seenResults.has(result.id))reject();seenResults.add(result.id);}
    jobs.push({jobNo,results});
  }
  return {available:true,generatedAt:input.generatedAt,sourceStatus,jobs};
}

export function readPressSnapshot(file,{now=Date.now(),staleAfterMs}={}) {
  const empty=(state='unknown')=>({available:false,generatedAt:null,sourceStatus:{state,lastSuccessfulAt:null},jobs:[]});
  if(!file)return empty();
  let fd;
  try {
    if(typeof file!=='string' || !isAbsolute(file) || file.includes('\0')
        || file.split('/').includes('..') || !file.endsWith('.json'))reject();
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd);
    if(!before.isFile() || before.size<2 || before.size>MAX_BYTES)reject();
    const buffer=Buffer.alloc(MAX_BYTES+1);let length=0,read;
    while(length<buffer.length && (read=readSync(fd,buffer,length,buffer.length-length,null))>0)length+=read;
    if(length>MAX_BYTES)reject();
    const after=fstatSync(fd);
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs || before.ino!==after.ino)reject();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,length));
    return validatePressSnapshot(JSON.parse(text),{now,staleAfterMs});
  } catch{return empty('error');}
  finally {if(fd!==undefined)closeSync(fd);}
}

export function pressJobStatus(snapshot,jobNo) {
  const canonical=canonicalPressJob(jobNo);
  if(!canonical)return null;
  const row=snapshot.jobs.find(job=>job.jobNo===canonical);
  return {jobNo:canonical,results:row?.results ?? [],sourceStatus:snapshot.sourceStatus,
    generatedAt:snapshot.generatedAt,available:snapshot.available};
}
