import {productionStaff} from './sample-workflow.mjs';
import {randomBytes, randomInt, randomUUID, createHmac, timingSafeEqual} from 'node:crypto';
import {readFileSync, statSync, createReadStream} from 'node:fs';
import {join} from 'node:path';
import {need, Fault} from './core.mjs';
import {sendMail} from './worker.mjs';

const host = 'https://printcrm.sunnyland.com.au';
const prefix = '/sample-review/';
const assets = new Set(['review.css','review.js']);
const types = new Set(['image/jpeg','image/png','video/mp4','video/quicktime']);
const emailPattern = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const day = 86400000;
const safeHeaders = {'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','X-Robots-Tag':'noindex, nofollow',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};

export function clientReviewSettings() {
  return {enabled:process.env.SUNNYLAND_CLIENT_REVIEWS === 'true',
    approval:process.env.SMTP_ENABLED === 'true' && Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM),
    mail:sendMail};
}
function json(res,status,body,extra={}) {
  res.writeHead(status,{...safeHeaders,'Content-Type':'application/json',...extra});res.end(JSON.stringify(body));
}
async function input(req) {
  need(req.headers['content-type']?.split(';')[0].trim() === 'application/json','Use a JSON request.',415);
  const chunks=[]; let size=0;
  for await(const chunk of req) {size+=chunk.length;need(size<=8192,'Request too large.',413);chunks.push(chunk);}
  let data;
  try {data=JSON.parse(Buffer.concat(chunks));} catch {throw new Fault('Invalid review request.');}
  need(data && typeof data==='object' && !Array.isArray(data),'Invalid review request.');
  return data;
}
function clean(value,limit) {
  if (value == null) return '';
  need(typeof value==='string' && value.length<=limit && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value),'Check the text entered.');
  return value.trim();
}
function manage(actor,sample) {return actor.role==='manager' || actor.id===sample.rep;}
function latest(store,s) {
  return !store.all('sample').some(x=>x.family===s.family && x.version>s.version);
}
function status(store,r) {
  if(r.revokedAt) return 'revoked';
  const sample=store.get('sample',r.sample);
  if(!sample || !latest(store,sample)) return 'superseded';
  return r.expiresAt<=Date.now()?'expired':'open';
}
function mac(store,...parts) {
  // This key is private to the service and is never included in a staff snapshot.
  let key=store.get('clientReviewSecret','signing');
  if(!key) {
    const doc=JSON.stringify({id:'signing',key:randomBytes(32).toString('hex')});
    store.db.prepare('INSERT OR IGNORE INTO records(kind,id,doc) VALUES (?,?,?)').run('clientReviewSecret','signing',doc);
    key=store.require('clientReviewSecret','signing');
  }
  return createHmac('sha256',Buffer.from(key.key,'hex')).update(parts.join('\0')).digest('hex');
}
function equal(a,b) {
  return typeof a==='string' && /^[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function proof(store,r) {return mac(store,'link',r.id,r.sample,String(r.version));}
function staffRow(store,r,canManage) {
  const access=status(store,r);
  const state=r.result || access;
  const data={id:r.id,mode:r.mode,version:r.version,state,access,comment:r.comment||'',decisionAt:r.decisionAt,
    createdAt:r.createdAt,expiresAt:new Date(r.expiresAt).toISOString()};
  if(canManage) Object.assign(data,{email:r.email,contact:r.contact,question:r.question,
    url:access==='open'?host+prefix+r.id+'/#'+proof(store,r):null});
  return data;
}
export async function staffReviews({req,res,url,store,authorize,settings}) {
  need(settings.enabled,'Client sharing is unavailable.',404);
  const post=req.method==='POST';
  need(post || req.method==='GET','Method unavailable.',405);
  const body=post?await input(req):{};
  const actor=authorize(),sample=store.require('sample',post?body.sample:url.searchParams.get('sample'));
  const canManage=manage(actor,sample);
  need(productionStaff(actor),'Sample unavailable.',403);
  if(!post) return json(res,200,{canManage,canCreate:canManage && latest(store,sample),approvalEnabled:settings.approval,
    reviews:store.all('clientReview').filter(r=>r.sample===sample.id).reverse().map(r=>staffRow(store,r,canManage))});
  need(canManage,'Only the assigned rep or a manager can share this sample.',403);
  const id=store.transaction(actor,req.headers['idempotency-key'],{action:'clientReview',body},()=>{
    if(body.action==='revoke') {
      const r=store.require('clientReview',body.id);need(r.sample===sample.id,'Review unavailable.',404);
      if(!r.revokedAt){r.revokedAt=new Date().toISOString();store.put('clientReview',r);store.audit(actor,'client_review_revoked',r.id,{sample:sample.id});}
      return r.id;
    }
    need(body.action==='create' && ['view','approval'].includes(body.mode),'Choose the review type.');
    need(latest(store,sample),'A newer version of this sample exists.',409);
    need(body.mode!=='approval' || settings.approval,'Verification email is unavailable.',503);
    const email=clean(body.email,254),contact=clean(body.contact,254),question=clean(body.question,1000);
    need(!email || emailPattern.test(email),'Enter a client email address.');
    const phone=contact.replace(/[\s().-]/g,'');
    need(!contact || emailPattern.test(contact) || /^\+?\d{6,15}$/.test(phone),'Enter a mobile number or iMessage address.');
    need(email || contact,'Enter a recipient.');
    need(body.mode==='view' || email,'Enter an email address for the approval code.');
    const media=store.require('media',sample.media);need(types.has(media.mime),'Unsupported sample media.');
    const r=store.put('clientReview',{id:randomUUID(),sample:sample.id,job:sample.job,media:sample.media,version:sample.version,
      mode:body.mode,email,contact,question,title:sample.title,actor:actor.id,createdAt:new Date().toISOString(),expiresAt:Date.now()+7*day});
    store.audit(actor,'client_review_created',r.id,{sample:r.sample,version:r.version,mode:r.mode});
    return r.id;
  });
  return json(res,200,staffRow(store,store.require('clientReview',id),true));
}
function active(store,id) {
  const r=store.get('clientReview',id), s=r && store.get('sample',r.sample);
  need(s && !r.revokedAt && Date.now()<r.expiresAt && s.version===r.version && s.media===r.media && latest(store,s),
    'This review link has expired, was withdrawn, or has been replaced. Contact Sunnyland for a current link.',410);
  return r;
}
function publicRow(r,media) {
  return {title:r.title,job:r.job,version:r.version,question:r.question,mime:media.mime,mode:r.mode,
    result:r.result||null,comment:r.comment||'',decisionAt:r.decisionAt||null,expiresAt:new Date(r.expiresAt).toISOString()};
}
function transaction(store,fn) {
  store.db.exec('BEGIN IMMEDIATE');
  try {const value=fn();store.db.exec('COMMIT');return value;}
  catch(e){store.db.exec('ROLLBACK');throw e;}
}
function asset(res,name,mime,head) {
  const bytes=readFileSync(new URL('./review-web/'+name,import.meta.url));
  res.writeHead(200,{...safeHeaders,'Content-Type':mime,'Content-Length':bytes.length});res.end(head?undefined:bytes);
}
function serveMedia(req,res,media,mediaDir) {
  need(uuid.test(media.id) && types.has(media.mime),'Media unavailable.',404);
  const path=join(mediaDir,media.id), size=statSync(path).size;
  let start=0,end=size-1,code=200;
  const headers={...safeHeaders,'Content-Type':media.mime,'Accept-Ranges':'bytes'};
  if(req.headers.range) {
    const m=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if(m && (m[1]||m[2])) {
      start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));
      end=m[1]&&m[2]?Math.min(size-1,Number(m[2])):size-1;
    } else start=size;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size) {
      res.writeHead(416,{...headers,'Content-Range':'bytes */'+size});return res.end();
    }
    code=206;headers['Content-Range']='bytes '+start+'-'+end+'/'+size;
  }
  res.writeHead(code,{...headers,'Content-Length':end-start+1});
  if(req.method==='HEAD')return res.end();
  const file=createReadStream(path,{start,end});
  res.on('close',()=>file.destroy());file.on('error',()=>res.destroy());file.pipe(res);
}
export async function publicReview({req,res,url,store,mediaDir,settings}) {
  need(settings.enabled,'Page unavailable.',404);
  const tail=url.pathname.slice(prefix.length), get=req.method==='GET'||req.method==='HEAD';
  if(get && assets.has(tail)) return asset(res,tail,tail.endsWith('.js')?'application/javascript':'text/css',req.method==='HEAD');
  const [id,action,...more]=tail.split('/');
  need(uuid.test(id) && action!==undefined && !more.length,'Page unavailable.',404);
  if(get && action==='')return asset(res,'index.html','text/html; charset=utf-8',req.method==='HEAD');
  const r=active(store,id),path=prefix+id+'/';
  const expected=proof(store,r);
  const cookie=req.headers.cookie?.split(';').map(p=>p.trim()).find(p=>p.startsWith('slp_review='))?.slice(11);
  if(get && action==='media') {
    need(equal(cookie,expected),'Open the link sent by Sunnyland.',403);
    return serveMedia(req,res,store.require('media',r.media),mediaDir);
  }
  need(req.method==='POST' && ['open','code','decision'].includes(action),'Page unavailable.',404);
  need(req.headers.origin===host,'Open the review on the Sunnyland website.',403);
  const data=await input(req);
  const current=active(store,id);
  if(action==='open') {
    need(equal(data.token,expected)||equal(cookie,expected),'Open the full link sent by Sunnyland.',403);
    return json(res,200,publicRow(current,store.require('media',current.media)),{
      'Set-Cookie':'slp_review='+expected+'; Path='+path+'; HttpOnly; Secure; SameSite=Strict; Max-Age=3600'});
  }
  need(equal(cookie,expected),'Reopen the link sent by Sunnyland.',403);
  need(current.mode==='approval' && !current.result,'This review is not awaiting a decision.',409);
  if(action==='code') {
    need(settings.approval,'Verification email is unavailable. Contact Sunnyland.',503);
    const code=String(randomInt(0,100000000)).padStart(8,'0'), nonce=randomUUID();
    transaction(store,()=>{
      const row=active(store,id),now=Date.now(), previous=row.challenge;
      need(!row.result,'Decision already recorded.',409);
      need(!previous || now-previous.sentAt>=60000,'Please wait a minute before requesting another code.',429);
      const recent=(row.sends||[]).filter(at=>now-at<3600000);
      need(recent.length<5,'Too many requests. Try again in an hour.',429);
      row.sends=[...recent,now];row.challenge={sentAt:now,until:now+600000,tries:0,nonce,digest:mac(store,'code',id,nonce,code)};
      store.put('clientReview',row);
    });
    const receipt=await settings.mail({id:nonce,body:JSON.stringify({kind:'client_review_code',to:current.email,job:current.job,title:current.title,code})});
    need(receipt.state==='accepted',receipt.state==='uncertain'?'Email delivery could not be confirmed. If a code arrives, it can be used.':'Email delivery failed. Contact Sunnyland or request a new code in a minute.',503);
    return json(res,200,{ok:true});
  }
  need(['approved','changes_requested'].includes(data.result),'Choose a decision.');
  const comment=clean(data.comment,1200);
  need(data.result!=='changes_requested'||comment,'Describe the changes requested.');
  const matched=transaction(store,()=>{
    const row=active(store,id);
    need(!row.result,'A decision is already recorded for this review.',409);
    const c=row.challenge;
    need(c && c.until>Date.now() && c.tries<5,'Request a new verification code.',403);
    if(typeof data.code!=='string'||!/^\d{8}$/.test(data.code)||!equal(mac(store,'code',id,c.nonce,data.code),c.digest)){
      c.tries++;store.put('clientReview',row);return false;
    }
    row.result=data.result;row.comment=comment;row.decisionAt=new Date().toISOString();delete row.challenge;
    store.put('clientReview',row);
    store.audit({id:'client-review:'+id},'client_sample_decision',row.sample,
      {review:id,version:row.version,job:row.job,email:row.email,result:row.result,at:row.decisionAt,comment});
    return true;
  });
  need(matched,'Check the verification code.',403);
  return json(res,200,publicRow(store.require('clientReview',id),store.require('media',current.media)));
}
