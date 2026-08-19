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
const profileBtn        = document.getElementById('profileBtn');
const sortToggleBtn     = document.getElementById('sortToggle');
const sortLabelEl       = document.getElementById('sortLabel');

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
const doneSectionEl     = document.getElementById('doneSection');
const doneListEl        = document.getElementById('doneList');
const doneCountEl       = document.getElementById('doneCount');
const deletedSectionEl  = document.getElementById('deletedSection');
const deletedListEl     = document.getElementById('deletedList');
const deletedCountEl    = document.getElementById('deletedCount');
const purgeDeletedBtn   = document.getElementById('purgeDeleted');

/* ---------- Helpers ---------- */
const qs  = (k) => new URLSearchParams(location.search).get(k);
const fmt = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleString() : '…';
};
// Compact ages for the row meta. A full timestamp fills the line on a phone and
// says less than "2m ago" does.
const ago = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '';
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
   LIST ORDER

   The control in the header was previously a label with no behaviour. Dragging a
   card writes a manual key, so that ordering is only meaningful in 'custom' mode —
   in 'recent' mode the handle is taken out of reach rather than left to produce a
   reorder the user cannot see.
   ============================================================ */
let listSort = localStorage.getItem('listSort') === 'recent' ? 'recent' : 'custom';

function applySortPref() {
  if (sortLabelEl) sortLabelEl.textContent = listSort === 'recent' ? 'Recent' : 'Custom';
  if (sortToggleBtn) {
    sortToggleBtn.title = listSort === 'recent'
      ? 'Sorted by most recently updated. Switch to your own order.'
      : 'Sorted by your own order. Switch to most recently updated.';
  }
}
applySortPref();

if (sortToggleBtn) {
  sortToggleBtn.onclick = () => {
    listSort = listSort === 'recent' ? 'custom' : 'recent';
    localStorage.setItem('listSort', listSort);
    applySortPref();
    renderLists();
  };
}

/* ============================================================
   WHO

   Names come from a profile that syncs in the documents, not from an account —
   there is no server to authenticate against. Colours are picked from a fixed
   palette by index so they survive syncing as a number and read on both themes.
   ============================================================ */
const PERSON_COLOURS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#ec4899', '#8b5cf6', '#14b8a6',
];
const personColour = (n) => PERSON_COLOURS[(n ?? 0) % PERSON_COLOURS.length];
const initialOf = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';

function renderProfileButton() {
  if (!profileBtn) return;
  const me = store.profile();
  profileBtn.textContent = initialOf(me.name);
  profileBtn.style.backgroundColor = personColour(me.colour);
  profileBtn.title = `You are "${me.name}" — tap to change`;
}

function editProfile() {
  const me = store.profile();
  const name = prompt('Your name, as other people on shared lists will see it:', me.name);
  if (name === null) return;
  store.setProfile({ name });
  renderProfileButton();
  showToast('Name updated everywhere you have shared a list.');
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
  card.className = 'card-list row-press group flex items-center gap-1 bg-surface border border-line rounded-xl pl-1 pr-1.5 py-1.5 hover:bg-raised cursor-pointer';
  card.dataset.id = id;

  const rowTop = document.createElement('div');
  rowTop.className = 'row-top flex items-center gap-1 min-w-0 flex-1';

  const drag = document.createElement('div');
  drag.className = 'drag w-7 h-9 shrink-0 flex items-center justify-center rounded-md cursor-grab text-faint active:cursor-grabbing hover:text-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent';
  drag.tabIndex = 0;
  drag.setAttribute('aria-label', 'Reorder list (Press Space to grab)');
  drag.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">drag_indicator</span>';

  const title = document.createElement('h3');
  title.className = 'text-[15px] font-medium text-ink truncate outline-none focus:bg-raised rounded px-1 -mx-1';
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

  const textCol = document.createElement('div');
  textCol.className = 'flex flex-col min-w-0 flex-1 py-1';
  textCol.append(title);
  rowTop.append(drag, textCol);

  const meta = document.createElement('div');
  meta.className = 'muted flex items-center gap-1.5 text-faint text-[12px] leading-tight';
  const countEl = document.createElement('span');
  countEl.className = '';
  const updatedEl = document.createElement('span');
  updatedEl.className = 'metaRow truncate';
  const sep = document.createElement('span');
  sep.className = 'metaRow h-0.5 w-0.5 bg-faint rounded-full shrink-0';
  const creatorEl = document.createElement('span');
  creatorEl.className = 'hidden truncate font-medium';
  meta.append(countEl, sep, updatedEl, creatorEl);

  const actions = document.createElement('div');
  actions.className = 'actions flex items-center gap-0.5 shrink-0';

  const openBtn = document.createElement('button');
  openBtn.className = 'icon-btn sr-only';
  openBtn.textContent = 'Open';
  openBtn.onclick = (e) => { e.stopPropagation(); openList(id); };

  const shareBtnNode = document.createElement('button');
  shareBtnNode.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-ink hover:bg-raised transition-colors';
  shareBtnNode.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">ios_share</span>';
  shareBtnNode.onclick = (e) => { e.stopPropagation(); shareList(id); };

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-danger hover:bg-danger-soft transition-colors';
  deleteBtn.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">delete</span>';
  deleteBtn.onclick = (e) => { e.stopPropagation(); deleteList(id); };

  actions.append(openBtn, shareBtnNode, deleteBtn);

  card.onclick = (e) => {
    if (!e.target.closest('button') && !e.target.closest('h3') && !e.target.closest('.drag')) {
      openList(id);
    }
  };

  textCol.append(meta);
  card.append(rowTop, actions);
  card.refs = { title, countEl, updatedEl, drag, creatorEl };
  return card;
}

function updateListCard(card, list) {
  const { title, countEl, updatedEl, drag, creatorEl } = card.refs;

  // Dragging only means anything when the manual order is the one on screen.
  const draggable = listSort === 'custom';
  drag.classList.toggle('hidden', !draggable);
  drag.tabIndex = draggable ? 0 : -1;

  // Leave the heading alone while it is being edited, or the caret jumps.
  const name = list.name || (list.loaded ? 'Untitled list' : '…');
  if (!title.isContentEditable && title.textContent !== name) title.textContent = name;

  const count = plural(list.itemCount, 'item');
  if (countEl.textContent !== count) countEl.textContent = count;

  // Only worth saying when somebody else made it — on your own lists it is noise.
  const creator = list.createdBy && list.createdBy !== store.profile().id
    ? store.people(list.id)[list.createdBy]
    : null;
  const by = creator ? `by ${creator.name}` : '';
  if (creatorEl.textContent !== by) {
    creatorEl.textContent = by;
    creatorEl.classList.toggle('hidden', !by);
    creatorEl.style.color = creator ? personColour(creator.colour) : '';
  }

  const updated = ago(list.updatedAt);
  if (updatedEl.textContent !== updated) {
    updatedEl.textContent = updated;
    updatedEl.title = fmt(list.updatedAt);
  }

  card.dataset.order = list.order;
}

function renderLists() {
  if (!listsGrid) return;
  const lists = store.lists(listSort);

  if (!lists.length) {
    if (!emptyStateEl) {
      emptyStateEl = document.createElement('div');
      emptyStateEl.className = 'flex flex-col items-center justify-center gap-2 py-14 text-center';
      emptyStateEl.innerHTML = `
      <span class="material-symbols-outlined text-[28px] text-faint">list_alt</span>
      <p class="text-[13px] text-faint">Nothing here yet</p>`;
    }
    if (!emptyStateEl.isConnected) listsGrid.appendChild(emptyStateEl);
  } else if (emptyStateEl?.isConnected) {
    emptyStateEl.remove();
  }

  renderProfileButton();
  reconcile(listsGrid, lists, listRows, createListCard, updateListCard);
  attachRipples();
}

/* ============================================================
   LIST VIEW (items)
   ============================================================ */
// Who is on the open list, resolved once per render rather than per row.
let people = {};
let shared = false;

const itemRows = new Map();
const doneRows = new Map();
const deletedRows = new Map();
// Only the most recent are drawn; nothing restores them, so an unbounded history
// would just grow the page.
const DELETED_SHOWN = 50;

function loadListName() {
  if (listNameEl) setInputValue(listNameEl, store.listName(listId));
}

function saveListName() {
  store.renameList(listId, (listNameEl?.value || '').trim() || 'Shopping List');
}

function createItemRow(item) {
  const id = item.id;

  const li = document.createElement('li');
  li.className = 'card row-press group animate-slide-in flex items-center gap-2 pl-3 pr-1.5 py-1.5 bg-surface border border-line rounded-xl hover:bg-raised';
  li.dataset.id = id;

  const row = document.createElement('div');
  row.className = 'flex items-center gap-3 flex-1 min-w-0 pl-1';

  const label = document.createElement('label');
  label.className = 'relative flex items-center justify-center cursor-pointer flex-shrink-0';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'peer appearance-none w-[19px] h-[19px] shrink-0 bg-transparent border-[1.5px] border-faint rounded-full checked:bg-accent checked:border-accent hover:border-muted transition-colors cursor-pointer';
  cb.onchange = () => toggleDone(id);

  const checkIcon = document.createElement('span');
  checkIcon.className = 'absolute inset-0 flex items-center justify-center opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none text-accent-ink';
  checkIcon.innerHTML = '<span class="material-symbols-outlined text-[13px] leading-none font-bold">check</span>';

  label.append(cb, checkIcon);

  const textContainer = document.createElement('div');
  textContainer.className = 'flex flex-col flex-1 min-w-0 py-1';

  const text = document.createElement('input');
  text.className = 'text w-full bg-transparent border-0 p-0 focus:ring-0 text-[15px] leading-snug truncate';
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
  meta.className = 'metaRow text-[11px] text-faint leading-tight mt-0.5 truncate';

  textContainer.append(text, meta);
  row.append(label, textContainer);

  const rightContainer = document.createElement('div');
  rightContainer.className = 'flex items-center shrink-0';

  const mobileMeta = document.createElement('span');
  mobileMeta.className = 'sr-only';

  const dot = document.createElement('span');
  dot.className = 'hidden w-1.5 h-1.5 rounded-full shrink-0 mr-1.5';

  const actionsContainer = document.createElement('div');
  actionsContainer.className = 'flex items-center gap-0.5';

  const del = document.createElement('button');
  del.className = 'icon-btn w-9 h-9 flex items-center justify-center rounded-lg text-faint hover:text-danger hover:bg-danger-soft transition-colors';
  del.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">delete</span>';
  del.onclick = () => store.deleteItem(listId, id);

  const handle = document.createElement('div');
  handle.className = 'drag handle w-7 h-9 flex items-center justify-center rounded-md text-faint hover:text-muted transition-colors cursor-grab active:cursor-grabbing focus:ring-2 focus:ring-accent focus:outline-none';
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', 'Reorder item (Press Space to grab)');
  handle.innerHTML = '<span class="material-symbols-outlined text-[18px] leading-none">drag_indicator</span>';

  actionsContainer.append(del, handle);
  rightContainer.append(mobileMeta, dot, actionsContainer);

  li.append(row, rightContainer);
  li.refs = { cb, text, meta, mobileMeta, del, handle, label, dot };
  return li;
}

function updateItemRow(li, item) {
  const { cb, text, meta, mobileMeta, del, handle, label, dot } = li.refs;
  const done = item.done;
  const deleted = item.deleted;

  if (cb.checked !== done) cb.checked = done;
  const muted = done || deleted;
  text.classList.toggle('line-through', muted);
  text.classList.toggle('text-faint', muted);
  text.classList.toggle('text-ink', !muted);
  setInputValue(text, item.text);

  // A deleted row is a record, not a control. It loses the card chrome as well as
  // the controls, so it reads as history rather than as something still on the list.
  li.classList.toggle('row-press', !deleted);
  li.classList.toggle('bg-surface', !deleted);
  li.classList.toggle('border-line', !deleted);
  li.classList.toggle('hover:bg-raised', !deleted);
  li.classList.toggle('bg-transparent', deleted);
  li.classList.toggle('border-transparent', deleted);
  text.readOnly = deleted;
  cb.disabled = deleted;
  label.classList.toggle('hidden', deleted);
  del.classList.toggle('hidden', deleted);
  // Reorder is only wired to the active section, so a handle anywhere else would be
  // a control that quietly does nothing.
  handle.classList.toggle('hidden', deleted || done);

  // Naming the author on a list only one person has touched is noise, so it
  // appears once a list actually has more than one person in it.
  const who = shared && item.authorId && people[item.authorId]
    ? ` by ${people[item.authorId].name}`
    : '';
  const stamp = deleted
    ? `Deleted ${ago(item.deletedAt)}`
    : `Added${who} ${ago(item.createdAt)}`;
  if (meta.textContent !== stamp) {
    meta.textContent = stamp;
    meta.title = fmt(deleted ? item.deletedAt : item.createdAt);
    mobileMeta.textContent = stamp;
  }

  const author = item.authorId ? people[item.authorId] : null;
  dot.style.backgroundColor = author ? personColour(author.colour) : 'transparent';
  dot.classList.toggle('hidden', !shared || !author);
  dot.title = author ? `Added by ${author.name}` : '';

  li.dataset.order = item.order;
}

function renderItems() {
  if (!remainingEl || !listEl) return;

  people = store.people(listId);
  shared = Object.keys(people).length > 1;

  const active = store.activeItems(listId);
  const outstanding = active.filter(i => !i.done);
  const done = active.filter(i => i.done);
  const deleted = store.deletedItems(listId).slice(0, DELETED_SHOWN);

  remainingEl.textContent = `${outstanding.length} remaining`;

  reconcile(listEl, outstanding, itemRows, createItemRow, updateItemRow);
  reconcile(doneListEl, done, doneRows, createItemRow, updateItemRow);
  reconcile(deletedListEl, deleted, deletedRows, createItemRow, updateItemRow);

  toggleSection(doneSectionEl, doneCountEl, done.length);
  toggleSection(deletedSectionEl, deletedCountEl, store.deletedItems(listId).length);

  attachRipples();
}

// A heading for an empty section is just noise.
function toggleSection(section, countEl, count) {
  if (!section) return;
  section.classList.toggle('hidden', count === 0);
  if (countEl) countEl.textContent = String(count);
}

if (inputEl) inputEl.setAttribute('enterkeyhint','enter');
function autoResizeTextarea(el) {
  // A hidden element reports scrollHeight 0, and this used to run once at load
  // while the list view was still hidden — pinning the composer to zero height.
  if (!el || el.offsetParent === null) return;
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
// Sections are separate containers now, so a row's siblings are already its group.
// The dataset.done skipping this used to do existed only because active, done and
// deleted rows all shared one <ul>.
function neighbourKey(el, direction) {
  const sibling = direction === 'prev' ? el.previousElementSibling : el.nextElementSibling;
  return sibling?.dataset.order ?? null;
}

function persistOrder(el, move) {
  const lower = neighbourKey(el, 'prev');
  const upper = neighbourKey(el, 'next');
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
const persistItemsOrder = (el) => persistOrder(el, (id, lo, hi) => store.moveItem(listId, id, lo, hi));

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
  autoResizeTextarea(inputEl);
  // Rows belong to whichever list is open, so start the view from scratch.
  itemRows.clear();
  doneRows.clear();
  deletedRows.clear();
  listEl.replaceChildren();
  doneListEl.replaceChildren();
  deletedListEl.replaceChildren();
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
if (purgeDeletedBtn)    purgeDeletedBtn.onclick = () => {
    if (confirm('Permanently remove the deleted items? They cannot be brought back.')) {
      store.purgeDeleted(listId);
    }
};
if (shareBtn)           shareBtn.onclick = () => shareList(listId);
if (linkDeviceBtn)      linkDeviceBtn.onclick = copyDeviceLink;
if (profileBtn)         profileBtn.onclick = editProfile;
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
