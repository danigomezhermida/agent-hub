const crypto = require('crypto');

const COOKIE_NAME = 'agenthub_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

function base64urlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function sessionSecret() {
  return String(process.env.AGENT_HUB_SESSION_SECRET || '');
}

function passwordConfigured() {
  return Boolean(process.env.AGENT_HUB_PASSWORD);
}

function signPayload(payload) {
  const secret = sessionSecret();
  return base64urlEncode(crypto.createHmac('sha256', secret).update(payload, 'utf8').digest());
}

function mintSession() {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64urlEncode(JSON.stringify({ sub: 'owner', iat: now, exp: now + SESSION_TTL_SECONDS }));
  return `${payload}.${signPayload(payload)}`;
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const out = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function verifySession(token) {
  const secret = sessionSecret();
  if (!secret || secret.length < 32 || !token || typeof token !== 'string') return false;
  const pieces = token.split('.');
  if (pieces.length !== 2) return false;
  const [payload, signature] = pieces;
  const expected = signPayload(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  if (!crypto.timingSafeEqual(a, b)) return false;
  try {
    const data = JSON.parse(base64urlDecode(payload));
    if (!data || typeof data.exp !== 'number') return false;
    return data.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function sessionCookieHeader(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function bearerToken(req) {
  const configured = String(process.env.AGENT_HUB_ACCESS_TOKEN || '');
  if (!configured) return false;
  const header = String(req.headers.authorization || '');
  if (header.length !== configured.length + 7) return false;
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(`Bearer ${configured}`));
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  if (verifySession(cookies[COOKIE_NAME])) return true;
  if (bearerToken(req)) return true;
  return false;
}

function checkPassword(candidate) {
  const expected = String(process.env.AGENT_HUB_PASSWORD || '');
  if (!expected) return false;
  const a = Buffer.from(String(candidate || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  sessionSecret,
  passwordConfigured,
  mintSession,
  parseCookies,
  verifySession,
  sessionCookieHeader,
  clearCookieHeader,
  isAuthenticated,
  checkPassword,
};
