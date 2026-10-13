import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { t } from './i18n.mjs';

// One folder per talk under dataRoot. Everything is plain files so the folder is useful without this tool.

export function talkDir(slug) {
  const dir = path.join(config.dataRoot, slug);
  if (path.dirname(dir) !== path.resolve(config.dataRoot)) throw new Error('bad talk id');
  return dir;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// Writes go through a temp file so a crash never leaves half a JSON file behind.
async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

export function nyDateParts(ms = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hhmm: `${parts.hour}${parts.minute}` };
}

function slugFor({ date, hhmm, title }) {
  const clean = title.replace(/[\/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  return `${date} ${hhmm} ${clean}`;
}

export async function createTalk(info) {
  await fs.mkdir(config.dataRoot, { recursive: true });
  const now = nyDateParts();
  const base = slugFor({ date: info.date || now.date, hhmm: info.hhmm || now.hhmm, title: info.title || 'Untitled' });
  let slug = base;
  for (let i = 2; await exists(talkDir(slug)); i++) slug = `${base} (${i})`;
  const dir = talkDir(slug);
  await fs.mkdir(path.join(dir, 'audio'), { recursive: true });
  const session = {
    title: info.title || 'Untitled',
    speakers: info.speakers || [],
    speakersBackfilled: !!info.scheduleId,
    references: [],
    link: info.link || '',
    scheduleId: info.scheduleId || '',
    time: info.time || '', startsAt: info.startsAt || '', room: info.room || '', type: info.type || '',
    topics: info.topics || [], description: info.description || '',
    createdAt: Date.now(),
    takes: [], chunks: [],
    claudeSession: null, chatTranscriptCount: 0,
  };
  await writeJson(path.join(dir, 'session.json'), session);
  return slug;
}

export async function listTalks() {
  let entries = [];
  try { entries = await fs.readdir(config.dataRoot, { withFileTypes: true }); } catch { return []; }
  const talks = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(config.dataRoot, e.name);
    const s = await readJson(path.join(dir, 'session.json'), null);
    talks.push({
      slug: e.name,
      title: s?.title || e.name,
      scheduleId: s?.scheduleId || '',
      prep: s?.prep?.status || '',
      speakers: (s?.speakers || []).map((p) => p.name).join(', '),
      date: e.name.slice(0, 10),
      chunks: s?.chunks?.length || 0,
      hasDigest: await exists(path.join(dir, 'digest.md')),
      hasChat: !!s?.claudeSession,
    });
  }
  return talks.sort((a, b) => a.slug.localeCompare(b.slug)); // folder names start with date + time, so this is chronological
}

// Folders made by hand (e.g. before this tool existed) get a session.json on first use.
export async function loadSession(slug) {
  const dir = talkDir(slug);
  if (!(await exists(dir))) throw new Error('no such talk');
  const s = await readJson(path.join(dir, 'session.json'), null);
  if (s) return s;
  const stat = await fs.stat(dir);
  return { title: slug, speakers: [], link: '', description: '', createdAt: stat.birthtimeMs, takes: [], chunks: [], claudeSession: null, chatTranscriptCount: 0 };
}

// Serialize read-modify-write per talk: the recorder, the transcriber and HTTP handlers all touch session.json.
const locks = new Map();
export function updateSession(slug, fn) {
  const prev = locks.get(slug) || Promise.resolve();
  const next = prev.then(async () => {
    const s = await loadSession(slug);
    const out = (await fn(s)) ?? s;
    await writeJson(path.join(talkDir(slug), 'session.json'), out);
    return out;
  });
  locks.set(slug, next.catch(() => {}));
  return next;
}

export async function loadNotes(slug) {
  return readJson(path.join(talkDir(slug), 'notes.json'), { lines: [] });
}

export async function saveNotes(slug, lines) {
  const dir = talkDir(slug);
  await writeJson(path.join(dir, 'notes.json'), { lines });
  await fs.writeFile(path.join(dir, 'notes.md'), lines.map((l) => l.text).join('\n') + '\n');
}

export async function loadChunkSegments(slug, chunkId) {
  return readJson(path.join(talkDir(slug), 'audio', 'chunks', `${chunkId}.json`), null);
}

export async function saveChunkSegments(slug, chunkId, segments) {
  const dir = path.join(talkDir(slug), 'audio', 'chunks');
  await fs.mkdir(dir, { recursive: true });
  await writeJson(path.join(dir, `${chunkId}.json`), segments);
}

export async function loadChat(slug) {
  return readJson(path.join(talkDir(slug), 'chat.json'), []);
}

export async function appendChat(slug, entries) {
  const dir = talkDir(slug);
  const chat = await loadChat(slug);
  chat.push(...entries);
  await writeJson(path.join(dir, 'chat.json'), chat);
  await fs.writeFile(path.join(dir, 'chat.md'), chat.map((m) => `## ${m.role === 'user' ? t('chat.me') : 'Claude'}\n\n${m.text}\n`).join('\n'));
}
