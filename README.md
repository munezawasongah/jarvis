# Jarvis

Your own voice assistant. Claude is the brain; it calls tools to read and send email, manage your
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
cp .env.example .env      # add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY
npm test                  # optional: 15 self tests, no API key needed
npm start
```
It prints the access token (also in `data/token.txt`). Open http://localhost:3000 on the same machine,
tap Start, paste the token.

**Which AI?** Jarvis works with Google Gemini (free tier, key from https://aistudio.google.com/apikey) or Anthropic Claude (paid).
Set `GEMINI_API_KEY` to start free. To switch later, add `ANTHROPIC_API_KEY` and set `JARVIS_PROVIDER=anthropic`. Nothing else changes.

## 2. Reach it from your Fold 5

Chrome only allows the microphone on HTTPS (or localhost), so the phone needs an HTTPS address.
Pick one:
- **Cloud server** (Railway, Fly, a VPS): deploy the folder, set the env vars, you get HTTPS. Set `LAPTOP_TOOLS=0`.
  Add a persistent volume and set `JARVIS_DATA_DIR` to it so memory and Google login survive restarts.
- **Server on your laptop + tunnel**: `cloudflared tunnel --url http://localhost:3000` (or Tailscale Serve) gives an HTTPS link.
  This is the one that lets Jarvis control the laptop.

On the Fold open the link in Chrome, sign in with the token, then menu > **Install app**. Unfolded, the same page uses the wide layout.
Settings has speech language (try `sw-TZ` for Swahili), voice and speed. Say "Jarvis, ..." or tap the mic.

## 3. Connect Gmail and Calendar (once)

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

## Things to say

- "Jarvis, what's on today?" / "Any important email?"
- "Email Amina that I'm ten minutes late." (you approve the draft)
- "Find 30 minutes with Samuel tomorrow afternoon and send an invite with a Meet link."
- "Text my brother I'll call tonight." / "WhatsApp Pauline the address."
- "Remind me at 5 to call the bank." / "Add a task: renew the domain, due Friday."
- "Remember that I prefer meetings after ten."
- "Open Maps on my phone." / "Open VS Code on the laptop."

## Notes and limits

- Speech recognition uses Chrome's built-in service (audio goes to Google). Wake word detection is "listen for the word in continuous transcription", so it needs the tab/app open and the screen on. A fully offline wake word (Porcupine) is a good next step.
- iPhone is not supported (Apple blocks this level of control).
- `laptop_run` always asks first and shows the exact command. Never put it in `AUTO_APPROVE` on a server exposed to the internet.
- The token is the key to everything. Keep it private; use HTTPS.
