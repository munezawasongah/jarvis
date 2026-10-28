import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { config } from './config.js';
import { synthMine, voiceStatus } from './voiceBridge.js';

// Text to speech for the app. Three engines, all free:
//   mine    your own cloned voice, generated on your laptop by the voice worker (offline)
//   neural  Microsoft Edge neural voices (online, no key)
//   device  the phone/browser's built-in voice, played by the app itself (offline fallback)
// The app asks for mine/neural here and falls back to device on its own.

export const MAX_TTS_CHARS = 1200;

// Hand-picked voices that show even when the full Microsoft list can't be fetched.
export const CURATED_VOICES = [
  { id: 'en-GB-RyanNeural', label: 'Ryan (British, male)', locale: 'en-GB', gender: 'Male' },
  { id: 'en-GB-ThomasNeural', label: 'Thomas (British, male)', locale: 'en-GB', gender: 'Male' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia (British, female)', locale: 'en-GB', gender: 'Female' },
  { id: 'en-KE-ChilembaNeural', label: 'Chilemba (Kenyan English, male)', locale: 'en-KE', gender: 'Male' },
  { id: 'en-KE-AsiliaNeural', label: 'Asilia (Kenyan English, female)', locale: 'en-KE', gender: 'Female' },
  { id: 'en-TZ-ElimuNeural', label: 'Elimu (Tanzanian English, male)', locale: 'en-TZ', gender: 'Male' },
  { id: 'en-TZ-ImaniNeural', label: 'Imani (Tanzanian English, female)', locale: 'en-TZ', gender: 'Female' },
  { id: 'en-US-AndrewNeural', label: 'Andrew (American, male)', locale: 'en-US', gender: 'Male' },
  { id: 'en-US-GuyNeural', label: 'Guy (American, male)', locale: 'en-US', gender: 'Male' },
  { id: 'en-US-AvaNeural', label: 'Ava (American, female)', locale: 'en-US', gender: 'Female' },
  { id: 'sw-KE-RafikiNeural', label: 'Rafiki (Kiswahili, Kenya, male)', locale: 'sw-KE', gender: 'Male' },
  { id: 'sw-KE-ZuriNeural', label: 'Zuri (Kiswahili, Kenya, female)', locale: 'sw-KE', gender: 'Female' },
  { id: 'sw-TZ-DaudiNeural', label: 'Daudi (Kiswahili, Tanzania, male)', locale: 'sw-TZ', gender: 'Male' },
  { id: 'sw-TZ-RehemaNeural', label: 'Rehema (Kiswahili, Tanzania, female)', locale: 'sw-TZ', gender: 'Female' },
  { id: 'fr-FR-HenriNeural', label: 'Henri (French, male)', locale: 'fr-FR', gender: 'Male' },
  { id: 'es-ES-AlvaroNeural', label: 'Álvaro (Spanish, male)', locale: 'es-ES', gender: 'Male' },
  { id: 'de-DE-ConradNeural', label: 'Conrad (German, male)', locale: 'de-DE', gender: 'Male' },
];

const DEFAULTS = {
  'en-gb': 'en-GB-RyanNeural', 'en-us': 'en-US-AndrewNeural', 'en-ke': 'en-KE-ChilembaNeural', 'en-tz': 'en-TZ-ElimuNeural',
  'sw-ke': 'sw-KE-RafikiNeural', 'sw-tz': 'sw-TZ-DaudiNeural', sw: 'sw-KE-RafikiNeural',
  en: 'en-GB-RyanNeural', fr: 'fr-FR-HenriNeural', es: 'es-ES-AlvaroNeural', de: 'de-DE-ConradNeural',
};

const VOICE_RE = /^[a-z]{2,3}-[A-Za-z]{2,4}(?:-[A-Za-z0-9]+)*Neural$/;

export function defaultNeuralVoice(lang = 'en-GB') {
  if (config.voice.neuralVoice) return config.voice.neuralVoice;
  const l = String(lang).toLowerCase();
  return DEFAULTS[l] || DEFAULTS[l.split('-')[0]] || 'en-GB-RyanNeural';
}

// ---------- full Microsoft voice list (best effort, cached for a day) ----------
let fullList = null;
let fullListAt = 0;
let refreshing = null;
function refreshVoiceList() {
  if (!config.voice.listRefresh || refreshing || Date.now() - fullListAt < 24 * 3600e3) return;
  refreshing = (async () => {
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 8000 });
    const voices = await tts.getVoices();
    fullList = voices
      .filter((v) => VOICE_RE.test(v.ShortName))
      .map((v) => ({ id: v.ShortName, label: `${v.ShortName.split('-').slice(2).join(' ').replace(/Neural$/, '')} (${v.Locale}, ${String(v.Gender).toLowerCase()})`, locale: v.Locale, gender: v.Gender }));
    fullListAt = Date.now();
  })().catch(() => { fullListAt = Date.now() - 23 * 3600e3; }) // retry in an hour
    .finally(() => { refreshing = null; });
}

export function neuralVoices() {
  refreshVoiceList();
  if (!fullList || !fullList.length) return CURATED_VOICES;
  const curated = new Set(CURATED_VOICES.map((v) => v.id));
  return [...CURATED_VOICES, ...fullList.filter((v) => !curated.has(v.id))];
}

// ---------- disk cache (the same sentence is often said twice: greetings, confirmations) ----------
const cacheDir = path.join(config.dataDir, 'tts-cache');
let cacheBytes = null;

function cacheKey(engine, voice, text) {
  return crypto.createHash('sha256').update(`${engine}\n${voice}\n${text}`).digest('hex');
}
function cacheGet(key, ext) {
  const file = path.join(cacheDir, `${key}.${ext}`);
  try {
    const buf = fs.readFileSync(file);
    const now = new Date();
    fs.utimesSync(file, now, now); // mark as recently used
    return buf;
  } catch {
    return null;
  }
}
function cachePut(key, ext, buf) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, `${key}.${ext}`), buf);
    if (cacheBytes === null) cacheBytes = dirSize();
    cacheBytes += buf.length;
    if (cacheBytes > config.voice.cacheMb * 1024 * 1024) pruneCache();
  } catch { /* cache is optional */ }
}
function dirSize() {
  try { return fs.readdirSync(cacheDir).reduce((n, f) => n + fs.statSync(path.join(cacheDir, f)).size, 0); } catch { return 0; }
}
function pruneCache() {
  const files = fs.readdirSync(cacheDir)
    .map((f) => { const p = path.join(cacheDir, f); const s = fs.statSync(p); return { p, size: s.size, t: s.mtimeMs }; })
    .sort((a, b) => a.t - b.t);
  let total = files.reduce((n, f) => n + f.size, 0);
  const target = config.voice.cacheMb * 1024 * 1024 * 0.8;
  for (const f of files) {
    if (total <= target) break;
    try { fs.unlinkSync(f.p); total -= f.size; } catch { /* ignore */ }
  }
  cacheBytes = total;
}

// ---------- Edge neural voices ----------
const pool = new Map(); // voice -> Promise<MsEdgeTTS>
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function edgeFor(voice) {
  let p = pool.get(voice);
  if (!p) {
    p = (async () => {
      const tts = new MsEdgeTTS({ connectionTimeoutMs: 6000, synthesisTimeoutMs: 15000 });
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      return tts;
    })();
    pool.set(voice, p);
    p.catch(() => pool.delete(voice));
  }
  return p;
}

async function synthNeural(text, voice, attempt = 0) {
  let tts;
  const reused = pool.has(voice); // an idle pooled socket may have been dropped by Microsoft
  try {
    tts = await edgeFor(voice);
    return await new Promise((resolve, reject) => {
      const { audioStream } = tts.toStream(xml(text));
      const parts = [];
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        const buf = Buffer.concat(parts);
        if (err) reject(err);
        else if (!buf.length) reject(new Error('The online voice returned no audio.'));
        else resolve(buf);
      };
      audioStream.on('data', (d) => parts.push(d));
      audioStream.on('error', (e) => finish(e));
      audioStream.on('end', () => finish());
      audioStream.on('close', () => finish());
    });
  } catch (err) {
    pool.delete(voice);
    try { tts?.close(); } catch { /* ignore */ }
    if (attempt === 0 && reused) return synthNeural(text, voice, 1); // stale socket: one fresh retry
    throw Object.assign(new Error(`The online voice service could not be reached (${err.message || err}).`), { status: 502 });
  }
}

// ---------- public entry point ----------
export async function synthesize({ text, engine, voice, lang }) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) throw Object.assign(new Error('Missing "text".'), { status: 400 });
  if (t.length > MAX_TTS_CHARS) throw Object.assign(new Error(`Text too long (max ${MAX_TTS_CHARS} characters per request).`), { status: 413 });

  if (engine === 'mine') {
    const s = voiceStatus();
    const key = cacheKey('mine', s.sampleSha || 'none', t);
    const hit = s.ready ? cacheGet(key, 'wav') : null;
    if (hit) return { audio: hit, mime: 'audio/wav', engine: 'mine', cached: true };
    const audio = await synthMine(t);
    if (voiceStatus().sampleSha === s.sampleSha) cachePut(key, 'wav', audio);
    return { audio, mime: 'audio/wav', engine: 'mine', cached: false };
  }

  if (engine === 'neural') {
    const v = voice || defaultNeuralVoice(lang);
    if (!VOICE_RE.test(v)) throw Object.assign(new Error('Unknown voice name.'), { status: 400 });
    const key = cacheKey('neural', v, t);
    const hit = cacheGet(key, 'mp3');
    if (hit) return { audio: hit, mime: 'audio/mpeg', engine: 'neural', voice: v, cached: true };
    const audio = await synthNeural(t, v);
    cachePut(key, 'mp3', audio);
    return { audio, mime: 'audio/mpeg', engine: 'neural', voice: v, cached: false };
  }

  throw Object.assign(new Error('engine must be "mine" or "neural".'), { status: 400 });
}
