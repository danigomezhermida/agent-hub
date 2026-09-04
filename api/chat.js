const { json, authorize, validateRuntime, hermes } = require('./_lib/hermes');

function safeError(error) {
  if (error.code === 'upstream_not_configured') {
    return json(503, { error: error.code, message: 'Hermes Cloud connection is not configured.' });
  }
  if (error.status) {
    return json(error.status >= 500 ? 502 : error.status, {
      error: 'hermes_upstream_error',
      message: 'Hermes Cloud rejected the request.',
    });
  }
  return json(502, { error: 'hermes_upstream_unavailable', message: 'Hermes Cloud is unavailable.' });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const authError = authorize(req);
  if (authError) {
    res.status(authError.status);
    Object.entries(authError.headers).forEach(([key, value]) => res.setHeader(key, value));
    return res.end(authError.body);
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 20000) {
    return res.status(400).json({ error: 'invalid_message', message: 'A message is required.' });
  }
  const runtimeError = validateRuntime(body);
  if (runtimeError) return res.status(400).json({ error: 'invalid_runtime', message: runtimeError });

  const effort = body.effort || 'medium';
  const model = body.model || undefined;
  const runtime = {
    ...(model ? { model } : {}),
    model_options: { reasoning: { enabled: effort !== 'none', ...(effort !== 'none' ? { effort } : {}) } },
    require_model_lock: Boolean(model),
    source: 'agent-hub',
  };

  try {
    let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId) {
      const created = await hermes('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ ...runtime, title: 'Agent Hub' }),
      });
      sessionId = created?.session?.id || created?.id || created?.session_id || '';
    }
    if (!sessionId) throw new Error('Hermes did not return a session id.');

    const result = await hermes(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, ...runtime }),
    });

    return res.status(200).json({
      sessionId,
      message: result?.message || { role: 'assistant', content: '' },
      runtime: result?.runtime || null,
      usage: result?.usage || null,
    });
  } catch (error) {
    const response = safeError(error);
    res.status(response.status);
    Object.entries(response.headers).forEach(([key, value]) => res.setHeader(key, value));
    return res.end(response.body);
  }
};
