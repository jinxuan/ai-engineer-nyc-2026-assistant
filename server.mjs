import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './lib/config.mjs';
import { resolveSession, daySessions, sessionIdFromLink } from './lib/schedule.mjs';
import { listTalks, createTalk, loadSession, updateSession, loadNotes, saveNotes, loadChat, exists, talkDir } from './lib/store.mjs';
import { startRecording, stopRecording, cutNow, recordingState, kick, retryChunk, waitForChunk, recover } from './lib/audio.mjs';
import { transcriptSegments, talkZero, paragraphs, loadStructure } from './lib/transcript.mjs';
import { startStructure, structureRunning } from './lib/structure.mjs';
import { chat, resetChat, startDigest, digestJob } from './lib/claude.mjs';
import { importFile } from './lib/importer.mjs';
import { addReference, removeReference, saveSpeakers } from './lib/references.mjs';
import { startPrep, prepRunning } from './lib/prep.mjs';
import os from 'node:os';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { t, strings, readPrompt } from './lib/i18n.mjs';

const publicDir = path.join(import.meta.dirname, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

// Talks created before speaker bios/handles were kept: fill them in once from the schedule.
async function backfillSpeakers(slug, s) {
  if (!s.scheduleId || s.speakersBackfilled) return s;
  try {
    const fresh = await resolveSession(s.scheduleId);
    return await updateSession(slug, (s) => {
      s.speakers = fresh.speakers.map((f) => ({ ...f, ...Object.fromEntries(Object.entries(s.speakers.find((p) => p.name === f.name) || {}).filter(([, v]) => v)) }));
      s.speakersBackfilled = true;
    });
  } catch {
    return s;
  }
}

async function talkState(slug) {
  const s = await backfillSpeakers(slug, await loadSession(slug));
  const rec = recordingState();
  return {
    slug,
    session: s,
    zero: talkZero(s),
    notes: (await loadNotes(slug)).lines,
    transcript: paragraphs(await transcriptSegments(slug, s), await loadStructure(slug)),
    chapters: (await loadStructure(slug))?.chapters || [],
    structureJob: s.structureJob?.status === 'running' && !structureRunning(slug) ? { status: 'error', error: t('err.structureInterrupted') } : s.structureJob || null,
    recording: rec?.slug === slug ? rec : null,
    recordingElsewhere: rec && rec.slug !== slug ? rec.slug : null,
    digestJob: digestJob(slug),
    // A prep marked running in session.json but not running here was cut off by a restart.
    prep: (s.prep?.status === 'running' || s.prep?.status === 'queued') && !prepRunning(slug) ? { status: 'error', error: t('prep.interrupted') } : s.prep || null,
    hasPrep: await exists(path.join(talkDir(slug), 'prep.md')),
    hasDigest: await exists(path.join(talkDir(slug), 'digest.md')),
  };
}

const routes = [
  ['GET', /^\/api\/status$/, async () => ({
    dataRoot: config.dataRoot,
    model: await exists(config.whisperModel),
    recording: recordingState(),
    modes: JSON.parse(await readPrompt('modes.json')),
  })],
  ['GET', /^\/api\/talks$/, () => listTalks()],
  ['GET', /^\/api\/strings$/, () => strings],
  ['GET', /^\/api\/resolve$/, (req, url) => resolveSession(url.searchParams.get('link') || '')],
  ['POST', /^\/api\/talks$/, async (req) => {
    const b = await body(req);
    const info = b.link ? await resolveSession(b.link) : { title: b.title, speakers: (b.speakers || '').split(',').map((n) => n.trim()).filter(Boolean).map((name) => ({ name })) };
    if (!info.title) throw new Error(t('err.needLinkOrTitle'));
    const slug = await createTalk(info);
    if (info.scheduleId) startPrep(slug); // prep starts on its own for talks from the schedule
    return { slug };
  }],
  ['GET', /^\/api\/schedule$/, async (req, url) => {
    const existing = new Set((await listTalks()).map((t) => t.scheduleId).filter(Boolean));
    return (await daySessions(url.searchParams.get('date'))).map((s) => ({ ...s, description: undefined, exists: existing.has(s.scheduleId) }));
  }],
  // Batch: create a talk for each schedule link / id not created yet, and queue prep for each.
  ['POST', /^\/api\/talks\/batch$/, async (req) => {
    const b = await body(req);
    const ids = [...new Set([...(b.ids || []), ...(b.links || []).map(sessionIdFromLink)].filter(Boolean))];
    const talks = await listTalks();
    const created = [], skipped = [];
    for (const id of ids) {
      const have = talks.find((t) => t.scheduleId === id);
      if (have) { skipped.push(have.slug); continue; }
      const slug = await createTalk(await resolveSession(id));
      startPrep(slug);
      created.push(slug);
    }
    return { created, skipped };
  }],
  ['GET', /^\/api\/talks\/([^/]+)$/, (req, url, slug) => talkState(slug)],
  ['PUT', /^\/api\/talks\/([^/]+)\/notes$/, async (req, url, slug) => {
    const { lines } = await body(req);
    await saveNotes(slug, lines.map((l) => ({ t: l.t || null, text: String(l.text ?? '') })));
    return { ok: true };
  }],
  ['POST', /^\/api\/talks\/([^/]+)\/record\/start$/, (req, url, slug) => startRecording(slug)],
  ['POST', /^\/api\/talks\/([^/]+)\/record\/stop$/, async () => { await stopRecording(); return { ok: true }; }],
  ['POST', /^\/api\/talks\/([^/]+)\/record\/cut$/, async (req, url, slug) => ({ chunk: await cutNow(slug) })],
  ['POST', /^\/api\/talks\/([^/]+)\/chunks\/([^/]+)\/retry$/, async (req, url, slug, id) => { await retryChunk(slug, id); return { ok: true }; }],
  ['PUT', /^\/api\/talks\/([^/]+)\/speakers$/, async (req, url, slug) => { await saveSpeakers(slug, (await body(req)).speakers || []); return { ok: true }; }],
  ['POST', /^\/api\/talks\/([^/]+)\/references$/, async (req, url, slug) => { const b = await body(req); return addReference(slug, b.url, { note: b.note, kind: b.kind }); }],
  ['DELETE', /^\/api\/talks\/([^/]+)\/references$/, async (req, url, slug) => { await removeReference(slug, url.searchParams.get('url')); return { ok: true }; }],
  ['POST', /^\/api\/talks\/([^/]+)\/structure$/, async (req, url, slug) => { await startStructure(slug); return { ok: true }; }],
  ['POST', /^\/api\/talks\/([^/]+)\/prep$/, async (req, url, slug) => { await startPrep(slug); return { ok: true }; }],
  ['GET', /^\/api\/talks\/([^/]+)\/prep$/, async (req, url, slug) => ({ markdown: await fs.readFile(path.join(talkDir(slug), 'prep.md'), 'utf8').catch(() => '') })],
  ['POST', /^\/api\/talks\/([^/]+)\/digest$/, (req, url, slug) => startDigest(slug)],
  ['GET', /^\/api\/talks\/([^/]+)\/digest$/, async (req, url, slug) => ({ markdown: await fs.readFile(path.join(talkDir(slug), 'digest.md'), 'utf8').catch(() => '') })],
  ['GET', /^\/api\/talks\/([^/]+)\/chat$/, (req, url, slug) => loadChat(slug)],
  ['POST', /^\/api\/talks\/([^/]+)\/chat\/reset$/, async (req, url, slug) => { await resetChat(slug); return { ok: true }; }],
];

// Chat streams newline-delimited JSON events.
async function chatRoute(req, res, slug) {
  const { message } = await body(req);
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
  const emit = (ev) => res.write(JSON.stringify(ev) + '\n');
  try {
    // Asking mid-talk: cut first so the minutes just spoken are transcribed before Claude answers.
    const chunk = await cutNow(slug, { priority: true });
    if (chunk) {
      emit({ type: 'status', text: t('chat.cut') });
      const started = Date.now();
      const c = await waitForChunk(slug, chunk);
      emit({ type: 'status', text: c?.status === 'done' ? t('chat.transcribed', { s: Math.round((Date.now() - started) / 1000) }) : t('chat.notYet') });
    }
    emit({ type: 'status', text: t('chat.thinking') });
    await chat(slug, message, emit);
  } catch (e) {
    emit({ type: 'error', text: e.message });
  }
  res.end();
}

async function serveStatic(res, pathname) {
  const file = path.join(publicDir, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(publicDir)) return send(res, 404, { error: 'not found' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

// Upload: the browser PUTs the raw file; it lands in a temp dir, gets imported, and the temp copy is deleted.
async function uploadRoute(req, res, slug, url) {
  const name = path.basename(url.searchParams.get('name') || 'upload');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talk-up-'));
  const file = path.join(tmp, name);
  try {
    await pipeline(req, createWriteStream(file));
    send(res, 200, await importFile(slug, file));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// Files inside a talk folder (slide photos etc.).
async function serveTalkFile(res, slug, rel) {
  const dir = talkDir(slug);
  const file = path.join(dir, rel);
  if (!file.startsWith(dir + path.sep)) return send(res, 404, { error: 'not found' });
  return serveFileAt(res, file);
}

async function serveFileAt(res, file) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    let m = p.match(/^\/api\/talks\/([^/]+)\/chat$/);
    if (m && req.method === 'POST') return await chatRoute(req, res, decodeURIComponent(m[1]));
    m = p.match(/^\/api\/talks\/([^/]+)\/upload$/);
    if (m && req.method === 'PUT') return await uploadRoute(req, res, decodeURIComponent(m[1]), url);
    m = p.match(/^\/files\/([^/]+)\/(.+)$/);
    if (m && req.method === 'GET') return await serveTalkFile(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    for (const [method, re, fn] of routes) {
      const mm = p.match(re);
      if (mm && req.method === method) return send(res, 200, await fn(req, url, ...mm.slice(1).map(decodeURIComponent)));
    }
    if (req.method === 'GET' && !p.startsWith('/api/')) return await serveStatic(res, p);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(req.method, p, e.message);
    if (!res.headersSent) send(res, 400, { error: e.message });
    else res.end();
  }
});

// Local only: nothing here needs to be reachable from other devices.
server.listen(config.port, '127.0.0.1', () => {
  console.log(`talk-copilot on http://localhost:${config.port}  ·  data: ${config.dataRoot}`);
  recover().then(kick); // resume chunks left pending by a previous run
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await stopRecording().catch(() => {});
    process.exit(0);
  });
}
