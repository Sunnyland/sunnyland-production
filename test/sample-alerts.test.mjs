import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {generateKeyPairSync,randomUUID,verify} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../core.mjs';
import {makeVideoSample,prepareSamples} from '../sample-workflow.mjs';
import {appleProvider,drainSampleAlerts,pushDevice} from '../sample-push.mjs';

function staff(s,role,name=role) {return s.user(name+'@example.test','example-test-password',role,name);}
function makeVideo(s,creator) {
  const id=randomUUID();
  s.put('media',{id,owner:creator.id,mime:'video/mp4',kind:'jobVideo'});
  return s.put('jobVideo',{id,media:id,printiqId:64474,creator:creator.id,job:'J064474',at:new Date().toISOString(),title:'Fold'});
}

test('opening an existing database links old attachments exactly once without copying files or sending historical notifications', t=>{
  const dir=mkdtempSync(join(tmpdir(),'sample-migration-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=join(dir,'production.sqlite');
  let s=new Store(db);
  const maker=staff(s,'operator'),other=staff(s,'operator','coworker'),rep=staff(s,'rep');
  const v=makeVideo(s,maker);s.close();
  s=new Store(db);
  let sample=s.snapshot(other).samples[0];
  assert.equal(sample.id,v.id);assert.equal(sample.media,v.media);assert.equal(sample.rep,null);
  assert.equal(sample.state,'unassigned');assert.equal(sample.at,v.at);assert.equal(sample.printiqId,64474);
  assert.equal(s.all('media').length,1);assert.equal(s.db.prepare('SELECT count(*) n FROM sample_alerts').get().n,0);
  const device={installation:randomUUID(),token:'ab'.repeat(32)};
  pushDevice(s,rep,device);
  const key=randomUUID(),assign={id:v.id,previousRep:'',rep:rep.id};
  sample=s.action(maker,key,'sample_assign',assign);
  assert.equal(sample.rep,rep.id);assert.equal(sample.state,'pending');
  assert.deepEqual(s.action(maker,key,'sample_assign',assign),sample);
  assert.throws(()=>s.action(other,randomUUID(),'decision',{id:v.id,state:'approved',note:'not assigned'}),/assigned rep/);
  s.close();s=new Store(db);
  assert.equal(s.all('sample').length,1);assert.equal(s.all('sample')[0].rep,rep.id);
  assert.equal(s.db.prepare('SELECT count(*) n FROM sample_alerts').get().n,1);
  const decision=s.action(rep,randomUUID(),'decision',{id:v.id,state:'approved',note:'Reviewed'});
  assert.equal(decision.state,'approved');
  assert.equal(s.db.prepare("SELECT count(*) n FROM outbox WHERE channel='printiq'").get().n,0);
  s.close();
});

test('notification delivery only targets the current assigned active rep and the current device binding',async t=>{
  const s=new Store();t.after(()=>s.close());
  const op=staff(s,'operator'), rep=staff(s,'rep'), next=staff(s,'rep','replacement');
  const one={installation:randomUUID(),token:'ab'.repeat(32)},two={installation:randomUUID(),token:'bc'.repeat(32)};
  assert.throws(()=>pushDevice(s,op,one),/rep/i);
  pushDevice(s,rep,one);pushDevice(s,rep,one);pushDevice(s,next,two);
  const listed=s.snapshot(op).users.find(u=>u.id===rep.id);assert.equal(listed.sampleAlertsRegistered,true);assert.equal(listed.token,undefined);
  const v=makeVideo(s,op);makeVideoSample(s,v,rep.id);
  const move={id:v.id,previousRep:rep.id,rep:next.id};
  assert.throws(()=>s.action(op,randomUUID(),'sample_assign',{...move,previousRep:''}),/changed/);
  s.action(op,randomUUID(),'sample_assign',move);
  const sent=[];
  const deliver=async(device,alert)=>{sent.push([device.token,alert.sample]);return {status:200};};
  await Promise.all([drainSampleAlerts(s,deliver),drainSampleAlerts(s,deliver)]);
  assert.deepEqual(sent,[[two.token,v.id]]);
  assert.equal(s.db.prepare("SELECT count(*) n FROM sample_alerts WHERE state='accepted'").get().n,1);
  const b=makeVideo(s,op);makeVideoSample(s,b,rep.id);
  pushDevice(s,next,one); // Shared iPhone signed in as a different rep.
  await drainSampleAlerts(s,deliver);
  assert.equal(sent.length,1);
  const c=makeVideo(s,op);makeVideoSample(s,c,next.id);
  s.put('user',{...next,enabled:false});
  await drainSampleAlerts(s,deliver);
  assert.equal(sent.length,1);
});

test('temporary Apple failures are retried; unregistered devices are retired',async t=>{
  const s=new Store();t.after(()=>s.close());
  const op=staff(s,'operator'),rep=staff(s,'rep');
  pushDevice(s,rep,{installation:randomUUID(),token:'ab'.repeat(32)});
  makeVideoSample(s,makeVideo(s,op),rep.id);
  await drainSampleAlerts(s,async()=>({status:503}));
  let row=s.db.prepare('SELECT * FROM sample_alerts').get();
  assert.equal(row.state,'pending');assert.equal(row.attempts,1);
  await drainSampleAlerts(s,async()=>({status:410,reason:'Unregistered'}),row.due+1);
  assert.equal(s.db.prepare('SELECT count(*) n FROM push_devices').get().n,0);
  assert.equal(s.db.prepare('SELECT state FROM sample_alerts').get().state,'failed');
});

test('Apple transport signs ES256 tokens and sends an alert for this app without customer data', async t=>{
  assert.equal(appleProvider({}),null);
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
  const dir=mkdtempSync(join(tmpdir(),'sample-alert-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const key=join(dir,'test.p8');writeFileSync(key,privateKey.export({format:'pem',type:'pkcs8'}));
  const observations=[];
  function open(origin) {
    const session=new EventEmitter();session.close=()=>session.emit('close');session.destroy=()=>session.close();
    session.request=headers=>{
      const req=new EventEmitter();req.setEncoding=()=>{};
      req.end=body=>{observations.push({origin,headers,payload:JSON.parse(body)});req.emit('response',{':status':200});req.emit('end');};
      return req;
    };return session;
  }
  const send=appleProvider({SUNNYLAND_APNS_ENVIRONMENT:'sandbox',SUNNYLAND_APNS_TEAM_ID:'TEAM123456',SUNNYLAND_APNS_KEY_ID:'TEST123456',SUNNYLAND_APNS_KEY_FILE:key},open);
  const alert={id:randomUUID(),sample:randomUUID()};
  assert.equal((await send({token:'cd'.repeat(32)},alert)).status,200);
  const {origin,headers,payload}=observations[0];
  assert.equal(origin,'https://api.sandbox.push.apple.com');assert.equal(headers['apns-topic'],'au.com.sunnyland.production');
  assert.equal(headers[':path'],'/3/device/'+'cd'.repeat(32));assert.equal(headers['apns-push-type'],'alert');assert.equal(payload.sample,alert.sample);
  const [h,b,sig]=headers.authorization.slice(7).split('.');
  assert.ok(verify('sha256',Buffer.from(h+'.'+b),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(sig,'base64url')));
  assert.ok(!JSON.stringify(payload).includes('J064474'));
});

test('a folding sample honours the chosen rep and sends its ready alert only to that rep',async t=>{
  const s=new Store();t.after(()=>s.close());
  const op=staff(s,'operator'),defaultRep=staff(s,'rep'),chosen=staff(s,'rep','chosen');
  s.put('job',{id:'J064474',active:true,verifiedAt:new Date().toISOString(),rep:defaultRep.id,sections:[]});
  s.put('media',{id:'fold-photo',owner:op.id});
  pushDevice(s,defaultRep,{installation:randomUUID(),token:'aa'.repeat(32)});
  pushDevice(s,chosen,{installation:randomUUID(),token:'bb'.repeat(32)});
  const data={job:'J064474',media:'fold-photo',title:'First fold',note:'Check panel',rep:chosen.id};
  const key=randomUUID(),sample=s.action(op,key,'sample',data);
  assert.equal(s.action(op,key,'sample',data).id,sample.id);
  assert.equal(sample.rep,chosen.id);
  const targets=[];
  await drainSampleAlerts(s,async d=>{targets.push(d.actor);return {status:200};});
  assert.deepEqual(targets,[chosen.id]);
  assert.equal(JSON.parse(s.db.prepare("SELECT body FROM outbox WHERE channel='mail'").get().body).to,chosen.email);
  assert.throws(()=>s.action(defaultRep,randomUUID(),'decision',{id:sample.id,state:'approved',note:'check'}),/assigned rep/);
});
