import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, sleep } from './helpers/app-sandbox.js';
async function boot() { const ctx=makeSandbox(); ctx.sandbox.PointerEvent=class {}; ctx.run(); await sleep(80); return ctx.sandbox.window.alphyBridge._test; }

test('a fast primary never spends the backup request', async () => {
  const {hedgedRequest}=await boot(); let backups=0;
  assert.equal(await hedgedRequest(async()=> 'direct', async()=>{backups++;return 'relay';},20),'direct');
  await sleep(30); assert.equal(backups,0);
});
test('a hanging primary cannot delay the working relay and is cancelled', async () => {
  const {hedgedRequest}=await boot(); let aborted=false;
  const primary=signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'));}));
  assert.equal(await hedgedRequest(primary,async()=> 'relay',10),'relay'); assert.equal(aborted,true);
});
test('a primary failure starts backup immediately; two failures remain an error', async () => {
  const {hedgedRequest}=await boot();
  const fail=async()=>{throw new Error('unavailable');};
  const start=Date.now(); assert.equal(await hedgedRequest(fail,async()=> 'relay',2000),'relay'); assert.ok(Date.now()-start<1000);
  await assert.rejects(hedgedRequest(fail,fail,10),/unavailable/);
});
test('touch suggestion activates before a delayed synthesized click, exactly once', async () => {
  const {bindSuggestActivation}=await boot(); const handlers={}; let opened=0;
  bindSuggestActivation({addEventListener:(name,fn)=>{handlers[name]=fn;}},()=>opened++);
  const e={pointerId:1,isPrimary:true,button:0,clientX:10,clientY:10,preventDefault(){}};
  handlers.pointerdown(e); assert.equal(opened,0); handlers.pointerup(e); assert.equal(opened,1);
  handlers.click({...e,detail:1}); assert.equal(opened,1);
});
test('scrolling a suggestion does not open it; keyboard activation still works', async () => {
  const {bindSuggestActivation}=await boot(); const handlers={}; let opened=0;
  bindSuggestActivation({addEventListener:(name,fn)=>{handlers[name]=fn;}},()=>opened++);
  const e={pointerId:1,isPrimary:true,button:0,clientX:10,clientY:10,preventDefault(){}};
  handlers.pointerdown(e); handlers.pointerup({...e,clientY:60}); handlers.click({...e,detail:1}); assert.equal(opened,0);
  handlers.click({...e,detail:0}); assert.equal(opened,1);
});

test('a failed first media sandbox is recreated for the next attempt', async () => {
  const ctx=makeSandbox(); const timers=[]; const original=ctx.sandbox.setTimeout;
  ctx.sandbox.setTimeout=(fn,ms,...args)=>ms===8000?(timers.push(fn),-1):original(fn,ms,...args);
  ctx.run(); await sleep(80);
  const get=ctx.sandbox.window.alphyBridge._test.liftwMediaBroker;
  const first=get(); assert.equal(get(),first);
  timers.shift()(); await assert.rejects(first.ready,/timeout/);
  const second=get(); assert.notEqual(second,first);
  timers.shift()(); await assert.rejects(second.ready,/timeout/);
});
