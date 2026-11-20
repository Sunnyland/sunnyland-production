import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {Store} from '../core.mjs';
import {readJob} from '../job-documents.mjs';
import {createServer} from '../server.mjs';
import {choosePrintDay, finishDay, pressDay, savePrintRun, searchDueJobs, sequencePressDay} from '../print-planning.mjs';

const press='Ryobi 755', day='2026-11-23';
const run=(id,updates={})=>({id,job:'J'+id,day,press,minutes:30,due:day,stock:'Silk',finishes:'Fold',fixedStart:null,...updates});
const raw=(id,due=day)=>({Id:id,JobNo:'J'+id,JobTitle:'Job '+id,DueDate:due,CompletedDate:null});

test('finish day uses Melbourne civil dates, including UTC boundaries and missing dates',()=>{
  assert.equal(finishDay('2026-11-22T13:00:00Z'),day);
  assert.equal(finishDay('2026-06-01T13:59:59Z'),'2026-06-01');
  assert.equal(finishDay('2026-06-01T14:00:00Z'),'2026-06-02');
  assert.equal(finishDay(day),day);assert.equal(finishDay(null),null);assert.equal(finishDay('2026-02-30'),null);
});

test('priority is required day, stock, finishes, then stable job identity; no due date goes last',()=>{
  const input=[run('5',{due:null}),run('3',{stock:' Silk ',finishes:'Trim'}),run('2'),run('1',{stock:'Board'}),run('4',{due:'2026-11-22',stock:'ZZ'})];
  const plan=sequencePressDay(input);
  assert.deepEqual(plan.map(r=>r.id),['4','1','2','3','5']);
  assert.deepEqual(plan.map(r=>r.start),[480,510,540,570,600]);
  assert.deepEqual(sequencePressDay(input.reverse()),plan);
});

test('fixed slots, short gaps, capacity and holds never yield overlapping automatic bookings',()=>{
  const fixed=run('2',{fixedStart:540,minutes:60});
  const plan=sequencePressDay([fixed,run('1',{minutes:100,due:'2026-11-22'}),run('3',{minutes:60}),run('4',{minutes:450}),run('5',{blocked:'Job on hold'})]);
  assert.deepEqual(plan.filter(r=>r.start!==null).map(r=>[r.id,r.start,r.end]),[['3',480,540],['2',540,600],['1',600,700]]);
  assert.equal(plan.find(r=>r.id==='4').start,null);
  assert.equal(plan.find(r=>r.id==='5').blocked,'Job on hold');
});

test('automatic day matches eligible stock then finishes within the finish deadline; preserves existing capacity',()=>{
  const now=new Date('2026-11-22T21:00:00Z'); // Monday 08:00 Melbourne
  const tue='2026-11-24',wed='2026-11-25',thu='2026-11-26';
  const target=run('1',{due:thu});
  const existing=[run('2',{stock:'Board'}),run('3',{day:tue,finishes:'Trim'}),run('4',{day:wed}),run('5',{day:thu,fixedStart:480,minutes:480})];
  assert.equal(choosePrintDay(target,existing,now),wed);
  assert.equal(choosePrintDay({...target,due:tue},existing,now),tue);
  assert.equal(choosePrintDay({...target,due:day},existing,now),day);
  assert.throws(()=>choosePrintDay({...target,due:day,minutes:481},existing,now),/No automatic slot/);
  assert.throws(()=>choosePrintDay({...target,due:null},existing,now),/required finish/);
  assert.throws(()=>choosePrintDay({...target,due:day},[],new Date('2026-11-23T04:59:00Z')),/No automatic slot/);
  assert.throws(()=>choosePrintDay({...target,due:'2026-11-22'},[],new Date('2026-11-21T02:00:00Z')),/No automatic slot/);
});

test('directory filters at the provider before paging, keeps tied dates stable, handles undated and completed jobs',async()=>{
  let sent, response={value:Array.from({length:26},(_,i)=>raw(i+1))};
  const iq={call:async path=>{sent=new URL('https://fixture.invalid/'+path).searchParams;return response;}};
  const query=new URLSearchParams({jobs:"O'Brien",from:'2026-11-22T13:00:00Z',until:'2026-11-23T13:00:00Z'});
  const first=await searchDueJobs(iq,query);
  assert.match(sent.get('$filter'),/DueDate ge 2026-11-22T13:00:00Z and DueDate lt 2026-11-23T13:00:00Z/);
  assert.match(sent.get('$filter'),/o''brien/);assert.match(sent.get('$filter'),/CompletedDate eq null/);
  assert.equal(sent.get('$orderby'),'DueDate asc,Id asc');
  assert.equal(first.jobs.length,25);query.set('cursor',first.nextCursor);response={value:[raw(26)]};
  assert.equal((await searchDueJobs(iq,query)).nextCursor,null);assert.match(sent.get('$filter'),/DueDate eq 2026-11-23T00:00:00Z and Id gt 25/);
  const all=new URLSearchParams({jobs:'',includeCompleted:'1'});
  assert.equal((await searchDueJobs(iq,all)).nextCursor,'undated:0');
  assert.doesNotMatch(sent.get('$filter'),/CompletedDate/);
  all.set('cursor','undated:0');response={value:[raw(99,null)]};
  assert.equal((await searchDueJobs(iq,all)).nextCursor,null);assert.match(sent.get('$filter'),/DueDate eq null/);
  all.set('cursor','invalid');await assert.rejects(searchDueJobs(iq,all),/Invalid finish date page/);
});

test('shared schedule authorizes managers, reconciles retries, refreshes exact remote identity and prevents stale edits',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'sunnyland-plan-')), db=join(dir,'test.sqlite'), store=new Store(db);
  const password='test-only-password!';
  const login=role=>{const u=store.user(role+'@example.test',password,role);return store.login(u.email,password).token;};
  const manager=login('manager'),operator=login('operator');
  let remote=raw(123),reads=0;
  const iq={token:'fixture',job:async n=>{reads++;return {...remote,JobNo:n};},call:async()=>({value:[remote]})};
  const server=createServer(store,{mediaDir:dir,iq});
  t.after(()=>{server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  async function call(url,token,body,key='key') {
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
    Object.assign(req,{url,method:body?'POST':'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost',authorization:'Bearer '+token,'idempotency-key':key}});
    return await new Promise(resolve=>{let status;server.emit('request',req,{writeHead(s){status=s;},end(b){resolve({status,data:JSON.parse(b)});}});});
  }
  const path='/api/action?printPlan=1', body={...run(randomUUID()),job:'J123',printiqId:123,revision:0,part:'Cover',fixedStart:525};
  assert.equal((await call(path,operator,body)).status,403);
  assert.equal((await call('/api/state','')).status,401);
  const saved=await call(path,manager,body);
  assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
  assert.deepEqual(await call(path,manager,body),saved);assert.equal(reads,1);
  assert.equal((await call(path,manager,{...body,minutes:90})).status,409);
  assert.equal((await call(path,manager,{...body,id:randomUUID()},'overlap')).status,409);
  assert.equal((await call(path,manager,body,'stale')).status,409);
  assert.equal((await call('/api/state',operator)).data.printBookings[0].part,'Cover');
  remote.DueDate='2026-11-24';
  const board='/api/resolve?pressPlanDay='+day+'&press='+encodeURIComponent(press);
  assert.equal((await call(board,operator)).data.runs[0].due,remote.DueDate);
  remote.CompletedDate=day;assert.equal((await call(board,operator)).data.runs[0].blocked,'Closed job');
  remote.JobNo='J123-02';assert.equal((await call(board,operator)).data.runs[0].blocked,'Check job reference');
  assert.equal((await call(path,manager,{...body,revision:1,remove:true},'remove')).status,200);
  assert.equal((await call(board,operator)).data.runs.length,0);
  assert.deepEqual(store.all('operation'),[]);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM outbox').get().n,0);
});

test('local jobs can be planned without printIQ and current holds/finish dates take effect',async t=>{
  const s=new Store();t.after(()=>s.close());
  const manager={id:'manager',role:'manager'},job=s.put('job',{id:'J123',name:'Brochure',due:day,active:true,sections:[]});
  const body={...run(randomUUID()),job:job.id,part:'Text',revision:0};
  savePrintRun(s,manager,'test',body,job);s.put('hold',{id:'hold',job:'J123',releasedAt:null});
  const [row]=await pressDay(s,{},day,press);assert.equal(row.start,null);assert.equal(row.blocked,'Job on hold');
  assert.throws(()=>savePrintRun(s,manager,'held',{...body,id:randomUUID(),autoDay:true},job),/hold/);
});

test('a lettered component opens the exact directory identity with its own finish date',async()=>{
  const data={...raw(123),JobNo:'J123-01a'};
  const iq={call:async path=>{assert.equal(new URL('https://example.test/'+path).searchParams.get('$filter'),"JobNo eq 'J123-01a'");return {value:[data]};}};
  assert.equal((await readJob(iq,data.JobNo,123)).id,'J123-01a');
  await assert.rejects(readJob({...iq,call:async()=>({value:[{...data,JobNo:'J123'}]})},data.JobNo,123),/reference/);
});

test('local date lookup uses exact jobs, excludes reassigned IDs and reads in provider-sized batches',async t=>{
  const {localJobDates}=await import('../print-planning.mjs');
  const store=new Store();t.after(()=>store.close());
  const number=i=>'J'+String(i).padStart(6,'0');
  for(let i=1;i<=27;i++)store.put('job',{id:number(i),printiqId:i===2?999:i});
  let pages=0;
  const iq={call:async q=>{
    const filter=new URL('https://example.test/'+q).searchParams.get('$filter');
    const ids=[...filter.matchAll(/JobNo eq 'J(\d+)'/g)].map(match=>Number(match[1]));
    const names=[...filter.matchAll(/JobNo eq '([^']+)'/g)].map(match=>match[1]);
    assert.ok(names.length<=20);
    assert.deepEqual(names,ids.flatMap(id=>[number(id),number(id).slice(1)]));
    pages++;return {value:ids.map(id=>({...raw(id),JobNo:number(id)}))};
  }};
  const dates=await localJobDates(store,iq);
  assert.equal(pages,3);assert.equal(dates.length,26);assert.ok(!dates.some(j=>j.id===number(2)));
  await assert.rejects(localJobDates(store,{call:async()=>({value:['J000001','000001'].map(JobNo=>({...raw(1),JobNo}))})}),/Ambiguous/);
});
