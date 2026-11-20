import {Store,need} from './core.mjs';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url)),data=process.env.SUNNYLAND_DATA||join(root,'data');mkdirSync(data,{recursive:true});
const store=new Store(join(data,'production.sqlite'));
try{
 const email=process.env.SUNNYLAND_USER_EMAIL,password=process.env.SUNNYLAND_USER_PASSWORD;
 need(email&&password,'Set SUNNYLAND_USER_EMAIL and SUNNYLAND_USER_PASSWORD for the staff account to create. No default password is supplied.');
 const role=store.all('user').length?(process.env.SUNNYLAND_USER_ROLE||'operator'):'manager';store.user(email,password,role,process.env.SUNNYLAND_USER_NAME||email);
 const catalogue=JSON.parse(readFileSync(join(root,'catalog.json'),'utf8'));for(const c of catalogue)if(!store.get('stock',c.inv))store.put('stock',{...c,id:c.inv});
 console.log(`Staff account created with role ${role}; ${catalogue.length} catalogue records loaded. No physical balances were assumed.`);
}finally{store.close();}
