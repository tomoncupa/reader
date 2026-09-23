'use strict';
/* The library: adding books, covers, shelves, sorting, backup, storage, settings. */

let coverUrls = [];
function onSheetClosed() { if (!$('lib').hidden) drawLib(); }

async function makeThumb(blob) {
  if (!blob) return null;
  const u = URL.createObjectURL(blob);
  const late = (p, ms) => Promise.race([p, wait(ms).then(() => { throw new Error('slow'); })]);
  try {
    // a bitmap first; an <img> for pictures a bitmap cannot take, such as SVG. Neither may hang the import.
    let src;
    try { src = await late(createImageBitmap(blob), 5000); }
    catch (e) { src = new Image(); src.src = u; await late(new Promise((ok, no) => { src.onload = ok; src.onerror = no; }), 5000); }
    const sw = src.width || src.naturalWidth, sh = src.height || src.naturalHeight;
    const w = 300, hgt = Math.round(w * (sh / sw || 1.5));
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.min(hgt, 600);
    c.getContext('2d').drawImage(src, 0, 0, w, hgt);
    return await late(new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)), 5000);
  } catch (e) { return blob.size < 200000 ? blob : null; } finally { URL.revokeObjectURL(u); }
}

async function importFiles(files) {
  let added = 0;
  for (const f of files) {
    busy('Adding ' + f.name + '…');
    try {
      const kind = await sniff(f, f.name);
      if (kind === 'backup') { await restoreBackup(f); continue; }
      const id = await fileId(f);
      const had = await DB.book(id);
      if (had && await DB.hasFile(id)) { toast('"' + had.title + '" is already in your library'); continue; }
      const book = await openBook(f, { kind, name: f.name });
      const cover = await makeThumb(await Promise.race([book.cover().catch(() => null), wait(8000).then(() => null)]));
      const meta = Object.assign(had || {}, {
        id, kind, name: f.name, title: book.title, author: book.author, ext: (f.name.split('.').pop() || kind).toLowerCase(),
        size: f.size, added: (had && had.added) || now(), t: now(), cover, count: book.count,
        shelf: (had && had.shelf) || '', finished: !!(had && had.finished), remote: false
      });
      book.close();
      await DB.putFile(id, new Blob([f], { type: f.type || '' }));
      await DB.putBook(meta);
      store.del('gone.' + id);
      Sync.mark('meta', id);
      added++;
      if (Sync.on()) Sync.upload(id).catch(e => console.warn(e));
    } catch (err) {
      alert(f.name + '\n\n' + (err.message || err));
    }
  }
  busy('');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  drawLib();
  return added;
}
function busy(t) { $('busy').hidden = !t; $('busy').textContent = t || ''; }

async function openBookById(id) {
  if (Sync.on()) await Promise.race([Sync.cycle(), wait(2500)]);
  const meta = await DB.book(id);
  if (!meta) { store.del('last'); return drawLib(); }
  let blob = await DB.file(id);
  if (!blob) {
    if (Sync.on() && meta.chunks) {
      try {
        busy('Downloading "' + meta.title + '"…');
        blob = await Sync.download(id, meta.chunks, (k, n) => busy('Downloading "' + meta.title + '": ' + Math.round(k / n * 100) + '%'));
        await DB.putFile(id, blob);
        meta.remote = false; await DB.putBook(meta);
      } catch (e) { busy(''); alert('The download failed: ' + e.message); return; }
    } else {
      alert('"' + meta.title + '" is on your other device and has not been uploaded yet. Open Sync on that device and tap Upload books.');
      return;
    }
  }
  busy('Opening "' + meta.title + '"…');
  let book;
  try { book = await openBook(blob, meta); }
  catch (e) { busy(''); alert(e.message || e); return; }
  busy('');
  await startReading(book, meta);
}

/* ---------- drawing the library ---------- */
async function drawLib() {
  const all = await DB.books();
  const has = new Set();
  await Promise.all(all.map(async b => { if (await DB.hasFile(b.id)) has.add(b.id); }));
  const q = ($('q').value || '').trim().toLowerCase();
  const shelves = [...new Set(all.map(b => b.shelf).filter(Boolean))].sort();
  const pos = id => Rows.pos(id) || {};
  const inShelf = b => S.shelf === 'all' ? true
    : S.shelf === 'reading' ? !b.finished && pos(b.id).t
    : S.shelf === 'unread' ? !b.finished && !pos(b.id).t
    : S.shelf === 'finished' ? b.finished
    : b.shelf === S.shelf;
  let list = all.filter(inShelf).filter(b => !q || (b.title + ' ' + (b.author || '')).toLowerCase().includes(q));
  const by = {
    recent: (a, b) => (pos(b.id).t || b.added) - (pos(a.id).t || a.added),
    title: (a, b) => a.title.localeCompare(b.title),
    author: (a, b) => (a.author || '~').localeCompare(b.author || '~') || a.title.localeCompare(b.title),
    added: (a, b) => b.added - a.added,
    progress: (a, b) => (pos(b.id).p || 0) - (pos(a.id).p || 0)
  };
  list.sort(by[S.sort] || by.recent);

  const chips = $('shelves');
  chips.innerHTML = '';
  for (const [v, t] of [['all', 'All'], ['reading', 'Reading'], ['unread', 'Not started'], ['finished', 'Finished'], ...shelves.map(s => [s, s])])
    chips.append(h('button', { class: 'chip' + (S.shelf === v ? ' on' : ''), text: t, onclick: () => { S.shelf = v; saveS(); drawLib(); } }));
  if (!['all', 'reading', 'unread', 'finished'].includes(S.shelf) && !shelves.includes(S.shelf)) { S.shelf = 'all'; saveS(); }
  $('sort').value = S.sort;

  coverUrls.forEach(u => URL.revokeObjectURL(u)); coverUrls = [];
  const grid = $('list');
  grid.innerHTML = '';
  $('empty').hidden = all.length > 0;
  if (all.length && !list.length) grid.append(h('p', { class: 'mut', text: 'Nothing here.' }));
  for (const b of list) {
    const p = pos(b.id);
    const local = has.has(b.id);
    let cov;
    if (b.cover) { const u = URL.createObjectURL(b.cover); coverUrls.push(u); cov = h('img', { src: u, alt: '' }); }
    else cov = h('div', { class: 'ph', text: b.title.slice(0, 40) });
    const status = b.finished ? 'Finished' : !local ? (b.chunks ? 'On another device: tap to download' : 'On another device') : p.t ? Math.floor((p.p || 0) * 100) + '% read' : 'Not started';
    const card = h('div', { class: 'card' + (local ? '' : ' away') },
      h('button', { class: 'cover', onclick: () => openBookById(b.id), 'aria-label': 'Open ' + b.title }, cov,
        h('div', { class: 'prog' }, h('i', { style: 'width:' + (b.finished ? 100 : Math.floor((p.p || 0) * 100)) + '%' }))),
      h('div', { class: 'meta' },
        h('button', { class: 'go', onclick: () => openBookById(b.id) }, h('div', { class: 't', text: b.title }), h('div', { class: 'a', text: b.author || '' }), h('div', { class: 's', text: status })),
        h('button', { class: 'dots', text: '•••', 'aria-label': 'Book options', onclick: () => bookMenu(b, local) })));
    grid.append(card);
  }
  $('syncdot').hidden = !Sync.on();
}
$('q').oninput = () => drawLib();
$('sort').onchange = () => { S.sort = $('sort').value; saveS(); drawLib(); };
$('add').onclick = () => $('file').click();
$('file').onchange = async e => { const files = [...e.target.files]; e.target.value = ''; await importFiles(files); };
$('libset').onclick = () => openLibSettings();

function bookMenu(b, local) {
  openSheet(b.title, body => {
    const it = (text, fn) => h('button', { class: 'item', text, onclick: fn });
    body.append(
      h('p', { class: 'mut', text: [b.author, (b.kind || 'epub').toUpperCase(), fmtMB(b.size || 0), 'added ' + new Date(b.added).toLocaleDateString()].filter(Boolean).join(' · ') }),
      it('Open', () => { closeSheet(true); openBookById(b.id); }),
      it(b.finished ? 'Mark as not finished' : 'Mark as finished', async () => { b.finished = !b.finished; b.t = now(); await DB.putBook(b); Sync.mark('meta', b.id); closeSheet(); }),
      it('Start again from the beginning', async () => { if (!confirm('Go back to the start of "' + b.title + '"?')) return; Rows.setPos(b.id, { ch: 0, off: -1, f: 0, p: 0, t: now() }); b.finished = false; b.t = now(); await DB.putBook(b); Sync.mark('meta', b.id); closeSheet(); }),
      h('h3', { text: 'Shelf' }));
    const shelfRow = h('div', { class: 'choices' });
    DB.books().then(all => {
      const shelves = [...new Set(all.map(x => x.shelf).filter(Boolean))].sort();
      shelfRow.append(h('button', { class: !b.shelf ? 'pri' : '', text: 'No shelf', onclick: () => setShelf('') }));
      for (const s of shelves) shelfRow.append(h('button', { class: b.shelf === s ? 'pri' : '', text: s, onclick: () => setShelf(s) }));
      shelfRow.append(h('button', { text: 'New shelf…', onclick: () => { const n = (prompt('Name the new shelf') || '').trim(); if (n) setShelf(n); } }));
    });
    const setShelf = async s => { b.shelf = s; b.t = now(); await DB.putBook(b); Sync.mark('meta', b.id); closeSheet(); };
    body.append(shelfRow);
    if (local) body.append(it('Save a copy of the book file', async () => { const blob = await DB.file(b.id); handOver(new File([blob], (b.name || b.title + '.' + (b.ext || 'epub')).replace(/[\\/:*?"<>|]/g, ''), { type: blob.type || 'application/octet-stream' })); }));
    if (local && Sync.on()) body.append(it(b.chunks ? 'Uploaded for your other devices' : 'Upload for your other devices', () => Sync.upload(b.id, (k, n) => toast('Uploading ' + Math.round(k / n * 100) + '%')).then(() => { toast('Uploaded'); closeSheet(); }, e => alert(e.message))));
    if (local) body.append(it('Remove the file from this iPad only (keep place and notes)', async () => {
      if (!b.chunks || !Sync.on()) { if (!confirm('Nothing else holds a copy of this book. Remove the file anyway?')) return; }
      await DB.delFile(b.id); b.remote = true; await DB.putBook(b); closeSheet();
    }));
    body.append(it('Delete this book', async () => {
      if (!confirm('Delete "' + b.title + '", with its place, bookmarks and highlights?' + (Sync.on() ? ' It goes from your other devices too.' : ''))) return;
      await DB.delBook(b.id);
      store.del('pos.' + b.id); store.del('marks.' + b.id);
      if (store.get('last') === b.id) store.del('last');
      store.set('gone.' + b.id, { t: now() });
      Sync.mark('meta', b.id);
      closeSheet();
    }));
  });
}

/* hands a file to the iPad: the share sheet where it exists (Save to Files), a download where not */
function handOver(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: file.name }).catch(e => { if (e.name !== 'AbortError') download(file); });
  } else download(file);
}
function download(file) {
  const u = URL.createObjectURL(file);
  const a = h('a', { href: u, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

/* ---------- backup ---------- */
async function backupAll(onStep) {
  const books = await DB.books();
  const data = { v: 1, made: now(), books: books.map(b => Object.assign({}, b, { cover: undefined })), local: {} };
  for (const k of store.keys('')) if (!/^(settings|sync|dirty|device)/.test(k)) data.local[k] = store.get(k);
  const entries = [{ name: 'reader-backup.json', blob: new Blob([JSON.stringify(data)], { type: 'application/json' }) }];
  for (const b of books) {
    const f = await DB.file(b.id);
    if (f) entries.push({ name: 'books/' + b.id, blob: f });
    if (b.cover) entries.push({ name: 'covers/' + b.id + '.jpg', blob: b.cover });
  }
  return makeZip(entries, onStep);
}
async function restoreBackup(file) {
  const z = await unzip(file);
  const data = JSON.parse(await z.text('reader-backup.json'));
  let n = 0;
  for (const b of data.books || []) {
    busy('Restoring "' + b.title + '"…');
    const had = await DB.book(b.id);
    if (!(await DB.hasFile(b.id))) {
      const blob = await z.blob('books/' + b.id, 'application/octet-stream');
      if (blob) await DB.putFile(b.id, blob);
    }
    if (!had || (b.t || 0) > (had.t || 0)) {
      const cover = await z.blob('covers/' + b.id + '.jpg', 'image/jpeg');
      await DB.putBook(Object.assign({}, b, { cover: cover || (had && had.cover) || null, remote: !(await DB.hasFile(b.id)) }));
      n++;
    }
  }
  for (const k in data.local || {}) {
    const v = data.local[k], mine = store.get(k);
    if (mine == null) store.set(k, v);
    else if (k.startsWith('pos.') && (v.t || 0) > (mine.t || 0)) store.set(k, v);
    else if (k.startsWith('marks.')) { for (const id in v) if (!mine[id] || (v[id].t || 0) > (mine[id].t || 0)) mine[id] = v[id]; store.set(k, mine); }
    else if (k === 'log') { for (const d in v) if (!mine[d] || (v[d].ms || 0) > (mine[d].ms || 0)) mine[d] = v[d]; store.set(k, mine); }
  }
  toast('Backup restored: ' + (data.books || []).length + ' books');
  return n;
}

/* ---------- settings from the library ---------- */
function openLibSettings() {
  openSheet('Settings', async body => {
    const sec = t => h('h3', { text: t });
    // add from a link
    const url = h('input', { type: 'url', placeholder: 'https://… link to an EPUB, PDF or MOBI file' });
    const fromLink = async () => {
      let u = url.value.trim();
      if (!u) return;
      const gd = u.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?id=)([\w-]+)/);
      if (gd) u = 'https://drive.google.com/uc?export=download&id=' + gd[1];
      busy('Downloading…');
      try {
        const r = await fetch(u);
        if (!r.ok) throw new Error('The site answered ' + r.status);
        const blob = await r.blob();
        let name = decodeURIComponent((new URL(u).pathname.split('/').pop() || 'book'));
        const cd = r.headers.get('content-disposition') || '';
        const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
        if (m) name = decodeURIComponent(m[1]);
        closeSheet(true);
        await importFiles([new File([blob], name, { type: blob.type })]);
      } catch (e) {
        busy('');
        alert('That link could not be downloaded here. Many sites, Google Drive included, stop other websites from fetching their files.\n\nThe way that always works: open the link in Safari, save the book to Files, then tap Add book.\n\n(' + e.message + ')');
      }
    };
    body.append(sec('Add a book from a link'), h('div', { class: 'row' }, url, h('button', { class: 'pri', text: 'Add', onclick: fromLink })),
      h('p', { class: 'mut', text: 'Books in Google Drive, Dropbox or iCloud Drive: tap Add book. The Files app lists those places once their apps are installed on the iPad (in Files, tap Browse, then the three dots, then Edit to switch them on).' }));

    // backup
    const bk = h('div');
    const makeBk = h('button', { class: 'wide', text: 'Back up everything', onclick: async () => {
      makeBk.disabled = true;
      try {
        const blob = await backupAll((k, n) => { makeBk.textContent = 'Packing ' + k + ' of ' + n + '…'; });
        const file = new File([blob], 'reader-backup-' + dayKey() + '.zip', { type: 'application/zip' });
        makeBk.textContent = 'Back up everything';
        bk.innerHTML = '';
        bk.append(h('button', { class: 'pri wide', text: 'Save backup (' + fmtMB(file.size) + ')', onclick: () => handOver(file) }),
          h('p', { class: 'mut', text: 'Choose Save to Files. To restore, tap Add book and pick this file.' }));
      } catch (e) { alert('Backup failed: ' + e.message); makeBk.textContent = 'Back up everything'; }
      makeBk.disabled = false;
    } });
    body.append(sec('Backup'), h('p', { class: 'mut', text: 'One file with every book, place, bookmark, highlight and your reading log.' }), makeBk, bk);

    // storage
    const books = await DB.books();
    const used = books.reduce((a, b) => a + (b.size || 0), 0);
    const st = h('p', { class: 'mut', text: 'Books take ' + fmtMB(used) + ' (' + books.length + ' books).' });
    body.append(sec('Storage'), st);
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      const kept = navigator.storage.persisted ? await navigator.storage.persisted() : false;
      st.textContent += ' This site uses ' + fmtMB(e.usage || 0) + ' of the ' + fmtMB(e.quota || 0) + ' the iPad allows it. ' +
        (kept ? 'The iPad has agreed to keep it.' : 'Add the reader to the Home Screen so the iPad keeps your books: Safari can clear a site\'s storage after 7 days without a visit.');
    }
    const big = books.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 5);
    for (const b of big) body.append(h('div', { class: 'sess' }, h('span', { text: b.title }), h('span', { text: fmtMB(b.size || 0) })));

    body.append(sec('More'),
      h('button', { class: 'item', text: 'Sync between devices' + (Sync.on() ? ' (on)' : ''), onclick: openSync }),
      h('button', { class: 'item', text: 'Remote buttons', onclick: openRemote }),
      h('button', { class: 'item', text: 'Text and page', onclick: openTextSettings }),
      h('button', { class: 'item', text: 'Reading log', onclick: openLog }),
      h('p', { class: 'mut', text: 'Opens EPUB, PDF, MOBI, AZW, AZW3, CBZ comics and TXT. Books bought from Kindle, Apple Books or Google Play are copy-protected and cannot open anywhere but their own apps.' }));
  });
}
