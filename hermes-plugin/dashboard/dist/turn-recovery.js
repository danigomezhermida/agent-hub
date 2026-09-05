/* Safe, bounded uncertain-turn inspection. This module never submits prompts. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentHubTurnRecovery = api;
})(typeof globalThis === 'object' ? globalThis : self, function (root) {
  'use strict';

  const DEFINITE_PROMPT_REJECTION_CODES = Object.freeze([
    4001, // no active runtime session
    4009, // lazy/subagent session still running
    4090, // active-session slot limit
    4122, // gateway-managed room
    5070, // disk full before background run
    5071, // session persistence failure before background run
    5072, // session storage unavailable before background run
    5122  // group ownership probe unavailable
  ]);
  const definiteCodes = new Set(DEFINITE_PROMPT_REJECTION_CODES);

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }

  function requireNonEmptyString(value, field) {
    if (typeof value !== 'string' || !value) throw new TypeError(field + ' must be a non-empty string');
    return value;
  }

  function durableRowId(row) {
    const value = row && (row.row_id !== undefined ? row.row_id : row.rowId);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }

  function historyMessages(value) {
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.messages)) return value.messages;
    return null;
  }

  function rowText(row) {
    if (!row || typeof row !== 'object') return null;
    if (typeof row.text === 'string') return row.text;
    if (typeof row.content === 'string') return row.content;
    return null;
  }

  function rowCorrelation(row) {
    if (!row || typeof row !== 'object') return null;
    for (const key of ['client_message_id', 'clientMessageId', 'message_id']) {
      if (typeof row[key] === 'string' && row[key]) return row[key];
    }
    return null;
  }

  async function digestText(text) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const crypto = root && root.crypto;
    if (!crypto || !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
      throw new Error('Web Crypto SHA-256 is required');
    }
    const bytes = new TextEncoder().encode(text);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function createPendingEntry(options) {
    const input = options || {};
    const promptText = typeof input.promptText === 'string'
      ? input.promptText
      : (() => { throw new TypeError('promptText must be a string'); })();
    const history = historyMessages(input.baselineHistory);
    if (!history) throw new TypeError('baselineHistory must be an array or {messages: array}');

    const durableRows = [];
    for (let ordinal = 0; ordinal < history.length; ordinal += 1) {
      const rowId = durableRowId(history[ordinal]);
      if (rowId !== null) durableRows.push({ ordinal, rowId });
    }
    const createdAt = input.createdAt === undefined ? Date.now() : input.createdAt;
    if (!Number.isFinite(createdAt)) throw new TypeError('createdAt must be finite');

    return deepFreeze({
      version: 1,
      pendingId: requireNonEmptyString(input.pendingId, 'pendingId'),
      sessionId: requireNonEmptyString(input.sessionId, 'sessionId'),
      clientMessageId: requireNonEmptyString(input.clientMessageId, 'clientMessageId'),
      promptDigest: await digestText(promptText),
      baseline: {
        historyCount: history.length,
        durableRows
      },
      createdAt
    });
  }

  function requireStore(store, methods) {
    if (!store || typeof store !== 'object') throw new TypeError('store is required');
    for (const method of methods) {
      if (typeof store[method] !== 'function') throw new TypeError('store.' + method + ' is required');
    }
  }

  async function captureAndPersistPending(options) {
    const input = options || {};
    requireStore(input.store, ['set']);
    requireNonEmptyString(input.key, 'key');
    if (typeof input.readHistory !== 'function') throw new TypeError('readHistory is required');
    const baselineHistory = await input.readHistory(input.sessionId);
    const entry = await createPendingEntry({ ...input, baselineHistory });
    await input.store.set(input.key, entry);
    return entry;
  }

  function statusState(value) {
    if (!value || typeof value !== 'object') return 'unknown';
    if (value.running === true) return 'running';
    if (value.running === false) return 'idle';
    if (typeof value.output === 'string') {
      if (/^Agent Running: Yes$/m.test(value.output)) return 'running';
      if (/^Agent Running: No$/m.test(value.output)) return 'idle';
    }
    return 'unknown';
  }

  function stableEvidence(messages) {
    return JSON.stringify(messages.map(row => ({
      role: row && row.role,
      text: rowText(row),
      rowId: durableRowId(row),
      correlation: rowCorrelation(row)
    })));
  }

  function validPending(entry) {
    return Boolean(
      entry && entry.version === 1 && typeof entry.sessionId === 'string' && entry.sessionId &&
      typeof entry.clientMessageId === 'string' && entry.clientMessageId &&
      typeof entry.promptDigest === 'string' && /^[a-f0-9]{64}$/.test(entry.promptDigest) &&
      entry.baseline && Number.isSafeInteger(entry.baseline.historyCount) && entry.baseline.historyCount >= 0 &&
      Array.isArray(entry.baseline.durableRows) && entry.baseline.durableRows.every(item =>
        item && Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 &&
        Number.isSafeInteger(item.rowId) && item.rowId > 0)
    );
  }

  function baselineMatches(entry, messages) {
    if (messages.length < entry.baseline.historyCount) return false;
    return entry.baseline.durableRows.every(item =>
      item.ordinal < entry.baseline.historyCount && durableRowId(messages[item.ordinal]) === item.rowId
    );
  }

  function uncertain(reason) {
    return { state: 'uncertain', reason };
  }

  async function reconcilePending(options) {
    const input = options || {};
    if (typeof input.readStatus !== 'function' || typeof input.readHistory !== 'function') {
      throw new TypeError('readStatus and readHistory are required');
    }

    let entry = input.pending;
    if (entry === undefined) {
      requireStore(input.store, ['get']);
      requireNonEmptyString(input.key, 'key');
      try { entry = await input.store.get(input.key); }
      catch (_) { return uncertain('inspection-failed'); }
    }
    if (!validPending(entry)) return uncertain('pending-invalid');

    try {
      const firstStatus = statusState(await input.readStatus(entry.sessionId));
      if (firstStatus === 'running') return uncertain('turn-running');
      if (firstStatus !== 'idle') return uncertain('status-indeterminate');

      const firstMessages = historyMessages(await input.readHistory(entry.sessionId));
      if (!firstMessages) return uncertain('malformed-history');
      if (!baselineMatches(entry, firstMessages)) return uncertain('baseline-drift');

      const secondStatus = statusState(await input.readStatus(entry.sessionId));
      if (secondStatus === 'running') return uncertain('turn-running');
      if (secondStatus !== 'idle') return uncertain('status-indeterminate');

      const secondMessages = historyMessages(await input.readHistory(entry.sessionId));
      if (!secondMessages) return uncertain('malformed-history');
      if (stableEvidence(firstMessages) !== stableEvidence(secondMessages)) {
        return uncertain('history-unstable');
      }
      if (!baselineMatches(entry, secondMessages)) return uncertain('baseline-drift');

      const delta = secondMessages.slice(entry.baseline.historyCount);
      const user = delta[0];
      if (!user || user.role !== 'user' || durableRowId(user) === null) {
        return uncertain('expected-user-not-found');
      }
      const userText = rowText(user);
      if (userText === null || await digestText(userText) !== entry.promptDigest) {
        return uncertain('prompt-digest-mismatch');
      }
      const correlation = rowCorrelation(user);
      if (correlation === null) return uncertain('correlation-unavailable');
      if (correlation !== entry.clientMessageId) return uncertain('correlation-mismatch');
      if (delta.slice(1).some(row => row && row.role === 'user')) {
        return uncertain('unexpected-user-turn');
      }

      const assistant = delta[delta.length - 1];
      const text = rowText(assistant);
      if (!assistant || assistant.role !== 'assistant' || durableRowId(assistant) === null ||
          typeof text !== 'string' || !text.trim()) {
        return uncertain('assistant-not-final');
      }

      if (input.store !== undefined || input.key !== undefined) {
        requireStore(input.store, ['delete']);
        requireNonEmptyString(input.key, 'key');
        await input.store.delete(input.key);
      }
      return {
        state: 'completed',
        text,
        sessionId: entry.sessionId,
        clientMessageId: entry.clientMessageId,
        userRowId: durableRowId(user),
        assistantRowId: durableRowId(assistant)
      };
    } catch (_) {
      return uncertain('inspection-failed');
    }
  }

  function rejectionCode(error) {
    const candidate = error && typeof error === 'object' && error.error && typeof error.error === 'object'
      ? error.error.code
      : error && typeof error === 'object' ? error.code : undefined;
    return Number.isSafeInteger(candidate) ? candidate : null;
  }

  function isDefinitePromptRejection(error) {
    const code = rejectionCode(error);
    return code !== null && definiteCodes.has(code);
  }

  async function settleDefinitePromptRejection(options) {
    const input = options || {};
    const code = rejectionCode(input.error);
    if (code === null || !definiteCodes.has(code)) return uncertain('rpc-outcome-uncertain');
    try {
      requireStore(input.store, ['delete']);
      requireNonEmptyString(input.key, 'key');
      await input.store.delete(input.key);
      return { state: 'rejected', code };
    } catch (_) {
      return uncertain('storage-failed');
    }
  }

  return Object.freeze({
    DEFINITE_PROMPT_REJECTION_CODES,
    captureAndPersistPending,
    createPendingEntry,
    digestText,
    isDefinitePromptRejection,
    reconcilePending,
    settleDefinitePromptRejection
  });
});
