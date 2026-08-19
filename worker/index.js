// Price lookup proxy.
//
// The app is a static bundle, so it cannot hold an API key and cannot call a
// supermarket or a search engine directly (no CORS, and a key in client JavaScript
// is a public key). This Worker is the smallest thing that solves both: it holds the
// Serper key as a secret and answers one narrow question — what does this product
// cost at this shop.
//
// It is deliberately not a general proxy. It accepts a list of short product names
// and a store from a fixed set, and returns prices. Nothing else about a list ever
// reaches it, and it stores nothing.

const STORES = {
  asda: ['asda'],
  aldi: ['aldi'],
  morrisons: ['morrisons'],
  sainsburys: ["sainsbury's", 'sainsburys', 'sainsbury'],
};

// What to put in the query. A search engine reads "Sainsbury's" very differently
// from the id "sainsburys".
// No apostrophe: "Sainsbury's" in the query returns no shopping results at all,
// while "Sainsburys" behaves like the others.
const STORE_LABELS = {
  asda: 'ASDA',
  aldi: 'Aldi',
  morrisons: 'Morrisons',
  sainsburys: 'Sainsburys',
};

const MAX_ITEMS = 40;
const MAX_QUERY = 80;

// Only these origins may call it. A Worker with an open CORS policy is a free
// search API for anyone who finds the URL, billed to whoever owns the key.
const ALLOWED_ORIGINS = [
  'https://pramod0308.github.io',
  'http://localhost:5173',
  'http://localhost:8737', // the mobile shell's loopback server
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });

// "£1.25" / "1.25" / "GBP 1.25" -> 1.25
function parsePrice(raw) {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return null;
  const match = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function matchesStore(source, store) {
  const needles = STORES[store] ?? [];
  const haystack = (source || '').toLowerCase();
  return needles.some((n) => haystack.includes(n));
}

async function shoppingFor(q, apiKey) {
  const res = await fetch('https://google.serper.dev/shopping', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    // gl/hl keep results on the UK market, where these shops exist.
    body: JSON.stringify({ q, gl: 'gb', hl: 'en' }),
  });
  return res;
}

async function findListing(q, store, apiKey) {
  const res = await shoppingFor(q, apiKey);
  if (!res.ok) return { error: `lookup failed (${res.status})` };
  const data = await res.json();
  const results = Array.isArray(data.shopping) ? data.shopping : [];
  // The store filter is what produces the availability answer: no listing from that
  // seller means it is not sold there, which is a result rather than a failure.
  const hit = results.find((r) => matchesStore(r.source, store) && parsePrice(r.price) !== null);
  return { hit };
}

async function priceFor(query, store, apiKey) {
  const label = STORE_LABELS[store] ?? store;

  // Naming the shop usually gets its own listings straight away. Sainsbury's is the
  // exception: it returns nothing when named, but shows up as sainsburys.co.uk in a
  // plain search — so a miss falls back to searching the product alone and filtering
  // the sellers. The second call only happens on a miss.
  let { hit, error } = await findListing(`${query} ${label}`, store, apiKey);
  if (error) return { query, error };

  if (!hit) {
    const plain = await findListing(query, store, apiKey);
    if (plain.error) return { query, error: plain.error };
    hit = plain.hit;
  }

  if (!hit) return { query, unavailable: true };

  return {
    query,
    price: parsePrice(hit.price),
    currency: 'GBP',
    title: hit.title ?? query,
    source: hit.source ?? store,
    // Which listing this price came from, so it can be opened and checked.
    link: typeof hit.link === 'string' ? hit.link : null,
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') ?? '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, origin);
    }
    if (!env.SERPER_API_KEY) {
      return json({ error: 'worker is missing SERPER_API_KEY' }, 500, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'expected JSON' }, 400, origin);
    }

    const store = String(body.store ?? '').toLowerCase();
    if (!STORES[store]) {
      return json({ error: `store must be one of ${Object.keys(STORES).join(', ')}` }, 400, origin);
    }

    if (body.debug === true) {
      const q = String(body.items?.[0] ?? 'milk').slice(0, MAX_QUERY);
      const label = STORE_LABELS[store] ?? store;
      const [withStore, plain] = await Promise.all([
        shoppingFor(`${q} ${label}`, env.SERPER_API_KEY).then((r) => r.json()),
        shoppingFor(q, env.SERPER_API_KEY).then((r) => r.json()),
      ]);
      const summarise = (d) =>
        (Array.isArray(d.shopping) ? d.shopping : [])
          .slice(0, 10)
          .map((r) => ({ source: r.source, price: r.price, title: (r.title || '').slice(0, 60), link: r.link }));
      return json({
        query: q,
        store,
        withStoreInQuery: summarise(withStore),
        plainQuery: summarise(plain),
      }, 200, origin);
    }

    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) return json({ results: [] }, 200, origin);
    if (items.length > MAX_ITEMS) {
      return json({ error: `at most ${MAX_ITEMS} items per request` }, 400, origin);
    }

    const queries = items
      .map((i) => String(i ?? '').trim().slice(0, MAX_QUERY))
      .filter(Boolean);

    const results = await Promise.all(
      queries.map((q) =>
        priceFor(q, store, env.SERPER_API_KEY).catch(() => ({ query: q, error: 'lookup failed' }))
      )
    );

    return json({ store, results }, 200, origin);
  },
};
