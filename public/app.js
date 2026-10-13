const $ = (s) => document.querySelector(s);
const api = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { 'content-type': 'application/json' } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
};
const enc = encodeURIComponent;

// UI strings: English in the repo, optionally overridden by local/strings.json (served merged by the API).
const S = await (await fetch('/api/strings')).json();
const t = (k, v = {}) => (S[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => v[x] ?? '');
document.documentElement.lang = S._lang || 'en';
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));

let current = null;   // slug
let state = null;     // last /api/talks/:slug payload
let modes = [];
let chatBusy = false;

function clock(ms, zero) {
  const sec = Math.max(0, Math.round((ms - zero) / 1000));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h ? `${h}:${mm}` : mm;
}
const wallClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
// Before anything was recorded, note times show wall-clock; afterwards, time into the recording.
const stamp = (t) => (!t ? '' : state?.session?.takes?.length ? clock(t, state.zero) : wallClock(t));

// ---------- sidebar ----------

async function loadSidebar() {
  const talks = await api('/api/talks');
  const status = await api('/api/status');
  modes = status.modes;
  const recSlug = status.recording?.slug;
  const byDay = Map.groupBy(talks, (t) => t.date);
  const nav = $('#talk-list');
  nav.innerHTML = '';
  for (const [day, items] of byDay) {
    const h = document.createElement('div');
    h.className = 'day';
    const d = new Date(`${day}T12:00:00`);
    h.textContent = isNaN(d) ? day : d.toLocaleDateString(S._lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'long', day: 'numeric', weekday: 'short' });
    nav.append(h);
    for (const talk of items) {
      const a = document.createElement('a');
      a.className = 'talk-item' + (talk.slug === current ? ' active' : '');
      a.href = `#${enc(talk.slug)}`;
      const hhmm = talk.slug.slice(11, 15);
      a.innerHTML = '<span class="time"></span><div><div class="t"></div><div class="s"><span class="sdot"></span><span></span></div></div>';
      a.querySelector('.time').textContent = /^\d{4}$/.test(hhmm) ? `${hhmm.slice(0, 2)}:${hhmm.slice(2)}` : '';
      a.querySelector('.t').textContent = talk.title.replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
      const dot = a.querySelector('.sdot');
      if (talk.slug === recSlug) dot.classList.add('rec');
      else if (talk.hasDigest) dot.classList.add('done');
      const prepLabel = { queued: t('side.prepQueued'), running: t('side.prepRunning') }[talk.prep];
      a.querySelector('.s span:last-child').textContent = talk.slug === recSlug ? t('side.recording') : [talk.speakers, prepLabel || (talk.hasDigest && t('side.digested'))].filter(Boolean).join(' · ');
      nav.append(a);
    }
  }
  $('#status-line').textContent = status.model ? '' : t('app.modelMissing');
}

// ---------- talk view ----------

async function openTalk(slug) {
  if (current && current !== slug) await flushNotes();
  current = slug;
  if (!slug) { $('#talk').hidden = true; $('#empty').hidden = false; return; }
  state = await api(`/api/talks/${enc(slug)}`);
  $('#empty').hidden = true;
  $('#talk').hidden = false;
  renderHead();
  renderInfo();
  renderNotes(state.notes);
  renderTranscript();
  renderModes();
  setView(openOnView || 'live');
  openOnView = null;
  await renderChatHistory();
  loadSidebar();
}

function renderHead() {
  const s = state.session;
  $('#t-title').textContent = s.title;
  renderMaterials();
  renderRecording();
}

const kindLabel = { repo: t('kind.repo'), slides: t('kind.slides'), ref: t('kind.ref') };

// Meta line: speakers · time · room · schedule link, then this talk's own repo / slides (only when found).
function renderMaterials() {
  const s = state.session;
  const meta = $('#t-meta');
  meta.innerHTML = '';
  const text = [s.speakers.map((p) => [p.name, p.company].filter(Boolean).join(' · ')).join('，'), s.time, s.room].filter(Boolean).join('　·　');
  if (text) meta.append(Object.assign(document.createElement('span'), { textContent: text }));
  if (s.link) meta.append(Object.assign(document.createElement('a'), { href: s.link, target: '_blank', textContent: t('head.agenda') }));
  for (const r of (s.references || []).filter((r) => r.kind === 'repo' || r.kind === 'slides')) {
    const a = document.createElement('a');
    a.className = `material ${r.confidence === 'medium' ? 'medium' : ''}`;
    a.href = r.url; a.target = '_blank'; a.title = r.note || r.url;
    a.innerHTML = `<b></b><span></span>`;
    a.querySelector('b').textContent = kindLabel[r.kind] + (r.confidence === 'medium' ? '?' : '');
    a.querySelector('span').textContent = (r.title || r.url).replace(/^https?:\/\/(www\.)?/, '');
    meta.append(a);
  }
  if (state.prep?.status === 'queued') meta.append(Object.assign(document.createElement('span'), { className: 'searching', textContent: t('head.prepQueued') }));
  if (state.prep?.status === 'running') meta.append(Object.assign(document.createElement('span'), { className: 'searching', textContent: t('head.prepRunning', { step: state.prep.steps?.at(-1) || t('head.prepStarting') }) }));
}

function renderRecording() {
  const rec = state.recording;
  $('#rec-btn').classList.toggle('on', !!rec);
  $('#rec-cut').hidden = !rec;
  showNotice(state.recordingElsewhere ? t('app.recordingElsewhere', { name: state.recordingElsewhere.replace(/^\d{4}-\d{2}-\d{2} \d{4} /, '') }) : '');
  tickClock();
}

function tickClock() {
  if (!state) return;
  const rec = state.recording;
  $('#rec-label').textContent = rec ? t('rec.stop', { time: clock(Date.now(), rec.startedAt) }) : state.session.takes.length ? t('rec.resume') : t('rec.start');
}

let noticeTimer = null;
function showNotice(text, ms) {
  clearTimeout(noticeTimer);
  $('#notice').hidden = !text;
  $('#notice').textContent = text;
  if (text && ms) noticeTimer = setTimeout(() => showNotice(''), ms);
}
setInterval(tickClock, 1000);

function chunkTime(c) {
  const take = state.session.takes.find((t) => t.take === c.take);
  const base = take?.startedAt ?? state.session.createdAt;
  return `${clock(base + c.from * 1000, state.zero)}–${clock(base + c.to * 1000, state.zero)}`;
}

const statusText = { pending: t('chunk.pending'), transcribing: t('chunk.transcribing'), done: t('chunk.done'), error: t('chunk.error') };

function renderTranscript() {
  const chunks = state.session.chunks;
  const done = chunks.filter((c) => c.status === 'done');
  const failed = chunks.filter((c) => c.status === 'error').length;
  const minutes = Math.round(done.reduce((a, c) => a + c.to - c.from, 0) / 60);
  $('#seg-tr').textContent = chunks.length ? `${done.length}/${chunks.length}` : '';
  $('#seg-sl').textContent = (state.session.slides || []).length || '';
  $('#tr-status').textContent = !chunks.length && !state.recording ? t('tr.none')
    : t('tr.status', { done: done.length, total: chunks.length, min: minutes }) + (failed ? t('tr.failed', { n: failed }) : '') + (state.recording ? t('tr.recording') : '');
  $('#tr-prog').style.width = chunks.length ? `${(done.length / chunks.length) * 100}%` : '0';
  const box = $('#chunks');
  box.innerHTML = '';
  for (const c of state.session.chunks) {
    const row = document.createElement('div');
    row.className = 'chunk';
    row.innerHTML = `<span class="pill ${c.status}">${statusText[c.status]}</span><span class="mono"></span>`;
    row.querySelector('.mono').textContent = chunkTime(c) + (c.seconds ? `  (${c.seconds}s)` : '');
    if (c.status === 'error') {
      const b = document.createElement('button');
      b.className = 'link small'; b.textContent = t('tr.retry'); b.title = c.error || '';
      b.onclick = () => api(`/api/talks/${enc(current)}/chunks/${enc(c.id)}/retry`, { method: 'POST' }).then(refresh);
      row.append(b);
    }
    box.append(row);
  }
  if (state.recording) {
    const row = document.createElement('div');
    row.className = 'chunk';
    const take = state.session.takes.at(-1);
    row.innerHTML = `<span class="pill live">${t('tr.live')}</span><span class="mono">${clock(take.startedAt + state.recording.chunkStart * 1000, state.zero)}–now</span>`;
    box.append(row);
  }
  const tr = $('#transcript');
  const pane = $('#side-transcript');
  const atBottom = !state.chapters.length && pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  tr.innerHTML = '';
  const host = state.session.speakers.map((p) => p.name);
  for (const para of state.transcript) {
    if (para.chapter) {
      const h = document.createElement('h4');
      h.id = `ch-${para.at}`;
      h.innerHTML = '<span></span><b></b>';
      h.firstChild.textContent = clock(para.at, state.zero);
      h.lastChild.textContent = para.chapter;
      tr.append(h);
    }
    const p = document.createElement('p');
    p.innerHTML = '<span class="ts"></span><span class="who"></span><span></span>';
    p.children[0].textContent = clock(para.at, state.zero);
    if (para.speaker) {
      p.children[1].textContent = para.speaker;
      if (!host.includes(para.speaker)) p.children[1].classList.add('audience');
    }
    p.children[2].textContent = para.text;
    tr.append(p);
  }
  // Chapter picker: jump on change; follows the scroll position (see syncToc).
  const toc = $('#toc');
  toc.hidden = !state.chapters.length;
  toc.innerHTML = '';
  for (const c of state.chapters) toc.append(new Option(`${clock(c.at, state.zero)}　${c.title}`, c.at));
  const job = state.structureJob;
  const finished = chunks.length && done.length === chunks.length && !state.recording;
  $('#structure-btn').hidden = !finished || job?.status === 'running';
  $('#structure-btn').textContent = state.chapters.length ? t('tr.restructure') : t('tr.structure');
  if (job?.status === 'running') $('#tr-status').textContent += t('tr.structuring');
  if (job?.status === 'error') $('#tr-status').textContent += t('tr.structureFailed', { msg: job.error });
  if (!state.transcript.length) tr.innerHTML = `<p class="side-empty">${t('tr.empty')}</p>`;
  if (atBottom) pane.scrollTop = pane.scrollHeight;
  renderSlides();
}

function renderSlides() {
  const box = $('#slides');
  box.innerHTML = (state.session.slides || []).length ? '' : `<p class="side-empty">${t('slides.empty')}</p>`;
  for (const sl of state.session.slides || []) {
    const a = document.createElement('a');
    a.href = `/files/${enc(current)}/slides/${enc(sl.file)}`;
    a.target = '_blank';
    a.innerHTML = '<img loading="lazy" alt=""><span></span>';
    a.querySelector('img').src = a.href;
    a.querySelector('span').textContent = clock(sl.at, state.zero);
    const i = box.children.length;
    a.onclick = (e) => {
      e.preventDefault();
      openLightbox(state.session.slides.map((x, j) => ({ src: `/files/${enc(current)}/slides/${enc(x.file)}`, caption: `${j + 1} / ${state.session.slides.length}　·　${clock(x.at, state.zero)}` })), i);
    };
    box.append(a);
  }
}

// ---------- slide viewer: ← → to flip, Esc to close ----------

let lb = null; // { items, i }
function openLightbox(items, i) {
  lb = { items, i };
  showLightbox();
  $('#lightbox').hidden = false;
}
function showLightbox() {
  const it = lb.items[lb.i];
  $('#lightbox img').src = it.src;
  $('#lightbox figcaption').textContent = it.caption;
}
function stepLightbox(d) {
  lb.i = (lb.i + d + lb.items.length) % lb.items.length;
  showLightbox();
}
function closeLightbox() { lb = null; $('#lightbox').hidden = true; }
$('.lb-prev').onclick = () => stepLightbox(-1);
$('.lb-next').onclick = () => stepLightbox(1);
$('.lb-close').onclick = closeLightbox;
$('#lightbox').onclick = (e) => { if (e.target.id === 'lightbox') closeLightbox(); };
document.addEventListener('keydown', (e) => {
  if (!lb) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
  if (e.key === 'Escape') closeLightbox();
});

async function refresh(force = false) {
  if (!current) return;
  const slug = current;
  const next = await api(`/api/talks/${enc(slug)}`).catch(() => null);
  if (!next || slug !== current) return;
  const changed = JSON.stringify([next.chapters, next.structureJob, next.session.slides, next.session.chunks, next.recording?.chunkStart, next.transcript.length, !!next.recording]) !==
    JSON.stringify([state.chapters, state.structureJob, state.session.slides, state.session.chunks, state.recording?.chunkStart, state.transcript.length, !!state.recording]);
  const wasRecording = !!state.recording;
  const prepChanged = force || JSON.stringify([next.prep, next.session.references, next.session.speakers]) !== JSON.stringify([state.prep, state.session.references, state.session.speakers]);
  state = { ...next, notes: state.notes, prevDigestFinished: state.prevDigestFinished };
  if (changed) { renderTranscript(); renderRecording(); }
  if (prepChanged) { renderMaterials(); if (!$('#view-info').querySelector('form')) renderInfo(); if (view === 'prep') renderPrep(); }
  else if (view === 'prep' && next.prep?.status === 'running') renderPrep();
  if (view === 'digest' && (next.digestJob?.running || next.digestJob?.finishedAt !== state.prevDigestFinished)) {
    state.prevDigestFinished = next.digestJob?.finishedAt;
    renderDigest();
  }
  if (wasRecording !== !!next.recording) loadSidebar();
}
setInterval(refresh, 2000);
setInterval(loadSidebar, 5000); // prep / recording status in the list

// ---------- recording ----------

$('#rec-btn').onclick = async () => {
  try {
    await api(`/api/talks/${enc(current)}/record/${state.recording ? 'stop' : 'start'}`, { method: 'POST' });
    await refresh(true);
    renderRecording();
    renderTranscript();
    restamp();
    loadSidebar();
  } catch (e) { alert(e.message); }
};
const cut = () => state?.recording && api(`/api/talks/${enc(current)}/record/cut`, { method: 'POST' }).then(refresh);
$('#rec-cut').onclick = cut;
document.addEventListener('keydown', (e) => {
  if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); cut(); }
});

// ---------- speakers + references ----------

const handleFields = ['twitter', 'linkedin', 'github', 'website'].map((k) => [k, t(`field.${k}`)]);
const handleUrl = (k, v) => /^https?:\/\//.test(v) ? v
  : k === 'twitter' ? `https://x.com/${v.replace(/^@/, '')}`
  : k === 'github' ? `https://github.com/${v.replace(/^@/, '')}`
  : k === 'linkedin' ? `https://www.linkedin.com/in/${v}` : `https://${v}`;

function renderInfo() {
  const s = state.session;
  const refs = s.references || [];
  const box = $('#speakers');
  box.innerHTML = '';
  s.speakers.forEach((p, i) => box.append(speakerCard(p, i)));
  const list = $('#refs');
  list.innerHTML = '';
  for (const r of refs) {
    const row = document.createElement('div');
    row.className = 'ref';
    row.innerHTML = '<span class="kind"></span><a target="_blank"></a><button class="link small"></button><span class="note"></span>';
    row.querySelector('button').textContent = t('info.delete');
    row.querySelector('.kind').textContent = kindLabel[r.kind || 'ref'] + (r.confidence === 'medium' ? '?' : '');
    row.querySelector('.kind').classList.add(r.kind || 'ref');
    row.querySelector('a').href = r.url;
    row.querySelector('a').textContent = r.title || r.url;
    const info = row.querySelector('.note');
    info.textContent = [r.note, r.error || (r.file ? t('info.snapshot') : t('info.fetching'))].filter(Boolean).join(' · ');
    if (r.error) info.classList.add('error');
    row.querySelector('button').onclick = async () => {
      await api(`/api/talks/${enc(current)}/references?url=${enc(r.url)}`, { method: 'DELETE' });
      await reloadInfo();
    };
    list.append(row);
  }
}

function speakerCard(p, i) {
  const card = document.createElement('div');
  card.className = 'speaker';
  card.innerHTML = '<div class="who"></div><div class="bio"></div><div class="chips"></div>';
  card.querySelector('.who').textContent = p.name;
  card.querySelector('.who').append(Object.assign(document.createElement('span'), { textContent: [p.role, p.company].filter(Boolean).join(' · ') }));
  const bio = card.querySelector('.bio');
  bio.textContent = p.bio || '';
  bio.onclick = () => bio.classList.toggle('full');
  const chips = card.querySelector('.chips');
  for (const [k, label] of handleFields) {
    if (!p[k]) continue;
    const a = document.createElement('a');
    a.className = 'chip'; a.target = '_blank'; a.href = handleUrl(k, p[k]); a.textContent = label;
    chips.append(a);
  }
  const edit = document.createElement('button');
  edit.className = 'link small'; edit.textContent = t('info.edit');
  edit.onclick = () => card.replaceWith(speakerForm(p, i));
  chips.append(edit);
  return card;
}

function speakerForm(p, i) {
  const form = document.createElement('form');
  form.className = 'speaker';
  const fields = [...['name', 'role', 'company'].map((k) => [k, t(`field.${k}`)]), ...handleFields];
  form.innerHTML = `<div class="speaker-edit">${fields.map(([k, l]) => `<label>${l}<input name="${k}"></label>`).join('')}</div>
    <label class="small muted">${t('field.bio')}<textarea name="bio" rows="2"></textarea></label>
    <div class="chips"><button class="btn primary" type="submit">${t('info.save')}</button><button type="button" class="btn" data-act="cancel">${t('info.cancel')}</button><button type="button" class="link small" data-act="del">${t('info.deleteSpeaker')}</button></div>`;
  for (const [k] of [...fields, ['bio']]) form.elements[k].value = p[k] || '';
  const save = async (speakers) => {
    await api(`/api/talks/${enc(current)}/speakers`, { method: 'PUT', body: JSON.stringify({ speakers }) });
    await reloadInfo();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const next = Object.fromEntries([...fields, ['bio']].map(([k]) => [k, form.elements[k].value]));
    if (!next.name.trim()) { form.elements.name.focus(); return; }
    const speakers = [...state.session.speakers];
    speakers[i] = { ...p, ...next };
    save(speakers);
  };
  form.querySelector('[data-act=cancel]').onclick = () => renderInfo();
  form.querySelector('[data-act=del]').onclick = () => save(state.session.speakers.filter((_, j) => j !== i));
  setTimeout(() => form.elements[p.name ? 'twitter' : 'name'].focus());
  return form;
}

async function reloadInfo() {
  state = { ...(await api(`/api/talks/${enc(current)}`)), notes: state.notes };
  renderHead();
  renderInfo();
}

$('#speaker-add').onclick = () => {
  $('#speakers').append(speakerForm({}, state.session.speakers.length));
};
$('#ref-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#ref-url').value.trim();
  if (!url) return;
  const note = $('#ref-note').value.trim();
  $('#ref-url').value = ''; $('#ref-note').value = '';
  const pending = document.createElement('div');
  pending.className = 'ref muted small';
  pending.textContent = t('info.fetchingUrl', { url });
  $('#refs').append(pending);
  try {
    await api(`/api/talks/${enc(current)}/references`, { method: 'POST', body: JSON.stringify({ url, note }) });
  } catch (err) { alert(err.message); }
  await reloadInfo();
};

$('#toc').onchange = (e) => document.getElementById(`ch-${e.target.value}`)?.scrollIntoView({ block: 'start' });
function syncToc() {
  const pane = $('#side-transcript');
  const top = pane.getBoundingClientRect().top + 110;
  let current = null;
  for (const h of $('#transcript').querySelectorAll('h4')) {
    if (h.getBoundingClientRect().top <= top + 1) current = h.id.slice(3);
    else break;
  }
  if (current) $('#toc').value = current;
}
$('#side-transcript').addEventListener('scroll', syncToc, { passive: true });

$('#structure-btn').onclick = async () => {
  await api(`/api/talks/${enc(current)}/structure`, { method: 'POST' });
  await refresh(true);
  renderTranscript();
};

// Narrow windows hide the sidebar behind ☰.
$('#menu-btn').onclick = () => document.body.classList.toggle('menu-open');
$('#talk-list').addEventListener('click', () => document.body.classList.remove('menu-open'));

// ---------- side panel: chat / transcript / slides ----------

for (const b of document.querySelectorAll('.seg button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('active', x === b);
    for (const k of ['chat', 'transcript', 'slides']) $(`#side-${k}`).hidden = k !== b.dataset.side;
    if (b.dataset.side === 'transcript') $('#side-transcript').scrollTop = $('#side-transcript').scrollHeight;
  };
}

// ---------- views + digest ----------

let view = 'live';
let openOnView = null;
function setView(v) {
  view = v;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.view === v);
  $('#view-live').hidden = v !== 'live';
  $('#view-digest').hidden = v !== 'digest';
  $('#view-prep').hidden = v !== 'prep';
  $('#view-info').hidden = v !== 'info';
  if (v === 'digest') renderDigest();
  if (v === 'prep') renderPrep();
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setView(b.dataset.view);

async function renderDigest() {
  const s = state.session;
  const notes = state.notes.filter((l) => l.text.trim()).length;
  const minutes = Math.round(s.chunks.filter((c) => c.status === 'done').reduce((a, c) => a + c.to - c.from, 0) / 60);
  const pending = s.chunks.filter((c) => c.status !== 'done').length;
  $('#digest-materials').textContent = t('digest.materials', { notes, min: minutes, pending: pending ? t('digest.pending', { n: pending }) : '', slides: (s.slides || []).length });
  const job = state.digestJob;
  const st = $('#digest-status');
  $('#digest-btn').textContent = state.hasDigest ? t('digest.regenerate') : t('digest.generate');
  $('#digest-btn').disabled = !!job?.running;
  if (job?.running) st.textContent = t('digest.running', { s: Math.round((Date.now() - job.startedAt) / 1000) });
  else if (job?.error) st.innerHTML = `<span class="error"></span>`, (st.firstChild.textContent = t('app.failed', { msg: job.error }));
  else st.textContent = '';
  $('#digest-empty').hidden = state.hasDigest || !!job?.running;
  if (!state.hasDigest) { $('#digest').innerHTML = ''; return; }
  const { markdown } = await api(`/api/talks/${enc(current)}/digest`);
  // Image paths in digest.md are relative to the talk folder.
  const html = md(markdown).replace(/(<img[^>]+src=")(?!https?:|\/)([^"]+)"/g, (m, a, src) => `${a}/files/${enc(current)}/${src.split('/').map(enc).join('/')}"`);
  $('#digest').innerHTML = html;
  const imgs = [...$('#digest').querySelectorAll('img')];
  imgs.forEach((img, i) => {
    img.onclick = () => openLightbox(imgs.map((x, j) => ({ src: x.src, caption: `${j + 1} / ${imgs.length}　·　${x.alt}` })), i);
  });
}

async function renderPrep() {
  const p = state.prep;
  const st = $('#prep-status');
  $('#prep-btn').textContent = state.hasPrep ? t('prep.redo') : t('prep.start');
  $('#prep-btn').disabled = p?.status === 'running' || p?.status === 'queued';
  if (p?.status === 'queued') st.textContent = t('prep.queued');
  else if (p?.status === 'running') st.textContent = t('prep.running', { s: Math.round((Date.now() - p.startedAt) / 1000), n: (p.steps || []).length });
  else if (p?.status === 'error') { st.innerHTML = '<span class="error"></span>'; st.firstChild.textContent = t('app.failed', { msg: p.error }); }
  else st.textContent = state.hasPrep ? t('prep.doneHint') : '';
  $('#prep-empty').hidden = state.hasPrep || p?.status === 'running' || p?.status === 'queued';
  // What Grok searched / opened: open while it runs, folded afterwards.
  const steps = p?.steps || [];
  $('#prep-steps-box').hidden = !steps.length;
  $('#prep-steps-box').open = p?.status === 'running';
  $('#prep-steps-sum').textContent = p?.status === 'running' ? t('prep.now', { step: steps.at(-1) || '' }) : t('prep.steps', { n: steps.length });
  $('#prep-steps').innerHTML = '';
  for (const t of steps) $('#prep-steps').append(Object.assign(document.createElement('li'), { textContent: t, title: t }));
  $('#prep-steps').scrollTop = $('#prep-steps').scrollHeight;
  if (!state.hasPrep) { $('#prep').innerHTML = ''; return; }
  const { markdown } = await api(`/api/talks/${enc(current)}/prep`);
  // The prep answer uses single line breaks for its fixed GitHub / Slides / Speaker lines.
  $('#prep').innerHTML = window.marked ? window.marked.parse(markdown, { breaks: true }) : md(markdown);
  for (const a of $('#prep').querySelectorAll('a')) a.target = '_blank';
}

$('#prep-btn').onclick = async () => {
  await api(`/api/talks/${enc(current)}/prep`, { method: 'POST' });
  await refresh(true);
  renderPrep();
};

$('#digest-btn').onclick = async () => {
  await flushNotes();
  state.digestJob = await api(`/api/talks/${enc(current)}/digest`, { method: 'POST' });
  renderDigest();
};

// ---------- import ----------

async function importFiles(files) {
  const slug = current;
  // Audio last, so the slides are in place before transcription starts.
  const sorted = [...files].sort((a, b) => /^audio|^video/.test(a.type) - /^audio|^video/.test(b.type));
  let i = 0;
  for (const f of sorted) {
    showNotice(t('app.importing', { i: ++i, n: sorted.length, name: f.name }) + (/^audio|^video/.test(f.type) ? t('app.importingAudio') : ''));
    try {
      const res = await fetch(`/api/talks/${enc(slug)}/upload?name=${enc(f.name)}`, { method: 'PUT', body: f });
      if (!res.ok) throw new Error((await res.json()).error);
    } catch (e) {
      alert(`${f.name}：${e.message}`);
    }
  }
  showNotice(t('app.imported', { n: sorted.length }), 4000);
  if (slug === current) { await refresh(); renderTranscript(); restamp(); }
}

$('#import-btn').onclick = () => $('#import-input').click();
$('#import-input').onchange = (e) => { importFiles(e.target.files); e.target.value = ''; };
document.addEventListener('dragover', (e) => { if (current) { e.preventDefault(); document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', (e) => {
  document.body.classList.remove('dragging');
  if (!current || !e.dataTransfer.files.length) return;
  e.preventDefault();
  importFiles(e.dataTransfer.files);
});

// ---------- notes editor ----------
// Each line is a <div data-id data-t>. A line's time is when it first got text; editing keeps it.

const notesEl = $('#notes');
let lineSeq = 0;
const newId = () => `l${Date.now().toString(36)}${(lineSeq++).toString(36)}`;

function renderNotes(lines) {
  notesEl.innerHTML = '';
  for (const l of lines.length ? lines : [{ t: null, text: '' }]) {
    const d = document.createElement('div');
    d.dataset.id = newId();
    if (l.t) d.dataset.t = l.t;
    d.textContent = l.text;
    if (!l.text) d.append(document.createElement('br'));
    notesEl.append(d);
  }
  restamp();
}

function restamp() {
  for (const d of notesEl.children) d.dataset.c = stamp(Number(d.dataset.t));
}

const lineText = (d) => d.textContent.replace(/​/g, '');

function normalizeNotes() {
  // Browsers sometimes leave bare text nodes or <br>s at the top level; wrap them into line divs.
  for (const n of [...notesEl.childNodes]) {
    if (n.nodeType === 1 && n.tagName === 'DIV') continue;
    if (n.nodeType === 1 && n.tagName === 'BR') { n.remove(); continue; }
    const d = document.createElement('div');
    n.replaceWith(d);
    d.append(n);
  }
  // Splitting a line clones its attributes: within a group sharing an id, the first non-empty line keeps it.
  const groups = Map.groupBy([...notesEl.children], (d) => d.dataset.id || newId());
  const now = Date.now();
  for (const [, divs] of groups) {
    const keeper = divs.find((d) => lineText(d).trim()) || divs[0];
    for (const d of divs) {
      if (d === keeper && d.dataset.id) continue;
      d.dataset.id = newId();
      delete d.dataset.t;
    }
  }
  for (const d of notesEl.children) {
    const has = !!lineText(d).trim();
    if (has && !d.dataset.t) d.dataset.t = now;
    if (!has) delete d.dataset.t;
  }
  restamp();
}

let saveTimer = null;
notesEl.addEventListener('input', () => {
  normalizeNotes();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushNotes, 800);
});
notesEl.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
});
notesEl.addEventListener('paste', (e) => {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});

async function flushNotes() {
  clearTimeout(saveTimer);
  if (!current || $('#talk').hidden) return;
  const lines = [...notesEl.children].map((d) => ({ t: Number(d.dataset.t) || null, text: lineText(d) }));
  while (lines.length && !lines.at(-1).text.trim()) lines.pop();
  state.notes = lines;
  await api(`/api/talks/${enc(current)}/notes`, { method: 'PUT', body: JSON.stringify({ lines }) });
}
window.addEventListener('beforeunload', () => { flushNotes(); });

// ---------- chat ----------

const md = (text) => (window.marked ? window.marked.parse(text) : text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/\n/g, '<br>'));

function addMsg(role, text = '') {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = md(text);
  $('#chat-log').append(div);
  return div;
}

async function renderChatHistory() {
  $('#chat-log').innerHTML = '';
  for (const m of await api(`/api/talks/${enc(current)}/chat`)) addMsg(m.role, m.text);
  $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
}

function renderModes() {
  const box = $('#modes');
  box.innerHTML = '';
  for (const m of modes) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.onclick = () => sendChat(m.prompt, m.label);
    box.append(b);
  }
}

async function sendChat(message, shown = message) {
  if (chatBusy || !message.trim()) return;
  chatBusy = true;
  await flushNotes();
  const slug = current;
  addMsg('user', shown);
  const bubble = addMsg('assistant');
  const status = document.createElement('div');
  status.className = 'status';
  bubble.append(status);
  let text = '';
  try {
    const res = await fetch(`/api/talks/${enc(slug)}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (ev.type === 'status') status.textContent = ev.text;
        if (ev.type === 'error') status.textContent = t('app.error', { msg: ev.text });
        if (ev.type === 'text') {
          text += ev.text;
          bubble.innerHTML = md(text);
          bubble.append(status);
          status.textContent = '';
        }
        $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
      }
    }
    if (text) status.remove();
  } catch (e) {
    status.textContent = t('app.error', { msg: e.message });
  } finally {
    chatBusy = false;
    if (slug === current) refresh();
  }
}

$('#chat-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $('#chat-input').value;
  $('#chat-input').value = '';
  sendChat(v);
};
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.metaKey) { e.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#chat-reset').onclick = async () => {
  if (!confirm(t('chat.confirmNew'))) return;
  await api(`/api/talks/${enc(current)}/chat/reset`, { method: 'POST' });
  const d = addMsg('divider');
  d.textContent = t('chat.divider');
};

// ---------- new talk dialog: one link, many links, or pick from the day's schedule ----------

const dialog = $('#new-dialog');
let nfMode = 'links';
const linksIn = () => $('#nf-link').value.split(/\s+/).filter((l) => /session=|^[0-9a-f-]{36}$/i.test(l));
const picked = () => [...$('#nf-list').querySelectorAll('input:checked')].map((x) => x.value);

function updateCreateLabel() {
  const n = nfMode === 'pick' ? picked().length : linksIn().length;
  $('#nf-create').textContent = n > 1 ? t('nf.createMany', { n }) : t('nf.create');
}

function setNfMode(m) {
  nfMode = m;
  for (const b of document.querySelectorAll('[data-nf]')) b.classList.toggle('active', b.dataset.nf === m);
  $('#nf-links').hidden = m !== 'links';
  $('#nf-pick').hidden = m !== 'pick';
  if (m === 'pick') loadPickList();
  updateCreateLabel();
}
for (const b of document.querySelectorAll('[data-nf]')) b.onclick = () => setNfMode(b.dataset.nf);

async function loadPickList() {
  const list = $('#nf-list');
  list.innerHTML = `<p class="muted small" style="padding:10px">${t('nf.loading')}</p>`;
  try {
    const sessions = (await api(`/api/schedule?date=${$('#nf-date').value}`)).filter((s) => $('#nf-all').checked || s.speakers.length);
    list.innerHTML = sessions.length ? '' : `<p class="muted small" style="padding:10px">${t('nf.noSessions')}</p>`;
    let slot = null;
    for (const s of sessions) {
      if (s.time !== slot) {
        slot = s.time;
        list.append(Object.assign(document.createElement('div'), { className: 'pick-slot', textContent: s.time }));
      }
      const row = document.createElement('label');
      row.className = `pick-row${s.exists ? ' exists' : ''}`;
      row.innerHTML = '<input type="checkbox"><span><span class="t"></span><span class="who"></span></span>';
      row.querySelector('input').value = s.scheduleId;
      row.querySelector('input').disabled = s.exists;
      row.querySelector('.t').textContent = s.title;
      row.querySelector('.who').textContent = [s.speakers.map((p) => p.company ? `${p.name} (${p.company})` : p.name).join(', '), s.room, s.exists && t('nf.exists')].filter(Boolean).join(' · ');
      list.append(row);
    }
  } catch (e) {
    list.innerHTML = '';
    list.append(Object.assign(document.createElement('p'), { className: 'error small', textContent: e.message }));
  }
  updateCreateLabel();
}
$('#nf-date').onchange = loadPickList;
$('#nf-all').onchange = loadPickList;
$('#nf-list').addEventListener('change', updateCreateLabel);

$('#new-talk').onclick = () => {
  $('#new-form').reset();
  $('#nf-preview').textContent = '';
  $('#nf-error').textContent = '';
  // Default to tomorrow (conference time zone is close enough to local for picking a day).
  const tm = new Date(Date.now() + 86400000);
  $('#nf-date').value = `${tm.getFullYear()}-${String(tm.getMonth() + 1).padStart(2, '0')}-${String(tm.getDate()).padStart(2, '0')}`;
  setNfMode('links');
  dialog.showModal();
  $('#nf-link').focus();
};

let resolveTimer = null;
$('#nf-link').addEventListener('input', () => {
  clearTimeout(resolveTimer);
  $('#nf-error').textContent = '';
  updateCreateLabel();
  const links = linksIn();
  if (!links.length) { $('#nf-preview').textContent = ''; return; }
  if (links.length > 1) { $('#nf-preview').textContent = t('nf.manyLinks', { n: links.length }); return; }
  $('#nf-preview').textContent = t('nf.lookingUp');
  resolveTimer = setTimeout(async () => {
    try {
      const s = await api(`/api/resolve?link=${enc(links[0])}`);
      $('#nf-preview').textContent = `${s.date} ${s.time} · ${s.title} — ${s.speakers.map((p) => `${p.name} (${p.company})`).join(', ')} · ${s.room}`;
    } catch (e) {
      $('#nf-preview').textContent = '';
      $('#nf-error').textContent = e.message;
    }
  }, 300);
});

$('#nf-create').onclick = async (e) => {
  e.preventDefault();
  const links = linksIn();
  const ids = nfMode === 'pick' ? picked() : [];
  const title = $('#nf-title').value.trim();
  try {
    if (ids.length > 1 || links.length > 1 || (nfMode === 'pick' && ids.length)) {
      const { created, skipped } = await api('/api/talks/batch', { method: 'POST', body: JSON.stringify(nfMode === 'pick' ? { ids } : { links }) });
      dialog.close();
      await loadSidebar();
      showNotice(t('nf.created', { n: created.length }) + (skipped.length ? t('nf.skipped', { n: skipped.length }) : ''), 6000);
      if (created.length === 1) { openOnView = 'prep'; location.hash = enc(created[0]); }
      return;
    }
    if (!links.length && !title) { $('#nf-error').textContent = nfMode === 'pick' ? t('nf.pickOne') : t('nf.needLink'); return; }
    const { slug } = await api('/api/talks', { method: 'POST', body: JSON.stringify(links.length ? { link: links[0] } : { title, speakers: $('#nf-speakers').value }) });
    dialog.close();
    openOnView = links.length ? 'prep' : 'live';
    location.hash = enc(slug);
  } catch (err) {
    $('#nf-error').textContent = err.message;
  }
};

// ---------- routing ----------

window.addEventListener('hashchange', () => openTalk(decodeURIComponent(location.hash.slice(1))));
await loadSidebar();
openTalk(decodeURIComponent(location.hash.slice(1)) || null);
