const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto').webcrypto;

const clientSource = fs.readFileSync('cloud-connection.js', 'utf8');
const storageSource = fs.readFileSync('hermes-plugin/dashboard/dist/storage-transport.js', 'utf8');
const recoverySource = fs.readFileSync('hermes-plugin/dashboard/dist/turn-recovery.js', 'utf8');
const connectorSource = fs.readFileSync('hermes-plugin/dashboard/dist/connector.js', 'utf8');
const APP = 'https://agent-hub-theta-five.vercel.app';

test('synthesis cancellation is request/chat correlated and awaits acknowledgement', async () => {
  const h=clientHarness();const popup=await readyClientVoice(h);const controller=new AbortController();
  const pending=h.api.synthesize({text:'hola',chatId:'chat_1',signal:controller.signal});
  const request=h.sent.find(x=>x.data.type==='synthesize').data;
  controller.abort();
  const cancel=h.sent.find(x=>x.data.type==='cancel-voice').data;
  assert.equal(cancel.requestId,request.requestId);assert.equal(cancel.chatId,'chat_1');
  h.receive(popup,{type:'result',requestId:request.requestId,ok:false,error:'cancelled'});
  await assert.rejects(pending,/cancelled/);h.api.closeVoice();
});
test('connector cancels only the matching synthesis and sanitizes upstream failures', async () => {
  let signal;
  const h=connectorHarness({voiceResponder:(_url,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('INTERNAL_TEST_DETAIL'))));}});
  await readyConnector(h);
  const task=h.send({type:'synthesize',requestId:'synth_cancel',chatId:'chat_1',text:'hola'});await flush();
  await h.send({type:'cancel-voice',requestId:'synth_cancel',chatId:'wrong_chat'});assert.equal(signal.aborted,false);
  await h.send({type:'cancel-voice',requestId:'synth_cancel',chatId:'chat_1'});await task;
  assert.equal(signal.aborted,true);assert.equal(JSON.stringify(h.posts).includes('INTERNAL_TEST_DETAIL'),false);
  h.context.document.getElementById('disconnect').onclick();
});

const HERMES = 'https://future-rich-0308.agents.nousresearch.com';
const flush = () => new Promise(resolve => setImmediate(resolve));

function clientHarness({ authorized = true } = {}) {
  const listeners = {}, sent = [], popups = [], store = new Map(), timers = new Map(), events = [];
  let timerId = 0, interval;
  if (authorized) store.set('agenthub.hermes.authorized.v1', '1');
  const context = {
    crypto, Blob, Event: class { constructor(type) { this.type = type; } }, console,
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn) { interval = fn; return 1; }, clearInterval() {}
  };
  context.window = context;
  context.addEventListener = (type, fn) => { listeners[type] = fn; };
  context.dispatchEvent = event => { events.push(event.type); };
  context.open = (url, name) => {
    const popup = { url, name, closed: false, focus() {}, postMessage(data, origin) { sent.push({ popup, data, origin }); } };
    popups.push(popup); return popup;
  };
  vm.runInNewContext(clientSource, context);
  const hello = popup => [...sent].reverse().find(item => item.popup === popup && item.data.type === 'hello');
  const receive = (popup, data) => {
    const h = hello(popup);
    listeners.message({ origin: h.origin, source: popup, data: { channel: h.data.channel, channelId: h.data.channelId, ...data } });
  };
  return {
    api: context.hermesCloud, sent, popups, store, timers, events, receive,
    tick: () => interval(),
    fireTimeout: ms => { const pair = [...timers].find(([, item]) => item.ms === ms); assert.ok(pair, `timer ${ms} exists`); timers.delete(pair[0]); pair[1].fn(); }
  };
}

function connectorHarness({ voiceResponder, identityStatus = 200, ledger = new Map(), bindings = {} } = {}) {
  const listeners = {}, posts = [], store = new Map(), sockets = [], elements = {}, requests = [];
  store.set('agenthub.connector.granted.v1', '1');
  for (const id of ['status', 'connect', 'disconnect', 'prompt', 'test', 'reply']) {
    elements[id] = { hidden: false, textContent: '', value: '', disabled: false, onclick: null, append() {} };
  }
  const parentWindow = { postMessage(data, origin) { posts.push({ data, origin }); } };
  class MockWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    frame(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  }
  class MockFileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then(buffer => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      }, error => this.onerror?.(error));
    }
  }
  const fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    const target = String(url);
    const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json', ...headers}});
    if (target === '/api/plugins/agent-hub/identity') return reply(identityStatus === 200 ? {scope:'personal'} : {error:'denied'}, identityStatus);
    if (target === '/api/plugins/agent-hub/bindings' && (!options.method || options.method === 'GET')) return reply({bindings:{...bindings}});
    if (target.startsWith('/api/plugins/agent-hub/bindings/') && options.method === 'PUT') {
      const chatId = decodeURIComponent(target.split('/').at(-1)); const body = JSON.parse(options.body);
      if ((bindings[chatId] ?? null) !== body.expectedSessionId) return reply({error:'conflict'},409);
      if (body.sessionId === null) delete bindings[chatId]; else bindings[chatId] = body.sessionId;
      return reply({chatId,sessionId:body.sessionId});
    }
    const turnMatch = /^\/api\/plugins\/agent-hub\/turns\/([^/?]+)(?:\/([^?]+))?/.exec(target);
    if (turnMatch) {
      const chatId=decodeURIComponent(turnMatch[1]), clientFromPath=turnMatch[2]&&decodeURIComponent(turnMatch[2]);
      if (options.method === 'POST') {
        const body=JSON.parse(options.body); const existing=ledger.get(`${chatId}:${body.clientMessageId}`);
        const pending=[...ledger.entries()].find(([key,value])=>key.startsWith(chatId+':')&&value.state==='pending');
        if (existing || pending) return reply({claimed:false,turn:existing || pending[1]});
        const turn={chatId,clientMessageId:body.clientMessageId,requestId:body.requestId,promptDigest:body.promptDigest,state:'pending'};
        ledger.set(`${chatId}:${body.clientMessageId}`,turn); return reply({claimed:true,turn});
      }
      if (options.method === 'PATCH') {
        const body=JSON.parse(options.body), key=`${chatId}:${clientFromPath}`, turn=ledger.get(key);
        if (!turn || turn.requestId !== body.requestId) return reply({error:'conflict'},409);
        Object.assign(turn,{state:body.state,...(body.state==='completed'?{text:body.text}:{})}); return reply({turn});
      }
      const query=new URL(target,'https://test.invalid').searchParams; const id=query.get('clientMessageId');
      return reply({turn:id ? ledger.get(`${chatId}:${id}`) || null : [...ledger.entries()].find(([key])=>key.startsWith(chatId+':'))?.[1] || null});
    }
    if (String(url) === '/api/auth/ws-ticket') return { ok: true, status: 200, json: async () => ({ ticket: 'opaque-ticket' }) };
    if (voiceResponder && String(url).startsWith('/api/audio/')) return voiceResponder(String(url), options);
    if (String(url).startsWith('/api/audio/transcribe?')) return { ok: true, status: 200, json: async () => ({ ok: true, transcript: 'hola voz', provider: 'test-stt' }) };
    if (String(url).startsWith('/api/audio/speak?')) return {
      ok: true, status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true, data_url: 'data:audio/mpeg;base64,AQID', mime_type: 'audio/mpeg', provider: 'test-tts' })
    };
    throw new Error(`unexpected fetch ${url}`);
  };
  const context = {
    crypto, URLSearchParams, URL, Map, Set, JSON, Error, Promise, encodeURIComponent, TextEncoder, Uint8Array, Response,
    Blob, FileReader: MockFileReader, AbortController, atob, btoa, fetch, WebSocket: MockWebSocket,
    location: { search: '?mode=voice', protocol: 'https:', host: 'future-rich-0308.agents.nousresearch.com', pathname: '/connector' },
    document: { getElementById: id => elements[id], querySelector: () => null, createElement: () => ({}) },
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    setTimeout, clearTimeout, setInterval() {}, console
  };
  context.window = context; context.opener = parentWindow;
  context.addEventListener = (type, fn) => { listeners[type] = fn; };
  context.close = () => { context.closed = true; };
  vm.runInNewContext(storageSource, context);
  vm.runInNewContext(recoverySource, context);
  vm.runInNewContext(connectorSource, context);
  const send = data => listeners.message({ origin: APP, source: parentWindow, data: { channel: 'agenthub.sso.v2', channelId: 'voice_1', ...data } });
  return { context, listeners, posts, requests, sockets, store, ledger, bindings, send, parentWindow };
}

async function readyConnector(h) {
  for (let i=0;i<10 && !h.sockets[0];i++) await flush();
  assert.ok(h.sockets[0], 'owner verification creates websocket');
  h.sockets[0].open(); await flush();
  await h.send({type:'hello'}); await flush();
  return h.sockets[0];
}

async function waitForRpc(ws, method) {
  for (let i=0;i<100;i++) {
    const frame=ws.sent.find(item=>item.method===method);
    if (frame) return frame;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail(`RPC ${method} was not sent; frames=${JSON.stringify(ws.sent)}`);
}

async function readyClientVoice(h) {
  const promise = h.api.openVoice();
  const popup = h.popups.at(-1);
  h.receive(popup, { type: 'ready', connected: true, profile: 'limpatexdev-cloud', ownerScope: 'personal' });
  await promise;
  return popup;
}

test('mocked backend: owner denial blocks all websocket RPC', async () => {
  const h=connectorHarness({identityStatus:403});
  await h.send({type:'hello'});
  await h.send({type:'chat',requestId:'request_owner_denied',clientMessageId:'message_owner_denied',chatId:'chat_owner',message:'no ejecutar'});
  await flush();
  assert.equal(h.sockets.length,0);
  assert.equal(h.requests.some(item=>item.url==='/api/auth/ws-ticket'),false);
  assert.ok(h.posts.some(item=>item.data.type==='result'&&item.data.requestId==='request_owner_denied'&&item.data.ok===false));
});

test('mocked backend: completed same-message ledger returns cached reply without prompt.submit', async () => {
  const ledger=new Map([['chat_cache:message_cache',{chatId:'chat_cache',clientMessageId:'message_cache',requestId:'old_request',state:'completed',text:'respuesta cacheada'}]]);
  const h=connectorHarness({ledger,bindings:{chat_cache:'stored_cache'}}); const ws=await readyConnector(h);
  const pending=h.send({type:'chat',requestId:'request_cache',clientMessageId:'message_cache',chatId:'chat_cache',message:'mismo mensaje',model:'default',effort:'low'});
  const resume=await waitForRpc(ws,'session.resume');
  ws.frame({jsonrpc:'2.0',id:resume.id,result:{session_id:'live_cache',stored_session_id:'stored_cache'}});
  await pending; await flush();
  const result=h.posts.find(item=>item.data.type==='result'&&item.data.requestId==='request_cache');
  assert.equal(result.data.ok,true); assert.equal(result.data.result.text,'respuesta cacheada'); assert.equal(result.data.result.recovered,true);
  assert.equal(ws.sent.filter(item=>item.method==='prompt.submit').length,0);
});

test('mocked backend: pending ledger denies a different turn without prompt.submit', async () => {
  const ledger=new Map([['chat_pending:message_first',{chatId:'chat_pending',clientMessageId:'message_first',requestId:'request_first',state:'pending'}]]);
  const h=connectorHarness({ledger,bindings:{chat_pending:'stored_pending'}}); const ws=await readyConnector(h);
  const pending=h.send({type:'chat',requestId:'request_second',clientMessageId:'message_second',chatId:'chat_pending',message:'otro mensaje',model:'default',effort:'low'});
  const resume=await waitForRpc(ws,'session.resume');
  ws.frame({jsonrpc:'2.0',id:resume.id,result:{session_id:'live_pending',stored_session_id:'stored_pending'}});
  await pending; await flush();
  const result=h.posts.find(item=>item.data.type==='result'&&item.data.requestId==='request_second');
  assert.equal(result.data.ok,false); assert.equal(result.data.code,'uncertain');
  assert.equal(ws.sent.filter(item=>item.method==='prompt.submit').length,0);
});

test('mocked runtime: queued or unknown prompt acknowledgement stays uncertain and never completes ledger', async () => {
  for (const acknowledgement of [{status:'queued'},{}]) {
    const ledger=new Map(),h=connectorHarness({ledger,bindings:{chat_ack:'stored_ack'}}),ws=await readyConnector(h);
    const pending=h.send({type:'chat',requestId:'request_ack_'+(acknowledgement.status||'unknown'),clientMessageId:'message_ack_'+(acknowledgement.status||'unknown'),chatId:'chat_ack',message:'validar aceptación',model:'default',effort:'low'});
    const resume=await waitForRpc(ws,'session.resume');
    ws.frame({jsonrpc:'2.0',id:resume.id,result:{session_id:'live_ack',stored_session_id:'stored_ack'}});
    const submit=await waitForRpc(ws,'prompt.submit'); ws.frame({jsonrpc:'2.0',id:submit.id,result:acknowledgement});
    await pending; await flush();
    const requestId='request_ack_'+(acknowledgement.status||'unknown');
    const result=h.posts.find(item=>item.data.type==='result'&&item.data.requestId===requestId);
    assert.equal(result.data.ok,false); assert.equal(result.data.code,'uncertain');
    assert.equal([...ledger.values()][0].state,'pending');
    assert.equal(h.requests.filter(item=>item.options.method==='PATCH').length,0);
  }
});

test('openVoice keeps one ready popup for programmatic chat until closeVoice', async () => {
  const h = clientHarness();
  const popup = await readyClientVoice(h);
  assert.match(popup.url, /mode=voice/);
  const turn = h.api.chat({ message: 'hola', chatId: 'chat_1' });
  assert.equal(h.popups.length, 1);
  const request = [...h.sent].reverse().find(item => item.data.type === 'chat');
  h.receive(popup, { type: 'result', requestId: request.data.requestId, ok: true, result: { text: 'respuesta', sessionId: 'stored_1', profile: 'limpatexdev-cloud' } });
  assert.equal((await turn).text, 'respuesta');
  assert.equal(h.api.isLive(), true);
  assert.equal(h.sent.some(item => item.data.type === 'close'), false);
  h.api.closeVoice();
  assert.ok(h.sent.some(item => item.data.type === 'close'));
  assert.equal(h.api.isLive(), false);
  assert.equal(h.events.includes('hermes-voice-closed'), false);
});

test('connector voice-closed message releases lease but keeps authorization', async () => {
  const h = clientHarness(); const popup = await readyClientVoice(h);
  h.receive(popup, { type: 'voice-closed' });
  assert.ok(h.events.includes('hermes-voice-closed'));
  assert.equal(h.api.isLive(), false);
  assert.equal(h.api.isConnected(), true);
});

test('openVoice rejects on bounded readiness timeout', async () => {
  const h = clientHarness();
  const opening = h.api.openVoice();
  h.fireTimeout(15000);
  await assert.rejects(opening, /tiempo|conect/i);
  assert.equal(h.api.isLive(), false);
});

test('client transcribe uses bounded Blob transport and enforces chat identity', async () => {
  const h = clientHarness(); const popup = await readyClientVoice(h);
  await assert.rejects(h.api.transcribe({ blob: new Blob([], { type: 'audio/webm' }), chatId: 'chat_1' }), /vacío|empty/i);
  await assert.rejects(h.api.transcribe({ blob: new Blob(['x'], { type: 'text/plain' }), chatId: 'chat_1' }), /audio/i);
  await assert.rejects(h.api.transcribe({ blob: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: 'audio/webm' }), chatId: 'chat_1' }), /25 MiB/i);
  const promise = h.api.transcribe({ blob: new Blob(['voice'], { type: 'audio/webm' }), chatId: 'chat_1' });
  const request = [...h.sent].reverse().find(item => item.data.type === 'transcribe');
  assert.equal(request.data.chatId, 'chat_1'); assert.equal(request.data.blob.size, 5);
  h.receive(popup, { type: 'result', requestId: request.data.requestId, ok: true, result: { text: 'hola voz', chatId: 'wrong' } });
  await assert.rejects(promise, /identidad|chat/i);
});

test('connector transcribes through fixed authenticated Hermes upload route', async () => {
  const h = connectorHarness(); await readyConnector(h);
  h.send({ type: 'transcribe', requestId: 'req_stt', chatId: 'chat_1', blob: new Blob(['voice'], { type: 'audio/webm' }) });
  await flush(); await flush();
  const req = h.requests.find(item => item.url.startsWith('/api/audio/transcribe?'));
  assert.ok(req); assert.equal(req.options.credentials, 'same-origin'); assert.equal(req.options.method, 'POST');
  assert.match(req.url, /profile=limpatexdev-cloud/);
  const body = JSON.parse(req.options.body); assert.match(body.data_url, /^data:audio\/webm;base64,/); assert.equal(body.mime_type, 'audio/webm');
  const result = h.posts.find(item => item.data.requestId === 'req_stt');
  assert.deepEqual({ ok: result.data.ok, text: result.data.result.text, chatId: result.data.result.chatId }, { ok: true, text: 'hola voz', chatId: 'chat_1' });
  assert.equal(h.requests.some(item => item.url.includes('voice-config')), false);
});

test('connector synthesizes with fixed route and returns a bounded audio Blob', async () => {
  const h = connectorHarness(); await readyConnector(h);
  h.send({ type: 'synthesize', requestId: 'req_tts', chatId: 'chat_1', text: 'respuesta' });
  await flush(); await flush();
  const req = h.requests.find(item => item.url.startsWith('/api/audio/speak?'));
  assert.ok(req); assert.equal(req.options.credentials, 'same-origin'); assert.deepEqual(JSON.parse(req.options.body), { text: 'respuesta' });
  const result = h.posts.find(item => item.data.requestId === 'req_tts');
  assert.equal(result.data.ok, true); assert.equal(result.data.result.chatId, 'chat_1');
  assert.equal(result.data.result.mimeType, 'audio/mpeg'); assert.equal(result.data.result.blob.size, 3);
  assert.equal(h.requests.some(item => item.url.includes('voice-config')), false);
});

test('closing a voice popup after chat dispatch keeps uncertain-send warning', async () => {
  const h = clientHarness(); const popup = await readyClientVoice(h);
  const turn = h.api.chat({ message: 'no reintentar', chatId: 'chat_1' });
  popup.closed = true; h.tick();
  await assert.rejects(turn, /Comprueba Hermes antes de reenviar/);
  assert.ok(h.events.includes('hermes-voice-closed'));
  assert.equal(h.api.isConnected(), true);
});

test('unexpected connector websocket closure signals the voice UI', async () => {
  const h = connectorHarness(); const ws = await readyConnector(h);
  ws.readyState = 3; ws.onclose(); await flush();
  assert.ok(h.posts.some(item => item.data.type === 'voice-closed'));
});

test('disconnect revokes the grant and aborts in-flight voice HTTP work', async () => {
  let signal;
  const h = connectorHarness({ voiceResponder: (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  } });
  await readyConnector(h);
  h.send({ type: 'transcribe', requestId: 'req_abort', chatId: 'chat_1', blob: new Blob(['voice'], { type: 'audio/webm' }) });
  await flush(); await flush();
  assert.equal(signal.aborted, false);
  h.send({ type: 'disconnect' }); await flush();
  assert.equal(signal.aborted, true);
  assert.equal(h.store.has('agenthub.connector.granted.v1'), false);
  assert.ok(h.posts.some(item => item.data.type === 'revoked'));
});
