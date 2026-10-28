import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// The voice worker (voice-server/jarvis_voice.py) dials in here over WebSocket (/voice) and speaks
// in the user's cloned voice. It connects *out* to Jarvis, exactly like the phone companion, so it
// works whether Jarvis runs on the laptop or in the cloud, with no tunnel or open port.
//
// The canonical voice sample lives in the Jarvis data folder (data/voice/sample.wav), so recording a
// new sample in the app reaches every worker, and a worker started on a fresh machine is taught the
// voice automatically.

const sampleDir = path.join(config.dataDir, 'voice');
const samplePath = path.join(sampleDir, 'sample.wav');
const MAX_SAMPLE_BYTES = 30 * 1024 * 1024;

let sock = null;
let info = {};
const waiting = new Map();
const listeners = new Set();
let stored; // { sha, bytes } | null, loaded lazily

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function loadStored() {
  if (stored !== undefined) return stored;
  try {
    const buf = fs.readFileSync(samplePath);
    stored = { sha: sha(buf), bytes: buf.length };
  } catch {
    stored = null;
  }
  return stored;
}

export function onVoiceChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  const s = voiceStatus();
  for (const fn of listeners) {
    try { fn(s); } catch { /* listener errors never break the bridge */ }
  }
}

export function voiceWorkerConnected() {
  return !!sock && sock.readyState === 1;
}

export function voiceStatus() {
  const connected = voiceWorkerConnected();
  const s = loadStored();
  return {
    connected,
    ready: connected && info.ready === true,
    busy: connected && info.busy === true, // learning a new sample
    cloning: connected ? info.cloning !== false : null,
    languages: Array.isArray(info.languages) && info.languages.length ? info.languages : ['en'],
    device: connected ? String(info.device || '') : '',
    hasSample: !!s || (connected && !!info.sampleSha),
    sampleSha: s ? s.sha : (connected ? info.sampleSha || null : null),
    error: connected && info.error ? String(info.error) : '',
  };
}

// A WAV the worker can read: RIFF/WAVE, PCM 16-bit, at least ~5 s, not absurdly large.
export function checkWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return 'That is not a WAV file.';
  if (buf.length > MAX_SAMPLE_BYTES) return 'The voice sample is too large (max 30 MB).';
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'That is not a WAV file.';
  let off = 12;
  let fmt = null;
  let dataBytes = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      dataBytes = Math.min(size, buf.length - off - 8);
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (!fmt || fmt.format !== 1 || fmt.bits !== 16) return 'The voice sample must be 16-bit PCM WAV.';
  if (!fmt.channels || !fmt.rate) return 'The voice sample has an invalid header.';
  const seconds = dataBytes / (fmt.channels * 2 * fmt.rate);
  if (seconds < 5) return 'The voice sample is too short. Record at least 20 seconds of speech.';
  return null;
}

function send(obj) {
  if (!voiceWorkerConnected()) return false;
  try { sock.send(JSON.stringify(obj)); return true; } catch { return false; }
}

function pushStoredSampleTo() {
  try {
    const buf = fs.readFileSync(samplePath);
    send({ type: 'set_voice', sha: sha(buf), wav_b64: buf.toString('base64') });
  } catch { /* nothing stored */ }
}

function storeSample(buf) {
  fs.mkdirSync(sampleDir, { recursive: true });
  const tmp = `${samplePath}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, samplePath);
  stored = { sha: sha(buf), bytes: buf.length };
  return stored;
}

export function attachVoiceWorker(ws) {
  if (sock && sock !== ws) {
    try { sock.close(4000, 'replaced by a newer voice worker'); } catch { /* ignore */ }
  }
  sock = ws;
  info = {};
  emit();

  ws.on('message', (raw) => {
    if (sock !== ws) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'hello' || m.type === 'status') {
      info = { ...info, ...pick(m) };
      if (m.type === 'hello') {
        const s = loadStored();
        if (s && s.sha !== m.sampleSha) pushStoredSampleTo(); // teach the worker the current voice
        else if (!s && m.sampleSha) send({ type: 'get_voice' }); // adopt the worker's sample
      }
      emit();
    } else if (m.type === 'voice_sample' && typeof m.wav_b64 === 'string') {
      const buf = Buffer.from(m.wav_b64, 'base64');
      if (!checkWav(buf)) { storeSample(buf); emit(); }
    } else if (m.type === 'audio' && typeof m.id === 'string') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok && typeof m.wav_b64 === 'string') w.resolve(Buffer.from(m.wav_b64, 'base64'));
      else w.reject(Object.assign(new Error(m.error || 'The voice worker could not speak that.'), { status: 502 }));
    }
  });

  ws.on('close', () => {
    if (sock !== ws) return;
    sock = null;
    info = {};
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.reject(Object.assign(new Error('The voice worker disconnected.'), { status: 503 }));
      waiting.delete(id);
    }
    emit();
  });
}

function pick(m) {
  const out = {};
  for (const k of ['ready', 'busy', 'cloning', 'languages', 'device', 'sampleSha', 'error', 'engine', 'version']) {
    if (k in m) out[k] = m[k];
  }
  return out;
}

// Speak `text` in the cloned voice. Resolves with WAV bytes.
export function synthMine(text, timeoutMs = 60000) {
  const s = voiceStatus();
  if (!s.connected) return Promise.reject(Object.assign(new Error('Your voice worker is not running. Start it on the laptop (voice-server/start.ps1).'), { status: 503 }));
  if (!s.ready) return Promise.reject(Object.assign(new Error(s.error || 'Your voice is still being prepared on the laptop.'), { status: 503 }));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(Object.assign(new Error('Your voice worker took too long to answer.'), { status: 504 }));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    if (!send({ type: 'tts', id, text })) {
      clearTimeout(timer);
      waiting.delete(id);
      reject(Object.assign(new Error('The voice worker is not reachable.'), { status: 503 }));
    }
  });
}

// Save a new sample (from the app's recorder or an upload) and teach it to the worker.
export function setVoiceSample(buf) {
  const problem = checkWav(buf);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const s = storeSample(buf);
  if (voiceWorkerConnected()) {
    if (!(info.ready && info.sampleSha === s.sha)) info = { ...info, ready: false, busy: true, error: '' };
    send({ type: 'set_voice', sha: s.sha, wav_b64: buf.toString('base64') });
  }
  emit();
  return voiceStatus();
}
