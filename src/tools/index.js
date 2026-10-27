import { config } from '../config.js';
import memory from './memory.js';
import tasks from './tasks.js';
import email from './email.js';
import calendar from './calendar.js';
import messaging from './messaging.js';
import phone from './phone.js';
import laptop from './laptop.js';
import web from './web.js';

export const tools = [...memory, ...tasks, ...email, ...calendar, ...messaging, ...phone, ...laptop, ...web];

const byName = new Map();
for (const t of tools) {
  if (byName.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  byName.set(t.name, t);
}

export const getTool = (name) => byName.get(name);

// What the model sees (no run functions or UI metadata).
export const toolDefs = tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));

export function needsConfirmation(tool, input) {
  if (config.autoApprove.has(tool.name)) return false;
  return typeof tool.risky === 'function' ? !!tool.risky(input || {}) : !!tool.risky;
}
