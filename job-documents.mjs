import {makeVideoSample,reviewer} from './sample-workflow.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {open,unlink} from 'node:fs/promises';
import {linkSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {Fault,need} from './core.mjs';
import {printIQJobKey,printIQNumberFilter,readNumberMatch} from './job-tickets.mjs';

export const maxVideoBytes = 100 * 1024 * 1024;
const jobPattern = /^J\d+(?:-\d+)?$/;

const readJobPattern = /^J\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?$/;

export function canReadJobs(actor) {
  const roles=(process.env.SUNNYLAND_PRINTIQ_JOB_ROLES ?? 'manager,operator,rep').split(',').map(role=>role.trim());
  return ['manager','operator','rep'].includes(actor?.role) && roles.includes(actor.role);
}
export function jobSummary(row) {
  const id = row?.JobNo;
  const canonical = printIQJobKey(id);
  const native = canonical && (id===canonical || id===canonical.slice(1)) ? canonical : id;
  need(row && readJobPattern.test(native) && Number.isSafeInteger(row.Id) && row.Id > 0,
    'printIQ returned an invalid job reference.',502);
  return {id:native,printiqId:row.Id,name:row.JobTitle || '',due:row.DueDate || null,
    quantity:row.Quantity ?? null,...(Number.isSafeInteger(row.ProductionStatusId)?{productionStatusId:row.ProductionStatusId}:{}),completedAt:row.CompletedDate || null};
}

export async function searchJobs(iq, query, before, visibilityFilter=null) {
  need(typeof query === 'string' && query.length <= 100 && !/[\x00-\x1F]/.test(query),'Use up to 100 characters for the job search.');
  need(before === null || (/^[1-9]\d{0,9}$/.test(before) && Number.isSafeInteger(Number(before))), 'Invalid jobs page.');
  const term=query.trim().toLowerCase().replaceAll("'","''");
  const filters=visibilityFilter?[visibilityFilter]:[];
  if (term) filters.push(jobSearchFilter(query));
  if (before) filters.push('Id lt '+Number(before));
  const params=new URLSearchParams({'$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId',
    '$orderby':'Id desc','$top':'26'});
  if (filters.length) params.set('$filter',filters.join(' and '));
  const response=await iq.call('Jobs?'+params);
  need(Array.isArray(response?.value),'Could not read jobs from printIQ.',502);
  const rows=response.value.map(jobSummary);
  let last=before ? Number(before) : Infinity;
  for (const row of rows) {
    need(row.printiqId < last,'printIQ returned an unexpected page order. Refresh the search.',502);
    last=row.printiqId;
  }
  const jobs=rows.slice(0,25);
  return {jobs,nextBefore:jobs.length && (rows.length>25 || response['@odata.nextLink']) ? jobs.at(-1).printiqId : null};
}

export function jobSearchFilter(query) {
  const term=query.trim().toLowerCase().replaceAll("'","''");
  const key=printIQJobKey(query);
  const number=key ? printIQNumberFilter(key) : `contains(tolower(JobNo),'${term}')`;
  return `(${number} or contains(tolower(JobTitle),'${term}'))`;
}

export async function readJob(iq, number, expectedID) {
  const key=printIQJobKey(number);
  need(key || readJobPattern.test(number ?? ''),'Choose a valid job number.');
  let row;
  if (key) row=iq.call ? await readNumberMatch(iq,key) : await iq.job(key);
  else if (jobPattern.test(number)) row=await iq.job(number);
  else {
    const params=new URLSearchParams({'$filter':"JobNo eq '"+number+"'",
      '$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId','$top':'2'});
    const result=await iq.call('Jobs?'+params);
    need(Array.isArray(result?.value) && result.value.length===1,'Job missing or ambiguous in printIQ.',409);
    row=result.value[0];
  }
  need(key ? (row?.JobNo===key || row?.JobNo===key.slice(1)) : row?.JobNo===number,'The printIQ job reference changed.',409);
  const job=jobSummary(row);
  if (expectedID !== null) need(String(job.printiqId)===String(expectedID),'This printIQ job reference has changed.',409);
  return job;
}

export function jobVideos(store,number,printiqId) {
  return store.all('jobVideo').filter(v=>v.job===number && v.printiqId===printiqId)
    .sort((a,b)=>b.at.localeCompare(a.at)||a.id.localeCompare(b.id));
}

async function captureBody(req, filename) {
  const handle=await open(filename,'wx',0o600);
  const hash=createHash('sha256');
  let size=0, prefix=Buffer.alloc(0);
  try {
    for await (const chunk of req) {
      const bytes=Buffer.from(chunk);size+=bytes.length;
      need(size<=maxVideoBytes,'Video exceeds 100 MB. Record a shorter clip.',413);
      if(prefix.length<12) prefix=Buffer.concat([prefix,bytes.subarray(0,12-prefix.length)]);
      hash.update(bytes);await handle.writeFile(bytes);
    }
    need(prefix.length>=12 && prefix.toString('ascii',4,8)==='ftyp','Choose a recorded MOV or MP4 video.');
    await handle.sync();
    return {size,digest:hash.digest('hex')};
  } finally { await handle.close(); }
}

export async function receiveJobVideo({req,params,store,iq,token,mediaDir}) {
  let actor=store.auth(token);
  need(canReadJobs(actor),'Job video access is required.',403);
  const job=params.get('jobVideo'),printiqId=Number(params.get('jobId'));
  need(jobPattern.test(job ?? '') && Number.isSafeInteger(printiqId) && printiqId>0,'Choose a printIQ job.');
  const key=req.headers['idempotency-key'];
  need(typeof key==='string' && /^[A-Za-z0-9-]{8,80}$/.test(key),'Missing recording identifier.');
  const mime=req.headers['content-type'];
  need(['video/quicktime','video/mp4'].includes(mime),'Choose a MOV or MP4 video.',415);
  const label=Buffer.from(String(req.headers['x-video-title']||''),'base64').toString('utf8').trim();
  need(label.length>0 && label.length<=160 && !/[\p{Cc}\uFFFD]/u.test(label),'Use a video title of up to 160 characters.');
  const temp=join(mediaDir,'.incoming-'+randomUUID());
  let linkedFile=null;
  try {
    const {size,digest}=await captureBody(req,temp);
    const selected=params.get('rep');
    const identity={type:'job_video',job,printiqId,mime,title:label,digest,...(selected!==null?{rep:selected}:{})};
    const prior=store.db.prepare('SELECT 1 FROM requests WHERE actor=? AND key=?').get(actor.id,key);
    if (!prior) {
      try { await readJob(iq,job,printiqId); } catch(error) { throw printIQReadError(error); }
    }
    actor=store.auth(token);
    need(canReadJobs(actor),'Job video access is required.',403);
    return store.transaction(actor,key,identity,()=>{
      const id=randomUUID(),at=new Date().toISOString(),file=join(mediaDir,id);
      linkSync(temp,file);linkedFile=file;
      store.put('media',{id,mime,owner:actor.id,kind:'jobVideo',bytes:size,sha256:digest,at});
      const video=store.put('jobVideo',{id,job,printiqId,title:label,creator:actor.id,creatorName:actor.name,media:id,at});
      const jobRep=store.get('job',job)?.rep;
      const account=jobRep && store.get('user',jobRep);
      const activeDefault=account?.enabled && ['rep','manager'].includes(account.role) ? jobRep : null;
      const chosen=selected===null ? activeDefault : selected;
      makeVideoSample(store,video,chosen ? reviewer(store,chosen) : null);
      store.audit(actor,'job_video',id,{job,printiqId,bytes:size});
      store.queue('printiq',id,{kind:'job_video',...video});
      return video;
    });
  } catch(error) {
    if(linkedFile) unlinkSync(linkedFile);
    throw error;
  } finally {await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}

export function printIQReadError(error) {
  if (error instanceof Fault) return error;
  if (error.http===401 || error.http===403) return new Fault('The printIQ integration does not have permission to read jobs. Contact your manager.',502);
  return new Fault('PrintCRM could not read printIQ. Try again when the connection is available.',502);
}
