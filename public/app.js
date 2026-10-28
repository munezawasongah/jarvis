'use strict';
/* Jarvis voice client: wake word ("Jarvis"), push-to-talk, spoken replies, confirmation sheet.
   Uses the browser's Web Speech API, so it works in Chrome on Android and on desktop Chrome/Edge. */

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

const S = {
  token: '',
  name: '',
  lang: store.get('lang', navigator.language || 'en-US'),
  voiceName: store.get('voiceName', ''), // the phone's built-in voice
  engine: store.get('engine', 'auto'), // auto | mine | neural | device
  neuralVoice: store.get('neuralVoice', ''), // '' = best match for the speech language
  voice: null, // status of your cloned voice (from the server)
  neuralVoices: [],
  recording: false,
  rate: store.get('rate', 1.05),
  wake: store.get('wake', true),
  speakReplies: store.get('speak', true),
  started: false,
  phase: 'wake', // wake = waiting for "Jarvis" | command = next sentence is a command | confirm = waiting for yes/no
  speaking: false,
  busy: false,
  micBlocked: false,
};
try { S.token = localStorage.getItem('jarvis_token') || ''; } catch { /* ignore */ }

/* ---------- small UI helpers ---------- */
const log = $('#log');
let toastTimer;
function toast(text, ms = 4000) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
function addMsg(kind, text) {
  const d = document.createElement('div');
  d.className = `msg ${kind}`;
  d.textContent = text; // textContent only: replies can contain email/web content
  log.appendChild(d);
  while (log.children.length > 120) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
function setStatus(text) { $('#statusLine').textContent = text; }
function setChip(id, on, label) {
  const c = $(id);
  c.classList.toggle('on', !!on);
  c.classList.toggle('off', !on);
  if (label) c.lastChild.textContent = label;
}

function updateOrb() {
  const orbs = document.querySelectorAll('#orbBtn');
  let cls = 'idle';
  if (S.speaking) cls = 'speaking';
  else if (S.busy) cls = 'thinking';
  else if (S.phase !== 'wake') cls = 'active';
  else if (recOn) cls = 'listening';
  orbs.forEach((o) => { o.className = `orb ${cls}`; });
  $('#micBtn').classList.toggle('active', S.phase === 'command');
  if (!S.busy) {
    if (S.phase === 'command') setStatus('Listening…');
    else if (S.phase === 'confirm') setStatus('Waiting for your yes or no');
    else if (S.speaking) setStatus('');
    else if (recOn && S.wake) setStatus('Say “Jarvis…”');
    else setStatus(S.micBlocked ? 'Microphone blocked' : 'Tap the mic to talk');
  }
}

/* ---------- audio cues ---------- */
let audioCtx;
function chime(freq = 880, dur = 0.12) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur + 0.02);
  } catch { /* audio not available */ }
}

/* ---------- text to speech ----------
   Engines (all free):
     mine    your own cloned voice, made on your laptop by the voice worker (works without internet)
     neural  Microsoft neural voices through the Jarvis server (online)
     device  this phone/browser's built-in voice (always available, works offline)
   "auto" tries them in that order, per sentence, and remembers for a minute which one failed. */
const synth = window.speechSynthesis;
const speechQueue = []; // { text, audio: Promise<{engine,url}|null> }
const player = new Audio();
player.preload = 'auto';
let speakGen = 0; // bumped by stopSpeaking(): anything from an older generation is dropped
const inflight = new Set();
const engineDownUntil = { mine: 0, neural: 0 };
let lastEngine = '';
let lastFallbackToast = 0;

function toSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function chunk(text, max = 220) {
  const parts = text.match(/[^.!?;:\n]+[.!?;:]?\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((t) => /[\p{L}\p{N}]/u.test(t));
}
function pickVoice() {
  const voices = synth ? synth.getVoices() : [];
  if (S.voiceName) { const v = voices.find((x) => x.name === S.voiceName); if (v) return v; }
  const base = S.lang.toLowerCase().split('-')[0];
  return voices.find((v) => v.lang.toLowerCase() === S.lang.toLowerCase())
    || voices.find((v) => v.lang.toLowerCase().startsWith(base))
    || null;
}
const langBase = () => S.lang.toLowerCase().split('-')[0];
function mineUsable() {
  const m = S.voice;
  return !!(m && m.ready && (m.languages || ['en']).includes(langBase()));
}
function engineOrder() {
  const now = Date.now();
  const order = { auto: ['mine', 'neural', 'device'], mine: ['mine', 'neural', 'device'], neural: ['neural', 'device'], device: ['device'] }[S.engine] || ['mine', 'neural', 'device'];
  return order.filter((e) => e === 'device' || ((e !== 'mine' || mineUsable()) && now >= engineDownUntil[e]));
}

async function ttsRequest(text, engine) {
  const ctl = new AbortController();
  inflight.add(ctl);
  const timer = setTimeout(() => ctl.abort('timeout'), engine === 'mine' ? 45000 : 15000);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${S.token}` },
      body: JSON.stringify({ text, engine, voice: engine === 'neural' ? neuralVoiceFor() || undefined : undefined, lang: S.lang }),
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).error || msg; } catch { /* not json */ }
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('empty audio');
    return blob;
  } finally {
    clearTimeout(timer);
    inflight.delete(ctl);
  }
}

function noteFallback(engine, err) {
  // 503 = not ready right now (worker offline / still learning); try it again sooner.
  engineDownUntil[engine] = Date.now() + (err && err.status === 503 ? 20000 : 60000);
  if (Date.now() - lastFallbackToast > 60000 && S.engine !== 'auto') {
    lastFallbackToast = Date.now();
    toast(engine === 'mine' ? 'Your voice isn’t available right now, so I’m using another voice.' : 'The online voice isn’t reachable, so I’m using the phone’s voice.', 4000);
  }
}

async function fetchAudio(text, gen) {
  for (const engine of engineOrder()) {
    if (gen !== speakGen) return null;
    if (engine === 'device') return { engine: 'device' };
    try {
      const blob = await ttsRequest(text, engine);
      if (gen !== speakGen) return null;
      return { engine, url: URL.createObjectURL(blob) };
    } catch (err) {
      if (gen !== speakGen) return null;
      noteFallback(engine, err);
    }
  }
  return { engine: 'device' };
}

function prefetch() {
  const gen = speakGen;
  for (const item of speechQueue.slice(0, 2)) if (!item.audio) item.audio = fetchAudio(item.text, gen);
}

function speak(text, { force = false } = {}) {
  if (!S.speakReplies && !force) return;
  const clean = toSpeech(text);
  if (!clean) return;
  for (const t of chunk(clean)) speechQueue.push({ text: t, audio: null });
  prefetch();
  if (!S.speaking) nextSpeech();
}

async function nextSpeech() {
  const item = speechQueue.shift();
  if (!item) {
    S.speaking = false;
    syncRec();
    return;
  }
  const gen = speakGen;
  S.speaking = true;
  syncRec(); // pause the microphone so Jarvis doesn't hear himself
  if (!item.audio) item.audio = fetchAudio(item.text, gen);
  prefetch();
  const slow = setTimeout(() => { if (gen === speakGen && !S.busy) setStatus('Preparing voice…'); }, 900);
  const res = await item.audio;
  clearTimeout(slow);
  if (gen !== speakGen) { if (res && res.url) URL.revokeObjectURL(res.url); return; }
  if (!S.busy) updateOrb();
  const done = () => { if (gen === speakGen) nextSpeech(); };
  if (!res) { done(); return; }
  if (res.engine !== lastEngine) { lastEngine = res.engine; updateVoiceChip(); }
  if (res.engine === 'device') speakDevice(item.text, done);
  else playUrl(res.url, () => { URL.revokeObjectURL(res.url); done(); });
}

function playUrl(url, done) {
  let finished = false;
  const fin = () => { if (finished) return; finished = true; player.onended = player.onerror = null; done(); };
  player.onended = fin;
  player.onerror = fin;
  player.defaultPlaybackRate = S.rate;
  player.preservesPitch = true;
  player.src = url;
  player.playbackRate = S.rate;
  const p = player.play();
  if (p && p.catch) {
    p.catch((err) => {
      if (err && err.name === 'NotAllowedError') toast('Tap the orb once to let Jarvis play sound.', 5000);
      fin();
    });
  }
}

function speakDevice(text, done) {
  if (!synth) { done(); return; }
  let finished = false;
  const fin = () => { if (finished) return; finished = true; done(); };
  const u = new SpeechSynthesisUtterance(text);
  u.lang = S.lang;
  u.rate = S.rate;
  const v = pickVoice();
  if (v) u.voice = v;
  u.onend = fin;
  u.onerror = fin;
  synth.speak(u);
}

function stopSpeaking() {
  speakGen++;
  for (const c of inflight) { try { c.abort('stopped'); } catch { /* ignore */ } }
  inflight.clear();
  for (const it of speechQueue) if (it.audio) it.audio.then((r) => { if (r && r.url) URL.revokeObjectURL(r.url); });
  speechQueue.length = 0;
  try {
    player.onended = player.onerror = null;
    player.pause();
    player.removeAttribute('src');
    player.load();
  } catch { /* ignore */ }
  try { synth && synth.cancel(); } catch { /* ignore */ }
  S.speaking = false;
}

// Android Chrome only plays audio after a tap: play a tiny silent clip from the Start/mic tap.
const SILENCE = 'data:audio/wav;base64,UklGRgQCAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YeABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
function unlockAudio() {
  try { player.src = SILENCE; const p = player.play(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  try { synth && synth.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ }
}

/* ---------- voice status (your cloned voice on the laptop) ---------- */
function updateVoiceChip() {
  const m = S.voice || {};
  let label;
  let on = true;
  if (S.engine === 'device') label = 'Phone voice';
  else if (S.engine === 'neural') label = lastEngine === 'device' ? 'Phone voice' : 'Online voice';
  else if (mineUsable()) label = lastEngine === 'device' ? 'Phone voice' : 'My voice';
  else if (m.busy) { label = 'Learning…'; on = false; }
  else if (S.engine === 'mine') { label = 'My voice off'; on = false; }
  else label = lastEngine === 'device' ? 'Phone voice' : 'Online voice';
  setChip('#voiceChip', on, label);
  $('#voiceChip').title = mineStatusText();
}
function mineStatusText() {
  const m = S.voice || {};
  if (!m.connected) return 'My voice: the laptop voice worker is not connected. Start it with voice-server\\start.ps1.';
  if (m.busy) return 'My voice: learning your new sample… (about a minute)';
  if (m.error && !m.ready) return `My voice: ${m.error}`;
  if (!m.hasSample) return 'My voice: no sample yet. Record one below.';
  if (m.ready && !(m.languages || ['en']).includes(langBase())) return `My voice is ready${m.device ? ` on ${m.device}` : ''}, but it only speaks ${(m.languages || ['en']).join(', ')}. Other languages use the online voice.`;
  if (m.ready) return `My voice: ready${m.device ? ` on ${m.device}` : ''}.`;
  return 'My voice: starting…';
}
function setVoiceStatus(v) {
  if (!v) return;
  const wasBusy = S.voice && S.voice.busy;
  S.voice = v;
  if (v.ready) engineDownUntil.mine = 0;
  if (wasBusy && v.ready && !v.busy) toast('Your voice is ready.', 3000);
  updateVoiceChip();
  if (settingsDlg && settingsDlg.open) fillVoiceSettings();
}

/* ---------- speech recognition ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recOn = false;
let restartTimer = null;
let cmdTimer = null;
const WAKE = /\b(?:hey |ok |okay )?(?:jarvis|jervis|jarvas|jarves)\b[\s,.:;!?-]*(.*)$/i;
const YES = /^(yes|yeah|yep|yup|sure|ok|okay|confirm|confirmed|approve|approved|go ahead|do it|send it|proceed)\b/i;
const NO = /^(no|nope|cancel|stop|don't|do not|deny|denied|negative|abort|never mind)\b/i;

function shouldListen() {
  return !!SR && S.started && !S.speaking && !S.recording && !S.micBlocked && (S.wake || S.phase !== 'wake');
}
function syncRec() {
  if (shouldListen()) { if (!recOn) startRec(); } else { stopRec(); }
  updateWakeLock();
  updateOrb();
}
function startRec() {
  clearTimeout(restartTimer);
  const me = new SR();
  rec = me;
  me.lang = S.lang;
  me.continuous = true;
  me.interimResults = false;
  me.maxAlternatives = 1;
  // Every handler ignores events from an instance that has since been replaced or stopped.
  me.onstart = () => { if (rec !== me) return; recOn = true; updateOrb(); };
  me.onend = () => {
    if (rec !== me) return;
    recOn = false;
    updateOrb();
    if (shouldListen()) restartTimer = setTimeout(syncRec, 350); // Chrome ends sessions on silence; keep going
  };
  me.onerror = (e) => {
    if (rec !== me) return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.micBlocked = true;
      toast('Microphone is blocked. Allow it in your browser’s site settings, then reload.', 7000);
    } else if (e.error === 'network') {
      toast('The speech service could not be reached. Check your connection.');
    }
  };
  me.onresult = (ev) => {
    if (rec !== me) return;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      if (ev.results[i].isFinal) onHeard(ev.results[i][0].transcript.trim());
    }
  };
  try { me.start(); } catch { rec = null; recOn = false; }
}
function stopRec() {
  clearTimeout(restartTimer);
  const old = rec;
  rec = null; // detaches all of the old instance's handlers (see startRec)
  recOn = false;
  if (old) { try { old.abort(); } catch { /* ignore */ } }
}

function enterCommand(ms = 9000) {
  S.phase = 'command';
  chime(988, 0.1);
  clearTimeout(cmdTimer);
  cmdTimer = setTimeout(() => {
    if (S.phase === 'command') {
      S.phase = 'wake';
      syncRec();
      toast('I didn’t catch anything.');
    }
  }, ms);
  syncRec();
}
function leaveCommand() {
  clearTimeout(cmdTimer);
  if (S.phase === 'command') S.phase = 'wake';
}

function onHeard(text) {
  if (!text) return;
  if (S.phase === 'confirm') {
    if (YES.test(text)) answerConfirm(true);
    else if (NO.test(text)) answerConfirm(false);
    return;
  }
  const m = text.match(WAKE);
  if (S.phase === 'command') {
    leaveCommand();
    sendUser(m && m[1] ? m[1] : text);
    syncRec();
    return;
  }
  if (m) {
    const cmd = (m[1] || '').trim();
    if (cmd) { chime(988, 0.08); sendUser(cmd); } else enterCommand();
  }
}

/* ---------- screen wake lock (only while always-listening) ---------- */
let wakeLock = null;
async function updateWakeLock() {
  try {
    const want = S.started && S.wake && !document.hidden && 'wakeLock' in navigator;
    if (want && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not allowed */ }
}
document.addEventListener('visibilitychange', () => { updateWakeLock(); if (!document.hidden) syncRec(); });

/* ---------- server connection ---------- */
let ws = null;
let retry = 0;
let reconnectTimer = null;

function connect() {
  if (!S.token) { openTokenDialog(); return; }
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
  ws.onopen = () => { retry = 0; setChip('#connChip', true); };
  ws.onclose = () => {
    setChip('#connChip', false);
    setChip('#phoneChip', false);
    S.busy = false;
    updateOrb();
    retry++;
    if (retry === 3) toast('Can’t connect. Is the server running, and is the access token right? (Settings → Change access token)', 8000);
    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15000));
  };
  ws.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch { /* ignore malformed */ } };
}

function sendWs(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  toast('Not connected to the Jarvis server.');
  return false;
}

function sendUser(text) {
  const t = text.trim();
  if (!t) return;
  stopSpeaking();
  addMsg('user', t);
  if (sendWs({ type: 'user', text: t })) { S.busy = true; setStatus('Thinking…'); }
  updateOrb();
}

/* ---------- confirmation sheet ---------- */
let currentConfirm = null;
function showConfirm(m) {
  currentConfirm = m;
  $('#cLabel').textContent = `Confirm: ${m.label || m.tool}`;
  $('#cSummary').textContent = m.summary || m.label || m.tool;
  const dl = $('#cDetails');
  dl.replaceChildren();
  for (const [k, v] of Object.entries(m.input || {})) {
    if (v === undefined || v === null || v === '') continue;
    const dt = document.createElement('dt');
    dt.textContent = k.replace(/_/g, ' ');
    const dd = document.createElement('dd');
    dd.textContent = typeof v === 'string' ? v : JSON.stringify(v);
    dl.append(dt, dd);
  }
  dl.hidden = !dl.children.length;
  $('#confirm').hidden = false;
  S.phase = 'confirm';
  chime(660, 0.16);
  speak(`Confirm: ${m.summary}. Say yes or no.`, { force: true });
  syncRec();
  if (navigator.vibrate) navigator.vibrate(80);
}
function hideConfirm(id) {
  if (id && currentConfirm && currentConfirm.id !== id) return;
  currentConfirm = null;
  $('#confirm').hidden = true;
  if (S.phase === 'confirm') S.phase = 'wake';
  syncRec();
}
function answerConfirm(approved) {
  if (!currentConfirm) return;
  sendWs({ type: 'confirm_response', id: currentConfirm.id, approved });
  addMsg('system', approved ? `Approved: ${currentConfirm.summary}` : `Declined: ${currentConfirm.summary}`);
  stopSpeaking();
  hideConfirm();
}

/* ---------- incoming events ---------- */
function handle(m) {
  switch (m.type) {
    case 'hello':
      S.name = m.name || '';
      setChip('#phoneChip', m.phone);
      setVoiceStatus(m.voice);
      loadVoiceList();
      break;
    case 'voice':
      setVoiceStatus(m);
      break;
    case 'phone':
      setChip('#phoneChip', m.connected);
      toast(m.connected ? 'Phone connected' : 'Phone disconnected', 2500);
      break;
    case 'working':
      S.busy = true;
      updateOrb();
      break;
    case 'status':
      setStatus(`${m.text}…`);
      break;
    case 'assistant':
      addMsg('jarvis', m.text);
      speak(m.text);
      break;
    case 'notify':
      addMsg('system', m.text);
      chime(740, 0.14);
      speak(m.text);
      break;
    case 'error':
      addMsg('error', m.text);
      speak('Sorry, something went wrong.');
      break;
    case 'idle':
      S.busy = false;
      updateOrb();
      break;
    case 'confirm':
      showConfirm(m);
      break;
    case 'confirm_done':
      hideConfirm(m.id);
      break;
  }
}

/* ---------- controls ---------- */
$('#form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#input');
  sendUser(input.value);
  input.value = '';
});
$('#micBtn').addEventListener('click', () => {
  ensureStarted();
  if (!SR) { toast('This browser has no speech recognition. Use Chrome on Android or desktop.'); return; }
  if (S.phase === 'command') { leaveCommand(); syncRec(); return; }
  stopSpeaking();
  enterCommand();
});
$('#orbBtn').addEventListener('click', () => {
  if (S.speaking) { stopSpeaking(); syncRec(); } else { unlockAudio(); $('#micBtn').click(); }
});
$('#wakeBtn').addEventListener('click', () => setWake(!S.wake));
$('#approveBtn').addEventListener('click', () => answerConfirm(true));
$('#denyBtn').addEventListener('click', () => answerConfirm(false));

function setWake(on) {
  S.wake = on;
  store.set('wake', on);
  $('#wakeBtn').setAttribute('aria-pressed', String(on));
  $('#wakeChk').checked = on;
  syncRec();
}

/* ---------- settings ---------- */
const settingsDlg = $('#settings');
const recDlg = $('#recDlg');
function fillVoices() {
  const sel = $('#voice');
  const voices = synth ? synth.getVoices() : [];
  const base = S.lang.toLowerCase().split('-')[0];
  const list = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  sel.replaceChildren(new Option('Automatic', ''));
  for (const v of (list.length ? list : voices)) sel.add(new Option(`${v.name} (${v.lang})`, v.name));
  sel.value = S.voiceName;
}
if (synth) synth.onvoiceschanged = fillVoices;

function neuralVoiceFor() {
  // Keep the chosen online voice only while it matches the speech language; otherwise the server picks one.
  return S.neuralVoice && S.neuralVoice.toLowerCase().startsWith(`${langBase()}-`) ? S.neuralVoice : '';
}

async function loadVoiceList() {
  if (!S.token) return;
  try {
    const res = await fetch(`/api/voice?lang=${encodeURIComponent(S.lang)}`, { headers: { Authorization: `Bearer ${S.token}` }, cache: 'no-store' });
    if (!res.ok) return;
    const j = await res.json();
    S.neuralVoices = (j.neural && j.neural.voices) || [];
    S.neuralDefault = (j.neural && j.neural.default) || '';
    setVoiceStatus(j.mine);
    if (settingsDlg.open) fillVoiceSettings();
  } catch { /* offline: the phone voice still works */ }
}

function fillVoiceSettings() {
  $('#engine').value = S.engine;
  const sel = $('#neuralVoice');
  const base = langBase();
  const list = S.neuralVoices.filter((v) => String(v.locale).toLowerCase().startsWith(`${base}-`));
  const def = S.neuralVoices.find((v) => v.id === S.neuralDefault);
  sel.replaceChildren(new Option(`Automatic${def ? ` – ${def.label}` : ''}`, ''));
  for (const v of list) sel.add(new Option(v.label, v.id));
  sel.value = list.some((v) => v.id === S.neuralVoice) ? S.neuralVoice : '';
  $('#neuralRow').hidden = S.engine === 'device';
  const st = $('#mineStatus');
  st.textContent = mineStatusText();
  st.className = `voice-status ${mineUsable() ? 'ok' : (S.voice && S.voice.busy) ? 'busy' : 'off'}`;
}

$('#settingsBtn').addEventListener('click', () => {
  $('#lang').value = S.lang;
  $('#rate').value = S.rate;
  $('#rateOut').textContent = `${S.rate.toFixed(2)}×`;
  $('#wakeChk').checked = S.wake;
  $('#speakChk').checked = S.speakReplies;
  fillVoices();
  fillVoiceSettings();
  loadVoiceList();
  settingsDlg.showModal();
});
$('#lang').addEventListener('change', (e) => {
  S.lang = e.target.value.trim() || 'en-US';
  store.set('lang', S.lang);
  fillVoices();
  fillVoiceSettings();
  loadVoiceList();
  updateVoiceChip();
  stopRec();
  syncRec();
});
$('#engine').addEventListener('change', (e) => {
  S.engine = e.target.value;
  store.set('engine', S.engine);
  engineDownUntil.mine = 0;
  engineDownUntil.neural = 0;
  lastEngine = '';
  updateVoiceChip();
  fillVoiceSettings();
});
$('#neuralVoice').addEventListener('change', (e) => { S.neuralVoice = e.target.value; store.set('neuralVoice', S.neuralVoice); });
$('#voice').addEventListener('change', (e) => { S.voiceName = e.target.value; store.set('voiceName', S.voiceName); });
$('#rate').addEventListener('input', (e) => {
  S.rate = parseFloat(e.target.value);
  store.set('rate', S.rate);
  $('#rateOut').textContent = `${S.rate.toFixed(2)}×`;
  player.playbackRate = S.rate;
});
$('#testVoiceBtn').addEventListener('click', () => {
  ensureStarted();
  stopSpeaking();
  speak(`Hello${S.name ? ` ${S.name}` : ''}. This is how I sound now. Say Jarvis whenever you need me.`, { force: true });
});

/* ---------- your voice sample: record in the app or upload a file ---------- */
const REC_SCRIPT = 'Good morning. I am recording this so my assistant can speak with my voice. '
  + 'Today I will check my email, look at the calendar, and call the team about the new project. '
  + 'The weather in Kisumu is warm, and the lake looks calm this morning. '
  + 'Please remind me at three o\'clock to send the invoice, and tell me if anything urgent comes in. '
  + 'Numbers like twenty-four, one hundred, and two thousand and twenty-six should sound natural too. '
  + 'Thank you. That is all for now, and I will speak to you later.';
let recState = null;

$('#recordBtn').addEventListener('click', () => {
  if (!navigator.mediaDevices || !window.MediaRecorder) { toast('This browser cannot record audio. Use Upload instead.'); return; }
  $('#recScript').textContent = REC_SCRIPT;
  $('#recTime').textContent = '0:00';
  $('#recLevel').style.width = '0%';
  $('#recGo').textContent = 'Start recording';
  $('#recGo').disabled = false;
  if (settingsDlg.open) settingsDlg.close();
  recDlg.showModal();
});
$('#recGo').addEventListener('click', () => { if (recState) stopSampleRecording(false); else startSampleRecording(); });
$('#recCancel').addEventListener('click', () => { stopSampleRecording(true); recDlg.close(); });
recDlg.addEventListener('close', () => stopSampleRecording(true));

async function startSampleRecording() {
  ensureStarted();
  stopSpeaking();
  S.recording = true; // the speech recognizer and the recorder can't share the mic on Android
  syncRec();
  $('#recGo').disabled = true;
  await new Promise((r) => setTimeout(r, 350));
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true } });
  } catch {
    S.recording = false;
    syncRec();
    $('#recGo').disabled = false;
    toast('Allow the microphone to record your voice.', 5000);
    return;
  }
  const mr = new MediaRecorder(stream);
  const st = { stream, mr, parts: [], t0: Date.now(), cancelled: false, raf: 0, timer: 0, src: null };
  recState = st;
  mr.ondataavailable = (e) => { if (e.data && e.data.size) st.parts.push(e.data); };
  mr.onstop = () => finishSampleRecording(st);
  mr.start(1000);
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    st.src = src;
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (recState !== st) return;
      an.getFloatTimeDomainData(buf);
      let pk = 0;
      for (const v of buf) pk = Math.max(pk, Math.abs(v));
      $('#recLevel').style.width = `${Math.min(100, pk * 130)}%`;
      st.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* meter is optional */ }
  st.timer = setInterval(() => {
    const s = Math.floor((Date.now() - st.t0) / 1000);
    $('#recTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${s < 30 ? '  · keep reading to 0:30' : '  · you can stop any time'}`;
    if (s >= 90) stopSampleRecording(false);
  }, 250);
  $('#recGo').textContent = 'Stop and save';
  $('#recGo').disabled = false;
}

function stopSampleRecording(cancel) {
  const st = recState;
  if (!st) return;
  st.cancelled = !!cancel;
  clearInterval(st.timer);
  cancelAnimationFrame(st.raf);
  try { if (st.src) st.src.disconnect(); } catch { /* ignore */ }
  try { if (st.mr.state !== 'inactive') st.mr.stop(); else finishSampleRecording(st); } catch { finishSampleRecording(st); }
  st.stream.getTracks().forEach((t) => t.stop());
}

async function finishSampleRecording(st) {
  if (st.finished) return;
  st.finished = true;
  if (recState === st) recState = null;
  S.recording = false;
  syncRec();
  if (st.cancelled) return;
  const secs = (Date.now() - st.t0) / 1000;
  if (secs < 15) {
    toast('That was a bit short. Record at least 20 seconds (30 or more is best).', 6000);
    $('#recGo').textContent = 'Start recording';
    return;
  }
  if (recDlg.open) recDlg.close();
  await uploadSample(new Blob(st.parts, { type: st.mr.mimeType || 'audio/webm' }));
}

$('#uploadBtn').addEventListener('click', () => $('#sampleFile').click());
$('#sampleFile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) await uploadSample(f);
});

async function uploadSample(blob) {
  toast('Preparing your voice sample…', 10000);
  try {
    const wav = await toWav24k(blob);
    const res = await fetch('/api/voice/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', Authorization: `Bearer ${S.token}` },
      body: wav,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
    setVoiceStatus(j.mine);
    toast(j.mine && j.mine.connected
      ? 'Saved. Your laptop is learning the new voice (about a minute).'
      : 'Saved. Your voice is learnt as soon as the laptop voice worker connects.', 7000);
  } catch (err) {
    toast(`Could not save the voice sample: ${err.message}`, 8000);
  }
}

// Any audio the browser can play (webm, m4a, mp3, wav) -> 24 kHz mono 16-bit WAV, up to 3 minutes.
async function toWav24k(blob) {
  const raw = await blob.arrayBuffer();
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await audioCtx.decodeAudioData(raw.slice(0)); } catch { throw new Error('this audio format can’t be read here; try a WAV, MP3 or M4A file'); }
  if (decoded.duration < 10) throw new Error('the recording is shorter than 10 seconds');
  const secs = Math.min(decoded.duration, 180);
  const off = new OfflineAudioContext(1, Math.ceil(secs * 24000), 24000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const ab = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(ab);
  const tag = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

$('#wakeChk').addEventListener('change', (e) => setWake(e.target.checked));
$('#speakChk').addEventListener('change', (e) => { S.speakReplies = e.target.checked; store.set('speak', S.speakReplies); if (!S.speakReplies) stopSpeaking(); });
$('#clearBtn').addEventListener('click', () => { sendWs({ type: 'reset' }); log.replaceChildren(); });

$('#googleBtn').addEventListener('click', () => { window.open(`/auth/google?token=${encodeURIComponent(S.token)}`, '_blank'); });

const tokenDlg = $('#tokenDlg');
function openTokenDialog() {
  $('#tokenInput').value = '';
  if (settingsDlg.open) settingsDlg.close();
  if (!tokenDlg.open) tokenDlg.showModal();
}
$('#tokenBtn').addEventListener('click', openTokenDialog);
$('#tokenForm').addEventListener('submit', () => {
  const t = $('#tokenInput').value.trim();
  if (!t) return;
  S.token = t;
  try { localStorage.setItem('jarvis_token', t); } catch { /* ignore */ }
  retry = 0;
  if (ws) { ws.onclose = null; try { ws.close(); } catch { /* ignore */ } }
  connect();
});

let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  installEvent = null;
  $('#installBtn').hidden = true;
});

/* ---------- start ---------- */
function ensureStarted() {
  if (S.started) return;
  S.started = true;
  $('#start').hidden = true;
  unlockAudio();
  chime(660, 0.08);
  $('#wakeBtn').setAttribute('aria-pressed', String(S.wake));
  syncRec();
  if (!SR) toast('Speech recognition isn’t supported in this browser. You can still type. Use Chrome for voice.', 7000);
  const hi = S.name ? `Online. How can I help, ${S.name}?` : 'Online. How can I help?';
  speak(hi);
}
$('#startBtn').addEventListener('click', ensureStarted);

if (!window.isSecureContext) $('#secureWarn').hidden = false;
setChip('#connChip', false);
setChip('#phoneChip', false);
updateVoiceChip();
updateOrb();
connect();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
