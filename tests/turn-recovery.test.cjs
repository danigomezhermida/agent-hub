const test = require('node:test');
const assert = require('node:assert/strict');

const recovery = require('../hermes-plugin/dashboard/dist/turn-recovery.js');

function memoryStore(initial) {
  const values = new Map(Object.entries(initial || {}));
  const calls = [];
  return {
    calls,
    async get(key) { calls.push(['get', key]); return values.get(key); },
    async set(key, value) { calls.push(['set', key, value]); values.set(key, value); },
    async delete(key) { calls.push(['delete', key]); values.delete(key); },
    peek(key) { return values.get(key); }
  };
}

const idle = { output: 'Hermes TUI Status\nAgent Running: No' };
const running = { output: 'Hermes TUI Status\nAgent Running: Yes' };

function baseHistory() {
  return [
    { role: 'user', text: 'antes', row_id: 10 },
    { role: 'assistant', text: 'respuesta anterior', row_id: 11 }
  ];
}

async function pending(overrides = {}) {
  return recovery.createPendingEntry({
    pendingId: 'pending-1',
    sessionId: 'session-1',
    clientMessageId: 'client-1',
    promptText: 'mensaje exacto',
    baselineHistory: baseHistory(),
    createdAt: 123,
    ...overrides
  });
}

function completedHistory(correlation = { client_message_id: 'client-1' }) {
  return [
    ...baseHistory(),
    { role: 'user', text: 'mensaje exacto', row_id: 12, ...correlation },
    { role: 'assistant', text: 'respuesta recuperada', row_id: 13 }
  ];
}

test('captures an immutable durable baseline and hashes the exact unmodified prompt', async () => {
  const history = baseHistory();
  const entry = await pending({ baselineHistory: history });
  history[0].row_id = 999;

  assert.deepEqual(entry.baseline, {
    historyCount: 2,
    durableRows: [{ ordinal: 0, rowId: 10 }, { ordinal: 1, rowId: 11 }]
  });
  assert.equal(entry.promptDigest, await recovery.digestText('mensaje exacto'));
  assert.equal(entry.promptText, undefined);
  assert.equal(JSON.stringify(entry).includes('hidden'), false);
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.baseline));
});

test('captureAndPersistPending reads baseline once and stores before returning', async () => {
  const store = memoryStore();
  let reads = 0;
  const entry = await recovery.captureAndPersistPending({
    key: 'chat-1', store,
    readHistory: async sessionId => { reads += 1; assert.equal(sessionId, 'session-1'); return { messages: baseHistory() }; },
    pendingId: 'pending-1', sessionId: 'session-1', clientMessageId: 'client-1',
    promptText: 'mensaje exacto', createdAt: 123
  });
  assert.equal(reads, 1);
  assert.deepEqual(store.peek('chat-1'), entry);
  assert.equal(store.calls.at(-1)[0], 'set');
});

test('recovers only a stable, idle, correlated durable turn and deletes pending', async () => {
  const entry = await pending();
  const store = memoryStore({ chat: entry });
  let statusReads = 0, historyReads = 0;
  const result = await recovery.reconcilePending({
    key: 'chat', store,
    readStatus: async sessionId => { statusReads += 1; assert.equal(sessionId, 'session-1'); return idle; },
    readHistory: async () => { historyReads += 1; return { messages: completedHistory() }; }
  });

  assert.deepEqual(result, {
    state: 'completed',
    text: 'respuesta recuperada',
    sessionId: 'session-1',
    clientMessageId: 'client-1',
    userRowId: 12,
    assistantRowId: 13
  });
  assert.equal(statusReads, 2);
  assert.equal(historyReads, 2);
  assert.equal(store.peek('chat'), undefined);
  assert.deepEqual(store.calls.at(-1), ['delete', 'chat']);
});

test('real Hermes history shape without persisted correlation stays uncertain', async () => {
  const entry = await pending();
  const store = memoryStore({ chat: entry });
  const result = await recovery.reconcilePending({
    key: 'chat', store,
    readStatus: async () => idle,
    readHistory: async () => ({ messages: completedHistory({}) })
  });
  assert.deepEqual(result, { state: 'uncertain', reason: 'correlation-unavailable' });
  assert.equal(store.peek('chat'), entry);
  assert.equal(store.calls.some(call => call[0] === 'delete'), false);
});

test('running, baseline drift, unstable reads, and extra user turns all fail closed', async t => {
  const entry = await pending();
  const cases = [
    {
      name: 'running', expected: 'turn-running',
      statuses: [running], histories: []
    },
    {
      name: 'baseline drift', expected: 'baseline-drift', statuses: [idle, idle],
      histories: [completedHistory().map((row, index) => index === 0 ? { ...row, row_id: 99 } : row)]
    },
    {
      name: 'unstable', expected: 'history-unstable', statuses: [idle, idle],
      histories: [completedHistory(), [...completedHistory(), { role: 'assistant', text: 'late', row_id: 14 }]]
    },
    {
      name: 'extra user', expected: 'unexpected-user-turn', statuses: [idle, idle],
      histories: [[...completedHistory(), { role: 'user', text: 'otro', row_id: 14 }]]
    }
  ];

  for (const item of cases) await t.test(item.name, async () => {
    const store = memoryStore({ chat: entry });
    let si = 0, hi = 0;
    const result = await recovery.reconcilePending({
      key: 'chat', store,
      readStatus: async () => item.statuses[Math.min(si++, item.statuses.length - 1)],
      readHistory: async () => ({ messages: item.histories[Math.min(hi++, item.histories.length - 1)] })
    });
    assert.deepEqual(result, { state: 'uncertain', reason: item.expected });
    assert.equal(store.peek('chat'), entry);
  });
});

test('digest mismatch, nonfinal tail, malformed evidence, and read failures stay uncertain', async t => {
  const entry = await pending();
  const cases = [
    ['prompt-digest-mismatch', completedHistory().map((row, i) => i === 2 ? { ...row, text: 'otro texto' } : row)],
    ['assistant-not-final', completedHistory().slice(0, -1)],
    ['assistant-not-final', [...completedHistory().slice(0, -1), { role: 'assistant', text: '', row_id: 13 }]],
    ['malformed-history', { nope: true }]
  ];
  for (const [reason, evidence] of cases) await t.test(reason + JSON.stringify(evidence).length, async () => {
    const result = await recovery.reconcilePending({
      pending: entry,
      readStatus: async () => idle,
      readHistory: async () => Array.isArray(evidence) ? { messages: evidence } : evidence
    });
    assert.deepEqual(result, { state: 'uncertain', reason });
  });
  const failed = await recovery.reconcilePending({
    pending: entry,
    readStatus: async () => { throw new Error('offline'); },
    readHistory: async () => { throw new Error('must not leak'); }
  });
  assert.deepEqual(failed, { state: 'uncertain', reason: 'inspection-failed' });
});

test('reconciliation is bounded and has no submit or retry callback', async () => {
  const entry = await pending();
  let statusReads = 0, historyReads = 0;
  const result = await recovery.reconcilePending({
    pending: entry,
    readStatus: async () => { statusReads += 1; return idle; },
    readHistory: async () => { historyReads += 1; return { messages: completedHistory({}) }; }
  });
  assert.equal(result.state, 'uncertain');
  assert.ok(statusReads <= 2);
  assert.ok(historyReads <= 2);
  assert.equal('submit' in recovery, false);
  assert.equal('retry' in recovery, false);
});

test('definite rejection classifier accepts only exact installed pre-background codes', () => {
  for (const code of [4001, 4009, 4090, 4122, 5070, 5071, 5072, 5122]) {
    assert.equal(recovery.isDefinitePromptRejection({ code }), true, String(code));
    assert.equal(recovery.isDefinitePromptRejection({ error: { code } }), true, `nested ${code}`);
  }
  for (const value of [
    { code: 5000 }, { code: -32603 }, { code: '4001' }, { message: 'no active session' },
    new Error('timeout'), null, undefined
  ]) assert.equal(recovery.isDefinitePromptRejection(value), false);
});

test('settleDefinitePromptRejection clears only proven rejection and never retries', async () => {
  const entry = await pending();
  const store = memoryStore({ chat: entry });
  assert.deepEqual(await recovery.settleDefinitePromptRejection({ key: 'chat', store, error: { code: 5000 } }), {
    state: 'uncertain', reason: 'rpc-outcome-uncertain'
  });
  assert.equal(store.peek('chat'), entry);
  assert.deepEqual(await recovery.settleDefinitePromptRejection({ key: 'chat', store, error: { error: { code: 4001 } } }), {
    state: 'rejected', code: 4001
  });
  assert.equal(store.peek('chat'), undefined);
});
