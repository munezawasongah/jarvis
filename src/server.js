import { config } from './config.js';
import { createServer } from './app.js';
import { tools } from './tools/index.js';
import { googleReady } from './google.js';

if (!config.llm.apiKey) {
  console.warn('! GROQ_API_KEY is not set. Jarvis cannot think until you add it (Railway variables or .env).');
}

const jarvis = createServer();
const port = await jarvis.listen(config.port);

console.log(`Jarvis is up on http://localhost:${port}  (${tools.length} tools, model ${config.model})`);
console.log(`Google: ${googleReady() ? 'connected' : 'not connected (run: npm run auth:google)'}  |  Telegram: ${config.telegramToken ? 'on' : 'off'}  |  Laptop tools: ${config.laptopEnabled ? 'on' : 'off'}`);
console.log('Voice: your cloned voice connects from voice-server/ (start.ps1); online neural voices are on; the phone voice is the offline fallback.');
console.log(process.stdout.isTTY ? `Access token: ${config.token}` : 'Access token: see JARVIS_TOKEN or data/token.txt');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await jarvis.close();
    process.exit(0);
  });
}
