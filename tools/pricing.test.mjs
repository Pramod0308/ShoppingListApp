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
  const body = await (await call({ store: 'aldi', items: ['sourdough'] })).json();
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
    { title: 'Aldi Coffee', source: 'Aldi', price: 'See in store' },
    { title: 'Aldi Coffee 227g', source: 'Aldi', price: '£3.29' },
  ]);
  const body = await (await call({ store: 'aldi', items: ['coffee'] })).json();
  check('skips listings with no usable price', body.results[0].price === 3.29);
}

// 5. Input limits — this endpoint is public, so it must not be a free search API.
{
  const bad = await call({ store: 'tesco', items: ['x'] });
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
      { title: 'Tesco Milk', source: 'Tesco', price: '£1.20' },
    ] }), { status: 200 });
  };
  const body = await (await call({ store: 'aldi', items: ['milk'] })).json();
  check('absent after both passes is still unavailable', body.results[0].unavailable === true);
  check('both passes were tried', calls === 2, `calls=${calls}`);
}

console.log(failures === 0 ? 'pricing: all checks passed' : `pricing: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
