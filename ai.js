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
  const lines = [
    'אתה מדריך טיסת רחפני FPV באקדמיה 88ACADEMY. סטודנט שלח סרטון של טיסה שלו כדי לעבור מיומנות.',
    'צפה בסרטון כולו ובדוק אם הוא עומד בדרישות המיומנות.',
    '',
    'המיומנות: ' + job.skillName,
    job.desc ? 'תיאור: ' + job.desc : '',
    job.pass ? 'איך עוברים (מה בודקים): ' + job.pass : '',
    job.map ? 'מפה / מסלול: ' + job.map : '',
    job.note ? 'הערת הסטודנט: ' + job.note : '',
    job.extra ? 'הנחיות נוספות מהמדריך: ' + job.extra : '',
    '',
    'כללים:',
    '- אם הסרטון לא מראה טיסת רחפן, או לא מראה את התרגיל הזה, או שאי אפשר לראות מספיק כדי להחליט, החזר verdict "unclear".',
    '- "pass" רק כשרואים בבירור שכל הדרישות מתקיימות. "fail" כשרואים בבירור שדרישה לא מתקיימת.',
    '- confidence הוא מספר בין 0 ל־100: כמה אתה בטוח בהחלטה.',
    '- feedback: משוב לסטודנט בעברית, בגוף שני רבים, 2–4 משפטים, מעודד וענייני: מה היה טוב, ומה לשפר (עם זמנים בסרטון אם אפשר).',
    '- notes: הערה קצרה למדריך בעברית: על מה התבססת ומה כדאי לו לבדוק בעצמו.',
    '',
    'ענה ב־JSON בלבד, בדיוק במבנה הזה:',
    '{"verdict": "pass" | "fail" | "unclear", "confidence": 0-100, "feedback": "...", "notes": "..."}'
  ];
  return lines.filter((l) => l !== '').join('\n').replace(/\n(כללים:|ענה ב)/g, '\n\n$1');
}

function parse(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let o = null;
  try { o = JSON.parse(t); } catch (e) {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { o = JSON.parse(m[0]); } catch (e2) {} }
  }
  if (!o || typeof o !== 'object') throw new Error('Gemini answered in an unexpected format.');
  const verdict = ['pass', 'fail', 'unclear'].indexOf(o.verdict) !== -1 ? o.verdict : 'unclear';
  const confidence = Math.max(0, Math.min(100, Math.round(Number(o.confidence) || 0)));
  return {
    verdict,
    confidence,
    feedback: String(o.feedback || '').trim().slice(0, 1000),
    notes: String(o.notes || '').trim().slice(0, 1000)
  };
}

// job: { file (full path) | youtube (url), skillName, desc, pass, map, note, extra, model }
async function check(job) {
  if (!hasKey()) throw new Error('חסר מפתח GEMINI_API_KEY בהגדרות של Render.');
  const model = (job.model || DEFAULT_MODEL).replace(/^models\//, '');
  let uploaded = null;
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
    const body = {
      contents: [{ role: 'user', parts: [part, { text: prompt(job) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    };
    const out = await call(BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, 5 * 60000);
    const cand = out.json && out.json.candidates && out.json.candidates[0];
    const text = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
    if (!text) throw new Error('Gemini did not answer' + (cand && cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
    return Object.assign(parse(text), { model });
  } finally {
    if (uploaded) deleteFile(uploaded.name);
  }
}

// A YouTube address Gemini can open (it accepts only public videos).
function youtubeUrl(u) {
  const m = String(u || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? 'https://www.youtube.com/watch?v=' + m[1] : '';
}

module.exports = { hasKey, check, youtubeUrl, DEFAULT_MODEL, prompt, parse };
