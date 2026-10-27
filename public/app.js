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
  voiceName: store.get('voiceName', ''),
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

/* ---------- text to speech ---------- */
const synth = window.speechSynthesis;
const speechQueue = [];

function toSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_#`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function chunk(text, max = 180) {
  const parts = text.match(/[^.!?;:\n]+[.!?;:]?\s*/g) || [text];
  const out = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > max && cur) { out.push(cur.trim()); cur = ''; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function pickVoice() {
  const voices = synth ? synth.getVoices() : [];
  if (S.voiceName) { const v = voices.find((x) => x.name === S.voiceName); if (v) return v; }
  const base = S.lang.toLowerCase().split('-')[0];
  return voices.find((v) => v.lang.toLowerCase() === S.lang.toLowerCase())
    || voices.find((v) => v.lang.toLowerCase().startsWith(base))
    || null;
}
function speak(text, { force = false } = {}) {
  if (!synth || (!S.speakReplies && !force)) return;
  const clean = toSpeech(text);
  if (!clean) return;
  speechQueue.push(...chunk(clean));
  if (!S.speaking) nextSpeech();
}
function nextSpeech() {
  const t = speechQueue.shift();
  if (!t) {
    S.speaking = false;
    syncRec();
    return;
  }
  S.speaking = true;
  syncRec(); // pause the microphone so Jarvis doesn't hear himself
  const u = new SpeechSynthesisUtterance(t);
  u.lang = S.lang;
  u.rate = S.rate;
  const v = pickVoice();
  if (v) u.voice = v;
  u.onend = u.onerror = nextSpeech;
  synth.speak(u);
}
function stopSpeaking() {
  speechQueue.length = 0;
  try { synth && synth.cancel(); } catch { /* ignore */ }
  S.speaking = false;
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
  return !!SR && S.started && !S.speaking && !S.micBlocked && (S.wake || S.phase !== 'wake');
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
  if (S.speaking) { stopSpeaking(); syncRec(); } else { $('#micBtn').click(); }
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

$('#settingsBtn').addEventListener('click', () => {
  $('#lang').value = S.lang;
  $('#rate').value = S.rate;
  $('#rateOut').textContent = `${S.rate.toFixed(2)}×`;
  $('#wakeChk').checked = S.wake;
  $('#speakChk').checked = S.speakReplies;
  fillVoices();
  settingsDlg.showModal();
});
$('#lang').addEventListener('change', (e) => {
  S.lang = e.target.value.trim() || 'en-US';
  store.set('lang', S.lang);
  fillVoices();
  stopRec();
  syncRec();
});
$('#voice').addEventListener('change', (e) => { S.voiceName = e.target.value; store.set('voiceName', S.voiceName); });
$('#rate').addEventListener('input', (e) => {
  S.rate = parseFloat(e.target.value);
  store.set('rate', S.rate);
  $('#rateOut').textContent = `${S.rate.toFixed(2)}×`;
});
$('#wakeChk').addEventListener('change', (e) => setWake(e.target.checked));
$('#speakChk').addEventListener('change', (e) => { S.speakReplies = e.target.checked; store.set('speak', S.speakReplies); if (!S.speakReplies) stopSpeaking(); });
$('#clearBtn').addEventListener('click', () => { sendWs({ type: 'reset' }); log.replaceChildren(); });

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
  try { synth && synth.speak(new SpeechSynthesisUtterance('')); } catch { /* unlock audio */ }
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
updateOrb();
connect();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
