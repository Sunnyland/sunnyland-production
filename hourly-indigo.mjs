import {rememberStatus} from './job-visibility.mjs';
import {printIQJobKey} from './job-tickets.mjs';
import {openSync, closeSync, fstatSync, readFileSync, constants} from 'node:fs';
import {addWorkdays, chooseLateDay, choosePrintDay, earliestPressStart, finishDay, plantMinute, sequencePressDay} from './print-planning.mjs';
import {queueProductionAlerts} from './indigo-watch.mjs';
import {maintenanceRows, openDays} from './press-plan.mjs';
import {Fault} from './core.mjs';
import {byPriority,plannerSettings,withFinishingPlan} from './indigo-sequence.mjs';

const kind='printPlanRun', marker='indigoHourlyScan', press='HP Indigo 7900', actor={id:'indigo-hourly-agent'};
const path='/var/lib/sunnyland-production/indigo-hourly.json';

export function readHourlyFeed(file=path){
  let fd;
  try{
    fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const st=fstatSync(fd);
    if(!st.isFile() || !(file===path?st.uid===0:[0,process.geteuid()].includes(st.uid)) || (st.mode&0o027) || st.size>32*1024*1024)return null;
    const feed=JSON.parse(readFileSync(fd,'utf8'));
    if(feed.schema!==3 || !Number.isFinite(Date.parse(feed.asOf)) || !Number.isFinite(Date.parse(feed.generatedAt)) ||
       !Array.isArray(feed.history)||!Array.isArray(feed.jobs))return null;
    return feed;
  }catch{return null;}finally{if(fd!==undefined)closeSync(fd);}
}
export function hourlySummary(store,clock=new Date()){
  const row=store.get(marker,'latest');
  if(!row)return {state:'Waiting for the first hourly source scan'};
  const stale=clock.getTime()-Date.parse(row.asOf)>2*3600000;
  return {...row,state:stale?'Hourly source overdue':row.state};
}
export function planHourly(store,feed,now=new Date()){
  if(!feed || now-Date.parse(feed.asOf)>2*3600000 || Date.parse(feed.generatedAt)>now.getTime()+60000)return;
  store.db.exec('BEGIN IMMEDIATE');
  try{
    const plannerConfig=store.get('indigoPlannerConfig','indigo');
    const enabled=plannerConfig?.enabled===true;
    const settings=plannerSettings(plannerConfig);
    const last=store.get(marker,'latest');
    if(last && (last.generatedAt>feed.generatedAt || (last.generatedAt===feed.generatedAt && (last.enabled || !enabled)))){
      store.db.exec('COMMIT');return;
    }
    if(feed.completeStatusIds?.length)store.put('jobStatusCatalogue',{id:'current',completeIds:feed.completeStatusIds});
    for(const [job,printiqId] of feed.undatedComplete??[])rememberStatus(store,{job,printiqId,complete:true},feed.asOf);
    for(const row of feed.visibility??[])rememberStatus(store,row,feed.asOf);
    const observedComplete=new Set((feed.visibility??[]).filter(v=>v.completedAt || v.complete).map(v=>v.job));
    for(const row of feed.jobs)if(row.state==='complete' && !observedComplete.has(row.job))rememberStatus(store,{...row,complete:true},feed.asOf);
    const day=finishDay(now.toISOString()), minute=plantMinute(now), bookings=[...store.all(kind),...maintenanceRows(store)],open=openDays(store);
    const changed=new Map(),kept=[],future=new Map(),pending=[],review=[];
    const jobKey=value=>printIQJobKey(value)??value;
    const localOps=store.all('operation'),holds=new Set(store.all('hold').filter(h=>!h.releasedAt).map(h=>jobKey(h.job)));
    const localJobs=store.all('job');
    const manualQueue=store.all('indigoReadyRun').filter(r=>r.state==='waiting');
    const checks=new Set(store.all('checkedPrintFinish').filter(r=>r.active).map(r=>r.id));
    const historyJobs=new Set(feed.history.map(r=>r.job).filter(Boolean));
    const closed=new Set(feed.jobs.filter(j=>j.state==='complete').map(j=>j.job));
    const reviewed=new Map(feed.jobs.map(j=>[j.job,j]));
    const todays=sequencePressDay(bookings.filter(b=>!b.removed && b.day===day && b.press===press));
    const started=new Set(todays.filter(r=>r.start!==null && r.start<=minute).map(r=>r.id));
    for(const b of bookings){
      const key=jobKey(b.job),job=reviewed.get(key), same=localOps.some(op=>jobKey(op.job)===key && String(op.printiqOperationKey)===b.operationKey && ['running','paused','completed'].includes(op.state));
      const unstarted=b.day>day || (b.day===day && !started.has(b.id));
      if(b.hourly && !b.managerOverride && !b.removed && unstarted && !same && enabled &&
          (closed.has(key) || (job && !feed.approvalError && !feed.directoryError && !['Accepted routing unavailable','Exact printIQ job unavailable'].includes(job.state)) ||
            (!job && !feed.directoryError && !feed.approvalError)))future.set(b.id,b);
      else kept.push(b);
    }
    const fixed=kept.filter(b=>!b.removed && !b.held);
    // Unapproved jobs due in the next five working days are pencilled in after the approved work.
    const pencilBy=addWorkdays(day,5),awaiting='Awaiting current artwork approval';
    const pencil=job=>job.state===awaiting && Array.isArray(job.runs) && job.runs.length && validDue(job.due) && finishDay(job.due)>=day && finishDay(job.due)<=pencilBy;
    const jobsById=new Map();
    for(const job of feed.jobs){
      if(job.state!=='open' && !pencil(job)){
        if(!['complete','cancelled','other press'].includes(job.state))review.push({id:job.job,job:job.job,reason:job.state});
        continue;
      }
      for(const item of job.runs){
        // Finishing time from printIQ sets the latest print day; only plain values are stored on the booking.
        const {finishOps:_ops,...run}=withFinishingPlan({id:item.id,job:job.job,name:job.name,printiqId:job.printiqId,press,part:item.part,stock:item.stock,finishes:item.finishes,
          minutes:item.minutes,due:finishDay(job.due),fixedStart:null,operationKey:item.operationKey,agentOperation:item.operation,agentRelease:true,hourly:true,
          finishOps:Array.isArray(item.finishOps)?item.finishOps:undefined,finishingMinutes:item.finishingMinutes,inIndigoQueue:job.inIndigoQueue===true,
          provisional:job.state!=='open'},settings);
        jobsById.set(item.id,job);
        const locals=localJobs.filter(row=>jobKey(row.id)===job.job);
        let reason='';
        if(holds.has(job.job) || locals.some(local=>local.active===false || (local.printiqId && local.printiqId!==run.printiqId)))reason='Check local job status or hold';
        else if(checks.has(item.operation)||localOps.some(op=>jobKey(op.job)===job.job && String(op.printiqOperationKey)===item.operationKey && ['running','paused','completed'].includes(op.state)))reason='Operation already started or finished';
        else if(kept.some(b=>b.id===item.id && (!b.removed || b.managerOverride)))continue;
        else if(fixed.some(b=>jobKey(b.job)===job.job && b.press===press && (!b.agentOperation || b.agentOperation===item.operation || b.operationKey===item.operationKey || b.job!==job.job)))reason='Existing Indigo booking';
        else if(manualQueue.some(r=>jobKey(r.job)===job.job && (!r.operation || r.operation===item.operation || r.job!==job.job)))reason='Existing manual release';
        else if(item.estimateIssue)reason=item.estimateIssue;
        else if(!(Number.isInteger(item.minutes)&&item.minutes>0)||!item.stock||!run.due)reason='Check required date, stock or run duration';
        if(reason)review.push({id:item.id,job:job.job,reason});
        else pending.push(run);
      }
    }
    pending.sort((a,b)=>Number(a.provisional)-Number(b.provisional)||byPriority(a,b));
    const published=[],lateAlerts=[];
    for(const run of pending){
      try{run.day=choosePrintDay(run,fixed,now,open);run.finishingAtRisk=false;}catch(e){
        if(!(e instanceof Fault))throw e;
        // No day leaves the full finishing time: book the earliest day before the due date and flag it.
        let day=null;
        if(run.latestPrintDay && run.latestPrintDay<run.due){try{day=choosePrintDay({...run,latestPrintDay:null},fixed,now,open);}catch(again){if(!(again instanceof Fault))throw again;}}
        // Still nothing: approved work goes on the earliest day with room, flagged late (pencilled-in work waits).
        if(!day && !run.provisional){try{day=chooseLateDay(run,fixed,now,open);}catch(again){if(!(again instanceof Fault))throw again;}}
        if(!day){review.push({id:run.id,job:run.job,reason:run.provisional?'Not approved, and no room before it is due':e.message});continue;}
        run.day=day;run.finishingAtRisk=true;
        if(day<=run.due)review.push({id:run.id,job:run.job,reason:'Booked '+day+', but that leaves less than the '+run.finishingDays+' working day'+(run.finishingDays===1?'':'s')+' of finishing printIQ estimates'});
      }
      // Best-case dispatch: print day, printIQ's finishing days, plus one spare working day.
      run.bestDispatch=addWorkdays(run.day,(Number.isInteger(run.finishingDays)?run.finishingDays:0)+1);
      run.late=!run.provisional && run.bestDispatch>run.due;
      if(run.late){
        review.push({id:run.id,job:run.job,reason:'Late: printing '+run.day+', best-case dispatch '+run.bestDispatch+' (due '+run.due+')'});
        lateAlerts.push({run,job:jobsById.get(run.id)});
      }
      run.earliestStart=earliestPressStart(press,run.day,now);
      fixed.push(run);published.push({id:run.id,job:run.job,part:run.part,day:run.day,press});
      if(!enabled)continue;
      const old=store.get(kind,run.id);
      if(old?.managerOverride || (old&&!old.hourly))continue;
      run.revision=(old?.revision??0)+1;
      if(!old || old.removed || Object.keys(run).some(k=>k!=='revision' && run[k]!==old[k]))changed.set(run.id,run);
      future.delete(run.id);
    }
    for(const [id,old] of future)changed.set(id,{...old,removed:true,revision:old.revision+1});
    if(enabled)lateEmails(store,lateAlerts,plannerConfig??{});
    for(const run of changed.values()){store.put(kind,run);store.audit(actor,run.removed?'withdraw_auto_indigo':'plan_auto_indigo',run.id,{job:run.job,day:run.day});}
    const summary={id:'latest',state:[feed.approvalError,feed.directoryError].filter(Boolean).join(' ') || 'Sources checked',enabled,asOf:feed.asOf,generatedAt:feed.generatedAt,
      entries:feed.history.length,historyJobs:historyJobs.size,completed:[...historyJobs].filter(j=>closed.has(j)).length,
      history:feed.history.map(h=>({...h,id:h.entry,mis:reviewed.get(h.job)?.state==='complete'?'Complete in printIQ':reviewed.get(h.job)?.state==='cancelled'?'Cancelled':'Completion unverified'})),
      bookings:published,review};
    store.put(marker,summary);
    store.db.exec('COMMIT');
  }catch(e){store.db.exec('ROLLBACK');throw e;}
}

const validDue=value=>typeof value==='string' && Boolean(finishDay(value));
const longDay=day=>new Date(day+'T00:00:00Z').toLocaleDateString('en-AU',{weekday:'long',day:'numeric',month:'long',timeZone:'UTC'});

/// Emails the sales rep (or the managers when printIQ has no rep email) when a job can't make its due date,
/// with the best-case dispatch date. Once per job, and again only if the date moves later.
function lateEmails(store,late,config){
  const alerts=[];
  for(const {run,job} of late){
    const prior=store.get('lateDispatch',run.job);
    if(prior && prior.dispatch>=run.bestDispatch)continue;
    store.put('lateDispatch',{id:run.job,dispatch:run.bestDispatch,printDay:run.day,due:run.due,at:new Date().toISOString()});
    const rep=job?.rep?.email && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(job.rep.email)?job.rep:null;
    alerts.push({key:`late-dispatch:${run.job}:${run.bestDispatch}`,audience:rep?'rep':'managers',rep,job:run.job,
      subject:`${run.job} ${run.name??''}: best-case dispatch ${longDay(run.bestDispatch)} (due ${longDay(run.due)})`.replace(/\s+/g,' '),
      text:[`${run.job} ${run.name??''} can't be ready by its due date of ${longDay(run.due)}.`,'',
        `It is booked on the Indigo for ${longDay(run.day)}${run.part?` (${run.part})`:''}.`,
        `printIQ allows ${run.finishingDays??0} working day${run.finishingDays===1?'':'s'} of finishing after printing, plus one spare day,`,
        `so the best-case dispatch date is ${longDay(run.bestDispatch)}.`,'',
        'Please let the customer know, or talk to production about moving other work.',
        ...(rep?[]:['','(No rep email was found for this job in printIQ, so this went to the production managers.)'])].join('\n')});
  }
  if(alerts.length)queueProductionAlerts(store,alerts,config);
}
