// End-to-end self test with a scripted fake model (no API key, Google or phone needed).
// Exercises: tool registry, time helpers, agent loop, confirmation gate, WebSocket UI flow,
// phone bridge, HTTP auth and history trimming.  Run: npm test
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
process.env.JARVIS_DATA_DIR = tmp;
process.env.JARVIS_TOKEN = 'testtoken';
process.env.TIMEZONE = 'Africa/Dar_es_Salaam';
process.env.USER_NAME = 'Tester';
process.env.GOOGLE_CLIENT_ID = 'test-client-id';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.PUBLIC_URL = 'https://jarvis.example.com';
process.env.VOICE_LIST_REFRESH = '0'; // no network in tests

const { createServer } = await import('../src/app.js');
const { tools, toolDefs } = await import('../src/tools/index.js');
const { parseWhen, localParts, localToDate } = await import('../src/time.js');
const { trimHistory } = await import('../src/agent.js');
const { db } = await import('../src/db.js');

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log('  ok  ', name);
  } catch (err) {
    console.error('  FAIL', name, '\n      ', err.stack || err);
    process.exitCode = 1;
  }
};

// ---------- pure units ----------
await test('tool registry is valid', () => {
  assert.ok(tools.length >= 30, `expected many tools, got ${tools.length}`);
  const names = new Set();
  for (const t of toolDefs) {
    assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(!names.has(t.name), `duplicate ${t.name}`);
    names.add(t.name);
    assert.ok(t.description.length > 20, `${t.name} needs a description`);
    assert.equal(t.input_schema.type, 'object');
  }
  for (const must of ['gmail_send', 'sms_send', 'calendar_create', 'laptop_run', 'phone_open_app', 'task_add']) {
    assert.ok(names.has(must), `missing ${must}`);
  }
});

await test('timezone helpers', () => {
  assert.equal(parseWhen('2026-10-28T15:00').toISOString(), '2026-10-28T12:00:00.000Z');
  assert.equal(parseWhen('2026-10-28T15:00:00+01:00').toISOString(), '2026-10-28T14:00:00.000Z');
  assert.equal(parseWhen('2026-10-28').toISOString(), '2026-10-27T21:00:00.000Z');
  const p = localParts(new Date('2026-10-28T12:00:00Z'));
  assert.deepEqual([p.dateStr, p.hhmm], ['2026-10-28', '15:00']);
  assert.equal(localToDate(2026, 10, 28, 15, 0).toISOString(), '2026-10-28T12:00:00.000Z');
  assert.throws(() => parseWhen('next tuesday'), /Could not understand/);
});

await test('trimHistory never splits tool pairs', () => {
  const h = [];
  for (let i = 0; i < 30; i++) {
    h.push({ role: 'user', content: `q${i}` });
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: `t${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }] });
    h.push({ role: 'tool', tool_call_id: `t${i}`, content: 'ok' });
    h.push({ role: 'assistant', content: 'done' });
  }
  trimHistory(h, 40);
  assert.ok(h.length <= 40 && h.length > 30);
  assert.equal(h[0].role, 'user');
});

await test('tool safety rules', async () => {
  const { needsConfirmation, getTool } = await import('../src/tools/index.js');
  assert.ok(needsConfirmation(getTool('gmail_send'), {}));
  assert.ok(needsConfirmation(getTool('laptop_run'), { command: 'ls' }));
  assert.ok(!needsConfirmation(getTool('task_add'), {}));
  assert.ok(needsConfirmation(getTool('phone_tap'), { text: 'Send' }));
  assert.ok(!needsConfirmation(getTool('phone_tap'), { text: 'Settings' }));
  assert.ok(needsConfirmation(getTool('calendar_create'), { attendees: ['a@b.c'] }));
  assert.ok(!needsConfirmation(getTool('calendar_create'), {}));
  // secrets stay unreadable
  const read = getTool('laptop_read_file');
  assert.throws(() => read.run({ path: '~/.ssh/id_rsa' }), /protected/);
  assert.throws(() => read.run({ path: path.join(tmp, 'token.txt') }), /protected/);
});

await test('web_fetch refuses private and internal addresses', async () => {
  const { getTool } = await import('../src/tools/index.js');
  const run = getTool('web_fetch').run;
  for (const u of ['http://127.0.0.1:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'http://10.0.0.5/', 'http://[::1]/', 'file:///etc/passwd']) {
    await assert.rejects(run({ url: u }), /not allowed|Only http|find the site/, u);
  }
});

// ---------- server flows ----------
const fake = {
  script: [],
  seen: [],
  async chat(req) {
    fake.seen.push(JSON.parse(JSON.stringify(req)));
    const next = fake.script.shift();
    if (!next) throw new Error('fake model script exhausted');
    return typeof next === 'function' ? next(req) : next;
  },
};
const toolUse = (name, input, id = 'call_' + Math.random().toString(36).slice(2, 8)) => ({
  finish_reason: 'tool_calls',
  message: {
    role: 'assistant',
    content: 'On it.',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }],
  },
});
const say = (text) => ({ finish_reason: 'stop', message: { role: 'assistant', content: text } });

const jarvis = createServer({ client: fake });
const port = await jarvis.listen(0, '127.0.0.1');
const base = `ws://127.0.0.1:${port}`;

function connect(pathname) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${pathname}?token=testtoken`);
    ws.msgs = [];
    ws.on('message', (raw) => ws.msgs.push(JSON.parse(raw)));
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const waitFor = async (ws, pred, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = ws.msgs.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting; saw: ' + JSON.stringify(ws.msgs.map((m) => m.type)));
};
const send = (ws, obj) => ws.send(JSON.stringify(obj));

await test('google sign-in: protected, redirects to Google with the right callback, rejects bad state', async () => {
  const origin = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${origin}/auth/google`, { redirect: 'manual' })).status, 401);
  const r = await fetch(`${origin}/auth/google?token=testtoken`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'accounts.google.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://jarvis.example.com/auth/google/callback');
  assert.equal(loc.searchParams.get('access_type'), 'offline');
  assert.match(loc.searchParams.get('scope'), /gmail\.modify/);
  assert.equal((await fetch(`${origin}/auth/google/callback?code=x&state=forged`)).status, 400);
});

const ui = await connect('/ws');
await waitFor(ui, (m) => m.type === 'hello');

await test('auth rejects bad tokens', async () => {
  await assert.rejects(new Promise((res, rej) => {
    const ws = new WebSocket(`${base}/ws?token=nope`);
    ws.once('open', res);
    ws.once('error', rej);
  }));
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  assert.equal(r.status, 401);
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.ok, true);
});

await test('plain reply is spoken back', async () => {
  ui.msgs.length = 0;
  fake.script = [say('Good morning, Tester.')];
  send(ui, { type: 'user', text: 'hello' });
  const m = await waitFor(ui, (x) => x.type === 'assistant' && x.final);
  assert.equal(m.text, 'Good morning, Tester.');
  assert.match(fake.seen.at(-1).system, /Tester/);
});

await test('safe tool runs without confirmation (task_add)', async () => {
  ui.msgs.length = 0;
  fake.script = [toolUse('task_add', { title: 'Buy cables', due: '2026-10-30T17:00' }), say('Added.')];
  send(ui, { type: 'user', text: 'add a task to buy cables' });
  await waitFor(ui, (x) => x.type === 'assistant' && x.final);
  assert.equal(db.tasks.length, 1);
  assert.equal(db.tasks[0].title, 'Buy cables');
  assert.ok(!ui.msgs.some((m) => m.type === 'confirm'));
});

await test('risky tool waits for approval, then runs', async () => {
  ui.msgs.length = 0;
  fake.script = [toolUse('laptop_run', { command: 'echo jarvis-ok' }), say('Ran it.')];
  send(ui, { type: 'user', text: 'run echo' });
  const c = await waitFor(ui, (x) => x.type === 'confirm');
  assert.match(c.summary, /echo jarvis-ok/);
  assert.ok(!ui.msgs.some((m) => m.type === 'assistant' && m.final), 'must not finish before approval');
  send(ui, { type: 'confirm_response', id: c.id, approved: true });
  await waitFor(ui, (x) => x.type === 'assistant' && x.final);
  const result = fake.seen.at(-1).messages.at(-1);
  assert.match(result.content, /jarvis-ok/);
  assert.ok(!result.content.startsWith('ERROR'));
});

await test('declined action is not executed and model is told', async () => {
  ui.msgs.length = 0;
  const marker = path.join(tmp, 'should-not-exist.txt');
  fake.script = [toolUse('laptop_write_file', { path: marker, content: 'x' }), say('Okay, cancelled.')];
  send(ui, { type: 'user', text: 'write a file' });
  const c = await waitFor(ui, (x) => x.type === 'confirm');
  send(ui, { type: 'confirm_response', id: c.id, approved: false });
  await waitFor(ui, (x) => x.type === 'assistant' && x.final);
  assert.ok(!fs.existsSync(marker));
  const result = fake.seen.at(-1).messages.at(-1);
  assert.ok(result.content.startsWith('ERROR'));
  assert.match(result.content, /declined/);
});

await test('a pending confirmation is replayed to a screen that reconnects', async () => {
  ui.msgs.length = 0;
  fake.script = [toolUse('laptop_run', { command: 'echo replay-ok' }), say('Replayed.')];
  send(ui, { type: 'user', text: 'run echo' });
  const first = await waitFor(ui, (x) => x.type === 'confirm');
  ui.close();
  await new Promise((r) => setTimeout(r, 100));
  const again = await connect('/ws');
  const replay = await waitFor(again, (x) => x.type === 'confirm');
  assert.equal(replay.id, first.id);
  send(again, { type: 'confirm_response', id: replay.id, approved: true });
  await waitFor(again, (x) => x.type === 'assistant' && x.final);
  again.close();
  await new Promise((r) => setTimeout(r, 100));
});

await test('risky tool with no screen connected is denied (HTTP path)', async () => {
  ui.close();
  await new Promise((r) => setTimeout(r, 100));
  fake.script = [toolUse('laptop_run', { command: 'echo nope' }), say('Could not confirm.')];
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer testtoken' },
    body: JSON.stringify({ text: 'run echo' }),
  });
  const body = await r.json();
  assert.equal(body.reply, 'Could not confirm.');
  const result = fake.seen.at(-1).messages.at(-1);
  assert.match(result.content, /No screen was available/);
});

const ui2 = await connect('/ws');
await waitFor(ui2, (m) => m.type === 'hello');

await test('phone bridge: command goes to phone and result returns', async () => {
  const phone = await connect('/phone');
  await waitFor(ui2, (m) => m.type === 'phone' && m.connected === true);
  phone.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'command' && m.action === 'open_app') {
      assert.equal(m.params.name, 'WhatsApp');
      send(phone, { type: 'result', id: m.id, ok: true, result: 'Opened WhatsApp.' });
    }
  });
  ui2.msgs.length = 0;
  fake.script = [toolUse('phone_open_app', { name: 'WhatsApp' }), say('WhatsApp is open.')];
  send(ui2, { type: 'user', text: 'open whatsapp' });
  await waitFor(ui2, (x) => x.type === 'assistant' && x.final);
  const result = fake.seen.at(-1).messages.at(-1);
  assert.equal(result.content, 'Opened WhatsApp.');

  // sms: contact from the address book -> number goes to phone after confirmation
  db.contacts.Amina = { phone: '+255 700 000 111' };
  const smsSeen = new Promise((resolve) => {
    phone.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'command' && m.action === 'sms_send') {
        send(phone, { type: 'result', id: m.id, ok: true, result: 'sent' });
        resolve(m.params);
      }
    });
  });
  ui2.msgs.length = 0;
  fake.script = [toolUse('sms_send', { to: 'Amina', text: 'Running 10 minutes late.' }), say('Text sent.')];
  send(ui2, { type: 'user', text: 'text amina' });
  const c = await waitFor(ui2, (x) => x.type === 'confirm');
  assert.match(c.summary, /Amina/);
  send(ui2, { type: 'confirm_response', id: c.id, approved: true });
  const params = await smsSeen;
  assert.deepEqual(params, { to: '+255700000111', text: 'Running 10 minutes late.' });

  phone.close();
  await waitFor(ui2, (m) => m.type === 'phone' && m.connected === false);
});

await test('phone tools fail cleanly when phone is offline', async () => {
  ui2.msgs.length = 0;
  fake.script = [toolUse('phone_open_app', { name: 'Maps' }), say('The phone is not connected.')];
  send(ui2, { type: 'user', text: 'open maps' });
  await waitFor(ui2, (x) => x.type === 'assistant' && x.final);
  const result = fake.seen.at(-1).messages.at(-1);
  assert.ok(result.content.startsWith('ERROR'));
  assert.match(result.content, /not connected/);
});

await test('model/API failure surfaces as an error and history stays valid', async () => {
  ui2.msgs.length = 0;
  const before = jarvis.session.history.length;
  fake.script = [() => { const e = new Error('boom'); e.status = 401; throw e; }];
  send(ui2, { type: 'user', text: 'this will fail' });
  const err = await waitFor(ui2, (x) => x.type === 'error');
  assert.match(err.text, /API key/);
  assert.equal(jarvis.session.history.length, before);
});

await test('remember() feeds the next system prompt', async () => {
  ui2.msgs.length = 0;
  fake.script = [toolUse('remember', { key: 'meeting preference', value: 'after 10am' }), say('Noted.'), say('ok')];
  send(ui2, { type: 'user', text: 'I prefer meetings after ten' });
  await waitFor(ui2, (x) => x.type === 'assistant' && x.final);
  send(ui2, { type: 'user', text: 'what do you know' });
  await waitFor(ui2, (x) => x.type === 'assistant' && x.final && x.text === 'ok');
  assert.match(fake.seen.at(-1).system, /meeting preference: after 10am/);
});

// ---------- voice ----------
const http = `http://127.0.0.1:${port}`;
const makeWav = (seconds, rate = 24000) => {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 9) * 6000), 44 + i * 2);
  return b;
};
const tts = (body, token = 'testtoken') => fetch(`${http}/api/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

await test('voice: auth, validation, and clean 503 when the voice worker is offline', async () => {
  assert.equal((await tts({ text: 'hi', engine: 'mine' }, 'wrong')).status, 401);
  assert.equal((await tts({ text: '   ', engine: 'mine' })).status, 400);
  assert.equal((await tts({ text: 'hi', engine: 'robot' })).status, 400);
  assert.equal((await tts({ text: 'x'.repeat(1300), engine: 'neural' })).status, 413);
  assert.equal((await tts({ text: 'hi', engine: 'neural', voice: '<bad>' })).status, 400);
  const r = await tts({ text: 'hi', engine: 'mine' });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not running/);
  const info = await (await fetch(`${http}/api/voice?lang=sw-KE`, { headers: { Authorization: 'Bearer testtoken' } })).json();
  assert.equal(info.mine.connected, false);
  assert.equal(info.neural.default, 'sw-KE-RafikiNeural');
  assert.ok(info.neural.voices.some((v) => v.id === 'en-GB-RyanNeural'));
});

await test('voice: worker joins, Jarvis adopts its sample, speaks, caches, and pushes new samples', async () => {
  const worker = await connect('/voice');
  const sample = makeWav(8);
  let ttsCalls = 0;
  const gotSetVoice = [];
  worker.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'get_voice') send(worker, { type: 'voice_sample', sha: 'w1', wav_b64: sample.toString('base64') });
    if (m.type === 'tts') { ttsCalls++; send(worker, { type: 'audio', id: m.id, ok: true, wav_b64: makeWav(0.5).toString('base64') }); }
    if (m.type === 'set_voice') gotSetVoice.push(m);
  });
  send(worker, { type: 'hello', engine: 'pocket-tts', device: 'LAPTOP', ready: true, busy: false, cloning: true, languages: ['en'], sampleSha: 'w1', error: '' });
  const st = await waitFor(ui2, (m) => m.type === 'voice' && m.ready === true && m.device === 'LAPTOP');
  assert.equal(st.connected, true);
  // Jarvis had no sample, so it asked for the worker's one and stored it
  for (let i = 0; i < 40 && !fs.existsSync(path.join(tmp, 'voice', 'sample.wav')); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(path.join(tmp, 'voice', 'sample.wav')), 'sample adopted');

  const r1 = await tts({ text: 'Good evening, Evans.', engine: 'mine' });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('content-type'), 'audio/wav');
  assert.equal(r1.headers.get('x-voice-cached'), '0');
  const a1 = Buffer.from(await r1.arrayBuffer());
  assert.equal(a1.toString('ascii', 0, 4), 'RIFF');
  const r2 = await tts({ text: 'Good  evening, Evans. ', engine: 'mine' });
  assert.equal(r2.headers.get('x-voice-cached'), '1');
  assert.equal(ttsCalls, 1, 'second identical sentence served from cache');

  // A new sample recorded in the app is stored and taught to the worker
  const bad = await fetch(`${http}/api/voice/sample`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Authorization: 'Bearer testtoken' }, body: Buffer.from('not audio at all, definitely not a wav file header') });
  assert.equal(bad.status, 400);
  const short = await fetch(`${http}/api/voice/sample`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Authorization: 'Bearer testtoken' }, body: makeWav(2) });
  assert.equal(short.status, 400);
  const fresh = makeWav(12, 16000);
  const up = await fetch(`${http}/api/voice/sample`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', Authorization: 'Bearer testtoken' }, body: fresh });
  assert.equal(up.status, 200);
  const upj = await up.json();
  assert.equal(upj.mine.busy, true);
  for (let i = 0; i < 40 && !gotSetVoice.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(gotSetVoice.length, 1);
  assert.ok(Buffer.from(gotSetVoice[0].wav_b64, 'base64').equals(fresh));
  // while learning, "mine" is not used (and the cache key changed with the sample)
  assert.equal((await tts({ text: 'Good evening, Evans.', engine: 'mine' })).status, 503);
  send(worker, { type: 'status', ready: true, busy: false, sampleSha: gotSetVoice[0].sha, error: '' });
  await waitFor(ui2, (m) => m.type === 'voice' && m.ready === true && m.busy === false);
  const r3 = await tts({ text: 'Good evening, Evans.', engine: 'mine' });
  assert.equal(r3.headers.get('x-voice-cached'), '0');
  assert.equal(ttsCalls, 2);

  // A worker error is reported, not hung
  worker.removeAllListeners('message');
  worker.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'tts') send(worker, { type: 'audio', id: m.id, ok: false, error: 'model crashed' }); });
  const r4 = await tts({ text: 'Something new.', engine: 'mine' });
  assert.equal(r4.status, 502);
  assert.match((await r4.json()).error, /model crashed/);

  // A restarted worker with an old sample is sent the current one
  worker.close();
  await waitFor(ui2, (m) => m.type === 'voice' && m.connected === false);
  const w2 = await connect('/voice');
  const pushed = new Promise((resolve) => w2.on('message', (raw) => { const m = JSON.parse(raw); if (m.type === 'set_voice') resolve(m); }));
  send(w2, { type: 'hello', ready: true, cloning: true, languages: ['en'], sampleSha: 'something-old' });
  const m = await pushed;
  assert.ok(Buffer.from(m.wav_b64, 'base64').equals(fresh));
  w2.close();
  await waitFor(ui2, (x) => x.type === 'voice' && x.connected === false);
});

ui2.close();
await jarvis.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? '\nSome tests FAILED.' : `\nAll ${passed} tests passed.`);
process.exit(process.exitCode || 0);
