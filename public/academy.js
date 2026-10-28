/* 88ACADEMY: the screens' link to the server.
   The server puts the signed-in person's data on the page (window.__ACADEMY__). This file reads it, sends
   changes back, keeps it fresh, and gives every screen the same numbers for each student. */
(function () {
  'use strict';
  var boot = window.__ACADEMY__ || null;
  var SCORING_KEY = '88academy.scoring.v1';
  var A = {
    on: !!boot,
    data: boot,
    me: boot ? boot.me : null
  };
  window.Academy = A;
  // ---------- requests ----------
  function req(method, url, body) {
    return fetch(url, {
      method: method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Academy': '1' },
      body: body == null ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && url !== '/api/login') { location.href = '/Login.dc.html'; }
        return r.ok ? { ok: true, json: j } : { ok: false, error: j.error || 'משהו השתבש. נסו שוב.' };
      });
    }).catch(function () {
      return { ok: false, error: 'אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.' };
    });
  }
  A.request = req;

  // Sends a video file from this computer to the server. onProgress gets 0–100. Resolves { ok, url } or { ok: false, error }.
  A.upload = function (file, onProgress, endpoint) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open('POST', endpoint || '/api/admin/upload');
      x.setRequestHeader('X-Academy', '1');
      x.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'video.mp4'));
      x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      x.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(Math.round(e.loaded / e.total * 100)); };
      x.onload = function () {
        var j = {};
        try { j = JSON.parse(x.responseText || '{}'); } catch (e) {}
        if (x.status === 200 && j.url) resolve({ ok: true, url: j.url, name: j.name });
        else resolve({ ok: false, error: j.error || 'ההעלאה נכשלה (' + x.status + '). נסו שוב.' });
      };
      x.onerror = function () { resolve({ ok: false, error: 'אין חיבור לשרת. בדקו את האינטרנט ונסו שוב.' }); };
      x.send(file);
    });
  };
  // A video uploaded to this site (played with the browser's own player).
  A.isFile = function (u) { return /^\/media\/[A-Za-z0-9_-]+\.(mp4|m4v|mov|webm)$/.test(String(u || '')); };

  if (!boot) return;

  // ---------- events ----------
  function emit() {
    try { window.dispatchEvent(new Event('academy:change')); } catch (e) {}
    try {
      var ev = document.createEvent('Event');
      ev.initEvent('storage', false, false);
      ev.key = SCORING_KEY;
      window.dispatchEvent(ev);
    } catch (e) {}
  }
  A.listen = function (fn) {
    window.addEventListener('academy:change', fn);
    return function () { window.removeEventListener('academy:change', fn); };
  };
  function replace(next) {
    if (!next) return;
    A.data = next;
    A.me = next.me;
    emit();
  }

  // An admin action: the server answers with the fresh data, and every screen redraws from it.
  A.call = function (action, body) {
    return req('POST', '/api/admin/' + action, body || {}).then(function (r) {
      if (r.ok && r.json.boot) replace(r.json.boot);
      return r.ok ? { ok: true, result: r.json.result } : r;
    });
  };
  A.refresh = function () {
    return req('GET', '/api/boot').then(function (r) {
      if (r.ok) replace(r.json);
      return r;
    });
  };
  A.logout = function () {
    return req('POST', '/api/logout').then(function () { location.href = '/Login.dc.html'; });
  };

  // Keep the screens of managers and observers fresh while they are open.
  if (boot.me.role !== 'student') {
    setInterval(function () {
      if (document.visibilityState === 'visible') A.refresh();
    }, 30000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') A.refresh();
    });
  }

  // ---------- the scoring settings live on the server ----------
  // The screens already read and write them as one stored value; that value now comes from the server.
  try {
    var proto = Object.getPrototypeOf(window.localStorage);
    var getItem = proto.getItem;
    var setItem = proto.setItem;
    var removeItem = proto.removeItem;
    proto.getItem = function (k) {
      if (k === SCORING_KEY) return JSON.stringify(A.data.scoring);
      return getItem.call(this, k);
    };
    proto.setItem = function (k, v) {
      if (k === SCORING_KEY) {
        try {
          var sc = JSON.parse(v);
          A.data.scoring = sc;
          if (A.me.role === 'admin') A.call('saveScoring', { scoring: sc });
        } catch (e) {}
        return;
      }
      return setItem.call(this, k, v);
    };
    proto.removeItem = function (k) {
      if (k === SCORING_KEY) return;
      return removeItem.call(this, k);
    };
  } catch (e) {}

  // ---------- shared numbers ----------
  A.units = function () { return A.data.units || []; };
  A.unitName = function (id) {
    var u = A.units().filter(function (x) { return x.id === id; })[0];
    return u ? u.name : '';
  };
  A.users = function (role) {
    return (A.data.users || []).filter(function (u) { return !role || u.role === role; });
  };
  A.user = function (id) {
    return (A.data.users || []).filter(function (u) { return u.id === id; })[0] || null;
  };
  A.levels = function () { return A.data.levels; };
  A.skills = function () { return A.data.skills; };
  A.skillPoints = function (id) {
    var sc = A.data.scoring;
    var v = sc && sc.skills ? sc.skills[id] : null;
    return v != null ? Number(v) || 0 : 0;
  };
  A.ranks = function () { return A.data.scoring.ranks; };
  A.rankIndex = function (xp) {
    var r = A.ranks();
    var i = 0;
    while (i + 1 < r.length && xp >= r[i + 1].min) i++;
    return i;
  };
  A.progress = function (uid) {
    var all = A.data.progressAll || {};
    return all[uid] || { acquired: {}, flights: [], ledger: [], notifications: [], requests: [] };
  };
  A.dayOf = function (at) { return String(at || '').slice(0, 10); };

  // One student's picture, the same on every screen.
  // What a student's group learns: whole levels and single skills (its own setting, else its parent's); null = everything.
  A.scopeFor = function (user) {
    var unit = user && user.unit ? A.units().filter(function (x) { return x.id === user.unit; })[0] : null;
    for (var i = 0; unit && i < 6; i++) {
      var lv = unit.levels || [], sk = unit.skills || [];
      if (lv.length || sk.length) return { levels: lv, skills: sk };
      var p = unit.parent;
      unit = p ? A.units().filter(function (x) { return x.id === p; })[0] : null;
    }
    return null;
  };
  A.summary = function (uid) {
    var u = A.user(uid);
    var d = A.progress(uid);
    var only = u && u.role === 'student' ? A.scopeFor(u) : null;
    var inScope = function (k) { return !only || only.levels.indexOf(k.level) !== -1 || only.skills.indexOf(k.id) !== -1; };
    var skills = A.skills().filter(inScope);
    var shown = skills.map(function (k) { return k.level; });
    var levels = A.levels().filter(function (l) { return shown.indexOf(l.n) !== -1; });
    // The group's own order of levels first, then levels reached only through single skills.
    if (only && only.levels.length) {
      var own = only.levels.map(function (n) { return levels.filter(function (l) { return l.n === n; })[0]; }).filter(Boolean);
      levels = own.concat(levels.filter(function (l) { return own.indexOf(l) === -1; }));
    }
    if (!levels.length) { skills = A.skills(); levels = A.levels(); }
    var done = skills.filter(function (k) { return d.acquired[k.id]; });
    var level = levels.length;
    for (var i = 0; i < levels.length; i++) {
      var n = levels[i].n;
      if (skills.some(function (k) { return k.level === n && !d.acquired[k.id]; })) { level = n; break; }
    }
    var cat = { habit: 0, bonus: 0, stage: 0, manual: 0 };
    var total = 0;
    var last = u && u.lastSeen ? u.lastSeen : '';
    // A student who does not earn points (not a "player") counts as 0 on every screen.
    var earns = !u || u.role !== 'student' || !!u.earns;
    (earns ? d.ledger : []).forEach(function (e) {
      total += Number(e.amount) || 0;
      var c = e.kind === 'manual' ? 'manual' : e.cat;
      cat[c] = (cat[c] || 0) + (Number(e.amount) || 0);
      if (e.at > last) last = e.at;
    });
    d.flights.forEach(function (f) { if (f.at > last) last = f.at; });
    d.ledger.forEach(function (e) { if (e.at > last) last = e.at; });
    var spent = !earns ? 0 : d.requests.filter(function (r) { return r.status === 'pending' || r.status === 'delivered'; }).reduce(function (s, r) { return s + (Number(r.cost) || 0); }, 0);
    var ri = A.rankIndex(total);
    var lv = levels.filter(function (l) { return l.n === level; })[0] || levels[0];
    var allDone = done.length === skills.length;
    return {
      user: u, doc: d, done: done.length, doneIds: done.map(function (k) { return k.id; }), level: level, levelName: allDone ? 'המסלול הושלם' : lv.name,
      total: total, balance: total - spent, spent: spent, habit: cat.habit, bonus: cat.bonus, stage: cat.stage, manual: cat.manual,
      rankIndex: ri, rankName: A.ranks()[ri].name, last: last, lastDay: A.dayOf(last),
      reviewing: d.flights.filter(function (f) { return f.status === 'review'; }),
      pendingRequests: d.requests.filter(function (r) { return r.status === 'pending'; }),
      earns: earns,
      levelsList: levels, skillsList: skills,
      started: d.ledger.length > 0 || d.flights.length > 0 || !!(u && u.lastLogin)
    };
  };
  A.students = function () {
    return A.users('student').map(function (u) { return A.summary(u.id); });
  };
  // Skills most students of a group are stuck on: open skills in their current level that they have not passed.
  A.bottlenecks = function (list) {
    var count = {};
    list.forEach(function (s) {
      A.skills().forEach(function (k) {
        if (k.level === s.level && !s.doc.acquired[k.id]) count[k.id] = (count[k.id] || 0) + 1;
      });
    });
    return Object.keys(count).map(function (id) {
      var k = A.skills().filter(function (x) { return String(x.id) === id; })[0];
      return [k.name, count[id]];
    }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
  };
  A.today = function () { return A.data.today; };
  A.addDays = function (iso, n) {
    var d = new Date(iso + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  A.fmtDate = function (at) {
    var s = String(at || '');
    if (s.length < 10) return '';
    return s.slice(8, 10) + '.' + s.slice(5, 7) + (s.length > 10 ? ' ' + s.slice(11, 16) : '');
  };
  A.ago = function (at) {
    var day = A.dayOf(at);
    if (!day) return '';
    var t = new Date(A.today() + 'T12:00:00Z');
    var d = new Date(day + 'T12:00:00Z');
    var n = Math.round((t - d) / 864e5);
    if (n <= 0) return 'היום';
    if (n === 1) return 'אתמול';
    return 'לפני ' + n + ' ימים';
  };
  A.skillName = function (id) {
    var k = (A.data.allSkills || A.skills()).filter(function (x) { return x.id === Number(id); })[0];
    return k ? k.name : '';
  };
  A.challenges = function () { return A.data.challenges || []; };
  A.challengeTitle = function (id) {
    var c = (A.data.allChallenges || []).filter(function (x) { return x.id === id; })[0];
    return c ? c.title : 'אתגר';
  };
  // What a flight was for: a skill or a challenge.
  A.flightName = function (f) {
    return f && f.challenge ? 'אתגר: ' + A.challengeTitle(f.challenge) : A.skillName(f && f.skill);
  };
  // A YouTube or Google Drive link as an address that can play inside the page, or '' when it cannot.
  A.embedUrl = function (u) {
    var t = String(u || '').trim();
    var m = t.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1] + '?rel=0';
    m = t.match(/drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]{10,})/);
    if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    return '';
  };
})();
