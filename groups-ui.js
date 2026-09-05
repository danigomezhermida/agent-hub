(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgentGroups = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DIRECTOR = 'limpatexdev-cloud';
  var RUNS_KEY = 'agenthub.group-runs.v1';
  var TERMINAL_STATES = new Set(['completed', 'failed']);
  var RUN_STATES = new Set(['running', 'completed', 'failed', 'uncertain']);
  var ID = /^[A-Za-z0-9_-]{1,128}$/;

  function copy(value) {
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function validCatalog(value) {
    if (!value || typeof value !== 'object' || !value.director || value.director.id !== DIRECTOR ||
        typeof value.director.label !== 'string' || typeof value.director.available !== 'boolean' ||
        !Array.isArray(value.specialists)) throw new Error('Hermes no devolvió un director válido en el catálogo real.');
    var seen = new Set();
    value.specialists.forEach(function (profile) {
      if (!profile || !ID.test(profile.id) || !profile.label || typeof profile.available !== 'boolean' || seen.has(profile.id)) {
        throw new Error('Hermes devolvió un catálogo de grupos no válido.');
      }
      seen.add(profile.id);
    });
    return copy(value);
  }

  function validGroups(value) {
    if (!value || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.groups)) {
      throw new Error('Hermes devolvió una lista de grupos no válida.');
    }
    value.groups.forEach(function (group) {
      if (!group || !ID.test(group.id) || typeof group.name !== 'string' || !group.name.trim() ||
          group.director !== DIRECTOR || !Array.isArray(group.members) || !group.members.length ||
          typeof group.objective !== 'string' || !group.objective.trim()) {
        throw new Error('Hermes devolvió una configuración de grupo no válida.');
      }
    });
    return { revision: value.revision, groups: copy(value.groups) };
  }

  function validRun(value, expectedRunId, expectedGroupId) {
    if (!value || !ID.test(value.id || '') || value.id !== expectedRunId || value.groupId !== expectedGroupId || !RUN_STATES.has(value.state) || !Array.isArray(value.steps)) {
      throw new Error('Hermes devolvió un estado de ejecución no válido.');
    }
    return {
      id: value.id,
      groupId: value.groupId,
      state: value.state,
      message: typeof value.message === 'string' ? value.message : '',
      steps: value.steps.filter(function (step) {
        return step && typeof step.profile === 'string' && typeof step.stage === 'string' && typeof step.status === 'string';
      }).map(function (step) { return { profile: step.profile, stage: step.stage, status: step.status }; }),
      text: typeof value.text === 'string' ? value.text : '',
      error: typeof value.error === 'string' ? value.error : ''
    };
  }

  function validRunList(value, expectedGroupId) {
    if (!value || !Array.isArray(value.runs) || value.runs.length > 20) throw new Error('Hermes devolvió un historial de ejecuciones no válido.');
    return value.runs.map(function (run) { return validRun(run, run?.id, expectedGroupId); });
  }

  function GroupUI(options) {
    options = options || {};
    this.window = options.window || window;
    this.document = options.document || this.window.document;
    this.transport = options.transport;
    if (!this.transport || typeof this.transport.storage !== 'function') throw new Error('Group UI requires the authenticated storage transport.');
    this.notify = options.notify || function () {};
    this.onOpen = options.onOpen || function () {};
    this.onCount = options.onCount || function () {};
    this.isVoiceBusy = options.isVoiceBusy || function () { return false; };
    this._now = options.now || Date.now;
    this._setTimer = options.setTimer || this.window.setTimeout.bind(this.window);
    this._clearTimer = options.clearTimer || this.window.clearTimeout.bind(this.window);
    this.observationIntervalMs = Math.max(1, Number(options.observationIntervalMs) || 3000);
    this.observationMaxMs = Math.min(600000, Math.max(1, Number(options.observationMaxMs) || 600000));
    this.groups = [];
    this.revision = null;
    this.catalog = null;
    this.activeId = null;
    this.editingId = null;
    this.loaded = false;
    this.operationBusy = false;
    this.generation = 0;
    this.leaseSequence = 0;
    this.leaseOwner = null;
    this.observationSequence = 0;
    this.observation = null;
    this.histories = {};
    this.selectedHistoryId = null;
    this.runs = this._readRuns();
    this._bind();
    this.revoke();
  }

  GroupUI.prototype._el = function (selector) { return this.document.querySelector(selector); };
  GroupUI.prototype._readRuns = function () {
    try {
      var value = JSON.parse(this.window.localStorage.getItem(RUNS_KEY) || '{}');
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      var safe = {};
      Object.keys(value).forEach(function (groupId) {
        var record = value[groupId], runId = record && (record.runId || record.id);
        if (!ID.test(groupId) || !ID.test(runId || '')) return;
        var notSubmitted = record.notSubmitted === true && record.state === 'failed';
        var cachedTerminal = TERMINAL_STATES.has(record.state) && !notSubmitted;
        safe[groupId] = { runId: runId, id: runId, groupId: groupId, state: notSubmitted ? 'failed' : 'uncertain', notSubmitted: notSubmitted, cachedTerminal: cachedTerminal, message: typeof record.message === 'string' ? record.message : '', steps: [], text: '', error: '' };
      });
      return safe;
    } catch (_) { return {}; }
  };
  GroupUI.prototype._writeRuns = function () {
    this.window.localStorage.setItem(RUNS_KEY, JSON.stringify(this.runs));
  };
  GroupUI.prototype._assertOwner = function () {
    if (typeof this.transport.ownerScope !== 'function' || this.transport.ownerScope() !== 'personal') {
      this.revoke();
      var error = new Error('Sincroniza con la cuenta personal verificada para usar grupos.');
      error.code = 'owner_unverified';
      throw error;
    }
  };
  GroupUI.prototype._assertFence = function (generation) {
    if (this.generation !== generation || this.transport.ownerScope?.() !== 'personal') {
      var error = new Error('La identidad cambió durante la operación. Vuelve a sincronizar.');
      error.code = 'stale_identity';
      throw error;
    }
  };
  GroupUI.prototype._setBusy = function (value) {
    this.operationBusy = value;
    this._renderControls();
  };
  GroupUI.prototype._withGesture = function (operation) {
    if (this.operationBusy) return Promise.reject(new Error('Espera a que termine la operación anterior.'));
    this._assertOwner();
    if (this.observation?.polling) return Promise.reject(new Error('Espera a que termine la consulta de estado.'));
    this._stopObservation(false);
    var opened;
    try { opened = this.transport.openVoice(); }
    catch (error) {
      if (!this.observation) this._closeLease(this.leaseOwner);
      return Promise.reject(error);
    }
    this._setBusy(true);
    var self = this, generation = this.generation, leaseId = ++this.leaseSequence;
    this.leaseOwner = leaseId;
    if (this.observation) this.observation.leaseId = leaseId;
    var fence = function () { self._assertFence(generation); };
    return Promise.resolve(opened).then(function () {
      fence();
      return operation(fence, leaseId);
    }).finally(function () {
      if (self.generation !== generation) return;
      self._setBusy(false);
      if (!self.observation || self.observation.leaseId !== leaseId) self._closeLease(leaseId);
    });
  };
  GroupUI.prototype._closeLease = function (leaseId) {
    if (leaseId == null || this.leaseOwner !== leaseId) return;
    this.leaseOwner = null;
    if (!this.isVoiceBusy()) this.transport.closeVoice?.();
  };
  GroupUI.prototype.pauseObservation = function () { this._stopObservation(true); };
  GroupUI.prototype._stopObservation = function (closeLease) {
    var observation = this.observation;
    if (!observation) return;
    this.observation = null;
    if (observation.timer != null) this._clearTimer(observation.timer);
    if (observation.deadlineTimer != null) this._clearTimer(observation.deadlineTimer);
    if (closeLease !== false) this._closeLease(observation.leaseId);
    this._renderControls();
  };
  GroupUI.prototype._observationInvalid = function (observation) {
    return this.observation !== observation || this.generation !== observation.generation ||
      this.activeId !== observation.groupId || this.transport.ownerScope?.() !== 'personal' ||
      this.document.visibilityState === 'hidden' || this.isVoiceBusy() || this._now() >= observation.deadline;
  };
  GroupUI.prototype._scheduleObservation = function (observation) {
    var self = this;
    if (this.observation !== observation) return;
    if (this._observationInvalid(observation)) {
      this._stopObservation(!this.isVoiceBusy());
      return;
    }
    var delay = Math.min(this.observationIntervalMs, observation.deadline - this._now());
    observation.timer = this._setTimer(function () { self._pollObservation(observation); }, delay);
  };
  GroupUI.prototype._beginObservation = function (run, leaseId) {
    if (!run || TERMINAL_STATES.has(run.state) || this.activeId !== run.groupId) return false;
    this._stopObservation(false);
    var observation = {
      id: ++this.observationSequence,
      runId: run.id,
      groupId: run.groupId,
      generation: this.generation,
      leaseId: leaseId,
      deadline: this._now() + this.observationMaxMs,
      timer: null,
      deadlineTimer: null
    };
    this.leaseOwner = leaseId;
    this.observation = observation;
    var self = this;
    observation.deadlineTimer = this._setTimer(function () {
      if (self.observation === observation) self._stopObservation(!self.isVoiceBusy());
    }, this.observationMaxMs);
    this._scheduleObservation(observation);
    this._renderControls();
    return true;
  };
  GroupUI.prototype._pollObservation = async function (observation) {
    observation.timer = null;
    if (this.observation !== observation) return;
    if (this._observationInvalid(observation)) { this._stopObservation(!this.isVoiceBusy()); return; }
    if (this.operationBusy) { this._scheduleObservation(observation); return; }
    observation.polling = true; this._renderControls();
    try {
      // Deliberately READ-ONLY: timers reuse the authorized lease and never open
      // a popup or replay startGroupRun.
      var reply = await this.transport.storage('getGroupRun', { runId: observation.runId });
      if (this.observation !== observation) return;
      if (this._observationInvalid(observation)) { this._stopObservation(!this.isVoiceBusy()); return; }
      var run = validRun(reply, observation.runId, observation.groupId);
      var current = this.runs[observation.groupId];
      if (!current || (current.runId || current.id) !== observation.runId) { this._stopObservation(true); return; }
      this._persistRun(Object.assign({ runId: run.id, message: current.message || '' }, run));
      if (TERMINAL_STATES.has(run.state)) this._stopObservation(true);
      else this._scheduleObservation(observation);
    } catch (error) {
      if (this.observation === observation) {
        this._stopObservation(true);
        this._report(error);
      }
    } finally {
      observation.polling = false; this._renderControls();
    }
  };
  GroupUI.prototype._report = function (error, target) {
    var message = error && error.code === 'conflict'
      ? 'Hay cambios de otro dispositivo. No se ha sobrescrito nada; recarga los grupos antes de guardar.'
      : (error && error.message) || 'No se pudo completar la operación de grupos.';
    if (target) target.textContent = message;
    this.notify(message);
    return error;
  };

  GroupUI.prototype._bind = function () {
    var self = this;
    this._el('#newGroupBtn')?.addEventListener('click', function () {
      if (self.catalog && self.loaded) self.openEditor();
      else self.loadFromGesture().then(function () { self.openEditor(); }).catch(function () {});
    });
    this._el('#reloadGroupsBtn')?.addEventListener('click', function () { self.loadFromGesture().catch(function () {}); });
    this._el('#editGroupBtn')?.addEventListener('click', function () { self.openEditor(self.activeId); });
    this._el('#cancelGroupBtn')?.addEventListener('click', function () { self.closeEditor(); });
    this._el('#groupDialog')?.addEventListener('click', function (event) { if (event.target === event.currentTarget) self.closeEditor(); });
    this._el('#groupForm')?.addEventListener('submit', function (event) {
      event.preventDefault();
      self._saveEditorFromGesture().catch(function () {});
    });
    this._el('#startGroupBtn')?.addEventListener('click', function () { self.startFromGesture().catch(function () {}); });
    this._el('#refreshGroupRunBtn')?.addEventListener('click', function () { self.refreshRunFromGesture().catch(function () {}); });
    this.document.addEventListener('visibilitychange', function () {
      if (self.document.visibilityState === 'hidden') self._stopObservation(!self.isVoiceBusy());
    });
    this.window.addEventListener('pagehide', function () { self._stopObservation(!self.isVoiceBusy()); });
    this.window.addEventListener('hashchange', function () {
      if (self.observation && self.window.location.hash !== '#group=' + self.observation.groupId) self._stopObservation(!self.isVoiceBusy());
    });
  };

  GroupUI.prototype.loadWithinLease = async function () {
    this._assertOwner();
    var generation = this.generation, self = this;
    var fence = function () { self._assertFence(generation); };
    var status = this._el('#groupsStatus');
    if (status) status.textContent = 'Consultando catálogo real y grupos…';
    try {
      var catalogReply = await this.transport.storage('getGroupCatalog', {}); fence();
      var catalog = validCatalog(catalogReply);
      var groupsReply = await this.transport.storage('getGroups', {}); fence();
      var state = validGroups(groupsReply);
      fence();
      this.catalog = catalog;
      this.revision = state.revision;
      this.groups = state.groups;
      this.loaded = true;
      if (status) status.textContent = this.groups.length ? this.groups.length + ' grupo(s) sincronizado(s).' : 'No hay grupos creados.';
      this.renderList();
      this.onCount(this.groups.length);
      if (this.activeId && this.groups.some(function (group) { return group.id === this.activeId; }, this)) this.open(this.activeId);
      return copy(state);
    } catch (error) {
      if (error?.code === 'stale_identity') throw error;
      this.catalog = null;
      this.revision = null;
      this.groups = [];
      this.loaded = false;
      this.activeId = null;
      this.renderList();
      this.hideDetail();
      this.onCount(0);
      if (status) status.textContent = 'No se pudo validar el catálogo real de grupos.';
      this._report(error);
      throw error;
    }
  };
  GroupUI.prototype.loadFromGesture = function () {
    var self = this;
    return this._withGesture(function () { return self.loadWithinLease(); });
  };

  GroupUI.prototype.renderList = function (filter) {
    var self = this, list = this._el('#groupList');
    if (!list) return;
    var query = String(filter || '').toLowerCase();
    list.textContent = '';
    if (!this.loaded || this.transport.ownerScope?.() !== 'personal') return;
    this.groups.forEach(function (group) {
      if (query && !(group.name + ' ' + group.objective).toLowerCase().includes(query)) return;
      var item = self.document.createElement('li');
      var button = self.document.createElement('button');
      button.type = 'button';
      button.textContent = group.name;
      if (group.id === self.activeId) button.classList.add('active');
      button.addEventListener('click', function () { self.open(group.id); });
      item.appendChild(button); list.appendChild(item);
    });
    this._renderControls();
  };
  GroupUI.prototype.getGroupCount = function () { return this.loaded ? this.groups.length : 0; };
  GroupUI.prototype._profile = function (id) {
    if (!this.catalog) return null;
    if (this.catalog.director.id === id) return this.catalog.director;
    return this.catalog.specialists.find(function (profile) { return profile.id === id; }) || null;
  };
  GroupUI.prototype._groupIssue = function (group) {
    if (!this.catalog || !this.catalog.director.available) return 'El director no está disponible en el catálogo verificado.';
    for (var i = 0; i < group.members.length; i += 1) {
      var profile = this._profile(group.members[i]);
      if (!profile) return 'El miembro ' + group.members[i] + ' ya no figura en el catálogo oficial.';
      if (!profile.available) return 'El miembro ' + profile.label + ' no está disponible ahora.';
    }
    return '';
  };
  GroupUI.prototype.open = function (groupId) {
    if (!this.loaded || this.transport.ownerScope?.() !== 'personal') return false;
    var group = this.groups.find(function (candidate) { return candidate.id === groupId; });
    if (!group) return false;
    if (this.activeId && this.activeId !== groupId) this._stopObservation(!this.isVoiceBusy());
    if (this.activeId !== groupId) this.selectedHistoryId = null;
    this.activeId = groupId;
    this._el('#groupTitle').textContent = group.name;
    this._el('#groupObjective').textContent = group.objective;
    var members = this._el('#groupMembers'); members.textContent = '';
    var director = this.document.createElement('p');
    director.textContent = (this._profile(DIRECTOR)?.label || DIRECTOR) + ' · director';
    members.appendChild(director);
    group.members.forEach(function (id) {
      var row = this.document.createElement('p'), profile = this._profile(id);
      row.textContent = (profile?.label || id) + ' · especialista';
      members.appendChild(row);
    }, this);
    var issue = this._groupIssue(group);
    this._el('#groupNotice').textContent = issue || 'Cada ejecución es una consulta independiente: no hereda el contexto de un chat. Solo análisis y propuestas; las herramientas están deshabilitadas en servidor. Cerrar la ventana de Hermes o desconectar no cancela un cálculo ya aceptado. Consultar el estado es seguro y nunca reenvía la petición.';
    this._el('#viewGroup').hidden = false;
    this.onOpen(group);
    this.renderList();
    this._renderHistory(this.histories[groupId] || []);
    this._renderRun(this.runs[groupId] || null);
    this._renderControls();
    return true;
  };
  GroupUI.prototype.hideDetail = function () {
    this._stopObservation(!this.isVoiceBusy());
    var view = this._el('#viewGroup'); if (view) view.hidden = true;
    this.activeId = null;
    this.renderList();
  };
  GroupUI.prototype.revoke = function () {
    this._stopObservation(!this.isVoiceBusy());
    this._closeLease(this.leaseOwner);
    this.generation += 1;
    this.operationBusy = false;
    this.runs = this._readRuns();
    this.groups = [];
    this.revision = null;
    this.catalog = null;
    this.loaded = false;
    this.activeId = null;
    this.editingId = null;
    this.histories = {};
    this.selectedHistoryId = null;
    this._el('#groupRunHistory')?.remove();
    this._el('#groupObservationStatus')?.remove();
    this._el('#groupList')?.replaceChildren();
    if (this._el('#viewGroup')) this._el('#viewGroup').hidden = true;
    if (this._el('#groupDialog')) this._el('#groupDialog').hidden = true;
    if (this._el('#groupsStatus')) this._el('#groupsStatus').textContent = 'Sincroniza para cargar grupos reales.';
    this.onCount(0);
    this._renderControls();
  };

  GroupUI.prototype.openEditor = function (groupId) {
    if (!this.loaded || !this.catalog) return false;
    var group = groupId ? this.groups.find(function (candidate) { return candidate.id === groupId; }) : null;
    if (groupId && !group) return false;
    this.editingId = group?.id || null;
    this._el('#groupFormTitle').textContent = group ? 'Editar grupo' : 'Crear grupo';
    this._el('#groupName').value = group?.name || '';
    this._el('#groupObjectiveInput').value = group?.objective || '';
    this._el('#groupDirector').textContent = this.catalog.director.label + ' · director fijo' + (this.catalog.director.available ? '' : ' · no disponible');
    this._el('#groupFormError').textContent = '';
    var choices = this._el('#groupMemberChoices'); choices.textContent = '';
    this.catalog.specialists.forEach(function (profile) {
      var label = this.document.createElement('label');
      var input = this.document.createElement('input');
      input.type = 'checkbox'; input.name = 'groupMember'; input.value = profile.id;
      input.checked = Boolean(group?.members.includes(profile.id));
      input.disabled = !profile.available;
      label.append(input, this.document.createTextNode(' ' + profile.label + (profile.available ? '' : ' · no disponible')));
      choices.appendChild(label);
    }, this);
    if (group) group.members.filter(function (id) { return !this._profile(id); }, this).forEach(function (id) {
      var warning = this.document.createElement('p'); warning.setAttribute('role', 'alert');
      warning.textContent = 'Miembro fuera del catálogo: ' + id; choices.appendChild(warning);
    }, this);
    this._el('#groupDialog').hidden = false;
    this._renderControls();
    return true;
  };
  GroupUI.prototype.closeEditor = function () {
    this.editingId = null;
    if (this._el('#groupDialog')) this._el('#groupDialog').hidden = true;
    if (this._el('#groupFormError')) this._el('#groupFormError').textContent = '';
  };
  GroupUI.prototype._editorValue = function () {
    var name = this._el('#groupName').value.trim();
    var objective = this._el('#groupObjectiveInput').value.trim();
    var members = Array.from(this.document.querySelectorAll('input[name="groupMember"]:checked:not(:disabled)')).map(function (input) { return input.value; });
    if (!this.catalog?.director.available) throw new Error('El director no está disponible.');
    if (!name || name.length > 120) throw new Error('Escribe un nombre de hasta 120 caracteres.');
    if (!objective || objective.length > 2000) throw new Error('Escribe un objetivo de hasta 2000 caracteres.');
    if (!members.length) throw new Error('Selecciona al menos un especialista disponible.');
    var current = this.editingId ? this.groups.find(function (group) { return group.id === this.editingId; }, this) : null;
    if (current && current.members.some(function (id) { return !this._profile(id); }, this)) throw new Error('El grupo contiene un miembro que ya no está en el catálogo.');
    return { id: current?.id || ('group_' + this.window.crypto.randomUUID()), name: name, director: DIRECTOR, members: members, objective: objective };
  };
  GroupUI.prototype._saveEditorFromGesture = function () {
    var candidate, errorBox = this._el('#groupFormError');
    try { candidate = this._editorValue(); }
    catch (error) { this._report(error, errorBox); return Promise.reject(error); }
    var next = this.groups.map(function (group) { return copy(group); });
    var index = next.findIndex(function (group) { return group.id === candidate.id; });
    if (index < 0) next.unshift(candidate); else next[index] = candidate;
    var self = this;
    return this._withGesture(async function (fence) {
      var written, readback;
      try {
        var writeReply = await self.transport.storage('putGroups', { expectedRevision: self.revision, groups: next }); fence();
        written = validGroups(writeReply);
        var readReply = await self.transport.storage('getGroups', {}); fence();
        readback = validGroups(readReply);
        if (readback.revision !== written.revision || JSON.stringify(readback.groups) !== JSON.stringify(next)) {
          var superseded = new Error('La configuración cambió antes de poder verificarla. Recarga los grupos.');
          superseded.code = 'conflict';
          throw superseded;
        }
      } catch (error) { self._report(error, errorBox); throw error; }
      fence();
      self.revision = readback.revision;
      self.groups = readback.groups;
      self.loaded = true;
      self.closeEditor();
      self.renderList(); self.onCount(self.groups.length); self.open(candidate.id);
      fence(); self.notify('Grupo guardado y verificado en Hermes.');
      return copy(candidate);
    });
  };

  GroupUI.prototype._activeGroup = function () {
    return this.groups.find(function (group) { return group.id === this.activeId; }, this) || null;
  };
  GroupUI.prototype._renderControls = function () {
    var owner = this.transport.ownerScope?.() === 'personal';
    var group = this._activeGroup();
    var issue = group ? this._groupIssue(group) : 'Sin grupo activo.';
    var pending = group ? this.runs[group.id] : null;
    var blocksStart = pending && !TERMINAL_STATES.has(pending.state);
    var polling = Boolean(this.observation?.polling), self = this;
    if (group) {
      var note = this._el('#groupObservationStatus');
      if (!note) { note = this.document.createElement('p'); note.id = 'groupObservationStatus'; note.setAttribute('role','status'); this._el('#groupRunStatus')?.after(note); }
      var wording = this.observation ? 'Seguimiento automático activo (máximo 10 minutos). No se reenvía la consulta.' : blocksStart ? 'Seguimiento pausado. Pulsa Consultar estado para continuar; no se reenvía la consulta.' : '';
      if (note.textContent !== wording) note.textContent = wording;
      var currentButton = this._el('#groupRunCurrent');
      if (!currentButton) {
        currentButton = this.document.createElement('button'); currentButton.id = 'groupRunCurrent'; currentButton.type = 'button'; currentButton.className = 'secondary-btn'; currentButton.textContent = 'Ver consulta actual'; note.after(currentButton);
        currentButton.onclick = function () { self.selectedHistoryId = null; self._renderRun(self.runs[self.activeId]); self._renderHistory(self.histories[self.activeId] || []); };
      }
      currentButton.hidden = !this.selectedHistoryId;
    }
    // A foreground gesture cannot overlap an exact-state GET on the shared bridge.
    this.document.querySelectorAll('#newGroupBtn,#reloadGroupsBtn,#editGroupBtn,#saveGroupBtn,#startGroupBtn,#refreshGroupRunBtn').forEach(function(button) { button.dataset.polling = String(polling); });
    if (this._el('#newGroupBtn')) this._el('#newGroupBtn').disabled = !owner || (this.operationBusy || polling);
    if (this._el('#reloadGroupsBtn')) this._el('#reloadGroupsBtn').disabled = !owner || (this.operationBusy || polling);
    if (this._el('#editGroupBtn')) this._el('#editGroupBtn').disabled = !group || (this.operationBusy || polling);
    if (this._el('#saveGroupBtn')) this._el('#saveGroupBtn').disabled = (this.operationBusy || polling);
    if (this._el('#startGroupBtn')) this._el('#startGroupBtn').disabled = !group || Boolean(issue) || Boolean(blocksStart) || (this.operationBusy || polling);
    if (this._el('#refreshGroupRunBtn')) {
      this._el('#refreshGroupRunBtn').hidden = !group;
      this._el('#refreshGroupRunBtn').disabled = !group || (this.operationBusy || polling);
    }
  };
  GroupUI.prototype._persistRun = function (record) {
    this.runs[record.groupId] = copy(record);
    this._writeRuns();
    if (!this.selectedHistoryId || this.selectedHistoryId === record.id) this._renderRun(record);
    this._renderControls();
  };
  GroupUI.prototype._historyRoot = function () {
    var view = this._el('#viewGroup');
    if (!view) return null;
    var section = this._el('#groupRunHistory');
    if (section) return section;
    section = this.document.createElement('section');
    section.id = 'groupRunHistory';
    var title = this.document.createElement('h3'); title.textContent = 'Historial verificado';
    var list = this.document.createElement('ol');
    section.append(title, list); view.appendChild(section);
    return section;
  };
  GroupUI.prototype._renderHistory = function (runs) {
    var self = this, section = this._historyRoot();
    if (!section) return;
    var list = section.querySelector('ol'); list.textContent = '';
    runs.slice(0, 20).forEach(function (run) {
      var item = self.document.createElement('li'), button = self.document.createElement('button');
      button.type = 'button';
      var labels = { completed: 'Completada', failed: 'Error', running: 'En curso', uncertain: 'Por confirmar' };
      button.textContent = (run.message || run.id).slice(0,120) + ' · ' + labels[run.state];
      button.title = run.id;
      button.setAttribute('aria-pressed', String(self.selectedHistoryId === run.id));
      button.addEventListener('click', function () { self.selectedHistoryId = run.id; self._renderHistory(runs); self._renderRun(run); });
      item.appendChild(button); list.appendChild(item);
    });
    section.hidden = runs.length === 0;
  };
  GroupUI.prototype._renderVerifiedText = function (container, text) {
    var renderer = this.window.AgentHubContent && this.window.AgentHubContent.render;
    if (typeof renderer === 'function') {
      try { renderer(container, text, { notify: this.notify }); return; }
      catch (_) {}
    }
    container.textContent = text;
  };
  GroupUI.prototype._renderRun = function (run) {
    var status = this._el('#groupRunStatus'), steps = this._el('#groupRunSteps'), result = this._el('#groupRunResult');
    if (!status || !steps || !result) return;
    steps.textContent = ''; result.hidden = true;
    var output = result.querySelector('[data-output]') || result.querySelector('p');
    if (!output) return;
    output.replaceChildren();
    if (!run) { status.textContent = 'Sin ejecuciones para este grupo.'; this._renderControls(); return; }
    var labels = { starting: 'Ejecución preparada. Si recargaste, pulsa Consultar estado; no se reenviará.', running: 'Ejecución en curso.', completed: 'Ejecución completada.', failed: run.notSubmitted ? 'La petición no fue aceptada por Hermes. Recarga la configuración antes de iniciar una petición nueva.' : 'Ejecución fallida.', uncertain: 'Resultado sin confirmar. Pulsa Consultar estado; no se reenviará.' };
    status.textContent = labels[run.state] || 'Estado pendiente. Pulsa Consultar estado.';
    (run.steps || []).forEach(function (step) {
      var item = this.document.createElement('li');
      var profile = this._profile(step.profile);
      item.textContent = (profile?.label || step.profile) + ': ' + step.stage + ' · ' + step.status;
      steps.appendChild(item);
    }, this);
    if (run.state === 'completed') {
      result.hidden = false;
      result.querySelector('h3').textContent = 'Resultado final del director';
      this._renderVerifiedText(result.querySelector('[data-output]') || result.querySelector('p'), run.text || 'El director terminó sin texto.');
    } else if (run.state === 'failed' && run.error) {
      result.hidden = false;
      result.querySelector('h3').textContent = 'Error seguro de ejecución';
      this._renderVerifiedText(result.querySelector('[data-output]') || result.querySelector('p'), run.error);
    }
    this._renderControls();
  };
  GroupUI.prototype.startFromGesture = function () {
    var group = this._activeGroup(), input = this._el('#groupMessage');
    if (!group) return Promise.reject(new Error('Selecciona un grupo.'));
    var message = String(input?.value || '').trim();
    if (!message || message.length > 12000) {
      var invalid = new Error('Escribe un mensaje de hasta 12000 caracteres.'); this._report(invalid); return Promise.reject(invalid);
    }
    var issue = this._groupIssue(group);
    if (issue) { var unavailable = new Error(issue); this._report(unavailable); return Promise.reject(unavailable); }
    var previous = this.runs[group.id];
    if (previous && !TERMINAL_STATES.has(previous.state)) {
      var duplicate = new Error('Ya hay una ejecución pendiente. Consulta su estado; no se enviará otra.'); this._report(duplicate); return Promise.reject(duplicate);
    }
    var self = this;
    return this._withGesture(async function (fence, leaseId) {
      var runId = 'run_' + self.window.crypto.randomUUID();
      var pending = { runId: runId, id: runId, groupId: group.id, state: 'starting', message: message, steps: [], text: '', error: '' };
      try { self._persistRun(pending); }
      catch (error) { self._report(new Error('No se pudo guardar el identificador de ejecución. No se ha enviado nada.')); throw error; }
      try {
        var runReply = await self.transport.storage('startGroupRun', { groupId: group.id, runId: runId, message: message, expectedRevision: self.revision }); fence();
        var run = validRun(runReply, runId, group.id);
        fence();
        self._persistRun(Object.assign({ runId: run.id, message: message }, run));
        if (input) input.value = '';
        self._beginObservation(run, leaseId);
        return copy(run);
      } catch (error) {
        var definite = [400, 401, 403, 404, 409, 422].includes(error.httpStatus);
        pending.state = definite ? 'failed' : 'uncertain'; pending.notSubmitted = definite; pending.error = '';
        try { self._persistRun(pending); } catch (_) {}
        self._report(error);
        throw error;
      }
    });
  };
  GroupUI.prototype.refreshRunFromGesture = function () {
    var group = this._activeGroup(), pending = group && this.runs[group.id];
    if (!group) return Promise.reject(new Error('Selecciona un grupo.'));
    var runId = pending && (pending.runId || pending.id), self = this;
    // An explicit refresh supersedes the old observer but deliberately retains
    // its already-open popup until the new gesture lease takes ownership.
    if (this.observation?.polling) return Promise.reject(new Error('Espera a que termine la consulta de estado.'));
    this.selectedHistoryId = null;
    this._stopObservation(false);
    return this._withGesture(async function (fence, leaseId) {
      try {
        var listReply = await self.transport.storage('getGroupRuns', { groupId: group.id }); fence();
        var runs = validRunList(listReply, group.id);
        self.histories[group.id] = copy(runs);
        self._renderHistory(runs);
        var run = runId && runs.find(function (candidate) { return candidate.id === runId; });
        if (!run && runId && ID.test(runId)) {
          var exactReply = await self.transport.storage('getGroupRun', { runId: runId }); fence();
          run = validRun(exactReply, runId, group.id);
        }
        // A pending local request remains authoritative for duplicate-submit
        // gating. An older terminal history item may be viewed, never promoted
        // over that pending run.
        if ((!run || TERMINAL_STATES.has(run.state)) && runs[0]) run = runs[0];
        if (!run) throw new Error('Este grupo todavía no tiene ejecuciones.');
        fence();
        self._persistRun(Object.assign({ runId: run.id, message: pending?.message || '' }, run));
        self._beginObservation(run, leaseId);
        return copy(run);
      } catch (error) { self._report(error); throw error; }
    });
  };

  return { GroupUI: GroupUI, validCatalog: validCatalog, validGroups: validGroups, validRun: validRun, validRunList: validRunList, RUNS_KEY: RUNS_KEY };
});
