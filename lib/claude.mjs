import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { talkDir, loadSession, updateSession, appendChat } from './store.mjs';
import { talkZero, clock, sessionHeader, notesText, transcriptText } from './transcript.mjs';
import { t, readPrompt } from './i18n.mjs';

// claude -p inherits the user's global allow-list; these jobs only ever need to read.
export const readOnly = ['Bash', 'Write', 'Edit', 'NotebookEdit'];

// Each turn carries the current notes and only the transcript that arrived since the previous turn;
// earlier material is already in the resumed Claude session.
async function buildTurn(slug, message) {
  const s = await loadSession(slug);
  const zero = talkZero(s);
  const notes = await notesText(slug, zero);
  const first = !s.claudeSession;
  const tr = await transcriptText(slug, s, first ? 0 : s.chatTranscriptCount || 0);
  const parts = [];
  if (first) parts.push(`<session>\n${config.conference}\n${sessionHeader(s)}\n</session>`);
  else if (s.references?.length) parts.push(`<references>\n${s.references.map((r) => `- ${r.title || r.url} — ${r.url}${r.file ? ` [snapshot: ${r.file}]` : ''}`).join('\n')}\n</references>`);
  parts.push(`<my_notes>\n${notes || t('ctx.noNotes')}\n</my_notes>`);
  parts.push(tr.text ? `<transcript${first ? '' : ' new_since_last_turn="true"'}>\n${tr.text}\n</transcript>` : (first ? `<transcript>${t('ctx.noTranscript')}</transcript>` : ''));
  parts.push(`<message>\n${message}\n</message>`);
  return { prompt: parts.filter(Boolean).join('\n\n'), session: s, transcriptCount: tr.count };
}

// Streams Claude's reply through onEvent({type:'text'|'status'|'done'|'error'}).
export async function chat(slug, message, onEvent) {
  const { prompt, session, transcriptCount } = await buildTurn(slug, message);
  const system = await readPrompt('chat-system.md');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', system, '--allowedTools', 'Read', 'Glob', 'Grep', 'WebFetch', '--disallowedTools', ...readOnly];
  if (session.claudeSession) args.push('--resume', session.claudeSession);
  const proc = spawn(config.claudeBin, args, { cwd: talkDir(slug), stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.end(prompt);

  let buf = '', reply = '', sessionId = session.claudeSession, stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        reply += ev.event.delta.text;
        onEvent({ type: 'text', text: ev.event.delta.text });
      } else if (ev.type === 'stream_event' && ev.event?.type === 'content_block_start' && ev.event.content_block?.type === 'tool_use') {
        onEvent({ type: 'status', text: t('chat.usingTool', { tool: ev.event.content_block.name }) });
      } else if (ev.type === 'stream_event' && ev.event?.type === 'message_start' && reply) {
        reply += '\n\n';
        onEvent({ type: 'text', text: '\n\n' });
      } else if (ev.type === 'result' && ev.is_error) {
        onEvent({ type: 'error', text: ev.result || t('chat.claudeError') });
      }
    }
  });
  const code = await new Promise((r) => proc.on('close', r));
  if (code !== 0 && !reply) {
    onEvent({ type: 'error', text: stderr.slice(-500) || `claude exited ${code}` });
    return;
  }
  await updateSession(slug, (s) => { s.claudeSession = sessionId; s.chatTranscriptCount = transcriptCount; });
  await appendChat(slug, [{ role: 'user', text: message, at: Date.now() }, { role: 'assistant', text: reply.trim(), at: Date.now() }]);
  onEvent({ type: 'done' });
}

export async function resetChat(slug) {
  await updateSession(slug, (s) => { s.claudeSession = null; s.chatTranscriptCount = 0; });
}

// ---- digest: one-shot, runs in the background; the reply text becomes digest.md ----

const digestJobs = new Map(); // slug -> { startedAt, error }

export function digestJob(slug) {
  return digestJobs.get(slug) || null;
}

export async function startDigest(slug) {
  if (digestJobs.get(slug)?.running) return digestJobs.get(slug);
  const job = { running: true, startedAt: Date.now(), error: null };
  digestJobs.set(slug, job);
  (async () => {
    try {
      const s = await loadSession(slug);
      const zero = talkZero(s);
      const notes = await notesText(slug, zero);
      const tr = await transcriptText(slug, s);
      const slides = (s.slides || []).map((x) => `- slides/${x.file} @ [${clock(x.at, zero)}]`).join('\n');
      const prompt = [
        await readPrompt('digest.md'),
        `<session>\n${config.conference}\n${sessionHeader(s)}\n</session>`,
        `<my_notes>\n${notes || t('ctx.noNotes')}\n</my_notes>`,
        `<slides>\n${slides || t('ctx.noSlides')}\n</slides>`,
        `<transcript>\n${tr.text || t('ctx.noTranscript')}\n</transcript>`,
      ].join('\n\n');
      const out = await new Promise((resolve, reject) => {
        const proc = spawn(config.claudeBin, ['-p', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read', 'Glob', 'Grep',
          '--disallowedTools', ...readOnly], { cwd: talkDir(slug), stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        proc.stdout.on('data', (d) => (stdout += d));
        proc.stderr.on('data', (d) => (stderr += d));
        proc.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-400) || `claude exited ${code}`))));
        proc.stdin.end(prompt);
      });
      // The article can arrive in an earlier assistant turn than the last one, so take the longest text block.
      const texts = [];
      for (const line of out.split('\n')) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant') texts.push(...ev.message.content.filter((c) => c.type === 'text').map((c) => c.text));
        if (ev.type === 'result' && ev.is_error) throw new Error(ev.result || 'digest failed');
      }
      const best = texts.sort((a, b) => b.length - a.length)[0] || '';
      if (best.length < 300) throw new Error(t('digest.noResult'));
      const md = best.slice(Math.max(0, best.indexOf('#'))).trim(); // drop any preamble before the title
      await fs.writeFile(path.join(talkDir(slug), 'digest.md'), md + '\n');
    } catch (e) {
      job.error = e.message;
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
    }
  })();
  return job;
}
