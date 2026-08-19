# ShopIt

Shopping lists that work offline and sync straight between devices — no account, no
server holding your data.

The app is a static web bundle in [`assets/www`](assets/www). It ships two ways:

- **Android/iOS** — a Flutter shell (`lib/main.dart`) that serves the bundle from a
  loopback HTTP server and shows it in a WebView. There is no Flutter UI beyond that.
- **Web** — the same bundle published to GitHub Pages, installable as a PWA.

Lists live in [Yjs](https://github.com/yjs/yjs) documents persisted to IndexedDB and
synced peer-to-peer over WebRTC, so two devices reconcile their edits without either
one being authoritative and without anything passing through a server that can read
them.

## Getting started

```bash
npm install && npm run build   # build the web bundle
npm run serve                  # http://localhost:5173
```

For the mobile shell you also need the [Flutter SDK](https://docs.flutter.dev/get-started/install):

```bash
flutter pub get && flutter run
```

## Web bundle

Nothing in `assets/www` may be fetched at runtime — the app has to start with no
network — so every third-party piece is built into the bundle and committed.

| Committed output | Built from | Command |
| --- | --- | --- |
| `assets/www/vendor/sync.js` | `web-src/vendor-entry.js` (yjs, y-webrtc, y-indexeddb) | `npm run build:vendor` |
| `assets/www/styles.css` | `web-src/styles.css` + `tailwind.config.js` | `npm run build:css` |
| `assets/www/sw.js` | whatever is in `assets/www` | `npm run build:sw` |
| `assets/www/fonts/` | Google Fonts (Geist, Material Symbols) | `npm run fonts` |
| `assets/www/icons/` | `web-src/icon.svg`, `web-src/icon-maskable.svg` | `npm run icons` |

`npm run build` regenerates the first three; run it after touching anything in
`web-src/` or `tailwind.config.js`. CI fails if the committed bundle does not match
its sources. `npm run watch:css` does the CSS in a loop while working on markup.

`npm run fonts` is separate because it needs network access. It subsets Material
Symbols to exactly the icons referenced in `index.html` and `app.js` — re-run it
after introducing a new icon, or it will render as its literal ligature name.
`npm run icons` is separate because it needs macOS.

To exercise the bundle in a browser the way the WebView loads it:

```bash
npm run serve
```

Adding a new directory under `assets/www/` also needs an entry in `pubspec.yaml`
— Flutter's asset directories are not recursive.

### Data model

Every list and item is its own `Y.Map`, and its editable text is a `Y.Text`, so two
devices editing different fields of the same row — or typing in the same row — both
keep their edit. Rows are ordered by a fractional index string
(`assets/www/order-key.js`) rather than a timestamp: ordering no longer depends on
two devices agreeing about the clock, and a drag writes one field on one row instead
of renumbering every sibling. Documents still in the older plain-object shape are
converted on load.

```bash
npm test
```

covers the ordering keys and the merge behaviour, the two parts with no visible
symptom when they go subtly wrong.

### Sync and sharing

Each list is its own document with its own secret, and therefore its own WebRTC
room. An index document — one per user — records each list's id, secret and
position, and syncs in a room derived from the device secret. That split is what
makes the two link types mean different things:

| Link | Carries | Built from |
| --- | --- | --- |
| `?join=<listId>~<secret>` | one list | the list's own secret |
| `?link=<deviceSecret>` | the index, and so every list in it | the device secret |

A room name is always the SHA-256 digest of the relevant secret, so the signalling
server sees only a hash. The secret itself never leaves the device except in a link
the user deliberately copies, and y-webrtc uses it to encrypt the connection
handshake. Both parameters are adopted and then stripped from the URL, so secrets do
not linger in history.

Links are built against `PUBLIC_BASE_URL` rather than `location.origin`: inside the
mobile shell the page is served from a loopback server, and a `localhost` URL means
nothing on the device it gets sent to. Point it at wherever the web build is
published.

Documents from before the split — both the single document that held every list, and
the plain-object shape before that — are converted on first load.

**The signalling servers in `assets/www/sync-config.js` default to the public
y-webrtc demo servers, which are frequently unreachable.** `signalling/` is a
replacement you can run yourself — a Cloudflare Worker backed by a Durable Object,
which is what lets every peer of a room meet in one place. Durable Objects are on
the Workers free plan (100k requests/day), and the SQLite-backed class this uses is
the free-tier one.

```bash
cd signalling && npx wrangler deploy
```

Put the resulting `wss://shopnest-signalling.<subdomain>.workers.dev` at the front of
`SIGNALING_SERVERS`. A host outside `*.workers.dev` also needs adding to
`connect-src` in `index.html`.

It relays connection offers and nothing else: topics are SHA-256 digests of a room
secret and the offers are encrypted with that secret, so the server sees neither the
secret nor any list content, and stores nothing.

To run it locally and test it:

```bash
cd signalling && npx wrangler dev --local --port 8799
```

```bash
node tools/signalling.test.mjs
```

Sync is an enhancement, never a dependency: if it cannot start, the failure is logged
and the app runs offline as normal.

### How the shell serves it

The bundle is not opened as a `file://` URL. `main.dart` starts an
`InAppLocalhostServer` bound to `127.0.0.1:8737` with `assets/www` as its document
root, and the WebView loads `http://localhost:8737/`. A real origin is what lets
the WebView's file-URL access settings stay off, and what makes ES modules, the
history API and persistent storage behave as they do in a browser.

`kLocalServerPort` is effectively part of the on-disk format: changing it changes
the page's origin, which orphans everything already saved in IndexedDB under the
old one.

## Android release signing

Release builds are signed from `android/key.properties`, which is not committed:

```
storeFile=upload-keystore.jks
storePassword=…
keyAlias=upload
keyPassword=…
```

Put the keystore next to it at `android/upload-keystore.jks`. Without that file the
release build falls back to the debug key and Gradle prints a warning — fine for
`flutter run --release`, never for distribution.

CI writes both files from repository secrets on tag builds, and the job fails
rather than publishing an unsigned APK. The secrets it expects are
`ANDROID_KEYSTORE_BASE64` (`base64 -i upload-keystore.jks`),
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.

## Publishing the web app

`.github/workflows/pages.yml` builds the bundle and deploys it to GitHub Pages on
every push to `main`. Enable it once under **Settings → Pages → Source: GitHub
Actions**.

The published origin is also what share links point at — see `PUBLIC_BASE_URL` in
`assets/www/sync-config.js`, and change it if the site moves or gains a custom
domain.

The service worker precaches the whole bundle, so the installed web app opens
offline. It is deliberately **not** registered on `localhost`: inside the mobile
shell the bundle already comes off disk, and a cache in front of it would serve the
previous build after an app update.

## Known gaps

- There is no archive: deleting a list hides it in the Deleted section, and Clear
  removes it for good. The Archive and Settings tabs that used to sit in the bottom
  navigation were removed because nothing was behind them; the mockups for them are
  in `design/mockups/`.
- **The cost estimate does not currently return prices.** Reading a shop's own page
  was measured against all four: ASDA serves a Cloudflare bot challenge, Sainsbury's
  and Aldi return Access Denied, and Morrisons loads but ignores the search term and
  publishes no prices in its structured data. The lookup now reports "blocked" or
  "no price found" rather than guessing — an earlier fallback that took the first
  £ on the page reported £1 for everything. Setting `PRICE_API_URL` to the Worker in
  `worker/` is the route that does work.
- Release signing is wired to repository secrets, so a tag build fails rather than
  publishing a debug-signed APK if they are ever missing.

## Licence

**None. All rights reserved.**

This is deliberate rather than an oversight: without a licence, default copyright
applies and the code may not be copied, modified or redistributed, even though the
repository is public and the app is deployed. If that should change, adding a LICENSE
file is the only step needed.

## Cost estimate

The list view can price what is on it against one supermarket (ASDA, Aldi,
Morrisons, Sainsbury's) and flag anything that store does not stock.

None of those retailers publish a price API, a browser cannot call their sites (no
CORS), and a static bundle cannot hold a key — so `worker/` is a Cloudflare Worker
that holds one and answers a single question: what does this product cost at this
shop. Prices come from Google Shopping results via [Serper.dev](https://serper.dev/) —
2,500 credits free, then about $0.30 per 1,000 queries. Matching the chosen store
against a listing's seller is what produces the availability flag.

Reading the shops' own pages from the mobile shell was tried and removed. Measured
against all four: ASDA answers with a Cloudflare bot challenge, Sainsbury's and Aldi
with Access Denied, and Morrisons loads but ignores the search term entirely and
publishes no prices in its structured data. Having the shops' apps installed does not
help either — the platforms sandbox apps from one another, so nothing can read
another app's data or screen.

An API key cannot ship in a static bundle, so `worker/` is a Cloudflare Worker that
holds the key and answers one narrow question — what does this product cost at this
shop. To deploy it:

```bash
cd worker && npx wrangler secret put SERPER_API_KEY && npx wrangler deploy
```

Then put the deployed URL in `PRICE_API_URL` in `assets/www/sync-config.js`. Until
that is set the button says so rather than failing. A host outside `*.workers.dev`
also needs adding to `connect-src` in `index.html`, or the browser refuses the
request.

**Item text leaves the device when the button is pressed** — only then, never in the
background, and nothing else about a list is sent. Results are cached per item and
store for 7 days in `localStorage`, so re-estimating the same list costs nothing and
works offline.

Estimates are estimates: "milk" is not a product, so the matched listing's title is
shown on each price. Aldi is thinly represented in shopping results because its UK
site is largely a marketing site, so it will flag unavailable more often than the
others.
