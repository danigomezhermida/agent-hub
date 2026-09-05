const seedChats = [
  { title: 'Plan de Agent Hub', desc: 'Diseño de la nueva sala de agentes', time: 'Ahora', agents: ['D', 'S', 'Q'], status: 'Activo' },
  { title: 'Revisión app de gestión', desc: 'Comprobando el flujo de asignaciones', time: 'Ayer', agents: ['S', 'Q'], status: 'Listo' },
  { title: 'Operativa de septiembre', desc: 'Planificación y prioridades de hoy', time: 'Ayer', agents: ['O', 'D'], status: 'Listo' },
  { title: 'Ideas para SATUA', desc: 'Servicios y experiencia hospitality', time: '2 sep', agents: ['D'], status: 'Listo' }
];
const agents = ['Hermes · Director'];
const MODELS = ['default', 'gpt-5.6-luna', 'claude-opus', 'gpt-4.1-mini'];
const EFFORTS = ['low', 'medium', 'high'];
const MODEL_LABEL = { 'default': 'Modelo de Hermes', 'gpt-5.6-luna': 'gpt-5.6-luna', 'claude-opus': 'claude-opus', 'gpt-4.1-mini': 'gpt-4.1-mini' };
const storage = { chats: 'agenthub.chats.v1', messages: 'agenthub.messages.v2', model: 'agenthub.model.v1', effort: 'agenthub.effort.v1', sessions: 'agenthub.sessions.v1' };
const read = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) ?? fallback) : fallback; } catch { return fallback; } };
const cloneJSON = value => JSON.parse(JSON.stringify(value));
const $ = (id) => document.querySelector(id);
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;

const snapshotKey = 'agenthub.conversations.v3';
const legacySnapshotKey = 'agenthub.conversations.legacy.v3';
const snapshot = read(snapshotKey, null);
// Preserve the exact pre-sync source. It is never removed, including on revocation.
if (snapshot && !localStorage.getItem(legacySnapshotKey)) localStorage.setItem(legacySnapshotKey, JSON.stringify(snapshot));
let chats = snapshot?.chats || read(storage.chats, seedChats);
let messages = snapshot?.messages || read(storage.messages, {});
let sessions = snapshot?.sessions || read(storage.sessions, {});
let sending = false;
const draftKey = 'agenthub.drafts.v2';
const storedDrafts = read(draftKey, null);
const legacyDrafts = read('agenthub.drafts.v1', {});
const drafts = {
  home: typeof storedDrafts?.home === 'string' ? storedDrafts.home : (typeof legacyDrafts.heroInput === 'string' ? legacyDrafts.heroInput : ''),
  byChat: Object.fromEntries(Object.entries(storedDrafts?.byChat || {}).filter(([, value]) => typeof value === 'string')),
  legacyMessage: storedDrafts ? (storedDrafts.legacyMessage || '') : (legacyDrafts.messageInput || '')
};
let draftsVisible = false;
let selectedModel = localStorage.getItem('agenthub.model.sso.v1') || 'default';
let selectedEffort = localStorage.getItem(storage.effort) || 'medium';
if (!MODELS.includes(selectedModel)) selectedModel = 'gpt-5.6-luna';
if (!EFFORTS.includes(selectedEffort)) selectedEffort = 'medium';
let selectedIndex = 0;
let activeChat = null;
let voiceUI = null;
let cloudSync = null;
let groupUI = null;
let preservedLocalSnapshot = null;
const mediaURLs = new Map();

const currentSnapshot = () => ({ chats, messages, sessions });
const save = () => {
  // Commit related records together: a failed write cannot leave an orphan.
  localStorage.setItem(snapshotKey, JSON.stringify(currentSnapshot()));
  preservedLocalSnapshot = cloneJSON(currentSnapshot());

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
function syncReady() { return Boolean(cloudSync?.isReady() && window.hermesCloud.ownerScope?.() === 'personal'); }
function setSyncGate() {
  const ready = syncReady();
  if (ready && !draftsVisible) { draftsVisible = true; restoreVisibleDrafts(); }
  document.body.classList.toggle('sync-locked', !ready);
  ['#newChatBtn','#mobileNewChatBtn','#chatNewBtn','#heroInput','#messageInput','#heroSendBtn','#sendBtn','#heroMicBtn','#micBtn','#heroVoiceBtn','#voiceBtn'].forEach(id => { const el = $(id); if (el) el.disabled = !ready || sending || (voiceUI?.busy ?? false); });
  $('#recoverBtn').disabled = !ready || sending || Boolean(voiceUI?.busy);
  if (activeChat?.archived) ['#messageInput','#sendBtn','#micBtn','#voiceBtn'].forEach(id => $(id).disabled = true);
  $('#syncBtn').disabled = !window.hermesCloud.isConnected() || window.hermesCloud.isRevoking();
  const reconnect = $('#reconnectNowBtn'); if (reconnect) reconnect.disabled = !window.hermesCloud.isConnected() || window.hermesCloud.isRevoking() || Boolean(voiceUI?.busy);
  refreshReconnectCard();
}
function releaseMediaURLs() {
  for (const [element, url] of mediaURLs) { element.pause(); element.removeAttribute('src'); URL.revokeObjectURL(url); }
  mediaURLs.clear();
}
function clearSyncedView() {
  stashVisibleDrafts(); draftsVisible = false;
  $('#heroInput').value = ''; $('#messageInput').value = ''; $('#recoverDraftBtn').hidden = true;
  if (!preservedLocalSnapshot) preservedLocalSnapshot = cloneJSON(currentSnapshot());
  releaseMediaURLs(); document.querySelectorAll('dialog[data-turn-evidence]').forEach(dialog => dialog.remove()); activeChat = null; chats = []; messages = {}; sessions = {};
  groupUI?.revoke();
  $('#messageList').textContent = ''; renderLists(); renderHome();
  $('#viewChat').hidden = true; $('#viewHome').hidden = false; document.body.classList.remove('chat-open');
  setSyncGate();
}
function applySyncedSnapshot(value) {
  chats = value.chats; messages = value.messages; sessions = value.sessions;
  save(); renderLists($('#searchInput').value); renderHome();
  const restored = chats.find(c => '#chat=' + c.id === location.hash);
  if (restored) openChat(restored); else showHome();
  setSyncGate();
}
function syncStatus(status) {
  $('#syncStatus').textContent = status.message || '';
  $('#reloadRemoteBtn').hidden = status.state !== 'conflict';
  setSyncGate();
  if (status.state === 'conflict' || status.state === 'error') showToast(status.message);
}
async function refreshSession() {
  if (window.hermesCloud.isRevoking()) {
    cloudSync?.revoke(); setLoginOpen(false); setConn(false, 'Desconexión pendiente'); setSyncGate(); return false;
  }
  if (window.hermesCloud.isConnected()) {
    setLoginOpen(false);
    if (syncReady()) setConn(true, 'Hermes sincronizado');
    else setConn(false, window.hermesCloud.ownerScope?.() === 'personal' ? 'Cuenta verificada · sincroniza' : 'Permiso guardado · verifica tu cuenta');
    if (cloudSync?.isReady() && !window.hermesCloud.ownerScope?.()) cloudSync.revoke();
    setSyncGate(); return syncReady();
  }
  cloudSync?.revoke(); setConn(false, 'Conectar Hermes'); showLogin(window.hermesCloud.connectionMessage?.() || 'Usa tu sesión de Hermes. No necesitas API key ni contraseña de Vercel.'); setSyncGate(); return false;
}
window.addEventListener('hermes-connection', refreshSession);
window.addEventListener('hermes-attention', () => showToast('Hermes necesita tu intervención en su dashboard.'));
let syncNowInFlight = false;
function syncFromNow() {
  if (syncNowInFlight || !window.hermesCloud.isConnected() || window.hermesCloud.isRevoking()) return Promise.resolve();
  syncNowInFlight = true;
  groupUI?.pauseObservation();
  const operation = cloudSync.syncFromUserGesture();
  operation.then(async () => {
    setConn(true, 'Hermes sincronizado'); setSyncGate();
    try {
      await groupUI?.loadWithinLease();
      const groupId = location.hash.startsWith('#group=') ? location.hash.slice(7) : '';
      if (groupId) groupUI?.open(groupId);
    } catch { /* El estado de grupos conserva el error real del catálogo. */ }
  }).catch(error => {
    if (error.code !== 'conflict') syncStatus({ state: 'error', message: error.message });
  }).finally(() => { syncNowInFlight = false; if (!voiceUI?.busy) window.hermesCloud.closeSync?.(); });
  return operation;
}
let firstGestureArmed = true;
let firstGestureDisarm = null;
function armFirstGestureSync() {
  if (!firstGestureArmed) return;
  // No abrimos ventanas desde un temporizador: esto se dispara dentro de un gesto real
  // (pointerdown/touchend/keydown) y solo cuando hay permiso guardado aún sin verificar.
  const needsSync = () => !loginIsOpen() && window.hermesCloud.isConnected() && !window.hermesCloud.isRevoking() && !syncReady();
  if (!needsSync()) { firstGestureArmed = false; return; }
  let fired = false;
  const isOwnedControl = target => Boolean(target && target.closest && (target.closest('#logoutBtn') || target.closest('#connectBtn') || target.closest('#loginOverlay') || target.closest('#reconnectNowBtn') || target.closest('#syncBtn')));
  const fire = (event) => {
    if (fired) return; fired = true; firstGestureArmed = false;
    cleanup();
    if (needsSync() && !isOwnedControl(event.target)) syncFromNow();
  };
  const cleanup = () => {
    document.removeEventListener('pointerdown', fire, true);
    document.removeEventListener('touchend', fire, true);
    document.removeEventListener('keydown', fire, true);
    if (firstGestureDisarm === cleanup) firstGestureDisarm = null;
  };
  if (firstGestureDisarm) firstGestureDisarm();
  document.addEventListener('pointerdown', fire, true);
  document.addEventListener('touchend', fire, true);
  document.addEventListener('keydown', fire, true);
  firstGestureDisarm = cleanup;
}
function disarmFirstGestureSync() { if (firstGestureDisarm) firstGestureDisarm(); }
function refreshReconnectCard() {
  const card = $('#reconnectCard');
  if (!card) return;
  const show = !syncReady() && window.hermesCloud.isConnected() && !window.hermesCloud.isRevoking();
  card.hidden = !show;
  if (show) armFirstGestureSync(); else disarmFirstGestureSync();
}
function setConn(ok, text) {
  const dot = $('#connDot'); if (dot) dot.className = 'conn-dot' + (ok ? ' ok' : text === 'Comprobando…' ? '' : ' bad');
  const el = $('#connText'); if (el) el.textContent = text;
  const bs = $('#backendState'); if (bs) bs.textContent = text.toLowerCase();
}
let loginReturnFocus = null;
const loginBackground = new Map();
function loginIsOpen() { return $('#loginOverlay').classList.contains('open'); }
function setLoginOpen(open) {
  const modal = $('#loginOverlay');
  const wasOpen = loginIsOpen();
  modal.classList.toggle('open', open);
  modal.setAttribute('aria-hidden', String(!open));
  if (open && !wasOpen) {
    loginReturnFocus = document.activeElement;
    for (const el of document.body.children) {
      if (el === modal || el.tagName === 'SCRIPT' || el.id === 'toast') continue;
      loginBackground.set(el, Boolean(el.inert)); el.inert = true;
    }
    $('#loginForm button').focus();
  } else if (!open && wasOpen) {
    for (const [el, inert] of loginBackground) el.inert = inert;
    loginBackground.clear();
    const target = loginReturnFocus?.isConnected && loginReturnFocus !== document.body && !loginReturnFocus.disabled ? loginReturnFocus : $(isMobile() ? '#openSidebar' : '#connectBtn');
    target?.focus(); loginReturnFocus = null;
  }
}
function showLogin(msg) {
  if (msg) $('#loginStatus').textContent = msg;
  setLoginOpen(true);
}
$('#closeLoginBtn').addEventListener('click', () => setLoginOpen(false));
$('#connectBtn').addEventListener('click', () => showLogin('Conecta tu sesión de Hermes para trabajar.'));
document.addEventListener('focusin', event => {
  if (loginIsOpen() && !$('#loginOverlay').contains(event.target)) $('#loginForm button').focus();
});
document.addEventListener('keydown', event => {
  if (!loginIsOpen()) return;
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setLoginOpen(false); }
  if (event.key === 'Tab') {
    const buttons = [...$('#loginOverlay').querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
  }
}, true);

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
  groupUI?.renderList(filter);
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
  $('#fleet').innerHTML = `<span>Chat individual · <b>Director</b></span><span><b>${groupUI?.getGroupCount() || 0}</b> grupos reales</span><span><b>${escapeHtml(selectedModel)}</b> · ${escapeHtml(selectedEffort)}</span>`;
}
function syncPills() {
  ['#modelPill', '#modelPillChat'].forEach((s) => { const el = $(s); if (el) el.innerHTML = `${escapeHtml(selectedModel)} <span aria-hidden="true">⌄</span>`; });
  ['#effortPill', '#effortPillChat'].forEach((s) => { const el = $(s); if (el) el.innerHTML = `${escapeHtml(selectedEffort)} <span aria-hidden="true">⌄</span>`; });
}

/* ---------- views ---------- */
function showHome() {
  if (voiceUI?.busy) { showToast('Finaliza la voz antes de cambiar de conversación.'); return; }
  stashVisibleDrafts();
  activeChat = null; restoreVisibleDrafts();
  history.replaceState(null, '', location.pathname + location.search);
  $('#viewChat').hidden = true;
  groupUI?.hideDetail();
  const home = $('#viewHome'); home.hidden = false; home.style.display = '';
  document.body.classList.remove('chat-open');
  autoGrow($('#heroInput'));
  renderLists($('#searchInput').value); renderHome();
}
function openChat(chat) {
  if (voiceUI && !voiceUI.canNavigate(chat)) { showToast('Finaliza la voz antes de cambiar de conversación.'); return; }
  stashVisibleDrafts();
  activeChat = chat; restoreVisibleDrafts();
  history.replaceState(null, '', '#chat=' + chatKey(chat));
  selectedModel = chat.model || selectedModel;
  selectedEffort = chat.effort || selectedEffort;
  syncPills();
  selectedIndex = Math.max(0, chats.indexOf(chat));
  $('#viewHome').hidden = true;
  groupUI?.hideDetail();
  const thread = $('#viewChat'); thread.hidden = false;
  document.body.classList.add('chat-open');
  autoGrow($('#messageInput'));
  $('#chatWindowTitle').textContent = chat.title;
  renderMessages(chat); renderLists($('#searchInput').value);
  document.body.classList.remove('side-open');
  if (!isMobile()) $('#messageInput').focus();
}
function closeChat() { showHome(); }

/* ---------- messages ---------- */
function renderMessages(chat) {
  const box = $('#messageList');
  releaseMediaURLs();
  const history = historyOf(chat);
  if (!history.length) {
    box.textContent = 'Escribe un mensaje para comenzar.';
    return;
  }
  box.innerHTML = history.map((m) => {
    if (m.role === 'assistant' || m.role === 'agent') return `<div class="msg-agent"><span class="who">HERMES · DIRECTOR</span><div class="safe-content" data-answer-id="${escapeHtml(m.id || '')}"></div></div>`;
    if (m.role === 'audio') return `<div class="msg-user msg-audio" data-message-id="${escapeHtml(m.id || '')}"><span class="audio-label">${escapeHtml(AUDIO_STATES[m.status] || 'Nota de voz')} · ${Math.round((m.duration || 0) / 1000)} s</span>${m.audioId ? `<audio controls preload="metadata" aria-label="Reproducir nota de voz" data-audio-id="${escapeHtml(m.audioId)}"></audio>` : '<span>Audio antiguo no recuperable</span>'}${m.text ? `<p class="transcript">${escapeHtml(m.text)}</p>` : ''}${m.status === 'transcription_error' ? `<button class="audio-retry" data-retry-audio="${escapeHtml(m.id)}">Reintentar transcripción</button>` : ''}</div>`;
    return `<div class="msg-user">${escapeHtml(m.text || '')}</div>`;
  }).join('');
  const answers = history.filter(m => m.role === 'assistant' || m.role === 'agent');
  box.querySelectorAll('.safe-content').forEach((container, index) => {
    const text = answers[index].text || '';
    if (window.AgentHubContent?.render) window.AgentHubContent.render(container, text, { notify: showToast });
    else container.textContent = text; // A missing presentation asset must never hide the answer.
  });
  if (chat.error) { const notice = document.createElement('div'); notice.setAttribute('role', 'alert'); notice.textContent = chat.error; box.appendChild(notice); }
  hydrateAudio(chat, box);
  box.querySelectorAll('[data-retry-audio]').forEach(button => { button.onclick = () => voiceUI?.retryNote(chat, history.find(m => m.id === button.dataset.retryAudio)); });
  box.scrollTop = box.scrollHeight;
}
function inputDraftId(input) { return input.id === 'heroInput' ? 'home' : activeChat?.id; }
function persistDrafts() {
  try { localStorage.setItem(draftKey, JSON.stringify(drafts)); }
  catch { showToast('No se pudo guardar el borrador en este dispositivo. No recargues todavía.'); }
}
function rememberDraft(input, key = inputDraftId(input)) {
  if (!key) return;
  if (key === 'home') drafts.home = input.value;
  else drafts.byChat[key] = input.value;
  persistDrafts();
}
function stashVisibleDrafts() {
  if (!draftsVisible) return;
  rememberDraft($('#heroInput'));
  if (activeChat) rememberDraft($('#messageInput'));
}
function restoreVisibleDrafts() {
  if (!draftsVisible) return;
  $('#heroInput').value = drafts.home;
  $('#messageInput').value = activeChat ? (drafts.byChat[activeChat.id] || '') : '';
  $('#recoverDraftBtn').hidden = !drafts.legacyMessage;
  autoGrow($('#heroInput')); autoGrow($('#messageInput'));
}
$('#recoverDraftBtn').addEventListener('click', () => {
  if (!syncReady() || !drafts.legacyMessage) return;
  if ($('#heroInput').value.trim()) { showToast('Conserva o envía primero el borrador de inicio; no lo sobrescribiremos.'); return; }
  drafts.home = String(drafts.legacyMessage); drafts.legacyMessage = '';
  persistDrafts(); restoreVisibleDrafts();
});
function sendError(message, input) {
  let box = document.getElementById('sendError');
  if (!box) { box = document.createElement('div'); box.id = 'sendError'; box.setAttribute('role', 'alert'); }
  box.textContent = message + ' ';
  const retry = document.createElement('button'); retry.textContent = 'Reintentar';
  retry.onclick = () => sendText(input.value.trim(), input);
  box.appendChild(retry); input.closest('.composer').after(box);
}
function commitMessage(chat, entry) {
  const key = chatKey(chat);
  const previous = messages[key] || [];
  if (entry.id && previous.some(m => m.id === entry.id)) return false;
  const nextMessages = { ...messages, [key]: [...previous, entry] };
  const nextChats = chats.includes(chat) ? chats : [chat, ...chats];
  localStorage.setItem(snapshotKey, JSON.stringify({ chats: nextChats, messages: nextMessages, sessions }));
  chats = nextChats; messages = nextMessages;
  preservedLocalSnapshot = cloneJSON(currentSnapshot());
  openChat(chat);
  return true;
}
function persistMessages(chat) {
  localStorage.setItem(snapshotKey, JSON.stringify({ chats, messages, sessions }));
  preservedLocalSnapshot = cloneJSON(currentSnapshot());
  if (activeChat === chat) renderMessages(chat);
  renderLists($('#searchInput').value);
}
function setSending(value) {
  sending = value;
  ['#heroSendBtn', '#sendBtn'].forEach(id => $(id).disabled = value || Boolean(voiceUI?.busy) || !syncReady());
}
async function respondToMessage(chat, entry, leaseReady = Promise.resolve()) {
  const key = chatKey(chat);
  if (entry.delivery === 'complete' || entry.delivery === 'uncertain') throw new Error('Este turno ya fue enviado. No se reenviará.');
  // The user entry and every referenced audio blob must be remotely durable first.
  await leaseReady;
  await cloudSync.beforeTurn();
  entry.delivery = 'sending';
  persistMessages(chat);
  try {
    const data = await window.hermesCloud.chat({ message: entry.text, chatId: key, clientMessageId: entry.id, model: chat.model, effort: chat.effort });
    if (data?.sessionId) sessions[key] = data.sessionId;
    const reply = { id: entry.id + '-reply', role: 'assistant', text: data?.text || 'Sin respuesta.' };
    if (!messages[key].some(m => m.id === reply.id)) messages[key].push(reply);
    entry.delivery = 'complete'; entry.status = 'complete'; delete chat.error;
    persistMessages(chat);
    try { await cloudSync.afterTurn(); }
    catch (syncError) { showToast(syncError.message || 'La respuesta quedó local; sincroniza de nuevo.'); }
    return reply.text;
  } catch (error) {
    entry.delivery = 'uncertain'; entry.status = 'uncertain';
    chat.error = 'No se pudo confirmar el turno. Comprueba Hermes antes de reenviarlo.';
    try { persistMessages(chat); await cloudSync.afterTurn(); } catch { showToast('No recargues: no se pudo sincronizar el estado del turno.'); }
    throw error;
  }
}
async function sendText(text, input = $('#messageInput')) {
  if (!text || sending || voiceUI?.busy) return;
  if (input.id !== 'heroInput' && activeChat?.archived) { showToast('Este hilo está archivado. Abre una conversación nueva; no reenvíes automáticamente el turno anterior.'); return; }
  const sourceDraftId = inputDraftId(input);
  rememberDraft(input);
  if (input.id !== 'heroInput' && activeChat && (messages[activeChat.id] || []).some(m => ['uncertain','sending'].includes(m.delivery))) { showToast('Consulta el resultado pendiente antes de enviar otro mensaje a este hilo.'); return; }
  if (!window.hermesCloud.isConnected()) {
    showLogin(window.hermesCloud.isRevoking() ? 'Completa la desconexión pendiente.' : 'Conecta tu sesión de Hermes para enviar. Tu borrador está guardado.');
    return;
  }
  if (!syncReady()) { showToast('Pulsa Sincronizar antes de enviar. Tu borrador se conserva.'); return; }
  let leaseReady;
  try { leaseReady = window.hermesCloud.openVoice(); leaseReady.catch(() => {}); }
  catch (error) { showToast(error.message); return; }
  setSending(true);
  document.getElementById('sendError')?.remove();
  const isNew = input.id === 'heroInput' || !activeChat;
  const chat = isNew ? newConversation(text.slice(0, 42), agents[0]) : activeChat;
  const entry = { id: crypto.randomUUID(), role: 'user', text };
  chat.model = selectedModel; chat.effort = selectedEffort;
  delete chat.error;
  try { commitMessage(chat, entry); }
  catch {
    setSending(false);
    window.hermesCloud.closeVoice?.();
    sendError('No se pudo guardar la conversación. El texto sigue aquí.', input);
    return;
  }
  input.value = ''; rememberDraft(input, sourceDraftId); autoGrow(input);
  openChat(chat);
  setConn(true, 'Pensando…');
  $('#messageList').insertAdjacentHTML('beforeend', '<div class="msg-agent" id="typingRow" role="status">Hermes está respondiendo…</div>');
  try {
    // Keep popup creation synchronous with the original click/Enter.
    await respondToMessage(chat, entry, leaseReady);
  } catch (error) {
    // Never disguise transport/auth failures as agent replies or auto-retry an uncertain turn.
    chat.error = error.message || 'Sin conexión con Hermes.';
    showToast(chat.error);
  } finally {
    try { localStorage.setItem(snapshotKey, JSON.stringify({chats, messages, sessions})); }
    catch { showToast('No se pudo guardar la última respuesta. No recargues todavía.'); }
    window.hermesCloud.closeVoice?.();
    setSending(false);
    if (activeChat === chat) renderMessages(chat);
    renderLists($('#searchInput').value); refreshSession();
  }
}

/* ---------- audio presentation (binary persistence lives in voice-engine) ---------- */
const AUDIO_STATES = {uploading: 'Guardando audio…', transcribing: 'Transcribiendo…', processing: 'Esperando a Hermes…', complete: 'Nota de voz', transcription_error: 'No se pudo transcribir', uncertain: 'Turno sin confirmar: comprueba Hermes'};
async function hydrateAudio(chat, box) {
  if (!voiceUI) return;
  for (const element of box.querySelectorAll('audio[data-audio-id]')) {
    const id = element.dataset.audioId;
    try {
      const blob = cloudSync ? await cloudSync.getAudio(id, chat.id) : await voiceUI.store.get(id, chat.id);
      if (!element.isConnected || activeChat !== chat) continue;
      if (!blob) { element.replaceWith(document.createTextNode('Audio no disponible en este dispositivo.')); continue; }
      const url = URL.createObjectURL(blob); mediaURLs.set(element, url); element.src = url;
    } catch { if (element.isConnected) element.replaceWith(document.createTextNode('No se pudo cargar el audio. Recarga para reintentar.')); }
  }
}
function voiceTarget(fromHome) {
  return fromHome || !activeChat ? newConversation('Conversación de voz', agents[0]) : activeChat;
}
function authorizeVoice() {
  groupUI?.pauseObservation();
  if (activeChat && (messages[activeChat.id] || []).some(m => ['uncertain','sending'].includes(m.delivery))) { showToast('Consulta el resultado pendiente antes de continuar con voz.'); return false; }
  if (activeChat?.archived) { showToast('Este hilo está archivado. Abre una conversación nueva.'); return false; }
  if (!window.hermesCloud.isConnected()) { showLogin('Conecta Hermes antes de usar el micrófono.'); return false; }
  if (!syncReady()) { showToast('Pulsa Sincronizar antes de usar la voz.'); return false; }
  return true;
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
function newConversation(title, agentName = agents[0]) {
  agentName = agents[0]; // The authenticated individual connector serves only this profile.
  return { id: crypto.randomUUID(), title, desc: 'Conversación con Hermes Cloud', time: 'Ahora', agent: agentName, agents: [agentName[0]], model: selectedModel, effort: selectedEffort, status: 'Nuevo' };
}
function createChat() {
  if (!syncReady()) { showToast('Conecta y sincroniza tu cuenta antes de abrir un chat.'); return; }
  showHome();
  if (!isMobile()) $('#heroInput').focus();
}
function autoGrow(t) { t.style.height = 'auto'; t.style.height = `${Math.max(44, Math.min(t.scrollHeight, 200))}px`; }

/* ---------- wiring ---------- */
$('#searchInput').addEventListener('input', (e) => renderLists(e.target.value));
const startNewChat = () => createChat();
$('#newChatBtn').addEventListener('click', startNewChat);
$('#mobileNewChatBtn').addEventListener('click', startNewChat);
$('#chatNewBtn').addEventListener('click', startNewChat);

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
  t.value = ''; // Restore stored drafts only after verifying the personal account.
  t.addEventListener('input', () => { autoGrow(t); rememberDraft(t); });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !e.repeat) {
      e.preventDefault();
      if (t.id === 'heroInput') submitHero(); else $('#sendBtn').click();
    }
  });
});
$('#heroMicBtn').addEventListener('click', () => { if (!sending) voiceUI?.startNote(voiceTarget(true)); });
$('#micBtn').addEventListener('click', () => { if (!sending) voiceUI?.startNote(voiceTarget(false)); });
$('#heroVoiceBtn').addEventListener('click', () => voiceUI?.startLive(voiceTarget(true)));
$('#voiceBtn').addEventListener('click', () => voiceUI?.startLive(voiceTarget(false)));

const placeMenus = (anchor, menu) => toggleMenu(menu, anchor);
['#modelPill', '#modelPillChat'].forEach((s) => $(s).addEventListener('click', (e) => { e.stopPropagation(); placeMenus(e.currentTarget, '#modelMenu'); }));
['#effortPill', '#effortPillChat'].forEach((s) => $(s).addEventListener('click', (e) => { e.stopPropagation(); placeMenus(e.currentTarget, '#effortMenu'); }));
document.addEventListener('click', () => { $('#modelMenu').hidden = true; $('#effortMenu').hidden = true; });
document.querySelectorAll('#modelMenu button').forEach((b) => b.addEventListener('click', () => { selectedModel = b.dataset.model; save(); syncPills(); renderHome(); showToast(`Modelo: ${selectedModel}`); }));
document.querySelectorAll('#effortMenu button').forEach((b) => b.addEventListener('click', () => { selectedEffort = b.dataset.effort; save(); syncPills(); renderHome(); showToast(`Esfuerzo: ${selectedEffort}`); }));

$('#syncBtn').addEventListener('click', () => { syncFromNow(); });
$('#reconnectNowBtn').addEventListener('click', () => { syncFromNow(); });
$('#reloadRemoteBtn').addEventListener('click', () => {
  groupUI?.pauseObservation();
  let ready;
  try { ready = window.hermesCloud.openSync ? window.hermesCloud.openSync() : window.hermesCloud.openVoice(); ready.catch(() => {}); }
  catch (error) { showToast(error.message); return; }
  ready.then(async () => { await cloudSync.reloadRemote(); try { await groupUI?.loadWithinLease(); } catch {} })
    .catch(error => syncStatus({ state: 'error', message: error.message }))
    .finally(() => { if (!voiceUI?.busy) window.hermesCloud.closeSync?.(); });
});
$('#loginForm').addEventListener('submit', e => {
  e.preventDefault();
  try { window.hermesCloud.open(); $('#loginStatus').textContent = 'Pulsa Conectar en la ventana de Hermes y vuelve aquí.'; }
  catch (error) { $('#loginStatus').textContent = error.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  await voiceUI?.end();
  try { await window.hermesCloud.disconnect(); cloudSync.revoke(); showToast('Conexión con Hermes revocada.'); }
  catch (error) { showToast(error.message); }
  refreshSession();
});
document.addEventListener('keydown', (e) => {
  if (voiceUI?.busy) return;
  if (e.key === 'Escape') { closeDialog(); groupUI?.closeEditor(); if (activeChat || !$('#viewGroup').hidden) showHome(); document.body.classList.remove('side-open'); }
  if ((e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'k') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) startNewChat();
});

cloudSync = new window.AgentCloudSync.CloudSync({
  transport: window.hermesCloud,
  readLocalSnapshot: () => cloneJSON(preservedLocalSnapshot || currentSnapshot()),
  applySnapshot: applySyncedSnapshot,
  getLocalAudio: (id, chatId) => voiceUI?.store.get(id, chatId) || null,
  cacheAudio: (id, chatId, blob) => voiceUI?.store.put(id, chatId, blob),
  clearVisible: clearSyncedView,
  onStatus: syncStatus
});
window.addEventListener('hermes-identity-denied', () => { cloudSync.revoke(); groupUI?.revoke(); });
const turnRecoveryUI = window.AgentTurnUI?.create({
  transport: window.hermesCloud, sync: cloudSync,
  getChat: () => activeChat, getMessages: chat => messages[chat.id] || [],
  isBusy: () => sending || Boolean(voiceUI?.busy) || !syncReady(),
  setBusy: value => { setSending(value); setSyncGate(); },
  notice: showToast,
  persist: chat => { delete chat.error; persistMessages(chat); },
  render: chat => { if (activeChat === chat) renderMessages(chat); },
  showEvidence: result => {
    const chat = activeChat;
    const dialog = document.createElement('dialog'); dialog.dataset.turnEvidence = '1';
    const title = document.createElement('h2'); title.textContent = 'Resultado sin confirmar';
    const warning = document.createElement('p'); warning.textContent = 'No hay prueba suficiente para recuperar una respuesta exacta. No se ha reenviado nada. El historial siguiente es solo para revisión; las acciones podrían seguir ejecutándose en Hermes.';
    const evidence = document.createElement('pre'); evidence.textContent = [result.status || '', ...(result.history || []).map(row => row.role + ': ' + row.text)].join('\n\n');
    const close = document.createElement('button'); close.textContent = 'Cerrar'; close.onclick = () => { dialog.close(); dialog.remove(); };
    const abandon = document.createElement('button'); abandon.textContent = 'Archivar y abrir conversación nueva';
    abandon.onclick = async () => {
      if (!chat || sending || voiceUI?.busy || !syncReady()) return;
      if (!window.confirm('Esto NO cancela acciones que Hermes pueda seguir ejecutando y NO reenvía el mensaje. El hilo anterior quedará de solo lectura. La conversación nueva no heredará su contexto. ¿Continuar?')) return;
      setSending(true); setSyncGate();
      try {
        await window.hermesCloud.openVoice();
        chat.archived = true; chat.error = 'Archivada con resultado sin confirmar; no reenviar automáticamente.';
        persistMessages(chat); await cloudSync.afterTurn();
        dialog.close(); dialog.remove(); showHome();
        showToast('Hilo archivado. Escribe un objetivo nuevo; no se ha reenviado el anterior.');
      } catch (error) { showToast(error.message); }
      finally { window.hermesCloud.closeVoice(); setSending(false); setSyncGate(); }
    };
    dialog.append(title, warning, evidence, close, abandon); document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('close', () => dialog.remove(), {once:true});
  }
});
$('#recoverBtn').addEventListener('click', () => turnRecoveryUI?.run());

if (window.AgentVoice && window.AgentVoiceUI) {
  const voiceTransport = {
    isConnected: () => window.hermesCloud.isConnected(),
    openVoice: () => window.hermesCloud.openVoice(),
    closeVoice: () => window.hermesCloud.closeVoice(),
    transcribe: async data => { await cloudSync.beforeTurn(); return window.hermesCloud.transcribe(data); },
    synthesize: data => window.hermesCloud.synthesize(data)
  };
  voiceUI = new window.AgentVoiceUI({
    transport: voiceTransport, authorize: authorizeVoice,
    commit: commitMessage, persist: persistMessages, respond: respondToMessage,
    notify: showToast, isSending: () => sending, lock: () => setSending(sending)
  });
}
if (window.AgentGroups?.GroupUI) {
  groupUI = new window.AgentGroups.GroupUI({
    window,
    document,
    transport: window.hermesCloud,
    notify: showToast,
    isVoiceBusy: () => Boolean(voiceUI?.busy),
    onCount: () => renderHome(),
    onOpen: group => {
      stashVisibleDrafts();
      activeChat = null; restoreVisibleDrafts();
      $('#viewHome').hidden = true;
      $('#viewChat').hidden = true;
      history.replaceState(null, '', '#group=' + group.id);
      document.body.classList.remove('chat-open', 'side-open');
    }
  });
}
['#heroMicBtn','#micBtn','#heroVoiceBtn','#voiceBtn'].forEach(id => { $(id).disabled = !voiceUI; $(id).title = id.includes('Mic') || id === '#micBtn' ? 'Grabar una nota de voz' : 'Conversación de voz'; });
// A reload is not proof of delivery: never replay uncertain actions.
for (const chat of chats) for (const entry of messages[chat.id] || []) {
  if (entry.delivery === 'sending') { entry.delivery = 'uncertain'; entry.status = 'uncertain'; chat.error = 'Turno interrumpido por una recarga. Comprueba Hermes antes de reenviar.'; }
  else if (entry.role === 'audio' && ['uploading','transcribing','processing'].includes(entry.status)) entry.status = 'transcription_error';
}
save();
syncPills();
// A local authorization bit is not owner verification: start with history hidden.
cloudSync.revoke();
refreshSession();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js?v=20260905-8').catch(() => {}));
