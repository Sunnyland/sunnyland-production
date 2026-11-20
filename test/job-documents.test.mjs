import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../core.mjs';
import {PrintIQ} from '../printiq.mjs';
import {createServer} from '../server.mjs';
import {searchJobs} from '../job-documents.mjs';
import {jobNoteLines} from '../job-tickets.mjs';

const job='J000123-01', id=301, key='clip-key-001';
const bytes=Buffer.from([0,0,0,20,102,116,121,112,113,116,32,32,0,0,0,0,113,116,32,32]);
const remote=(n=301)=>({Id:n,JobNo:n===id?job:'J'+n,JobTitle:"Fold O'Brien",Quantity:500,DueDate:'2026-11-30T00:00:00Z',CompletedDate:null});

test('printIQ directory escapes search, pages without overlap and returns only production details',async()=>{
 let params;let rows=Array.from({length:26},(_,i)=>({...remote(310-i),Price:45,CustomerName:'Private'}));
 const iq={call:async path=>{params=new URL('https://example.test/'+path).searchParams;return {value:rows};}};
 const first=await searchJobs(iq," O'Brien ",null);
 assert.ok(params.get('$filter').includes("o''brien"));assert.equal(params.get('$orderby'),'Id desc');
 assert.equal(first.jobs.length,25);assert.equal(first.nextBefore,286);assert.equal(first.jobs[0].Price,undefined);
 rows=[remote(285)];const next=await searchJobs(iq," O'Brien ",'286');assert.ok(params.get('$filter').includes('Id lt 286'));
 assert.equal(next.jobs[0].printiqId,285);assert.equal(next.nextBefore,null);
 await assert.rejects(searchJobs(iq,'x','invalid'));
 rows=[remote(301),remote(301)];await assert.rejects(searchJobs(iq,'',null),/page order/);
});

function fixture(t) {
 const store=new Store(), directory=mkdtempSync(join(tmpdir(),'sunny-job-movies-'));
 const account=store.user('operator@example.test','example-test-password','operator');
 const rep=store.user('rep@example.test','example-test-password','rep');
 const login=u=>store.login(u.email,'example-test-password').token;
 const first=login(account), second=login(rep);
 let reads=0;
 const iq={token:'test',job:async number=>{reads++;assert.equal(number,job);return remote();},
   call:async path=>{
     const filter=new URL('https://example.invalid/'+path).searchParams.get('$filter')??'';
     if(filter.includes('JobNo eq')) {
       assert.equal(filter,"(JobNo eq 'J000123-01' or JobNo eq '000123-01')");
       return {value:[await iq.job(job)]};
     }
     return {value:[remote()]};
   }};
 const server=createServer(store,{iq,mediaDir:directory});
 t.after(()=>{server.close();store.close();rmSync(directory,{recursive:true,force:true});});
 async function call(url,{body,token=first,headers={}}={}) {
   const req=Readable.from(body?[body]:[]);req.method=body?'POST':'GET';req.url=url;req.socket={remoteAddress:'127.0.0.1'};
   req.headers={host:'localhost',authorization:'Bearer '+token,...headers};
   return await new Promise(resolve=>{let status,ht;server.emit('request',req,{writeHead(s,h){status=s;ht=h;},
      end(b){resolve({status,data:ht['Content-Type']==='application/json'?JSON.parse(b):b});}});});
 }
 const post=(options={})=>call('/api/media?jobVideo='+job+'&jobId='+(options.jobId??id)+(options.rep===undefined?'':'&rep='+options.rep),{
   body:options.body??bytes,token:options.token,headers:{'content-type':options.mime??'video/quicktime','idempotency-key':key,
     'x-video-title':Buffer.from(options.title??'How the document folds').toString('base64')}});
 return {store,directory,account,rep,first,second,call,post,iq,reads:()=>reads};
}

test('two simultaneous uploads attach one protected video to an exact printIQ job without local setup',async t=>{
 const f=fixture(t);const [a,b]=await Promise.all([f.post(),f.post()]);
 assert.equal(a.status,201);assert.deepEqual(b.data,a.data);assert.equal(a.data.printiqId,id);
 assert.equal(f.store.all('job').length,0);assert.equal(f.store.all('media').length,1);
 assert.deepEqual(readdirSync(f.directory),[a.data.media]);
 const detail=await f.call('/api/resolve?printJob='+job+'&jobId='+id,{token:f.second});
 assert.deepEqual(detail.data.videos,[a.data]);assert.equal(detail.data.job.quantity,500);
 const down=await f.call('/api/media/'+a.data.media,{token:f.second});assert.deepEqual(down.data,bytes);
 const queued=f.store.db.prepare('SELECT * FROM outbox').all();assert.equal(queued.length,1);
 const event=JSON.parse(queued[0].body);assert.equal(event.job,job);
 assert.ok(jobNoteLines(event).join('').includes('sunnylandproduction://jobs/'+job+'/videos/'+a.data.id));
 assert.equal((await f.call('/api/resolve?jobs=',{token:'invalid'})).status,401);
 f.store.put('user',{...f.rep,enabled:false});
 assert.equal((await f.call('/api/media/'+a.data.id,{token:f.second})).status,401);
});

test('retries survive a printIQ outage without duplicates and changed recordings are rejected',async t=>{
 const f=fixture(t);const saved=await f.post();assert.equal(saved.status,201);
 f.iq.job=()=>{throw new Error('Disconnected');};
 assert.deepEqual((await f.post()).data,saved.data);
 assert.equal((await f.post({title:'Different intent'})).status,409);
 assert.equal((await f.post({body:Buffer.concat([bytes,Buffer.of(9)])})).status,409);
 assert.equal(f.store.all('jobVideo').length,1);
});

test('reject wrong job, invalid file, revoked user and anonymous access before recording or queueing',async t=>{
 const f=fixture(t);
 assert.equal((await f.post({jobId:302})).status,409);
 assert.equal((await f.post({body:Buffer.from('invalid')})).status,400);
 assert.equal((await f.post({mime:'image/jpeg'})).status,415);
 assert.equal((await f.post({token:'invalid'})).status,401);
 f.iq.job=async()=>{f.store.put('user',{...f.account,enabled:false});return remote();};
 assert.equal((await f.post()).status,401);
 assert.deepEqual(readdirSync(f.directory),[]);assert.equal(f.store.all('media').length,0);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});

test('note delivery stops before a write if printIQ reassigns the job number',async t=>{
 const f=fixture(t);await f.post();const entry=f.store.db.prepare('SELECT * FROM outbox').get();
 const calls=[];
 const iq=new PrintIQ({write:true,token:'test',noteType:1,user:'12345678-1234-1234-1234-123456789abc',
   fetcher:async(url,opts)=>{calls.push(opts.method);return {ok:true,json:async()=>({value:[{Id:444,JobNo:job}]})};}});
 await assert.rejects(iq.deliver(entry,f.store),/job ID has changed/);assert.deepEqual(calls,['GET']);
});

test('recording with an explicit rep publishes the exact same media to Samples and schedules one rep alert on replay',async t=>{
 const f=fixture(t);
 const bystander=f.store.user('colleague@example.test','example-test-password','operator');
 const viewer=f.store.login(bystander.email,'example-test-password').token;
 const registration=await f.call('/api/action?pushDevice=1',{token:f.second,body:Buffer.from(JSON.stringify({installation:'11111111-1111-4111-8111-111111111111',token:'ab'.repeat(32)}))});
 assert.equal(registration.status,200);
 const saved=await f.post({rep:f.rep.id});assert.equal(saved.status,201);
 const replay=await f.post({rep:f.rep.id});assert.deepEqual(replay.data,saved.data);
 assert.equal((await f.post({rep:''})).status,409);
 const board=(await f.call('/api/state',{token:viewer})).data.samples;
 assert.equal(board.length,1);assert.equal(board[0].media,saved.data.id);assert.equal(board[0].rep,f.rep.id);
 assert.deepEqual((await f.call('/api/media/'+board[0].media,{token:viewer})).data,bytes);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM sample_alerts').get().n,1);
 assert.equal((await f.call('/api/logout',{token:f.second,body:Buffer.from(JSON.stringify({installation:'11111111-1111-4111-8111-111111111111'}))})).status,200);
 assert.equal(f.store.db.prepare('SELECT count(*) n FROM push_devices').get().n,0);
});

test('rejects an ineligible reviewer without leaving an uploaded video or sample',async t=>{
 const f=fixture(t);const failed=await f.post({rep:f.account.id});
 assert.equal(failed.status,400);assert.deepEqual(readdirSync(f.directory),[]);
 assert.equal(f.store.all('sample').length,0);assert.equal(f.store.all('jobVideo').length,0);
});
