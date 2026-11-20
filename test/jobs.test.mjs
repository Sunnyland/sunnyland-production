import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Store} from '../core.mjs';
import {PrintIQ} from '../printiq.mjs';
import {printedTicket, resolveTicket} from '../job-tickets.mjs';

const job='J064383', section='503000', id='fold-local', code=job+'|7768539.3';
function setup(t) {
 const s=new Store(); t.after(()=>s.close());
 const actor={id:'staff',role:'operator'}, manager={id:'rep',role:'manager'};
 s.put('user',{...actor,name:'Staff',enabled:true}); s.put('user',{...manager,email:'rep@example.test',enabled:true});
 for(const number of [job,'J064383-01'])s.put('job',{id:number,name:'Example',active:true,verifiedAt:new Date().toISOString(),rep:manager.id,sections:[{id:section,name:'Main',stocks:[]},{id:'other',name:'Cover',stocks:[]}]});
 const act=(type,data,key=randomUUID(),user=actor)=>s.action(user,key,type,data);
 const link={job,section,operation:id,code,name:'Folding',location:'Folder',unit:'sheets'};
 const transition=(state,revision,key)=>act('operation',{job,section,id,name:'Folding',location:'Folder',unit:'sheets',good:10,waste:1,state,revision},key);
 return {s,actor,manager,act,link,transition};
}

test('ticket scan and manual caption agree; lookup cannot start time or write a job',async t=>{
 const {s}=setup(t);
 const iq={token:'test',ticketOperation:async key=>{assert.equal(key,'7768539');return {QuoteDetailSectionId:Number(section)};}};
 assert.deepEqual(printedTicket(code),printedTicket(job+'|7768539'));
 assert.equal(printedTicket(job+'|7768539.4'),null);
 const first=await resolveTicket(s,code,iq); assert.deepEqual(first,{kind:'ticket',job,section,operationKey:'7768539',code:job+'|7768539'});
 assert.equal(s.all('operation').length,0); assert.equal(s.all('jobTicket').length,0);
 assert.deepEqual(await resolveTicket(s,'J064383-01',iq),{kind:'job',job:'J064383-01'});
 await assert.rejects(resolveTicket(s,'7768539',iq),/no linked/);
 const remote=await resolveTicket(s,'J000009-03|017.3',{job:async number=>({JobNo:number,JobTitle:'Test'})});
 assert.deepEqual(remote,{kind:'unregistered',job:'J000009-03',name:'Test'});
});

test('first scan binds once across staff, rejects competing links, wrong jobs and different printIQ IDs',async t=>{
 const {s,act,link,manager}=setup(t);
 assert.throws(()=>act('job_ticket_link',link),/manager/);
 assert.throws(()=>act('job_ticket_attach',{...link,job:'J064383-01'}),/for this job/);
 const result=act('job_ticket_attach',link,'link');assert.deepEqual(act('job_ticket_attach',link,'link'),result);
 assert.equal(s.get('operation',id).state,'ready');assert.equal(s.get('operation',id).printiqOperationKey,'7768539');
 assert.equal((await resolveTicket(s,code,{})).operation,id);
 assert.equal((await resolveTicket(s,job+'|7768539',{})).operation,id);
 assert.throws(()=>act('job_ticket_attach',{...link,operation:'duplicate',code:job+'|7768539'}),/another operation/);
 assert.throws(()=>act('job_ticket_attach',{...link,code:job+'|1234.3'}),/different printIQ/);
 assert.throws(()=>act('job_ticket_link',{...link,code:job+'|7768539.5'},'unsupported',manager),/unrecognised/);
 assert.equal(s.all('operation').length,1);
 act('job_ticket_link',{...link,code:'STATION0001'},'manager-link',manager);
 assert.equal((await resolveTicket(s,'STATION0001',{})).operation,id);
});

test('a repeat scan never double-starts; stop preserves seconds on hold; QC and quantities stay intact',t=>{
 const {s,act,link,transition}=setup(t);act('job_ticket_attach',link);
 const running=transition('running',0,'start');assert.deepEqual(transition('running',0,'start'),running);
 assert.throws(()=>transition('running',0,'double'),/changed/);
 s.put('operation',{...running,lastStartedAt:new Date(Date.now()-65000).toISOString()});
 s.put('hold',{id:'hold',job,section,releasedAt:null});const paused=transition('paused',1);
 assert.ok(paused.elapsedSeconds>=65 && paused.elapsedSeconds<=67);assert.equal(paused.printiqOperationKey,'7768539');
 assert.throws(()=>transition('running',2),/on hold/);s.put('hold',{id:'hold',job,section,releasedAt:new Date().toISOString()});
 const resumed=transition('running',2);assert.equal(resumed.elapsedSeconds,paused.elapsedSeconds);
 transition('paused',3);assert.throws(()=>transition('completed',4),/quality check/);
 act('qc',{operation:id,result:'pass',note:'Fold checked'});assert.equal(transition('completed',4).good,10);
});

test('sample versions stay attached; printIQ submission and approval reach the exact job once',async t=>{
 const {s,actor,manager,act,link}=setup(t);act('job_ticket_attach',link);
 s.put('media',{id:'m',owner:actor.id});
 const fields={job,section,operation:id,media:'m',title:'Fold',note:'Check panel'};
 assert.throws(()=>act('sample',{...fields,job:'J064383-01'}),/from this job/);
 const a=act('sample',fields,'sample-once');assert.deepEqual(act('sample',fields,'sample-once'),a);
 assert.throws(()=>act('sample',{...fields,section:'other',family:a.family}),/replacement/);
 const b=act('sample',{job,family:a.family,media:'m',title:'Fold revised',note:'Reviewed'});
 assert.equal(b.operation,id);assert.equal(b.section,section);assert.equal(b.version,2);
 act('decision',{id:b.id,state:'approved',note:'Pass'},'decision',manager);
 const entries=s.db.prepare("SELECT * FROM outbox WHERE channel='printiq' ORDER BY rowid").all();
 assert.deepEqual(entries.map(e=>JSON.parse(e.body).kind),['sample_submitted','sample_submitted','sample_decision']);
 const notes=[];
 const fetcher=async (url,options)=>{
   const u=new URL(url); let value;
   if (u.pathname.endsWith('/Jobs')) {assert.equal(u.searchParams.get('$filter'),"JobNo eq 'J064383'");value={value:[{Id:44,JobNo:job}]};}
   else if(options.method==='POST'){const saved=JSON.parse(options.body);assert.equal(saved.JobId,44);notes.push({...saved,Id:100+notes.length});value=notes.at(-1);}
   else value={value:notes.filter(n=>u.searchParams.get('$filter').includes(n.NoteValue.split('\n')[0]))};
   return {ok:true,json:async()=>value};
 };
 const iq=new PrintIQ({token:'test',write:true,noteType:1,user:'12345678-1234-1234-1234-123456789abc',fetcher});
 for(const e of entries) {assert.equal((await iq.deliver(e,s)).state,'accepted');assert.equal((await iq.deliver(e,s)).receipt.reconciled,true);}
 assert.equal(notes.length,3);assert.ok(notes[2].NoteValue.includes('sunnylandproduction://jobs/'+job+'/samples/'+b.id));
 assert.ok(notes[1].NoteValue.includes('Operation: Folding'));
});

test('read-only operation lookup checks the returned ID and never guesses membership',async()=>{
 const response=row=>async (url,opts)=>{assert.equal(opts.method,'GET');assert.equal(new URL(url).searchParams.get('$filter'),'Id eq 7768539');return {ok:true,json:async()=>({value:[row]})};};
 const iq=new PrintIQ({token:'test',fetcher:response({Id:7768539,QuoteDetailSectionId:503000})});
 assert.equal((await iq.ticketOperation('7768539')).QuoteDetailSectionId,503000);
 iq.fetcher=response({Id:21});await assert.rejects(iq.ticketOperation('7768539'),/different operation/);
});

test('authenticated HTTP handler separates stock from job tickets and rejects stale or unauthorised actions',async t=>{
 const {Readable}=await import('node:stream');
 const {createServer}=await import('../server.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const {s,act,link}=setup(t);
 const dir=mkdtempSync(join(tmpdir(),'ticket-http-'));
 const server=createServer(s,{mediaDir:dir});
 t.after(()=>{server.close();rmSync(dir,{recursive:true,force:true});});
 const pw='test-password-for-local-store';const user=s.user('scan@example.test',pw);
 const token=s.login(user.email,pw).token;
 async function call(url,token,body,headers={}) {
   const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
   req.url=url;req.method=body?'POST':'GET';req.headers={host:'localhost',...headers};
   if(token)req.headers.authorization='Bearer '+token;
   req.socket={remoteAddress:'127.0.0.1'};
   return new Promise(resolve=>{let status;server.emit('request',req,{writeHead(code){status=code;},end(bytes){resolve({status,data:JSON.parse(bytes)});}});});
 }
 const lookup='/api/resolve?ticket='+encodeURIComponent(code);
 assert.equal((await call(lookup,null)).status,401);
 assert.equal((await call('/api/state',token)).data.jobTicketsEnabled,true);
 s.put('stock',{id:code,name:'test stock'});const stock=await call('/api/resolve?code='+encodeURIComponent(code),token);
 assert.equal(stock.data.matches[0].id,code);
 act('job_ticket_attach',link);
 const operation=await call(lookup,token);assert.equal(operation.data.operation,id);
 assert.equal((await call(lookup+'&ticket=other',token)).status,400);
 const payload={type:'job_ticket_link',data:link};
 assert.equal((await call('/api/action',token,payload,{'idempotency-key':'operator'})).status,403);
});
