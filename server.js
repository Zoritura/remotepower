'use strict';
// Remote shutdown server - zero dependencies, Windows 11.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { startMdns } = require('./mdns');

const ROOT = __dirname;

/* ---------- Config (file + optional env overrides, no secrets in code) ---------- */
function loadConfig() {
  const file = process.env.RS_CONFIG || path.join(ROOT, 'config.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.error('Cannot read config.json. Run: node setup-password.js'); process.exit(1); }
  const c = {
    host: '0.0.0.0', port: 3000, allowedHosts: [],
    https: { enabled: false, keyFile: 'certs/key.pem', certFile: 'certs/cert.pem' },
    logFile: 'logs/audit.log', sessionIdleMinutes: 10, maxFailures: 5, lockoutMinutes: 15,
    ...raw,
  };
  if (process.env.RS_PORT) c.port = parseInt(process.env.RS_PORT, 10);
  if (process.env.RS_HOST) c.host = process.env.RS_HOST;
  if (typeof c.passwordHash !== 'string' || !c.passwordHash.startsWith('scrypt$')) {
    console.error('No password hash configured. Run: node setup-password.js'); process.exit(1);
  }
  c.allowedHosts = (c.allowedHosts || []).map((h) => String(h).toLowerCase());
  return c;
}
const cfg = loadConfig();

/* ---------- Hardcoded commands: no user input ever reaches these ---------- */
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const COUNTDOWN = 30; // seconds
const COMMANDS = Object.freeze({
  shutdown: Object.freeze({ file: path.join(SYS32, 'shutdown.exe'),
    args: Object.freeze(['/s', '/t', String(COUNTDOWN), '/c', 'Remote shutdown requested']) }),
  abort: Object.freeze({ file: path.join(SYS32, 'shutdown.exe'), args: Object.freeze(['/a']) }),
  sleep: Object.freeze({ file: path.join(SYS32, 'rundll32.exe'),
    args: Object.freeze(['powrprof.dll,SetSuspendState', '0,1,0']) }),
});
function run(cmd) { // execFile = no shell, no string concatenation
  return new Promise((resolve, reject) =>
    execFile(cmd.file, [...cmd.args], { windowsHide: true, timeout: 15000 },
      (err) => (err ? reject(err) : resolve())));
}

/* ---------- Audit log (append-only stream, never logs secrets) ---------- */
const logPath = path.resolve(ROOT, cfg.logFile);
fs.mkdirSync(path.dirname(logPath), { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
function audit(event, ip, extra) {
  logStream.write(JSON.stringify({ ts: new Date().toISOString(), event, ip, ...extra }) + '\n');
}
const auditSeen = new Map();
function auditThrottled(event, ip) { // avoid log flooding from blocked sources
  const k = event + ip, now = Date.now();
  if (now - (auditSeen.get(k) || 0) > 60000) { auditSeen.set(k, now); audit(event, ip); }
}

/* ---------- Network helpers ---------- */
function normIp(a) {
  if (!a) return '';
  a = a.toLowerCase().replace(/^::ffff:/, '');
  const z = a.indexOf('%'); return z > -1 ? a.slice(0, z) : a;
}
// loopback + 10/8, 172.16/12, 192.168/16, fe80::/10, fc00::/7. X-Forwarded-For is never read.
function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(ip)) {
    if (ip === '::1') return true;
    const first = parseInt(ip.split(':')[0] || '0', 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
  }
  return false;
}
// DNS-rebinding defence: Host must be a private IP literal, localhost, or a name you whitelisted.
function hostOk(h) {
  if (!h || h.length > 255) return false;
  const host = (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.split(':')[0]).toLowerCase();
  if (net.isIP(host)) return isPrivate(host);
  return host === 'localhost' || cfg.allowedHosts.includes(host);
}
function originOk(req) { // required on every POST
  const o = req.headers.origin;
  if (!o) return false;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

/* ---------- Password verification (scrypt, constant-time compare) ---------- */
function verifyPassword(pw) {
  return new Promise((resolve) => {
    const [, N, r, p, saltB, hashB] = cfg.passwordHash.split('$');
    const salt = Buffer.from(saltB, 'base64'), expected = Buffer.from(hashB, 'base64');
    crypto.scrypt(pw, salt, expected.length,
      { N: +N, r: +r, p: +p, maxmem: 128 * 1024 * 1024 }, (err, dk) =>
        resolve(!err && dk.length === expected.length && crypto.timingSafeEqual(dk, expected)));
  });
}

/* ---------- Rate limiting / backoff / lockout (per IP) ---------- */
const attempts = new Map(); // ip -> {fails, nextOk, lockUntil}
const reqCount = new Map(); // ip -> {n, reset}
function attempt(ip) {
  if (!attempts.has(ip)) attempts.set(ip, { fails: 0, nextOk: 0, lockUntil: 0 });
  return attempts.get(ip);
}
function rateLimited(ip) { // general flood limit: 120 req/min/IP
  const now = Date.now(); let e = reqCount.get(ip);
  if (!e || now > e.reset) { e = { n: 0, reset: now + 60000 }; reqCount.set(ip, e); }
  return ++e.n > 120;
}
setInterval(() => { // memory hygiene
  const now = Date.now();
  for (const [k, v] of attempts) if (now > v.lockUntil && now > v.nextOk + 600000) attempts.delete(k);
  for (const [k, v] of reqCount) if (now > v.reset) reqCount.delete(k);
  for (const [k, v] of sessions) if (expired(v)) sessions.delete(k);
}, 60000).unref();

/* ---------- Sessions ---------- */
const IDLE_MS = cfg.sessionIdleMinutes * 60000, ABS_MS = 60 * 60000;
const sessions = new Map(); // id -> {csrf, last, created}
const COOKIE = 'sid';
const expired = (s) => Date.now() - s.last > IDLE_MS || Date.now() - s.created > ABS_MS;
function parseCookies(h) {
  const out = {};
  for (const part of (h || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function getSession(req, touch) {
  const id = parseCookies(req.headers.cookie)[COOKIE];
  const s = id && sessions.get(id);
  if (!s) return null;
  if (expired(s)) { sessions.delete(id); return null; }
  if (touch) s.last = Date.now();
  return { id, ...s, ref: s };
}
function cookieHeader(id, maxAge) {
  return `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}` +
    (cfg.https.enabled ? '; Secure' : '');
}
function newSession() {
  if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { csrf: crypto.randomBytes(32).toString('hex'), last: Date.now(), created: Date.now() });
  return { id, s: sessions.get(id) };
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- Power action state ---------- */
let pending = null; // {action, endsAt, timer}
let lastAction = { text: 'None since service start', at: null };
const setLast = (text) => { lastAction = { text, at: new Date().toISOString() }; };

async function startAction(action, ip) {
  if (pending) return 'busy';
  pending = { action, endsAt: Date.now() + COUNTDOWN * 1000, timer: null };
  const mine = pending;
  if (action === 'shutdown') { // native delayed shutdown: survives even if this server dies
    try { await run(COMMANDS.shutdown); }
    catch { pending = null; audit('shutdown_failed', ip); return 'error'; }
  }
  mine.timer = setTimeout(async () => {
    if (pending !== mine) return;
    if (action === 'sleep') {
      audit('sleep_executing', ip);
      try { await run(COMMANDS.sleep); } catch { audit('sleep_failed', ip); }
    }
    pending = null;
  }, COUNTDOWN * 1000 + (action === 'shutdown' ? 3000 : 0));
  setLast(`${action} requested`);
  audit(`${action}_requested`, ip, { countdown: COUNTDOWN });
  return 'ok';
}
async function cancelAction(ip) {
  if (pending) clearTimeout(pending.timer);
  pending = null;
  try { await run(COMMANDS.abort); } catch { /* nothing scheduled: harmless */ }
  setLast('Cancelled'); audit('cancelled', ip);
}

/* ---------- HTTP plumbing ---------- */
const STATIC = {};
for (const [url, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
]) STATIC[url] = { body: fs.readFileSync(path.join(ROOT, 'public', file)), type };

function secHeaders(res) {
  res.setHeader('Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}
function json(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), ...headers });
  res.end(body);
}
const fail = (res, code) => json(res, code, { error: 'Request failed' }); // generic on purpose

function readBody(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] || '')) return reject(new Error('type'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('size')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      resolve(o && typeof o === 'object' && !Array.isArray(o) ? o : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  secHeaders(res);
  const ip = normIp(req.socket.remoteAddress);
  if (!isPrivate(ip)) { auditThrottled('blocked_ip', ip); return fail(res, 403); }
  if (!hostOk(req.headers.host)) { auditThrottled('blocked_host', ip); return fail(res, 400); }
  if (rateLimited(ip)) return fail(res, 429);

  const p = new URL(req.url, 'http://x').pathname;

  if (req.method === 'GET') {
    if (STATIC[p]) {
      res.writeHead(200, { 'Content-Type': STATIC[p].type, 'Content-Length': STATIC[p].body.length });
      return res.end(STATIC[p].body);
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (p === '/api/status') { // does NOT refresh idle timer, so polling can't keep a session alive
      const s = getSession(req, false);
      if (!s) return json(res, 200, { authed: false });
      return json(res, 200, { authed: true, csrf: s.csrf,
        pending: pending ? { action: pending.action,
          remaining: Math.max(0, Math.ceil((pending.endsAt - Date.now()) / 1000)) } : null,
        last: lastAction });
    }
    return fail(res, 404);
  }
  if (req.method !== 'POST') return fail(res, 405);

  // ---- all POSTs: Origin check + JSON body + size limit ----
  if (!originOk(req)) { audit('csrf_origin_rejected', ip); return fail(res, 403); }
  let body;
  try { body = await readBody(req); } catch { return fail(res, 400); }

  if (p === '/api/login') {
    const a = attempt(ip), now = Date.now();
    if (now < a.lockUntil) { audit('login_blocked_lockout', ip);
      return json(res, 429, { error: 'Too many attempts. Try later.' },
        { 'Retry-After': Math.ceil((a.lockUntil - now) / 1000) }); }
    if (now < a.nextOk) return json(res, 429, { error: 'Too many attempts. Try later.' },
      { 'Retry-After': Math.ceil((a.nextOk - now) / 1000) });
    a.nextOk = now + 500; // blocks parallel guessing while scrypt runs
    const ok = typeof body.password === 'string' && body.password.length > 0 &&
      body.password.length <= 256 && await verifyPassword(body.password);
    if (!ok) {
      a.fails++;
      a.nextOk = Date.now() + Math.min(500 * 2 ** (a.fails - 1), 30000); // exponential backoff
      audit('login_failed', ip, { fails: a.fails });
      if (a.fails >= cfg.maxFailures) {
        a.lockUntil = Date.now() + cfg.lockoutMinutes * 60000; a.fails = 0;
        audit('login_lockout', ip, { minutes: cfg.lockoutMinutes });
      }
      return json(res, 401, { error: 'Invalid credentials' });
    }
    attempts.delete(ip);
    const { id, s } = newSession();
    audit('login_success', ip);
    return json(res, 200, { csrf: s.csrf }, { 'Set-Cookie': cookieHeader(id, cfg.sessionIdleMinutes * 60) });
  }

  // ---- everything below needs session + CSRF token ----
  const s = getSession(req, true);
  if (!s) return fail(res, 401);
  if (!safeEq(req.headers['x-csrf-token'], s.csrf)) { audit('csrf_token_rejected', ip); return fail(res, 403); }
  const refresh = { 'Set-Cookie': cookieHeader(s.id, cfg.sessionIdleMinutes * 60) };

  if (p === '/api/logout') {
    sessions.delete(s.id); audit('logout', ip);
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
  }
  if (p === '/api/action') {
    if (body.action !== 'shutdown' && body.action !== 'sleep') return fail(res, 400); // strict whitelist
    const r = await startAction(body.action, ip);
    return r === 'ok' ? json(res, 200, { ok: true }, refresh) : fail(res, r === 'busy' ? 409 : 500);
  }
  if (p === '/api/cancel') { await cancelAction(ip); return json(res, 200, { ok: true }, refresh); }
  return fail(res, 404);
}

const wrapped = (req, res) => handle(req, res).catch(() => { try { fail(res, 500); } catch { /* */ } });
let server;
if (cfg.https.enabled) {
  server = https.createServer({
    key: fs.readFileSync(path.resolve(ROOT, cfg.https.keyFile)),
    cert: fs.readFileSync(path.resolve(ROOT, cfg.https.certFile)),
    minVersion: 'TLSv1.2',
  }, wrapped);
} else server = http.createServer(wrapped);

server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50; server.maxRequestsPerSocket = 200;
startMdns();
server.listen(cfg.port, cfg.host, () => {
  audit('service_started', 'local', { port: cfg.port, https: !!cfg.https.enabled });
});
// On any fatal error: log and exit non-zero so Task Scheduler restarts us.
process.on('uncaughtException', () => { audit('fatal_error', 'local'); setTimeout(() => process.exit(1), 200); });
