'use strict';
/* Every kind of book becomes the same shape:
   { kind, title, author, count, sizes, toc, unit, fixed,
     chapter(i, {images}) -> { div } or { fixedPage: {src|img, vw, vh} },
     link(i, href) -> { i, frag } | { external } | { resolve: async () => {i, anchor} },
     cover() -> Blob, close() } */

const DRM_MSG = 'This book is copy-protected (DRM). Books bought from Kindle, Apple Books or Google Play are locked to their own apps, and no web page can open them. DRM-free EPUBs open fine: many shops sell them, and Project Gutenberg and Standard Ebooks give them away.';
const xmlDoc = s => new DOMParser().parseFromString(s || '', 'application/xml');
const tagsNS = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function joinPath(base, href) {
  href = (href || '').split('#')[0];
  try { href = decodeURIComponent(href); } catch (e) {}
  if (href.startsWith('/')) { base = ''; href = href.slice(1); }
  const out = [];
  for (const part of (base + href).split('/')) { if (part === '..') out.pop(); else if (part && part !== '.') out.push(part); }
  return out.join('/');
}
const fragOf = href => { const i = (href || '').indexOf('#'); if (i < 0) return ''; try { return decodeURIComponent(href.slice(i + 1)); } catch (e) { return href.slice(i + 1); } };
const isExternal = href => /^[a-z][a-z0-9+.-]*:/i.test(href || '') && !/^(blob|filepos|kindle):/i.test(href);

/* ---------- turning a book's page into something that obeys the reader's settings ---------- */
const STRIP = 'script,style,link,meta,iframe,object,embed,form,input,button,select,textarea,audio,video,title,head,noscript,canvas';
const KEEP = /^(text-align|font-style|font-weight|font-variant|font-variant-caps|text-decoration|text-decoration-line|text-transform|margin-left|margin-right|padding-left|text-indent|display|page-break-before|page-break-after|break-before|break-after|vertical-align|list-style-type|white-space)$/;
function safeDecl(prop, val) {
  prop = prop.toLowerCase(); val = String(val).trim().replace(/\s*!important$/, '');
  if (!KEEP.test(prop) || !val) return null;
  if (/^(margin|padding)-(left|right)$|^text-indent$/.test(prop)) {
    const m = val.match(/^(-?[\d.]+)(em|rem|%|px|pt)?$/);
    if (!m) return val === '0' || val === 'auto' ? (val === 'auto' ? null : '0') : null;
    const n = parseFloat(m[1]), u = m[2] || 'px';
    let em = u === 'em' || u === 'rem' ? n : u === '%' ? n / 10 : u === 'pt' ? n / 12 : n / 16;
    em = Math.max(prop === 'text-indent' ? -2 : 0, Math.min(em, 2));
    return +em.toFixed(2) + 'em';
  }
  if (prop === 'display' && !/^(none|block|inline|inline-block)$/.test(val)) return null;
  if (prop === 'text-align' && val === 'justify') return S.justify ? 'justify' : 'left';
  if (prop === 'white-space' && !/^(pre|pre-wrap|pre-line)$/.test(val)) return null;
  return val;
}
function safeStyle(style) {
  const out = [];
  for (let i = 0; i < style.length; i++) { const p = style[i], v = safeDecl(p, style.getPropertyValue(p)); if (v != null) out.push(p + ':' + v); }
  return out.join(';');
}
/* the book's own stylesheet, cut down to layout that cannot fight the text size, and fenced inside #flow */
function scopeCss(text) {
  let sheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(text.replace(/@import[^;]+;/g, '')); } catch (e) { return ''; }
  const out = [];
  const walk = rules => {
    for (const r of rules) {
      if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
      if (!r.selectorText || !r.style) continue;
      const body = safeStyle(r.style);
      if (!body) continue;
      const sel = r.selectorText.split(',').map(s => s.trim().replace(/^(html|body)\b\s*/i, '').replace(/::?(before|after|first-letter|first-line)\b.*/i, '')).filter(Boolean);
      const scoped = sel.length ? sel.map(s => '#flow ' + s).join(',') : '#flow';
      out.push(scoped + '{' + body + '}');
    }
  };
  walk(sheet.cssRules);
  return out.join('\n');
}

/* turns a parsed page into a clean div. css: collects the book's stylesheets */
async function cleanBody(doc, { base = '', loadCss } = {}) {
  const body = doc.body || tagsNS(doc, 'body')[0];
  const div = document.createElement('div');
  let css = '';
  if (S.bookStyle && loadCss) {
    const heads = [...doc.getElementsByTagNameNS('*', 'link')].filter(l => /stylesheet/i.test(l.getAttribute('rel') || ''));
    for (const l of heads) css += await loadCss(l.getAttribute('href')) + '\n';
    for (const st of doc.getElementsByTagNameNS('*', 'style')) css += scopeCss(st.textContent) + '\n';
  }
  if (!body) return { div, css };
  for (const n of [...body.childNodes]) div.append(document.importNode(n, true));
  div.querySelectorAll(STRIP).forEach(n => n.remove());
  // an svg that only wraps a picture, which covers usually are, becomes a plain picture
  for (const svg of [...div.querySelectorAll('svg')]) {
    const im = svg.querySelector('image');
    if (!im) { if (!svg.textContent.trim()) svg.remove(); continue; }
    const img = document.createElement('img');
    img.setAttribute('src', im.getAttribute('href') || im.getAttribute('xlink:href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '');
    svg.replaceWith(img);
  }
  for (const el of div.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n === 'style') {
        const v = S.bookStyle ? safeStyle(el.style) : '';
        if (v) el.setAttribute('style', v); else el.removeAttribute('style');
      } else if (/^on|^(width|height|bgcolor|color|face|size|background)$/.test(n)) el.removeAttribute(a.name);
      else if (n === 'align' && !S.bookStyle) el.removeAttribute(a.name);
      else if (n === 'class' && !S.bookStyle) el.removeAttribute(a.name);
    }
  }
  el_dataBase(div, base);
  return { div, css };
}
function el_dataBase(div, base) { div.dataset.base = base; }

/* pictures: turned into blob addresses. resolve(src) -> Blob or a ready url */
async function fillImages(div, resolve, urls) {
  await Promise.all([...div.querySelectorAll('img')].map(async img => {
    const src = img.getAttribute('src') || '';
    if (/^(blob|data):/.test(src)) return;
    let got = null;
    try { got = await resolve(src); } catch (e) {}
    if (!got) { img.remove(); return; }
    const u = typeof got === 'string' ? got : URL.createObjectURL(got);
    if (typeof got !== 'string') urls.push(u);
    img.src = u; img.alt = '';
  }));
}
function stripImages(div) { div.querySelectorAll('img').forEach(i => i.removeAttribute('src')); }

function parseMarkup(src) {
  let doc = new DOMParser().parseFromString(src, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length || !(doc.body || tagsNS(doc, 'body')[0])) doc = new DOMParser().parseFromString(src, 'text/html');
  return doc;
}

/* ---------- which kind of file is this ---------- */
async function sniff(blob, name = '') {
  const head = new Uint8Array(await blob.slice(0, 80).arrayBuffer());
  const str = String.fromCharCode(...head);
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (str.startsWith('%PDF')) return 'pdf';
  if (str.slice(60, 68) === 'BOOKMOBI') return 'mobi';
  if (str.slice(60, 68) === 'TEXtREAd') return 'palmdoc';
  if (str.startsWith('TPZ')) return 'topaz';
  if (str.startsWith('CONT') || str.startsWith('\xeaDRMION')) return 'kfx';
  if (head[0] === 0x50 && head[1] === 0x4b) {
    const z = await unzip(blob);
    if (z.find('reader-backup.json')) return 'backup';
    if (z.find('META-INF/container.xml')) return 'epub';
    if (z.names().some(n => /\.(jpe?g|png|gif|webp|avif)$/i.test(n))) return 'cbz';
    return 'zip';
  }
  if (ext === 'txt' || ext === 'text' || ext === 'md') return 'txt';
  if (['doc', 'docx', 'rtf', 'djvu', 'lit', 'fb2', 'kfx', 'azw4'].includes(ext)) return 'unknown';
  // plain text if the first bytes read as text
  const bytes = new Uint8Array(await blob.slice(0, 4000).arrayBuffer());
  let bad = 0; for (const b of bytes) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bad < 4 ? 'txt' : 'unknown';
}

async function openBook(blob, meta = {}) {
  const kind = meta.kind || await sniff(blob, meta.name || '');
  if (kind === 'epub') return openEpub(blob);
  if (kind === 'pdf') return openPdf(blob, meta);
  if (kind === 'mobi') return openMobi(blob);
  if (kind === 'cbz') return openCbz(blob, meta);
  if (kind === 'txt') return openTxt(blob, meta);
  if (kind === 'kfx' || kind === 'topaz') throw new Error('This is a Kindle file in Amazon\'s own format (KFX or Topaz), which only Kindle apps can open. ' + DRM_MSG);
  if (kind === 'palmdoc') throw new Error('This is a very old Palm eBook. Convert it to EPUB first, for example with Calibre.');
  throw new Error('The reader opens EPUB, PDF, MOBI, AZW, AZW3, CBZ and TXT files. This one is none of those.');
}

/* ---------- EPUB ---------- */
async function openEpub(blob) {
  const z = await unzip(blob);
  const encx = await z.text('META-INF/encryption.xml');
  if (encx) {
    const algs = tagsNS(xmlDoc(encx), 'EncryptionMethod').map(m => m.getAttribute('Algorithm') || '');
    if (algs.some(a => !/idpf\.org\/2008\/embedding|ns\.adobe\.com\/pdf\/enc#RC/.test(a))) throw new Error(DRM_MSG);
  }
  if (await z.text('META-INF/rights.xml')) throw new Error(DRM_MSG);
  const cx = xmlDoc(await z.text('META-INF/container.xml'));
  const rf = tagsNS(cx, 'rootfile')[0];
  if (!rf) throw new Error('This EPUB is damaged: it has no contents file.');
  const opfPath = rf.getAttribute('full-path');
  const opf = xmlDoc(await z.text(opfPath));
  const base = dirOf(opfPath), man = {}, byPath = {};
  for (const it of tagsNS(opf, 'item')) {
    const m = { id: it.getAttribute('id'), href: joinPath(base, it.getAttribute('href')), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
    man[m.id] = m; byPath[m.href] = m;
  }
  const spine = [], spineProps = [];
  const spineEl = tagsNS(opf, 'spine')[0];
  for (const r of tagsNS(opf, 'itemref')) {
    if (r.getAttribute('linear') === 'no') continue;
    const m = man[r.getAttribute('idref')];
    if (m && /html|xml/.test(m.type)) { spine.push(m.href); spineProps.push(r.getAttribute('properties') || ''); }
  }
  if (!spine.length) throw new Error('This EPUB has no chapters.');
  const metas = tagsNS(opf, 'meta');
  const metaProp = p => (metas.find(m => m.getAttribute('property') === p) || {}).textContent;
  const fixedAll = (metaProp('rendition:layout') || '').trim() === 'pre-paginated';
  const isFixed = i => /rendition:layout-pre-paginated/.test(spineProps[i]) || (fixedAll && !/rendition:layout-reflowable/.test(spineProps[i]));
  const first = n => ((tagsNS(opf, n)[0] || {}).textContent || '').trim();
  const lang = first('language') || 'en';
  const indexOf = path => spine.indexOf(path);

  /* contents list: EPUB 3 nav first, then the older NCX */
  const toc = [];
  const nav = Object.values(man).find(m => /\bnav\b/.test(m.props));
  try {
    if (nav) {
      const d = parseMarkup(await z.text(nav.href));
      const navs = tagsNS(d, 'nav');
      const tocNav = navs.find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
      const walk = (ol, depth) => {
        for (const li of [...ol.children].filter(c => c.localName === 'li')) {
          const a = [...li.children].find(c => c.localName === 'a' || c.localName === 'span');
          if (a) {
            const href = a.getAttribute('href');
            const path = href ? joinPath(dirOf(nav.href), href) : '';
            toc.push({ label: a.textContent.replace(/\s+/g, ' ').trim(), i: indexOf(path), frag: href ? fragOf(href) : '', depth });
          }
          const sub = [...li.children].find(c => c.localName === 'ol');
          if (sub) walk(sub, depth + 1);
        }
      };
      const ol = tocNav && [...tocNav.getElementsByTagNameNS('*', 'ol')][0];
      if (ol) walk(ol, 0);
    }
    if (!toc.length) {
      const ncxItem = man[spineEl && spineEl.getAttribute('toc')] || Object.values(man).find(m => /ncx/.test(m.type));
      if (ncxItem) {
        const d = xmlDoc(await z.text(ncxItem.href));
        const walk = (el, depth) => {
          for (const np of [...el.children].filter(c => c.localName === 'navPoint')) {
            const label = (tagsNS(np, 'text')[0] || {}).textContent || '';
            const src = (tagsNS(np, 'content')[0] || { getAttribute: () => '' }).getAttribute('src');
            toc.push({ label: label.replace(/\s+/g, ' ').trim(), i: indexOf(joinPath(dirOf(ncxItem.href), src)), frag: fragOf(src), depth });
            walk(np, depth + 1);
          }
        };
        const navMap = tagsNS(d, 'navMap')[0];
        if (navMap) walk(navMap, 0);
      }
    }
  } catch (e) { console.warn('contents', e); }

  const cssCache = new Map();
  const loadCss = dir => async href => {
    if (!href) return '';
    const p = joinPath(dir, href);
    if (!cssCache.has(p)) cssCache.set(p, scopeCss((await z.text(p)) || ''));
    return cssCache.get(p);
  };

  return {
    kind: 'epub', lang, count: spine.length, unit: fixedAll ? 'page' : 'chapter', toc,
    title: first('title') || 'Untitled',
    author: tagsNS(opf, 'creator').map(c => c.textContent.trim()).filter(Boolean).join(', '),
    sizes: spine.map(p => Math.max(1, (z.find(p) || {}).usize || 1)),
    fixedAll,
    isFixed,
    pathOf: i => spine[i],
    async chapter(i, { images = true, urls = [] } = {}) {
      const path = spine[i], src = (await z.text(path)) || '';
      if (isFixed(i)) return images ? { fixedPage: await this.fixedPage(i, src, urls) } : { div: document.createElement('div'), css: '' };
      const doc = parseMarkup(src);
      const out = await cleanBody(doc, { base: path, loadCss: loadCss(dirOf(path)) });
      if (images) await fillImages(out.div, s => z.blob(joinPath(dirOf(path), s)), urls);
      else stripImages(out.div);
      return out;
    },
    /* a fixed-layout page is drawn as the book drew it, scaled to fit */
    async fixedPage(i, src, urls) {
      const path = spine[i], dir = dirOf(path);
      const doc = parseMarkup(src);
      const toUrl = async href => {
        if (!href || /^(data|blob|https?):/.test(href)) return href;
        const b = await z.blob(joinPath(dir, href));
        if (!b) return href;
        const u = URL.createObjectURL(b); urls.push(u); return u;
      };
      const cssUrls = async (text, cdir) => {
        const parts = [], re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
        let m, last = 0;
        while ((m = re.exec(text))) {
          parts.push(text.slice(last, m.index));
          let u = m[1];
          if (!/^(data|blob|https?):/.test(u)) { const b = await z.blob(joinPath(cdir, u)); if (b) { u = URL.createObjectURL(b); urls.push(u); } }
          parts.push('url("' + u + '")'); last = re.lastIndex;
        }
        parts.push(text.slice(last));
        return parts.join('');
      };
      doc.querySelectorAll('script').forEach(s => s.remove());
      for (const img of doc.querySelectorAll('img')) img.setAttribute('src', await toUrl(img.getAttribute('src')));
      for (const im of doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')) {
        const href = im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        const u = await toUrl(href);
        im.setAttribute('href', u); im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', u);
      }
      for (const l of [...doc.getElementsByTagNameNS('*', 'link')]) {
        if (!/stylesheet/i.test(l.getAttribute('rel') || '')) continue;
        const p = joinPath(dir, l.getAttribute('href'));
        const st = doc.createElementNS(l.namespaceURI, 'style');
        st.textContent = await cssUrls((await z.text(p)) || '', dirOf(p));
        l.replaceWith(st);
      }
      for (const st of doc.getElementsByTagNameNS('*', 'style')) st.textContent = await cssUrls(st.textContent, dir);
      let vw = 0, vh = 0;
      const vp = [...doc.getElementsByTagNameNS('*', 'meta')].find(m => m.getAttribute('name') === 'viewport');
      if (vp) { const c = vp.getAttribute('content') || ''; vw = +(c.match(/width\s*=\s*([\d.]+)/) || [])[1] || 0; vh = +(c.match(/height\s*=\s*([\d.]+)/) || [])[1] || 0; }
      if (!vw) { const v = metaProp('rendition:viewport') || ''; vw = +(v.match(/width\s*=\s*([\d.]+)/) || [])[1] || 0; vh = +(v.match(/height\s*=\s*([\d.]+)/) || [])[1] || 0; }
      const html = new XMLSerializer().serializeToString(doc);
      const u = URL.createObjectURL(new Blob([html], { type: doc.contentType === 'text/html' ? 'text/html' : 'application/xhtml+xml' }));
      urls.push(u);
      return { src: u, vw: vw || 1200, vh: vh || 1600 };
    },
    link(i, href) {
      if (isExternal(href)) return { external: href };
      const path = href.startsWith('#') ? spine[i] : joinPath(dirOf(spine[i]), href);
      const t = indexOf(path);
      if (t >= 0) return { i: t, frag: fragOf(href) };
      return byPath[path] && /html|xml/.test(byPath[path].type) ? { i: -1, path, frag: fragOf(href) } : null;
    },
    /* the text a footnote link points at, even in a file outside the reading order */
    async noteAt(path, frag) {
      const doc = parseMarkup((await z.text(path)) || '');
      const el = frag && (doc.getElementById(frag) || [...doc.getElementsByTagNameNS('*', '*')].find(e => e.getAttribute('id') === frag || e.getAttribute('name') === frag));
      if (!el) return '';
      const block = el.closest ? (el.closest('aside,li,p,dd,div,section') || el) : el;
      return block.textContent.replace(/\s+/g, ' ').trim().slice(0, 1500);
    },
    async cover() {
      let item = Object.values(man).find(m => /cover-image/.test(m.props));
      if (!item) { const id = (metas.find(m => m.getAttribute('name') === 'cover') || { getAttribute: () => '' }).getAttribute('content'); item = man[id]; }
      if (item && /^image/.test(item.type)) return z.blob(item.href, item.type);
      const doc = parseMarkup((await z.text(spine[0])) || '');
      const im = doc.querySelector('img') || doc.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'image')[0];
      if (!im) return null;
      const src = im.getAttribute('src') || im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      return src ? z.blob(joinPath(dirOf(spine[0]), src)) : null;
    },
    close() {}
  };
}

/* ---------- CBZ comics: a zip of pictures, one picture a page ---------- */
async function openCbz(blob, meta) {
  const z = await unzip(blob);
  const pics = z.names().filter(n => /\.(jpe?g|png|gif|webp|avif)$/i.test(n) && !/__MACOSX|\/\./.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  if (!pics.length) throw new Error('This comic has no pictures in it.');
  return {
    kind: 'cbz', count: pics.length, unit: 'page', toc: [], fixedAll: true, isFixed: () => true,
    title: (meta.name || 'Comic').replace(/\.[^.]+$/, ''), author: '',
    sizes: pics.map(() => 1),
    async chapter(i, { images = true, urls = [] } = {}) {
      if (!images) return { div: document.createElement('div'), css: '' };
      const u = URL.createObjectURL(await z.blob(pics[i])); urls.push(u);
      return { fixedPage: { img: u } };
    },
    link: () => null,
    cover() { return z.blob(pics[0]); },
    close() {}
  };
}

/* ---------- plain text ---------- */
async function openTxt(blob, meta) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(bytes);
  if ((text.match(/�/g) || []).length > 20) text = new TextDecoder('windows-1252').decode(bytes);
  text = text.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const blank = lines.filter(l => !l.trim()).length;
  // hard-wrapped text keeps paragraphs apart with blank lines; otherwise each line is one
  const paras = blank > lines.length / 12 ? text.split(/\n\s*\n/).map(p => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean) : lines.map(l => l.trim()).filter(Boolean);
  const isHead = p => p.length < 80 && /^(chapter|book|part|prologue|epilogue|act|section)\b/i.test(p);
  const chapters = [];
  let cur = null;
  const heads = paras.filter(isHead).length;
  for (const p of paras) {
    if (!cur || (heads >= 2 && isHead(p)) || (heads < 2 && cur.len > 20000)) { cur = { title: heads >= 2 && isHead(p) ? p : '', paras: [], len: 0 }; chapters.push(cur); }
    cur.paras.push(p); cur.len += p.length;
  }
  if (!chapters.length) chapters.push({ title: '', paras: [''], len: 1 });
  const title = (meta.name || 'Text').replace(/\.[^.]+$/, '');
  return {
    kind: 'txt', count: chapters.length, unit: 'chapter', title, author: '', fixedAll: false, isFixed: () => false,
    toc: chapters.map((c, i) => ({ label: c.title || 'Part ' + (i + 1), i, frag: '', depth: 0 })).filter(t => chapters[t.i].title || chapters.length > 1),
    sizes: chapters.map(c => c.len || 1),
    async chapter(i) {
      const div = document.createElement('div');
      div.innerHTML = chapters[i].paras.map(p => p === chapters[i].title ? '<h2>' + esc(p) + '</h2>' : '<p>' + esc(p) + '</p>').join('');
      return { div, css: '' };
    },
    link: () => null, cover: async () => null, close() {}
  };
}

/* ---------- PDF: reflowed into big text, or shown as pictures of the pages ---------- */
async function loadPdfJs() {
  if (window.pdfjsLib) return;
  await loadScript('lib/pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
}
async function openPdf(blob, meta) {
  await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  let pdf;
  try { pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise; }
  catch (e) {
    if (e && e.name === 'PasswordException') throw new Error('This PDF is locked with a password, and the reader cannot open locked PDFs.');
    throw new Error('This PDF could not be read: ' + (e.message || e));
  }
  const info = (await pdf.getMetadata().catch(() => null)) || {};
  const toc = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items, depth) => {
      for (const it of items || []) {
        let i = -1;
        try {
          const dest = typeof it.dest === 'string' ? await pdf.getDestination(it.dest) : it.dest;
          if (dest && dest[0] != null) i = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
        } catch (e) {}
        toc.push({ label: it.title, i, frag: '', depth });
        await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
  } catch (e) {}
  const mode = () => (meta.pdfMode || 'text');
  const renderPage = async (i, maxW) => {
    const page = await pdf.getPage(i + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxW / vp1.width);
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, intent: 'print' }).promise;
    const b = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.88));
    c.width = c.height = 0;
    return b;
  };
  return {
    kind: 'pdf', count: pdf.numPages, unit: 'page', toc,
    title: (info.info && info.info.Title && info.info.Title.trim()) || (meta.name || 'PDF').replace(/\.[^.]+$/, ''),
    author: (info.info && info.info.Author) || '',
    sizes: Array.from({ length: pdf.numPages }, () => 1),
    get fixedAll() { return mode() === 'pages'; },
    isFixed() { return mode() === 'pages'; },
    async chapter(i, { images = true, urls = [] } = {}) {
      if (mode() === 'pages') {
        if (!images) return { div: document.createElement('div'), css: '' };
        const w = Math.min(2400, Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1));
        const u = URL.createObjectURL(await renderPage(i, w)); urls.push(u);
        return { fixedPage: { img: u } };
      }
      const page = await pdf.getPage(i + 1);
      const tc = await page.getTextContent();
      const html = pdfParagraphs(tc.items);
      const div = document.createElement('div');
      if (html.replace(/<[^>]+>/g, '').trim().length < 25) {
        // a scanned page has no text to reflow, so show its picture instead
        if (images) {
          const u = URL.createObjectURL(await renderPage(i, Math.min(2000, innerWidth * (devicePixelRatio || 1)))); urls.push(u);
          div.innerHTML = '<img src="' + u + '">';
        }
        return { div, css: '' };
      }
      div.innerHTML = html;
      return { div, css: '' };
    },
    link: () => null,
    async cover() { return renderPage(0, 400); },
    close() { pdf.destroy(); }
  };
}
function pdfParagraphs(items) {
  const lines = [];
  let cur = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const t = it.transform, x = t[4], y = t[5], hgt = Math.hypot(t[2], t[3]) || it.height || 10;
    if (!cur || Math.abs(cur.y - y) > hgt * 0.5) { cur = { y, x, x2: x, h: hgt, s: '' }; lines.push(cur); }
    if (cur.s && !/\s$/.test(cur.s) && it.str && !/^\s/.test(it.str) && x - cur.x2 > hgt * 0.12) cur.s += ' ';
    cur.s += it.str; cur.x2 = Math.max(cur.x2, x + (it.width || 0)); cur.h = Math.max(cur.h, hgt);
    if (it.hasEOL) cur = null;
  }
  const L = lines.map(l => ({ ...l, s: l.s.replace(/\s+/g, ' ').trim() })).filter(l => l.s && !/^\d{1,4}$/.test(l.s));
  if (!L.length) return '';
  const gaps = [], hs = L.map(l => l.h).sort((a, b) => a - b);
  for (let k = 1; k < L.length; k++) { const g = L[k - 1].y - L[k].y; if (g > 0) gaps.push(g); }
  gaps.sort((a, b) => a - b);
  const mg = gaps[Math.floor(gaps.length / 2)] || hs[0] * 1.2, mh = hs[Math.floor(hs.length / 2)];
  const right = Math.max(...L.map(l => l.x2)), left = Math.min(...L.map(l => l.x));
  const out = [];
  let para = null;
  for (let k = 0; k < L.length; k++) {
    const l = L[k], prev = L[k - 1];
    const head = l.h > mh * 1.3;
    const brk = !prev || head || (prev.h > mh * 1.3) || (prev.y - l.y) > mg * 1.45 || (prev.y - l.y) < 0 ||
      (/[.!?:"”’)]$/.test(prev.s) && prev.x2 < right - mh * 3) || (l.x > left + mh * 1.2 && l.x2 > right - mh * 3 && /[.!?"”’]$/.test(prev.s));
    if (brk) { para = { head, s: l.s }; out.push(para); continue; }
    if (/[A-Za-z]-$/.test(para.s) && /^[a-z]/.test(l.s)) para.s = para.s.slice(0, -1) + l.s;
    else para.s += ' ' + l.s;
  }
  return out.map(p => p.head ? '<h2>' + esc(p.s) + '</h2>' : '<p>' + esc(p.s) + '</p>').join('');
}

/* ---------- MOBI, AZW, AZW3 (Kindle files without copy protection), via foliate-js ---------- */
async function openMobi(blob) {
  // copy protection is flagged in the first record, before anything is decoded
  const hdr = new DataView(await blob.slice(0, 86).arrayBuffer());
  const rec0 = hdr.getUint32(78, false);
  const r0 = new DataView(await blob.slice(rec0, rec0 + 16).arrayBuffer());
  if (r0.getUint16(12, false) !== 0) throw new Error(DRM_MSG);
  const { MOBI } = await import('../lib/mobi.js');
  const unzlib = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  let bk;
  try { bk = await new MOBI({ unzlib }).open(blob); }
  catch (e) { throw new Error('This Kindle file could not be read: ' + (e.message || e)); }
  const idx = bk.sections.map((s, i) => s.load ? i : -1).filter(i => i >= 0);
  const fixed = bk.rendition && bk.rendition.layout === 'pre-paginated';
  const toc = [];
  const walk = (items, depth) => { for (const it of items || []) { let i = -1; try { i = idx.indexOf(bk.splitTOCHref(it.href)[0]); } catch (e) {} toc.push({ label: it.label, i, frag: '', href: it.href, depth }); walk(it.subitems, depth + 1); } };
  walk(bk.toc, 0);
  const md = bk.metadata || {};
  const author = Array.isArray(md.author) ? md.author.join(', ') : (md.author || '');
  const cssCache = new Map();
  const loadCss = async href => {
    if (!href || !/^blob:/.test(href)) return '';
    if (!cssCache.has(href)) cssCache.set(href, scopeCss(await fetch(href).then(r => r.text()).catch(() => '')));
    return cssCache.get(href);
  };
  return {
    kind: 'mobi', count: idx.length, unit: fixed ? 'page' : 'chapter', toc, fixedAll: fixed, isFixed: () => fixed,
    title: md.title || 'Untitled', author,
    sizes: idx.map(i => Math.max(1, bk.sections[i].size || 1)),
    async chapter(i, { images = true } = {}) {
      const url = await bk.sections[idx[i]].load();
      if (fixed) {
        const v = bk.rendition.viewport || {};
        return images ? { fixedPage: { src: url, vw: +v.width || 1200, vh: +v.height || 1600 } } : { div: document.createElement('div'), css: '' };
      }
      const doc = parseMarkup(await fetch(url).then(r => r.text()));
      const out = await cleanBody(doc, { loadCss });
      if (!images) stripImages(out.div);
      return out;
    },
    link(i, href) {
      if (bk.isExternal && bk.isExternal(href) || isExternal(href)) return { external: href };
      return { resolve: async () => { const r = await bk.resolveHref(href); return r ? { i: idx.indexOf(r.index), anchor: r.anchor } : null; } };
    },
    async cover() { try { return await bk.getCover(); } catch (e) { return null; } },
    close() { try { bk.destroy(); } catch (e) {} }
  };
}
