'use strict';
/* The reading screen: pages, place, and everything done while reading. */

const root = document.documentElement;
const page = $('page'), flow = $('flow');
const R = {
  book: null, meta: null, id: null, ch: 0, pg: 0, pages: 1, step: 1, gap: 0, w: 0, h: 0, cols: 1,
  off: 0, anchor: -1, nodes: [], chLen: 0, fixed: null, loading: false, urls: [], turnT: 0, history: [],
  texts: [], lens: null, learn: null, token: 0
};

/* ---------- looks ---------- */
const FONTS = {
  system: { label: 'System', css: '-apple-system,system-ui,"Segoe UI",Roboto,sans-serif' },
  atkinson: { label: 'Atkinson Hyperlegible', css: '"Atkinson Hyperlegible",-apple-system,sans-serif', g: 'Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400;1,700' },
  lexend: { label: 'Lexend', css: 'Lexend,-apple-system,sans-serif', g: 'Lexend:wght@300..700' },
  georgia: { label: 'Georgia', css: 'Georgia,"Times New Roman",serif' },
  literata: { label: 'Literata', css: 'Literata,Georgia,serif', g: 'Literata:ital,opsz,wght@0,7..72,400..700;1,7..72,400..700' }
};
function loadFont(key) {
  const f = FONTS[key];
  if (!f || !f.g || document.getElementById('gf-' + key)) return;
  document.head.append(h('link', { id: 'gf-' + key, rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=' + f.g + '&display=swap' }));
}
if (document.fonts) document.fonts.addEventListener('loadingdone', () => { if (R.book) layout(); });

function applySet() {
  document.body.dataset.theme = S.theme;
  loadFont(S.font);
  root.style.setProperty('--fs', S.fs + 'px');
  root.style.setProperty('--fw', S.bold ? 600 : 400);
  root.style.setProperty('--lh', S.lh);
  root.style.setProperty('--mx', S.margin + 'px');
  root.style.setProperty('--ff', (FONTS[S.font] || FONTS.system).css);
  document.body.classList.toggle('justify', !!S.justify);
  document.body.classList.toggle('selectable', !!S.select && !S.lock);
  document.body.classList.toggle('locked', !!S.lock);
  $('clock').hidden = !S.clock;
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#111';
}

/* ---------- a chapter onto the screen ---------- */
async function loadChapter(i, target = {}) {
  if (R.loading || !R.book) return false;
  R.loading = true;
  stopAuto();
  const token = R.token;
  try {
    const old = R.urls;
    R.urls = [];
    let res;
    try { res = await R.book.chapter(i, { urls: R.urls }); }
    catch (e) { console.error(e); res = { div: h('div', {}, h('p', { text: 'This part of the book could not be shown. ' + (e.message || '') })), css: '' }; }
    if (token !== R.token) { R.urls.forEach(u => URL.revokeObjectURL(u)); return false; }
    R.ch = i;
    flow.innerHTML = '';
    $('bookcss').textContent = res.css || '';
    if (res.fixedPage) {
      R.fixed = res.fixedPage;
      flow.classList.add('fixed');
      const box = h('div', { class: 'fx' });
      if (res.fixedPage.img) box.append(h('img', { src: res.fixedPage.img, alt: '' }));
      else box.append(h('iframe', { src: res.fixedPage.src, tabindex: '-1', sandbox: 'allow-same-origin', title: 'page' }));
      flow.append(box);
    } else {
      R.fixed = null;
      flow.classList.remove('fixed');
      flow.append(...res.div.childNodes);
      if (!flow.textContent.trim() && !flow.querySelector('img')) flow.innerHTML = '<p>&nbsp;</p>';
    }
    old.forEach(u => URL.revokeObjectURL(u));
    const imgs = [...flow.querySelectorAll('img')];
    await Promise.race([Promise.all(imgs.map(im => im.decode().catch(() => {}))), wait(1500)]);
    buildNodes();
    paintMarks();
    layout(target);
    imgs.forEach(im => { if (!im.complete) im.addEventListener('load', () => layout(), { once: true }); });
    return true;
  } finally { R.loading = false; }
}

/* every piece of text in the chapter, with where it starts, so a place is a character count */
function buildNodes() {
  const w = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
  const arr = [];
  let s = 0, n;
  while ((n = w.nextNode())) { arr.push({ n, s }); s += n.data.length; }
  R.nodes = arr; R.chLen = s;
}
function nodeAt(off) {
  const N = R.nodes;
  let lo = 0, hi = N.length - 1, k = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (N[m].s <= off) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}
function rangeFor(s, e) {
  const N = R.nodes;
  if (!N.length) return null;
  const a = nodeAt(s), b = nodeAt(Math.max(s, e - 1));
  const r = document.createRange();
  r.setStart(N[a].n, Math.min(N[a].n.data.length, s - N[a].s));
  r.setEnd(N[b].n, Math.min(N[b].n.data.length, e - N[b].s));
  return r;
}
function offsetOf(node, off) {
  const r = document.createRange();
  r.setStart(flow, 0);
  try { r.setEnd(node, off); } catch (e) { return 0; }
  return r.toString().length;
}
/* the left edge of the first visible letter at or after i (dir 1), or at or before it (dir -1) */
function xAt(n, i, dir) {
  const t = n.data;
  while (i >= 0 && i < t.length && /\s/.test(t[i])) i += dir;
  if (i < 0 || i >= t.length) return null;
  const r = document.createRange();
  r.setStart(n, i); r.setEnd(n, i + 1);
  const rc = r.getClientRects();
  return rc.length ? rc[0].left : null;
}
const flowLeft = () => flow.getBoundingClientRect().left;
function pageOfX(x) { return Math.max(0, Math.min(R.pages - 1, Math.floor((x + 2) / R.step))); }
function pageOfOffset(off) {
  const N = R.nodes;
  if (!N.length || R.fixed) return 0;
  const fl = flowLeft();
  for (let k = nodeAt(off); k < N.length; k++) {
    const x = xAt(N[k].n, k === nodeAt(off) ? Math.max(0, off - N[k].s) : 0, 1);
    if (x != null) return pageOfX(x - fl);
  }
  return R.pages - 1;
}
function offsetAtPage(pg) {
  const N = R.nodes;
  if (!N.length || R.fixed) return -1;
  const fl = flowLeft(), lim = pg * R.step - 2;
  const lastX = k => { const n = N[k].n, x = xAt(n, n.data.length - 1, -1); return x == null ? null : x - fl; };
  let lo = 0, hi = N.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let k = mid, x = lastX(k);
    while (x == null && k < hi) { k++; x = lastX(k); }
    if (x == null) { hi = mid - 1; continue; }
    if (x >= lim) { ans = k; hi = mid - 1; } else lo = k + 1;
  }
  if (ans < 0) return -1;
  const n = N[ans].n;
  let a = 0, b = n.data.length - 1, best = b;
  while (a <= b) {
    const m = (a + b) >> 1, x = xAt(n, m, 1);
    if (x == null) { b = m - 1; continue; }
    if (x - fl >= lim) { best = m; b = m - 1; } else a = m + 1;
  }
  while (best < n.data.length - 1 && /\s/.test(n.data[best])) best++;
  return N[ans].s + best;
}
function pageOfEl(el) {
  const fl = flowLeft();
  const rc = [...el.getClientRects()].find(r => r.width || r.height) || el.getBoundingClientRect();
  if (rc && (rc.width || rc.height || rc.left)) return pageOfX(rc.left - fl);
  // an empty marker: use the text right after it
  const k = R.nodes.findIndex(x => el.compareDocumentPosition(x.n) & (Node.DOCUMENT_POSITION_FOLLOWING | Node.DOCUMENT_POSITION_CONTAINED_BY));
  return k < 0 ? 0 : pageOfOffset(R.nodes[k].s);
}
function findId(id) { try { return flow.querySelector('#' + CSS.escape(id)) || flow.querySelector('[name="' + CSS.escape(id) + '"]'); } catch (e) { return null; } }

/* ---------- cutting the chapter into pages ---------- */
function layout(target) {
  if (!R.book) return;
  // a relayout (text size, turning the iPad) keeps the exact letter he was at, not the top of the page it lands on
  if (target == null) target = { off: R.anchor >= 0 && !R.fixed ? R.anchor : null, frac: R.anchor < 0 && R.pages > 1 ? R.pg / R.pages : null, keepAnchor: true };
  const cs = getComputedStyle(page);
  const pl = parseFloat(cs.paddingLeft), pr = parseFloat(cs.paddingRight), pt = parseFloat(cs.paddingTop), pb = parseFloat(cs.paddingBottom);
  const w = page.clientWidth - pl - pr, hh = page.clientHeight - pt - pb;
  R.w = w; R.h = hh; R.gap = pl + pr; R.step = w + R.gap;
  root.style.setProperty('--ph', hh + 'px');
  flow.style.transition = 'none';
  flow.style.transform = 'none';
  flow.style.width = w + 'px';
  flow.style.height = hh + 'px';
  if (R.fixed) {
    flow.style.columnWidth = 'auto';
    const box = flow.querySelector('.fx');
    const f = box && box.querySelector('iframe');
    if (f) {
      const sc = Math.min(w / R.fixed.vw, hh / R.fixed.vh);
      f.style.width = R.fixed.vw + 'px'; f.style.height = R.fixed.vh + 'px';
      f.style.transform = 'scale(' + sc + ')';
      f.style.left = (w - R.fixed.vw * sc) / 2 + "px"; f.style.top = (hh - R.fixed.vh * sc) / 2 + "px";
    }
    R.pages = 1; R.pg = 0; R.cols = 1;
    show(target);
    return;
  }
  R.cols = S.twoPage && innerWidth > innerHeight && innerWidth >= 900 ? 2 : 1;
  const colW = (R.cols === 2 ? (w - R.gap) / 2 : w) - 0.5;
  flow.style.columnWidth = colW + 'px';
  flow.style.columnGap = R.gap + 'px';
  const fr = flow.getBoundingClientRect();
  let right = flow.scrollWidth;
  const kids = [...flow.childNodes].slice(-4);
  if (kids.length) {
    const rg = document.createRange();
    rg.setStartBefore(kids[0]); rg.setEndAfter(kids[kids.length - 1]);
    for (const rc of rg.getClientRects()) right = Math.max(right, rc.right - fr.left);
  }
  R.pages = Math.max(1, Math.ceil((right + R.gap - 2) / R.step));
  let pg = 0;
  if (target.end) pg = R.pages - 1;
  else if (target.el) pg = pageOfEl(target.el);
  else if (target.frag) { const el = findId(target.frag); pg = el ? pageOfEl(el) : 0; }
  else if (target.anchor) {
    let el = null;
    try { el = target.anchor({ getElementById: id => findId(id), querySelector: s => flow.querySelector(s) }); } catch (e) {}
    pg = el ? pageOfEl(el) : 0;
  }
  else if (target.off != null && target.off >= 0) pg = pageOfOffset(target.off);
  else if (target.frac != null) pg = target.frac >= 1 ? R.pages - 1 : Math.floor(target.frac * R.pages + 1e-6);
  else if (target.page != null) pg = target.page;
  R.pg = Math.max(0, Math.min(R.pages - 1, pg));
  if (target.off != null && target.off >= 0 && pageOfOffset(target.off) === R.pg) { R.anchor = target.off; target.keepAnchor = true; }
  show(target);
}

function show(opts = {}) {
  flow.style.transition = S.anim && opts.animate ? 'transform .22s ease-out' : 'none';
  flow.style.transform = 'translateX(' + (-R.pg * R.step) + 'px)';
  R.off = R.fixed ? -1 : offsetAtPage(R.pg);
  if (!opts.keepAnchor || R.anchor == null || R.anchor < 0) R.anchor = R.off;
  drawStatus();
  save();
  if (!opts.fromTTS) scheduleAuto();
}

function weights() { return R.lens && !R.book.fixedAll ? R.lens : R.book.sizes; }
function progress() {
  if (!R.book) return 0;
  const w = weights();
  let before = 0, tot = 0;
  for (let i = 0; i < w.length; i++) { tot += w[i]; if (i < R.ch) before += w[i]; }
  return Math.min(1, (before + w[R.ch] * (R.pg + 1) / R.pages) / (tot || 1));
}
function pageChars() {
  if (R.fixed || !R.nodes.length) return 0;
  const a = Math.max(0, R.off), b = R.pg < R.pages - 1 ? offsetAtPage(R.pg + 1) : R.chLen;
  return Math.max(0, (b < 0 ? R.chLen : b) - a);
}
function tocLabel(ch) {
  let best = null;
  for (const t of R.book.toc) if (t.i >= 0 && t.i <= ch && (!best || t.i >= best.i)) best = t;
  return best ? best.label : '';
}
function timeLeft() {
  if (R.book.fixedAll) {
    const left = R.book.count - R.ch - 1;
    return left + ' page' + (left === 1 ? '' : 's') + ' left';
  }
  const inCh = R.chLen * (1 - (R.pg + 1) / R.pages);
  let txt = fmtMin(inCh / S.rate) + ' left in ' + (R.book.unit === 'page' ? 'this page' : 'chapter');
  if (R.lens) {
    let rest = inCh;
    for (let i = R.ch + 1; i < R.lens.length; i++) rest += R.lens[i];
    txt += ' · ' + fmtMin(rest / S.rate) + ' in book';
  }
  return txt;
}
function drawStatus() {
  const p = progress();
  $('fill').style.width = (p * 100).toFixed(2) + '%';
  $('pct').textContent = Math.floor(p * 100) + '%';
  $('left').textContent = S.timeLeft ? timeLeft() : '';
  const unit = R.book.unit === 'page' ? 'Page' : 'Chapter';
  const lab = tocLabel(R.ch);
  $('where').textContent = unit + ' ' + (R.ch + 1) + ' of ' + R.book.count + (lab ? ': ' + lab : '') + (R.pages > 1 ? ' · screen ' + (R.pg + 1) + ' of ' + R.pages : '');
  $('slider').value = Math.round(p * 1000);
  $('sliderlab').textContent = Math.floor(p * 100) + '%';
  $('ribbon').hidden = !bookmarkHere();
  $('backbtn').hidden = !R.history.length;
}

function save() {
  if (!R.id || !R.book) return;
  const at = R.anchor >= 0 ? R.anchor : R.off;
  const valid = !R.fixed && at >= 0 && pageOfOffset(at) === R.pg;
  const row = { ch: R.ch, off: valid ? at : -1, f: R.pages > 1 ? R.pg / R.pages : 0, p: progress() };
  // Opened at a place the X4 sent: say nothing back until a page is turned, or the
  // iPad's rounding of that place would go to the X4 as if it were new reading.
  if (R.quietUntilTurn) return;
  // The same place saved again is not news. A fresh time on it would beat a newer
  // place from the other device.
  const old = Rows.pos(R.id);
  if (old && old.ch === row.ch && old.off === row.off && (row.off >= 0 || Math.abs((old.f || 0) - row.f) < 1e-9)) return;
  row.t = now();
  Rows.setPos(R.id, row);
}

/* ---------- turning ---------- */
async function next(opts = {}) {
  if (!R.book || R.loading) return;
  toggleTools(false);
  const t = now(), read = pageChars();
  if (R.pg < R.pages - 1) { R.pg++; show({ animate: true }); }
  else if (R.ch < R.book.count - 1) { if (!await loadChapter(R.ch + 1, { page: 0 })) return; }
  else { finished(); return; }
  afterTurn(t, read, opts);
}
async function prev(opts = {}) {
  if (!R.book || R.loading) return;
  toggleTools(false);
  if (R.pg > 0) { R.pg--; show({ animate: true }); }
  else if (R.ch > 0) { if (!await loadChapter(R.ch - 1, { end: true })) return; }
  else { toast('Start of the book'); return; }
  afterTurn(now(), 0, opts);
}
function afterTurn(t, read, opts) {
  if (R.quietUntilTurn) { R.quietUntilTurn = false; save(); }
  Log.tick(read, 1);
  const dt = t - R.turnT;
  // learn how fast he reads, from turns he made himself
  if (read > 30 && !opts.auto && !TTS.on && dt > 2500 && dt < 240000) {
    const cpm = read / dt * 60000;
    S.rate = Math.max(150, Math.min(4000, S.rate * 0.8 + cpm * 0.2));
    saveS();
  }
  R.turnT = t;
  if (TTS.on && !opts.fromTTS) ttsFrom(Math.max(0, R.off));
}
function jumpChapter(d) {
  const t = R.ch + d;
  if (!R.book || t < 0 || t >= R.book.count) return;
  loadChapter(t, { page: 0 }).then(() => { if (TTS.on) ttsFrom(0); });
}
async function finished() {
  toast('The end. Marked as finished.');
  if (R.meta && !R.meta.finished) {
    R.meta.finished = true; R.meta.t = now();
    await DB.putBook(R.meta);
    Sync.mark('meta', R.id);
  }
}
function remember() {
  R.history.push({ ch: R.ch, off: R.off, f: R.pages > 1 ? R.pg / R.pages : 0 });
  if (R.history.length > 30) R.history.shift();
}
async function goBack() {
  const h0 = R.history.pop();
  if (!h0) return;
  await loadChapter(h0.ch, h0.off >= 0 ? { off: h0.off } : { frac: h0.f });
}
async function goToc(t) {
  remember();
  if (t.href && R.book.link) {
    const l = R.book.link(R.ch, t.href);
    if (l && l.resolve) { const r = await l.resolve(); if (r && r.i >= 0) return loadChapter(r.i, { anchor: r.anchor }); }
  }
  if (t.i >= 0) return loadChapter(t.i, t.frag ? { frag: t.frag } : { page: 0 });
}
function percentTarget(p) {
  const w = weights();
  const tot = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < w.length; i++) {
    if (acc + w[i] >= p * tot || i === w.length - 1) return { i, f: Math.max(0, Math.min(0.999, (p * tot - acc) / w[i])) };
    acc += w[i];
  }
  return { i: 0, f: 0 };
}
function goPercent(p) {
  const at = percentTarget(p);
  remember();
  return loadChapter(at.i, { frac: at.f });
}

/* ---------- links and footnotes ---------- */
async function followLink(a) {
  const href = a.getAttribute('href') || '';
  const l = R.book.link(R.ch, href);
  if (!l) return;
  if (l.external) {
    if (confirm('Open this link in Safari?\n' + l.external)) window.open(l.external, '_blank', 'noopener');
    return;
  }
  if (l.i === -1 && l.path) {
    const text = R.book.noteAt ? await R.book.noteAt(l.path, l.frag) : '';
    if (text) showNote(text);
    return;
  }
  let target = null, i = R.ch;
  if (l.resolve) { const r = await l.resolve(); if (!r || r.i < 0) return; i = r.i; target = { anchor: r.anchor }; }
  else { i = l.i; target = l.frag ? { frag: l.frag } : { page: 0 }; }
  // a footnote opens over the page instead of sending you away from it
  const noteType = /noteref/.test((a.getAttribute('epub:type') || '') + ' ' + (a.getAttribute('role') || ''));
  const shortLabel = /^[\[(]?[\d*†‡§a-z]{1,4}[\])]?$/i.test(a.textContent.trim());
  if ((noteType || shortLabel) && (target.frag || target.anchor)) {
    const text = await noteText(i, target);
    if (text) return showNote(text, i, target);
  }
  remember();
  loadChapter(i, target);
}
async function noteText(i, target) {
  let scope = flow;
  if (i !== R.ch) { try { scope = (await R.book.chapter(i, { images: false })).div; } catch (e) { return ''; } }
  let el = null;
  try {
    if (target.frag) el = scope.querySelector('#' + CSS.escape(target.frag)) || scope.querySelector('[name="' + CSS.escape(target.frag) + '"]');
    else if (target.anchor) el = target.anchor({ getElementById: id => scope.querySelector('#' + CSS.escape(id)), querySelector: s => scope.querySelector(s) });
  } catch (e) {}
  if (!el) return '';
  const block = el.closest('aside,li,p,dd,div,section') || el;
  let t = (block === scope ? el : block).textContent.replace(/\s+/g, ' ').trim();
  if (t.length < 3) { const nx = block.nextElementSibling; if (nx) t += ' ' + nx.textContent.replace(/\s+/g, ' ').trim(); }
  return t.slice(0, 1500);
}
function showNote(text, i, target) {
  openSheet('Note', body => {
    body.append(h('p', { class: 'note-text', text }));
    if (target) body.append(h('div', { class: 'row' }, h('button', { text: 'Go to the note', onclick: () => { closeSheet(); remember(); loadChapter(i, target); } })));
  });
}

/* ---------- bookmarks and highlights ---------- */
function bookmarkHere() {
  if (!R.id || !R.book) return null;
  return Rows.liveMarks(R.id).find(m => m.kind === 'bm' && m.ch === R.ch && (m.off >= 0 ? pageOfOffset(m.off) === R.pg : Math.round((m.f || 0) * R.pages) === R.pg)) || null;
}
function toggleBookmark() {
  const b = bookmarkHere();
  if (b) { Rows.delMark(R.id, b.id); toast('Bookmark removed'); }
  else {
    const text = R.off >= 0 ? R.nodes.map(x => x.n.data).join('').slice(R.off, R.off + 120).replace(/\s+/g, ' ').trim() : '';
    Rows.putMark(R.id, { id: uid(), kind: 'bm', ch: R.ch, off: R.off, f: R.pages > 1 ? R.pg / R.pages : 0, p: progress(), text });
    toast('Bookmarked');
  }
  drawStatus();
}
function paintMarks() {
  if (!R.id || R.fixed) return;
  const ms = Rows.liveMarks(R.id).filter(m => m.kind === 'hl' && m.ch === R.ch).sort((a, b) => b.s - a.s);
  if (!ms.length) return;
  for (const m of ms) wrapRange(m.s, m.e, el => { el.className = 'hl' + (m.note ? ' has-note' : ''); el.dataset.id = m.id; });
  buildNodes();
}
function wrapRange(s, e, deco) {
  for (let k = R.nodes.length - 1; k >= 0; k--) {
    const { n, s: ns } = R.nodes[k];
    const len = n.data.length;
    if (ns >= e || ns + len <= s) continue;
    const a = Math.max(0, s - ns), b = Math.min(len, e - ns);
    if (b <= a || !n.data.slice(a, b).trim()) continue;
    if (b < len) n.splitText(b);
    const seg = a > 0 ? n.splitText(a) : n;
    const mk = document.createElement('mark');
    deco(mk);
    seg.parentNode.insertBefore(mk, seg);
    mk.append(seg);
  }
}
function addHighlight(note) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  if (!flow.contains(r.commonAncestorContainer)) return;
  const s = offsetOf(r.startContainer, r.startOffset), e = offsetOf(r.endContainer, r.endOffset);
  if (e <= s) return;
  const m = { id: uid(), kind: 'hl', ch: R.ch, s, e, text: r.toString().replace(/\s+/g, ' ').trim().slice(0, 2000), note: note || '', p: progress() };
  Rows.putMark(R.id, m);
  sel.removeAllRanges();
  hideSelBar();
  wrapRange(s, e, el => { el.className = 'hl' + (m.note ? ' has-note' : ''); el.dataset.id = m.id; });
  buildNodes();
  return m;
}
function openHighlight(id) {
  const m = Rows.marks(R.id)[id];
  if (!m || m.del) return;
  openSheet('Highlight', body => {
    const ta = h('textarea', { rows: 4, placeholder: 'Add a note' });
    ta.value = m.note || '';
    body.append(h('blockquote', { text: m.text }), ta,
      h('div', { class: 'row' },
        h('button', { class: 'pri', text: 'Save note', onclick: () => { m.note = ta.value.trim(); Rows.putMark(R.id, m); closeSheet(); reloadHere(); } }),
        h('button', { text: 'Copy', onclick: () => copyText(m.text) }),
        h('button', { text: 'Delete highlight', onclick: () => { Rows.delMark(R.id, id); closeSheet(); reloadHere(); } })));
  });
}
function reloadHere() { if (R.book) loadChapter(R.ch, R.off >= 0 ? { off: R.off } : { frac: R.pages > 1 ? R.pg / R.pages : 0 }); }
function copyText(t) {
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Copied'), () => toast('Copy was refused'));
}

/* the bar that appears over selected text */
function hasSelection() { const s = getSelection(); return s && !s.isCollapsed && s.rangeCount && flow.contains(s.getRangeAt(0).commonAncestorContainer); }
let selT;
document.addEventListener('selectionchange', () => {
  clearTimeout(selT);
  selT = setTimeout(() => { if (hasSelection() && !S.lock) $('selbar').hidden = false; else hideSelBar(); }, 250);
});
function hideSelBar() { $('selbar').hidden = true; }
$('sel-hl').onclick = () => addHighlight('');
$('sel-note').onclick = () => { const m = addHighlight(''); if (m) openHighlight(m.id); };
$('sel-copy').onclick = () => { const t = getSelection().toString(); copyText(t); };
$('sel-def').onclick = () => { const t = getSelection().toString().trim(); define(t); };
$('sel-x').onclick = () => { getSelection().removeAllRanges(); hideSelBar(); };

async function define(word) {
  word = word.replace(/[^\p{L}\p{N}' -]/gu, '').trim().split(/\s+/).slice(0, 3).join(' ');
  if (!word) return;
  openSheet('Define: ' + word, async body => {
    body.append(h('p', { class: 'mut', text: 'Looking it up…' }));
    try {
      const r = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word.toLowerCase()));
      body.innerHTML = '';
      if (!r.ok) { body.append(h('p', { text: 'No definition found for "' + word + '".' })); return; }
      const data = await r.json();
      for (const entry of data.slice(0, 2)) {
        body.append(h('h3', { text: entry.word + (entry.phonetic ? '  ' + entry.phonetic : '') }));
        for (const mn of entry.meanings.slice(0, 3)) {
          body.append(h('p', { class: 'mut', text: mn.partOfSpeech }));
          const ol = h('ol');
          for (const d of mn.definitions.slice(0, 3)) ol.append(h('li', { text: d.definition }));
          body.append(ol);
        }
      }
    } catch (e) {
      body.innerHTML = '';
      body.append(h('p', { text: 'The dictionary needs a signal. With no signal, use Look Up in the iPad\'s own menu above the selected word.' }));
    }
  });
}

/* ---------- read aloud ---------- */
const TTS = { on: false, list: [], k: 0, token: 0 };
function voices() { return 'speechSynthesis' in window ? speechSynthesis.getVoices() : []; }
function ttsToggle() { TTS.on ? ttsStop() : ttsStart(); }
function ttsStart() {
  if (!('speechSynthesis' in window)) return toast('This browser cannot read aloud');
  if (R.fixed) return toast('There is no text on this page to read');
  TTS.on = true;
  stopAuto();
  ttsFrom(Math.max(0, R.off));
  toast('Reading aloud');
  drawTools();
}
function ttsStop() {
  TTS.on = false; TTS.token++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  clearHL('tts');
  drawTools();
  scheduleAuto();
}
function ttsFrom(off) {
  const token = ++TTS.token;
  speechSynthesis.cancel();
  const text = R.nodes.map(x => x.n.data).join('');
  const list = [], re = /[^.!?…\n]+(?:[.!?…]+["'”’)\]]*|\n|$)/g;
  re.lastIndex = off;
  let m;
  while ((m = re.exec(text))) {
    if (!m[0]) { re.lastIndex++; if (re.lastIndex >= text.length) break; continue; }
    const t = m[0].trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) {
      const s = m.index + m[0].indexOf(t[0]);
      list.push({ s, e: s + t.length, t });
    }
    if (re.lastIndex >= text.length) break;
  }
  TTS.list = list; TTS.k = 0;
  setTimeout(() => speakNext(token), 60);
}
function speakNext(token) {
  if (token !== TTS.token || !TTS.on) return;
  if (TTS.k >= TTS.list.length) {
    if (R.ch < R.book.count - 1) loadChapter(R.ch + 1, { page: 0 }).then(() => { if (token === TTS.token && TTS.on) ttsFrom(0); });
    else { ttsStop(); finished(); }
    return;
  }
  const it = TTS.list[TTS.k];
  const u = new SpeechSynthesisUtterance(it.t);
  const v = voices().find(x => x.voiceURI === S.ttsVoice);
  if (v) u.voice = v; else u.lang = R.book.lang || 'en';
  u.rate = S.ttsRate;
  u.onstart = () => {
    if (token !== TTS.token) return;
    setHL('tts', it.s, it.e);
    const p = pageOfOffset(it.s);
    if (p !== R.pg) { const read = pageChars(); R.pg = p; show({ fromTTS: true }); Log.tick(read, 1); }
    else Log.tick(0, 0);
  };
  u.onend = () => { if (token !== TTS.token) return; TTS.k++; speakNext(token); };
  u.onerror = e => { if (token !== TTS.token || e.error === 'interrupted' || e.error === 'canceled') return; TTS.k++; speakNext(token); };
  speechSynthesis.speak(u);
}
function setHL(name, s, e) {
  if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
  const r = rangeFor(s, e);
  if (r) CSS.highlights.set(name, new Highlight(r));
}
function clearHL(name) { if (window.CSS && CSS.highlights) CSS.highlights.delete(name); }
function flash(s, e) {
  if (window.CSS && CSS.highlights && typeof Highlight !== 'undefined') { setHL('found', s, e); setTimeout(() => clearHL('found'), 4000); return; }
  wrapRange(s, e, el => { el.className = 'found'; });
  buildNodes();
  setTimeout(() => { flow.querySelectorAll('mark.found').forEach(m => m.replaceWith(...m.childNodes)); buildNodes(); }, 4000);
}

/* ---------- auto turn ---------- */
let autoT = null;
function scheduleAuto() {
  stopAuto();
  if (!S.autoOn || !R.book || sheetOpen() || !$('tools').hidden || TTS.on || document.hidden) return;
  let ms = S.autoSec * 1000;
  if (S.autoMode === 'pace') ms = R.fixed ? 20000 : Math.max(3000, pageChars() / S.rate * 60000);
  const bar = $('autobar');
  bar.hidden = false;
  void bar.offsetWidth;
  bar.style.transition = 'width ' + ms + 'ms linear';
  bar.style.width = '100%';
  autoT = setTimeout(() => next({ auto: true }), ms);
}
function stopAuto() {
  clearTimeout(autoT);
  const bar = $('autobar');
  bar.style.transition = 'none'; bar.style.width = '0';
  bar.hidden = !S.autoOn;
}
function autoToggle() { S.autoOn = !S.autoOn; saveS(); toast(S.autoOn ? 'Auto turn on' : 'Auto turn off'); scheduleAuto(); drawTools(); }

/* ---------- touch lock ---------- */
function lockToggle() {
  S.lock = !S.lock; applySet();
  toast(S.lock ? 'Screen locked. Hold it for 2 seconds to unlock.' : 'Unlocked');
  if (S.lock) { getSelection().removeAllRanges(); hideSelBar(); toggleTools(false); }
}

/* ---------- the remote: to the iPad it is a keyboard ---------- */
const ACTIONS = [
  ['next', 'Next page'], ['prev', 'Previous page'], ['nextCh', 'Next chapter'], ['prevCh', 'Previous chapter'],
  ['fontUp', 'Bigger text'], ['fontDown', 'Smaller text'], ['menu', 'Menu open or closed'], ['read', 'Read aloud on or off'],
  ['auto', 'Auto turn on or off'], ['bookmark', 'Bookmark this page'], ['lock', 'Touch lock on or off'], ['back', 'Back after a jump']
];
const DEFAULT_KEYS = {
  next: ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N', 'j', 'MediaTrackNext', 'MediaFastForward', 'AudioVolumeUp'],
  prev: ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P', 'k', 'MediaTrackPrevious', 'MediaRewind', 'AudioVolumeDown'],
  nextCh: [']'], prevCh: ['['], fontUp: ['+', '='], fontDown: ['-', '_'], menu: ['Escape', 'm'],
  read: ['r', 'MediaPlayPause'], auto: ['a'], bookmark: ['b'], lock: ['l'], back: ['Delete']
};
function keymap() { return Object.assign({}, DEFAULT_KEYS, S.keys || {}); }
const keyName = k => k === ' ' ? 'Space' : k.startsWith('code:') ? k.slice(5) : k;
function actionFor(e) {
  const km = keymap(), code = 'code:' + e.code;
  for (const a in km) if (km[a].includes(e.key) || km[a].includes(code)) return a;
  return null;
}
function run(a) {
  if (a === 'next') next(); else if (a === 'prev') prev();
  else if (a === 'nextCh') jumpChapter(1); else if (a === 'prevCh') jumpChapter(-1);
  else if (a === 'fontUp') fontBy(4); else if (a === 'fontDown') fontBy(-4);
  else if (a === 'menu') { if (sheetOpen()) closeSheet(); else toggleTools(); }
  else if (a === 'read') ttsToggle(); else if (a === 'auto') autoToggle();
  else if (a === 'bookmark') toggleBookmark(); else if (a === 'lock') lockToggle();
  else if (a === 'back') goBack();
}
document.addEventListener('keydown', e => {
  const k = e.key;
  const shown = k === 'Unidentified' || !k ? 'code ' + e.code : keyName(k);
  document.querySelectorAll('.lastkey').forEach(el => { el.textContent = shown; });
  if (R.learn) {
    e.preventDefault(); e.stopPropagation();
    const key = k && k !== 'Unidentified' ? k : 'code:' + e.code;
    const km = keymap();
    for (const a in km) km[a] = km[a].filter(x => x !== key);
    km[R.learn] = [...(km[R.learn] || []), key];
    S.keys = km; saveS();
    const a = R.learn; R.learn = null;
    toast(keyName(key) + ' now does: ' + ACTIONS.find(x => x[0] === a)[1]);
    if (R.onLearn) R.onLearn();
    return;
  }
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { if (k === 'Escape') closeSheet(); return; }
  if (sheetOpen()) { if (k === 'Escape' || actionFor(e) === 'menu') { e.preventDefault(); closeSheet(); } return; }
  if ($('read').hidden) {
    if (k === 'Enter' && store.get('last')) { e.preventDefault(); openBookById(store.get('last')); }
    return;
  }
  let a = actionFor(e);
  if (a === 'next' && k === ' ' && e.shiftKey) a = 'prev';
  if (!a) return;
  e.preventDefault();
  if (e.repeat && (a === 'next' || a === 'prev')) return; // a held button turns one page, not twenty
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  run(a);
}, true);

/* ---------- touch: sides turn, middle opens the menu, swipes turn ---------- */
let pd = null, holdT = null, unlockedAt = 0;
page.addEventListener('pointerdown', e => {
  pd = { x: e.clientX, y: e.clientY, t: now(), sel: hasSelection() };
  if (S.lock) holdT = setTimeout(() => { S.lock = false; applySet(); unlockedAt = now(); toast('Unlocked'); }, 2000);
});
page.addEventListener('pointercancel', () => { pd = null; clearTimeout(holdT); });
page.addEventListener('pointerup', e => {
  clearTimeout(holdT);
  if (!pd) return;
  const d = pd; pd = null;
  if (now() - unlockedAt < 800) return;
  if (S.lock) { toast('Locked. Hold the screen for 2 seconds to unlock.'); return; }
  const dx = e.clientX - d.x, dy = e.clientY - d.y, dt = now() - d.t;
  if (d.sel || hasSelection()) return;
  if (Math.abs(dx) > 40 || Math.abs(dy) > 40) {
    if (dt > 900) return;
    if (Math.abs(dx) > Math.abs(dy)) dx < 0 ? next() : prev();
    else dy < 0 ? next() : prev();
    return;
  }
  if (dt > 500) return; // a long press is someone selecting text
  const a = e.target.closest && e.target.closest('a[href]');
  if (a && flow.contains(a)) { followLink(a); return; }
  const mk = e.target.closest && e.target.closest('mark.hl');
  if (mk && $('tools').hidden) { openHighlight(mk.dataset.id); return; }
  if (!$('tools').hidden) return toggleTools(false);
  const w = page.clientWidth;
  if (e.clientX < w * 0.3) prev();
  else if (e.clientX > w * 0.7) next();
  else toggleTools(true);
});
let wheelSum = 0, wheelT = 0;
page.addEventListener('wheel', e => {
  e.preventDefault();
  if (S.lock) return;
  wheelSum += Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (now() - wheelT < 400 || Math.abs(wheelSum) < 40) return;
  wheelT = now();
  wheelSum > 0 ? next() : prev();
  wheelSum = 0;
}, { passive: false });

/* ---------- the menu over the page ---------- */
function toggleTools(force) {
  const want = force != null ? force : $('tools').hidden;
  if (want === !$('tools').hidden) return;
  $('tools').hidden = !want;
  if (want) { drawTools(); stopAuto(); } else scheduleAuto();
}
function drawTools() {
  if (!R.book) return;
  $('t-read').textContent = TTS.on ? 'Stop reading' : 'Read aloud';
  $('t-auto').textContent = S.autoOn ? 'Auto turn: on' : 'Auto turn: off';
  $('t-mark').textContent = bookmarkHere() ? 'Unbookmark' : 'Bookmark';
  $('booktitle').textContent = R.meta.title;
}
$('t-lib').onclick = () => closeBook();
$('t-toc').onclick = () => openToc();
$('t-search').onclick = () => openSearch();
$('t-mark').onclick = () => { toggleBookmark(); drawTools(); };
$('t-marks').onclick = () => openMarks();
$('t-text').onclick = () => openTextSettings();
$('t-read').onclick = () => { ttsToggle(); };
$('t-auto').onclick = () => openAuto();
$('t-lock').onclick = () => lockToggle();
$('t-more').onclick = () => openMore();
$('backbtn').onclick = () => goBack();
$('slider').oninput = () => { $('sliderlab').textContent = Math.floor($('slider').value / 10) + '%'; };
$('slider').onchange = () => goPercent($('slider').value / 1000);

function fontBy(d) {
  S.fs = Math.max(20, Math.min(120, S.fs + d));
  saveS(); applySet();
  if (R.book) layout();
  toast(S.fs + 'px');
}

/* ---------- sheets: panels that slide over the page ---------- */
function openSheet(title, build, opts = {}) {
  closeSheet(true);
  stopAuto();
  const body = h('div', { class: 'sbody' });
  const sh = h('div', { class: 'sheet' + (opts.wide ? ' wide' : '') },
    h('div', { class: 'shead' }, h('h2', { text: title }), h('button', { class: 'close', text: 'Close', onclick: () => closeSheet() })), body);
  $('sheets').append(h('div', { class: 'scrim', onclick: () => closeSheet() }), sh);
  build(body, sh);
  return body;
}
function closeSheet(quiet) {
  $('sheets').innerHTML = '';
  R.learn = null; R.onLearn = null;
  if (!quiet && R.book && !$('read').hidden) scheduleAuto();
  if (!quiet && typeof onSheetClosed === 'function') onSheetClosed();
}
function sheetOpen() { return !!$('sheets').firstChild; }

function openToc() {
  openSheet('Contents', body => {
    const list = R.book.toc.length ? R.book.toc : Array.from({ length: R.book.count }, (_, i) => ({ label: (R.book.unit === 'page' ? 'Page ' : 'Chapter ') + (i + 1), i, frag: '', depth: 0 }));
    let cur = null;
    for (const t of list) {
      const here = t.i === R.ch && (!cur || cur.dataset.i != t.i);
      const b = h('button', { class: 'item' + (here ? ' cur' : ''), style: 'padding-left:' + (16 + Math.min(t.depth, 4) * 28) + 'px', text: t.label || '(untitled)', onclick: () => { closeSheet(); goToc(t); } });
      b.dataset.i = t.i;
      if (here) cur = b;
      body.append(b);
    }
    if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 0);
  });
}

async function chapterText(i) {
  if (R.texts[i] != null) return R.texts[i];
  const res = await R.book.chapter(i, { images: false });
  R.texts[i] = res.div ? res.div.textContent : '';
  return R.texts[i];
}
/* how long each chapter is, in letters, worked out in the background */
async function measureBook() {
  const token = R.token;
  if (R.lens || R.book.fixedAll) return;
  const lens = [];
  for (let i = 0; i < R.book.count; i++) {
    if (token !== R.token) return;
    try { lens.push((await chapterText(i)).length || 1); } catch (e) { lens.push(1); }
    if (i % 4 === 3) await wait(0);
  }
  if (token !== R.token) return;
  R.lens = lens;
  R.meta.lens = lens;
  await DB.putBook(R.meta);
  drawStatus();
}

function openSearch() {
  openSheet('Search this book', body => {
    const inp = h('input', { type: 'search', placeholder: 'Words to find', enterkeyhint: 'search' });
    const out = h('div');
    const go = async () => {
      const q = inp.value.trim().toLowerCase();
      if (q.length < 2) return;
      out.innerHTML = '';
      const note = h('p', { class: 'mut', text: 'Searching…' });
      out.append(note);
      let n = 0;
      for (let i = 0; i < R.book.count && n < 300; i++) {
        note.textContent = 'Searching ' + (R.book.unit === 'page' ? 'page ' : 'chapter ') + (i + 1) + ' of ' + R.book.count + '…';
        const t = await chapterText(i), low = t.toLowerCase();
        let at = low.indexOf(q);
        while (at >= 0 && n < 300) {
          const snip = t.slice(Math.max(0, at - 60), at + q.length + 60).replace(/\s+/g, ' ');
          const s = at;
          const b = h('button', { class: 'item result', onclick: async () => { closeSheet(); remember(); await loadChapter(i, { off: s }); flash(s, s + q.length); } },
            h('span', { class: 'mut', text: (tocLabel(i) || (R.book.unit === 'page' ? 'Page ' : 'Chapter ') + (i + 1)) + '  ' }),
            h('span', { html: esc(snip).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => '<b>' + m + '</b>') }));
          out.append(b); n++;
          at = low.indexOf(q, at + q.length);
        }
      }
      note.textContent = n ? n + (n >= 300 ? '+' : '') + ' found' : 'Not found';
    };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    body.append(h('div', { class: 'row' }, inp, h('button', { class: 'pri', text: 'Find', onclick: go })), out);
    setTimeout(() => inp.focus(), 50);
  });
}

function openMarks(tab = 'bm') {
  openSheet('Bookmarks and highlights', body => {
    const draw = () => {
      body.innerHTML = '';
      const all = Rows.liveMarks(R.id).sort((a, b) => a.ch - b.ch || (a.off ?? a.s ?? 0) - (b.off ?? b.s ?? 0));
      const bms = all.filter(m => m.kind === 'bm'), hls = all.filter(m => m.kind === 'hl');
      body.append(h('div', { class: 'row' },
        h('button', { class: tab === 'bm' ? 'pri' : '', text: 'Bookmarks (' + bms.length + ')', onclick: () => { tab = 'bm'; draw(); } }),
        h('button', { class: tab === 'hl' ? 'pri' : '', text: 'Highlights (' + hls.length + ')', onclick: () => { tab = 'hl'; draw(); } })));
      const where = m => Math.floor((m.p || 0) * 100) + '% · ' + (tocLabel(m.ch) || (R.book.unit === 'page' ? 'Page ' : 'Chapter ') + (m.ch + 1));
      if (tab === 'bm') {
        body.append(h('button', { class: 'pri wide', text: bookmarkHere() ? 'Remove the bookmark on this page' : 'Bookmark this page', onclick: () => { toggleBookmark(); draw(); } }));
        if (!bms.length) body.append(h('p', { class: 'mut', text: 'No bookmarks yet. The remote can add one too: press B, or set a button under Remote buttons.' }));
        for (const m of bms) body.append(h('div', { class: 'mark' },
          h('button', { class: 'item', onclick: () => { closeSheet(); remember(); loadChapter(m.ch, m.off >= 0 ? { off: m.off } : { frac: m.f }); } },
            h('div', { class: 'mut', text: where(m) }), h('div', { text: m.text || '(a picture)' })),
          h('button', { class: 'small', text: 'Delete', onclick: () => { Rows.delMark(R.id, m.id); drawStatus(); draw(); } })));
      } else {
        if (!hls.length) body.append(h('p', { class: 'mut', text: 'No highlights yet. Press and hold on a word, drag to select, then tap Highlight at the bottom of the screen.' }));
        else body.append(h('button', { class: 'wide', text: 'Copy all highlights and notes', onclick: () => copyText(R.meta.title + '\n\n' + hls.map(m => '"' + m.text + '"' + (m.note ? '\nNote: ' + m.note : '') + '\n(' + where(m) + ')').join('\n\n')) }));
        for (const m of hls) body.append(h('div', { class: 'mark' },
          h('button', { class: 'item', onclick: async () => { closeSheet(); remember(); await loadChapter(m.ch, { off: m.s }); } },
            h('div', { class: 'mut', text: where(m) }), h('div', { class: 'quote', text: m.text }), m.note ? h('div', { class: 'notetxt', text: 'Note: ' + m.note }) : null),
          h('button', { class: 'small', text: 'Edit', onclick: () => openHighlight(m.id) })));
      }
    };
    draw();
  });
}

function stepper(label, get, set, fmt) {
  const val = h('span', { class: 'val' });
  const upd = () => { val.textContent = fmt(get()); };
  upd();
  return h('div', { class: 'setrow' }, h('span', { class: 'lab', text: label }),
    h('button', { text: '−', 'aria-label': 'less', onclick: () => { set(-1); upd(); } }), val,
    h('button', { text: '+', 'aria-label': 'more', onclick: () => { set(1); upd(); } }));
}
function toggleRow(label, key, after) {
  const b = h('button', { class: 'tog' });
  const upd = () => { b.textContent = S[key] ? 'On' : 'Off'; b.classList.toggle('on', !!S[key]); };
  upd();
  b.onclick = () => { S[key] = !S[key]; saveS(); applySet(); upd(); if (after) after(); };
  return h('div', { class: 'setrow' }, h('span', { class: 'lab', text: label }), b);
}
function choiceRow(label, opts, get, set) {
  const wrap = h('div', { class: 'choices' });
  const draw = () => {
    wrap.innerHTML = '';
    for (const [v, t] of opts) wrap.append(h('button', { class: get() === v ? 'pri' : '', text: t, onclick: () => { set(v); draw(); } }));
  };
  draw();
  return h('div', { class: 'setblock' }, h('div', { class: 'lab', text: label }), wrap);
}
function relayout() { if (R.book) layout(); }
function openTextSettings() {
  openSheet('Text and page', body => {
    body.append(
      stepper('Text size', () => S.fs, d => { S.fs = Math.max(20, Math.min(120, S.fs + d * 4)); saveS(); applySet(); relayout(); }, v => v + 'px'),
      choiceRow('Font', Object.entries(FONTS).map(([k, f]) => [k, f.label]), () => S.font, v => { S.font = v; saveS(); applySet(); relayout(); }),
      toggleRow('Bold text', 'bold', relayout),
      stepper('Line spacing', () => S.lh, d => { S.lh = Math.max(1.1, Math.min(2.2, +(S.lh + d * 0.1).toFixed(2))); saveS(); applySet(); relayout(); }, v => v.toFixed(1)),
      stepper('Side margins', () => S.margin, d => { S.margin = Math.max(12, Math.min(160, S.margin + d * 8)); saveS(); applySet(); relayout(); }, v => v + 'px'),
      choiceRow('Colours', [['dark', 'Dark'], ['black', 'Black'], ['sepia', 'Sepia'], ['light', 'Light']], () => S.theme, v => { S.theme = v; saveS(); applySet(); }),
      toggleRow('Straight right edge (justify)', 'justify', () => reloadHere()),
      toggleRow('Book\'s own layout (centred lines, indents, quotes)', 'bookStyle', () => reloadHere()),
      toggleRow('Two pages side by side when sideways', 'twoPage', relayout),
      toggleRow('Slide animation on page turn', 'anim'),
      toggleRow('Clock', 'clock'),
      toggleRow('Time left', 'timeLeft', () => R.book && drawStatus()),
      toggleRow('Text selection (press and hold)', 'select')
    );
    if (R.book && R.book.kind === 'pdf') {
      body.append(choiceRow('This PDF shows', [['text', 'Big text'], ['pages', 'Page pictures']], () => R.meta.pdfMode || 'text', async v => {
        R.meta.pdfMode = v; await DB.putBook(R.meta);
        const f = R.pages > 1 ? R.pg / R.pages : 0;
        loadChapter(R.ch, { frac: f });
      }));
    }
  });
}
function openAuto() {
  openSheet('Auto turn', body => {
    body.append(
      h('p', { class: 'mut', text: 'Turns the page for you. The thin bar at the top fills up until the next turn. Any button or tap resets it.' }),
      toggleRow('Auto turn', 'autoOn', () => drawTools()),
      choiceRow('Timing', [['fixed', 'Every few seconds'], ['pace', 'At my reading pace']], () => S.autoMode, v => { S.autoMode = v; saveS(); }),
      stepper('Seconds per page (every few seconds)', () => S.autoSec, d => { S.autoSec = Math.max(5, Math.min(300, S.autoSec + d * 5)); saveS(); }, v => v + ' s'),
      h('p', { class: 'mut', text: 'Your pace right now: about ' + Math.round(S.rate / 6) + ' words a minute, learned from the pages you turn yourself.' }));
  });
}
function openRead() {
  openSheet('Read aloud', body => {
    const sel = h('select');
    const fill = () => {
      sel.innerHTML = '';
      sel.append(h('option', { value: '', text: 'Default voice' }));
      const lang = (R.book && R.book.lang || 'en').slice(0, 2);
      for (const v of voices().filter(v => v.lang.startsWith(lang)).concat(voices().filter(v => !v.lang.startsWith(lang)))) {
        const o = h('option', { value: v.voiceURI, text: v.name + ' (' + v.lang + ')' });
        if (v.voiceURI === S.ttsVoice) o.selected = true;
        sel.append(o);
      }
    };
    fill();
    if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = fill;
    sel.onchange = () => { S.ttsVoice = sel.value; saveS(); if (TTS.on) ttsFrom(TTS.list[TTS.k] ? TTS.list[TTS.k].s : Math.max(0, R.off)); };
    body.append(
      h('div', { class: 'row' }, h('button', { class: 'pri', text: TTS.on ? 'Stop reading' : 'Start reading from this page', onclick: () => { closeSheet(); ttsToggle(); } })),
      h('div', { class: 'setblock' }, h('div', { class: 'lab', text: 'Voice' }), sel),
      stepper('Speed', () => S.ttsRate, d => { S.ttsRate = Math.max(0.5, Math.min(2.5, +(S.ttsRate + d * 0.1).toFixed(1))); saveS(); }, v => v.toFixed(1) + '×'),
      h('p', { class: 'mut', text: 'Better voices: iPad Settings, Accessibility, Spoken Content, Voices. Download an Enhanced or Premium voice, then pick it here.' }));
  });
}
function openMore() {
  openSheet('More', body => {
    const b = (text, fn) => h('button', { class: 'item', text, onclick: fn });
    body.append(
      b('Read aloud settings', openRead),
      b('Auto turn settings', openAuto),
      b(S.lock ? 'Unlock the screen' : 'Lock the screen (remote only)', () => { closeSheet(); lockToggle(); }),
      b('Remote buttons', openRemote),
      b('Reading log', openLog),
      b(R.meta.finished ? 'Mark as not finished' : 'Mark as finished', async () => { R.meta.finished = !R.meta.finished; R.meta.t = now(); await DB.putBook(R.meta); Sync.mark('meta', R.id); closeSheet(); toast(R.meta.finished ? 'Marked as finished' : 'Marked as not finished'); }),
      b('Previous chapter', () => { closeSheet(); jumpChapter(-1); }),
      b('Next chapter', () => { closeSheet(); jumpChapter(1); }),
      h('p', { class: 'mut', text: R.meta.title + (R.meta.author ? ' by ' + R.meta.author : '') + ' · ' + (R.meta.kind || 'epub').toUpperCase() + ' · ' + fmtMB(R.meta.size || 0) }));
  });
}

function openRemote() {
  openSheet('Remote buttons', body => {
    const draw = () => {
      body.innerHTML = '';
      body.append(h('p', { class: 'mut' }, 'Press any button on the remote to see its name: ', h('b', { class: 'lastkey', text: 'nothing yet' })),
        h('p', { class: 'mut', text: 'To give a button a job, tap Set next to the job, then press the button. The iPad never lets a web page see the volume buttons, so a camera-shutter remote has to be switched to a mode that sends arrows or Enter.' }));
      const km = keymap();
      for (const [a, label] of ACTIONS) {
        const set = h('button', { class: 'small' + (R.learn === a ? ' pri' : ''), text: R.learn === a ? 'Press it now' : 'Set', onclick: () => { R.learn = a; R.onLearn = draw; draw(); } });
        body.append(h('div', { class: 'setrow' }, h('span', { class: 'lab' }, label, h('br'), h('small', { class: 'mut', text: (km[a] || []).slice(0, 6).map(keyName).join(', ') || 'no button' })), set));
      }
      body.append(h('button', { class: 'wide', text: 'Reset all buttons', onclick: () => { S.keys = null; saveS(); draw(); } }));
    };
    draw();
  });
}

function openLog() {
  openSheet('Reading log', body => {
    const mine = store.get('log', {}), other = store.get('logRemote', {});
    const days = {};
    const add = (d, r) => { if (!r) return; const x = days[d] || (days[d] = { ms: 0, chars: 0, pages: 0 }); x.ms += r.ms || 0; x.chars += r.chars || 0; x.pages += r.pages || 0; };
    for (const d in mine) add(d, mine[d]);
    for (const d in other) for (const dev in other[d]) add(d, other[d][dev]);
    const today = days[dayKey()] || { ms: 0, chars: 0, pages: 0 };
    const words = c => Math.round(c / 6).toLocaleString();
    let wk = { ms: 0, chars: 0 }, all = { ms: 0, chars: 0 };
    const t0 = now();
    for (const d in days) { all.ms += days[d].ms; all.chars += days[d].chars; if (t0 - new Date(d + 'T00:00').getTime() < 7 * 864e5) { wk.ms += days[d].ms; wk.chars += days[d].chars; } }
    body.append(h('div', { class: 'stats' },
      h('div', {}, h('b', { text: fmtMin(today.ms / 60000) }), h('span', { text: 'today, ' + words(today.chars) + ' words' })),
      h('div', {}, h('b', { text: fmtMin(wk.ms / 60000) }), h('span', { text: 'last 7 days, ' + words(wk.chars) + ' words' })),
      h('div', {}, h('b', { text: fmtMin(all.ms / 60000) }), h('span', { text: 'all time, ' + words(all.chars) + ' words' })),
      h('div', {}, h('b', { text: Math.round(S.rate / 6) + '' }), h('span', { text: 'words a minute, your pace' }))));
    const bars = h('div', { class: 'bars' });
    let max = 1;
    const last = [];
    for (let k = 13; k >= 0; k--) { const d = dayKey(t0 - k * 864e5); const m = (days[d] || {}).ms || 0; last.push([d, m]); max = Math.max(max, m); }
    for (const [d, m] of last) bars.append(h('div', { class: 'bar', title: d + ': ' + fmtMin(m / 60000) }, h('i', { style: 'height:' + Math.round(m / max * 100) + '%' }), h('span', { text: new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'narrow' }) })));
    body.append(h('h3', { text: 'Minutes read, last 14 days' }), bars);
    const ses = store.get('sessions', []).filter(s => s.ms > 30000).slice(-15).reverse();
    body.append(h('h3', { text: 'Recent sessions on this device' }));
    if (!ses.length) body.append(h('p', { class: 'mut', text: 'None yet. A session is counted from the pages you turn.' }));
    for (const s of ses) {
      const dt = new Date(s.start);
      body.append(h('div', { class: 'sess' },
        h('span', { text: dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) }),
        h('span', { text: s.book || '' }),
        h('span', { text: fmtMin(s.ms / 60000) + ', ' + s.pages + ' pages, ' + (s.ms > 60000 ? Math.round(s.chars / 6 / (s.ms / 60000)) + ' wpm' : '') })));
    }
  });
}

/* ---------- keep the screen on, and the clock ---------- */
let lock = null;
async function wake() {
  try { if ('wakeLock' in navigator && !lock && !document.hidden) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) {}
}
function unwake() { if (lock) lock.release().catch(() => {}); lock = null; }
function tickClock() { $('clock').textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
setInterval(tickClock, 15000); tickClock();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (R.book) { wake(); scheduleAuto(); } }
  else { save(); stopAuto(); Log.pause(); }
});
window.addEventListener('pagehide', () => save());
let resizeT;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(() => layout(), 150); });

/* ---------- open and close ---------- */
async function startReading(book, meta) {
  R.token++;
  R.book = book; R.meta = meta; R.id = meta.id; R.quietUntilTurn = false;
  R.lens = meta.lens && meta.lens.length === book.count ? meta.lens : null;
  R.texts = []; R.history = []; R.turnT = now(); R.pg = 0; R.pages = 1; R.off = 0;
  store.set('last', meta.id);
  $('lib').hidden = true;
  $('read').hidden = false;
  $('tools').hidden = true;
  applySet();
  const pos = Rows.pos(meta.id) || { ch: 0, off: -1, f: 0 };
  if (pos.ch == null && pos.p != null) {
    // came from the X4, which keeps its place as a share of the book
    const at = percentTarget(pos.p);
    R.quietUntilTurn = true;
    await loadChapter(at.i, { frac: at.f });
    if (pos.src === 'x4') toast('Opened where you left off on the X4');
  } else {
    await loadChapter(Math.min(pos.ch || 0, book.count - 1), pos.off >= 0 ? { off: pos.off } : { frac: pos.f || 0 });
  }
  Log.last = now();
  wake();
  measureBook();
}
function closeBook() {
  save();
  if (TTS.on) ttsStop();
  stopAuto();
  R.token++;
  try { R.book && R.book.close(); } catch (e) {}
  R.book = null; R.meta = null; R.id = null;
  R.urls.forEach(u => URL.revokeObjectURL(u)); R.urls = [];
  flow.innerHTML = '';
  $('bookcss').textContent = '';
  closeSheet(true);
  hideSelBar();
  $('read').hidden = true;
  $('lib').hidden = false;
  Log.pause();
  unwake();
  Sync.push();
  drawLib();
}
