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
- `lib/`: pdf.js 3.11.174 (Mozilla, Apache 2.0) and foliate-js `mobi.js` (MIT, see `lib/FOLIATE-LICENSE`)
- `sw.js`: keeps a copy on the device so it opens with no signal

## Sync setup
In the Firebase console, Realtime Database, Rules, add inside `"rules"`:

```json
"reader": { "$code": { ".read": true, ".write": true } }
```

Then paste the database address and the same sync code into Settings, Sync between devices, on each device. Anyone with the address and the code can read the synced books.

## Working with the XTEINK X4
The X4 runs Tom's CrossPoint firmware fork (https://github.com/tomoncupa/crosspoint-reader-ble, branch `tom-remote-tweaks`), whose main menu has iPad Sync.

1. Set up sync above on the iPad.
2. iPad reader: Settings, Sync between devices, Save setup file for my X4. It saves `ipad-sync.txt` (database address, sync code).
3. X4: Network, File Transfer. Open the address it shows in Safari on the iPad and upload `ipad-sync.txt` to the top of the SD card.
4. X4 main menu: iPad Sync. It downloads EPUB and TXT books to the top of the SD card and swaps reading places by percentage, then turns WiFi off.

The iPad uploads its books by itself, one per sync, and publishes a light list at `reader/<code>/lite` for the X4. A place from the X4 is `{p, t, src: "x4"}`.
