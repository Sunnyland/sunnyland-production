import {randomBytes,scryptSync} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store,need,str} from './core.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
export function provision(store,email,name){
 email=str(email,'email').toLowerCase();
 const existing=store.all('user').find(u=>u.email===email);
 if(existing)return {email:existing.email,role:existing.role,enabled:existing.enabled,passwordPending:existing.passwordPending===true};
 need(store.all('user').length===0,'First-manager provisioning is only available on an empty service.');
 store.db.exec('BEGIN IMMEDIATE');
 try{need(store.all('user').length===0,'A staff account was already created.');
  const user=store.user(email,randomBytes(48).toString('base64url'),'manager',name);
  user.enabled=false;user.passwordPending=true;user.createdAt=new Date().toISOString();store.put('user',user);
  const catalogue=JSON.parse(readFileSync(join(root,'catalog.json'),'utf8'));for(const c of catalogue)if(!store.get('stock',c.inv))store.put('stock',{...c,id:c.inv});
  store.audit({id:'local-setup'},'manager_provisioned',user.id,{email,enabled:false,passwordPending:true});store.db.exec('COMMIT');
  return {email,role:user.role,enabled:false,passwordPending:true,catalogueItems:catalogue.length};
 }catch(e){store.db.exec('ROLLBACK');throw e;}
}
export function activate(store,email,password){
 need(typeof password==='string'&&password.length>=14&&password.length<=200,'Use a password of at least 14 characters.');
 store.db.exec('BEGIN IMMEDIATE');
 try{const user=store.all('user').find(u=>u.email===email.toLowerCase());need(user&&user.passwordPending===true&&user.enabled===false,'This account is not waiting for its first password. Existing passwords are not changed by this setup.');
  user.salt=randomBytes(16).toString('hex');user.password=scryptSync(password,user.salt,64).toString('hex');user.enabled=true;user.passwordPending=false;user.activatedAt=new Date().toISOString();store.put('user',user);store.audit({id:'local-setup'},'manager_activated',user.id,{email:user.email});store.db.exec('COMMIT');return {email:user.email,enabled:true,role:user.role};
 }catch(e){store.db.exec('ROLLBACK');throw e;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const data=process.env.SUNNYLAND_DATA||join(root,'data');mkdirSync(data,{recursive:true});const store=new Store(join(data,'production.sqlite'));
 try{const command=process.argv[2];if(command==='prepare')console.log(JSON.stringify(provision(store,process.argv[3],process.argv[4]||process.argv[3])));
  else if(command==='activate'){let input='';for await(const chunk of process.stdin){input+=chunk;need(input.length<5000,'Invalid setup input.');}const body=JSON.parse(input);console.log(JSON.stringify(activate(store,body.email,body.password)));}
  else if(command==='status'){const u=store.all('user').find(u=>u.email===process.argv[3]);console.log(JSON.stringify(u?{email:u.email,role:u.role,enabled:u.enabled,passwordPending:u.passwordPending===true}:{exists:false}));}
  else throw new Error('Use prepare EMAIL NAME, status EMAIL, or activate (JSON on stdin).');
 }catch(e){console.error(e.message);process.exitCode=1;}finally{store.close();}
}
