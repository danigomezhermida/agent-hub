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
const storage = { chats: 'agenthub.chats.v1', groups: 'agenthub.groups.v1', messages: 'agenthub.messages.v1', model: 'agenthub.model.v1' };
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
let chats = read(storage.chats, seedChats);
let groups = read(storage.groups, seedGroups);
let messages = read(storage.messages, {});
let selectedModel = localStorage.getItem(storage.model) || 'gpt-5.6-luna';
let selectedIndex = 0;
const grid = document.querySelector('#chatGrid');
const strip = document.querySelector('#groupsStrip');
const toast = document.querySelector('#toast');
const overlay = document.querySelector('#chatOverlay');
const dialog = document.querySelector('#simpleDialog');

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
const messageList = document.querySelector('#messageList');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (match) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[match]));
const save = () => { localStorage.setItem(storage.chats, JSON.stringify(chats)); localStorage.setItem(storage.groups, JSON.stringify(groups)); localStorage.setItem(storage.messages, JSON.stringify(messages)); localStorage.setItem(storage.model, selectedModel); };

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
  const history = messages[chat.title] || [{ role: 'agent', author: 'Dani · Director', text: '¿En qué quieres que trabajemos?' }];
  messageList.innerHTML = history.map((message) => message.role === 'agent'
    ? `<div class="message agent"><span class="message-avatar">D</span><div><small>${escapeHtml(message.author)}</small><p>${escapeHtml(message.text)}</p></div></div>`
    : `<div class="message user"><div><small>Tú</small><p>${escapeHtml(message.text)}</p></div></div>`).join('');
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
  // En móvil no hacemos focus automático: evita que Safari/Chrome
  // abra el teclado y desplace la cabecera fuera de la pantalla.
  if (!window.matchMedia('(max-width: 760px)').matches) document.querySelector('#messageInput').focus();
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
  const chat = { title: `Chat con ${agentName.split(' · ')[0]}`, desc: 'Nueva conversación preparada', time: 'Ahora', icon: '✦', tone: 'purple', agents: [agentName[0]], status: 'Nuevo' };
  chats.unshift(chat);
  selectedIndex = 0;
  save(); render(); selectChat(0, true);
  showToast('Chat creado y guardado en este dispositivo');
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
document.querySelector('#closeChat').addEventListener('click', () => { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); });
document.querySelector('#closeDialog').addEventListener('click', closeDialog);
overlay.addEventListener('click', (event) => { if (event.target === overlay) document.querySelector('#closeChat').click(); });
dialog.addEventListener('click', (event) => { if (event.target === dialog) closeDialog(); });
document.querySelector('#composer').addEventListener('submit', (event) => { event.preventDefault(); const input = document.querySelector('#messageInput'); const text = input.value.trim(); const chat = chats[selectedIndex]; if (!text || !chat) return; if (!messages[chat.title]) messages[chat.title] = [{ role: 'agent', author: 'Dani · Director', text: '¿En qué quieres que trabajemos?' }]; messages[chat.title].push({ role: 'user', text }); save(); renderMessages(chat); input.value = ''; showToast('Mensaje guardado en este dispositivo; falta conectar Hermes'); });
document.querySelector('#modelSelect').addEventListener('click', () => document.querySelector('#modelMenu').classList.toggle('open'));
document.querySelectorAll('#modelMenu button').forEach((button) => button.addEventListener('click', () => { selectedModel = button.firstChild.textContent.trim(); document.querySelector('#modelSelect').firstChild.textContent = `${selectedModel} `; document.querySelector('#modelMenu').classList.remove('open'); save(); showToast(`Modelo seleccionado: ${selectedModel}`); }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { closeDialog(); document.querySelector('#closeChat').click(); } if (event.key.toLowerCase() === 'n' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) document.querySelector('#newChatBtn').click(); });
document.querySelector('#modelSelect').firstChild.textContent = `${selectedModel} `;
render(); renderGroups(); selectChat(0);
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));