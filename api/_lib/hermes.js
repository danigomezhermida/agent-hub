const HERMES_URL = String(process.env.HERMES_CLOUD_URL || '').replace(/\/$/, '');
const HERMES_API_KEY = String(process.env.HERMES_CLOUD_API_KEY || '');
const AGENT_HUB_ACCESS_TOKEN = String(process.env.AGENT_HUB_ACCESS_TOKEN || '');

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
    accessControlConfigured: Boolean(AGENT_HUB_ACCESS_TOKEN),
  };
}

function authorize(req) {
  if (!AGENT_HUB_ACCESS_TOKEN) {
    return json(503, {
      error: 'backend_not_configured',
      message: 'Agent Hub backend auth is not configured.',
    });
  }
  const header = String(req.headers.authorization || '');
  if (header !== `Bearer ${AGENT_HUB_ACCESS_TOKEN}`) {
    return json(401, { error: 'unauthorized', message: 'Authentication required.' });
  }
  return null;
}

function validateRuntime(body) {
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const effort = typeof body.effort === 'string' ? body.effort.trim() : 'medium';
  const allowedEfforts = new Set(['none', 'low', 'medium', 'high', 'max']);
  if (model.length > 120 || /[\r\n\x00]/.test(model)) return 'Invalid model.';
  if (!allowedEfforts.has(effort)) return 'Invalid effort.';
  return null;
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

module.exports = { json, configStatus, authorize, validateRuntime, hermes };
