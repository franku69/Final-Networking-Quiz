/* Live teacher dashboard. Never import student-owned files as official grades. */
(function () {
  'use strict';
  var C = window.PacketCore, API = window.PacketAPI, esc = C.escapeHTML, cfg = window.PACKET_CONFIG, TOTAL = window.PACKET_CONFIG.questionCount || 30;
  var main = document.getElementById('main'), notices = document.getElementById('notices'), connection = document.getElementById('connection');
  var authKey = 'pq-live-v7-teacher:' + (API.base || location.origin), selectionKey = authKey + ':room';
  var token = '', rooms = [], selected = '', snapshot = null, timer = null, pollBusy = false;
  var error = '', online = false, lastSuccess = 0, studentBase = '', search = '', filter = 'all';
  var createRequest = null, extendRequest = null, rowNodes = new Map(), actionBusy = false;
  try { token = sessionStorage.getItem(authKey) || ''; selected = sessionStorage.getItem(selectionKey) || ''; } catch (e) {}
  function sessionSave() { try { if (token) sessionStorage.setItem(authKey, token); else sessionStorage.removeItem(authKey); sessionStorage.setItem(selectionKey, selected); } catch (e) {} }
  function showError(message) { error = message || ''; renderNotice(); }
  function renderNotice() {
    var html = error ? '<div class="notice error" role="alert"><strong>' + (online ? 'Please check: ' : 'Live connection interrupted: ') + '</strong>' + esc(error) + '<div class="banner-actions"><button class="secondary" data-action="retry">RECONNECT</button></div></div>' : '';
    if (notices.innerHTML !== html) notices.innerHTML = html;
    connection.textContent = online ? 'LIVE CONNECTED' : 'NOT CONNECTED';
    connection.className = 'live-pill' + (online ? '' : ' bad');
    var status = document.getElementById('dashboard-sync');
    if (status) { status.textContent = online ? 'Live updates about every 2 seconds · Last confirmed ' + new Date(lastSuccess).toLocaleTimeString() : 'NOT LIVE — showing the last confirmed snapshot. Reconnect before relying on these values.'; status.classList.toggle('stale', !online); }
  }
  function renderBackendSetup() {
    online = false; error = '';
    main.innerHTML = '<section class="center-wrap panel"><p class="eyebrow">TEACHER / GITHUB PAGES + LIVE CRM</p><h1 style="font-size:2.3rem">Connect your quiz backend once.</h1><p class="subtle">GitHub Pages hosts the game. The live backend stores student names, progress, and server-graded scores. After pairing, room links automatically carry the backend address to students.</p><form id="backend-form"><label class="field"><span>LIVE BACKEND HTTPS URL</span><input id="backend-url" name="backend" type="url" required inputmode="url" placeholder="https://your-packet-quest-backend.example.com"></label><button class="primary full" type="submit">TEST & CONNECT BACKEND</button></form><div class="info-card"><h3>Students still receive one link.</h3><p class="hint">After you create a room, COPY ROOM LINK produces one GitHub Pages link containing the room and backend connection. Students simply tap that link from Google Meet.</p></div><p class="private-note">Never enter your teacher key in this backend field. The backend URL is public; your teacher key remains private.</p></section>';
    renderNotice();
  }
  async function call(action, data) {
    try { var result = await API.call(action, data, token); online = true; lastSuccess = Date.now(); return result; }
    catch (e) { online = false; if (e.code === 'teacher_login') { token = ''; sessionSave(); clearTimeout(timer); renderLogin(); } throw e; }
  }
  function renderLogin() {
    main.innerHTML = '<section class="center-wrap panel"><p class="eyebrow">TEACHER / LIVE CLASSROOM</p><h1 style="font-size:2.3rem">Your class. In real time.</h1><p class="subtle">See students join, follow saved-answer progress, and receive server-graded scores automatically.</p><form id="login-form"><label class="field"><span>PRIVATE TEACHER KEY</span><input id="teacher-key" name="key" type="password" required autocomplete="current-password" placeholder="Your private Packet Quest teacher key"></label><button class="primary full" type="submit">OPEN LIVE DASHBOARD</button></form><p class="private-note">Keep this key private. Students never need it.</p><p class="service-line">GitHub Pages frontend · Backend: <code>' + esc(API.label) + '</code> · <button class="text-button" type="button" data-action="backend">CHANGE BACKEND</button></p></section>';
    renderNotice();
  }
  function renderShell() {
    rowNodes.clear();
    main.innerHTML = '<section class="teacher-layout"><aside class="panel teacher-sidebar"><div><div class="split"><p class="eyebrow">TEACHER DESK</p><button class="text-button" data-action="logout">SIGN OUT</button></div><h2>Create a live classroom.</h2><form id="create-form"><label class="field"><span>SECTION / CLASS</span><input name="section" maxlength="80" required placeholder="e.g. BSIT 1A"></label><label class="field"><span>TIME LIMIT (minutes)</span><input name="durationMinutes" type="number" min="1" max="180" step="1" value="30" required></label><details><summary>Optional roster / personal codes</summary><label class="field"><span>STUDENT ID,FULL NAME (one per line)</span><textarea name="roster" rows="5" placeholder="2026-001,Juan Dela Cruz&#10;2026-002,Maria Santos"></textarea><small>No header. Download generated personal codes after creating the room and distribute each privately.</small></label></details><label class="checkbox-line"><input type="checkbox" name="allowLateJoin" checked> Allow late joiners until the deadline</label><button class="primary full" type="submit" id="create-button">CREATE LIVE ROOM</button></form></div><div><label class="field" style="margin-top:20px"><span>YOUR ROOMS</span><select id="room-select"><option value="">Choose a room</option></select></label><button class="secondary full" data-action="rooms">REFRESH ROOMS</button><div class="info-card" style="margin-top:18px"><h3>Correct question set</h3><p class="hint">CS111 Topic 4 · Networking and the Internet<br><strong>' + TOTAL + ' MCQ / ' + TOTAL + ' points</strong><br>Based on your uploaded study guide.</p><button class="text-button" data-action="answer-key">DOWNLOAD ANSWER KEY</button></div></div><div class="sidebar-footer"><p class="private-note">Section records are saved on the server disk and retained for up to 7 days. Export your scores after class. Keep the live backend online throughout the quiz.</p><p class="service-line">GITHUB LIVE v7.1 · <code>' + esc(API.label) + '</code> · <button class="text-button" type="button" data-action="backend">CHANGE BACKEND</button></p></div></aside><section class="panel" id="dashboard"><p class="eyebrow">LIVE MONITOR</p><h2>Ready for your students.</h2><p>Create or select a room. Share its link, wait for students to join, then start the quiz.</p><div class="empty">No classroom selected.</div></section></section>';
    updateRooms(); if (snapshot) mountDashboard(); renderNotice();
  }
  function updateRooms() {
    var select = document.getElementById('room-select'); if (!select) return;
    select.innerHTML = '<option value="">Choose a room</option>' + rooms.map(function (r) { return '<option value="' + esc(r.code) + '">' + esc(r.section) + ' · ' + esc(r.code) + ' · ' + esc(r.status) + '</option>'; }).join('');
    select.value = selected;
  }
  function defaultStudentURL() {
    if (cfg.siteBase) { try { return new URL(cfg.siteBase, location.href).href; } catch (e) {} }
    try { var url = new URL('../', location.href); url.search = ''; url.hash = ''; return url.href; }
    catch (e) { return location.href; }
  }
  function mountDashboard() {
    rowNodes.clear(); search = ''; filter = 'all';
    var root = document.getElementById('dashboard'); if (!root || !snapshot) return;
    root.innerHTML = '<div class="dashboard-top"><div><p class="eyebrow" id="room-status"></p><h2 id="section-title"></h2></div><span class="pill">LIVE · ' + TOTAL + ' MCQ</span></div><div class="room-line"><div class="room-code" id="display-room-code"></div><div><span class="timer-label">TIME LEFT</span><span class="timer" id="room-timer">--:--</span></div></div><div class="dashboard-metrics"><div class="stat"><strong id="joined-count">0</strong><span>joined</span></div><div class="stat"><strong id="active-count">0</strong><span>active / waiting</span></div><div class="stat"><strong id="submitted-count">0</strong><span>submitted</span></div><div class="stat"><strong id="reconnect-count">0</strong><span>reconnecting</span></div></div><div class="teacher-actions"><button class="primary" id="start-room" data-action="start">START FOR EVERYONE</button><button class="secondary" id="extend-room" data-action="extend">ADD 5 MINUTES</button><button class="danger" id="end-room" data-action="end">END & GRADE</button></div><label class="field"><span>STUDENT PAGE URL</span><input id="student-url" type="url" value="' + esc(defaultStudentURL()) + '"><small>Share the public HTTPS link for Google Meet students. Do not share localhost or 127.0.0.1 with other devices.</small></label><div class="teacher-actions"><button class="secondary" data-action="copy-link">COPY ROOM LINK</button><button class="secondary" data-action="codes">DOWNLOAD STUDENT CODES</button><button class="secondary" data-action="export-csv">EXPORT SCORES CSV</button><button class="secondary" data-action="export-json">SAVE FULL RECORD</button></div><textarea id="link-copy" class="copy-area small" readonly hidden aria-label="Room link to copy"></textarea><p class="sync-detail" id="dashboard-sync"></p><div class="live-toolbar"><label class="field"><span>FIND A STUDENT</span><input id="student-search" type="search" placeholder="Name or student ID" autocomplete="off"></label><label class="field"><span>SHOW</span><select id="status-filter"><option value="all">Everyone</option><option value="unfinished">Not submitted</option><option value="submitted">Submitted</option><option value="reconnecting">Reconnecting</option><option value="background">Background tab</option></select></label><button class="secondary" data-action="refresh">REFRESH NOW</button></div><div class="table-scroll" tabindex="0" aria-label="Live student records; scroll horizontally on narrow screens"><table class="records-table"><thead><tr><th>STUDENT</th><th>STATUS</th><th>PROGRESS</th><th>SCORE</th><th>LAST CONTACT / SUBMITTED</th><th>DEVICE HELP</th></tr></thead><tbody id="student-rows"></tbody></table></div><p class="hint" id="visible-count"></p><p class="private-note">Live scores are provisional until submission. Progress means answers saved on the server, not unsynced taps on a phone. “Background tab” can mean an app switch or a locked screen; it is not proof of cheating.</p><details class="danger-zone"><summary>Delete this room after exporting</summary><p class="hint">Deleting removes this room and all its student records from the live server. Export first.</p><button class="danger" data-action="delete">DELETE ROOM RECORDS</button></details>';
    paintDashboard();
  }
  function tdSet(td, html) { if (td.innerHTML !== html) td.innerHTML = html; }
  function paintDashboard() {
    if (!snapshot || !document.getElementById('student-rows')) return;
    var r = snapshot.room, rows = snapshot.students, tbody = document.getElementById('student-rows');
    document.getElementById('room-status').textContent = r.status.toUpperCase() + ' / LIVE CLASSROOM';
    document.getElementById('section-title').textContent = r.section;
    document.getElementById('display-room-code').textContent = r.code;
    document.getElementById('joined-count').textContent = rows.length;
    document.getElementById('active-count').textContent = rows.filter(function (x) { return x.status === 'active' || x.status === 'waiting'; }).length;
    document.getElementById('submitted-count').textContent = rows.filter(function (x) { return x.submitted; }).length;
    document.getElementById('reconnect-count').textContent = rows.filter(function (x) { return x.status === 'reconnecting'; }).length;
    document.getElementById('start-room').disabled = r.status !== 'waiting' || actionBusy;
    document.getElementById('extend-room').disabled = r.status !== 'running' || actionBusy;
    document.getElementById('end-room').disabled = r.status === 'ended' || actionBusy;
    var liveIDs = new Set(), shown = 0;
    rows.forEach(function (s) {
      liveIDs.add(s.attemptId);
      var tr = rowNodes.get(s.attemptId);
      if (!tr) { tr = document.createElement('tr'); tr.dataset.attempt = s.attemptId; for (var i=0;i<6;i++) tr.appendChild(document.createElement('td')); rowNodes.set(s.attemptId,tr); tbody.appendChild(tr); }
      var name = (s.student.name + ' ' + s.student.studentId).toLowerCase();
      var visible = name.indexOf(search.toLowerCase()) >= 0 && (filter === 'all' || (filter === 'unfinished' ? !s.submitted : s.status === filter));
      tr.hidden = !visible; if (visible) shown++;
      tdSet(tr.children[0], '<strong class="student-name">' + esc(s.student.name) + '</strong><small>' + esc(s.student.studentId || 'No student ID') + '</small>');
      var labels = {active:'Active',waiting:'Waiting',background:'Background tab',reconnecting:'Reconnecting',submitted:'Submitted'};
      tdSet(tr.children[1], '<span class="status-dot ' + esc(s.status) + '">' + esc(labels[s.status] || s.status) + '</span>');
      tdSet(tr.children[2], '<strong>' + s.answered + ' / ' + TOTAL + ' saved</strong><div class="mini-progress"><span style="width:' + s.answered*5 + '%"></span></div><small>' + (s.submitted ? 'Completed' : (s.currentPosition ? 'Viewing item ' + s.currentPosition : 'Waiting / reviewing')) + '</small>');
      tdSet(tr.children[3], '<strong class="record-score' + (s.submitted ? '' : ' provisional') + '">' + (s.submitted ? s.score : s.liveScore) + ' / ' + TOTAL + '</strong><small>' + (s.submitted ? 'FINAL' : 'PROVISIONAL') + '</small>');
      tdSet(tr.children[4], s.submittedAt ? '<strong>' + esc(new Date(s.submittedAt).toLocaleTimeString()) + '</strong><small>' + esc(new Date(s.submittedAt).toLocaleDateString()) + '</small>' : '<span>' + Math.max(0,Math.round((API.now()-s.lastSeen)/1000)) + 's ago</span><small>' + esc(new Date(s.lastSeen).toLocaleTimeString()) + '</small>');
      tdSet(tr.children[5], '<button class="text-button row-focus" data-action="recovery" data-id="' + esc(s.attemptId) + '">RECOVERY CODE</button>');
    });
    rowNodes.forEach(function (node,id) { if (!liveIDs.has(id)) { node.remove(); rowNodes.delete(id); } });
    var empty = document.getElementById('empty-students');
    if (!rows.length) { if (!empty) { empty=document.createElement('tr');empty.id='empty-students';empty.className='empty-table';empty.innerHTML='<td colspan="6">Share the room link. Students will appear here automatically as they join.</td>';tbody.appendChild(empty); } }
    else if (empty) empty.remove();
    document.getElementById('visible-count').textContent = shown + ' of ' + rows.length + ' students shown';
    tick(); renderNotice();
  }
  function tick() {
    var clock = document.getElementById('room-timer'); if (!clock || !snapshot) return;
    clock.textContent = snapshot.room.status === 'waiting' ? snapshot.room.durationMinutes + ' min' : (snapshot.room.status === 'ended' ? 'ENDED' : C.timeText(snapshot.room.deadline-API.now()));
  }
  async function loadRooms() {
    var data = await call('teacher_rooms'); rooms = data.rooms; studentBase = data.studentBase || studentBase; updateRooms();
    if (selected && !rooms.some(function (r) { return r.code === selected; })) { selected = ''; snapshot = null; sessionSave(); renderShell(); }
  }
  async function poll() {
    clearTimeout(timer);
    if (!token || !selected || pollBusy) return;
    pollBusy = true; var code = selected;
    try {
      var data = await call('teacher_dashboard', {roomCode:code});
      if (selected !== code || !token) return;
      if (snapshot && snapshot.room.code === code && snapshot.serverTime > data.serverTime) return;
      var fresh = !snapshot || snapshot.room.code !== code;
      snapshot = data; studentBase = data.studentBase || studentBase; error = '';
      var roomIndex = rooms.findIndex(function (r) { return r.code === code; }); if (roomIndex >= 0) rooms[roomIndex] = data.room;
      if (fresh) mountDashboard(); else paintDashboard();
    } catch (e) { error = e.message; renderNotice(); }
    finally { pollBusy = false; if (token && selected) timer = setTimeout(poll, document.hidden ? 10000 : (online ? 2500 : 6000)); }
  }
  async function bootstrap() {
    try { var data = await call('teacher_info'); rooms = data.rooms; studentBase = data.studentBase || ''; error = ''; renderShell(); if (selected) poll(); }
    catch (e) { error = e.message; renderLogin(); }
  }
  async function mutate(action, data) {
    if (actionBusy) return;
    actionBusy = true; paintDashboard();
    try { var result = await call(action, Object.assign({roomCode:selected},data||{})); error = ''; if (result.room && result.room.code === selected && (!snapshot || snapshot.serverTime <= result.serverTime)) { snapshot = result; paintDashboard(); } await loadRooms(); return result; }
    catch (e) { error = e.message; renderNotice(); }
    finally { actionBusy=false; paintDashboard(); }
  }
  function csvRows() {
    var rows = [['Student name','Student ID','Section','Room','Status','Saved answers','Final score','Provisional score','Total','Submitted at','Time used (seconds)','Last contact','Attempt ID']];
    snapshot.students.forEach(function (s) { rows.push([s.student.name,s.student.studentId,s.student.section,snapshot.room.code,s.status,s.answered,s.submitted?s.score:'',s.liveScore,TOTAL,s.submittedAt?new Date(s.submittedAt).toISOString():'',s.submittedAt?Math.max(0,Math.round((s.submittedAt-s.startedAt)/1000)):'',new Date(s.lastSeen).toISOString(),s.attemptId]); });
    return rows;
  }
  function dialog(title, html) {
    var existing=document.getElementById('live-dialog'); if(existing)existing.remove();
    var modal=document.createElement('div');modal.id='live-dialog';modal.className='alert-dialog';modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-labelledby','dialog-title');
    modal.innerHTML='<div class="panel"><h2 id="dialog-title">'+esc(title)+'</h2>'+html+'<button class="primary full" data-action="close-dialog">CLOSE</button></div>';document.body.appendChild(modal);modal.querySelector('button').focus();
  }
  document.addEventListener('submit', async function (e) {
    if (e.target.id==='backend-form') {
      e.preventDefault(); var backendButton=e.target.querySelector('button'); backendButton.disabled=true;
      try { var nextBase=new FormData(e.target).get('backend'); await API.test(nextBase); API.configure(nextBase); }
      catch(err){ error=err.message; online=false; renderNotice(); backendButton.disabled=false; }
      return;
    }
    if (e.target.id==='login-form') {
      e.preventDefault();var button=e.target.querySelector('button');button.disabled=true;
      try { var rootKey=new FormData(e.target).get('key');var result=await API.call('teacher_login',{},rootKey);rootKey='';e.target.reset();token=result.token;sessionSave();online=true;error='';await bootstrap(); }
      catch(err){error=err.message;online=false;renderNotice();}
      finally{if(document.contains(button))button.disabled=false;}
    }
    if (e.target.id==='create-form') {
      e.preventDefault();if(actionBusy)return;
      var form=e.target,values=new FormData(form),payload={section:values.get('section'),durationMinutes:Number(values.get('durationMinutes')),roster:values.get('roster')||'',allowLateJoin:values.get('allowLateJoin')==='on'};
      var signature=JSON.stringify(payload);if(!createRequest||createRequest.signature!==signature)createRequest={id:C.uid(),signature:signature};payload.requestId=createRequest.id;
      actionBusy=true;document.getElementById('create-button').disabled=true;
      try { var data=await call('teacher_create',payload);createRequest=null;selected=data.room.code;snapshot=data;sessionSave();error='';await loadRooms();mountDashboard();clearTimeout(timer);poll();C.toast('Live room created. Share the room link, then start when your students are ready.'); }
      catch(err){error=err.message;renderNotice();}
      finally{actionBusy=false;var b=document.getElementById('create-button');if(b)b.disabled=false;paintDashboard();}
    }
  });
  document.addEventListener('change',function(e){
    if(e.target.id==='room-select'){selected=e.target.value;snapshot=null;sessionSave();clearTimeout(timer);rowNodes.clear();if(selected){document.getElementById('dashboard').innerHTML='<p>Loading live room…</p>';poll();}else renderShell();}
    if(e.target.id==='status-filter'){filter=e.target.value;paintDashboard();}
  });
  document.addEventListener('input',function(e){if(e.target.id==='student-search'){search=e.target.value;paintDashboard();}});
  document.addEventListener('click', async function(e){
    var button=e.target.closest('[data-action]');if(!button||button.disabled)return;var action=button.dataset.action;
    if(action==='close-dialog'){document.getElementById('live-dialog').remove();return;}
    if(action==='backend'){if(window.confirm('Change the live backend for this browser? Sign in again after reconnecting.'))API.forget();return;}
    if(action==='logout'){clearTimeout(timer);try{await call('teacher_logout');}catch(err){}token='';snapshot=null;sessionSave();error='';renderLogin();return;}
    if(action==='retry'){if(token){if(selected)poll();else bootstrap();}else{try{await API.call('info');online=true;error='';}catch(err){online=false;error=err.message;}renderNotice();}return;}
    if(action==='rooms'){try{await loadRooms();error='';}catch(err){error=err.message;}renderNotice();return;}
    if(action==='answer-key'){
      try{var data=await call('teacher_bank');var lines=[data.bank.title,'TEACHER ANSWER KEY — KEEP PRIVATE','Questions and option display order are shuffled for each student. Use question text, not display position.',''];data.bank.questions.forEach(function(q){lines.push(q.number+'. '+q.prompt,q.correct+' — '+q.options.find(function(o){return o.id===q.correct;}).text,'Source: study-guide PDF page '+q.sourcePage,q.explanation,'');});C.download('CS111_Teacher_Answer_Key.txt',lines.join('\n'));}catch(err){showError(err.message);}return;
    }
    if(!snapshot||!selected)return;
    if(action==='refresh'){poll();return;}
    if(action==='start'){if(window.confirm('Start the shared timer for '+snapshot.room.section+' now?'))await mutate('teacher_start');return;}
    if(action==='end'){if(window.confirm('End this room NOW and grade every student’s server-saved answers? This cannot be undone.'))await mutate('teacher_end');return;}
    if(action==='extend'){if(!extendRequest)extendRequest=C.uid();var response=await mutate('teacher_extend',{minutes:5,requestId:extendRequest});if(response)extendRequest=null;return;}
    if(action==='copy-link'){
      try{var url=new URL(document.getElementById('student-url').value);if(!/^https?:$/.test(url.protocol))throw Error('Use an HTTP or HTTPS student page URL.');url.searchParams.set('room',selected);var sharedApi=API.shareBase();if(sharedApi)url.searchParams.set('api',sharedApi);else url.searchParams.delete('api');url.hash='';if(url.hostname==='localhost'||url.hostname==='127.0.0.1')C.toast('Local test link only. Use your GitHub Pages URL for remote students.');await C.copy(url.href,document.getElementById('link-copy'));}catch(err){showError(err.message);}return;
    }
    if(action==='codes'){
      try{var codes=await call('teacher_codes',{roomCode:selected});if(!codes.codes.length){C.toast('This room has no roster. Students join with their name and room code.');return;}var rows=[['Student ID','Full name','Section','Room','Personal student code']];codes.codes.forEach(function(s){rows.push([s.studentId,s.name,s.section,selected,s.code]);});C.download('PRIVATE_Student_Codes_'+selected+'.csv',C.csv(rows),'text/csv;charset=utf-8');}catch(err){showError(err.message);}return;
    }
    if(action==='recovery'){
      try{var recovery=await call('teacher_recovery',{roomCode:selected,attemptId:button.dataset.id});dialog('Device recovery for '+recovery.student.name,'<p>Give this code only to this student. They rejoin with the same room, name/ID, and personal student code, then enter this recovery code under the recovery section.</p><code>'+esc(recovery.recoveryCode)+'</code><p>Valid once for 30 minutes. Saved answers and the final grade are preserved. The previous device loses access after recovery.</p>');}catch(err){showError(err.message);}return;
    }
    if(action==='export-csv'||action==='export-json'){
      try{snapshot=await call('teacher_dashboard',{roomCode:selected});paintDashboard();if(action==='export-csv')C.download('CS111_Scores_'+selected+'.csv',C.csv(csvRows()),'text/csv;charset=utf-8');else C.download('PRIVATE_CS111_Record_'+selected+'.json',JSON.stringify(snapshot,null,2),'application/json');C.toast('Server record exported. Keep it private.');}catch(err){showError('Could not retrieve a fresh export. '+err.message);}return;
    }
    if(action==='delete'){
      var confirmation=window.prompt('Export first. Type '+selected+' to permanently delete this room and its records.');if(confirmation!==selected)return;
      try{await call('teacher_delete',{roomCode:selected,confirmation:confirmation});selected='';snapshot=null;sessionSave();clearTimeout(timer);await loadRooms();renderShell();}catch(err){showError(err.message);}
    }
  });
  document.addEventListener('keydown',function(e){var modal=document.getElementById('live-dialog');if(!modal)return;if(e.key==='Escape'){modal.remove();return;}if(e.key==='Tab'){var targets=modal.querySelectorAll('button,input,a,textarea');if(targets.length===1){e.preventDefault();targets[0].focus();}}});
  window.addEventListener('online',function(){if(token){if(selected)poll();else bootstrap();}});
  window.addEventListener('offline',function(){online=false;error='Internet connection lost. Counts shown are the last confirmed values.';renderNotice();});
  document.addEventListener('visibilitychange',function(){if(!document.hidden&&token&&selected)poll();});
  setInterval(tick,1000);
  if(!API.configured)renderBackendSetup();else if(token)bootstrap();else{renderLogin();API.call('info').then(function(){online=true;error='';renderNotice();}).catch(function(e){error=e.message;renderNotice();});}
}());
