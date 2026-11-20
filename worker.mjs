import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store,need} from './core.mjs';
import {PrintIQ} from './printiq.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
export function sendMail(entry){return new Promise(resolve=>{const p=spawn(process.env.PYTHON||'python3',[join(root,'mail_transport.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='';p.stdout.on('data',b=>{output+=b;if(output.length>10000)p.kill();});p.stderr.resume();p.on('error',()=>resolve({state:'blocked',receipt:{reason:'Python mail transport could not start.'}}));const timeout=setTimeout(()=>p.kill(),120000);p.on('close',()=>{clearTimeout(timeout);try{const r=JSON.parse(output);need(['accepted','rejected','uncertain','blocked'].includes(r.state),'Invalid mail result.');resolve(r);}catch{resolve({state:'uncertain',receipt:{reason:'Mail process ended without a verifiable receipt.'}});}});p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify({id:entry.id,event:JSON.parse(entry.body)}));});}
export async function drain(store,{iq=new PrintIQ(),mail=sendMail}={}){
 const results=[];
 // A crashed or timed-out worker must never cause a blind resend.
 store.db.prepare("UPDATE outbox SET state='uncertain' WHERE state='sending' AND json_extract(receipt,'$.startedAt') < ?").run(new Date(Date.now()-600000).toISOString());
 const pending=store.db.prepare("SELECT * FROM outbox WHERE state='pending' ORDER BY created LIMIT 100").all();
 for(const entry of pending){const event=JSON.parse(entry.body);if(entry.channel==='mail'&&['sample_ready','sample_reminder'].includes(event.kind)&&store.get('sample',entry.entity)?.state!=='pending'){store.db.prepare("UPDATE outbox SET state='cancelled' WHERE id=? AND state='pending'").run(entry.id);continue;}
  const changed=store.db.prepare("UPDATE outbox SET state='sending',receipt=? WHERE id=? AND state='pending'").run(JSON.stringify({startedAt:new Date().toISOString()}),entry.id);if(!changed.changes)continue;
  let result;try{result=entry.channel==='mail'?await mail(entry):await iq.deliver(entry,store);}catch(e){result={state:'blocked',receipt:{reason:e.message}};}
  store.db.prepare("UPDATE outbox SET state=?,receipt=? WHERE id=? AND state='sending'").run(result.state,JSON.stringify(result.receipt),entry.id);results.push({id:entry.id,...result});
 }
 return results;
}
export async function reconcile(store,iq=new PrintIQ()){const rows=store.db.prepare("SELECT * FROM outbox WHERE state='uncertain' AND channel='printiq'").all();for(const row of rows){const r=await iq.deliver(row,store,{reconcileOnly:true});if(r.state==='accepted')store.db.prepare("UPDATE outbox SET state=?,receipt=? WHERE id=? AND state='uncertain'").run(r.state,JSON.stringify(r.receipt),row.id);}return rows.length;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const s=new Store(join(process.env.SUNNYLAND_DATA||join(root,'data'),'production.sqlite'));try{if(process.env.REMINDER_HOURS)s.reminders(Number(process.env.REMINDER_HOURS));if(process.argv.includes('--reconcile'))await reconcile(s);else console.log(JSON.stringify(await drain(s)));}finally{s.close();}}
