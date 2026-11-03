'use strict';
// 88ACADEMY student system: one small Node server with no dependencies.
// It serves the screens from ./public, keeps everything in one data file under DATA_DIR (a Render Disk),
// signs people in with their own username and password, and lets each role see only what it may.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./model');
const AI = require('./ai');

const PORT = Number(process.env.PORT) || 3000;
const PROD = process.env.NODE_ENV === 'production';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'academy.json');
const PUBLIC = path.join(__dirname, 'public');
// Videos the admin uploads live next to the data file, on the same disk.
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;
const MAX_FLIGHT = (Number(process.env.MAX_FLIGHT_MB) || 500) * 1024 * 1024;
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE = 10 * 1024 * 1024;
const COOKIE = 'aca_sid';
const SESSION_DAYS = 30;

// ---------- storage ----------
let db = null;
let saveTimer = null;

function seedUnits() {
  return [
    { id: 'a', name: "קבוצה א'", type: '', parent: '' },
    { id: 'b', name: "קבוצה ב'", type: '', parent: '' },
    { id: 'c', name: "קבוצה ג'", type: '', parent: '' },
    { id: 'd', name: "קבוצה ד'", type: '', parent: '' },
    { id: 'e', name: "קבוצה ה'", type: '', parent: '' },
    { id: 'prep', name: 'קורס הכנה לפני גיוס היברידי', type: '', parent: '' }
  ];
}
function seedRewards() {
  return [
    { id: 'r1', title: 'כרטיס זוגי לסרט - רב חן', desc: 'כרטיס זוגי לסרט בקולנוע רב חן.', cost: 250, stock: 10, icon: 'ticket', groups: 'all', active: true },
    { id: 'r2', title: 'שובר מסעדת שף - 150 ש״ח', desc: 'שובר לארוחה במסעדת שף בשווי 150 ש״ח.', cost: 400, stock: 8, icon: 'food', groups: ['a', 'b'], active: true }
  ];
}

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, pw) {
  if (!user || !user.passHash) return false;
  const h = crypto.scryptSync(String(pw), user.passSalt, 64);
  const want = Buffer.from(user.passHash, 'hex');
  return want.length === h.length && crypto.timingSafeEqual(want, h);
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    db = { v: 1, users: [], sessions: {}, units: seedUnits(), rewards: seedRewards(), scoring: M.scoringDefaults(), progress: {}, activity: [], created: M.stamp() };
  }
  db.sessions = db.sessions || {};
  db.activity = db.activity || [];
  db.uploads = db.uploads || {};
  db.settings = Object.assign({ videoDays: 14 }, db.settings || {});
  ensureLooks();
  db.settings.ai = Object.assign({ enabled: false, mode: 'suggest', threshold: 80, autoReject: true, extra: '', model: '', dailyLimit: 100 }, db.settings.ai || {});
  db.aiUsage = db.aiUsage || { day: '', count: 0 };
  db.progress = db.progress || {};
  const cur = M.cleanCurriculum(db.curriculum || M.curriculumDefaults());
  db.curriculum = typeof cur === 'string' ? M.curriculumDefaults() : cur;
  M.setCurriculum(db.curriculum);
  // The manager named in the settings always exists and always has the password from the settings.
  const au = (process.env.ADMIN_USERNAME || (PROD ? '' : 'admin')).trim();
  const ap = process.env.ADMIN_PASSWORD || (PROD ? '' : 'admin1234');
  if (!au || !ap) {
    console.error('ADMIN_USERNAME and ADMIN_PASSWORD must be set.');
    process.exit(1);
  }
  let admin = db.users.find((u) => u.username.toLowerCase() === au.toLowerCase());
  if (!admin) {
    admin = { id: M.newId('u'), username: au, name: 'מנהל', role: 'admin', unit: '', earns: false, created: M.stamp() };
    db.users.push(admin);
  }
  admin.role = 'admin';
  admin.disabled = false;
  admin.mustChange = false;
  admin.envAdmin = true;
  const hp = hashPassword(ap, admin.passSalt);
  if (hp.hash !== admin.passHash) {
    const fresh = hashPassword(ap);
    admin.passSalt = fresh.salt;
    admin.passHash = fresh.hash;
  }
  // drop expired sessions
  const now = Date.now();
  Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].exp < now) delete db.sessions[k]; });
  writeNow();
}

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(writeNow, 200);
}
process.on('SIGTERM', () => { try { writeNow(); } catch (e) {} process.exit(0); });
process.on('SIGINT', () => { try { writeNow(); } catch (e) {} process.exit(0); });

function who(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return { ip: ip.slice(0, 64), ua: String(req.headers['user-agent'] || '').slice(0, 300) };
}
function log(user, kind, text, extra) {
  db.activity.unshift(Object.assign({ id: M.newId('e'), at: M.stamp(), uid: user ? user.id : null, name: user ? user.name : '', role: user ? user.role : '', kind, text }, extra || {}));
  if (db.activity.length > 3000) db.activity.length = 3000;
}

function progressOf(uid) {
  if (!db.progress[uid]) db.progress[uid] = M.emptyProgress();
  return db.progress[uid];
}

function stockLeft(prizeId) {
  const p = db.rewards.find((x) => x.id === prizeId);
  if (!p) return 0;
  let taken = 0;
  Object.keys(db.progress).forEach((uid) => {
    db.progress[uid].requests.forEach((r) => { if (r.prize === prizeId && (r.status === 'pending' || r.status === 'delivered')) taken++; });
  });
  return Number(p.stock) - taken;
}

// ---------- what each person receives ----------
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, unit: u.unit || '', earns: !!u.earns, disabled: !!u.disabled, mustChange: !!u.mustChange, created: u.created || '', lastLogin: u.lastLogin || '', lastSeen: u.lastSeen || '', envAdmin: !!u.envAdmin };
}
// What a student's group learns: whole levels and single skills (its own setting, else its parent group's).
// Nothing assigned = the whole curriculum.
function levelsFor(user) {
  let unit = user && user.unit ? db.units.find((x) => x.id === user.unit) : null;
  for (let i = 0; unit && i < 6; i++) {
    const lv = Array.isArray(unit.levels) ? unit.levels : [];
    const sk = Array.isArray(unit.skills) ? unit.skills : [];
    if (lv.length || sk.length) return { levels: lv, skills: sk };
    unit = unit.parent ? db.units.find((x) => x.id === unit.parent) : null;
  }
  return { levels: [], skills: [] };
}
// ---------- the game's look: themes the admin designs, chosen per group ----------
// A theme is a base style (race, regular, military) plus the admin's colors, fonts, background, words and motion.
// The three built-in themes always exist; they can be edited and reset, not deleted.
const BASES = ['race', 'regular', 'mil'];
const BASE_ICONS = { race: 'line', regular: 'emoji', mil: 'emoji' };
const BUILTIN_NAMES = { 't-race': ['race', 'מירוץ FPV'], 't-regular': ['regular', 'משחקי צבעוני'], 't-mil': ['mil', 'צבאי'] };
const LEGACY_UI = { race: 't-race', regular: 't-regular', mil: 't-mil' };
// A group on a built-in theme keeps the older name on disk (race, regular, mil), so going back to the previous
// version of the site still finds it; the server reads both names the same way.
const STORED_UI = { 't-race': 'race', 't-regular': 'regular', 't-mil': 'mil' };
const SCENES = ['field', 'city', 'street', 'garage', 'loft', 'forest', 'night'];
// the fonts the design page offers (the same lists as the page): Hebrew fonts for titles and text, any for numbers
const FONTS_HEAD = ['Rubik', 'Heebo', 'Assistant', 'Open Sans', 'Noto Sans Hebrew', 'IBM Plex Sans Hebrew', 'Alef', 'Miriam Libre', 'Varela Round', 'Fredoka', 'Secular One', 'Suez One', 'Karantina', 'Amatic SC', 'Bellefair', 'Frank Ruhl Libre', 'David Libre', 'Noto Serif Hebrew', 'Bona Nova', 'Rubik Dirt', 'Rubik Glitch', 'Rubik Wet Paint', 'Rubik Puddles', 'Rubik Moonrocks', 'Rubik Iso', 'Rubik Microbe', 'Rubik Beastly', 'Rubik Burned', 'Rubik Distressed'];
const FONTS_BODY = ['Rubik', 'Heebo', 'Assistant', 'Open Sans', 'Noto Sans Hebrew', 'IBM Plex Sans Hebrew', 'Alef', 'Miriam Libre', 'Arimo', 'Varela Round', 'Fredoka', 'Frank Ruhl Libre', 'David Libre', 'Noto Serif Hebrew'];
const FONTS_NUM = ['Unbounded', 'Russo One', 'Black Ops One', 'Orbitron', 'Audiowide', 'Bungee', 'Press Start 2P', 'Teko', 'Oswald', 'Bebas Neue', 'Chakra Petch', 'Rubik', 'Heebo', 'Open Sans', 'Secular One'];
// colours: the brand four, the stations' states and a few parts of the screen; per mode: background, cards, text, secondary text
const COLOR_KEYS = ['accent', 'accent2', 'gold', 'sky', 'done', 'fix', 'lock', 'coin', 'xp', 'menu'];
const SURF_KEYS = ['bg', 'card', 'text', 'dim'];
const TERM_KEYS = ['t1', 't2', 't3', 't4', 'world', 'chest', 'boss', 'league', 'mapTitle', 'questsTitle', 'go', 'lit'];
function themeDefaults(id) {
  const [base, name] = BUILTIN_NAMES[id];
  return { id, name, base, mode: 'night', allowToggle: true, colors: {}, surf: { night: {}, day: {} }, fonts: { head: 'default', body: 'default', num: 'default' }, icons: BASE_ICONS[base], bg: { kind: 'look' }, stageBg: true, terms: {}, motion: 'full', builtIn: true };
}
const hexOk = (v) => /^#[0-9a-f]{6}$/i.test(String(v || ''));
const imgOk = (v) => /^\/media\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(String(v || '')) || /^https:\/\/\S+$/i.test(String(v || ''));
// the showcase's own look: a picture for the media window (empty = each stage's picture), how dark it is,
// the colours of the info square and the tabs (empty = the theme's), and the corners
function cleanShow(v) {
  const o = v && typeof v === 'object' ? v : {};
  const dim = Math.max(0, Math.min(80, Math.round(Number(o.dim))));
  return {
    img: imgOk(o.img) ? String(o.img).slice(0, 500) : '',
    dim: Number.isFinite(dim) && o.dim !== undefined && o.dim !== '' ? dim : 35,
    info: hexOk(o.info) ? String(o.info).toLowerCase() : '',
    tab: hexOk(o.tab) ? String(o.tab).toLowerCase() : '',
    corners: o.corners === 'soft' ? 'soft' : 'square'
  };
}
function cleanTheme(t) {
  if (!t || typeof t !== 'object') return null;
  const id = /^t-[A-Za-z0-9-]{1,40}$/.test(String(t.id || '')) ? String(t.id) : M.newId('t-');
  const base = BASES.indexOf(t.base) !== -1 ? t.base : 'race';
  const pick = (o, keys) => { const out = {}; keys.forEach((k) => { if (o && hexOk(o[k])) out[k] = String(o[k]).toLowerCase(); }); return out; };
  const surf = { night: pick(t.surf && t.surf.night, SURF_KEYS), day: pick(t.surf && t.surf.day, SURF_KEYS) };
  const font = (v, list) => (list.indexOf(v) !== -1 ? v : 'default');
  const tf = t.fonts || {};
  let bg = { kind: 'look' };
  const b = t.bg || {};
  if (b.kind === 'color' && hexOk(b.color)) bg = { kind: 'color', color: String(b.color).toLowerCase() };
  else if (b.kind === 'scene' && SCENES.indexOf(b.id) !== -1) bg = { kind: 'scene', id: b.id };
  else if (b.kind === 'img' && imgOk(b.url)) bg = { kind: 'img', url: String(b.url).slice(0, 500), blur: b.blur !== false };
  const terms = {};
  TERM_KEYS.forEach((k) => { const v = String((t.terms && t.terms[k]) || '').replace(/[<>]/g, '').trim().slice(0, 40); if (v) terms[k] = v; });
  return {
    id, name: String(t.name || '').replace(/[<>]/g, '').trim().slice(0, 40) || 'ערכה ללא שם', base, mode: t.mode === 'day' ? 'day' : 'night', allowToggle: t.allowToggle !== false,
    colors: pick(t.colors, COLOR_KEYS), surf, fonts: { head: font(tf.head, FONTS_HEAD), body: font(tf.body, FONTS_BODY), num: font(tf.num, FONTS_NUM) },
    icons: t.icons === 'line' || t.icons === 'emoji' ? t.icons : BASE_ICONS[base], bg, stageBg: t.stageBg !== false, terms, motion: t.motion === 'calm' ? 'calm' : 'full',
    // how an exercise window is laid out: as it always was (classic), one panel at the bottom, or the showcase
    // (an info square beside a big media window, with a tab per step). Only a theme that picks one gets it.
    layout: ['show', 'panel', 'bar', 'story'].indexOf(t.layout) !== -1 ? t.layout : 'classic', show: cleanShow(t.show),
    // a special look over the base style: 'pixel' turns the whole student screen into a retro 8-bit arcade
    look: t.look === 'pixel' ? 'pixel' : '',
    // the stage lens in the exercise window: shown or not (auto = as the layout has it), size, shape, place, ring colour
    lens: (() => { const l = t.lens && typeof t.lens === 'object' ? t.lens : {}; const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v != null ? Math.max(lo, Math.min(hi, n)) : d; };
      return { show: ['on', 'off'].indexOf(l.show) !== -1 ? l.show : 'auto', size: num(l.size, 50, 200, 100), shape: ['round', 'square', 'hex', 'diamond'].indexOf(l.shape) !== -1 ? l.shape : 'round',
        x: num(l.x, -400, 400, 0), y: num(l.y, -300, 300, 0), ring: hexOk(l.ring) ? String(l.ring).toLowerCase() : '' }; })(),
    // the pilot card in the hangar ("example student"): colours, sizes, corners, width, side and what it shows
    pcard: (() => { const c = t.pcard && typeof t.pcard === 'object' ? t.pcard : {}; const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v != null ? Math.max(lo, Math.min(hi, n)) : d; };
      const o = { drone: num(c.drone, 50, 160, 100), name: num(c.name, 60, 180, 100), num: num(c.num, 60, 200, 100),
        corners: ['0', '16', '40'].indexOf(String(c.corners)) !== -1 ? String(c.corners) : 'auto', width: ['narrow', 'wide'].indexOf(c.width) !== -1 ? c.width : 'normal',
        side: c.side === 'end' ? 'end' : 'start', align: c.align === 'start' ? 'start' : 'center', stats: c.stats !== false, badge: c.badge !== false, float: c.float !== false };
      ['bg', 'bg2', 'fg', 'badgeBg', 'badgeFg', 'statBg', 'numC', 'lbl', 'line'].forEach((k) => { o[k] = hexOk(c[k]) ? String(c[k]).toLowerCase() : ''; });
      return o; })(),
    // the exercise window card (story card, one-panel box, bar pop-up): colours, sizes, width, corners, glass, place
    wcard: (() => { const c = t.wcard && typeof t.wcard === 'object' ? t.wcard : {}; const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v != null ? Math.max(lo, Math.min(hi, n)) : d; };
      const o = { title: num(c.title, 60, 160, 100), text: num(c.text, 80, 140, 100), width: num(c.width, 60, 150, 100), alpha: num(c.alpha, 30, 100, 85), y: num(c.y, -250, 250, 0),
        corners: ['0', '16', '40'].indexOf(String(c.corners)) !== -1 ? String(c.corners) : 'auto', glass: c.glass !== false, align: c.align === 'center' ? 'center' : 'start' };
      ['bg', 'fg', 'head', 'kick', 'btn', 'btnFg', 'line'].forEach((k) => { o[k] = hexOk(c[k]) ? String(c[k]).toLowerCase() : ''; });
      return o; })(),
    // windows of the admin's own: a title, text, picture and button, shown in a chosen screen
    boxes: (Array.isArray(t.boxes) ? t.boxes : []).slice(0, 8).map((x, i) => { x = x && typeof x === 'object' ? x : {}; const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, n);
      const url = (v) => { const u = str(v, 600).trim(); return /^https?:\/\//i.test(u) || /^\/[^\/]/.test(u) || /^data:image\/(png|jpe?g|webp|gif);base64,/i.test(u) ? u : ''; };
      return { id: /^[a-z0-9]{1,16}$/i.test(String(x.id)) ? String(x.id) : 'b' + i, on: x.on !== false, place: ['map', 'quests', 'league', 'hangar'].indexOf(x.place) !== -1 ? x.place : 'map',
        title: str(x.title, 80), text: str(x.text, 600), img: url(x.img), btn: str(x.btn, 30), link: /^https?:\/\//i.test(String(x.link || '').trim()) ? str(x.link, 400).trim() : '',
        size: ['s', 'l'].indexOf(x.size) !== -1 ? x.size : 'm', align: x.align === 'center' ? 'center' : 'start', close: x.close !== false,
        bg: hexOk(x.bg) ? String(x.bg).toLowerCase() : '', fg: hexOk(x.fg) ? String(x.fg).toLowerCase() : '', accent: hexOk(x.accent) ? String(x.accent).toLowerCase() : '' }; }),
    // open editing: the admin's own CSS for this theme (no imports, no closing the style tag)
    css: String(t.css == null ? '' : t.css).slice(0, 20000).replace(/<\/?\s*style/gi, '').replace(/@import/gi, '').replace(/javascript:/gi, ''),
    // the stage chips above the exercise card (the mission, briefing, flight, instructor): colours, size, shape, names, place
    steps: (() => { const c = t.steps && typeof t.steps === 'object' ? t.steps : {}; const num = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v != null ? Math.max(lo, Math.min(hi, n)) : d; };
      const o = { show: c.show !== false, size: num(c.size, 70, 170, 100), gap: num(c.gap, 0, 40, 6), shape: ['round', 'square'].indexOf(c.shape) !== -1 ? c.shape : 'pill', place: c.place === 'below' ? 'below' : 'above',
        lines: c.lines !== false, ticks: c.ticks !== false, stamp: c.stamp !== false, names: {} };
      ['bg', 'fg', 'curBg', 'curFg', 'okBg', 'okFg', 'line', 'edge', 'stampBg', 'stampFg'].forEach((k) => { o[k] = hexOk(c[k]) ? String(c[k]).toLowerCase() : ''; });
      const n = c.names && typeof c.names === 'object' ? c.names : {}; ['intro', 'video', 'up', 'tower'].forEach((k) => { o.names[k] = String(n[k] == null ? '' : n[k]).replace(/[\u0000-\u001F<>]/g, '').slice(0, 20); });
      return o; })(),
    // the bottom bar's default place: a row at the bottom, or a list under the side menu (the student can switch)
    barPos: t.barPos === 'side' ? 'side' : 'bottom',
    // the automatic flow: open the waiting step on arrival, move on after sending, close messages after some seconds
    flow: (() => { const f = t.flow && typeof t.flow === 'object' ? t.flow : {}; const c = Math.round(Number(f.close)); return { on: !!f.on, open: f.open !== false, next: f.next !== false, close: Number.isFinite(c) ? Math.max(0, Math.min(15, c)) : 4 }; })(), builtIn: !!BUILTIN_NAMES[id]
  };
}
// A background for one stage: none, a built-in scene, or an uploaded image (blurred a little unless told not to).
function cleanBg(v) {
  if (!v || typeof v !== 'object') return null;
  const s = String(v.bg || '');
  if (s === 'none') return { bg: 'none' };
  if (/^scene:/.test(s) && SCENES.indexOf(s.slice(6)) !== -1) return { bg: s };
  if (/^img:/.test(s) && imgOk(s.slice(4))) return { bg: s.slice(0, 504), blur: v.blur !== false };
  return null;
}
function ensureLooks() {
  const st = db.settings;
  const list = (Array.isArray(st.themes) ? st.themes : []).map(cleanTheme).filter(Boolean);
  Object.keys(BUILTIN_NAMES).forEach((id) => { if (!list.some((t) => t.id === id)) list.push(themeDefaults(id)); });
  // once: themes saved while the bottom panel was everyone's default go back to the classic window
  if (!st.layoutV2) { st.layoutV2 = true; list.forEach((t) => { if (t.layout === 'panel') t.layout = 'classic'; }); }
  // once: a ready theme with the showcase layout, to assign to a group or copy (an ordinary theme, so it can be edited or deleted)
  if (!st.showSeeded) {
    st.showSeeded = true;
    if (!list.some((t) => t.id === 't-show')) list.push(cleanTheme({ id: 't-show', name: 'תצוגת משימה', base: 'regular', mode: 'night', layout: 'show', colors: { accent: '#8cfac8' } }));
  }
  // once: a ready retro-arcade theme (an original pixel look, no game's characters or brands)
  if (!st.pixelSeeded) {
    st.pixelSeeded = true;
    if (!list.some((t) => t.id === 't-pixel')) list.push(cleanTheme({ id: 't-pixel', name: 'פיקסל 88', base: 'regular', mode: 'day', allowToggle: false, look: 'pixel',
      colors: { accent: '#e83b2e', accent2: '#2e5ce8', gold: '#ffc61a', sky: '#4fc3f7', done: '#3cb043', fix: '#ff8a1a', lock: '#7a6a5a', coin: '#ffc61a' },
      surf: { day: { bg: '#6bb8ff', card: '#fff6e0', text: '#1a1020', dim: '#5a4a60' } },
      terms: { world: 'עולם', chest: 'תיבת בונוס', boss: 'השלב האחרון', lit: '1-UP!', go: 'יוצאים לדרך!' } }));
  }
  // once: a ready theme with the bottom bar (headings that open their own windows)
  if (!st.barSeeded) {
    st.barSeeded = true;
    if (!list.some((t) => t.id === 't-bar')) list.push(cleanTheme({ id: 't-bar', name: 'בר תחתון', base: 'regular', mode: 'night', layout: 'bar' }));
  }
  // once: the ready bottom-bar theme runs on the automatic flow
  if (!st.barFlowSeeded) {
    st.barFlowSeeded = true;
    const tb = list.find((t) => t.id === 't-bar'); if (tb && !tb.flow.on) tb.flow = { on: true, open: true, next: true, close: 4 };
  }
  // once: a ready theme where each exercise plays itself, stage by stage
  if (!st.storySeeded) {
    st.storySeeded = true;
    if (!list.some((t) => t.id === 't-story')) list.push(cleanTheme({ id: 't-story', name: 'זרימה אוטומטית', base: 'regular', mode: 'night', layout: 'story', flow: { on: true, open: true, next: true, close: 3 } }));
  }
  if (!st.barSideSeeded) {
    st.barSideSeeded = true;
    if (!list.some((t) => t.id === 't-side')) list.push(cleanTheme({ id: 't-side', name: 'רשימה בצד', base: 'regular', mode: 'night', layout: 'bar', barPos: 'side', flow: { on: true, open: true, next: true, close: 4 } }));
  }
  st.themes = list;
  const sb = st.stageBg && st.stageBg.assign && typeof st.stageBg.assign === 'object' ? st.stageBg.assign : {};
  const assign = {};
  Object.keys(sb).forEach((k) => { if (/^(w\d{1,3}|s\d{1,6}|c\d{1,3}|boss)$/.test(k)) { const v = cleanBg(sb[k]); if (v) assign[k] = v; } });
  st.stageBg = { assign };
  st.bgLib = (Array.isArray(st.bgLib) ? st.bgLib : []).filter((x) => x && imgOk(x.url)).map((x) => ({ url: String(x.url).slice(0, 500), name: String(x.name || 'תמונה').replace(/[<>]/g, '').slice(0, 60) })).slice(0, 80);
}
function themeById(id) {
  return db.settings.themes.find((t) => t.id === id) || null;
}
// What a group's value means now: the regular screen, a theme that exists, or (a deleted theme) the race theme.
function uiValue(v) {
  if (!v) return '';
  if (v === 'classic') return 'classic';
  const id = LEGACY_UI[v] || v;
  return themeById(id) ? id : 't-race';
}
// Which screen a group's students get: the regular one, or the game in one of the themes.
// The group's own choice, else its parent group's; nothing set = the regular screen.
function uiFor(user) {
  let unit = user && user.unit ? db.units.find((x) => x.id === user.unit) : null;
  for (let i = 0; unit && i < 6; i++) {
    const v = uiValue(unit.ui);
    if (v) return v;
    unit = unit.parent ? db.units.find((x) => x.id === unit.parent) : null;
  }
  return 'classic';
}
function bootFor(user) {
  if (user.role === 'student') return M.scoped(levelsFor(user), () => bootFor0(user));
  return bootFor0(user);
}
function bootFor0(user) {
  const rewards = db.rewards.map((p) => Object.assign({}, p, { left: stockLeft(p.id) }));
  const base = { me: publicUser(user), today: M.today(), now: M.stamp(), units: db.units, rewards, scoring: db.scoring, levels: M.LEVELS.slice(), skills: M.SKILLS.slice(), challenges: M.CHALLENGES.slice(),
    allSkills: M.ALL_SKILLS.map((k) => ({ id: k.id, name: k.name, level: k.level, active: k.active })),
    allChallenges: M.ALL_CHALLENGES.map((c) => ({ id: c.id, title: c.title, points: c.points, active: c.active, final: !!c.final })) };
  base.settings = { videoDays: db.settings.videoDays, maxFlightMb: Math.round(MAX_FLIGHT / 1048576) };
  if (user.role === 'admin') {
    base.curriculum = db.curriculum;
    base.settings.mediaFree = Number.isFinite(freeBytes()) ? Math.round(freeBytes() / 1048576) : null;
    base.settings.ai = Object.assign({}, db.settings.ai, { hasKey: AI.hasKey(), defaultModel: AI.DEFAULT_MODEL, queue: aiQueue.length + (aiBusy ? 1 : 0), today: db.aiUsage.day === M.today() ? db.aiUsage.count : 0 });
  }
  if (user.role === 'student') {
    base.progress = studentView(progressOf(user.id));
    base.ui = uiFor(user);
    base.theme = themeById(base.ui === 'classic' ? 't-race' : base.ui) || themeDefaults('t-race');
    base.stageBg = db.settings.stageBg;
  } else if (user.role === 'admin') {
    base.users = db.users.map(publicUser);
    base.progressAll = {};
    db.users.filter((u) => u.role === 'student').forEach((u) => { base.progressAll[u.id] = progressOf(u.id); });
    base.themes = db.settings.themes;
    base.stageBg = db.settings.stageBg;
    base.bgLib = db.settings.bgLib;
    base.activity = db.activity.slice(0, 1000);
  } else if (user.role === 'observer') {
    const mine = db.users.filter((u) => u.role === 'student' && u.unit && u.unit === user.unit);
    base.users = mine.map(publicUser).concat([publicUser(user)]);
    base.progressAll = {};
    mine.forEach((u) => { base.progressAll[u.id] = progressOf(u.id); });
    base.activity = [];
  }
  return base;
}

// ---------- the admin's preview of the game (the design page shows it live) ----------
// A sample student in the chosen group: a third of the path done, the next exercise waiting for the instructor.
function previewBoot(unitId, themeId) {
  const fake = { id: 'preview', username: 'preview', name: 'תלמיד לדוגמה', role: 'student', unit: db.units.some((x) => x.id === unitId) ? unitId : '', earns: true };
  return M.scoped(levelsFor(fake), () => {
    const sk = M.SKILLS.slice(), now = M.stamp(), day = M.today(), doc = M.emptyProgress();
    // about a third of the path: whole levels done (their chest ready to open), then in the current level
    // all but two exercises done, one waiting for the instructor and one open, so every state shows
    const lvls = M.LEVELS.filter((l) => sk.some((k) => k.level === l.n));
    const target = Math.max(1, Math.ceil(sk.length / 3)), done = [], full = [];
    let wait = null;
    for (let i = 0; i < lvls.length; i++) {
      const ks = sk.filter((k) => k.level === lvls[i].n);
      if (done.length + ks.length <= target && i < lvls.length - 1) { done.push(...ks); full.push(lvls[i].n); continue; }
      done.push(...ks.slice(0, Math.max(0, ks.length - 2)));
      if (ks.length >= 3) wait = ks[ks.length - 2];
      break;
    }
    done.forEach((k, i) => {
      doc.acquired[k.id] = 'flight';
      doc.flights.push({ id: 'pf' + k.id, skill: k.id, at: now, status: 'approved', feedback: i === 0 ? 'יפה מאוד, ככה ממשיכים' : '', note: '', link: '', stars: 3 - (i % 3) });
      doc.ledger.push({ id: 'pl' + k.id, at: now, cat: 'stage', kind: 'skill', text: 'טיסה אושרה: ' + k.name, amount: M.skillPoints(db.scoring, k.id), skill: k.id });
    });
    const lb = db.scoring.levelBonus || {};
    full.forEach((n) => { const amount = lb.on ? Number(lb[n]) || 0 : 0; if (amount > 0) doc.ledger.push({ id: 'plv' + n, at: now, cat: 'stage', kind: 'level', level: n, text: 'בונוס סיום רמה', amount, skill: null }); });
    if (wait) doc.flights.unshift({ id: 'pw', skill: wait.id, at: now, status: 'review', feedback: '', note: '', link: '' });
    doc.ledger.push({ id: 'plg', at: day + ' 08:00', cat: 'habit', kind: 'login', text: 'כניסה יומית', amount: M.rule(db.scoring, 'login') });
    doc.timeDay = day; doc.introSeen = true;
    const ui = uiFor(fake);
    return {
      preview: true, me: publicUser(fake), today: day, now, units: db.units, rewards: db.rewards.map((p) => Object.assign({}, p, { left: stockLeft(p.id) })), scoring: db.scoring,
      levels: M.LEVELS.slice(), skills: M.SKILLS.slice(), challenges: M.CHALLENGES.slice(),
      allSkills: M.ALL_SKILLS.map((k) => ({ id: k.id, name: k.name, level: k.level, active: k.active })),
      allChallenges: M.ALL_CHALLENGES.map((c) => ({ id: c.id, title: c.title, points: c.points, active: c.active, final: !!c.final })),
      settings: { videoDays: db.settings.videoDays, maxFlightMb: Math.round(MAX_FLIGHT / 1048576) },
      progress: doc, ui, theme: themeById(themeId) || themeById(ui === 'classic' ? 't-race' : ui) || themeDefaults('t-race'), stageBg: db.settings.stageBg
    };
  });
}

// ---------- the game's league: this week's coins in the student's group ----------
// The week runs Sunday to Saturday, Israel time. Only students who earn points take part; each one sees first names
// and an initial, never usernames or ids.
function weekStart(day) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
}
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'שחקן';
  return parts[0] + (parts.length > 1 ? ' ' + parts[parts.length - 1].charAt(0) + '.' : '');
}
function leagueFor(user) {
  const day = M.today();
  const start = weekStart(day);
  const endD = new Date(start + 'T12:00:00Z');
  endD.setUTCDate(endD.getUTCDate() + 6);
  const end = endD.toISOString().slice(0, 10);
  const mates = user.unit ? db.users.filter((u) => u.role === 'student' && !u.disabled && u.earns && u.unit === user.unit) : [];
  if (!mates.some((u) => u.id === user.id) && user.earns) mates.push(user);
  const rows = mates.map((u) => {
    const doc = db.progress[u.id] || M.emptyProgress();
    const pts = (doc.ledger || []).filter((e) => String(e.at || '').slice(0, 10) >= start).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return { name: shortName(u.name), pts: Math.max(0, pts), me: u.id === user.id };
  }).sort((a, b) => b.pts - a.pts || (a.me ? -1 : b.me ? 1 : 0));
  const un = db.units.find((x) => x.id === user.unit);
  return { unit: un ? un.name : '', start, end, today: day, rows };
}

// ---------- http helpers ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' }, headers || {}));
  res.end(body);
}
function json(res, code, obj, headers) {
  send(res, code, JSON.stringify(obj), Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
}
function redirect(res, to, headers) {
  send(res, 302, '', Object.assign({ Location: to }, headers || {}));
}
function cookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token, maxAge) {
  return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (PROD ? '; Secure' : '');
}
function currentUser(req) {
  const token = cookies(req)[COOKIE];
  const s = token && db.sessions[token];
  if (!s || s.exp < Date.now()) return null;
  const u = db.users.find((x) => x.id === s.uid);
  if (!u || u.disabled) return null;
  return u;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2e6) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function homeFor(user) {
  if (!user) return '/Login.dc.html';
  if (user.mustChange) return '/password';
  if (user.role === 'student') return uiFor(user) === 'classic' ? '/StudentApp.dc.html' : '/Game.html';
  if (user.role === 'observer') return '/Observer.dc.html';
  return '/Main.dc.html';
}

// Which screens each role may open. Imported screens must also be reachable (the observer view imports Leadership).
// Pages that are not built with the design tool: they get the same signed-in data in the spot they mark.
const PLAIN_PAGES = new Set(['Game.html', 'Tower.html', 'Studio.html']);
const OBSERVER_PAGES = new Set(['Observer.dc.html', 'Leadership.dc.html']);
const ADMIN_BLOCKED = new Set(['StudentApp.dc.html', 'Observer.dc.html', 'Game.html']);
const STUDENT_FILES = new Set(['StudentApp.dc.html', 'Game.html', 'Login.dc.html']);
function mayOpen(user, file) {
  // a student gets the one screen chosen for their group: the regular screen or the game
  if (user.role === 'student') return file === (uiFor(user) === 'classic' ? 'StudentApp.dc.html' : 'Game.html');
  if (user.role === 'observer') return OBSERVER_PAGES.has(file);
  return !ADMIN_BLOCKED.has(file);
}

// ---------- login protection ----------
const attempts = new Map();
function tooMany(key) {
  const a = attempts.get(key);
  return a && a.count >= 5 && Date.now() - a.first < 60000;
}
function failed(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first >= 60000) attempts.set(key, { count: 1, first: Date.now() });
  else a.count++;
}

// ---------- pages ----------
function boardHtml(file, user, bootOverride) {
  let html = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  const boot = bootOverride || (user ? bootFor(user) : null);
  const data = JSON.stringify(boot).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // admin pages also get the side menu's look (public/adminnav.css); the student screens keep their own
  const nav = STUDENT_FILES.has(file) ? '' : '<link rel="stylesheet" href="./adminnav.css">\n';
  const inject = '<script>window.__ACADEMY__=' + data + ';</script>\n<script src="./academy.js"></script>\n' + nav;
  if (html.indexOf('<!--ACADEMY-->') !== -1) return html.replace('<!--ACADEMY-->', inject);
  return html.replace('<script src="./support.js"></script>', inject + '<script src="./support.js"></script>');
}

function passwordPage(user, error) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>בחירת סיסמה · 88ACADEMY</title><link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Karantina:wght@700&family=Rubik:wght@400;500;600&display=swap">
<style>body{margin:0;background:#FFFFFF;color:#1E2320;font-family:'Rubik',system-ui,sans-serif;font-size:15px;line-height:1.5}main{width:min(440px,calc(100% - 32px));margin:48px auto;box-sizing:border-box;padding:30px;border:6px solid #57AD8E;border-radius:26px;box-shadow:0 24px 60px rgba(18,20,19,.12)}h1{display:inline-block;margin:0;padding:4px 2px 6px;border-top:5px solid #121413;border-bottom:5px solid #121413;font-family:'Karantina','Rubik',sans-serif;font-size:48px;line-height:.9;color:#121413}label{display:block;margin:18px 0 8px;font-size:14px;font-weight:500;color:#3D4541}input{width:100%;box-sizing:border-box;height:46px;padding:0 14px;border:1px solid #D3D9D5;border-radius:10px;font:inherit;font-size:16px}button{width:100%;height:50px;margin-top:22px;border:0;border-radius:999px;background:#C7436A;color:#fff;font:inherit;font-size:16px;font-weight:600;cursor:pointer}button:hover{background:#B13A5D}.err{margin:14px 0 0;padding:10px 12px;background:#FDECEC;border:1px solid #F2B8B8;border-radius:10px;color:#7F1D1D}p.hint{margin:12px 0 0;color:#3D4541}:focus-visible{outline:2px solid #C7436A;outline-offset:2px}</style></head>
<body><main><h1>סיסמה חדשה</h1><p class="hint">${user.mustChange ? 'שלום ' + esc(user.name) + '. זו הכניסה הראשונה שלך, אז בחר/י סיסמה משלך: לפחות 8 תווים.' : 'שלום ' + esc(user.name) + '. כאן מחליפים סיסמה: לפחות 8 תווים.'}</p>
${error ? '<p class="err" role="alert">' + esc(error) + '</p>' : ''}
<form method="post" action="/password">${user.mustChange ? '' : '<label for="p0">הסיסמה הנוכחית</label><input id="p0" name="p0" type="password" autocomplete="current-password" required dir="ltr">'}<label for="p1">סיסמה חדשה</label><input id="p1" name="p1" type="password" autocomplete="new-password" required minlength="8" dir="ltr">
<label for="p2">שוב, לאימות</label><input id="p2" name="p2" type="password" autocomplete="new-password" required minlength="8" dir="ltr"><button type="submit">${user.mustChange ? 'שמירה וכניסה' : 'שמירה'}</button></form>${user.mustChange ? '' : '<p class="hint" style="text-align:center"><a href="' + homeFor(user) + '" style="color:#17694F">ביטול וחזרה</a></p>'}</main></body></html>`;
}

function readForm(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const out = {};
      body.split('&').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[decodeURIComponent(p.slice(0, i))] = decodeURIComponent(p.slice(i + 1).replace(/\+/g, ' ')); });
      resolve(out);
    });
  });
}

// ---------- admin actions ----------
function findUser(id) {
  return db.users.find((u) => u.id === id);
}
function cleanUsername(s) {
  return String(s || '').trim();
}
function validUsername(s) {
  return /^[A-Za-z0-9._-]{2,40}$/.test(s);
}

const ADMIN_ACTIONS = {
  createUser(me, b) {
    const username = cleanUsername(b.username);
    if (!validUsername(username)) return 'שם משתמש: רק אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון.';
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return 'שם המשתמש @' + username + ' כבר תפוס.';
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) return 'יש להזין שם תצוגה.';
    const role = ['student', 'observer', 'admin'].indexOf(b.role) !== -1 ? b.role : 'student';
    const pw = String(b.password || '');
    if (pw.length < 6) return 'הסיסמה הזמנית צריכה להכיל לפחות 6 תווים.';
    const unit = role === 'admin' ? '' : String(b.unit || '');
    if (role === 'observer' && !unit) return 'יש לבחור קבוצה למשקיף.';
    const h = hashPassword(pw);
    const u = { id: M.newId('u'), username, name, role, unit, earns: role === 'student' ? b.earns !== false : false, passSalt: h.salt, passHash: h.hash, mustChange: true, created: M.stamp() };
    db.users.push(u);
    if (role === 'student') progressOf(u.id);
    log(me, 'user', 'פתח חשבון ל' + name + ' (' + roleName(role) + ')', { target: u.id });
    return { id: u.id };
  },
  updateUser(me, b) {
    const u = findUser(b.id);
    if (!u) return 'המשתמש לא נמצא.';
    if (u.envAdmin && !me.envAdmin) return 'רק המנהל הראשי יכול לערוך את החשבון שלו.';
    const username = cleanUsername(b.username != null ? b.username : u.username);
    if (!validUsername(username)) return 'שם משתמש: רק אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון.';
    if (db.users.some((x) => x.id !== u.id && x.username.toLowerCase() === username.toLowerCase())) return 'שם המשתמש @' + username + ' כבר תפוס.';
    if (u.envAdmin && username !== u.username) return 'את שם המשתמש של המנהל הראשי משנים בהגדרות של Render.';
    const name = String(b.name != null ? b.name : u.name).trim().slice(0, 80);
    if (!name) return 'יש להזין שם תצוגה.';
    let role = b.role != null ? b.role : u.role;
    if (['student', 'observer', 'admin'].indexOf(role) === -1) role = u.role;
    if (u.envAdmin) role = 'admin';
    const unit = role === 'admin' ? '' : String(b.unit != null ? b.unit : u.unit || '');
    if (role === 'observer' && !unit) return 'יש לבחור קבוצה למשקיף.';
    u.username = username;
    u.name = name;
    u.role = role;
    u.unit = unit;
    if (b.earns != null) u.earns = role === 'student' && !!b.earns;
    if (b.disabled != null && !u.envAdmin && u.id !== me.id) {
      u.disabled = !!b.disabled;
      if (u.disabled) Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].uid === u.id) delete db.sessions[k]; });
    }
    if (role === 'student') progressOf(u.id);
    log(me, 'user', 'עדכן את הפרטים של ' + name, { target: u.id });
    return { id: u.id };
  },
  // Clearing history: only the main admin (the one set in Render) may do it. Takes the ids to remove, or all: true.
  clearActivity(me, b) {
    if (!me.envAdmin) return 'רק המנהל הראשי יכול למחוק היסטוריה.';
    const before = db.activity.length;
    if (b.all === true) db.activity = [];
    else {
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      if (!ids.size) return 'לא נבחרו אירועים למחיקה.';
      db.activity = db.activity.filter((e) => !ids.has(String(e.id)));
    }
    const gone = before - db.activity.length;
    log(me, 'user', b.all === true ? 'מחק את כל ההיסטוריה (' + gone + ' אירועים)' : gone === 1 ? 'מחק אירוע אחד מההיסטוריה' : 'מחק ' + gone + ' אירועים מההיסטוריה');
    return { removed: gone };
  },
  deleteUser(me, b) {
    const u = findUser(b.id);
    if (!u) return 'המשתמש לא נמצא.';
    if (u.envAdmin || u.id === me.id) return 'אי אפשר למחוק את החשבון הזה.';
    db.users = db.users.filter((x) => x.id !== u.id);
    delete db.progress[u.id];
    Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].uid === u.id) delete db.sessions[k]; });
    log(me, 'user', 'מחק את החשבון של ' + u.name);
    return { ok: true };
  },
  resetPassword(me, b) {
    const u = findUser(b.id);
    if (!u) return 'המשתמש לא נמצא.';
    if (u.envAdmin) return 'את הסיסמה של המנהל הראשי משנים בהגדרות של Render.';
    const pw = String(b.password || '');
    if (pw.length < 6) return 'הסיסמה הזמנית צריכה להכיל לפחות 6 תווים.';
    const h = hashPassword(pw);
    u.passSalt = h.salt;
    u.passHash = h.hash;
    u.mustChange = true;
    Object.keys(db.sessions).forEach((k) => { if (db.sessions[k].uid === u.id) delete db.sessions[k]; });
    log(me, 'user', 'איפס סיסמה ל' + u.name, { target: u.id });
    return { ok: true };
  },
  moveUsers(me, b) {
    const unit = b.unit === 'none' ? '' : String(b.unit || '');
    const ids = Array.isArray(b.ids) ? b.ids : [];
    let n = 0;
    ids.forEach((id) => { const u = findUser(id); if (u && u.role === 'student') { u.unit = unit; n++; } });
    const un = db.units.find((x) => x.id === unit);
    log(me, 'user', n + ' סטודנטים הועברו ' + (un ? 'ל' + un.name : 'אל מחוץ ליחידות'));
    return { ok: true };
  },
  adjust(me, b) {
    const u = findUser(b.id);
    if (!u || u.role !== 'student') return 'הסטודנט לא נמצא.';
    if (!u.earns) return 'זה סטודנט שלא צובר נקודות. כדי לתת לו נקודות, משנים את התפקיד שלו לשחקן.';
    const delta = Math.trunc(Number(b.delta));
    if (!delta || Math.abs(delta) > 100000) return 'יש להזין מספר שלם שאינו אפס.';
    const doc = progressOf(u.id);
    if (M.total(doc) + delta < 0) return 'אפשר להוריד עד ' + M.total(doc) + ' מטבעות.';
    const reason = String(b.reason || '').trim().slice(0, 120) || 'התאמה ידנית';
    doc.ledger.push({ id: M.newId('a'), at: M.stamp(), cat: 'bonus', kind: 'manual', text: reason, amount: delta, skill: null, by: me.name });
    M.notify(doc, { kind: delta > 0 ? 'bonus' : 'manual', text: (delta > 0 ? 'המדריך הוסיף לך ' : 'המדריך הוריד ') + M.sg(delta) + ' מטבעות: ' + reason });
    log(me, 'points', (delta > 0 ? 'הוסיף ' : 'הוריד ') + Math.abs(delta) + ' מטבעות ל' + u.name + ': ' + reason, { target: u.id });
    return { ok: true };
  },
  reviewFlight(me, b) {
    const u = findUser(b.id);
    if (!u || u.role !== 'student') return 'הסטודנט לא נמצא.';
    const doc = progressOf(u.id);
    const f = doc.flights.find((x) => x.id === b.flight);
    if (!f) return 'הטיסה לא נמצאה.';
    if (f.status !== 'review') return 'הטיסה כבר נבדקה.';
    const feedback = String(b.feedback || '').trim().slice(0, 500);
    f.feedback = feedback;
    f.reviewedAt = M.stamp();
    f.reviewer = me.name;
    if (f.challenge) {
      const c = M.challengeById(f.challenge) || { title: 'אתגר', points: 0 };
      if (b.approve) {
        f.status = 'approved';
        const cstars = Math.trunc(Number(b.stars));
        if (cstars >= 1 && cstars <= 3) f.stars = cstars;
        const pts = u.earns ? Number(c.points) || 0 : 0;
        if (pts && !doc.ledger.some((e) => e.kind === 'challenge' && e.challenge === f.challenge && !e.reverted)) {
          doc.ledger.push({ id: M.newId('a'), at: M.stamp(), cat: 'bonus', kind: 'challenge', challenge: f.challenge, text: 'אתגר: ' + c.title, amount: pts, skill: null });
        }
        M.notify(doc, { kind: 'approved', text: 'האתגר אושר: ' + c.title + (f.stars ? ' · ' + '★'.repeat(f.stars) + '☆'.repeat(3 - f.stars) : '') + (pts ? ' (' + M.sg(pts) + ' מטבעות).' : '.') + (feedback ? (me.ai ? ' משוב הבדיקה האוטומטית: ״' : ' מדריך: ״') + feedback + '״' : '') });
        log(me, 'flight', 'אישר אתגר של ' + u.name + ': ' + c.title, { target: u.id });
      } else {
        f.status = 'rejected';
        M.notify(doc, { kind: 'rejected', text: 'הטיסה לאתגר ' + c.title + ' לא אושרה. אפשר לנסות שוב.' + (feedback ? (me.ai ? ' משוב הבדיקה האוטומטית: ״' : ' מדריך: ״') + feedback + '״' : '') });
        log(me, 'flight', 'החזיר לתיקון אתגר של ' + u.name + ': ' + c.title, { target: u.id });
      }
      return { ok: true };
    }
    const k = M.skillById(f.skill) || { name: 'מיומנות' };
    if (b.approve) {
      const first = !doc.flights.some((x) => x.skill === f.skill && x.id !== f.id && x.status === 'rejected');
      f.status = 'approved';
      const stars = Math.trunc(Number(b.stars));
      if (stars >= 1 && stars <= 3) f.stars = stars;
      const added = M.grantSkill(doc, db.scoring, f.skill, 'flight', { first, points: !!u.earns });
      const sum = added.reduce((s, e) => s + e.amount, 0);
      M.notify(doc, { kind: 'approved', skill: f.skill, text: 'מאושר: ' + k.name + (f.stars ? ' · ' + '★'.repeat(f.stars) + '☆'.repeat(3 - f.stars) : '') + (u.earns ? ' (' + M.sg(sum) + ' מטבעות).' : '.') + (feedback ? (me.ai ? ' משוב הבדיקה האוטומטית: ״' : ' מדריך: ״') + feedback + '״' : '') });
      log(me, 'flight', 'אישר טיסה של ' + u.name + ': ' + k.name, { target: u.id });
    } else {
      f.status = 'rejected';
      M.notify(doc, { kind: 'rejected', skill: f.skill, text: 'הטיסה ב' + k.name + ' לא אושרה. אפשר לנסות שוב.' + (feedback ? (me.ai ? ' משוב הבדיקה האוטומטית: ״' : ' מדריך: ״') + feedback + '״' : '') });
      log(me, 'flight', 'החזיר לתיקון טיסה של ' + u.name + ': ' + k.name, { target: u.id });
    }
    if (Number(db.settings.videoDays) === 0) cleanFlightVideos();
    return { ok: true };
  },
  // The instructor sets skills: done (with or without coins), sent back for a redo, or cancelled.
  setSkill(me, b) {
    const u = findUser(b.id);
    if (!u || u.role !== 'student') return 'הסטודנט לא נמצא.';
    const doc = progressOf(u.id);
    doc.redo = doc.redo || {};
    const to = b.to || (b.done ? 'done' : 'none');
    if (['done', 'required', 'none'].indexOf(to) === -1) return 'פעולה לא מוכרת.';
    const ids = Array.isArray(b.skills) ? b.skills.map(Number) : [Number(b.skill)];
    const names = [];
    let sum = 0;
    ids.forEach((sid) => {
      const k = M.skillById(sid);
      if (!k) return;
      if (to === 'done') {
        if (doc.acquired[sid]) return;
        const added = M.grantSkill(doc, db.scoring, sid, 'instructor', { first: false, points: b.points !== false && !!u.earns });
        sum += added.reduce((s, e) => s + e.amount, 0);
        doc.flights.forEach((f) => { if (f.skill === sid && f.status === 'review') { f.status = 'approved'; f.reviewedAt = M.stamp(); f.reviewer = me.name; } });
      } else if (to === 'required') {
        if (!doc.acquired[sid]) return;
        sum += M.requireSkill(doc, db.scoring, sid).reduce((s, e) => s + e.amount, 0);
      } else {
        if (!doc.acquired[sid] && !doc.redo[sid]) return;
        if (doc.acquired[sid]) sum += M.revokeSkill(doc, sid).reduce((s, e) => s + e.amount, 0);
        delete doc.redo[sid];
      }
      names.push(k.name);
    });
    if (!names.length) return { changed: 0, coins: 0 };
    const list = names.join(', ');
    if (to === 'done') M.notify(doc, { kind: 'marked', text: 'המדריך שלך סימן כנרכשה: ' + list + (sum ? ' (' + M.sg(sum) + ' מטבעות).' : '.') });
    else if (to === 'required') M.notify(doc, { kind: 'required', text: 'המדריך ביקש ביצוע חוזר: ' + list + '. הגישו טיסה חדשה כשאתם מוכנים.' + (sum ? ' ' + M.sg(sum) + ' מטבעות עד לאישור מחדש.' : '') });
    else M.notify(doc, { kind: 'revoked', text: 'המדריך החזיר לתרגול: ' + list + (sum ? ' (' + M.sg(sum) + ' מטבעות).' : '.') });
    log(me, 'skill', ({ done: 'סימן כנרכשה ל', required: 'ביקש ביצוע חוזר מ', none: 'ביטל ל' })[to] + u.name + ': ' + list, { target: u.id });
    return { changed: names.length, coins: sum };
  },
  setRequest(me, b) {
    const u = findUser(b.id);
    if (!u || u.role !== 'student') return 'הסטודנט לא נמצא.';
    const doc = progressOf(u.id);
    const r = doc.requests.find((x) => x.id === b.request);
    if (!r) return 'הבקשה לא נמצאה.';
    if (['delivered', 'declined'].indexOf(b.status) === -1) return 'פעולה לא מוכרת.';
    if (r.status !== 'pending') return 'הבקשה כבר טופלה.';
    r.status = b.status;
    r.closedAt = M.stamp();
    const p = db.rewards.find((x) => x.id === r.prize);
    const title = p ? p.title : 'הפרס';
    if (b.status === 'delivered') M.notify(doc, { kind: 'reward', reward: r.prize, text: 'הפרס ' + title + ' נמסר לך. תיהנו!' + (p && p.link ? ' הקישור: ' + p.link : '') });
    else M.notify(doc, { kind: 'reward', reward: r.prize, text: 'הבקשה ל' + title + ' לא אושרה, ו־' + r.cost + ' המטבעות חזרו לארנק.' });
    log(me, 'reward', (b.status === 'delivered' ? 'מסר את ' : 'דחה בקשה ל') + title + ' ל' + u.name, { target: u.id });
    return { ok: true };
  },
  saveUnits(me, b) {
    if (!Array.isArray(b.units)) return 'נתונים חסרים.';
    const old = new Map(db.units.map((x) => [x.id, x]));
    const units = b.units.map((x) => ({ id: String(x.id || M.newId('g')).slice(0, 40), name: String(x.name || '').trim().slice(0, 80), type: String(x.type || '').trim().slice(0, 40), parent: String(x.parent || '') })).filter((x) => x.name);
    units.forEach((x) => {
      const o = old.get(x.id);
      if (o && Array.isArray(o.levels) && o.levels.length) x.levels = o.levels;
      if (o && Array.isArray(o.skills) && o.skills.length) x.skills = o.skills;
      if (o && o.ui) x.ui = o.ui;
    });
    const ids = new Set(units.map((x) => x.id));
    units.forEach((x) => { if (!ids.has(x.parent)) x.parent = ''; });
    db.units = units;
    db.users.forEach((u) => { if (u.unit && !ids.has(u.unit)) u.unit = ''; });
    log(me, 'settings', 'עדכן את היחידות');
    return { ok: true };
  },
  // The levels a group learns. An empty list means every level.
  setUnitLevels(me, b) {
    const un = db.units.find((x) => x.id === String(b.unit || ''));
    if (!un) return 'הקבוצה לא נמצאה.';
    const known = new Set(M.LEVELS.map((l) => l.n));
    const levels = Array.from(new Set((Array.isArray(b.levels) ? b.levels : []).map(Number).filter((n) => known.has(n))));
    if (Array.isArray(b.levels) && b.levels.length && !levels.length) return 'לא נבחרו רמות.';
    // The list is kept in the order given: that is the order the group learns the levels in.
    const isDefault = levels.length === known.size && levels.every((n, i) => M.LEVELS[i] && M.LEVELS[i].n === n);
    if (levels.length && !isDefault) un.levels = levels;
    else delete un.levels;
    const names = un.levels ? un.levels.map((n) => (M.LEVELS.find((l) => l.n === n) || {}).name).join(', ') : 'כל הרמות';
    log(me, 'settings', 'שייך ל' + un.name + ' רמות: ' + names);
    return { ok: true };
  },
  // The screen a group's students get: the regular one, the game in one of the themes, or the parent group's choice.
  setUnitUi(me, b) {
    const un = db.units.find((x) => x.id === String(b.unit || ''));
    if (!un) return 'הקבוצה לא נמצאה.';
    const set = setUi(un, String(b.ui || ''));
    if (typeof set === 'string') return set;
    log(me, 'settings', 'המסך של התלמידים ב' + un.name + ': ' + uiName(uiValue(un.ui) || 'inherit'));
    return { ok: true };
  },
  // The design page saves all the themes at once, and which theme (or the regular screen) each group gets.
  saveThemes(me, b) {
    if (!Array.isArray(b.themes)) return 'נתונים חסרים.';
    const list = [];
    b.themes.slice(0, 30).forEach((t) => { const c = cleanTheme(t); if (c && !list.some((x) => x.id === c.id)) list.push(c); });
    Object.keys(BUILTIN_NAMES).forEach((id) => { if (!list.some((t) => t.id === id)) list.push(themeDefaults(id)); });
    db.settings.themes = list;
    const assign = b.assign && typeof b.assign === 'object' ? b.assign : {};
    Object.keys(assign).forEach((uid) => { const un = db.units.find((x) => x.id === uid); if (un) setUi(un, String(assign[uid] || '')); });
    // groups whose theme is gone move to the race theme
    db.units.forEach((u) => { if (u.ui && u.ui !== 'classic' && !themeById(LEGACY_UI[u.ui] || u.ui)) u.ui = 'race'; });
    cleanMedia();
    log(me, 'settings', 'עדכן את עיצוב האתר (' + list.length + ' ערכות נושא)');
    return { ok: true };
  },
  // A background per stage of the game (a level, an exercise, a level's chest, the final exam), and the uploaded images.
  saveStageBg(me, b) {
    const sb = b.assign && typeof b.assign === 'object' ? b.assign : {};
    const assign = {};
    Object.keys(sb).forEach((k) => { if (/^(w\d{1,3}|s\d{1,6}|c\d{1,3}|boss)$/.test(k)) { const v = cleanBg(sb[k]); if (v) assign[k] = v; } });
    db.settings.stageBg = { assign };
    if (Array.isArray(b.lib)) db.settings.bgLib = b.lib.filter((x) => x && imgOk(x.url)).map((x) => ({ url: String(x.url).slice(0, 500), name: String(x.name || 'תמונה').replace(/[<>]/g, '').slice(0, 60) })).slice(0, 80);
    cleanMedia();
    log(me, 'settings', 'עדכן את הרקעים של השלבים במשחק');
    return { ok: true };
  },
  // Points for a whole group at once: every student in it becomes a player (earns) or a student (doesn't).
  setUnitEarns(me, b) {
    const un = db.units.find((x) => x.id === String(b.unit || ''));
    if (!un) return 'הקבוצה לא נמצאה.';
    const earns = !!b.earns;
    let n = 0;
    db.users.forEach((u) => { if (u.role === 'student' && u.unit === un.id && !!u.earns !== earns) { u.earns = earns; n++; } });
    log(me, 'user', (earns ? 'כל התלמידים ב' + un.name + ' צוברים נקודות' : 'התלמידים ב' + un.name + ' לא צוברים נקודות') + ' (' + n + ' עודכנו)');
    return { changed: n };
  },
  // From the curriculum page: put one level or one skill in the chosen groups (and take it out of the others).
  assignToUnits(me, b) {
    const kind = b.kind === 'skill' ? 'skill' : 'level';
    const id = Number(b.ref);
    const known = kind === 'level' ? M.LEVELS.some((l) => l.n === id) : M.ALL_SKILLS.some((k) => k.id === id);
    if (!known) return kind === 'level' ? 'הרמה לא נמצאה.' : 'המיומנות לא נמצאה.';
    const want = new Set((Array.isArray(b.units) ? b.units : []).map(String));
    const field = kind === 'level' ? 'levels' : 'skills';
    db.units.forEach((u) => {
      const had = Array.isArray(u[field]) ? u[field] : [];
      const list = want.has(u.id) && had.indexOf(id) !== -1 ? had.slice() : had.filter((x) => x !== id);
      if (want.has(u.id) && list.indexOf(id) === -1) list.push(id);
      if (list.length) u[field] = kind === 'level' ? list : list.sort((x, y) => x - y);
      else delete u[field];
    });
    const name = kind === 'level' ? (M.LEVELS.find((l) => l.n === id) || {}).name : (M.ALL_SKILLS.find((k) => k.id === id) || {}).name;
    const names = db.units.filter((u) => want.has(u.id)).map((u) => u.name);
    log(me, 'settings', 'שייך את ' + (kind === 'level' ? 'הרמה ' : 'המיומנות ') + name + ' ל' + (names.length ? names.join(', ') : 'אף קבוצה'));
    return { ok: true };
  },
  // Which prizes a group can see and ask for. Updates each prize's own list of groups.
  setUnitRewards(me, b) {
    const unit = String(b.unit || '');
    if (unit !== 'none' && !db.units.some((x) => x.id === unit)) return 'הקבוצה לא נמצאה.';
    const want = new Set((Array.isArray(b.prizes) ? b.prizes : []).map(String));
    const everyGroup = db.units.map((x) => x.id).concat(['none']);
    db.rewards.forEach((p) => {
      const on = want.has(p.id);
      if (p.groups === 'all' || !Array.isArray(p.groups)) {
        if (on) return;
        p.groups = everyGroup.filter((g) => g !== unit);
      } else {
        const set = new Set(p.groups);
        if (on) set.add(unit); else set.delete(unit);
        p.groups = everyGroup.every((g) => set.has(g)) ? 'all' : Array.from(set);
      }
    });
    const un = db.units.find((x) => x.id === unit);
    log(me, 'reward', 'עדכן את הפרסים של ' + (un ? un.name : 'מי שלא ביחידה') + ' (' + want.size + ')');
    return { ok: true };
  },
  saveRewards(me, b) {
    if (!Array.isArray(b.rewards)) return 'נתונים חסרים.';
    db.rewards = b.rewards.map((p) => ({
      id: String(p.id || M.newId('r')).slice(0, 40), title: String(p.title || '').trim().slice(0, 120), desc: String(p.desc || '').slice(0, 1000),
      cost: Math.max(1, Math.trunc(Number(p.cost)) || 1), stock: Math.max(0, Math.trunc(Number(p.stock)) || 0), icon: String(p.icon || 'gift').slice(0, 20),
      groups: p.groups === 'all' || !Array.isArray(p.groups) ? 'all' : p.groups.map(String), active: p.active !== false, link: String(p.link || '').slice(0, 500), image: /^https?:\/\/\S+$/i.test(String(p.image || '').trim()) || /^\/media\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/.test(String(p.image || '').trim()) ? String(p.image).trim().slice(0, 500) : ''
    })).filter((p) => p.title);
    log(me, 'settings', 'עדכן את הפרסים');
    cleanMedia();
    return { ok: true };
  },
  saveCurriculum(me, b) {
    const cur = M.cleanCurriculum(b.curriculum);
    if (typeof cur === 'string') return cur;
    // points of skills and level bonuses saved with the curriculum
    const sc = db.scoring;
    sc.skills = sc.skills || {};
    sc.levelBonus = sc.levelBonus || { on: true };
    const pts = b.points && typeof b.points === 'object' ? b.points : {};
    cur.skills.forEach((k) => {
      const v = pts[k.id];
      if (v != null && Number.isFinite(Number(v))) sc.skills[k.id] = Math.max(0, Math.min(10000, Math.trunc(Number(v))));
      else if (sc.skills[k.id] == null) sc.skills[k.id] = 0;
    });
    const lb = b.levelBonus && typeof b.levelBonus === 'object' ? b.levelBonus : {};
    cur.levels.forEach((l) => {
      const v = lb[l.n];
      if (v != null && Number.isFinite(Number(v))) sc.levelBonus[l.n] = Math.max(0, Math.min(100000, Math.trunc(Number(v))));
      else if (sc.levelBonus[l.n] == null) sc.levelBonus[l.n] = 0;
    });
    db.curriculum = cur;
    M.setCurriculum(cur);
    cleanMedia();
    log(me, 'settings', String(b.note || 'עדכן את תוכנית הלימודים').slice(0, 200));
    return { ok: true };
  },
  // Give a level another number (its place in the path): "level 1 becomes level 3" moves it and renumbers
  // the others. Every stored reference to a level number follows: skills, challenges, level bonuses,
  // the levels a group learns, and level-bonus entries in students' coins.
  moveLevel(me, b) {
    const cur = db.curriculum;
    const from = Number(b.n);
    const to = Math.trunc(Number(b.to));
    const order = cur.levels.slice();
    const i = order.findIndex((l) => l.n === from);
    if (i === -1) return 'הרמה לא נמצאה.';
    if (!(to >= 1 && to <= order.length)) return 'מספר הרמה צריך להיות בין 1 ל־' + order.length + '.';
    if (to === i + 1 && order.every((l, k) => l.n === k + 1)) return { ok: true };
    const [lv] = order.splice(i, 1);
    order.splice(to - 1, 0, lv);
    const map = {};
    order.forEach((l, k) => { map[l.n] = k + 1; });
    const re = (n) => (map[n] != null ? map[n] : n);
    cur.levels = order.map((l) => Object.assign({}, l, { n: re(l.n) }));
    cur.skills.forEach((k) => { k.level = re(k.level); });
    cur.challenges.forEach((c) => { if (c.level != null) c.level = re(c.level); });
    const lb = db.scoring.levelBonus || {};
    const nlb = { on: lb.on };
    Object.keys(lb).forEach((key) => { if (key !== 'on' && map[Number(key)] != null) nlb[map[Number(key)]] = lb[key]; });
    db.scoring.levelBonus = nlb;
    db.units.forEach((u) => { if (Array.isArray(u.levels)) u.levels = u.levels.map(re); });
    Object.keys(db.progress).forEach((uid) => {
      (db.progress[uid].ledger || []).forEach((e) => { if (e.kind === 'level' && e.level != null) e.level = re(e.level); });
      if (Array.isArray(db.progress[uid].chests)) db.progress[uid].chests = db.progress[uid].chests.map(re);
    });
    M.setCurriculum(cur);
    log(me, 'settings', 'הרמה ' + lv.name + ' היא עכשיו רמה ' + to);
    return { ok: true };
  },
  saveAi(me, b) {
    const a = db.settings.ai;
    const t = Math.trunc(Number(b.threshold));
    const lim = Math.trunc(Number(b.dailyLimit));
    if (!(t >= 50 && t <= 100)) return 'רמת הביטחון צריכה להיות בין 50 ל־100.';
    if (!(lim >= 1 && lim <= 5000)) return 'המגבלה היומית צריכה להיות בין 1 ל־5,000.';
    if (b.enabled && !AI.hasKey()) return 'קודם מוסיפים את המפתח GEMINI_API_KEY בהגדרות של Render (Environment), ואז מפעילים.';
    const was = a.enabled;
    a.enabled = !!b.enabled;
    a.mode = b.mode === 'auto' ? 'auto' : 'suggest';
    a.threshold = t;
    a.autoReject = !!b.autoReject;
    a.extra = String(b.extra || '').trim().slice(0, 1500);
    a.model = String(b.model || '').trim().replace(/[^A-Za-z0-9._\/-]/g, '').slice(0, 80);
    a.dailyLimit = lim;
    log(me, 'settings', 'עדכן את בדיקת ה־AI: ' + (a.enabled ? (a.mode === 'auto' ? 'פעילה, מחליטה לבד' : 'פעילה, ממליצה בלבד') : 'כבויה'));
    if (a.enabled && !was) queueWaiting();
    return { ok: true };
  },
  // Clears AI check records from the "recent checks" list: chosen ones, or all of them.
  // Only the record goes; a decision the AI already applied (approved or sent back) stays as it is.
  aiClear(me, b) {
    const pick = Array.isArray(b.items) ? b.items.slice(0, 1000) : [];
    if (!b.all && !pick.length) return 'לא נבחרו בדיקות למחיקה.';
    const want = new Set(pick.map((x) => String(x && x.user) + '|' + String(x && x.flight)));
    let n = 0;
    db.users.filter((u) => u.role === 'student').forEach((u) => {
      (progressOf(u.id).flights || []).forEach((f) => {
        if (!f.ai || !(b.all || want.has(u.id + '|' + f.id))) return;
        if (f.ai.status === 'checking') return; // a check that is running now finishes first
        const q = aiQueue.findIndex((j) => j.fid === f.id);
        if (q !== -1) aiQueue.splice(q, 1);
        delete f.ai;
        n++;
      });
    });
    if (!n) return 'אין מה למחוק: הבדיקות שבחרתם כבר נמחקו או רצות עכשיו.';
    log(me, 'settings', 'מחק ' + (n === 1 ? 'בדיקת AI אחת' : n + ' בדיקות AI') + ' מהרשימה');
    save();
    return { ok: true, count: n };
  },
  aiRecheck(me, b) {
    const u = findUser(b.id);
    if (!u || u.role !== 'student') return 'הסטודנט לא נמצא.';
    const f = progressOf(u.id).flights.find((x) => x.id === b.flight);
    if (!f) return 'הטיסה לא נמצאה.';
    if (f.status !== 'review') return 'אפשר לבדוק שוב רק טיסה שממתינה לבדיקה.';
    if (!AI.hasKey()) return 'חסר המפתח GEMINI_API_KEY בהגדרות של Render.';
    if (!enqueue(u.id, f, true)) return 'לטיסה הזו אין סרטון ש־AI יכול לפתוח (קובץ שהועלה או קישור YouTube ציבורי).';
    log(me, 'flight', 'שלח לבדיקת AI חוזרת את הטיסה של ' + u.name, { target: u.id });
    return { ok: true };
  },
  saveSettings(me, b) {
    // 0 = delete the video as soon as the flight has been reviewed.
    const days = Math.trunc(Number(b.videoDays));
    if (!(days >= 0 && days <= 365)) return 'מספר הימים צריך להיות בין 1 ל־365.';
    db.settings.videoDays = days;
    log(me, 'settings', days === 0 ? 'סרטוני טיסה נמחקים מיד אחרי הבדיקה' : 'סרטוני טיסה נשמרים ' + days + ' ימים אחרי הבדיקה');
    cleanFlightVideos();
    return { ok: true };
  },
  saveScoring(me, b) {
    if (!b.scoring || typeof b.scoring !== 'object' || !b.scoring.rules) return 'נתונים חסרים.';
    db.scoring = b.scoring;
    log(me, 'settings', 'עדכן את הגדרות הניקוד');
    return { ok: true };
  }
};

// Sets a group's screen: 'inherit' (its parent's choice), 'classic', or a theme id.
function setUi(un, ui) {
  const id = LEGACY_UI[ui] || ui;
  if (id === 'inherit' || (id === 'classic' && !un.parent)) { delete un.ui; return true; }
  if (id === 'classic' || themeById(id)) { un.ui = STORED_UI[id] || id; return true; }
  return 'בחירה לא מוכרת.';
}
function uiName(v) {
  if (v === 'inherit') return 'כמו בקבוצת האם';
  if (v === 'classic') return 'המסך הרגיל';
  const t = themeById(v);
  return t ? 'משחק · ' + t.name : v;
}

function roleName(r) {
  return { admin: 'מנהל', observer: 'משקיף', student: 'סטודנט' }[r] || r;
}

// ---------- server ----------
// ---------- uploaded videos ----------
function freeBytes() {
  try {
    const st = fs.statfsSync(MEDIA_DIR);
    return Number(st.bavail) * Number(st.bsize);
  } catch (e) {
    return Infinity;
  }
}

// The admin's browser sends the file as is; it is written to a temporary name and renamed when complete.
function upload(req, res, user, opts) {
  opts = opts || {};
  const max = opts.max || MAX_UPLOAD;
  const name = decodeURIComponent(String(req.headers['x-file-name'] || 'video.mp4'));
  const ext = path.extname(name).toLowerCase();
  if (opts.image) {
    if (!IMAGE_TYPES[ext]) return json(res, 400, { error: 'אפשר להעלות תמונות מסוג JPG, PNG, WEBP או GIF.' });
  } else if (!VIDEO_TYPES[ext]) return json(res, 400, { error: 'אפשר להעלות סרטונים מסוג MP4, MOV, M4V או WEBM.' });
  const size = Number(req.headers['content-length']) || 0;
  if (!size) return json(res, 411, { error: 'הקובץ ריק.' });
  if (size > max) return json(res, 413, { error: 'הקובץ גדול מדי. אפשר עד ' + Math.round(max / 1048576) + ' מגה־בייט. כדאי לקצר את הסרטון, או להעלות אותו ל־YouTube ולהדביק קישור.' });
  if (size > freeBytes() - 50 * 1048576) return json(res, 507, { error: opts.owner ? 'אין כרגע מקום לסרטונים באתר. העלו את הסרטון ל־YouTube או ל־Google Drive והדביקו קישור, ועדכנו את המדריך.' : 'אין מספיק מקום בדיסק. מגדילים את ה־Disk ב־Render (Disk ← Size), או מעלים את הסרטון ל־YouTube ומדביקים קישור.' });
  const id = (opts.owner ? 'f' : opts.image ? 'i' : 'v') + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const tmp = path.join(MEDIA_DIR, id + '.part');
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let failedUpload = false;
  const fail = (code, msg) => {
    if (failedUpload) return;
    failedUpload = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    try { json(res, code, { error: msg }); } catch (e) {}
  };
  req.on('data', (c) => {
    got += c.length;
    if (got > max || got > size) { fail(413, 'הקובץ גדול מדי.'); req.destroy(); }
  });
  req.on('aborted', () => fail(400, 'ההעלאה הופסקה.'));
  req.pipe(out);
  out.on('error', () => fail(500, 'שמירת הקובץ נכשלה. אולי הדיסק מלא.'));
  out.on('finish', () => {
    if (failedUpload) return;
    if (got !== size) return fail(400, 'ההעלאה לא הושלמה. נסו שוב.');
    const final = id + ext;
    fs.rename(tmp, path.join(MEDIA_DIR, final), (err) => {
      if (err) return fail(500, 'שמירת הקובץ נכשלה.');
      if (opts.owner) db.uploads[final] = { uid: user.id, at: Date.now(), size: got };
      else log(user, 'settings', (opts.image ? 'העלה תמונה: ' : 'העלה סרטון: ') + name.slice(0, 80));
      save();
      json(res, 200, { url: '/media/' + final, name: name.slice(0, 120), size: got });
    });
  });
}

// Plays a video, with byte ranges so the player can jump around.
function sendMedia(req, res, name, user) {
  if (!/^[A-Za-z0-9_-]+\.(mp4|m4v|mov|webm|jpg|jpeg|png|webp|gif)$/.test(name)) return send(res, 404, 'Not found');
  const up = db.uploads[name];
  if (up && user.role !== 'admin' && up.uid !== user.id) return send(res, 403, 'Forbidden');
  const full = path.join(MEDIA_DIR, name);
  let st;
  try { st = fs.statSync(full); } catch (e) { return send(res, 404, 'Not found'); }
  const type = VIDEO_TYPES[path.extname(name).toLowerCase()] || IMAGE_TYPES[path.extname(name).toLowerCase()];
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  const head = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' };
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(st.size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    res.writeHead(206, Object.assign(head, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 }));
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, Object.assign(head, { 'Content-Length': st.size }));
  fs.createReadStream(full).pipe(res);
}

// Uploaded videos no skill or challenge uses any more (older than a day, so a fresh upload not yet saved stays).
function cleanMedia() {
  const used = new Set();
  const cur = db.curriculum || { skills: [], challenges: [] };
  cur.skills.concat(cur.challenges).forEach((x) => { if (x.video && x.video.startsWith('/media/')) used.add(x.video.slice(7)); });
  (db.rewards || []).forEach((r) => { if (r.image && r.image.startsWith('/media/')) used.add(r.image.slice(7)); });
  // images of the game's look: theme backgrounds, stage backgrounds and the uploaded-images library
  const st = db.settings || {};
  (st.themes || []).forEach((t) => { if (t.bg && t.bg.kind === 'img' && String(t.bg.url).startsWith('/media/')) used.add(t.bg.url.slice(7)); });
  const sb = (st.stageBg && st.stageBg.assign) || {};
  Object.keys(sb).forEach((k) => { const v = String(sb[k].bg || ''); if (v.startsWith('img:/media/')) used.add(v.slice(11)); });
  (st.bgLib || []).forEach((x) => { if (String(x.url).startsWith('/media/')) used.add(x.url.slice(7)); });
  fs.readdir(MEDIA_DIR, (err, files) => {
    if (err) return;
    files.forEach((f) => {
      if (used.has(f) || db.uploads[f]) return;
      const full = path.join(MEDIA_DIR, f);
      fs.stat(full, (e, st) => { if (!e && Date.now() - st.mtimeMs > 864e5) fs.rm(full, { force: true }, () => {}); });
    });
  });
}

// Students' flight videos are kept until the instructor has looked at them, and for a while after: then the file
// goes and the flight keeps its status and feedback. Uploads no flight uses go after a day.
function cleanFlightVideos() {
  const set = Number(db.settings.videoDays);
  const days = Number.isFinite(set) && set >= 0 ? set : 14;
  const limit = Date.now() - days * 864e5;
  const used = new Set();
  let changed = false;
  Object.keys(db.progress).forEach((uid) => {
    (db.progress[uid].flights || []).forEach((f) => {
      const name = f.link && f.link.startsWith('/media/') ? f.link.slice(7) : '';
      if (!name || !db.uploads[name]) return;
      const done = f.status === 'approved' || f.status === 'rejected' || f.status === 'cancelled';
      const at = Date.parse(String(f.reviewedAt || f.at || '').replace(' ', 'T') + ':00+03:00') || 0;
      if (done && (days === 0 || (at && at < limit))) {
        fs.rm(path.join(MEDIA_DIR, name), { force: true }, () => {});
        delete db.uploads[name];
        f.link = '';
        f.videoGone = true;
        changed = true;
      } else used.add(name);
    });
  });
  Object.keys(db.uploads).forEach((name) => {
    if (used.has(name)) return;
    if (Date.now() - db.uploads[name].at > 864e5) {
      fs.rm(path.join(MEDIA_DIR, name), { force: true }, () => {});
      delete db.uploads[name];
      changed = true;
    }
  });
  if (changed) save();
}

// ---------- AI checks ----------
// A student's view of their progress: everything, except the AI's notes meant for the instructor.
function studentView(doc) {
  if (!doc.flights.some((f) => f.ai)) return doc;
  const copy = Object.assign({}, doc, { flights: doc.flights.map((f) => {
    if (!f.ai) return f;
    const ai = Object.assign({}, f.ai);
    delete ai.notes;
    delete ai.error;
    delete ai.checks;
    return Object.assign({}, f, { ai });
  }) });
  return copy;
}

const aiQueue = [];
let aiBusy = false;
const AI_USER = { id: 'ai', name: 'בדיקת AI', role: 'admin', ai: true };

function videoSource(f) {
  if (f.link && f.link.startsWith('/media/') && db.uploads[f.link.slice(7)]) return { file: path.join(MEDIA_DIR, f.link.slice(7)) };
  const yt = AI.youtubeUrl(f.link);
  return yt ? { youtube: yt } : null;
}

// the instructor's demo video of the exercise (or challenge), so the AI can see the right map and exercise
function refSource(x) {
  const v = x && x.video ? String(x.video) : '';
  if (v.startsWith('/media/')) { const full = path.join(MEDIA_DIR, path.basename(v.slice(7))); return fs.existsSync(full) ? { refFile: full } : {}; }
  const yt = AI.youtubeUrl(v);
  return yt ? { refYoutube: yt } : {};
}

function aiWanted(f) {
  if (f.challenge) return true;
  const k = M.skillById(f.skill);
  return !!k && k.aiCheck !== false;
}

function enqueue(uid, f, force) {
  if (!videoSource(f)) { f.ai = { status: 'skipped', reason: 'link', at: M.stamp() }; return false; }
  if (!force && !aiWanted(f)) return false;
  if (aiQueue.some((j) => j.fid === f.id)) return true;
  f.ai = { status: 'queued', at: M.stamp() };
  aiQueue.push({ uid, fid: f.id });
  setImmediate(runAi);
  return true;
}

function queueNewFlights(uid, events) {
  if (!db.settings.ai.enabled || !AI.hasKey()) return;
  const doc = progressOf(uid);
  events.filter((e) => e.kind === 'flight' && e.ref).forEach((e) => {
    const f = doc.flights.find((x) => x.id === e.ref);
    if (f && f.status === 'review') enqueue(uid, f, false);
  });
  save();
}

// When the check is turned on, flights already waiting (and checks cut off by a restart) go in line.
function queueWaiting() {
  if (!db.settings.ai.enabled || !AI.hasKey()) return;
  Object.keys(db.progress).forEach((uid) => {
    (db.progress[uid].flights || []).forEach((f) => {
      if (f.status !== 'review') return;
      if (!f.ai || f.ai.status === 'queued' || f.ai.status === 'checking') enqueue(uid, f, false);
    });
  });
  save();
}

async function runAi() {
  if (aiBusy) return;
  aiBusy = true;
  try {
    while (aiQueue.length) {
      const job = aiQueue.shift();
      await checkOne(job).catch((e) => console.error('AI check failed:', e.message));
    }
  } finally {
    aiBusy = false;
  }
}

async function checkOne(job) {
  const set = db.settings.ai;
  const find = () => (db.progress[job.uid] || { flights: [] }).flights.find((x) => x.id === job.fid);
  let f = find();
  if (!f || f.status !== 'review') return;
  const today = M.today();
  if (db.aiUsage.day !== today) db.aiUsage = { day: today, count: 0 };
  if (db.aiUsage.count >= set.dailyLimit) { f.ai = { status: 'skipped', reason: 'limit', at: M.stamp() }; save(); return; }
  const src = videoSource(f);
  if (!src) { f.ai = { status: 'skipped', reason: 'link', at: M.stamp() }; save(); return; }
  const c = f.challenge ? M.challengeById(f.challenge) : null;
  const k = f.challenge ? null : M.skillById(f.skill);
  if (!c && !k) { f.ai = { status: 'skipped', reason: 'gone', at: M.stamp() }; save(); return; }
  f.ai = { status: 'checking', at: M.stamp() };
  db.aiUsage.count++;
  save();
  let result;
  try {
    result = await AI.check(Object.assign({}, src, refSource(c || k), {
      skillName: c ? 'אתגר: ' + c.title : k.name,
      desc: c ? c.desc : k.desc,
      pass: c ? c.desc : k.pass,
      map: k ? k.map : '',
      note: f.note,
      extra: set.extra,
      model: set.model
    }));
  } catch (e) {
    f = find();
    if (f) { f.ai = { status: 'error', error: String(e.message || e).slice(0, 300), at: M.stamp() }; save(); }
    return;
  }
  f = find();
  if (!f) return;
  f.ai = Object.assign({ status: 'done', at: M.stamp() }, result);
  const u = findUser(job.uid);
  const sure = result.confidence >= set.threshold;
  if (f.status === 'review' && set.enabled && set.mode === 'auto' && sure && u) {
    if (result.verdict === 'pass') {
      ADMIN_ACTIONS.reviewFlight(AI_USER, { id: u.id, flight: f.id, approve: true, feedback: result.feedback });
      f.ai.applied = 'approved';
    } else if (result.verdict === 'fail' && set.autoReject) {
      ADMIN_ACTIONS.reviewFlight(AI_USER, { id: u.id, flight: f.id, approve: false, feedback: result.feedback });
      f.ai.applied = 'rejected';
    }
  }
  save();
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  let p = decodeURIComponent(url.pathname);
  const user = currentUser(req);
  if (user) {
    const now = M.stamp();
    if (user.lastSeen !== now) { user.lastSeen = now; save(); }
  }

  // ---- api ----
  if (p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.headers['x-academy'] !== '1') return json(res, 403, { error: 'בקשה לא מורשית.' });
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const username = cleanUsername(b.username).toLowerCase();
      const key = (req.socket.remoteAddress || '') + '|' + username;
      if (tooMany(key)) return json(res, 429, { error: 'יותר מדי ניסיונות. נסו שוב בעוד דקה.' });
      const u = db.users.find((x) => x.username.toLowerCase() === username);
      if (!u || u.disabled || !checkPassword(u, b.password || '')) {
        failed(key);
        return json(res, 401, { error: 'שם המשתמש או הסיסמה שגויים.' });
      }
      attempts.delete(key);
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_DAYS * 864e5 };
      u.lastLogin = M.stamp();
      log(u, 'login', 'נכנס למערכת', who(req));
      save();
      return json(res, 200, { home: homeFor(u) }, { 'Set-Cookie': sessionCookie(token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const token = cookies(req)[COOKIE];
      const ses = token && db.sessions[token];
      const lu = ses ? db.users.find((x) => x.id === ses.uid) : null;
      if (lu) log(lu, 'logout', 'יצא מהמערכת', who(req));
      if (token) delete db.sessions[token];
      save();
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (!user) return json(res, 401, { error: 'צריך להתחבר מחדש.' });
    if (p === '/api/boot' && req.method === 'GET') return json(res, 200, bootFor(user));
    if (p === '/api/password' && req.method === 'POST') {
      const b = await readBody(req).catch(() => ({}));
      const next = String(b.password || '');
      if (next.length < 8) return json(res, 400, { error: 'הסיסמה צריכה להכיל לפחות 8 תווים.' });
      if (user.envAdmin) return json(res, 400, { error: 'את הסיסמה של המנהל הראשי משנים בהגדרות של Render.' });
      if (!user.mustChange && !checkPassword(user, b.current || '')) return json(res, 400, { error: 'הסיסמה הנוכחית שגויה.' });
      const h = hashPassword(next);
      user.passSalt = h.salt;
      user.passHash = h.hash;
      user.mustChange = false;
      log(user, 'user', 'בחר סיסמה חדשה');
      save();
      return json(res, 200, { home: homeFor(user) });
    }
    if (p === '/api/progress' && req.method === 'PUT') {
      if (user.role !== 'student') return json(res, 403, { error: 'רק סטודנטים.' });
      const b = await readBody(req).catch(() => null);
      if (!b) return json(res, 400, { error: 'נתונים שגויים.' });
      const ctx = { scoring: db.scoring, rewards: db.rewards, unit: user.unit, earns: !!user.earns, stockLeft, ownsMedia: (link) => { const u = db.uploads[String(link).slice(7)]; return String(link).startsWith('/media/') && !!u && u.uid === user.id; } };
      const out = M.scoped(levelsFor(user), () => M.acceptStudent(progressOf(user.id), b.progress, ctx));
      db.progress[user.id] = out.doc;
      out.events.forEach((e) => log(user, e.kind, e.text, { target: user.id, ref: e.ref }));
      save();
      queueNewFlights(user.id, out.events);
      return json(res, 200, { progress: studentView(out.doc), rewards: db.rewards.map((x) => Object.assign({}, x, { left: stockLeft(x.id) })), scoring: db.scoring, today: M.today() });
    }
    if (p === '/api/upload/flight' && req.method === 'POST') {
      if (user.role !== 'student') return json(res, 403, { error: 'רק סטודנטים.' });
      return upload(req, res, user, { max: MAX_FLIGHT, owner: user.id });
    }
    if (p === '/api/admin/upload-image' && req.method === 'POST') {
      if (user.role !== 'admin') return json(res, 403, { error: 'רק מנהלים.' });
      return upload(req, res, user, { image: true, max: MAX_IMAGE });
    }
    if (p === '/api/admin/upload' && req.method === 'POST') {
      if (user.role !== 'admin') return json(res, 403, { error: 'רק מנהלים.' });
      return upload(req, res, user);
    }
    if (p.startsWith('/api/admin/') && req.method === 'POST') {
      if (user.role !== 'admin') return json(res, 403, { error: 'רק מנהלים.' });
      const action = ADMIN_ACTIONS[p.slice('/api/admin/'.length)];
      if (!action) return json(res, 404, { error: 'פעולה לא מוכרת.' });
      const b = await readBody(req).catch(() => null);
      if (!b) return json(res, 400, { error: 'נתונים שגויים.' });
      // Actions on one student run with that student's group levels.
      const tgt = b && b.id ? findUser(b.id) : null;
      const out = tgt && tgt.role === 'student' ? M.scoped(levelsFor(tgt), () => action(user, b)) : action(user, b);
      if (typeof out === 'string') return json(res, 400, { error: out });
      if (Number(db.settings.videoDays) === 0) cleanFlightVideos();
      save();
      return json(res, 200, Object.assign({ result: out }, { boot: bootFor(user) }));
    }
    if (p === '/api/league' && req.method === 'GET') {
      if (user.role !== 'student') return json(res, 403, { error: 'רק סטודנטים.' });
      return json(res, 200, leagueFor(user));
    }
    if (p === '/api/intro-seen' && req.method === 'POST') {
      if (user.role === 'student') {
        const doc = progressOf(user.id);
        if (!doc.introSeen) { doc.introSeen = true; log(user, 'user', 'קרא את ההסבר על הלמידה באפליקציה'); save(); }
      }
      return json(res, 200, { ok: true });
    }
    if (p === '/api/viewed' && req.method === 'POST') {
      if (user.role === 'observer') {
        const un = db.units.find((x) => x.id === user.unit);
        const last = db.activity.find((e) => e.uid === user.id && e.kind === 'eye');
        if (!last || String(last.at).slice(0, 10) !== M.today()) { log(user, 'eye', 'צפה בנתוני ' + (un ? un.name : 'הקבוצה')); save(); }
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'לא נמצא.' });
  }

  // ---- password page ----
  if (p === '/password') {
    if (!user) return redirect(res, '/Login.dc.html');
    if (user.envAdmin) return send(res, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><body dir="rtl" style="font-family:system-ui,sans-serif;padding:32px;line-height:1.6">את הסיסמה של המנהל הראשי משנים ב־Render: Environment ← ADMIN_PASSWORD, ואז שמירה. <a href="/Main.dc.html">חזרה</a></body>', { 'Content-Type': TYPES['.html'] });
    if (req.method === 'POST') {
      const f = await readForm(req);
      if (!user.mustChange) {
        if (tooMany('pw:' + user.id)) return send(res, 200, passwordPage(user, 'יותר מדי ניסיונות. נסו שוב בעוד דקה.'), { 'Content-Type': TYPES['.html'] });
        if (!checkPassword(user, f.p0 || '')) { failed('pw:' + user.id); return send(res, 200, passwordPage(user, 'הסיסמה הנוכחית לא נכונה.'), { 'Content-Type': TYPES['.html'] }); }
      }
      if (!f.p1 || f.p1.length < 8) return send(res, 200, passwordPage(user, 'הסיסמה צריכה להכיל לפחות 8 תווים.'), { 'Content-Type': TYPES['.html'] });
      if (f.p1 !== f.p2) return send(res, 200, passwordPage(user, 'שתי הסיסמאות לא זהות.'), { 'Content-Type': TYPES['.html'] });
      const h = hashPassword(f.p1);
      user.passSalt = h.salt;
      user.passHash = h.hash;
      user.mustChange = false;
      log(user, 'user', 'בחר סיסמה חדשה');
      save();
      return redirect(res, homeFor(user));
    }
    return send(res, 200, passwordPage(user, ''), { 'Content-Type': TYPES['.html'] });
  }

  // ---- pages and files ----
  if (p === '/' || p === '/index.html') return redirect(res, homeFor(user));
  if (p === '/logout') {
    const token = cookies(req)[COOKIE];
    if (token) {
      if (user) log(user, 'logout', 'יצא מהמערכת', who(req));
      delete db.sessions[token];
      save();
    }
    return redirect(res, '/Login.dc.html', { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (p.startsWith('/media/')) {
    if (!user) return send(res, 401, 'Sign in');
    return sendMedia(req, res, p.slice('/media/'.length), user);
  }
  const file = path.normalize(p).replace(/^[/\\]+/, '');
  if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) return send(res, 404, 'Not found');
  const full = path.join(PUBLIC, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, 'Not found');

  if (file.endsWith('.dc.html') || PLAIN_PAGES.has(file)) {
    if (file === 'Login.dc.html') {
      if (user && req.headers['sec-fetch-dest'] === 'document') return redirect(res, homeFor(user));
      return send(res, 200, boardHtml(file, null), { 'Content-Type': TYPES['.html'] });
    }
    if (!user) return req.headers['sec-fetch-dest'] === 'document' || !req.headers['sec-fetch-dest'] ? redirect(res, '/Login.dc.html') : send(res, 401, 'Sign in');
    if (user.mustChange) return redirect(res, '/password');
    // the admin sees the game only as a preview, inside the design page
    if (file === 'Game.html' && user.role === 'admin') {
      if (url.searchParams.get('preview') !== '1') return redirect(res, '/Studio.html');
      return send(res, 200, boardHtml(file, user, previewBoot(String(url.searchParams.get('unit') || ''), String(url.searchParams.get('theme') || ''))), { 'Content-Type': TYPES['.html'] });
    }
    if (!mayOpen(user, file)) return redirect(res, homeFor(user));
    return send(res, 200, boardHtml(file, user), { 'Content-Type': TYPES['.html'] });
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const cache = file === 'support.js' || file === 'favicon.svg' ? 'public, max-age=3600' : 'no-cache';
  res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': cache });
  fs.createReadStream(full).pipe(res);
}

load();
cleanFlightVideos();
queueWaiting();
setInterval(cleanFlightVideos, 3600e3).unref();
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    try { json(res, 500, { error: 'שגיאה בשרת. נסו שוב.' }); } catch (e) {}
  });
});
// Big flight videos from a phone on a slow connection can take a while: allow up to an hour per request (Node's default stops at 5 minutes).
server.requestTimeout = 60 * 60 * 1000;
server.listen(PORT, () => console.log('88ACADEMY on port ' + PORT + (PROD ? '' : ' (dev: admin / admin1234)')));
