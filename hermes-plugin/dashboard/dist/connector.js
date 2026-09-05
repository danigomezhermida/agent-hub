/* Authenticated, origin-limited browser connector. Never exports credentials. */
(() => {
  'use strict';
  const APP = 'https://agent-hub-theta-five.vercel.app';
  const PROFILE = 'limpatexdev-cloud';
  const CHANNEL = 'agenthub.sso.v2';
  const SESSION_KEY = 'agenthub.connector.sessions.v1';
  const GRANT_KEY = 'agenthub.connector.granted.v1';
  const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
  const MAX_TTS_AUDIO_BYTES = 16 * 1024 * 1024;
  const MAX_TTS_TEXT = 8000;
  const STORAGE_OPS = new Set(['identity','getState','putState','getAudio','putAudio','getBindings','putBinding','claimTurn','getTurn','finishTurn','getGroupCatalog','getGroups','putGroups','startGroupRun','getGroupRun','getGroupRuns']);
  const params = new URLSearchParams(location.search);
  const revokeMode = params.get('mode') === 'revoke' || params.get('revoke') === '1';
  const voiceMode = params.get('mode') === 'voice';
  const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
  let allowed = localStorage.getItem(GRANT_KEY) === '1';
  let ownerScope = null;
  let socket = null, connecting = null, sequence = 0, channelId = '', processing = false, deliberateSocketClose = false;
  const parentWindow = window.opener;
  const calls = new Map(), live = new Map(), turns = new Map(), seen = new Set(), busy = new Set(), fetchControllers = new Set();
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
  const announce = () => post({ type: 'ready', connected: allowed && Boolean(ownerScope) && socket?.readyState === 1, profile: PROFILE, ownerScope });
  const closeSoon = (force = false) => {
    const mode = params.get('mode');
    const temporary = ['authorize', 'turn', 'revoke'].includes(mode) || revokeMode;
    if (!parentWindow || (!temporary && !force)) return;
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
    for (const controller of fetchControllers) controller.abort();
    fetchControllers.clear();
    processing = false;
  }

  function stop({ revoke = false } = {}) {
    if (revoke) {
      ownerScope = null; allowed = false;
      localStorage.removeItem(GRANT_KEY);
    }
    failOutstanding('Conexión cerrada durante el turno. No reenvíes sin comprobar Hermes.');
    if (socket) {
      const current = socket;
      socket = null;
      deliberateSocketClose = true;
      try { current.close(); } catch {}
    }
    document.getElementById('disconnect').hidden = true;
  }

  async function storage(op, args = {}) {
    if (!STORAGE_OPS.has(op)) throw new Error('Operación de almacenamiento no permitida.');
    if (!allowed && op !== 'identity') throw new Error('Autoriza esta conexión primero.');
    const controller = new AbortController(); fetchControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try { return await window.AgentHubStorage.request(op, args, controller.signal); }
    catch (error) {
      if (error.code === 'identity') { ownerScope = null; post({type: 'identity-denied'}); }
      throw error;
    } finally { clearTimeout(timer); fetchControllers.delete(controller); }
  }
  async function verifyOwner() {
    const identity = await storage('identity');
    if (identity.scope !== 'personal') throw new Error('No se pudo verificar la identidad.');
    if (ownerScope && ownerScope !== identity.scope) throw new Error('La identidad cambió. Vuelve a conectar.');
    ownerScope = identity.scope;
    return ownerScope;
  }
  async function connect() {
    await verifyOwner();
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
        deliberateSocketClose = false;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('Hermes no abrió la conexión.')); }, 15000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error('Error de conexión WebSocket.')); };
        ws.onclose = () => {
          clearTimeout(timeout);
          reject(new Error('Hermes cerró la conexión WebSocket.'));
          const unexpectedVoiceClose = voiceMode && !deliberateSocketClose;
          if (socket === ws) {
            socket = null;
            failOutstanding('La conexión WebSocket se cerró durante la operación. Comprueba Hermes antes de reenviar.');
          }
          if (unexpectedVoiceClose) post({ type: 'voice-closed' });
        };
        ws.onmessage = ({ data }) => {
          for (const line of String(data).split('\n').filter(Boolean)) {
            let frame; try { frame = JSON.parse(line); } catch { continue; }
            if (frame.id != null) {
              const call = calls.get(frame.id);
              if (!call) continue;
              calls.delete(frame.id); clearTimeout(call.timer);
              if (frame.error) { const error = new Error('Hermes rechazó la operación.'); error.rpcEnvelope = frame; call.reject(error); }
              else call.resolve(frame.result);
              continue;
            }
            const event = frame.params;
            if (!event?.type) continue;
            const turn = turns.get(event.session_id);
            if (!turn) continue;
            if (event.type === 'message.complete') {
              turns.delete(event.session_id); clearTimeout(turn.timer);
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
    if (uncertain[data.chatId]) { const error = new Error('Este chat tiene un turno sin confirmar. Usa Consultar resultado antes de continuar.'); error.code = 'uncertain'; throw error; }
    if (busy.has(data.chatId)) throw new Error('Espera a que termine el mensaje anterior.');
    if (!idOK(data.clientMessageId) || !idOK(data.requestId)) throw new Error('El mensaje necesita un identificador persistente.');
    const effort = ['low', 'medium', 'high'].includes(data.effort) ? data.effort : 'medium';
    if (data.model && !['default', 'gpt-5.6-luna', 'gpt-4.1-mini', 'claude-opus'].includes(data.model)) throw new Error('Modelo no permitido.');
    busy.add(data.chatId);
    try {
      await connect();
      const bindings = await storage('getBindings');
      if (bindings.bindings?.[data.chatId]) sessions[data.chatId] = bindings.bindings[data.chatId];
      let entry = live.get(data.chatId);
      if (!entry) {
        if (sessions[data.chatId]) {
          entry = await rpc('session.resume', { session_id: sessions[data.chatId], profile: PROFILE, omit_messages: true });
        } else {
          entry = await rpc('session.create', { profile: PROFILE, title: 'Agent Hub · ' + data.chatId, source: 'web', reasoning_effort: effort, ...(data.model && data.model !== 'default' ? { model: data.model } : {}) });
        }
        entry.stored_session_id = entry.stored_session_id || entry.session_key || entry.resumed || sessions[data.chatId];
        if (!entry?.session_id || !entry?.stored_session_id) throw new Error('Hermes no devolvió una sesión válida.');
        if (!bindings.bindings?.[data.chatId]) await storage('putBinding', {chatId:data.chatId, sessionId:entry.stored_session_id, expectedSessionId:null});
        live.set(data.chatId, entry);
        sessions[data.chatId] = entry.stored_session_id;
        localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
      }
      const promptDigest = await window.AgentHubTurnRecovery.digestText(data.message);
      const claim = await storage('claimTurn', {...data, promptDigest});
      if (!claim.claimed) {
        if (claim.turn?.state === 'completed') return {text:claim.turn.text, sessionId:entry.stored_session_id, profile:PROFILE, recovered:true};
        const error = new Error(claim.turn?.state === 'rejected' ? 'Este intento fue rechazado antes de ejecutarse. Puedes escribir un mensaje nuevo.' : 'El turno sigue sin confirmar. Consulta el resultado, no lo reenvíes.');
        error.code = claim.turn?.state === 'rejected' ? 'rejected' : 'uncertain'; throw error;
      }
      mark(data.chatId, true);
      let text;
      try {
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            turns.delete(entry.session_id);
            reject(new Error('El turno sigue tardando. Consulta el resultado antes de continuar.'));
          }, 600000);
          turns.set(entry.session_id, { resolve, reject, timer, chatId: data.chatId });
        });
        const acceptance = rpc('prompt.submit', { session_id: entry.session_id, text: data.message }).then(result => {
          if (result?.status !== 'streaming') throw new Error('Hermes no confirmó el inicio de este turno.');
          return result;
        });
        [text] = await Promise.all([response, acceptance]);
      if (!text.trim()) throw new Error('Hermes terminó sin texto.');
      await storage('finishTurn', {...data, state:'completed', text});
      mark(data.chatId, false);
      return { text, sessionId: entry.stored_session_id, profile: PROFILE };
      } catch (error) {
        const pendingTurn = turns.get(entry.session_id);
        if (pendingTurn) { clearTimeout(pendingTurn.timer); turns.delete(entry.session_id); pendingTurn.reject(error); }
        if (error.rpcEnvelope && window.AgentHubTurnRecovery.isDefinitePromptRejection(error.rpcEnvelope)) {
          await storage('finishTurn', {...data,state:'rejected'});
          mark(data.chatId, false); error.code = 'rejected';
        } else { error.code = 'uncertain'; }
        throw error;
      }
    } finally { busy.delete(data.chatId); }
  }

  async function recover(data) {
    if (!allowed || !idOK(data.chatId) || (data.clientMessageId && !idOK(data.clientMessageId))) throw new Error('Conversación inválida.');
    await connect();
    const result = await storage('getTurn',data);
    if (result.turn?.state === 'completed' || result.turn?.state === 'rejected') {
      mark(data.chatId,false);
      return {chatId:data.chatId,state:result.turn.state,text:result.turn.text || '',clientMessageId:result.turn.clientMessageId};
    }
    const bindings = await storage('getBindings');
    if (!bindings.bindings?.[data.chatId]) return {chatId:data.chatId,clientMessageId:data.clientMessageId,state:'uncertain',history:[],running:null};
    const entry = await rpc('session.resume',{session_id:bindings.bindings[data.chatId],profile:PROFILE,omit_messages:true});
    const state = await rpc('session.status',{session_id:entry.session_id});
    const history = await rpc('session.history',{session_id:entry.session_id});
    return {chatId:data.chatId,clientMessageId:data.clientMessageId,state:'uncertain',status:typeof state.text === 'string' ? state.text : '',history:(history.messages || []).filter(row=>['user','assistant'].includes(row.role)).slice(-12).map(row=>({role:row.role,text:String(row.text ?? row.content ?? '').slice(0,16000)}))};
  }

  function validChatId(chatId) {
    if (!idOK(chatId)) throw new Error('Identificador de chat no válido.');
  }

  function readBlobAsDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('No se pudo leer el audio.'));
      reader.onerror = () => reject(new Error('No se pudo leer el audio.'));
      reader.readAsDataURL(blob);
    });
  }

  let activeVoiceRequest = null;
  async function voiceFetch(path, body) {
    const controller = new AbortController();
    fetchControllers.add(controller);
    try {
      const response = await fetch(path + '?profile=' + encodeURIComponent(PROFILE), {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal
      });
      return { response, release: () => fetchControllers.delete(controller) };
    } catch (error) {
      fetchControllers.delete(controller);
      throw error;
    }
  }

  async function httpError(_response, fallback) {
    // Backend/provider details can include paths or configuration: never export them.
    return new Error(fallback);
  }

  async function transcribe(data) {
    if (!allowed) throw new Error('Autoriza esta conexión primero.');
    validChatId(data.chatId);
    const blob = data.blob;
    const mimeType = String(blob?.type || '').split(';', 1)[0].toLowerCase();
    if (!(blob instanceof Blob) || blob.size < 1) throw new Error('El audio está vacío.');
    if (blob.size > MAX_AUDIO_BYTES) throw new Error('El audio supera el límite de 25 MiB.');
    if (!mimeType.startsWith('audio/') && mimeType !== 'video/webm') throw new Error('El archivo debe ser audio.');
    const dataUrl = await readBlobAsDataURL(blob);
    const operation = await voiceFetch('/api/audio/transcribe', { data_url: dataUrl, mime_type: mimeType });
    try {
      if (!operation.response.ok) throw await httpError(operation.response, 'Hermes no pudo transcribir el audio.');
      const result = await operation.response.json();
      if (!result?.ok || typeof result.transcript !== 'string') throw new Error('Hermes devolvió una transcripción no válida.');
      return { text: result.transcript.trim(), provider: result.provider || null, chatId: data.chatId };
    } finally { operation.release(); }
  }

  function audioBlobFromDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') throw new Error('Hermes no devolvió audio válido.');
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
    if (!match || !match[1].toLowerCase().startsWith('audio/')) throw new Error('Hermes no devolvió audio válido.');
    if (match[2].length > Math.ceil(MAX_TTS_AUDIO_BYTES / 3) * 4 + 4) throw new Error('El audio sintetizado supera el límite permitido.');
    let binary;
    try { binary = atob(match[2]); } catch { throw new Error('Hermes devolvió audio base64 no válido.'); }
    if (binary.length > MAX_TTS_AUDIO_BYTES) throw new Error('El audio sintetizado supera el límite permitido.');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: match[1].toLowerCase() });
  }

  async function synthesize(data) {
    if (!allowed) throw new Error('Autoriza esta conexión primero.');
    validChatId(data.chatId);
    if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > MAX_TTS_TEXT) throw new Error('Texto de síntesis no válido.');
    const operation = await voiceFetch('/api/audio/speak', { text: data.text });
    try {
      const response = operation.response;
      if (!response.ok) throw await httpError(response, 'Hermes no pudo sintetizar la respuesta.');
      const maxJsonBytes = Math.ceil(MAX_TTS_AUDIO_BYTES / 3) * 4 + 4096;
      const declared = Number(response.headers?.get?.('content-length') || 0);
      if (declared > maxJsonBytes) throw new Error('La respuesta de audio supera el límite permitido.');
      const raw = await response.text();
      if (raw.length > maxJsonBytes) throw new Error('La respuesta de audio supera el límite permitido.');
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('Hermes devolvió una respuesta de audio no válida.'); }
      if (!result?.ok) throw new Error('Hermes no pudo sintetizar la respuesta.');
      const blob = audioBlobFromDataUrl(result.data_url);
      return { blob, mimeType: blob.type, provider: result.provider || null, chatId: data.chatId };
    } finally { operation.release(); }
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
    if (data.type === 'cancel-voice') {
      if (allowed && activeVoiceRequest?.type === 'synthesize' &&
          data.requestId === activeVoiceRequest.requestId && data.chatId === activeVoiceRequest.chatId) {
        for (const controller of fetchControllers) controller.abort();
      }
      return;
    }
    if (data.type === 'close') {
      if (voiceMode) { stop(); closeSoon(true); }
      else closeSoon();
      return;
    }
    if (data.type === 'disconnect') { stop({ revoke: true }); post({ type: 'revoked' }); closeSoon(voiceMode); return; }
    if (!['chat', 'transcribe', 'synthesize', 'storage', 'recover'].includes(data.type) || !idOK(data.requestId)) return;
    if (seen.has(data.requestId)) return;
    if (seen.size >= 500 || processing || busy.size >= 1) {
      post({ type: 'result', requestId: data.requestId, ok: false, error: 'Hay otra operación en curso. Espera a que termine.' });
      return;
    }
    seen.add(data.requestId);
    processing = true;
    activeVoiceRequest = data;
    try {
      await verifyOwner();
      const result = data.type === 'recover' ? await recover(data) : data.type === 'chat' ? await chat(data) : data.type === 'transcribe' ? await transcribe(data) : data.type === 'storage' ? await storage(data.op, data.args) : await synthesize(data);
      post({ type: 'result', requestId: data.requestId, ok: true, result });
    } catch (error) {
      post({ type: 'result', requestId: data.requestId, ok: false, error: ['chat','storage','recover'].includes(data.type) ? error.message : 'No se pudo procesar el audio. Puedes reintentar.', code: error.code, httpStatus: Number.isInteger(error.httpStatus) ? error.httpStatus : undefined });
    } finally {
      processing = false; activeVoiceRequest = null;
      if (!voiceMode) closeSoon();
    }
  });

  document.getElementById('connect').onclick = async () => {
    try {
      status('Conectando con Hermes…');
      await connect();
      allowed = true;
      localStorage.setItem(GRANT_KEY, '1');
      status(voiceMode ? 'Voz autorizada. Mantén esta ventana abierta durante la llamada o el envío de la nota.' : 'Agent Hub autorizado. Esta ventana se cerrará; se abrirá temporalmente al enviar cada mensaje.');
      document.getElementById('disconnect').hidden = false;
      announce();
    } catch (error) {
      if (!document.querySelector('#status a')) status(error.message);
    }
  };
  document.getElementById('disconnect').onclick = () => { stop({ revoke: true }); post({ type: 'revoked' }); closeSoon(voiceMode); };
  document.getElementById('test').onclick = async () => {
    const button = document.getElementById('test'); button.disabled = true;
    try {
      document.getElementById('reply').textContent = 'Esperando respuesta real…';
      const result = await chat({ chatId: 'connection-test-personal-v1', clientMessageId: 'm_' + crypto.randomUUID(), requestId: 'r_' + crypto.randomUUID(), message: document.getElementById('prompt').value, effort: 'low', model: 'default' });
      document.getElementById('reply').textContent = result.text + '\n\nSesión real: ' + result.sessionId;
    } catch (error) {
      document.getElementById('reply').textContent = error.message;
    } finally { button.disabled = false; }
  };

  if (revokeMode) {
    stop({ revoke: true });
    status('Autorización eliminada. Confirmando la revocación con Agent Hub…');
  } else if (allowed && ['turn', 'voice'].includes(params.get('mode'))) {
    status(voiceMode ? 'Conexión de voz activa. Mantén esta ventana abierta…' : 'Autorización conservada. Conectando solo para este turno…');
    connect().then(() => { announce(); }).catch(error => status(error.message));
  } else if (allowed) {
    status('Existe una autorización anterior. Pulsa Conectar Agent Hub para confirmarla de nuevo.');
  }
})();
