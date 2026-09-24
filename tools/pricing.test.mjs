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

// 12. Matching the product, not just the shop.
//
//     Taking the first listing from the right shop is how "Apetina Paneer" came back
//     as the shop's own-brand paneer at every one of them. Google ranks by its own
//     idea of relevance and a shop's own brand routinely outranks the brand someone
//     typed, so the filter has to ask whether the listing is the product as well as
//     whether it is the shop's.
{
  stubSerper([
    { title: 'ASDA Paneer 200g', source: 'ASDA', price: '£1.76' },
    { title: 'Apetina Paneer 200g', source: 'ASDA', price: '£2.25' },
  ]);
  const body = await (await call({ store: 'asda', items: ['Apetina Paneer'] })).json();
  const [first] = body.results;
  check('the branded listing wins over the own brand above it',
    first.title === 'Apetina Paneer 200g', JSON.stringify(first));
  check('and its price is the one quoted', first.price === 2.25);
  check('a full match reports nothing missing', first.missing.length === 0, JSON.stringify(first.missing));
}
{
  // The shop really does not stock it. The price is still worth showing — but as the
  // near miss it is, not as though it were what was asked for.
  stubSerper([{ title: 'ASDA Paneer 200g', source: 'ASDA', price: '£1.76' }]);
  const body = await (await call({ store: 'asda', items: ['Apetina Paneer'] })).json();
  const [first] = body.results;
  check('a near miss is still priced', first.price === 1.76);
  check('and names what it could not find', first.missing.join(',') === 'apetina',
    JSON.stringify(first.missing));
}
{
  // Naming the shop pushes its own brand up the results, so a near miss is worth a
  // plain search — that is where the branded listing shows up.
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    const { q } = JSON.parse(init.body);
    calls++;
    const shopping = /asda/i.test(q)
      ? [{ title: 'ASDA Paneer 200g', source: 'ASDA', price: '£1.76' }]
      : [{ title: 'Apetina Paneer 200g', source: 'ASDA', price: '£2.25' }];
    return new Response(JSON.stringify({ shopping }), { status: 200 });
  };
  const body = await (await call({ store: 'asda', items: ['Apetina Paneer'] })).json();
  check('a near miss is retried without the shop name', body.results[0].title === 'Apetina Paneer 200g',
    JSON.stringify(body.results[0]));
  check('and that costs one extra search, not more', calls === 2, `calls=${calls}`);
}
{
  // The common case must not get dearer: a first pass that found everything asked
  // for is not searched again.
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ shopping: [
      { title: 'Tesco Semi Skimmed Milk 2.27L', source: 'Tesco', price: '£1.45' },
    ] }), { status: 200 });
  };
  const body = await (await call({ store: 'tesco', items: ['semi skimmed milk'] })).json();
  check('an exact match costs a single search', calls === 1, `calls=${calls}`);
  check('and reports nothing missing', body.results[0].missing.length === 0);
}
{
  // Short words are units and articles; matching on them would make any title look
  // like a match. "1L" and "of" must not count towards the score.
  stubSerper([
    { title: 'Tesco Semi Skimmed Milk 1L', source: 'Tesco', price: '£1.10' },
    { title: 'Tesco Oat Milk 1L', source: 'Tesco', price: '£1.20' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['oat milk 1L'] })).json();
  check('the product decides the match, not the unit',
    body.results[0].title === 'Tesco Oat Milk 1L', JSON.stringify(body.results[0]));
}
{
  // A plural in the listing against a singular in the search is the same product.
  stubSerper([
    { title: 'Tesco Baking Potatoes 4 Pack', source: 'Tesco', price: '£1.50' },
    { title: 'Tesco Tomatoes 6 Pack', source: 'Tesco', price: '£0.95' },
  ]);
  const body = await (await call({ store: 'tesco', items: ['tomato'] })).json();
  check('a singular search matches the plural listing',
    body.results[0].title === 'Tesco Tomatoes 6 Pack', JSON.stringify(body.results[0]));
}

// 13. Resolving a product's own page.
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

// 14. The passcode gate.
//
//     CORS decides who may read a reply, not who may cause the request — any client
//     that is not a browser ignores it — so without this the endpoint is an open
//     wallet: every call spends a search billed to whoever owns the key.
const PASSCODE = 'open sesame';
const gated = { SERPER_API_KEY: 'test', APP_PASSCODE: PASSCODE };

async function tokenFor(passcode) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`shopnest-gate:${passcode}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const callAs = (body, token, env = gated) =>
  worker.fetch(
    new Request('https://w/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(token === undefined ? {} : { 'X-App-Token': token }),
      },
      body: JSON.stringify(body),
    }),
    env,
  );

{
  stubSerper([{ title: 'Tesco Milk', source: 'Tesco', price: '£1.00' }]);
  let searches = 0;
  globalThis.fetch = async () => {
    searches++;
    return new Response(JSON.stringify({ shopping: [] }), { status: 200 });
  };

  const none = await callAs({ store: 'tesco', items: ['milk'] }, undefined);
  check('a request with no token is refused', none.status === 401, String(none.status));
  check('and it costs no search', searches === 0, `${searches} searches`);

  const wrong = await callAs({ store: 'tesco', items: ['milk'] }, await tokenFor('guess'));
  check('a wrong passcode is refused', wrong.status === 401);
  check('and still costs no search', searches === 0, `${searches} searches`);

  const right = await callAs({ store: 'tesco', items: ['milk'] }, await tokenFor(PASSCODE));
  check('the right passcode is served', right.status === 200, String(right.status));
  check('and that one does search', searches > 0);
}
{
  // The lock screen has to be able to ask without spending anything, or being
  // locked out would cost money and so would anyone hammering the box.
  let searches = 0;
  globalThis.fetch = async () => { searches++; return new Response('{}', { status: 200 }); };

  const ok = await callAs({ unlock: true }, await tokenFor(PASSCODE));
  check('unlock accepts the right passcode', ok.status === 200);
  check('and says a passcode is required', (await ok.json()).required === true);

  const bad = await callAs({ unlock: true }, await tokenFor('nope'));
  check('unlock refuses the wrong one', bad.status === 401);
  check('checking a passcode spends no searches', searches === 0, `${searches} searches`);
  check('a refusal still carries CORS, or the app cannot read it',
    bad.headers.get('Access-Control-Allow-Origin') === ORIGIN);
}
{
  // Turning the gate on is a decision. A worker with no passcode set behaves
  // exactly as it did before, rather than locking everyone out on deploy.
  stubSerper([{ title: 'Tesco Milk', source: 'Tesco', price: '£1.00' }]);
  const open = await callAs({ store: 'tesco', items: ['milk'] }, undefined, { SERPER_API_KEY: 'test' });
  check('no passcode configured leaves the worker open', open.status === 200);
  const asked = await callAs({ unlock: true }, undefined, { SERPER_API_KEY: 'test' });
  check('and unlock says none is required', (await asked.json()).required === false);
}
{
  const preflight = await worker.fetch(
    new Request('https://w/', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), {});
  check('preflight allows the token header',
    /x-app-token/i.test(preflight.headers.get('Access-Control-Allow-Headers') ?? ''),
    preflight.headers.get('Access-Control-Allow-Headers'));
}

console.log(failures === 0 ? 'pricing: all checks passed' : `pricing: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
