import crypto from 'node:crypto';

// The Android companion app connects here over WebSocket (/phone) and executes commands.
let sock = null;
let info = {};
const waiting = new Map();
let changeListener = () => {};

export function onPhoneChange(fn) {
  changeListener = fn;
}

export function phoneConnected() {
  return !!sock && sock.readyState === 1;
}

export function phoneInfo() {
  return info;
}

export function attachPhone(ws) {
  if (sock && sock !== ws) {
    try { sock.close(4000, 'replaced by a newer connection'); } catch { /* ignore */ }
  }
  sock = ws;
  info = {};
  changeListener(true);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'hello') {
      info = { device: m.device, battery: m.battery, version: m.version };
    } else if (m.type === 'result') {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.ok) w.resolve(m.result);
      else w.reject(new Error(m.error || 'The phone reported an error.'));
    }
  });

  ws.on('close', () => {
    if (sock !== ws) return;
    sock = null;
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.reject(new Error('The phone disconnected.'));
      waiting.delete(id);
    }
    changeListener(false);
  });
}

export function callPhone(action, params = {}, timeoutMs = 20000) {
  if (!phoneConnected()) {
    return Promise.reject(new Error('The phone companion app is not connected.'));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`The phone did not answer "${action}" in time.`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    sock.send(JSON.stringify({ type: 'command', id, action, params }));
  });
}
