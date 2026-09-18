/* Packet Quest GitHub Live v7.1: one serial sync queue, server-only grading, durable drafts. */
(function () {
  'use strict';
  var C = window.PacketCore, API = window.PacketAPI, cfg = window.PACKET_CONFIG, TOTAL = window.PACKET_CONFIG.questionCount || 30;
  var esc = C.escapeHTML, store = C.safeStore(), main = document.getElementById('main');
  var notices = document.getElementById('notices'), connection = document.getElementById('connection');
  var key = 'pq-live-v7:' + (API.base || location.origin), tab = C.uid();
  var state = null, view = 'entry', online = false, error = '', info = '', busy = false, pollTimer = null;
  var lastAck = 0, failures = 0, tabBlocked = false, needsFresh = false, joining = false;
  var roomHint = new URL(location.href).searchParams.get('room') || '';
  var previous = readSaved();

  function readSaved() {
    try {
      var value = JSON.parse(store.get(key) || 'null');
      if (!value || value.schema !== 5 || value.bankId !== cfg.bankId || !value.attemptId || !value.token || !value.room || !Array.isArray(value.questions)) return null;
      // Room expiry is decided by the server, not a possibly incorrect phone clock.
      return value;
    } catch (e) { return null; }
  }
  function persist() { if (state) { state.savedAt = Date.now(); store.set(key, JSON.stringify(state)); } }
  function badge() {
    var pending = state && state.revision > state.serverRevision;
    connection.textContent = !online ? 'RECONNECTING' : (pending ? 'SYNCING' : 'LIVE CONNECTED');
    connection.className = 'live-pill' + (!online ? ' bad' : pending ? ' sync' : '');
  }
  function notice() {
    var html = '';
    if (!store.available) html += '<div class="notice warning">Browser storage is blocked. Keep this tab open. Server-synced answers remain safe; refreshing may require a recovery code from your teacher.</div>';
    if (error) html += '<div class="notice warning" role="alert"><strong>Connection needs attention.</strong> ' + esc(error) + (state ? '<div class="banner-actions"><button class="secondary" data-action="retry">RETRY CONNECTION</button></div>' : '') + '</div>';
    if (state && !navigator.onLine) html += '<div class="notice warning">You are offline. Keep answering on this page, but reconnect before the deadline. Only answers received by the server before the deadline can be graded.</div>';
    if (tabBlocked) html += '<div class="notice warning">This attempt is active in another tab. Use just one quiz tab.<div class="banner-actions"><button class="secondary" data-action="take-tab">USE THIS TAB INSTEAD</button></div></div>';
    if (state && state.conflict) html += '<div class="notice error">Another tab has newer or conflicting answers. Editing is paused to avoid overwriting them.<div class="banner-actions"><button class="secondary" data-action="server-copy">LOAD SERVER ANSWERS</button></div></div>';
    if (info) html += '<div class="notice">' + esc(info) + '</div>';
    if (notices.innerHTML !== html) notices.innerHTML = html;
    badge();
  }
  function leaseKey() { return state ? key + ':lease:' + state.attemptId : ''; }
  function claim(force) {
    if (!state || state.submitted || !store.available) { tabBlocked = false; return true; }
    var existing;
    try { existing = JSON.parse(store.get(leaseKey()) || 'null'); } catch (e) {}
    if (!force && existing && existing.owner !== tab && Date.now() - existing.at < 16000) { tabBlocked = true; notice(); return false; }
    store.set(leaseKey(), JSON.stringify({owner:tab, at:Date.now()})); tabBlocked = false; notice(); return true;
  }
  function release() {
    if (!state) return;
    try { var existing = JSON.parse(store.get(leaseKey()) || 'null'); if (existing && existing.owner === tab) store.remove(leaseKey()); } catch (e) {}
  }
  function apply(snapshot, initial) {
    if (!state || snapshot.attempt.id !== state.attemptId) return;
    var oldStatus = state.submitted ? 'submitted' : state.room.status;
    var a = snapshot.attempt;
    var redrawChoices = needsFresh || a.revision > state.revision;
    state.room = snapshot.room; state.student = a.student;
    if (snapshot.questions && snapshot.questions.length) state.questions = snapshot.questions;
    if (initial || needsFresh || a.submitted || a.revision >= state.revision) {
      state.answers = a.answers; state.revision = a.revision;
    }
    if (needsFresh) { state.conflict = false; needsFresh = false; }
    state.serverRevision = Math.max(state.serverRevision || 0, a.revision);
    state.submitted = a.submitted; state.receipt = a.receipt;
    state.startedAt = a.startedAt || snapshot.room.startedAt;
    if (a.submitted) { state.pendingSubmit = false; state.conflict = false; release(); }
    lastAck = Date.now(); failures = 0; online = true; error = ''; persist();
    var newStatus = a.submitted ? 'submitted' : state.room.status;
    if (initial || oldStatus !== newStatus || (view === 'waiting' && newStatus === 'running' && state.questions.length)) renderState();
    else if (redrawChoices && view === 'quiz') renderQuiz();
    else if (redrawChoices && view === 'review') renderReview();
    else updateProgress();
    notice();
  }
  function schedule(delay) {
    clearTimeout(pollTimer);
    if (state && !state.submitted) pollTimer = setTimeout(pump, delay);
  }
  // All foreground state/save/submit calls use this one queue. An older acknowledgement
  // cannot overwrite a student's newer local edit, and duplicate submissions are safe.
  async function pump() {
    clearTimeout(pollTimer);
    if (!state || state.submitted || busy || tabBlocked) return;
    busy = true;
    var action = 'state';
    if (!state.conflict && !needsFresh && state.room.status === 'running') {
      if (state.pendingSubmit) action = 'submit';
      else if (state.revision > state.serverRevision) action = 'save';
    }
    var payload = {attemptId:state.attemptId, needQuestions:state.questions.length !== cfg.questionCount, visible:!document.hidden, currentPosition:view === 'quiz' ? state.index + 1 : 0};
    if (action !== 'state') { payload.answers = Object.assign({}, state.answers); payload.revision = state.revision; }
    updateProgress();
    try { apply(await API.call(action, payload, state.token), false); }
    catch (e) {
      online = false; failures++; error = e.message;
      if (e.code === 'revision_conflict') { state.conflict = true; state.pendingSubmit = false; persist(); }
      if (e.code === 'authentication' || e.code === 'bank_mismatch') { state.conflict = true; persist(); }
      notice();
    } finally {
      busy = false; updateProgress();
      if (state && !state.submitted) {
        var fast = online && !state.conflict && (state.pendingSubmit || state.revision > state.serverRevision);
        schedule(fast ? 60 : (online ? (document.hidden ? 15000 : 3200 + Math.random()*800) : Math.min(15000, 2000 * Math.pow(1.5, failures))));
      }
    }
  }
  async function health() {
    try { var result = await API.call('info'); if (!result.live || result.questionCount !== TOTAL) throw Error('This is not the live CS111 quiz server.'); online = true; error = ''; }
    catch (e) { online = false; error = e.message; }
    notice();
  }
  function renderNoBackend() {
    view = 'entry';
    main.innerHTML = '<section class="center-wrap panel"><p class="eyebrow">PACKET QUEST / LIVE QUIZ</p><h1 style="font-size:2rem">Use the exact quiz link from your teacher.</h1><p>This GitHub Pages game needs the live classroom backend included in your teacher’s room link.</p><div class="notice warning"><strong>Nothing is wrong with your phone.</strong> Return to Google Meet and tap the complete link your teacher posted.</div><p class="hint">The correct link contains your room information and securely connects this page to the live classroom service.</p></section>';
    online = false; error = ''; notice();
  }
  function renderEntry() {
    view = 'entry'; previous = readSaved();
    main.innerHTML = '<section class="entry"><div class="entry-hero"><p class="eyebrow">CS111 / TOPIC 4 / LIVE INDIVIDUAL QUIZ</p><h1>Small pixels.<br> Big brain<br> <span>energy.</span></h1><p class="entry-description">Explore Networking and the Internet. Your teacher monitors this classroom live while you take the quiz.</p><div class="quest-facts"><span class="pill">' + TOTAL + ' MULTIPLE CHOICE</span><span class="pill">' + TOTAL + ' POINTS</span><span class="pill">ONE STUDENT</span></div><div class="mascot-intro"><img class="mascot" src="./assets/slime.webp" alt="Friendly pixel slime" width="92" height="92"><p>“I ate the Wi-Fi.<br> It tasted like packets.”<small>— Sir Slimes-a-Lot</small></p></div></div><div class="panel"><p class="eyebrow">ENTER THE CLASSROOM</p><h2>Got your room code?</h2><p class="subtle">Use the quiz link and code your teacher shared.</p>' +
      (previous ? '<div class="notice"><strong>Saved attempt found</strong><p>' + esc(previous.student.name) + ' · ' + esc(previous.room.section) + ' · ' + esc(previous.room.code) + '</p><button class="primary full" data-action="resume">' + (previous.submitted ? 'OPEN MY RECORDED RESULT' : 'RESUME MY QUIZ') + '</button><button class="text-button full" data-action="clear">DIFFERENT STUDENT / ROOM</button></div>' : '') +
      '<form id="join-form"><label class="field"><span>ROOM CODE</span><input name="roomCode" id="room-code" value="' + esc(roomHint) + '" maxlength="12" required autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="e.g. ABC234"></label><label class="field"><span>FULL NAME</span><input name="name" maxlength="120" required autocomplete="name" placeholder="Name used in your class record"></label><label class="field"><span>STUDENT ID (optional unless your teacher asks)</span><input name="studentId" maxlength="80" autocomplete="off" placeholder="Your student ID"></label><label class="field"><span>PERSONAL STUDENT CODE (when assigned)</span><input name="seatCode" maxlength="40" autocapitalize="characters" autocomplete="off" spellcheck="false" placeholder="Leave blank if no personal code was assigned"><small>This is your individual code, not the room code.</small></label><details><summary>Teacher gave you a device-recovery code?</summary><label class="field"><span>ONE-TIME RECOVERY CODE</span><input name="recoveryCode" maxlength="40" autocomplete="off" autocapitalize="characters" spellcheck="false"><small>Use only when moving your existing attempt to another browser or device. Your answers are not reset.</small></label></details><div id="form-error" class="notice error join-error" role="alert" hidden></div><button class="primary full" id="join-button" type="submit">JOIN LIVE CLASSROOM →</button></form><p class="hint">Join first. Your teacher starts the timer for the class. Answer choices are shuffled; use their text, not another student’s letters.</p><p class="private-note">Your teacher sees your name, saved-answer progress, connection status, and scores. A background-tab indicator is not proof of cheating. Section records expire after 7 days.</p><p class="service-line">LIVE v6 · Server: <code>' + esc(API.label) + '</code></p></div></section>';
    notice();
  }
  async function join(form) {
    if (joining) return;
    var err = document.getElementById('form-error'), button = document.getElementById('join-button');
    if (previous) { err.hidden = false; err.textContent = 'Resume your saved attempt above, or choose DIFFERENT STUDENT / ROOM first.'; return; }
    joining = true; button.disabled = true; button.textContent = 'CONNECTING…'; err.hidden = true;
    var values = new FormData(form), room = String(values.get('roomCode') || '').trim().toUpperCase();
    try {
      var tokenKey = key + ':device:' + room;
      var token = store.get(tokenKey); if (!token) { token = C.uid(32); store.set(tokenKey, token); }
      var data = {roomCode:room, name:values.get('name'), studentId:values.get('studentId'), seatCode:values.get('seatCode'), recoveryCode:values.get('recoveryCode'), visible:true};
      var snapshot = await API.call('join', data, token);
      state = {schema:5, bankId:cfg.bankId, attemptId:snapshot.attempt.id, token:token, room:snapshot.room, student:snapshot.attempt.student, answers:{}, questions:[], revision:0, serverRevision:0, index:0, flags:[], submitted:false, pendingSubmit:false, conflict:false};
      claim(true); apply(snapshot, true); schedule(50);
    } catch (e) { err.hidden = false; err.textContent = e.message; online = false; notice(); }
    finally { joining = false; if (document.contains(button)) { button.disabled = false; button.textContent = 'JOIN LIVE CLASSROOM →'; } }
  }
  function renderState() {
    if (!state) return renderEntry();
    if (state.submitted) return renderResult();
    if (state.pendingSubmit) return renderPending();
    if (state.room.status !== 'running' || !state.questions.length) return renderWaiting();
    renderQuiz();
  }
  function renderWaiting() {
    view = 'waiting';
    main.innerHTML = '<section class="center-wrap panel wait-hero"><img class="mascot" src="./assets/slime.webp" alt="Pixel slime" width="88" height="88"><p class="eyebrow">LIVE CLASSROOM · ' + esc(state.room.code) + '</p><h1 style="font-size:2rem">You’re in, ' + esc(state.student.name) + '.</h1><p>' + esc(state.room.section) + '</p><div class="notice"><span class="spinner" aria-hidden="true"></span>' + (state.room.status === 'running' ? 'Loading your quiz questions…' : 'Waiting for your teacher to start') + '</div><p class="subtle">Your teacher can see that you joined. The quiz opens automatically here.</p><div class="stats"><div class="stat"><strong>' + TOTAL + '</strong><span>multiple choice</span></div><div class="stat"><strong>' + state.room.durationMinutes + '</strong><span>minutes</span></div><div class="stat"><strong>1</strong><span>individual attempt</span></div></div><button class="secondary" data-action="retry">CHECK CONNECTION</button><p class="hint">Keep this page open. After a refresh, choose RESUME MY QUIZ.</p></section>';
    window.scrollTo(0, 0);
  }
  function visualHTML(q) {
    var v = q && q.visual ? q.visual : {}, scene = String(v.scene || 'network').replace(/[^a-z0-9-]/g,''), cap = esc(v.caption || 'PACKETS IN MOTION');
    return '<div class="question-visual scene-' + scene + '" aria-hidden="true"><div class="scene-grid"></div><div class="scene-wire wire-a"></div><div class="scene-wire wire-b"></div><div class="scene-node n1"><span>01</span></div><div class="scene-node n2"><span>10</span></div><div class="scene-node n3"><span>11</span></div><div class="scene-core"><span></span></div><i class="packet p1"></i><i class="packet p2"></i><i class="packet p3"></i><div class="scene-symbol"></div><div class="scene-caption">' + cap + '</div></div>';
  }
  function renderQuiz() {
    view = 'quiz'; state.index = Math.max(0, Math.min(TOTAL-1, state.index || 0));
    var q = state.questions[state.index]; if (!q) return renderWaiting();
    main.innerHTML = '<section class="quiz-layout"><div class="quiz-main"><div class="quiz-topline"><div class="student-badge"><strong>' + esc(state.student.name) + '</strong><small>' + esc(state.room.section) + ' · Room ' + esc(state.room.code) + '</small></div><div><span class="timer-label">TIME LEFT</span><span id="timer" class="timer">--:--</span></div></div><div class="progress-track" role="progressbar" aria-label="Answers selected" aria-valuemin="0" aria-valuemax="' + TOTAL + '"><span id="progress-fill"></span></div><article class="question-panel"><div class="question-meta"><span>QUESTION ' + (state.index+1) + ' / ' + TOTAL + '</span><span class="topic">' + esc(q.topic) + '</span></div>' + visualHTML(q) + '<h2 id="question-title" tabindex="-1">' + esc(q.prompt) + '</h2><fieldset class="answers" aria-labelledby="question-title"><legend class="visually-hidden">Choose one answer</legend>' + q.options.map(function (o, i) {
      var chosen = state.answers[q.id] === o.id;
      return '<label class="answer' + (chosen ? ' selected' : '') + '"><input type="radio" name="choice" value="' + esc(o.id) + '" ' + (chosen ? 'checked' : '') + '><span class="answer-letter" aria-hidden="true">' + String.fromCharCode(65+i) + '</span><span class="answer-text">' + esc(o.text) + '</span></label>';
    }).join('') + '</fieldset><div class="question-tools"><button class="text-button" id="flag-button" data-action="flag" aria-pressed="false">☆ FLAG FOR REVIEW</button><span class="hint">One answer · 1 point</span></div></article><div class="nav-actions"><button class="secondary" data-action="previous" ' + (state.index === 0 ? 'disabled' : '') + '>← PREVIOUS</button><button class="primary" data-action="next">' + (state.index === TOTAL-1 ? 'REVIEW QUIZ →' : 'NEXT →') + '</button></div><p id="save-status" class="save-status" role="status"></p></div><aside class="quiz-aside"><h3>Your packet trail</h3><p id="answered-count"></p><nav id="question-grid" class="question-grid" aria-label="Go to question">' + state.questions.map(function (item, i) {
      return '<button class="qdot" data-action="jump" data-index="' + i + '" aria-label="Question ' + (i+1) + '">' + (i+1) + '</button>';
    }).join('') + '</nav><div class="legend"><span><i></i>Answered</span><span><i class="flag"></i>Flagged</span></div><button class="secondary full" data-action="review">REVIEW & SUBMIT</button><p class="hint">Answers auto-sync to your teacher. Only answers received by the deadline count.</p></aside></section>';
    updateProgress(); tick(); window.scrollTo(0, 0);
    var heading = document.getElementById('question-title'); if (heading) heading.focus({preventScroll:true});
  }
  function updateProgress() {
    if (!state) return;
    var count = Object.keys(state.answers).length, countNode = document.getElementById('answered-count');
    if (countNode) countNode.textContent = count + ' of ' + TOTAL + ' answered';
    var fill = document.getElementById('progress-fill');
    if (fill) { fill.style.width = ((count / TOTAL) * 100) + '%'; fill.parentElement.setAttribute('aria-valuenow', String(count)); }
    document.querySelectorAll('#question-grid .qdot').forEach(function (button, i) {
      var q = state.questions[i], flagged = state.flags.indexOf(q.id) >= 0;
      button.className = 'qdot' + (state.answers[q.id] ? ' answered' : '') + (i === state.index ? ' current' : '') + (flagged ? ' flagged' : '');
      button.setAttribute('aria-label', 'Question ' + (i+1) + (state.answers[q.id] ? ', answered' : ', unanswered') + (flagged ? ', flagged' : ''));
      if (i === state.index) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
    });
    var flag = document.getElementById('flag-button');
    if (flag && state.questions[state.index]) { var active = state.flags.indexOf(state.questions[state.index].id) >= 0; flag.textContent = active ? '★ FLAGGED FOR REVIEW' : '☆ FLAG FOR REVIEW'; flag.setAttribute('aria-pressed', String(active)); }
    var save = document.getElementById('save-status');
    if (save) {
      var pending = state.revision > state.serverRevision;
      save.className = 'save-status' + (pending || !online ? ' warning' : '');
      save.textContent = pending ? (busy ? 'Syncing your latest answers…' : 'Saved on this device · waiting to sync to teacher') : (online ? '✓ Saved to your teacher’s server.' : 'Latest acknowledged answers are recorded. Reconnecting…');
    }
    document.querySelectorAll('input[name="choice"]').forEach(function (input) { input.disabled = tabBlocked || state.conflict || state.pendingSubmit; });
    badge();
  }
  function choose(option) {
    if (!state || state.submitted || state.pendingSubmit || state.conflict || tabBlocked || state.room.status !== 'running') return;
    if (API.verified() && API.now() >= state.room.deadline) { submit(true); return; }
    var q = state.questions[state.index];
    if (!q || !q.options.some(function (o) { return o.id === option; }) || state.answers[q.id] === option) return;
    state.answers[q.id] = option; state.revision++; persist();
    document.querySelectorAll('input[name="choice"]').forEach(function (input) { input.checked = input.value === option; input.closest('.answer').classList.toggle('selected', input.checked); });
    updateProgress(); if (window.PacketAudio) window.PacketAudio.select(); schedule(180);
  }
  function go(index) {
    if (!state || state.pendingSubmit || state.submitted) return;
    state.index = Math.max(0, Math.min(TOTAL-1, index)); persist(); renderQuiz(); schedule(180);
    var title = document.getElementById('question-title'); if (title) { title.focus({preventScroll:true}); title.scrollIntoView({block:'start', behavior:'auto'}); }
  }
  function renderReview() {
    view = 'review';
    var count = Object.keys(state.answers).length;
    main.innerHTML = '<section class="center-wrap panel"><p class="eyebrow">LAST CHECK BEFORE SUBMISSION</p><h1 style="font-size:2rem">Review your answers.</h1><p>' + count + ' answered · ' + (TOTAL-count) + ' unanswered. You can still change answers before submitting.</p><p>Time left: <strong class="timer" id="timer"></strong></p><div class="actions"><button class="secondary" data-action="back">BACK TO QUIZ</button><button class="primary" id="submit-button" data-action="submit">SUBMIT MY QUIZ</button></div><div class="review-list">' + state.questions.map(function (q, i) {
      var selected = q.options.find(function (o) { return o.id === state.answers[q.id]; });
      return '<div class="review-row"><div><p><strong>' + (i+1) + '.</strong> ' + esc(q.prompt) + '</p><small class="' + (selected ? '' : 'missing') + '">' + (selected ? esc(selected.text) : 'Not answered') + (state.flags.indexOf(q.id) >= 0 ? ' · ★ Flagged' : '') + '</small></div><button class="text-button" data-action="jump" data-index="' + i + '">EDIT</button></div>';
    }).join('') + '</div><div class="actions"><button class="secondary" data-action="back">BACK TO QUIZ</button><button class="primary" data-action="submit">SUBMIT MY QUIZ</button></div><p class="hint">Your score is calculated by the live server, not by this browser.</p></section>';
    tick(); window.scrollTo(0, 0);
  }
  function submit(automatic) {
    if (!state || state.submitted || state.pendingSubmit || state.conflict || tabBlocked) return;
    if (!automatic && !window.confirm('Submit your quiz now? ' + (TOTAL - Object.keys(state.answers).length) + ' unanswered. Once recorded, answers cannot be changed.')) return;
    state.pendingSubmit = true; persist(); renderPending(); schedule(0);
  }
  function renderPending() {
    view = 'pending';
    main.innerHTML = '<section class="center-wrap panel pending-panel"><p class="eyebrow">FINAL ANSWER SYNC</p><h1 style="font-size:2rem">Confirming your submission…</h1><p>Keep this page open until your recorded score appears.</p><div class="notice"><strong>Not yet confirmed.</strong> The game will retry automatically. Do not start another attempt.</div><button class="primary" data-action="retry">RETRY NOW</button><p class="hint">The server accepts each submission only once. A repeated request cannot create a duplicate grade. Answers that did not reach the server before the deadline cannot be added afterward.</p></section>';
  }
  function resultText() {
    var r = state.receipt;
    return ['PACKET QUEST — SERVER-RECORDED RESULT', r.student.name, 'Section: ' + r.student.section, 'Room: ' + r.roomCode, 'Score: ' + r.score + ' / ' + r.total, 'Submitted: ' + new Date(r.submittedAt).toLocaleString(), 'Attempt: ' + r.attemptId].join('\n');
  }
  function renderResult() {
    view = 'result'; clearTimeout(pollTimer);
    var r = state.receipt;
    if (!r) { state.submitted = false; state.pendingSubmit = true; renderPending(); schedule(0); return; }
    if (window.PacketAudio && window.PacketAudio.finish) window.PacketAudio.finish();
    main.innerHTML = '<section class="center-wrap panel"><div class="result-heading"><img src="./assets/slime.webp" class="mascot" alt="Pixel slime" width="80" height="80"><div><p class="eyebrow">QUEST COMPLETE / LIVE RECORD</p><h1 style="font-size:2rem">Your score is recorded.</h1></div></div><p>' + esc(r.student.name) + ' · ' + esc(r.student.section) + '</p><div class="score" id="final-score">' + r.score + ' <small>/ ' + r.total + '</small></div><div class="notice"><strong>Submitted to your teacher.</strong> This result is stored on the quiz server and appears in the live dashboard. Once this recorded-score screen appears, your teacher already has your result; you may leave Google Meet when your teacher permits it.</div>' + (r.reason === 'time' ? '<p class="hint">Time expired. The server graded the answers it received before the deadline.</p>' : r.reason === 'teacher' ? '<p class="hint">Your teacher ended the session. The server graded your saved answers.</p>' : '') + '<dl class="receipt-meta"><dt>Room</dt><dd>' + esc(r.roomCode) + '</dd><dt>Answered</dt><dd>' + r.answered + ' / ' + r.total + '</dd><dt>Submitted</dt><dd>' + esc(new Date(r.submittedAt).toLocaleString()) + '</dd><dt>Time used</dt><dd>' + C.timeText(r.submittedAt-r.startedAt) + '</dd><dt>Attempt ID</dt><dd class="code">' + esc(r.attemptId) + '</dd></dl><div class="actions"><button class="primary" data-action="download">SAVE MY RECEIPT</button><button class="secondary" data-action="copy">COPY RESULT</button></div><textarea id="copy-result" class="copy-area" readonly hidden aria-label="Result text to copy"></textarea><p class="hint">A screenshot is also fine for your own copy. You do not need to upload a file for live teacher monitoring.</p><details><summary>Shared device?</summary><p>Save your receipt before clearing this browser. This does not delete your teacher’s record.</p><button class="text-button" data-action="clear">CLEAR THIS BROWSER</button></details></section>';
    window.scrollTo(0, 0); notice();
  }
  function tick() {
    if (!state || state.submitted || state.room.status !== 'running') return;
    var remaining = state.room.deadline - API.now(), element = document.getElementById('timer');
    if (element) { element.textContent = C.timeText(remaining); element.classList.toggle('urgent', remaining < 60000); }
    if (remaining <= 0 && API.verified() && !tabBlocked && !state.conflict) submit(true);
  }
  function handleAction(e) {
    var button = e.target.closest('[data-action]'); if (!button || button.disabled) return;
    var action = button.dataset.action;
    if (action === 'resume') { state = readSaved(); if (!state) return renderEntry(); error = ''; info = ''; claim(false); renderState(); persist(); schedule(0); notice(); return; }
    if (action === 'clear') {
      if (!window.confirm('Clear only this browser’s saved attempt? The teacher’s record will remain. Use the same browser to resume, or ask your teacher for a recovery code.')) return;
      var cleared = state || previous; if (cleared && cleared.submitted) store.remove(key + ':device:' + cleared.room.code); release(); clearTimeout(pollTimer); store.remove(key); state = null; previous = null; info = ''; error = ''; tabBlocked = false; renderEntry(); return;
    }
    if (action === 'retry') { if (state) schedule(0); else health(); return; }
    if (action === 'take-tab') { claim(true); if (state) { state.conflict = false; needsFresh = true; } updateProgress(); schedule(0); return; }
    if (action === 'server-copy') { if (window.confirm('Load the server-saved answers? This replaces conflicting local choices.')) { needsFresh = true; schedule(0); } return; }
    if (!state) return;
    if (action === 'previous') go(state.index-1);
    if (action === 'next') { if (state.index === TOTAL-1) renderReview(); else go(state.index+1); }
    if (action === 'jump') go(Number(button.dataset.index));
    if (action === 'back') renderQuiz();
    if (action === 'review') renderReview();
    if (action === 'flag') { var q = state.questions[state.index], index = state.flags.indexOf(q.id); if (index >= 0) state.flags.splice(index,1); else state.flags.push(q.id); persist(); updateProgress(); }
    if (action === 'submit') submit(false);
    if (action === 'download') { C.download('PacketQuest_' + state.room.code + '_' + state.attemptId.slice(0,8) + '.json', JSON.stringify(state.receipt,null,2), 'application/json'); C.toast('Your teacher already has this result. Save this receipt for yourself.'); }
    if (action === 'copy') C.copy(resultText(), document.getElementById('copy-result'));
  }
  document.addEventListener('click', handleAction);
  main.addEventListener('submit', function (e) { if (e.target.id === 'join-form') { e.preventDefault(); join(e.target); } });
  main.addEventListener('change', function (e) { if (e.target.name === 'choice') choose(e.target.value); });
  document.addEventListener('keydown', function (e) {
    if (view !== 'quiz' || !state || e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.target.matches('textarea,input:not([type="radio"]),select,[contenteditable="true"]')) return;
    if (/^[1-4]$/.test(e.key)) { e.preventDefault(); choose(state.questions[state.index].options[Number(e.key)-1].id); }
  });
  document.getElementById('sound-toggle').addEventListener('click', async function () {
    try { var on = await window.PacketAudio.toggle(); this.textContent = on ? 'BGM on' : 'BGM off'; this.setAttribute('aria-pressed',String(on)); } catch (e) { C.toast(e.message); }
  });
  (function setAdaptiveEffects(){
    var low = false;
    try {
      low = !!(navigator.connection && navigator.connection.saveData) ||
            (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 2) ||
            (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 2) ||
            (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {}
    if (low) document.body.classList.add('ultra-low');
  }());
  document.getElementById('motion-toggle').addEventListener('click', function () {
    var on = !document.body.classList.contains('lively');
    document.body.classList.toggle('lively', on);
    if (on) document.body.classList.remove('ultra-low');
    this.textContent = on ? 'Effects: on' : 'Effects: low';
    this.setAttribute('aria-pressed', String(on));
  });
  window.addEventListener('online', function () { if (state) schedule(0); else health(); });
  window.addEventListener('offline', function () { online = false; notice(); });
  document.addEventListener('visibilitychange', function () { persist(); if (!tabBlocked && state && !state.submitted) schedule(0); });
  window.addEventListener('pagehide', function () {
    persist(); release();
    if (state && !state.submitted && !state.pendingSubmit && !state.conflict && !tabBlocked && state.room.status === 'running' && state.revision > state.serverRevision) {
      API.call('save', {attemptId:state.attemptId, answers:state.answers, revision:state.revision, visible:false, currentPosition:state.index+1}, state.token, true).catch(function () {});
    }
  });
  window.addEventListener('pageshow', function (e) { if (e.persisted && state) { claim(false); schedule(0); } });
  window.addEventListener('storage', function (e) {
    if (state && e.key === leaseKey() && e.newValue) {
      try { var lease = JSON.parse(e.newValue); if (lease.owner !== tab) { tabBlocked = true; clearTimeout(pollTimer); notice(); updateProgress(); } } catch (err) {}
    }
  });
  setInterval(tick, 1000);
  setInterval(function () { if (state && !state.submitted && !tabBlocked) claim(false); }, 5000);
  if(!API.configured) renderNoBackend(); else { renderEntry(); health(); }
}());
