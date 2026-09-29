'use strict';
/* Sync with X4: the place in a book, shared with the X4 through a KOReader-sync server
   (CrossPoint Sync at sync.crosspointreader.com unless another address is typed in).
   Only the place travels. Books, highlights and the reading log stay with the Firebase sync.

   The X4 names a book by an MD5 of its file name ("Filename") or of 1 KB samples of the file
   ("Binary"), by its KOReader Sync setting. This iPad sends and asks under both names, so
   either setting finds the book. Percentages are worked out the X4's way: from the unzipped
   size of each chapter file in the EPUB. The server keeps one row per device and hands back
   the newest, by its own clock. */

const KO = {
  DEFAULT: 'https://sync.crosspointreader.com',
  X4_ID: 'crosspoint-reader',
  EVERY: 30000, // while reading, at most one send every 30 s
  timer: null, lastSend: 0, busy: false,
  cfg() { return store.get('kosync', null); },
  on() { const c = this.cfg(); return !!(c && c.url && c.user && c.key); },
  devId() { return 'reader-' + Sync.dev(); },
  status(m) { store.set('koStatus', m); const el = document.getElementById('kostatus'); if (el) el.textContent = m; },
  clock: () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),

  async call(path, { method = 'GET', body, cfg = this.cfg() } = {}) {
    const headers = { Accept: 'application/vnd.koreader.v1+json' };
    if (cfg.user) { headers['x-auth-user'] = cfg.user; headers['x-auth-key'] = cfg.key; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let r;
    try { r = await fetch(cfg.url.replace(/\/+$/, '') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (e) { throw new Error('no answer from the sync server. Check the WiFi.'); }
    let j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      const err = new Error(r.status === 401 ? 'the name or password is wrong'
        : r.status === 402 ? 'that name is taken. If it is yours, tap Sign in'
        : r.status === 429 ? 'too many tries. Wait a minute'
        : r.status === 403 && j && j.message ? j.message
        : 'the sync server answered ' + r.status);
      err.status = r.status;
      throw err;
    }
    return j || {};
  },

  /* once per book: its two X4 names and the X4's chapter sizes */
  info(id) { return store.get('ko.' + id, null); },
  async prepare(book, meta) {
    const have = this.info(meta.id);
    if (have && have.v === 1) return have;
    if (!book || !book.x4 || !book.x4.sizes.some(s => s > 0)) return null; // the X4 syncs EPUBs only
    const inf = { v: 1, ids: [], xs: book.x4.sizes, xc: [] };
    const blob = await DB.file(meta.id);
    if (blob) inf.ids.push(await partialMd5(blob));
    if (meta.name) { const n = md5hex(new TextEncoder().encode(meta.name)); if (!inf.ids.includes(n)) inf.ids.push(n); }
    for (let i = 0; i < book.count; i++) inf.xc.push(book.x4.paths.indexOf(book.pathOf(i)));
    if (!inf.ids.length) return null;
    store.set('ko.' + meta.id, inf);
    return inf;
  },

  /* this iPad's place as the X4 counts it. intra: how far into the chapter, 0 to 1 */
  toX4(inf, ch, intra) {
    const j = inf.xc[ch];
    if (j == null || j < 0) return null;
    let before = 0, tot = 0;
    inf.xs.forEach((s, k) => { tot += s; if (k < j) before += s; });
    if (!tot) return null;
    const size = inf.xs[j];
    // a few bytes in: the X4 reads a place exactly on a chapter's edge as the end of the chapter before
    const into = Math.min(size, Math.max(intra * size, Math.min(16, size / 2)));
    return { pct: Math.round(Math.min(1, (before + into) / tot) * 1e6) / 1e6, xp: '/body/DocFragment[' + (j + 1) + ']/body' };
  },
  /* the X4's percentage as a chapter here and a share of it */
  fromX4(inf, pct) {
    const tot = inf.xs.reduce((a, b) => a + b, 0), target = Math.max(0, Math.min(1, pct)) * tot;
    const lastCh = () => { for (let i = inf.xc.length - 1; i >= 0; i--) if (inf.xc[i] >= 0) return i; return inf.xc.length - 1; };
    let acc = 0, j = -1;
    for (let k = 0; k < inf.xs.length; k++) { if (target < acc + inf.xs[k]) { j = k; break; } acc += inf.xs[k]; }
    if (j < 0) return { ch: lastCh(), f: 0.999 };
    const intra = Math.max(0, Math.min(0.999, (target - acc) / inf.xs[j]));
    const i = inf.xc.indexOf(j);
    if (i >= 0) return { ch: i, f: intra };
    // a part the iPad does not show as a chapter (linear="no"): the next chapter it does show
    let best = -1;
    inf.xc.forEach((x, k) => { if (x > j && (best < 0 || x < inf.xc[best])) best = k; });
    return best >= 0 ? { ch: best, f: 0 } : { ch: lastCh(), f: 0.999 };
  },

  /* sending: Rows.setPos calls this every time this iPad's place changes */
  moved(id, pos) {
    if (!this.on() || !pos) return;
    const inf = this.info(id);
    if (!inf) return;
    let intra = pos.f || 0;
    if (typeof R !== 'undefined' && R.id === id && R.book && R.ch === pos.ch && pos.off >= 0 && R.chLen > 0) intra = pos.off / R.chLen;
    const x = this.toX4(inf, pos.ch || 0, intra);
    if (!x) return;
    const pend = store.get('koPending', {});
    pend[id] = { pct: x.pct, xp: x.xp, t: pos.t || now() };
    store.set('koPending', pend);
    this.schedule();
  },
  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(0, this.lastSend + this.EVERY - now()));
  },
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.on() || this.busy) return;
    const pend = store.get('koPending', {}), ids = Object.keys(pend);
    if (!ids.length) return;
    this.busy = true; this.lastSend = now();
    let stop = false;
    try {
      for (const id of ids) {
        const p = pend[id], inf = this.info(id), meta = await DB.book(id);
        if (inf && meta) for (const doc of inf.ids) {
          await this.call('/syncs/progress', { method: 'PUT', body: {
            document: doc, progress: p.xp, percentage: p.pct, device: 'iPad Reader', device_id: this.devId(),
            metadata: { filename: meta.name || undefined, title: meta.title || undefined, authors: meta.author || undefined } } });
        }
        const cur = store.get('koPending', {});
        if (cur[id] && cur[id].t === p.t) { delete cur[id]; store.set('koPending', cur); }
      }
      this.status('Place sent at ' + this.clock());
    } catch (e) { this.status('Not sent: ' + e.message); stop = e.status === 401; }
    finally {
      this.busy = false;
      if (!stop && Object.keys(store.get('koPending', {})).length) this.schedule();
    }
  },

  /* asking: the newest place under either of the book's names */
  async newest(inf) {
    const rows = await Promise.all(inf.ids.map(d => this.call('/syncs/progress/' + d).catch(e => { if (e.status === 401 || !e.status) throw e; return {}; })));
    let best = null;
    for (const r of rows) if (r && typeof r.percentage === 'number' && r.timestamp && (!best || r.timestamp > best.timestamp)) best = r;
    return best;
  },
  /* newest wins: a newer place from another device comes back to be taken; this iPad's
     own place is sent if it is the newer one */
  async exchange(meta, inf) {
    const r = await this.newest(inf), id = meta.id, local = Rows.pos(id);
    if (r && r.device_id === this.X4_ID) {
      const x = store.get('x4.' + id);
      if (!x || (x.t || 0) < r.timestamp * 1000) store.set('x4.' + id, { p: r.percentage, t: r.timestamp * 1000 });
    }
    const rt = r ? r.timestamp * 1000 : 0;
    if (r && r.device_id !== this.devId() && r.timestamp > store.get('koSeen.' + id, 0) && (!local || (local.t || 0) < rt)) {
      const at = this.fromX4(inf, r.percentage);
      return { ch: at.ch, off: -1, f: at.f, p: r.percentage, t: rt, src: 'cps', dev: r.device_id === this.X4_ID ? 'the X4' : (r.device || 'another device') };
    }
    if (local && local.t && local.t > rt + 2000) this.moved(id, local);
    return null;
  },
  take(id, pos) {
    store.set('koSeen.' + id, Math.round(pos.t / 1000));
    store.set('pos.' + id, pos);
    Sync.mark('pos', id);
  },
  /* before a book opens: up to 3 s for a newer place, which it then opens at */
  async beforeOpen(book, meta) {
    if (!this.on()) return;
    try {
      const inf = await this.prepare(book, meta);
      if (!inf) return;
      const job = this.exchange(meta, inf).then(pos => { this.status('Synced at ' + this.clock()); return pos; },
        e => { this.status('Not synced: ' + e.message); return null; });
      const got = await Promise.race([job, wait(3000).then(() => 'late')]);
      if (got === 'late') job.then(pos => this.later(meta.id, pos));
      else if (got) this.take(meta.id, got);
    } catch (e) { console.warn('kosync', e); }
  },
  /* a newer place for the book on screen. Kept only with the move to it, and only if no page
     turned here since: a place kept without the move would be overwritten by the next save */
  async later(id, pos) {
    if (!pos) return;
    for (let k = 0; k < 50 && R.loading; k++) await wait(100);
    const local = Rows.pos(id);
    if (R.id !== id || !R.book || R.loading || (local && (local.t || 0) >= pos.t)) return;
    this.take(id, pos);
    remember();
    R.quietUntilTurn = true;
    loadChapter(Math.min(pos.ch, R.book.count - 1), { frac: pos.f || 0 });
    toast('Moved to where you left off on ' + (pos.dev || 'the X4'));
  },
  /* the book on screen: ask again, as when the reader comes back to the front */
  async check() {
    if (!this.on() || !R.book || !R.meta) return null;
    const meta = R.meta, inf = await this.prepare(R.book, meta);
    if (!inf) return null;
    const pos = await this.exchange(meta, inf);
    await this.later(meta.id, pos);
    return pos;
  }
};

/* ---------- MD5, as KOReader and the X4 use it ---------- */
const MD5K = (() => { const k = new Int32Array(64); for (let i = 0; i < 64; i++) k[i] = (Math.abs(Math.sin(i + 1)) * 4294967296) | 0; return k; })();
const MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
function md5hex(bytes) {
  const n = bytes.length, total = (((n + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes); buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (n * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(n / 536870912), true);
  let a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
  const M = new Int32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      const s = MD5S[((i >> 4) << 2) + (i & 3)], x = (A + F + MD5K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, k) => out.setInt32(k * 4, v, true));
  return [...new Uint8Array(out.buffer)].map(x => x.toString(16).padStart(2, '0')).join('');
}
/* KOReader's "partial MD5": 1 KB at 0, 1 KB, 4 KB, 16 KB … 1 GB, while inside the file */
async function partialMd5(blob) {
  const parts = [];
  for (let i = -1; i <= 10; i++) {
    const off = i < 0 ? 0 : 1024 * Math.pow(4, i);
    if (off >= blob.size) break;
    parts.push(new Uint8Array(await blob.slice(off, off + 1024).arrayBuffer()));
  }
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let k = 0;
  for (const p of parts) { all.set(p, k); k += p.length; }
  return md5hex(all);
}

/* ---------- the Settings sheet ---------- */
function openX4Sync() {
  openSheet('Sync with X4', body => {
    const c = KO.cfg() || {};
    const stat = h('p', { id: 'kostatus', class: 'mut', text: store.get('koStatus', '') });
    const block = (label, el) => h('div', { class: 'setblock' }, h('div', { class: 'lab', text: label }), el);
    body.append(h('p', { text: 'Keeps your place in a book the same on this iPad and on the X4. Only the place travels, through CrossPoint Sync, a free server the X4 already knows how to use. Books still go onto the X4 by File Transfer.' }));
    if (KO.on()) {
      body.append(
        h('p', {}, 'On. Signed in as ', h('b', { text: c.user }), c.url.replace(/\/+$/, '') === KO.DEFAULT ? '.' : ' at ' + c.url + '.'),
        h('p', { class: 'mut', text: 'Your place goes out as you turn pages (at most every 30 seconds) and when you leave a book. Opening a book, or coming back to the reader, picks up a newer place from the X4. Works for EPUB books, the kind the X4 syncs.' }),
        h('div', { class: 'row' },
          h('button', { class: 'pri', text: 'Sync now', onclick: async () => {
            const waiting = Object.keys(store.get('koPending', {})).length;
            KO.status('Syncing…');
            await KO.flush();
            if (!R.book && !waiting) KO.status('Nothing waiting to send. Open a book to check the X4\'s place.');
            if (R.book) {
              try { const pos = await KO.check(); KO.status('Synced at ' + KO.clock() + (pos ? ': moved to where you left off on ' + pos.dev : ': this iPad has the newest place')); }
              catch (e) { KO.status('Not synced: ' + e.message); }
            }
          } }),
          h('button', { text: 'Sign out', onclick: () => {
            if (!confirm('Stop syncing your place with the X4 on this iPad?')) return;
            // keep the name and server for signing back in; forget the password key
            store.set('kosync', { url: c.url, user: c.user }); store.del('koPending'); store.del('koStatus');
            openX4Sync();
          } })),
        stat);
    } else {
      const user = h('input', { type: 'text', placeholder: 'name', autocapitalize: 'off', autocomplete: 'username', spellcheck: 'false', value: c.user || '' });
      const pass = h('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
      const url = h('input', { type: 'url', value: c.url || KO.DEFAULT, autocapitalize: 'off', spellcheck: 'false' });
      const go = async create => {
        const u = user.value.trim(), p = pass.value, base = url.value.trim().replace(/\/+$/, '');
        if (!/^[A-Za-z0-9._@+-]{1,64}$/.test(u)) { alert('Pick a name made of letters and numbers, with no spaces. Dots, dashes and @ are fine.'); return; }
        if (!p) { alert('Type a password.'); return; }
        if (!/^https?:\/\/[^/\s]+/.test(base)) { alert('The server address starts with https://'); return; }
        const cfg = { url: base, user: u, key: md5hex(new TextEncoder().encode(p)) };
        KO.status(create ? 'Making your account…' : 'Signing in…');
        try {
          if (create) await KO.call('/users/create', { method: 'POST', body: { username: u, password: cfg.key }, cfg: { url: base } });
          await KO.call('/users/auth', { cfg });
        } catch (e) { KO.status((create ? 'No account made: ' : 'Not signed in: ') + e.message); return; }
        store.set('kosync', cfg);
        KO.status((create ? 'Account made. ' : '') + 'Signed in at ' + KO.clock() + '.');
        openX4Sync();
        if (R.book) KO.check().catch(e => KO.status('Not synced: ' + e.message));
      };
      body.append(
        block('Name', user),
        block('Password: keep it short, you type it once on the X4 too', pass),
        h('div', { class: 'row' },
          h('button', { class: 'pri', text: 'Sign in', onclick: () => go(false) }),
          h('button', { text: 'Create account', onclick: () => go(true) })),
        stat,
        h('details', {}, h('summary', { text: 'Server address' }), url,
          h('p', { class: 'mut', text: 'Leave it as it is unless you run your own KOReader sync server.' })));
    }
    body.append(h('h3', { text: 'On the X4, once' }), h('ol', {},
      h('li', { text: 'Settings, System, KOReader Sync.' }),
      h('li', { text: 'Sync Server URL: https://sync.crosspointreader.com' }),
      h('li', { text: 'Username and Password: the same as here. Then Authenticate.' }),
      h('li', { text: 'Document Matching: either works; Binary still finds a book whose file was renamed.' }),
      h('li', { text: 'In a book: menu, Sync Progress. Apply remote takes the iPad\'s place; Upload local sends the X4\'s.' })));
  });
}

/* send when the reader goes away; ask again when it comes back with a book open */
document.addEventListener('visibilitychange', () => {
  if (!KO.on()) return;
  if (document.hidden) KO.flush();
  else { KO.flush(); if (R.book) KO.check().catch(e => KO.status('Not synced: ' + e.message)); }
});
window.addEventListener('pagehide', () => { if (KO.on()) KO.flush(); });
/* the iPad left open on its stand while he reads on the X4: ask once a minute when no page has
   turned here for a minute, every 5 minutes after 10 quiet minutes */
let koTick = 0;
setInterval(() => {
  koTick++;
  if (!KO.on() || document.hidden || !R.book || R.loading || sheetOpen()) return;
  const idle = now() - (R.turnT || 0);
  if (idle < 60000 || (idle > 600000 && koTick % 5)) return;
  KO.check().catch(e => KO.status('Not synced: ' + e.message));
}, 60000);
if (KO.on()) setTimeout(() => KO.flush(), 3000);
