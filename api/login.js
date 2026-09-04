const { checkPassword, mintSession, passwordConfigured, sessionCookieHeader, sessionSecret } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!passwordConfigured() || String(sessionSecret() || '').length < 32) {
    return res.status(503).json({ error: 'backend_not_configured', message: 'Login is not configured yet.' });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!checkPassword(body.password)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = mintSession();
  res.setHeader('Set-Cookie', sessionCookieHeader(token));
  return res.status(200).json({ ok: true });
};
