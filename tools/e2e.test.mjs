#!/usr/bin/env node
// End-to-end test of the web bundle: `npm run test:e2e`.
//
// The other suites check pieces in isolation — ordering keys, document merges, the
// price Worker's parsing. None of them can tell you whether pressing Add puts a row
// on the screen, whether it is still there after a reload, or whether a share link
// opens the list on the device it is sent to. That needs the real bundle in a real
// browser with real IndexedDB, which is what this does.
//
// It serves assets/www itself and drives Chromium over it, so there is nothing to
// start first. The browser comes from `npx playwright install chromium`; set
// CHROMIUM_PATH to use one that is already on the machine.
//
// Peer sync is deliberately out of scope: it needs two devices and a reachable
// signalling server, and tools/signalling.test.mjs covers the server half. What is
// tested here is everything that must work with no network at all — which is the
// bar the app sets for itself.

import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { STORES } from '../assets/www/pricing.js';

const PORT = Number(process.env.E2E_PORT || 5199);
const BASE = `http://localhost:${PORT}/`;
// Where share links point. The app builds them from PUBLIC_BASE_URL rather than
// location.origin, so a link has to be rewritten to be followed locally.
const PUBLIC = 'https://pramod0308.github.io/ShoppingListApp/';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label} ${detail && `— ${detail}`}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

/* ---------- the static server ---------- */
const server = spawn(process.execPath, [new URL('serve.mjs', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
// Registered before anything can throw, including the startup wait below: a failing
// run used to leave the server behind holding the port, so the next run died with
// EADDRINUSE — an error about the port rather than about the check that broke.
process.on('exit', () => server.kill());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { server.kill(); process.exit(1); });
}

await new Promise((resolve, reject) => {
  server.stdout.once('data', resolve);
  server.once('error', reject);
  setTimeout(() => reject(new Error('serve.mjs did not start')), 10_000);
});

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);

// Anything thrown on the page is a failure in its own right: the app is expected to
// survive with no network, so an unhandled rejection is never "just the environment".
const pageErrors = [];
const OFFLINE_NOISE = /WebSocket|ERR_TUNNEL|ERR_NAME|ERR_FAILED|Failed to load resource|net::/;

// Every request that tried to leave the bundle, and none of them are allowed out.
//
// The run has to mean the same thing on a laptop with wifi as on a CI runner, so the
// network is cut here rather than left to the environment — otherwise the estimate
// reaches the real Worker from CI, spends the account's search credits on every
// push, and fails on CORS besides, because this server's port is not one the Worker
// allows. Cutting it is also what makes the check below an assertion rather than an
// accident: the app claims to start with nothing fetched, and this proves it.
const blocked = [];

// Set to a (store, items) => payload function to answer the price Worker from a
// fixture; null leaves it blocked, which is the offline path the app must survive.
let priceFixture = null;
// The same, for "where is this product's page" — and a record of every such ask, so
// the test can prove the click resolved rather than just guessing a URL.
let productFixture = null;
const resolveAsks = [];

async function openPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !OFFLINE_NOISE.test(m.text())) pageErrors.push(m.text());
  });
  // Routed on the context rather than the page: following a price opens a new tab,
  // and a page-level route would let that tab reach the real internet.
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    blocked.push(url);
    // The comparison matrix needs four shops' answers to have anything to compare,
    // and the real Worker can neither be reached from CI nor spent on every push.
    // When a fixture is armed the Worker is answered from it — still without a
    // packet leaving the browser — so the matrix is tested against known numbers.
    if (priceFixture && /workers\.dev/.test(url)) {
      const body = JSON.parse(route.request().postData() ?? '{}');
      // Following a price asks the same Worker a different question: where is this
      // product's own page. Answered from the fixture so the click can be tested
      // without a search credit or a packet.
      if (typeof body.product === 'string') {
        resolveAsks.push(body);
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ url: productFixture ? productFixture(body.store, body.product) : null }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(priceFixture(body.store, body.items ?? [])),
      });
    }
    return route.abort();
  });
  // Sockets do not go through page.route, and y-webrtc opens one on startup. Handling
  // it without connecting upstream is what keeps CI off the real signalling server.
  await page.routeWebSocket(/.*/, () => {});
  // Neither dialog can be answered in a headless run, and both gate real behaviour
  // (delete, purge, the profile name), so they are answered from the test instead.
  await page.addInitScript(() => {
    window.prompt = (_msg, def) => window.__promptReply ?? def;
    window.confirm = () => window.__confirmReply !== false;
  });
  return page;
}

const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await openPage(context);

const rows = (sel) => page.$$eval(`${sel} li`, (l) => l.length);
const texts = (sel) => page.$$eval(`${sel} li input.text`, (l) => l.map((i) => i.value));
const settle = (ms = 500) => page.waitForTimeout(ms);
const reload = async () => {
  await page.reload({ waitUntil: 'networkidle' });
  await settle(1200);
};
// A row has more than one button now, and the restore one is hidden until the row
// is deleted — so clicking "the button" would wait on the wrong element forever.
const DELETE_ITEM = 'button[aria-label="Delete this item"]';
const RESTORE_ITEM = 'button[aria-label="Put this item back on the list"]';
// Same for a list card: nth-of-type broke the moment the archive buttons landed
// between share and delete, so these are addressed by label too.
const SHARE_LIST = 'button[aria-label="Share this list"]';
const ARCHIVE_LIST = 'button[aria-label="Archive this list"]';
const UNARCHIVE_LIST = 'button[aria-label="Put this list back on the home screen"]';
const DELETE_LIST = 'button[aria-label="Delete this list"]';

const clipboard = () => page.evaluate(async () => {
  try { return await navigator.clipboard.readText(); } catch { return ''; }
});

await page.goto(BASE, { waitUntil: 'networkidle' });
await settle(1200);

/* ---------- it starts ---------- */
check('home shows the empty state', (await page.textContent('#listsGrid')).includes('Nothing here yet'));
// Nothing in assets/www may be fetched at runtime — fonts, styles and the sync
// vendor bundle are all committed precisely so the app opens with no network.
check('the app starts without fetching anything', blocked.length === 0, blocked.join(' | '));
// The shell serves the bundle off disk already; a cache in front of it would serve
// the previous build after an app update, so sw.js must stay unregistered here.
check('no service worker on localhost',
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length === 0));

/* ---------- lists ---------- */
await page.fill('#newListName', 'Weekly shop');
await page.click('#createListBtn');
await settle(600);
check('creating a list opens it', await page.isVisible('#listView') && !(await page.isVisible('#home')));
check('the new list keeps its name', (await page.inputValue('#listName')) === 'Weekly shop');
check('the url carries the list id', /\?list=/.test(page.url()), page.url());

/* ---------- adding ---------- */
await page.fill('#itemInput', 'Milk');
await page.click('#addBtn');
await settle(300);
check('Add puts a row on the list', (await rows('#list')) === 1);

await page.fill('#itemInput', 'Bread');
await page.press('#itemInput', 'Enter');
await settle(300);
check('Enter adds a row too', (await rows('#list')) === 2);

// Pasting a shopping list in one go is the whole reason the composer is a textarea.
await page.evaluate(() => {
  const ta = document.getElementById('itemInput');
  ta.value = 'Eggs\nButter\nApples';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#addBtn');
await settle(400);
check('a pasted block adds one row per line', (await rows('#list')) === 5, `${await rows('#list')} rows`);
check('the remaining count follows', (await page.textContent('#remaining')).trim() === '5 remaining',
  await page.textContent('#remaining'));

/* ---------- editing, and whether any of it survives ---------- */
const firstRow = '#list li:first-child input.text';
const original = await page.inputValue(firstRow);
await page.click(firstRow);
await page.fill(firstRow, `${original} (semi-skimmed)`);
await settle(400);
await reload();
check('an edit survives a reload', (await page.inputValue(firstRow)) === `${original} (semi-skimmed)`,
  await page.inputValue(firstRow));
check('the rows survive a reload', (await rows('#list')) === 5);

// Enter inside a row is how you write a list without returning to the composer.
await page.click(firstRow);
await page.press(firstRow, 'Enter');
await settle(500);
check('Enter in a row inserts one below', (await rows('#list')) === 6, `${await rows('#list')} rows`);
check('the inserted row takes focus',
  (await page.evaluate(() => document.activeElement?.className || '')).includes('text'));

// Clearing up the blank row is itself a soft delete, so purge before counting below.
// The selector is passed in: this body runs in the page, where it is not in scope.
await page.evaluate((sel) => {
  const blank = [...document.querySelectorAll('#list li')]
    .find((r) => r.querySelector('input.text').value === '');
  blank?.querySelector(sel)?.click();
}, DELETE_ITEM);
await settle(400);
await page.evaluate(() => { window.__confirmReply = true; });
await page.click('#purgeDeleted');
await settle(400);

/* ---------- done ---------- */
await page.click('#list li:first-child input[type=checkbox]');
await settle(500);
check('ticking moves the row to Done',
  (await rows('#doneList')) === 1 && (await rows('#list')) === 4,
  `done=${await rows('#doneList')} active=${await rows('#list')}`);
check('the Done heading appears', await page.isVisible('#doneSection'));
check('the done count is right', (await page.textContent('#doneCount')).trim() === '1');

await page.click('#doneList li:first-child input[type=checkbox]');
await settle(500);
check('unticking brings it back', (await rows('#list')) === 5);
check('the Done heading goes away when empty', !(await page.isVisible('#doneSection')));

/* ---------- deleting ---------- */
const deletedText = await page.inputValue('#list li:first-child input.text');
await page.click(`#list li:first-child ${DELETE_ITEM}`);
await settle(500);
check('deleting moves the row to Deleted',
  (await rows('#deletedList')) === 1 && (await rows('#list')) === 4,
  `deleted=${await rows('#deletedList')} active=${await rows('#list')}`);
check('the Deleted heading appears', await page.isVisible('#deletedSection'));
// A deleted row is a record, not a control — except for putting it back.
check('a deleted row cannot be edited',
  await page.evaluate(() => document.querySelector('#deletedList li input.text').readOnly));

/* ---------- putting one back ---------- */
// Delete is one tap and asks nothing, so it has to be reversible to be honest.
check('a deleted row offers to go back', await page.isVisible(`#deletedList li ${RESTORE_ITEM}`));
check('an active row does not', !(await page.isVisible(`#list li:first-child ${RESTORE_ITEM}`)));

const orderBeforeDelete = await texts('#list');
await page.click(`#deletedList li:first-child ${RESTORE_ITEM}`);
await settle(600);
check('restoring returns the row to the list',
  (await rows('#list')) === 5 && (await rows('#deletedList')) === 0,
  `active=${await rows('#list')} deleted=${await rows('#deletedList')}`);
check('the Deleted heading goes away when empty', !(await page.isVisible('#deletedSection')));
// It keeps its order key while deleted, so it comes back where it was.
check('the restored row comes back in its old place',
  (await texts('#list'))[0] === deletedText,
  `expected ${deletedText} first, got ${(await texts('#list'))[0]}`);
check('the restored row is editable again',
  await page.evaluate(() => document.querySelector('#list li:first-child input.text').readOnly === false));
await reload();
check('the restore survives a reload',
  (await rows('#list')) === 5 && (await rows('#deletedList')) === 0);

// Clear done and Clear all soft-delete too, so restore is their undo as well — and
// a restored row keeps its done flag rather than coming back as outstanding.
await page.click('#list li:first-child input[type=checkbox]');
await settle(500);
await page.click(`#doneList li:first-child ${DELETE_ITEM}`);
await settle(500);
await page.click(`#deletedList li:first-child ${RESTORE_ITEM}`);
await settle(600);
check('a restored row keeps its done flag',
  (await rows('#doneList')) === 1 && (await rows('#list')) === 4,
  `done=${await rows('#doneList')} active=${await rows('#list')}`);
await page.click('#doneList li:first-child input[type=checkbox]');
await settle(500);

// Delete one again so the purge below has something to remove.
await page.click(`#list li:first-child ${DELETE_ITEM}`);
await settle(500);
await page.evaluate(() => { window.__confirmReply = true; });
await page.click('#purgeDeleted');
await settle(500);
check('Clear empties the Deleted section', (await rows('#deletedList')) === 0);
check('and what Clear removed does not come back', (await rows('#list')) === 4,
  `${await rows('#list')} rows`);

/* ---------- the two header toggles ---------- */
const metaShown = () => page.evaluate(() =>
  [...document.querySelectorAll('#list .metaRow')].some((e) => e.offsetParent !== null));
const metaWas = await metaShown();
await page.click('#toggleDates');
await settle(300);
check('the timestamp toggle works', (await metaShown()) !== metaWas);
await page.click('#toggleDates');
await settle(300);

const themeWas = await page.getAttribute('html', 'class');
await page.click('#themeToggle2');
await settle(300);
const themeNow = await page.getAttribute('html', 'class');
check('the theme toggle works', themeWas !== themeNow, `${themeWas} -> ${themeNow}`);
await reload();
check('the theme survives a reload', (await page.getAttribute('html', 'class')) === themeNow);
await page.click('#themeToggle2');
await settle(300);

/* ---------- reordering ---------- */
// Dragging cannot be synthesised reliably headless; the keyboard path writes the
// same order key through the same code, and is the one a screen reader uses.
const itemsBefore = await texts('#list');
await page.focus('#list li:first-child .drag.handle');
await page.keyboard.press('Space');
await settle(200);
await page.keyboard.press('ArrowDown');
await settle(200);
await page.keyboard.press('Space');
await settle(600);
const itemsAfter = await texts('#list');
check('an item can be moved with the keyboard',
  itemsBefore[0] === itemsAfter[1] && itemsBefore[1] === itemsAfter[0],
  `${itemsBefore.slice(0, 2)} -> ${itemsAfter.slice(0, 2)}`);
await reload();
check('the new order survives a reload', JSON.stringify(await texts('#list')) === JSON.stringify(itemsAfter));

/* ---------- renaming, and the card that reflects it ---------- */
await page.fill('#listName', 'Weekend shop');
await settle(500);
await page.click('#backHome');
await settle(600);
check('Back returns home', await page.isVisible('#home') && !(await page.isVisible('#listView')));
check('the rename shows on the card', (await page.textContent('#listsGrid')).includes('Weekend shop'));
check('the card counts the items', /\d+ items?/.test(await page.textContent('#listsGrid')));

/* ---------- the two kinds of link ---------- */
await page.click(`#listsGrid .card-list ${SHARE_LIST}`);
await settle(600);
const shareUrl = await clipboard();
check('Share copies a ?join= link for one list', /\?join=[^~%]+(~|%7E)/i.test(shareUrl), shareUrl);
// location.origin is http://localhost inside the mobile shell, which means nothing
// on the device the link is sent to.
check('the link points at PUBLIC_BASE_URL, not localhost', shareUrl.startsWith(PUBLIC), shareUrl);

await page.click('#linkDevice');
await settle(600);
const deviceUrl = await clipboard();
check('Link device copies a ?link= link for the index', /\?link=/.test(deviceUrl), deviceUrl);
check('the two links are different', shareUrl !== deviceUrl);

/* ---------- who you are ---------- */
await page.evaluate(() => { window.__promptReply = 'Pramod'; });
await page.click('#profileBtn');
await settle(400);
check('the profile name drives the avatar', (await page.textContent('#profileBtn')).trim() === 'P',
  await page.textContent('#profileBtn'));

/* ---------- sort mode ---------- */
const sortWas = (await page.textContent('#sortLabel')).trim();
await page.click('#sortToggle');
await settle(400);
const sortNow = (await page.textContent('#sortLabel')).trim();
check('the sort toggle switches mode', sortWas !== sortNow, `${sortWas} -> ${sortNow}`);
// Dragging only means anything when the manual order is the one on screen.
check('the drag handle is out of reach in Recent mode',
  sortNow !== 'Recent' || await page.evaluate(() =>
    document.querySelector('#listsGrid .card-list .drag')?.classList.contains('hidden')));
await page.click('#sortToggle');
await settle(400);

/* ---------- a second list, and list order ---------- */
await page.fill('#newListName', 'Hardware');
await page.press('#newListName', 'Enter');
await settle(700);
check('Enter in the new-list field creates one', await page.isVisible('#listView'));
await page.click('#backHome');
await settle(600);
check('both lists are on the home screen', (await page.$$('#listsGrid .card-list')).length === 2);

const listsBefore = await page.$$eval('#listsGrid .card-list h3', (h) => h.map((e) => e.textContent));
await page.focus('#listsGrid .card-list:first-child .drag');
await page.keyboard.press('Space');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Space');
await settle(700);
const listsAfter = await page.$$eval('#listsGrid .card-list h3', (h) => h.map((e) => e.textContent));
check('lists can be reordered too', listsBefore[0] === listsAfter[1], `${listsBefore} -> ${listsAfter}`);

/* ---------- setting one aside ---------- */
// The Archived section only appears once something is in it.
check('no Archived section until there is one', !(await page.isVisible('#archivedSection')));

const archivedName = (await page.$$eval('#listsGrid .card-list h3', (h) => h.map((e) => e.textContent)))[0];
await page.click(`#listsGrid .card-list:first-child ${ARCHIVE_LIST}`);
await settle(700);
check('archiving moves the card out of the home list',
  (await page.$$('#listsGrid .card-list')).length === 1 &&
  (await page.$$('#archivedGrid .card-list')).length === 1,
  `home=${(await page.$$('#listsGrid .card-list')).length} archived=${(await page.$$('#archivedGrid .card-list')).length}`);
check('the Archived heading appears', await page.isVisible('#archivedSection'));
check('the archived count is right', (await page.textContent('#archivedCount')).trim() === '1');
check('the archived card is the one archived',
  (await page.textContent('#archivedGrid')).includes(archivedName), archivedName);
// The list is set aside, not deleted: it is intact and still opens.
check('an archived list still offers to open and share',
  await page.isVisible(`#archivedGrid .card-list ${SHARE_LIST}`));
// Reorder is wired to the home grid only, so a handle here would do nothing.
check('an archived card has no drag handle',
  await page.evaluate(() => document.querySelector('#archivedGrid .card-list .drag')
    ?.classList.contains('hidden') === true));
check('an archived card offers to come back',
  await page.isVisible(`#archivedGrid .card-list ${UNARCHIVE_LIST}`));
check('a home card does not', !(await page.isVisible(`#listsGrid .card-list ${UNARCHIVE_LIST}`)));

await reload();
check('the archive survives a reload',
  (await page.$$('#archivedGrid .card-list')).length === 1 &&
  (await page.$$('#listsGrid .card-list')).length === 1);

// Opening an archived list works, and leaves it archived.
await page.click('#archivedGrid .card-list');
await settle(700);
check('an archived list opens', await page.isVisible('#listView'));
await page.click('#backHome');
await settle(600);
check('opening it does not unarchive it', (await page.$$('#archivedGrid .card-list')).length === 1);

await page.click(`#archivedGrid .card-list ${UNARCHIVE_LIST}`);
await settle(700);
check('unarchiving puts it back on the home screen',
  (await page.$$('#listsGrid .card-list')).length === 2 &&
  (await page.$$('#archivedGrid .card-list')).length === 0);
check('the Archived heading goes away when empty', !(await page.isVisible('#archivedSection')));
// It keeps its order key while archived, so it returns to where it was.
check('the unarchived list comes back in its old place',
  (await page.$$eval('#listsGrid .card-list h3', (h) => h.map((e) => e.textContent)))[0] === archivedName,
  `expected ${archivedName} first`);

/* ---------- clearing ---------- */
await page.click('#listsGrid .card-list:last-child');
await settle(600);
for (const item of ['Screws', 'Nails']) {
  await page.fill('#itemInput', item);
  await page.click('#addBtn');
  await settle(250);
}
await page.click('#list li:first-child input[type=checkbox]');
await settle(500);
await page.evaluate(() => { window.__confirmReply = true; });
await page.click('#clearCompleted');
await settle(600);
check('Clear done removes the ticked rows', (await rows('#doneList')) === 0);
await page.click('#clearAll');
await settle(600);
check('Clear all empties the list', (await rows('#list')) === 0, `${await rows('#list')} rows`);

/* ---------- the cost estimate ---------- */
// The one thing that may leave the device, and only on this button. With the network
// cut above, what is checked is that the failure is a sentence rather than a stuck
// button — the same path a user gets when the Worker is down.
await page.click('#estimateBtn');
await settle(600);
check('an empty list says there is nothing to price',
  (await page.textContent('#estimateSummary')).includes('Nothing to price'),
  await page.textContent('#estimateSummary'));

await page.fill('#itemInput', 'Milk');
await page.click('#addBtn');
await settle(300);
await page.click('#estimateBtn');
await page.waitForTimeout(8000);
const estimate = (await page.textContent('#estimateSummary')).trim();
check('an unreachable price service reports itself in words',
  estimate.length > 0 && !/undefined|NaN|\[object/.test(estimate), estimate);
check('the Estimate button is usable again afterwards', !(await page.isDisabled('#estimateBtn')));
// Pressing it is the only thing that should ever have tried to leave.
check('only the estimate reached for the network',
  blocked.length > 0 && blocked.every((u) => u.includes('workers.dev')), blocked.join(' | '));
check('no matrix when nothing could be priced', !(await page.isVisible('#priceMatrix')));

/* ---------- the comparison matrix ---------- */
// Known prices per shop, so the cheapest cell and the cheapest basket are facts
// rather than whatever the live API happens to say today. Aldi deliberately stocks
// nothing — the case that would otherwise "win" every comparison on £0.00.
// Morrisons stocks nothing and Tesco stocks two of three cheaply: between them they
// cover both ways the naive "lowest total wins" goes wrong. Tesco's £2.00 is the
// lowest number in the table and must still lose to Sainsbury's £4.90, which is the
// only complete basket cheaper than ASDA's.
const PRICES = {
  asda:       { Milk: 0.95, Bread: 1.40, Eggs: 2.60 },
  morrisons:  {},
  sainsburys: { Milk: 1.10, Bread: 1.30, Eggs: 2.50 },
  tesco:      { Milk: 0.80, Bread: 1.20 },
};
// Derived rather than hard-coded, so adding a shop to STORES does not silently rot
// these numbers into a lie — it changes them.
const PRICED_CELLS = Object.values(PRICES).reduce((n, shop) => n + Object.keys(shop).length, 0);
const NA_CELLS = STORES.length * 3 - PRICED_CELLS;
// One cell where the shop's listing is not what was asked for — the "Apetina Paneer
// comes back as the shop's own paneer" case, which the table has to mark rather than
// pass off as a match.
const NEAR_MISS = { store: 'sainsburys', item: 'Milk' };
priceFixture = (store, items) => ({
  results: items.map((q) => {
    const price = PRICES[store]?.[q];
    return price === undefined
      ? { query: q, unavailable: true }
      : {
          query: q, price, title: `${store} ${q}`, source: `${store}.co.uk`,
          link: `https://example.test/${store}/${q}`,
          missing: store === NEAR_MISS.store && q === NEAR_MISS.item ? ['seeded'] : [],
        };
  }),
});

// A fresh list, so the 7-day cache from the failed run above cannot answer for it.
await page.click('#backHome');
await settle(600);
await page.fill('#newListName', 'Compare');
await page.press('#newListName', 'Enter');
await settle(700);
await page.evaluate(() => {
  const ta = document.getElementById('itemInput');
  ta.value = 'Milk\nBread\nEggs';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#addBtn');
await settle(500);
await page.click('#estimateBtn');
await settle(3000);

// Who put each row there. It used to appear only once a list had two people in it,
// which left the rows added before anyone joined anonymous on exactly the lists
// where it matters.
check('each item names who added it',
  (await page.$$eval('#list li .metaRow', (m) => m.map((x) => x.textContent)))
    .every((t) => /Added by Pramod/.test(t)),
  (await page.$$eval('#list li .metaRow', (m) => m.map((x) => x.textContent))).join(' | '));

check('the matrix appears', await page.isVisible('#priceMatrix'));
check('it has a column per shop',
  (await page.$$eval('#matrixHead th', (h) => h.length)) === STORES.length + 1,
  `${await page.$$eval('#matrixHead th', (h) => h.length)} headers`);
check('and a row per item',
  (await page.$$eval('#matrixBody tr', (r) => r.length)) === 3,
  `${await page.$$eval('#matrixBody tr', (r) => r.length)} rows`);

// Every price is a link to that shop's own search for the matched product.
const links = await page.$$eval('#matrixBody a', (a) => a.map((x) => x.href));
check('every price is a link', links.length === PRICED_CELLS,
  `${links.length} links for ${PRICED_CELLS} prices`);
check('the links point at the shops, not at one shop',
  new Set(links.map((l) => new URL(l).host)).size >= 3,
  [...new Set(links.map((l) => new URL(l).host))].join(', '));
// What each shop is actually selling you, in the cell with its price. Four shops'
// prices for four different products is not a comparison unless the table says so.
const cellNames = await page.$$eval('#matrixBody a span:last-child', (s) => s.map((x) => x.textContent));
check('every price names the product it is for', cellNames.length === PRICED_CELLS,
  `${cellNames.length} names for ${PRICED_CELLS} prices`);
check('and each shop names its own listing, not one shared caption',
  new Set(cellNames).size === PRICED_CELLS, [...new Set(cellNames)].join(' | '));
check('the product name is in the matrix rather than under the item',
  !(await page.textContent('#list')).includes(`${STORES[0].id} Milk`),
  await page.textContent('#list'));

// A price for something that is not what was asked for is still worth seeing, but
// not as though it matched.
const nearMisses = await page.$$eval('#matrixBody [title*="closest"]', (a) => a.map((x) => x.title));
check('a listing missing what was searched for is marked as the closest match',
  nearMisses.length === 1, `${nearMisses.length} marked`);
check('and the tooltip names what the shop did not have',
  nearMisses[0]?.includes('seeded'), nearMisses[0] ?? '(none)');
check('a matched listing is not marked',
  (await page.$$eval('#matrixBody a', (a) => a.filter((x) => /open at/.test(x.title)).length))
    === PRICED_CELLS - 1);

check('what a shop does not stock shows n/a rather than a price',
  (await page.$$eval('#matrixBody td', (t) => t.filter((x) => x.textContent.trim() === 'n/a').length)) === NA_CELLS,
  `expected ${NA_CELLS}`);

// The cheapest cell in each row, which is the point of the whole table.
const cheapest = await page.$$eval('#matrixBody tr', (trs) =>
  trs.map((tr) => {
    const cells = [...tr.querySelectorAll('td')];
    const i = cells.findIndex((c) => c.className.includes('bg-accent-soft'));
    return `${tr.querySelector('th').textContent}:${i}`;
  }));
// Columns are ASDA, Morrisons, Sainsbury's, Tesco. Tesco is cheapest on the two it
// stocks; Sainsbury's on the one it does not.
check('the cheapest shop is highlighted per row',
  cheapest.join(' ') === 'Milk:3 Bread:3 Eggs:2', cheapest.join(' '));

// Totals: ASDA 4.95, Morrisons nothing, Sainsbury's 4.90, Tesco 2.00 (two items).
const totals = await page.$$eval('#matrixFoot tr:first-child td', (t) => t.map((x) => x.textContent.trim()));
check('each shop gets a total', totals.join(' ') === '£4.95 — £4.90 £2.00', totals.join(' '));
const bestCol = await page.$$eval('#matrixFoot tr:first-child td',
  (t) => t.findIndex((x) => x.className.includes('bg-accent-soft')));
check('the cheapest complete basket is highlighted, not the cheapest number',
  bestCol === 2, `column ${bestCol}`);
// Tesco's total is the smallest on screen and covers two thirds of the list, so it
// has to read as out of the running rather than as the answer.
check('a total over fewer items is dimmed',
  await page.$$eval('#matrixFoot tr:first-child td',
    (t) => t[3].className.includes('text-faint')));
check('the empty shop does not win on nothing',
  (await page.textContent('#estimateSummary')).includes("Sainsbury's"),
  await page.textContent('#estimateSummary'));
// The winning basket contains that near miss, so the headline must not present it
// as the cheapest way to buy what was actually asked for.
check('the headline says when the winner is only the closest match',
  /1 price is the closest match, not exact/.test(await page.textContent('#estimateSummary')),
  await page.textContent('#estimateSummary'));

check('the summary names the saving',
  /£0\.05 less than ASDA/.test(await page.textContent('#estimateSummary')),
  await page.textContent('#estimateSummary'));
check('coverage is stated under the totals',
  (await page.$$eval('#matrixFoot tr:last-child td', (t) => t.map((x) => x.textContent.trim()))).join(' ')
    === 'of 3 items 3 0 3 2',
  (await page.$$eval('#matrixFoot tr:last-child td', (t) => t.map((x) => x.textContent.trim()))).join(' '));

// Refresh asks again. Prices are cached for a week, so a wrong or stale answer —
// the shape the worker returns having changed under it, say — otherwise has no way
// out of the cache but the developer tools.
const beforeRefresh = blocked.filter((u) => /workers\.dev/.test(u)).length;
await page.click('#matrixRefresh');
await settle(3000);
const afterRefresh = blocked.filter((u) => /workers\.dev/.test(u)).length;
check('Refresh asks every shop again rather than re-reading the cache',
  afterRefresh - beforeRefresh === STORES.length, `${afterRefresh - beforeRefresh} lookups`);
check('and the table is still there afterwards', await page.isVisible('#priceMatrix'));

// Estimate, by contrast, must stay cheap.
const beforeEstimate = blocked.filter((u) => /workers\.dev/.test(u)).length;
await page.click('#estimateBtn');
await settle(1500);
check('Estimate still answers from the cache', 
  blocked.filter((u) => /workers\.dev/.test(u)).length === beforeEstimate);

// Switching shop re-reads what was already fetched rather than asking again.
const beforeSwitch = blocked.length;
await page.selectOption('#storeSelect', 'tesco');
await settle(600);
check('switching shop costs no further lookups', blocked.length === beforeSwitch,
  `${blocked.length - beforeSwitch} extra`);
check('and the rows now show that shop',
  (await page.textContent('#list')).includes('£0.80'), 'expected Tesco milk at £0.80');

/* ---------- following a price to the product's own page ---------- */

// The price on screen links to the shop's search. Tapping it should land on the
// product itself, which takes a lookup the matrix deliberately does not do up front.
productFixture = (store, product) =>
  `${BASE}product-page?shop=${store}&product=${encodeURIComponent(product)}`;

const asksBefore = resolveAsks.length;
const [popup] = await Promise.all([
  page.waitForEvent('popup'),
  page.click('#matrixBody a'),
]);
await popup.waitForURL(/product-page/, { timeout: 10000 }).catch(() => {});
check('tapping a price asks where the product lives', resolveAsks.length === asksBefore + 1,
  `${resolveAsks.length - asksBefore} asks`);
check('and asks for the matched product, not the typed word',
  resolveAsks.at(-1)?.product?.includes('Milk'), JSON.stringify(resolveAsks.at(-1)));
check('the tab lands on the resolved product page', /product=/.test(popup.url()), popup.url());
check('which is the page for that shop', popup.url().includes(`shop=${resolveAsks.at(-1).store}`), popup.url());
await popup.close();

// A second tap costs no second lookup: product pages are cached far longer than
// prices, because a URL changes when a shop rebuilds its site, not every week.
const asksBeforeRepeat = resolveAsks.length;
const [popup2] = await Promise.all([
  page.waitForEvent('popup'),
  page.click('#matrixBody a'),
]);
await popup2.waitForURL(/product-page/, { timeout: 10000 }).catch(() => {});
check('a second tap is answered from cache', resolveAsks.length === asksBeforeRepeat, 'asked again');
await popup2.close();

// When the lookup finds nothing, the link still has to go somewhere useful.
productFixture = () => null;
const [popup3] = await Promise.all([
  page.waitForEvent('popup'),
  page.click('#matrixBody tr:nth-child(2) a'),
]);
await popup3.waitForTimeout(2000);
// The tab is stopped at the door like every other outbound request, so what it was
// reaching for is the evidence: the shop's own site, not a blank tab or Google.
const followed = blocked.filter((u) => !/workers\.dev/.test(u)).at(-1) ?? '';
check('an unresolved product still falls back to the shop itself',
  /asda|morrisons|sainsburys|tesco/.test(followed), followed || '(nothing followed)');
check('and not to a search engine', !/google\./.test(followed), followed);
await popup3.close();
productFixture = null;

/* ---------- an estimate outlives leaving the list ---------- */

// Opens the list whose card carries this name.
async function openListNamed(name) {
  for (const card of await page.$$('#listsGrid .card-list')) {
    if (((await card.textContent()) ?? '').includes(name)) {
      await card.click();
      return true;
    }
  }
  return false;
}

const workerCalls = () => blocked.filter((u) => /workers\.dev/.test(u)).length;
const pricedRows = await page.$$eval('#matrixBody tr', (r) => r.length);
const lookupsBeforeLeaving = workerCalls();

await page.click('#backHome');
await settle(600);
check('the matrix is not on the home screen', !(await page.isVisible('#priceMatrix')));

await openListNamed('Compare');
await settle(900);
check('the estimate is still there on coming back', await page.isVisible('#priceMatrix'));
check('and the sentence that explains it comes back with it',
  /Cheapest at|Best is/.test(await page.textContent('#estimateSummary')),
  await page.textContent('#estimateSummary'));
check('with the rows it was generated for',
  (await page.$$eval('#matrixBody tr', (r) => r.length)) === pricedRows,
  `${await page.$$eval('#matrixBody tr', (r) => r.length)} of ${pricedRows} rows`);
// The whole point: an estimate costs a search per item per shop, so coming back to
// one must not quietly buy it again.
check('and nothing was looked up again to show it', workerCalls() === lookupsBeforeLeaving,
  `${workerCalls() - lookupsBeforeLeaving} extra lookups`);

const lookupsAfterReopen = workerCalls();
check('it says it matches the list',
  (await page.textContent('#matrixStatusText')).startsWith('Up to date'),
  await page.textContent('#matrixStatusText'));

// Adding to the list makes the prices a photograph of something else.
await page.fill('#itemInput', 'Butter');
await page.click('#addBtn');
await settle(700);
check('adding an item marks the matrix out of date',
  (await page.textContent('#matrixStatusText')).startsWith('Out of date'),
  await page.textContent('#matrixStatusText'));
check('and says what changed', /1 added/.test(await page.textContent('#matrixStatusText')),
  await page.textContent('#matrixStatusText'));
check('going stale costs no lookups of its own', workerCalls() === lookupsAfterReopen);

// Rows carry their text in an input, which :has-text cannot see.
async function deleteItemNamed(name) {
  for (const li of await page.$$('#list li')) {
    const value = await li.$eval('input.text', (i) => i.value).catch(() => '');
    if (value === name) {
      await (await li.$('[aria-label="Delete this item"]')).click();
      return true;
    }
  }
  return false;
}

// Undo it and it is honest about being current again.
check('the added item is there to remove', await deleteItemNamed('Butter'));
await settle(700);
check('removing the new item makes it current again',
  (await page.textContent('#matrixStatusText')).startsWith('Up to date'),
  await page.textContent('#matrixStatusText'));

// Removing something it priced is the other direction: the row is now history.
check('the priced item is there to remove', await deleteItemNamed('Milk'));
await settle(700);
check('removing a priced item marks it out of date',
  /1 removed/.test(await page.textContent('#matrixStatusText')),
  await page.textContent('#matrixStatusText'));
check('and that row reads as history rather than as a price to act on',
  await page.$eval('#matrixBody tr:first-child th', (th) => th.className.includes('line-through')),
  await page.$eval('#matrixBody tr:first-child th', (th) => th.className));

// The matrix is about the open list, so it must not follow you to another one.
await page.click('#backHome');
await settle(600);
for (const card of await page.$$('#listsGrid .card-list')) {
  if (!((await card.textContent()) ?? '').includes('Compare')) { await card.click(); break; }
}
await settle(700);
check('the matrix does not follow you to another list', !(await page.isVisible('#priceMatrix')));
priceFixture = null;

/* ---------- a share link, followed on another device ---------- */
const other = await browser.newContext({ viewport: { width: 420, height: 900 } });
const otherPage = await openPage(other);
await otherPage.goto(shareUrl.replace(PUBLIC, BASE), { waitUntil: 'networkidle' });
await otherPage.waitForTimeout(2000);
check('a ?join= link opens that list on a device that has never seen it',
  await otherPage.isVisible('#listView'));
// Secrets in the address bar end up in history and in screenshots.
check('the token is stripped from the url once adopted', !/join=/.test(otherPage.url()), otherPage.url());
await other.close();

/* ---------- deleting a list, and going back ---------- */
await page.click('#backHome');
await settle(600);
await page.evaluate(() => { window.__confirmReply = true; });
const cardsBefore = (await page.$$('#listsGrid .card-list')).length;
await page.click(`#listsGrid .card-list:last-child ${DELETE_LIST}`);
await settle(800);
check('deleting a list removes its card',
  (await page.$$('#listsGrid .card-list')).length === cardsBefore - 1,
  `${cardsBefore} -> ${(await page.$$('#listsGrid .card-list')).length}`);

await page.click('#listsGrid .card-list');
await settle(600);
await page.goBack();
await settle(800);
check('the browser Back button returns home',
  await page.isVisible('#home') && !(await page.isVisible('#listView')));

/* ---------- teardown ---------- */
const unique = [...new Set(pageErrors)];
check('nothing threw on the page', unique.length === 0, unique.join(' | '));

await browser.close();
server.kill();

if (failures) {
  console.error(`\ne2e: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('\ne2e: all checks passed');
process.exit(0);
