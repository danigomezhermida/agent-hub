const { json, validateRuntime, buildRuntime, hermes, ensureSessionId } = require('./_lib/hermes');
const { isAuthenticated } = require('./_lib/auth');

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

function extractAssistantText(result) {
  const message = result?.message;
  if (typeof message === 'string') return message;
  if (message && typeof message.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    return message.content.filter((part) => part && typeof part.text === 'string').map((part) => part.text).join('\n');
  }
  if (typeof result?.text === 'string') return result.text;
  if (typeof result?.reply === 'string') return result.reply;
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Login required.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 20000) {
    return res.status(400).json({ error: 'invalid_message', message: 'A message is required.' });
  }
  const runtimeError = validateRuntime(body);
  if (runtimeError) return res.status(400).json({ error: 'invalid_runtime', message: runtimeError });

  const runtime = buildRuntime(body);
  try {
    const requestedSession = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 256) : '';
    const sessionId = await ensureSessionId(requestedSession, runtime);
    if (!sessionId) throw new Error('Hermes did not return a session id.');

    const result = await hermes(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message, ...runtime }),
    });

    return res.status(200).json({
      sessionId,
      text: extractAssistantText(result),
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
