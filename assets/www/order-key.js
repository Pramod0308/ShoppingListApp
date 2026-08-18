// Fractional index keys.
//
// Rows used to be ordered by a numeric `order_index` taken from `Date.now()`, which
// made ordering depend on two devices agreeing about the time, and made every drop
// rewrite every sibling's index. These keys are strings compared lexicographically:
// there is always room to generate another key between any two, so a reorder writes
// one field on one row and two devices reordering at once cannot corrupt each other.
//
// Keys are base-36 fractions with an implied leading "0.", e.g. "i" sits halfway
// between nothing and everything. No key ever ends in '0' — that would leave no room
// to insert before it.

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

// Smallest key strictly between `a` and `b`. `a` is '' for "before everything",
// `b` is null for "after everything".
function midpoint(a, b) {
  if (b !== null && a >= b) {
    throw new Error(`order keys out of sequence: ${a} >= ${b}`);
  }
  if (a.slice(-1) === '0' || (b !== null && b.slice(-1) === '0')) {
    throw new Error('order key must not end in 0');
  }

  if (b !== null) {
    // Copy the shared prefix through untouched and split what is left.
    let n = 0;
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;

  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))];
  }
  // The leading digits are adjacent, so the answer needs another digit.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/// Returns a key that sorts strictly between `a` and `b`. Pass null (or undefined)
/// for either end to mean "before the first" or "after the last".
export function keyBetween(a, b) {
  return midpoint(a ?? '', b ?? null);
}

/// Keys for `count` new rows landing in sequence between `a` and `b`, in order.
export function keysBetween(a, b, count) {
  const keys = [];
  let lower = a ?? null;
  for (let i = 0; i < count; i++) {
    const key = keyBetween(lower, b);
    keys.push(key);
    lower = key;
  }
  return keys;
}
