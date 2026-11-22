import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../core.mjs';
import {planHourly,hourlySummary} from '../hourly-indigo.mjs';
import {choosePrintDay, indigoCapacity, savePrintRun, sequencePressDay} from '../print-planning.mjs';
import {randomUUID} from 'node:crypto';
import {readJob,searchJobs} from '../job-documents.mjs';
import {resolveTicket,printIQJobKey} from '../job-tickets.mjs';
import {PrintIQ} from '../printiq.mjs';
const now=new Date('2026-11-22T20:00:00Z'); // Monday 07:00 at the plant
const stamp=now.toISOString();
const fixture=(state='open')=>({schema:3,asOf:stamp,generatedAt:stamp,history:[{entry:'q',job:'J064500'}],jobs:[{job:'J064500',state,due:'2026-11-24',name:'Brochure',printiqId:1,
  runs:state==='open'?[{id:'automatic',part:'Text',stock:'20415 320x450',minutes:40,finishes:'Trim',operation:'exact',operationKey:'123'}]:[]}]});
function setup(t){const s=new Store();t.after(()=>s.close());s.put('indigoPlannerConfig',{id:'indigo',enabled:true});return s;}
const monday='2026-11-23',tuesday='2026-11-24',indigo='HP Indigo 7900';
test('status refresh looks up the underlying job and honours its previously linked printIQ ID',async t=>{
 const s=setup(t),reader=new PrintIQ({active:'7'}),record={id:'J064500',printiqId:42,active:false};
 s.put('job',record);reader.call=async()=>({value:[{JobNo:'064500',Id:42,ProductionStatusId:7}]});
 assert.equal((await reader.refresh(s,'064500a')).active,true);
 reader.call=async()=>({value:[{JobNo:'J064500',Id:43,ProductionStatusId:7}]});
 await assert.rejects(reader.refresh(s,'J064500B'),/job ID has changed/);
 assert.equal(s.get('job','J064500').printiqId,42);
});
test('a designer reference on an active hold or running operation blocks another booking for the same printIQ job',t=>{
 for(const [kind,item] of [['hold',{id:'hold'}],['operation',{id:'op',state:'running',printiqOperationKey:123}]]){
   const s=setup(t);s.put(kind,{...item,job:'064500b'});planHourly(s,fixture(),now);
   assert.equal(s.all('printPlanRun').length,0);
   assert.equal(hourlySummary(s,now).review.length,1);
 }
});
test('exact printIQ lookup accepts both number forms and one design letter and preserves numeric parts',async()=>{
 const iq={call:async path=>{
   const filter=new URL('https://example.invalid/'+path).searchParams.get('$filter');
   assert.equal(filter,"(JobNo eq 'J000123-01' or JobNo eq '000123-01')");
   return {value:[{Id:42,JobNo:'000123-01'}]};
 }};
 for(const number of ['J000123-01','000123-01','J000123-01b','000123-01A']){
   assert.equal((await readJob(iq,number,42)).id,'J000123-01');
 }
 await assert.rejects(readJob(iq,'000123-01A',43),/reference/);
 assert.equal(printIQJobKey('000123B'),'J000123');
 for(const malformed of ['000123AB','X000123','0001234','file_000123A','J000123A-01']){
   assert.equal(printIQJobKey(malformed),null);
 }
 const ambiguous={call:async()=>({value:[{JobNo:'000123',Id:1},{JobNo:'J000123',Id:2}]})};
 await assert.rejects(readJob(ambiguous,'000123B',1),/ambiguous/);
});
test('directory and standalone scans match the job while linked numeric operation barcodes still resolve',async t=>{
 const s=setup(t),calls=[],iq={call:async p=>{calls.push(new URL('https://example.invalid/'+p).searchParams.get('$filter'));return {value:[{JobNo:'064500',Id:1}]};}};
 assert.equal((await searchJobs(iq,'064500b',null)).jobs[0].id,'J064500');
 assert.ok(calls[0].includes("JobNo eq 'J064500' or JobNo eq '064500'"));
 assert.equal((await resolveTicket(s,'064500B',iq)).job,'J064500');
 s.put('job',{id:'JOTHER',sections:[{id:'s'}]});s.put('operation',{id:'064500',section:'s',job:'JOTHER'});
 assert.equal((await resolveTicket(s,'064500',iq)).operation,'064500');
});
function booking(minutes, props={}) {
 return {id:randomUUID(),job:'J200',printiqId:null,press:indigo,day:monday,due:monday,stock:'A',finishes:'Trim',minutes,fixedStart:null,part:'Text',...props};
}
test('Indigo books 80% after startup and shutdown, counting each existing booking once',()=>{
 const old=booking(400,{fixedStart:490}),run=booking(36);
 const rows=[old,booking(60,{removed:true}),booking(480,{press:'Ryobi 755'}),booking(20,{day:tuesday})];
 assert.deepEqual(indigoCapacity(rows,monday,indigo),{shiftStart:420,shiftEnd:1020,printStart:465,printEnd:1010,limitMinutes:436,bookedMinutes:400});
 assert.equal(choosePrintDay(run,rows,now),monday);
 assert.throws(()=>choosePrintDay({...run,minutes:37},rows,now),/80%/);
 assert.equal(choosePrintDay({...run,minutes:37,due:tuesday},rows,now),tuesday);
 assert.throws(()=>choosePrintDay(booking(437),[],now),/436/);
 assert.equal(choosePrintDay(booking(480,{press:'Ryobi 755'}),[],now),monday);
});
test('Indigo can print before 08:00 and after 16:00 but leaves warm-up and shutdown free',()=>{
 const [first]=sequencePressDay([booking(436)]);assert.deepEqual([first.start,first.end],[465,901]);
 const lastMinute=new Date('2026-11-23T05:49:00Z');
 assert.equal(choosePrintDay(booking(1),[],lastMinute),monday);
 assert.throws(()=>choosePrintDay(booking(2),[],lastMinute),/No automatic slot/);
 assert.equal(sequencePressDay([booking(2,{earliestStart:1009})])[0].start,null);
});
test('manual bookings share the cap and exact print window; reductions to legacy overbookings are accepted',t=>{
 const s=setup(t),manager={role:'manager',id:'manager'},job=s.put('job',{id:'J200',name:'Test',active:true,due:monday});
 const save=(row,revision=0)=>savePrintRun(s,manager,randomUUID(),{...row,revision},job);
 assert.throws(()=>save(booking(1,{fixedStart:464})),/07:45/);
 assert.throws(()=>save(booking(2,{fixedStart:1009})),/16:50/);
 const pinned=save(booking(435,{fixedStart:465}));
 const last=save(booking(1,{fixedStart:1009}));
 assert.throws(()=>save(booking(1)),/436/);
 save({...last,remove:true},1);
 save({...pinned,minutes:436},1);
 const legacy=booking(10,{revision:1});s.put('printPlanRun',legacy);
 save({...legacy,minutes:9},1);
 assert.throws(()=>save({...legacy,minutes:10},2),/436/);
});
test('hourly intake respects manual reservations and carries work to the next day',t=>{
 const s=setup(t),f=fixture();s.put('printPlanRun',booking(400,{fixedStart:465}));
 planHourly(s,f,now);
 const auto=s.get('printPlanRun','automatic');assert.equal(auto.day,tuesday);assert.equal(auto.earliestStart,465);
});
test('unknown press modes give the scheduler the specific reason and do not reserve a slot',t=>{
 const s=setup(t),f=fixture(),item=f.jobs[0].runs[0];
 item.minutes=null;item.estimateIssue='Check Indigo front and reverse print modes';
 planHourly(s,f,now);
 assert.equal(hourlySummary(s,now).review[0].reason,item.estimateIssue);
 assert.equal(s.all('printPlanRun').length,0);
});
test('automatic intake schedules without any staff release, once per source generation',t=>{
 const s=setup(t),f=fixture();planHourly(s,f,now);const run=s.get('printPlanRun','automatic');assert.equal(run.day,'2026-11-23');assert.equal(s.all('indigoReadyRun').length,0);
 planHourly(s,f,now);assert.equal(s.get('printPlanRun','automatic').revision,1);assert.equal(s.all('operation').length,0);
 assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});
test('later completion and revoked approvals withdraw only unstarted automatically managed runs',t=>{
 for(const state of ['complete','Awaiting current artwork approval','other press']){
   const s=setup(t);planHourly(s,fixture(),now);const next=new Date(+now+30000);const f={...fixture(state),generatedAt:next.toISOString()};
   planHourly(s,f,next);assert.ok(s.get('printPlanRun','automatic').removed);assert.equal(hourlySummary(s,next).completed,state==='complete'?1:0);
   assert.equal(s.all('checkedPrintFinish').length,0);assert.equal(s.all('operation').length,0);
 }
});
test('historical output and cancelled jobs cannot enter production as approved work',t=>{
 const s=setup(t), f=fixture('complete');f.jobs.push({job:'J064501',state:'cancelled',runs:[]},{job:'J064502',state:'Indigo output needs reconciliation',runs:[]});
 planHourly(s,f,now);const a=hourlySummary(s,now);assert.equal(a.completed,1);assert.equal(a.review.length,1);assert.equal(s.all('printPlanRun').length,0);
});
test('holds, signed Finish, active timers, conflicting manual bookings and withdrawal are respected',t=>{
 for(const what of ['hold','finished','manual','withdrawn','running']){
   const s=setup(t);
   if(what==='hold')s.put('hold',{id:'hold',job:'J064500'});
   if(what==='finished')s.put('checkedPrintFinish',{id:'exact',active:true});
   if(what==='running')s.put('operation',{id:'timer',job:'J064500',printiqOperationKey:123,state:'running'});
   if(what==='manual')s.put('printPlanRun',{id:'other',job:'J064500',day:'2026-11-24',press:'HP Indigo 7900',stock:'paper',finishes:'Trim',fixedStart:500,minutes:40});
   if(what==='withdrawn')s.put('printPlanRun',{id:'automatic',job:'J064500',hourly:true,managerOverride:true,removed:true});
   planHourly(s,fixture(),now);assert.ok(!s.get('printPlanRun','automatic')||s.get('printPlanRun','automatic').removed,what);
 }
});
test('paused preview, stale input, chronology and source outages preserve booking history',t=>{
 const s=setup(t);s.put('indigoPlannerConfig',{id:'indigo',enabled:false});
 planHourly(s,fixture(),now);assert.equal(s.all('printPlanRun').length,0);assert.equal(hourlySummary(s,now).bookings.length,1);
 s.put('indigoPlannerConfig',{id:'indigo',enabled:true});planHourly(s,fixture(),now);
 const next=new Date(+now+15000);planHourly(s,{...fixture(),generatedAt:next.toISOString(),approvalError:'Prinect unavailable',jobs:[]},next);
 assert.ok(!s.get('printPlanRun','automatic').removed);planHourly(s,fixture('complete'),next);assert.ok(!s.get('printPlanRun','automatic').removed);
 assert.match(hourlySummary(s,new Date(+now+3*3600000)).state,/overdue/);
});

import {visibleFrom,hiddenJobs,rememberStatus,directoryCutoff} from '../job-visibility.mjs';
test('strict ten Melbourne workdays, weekends, holidays, and exact suffixes',t=>{
 const s=setup(t),fri=new Date('2026-11-20T01:00:00Z');
 assert.equal(visibleFrom(fri),'2026-11-06');assert.equal(visibleFrom(new Date('2026-11-21T02:00:00Z')),'2026-11-06');
 assert.equal(visibleFrom(new Date('2026-11-22T13:05:00Z')),'2026-11-09');
 assert.equal(directoryCutoff(fri),'(CompletedDate eq null or CompletedDate ge 2026-11-05T13:00:00.000Z)');
 assert.equal(visibleFrom(new Date('2027-01-05T01:00:00Z')),'2026-12-17');
 rememberStatus(s,{job:'J064500',printiqId:1,completedAt:'2026-11-05T12:59:59Z'},fri.toISOString());
 rememberStatus(s,{job:'J064500-01',printiqId:2,completedAt:'2026-11-05T13:00:00Z'},fri.toISOString());
 const hidden=hiddenJobs(s,fri);assert.equal(hidden('J064500',1),true);assert.equal(hidden('J064500-01',2),false);assert.equal(hidden('J064500',99),false);
});
test('undated Complete starts at first verification, reopening clears it and stale observations cannot re-hide it',t=>{
 const s=setup(t),stamp='2026-11-04T02:00:00Z',now=new Date('2026-11-20T02:00:00Z'),j={job:'J064500',printiqId:22,complete:true};
 rememberStatus(s,j,stamp);rememberStatus(s,j,'2026-11-15T02:00:00Z');assert.ok(hiddenJobs(s,now)(j.job));
 rememberStatus(s,{...j,complete:false},now.toISOString());rememberStatus(s,j,stamp);
 assert.equal(hiddenJobs(s,now)(j.job),false);assert.equal(s.get('jobVisibility',j.job).completedOn,null);
});
import {createServer} from '../server.mjs';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('old completed job is hidden across staff lists, default and inclusive search, scanned ticket and exact job page',async t=>{
 const s=setup(t),dir=mkdtempSync(join(tmpdir(),'visibility-')),old='J064500';
 const remote={Id:31,JobNo:old,JobTitle:'Past job',CompletedDate:'2019-01-02T04:00:00Z',DueDate:'2019-01-01',ProductionStatusId:21};
 let sent;const iq={token:'fixture',job:async()=>remote,call:async q=>{sent=new URL('https://test.invalid/'+q).searchParams;return {value:[remote]};}};
 const server=createServer(s,{mediaDir:dir,iq});t.after(()=>{server.close();rmSync(dir,{recursive:true,force:true});});
 const user=s.user('manager@example.test','example-password-123','manager');const token=s.login(user.email,'example-password-123').token;
 const get=url=>new Promise(resolve=>{
   const req=Readable.from([]);Object.assign(req,{url,method:'GET',headers:{host:'localhost',authorization:'Bearer '+token},socket:{remoteAddress:'127.0.0.1'}});
   let status;server.emit('request',req,{writeHead(n){status=n;},end(data){resolve({status,data:JSON.parse(data)});}});
 });
 s.put('job',{id:old,printiqId:31});s.put('sample',{id:'video',job:old});s.put('hold',{id:'hold',job:old});
 s.put('printPlanRun',{id:'run',job:old,printiqId:31,press:'HP Indigo 7900',day:'2019-01-01',fixedStart:480,minutes:20});
 assert.equal((await get('/api/resolve?printJob='+old+'&jobId=31')).status,404);
 for(const url of ['/api/resolve?jobs=','/api/resolve?jobs=&order=due&includeCompleted=1']){
   assert.equal((await get(url)).data.jobs.length,0);assert.match(sent.get('$filter'),/CompletedDate ge /);
 }
 const state=(await get('/api/state')).data;for(const field of ['jobs','samples','holds','printBookings'])assert.equal(state[field].length,0);
 assert.equal((await get('/api/resolve?ticket='+old)).status,404);
 assert.equal((await get('/api/press-results?jobNo='+old)).status,404);
 assert.ok(s.get('sample','video'));assert.ok(s.get('job',old));
});

const feedJob=(job,extra={})=>({job,state:'open',due:'2026-11-26',name:'Job '+job,printiqId:Number(job.slice(1)),rep:{name:'Sam Rep',email:'sam@sunnyland.test'},
  runs:[{id:'run-'+job,part:'Text',stock:'20415 320x450',minutes:60,finishes:'None',operation:'op-'+job,operationKey:'1'+job.slice(1)}],...extra});
const feedOf=jobs=>({schema:3,asOf:stamp,generatedAt:stamp,history:[],jobs});
const mails=s=>s.db.prepare("SELECT body FROM outbox WHERE channel='mail' ORDER BY created,id").all().map(r=>JSON.parse(r.body));

test('unapproved jobs due in the next five working days are pencilled in after approved work; older ones are not',t=>{
 const s=setup(t);
 planHourly(s,feedOf([feedJob('J000001'),feedJob('J000002',{state:'Awaiting current artwork approval',due:'2026-11-25'}),
   feedJob('J000003',{state:'Awaiting current artwork approval',due:'2026-12-04'}),feedJob('J000004',{state:'Awaiting current artwork approval',due:'2026-11-10'})]),now);
 const runs=Object.fromEntries(s.all('printPlanRun').map(r=>[r.job,r]));
 assert.deepEqual(Object.keys(runs).sort(),['J000001','J000002']);
 assert.equal(runs.J000002.provisional,true);assert.equal(runs.J000001.provisional,false);
 // Approved later: the same run firms up.
 planHourly(s,{...feedOf([feedJob('J000001'),feedJob('J000002',{due:'2026-11-25'})]),generatedAt:new Date(+now+60000).toISOString(),asOf:new Date(+now+60000).toISOString()},new Date(+now+120000));
 assert.equal(s.get('printPlanRun','run-J000002').provisional,false);
 assert.equal(mails(s).length,0);
});

test('a job that cannot make its due date is booked on the earliest day, flagged late, and the rep is emailed once',t=>{
 const s=setup(t);
 s.put('printPlanRun',{id:'full',job:'J000900',name:'Big job',press:indigo,day:monday,minutes:430,fixedStart:null,earliestStart:null,managerOverride:true});
 const f=feedOf([feedJob('J000010',{due:'2026-11-23'})]);
 planHourly(s,f,now);
 const run=s.get('printPlanRun','run-J000010');
 assert.equal(run.day,tuesday);assert.equal(run.late,true);assert.equal(run.bestDispatch,'2026-11-25');
 let sent=mails(s);
 assert.equal(sent.length,1);assert.equal(sent[0].to,'sam@sunnyland.test');
 assert.match(sent[0].subject,/J000010 .*best-case dispatch Wednesday 25 November \(due Monday 23 November\)/);
 assert.match(sent[0].text,/booked on the Indigo for Tuesday 24 November/);
 assert.match(hourlySummary(s,now).review.map(r=>r.reason).join(),/Late: printing 2026-11-24, best-case dispatch 2026-11-25/);
 // The next hourly pass with the same answer sends nothing new.
 const later=new Date(+now+3600000);
 planHourly(s,{...f,asOf:later.toISOString(),generatedAt:later.toISOString()},later);
 assert.equal(mails(s).length,1);
 // No rep email in printIQ: the managers get it.
 const t2=setup(t);t2.user('boss@sunnyland.test','a-long-test-password','manager','Boss');
 t2.put('printPlanRun',{id:'full',job:'J000900',name:'Big job',press:indigo,day:monday,minutes:430,fixedStart:null,earliestStart:null,managerOverride:true});
 planHourly(t2,feedOf([feedJob('J000011',{due:'2026-11-23',rep:null})]),now);
 sent=mails(t2);assert.equal(sent.length,1);assert.equal(sent[0].to,'boss@sunnyland.test');assert.match(sent[0].text,/No rep email/);
});
