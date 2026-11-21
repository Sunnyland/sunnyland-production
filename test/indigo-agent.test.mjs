import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {Store} from '../core.mjs';
import {checkFinish,operationEvidence,routingFacts} from '../production-finishes.mjs';
import {indigoPlanner} from '../indigo-agent.mjs';
import {createServer} from '../server.mjs';
import {finishDay} from '../print-planning.mjs';

const now=new Date('2026-11-22T21:00:00Z'); // Monday 08:00 in Mildura
const manager={role:'manager',id:'manager'}, operator={role:'operator',id:'operator'}, rep={role:'rep',id:'rep'};
const source='PrintIQ.GetAcceptanceDetails', day='2026-11-23';
function accepted(jobNo,presses=[64],at=now.toISOString()) {
  return {jobNo,source,refreshStatus:'ok',fetchedAt:at,productStatus:'Preflight Ready',issues:[],acceptanceProductKey:1,productKey:2,
    acceptedSections:presses.map((_,i)=>({SectionKey:10+i,QuotedSectionKey:20+i,SectionTypeName:i?'Cover':'Text'})),
    printingOperations:presses.map((pressKey,i)=>({operationKey:300+i,acceptedSectionKey:10+i,quotedSectionKey:20+i,pressKey,pressName:pressKey===64?'HP Indigo 7900':'Ryobi 755 Press'}))};
}
function cache(jobs,at=now.toISOString()){return {schemaVersion:1,source,generatedAt:at,jobs,failures:[]};}
function setup(t,initial=[accepted('J123')]){
  const s=new Store(); t.after(()=>s.close());
  const state={cache:cache(initial),remote:new Map(),clock:now};
  const raw=n=>state.remote.get(n)??{Id:Number(n.slice(1)),JobNo:n,JobTitle:n,DueDate:day,CompletedDate:null};
  const iq={job:async n=>raw(n),call:async path=>{
    const filter=new URL('https://test.invalid/'+path).searchParams.get('$filter');
    return {value:[...filter.matchAll(/Id eq (\d+)/g)].map(m=>raw('J'+m[1]))};
  }};
  const opts={routing:()=>routingFacts(state.cache,state.clock.getTime()),clock:()=>state.clock};
  return {s,state,iq,opts,agent:indigoPlanner(s,iq,opts)};
}
function release(opts,job='J123',extra={}){return {id:randomUUID(),action:'release',productionReady:true,job,stock:'Silk',finishes:'Fold',minutes:30,part:'Text',
  operation:opts.routing().operations.find(op=>op.job===job)?.id,...extra};}
const enable=(agent,enabled=true,revision=0)=>agent.control(manager,randomUUID(),{action:'configure',enabled,revision});
test('acceptance and hardcopy proof never imply a Ryobi operator Finish; late entry retains three independent dates',t=>{
  const {s,opts}=setup(t,[accepted('J123',[71,71]),accepted('J123-01a',[71])]);
  const f=opts.routing(),[text,cover,sibling]=f.operations;
  s.put('sample',{id:'historical-proof',job:'J123',state:'approved'});
  s.put('operation',{id:'other',job:'J123-01',state:'completed',printiqOperationKey:text.operationKey,updatedAt:now.toISOString()});
  assert.ok(operationEvidence(s,f).every(op=>!op.source));
  const body={action:'confirm',job:'J123',operation:cover.id,revision:0,printedOn:'2020-11-19',finishedOn:'2020-11-20'};
  assert.throws(()=>checkFinish(s,rep,'rep',body,f),/operator or manager/);
  assert.throws(()=>checkFinish(s,operator,'date',{...body,printedOn:'2020-02-31'},f),/print date/);
  assert.throws(()=>checkFinish(s,operator,'future',{...body,finishedOn:'2999-01-01'},f),/Finish/);
  assert.throws(()=>checkFinish(s,operator,'inverted',{...body,printedOn:'2020-11-21'},f),/print date/);
  assert.throws(()=>checkFinish(s,operator,'sibling',{...body,operation:sibling.id},f),/exact accepted/);
  const saved=checkFinish(s,operator,'confirm',body,f);
  assert.deepEqual(checkFinish(s,operator,'confirm',body,f),saved);
  const rows=operationEvidence(s,f);
  assert.equal(rows[0].source,null);assert.equal(rows[2].source,null);
  assert.equal(rows[1].source,'staffCheck');assert.equal(rows[1].printedOn,'2020-11-19');
  assert.equal(rows[1].finishedOn,'2020-11-20');assert.equal(finishDay(rows[1].at),finishDay(new Date().toISOString()));
  const stale=routingFacts(null),old=operationEvidence(s,stale)[0];
  assert.ok(old.earlier);assert.ok(!old.fresh);
  const remove={...body,revision:1,action:'withdraw'};
  assert.throws(()=>checkFinish(s,{...operator,id:'someone-else'},'withdraw',remove,stale),/author/);
  checkFinish(s,manager,'withdraw',remove,stale);
  assert.equal(operationEvidence(s,stale).length,0);
  assert.equal(s.get('sample','historical-proof').state,'approved');
  assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});
test('existing app Finish needs the exact job and operation; ambiguous duplicate timers give no Finish',t=>{
  const {s,opts}=setup(t);const facts=opts.routing(),op=facts.operations[0];
  const app={id:'timer',job:op.job,state:'completed',printiqOperationKey:Number(op.operationKey),updatedAt:now.toISOString(),actor:'operator'};
  s.put('operation',{...app,state:'paused'});assert.equal(operationEvidence(s,facts)[0].source,null);
  s.put('operation',app);assert.equal(operationEvidence(s,facts)[0].source,'appFinish');
  s.put('operation',{...app,id:'second',state:'running'});assert.equal(operationEvidence(s,facts)[0].source,null);
  s.put('operation',{...app,id:'second'});assert.equal(operationEvidence(s,facts)[0].source,null);
});
test('paused agent previews and then books each release once across simultaneous ticks and restarts',async t=>{
  const {s,opts,agent,iq}=setup(t);
  const body=release(opts);
  await assert.rejects(agent.control(operator,'no',body),/manager/i);
  const queued=await agent.control(manager,'release',body);
  assert.deepEqual(await agent.control(manager,'release',body),queued);
  await assert.rejects(agent.control(manager,'duplicate',{...body,id:randomUUID()}),/already in the Indigo/);
  assert.equal((await agent.dashboard()).rows[0].day,day);
  await agent.tick();assert.equal(s.all('printPlanRun').length,0);
  await enable(agent);await Promise.all([agent.tick(),indigoPlanner(s,iq,opts).tick()]);
  await indigoPlanner(s,iq,opts).tick();
  assert.equal(s.all('printPlanRun').length,1);
  assert.equal(s.all('printPlanRun')[0].press,'HP Indigo 7900');
  assert.equal(s.all('indigoReadyRun')[0].state,'scheduled');
  assert.equal(s.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});
test('never infer Indigo from proofs, closed/ambiguous/stale routing or an unselected section',async t=>{
  const {s,opts,state,agent}=setup(t,[accepted('J123',[71]),accepted('J124',[71,64])]);
  s.put('sample',{id:'proof',job:'J123',state:'approved'});
  await assert.rejects(agent.control(manager,'ryobi',release(opts)),/another press/);
  await assert.rejects(agent.control(manager,'unnamed',release(opts,'J124',{operation:null})),/exact Indigo/);
  const exact=opts.routing().jobs.get('J124').operations[1].id;
  await agent.control(manager,'mixed',release(opts,'J124',{operation:exact}));
  state.cache.jobs[1].printingOperations[1].pressKey=71;
  await enable(agent);await agent.tick();assert.equal(s.all('printPlanRun').length,0);
  assert.match((await agent.dashboard()).rows[0].reason,/another press/);
  state.cache.jobs[0].productStatus='Complete';
  await assert.rejects(agent.control(manager,'closed',release(opts)),/closed/);
  state.cache.jobs[0].issues=['ambiguous'];
  await assert.rejects(agent.control(manager,'issues',release(opts)),/Refresh accepted/);
  state.clock=new Date(now.getTime()+20*60_000);
  await assert.rejects(agent.control(manager,'stale',release(opts,'J125',{operation:null})),/current routing cache/);
});
test('explicit manager assignment for a job outside cache is checked again when accepted routing arrives',async t=>{
  const {s,opts,state,agent}=setup(t,[]);
  await assert.rejects(agent.control(manager,'guess',release(opts,'J124',{productionReady:false})),/ready/);
  await agent.control(manager,'signed',release(opts,'J124',{operation:null}));
  state.cache.jobs.push(accepted('J124',[71]));
  await enable(agent);await agent.tick();assert.equal(s.all('printPlanRun').length,0);
  assert.match((await agent.dashboard()).rows[0].reason,/exact Indigo/);
});
test('holds, started runs, completion, new manual bookings, full shifts and job closure block release at publication',async t=>{
  for(const condition of ['hold','started','finished','manual','capacity','closed','due']){
    const {s,state,opts,agent}=setup(t); const body=release(opts);
    await agent.control(manager,'release',body);
    if(condition==='hold')s.put('hold',{id:'h',job:body.job});
    if(condition==='started'||condition==='finished')s.put('operation',{id:'op',state:condition==='started'?'running':'completed',updatedAt:now.toISOString(),job:'J123',printiqOperationKey:'300'});
    if(condition==='manual'||condition==='capacity')s.put('printPlanRun',{id:'manual',job:condition==='capacity'?'J999':'J123',press:'HP Indigo 7900',day,due:day,minutes:480,fixedStart:480,stock:'X',finishes:'None'});
    if(condition==='closed'||condition==='due')state.remote.set('J123',{Id:123,JobNo:'J123',JobTitle:'Test',DueDate:condition==='due'?null:day,CompletedDate:condition==='closed'?day:null});
    await enable(agent);await agent.tick();
    assert.ok((await agent.dashboard()).rows[0].reason,condition);assert.equal(s.get('printPlanRun',body.id),null,condition);
  }
});
test('due date precedes stock and finishes under contention for a shift',async t=>{
  const {s,state,opts,agent}=setup(t,[]);
  const groups=[['J101','2026-11-24','Board','Cut'],['J102',day,'Silk','Trim'],['J103',day,'Silk','Fold'],['J104',day,'Board','Trim']];
  for(const [job,due,stock,finishes] of groups){
    state.remote.set(job,{Id:Number(job.slice(1)),JobNo:job,DueDate:due,CompletedDate:null});
    await agent.control(manager,job,release(opts,job,{stock,finishes,operation:null,minutes:240}));
  }
  const rows=(await agent.dashboard()).rows;
  // Equal deadlines: the run with more finishing goes first (Trim 120 min before Fold 60 min).
  assert.deepEqual(rows.map(r=>r.job),['J104','J102','J103','J101']);
  assert.deepEqual(rows.map(r=>r.day),[day,null,null,'2026-11-24']);
  assert.ok(rows.filter(r=>!r.day).every(r=>r.reason.includes('80%')));
  await enable(agent);await agent.tick();assert.equal(s.all('printPlanRun').length,2);
});
test('staff API scopes exact operation confirmation and manager-only Indigo controls',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'indigo-api-')),s=new Store(),file=join(dir,'routing.json');
  const stamp=new Date().toISOString();writeFileSync(file,JSON.stringify(cache([accepted('J123',[71],stamp)],stamp)),{mode:0o640});
  const server=createServer(s,{mediaDir:dir,requirementsFile:file,iq:{token:'fixture'}});
  t.after(()=>{server.close();s.close();rmSync(dir,{recursive:true,force:true});});
  const login=role=>{const password='test-only-password!';const u=s.user(role+'@example.test',password,role);return s.login(u.email,password).token;};
  const rep=login('rep'),op=login('operator'),manager=login('manager');
  async function request(url,token,body){
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
    Object.assign(req,{url,method:body?'POST':'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'localhost',authorization:'Bearer '+token,'idempotency-key':randomUUID()}});
    return new Promise(resolve=>{let status;server.emit('request',req,{writeHead(s){status=s;},end(b){resolve({status,data:JSON.parse(b)});}});});
  }
  const dashboard='/api/resolve?indigoPlanner=1', check='/api/action?checkedPrintFinish=1';
  assert.equal((await request(dashboard,'')).status,401);assert.equal((await request(dashboard,rep)).status,403);
  assert.equal((await request(dashboard,manager)).data.enabled,false);
  const opRow=(await request('/api/state',op)).data.productionOperations[0];
  const body={action:'confirm',job:'J123',operation:opRow.id,revision:0,finishedOn:'2020-11-20'};
  assert.equal((await request(check,rep,body)).status,403);assert.equal((await request(check,op,body)).status,200);
  assert.equal((await request('/api/state',rep)).data.productionOperations[0].source,'staffCheck');
});
