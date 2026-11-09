'use strict';
// 88ACADEMY: Gemini reads the numbers of a simulator flight and judges it against the instructor's criteria.
// The server only builds the question and cleans the answer; the game decides what to do with the verdict.

const BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const KEY = () => process.env.GEMINI_API_KEY || '';
let found = '';                                               // a model found automatically when the configured one does not exist
const MODEL = () => found || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const hasKey = () => !!KEY();

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);

function prompt(j) {
  const tr = (j.track && typeof j.track === 'object') ? j.track : {}, f = j.flight || {}, hist = Array.isArray(j.history) ? j.history.slice(-8) : [];
  const L = [
    'אתה מדריך טיסת רחפני FPV באקדמיה 88ACADEMY. תלמיד סיים טיסה בסימולטור, ואתה מקבל את נתוני הטיסה ואת הקריטריונים של המדריך.',
    'הנתונים נמדדו על ידי הסימולטור, אז הם אמינים. אין לך סרטון, ואל תנחש דברים שאינם בנתונים.',
    '',
    'השלב: ' + str(j.stage, 80),
    j.course ? 'הקורס: ' + str(j.course, 80) : '',
    tr.map ? 'המפה: ' + str(tr.map, 60) : '',
    tr.desc ? 'תיאור המסלול (מהמדריך): ' + str(tr.desc, 800) : '',
    tr.pass ? 'איך עוברים את השלב (מהמדריך): ' + str(tr.pass, 800) : '',
    tr.focus ? 'מה לבחון במיוחד (מהמדריך): ' + str(tr.focus, 800) : '',
    j.crit ? 'קריטריונים נוספים של המדריך (זה מה שקובע אם עוברים): ' + str(j.crit, 1500) : '',
    '',
    'הטיסה הנוכחית:',
    '- זמן כולל: ' + num(f.total, 0).toFixed(2) + ' שניות',
    '- הקפה הכי טובה: ' + num(f.bestLap, 0).toFixed(2) + ' שניות',
    '- מספר הקפות: ' + num(f.laps, 1) + (Array.isArray(f.lapTimes) ? ' (זמנים: ' + f.lapTimes.slice(0, 20).map((t) => num(t, 0).toFixed(1)).join(', ') + ')' : ''),
    '- התרסקויות: ' + num(f.crashes, 0),
    '- כוכבים: ' + num(f.stars, 0) + ' מתוך 3' + (f.par3 ? ' (זמן ל־3 כוכבים: ' + num(f.par3, 0).toFixed(1) + ' שניות)' : ''),
    '- מספר שערים במסלול: ' + num(f.gates, 0) + (tr.laps ? ', מספר ההקפות הנדרש במסלול הזה: ' + num(tr.laps, 1) + ' (זה המספר שהמנהל קבע; אל תדרוש יותר הקפות ממנו, וסיום של כל ההקפות האלה נחשב השלמה מלאה)' : ''),
    f.drone ? '- רחפן: ' + str(f.drone, 40) : '',
    '',
    hist.length ? 'ניסיונות קודמים של התלמיד באותו שלב (מהישן לחדש):' : 'זה הניסיון הראשון של התלמיד בשלב הזה.',
    ].concat(hist.map((h, i) => '  ' + (i + 1) + '. זמן ' + num(h.t, 0).toFixed(1) + ' ש׳, התרסקויות ' + num(h.c, 0) + ', כוכבים ' + num(h.s, 0))).concat([
    '',
    'כללים:',
    '- verdict: "pass" רק אם הנתונים מראים בבירור שכל הקריטריונים מתקיימים. "fail" אם קריטריון ברור לא מתקיים. "unclear" אם הנתונים לא מספיקים כדי להחליט.',
    '- אל תמציא קריטריונים שהמדריך לא כתב. אם המדריך לא כתב מספר, אל תקבע אחד בעצמך.',
    '- confidence: מספר בין 0 ל־100, כמה אתה בטוח בהחלטה.',
    '- feedback: משוב לתלמיד בעברית, בגוף שני, 2–3 משפטים, ענייני ומעודד. אם לא עבר, אמור מה בדיוק לשפר.',
    '- notes: הערה קצרה למדריך בעברית: על אילו נתונים התבססת.',
    '',
    'ענה ב־JSON בלבד: {"verdict": "pass" | "fail" | "unclear", "confidence": 0-100, "feedback": "...", "notes": "..."}'
  ]);
  return L.filter((l) => l !== '').join('\n');
}

function parse(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let o = null;
  try { o = JSON.parse(t); } catch (e) { const m = t.match(/\{[\s\S]*\}/); if (m) { try { o = JSON.parse(m[0]); } catch (e2) { /* below */ } } }
  if (!o || typeof o !== 'object') throw new Error('bad-answer');
  return {
    verdict: ['pass', 'fail', 'unclear'].indexOf(o.verdict) >= 0 ? o.verdict : 'unclear',
    confidence: Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0))),
    feedback: str(o.feedback, 600), notes: str(o.notes, 600)
  };
}

async function gem(path, opts, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 60000);
  try {
    const res = await fetch(BASE + path, Object.assign({ signal: ctl.signal }, opts, { headers: Object.assign({ 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' }, (opts && opts.headers) || {}) }));
    const raw = await res.text(); let j = null; try { j = JSON.parse(raw); } catch (e) { /* below */ }
    if (!res.ok) { const e = new Error('gemini-' + res.status + ': ' + ((j && j.error && j.error.message) || raw.slice(0, 300))); e.code = 'gemini'; e.status = res.status; throw e; }
    return j;
  } catch (e) {
    if (e && e.name === 'AbortError') { const t = new Error('timeout: ג׳מיני לא ענה תוך ' + Math.round((ms || 60000) / 1000) + ' שניות'); t.code = 'timeout'; throw t; }
    throw e;
  } finally { clearTimeout(timer); }
}

// The models this key can use for text answers, newest flash first.
async function listModels() {
  if (!hasKey()) { const e = new Error('no-key'); e.code = 'no-key'; throw e; }
  const j = await gem('/v1beta/models?pageSize=200', { method: 'GET' }, 15000);
  const ok = (j.models || []).filter((m) => /generateContent/.test((m.supportedGenerationMethods || []).join(',')) && /^models\/gemini-/.test(m.name) && !/tts|image|transcribe|embed|audio|live|imagen|veo|argon|robotics|computer/i.test(m.name)).map((m) => m.name.replace(/^models\//, ''));
  const rank = (n) => { const v = /gemini-(\d+(?:\.\d+)?)/.exec(n); return (v ? parseFloat(v[1]) : 0) * 10 + (/flash/.test(n) && !/lite|image|live|tts|preview|exp|thinking/.test(n) ? 5 : /flash/.test(n) ? 2 : 0); };
  return ok.sort((a, b) => rank(b) - rank(a));
}

// A short judgement does not need long "thinking": ask the model to think little (the setting differs between model families).
function thinkingFor(model) {
  if (/gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/gemini-3/.test(model) && !/pro/.test(model)) return { thinkingLevel: 'low' };
  return null;
}
const BASES = ['clean', 'field', 'desert', 'snow', 'dusk', 'redwood', 'arena'];
const JUDGE_SCHEMA = { type: 'OBJECT', properties: { verdict: { type: 'STRING', enum: ['pass', 'fail', 'unclear'] }, confidence: { type: 'INTEGER' }, feedback: { type: 'STRING' }, notes: { type: 'STRING' } }, required: ['verdict', 'confidence', 'feedback', 'notes'] };
// The shape the model MUST answer in (Gemini enforces it), so a track answer is always well-formed JSON with real element types.
function trackSchema(kind, types, kinds) {
  const num = { type: 'NUMBER' }, en = (l) => (l && l.length ? { type: 'STRING', enum: l } : { type: 'STRING' });
  const obj = { type: 'OBJECT', properties: { t: en(types), x: num, z: num, s: num, yaw: num, c: { type: 'STRING' } }, required: ['t', 'x', 'z'] };
  const gate = { type: 'OBJECT', properties: { x: num, y: num, z: num, k: en(kinds), sz: num }, required: ['x', 'y', 'z'] };
  if (kind === 'edit') return { type: 'OBJECT', properties: { base: { type: 'STRING', enum: BASES }, addObjects: { type: 'ARRAY', items: obj }, removeObjects: { type: 'OBJECT', properties: { all: { type: 'BOOLEAN' }, types: { type: 'ARRAY', items: { type: 'STRING' } } } }, gates: { type: 'ARRAY', items: gate }, addGates: { type: 'OBJECT', properties: { after: { type: 'INTEGER' }, count: { type: 'INTEGER' }, spacing: num, y: num, dx: num, dz: num } }, closed: { type: 'BOOLEAN' } } };
  return { type: 'OBJECT', properties: { name: { type: 'STRING' }, base: { type: 'STRING', enum: BASES }, closed: { type: 'BOOLEAN' }, gates: { type: 'ARRAY', items: gate }, objects: { type: 'ARRAY', items: obj } }, required: ['name', 'base', 'closed', 'gates'] };
}
async function ask(model, job, ms, text, asJson, schema) {
  const body = (think, noSchema) => JSON.stringify({ contents: [{ role: 'user', parts: [{ text: text || prompt(job) }] }], generationConfig: Object.assign({ temperature: asJson ? 0.5 : 0.2 }, asJson ? { maxOutputTokens: 8192 } : {}, text && !asJson ? {} : { responseMimeType: 'application/json' }, (!noSchema && (schema || !text)) ? { responseSchema: schema || JUDGE_SCHEMA } : {}, think ? { thinkingConfig: think } : {}) });
  const path = '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', think = thinkingFor(model);
  let j;
  try { j = await gem(path, { method: 'POST', body: body(think) }, ms); }
  catch (e) {
    if (e.status !== 400) throw e;
    if (/schema|enum|response_?schema/i.test(e.message)) j = await gem(path, { method: 'POST', body: body(think, true) }, ms);     // a model that rejects the answer shape: ask without it (the app still validates)
    else if (think && /think/i.test(e.message)) j = await gem(path, { method: 'POST', body: body(null) }, ms);
    else throw e;
  }
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  const out = (parts || []).map((p) => p.text || '').join('');
  return text && !asJson ? out : (asJson ? out : parse(out));
}

const RETRY = (e) => e && (e.code === 'timeout' || [429, 500, 502, 503, 504].indexOf(e.status) >= 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let listCache = { at: 0, list: [] };
async function modelsCached() {
  if (Date.now() - listCache.at < 10 * 60000 && listCache.list.length) return listCache.list;
  const list = await listModels(); listCache = { at: Date.now(), list }; return list;
}

// Asks the wanted model. A model that does not exist is replaced by the newest one the key can use.
// A busy model (503, 429, timeout) is tried again once, and then other models are tried, all inside about a minute.
async function check(job, wanted) {
  if (!hasKey()) { const e = new Error('no-key'); e.code = 'no-key'; throw e; }
  const t0 = Date.now(), left = () => 55000 - (Date.now() - t0);
  const first = /^gemini-[A-Za-z0-9._\-]{1,60}$/.test(wanted || '') ? wanted : MODEL(), tried = [];
  let last = null;
  const go = async (m, ms) => { tried.push(m); try { return await ask(m, job, ms); } catch (e) { last = e; throw e; } };
  const skip = (e) => RETRY(e) || e.status === 404 || e.status === 400;           // a model that is missing, busy or slow: try the next one
  try { return await go(first, Math.min(20000, left())); }
  catch (e) {
    if (!skip(e)) throw e;
    if (RETRY(e) && e.status !== 404 && left() > 8000) { await sleep(1200); try { return await go(first, Math.min(15000, left())); } catch (e2) { if (!skip(e2)) throw e2; } }
  }
  let list = []; try { list = await modelsCached(); } catch (e) { /* keep the first error */ }
  const light = (n) => (/lite|flash-8b/.test(n) ? 0 : 1);
  for (const n of list.filter((x) => x !== first).sort((a, b) => light(a) - light(b)).slice(0, 3)) {
    if (left() < 6000) break;
    try { const r = await go(n, Math.min(20000, left())); if (last && (last.status === 404 || last.status === 400) && tried[0] === first) found = n; return r; } catch (e) { if (!skip(e)) throw e; }
  }
  const err = new Error(String((last && last.message) || 'failed') + ' | נוסו: ' + tried.join(', ')); err.code = (last && last.code) || 'gemini'; err.status = last && last.status;
  throw err;
}

// Free-form JSON generation for the track builder: the same model fallback as check(), the raw JSON text is returned.
async function generate(promptText, wanted, schema) {
  if (!hasKey()) { const e = new Error('no-key'); e.code = 'no-key'; throw e; }
  const t0 = Date.now(), left = () => 58000 - (Date.now() - t0);
  const first = /^gemini-[A-Za-z0-9._\-]{1,60}$/.test(wanted || '') ? wanted : MODEL(), tried = [];
  let last = null, order = [first];
  for (let i = 0; i < order.length; i++) {
    const m = order[i]; if (left() < 6000) break;
    tried.push(m);
    try { return await ask(m, {}, Math.min(45000, left()), promptText, true, schema); }
    catch (e) {
      last = e; if (!(RETRY(e) || e.status === 404 || e.status === 400)) throw e;
      if (i === 0) { let list = []; try { list = await modelsCached(); } catch (e2) { /* keep the error */ } order = order.concat(list.filter((x) => x !== first).sort((a, b) => (/lite|flash-8b/.test(a) ? 1 : 0) - (/lite|flash-8b/.test(b) ? 1 : 0)).slice(0, 2)); }
    }
  }
  const err = new Error(String((last && last.message) || 'failed') + ' | נוסו: ' + tried.join(', ')); err.code = (last && last.code) || 'gemini'; err.status = last && last.status;
  throw err;
}

// Step by step connection test with timings: can the server reach Gemini, does the key work, does the model answer.
async function ping(wanted) {
  const steps = [], t0 = () => Date.now();
  if (!hasKey()) return [{ step: 'מפתח', ok: false, msg: 'חסר GEMINI_API_KEY בשרת' }];
  let m = /^gemini-[A-Za-z0-9._\-]{1,60}$/.test(wanted || '') ? wanted : MODEL(), a = t0(), list = [];
  try { list = await listModels(); steps.push({ step: 'חיבור ומפתח', ok: true, ms: t0() - a, msg: list.length + ' מודלים זמינים' + (list.length ? ', הראשונים: ' + list.slice(0, 4).join(', ') : '') }); }
  catch (e) { steps.push({ step: 'חיבור ומפתח', ok: false, ms: t0() - a, msg: String(e.message || e).slice(0, 300) }); return steps; }
  if (list.length && list.indexOf(m) < 0) { steps.push({ step: 'שם המודל', ok: false, msg: m + ' לא ברשימת המודלים של המפתח. המערכת תעבור למודל ' + list[0] + ' אוטומטית' }); m = list[0]; }
  a = t0();
  try {
    const out = await ask(m, {}, 60000, 'ענה במילה אחת: שלום');
    steps.push({ step: 'תשובה מהמודל ' + m, ok: true, ms: t0() - a, msg: String(out).slice(0, 60) || '(ריק)' });
  } catch (e) { steps.push({ step: 'תשובה מהמודל ' + m, ok: false, ms: t0() - a, msg: String(e.message || e).slice(0, 300) }); }
  const bad = steps[steps.length - 1];
  if (!bad.ok || bad.ms > 8000) {                                                    // slow or failing: time the other models side by side, so the manager can pick a fast one
    const others = list.filter((x) => x !== m).sort((x, y) => (/lite|flash-8b/.test(x) ? 0 : 1) - (/lite|flash-8b/.test(y) ? 0 : 1)).slice(0, 3);
    const rs = await Promise.all(others.map(async (n) => { const b = t0(); try { await ask(n, {}, 20000, 'ענה במילה אחת: שלום'); return { step: 'מודל חלופי ' + n, ok: true, ms: t0() - b, msg: 'ענה. אפשר לבחור אותו בשדה "מודל ג׳מיני"' }; } catch (e) { return { step: 'מודל חלופי ' + n, ok: false, ms: t0() - b, msg: String(e.message || e).slice(0, 160) }; } }));
    rs.forEach((r) => steps.push(r));
  }
  return steps;
}

module.exports = { trackSchema, generate, check, listModels, ping, hasKey, model: MODEL };
