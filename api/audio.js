const { json, validateRuntime, buildRuntime, hermes, ensureSessionId } = require('./_lib/hermes');
const { isAuthenticated } = require('./_lib/auth');

const ALLOWED_MIME = new Set([
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/aac',
]);
const MAX_BASE64_CHARS = 8 * 1024 * 1024;

function extractAssistantText(result) {
  const message = result?.message;
  if (typeof message === 'string') return message;
  if (message && typeof message.content === 'string') return message.content;
  if (typeof result?.text === 'string') return result.text;
  return '';
}

async function transcribeWithOpenAI(audioBuffer, mimeType) {
  const apiKey = String(process.env.OPENAI_API_KEY || '');
  if (!apiKey) {
    const error = new Error('Transcription is not configured.');
    error.code = 'transcription_not_configured';
    throw error;
  }
  const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('wav') ? 'wav' : 'webm';
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([audioBuffer], { type: mimeType }), `audio.${extension}`);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!response.ok) {
    const error = new Error(`Transcription provider returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return String(data?.text || '').trim();
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
  const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64 : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.split(';')[0].trim().toLowerCase() : 'audio/webm';
  if (!audioBase64 || audioBase64.length > MAX_BASE64_CHARS) {
    return res.status(400).json({ error: 'invalid_audio', message: 'Audio is missing or too large (max ~6 MB).' });
  }
  if (mimeType && !ALLOWED_MIME.has(mimeType)) {
    return res.status(400).json({ error: 'unsupported_audio_type', message: 'Unsupported audio format.' });
  }
  const runtimeError = validateRuntime(body);
  if (runtimeError) return res.status(400).json({ error: 'invalid_runtime', message: runtimeError });

  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audioBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_audio', message: 'Audio is not valid base64.' });
  }
  if (audioBuffer.length < 1000 || audioBuffer.length > 6 * 1024 * 1024) {
    return res.status(400).json({ error: 'invalid_audio', message: 'Audio size out of range.' });
  }

  try {
    const transcript = await transcribeWithOpenAI(audioBuffer, mimeType || 'audio/webm');
    if (!transcript) {
      return res.status(502).json({ error: 'empty_transcript', message: 'No speech was recognized.' });
    }
    const runtime = buildRuntime(body);
    const requestedSession = typeof body.sessionId === 'string' ? body.sessionId.trim().slice(0, 256) : '';
    const sessionId = await ensureSessionId(requestedSession, runtime);
    const result = await hermes(`/api/sessions/${encodeURIComponent(sessionId)}/chat`, {
      method: 'POST',
      body: JSON.stringify({ message: transcript, ...runtime }),
    });
    return res.status(200).json({ sessionId, transcript, text: extractAssistantText(result) });
  } catch (error) {
    if (error.code === 'transcription_not_configured') {
      return res.status(501).json({ error: 'transcription_not_configured', message: 'Audio received, but transcription is not configured yet.' });
    }
    if (error.code === 'upstream_not_configured') {
      return res.status(503).json({ error: error.code, message: 'Hermes Cloud connection is not configured.' });
    }
    return res.status(502).json({ error: 'audio_pipeline_failed', message: 'Audio could not be processed.' });
  }
};
