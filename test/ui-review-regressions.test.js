'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ui=require('../lib/ui'),auth=require('../lib/auth'),Controller=require('../lib/power-controller');
const lookup=(lang,key)=>key.split('.').reduce((v,k)=>v?.[k],require('../locales/'+lang+'.json'));
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const keys={ziggo_channel_up:'ChannelUp',ziggo_channel_down:'ChannelDown',ziggo_ok:'Enter',ziggo_back:'Escape',ziggo_nav_up:'ArrowUp',ziggo_nav_down:'ArrowDown',ziggo_nav_left:'ArrowLeft',ziggo_nav_right:'ArrowRight',...Object.fromEntries(Array.from({length:10},(_,i)=>['ziggo_digit_'+i,String(i)]))};
async function deviceHarness(lang){
 const listeners={},logs=[],unavailable=[],sends=[];let configError=null,sessionError=null,sendError=null;
 class Device{log(){}hasCapability(){return true;}registerCapabilityListener(k,f){listeners[k]=f;}getStoreValue(){}async setStoreValue(){}getData(){return{id:'synthetic'};}async setUnavailable(s){unavailable.push(s);}async setWarning(){}async unsetWarning(){}}
 const ziggo={getConfig:async()=>{if(configError)throw configError;return{};},sendKey:async(...args)=>{sends.push(args[4]);if(sendError)throw sendError;}};
 const box={module:{exports:{}},require:id=>id==='homey'?{Device}:id==='../../lib/ui'?ui:id==='../../lib/auth'?auth:id.includes('power-controller')?Controller:ziggo,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../drivers/ziggo_next/device.js'),'utf8'),box);
 const device=new box.module.exports();device.homey={__:k=>lookup(lang,k),app:{recordDiag:s=>logs.push(s)}};device.startStatusMonitor=async()=>{};
 device.ensureSessionLocked=async()=>{if(sessionError)throw sessionError;return{session:{},mqttToken:'SYNTHETIC',refreshed:false};};await device.onInit();
 return{device,listeners,logs,unavailable,sends,set configError(e){configError=e;},set sessionError(e){sessionError=e;},set sendError(e){sendError=e;}};
}
function viewHarness(mode,lang,options={}){
 const elements=new Map(),calls={emit:0,add:0,done:0};let click;
 const el=id=>{if(!elements.has(id))elements.set(id,{value:'',disabled:false,addEventListener:(_,f)=>{click=f;}});return elements.get(id);};
 const host={__:k=>lookup(lang,k),setTitle(){},emit(){calls.emit++;return options.emit?options.emit():Promise.resolve({data:{id:'synthetic'}});},createDevice(){calls.add++;return options.add?options.add():Promise.resolve();},done(){calls.done++;return options.done?options.done():Promise.resolve();}};
 const file='../drivers/ziggo_next/'+(mode==='pair'?'pair/ziggo_login.html':'repair/ziggo_repair.html');
 const source=fs.readFileSync(path.join(__dirname,file),'utf8').match(/<script type="application\/javascript">([\s\S]*?)<\/script>/)[1];vm.runInNewContext(source,{Homey:host,document:{getElementById:el}});
 const credentials=()=>{el('username').value='synthetic@example.invalid';el('password').value='SYNTHETIC_PASSWORD';};credentials();return{el,calls,click:()=>click(),credentials};
}
test('navigation labels are English/Dutch in both source metadata and generated manifest',()=>{
 const app=require('../app.json');for(const[id,en,nl]of [['up','Up','Omhoog'],['down','Down','Omlaag'],['left','Left','Links'],['right','Right','Rechts']]){const cap=require('../.homeycompose/capabilities/ziggo_nav_'+id+'.json');assert.equal(cap.title.en,en);assert.equal(cap.title.nl,nl);assert.deepEqual(app.capabilities['ziggo_nav_'+id].title,cap.title);}
});
for(const lang of ['en','nl']){
 test('all non-Power device controls sanitize transport failures without extra commands: '+lang,async()=>{
  const h=await deviceHarness(lang),original=Error('MQTT-fout: SYNTHETIC_PRIVATE_DETAIL');h.sendError=original;
  for(const[id,key]of Object.entries(keys)){await assert.rejects(h.listeners[id](),e=>e.message===lookup(lang,'errors.commandFailed')&&!e.message.includes('PRIVATE'));assert.equal(h.sends.at(-1),key);}
  assert.equal(h.sends.length,18);assert.equal(original.message,'MQTT-fout: SYNTHETIC_PRIVATE_DETAIL');assert.ok(!h.sends.includes('Power'));assert.equal(h.device.power.tx,null);await h.device.onDeleted();
 });
 test('successful non-Power controls retain original key routing: '+lang,async()=>{
  const h=await deviceHarness(lang);for(const id of Object.keys(keys))await h.listeners[id]();assert.deepEqual(h.sends,Object.values(keys));await h.device.onDeleted();
 });
 test('config and auth failures are localized before non-Power publication: '+lang,async()=>{
  const h=await deviceHarness(lang);h.configError=Error('SYNTHETIC_CONFIG');await assert.rejects(h.listeners.ziggo_nav_left(),e=>e.message===lookup(lang,'errors.commandFailed'));
  h.configError=null;const original=new auth.AuthError('session_missing','session',401);h.sessionError=original;
  await assert.rejects(h.listeners.ziggo_digit_1(),e=>e.message===lookup(lang,'auth.session_missing')&&e.kind===original.kind&&e.phase===original.phase&&e.status===401&&e.requiresRepair===true);
  assert.equal(h.sends.length,0);assert.notEqual(original.message,lookup('en','auth.session_missing'));await h.device.onDeleted();
 });
 test('Repair-required unavailability uses localized text and preserves original auth/retry diagnostics: '+lang,async()=>{
  const h=await deviceHarness(lang);for(const kind of ['session_missing','refresh_rejected','session_conflict']){const original=new auth.AuthError(kind,'session',401),message=original.message;const returned=await h.device.handleAuthFailure(original);assert.equal(returned,original);assert.equal(original.message,message);assert.equal(h.unavailable.at(-1),lookup(lang,'auth.'+kind));assert.equal(returned.requiresRepair,true);assert.equal(h.device.authUnavailable,true);assert.ok(h.logs.some(s=>s.includes('auth.failure')&&s.includes(kind)));}assert.equal(h.sends.length,0);assert.ok(h.device.authRetryTimer);await h.device.onDeleted();
 });
 for(const mode of ['pair','repair']){
  for(const sync of [false,true])test(mode+' finish failure retries only host completion, '+(sync?'sync':'async')+': '+lang,async()=>{
   let fail=true;const h=viewHarness(mode,lang,{done(){if(fail){if(sync)throw Error('PRIVATE_FINISH');return Promise.reject(Error('PRIVATE_FINISH'));}return Promise.resolve();}});
   h.click();await flush();assert.equal(h.calls.emit,1);assert.equal(h.calls.add,mode==='pair'?1:0);assert.equal(h.calls.done,1);assert.equal(h.el('password').value,'');assert.equal(h.el('status').textContent,lookup(lang,mode+'.finishFailed'));assert.equal(h.el(mode).textContent,lookup(lang,mode+'.finish'));assert.equal(h.el(mode).disabled,false);
   fail=false;h.click();h.click();await flush();assert.equal(h.calls.emit,1);assert.equal(h.calls.add,mode==='pair'?1:0);assert.equal(h.calls.done,2);assert.equal(h.el('status').textContent,lookup(lang,mode+'.done'));assert.equal(h.el(mode).disabled,true);
  });
  test(mode+' ignores concurrent submit clicks and clears password after success: '+lang,async()=>{
   const gate=deferred(),h=viewHarness(mode,lang,{emit:()=>gate.promise});h.click();h.click();await flush();assert.equal(h.calls.emit,1);assert.equal(h.calls.done,0);gate.resolve({data:{id:'synthetic'}});await flush();h.click();await flush();assert.equal(h.calls.emit,1);assert.equal(h.calls.add,mode==='pair'?1:0);assert.equal(h.calls.done,1);assert.equal(h.el('password').value,'');
  });
  test(mode+' sign-in/restore failure has contextual safe wording and allows deliberate retry: '+lang,async()=>{
   let fail=true;const h=viewHarness(mode,lang,{emit(){if(fail)throw Error('PRIVATE_SIGN_IN');return Promise.resolve({data:{id:'synthetic'}});}});h.click();await flush();assert.equal(h.el('status').textContent,lookup(lang,mode+'.failed'));assert.equal(h.el('password').value,'');assert.equal(h.el(mode).disabled,false);assert.equal(h.calls.done,0);fail=false;h.credentials();h.click();await flush();assert.equal(h.calls.emit,2);assert.equal(h.calls.add,mode==='pair'?1:0);assert.equal(h.calls.done,1);
  });
 }
 test('unconfirmed device creation never retries sign-in/add or claims completion: '+lang,async()=>{
  const h=viewHarness('pair',lang,{add:()=>Promise.reject(Error('PRIVATE_ADD'))});h.click();await flush();assert.equal(h.el('status').textContent,lookup(lang,'pair.addFailed'));assert.equal(h.el('password').value,'');assert.equal(h.el('pair').disabled,true);h.click();await flush();assert.deepEqual(h.calls,{emit:1,add:1,done:0});
 });
}
test('new device UI error boundaries fall back to English when translation lookup returns its key',async()=>{
 const h=await deviceHarness('en');h.device.homey.__=k=>k;h.sendError=Error('PRIVATE');await assert.rejects(h.listeners.ziggo_ok(),e=>e.message===lookup('en','errors.commandFailed'));await h.device.handleAuthFailure(new auth.AuthError('session_missing','session'));assert.equal(h.unavailable.at(-1),lookup('en','auth.session_missing'));await h.device.onDeleted();
});
