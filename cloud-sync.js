(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentCloudSync = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var EMPTY = { chats: [], messages: {}, sessions: {} };

  function copy(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeSnapshot(value) {
    value = value && typeof value === 'object' ? value : EMPTY;
    return {
      chats: Array.isArray(value.chats) ? copy(value.chats) : [],
      messages: value.messages && typeof value.messages === 'object' && !Array.isArray(value.messages) ? copy(value.messages) : {},
      sessions: value.sessions && typeof value.sessions === 'object' && !Array.isArray(value.sessions) ? copy(value.sessions) : {}
    };
  }

  // Demo/seed rows have no messages. They remain local presentation data only.
  function uploadableSnapshot(value) {
    var source = normalizeSnapshot(value);
    var ids = new Set(source.chats.filter(function (item) {
      return item && typeof item.id === 'string' && Array.isArray(source.messages[item.id]) && source.messages[item.id].length > 0;
    }).map(function (item) { return item.id; }));
    var chats = source.chats.filter(function (item) { return item && ids.has(item.id); });
    var messages = {}, sessions = {};
    ids.forEach(function (id) {
      messages[id] = source.messages[id];
      if (typeof source.sessions[id] === 'string' && source.sessions[id]) sessions[id] = source.sessions[id];
    });
    return copy({ chats: chats, messages: messages, sessions: sessions });
  }

  function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    Object.keys(value).sort().forEach(function (key) {
      if (value[key] !== undefined && typeof value[key] !== 'function' && typeof value[key] !== 'symbol') {
        result[key] = canonicalValue(value[key]);
      }
    });
    return result;
  }

  function sameValue(left, right) {
    return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
  }

  function initialConflict(kind, id) {
    var error = syncError('initial_sync_conflict', 'La copia local y la remota contienen versiones distintas del mismo elemento.');
    error.kind = kind;
    error.id = id;
    return error;
  }

  function mergeNewIds(remoteItems, localItems, kind) {
    var result = [], values = new Map();
    remoteItems.concat(localItems).forEach(function (item) {
      if (!item || typeof item.id !== 'string') return;
      if (values.has(item.id)) {
        if (!sameValue(values.get(item.id), item)) throw initialConflict(kind, item.id);
        return;
      }
      values.set(item.id, copy(item));
      result.push(copy(item));
    });
    return result;
  }

  // Initial sync has no trusted common base. Keep remote values for known IDs,
  // accept exact canonical equality, and import only IDs absent from remote.
  function mergeSnapshots(remoteValue, localValue) {
    var remote = uploadableSnapshot(remoteValue), local = uploadableSnapshot(localValue);
    var chats = mergeNewIds(remote.chats, local.chats, 'chat'), messages = {}, sessions = {};
    chats.forEach(function (item) {
      var id = item.id;
      messages[id] = mergeNewIds(remote.messages[id] || [], local.messages[id] || [], 'message');
      if (Object.prototype.hasOwnProperty.call(remote.sessions, id)) sessions[id] = remote.sessions[id];
      if (Object.prototype.hasOwnProperty.call(local.sessions, id)) {
        if (Object.prototype.hasOwnProperty.call(remote.sessions, id) && !sameValue(remote.sessions[id], local.sessions[id])) {
          throw initialConflict('session', id);
        }
        sessions[id] = local.sessions[id];
      }
    });
    return { chats: chats, messages: messages, sessions: sessions };
  }

  function sameSnapshot(left, right) { return sameValue(normalizeSnapshot(left), normalizeSnapshot(right)); }

  function syncError(code, message, cause) {
    var error = cause instanceof Error ? cause : new Error(message);
    error.code = code;
    if (!error.message) error.message = message;
    return error;
  }

  function CloudSync(options) {
    options = options || {};
    if (!options.transport || typeof options.transport.storage !== 'function') throw new Error('Cloud sync requires a storage transport.');
    this.transport = options.transport;
    this.readLocalSnapshot = options.readLocalSnapshot || function () { return EMPTY; };
    this.applySnapshot = options.applySnapshot || function () {};
    this.getLocalAudio = options.getLocalAudio || async function () { return null; };
    this.cacheAudio = options.cacheAudio || async function () {};
    this.clearVisible = options.clearVisible || function () {};
    this.onStatus = options.onStatus || function () {};
    this.ready = false;
    this.revision = null;
    this.remoteSnapshot = null;
    this.queue = Promise.resolve();
  }

  CloudSync.prototype._status = function (state, message, error) {
    this.onStatus({ state: state, message: message, error: error || null });
  };

  CloudSync.prototype._enqueue = function (operation) {
    var run = this.queue.then(operation, operation);
    this.queue = run.catch(function () {});
    return run;
  };

  CloudSync.prototype._assertOwner = async function () {
    var scope = typeof this.transport.ownerScope === 'function' ? this.transport.ownerScope() : null;
    if (scope !== 'personal') {
      this.revoke();
      throw syncError('owner_unverified', 'No se pudo verificar al propietario de esta cuenta.');
    }
    var identity = await this.transport.storage('identity', {});
    if (!identity || identity.scope !== scope || identity.scope !== 'personal') {
      this.revoke();
      throw syncError('owner_unverified', 'No se pudo verificar al propietario de esta cuenta.');
    }
    return scope;
  };

  CloudSync.prototype._assertReady = function () {
    if (typeof this.transport.ownerScope !== 'function' || this.transport.ownerScope() !== 'personal') {
      this.revoke();
      throw syncError('owner_unverified', 'No se pudo verificar al propietario de esta cuenta.');
    }
    if (!this.ready || this.revision === null) throw syncError('sync_required', 'Sincroniza antes de continuar.');
  };

  CloudSync.prototype._audioRefs = function (snapshot) {
    var refs = [];
    snapshot.chats.forEach(function (chat) {
      (snapshot.messages[chat.id] || []).forEach(function (entry) {
        if (entry && typeof entry.audioId === 'string' && entry.audioId) refs.push({ id: entry.audioId, chatId: chat.id });
      });
    });
    return refs;
  };

  CloudSync.prototype._uploadAudio = async function (snapshot) {
    var refs = this._audioRefs(snapshot);
    for (var i = 0; i < refs.length; i += 1) {
      var ref = refs[i], blob = await this.getLocalAudio(ref.id, ref.chatId);
      if (blob) await this.transport.storage('putAudio', { id: ref.id, chatId: ref.chatId, blob: blob });
    }
  };

  CloudSync.prototype._putAndVerify = async function (snapshot) {
    await this._uploadAudio(snapshot);
    var written;
    try {
      written = await this.transport.storage('putState', { expectedRevision: this.revision, snapshot: snapshot });
    } catch (error) {
      if (error && error.code === 'conflict') {
        this.ready = false;
        this._status('conflict', 'La versión remota cambió. Tu copia local se conserva; elige si quieres cargar la remota.', error);
      }
      throw error;
    }
    var verified = await this.transport.storage('getState', {});
    if (!verified || verified.revision !== written.revision || !sameSnapshot(verified.snapshot, snapshot)) {
      this.ready = false;
      throw syncError('readback_failed', 'Hermes no pudo verificar la copia remota. La copia local se conserva.');
    }
    this.revision = verified.revision;
    this.remoteSnapshot = normalizeSnapshot(verified.snapshot);
    return this.remoteSnapshot;
  };

  CloudSync.prototype._initialSync = async function () {
    this._status('syncing', 'Verificando propietario y sincronizando…');
    await this._assertOwner();
    var state = await this.transport.storage('getState', {});
    if (!state || !Number.isInteger(state.revision) || state.revision < 0) throw syncError('invalid_state', 'Hermes devolvió un estado remoto no válido.');
    this.revision = state.revision;
    this.remoteSnapshot = normalizeSnapshot(state.snapshot);
    var local = uploadableSnapshot(this.readLocalSnapshot()), merged;
    try {
      merged = mergeSnapshots(this.remoteSnapshot, local);
    } catch (error) {
      if (error && error.code === 'initial_sync_conflict') {
        this.ready = false;
        this._status('conflict', 'La copia local y la remota son distintas. Ninguna se ha sobrescrito; carga la remota explícitamente o conserva la local.', error);
      }
      throw error;
    }
    if (!sameSnapshot(merged, this.remoteSnapshot)) await this._putAndVerify(merged);
    else this.remoteSnapshot = merged;
    this.applySnapshot(copy(this.remoteSnapshot));
    this.ready = true;
    this._status('ready', 'Sincronización al día.');
    return copy(this.remoteSnapshot);
  };

  CloudSync.prototype.syncFromUserGesture = function () {
    // Do not move this open into a promise callback: popup creation needs activation.
    var opened;
    try { opened = this.transport.openVoice(); }
    catch (error) { return Promise.reject(error); }
    var self = this;
    return this._enqueue(async function () { await opened; return self._initialSync(); });
  };

  CloudSync.prototype.ensureReady = function () {
    var self = this;
    return this._enqueue(async function () { self._assertReady(); return true; });
  };

  CloudSync.prototype._flush = async function () {
    this._assertReady();
    var current = uploadableSnapshot(this.readLocalSnapshot());
    if (!sameSnapshot(current, this.remoteSnapshot)) await this._putAndVerify(current);
    else await this._uploadAudio(current);
    this._status('ready', 'Sincronización al día.');
    return copy(current);
  };

  CloudSync.prototype.beforeTurn = function () {
    var self = this;
    return this._enqueue(function () { return self._flush(); });
  };

  CloudSync.prototype.afterTurn = function () {
    var self = this;
    return this._enqueue(function () { return self._flush(); });
  };

  CloudSync.prototype.getAudio = async function (id, chatId) {
    var self = this;
    return this._enqueue(async function () {
      self._assertReady();
      var local = await self.getLocalAudio(id, chatId);
      if (local) return local;
      var result = await self.transport.storage('getAudio', { id: id, chatId: chatId });
      var blob = result && result.blob ? result.blob : result;
      if (blob) await self.cacheAudio(id, chatId, blob);
      return blob || null;
    });
  };

  CloudSync.prototype.reloadRemote = function () {
    var self = this;
    return this._enqueue(async function () {
      await self._assertOwner();
      var state = await self.transport.storage('getState', {});
      self.revision = state.revision;
      self.remoteSnapshot = normalizeSnapshot(state.snapshot);
      self.applySnapshot(copy(self.remoteSnapshot));
      self.ready = true;
      self._status('ready', 'Versión remota cargada.');
      return copy(self.remoteSnapshot);
    });
  };

  CloudSync.prototype.revoke = function () {
    this.ready = false;
    this.revision = null;
    this.remoteSnapshot = null;
    this.clearVisible();
    this._status('locked', 'Sincroniza con la cuenta propietaria para ver el historial.');
  };

  CloudSync.prototype.isReady = function () { return this.ready; };

  return {
    CloudSync: CloudSync,
    normalizeSnapshot: normalizeSnapshot,
    uploadableSnapshot: uploadableSnapshot,
    mergeSnapshots: mergeSnapshots
  };
});
