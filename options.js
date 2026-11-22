import {
  getSettings, setSettings, normalizeServer, originPattern, hasServerPermission,
  request, api, probe, signIn, publicUser, ApiError, hostOf, fillAvatar,
} from './lib.js';

const $ = (id) => document.getElementById(id);
const TOGGLES = ['autoDescription', 'autoThumbnail', 'rememberFolder', 'closeAfterSave'];

let s = null;
let pendingServer = ''; // server being connected, before it is saved

init();

async function init() {
  s = await getSettings();
  for (const key of TOGGLES) {
    const box = $(key);
    box.checked = !!s[key];
    box.onchange = async () => {
      await setSettings({ [key]: box.checked });
      flash('Saved.');
    };
  }
  $('server-form').onsubmit = connect;
  $('login-form').onsubmit = login;
  $('login-cancel').onclick = () => { clearMsg(); render(); };
  $('choice-other').onclick = () => showLogin(pendingServer);
  $('switch').onclick = () => { pendingServer = s.server; showLogin(s.server); };
  $('disconnect').onclick = disconnect;
  $('refresh').onclick = async () => {
    const btn = $('refresh');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('spinning');
    clearMsg();
    pill('Checking…');
    try { await checkConnection(); } finally {
      btn.disabled = false;
      btn.classList.remove('spinning');
    }
  };
  $('open').onclick = () => chrome.tabs.create({ url: s.server + '/' });
  $('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  render();
  if (s.server) checkConnection();
}

// ---------- views ----------

function only(id) {
  for (const v of ['connected', 'server-form', 'login-form', 'choice']) $(v).hidden = v !== id;
}

function render() {
  if (!s.server) {
    only('server-form');
    $('server').value = pendingServer || '';
    return;
  }
  only('connected');
  const u = s.user || {};
  const name = s.auth === 'guest' ? 'Guest (login is off)' : (u.displayName || u.username || 'Signed in');
  $('acct-name').textContent = name;
  const how = { token: 'its own sign-in', cookie: 'your Crumbs sign-in in Chrome', guest: 'no sign-in' }[s.auth] || '';
  $('acct-detail').textContent = s.server + (how ? ' · using ' + how : '');
  $('switch').textContent = s.auth === 'guest' ? 'Sign in' : 'Sign in as someone else';
  fillAvatar($('avatar'), s.auth === 'guest' ? null : s.user, name);
}

function pill(text, bad = false) {
  $('status-pill').textContent = text;
  $('status-pill').classList.toggle('bad', bad);
}

function showLogin(server, intro) {
  clearMsg();
  only('login-form');
  $('login-intro').innerHTML = intro || `Sign in with your Crumbs account on <b>${esc(hostOf(server))}</b>.`;
  $('password').value = '';
  $('username').focus();
}

// ---------- connecting ----------

async function connect(e) {
  e.preventDefault();
  clearMsg();
  let server;
  try { server = normalizeServer($('server').value); }
  catch (err) { return showError(err.message); }

  // Must come first: Chrome only shows the permission prompt during a click.
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: [originPattern(server)] }); }
  catch (err) { return showError('Chrome could not ask for permission: ' + err.message); }
  if (!granted) return showError('The extension needs your permission to talk to ' + hostOf(server) + '.');

  busy($('connect'), true, 'Connecting…');
  try {
    const state = await probe(server);
    if (!state || typeof state.setup !== 'boolean') throw new Error('That address answered, but it does not look like Crumbs.');
    if (state.setup) {
      throw new Error('This Crumbs has no accounts yet. Open it in a tab, create the first account, then connect again.');
    }
    pendingServer = server;
    if (state.user && state.guest) {
      showChoice('Login is turned off on this Crumbs, so the extension can save to the owner\'s bookmarks without signing in.',
        'Use without signing in', () => finish(server, { auth: 'guest', token: '', user: null }));
    } else if (state.user) {
      const n = state.user.displayName || state.user.username;
      showChoice(`You're already signed in to Crumbs in Chrome as <b>${esc(n)}</b>.`,
        'Use this account', () => finish(server, { auth: 'cookie', token: '', user: state.user }));
    } else {
      showLogin(server);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    busy($('connect'), false);
  }
}

function showChoice(html, useLabel, onUse) {
  only('choice');
  $('choice-msg').innerHTML = html;
  $('choice-use').textContent = useLabel;
  $('choice-use').onclick = onUse;
}

async function login(e) {
  e.preventDefault();
  clearMsg();
  const server = pendingServer || s.server;
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) return;
  busy($('login'), true, 'Signing in…');
  try {
    const out = await signIn(server, username, password);
    $('password').value = '';
    await finish(server, out);
  } catch (err) {
    showError(err.message);
  } finally {
    busy($('login'), false);
  }
}

async function finish(server, { auth, token, user }) {
  // Signing in as someone else: retire the old token first.
  if (s.server && s.auth === 'token' && s.token && s.token !== token) {
    request(s.server, { method: 'POST', path: '/api/logout', token: s.token }).catch(() => {});
  }
  await setSettings({ server, auth, token: token || '', user: publicUser(user), lastFolder: server === s.server ? s.lastFolder : null });
  s = await getSettings();
  pendingServer = '';
  render();
  pill('Connected');
  flash('Connected. Click the Crumbs button in the toolbar on any page to save it.');
}

async function checkConnection() {
  if (!(await hasServerPermission(s.server))) {
    pill('No permission', true);
    return showError('Chrome no longer lets the extension talk to ' + hostOf(s.server) + '. Disconnect and connect again.');
  }
  try {
    const state = await api('GET', '/api/state', undefined, { timeout: 8000 });
    if (!state.user) {
      pill('Signed out', true);
      pendingServer = s.server;
      return showLogin(s.server, 'Your sign-in has expired. Sign in again to keep saving crumbs.');
    }
    if (s.auth !== 'guest') {
      await setSettings({ user: publicUser(state.user) });
      s = await getSettings();
      render();
    }
    pill('Connected');
  } catch (err) {
    pill(err instanceof ApiError && err.status === 0 ? 'Offline' : 'Problem', true);
    showError(err.message);
  }
}

async function disconnect() {
  clearMsg();
  if (s.auth === 'token' && s.token) {
    await request(s.server, { method: 'POST', path: '/api/logout', token: s.token, timeout: 5000 }).catch(() => {});
  }
  // A cookie sign-in is shared with the Crumbs tab, so it is left alone.
  const old = s.server;
  await setSettings({ server: '', auth: '', token: '', user: null, lastFolder: null });
  try { await chrome.permissions.remove({ origins: [originPattern(old)] }); } catch { /* fine */ }
  s = await getSettings();
  pendingServer = old;
  render();
  flash('Disconnected.');
}

// ---------- messages ----------

function showError(msg) {
  $('ok').hidden = true;
  $('error').textContent = msg;
  $('error').hidden = false;
}

let flashTimer = 0;
function flash(msg) {
  $('error').hidden = true;
  $('ok').textContent = msg;
  $('ok').hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $('ok').hidden = true; }, 4000);
}

function clearMsg() {
  $('error').hidden = true;
  $('ok').hidden = true;
}

function busy(btn, on, label) {
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label; }
  else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = on;
}

function esc(x) {
  return String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
