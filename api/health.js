const { json, configStatus, hermes } = require('./_lib/hermes');
const { isAuthenticated, passwordConfigured, sessionSecret } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const status = configStatus();
  const loginConfigured = passwordConfigured() && String(sessionSecret() || '').length >= 32;
  if (!status.upstreamConfigured || !loginConfigured) {
    return res.status(503).json({
      status: 'not_ready',
      service: 'agent-hub-backend',
      hermes: { status: status.upstreamConfigured ? 'unknown' : 'not_configured' },
      configuration: {
        upstreamConfigured: status.upstreamConfigured,
        accessControlConfigured: loginConfigured,
        transcriptionConfigured: status.transcriptionConfigured,
      },
    });
  }
  if (!isAuthenticated(req)) {
    return res.status(401).json({ status: 'unauthorized', service: 'agent-hub-backend' });
  }
  try {
    await hermes('/health', { method: 'GET' });
    return res.status(200).json({ status: 'ok', service: 'agent-hub-backend', hermes: { status: 'ok' } });
  } catch (error) {
    const code = error.code === 'upstream_not_configured' ? 503 : 502;
    return res.status(code).json({ status: 'degraded', service: 'agent-hub-backend', hermes: { status: 'unreachable' } });
  }
};
