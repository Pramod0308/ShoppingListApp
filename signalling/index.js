// WebRTC signalling for ShopNest.
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('ShopNest signalling server — connect over WebSocket.', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // One room for everyone: peers are separated by topic, not by object, and
    // sharding by topic would break a client that subscribes to several at once.
    return env.SIGNALLING.getByName('shopnest').fetch(request);
  },
};
