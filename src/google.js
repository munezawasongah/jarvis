import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';
import { config } from './config.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar',
];

export const REDIRECT_PORT = 53682;
export const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;
export const tokenFile = path.join(config.dataDir, 'google-token.json');

export function googleReady() {
  return !!(config.google.clientId && config.google.clientSecret && fs.existsSync(tokenFile));
}

export function newOAuthClient(redirectUri = REDIRECT_URI) {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, redirectUri);
}

let cached;

/** Persist tokens from a completed sign-in and drop the cached client so the next call uses them. */
export function saveTokens(tokens) {
  fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  cached = undefined;
}
export function getAuth() {
  if (!googleReady()) {
    throw new Error('Google is not connected yet. Open Jarvis settings and tap Connect Google (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set on the server).');
  }
  if (cached) return cached;
  const auth = newOAuthClient();
  auth.setCredentials(JSON.parse(fs.readFileSync(tokenFile, 'utf8')));
  // Refresh tokens are only sent once; keep them when new access tokens arrive.
  auth.on('tokens', (t) => {
    const current = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
    fs.writeFileSync(tokenFile, JSON.stringify({ ...current, ...t }, null, 2), { mode: 0o600 });
  });
  cached = auth;
  return auth;
}

export const gmail = () => google.gmail({ version: 'v1', auth: getAuth() });
export const calendar = () => google.calendar({ version: 'v3', auth: getAuth() });
