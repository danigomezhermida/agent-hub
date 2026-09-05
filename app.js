const seedChats = [
  { title: 'Plan de Agent Hub', desc: 'Diseño de la nueva sala de agentes', time: 'Ahora', agents: ['D', 'S', 'Q'], status: 'Activo' },
  { title: 'Revisión app de gestión', desc: 'Comprobando el flujo de asignaciones', time: 'Ayer', agents: ['S', 'Q'], status: 'Listo' },
  { title: 'Operativa de septiembre', desc: 'Planificación y prioridades de hoy', time: 'Ayer', agents: ['O', 'D'], status: 'Listo' },
  { title: 'Ideas para SATUA', desc: 'Servicios y experiencia hospitality', time: '2 sep', agents: ['D'], status: 'Listo' }
];
const seedGroups = [
  { name: 'Dirección + Desarrollo', desc: '3 agentes', agents: ['D', 'S', 'Q'] },
  { name: 'Limpatex Operaciones', desc: '2 agentes', agents: ['O', 'D'] },
  { name: 'Equipo de calidad', desc: '2 agentes', agents: ['Q', 'S'] }
];
const agents = ['Dani · Director', 'Senior Dev', 'QA Limpatex', 'Operaciones'];
const MODELS = ['default', 'gpt-5.6-luna', 'claude-opus', 'gpt-4.1-mini'];
const EFFORTS = ['low', 'medium', 'high'];
const MODEL_LABEL = { 'default': 'Modelo de Hermes', 'gpt-5.6-luna': 'gpt-5.6-luna', 'claude-opus': 'claude-opus', 'gpt-4.1-mini': 'gpt-4.1-mini' };
const storage = { chats: 'agenthub.chats.v1', groups: 'agenthub.groups.v1', messages: 'agenthub.messages.v2', model: 'agenthub.model.v1', effort: 'agenthub.effort.v1', sessions: 'agenthub.sessions.v1' };
const read = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) ?? fallback) : fallback; } catch { return fallback; } };
const $ = (id) => document.querySelector(id);
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

const snapshotKey = 'agenthub.conversations.v3';
const snapshot = read(snapshotKey, null);
let chats = snapshot?.chats || read(storage.chats, seedChats);
let groups = read(storage.groups, seedGroups);
let messages = snapshot?.messages || read(storage.messages, {});
let sessions = snapshot?.sessions || read(storage.sessions, {});
let sending = false;
const draftKey = 'agenthub.drafts.v1';
const drafts = read(draftKey, {});
let selectedModel = localStorage.getItem('agenthub.model.sso.v1') || 'default';
let selectedEffort = localStorage.getItem(storage.effort) || 'medium';
if (!MODELS.includes(selectedModel)) selectedModel = 'gpt-5.6-luna';
if (!EFFORTS.includes(selectedEffort)) selectedEffort = 'medium';
let selectedIndex = 0;
let activeChat = null;
let mediaRecorder = null;
let recordingChunks = [];

const save = () => {
  // Commit related records together: a failed write cannot leave an orphan.
  localStorage.setItem(snapshotKey, JSON.stringify({ chats, messages, sessions }));

  localStorage.setItem(storage.groups, JSON.stringify(groups));

  localStorage.setItem('agenthub.model.sso.v1', selectedModel);
  localStorage.setItem(storage.effort, selectedEffort);
};
chats.forEach(c => { if (!c.id) { c.id = crypto.randomUUID(); if (messages[c.title]) messages[c.id] = [...messages[c.title]]; } });
save();
const chatKey = (c) => { if (!c.id) c.id = crypto.randomUUID(); return c.id; };
const historyOf = (c) => { const k = chatKey(c); if (!messages[k]) messages[k] = []; return messages[k]; };
const sessionOf = (c) => sessions[chatKey(c)] || '';

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'include', headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}
function showToast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => t.classList.remove('show'), 2400); }

/* ---------- session / connection ---------- */
async function refreshSession() {
  if (window.hermesCloud.isRevoking()) {
    $('#loginOverlay').classList.remove('open'); setConn(false, 'Desconexión pendiente'); return false;
  }
  if (window.hermesCloud.isConnected()) {
    $('#loginOverlay').classList.remove('open'); setConn(true, window.hermesCloud.isLive() ? 'Hermes conectado' : 'Hermes autorizado'); return true;
  }
  setConn(false, 'Conectar Hermes'); showLogin('Usa tu sesión de Hermes. No necesitas API key ni contraseña de Vercel.'); return false;
}
window.addEventListener('hermes-connection', refreshSession);
window.addEventListener('hermes-attention', () => showToast('Hermes necesita tu intervención en su dashboard.'));
function setConn(ok, text) {
  const dot = $('#connDot'); if (dot) dot.className = 'conn-dot' + (ok ? ' ok' : text === 'Comprobando…' ? '' : ' bad');
  const el = $('#connText'); if (el) el.textContent = text;
  const bs = $('#backendState'); if (bs) bs.textContent = text.toLowerCase();
}
function showLogin(msg) {
  $('#loginOverlay').classList.add('open');
  if (msg) $('#loginStatus').textContent = msg;
}

/* ---------- lists ---------- */
function renderLists(filter = '') {
  const q = filter.toLowerCase();
  const list = $('#chatList');
  list.innerHTML = '';
  chats.forEach((chat, i) => {
    if (q && !`${chat.title} ${chat.desc}`.toLowerCase().includes(q)) return;
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = chat.title;
    b.title = chat.desc || '';
    if (chats[i] === activeChat) b.classList.add('active');
    b.addEventListener('click', () => openChat(chat));
    li.appendChild(b); list.appendChild(li);
  });
  const gl = $('#groupList');
  gl.innerHTML = '';
  groups.forEach((g) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = g.name;
    b.addEventListener('click', () => openGroup(g));
    li.appendChild(b); gl.appendChild(li);
  });
}
function renderHome() {
  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 13 ? 'Buenos días, Dani. ¿En qué trabajamos hoy?' : hour < 21 ? 'Buenas tardes, Dani. ¿En qué trabajamos hoy?' : 'Buenas noches, Dani. ¿En qué trabajamos hoy?';
  $('#chips').innerHTML = '';
  ['Plan de Agent Hub', 'Revisión app de gestión', 'Operativa de septiembre', 'Ideas para SATUA'].forEach((s) => {
    const b = document.createElement('button');
    b.textContent = s;
    b.addEventListener('click', () => { $('#heroInput').value = `Trabajemos en: ${s}`; $('#heroInput').focus(); });
    $('#chips').appendChild(b);
  });
  $('#fleet').innerHTML = `<span><b>${agents.length}</b> agentes</span><span><b>${groups.length}</b> grupos</span><span><b>${escapeHtml(selectedModel)}</b> · ${escapeHtml(selectedEffort)}</span>`;
}
function syncPills() {
  ['#modelPill', '#modelPillChat'].forEach((s) => { const el = $(s); if (el) el.innerHTML = `${escapeHtml(selectedModel)} <span aria-hidden="true">⌄</span>`; });
  ['#effortPill', '#effortPillChat'].forEach((s) => { const el = $(s); if (el) el.innerHTML = `${escapeHtml(selectedEffort)} <span aria-hidden="true">⌄</span>`; });
}

/* ---------- views ---------- */
function showHome() {
  activeChat = null;
  history.replaceState(null, '', location.pathname + location.search);
  $('#viewChat').hidden = true;
  const home = $('#viewHome'); home.hidden = false; home.style.display = '';
  document.body.classList.remove('chat-open');
  renderLists($('#searchInput').value); renderHome();
}
function openChat(chat) {
  activeChat = chat;
  history.replaceState(null, '', '#chat=' + chatKey(chat));
  selectedModel = chat.model || selectedModel;
  selectedEffort = chat.effort || selectedEffort;
  syncPills();
  selectedIndex = Math.max(0, chats.indexOf(chat));
  $('#viewHome').hidden = true;
  const thread = $('#viewChat'); thread.hidden = false;
  document.body.classList.add('chat-open');
  $('#chatWindowTitle').textContent = chat.title;
  renderMessages(chat); renderLists($('#searchInput').value);
  document.body.classList.remove('side-open');
  if (!isMobile()) $('#messageInput').focus();
}
function openGroup(g) {
  openDialog('GRUPO DE AGENTES', g.name, g.agents.map((a) => agents.find((n) => n.startsWith(a)) || a));
}
function closeChat() { showHome(); }

/* ---------- messages ---------- */
function renderMessages(chat) {
  const box = $('#messageList');
  const history = historyOf(chat);
  if (!history.length) {
    box.textContent = 'Escribe un mensaje para comenzar.';
    return;
  }
  box.innerHTML = history.map((m) => {
    if (m.role === 'assistant' || m.role === 'agent') return `<div class="msg-agent"><span class="who">HERMES</span>${escapeHtml(m.text || '')}</div>`;
    if (m.role === 'audio') return `<div class="msg-user"><div>${escapeHtml(m.text || 'Audio enviado')}</div>${m.audioUrl ? `<div class="msg-audio"><audio controls src="${m.audioUrl}"></audio></div>` : ''}</div>`;
    return `<div class="msg-user">${escapeHtml(m.text || '')}</div>`;
  }).join('');
  if (chat.error) { const notice = document.createElement('div'); notice.setAttribute('role', 'alert'); notice.textContent = chat.error; box.appendChild(notice); }
  box.scrollTop = box.scrollHeight;
}
function rememberDraft(input) {
  drafts[input.id] = input.value;
  try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { /* Keep visible draft. */ }
}
function sendError(message, input) {
  let box = document.getElementById('sendError');
  if (!box) { box = document.createElement('div'); box.id = 'sendError'; box.setAttribute('role', 'alert'); }
  box.textContent = message + ' ';
  const retry = document.createElement('button'); retry.textContent = 'Reintentar';
  retry.onclick = () => sendText(input.value.trim(), input);
  box.appendChild(retry); input.closest('.composer').after(box);
}
async function sendText(text, input = $('#messageInput')) {
  if (!text || sending) return;
  rememberDraft(input);
  if (!window.hermesCloud.isConnected()) {
    showLogin(window.hermesCloud.isRevoking() ? 'Completa la desconexión pendiente.' : 'Conecta tu sesión de Hermes para enviar. Tu borrador está guardado.');
    return;
  }
  sending = true;
  ['#heroSendBtn', '#sendBtn'].forEach(id => $(id).disabled = true);
  document.getElementById('sendError')?.remove();
  const isNew = input.id === 'heroInput' || !activeChat;
  const chat = isNew ? newConversation(text.slice(0, 42), agents[0]) : activeChat;
  const key = chatKey(chat);
  const previous = messages[key] || [];
  const entry = { role: 'user', text };
  const nextMessages = { ...messages, [key]: [...previous, entry] };
  const nextChats = chats.includes(chat) ? chats : [chat, ...chats];
  chat.model = selectedModel; chat.effort = selectedEffort;
  delete chat.error;
  try {
    // One atomic local commit, before opening the remote turn.
    localStorage.setItem(snapshotKey, JSON.stringify({chats: nextChats, messages: nextMessages, sessions}));
  } catch {
    sending = false;
    ['#heroSendBtn', '#sendBtn'].forEach(id => $(id).disabled = false);
    sendError('No se pudo guardar la conversación. El texto sigue aquí.', input);
    return;
  }
  chats = nextChats; messages = nextMessages;
  chat.model = selectedModel; chat.effort = selectedEffort;
  input.value = ''; rememberDraft(input); autoGrow(input);
  openChat(chat);
  setConn(true, 'Pensando…');
  $('#messageList').insertAdjacentHTML('beforeend', '<div class="msg-agent" id="typingRow" role="status">Hermes está respondiendo…</div>');
  try {
    // Keep popup creation synchronous with the original click/Enter.
    const data = await window.hermesCloud.chat({ message: text, chatId: key, model: chat.model, effort: chat.effort });
    if (data?.sessionId) sessions[key] = data.sessionId;
    messages[key].push({ role: 'assistant', text: data?.text || 'Sin respuesta.' });
  } catch (error) {
    // Never disguise transport/auth failures as agent replies or auto-retry an uncertain turn.
    chat.error = error.message || 'Sin conexión con Hermes.';
    showToast(chat.error);
  } finally {
    try { localStorage.setItem(snapshotKey, JSON.stringify({chats, messages, sessions})); }
    catch { showToast('No se pudo guardar la última respuesta. No recargues todavía.'); }
    sending = false;
    ['#heroSendBtn', '#sendBtn'].forEach(id => $(id).disabled = false);
    if (activeChat === chat) renderMessages(chat);
    renderLists($('#searchInput').value); refreshSession();
  }
}

/* ---------- audio ---------- */
const blobToBase64 = (blob) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(blob); });
async function toggleRecording(btn) {
  const chat = activeChat || chats[selectedIndex];
  if (!chat) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') { mediaRecorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) { showToast('Este navegador no permite grabar audio'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordingChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      document.querySelectorAll('.tool-btn.recording').forEach((b) => b.classList.remove('recording'));
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) { showToast('Grabación demasiado corta'); return; }
      await sendAudio(blob, chat);
    };
    mediaRecorder.start();
    if (btn) btn.classList.add('recording');
    showToast('Grabando… pulsa de nuevo para enviar');
  } catch { showToast('Permiso de micrófono denegado'); }
}
async function sendAudio(blob, chat) {
  if (!activeChat) openChat(chat);
  const history = historyOf(chat);
  const localUrl = URL.createObjectURL(blob);
  history.push({ role: 'audio', text: 'Audio enviado · transcribiendo…', audioUrl: localUrl });
  save(); renderMessages(chat);
  try {
    const audioBase64 = await blobToBase64(blob);
    const { status, data } = await api('/api/audio', { method: 'POST', body: JSON.stringify({ audioBase64, mimeType: blob.type, sessionId: sessionOf(chat), model: selectedModel, effort: selectedEffort }) });
    if (status === 401) history.push({ role: 'assistant', text: 'Necesitas iniciar sesión para enviar audio.' });
    else if (status === 501) history.push({ role: 'assistant', text: 'Audio recibido, pero la transcripción aún no está configurada.' });
    else if (status !== 200) history.push({ role: 'assistant', text: 'No se pudo procesar el audio.' });
    else {
      if (data && data.sessionId) sessions[chatKey(chat)] = data.sessionId;
      const audioMsg = [...history].reverse().find((i) => i.role === 'audio');
      if (audioMsg && data && data.transcript) audioMsg.text = `Audio: ${data.transcript}`;
      history.push({ role: 'assistant', text: (data && data.text) || 'Audio transcrito sin respuesta.' });
    }
  } catch { history.push({ role: 'assistant', text: 'Sin conexión para enviar el audio.' }); }
  save(); renderMessages(chat);
}
async function voiceInfo() {
  try {
    const { status } = await api('/api/voice');
    if (status === 401) { showLogin('Inicia sesión para usar la voz.'); return; }
    showToast('Voz en vivo: canal separado planificado, usa audio grabado por ahora');
  } catch { showToast('Sin conexión con el backend'); }
}

/* ---------- dialogs / menus ---------- */
function openDialog(kicker, title, choices, onChoice = null) {
  $('#dialogKicker').textContent = kicker;
  $('#dialogTitle').textContent = title;
  $('#choiceList').innerHTML = choices.map((c, i) => `<button data-choice="${i}"><span class="choice-avatar">${escapeHtml(c[0])}</span>${escapeHtml(c)}<span>→</span></button>`).join('');
  $('#simpleDialog').classList.add('open');
  document.querySelectorAll('#choiceList button').forEach((b) => b.addEventListener('click', () => {
    const choice = choices[Number(b.dataset.choice)];
    closeDialog();
    if (onChoice) onChoice(choice);
    else showToast(`Preparado: ${choice}`);
  }));
}
function closeDialog() { $('#simpleDialog').classList.remove('open'); }
function toggleMenu(menu, anchor) {
  const m = $(menu);
  const willOpen = m.hidden;
  $('#modelMenu').hidden = true; $('#effortMenu').hidden = true;
  if (!willOpen) return;
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.min(r.left, window.innerWidth - 230)}px`;
  m.style.top = `${r.bottom + 8}px`;
  if (r.bottom > window.innerHeight - 220) m.style.top = `${Math.max(8, r.top - m.offsetHeight - 8)}px`;
  m.hidden = false;
}
function newConversation(title, agentName) {
  return { id: crypto.randomUUID(), title, desc: 'Conversación con Hermes Cloud', time: 'Ahora', agent: agentName, agents: [agentName[0]], model: selectedModel, effort: selectedEffort, status: 'Nuevo' };
}
function createChat(agentName) {
  openChat(newConversation(`Chat con ${agentName.split(' · ')[0]}`, agentName));
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 200)}px`; }

/* ---------- wiring ---------- */
$('#searchInput').addEventListener('input', (e) => renderLists(e.target.value));
const startNewChat = () => openDialog('NUEVO CHAT', '¿Con quién quieres hablar?', agents, createChat);
$('#newChatBtn').addEventListener('click', startNewChat);
$('#mobileNewChatBtn').addEventListener('click', startNewChat);
$('#chatNewBtn').addEventListener('click', startNewChat);
$('#newGroupBtn').addEventListener('click', () => openDialog('NUEVO GRUPO', 'Elige los agentes del grupo', agents, (a) => { groups.unshift({ name: `Grupo con ${a.split(' · ')[0]}`, desc: '1 agente', agents: [a[0]] }); save(); renderLists($('#searchInput').value); renderHome(); showToast('Grupo creado'); }));
$('#backBtn').addEventListener('click', closeChat);
$('#openSidebar').addEventListener('click', () => document.body.classList.add('side-open'));
$('#collapseSidebar').addEventListener('click', () => document.body.classList.remove('side-open'));
$('#sidebarSearchBtn').addEventListener('click', () => { document.body.classList.remove('side-open'); $('#searchInput').focus(); });
$('#scrim').addEventListener('click', () => document.body.classList.remove('side-open'));
$('#closeDialog').addEventListener('click', closeDialog);
$('#simpleDialog').addEventListener('click', (e) => { if (e.target.id === 'simpleDialog') closeDialog(); });

const submitHero = () => sendText($('#heroInput').value.trim(), $('#heroInput'));
$('#heroSendBtn').addEventListener('click', submitHero);
$('#sendBtn').addEventListener('click', () => sendText($('#messageInput').value.trim(), $('#messageInput')));
[$('#heroInput'), $('#messageInput')].forEach((t) => {
  t.value = drafts[t.id] || '';
  t.addEventListener('input', () => { autoGrow(t); rememberDraft(t); });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
      e.preventDefault();
      if (t.id === 'heroInput') submitHero(); else $('#sendBtn').click();
    }
  });
});
$('#heroMicBtn').addEventListener('click', (e) => toggleRecording(e.currentTarget));
$('#micBtn').addEventListener('click', (e) => toggleRecording(e.currentTarget));
$('#heroVoiceBtn').addEventListener('click', voiceInfo);
$('#voiceBtn').addEventListener('click', voiceInfo);

const placeMenus = (anchor, menu) => toggleMenu(menu, anchor);
['#modelPill', '#modelPillChat'].forEach((s) => $(s).addEventListener('click', (e) => { e.stopPropagation(); placeMenus(e.currentTarget, '#modelMenu'); }));
['#effortPill', '#effortPillChat'].forEach((s) => $(s).addEventListener('click', (e) => { e.stopPropagation(); placeMenus(e.currentTarget, '#effortMenu'); }));
document.addEventListener('click', () => { $('#modelMenu').hidden = true; $('#effortMenu').hidden = true; });
document.querySelectorAll('#modelMenu button').forEach((b) => b.addEventListener('click', () => { selectedModel = b.dataset.model; save(); syncPills(); renderHome(); showToast(`Modelo: ${selectedModel}`); }));
document.querySelectorAll('#effortMenu button').forEach((b) => b.addEventListener('click', () => { selectedEffort = b.dataset.effort; save(); syncPills(); renderHome(); showToast(`Esfuerzo: ${selectedEffort}`); }));

$('#loginForm').addEventListener('submit', e => {
  e.preventDefault();
  try { window.hermesCloud.open(); $('#loginStatus').textContent = 'Pulsa Conectar en la ventana de Hermes y vuelve aquí.'; }
  catch (error) { $('#loginStatus').textContent = error.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await window.hermesCloud.disconnect(); showToast('Conexión con Hermes revocada.'); }
  catch (error) { showToast(error.message); }
  refreshSession();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDialog(); if (activeChat) closeChat(); document.body.classList.remove('side-open'); }
  if ((e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'k') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) startNewChat();
});

['#heroMicBtn','#micBtn','#heroVoiceBtn','#voiceBtn'].forEach(id => { $(id).disabled = true; $(id).title = 'Audio y voz pendientes de conexión'; });
const restoredChat = chats.find(c => '#chat=' + c.id === location.hash);
syncPills(); renderLists(); renderHome();
if (restoredChat) openChat(restoredChat); else showHome();
refreshSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=20260905-4').catch(() => {}));
