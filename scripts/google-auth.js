// One-time Google sign-in. Run on a machine with a browser: npm run auth:google
import http from 'node:http';
import fs from 'node:fs';
import { config } from '../src/config.js';
import { SCOPES, REDIRECT_PORT, REDIRECT_URI, tokenFile, newOAuthClient } from '../src/google.js';

if (!config.google.clientId || !config.google.clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README, step 3).');
  process.exit(1);
}

const auth = newOAuthClient();
const url = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
  if (u.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get('code');
  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }
  try {
    const { tokens } = await auth.getToken(code);
    fs.writeFileSync(tokenFile, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Jarvis is connected to Google. You can close this tab.');
    console.log('\nSaved', tokenFile);
    server.close();
  } catch (err) {
    res.writeHead(500).end('Token exchange failed: ' + err.message);
    console.error(err.message);
    server.close();
  }
});

server.listen(REDIRECT_PORT, () => {
  console.log(`Redirect URI (add this to your OAuth client): ${REDIRECT_URI}\n`);
  console.log('Open this URL and approve access:\n\n' + url + '\n');
});
