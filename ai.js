'use strict';
// 88ACADEMY: Gemini reads the numbers of a simulator flight and judges it against the instructor's criteria.
// The server only builds the question and cleans the answer; the game decides what to do with the verdict.

const BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const KEY = () => process.env.GEMINI_API_KEY || '';
let found = '';                                               // a model found automatically when the configured one does not exist
const MODEL = () => found || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
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
    '- מספר שערים במסלול: ' + num(f.gates, 0) + (tr.laps ? ', הקפות במבחן: ' + num(tr.laps, 1) : ''),
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

async function gem(path, opts) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(BASE + path, Object.assign({ signal: ctl.signal }, opts, { headers: Object.assign({ 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' }, (opts && opts.headers) || {}) }));
    const raw = await res.text(); let j = null; try { j = JSON.parse(raw); } catch (e) { /* below */ }
    if (!res.ok) { const e = new Error('gemini-' + res.status + ': ' + ((j && j.error && j.error.message) || raw.slice(0, 300))); e.code = 'gemini'; e.status = res.status; throw e; }
    return j;
  } finally { clearTimeout(timer); }
}

// The models this key can use for text answers, newest flash first.
async function listModels() {
  if (!hasKey()) { const e = new Error('no-key'); e.code = 'no-key'; throw e; }
  const j = await gem('/v1beta/models?pageSize=200', { method: 'GET' });
  const ok = (j.models || []).filter((m) => /generateContent/.test((m.supportedGenerationMethods || []).join(',')) && /^models\/gemini-/.test(m.name)).map((m) => m.name.replace(/^models\//, ''));
  const rank = (n) => { const v = /gemini-(\d+(?:\.\d+)?)/.exec(n); return (v ? parseFloat(v[1]) : 0) * 10 + (/flash/.test(n) && !/lite|image|live|tts|preview|exp|thinking/.test(n) ? 5 : /flash/.test(n) ? 2 : 0); };
  return ok.sort((a, b) => rank(b) - rank(a));
}

async function ask(model, job) {
  const j = await gem('/v1beta/models/' + encodeURIComponent(model) + ':generateContent', { method: 'POST',
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt(job) }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }) });
  const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
  return parse((parts || []).map((p) => p.text || '').join(''));
}

async function check(job, wanted) {
  if (!hasKey()) { const e = new Error('no-key'); e.code = 'no-key'; throw e; }
  const m = /^gemini-[A-Za-z0-9._\-]{1,60}$/.test(wanted || '') ? wanted : MODEL();
  try { return await ask(m, job); }
  catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;                        // the model name is not valid for this key: pick the newest one it can use
    const list = await listModels(); const pick = list.find((n) => n !== m);
    if (!pick) throw e;
    const r = await ask(pick, job); found = pick; return r;
  }
}

module.exports = { check, listModels, hasKey, model: MODEL };
