/* Fixed authenticated personal-owner storage. Runs only on the Hermes origin. */
(() => {
  'use strict';
  const PREFIX = '/api/plugins/agent-hub';
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const validRevision = value => Number.isInteger(value) && value >= 0;
  async function http(path, options = {}) {
    const response = await fetch(PREFIX + path, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (!response.ok) {
      const error = new Error(response.status === 409 ? 'Hay cambios de otro dispositivo. Sincroniza antes de continuar.' : response.status === 401 || response.status === 403 ? 'Esta cuenta no tiene acceso a Agent Hub.' : 'No se pudo acceder al almacenamiento de Hermes.');
      error.code = response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'identity' : 'storage';
      error.httpStatus = response.status;
      throw error;
    }
    return response;
  }
  const json = body => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  window.AgentHubStorage = {
    async request(op, args = {}, signal) {
      const call = (path, options = {}) => http(path, { ...options, signal });
      switch (op) {
        case 'identity': return (await call('/identity')).json();
        case 'getState': return (await call('/state')).json();
        case 'putState': return (await call('/state', json({ expectedRevision: args.expectedRevision, snapshot: args.snapshot }))).json();
        case 'getGroupCatalog': return (await call('/group-catalog')).json();
        case 'getGroups': return (await call('/groups')).json();
        case 'putGroups':
          if (!validRevision(args.expectedRevision) || !Array.isArray(args.groups)) throw new Error('Configuración de grupos no válida.');
          return (await call('/groups', json({ expectedRevision: args.expectedRevision, groups: args.groups }))).json();
        case 'startGroupRun':
          if (!validId(args.groupId) || !validId(args.runId) || !validRevision(args.expectedRevision) || typeof args.message !== 'string' || !args.message.trim() || args.message.length > 12000) throw new Error('Ejecución de grupo no válida.');
          return (await call('/groups/' + encodeURIComponent(args.groupId) + '/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: args.runId, message: args.message, expectedRevision: args.expectedRevision }) })).json();
        case 'getGroupRun':
          if (!validId(args.runId)) throw new Error('Identificador de ejecución no válido.');
          return (await call('/group-runs/' + encodeURIComponent(args.runId))).json();
        case 'getGroupRuns':
          if (!validId(args.groupId)) throw new Error('Identificador de grupo no válido.');
          return (await call('/group-runs?groupId=' + encodeURIComponent(args.groupId))).json();
        case 'getBindings': return (await call('/bindings')).json();
        case 'putBinding':
          if (!validId(args.chatId)) throw new Error('Identificador de conversación no válido.');
          return (await call('/bindings/' + args.chatId, json({sessionId: args.sessionId, expectedSessionId: args.expectedSessionId ?? null}))).json();
        case 'getAudio': case 'putAudio': {
          if (!validId(args.id) || !validId(args.chatId)) throw new Error('Identificador de audio no válido.');
          const path = '/audio/' + args.id + '?chatId=' + encodeURIComponent(args.chatId);
          if (op === 'getAudio') return (await call(path)).blob();
          if (!(args.blob instanceof Blob) || !args.blob.size || args.blob.size > 6 * 1024 * 1024) throw new Error('Audio vacío o superior a 6 MiB.');
          return (await call(path, { method: 'PUT', headers: { 'Content-Type': args.blob.type }, body: args.blob })).json();
        }
        case 'claimTurn': {
          if (!validId(args.chatId) || !validId(args.clientMessageId) || !validId(args.requestId)) throw new Error('Turno inválido.');
          return (await call(`/turns/${encodeURIComponent(args.chatId)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientMessageId:args.clientMessageId,requestId:args.requestId,promptDigest:args.promptDigest})})).json();
        }
        case 'getTurn': {
          if (!validId(args.chatId) || (args.clientMessageId && !validId(args.clientMessageId))) throw new Error('Turno inválido.');
          const query = args.clientMessageId ? '?clientMessageId='+encodeURIComponent(args.clientMessageId) : '';
          return (await call(`/turns/${encodeURIComponent(args.chatId)}${query}`)).json();
        }
        case 'finishTurn': {
          if (!validId(args.chatId) || !validId(args.clientMessageId) || !validId(args.requestId)) throw new Error('Turno inválido.');
          const payload = {requestId:args.requestId,state:args.state};
          if (args.state === 'completed') payload.text = args.text;
          return (await call(`/turns/${encodeURIComponent(args.chatId)}/${encodeURIComponent(args.clientMessageId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})).json();
        }
        default: throw new Error('Operación de almacenamiento no permitida.');
      }
    }
  };
})();
