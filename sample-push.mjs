import {connect} from 'node:http2';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {createPrivateKey, randomUUID, sign} from 'node:crypto';
import {need} from './core.mjs';
import {drainProductionAlerts} from './indigo-watch.mjs';

const topic = 'au.com.sunnyland.production';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function pushDevice(store, actor, data) {
  need(typeof data.installation === 'string' && uuid.test(data.installation),'Invalid iPhone installation.');
  if (data.remove === true) {
    store.db.prepare('DELETE FROM push_devices WHERE installation=? AND actor=?').run(data.installation,actor.id);
    return;
  }
  need(typeof data.token === 'string' && /^(?:[a-f0-9]{2}){16,256}$/.test(data.token),'Invalid Apple device token.');
  need(['rep','manager'].includes(actor.role),'Rep notifications are available to reps and managers.',403);
  const old = store.db.prepare('SELECT * FROM push_devices WHERE installation=?').get(data.installation);
  if (old?.actor===actor.id && old.token===data.token) return;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('DELETE FROM push_devices WHERE installation=? OR token=?').run(data.installation,data.token);
    store.db.prepare('INSERT INTO push_devices VALUES (?,?,?,?)').run(data.installation,data.token,actor.id,randomUUID());
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}

export function appleProvider(env=process.env, openConnection=connect) {
  const team=env.SUNNYLAND_APNS_TEAM_ID, kid=env.SUNNYLAND_APNS_KEY_ID;
  const file=env.SUNNYLAND_APNS_KEY_FILE || (env.CREDENTIALS_DIRECTORY && join(env.CREDENTIALS_DIRECTORY,'sample-apns.p8'));
  const environment=env.SUNNYLAND_APNS_ENVIRONMENT;
  if (!/^[A-Z0-9]{10}$/.test(team||'') || !/^[A-Z0-9]{10}$/.test(kid||'') || !file ||
      !['sandbox','production'].includes(environment)) return null;
  let key;
  try { key=createPrivateKey(readFileSync(file)); } catch {return null;}
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null;
  const origin=environment==='sandbox'?'https://api.sandbox.push.apple.com':'https://api.push.apple.com';
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  let jwt, issued=0;
  return async function send(device, alert) {
    const now=Math.floor(Date.now()/1000);
    if (!jwt || now-issued>=2400) {
      const data=encode({alg:'ES256',kid})+'.'+encode({iss:team,iat:now});
      jwt=data+'.'+sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
      issued=now;
    }
    return new Promise((resolve,reject)=>{
      const session=openConnection(origin);
      const timer=setTimeout(()=>session.destroy(new Error('Apple connection timeout')),12000);
      session.on('error',reject);
      session.on('close',()=>{clearTimeout(timer);reject(new Error('Apple connection closed'));});
      const req=session.request({':method':'POST',':path':'/3/device/'+device.token,authorization:'bearer '+jwt,
        'apns-topic':topic,'apns-push-type':'alert','apns-priority':'10','apns-id':alert.id,
        'apns-collapse-id':alert.collapse??alert.sample,'apns-expiration':String(now+3600)});
      let status=0, body='';
      req.on('response',headers=>{status=Number(headers[':status']);});
      req.setEncoding('utf8');
      req.on('data',chunk=>{ if(body.length<2048) body+=chunk; });
      req.on('error',err=>{reject(err);session.destroy();});
      req.on('end',()=>{
        let reason;try {reason=JSON.parse(body).reason;} catch {}
        resolve({status,reason});session.close();
      });
      // Sample alerts keep their fixed wording; production alerts carry their own title and body.
      const content=alert.sample?{title:'Sample ready for review',body:'Open Sunnyland Production to review your assigned sample.'}:{title:alert.title,body:alert.body};
      req.end(JSON.stringify({aps:{alert:content,sound:'default'},...(alert.sample?{sample:alert.sample}:{production:true})}));
    });
  };
}

export async function drainSampleAlerts(store, send, now=Date.now()) {
  if (!send) return;
  const due=store.db.prepare("SELECT * FROM sample_alerts WHERE state='pending' AND due<=? ORDER BY due LIMIT 25").all(now);
  for (const alert of due) {
    const lease=Date.now()+60000;
    if(!store.db.prepare("UPDATE sample_alerts SET due=?,attempts=attempts+1 WHERE id=? AND state='pending' AND due=?").run(lease,alert.id,alert.due).changes) continue;
    const finish=(state,reason=null,due=lease)=>store.db.prepare("UPDATE sample_alerts SET state=?,reason=?,due=? WHERE id=? AND state='pending' AND due=?").run(state,reason,due,alert.id,lease);
    const sample=store.get('sample',alert.sample);
    const user=store.get('user',alert.rep);
    const device=store.db.prepare('SELECT * FROM push_devices WHERE binding=? AND actor=?').get(alert.binding,alert.rep);
    if (!device || !user?.enabled || sample?.rep!==alert.rep || sample.state!=='pending') {finish('cancelled');continue;}
    let receipt;
    try {receipt=await send(device,alert);} catch {receipt={status:0,reason:'ConnectionError'};}
    if(receipt.status===200) {finish('accepted');continue;}
    if(receipt.status===410) store.db.prepare('DELETE FROM push_devices WHERE binding=?').run(alert.binding);
    const retry=receipt.status===0 || receipt.status===429 || receipt.status>=500;
    finish(retry && alert.attempts<6?'pending':'failed',receipt.reason||String(receipt.status),
      Date.now()+Math.min(3600000,30000*2**alert.attempts));
  }
}

export function startSampleAlerts(store, send) {
  if (!send) return;
  let running=false;
  const tick=async()=>{
    if(running)return;
    running=true;
    try {await drainSampleAlerts(store,send);} catch {console.error('Sample notification queue is unavailable.');}
    try {await drainProductionAlerts(store,send);} catch {console.error('Production notification queue is unavailable.');} finally {running=false;}
  };
  void tick();
  setInterval(tick,5000).unref();
}
