// Estimating what a list costs at one shop.
//
// A page cannot fetch a supermarket's site — no CORS — and a static bundle cannot
// hold an API key, so prices come from the Worker in worker/, which holds the key and
// answers one narrow question: what does this product cost at this shop.
//
// Reading the shops' own pages from the mobile shell was tried and removed. It does
// not work: ASDA answers with a bot challenge, Sainsbury's and Aldi with Access
// Denied, and Morrisons ignores the search term and publishes no prices.
//
// Item text leaves the device only when the estimate button is pressed. Nothing here
// runs in the background, and no other part of a list is ever sent.

import { PRICE_API_URL } from './sync-config.js';
import { authHeaders } from './passcode.js';

// Aldi and Lidl are deliberately absent. Measured against the live API: a search
// naming Aldi returned ten listings, none of them Aldi's, and a plain search found
// neither discounter — neither sells groceries online in the UK, so there is
// nothing for Google Shopping to index. A column that can only say "not stocked"
// still costs a query per item to say it, so they are gone and Tesco, which the
// same measurement found three times over, is here instead.
export const STORES = [
  { id: 'asda', label: 'ASDA' },
  { id: 'morrisons', label: 'Morrisons' },
  { id: 'sainsburys', label: "Sainsbury's" },
  { id: 'tesco', label: 'Tesco' },
];

// Versioned, and the version is part of the key rather than a field inside it.
// A cached answer outlives a change to what the worker returns: when the store
// filter was fixed to match the product and not just the shop, every device that
// had estimated in the previous week went on being served the old wrong matches,
// with no way to tell and nothing to press. Bumping this orphans them at once.
const CACHE_KEY = 'shopnest-prices-v2';
const LEGACY_CACHE_KEYS = ['shopnest-prices'];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Resolved product pages, kept far longer than prices: a product's URL changes when
// the shop restructures its site, which is rare, while its price changes weekly.
// A miss is remembered too, briefly, so a product the shop does not have a page for
// is not re-searched on every tap.
const LINK_CACHE_KEY = 'shopnest-product-urls';
const LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LINK_MISS_TTL_MS = 24 * 60 * 60 * 1000;

// The last matrix generated for each list, so leaving a list and coming back does
// not throw away an estimate that cost real searches to produce.
const MATRIX_KEY = 'shopnest-matrix';
const MATRIX_KEEP = 10;

export const isConfigured = () => Boolean(PRICE_API_URL);

/// Where a lookup would go, for messages the user reads.
export const sourceName = () => (PRICE_API_URL ? 'the price service' : null);

// Cache keys ignore case and spacing so "Oat Milk" and "oat milk" are one lookup.
const normalise = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const cacheKey = (text, store) => `${store}|${normalise(text)}`;

function readStore(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}');
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: losing the cache costs credits, not correctness.
  }
}

const readCache = () => readStore(CACHE_KEY);
const writeCache = (cache) => writeStore(CACHE_KEY, cache);

// Superseded caches are dead weight in a storage quota shared with the lists
// themselves, so they go rather than sit there until the browser is cleared.
for (const key of LEGACY_CACHE_KEYS) {
  try {
    localStorage.removeItem(key);
  } catch {
    // No storage at all; there is nothing to clean up.
  }
}

/// Prices a list of `{ id, text }`. Returns a Map of item id -> result, where a
/// result is `{ price, title, source }`, `{ unavailable: true }` or `{ error }`.
///
/// Cached answers cost nothing and work offline; only the misses are fetched, so
/// re-estimating the same list makes no request at all.
export async function priceItems(items, store, { fresh = false } = {}) {
  const out = new Map();
  if (!isConfigured()) {
    for (const item of items) out.set(item.id, { error: 'Price lookup is not set up' });
    return out;
  }

  const cache = readCache();
  const now = Date.now();
  const misses = [];

  for (const item of items) {
    const hit = fresh ? null : cache[cacheKey(item.text, store)];
    if (hit && now - hit.at < TTL_MS) out.set(item.id, hit.result);
    else misses.push(item);
  }

  if (misses.length === 0) return out;

  if (!navigator.onLine) {
    for (const item of misses) out.set(item.id, { error: 'Offline' });
    return out;
  }

  let payload;
  try {
    payload = await lookup(misses.map((i) => i.text), store);
  } catch (err) {
    for (const item of misses) out.set(item.id, { error: err.message });
    return out;
  }

  // The worker answers in the order it was asked, but match on the query text so a
  // dropped or reordered entry cannot shift every price onto the wrong item.
  const byQuery = new Map();
  for (const result of payload.results ?? []) byQuery.set(normalise(result.query ?? ''), result);

  const updates = [];
  for (const item of misses) {
    const result = byQuery.get(normalise(item.text)) ?? { error: 'No answer for this item' };
    out.set(item.id, result);
    if (!result.error) updates.push([cacheKey(item.text, store), { at: now, result }]);
  }

  // Re-read before writing rather than saving the copy taken at the top. All four
  // shops are priced at once, and each one writing back the snapshot it started with
  // means the last to finish erases the other three — so every estimate was paying
  // for four shops and keeping one, and re-estimating the same list bought them all
  // again. There is no await between this read and the write, so nothing can
  // interleave with it.
  if (updates.length) {
    const latest = readCache();
    for (const [key, value] of updates) latest[key] = value;
    writeCache(latest);
  }
  return out;
}

/// Prices a list at every shop at once, for the comparison matrix. Returns a Map of
/// store id -> the same per-item Map priceItems gives.
///
/// One request per shop rather than one for all of them: the Worker answers for a
/// single store by design, and keeping it that way means this needs no redeploy.
/// They go out together, so four shops take about as long as one.
///
/// It does cost about four times the search credits of a single-shop estimate, and
/// a little more, because Sainsbury's needs a second query when naming the shop
/// finds nothing. The per (item, shop) cache is what keeps that bearable: looking
/// at the same list again inside a week is free.
export async function priceAllStores(items, { fresh = false } = {}) {
  const entries = await Promise.all(
    STORES.map(async (s) => [s.id, await priceItems(items, s.id, { fresh })]),
  );
  return new Map(entries);
}

/// Turns that matrix into per-shop totals and picks the one to beat.
///
/// Summing whatever a shop happens to stock and calling the smallest number the
/// winner is how a shop carrying none of your list wins with an empty basket at
/// £0.00. That was Aldi's every answer while it was listed, and it remains one
/// unstocked item away from mattering. Coverage is therefore compared first and
/// price only settles ties: the shops that priced the most items are the ones in
/// the running, and the cheapest of those wins.
/// `complete` says whether that was the whole list, so the UI can qualify it.
export function compareStores(items, byStore) {
  const rows = STORES.map((s) => {
    const prices = byStore.get(s.id) ?? new Map();
    let total = 0;
    let priced = 0;
    let missing = 0;
    let failed = 0;
    for (const item of items) {
      const result = prices.get(item.id);
      if (!result || result.error) failed++;
      else if (result.unavailable) missing++;
      else { total += result.price; priced++; }
    }
    return { store: s.id, label: s.label, total, priced, missing, failed };
  });

  const most = Math.max(0, ...rows.map((r) => r.priced));
  const contenders = most > 0 ? rows.filter((r) => r.priced === most) : [];
  const best = contenders.reduce((a, b) => (!a || b.total < a.total ? b : a), null);

  return { rows, best: best?.store ?? null, complete: most === items.length && most > 0 };
}

/// The cheapest shop for one item, or null when nobody priced it. Ties go to the
/// first shop in STORES order, so the highlight does not wander between renders.
export function cheapestFor(itemId, byStore) {
  let best = null;
  for (const s of STORES) {
    const result = byStore.get(s.id)?.get(itemId);
    if (!result || result.error || result.unavailable) continue;
    if (!best || result.price < best.price) best = { store: s.id, price: result.price };
  }
  return best;
}

async function lookup(items, store) {
  const res = await fetch(PRICE_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ store, items }),
  });
  // A rejected passcode is worth saying plainly; every other failure is a number.
  if (res.status === 401) throw new Error('The passcode this device saved is no longer accepted');
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  return res.json();
}

/* ---------- Keeping an estimate ----------

   A matrix is expensive: four shops, one search per item each, and more when a shop
   needs the fallback query. Throwing it away because someone went back to the home
   screen means paying for it again. It is saved per list, and a list only ever sees
   its own.

   It lives in localStorage rather than in the synced document on purpose. Prices are
   not list data — they are one person's lookup at one moment, and syncing them would
   push someone else's stale estimate onto everybody's screen. */

/// Serialises `byStore` (store id -> Map of item id -> result) alongside the items
/// it was generated for, so freshness can be judged when it is read back.
export function saveMatrix(listId, items, byStore) {
  if (!listId) return;
  const all = readStore(MATRIX_KEY);
  const stores = {};
  for (const [storeId, prices] of byStore) stores[storeId] = Object.fromEntries(prices);
  all[listId] = {
    at: Date.now(),
    items: items.map((i) => ({ id: i.id, text: i.text })),
    stores,
  };

  // Bound the growth: a device that has opened many shared lists should not carry
  // every estimate it has ever run. Newest first, and the one just saved counts as
  // newest whatever the clock says — two saves inside the same millisecond tie on
  // `at`, and the tie must not be settled by evicting the estimate being written.
  const ids = Object.keys(all).sort((a, b) => {
    if (a === listId) return -1;
    if (b === listId) return 1;
    return (all[b]?.at ?? 0) - (all[a]?.at ?? 0);
  });
  for (const id of ids.slice(MATRIX_KEEP)) delete all[id];

  writeStore(MATRIX_KEY, all);
}

/// The saved matrix for a list, as `{ at, items, byStore }`, or null.
export function loadMatrix(listId) {
  if (!listId) return null;
  const saved = readStore(MATRIX_KEY)[listId];
  if (!saved || !Array.isArray(saved.items) || !saved.stores) return null;
  const byStore = new Map();
  for (const [storeId, prices] of Object.entries(saved.stores)) {
    byStore.set(storeId, new Map(Object.entries(prices)));
  }
  return { at: saved.at ?? 0, items: saved.items, byStore };
}

/// Drops a list's saved estimate. Called when the list itself goes.
export function forgetMatrix(listId) {
  const all = readStore(MATRIX_KEY);
  if (!(listId in all)) return;
  delete all[listId];
  writeStore(MATRIX_KEY, all);
}

/// Whether a matrix still describes the list in front of you.
///
/// An estimate is a photograph, not a live reading: add an item, rename one, or tick
/// one off and the table is answering a question that is no longer being asked. This
/// says exactly how it has drifted so the UI can name it rather than leaving someone
/// to compare the rows by eye.
export function matrixFreshness(pricedItems, currentItems) {
  const was = new Map(pricedItems.map((i) => [i.id, i.text]));
  const now = new Map(currentItems.map((i) => [i.id, i.text]));

  let added = 0;
  let renamed = 0;
  for (const [id, text] of now) {
    if (!was.has(id)) added++;
    else if (was.get(id) !== text) renamed++;
  }
  const removed = [...was.keys()].filter((id) => !now.has(id)).length;

  return { fresh: added === 0 && removed === 0 && renamed === 0, added, removed, renamed };
}

/// The ids in a priced matrix that are no longer on the list, so those rows can be
/// shown for what they are rather than as current prices.
export function goneFromList(pricedItems, currentItems) {
  const now = new Set(currentItems.map((i) => i.id));
  return new Set(pricedItems.filter((i) => !now.has(i.id)).map((i) => i.id));
}

/* ---------- The product's own page ---------- */

/// Asks the worker for the page this product has at this shop.
///
/// Costs one search, so it is called when someone taps a price rather than for every
/// cell. Answers are cached for a month; a product with no page of its own is
/// remembered as such for a day so tapping it again is not another search.
///
/// Returns null rather than throwing: the caller always has the shop's search page
/// to fall back on, and a failed lookup should cost a less precise link, not an error.
export async function resolveProductUrl(store, title) {
  if (!isConfigured() || !title) return null;

  const key = `${store}|${normalise(title)}`;
  const cache = readStore(LINK_CACHE_KEY);
  const hit = cache[key];
  if (hit) {
    const ttl = hit.url ? LINK_TTL_MS : LINK_MISS_TTL_MS;
    if (Date.now() - hit.at < ttl) return hit.url;
  }

  if (!navigator.onLine) return null;

  let url = null;
  try {
    const res = await fetch(PRICE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ store, product: title }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    url = typeof body.url === 'string' ? body.url : null;
  } catch {
    return null;
  }

  cache[key] = { at: Date.now(), url };
  writeStore(LINK_CACHE_KEY, cache);
  return url;
}

// Where to send someone who taps a matched product.
//
// Serper's own `link` goes to Google Shopping, not the shop — confirmed against the
// live API, every listing it returns links to google.com/search, never to the
// retailer. So a tapped price resolves the product's own page through
// resolveProductUrl, and these are the fallback for when that finds nothing, is
// offline, or has not answered yet.
//
// A search on the shop's own site for the exact product the price came from is a
// near miss rather than a wrong answer, and on a phone it still opens that shop's
// app, because the apps claim these links.
const STORE_SEARCH = {
  asda: (q) => `https://groceries.asda.com/search/${encodeURIComponent(q)}`,
  sainsburys: (q) => `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(q)}`,
  morrisons: (q) => `https://groceries.morrisons.com/search?entry=${encodeURIComponent(q)}`,
  tesco: (q) => `https://www.tesco.com/groceries/en-GB/search?query=${encodeURIComponent(q)}`,
};

/// The link a price carries before anything is resolved: the shop's own search for
/// the matched product, falling back to whatever the lookup gave us. Following it
/// upgrades to the product's own page — see resolveProductUrl.
export function productUrl(store, result) {
  if (!result || result.error || result.unavailable) return null;
  const build = STORE_SEARCH[store];
  if (build && result.title) return build(result.title);
  return result.link ?? null;
}

export function formatMoney(amount) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'GBP' }).format(amount);
}
