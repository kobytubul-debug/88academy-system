'use strict';
// The academy's rules, shared by the server: the curriculum, coins for skills and levels, and what a student may
// change in their own progress. The screens show the same numbers through public/academy.js.

// The curriculum lives in the data file and the admin edits it. These lists always hold the current one:
// LEVELS (in order), SKILLS (the active skills, in order: they make up the path), ALL_SKILLS (inactive ones too,
// for names in old flights and coins), CHALLENGES (the active challenges).
const LEVELS = [];
const SKILLS = [];
const ALL_SKILLS = [];
const CHALLENGES = [];
const ALL_CHALLENGES = [];

// The curriculum a new academy starts with.
function curriculumDefaults() {
  const levels = [
    { n: 1, name: 'אבני יסוד', desc: 'תרגילים למטיסים מתחילים' },
    { n: 2, name: 'תרגילי קורס פרופלור', desc: '' },
    { n: 3, name: 'תרגילים מתקדמים', desc: 'שלב זה כולל מספר תרגילים מתקדמים שיאפשרו לכם להתמקצע ביכולות הטסה מתקדמות ושליטה טובה יותר.' }
  ];
  const s = (id, level, name, desc, pass, extra) => Object.assign({ id, level, order: 0, name, desc, pass, map: '', caption: '', video: '', showVideo: true, active: true }, extra || {});
  const skills = [
    s(1, 1, 'שמירה על גובה', 'שמירה על גובה של 15-20 מטר מהקרקע', 'יש לשמור על גובה של 15-20 מטר מעל פני השטח.', { map: 'STRAW BALE', caption: 'יש לשמור על גובה של 15-20 מטר מעל פני השטח, אין לנחות כלל' }),
    s(2, 1, 'טיסה בקו ישר', 'טיסה ישרה ויציבה לאורך המסלול, בלי לסטות הצידה.', 'יש לטוס בקו ישר מתחילת המסלול ועד סופו ולשמור על גובה קבוע.'),
    s(3, 1, 'האטה ובלימה', 'האטה מבוקרת ועצירה מעל נקודה מסומנת.', 'יש להאט ולעצור מעל נקודת הסיום בלי לחצות אותה.'),
    s(4, 1, 'סללום ימינה ושמאלה', 'מעבר בין עמודים לסירוגין, מימין ומשמאל.', 'יש לעבור את כל העמודים לסירוגין בלי לדלג על אף אחד.'),
    s(5, 1, 'שינוי גובה', 'עלייה וירידה מבוקרות בין שני גבהים.', 'יש לעלות ולרדת בין שני גבהים בתנועה רציפה ויציבה, בלי לאבד כיוון.'),
    s(6, 1, 'פניות', 'פניות חלקות ימינה ושמאלה סביב נקודת ציון.', 'יש להשלים פנייה מלאה סביב העמוד בלי לאבד גובה.'),
    s(7, 1, 'שמיניות', 'טיסה בצורת הספרה 8 סביב שני עמודים.', 'יש להשלים שתי שמיניות רצופות סביב העמודים.'),
    s(8, 2, 'עינוי סיני', 'רצף תרגילי שליטה עדינים במרחב צפוף.', 'יש להשלים את כל הרצף בלי לגעת במכשולים.'),
    s(9, 2, 'מסלול', 'הקפת נקודה תוך שמירה על המצלמה מכוונת אליה.', 'יש להשלים הקפה מלאה כשהנקודה במרכז התמונה.'),
    s(10, 2, 'נחיתות', 'נחיתה רכה ומבוקרת על משטח הנחיתה.', 'יש לנחות בתוך המשטח בלי הקפצה.'),
    s(11, 2, 'צלילות', 'צלילה מגובה וחזרה לטיסה ישרה.', 'יש לצלול ולהתיישר מעל הקרקע בגובה בטוח.'),
    s(12, 2, 'מדרגות', 'טיסה לאורך גרם מדרגות.', 'יש לעבור את כל המדרגות בלי לגעת בהן.'),
    s(13, 2, 'צינורות', 'מעבר דרך צינורות בלי לגעת בדפנות.', 'יש לעבור את כל הצינורות ברצף.'),
    s(14, 3, 'נחיתות מדויקות', 'נחיתה על מטרה קטנה ממרחק.', 'יש לנחות בתוך המטרה המסומנת.'),
    s(15, 3, 'ירידה במדרגות', 'ירידה מבוקרת לאורך גרם מדרגות.', 'יש לרדת לאורך כל המדרגות בקצב קבוע.'),
    s(16, 3, 'פיגומים', 'מעבר בין קומות של פיגום.', 'יש לעבור דרך כל הקומות לפי הסדר.'),
    s(17, 3, 'עליית מדרגות - שמאל', 'עלייה לאורך מדרגות בפנייה שמאלה.', 'יש לעלות את כל המדרגות בלי לגעת בקירות.'),
    s(18, 3, 'סיבוב 360 בפיר מעלית', 'סיבוב מלא בתוך פיר מעלית צר.', 'יש להשלים סיבוב מלא בלי לגעת בדפנות הפיר.'),
    s(19, 3, 'מעבר בתוך המנוף', 'מעבר דרך מבנה המנוף.', 'יש לעבור את המנוף מקצה לקצה.'),
    s(20, 3, 'שמיניות קצרות', 'שמיניות הדוקות במרחב קטן.', 'יש להשלים שתי שמיניות הדוקות ברצף.')
  ];
  skills.forEach((k) => { k.order = skills.filter((x) => x.level === k.level && x.id < k.id).length + 1; });
  return { levels, skills, challenges: [] };
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}
function url(v) {
  const t = str(v, 500);
  if (/^\/media\/[A-Za-z0-9_-]+\.(mp4|m4v|mov|webm)$/.test(t)) return t;
  return /^https?:\/\/\S+$/i.test(t) ? t : '';
}

// Cleans a curriculum sent by the admin screen and puts it in the lists above. Returns the clean copy, or a
// message when something is wrong.
function cleanCurriculum(cur) {
  if (!cur || !Array.isArray(cur.levels) || !Array.isArray(cur.skills)) return 'נתונים חסרים.';
  const levels = [];
  cur.levels.forEach((l) => {
    const n = Math.trunc(Number(l && l.n));
    if (!(n >= 1 && n <= 99) || levels.some((x) => x.n === n)) return;
    const name = str(l.name, 80);
    if (!name) return;
    levels.push({ n, name, desc: str(l.desc, 600) });
  });
  if (!levels.length) return 'צריך לפחות רמה אחת.';
  levels.sort((a, b) => a.n - b.n);
  const skills = [];
  cur.skills.forEach((k) => {
    const id = Math.trunc(Number(k && k.id));
    if (!(id >= 1 && id <= 100000) || skills.some((x) => x.id === id)) return;
    const name = str(k.name, 80);
    if (!name) return;
    const level = levels.some((l) => l.n === Number(k.level)) ? Number(k.level) : levels[0].n;
    skills.push({
      id, level, order: Math.max(0, Math.trunc(Number(k.order)) || 0), name, desc: str(k.desc, 1000), pass: str(k.pass, 1000),
      map: str(k.map, 80), caption: str(k.caption, 300), video: url(k.video), showVideo: k.showVideo !== false, active: k.active !== false, aiCheck: k.aiCheck !== false
    });
  });
  const challenges = [];
  (Array.isArray(cur.challenges) ? cur.challenges : []).forEach((c) => {
    const id = str(c && c.id, 40);
    const title = str(c && c.title, 120);
    if (!id || !title || challenges.some((x) => x.id === id)) return;
    const level = levels.some((l) => l.n === Number(c.level)) ? Number(c.level) : levels[0].n;
    const ends = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(str(c.ends, 16)) ? str(c.ends, 16) : '';
    const final = !!c.final && !challenges.some((x) => x.final);
    challenges.push({ id, title, desc: str(c.desc, 1000), level, ends, points: Math.max(0, Math.min(100000, Math.trunc(Number(c.points)) || 0)), video: url(c.video), active: c.active !== false, final });
  });
  return { levels, skills, challenges };
}

function setCurriculum(cur) {
  const fill = (arr, items) => { arr.length = 0; items.forEach((x) => arr.push(x)); };
  const rank = {};
  cur.levels.forEach((l, i) => { rank[l.n] = i; });
  const sorted = cur.skills.slice().sort((a, b) => (rank[a.level] - rank[b.level]) || (a.order - b.order) || (a.id - b.id));
  fill(LEVELS, cur.levels);
  fill(ALL_SKILLS, sorted);
  fill(SKILLS, sorted.filter((k) => k.active));
  fill(ALL_CHALLENGES, cur.challenges);
  fill(CHALLENGES, cur.challenges.filter((c) => c.active));
}
setCurriculum(curriculumDefaults());

function skillById(id) {
  return ALL_SKILLS.find((k) => k.id === Number(id)) || null;
}
function challengeById(id) {
  return ALL_CHALLENGES.find((c) => c.id === id) || null;
}

function scoringDefaults() {
  return {
    v: 1,
    rules: {
      login: { on: true, points: 5 },
      streak3: { on: true, points: 10 },
      streak7: { on: true, points: 30 },
      time: { on: true, points: 5, minutes: 10, max: 3 },
      video: { on: true, points: 5 },
      first: { on: true, points: 10 },
      quests: { on: true, points: 15 }
    },
    levelBonus: { on: true, 1: 50, 2: 100, 3: 150 },
    skills: { 1: 20, 2: 20, 3: 20, 4: 50, 5: 40, 6: 30, 7: 40, 8: 50, 9: 20, 10: 25, 11: 25, 12: 80, 13: 50, 14: 30, 15: 60, 16: 50, 17: 80, 18: 50, 19: 50, 20: 50 },
    ranks: [{ name: 'צוער', min: 0 }, { name: 'איש כנף', min: 300 }, { name: 'טייס', min: 600 }, { name: 'מוביל מבנה', min: 1000 }, { name: 'מפקד טייסת', min: 1500 }],
    redo: 'keep'
  };
}

function emptyProgress() {
  return { acquired: {}, redo: {}, flights: [], ledger: [], notifications: [], requests: [], timeToday: 0, timeDay: '', questVideoDay: '', dailyDismissedDay: '', seq: 1 };
}

// ---------- time (Israel) ----------
const TZ = 'Asia/Jerusalem';
function parts(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {};
  f.formatToParts(d || new Date()).forEach((p) => { o[p.type] = p.value; });
  return o;
}
function today(d) {
  const p = parts(d);
  return p.year + '-' + p.month + '-' + p.day;
}
function stamp(d) {
  const p = parts(d);
  return p.year + '-' + p.month + '-' + p.day + ' ' + p.hour + ':' + p.minute;
}

// ---------- coins ----------
function skillPoints(sc, id) {
  const v = sc.skills && sc.skills[id];
  return v != null ? Number(v) || 0 : 0;
}
function rule(sc, key) {
  const r = sc.rules && sc.rules[key];
  return r && r.on ? Number(r.points) || 0 : 0;
}
function levelBonus(sc, n) {
  const lb = sc.levelBonus || {};
  return lb.on ? Number(lb[n]) || 0 : 0;
}
function total(doc) {
  return doc.ledger.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
}
function spent(doc) {
  return doc.requests.filter((r) => r.status === 'pending' || r.status === 'delivered').reduce((sum, r) => sum + (Number(r.cost) || 0), 0);
}
function balance(doc) {
  return total(doc) - spent(doc);
}
function levelComplete(doc, n) {
  const list = SKILLS.filter((k) => k.level === n);
  return list.length > 0 && list.every((k) => doc.acquired[k.id]);
}
// The first level with an active skill still open; after the last one, the last level.
function currentLevel(doc) {
  for (const lv of LEVELS) {
    const list = SKILLS.filter((k) => k.level === lv.n);
    if (list.length && !list.every((k) => doc.acquired[k.id])) return lv.n;
  }
  return LEVELS.length ? LEVELS[LEVELS.length - 1].n : 1;
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Give a skill: its coins (once: a skill sent back for a redo does not pay twice), a first-try bonus when it passed on
// the first flight, and the level bonus when it closes the level. Without coins when the instructor chose so.
function grantSkill(doc, sc, skillId, how, opts) {
  const k = skillById(skillId);
  if (!k || doc.acquired[skillId]) return [];
  opts = opts || {};
  const withPoints = opts.points !== false;
  const at = stamp();
  const added = [];
  doc.acquired[skillId] = how;
  if (doc.redo) delete doc.redo[skillId];
  const paid = doc.ledger.some((e) => e.skill === skillId && e.kind === 'skill' && !e.reverted);
  if (withPoints && !paid) {
    const pts = skillPoints(sc, skillId);
    const text = how === 'flight' ? 'טיסה אושרה: ' + k.name : 'המדריך סימן כנרכשה: ' + k.name;
    added.push({ id: newId('a'), at, cat: 'stage', kind: 'skill', text, amount: pts, skill: skillId });
    if (opts.first && rule(sc, 'first') > 0) {
      added.push({ id: newId('a'), at, cat: 'bonus', kind: 'first', text: 'ניסיון ראשון: ' + k.name, amount: rule(sc, 'first'), skill: skillId });
    }
  }
  if (withPoints && levelComplete(doc, k.level) && levelBonus(sc, k.level) > 0 && !doc.ledger.some((e) => e.kind === 'level' && e.level === k.level && !e.reverted)) {
    const lv = LEVELS.find((l) => l.n === k.level) || { name: 'רמה ' + k.level };
    added.push({ id: newId('a'), at, cat: 'stage', kind: 'level', level: k.level, text: 'בונוס סיום רמה: ' + lv.name, amount: levelBonus(sc, k.level), skill: null });
  }
  doc.ledger.push(...added);
  return added;
}

// Ask for a redo: the skill reopens. Under the "hold" policy its coins come off until it is approved again;
// otherwise the coins stay and are not paid twice.
function requireSkill(doc, sc, skillId) {
  const k = skillById(skillId);
  if (!k || !doc.acquired[skillId]) return [];
  if ((sc.redo || 'keep') === 'hold') {
    const added = revokeSkill(doc, skillId);
    doc.redo = doc.redo || {};
    doc.redo[skillId] = true;
    return added;
  }
  delete doc.acquired[skillId];
  doc.redo = doc.redo || {};
  doc.redo[skillId] = true;
  return [];
}

// Take a skill back: it reopens, and the coins it brought (and a level bonus it closed) come off.
function revokeSkill(doc, skillId) {
  const k = skillById(skillId);
  if (!k || !doc.acquired[skillId]) return [];
  const at = stamp();
  const wasComplete = levelComplete(doc, k.level);
  delete doc.acquired[skillId];
  if (doc.redo) delete doc.redo[skillId];
  const earned = doc.ledger.filter((e) => e.skill === skillId && (e.kind === 'skill' || e.kind === 'first') && !e.reverted);
  earned.forEach((e) => { e.reverted = true; });
  const sum = earned.reduce((s, e) => s + e.amount, 0);
  const added = [];
  if (sum) added.push({ id: newId('a'), at, cat: 'stage', kind: 'revoke', text: 'המיומנות בוטלה: ' + k.name, amount: -sum, skill: skillId });
  if (wasComplete) {
    const lb = doc.ledger.filter((e) => e.kind === 'level' && e.level === k.level && !e.reverted);
    lb.forEach((e) => { e.reverted = true; });
    const lsum = lb.reduce((s, e) => s + e.amount, 0);
    const lv = LEVELS.find((l) => l.n === k.level) || { name: 'רמה ' + k.level };
    if (lsum) added.push({ id: newId('a'), at, cat: 'stage', kind: 'revoke', text: 'בונוס סיום רמה בוטל: ' + lv.name, amount: -lsum, skill: null });
  }
  doc.ledger.push(...added);
  return added;
}

// A challenge is open from its level on, until its end time (Israel time) if it has one.
function challengeOpen(c, doc) {
  if (c.final) {
    if (!SKILLS.length || !SKILLS.every((k) => doc.acquired[k.id])) return false;
    if (c.ends && stamp() > (c.ends.length === 10 ? c.ends + ' 23:59' : c.ends)) return false;
    return true;
  }
  const rank = (n) => LEVELS.findIndex((l) => l.n === n);
  if (rank(c.level) > rank(currentLevel(doc))) return false;
  if (c.ends && stamp() > (c.ends.length === 10 ? c.ends + ' 23:59' : c.ends)) return false;
  return true;
}

function notify(doc, n) {
  doc.notifications.unshift(Object.assign({ id: newId('an'), at: stamp(), when: 'עכשיו', read: false }, n));
  if (doc.notifications.length > 200) doc.notifications.length = 200;
}

function sg(n) {
  return '⁦' + (n > 0 ? '+' : '') + n + '⁩';
}

// ---------- what a student may change in their own progress ----------
// The student's screen sends its whole progress; the server keeps the stored copy and takes from the screen only
// what a student is allowed to add: today's habit coins within the rules, flights sent for review, prize
// requests they can afford, cancelling their own pending requests, notes read, and the day's counters.
function acceptStudent(stored, incoming, ctx) {
  const sc = ctx.scoring;
  const now = stamp();
  const day = today();
  const doc = JSON.parse(JSON.stringify(stored));
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const events = [];
  const ids = new Set(doc.ledger.map((e) => e.id));
  const todays = (kind) => doc.ledger.filter((e) => e.kind === kind && String(e.at).slice(0, 10) === day).length;

  // habit and bonus coins the student earns by using the app
  (Array.isArray(inc.ledger) ? inc.ledger : []).forEach((e) => {
    if (!e || typeof e.id !== 'string' || ids.has(e.id) || e.id.length > 40) return;
    const amount = Number(e.amount) || 0;
    let ok = false;
    if (e.kind === 'login') ok = todays('login') === 0 && amount === rule(sc, 'login');
    else if (e.kind === 'streak') ok = todays('streak') === 0 && todays('login') > 0 && (amount === rule(sc, 'streak3') || amount === rule(sc, 'streak7'));
    else if (e.kind === 'time') ok = todays('time') < Math.max(0, Number(sc.rules && sc.rules.time && sc.rules.time.max) || 0) && amount === rule(sc, 'time');
    else if (e.kind === 'video') {
      const sid = Number(e.skill);
      ok = SKILLS.some((k) => k.id === sid && k.video) && !doc.ledger.some((x) => x.kind === 'video' && x.skill === sid) && amount === rule(sc, 'video');
    } else if (e.kind === 'quests') ok = todays('quests') === 0 && amount === rule(sc, 'quests') && todays('login') > 0;
    if (!ok) return;
    const entry = { id: e.id, at: now, cat: e.kind === 'video' || e.kind === 'quests' ? 'bonus' : 'habit', kind: e.kind, text: String(e.text || '').slice(0, 120), amount: amount, skill: e.kind === 'video' ? Number(e.skill) : null };
    doc.ledger.push(entry);
    ids.add(e.id);
  });

  // flights sent for review
  const fids = new Set(doc.flights.map((f) => f.id));
  (Array.isArray(inc.flights) ? inc.flights : []).forEach((f) => {
    if (!f || typeof f.id !== 'string' || fids.has(f.id) || f.id.length > 40) return;
    const link = String(f.link || '').trim().slice(0, 500);
    if (!/^https?:\/\/\S+$/i.test(link) && !(ctx.ownsMedia && ctx.ownsMedia(link))) return;
    if (f.challenge != null) {
      const c = CHALLENGES.find((x) => x.id === String(f.challenge));
      if (!c || !challengeOpen(c, doc)) return;
      if (doc.flights.some((x) => x.challenge === c.id && (x.status === 'review' || x.status === 'approved'))) return;
      doc.flights.unshift({ id: f.id, skill: null, challenge: c.id, at: now, status: 'review', feedback: '', note: String(f.note || '').slice(0, 500), link: link });
      fids.add(f.id);
      events.push({ kind: 'flight', text: 'הגיש טיסה לאתגר: ' + c.title, ref: f.id });
      return;
    }
    const sid = Number(f.skill);
    const k = SKILLS.find((x) => x.id === sid);
    if (!k || doc.acquired[sid] || k.level > currentLevel(doc)) return;
    if (doc.flights.some((x) => x.skill === sid && x.status === 'review')) return;
    const flight = { id: f.id, skill: sid, at: now, status: 'review', feedback: '', note: String(f.note || '').slice(0, 500), link: link };
    doc.flights.unshift(flight);
    fids.add(f.id);
    events.push({ kind: 'flight', text: 'הגיש טיסה לבדיקה: ' + k.name, ref: f.id });
  });

  // prize requests and cancelling them
  const rids = new Map(doc.requests.map((r) => [r.id, r]));
  (Array.isArray(inc.requests) ? inc.requests : []).forEach((r) => {
    if (!r || typeof r.id !== 'string' || r.id.length > 40) return;
    const mine = rids.get(r.id);
    if (mine) {
      if (mine.status === 'pending' && r.status === 'cancelled') {
        mine.status = 'cancelled';
        mine.closedAt = now;
        const p = ctx.rewards.find((x) => x.id === mine.prize);
        events.push({ kind: 'reward', text: 'ביטל בקשה לפרס: ' + (p ? p.title : mine.prize), ref: mine.id });
      }
      return;
    }
    if (r.status !== 'pending') return;
    const p = ctx.rewards.find((x) => x.id === r.prize && x.active !== false);
    if (!p) return;
    if (p.groups !== 'all' && (!Array.isArray(p.groups) || p.groups.indexOf(ctx.unit || 'none') === -1)) return;
    if (doc.requests.some((x) => x.prize === p.id && x.status === 'pending')) return;
    if (balance(doc) < p.cost) return;
    if (ctx.stockLeft(p.id) <= 0) return;
    const req = { id: r.id, prize: p.id, cost: Number(p.cost), at: now, status: 'pending' };
    doc.requests.unshift(req);
    rids.set(req.id, req);
    events.push({ kind: 'reward', text: 'ביקש לממש פרס: ' + p.title, ref: req.id });
  });

  // notes the screen adds (sent, requested, new rank) and notes marked as read
  const nmap = new Map(doc.notifications.map((n) => [n.id, n]));
  const incoming_notes = Array.isArray(inc.notifications) ? inc.notifications : [];
  incoming_notes.slice().reverse().forEach((n) => {
    if (!n || typeof n.id !== 'string' || n.id.length > 40) return;
    const mine = nmap.get(n.id);
    if (mine) {
      if (n.read === true) mine.read = true;
      return;
    }
    if (['submitted', 'reward', 'rank'].indexOf(n.kind) === -1) return;
    const note = { id: n.id, kind: n.kind, text: String(n.text || '').slice(0, 300), at: now, when: 'עכשיו', read: !!n.read };
    if (n.skill != null) note.skill = Number(n.skill);
    if (n.reward != null) note.reward = String(n.reward).slice(0, 40);
    doc.notifications.unshift(note);
    nmap.set(note.id, note);
  });
  if (doc.notifications.length > 200) doc.notifications.length = 200;

  // the day's counters
  if (Number.isFinite(Number(inc.timeToday)) && inc.timeDay === day) {
    doc.timeToday = Math.max(0, Math.min(86400, Math.floor(Number(inc.timeToday))));
    doc.timeDay = day;
  }
  if (inc.questVideoDay === day) doc.questVideoDay = day;
  if (inc.dailyDismissedDay === day) doc.dailyDismissedDay = day;
  if (Number.isFinite(Number(inc.seq))) doc.seq = Math.max(doc.seq || 1, Math.floor(Number(inc.seq)));

  return { doc, events };
}

module.exports = { LEVELS, SKILLS, ALL_SKILLS, CHALLENGES, ALL_CHALLENGES, curriculumDefaults, cleanCurriculum, setCurriculum, skillById, challengeById, challengeOpen, scoringDefaults, emptyProgress, today, stamp, total, spent, balance, currentLevel, levelComplete, grantSkill, requireSkill, revokeSkill, notify, newId, skillPoints, rule, sg, acceptStudent };
