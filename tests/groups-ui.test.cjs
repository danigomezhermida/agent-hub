const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require(process.env.JSDOM_PATH || 'jsdom');
const { GroupUI } = require('../groups-ui.js');

const catalog = {
  director: { id: 'limpatexdev-cloud', label: 'Director', available: true },
  specialists: [
    { id: 'limpatexdevsenior', label: 'Senior Dev', available: true },
    { id: 'limpatexqa', label: 'QA', available: true }
  ]
};
const group = { id: 'development', name: 'Desarrollo y QA', director: 'limpatexdev-cloud', members: ['limpatexdevsenior'], objective: 'Analizar y proponer.' };

function markup() {
  return `
    <ul id="groupList"></ul><button id="newGroupBtn"></button><button id="reloadGroupsBtn"></button><span id="groupsStatus"></span>
    <section id="viewGroup" hidden><h2 id="groupTitle"></h2><p id="groupObjective"></p><div id="groupMembers"></div><div id="groupNotice"></div>
      <button id="editGroupBtn"></button><textarea id="groupMessage"></textarea><button id="startGroupBtn"></button><button id="refreshGroupRunBtn"></button>
      <div id="groupRunStatus"></div><ol id="groupRunSteps"></ol><section id="groupRunResult" hidden><h3></h3><div data-output></div></section>
    </section>
    <div id="groupDialog" hidden><form id="groupForm"><h2 id="groupFormTitle"></h2><input id="groupName"><textarea id="groupObjectiveInput"></textarea>
      <p id="groupDirector"></p><div id="groupMemberChoices"></div><div id="groupFormError"></div><button id="saveGroupBtn" type="submit"></button><button id="cancelGroupBtn" type="button"></button>
    </form></div>`;
}

function harness({ groups = [group], cat = catalog, stored = {}, owner = 'personal', handlers = {}, isVoiceBusy = () => false, clock = null, content = null } = {}) {
  const dom = new JSDOM(markup(), { url: 'https://hub.test/' });
  const w = dom.window;
  for (const [key, value] of Object.entries(stored)) w.localStorage.setItem(key, value);
  const calls = []; let closes = 0, remoteGroups = structuredClone(groups), remoteRevision = 4;
  const transport = {
    ownerScope: () => owner,
    openVoice: () => { calls.push({ op: 'openVoice' }); return Promise.resolve(); },
    closeVoice: () => { closes += 1; },
    storage: async (op, args = {}) => {
      calls.push({ op, args });
      if (handlers[op]) return handlers[op](args, w);
      if (op === 'getGroupCatalog') return structuredClone(cat);
      if (op === 'getGroups') return { revision: remoteRevision, groups: structuredClone(remoteGroups) };
      if (op === 'putGroups') { remoteRevision = args.expectedRevision + 1; remoteGroups = structuredClone(args.groups); return { revision: remoteRevision, groups: structuredClone(remoteGroups) }; }
      if (op === 'startGroupRun') return { id: args.runId, groupId: args.groupId, state: 'running', steps: [], text: '', error: '' };
      if (op === 'getGroupRuns') return { runs: [{ id: 'run_recover', groupId: group.id, state: 'completed', steps: [], text: 'Síntesis final', error: '' }] };
      if (op === 'getGroupRun') return { id: args.runId, groupId: group.id, state: 'completed', steps: [], text: 'Síntesis final', error: '' };
      throw Error('unexpected ' + op);
    }
  };
  const notices = [];
  if (content) w.AgentHubContent = content;
  const ui = new GroupUI({
    window: w, document: w.document, transport, notify: text => notices.push(text), onOpen: () => {}, onCount: () => {}, isVoiceBusy,
    observationIntervalMs: 10, observationMaxMs: 50,
    now: clock && (() => clock.now),
    setTimer: clock && ((fn, delay) => clock.set(fn, delay)),
    clearTimer: clock && (id => clock.clear(id))
  });
  return { dom, w, ui, calls, notices, closes: () => closes, $: selector => w.document.querySelector(selector), flush: () => new Promise(resolve => setImmediate(resolve)) };
}

function manualClock() {
  let nextId = 1;
  const jobs = new Map();
  return {
    now: 0,
    set(fn, delay) { const id = nextId++; jobs.set(id, { at: this.now + delay, fn }); return id; },
    clear(id) { jobs.delete(id); },
    async advance(ms) {
      const end = this.now + ms;
      while (true) {
        const due = [...jobs.entries()].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        jobs.delete(due[0]); this.now = due[1].at; due[1].fn(); await new Promise(resolve => setImmediate(resolve));
      }
      this.now = end; await new Promise(resolve => setImmediate(resolve));
    },
    pending: () => jobs.size
  };
}

async function loaded(h) { await h.ui.loadFromGesture(); }

test('old completion after revoke cannot close or unlock a new group lease', async () => {
  const h=harness(); let resolveOld,resolveNew;
  const oldGate=new Promise(resolve=>{resolveOld=resolve;});
  const newGate=new Promise(resolve=>{resolveNew=resolve;});
  const old=h.ui._withGesture(async fence=>{await oldGate;fence();});
  old.catch(()=>{}); await h.flush();
  h.ui.revoke();
  const newer=h.ui._withGesture(async fence=>{await newGate;fence();});
  newer.catch(()=>{}); await h.flush();
  const closes=h.closes(); resolveOld();
  await assert.rejects(old,/identidad/i);
  assert.equal(h.closes(),closes);
  assert.equal(h.ui.operationBusy,true);
  resolveNew();await newer;
  assert.equal(h.ui.operationBusy,false);
  assert.equal(h.closes(),closes+1);
  h.dom.window.close();
});

test('catalog is authoritative: missing director/member is visible and cannot run', async () => {
  const missingDirector = harness({ cat: { director: null, specialists: catalog.specialists } });
  await assert.rejects(missingDirector.ui.loadFromGesture(), /director/i);
  assert.equal(missingDirector.$('#groupList').children.length, 0);
  assert.match(missingDirector.$('#groupsStatus').textContent, /catálogo|director/i);
  assert.doesNotMatch(missingDirector.$('#groupsStatus').textContent, /disponible/i);
  missingDirector.dom.window.close();

  const missingMember = harness({ groups: [{ ...group, members: ['removed-profile'] }] });
  await loaded(missingMember); missingMember.ui.open(group.id);
  assert.match(missingMember.$('#groupNotice').textContent, /removed-profile/);
  assert.equal(missingMember.$('#startGroupBtn').disabled, true);
  missingMember.dom.window.close();
});

test('identity revocation hides group state without deleting recoverable run id', async () => {
  const h = harness(); await loaded(h); h.ui.open(group.id);
  h.w.localStorage.setItem('agenthub.group-runs.v1', JSON.stringify({ [group.id]: { runId: 'run_keep', groupId: group.id, state: 'running' } }));
  h.ui.revoke();
  assert.equal(h.$('#groupList').children.length, 0);
  assert.equal(h.$('#viewGroup').hidden, true);
  assert.equal(h.ui.getGroupCount(), 0);
  assert.match(h.w.localStorage.getItem('agenthub.group-runs.v1'), /run_keep/);
  h.dom.window.close();
});

test('CAS conflict is shown and never overwrites the loaded group', async () => {
  const h = harness({ handlers: { putGroups: () => { const error = Error('Hay cambios de otro dispositivo.'); error.code = 'conflict'; throw error; } } });
  await loaded(h); h.ui.open(group.id); h.ui.openEditor(group.id);
  h.$('#groupName').value = 'Nombre local en conflicto';
  h.$('#groupForm').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush(); await h.flush();
  assert.equal(h.ui.groups[0].name, group.name);
  assert.match(h.$('#groupFormError').textContent, /otro dispositivo|conflicto/i);
  assert.equal(h.$('#groupDialog').hidden, false);
  assert.equal(h.calls.filter(call => call.op === 'putGroups').length, 1);
  h.dom.window.close();
});

test('run id is durable before submit, duplicate start is gated, and only director final text renders', async () => {
  let observedPending;
  const h = harness({ handlers: {
    startGroupRun: async (args, w) => {
      observedPending = JSON.parse(w.localStorage.getItem('agenthub.group-runs.v1'))[group.id];
      await new Promise(resolve => setImmediate(resolve));
      return { id: args.runId, groupId: group.id, state: 'completed', steps: [{ profile: 'limpatexdevsenior', stage: 'analysis', status: 'completed', text: 'raw specialist secret' }], text: 'Respuesta revisada del director', error: '' };
    }
  } });
  await loaded(h); h.ui.open(group.id); h.$('#groupMessage').value = 'Evalúa esta propuesta';
  h.$('#startGroupBtn').click(); h.$('#startGroupBtn').click();
  await h.flush(); await h.flush();
  assert.equal(h.calls.filter(call => call.op === 'startGroupRun').length, 1);
  assert.equal(observedPending.state, 'starting');
  assert.ok(observedPending.runId);
  assert.match(h.$('#groupRunResult').textContent, /Respuesta revisada del director/);
  assert.match(h.$('#groupRunResult h3').textContent, /director/i);
  assert.doesNotMatch(h.$('#viewGroup').textContent, /raw specialist secret/);
  h.dom.window.close();
});

test('reload never resubmits a persisted run; recovery is an explicit run-list GET', async () => {
  const stored = { 'agenthub.group-runs.v1': JSON.stringify({ [group.id]: { runId: 'run_recover', groupId: group.id, state: 'running', message: 'Pendiente' } }) };
  const h = harness({ stored });
  await loaded(h); h.ui.open(group.id); await h.flush();
  assert.equal(h.calls.some(call => call.op === 'startGroupRun'), false);
  assert.equal(h.calls.some(call => call.op === 'getGroupRuns'), false);
  assert.match(h.$('#groupRunStatus').textContent, /consultar/i);
  h.$('#refreshGroupRunBtn').click(); await h.flush(); await h.flush();
  assert.equal(h.calls.filter(call => call.op === 'getGroupRuns').length, 1);
  assert.equal(h.calls.some(call => call.op === 'startGroupRun'), false);
  assert.match(h.$('#groupRunResult').textContent, /Síntesis final/);
  h.dom.window.close();
});

test('explicit status refresh discovers the latest run created on another device', async () => {
  const h = harness({ handlers: { getGroupRuns: () => ({ runs: [
    { id: 'run_other_device', groupId: group.id, state: 'completed', steps: [], text: 'Última de otro dispositivo', error: '' },
    { id: 'run_old', groupId: group.id, state: 'completed', steps: [], text: 'Anterior', error: '' }
  ] }) } });
  await loaded(h); h.ui.open(group.id);
  assert.equal(h.$('#refreshGroupRunBtn').hidden, false);
  h.$('#refreshGroupRunBtn').click(); await h.flush(); await h.flush();
  assert.match(h.$('#groupRunResult').textContent, /Última de otro dispositivo/);
  assert.match(h.w.localStorage.getItem('agenthub.group-runs.v1'), /run_other_device/);
  assert.equal(h.calls.some(call => call.op === 'startGroupRun'), false);
  h.dom.window.close();
});

test('old locally cached terminal run does not hide a newer server result', async () => {
  const h=harness({stored:{'agenthub.group-runs.v1':JSON.stringify({[group.id]:{runId:'old',state:'completed'}})},handlers:{getGroupRuns:()=>({runs:[
    {id:'new',groupId:group.id,state:'completed',steps:[],text:'Nueva consulta',error:''},
    {id:'old',groupId:group.id,state:'completed',steps:[],text:'Antigua',error:''}
  ]})}});
  await loaded(h);h.ui.open(group.id);await h.ui.refreshRunFromGesture();
  assert.match(h.$('#groupRunResult').textContent,/Nueva consulta/);
  assert.equal(h.calls.some(c=>c.op==='startGroupRun'),false);h.dom.window.close();
});

test('identity revocation during a deferred catalog reply cannot repopulate groups', async () => {
  let resolveCatalog;
  const h = harness({ handlers: { getGroupCatalog: () => new Promise(resolve => { resolveCatalog = resolve; }) } });
  const loading = h.ui.loadFromGesture(); await h.flush();
  h.ui.revoke(); resolveCatalog(catalog);
  await assert.rejects(loading);
  assert.equal(h.ui.groups.length, 0);
  assert.equal(h.$('#groupList').children.length, 0);
  assert.equal(h.$('#viewGroup').hidden, true);
  h.dom.window.close();
});

test('save success requires an exact authenticated getGroups readback', async () => {
  const h = harness(); await loaded(h); h.ui.openEditor(group.id);
  h.$('#groupName').value = 'Nombre verificado';
  h.$('#groupForm').dispatchEvent(new h.w.Event('submit', { bubbles: true, cancelable: true }));
  await h.flush(); await h.flush(); await h.flush();
  assert.deepEqual(h.calls.slice(-2).map(call => call.op), ['putGroups', 'getGroups']);
  assert.equal(h.ui.groups[0].name, 'Nombre verificado');
  assert.match(h.notices.join(' '), /guardado y verificado/i);
  h.dom.window.close();
});

test('cached terminal output is never rendered as authoritative before server readback', async () => {
  const stored = { 'agenthub.group-runs.v1': JSON.stringify({ [group.id]: { runId: 'run_cached', id: 'run_cached', groupId: group.id, state: 'completed', message: 'Anterior', text: 'Texto local no verificado', steps: [{profile:'limpatexqa',stage:'raw',status:'completed'}] } }) };
  const h = harness({ stored }); await loaded(h); h.ui.open(group.id);
  assert.doesNotMatch(h.$('#groupRunResult').textContent, /Texto local no verificado/);
  assert.equal(h.$('#groupRunResult').hidden, true);
  assert.match(h.$('#groupRunStatus').textContent, /consultar/i);
  h.dom.window.close();
});

test('definite rejected start stays not-sent and permits a new explicit submission after reload', async () => {
  const h = harness({ handlers: { startGroupRun: () => { const error = Error('Hay cambios de otro dispositivo.'); error.code = 'conflict'; error.httpStatus = 409; throw error; } } });
  await loaded(h); h.ui.open(group.id); h.$('#groupMessage').value = 'Primera'; h.$('#startGroupBtn').click();
  await h.flush(); await h.flush();
  assert.equal(h.calls.filter(call => call.op === 'startGroupRun').length, 1);
  const durable = JSON.parse(h.w.localStorage.getItem('agenthub.group-runs.v1'))[group.id];
  assert.equal(durable.state, 'failed'); assert.equal(durable.notSubmitted, true);

  const reloaded = harness({ stored: { 'agenthub.group-runs.v1': h.w.localStorage.getItem('agenthub.group-runs.v1') } });
  await loaded(reloaded); reloaded.ui.open(group.id);
  assert.equal(reloaded.calls.some(call => call.op === 'startGroupRun'), false);
  assert.equal(reloaded.$('#startGroupBtn').disabled, false);
  reloaded.$('#groupMessage').value = 'Nueva petición explícita'; reloaded.$('#startGroupBtn').click();
  await reloaded.flush(); await reloaded.flush();
  assert.equal(reloaded.calls.filter(call => call.op === 'startGroupRun').length, 1);
  h.dom.window.close(); reloaded.dom.window.close();
});

test('a started run is observed by bounded exact GETs on its existing popup lease', async () => {
  const clock = manualClock(); let polls = 0;
  const h = harness({ clock, handlers: {
    startGroupRun: args => ({ id: args.runId, groupId: args.groupId, state: 'running', steps: [], text: '', error: '' }),
    getGroupRun: args => ({ id: args.runId, groupId: group.id, state: ++polls === 2 ? 'completed' : 'running', steps: [], text: polls === 2 ? 'Resultado exacto' : '', error: '' })
  } });
  await loaded(h); const closesBefore = h.closes(); h.ui.open(group.id); h.$('#groupMessage').value = 'Observa';
  await h.ui.startFromGesture();
  assert.equal(h.closes(), closesBefore, 'the start lease stays open while observing');
  await clock.advance(20);
  assert.equal(h.calls.filter(call => call.op === 'getGroupRun').length, 2);
  assert.equal(h.calls.filter(call => call.op === 'openVoice').length, 2, 'timers never open a popup');
  assert.equal(h.calls.some(call => call.op === 'getGroupRuns'), false);
  assert.match(h.$('#groupRunResult [data-output]').textContent, /Resultado exacto/);
  assert.equal(h.closes(), closesBefore + 1);
  assert.equal(clock.pending(), 0);
  h.dom.window.close();
});

test('automatic observation is bounded and stops on hide, revoke, visibility, navigation, or voice start', async () => {
  for (const stop of ['hide', 'revoke', 'hidden', 'navigation', 'voice']) {
    const clock = manualClock(); let voiceBusy = false;
    const h = harness({ clock, isVoiceBusy: () => voiceBusy, handlers: {
      startGroupRun: args => ({ id: args.runId, groupId: args.groupId, state: 'running', steps: [], text: '', error: '' }),
      getGroupRun: args => ({ id: args.runId, groupId: group.id, state: 'running', steps: [], text: '', error: '' })
    } });
    await loaded(h); h.ui.open(group.id); h.$('#groupMessage').value = stop; await h.ui.startFromGesture();
    if (stop === 'hide') h.ui.hideDetail();
    if (stop === 'revoke') h.ui.revoke();
    if (stop === 'hidden') { Object.defineProperty(h.w.document, 'visibilityState', { configurable: true, value: 'hidden' }); h.w.document.dispatchEvent(new h.w.Event('visibilitychange')); }
    if (stop === 'navigation') h.w.dispatchEvent(new h.w.Event('pagehide'));
    if (stop === 'voice') voiceBusy = true;
    await clock.advance(stop === 'voice' ? 10 : 60);
    assert.equal(h.calls.filter(call => call.op === 'getGroupRun').length, 0, stop + ' must stop before another GET');
    assert.equal(clock.pending(), 0, stop + ' must clear its timer');
    h.dom.window.close();
  }

  const clock = manualClock();
  const bounded = harness({ clock, handlers: {
    startGroupRun: args => ({ id: args.runId, groupId: args.groupId, state: 'running', steps: [], text: '', error: '' }),
    getGroupRun: args => ({ id: args.runId, groupId: group.id, state: 'running', steps: [], text: '', error: '' })
  } });
  await loaded(bounded); bounded.ui.open(group.id); bounded.$('#groupMessage').value = 'Límite'; await bounded.ui.startFromGesture();
  await clock.advance(100);
  assert.ok(bounded.calls.filter(call => call.op === 'getGroupRun').length <= 5);
  assert.equal(clock.pending(), 0);
  bounded.dom.window.close();
});

test('verified latest-20 history is selectable without replacing the current pending run', async () => {
  const pending = { runId: 'run_pending', id: 'run_pending', groupId: group.id, state: 'running', message: 'Actual', steps: [], text: '', error: '' };
  const runs = Array.from({ length: 20 }, (_, i) => ({ id: 'run_' + i, groupId: group.id, state: 'completed', steps: [], text: 'Salida exacta ' + i, error: '' }));
  const h = harness({ stored: { 'agenthub.group-runs.v1': JSON.stringify({ [group.id]: pending }) }, handlers: {
    getGroupRuns: () => ({ runs }),
    getGroupRun: args => ({ id: args.runId, groupId: group.id, state: 'running', steps: [], text: '', error: '' })
  } });
  await loaded(h); h.ui.open(group.id); await h.ui.refreshRunFromGesture();
  const buttons = [...h.w.document.querySelectorAll('#groupRunHistory button')];
  assert.equal(buttons.length, 20);
  buttons[7].click();
  assert.match(h.$('#groupRunResult [data-output]').textContent, /Salida exacta 7/);
  assert.equal(h.ui.runs[group.id].runId, 'run_pending');
  assert.equal(h.$('#startGroupBtn').disabled, true, 'older terminal history cannot enable a duplicate submit');
  assert.equal(h.calls.some(call => call.op === 'startGroupRun'), false);
  h.dom.window.close();
});

test('verified output uses AgentHubContent when available and keeps the result paragraph boundary', async () => {
  const rendered = [];
  const h = harness({ content: { render: (container, text, options) => { rendered.push({ container, text, options }); container.textContent = 'content:' + text; } } });
  await loaded(h); h.ui.open(group.id); await h.ui.refreshRunFromGesture();
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].container, h.$('#groupRunResult [data-output]'));
  assert.equal(rendered[0].text, 'Síntesis final');
  assert.equal(typeof rendered[0].options.notify, 'function');
  assert.match(h.$('#groupRunResult [data-output]').textContent, /content:Síntesis final/);
  h.dom.window.close();
});

test('foreground work pauses observation and its deadline cannot close an active write lease', async () => {
 const clock=manualClock();let resolveWork;
 const h=harness({clock});await loaded(h);h.ui.open(group.id);h.$('#groupMessage').value='Test';await h.ui.startFromGesture();
 const work=h.ui._withGesture(()=>new Promise(resolve=>{resolveWork=resolve;}));await h.flush();
 const closes=h.closes();await clock.advance(100);
 assert.equal(h.calls.filter(c=>c.op==='getGroupRun').length,0);
 assert.equal(h.closes(),closes);resolveWork();await work;
 assert.equal(h.ui.observation,null);h.dom.window.close();
});

test('viewing an old verified result remains stable while the current run is observed',async()=>{
 const clock=manualClock();
 const pending={id:'pending',runId:'pending',groupId:group.id,state:'running'};
 const h=harness({clock,stored:{'agenthub.group-runs.v1':JSON.stringify({[group.id]:pending})},handlers:{
  getGroupRuns:()=>({runs:[{...pending,steps:[],text:''},{id:'older',groupId:group.id,state:'completed',steps:[],text:'Keep old selected'}]}),
  getGroupRun:args=>({id:args.runId,groupId:group.id,state:'running',steps:[],text:''})
 }});
 await loaded(h);h.ui.open(group.id);await h.ui.refreshRunFromGesture();
 [...h.w.document.querySelectorAll('#groupRunHistory button')][1].click();await clock.advance(10);
 assert.equal(h.$('#groupRunResult').hidden,false);
 assert.match(h.$('#groupRunResult').textContent,/Keep old selected/);
 assert.equal(h.ui.runs[group.id].runId,'pending');assert.equal(h.$('#startGroupBtn').disabled,true);
 h.dom.window.close();
});

test('a stale poll reply cannot stop or close a newer observation lease', async () => {
  const clock = manualClock(); let oldRunId, resolveOld;
  const h = harness({ clock, handlers: {
    startGroupRun: args => { oldRunId = args.runId; return { id: args.runId, groupId: group.id, state: 'running', steps: [], text: '', error: '' }; },
    getGroupRuns: () => ({ runs: [{ id: 'run_new', groupId: group.id, state: 'running', steps: [], text: '', error: '' }] }),
    getGroupRun: args => args.runId === oldRunId
      ? new Promise(resolve => { resolveOld = resolve; })
      : ({ id: args.runId, groupId: group.id, state: 'running', steps: [], text: '', error: '' })
  } });
  await loaded(h); h.ui.open(group.id); h.$('#groupMessage').value = 'Vieja'; await h.ui.startFromGesture();
  await clock.advance(10);
  assert.equal(typeof resolveOld, 'function');
  h.ui.hideDetail(); h.ui.open(group.id);
  h.ui.runs[group.id] = { runId: 'run_new', id: 'run_new', groupId: group.id, state: 'running', steps: [], text: '', error: '' };
  await h.ui.refreshRunFromGesture();
  const closes = h.closes();
  resolveOld({ id: oldRunId, groupId: group.id, state: 'completed', steps: [], text: 'Salida obsoleta', error: '' });
  await h.flush();
  assert.equal(h.ui.observation.runId, 'run_new');
  assert.equal(h.closes(), closes);
  assert.doesNotMatch(h.$('#groupRunResult').textContent, /Salida obsoleta/);
  h.ui.hideDetail(); h.dom.window.close();
});
