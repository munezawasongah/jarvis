# Jarvis

Your own voice assistant. An LLM (Groq by default) is the brain; it calls tools to read and send email, manage your
calendar, text people, keep tasks and reminders, and operate your Android phone and laptop.

```
 Fold 5 / laptop browser  <-- WebSocket -->  Jarvis server (Node)  <-- WebSocket -->  Android companion app
   voice, wake word,                          Claude + tools, memory,                   SMS, calls, apps,
   approve/deny sheet                         reminders, briefing                       screen control
                                                   |
                                          Gmail, Calendar, Telegram, laptop shell
```

**Safety first.** Anything that sends, calls, runs a command, writes a file or invites people
pauses and shows an Approve/Deny sheet (or say "yes" / "no"). No screen connected = denied.
Read-only things (calendar, search, open app) just run. Email, web pages and screen text are treated
as untrusted data, never as instructions.

## 1. Run the server

```bash
cd jarvis
npm install
cp .env.example .env      # add GROQ_API_KEY
npm test                  # optional: self tests, no API key needed
npm start
```
It prints the access token (also in `data/token.txt`). Open http://localhost:3000 on the same machine,
tap Start, paste the token.

## 2. Reach it from your Fold 5

Chrome only allows the microphone on HTTPS (or localhost), so the phone needs an HTTPS address.
Pick one:
- **Cloud server** (Railway, Fly, a VPS): deploy the folder, set the env vars, you get HTTPS. Set `LAPTOP_TOOLS=0`.
  Add a persistent volume and set `JARVIS_DATA_DIR` to it so memory and Google login survive restarts.
- **Server on your laptop + tunnel**: `cloudflared tunnel --url http://localhost:3000` (or Tailscale Serve) gives an HTTPS link.
  This is the one that lets Jarvis control the laptop.

On the Fold open the link in Chrome, sign in with the token, then menu > **Install app**. Unfolded, the same page uses the wide layout.
Settings has speech language (try `sw-TZ` for Swahili), voice and speed. Say "Jarvis, ..." or tap the mic.

## 3. Connect Gmail and Calendar (once, from the browser)

On a deployed server: create an OAuth client of type **Web application** with the redirect URI
`https://YOUR-DOMAIN/auth/google/callback`, set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (and `PUBLIC_URL` if
not on Railway), redeploy, then open Jarvis > Settings > **Connect Google**. Keep `JARVIS_DATA_DIR` on a volume.
Publish the consent screen ("In production"), otherwise Google expires the login after 7 days.

### Alternative: local script (Desktop-app client)

1. console.cloud.google.com > new project > enable **Gmail API** and **Google Calendar API**.
2. OAuth consent screen: External, add your own address as a test user.
3. Credentials > Create OAuth client ID > **Desktop app**. Put the id and secret in `.env`.
4. `npm run auth:google` on a machine with a browser, approve, done. It writes `data/google-token.json`.
   For a cloud server, run this locally and copy that file into the server's data folder.

## 4. Android companion (phone control)

Needs Android Studio (not compiled in the environment this was written in, so expect to fix a small
thing or two on first build).
1. Open the `android/` folder in Android Studio, let Gradle sync, run on the Fold (USB debugging) or build an APK.
2. In the app enter the server address and token, **Save and connect**. The Phone chip in Jarvis turns green.
3. Work down the checklist buttons: permissions (SMS, calls, contacts), the accessibility service,
   display over other apps, no battery limits.
4. Android 13+: App info > ⋮ > **Allow restricted settings**, otherwise accessibility cannot be enabled for a sideloaded app.

What works: `sms_send`, `phone_call`, contacts lookup, open apps and links, alarms, read screen, tap, type, scroll,
back/home/recents, and WhatsApp (opens the chat with the text prefilled and presses Send; needs international
numbers and the English "Send" label). Phone calls and SMS go through your normal SIM.

## 5. Telegram (optional)

Create a bot with @BotFather, put the token in `.env`. Telegram only lets bots message people who
have started the bot; save their chat id with "save Amina's telegram chat id 123456".

## 6. Jarvis' voice (your own voice, free, offline and online)

Settings > **Jarvis' voice** has three engines. Automatic tries them in this order for each sentence:

| Engine | What it is | Needs |
|---|---|---|
| **My voice** | Your own voice, cloned from a recording by [Kyutai Pocket TTS](https://github.com/kyutai-labs/pocket-tts) on your laptop's CPU. Nothing leaves your machine. | The voice worker running on the laptop (below). English. |
| **Online voice** | Microsoft neural voices (British Ryan, Kenyan Chilemba, Kiswahili Rafiki/Daudi, ...), free, no key. | Internet on the Jarvis server. |
| **Phone voice** | The phone's built-in voice. | Nothing; works offline. |

The chip in the top bar shows which voice is speaking. Speed applies to all three. Kiswahili (`sw-KE`/`sw-TZ`)
automatically uses the online Kiswahili voices, because the cloned voice speaks English.

### Set up your voice on the laptop (once)

```powershell
cd jarvis\voice-server
powershell -ExecutionPolicy Bypass -File setup.ps1
```
It installs Python if needed and Pocket TTS (~700 MB in total), then asks for a free Hugging Face **Read** token: Kyutai
asks you to accept their terms at huggingface.co/kyutai/pocket-tts before voice cloning works (the script opens the pages).
It then learns your voice from `voices\my-voice.wav` and plays a test sentence in it.

### Connect it to Jarvis

```powershell
# Jarvis running on this laptop:
powershell -ExecutionPolicy Bypass -File start.ps1
# Jarvis on Railway (remembered, so next time just start.ps1):
powershell -ExecutionPolicy Bypass -File start.ps1 -Server https://YOUR-APP.up.railway.app -Token YOUR_JARVIS_TOKEN
# Start it hidden every time you sign in to Windows:
powershell -ExecutionPolicy Bypass -File start.ps1 -Autostart
```
The worker dials out to Jarvis (like the phone app), so no tunnel or open port is needed, even with Jarvis in the cloud.
When it's off, Jarvis just uses the online voice.

### Change your voice sample

Settings > **Record my voice** (reads a short script, 30-60 s) or **Upload a sample** (any WAV/MP3/M4A). The sample is
kept in Jarvis' data folder, sent to the worker, and learnt in about a minute. Tips: quiet room, no fan or TV, phone a
hand's width from your mouth, normal pace. The sample's quality (noise, echo) is copied into the voice.

Your voice files are git-ignored (`voice-server/voices/`): anyone with the sample could clone your voice, so keep them
off GitHub. Only clone voices of people who have agreed to it.

Optional: `voice-server/Dockerfile` runs the worker in the cloud instead (needs ~1.5 GB RAM, `HF_TOKEN`, `JARVIS_URL`,
`JARVIS_TOKEN`); Jarvis sends it your sample automatically.

## Things to say

- "Jarvis, what's on today?" / "Any important email?"
- "Email Amina that I'm ten minutes late." (you approve the draft)
- "Find 30 minutes with Samuel tomorrow afternoon and send an invite with a Meet link."
- "Text my brother I'll call tonight." / "WhatsApp Pauline the address."
- "Remind me at 5 to call the bank." / "Add a task: renew the domain, due Friday."
- "Remember that I prefer meetings after ten."
- "Open Maps on my phone." / "Open VS Code on the laptop."

## Notes and limits

- Jarvis' brain (Groq) needs internet; without it Jarvis can't answer, but whatever it says still plays in your voice or the phone voice.
- Speech recognition uses Chrome's built-in service (audio goes to Google). Wake word detection is "listen for the word in continuous transcription", so it needs the tab/app open and the screen on. A fully offline wake word (Porcupine) is a good next step.
- Web: `web_search` uses Tavily if `TAVILY_API_KEY` is set (recommended), otherwise a free scraper that datacenter IPs may get blocked on; `web_fetch` reads a page and refuses private/internal addresses.
- Groq free plans have per-minute token limits; Jarvis waits and retries on rate limits, but heavy multi-step requests can still be slow.
- iPhone is not supported (Apple blocks this level of control).
- `laptop_run` always asks first and shows the exact command. Never put it in `AUTO_APPROVE` on a server exposed to the internet.
- The token is the key to everything. Keep it private; use HTTPS.

## Deploy on Railway

1. Push this repo to GitHub, then Railway > New Project > Deploy from GitHub repo.
2. Variables: `GROQ_API_KEY`, `JARVIS_TOKEN` (a long random string), `TIMEZONE`, `USER_NAME`, `LAPTOP_TOOLS=0`,
   `JARVIS_DATA_DIR=/data`, plus `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `TELEGRAM_BOT_TOKEN` if used.
3. Add a Volume mounted at `/data` so memory, tasks and the Google login survive redeploys.
4. Settings > Networking > Generate Domain. That HTTPS address is what you open on the Fold and enter in the Android app.
5. Google login: run `npm run auth:google` locally, then put the resulting `data/google-token.json` into the volume.
