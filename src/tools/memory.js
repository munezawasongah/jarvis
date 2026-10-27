import { db, save, findContact } from '../db.js';

export default [
  {
    name: 'remember',
    label: 'Saving that to memory',
    description: 'Save a lasting fact or preference about the user (e.g. "prefers meetings after 10am", "wife is called Amina"). Overwrites the same key.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short label, e.g. "preferred meeting time"' },
        value: { type: 'string', description: 'The fact to remember' },
      },
      required: ['key', 'value'],
    },
    run({ key, value }) {
      db.memory[key] = value;
      save();
      return `Remembered: ${key}.`;
    },
  },
  {
    name: 'forget',
    label: 'Removing a memory',
    description: 'Delete a saved fact by its key.',
    input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run({ key }) {
      const existed = key in db.memory;
      delete db.memory[key];
      save();
      return existed ? `Forgot: ${key}.` : `Nothing saved under "${key}".`;
    },
  },
  {
    name: 'contact_save',
    label: 'Saving a contact',
    description: 'Create or update a contact in Jarvis\'s own address book. Use phone in international format (+<country code><number>).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        email: { type: 'string' },
        telegram_chat_id: { type: 'string', description: 'Telegram chat id, if the person has started the Jarvis bot' },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
    run({ name, ...fields }) {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
      db.contacts[name] = { ...(db.contacts[name] || {}), ...clean };
      save();
      return `Saved contact ${name}.`;
    },
  },
  {
    name: 'contact_find',
    label: 'Looking up a contact',
    description: 'Look up a person in Jarvis\'s address book by name (partial match). Returns phone, email and notes if known.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run({ query }) {
      const c = findContact(query);
      return c || `No contact matching "${query}" in the address book. Try phone_find_contact for the phone's contacts.`;
    },
  },
];
