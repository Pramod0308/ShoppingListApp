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

// The shops this serves. Aldi and Lidl were here and are not any more: measured
// against the live API, a search naming Aldi returned ten listings and none of them
// were Aldi's, and a plain search returned none for either discounter. Neither
// sells groceries online in the UK, so Google Shopping has nothing of theirs to
// find, and a column that can only ever say "not stocked" costs a query per item
// to say it. Tesco replaced them because the same measurement showed it three
// times over.
//
// `names` are matched against the seller Google displays; `domains` against the
// host the listing links to. The host check is a fallback for a seller name the
// list does not know — but note that Serper returns google.com/search links rather
// than the shop's own, so today it never fires. It is kept because it is correct
// if that ever changes, not because it is doing work.
const STORES = {
  asda: { names: ['asda'], domains: ['asda.com', 'asda.co.uk'] },
  morrisons: { names: ['morrisons'], domains: ['morrisons.com', 'morrisons.co.uk'] },
  sainsburys: {
    names: ["sainsbury's", 'sainsburys', 'sainsbury'],
    domains: ['sainsburys.co.uk'],
  },
  tesco: { names: ['tesco'], domains: ['tesco.com', 'tesco.co.uk'] },
};

// What to put in the query. A search engine reads "Sainsbury's" very differently
// from the id "sainsburys".
// No apostrophe: "Sainsbury's" in the query returns no shopping results at all,
// while "Sainsburys" behaves like the others.
const STORE_LABELS = {
  asda: 'ASDA',
  morrisons: 'Morrisons',
  sainsburys: 'Sainsburys',
  tesco: 'Tesco',
};

// What a product page looks like at each shop, so a resolved link is the product
// rather than a category or a help page. Every one of these shops puts its products
// under /product/ or /products/; Sainsbury's has an older /shop/gb/groceries/ form
// still in use.
const PRODUCT_PATHS = {
  asda: /\/product\//i,
  morrisons: /\/products?\//i,
  sainsburys: /\/(product|shop\/gb\/groceries)\//i,
  tesco: /\/products\//i,
};

const MAX_ITEMS = 40;
const MAX_QUERY = 80;
// Product names are longer than the search terms people type into the list.
const MAX_PRODUCT = 120;

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

// A host belongs to a shop when it is that domain or a subdomain of it —
// groceries.asda.com counts, notaldi.co.uk and aldi.co.uk.example.com do not.
function hostMatches(link, domains) {
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function matchesStore(result, store) {
  const { names = [], domains = [] } = STORES[store] ?? {};
  const seller = (result?.source || '').toLowerCase();
  if (names.some((n) => seller.includes(n))) return true;
  return typeof result?.link === 'string' && hostMatches(result.link, domains);
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
  const hit = results.find((r) => matchesStore(r, store) && parsePrice(r.price) !== null);
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

// Finding the product's own page at the shop.
//
// The shopping API cannot do this: every listing it returns links to
// google.com/search, never to the retailer, so a price can be shown but not opened.
// A plain web search restricted to the shop's own domain is the one thing that
// turns a matched product name into a page on that shop's site.
//
// It is a separate call, made when someone actually taps a price rather than for
// every cell of the matrix. Resolving all of them up front would cost a search for
// every (item, shop) pair whether or not anyone ever followed the link.
async function searchFor(q, apiKey) {
  return fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl: 'gb', hl: 'en', num: 10 }),
  });
}

function pathOf(link) {
  try {
    return new URL(link).pathname;
  } catch {
    return '';
  }
}

async function productUrlFor(product, store, apiKey) {
  const { domains = [] } = STORES[store] ?? {};
  const res = await searchFor(`${product} site:${domains[0]}`, apiKey);
  if (!res.ok) return { error: `lookup failed (${res.status})` };
  const data = await res.json();
  const organic = Array.isArray(data.organic) ? data.organic : [];

  // Only the shop's own pages. `site:` is a request, not a guarantee — Google will
  // pad a thin result set with pages from elsewhere, and one of those opened as
  // "the product at Tesco" would be a lie.
  const onSite = organic.filter((r) => typeof r.link === 'string' && hostMatches(r.link, domains));
  const pattern = PRODUCT_PATHS[store];
  // A page under the shop's product path is the answer. Failing that, the top hit on
  // the shop's own site beats sending someone back to a search box.
  const best = onSite.find((r) => pattern?.test(pathOf(r.link))) ?? onSite[0] ?? null;

  return { url: best?.link ?? null, title: best?.title ?? null };
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

    // Resolving one product's page. Answered before the price path so it never
    // falls through into a shopping lookup it has no items for.
    if (typeof body.product === 'string') {
      const product = body.product.trim().slice(0, MAX_PRODUCT);
      if (!product) return json({ error: 'product must not be empty' }, 400, origin);
      const found = await productUrlFor(product, store, env.SERPER_API_KEY)
        .catch(() => ({ error: 'lookup failed' }));
      if (found.error) return json({ store, product, error: found.error }, 502, origin);
      return json({ store, product, url: found.url, title: found.title }, 200, origin);
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
