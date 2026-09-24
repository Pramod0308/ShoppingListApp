// Bundled locally by `npm run build:vendor` — the app has to start with no network.
import { Store } from "./store.js";
import { resolveLinkSecret } from "./peer-sync.js";
import { PUBLIC_BASE_URL } from "./sync-config.js";
import { isUnlocked, unlock, forget } from "./passcode.js";
import { STORES, isConfigured, priceAllStores, compareStores, cheapestFor, formatMoney, sourceName, productUrl,
         saveMatrix, loadMatrix, forgetMatrix, matrixFreshness, goneFromList, resolveProductUrl } from "./pricing.js";

const store = new Store();
const linkSecret = resolveLinkSecret(location.search);

// The bundle is loaded from a loopback server inside the mobile shell, where the
// URL means nothing to anyone else. It is the source of truth on the web, so every
// write is best-effort and never allowed to take the app down with it.
function writeUrl(href, { replace = false } = {}) {
  try {
    if (replace) history.replaceState({}, '', href);
    else history.pushState({}, '', href);
    return true;
  } catch {
    return false;
  }
}

// Secrets have been read into storage by now, so take them back out of the URL
// rather than leaving them in the address bar, in history and in any screenshot.
const incomingShare = new URLSearchParams(location.search).get('join');
if (incomingShare || new URLSearchParams(location.search).has('link')) {
  const cleaned = new URL(location.href);
  cleaned.searchParams.delete('link');
  cleaned.searchParams.delete('join');
  writeUrl(cleaned.href, { replace: true });
}

// The service worker is for the published web app. Inside the mobile shell the
// bundle already comes off disk through a loopback server, so a cache in front of
// it would only serve yesterday's build after an app update.
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('service worker registration failed:', err.message);
    });
  });
}

/* ---------- Elements (HOME) ---------- */
const homeSection       = document.getElementById('home');
const listsGrid         = document.getElementById('listsGrid');
const newListNameEl     = document.getElementById('newListName');
const createListBtn     = document.getElementById('createListBtn');
const themeToggle       = document.getElementById('themeToggle');
const linkDeviceBtn     = document.getElementById('linkDevice');
const profileBtn        = document.getElementById('profileBtn');
const sortToggleBtn     = document.getElementById('sortToggle');
const sortLabelEl       = document.getElementById('sortLabel');
const archivedSectionEl = document.getElementById('archivedSection');
const archivedGridEl    = document.getElementById('archivedGrid');
const archivedCountEl   = document.getElementById('archivedCount');

/* ---------- Elements (LIST VIEW) ---------- */
const listView          = document.getElementById('listView');
const backHomeBtn       = document.getElementById('backHome');
const listNameEl        = document.getElementById('listName');
const shareBtn          = document.getElementById('shareBtn');
const themeToggle2      = document.getElementById('themeToggle2');
const toggleDatesBtn    = document.getElementById('toggleDates');
const inputEl           = document.getElementById('itemInput');      // textarea
const addBtn            = document.getElementById('addBtn');
const remainingEl       = document.getElementById('remaining');
const clearAllBtn       = document.getElementById('clearAll');
const clearCompletedBtn = document.getElementById('clearCompleted');
const listEl            = document.getElementById('list');
const doneSectionEl     = document.getElementById('doneSection');
const doneListEl        = document.getElementById('doneList');
const doneCountEl       = document.getElementById('doneCount');
const deletedSectionEl  = document.getElementById('deletedSection');
const deletedListEl     = document.getElementById('deletedList');
const deletedCountEl    = document.getElementById('deletedCount');
const purgeDeletedBtn   = document.getElementById('purgeDeleted');
const storeSelectEl     = document.getElementById('storeSelect');
const estimateBtn       = document.getElementById('estimateBtn');
const estimateSummary   = document.getElementById('estimateSummary');
const matrixEl          = document.getElementById('priceMatrix');
const matrixHeadEl      = document.getElementById('matrixHead');
const matrixBodyEl      = document.getElementById('matrixBody');
const matrixFootEl      = document.getElementById('matrixFoot');
const matrixStatusEl    = document.getElementById('matrixStatus');
const matrixStatusDot   = document.getElementById('matrixStatusDot');
const matrixStatusText  = document.getElementById('matrixStatusText');
const matrixRefreshBtn  = document.getElementById('matrixRefresh');

/* ---------- Helpers ---------- */
const qs  = (k) => new URLSearchParams(location.search).get(k);
const fmt = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleString() : '…';
};
// Compact ages for the row meta. A full timestamp fills the line on a phone and
// says less than "2m ago" does.
const ago = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const root   = document.documentElement;

/* ============================================================
   ROUTING

   Which view is showing is held here, not read back out of the URL. Reloading the
   page to navigate used to drop writes that had not reached IndexedDB yet, and a
   file:// URL carrying a query string does not resolve reliably in a WebView, so
   both views now swap in place. The URL still tracks the route for shareable links
   on the web, but nothing reads it after startup.
   ============================================================ */
let listId = qs('list');

function routeUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('list', id);
  else url.searchParams.delete('list');
  return url.href;
}

function openList(id) {
  listId = id;
  writeUrl(routeUrl(id));
  showListView();
}

function goHome() {
  listId = null;
  writeUrl(routeUrl(null));
  showHome();
}

// The browser back button on the web, and the hardware back gesture on Android via
// the shell below.
window.addEventListener('popstate', () => {
  listId = qs('list');
  if (listId) showListView();
  else showHome();
});

// Called by the Flutter shell when Android's back gesture fires. Returns true when
// the web app consumed it; false tells the shell to close the app.
window.__shopnestBack = () => {
  if (!listId) return false;
  goHome();
  return true;
};

/* ============================================================
   THEME & TIMESTAMPS
   ============================================================ */
function applyTheme(t) {
  if (t === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  localStorage.setItem('theme', t);
}
const storedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(storedTheme);
[themeToggle, themeToggle2].forEach(b => b && (b.onclick = () => {
  applyTheme(root.classList.contains('dark') ? 'light' : 'dark');
}));

let showTimestamps = localStorage.getItem('showTimestamps') !== '0';
function applyTimestampPref() {
  document.body.classList.toggle('hide-meta', !showTimestamps);
  if (toggleDatesBtn) {
    toggleDatesBtn.title = showTimestamps ? 'Hide timestamps' : 'Show timestamps';
    toggleDatesBtn.innerHTML = showTimestamps
      ? '<span class="material-symbols-outlined">schedule</span>'
      : '<span class="material-symbols-outlined">visibility_off</span>';
  }
}
applyTimestampPref();
if (toggleDatesBtn) {
  toggleDatesBtn.onclick = () => {
    showTimestamps = !showTimestamps;
    localStorage.setItem('showTimestamps', showTimestamps ? '1' : '0');
    applyTimestampPref();
  };
}

/* ============================================================
   LIST ORDER

   The control in the header was previously a label with no behaviour. Dragging a
   card writes a manual key, so that ordering is only meaningful in 'custom' mode —
   in 'recent' mode the handle is taken out of reach rather than left to produce a
   reorder the user cannot see.
   ============================================================ */
let listSort = localStorage.getItem('listSort') === 'recent' ? 'recent' : 'custom';

function applySortPref() {
  if (sortLabelEl) sortLabelEl.textContent = listSort === 'recent' ? 'Recent' : 'Custom';
  if (sortToggleBtn) {
    sortToggleBtn.title = listSort === 'recent'
      ? 'Sorted by most recently updated. Switch to your own order.'
      : 'Sorted by your own order. Switch to most recently updated.';
  }
}
applySortPref();

if (sortToggleBtn) {
  sortToggleBtn.onclick = () => {
    listSort = listSort === 'recent' ? 'custom' : 'recent';
    localStorage.setItem('listSort', listSort);
    applySortPref();
    renderLists();
  };
}

/* ============================================================
   WHO

   Names come from a profile that syncs in the documents, not from an account —
   there is no server to authenticate against. Colours are picked from a fixed
   palette by index so they survive syncing as a number and read on both themes.
   ============================================================ */
const PERSON_COLOURS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6',
];
const personColour = (n) => PERSON_COLOURS[(n ?? 0) % PERSON_COLOURS.length];
const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

function renderProfileButton() {
  if (!profileBtn) return;
  const me = store.profile();
  profileBtn.textContent = initialOf(me.name);
  profileBtn.style.backgroundColor = personColour(me.colour);
  profileBtn.title = `You are "${me.name}" — tap to change`;
}

function editProfile() {
  const me = store.profile();
  const name = prompt('Your name, as other people on shared lists will see it:', me.name);
  if (name === null) return;
  store.setProfile({ name });
  renderProfileButton();
  showToast('Name updated everywhere you have shared a list.');
}

/* ============================================================
   COST ESTIMATE

   Prices are per (item, store) and live outside the documents on purpose: they are
   not list data, and syncing them to everyone a list is shared with would add
   conflicts and noise for no benefit. Results are held for the current render only.
   ============================================================ */
let prices = new Map();
// store id -> (item id -> result), for every shop at once. The matrix reads this;
// `prices` stays as the selected shop's column, which is what the rows show.
let priceMatrix = new Map();

if (storeSelectEl) {
  storeSelectEl.innerHTML = STORES
    .map((s) => `<option value="${s.id}">${s.label}</option>`)
    .join('');
  storeSelectEl.value = localStorage.getItem('store') || STORES[0].id;
  storeSelectEl.onchange = () => {
    localStorage.setItem('store', storeSelectEl.value);
    // Every shop was fetched together, so switching is a lookup rather than a
    // reason to throw the prices away and ask again.
    prices = priceMatrix.get(storeSelectEl.value) ?? new Map();
    renderItems();
    renderMatrix();
  };
}

function setSummary(text, tone = 'muted') {
  if (!estimateSummary) return;
  estimateSummary.textContent = text;
  estimateSummary.classList.toggle('hidden', !text);
  estimateSummary.classList.toggle('text-danger', tone === 'danger');
  estimateSummary.classList.toggle('text-muted', tone !== 'danger');
}

/// `fresh` skips the 7-day cache and asks every shop again. That costs a search per
/// item per shop, so it is what the Refresh button does and not what pressing
/// Estimate does.
async function estimateCost({ fresh = false } = {}) {
  if (!isConfigured()) {
    // Neither source is available: no worker URL, and no shell to fall back on.
    setSummary('Price lookup is not set up — see PRICE_API_URL in sync-config.js.', 'danger');
    return;
  }

  const target = listId ? shoppableItems() : [];
  if (target.length === 0) {
    setSummary('Nothing to price yet.');
    renderMatrix();
    return;
  }

  estimateBtn.disabled = true;
  if (matrixRefreshBtn) matrixRefreshBtn.disabled = true;
  setSummary(fresh ? 'Asking every shop again…' : 'Checking every shop…');
  try {
    priceMatrix = await priceAllStores(target, { fresh });
  } finally {
    estimateBtn.disabled = false;
    if (matrixRefreshBtn) matrixRefreshBtn.disabled = false;
  }
  // Named storeId, not store: `store` is the document store this module already uses.
  const storeId = storeSelectEl.value;
  prices = priceMatrix.get(storeId) ?? new Map();
  matrixItems = target;
  matrixAt = Date.now();
  // Saved against this list so going back to the home screen — or to another list
  // and back — does not throw away an estimate that cost a search per item per shop.
  saveMatrix(listId, target, priceMatrix);
  renderMatrix();
  renderItems();

  showComparisonSummary(target);
}

// The headline above the table: which shop wins, and by how much. Shared with the
// restore path, because a table that comes back without the sentence that explains
// it has only half survived the trip to the home screen.
function showComparisonSummary(items, byStore = priceMatrix) {
  const { rows, best, complete } = compareStores(items, byStore);
  const winner = rows.find((r) => r.store === best);

  if (!winner) {
    const anyFailed = rows.some((r) => r.failed > 0);
    setSummary(
      anyFailed
        ? `Could not get prices from ${sourceName() ?? 'anywhere'}.`
        : 'None of these are listed at any of the shops.',
      anyFailed ? 'danger' : 'muted',
    );
    return;
  }

  // Saying how many items a total covers matters when no shop stocks the lot —
  // otherwise "cheapest" would be comparing baskets that are not the same basket.
  const parts = [
    complete
      ? `Cheapest at ${winner.label}: ${formatMoney(winner.total)} for all ${plural(winner.priced, 'item')}`
      : `Best is ${winner.label}: ${formatMoney(winner.total)} for the ${plural(winner.priced, 'item')} it stocks`,
  ];
  const others = rows.filter((r) => r.store !== best && r.priced === winner.priced);
  if (others.length) {
    const dearest = others.reduce((a, b) => (b.total > a.total ? b : a));
    const saving = dearest.total - winner.total;
    if (saving > 0) parts.push(`${formatMoney(saving)} less than ${dearest.label}`);
  }

  // A basket is only cheapest for what you asked for if that is what is in it. A
  // shop's own paneer undercutting the brand you searched for is how it wins here
  // without stocking the product at all, so the headline says when that is why.
  const near = items.filter((i) => byStore.get(best)?.get(i.id)?.missing?.length).length;
  if (near) parts.push(`${near === 1 ? '1 price is' : `${near} prices are`} the closest match, not exact`);

  setSummary(parts.join(' · '));
}

/* ---------- The comparison matrix ---------- */
// The rows the matrix is about, kept so a change of shop can redraw it without
// asking what is on the list again.
let matrixItems = [];
// When it was generated, and which of its rows have since left the list. Both are
// what let the table say whether it still describes what you are looking at.
let matrixAt = 0;
let matrixGone = new Set();
// The list as it was the last time the table was drawn. Items sync per keystroke,
// so redrawing on every change would rebuild the whole table while someone types;
// this rebuilds only when the rows or their text actually differ.
let matrixDrawnFor = null;

// How long to wait for the product page before settling for the shop's search.
const RESOLVE_TIMEOUT_MS = 6000;

// Following a price through to the product's own page at that shop.
//
// The link on the page is the shop's search for the matched product: it always
// works, needs no lookup, and is what someone gets with JavaScript off or the
// lookup down. The product's own page has to be searched for (see
// resolveProductUrl), and that is a network round trip — so the tab is opened
// first, synchronously, because a window.open after an await is a popup as far as
// the browser is concerned and gets blocked.
//
// Whatever happens, the tab lands somewhere useful: the product if it was found,
// the shop's search for it if not.
function openProductPage(event, storeId, result) {
  const fallback = productUrl(storeId, result);
  if (!fallback || !result?.title) return; // nothing better to offer than the href

  const tab = window.open('about:blank', '_blank');
  if (!tab) return; // popups blocked: let the href navigate as it always did
  event.preventDefault();
  // The new tab must not be able to reach back into this one.
  try { tab.opener = null; } catch { /* already navigating cross-origin */ }
  try { tab.document.title = 'Finding the product…'; } catch { /* not ours to write */ }

  const timeout = new Promise((resolve) => setTimeout(resolve, RESOLVE_TIMEOUT_MS, null));
  Promise.race([resolveProductUrl(storeId, result.title), timeout])
    .catch(() => null)
    .then((url) => {
      try {
        tab.location.replace(url || fallback);
      } catch {
        // The tab was closed while we were looking.
      }
    });
}

// Puts back the last estimate run for the open list, if there is one. Nothing is
// re-fetched: this is the saved answer, and how old it is shows in the status line.
function restoreMatrix() {
  prices = new Map();
  priceMatrix = new Map();
  matrixItems = [];
  matrixAt = 0;
  matrixGone = new Set();
  matrixDrawnFor = null;

  const saved = listId ? loadMatrix(listId) : null;
  if (saved) {
    priceMatrix = saved.byStore;
    matrixItems = saved.items;
    matrixAt = saved.at;
    prices = priceMatrix.get(storeSelectEl?.value) ?? new Map();
    showComparisonSummary(matrixItems);
  }
  // The table is not drawn here: the list's items arrive with renderItems, and
  // judging the saved prices against rows that have not loaded would flash "out of
  // date" at someone whose list is merely still opening.
  matrixEl?.classList.add('hidden');
}

function matrixCell(item, storeId, cheapest) {
  const result = priceMatrix.get(storeId)?.get(item.id);
  const td = document.createElement('td');
  // No minimum width: fitting every shop on the screen at once is the point of the
  // table, and a column wide enough for a whole product name pushed the last shop
  // off a phone. The name below the price wraps and clips instead; the full one is
  // in the cell's tooltip.
  td.className = 'px-1 py-1.5 text-right tabular-nums align-top border-t border-line';

  if (!result || result.error) {
    td.textContent = '—';
    td.className += ' text-faint whitespace-nowrap';
    td.title = result?.error ? `Could not check: ${result.error}` : 'Not checked';
    return td;
  }
  if (result.unavailable) {
    td.textContent = 'n/a';
    td.className += ' text-faint whitespace-nowrap';
    td.title = 'Not stocked here';
    return td;
  }

  // Cheapest for this row: the one thing the matrix exists to show at a glance.
  const isCheapest = cheapest && cheapest.store === storeId;
  const href = productUrl(storeId, result);
  const cell = document.createElement(href ? 'a' : 'span');
  cell.className = 'block';

  const amount = document.createElement('span');
  amount.textContent = formatMoney(result.price);
  // Every price opens that shop's page for the matched product, so every price is
  // marked as something you can tap. Hover is not a thing on a phone, so the
  // underline is always on rather than appearing when a mouse arrives.
  amount.className = 'block whitespace-nowrap underline decoration-dotted underline-offset-2 '
    + (isCheapest ? 'font-semibold text-accent decoration-accent' : 'text-ink decoration-faint');
  cell.appendChild(amount);

  // What each shop is actually selling you. "Paneer" is not a product, and four
  // shops' prices for four different paneers is not a comparison — the prices only
  // mean something next to the thing each one is for.
  const shortfall = result.missing?.length ? result.missing : null;
  if (result.title) {
    const name = document.createElement('span');
    name.textContent = result.title;
    // A near miss is marked rather than dropped: the price is still worth seeing,
    // but not as though it were what was asked for.
    name.className = 'text-[10px] leading-tight font-normal line-clamp-2 '
      + (shortfall ? 'text-danger italic' : 'text-faint');
    cell.appendChild(name);
  }

  const shopLabel = STORES.find((s) => s.id === storeId)?.label ?? storeId;
  cell.title = shortfall
    ? `${result.title} — the closest ${shopLabel} stocks; no “${shortfall.join('”, “')}” in its listings`
    : `${result.title} — open at ${shopLabel}`;
  if (href) {
    cell.href = href;
    cell.target = '_blank';
    cell.rel = 'noopener noreferrer';
    cell.onclick = (e) => openProductPage(e, storeId, result);
  }

  td.appendChild(cell);
  if (isCheapest) td.className += ' bg-accent-soft';
  return td;
}

// A cheap fingerprint of what is on the list: which rows, and what they say. Two
// lists with the same fingerprint would produce the same matrix.
function matrixSignature(items) {
  return items.map((i) => `${i.id}\u0000${i.text}`).join('\u0001');
}

// Says, in one line, whether the table below still describes the list.
//
// Without this an estimate ages silently: prices stay on screen looking current
// while items are added and renamed underneath them, and the only way to tell is to
// compare the rows by eye.
function renderMatrixStatus(pricedItems, currentItems) {
  if (!matrixStatusEl) return;
  const { fresh, added, removed, renamed } = matrixFreshness(pricedItems, currentItems);
  const when = matrixAt ? ago(new Date(matrixAt).toISOString()) : '';

  if (fresh) {
    matrixStatusDot.style.backgroundColor = 'rgb(var(--accent))';
    matrixStatusEl.className = 'flex items-center gap-1.5 px-2 py-1.5 text-[11px] leading-tight border-b border-line text-muted';
    matrixStatusText.textContent = when ? `Up to date · priced ${when}` : 'Up to date with this list';
    matrixStatusText.title = 'Every item on the list is priced here, and nothing has changed since.';
    return;
  }

  // Name the drift rather than just flagging it: "2 added" tells you whether to
  // re-estimate now or carry on, and a bare "out of date" does not.
  const bits = [];
  if (added) bits.push(`${added} added`);
  if (removed) bits.push(`${removed} removed`);
  if (renamed) bits.push(`${renamed} changed`);
  matrixStatusDot.style.backgroundColor = 'rgb(var(--danger))';
  matrixStatusEl.className = 'flex items-center gap-1.5 px-2 py-1.5 text-[11px] leading-tight border-b border-line text-danger';
  matrixStatusText.textContent = `Out of date · ${bits.join(', ')} since — Estimate again`;
  matrixStatusText.title = `These prices were looked up for a different set of items${when ? `, ${when}` : ''}.`;
}

function renderMatrix() {
  if (!matrixEl) return;
  const items = priceMatrix.size ? matrixItems : [];
  const current = shoppableItems();
  // Recorded whether or not a table gets drawn, so the redraw check in renderItems
  // fires on a real change rather than on every render.
  matrixDrawnFor = matrixSignature(current);

  // A grid of dashes is not a comparison. When the lookup failed outright, or no
  // shop stocks any of it, the summary line says so on its own and the table would
  // only take up room repeating it.
  const anyPriced = items.length > 0 && compareStores(items, priceMatrix).best !== null;
  if (!anyPriced) {
    matrixEl.classList.add('hidden');
    return;
  }
  matrixEl.classList.remove('hidden');

  matrixGone = goneFromList(items, current);
  renderMatrixStatus(items, current);

  matrixHeadEl.innerHTML = '';
  const head = document.createElement('tr');
  const corner = document.createElement('th');
  corner.className = 'px-1 py-1.5 text-left font-medium text-faint sticky left-0 bg-surface z-10';
  corner.scope = 'col';
  corner.textContent = 'Item';
  head.appendChild(corner);
  for (const s of STORES) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'px-1 py-1.5 text-right font-medium whitespace-nowrap '
      + (s.id === storeSelectEl?.value ? 'text-ink' : 'text-faint');
    th.textContent = s.label;
    head.appendChild(th);
  }
  matrixHeadEl.appendChild(head);

  matrixBodyEl.innerHTML = '';
  for (const item of items) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    // A row priced for something no longer on the list is history, not a price to
    // act on — so it reads as struck through rather than as part of the basket.
    const gone = matrixGone.has(item.id);
    th.className = 'px-1 py-1.5 text-left font-normal border-t border-line max-w-[5rem] truncate sticky left-0 bg-surface '
      + (gone ? 'text-faint line-through' : 'text-ink');
    th.textContent = item.text;
    th.title = gone ? `${item.text} — no longer on the list` : item.text;
    tr.appendChild(th);
    const cheapest = cheapestFor(item.id, priceMatrix);
    for (const s of STORES) tr.appendChild(matrixCell(item, s.id, cheapest));
    matrixBodyEl.appendChild(tr);
  }

  const { rows, best } = compareStores(items, priceMatrix);
  matrixFootEl.innerHTML = '';
  const foot = document.createElement('tr');
  const label = document.createElement('th');
  label.scope = 'row';
  label.className = 'px-1 py-1.5 text-left font-medium text-ink border-t-2 border-line sticky left-0 bg-surface';
  label.textContent = 'Total';
  foot.appendChild(label);
  for (const row of rows) {
    const td = document.createElement('td');
    const isBest = row.store === best;
    // A total over fewer items is not a rival basket, and £3.73 for three things
    // reads as the winner next to £15.70 for five unless it is visibly dimmer.
    const comparable = row.priced === items.length;
    td.className = 'px-1 py-1.5 text-right tabular-nums whitespace-nowrap border-t-2 border-line '
      + (isBest ? 'bg-accent-soft font-semibold text-accent' : comparable ? 'text-ink' : 'text-faint');
    // A total over fewer items is not the same basket, so it says how many.
    td.textContent = row.priced ? formatMoney(row.total) : '—';
    td.title = row.priced
      ? `${row.label}: ${plural(row.priced, 'item')} priced`
        + (row.missing ? `, ${row.missing} not stocked` : '')
        + (row.failed ? `, ${row.failed} could not be checked` : '')
      : `${row.label}: nothing priced`;
    foot.appendChild(td);
  }
  matrixFootEl.appendChild(foot);

  // Under the totals, how much of the list each one actually covers — without it,
  // two totals of different baskets sit next to each other looking comparable.
  const counts = document.createElement('tr');
  const countLabel = document.createElement('td');
  countLabel.className = 'px-1 pb-1.5 text-left text-[11px] text-faint sticky left-0 bg-surface';
  countLabel.textContent = 'of ' + plural(items.length, 'item');
  counts.appendChild(countLabel);
  for (const row of rows) {
    const td = document.createElement('td');
    td.className = 'px-1 pb-1.5 text-right text-[11px] text-faint tabular-nums';
    td.textContent = `${row.priced}`;
    counts.appendChild(td);
  }
  matrixFootEl.appendChild(counts);
}

// Only things still to buy get priced; done and deleted rows are not shopping.
function shoppableItems() {
  return store.activeItems(listId).filter((i) => !i.done).map((i) => ({ id: i.id, text: i.text }));
}

/* ============================================================
   RENDERING

   Rows are reconciled by id instead of being thrown away and rebuilt. Wiping the
   container on every change meant that any edit arriving from another device — or
   from the row next door — destroyed whatever input the user was typing in.
   ============================================================ */

// Writes a value into an input without disturbing the caret when the user is in it.
function setInputValue(input, value) {
  if (input.value === value) return;
  if (document.activeElement !== input) {
    input.value = value;
    return;
  }
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;
  input.value = value;
  try {
    input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
  } catch {
    // Inputs that do not support selection ranges; nothing to preserve.
  }
}

// Keyed reconciliation. `cache` maps id -> element and is mutated in place.
function reconcile(container, entries, cache, create, update) {
  const seen = new Set();
  let previous = null;

  for (const entry of entries) {
    const id = entry.id;
    seen.add(id);

    let el = cache.get(id);
    if (!el) {
      el = create(entry);
      cache.set(id, el);
    }
    update(el, entry);

    const shouldFollow = previous ? previous.nextElementSibling : container.firstElementChild;
    if (shouldFollow !== el) container.insertBefore(el, shouldFollow);
    previous = el;
  }

  for (const [id, el] of cache) {
    if (!seen.has(id)) {
      el.remove();
      cache.delete(id);
    }
  }
}

/* ============================================================
   HOME (lists)
   ============================================================ */
const listRows = new Map();
// Archived cards live in their own container, so they get their own cache —
// reconcile drops a card from one and builds it in the other as a list moves.
const archivedRows = new Map();
let emptyStateEl = null;

function createList() {
  const name = (newListNameEl?.value || '').trim() || 'My Shopping List';
  newListNameEl.value = '';
  openList(store.createList(name));
}

// Links are built against the published origin, not location.origin: inside the
// mobile shell the page is served from a loopback server, and a localhost URL means
// nothing on the device it gets sent to.
function publicUrl(param, value) {
  const url = new URL(PUBLIC_BASE_URL);
  url.searchParams.set(param, value);
  return url.href;
}

function offerLink(url, message) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url)
      .then(() => showToast(message))
      .catch(() => prompt('Copy this link:', url));
  } else {
    prompt('Copy this link:', url);
  }
}

// One list, and only that list.
function shareList(id) {
  const token = store.shareToken(id);
  if (!token) return;
  offerLink(publicUrl('join', token), 'Link copied — it opens this list only.');
}

// The whole index, and therefore every list in it. A different blast radius from
// sharing a list, so it says so.
function copyDeviceLink() {
  offerLink(publicUrl('link', linkSecret), 'Device link copied — it carries every list. Keep it to your own devices.');
}

function deleteList(id) {
  if (!confirm('Delete this list (and all its items)?')) return;
  store.deleteList(id);
  // The saved estimate goes with it, or it would sit in storage for a list that no
  // longer exists — and reappear if the same id were ever adopted again.
  forgetMatrix(id);
}

function createListCard(list) {
  const id = list.id;

  const card = document.createElement('div');
  card.className = 'card-list row-press group flex items-center gap-1 bg-surface border border-line rounded-xl pl-1 pr-1.5 py-1.5 hover:bg-raised cursor-pointer';
  card.dataset.id = id;

  const rowTop = document.createElement('div');
  rowTop.className = 'row-top flex items-center gap-1 min-w-0 flex-1';

  const drag = document.createElement('div');
  drag.className = 'drag w-7 h-9 shrink-0 flex items-center justify-center rounded-md cursor-grab text-faint active:cursor-grabbing hover:text-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  drag.tabIndex = 0;
  drag.setAttribute('aria-label', 'Reorder list (Press Space to grab)');
  drag.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">drag_indicator</span>';

  const title = document.createElement('h3');
  title.className = 'text-[15px] font-medium text-ink truncate';

  const textCol = document.createElement('div');
  textCol.className = 'flex flex-col min-w-0 flex-1 py-1';
  textCol.append(title);
  rowTop.append(drag, textCol);

  const meta = document.createElement('div');
  meta.className = 'muted flex items-center gap-1.5 text-faint text-[12px] leading-tight';
  const countEl = document.createElement('span');
  countEl.className = '';
  const updatedEl = document.createElement('span');
  updatedEl.className = 'metaRow truncate';
  const sep = document.createElement('span');
  sep.className = 'metaRow h-0.5 w-0.5 bg-faint rounded-full shrink-0';
  const creatorEl = document.createElement('span');
  creatorEl.className = 'hidden truncate font-medium';
  meta.append(countEl, sep, updatedEl, creatorEl);

  const actions = document.createElement('div');
  actions.className = 'actions flex items-center gap-0.5 shrink-0';

  const openBtn = document.createElement('button');
  openBtn.className = 'icon-btn sr-only';
  openBtn.textContent = 'Open';
  openBtn.onclick = (e) => { e.stopPropagation(); openList(id); };

  const shareBtnNode = document.createElement('button');
  shareBtnNode.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors';
  shareBtnNode.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">ios_share</span>';
  shareBtnNode.setAttribute('aria-label', 'Share this list');
  shareBtnNode.title = 'Share';
  shareBtnNode.onclick = (e) => { e.stopPropagation(); shareList(id); };

  // Setting a list aside, and taking it back out. Only one is ever on screen.
  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors';
  archiveBtn.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">archive</span>';
  archiveBtn.setAttribute('aria-label', 'Archive this list');
  archiveBtn.title = 'Archive';
  archiveBtn.onclick = (e) => { e.stopPropagation(); store.archiveList(id); };

  const unarchiveBtn = document.createElement('button');
  unarchiveBtn.className = 'icon-btn hidden w-9 h-9 items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors';
  unarchiveBtn.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">unarchive</span>';
  unarchiveBtn.setAttribute('aria-label', 'Put this list back on the home screen');
  unarchiveBtn.title = 'Put back';
  unarchiveBtn.onclick = (e) => { e.stopPropagation(); store.unarchiveList(id); };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-danger hover:bg-danger-soft transition-colors';
  deleteBtn.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">delete</span>';
  deleteBtn.setAttribute('aria-label', 'Delete this list');
  deleteBtn.onclick = (e) => { e.stopPropagation(); deleteList(id); };

  actions.append(openBtn, shareBtnNode, archiveBtn, unarchiveBtn, deleteBtn);

  card.onclick = (e) => {
    if (!e.target.closest('button') && !e.target.closest('.drag')) {
      openList(id);
    }
  };

  textCol.append(meta);
  card.append(rowTop, actions);
  card.refs = { title, countEl, updatedEl, drag, creatorEl, archiveBtn, unarchiveBtn };
  return card;
}

function updateListCard(card, list) {
  const { title, countEl, updatedEl, drag, creatorEl, archiveBtn, unarchiveBtn } = card.refs;
  const archived = list.archived;

  archiveBtn.classList.toggle('hidden', archived);
  archiveBtn.classList.toggle('flex', !archived);
  unarchiveBtn.classList.toggle('hidden', !archived);
  unarchiveBtn.classList.toggle('flex', archived);

  // Dragging only means anything when the manual order is the one on screen, and
  // reorder is wired to the active grid only — a handle in the archived section
  // would be a control that quietly does nothing.
  const draggable = listSort === 'custom' && !archived;
  drag.classList.toggle('hidden', !draggable);
  drag.tabIndex = draggable ? 0 : -1;

  const name = list.name || (list.loaded ? 'Untitled list' : '…');
  if (title.textContent !== name) title.textContent = name;

  const count = plural(list.itemCount, 'item');
  if (countEl.textContent !== count) countEl.textContent = count;

  // Only worth saying when somebody else made it — on your own lists it is noise.
  const creator = list.createdBy && list.createdBy !== store.profile().id
    ? store.people(list.id)[list.createdBy]
    : null;
  const by = creator ? `by ${creator.name}` : '';
  if (creatorEl.textContent !== by) {
    creatorEl.textContent = by;
    creatorEl.classList.toggle('hidden', !by);
    creatorEl.style.color = creator ? personColour(creator.colour) : '';
  }

  const updated = ago(list.updatedAt);
  if (updatedEl.textContent !== updated) {
    updatedEl.textContent = updated;
    updatedEl.title = fmt(list.updatedAt);
  }

  card.dataset.order = list.order;
}

function renderLists() {
  if (!listsGrid) return;
  const lists = store.activeLists(listSort);
  const archived = store.archivedLists();

  // "Nothing here yet" alongside a full Archived section would be a lie about an
  // empty account rather than about an empty home screen, so it waits until there
  // is genuinely nothing anywhere.
  if (!lists.length && !archived.length) {
    if (!emptyStateEl) {
      emptyStateEl = document.createElement('div');
      emptyStateEl.className = 'flex flex-col items-center justify-center gap-2 py-14 text-center';
      emptyStateEl.innerHTML = `
      <span class="material-symbols-outlined text-[28px] text-faint">list_alt</span>
      <p class="text-[13px] text-faint">Nothing here yet</p>`;
    }
    if (!emptyStateEl.isConnected) listsGrid.appendChild(emptyStateEl);
  } else if (emptyStateEl?.isConnected) {
    emptyStateEl.remove();
  }

  renderProfileButton();
  reconcile(listsGrid, lists, listRows, createListCard, updateListCard);
  reconcile(archivedGridEl, archived, archivedRows, createListCard, updateListCard);
  toggleSection(archivedSectionEl, archivedCountEl, archived.length);
  attachRipples();
}

/* ============================================================
   LIST VIEW (items)
   ============================================================ */
// Who is on the open list, resolved once per render rather than per row.
let people = {};
let shared = false;

const itemRows = new Map();
const doneRows = new Map();
const deletedRows = new Map();
// Only the most recent are drawn; nothing restores them, so an unbounded history
// would just grow the page.
const DELETED_SHOWN = 50;

function loadListName() {
  if (listNameEl) setInputValue(listNameEl, store.listName(listId));
}

function saveListName() {
  store.renameList(listId, (listNameEl?.value || '').trim() || 'Shopping List');
}

function createItemRow(item) {
  const id = item.id;

  const li = document.createElement('li');
  li.className = 'card row-press group animate-slide-in flex items-center gap-2 pl-3 pr-1.5 py-1.5 bg-surface border border-line rounded-xl hover:bg-raised';
  li.dataset.id = id;

  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 flex-1 min-w-0 pl-1';

  const label = document.createElement('label');
  label.className = 'relative flex items-center justify-center cursor-pointer flex-shrink-0';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'peer appearance-none w-[19px] h-[19px] shrink-0 bg-transparent border-[1.5px] border-faint rounded-full checked:bg-accent checked:border-accent hover:border-muted transition-colors cursor-pointer';
  cb.onchange = () => toggleDone(id);

  const checkIcon = document.createElement('span');
  checkIcon.className = 'absolute inset-0 flex items-center justify-center opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none text-accent-ink';
  checkIcon.innerHTML = '<span class="material-symbols-outlined text-[13px] leading-none font-bold">check</span>';

  label.append(cb, checkIcon);

  const textContainer = document.createElement('div');
  textContainer.className = 'flex flex-col flex-1 min-w-0 py-1';

  const text = document.createElement('input');
  text.className = 'text w-full bg-transparent border-0 p-0 focus:ring-0 text-[15px] leading-snug truncate';
  text.setAttribute('enterkeyhint', 'enter');
  text.autocomplete = 'off';
  // Sync per keystroke rather than on blur: the store narrows it to the characters
  // that actually changed, which is what lets two people type in the same row.
  text.addEventListener('input', () => editItem(id, text.value));
  // Truncation keeps rows to one line, but it also hides the end of what you are
  // editing. Drop it while the field is focused.
  text.addEventListener('focus', () => text.classList.remove('truncate'));
  text.addEventListener('blur', () => text.classList.add('truncate'));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addEmptyItemAfter(id);
    }
  });

  const meta = document.createElement('span');
  meta.className = 'metaRow text-[11px] text-faint leading-tight mt-0.5 truncate';

  // Which listing a price came from used to sit here, under the item. It belongs in
  // the matrix instead: one row showing only the selected shop's match cannot be
  // compared with anything, and the same four products are what the table is for.
  textContainer.append(text, meta);
  row.append(label, textContainer);

  const rightContainer = document.createElement('div');
  rightContainer.className = 'flex items-center shrink-0';

  const mobileMeta = document.createElement('span');
  mobileMeta.className = 'sr-only';

  const dot = document.createElement('span');
  dot.className = 'hidden w-1.5 h-1.5 rounded-full shrink-0 mr-1.5';

  const price = document.createElement('span');
  price.className = 'hidden text-[13px] tabular-nums shrink-0 mr-1.5';

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'flex items-center gap-0.5';

  const del = document.createElement('button');
  del.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-danger hover:bg-danger-soft transition-colors';
  del.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">delete</span>';
  del.onclick = () => store.deleteItem(listId, id);
  del.setAttribute('aria-label', 'Delete this item');

  // Deleting is one tap and asks nothing, which is the right weight for something
  // that only moves a row into a section below — but only while that move can be
  // undone. This is the control that makes it true.
  const restore = document.createElement('button');
  restore.className = 'icon-btn hidden w-9 h-9 items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors';
  restore.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">undo</span>';
  restore.onclick = () => store.restoreItem(listId, id);
  restore.setAttribute('aria-label', 'Put this item back on the list');
  restore.title = 'Put back';

  const handle = document.createElement('div');
  handle.className = 'drag handle w-7 h-9 flex items-center justify-center rounded-md text-faint hover:text-muted transition-colors cursor-grab active:cursor-grabbing focus:ring-2 focus:ring-accent focus:outline-none';
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', 'Reorder item (Press Space to grab)');
  handle.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">drag_indicator</span>';

  actionsContainer.append(restore, del, handle);
  rightContainer.append(mobileMeta, dot, price, actionsContainer);

  li.append(row, rightContainer);
  li.refs = { cb, text, meta, mobileMeta, del, restore, handle, label, dot, price };
  return li;
}

function updateItemRow(li, item) {
  const { cb, text, meta, mobileMeta, del, restore, handle, label, dot, price } = li.refs;
  const done = item.done;
  const deleted = item.deleted;

  if (cb.checked !== done) cb.checked = done;
  const muted = done || deleted;
  text.classList.toggle('line-through', muted);
  text.classList.toggle('text-faint', muted);
  text.classList.toggle('text-ink', !muted);
  setInputValue(text, item.text);

  // A deleted row is a record, not a control. It loses the card chrome as well as
  // the controls, so it reads as history rather than as something still on the list.
  // Putting it back is the one thing it can still do, and the only control it keeps.
  li.classList.toggle('row-press', !deleted);
  li.classList.toggle('bg-surface', !deleted);
  li.classList.toggle('border-line', !deleted);
  li.classList.toggle('hover:bg-raised', !deleted);
  li.classList.toggle('bg-transparent', deleted);
  li.classList.toggle('border-transparent', deleted);
  text.readOnly = deleted;
  cb.disabled = deleted;
  label.classList.toggle('hidden', deleted);
  del.classList.toggle('hidden', deleted);
  restore.classList.toggle('hidden', !deleted);
  restore.classList.toggle('flex', deleted);
  // Reorder is only wired to the active section, so a handle anywhere else would be
  // a control that quietly does nothing.
  handle.classList.toggle('hidden', deleted || done);

  // Who put this here. It used to appear only on lists with more than one person in
  // them, on the reasoning that your own name is noise — but on a shared list the
  // rows added before anyone else joined then stayed anonymous, which is exactly
  // where you want to know. It is named whenever it is known.
  const who = item.authorId && people[item.authorId]
    ? ` by ${people[item.authorId].name}`
    : '';
  const stamp = deleted
    ? `Deleted ${ago(item.deletedAt)}`
    : `Added${who} ${ago(item.createdAt)}`;
  if (meta.textContent !== stamp) {
    meta.textContent = stamp;
    meta.title = fmt(deleted ? item.deletedAt : item.createdAt);
    mobileMeta.textContent = stamp;
  }

  const author = item.authorId ? people[item.authorId] : null;
  dot.style.backgroundColor = author ? personColour(author.colour) : 'transparent';
  // The colour is only telling you anything once there is more than one person to
  // tell apart; the name above carries it on a list of one.
  dot.classList.toggle('hidden', !shared || !author);
  dot.title = author ? `Added by ${author.name}` : '';

  const quote = prices.get(item.id);

  if (!quote || deleted) {
    price.classList.add('hidden');
    price.textContent = '';
    price.title = '';
  } else {
    price.classList.remove('hidden');
    if (quote.error) {
      price.textContent = '—';
      price.className = price.className.replace(/text-(ink|faint|danger)/g, '') + ' text-faint';
      price.title = quote.error;
    } else if (quote.unavailable) {
      // The point of the flag: say it is not sold here rather than quietly zero it.
      price.textContent = 'n/a';
      price.className = price.className.replace(/text-(ink|faint|danger)/g, '') + ' text-danger';
      price.title = `Not stocked at ${STORES.find(x => x.id === storeSelectEl.value)?.label ?? 'this store'}`;
    } else {
      price.textContent = formatMoney(quote.price);
      price.className = price.className.replace(/text-(ink|faint|danger)/g, '') + ' text-ink';
      price.title = quote.missing?.length
        ? `${quote.title} — the closest match, not what you asked for`
        : `${quote.title} — ${quote.source}`;
    }
  }

  li.dataset.order = item.order;
}

function renderItems() {
  if (!remainingEl || !listEl) return;

  people = store.people(listId);
  shared = Object.keys(people).length > 1;

  const active = store.activeItems(listId);
  const outstanding = active.filter(i => !i.done);
  const done = active.filter(i => i.done);
  const deleted = store.deletedItems(listId).slice(0, DELETED_SHOWN);

  remainingEl.textContent = `${outstanding.length} remaining`;

  reconcile(listEl, outstanding, itemRows, createItemRow, updateItemRow);
  reconcile(doneListEl, done, doneRows, createItemRow, updateItemRow);
  reconcile(deletedListEl, deleted, deletedRows, createItemRow, updateItemRow);

  toggleSection(doneSectionEl, doneCountEl, done.length);
  toggleSection(deletedSectionEl, deletedCountEl, store.deletedItems(listId).length);

  // The matrix has to answer for the list as it is now, so ticking an item off or
  // renaming one updates whether it still says "up to date". Only when something it
  // depends on actually differs: items sync per keystroke, and rebuilding the table
  // on each one would be work nobody asked for.
  if (matrixSignature(shoppableItems()) !== matrixDrawnFor) renderMatrix();

  attachRipples();
}

// A heading for an empty section is just noise.
function toggleSection(section, countEl, count) {
  if (!section) return;
  section.classList.toggle('hidden', count === 0);
  if (countEl) countEl.textContent = String(count);
}

if (inputEl) inputEl.setAttribute('enterkeyhint','enter');
function autoResizeTextarea(el) {
  // Two states give a measurement worth nothing. A hidden element reports
  // scrollHeight 0, which used to pin the composer shut. A laid-out element in a
  // page with no width — a background tab reports innerWidth 0 — wraps its text
  // into a column one character wide, so scrollHeight comes back enormous and the
  // composer sticks at its 200px ceiling. Measure only when there is a width.
  if (!el || el.offsetParent === null || el.clientWidth === 0) return;
  el.style.height = 'auto';
  el.style.height = Math.min(200, el.scrollHeight) + 'px';
}
if (inputEl) {
    autoResizeTextarea(inputEl);
    inputEl.addEventListener('input', () => autoResizeTextarea(inputEl));
    // Self-correcting: a measurement taken with no layout is re-taken as soon as
    // there is some, rather than leaving the composer wrong until the next keystroke.
    window.addEventListener('resize', () => autoResizeTextarea(inputEl));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) autoResizeTextarea(inputEl);
    });
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addFromTextarea();
        }
    });
}

function getLinesFromTextarea() {
  const raw = (inputEl?.value || '').replace(/\r\n/g, '\n');
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function addFromTextarea() {
  const lines = getLinesFromTextarea();
  if (!lines.length) return;
  inputEl.value = '';
  autoResizeTextarea(inputEl);
  store.addItems(listId, lines);
}

function addEmptyItemAfter(id) {
  const newItemId = store.addItemAfter(listId, id);
  // The store notifies synchronously, so the row is already reconciled into the DOM
  // by now — no timer needed to wait for it.
  if (newItemId) itemRows.get(newItemId)?.refs.text.focus();
}

function toggleDone(id) {
  store.toggleItem(listId, id);
}

function editItem(id, value) {
  store.setItemText(listId, id, value);
}

function clearAll() {
  if (!confirm('Clear all items?')) return;
  store.clearItems(listId);
}

function clearCompleted() {
  store.clearItems(listId, { doneOnly: true });
}

/* ---------- Reordering ---------- */

// The row's new neighbours in the DOM decide its key, and only that one row is
// written. The old scheme renumbered every sibling on every drop, which is both
// more writes than necessary and the most conflict-prone thing two devices can do.
// Sections are separate containers now, so a row's siblings are already its group.
// The dataset.done skipping this used to do existed only because active, done and
// deleted rows all shared one <ul>.
function neighbourKey(el, direction) {
  const sibling = direction === 'prev' ? el.previousElementSibling : el.nextElementSibling;
  return sibling?.dataset.order ?? null;
}

function persistOrder(el, move) {
  const lower = neighbourKey(el, 'prev');
  const upper = neighbourKey(el, 'next');
  try {
    const key = move(el.dataset.id, lower, upper);
    if (key) el.dataset.order = key;
  } catch (err) {
    // Only reachable if the DOM order and the stored keys disagree; the next
    // render puts the row back where its key says it belongs.
    console.warn('could not reorder', el.dataset.id, err);
    if (listId) renderItems(); else renderLists();
  }
}

const persistListOrder = (el) => persistOrder(el, (id, lo, hi) => store.moveList(id, lo, hi));
const persistItemsOrder = (el) => persistOrder(el, (id, lo, hi) => store.moveItem(listId, id, lo, hi));

/* ============================================================
   Mode switch
   ============================================================ */
function showHome() {
  if (homeSection) homeSection.classList.remove('hidden');
  if (listView) listView.classList.add('hidden');
  renderLists();
}
function showListView() {
  if (homeSection) homeSection.classList.add('hidden');
  if (listView) listView.classList.remove('hidden');
  autoResizeTextarea(inputEl);
  // Rows belong to whichever list is open, so start the view from scratch. The
  // matrix is restored from whatever was last estimated for *this* list — never the
  // one before it, which would show the previous list's prices against these rows.
  setSummary('');
  restoreMatrix();
  itemRows.clear();
  doneRows.clear();
  deletedRows.clear();
  listEl.replaceChildren();
  doneListEl.replaceChildren();
  deletedListEl.replaceChildren();
  loadListName();
  renderItems();
}

/* ============================================================
   Long-press reorder helper
   ============================================================ */
function enableLongPressReorder(container, itemSelector, onDrop, handleSelector = null) {
  if (!container) return;

  let pressTimer = null;
  let dragging = null;
  let startY = 0;
  let moved = false;

  const isInteractive = (el) =>
    el.closest('button, input, textarea, select, a, [contenteditable="true"]');

  const pointerDown = (e) => {
    const item = e.target.closest(itemSelector);
    if (!item) return;

    if (handleSelector && !e.target.closest(handleSelector)) return;
    if (isInteractive(e.target)) return;

    startY = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;
    moved = false;

    pressTimer = setTimeout(() => {
      dragging = item;
      dragging.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
      container.addEventListener('touchmove', preventScroll, { passive: false });
    }, 300);
  };

  const pointerMove = (e) => {
    if (!pressTimer && !dragging) return;
    const y = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;
    if (!dragging) {
      if (Math.abs(y - startY) > 8) { clearTimeout(pressTimer); pressTimer = null; }
      return;
    }
    moved = true;
    e.preventDefault();
    const afterEl = getDragAfterElement(container, y, itemSelector);
    if (!afterEl) container.appendChild(dragging);
    else container.insertBefore(dragging, afterEl);
  };

  const pointerUp = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (dragging) {
      const dropped = dragging;
      dropped.classList.remove('dragging');
      container.removeEventListener('touchmove', preventScroll);
      dragging = null;
      if (moved && typeof onDrop === 'function') onDrop(dropped);
      moved = false;
    }
  };

  container.addEventListener('mousedown', pointerDown);
  container.addEventListener('touchstart', pointerDown, { passive: true });
  container.addEventListener('mousemove', pointerMove);
  container.addEventListener('touchmove', pointerMove, { passive: false });
  container.addEventListener('mouseup', pointerUp);
  container.addEventListener('mouseleave', pointerUp);
  container.addEventListener('touchend', pointerUp);
  container.addEventListener('touchcancel', pointerUp);
}

function enableKeyboardReorder(container, itemSelector, onDrop, handleSelector = null) {
  if (!container) return;

  container.addEventListener('keydown', (e) => {
    const handle = e.target.closest(handleSelector || itemSelector);
    if (!handle) return;

    // Only proceed if the handle itself is focused
    if (e.target !== handle && !handle.contains(e.target)) return;

    const item = handle.closest(itemSelector);
    if (!item) return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (item.classList.contains('keyboard-dragging')) {
        item.classList.remove('keyboard-dragging');
        if (typeof onDrop === 'function') onDrop(item);
        handle.focus(); // keep focus
      } else {
        // Drop any existing
        container.querySelectorAll('.keyboard-dragging').forEach(el => el.classList.remove('keyboard-dragging'));
        item.classList.add('keyboard-dragging');
        showToast('Use Arrow Up/Down to move, Space to drop');
      }
    } else if (item.classList.contains('keyboard-dragging')) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = item.previousElementSibling;
        if (prev) {
          container.insertBefore(item, prev);
          handle.focus();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = item.nextElementSibling;
        if (next) {
          container.insertBefore(item, next.nextElementSibling);
          handle.focus();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        item.classList.remove('keyboard-dragging');
        handle.focus();
      }
    }
  });
}

function preventScroll(e) { e.preventDefault(); }

function getDragAfterElement(container, y, itemSelector) {
  const els = [...container.querySelectorAll(`${itemSelector}:not(.dragging)`)];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/* ---------- Ripples ---------- */
function attachRipples() {
  document.querySelectorAll('button.btn, button.icon-btn, button.neumorphic-btn').forEach(btn => {
    if (btn.dataset.rippleAttached) return;
    btn.dataset.rippleAttached = '1';
    btn.addEventListener('click', function (e) {
      const rect = this.getBoundingClientRect();
      const circle = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      circle.style.width = circle.style.height = size + 'px';
      circle.style.left = (e.clientX - rect.left - size/2) + 'px';
      circle.style.top  = (e.clientY - rect.top  - size/2) + 'px';
      circle.className = 'ripple';
      this.appendChild(circle);
      setTimeout(() => circle.remove(), 550);
    });
  });
}

/* ---------- Toast Notification ---------- */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 bg-inverse-surface text-inverse-on-surface px-4 py-2 rounded-lg shadow-lg font-label-md z-[100] animate-slide-up flex items-center gap-2';
  toast.innerHTML = `<span class="material-symbols-outlined text-[18px]">info</span> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, 10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* ---------- Wire UI ---------- */
if (createListBtn)      createListBtn.onclick = createList;
if (backHomeBtn)        backHomeBtn.onclick = goHome;
if (addBtn)             addBtn.onclick = addFromTextarea;
if (clearAllBtn)        clearAllBtn.onclick = clearAll;
if (clearCompletedBtn)  clearCompletedBtn.onclick = clearCompleted;
if (estimateBtn)        estimateBtn.onclick = () => estimateCost();
if (matrixRefreshBtn)   matrixRefreshBtn.onclick = () => estimateCost({ fresh: true });
if (purgeDeletedBtn)    purgeDeletedBtn.onclick = () => {
    if (confirm('Permanently remove the deleted items? They cannot be brought back.')) {
      store.purgeDeleted(listId);
    }
};
if (shareBtn)           shareBtn.onclick = () => shareList(listId);
if (linkDeviceBtn)      linkDeviceBtn.onclick = copyDeviceLink;
if (profileBtn)         profileBtn.onclick = editProfile;
if (listNameEl)         listNameEl.addEventListener('input', saveListName);
if (listNameEl)         listNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listNameEl.blur(); }
});
if (newListNameEl)      newListNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
});

// Attached once, not per render — rows outlive a change now.
enableLongPressReorder(listsGrid, '.card-list', persistListOrder, '.drag');
enableKeyboardReorder(listsGrid, '.card-list', persistListOrder, '.drag');
enableLongPressReorder(listEl, '.card', persistItemsOrder, '.drag.handle');
enableKeyboardReorder(listEl, '.card', persistItemsOrder, '.drag.handle');

/* ---------- Store subscription ---------- */
store.onChange(() => {
  if (listId) {
    // A list can be removed on another device while it is open here.
    if (!store.hasList(listId)) { goHome(); return; }
    loadListName();
    renderItems();
  } else {
    renderLists(); // names and item counts live on the cards
  }
});

/* ---------- Start ----------

   Nothing opens until the app is unlocked: no store, no sync, no lookups. A
   stranger with the URL gets a passcode box and an app that has not started. */
const lockScreen = document.getElementById('lockScreen');
const lockForm   = document.getElementById('lockForm');
const lockInput  = document.getElementById('lockInput');
const lockSubmit = document.getElementById('lockSubmit');
const lockError  = document.getElementById('lockError');

function showLockError(message) {
  if (!lockError) return;
  lockError.textContent = message;
  lockError.classList.toggle('hidden', !message);
}

function askForPasscode() {
  if (!lockScreen) return; // no lock screen in this build; nothing to ask with
  lockScreen.classList.remove('hidden');
  homeSection?.classList.add('hidden');
  listView?.classList.add('hidden');
  lockInput?.focus();

  lockForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    showLockError('');
    lockSubmit.disabled = true;
    const previous = lockSubmit.textContent;
    lockSubmit.textContent = 'Checking…';
    const result = await unlock(lockInput.value);
    lockSubmit.disabled = false;
    lockSubmit.textContent = previous;

    if (!result.ok) {
      showLockError(result.reason);
      lockInput.select();
      return;
    }
    lockInput.value = '';
    lockScreen.classList.add('hidden');
    startApp();
  });
}

function startApp() {
  store.open(linkSecret)
    .then(() => {
      // A shared list arrives as a token in the URL; adopt it and open it.
      if (incomingShare) {
        const share = Store.parseShareToken(incomingShare);
        if (share) {
          const joined = store.joinList(share.id, share.secret);
          listId = share.id;
          showListView();
          showToast(joined ? 'List added.' : 'You already have that list.');
          return;
        }
      }
      if (listId && store.hasList(listId)) showListView();
      else { listId = null; showHome(); }
    })
    .catch((err) => {
      console.error('could not open the store:', err);
      showHome();
    });
}

if (isUnlocked()) startApp();
else askForPasscode();

// Giving the device back. Not offered in the UI yet — the passcode is remembered
// per device on purpose — but this is the way out of a remembered unlock.
globalThis.shopitLock = () => { forget(); location.reload(); };
