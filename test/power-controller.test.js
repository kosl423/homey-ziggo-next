'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PowerController = require('../lib/power-controller');
const tick = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; }
function harness({ initial = false, delayedPrepare = false, delayedAck = false, record = null } = {}) {
  let clock = 0, serial = 0;
  const timers = new Map(), publications = [], logs = [], journal = [];
  const prep = deferred(), ack = deferred();
  const c = new PowerController({
    now: () => clock,
    timers: { setTimeout: (fn,ms) => { const id=++serial;timers.set(id,{fn,at:clock+ms});return id; }, clearTimeout: id=>timers.delete(id) },
    preparationMs: 100, confirmationMs: 200, freshnessMs: 500, initializationMs: 100,
    journal: async r => {journal.push(r);}, log: (event,data)=>logs.push({event,...data}),
    prepare: async () => {
      if(delayedPrepare) await prep.promise;
      return async ({signal,onPublish}) => {
        if(signal.aborted) throw new Error('aborted');
        if(onPublish()===false) return;
        publications.push('Power');
        if(delayedAck) await ack.promise;
      };
    },
  });
  c.restore(record);c.connect(1);if(typeof initial==='boolean')c.observe(initial,{generation:1});
  return {c,prep,ack,publications,logs,journal,
    status:(v,meta={})=>c.observe(v,{generation:c.generation,...meta}),
    advance:async ms=>{clock+=ms;for(const [id,t]of [...timers])if(t.at<=clock){timers.delete(id);t.fn();}await tick();},
  };
}

for(const initial of [false,true]) test(`100 simultaneous ${initial?'OFF':'ON'} requests publish once`,async()=>{
  const h=harness({initial});const requests=Array.from({length:100},()=>h.c.request(!initial));
  await tick();assert.equal(h.publications.length,1);assert.equal(h.c.state,'waiting');
  h.status(initial);await tick();assert.equal(h.publications.length,1);
  h.status(!initial);await Promise.all(requests);assert.equal(h.c.state,'ready');h.c.close();
});

test('matching state is a noop; stale state rejects',async()=>{
  const h=harness();await h.c.request(false);assert.equal(h.publications.length,0);
  await h.advance(501);await assert.rejects(h.c.request(true),/actuele/);h.c.close();
});

test('opposite request after publication waits for original target',async()=>{
  const h=harness();const a=h.c.request(true);const rejected=assert.rejects(a,/vervangen/);
  await tick();const b=h.c.request(false);await rejected;await tick();assert.equal(h.publications.length,1);
  h.status(false);await tick();assert.equal(h.publications.length,1);
  h.status(true);await tick();assert.equal(h.publications.length,2);
  h.status(false);await b;assert.equal(h.c.state,'ready');h.c.close();
});

test('latest desired wins ON OFF ON, no queue of three toggles',async()=>{
  const h=harness();const a=h.c.request(true);const ra=assert.rejects(a,/vervangen/);await tick();
  const b=h.c.request(false);const rb=assert.rejects(b,/vervangen/);const last=h.c.request(true);
  await Promise.all([ra,rb]);h.status(true);await last;assert.equal(h.publications.length,1);h.c.close();
});

test('opposite before publish cancels original, with zero toggles',async()=>{
  const h=harness({delayedPrepare:true});const a=h.c.request(true);const ra=assert.rejects(a,/vervangen/);
  const b=h.c.request(false);h.prep.resolve();await Promise.all([ra,b]);assert.equal(h.publications.length,0);h.c.close();
});

test('remote changes state during preparation: no unnecessary toggle',async()=>{
  const h=harness({delayedPrepare:true});const a=h.c.request(true);h.status(true);h.prep.resolve();await a;
  assert.equal(h.publications.length,0);h.c.close();
});

test('status before publish ACK is remembered, does not release early',async()=>{
  const h=harness({delayedAck:true});const a=h.c.request(true);await tick();h.status(true);await tick();
  assert.equal(h.c.state,'waiting');h.ack.resolve();await a;assert.equal(h.publications.length,1);h.c.close();
});

test('subsequent opposite status invalidates early confirmation',async()=>{
  const h=harness({delayedAck:true});const a=h.c.request(true);const ra=assert.rejects(a,/bevestiging/);
  await tick();h.status(true);h.status(false);h.ack.resolve();await tick();assert.equal(h.c.state,'waiting');
  await h.advance(201);await ra;assert.equal(h.publications.length,1);h.c.close();
});

test('retained, duplicate, old generation and explicit stale statuses cannot confirm',async()=>{
  const h=harness();const a=h.c.request(true);await tick();
  for(const meta of [{retain:true},{dup:true},{generation:0},{stale:true}])assert.equal(h.status(true,meta),false);
  assert.equal(h.c.state,'waiting');h.status(true);await a;h.c.close();
});

test('retained initial status cannot enable a toggle',async()=>{
  const h=harness();h.c.disconnect(1);h.c.connect(2);h.status(false,{retain:true});
  const rejected=assert.rejects(h.c.request(true),/beginstatus/);await h.advance(101);await rejected;
  assert.equal(h.c.initialCandidate.value,false);assert.equal(h.publications.length,0);h.c.close();
});

test('missing confirmation fails without retry; late target recovers',async()=>{
  const h=harness();const a=h.c.request(true);const ra=assert.rejects(a,/bevestiging/);await tick();
  await h.advance(201);await ra;assert.equal(h.c.state,'uncertain');assert.equal(h.publications.length,1);
  await assert.rejects(h.c.request(true),/onbekend/);h.status(false);await tick();assert.equal(h.c.state,'uncertain');
  h.status(true);await tick();assert.equal(h.c.state,'ready');await h.c.request(true);assert.equal(h.publications.length,1);h.c.close();
});

test('preparation timeout cancels late work, never publishes',async()=>{
  const h=harness({delayedPrepare:true});const a=h.c.request(true);const ra=assert.rejects(a,/voorbereiding/);
  await h.advance(101);await ra;h.prep.resolve();await tick();assert.equal(h.publications.length,0);assert.equal(h.c.state,'ready');h.c.close();
});

test('disconnect after publish blocks until original target observed on new connection',async()=>{
  const h=harness();const a=h.c.request(true);const ra=assert.rejects(a,/verbroken/);await tick();
  h.c.disconnect(1);await ra;assert.equal(h.c.state,'uncertain');h.c.connect(2);
  h.status(true,{generation:1});h.status(true,{retain:true});await tick();assert.equal(h.c.state,'uncertain');
  h.status(true);await tick();assert.equal(h.c.state,'ready');assert.equal(h.publications.length,1);h.c.close();
});

test('transport error after publishing is uncertain and does not retry',async()=>{
  const h=harness({delayedAck:true});const a=h.c.request(true);const ra=assert.rejects(a,/verzending/);await tick();
  h.ack.reject(new Error('secret-token-do-not-log'));await ra;assert.equal(h.c.state,'uncertain');
  assert.equal(h.publications.length,1);assert.ok(!JSON.stringify(h.logs).includes('secret-token'));h.c.close();
});

test('raw Power joins central protection but duplicate raw press is rejected',async()=>{
  const h=harness();const a=h.c.toggle();await tick();await assert.rejects(h.c.toggle(),/geblokkeerd/);
  const b=h.c.request(true);h.status(true);await Promise.all([a,b]);assert.equal(h.publications.length,1);h.c.close();
});

test('persisted uncertain transaction never replays on restart',async()=>{
  const h=harness({initial:false,record:{id:'old',target:true}});assert.equal(h.c.state,'uncertain');
  await assert.rejects(h.c.request(false),/onbekend/);assert.equal(h.publications.length,0);
  h.status(true);await tick();assert.equal(h.c.state,'ready');assert.equal(h.publications.length,0);h.c.close();
});

test('close stops pending work and rejects callers',async()=>{
  const h=harness({delayedPrepare:true});const a=h.c.request(true);const ra=assert.rejects(a,/gestopt/);
  h.c.close();h.prep.resolve();await ra;await tick();assert.equal(h.publications.length,0);
});

test('journal failure before publication sends nothing',async()=>{
  const h=harness();h.c.journal=async()=>{throw new Error('store unavailable');};
  await assert.rejects(h.c.request(true),/verzending/);await tick();assert.equal(h.publications.length,0);h.c.close();
});

test('journal clear failure remains blocked until storage and target status recover',async()=>{
  const h=harness();let failClear=true;
  h.c.journal=async value=>{if(value===null&&failClear)throw new Error('store failed');};
  const a=h.c.request(true);const ra=assert.rejects(a,/journal/);await tick();h.status(true);await ra;
  assert.equal(h.c.state,'uncertain');await assert.rejects(h.c.request(false),/onbekend/);
  failClear=false;h.status(true);await tick();assert.equal(h.c.state,'ready');assert.equal(h.publications.length,1);h.c.close();
});

test('disconnect during preparation and reconnect do not resume cancelled request',async()=>{
  const h=harness({delayedPrepare:true});const a=h.c.request(true);const ra=assert.rejects(a,/verbroken/);
  h.c.disconnect(1);await ra;await tick();h.c.connect(2);h.status(false);h.prep.resolve();await tick();
  assert.equal(h.publications.length,0);assert.equal(h.c.state,'ready');h.c.close();
});

test('stale disconnect cannot invalidate a newer connection',async()=>{
  const h=harness();h.c.disconnect(1);h.c.connect(2);h.status(false);h.c.disconnect(1);
  assert.equal(h.c.connected,true);const a=h.c.request(true);await tick();h.status(true);await a;h.c.close();
});

test('power requests are blocked during failed journal cleanup',async()=>{
  const h=harness({delayedPrepare:true});const clear=deferred();h.c.journal=()=>clear.promise;
  const a=h.c.request(true);const ra=assert.rejects(a,/voorbereiding/);await h.advance(101);await ra;
  await assert.rejects(h.c.request(false),/onbekend/);clear.resolve();h.prep.resolve();await tick();
  assert.equal(h.publications.length,0);h.c.close();
});

test('missing state at boot rejects requests without any transport work',async()=>{
  const h=harness();h.c.disconnect(1);h.c.connect(2);
  const rejected=assert.rejects(h.c.request(true),/beginstatus/);await h.advance(101);await rejected;
  await assert.rejects(h.c.toggle(),/geblokkeerd/);
  assert.equal(h.publications.length,0);h.c.close();
});

test('new connection without close callback still invalidates pending transition',async()=>{
  const h=harness();const a=h.c.request(true);const ra=assert.rejects(a,/vervangen/);await tick();
  h.c.connect(2);await ra;assert.equal(h.c.state,'uncertain');h.status(true);await tick();
  assert.equal(h.c.state,'ready');assert.equal(h.publications.length,1);h.c.close();
});

test('seeded mixed event traces never publish while uncertain or replay requests',async()=>{
  let seed=9023;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  for(let run=0;run<100;run++){
    const h=harness();const results=[];
    for(let step=0;step<60;step++){
      const before=h.publications.length,wasUncertain=h.c.state==='uncertain';
      const event=rand()%7;
      if(event===0||event===1)results.push(h.c.request(event===1).catch(()=>{}));
      else if(event===2)h.status(Boolean(rand()%2));
      else if(event===3)h.status(Boolean(rand()%2),{retain:true});
      else if(event===4)await h.advance(210);
      else if(event===5){h.c.disconnect(h.c.generation);h.c.connect(h.c.generation+1);}
      else results.push(h.c.toggle().catch(()=>{}));
      await tick();
      if(wasUncertain&&event!==2)assert.equal(h.publications.length,before,'uncertain transaction cannot publish again');
      assert.equal(h.logs.filter(x=>x.event==='publish.begin').length,h.publications.length);
      assert.ok(h.c.waiters.every(w=>w.target===h.c.desired));
    }
    h.c.close();await Promise.all(results);
  }
});

test('100 requests during initialization share a single Power after live status',async()=>{
  const h=harness({initial:null});const requests=Array.from({length:100},()=>h.c.request(true));
  await tick();assert.equal(h.publications.length,0);h.status(false);await tick();assert.equal(h.publications.length,1);
  h.status(true);await Promise.all(requests);h.c.close();
});

test('contradictory initialization goals keep latest; matching live state is noop',async()=>{
  const h=harness({initial:null});const first=h.c.request(true);const ra=assert.rejects(first,/vervangen/);
  const last=h.c.request(false);h.status(false);await Promise.all([ra,last]);assert.equal(h.publications.length,0);h.c.close();
});

test('initialization deadline is not extended by repeated requests',async()=>{
  const h=harness({initial:null});const first=h.c.request(true);const ra=assert.rejects(first,/beginstatus/);
  await h.advance(80);const second=h.c.request(true);const rb=assert.rejects(second,/beginstatus/);
  await h.advance(21);await Promise.all([ra,rb]);h.status(false);await tick();
  assert.equal(h.publications.length,0);assert.equal(h.c.desired,null);h.c.close();
});

test('disconnect cancels initialization goals; reconnect does not replay them',async()=>{
  const h=harness({initial:null});const first=h.c.request(true);const ra=assert.rejects(first,/initialisatie/);
  h.c.disconnect(1);await ra;h.c.connect(2);h.status(false);await tick();assert.equal(h.publications.length,0);h.c.close();
});

test('retained candidate never overwrites a live state or confirms uncertain restart',async()=>{
  const h=harness({initial:null,record:{id:'old',target:true}});h.status(true,{retain:true});
  assert.equal(h.c.initialCandidate,null);assert.equal(h.c.state,'uncertain');
  h.status(true,{buffered:true});await tick();assert.equal(h.c.state,'uncertain');
  h.status(true);await tick();assert.equal(h.c.state,'ready');h.status(false,{retain:true});
  assert.equal(h.c.observed.value,true);assert.equal(h.c.initialCandidate,null);h.c.close();
});

test('raw Power cannot queue a blind toggle during initialization',async()=>{
  const h=harness({initial:null});await assert.rejects(h.c.toggle(),/geblokkeerd/);
  assert.equal(h.c.desired,null);assert.equal(h.publications.length,0);h.c.close();
});

test('close rejects queued initialization and late status cannot send Power',async()=>{
  const h=harness({initial:null});const p=h.c.request(true);const ra=assert.rejects(p,/gestopt/);
  h.c.close();h.status(false);await ra;await tick();assert.equal(h.publications.length,0);
});
