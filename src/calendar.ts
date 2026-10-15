// Calendar links. The browser sends the weekly plan once; we save it in KV and give it
// its own URL. Google Calendar, Apple Calendar and Outlook can subscribe to that URL
// in one click, so students never have to download and import a file.

import type { Env, StudyWeek } from './types.ts';

export const WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KEEP_SECONDS = 400 * 24 * 60 * 60; // a little over a year, longer than any plan

export interface SavedCalendar {
  start: string; // YYYY-MM-DD, always a Monday
  weeks: StudyWeek[];
}

// Accepts a Monday between yesterday and 15 days from now, so a plan can't be backdated or parked far ahead.
export function validStart(value: unknown, now = new Date()): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  if (date.getUTCDay() !== 1) return null;
  const days = (date.getTime() - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 86_400_000;
  return days >= -1 && days <= 15 ? value : null;
}

export async function saveCalendar(env: Env, calendar: SavedCalendar): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, '');
  await env.DATA.put(`cal:${id}`, JSON.stringify(calendar), { expirationTtl: KEEP_SECONDS });
  return id;
}

export async function loadCalendar(env: Env, id: string): Promise<SavedCalendar | null> {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return env.DATA.get<SavedCalendar>(`cal:${id}`, 'json');
}

// The .ics format needs commas, semicolons and backslashes escaped, and lines folded at 75 characters.
function text(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line: string): string {
  const parts: string[] = [];
  while (line.length > 74) {
    parts.push(line.slice(0, 74));
    line = ' ' + line.slice(74);
  }
  parts.push(line);
  return parts.join('\r\n');
}
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

export function buildIcs(id: string, calendar: SavedCalendar, now = new Date()): string {
  const start = new Date(`${calendar.start}T00:00:00Z`);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LSAT Compass//Study Plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:LSAT study plan',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  calendar.weeks.forEach((week, w) => {
    week.tasks.forEach((task, t) => {
      const offset = WEEK_DAYS.indexOf(task.day);
      if (offset === -1) return;
      const day = new Date(start);
      day.setUTCDate(start.getUTCDate() + w * 7 + offset);
      const next = new Date(day);
      next.setUTCDate(day.getUTCDate() + 1);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${id}-${w}-${t}@lsatcompass.com`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymd(day)}`,
        `DTEND;VALUE=DATE:${ymd(next)}`,
        fold(`SUMMARY:${text(`LSAT: ${task.task}`)}`),
        fold(`DESCRIPTION:${text(`Week ${week.week}: ${week.title}. ${week.focus}`.trim())}`),
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    });
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
