(() => {
  'use strict';
  const ORIGIN = 'https://future-rich-0308.agents.nousresearch.com';
  const CONNECT_URL = ORIGIN + '/dashboard-plugins/agent-hub/connect.html';
  const CHANNEL = 'agenthub.sso.v2';
  const AUTH_KEY = 'agenthub.hermes.authorized.v1';
  let popup = null;
  let live = false;
  let authorized = localStorage.getItem(AUTH_KEY) === '1';
  let channelId = crypto.randomUUID();
  const pending = new Map();

  function changed() { window.dispatchEvent(new Event('hermes-connection')); }
  function post(message) {
    if (popup && !popup.closed) popup.postMessage({ channel: CHANNEL, channelId, ...message }, ORIGIN);
  }
  function rejectPending(message) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    pending.clear();
  }
  function openPopup(path = '') {
    if (popup && !popup.closed) return popup;
    live = false;
    channelId = crypto.randomUUID();
    popup = window.open(CONNECT_URL + path, 'agenthub-hermes', 'popup,width=640,height=760');
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

  window.addEventListener('message', event => {
    if (event.origin !== ORIGIN || !popup || event.source !== popup) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.channelId !== channelId) return;
    if (data.type === 'attention') window.dispatchEvent(new Event('hermes-attention'));
    if (data.type === 'ready') {
      live = Boolean(data.connected);
      if (live) {
        authorized = true;
        localStorage.setItem(AUTH_KEY, '1');
        dispatchQueued();
        if (pending.size === 0) post({ type: 'close' });
      }
      changed();
    }
    if (data.type === 'revoked') {
      authorized = false;
      live = false;
      localStorage.removeItem(AUTH_KEY);
      rejectPending('Conexión revocada.');
      changed();
    }
    if (data.type === 'result' && pending.has(data.requestId)) {
      const item = pending.get(data.requestId);
      pending.delete(data.requestId);
      clearTimeout(item.timer);
      if (data.ok && typeof data.result?.text === 'string') item.resolve(data.result);
      else item.reject(new Error(data.error || 'Hermes no devolvió una respuesta.'));
    }
  });

  setInterval(() => {
    if (popup && !popup.closed) post({ type: 'hello' });
    if (popup && popup.closed) {
      popup = null;
      live = false;
      const sent = [...pending.values()].some(item => item.sent);
      if (sent) rejectPending('La ventana se cerró durante el turno. Comprueba Hermes antes de reenviar.');
      changed();
    }
  }, 800);

  window.hermesCloud = {
    isConnected: () => authorized,
    isLive: () => live,
    open() {
      try {
        const win = openPopup('?mode=authorize');
        win.focus();
      } catch (error) {
        throw error;
      }
    },
    disconnect() {
      const activePopup = popup && !popup.closed ? popup : null;
      authorized = false;
      live = false;
      localStorage.removeItem(AUTH_KEY);
      rejectPending('Conexión cerrada.');
      try {
        if (activePopup) activePopup.postMessage({ channel: CHANNEL, channelId, type: 'disconnect' }, ORIGIN);
        else openPopup('?revoke=1');
      } catch { /* local grant is still removed */ }
      changed();
    },
    chat(data) {
      if (!authorized) return Promise.reject(new Error('Conecta Hermes antes de enviar.'));
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
