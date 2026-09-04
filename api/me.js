const { isAuthenticated, passwordConfigured, sessionSecret } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  const configured = passwordConfigured() && String(sessionSecret() || '').length >= 32;
  return res.status(200).json({ authenticated: isAuthenticated(req), loginConfigured: configured });
};
