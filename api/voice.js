const { isAuthenticated } = require('./_lib/auth');

// Voz en vivo: canal separado. Vercel serverless no mantiene WebSocket/WebRTC,
// asi que esta ruta solo expone el plan y el estado. No mezcla audio en /api/chat.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!isAuthenticated(req)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Login required.' });
  }
  return res.status(200).json({
    status: 'planned',
    channel: 'voice-live-separate',
    transport: 'webrtc_or_websocket_dedicated_server',
    message: 'Live voice needs a dedicated realtime voice server. Recorded audio uses /api/audio.',
  });
};
