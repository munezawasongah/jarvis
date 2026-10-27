import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { Session } from './session.js';
import { clients, broadcast } from './hub.js';
import { resolveConfirmation, pendingConfirmations } from './confirm.js';
import { attachPhone, onPhoneChange, phoneConnected } from './phoneBridge.js';
import { googleReady } from './google.js';
import { startScheduler } from './scheduler.js';
import { tools } from './tools/index.js';

const digest = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest();
const tokenOk = (t) => crypto.timingSafeEqual(digest(t), digest(config.token));

export function friendlyError(err) {
  const msg = String(err?.message || '');
  if (err?.status === 401 || /authentication|api key|auth token/i.test(msg)) {
    return config.provider === 'gemini'
      ? 'The Gemini API key is missing or invalid. Set GEMINI_API_KEY on the server.'
      : 'The Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY on the server.';
  }
  if (err?.status === 429) return 'The AI service is rate limited right now. Try again in a moment.';
  if (err?.status >= 500) return 'The AI service is having trouble. Try again shortly.';
  return msg || 'Something went wrong.';
}

export function createServer({ client } = {}) {
  const session = new Session({ client });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  const auth = (req, res, next) => {
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (tokenOk(bearer || req.query.token)) return next();
    res.status(401).json({ error: 'Unauthorized' });
  };

  app.get('/health', (req, res) => {
    res.json({ ok: true, phone: phoneConnected(), google: googleReady(), tools: tools.length });
  });

  // Plain HTTP entry point (handy for testing and automations). Confirmations still go to connected screens.
  app.post('/api/chat', auth, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Missing "text".' });
    try {
      const reply = await session.ask(text);
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: friendlyError(err) });
    }
  });

  app.use(express.static(config.publicDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!tokenOk(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const accept = (handler) => (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      handler(ws);
    };
    if (url.pathname === '/ws') wss.handleUpgrade(req, socket, head, accept(onClient));
    else if (url.pathname === '/phone') wss.handleUpgrade(req, socket, head, accept(attachPhone));
    else socket.destroy();
  });

  function onClient(ws) {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'hello', name: config.userName, phone: phoneConnected(), google: googleReady() }));
    for (const m of pendingConfirmations()) ws.send(JSON.stringify(m));

    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'user' && typeof m.text === 'string' && m.text.trim()) {
        broadcast({ type: 'working' });
        session
          .ask(m.text.trim())
          .catch((err) => broadcast({ type: 'error', text: friendlyError(err) }))
          .finally(() => broadcast({ type: 'idle' }));
      } else if (m.type === 'confirm_response' && typeof m.id === 'string') {
        resolveConfirmation(m.id, m.approved === true);
      } else if (m.type === 'reset') {
        session.reset();
        broadcast({ type: 'notify', text: 'Conversation cleared.' });
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  }

  // Keep connections alive through proxies and drop dead ones.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 25000);
  heartbeat.unref?.();

  onPhoneChange((connected) => broadcast({ type: 'phone', connected }));

  let stopScheduler = () => {};
  return {
    app,
    server,
    session,
    listen(port = config.port, host = '0.0.0.0') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          stopScheduler = startScheduler(session);
          resolve(server.address().port);
        });
      });
    },
    close() {
      stopScheduler();
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
