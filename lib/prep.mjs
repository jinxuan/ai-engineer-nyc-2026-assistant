import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { talkDir, loadSession, updateSession } from './store.mjs';
import { sessionHeader } from './transcript.mjs';
import { addReference } from './references.mjs';
import { t, readPrompt } from './i18n.mjs';
import { readOnly } from './claude.mjs';

// Prep: a model searches the web for this talk (its repo/slides, the speakers, background reading) and
// answers in plain text; we write prep.md and pick the repo/slides and speaker handles out of its first lines.
// Engine: Claude (WebSearch/WebFetch) by default, or the Grok CLI (config.prepEngine = "grok").

const timeoutMs = 5 * 60 * 1000;

// Runs a CLI that prints one JSON event per line; onLine sees each event.
function stream(cmd, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '', err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try { onLine(JSON.parse(line)); } catch {}
      }
    });
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === null) reject(new Error(t('prep.timeout')));
      else resolve({ code, err });
    });
  });
}

async function askClaude(prompt, cwd, onStep) {
  let result = '';
  const texts = [];
  const { code, err } = await stream(config.claudeBin, ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    '--allowedTools', 'WebSearch', 'WebFetch', '--disallowedTools', ...readOnly], cwd, (ev) => {
    if (ev.type === 'assistant') {
      for (const c of ev.message.content) {
        if (c.type === 'text') texts.push(c.text);
        if (c.type === 'tool_use' && c.name === 'WebSearch') onStep(t('prep.stepSearch', { q: c.input?.query }));
        if (c.type === 'tool_use' && c.name === 'WebFetch') onStep(t('prep.stepOpen', { url: c.input?.url }));
      }
    }
    if (ev.type === 'result' && !ev.is_error) result = ev.result || '';
  });
  // The formatted answer is usually the last message; fall back to the longest text block.
  const answer = /GitHub\s*[:：]/i.test(result) ? result : texts.sort((a, b) => b.length - a.length)[0] || result;
  if (!answer.trim()) throw new Error(err.trim().slice(-300) || `claude exited ${code}`);
  return answer.trim();
}

const grokTools = 'web_search,web_fetch,open_page,open_page_with_find,x_user_search,x_semantic_search,x_keyword_search,x_thread_fetch';

async function askGrok(prompt, cwd, onStep) {
  let text = '';
  // Read-only tools, auto-approved: in -p mode a tool that needs approval just cancels the run.
  const { code, err } = await stream(config.grokBin, ['-p', prompt, '--output-format', 'streaming-json', '--tools', grokTools, '--always-approve'], cwd, (ev) => {
    if (ev.type === 'text') text += ev.data;
    const action = ev.type === 'tool_call_update' && ev.rawOutput?.action;
    if (action?.query) onStep(t('prep.stepSearch', { q: action.query }));
    else if (action?.url) onStep(t('prep.stepOpen', { url: action.url }));
  });
  if (!text.trim()) throw new Error(err.trim().slice(-300) || `grok exited ${code}`);
  return text.trim();
}

// At most `parallel` searches at once; batch prep queues the rest.
const parallel = 3;
const running = new Set();
const queue = [];
export const prepRunning = (slug) => running.has(slug) || queue.includes(slug);

function next() {
  while (running.size < parallel && queue.length) run(queue.shift());
}

export async function startPrep(slug) {
  if (prepRunning(slug)) return;
  queue.push(slug);
  await updateSession(slug, (s) => { s.prep = { status: 'queued', queuedAt: Date.now() }; });
  next();
}

async function run(slug) {
  running.add(slug);
  const startedAt = Date.now();
  await updateSession(slug, (s) => { s.prep = { status: 'running', startedAt, steps: [] }; });
  try {
    const s = await loadSession(slug);
    const prompt = `${await readPrompt('prep.md')}\n${t('ctx.talkInfo')}\n${config.conference}\n${sessionHeader(s)}`;
    const cwd = path.join(config.cacheDir, 'prep');
    await fs.mkdir(cwd, { recursive: true });
    const steps = [];
    const onStep = (step) => {
      steps.push(step);
      updateSession(slug, (s) => { if (s.prep?.status === 'running') s.prep.steps = steps.slice(-30); });
    };
    const ask = config.prepEngine === 'grok' ? askGrok : askClaude;
    await savePrep(slug, await ask(prompt, cwd, onStep));
    await updateSession(slug, (s) => { s.prep = { status: 'done', startedAt, finishedAt: Date.now(), steps: steps.slice(-30) }; });
  } catch (e) {
    await updateSession(slug, (s) => { s.prep = { status: 'error', error: e.message.slice(0, 300), finishedAt: Date.now(), steps: s.prep?.steps }; });
  } finally {
    running.delete(slug);
    next();
  }
}

// The model sometimes narrates a sentence before the fixed "GitHub:" line; the file starts there.
export async function savePrep(slug, answer) {
  const at = answer.search(/GitHub\s*[:：]/i);
  const text = at > 0 ? answer.slice(at) : answer;
  await fs.writeFile(path.join(talkDir(slug), 'prep.md'), text.trim() + '\n');
  await apply(slug, text);
}

const url = (v) => v?.match(/https?:\/\/\S+/)?.[0].replace(/[)>\]，。]+$/, '') || '';

// prep.md starts with fixed lines: "GitHub: …", "Slides: …", "<Speaker>: name | X: … | LinkedIn: … | GitHub: … | <Website>: …".
async function apply(slug, text) {
  const lines = text.split('\n').slice(0, 15);
  const repo = url(lines.find((l) => /^GitHub\s*[:：]/i.test(l)));
  const slides = url(lines.find((l) => /^Slides\s*[:：]/i.test(l)));
  if (repo) await addReference(slug, repo, { kind: 'repo', note: t('prep.found') }).catch(() => {});
  if (slides) await addReference(slug, slides, { kind: 'slides', note: t('prep.found') }).catch(() => {});
  const keys = { x: 'twitter', twitter: 'twitter', linkedin: 'linkedin', github: 'github', website: 'website', [t('prep.websiteLabel').toLowerCase()]: 'website' };
  const speakerLine = new RegExp(`^(${t('prep.speakerLabel')}|Speaker)\\s*[:：]\\s*`, 'i');
  await updateSession(slug, (s) => {
    for (const line of lines.filter((l) => speakerLine.test(l))) {
      const [namePart, ...fields] = line.replace(speakerLine, '').split('|');
      const p = s.speakers.find((x) => x.name.toLowerCase() === namePart.trim().toLowerCase());
      if (!p) continue;
      for (const f of fields) {
        const [k, ...v] = f.split(/[:：]/);
        const key = keys[k.trim().toLowerCase()];
        const link = url(v.join(':'));
        if (key && link && !p[key]) p[key] = link; // never overwrite what's already there
      }
    }
  });
}
