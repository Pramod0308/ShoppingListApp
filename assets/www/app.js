// Bundled locally by `npm run build:vendor` — the app has to start with no network.
import { Store } from "./store.js";
import { resolveLinkSecret } from "./peer-sync.js";
import { PUBLIC_BASE_URL } from "./sync-config.js";

const store = new Store();
const linkSecret = resolveLinkSecret(location.search);

// The bundle is loaded from a loopback server inside the mobile shell, where the
// URL means nothing to anyone else. It is the source of truth on the web, so every
// write is best-effort and never allowed to take the app down with it.
function writeUrl(href, { replace = false } = {}) {
  try {
    if (replace) history.replaceState({}, '', href);
    else history.pushState({}, '', href);
    return true;
  } catch {
    return false;
  }
}

// Secrets have been read into storage by now, so take them back out of the URL
// rather than leaving them in the address bar, in history and in any screenshot.
const incomingShare = new URLSearchParams(location.search).get('join');
if (incomingShare || new URLSearchParams(location.search).has('link')) {
  const cleaned = new URL(location.href);
  cleaned.searchParams.delete('link');
  cleaned.searchParams.delete('join');
  writeUrl(cleaned.href, { replace: true });
}

// The service worker is for the published web app. Inside the mobile shell the
// bundle already comes off disk through a loopback server, so a cache in front of
// it would only serve yesterday's build after an app update.
if ('serviceWorker' in navigator && !['localhost', '127.0.0.1'].includes(location.hostname)) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('service worker registration failed:', err.message);
    });
  });
}

/* ---------- Elements (HOME) ---------- */
const homeSection       = document.getElementById('home');
const listsGrid         = document.getElementById('listsGrid');
const newListNameEl     = document.getElementById('newListName');
const createListBtn     = document.getElementById('createListBtn');
const themeToggle       = document.getElementById('themeToggle');
const linkDeviceBtn     = document.getElementById('linkDevice');

/* ---------- Elements (LIST VIEW) ---------- */
const listView          = document.getElementById('listView');
const backHomeBtn       = document.getElementById('backHome');
const listNameEl        = document.getElementById('listName');
const shareBtn          = document.getElementById('shareBtn');
const themeToggle2      = document.getElementById('themeToggle2');
const toggleDatesBtn    = document.getElementById('toggleDates');
const inputEl           = document.getElementById('itemInput');      // textarea
const addBtn            = document.getElementById('addBtn');
const remainingEl       = document.getElementById('remaining');
const clearAllBtn       = document.getElementById('clearAll');
const clearCompletedBtn = document.getElementById('clearCompleted');
const listEl            = document.getElementById('list');

/* ---------- Helpers ---------- */
const qs  = (k) => new URLSearchParams(location.search).get(k);
const fmt = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleString() : '…';
};
const root   = document.documentElement;

/* ============================================================
   ROUTING

   Which view is showing is held here, not read back out of the URL. Reloading the
   page to navigate used to drop writes that had not reached IndexedDB yet, and a
   file:// URL carrying a query string does not resolve reliably in a WebView, so
   both views now swap in place. The URL still tracks the route for shareable links
   on the web, but nothing reads it after startup.
   ============================================================ */
let listId = qs('list');

function routeUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('list', id);
  else url.searchParams.delete('list');
  return url.href;
}

function openList(id) {
  listId = id;
  writeUrl(routeUrl(id));
  showListView();
}

function goHome() {
  listId = null;
  writeUrl(routeUrl(null));
  showHome();
}

// The browser back button on the web, and the hardware back gesture on Android via
// the shell below.
window.addEventListener('popstate', () => {
  listId = qs('list');
  if (listId) showListView();
  else showHome();
});

// Called by the Flutter shell when Android's back gesture fires. Returns true when
// the web app consumed it; false tells the shell to close the app.
window.__shopnestBack = () => {
  if (!listId) return false;
  goHome();
  return true;
};

/* ============================================================
   THEME & TIMESTAMPS
   ============================================================ */
function applyTheme(t) {
  if (t === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
  localStorage.setItem('theme', t);
}
const storedTheme = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(storedTheme);
[themeToggle, themeToggle2].forEach(b => b && (b.onclick = () => {
  applyTheme(root.classList.contains('dark') ? 'light' : 'dark');
}));

let showTimestamps = localStorage.getItem('showTimestamps') !== '0';
function applyTimestampPref() {
  document.body.classList.toggle('hide-meta', !showTimestamps);
  if (toggleDatesBtn) {
    toggleDatesBtn.title = showTimestamps ? 'Hide timestamps' : 'Show timestamps';
    toggleDatesBtn.innerHTML = showTimestamps
      ? '<span class="material-symbols-outlined">schedule</span>'
      : '<span class="material-symbols-outlined">visibility_off</span>';
  }
}
applyTimestampPref();
if (toggleDatesBtn) {
  toggleDatesBtn.onclick = () => {
    showTimestamps = !showTimestamps;
    localStorage.setItem('showTimestamps', showTimestamps ? '1' : '0');
    applyTimestampPref();
  };
}

/* ============================================================
   RENDERING

   Rows are reconciled by id instead of being thrown away and rebuilt. Wiping the
   container on every change meant that any edit arriving from another device — or
   from the row next door — destroyed whatever input the user was typing in.
   ============================================================ */

// Writes a value into an input without disturbing the caret when the user is in it.
function setInputValue(input, value) {
  if (input.value === value) return;
  if (document.activeElement !== input) {
    input.value = value;
    return;
  }
  const start = input.selectionStart ?? value.length;
  const end = input.selectionEnd ?? start;
  input.value = value;
  try {
    input.setSelectionRange(Math.min(start, value.length), Math.min(end, value.length));
  } catch {
    // Inputs that do not support selection ranges; nothing to preserve.
  }
}

// Keyed reconciliation. `cache` maps id -> element and is mutated in place.
function reconcile(container, entries, cache, create, update) {
  const seen = new Set();
  let previous = null;

  for (const entry of entries) {
    const id = entry.id;
    seen.add(id);

    let el = cache.get(id);
    if (!el) {
      el = create(entry);
      cache.set(id, el);
    }
    update(el, entry);

    const shouldFollow = previous ? previous.nextElementSibling : container.firstElementChild;
    if (shouldFollow !== el) container.insertBefore(el, shouldFollow);
    previous = el;
  }

  for (const [id, el] of cache) {
    if (!seen.has(id)) {
      el.remove();
      cache.delete(id);
    }
  }
}

/* ============================================================
   HOME (lists)
   ============================================================ */
const listRows = new Map();
let emptyStateEl = null;

function createList() {
  const name = (newListNameEl?.value || '').trim() || 'My Shopping List';
  newListNameEl.value = '';
  openList(store.createList(name));
}

// Links are built against the published origin, not location.origin: inside the
// mobile shell the page is served from a loopback server, and a localhost URL means
// nothing on the device it gets sent to.
function publicUrl(param, value) {
  const url = new URL(PUBLIC_BASE_URL);
  url.searchParams.set(param, value);
  return url.href;
}

function offerLink(url, message) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url)
      .then(() => showToast(message))
      .catch(() => prompt('Copy this link:', url));
  } else {
    prompt('Copy this link:', url);
  }
}

// One list, and only that list.
function shareList(id) {
  const token = store.shareToken(id);
  if (!token) return;
  offerLink(publicUrl('join', token), 'Link copied — it opens this list only.');
}

// The whole index, and therefore every list in it. A different blast radius from
// sharing a list, so it says so.
function copyDeviceLink() {
  offerLink(publicUrl('link', linkSecret), 'Device link copied — it carries every list. Keep it to your own devices.');
}

function deleteList(id) {
  if (!confirm('Delete this list (and all its items)?')) return;
  store.deleteList(id);
}

function renameList(id, newName) {
  store.renameList(id, (newName || '').trim() || 'Untitled list');
}

function createListCard(list) {
  const id = list.id;

  const card = document.createElement('div');
  card.className = 'card-list group bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-300 relative cursor-pointer';
  card.dataset.id = id;

  const rowTop = document.createElement('div');
  rowTop.className = 'row-top flex items-center justify-start gap-2 mb-4';

  const drag = document.createElement('div');
  drag.className = 'drag p-2 rounded-lg cursor-grab text-outline-variant active:cursor-grabbing hover:text-primary hover:bg-surface-container transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
  drag.tabIndex = 0;
  drag.setAttribute('aria-label', 'Reorder list (Press Space to grab)');
  drag.innerHTML = '<span class="material-symbols-outlined">drag_indicator</span>';

  const title = document.createElement('h3');
  title.className = 'font-headline-sm text-[20px] text-on-surface flex-1 truncate font-bold outline-none focus:bg-surface-container-high rounded px-1 -ml-1';
  title.title = 'Double-click to rename. Enter to save.';
  title.contentEditable = 'false';
  title.addEventListener('dblclick', () => {
    title.contentEditable = 'true';
    title.focus();
    document.execCommand('selectAll', false, null);
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { title.contentEditable = 'false'; title.blur(); }
  });
  title.addEventListener('blur', () => {
    if (title.isContentEditable) {
      title.contentEditable = 'false';
      renameList(id, title.textContent || '');
    }
  });

  rowTop.append(drag, title);

  const meta = document.createElement('div');
  meta.className = 'muted flex items-center gap-2 text-on-surface-variant text-[12px] font-medium mb-6';
  const countEl = document.createElement('span');
  countEl.className = 'flex items-center gap-1';
  const updatedEl = document.createElement('span');
  updatedEl.className = 'flex items-center gap-1';
  const dot = document.createElement('span');
  dot.className = 'h-1 w-1 bg-outline-variant rounded-full';
  meta.append(countEl, dot, updatedEl);

  const actions = document.createElement('div');
  actions.className = 'actions flex items-center gap-2 pt-4 border-t border-outline-variant/20';

  const openBtn = document.createElement('button');
  openBtn.className = 'icon-btn primary flex-1 py-2 bg-primary-container text-on-primary-container rounded-lg font-medium text-center hover:brightness-105 transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px] border-transparent';
  openBtn.textContent = 'Open';
  openBtn.onclick = (e) => { e.stopPropagation(); openList(id); };

  const shareBtnNode = document.createElement('button');
  shareBtnNode.className = 'icon-btn p-2 rounded-lg border border-outline-variant/30 text-on-surface-variant hover:bg-surface-container transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px]';
  shareBtnNode.innerHTML = '<span class="material-symbols-outlined">ios_share</span>';
  shareBtnNode.onclick = (e) => { e.stopPropagation(); shareList(id); };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn p-2 rounded-lg border border-outline-variant/30 text-error hover:bg-error-container/20 transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px]';
  deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
  deleteBtn.onclick = (e) => { e.stopPropagation(); deleteList(id); };

  actions.append(openBtn, shareBtnNode, deleteBtn);

  card.onclick = (e) => {
    if (!e.target.closest('button') && !e.target.closest('h3') && !e.target.closest('.drag')) {
      openList(id);
    }
  };

  card.append(rowTop, meta, actions);
  card.refs = { title, countEl, updatedEl };
  return card;
}

function updateListCard(card, list) {
  const { title, countEl, updatedEl } = card.refs;

  // Leave the heading alone while it is being edited, or the caret jumps.
  const name = list.name || (list.loaded ? 'Untitled list' : '…');
  if (!title.isContentEditable && title.textContent !== name) title.textContent = name;

  const count = `${list.itemCount} items`;
  if (countEl.dataset.value !== count) {
    countEl.dataset.value = count;
    countEl.innerHTML = `<span class="material-symbols-outlined text-[14px]">list</span> ${count}`;
  }

  const updated = fmt(list.updatedAt);
  if (updatedEl.dataset.value !== updated) {
    updatedEl.dataset.value = updated;
    updatedEl.innerHTML = `<span class="material-symbols-outlined text-[14px]">history</span> ${updated}`;
  }

  card.dataset.order = list.order;
}

function renderLists() {
  if (!listsGrid) return;
  const lists = store.lists();

  if (!lists.length) {
    if (!emptyStateEl) {
      emptyStateEl = document.createElement('div');
      emptyStateEl.className = 'col-span-full border-2 border-dashed border-outline-variant/40 rounded-2xl p-5 flex flex-col items-center justify-center min-h-[220px]';
      emptyStateEl.innerHTML = `
      <div class="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-outline-variant">
        <span class="material-symbols-outlined text-[32px]">list_alt</span>
      </div>
      <p class="mt-3 font-label-md text-outline">No lists yet. Create your first list.</p>`;
    }
    if (!emptyStateEl.isConnected) listsGrid.appendChild(emptyStateEl);
  } else if (emptyStateEl?.isConnected) {
    emptyStateEl.remove();
  }

  reconcile(listsGrid, lists, listRows, createListCard, updateListCard);
  attachRipples();
}

/* ============================================================
   LIST VIEW (items)
   ============================================================ */
const itemRows = new Map();

function loadListName() {
  if (listNameEl) setInputValue(listNameEl, store.listName(listId));
}

function saveListName() {
  store.renameList(listId, (listNameEl?.value || '').trim() || 'Shopping List');
}

function createItemRow(item) {
  const id = item.id;

  const li = document.createElement('li');
  li.className = 'card group animate-slide-in flex flex-col md:flex-row md:items-center justify-between p-4 mb-3 bg-surface-container-lowest dark:bg-surface-container-low border border-outline-variant/30 rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-md transition-all duration-200 relative';
  li.dataset.id = id;

  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 flex-1 overflow-hidden min-w-0';

  const label = document.createElement('label');
  label.className = 'relative flex items-center justify-center cursor-pointer flex-shrink-0';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'peer appearance-none w-6 h-6 border-2 border-outline-variant rounded-full checked:bg-primary checked:border-primary transition-colors cursor-pointer';
  cb.onchange = () => toggleDone(id);

  const checkIcon = document.createElement('span');
  checkIcon.className = 'absolute inset-0 flex items-center justify-center opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none text-on-primary';
  checkIcon.innerHTML = '<span class="material-symbols-outlined text-[16px] font-bold">check</span>';

  label.append(cb, checkIcon);

  const textContainer = document.createElement('div');
  textContainer.className = 'flex flex-col flex-1 min-w-0 pr-2';

  const text = document.createElement('input');
  text.className = 'text w-full bg-transparent border-none p-0 focus:ring-0 text-on-surface font-body-lg transition-all truncate';
  text.setAttribute('enterkeyhint', 'enter');
  text.autocomplete = 'off';
  // Sync per keystroke rather than on blur: the store narrows it to the characters
  // that actually changed, which is what lets two people type in the same row.
  text.addEventListener('input', () => editItem(id, text.value));
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      addEmptyItemAfter(id);
    }
  });

  const meta = document.createElement('span');
  meta.className = 'metaRow text-[11px] text-on-surface-variant font-medium mt-0.5 hidden md:block opacity-0 group-hover:opacity-100 transition-opacity duration-300';

  textContainer.append(text, meta);
  row.append(label, textContainer);

  const rightContainer = document.createElement('div');
  rightContainer.className = 'flex items-center justify-between md:justify-end gap-1 mt-3 md:mt-0 pt-3 md:pt-0 border-t border-outline-variant/20 md:border-t-0 flex-shrink-0';

  const mobileMeta = document.createElement('span');
  mobileMeta.className = 'text-[11px] text-on-surface-variant font-medium md:hidden';

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'flex items-center gap-1';

  const del = document.createElement('button');
  del.className = 'w-10 h-10 flex items-center justify-center rounded-full text-outline-variant hover:text-error hover:bg-error-container/20 transition-colors';
  del.innerHTML = '<span class="material-symbols-outlined text-[20px]">delete</span>';
  del.onclick = () => store.deleteItem(listId, id);

  const handle = document.createElement('div');
  handle.className = 'drag handle p-2 rounded-lg text-outline-variant hover:bg-surface-container hover:text-primary transition-colors cursor-grab active:cursor-grabbing focus:ring-2 focus:ring-primary focus:outline-none';
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', 'Reorder item (Press Space to grab)');
  handle.innerHTML = '<span class="material-symbols-outlined">drag_indicator</span>';

  actionsContainer.append(del, handle);
  rightContainer.append(mobileMeta, actionsContainer);

  li.append(row, rightContainer);
  li.refs = { cb, text, meta, mobileMeta };
  return li;
}

function updateItemRow(li, item) {
  const { cb, text, meta, mobileMeta } = li.refs;
  const done = item.done;

  if (cb.checked !== done) cb.checked = done;
  text.classList.toggle('line-through', done);
  text.classList.toggle('text-on-surface-variant/50', done);
  setInputValue(text, item.text);

  const added = `Added: ${fmt(item.createdAt)}`;
  if (meta.textContent !== added) {
    meta.textContent = added;
    mobileMeta.textContent = added;
  }

  li.dataset.order = item.order;
  // Reordering reads neighbours off the DOM, and done rows are grouped separately,
  // so a row needs to advertise which group it is in.
  li.dataset.done = done ? '1' : '0';
}

function renderItems() {
  if (!remainingEl || !listEl) return;
  const items = store.items(listId);
  remainingEl.textContent = `${items.filter(i => !i.done).length} remaining`;
  reconcile(listEl, items, itemRows, createItemRow, updateItemRow);
  attachRipples();
}

if (inputEl) inputEl.setAttribute('enterkeyhint','enter');
function autoResizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(200, el.scrollHeight) + 'px';
}
if (inputEl) {
    autoResizeTextarea(inputEl);
    inputEl.addEventListener('input', () => autoResizeTextarea(inputEl));
    inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addFromTextarea();
        }
    });
}

function getLinesFromTextarea() {
  const raw = (inputEl?.value || '').replace(/\r\n/g, '\n');
  return raw.split('\n').map(s => s.trim()).filter(Boolean);
}

function addFromTextarea() {
  const lines = getLinesFromTextarea();
  if (!lines.length) return;
  inputEl.value = '';
  autoResizeTextarea(inputEl);
  store.addItems(listId, lines);
}

function addEmptyItemAfter(id) {
  const newItemId = store.addItemAfter(listId, id);
  // The store notifies synchronously, so the row is already reconciled into the DOM
  // by now — no timer needed to wait for it.
  if (newItemId) itemRows.get(newItemId)?.refs.text.focus();
}

function toggleDone(id) {
  store.toggleItem(listId, id);
}

function editItem(id, value) {
  store.setItemText(listId, id, value);
}

function clearAll() {
  if (!confirm('Clear all items?')) return;
  store.clearItems(listId);
}

function clearCompleted() {
  store.clearItems(listId, { doneOnly: true });
}

/* ---------- Reordering ---------- */

// The row's new neighbours in the DOM decide its key, and only that one row is
// written. The old scheme renumbered every sibling on every drop, which is both
// more writes than necessary and the most conflict-prone thing two devices can do.
function neighbourKey(el, direction, sameGroup) {
  const step = (node) => (direction === 'prev' ? node.previousElementSibling : node.nextElementSibling);
  let sibling = step(el);
  while (sibling && sameGroup && sibling.dataset.done !== el.dataset.done) sibling = step(sibling);
  return sibling?.dataset.order ?? null;
}

function persistOrder(el, move, { grouped = false } = {}) {
  const lower = neighbourKey(el, 'prev', grouped);
  const upper = neighbourKey(el, 'next', grouped);
  try {
    const key = move(el.dataset.id, lower, upper);
    if (key) el.dataset.order = key;
  } catch (err) {
    // Only reachable if the DOM order and the stored keys disagree; the next
    // render puts the row back where its key says it belongs.
    console.warn('could not reorder', el.dataset.id, err);
    if (listId) renderItems(); else renderLists();
  }
}

const persistListOrder = (el) => persistOrder(el, (id, lo, hi) => store.moveList(id, lo, hi));
const persistItemsOrder = (el) => persistOrder(el, (id, lo, hi) => store.moveItem(listId, id, lo, hi), { grouped: true });

/* ============================================================
   Mode switch
   ============================================================ */
function showHome() {
  if (homeSection) homeSection.classList.remove('hidden');
  if (listView) listView.classList.add('hidden');
  renderLists();
}
function showListView() {
  if (homeSection) homeSection.classList.add('hidden');
  if (listView) listView.classList.remove('hidden');
  // Rows belong to whichever list is open, so start the view from scratch.
  itemRows.clear();
  listEl.replaceChildren();
  loadListName();
  renderItems();
}

/* ============================================================
   Long-press reorder helper
   ============================================================ */
function enableLongPressReorder(container, itemSelector, onDrop, handleSelector = null) {
  if (!container) return;

  let pressTimer = null;
  let dragging = null;
  let startY = 0;
  let moved = false;

  const isInteractive = (el) =>
    el.closest('button, input, textarea, select, a, [contenteditable="true"]');

  const pointerDown = (e) => {
    const item = e.target.closest(itemSelector);
    if (!item) return;

    if (handleSelector && !e.target.closest(handleSelector)) return;
    if (isInteractive(e.target)) return;

    startY = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;
    moved = false;

    pressTimer = setTimeout(() => {
      dragging = item;
      dragging.classList.add('dragging');
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch {} }
      container.addEventListener('touchmove', preventScroll, { passive: false });
    }, 300);
  };

  const pointerMove = (e) => {
    if (!pressTimer && !dragging) return;
    const y = e.clientY || (e.touches && e.touches[0]?.clientY) || 0;
    if (!dragging) {
      if (Math.abs(y - startY) > 8) { clearTimeout(pressTimer); pressTimer = null; }
      return;
    }
    moved = true;
    e.preventDefault();
    const afterEl = getDragAfterElement(container, y, itemSelector);
    if (!afterEl) container.appendChild(dragging);
    else container.insertBefore(dragging, afterEl);
  };

  const pointerUp = () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (dragging) {
      const dropped = dragging;
      dropped.classList.remove('dragging');
      container.removeEventListener('touchmove', preventScroll);
      dragging = null;
      if (moved && typeof onDrop === 'function') onDrop(dropped);
      moved = false;
    }
  };

  container.addEventListener('mousedown', pointerDown);
  container.addEventListener('touchstart', pointerDown, { passive: true });
  container.addEventListener('mousemove', pointerMove);
  container.addEventListener('touchmove', pointerMove, { passive: false });
  container.addEventListener('mouseup', pointerUp);
  container.addEventListener('mouseleave', pointerUp);
  container.addEventListener('touchend', pointerUp);
  container.addEventListener('touchcancel', pointerUp);
}

function enableKeyboardReorder(container, itemSelector, onDrop, handleSelector = null) {
  if (!container) return;

  container.addEventListener('keydown', (e) => {
    const handle = e.target.closest(handleSelector || itemSelector);
    if (!handle) return;

    // Only proceed if the handle itself is focused
    if (e.target !== handle && !handle.contains(e.target)) return;

    const item = handle.closest(itemSelector);
    if (!item) return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (item.classList.contains('keyboard-dragging')) {
        item.classList.remove('keyboard-dragging');
        if (typeof onDrop === 'function') onDrop(item);
        handle.focus(); // keep focus
      } else {
        // Drop any existing
        container.querySelectorAll('.keyboard-dragging').forEach(el => el.classList.remove('keyboard-dragging'));
        item.classList.add('keyboard-dragging');
        showToast('Use Arrow Up/Down to move, Space to drop');
      }
    } else if (item.classList.contains('keyboard-dragging')) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = item.previousElementSibling;
        if (prev) {
          container.insertBefore(item, prev);
          handle.focus();
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = item.nextElementSibling;
        if (next) {
          container.insertBefore(item, next.nextElementSibling);
          handle.focus();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        item.classList.remove('keyboard-dragging');
        handle.focus();
      }
    }
  });
}

function preventScroll(e) { e.preventDefault(); }

function getDragAfterElement(container, y, itemSelector) {
  const els = [...container.querySelectorAll(`${itemSelector}:not(.dragging)`)];
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    return (offset < 0 && offset > closest.offset) ? { offset, element: child } : closest;
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

/* ---------- Ripples ---------- */
function attachRipples() {
  document.querySelectorAll('button.btn, button.icon-btn, button.neumorphic-btn').forEach(btn => {
    if (btn.dataset.rippleAttached) return;
    btn.dataset.rippleAttached = '1';
    btn.addEventListener('click', function (e) {
      const rect = this.getBoundingClientRect();
      const circle = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      circle.style.width = circle.style.height = size + 'px';
      circle.style.left = (e.clientX - rect.left - size/2) + 'px';
      circle.style.top  = (e.clientY - rect.top  - size/2) + 'px';
      circle.className = 'ripple';
      this.appendChild(circle);
      setTimeout(() => circle.remove(), 550);
    });
  });
}

/* ---------- Toast Notification ---------- */
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'fixed bottom-24 left-1/2 -translate-x-1/2 bg-inverse-surface text-inverse-on-surface px-4 py-2 rounded-lg shadow-lg font-label-md z-[100] animate-slide-up flex items-center gap-2';
  toast.innerHTML = `<span class="material-symbols-outlined text-[18px]">info</span> ${message}`;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translate(-50%, 10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/* ---------- Wire UI ---------- */
if (createListBtn)      createListBtn.onclick = createList;
if (backHomeBtn)        backHomeBtn.onclick = goHome;
if (addBtn)             addBtn.onclick = addFromTextarea;
if (clearAllBtn)        clearAllBtn.onclick = clearAll;
if (clearCompletedBtn)  clearCompletedBtn.onclick = clearCompleted;
if (shareBtn)           shareBtn.onclick = () => shareList(listId);
if (linkDeviceBtn)      linkDeviceBtn.onclick = copyDeviceLink;
if (listNameEl)         listNameEl.addEventListener('input', saveListName);
if (listNameEl)         listNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listNameEl.blur(); }
});
if (newListNameEl)      newListNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
});

// Attached once, not per render — rows outlive a change now.
enableLongPressReorder(listsGrid, '.card-list', persistListOrder, '.drag');
enableKeyboardReorder(listsGrid, '.card-list', persistListOrder, '.drag');
enableLongPressReorder(listEl, '.card', persistItemsOrder, '.drag.handle');
enableKeyboardReorder(listEl, '.card', persistItemsOrder, '.drag.handle');

/* ---------- Store subscription ---------- */
store.onChange(() => {
  if (listId) {
    // A list can be removed on another device while it is open here.
    if (!store.hasList(listId)) { goHome(); return; }
    loadListName();
    renderItems();
  } else {
    renderLists(); // names and item counts live on the cards
  }
});

/* ---------- Start ---------- */
store.open(linkSecret)
  .then(() => {
    // A shared list arrives as a token in the URL; adopt it and open it.
    if (incomingShare) {
      const share = Store.parseShareToken(incomingShare);
      if (share) {
        const joined = store.joinList(share.id, share.secret);
        listId = share.id;
        showListView();
        showToast(joined ? 'List added.' : 'You already have that list.');
        return;
      }
    }
    if (listId && store.hasList(listId)) showListView();
    else { listId = null; showHome(); }
  })
  .catch((err) => {
    console.error('could not open the store:', err);
    showHome();
  });
