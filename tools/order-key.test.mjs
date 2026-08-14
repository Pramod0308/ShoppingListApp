#!/usr/bin/env node
// Property test for assets/www/order-key.js: run `node tools/order-key.test.mjs`.
// Ordering is the one thing here with no visible symptom when it goes subtly wrong,
// so it gets checked by brute force rather than by eye.

import { keyBetween, keysBetween } from '../assets/www/order-key.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label} ${detail}`);
  }
}

// A key is only ever generated between its neighbours, so the invariant that must
// hold after any sequence of inserts is: the array stays sorted and has no dupes.
function assertSorted(label, keys) {
  for (let i = 1; i < keys.length; i++) {
    check(label, keys[i - 1] < keys[i], `${keys[i - 1]} !< ${keys[i]} at ${i}`);
  }
  check(`${label} (unique)`, new Set(keys).size === keys.length);
  check(
    `${label} (no trailing zero)`,
    keys.every((k) => !k.endsWith('0')),
    keys.filter((k) => k.endsWith('0')).join(','),
  );
}

// 1. Append-only, the common case of adding row after row.
{
  const keys = [];
  for (let i = 0; i < 2000; i++) keys.push(keyBetween(keys.at(-1) ?? null, null));
  assertSorted('append 2000', keys);
}

// 2. Prepend-only, which is how new lists and new items land at the top.
{
  const keys = [];
  for (let i = 0; i < 2000; i++) keys.unshift(keyBetween(null, keys[0] ?? null));
  assertSorted('prepend 2000', keys);
}

// 3. Random insertion anywhere, repeatedly — the drag-to-reorder case.
{
  const keys = [keyBetween(null, null)];
  for (let i = 0; i < 5000; i++) {
    const at = Math.floor(Math.random() * (keys.length + 1));
    const key = keyBetween(keys[at - 1] ?? null, keys[at] ?? null);
    keys.splice(at, 0, key);
  }
  assertSorted('random 5000', keys);
}

// 4. Repeatedly splitting the same gap — the pathological case for key length.
{
  const keys = [keyBetween(null, null), keyBetween(keyBetween(null, null), null)];
  for (let i = 0; i < 500; i++) keys.splice(1, 0, keyBetween(keys[0], keys[1]));
  assertSorted('same gap 500', keys);
  console.log(`  longest key after 500 splits of one gap: ${Math.max(...keys.map((k) => k.length))} chars`);
}

// 5. Batch insert, used when several lines are pasted into the composer at once.
{
  const a = keyBetween(null, null);
  const b = keyBetween(a, null);
  const batch = keysBetween(a, b, 50);
  assertSorted('batch of 50', [a, ...batch, b]);
}

// 6. Moving one row around a list without touching its neighbours.
{
  const keys = [];
  for (let i = 0; i < 100; i++) keys.push(keyBetween(keys.at(-1) ?? null, null));
  for (let i = 0; i < 1000; i++) {
    // Drop the row out of the list, then give it a key for where it landed —
    // exactly what a drag-and-drop does, and no other row is written.
    const from = Math.floor(Math.random() * keys.length);
    keys.splice(from, 1);
    const to = Math.floor(Math.random() * (keys.length + 1));
    keys.splice(to, 0, keyBetween(keys[to - 1] ?? null, keys[to] ?? null));
  }
  assertSorted('1000 moves', keys);
}

console.log(failures === 0 ? 'order-key: all checks passed' : `order-key: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
