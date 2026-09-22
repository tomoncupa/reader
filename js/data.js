'use strict';
/* Storage, zip files and small helpers. Loaded first. */

const $ = id => document.getElementById(id);
const wait = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now();
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dayKey = (t = now()) => { const d = new Date(t); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const fmtMB = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
function fmtMin(m) {
  m = Math.round(m);
  if (m < 1) return 'under a minute';
  if (m < 60) return m + ' min';
  const hh = Math.floor(m / 60), mm = m % 60;
  return hh + ' h' + (mm ? ' ' + mm + ' min' : '');
}

/* ---------- small values: localStorage ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem('reader.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('reader.' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('reader.' + k); } catch (e) {} },
  keys(prefix) {
    const out = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith('reader.' + prefix)) out.push(k.slice(7)); } } catch (e) {}
    return out;
  }
};

const DEFAULTS = {
  fs: 44, theme: 'dark', bold: true, font: 'system', lh: 1.45, margin: 44, justify: false,
  bookStyle: true, twoPage: false, anim: false, clock: true, timeLeft: true, select: true,
  rate: 900, autoOn: false, autoMode: 'fixed', autoSec: 30, ttsRate: 1, ttsVoice: '',
  lock: false, keys: null, sort: 'recent', shelf: 'all'
};
const S = Object.assign({}, DEFAULTS, store.get('settings', {}));
S.lock = false; // never open locked
function saveS() { store.set('settings', S); }

/* ---------- big values: IndexedDB. books = details, files = the book itself ---------- */
const DB = {
  p: null,
  open() {
    return this.p || (this.p = new Promise((ok, no) => {
      const r = indexedDB.open('reader', 2);
      r.onupgradeneeded = e => {
        const d = r.result, t = r.transaction;
        if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('files')) d.createObjectStore('files', { keyPath: 'id' });
        if (e.oldVersion === 1) {
          // version 1 kept the book inside its details; move it out
          const bs = t.objectStore('books'), fs = t.objectStore('files');
          bs.openCursor().onsuccess = ev => {
            const c = ev.target.result;
            if (!c) return;
            const v = c.value;
            if (v.data) {
              fs.put({ id: v.id, blob: new Blob([v.data], { type: 'application/epub+zip' }) });
              v.size = v.data.byteLength; v.ext = 'epub'; v.t = v.added || now();
              delete v.data;
              c.update(v);
            }
            c.continue();
          };
        }
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    }));
  },
  async req(name, mode, fn) {
    const d = await this.open();
    return new Promise((ok, no) => {
      const t = d.transaction(name, mode);
      const r = fn(t.objectStore(name));
      t.oncomplete = () => ok(r && r.result);
      t.onerror = () => no(t.error);
      t.onabort = () => no(t.error || new Error('Storage refused the write. The iPad may be out of space.'));
    });
  },
  books() { return this.req('books', 'readonly', s => s.getAll()); },
  book(id) { return this.req('books', 'readonly', s => s.get(id)); },
  putBook(b) { return this.req('books', 'readwrite', s => s.put(b)); },
  delBook(id) { return Promise.all([this.req('books', 'readwrite', s => s.delete(id)), this.delFile(id)]); },
  async file(id) { const r = await this.req('files', 'readonly', s => s.get(id)); return r && r.blob; },
  putFile(id, blob) { return this.req('files', 'readwrite', s => s.put({ id, blob })); },
  delFile(id) { return this.req('files', 'readwrite', s => s.delete(id)); },
  async hasFile(id) { const k = await this.req('files', 'readonly', s => s.getKey(id)); return k != null; }
};

/* ---------- per-book rows kept in localStorage ---------- */
const Rows = {
  pos(id) { return store.get('pos.' + id, null); },
  setPos(id, v) { store.set('pos.' + id, v); Sync.mark('pos', id); },
  marks(id) { return store.get('marks.' + id, {}); },
  liveMarks(id) { return Object.values(this.marks(id)).filter(m => !m.del); },
  putMark(bookId, m) {
    const all = this.marks(bookId);
    m.t = now();
    all[m.id] = m;
    store.set('marks.' + bookId, all);
    Sync.mark('marks', bookId);
  },
  delMark(bookId, markId) {
    const all = this.marks(bookId);
    if (!all[markId]) return;
    all[markId] = { id: markId, del: true, t: now() };
    store.set('marks.' + bookId, all);
    Sync.mark('marks', bookId);
  }
};
const uid = () => now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------- reading log, one row per day on this device ---------- */
const Log = {
  last: 0, session: null,
  tick(chars, pages) {
    const t = now(), d = dayKey(t);
    const log = store.get('log', {});
    const row = log[d] || (log[d] = { ms: 0, chars: 0, pages: 0 });
    const gap = this.last ? t - this.last : 0;
    if (gap > 0 && gap < 180000) row.ms += gap;
    row.chars += Math.max(0, chars || 0);
    row.pages += pages || 0;
    row.t = t;
    store.set('log', log);
    if (!this.session || gap > 600000 || !this.last) this.startSession();
    const s = this.session;
    if (gap > 0 && gap < 180000) s.ms += gap;
    s.chars += Math.max(0, chars || 0); s.pages += pages || 0; s.end = t;
    this.saveSession();
    this.last = t;
    Sync.mark('log', d);
  },
  startSession() {
    this.session = { start: now(), end: now(), ms: 0, chars: 0, pages: 0, book: (typeof R !== 'undefined' && R.meta) ? R.meta.title : '' };
    const all = store.get('sessions', []);
    all.push(this.session);
    store.set('sessions', all.slice(-400));
  },
  saveSession() {
    const all = store.get('sessions', []);
    if (all.length) all[all.length - 1] = this.session;
    store.set('sessions', all);
  },
  pause() { this.last = 0; }
};

/* ---------- zip: read lazily from a Blob, so a big book is never all in memory ---------- */
async function unzip(blob) {
  const size = blob.size, tailLen = Math.min(size, 65557 + 22);
  const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
  const tdv = new DataView(tail.buffer);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tdv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('This file is not a zip.');
  let n = tdv.getUint16(e + 10, true), cdSize = tdv.getUint32(e + 12, true), cdOff = tdv.getUint32(e + 16, true);
  if ((n === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && e >= 20 && tdv.getUint32(e - 20, true) === 0x07064b50) {
    // ZIP64, for files past 4 GB
    const z64 = Number(tdv.getBigUint64(e - 12, true));
    const z = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
    n = Number(z.getBigUint64(32, true)); cdSize = Number(z.getBigUint64(40, true)); cdOff = Number(z.getBigUint64(48, true));
  }
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer), td = new TextDecoder();
  const files = new Map();
  let p = 0;
  for (let k = 0; k < n && p + 46 <= cd.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), lo = dv.getUint32(p + 42, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nl));
    let x = p + 46 + nl;
    const xend = x + xl;
    while (x + 4 <= xend) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true);
      if (id === 1) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (lo === 0xffffffff) { lo = Number(dv.getBigUint64(q, true)); }
      }
      x += 4 + len;
    }
    if (!name.endsWith('/')) files.set(name, { method, csize, usize, lo });
    p += 46 + nl + xl + cl;
  }
  const lower = new Map([...files.keys()].map(k => [k.toLowerCase(), k]));
  const find = name => files.get(name) || files.get(lower.get((name || '').toLowerCase()));
  return {
    files, find,
    names() { return [...files.keys()]; },
    async bytes(name) {
      const f = find(name);
      if (!f) return null;
      const lh = new DataView(await blob.slice(f.lo, f.lo + 30).arrayBuffer());
      const s = f.lo + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = blob.slice(s, s + f.csize);
      if (f.method === 0) return new Uint8Array(await raw.arrayBuffer());
      if (f.method !== 8) throw new Error('This file uses a compression the reader does not know.');
      const out = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(out).arrayBuffer());
    },
    async text(name) { const b = await this.bytes(name); return b ? td.decode(b) : null; },
    async blob(name, type) { const b = await this.bytes(name); return b ? new Blob([b], { type: type || mimeOf(name) }) : null; }
  };
}
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', css: 'text/css', xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
const mimeOf = name => MIME[(name.split('.').pop() || '').toLowerCase()] || '';

/* a plain (stored, uncompressed) zip, for backups */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function makeZip(entries, onStep) {
  const parts = [], cen = [], enc = new TextEncoder();
  let off = 0, k = 0;
  for (const en of entries) {
    if (onStep) onStep(++k, entries.length);
    const name = enc.encode(en.name), data = new Uint8Array(await en.blob.arrayBuffer()), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, en.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    cen.push(ch.buffer, name);
    off += 30 + name.length + data.length;
  }
  const cenSize = cen.reduce((a, b) => a + b.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cen, end.buffer], { type: 'application/zip' });
}

/* a book's id comes from its bytes, so the same file on two devices is the same book */
async function fileId(blob) {
  const a = await blob.slice(0, 2e6).arrayBuffer(), b = await blob.slice(Math.max(0, blob.size - 2e6)).arrayBuffer();
  const all = new Uint8Array(a.byteLength + b.byteLength + 16);
  all.set(new Uint8Array(a), 0); all.set(new Uint8Array(b), a.byteLength);
  all.set(new TextEncoder().encode(String(blob.size).padStart(16, '0')), a.byteLength + b.byteLength);
  if (crypto.subtle) {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return 'b' + [...d.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return 'b' + crc32(all).toString(16) + blob.size.toString(16);
}

function loadScript(src) {
  return new Promise((ok, no) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => no(new Error('Could not load ' + src)); document.head.append(s); });
}
