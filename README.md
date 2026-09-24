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

**Who added what.** Every row says who put it there and when — `Added by Priya 2m
ago` — from the name in the profile button, which rides along in the document rather
than in any account. On a shared list each person also gets a colour, shown as a dot
on the rows they added. Names are self-asserted: anyone holding a share link can
already edit everything in the list, so this is honest labelling among people who
trust each other, not proof of identity.

**Sync.** Two halves, because one of them alone is not enough.

Devices talk to each other directly over WebRTC when they can: fast, and no server
involved. But peers only meet while both are awake, so on its own that means a change
made while the other phone is in a pocket goes nowhere. The **relay** is the other
half — a room on the signalling worker that keeps updates until the device that missed
them turns up. Add bread on one phone, close it, open the other tomorrow: it is there.

What the relay stores is encrypted with the room secret, which lives on the devices
and in the share link and never reaches the server. The room name is a digest of that
same secret under its own label, so the relay cannot line its rooms up with the
signalling server's topics. Be clear about what is given up, though: the signalling
worker genuinely sees nothing, and the relay sees shapes — how many updates of what
size belong together, and when. It cannot read them. `RELAY_SERVER = ''` in
`sync-config.js` turns it off and leaves the app exactly as peer-to-peer as it was.

A server that cannot read the updates cannot merge them either, so the log is
append-only and clients are asked to collapse it: a snapshot is one device's whole
document, and it replaces every update it covers.

**Joining by paste.** A link someone sends you works when you tap it — but on a phone
with this installed, a link opened from a chat app often lands in a different browser
than the one holding your lists, and the list is then adopted somewhere you are not
looking. **Paste a list link to join** on the home screen puts it where you already
are. It takes the whole URL or the bare token, and a device link pasted there is named
rather than adopted, because that one carries every list.

**Sharing.** Two links, meaning two different things. Share on a list copies a
`?join=` link that hands over that one list. Link device copies a `?link=` link that
hands over your whole index, and so every list in it. Both are adopted and stripped
from the URL on arrival, so the secret does not linger in history. Your name and
colour ride along in the document, so shared lists show who made what — there is no
account behind it.

**Cost estimate.** Estimate prices what is still to buy at all four shops — ASDA,
Morrisons, Sainsbury's and Tesco — and lays them out as a matrix: a row per item, a
column per shop, the cheapest shop for each item picked out, and a row of totals with
the cheapest basket picked out. Each price carries the product it is actually for,
because four shops' prices for four different paneers is not a comparison. Where a
shop's nearest listing is not what you searched for, that name is marked in red and
the headline says so rather than presenting it as the cheapest way to buy what you
asked for. Tapping a price opens that product's own page at that shop. Anything a
shop does not stock reads `n/a`; anything that could not be checked reads `—`.

An estimate stays put: it is saved against its list, so leaving for the home screen
and coming back shows it again without spending another search. Because it is a
photograph rather than a live reading, a line above the table says whether it still
matches the list — `Up to date`, or `Out of date · 2 added, 1 removed since` — and a
row priced for something no longer on the list is struck through rather than left
looking current. See [Cost estimate](#cost-estimate) for what that costs and what it
sends.

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

## Continuous integration

Every push and pull request runs the two checks that can actually fail on a change to
this repo: the web bundle (unit suites, end-to-end suite, and that the committed
bundle matches a fresh build) and the signalling worker.

**The Android and iOS builds do not run on every push.** They are the slow half of a
run — the iOS one on a macOS runner, which bills at ten times the rate — and what they
prove is that the Flutter shell still compiles around the bundle, which a change to
`assets/www` does not put at risk. They run on a `v*` tag, where the release is
actually cut and signed, and on `workflow_dispatch` when you want one on demand.

The trade is worth naming: a change that breaks the shell itself — `pubspec.yaml`,
anything under `android/` or `ios/` — will now get through CI and fail at tag time
instead. Run the workflow by hand after touching those.

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

## Passcode

The app asks for a passcode before it starts anything — no store, no sync, no price
lookups. Two things to be clear about:

- **It is a door, not a safe.** The lists live in the browser's IndexedDB either way.
  Anyone holding an unlocked phone, or willing to open the developer tools on it, can
  read them whatever the lock screen says.
- **What it really protects is the price service**, which spends money per search.
  CORS decides who may *read* a reply, not who may cause the request — any client
  that is not a browser ignores it — so before this the worker was an open wallet to
  anyone who knew the URL.

The passcode is never stored and never sent. The app sends a digest of it, and the
worker compares that against the digest of its own copy, so nothing in the shipped
bundle helps anyone guess it. Set it on the worker and turn the flag on together:

```bash
cd worker && npx wrangler secret put APP_PASSCODE   # type the passcode
# assets/www/sync-config.js: export const REQUIRE_PASSCODE = true;
```

**Both halves matter.** With `REQUIRE_PASSCODE` on and no secret set, the worker waves
everyone through and the lock screen opens to any passcode at all. With the secret set
and the flag off, the app cannot price anything, because it sends no token. A worker
with no `APP_PASSCODE` behaves exactly as it did before — turning the gate on is a
decision, not something a deploy does to you.

It is asked once per device and then remembered; `shopitLock()` in the console is the
way back out. Changing the passcode means setting the secret again and re-unlocking
every device.

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
- **The discounters cannot be priced at all**, and are no longer offered. Measured
  against the live API: a search naming Aldi returned ten listings and not one was
  Aldi's — Sainsbury's, Iceland, Ocado, Costco, Waitrose and four corner shops — and
  a plain search found neither Aldi nor Lidl. Neither sells groceries online in the
  UK, so Google Shopping has nothing of theirs to index, and no query or matching
  rule can recover what is not there. Tesco took their place; the same measurement
  found it three times over. `debug: true` against the Worker is how to re-check
  that; see [Cost estimate](#cost-estimate).
  Reading the shops' own pages instead was tried and removed; that section has the
  detail.
- **Product-page resolution has only been tested against stubs.** The Worker's
  `product` path is covered by `tools/pricing.test.mjs` for what it does with a
  result set, and the tap-through by `tools/e2e.test.mjs` — but no test has seen what
  Google actually returns for `"<product> site:tesco.com"`, because the sandbox this
  was built in cannot reach either. How often it lands on the product rather than a
  category page is therefore unmeasured. Tapping a few prices after a deploy is the
  check; the fallback to the shop's search means a bad answer is a less precise link
  rather than a broken one.
- **There is still no TURN server.** The relay makes this far less painful — two
  phones that cannot reach each other directly now sync through it rather than not at
  all — but a direct peer connection between two devices on mobile data will often
  still fail, so those changes take the slower path.
- **A relay room is never garbage collected.** A list nobody opens again keeps its
  snapshot on the server for good; there is no expiry and no way to delete a room.
- The passcode is remembered per device with no way to change it from the UI, and
  rotating it means re-unlocking every device by hand.
- Release signing is wired to repository secrets, so a tag build fails rather than
  publishing a debug-signed APK if they are ever missing.
- The iOS target builds but has never been signed or installed on a device. CI
  compiles it with `--no-codesign`, which proves it links and nothing more.

## Cost estimate

The list view prices what is on it at all four supermarkets (ASDA, Morrisons,
Sainsbury's, Tesco) at once and lays the answers out as a matrix, so the point of
it is comparison rather than a single number.

**That costs about four times the credits of a single-shop estimate** — one request
per shop, and a second for any shop whose first pass did not match everything asked
for (Sainsbury's needs one almost always, since naming it finds nothing at all).
Three things keep that bearable, all in `assets/www/pricing.js`:

- answers are cached per (item, shop) for 7 days, so looking at the same list again,
  or switching which shop the rows show, costs nothing at all. **Refresh**, above the
  table, asks every shop again and ignores that cache — without it a wrong or stale
  answer has no way out but the developer tools, which is exactly what happened when
  the store filter was fixed and every device that had estimated that week went on
  being served the old matches. The cache key carries a version for the same reason:
  bumping it orphans answers whose shape no longer matches what the worker returns;
- the matrix itself is saved per list under `shopnest-matrix`, so leaving the list
  and coming back redraws the saved answer rather than buying it again — the ten most
  recent lists are kept, and a deleted list takes its estimate with it;
- a product's own page is only looked up when someone actually taps a price, not for
  every cell of the table.

All four shops are priced at once, and each one writing the cache back has to
re-read it first: saving the copy taken when that shop started means the last to
finish erases the other three, so an estimate pays for four shops and keeps one and
the next look at the same list buys them all again. Nothing about that is visible —
the prices on screen are right, they are simply not there next time —
so `tools/compare.test.mjs` asserts every shop survives the others writing.

Saved prices are kept out of the synced document deliberately. They are one person's
lookup at one moment, and syncing them would push a stale estimate onto everyone
else's screen.

Because a saved estimate can go on being displayed long after the list has moved on,
`matrixFreshness` compares the items it was generated for against the list as it is
now and the table says which it is. Renaming an item counts: same ids, same count,
different products — comparing lengths alone would call that fresh and quote the
price of something else entirely.

Matching the *product* is a separate problem from matching the shop, and for a while
only the second was being done: the Worker took the first listing from the right
retailer, whatever it was. Searching for "Apetina Paneer" therefore came back with
each shop's own-brand paneer, at four shops out of four — Google ranks by its own
idea of relevance, and a shop's own brand routinely outranks the brand someone typed.
Every candidate from the shop is now scored on how much of the search its title
contains, and the best-matching one wins rather than the first. Whatever it could not
find comes back in `missing`, which is what lets the table mark a near miss instead of
passing it off as the product.

Naming the shop in the query makes that worse, not better — it is exactly what pushes
its own brand up the results — so a first pass that did not find everything asked for
is retried without the shop name. That is where the branded listing shows up. It costs
a second search only when the first pass fell short; an exact match on the first pass
still costs one.

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
listing it was matched to, and tapping it opens that product at that shop.

Getting there takes a second lookup. Every link the shopping API returns points at
`google.com/search` rather than at the retailer — measured, not assumed — so the
Worker answers a separate question, "where does this product live at this shop", with
a web search restricted to that shop's own domain, and prefers a result under its
product path. That costs one search, which is why it happens on a tap rather than for
every cell: resolving the whole matrix up front would buy a search for every
(item, shop) pair whether or not anyone ever followed one. Answers are cached for 30
days, since a product URL changes when a shop rebuilds its site, not every week.

The link on the page is the shop's own search for the matched product, so it works
with the lookup down, offline, or before the resolve has answered — the tab opens
first and lands on the product if it is found, on that search if it is not. On a
phone either one opens the shop's own app, because the apps claim these links; in the
app they open in the system browser rather than navigating the list away.

## Licence

**None. All rights reserved.**

This is deliberate rather than an oversight: without a licence, default copyright
applies and the code may not be copied, modified or redistributed, even though the
repository is public and the app is deployed. If that should change, adding a LICENSE
file is the only step needed.
