import crypto from 'node:crypto';
import { broadcast } from './hub.js';

// Risky actions (sending messages, running commands, ...) wait here until the user approves
// on one of their screens. No screen connected, or no answer in time => denied.
const pending = new Map();

export function requestConfirmation({ tool, label, summary, input }, timeoutMs = 120000) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const msg = { type: 'confirm', id, tool, label, summary, input };
    const reached = broadcast(msg);
    if (!reached) return resolve({ approved: false, reason: 'no_client' });
    const timer = setTimeout(() => finish(id, false, 'timeout'), timeoutMs);
    pending.set(id, { resolve, timer, msg });
  });
}

/** Confirmations still waiting for an answer; replayed to a screen that connects (or reconnects) meanwhile. */
export function pendingConfirmations() {
  return [...pending.values()].map((p) => p.msg);
}

function finish(id, approved, reason) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  broadcast({ type: 'confirm_done', id, approved });
  p.resolve({ approved, reason });
  return true;
}

export function resolveConfirmation(id, approved) {
  return finish(id, !!approved, approved ? 'approved' : 'denied');
}

export function pendingCount() {
  return pending.size;
}
