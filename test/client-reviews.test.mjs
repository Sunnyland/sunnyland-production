import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable, Writable} from 'node:stream';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Store} from '../core.mjs';
import {createServer} from '../server.mjs';

const origin='https://printcrm.sunnyland.com.au';
function fixture(t) {
  const store=new Store(), dir=mkdtempSync(join(tmpdir(),'slp-client-review-'));
  const sample=randomUUID(), media=randomUUID(), family=randomUUID();
  const bytes=Buffer.concat([Buffer.from([0,0,0,20]),Buffer.from('ftypqt  review data')]);
  writeFileSync(join(dir,media),bytes);
  const user=(name,role)=>{
    const u=store.user(name+'@example.invalid','long-test-password-123',role,name);
    return {...u,token:store.login(u.email,'long-test-password-123').token};
  };
  const rep=user('rep','rep'), creator=user('maker','operator'), other=user('other','rep');
  store.put('media',{id:media,mime:'video/quicktime',bytes:bytes.length,owner:creator.id});
  store.put('sample',{id:sample,family,media,version:1,title:'Fold sample',note:'Private internal note',
    rep:rep.id,creator:creator.id,job:'J145',state:'pending'});
  const messages=[], settings={enabled:true,approval:true,mail:async entry=>{
    messages.push(JSON.parse(entry.body));return {state:'accepted'};
  }};
  const server=createServer(store,{reviews:settings,mediaDir:dir,allowedPeers:null});
  t.after(()=>{server.close();store.close();rmSync(dir,{recursive:true,force:true});});
  function request(path,{actor,body,headers={},method=body?'POST':'GET'}={}) {
    const req=Readable.from(body?[Buffer.from(JSON.stringify(body))]:[]);
    req.method=method;req.url=path;req.socket={remoteAddress:'127.0.0.1'};
    req.headers={host:'printcrm.sunnyland.com.au',...(actor?{authorization:'Bearer '+actor.token}:{}),
      ...(body?{origin,'content-type':'application/json'}:{}),...headers};
    return new Promise((resolve,reject)=>{
      const chunks=[];const res=new Writable({write(chunk,encoding,done){chunks.push(Buffer.from(chunk));done();}});
      res.writeHead=(status,h)=>{res.status=status;res.headers=h;return res;};
      res.once('error',reject);res.once('finish',()=>{
        const buf=Buffer.concat(chunks),text=buf.toString();
        resolve({status:res.status,headers:res.headers,bytes:buf,text,
          data:text && res.headers?.['Content-Type']?.includes('application/json')?JSON.parse(text):null});
      });
      server.emit('request',req,res);
    });
  }
  const body={action:'create',sample,mode:'approval',email:'client@example.invalid',contact:'+61 400 123 456',question:'Please check the fold.'};
  const create=(data=body,actor=rep,key=randomUUID())=>request('/api/client-reviews',{actor,body:data,headers:{'idempotency-key':key}});
  async function open(row) {
    const link=new URL(row.url);
    const result=await request(link.pathname+'open',{body:{token:link.hash.slice(1)}});
    assert.equal(result.status,200,result.text);
    return {path:link.pathname,headers:{cookie:result.headers['Set-Cookie'].split(';')[0]},result};
  }
  return {store,sample,media,bytes,family,rep,creator,other,messages,settings,body,request,create,open};
}

test('staff creates a single versioned link reusable in Mail and Messages; only assigned staff may manage it',async t=>{
  const f=fixture(t), key=randomUUID();
  assert.equal((await f.create(f.body,f.other)).status,403);
  assert.equal((await f.create(f.body,f.creator)).status,403);
  const first=(await f.create(f.body,f.rep,key)).data;
  assert.equal((await f.create(f.body,f.rep,key)).data.url,first.url);
  assert.equal((await f.create({...f.body,mode:'view'},f.rep,key)).status,409);
  assert.equal(f.messages.length,0);
  const staff=(await f.request('/api/client-reviews?sample='+f.sample,{actor:f.rep})).data;
  assert.equal(staff.reviews[0].url,first.url);
  const production=(await f.request('/api/client-reviews?sample='+f.sample,{actor:f.creator})).data;
  assert.equal(production.reviews.length,1);assert.equal(production.reviews[0].url,undefined);
  assert.equal(production.reviews[0].email,undefined);
  assert.equal((await f.request('/api/client-reviews?sample='+f.sample)).status,401);
  const coworker=await f.request('/api/client-reviews?sample='+f.sample,{actor:f.other});
  assert.equal(coworker.status,200);assert.equal(coworker.data.canManage,false);assert.equal(coworker.data.reviews[0].url,undefined);
  const {path,headers,result}=await f.open(first);
  assert.match(result.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
  assert.equal(result.data.title,'Fold sample');assert.equal(result.data.email,undefined);
  assert.ok(!result.text.includes('Private internal note'));
  assert.equal((await f.request(path+'media')).status,403);
  const partial=await f.request(path+'media',{headers:{...headers,range:'bytes=4-7'}});
  assert.equal(partial.status,206);assert.equal(partial.text,'ftyp');
  assert.equal((await f.request(path+'media',{headers:{...headers,range:'bytes=800-'}})).status,416);
  const head=await f.request(path+'media',{headers,method:'HEAD'});
  assert.equal(head.status,200);assert.equal(head.bytes.length,0);
  assert.equal((await f.request('/api/state',{headers})).status,401);
  const html=await f.request(path);assert.equal(html.status,200);assert.ok(html.text.includes('Sunnyland Press'));
  assert.equal((await f.request('/sample-review/review.js')).status,200);
  assert.equal((await f.request('/sample-review/review.css')).status,200);
});

test('email verification binds the client decision to a single invitation, sample version and recorded recipient',async t=>{
  const f=fixture(t), row=(await f.create()).data, {path,headers}=await f.open(row);
  const decision={result:'changes_requested',comment:'Fold short panel inwards',code:'00000000'};
  assert.equal((await f.request(path+'decision',{body:decision,headers})).status,403);
  assert.equal((await f.request(path+'code',{body:{},headers:{...headers,origin:'https://example.invalid'}})).status,403);
  assert.equal((await f.request(path+'code',{body:{to:'another@example.invalid'},headers})).status,200);
  assert.equal(f.messages.length,1);assert.equal(f.messages[0].to,f.body.email);
  assert.equal((await f.request(path+'code',{body:{},headers})).status,429);
  decision.code=f.messages[0].code;
  const second=(await f.create({...f.body,email:'another@example.invalid'})).data;
  const b=await f.open(second);
  assert.equal((await f.request(b.path+'decision',{body:decision,headers})).status,403);
  assert.equal((await f.request(b.path+'decision',{body:decision,headers:b.headers})).status,403);
  const replies=await Promise.all([1,2].map(()=>f.request(path+'decision',{body:decision,headers})));
  assert.deepEqual(replies.map(x=>x.status).sort(),[200,409]);
  assert.equal(f.store.require('sample',f.sample).state,'pending');
  const record=f.store.require('clientReview',row.id);
  assert.equal(record.result,'changes_requested');assert.equal(record.comment,decision.comment);
  assert.equal(record.version,1);assert.ok(record.decisionAt);assert.equal(record.challenge,undefined);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit WHERE kind='client_sample_decision'").get().n,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM outbox').get().n,0);
});

test('view-only SMS requires no email; withdrawal, expiry and a replacement version block the old page and media',async t=>{
  const f=fixture(t);
  assert.equal((await f.create({...f.body,email:''})).status,400);
  const view={...f.body,mode:'view',email:''};
  const row=(await f.create(view)).data, a=await f.open(row);
  assert.equal((await f.request(a.path+'code',{headers:a.headers,body:{}})).status,409);
  assert.equal((await f.request(a.path+'decision',{headers:a.headers,body:{result:'approved',code:'00000000'}})).status,409);
  assert.equal((await f.create({action:'revoke',sample:f.sample,id:row.id})).data.state,'revoked');
  assert.equal((await f.request(a.path+'media',{headers:a.headers})).status,410);
  const older=(await f.create(view)).data, b=await f.open(older);
  const saved=f.store.require('clientReview',older.id);
  f.store.put('clientReview',{...saved,expiresAt:Date.now()-1});
  assert.equal((await f.request(b.path+'open',{headers:b.headers,body:{}})).status,410);
  f.store.put('clientReview',saved);
  f.store.put('sample',{...f.store.require('sample',f.sample),id:randomUUID(),version:2});
  assert.equal((await f.request(b.path+'media',{headers:b.headers})).status,410);
  assert.equal((await f.create(view)).status,409);
});

test('verification limits guesses and expiry; sharing is disabled until configured',async t=>{
  const f=fixture(t);
  f.settings.approval=false;
  assert.equal((await f.create()).status,503);
  f.settings.approval=true;
  const row=(await f.create()).data, {path,headers}=await f.open(row);
  await f.request(path+'code',{headers,body:{}});
  const wrong=f.messages[0].code==='00000000'?'00000001':'00000000';
  for(let i=0;i<5;i++) assert.equal((await f.request(path+'decision',{headers,body:{result:'approved',code:wrong}})).status,403);
  assert.equal((await f.request(path+'decision',{headers,body:{result:'approved',code:f.messages[0].code}})).status,403);
  const saved=f.store.require('clientReview',row.id);
  saved.challenge.tries=0;saved.challenge.until=Date.now()-1;f.store.put('clientReview',saved);
  assert.equal((await f.request(path+'decision',{headers,body:{result:'approved',code:f.messages[0].code}})).status,403);
  f.settings.enabled=false;
  assert.equal((await f.request(path+'media',{headers})).status,404);
  assert.equal((await f.create()).status,404);
});

test('a client can approve once, and staff retain that decision when they withdraw the link', async t => {
  const f = fixture(t), row = (await f.create()).data;
  const {path, headers} = await f.open(row);
  await f.request(path + 'code', {headers, body:{}});
  const decision = {result:'approved', code:f.messages[0].code};
  assert.equal((await f.request(path+'decision', {headers, body:decision})).data.result, 'approved');
  assert.equal((await f.request(path+'decision', {headers, body:decision})).status, 409);
  const after = (await f.create({action:'revoke', sample:f.sample, id:row.id})).data;
  assert.equal(after.state, 'approved');
  assert.equal(after.access, 'revoked');
  assert.equal(after.url, null);
  assert.equal((await f.request(path+'media', {headers})).status, 410);
});
