#!/usr/bin/env node
// Exercises the price Worker without deploying it or spending a credit:
// `node tools/pricing.test.mjs`.
//
// The interesting behaviour is the store filter. "Not stocked here" has to be a
// result the UI can show, not an error it has to guess at, and a listing from the
// wrong retailer must never be counted as this store's price.

import worker from '../worker/index.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) { failures++; console.error(`FAIL ${label} ${detail}`); }
  else console.log(`  ok  ${label}`);
}

const ORIGIN = 'https://pramod0308.github.io';

// One canned Serper reply, listing three sellers and one entry with no price.
function stubSerper(shopping) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ shopping }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const call = (body, env = { SERPER_API_KEY: 'test' }) =>
  worker.fetch(
    new Request('https://w/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify(body),
    }),
    env,
  );

// 1. A listing from the chosen store is used; other sellers are ignored.
{
  stubSerper([
    { title: 'Tesco Oat Drink 1L', source: 'Tesco', price: '£1.40' },
    { title: 'ASDA Oat Drink 1L', source: 'Asda Groceries', price: '£1.15', link: 'https://groceries.asda.com/product/123' },
    { title: 'Waitrose Oat Drink', source: 'Waitrose', price: '£1.85' },
  ]);
  const res = await call({ store: 'asda', items: ['oat milk'] });
  const body = await res.json();
  const [first] = body.results;

  check('picks the price from the selected store', first.price === 1.15, JSON.stringify(first));
  check('reports which listing it costed', first.title === 'ASDA Oat Drink 1L');
  check('does not use another retailer as a fallback', first.price !== 1.4 && first.price !== 1.85);
  check('sets CORS for the app origin', res.headers.get('Access-Control-Allow-Origin') === ORIGIN);
  check('returns the listing URL so the product can be opened',
    first.link === 'https://groceries.asda.com/product/123', String(first.link));
}

// 2. No listing from that store is the "not available here" answer, not an error.
{
  stubSerper([
    { title: 'Tesco Sourdough', source: 'Tesco', price: '£2.00' },
    { title: 'Ocado Sourdough', source: 'Ocado', price: '£2.50' },
  ]);
  const body = await (await call({ store: 'asda', items: ['sourdough'] })).json();
  const [first] = body.results;

  check('absent from the store is flagged, not errored', first.unavailable === true && !first.error);
  check('flagged item carries no price', first.price === undefined);
}

// 3. Sainsbury's is spelled several ways in listings.
{
  stubSerper([{ title: 'Sainsbury\'s Tomatoes', source: "Sainsbury's", price: '£0.90' }]);
  const body = await (await call({ store: 'sainsburys', items: ['tomatoes'] })).json();
  check('matches the apostrophe spelling', body.results[0].price === 0.9);
}

// 4. A listing with an unparseable price must not count as a match.
{
  stubSerper([
    { title: 'Tesco Coffee', source: 'Tesco', price: 'See in store' },
    { title: 'Tesco Coffee 227g', source: 'Tesco', price: '£3.29' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['coffee'] })).json();
  check('skips listings with no usable price', body.results[0].price === 3.29);
}

// 5. Input limits — this endpoint is public, so it must not be a free search API.
{
  const bad = await call({ store: 'waitrose', items: ['x'] });
  check('rejects a store it does not serve', bad.status === 400);

  const many = await call({ store: 'asda', items: Array(41).fill('x') });
  check('rejects an oversized batch', many.status === 400);

  const noKey = await call({ store: 'asda', items: ['x'] }, {});
  check('fails clearly with no API key', noKey.status === 500);

  const preflight = await worker.fetch(
    new Request('https://w/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {});
  check('answers CORS preflight', preflight.status === 204);
}

// 6. A stranger's origin does not get an allow header for their own site.
{
  stubSerper([{ title: 'x', source: 'Asda', price: '£1.00' }]);
  const res = await worker.fetch(
    new Request('https://w/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ store: 'asda', items: ['x'] }),
    }),
    { SERPER_API_KEY: 'test' },
  );
  check('unknown origin is not echoed back',
    res.headers.get('Access-Control-Allow-Origin') !== 'https://evil.example');
}

// 7. The two-pass lookup. Naming the shop gets nothing for Sainsbury's, which only
//    appears as sainsburys.co.uk in a plain search — so a miss must retry without
//    the shop name rather than reporting "not stocked".
{
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const { q } = JSON.parse(init.body);
    calls++;
    // Naming the shop returns nothing at all, exactly as the live API does.
    const shopping = /sainsburys/i.test(q)
      ? []
      : [{ title: "Sainsbury's British Semi Skimmed Milk", source: 'sainsburys.co.uk', price: '£1.75' }];
    return new Response(JSON.stringify({ shopping }), { status: 200 });
  };

  const body = await (await call({ store: 'sainsburys', items: ['semi skimmed milk'] })).json();
  check('falls back to a plain search when naming the shop finds nothing',
    body.results[0].price === 1.75, JSON.stringify(body.results[0]));
  check('the seller domain counts as the shop', body.results[0].source === 'sainsburys.co.uk');
  check('the fallback costs one extra call, not more', calls === 2, `calls=${calls}`);
}

// 8. A shop that is genuinely absent stays absent after both passes.
{
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ shopping: [
      { title: 'Ocado British Semi Skimmed Milk', source: 'Ocado', price: '£1.20' },
    ] }), { status: 200 });
  };
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('absent after both passes is still unavailable', body.results[0].unavailable === true);
  check('both passes were tried', calls === 2, `calls=${calls}`);
}

// 9. The seller name Google prints is a display string, not the shop's identity. A
//    listing linking to the shop's own site counts even when the name does not say
//    so — which is what used to throw away anything reading "Aldi Stores Ltd" or
//    arriving through a marketplace.
{
  stubSerper([
    { title: 'Tesco Semi Skimmed Milk', source: 'Tesco Stores Ltd', price: '£0.85',
      link: 'https://www.tesco.com/groceries/en-GB/products/123' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('a seller name the filter does not know still matches on the link host',
    body.results[0].price === 0.85, JSON.stringify(body.results[0]));
}
{
  stubSerper([
    { title: 'Milk', source: 'SomeMarketplace', price: '£0.85',
      link: 'https://groceries.morrisons.com/products/milk-123' },
  ]);
  const body = await (await call({ store: 'morrisons', items: ['milk'] })).json();
  check('the host counts even when the seller name says nothing',
    body.results[0].price === 0.85, JSON.stringify(body.results[0]));
}
{
  stubSerper([
    { title: 'Milk', source: 'ASDA', price: '£1.10',
      link: 'https://groceries.asda.com/product/milk/456' },
  ]);
  const body = await (await call({ store: 'asda', items: ['milk'] })).json();
  check('a subdomain of the shop matches', body.results[0].price === 1.10);
}

// 10. The host has to be the shop's own, not merely mention it. Matching the whole
//     URL as a string would put a rival's price in Aldi's column.
{
  stubSerper([
    { title: 'Milk', source: 'Ocado', price: '£1.99',
      link: 'https://www.ocado.com/search?q=tesco.com+milk' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('another shop naming tesco in a query string is not a match',
    body.results[0].unavailable === true, JSON.stringify(body.results[0]));
}
{
  stubSerper([
    { title: 'Milk', source: 'Not It', price: '£1.99', link: 'https://nottesco.com/milk' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('a lookalike domain is not a match',
    body.results[0].unavailable === true, JSON.stringify(body.results[0]));
}
{
  stubSerper([
    { title: 'Milk', source: 'Nobody', price: '£1.99', link: 'not a url at all' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('an unparseable link is not a match rather than a crash',
    body.results[0].unavailable === true, JSON.stringify(body.results[0]));
}

// 11. Tesco is served like any other shop; the discounters are not served at all,
//     because the live API has no listings for either. Asking for one is refused
//     rather than answered with a silent "not stocked".
{
  stubSerper([{ title: 'Tesco Milk', source: 'Tesco', price: '£0.89',
    link: 'https://www.tesco.com/groceries/en-GB/products/1' }]);
  const body = await (await call({ store: 'tesco', items: ['milk'] })).json();
  check('tesco is a store the worker serves', body.results[0].price === 0.89, JSON.stringify(body.results[0]));
}
for (const gone of ['aldi', 'lidl']) {
  const res = await call({ store: gone, items: ['milk'] });
  check(`${gone} is no longer served`, res.status === 400);
  check(`and the error names the shops that are`,
    (await res.json()).error.includes('tesco'));
}

// 12. Resolving a product's own page.
//
//     The shopping API cannot answer this: every listing it returns links to
//     google.com/search. A tapped price that lands on a search engine is the bug
//     this path exists to fix, so what it must never do is hand back a link that is
//     not the shop's own page.
function stubSearch(organic) {
  globalThis.fetch = async () => new Response(JSON.stringify({ organic }), { status: 200 });
}

{
  stubSearch([
    { title: 'Semi Skimmed Milk 2.27L - Groceries', link: 'https://www.tesco.com/groceries/en-GB/products/254656543' },
  ]);
  const body = await (await call({ store: 'tesco', product: 'Tesco Semi Skimmed Milk' })).json();
  check('resolves a product page at the shop',
    body.url === 'https://www.tesco.com/groceries/en-GB/products/254656543', JSON.stringify(body));
}
{
  // Google pads a thin `site:` result set with pages from elsewhere. One of those
  // opened as "the product at Tesco" would be a plain lie about where to buy it.
  stubSearch([
    { title: 'Milk price comparison', link: 'https://www.trolley.co.uk/product/tesco-milk/ABC' },
    { title: 'Tesco Semi Skimmed Milk', link: 'https://www.tesco.com/groceries/en-GB/products/1234' },
  ]);
  const body = await (await call({ store: 'tesco', product: 'milk' })).json();
  check('a result from another site is not the shop\'s product page',
    body.url === 'https://www.tesco.com/groceries/en-GB/products/1234', String(body.url));
}
{
  // On-site but not a product: a category page beats a search box, and is what the
  // shop itself ranked first for this product.
  stubSearch([
    { title: 'Fresh Milk', link: 'https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk' },
  ]);
  const body = await (await call({ store: 'tesco', product: 'milk' })).json();
  check('falls back to the shop\'s own top hit when no product page is found',
    body.url === 'https://www.tesco.com/groceries/en-GB/shop/fresh-food/milk', String(body.url));
}
{
  // A product page anywhere in the results beats a non-product page above it.
  stubSearch([
    { title: 'Help', link: 'https://www.sainsburys.co.uk/help/delivery' },
    { title: 'British Semi Skimmed Milk', link: 'https://www.sainsburys.co.uk/gol-ui/product/sainsburys-british-semi-skimmed-milk' },
  ]);
  const body = await (await call({ store: 'sainsburys', product: 'milk' })).json();
  check('a product page outranks a higher non-product one',
    body.url.includes('/gol-ui/product/'), String(body.url));
}
{
  stubSearch([{ title: 'Milk', link: 'https://www.ocado.com/products/milk' }]);
  const body = await (await call({ store: 'asda', product: 'milk' })).json();
  check('nothing on the shop\'s site resolves to no url', body.url === null, JSON.stringify(body));
}
{
  stubSearch([]);
  const bad = await call({ store: 'tesco', product: '   ' });
  check('an empty product name is refused', bad.status === 400);
}
{
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const res = await call({ store: 'tesco', product: 'milk' });
  check('a failed search is an error, not a bad link', res.status === 502);
}
{
  // The resolve path must not fall through into a price lookup it has no items for.
  let searched = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search')) searched++;
    return new Response(JSON.stringify({ organic: [
      { title: 'Milk', link: 'https://groceries.asda.com/product/milk/123' },
    ] }), { status: 200 });
  };
  const body = await (await call({ store: 'asda', product: 'milk', items: ['milk'] })).json();
  check('resolving costs one search and no shopping lookups', searched === 1, `searched=${searched}`);
  check('and answers with the url rather than prices', body.url !== undefined && body.results === undefined);
}

console.log(failures === 0 ? 'pricing: all checks passed' : `pricing: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
