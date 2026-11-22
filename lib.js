// Shared code for the Crumbs extension: settings, talking to the Crumbs
// server, reading pages and making thumbnails.

import { AVATAR_ICONS } from './avatars.js';

// ---------- settings ----------

export const DEFAULTS = {
  server: '',            // e.g. "http://192.168.1.20:9099" (no trailing slash)
  token: '',             // API token, when the server supports /api/token
  auth: '',              // "token", "cookie" (Crumbs' browser sign-in) or "guest" (login is off)
  user: null,            // { username, displayName, avatar } for display only
  autoDescription: true, // fill the description from the page
  autoThumbnail: true,   // pick a preview image (or a screenshot) automatically
  rememberFolder: true,  // preselect the folder used last time
  closeAfterSave: true,  // close the popup a moment after saving
  lastFolder: null,      // id of the folder used last time (null = Uncategorized)
};

export async function getSettings() {
  const s = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...s };
}

export function setSettings(patch) {
  return chrome.storage.local.set(patch);
}

// normalizeServer turns what the user typed into "scheme://host[:port][/path]".
export function normalizeServer(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Enter the address of your Crumbs server.');
  // A Pi on the home network is almost always plain http.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The address must start with http:// or https://');
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + path;
}

// The host permission Chrome asks the user for. Match patterns without a
// port cover every port on that host.
export function originPattern(server) {
  const u = new URL(server);
  return `${u.protocol}//${u.hostname}/*`;
}

export async function hasServerPermission(server) {
  try { return await chrome.permissions.contains({ origins: [originPattern(server)] }); }
  catch { return false; }
}

// ---------- talking to Crumbs ----------

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// request is the low-level call. Every request carries X-Crumbs-Client, which
// is how the server tells the extension apart from a cross-site web page.
export async function request(server, { method = 'GET', path, body, token = '', timeout = 20000, raw = false } = {}) {
  const headers = { 'X-Crumbs-Client': 'chrome-extension' };
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body instanceof Blob) {
    payload = body;
    if (body.type) headers['Content-Type'] = body.type;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(server + path, {
      method, headers, body: payload,
      // With a token we never send cookies, so a request is only ever one account.
      credentials: token ? 'omit' : 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const msg = e && e.name === 'TimeoutError'
      ? 'Crumbs did not answer in time. Is the Pi on?'
      : 'Could not reach Crumbs at ' + server + '. Is the address right and the Pi on?';
    throw new ApiError(0, msg);
  }
  if (raw) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP ' + res.status);
    return res;
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    let msg = (data && data.error) || 'Crumbs answered HTTP ' + res.status;
    if (res.status === 403 && /cross-site/i.test(msg)) {
      msg = 'Your Crumbs server blocked the extension. Update Crumbs on the Pi to the version with extension support.';
    }
    throw new ApiError(res.status, msg);
  }
  return data;
}

// api calls the connected server with the saved sign-in.
export async function api(method, path, body, opts = {}) {
  const s = await getSettings();
  if (!s.server) throw new ApiError(0, 'Not connected to Crumbs yet.');
  return request(s.server, { method, path, body, token: s.auth === 'token' ? s.token : '', ...opts });
}

// probe reads /api/state with the browser's own Crumbs sign-in (if any).
export function probe(server) {
  return request(server, { path: '/api/state', timeout: 10000 });
}

// signIn signs in with a username and password. It prefers an API token (a
// dedicated sign-in for the extension) and falls back to the normal Crumbs
// sign-in cookie on servers that don't have tokens yet.
export async function signIn(server, username, password) {
  try {
    const out = await request(server, {
      method: 'POST', path: '/api/token',
      body: { username, password, name: 'Chrome extension' },
    });
    if (out && out.token) {
      return { auth: 'token', token: out.token, user: out.user || { username } };
    }
  } catch (e) {
    // 404/405: this server has no tokens. Anything else is a real answer.
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
  }
  await request(server, { method: 'POST', path: '/api/login', body: { username, password } });
  const st = await probe(server);
  if (!st.user) {
    throw new Error('Signed in, but Chrome did not keep the Crumbs cookie. Update Crumbs on the Pi to the version with extension support.');
  }
  return { auth: 'cookie', token: '', user: st.user };
}

export function publicUser(u) {
  if (!u) return null;
  return { username: u.username || '', displayName: u.displayName || '', avatar: u.avatar || '' };
}

// ---------- folders ----------

// folderTree returns folders in sidebar order, each with its depth.
export function folderTree(folders) {
  const kids = new Map();
  for (const f of folders) {
    const p = f.parentId ?? 0;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  }
  for (const list of kids.values()) {
    list.sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id - b.id));
  }
  const out = [];
  const seen = new Set();
  const walk = (pid, depth) => {
    for (const f of kids.get(pid) || []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push({ ...f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(0, 0);
  // Folders whose parent is missing still show up, at the top level.
  for (const f of folders) if (!seen.has(f.id)) out.push({ ...f, depth: 0 });
  return out;
}

export function folderPath(folders, id) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const names = [];
  for (let cur = byId.get(id), n = 0; cur && n < 50; cur = byId.get(cur.parentId), n++) names.unshift(cur.name);
  return names.join(' / ');
}

// ---------- URLs ----------

export function isSavable(url) {
  return /^https?:\/\//i.test(url || '');
}

// cleanURL removes tracking parameters (utm_source and friends) from a link.
const TRACKING = /^(utm_[a-z_]+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|mkt_tok|yclid|twclid)$/i;
export function cleanURL(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    const shareSi = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/i.test(u.hostname);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING.test(k) || (shareSi && k === 'si')) { u.searchParams.delete(k); changed = true; }
    }
    return changed ? u.href : raw;
  } catch {
    return raw;
  }
}

// urlKey is a forgiving comparison for "is this page already saved?".
export function urlKey(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|si$)/i.test(p)) u.searchParams.delete(p);
    }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    const q = u.searchParams.toString();
    return host + (u.port ? ':' + u.port : '') + path + (q ? '?' + q : '');
  } catch {
    return String(raw || '');
  }
}

export function youtubeID(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
    if (h === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
    if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([\w-]{6,})/);
      if (m) return m[2];
    }
  } catch { /* not a URL */ }
  return '';
}

export function hostOf(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ---------- reading the page ----------

// extractPage runs inside the web page (chrome.scripting), so it must not use
// anything from outside its own body.
export function extractPage() {
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return ''; } };
  const metaAll = (name) => [...document.querySelectorAll(
    `meta[property="${name}" i], meta[name="${name}" i], meta[itemprop="${name}" i]`)]
    .map((m) => (m.getAttribute('content') || '').trim()).filter(Boolean);
  const meta = (...names) => { for (const n of names) { const v = metaAll(n)[0]; if (v) return v; } return ''; };

  // Single-page apps (YouTube and friends) often leave the og: tags of the
  // first page in place. If og:url points somewhere else, ignore them.
  let stale = false;
  const ogUrl = meta('og:url');
  if (ogUrl) {
    try {
      const a = new URL(ogUrl, location.href), b = new URL(location.href);
      const p = (u) => u.pathname.replace(/\/+$/, '');
      stale = p(a) !== p(b) || (a.searchParams.get('v') || '') !== (b.searchParams.get('v') || '');
    } catch { /* keep going */ }
  }

  const title = (!stale && meta('og:title', 'twitter:title')) || document.title || '';
  const description = (!stale && meta('og:description', 'twitter:description')) || meta('description') || '';

  const images = [];
  const addImg = (u) => {
    u = abs(u);
    if (u && /^(https?:|data:image\/)/i.test(u) && !images.includes(u)) images.push(u);
  };
  if (!stale) {
    for (const n of ['og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'thumbnailUrl', 'image']) {
      metaAll(n).forEach(addImg);
    }
    const src = document.querySelector('link[rel="image_src"]');
    if (src) addImg(src.getAttribute('href'));
  }
  // The biggest images on the page, as more choices.
  [...document.images]
    .filter((i) => i.naturalWidth >= 300 && i.naturalHeight >= 150 && (i.currentSrc || i.src))
    .map((i) => ({ src: i.currentSrc || i.src, area: i.naturalWidth * i.naturalHeight }))
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .forEach((i) => addImg(i.src));

  const icons = [...document.querySelectorAll('link[rel~="icon" i], link[rel="apple-touch-icon" i], link[rel="apple-touch-icon-precomposed" i], link[rel="mask-icon" i]')]
    .filter((l) => !/mask-icon/i.test(l.rel))
    .map((l) => {
      const href = abs(l.getAttribute('href'));
      const m = (l.getAttribute('sizes') || '').match(/(\d+)\s*x/i);
      let size = m ? +m[1] : (/apple/i.test(l.rel) ? 180 : 16);
      if (/svg/i.test(l.type || '') || /\.svg(\?|#|$)/i.test(href) || /any/i.test(l.getAttribute('sizes') || '')) size = 96;
      // Best: the smallest icon that is at least 48px; then the biggest smaller one.
      const score = size >= 48 ? 10000 - size : size;
      return { href, score };
    })
    .filter((i) => i.href)
    .sort((a, b) => b.score - a.score)
    .map((i) => i.href);

  // Text the user selected on the page makes a good description.
  let selection = '';
  try { selection = String(getSelection() || '').replace(/\s+/g, ' ').trim(); } catch { /* none */ }
  if (selection.length < 12) selection = '';

  return {
    url: location.href,
    selection: selection.slice(0, 2000),
    title: title.replace(/\s+/g, ' ').trim().slice(0, 300),
    description: description.replace(/\s+/g, ' ').trim().slice(0, 2000),
    images: images.slice(0, 12),
    icons: [...new Set(icons)].slice(0, 6),
  };
}

// ---------- images ----------

// fetchImage downloads an image. It tries the extension first (works for the
// current site and for images that allow it), then asks the Pi to fetch it.
export async function fetchImage(url) {
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('chrome-extension:')) {
    const r = await fetch(url);
    return r.blob();
  }
  try {
    const r = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const b = await r.blob();
      if (b.size && /^image\//.test(b.type || 'image/')) return b;
    }
  } catch { /* blocked by CORS or offline: use the Pi */ }
  const res = await api('GET', '/api/fetch?url=' + encodeURIComponent(url), undefined, { raw: true, timeout: 15000 });
  return res.blob();
}

async function decode(blob) {
  // Bitmaps decode fastest with createImageBitmap; SVG favicons need an <img>.
  if (!/svg/i.test(blob.type) && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch { /* try an <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('not an image');
  }
}

function canvasBlob(c, type, quality) {
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality));
}

// makeThumb makes the same 640x360 JPEG the Crumbs web app makes.
//   'auto': crop wide images, letterbox square or tall ones (logos)
//   'top' : always fill, anchored to the top (screenshots)
export async function makeThumb(blob, mode = 'auto') {
  const im = await decode(blob);
  try {
    const w = im.w || 640, h = im.h || 360;
    if (mode === 'auto' && (w < 100 || h < 60)) throw new Error('too small');
    const W = 640, H = 360;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    const ratio = w / h;
    const cover = mode === 'top' || (ratio > 1.25 && ratio < 2.4);
    const scale = cover ? Math.max(W / w, H / h) : Math.min(W / w, H / h, 3);
    const dw = w * scale, dh = h * scale;
    const y = mode === 'top' ? 0 : (H - dh) / 2;
    ctx.drawImage(im.src, (W - dw) / 2, y, dw, dh);
    return await canvasBlob(c, 'image/jpeg', 0.85);
  } finally { im.done(); }
}

// makeIcon makes the same 64x64 PNG favicon the web app makes.
export async function makeIcon(blob) {
  const im = await decode(blob);
  try {
    const w = im.w || 64, h = im.h || 64;
    if (w < 8 || h < 8) throw new Error('too small');
    const N = 64;
    const c = document.createElement('canvas');
    c.width = N; c.height = N;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    const scale = Math.min(N / w, N / h);
    const dw = w * scale, dh = h * scale;
    ctx.drawImage(im.src, (N - dw) / 2, (N - dh) / 2, dw, dh);
    return await canvasBlob(c, 'image/png');
  } finally { im.done(); }
}

// ---------- avatars ----------

// fillAvatar shows a user's Crumbs profile picture in `el`, like the web app:
// an uploaded photo ("/avatar/..."), a built-in icon ("icon:name"), or the
// first letter of their name.
export async function fillAvatar(el, user, fallbackName = '') {
  const name = (user && (user.displayName || user.username)) || fallbackName || '?';
  const letter = () => el.replaceChildren(document.createTextNode([...name][0].toUpperCase()));
  const av = (user && user.avatar) || '';
  if (av.startsWith('icon:') && AVATAR_ICONS[av.slice(5)]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = AVATAR_ICONS[av.slice(5)];
    el.replaceChildren(svg);
    return;
  }
  if (av.startsWith('/')) {
    letter(); // until the photo arrives, or if it can't load
    try {
      const blob = await (await api('GET', av, undefined, { raw: true, timeout: 8000 })).blob();
      const img = new Image();
      img.alt = '';
      img.src = URL.createObjectURL(blob);
      await img.decode();
      el.replaceChildren(img);
    } catch { /* keep the letter */ }
    return;
  }
  letter();
}

// Chrome's own cached favicon for a page (needs the "favicon" permission).
export function chromeFavicon(pageUrl, size = 64) {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`);
}
