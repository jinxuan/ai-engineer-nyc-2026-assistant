import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { talkDir, loadSession, updateSession } from './store.mjs';
import { transcriptSegments, rebuildTranscript, talkZero, clock } from './transcript.mjs';
import { t, readPrompt } from './i18n.mjs';

// Chapters + speaker turns for a finished transcript, from one cheap Claude (Haiku) pass.
// The model sees ~15s numbered blocks and answers in two line types: "CH <i> <title>" / "SP <i> <speaker>".

const blockMs = 15000;
const running = new Set();
export const structureRunning = (slug) => running.has(slug);

function blocksOf(segs) {
  const blocks = [];
  for (const seg of segs) {
    const last = blocks.at(-1);
    if (last && seg.at - last.at < blockMs) last.text += ` ${seg.text}`;
    else blocks.push({ at: seg.at, text: seg.text });
  }
  return blocks;
}

export async function startStructure(slug) {
  if (running.has(slug)) return;
  running.add(slug);
  await updateSession(slug, (s) => { s.structureJob = { status: 'running', startedAt: Date.now() }; });
  (async () => {
    try {
      const s = await loadSession(slug);
      const zero = talkZero(s);
      const segs = await transcriptSegments(slug, s);
      if (!segs.length) throw new Error(t('err.noTranscript'));
      const blocks = blocksOf(segs);
      const speakers = s.speakers.map((p) => p.name).join(', ') || t('ctx.speakerFallback');
      const prompt = `${await readPrompt('structure.md')}
${t('ctx.talk')}: ${s.title}
${t('ctx.speakers')}: ${speakers}

${blocks.map((b, i) => `[${i} ${clock(b.at, zero)}] ${b.text}`).join('\n')}`;
      const out = await new Promise((resolve, reject) => {
        const p = spawn(config.claudeBin, ['-p', '--model', 'haiku', '--tools', ''], { cwd: talkDir(slug), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-300) || `claude exited ${code}`))));
        p.stdin.end(prompt);
      });
      const chapters = [], turns = [];
      for (const m of out.matchAll(/^(CH|SP)\s+(\d+)\s+(.+)$/gm)) {
        const b = blocks[Number(m[2])];
        if (!b) continue;
        (m[1] === 'CH' ? chapters : turns).push({ at: b.at, [m[1] === 'CH' ? 'title' : 'speaker']: m[3].trim() });
      }
      if (!chapters.length && !turns.length) throw new Error(t('err.noChapters'));
      await fs.writeFile(path.join(talkDir(slug), 'structure.json'), JSON.stringify({ basedOn: segs.length, chapters, turns }, null, 2));
      await rebuildTranscript(slug);
      await updateSession(slug, (s) => { s.structureJob = { status: 'done', finishedAt: Date.now() }; });
    } catch (e) {
      await updateSession(slug, (s) => { s.structureJob = { status: 'error', error: e.message.slice(0, 300), finishedAt: Date.now() }; });
    } finally {
      running.delete(slug);
    }
  })();
}
