import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.JARVIS_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// The access token protects everything Jarvis can do (email, phone, laptop).
// If you don't set JARVIS_TOKEN, one is generated on first run and saved to data/token.txt.
function loadToken() {
  if (process.env.JARVIS_TOKEN) return process.env.JARVIS_TOKEN;
  const file = path.join(dataDir, 'token.txt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  return token;
}

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  root,
  dataDir,
  publicDir: path.join(root, 'public'),
  port: Number(process.env.PORT || 3000),
  token: loadToken(),
  model: process.env.JARVIS_MODEL || 'llama-3.3-70b-versatile',
  // Any OpenAI-compatible chat API. Defaults to Groq.
  llm: {
    apiKey: process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '',
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  },
  tavilyKey: process.env.TAVILY_API_KEY || '',
  userName: process.env.USER_NAME || 'Diego',
  tz: process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
  maxSteps: Number(process.env.MAX_STEPS || 12),
  // Tools listed here skip the confirmation prompt. Leave empty until you trust Jarvis.
  autoApprove: new Set(list(process.env.AUTO_APPROVE)),
  briefingTime: process.env.BRIEFING_TIME || '', // e.g. "07:30"; empty disables
  workStart: process.env.WORK_START || '09:00',
  workEnd: process.env.WORK_END || '17:00',
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  // Public HTTPS address of this server (used for the Google sign-in redirect). Railway sets RAILWAY_PUBLIC_DOMAIN.
  publicUrl: (process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')).replace(/\/+$/, ''),
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  // Laptop tools run on whichever machine runs this server. Set to 0 to disable them.
  laptopEnabled: process.env.LAPTOP_TOOLS !== '0',
};
