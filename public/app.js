'use strict';
const $ = id => document.getElementById(id);
const views = ['login', 'main', 'confirm', 'count', 'done'];
let csrf = '', chosen = '', endsAt = 0, current = 'login', busy = false, reachable = false;
const preference = matchMedia('(prefers-color-scheme: dark)');
let savedTheme = null;
try { savedTheme = localStorage.getItem('remotepower-theme'); } catch {}
if (!['dark', 'light'].includes(savedTheme)) savedTheme = null;
function setTheme(value) {
  const dark = value === 'dark';
  document.documentElement.dataset.theme = value;
  $('theme').setAttribute('aria-pressed', String(dark));
  $('themeLabel').textContent = dark ? 'Light' : 'Dark';
  $('themeIcon').textContent = dark ? '☼' : '☾';
}
setTheme(savedTheme || (preference.matches ? 'dark' : 'light'));
$('theme').addEventListener('click', () => {
  savedTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(savedTheme);
  try { localStorage.setItem('remotepower-theme', savedTheme); } catch {}
});
preference.addEventListener('change', () => { if (!savedTheme) setTheme(preference.matches ? 'dark' : 'light'); });
function show(view) { current = view; views.forEach(name => { $('v-' + name).hidden = name !== view; }); }
function msg(text) { $('msg').textContent = text || ''; }
function pill(state, text) {
  $('dot').className = 'dot ' + state; $('pillText').textContent = text;
  reachable = state !== 'offline';
  ['btnSleep', 'btnShutdown', 'slider'].forEach(id => { $(id).disabled = !reachable || busy; });
}
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method, headers, credentials: 'same-origin', signal: controller.signal, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
    let data = {}; try { data = await response.json(); } catch {}
    return { status: response.status, data };
  } catch { return { status: 0, data: {} }; }
  finally { clearTimeout(timeout); }
}
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const { status, data } = await api('GET', '/api/status');
    if (status !== 200 || typeof data.authed !== 'boolean') { pill('offline', status === 0 ? 'Disconnected' : 'Server unavailable'); return; }
    if (!data.authed) { csrf = ''; pill('online', 'Connected'); if (current !== 'login') show('login'); return; }
    csrf = data.csrf;
    if (data.pending) {
      endsAt = Date.now() + data.pending.remaining * 1000;
      $('countNum').textContent = Math.max(0, data.pending.remaining);
      $('countText').textContent = data.pending.action === 'sleep' ? 'Sleep pending' : 'Shutdown pending';
      pill('pending', $('countText').textContent); show('count'); return;
    }
    pill('online', 'Connected');
    $('lastAction').textContent = data.last && data.last.at ? `Last request: ${data.last.text} · ${new Date(data.last.at).toLocaleTimeString()}` : 'No requests since server start.';
    if (current === 'count') { $('doneText').textContent = 'Countdown ended. Check the PC state.'; show('done'); }
    else if (current === 'login') show('main');
  } finally { refreshing = false; }
}
setInterval(() => { if (current === 'count') $('countNum').textContent = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)); }, 250);
setInterval(() => { if (!document.hidden) refresh(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; busy = true; msg('');
  const button = event.currentTarget.querySelector('button'); button.disabled = true;
  const result = await api('POST', '/api/login', { password: $('pw').value });
  $('pw').value = ''; busy = false; button.disabled = false;
  if (result.status === 200) { csrf = result.data.csrf; await refresh(); }
  else msg(result.status === 429 ? 'Too many attempts. Wait and try again.' : result.status === 0 ? 'Cannot reach the server.' : 'Login failed.');
});
function choose(action) {
  if (!reachable || busy) return; chosen = action; msg('');
  $('confirmTitle').textContent = action === 'sleep' ? 'Put PC to sleep?' : 'Shut down PC?';
  $('slider').value = 0; show('confirm');
}
$('btnShutdown').addEventListener('click', () => choose('shutdown'));
$('btnSleep').addEventListener('click', () => choose('sleep'));
$('btnBack').addEventListener('click', () => { $('slider').value = 0; show('main'); });
$('slider').addEventListener('change', async () => {
  const slider = $('slider');
  if (+slider.value < 100 || busy || !reachable) { slider.value = 0; return; }
  busy = true; slider.disabled = true;
  const result = await api('POST', '/api/action', { action: chosen });
  busy = false; slider.value = 0; slider.disabled = !reachable;
  if (result.status === 200) { msg(''); await refresh(); }
  else { msg(result.status === 401 ? 'Session expired.' : result.status === 0 ? 'No response. Check status before retrying; the request may have reached the PC.' : 'Could not start the action.'); await refresh(); }
});
async function cancel() {
  if (busy) return; busy = true;
  $('btnCancelBig').disabled = true; $('btnCancelSched').disabled = true;
  const result = await api('POST', '/api/cancel');
  busy = false; $('btnCancelBig').disabled = false; $('btnCancelSched').disabled = false;
  if (result.status === 200) { msg(''); $('doneText').textContent = 'Cancellation request accepted.'; show('done'); }
  else msg('Cancellation was not confirmed. Check the PC.');
  await refresh();
}
$('btnCancelBig').addEventListener('click', cancel);
$('btnCancelSched').addEventListener('click', cancel);
$('btnDone').addEventListener('click', () => { msg(''); show('main'); refresh(); });
$('btnLogout').addEventListener('click', async () => {
  if (busy) return; busy = true; const result = await api('POST', '/api/logout'); busy = false;
  if (result.status === 200 || result.status === 401) { csrf = ''; msg(''); show('login'); }
  else msg('Could not confirm logout. Try again.');
});
show('login'); pill('offline', 'Connecting…'); refresh();
