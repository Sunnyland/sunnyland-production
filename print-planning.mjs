import {need, str} from './core.mjs';
import {jobSearchFilter,jobSummary} from './job-documents.mjs';
import {printIQJobKey,printIQNumberFilter,samePrintIQJob} from './job-tickets.mjs';

export const presses = ['HP Indigo 7900','Ryobi 755','Heidelberg SM52'];
const kind = 'printPlanRun';
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
import {finishDay,validDay,hiddenJobs,observeDirectory,isPlantWorkday} from './job-visibility.mjs';
import {indigoDayOrder,sharesFinishing} from './indigo-sequence.mjs';
import {maintenanceRows,openDays,planBookings} from './press-plan.mjs';
export {finishDay} from './job-visibility.mjs';
const normalized = s => s.trim().toLowerCase().replace(/\s+/g,' ');
const optionalText = (value,label) => value === '' ? '' : str(value,label,160);
const closed = job => job?.active === false || Boolean(job?.completedAt);
const overlaps = (a,b) => a.start < b.end && b.start < a.end;
const indigo = 'HP Indigo 7900';
const shiftStart = 7 * 60, shiftEnd = 17 * 60;
const printStart = shiftStart + 45, printEnd = shiftEnd - 10;
export const indigoBookableMinutes = Math.floor((printEnd - printStart) * 80 / 100);
const indigoLimitMessage = 'Indigo bookings are limited to 436 minutes per day, including setup.';
const printWindow = press => press === indigo ? {start:printStart, end:printEnd} : {start:480, end:960};

export function indigoCapacity(bookings, day, press) {
  if (press !== indigo) return null;
  const bookedMinutes = bookings.filter(r => !r.removed && r.press === press && r.day === day)
    .reduce((total, r) => total + r.minutes, 0);
  return {shiftStart, shiftEnd, printStart, printEnd, limitMinutes:indigoBookableMinutes, bookedMinutes};
}

export function earliestPressStart(press, day, now) {
  const {start} = printWindow(press);
  return day === finishDay(now.toISOString()) ? Math.max(start, plantMinute(now)) : start;
}

export function savePrintRun(store,actor,key,body,job) {
  store.manager(actor);
  return store.transaction(actor,key,body,()=>{
    need(typeof body.id==='string' && uuid.test(body.id),'Invalid run identifier.');
    const prior=store.get(kind,body.id);
    need(!prior?.removed && (prior?.revision ?? 0)===body.revision,'This run changed. Refresh the schedule and reopen the run.',409);
    need(!prior || (prior.job===body.job && prior.printiqId===(body.printiqId??null)),'The job for this run cannot change.',409);
    let run;
    if (body.remove===true) {
      need(prior,'Run unavailable.',404);
      run={...prior,removed:true};
    } else {
      const local=store.get('job',body.job);
      const matches=job && (job.id===body.job || (body.printiqId===job.printiqId && !!body.printiqId && samePrintIQJob(body.job,job.id)));
      need(matches && !closed(job) && !closed(local),'Choose an open job.',409);
      need(!local?.printiqId || !body.printiqId || local.printiqId===body.printiqId,'The local job has a different printIQ reference.',409);
      need(presses.includes(body.press) && (body.autoDay===true || validDay(body.day)),'Choose a press and print date.');
      need(!(body.autoDay===true && body.fixedStart!==null),'Select a date for a fixed booking.');
      need(Number.isInteger(body.minutes) && body.minutes>0 && body.minutes<=1440,'Enter a duration of 1 to 1440 minutes.');
      const fixed=body.fixedStart;
      need(fixed===null || (Number.isInteger(fixed) && fixed>=0 && fixed+body.minutes<=1440),'The fixed run must fit within its print date.');
      if (fixed!==null) {
        const collision=planBookings(store).some(r=>!r.removed && r.id!==body.id && r.day===body.day && r.press===body.press &&
          r.fixedStart!==null && overlaps({start:fixed,end:fixed+body.minutes},{start:r.fixedStart,end:r.fixedStart+r.minutes}));
        need(!collision,'That time overlaps another fixed booking on this press.',409);
      }
      run={id:body.id,job:prior?.job??job.id,printiqId:body.printiqId??null,name:job.name,due:finishDay(job.due)??finishDay(local?.due),
        day:body.day,press:body.press,minutes:body.minutes,fixedStart:fixed,
        part:optionalText(body.part,'section or run'),stock:optionalText(body.stock,'stock'),finishes:optionalText(body.finishes,'finishes')};
      const now=new Date();
      if(body.autoDay===true) {
        need(!store.all('hold').some(h=>samePrintIQJob(h.job,job.id) && !h.releasedAt),'Release the job hold before automatic scheduling.',409);
        run.day=choosePrintDay(run,planBookings(store),now,openDays(store));
      }
      if (run.press===indigo) {
        const others=planBookings(store).filter(b=>b.id!==run.id);
        const capacity=indigoCapacity(others,run.day,run.press);
        const sameDay=prior?.press===run.press && prior.day===run.day;
        need(capacity.bookedMinutes+run.minutes<=capacity.limitMinutes || (sameDay && run.minutes<=prior.minutes),indigoLimitMessage,409);
        const existingSlot=sameDay && fixed===prior.fixedStart && run.minutes<=prior.minutes;
        need(fixed===null || existingSlot || (fixed>=printStart && fixed+run.minutes<=printEnd),
             'Choose an Indigo print time between 07:45 and 16:50.',409);
      }
      run.earliestStart=earliestPressStart(run.press,run.day,now);
    }
    if(prior?.hourly){run.hourly=true;run.managerOverride=true;run.agentOperation=prior.agentOperation;run.operationKey=prior.operationKey;}
    run.revision=(prior?.revision??0)+1;
    store.put(kind,run);
    store.audit(actor,'printPlanRun',run.id,run);
    return run;
  });
}

// Fixed bookings reserve their times. A lower-priority automatic run never pushes
// a more urgent one later. All times are wall-clock minutes at the plant.
export function sequencePressDay(all) {
  // Held runs take no slot. "Any time" maintenance is kept free at the end of the day. Rush runs go first.
  const held=all.filter(r=>r.held).map(r=>({...r,start:null,end:null,blocked:'Held'}));
  const anyTime=all.filter(r=>!r.held && r.maintenance && r.fixedStart===null).map(r=>({...r,start:null,end:null}));
  const rows=all.filter(r=>!r.held && !(r.maintenance && r.fixedStart===null));
  const reserve=anyTime.reduce((total,r)=>total+r.minutes,0);
  const fixed=rows.filter(r=>r.fixedStart!==null).map(r=>({...r,start:r.fixedStart,end:r.fixedStart+r.minutes}));
  fixed.sort((a,b)=>a.start-b.start);
  const unfixed=rows.filter(r=>r.fixedStart===null);
  // The Indigo groups paper and shared finishing (see indigo-sequence.mjs); other presses keep due-date order.
  const ordered=unfixed.length && unfixed.every(r=>r.press===indigo) ? indigoDayOrder(unfixed) : unfixed.sort((a,b)=>
    (a.due??'9999').localeCompare(b.due??'9999') ||
    (normalized(a.stock)||'\uffff').localeCompare(normalized(b.stock)||'\uffff') ||
    (normalized(a.finishes)||'\uffff').localeCompare(normalized(b.finishes)||'\uffff') ||
    a.job.localeCompare(b.job) || a.id.localeCompare(b.id));
  const auto=[...ordered.filter(r=>r.rush),...ordered.filter(r=>!r.rush)];
  const occupied=fixed.map(({start,end})=>({start,end}));
  const placed=[...fixed];
  for (const r of auto) {
    if (r.blocked) {placed.push({...r,start:null,end:null});continue;}
    const window={...printWindow(r.press)};window.end-=reserve;
    let start=Math.max(window.start,r.earliestStart??window.start);
    for (const slot of occupied) {
      if (overlaps({start,end:start+r.minutes},slot)) start=slot.end;
    }
    const end=start+r.minutes;
    if (end>window.end) placed.push({...r,start:null,end:null,blocked:r.press===indigo?'Outside Indigo print window 07:45–16:50':'Outside automatic shift 08:00–16:00'});
    else {
      occupied.push({start,end});occupied.sort((a,b)=>a.start-b.start);
      placed.push({...r,start,end});
    }
  }
  return [...placed.sort((a,b)=>(a.start??1441)-(b.start??1441)),...anyTime,...held];
}

export function plantMinute(now) {
  const clock=new Intl.DateTimeFormat('en-GB',{timeZone:'Australia/Melbourne',hourCycle:'h23',hour:'2-digit',minute:'2-digit'}).format(now);
  const [hours,minutes]=clock.split(':').map(Number);
  return hours*60+minutes+(now.getSeconds()!==0?1:0);
}

// Match setups only among days that fit the full estimated run by its finish day.
export function choosePrintDay(run,bookings,now,open=new Set()) {
  const today=finishDay(now.toISOString());
  need(validDay(run.due),'Set a required finish date or choose the print date manually.');
  // Leave the run's finishing time before its due date when the agent has worked it out.
  const deadline=validDay(run.latestPrintDay) && run.latestPrintDay<run.due ? run.latestPrintDay : run.due;
  if (run.press===indigo) need(run.minutes<=indigoBookableMinutes,indigoLimitMessage,409);
  const candidates=[];
  let atCapacity=false;
  const start=new Date(today+'T00:00:00Z');
  for(let offset=0,weekdays=0;weekdays<5;offset++){
    const date=new Date(start.getTime()+offset*86400000), day=date.toISOString().slice(0,10);
    if(day>deadline)break;
    // Saturdays only when a manager has opened them for automatic booking.
    if(date.getUTCDay()===0 || (date.getUTCDay()===6 && !open.has(day)))continue;
    weekdays++;
    const same=bookings.filter(r=>!r.removed && r.press===run.press && r.day===day && r.id!==run.id);
    const capacity=indigoCapacity(same,day,run.press);
    if(capacity && capacity.bookedMinutes+run.minutes>capacity.limitMinutes){atCapacity=true;continue;}
    const placed=sequencePressDay([...same,{...run,day,earliestStart:earliestPressStart(run.press,day,now)}]);
    if(placed.some(r=>r.start===null && !r.maintenance && !r.held))continue;
    const eligible=same.filter(r=>day!==today || placed.find(p=>p.id===r.id)?.end>plantMinute(now));
    const stocks=eligible.filter(r=>normalized(run.stock) && normalized(r.stock)===normalized(run.stock));
    const finishMatch=(stocks.length?stocks:eligible).some(r=>sharesFinishing(run,r));
    candidates.push({day,stock:stocks.length>0,finishes:finishMatch});
  }
  candidates.sort((a,b)=>Number(b.stock)-Number(a.stock)||Number(b.finishes)-Number(a.finishes)||a.day.localeCompare(b.day));
  const by=deadline<run.due?'in time for its finishing before the due date':'by the required finish';
  need(candidates.length,atCapacity?'No automatic slot fits '+by+' within the 80% Indigo booking limit.':'No automatic slot fits '+by+' in the next five weekdays. Choose another press or set a date and time.',409);
  return candidates[0].day;
}

/// When no day meets the due date: the earliest day in the next ten weekdays with room (ignores the due date).
export function chooseLateDay(run,bookings,now,open=new Set()) {
  const today=finishDay(now.toISOString());
  if (run.press===indigo) need(run.minutes<=indigoBookableMinutes,indigoLimitMessage,409);
  const start=new Date(today+'T00:00:00Z');
  for(let offset=0,weekdays=0;weekdays<10;offset++){
    const date=new Date(start.getTime()+offset*86400000), day=date.toISOString().slice(0,10);
    if(date.getUTCDay()===0 || (date.getUTCDay()===6 && !open.has(day)))continue;
    weekdays++;
    const same=bookings.filter(r=>!r.removed && r.press===run.press && r.day===day && r.id!==run.id);
    const capacity=indigoCapacity(same,day,run.press);
    if(capacity && capacity.bookedMinutes+run.minutes>capacity.limitMinutes)continue;
    const placed=sequencePressDay([...same,{...run,day,earliestStart:earliestPressStart(run.press,day,now)}]);
    if(placed.some(r=>r.start===null && !r.maintenance && !r.held))continue;
    return day;
  }
  need(false,'No room on the Indigo in the next ten weekdays.',409);
}
/// `day` plus n plant working days (weekends and public holidays skipped).
export function addWorkdays(day,n){
  let d=new Date(day+'T00:00:00Z'),left=n;
  while(left>0){d=new Date(d.getTime()+86400000);if(isPlantWorkday(d.toISOString().slice(0,10)))left--;}
  return d.toISOString().slice(0,10);
}

export async function localJobDates(store,iq) {
  const byNumber=new Map();
  for(const job of store.all('job')){
    const key=printIQJobKey(job.id) ?? job.id;
    if(!/^J\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?$/.test(key))continue;
    if(!byNumber.has(key))byNumber.set(key,[]);
    byNumber.get(key).push(job);
  }
  const locals=[...byNumber];
  const dates=[];
  const jobsPerLookup=10;
  for(let i=0;i<locals.length;i+=jobsPerLookup){
    const group=new Map(locals.slice(i,i+jobsPerLookup));
    const params=new URLSearchParams({'$filter':[...group.keys()].map(id=>printIQJobKey(id)?printIQNumberFilter(id):"JobNo eq '"+id+"'").join(' or '),
      '$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId','$top':String(group.size+1)});
    const result=await iq.call('Jobs?'+params);
    need(Array.isArray(result?.value) && !result['@odata.nextLink'],'Could not verify all local job references.',502);
    const seen=new Set();
    for(const row of result.value){
      const remote=jobSummary(row),matches=group.get(remote.id);
      need(matches && !seen.has(remote.id),'Ambiguous printIQ job reference.',409);
      seen.add(remote.id);
      observeDirectory(store,[remote]);
      for(const local of matches){
        if(!local.printiqId || local.printiqId===remote.printiqId)
          dates.push({id:local.id,printiqId:remote.printiqId,due:remote.due,completedAt:remote.completedAt});
      }
    }
  }
  return dates;
}

export async function pressDay(store,iq,day,press) {
  need(validDay(day) && presses.includes(press),'Choose a print date and press.');
  const rows=[...store.all(kind).filter(r=>!r.removed && r.day===day && r.press===press),...maintenanceRows(store).filter(r=>r.day===day && r.press===press)];
  const ids=[...new Set(rows.map(r=>r.printiqId).filter(Boolean))], remote=new Map();
  for (let i=0;i<ids.length;i+=25) {
    const group=ids.slice(i,i+25);
    const params=new URLSearchParams({'$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId','$filter':group.map(id=>'Id eq '+id).join(' or '),'$top':String(group.length)});
    const result=await iq.call('Jobs?'+params);
    need(Array.isArray(result?.value),'Could not refresh the scheduled jobs from printIQ.',502);
    for(const data of result.value) {
      const job=jobSummary(data);
      need(group.includes(job.printiqId) && !remote.has(job.printiqId),'Unexpected scheduled job identity from printIQ.',502);
      remote.set(job.printiqId,job);
    }
  }
  const holds=new Set(store.all('hold').filter(h=>!h.releasedAt).map(h=>h.job));
  observeDirectory(store,[...remote.values()]);
  const hidden=hiddenJobs(store);
  return sequencePressDay(rows.filter(r=>r.maintenance || !hidden(r.job,r.printiqId)).map(r=>{
    if(r.maintenance)return r;
    const local=store.get('job',r.job);
    const job=r.printiqId?remote.get(r.printiqId):local;
    const matches=Boolean(job) && samePrintIQJob(job.id,r.job) && !(r.printiqId && local?.printiqId && r.printiqId!==local.printiqId);
    const blocked=!matches?'Check job reference':closed(job)||closed(local)?'Closed job':holds.has(r.job)?'Job on hold':null;
    return {...r,due:matches?(finishDay(job.due)??finishDay(local?.due)):null,blocked};
  }));
}

// Two streams keep undated jobs last. Apply filters at the provider before paging.
export async function searchDueJobs(iq,params,visibilityFilter=null) {
  const term=params.get('jobs')?.trim().toLowerCase()??'';
  need(term.length<=100 && !/[\x00-\x1f]/.test(term),'Check the job search.');
  const cursor=params.get('cursor')??'dated:0';
  const match=/^(dated|undated):(0|[1-9]\d{0,15})(?:\|([^|]{10,40}))?$/.exec(cursor);
  need(match,'Invalid finish date page.');
  const dated=match[1]==='dated', after=Number(match[2]), latest=params.get('by')==='latest';
  const instant=v=>typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
  const literal=v=>validDay(v)?v+'T00:00:00Z':instant(v)?v:null;
  const stamp=literal(match[3]);
  need(Number.isSafeInteger(after) && (dated && after && !latest ? Boolean(stamp) : match[3]===undefined),'Invalid finish date page.');
  const filters=[dated?'DueDate ne null':'DueDate eq null'];
  if(after){
    if(latest)filters.push('Id lt '+after);
    else if(dated)filters.push('(DueDate gt '+stamp+' or (DueDate eq '+stamp+' and Id gt '+after+'))');
    else filters.push('Id gt '+after);
  }
  if(params.get('includeCompleted')!=='1')filters.push('CompletedDate eq null');
  else if(visibilityFilter)filters.push(visibilityFilter);
  if (term) {
    filters.push(jobSearchFilter(term));
  }
  const from=params.get('from'), until=params.get('until');
  if (from!==null || until!==null) {
    const iso=s=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(s) && Number.isFinite(Date.parse(s));
    need(dated && iso(from) && iso(until) && Date.parse(until)>Date.parse(from),'Invalid finish date window.');
    filters.push('DueDate ge '+from,'DueDate lt '+until);
  }
  const query=new URLSearchParams({'$select':'Id,JobNo,JobTitle,Quantity,DueDate,CompletedDate,ProductionStatusId','$filter':filters.join(' and '),
    '$orderby':latest?'Id desc':dated?'DueDate asc,Id asc':'Id asc','$top':'26'});
  const result=await iq.call('Jobs?'+query);
  need(Array.isArray(result?.value),'Could not read jobs by finish date.',502);
  const jobs=result.value.slice(0,25).map(jobSummary);
  const more=jobs.length>0 && (result.value.length>25 || Boolean(result['@odata.nextLink']));
  if(more){
    const last=jobs.at(-1), date=literal(last.due);
    need(!dated || latest || date,'printIQ returned an invalid finish date.',502);
    return {jobs,nextCursor:match[1]+':'+last.printiqId+(dated&&!latest?'|'+date:'')};
  }
  return {jobs,nextCursor:dated&&!from?'undated:0':null};
}
