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
