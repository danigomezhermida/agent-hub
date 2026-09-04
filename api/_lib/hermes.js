const HERMES_URL = String(process.env.HERMES_CLOUD_URL || '').replace(/\/$/, '');
const HERMES_API_KEY = String(process.env.HERMES_CLOUD_API_KEY || '');

function json(status, body, extraHeaders = {}) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function configStatus() {
  return {
    upstreamConfigured: Boolean(HERMES_URL && HERMES_API_KEY),
    accessControlConfigured: Boolean(process.env.AGENT_HUB_PASSWORD || process.env.AGENT_HUB_SESSION_SECRET),
    transcriptionConfigured: Boolean(process.env.OPENAI_API_KEY),
  };
}

function validateRuntime(body) {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const effort = typeof body.effort === 'string' ? body.effort.trim() : 'medium';
  const allowedModels = new Set(['gpt-5.6-luna', 'claude-opus', 'gpt-4.1-mini']);
  const allowedEfforts = new Set(['none', 'low', 'medium', 'high', 'max']);
  if (model && (model.length > 120 || /[\r\n\x00]/.test(model) || !allowedModels.has(model))) return 'Invalid model.';
  if (!allowedEfforts.has(effort)) return 'Invalid effort.';
  return null;
}

function buildRuntime(body) {
  const effort = body.effort || 'medium';
  const model = body.model || undefined;
  return {
    ...(model ? { model } : {}),
    model_options: { reasoning: { enabled: effort !== 'none', ...(effort !== 'none' ? { effort } : {}) } },
    require_model_lock: Boolean(model),
    source: 'agent-hub',
  };
}

async function hermes(path, options = {}) {
  if (!HERMES_URL || !HERMES_API_KEY) {
    const error = new Error('Hermes Cloud is not configured.');
    error.code = 'upstream_not_configured';
    throw error;
  }
  const response = await fetch(`${HERMES_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${HERMES_API_KEY}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 1000) }; }
  if (!response.ok) {
    const error = new Error(`Hermes Cloud returned HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function ensureSessionId(sessionId, runtime) {
  if (sessionId) return sessionId;
  const created = await hermes('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ ...runtime, title: 'Agent Hub' }),
  });
  return created?.session?.id || created?.id || created?.session_id || '';
}

module.exports = { json, configStatus, validateRuntime, buildRuntime, hermes, ensureSessionId };
