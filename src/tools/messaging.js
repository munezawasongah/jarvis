import { config } from '../config.js';
import { findContact } from '../db.js';
import { callPhone, phoneConnected } from '../phoneBridge.js';

const looksLikeNumber = (s) => /^\+?[\d\s().-]{6,}$/.test(s.trim());

/** Name or number -> dialable number, using Jarvis's address book first, then the phone's contacts. */
export async function resolvePhone(to) {
  const raw = String(to).trim();
  if (looksLikeNumber(raw)) return raw.replace(/[^\d+]/g, '');
  const c = findContact(raw);
  if (c?.phone) return c.phone.replace(/[^\d+]/g, '');
  if (phoneConnected()) {
    const found = await callPhone('find_contact', { name: raw });
    if (Array.isArray(found) && found.length === 1) return found[0].number.replace(/[^\d+]/g, '');
    if (Array.isArray(found) && found.length > 1) {
      const options = found.map((f) => `${f.name} ${f.number}`).join('; ');
      throw new Error(`Several contacts match "${raw}": ${options}. Ask which one is meant.`);
    }
  }
  throw new Error(`I couldn't find a phone number for "${raw}". Ask for the number, or save it with contact_save.`);
}

const textSchema = (extra = {}) => ({
  type: 'object',
  properties: {
    to: { type: 'string', description: 'Contact name or phone number' },
    text: { type: 'string', description: 'The message, written in the user\'s voice' },
    ...extra,
  },
  required: ['to', 'text'],
});

export default [
  {
    name: 'sms_send',
    label: 'Sending a text message',
    risky: true,
    summarize: ({ to, text }) => `SMS to ${to}: "${text}"`,
    description: 'Send an SMS from the user\'s phone. `to` is a contact name or number. The user is asked to confirm first.',
    input_schema: textSchema(),
    async run({ to, text }) {
      const number = await resolvePhone(to);
      await callPhone('sms_send', { to: number, text });
      return `SMS sent to ${to}.`;
    },
  },
  {
    name: 'whatsapp_send',
    label: 'Sending a WhatsApp message',
    risky: true,
    summarize: ({ to, text }) => `WhatsApp to ${to}: "${text}"`,
    description: 'Send a WhatsApp message by driving the WhatsApp app on the phone (opens the chat and taps send). `to` is a contact name or number with country code. The user is asked to confirm first.',
    input_schema: textSchema(),
    async run({ to, text }) {
      const number = await resolvePhone(to);
      const result = await callPhone('whatsapp_send', { to: number, text }, 30000);
      return result || `WhatsApp message sent to ${to}.`;
    },
  },
  {
    name: 'telegram_send',
    label: 'Sending a Telegram message',
    risky: true,
    summarize: ({ to, text }) => `Telegram to ${to}: "${text}"`,
    description: 'Send a Telegram message through the Jarvis bot. Only works for people who have started the bot; save their chat id with contact_save (telegram_chat_id). The user is asked to confirm first.',
    input_schema: textSchema(),
    async run({ to, text }) {
      if (!config.telegramToken) throw new Error('Telegram is not set up (TELEGRAM_BOT_TOKEN is missing).');
      const c = findContact(to);
      const chatId = /^-?\d+$/.test(String(to)) ? String(to) : c?.telegram_chat_id;
      if (!chatId) throw new Error(`No Telegram chat id saved for "${to}".`);
      const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(`Telegram refused the message: ${data.description || res.status}`);
      return `Telegram message sent to ${to}.`;
    },
  },
];
