const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CloudSync, uploadableSnapshot } = require('../cloud-sync.js');
const fs = require('node:fs');
const path = require('node:path');

const blank = () => ({ chats: [], messages: {}, sessions: {} });
const clone = value => structuredClone(value);
const chat = (id, title = id) => ({ id, title, desc: '', time: 'Ahora', status: 'Activo' });
const message = (id, text) => ({ id, role: 'user', text });

function harness({ local = blank(), remote = blank(), scope = 'personal', revision = 0, audio = new Map(), localAudio = audio } = {}) {
  let localState = clone(local), remoteState = clone(remote), remoteRevision = revision;
  let active = 0, maxActive = 0, cleared = 0;
  const calls = [], statuses = [], cached = new Map();
  const transport = {
    openVoice() { calls.push(['openVoice']); return Promise.resolve(); },
    ownerScope() { return scope; },
    async storage(op, args = {}) {
      active += 1; maxActive = Math.max(maxActive, active); calls.push([op, args]);
      await new Promise(resolve => setImmediate(resolve));
      try {
        if (op === 'identity') return { scope };
        if (op === 'getState') return { revision: remoteRevision, snapshot: clone(remoteState) };
        if (op === 'putAudio') return { ok: true };
        if (op === 'getAudio') return audio.get(`${args.chatId}:${args.id}`) || null;
        if (op === 'putState') {
          if (args.expectedRevision !== remoteRevision) { const error = Error('stale'); error.code = 'conflict'; throw error; }
          remoteState = clone(args.snapshot); remoteRevision += 1;
          return { revision: remoteRevision, snapshot: clone(remoteState) };
        }
        throw Error(`unexpected ${op}`);
      } finally { active -= 1; }
    }
  };
  const sync = new CloudSync({
    transport,
    readLocalSnapshot: () => clone(localState),
    applySnapshot: value => { localState = clone(value); },
    getLocalAudio: async (id, chatId) => localAudio.get(`${chatId}:${id}`) || cached.get(`${chatId}:${id}`) || null,
    cacheAudio: async (id, chatId, blob) => cached.set(`${chatId}:${id}`, blob),
    clearVisible: () => { cleared += 1; },
    onStatus: status => statuses.push(status)
  });
  return { sync, transport, calls, statuses, cached, maxActive: () => maxActive, cleared: () => cleared, local: () => localState, remote: () => remoteState, revision: () => remoteRevision };
}

test('uploadableSnapshot excludes demos and keeps only real chat maps', () => {
  const source = {
    chats: [chat('demo'), chat('real')],
    messages: { demo: [], real: [message('m1', 'hola')], orphan: [message('m2', 'no')] },
    sessions: { demo: 's0', real: 's1', orphan: 's2' }
  };
  assert.deepEqual(uploadableSnapshot(source), {
    chats: [chat('real')], messages: { real: [message('m1', 'hola')] }, sessions: { real: 's1' }
  });
});

test('explicit sync opens synchronously, verifies owner, uploads audio before state and reads back', async () => {
  const blob = new Blob(['voice'], { type: 'audio/webm' });
  const local = { chats: [chat('c1')], messages: { c1: [{ id: 'a1', role: 'audio', audioId: 'a1', status: 'complete' }] }, sessions: {} };
  const h = harness({ local, audio: new Map([['c1:a1', blob]]) });
  const pending = h.sync.syncFromUserGesture();
  assert.equal(h.calls[0][0], 'openVoice');
  await pending;
  assert.deepEqual(h.calls.map(call => call[0]), ['openVoice', 'identity', 'getState', 'putAudio', 'putState', 'getState']);
  assert.equal(h.sync.isReady(), true);
  assert.equal(h.revision(), 1);
});

test('unverified or wrong owner never reveals cached state', async () => {
  for (const scope of [null, 'other']) {
    const h = harness({ scope, local: { chats: [chat('private')], messages: { private: [message('m', 'secret')] }, sessions: {} } });
    await assert.rejects(h.sync.syncFromUserGesture(), /propietario/i);
    assert.equal(h.sync.isReady(), false);
    assert.equal(h.cleared(), 1);
    assert.equal(h.calls.some(call => call[0] === 'getState'), false);
  }
});

test('new device hydrates remote state and lazy-downloads missing audio once', async () => {
  const blob = new Blob(['remote'], { type: 'audio/webm' });
  const remote = { chats: [chat('c1')], messages: { c1: [{ id: 'a1', role: 'audio', audioId: 'a1' }] }, sessions: { c1: 's1' } };
  const h = harness({ remote, revision: 4, audio: new Map([['c1:a1', blob]]), localAudio: new Map() });
  await h.sync.syncFromUserGesture();
  assert.deepEqual(h.local(), remote);
  assert.equal(await h.sync.getAudio('a1', 'c1'), blob);
  assert.equal(h.cached.get('c1:a1'), blob);
});

test('before/after turn and concurrent callers serialize all storage transport calls', async () => {
  const local = { chats: [chat('c1')], messages: { c1: [message('m1', 'uno')] }, sessions: {} };
  const h = harness({ local, remote: local, revision: 2 });
  await h.sync.syncFromUserGesture();
  await Promise.all([h.sync.beforeTurn(), h.sync.afterTurn(), h.sync.beforeTurn()]);
  assert.equal(h.maxActive(), 1);
});

test('CAS conflict is visible, preserves local draft and never auto-retries', async () => {
  const local = { chats: [chat('local')], messages: { local: [message('m1', 'draft')] }, sessions: {} };
  const h = harness({ local });
  h.transport.storage = async (op, args = {}) => {
    h.calls.push([op, args]);
    if (op === 'identity') return { scope: 'personal' };
    if (op === 'getState') return { revision: 0, snapshot: blank() };
    if (op === 'putState') { const error = Error('stale'); error.code = 'conflict'; throw error; }
    if (op === 'putAudio') return {};
    throw Error(op);
  };
  await assert.rejects(h.sync.syncFromUserGesture(), error => error.code === 'conflict');
  assert.deepEqual(h.local(), local);
  assert.equal(h.calls.filter(call => call[0] === 'putState').length, 1);
  assert.equal(h.statuses.at(-1).state, 'conflict');
});

test('initial sync rejects stale overlapping IDs without writing or replacing either source', async () => {
  const shared = chat('shared', 'Igual');
  const local = {
    chats: [shared],
    messages: { shared: [message('m1', 'OLD')] },
    sessions: { shared: 'same-session' }
  };
  const remote = {
    chats: [clone(shared)],
    messages: { shared: [message('m1', 'NEW')] },
    sessions: { shared: 'same-session' }
  };
  const h = harness({ local, remote, revision: 9 });

  await assert.rejects(h.sync.syncFromUserGesture(), error => error.code === 'initial_sync_conflict');

  assert.deepEqual(h.local(), local);
  assert.deepEqual(h.remote(), remote);
  assert.equal(h.calls.filter(call => call[0] === 'putState').length, 0);
  assert.equal(h.sync.isReady(), false);
  assert.equal(h.statuses.at(-1).state, 'conflict');
});

test('initial sync imports only new chat and message IDs when shared metadata is identical', async () => {
  const shared = chat('shared', 'Igual');
  const remoteOnly = chat('remote', 'Remoto');
  const localOnly = chat('local', 'Local');
  const remote = {
    chats: [shared, remoteOnly],
    messages: { shared: [message('remote-message', 'remoto')], remote: [message('r1', 'solo remoto')] },
    sessions: { shared: 'same-session' }
  };
  const local = {
    chats: [clone(shared), localOnly],
    messages: { shared: [message('local-message', 'local')], local: [message('l1', 'solo local')] },
    sessions: { shared: 'same-session', local: 'local-session' }
  };
  const expected = {
    chats: [shared, remoteOnly, localOnly],
    messages: {
      shared: [message('remote-message', 'remoto'), message('local-message', 'local')],
      remote: [message('r1', 'solo remoto')],
      local: [message('l1', 'solo local')]
    },
    sessions: { shared: 'same-session', local: 'local-session' }
  };
  const h = harness({ local, remote, revision: 3 });

  await h.sync.syncFromUserGesture();

  assert.deepEqual(h.local(), expected);
  assert.deepEqual(h.remote(), expected);
  assert.equal(h.calls.filter(call => call[0] === 'putState').length, 1);
});

test('initial sync treats reordered object fields as exact equality and does not write', async () => {
  const remoteChat = { id: 'shared', title: 'Igual', desc: '', time: 'Ahora', status: 'Activo' };
  const localChat = { status: 'Activo', time: 'Ahora', desc: '', title: 'Igual', id: 'shared' };
  const remoteMessage = { id: 'm1', role: 'user', text: 'igual', meta: { beta: 2, alpha: 1 } };
  const localMessage = { meta: { alpha: 1, beta: 2 }, text: 'igual', role: 'user', id: 'm1' };
  const remote = { chats: [remoteChat], messages: { shared: [remoteMessage] }, sessions: { shared: 'same' } };
  const local = { chats: [localChat], messages: { shared: [localMessage] }, sessions: { shared: 'same' } };
  const h = harness({ local, remote, revision: 5 });

  await h.sync.syncFromUserGesture();

  assert.deepEqual(h.local(), remote);
  assert.equal(h.calls.filter(call => call[0] === 'putState').length, 0);
});

test('initial sync rejects different shared chat metadata even when message IDs are disjoint', async () => {
  const local = { chats: [chat('shared', 'OLD')], messages: { shared: [message('local-message', 'local')] }, sessions: {} };
  const remote = { chats: [chat('shared', 'NEW')], messages: { shared: [message('remote-message', 'remote')] }, sessions: {} };
  const h = harness({ local, remote, revision: 2 });

  await assert.rejects(h.sync.syncFromUserGesture(), error => error.code === 'initial_sync_conflict');

  assert.deepEqual(h.local(), local);
  assert.deepEqual(h.remote(), remote);
  assert.equal(h.calls.filter(call => call[0] === 'putState').length, 0);
});

test('getAudio checks the owner gate before returning cached audio', async () => {
  const blob = new Blob(['private'], { type: 'audio/webm' });
  const h = harness({ scope: null, localAudio: new Map([['private:a1', blob]]) });

  await assert.rejects(h.sync.getAudio('a1', 'private'), error => error.code === 'owner_unverified');

  assert.equal(h.cleared(), 1);
  assert.equal(h.calls.some(call => call[0] === 'getAudio'), false);
});

test('remote reload requires explicit call; revocation clears visible state only', async () => {
  const local = { chats: [chat('local')], messages: { local: [message('m1', 'local')] }, sessions: {} };
  const remote = { chats: [chat('remote')], messages: { remote: [message('m2', 'remote')] }, sessions: {} };
  const h = harness({ local, remote, revision: 7 });
  await h.sync.syncFromUserGesture();
  await h.sync.reloadRemote();
  assert.deepEqual(h.local(), h.remote());
  h.sync.revoke();
  assert.equal(h.sync.isReady(), false);
  assert.equal(h.cleared(), 1);
  assert.notDeepEqual(h.local(), blank());
});

test('app gates history, integrates sync, and sends stable clientMessageId after preflush', async t => {
  let JSDOM;
  try { ({ JSDOM } = require(process.env.JSDOM_PATH || 'jsdom')); }
  catch { return t.skip('jsdom unavailable'); }
  const root = path.join(__dirname, '..');
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), { url: 'https://hub.test/', runScripts: 'outside-only' });
  const w = dom.window; w.matchMedia = () => ({ matches: false });
  let revision = 0, remote = blank(); const calls = [];
  w.hermesCloud = {
    isConnected: () => true, isRevoking: () => false, isLive: () => true, ownerScope: () => 'personal',
    open() {}, disconnect: async () => {}, closeVoice() { calls.push(['closeVoice']); },
    openVoice() { calls.push(['openVoice']); return Promise.resolve(); },
    async storage(op, args = {}) {
      calls.push([op, args]);
      if (op === 'identity') return { scope: 'personal' };
      if (op === 'getState') return { revision, snapshot: clone(remote) };
      if (op === 'putState') { assert.equal(args.expectedRevision, revision); remote = clone(args.snapshot); revision += 1; return { revision, snapshot: clone(remote) }; }
      if (op === 'putAudio') return {};
      throw Error(op);
    },
    async chat(data) { calls.push(['chat', data]); return { text: 'respuesta', sessionId: 'session_1' }; }
  };
  w.eval(fs.readFileSync(path.join(root, 'cloud-sync.js'), 'utf8'));
  w.eval(fs.readFileSync(path.join(root, 'app.js'), 'utf8'));
  try {
    assert.equal(w.document.body.classList.contains('sync-locked'), true);
    assert.equal(w.document.querySelector('#chatList').textContent, '');
    w.document.querySelector('#syncBtn').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(w.document.body.classList.contains('sync-locked'), false);
    w.document.querySelector('#heroInput').value = 'hola';
    w.document.querySelector('#heroSendBtn').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const chatCall = calls.find(call => call[0] === 'chat');
    assert.ok(chatCall);
    assert.equal(typeof chatCall[1].clientMessageId, 'string');
    assert.equal(chatCall[1].clientMessageId, remote.messages[chatCall[1].chatId][0].id);
    const chatIndex = calls.indexOf(chatCall);
    assert.ok(calls.slice(0, chatIndex).some(call => call[0] === 'putState'));
    assert.ok(calls.slice(chatIndex + 1).some(call => call[0] === 'putState'));
  } finally { dom.window.close(); }
});
