import {readHourlyFeed,planHourly,hourlySummary} from './hourly-indigo.mjs';
import {need, str, Fault} from './core.mjs';
import {readJob,jobSummary,printIQReadError} from './job-documents.mjs';
import {samePrintIQJob} from './job-tickets.mjs';
import {choosePrintDay,earliestPressStart,finishDay,indigoBookableMinutes} from './print-planning.mjs';
import {operationEvidence,readRouting} from './production-finishes.mjs';

const press='HP Indigo 7900', machine={id:'indigo-planning-agent'};
const itemKind='indigoReadyRun', configKind='indigoPlannerConfig', runKind='printPlanRun';
const config=store=>store.get(configKind,'indigo')??{id:'indigo',enabled:false,revision:0};
const normalized=s=>s.trim().replace(/\s+/g,' ').toLowerCase();
const order=(a,b)=>(a.due??'9999').localeCompare(b.due??'9999')||normalized(a.stock).localeCompare(normalized(b.stock))||
  normalized(a.finishes).localeCompare(normalized(b.finishes))||a.job.localeCompare(b.job)||a.id.localeCompare(b.id);
const uuid=s=>typeof s==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(s);
function routingProblem(row,facts,evidence){
  if(!facts.available)return 'Waiting for a current routing cache';
  const binding=facts.jobs.get(row.job);
  if(!binding)return row.operation?'Refresh accepted operation':'';
  if(!binding.fresh)return 'Refresh accepted operation';
  if(binding.closed)return 'Accepted product is closed';
  if(!row.operation)return 'Accepted routing now available. Release the exact Indigo operation.';
  const op=binding.operations.find(r=>r.id===row.operation);
  if(op?.pressKey!==64)return 'Production is assigned to another press or section';
  if(evidence.get(op.id)?.source)return 'Printing operation already finished';
  return '';
}
function hasExistingRun(row,bookings){
  return bookings.some(b=>{
    if(b.removed || !samePrintIQJob(b.job,row.job) || b.press!==press)return false;
    if(b.job!==row.job)return true;
    if(!b.agentRelease)return true;
    if(b.agentOperation && row.operation)return b.agentOperation===row.operation;
    return Boolean(b.agentOperation || row.operation) || normalized(b.part)===normalized(row.part);
  });
}
function compute(store,observed,remote,facts,now){
  const evidence=new Map(operationEvidence(store,facts).map(r=>[r.id,r]));
  const holds=store.all('hold').filter(h=>!h.releasedAt);
  const bookings=store.all(runKind);
  const inProgress=store.all('operation').filter(op=>['running','paused'].includes(op.state));
  const rows=store.all(itemKind).filter(r=>r.state==='waiting' && observed.has(r.id)).map(r=>{
    const job=remote.get(r.printiqId), local=store.get('job',r.job);
    const due=finishDay(job?.due)??finishDay(local?.due);
    let reason=routingProblem(r,facts,evidence);
    if(!job || !samePrintIQJob(job.id,r.job) || (local?.printiqId && local.printiqId!==r.printiqId))reason='Check exact printIQ job reference';
    else if(job.completedAt || local?.active===false)reason='Job is closed';
    else if(holds.some(h=>samePrintIQJob(h.job,r.job)))reason='Job on hold';
    else if(inProgress.some(op=>samePrintIQJob(op.job,r.job) && (!r.operation || facts.operations.some(f=>f.id===r.operation && f.operationKey===String(op.printiqOperationKey)))))reason='An operator has already started this run';
    else if(!due)reason='Required finish date missing';
    else if(!reason && hasExistingRun(r,bookings))reason='Review an existing Indigo booking';
    return {...r,due,day:null,reason};
  }).sort(order);
  for(const row of rows){
    if(!row.reason && hasExistingRun(row,bookings))row.reason='Review an existing Indigo booking';
    if(row.reason)continue;
    try{
      row.day=choosePrintDay({...row,press,fixedStart:null},bookings,now);
      row.earliestStart=earliestPressStart(press,row.day,now);
      bookings.push({...row,press,fixedStart:null,agentRelease:true,agentOperation:row.operation});
    }catch(e){if(!(e instanceof Fault))throw e;row.reason=e.message;}
  }
  return rows;
}

export function indigoPlanner(store,iq,{routing=()=>readRouting(),clock=()=>new Date(),hourly=readHourlyFeed}={}){
  let busy=false, lastError=null,lastCheck=null;
  const waiting=()=>store.all(itemKind).filter(r=>r.state==='waiting');
  const retry=(actor,key,body,fn)=>store.transaction(actor,key,{indigoPlanner:body},fn);

  async function control(actor,key,body,authenticate=()=>actor){
    store.manager(actor);
    if(body.action==='release'){
      need(body.productionReady===true && uuid(body.id),'Confirm that the production run is ready.');
      const previous=typeof key==='string'&&store.db.prepare('SELECT 1 FROM requests WHERE actor=? AND key=?').get(actor.id,key);
      let job;
      if(!previous){
        try{job=await readJob(iq,body.job,body.printiqId??null);}catch(e){throw printIQReadError(e);}
      }
      const current=authenticate();store.manager(current);
      return retry(current,key,body,()=>{
        need(!job.completedAt,'This printIQ job is closed.',409);
        const local=store.get('job',job.id);
        need(local?.active!==false && (!local?.printiqId || local.printiqId===job.printiqId),'Check the local job reference or active status.',409);
        need(!store.get(itemKind,body.id) && !store.get(runKind,body.id),'Run identifier already exists.',409);
        const stock=str(body.stock,'production stock',160), part=str(body.part,'section or run',160);
        const finishes=str(body.finishes,'finishes (enter None if applicable)',160);
        need(Number.isInteger(body.minutes)&&body.minutes>0&&body.minutes<=indigoBookableMinutes,'Enter 1 to 436 minutes including setup.');
        const row={id:body.id,job:job.id,printiqId:job.printiqId,name:job.name,part,stock,finishes,minutes:body.minutes,
          operation:body.operation??null,due:finishDay(job.due)??finishDay(local?.due),state:'waiting',releasedBy:current.id,releasedAt:clock().toISOString()};
        const facts=routing(), evidence=new Map(operationEvidence(store,facts).map(r=>[r.id,r]));
        const problem=routingProblem(row,facts,evidence);need(!problem,problem,409);
        need(!store.all('hold').some(h=>samePrintIQJob(h.job,row.job)&&!h.releasedAt),'Job on hold.',409);
        need(!waiting().some(r=>samePrintIQJob(r.job,row.job) && (r.job!==row.job || (r.operation&&row.operation?r.operation===row.operation:normalized(r.part)===normalized(row.part)))),
          'That section is already in the Indigo queue.',409);
        need(!hasExistingRun(row,store.all(runKind)),'Review the existing Indigo booking for this job first.',409);
        store.put(itemKind,row);store.audit(current,'release_indigo_run',row.id,row);
        return row;
      });
    }
    return retry(actor,key,body,()=>{
      if(body.action==='cancel'){
        const row=store.require(itemKind,body.id);
        need(row.state==='waiting','This run is already published or withdrawn. Refresh the board.',409);
        row.state='withdrawn';store.put(itemKind,row);store.audit(actor,'withdraw_indigo_release',row.id,{job:row.job});
        return row;
      }
      need(body.action==='configure' && typeof body.enabled==='boolean','Invalid Indigo planner action.');
      const c=config(store);need(body.revision===c.revision,'Planner settings changed. Refresh first.',409);
      const next={...c,enabled:body.enabled,revision:c.revision+1};store.put(configKind,next);
      store.audit(actor,'configure_indigo_agent','indigo',next);return next;
    });
  }

  async function refreshJobs(items){
    const ids=[...new Set(items.map(r=>r.printiqId))], found=new Map();
    for(let i=0;i<ids.length;i+=25){
      const group=ids.slice(i,i+25);
      const query=new URLSearchParams({'$filter':group.map(k=>'Id eq '+k).join(' or '),'$select':'Id,JobNo,JobTitle,DueDate,CompletedDate,Quantity','$top':String(group.length)});
      const result=await iq.call('Jobs?'+query);need(Array.isArray(result?.value),'Job dates unavailable.',502);
      for(const r of result.value){const job=jobSummary(r);need(group.includes(job.printiqId)&&!found.has(job.printiqId),'Ambiguous job reference.',409);found.set(job.printiqId,job);}
    }
    return found;
  }
  async function evaluate(publish){
    const before=config(store),items=waiting();
    if((publish && !before.enabled)||!items.length)return [];
    const remote=await refreshJobs(items),ids=new Set(items.map(r=>r.id));
    store.db.exec(publish?'BEGIN IMMEDIATE':'BEGIN');
    try{
      const current=config(store),now=clock();
      const rows=compute(store,ids,remote,routing(),now);
      if(publish && current.enabled && before.revision===current.revision){
        for(const row of rows.filter(r=>r.day)){
          const run={id:row.id,job:row.job,printiqId:row.printiqId,name:row.name,due:row.due,day:row.day,press,
            minutes:row.minutes,fixedStart:null,earliestStart:row.earliestStart,part:row.part,stock:row.stock,finishes:row.finishes,
            agentRelease:true,agentOperation:row.operation,revision:1};
          need(!store.get(runKind,row.id),'Booking identifier already used.',409);
          store.put(runKind,run);store.put(itemKind,{...store.require(itemKind,row.id),state:'scheduled',day:row.day});
          store.audit(machine,'schedule_indigo_run',run.id,{job:run.job,day:run.day,releasedBy:row.releasedBy});
        }
      }
      store.db.exec('COMMIT');return rows;
    }catch(e){store.db.exec('ROLLBACK');throw e;}
  }
  async function tick(){
    if(busy)return;
    busy=true;
    try{planHourly(store,hourly(),clock());await evaluate(true);lastError=null;}
    catch{lastError='Could not verify the Indigo plan. The agent will retry.';}
    finally{busy=false;lastCheck=clock().toISOString();}
  }
  async function dashboard(){
    let rows,problem=lastError;
    try{rows=await evaluate(false);}catch{rows=waiting().map(r=>({...r,day:null,reason:'Live job lookup unavailable'}));problem='Could not refresh printIQ jobs.';}
    return {...config(store),rows,lastCheck,problem,hourly:hourlySummary(store,clock()),scheduled:store.all(itemKind).filter(r=>r.state==='scheduled' &&
      store.get(runKind,r.id)?.removed!==true).slice(-12).reverse().map(r=>{const run=store.get(runKind,r.id);return {...r,day:run?.day,press:run?.press};})};
  }
  return {control,tick,dashboard,routing};
}
