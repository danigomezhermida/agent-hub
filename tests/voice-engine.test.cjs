const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

const modulePath = path.join(__dirname, '..', 'voice-engine.js');
const load = () => {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function track() { return { enabled: true, stopped: 0, stop() { this.stopped += 1; } }; }
function stream(tracks = [track()]) { return { tracks, getTracks() { return tracks; }, getAudioTracks() { return tracks; } }; }

test('browser IIFE installs the AgentVoice API on window', () => {
  const context = { Blob, AbortController, setTimeout, clearTimeout, setInterval, clearInterval };
  context.window = context; context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), context);
  assert.deepEqual(Array.from(Object.keys(context.AgentVoice)).sort(), ['AudioStore', 'Live', 'Recorder']);
});

class MockMediaRecorder {
  static supported = new Set(['audio/webm;codecs=opus']);
  static isTypeSupported(type) { return this.supported.has(type); }
  static instances = [];
  constructor(input, options = {}) { this.stream = input; this.mimeType = options.mimeType || 'audio/browser'; this.state = 'inactive'; this.listeners = {}; this.chunks = []; MockMediaRecorder.instances.push(this); }
  addEventListener(name, fn, options = {}) { (this.listeners[name] ||= []).push({ fn, once: !!options.once }); }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((x) => x.fn !== fn); }
  emit(name, event = {}) { const list = [...(this.listeners[name] || [])]; this.listeners[name] = (this.listeners[name] || []).filter((x) => !x.once); for (const item of list) item.fn(event); const prop = this[`on${name}`]; if (prop) prop(event); }
  start() { this.state = 'recording'; }
  stop() { if (this.state === 'inactive') return; this.state = 'inactive'; for (const value of this.chunks) this.emit('dataavailable', { data: value }); this.emit('stop'); }
}

test('Recorder negotiates MIME and finish returns blob/duration while stopping all tracks', async () => {
  const { Recorder } = load();
  const tracks = [track(), track()]; let now = 100;
  const recorder = new Recorder({ mediaDevices: { getUserMedia: async () => stream(tracks) }, MediaRecorder: MockMediaRecorder, now: () => now });
  await recorder.start();
  const native = MockMediaRecorder.instances.at(-1);
  assert.equal(native.mimeType, 'audio/webm;codecs=opus');
  native.chunks.push(new Blob(['voice'], { type: native.mimeType }));
  now = 850;
  const result = await recorder.finish();
  assert.equal(result.duration, 750);
  assert.equal(await result.blob.text(), 'voice');
  assert.deepEqual(tracks.map((item) => item.stopped), [1, 1]);
});

test('Recorder bounds microphone permission and cleans a late stream', async () => {
  const { Recorder } = load();
  const permission = deferred(); const lateTrack = track();
  const recorder = new Recorder({ mediaDevices: { getUserMedia: () => permission.promise }, MediaRecorder: MockMediaRecorder, permissionTimeoutMs: 5 });
  await assert.rejects(recorder.start(), (error) => error.code === 'permission_timeout');
  permission.resolve(stream([lateTrack]));
  await tick();
  assert.equal(lateTrack.stopped, 1);
});

test('Recorder cancel fences pending permission and remains idempotent', async () => {
  const { Recorder } = load();
  const permission = deferred(); const lateTrack = track();
  const recorder = new Recorder({ mediaDevices: { getUserMedia: () => permission.promise }, MediaRecorder: MockMediaRecorder, permissionTimeoutMs: 100 });
  const starting = recorder.start();
  await recorder.cancel(); await recorder.cancel();
  await assert.rejects(starting, (error) => error.code === 'cancelled');
  permission.resolve(stream([lateTrack])); await tick();
  assert.equal(lateTrack.stopped, 1);
});

test('Recorder rejects recordings beyond six MiB and enforces duration cap', async () => {
  const { Recorder } = load();
  let fireMax; const tr = track();
  const recorder = new Recorder({ mediaDevices: { getUserMedia: async () => stream([tr]) }, MediaRecorder: MockMediaRecorder, maxBytes: 3, maxDurationMs: 10, setTimeout: (fn) => { fireMax = fn; return 1; }, clearTimeout() {} });
  await recorder.start();
  const native = MockMediaRecorder.instances.at(-1);
  native.chunks.push(new Blob(['four']));
  fireMax();
  await assert.rejects(recorder.finish(), (error) => error.code === 'audio_too_large');
  assert.equal(tr.stopped, 1);
});

test('Recorder cancel rejects a later finish and discards active chunks', async () => {
  const { Recorder } = load(); const tr = track();
  const recorder = new Recorder({ mediaDevices: { getUserMedia: async () => stream([tr]) }, MediaRecorder: MockMediaRecorder });
  await recorder.start();
  MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['discard me']));
  await recorder.cancel();
  await assert.rejects(recorder.finish(), (error) => error.code === 'cancelled');
  assert.equal(tr.stopped, 1);
});

test('AudioStore persists blobs and binds retrieval to the owning chat', async () => {
  const { indexedDB } = require('/opt/data/agenthub-test-tools/node_modules/fake-indexeddb');
  const { AudioStore } = load();
  const store = new AudioStore({ indexedDB, dbName: `voice-${Date.now()}-${Math.random()}` });
  const blob = new Blob(['memo'], { type: 'audio/webm' });
  await store.put('audio-1', 'chat-a', blob);
  assert.equal(await (await store.get('audio-1', 'chat-a')).text(), 'memo');
  assert.equal(await store.get('audio-1', 'chat-b'), undefined);
  await store.remove('audio-1');
  assert.equal(await store.get('audio-1', 'chat-a'), undefined);
  await store.close();
});

test('AudioStore validates identifiers and blobs', async () => {
  const { indexedDB } = require('/opt/data/agenthub-test-tools/node_modules/fake-indexeddb');
  const { AudioStore } = load();
  const store = new AudioStore({ indexedDB, dbName: `voice-${Date.now()}-${Math.random()}` });
  await assert.rejects(store.put('', 'chat-a', new Blob(['x'])), (error) => error.code === 'invalid_audio_record');
  await assert.rejects(store.put('audio-1', '', new Blob(['x'])), (error) => error.code === 'invalid_audio_record');
  await assert.rejects(store.put('audio-1', 'chat-a', 'not-a-blob'), (error) => error.code === 'invalid_audio_record');
  await store.close();
});

test('AudioStore writes resolve on transaction completion, not request success', async () => {
  let completeTransaction;
  const db = {
    objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const transaction = {
        objectStore: () => ({ put: () => { const request = {}; queueMicrotask(() => request.onsuccess?.()); return request; } }),
        abort() {}
      };
      completeTransaction = () => transaction.oncomplete();
      return transaction;
    }
  };
  const indexedDB = { open: () => { const request = { result: db }; queueMicrotask(() => request.onsuccess()); return request; } };
  const { AudioStore } = load(); const store = new AudioStore({ indexedDB });
  let settled = false;
  const writing = store.put('audio-1', 'chat-a', new Blob(['x'])).then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  completeTransaction(); await writing;
  assert.equal(settled, true);
});

class FakeAnalyser {
  constructor() { this.value = 0; this.fftSize = 32; }
  getFloatTimeDomainData(array) { array.fill(this.value); }
}
class FakeAudioContext {
  static instances = [];
  constructor() { this.analyser = new FakeAnalyser(); this.closed = false; FakeAudioContext.instances.push(this); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return this.analyser; }
  async resume() {}
  async close() { this.closed = true; }
}
function liveHarness(overrides = {}) {
  const microphone = stream([track()]);
  const intervals = new Map(); let intervalId = 0;
  const timeouts = new Map(); let timeoutId = 0;
  const calls = { states: [], turns: [], spoken: [], interrupts: 0, connects: 0, closes: 0 };
  const options = {
    mediaDevices: { getUserMedia: async () => microphone }, MediaRecorder: MockMediaRecorder, AudioContext: FakeAudioContext, Blob,
    setInterval(fn) { const id = ++intervalId; intervals.set(id, fn); return id; }, clearInterval(id) { intervals.delete(id); },
    setTimeout(fn) { const id = ++timeoutId; timeouts.set(id, fn); return id; }, clearTimeout(id) { timeouts.delete(id); },
    speechFrames: 1, silenceMs: 0, now: (() => { let n = 0; return () => ++n * 100; })(),
    connect: async () => { calls.connects += 1; }, close: async () => { calls.closes += 1; },
    onTurn: async (value) => { calls.turns.push(value); return 'respuesta'; },
    speak: async (text) => { calls.spoken.push(text); }, interrupt: () => { calls.interrupts += 1; },
    onState: (state) => calls.states.push(state), ...overrides
  };
  const { Live } = load();
  const live = new Live(options);
  const sample = (value) => { FakeAudioContext.instances.at(-1).analyser.value = value; for (const fn of [...intervals.values()]) fn(); };
  return { live, calls, microphone, sample, intervals, timeouts };
}

test('Live runs browser RMS VAD, serial turn callback and TTS state flow', async () => {
  MockMediaRecorder.instances.length = 0;
  const h = liveHarness();
  await h.live.start();
  assert.deepEqual(h.calls.states.slice(0, 3), ['requesting', 'connecting', 'listening']);
  h.sample(0.3);
  MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['utterance']));
  h.sample(0);
  await tick(); await tick();
  assert.equal(h.calls.turns.length, 1);
  assert.equal(await h.calls.turns[0].blob.text(), 'utterance');
  assert.equal(typeof h.calls.turns[0].id, 'string');
  assert.equal(h.calls.spoken[0], 'respuesta');
  assert.equal(h.live.state, 'listening');
  assert.ok(h.calls.states.includes('processing'));
  assert.ok(h.calls.states.includes('speaking'));
  await h.live.end();
});

test('Live barge-in interrupts playback immediately and serializes pending TTS transport', async () => {
  MockMediaRecorder.instances.length = 0;
  const speaking = deferred();
  let playbackSignal;
  const h = liveHarness({ speak: async (text, context) => { h.calls.spoken.push(text); playbackSignal = context.signal; return speaking.promise; } });
  await h.live.start();
  h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['one'])); h.sample(0);
  await tick(); await tick();
  assert.equal(h.live.state, 'speaking');
  h.sample(0.3);
  assert.equal(h.calls.interrupts, 1);
  assert.equal(playbackSignal.aborted, true);
  assert.equal(MockMediaRecorder.instances.at(-1).state, 'recording');
  MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['two'])); h.sample(0); await tick();
  assert.equal(h.calls.turns.length, 1);
  speaking.resolve();
  await tick(); await tick();
  assert.equal(h.calls.turns.length, 2);
  await h.live.end();
});

test('Live retains the oldest pending utterance and pauses capture when its bounded queue is full', async () => {
  MockMediaRecorder.instances.length = 0;
  const first = deferred(); let number = 0;
  const h = liveHarness({ onTurn: async (value) => { h.calls.turns.push(value); number += 1; return number === 1 ? first.promise : `r${number}`; } });
  await h.live.start();
  for (const word of ['first', 'second']) {
    h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob([word])); h.sample(0); await tick();
  }
  const recorderCount = MockMediaRecorder.instances.length;
  h.sample(0.3); h.sample(0);
  assert.equal(MockMediaRecorder.instances.length, recorderCount);
  assert.equal(h.calls.turns.length, 1);
  first.resolve('r1'); await tick(); await tick(); await tick();
  assert.equal(h.calls.turns.length, 2);
  assert.equal(await h.calls.turns[1].blob.text(), 'second');
  await h.live.end();
});

test('Live end fences stale playback but lets in-flight history callback finish', async () => {
  MockMediaRecorder.instances.length = 0;
  const history = deferred();
  const h = liveHarness({ onTurn: async (value) => { h.calls.turns.push(value); return history.promise; } });
  await h.live.start();
  h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['history'])); h.sample(0); await tick();
  assert.equal(h.calls.turns.length, 1);
  await h.live.end();
  history.resolve('stale'); await tick(); await tick();
  assert.equal(h.calls.spoken.length, 0);
  assert.equal(h.live.state, 'ended');
  assert.equal(h.calls.closes, 1);
  assert.equal(h.microphone.tracks[0].stopped, 1);
  assert.equal(FakeAudioContext.instances.at(-1).closed, true);
});

test('Live mute toggles microphone tracks and call timeout tears down', async () => {
  MockMediaRecorder.instances.length = 0;
  const h = liveHarness();
  await h.live.start();
  h.live.setMuted(true); assert.equal(h.microphone.tracks[0].enabled, false);
  h.sample(0.3); assert.equal(MockMediaRecorder.instances.length, 0);
  h.live.setMuted(false); assert.equal(h.microphone.tracks[0].enabled, true);
  const callTimer = [...h.timeouts.values()].at(-1); callTimer(); await tick();
  assert.equal(h.live.state, 'ended');
});

test('Live suppresses a response made stale by speech during processing', async () => {
  MockMediaRecorder.instances.length = 0;
  const first = deferred(); let turn = 0;
  const h = liveHarness({ onTurn: async (value) => { h.calls.turns.push(value); turn += 1; return turn === 1 ? first.promise : 'fresh'; } });
  await h.live.start();
  h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['one'])); h.sample(0); await tick();
  h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['two'])); h.sample(0); await tick();
  first.resolve('stale'); await tick(); await tick(); await tick();
  assert.deepEqual(h.calls.spoken, ['fresh']);
  assert.equal(h.calls.turns.length, 2);
  await h.live.end();
});

test('Live normalizes bridge transcription objects before onTurn', async () => {
  MockMediaRecorder.instances.length = 0;
  const h = liveHarness({ transcribe: async () => ({ transcript: 'hola' }) });
  await h.live.start();
  h.sample(0.3); MockMediaRecorder.instances.at(-1).chunks.push(new Blob(['audio'])); h.sample(0);
  await tick(); await tick();
  assert.equal(h.calls.turns[0].transcript, 'hola');
  await h.live.end();
});

test('Live end cancels pending permission and stops a stream that arrives late', async () => {
  const permission = deferred(); const lateTrack = track();
  const { Live } = load();
  const states = [];
  const live = new Live({
    mediaDevices: { getUserMedia: () => permission.promise }, MediaRecorder: MockMediaRecorder, AudioContext: FakeAudioContext, Blob,
    permissionTimeoutMs: 1000, onTurn: async () => '', onState: (state) => states.push(state)
  });
  const starting = live.start();
  await live.end();
  await assert.rejects(starting, (error) => error.code === 'cancelled');
  permission.resolve(stream([lateTrack])); await tick();
  assert.equal(lateTrack.stopped, 1);
  assert.equal(states.at(-1), 'ended');
});

test('Live end during connect closes transport again if connect resolves late', async () => {
  const connecting = deferred(); let closes = 0;
  const h = liveHarness({ connect: () => connecting.promise, close: async () => { closes += 1; } });
  const starting = h.live.start(); await tick();
  await h.live.end();
  connecting.resolve();
  await assert.rejects(starting, (error) => error.code === 'cancelled');
  assert.equal(closes, 2);
  assert.equal(h.microphone.tracks[0].stopped, 1);
});

test('Live reconnect retries are bounded', async () => {
  MockMediaRecorder.instances.length = 0;
  let requests = 0; let fail = false;
  const h = liveHarness({
    mediaDevices: { getUserMedia: async () => { requests += 1; if (fail) throw Error('offline'); return stream([track()]); } },
    reconnectAttempts: 2, reconnectDelayMs: 0
  });
  await h.live.start();
  fail = true;
  await assert.rejects(h.live.reconnect(), (error) => error.code === 'live_start_failed');
  assert.equal(requests, 3);
  assert.equal(h.live.state, 'error');
  assert.ok(h.calls.states.includes('reconnecting'));
});
