# Shelf Snap (Photo-ISBN-LOC-Retriever)

Photograph a bookshelf → get **authors, titles, ISBNs and Library of Congress numbers (LCCNs)**,
ready to paste into [LibraryThing's Universal Import](https://www.librarything.com/import) to add
the books to your LibraryThing catalog.

## How it works

1. **Get photos** — upload one or more already-taken high-resolution photos (drag & drop or file
   picker), snap a new one with your phone camera, or capture from a webcam.
2. **Read the spines** — choose an engine:
   - **Claude AI vision** (recommended): the photo is sliced into overlapping high-resolution tiles
     and sent to the Anthropic API under *your own* API key
     ([get one here](https://console.anthropic.com/)). Best accuracy on vertical/angled spine text.
   - **Local OCR (Tesseract)**: free and fully in-browser — the photo never leaves your device —
     but much rougher on spines; expect to correct the detected titles.
3. **Review** — fix any misread titles/authors and add missed books.
4. **Look up** — each book is resolved against **Open Library** and **Google Books** to find its
   ISBN‑13, ISBN‑10 and LCCN.
   - If an ISBN/LCCN is actually printed on the spine, that wins (`spine`).
   - If a publisher is visible, the app tries to pin the exact edition (`edition`).
   - Otherwise it **guesses the most likely edition** and marks the row `guessed` — click
     *alternates* to pick a different edition.
5. **Export** — copy an ISBN list or LCCN list for LibraryThing's import page, copy the whole
   table, or download a CSV.

## Downloads

All platforms are built automatically and attached to the
[**preliminary release**](../../releases): Windows (`.exe`), macOS (`.dmg`), Linux
(`.AppImage`/`.deb`), Android (`.apk`), iOS (unsigned `.ipa` — sideload or sign yourself), and a
`shelf-snap-web.zip` static web bundle. On **ChromeOS**, install the Android APK or use the web
version as a PWA. On **iOS/Android** you can also skip the store entirely: open the web version in
the browser and *Add to Home Screen*.

## Running the web version locally

It's a static site — no build step:

```bash
npx http-server app -p 8080     # or any static file server
# then open http://localhost:8080
```

## Development

```bash
npm install          # tooling for desktop/mobile wrappers
npm start            # run the desktop (Electron) app
npm run dist         # build desktop installers for the current OS
npx cap add android && npx cap sync android   # generate the Android project
npx cap add ios && npx cap sync ios           # generate the iOS project (macOS only)
node scripts/gen-icons.mjs                    # regenerate app icons
```

CI (`.github/workflows/build-release.yml`) builds Web, Windows, macOS, Linux, Android and iOS on
every push to the release branches and publishes/updates the `v0.1.0-preview` prerelease.

## Privacy

- In **OCR mode** photos never leave your device.
- In **Claude mode** photos are sent only to the Anthropic API, under your own key (stored in your
  browser only if you tick *remember*).
- Lookups send only title/author text to Open Library and Google Books.
