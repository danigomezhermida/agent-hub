(() => {
  'use strict';
  const ORIGIN = 'https://future-rich-0308.agents.nousresearch.com';
  const CHANNEL = 'agenthub.sso.v1';
  let popup = null, ready = false, channelId = crypto.randomUUID();
  let lastSeen = 0;
  const pending = new Map();
  function changed() { window.dispatchEvent(new Event('hermes-connection')); }
  function post(message) { if (popup && !popup.closed) popup.postMessage({ channel: CHANNEL, channelId, ...message }, ORIGIN); }
  function disconnect() {
    post({ type: 'disconnect' }); ready = false;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Conexión cerrada. Comprueba el turno antes de reenviarlo.')); }
    pending.clear(); changed();
  }
  window.addEventListener('message', event => {
    if (event.origin !== ORIGIN || !popup || event.source !== popup) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.channelId !== channelId) return;
    if (data.type === 'attention') window.dispatchEvent(new Event('hermes-attention'));
    if (data.type === 'ready') { ready = Boolean(data.connected); lastSeen = Date.now(); changed(); }
    if (data.type === 'result' && pending.has(data.requestId)) {
      const p = pending.get(data.requestId); pending.delete(data.requestId); clearTimeout(p.timer);
      if (data.ok && typeof data.result?.text === 'string') p.resolve(data.result);
      else p.reject(new Error(data.error || 'Hermes no devolvió una respuesta.'));
    }
  });
  setInterval(() => {
    if (popup && !popup.closed) post({ type: 'hello' });
    if (ready && (!popup || popup.closed || Date.now() - lastSeen > 20000)) { ready = false; changed(); }
  }, 2000);
  window.hermesCloud = {
    isConnected: () => ready && popup && !popup.closed,
    open() {
      if (popup && !popup.closed) { popup.focus(); return; }
      ready = false; channelId = crypto.randomUUID();
      popup = window.open(ORIGIN + '/dashboard-plugins/agent-hub/connect.html', 'agenthub-hermes', 'popup,width=640,height=760');
      if (!popup) throw new Error('Permite la ventana emergente para conectar Hermes.');
      changed();
    },
    disconnect,
    chat(data) {
      if (!this.isConnected()) return Promise.reject(new Error('Conecta Hermes antes de enviar.'));
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Tiempo de espera agotado. Comprueba Hermes antes de reenviar.')); }, 620000);
        pending.set(requestId, { resolve, reject, timer });
        post({ ...data, type: 'chat', requestId });
      });
    }
  };
})();
