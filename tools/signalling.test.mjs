// Drives the signalling worker exactly as y-webrtc's own server does, against a
// locally running copy:
//
//   cd signalling && npx wrangler dev --local --port 8799
//   node tools/signalling.test.mjs
//
// Not part of `npm test`, because it needs that server up.
import WebSocket from 'ws';

const URL = 'ws://localhost:8799';
let failures = 0;
const check = (label, ok, detail='') => {
  if (!ok) { failures++; console.error(`FAIL ${label} ${detail}`); }
  else console.log(`  ok  ${label}`);
};
const open = () => new Promise((res, rej) => {
  const ws = new WebSocket(URL);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});
const next = (ws, ms = 2500) => new Promise((res) => {
  const t = setTimeout(() => res(null), ms);
  ws.once('message', (d) => { clearTimeout(t); res(JSON.parse(d.toString())); });
});

const a = await open();
const b = await open();
const c = await open();

// 1. ping/pong keeps y-webrtc's connection alive
a.send(JSON.stringify({ type: 'ping' }));
check('ping is answered with pong', (await next(a))?.type === 'pong');

// 2. a publish reaches another subscriber of the same topic
a.send(JSON.stringify({ type: 'subscribe', topics: ['room-1'] }));
b.send(JSON.stringify({ type: 'subscribe', topics: ['room-1'] }));
c.send(JSON.stringify({ type: 'subscribe', topics: ['room-2'] }));
await new Promise(r => setTimeout(r, 300));

const heardByB = next(b);
const heardByC = next(c, 800);
a.send(JSON.stringify({ type: 'publish', topic: 'room-1', data: 'offer-payload' }));

const gotB = await heardByB;
check('a subscriber receives the publish', gotB?.data === 'offer-payload', JSON.stringify(gotB));
check('the relay reports how many are on the topic', gotB?.clients === 2, `clients=${gotB?.clients}`);
check('a different topic hears nothing', (await heardByC) === null);

// 3. unsubscribe stops delivery
b.send(JSON.stringify({ type: 'unsubscribe', topics: ['room-1'] }));
await new Promise(r => setTimeout(r, 300));
const afterUnsub = next(b, 800);
a.send(JSON.stringify({ type: 'publish', topic: 'room-1', data: 'second' }));
check('unsubscribe stops delivery', (await afterUnsub) === null);

// 4. one socket can hold several topics at once, which the app relies on:
//    a device room plus a room per list.
b.send(JSON.stringify({ type: 'subscribe', topics: ['room-1', 'room-2', 'room-3'] }));
await new Promise(r => setTimeout(r, 300));
const onThird = next(b);
c.send(JSON.stringify({ type: 'subscribe', topics: ['room-3'] }));
await new Promise(r => setTimeout(r, 200));
c.send(JSON.stringify({ type: 'publish', topic: 'room-3', data: 'third' }));
check('multiple topics per socket', (await onThird)?.data === 'third');

// 5. malformed input must not kill the connection
a.send('not json at all');
await new Promise(r => setTimeout(r, 200));
a.send(JSON.stringify({ type: 'ping' }));
check('garbage does not drop the connection', (await next(a))?.type === 'pong');

[a,b,c].forEach(s => s.close());
console.log(failures === 0 ? 'signalling: all checks passed' : `signalling: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
