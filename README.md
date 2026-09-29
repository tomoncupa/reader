# Reader

A big-type book reader for the iPad, built for reading on a treadmill. Live at https://tomoncupa.github.io/reader/

Open it in Safari and use Share, Add to Home Screen. Books are kept in the iPad's browser storage and never go into this repo.

## What it opens
EPUB (including fixed-layout), PDF (as big reflowed text, or as page pictures), MOBI, AZW, AZW3, CBZ comics and TXT. Copy-protected (DRM) books from Kindle, Apple Books or Google Play cannot be opened by any web page, and the reader says so.

## Files
- `index.html`: the page, its styles and start-up
- `js/data.js`: storage, zip reading and writing, the reading log
- `js/formats.js`: turns each kind of book into chapters
- `js/reader.js`: pages, place, menu, search, bookmarks, highlights, read aloud, auto turn, remote, touch lock
- `js/library.js`: the library, shelves, backup, settings
- `js/sync.js`: optional sync through a Firebase Realtime Database
- `js/kosync.js`: Sync with X4, the place in EPUB books through a KOReader-sync server (CrossPoint Sync)
- `lib/`: pdf.js 3.11.174 (Mozilla, Apache 2.0) and foliate-js `mobi.js` (MIT, see `lib/FOLIATE-LICENSE`)
- `sw.js`: keeps a copy on the device so it opens with no signal

## Sync setup
In the Firebase console, Realtime Database, Rules, add inside `"rules"`:

```json
"reader": { "$code": { ".read": true, ".write": true } }
```

Then paste the database address and the same sync code into Settings, Sync between devices, on each device. Anyone with the address and the code can read the synced books.

## Sync with X4 (any CrossPoint firmware, including the stock and `tom-safe` builds)
Keeps the place in an EPUB the same on the iPad and the X4 through CrossPoint Sync (https://sync.crosspointreader.com, KOReader-sync compatible). Only the place travels; books still go onto the X4 by File Transfer, and the Firebase sync below still carries books, highlights and the reading log.

1. iPad reader: Settings, Sync with X4. Create account (or Sign in).
2. X4: Settings, System, KOReader Sync. Sync Server URL `https://sync.crosspointreader.com`, the same Username and Password, Authenticate. Document Matching: either.
3. X4, in a book: menu, Sync Progress. Apply remote takes the iPad's place; Upload local sends the X4's.

How it matches the X4 (from `lib/KOReaderSync` in the firmware):
- A book is named by MD5 of its file name, or KOReader's partial MD5 (1 KB at 0, 1 KB, 4 KB … 1 GB). The iPad sends and asks under both, so either X4 setting works.
- The percentage is the X4's: unzipped sizes of every spine item (linear or not, paths as written), `(sizes before + share of this one) / all`. The iPad sends a place 16 bytes into a chapter at its very start, because the X4 reads a place exactly on a chapter edge as the end of the chapter before.
- The iPad sends at most every 30 s while pages turn, and when it leaves a book or goes to the background. It asks when a book opens (waits up to 3 s), when it comes back to the front, and once a minute while a book sits open with no page turned. The server's newest row wins; a place from the X4 is taken only if no page turned on the iPad since.
- Stored per book in `localStorage` as `ko.<id>` (the two names and sizes); the account is `kosync` (name, server, MD5 of the password, never the password). Backups leave out every `ko*` key.

## Working with the XTEINK X4
The X4 runs Tom's CrossPoint firmware fork (https://github.com/tomoncupa/crosspoint-reader-ble, branch `tom-remote-tweaks`), whose main menu has iPad Sync.

1. Set up sync above on the iPad.
2. iPad reader: Settings, Sync between devices, Save setup file for my X4. It saves `ipad-sync.txt` (database address, sync code).
3. X4: Network, File Transfer. Open the address it shows in Safari on the iPad and upload `ipad-sync.txt` to the top of the SD card.
4. X4 main menu: iPad Sync. It downloads EPUB and TXT books to the top of the SD card and swaps reading places by percentage, then turns WiFi off.

The iPad uploads its books by itself, one per sync, and publishes a light list at `reader/<code>/lite` for the X4. A place from the X4 is `{p, t, src: "x4"}`.
