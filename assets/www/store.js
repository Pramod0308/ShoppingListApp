// Documents, rooms, and everything that reads or writes them.
//
// There used to be one document holding every list and every item, synced in one
// room. That made "share this list" a lie: the link handed over the whole document,
// so sharing a shopping list with a flatmate also gave them everything else.
//
// Now each list is its own document with its own secret, and therefore its own room:
//
//   index document   one per user, synced in the device room. Holds, per list, the
//                    id, the list's secret, and where it sorts. Nothing readable.
//   list document    one per list, synced in a room derived from that list's secret.
//                    Holds the list's name and its items.
//
// Sharing a list hands over one list secret. Linking a device hands over the device
// secret, which reaches the index and therefore every list in it. The two are
// different actions with different blast radii, which is the point.

import { Y, IndexeddbPersistence } from './vendor/sync.js';
import { connectPeers, newSecret } from './peer-sync.js';
import { keyBetween, keysBetween } from './order-key.js';
import { applyTextEdit } from './text-sync.js';

const INDEX_DB = 'shopnest-index';
const LIST_DB = (id) => `shopnest-list-${id}`;
const LEGACY_DB = 'shopnest-db';
const MIGRATED_FLAG = 'shopnest-migrated-per-list';

const nowIso = () => new Date().toISOString();
const newId = (prefix) => prefix + Math.random().toString(36).substring(2, 9);
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Two devices adding a row while apart can arrive at the same key — each of them
// asked for "before everything" against the same neighbour. Ties break on id so the
// order is total, and every device therefore agrees on it.
const compare = (a, b) => byKey(a.order, b.order) || byKey(a.id, b.id);

export class Store {
  #indexDoc = new Y.Doc();
  #indexPersistence = null;
  #lists = new Map(); // id -> { doc, items, persistence, provider }
  #listeners = new Set();
  #deviceSecret = null;

  /// Fires whenever anything the UI renders may have changed.
  onChange(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.#listeners) fn();
  }

  get #index() {
    return this.#indexDoc.getMap('lists');
  }

  /// Loads the index, opens every list it names, and converts anything left over
  /// from the single-document era. Resolves once local storage has been read; peer
  /// connections continue to arrive afterwards.
  async open(deviceSecret) {
    this.#deviceSecret = deviceSecret;

    this.#indexPersistence = new IndexeddbPersistence(INDEX_DB, this.#indexDoc);
    await whenSynced(this.#indexPersistence);

    this.#indexDoc.getMap('lists').observeDeep(() => {
      this.#openMissingLists();
      this.#emit();
    });

    await this.#migrateSingleDocument();
    await this.#openMissingLists();

    connectPeers(this.#indexDoc, deviceSecret)
      .catch((err) => console.warn('index sync unavailable:', err.message));

    this.#emit();
  }

  #openMissingLists() {
    const wanted = new Set(this.#index.keys());

    for (const id of wanted) {
      const entry = this.#index.get(id);
      if (entry instanceof Y.Map) this.#ensureList(id, entry.get('secret'));
    }

    // A list removed from the index on another device stops being ours.
    for (const id of [...this.#lists.keys()]) {
      if (!wanted.has(id)) this.#closeList(id);
    }

    return Promise.all([...this.#lists.values()].map((h) => h.ready));
  }

  /// The document exists as soon as this returns; `handle.ready` resolves once its
  /// stored contents have been read back and its room has been joined.
  #ensureList(id, secret) {
    const existing = this.#lists.get(id);
    if (existing) return existing;

    const doc = new Y.Doc();
    const handle = { doc, items: doc.getMap('items'), persistence: null, provider: null };
    this.#lists.set(id, handle);

    doc.getMap('items').observeDeep(() => this.#emit());
    doc.getText('name').observe(() => this.#emit());

    handle.ready = (async () => {
      handle.persistence = new IndexeddbPersistence(LIST_DB(id), doc);
      await whenSynced(handle.persistence);
      this.#emit();
      if (!secret) return;
      try {
        handle.provider = await connectPeers(doc, secret);
      } catch (err) {
        console.warn(`list ${id} sync unavailable:`, err.message);
      }
    })();

    return handle;
  }

  #closeList(id) {
    const handle = this.#lists.get(id);
    if (!handle) return;
    handle.provider?.destroy();
    handle.persistence?.destroy();
    handle.doc.destroy();
    this.#lists.delete(id);
  }

  /* ---------- Who ----------

     A person is a name and a colour, nothing more: there is no account and no
     server to check one against. The profile lives in the index document, so all
     of one person's devices share a single identity; writing to a list copies it
     into that list's `people` map, so whoever a list is shared with can resolve
     names offline without contacting anyone.

     Names are self-asserted. Anyone holding a list's share link could claim any
     name — but they can already edit everything in it, so this is honest labelling
     among people who trust each other, not proof of identity.
     ---------------------------------- */

  get #profileMap() {
    return this.#indexDoc.getMap('profile');
  }

  profile() {
    const map = this.#profileMap;
    if (!map.get('id')) {
      this.#indexDoc.transact(() => {
        map.set('id', newId('who-'));
        map.set('name', defaultName());
        map.set('colour', Math.floor(Math.random() * COLOURS));
      });
    }
    return {
      id: map.get('id'),
      name: map.get('name') ?? '',
      colour: map.get('colour') ?? 0,
    };
  }

  /// Renaming has to reach every list already carrying the old name, or shared
  /// lists keep showing whoever this person used to be.
  setProfile({ name, colour }) {
    const map = this.#profileMap;
    this.profile();
    this.#indexDoc.transact(() => {
      if (typeof name === 'string') map.set('name', name.trim() || defaultName());
      if (typeof colour === 'number') map.set('colour', colour);
    });
    for (const id of this.#lists.keys()) this.#stampPerson(id);
    this.#emit();
  }

  /// Copies the current profile into a list's directory of people. Called on every
  /// write, so a name is present wherever that person has actually done something.
  #stampPerson(listId) {
    const handle = this.#lists.get(listId);
    if (!handle) return null;
    const me = this.profile();
    const people = handle.doc.getMap('people');
    const existing = people.get(me.id);
    if (!(existing instanceof Y.Map)) {
      people.set(me.id, mapOf({ name: me.name, colour: me.colour }));
    } else if (existing.get('name') !== me.name || existing.get('colour') !== me.colour) {
      handle.doc.transact(() => {
        existing.set('name', me.name);
        existing.set('colour', me.colour);
      });
    }
    return me.id;
  }

  /// personId -> { name, colour } for everyone who has touched this list.
  people(listId) {
    const handle = this.#lists.get(listId);
    const out = {};
    if (!handle) return out;
    handle.doc.getMap('people').forEach((person, id) => {
      if (person instanceof Y.Map) {
        out[id] = { name: person.get('name') ?? '', colour: person.get('colour') ?? 0 };
      }
    });
    return out;
  }

  /* ---------- Reading ---------- */

  /// Plain snapshots, so nothing outside this module has to know about Yjs types.
  /// `by` is 'custom' for the order the user dragged them into, or 'recent' for
  /// most recently touched first. Creating, renaming and editing items all stamp
  /// the index entry, so 'recent' tracks activity rather than just renames.
  lists(by = 'custom') {
    const out = [];
    this.#index.forEach((entry, id) => {
      if (!(entry instanceof Y.Map)) return;
      const handle = this.#lists.get(id);
      out.push({
        id,
        order: entry.get('order') ?? '',
        name: handle ? handle.doc.getText('name').toString() : '',
        updatedAt: entry.get('updated_at') ?? '',
        itemCount: handle ? this.activeItems(id).length : 0,
        // Someone who joined by share link has an index entry they wrote
        // themselves, so the creator has to come from inside the list.
        createdBy: entry.get('created_by')
          ?? (handle ? handle.doc.getMap('meta').get('created_by') ?? null : null),
        loaded: !!handle,
      });
    });

    if (by === 'recent') {
      // Fall back to the manual key so the order stays total when two entries
      // carry the same timestamp.
      return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : compare(a, b)));
    }
    return out.sort(compare);
  }

  listName(id) {
    return this.#lists.get(id)?.doc.getText('name').toString() ?? '';
  }

  hasList(id) {
    return this.#index.has(id);
  }

  /// Every item, including deleted ones — callers partition on `deleted`. Items
  /// written before soft delete existed have no `deleted_at` and read as active.
  items(id) {
    const handle = this.#lists.get(id);
    if (!handle) return [];
    const out = [];
    handle.items.forEach((item, itemId) => {
      if (!(item instanceof Y.Map)) return;
      const deletedAt = item.get('deleted_at') ?? null;
      out.push({
        id: itemId,
        text: item.get('text')?.toString() ?? '',
        done: item.get('done') === true,
        deleted: deletedAt !== null,
        deletedAt,
        authorId: item.get('author_id') ?? null,
        createdAt: item.get('created_at') ?? '',
        order: item.get('order') ?? '',
      });
    });
    return out.sort((a, b) => (a.done !== b.done ? (a.done ? 1 : -1) : compare(a, b)));
  }

  /// Deleted items, most recently removed first — the order that section reads in.
  deletedItems(id) {
    return this.items(id)
      .filter((i) => i.deleted)
      .sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  }

  /// Items still on the list, deleted ones excluded.
  activeItems(id) {
    return this.items(id).filter((i) => !i.deleted);
  }

  /* ---------- Lists ---------- */

  createList(name) {
    const id = newId('list-');
    const secret = newSecret();
    const first = this.lists()[0];

    this.#index.set(id, mapOf({
      id,
      secret,
      order: keyBetween(null, first ? first.order : null),
      created_at: nowIso(),
      updated_at: nowIso(),
    }));

    this.#ensureList(id, secret).doc.getText('name').insert(0, name);
    // Recorded on the index entry and inside the list, so someone the list is
    // shared with can see who made it without access to the owner's index.
    const me = this.#stampPerson(id);
    this.#index.get(id).set('created_by', me);
    this.#lists.get(id).doc.getMap('meta').set('created_by', me);
    this.#emit();
    return id;
  }

  renameList(id, name) {
    const handle = this.#lists.get(id);
    if (!handle) return;
    applyTextEdit((fn) => handle.doc.transact(fn), handle.doc.getText('name'), name);
    this.#touchIndex(id);
  }

  deleteList(id) {
    this.#index.delete(id);
    this.#closeList(id);
    indexedDB.deleteDatabase(LIST_DB(id));
    this.#emit();
  }

  /// Adds a list somebody shared. Returns the id, or null if it is already here.
  joinList(id, secret) {
    if (this.#index.has(id)) return null;
    const first = this.lists()[0];
    this.#index.set(id, mapOf({
      id,
      secret,
      order: keyBetween(null, first ? first.order : null),
      created_at: nowIso(),
      updated_at: nowIso(),
    }));
    this.#ensureList(id, secret).ready.then(() => this.#stampPerson(id));
    return id;
  }

  #touchIndex(id) {
    const entry = this.#index.get(id);
    if (entry instanceof Y.Map) entry.set('updated_at', nowIso());
  }

  /* ---------- Items ---------- */

  addItems(listId, lines) {
    const handle = this.#lists.get(listId);
    if (!handle || !lines.length) return;

    // New rows land above everything still outstanding, in the order they were typed.
    const firstOpen = this.activeItems(listId).find((i) => !i.done);
    const keys = keysBetween(null, firstOpen ? firstOpen.order : null, lines.length);
    const now = nowIso();
    const author = this.#stampPerson(listId);

    handle.doc.transact(() => {
      lines.forEach((line, idx) => {
        handle.items.set(newId('item-'), mapOf({
          done: false, created_at: now, updated_at: now, order: keys[idx],
          author_id: author,
        }, 'text', line));
      });
    });
    this.#touchIndex(listId);
  }

  /// Inserts an empty row directly after `afterId`. Returns its id.
  addItemAfter(listId, afterId) {
    const handle = this.#lists.get(listId);
    if (!handle) return null;

    const items = this.activeItems(listId);
    const at = items.findIndex((i) => i.id === afterId);
    if (at === -1) return null;

    const next = items[at + 1];
    // Only slot in ahead of the next row when it is in the same done/not-done group;
    // otherwise this row is the last of its group and the new one goes after it.
    const upper = next && next.done === items[at].done ? next.order : null;

    const id = newId('item-');
    const now = nowIso();
    handle.items.set(id, mapOf({
      done: items[at].done, created_at: now, updated_at: now,
      order: keyBetween(items[at].order, upper),
      author_id: this.#stampPerson(listId),
    }, 'text', ''));
    this.#touchIndex(listId);
    return id;
  }

  setItemText(listId, itemId, text) {
    const item = this.#item(listId, itemId);
    if (!item) return;
    applyTextEdit((fn) => this.#lists.get(listId).doc.transact(fn), item.get('text'), text);
    item.set('updated_at', nowIso());
    this.#touchIndex(listId);
  }

  toggleItem(listId, itemId) {
    const item = this.#item(listId, itemId);
    if (!item) return;
    this.#lists.get(listId).doc.transact(() => {
      item.set('done', item.get('done') !== true);
      item.set('updated_at', nowIso());
    });
    this.#touchIndex(listId);
  }

  /// Marks an item deleted rather than removing it, so it can be shown in the
  /// deleted section. purgeDeleted is the only thing that actually removes items.
  deleteItem(listId, itemId) {
    const item = this.#item(listId, itemId);
    if (!item) return;
    item.set('deleted_at', nowIso());
    this.#touchIndex(listId);
  }

  purgeDeleted(listId) {
    const handle = this.#lists.get(listId);
    if (!handle) return;
    const ids = this.deletedItems(listId).map((i) => i.id);
    handle.doc.transact(() => ids.forEach((id) => handle.items.delete(id)));
    this.#touchIndex(listId);
  }

  clearItems(listId, { doneOnly = false } = {}) {
    const handle = this.#lists.get(listId);
    if (!handle) return;
    const ids = this.activeItems(listId).filter((i) => !doneOnly || i.done).map((i) => i.id);
    const now = nowIso();
    handle.doc.transact(() => {
      for (const id of ids) this.#item(listId, id)?.set('deleted_at', now);
    });
    this.#touchIndex(listId);
  }

  /// Moves one row between two keys. Only the moved row is written — the old scheme
  /// renumbered every sibling on every drop.
  moveItem(listId, itemId, lowerKey, upperKey) {
    const item = this.#item(listId, itemId);
    if (!item) return null;
    const key = keyBetween(lowerKey, upperKey);
    item.set('order', key);
    this.#touchIndex(listId);
    return key;
  }

  moveList(id, lowerKey, upperKey) {
    const entry = this.#index.get(id);
    if (!(entry instanceof Y.Map)) return null;
    const key = keyBetween(lowerKey, upperKey);
    entry.set('order', key);
    return key;
  }

  #item(listId, itemId) {
    const item = this.#lists.get(listId)?.items.get(itemId);
    return item instanceof Y.Map ? item : null;
  }

  /* ---------- Links ---------- */

  deviceSecret() {
    return this.#deviceSecret;
  }

  /// The token that grants one list, and nothing else.
  shareToken(id) {
    const entry = this.#index.get(id);
    if (!(entry instanceof Y.Map)) return null;
    return `${id}~${entry.get('secret')}`;
  }

  static parseShareToken(token) {
    const at = token.indexOf('~');
    if (at < 1) return null;
    return { id: token.slice(0, at), secret: token.slice(at + 1) };
  }

  /* ---------- Migration ---------- */

  /// Converts the single document every list used to live in. Reads both shapes it
  /// went through: plain objects, and the per-entry Y.Maps that replaced them.
  async #migrateSingleDocument() {
    if (localStorage.getItem(MIGRATED_FLAG)) return;

    // Opening a database creates it. Don't leave an empty one behind on installs
    // that never had the old single document in the first place.
    if (indexedDB.databases) {
      const existing = await indexedDB.databases();
      if (!existing.some((db) => db.name === LEGACY_DB)) {
        localStorage.setItem(MIGRATED_FLAG, '1');
        return;
      }
    }

    const legacy = new Y.Doc();
    const persistence = new IndexeddbPersistence(LEGACY_DB, legacy);
    await whenSynced(persistence);

    const oldLists = legacy.getMap('lists');
    const oldItems = legacy.getMap('items');

    if (oldLists.size === 0) {
      localStorage.setItem(MIGRATED_FLAG, '1');
      persistence.destroy();
      legacy.destroy();
      return;
    }

    // Only Y.Text needs unwrapping. Running every field through toString would turn
    // the boolean `done` into the string "true", which is not the same thing.
    const read = (v, key) => {
      const field = v instanceof Y.Map ? v.get(key) : v?.[key];
      return field instanceof Y.Text ? field.toString() : field;
    };

    const listIds = [...oldLists.keys()];
    let listKey = null;

    for (const id of listIds) {
      const old = oldLists.get(id);
      listKey = keyBetween(listKey, null);

      const secret = newSecret();
      this.#index.set(id, mapOf({
        id,
        secret,
        order: listKey,
        created_at: read(old, 'created_at') ?? nowIso(),
        updated_at: read(old, 'updated_at') ?? nowIso(),
      }));

      const handle = this.#ensureList(id, secret);
      await handle.ready;
      const name = read(old, 'name') ?? 'Untitled list';
      // Guard against seeding twice if a previous run was interrupted.
      if (handle.doc.getText('name').length === 0) handle.doc.getText('name').insert(0, name);

      // Preserve the order the items were displayed in, whichever shape they are in.
      const mine = [];
      oldItems.forEach((item, itemId) => {
        if (read(item, 'list_id') !== id) return;
        mine.push({ itemId, item, order: read(item, 'order'), legacy: read(item, 'order_index') ?? 0 });
      });
      mine.sort((a, b) => (a.order && b.order ? byKey(a.order, b.order) : b.legacy - a.legacy));

      let itemKey = null;
      handle.doc.transact(() => {
        for (const { itemId, item } of mine) {
          itemKey = keyBetween(itemKey, null);
          handle.items.set(itemId, mapOf({
            done: read(item, 'done') === true,
            created_at: read(item, 'created_at') ?? nowIso(),
            updated_at: read(item, 'updated_at') ?? nowIso(),
            order: itemKey,
          }, 'text', read(item, 'text') ?? ''));
        }
      });
    }

    localStorage.setItem(MIGRATED_FLAG, '1');
    persistence.destroy();
    legacy.destroy();
  }
}

export const COLOURS = 8;

// There is no way to read a device name from a browser, so start from the platform
// and let it be edited. One person's devices share this via the index document, so
// two Macs belonging to the same person do not collide.
function defaultName() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Someone';
}

function mapOf(fields, textField, textValue) {
  const map = new Y.Map();
  for (const [k, v] of Object.entries(fields)) map.set(k, v);
  if (textField) map.set(textField, new Y.Text(textValue));
  return map;
}

function whenSynced(persistence) {
  // Resolve even where IndexedDB is unavailable (private browsing, a WebView with
  // storage switched off) rather than hanging the whole startup on it.
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    persistence.once('synced', done);
    setTimeout(done, 1500);
  });
}
