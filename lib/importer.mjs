import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { talkDir, updateSession, loadSession } from './store.mjs';
import { kick } from './audio.mjs';
import { t } from './i18n.mjs';

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

export const audioExt = /\.(m4a|mp3|wav|aac|caf|ogg|opus|flac|mp4|mov|webm)$/i;
export const imageExt = /\.(jpe?g|png|heic|webp)$/i;
export const deckExt = /\.(pdf|pptx|key)$/i;

// Phone recordings (Voice Memos) don't carry their start time once AirDropped, so the default
// is the scheduled start; the caller can pass a better one.
export async function importAudio(slug, src, { startedAt } = {}) {
  const s = await loadSession(slug);
  const duration = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src])).out);
  if (!duration) throw new Error(t('err.noDuration'));
  const n = s.takes.length + 1;
  const rel = path.join('audio', `import-${n}.ogg`);
  await fs.mkdir(path.join(talkDir(slug), 'audio'), { recursive: true });
  // Re-encode small (mono 16 kHz Opus, ~11 MB/hour); the original file is left where it is.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', path.join(talkDir(slug), rel)]);
  const { err } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', path.join(talkDir(slug), rel), '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-']);
  const pauses = [...err.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]) - Number(m[2]) / 2);
  const cuts = [];
  for (let from = 0; from < duration;) {
    let to = pauses.find((p) => p >= from + config.minChunk && p <= from + config.maxChunk) ?? Math.min(from + config.maxChunk, duration);
    if (duration - to < 30) to = duration; // don't leave a tiny tail chunk
    cuts.push([from, to]);
    from = to;
  }
  const start = startedAt || (s.startsAt ? Date.parse(s.startsAt) : Date.now() - duration * 1000);
  await updateSession(slug, (s) => {
    s.takes.push({ take: n, startedAt: start, stoppedAt: start + duration * 1000, source: rel, importedFrom: path.basename(src) });
    s.takes.sort((a, b) => a.startedAt - b.startedAt);
    for (const [from, to] of cuts) {
      s.chunks.push({ id: `t${n}-${String(Math.round(from)).padStart(5, '0')}`, take: n, from, to, status: 'pending', priority: false, source: rel });
    }
  });
  kick();
  return { duration, chunks: cuts.length };
}

// EXIF times are local wall-clock without a zone; read them as conference-local time.
function localToEpoch(y, mo, d, h, mi, sec) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(guess).map((p) => [p.type, Number(p.value)]));
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return guess - (asLocal - guess);
}

async function capturedAt(file) {
  try {
    const m = (await run('sips', ['-g', 'creation', file])).out.match(/creation: (\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
    if (m) return localToEpoch(...m.slice(1).map(Number));
  } catch {}
  try {
    const { out } = await run('mdls', ['-raw', '-name', 'kMDItemContentCreationDate', file]);
    const t = Date.parse(out.trim().replace(' +0000', 'Z').replace(' ', 'T'));
    if (t) return t;
  } catch {}
  return (await fs.stat(file)).mtimeMs;
}

// Slides are shrunk to 1600px JPEG (sips ships with macOS); capture time decides where they sit in the timeline.
export async function importImage(slug, src) {
  const dir = path.join(talkDir(slug), 'slides');
  await fs.mkdir(dir, { recursive: true });
  const at = await capturedAt(src);
  const name = `${path.basename(src).replace(/\.[^.]+$/, '')}.jpg`;
  await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '1600', src, '--out', path.join(dir, name)]);
  await updateSession(slug, (s) => {
    s.slides = (s.slides || []).filter((x) => x.file !== name);
    s.slides.push({ file: name, at });
    s.slides.sort((a, b) => a.at - b.at);
  });
  return { file: name, at };
}

export async function importDeck(slug, src) {
  const dir = path.join(talkDir(slug), 'slides');
  await fs.mkdir(dir, { recursive: true });
  await fs.copyFile(src, path.join(dir, path.basename(src)));
  await updateSession(slug, (s) => {
    s.decks = [...new Set([...(s.decks || []), path.basename(src)])];
  });
  return { file: path.basename(src) };
}

export async function importFile(slug, src, opts) {
  if (audioExt.test(src)) return { kind: 'audio', ...(await importAudio(slug, src, opts)) };
  if (imageExt.test(src)) return { kind: 'image', ...(await importImage(slug, src)) };
  if (deckExt.test(src)) return { kind: 'deck', ...(await importDeck(slug, src)) };
  throw new Error(t('err.unsupported', { name: path.basename(src) }));
}
