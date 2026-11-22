// Crumbs extension service worker: the right-click menu and first-run setup.

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

// The ✓ badge marks a page as saved; clear it when the tab goes elsewhere.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.url) chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
