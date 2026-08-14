// Peer sync setup: what room the devices meet in, and what protects it.
//
// The room name used to be eight characters of Math.random(), it travelled in the
// URL for the lifetime of the tab, and it was the only credential — anyone who saw
// it got read and write access to every list. It also went to the signalling server
// in the clear, so the server operator could enumerate rooms and join them.
//
// Now there is one secret, 256 bits from the platform CSPRNG. The room name is its
// SHA-256 digest, which is what the signalling server sees; the secret itself never
// leaves the device except in a link the user deliberately copies, and y-webrtc uses
// it to encrypt the connection handshake.

import { WebrtcProvider } from './vendor/sync.js';
import { SIGNALING_SERVERS } from './sync-config.js';

const SECRET_KEY = 'shopnest-link-secret';
const LEGACY_ROOM_KEY = 'shopnest-sync-room';

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

/// Returns the secret this device syncs with, creating one the first time.
///
/// A `link` parameter in the URL wins and is adopted permanently — that is how a
/// second device joins. The caller is expected to strip it from the URL afterwards
/// so the secret does not sit in browser history.
export function resolveLinkSecret(search) {
  const fromUrl = new URLSearchParams(search).get('link');
  if (fromUrl) {
    localStorage.setItem(SECRET_KEY, fromUrl);
    return fromUrl;
  }

  const stored = localStorage.getItem(SECRET_KEY);
  if (stored) return stored;

  // Devices paired under the old scheme keep working: their room name becomes the
  // secret, so both ends still derive the same room from it.
  const legacy = localStorage.getItem(LEGACY_ROOM_KEY);
  const secret = legacy || generateSecret();
  localStorage.setItem(SECRET_KEY, secret);
  return secret;
}

/// The room name peers subscribe to. A digest, so the signalling server learns
/// nothing that would let it join.
export async function deriveRoom(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return 'shopnest-' + base64Url(new Uint8Array(digest)).slice(0, 22);
}

/// Connects `ydoc` to its peers. Sync is an enhancement — the app is expected to
/// work with no network at all — so a failure here is reported and swallowed rather
/// than being allowed to take down the module that awaited it.
export async function connectPeers(ydoc, secret) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WebCrypto unavailable — needs a secure context');
  }
  const room = await deriveRoom(secret);
  return new WebrtcProvider(room, ydoc, {
    password: secret,
    signaling: [...SIGNALING_SERVERS],
  });
}

/// A secret for a document nobody has seen yet — a newly created list.
export function newSecret() {
  return generateSecret();
}
