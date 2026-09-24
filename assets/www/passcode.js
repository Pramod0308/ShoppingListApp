// The lock on the front door.
//
// Be clear about what this is. It keeps strangers who find the URL out of the app
// and, more usefully, off the price worker — which spends real money per search. It
// is not encryption: the lists live in this browser's IndexedDB, and anyone holding
// an unlocked phone, or willing to open the developer tools on it, can read them
// whatever this screen says. Treat it as a lock, not a safe.
//
// The passcode itself is never stored and never sent. What is stored is a digest of
// it, which is also what the worker compares against the digest of its own copy —
// so nothing in the shipped bundle helps anyone guess it.

import { PRICE_API_URL, REQUIRE_PASSCODE } from './sync-config.js';

const TOKEN_KEY = 'shopnest-unlock';

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/// The same derivation the worker uses.
export async function tokenFor(passcode) {
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(`shopnest-gate:${passcode}`),
  );
  return base64Url(new Uint8Array(digest));
}

function storedToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // storage blocked; the gate fails closed
  }
}

/// Whether the app may start. A build with no gate configured is always unlocked.
export function isUnlocked() {
  return !REQUIRE_PASSCODE || Boolean(storedToken());
}

/// Checks a passcode against the worker and remembers it on success.
///
/// Remembered per device rather than asked for every launch: this is here to keep
/// strangers out, and a shopping list you have to log into is a shopping list you
/// stop using. `forget()` is the way back out.
export async function unlock(passcode) {
  if (!passcode) return { ok: false, reason: 'Enter the passcode.' };
  if (!PRICE_API_URL) return { ok: false, reason: 'No price service is configured to check it against.' };

  let token;
  try {
    token = await tokenFor(passcode);
  } catch {
    return { ok: false, reason: 'This browser cannot check a passcode — it needs a secure (https) connection.' };
  }

  let res;
  try {
    res = await fetch(PRICE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Token': token },
      body: JSON.stringify({ unlock: true }),
    });
  } catch {
    return { ok: false, reason: 'Could not reach the service to check it. Are you online?' };
  }

  if (res.status === 401) return { ok: false, reason: 'That passcode is not right.' };
  if (!res.ok) return { ok: false, reason: `Could not check it (${res.status}). Try again in a moment.` };

  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    return { ok: false, reason: 'This browser will not let the app remember anything.' };
  }
  return { ok: true };
}

/// Forgets the unlock on this device, so the next launch asks again.
export function forget() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored means nothing to forget.
  }
}

/// The header every call to the worker carries once unlocked.
export function authHeaders() {
  const token = storedToken();
  return token ? { 'X-App-Token': token } : {};
}
