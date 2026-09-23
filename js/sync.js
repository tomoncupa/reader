'use strict';
/* Sync between devices through a Firebase Realtime Database he owns.
   Off until an address and a sync code are typed in. Everything is a row with a time,
   and the newer row wins, one row at a time. Books travel in 1 MB pieces. */

const Sync = {
  pt: null, busy: false, lastMsg: '',
  cfg() { return store.get('sync', null); },
  on() { const c = this.cfg(); return !!(c && c.url && c.code); },
  dev() { let d = store.get('device'); if (!d) { d = uid(); store.set('device', d); } return d; },
  key: id => String(id).replace(/[.#$\[\]\/%]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')),
  unkey: k => String(k).replace(/%([0-9A-F]{2})/g, (_, x) => String.fromCharCode(parseInt(x, 16))),
  mark(kind, id) {
    if (!this.on()) return;
    const d = store.get('dirty', {});
    d[kind + '/' + id] = 1;
    store.set('dirty', d);
    clearTimeout(this.pt);
    this.pt = setTimeout(() => this.cycle(), 8000);
  },
  base() { const c = this.cfg(); return c.url.trim().replace(/\/+$/, '') + '/reader/' + encodeURIComponent(c.code.trim()); },
  async req(path, method = 'GET', body, keepalive) {
    const r = await fetch(this.base() + path + '.json', {
      method, keepalive: !!keepalive,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }
    });
    if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'the database refused (' + r.status + '). Check the rules in the setup steps.' : 'the database answered ' + r.status);
    return r.json();
  },
  status(t) { this.lastMsg = t; store.set('syncStatus', t); const el = document.getElementById('syncstatus'); if (el) el.textContent = t; },

  async metaOut(b) {
    const out = { id: b.id, title: b.title, author: b.author || '', kind: b.kind || 'epub', name: b.name || '', ext: b.ext || '', size: b.size || 0, added: b.added || 0, t: b.t || 0, shelf: b.shelf || '', finished: !!b.finished, count: b.count || 0, chunks: b.chunks || 0 };
    if (b.cover && b.cover.size < 60000) out.cover = await blobToB64(b.cover);
    return out;
  },
  async push(keepalive) {
    if (!this.on()) return;
    const dirty = store.get('dirty', {}), keys = Object.keys(dirty);
    if (!keys.length) return;
    const up = {};
    for (const k of keys) {
      const i = k.indexOf('/'), kind = k.slice(0, i), id = k.slice(i + 1);
      if (kind === 'pos') up['pos/' + this.key(id)] = Rows.pos(id);
      else if (kind === 'marks') {
        for (const [mid, m] of Object.entries(Rows.marks(id))) if ((m.t || 0) > (store.get('pushedAt', 0) - 60000)) up['marks/' + this.key(id) + '/' + this.key(mid)] = m;
      }
      else if (kind === 'meta') {
        const b = await DB.book(id);
        const gone = store.get('gone.' + id);
        if (b) {
          up['meta/' + this.key(id)] = await this.metaOut(b);
          up['lite/' + this.key(id)] = { id, name: b.name || '', title: b.title || '', kind: b.kind || 'epub', size: b.size || 0, chunks: b.chunks || 0, t: b.t || 0 };
        }
        else if (gone) {
          up['meta/' + this.key(id)] = { id, deleted: true, t: gone.t };
          up['lite/' + this.key(id)] = { id, deleted: true, t: gone.t };
          up['files/' + this.key(id)] = null;
        }
      }
      else if (kind === 'log') up['log/' + id + '/' + this.dev()] = (store.get('log', {}))[id] || null;
    }
    await this.req('', 'PATCH', up, keepalive);
    const d2 = store.get('dirty', {});
    for (const k of keys) delete d2[k];
    store.set('dirty', d2);
    store.set('pushedAt', now());
  },
  async pull() {
    if (!this.on()) return false;
    const [meta, pos, marks, log] = await Promise.all(['/meta', '/pos', '/marks', '/log'].map(p => this.req(p)));
    let changed = false;
    for (const k in meta || {}) {
      const m = meta[k], id = m.id || this.unkey(k);
      const local = await DB.book(id), gone = store.get('gone.' + id);
      if (m.deleted) {
        if (local && (local.t || 0) <= (m.t || 0)) { await DB.delBook(id); store.del('pos.' + id); store.del('marks.' + id); changed = true; }
        continue;
      }
      if (gone && gone.t >= (m.t || 0)) continue;
      const fields = { title: m.title, author: m.author, shelf: m.shelf, finished: m.finished, t: m.t, chunks: m.chunks || 0, kind: m.kind, name: m.name, ext: m.ext, size: m.size, count: m.count };
      if (!local) {
        await DB.putBook(Object.assign({ id, added: m.added || now(), remote: true, cover: m.cover ? b64ToBlob(m.cover, 'image/jpeg') : null }, fields));
        changed = true;
      } else if ((m.t || 0) > (local.t || 0)) {
        await DB.putBook(Object.assign(local, fields)); changed = true;
      } else if (!local.chunks && m.chunks) { local.chunks = m.chunks; await DB.putBook(local); }
    }
    for (const k in pos || {}) {
      const id = this.unkey(k), l = Rows.pos(id), r = pos[k];
      if (r && (!l || (r.t || 0) > (l.t || 0))) { store.set('pos.' + id, r); changed = true; }
    }
    for (const k in marks || {}) {
      const id = this.unkey(k), all = Rows.marks(id);
      let ch = false;
      for (const mk in marks[k]) { const r = marks[k][mk], mid = this.unkey(mk); if (!all[mid] || (r.t || 0) > (all[mid].t || 0)) { all[mid] = r; ch = true; } }
      if (ch) { store.set('marks.' + id, all); changed = true; }
    }
    const remote = {};
    for (const day in log || {}) for (const dv in log[day]) if (dv !== this.dev()) (remote[day] || (remote[day] = {}))[dv] = log[day][dv];
    store.set('logRemote', remote);
    return changed;
  },
  async cycle() {
    if (!this.on() || this.busy) return false;
    this.busy = true;
    let changed = false;
    try {
      changed = await this.pull();
      if (!store.get('liteDone')) {
        // the X4 reads a light list of books; fill it for books synced before it existed
        const d = store.get('dirty', {});
        for (const b of await DB.books()) d['meta/' + b.id] = 1;
        store.set('dirty', d);
        store.set('liteDone', 1);
      }
      await this.push();
      await this.uploadOne();
      this.status('Synced at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    } catch (e) { this.status('Not synced: ' + (e.message || e)); }
    finally { this.busy = false; }
    return changed;
  },
  /* books travel by themselves: one not-yet-uploaded book per sync, so the X4 can fetch it */
  async uploadOne() {
    if (this.uploading) return;
    for (const b of await DB.books()) {
      if (b.chunks || !(await DB.hasFile(b.id))) continue;
      this.uploading = true;
      try { await this.upload(b.id); } catch (e) { console.warn('upload', e); }
      finally { this.uploading = false; }
      return;
    }
  },
  async upload(id, onStep) {
    const b = await DB.book(id), blob = await DB.file(id);
    if (!b || !blob) return;
    const CH = 1e6, n = Math.ceil(blob.size / CH) || 1;
    for (let i = 0; i < n; i++) {
      if (onStep) onStep(i, n);
      await this.req('/files/' + this.key(id) + '/' + i, 'PUT', await blobToB64(blob.slice(i * CH, (i + 1) * CH)));
    }
    b.chunks = n; b.t = now();
    await DB.putBook(b);
    this.mark('meta', id);
    await this.push();
  },
  async download(id, chunks, onStep) {
    const parts = [];
    for (let i = 0; i < chunks; i++) {
      if (onStep) onStep(i, chunks);
      const s = await this.req('/files/' + this.key(id) + '/' + i);
      if (typeof s !== 'string') throw new Error('part ' + (i + 1) + ' of the book is missing');
      parts.push(b64ToBlob(s));
    }
    return new Blob(parts);
  }
};

function blobToB64(blob) {
  return new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = () => no(r.error); r.readAsDataURL(blob); });
}
function b64ToBlob(s, type = '') {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

function openSync() {
  openSheet('Sync between devices', body => {
    const c = Sync.cfg() || {};
    const url = h('input', { type: 'url', placeholder: 'https://…firebasedatabase.app', value: c.url || '' });
    const code = h('input', { type: 'text', placeholder: 'sync code', value: c.code || '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    const newCode = () => { const a = new Uint8Array(12); crypto.getRandomValues(a); code.value = [...a].map(x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('').replace(/(.{4})(?!$)/g, '$1-'); };
    if (!code.value) newCode();
    const stat = h('p', { id: 'syncstatus', class: 'mut', text: store.get('syncStatus', Sync.on() ? '' : 'Sync is off.') });
    body.append(
      h('p', { text: 'Keeps your books, your place, bookmarks, highlights and reading log the same on every device, through a free Firebase database you own. Your Magic app\'s Firebase project works.' }),
      h('div', { class: 'setblock' }, h('div', { class: 'lab', text: 'Database address' }), url),
      h('div', { class: 'setblock' }, h('div', { class: 'lab', text: 'Sync code: type the same one on every device' }), h('div', { class: 'row' }, code, h('button', { text: 'New code', onclick: newCode }))),
      h('div', { class: 'row' },
        h('button', { class: 'pri', text: 'Save and sync now', onclick: async () => {
          if (!/^https:\/\/.+/.test(url.value.trim()) || code.value.trim().length < 8) { alert('Paste the database address and a sync code of at least 8 letters.'); return; }
          store.set('sync', { url: url.value.trim(), code: code.value.trim() });
          const d = store.get('dirty', {});
          for (const b of await DB.books()) { d['meta/' + b.id] = 1; if (Rows.pos(b.id)) d['pos/' + b.id] = 1; if (Object.keys(Rows.marks(b.id)).length) d['marks/' + b.id] = 1; }
          for (const day in store.get('log', {})) d['log/' + day] = 1;
          store.set('dirty', d); store.set('pushedAt', 0);
          Sync.status('Syncing…');
          await Sync.cycle();
          drawLib();
        } }),
        Sync.on() ? h('button', { text: 'Turn sync off', onclick: () => { store.del('sync'); Sync.status('Sync is off.'); closeSheet(); } }) : null),
      stat);
    if (Sync.on()) {
      body.append(h('button', { class: 'pri wide', text: 'Save setup file for my X4', onclick: () => {
        const c2 = Sync.cfg();
        handOver(new File([c2.url + '\n' + c2.code + '\n'], 'ipad-sync.txt', { type: 'text/plain' }));
      } }), h('p', { class: 'mut', text: 'Put ipad-sync.txt at the top of the X4\'s SD card: open the X4\'s address in Safari (X4 menu, Network, File Transfer) and upload it. Then iPad Sync on the X4 main menu brings over your books and places. The X4 opens EPUB and TXT; PDFs and Kindle files stay here.' }));
      body.append(h('button', { class: 'wide', text: 'Upload books for my other devices', onclick: async e => {
        const btn = e.target;
        const books = await DB.books();
        const todo = [];
        for (const b of books) if (!b.chunks && await DB.hasFile(b.id)) todo.push(b);
        if (!todo.length) { toast('Every book here is already uploaded'); return; }
        let k = 0;
        for (const b of todo) {
          k++;
          try { await Sync.upload(b.id, (i, n) => { btn.textContent = 'Book ' + k + ' of ' + todo.length + ': ' + Math.round(i / n * 100) + '%'; }); }
          catch (err) { alert('"' + b.title + '" did not upload: ' + err.message); break; }
        }
        btn.textContent = 'Upload books for my other devices';
        toast('Uploaded');
      } }));
    }
    body.append(h('details', {},
      h('summary', { text: 'Setting it up, once' }),
      h('ol', {},
        h('li', { text: 'On a computer, open console.firebase.google.com and pick your project (the Magic one is fine), or make a new free one.' }),
        h('li', { text: 'Build, then Realtime Database. If there is none yet, Create Database, in Singapore, in locked mode.' }),
        h('li', { text: 'Open the Rules tab. Inside "rules", add this line next to what is already there, then Publish:' }),
        h('pre', { text: '"reader": { "$code": { ".read": true, ".write": true } }' }),
        h('li', { text: 'Copy the address at the top of the Data tab (it ends in firebasedatabase.app) and paste it above, on every device.' }),
        h('li', { text: 'Use the same sync code on every device. Anyone with the address and the code can read these books, so keep the code private.' }),
        h('li', { text: 'The free plan holds 1 GB, which is a few hundred novels, and allows 10 GB of downloads a month.' }))));
  });
}

/* sync when the reader opens, every minute while it is open, and as it goes away */
setInterval(() => { if (!document.hidden) Sync.cycle().then(ch => { if (ch && !$('lib').hidden) drawLib(); }); }, 60000);
document.addEventListener('visibilitychange', () => {
  if (!Sync.on()) return;
  if (document.hidden) Sync.push(true).catch(() => {});
  else Sync.cycle().then(ch => { if (ch && !$('lib').hidden) drawLib(); });
});
