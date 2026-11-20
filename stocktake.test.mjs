import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from './core.mjs';
import {stocktakeMonth} from './consignment.mjs';
import {randomUUID} from 'node:crypto';

function setup(t) {
  const s=new Store(); t.after(()=>s.close()); const a={id:'operator',role:'operator'};
  s.put('stock',{id:'paper'});
  const month=stocktakeMonth();
  const act=(type,data,key=randomUUID())=>s.action(a,key,type,data);
  const count=(fields={},key)=>act('count',{id:'P',stock:'paper',owner:'consignment',location:'Bay A',
    packaging:'flagged',opened:false,sheets:20000,revision:s.get('lot','P')?.revision??0,
    reason:'Physical stocktake',stocktakeMonth:month,...fields},key);
  return {s,a,act,count,month};
}
test('sealed, opened, exact half, idempotent retry, recount, return to higher balance',t=>{
  const {s,count,a,month}=setup(t);
  assert.equal(count().owner,'consignment');
  assert.equal(count({opened:true,sheets:10001}).owner,'consignment');
  const data={opened:true,sheets:10000,revision:2};
  assert.equal(count(data,'same').owner,'owned');
  assert.equal(count(data,'same').owner,'owned');
  assert.equal(s.summary('paper').physical,10000);assert.equal(s.summary('paper').consignment,0);
  assert.equal(s.snapshot(a).consignmentTransfers.length,1);
  assert.equal(s.snapshot(a).consignmentOpenings.length,1);
  assert.equal(s.snapshot(a).consignmentCounts.length,1);
  assert.equal(s.snapshot(a).consignmentCounts[0].month,month);
  assert.throws(()=>count({sheets:20000}),/no longer consignment/);
  assert.equal(count({owner:'owned',stocktakeMonth:undefined,opened:true,sheets:14000}).owner,'owned');
  assert.equal(s.all('consignmentTransfer').length,1);
});
test('stock issued to job triggers transfer once and keeps physical totals',t=>{
  const {s,act,count}=setup(t);
  count(); s.put('job',{id:'J1',sections:[{id:'press',stocks:['paper']}],active:true,verifiedAt:new Date().toISOString()});
  const issue={job:'J1',section:'press',stock:'paper',sheets:10000};
  const plan=act('issue',{...issue,preview:true});assert.equal(s.all('consignmentTransfer').length,0);
  const data={...issue,confirmedLots:plan.picks};
  act('issue',data,'issue-once');act('issue',data,'issue-once');
  assert.equal(s.summary('paper').owned,10000);assert.equal(s.all('issue').length,1);
  assert.equal(s.all('consignmentTransfer').length,1);
});
test('legacy open lot needs full size; invalid count, stale revision and wrong month roll back',t=>{
  const {s,count}=setup(t);
  const old={id:'P',revision:1,stock:'paper',location:'Bay A',owner:'consignment',packaging:'flagged',opened:true,sheets:7000};
  s.put('lot',old);
  assert.throws(()=>count({opened:true,sheets:7000}),/original full-pallet/);
  assert.throws(()=>count({opened:true,sheets:7000,originalSheets:20000,revision:0}),/changed/);
  assert.throws(()=>count({opened:true,sheets:7000,originalSheets:20000,stocktakeMonth:'2000-01'}),/month changed/);
  assert.deepEqual(s.get('lot','P'),old); assert.equal(s.all('consignmentCount').length,0);
  assert.equal(count({opened:true,sheets:7000,originalSheets:20000}).owner,'owned');
});
test('odd size, zero remaining, ordinary consignment and Melbourne month rollover',t=>{
  const {count,s}=setup(t);
  count({sheets:101});assert.equal(count({opened:true,sheets:51}).owner,'consignment');
  assert.equal(count({opened:true,sheets:50}).owner,'owned');
  assert.equal(count({id:'Q',revision:0,opened:true,sheets:0,originalSheets:20000}).owner,'owned');
  assert.equal(count({id:'R',revision:0,packaging:'wrapped',opened:true,sheets:20}).owner,'consignment');
  assert.equal(s.summary('paper').physical,70);
  assert.equal(stocktakeMonth(new Date('2026-11-30T13:01:00Z')),'2026-12');
});
test('receipts keep delivered size and waste triggers exactly one ownership transfer',t=>{
  const {s,act}=setup(t);
  const data={id:'N',reference:'DEL-1',location:'Warehouse',stock:'paper',owner:'consignment',packaging:'flagged',
    opened:false,packs:20,per:1000,loose:0};
  act('receipt',data);
  assert.equal(s.get('lot','N').originalSheets,20000);
  act('waste',{lot:'N',sheets:9999,reason:'Damaged'});
  assert.equal(s.summary('paper').consignment,10001);
  act('waste',{lot:'N',sheets:1,reason:'Damaged'});
  assert.equal(s.summary('paper').owned,10000);
  assert.equal(s.all('consignmentOpening').length,1);
  assert.equal(s.all('consignmentTransfer').length,1);
  assert.equal(s.all('outbox').length,0);
});
