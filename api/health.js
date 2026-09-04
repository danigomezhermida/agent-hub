const { json, configStatus, hermes } = require('./_lib/hermes');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const config = configStatus();
  let upstream = { status: 'not_configured' };
  if (config.upstreamConfigured) {
    try {
      upstream = await hermes('/health');
    } catch (error) {
      upstream = { status: 'unreachable', httpStatus: error.status || 502 };
    }
  }

  const result = {
    status: config.upstreamConfigured && upstream.status !== 'unreachable' ? 'ok' : 'not_ready',
    service: 'agent-hub-backend',
    hermes: upstream,
    configuration: config,
  };
  const response = json(result.status === 'ok' ? 200 : 503, result);
  res.status(response.status);
  Object.entries(response.headers).forEach(([key, value]) => res.setHeader(key, value));
  return res.end(response.body);
};
