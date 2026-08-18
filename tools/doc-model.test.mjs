#!/usr/bin/env node
// Checks the document model's merge behaviour against two real Y.Docs:
// `node tools/doc-model.test.mjs`.
//
// The point of the model change is that concurrent edits stop destroying each
// other. That is invisible on one device, so it is tested by building two documents,
// editing both while they are apart, and merging them in both directions.

import * as Y from 'yjs';
import { applyTextEdit } from '../assets/www/text-sync.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (!ok) {
    failures++;
    console.error(`FAIL ${label} ${detail}`);
  } else {
    console.log(`  ok  ${label}`);
  }
}

// Two devices holding the same document, able to be synced on demand.
function pair(seed) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  seed(a);
  sync(a, b);
  return [a, b];
}

function sync(a, b) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const item = (doc, id = 'item-1') => doc.getMap('items').get(id);
const edit = (doc, ytext, next) => applyTextEdit((fn) => doc.transact(fn), ytext, next);

function seedOneItem(text = 'milk') {
  return (doc) => {
    const map = new Y.Map();
    doc.getMap('items').set('item-1', map);
    map.set('id', 'item-1');
    map.set('list_id', 'list-1');
    map.set('done', false);
    map.set('order', 'i');
    map.set('text', new Y.Text(text));
  };
}

// 1. Different fields of the same row. Under the old whole-object writes, whichever
//    update was applied second reinstated its own stale copy of the other field.
{
  const [a, b] = pair(seedOneItem('milk'));
  edit(a, item(a).get('text'), 'whole milk');
  item(b).set('done', true);
  sync(a, b);

  check('field edits on one row both survive',
    item(a).get('text').toString() === 'whole milk' && item(a).get('done') === true,
    `text=${item(a).get('text')} done=${item(a).get('done')}`);
  check('both devices agree',
    item(b).get('text').toString() === item(a).get('text').toString() &&
    item(b).get('done') === item(a).get('done'));
}

// 2. Two people typing in the same row. Neither edit may vanish outright.
{
  const [a, b] = pair(seedOneItem('milk'));
  edit(a, item(a).get('text'), 'milk 2L');   // appended
  edit(b, item(b).get('text'), 'oat milk');  // prepended
  sync(a, b);

  const merged = item(a).get('text').toString();
  check('concurrent typing keeps both edits',
    merged.includes('oat') && merged.includes('2L'), `merged=${JSON.stringify(merged)}`);
  check('concurrent typing converges',
    merged === item(b).get('text').toString());
}

// 3. A row moved on one device while its text is edited on the other.
{
  const [a, b] = pair(seedOneItem('milk'));
  item(a).set('order', 'z');
  edit(b, item(b).get('text'), 'milk, semi-skimmed');
  sync(a, b);

  check('reorder and rename do not collide',
    item(a).get('order') === 'z' &&
    item(a).get('text').toString() === 'milk, semi-skimmed',
    `order=${item(a).get('order')} text=${item(a).get('text')}`);
}

// 4. Ordering is independent per row, so two devices reordering different rows do
//    not fight. The old scheme renumbered every sibling on each drop.
{
  const seed = (doc) => {
    const items = doc.getMap('items');
    ['a', 'b', 'c'].forEach((id, idx) => {
      const map = new Y.Map();
      items.set(id, map);
      map.set('id', id);
      map.set('order', ['c', 'i', 'r'][idx]);
      map.set('text', new Y.Text(id));
    });
  };
  const [a, b] = pair(seed);
  item(a, 'a').set('order', 'u'); // a moves to the end on one device
  item(b, 'c').set('order', '5'); // c moves to the front on the other
  sync(a, b);

  const order = (doc) =>
    [...doc.getMap('items').values()]
      .sort((x, y) => (x.get('order') < y.get('order') ? -1 : 1))
      .map((m) => m.get('id'))
      .join('');

  check('independent moves both apply', order(a) === 'cba', `order=${order(a)}`);
  check('independent moves converge', order(a) === order(b));
}

// 5. Two devices adding a row while apart can land on the same key: each asked for
//    "before everything" against the same neighbour. The order still has to be
//    total and identical on both, which is what the id tie-break is for.
{
  const seed = (doc) => {
    const map = new Y.Map();
    doc.getMap('items').set('existing', map);
    map.set('id', 'existing');
    map.set('order', 'r');
  };
  const [a, b] = pair(seed);
  for (const [doc, id] of [[a, 'from-a'], [b, 'from-b']]) {
    const map = new Y.Map();
    doc.getMap('items').set(id, map);
    map.set('id', id);
    map.set('order', 'c'); // both computed keyBetween(null, 'r')
  }
  sync(a, b);

  const byKey = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const order = (doc) =>
    [...doc.getMap('items').values()]
      .sort((x, y) => byKey(x.get('order'), y.get('order')) || byKey(x.get('id'), y.get('id')))
      .map((m) => m.get('id'))
      .join(',');

  check('colliding keys still order totally', order(a) === 'from-a,from-b,existing', `order=${order(a)}`);
  check('colliding keys order the same on both devices', order(a) === order(b));
}

// 6. The edit narrowing itself: only the changed run is written, so an edit at the
//    end of a long string does not rewrite the start of it.
{
  const doc = new Y.Doc();
  const text = doc.getText('t');
  text.insert(0, 'the quick brown fox');

  let deltaLength = 0;
  text.observe((event) => {
    for (const op of event.delta) {
      if (op.insert) deltaLength += op.insert.length;
      if (op.delete) deltaLength += op.delete;
    }
  });
  edit(doc, text, 'the quick brown foxes');

  check('edit touches only what changed', deltaLength === 2, `delta covered ${deltaLength} chars`);
  check('edit produces the right value', text.toString() === 'the quick brown foxes');

  check('no-op edit writes nothing', edit(doc, text, 'the quick brown foxes') === false);
}

console.log(failures === 0 ? 'doc-model: all checks passed' : `doc-model: ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
