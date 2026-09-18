#!/usr/bin/env node
// The rules behind the comparison matrix: `node tools/compare.test.mjs`.
//
// Picking the cheapest shop looks like one line of arithmetic and is not. A shop
// that stocks none of your list has a total of £0.00, which beats every real shop,
// so the naive answer recommends the one place you cannot buy anything. Aldi really
// did answer that way for every item, which is why it is no longer offered — but one
// unstocked item is enough to bring the same trap back.
// Coverage before price is the rule, and it has no visible symptom when it breaks:
// the matrix still renders, it just points at the wrong shop.

import { compareStores, cheapestFor } from '../assets/www/pricing.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label} ${detail}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

const items = [{ id: 'a', text: 'milk' }, { id: 'b', text: 'bread' }];
const priced = (p) => ({ price: p, title: 'something', source: 'shop' });

// Builds the shape priceAllStores returns: store id -> (item id -> result).
const matrix = (byStore) =>
  new Map(Object.entries(byStore).map(([s, items]) => [s, new Map(Object.entries(items))]));

// 1. With everyone stocking everything, it is simply the cheapest basket.
{
  const { rows, best, complete } = compareStores(items, matrix({
    asda: { a: priced(1.0), b: priced(2.0) },
    morrisons: { a: priced(0.9), b: priced(1.9) },
    sainsburys: { a: priced(1.1), b: priced(2.1) },
    tesco: { a: priced(1.5), b: priced(2.5) },
  }));
  check('the cheapest complete basket wins', best === 'morrisons', best);
  check('totals add up', rows.find((r) => r.store === 'asda').total === 3);
  check('a full basket reports complete', complete === true);
  check('every shop is listed, in a fixed order',
    rows.map((r) => r.store).join() === 'asda,morrisons,sainsburys,tesco', rows.map((r) => r.store).join());
}

// 2. The case that matters: a shop stocking nothing totals £0.00 and must not win.
{
  const { best, complete } = compareStores(items, matrix({
    asda: { a: priced(1.0), b: priced(2.0) },
    tesco: { a: { unavailable: true }, b: { unavailable: true } },
    morrisons: { a: priced(1.5), b: priced(2.5) },
    sainsburys: { a: priced(1.2), b: priced(2.2) },
  }));
  check('a shop that stocks nothing does not win on £0.00', best === 'asda', best);
  check('and the winner is still reported complete', complete === true);
}

// 3. Half a basket cheaply is not better than a whole one. Coverage decides first.
{
  const { rows, best, complete } = compareStores(items, matrix({
    asda: { a: priced(5.0), b: priced(5.0) },
    tesco: { a: priced(0.5), b: { unavailable: true } },
    morrisons: { a: priced(6.0), b: { unavailable: true } },
    sainsburys: { a: priced(9.0), b: priced(9.0) },
  }));
  check('a cheap half basket loses to a complete one', best === 'asda', best);
  check('the partial shop still reports its own total',
    rows.find((r) => r.store === 'tesco').total === 0.5);
  check('and it is counted as one item, not two',
    rows.find((r) => r.store === 'tesco').priced === 1);
}

// 4. When nobody can price everything, the fullest basket wins and says so.
{
  const three = [...items, { id: 'c', text: 'eggs' }];
  const { best, complete } = compareStores(three, matrix({
    asda: { a: priced(1.0), b: priced(1.0), c: { unavailable: true } },
    tesco: { a: priced(0.1), b: { unavailable: true }, c: { unavailable: true } },
    morrisons: { a: priced(9.0), b: priced(9.0), c: { unavailable: true } },
    sainsburys: { a: priced(1.0), b: { unavailable: true }, c: { unavailable: true } },
  }));
  check('the fullest basket wins when none is complete', best === 'asda', best);
  check('and it is not claimed to be complete', complete === false);
}

// 5. Errors are not zero-priced items. A shop that could not be checked at all has
//    no basket, and must not be recommended on the strength of an empty one.
{
  const { rows, best } = compareStores(items, matrix({
    asda: { a: { error: 'lookup failed (500)' }, b: { error: 'lookup failed (500)' } },
    tesco: { a: priced(3.0), b: priced(3.0) },
    morrisons: {},
    sainsburys: { a: priced(4.0), b: priced(4.0) },
  }));
  check('a shop that errored does not win', best === 'tesco', best);
  check('its failures are counted', rows.find((r) => r.store === 'asda').failed === 2);
  check('a shop with no answer at all counts as failed',
    rows.find((r) => r.store === 'morrisons').failed === 2);
}

// 6. Nothing priced anywhere is no recommendation, not a false one.
{
  const { best, complete } = compareStores(items, matrix({
    asda: { a: { unavailable: true }, b: { error: 'x' } },
    tesco: {}, morrisons: {}, sainsburys: {},
  }));
  check('no prices anywhere means no winner', best === null, String(best));
  check('and nothing is called complete', complete === false);
}

// 7. The per-row highlight, which is a different question from the per-shop winner:
//    the cheapest milk may not be at the shop with the cheapest basket.
{
  const byStore = matrix({
    asda: { a: priced(1.0), b: priced(0.5) },
    tesco: { a: priced(0.8), b: { unavailable: true } },
    morrisons: { a: priced(1.2), b: priced(0.6) },
    sainsburys: { a: priced(2.0), b: priced(0.7) },
  });
  check('the cheapest shop for a row is found', cheapestFor('a', byStore)?.store === 'tesco');
  check('even when a different shop wins the basket', cheapestFor('b', byStore)?.store === 'asda');
  check('an item nobody priced has no cheapest', cheapestFor('zzz', byStore) === null);
}

// 8. A tie keeps the first shop in STORES order, so the highlight does not move
//    between renders of identical data.
{
  const byStore = matrix({
    asda: { a: priced(1.0) },
    tesco: { a: priced(1.0) },
    morrisons: { a: priced(1.0) },
    sainsburys: { a: priced(1.0) },
  });
  check('a tie is broken stably', cheapestFor('a', byStore)?.store === 'asda');
  const { best } = compareStores([{ id: 'a' }], byStore);
  check('and so is a tie on the total', best === 'asda', best);
}

console.log(failures === 0 ? 'compare: all checks passed' : `compare: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
