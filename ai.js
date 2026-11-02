'use strict';
// 88ACADEMY: checking students' flight videos with Google Gemini.
// The server hands over a flight, its skill and the video (a file uploaded to the site, or a public YouTube link).
// Gemini watches the video against the skill's pass criteria and answers with a verdict, a confidence and feedback.
// What happens next (approve, send back, or leave for the instructor) is decided by the server from the admin's settings.

const fs = require('fs');
const path = require('path');

const BASE = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const KEY = () => process.env.GEMINI_API_KEY || '';
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };

function hasKey() {
  return !!KEY();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function call(url, opts, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 120000);
  try {
    const res = await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : text.slice(0, 300);
      const err = new Error('Gemini ' + res.status + ': ' + msg);
      err.status = res.status;
      throw err;
    }
    return { res, json };
  } finally {
    clearTimeout(t);
  }
}

// Sends a video file to Gemini's file store and waits until it is ready to be watched.
async function uploadFile(full) {
  const size = fs.statSync(full).size;
  const mime = MIME[path.extname(full).toLowerCase()] || 'video/mp4';
  const start = await call(BASE + '/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'x-goog-api-key': KEY(),
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: path.basename(full) } })
  }, 60000);
  const uploadUrl = start.res.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload address.');
  const done = await call(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: fs.createReadStream(full),
    duplex: 'half'
  }, 15 * 60000);
  let file = done.json && done.json.file;
  if (!file || !file.uri) throw new Error('Gemini did not accept the video.');
  for (let i = 0; i < 90 && file.state === 'PROCESSING'; i++) {
    await sleep(2000);
    file = (await call(BASE + '/v1beta/' + file.name, { headers: { 'x-goog-api-key': KEY() } }, 30000)).json;
  }
  if (file.state && file.state !== 'ACTIVE') throw new Error('Gemini could not read the video (' + file.state + ').');
  return { uri: file.uri, name: file.name, mime: file.mimeType || mime };
}

async function deleteFile(name) {
  try { await call(BASE + '/v1beta/' + name, { method: 'DELETE', headers: { 'x-goog-api-key': KEY() } }, 30000); } catch (e) {}
}

function prompt(job) {
  const ref = !!job.hasRef;
  const lines = [
    'אתה מדריך טיסת רחפני FPV באקדמיה 88ACADEMY. סטודנט שלח סרטון של טיסה שלו כדי לעבור מיומנות.',
    ref ? 'קיבלת שני סרטונים. סרטון 1 הוא סרטון ההדגמה של המדריך: הוא מראה את המפה הנכונה ואת התרגיל הנכון. סרטון 2 הוא הטיסה של הסטודנט, ואותו אתה בודק.'
      : 'קיבלת סרטון אחד: הטיסה של הסטודנט. אין סרטון הדגמה, אז השווה לתיאור המפה והתרגיל שבטקסט.',
    '',
    'המיומנות: ' + job.skillName,
    job.desc ? 'תיאור: ' + job.desc : '',
    job.pass ? 'איך עוברים (מה בודקים): ' + job.pass : '',
    job.map ? 'המפה / המסלול הנדרש: ' + job.map : 'לא נדרשה מפה מסוימת.',
    job.note ? 'הערת הסטודנט: ' + job.note : '',
    job.extra ? 'הנחיות נוספות מהמדריך: ' + job.extra : '',
    '',
    'בודקים בשלושה שלבים, בסדר הזה:',
    '1. מפה: האם הטיסה של הסטודנט היא באותה מפה / סביבה' + (ref ? ' כמו בסרטון ההדגמה' : ' שתוארה') + '? השווה סימנים שרואים: סוג השטח, מבנים, מכשולים, צבעים, שמיים. אם לא נדרשה מפה מסוימת, ענה "yes".',
    '2. תרגיל: האם הסטודנט מבצע את אותו תרגיל' + (ref ? ' כמו בהדגמה' : ' שתואר') + ' (אותה תנועה, אותו מסלול, אותם מכשולים)? טיסה טובה של תרגיל אחר היא "no".',
    '3. דרישות: כל דרישה מ"איך עוברים" בנפרד: מתקיימת או לא, ובאיזה זמן בסרטון 2 רואים את זה.',
    '',
    'כללים:',
    '- לכל שלב ענה "yes", "no" או "unsure". "yes" רק כשאתה רואה את זה בבירור. אם אתה לא בטוח, "unsure", לא "yes".',
    '- אל תניח שהסטודנט טס במפה הנכונה או בתרגיל הנכון רק כי הוא שלח את הסרטון לתרגיל הזה.',
    '- verdict: "pass" רק אם המפה "yes", התרגיל "yes" וכל הדרישות "yes". "fail" אם משהו מהם "no". אחרת "unclear".',
    '- confidence: מספר בין 0 ל־100, כמה אתה בטוח בהחלטה.',
    '- map_seen ו־exercise_seen: במשפט קצר בעברית, מה רואים בסרטון 2 (למשל "שדה דשא עם חבילות קש", "חניון בעיר, טיסה ישרה בין עמודים").',
    '- feedback: משוב לסטודנט בעברית, בגוף שני רבים, 2–4 משפטים, מעודד וענייני. אם המפה או התרגיל לא נכונים, אמור את זה קודם ובמפורש.',
    '- notes: הערה קצרה למדריך בעברית: על מה התבססת ומה כדאי לו לבדוק בעצמו.',
    '',
    'ענה ב־JSON בלבד, בדיוק במבנה הזה:',
    '{"map_match": "yes" | "no" | "unsure", "map_seen": "...", "exercise_match": "yes" | "no" | "unsure", "exercise_seen": "...", "requirements": [{"text": "...", "met": "yes" | "no" | "unsure", "at": "0:12"}], "verdict": "pass" | "fail" | "unclear", "confidence": 0-100, "feedback": "...", "notes": "..."}'
  ];
  return lines.filter((l) => l !== '').join('\n').replace(/\n(בודקים בשלושה|כללים:|ענה ב)/g, '\n\n$1');
}

const YNU = (v) => (['yes', 'no', 'unsure'].indexOf(v) !== -1 ? v : 'unsure');
const MARK = { yes: '✓', no: '✗', unsure: '?' };

// The decision is made here, from the checks, not taken from the model's own verdict:
// pass only when the map, the exercise and every requirement are a clear yes; any no is a fail; anything else is unclear.
function parse(text, opts) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let o = null;
  try { o = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch (e2) {} }
  }
  if (!o || typeof o !== 'object') throw new Error('Gemini answered in an unexpected format.');
  const needMap = !(opts && opts.noMap);
  const map = needMap ? YNU(o.map_match) : 'yes';
  const ex = YNU(o.exercise_match);
  const reqs = (Array.isArray(o.requirements) ? o.requirements : []).slice(0, 12).map((r) => ({
    text: String((r && r.text) || '').trim().slice(0, 200),
    met: YNU(r && r.met),
    at: String((r && r.at) || '').trim().slice(0, 20)
  })).filter((r) => r.text);
  const said = ['pass', 'fail', 'unclear'].indexOf(o.verdict) !== -1 ? o.verdict : 'unclear';
  const all = [map, ex].concat(reqs.map((r) => r.met));
  let verdict;
  if (all.indexOf('no') !== -1) verdict = 'fail';
  else if (all.indexOf('unsure') !== -1 || !reqs.length) verdict = said === 'fail' ? 'fail' : 'unclear';
  else verdict = said === 'fail' ? 'fail' : said === 'unclear' ? 'unclear' : 'pass';
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  const mapSeen = String(o.map_seen || '').trim().slice(0, 200), exSeen = String(o.exercise_seen || '').trim().slice(0, 200);
  const okReqs = reqs.filter((r) => r.met === 'yes').length;
  const summary = [
    needMap ? 'מפה ' + MARK[map] + (mapSeen ? ' (בסרטון: ' + mapSeen + ')' : '') : '',
    'תרגיל ' + MARK[ex] + (exSeen ? ' (בסרטון: ' + exSeen + ')' : ''),
    reqs.length ? 'דרישות ' + okReqs + '/' + reqs.length : 'לא פורטו דרישות',
    opts && opts.hasRef ? 'הושווה לסרטון ההדגמה' : 'בלי סרטון הדגמה להשוואה'
  ].filter(Boolean).join(' · ');
  return {
    verdict,
    confidence,
    feedback: String(o.feedback || '').trim().slice(0, 1000),
    notes: (summary + (o.notes ? ' · ' + String(o.notes).trim() : '')).slice(0, 1200),
    checks: { map, mapSeen, exercise: ex, exerciseSeen: exSeen, requirements: reqs, said, ref: !!(opts && opts.hasRef) }
  };
}

// job: { file (full path) | youtube (url), refFile | refYoutube (the demo video), skillName, desc, pass, map, note, extra, model }
async function check(job) {
  if (!hasKey()) throw new Error('חסר מפתח GEMINI_API_KEY בהגדרות של Render.');
  const model = (job.model || DEFAULT_MODEL).replace(/^models\//, '');
  let uploaded = null, refUp = null;
  try {
    let part;
    if (job.file) {
      uploaded = await uploadFile(job.file);
      part = { file_data: { mime_type: uploaded.mime, file_uri: uploaded.uri } };
    } else if (job.youtube) {
      part = { file_data: { file_uri: job.youtube } };
    } else {
      throw new Error('אין סרטון שאפשר לבדוק.');
    }
    // the instructor's demo video of the same exercise, when there is one: the model compares against it
    let refPart = null;
    if (job.refFile) {
      try { const r = await uploadFile(job.refFile); refUp = r; refPart = { file_data: { mime_type: r.mime, file_uri: r.uri } }; } catch (e) { refPart = null; }
    } else if (job.refYoutube) refPart = { file_data: { file_uri: job.refYoutube } };
    const ask = async (ref) => {
      const pj = Object.assign({}, job, { hasRef: !!ref });
      const parts = ref ? [{ text: 'סרטון 1: סרטון ההדגמה של המדריך (המפה והתרגיל הנכונים).' }, ref, { text: 'סרטון 2: הטיסה של הסטודנט, לבדיקה.' }, part, { text: prompt(pj) }] : [part, { text: prompt(pj) }];
      const out = await call(BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } })
      }, 5 * 60000);
      const cand = out.json && out.json.candidates && out.json.candidates[0];
      const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
      if (!text) throw new Error('Gemini did not answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
      return Object.assign(parse(text, { hasRef: !!ref, noMap: !job.map && !ref }), { model });
    };
    // if Gemini refuses the pair of videos (for example a demo it cannot open), the flight is checked on its own
    try { return await ask(refPart); } catch (e) { if (refPart && e.status >= 400 && e.status < 500) return await ask(null); throw e; }
  } finally {
    if (uploaded) deleteFile(uploaded.name);
    if (refUp) deleteFile(refUp.name);
  }
}

// A YouTube address Gemini can open (it accepts only public videos).
function youtubeUrl(u) {
  const m = String(u || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? 'https://www.youtube.com/watch?v=' + m[1] : '';
}

module.exports = { hasKey, check, youtubeUrl, DEFAULT_MODEL, prompt, parse };
