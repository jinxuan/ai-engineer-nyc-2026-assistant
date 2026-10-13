import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { t } from './i18n.mjs';

const cacheFile = path.join(config.cacheDir, 'schedule.json');
const maxAgeMs = 60 * 60 * 1000;

// The schedule page embeds every session in __NEXT_DATA__; ?session=<id> only selects one client-side.
async function fetchSchedule() {
  const res = await fetch(config.scheduleUrl);
  if (!res.ok) throw new Error(`schedule fetch failed: ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('schedule page has no __NEXT_DATA__');
  const sessions = JSON.parse(m[1]).props?.pageProps?.sessions;
  if (!Array.isArray(sessions)) throw new Error('schedule page has no sessions');
  await fs.mkdir(config.cacheDir, { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), sessions }));
  return sessions;
}

async function loadSchedule({ refresh = false } = {}) {
  try {
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
    if (!refresh && Date.now() - cached.fetchedAt < maxAgeMs) return cached.sessions;
    try { return await fetchSchedule(); } catch { return cached.sessions; } // conference Wi-Fi: stale beats nothing
  } catch {
    return fetchSchedule();
  }
}

export function sessionIdFromLink(link) {
  const m = String(link).match(/[?&]session=([0-9a-f-]{36})/i) || String(link).match(/^([0-9a-f-]{36})$/i);
  return m ? m[1].toLowerCase() : null;
}

export async function resolveSession(link) {
  const id = sessionIdFromLink(link);
  if (!id) throw new Error(t('err.noSessionId'));
  let s = (await loadSchedule()).find((x) => x.id === id);
  if (!s) s = (await loadSchedule({ refresh: true })).find((x) => x.id === id);
  if (!s) throw new Error(t('err.sessionNotFound'));
  return toInfo(s);
}

// All sessions on one day, for picking several talks at once.
export async function daySessions(date) {
  return (await loadSchedule()).filter((s) => s.date === date).sort((a, b) => a.startMinutes - b.startMinutes || a.roomOrder - b.roomOrder).map(toInfo);
}

function toInfo(s) {
  const hhmm = `${String(Math.floor(s.startMinutes / 60)).padStart(2, '0')}${String(s.startMinutes % 60).padStart(2, '0')}`;
  return {
    scheduleId: s.id,
    link: `${config.scheduleUrl}?session=${s.id}`,
    title: s.title,
    date: s.date,
    hhmm,
    time: s.time,
    startsAt: s.startsAt,
    room: s.room,
    type: s.format || s.type,
    topics: s.topics || [],
    description: (s.description || '').replace(/\r\n/g, '\n'),
    speakers: (s.speakers || []).map((p) => ({
      name: p.name, role: p.role || '', company: p.company || '', bio: p.bio || '',
      website: p.website || '', linkedin: p.linkedin || '', twitter: p.twitter || '', github: '',
    })),
  };
}
