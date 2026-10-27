import { config } from './config.js';

const HAS_OFFSET = /([zZ]|[+-]\d{2}:?\d{2})$/;

export function tzOffsetMinutes(date, tz = config.tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3] || '0', 10));
}

/** Local wall-clock time in `tz` -> real Date. */
export function localToDate(y, mo, d, h, mi, tz = config.tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMinutes(new Date(guess), tz);
  return new Date(guess - off * 60000);
}

/** Real Date -> wall-clock parts in `tz`. */
export function localParts(date, tz = config.tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  const y = +parts.year, mo = +parts.month, d = +parts.day, h = +parts.hour, mi = +parts.minute;
  const pad = (n) => String(n).padStart(2, '0');
  return { y, mo, d, h, mi, dateStr: `${y}-${pad(mo)}-${pad(d)}`, hhmm: `${pad(h)}:${pad(mi)}` };
}

/** True when an ISO string already carries a UTC offset (or Z). */
export function hasOffset(str) {
  return HAS_OFFSET.test(String(str).trim());
}

/** Parse "2026-10-28T15:00" (local, in the configured timezone) or a full ISO string with offset. */
export function parseWhen(str) {
  const s = String(str).trim();
  if (hasOffset(s)) {
    const d = new Date(s);
    if (isNaN(d)) throw new Error(`Could not understand the time "${str}".`);
    return d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) throw new Error(`Could not understand the time "${str}". Use ISO format like 2026-10-28T15:00.`);
  return localToDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0));
}

export function fmtLocal(date, opts = {}) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...opts,
  }).format(date);
}

export function nowString() {
  const now = new Date();
  const off = tzOffsetMinutes(now);
  const sign = off < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: config.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return `${text} (${config.tz}, UTC${sign}${hh}:${mm})`;
}
