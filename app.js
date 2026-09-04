const seedChats = [
  { title: 'Plan de Agent Hub', desc: 'Diseño de la nueva sala de agentes', time: 'Ahora', icon: '✦', tone: 'purple', agents: ['D', 'S', 'Q'], status: 'Activo' },
  { title: 'Revisión app de gestión', desc: 'Comprobando el flujo de asignaciones', time: 'Ayer', icon: '▦', tone: 'blue', agents: ['S', 'Q'], status: 'Listo' },
  { title: 'Operativa de septiembre', desc: 'Planificación y prioridades de hoy', time: 'Ayer', icon: '⌁', tone: 'green', agents: ['O', 'D'], status: 'Listo' },
  { title: 'Ideas para SATUA', desc: 'Servicios y experiencia hospitality', time: '2 sep', icon: '✣', tone: 'orange', agents: ['D'], status: 'Listo' }
];
const seedGroups = [
  { name: 'Dirección + Desarrollo', desc: '3 agentes · coordinación', agents: ['D', 'S', 'Q'] },
  { name: 'Limpatex Operaciones', desc: '2 agentes · operativo', agents: ['O', 'D'] },
  { name: 'Equipo de calidad', desc: '2 agentes · revisión', agents: ['Q', 'S'] }
];
const agents = ['Dani · Director', 'Senior Dev', 'QA Limpatex', 'Operaciones'];
const MODELS = ['gpt-5.6-luna', 'claude-opus', 'gpt-4.1-mini'];
const EFFORTS = ['low', 'medium', 'high'];
const storage = { chats: 'agenthub.chats.v1', groups: 'agenthub.groups.v1', messages: 'agenthub.messages.v2', model: 'agenthub.model.v1', effort: 'agenthub.effort.v1', sessions: 'agenthub.sessions.v1' };
const read = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) ?? fallback) : fallback; } catch { return fallback; } };
let chats = read(storage.chats, seedChats);
let groups = read(storage.groups, seedGroups);
let messages = read(storage.messages, {});
let sessions = read(storage.sessions, {});
let selectedModel = localStorage.getItem(storage.model) || 'gpt-5.6-luna';
let selectedEffort = localStorage.getItem(storage.effort) || 'medium';
if (!MODELS.includes(selectedModel)) selectedModel = 'gpt-5.6-luna';
if (!EFFORTS.includes(selectedEffort)) selectedEffort = 'medium';
let selectedIndex = 0;
let backendState = 'checking';
let mediaRecorder = null;
let recordingChunks = [];

const grid = document.querySelector('#chatGrid');
const strip = document.querySelector('#groupsStrip');
const toast = document.querySelector('#toast');
const overlay = document.querySelector('#chatOverlay');
const dialog = document.querySelector('#simpleDialog');
const messageList = document.querySelector('#messageList');
const backendStateEl = document.querySelector('#backendState');
const loginOverlay = document.querySelector('#loginOverlay');
const loginStatus = document.querySelector('#loginStatus');
const modelPicker = document.querySelector('#modelPicker');
const effortPicker = document.querySelector('#effortPicker');
const micBtn = document.querySelector('#micBtn');
const voiceBtn = document.querySelector('#voiceBtn');

function syncKeyboardViewport() {
  if (!window.visualViewport) return;
  const viewport = window.visualViewport;
  const keyboardOffset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
  document.documentElement.style.setProperty('--keyboard-offset', `${keyboardOffset}px`);
  document.documentElement.style.setProperty('--app-height', `${viewport.height}px`);
  document.documentElement.style.setProperty('--viewport-top', `${viewport.offsetTop}px`);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncKeyboardViewport);
  window.visualViewport.addEventListener('scroll', syncKeyboardViewport);
  syncKeyboardViewport();
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[match]));
const save = () => {
  localStorage.setItem(storage.chats, JSON.stringify(chats));
  localStorage.setItem(storage.groups, JSON.stringify(groups));
  localStorage.setItem(storage.messages, JSON.stringify(messages));
  localStorage.setItem(storage.sessions, JSON.stringify(sessions));
  localStorage.setItem(storage.model, selectedModel);
  localStorage.setItem(storage.effort, selectedEffort);
};
const chatKey = (chat) => chat.title;
const historyOf = (chat) => {
  const key = chatKey(chat);
  if (!messages[key]) messages[key] = [];
  return messages[key];
};
const sessionOf = (chat) => sessions[chatKey(chat)] || '';

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  return { status: response.status, data };
}

async function refreshSession() {
  try {
    const { status, data } = await api('/api/me');
    if (status === 200 && data && data.authenticated) {
      loginOverlay.classList.remove('open');
      loginOverlay.setAttribute('aria-hidden', 'true');
      setBackendState('ready');
      return true;
    }
    if (data && data.loginConfigured === false) {
      setBackendState('not_configured');
      showLogin('Backend sin configurar: faltan variables privadas en Vercel.');
      return false;
    }
    setBackendState('login');
    showLogin('');
    return false;
  } catch {
    setBackendState('offline');
    return false;
  }
}

function showLogin(message) {
  loginOverlay.classList.add('open');
  loginOverlay.setAttribute('aria-hidden', 'false');
  if (message) loginStatus.textContent = message;
}

function setBackendState(state) {
  backendState = state;
  if (!backendStateEl) return;
  backendStateEl.textContent = {
    checking: 'comprobando…', ready: 'Hermes listo', login: 'requiere login',
    not_configured: 'backend sin configurar', offline: 'sin conexión', busy: 'pensando…', recording: 'grabando…',
  }[state] || state;
}

function render(list = chats) {
  grid.innerHTML = list.map((chat) => {
    const index = chats.indexOf(chat);
    return `<article class="chat-card ${index === selectedIndex ? 'selected' : ''}" data-index="${index}"><div class="chat-card-top"><span class="chat-icon ${chat.tone}">${chat.icon}</span><span class="time">${escapeHtml(chat.time)}</span></div><h3>${escapeHtml(chat.title)}</h3><p>${escapeHtml(chat.desc)}</p><div class="card-footer"><div class="mini-avatars">${chat.agents.map((agent, i) => `<span class="${['purple', 'blue', 'orange', 'green'][i % 4]}">${escapeHtml(agent)}</span>`).join('')}</div><span class="status-label">${escapeHtml(chat.status)}</span></div></article>`;
  }).join('');
  grid.querySelectorAll('.chat-card').forEach((card) => card.addEventListener('click', () => selectChat(Number(card.dataset.index), true)));
  document.querySelector('#chatCount').textContent = chats.length;
}
function renderGroups() {
  strip.innerHTML = groups.map((group, index) => `<article class="group-card" data-group="${index}"><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.desc)}</p><div class="mini-avatars">${group.agents.map((agent, i) => `<span class="${['purple', 'blue', 'orange', 'green'][i % 4]}">${escapeHtml(agent)}</span>`).join('')}</div></article>`).join('');
  strip.querySelectorAll('.group-card').forEach((card) => card.addEventListener('click', () => {
    const group = groups[Number(card.dataset.group)];
    openDialog('GRUPO DE AGENTES', `Abrir ${group.name}`, group.agents.map((agent) => agents.find((name) => name.startsWith(agent)) || agent));
  }));
}
function renderMessages(chat) {
  const history = historyOf(chat);
  if (!history.length) {
    messageList.innerHTML = `<div class="message agent"><span class="message-avatar">D</span><div><small>Hermes</small><p>Inicia sesión para conversar con Hermes Cloud.</p></div></div>`;
    return;
  }
  messageList.innerHTML = history.map((message) => {
    if (message.role === 'agent' || message.role === 'assistant') {
      return `<div class="message agent"><span class="message-avatar">D</span><div><small>Hermes</small><p>${escapeHtml(message.text || '')}</p></div></div>`;
    }
    if (message.role === 'audio') {
      const src = message.audioUrl ? ` controls src="${message.audioUrl}"` : '';
      return `<div class="message user"><div><small>Tú · audio</small><p>${escapeHtml(message.text || 'Audio enviado')}</p>${message.audioUrl ? `<audio${src}></audio>` : ''}</div></div>`;
    }
    return `<div class="message user"><div><small>Tú</small><p>${escapeHtml(message.text || '')}</p></div></div>`;
  }).join('');
  messageList.scrollTop = messageList.scrollHeight;
}
function selectChat(index, open = false) {
  if (!chats[index]) return;
  selectedIndex = index;
  const chat = chats[index];
  document.querySelectorAll('.chat-card').forEach((card) => card.classList.toggle('selected', Number(card.dataset.index) === index));
  document.querySelector('#detailTitle').textContent = chat.title;
  document.querySelector('#detailMeta').textContent = `${chat.agents.join(' · ')} · conversación`;
  document.querySelector('#topTitle').textContent = chat.title;
  if (open) openChat(chat);
}
function openChat(chat) {
  document.querySelector('#chatWindowTitle').textContent = chat.title;
  renderMessages(chat);
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('chat-open');
  if (!window.matchMedia('(max-width: 760px)').matches) document.querySelector('#messageInput').focus();
}
function closeChat() {
  if (mediaRecorder && mediaRecorder.state === 'recording') { try { mediaRecorder.stop(); } catch {} }
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('chat-open');
}
function openDialog(kicker, title, choices, onChoice = null) {
  document.querySelector('#dialogKicker').textContent = kicker;
  document.querySelector('#dialogTitle').textContent = title;
  document.querySelector('#choiceList').innerHTML = choices.map((choice, index) => `<button data-choice="${index}"><span class="choice-avatar ${['purple', 'blue', 'orange', 'green'][index % 4]}">${escapeHtml(choice[0])}</span>${escapeHtml(choice)}<span>→</span></button>`).join('');
  dialog.classList.add('open');
  dialog.setAttribute('aria-hidden', 'false');
  document.querySelectorAll('#choiceList button').forEach((button) => button.addEventListener('click', () => {
    const choice = choices[Number(button.dataset.choice)];
    closeDialog();
    if (onChoice) onChoice(choice);
    else showToast(`Preparado: ${choice}`);
  }));
}
function closeDialog() { dialog.classList.remove('open'); dialog.setAttribute('aria-hidden', 'true'); }
function showToast(message) { toast.textContent = message; toast.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => toast.classList.remove('show'), 2400); }
function createChat(agentName) {
  const chat = { title: `Chat con ${agentName.split(' · ')[0]}`, desc: 'Conversación con Hermes Cloud', time: 'Ahora', icon: '✦', tone: 'purple', agents: [agentName[0]], status: 'Nuevo' };
  chats.unshift(chat);
  selectedIndex = 0;
  save(); render(); selectChat(0, true);
  showToast('Chat creado');
}

async function sendText(text) {
  const chat = chats[selectedIndex];
  if (!text || !chat) return;
  const history = historyOf(chat);
  history.push({ role: 'user', text });
  save(); renderMessages(chat);
  setBackendState('busy');
  messageList.insertAdjacentHTML('beforeend', `<div class="message agent" id="typingRow"><span class="message-avatar">D</span><div><small>Hermes</small><p><span class="typing">…</span></p></div></div>`);
  messageList.scrollTop = messageList.scrollHeight;
  try {
    const { status, data } = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message: text, sessionId: sessionOf(chat), model: selectedModel, effort: selectedEffort }),
    });
    document.querySelector('#typingRow')?.remove();
    if (status === 401) { history.push({ role: 'assistant', text: 'Necesitas iniciar sesión para continuar.' }); showLogin('Sesión caducada. Inicia sesión de nuevo.'); }
    else if (status === 503) history.push({ role: 'assistant', text: 'Backend sin configurar todavía en Vercel.' });
    else if (status !== 200) history.push({ role: 'assistant', text: 'Hermes no pudo responder ahora mismo.' });
    else {
      if (data && data.sessionId) sessions[chatKey(chat)] = data.sessionId;
      history.push({ role: 'assistant', text: (data && data.text) || 'Sin respuesta.' });
    }
  } catch {
    document.querySelector('#typingRow')?.remove();
    history.push({ role: 'assistant', text: 'Sin conexión con el backend.' });
  }
  save(); renderMessages(chat); setBackendState('ready');
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function toggleRecording() {
  const chat = chats[selectedIndex];
  if (!chat) return;
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    showToast('Este navegador no permite grabar audio');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
    mediaRecorder.onstop = async () => {
      micBtn.classList.remove('recording');
      setBackendState('ready');
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(recordingChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      if (blob.size < 1000) { showToast('Grabación demasiado corta'); return; }
      await sendAudio(blob, chat);
    };
    mediaRecorder.start();
    micBtn.classList.add('recording');
    setBackendState('recording');
    showToast('Grabando… pulsa de nuevo para enviar');
  } catch {
    showToast('Permiso de micrófono denegado');
  }
}

async function sendAudio(blob, chat) {
  const history = historyOf(chat);
  const localUrl = URL.createObjectURL(blob);
  history.push({ role: 'audio', text: 'Audio enviado · transcribiendo…', audioUrl: localUrl });
  save(); renderMessages(chat); setBackendState('busy');
  try {
    const audioBase64 = await blobToBase64(blob);
    const { status, data } = await api('/api/audio', {
      method: 'POST',
      body: JSON.stringify({ audioBase64, mimeType: blob.type, sessionId: sessionOf(chat), model: selectedModel, effort: selectedEffort }),
    });
    if (status === 401) history.push({ role: 'assistant', text: 'Necesitas iniciar sesión para enviar audio.' });
    else if (status === 501) history.push({ role: 'assistant', text: 'Audio recibido, pero la transcripción aún no está configurada.' });
    else if (status !== 200) history.push({ role: 'assistant', text: 'No se pudo procesar el audio.' });
    else {
      if (data && data.sessionId) sessions[chatKey(chat)] = data.sessionId;
      const audioMessage = [...history].reverse().find((item) => item.role === 'audio');
      if (audioMessage && data && data.transcript) audioMessage.text = `Audio: ${data.transcript}`;
      history.push({ role: 'assistant', text: (data && data.text) || 'Audio transcrito sin respuesta.' });
    }
  } catch {
    history.push({ role: 'assistant', text: 'Sin conexión para enviar el audio.' });
  }
  save(); renderMessages(chat); setBackendState('ready');
}

document.querySelector('#searchInput').addEventListener('input', (event) => { const query = event.target.value.toLowerCase(); render(chats.filter((chat) => `${chat.title} ${chat.desc}`.toLowerCase().includes(query))); });
const startNewChat = () => openDialog('NUEVO CHAT', '¿Con quién quieres hablar?', agents, createChat);
document.querySelector('#newChatBtn').addEventListener('click', startNewChat);
document.querySelector('#mobileNewChatBtn').addEventListener('click', startNewChat);
document.querySelector('#chatNewBtn').addEventListener('click', startNewChat);
document.querySelector('#newGroupBtn').addEventListener('click', () => openDialog('NUEVO GRUPO', 'Elige los agentes del grupo', agents, (agent) => { groups.unshift({ name: `Grupo con ${agent.split(' · ')[0]}`, desc: '1 agente · nuevo', agents: [agent[0]] }); save(); renderGroups(); showToast('Grupo creado y guardado en este dispositivo'); }));
document.querySelector('#groupsNav').addEventListener('click', () => { document.querySelector('.group-heading').scrollIntoView({ behavior: 'smooth' }); showToast('Mostrando grupos de agentes'); });
document.querySelector('#viewAll').addEventListener('click', () => showToast(`Tienes ${chats.length} conversaciones guardadas`));
document.querySelector('#focusSearch').addEventListener('click', () => document.querySelector('#searchInput').focus());
document.querySelector('#openChatBtn').addEventListener('click', () => openChat(chats[selectedIndex] || chats[0]));
document.querySelector('#closeChat').addEventListener('click', closeChat);
document.querySelector('#closeDialog').addEventListener('click', closeDialog);
overlay.addEventListener('click', (event) => { if (event.target === overlay) closeChat(); });
dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
document.querySelector('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector('#messageInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendText(text);
});
modelPicker.value = selectedModel;
effortPicker.value = selectedEffort;
modelPicker.addEventListener('change', () => { selectedModel = modelPicker.value; save(); showToast(`Modelo: ${selectedModel}`); });
effortPicker.addEventListener('change', () => { selectedEffort = effortPicker.value; save(); showToast(`Esfuerzo: ${selectedEffort}`); });
document.querySelector('#modelSelect').addEventListener('click', () => document.querySelector('#modelMenu').classList.toggle('open'));
document.querySelectorAll('#modelMenu button').forEach((button) => button.addEventListener('click', () => {
  const next = button.firstChild.textContent.trim();
  if (MODELS.includes(next)) { selectedModel = next; modelPicker.value = next; save(); }
  document.querySelector('#modelSelect').firstChild.textContent = `${selectedModel} `;
  document.querySelector('#modelMenu').classList.remove('open');
  showToast(`Modelo seleccionado: ${selectedModel}`);
}));
micBtn.addEventListener('click', toggleRecording);
voiceBtn.addEventListener('click', async () => {
  try {
    const { status } = await api('/api/voice');
    if (status === 401) { showLogin('Inicia sesión para usar la voz.'); return;
    }
    showToast('Voz en vivo: canal separado planificado, usa audio grabado por ahora');
  } catch { showToast('Sin conexión con el backend'); }
});
document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.querySelector('#loginPassword').value;
  loginStatus.textContent = 'Comprobando…';
  try {
    const { status } = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    if (status === 200) {
      document.querySelector('#loginPassword').value = '';
      loginStatus.textContent = '';
      await refreshSession();
      showToast('Sesión iniciada');
    } else if (status === 503) loginStatus.textContent = 'Backend sin configurar en Vercel.';
    else loginStatus.textContent = 'Contraseña incorrecta.';
  } catch { loginStatus.textContent = 'Sin conexión con el backend.'; }
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDialog(); document.querySelector('#closeChat').click(); } if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) document.querySelector('#newChatBtn').click(); });
document.querySelector('#modelSelect').firstChild.textContent = `${selectedModel} `;
render(); renderGroups(); selectChat(0);
refreshSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=20260904-8').catch(() => {}));
