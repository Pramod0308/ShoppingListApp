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

## What it does

Everything below works with the network switched off, which is the bar the app sets
for itself — sync and prices are the only two things that reach outside the device,
and both fail quietly rather than blocking the list. `tools/e2e.test.mjs` drives the
whole of it in a browser, so this list is what the tests assert rather than what the
UI suggests.

**Lists.** Create, rename, delete, and reorder them by dragging the handle or with
the keyboard (focus it, Space to grab, arrows to move, Space to drop). Each card
carries its item count and how long ago it changed. The header toggles between your
own order and most-recently-updated; the drag handle is taken out of reach in the
latter, because a manual order you cannot see is not one worth writing.

A list you are done with for now can be archived instead of deleted: it drops off
the home screen into an Archived section, stays intact and synced, still opens, and
comes back where it was. That is recorded against your own index rather than in the
list, so archiving something you share with a flatmate does nothing to their home
screen.

**Items.** Add one at a time, or paste a block and get a row per line. Enter inside a
row opens the next one, so a list can be written without going back to the composer.
Rows are edited in place and sync per keystroke, so two people can type in the same
row. Tick to move a row to Done; delete to move it to Deleted, which is a record
rather than a bin — anything there can be put back where it was, and Clear is the
only thing that removes it for good. Clear done and Clear all do the obvious thing
to the sections above it, and are undone the same way, one row at a time.

**Sharing.** Two links, meaning two different things. Share on a list copies a
`?join=` link that hands over that one list. Link device copies a `?link=` link that
hands over your whole index, and so every list in it. Both are adopted and stripped
from the URL on arrival, so the secret does not linger in history. Your name and
colour ride along in the document, so shared lists show who made what — there is no
account behind it.

**Cost estimate.** Estimate prices what is still to buy at all five shops — ASDA,
Aldi, Lidl, Morrisons and Sainsbury's — and lays them out as a matrix: a row per item, a
column per shop, the cheapest shop for each item picked out, and a row of totals with
the cheapest basket picked out. Every price links to that shop's own search for the
product it was matched to. Anything a shop does not stock reads `n/a`; anything that
could not be checked reads `—`. See [Cost estimate](#cost-estimate) for what that
costs and what it sends.

**Everywhere.** Dark and light themes, a timestamp toggle, and both remembered. The
web build installs as a PWA and opens offline.

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
symptom when they go subtly wrong. [Testing](#testing) has the rest.

### Sync and sharing

Each list is its own document with its own secret, and therefore its own WebRTC
room. An index document — one per user — records each list's id, secret, position
and whether it is archived, and syncs in a room derived from the device secret. That
split is what makes the two link types mean different things, and it is also why
archiving follows you between your own devices without reaching anyone you shared a
list with:

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

`SIGNALING_SERVERS` in `assets/www/sync-config.js` points at the deployment of
`signalling/` — a Cloudflare Worker backed by a Durable Object, which is what lets
every peer of a room meet in one place. Durable Objects are on the Workers free plan
(100k requests/day), and the SQLite-backed class this uses is the free-tier one. It
replaced the public y-webrtc demo servers, which are run as a courtesy, carry no
availability guarantee, and are unreachable for long stretches; if sync appears dead,
whether this host is up is the first thing to check.

```bash
cd signalling && npx wrangler deploy
```

Put the resulting `wss://shopnest-signalling.<subdomain>.workers.dev` at the front of
`SIGNALING_SERVERS`. A host outside `*.workers.dev` also needs adding to
`connect-src` in `index.html`.

It relays connection offers and nothing else: topics are SHA-256 digests of a room
secret and the offers are encrypted with that secret, so the server sees neither the
secret nor any list content, and stores nothing.

[Testing](#testing) has how to run it locally and point the test suite at it.

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

## Testing

| Command | What it covers | Needs |
| --- | --- | --- |
| `npm test` | Ordering keys, document merges, the price Worker's parsing, the comparison rules | nothing |
| `npm run test:e2e` | The whole app in a browser — see below | `npx playwright install chromium` |
| `npm run test:signalling` | The signalling worker over a real socket | a worker running (below) |
| `flutter test` | That the shell's asset manifest holds the whole bundle | the Flutter SDK |

CI runs the first three on every push and pull request, and `flutter test` in the
APK job.

`npm run test:e2e` serves `assets/www` itself and drives Chromium over it, so there
is nothing to start first. It is the only suite that can tell you whether pressing
Add puts a row on the screen, whether it is still there after a reload, or whether a
share link opens the list on the device it is sent to — the unit suites all pass
against an app that never renders. Set `CHROMIUM_PATH` to use a browser already on
the machine instead of Playwright's own.

The signalling test needs a copy of the worker running. **wrangler 3 cannot serve
it** — the Durable Object's WebSocket upgrade fails and every connection gets a 500:

```bash
cd signalling && npx wrangler@4 dev --local --port 8799
npm run test:signalling
```

`SIGNAL_URL=wss://…` points it at a deployed one instead.

## Known gaps

- There is no Settings screen. The Archive and Settings tabs that used to sit in the
  bottom navigation were removed because nothing was behind them; archiving now
  lives in a section on the home screen rather than behind a tab, and the mockups
  for both are still in `design/mockups/`.
- Deleting a list is permanent and immediate — there is no undo for it the way there
  is for an item. Archiving is the reversible option.
- Only the most recent deletions are listed, so a row that falls off the end of that
  section can no longer be put back — Clear is still the only thing that removes one
  for good, but it stops being reachable before then.
- **Aldi returns no prices**, and Lidl is expected to behave the same way: neither
  sells groceries online in the UK, so Google Shopping carries next to no listings
  for them and the lookup honestly reports "not stocked" rather than inventing a
  number. Listings are now matched on the host they link to as well as the seller
  name, which recovers any that are filed under a name the filter does not know —
  but if there are no listings at all, nothing can recover them. `debug: true`
  against the Worker shows what the search actually returns; see
  [Cost estimate](#cost-estimate).
  Reading the shops' own pages instead was tried and removed; that section has the
  detail.
- Release signing is wired to repository secrets, so a tag build fails rather than
  publishing a debug-signed APK if they are ever missing.
- The iOS target builds but has never been signed or installed on a device. CI
  compiles it with `--no-codesign`, which proves it links and nothing more.

## Cost estimate

The list view prices what is on it at all five supermarkets (ASDA, Aldi, Lidl,
Morrisons, Sainsbury's) at once and lays the answers out as a matrix, so the point
of it is comparison rather than a single number.

**That costs about five times the credits of a single-shop estimate** — one request
per shop, and Sainsbury's needs a second query when naming the shop finds nothing.
The per (item, shop) cache in `assets/www/pricing.js` is what makes it bearable:
answers are held for 7 days, so looking at the same list again, or switching which
shop the rows show, costs nothing at all.

Picking the winner is not simply the smallest total. A shop that stocks none of your
list totals £0.00, which beats every real shop — and Aldi returns nothing, so that is
the ordinary case rather than a corner. `compareStores` therefore compares coverage
first and uses price only to settle ties, the table dims a total that covers fewer
items than the others, and a row under the totals says how many of the list each one
actually priced. `tools/compare.test.mjs` is that rule written down.

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

Coverage, measured against the live API rather than assumed: **ASDA, Sainsbury's and
Morrisons return prices; Aldi does not** and reports every item as not stocked, which
matches its barely selling groceries online in the UK. Naming the shop in the query
finds it for ASDA and Morrisons; Sainsbury's returns nothing when named and is found
by a second, plain search filtered on the seller, so a miss costs one extra query and
a hit costs one.

To deploy the Worker:

```bash
cd worker && npx wrangler secret put SERPER_API_KEY && npx wrangler deploy
```

**The set of shops lives in the Worker as well as the app**, so adding one — Lidl,
most recently — takes a redeploy before it answers anything. Until then the app asks
for a store the deployed Worker does not serve and that column reads as an error
rather than as prices.

To see what the search actually returns for a shop, rather than guessing from an
empty column:

```bash
curl -s -X POST "$PRICE_API_URL" -H 'Content-Type: application/json' \
  -H 'Origin: https://pramod0308.github.io' \
  -d '{"store":"aldi","items":["milk"],"debug":true}' | head -40
```

It returns the first ten listings for both the named-shop and plain searches, with
each one's seller and link, which is how "Aldi returns nothing" was established in
the first place.

Then put the deployed URL in `PRICE_API_URL` in `assets/www/sync-config.js`. Until
that is set the button says so rather than failing. A host outside `*.workers.dev`
also needs adding to `connect-src` in `index.html`, or the browser refuses the
request.

**Item text leaves the device when the button is pressed** — only then, never in the
background, and nothing else about a list is sent. Results are cached per item and
store for 7 days in `localStorage`, so re-estimating the same list costs nothing and
works offline.

Estimates are estimates: "milk" is not a product, so each priced row shows the
listing it was matched to, linked to that shop's search for it. The lookup's own link
points at Google Shopping rather than the shop, so the link is built from the matched
product name instead — on a phone that opens the shop's own app. In the app it opens
in the system browser rather than navigating the list away.

## Licence

**None. All rights reserved.**

This is deliberate rather than an oversight: without a licence, default copyright
applies and the code may not be copied, modified or redistributed, even though the
repository is public and the app is deployed. If that should change, adding a LICENSE
file is the only step needed.
