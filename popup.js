import {
  getSettings, setSettings, api, ApiError, hasServerPermission, publicUser,
  folderTree, folderPath, isSavable, urlKey, cleanURL, youtubeID, hostOf,
  extractPage, fetchImage, makeThumb, makeIcon, chromeFavicon, fillAvatar,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const isWindow = new URLSearchParams(location.search).has('window');
if (isWindow) document.body.classList.add('window');

const st = {
  s: null,              // settings
  target: null,         // { kind, url, title, tabId, windowId, favIconUrl, srcUrl }
  page: null,           // what extractPage found
  meta: null,           // what the Pi found (/api/meta)
  folders: [],
  bookmarks: [],
  existing: null,       // a saved bookmark with the same URL
  update: false,        // save updates `existing` instead of making a new one
  dirty: { name: false, desc: false },
  thumbs: [],           // candidates: { label, load: () => Promise<Blob>, blob?, failed? }
  ti: -1,               // index of the candidate on screen (-1 = none)
  thumbBlob: null,      // what will be uploaded
  thumbIsCurrent: false,// the thumbnail on screen is the one already saved
  thumbRemoved: false,
  thumbStarted: false,
  thumbReq: 0,
  iconBlob: null,
  iconIsCurrent: false,
  saving: false,
  tags: [],             // tags on the bookmark being saved
  sugIdx: -1,           // highlighted tag suggestion
  folderId: null,       // chosen folder (null = Uncategorized)
  folderIdx: 0,         // highlighted row in the folder list
};

// ---------- start ----------

init().catch((e) => showError(e.message || String(e)));

async function init() {
  st.s = await getSettings();
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
  $('connect-btn').onclick = () => { chrome.runtime.openOptionsPage(); closeSoon(0); };
  $('brand').onclick = (e) => { e.preventDefault(); openCrumbs(); };
  $('open').onclick = openCrumbs;
  $('done-open').onclick = openCrumbs;
  $('done-close').onclick = () => closeSoon(0);

  if (!st.s.server) return showConnect();
  if (!(await hasServerPermission(st.s.server))) {
    return showConnect('Chrome no longer lets the extension talk to <b>' + esc(st.s.server) + '</b>. Open the settings and connect again.');
  }
  showWho();
  refreshUser();

  st.target = await getTarget();
  const t = st.target;
  $('form').hidden = false;
  $('name').value = cleanTitle(t.title || '', t.url);
  $('url').value = cleanURL(t.url || '');
  setLetter();
  wireForm();

  if (!isSavable(t.url)) {
    st.thumbs = [];
    showEmptyThumb('No preview for this page');
  }

  // Load the library (folders, duplicates) and read the page at the same time.
  const libP = loadLibrary();
  const pageP = isSavable(t.url) ? readPage() : Promise.resolve();
  await libP;
  await pageP;
  if (!isSavable(t.url)) return;

  // Ask the Pi when the page itself gave us too little.
  const p = st.page;
  const needMeta = !p || (!p.images.length && st.s.autoThumbnail) || (!p.description && st.s.autoDescription) || youtubeID(t.url);
  if (needMeta) st.meta = await api('GET', '/api/meta?url=' + encodeURIComponent(t.url), undefined, { timeout: 15000 }).catch(() => null);

  fillText();
  buildThumbs();
  pickIcon();
  if (st.s.autoThumbnail || st.thumbIsCurrent) startThumbs();
  else showEmptyThumb('Add a thumbnail', true);
}

// getTarget is what to save: a right-clicked link or image, or the current tab.
async function getTarget() {
  const { pending } = await chrome.storage.session.get('pending').catch(() => ({}));
  if (pending && Date.now() - pending.at < 60_000) {
    await chrome.storage.session.remove('pending').catch(() => {});
    let tab = null;
    if (pending.tabId != null) tab = await chrome.tabs.get(pending.tabId).catch(() => null);
    if (pending.kind === 'link') {
      return { kind: 'link', url: pending.url, title: pending.title || '', tabId: null };
    }
    if (tab) {
      return { kind: pending.kind, url: tab.url, title: tab.title, tabId: tab.id, windowId: tab.windowId, favIconUrl: tab.favIconUrl, srcUrl: pending.srcUrl, active: tab.active };
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return { kind: 'page', url: '', title: '' };
  return { kind: 'page', url: tab.url || tab.pendingUrl || '', title: tab.title || '', tabId: tab.id, windowId: tab.windowId, favIconUrl: tab.favIconUrl, active: true };
}

async function loadLibrary() {
  try {
    const out = await api('GET', '/api/bookmarks');
    st.folders = out.folders || [];
    st.bookmarks = out.bookmarks || [];
  } catch (e) {
    if (e instanceof ApiError && e.status === 423) {
      banner('Crumbs is locked. <button type="button" class="link" id="unlock">Open Crumbs</button> and enter the database key, then open this again.', true);
      $('unlock').onclick = openCrumbs;
      $('save').disabled = true;
    } else if (e instanceof ApiError && e.status === 401) {
      banner('You are signed out of Crumbs. <button type="button" class="link" id="relogin">Sign in again</button>', true);
      $('relogin').onclick = () => chrome.runtime.openOptionsPage();
      $('save').disabled = true;
    } else {
      showError(e.message);
    }
  }
  findExisting();
  fillFolders();
}

// refreshLibrary reloads the bookmarks without touching what the user typed.
async function refreshLibrary() {
  try {
    const out = await api('GET', '/api/bookmarks');
    st.folders = out.folders || [];
    st.bookmarks = out.bookmarks || [];
    const key = urlKey($('url').value.trim());
    st.existing = st.bookmarks.find((b) => urlKey(b.url) === key) || st.existing;
  } catch { /* keep what we have */ }
}

async function readPage() {
  const t = st.target;
  if (t.kind === 'link' || t.tabId == null) return;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: t.tabId }, func: extractPage });
    st.page = res && res.result ? res.result : null;
  } catch {
    st.page = null; // chrome:// pages, the Web Store, PDFs and the like
  }
}

// ---------- text fields ----------

function cleanTitle(title, url) {
  let s = String(title || '').replace(/\s+/g, ' ').trim();
  if (youtubeID(url)) s = s.replace(/^\(\d+\)\s*/, '').replace(/\s+-\s+YouTube$/, '');
  return s.slice(0, 300);
}

function pageDescription() {
  const p = st.page, m = st.meta;
  return (p && p.selection) || (p && p.description) || (m && m.description) || '';
}

function fillText() {
  const t = st.target, p = st.page, m = st.meta;
  if (!st.dirty.name && !st.existing) {
    const title = (youtubeID(t.url) && m && m.title) || (p && p.title) || (m && m.title) || t.title;
    if (title) $('name').value = cleanTitle(title, t.url);
  }
  const desc = pageDescription();
  if (st.s.autoDescription && !st.dirty.desc && !st.existing && desc) {
    $('desc').value = desc.slice(0, 2000);
  }
  updateDescFill();
  setLetter();
}

function updateDescFill() {
  const desc = pageDescription();
  $('desc-fill').hidden = !desc || $('desc').value.trim() === desc.trim();
}

// ---------- folders ----------

// The folder field shows the chosen folder. Clicking it opens a list you can
// type into to find a folder; a name that isn't there can be created.

function fillFolders(selectId) {
  let want = selectId;
  if (want === undefined) {
    if (st.existing) want = st.existing.folderId;
    else if (st.s.rememberFolder) want = st.s.lastFolder;
  }
  const ok = want != null && st.folders.some((f) => f.id === want);
  setFolder(ok ? want : null);
}

function folderName(id) {
  return id == null ? 'Uncategorized' : folderPath(st.folders, id);
}

function setFolder(id) {
  st.folderId = id;
  $('folder').value = folderName(id);
  $('folder').title = folderName(id);
}

function folderValue() {
  return st.folderId ?? null;
}

function folderMenuOpen() { return !$('folder-menu').hidden; }

function openFolderMenu(keepText = false) {
  if (folderMenuOpen()) return;
  closeTagMenu();
  $('folder-menu').hidden = false;
  $('folder').setAttribute('aria-expanded', 'true');
  if (!keepText) $('folder').value = '';
  $('folder').placeholder = folderName(st.folderId);
  showFolders();
}

function closeFolderMenu(focus = false) {
  if (!folderMenuOpen()) return;
  $('folder-menu').hidden = true;
  $('folder').setAttribute('aria-expanded', 'false');
  $('folder').placeholder = 'Find or create a folder';
  setFolder(st.folderId); // put the chosen name back
  if (focus) $('folder').focus();
}

function showFolders() {
  const q = $('folder').value.trim();
  const ql = q.toLowerCase();
  const items = [];
  if (!q) {
    // The whole tree, indented, like before.
    items.push({ id: null, label: 'Uncategorized' });
    for (const f of folderTree(st.folders)) items.push({ id: f.id, label: ' '.repeat(f.depth) + f.name });
  } else {
    // Matches by name, shown with their full path, names starting with the text first.
    const hits = st.folders
      .filter((f) => f.name.toLowerCase().includes(ql) || folderPath(st.folders, f.id).toLowerCase().includes(ql))
      .map((f) => ({ id: f.id, label: folderPath(st.folders, f.id), starts: f.name.toLowerCase().startsWith(ql) }))
      .sort((a, b) => (b.starts - a.starts) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    if ('uncategorized'.includes(ql)) items.push({ id: null, label: 'Uncategorized' });
    items.push(...hits);
    const exact = st.folders.some((f) => f.name.toLowerCase() === ql);
    if (!exact) items.push({ create: q.slice(0, 100), label: `Create “${q.slice(0, 100)}”` });
  }
  const box = $('folder-list');
  box.textContent = '';
  items.forEach((it) => {
    const d = document.createElement('div');
    d.setAttribute('role', 'option');
    d.textContent = it.label;
    if (it.create) d.className = 'new';
    else if (it.id === st.folderId) d.className = 'current';
    d.onmousedown = (e) => { e.preventDefault(); pickFolder(it); };
    d._item = it;
    box.append(d);
  });
  // Typing highlights the best match; with no text, the current folder.
  st.folderIdx = q ? 0 : Math.max(0, items.findIndex((it) => !it.create && it.id === st.folderId));
  markFolders();
}

function markFolders() {
  [...$('folder-list').children].forEach((d, i) => {
    d.setAttribute('aria-selected', String(i === st.folderIdx));
    if (i === st.folderIdx) d.scrollIntoView({ block: 'nearest' });
  });
}

async function pickFolder(it) {
  if (it.create) {
    await createFolder(it.create);
  } else {
    st.folderId = it.id;
  }
  closeFolderMenu();
}

function folderKey(e) {
  const opts = $('folder-list').children;
  if (!folderMenuOpen()) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); openFolderMenu(); }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = opts.length;
    if (!n) return;
    st.folderIdx = e.key === 'ArrowDown' ? (st.folderIdx + 1) % n : (st.folderIdx - 1 + n) % n;
    markFolders();
  } else if (e.key === 'Enter') {
    if (e.ctrlKey || e.metaKey) { closeFolderMenu(); return save(e); }
    e.preventDefault();
    const d = opts[st.folderIdx];
    if (d) pickFolder(d._item);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFolderMenu(true);
  } else if (e.key === 'Tab') {
    closeFolderMenu();
  }
}

async function createFolder(name) {
  name = name.trim();
  if (!name) return;
  try {
    const f = await api('POST', '/api/folders', { name, parentId: null });
    st.folders.push(f);
    st.folderId = f.id;
    clearError();
  } catch (e) {
    showError(e.message);
  }
}

// ---------- tags ----------

// Same rules as Crumbs: lowercase, no commas or leading #, up to 40 characters.
function cleanTag(t) {
  return String(t).trim().replace(/^#+/, '').replace(/,/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40);
}

// Every tag used in the library, most used first.
function knownTags() {
  const n = new Map();
  for (const b of st.bookmarks) for (const t of b.tags || []) n.set(t, (n.get(t) || 0) + 1);
  return [...n.keys()].sort((a, b) => n.get(b) - n.get(a) || a.localeCompare(b));
}

function renderTags() {
  const box = $('tag-chips');
  box.textContent = '';
  for (const t of st.tags) {
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.append(t);
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.title = 'Remove ' + t;
    x.setAttribute('aria-label', 'Remove tag ' + t);
    x.onclick = () => { removeTag(t); $('tag-input').focus(); showSuggest(); };
    chip.append(x);
    box.append(chip);
  }
  $('tag-input').placeholder = st.tags.length ? '' : 'Add a tag';
  const n = $('tag-count');
  n.hidden = !st.tags.length;
  n.textContent = st.tags.length;
  $('tag-btn').title = st.tags.length ? 'Tags: ' + st.tags.join(', ') : 'Tags';
}

function tagMenuOpen() { return !$('tag-menu').hidden; }

function openTagMenu() {
  closeFolderMenu();
  $('tag-menu').hidden = false;
  $('tag-btn').setAttribute('aria-expanded', 'true');
  $('tag-input').focus();
  showSuggest();
}

function closeTagMenu(focusBtn = false) {
  if (!tagMenuOpen()) return;
  addTag($('tag-input').value);
  $('tag-menu').hidden = true;
  $('tag-btn').setAttribute('aria-expanded', 'false');
  if (focusBtn) $('tag-btn').focus();
}

function addTag(raw) {
  const t = cleanTag(raw);
  $('tag-input').value = '';
  hideSuggest();
  if (!t || st.tags.includes(t) || st.tags.length >= 20) return;
  st.tags.push(t);
  renderTags();
}

function removeTag(t) {
  st.tags = st.tags.filter((x) => x !== t);
  renderTags();
}

function showSuggest() {
  const q = cleanTag($('tag-input').value);
  const list = (st.s.suggestTags ? knownTags() : []).filter((t) => !st.tags.includes(t) && (!q || t.includes(q)))
    .sort((a, b) => (q && b.startsWith(q)) - (q && a.startsWith(q)))
    .slice(0, 8);
  const box = $('tag-suggest');
  box.textContent = '';
  const items = list.map((t) => ({ t, label: t }));
  if (q && !list.includes(q) && !st.tags.includes(q)) items.push({ t: q, label: `Add “${q}”`, isNew: true });
  st.sugIdx = q ? 0 : -1;
  if (!items.length) return hideSuggest();
  items.forEach((it, i) => {
    const d = document.createElement('div');
    d.setAttribute('role', 'option');
    d.textContent = it.label;
    d.dataset.tag = it.t;
    if (it.isNew) d.className = 'new';
    // mousedown, so the input keeps focus.
    d.onmousedown = (e) => { e.preventDefault(); addTag(it.t); };
    box.append(d);
  });
  box.hidden = false;
  $('tag-input').setAttribute('aria-expanded', 'true');
  markSuggest();
}

function hideSuggest() {
  $('tag-suggest').textContent = '';
  $('tag-input').setAttribute('aria-expanded', 'false');
  st.sugIdx = -1;
}

function markSuggest() {
  [...$('tag-suggest').children].forEach((d, i) => {
    d.setAttribute('aria-selected', String(i === st.sugIdx));
    if (i === st.sugIdx) d.scrollIntoView({ block: 'nearest' });
  });
}

function tagKey(e) {
  const input = $('tag-input');
  const opts = $('tag-suggest').children;
  const open = $('tag-suggest').children.length > 0;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!open) return;
    const n = opts.length;
    st.sugIdx = e.key === 'ArrowDown' ? (st.sugIdx + 1) % n : (st.sugIdx - 1 + n) % n;
    markSuggest();
  } else if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && input.value.trim())) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return save(e);
    e.preventDefault();
    const pick = open && st.sugIdx >= 0 ? opts[st.sugIdx].dataset.tag : input.value;
    addTag(pick);
    showSuggest();
  } else if (e.key === 'Backspace' && !input.value && st.tags.length) {
    removeTag(st.tags[st.tags.length - 1]);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeTagMenu(true);
  }
}

// ---------- duplicates ----------

function findExisting() {
  const key = urlKey(st.target.url);
  if (!isSavable(st.target.url)) return;
  st.existing = st.bookmarks.find((b) => urlKey(b.url) === key) || null;
  if (!st.existing) return;
  setUpdate(true);
  const b = st.existing;
  $('name').value = b.name;
  $('desc').value = b.description || '';
  st.tags = Array.isArray(b.tags) ? [...b.tags] : [];
  renderTags();
  if (b.thumb) {
    st.thumbIsCurrent = true;
    st.thumbs.unshift({ label: 'Saved', current: true, load: () => api('GET', b.thumb, undefined, { raw: true }).then((r) => r.blob()) });
  }
  if (b.icon) {
    st.iconIsCurrent = true;
    api('GET', b.icon, undefined, { raw: true }).then((r) => r.blob()).then(showIcon).catch(() => {});
  }
}

function setUpdate(on) {
  st.update = on;
  const b = st.existing;
  if (!b) return;
  const where = b.folderId != null ? ' in <b>' + esc(folderPath(st.folders, b.folderId)) + '</b>' : '';
  if (on) {
    banner(`Already in Crumbs${where}. Saving updates it. <button type="button" class="link" id="as-new">Save a new copy instead</button>`);
    $('as-new').onclick = () => setUpdate(false);
    $('save').textContent = 'Update';
  } else {
    banner(`This will be a second copy. <button type="button" class="link" id="as-update">Update the saved one instead</button>`);
    $('as-update').onclick = () => setUpdate(true);
    $('save').textContent = 'Save';
  }
}

// ---------- thumbnails ----------

// findPreview is the "Find preview" button. With automatic thumbnails off
// the Pi was not asked yet, so ask it now.
async function findPreview() {
  const hasImages = st.thumbs.some((c) => !c.shot && !c.failed && !c.current);
  if (!hasImages && !st.meta && isSavable(st.target.url)) {
    $('thumb-empty-actions').hidden = true;
    $('thumb-status').textContent = 'Looking for a preview…';
    spin(true);
    st.meta = await api('GET', '/api/meta?url=' + encodeURIComponent(st.target.url), undefined, { timeout: 15000 }).catch(() => null);
    spin(false);
    const shot = st.thumbs.filter((c) => c.shot);
    st.thumbs = st.thumbs.filter((c) => !c.shot && !c.url);
    buildThumbs({ withShot: false });
    st.thumbs.push(...shot);
  }
  startThumbs();
}

function buildThumbs({ withShot = true } = {}) {
  const t = st.target, p = st.page, m = st.meta;
  const urls = [];
  const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  if (t.srcUrl) add(t.srcUrl);
  const yt = youtubeID(t.url);
  if (yt) {
    add(`https://i.ytimg.com/vi/${yt}/maxresdefault.jpg`);
    add(`https://i.ytimg.com/vi/${yt}/hqdefault.jpg`);
  }
  (p ? p.images : []).forEach(add);
  (m ? m.images : []).forEach(add);
  for (const u of urls) {
    st.thumbs.push({ label: 'Image', url: u, load: async () => makeThumb(await fetchImage(u)) });
  }
  if (withShot && canScreenshot()) st.thumbs.push({ label: 'Screenshot', shot: true, load: screenshot });
}

function canScreenshot() {
  const t = st.target;
  return t.kind !== 'link' && t.windowId != null && t.active !== false && isSavable(t.url);
}

async function screenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(st.target.windowId, { format: 'jpeg', quality: 90 });
  const blob = await (await fetch(dataUrl)).blob();
  return makeThumb(blob, 'top');
}

function startThumbs() {
  st.thumbStarted = true;
  $('thumb-empty-actions').hidden = true;
  if (!st.thumbs.length) return showEmptyThumb('No preview found', true);
  // Without a real preview image, a screenshot is the fallback.
  showThumb(0, 1);
}

// showThumb shows candidate i. If it fails it moves on in direction dir.
async function showThumb(i, dir = 1) {
  const req = ++st.thumbReq;
  const n = st.thumbs.length;
  for (let k = 0; k < n; k++) {
    const idx = ((i + k * dir) % n + n) % n;
    const c = st.thumbs[idx];
    if (c.failed) continue;
    spin(true);
    $('thumb-status').textContent = c.shot ? 'Taking a screenshot…' : 'Loading the preview…';
    try {
      if (!c.blob) c.blob = await c.load();
      if (req !== st.thumbReq) return;
      spin(false);
      return setThumb(c.blob, idx, !!c.current);
    } catch {
      c.failed = true;
      if (req !== st.thumbReq) return;
    }
  }
  spin(false);
  if (req === st.thumbReq) showEmptyThumb('No preview found', true);
}

function setThumb(blob, idx, isCurrent) {
  st.ti = idx;
  st.thumbBlob = blob;
  st.thumbIsCurrent = isCurrent;
  st.thumbRemoved = false;
  const img = $('thumb-img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.dataset.url = URL.createObjectURL(blob);
  img.src = img.dataset.url;
  img.hidden = false;
  $('thumb-empty').hidden = true;
  $('thumb-bar').hidden = false;
  updateThumbBar();
}

function updateThumbBar() {
  const live = st.thumbs.filter((c) => !c.failed);
  const pos = live.indexOf(st.thumbs[st.ti]);
  const many = live.length > 1;
  $('t-prev').hidden = !many;
  $('t-next').hidden = !many;
  const c = st.thumbs[st.ti];
  $('thumb-count').textContent = c ? (c.label === 'Image' ? '' : c.label + (many ? ' · ' : '')) + (many ? `${pos + 1} / ${live.length}` : '') : 'Your image';
  $('thumb-count').hidden = !$('thumb-count').textContent;
  $('t-shot').hidden = !canScreenshot() || (c && c.shot);
}

function showEmptyThumb(msg, withActions = false) {
  st.ti = -1;
  st.thumbBlob = null;
  const img = $('thumb-img');
  img.hidden = true;
  $('thumb-empty').hidden = false;
  $('thumb-bar').hidden = true;
  $('thumb-status').textContent = msg;
  $('thumb-empty-actions').hidden = !withActions;
  const canFind = st.thumbs.some((c) => !c.shot && !c.failed) || (!st.meta && isSavable(st.target.url));
  $('t-find').hidden = st.thumbStarted || !canFind;
  $('t-shot2').hidden = !canScreenshot();
}

function stepThumb(dir) {
  const n = st.thumbs.length;
  if (!n) return;
  showThumb(((st.ti + dir) % n + n) % n, dir);
}

async function useScreenshot() {
  let idx = st.thumbs.findIndex((c) => c.shot);
  if (idx < 0) return;
  st.thumbs[idx].failed = false;
  st.thumbs[idx].blob = null; // take a fresh one
  st.thumbStarted = true;
  showThumb(idx, 1);
}

async function useFile(file) {
  if (!file || !/^image\//.test(file.type)) return;
  spin(true);
  try {
    const blob = await makeThumb(file, 'auto').catch(() => makeThumb(file, 'top'));
    st.thumbs.push({ label: 'Your image', blob, load: async () => blob });
    st.thumbStarted = true;
    setThumb(blob, st.thumbs.length - 1, false);
  } catch {
    showError('That image could not be read.');
  } finally {
    spin(false);
  }
}

function removeThumb() {
  st.thumbReq++;
  spin(false);
  showEmptyThumb('No thumbnail', true);
  st.thumbRemoved = true;
  $('t-find').hidden = !st.thumbs.some((c) => !c.shot && !c.failed);
}

function spin(on) { $('thumb-spin').hidden = !on; }

// ---------- favicon ----------

async function pickIcon() {
  if (st.iconIsCurrent) return;
  const t = st.target, p = st.page, m = st.meta;
  const urls = [];
  const add = (u) => { if (u && !urls.includes(u)) urls.push(u); };
  (p ? p.icons : []).forEach(add);
  if (t.favIconUrl && /^(https?:|data:image\/)/.test(t.favIconUrl)) add(t.favIconUrl);
  (m ? m.icons : []).forEach(add);
  if (isSavable(t.url)) add(chromeFavicon(t.url));
  for (const u of urls) {
    try {
      const blob = await makeIcon(await fetchImage(u));
      if (st.iconIsCurrent) return;
      st.iconBlob = blob;
      return showIcon(blob);
    } catch { /* next */ }
  }
}

function showIcon(blob) {
  const img = $('fav');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.dataset.url = URL.createObjectURL(blob);
  img.src = img.dataset.url;
  img.hidden = false;
  $('fav-letter').textContent = '';
}

function setLetter() {
  if (!$('fav').hidden) return;
  const s = $('name').value.trim() || hostOf($('url').value);
  $('fav-letter').textContent = s ? [...s][0] : '';
}

// ---------- saving ----------

async function save(e) {
  e && e.preventDefault();
  if (st.saving || $('save').disabled) return;
  clearError();
  const url = $('url').value.trim();
  if (!url) return showError('A URL is required.');
  const body = {
    name: $('name').value.trim(),
    url,
    description: $('desc').value.trim(),
    folderId: folderValue(),
  };
  // A tag still being typed counts too.
  closeTagMenu();
  addTag($('tag-input').value);
  body.tags = st.tags;
  st.saving = true;
  const btn = $('save');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = st.update ? 'Updating…' : 'Saving…';
  try {
    const updating = st.update && st.existing;
    const b = updating
      ? await api('PUT', '/api/bookmarks/' + st.existing.id, body)
      : await api('POST', '/api/bookmarks', body);

    const problems = [];
    // Wait for a thumbnail that is still loading, so it isn't lost.
    if (st.thumbBlob && !st.thumbIsCurrent) {
      await api('PUT', `/api/bookmarks/${b.id}/thumb`, st.thumbBlob).catch((err) => problems.push('the thumbnail (' + err.message + ')'));
    } else if (updating && st.thumbRemoved && st.existing.thumb) {
      await api('DELETE', `/api/bookmarks/${b.id}/thumb`).catch(() => {});
    }
    if (st.iconBlob && !(updating && st.existing.icon)) {
      await api('PUT', `/api/bookmarks/${b.id}/icon`, st.iconBlob).catch((err) => problems.push('the favicon (' + err.message + ')'));
    }
    await setSettings({ lastFolder: body.folderId });
    if (st.target.tabId != null && st.target.kind !== 'link') {
      chrome.action.setBadgeText({ tabId: st.target.tabId, text: '✓' }).catch(() => {});
      chrome.action.setBadgeBackgroundColor({ tabId: st.target.tabId, color: '#000' }).catch(() => {});
    }
    // Remember it as saved, so the ✓ shows when you come back to this page.
    {
      const key = urlKey(b.url || body.url);
      const { saved } = await chrome.storage.session.get('saved').catch(() => ({}));
      if (saved && key && !saved.keys.includes(key)) {
        await chrome.storage.session.set({ saved: { at: saved.at, keys: [...saved.keys, key] } }).catch(() => {});
      }
    }
    showDone(b, updating, problems);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = label;
    if (err instanceof ApiError && err.status === 409) {
      // The server's duplicate rule said no. Offer to update the saved one.
      await refreshLibrary();
      if (st.existing && !st.update) {
        showError(err.message.replace(/[.!]?$/, '.') + ' You can update the saved one instead.');
        setUpdate(true);
      } else {
        showError(err.message);
      }
    } else if (err instanceof ApiError && err.status === 401) {
      showError('You are signed out of Crumbs. Open the settings to sign in again.');
    } else {
      showError(err.message || String(err));
    }
  } finally {
    st.saving = false;
  }
}

function showDone(b, updated, problems) {
  $('form').hidden = true;
  $('done').hidden = false;
  $('done-title').textContent = updated ? 'Updated in Crumbs' : 'Saved to Crumbs';
  const where = b.folderId != null ? folderPath(st.folders, b.folderId) : 'Uncategorized';
  let msg = `“${b.name}” is in ${where}.`;
  if (problems.length) msg += ' Could not upload ' + problems.join(' and ') + '.';
  $('done-msg').textContent = msg;
  $('done-close').focus();
  if (st.s.closeAfterSave && !problems.length) closeSoon(1300);
}

// ---------- wiring ----------

function wireForm() {
  $('form').addEventListener('submit', save);
  $('tagbox').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget || e.target.id === 'tag-chips') { e.preventDefault(); $('tag-input').focus(); } });
  $('tag-input').addEventListener('keydown', tagKey);
  $('tag-input').addEventListener('input', () => {
    // A comma (typed or pasted) finishes a tag.
    const v = $('tag-input').value;
    if (v.includes(',')) {
      const parts = v.split(',');
      const rest = parts.pop();
      parts.forEach(addTag);
      $('tag-input').value = rest;
    }
    showSuggest();
  });
  $('tag-btn').onclick = () => (tagMenuOpen() ? closeTagMenu(true) : openTagMenu());
  // Clicking anywhere else closes the menu, keeping a tag that was being typed.
  document.addEventListener('mousedown', (e) => {
    if (tagMenuOpen() && !e.target.closest('#tag-menu, #tag-btn')) closeTagMenu();
    if (folderMenuOpen() && !e.target.closest('#folder-menu, #folder')) closeFolderMenu();
  });
  document.addEventListener('focusin', (e) => {
    if (tagMenuOpen() && !e.target.closest('#tag-menu, #tag-btn')) closeTagMenu();
    if (folderMenuOpen() && !e.target.closest('#folder-menu, #folder')) closeFolderMenu();
  });
  // The error floats over the form: click it, or keep typing, to dismiss it.
  $('error').addEventListener('click', clearError);
  $('form').addEventListener('input', clearError);
  $('name').addEventListener('input', () => { st.dirty.name = true; setLetter(); });
  $('url').addEventListener('input', () => setLetter());
  $('desc').addEventListener('input', () => { st.dirty.desc = true; updateDescFill(); });
  $('desc').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(e); });
  $('desc-fill').onclick = () => { $('desc').value = pageDescription().slice(0, 2000); st.dirty.desc = true; updateDescFill(); };

  $('folder').addEventListener('mousedown', () => { if (!folderMenuOpen()) setTimeout(openFolderMenu); });
  $('folder').addEventListener('focus', () => { if (!folderMenuOpen()) openFolderMenu(); });
  $('folder').addEventListener('input', () => { if (!folderMenuOpen()) openFolderMenu(true); showFolders(); });
  $('folder').addEventListener('keydown', folderKey);

  $('t-prev').onclick = () => stepThumb(-1);
  $('t-next').onclick = () => stepThumb(1);
  $('t-shot').onclick = useScreenshot;
  $('t-shot2').onclick = useScreenshot;
  $('t-find').onclick = findPreview;
  $('t-remove').onclick = removeThumb;
  $('t-upload').onclick = () => $('t-file').click();
  $('t-upload2').onclick = () => $('t-file').click();
  $('t-file').onchange = () => { useFile($('t-file').files[0]); $('t-file').value = ''; };

  // Paste or drop an image anywhere on the thumbnail.
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); useFile(item.getAsFile()); }
  });
  const box = $('thumb');
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drop'); });
  box.addEventListener('dragleave', () => box.classList.remove('drop'));
  box.addEventListener('drop', (e) => {
    e.preventDefault();
    box.classList.remove('drop');
    useFile(e.dataTransfer.files[0]);
  });
}

// ---------- small helpers ----------

function showConnect(html) {
  $('connect').hidden = false;
  if (html) $('connect-msg').innerHTML = html;
}

function showWho() {
  const s = st.s;
  const name = s.auth === 'guest' ? 'Guest' : (s.user && (s.user.displayName || s.user.username)) || '';
  $('who').textContent = name;
  $('me').title = name ? 'Signed in to Crumbs as ' + name : '';
  $('me').hidden = false;
  fillAvatar($('avatar'), s.auth === 'guest' ? null : s.user, name || 'Guest');
  // The server's address, at the bottom.
  let addr = s.server;
  try { const u = new URL(s.server); addr = u.host + u.pathname.replace(/\/$/, ''); } catch { /* as typed */ }
  $('server-line').textContent = addr;
  $('server-line').title = s.server;
  $('server-line').hidden = false;
}

// refreshUser picks up a new name or profile picture changed in Crumbs.
async function refreshUser() {
  if (st.s.auth === 'guest') return;
  try {
    const state = await api('GET', '/api/state', undefined, { timeout: 8000 });
    if (state.locked || !state.user) return;
    const u = publicUser(state.user);
    const old = st.s.user || {};
    if (u.avatar !== old.avatar || u.displayName !== old.displayName || u.username !== old.username) {
      st.s.user = u;
      await setSettings({ user: u });
      showWho();
    }
  } catch { /* offline: keep what we have */ }
}

function banner(html, warn = false) {
  const b = $('banner');
  b.innerHTML = html;
  b.classList.toggle('warn', warn);
  b.hidden = false;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.title = 'Click to close';
  el.hidden = false;
  if ($('form').hidden && $('connect').hidden && $('done').hidden) $('form').hidden = false;
}

function clearError() { $('error').hidden = true; }

function openCrumbs() {
  if (st.s && st.s.server) chrome.tabs.create({ url: st.s.server + '/' });
  closeSoon(0);
}

function closeSoon(ms) { setTimeout(() => window.close(), ms); }

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
