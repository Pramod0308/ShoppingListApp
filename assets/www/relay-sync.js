// Changes that wait for the other phone.
//
// WebRTC only connects two devices that are both awake. Add bread on one phone while
// the other is in a pocket and there is nowhere for the change to go — it arrives the
// next time both happen to be open, which for a shopping list is the wrong moment.
// This is the other half: a room on the server that keeps updates until the device
// that missed them turns up.
//
// It runs *alongside* peer sync rather than replacing it. Yjs merges from as many
// sources as it likes, so the two cost nothing together: peers stay the fast path,
// and this is what makes the answer eventually arrive whether or not they connect.
//
// What leaves the device is ciphertext. The key comes from the room secret — the
// same one the share link carries — through HKDF, and the server has no way to get
// it. The room name is a digest of that secret under a different label, so the relay
// cannot line its rooms up with the signalling server's topics. The honest limit:
// the server learns how many updates of what size belong together, and when. It
// cannot read them.

import { Y } from './vendor/sync.js';
import { RELAY_SERVER } from './sync-config.js';

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_MS = 25000;

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const toBase64 = (bytes) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/// The room this secret meets in. Salted differently from the signalling topic so the
/// two services cannot be correlated by name.
export async function relayRoom(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`relay:${secret}`));
  return base64Url(new Uint8Array(digest)).slice(0, 22);
}

/// AES-GCM key for a room. HKDF rather than PBKDF2: the secret is 256 bits from the
/// platform CSPRNG, so there is nothing to slow an attacker down about.
async function keyFor(secret) {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('shopnest-relay'),
      info: new TextEncoder().encode('doc-updates'),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const packed = new Uint8Array(iv.length + body.length);
  packed.set(iv, 0);
  packed.set(body, iv.length);
  return toBase64(packed);
}

async function open(key, text) {
  const packed = fromBase64(text);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12),
  );
  return new Uint8Array(plain);
}

/// One socket for every document on the device, multiplexed by room.
///
/// A socket per list would mean a phone holding one connection per list it owns, all
/// of them waking the radio independently.
class Relay {
  #socket = null;
  #rooms = new Map(); // room -> { doc, key, seen }
  #retry = RECONNECT_MIN_MS;
  #timer = null;
  #ping = null;
  #closed = false;

  get connected() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  /// Registers a document. Safe to call before the socket is up: rooms are
  /// (re)joined on every connect.
  async add(doc, secret) {
    if (!RELAY_SERVER) return null;
    const room = await relayRoom(secret);
    if (this.#rooms.has(room)) return room;

    const key = await keyFor(secret);
    const entry = { doc, key, seen: 0 };
    this.#rooms.set(room, entry);

    // Anything this device changes goes up — except what came down from here, which
    // would otherwise bounce back to the server that just sent it.
    doc.on('update', (update, origin) => {
      if (origin === this) return;
      this.#publish(room, 'update', update);
    });

    if (this.connected) this.#join([room]);
    else this.#connect();
    return room;
  }

  remove(room) {
    this.#rooms.delete(room);
  }

  destroy() {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearInterval(this.#ping);
    this.#rooms.clear();
    try {
      this.#socket?.close();
    } catch {
      // Already gone.
    }
    this.#socket = null;
  }

  #connect() {
    if (this.#closed || this.#socket) return;
    let socket;
    try {
      socket = new WebSocket(RELAY_SERVER);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#retry = RECONNECT_MIN_MS;
      this.#join([...this.#rooms.keys()]);
      clearInterval(this.#ping);
      this.#ping = setInterval(() => {
        if (this.connected) socket.send(JSON.stringify({ type: 'ping' }));
      }, PING_MS);
    });

    socket.addEventListener('message', (event) => {
      this.#receive(event.data).catch(() => {
        // A message we cannot read is not a reason to drop the connection: it may
        // be from a room whose secret this device no longer holds.
      });
    });

    const dropped = () => {
      clearInterval(this.#ping);
      if (this.#socket === socket) this.#socket = null;
      this.#scheduleReconnect();
    };
    socket.addEventListener('close', dropped);
    socket.addEventListener('error', dropped);
  }

  #scheduleReconnect() {
    if (this.#closed || this.#rooms.size === 0) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), this.#retry);
    // Backing off rather than hammering: a server that is down stays down for a
    // while, and a phone that retries every second is a phone with a flat battery.
    this.#retry = Math.min(this.#retry * 2, RECONNECT_MAX_MS);
  }

  #join(rooms) {
    if (!this.connected || rooms.length === 0) return;
    this.#socket.send(JSON.stringify({ type: 'join', rooms }));
  }

  async #publish(room, type, update, replaces) {
    const entry = this.#rooms.get(room);
    if (!entry || !this.connected) return; // queued implicitly: the next connect sends full state
    const data = await seal(entry.key, update);
    if (!this.connected) return;
    this.#socket.send(JSON.stringify({ type, room, data, ...(replaces === undefined ? {} : { replaces }) }));
  }

  async #receive(raw) {
    const message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'pong') return;

    const entry = this.#rooms.get(message.room);
    if (!entry) return;

    if (message.type === 'sync') {
      for (const { seq, data } of message.updates ?? []) {
        await this.#apply(entry, seq, data);
      }
      // Now tell the room what this device knows. A phone that was the one making
      // changes while offline is how those changes reach everyone else.
      await this.#publish(message.room, 'update', Y.encodeStateAsUpdate(entry.doc));
      return;
    }

    if (message.type === 'update') {
      await this.#apply(entry, message.seq, message.data);
      return;
    }

    if (message.type === 'compact') {
      // The server cannot merge what it cannot read, so collapsing the log is the
      // client's job: one update carrying the whole document, standing in for every
      // update it covers.
      await this.#publish(
        message.room, 'snapshot', Y.encodeStateAsUpdate(entry.doc), message.upTo ?? 0,
      );
    }
  }

  async #apply(entry, seq, data) {
    const update = await open(entry.key, data);
    // `this` as the origin marks it as arriving from here, so the doc's own update
    // handler does not send it straight back.
    Y.applyUpdate(entry.doc, update, this);
    if (typeof seq === 'number') entry.seen = Math.max(entry.seen, seq);
  }
}

const relay = new Relay();

/// Keeps `doc` in step with every other device holding this secret, whether or not
/// any of them is awake right now. Failing is not fatal — peer sync and the local
/// copy carry on — so this reports and swallows.
export async function joinRelay(doc, secret) {
  if (!RELAY_SERVER) return null;
  try {
    return await relay.add(doc, secret);
  } catch (err) {
    console.warn('relay unavailable:', err?.message ?? err);
    return null;
  }
}

export function leaveRelay(room) {
  if (room) relay.remove(room);
}
