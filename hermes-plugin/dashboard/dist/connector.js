/* Authenticated, origin-limited browser connector. Never exports credentials. */
(() => {
  'use strict';
  document.getElementById('status').textContent = 'Conector cargado. Pulsa Conectar Agent Hub.';
  window.addEventListener('error', () => { document.getElementById('status').textContent = 'Error de JavaScript en el conector'; });
  const APP = 'https://agent-hub-theta-five.vercel.app';
  const PROFILE = 'limpatexdev-cloud';
  const CHANNEL = 'agenthub.sso.v1';
  const KEY = 'agenthub.connector.sessions.v1';
  const idOK = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x);
  let allowed = false, socket = null, connecting = null, sequence = 0, channelId = '';
  const opener = window.opener;
  const calls = new Map(), live = new Map(), turns = new Map(), seen = new Set();
  let sessions = {}, uncertain = {};
  try { uncertain = JSON.parse(localStorage.getItem(KEY + '.uncertain') || '{}'); } catch {}
  const mark = (id, value) => { if (value) uncertain[id] = true; else delete uncertain[id]; localStorage.setItem(KEY + '.uncertain', JSON.stringify(uncertain)); };
  try { sessions = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const status = text => { document.getElementById('status').textContent = text; };
  const post = data => { if (opener && channelId) opener.postMessage({ channel: CHANNEL, channelId, ...data }, APP); };
  const announce = () => post({ type: 'ready', connected: allowed && socket?.readyState === 1, profile: PROFILE });
  function stop() {
    allowed = false;
    for (const p of calls.values()) { clearTimeout(p.timer); p.reject(new Error('Conexión cerrada')); }
    calls.clear();
    for (const p of turns.values()) { clearTimeout(p.timer); p.reject(new Error('Conexión cerrada durante el turno. No reenvíes sin comprobar el chat en Hermes.')); }
    turns.clear(); live.clear();
    if (socket) socket.close(); socket = null;
    status('Desconectado.'); announce();
    document.getElementById('disconnect').hidden = true;
  }
  async function connect() {
    if (socket?.readyState === 1) return;
    if (connecting) return connecting;
    connecting = (async () => {
      const response = await fetch('/api/auth/ws-ticket', { method: 'POST', credentials: 'same-origin' });
      if (response.status === 401) {
        status('Inicia sesión en Hermes y vuelve a conectar.');
        const a = document.createElement('a'); a.textContent = 'Iniciar sesión en Hermes';
        a.href = '/login?next=' + encodeURIComponent(location.pathname); document.getElementById('status').append(' ', a);
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
        ws.onclose = () => { clearTimeout(timeout); if (socket === ws) stop(); };
        ws.onmessage = ({ data }) => {
          for (const line of String(data).split('\n').filter(Boolean)) {
            let frame; try { frame = JSON.parse(line); } catch { continue; }
            if (frame.id != null) {
              const call = calls.get(frame.id); if (!call) continue;
              calls.delete(frame.id); clearTimeout(call.timer);
              if (frame.error) call.reject(new Error('Hermes rechazó la operación: ' + (frame.error.message || 'error RPC')));
              else call.resolve(frame.result);
              continue;
            }
            const event = frame.params;
            if (!event || !event.type) continue;
            const turn = turns.get(event.session_id); if (!turn) continue;
            if (event.type === 'message.complete') {
              turns.delete(event.session_id); clearTimeout(turn.timer); mark(turn.chatId, false);
              if (event.payload?.status === 'error') turn.reject(new Error('El agente no pudo completar el turno.'));
              else turn.resolve(String(event.payload?.text || ''));
            } else if (['approval.request', 'secret.request', 'sudo.request', 'clarify.request'].includes(event.type)) {
              status('Hermes necesita una intervención. Abre este chat en el dashboard para responder; no se aprueba automáticamente.');
              post({ type: 'attention', message: 'Hermes necesita una confirmación en su dashboard.' });
            } else if (event.type === 'error') {
              turns.delete(event.session_id); clearTimeout(turn.timer); turn.reject(new Error('Error del agente. Consulta la sesión en Hermes.'));
            }
          }
        };
      });
    })();
    try { await connecting; } finally { connecting = null; }
  }
  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      if (socket?.readyState !== 1) return reject(new Error('Conecta Hermes primero.'));
      const id = 'ah' + (++sequence);
      const timer = setTimeout(() => { calls.delete(id); reject(new Error('Hermes tardó demasiado en aceptar la operación.')); }, 120000);
      calls.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  const busy = new Set();
  async function chat(data) {
    if (!allowed) throw new Error('Autoriza la conexión en la ventana Hermes.');
    if (!idOK(data.chatId) || typeof data.message !== 'string' || !data.message.trim() || data.message.length > 8000) throw new Error('Mensaje o identificador no válido.');
    if (uncertain[data.chatId]) throw new Error('Este chat tiene un turno sin confirmar. Revísalo en Hermes antes de continuar; puedes abrir un chat nuevo.');
    if (busy.has(data.chatId)) throw new Error('Espera a que termine el mensaje anterior.');
    const effort = ['low', 'medium', 'high'].includes(data.effort) ? data.effort : 'medium';
    if (data.model && !['default', 'gpt-5.6-luna', 'gpt-4.1-mini', 'claude-opus'].includes(data.model)) throw new Error('Modelo no permitido.');
    busy.add(data.chatId);
    try {
      await connect();
      let entry = live.get(data.chatId);
      if (!entry) {
        if (sessions[data.chatId]) {
          // Only resume sessions created here: never accept arbitrary IDs from the opener.
          entry = await rpc('session.resume', { session_id: sessions[data.chatId], profile: PROFILE, omit_messages: true });
        } else {
          entry = await rpc('session.create', { profile: PROFILE, title: 'Agent Hub · ' + data.chatId, source: 'web', reasoning_effort: effort, ...(data.model && data.model !== 'default' ? { model: data.model } : {}) });
        }
        entry.stored_session_id = entry.stored_session_id || entry.session_key || entry.resumed || sessions[data.chatId];
        if (!entry?.session_id || !entry?.stored_session_id) throw new Error('Hermes no devolvió una sesión válida.');
        live.set(data.chatId, entry); sessions[data.chatId] = entry.stored_session_id; localStorage.setItem(KEY, JSON.stringify(sessions));
      }
      const text = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { turns.delete(entry.session_id); reject(new Error('El turno sigue tardando. Comprueba la conversación en Hermes antes de reenviar.')); }, 600000);
        mark(data.chatId, true);
        turns.set(entry.session_id, { resolve, reject, timer, chatId: data.chatId });
        rpc('prompt.submit', { session_id: entry.session_id, text: data.message }).catch(error => { clearTimeout(timer); turns.delete(entry.session_id); reject(error); });
      });
      if (!text) throw new Error('Hermes terminó sin texto.');
      return { text, sessionId: entry.stored_session_id, profile: PROFILE };
    } finally { busy.delete(data.chatId); }
  }
  window.addEventListener('message', async event => {
    if (event.origin !== APP || !opener || event.source !== opener || !event.data || event.data.channel !== CHANNEL) return;
    const data = event.data;
    if (!idOK(data.channelId)) return;
    if (data.type === 'hello') {
      if (channelId && channelId !== data.channelId) { stop(); seen.clear(); status('Agent Hub se ha recargado. Pulsa Conectar para autorizar de nuevo.'); }
      channelId = data.channelId; announce(); return;
    }
    if (data.channelId !== channelId) return;
    if (data.type === 'disconnect') { stop(); return; }
    if (data.type !== 'chat' || !idOK(data.requestId)) return;
    if (seen.has(data.requestId)) return;
    if (seen.size >= 500 || busy.size >= 3) { post({type:'result',requestId:data.requestId,ok:false,error:'Límite de conexión. Reconecta cuando terminen los turnos.'}); return; }
    seen.add(data.requestId);
    try { const result = await chat(data); post({ type: 'result', requestId: data.requestId, ok: true, result }); }
    catch (error) { post({ type: 'result', requestId: data.requestId, ok: false, error: error.message }); }
  });
  document.getElementById('connect').onclick = async () => {
    try { status('Conectando con Hermes…'); await connect(); allowed = true; status('Conectado a Hermes. Puedes volver a Agent Hub; mantén esta ventana abierta.'); document.getElementById('disconnect').hidden = false; announce(); }
    catch (error) { if (!document.querySelector('#status a')) status(error.message); }
  };
  document.getElementById('disconnect').onclick = stop;
  document.getElementById('test').onclick = async () => {
    const button = document.getElementById('test'); button.disabled = true;
    try { document.getElementById('reply').textContent = 'Esperando respuesta real…'; const result = await chat({ chatId: 'connection-test-browser-v1', message: document.getElementById('prompt').value, effort: 'low', model: 'default' }); document.getElementById('reply').textContent = result.text + '\n\nSesión real: ' + result.sessionId; }
    catch (error) { document.getElementById('reply').textContent = error.message; }
    finally { button.disabled = false; }
  };
  setInterval(() => { if (socket?.readyState === 1) rpc('ping', {}).catch(() => {}); }, 25000);
})();
