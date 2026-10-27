import { db, save } from './db.js';
import { config } from './config.js';
import { broadcast } from './hub.js';
import { callPhone, phoneConnected } from './phoneBridge.js';
import { localParts } from './time.js';

const BRIEFING_PROMPT = `Give me my morning briefing. Check today's calendar events, my open tasks and reminders due today, and unread email from the last day (summarise only what matters, name the sender of anything important). Be brief: at most six spoken sentences. Start with a greeting.`;

export function startScheduler(session) {
  async function tick() {
    const now = Date.now();

    for (const r of db.reminders) {
      if (!r.fired && new Date(r.at).getTime() <= now) {
        r.fired = true;
        save();
        broadcast({ type: 'notify', text: `Reminder: ${r.text}` });
        if (phoneConnected()) callPhone('notify', { title: 'Jarvis reminder', text: r.text }).catch(() => {});
      }
    }

    // Forget reminders that fired more than a week ago.
    const cutoff = now - 7 * 24 * 3600 * 1000;
    const kept = db.reminders.filter((r) => !r.fired || new Date(r.at).getTime() > cutoff);
    if (kept.length !== db.reminders.length) {
      db.reminders = kept;
      save();
    }

    if (config.briefingTime) {
      const p = localParts(new Date());
      const [bh, bm] = config.briefingTime.split(':').map(Number);
      const minutes = p.h * 60 + p.mi;
      const target = bh * 60 + bm;
      // 30-minute window so a late server start doesn't read out a stale briefing.
      if (minutes >= target && minutes < target + 30 && db.meta.lastBriefing !== p.dateStr) {
        db.meta.lastBriefing = p.dateStr;
        save();
        session
          .ask(BRIEFING_PROMPT, { source: 'briefing' })
          .then((text) => {
            if (phoneConnected()) callPhone('notify', { title: 'Morning briefing', text }).catch(() => {});
          })
          .catch((err) => console.error('Briefing failed:', err.message));
      }
    }
  }

  const timer = setInterval(() => tick().catch((e) => console.error('Scheduler error:', e.message)), 15000);
  timer.unref?.();
  return () => clearInterval(timer);
}
