const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto').webcrypto;
const clientSource = fs.readFileSync('cloud-connection.js', 'utf8');
const storageSource = fs.readFileSync('hermes-plugin/dashboard/dist/storage-transport.js', 'utf8');
const recoverySource = fs.readFileSync('hermes-plugin/dashboard/dist/turn-recovery.js', 'utf8');
const connectorSource = fs.readFileSync('hermes-plugin/dashboard/dist/connector.js', 'utf8');

function clientHarness() {
  const listeners = {}, sent = [], popups = [], store = new Map();
  let tick, blockOpen = false;
  const context = {
    crypto,
    Event: class { constructor(type) { this.type = type; } },
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    setTimeout, clearTimeout,
    setInterval(fn) { tick = fn; return 1; },
    clearInterval() {},
    console
  };
  context.window = context;
  context.window.addEventListener = (type, fn) => { listeners[type] = fn; };
  context.window.dispatchEvent = () => {};
  context.window.open = (url, name) => {
    if (blockOpen) return null;
    const popup = { url, name, closed: false, focus() {}, postMessage(data, origin) { sent.push({ popup, data, origin }); } };
    popups.push(popup);
    return popup;
  };
  vm.runInNewContext(clientSource, context);
  return { api: context.window.hermesCloud, context, listeners, sent, popups, store, tick: () => tick(), block: value => { blockOpen = value; } };
}
function helloFor(h, popup) {
  return [...h.sent].reverse().find(item => item.popup === popup && item.data.type === 'hello');
}
function receive(h, popup, data, overrides = {}) {
  const hello = helloFor(h, popup);
  h.listeners.message({ origin: hello.origin, source: popup, data: { channel: hello.data.channel, channelId: hello.data.channelId, ...data }, ...overrides });
  return hello;
}
function authorize(h) {
  h.api.open(); h.tick(); const popup = h.popups.at(-1);
  receive(h, popup, { type: 'ready', connected: true, ownerScope: 'personal' });
  return popup;
}

function connectorHarness(search = '?mode=turn', seededGrant = true) {
  const listeners = {}, posts = [], store = new Map(), sockets = [], elements = {};
  if (seededGrant) store.set('agenthub.connector.granted.v1', '1');
  for (const id of ['status', 'connect', 'disconnect', 'prompt', 'test', 'reply']) {
    elements[id] = { hidden: false, textContent: '', value: '', disabled: false, onclick: null, append() {} };
  }
  const parentWindow = { closed: false, postMessage(data, origin) { posts.push({ data, origin }); } };
  let fetchCount = 0;
  class MockWebSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    open() { this.readyState = 1; this.onopen(); }
    frame(frame) { this.onmessage({ data: JSON.stringify(frame) }); }
  }
  const context = {
    crypto, URLSearchParams, Map, Set, JSON, Error, Promise, encodeURIComponent,
    location: { search, protocol: 'https:', host: 'future-rich-0308.agents.nousresearch.com', pathname: '/connector' },
    document: {
      getElementById: id => elements[id],
      querySelector: () => null,
      createElement: () => ({ textContent: '', href: '' })
    },
    localStorage: {
      getItem: key => store.has(key) ? store.get(key) : null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key)
    },
    fetch: async (url, options={}) => {
      fetchCount += 1; const target=String(url);
      const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
      if(target==='/api/plugins/agent-hub/identity')return reply({scope:'personal'});
      if(target==='/api/plugins/agent-hub/bindings'&&(!options.method||options.method==='GET'))return reply({bindings:{}});
      if(target.startsWith('/api/plugins/agent-hub/bindings/')&&options.method==='PUT')return reply({sessionId:JSON.parse(options.body).sessionId});
      if(/^\/api\/plugins\/agent-hub\/turns\//.test(target)&&options.method==='POST'){
        const body=JSON.parse(options.body);return reply({claimed:true,turn:{...body,state:'pending'}});
      }
      if(/^\/api\/plugins\/agent-hub\/turns\//.test(target)&&options.method==='PATCH')return reply({turn:{...JSON.parse(options.body)}});
      if(target==='/api/auth/ws-ticket')return reply({ticket:'opaque-test-ticket'});
      throw new Error(`unexpected mocked HTTP ${target}`);
    },
    WebSocket: MockWebSocket,
    AbortController, Response, TextEncoder, Uint8Array, Blob,
    setTimeout, clearTimeout, setInterval() {}, console
  };
  context.window = context;
  context.opener = parentWindow;
  context.addEventListener = (type, fn) => { listeners[type] = fn; };
  context.close = () => {};
  vm.runInNewContext(storageSource, context);
  vm.runInNewContext(recoverySource, context);
  vm.runInNewContext(connectorSource, context);
  return { context, listeners, posts, store, sockets, elements, parentWindow, fetchCount: () => fetchCount };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

// Client security and lifecycle
test('rejects forged origin, source and channel id', () => {
  const h = clientHarness(); h.api.open(); h.tick(); const popup = h.popups[0]; const hello = helloFor(h, popup);
  const good = { channel: hello.data.channel, channelId: hello.data.channelId, type: 'ready', connected: true };
  h.listeners.message({ origin: 'https://evil.example', source: popup, data: good });
  h.listeners.message({ origin: hello.origin, source: {}, data: good });
  h.listeners.message({ origin: hello.origin, source: popup, data: { ...good, channelId: 'forged' } });
  assert.equal(h.api.isConnected(), false);
});

test('authorization persists and closes only after ready acknowledgement', () => {
  const h = clientHarness(); const popup = authorize(h);
  assert.equal(h.api.isConnected(), true);
  assert.equal(h.api.isLive(), false);
  assert.ok(h.sent.some(item => item.popup === popup && item.data.type === 'close'));
  assert.match(popup.url, /mode=authorize/);
});

test('popup closed before ready rejects queued message immediately', async () => {
  const h = clientHarness(); authorize(h);
  const promise = h.api.chat({ message: 'hola', chatId: 'chat_1' });
  const popup = h.popups.at(-1); popup.closed = true; h.tick();
  await assert.rejects(promise, /antes de enviar/);
});

test('completed result detaches old popup and next turn uses a unique window', async () => {
  const h = clientHarness(); authorize(h);
  const first = h.api.chat({ message: 'uno', chatId: 'chat_1' });
  const popup1 = h.popups.at(-1); h.tick(); receive(h, popup1, { type: 'ready', connected: true, ownerScope: 'personal' });
  const req1 = [...h.sent].reverse().find(item => item.popup === popup1 && item.data.type === 'chat');
  receive(h, popup1, { type: 'result', requestId: req1.data.requestId, ok: true, result: { text: 'uno' } });
  assert.equal((await first).text, 'uno');
  const second = h.api.chat({ message: 'dos', chatId: 'chat_1' });
  const popup2 = h.popups.at(-1);
  assert.notEqual(popup2, popup1);
  assert.notEqual(popup2.name, popup1.name);
  h.tick(); receive(h, popup2, { type: 'ready', connected: true, ownerScope: 'personal' });
  const req2 = [...h.sent].reverse().find(item => item.popup === popup2 && item.data.type === 'chat');
  receive(h, popup2, { type: 'result', requestId: req2.data.requestId, ok: true, result: { text: 'dos' } });
  assert.equal((await second).text, 'dos');
});

test('failed remote revocation remains fail-closed and cannot reconnect silently', async () => {
  const h = clientHarness(); authorize(h); h.block(true);
  await assert.rejects(h.api.disconnect(), /Desconexión pendiente/);
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.api.isRevoking(), true);
  assert.equal(h.store.get('agenthub.hermes.revoking.v1'), '1');
  assert.throws(() => h.api.open(), /ventana emergente/);
});

test('confirmed remote revocation clears pending state', async () => {
  const h = clientHarness(); authorize(h);
  const promise = h.api.disconnect(); const popup = h.popups.at(-1); h.tick();
  receive(h, popup, { type: 'revoked' });
  await promise;
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.api.isRevoking(), false);
});

// Connector fail-closed behavior
test('authorize mode with an old grant still requires an explicit click', async () => {
  const h = connectorHarness('?mode=authorize', true); await flush();
  assert.equal(h.fetchCount(), 0);
  assert.match(h.elements.status.textContent, /Pulsa Conectar/);
  assert.equal(typeof h.elements.connect.onclick, 'function');
});

test('revoke mode clears Hermes grant and confirms only after channel hello', () => {
  const h = connectorHarness('?mode=revoke&revoke=1', true);
  assert.equal(h.store.has('agenthub.connector.granted.v1'), false);
  assert.equal(h.posts.length, 0);
  h.listeners.message({ origin: 'https://agent-hub-theta-five.vercel.app', source: h.parentWindow, data: { channel: 'agenthub.sso.v2', channelId: 'revoke_1', type: 'hello' } });
  assert.ok(h.posts.some(item => item.data.type === 'revoked' && item.data.channelId === 'revoke_1'));
});

test('mocked backend: websocket closure rejects an outstanding ledger-claimed turn without waiting for timeout', async () => {
  const h = connectorHarness('?mode=turn', true);
  for(let i=0;i<10&&!h.sockets[0];i++)await flush();
  const ws = h.sockets[0]; assert.ok(ws); ws.open(); await flush();
  h.listeners.message({ origin: 'https://agent-hub-theta-five.vercel.app', source: h.parentWindow, data: { channel: 'agenthub.sso.v2', channelId: 'turn_1', type: 'hello' } });
  h.listeners.message({ origin: 'https://agent-hub-theta-five.vercel.app', source: h.parentWindow, data: { channel: 'agenthub.sso.v2', channelId: 'turn_1', type: 'chat', requestId: 'req_1', clientMessageId: 'message_1', chatId: 'chat_1', message: 'hola', model: 'default', effort: 'low' } });
  for(let i=0;i<20&&!ws.sent.some(frame=>frame.method==='session.create');i++)await flush();
  const create = ws.sent.find(frame => frame.method === 'session.create'); assert.ok(create);
  ws.frame({ jsonrpc: '2.0', id: create.id, result: { session_id: 'live_1', stored_session_id: 'stored_1' } });
  for(let i=0;i<20&&!ws.sent.some(frame=>frame.method==='prompt.submit');i++)await flush();
  assert.ok(ws.sent.some(frame => frame.method === 'prompt.submit'));
  ws.readyState = 3; ws.onclose(); await flush(); await flush();
  const result = h.posts.find(item => item.data.type === 'result' && item.data.requestId === 'req_1');
  assert.equal(result.data.ok, false);
  assert.match(result.data.error, /WebSocket|conexión/i);
});

test('service worker excludes APIs and foreign origins', () => {
  const sw = fs.readFileSync('sw.js', 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
});
