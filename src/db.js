import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Tiny JSON-file store: plenty for one person's contacts, tasks, reminders and facts.
const file = path.join(config.dataDir, 'db.json');

export const db = { memory: {}, contacts: {}, tasks: [], reminders: [], meta: {}, nextId: 1 };

try {
  Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8')));
} catch {
  /* first run */
}

export function save() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function nextId() {
  const id = db.nextId++;
  save();
  return id;
}

export function findContact(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const entries = Object.entries(db.contacts);
  const exact = entries.find(([name]) => name.toLowerCase() === q);
  if (exact) return { name: exact[0], ...exact[1] };
  const partial = entries.find(([name]) => name.toLowerCase().includes(q) || q.includes(name.toLowerCase()));
  return partial ? { name: partial[0], ...partial[1] } : null;
}
