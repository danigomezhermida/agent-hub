/* Authenticated, origin-limited browser connector. Never exports credentials. */
(() => {
  'use strict';
  const APP = 'https://agent-hub-theta-five.vercel.app';
  const PROFILE = 'limpatexdev-cloud';
  const CHANNEL = 'agenthub.sso.v2';
  const SESSION_KEY = 'agenthub.connector.sessions.v1';
  const GRANT_KEY = 'agenthub.connector.granted.v1';
  const params = new URLSearchParams(location.search);
  const revokeMode = params.get('mode') === 'revoke' || params.get('revoke') === '1';
  const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  let allowed = localStorage.getItem(GRANT_KEY) === '1';
  let socket = null, connecting = null, sequence = 0, channelId = '';
  const parentWindow = window.opener;
  const calls = new Map(), live = new Map(), turns = new Map(), seen = new Set(), busy = new Set();
  let sessions = {}, uncertain = {};
  try { sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}'); } catch {}
  try { uncertain = JSON.parse(localStorage.getItem(SESSION_KEY + '.uncertain') || '{}'); } catch {}
  const status = text => { document.getElementById('status').textContent = text; };
  const mark = (id, value) => {
    if (value) uncertain[id] = true; else delete uncertain[id];
    localStorage.setItem(SESSION_KEY + '.uncertain', JSON.stringify(uncertain));
  };
  const post = data => {
    if (parentWindow && channelId) parentWindow.postMessage({ channel: CHANNEL, channelId, ...data }, APP);
  };
  const announce = () => post({ type: 'ready', connected: allowed && socket?.readyState === 1, profile: PROFILE });
  const closeSoon = () => {
    const mode = params.get('mode');
    const temporary = ['authorize', 'turn', 'revoke'].includes(mode) || revokeMode;
    if (!parentWindow || !temporary) return;
    setTimeout(() => { try { window.close(); } catch {} }, 350);
  };

  function failOutstanding(message) {
    for (const item of calls.values()) { clearTimeout(item.timer); item.reject(new Error(message)); }
    calls.clear();
    for (const item of turns.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
    }
    turns.clear();
    live.clear();
  }

  function stop({ revoke = false } = {}) {
    if (revoke) {
      allowed = false;
      localStorage.removeItem(GRANT_KEY);
    }
    failOutstanding('Conexión cerrada durante el turno. No reenvíes sin comprobar Hermes.');
    if (socket) {
      const current = socket;
      socket = null;
      try { current.close(); } catch {}
    }
    document.getElementById('disconnect').hidden = true;
  }

  async function connect() {
    if (socket?.readyState === 1) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const response = await fetch('/api/auth/ws-ticket', { method: 'POST', credentials: 'same-origin' });
      if (response.status === 401) {
        status('Inicia sesión en Hermes y vuelve a conectar.');
        const link = document.createElement('a');
        link.textContent = 'Iniciar sesión en Hermes';
        link.href = '/login?next=' + encodeURIComponent(location.pathname);
        document.getElementById('status').append(' ', link);
        throw new Error('Debes iniciar sesión en Hermes.');
      }
      if (!response.ok) throw new Error('No se pudo autorizar la conexión con Hermes.');
      const { ticket } = await response.json();
      if (!ticket) throw new Error('Hermes no emitió autorización WebSocket.');
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
        socket = ws;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Hermes no abrió la conexión.')); }, 15000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('Error de conexión WebSocket.')); };
        ws.onclose = () => {
          clearTimeout(timeout);
          reject(new Error('Hermes cerró la conexión WebSocket.'));
          if (socket === ws) {
            socket = null;
            failOutstanding('La conexión WebSocket se cerró durante la operación. Comprueba Hermes antes de reenviar.');
          }
        };
        ws.onmessage = ({ data }) => {
          for (const line of String(data).split('\n').filter(Boolean)) {
            let frame; try { frame = JSON.parse(line); } catch { continue; }
            if (frame.id != null) {
              const call = calls.get(frame.id);
              if (!call) continue;
              calls.delete(frame.id); clearTimeout(call.timer);
              if (frame.error) call.reject(new Error('Hermes rechazó la operación: ' + (frame.error.message || 'error RPC')));
              else call.resolve(frame.result);
              continue;
            }
            const event = frame.params;
            if (!event?.type) continue;
            const turn = turns.get(event.session_id);
            if (!turn) continue;
            if (event.type === 'message.complete') {
              turns.delete(event.session_id); clearTimeout(turn.timer); mark(turn.chatId, false);
              if (event.payload?.status === 'error') turn.reject(new Error('El agente no pudo completar el turno.'));
              else turn.resolve(String(event.payload?.text || ''));
            } else if (['approval.request', 'secret.request', 'sudo.request', 'clarify.request'].includes(event.type)) {
              status('Hermes necesita una intervención en su dashboard; no se aprueba automáticamente.');
              post({ type: 'attention' });
            } else if (event.type === 'error') {
              turns.delete(event.session_id); clearTimeout(turn.timer);
              turn.reject(new Error('Error del agente. Consulta la sesión en Hermes.'));
            }
          }
        };
      });
    })();
    try { await connecting; } finally { connecting = null; }
  }

  function rpc(method, rpcParams) {
    return new Promise((resolve, reject) => {
      if (socket?.readyState !== 1) return reject(new Error('Conecta Hermes primero.'));
      const id = 'ah' + (++sequence);
      const timer = setTimeout(() => { calls.delete(id); reject(new Error('Hermes tardó demasiado en aceptar la operación.')); }, 120000);
      calls.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: rpcParams }));
    });
  }

  async function chat(data) {
    if (!allowed) throw new Error('Autoriza esta conexión primero.');
    if (!idOK(data.chatId) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000) throw new Error('Mensaje o identificador no válido.');
    if (uncertain[data.chatId]) throw new Error('Este chat tiene un turno sin confirmar. Revísalo en Hermes antes de continuar; puedes abrir otro chat.');
    if (busy.has(data.chatId)) throw new Error('Espera a que termine el mensaje anterior.');
    const effort = ['low', 'medium', 'high'].includes(data.effort) ? data.effort : 'medium';
    if (data.model && !['default', 'gpt-5.6-luna', 'gpt-4.1-mini', 'claude-opus'].includes(data.model)) throw new Error('Modelo no permitido.');
    busy.add(data.chatId);
    try {
      await connect();
      let entry = live.get(data.chatId);
      if (!entry) {
        if (sessions[data.chatId]) {
          entry = await rpc('session.resume', { session_id: sessions[data.chatId], profile: PROFILE, omit_messages: true });
        } else {
          entry = await rpc('session.create', { profile: PROFILE, title: 'Agent Hub · ' + data.chatId, source: 'web', reasoning_effort: effort, ...(data.model && data.model !== 'default' ? { model: data.model } : {}) });
        }
        entry.stored_session_id = entry.stored_session_id || entry.session_key || entry.resumed || sessions[data.chatId];
        if (!entry?.session_id || !entry?.stored_session_id) throw new Error('Hermes no devolvió una sesión válida.');
        live.set(data.chatId, entry);
        sessions[data.chatId] = entry.stored_session_id;
        localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
      }
      const text = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          turns.delete(entry.session_id);
          reject(new Error('El turno sigue tardando. Comprueba la conversación en Hermes antes de reenviar.'));
        }, 600000);
        mark(data.chatId, true);
        turns.set(entry.session_id, { resolve, reject, timer, chatId: data.chatId });
        rpc('prompt.submit', { session_id: entry.session_id, text: data.message }).catch(error => {
          clearTimeout(timer); turns.delete(entry.session_id); reject(error);
        });
      });
      if (!text) throw new Error('Hermes terminó sin texto.');
      return { text, sessionId: entry.stored_session_id, profile: PROFILE };
    } finally { busy.delete(data.chatId); }
  }

  window.addEventListener('message', async event => {
    if (event.origin !== APP || !parentWindow || event.source !== parentWindow || !event.data || event.data.channel !== CHANNEL) return;
    const data = event.data;
    if (!idOK(data.channelId)) return;
    if (data.type === 'hello') {
      channelId = data.channelId;
      if (revokeMode) { post({ type: 'revoked' }); closeSoon(); }
      else announce();
      return;
    }
    if (data.channelId !== channelId) return;
    if (data.type === 'close') { closeSoon(); return; }
    if (data.type === 'disconnect') { stop({ revoke: true }); post({ type: 'revoked' }); closeSoon(); return; }
    if (data.type !== 'chat' || !idOK(data.requestId)) return;
    if (seen.has(data.requestId)) return;
    if (seen.size >= 500 || busy.size >= 1) {
      post({ type: 'result', requestId: data.requestId, ok: false, error: 'Hay otro turno en curso. Espera a que termine.' });
      return;
    }
    seen.add(data.requestId);
    try {
      const result = await chat(data);
      post({ type: 'result', requestId: data.requestId, ok: true, result });
    } catch (error) {
      post({ type: 'result', requestId: data.requestId, ok: false, error: error.message });
    } finally {
      closeSoon();
    }
  });

  document.getElementById('connect').onclick = async () => {
    try {
      status('Conectando con Hermes…');
      await connect();
      allowed = true;
      localStorage.setItem(GRANT_KEY, '1');
      status('Agent Hub autorizado. Esta ventana se cerrará; se abrirá temporalmente al enviar cada mensaje.');
      document.getElementById('disconnect').hidden = false;
      announce();
    } catch (error) {
      if (!document.querySelector('#status a')) status(error.message);
    }
  };
  document.getElementById('disconnect').onclick = () => { stop({ revoke: true }); post({ type: 'revoked' }); closeSoon(); };
  document.getElementById('test').onclick = async () => {
    const button = document.getElementById('test'); button.disabled = true;
    try {
      document.getElementById('reply').textContent = 'Esperando respuesta real…';
      const result = await chat({ chatId: 'connection-test-browser-v2', message: document.getElementById('prompt').value, effort: 'low', model: 'default' });
      document.getElementById('reply').textContent = result.text + '\n\nSesión real: ' + result.sessionId;
    } catch (error) {
      document.getElementById('reply').textContent = error.message;
    } finally { button.disabled = false; }
  };

  if (revokeMode) {
    stop({ revoke: true });
    status('Autorización eliminada. Confirmando la revocación con Agent Hub…');
  } else if (allowed && params.get('mode') === 'turn') {
    status('Autorización conservada. Conectando solo para este turno…');
    connect().then(() => { announce(); }).catch(error => status(error.message));
  } else if (allowed) {
    status('Existe una autorización anterior. Pulsa Conectar Agent Hub para confirmarla de nuevo.');
  }
})();
