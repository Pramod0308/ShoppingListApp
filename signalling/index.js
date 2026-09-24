// WebRTC signalling for ShopIt.
//
// Peers cannot find each other without an introducer. The app has been using the
// public y-webrtc demo servers, which are frequently unreachable — this is the same
// protocol, running somewhere you control.
//
// A signalling server only relays connection offers between peers subscribed to the
// same topic. Topics are SHA-256 digests of a room secret (see peer-sync.js) and the
// offers are encrypted with that secret, so this server sees neither the secret nor
// any list content. It is a switchboard, not a database — nothing is stored.
//
// Everyone must meet in one place for that relaying to work, which is exactly what a
// Durable Object provides: one instance, all sockets, no shared-state problem.
//
// One object for the whole service is normally an anti-pattern — it is a single
// coordination point rather than one per room. It is deliberate here: a y-webrtc
// client opens one socket and subscribes it to several topics at once (this app uses
// a device room plus a room per list), so sharding by topic would split a single
// socket across objects it cannot be in. The ceiling is the free plan's 100k
// requests/day, which is far beyond a household; a large deployment would need a
// session-object-per-client fanning out to a topic-object-per-room.

import { DurableObject } from 'cloudflare:workers';

const PROTOCOL = ['subscribe', 'unsubscribe', 'publish', 'ping'];

// serializeAttachment caps at 16KB. Topics are ~35 bytes each, so this is roughly
// 460 rooms on one socket — far past anything real, but bounded rather than silently
// failing to serialize.
const MAX_TOPICS = 400;

export class SignallingRoom extends DurableObject {

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Hibernation: the object may be evicted between messages, so a socket's
    // subscriptions travel with the socket rather than living in memory here.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment([]);

    return new Response(null, { status: 101, webSocket: client });
  }

  topicsOf(ws) {
    try {
      const topics = ws.deserializeAttachment();
      return Array.isArray(topics) ? topics : [];
    } catch {
      return [];
    }
  }

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // not our protocol; ignore rather than dropping the connection
    }
    if (!message || !PROTOCOL.includes(message.type)) return;

    if (message.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    if (message.type === 'subscribe' || message.type === 'unsubscribe') {
      const asked = Array.isArray(message.topics) ? message.topics.filter((t) => typeof t === 'string') : [];
      const current = new Set(this.topicsOf(ws));
      for (const topic of asked) {
        if (message.type === 'subscribe') {
          if (current.size >= MAX_TOPICS) break;
          current.add(topic);
        } else {
          current.delete(topic);
        }
      }
      ws.serializeAttachment([...current]);
      return;
    }

    // publish: relay verbatim to everyone on the topic, including the sender —
    // y-webrtc uses the `clients` count to decide whether anyone else is there.
    if (!message.topic) return;
    const receivers = this.ctx
      .getWebSockets()
      .filter((peer) => this.topicsOf(peer).includes(message.topic));

    const payload = JSON.stringify({ ...message, clients: receivers.length });
    for (const peer of receivers) {
      try {
        peer.send(payload);
      } catch {
        // A socket that has gone away is not this connection's problem.
      }
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Subscriptions live on the socket, so nothing to clean up.
  }

  async webSocketError() {}
}

/* ============================================================
   The relay.

   Signalling introduces two peers who are both there. That is the whole limit of
   WebRTC for a shopping list: add bread on one phone while the other is in a pocket
   and there is nowhere for the change to wait. Both must be awake at the same moment,
   and with STUN but no TURN two phones on mobile data often cannot reach each other
   even then.

   So this keeps the changes. A client sends its document updates here, they are
   stored, and the next client to connect is given everything it missed.

   What it stores is ciphertext. The server has no key and no way to get one: the key
   is derived from the room secret, which lives on the devices and in the share link
   and never reaches here. The room name is a digest of that same secret, so the only
   thing this object learns is that some number of anonymous updates of some size
   belong together. That is the price of durability, and it is worth being explicit
   that it is a price: the signalling object above genuinely sees nothing, and this
   one sees shapes.

   It cannot merge what it cannot read, so the log is append-only and clients are
   asked to collapse it: a snapshot is one client's whole document, and it replaces
   every update it covers.
   ============================================================ */

// Where the log is asked to collapse, and where it is made to.
const COMPACT_AT = 40;
const FORCE_COMPACT_AT = 400;
// Room names are digests; updates are base64. A shopping list is orders of magnitude
// under this, so anything near it is not this app.
const MAX_ROOM_NAME = 128;
const MAX_PAYLOAD = 64 * 1024;
const MAX_ROOMS_PER_SOCKET = 100;

const seqKey = (room, seq) => `u:${room}:${String(seq).padStart(12, '0')}`;

export class RelayRoom extends DurableObject {

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment([]);
    return new Response(null, { status: 101, webSocket: client });
  }

  roomsOf(ws) {
    try {
      const rooms = ws.deserializeAttachment();
      return Array.isArray(rooms) ? rooms : [];
    } catch {
      return [];
    }
  }

  async nextSeq(room) {
    const next = (await this.ctx.storage.get(`n:${room}`)) ?? 1;
    await this.ctx.storage.put(`n:${room}`, next + 1);
    return next;
  }

  async storedUpdates(room) {
    const rows = await this.ctx.storage.list({ prefix: `u:${room}:` });
    return [...rows.entries()].map(([key, data]) => ({
      seq: Number(key.slice(key.lastIndexOf(':') + 1)),
      data,
    }));
  }

  send(ws, message) {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // A socket that has gone away is not this connection's problem.
    }
  }

  broadcast(room, message, except) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === except) continue;
      if (this.roomsOf(peer).includes(room)) this.send(peer, message);
    }
  }

  async webSocketMessage(ws, raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'ping') {
      this.send(ws, { type: 'pong' });
      return;
    }

    if (message.type === 'join') {
      const asked = (Array.isArray(message.rooms) ? message.rooms : [])
        .filter((r) => typeof r === 'string' && r.length > 0 && r.length <= MAX_ROOM_NAME);
      const rooms = new Set(this.roomsOf(ws));
      for (const room of asked) {
        if (rooms.size >= MAX_ROOMS_PER_SOCKET) break;
        rooms.add(room);
      }
      ws.serializeAttachment([...rooms]);

      // Everything this device missed while it was closed.
      for (const room of asked) {
        if (!rooms.has(room)) continue;
        const updates = await this.storedUpdates(room);
        this.send(ws, { type: 'sync', room, updates });
      }
      return;
    }

    const room = typeof message.room === 'string' ? message.room : null;
    if (!room || !this.roomsOf(ws).includes(room)) return;
    if (typeof message.data !== 'string' || message.data.length > MAX_PAYLOAD) return;

    if (message.type === 'snapshot') {
      // One client's whole document, standing in for everything up to `replaces`.
      // Updates that arrived after it was taken are left alone.
      const replaces = Number.isInteger(message.replaces) ? message.replaces : 0;
      const stale = (await this.storedUpdates(room)).filter((u) => u.seq <= replaces);
      if (stale.length) await this.ctx.storage.delete(stale.map((u) => seqKey(room, u.seq)));

      const seq = await this.nextSeq(room);
      await this.ctx.storage.put(seqKey(room, seq), message.data);
      this.broadcast(room, { type: 'update', room, seq, data: message.data }, ws);
      return;
    }

    if (message.type !== 'update') return;

    const existing = await this.storedUpdates(room);
    // A log nobody has collapsed. Refusing the write rather than dropping the oldest
    // entries: old updates are what a device that has been away for a week still
    // needs, and the snapshot this asks for carries the refused change anyway.
    if (existing.length >= FORCE_COMPACT_AT) {
      this.send(ws, { type: 'compact', room, upTo: existing[existing.length - 1]?.seq ?? 0, required: true });
      return;
    }

    const seq = await this.nextSeq(room);
    await this.ctx.storage.put(seqKey(room, seq), message.data);
    this.broadcast(room, { type: 'update', room, seq, data: message.data }, ws);

    if (existing.length + 1 >= COMPACT_AT) {
      this.send(ws, { type: 'compact', room, upTo: seq, required: false });
    }
  }

  async webSocketClose() {}
  async webSocketError() {}
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('ShopIt signalling server — connect over WebSocket.', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // The relay is a different service on a different path: one socket per device
    // rather than one per list, multiplexed by room the same way signalling is.
    if (url.pathname === '/relay') {
      return env.RELAY.getByName('shopnest-relay').fetch(request);
    }

    // One room for everyone: peers are separated by topic, not by object, and
    // sharding by topic would break a client that subscribes to several at once.
    return env.SIGNALLING.getByName('shopnest').fetch(request);
  },
};
