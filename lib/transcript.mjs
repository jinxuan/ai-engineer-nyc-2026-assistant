import fs from 'node:fs/promises';
import path from 'node:path';
import { talkDir, loadSession, loadNotes, loadChunkSegments } from './store.mjs';

// All times are epoch ms; the talk's zero point is its first take (or creation, for talks never recorded here).

export function talkZero(s) {
  return s.takes?.[0]?.startedAt ?? s.createdAt;
}

export function clock(ms, zero) {
  const sec = Math.max(0, Math.round((ms - zero) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = sec % 60;
  const mm = `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  return h ? `${h}:${mm}` : mm;
}

export async function transcriptSegments(slug, s) {
  s ??= await loadSession(slug);
  const out = [];
  for (const c of s.chunks.filter((c) => c.status === 'done')) {
    const base = s.takes.find((t) => t.take === c.take)?.startedAt ?? s.createdAt;
    for (const seg of (await loadChunkSegments(slug, c.id)) || []) {
      out.push({ at: base + seg.start * 1000, text: seg.text });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// Chapters and speaker turns from the Haiku pass (lib/structure.mjs), if it has run.
export async function loadStructure(slug) {
  try { return JSON.parse(await fs.readFile(path.join(talkDir(slug), 'structure.json'), 'utf8')); } catch { return null; }
}

// Merge Whisper's short segments into ~30s paragraphs so the file reads like a transcript, not subtitles.
// A chapter start or a change of speaker always starts a new paragraph; such paragraphs carry
// `chapter` / `speaker` so renderers can show a heading or a name.
export function paragraphs(segs, structure) {
  const marks = [
    ...(structure?.chapters || []).map((c) => ({ at: c.at, chapter: c.title })),
    ...(structure?.turns || []).map((t) => ({ at: t.at, speaker: t.speaker })),
  ].sort((a, b) => a.at - b.at);
  const paras = [];
  let m = 0, speaker = null;
  for (const seg of segs) {
    let chapter = null, turn = false;
    while (m < marks.length && marks[m].at <= seg.at) {
      if (marks[m].chapter) chapter = marks[m].chapter;
      if (marks[m].speaker && marks[m].speaker !== speaker) { speaker = marks[m].speaker; turn = true; }
      m++;
    }
    const last = paras.at(-1);
    if (last && !chapter && !turn && seg.at - last.at < 30000) last.text += ` ${seg.text}`;
    else paras.push({ at: seg.at, text: seg.text, ...(chapter && { chapter }), ...((turn || chapter) && speaker && { speaker }) });
  }
  return paras;
}

function formatParas(paras, zero) {
  return paras.map((p) => `${p.chapter ? `## [${clock(p.at, zero)}] ${p.chapter}\n\n` : ''}[${clock(p.at, zero)}] ${p.speaker ? `**${p.speaker}：** ` : ''}${p.text}`).join('\n\n');
}

export async function rebuildTranscript(slug) {
  const s = await loadSession(slug);
  const zero = talkZero(s);
  const body = formatParas(paragraphs(await transcriptSegments(slug, s), await loadStructure(slug)), zero);
  await fs.writeFile(path.join(talkDir(slug), 'transcript.md'), `# Transcript: ${s.title}\n\n> Auto-transcribed (Whisper). Names and terms may be wrong.\n\n${body}\n`);
}

export function speakerLine(p) {
  const role = [p.role, p.company].filter(Boolean).join(', ');
  const handles = ['twitter', 'linkedin', 'github', 'website'].filter((k) => p[k]).map((k) => `${k}: ${p[k]}`).join(', ');
  return `${p.name}${role ? ` (${role})` : ''}${handles ? ` [${handles}]` : ''}${p.bio ? `\n  Bio: ${p.bio.replace(/\s+/g, ' ').slice(0, 600)}` : ''}`;
}

export function sessionHeader(s) {
  const speakers = s.speakers.map((p) => `- ${speakerLine(p)}`).join('\n');
  const refs = (s.references || []).map((r) => `- ${r.title || r.url} — ${r.url}${r.note ? ` (${r.note})` : ''}${r.file ? ` [snapshot: ${r.file}]` : ''}`).join('\n');
  return [
    `Title: ${s.title}`,
    speakers && `Speakers:\n${speakers}`,
    refs && `References (shared by the speaker or added by me):\n${refs}`,
    s.time && `Time: ${s.time}${s.room ? ` · ${s.room}` : ''}`,
    s.link && `Link: ${s.link}`,
    s.description && `Abstract:\n${s.description}`,
  ].filter(Boolean).join('\n');
}

export async function notesText(slug, zero) {
  const { lines } = await loadNotes(slug);
  return lines.map((l) => (l.t ? `[${clock(l.t, zero)}] ` : '[--:--] ') + l.text).join('\n');
}

export async function transcriptText(slug, s, fromIndex = 0) {
  const zero = talkZero(s);
  const segs = await transcriptSegments(slug, s);
  return { count: segs.length, text: formatParas(paragraphs(segs.slice(fromIndex), await loadStructure(slug)), zero) };
}
