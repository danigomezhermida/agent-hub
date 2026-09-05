(() => {
  'use strict';
  const ORIGIN = 'https://future-rich-0308.agents.nousresearch.com';
  const CONNECT_URL = ORIGIN + '/dashboard-plugins/agent-hub/connect.html';
  const CHANNEL = 'agenthub.sso.v2';
  const AUTH_KEY = 'agenthub.hermes.authorized.v1';
  const REVOKE_KEY = 'agenthub.hermes.revoking.v1';
  let popup = null;
  let live = false;
  let revoking = localStorage.getItem(REVOKE_KEY) === '1';
  let authorized = !revoking && localStorage.getItem(AUTH_KEY) === '1';
  let channelId = crypto.randomUUID();
  let revokeWaiter = null;
  const pending = new Map();

  function changed() { window.dispatchEvent(new Event('hermes-connection')); }
  function post(message, target = popup) {
    if (target && !target.closed) target.postMessage({ channel: CHANNEL, channelId, ...message }, ORIGIN);
  }
  function rejectPending(message) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  }
  function detach(target = popup) {
    if (popup !== target) return;
    popup = null;
    live = false;
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
  function dispatchQueued() {
    if (!live) return;
    for (const [requestId, item] of pending) {
      if (item.sent) continue;
      item.sent = true;
      post({ ...item.data, type: 'chat', requestId });
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
    authorized = false;
    revoking = true;
    live = false;
    localStorage.removeItem(AUTH_KEY);
    localStorage.setItem(REVOKE_KEY, '1');
    rejectPending('Desconexión solicitada. Comprueba Hermes antes de reenviar.');
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
    if (data.type === 'attention') window.dispatchEvent(new Event('hermes-attention'));
    if (data.type === 'ready') {
      live = Boolean(data.connected);
      if (live && !revoking) {
        authorized = true;
        localStorage.setItem(AUTH_KEY, '1');
        dispatchQueued();
        if (pending.size === 0) {
          const closing = popup;
          post({ type: 'close' }, closing);
          detach(closing);
        }
      }
      changed();
    }
    if (data.type === 'revoked') {
      const closing = popup;
      authorized = false;
      revoking = false;
      live = false;
      localStorage.removeItem(AUTH_KEY);
      localStorage.removeItem(REVOKE_KEY);
      rejectPending('Conexión revocada.');
      finishRevocation(true);
      detach(closing);
    }
    if (data.type === 'result' && pending.has(data.requestId)) {
      const closing = popup;
      const item = pending.get(data.requestId);
      pending.delete(data.requestId);
      clearTimeout(item.timer);
      if (data.ok && typeof data.result?.text === 'string') item.resolve(data.result);
      else item.reject(new Error(data.error || 'Hermes no devolvió una respuesta.'));
      detach(closing);
    }
  });

  setInterval(() => {
    if (popup && !popup.closed) post({ type: 'hello' });
    if (popup && popup.closed) {
      const closed = popup;
      const sent = [...pending.values()].some(item => item.sent);
      if (pending.size) rejectPending(sent
        ? 'La ventana se cerró durante el turno. Comprueba Hermes antes de reenviar.'
        : 'La ventana se cerró antes de enviar el mensaje. Puedes intentarlo de nuevo.');
      if (revokeWaiter?.target === closed) finishRevocation(false, 'Desconexión pendiente: la ventana se cerró sin confirmación.');
      detach(closed);
    }
  }, 400);

  window.hermesCloud = {
    isConnected: () => authorized && !revoking,
    isLive: () => live,
    isRevoking: () => revoking,
    open() {
      if (revoking) {
        const win = openPopup('?mode=revoke&revoke=1');
        win.focus();
        post({ type: 'hello' }, win);
        return;
      }
      const win = openPopup('?mode=authorize');
      win.focus();
      post({ type: 'hello' }, win);
    },
    disconnect: beginRevocation,
    chat(data) {
      if (revoking) return Promise.reject(new Error('Completa la desconexión pendiente antes de continuar.'));
      if (!authorized) return Promise.reject(new Error('Conecta Hermes antes de enviar.'));
      if (pending.size) return Promise.reject(new Error('Espera a que termine el mensaje anterior.'));
      try { openPopup('?mode=turn'); } catch (error) { return Promise.reject(error); }
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('Tiempo de espera agotado. Comprueba Hermes antes de reenviar.'));
        }, 620000);
        pending.set(requestId, { resolve, reject, timer, data, sent: false });
        post({ type: 'hello' });
        dispatchQueued();
      });
    }
  };
})();