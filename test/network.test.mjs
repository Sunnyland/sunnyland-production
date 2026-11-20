import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {Store} from '../core.mjs';
import {createServer} from '../server.mjs';
import {parseAllowedPeers,peerIsAllowed} from '../network.mjs';

function cleanup(directory){const target=realpathSync(directory);const child=relative(realpathSync(tmpdir()),target);assert.ok(child&&!child.startsWith('..')&&!isAbsolute(child));rmSync(target,{recursive:true,force:true});}

test('backend peer gate uses the real socket and rejects spoofed forwarding headers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sunnyland-peer-'));
 const store=new Store();
 const server=createServer(store,{mediaDir:directory,allowedPeers:parseAllowedPeers('192.168.0.50')});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/health`,{headers:{'X-Forwarded-For':'192.168.0.50','Forwarded':'for=192.168.0.50'}});
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'Connection not permitted.'});
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();cleanup(directory);}
});

test('allowed proxy peer still requires staff authentication for application data',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'sunnyland-peer-'));
 const store=new Store();
 const peers=parseAllowedPeers('127.0.0.1,192.168.0.50,::1');
 assert.equal(peerIsAllowed('::ffff:192.168.0.50',peers),true);
 assert.equal(peerIsAllowed('192.168.0.114',peers),false);
 assert.throws(()=>parseAllowedPeers(''));
 assert.throws(()=>parseAllowedPeers('192.168.0.0/24'));
 assert.throws(()=>parseAllowedPeers('127.0.0.1,'));
 const server=createServer(store,{mediaDir:directory,allowedPeers:peers});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/api/state')).status,401);
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();cleanup(directory);}
});
