import crypto from 'node:crypto';
import { calendar } from '../google.js';
import { config } from '../config.js';
import { findContact } from '../db.js';
import { parseWhen, localToDate, localParts, fmtLocal } from '../time.js';

const eventTime = (date) => ({ dateTime: date.toISOString(), timeZone: config.tz });

function attendeeList(list = []) {
  return list.map((a) => {
    if (a.includes('@')) return { email: a.trim() };
    const c = findContact(a);
    if (!c?.email) throw new Error(`I don't have an email address for "${a}". Ask for it, or save it with contact_save.`);
    return { email: c.email, displayName: c.name };
  });
}

function summarizeEvent(e) {
  const allDay = !!e.start?.date;
  const start = allDay ? e.start.date : fmtLocal(new Date(e.start.dateTime));
  const end = allDay ? e.end.date : fmtLocal(new Date(e.end.dateTime), { weekday: undefined, day: undefined, month: undefined });
  return {
    id: e.id,
    title: e.summary || '(no title)',
    when: allDay ? `${start} (all day)` : `${start} to ${end}`,
    location: e.location || undefined,
    attendees: (e.attendees || []).map((a) => a.email),
    meet: e.hangoutLink || undefined,
  };
}

export default [
  {
    name: 'calendar_list',
    label: 'Checking your calendar',
    description: 'List calendar events between two times. Dates are local ISO (e.g. 2026-10-28 or 2026-10-28T09:00). Defaults to today.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start, local ISO. Default: start of today.' },
        to: { type: 'string', description: 'End, local ISO. Default: end of the start day.' },
      },
    },
    async run({ from, to }) {
      const start = from ? parseWhen(from) : (() => { const p = localParts(new Date()); return localToDate(p.y, p.mo, p.d, 0, 0); })();
      const end = to ? parseWhen(to) : new Date(start.getTime() + 24 * 3600 * 1000);
      const { data } = await calendar().events.list({
        calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(),
        singleEvents: true, orderBy: 'startTime', maxResults: 40,
      });
      const items = (data.items || []).filter((e) => e.status !== 'cancelled').map(summarizeEvent);
      return items.length ? items : 'No events in that range.';
    },
  },
  {
    name: 'calendar_find_free',
    label: 'Finding free time',
    description: `Find free slots of a given length within working hours (${config.workStart}-${config.workEnd}) over the next few days, or between two dates.`,
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Meeting length in minutes (default 30)' },
        from_date: { type: 'string', description: 'First day, YYYY-MM-DD (default today)' },
        days: { type: 'number', description: 'How many days to look at (default 5, max 14)' },
      },
    },
    async run({ minutes = 30, from_date, days = 5 }) {
      const first = from_date || localParts(new Date()).dateStr;
      const [y, mo, d] = first.split('-').map(Number);
      const [wsH, wsM] = config.workStart.split(':').map(Number);
      const [weH, weM] = config.workEnd.split(':').map(Number);
      const n = Math.min(Math.max(days, 1), 14);

      const rangeStart = localToDate(y, mo, d, 0, 0);
      const rangeEnd = new Date(rangeStart.getTime() + n * 24 * 3600 * 1000);
      const { data } = await calendar().freebusy.query({
        requestBody: { timeMin: rangeStart.toISOString(), timeMax: rangeEnd.toISOString(), items: [{ id: 'primary' }] },
      });
      const busy = (data.calendars?.primary?.busy || []).map((b) => [new Date(b.start).getTime(), new Date(b.end).getTime()]);

      const out = [];
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const day = new Date(Date.UTC(y, mo - 1, d + i));
        const dy = day.getUTCFullYear(), dm = day.getUTCMonth() + 1, dd = day.getUTCDate();
        const dow = day.getUTCDay();
        if (dow === 0 || dow === 6) continue; // skip weekends
        let cursor = Math.max(localToDate(dy, dm, dd, wsH, wsM).getTime(), now);
        const dayEnd = localToDate(dy, dm, dd, weH, weM).getTime();
        const todays = busy.filter(([s, e]) => e > cursor && s < dayEnd).sort((a, b) => a[0] - b[0]);
        const slots = [];
        for (const [s, e] of todays) {
          if (s - cursor >= minutes * 60000) slots.push([cursor, s]);
          cursor = Math.max(cursor, e);
        }
        if (dayEnd - cursor >= minutes * 60000) slots.push([cursor, dayEnd]);
        if (slots.length) {
          out.push({
            day: fmtLocal(new Date(slots[0][0]), { hour: undefined, minute: undefined }),
            free: slots.map(([s, e]) => `${fmtLocal(new Date(s), { weekday: undefined, day: undefined, month: undefined })} to ${fmtLocal(new Date(e), { weekday: undefined, day: undefined, month: undefined })}`),
          });
        }
      }
      return out.length ? out : `No free ${minutes}-minute slots in that period.`;
    },
  },
  {
    name: 'calendar_create',
    label: 'Scheduling a meeting',
    risky: (input) => Array.isArray(input.attendees) && input.attendees.length > 0, // invites other people => confirm
    summarize: ({ title, start, attendees = [] }) => `Create "${title}" at ${start}${attendees.length ? `, inviting ${attendees.join(', ')}` : ''}`,
    description: 'Create a calendar event. Times are local ISO like 2026-10-28T15:00 (or with an explicit offset). Attendees may be emails or contact names; they receive invitations (the user confirms first). Set add_meet for a Google Meet link.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string', description: 'Default: 30 minutes after start' },
        attendees: { type: 'array', items: { type: 'string' } },
        location: { type: 'string' },
        description: { type: 'string' },
        add_meet: { type: 'boolean' },
      },
      required: ['title', 'start'],
    },
    async run({ title, start, end, attendees, location, description, add_meet }) {
      const startDate = parseWhen(start);
      const endDate = end ? parseWhen(end) : new Date(startDate.getTime() + 30 * 60000);
      if (endDate <= startDate) throw new Error('The end time must be after the start time.');
      const requestBody = {
        summary: title,
        location,
        description,
        start: eventTime(startDate),
        end: eventTime(endDate),
        attendees: attendees?.length ? attendeeList(attendees) : undefined,
      };
      if (add_meet) {
        requestBody.conferenceData = { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: 'hangoutsMeet' } } };
      }
      const { data } = await calendar().events.insert({
        calendarId: 'primary', requestBody, conferenceDataVersion: add_meet ? 1 : 0, sendUpdates: attendees?.length ? 'all' : 'none',
      });
      return { created: summarizeEvent(data) };
    },
  },
  {
    name: 'calendar_delete',
    label: 'Cancelling an event',
    risky: true,
    summarize: ({ id }) => `Delete calendar event ${id} (attendees are notified)`,
    description: 'Delete a calendar event by id (from calendar_list). The user confirms first.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    async run({ id }) {
      await calendar().events.delete({ calendarId: 'primary', eventId: id, sendUpdates: 'all' });
      return 'Event deleted.';
    },
  },
];
