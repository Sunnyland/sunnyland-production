import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,barcode,stockBarcodeValue} from '../core.mjs';
import {createServer} from '../server.mjs';

test('stock barcode keys preserve GS1 field separators, long payloads and leading zeros',()=>{
  const a='010931234567890010BATCH\u001d211234';
  for(const code of [a,'00001234','A+B&x=2%23/#','P'.repeat(1024),'é'.repeat(512)]) {
    assert.equal(barcode([code,code],stockBarcodeValue),code);
  }
  assert.throws(()=>barcode([a,a.replace('\u001d','')],stockBarcodeValue),/Different/);
  for(const code of ['', '\u001d', 'A\nB','A\u0000B','\u007f','\u0085','é'.repeat(513)]) {
    assert.throws(()=>stockBarcodeValue(code));
  }
  assert.throws(()=>barcode([a])); // The job ticket parser keeps its existing contract.
});

test('stock lookup returns a fresh balance only for a requested, unique barcode match',async t=>{
  const s=new Store(), dir=mkdtempSync(join(tmpdir(),'scanner-formats-'));
  const server=createServer(s,{mediaDir:dir});
  t.after(()=>{server.close();s.close();rmSync(dir,{recursive:true,force:true});});
  const password='local-scanner-test-1234';
  const staff=s.user('scanner@example.test',password,'manager');
  const token=s.login(staff.email,password).token;
  const gs='010931234567890010BATCH\u001d21A+B&=/%';
  s.put('stock',{id:'0001',supplier_ref:'one'});
  s.action(staff,'link','alias',{code:gs,stock:'0001'});
  s.action(staff,'count','count',{id:'p1',owner:'owned',packaging:'wrapped',opened:false,sheets:123,location:'Bay B',stock:'0001',reason:'Test count'});
  async function request(code,includeBalance, credential=token) {
    const req=Readable.from([]);req.url='/api/resolve?code='+encodeURIComponent(code)+(includeBalance?'&balance=1':'');
    req.method='GET';req.socket={remoteAddress:'127.0.0.1'};req.headers={host:'localhost',authorization:'Bearer '+credential};
    return new Promise(resolve=>{let status;server.emit('request',req,{writeHead(code){status=code;},end(body){resolve({status,data:JSON.parse(body)});}});});
  }
  const hit=await request(gs,true);assert.equal(hit.status,200);assert.equal(hit.data.code,gs);
  assert.deepEqual(hit.data.matches.map(r=>r.id),['0001']);assert.equal(hit.data.balance.physical,123);
  assert.equal(hit.data.balance.lots[0].location,'Bay B');assert.equal(hit.data.balance.owned,123);
  assert.equal((await request(gs,false)).data.balance,undefined);
  assert.deepEqual((await request(gs.replace('\u001d',''),true)).data.matches,[]);
  assert.equal((await request(gs,true,'invalid')).status,401);
  s.put('stock',{id:'0002',supplier_ref:gs});const ambiguous=await request(gs,true);
  assert.equal(ambiguous.data.matches.length,2);assert.equal(ambiguous.data.balance,undefined);
});
