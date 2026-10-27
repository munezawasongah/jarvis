import { db, save, nextId } from '../db.js';
import { parseWhen, fmtLocal } from '../time.js';

export default [
  {
    name: 'task_add',
    label: 'Adding a task',
    description: 'Add an item to the to-do list. `due` is optional, local ISO like 2026-10-30 or 2026-10-30T17:00.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
    run({ title, due, notes }) {
      const task = { id: nextId(), title, notes: notes || '', done: false, created: new Date().toISOString() };
      if (due) task.due = parseWhen(due).toISOString();
      db.tasks.push(task);
      save();
      return `Added task #${task.id}: ${title}${task.due ? ` (due ${fmtLocal(new Date(task.due))})` : ''}.`;
    },
  },
  {
    name: 'task_list',
    label: 'Checking your tasks',
    description: 'List tasks. status: "open" (default), "done" or "all".',
    input_schema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'done', 'all'] } },
    },
    run({ status = 'open' }) {
      const rows = db.tasks
        .filter((t) => status === 'all' || (status === 'done' ? t.done : !t.done))
        .sort((a, b) => (a.due || '9').localeCompare(b.due || '9'))
        .map((t) => ({ id: t.id, title: t.title, due: t.due ? fmtLocal(new Date(t.due)) : null, done: t.done, notes: t.notes || undefined }));
      return rows.length ? rows : 'No tasks.';
    },
  },
  {
    name: 'task_done',
    label: 'Completing a task',
    description: 'Mark a task done by id, or by part of its title.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number' }, title: { type: 'string', description: 'Part of the title, if id unknown' } },
    },
    run({ id, title }) {
      const t = db.tasks.find((x) => !x.done && (id ? x.id === id : title && x.title.toLowerCase().includes(title.toLowerCase())));
      if (!t) return 'No matching open task.';
      t.done = true;
      t.completed = new Date().toISOString();
      save();
      return `Marked done: ${t.title}.`;
    },
  },
  {
    name: 'reminder_set',
    label: 'Setting a reminder',
    description: 'Set a reminder that Jarvis will announce on screen/voice and send to the phone at the given time. `when` is local ISO like 2026-10-28T15:00.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string' }, when: { type: 'string' } },
      required: ['text', 'when'],
    },
    run({ text, when }) {
      const at = parseWhen(when);
      if (at.getTime() < Date.now() - 60000) throw new Error('That time is in the past.');
      const r = { id: nextId(), text, at: at.toISOString(), fired: false };
      db.reminders.push(r);
      save();
      return `Reminder #${r.id} set for ${fmtLocal(at)}: ${text}.`;
    },
  },
  {
    name: 'reminder_list',
    label: 'Checking reminders',
    description: 'List upcoming reminders.',
    input_schema: { type: 'object', properties: {} },
    run() {
      const rows = db.reminders.filter((r) => !r.fired).map((r) => ({ id: r.id, text: r.text, when: fmtLocal(new Date(r.at)) }));
      return rows.length ? rows : 'No upcoming reminders.';
    },
  },
];
