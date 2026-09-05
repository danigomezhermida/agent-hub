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
const isMobile = () => window.matchMedia('(max-width: 760px)').matches();

let chats = read(storage.chats, seedChats);
let groups = read(storage.groups, seedGroups);
let messages = read(storage.messages, {});
let sessions = read(storage.sessions, {});
let selectedModel = localStorage.getItem('agenthub.model.sso.v1') || 'default';
let selectedEffort = localStorage.getItem(storage.effort) || 'medium';
if (!MODELS.includes(selectedModel)) selectedModel = 'gpt-5.6-luna';
if (!EFFORTS.includes(selectedEffort)) selectedEffort = 'medium';
let selectedIndex = 0;
let activeChat = null;
let mediaRecorder = null;
let recordingChunks = [];

const save = () => {
  localStorage.setItem(storage.chats, JSON.stringify(chats));
  localStorage.setItem(storage.groups, JSON.stringify(groups));
  localStorage.setItem(storage.messages, JSON.stringify(messages));
  localStorage.setItem(storage.sessions, JSON.stringify(sessions));
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
  $('#viewChat').hidden = true;
  const home = $('#viewHome'); home.hidden = false; home.style.display = '';
  document.body.classList.remove('chat-open');
  renderLists($('#searchInput').value); renderHome();
}
function openChat(chat) {
  activeChat = chat;
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
    box.innerHTML = `<div class="msg-agent"><span class="who">HERMES</span>Inicia sesión para conversar con Hermes Cloud.</div>`;
    return;
  }
  box.innerHTML = history.map((m) => {
    if (m.role === 'assistant' || m.role === 'agent') return `<div class="msg-agent"><span class="who">HERMES</span>${escapeHtml(m.text || '')}</div>`;
    if (m.role === 'audio') return `<div class="msg-user"><div>${escapeHtml(m.text || 'Audio enviado')}</div>${m.audioUrl ? `<div class="msg-audio"><audio controls src="${m.audioUrl}"></audio></div>` : ''}</div>`;
    return `<div class="msg-user">${escapeHtml(m.text || '')}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
async function sendText(text) {
  const chat = activeChat || chats[selectedIndex];
  if (!text || !chat) return;
  if (!window.hermesCloud.isConnected()) { showLogin('Conecta Hermes antes de enviar.'); return; }
  if (!activeChat) openChat(chat);
  const history = historyOf(chat);
  history.push({ role: 'user', text }); save(); renderMessages(chat);
  setConn(true, 'Pensando…');
  $('#messageList').insertAdjacentHTML('beforeend', `<div class="msg-agent" id="typingRow"><span class="who">HERMES</span><span class="typing-dots"><span>●</span> <span>●</span> <span>●</span></span></div>`);
  $('#messageList').scrollTop = $('#messageList').scrollHeight;
  try {
    const data = await window.hermesCloud.chat({ message: text, chatId: chatKey(chat), model: selectedModel, effort: selectedEffort }); const status = 200;
    document.querySelector('#typingRow')?.remove();
    if (status === 401) { history.push({ role: 'assistant', text: 'Necesitas iniciar sesión para continuar.' }); showLogin('Sesión caducada. Inicia sesión de nuevo.'); }
    else if (status === 503) history.push({ role: 'assistant', text: 'Backend sin configurar todavía en Vercel.' });
    else if (status !== 200) history.push({ role: 'assistant', text: 'Hermes no pudo responder ahora mismo.' });
    else { if (data && data.sessionId) sessions[chatKey(chat)] = data.sessionId; history.push({ role: 'assistant', text: (data && data.text) || 'Sin respuesta.' }); }
  } catch (error) { document.querySelector('#typingRow')?.remove(); history.push({ role: 'assistant', text: error.message || 'Sin conexión con Hermes.' }); }
  save(); renderMessages(chat); refreshSession();
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
function createChat(agentName) {
  const chat = { title: `Chat con ${agentName.split(' · ')[0]}`, desc: 'Conversación con Hermes Cloud', time: 'Ahora', agents: [agentName[0]], status: 'Nuevo' };
  chats.unshift(chat); selectedIndex = 0; save(); openChat(chat); showToast('Chat creado');
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

const submitHero = () => { const v = $('#heroInput').value.trim(); if (!v) return; $('#heroInput').value = ''; autoGrow($('#heroInput')); const chat = { title: v.slice(0, 42) || 'Nuevo chat', desc: 'Conversación con Hermes Cloud', time: 'Ahora', agents: ['D'], status: 'Nuevo' }; chats.unshift(chat); selectedIndex = 0; save(); openChat(chat); sendText(v); };
$('#heroSendBtn').addEventListener('click', submitHero);
$('#sendBtn').addEventListener('click', () => { const v = $('#messageInput').value.trim(); if (!v) return; $('#messageInput').value = ''; autoGrow($('#messageInput')); sendText(v); });
[$('#heroInput'), $('#messageInput')].forEach((t) => {
  t.addEventListener('input', () => autoGrow(t));
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile()) { e.preventDefault(); (t.id === 'heroInput' ? submitHero : $('#sendBtn')).click(); }
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
$('#logoutBtn').addEventListener('click', () => window.hermesCloud.disconnect());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDialog(); if (activeChat) closeChat(); document.body.classList.remove('side-open'); }
  if ((e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'k') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) startNewChat();
});

['#heroMicBtn','#micBtn','#heroVoiceBtn','#voiceBtn'].forEach(id => { $(id).disabled = true; $(id).title = 'Audio y voz pendientes de conexión'; });
syncPills(); renderLists(); renderHome(); showHome(); refreshSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=20260905-2').catch(() => {}));
