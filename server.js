'use strict';
// 88ACADEMY - FPV NEXUS flight simulator server.
// One small Node file, no dependencies. It serves the game from ./public and keeps the shared data
// (groups, accounts, tracks, progress, live flights) in one JSON file on the Render Disk (DATA_DIR).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'nexus.json');
const PUBLIC = path.join(__dirname, 'public');
const ADMIN_USER = (process.env.ADMIN_USERNAME || (PROD ? '' : 'admin')).trim();
const ADMIN_PASS = process.env.ADMIN_PASSWORD || (PROD ? '' : 'admin1234');
if (!ADMIN_USER || !ADMIN_PASS) { console.error('ADMIN_USERNAME and ADMIN_PASSWORD must be set.'); process.exit(1); }
const TOKEN_DAYS = 30;
const MAX_BODY = 6 * 1024 * 1024;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,80}$/;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const docs = new Map();                       // 'collection/id' -> object
let secret = null;
try {
  const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  Object.keys(d.docs || {}).forEach((p) => docs.set(p, d.docs[p]));
  secret = d.secret || null;
} catch (e) { /* first run */ }
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); }
let dirty = true, saveTimer = null;
function flush() {
  if (!dirty) return;
  dirty = false;
  const o = { secret, docs: {} };
  docs.forEach((v, p) => { if (!p.startsWith('live/')) o.docs[p] = v; });       // live positions are not worth keeping
  const tmp = DATA_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(o)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('save failed', e.message); dirty = true; }
}
function touch() { dirty = true; if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 1500); }
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });
setInterval(flush, 30000).unref();

// ---------- automatic backups (every change of people or groups can be undone) ----------
const BK_DIR = path.join(DATA_DIR, 'backups');
const BK_KEEP = { auto: 40, start: 10, del: 80, import: 20, restore: 20 };
let lastBk = 0, lastDel = 0;
function snapshot(reason) {
  try {
    fs.mkdirSync(BK_DIR, { recursive: true });
    const o = { at: Date.now(), reason, docs: {} };
    docs.forEach((v, p) => { if (!p.startsWith('live/')) o.docs[p] = v; });
    if (!Object.keys(o.docs).length) return;                           // never keep an empty snapshot
    const name = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '') + '-' + reason + '.json';
    fs.writeFileSync(path.join(BK_DIR, name), JSON.stringify(o));
    const all = fs.readdirSync(BK_DIR).filter((n) => n.endsWith('-' + reason + '.json')).sort();
    all.slice(0, Math.max(0, all.length - (BK_KEEP[reason] || 20))).forEach((n) => { try { fs.unlinkSync(path.join(BK_DIR, n)); } catch (e) { /* ignore */ } });
    lastBk = Date.now();
  } catch (e) { console.error('backup failed', e.message); }
}
function bkList() {
  try { return fs.readdirSync(BK_DIR).filter((n) => /^[0-9T\-]+-[a-z]+\.json$/.test(n)).sort().reverse(); } catch (e) { return []; }
}
function bkInfo(name) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(BK_DIR, name), 'utf8')), ks = Object.keys(d.docs || {});
    return { name, at: d.at || 0, reason: d.reason || '', accounts: ks.filter((k) => k.startsWith('accounts/')).length, groups: ks.filter((k) => k.startsWith('groups/')).length };
  } catch (e) { return null; }
}
setTimeout(() => snapshot('start'), 5000).unref();
let bkSeen = '';
setInterval(() => { const sig = String(docs.size) + ':' + JSON.stringify(Array.from(docs.keys()).filter((k) => /^(accounts|groups)\//.test(k)).sort()); if (sig !== bkSeen && Date.now() - lastBk > 20 * 60000) { bkSeen = sig; snapshot('auto'); } }, 10 * 60000).unref();

// ---------- sign-in ----------
const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', secret).update(s).digest('base64url');
function makeToken() { const body = b64(JSON.stringify({ r: 'admin', exp: Date.now() + TOKEN_DAYS * 864e5 })); return body + '.' + sign(body); }
function isAdmin(req, qtok) {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || '')); const t = m ? m[1] : (qtok || ''); if (!t) return false;   // an EventSource cannot send headers, so the stream takes the token in the query
  const [body, sig] = t.split('.'); if (!body || !sig) return false;
  const want = sign(body), a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); } catch (e) { return false; }
}
function eq(a, b) { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); }
const fails = new Map();                      // ip -> [timestamps] of failed sign-ins
function limited(ip, max) { const now = Date.now(), l = (fails.get(ip) || []).filter((t) => now - t < 15 * 60000); fails.set(ip, l); return l.length >= max; }
function failed(ip) { const l = fails.get(ip) || []; l.push(Date.now()); fails.set(ip, l); }
setInterval(() => { const now = Date.now(); fails.forEach((l, ip) => { if (!l.some((t) => now - t < 15 * 60000)) fails.delete(ip); }); }, 600000).unref();

// ---------- rules ----------
// Everyone may read, except: creds (only a salt is shown, never the hash) and live (admin only).
// Only the admin writes, except a player's own players/<uid>, hist/<uid> and live/<uid>.
const SELF = new Set(['players', 'hist', 'live']);
const segs = (p) => String(p || '').split('/');
function validPath(p, wantDoc) { const s = segs(p); return s.length === (wantDoc ? 2 : 1) && s.every((x) => SEG.test(x) && !/^\.+$/.test(x)); }
function canRead(col, admin) { return admin || col !== 'live'; }
function canWrite(col, id, admin, uid) { return admin || (SELF.has(col) && uid && id === uid); }
function view(col, data, admin) {
  if (data == null) return null;
  if (col === 'creds' && !admin) return { salt: data.salt };
  return data;
}

// ---------- live updates (server-sent events) ----------
const clients = new Map();                    // sid -> { res, admin, subs:Set }
function broadcast(p, data) {
  const col = segs(p)[0];
  clients.forEach((c) => {
    if (!canRead(col, c.admin) || !(c.subs.has(p) || c.subs.has(col))) return;
    c.res.write('data: ' + JSON.stringify({ p, d: view(col, data, c.admin) }) + '\n\n');
  });
}
setInterval(() => clients.forEach((c) => c.res.write(': ping\n\n')), 25000).unref();

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };
const AUDIO = new Set(['.mp3', '.ogg', '.m4a', '.wav']);
const HEAD = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' };
function json(res, code, o) { const b = JSON.stringify(o); res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, HEAD)); res.end(b); }
function body(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const cache = new Map();                      // file -> { mtime, raw, gz }
function sendFile(req, res, file) {
  let st; try { st = fs.statSync(file); if (!st.isFile()) throw new Error('x'); } catch (e) { res.writeHead(404, HEAD); return res.end('Not found'); }
  if (AUDIO.has(path.extname(file))) {                                 // music: not compressed, with byte ranges so browsers can start playing and seek
    const size = st.size, type = TYPES[path.extname(file)], m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    const h = Object.assign({ 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' }, HEAD);
    let a = 0, b = size - 1, code = 200;
    if (m && (m[1] || m[2])) { if (m[1]) { a = Number(m[1]); if (m[2]) b = Math.min(Number(m[2]), size - 1); } else { a = Math.max(0, size - Number(m[2])); } if (a > b || a >= size) { res.writeHead(416, Object.assign({ 'Content-Range': 'bytes */' + size }, HEAD)); return res.end(); } code = 206; h['Content-Range'] = 'bytes ' + a + '-' + b + '/' + size; }
    h['Content-Length'] = b - a + 1; res.writeHead(code, h);
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start: a, end: b }).on('error', () => res.destroy()).pipe(res);
  }
  let c = cache.get(file);
  if (!c || c.mtime !== st.mtimeMs) { const raw = fs.readFileSync(file); c = { mtime: st.mtimeMs, raw, gz: zlib.gzipSync(raw, { level: 6 }) }; cache.set(file, c); }
  const gz = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const h = Object.assign({ 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' }, HEAD);
  if (gz) h['Content-Encoding'] = 'gzip';
  res.writeHead(200, h); res.end(gz ? c.gz : c.raw);
}
const ipOf = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const uidOf = (req) => { const u = String(req.headers['x-uid'] || ''); return SEG.test(u) ? u : ''; };

async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams, admin = isAdmin(req, p === '/api/stream' ? q.get('t') : ''), uid = uidOf(req);
  if (p === '/api/health') return json(res, 200, { ok: true, docs: docs.size });
  if (p === '/api/admin/login' && req.method === 'POST') {
    const ip = ipOf(req); if (limited('a:' + ip, 8)) return json(res, 429, { error: 'נסיונות רבים מדי. נסה שוב בעוד כמה דקות' });      // the manager's counter is separate: students typing wrong passwords on the same network never lock the manager out
    const b = await body(req);
    if (eq(b.u || '', ADMIN_USER) && eq(b.p || '', ADMIN_PASS)) return json(res, 200, { token: makeToken() });
    failed('a:' + ip); return json(res, 401, { error: 'שם משתמש או סיסמה שגויים' });
  }
  if (p === '/api/admin/me') return json(res, 200, { admin });
  if (p === '/api/admin/backups' && req.method === 'GET') {          // list of the server's automatic backups (admin only)
    if (!admin) return json(res, 403, { error: 'forbidden' });
    return json(res, 200, { list: bkList().slice(0, 60).map(bkInfo).filter(Boolean) });
  }
  if (p === '/api/admin/restore' && req.method === 'POST') {         // bring back what is missing now (accounts, groups...) from a backup; nothing existing is overwritten
    if (!admin) return json(res, 403, { error: 'forbidden' });
    const b = await body(req), name = String(b.name || '');
    if (!/^[0-9T\-]+-[a-z]+\.json$/.test(name) || !bkList().includes(name)) return json(res, 404, { error: 'not found' });
    let d; try { d = JSON.parse(fs.readFileSync(path.join(BK_DIR, name), 'utf8')); } catch (e) { return json(res, 500, { error: 'unreadable' }); }
    snapshot('restore');
    const back = []; Object.keys(d.docs || {}).forEach((k) => { if (validPath(k, true) && !k.startsWith('live/') && !k.startsWith('_') && !docs.has(k) && k !== 'tracks/main' && d.docs[k] && typeof d.docs[k] === 'object') { docs.set(k, d.docs[k]); broadcast(k, d.docs[k]); back.push(k); } });
    touch(); flush(); return json(res, 200, { restored: back.length, accounts: back.filter((k) => k.startsWith('accounts/')).length, groups: back.filter((k) => k.startsWith('groups/')).length });
  }
  if (p === '/api/admin/import' && req.method === 'POST') {            // load an export of the old data (admin only)
    if (!admin) return json(res, 403, { error: 'forbidden' });
    snapshot('import');
    const b = await body(req); const list = Array.isArray(b.docs) ? b.docs : [];
    let n = 0;
    const onlyMissing = q.get('mode') === 'missing';                  // keep what already exists (tracks count as missing when their list is empty)
    list.forEach((d) => {
      if (d && typeof d.path === 'string' && validPath(d.path, true) && d.data && typeof d.data === 'object' && !segs(d.path)[0].startsWith('_')) {
        const cur = docs.get(d.path);
        if (onlyMissing && cur && !(d.path === 'tracks/main' && !(Array.isArray(cur.list) && cur.list.length))) return;
        docs.set(d.path, d.data); n++;
      }
    });
    touch(); flush(); return json(res, 200, { imported: n });
  }
  if (p === '/api/db/check' && req.method === 'POST') {              // password check: the hash never leaves the server
    const ip = ipOf(req), b = await body(req), ku = 's:' + ip + ':' + String(b.un || '').slice(0, 40);
    if (limited(ku, 10) || limited('s:' + ip, 80)) return json(res, 429, { ok: false });          // per student name and address (10), and a wide limit for a whole school network (80)
    const c = docs.get('creds/' + String(b.un || ''));
    const ok = !!(c && typeof b.h === 'string' && eq(c.h, b.h));
    if (!ok) { failed(ku); failed('s:' + ip); }
    return json(res, 200, { ok });
  }
  if (p === '/api/db/changepw' && req.method === 'POST') {           // a student replaces the temporary password: proves the old one, sets the new one and clears the "must change" flag
    const ip = ipOf(req), b = await body(req), un = String(b.un || ''), ku = 's:' + ip + ':' + un.slice(0, 40);
    if (limited(ku, 10) || limited('s:' + ip, 80)) return json(res, 429, { ok: false });
    const c = SEG.test(un) ? docs.get('creds/' + un) : null;
    const good = !!(c && typeof b.h === 'string' && eq(c.h, b.h));
    if (!good) { failed(ku); failed('s:' + ip); return json(res, 403, { ok: false }); }
    if (typeof b.salt !== 'string' || typeof b.nh !== 'string' || b.salt.length < 6 || b.salt.length > 60 || b.nh.length < 20 || b.nh.length > 200 || b.nh === c.h) return json(res, 400, { ok: false });
    const next = { salt: b.salt, h: b.nh }; docs.set('creds/' + un, next); broadcast('creds/' + un, next);
    const ac = docs.get('accounts/' + un); if (ac && ac.mustPw) { const na = Object.assign({}, ac); delete na.mustPw; docs.set('accounts/' + un, na); broadcast('accounts/' + un, na); }
    touch(); return json(res, 200, { ok: true });
  }
  if (p === '/api/db/doc') {
    if (!validPath(q.get('p'), true)) return json(res, 400, { error: 'bad path' });
    const [col, id] = segs(q.get('p'));
    if (req.method === 'GET') { if (!canRead(col, admin)) return json(res, 403, { error: 'forbidden' }); const d = docs.get(q.get('p')); return json(res, 200, { exists: d !== undefined, data: view(col, d, admin) }); }
    if (!canWrite(col, id, admin, uid)) return json(res, 403, { error: 'forbidden' });
    if (req.method === 'PUT') {
      const b = await body(req); if (!b.data || typeof b.data !== 'object' || Array.isArray(b.data)) return json(res, 400, { error: 'bad data' });
      if (q.get('p') === 'tracks/main') {                              // never replace published tracks with an empty list by mistake
        const cur = docs.get('tracks/main'), nl = Array.isArray(b.data.list) ? b.data.list.length : 0;
        if (cur && Array.isArray(cur.list) && cur.list.length && !nl && !b.force) return json(res, 409, { error: 'empty-tracks' });
      }
      const next = b.merge ? Object.assign({}, docs.get(q.get('p')) || {}, b.data) : b.data;
      docs.set(q.get('p'), next); touch(); broadcast(q.get('p'), next); return json(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') { if (/^(accounts|groups|creds|themes)$/.test(col) && Date.now() - lastDel > 20000) { lastDel = Date.now(); snapshot('del'); } docs.delete(q.get('p')); touch(); broadcast(q.get('p'), null); return json(res, 200, { ok: true }); }
  }
  if (p === '/api/db/col' && req.method === 'GET') {
    const col = q.get('p'); if (!validPath(col, false)) return json(res, 400, { error: 'bad path' });
    if (!canRead(col, admin)) return json(res, 403, { error: 'forbidden' });
    if (col === 'creds' && !admin) return json(res, 403, { error: 'forbidden' });
    const out = []; docs.forEach((v, k) => { if (k.startsWith(col + '/')) out.push({ id: k.slice(col.length + 1), data: v }); });
    out.sort((a, b) => (a.id < b.id ? -1 : 1)); return json(res, 200, { docs: out });
  }
  if (p === '/api/stream' && req.method === 'GET') {
    const sid = String(q.get('sid') || ''); if (!SEG.test(sid)) return json(res, 400, { error: 'bad sid' });
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }, HEAD));
    res.write('retry: 2000\n\n');
    const old = clients.get(sid); const subs = old ? old.subs : new Set();
    clients.set(sid, { res, admin, subs });
    req.on('close', () => { const c = clients.get(sid); if (c && c.res === res) clients.delete(sid); });
    return;
  }
  if (p === '/api/stream/sub' && req.method === 'POST') {
    const b = await body(req), c = clients.get(String(b.sid || ''));
    if (!c) return json(res, 410, { error: 'no stream' });
    c.subs.clear(); (Array.isArray(b.paths) ? b.paths : []).slice(0, 200).forEach((x) => { if (typeof x === 'string' && (validPath(x, true) || validPath(x, false))) c.subs.add(x); });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    api(req, res, url).catch((e) => { if (!res.headersSent) json(res, e && e.message === 'too large' ? 413 : 400, { error: String(e && e.message || 'error') }); });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, HEAD); return res.end(); }
  const map = { '/': 'index.html', '/index.html': 'index.html', '/admin': 'index.html', '/admin/': 'index.html', '/import': 'import.html' };   // /admin is the same page: the game shows the manager sign-in there
  const mm = /^\/music\/([A-Za-z0-9_\-.]{1,80})$/.exec(url.pathname);            // the music files (public/music), nothing else is served from disk
  if (mm && !/^\.+$/.test(mm[1]) && AUDIO.has(path.extname(mm[1]))) return sendFile(req, res, path.join(PUBLIC, 'music', mm[1]));
  const f = map[url.pathname];
  if (!f) { res.writeHead(404, HEAD); return res.end('Not found'); }
  sendFile(req, res, path.join(PUBLIC, f));
});
server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log('FPV NEXUS on port ' + PORT + (PROD ? '' : ' (dev: ' + ADMIN_USER + ' / ' + ADMIN_PASS + ')')));
