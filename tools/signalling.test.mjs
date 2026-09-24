// Drives the signalling worker — both halves of it — against a locally running copy.
//
// The switchboard half speaks exactly what y-webrtc's own server does. The relay half
// is what makes a change survive the other device being closed, which is the one
// thing peer-to-peer sync cannot do.
//
//   cd signalling && npx wrangler dev --local --port 8799
//   node tools/signalling.test.mjs
//
// Or against the deployed one:
//
//   SIGNAL_URL=wss://shopnest-signalling.example.workers.dev node tools/signalling.test.mjs
//
// Not part of `npm test`, because it needs a server up.
import WebSocket from 'ws';

const URL = process.env.SIGNAL_URL || 'ws://localhost:8799';
const RELAY_URL = `${URL.replace(/\/$/, '')}/relay`;
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

/* ---------- the relay ----------

   The property under test is the one peer sync cannot give: a change made while the
   other device is closed is still there when it opens. Everything else here is in
   service of that. */

const openRelay = () => new Promise((res, rej) => {
  const ws = new WebSocket(RELAY_URL);
  ws.on('open', () => res(ws));
  ws.on('error', rej);
});

// The object keeps its storage between runs, so rooms are unique per run or a second
// run reads the first one's updates.
const room = `r-${Math.random().toString(36).slice(2, 10)}`;

{
  const one = await openRelay();
  one.send(JSON.stringify({ type: 'join', rooms: [room] }));
  const empty = await next(one);
  check('joining a room nobody has used syncs nothing', empty?.type === 'sync' && empty.updates.length === 0,
    JSON.stringify(empty));

  // The device that is awake sees it immediately.
  const two = await openRelay();
  two.send(JSON.stringify({ type: 'join', rooms: [room] }));
  await next(two);
  one.send(JSON.stringify({ type: 'update', room, data: 'aGVsbG8=' }));
  const live = await next(two);
  check('an update reaches a device that is already there',
    live?.type === 'update' && live.data === 'aGVsbG8=', JSON.stringify(live));

  // And the one that was not.
  one.close();
  two.close();
  const later = await openRelay();
  later.send(JSON.stringify({ type: 'join', rooms: [room] }));
  const caught = await next(later);
  check('a device that was closed gets what it missed',
    caught?.type === 'sync' && caught.updates.length === 1 && caught.updates[0].data === 'aGVsbG8=',
    JSON.stringify(caught));
  later.close();
}

{
  // Rooms are separate: one secret's updates never reach another's.
  const other = `r-${Math.random().toString(36).slice(2, 10)}`;
  const mine = await openRelay();
  const theirs = await openRelay();
  mine.send(JSON.stringify({ type: 'join', rooms: [room] }));
  theirs.send(JSON.stringify({ type: 'join', rooms: [other] }));
  await next(mine);
  await next(theirs);
  mine.send(JSON.stringify({ type: 'update', room, data: 'c2VjcmV0' }));
  check('an update stays in its own room', (await next(theirs, 1200)) === null);

  // And publishing to a room you never joined does nothing.
  theirs.send(JSON.stringify({ type: 'update', room, data: 'aW50cnVkZXI=' }));
  check('a room you have not joined cannot be written to', (await next(mine, 1200)) === null);
  mine.close();
  theirs.close();
}

{
  // The log cannot be merged by a server that cannot read it, so clients are asked
  // to collapse it. Without that a long-lived list grows without limit.
  const busy = `r-${Math.random().toString(36).slice(2, 10)}`;
  const ws = await openRelay();
  // next() attaches a listener per call and this loop makes dozens of them; node
  // warns about a leak otherwise, which is noise rather than a finding.
  ws.setMaxListeners(60);
  ws.send(JSON.stringify({ type: 'join', rooms: [busy] }));
  await next(ws);

  let compact = null;
  for (let i = 0; i < 45 && !compact; i++) {
    ws.send(JSON.stringify({ type: 'update', room: busy, data: btoa(`u${i}`) }));
    const reply = await next(ws, 1500);
    if (reply?.type === 'compact') compact = reply;
  }
  check('a long log asks to be collapsed', compact !== null, 'no compact hint arrived');

  // A snapshot stands in for everything it covers.
  ws.send(JSON.stringify({ type: 'snapshot', room: busy, data: btoa('whole doc'), replaces: compact?.upTo ?? 0 }));
  await new Promise((r) => setTimeout(r, 400));
  ws.close();

  const after = await openRelay();
  after.send(JSON.stringify({ type: 'join', rooms: [busy] }));
  const synced = await next(after);
  check('and the log it replaces is gone',
    synced?.updates?.length === 1 && atob(synced.updates[0].data) === 'whole doc',
    `${synced?.updates?.length} updates left`);
  after.close();
}

{
  const ws = await openRelay();
  const big = `r-${Math.random().toString(36).slice(2, 10)}`;
  ws.send(JSON.stringify({ type: 'join', rooms: [big] }));
  await next(ws);
  ws.send(JSON.stringify({ type: 'update', room: big, data: 'x'.repeat(70 * 1024) }));
  await new Promise((r) => setTimeout(r, 400));
  ws.close();

  const check2 = await openRelay();
  check2.send(JSON.stringify({ type: 'join', rooms: [big] }));
  const synced = await next(check2);
  check('an oversized payload is refused rather than stored', synced?.updates?.length === 0,
    `${synced?.updates?.length} stored`);
  check2.close();
}

console.log(failures === 0 ? 'signalling: all checks passed' : `signalling: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
