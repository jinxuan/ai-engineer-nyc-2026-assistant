import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, glossary } from './config.mjs';
import { talkDir, updateSession, loadSession, saveChunkSegments, exists, listTalks } from './store.mjs';
import { rebuildTranscript } from './transcript.mjs';
import { startStructure } from './structure.mjs';
import { t } from './i18n.mjs';

// Recording: one ffmpeg process writes 10-second Opus pieces continuously (a crash loses ≤10s).
// A "chunk" is a time range of a take; cutting a chunk never interrupts ffmpeg.

let active = null; // { slug, take, proc, startedAt, chunkStart, elapsed, silences: [], stopping }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-500)}`))));
  });
}

export function recordingState() {
  if (!active) return null;
  return { slug: active.slug, take: active.take, startedAt: active.startedAt, elapsed: active.elapsed, chunkStart: active.chunkStart };
}

export async function startRecording(slug) {
  if (active) throw new Error(t('err.alreadyRecording', { name: active.slug }));
  const s = await updateSession(slug, (s) => {
    s.takes.push({ take: s.takes.length + 1, startedAt: Date.now() });
  });
  const { take, startedAt } = s.takes.at(-1);
  const dir = path.join(talkDir(slug), 'audio', `take-${take}`);
  await fs.mkdir(dir, { recursive: true });
  const proc = spawn('ffmpeg', [
    '-hide_banner', '-f', 'avfoundation', '-i', `:${config.audioDevice}`,
    '-ac', '1', '-ar', '16000', '-af', 'silencedetect=noise=-35dB:d=0.5',
    '-c:a', 'libopus', '-b:a', '24k',
    '-f', 'segment', '-segment_time', String(config.pieceSeconds), '-reset_timestamps', '1',
    path.join(dir, '%05d.ogg'),
  ], { stdio: ['pipe', 'ignore', 'pipe'] });
  active = { slug, take, proc, startedAt, chunkStart: 0, elapsed: 0, silences: [], stopping: false, stderr: '' };
  const me = active;
  proc.stderr.on('data', (d) => {
    const text = d.toString();
    me.stderr = (me.stderr + text).slice(-2000);
    for (const m of text.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)) {
      me.silences.push(Number(m[1]) - Number(m[2]) / 2);
    }
    const t = [...text.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].at(-1);
    if (t) {
      me.elapsed = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      // Opening the mic takes a few seconds; anchor the take to when audio actually started.
      if (!me.anchored) {
        me.anchored = true;
        me.startedAt = Date.now() - me.elapsed * 1000;
        updateSession(slug, (s) => { const tk = s.takes.find((x) => x.take === take); if (tk) tk.startedAt = me.startedAt; });
      }
    }
  });
  proc.on('close', async (code) => {
    clearInterval(me.timer);
    if (active === me) active = null;
    if (me.elapsed - me.chunkStart > 1) await addChunk(me, me.elapsed, { final: true });
    if (!me.stopping) console.error(`ffmpeg stopped unexpectedly (code ${code}):\n${me.stderr}`);
    kick();
  });
  me.timer = setInterval(() => autoCut(me), 1000);
  return recordingState();
}

function autoCut(me) {
  const len = me.elapsed - me.chunkStart;
  if (len < config.minChunk) return;
  const pause = me.silences.find((t) => t >= me.chunkStart + config.minChunk && t <= me.elapsed);
  if (pause) addChunk(me, pause);
  else if (len >= config.maxChunk) addChunk(me, me.elapsed);
}

async function addChunk(me, to, { final = false, priority = false } = {}) {
  const from = me.chunkStart;
  me.chunkStart = to;
  const id = `t${me.take}-${String(Math.round(from)).padStart(5, '0')}`;
  await updateSession(me.slug, (s) => {
    s.chunks.push({ id, take: me.take, from, to, status: 'pending', priority, final });
  });
  kick();
  return id;
}

// Cut now (manual key, or before answering a question so the latest minutes get transcribed first).
export async function cutNow(slug, { priority = false } = {}) {
  if (!active || active.slug !== slug) return null;
  if (active.elapsed - active.chunkStart < 2) return null;
  return addChunk(active, active.elapsed, { priority });
}

export async function stopRecording() {
  if (!active) return;
  const me = active;
  me.stopping = true;
  const closed = new Promise((r) => me.proc.on('close', r));
  // 'q' on stdin is ffmpeg's own clean quit; signals can be ignored when the parent ignores them.
  me.proc.stdin.end('q');
  const timeout = setTimeout(() => me.proc.kill('SIGKILL'), 5000);
  await closed;
  clearTimeout(timeout);
  await updateSession(me.slug, (s) => {
    const t = s.takes.find((x) => x.take === me.take);
    if (t) t.stoppedAt = Date.now();
  });
}

// ---- transcription worker: one chunk at a time, priority chunks first ----

let working = false;

function whisperPrompt(s) {
  const speakers = s.speakers.map((p) => [p.name, p.company].filter(Boolean).join(', ')).join('; ');
  const parts = [`${config.conference}.`, `Talk: ${s.title}.`];
  if (speakers) parts.push(`Speakers: ${speakers}.`);
  if (s.extraTerms) parts.push(`${s.extraTerms}.`);
  parts.push(`Terms: ${glossary.join(', ')}.`);
  return parts.join(' ').slice(0, 900);
}

async function chunkReady(slug, c) {
  if (c.final || c.source) return true; // imported audio is complete from the start
  // The piece containing `to` is complete once ffmpeg has started the next one.
  const next = Math.floor(c.to / config.pieceSeconds) + 1;
  return exists(path.join(talkDir(slug), 'audio', `take-${c.take}`, `${String(next).padStart(5, '0')}.ogg`));
}

async function nextJob() {
  const candidates = [];
  const slugs = active ? [active.slug, ...(await listTalks()).map((t) => t.slug)] : (await listTalks()).map((t) => t.slug);
  for (const slug of [...new Set(slugs)]) {
    const s = await loadSession(slug).catch(() => null);
    for (const c of s?.chunks || []) {
      if (c.status === 'pending' && (await chunkReady(slug, c))) candidates.push({ slug, c, s });
    }
    if (candidates.some((x) => x.c.priority)) break;
  }
  candidates.sort((a, b) => (b.c.priority - a.c.priority) || (a.s.createdAt - b.s.createdAt) || (a.c.from - b.c.from));
  return candidates[0];
}

export function kick() {
  if (working) return;
  working = true;
  (async () => {
    try {
      for (let job = await nextJob(); job; job = await nextJob()) await transcribe(job);
    } catch (e) {
      console.error('transcribe worker:', e);
    } finally {
      working = false;
    }
  })();
}

async function setChunk(slug, id, patch) {
  await updateSession(slug, (s) => { Object.assign(s.chunks.find((c) => c.id === id), patch); });
}

async function transcribe({ slug, c, s }) {
  await setChunk(slug, c.id, { status: 'transcribing' });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talk-'));
  const started = Date.now();
  try {
    const wav = path.join(tmp, 'chunk.wav');
    if (c.source) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path.join(talkDir(slug), c.source), '-ss', String(c.from), '-to', String(c.to), '-ac', '1', '-ar', '16000', wav]);
    } else {
      const dir = path.join(talkDir(slug), 'audio', `take-${c.take}`);
      const first = Math.floor(c.from / config.pieceSeconds);
      const files = [];
      for (const f of (await fs.readdir(dir)).filter((f) => f.endsWith('.ogg')).sort()) {
        if ((await fs.stat(path.join(dir, f))).size > 0) files.push(f); // the piece open at stop time can be empty
      }
      const pieces = files.filter((f) => {
        const i = Number(f.slice(0, 5));
        return i >= first && i * config.pieceSeconds < c.to;
      });
      if (!pieces.length) throw new Error('no audio pieces for chunk');
      const list = path.join(tmp, 'list.txt');
      await fs.writeFile(list, pieces.map((f) => `file '${path.join(dir, f).replace(/'/g, "'\\''")}'`).join('\n'));
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
        '-ss', String(c.from - first * config.pieceSeconds), '-t', String(c.to - c.from), '-ac', '1', '-ar', '16000', wav]);
    }
    await run(config.whisperBin, ['-m', config.whisperModel, '-f', wav, '-l', 'en', '-np', '-oj', '-of', path.join(tmp, 'out'),
      '--prompt', whisperPrompt(s), '--carry-initial-prompt', '-sns']);
    const out = JSON.parse(await fs.readFile(path.join(tmp, 'out.json'), 'utf8'));
    const segments = (out.transcription || [])
      .map((x) => ({ start: c.from + x.offsets.from / 1000, end: c.from + x.offsets.to / 1000, text: x.text.trim() }))
      .filter((x) => x.text && !/^\[.*\]$/.test(x.text));
    await saveChunkSegments(slug, c.id, segments);
    await setChunk(slug, c.id, { status: 'done', seconds: Math.round((Date.now() - started) / 1000) });
    await rebuildTranscript(slug);
    // Last chunk of a talk that is no longer recording: add chapters and speakers.
    const after = await loadSession(slug);
    if (active?.slug !== slug && !after.chunks.some((x) => x.status === 'pending' || x.status === 'transcribing')) startStructure(slug);
  } catch (e) {
    console.error(`chunk ${slug}/${c.id}:`, e.message);
    await setChunk(slug, c.id, { status: 'error', error: e.message.slice(0, 300) });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

export async function retryChunk(slug, id) {
  await setChunk(slug, id, { status: 'pending', error: undefined });
  kick();
}

// Wait until the given chunk (and everything queued before it) has a transcript, or give up.
export async function waitForChunk(slug, id, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = (await loadSession(slug)).chunks.find((x) => x.id === id);
    if (!c || c.status === 'done' || c.status === 'error') return c;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

// After a crash: chunks caught mid-transcription go back to the queue, and a take that never
// stopped cleanly gets a final chunk covering whatever pieces ffmpeg managed to write.
export async function recover() {
  for (const { slug } of await listTalks()) {
    const s = await loadSession(slug).catch(() => null);
    if (!s?.takes?.length && !s?.chunks?.length) continue;
    await updateSession(slug, async (s) => {
      for (const c of s.chunks) if (c.status === 'transcribing') c.status = 'pending';
      for (const t of s.takes) {
        if (t.stoppedAt) continue;
        t.stoppedAt = Date.now();
        const dir = path.join(talkDir(slug), 'audio', `take-${t.take}`);
        const pieces = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.ogg'));
        const end = pieces.length * config.pieceSeconds;
        const from = Math.max(0, ...s.chunks.filter((c) => c.take === t.take).map((c) => c.to));
        if (end - from > 1) s.chunks.push({ id: `t${t.take}-${String(Math.round(from)).padStart(5, '0')}`, take: t.take, from, to: end, status: 'pending', priority: false, final: true });
      }
    });
  }
}
