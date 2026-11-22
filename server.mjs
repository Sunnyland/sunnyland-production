import {hiddenJobs,observeDirectory,directoryCutoff} from './job-visibility.mjs';
import {indigoPlanner} from './indigo-agent.mjs';
import {readWatch} from './indigo-watch.mjs';
import {boardFor,boardLinkValid,pressPrinting,renderBoard,renderPin,renderWeek,weekFor} from './board.mjs';
import {notPlanned,notPlannedAction} from './not-planned.mjs';
import {readCookie,renderLogin,renderNotPlanned,sessionCookie} from './plan-page.mjs';
import {readHourlyFeed} from './hourly-indigo.mjs';
import {boardCode,endPlanSession,planPinSession,planViewer,shiftAction,shiftOverview,shiftState,shiftTick,signInWithPin,signOut} from './shifts.mjs';
import {planBookings,pressPlanAction} from './press-plan.mjs';
import {checkFinish,operationEvidence,readRouting,requirementsPath} from './production-finishes.mjs';
import {indigoCapacity, localJobDates, pressDay, savePrintRun, searchDueJobs} from './print-planning.mjs';
import {canonicalPressJob} from './press-status.mjs';
import {pressStatusHook} from './smartstream/status.mjs';
import {productionStaff} from './sample-workflow.mjs';
import {appleProvider,pushDevice,startSampleAlerts} from './sample-push.mjs';
import {canReadJobs,searchJobs,readJob,jobVideos,receiveJobVideo,printIQReadError} from './job-documents.mjs';
import {createJobsReader} from './printiq-application.mjs';
import {resolveTicket} from './job-tickets.mjs';
import {clientReviewSettings, staffReviews, publicReview, streamMedia} from './client-reviews.mjs';
import {syncCursor,parseCursor,changedRecords,visibilityRows,markNewerVersions} from './state-sync.mjs';
import http from 'node:http';
import {PrintIQ} from './printiq.mjs';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {Store,Fault,need,barcode,stockBarcodeValue} from './core.mjs';
import {parseAllowedPeers,peerIsAllowed} from './network.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
export function createServer(store,{mediaDir=join(root,'data','media'),allowedPeers=parseAllowedPeers(process.env.SUNNYLAND_ALLOWED_PEERS),iq=createJobsReader(),reviews=clientReviewSettings(),push=appleProvider(),pressStatusFile=process.env.SUNNYLAND_PRESS_STATUS_FILE,requirementsFile=requirementsPath,runIndigoAgent=false,boardWatch=readWatch,hourlyFeed=readHourlyFeed,clock=()=>new Date(),publicHost=process.env.SUNNYLAND_PUBLIC_HOST||'printcrm.sunnyland.com.au'}={}){
 const press = pressStatusHook(store,{statusFile:pressStatusFile});
 const routing=()=>readRouting(requirementsFile);
 const planner=indigoPlanner(store,iq,{routing});
 const jobsConfigured = () => iq.jobsConfigured ?? Boolean(iq.token);
 mkdirSync(mediaDir,{recursive:true});
 const server=http.createServer(async(req,res)=>{const send=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 try{need(peerIsAllowed(req.socket.remoteAddress,allowedPeers),'Connection not permitted.',403);const url=new URL(req.url,'http://localhost'),path=url.pathname;// Browsers send "Origin: null" for some same-site form posts (privacy settings); that is not an address.
 const origin=req.headers.origin,screens=path.startsWith('/board/')||path==='/plan'||path.startsWith('/plan/');
 let originHost=null;if(origin&&origin!=='null'){try{originHost=new URL(origin).host;}catch{originHost='?';}}
 // Screens and the planning page are protected by their private link / SameSite cookie, so "null" is fine there.
 need(!origin||screens&&origin==='null'||path.startsWith('/board/')||originHost===req.headers.host||(path.startsWith('/plan')&&[req.headers['x-forwarded-host'],publicHost].includes(originHost)),'Cross-origin requests are not allowed.',403);
 if(path.startsWith('/sample-review/')) return await publicReview({req,res,url,store,mediaDir,settings:reviews});
 // Production board for screens: private link, no staff account. Refreshes itself. The link is the secret, so the
 // board's own forms (PIN pad, sign out) skip the same-origin check; they only change who is at the press.
 if(path.startsWith('/board/')){
   const m=/^\/board\/([A-Za-z0-9_-]{32})(\/week|\/pin|\/sign-out)?$/.exec(path);need(m&&boardLinkValid(store,m[1]),'Not found.',404);
   const key=m[1],sub=m[2]??'',now=clock();
   const html=(code,body)=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'"});res.end(body);};
   const back=()=>{res.writeHead(303,{Location:'../'+key,'Cache-Control':'no-store'});res.end();};
   if(req.method==='POST'){
     need(sub==='/pin'||sub==='/sign-out','Not found.',404);
     const parts=[];let size=0;for await(const part of req){size+=part.length;need(size<=2048,'Request is too large.',413);parts.push(part);}
     const form=new URLSearchParams(Buffer.concat(parts).toString('utf8'));
     if(sub==='/sign-out'){signOut(store,null,now,'signed out at the press screen');return back();}
     let digits=(form.get('d')??'').replace(/\D/g,'').slice(0,6);const k=form.get('k')??'';
     if(/^\d$/.test(k)&&digits.length<6)digits+=k;else if(k==='back')digits=digits.slice(0,-1);
     else if(k==='enter'){
       try{signInWithPin(store,key,digits,now);return back();}
       catch(e){if(!(e instanceof Fault))throw e;return html(e.status===429?429:401,renderPin({key,error:e.message}));}
     }
     return html(200,renderPin({key,digits}));
   }
   need(req.method==='GET'&&sub!=='/sign-out','Not found.',404);
   if(sub==='/pin')return html(200,renderPin({key}));
   const next=url.searchParams.get('next')==='1';
   if(sub==='/week')return html(200,renderWeek(weekFor(store,{watch:boardWatch(),now,next}),{todayHref:'../'+key,otherHref:next?'week':'?next=1',waiting:notPlanned(store,hourlyFeed(),now).counts}));
   // Sign-in shows once anyone has shift hours (until then the board stays as it was).
   const state=store.all('staffShift').length?shiftState(store,now):null;
   const shift=state&&{...state,code:state.operator?null:boardCode(store,now).code};
   return html(200,renderBoard(boardFor(store,{watch:boardWatch(),now}),{weekHref:key+'/week',shift,key,waiting:notPlanned(store,hourlyFeed(),now).counts}));
 }
 // Production planning page (read only): PIN sign-in, then Today, Week and Not planned. Managers change the plan in PrintCRM.
 if(path==='/plan'||path.startsWith('/plan/')){
   const m=/^\/plan(\/week|\/not-planned|\/login|\/logout)?$/.exec(path);need(m,'Not found.',404);
   const sub=m[1]??'',now=clock();
   const html=(code,body,extra={})=>{res.writeHead(code,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",...extra});res.end(body);};
   const go=(to,extra={})=>{res.writeHead(303,{Location:to,'Cache-Control':'no-store',...extra});res.end();};
   const token=readCookie(req);
   if(req.method==='POST'){
     need(sub==='/login'||sub==='/logout','Not found.',404);
     const parts=[];let size=0;for await(const part of req){size+=part.length;need(size<=1024,'Request is too large.',413);parts.push(part);}
     if(sub==='/logout'){endPlanSession(store,token);return go('../plan',{'Set-Cookie':sessionCookie('',req,0)});}
     const pin=new URLSearchParams(Buffer.concat(parts).toString('utf8')).get('pin')??'';
     const place=String(req.headers['x-forwarded-for']??'').split(',')[0].trim()||req.socket.remoteAddress||'unknown';
     try{const {token:t}=planPinSession(store,place,pin,now);return go('../plan',{'Set-Cookie':sessionCookie(t,req)});}
     catch(e){if(!(e instanceof Fault))throw e;return html(e.status||401,renderLogin(e.message));}
   }
   need(req.method==='GET'&&sub!=='/login'&&sub!=='/logout','Not found.',404);
   const viewer=planViewer(store,token,now);
   if(!viewer)return sub?go('../plan'):html(200,renderLogin());
   const waiting=notPlanned(store,hourlyFeed(),now);
   const out=(href)=>` · <form method="post" action="${href}" style="display:inline"><button>Sign out ${viewer.name.replace(/[&<>"']/g,'')}</button></form>`;
   if(sub==='/week'){const next=url.searchParams.get('next')==='1';
     return html(200,renderWeek(weekFor(store,{watch:boardWatch(),now,next}),{todayHref:'../plan',otherHref:next?'week':'?next=1',waiting:waiting.counts,
       nav:` · <a href="not-planned">Not planned (${waiting.counts.needs})</a>${out('logout')}`}));}
   if(sub==='/not-planned')return html(200,renderNotPlanned({list:waiting,user:viewer,nav:'<a href="../plan">Today</a> · <a href="week">Week</a>'}));
   return html(200,renderBoard(boardFor(store,{watch:boardWatch(),now}),{weekHref:'plan/week',waiting:waiting.counts,
     nav:` · <a href="plan/not-planned">Not planned (${waiting.counts.needs})</a>${out('plan/logout')}`}));
 }
 if(path==='/health'&&req.method==='GET')return send(200,{ok:true,version:'0.1.0'});
 if(path==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});return res.end('<!doctype html><title>Sunnyland Production</title><style>body{font:20px system-ui;padding:8vw;color:#143b33;background:#f5f4ee}p{max-width:40em}</style><h1>Sunnyland Production</h1><p>The shared service is running. Connect using the iPhone app. Staff sign-in is required for stock, jobs and media.</p><p>Version 0.1 pilot. Stock counts start unknown until physically verified.</p>');}
 const token=req.headers.authorization?.replace(/^Bearer /,'');let actor=null;if(path!=='/api/login')actor=store.auth(token);
 if(path==='/api/client-reviews') return await staffReviews({req,res,url,store,authorize:()=>store.auth(token),settings:reviews});
 if(req.method==='GET'){
 if(path==='/api/state'){
   // With ?since=<cursor> from an earlier response, only records changed since then are sent,
   // plus the ids still visible in lists that can lose rows. An unknown cursor gets the full state.
   const hidden=hiddenJobs(store),visible=row=>!hidden(row.job,row.printiqId);
   const cursor=syncCursor(store),since=parseCursor(store,url.searchParams.get('since'));
   let snapshot,jobIds;
   if(since===null){
     snapshot=store.snapshot(actor);
     snapshot.jobs=snapshot.jobs.filter(j=>!hidden(j.id,j.printiqId));
     for(const field of ['samples','operations','holds','issues'])if(Array.isArray(snapshot[field]))
       snapshot[field]=snapshot[field].filter(visible);
     jobIds=snapshot.jobs.map(job=>job.id);
     snapshot.sync={cursor,delta:false};
   }else{
     snapshot={...store.snapshot(actor,{lists:false}),...changedRecords(store,since)};
     const staff=productionStaff(actor);
     // A new version changes newerVersionExists on the earlier ones, so whole families are sent.
     const families=new Set(snapshot.samples.map(s=>s.family));
     snapshot.samples=staff&&families.size?markNewerVersions(store.all('sample').filter(s=>families.has(s.family))):[];
     snapshot.jobs=snapshot.jobs.filter(j=>!hidden(j.id,j.printiqId));
     for(const field of ['samples','operations','holds','issues'])snapshot[field]=snapshot[field].filter(visible);
     const visibleIds={};
     for(const [kind,field] of [['job','jobs'],['sample','samples'],['operation','operations'],['hold','holds'],['issue','issues']])
       visibleIds[field]=field==='samples'&&!staff?[]:visibilityRows(store,kind).filter(visible).map(r=>r.id);
     jobIds=visibleIds.jobs;
     snapshot.sync={cursor,delta:true,visibleIds};
   }
   const pressMilestones=canReadJobs(actor)?press.statuses(jobIds,{includeObserved:true}).filter(r=>!hidden(r.jobNo??r.id)):undefined;
   const printBookings=canReadJobs(actor)?store.all('printPlanRun').filter(r=>!r.removed && !hidden(r.job,r.printiqId)).map(({id,job,printiqId,day,press,part})=>({id,job,printiqId,day,press,part})):undefined;
   return send(200,{...snapshot,pressMilestones,printBookings,indigoPlannerAvailable:canReadJobs(actor),productionOperations:canReadJobs(actor)?operationEvidence(store,routing()).filter(r=>!hidden(r.job)):undefined,printPlanningEnabled:canReadJobs(actor),clientReviewsEnabled:reviews.enabled,sampleWorkflowEnabled:true,samplePushEnabled:Boolean(push),printIQJobsEnabled:canReadJobs(actor)&&jobsConfigured(),capabilities:actor.role==='manager'?['deactivateStaff']:[]});
 }
 if(path==='/api/press-results'){
   need(canReadJobs(actor),'Job access is required.',403);
   const values=url.searchParams.getAll('jobNo');
   need(values.length===1 && canonicalPressJob(values[0]),'Choose one valid job number.');
   const jobNo=canonicalPressJob(values[0]);
   need(!hiddenJobs(store)(jobNo),'This completed job is archived.',404);
   return send(200,{pressMilestones:press.statuses([jobNo])[0]});
 }
 if(path==='/api/resolve' && url.searchParams.has('indigoPlanner')){
   store.manager(actor);need(canReadJobs(actor),'Job access is required.',403);
   const result=await planner.dashboard();
   const current=store.auth(token);store.manager(current);need(canReadJobs(current),'Job access is required.',403);
   const hidden=hiddenJobs(store);
   for(const key of ['rows','scheduled'])result[key]=result[key].filter(r=>!hidden(r.job,r.printiqId));
   if(result.hourly?.history){
     for(const key of ['history','bookings','review'])result.hourly[key]=result.hourly[key].filter(r=>!hidden(r.job,r.printiqId));
     result.hourly.entries=result.hourly.history.length;
     result.hourly.historyJobs=new Set(result.hourly.history.map(r=>r.job).filter(Boolean)).size;
     result.hourly.completed=new Set(result.hourly.history.filter(r=>r.mis==='Complete in printIQ').map(r=>r.job)).size;
   }
   return send(200,result);
 }
 if(path==='/api/resolve' && url.searchParams.has('productionDates')){
   need(canReadJobs(actor) && jobsConfigured(),'Live job access is required.',403);
   let dates;
   try{dates=await localJobDates(store,iq);}catch(error){throw printIQReadError(error);}
   need(canReadJobs(store.auth(token)),'Job access is required.',403);
   const hidden=hiddenJobs(store);return send(200,{dates:dates.filter(j=>!hidden(j.id,j.printiqId))});
 }
 if(path==='/api/resolve' && url.searchParams.has('pressPlanDay')){
   need(canReadJobs(actor),'Job access is required.',403);
   let runs;
   try {runs=await pressDay(store,iq,url.searchParams.get('pressPlanDay'),url.searchParams.get('press'));}
   catch(error){if(error instanceof Fault)throw error;throw printIQReadError(error);}
   need(canReadJobs(store.auth(token)),'Job access is required.',403);
   return send(200,{runs,capacity:indigoCapacity(planBookings(store),url.searchParams.get('pressPlanDay'),url.searchParams.get('press'))});
 }
 if(path==='/api/stock'){return send(200,store.summary(url.searchParams.get('code')));}
 if(path==='/api/resolve' && (url.searchParams.has('jobs') || url.searchParams.has('printJob'))){
   need(canReadJobs(actor),'Job access is required.',403);
   need(jobsConfigured(),'PrintCRM needs its printIQ integration credential to read jobs.',503);
   let result;
   try {
     if(url.searchParams.has('printJob')){
       const job=await readJob(iq,url.searchParams.get('printJob'),url.searchParams.get('jobId'));
       observeDirectory(store,[job]);need(!hiddenJobs(store)(job.id,job.printiqId),'This completed job is archived.',404);
       result={job,videos:jobVideos(store,job.id,job.printiqId),pressMilestones:press.statuses([job.id])[0]};
     } else if(url.searchParams.get('order')==='due')result=await searchDueJobs(iq,url.searchParams,directoryCutoff());
     else result=await searchJobs(iq,url.searchParams.get('jobs'),url.searchParams.get('before'),directoryCutoff());
   } catch(error){throw printIQReadError(error);}
   need(canReadJobs(store.auth(token)),'Job access is required.',403);
   if(result.jobs){observeDirectory(store,result.jobs);const hidden=hiddenJobs(store);result.jobs=result.jobs.filter(j=>!hidden(j.id,j.printiqId));}
   return send(200,result);
 }
 if(path==='/api/resolve'&&url.searchParams.has('ticket')){
   const code=barcode(url.searchParams.getAll('ticket'));
   const operations=new PrintIQ();
   const result=await resolveTicket(store,code,operations,canReadJobs(actor) && jobsConfigured()?iq:operations);
   store.auth(token);need(!hiddenJobs(store)(result.job),'This completed job is archived.',404);
   return send(200,result);
 }
 if(path==='/api/resolve'){
   const code=barcode(url.searchParams.getAll('code'),stockBarcodeValue);
   const alias=store.get('alias',code);
   const matches=store.all('stock').filter(stock=>stock.id===code || stock.supplier_ref===code || alias?.stock===stock.id);
   const result={code,matches};
   if(url.searchParams.get('balance')==='1' && matches.length===1) result.balance=store.summary(matches[0].id);
   return send(200,result);
 }
 if(path==='/api/not-planned'){store.manager(actor);need(canReadJobs(actor),'Job access is required.',403);return send(200,notPlanned(store,hourlyFeed(),clock()));}
 if(path==='/api/shifts'){need(productionStaff(actor),'Production access is required.',403);return send(200,shiftOverview(store,clock()));}
 if(path==='/api/outbox'){store.manager(actor);return send(200,store.db.prepare('SELECT id,channel,entity,state,receipt,created FROM outbox ORDER BY created DESC').all());}
 if(path.startsWith('/api/media/')){const m=store.require('media',path.slice('/api/media/'.length));const sampleMedia=productionStaff(actor) && Boolean(store.db.prepare("SELECT 1 FROM records WHERE kind='sample' AND json_extract(doc,'$.media')=? LIMIT 1").get(m.id));const permitted=sampleMedia || (m.kind==='jobVideo' ? canReadJobs(actor) && Boolean(store.get('jobVideo',m.id)) : m.owner===actor.id||actor.role==='manager');need(permitted,'This media is not available to your account.',403);return streamMedia(req,res,m,mediaDir,{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});}
 }
 if(req.method==='POST' && path==='/api/media' && url.searchParams.has('jobVideo')){
   need(jobsConfigured(),'PrintCRM needs its printIQ integration credential to attach job videos.',503);
   const video=await receiveJobVideo({req,params:url.searchParams,store,iq,token,mediaDir});
   return send(201,video);
 }
 need(req.method==='POST','Endpoint not found.',404);const max=path==='/api/media'?100*1024*1024:1024*1024;const parts=[];let size=0;for await(const part of req){size+=part.length;need(size<=max,'File or request is too large.',413);parts.push(part);}const bytes=Buffer.concat(parts);
 if(path!=='/api/login')actor=store.auth(token);
 if(path==='/api/media'){const mime=req.headers['content-type'];need(['image/jpeg','image/png','video/mp4','video/quicktime'].includes(mime),'Use JPEG, PNG, MP4 or MOV.');need(bytes.length>=12,'Upload is empty.');const valid=mime==='image/jpeg'?bytes[0]===255&&bytes[1]===216:mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.subarray(4,8).toString()==='ftyp';need(valid,'The file does not match its media type.');const id=randomUUID();writeFileSync(join(mediaDir,id),bytes,{flag:'wx'});const m=store.put('media',{id,owner:actor.id,mime,bytes:size,sha256:createHash('sha256').update(bytes).digest('hex'),at:new Date().toISOString()});return send(201,m);}
 let body;try{body=JSON.parse(bytes.toString('utf8'));}catch{throw new Fault('Invalid JSON.');}
 if(path==='/api/login')return send(200,store.login(body.email,body.password));
 if(path==='/api/action' && url.searchParams.get('indigoPlanner')==='1'){
   const authorize=()=>{const a=store.auth(token);store.manager(a);need(canReadJobs(a),'Job access is required.',403);return a;};
   need(body && typeof body==='object','Invalid planner action.');
   return send(200,await planner.control(authorize(),req.headers['idempotency-key'],body,authorize));
 }
 if(path==='/api/action' && url.searchParams.get('notPlanned')==='1'){
   need(canReadJobs(actor),'Job access is required.',403);need(body && typeof body==='object','Invalid change.');
   return send(200,notPlannedAction(store,actor,body,hourlyFeed(),clock()));
 }
 if(path==='/api/action' && url.searchParams.get('shifts')==='1'){
   // Shifts and press sign-in: hours, day changes, PINs (managers); sign in with the board's code / sign out (operators).
   need(productionStaff(actor),'Production access is required.',403);need(body && typeof body==='object','Invalid shift change.');
   return send(200,shiftAction(store,actor,body,clock()));
 }
 if(path==='/api/action' && url.searchParams.get('pressPlan')==='1'){
   // Manager changes to the press plan: rush, hold, on the press, maintenance, job-number links, Saturdays.
   need(canReadJobs(actor),'Job access is required.',403);need(body && typeof body==='object','Invalid plan change.');
   return send(200,pressPlanAction(store,actor,req.headers['idempotency-key'],body));
 }
 if(path==='/api/action' && url.searchParams.get('checkedPrintFinish')==='1'){
   need(canReadJobs(actor),'Job access is required.',403);need(body && typeof body==='object','Invalid Printing operation.');
   return send(200,checkFinish(store,actor,req.headers['idempotency-key'],body,routing()));
 }
 if(path==='/api/action' && url.searchParams.get('printPlan')==='1'){
   store.manager(actor);need(canReadJobs(actor),'Job access is required.',403);
   need(body && typeof body==='object' && typeof body.job==='string','Choose a job.');
   const key=req.headers['idempotency-key'];
   const prior=typeof key==='string' && store.db.prepare('SELECT 1 FROM requests WHERE actor=? AND key=?').get(actor.id,key);
   let job=null;
   if(!prior && !body.remove){
     if(body.printiqId!=null){
       need(Number.isSafeInteger(body.printiqId) && body.printiqId>0,'Choose an exact printIQ job.');
       try{job=await readJob(iq,body.job,body.printiqId);}catch(error){throw printIQReadError(error);}
     }else job=store.require('job',body.job);
   }
   const current=store.auth(token);need(canReadJobs(current),'Job access is required.',403);
   return send(200,savePrintRun(store,current,key,body,job));
 }
 if(path==='/api/action' && url.searchParams.get('pushDevice')==='1'){
   need(body && typeof body==='object','Invalid iPhone registration.');
   pushDevice(store,actor,body);return send(200,{ok:true});
 }
 if(path==='/api/staff/deactivate'){
   store.manager(actor);
   const id=body?.id;
   need(typeof id==='string' && id.length>0,'Choose a staff account.');
   need(id!==actor.id,'Another manager must remove your access.',409);
   store.db.exec('BEGIN IMMEDIATE');
   try {
     const staff=store.require('user',id);
     if(staff.enabled){
       store.put('user',{...staff,enabled:false});
       store.db.prepare('DELETE FROM push_devices WHERE actor=?').run(id);
       store.audit(actor,'deactivate_staff',id,{name:staff.name});
     }
     store.db.prepare('DELETE FROM sessions WHERE user=?').run(id);
     store.db.exec('COMMIT');
   } catch(error) { store.db.exec('ROLLBACK'); throw error; }
   return send(200,{id,enabled:false});
 }
 if(path==='/api/logout'){if(body?.installation)pushDevice(store,actor,{installation:body.installation,remove:true});store.logout(token);return send(200,{ok:true});}
 if(path==='/api/action'){need(body&&typeof body.type==='string'&&body.data&&typeof body.data==='object'&&!Array.isArray(body.data),'Invalid action.');const key=req.headers['idempotency-key'];const previous=typeof key==='string'&&store.db.prepare('SELECT 1 FROM requests WHERE actor=? AND key=?').get(actor.id,key);if(!previous&&!(body.type==='operation'&&body.data.state==='paused')&&body.data.job&&['issue','reserve','operation','hold','sample'].includes(body.type)&&process.env.PRINTIQ_ACTIVE_STATUSES)await new PrintIQ().refresh(store,body.data.job);return send(200,store.action(store.auth(token),key,body.type,body.data));}
 throw new Fault('Endpoint not found.',404);
 }catch(e){send(e.status||500,{error:e instanceof Fault?e.message:'The operation could not be completed. No success was confirmed.'});if(!(e instanceof Fault))console.error(e.stack);}
 });
 if(runIndigoAgent){
   let timer;
   server.once('listening',()=>{void planner.tick();timer=setInterval(()=>void planner.tick(),60000);timer.unref();});
   server.once('close',()=>clearInterval(timer));
   // Shifts: sign out at the end of a shift, and the shift notifications.
   let shiftTimer;const shifts=()=>{try{shiftTick(store,{now:clock(),printing:pressPrinting(boardWatch(),clock())});}catch(e){console.error('Shift check failed:',e.message);}};
   server.once('listening',()=>{shifts();shiftTimer=setInterval(shifts,60000);shiftTimer.unref();});
   server.once('close',()=>clearInterval(shiftTimer));
 }
 return server;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const data=process.env.SUNNYLAND_DATA||join(root,'data');mkdirSync(data,{recursive:true});const store=new Store(join(data,'production.sqlite'));need(store.all('user').length,'Run setup.mjs to create the first staff account.');const push=appleProvider();const server=createServer(store,{mediaDir:join(data,'media'),push,runIndigoAgent:true});startSampleAlerts(store,push);server.requestTimeout=120000;server.headersTimeout=15000;server.listen(Number(process.env.PORT||5180),process.env.HOST||'127.0.0.1',()=>console.log('Sunnyland Production service listening. Use an HTTPS reverse proxy for phones.'));}
