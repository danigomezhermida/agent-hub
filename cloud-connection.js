(() => {
  'use strict';
  const ORIGIN = 'https://future-rich-0308.agents.nousresearch.com';
  const CONNECT_URL = ORIGIN + '/dashboard-plugins/agent-hub/connect.html';
  const CHANNEL = 'agenthub.sso.v2';
  const AUTH_KEY = 'agenthub.hermes.authorized.v1';
  const REVOKE_KEY = 'agenthub.hermes.revoking.v1';
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
  const MAX_TTS_TEXT = 8000;
  let popup = null;
  let verifiedScope = null;
  let live = false;
  let voiceLease = false;
  let readyTimer = null;
  let voiceWaiter = null;
  let revoking = localStorage.getItem(REVOKE_KEY) === '1';
  let authorized = !revoking && localStorage.getItem(AUTH_KEY) === '1';
  let channelId = crypto.randomUUID();
  let revokeWaiter = null;
  const pending = new Map();

  function changed() { window.dispatchEvent(new Event('hermes-connection')); }
  function post(message, target = popup) {
    if (target && !target.closed) target.postMessage({ channel: CHANNEL, channelId, ...message }, ORIGIN);
  }
  function clearReadyTimer() {
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
  }
  function finishVoiceOpen(ok, message) {
    if (!voiceWaiter) return;
    clearTimeout(voiceWaiter.timer);
    const waiter = voiceWaiter;
    voiceWaiter = null;
    if (ok) waiter.resolve(); else waiter.reject(new Error(message));
  }
  function pendingFailure(item, fallback) {
    if (item?.kind === 'chat' && item.sent) return 'El turno puede haberse enviado. Comprueba Hermes antes de reenviar.';
    return fallback;
  }
  function rejectPending(message) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(typeof message === 'function' ? message(item) : message));
    }
    pending.clear();
  }
  function detach(target = popup) {
    if (popup !== target) return;
    clearReadyTimer();
    popup = null;
    live = false;
    voiceLease = false;
    changed();
  }
  function openPopup(path = '') {
    if (popup && !popup.closed) return popup;
    live = false;
    channelId = crypto.randomUUID();
    const name = 'agenthub-hermes-' + channelId;
    popup = window.open(CONNECT_URL + path, name, 'popup,width=640,height=760');
    if (!popup) throw new Error('Permite la ventana emergente para conectar Hermes.');
    changed();
    return popup;
  }
  function requireReadyWithin(message) {
    if (live || readyTimer) return;
    readyTimer = setTimeout(() => {
      readyTimer = null;
      if (live) return;
      const closing = popup;
      rejectPending(item => pendingFailure(item, message));
      finishVoiceOpen(false, message);
      post({ type: 'close' }, closing);
      detach(closing);
    }, 15000);
  }
  function dispatchQueued() {
    if (!live) return;
    for (const [requestId, item] of pending) {
      if (item.sent) continue;
      item.sent = true;
      post({ ...item.data, type: item.kind, requestId });
    }
  }
  function finishRevocation(ok, message) {
    if (revokeWaiter) {
      clearTimeout(revokeWaiter.timer);
      const waiter = revokeWaiter;
      revokeWaiter = null;
      if (ok) waiter.resolve(); else waiter.reject(new Error(message));
    }
  }
  function beginRevocation() {
    verifiedScope = null;
    authorized = false;
    revoking = true;
    live = false;
    voiceLease = false;
    clearReadyTimer();
    finishVoiceOpen(false, 'Desconexión solicitada.');
    localStorage.removeItem(AUTH_KEY);
    localStorage.setItem(REVOKE_KEY, '1');
    rejectPending(item => pendingFailure(item, 'Desconexión solicitada.'));
    const activePopup = popup && !popup.closed ? popup : null;
    let target;
    try {
      target = activePopup || openPopup('?mode=revoke&revoke=1');
      if (activePopup) post({ type: 'disconnect' }, activePopup);
    } catch (error) {
      changed();
      return Promise.reject(new Error('Desconexión pendiente: permite la ventana de Hermes para confirmar la revocación.'));
    }
    changed();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        revokeWaiter = null;
        reject(new Error('Desconexión pendiente: Hermes no confirmó la revocación.'));
      }, 15000);
      revokeWaiter = { resolve, reject, timer, target };
      post({ type: 'hello' }, target);
    });
  }

  window.addEventListener('message', event => {
    if (event.origin !== ORIGIN || !popup || event.source !== popup) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.channelId !== channelId) return;
    if (data.type === 'identity-denied') {
      const lostVoice = voiceLease;
      verifiedScope = null; authorized = false; localStorage.removeItem(AUTH_KEY);
      rejectPending('Esta cuenta no tiene acceso a Agent Hub.');
      finishVoiceOpen(false, 'Esta cuenta no tiene acceso a Agent Hub.');
      const closing = popup; post({type:'close'}, closing); detach(closing);
      if (lostVoice) window.dispatchEvent(new Event('hermes-voice-closed'));
      window.dispatchEvent(new Event('hermes-identity-denied')); return;
    }
    if (data.type === 'attention') window.dispatchEvent(new Event('hermes-attention'));
    if (data.type === 'voice-closed' && voiceLease) {
      const closing = popup;
      rejectPending(item => pendingFailure(item, 'La conexión de voz se cerró inesperadamente.'));
      finishVoiceOpen(false, 'La conexión de voz se cerró antes de estar lista.');
      detach(closing);
      window.dispatchEvent(new Event('hermes-voice-closed'));
      return;
    }
    if (data.type === 'ready') {
      live = Boolean(data.connected);
      if (live && !revoking) {
        if (data.ownerScope === 'personal') verifiedScope = data.ownerScope;
        clearReadyTimer();
        authorized = true;
        localStorage.setItem(AUTH_KEY, '1');
        finishVoiceOpen(true);
        dispatchQueued();
        if (!voiceLease && pending.size === 0) {
          const closing = popup;
          post({ type: 'close' }, closing);
          detach(closing);
        }
      }
      changed();
    }
    if (data.type === 'revoked') {
      verifiedScope = null;
      const closing = popup;
      authorized = false;
      revoking = false;
      live = false;
      voiceLease = false;
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(REVOKE_KEY);
      rejectPending(item => pendingFailure(item, 'Conexión revocada.'));
      finishVoiceOpen(false, 'Conexión revocada.');
      finishRevocation(true);
      detach(closing);
    }
    if (data.type === 'result' && pending.has(data.requestId)) {
      const item = pending.get(data.requestId);
      pending.delete(data.requestId);
      clearTimeout(item.timer);
      if (!data.ok) {
        const error = new Error(data.error || 'Hermes no devolvió una respuesta.'); error.code = data.code; item.reject(error);
      } else if (item.kind === 'recover' && data.result?.chatId === item.chatId && ['completed','rejected','uncertain'].includes(data.result.state)) {
        item.resolve(data.result);
      } else if (item.kind === 'storage') {
        item.resolve(data.result);
      } else if (item.kind === 'chat' && typeof data.result?.text === 'string') {
        item.resolve(data.result);
      } else if (item.kind === 'transcribe' && typeof data.result?.text === 'string') {
        if (data.result.chatId !== item.chatId) item.reject(new Error('Hermes devolvió una identidad de chat incorrecta.'));
        else item.resolve(data.result);
      } else if (item.kind === 'synthesize' && data.result?.blob instanceof Blob) {
        if (data.result.chatId !== item.chatId) item.reject(new Error('Hermes devolvió una identidad de chat incorrecta.'));
        else item.resolve(data.result);
      } else {
        item.reject(new Error('Hermes devolvió una respuesta de voz no válida.'));
      }
      if (!voiceLease) detach(popup);
    }
  });

  setInterval(() => {
    if (popup && !popup.closed) post({ type: 'hello' });
    if (popup && popup.closed) {
      const closed = popup;
      const unexpectedVoiceClose = voiceLease;
      rejectPending(item => pendingFailure(item, 'La ventana se cerró antes de enviar la operación. Puedes intentarlo de nuevo.'));
      finishVoiceOpen(false, 'La ventana de voz se cerró antes de conectar.');
      if (revokeWaiter?.target === closed) finishRevocation(false, 'Desconexión pendiente: la ventana se cerró sin confirmación.');
      detach(closed);
      if (unexpectedVoiceClose) window.dispatchEvent(new Event('hermes-voice-closed'));
    }
  }, 400);

  function request(kind, data, timeout, signal) {
    if (signal?.aborted) return Promise.reject(new Error('Síntesis cancelada.'));
    if (revoking) return Promise.reject(new Error('Completa la desconexión pendiente antes de continuar.'));
    if (!authorized) return Promise.reject(new Error('Conecta Hermes antes de enviar.'));
    if (pending.size) return Promise.reject(new Error('Espera a que termine la operación anterior.'));
    if (kind !== 'chat' && (!voiceLease || !popup || popup.closed)) return Promise.reject(new Error('Abre primero la conexión de voz.'));
    if (kind === 'chat' && (!voiceLease || !popup || popup.closed)) {
      try { openPopup('?mode=turn'); } catch (error) { return Promise.reject(error); }
    }
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const item = pending.get(requestId);
        pending.delete(requestId);
        reject(new Error(pendingFailure(item, 'Tiempo de espera agotado. Puedes intentarlo de nuevo.')));
      }, timeout);
      pending.set(requestId, { resolve, reject, timer, data, kind, chatId: data.chatId, sent: false });
    });
    let abortTimer;
    const abort = () => {
      if (!pending.has(requestId)) return;
      post({type:'cancel-voice', requestId, chatId:data.chatId});
      // Wait for the matching result so no next turn races a still-active fetch.
      abortTimer = setTimeout(() => {
        if (pending.has(requestId)) {
          window.hermesCloud.closeVoice();
          window.dispatchEvent(new Event('hermes-voice-closed'));
        }
      }, 2000);
    };
    signal?.addEventListener('abort', abort, {once:true});
    post({ type: 'hello' });
    requireReadyWithin('Hermes no confirmó que la ventana estuviera lista a tiempo.');
    dispatchQueued();
    return promise.finally(() => { clearTimeout(abortTimer); signal?.removeEventListener('abort', abort); });
  }

  window.hermesCloud = {
    isConnected: () => authorized && !revoking,
    ownerScope: () => verifiedScope,
    storage(op, args = {}) {
      const allowedOps = ['identity','getState','putState','getAudio','putAudio','getBindings','putBinding'];
      if (!allowedOps.includes(op)) return Promise.reject(new Error('Operación no permitida.'));
      return request('storage', {op,args}, 35000);
    },
    isLive: () => live,
    isRevoking: () => revoking,
    open() {
      if (revoking) {
        const win = openPopup('?mode=revoke&revoke=1');
        win.focus(); post({ type: 'hello' }, win); return;
      }
      const win = openPopup('?mode=authorize');
      win.focus(); post({ type: 'hello' }, win);
    },
    openVoice() {
      if (revoking) return Promise.reject(new Error('Completa la desconexión pendiente antes de continuar.'));
      if (!authorized) return Promise.reject(new Error('Conecta Hermes antes de abrir la voz.'));
      if (voiceLease && popup && !popup.closed) {
        popup.focus(); post({ type: 'hello' });
        return live ? Promise.resolve() : (voiceWaiter?.promise || Promise.reject(new Error('La ventana de voz aún no está lista.')));
      }
      if (popup && !popup.closed) return Promise.reject(new Error('Termina la operación actual antes de abrir la voz.'));
      voiceLease = true;
      let win;
      try { win = openPopup('?mode=voice'); }
      catch (error) { voiceLease = false; return Promise.reject(error); }
      win.focus();
      let resolveOpen, rejectOpen;
      const promise = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
      const timer = setTimeout(() => {
        if (!voiceWaiter) return;
        voiceWaiter = null;
        post({ type: 'close' }, win);
        detach(win);
        rejectOpen(new Error('Hermes no confirmó la conexión de voz a tiempo.'));
      }, 15000);
      voiceWaiter = { resolve: resolveOpen, reject: rejectOpen, timer, promise };
      post({ type: 'hello' }, win);
      return promise;
    },
    closeVoice() {
      if (!voiceLease) return;
      const closing = popup;
      voiceLease = false;
      rejectPending(item => pendingFailure(item, 'Conexión de voz cerrada.'));
      finishVoiceOpen(false, 'Conexión de voz cerrada.');
      post({ type: 'close' }, closing);
      detach(closing);
    },
    disconnect: beginRevocation,
    chat(data) { return request('chat', data, 620000); },
    recover(data) { return request('recover', data, 120000); },
    transcribe(data) {
      const blob = data?.blob;
      const mime = String(blob?.type || '').split(';', 1)[0].toLowerCase();
      if (!(blob instanceof Blob) || blob.size < 1) return Promise.reject(new Error('El audio está vacío.'));
      if (blob.size > MAX_AUDIO_BYTES) return Promise.reject(new Error('El audio supera el límite de 25 MiB.'));
      if (!mime.startsWith('audio/') && mime !== 'video/webm') return Promise.reject(new Error('El archivo debe ser audio.'));
      return request('transcribe', { blob, chatId: data?.chatId }, 120000);
    },
    synthesize(data) {
      if (typeof data?.text !== 'string' || !data.text.trim() || data.text.length > MAX_TTS_TEXT) return Promise.reject(new Error('Texto de síntesis no válido.'));
      return request('synthesize', { text: data.text, chatId: data.chatId }, 120000, data.signal);
    }
  };
})();
