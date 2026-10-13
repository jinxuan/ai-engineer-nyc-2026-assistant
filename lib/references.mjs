import fs from 'node:fs/promises';
import path from 'node:path';
import { talkDir, updateSession } from './store.mjs';
import { t } from './i18n.mjs';

// Reference links get a text snapshot in links/ when added, so the digest and chat can use them
// without fetching again; Claude can still WebFetch deeper (e.g. one file in a repo) during chat.

const maxChars = 60000;

function htmlToText(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || '';
  const text = html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return { title, text };
}

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': 'talk-copilot', ...headers }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res;
}

async function snapshotGithub(owner, repo) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const meta = await (await get(api)).json();
  const readme = await get(`${api}/readme`, { accept: 'application/vnd.github.raw' }).then((r) => r.text()).catch(() => '');
  const tree = await get(`${api}/contents`).then((r) => r.json()).catch(() => []);
  const files = Array.isArray(tree) ? tree.map((f) => `- ${f.name}${f.type === 'dir' ? '/' : ''}`).join('\n') : '';
  return {
    title: `${owner}/${repo}${meta.description ? ` — ${meta.description}` : ''}`,
    text: `Top-level files:\n${files}\n\n## README\n\n${readme}`,
  };
}

async function snapshot(url, dir, n) {
  const u = new URL(url);
  const gh = u.hostname === 'github.com' && u.pathname.split('/').filter(Boolean);
  if (gh && gh.length >= 2) return snapshotGithub(gh[0], gh[1].replace(/\.git$/, ''));
  const slides = u.hostname === 'docs.google.com' && u.pathname.match(/\/presentation\/d\/([^/]+)/);
  if (slides) {
    const text = await (await get(`https://docs.google.com/presentation/d/${slides[1]}/export/txt`)).text();
    return { title: 'Google Slides', text };
  }
  const res = await get(url);
  const type = res.headers.get('content-type') || '';
  if (type.includes('pdf')) {
    // Kept as a file: Claude's Read tool reads PDFs directly.
    const file = `${n}.pdf`;
    await fs.writeFile(path.join(dir, file), Buffer.from(await res.arrayBuffer()));
    return { title: path.basename(u.pathname) || 'PDF', text: `(PDF saved as links/${file})` };
  }
  return htmlToText(await res.text());
}

// 'repo' and 'slides' are this talk's own materials and get shown up front; 'ref' is background reading.
export function guessKind(url) {
  const u = new URL(url);
  if (u.hostname === 'github.com' || u.hostname === 'gitlab.com') return 'repo';
  if (/(^|\.)(speakerdeck\.com|slideshare\.net|pitch\.com|gamma\.app|slides\.com)$/.test(u.hostname)) return 'slides';
  if (u.hostname === 'docs.google.com' && u.pathname.startsWith('/presentation/')) return 'slides';
  if (/\.(pdf|pptx?|key)$/i.test(u.pathname)) return 'slides';
  return 'ref';
}

export async function addReference(slug, url, { note = '', kind, confidence = 'high' } = {}) {
  url = new URL(url.trim()).toString();
  kind ||= guessKind(url);
  const dir = path.join(talkDir(slug), 'links');
  await fs.mkdir(dir, { recursive: true });
  const s = await updateSession(slug, (s) => {
    s.references ??= [];
    if (!s.references.some((r) => r.url === url)) s.references.push({ url, note, kind, confidence, n: Math.max(0, ...s.references.map((r) => r.n)) + 1 });
  });
  const ref = s.references.find((r) => r.url === url);
  let patch;
  try {
    const { title, text } = await snapshot(url, dir, ref.n);
    const file = `${ref.n}.md`;
    await fs.writeFile(path.join(dir, file), `# ${title || url}\n\nSource: ${url}\n${note ? `Note: ${note}\n` : ''}\n${text.slice(0, maxChars)}\n`);
    patch = { title: title || url, file: `links/${file}`, fetchedAt: Date.now(), error: null };
  } catch (e) {
    patch = { error: t('info.fetchFailed', { msg: e.message }), fetchedAt: Date.now() };
  }
  await updateSession(slug, (s) => { Object.assign(s.references.find((r) => r.url === url), patch); });
  return { ...ref, ...patch };
}

export async function removeReference(slug, url) {
  await updateSession(slug, (s) => {
    const ref = (s.references || []).find((r) => r.url === url);
    if (ref?.file) fs.rm(path.join(talkDir(slug), ref.file), { force: true });
    s.references = (s.references || []).filter((r) => r.url !== url);
  });
}

const speakerFields = ['name', 'role', 'company', 'bio', 'website', 'linkedin', 'twitter', 'github'];

export async function saveSpeakers(slug, speakers) {
  await updateSession(slug, (s) => {
    s.speakers = speakers
      .map((p) => Object.fromEntries(speakerFields.map((k) => [k, String(p[k] ?? '').trim()])))
      .filter((p) => p.name);
  });
}
