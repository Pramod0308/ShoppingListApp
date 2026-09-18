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

export const STORES = [
  { id: 'asda', label: 'ASDA' },
  { id: 'aldi', label: 'Aldi' },
  { id: 'lidl', label: 'Lidl' },
  { id: 'morrisons', label: 'Morrisons' },
  { id: 'sainsburys', label: "Sainsbury's" },
];

const CACHE_KEY = 'shopnest-prices';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const isConfigured = () => Boolean(PRICE_API_URL);

/// Where a lookup would go, for messages the user reads.
export const sourceName = () => (PRICE_API_URL ? 'the price service' : null);

// Cache keys ignore case and spacing so "Oat Milk" and "oat milk" are one lookup.
const normalise = (text) => text.trim().toLowerCase().replace(/\s+/g, ' ');
const cacheKey = (text, store) => `${store}|${normalise(text)}`;

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: losing the cache costs credits, not correctness.
  }
}

/// Prices a list of `{ id, text }`. Returns a Map of item id -> result, where a
/// result is `{ price, title, source }`, `{ unavailable: true }` or `{ error }`.
///
/// Cached answers cost nothing and work offline; only the misses are fetched, so
/// re-estimating the same list makes no request at all.
export async function priceItems(items, store) {
  const out = new Map();
  if (!isConfigured()) {
    for (const item of items) out.set(item.id, { error: 'Price lookup is not set up' });
    return out;
  }

  const cache = readCache();
  const now = Date.now();
  const misses = [];

  for (const item of items) {
    const hit = cache[cacheKey(item.text, store)];
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

  for (const item of misses) {
    const result = byQuery.get(normalise(item.text)) ?? { error: 'No answer for this item' };
    out.set(item.id, result);
    if (!result.error) cache[cacheKey(item.text, store)] = { at: now, result };
  }

  writeCache(cache);
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
export async function priceAllStores(items) {
  const entries = await Promise.all(
    STORES.map(async (s) => [s.id, await priceItems(items, s.id)]),
  );
  return new Map(entries);
}

/// Turns that matrix into per-shop totals and picks the one to beat.
///
/// Summing whatever a shop happens to stock and calling the smallest number the
/// winner is how a shop carrying none of your list wins with an empty basket —
/// Aldi returns nothing at all, so it would win every comparison at £0.00. Coverage
/// is therefore compared first and price only settles ties: the shops that priced
/// the most items are the ones in the running, and the cheapest of those wins.
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ store, items }),
  });
  if (!res.ok) throw new Error(`lookup failed (${res.status})`);
  return res.json();
}

// Where to send someone who taps a matched product.
//
// Serper's own `link` goes to Google Shopping, not the shop — following it lands on
// a Google results page rather than the item. These search the shop's own site for
// the exact product the price came from, which on a phone opens that shop's app,
// because the apps claim these links.
//
// Lidl is absent on purpose rather than guessed: its search URL could not be
// checked from where this was written, and a link that 404s is worse than the
// listing's own. productUrl falls back to that, so a Lidl price still opens
// something. Add the builder here once the real URL has been confirmed.
const STORE_SEARCH = {
  asda: (q) => `https://groceries.asda.com/search/${encodeURIComponent(q)}`,
  sainsburys: (q) => `https://www.sainsburys.co.uk/gol-ui/SearchResults/${encodeURIComponent(q)}`,
  morrisons: (q) => `https://groceries.morrisons.com/search?entry=${encodeURIComponent(q)}`,
  aldi: (q) => `https://groceries.aldi.co.uk/en-GB/Search?keywords=${encodeURIComponent(q)}`,
};

/// The best link for a priced result: the shop's own search for the matched product,
/// falling back to whatever the lookup gave us.
export function productUrl(store, result) {
  if (!result || result.error || result.unavailable) return null;
  const build = STORE_SEARCH[store];
  if (build && result.title) return build(result.title);
  return result.link ?? null;
}

export function formatMoney(amount) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'GBP' }).format(amount);
}
