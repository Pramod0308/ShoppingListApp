// Estimating what a list costs at one shop.
//
// Prices come from the Worker in worker/ — the app cannot call a supermarket or a
// search engine itself, because neither allows cross-origin browser requests and an
// API key in client JavaScript is a public key.
//
// Item text only leaves the device when the estimate button is pressed. Nothing here
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
    const res = await fetch(PRICE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, items: misses.map((i) => i.text) }),
    });
    if (!res.ok) throw new Error(`lookup failed (${res.status})`);
    payload = await res.json();
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

export function formatMoney(amount) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'GBP' }).format(amount);
}
