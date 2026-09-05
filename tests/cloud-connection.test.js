const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto').webcrypto;
const source = fs.readFileSync('cloud-connection.js', 'utf8');

function setup() {
  const listeners = {}, sent = [], popups = [], store = new Map();
  let tick;
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key)
  };
  const window = {
    addEventListener: (name, fn) => { listeners[name] = fn; },
    dispatchEvent() {},
    open: url => {
      const popup = { url, closed: false, postMessage: (data, origin) => sent.push({ popup, data, origin }), focus() {} };
      popups.push(popup);
      return popup;
    }
  };
  vm.runInNewContext(source, { window, localStorage, crypto, Event: class {}, Map, Date, Error, Promise, setInterval: fn => { tick = fn; }, setTimeout, clearTimeout });
  return { api: window.hermesCloud, listeners, popups, sent, store, tick };
}
function ready(x, popup) {
  const hello = [...x.sent].reverse().find(item => item.popup === popup && item.data.type === 'hello');
  assert.ok(hello);
  x.listeners.message({ origin: hello.origin, source: popup, data: { channel: hello.data.channel, channelId: hello.data.channelId, type: 'ready', connected: true } });
  return hello;
}

test('rejects forged origin and source', () => {
  const x = setup(); x.api.open(); x.tick(); const popup = x.popups[0];
  const hello = x.sent[0];
  x.listeners.message({ origin: 'https://evil.example', source: popup, data: { ...hello.data, type: 'ready', connected: true } });
  assert.equal(x.api.isConnected(), false);
  x.listeners.message({ origin: hello.origin, source: {}, data: { ...hello.data, type: 'ready', connected: true } });
  assert.equal(x.api.isConnected(), false);
});

test('authorization survives closing the connection window', () => {
  const x = setup(); x.api.open(); x.tick(); const popup = x.popups[0];
  assert.match(popup.url, /mode=authorize/);
  ready(x, popup);
  assert.ok(x.sent.some(item => item.data.type === 'close'));
  assert.equal(x.api.isConnected(), true);
  popup.closed = true; x.tick();
  assert.equal(x.api.isConnected(), true);
  assert.equal(x.api.isLive(), false);
});

test('each chat reopens a temporary connector and resolves exact response', async () => {
  const x = setup(); x.api.open(); x.tick(); let popup = x.popups[0]; ready(x, popup);
  popup.closed = true; x.tick();
  const result = x.api.chat({ message: 'hola', chatId: 'chat_1', model: 'default', effort: 'low' });
  popup = x.popups[1]; x.tick(); const hello = ready(x, popup);
  const request = [...x.sent].reverse().find(item => item.popup === popup && item.data.type === 'chat');
  assert.equal(request.origin, hello.origin);
  x.listeners.message({ origin: request.origin, source: popup, data: { channel: request.data.channel, channelId: request.data.channelId, type: 'result', requestId: request.data.requestId, ok: true, result: { text: 'respuesta real' } } });
  assert.equal((await result).text, 'respuesta real');
});

test('disconnect removes persisted authorization', () => {
  const x = setup(); x.api.open(); x.tick(); const popup = x.popups[0]; ready(x, popup);
  x.api.disconnect();
  assert.equal(x.api.isConnected(), false);
  const revokedByMessage = x.sent.some(item => item.data.type === 'disconnect');
  const revokedByUrl = x.popups.some(item => /revoke=1/.test(item.url));
  assert.ok(revokedByMessage || revokedByUrl);
});

test('service worker excludes API and foreign origins', () => {
  const sw = fs.readFileSync('sw.js', 'utf8');
  assert.match(sw, /url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(sw, /url\.origin !== self\.location\.origin/);
});

test('connector starts and registers controls in a browser-like global', () => {
  const connector = fs.readFileSync('/opt/data/plugins/agent-hub/dashboard/dist/connector.js', 'utf8');
  const handlers = {}, elements = {};
  for (const id of ['status', 'connect', 'disconnect', 'prompt', 'test', 'reply']) {
    elements[id] = { hidden: false, textContent: '', value: '', addEventListener: (name, fn) => { handlers[id + ':' + name] = fn; } };
  }
  const store = new Map();
  const context = {
    crypto, location: { search: '' }, URLSearchParams, Map, Set, JSON, Error, Promise,
    document: { getElementById: id => elements[id] },
    localStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) },
    addEventListener() {}, setInterval() {}, setTimeout, clearTimeout, fetch() { throw new Error('not called'); }, WebSocket: class {}
  };
  context.window = context;
  Object.defineProperty(context, 'opener', { value: null, configurable: false });
  vm.runInNewContext(connector, context);
  assert.equal(typeof elements.connect.onclick, 'function');
  assert.equal(typeof elements.disconnect.onclick, 'function');
  assert.equal(typeof elements.test.onclick, 'function');
});

test('connector persists grant and auto-closes after a turn', () => {
  const connector = fs.readFileSync('/opt/data/plugins/agent-hub/dashboard/dist/connector.js', 'utf8');
  assert.match(connector, /agenthub\.connector\.granted\.v1/);
  assert.match(connector, /window\.close\(\)/);
  assert.match(source, /mode=turn/);
});
