'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const PowerController=require('../lib/power-controller');
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

function transport({ delaySubscribe = false } = {}) {
  const clients=[],published=[];let timer;
  class Client extends EventEmitter {
    end(){this.ended=true;}
    publish(topic,payload,opts,cb){published.push({topic,payload:JSON.parse(payload),opts,cb});}
    subscribe(topic,opts,cb){this.topic=topic;this.subscribeCallback=cb;if(!delaySubscribe)cb(null);}
  }
  const sandbox={module:{exports:{}},require:id=>{
    if(id==='mqtt')return {connect:()=>{const c=new Client();clients.push(c);return c;}};
    if(id==='ws')return class {constructor(){throw new Error('Network forbidden in test');}};
    if(id==='node:crypto')return require(id);
    throw new Error('Unexpected import '+id);
  },fetch:()=>{throw new Error('Network forbidden in test');},URL,Buffer,
  setTimeout:fn=>{timer=fn;return 1;},clearTimeout:()=>{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../lib/ziggo.js'),'utf8'),sandbox);
  return {api:sandbox.module.exports,clients,published,timeout:()=>timer(),config:{mqttBroker:{URL:'wss://fake.invalid'}},session:{householdId:'test-household'}};
}

test('transport retains existing wire contract, no retries or real network',async()=>{
  const h=transport();let started=0;
  const p=h.api.sendKey(h.config,h.session,'box','mock-token','Power',{onPublish:()=>{started++;return true;}});
  h.clients[0].emit('connect');assert.equal(started,1);assert.equal(h.published.length,1);
  const entry=h.published[0];assert.equal(entry.opts.retain,true);assert.equal(entry.opts.qos,2);
  assert.equal(entry.payload.status.w3cKey,'Power');assert.equal(entry.payload.type,'CPE.KeyEvent');
  entry.cb(null);await p;assert.equal(h.clients[0].ended,true);
});

test('timeout prevents late connect from publishing',async()=>{
  const h=transport();const p=h.api.sendKey(h.config,h.session,'box','mock','Power');const rejected=assert.rejects(p,/12 seconden/);
  h.timeout();await rejected;h.clients[0].emit('connect');assert.equal(h.published.length,0);
});

test('abort before connect prevents later publication',async()=>{
  const h=transport();const ac=new AbortController();
  const p=h.api.sendKey(h.config,h.session,'box','mock','Power',{signal:ac.signal});const rejected=assert.rejects(p,/geannuleerd/);
  ac.abort();await rejected;h.clients[0].emit('connect');assert.equal(h.published.length,0);
});

test('last-minute guard cancels Power at transport boundary',async()=>{
  const h=transport();const p=h.api.sendKey(h.config,h.session,'box','mock','Power',{onPublish:()=>false});
  h.clients[0].emit('connect');await p;assert.equal(h.published.length,0);
});

test('status monitor carries retain/dup, ignores other topics and malformed JSON',()=>{
  const h=transport(),seen=[],errors=[];let ready=0;
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{
    onSubscribed:()=>ready++,onStatus:(value,meta)=>seen.push({value,meta}),onError:e=>errors.push(e.message),
  });
  client.emit('connect');assert.equal(ready,1);
  client.emit('message','test-household/other/status',Buffer.from('{}'),{});
  client.emit('message',client.topic,Buffer.from('{bad'),{});assert.equal(errors.length,1);
  client.emit('connect'); // malformed input invalidates the old generation
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_RUNNING"}'),{retain:true,dup:true,qos:0});
  assert.equal(seen.length,1);assert.equal(seen[0].meta.retain,true);assert.equal(seen[0].meta.dup,true);
});

function deviceHarness() {
  const listeners={},writes=[],calls=[],monitors=[],logs=[],warnings=[],store={},cap={onoff:false};
  class Device {
    log(){}error(){}hasCapability(){return true;}
    registerCapabilityListener(id,fn){listeners[id]=fn;}
    getData(){return {id:'box'};}
    getStoreValue(key){return store[key];}
    async setStoreValue(key,value){store[key]=value;}
    getCapabilityValue(key){return cap[key];}
    async setCapabilityValue(key,value){writes.push(value);cap[key]=value;}
    async setWarning(value){warnings.push(value);}
    async unsetWarning(){warnings.push(null);}
  }
  const ziggo={getConfig:async()=>({}),monitorStatus:(a,b,c,d,handlers)=>{
    monitors.push(handlers);return {end(){}};
  },sendKey:async(a,b,c,d,key,options)=>{
    if(options?.onPublish?.()===false)return;
    calls.push(key);
  }};
  const sandbox={module:{exports:{}},require:id=>id==='homey'?{Device}:id.includes('power-controller')?PowerController:ziggo,
    setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../drivers/ziggo_next/device.js'),'utf8'),sandbox);
  const d=new sandbox.module.exports();d.homey={app:{recordDiag:x=>logs.push(x)}};
  d.ensureSessionLocked=async()=>({session:{},mqttToken:'mock'});
  return {d,listeners,writes,calls,monitors,logs,warnings,store,ziggo,
    status:(state,metadata={})=>monitors.at(-1).onStatus({state,source:'box'},metadata)};
}

test('Homey on/off Flow listener and raw Power share one gate',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const m=h.monitors[0];m.onConnect();m.onSubscribed();h.status('ONLINE_STANDBY');
  const a=h.listeners.onoff(true),b=h.listeners.onoff(true);await flush();assert.deepEqual(h.calls,['Power']);
  await assert.rejects(h.listeners.ziggo_power(),/geblokkeerd/);h.status('ONLINE_RUNNING');await Promise.all([a,b]);
  await h.listeners.onoff(true);assert.deepEqual(h.calls,['Power']);
  const raw=h.listeners.ziggo_power();await flush();assert.deepEqual(h.calls,['Power','Power']);
  h.status('ONLINE_STANDBY');await raw;await flush();assert.deepEqual(h.writes,[true,false]);
  await h.d.onDeleted();
});

test('device retained status cannot confirm and wrong source is ignored',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const m=h.monitors[0];m.onConnect();m.onSubscribed();h.status('ONLINE_STANDBY');
  const a=h.listeners.onoff(true);await flush();h.status('ONLINE_RUNNING',{retain:true});
  m.onStatus({state:'ONLINE_RUNNING',source:'another-box'},{});await flush();assert.equal(h.d.power.state,'waiting');assert.equal(h.writes.length,0);
  h.status('ONLINE_RUNNING');await a;await h.d.onDeleted();
});

test('device reconnect discards old monitor callbacks and resumes without replay',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const old=h.monitors[0];old.onConnect();old.onSubscribed();h.status('ONLINE_STANDBY');
  const a=h.listeners.onoff(true);const ra=assert.rejects(a,/verbroken/);await flush();old.onClose();await ra;
  await h.d.startStatusMonitor();const current=h.monitors[1];current.onConnect();current.onSubscribed();
  old.onStatus({state:'ONLINE_RUNNING',source:'box'},{});assert.equal(h.d.power.state,'uncertain');
  h.status('ONLINE_RUNNING',{retain:true});assert.equal(h.d.power.state,'uncertain');
  h.status('ONLINE_RUNNING');await flush();assert.equal(h.d.power.state,'ready');assert.deepEqual(h.calls,['Power']);
  await h.d.onUninit();assert.equal(h.d.power.closed,true);
});

test('controller and transport cancel a request changed during MQTT connect',async()=>{
  const h=transport();const c=new PowerController({journal:async()=>{},prepare:async()=>opts=>h.api.sendKey(h.config,h.session,'box','mock','Power',opts)});
  c.connect(1);c.observe(false,{generation:1});
  const a=c.request(true);const ra=assert.rejects(a,/vervangen/);await flush();
  const b=c.request(false);h.clients[0].emit('connect');await Promise.all([ra,b]);assert.equal(h.published.length,0);c.close();
});

test('late socket error after abort is handled',async()=>{
  const h=transport();const ac=new AbortController();
  const p=h.api.sendKey(h.config,h.session,'box','mock','Power',{signal:ac.signal});const ra=assert.rejects(p,/geannuleerd/);
  ac.abort();await ra;assert.doesNotThrow(()=>h.clients[0].emit('error',new Error('late socket error')));assert.equal(h.published.length,0);
});

test('remote status remains mirrored with no persistent desired-state enforcement',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const m=h.monitors[0];m.onConnect();m.onSubscribed();
  h.status('ONLINE_RUNNING');await flush();h.status('ONLINE_STANDBY');await flush();
  assert.deepEqual(h.writes,[true,false]);assert.deepEqual(h.calls,[]);await h.d.onDeleted();
});

test('diagnostic writes are serialized and bounded to 250 entries',async()=>{
  const writes=[],pending=[],data={diagnosticLog:[]};let active=0,maxActive=0;
  class App {log(){}}
  const sandbox={module:{exports:{}},require:()=>({App}),Promise,Date};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app.js'),'utf8'),sandbox);
  const app=new sandbox.module.exports();app.homey={settings:{get:key=>data[key],set:async(key,value)=>{
    active++;maxActive=Math.max(maxActive,active);await Promise.resolve();data[key]=value;writes.push(value);active--;
  }}};
  for(let i=0;i<300;i++)app.recordDiag('event '+i);
  await app.diagnosticWrite;assert.equal(maxActive,1);assert.equal(data.diagnosticLog.length,250);
  assert.match(data.diagnosticLog.at(-1),/event 299$/);assert.equal(writes[0].length,1);
});

test('invalid session during Power preparation never publishes',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const m=h.monitors[0];m.onConnect();m.onSubscribed();h.status('ONLINE_STANDBY');
  h.d.ensureSessionLocked=async()=>{throw new Error('Bearer secret-value');};
  await assert.rejects(h.listeners.onoff(true),/voorbereiding/);await flush();
  assert.deepEqual(h.calls,[]);assert.ok(!h.logs.join('\n').includes('secret-value'));await h.d.onDeleted();
});

test('unchanged status on continuous connection remains usable after long viewing',async()=>{
  let clock=0,publications=0;
  const c=new PowerController({now:()=>clock,journal:async()=>{},prepare:async()=>async({onPublish})=>{if(onPublish()!==false)publications++;}});
  c.connect(1);c.observe(true,{generation:1});clock=4*60*60*1000;
  const p=c.request(false);await flush();assert.equal(publications,1);c.observe(false,{generation:1});await p;c.close();
});

test('early MQTT messages buffer and drain after SUBACK in order',()=>{
  const h=transport({delaySubscribe:true}),events=[];
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{
    onSubscribed:()=>events.push('ready'),onStatus:(message,meta)=>events.push([message.state,meta.buffered,meta.retain]),
  });
  client.emit('connect');
  for(const [state,retain]of [['ONLINE_STANDBY',true],['ONLINE_RUNNING',false],['ONLINE_STANDBY',false]]){
    client.emit('message',client.topic,Buffer.from(JSON.stringify({state})),{retain});
  }
  assert.deepEqual(events,[]);client.subscribeCallback(null,[{qos:0}]);
  assert.deepEqual(events,['ready',['ONLINE_STANDBY',true,true],['ONLINE_RUNNING',true,false],['ONLINE_STANDBY',true,false]]);
});

test('failed SUBACK discards the buffer without processing a status',()=>{
  const h=transport({delaySubscribe:true}),seen=[],errors=[];
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{onStatus:x=>seen.push(x),onError:e=>errors.push(e)});
  client.emit('connect');client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_STANDBY"}'),{});
  client.subscribeCallback(null,[{qos:128}]);assert.equal(seen.length,0);assert.equal(errors.length,1);
});

test('old subscription callback and buffer cannot contaminate reconnect',()=>{
  const h=transport({delaySubscribe:true}),seen=[];
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{onStatus:x=>seen.push(x.state)});
  client.emit('connect');const oldAck=client.subscribeCallback;
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_RUNNING"}'),{});
  client.emit('close');client.emit('connect');oldAck(null,[{qos:0}]);assert.equal(seen.length,0);
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_STANDBY"}'),{});
  client.subscribeCallback(null,[{qos:0}]);assert.deepEqual(seen,['ONLINE_STANDBY']);
});

test('buffer overflow fails initialization rather than trusting a partial sequence',()=>{
  const h=transport({delaySubscribe:true}),seen=[],errors=[];let ready=0;
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{onStatus:x=>seen.push(x),onError:e=>errors.push(e),onSubscribed:()=>ready++});
  client.emit('connect');for(let i=0;i<101;i++)client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_STANDBY"}'),{});
  client.subscribeCallback(null,[{qos:0}]);assert.equal(ready,0);assert.equal(seen.length,0);assert.equal(errors.length,1);
});

test('device request before SUBACK uses final buffered live state, no needless Power',async()=>{
  const h=deviceHarness(),wire=transport({delaySubscribe:true});
  h.ziggo.monitorStatus=(...args)=>wire.api.monitorStatus(wire.config,wire.session,'box','mock',args.at(-1));
  await h.d.onInit();await flush();const client=wire.clients[0];client.emit('connect');
  const p=h.listeners.onoff(true);
  for(const state of ['ONLINE_STANDBY','ONLINE_RUNNING']){
    client.emit('message',client.topic,Buffer.from(JSON.stringify({state,source:'box'})),{retain:false});
  }
  assert.deepEqual(h.calls,[]);client.subscribeCallback(null,[{qos:0}]);await p;await flush();
  assert.deepEqual(h.calls,[]);assert.deepEqual(h.writes,[true]);await h.d.onDeleted();
});

test('device boot retained candidate waits for live initialization before Power',async()=>{
  const h=deviceHarness(),wire=transport({delaySubscribe:true});
  h.ziggo.monitorStatus=(...args)=>wire.api.monitorStatus(wire.config,wire.session,'box','mock',args.at(-1));
  await h.d.onInit();await flush();const client=wire.clients[0];client.emit('connect');const p=h.listeners.onoff(true);
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_STANDBY","source":"box"}'),{retain:true});
  client.subscribeCallback(null,[{qos:0}]);await flush();assert.deepEqual(h.calls,[]);assert.equal(h.d.power.initialCandidate.value,false);
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_STANDBY","source":"box"}'),{retain:false});
  await flush();assert.deepEqual(h.calls,['Power']);
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_RUNNING","source":"box"}'),{retain:true});
  await flush();assert.equal(h.d.power.state,'waiting');
  client.emit('message',client.topic,Buffer.from('{"state":"ONLINE_RUNNING","source":"box"}'),{retain:false});
  await p;await h.d.onDeleted();
});

test('socket closes before SUBACK: queued Homey request is cancelled without replay',async()=>{
  const h=deviceHarness(),wire=transport({delaySubscribe:true});
  h.ziggo.monitorStatus=(...args)=>wire.api.monitorStatus(wire.config,wire.session,'box','mock',args.at(-1));
  await h.d.onInit();await flush();const client=wire.clients[0];client.emit('connect');
  const p=h.listeners.onoff(true);const rejected=assert.rejects(p,/initialisatie/);
  const oldAck=client.subscribeCallback;client.emit('close');await rejected;oldAck(null,[{qos:0}]);
  await flush();assert.deepEqual(h.calls,[]);assert.equal(h.d.power.desired,null);await h.d.onDeleted();
});

test('malformed message before SUBACK invalidates that subscription generation',()=>{
  const h=transport({delaySubscribe:true});let ready=0;
  const client=h.api.monitorStatus(h.config,h.session,'box','mock',{onSubscribed:()=>ready++});
  client.emit('connect');client.emit('message',client.topic,Buffer.from('{malformed'),{});
  client.subscribeCallback(null,[{qos:0}]);assert.equal(ready,0);
});

test('retained-only initialization warns clearly; valid live status clears warning',async()=>{
  const h=deviceHarness();await h.d.onInit();await flush();const m=h.monitors[0];m.onConnect();m.onSubscribed();
  h.status('ONLINE_STANDBY',{retain:true});await flush();assert.match(h.warnings.at(-1),/live status/);
  assert.deepEqual(h.calls,[]);h.status('ONLINE_STANDBY');await flush();assert.equal(h.warnings.at(-1),null);
  await h.d.onDeleted();
});
