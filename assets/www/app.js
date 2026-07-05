import * as Y from "https://esm.sh/yjs";
import { WebrtcProvider } from "https://esm.sh/y-webrtc";
import { IndexeddbPersistence } from "https://esm.sh/y-indexeddb";

// ---------- Global Yjs Setup ----------
const ydoc = new Y.Doc();

// Share the sync room ID via URL to link devices (like WhatsApp web linking)
let syncRoom = new URLSearchParams(location.search).get('room') || localStorage.getItem('shopnest-sync-room');
if (!syncRoom) {
  syncRoom = 'shopnest-' + Math.random().toString(36).substring(2, 10);
}
// Always save the current room so that if they open it without the query param next time, it remembers.
localStorage.setItem('shopnest-sync-room', syncRoom);

// Update URL to include room so they can easily copy/paste to another device
const urlParams = new URLSearchParams(location.search);
if (!urlParams.has('room')) {
  urlParams.set('room', syncRoom);
  window.history.replaceState({}, '', `${location.pathname}?${urlParams}`);
}

const providerIdb = new IndexeddbPersistence('shopnest-db', ydoc);
// Use public signaling servers for WebRTC P2P sync
const providerWebrtc = new WebrtcProvider(syncRoom, ydoc);

const yLists = ydoc.getMap('lists'); // listId -> { id, name, created_at, updated_at, order_index }
const yItems = ydoc.getMap('items'); // itemId -> { id, list_id, text, done, created_at, updated_at, order_index }

/* ---------- Elements (HOME) ---------- */
const homeSection       = document.getElementById('home');
const listsGrid         = document.getElementById('listsGrid');
const newListNameEl     = document.getElementById('newListName');
const createListBtn     = document.getElementById('createListBtn');
const themeToggle       = document.getElementById('themeToggle');

/* ---------- Elements (LIST VIEW) ---------- */
const listView          = document.getElementById('listView');
const backHomeBtn       = document.getElementById('backHome');
const listNameEl        = document.getElementById('listName');
const currentListTitle  = document.getElementById('currentListTitle'); // To update the top bar text
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
const nowIso = () => new Date().toISOString();

let listId = qs('list');

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
   HOME (lists)
   ============================================================ */
function createList() {
  const name  = (newListNameEl?.value || '').trim() || 'My Shopping List';
  const now   = nowIso();
  const order = Date.now();
  const id    = 'list-' + Math.random().toString(36).substring(2, 9);
  
  yLists.set(id, { id, name, created_at: now, updated_at: now, order_index: order });
  
  newListNameEl.value = '';
  const url = new URL(location.href);
  url.searchParams.set('list', id);
  location.href = url.href;
}

function loadLists() {
  // Convert Y.Map to array
  let lists = Array.from(yLists.values());
  // Sort
  lists.sort((a, b) => {
    const oi = (b.order_index ?? 0) - (a.order_index ?? 0);
    if (oi !== 0) return oi;
    return new Date(b.updated_at) - new Date(a.updated_at);
  });
  renderLists(lists);
}

function shareList(id) {
  const url = new URL(location.href);
  url.searchParams.set('list', id);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url.href)
      .then(() => showToast('Shareable link copied!'))
      .catch(() => showToast('Copy failed. Long-press/copy the URL.'));
  } else {
    prompt('Copy this link:', url.href);
  }
}

function deleteList(id) {
  if (!confirm('Delete this list (and all its items)?')) return;
  yLists.delete(id);
  // Also clean up items
  const itemKeys = [];
  yItems.forEach((item, key) => {
    if (item.list_id === id) itemKeys.push(key);
  });
  itemKeys.forEach(k => yItems.delete(k));
}

function renameList(id, newName) {
  const name = (newName || '').trim() || 'Untitled list';
  const l = yLists.get(id);
  if (l) yLists.set(id, { ...l, name, updated_at: nowIso() });
}

function renderLists(lists) {
  if (!listsGrid) return;
  listsGrid.innerHTML = '';

  if (!lists.length) {
    const empty = document.createElement('div');
    empty.className = 'col-span-full border-2 border-dashed border-outline-variant/40 rounded-2xl p-5 flex flex-col items-center justify-center min-h-[220px]';
    empty.innerHTML = `
      <div class="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-outline-variant">
        <span class="material-symbols-outlined text-[32px]">list_alt</span>
      </div>
      <p class="mt-3 font-label-md text-outline">No lists yet. Create your first list.</p>`;
    listsGrid.appendChild(empty);
    return;
  }

  for (const l of lists) {
    const card = document.createElement('div');
    card.className = 'card-list group bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-5 shadow-sm hover:shadow-md transition-all duration-300 relative cursor-pointer';
    card.dataset.id = l.id;

    // Top row
    const rowTop = document.createElement('div');
    rowTop.className = 'row-top flex items-center justify-start gap-2 mb-4';

    const drag = document.createElement('div');
    drag.className = 'drag p-2 rounded-lg cursor-grab text-outline-variant active:cursor-grabbing hover:text-primary hover:bg-surface-container transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary';
    drag.tabIndex = 0;
    drag.setAttribute('aria-label', 'Reorder list (Press Space to grab)');
    drag.innerHTML = '<span class="material-symbols-outlined">drag_indicator</span>';

    const title = document.createElement('h3');
    title.className = 'font-headline-sm text-[20px] text-on-surface flex-1 truncate font-bold outline-none focus:bg-surface-container-high rounded px-1 -ml-1';
    title.textContent = l.name || 'Untitled list';
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
        renameList(l.id, title.textContent || '');
      }
    });

    rowTop.append(drag, title);

    const meta = document.createElement('div');
    meta.className = 'muted flex items-center gap-2 text-on-surface-variant text-[12px] font-medium mb-6';
    // Count items
    let itemCount = 0;
    yItems.forEach(i => { if (i.list_id === l.id) itemCount++; });
    meta.innerHTML = `
      <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">list</span> ${itemCount} items</span>
      <span class="h-1 w-1 bg-outline-variant rounded-full"></span>
      <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">history</span> ${fmt(l.updated_at)}</span>
    `;

    const actions = document.createElement('div');
    actions.className = 'actions flex items-center gap-2 pt-4 border-t border-outline-variant/20';

    const openBtn = document.createElement('button');
    openBtn.className = 'icon-btn primary flex-1 py-2 bg-primary-container text-on-primary-container rounded-lg font-medium text-center hover:brightness-105 transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px] border-transparent';
    openBtn.textContent = 'Open';
    openBtn.onclick = (e) => { 
        e.stopPropagation(); 
        const url = new URL(location.href);
        url.searchParams.set('list', l.id);
        location.href = url.href; 
    };

    const shareBtnNode = document.createElement('button');
    shareBtnNode.className = 'icon-btn p-2 rounded-lg border border-outline-variant/30 text-on-surface-variant hover:bg-surface-container transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px]';
    shareBtnNode.innerHTML = '<span class="material-symbols-outlined">ios_share</span>';
    shareBtnNode.onclick = (e) => { e.stopPropagation(); shareList(l.id); };

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn p-2 rounded-lg border border-outline-variant/30 text-error hover:bg-error-container/20 transition-colors active:scale-95 flex items-center justify-center gap-1 text-[14px]';
    deleteBtn.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    deleteBtn.onclick = (e) => { e.stopPropagation(); deleteList(l.id); };

    actions.append(openBtn, shareBtnNode, deleteBtn);

    // Open by clicking card
    card.onclick = (e) => { 
        if (!e.target.closest('button') && !e.target.closest('h3') && !e.target.closest('.drag')) {
            const url = new URL(location.href);
            url.searchParams.set('list', l.id);
            location.href = url.href;
        }
    };

    card.append(rowTop, meta, actions);
    listsGrid.appendChild(card);
  }

  enableLongPressReorder(listsGrid, '.card-list', persistListOrder, '.drag');
  enableKeyboardReorder(listsGrid, '.card-list', persistListOrder, '.drag');
  attachRipples();
}

function persistListOrder() {
  const cards = [...listsGrid.querySelectorAll('.card-list')];
  let base = Date.now() + 1000;
  for (let i = 0; i < cards.length; i++) {
    const id = cards[i].dataset.id;
    const l = yLists.get(id);
    if (l) yLists.set(id, { ...l, order_index: base - i });
  }
}

/* ============================================================
   LIST VIEW (items)
   ============================================================ */
function loadListName() {
  const l = yLists.get(listId);
  if (l) {
      if (listNameEl) listNameEl.value = l.name || 'Shopping List';
      if (currentListTitle) currentListTitle.textContent = l.name || 'Shopping List';
  }
}

function saveListName() {
  const name = (listNameEl?.value || '').trim() || 'Shopping List';
  const l = yLists.get(listId);
  if (l) {
      yLists.set(listId, { ...l, name, updated_at: nowIso() });
      if (currentListTitle) currentListTitle.textContent = name;
  }
}

function sortItems(arr) {
  return arr.slice().sort((a,b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    const oi = (b.order_index ?? 0) - (a.order_index ?? 0);
    if (oi !== 0) return oi;
    return (new Date(b.created_at) - new Date(a.created_at));
  });
}

function loadItemsAndRender() {
  const allItems = Array.from(yItems.values());
  const listItems = allItems.filter(i => i.list_id === listId);
  renderItems(sortItems(listItems));
}

function renderItems(items) {
  if (!remainingEl || !listEl) return;
  remainingEl.textContent = `${items.filter(i => !i.done).length} remaining`;
  listEl.innerHTML = '';

  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'card group animate-slide-in flex flex-col md:flex-row md:items-center justify-between p-4 mb-3 bg-surface-container-lowest dark:bg-surface-container-low border border-outline-variant/30 rounded-2xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:shadow-md transition-all duration-200 relative';
    li.dataset.id = item.id;

    // Main Row
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 flex-1 overflow-hidden min-w-0';

    // Checkbox
    const label = document.createElement('label');
    label.className = 'relative flex items-center justify-center cursor-pointer flex-shrink-0';
    
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'peer appearance-none w-6 h-6 border-2 border-outline-variant rounded-full checked:bg-primary checked:border-primary transition-colors cursor-pointer';
    cb.checked = !!item.done;
    cb.onchange = () => toggleDoneOptimistic(item);

    const checkIcon = document.createElement('span');
    checkIcon.className = 'absolute inset-0 flex items-center justify-center opacity-0 peer-checked:opacity-100 transition-opacity pointer-events-none text-on-primary';
    checkIcon.innerHTML = '<span class="material-symbols-outlined text-[16px] font-bold">check</span>';
    
    label.append(cb, checkIcon);

    // Text Content
    const textContainer = document.createElement('div');
    textContainer.className = 'flex flex-col flex-1 min-w-0 pr-2';

    const text = document.createElement('input');
    text.className = 'w-full bg-transparent border-none p-0 focus:ring-0 text-on-surface font-body-lg transition-all truncate ' + (item.done ? 'line-through text-on-surface-variant/50' : '');
    text.value = item.text || '';
    text.setAttribute('enterkeyhint', 'enter');
    text.autocomplete = 'off';
    text.onchange = () => editItemOptimistic(item, text.value);
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        addEmptyItemAfter(item);
      }
    });

    const meta = document.createElement('span');
    meta.className = 'metaRow text-[11px] text-on-surface-variant font-medium mt-0.5 hidden md:block opacity-0 group-hover:opacity-100 transition-opacity duration-300';
    meta.textContent = `Added: ${fmt(item.created_at)}`;

    textContainer.append(text, meta);
    row.append(label, textContainer);

    // Actions & Mobile Meta
    const rightContainer = document.createElement('div');
    rightContainer.className = 'flex items-center justify-between md:justify-end gap-1 mt-3 md:mt-0 pt-3 md:pt-0 border-t border-outline-variant/20 md:border-t-0 flex-shrink-0';

    const mobileMeta = document.createElement('span');
    mobileMeta.className = 'text-[11px] text-on-surface-variant font-medium md:hidden';
    mobileMeta.textContent = `Added: ${fmt(item.created_at)}`;

    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'flex items-center gap-1';

    const del = document.createElement('button');
    del.className = 'w-10 h-10 flex items-center justify-center rounded-full text-outline-variant hover:text-error hover:bg-error-container/20 transition-colors';
    del.innerHTML = '<span class="material-symbols-outlined text-[20px]">delete</span>';
    del.onclick = () => removeItemOptimistic(item);

    const handle = document.createElement('div');
    handle.className = 'drag handle p-2 rounded-lg text-outline-variant hover:bg-surface-container hover:text-primary transition-colors cursor-grab active:cursor-grabbing focus:ring-2 focus:ring-primary focus:outline-none';
    handle.tabIndex = 0;
    handle.setAttribute('aria-label', 'Reorder item (Press Space to grab)');
    handle.innerHTML = '<span class="material-symbols-outlined">drag_indicator</span>';

    actionsContainer.append(del, handle);
    rightContainer.append(mobileMeta, actionsContainer);

    li.append(row, rightContainer);
    listEl.appendChild(li);
  }

  enableLongPressReorder(listEl, '.card', persistItemsOrder, '.drag.handle');
  enableKeyboardReorder(listEl, '.card', persistItemsOrder, '.drag.handle');
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

  const baseTime = Date.now();
  const now = nowIso();
  
  ydoc.transact(() => {
    lines.forEach((t, idx) => {
      const id = 'item-' + Math.random().toString(36).substring(2, 9);
      yItems.set(id, {
        id, list_id: listId, text: t, done: false,
        created_at: now, updated_at: now,
        order_index: baseTime + (lines.length - idx)
      });
    });
  });
}

function addEmptyItemAfter(item) {
  const now = nowIso();
  const order_index = (item.order_index ?? Date.now()) - 1;
  const id = 'item-' + Math.random().toString(36).substring(2, 9);
  
  yItems.set(id, {
    id, list_id: listId, text: '', done: false,
    created_at: now, updated_at: now, order_index
  });

  setTimeout(() => {
    const el = listEl.querySelector(`.card[data-id="${id}"] .text`);
    if (el) el.focus();
  }, 100); // small delay to let UI render
}

function toggleDoneOptimistic(item) {
  const i = yItems.get(item.id);
  if (i) yItems.set(item.id, { ...i, done: !i.done, updated_at: nowIso(), order_index: Date.now() });
}

function editItemOptimistic(item, newText) {
  const i = yItems.get(item.id);
  if (i) yItems.set(item.id, { ...i, text: newText, updated_at: nowIso() });
}

function removeItemOptimistic(item) {
  yItems.delete(item.id);
}

function clearAll() {
  if (!confirm('Clear all items?')) return;
  const keys = [];
  yItems.forEach((i, k) => { if (i.list_id === listId) keys.push(k); });
  ydoc.transact(() => keys.forEach(k => yItems.delete(k)));
}

function clearCompleted() {
  const keys = [];
  yItems.forEach((i, k) => { if (i.list_id === listId && i.done) keys.push(k); });
  ydoc.transact(() => keys.forEach(k => yItems.delete(k)));
}

function persistItemsOrder() {
  const cards = [...listEl.querySelectorAll('.card')];
  let base = Date.now() + 1000;
  ydoc.transact(() => {
    for (let i = 0; i < cards.length; i++) {
        const id = cards[i].dataset.id;
        const it = yItems.get(id);
        if (it) yItems.set(id, { ...it, order_index: base - i });
    }
  });
}

function goHome() {
  const url = new URL(location.href);
  url.searchParams.delete('list');
  history.pushState({}, '', url.href);
  showHome();
}

/* ============================================================
   Mode switch
   ============================================================ */
function showHome() {
  if (homeSection) homeSection.classList.remove('hidden');
  if (listView) listView.classList.add('hidden');
  loadLists();
}
function showListView() {
  if (homeSection) homeSection.classList.add('hidden');
  if (listView) listView.classList.remove('hidden');
  loadListName();
  loadItemsAndRender();
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
      dragging.classList.remove('dragging');
      container.removeEventListener('touchmove', preventScroll);
      dragging = null;
      if (moved && typeof onDrop === 'function') onDrop();
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
        if (typeof onDrop === 'function') onDrop();
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
if (listNameEl)         listNameEl.addEventListener('blur', saveListName);
if (listNameEl)         listNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); listNameEl.blur(); }
});
if (newListNameEl)      newListNameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
});

/* ---------- Yjs Subscriptions ---------- */
yLists.observe(() => {
    if (!listId) loadLists();
    else loadListName();
});

yItems.observe(() => {
    if (listId) loadItemsAndRender();
});

// Wait for IDB to sync initial state before rendering, or just render immediately.
providerIdb.on('synced', () => {
  listId = qs('list');
  if (!listId) showHome();
  else showListView();
});
// Fallback if IDB takes too long or is already synced
setTimeout(() => {
  // If neither view is explicitly shown yet (or if home is shown but URL has a list ID)
  listId = qs('list');
  if (listId && listView.classList.contains('hidden')) {
    showListView();
  } else if (!listId && homeSection.classList.contains('hidden')) {
    showHome();
  }
}, 200);
