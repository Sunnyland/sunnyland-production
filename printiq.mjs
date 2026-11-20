import {jobNoteLines,printIQJobKey,readNumberMatch} from './job-tickets.mjs';
import {need} from './core.mjs';
export class PrintIQ {
 constructor({token=process.env.PRINTIQ_TOKEN,noteType=process.env.PRINTIQ_NOTE_TYPE,user=process.env.PRINTIQ_NOTE_USER,write=process.env.PRINTIQ_NOTES_ENABLED==='true',active=process.env.PRINTIQ_ACTIVE_STATUSES||'',fetcher=fetch}={}){this.token=token;this.noteType=Number(noteType);this.user=user;this.write=write;this.active=String(active).split(',').filter(Boolean).map(Number);this.fetcher=fetcher;}
 async call(path,{method='GET',body}={}){need(this.token,'Existing printIQ API token is not configured.');const response=await this.fetcher('https://sunnyland.printiq.com/api/v1/odata/'+path,{method,headers:{'PrintIQ-Access-Token':this.token,'Content-Type':'application/json','Accept':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000),redirect:'error'});if(!response.ok){const error=new Error(`printIQ returned HTTP ${response.status}.`);error.http=response.status;throw error;}return response.status===204?{}:response.json();}
 async job(number){need(/^J\d+(?:-\d+)?$/.test(number),'Invalid job number.');const q=new URLSearchParams({'$filter':`JobNo eq '${number}'`,'$select':'Id,JobNo,JobTitle,ProductionStatusId,CompletedDate,AccountManagerId,Quantity,DueDate','$top':'2'});const r=await this.call('Jobs?'+q);need(Array.isArray(r.value)&&r.value.length===1,'printIQ job match is missing or ambiguous.');need(r.value[0].JobNo===number&&Number.isSafeInteger(r.value[0].Id)&&r.value[0].Id>0,'printIQ returned a mismatched job.');return r.value[0];}
 async ticketOperation(key) {
   need(/^\d{1,10}$/.test(key) && Number(key) > 0 && Number(key) <= 2147483647,'Invalid printIQ operation ID.');
   const params=new URLSearchParams({'$filter':'Id eq '+Number(key),'$select':'Id,QuoteDetailSectionId','$top':'2'});
   try {
     const response=await this.call('Operations?'+params);
     need(Array.isArray(response.value) && response.value.length<=1,'Ambiguous printIQ operation.');
     const row=response.value[0];
     if (row) need(row.Id===Number(key),'printIQ returned a different operation.');
     return row;
   } catch (error) {
     if ([403,404].includes(error.http)) return null;
     throw error;
   }
 }
 async refresh(store,number){
   need(this.active.length>0&&this.active.every(v=>Number.isSafeInteger(v)&&v>0),'Verify the active production status IDs before enabling job refresh.');
   const key=printIQJobKey(number);
   const remote=key ? await readNumberMatch(this,key) : await this.job(number);
   const job=store.get('job',number) ?? store.require('job',key??number);
   need(!job.printiqId || job.printiqId===remote.Id,'The linked printIQ job ID has changed.',409);
   job.printiqId=remote.Id;job.active=this.active.includes(remote.ProductionStatusId)&&!remote.CompletedDate;
   job.verifiedAt=new Date().toISOString();job.verification='printiq';job.productionStatusId=remote.ProductionStatusId;
   store.put('job',job);return job;
 }
 async findNote(jobId,marker){const q=new URLSearchParams({'$filter':`JobId eq ${jobId} and contains(NoteValue,'${marker.replaceAll("'","''")}')`,'$select':'Id,JobId,NoteValue','$top':'2'});const r=await this.call('Notes?'+q);need(Array.isArray(r.value),'printIQ note lookup was not verifiable.');need(r.value.length<=1,'Duplicate event markers found in printIQ.');const n=r.value[0];if(n)need(n.JobId===jobId&&n.NoteValue.includes(marker)&&Number.isSafeInteger(n.Id)&&n.Id>0,'printIQ note lookup returned a mismatched event.');return n;}
 validateWrite(){need(this.write,'printIQ job-note feedback is disabled.');need(Number.isSafeInteger(this.noteType)&&this.noteType>0&&/^[0-9a-f-]{36}$/i.test(this.user||'')&&!/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(this.user),'Verify the printIQ note type and integration user IDs.');need(this.token,'Existing printIQ API token is not configured.');}
 async deliver(entry,store,{reconcileOnly=false}={}){this.validateWrite();const event=JSON.parse(entry.body);need(typeof event.job==='string','No job reference is available for this event.');const job=await this.job(event.job),marker=`[Sunnyland event: ${entry.id}]`;
  if(event.kind==='job_video')need(job.Id===event.printiqId,'The linked printIQ job ID has changed.');
  const found=await this.findNote(job.Id,marker);if(found)return {state:'accepted',receipt:{noteId:found.Id,jobId:job.Id,reconciled:true,acceptedAt:new Date().toISOString()}};
  if(reconcileOnly)return {state:'uncertain',receipt:{reason:'No note with this event marker was found. Reconcile before resending.'}};
  const actorId=event.actor||event.decisionBy||event.creator;const actor=actorId?store.get('user',actorId):null;const text=[marker,`Sunnyland Production: ${event.kind}`,`Job: ${event.job}${event.section?' / '+event.section:''}`,`Staff: ${actor?.name||'Recorded in app audit'}`,...jobNoteLines(event)].join('\n');
  try{const response=await this.call('Notes',{method:'POST',body:{NoteValue:text,NoteDate:new Date().toISOString(),CreatedUserId:this.user,NoteTypeId:this.noteType,JobId:job.Id,Active:true,ShowOnRelatedJobs:false}});const readback=await this.findNote(job.Id,marker);if(readback)return {state:'accepted',receipt:{noteId:readback.Id,jobId:job.Id,acceptedAt:new Date().toISOString()}};return {state:'uncertain',receipt:{reason:'POST completed but note readback was not confirmed.',returnedId:response.Id||null}};}catch(e){return {state:e.http&&e.http>=400&&e.http<500?'rejected':'uncertain',receipt:{reason:e.message}};}
 }
}
