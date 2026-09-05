(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentVoice = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  var MIB = 1024 * 1024;
  var MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];

  function voiceError(code, message, cause) {
    var error = new Error(message || code);
    error.code = code;
    if (cause !== undefined) error.cause = cause;
    return error;
  }

  function stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach(function (track) {
      try { track.stop(); } catch (_) { /* cleanup is best effort */ }
    });
  }

  function selectMime(MediaRecorderCtor) {
    if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== 'function') return '';
    for (var i = 0; i < MIME_CANDIDATES.length; i += 1) {
      if (MediaRecorderCtor.isTypeSupported(MIME_CANDIDATES[i])) return MIME_CANDIDATES[i];
    }
    return '';
  }

  function Recorder(options) {
    options = options || {};
    this._mediaDevices = options.mediaDevices || (root.navigator && root.navigator.mediaDevices);
    this._MediaRecorder = options.MediaRecorder || root.MediaRecorder;
    this._Blob = options.Blob || root.Blob;
    this._now = options.now || Date.now;
    this._setTimeout = options.setTimeout || root.setTimeout.bind(root);
    this._clearTimeout = options.clearTimeout || root.clearTimeout.bind(root);
    this._permissionTimeoutMs = options.permissionTimeoutMs == null ? 15000 : options.permissionTimeoutMs;
    this._maxDurationMs = options.maxDurationMs == null ? 120000 : options.maxDurationMs;
    this._maxBytes = options.maxBytes == null ? 6 * MIB : options.maxBytes;
    this._generation = 0;
    this._stream = null;
    this._native = null;
    this._chunks = [];
    this._startedAt = 0;
    this._permissionTimer = null;
    this._durationTimer = null;
    this._cancelStart = null;
    this._outcome = null;
    this._resolveOutcome = null;
    this._rejectOutcome = null;
    this._settled = false;
  }

  Recorder.prototype.start = async function () {
    if (!this._mediaDevices || typeof this._mediaDevices.getUserMedia !== 'function' || !this._MediaRecorder || !this._Blob) {
      throw voiceError('unsupported', 'Audio recording is not supported');
    }
    if (this._native || this._cancelStart) throw voiceError('invalid_state', 'Recorder has already started');

    var self = this;
    var generation = ++this._generation;
    var rawPermission;
    try { rawPermission = Promise.resolve(this._mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })); }
    catch (error) { throw voiceError('permission_denied', 'Microphone permission failed', error); }

    rawPermission.then(function (lateStream) {
      if (generation !== self._generation || !self._cancelStart) stopTracks(lateStream);
    }, function () {});

    var timeoutPromise = new Promise(function (_, reject) {
      self._permissionTimer = self._setTimeout(function () {
        self._permissionTimer = null;
        if (generation === self._generation) {
          self._generation += 1;
          self._cancelStart = null;
          reject(voiceError('permission_timeout', 'Microphone permission timed out'));
        }
      }, self._permissionTimeoutMs);
    });
    var cancelPromise = new Promise(function (_, reject) { self._cancelStart = reject; });

    var acquired;
    try { acquired = await Promise.race([rawPermission, timeoutPromise, cancelPromise]); }
    catch (error) {
      if (this._permissionTimer !== null) this._clearTimeout(this._permissionTimer);
      this._permissionTimer = null;
      this._cancelStart = null;
      if (error && error.code) throw error;
      throw voiceError('permission_denied', 'Microphone permission failed', error);
    }
    if (generation !== this._generation) {
      stopTracks(acquired);
      throw voiceError('cancelled', 'Recording was cancelled');
    }
    this._clearTimeout(this._permissionTimer);
    this._permissionTimer = null;
    this._cancelStart = null;
    this._stream = acquired;
    this._chunks = [];
    this._settled = false;
    this._outcome = new Promise(function (resolve, reject) { self._resolveOutcome = resolve; self._rejectOutcome = reject; });
    this._outcome.catch(function () { /* cancellation may intentionally have no waiter */ });

    var mimeType = selectMime(this._MediaRecorder);
    try { this._native = new this._MediaRecorder(acquired, mimeType ? { mimeType: mimeType } : undefined); }
    catch (error) {
      this._cleanupStream();
      throw voiceError('recorder_start_failed', 'MediaRecorder could not start', error);
    }
    this._native.addEventListener('dataavailable', function (event) {
      if (event.data && event.data.size) self._chunks.push(event.data);
    });
    this._native.addEventListener('error', function (event) {
      self._settleError(voiceError('recorder_error', 'MediaRecorder failed', event.error || event));
    });
    this._native.addEventListener('stop', function () { self._settleRecording(); });
    try {
      this._native.start();
      this._startedAt = this._now();
      this._durationTimer = this._setTimeout(function () { self._stopNative(); }, this._maxDurationMs);
    } catch (error) {
      this._cleanupStream();
      throw voiceError('recorder_start_failed', 'MediaRecorder could not start', error);
    }
    return this;
  };

  Recorder.prototype._stopNative = function () {
    if (this._native && this._native.state !== 'inactive') {
      try { this._native.stop(); } catch (error) { this._settleError(error); }
    }
  };

  Recorder.prototype._cleanupStream = function () {
    if (this._durationTimer !== null) this._clearTimeout(this._durationTimer);
    this._durationTimer = null;
    var active = this._stream;
    this._stream = null;
    stopTracks(active);
  };

  Recorder.prototype._settleError = function (error) {
    if (this._settled) return;
    this._settled = true;
    this._cleanupStream();
    if (this._rejectOutcome) this._rejectOutcome(error && error.code ? error : voiceError('recorder_error', 'MediaRecorder failed', error));
  };

  Recorder.prototype._settleRecording = function () {
    if (this._settled) return;
    this._settled = true;
    var duration = Math.max(0, this._now() - this._startedAt);
    var type = (this._native && this._native.mimeType) || (this._chunks[0] && this._chunks[0].type) || 'audio/webm';
    var blob = new this._Blob(this._chunks, { type: type });
    this._cleanupStream();
    this._chunks = [];
    if (blob.size > this._maxBytes) this._rejectOutcome(voiceError('audio_too_large', 'Audio exceeds maximum size'));
    else this._resolveOutcome({ blob: blob, duration: duration });
  };

  Recorder.prototype.finish = async function () {
    if (!this._outcome) throw voiceError('invalid_state', 'Recorder has not started');
    this._stopNative();
    return this._outcome;
  };

  Recorder.prototype.cancel = async function () {
    this._generation += 1;
    if (this._permissionTimer !== null) this._clearTimeout(this._permissionTimer);
    this._permissionTimer = null;
    if (this._cancelStart) {
      var rejectStart = this._cancelStart;
      this._cancelStart = null;
      rejectStart(voiceError('cancelled', 'Recording was cancelled'));
    }
    if (this._durationTimer !== null) this._clearTimeout(this._durationTimer);
    this._durationTimer = null;
    if (this._outcome && !this._settled) {
      this._settled = true;
      this._rejectOutcome(voiceError('cancelled', 'Recording was cancelled'));
    }
    if (this._native && this._native.state !== 'inactive') {
      this._native.ondataavailable = null;
      try { this._native.stop(); } catch (_) { /* cleanup continues */ }
    }
    this._chunks = [];
    this._cleanupStream();
  };

  function AudioStore(options) {
    options = options || {};
    this._indexedDB = options.indexedDB || root.indexedDB;
    this._Blob = options.Blob || root.Blob;
    this._dbName = options.dbName || 'agenthub-audio';
    this._storeName = options.storeName || 'audio';
    this._dbPromise = null;
  }

  AudioStore.prototype._open = function () {
    if (this._dbPromise) return this._dbPromise;
    if (!this._indexedDB) return Promise.reject(voiceError('indexeddb_unavailable', 'IndexedDB is not available'));
    var self = this;
    this._dbPromise = new Promise(function (resolve, reject) {
      var request = self._indexedDB.open(self._dbName, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(self._storeName)) request.result.createObjectStore(self._storeName, { keyPath: 'id' });
      };
      request.onsuccess = function () {
        request.result.onversionchange = function () { request.result.close(); };
        resolve(request.result);
      };
      request.onerror = function () { reject(request.error || voiceError('indexeddb_open_failed')); };
      request.onblocked = function () { reject(voiceError('indexeddb_blocked', 'IndexedDB open was blocked')); };
    });
    this._dbPromise.catch(function () { self._dbPromise = null; });
    return this._dbPromise;
  };

  AudioStore.prototype._transaction = async function (mode, operation) {
    var db = await this._open();
    var transaction = db.transaction(this._storeName, mode);
    var request;
    try { request = operation(transaction.objectStore(this._storeName)); }
    catch (error) { try { transaction.abort(); } catch (_) {} throw error; }
    return new Promise(function (resolve, reject) {
      var result;
      if (request) {
        request.onsuccess = function () { result = request.result; };
        request.onerror = function () { /* transaction error is authoritative */ };
      }
      transaction.oncomplete = function () { resolve(result); };
      transaction.onerror = function () { reject(transaction.error || (request && request.error) || voiceError('indexeddb_transaction_failed')); };
      transaction.onabort = function () { reject(transaction.error || voiceError('indexeddb_transaction_aborted')); };
    });
  };

  AudioStore.prototype.put = async function (id, chatId, blob) {
    var isBlob = !!blob && typeof blob.size === 'number' && typeof blob.arrayBuffer === 'function';
    if (typeof id !== 'string' || !id || typeof chatId !== 'string' || !chatId || !isBlob) {
      throw voiceError('invalid_audio_record', 'Audio record requires id, chatId and Blob');
    }
    await this._transaction('readwrite', function (store) { return store.put({ id: id, chatId: chatId, blob: blob }); });
  };

  AudioStore.prototype.get = async function (id, chatId) {
    if (typeof id !== 'string' || !id || typeof chatId !== 'string' || !chatId) return undefined;
    var record = await this._transaction('readonly', function (store) { return store.get(id); });
    return record && record.chatId === chatId ? record.blob : undefined;
  };

  AudioStore.prototype.remove = async function (id) {
    if (typeof id !== 'string' || !id) throw voiceError('invalid_audio_record', 'Audio id is required');
    await this._transaction('readwrite', function (store) { return store.delete(id); });
  };

  AudioStore.prototype.close = async function () {
    if (!this._dbPromise) return;
    var db = await this._dbPromise;
    db.close();
    this._dbPromise = null;
  };

  function Live(options) {
    options = options || {};
    this._mediaDevices = options.mediaDevices || (root.navigator && root.navigator.mediaDevices);
    this._MediaRecorder = options.MediaRecorder || root.MediaRecorder;
    this._AudioContext = options.AudioContext || root.AudioContext || root.webkitAudioContext;
    this._AbortController = options.AbortController || root.AbortController;
    this._Blob = options.Blob || root.Blob;
    this._setTimeout = options.setTimeout || root.setTimeout.bind(root);
    this._clearTimeout = options.clearTimeout || root.clearTimeout.bind(root);
    this._setInterval = options.setInterval || root.setInterval.bind(root);
    this._clearInterval = options.clearInterval || root.clearInterval.bind(root);
    this._now = options.now || Date.now;
    this._connect = options.connect || function () {};
    this._close = options.close || function () {};
    this._transcribe = options.transcribe || null;
    this._onTurn = options.onTurn;
    this._speak = options.speak || function () {};
    this._interrupt = options.interrupt || function () {};
    this._onState = options.onState || function () {};
    this._permissionTimeoutMs = options.permissionTimeoutMs == null ? 15000 : options.permissionTimeoutMs;
    this._callDurationMs = options.callDurationMs == null ? 15 * 60 * 1000 : options.callDurationMs;
    this._reconnectAttempts = options.reconnectAttempts == null ? 3 : options.reconnectAttempts;
    this._reconnectDelayMs = options.reconnectDelayMs == null ? 300 : options.reconnectDelayMs;
    this._utteranceDurationMs = options.utteranceDurationMs == null ? 120000 : options.utteranceDurationMs;
    this._maxBytes = options.maxBytes == null ? 6 * MIB : options.maxBytes;
    this._vadIntervalMs = options.vadIntervalMs == null ? 50 : options.vadIntervalMs;
    this._speechThreshold = options.speechThreshold == null ? 0.04 : options.speechThreshold;
    this._speechFrames = options.speechFrames == null ? 2 : options.speechFrames;
    this._silenceMs = options.silenceMs == null ? 600 : options.silenceMs;
    this.state = 'ended';
    this.muted = false;
    this._generation = 0;
    this._stream = null;
    this._context = null;
    this._source = null;
    this._analyser = null;
    this._samples = null;
    this._vadTimer = null;
    this._callTimer = null;
    this._permissionTimer = null;
    this._rejectPermission = null;
    this._speechCount = 0;
    this._silenceSince = null;
    this._utterance = null;
    this._busy = false;
    this._pending = null;
    this._playbackGate = null;
    this._playbackController = null;
    this._speechEpoch = 0;
    this._turnSequence = 0;
    this._connected = false;
  }

  Live.prototype._setState = function (state, error) {
    this.state = state;
    try { this._onState(state, error); } catch (_) { /* observers do not control media */ }
  };

  Live.prototype.start = function () { return this._startGeneration(false); };

  Live.prototype._startGeneration = async function (reconnecting) {
    if (typeof this._onTurn !== 'function') throw voiceError('invalid_callbacks', 'Live requires onTurn');
    if (!this._mediaDevices || typeof this._mediaDevices.getUserMedia !== 'function' || !this._MediaRecorder || !this._AudioContext || !this._Blob) {
      throw voiceError('unsupported', 'Live voice is not supported');
    }
    if (this.state !== 'ended' && !reconnecting) throw voiceError('invalid_state', 'Live session is already active');
    var self = this;
    var generation = ++this._generation;
    this._setState('requesting');
    var rawPermission;
    try { rawPermission = Promise.resolve(this._mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })); }
    catch (error) { this._setState('error', error); throw error; }
    rawPermission.then(function (lateStream) {
      if (generation !== self._generation || !self._rejectPermission) stopTracks(lateStream);
    }, function () {});
    var timeout = new Promise(function (_, reject) {
      self._permissionTimer = self._setTimeout(function () {
        self._permissionTimer = null;
        if (generation === self._generation) {
          self._generation += 1;
          self._rejectPermission = null;
          reject(voiceError('permission_timeout', 'Microphone permission timed out'));
        }
      }, self._permissionTimeoutMs);
    });
    var cancelled = new Promise(function (_, reject) { self._rejectPermission = reject; });
    try {
      var acquired = await Promise.race([rawPermission, timeout, cancelled]);
      if (generation !== this._generation) { stopTracks(acquired); throw voiceError('cancelled', 'Live session ended'); }
      this._clearTimeout(this._permissionTimer);
      this._permissionTimer = null;
      this._rejectPermission = null;
      this._stream = acquired;
      this.setMuted(this.muted);
      this._setState('connecting');
      this._connected = true;
      await this._connect();
      if (generation !== this._generation) {
        try { await this._close(); } catch (_) {}
        this._connected = false;
        throw voiceError('cancelled', 'Live session ended');
      }
      this._context = new this._AudioContext();
      if (typeof this._context.resume === 'function') await this._context.resume();
      this._source = this._context.createMediaStreamSource(this._stream);
      this._analyser = this._context.createAnalyser();
      this._analyser.fftSize = Math.max(32, this._analyser.fftSize || 2048);
      this._samples = new Float32Array(this._analyser.fftSize);
      this._source.connect(this._analyser);
      this._setState('listening');
      this._vadTimer = this._setInterval(function () { self._sampleVad(generation); }, this._vadIntervalMs);
      this._callTimer = this._setTimeout(function () { self.end(); }, this._callDurationMs);
      return this;
    } catch (error) {
      if (this._permissionTimer !== null) this._clearTimeout(this._permissionTimer);
      this._permissionTimer = null;
      this._rejectPermission = null;
      if (error && error.code === 'cancelled' && this.state === 'ended') throw error;
      this._setState('error', error);
      await this._teardown(true);
      throw error && error.code ? error : voiceError('live_start_failed', 'Live voice could not start', error);
    }
  };

  Live.prototype._sampleVad = function (generation) {
    if (generation !== this._generation || !this._analyser || this.muted) {
      this._speechCount = 0;
      this._silenceSince = null;
      return;
    }
    this._analyser.getFloatTimeDomainData(this._samples);
    var sum = 0;
    for (var i = 0; i < this._samples.length; i += 1) sum += this._samples[i] * this._samples[i];
    var rms = Math.sqrt(sum / this._samples.length);
    if (rms >= this._speechThreshold) {
      this._speechCount += 1;
      this._silenceSince = null;
      // With one utterance already queued, pause capture rather than recording
      // speech that the bounded queue cannot retain.
      if (this._speechCount >= this._speechFrames && !this._utterance && !(this._busy && this._pending)) this._beginUtterance(generation);
      return;
    }
    this._speechCount = 0;
    if (!this._utterance) return;
    if (this._silenceSince === null) this._silenceSince = this._now();
    if (this._now() - this._silenceSince >= this._silenceMs) this._stopUtterance();
  };

  Live.prototype._bargeIn = function () {
    if (!this._playbackGate && !this._playbackController) return;
    var gate = this._playbackGate;
    if (this._playbackController) this._playbackController.abort();
    this._playbackController = null;
    try { Promise.resolve(this._interrupt()).catch(function () {}); } catch (_) {}
    if (gate) gate.interrupted = true;
  };

  Live.prototype._beginUtterance = function (generation) {
    if (generation !== this._generation || this.muted || this._utterance) return;
    if (this.state === 'speaking') this._bargeIn();
    this._speechEpoch += 1;
    var mimeType = selectMime(this._MediaRecorder);
    var recorder;
    try { recorder = new this._MediaRecorder(this._stream, mimeType ? { mimeType: mimeType } : undefined); }
    catch (error) { this._setState('error', error); return; }
    var self = this;
    var utterance = { recorder: recorder, chunks: [], startedAt: this._now(), generation: generation, timer: null };
    this._utterance = utterance;
    recorder.addEventListener('dataavailable', function (event) { if (event.data && event.data.size) utterance.chunks.push(event.data); });
    recorder.addEventListener('error', function (event) {
      if (self._utterance === utterance) self._utterance = null;
      self._setState('error', event.error || event);
    });
    recorder.addEventListener('stop', function () { self._completeUtterance(utterance); });
    try {
      recorder.start();
      utterance.timer = this._setTimeout(function () { self._stopUtterance(); }, this._utteranceDurationMs);
    } catch (error) {
      this._utterance = null;
      this._setState('error', error);
    }
  };

  Live.prototype._stopUtterance = function () {
    var utterance = this._utterance;
    if (!utterance) return;
    if (utterance.timer !== null) this._clearTimeout(utterance.timer);
    utterance.timer = null;
    if (utterance.recorder.state !== 'inactive') {
      try { utterance.recorder.stop(); } catch (error) { this._completeUtterance(utterance, error); }
    } else this._completeUtterance(utterance);
  };

  Live.prototype._completeUtterance = function (utterance, error) {
    if (this._utterance === utterance) this._utterance = null;
    if (utterance.timer !== null) this._clearTimeout(utterance.timer);
    if (error || utterance.generation !== this._generation) return;
    var type = utterance.recorder.mimeType || (utterance.chunks[0] && utterance.chunks[0].type) || 'audio/webm';
    var blob = new this._Blob(utterance.chunks, { type: type });
    if (!blob.size) return;
    if (blob.size > this._maxBytes) { this._setState('error', voiceError('audio_too_large', 'Audio exceeds maximum size')); return; }
    var payload = { blob: blob, duration: Math.max(0, this._now() - utterance.startedAt), id: this._nextTurnId(), generation: utterance.generation, speechEpoch: this._speechEpoch };
    this._enqueue(payload);
  };

  Live.prototype._nextTurnId = function () {
    this._turnSequence += 1;
    return 'voice-' + this._now().toString(36) + '-' + this._turnSequence.toString(36);
  };

  Live.prototype._enqueue = function (payload) {
    if (this._busy) {
      if (!this._pending) this._pending = payload;
      else this._setState('error', voiceError('voice_queue_full', 'Voice queue is full; capture is paused'));
      return;
    }
    this._processTurn(payload);
  };

  Live.prototype._processTurn = async function (payload) {
    var self = this;
    this._busy = true;
    var generation = payload.generation;
    try {
      if (generation === this._generation) this._setState('processing');
      var turnPayload = { blob: payload.blob, duration: payload.duration, id: payload.id };
      if (this._transcribe) {
        var transcription = await this._transcribe(turnPayload);
        turnPayload.transcript = typeof transcription === 'string' ? transcription : transcription && transcription.transcript;
      }
      var response = await this._onTurn(turnPayload);
      if (generation !== this._generation) return;
      var text = typeof response === 'string' ? response : response && response.text;
      // Speech captured while the request was in flight makes its reply stale.
      if (text && payload.speechEpoch === this._speechEpoch) {
        this._setState('speaking');
        var gate = { interrupted: false };
        var controller = this._AbortController ? new this._AbortController() : { signal: { aborted: false }, abort: function () { this.signal.aborted = true; } };
        this._playbackGate = gate;
        this._playbackController = controller;
        // Keep awaiting transport synthesis even after barge-in so onTurn and
        // TTS requests never overlap. The signal lets the parent suppress a
        // late audio response before it reaches playback.
        await Promise.resolve().then(function () { return self._speak(text, { signal: controller.signal, id: payload.id }); });
        if (this._playbackGate === gate) this._playbackGate = null;
        if (this._playbackController === controller) this._playbackController = null;
      }
    } catch (error) {
      if (generation === this._generation) this._setState('error', error);
    } finally {
      this._busy = false;
      if (this._pending && this._pending.generation === this._generation) {
          var next = this._pending;
          this._pending = null;
          this._processTurn(next);
      } else if (generation === this._generation && this.state !== 'error') this._setState('listening');
    }
  };

  Live.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    if (this._stream && typeof this._stream.getAudioTracks === 'function') {
      this._stream.getAudioTracks().forEach(function (track) { track.enabled = !muted; });
    }
    if (this.muted && this._utterance) this._stopUtterance();
  };

  Live.prototype._teardown = async function (notifyClose) {
    if (this._vadTimer !== null) this._clearInterval(this._vadTimer);
    if (this._callTimer !== null) this._clearTimeout(this._callTimer);
    if (this._permissionTimer !== null) this._clearTimeout(this._permissionTimer);
    this._vadTimer = this._callTimer = this._permissionTimer = null;
    if (this._rejectPermission) {
      var rejectPermission = this._rejectPermission;
      this._rejectPermission = null;
      rejectPermission(voiceError('cancelled', 'Live session ended'));
    }
    this._bargeIn();
    this._pending = null;
    if (this._utterance) {
      var utterance = this._utterance;
      this._utterance = null;
      if (utterance.timer !== null) this._clearTimeout(utterance.timer);
      if (utterance.recorder.state !== 'inactive') { try { utterance.recorder.stop(); } catch (_) {} }
    }
    if (this._source && typeof this._source.disconnect === 'function') { try { this._source.disconnect(); } catch (_) {} }
    this._source = this._analyser = this._samples = null;
    if (this._context && typeof this._context.close === 'function') { try { await this._context.close(); } catch (_) {} }
    this._context = null;
    var activeStream = this._stream;
    this._stream = null;
    stopTracks(activeStream);
    if (notifyClose && this._connected) {
      this._connected = false;
      try { await this._close(); } catch (_) { /* terminal cleanup still succeeds */ }
    }
  };

  Live.prototype.end = async function () {
    if (this.state === 'ended' && !this._rejectPermission) return;
    this._generation += 1;
    await this._teardown(true);
    this._setState('ended');
  };

  Live.prototype.disconnect = function () { return this.end(); };

  Live.prototype.reconnect = async function () {
    this._generation += 1;
    this._setState('reconnecting');
    await this._teardown(true);
    this._setState('ended');
    var lastError;
    for (var attempt = 0; attempt < this._reconnectAttempts; attempt += 1) {
      try { return await this._startGeneration(true); }
      catch (error) {
        lastError = error;
        if (attempt + 1 >= this._reconnectAttempts) break;
        this._setState('reconnecting', error);
        if (this._reconnectDelayMs > 0) {
          await new Promise((function (self, delay) { return function (resolve) { self._setTimeout(resolve, delay); }; })(this, this._reconnectDelayMs * Math.pow(2, attempt)));
        }
        this._setState('ended');
      }
    }
    this._setState('error', lastError);
    throw lastError;
  };

  return { Recorder: Recorder, AudioStore: AudioStore, Live: Live };
});
