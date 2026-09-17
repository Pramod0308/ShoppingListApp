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

async function openPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !OFFLINE_NOISE.test(m.text())) pageErrors.push(m.text());
  });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE) || url.startsWith('data:') || url.startsWith('blob:')) {
      return route.continue();
    }
    blocked.push(url);
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
await page.evaluate(() => {
  const blank = [...document.querySelectorAll('#list li')]
    .find((r) => r.querySelector('input.text').value === '');
  blank?.querySelector('button')?.click();
});
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
await page.click('#list li:first-child button');
await settle(500);
check('deleting moves the row to Deleted',
  (await rows('#deletedList')) === 1 && (await rows('#list')) === 4,
  `deleted=${await rows('#deletedList')} active=${await rows('#list')}`);
check('the Deleted heading appears', await page.isVisible('#deletedSection'));
// A deleted row is a record, not a control.
check('a deleted row cannot be edited',
  await page.evaluate(() => document.querySelector('#deletedList li input.text').readOnly));

await page.evaluate(() => { window.__confirmReply = true; });
await page.click('#purgeDeleted');
await settle(500);
check('Clear empties the Deleted section', (await rows('#deletedList')) === 0);

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
await page.click('#listsGrid .card-list .actions button:nth-of-type(2)');
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
await page.click('#listsGrid .card-list:last-child .actions button:nth-of-type(3)');
await settle(800);
check('deleting a list removes its card', (await page.$$('#listsGrid .card-list')).length === 1);

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
