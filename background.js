// Crumbs extension service worker: the right-click menu, first-run setup and
// the ✓ badge on pages that are already in Crumbs.

import { api, getSettings, hasServerPermission, isSavable, urlKey } from './lib.js';

const MENUS = [
  { id: 'crumbs-page', title: 'Save page to Crumbs', contexts: ['page', 'frame', 'selection'] },
  { id: 'crumbs-link', title: 'Save link to Crumbs', contexts: ['link'] },
  { id: 'crumbs-image', title: 'Save page to Crumbs with this image', contexts: ['image'] },
];

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) chrome.contextMenus.create(m);
  });
  if (details.reason === 'install') {
    const { server } = await chrome.storage.local.get('server');
    if (!server) chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const kind = { 'crumbs-page': 'page', 'crumbs-link': 'link', 'crumbs-image': 'image' }[info.menuItemId];
  if (!kind) return;
  const pending = {
    kind,
    url: kind === 'link' ? info.linkUrl : (info.pageUrl || tab?.url || ''),
    title: kind === 'link' ? (info.selectionText || info.linkText || '') : (tab?.title || ''),
    srcUrl: kind === 'image' ? info.srcUrl : '',
    tabId: tab?.id ?? null,
    at: Date.now(),
  };
  // Store first (it's quick), but open the popup right away: Chrome only
  // allows openPopup() while the click is still fresh.
  chrome.storage.session.set({ pending });
  chrome.action.openPopup().catch(() => {
    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?window=1'),
      type: 'popup', width: 420, height: 720, focused: true,
    });
  });
});

// ---------- the ✓ badge ----------
// A tab shows ✓ when its page is already in Crumbs. The saved addresses are
// kept in session storage (it lasts while Chrome is open) and fetched again
// when they are more than a couple of minutes old.

const FRESH_MS = 2 * 60 * 1000;
let loading = null;

async function savedKeys(force = false) {
  const { saved } = await chrome.storage.session.get('saved');
  if (!force && saved && Date.now() - saved.at < FRESH_MS) return new Set(saved.keys);
  if (!loading) {
    loading = (async () => {
      const s = await getSettings();
      if (!s.server || !(await hasServerPermission(s.server))) return null;
      const out = await api('GET', '/api/bookmarks', undefined, { timeout: 15000 });
      const keys = [...new Set((out.bookmarks || []).map((b) => urlKey(b.url)).filter(Boolean))];
      await chrome.storage.session.set({ saved: { at: Date.now(), keys } });
      return new Set(keys);
    })().catch(() => null).finally(() => { loading = null; });
  }
  // Offline or locked: fall back to what we knew, or nothing.
  return (await loading) || (saved ? new Set(saved.keys) : null);
}

async function markTab(tab) {
  if (!tab || tab.id == null) return;
  const url = tab.url || tab.pendingUrl || '';
  let on = false;
  if (isSavable(url)) {
    const keys = await savedKeys();
    on = !!keys && keys.has(urlKey(url));
  }
  // The tab may have moved on while we were looking.
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now || (now.url || now.pendingUrl || '') !== url) return;
  await chrome.action.setBadgeText({ tabId: tab.id, text: on ? '✓' : '' }).catch(() => {});
  if (on) await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#000' }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  if (change.url || change.status === 'complete') markTab(tab);
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(markTab).catch(() => {});
});

// Another server or account: what we knew no longer applies.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.server || changes.token || changes.auth)) {
    chrome.storage.session.remove('saved').catch(() => {});
  }
});
