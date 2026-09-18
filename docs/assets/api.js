(function () {
  'use strict';
  var cfg = window.PACKET_CONFIG || {};
  var STORAGE_KEY = 'packet-quest-backend-v1';

  function normalize(value) {
    if (!value) return '';
    try {
      var u = new URL(String(value), location.href);
      u.hash = ''; u.search = '';
      var local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return '';
      if (u.username || u.password) return '';
      var path = u.pathname.replace(/\/+$/, '');
      if (path === '/api/quiz' || path === '/api/packet/v1') path = '';
      u.pathname = path || '/';
      return u.origin + (u.pathname === '/' ? '' : u.pathname);
    } catch (e) { return ''; }
  }

  function safeGet() { try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; } }
  function safeSet(value) { try { localStorage.setItem(STORAGE_KEY, value); return true; } catch (e) { return false; } }
  function queryBase() {
    try {
      var raw = new URL(location.href).searchParams.get('api');
      if (!raw || cfg.allowApiOverride === false) return '';
      return normalize(raw);
    } catch (e) { return ''; }
  }
  function isStaticHost() {
    return /\.github\.io$/i.test(location.hostname) || /\.pages\.dev$/i.test(location.hostname) || /\.netlify\.app$/i.test(location.hostname);
  }

  var fromQuery = queryBase();
  if (fromQuery) safeSet(fromQuery);
  var configured = normalize(cfg.apiBase) || fromQuery || normalize(safeGet());
  var sameOrigin = !isStaticHost() && /^https?:$/.test(location.protocol);
  var base = configured || (sameOrigin ? location.origin : '');
  var stamp = Date.now(), received = performance.now(), verified = false;

  function originLabel() {
    try { return base ? new URL(base).host : 'not configured'; }
    catch (e) { return 'not configured'; }
  }
  function shareBase() {
    if (!base) return '';
    try { return new URL(base).origin === location.origin ? '' : base; }
    catch (e) { return base; }
  }
  async function call(action, data, token, keepalive) {
    if (!base) {
      var e = Error('This GitHub Pages quiz is not paired with a live backend yet. Use the exact room link from your teacher.');
      e.code = 'backend_not_configured'; throw e;
    }
    if (location.protocol === 'https:' && base.indexOf('http:') === 0) throw Error('The live backend must use HTTPS when the quiz page uses HTTPS.');
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timeout = controller ? setTimeout(function () { controller.abort(); }, 20000) : null;
    try {
      var response = await fetch(base + '/api/quiz', {
        method: 'POST', headers: Object.assign({'Content-Type':'application/json'}, token ? {'Authorization':'Bearer ' + token} : {}),
        body: JSON.stringify(Object.assign({}, data || {}, {action:action})), credentials:'omit', cache:'no-store',
        signal:controller ? controller.signal : undefined, keepalive:!!keepalive
      });
      var result;
      try { result = await response.json(); }
      catch (err) { if (response.status >= 500) throw Error('The live quiz server is waking up or temporarily busy. Keep this page open; it will retry.'); throw Error('The configured address is not the Packet Quest live API. Check the backend URL.'); }
      if (!response.ok || result.error) { var error = Error(result.error || 'The request could not be completed.'); error.status = response.status; error.code = result.code; throw error; }
      if (result.bankId && result.bankId !== cfg.bankId) { var mismatch = Error('This server has a different question bank. Do not begin: ask your teacher for the updated quiz link.'); mismatch.code = 'bank_mismatch'; throw mismatch; }
      if (result.serverTime && (!verified || result.serverTime >= stamp)) { stamp = result.serverTime; received = performance.now(); verified = true; }
      return result;
    } catch (e) {
      if (e.name === 'AbortError') throw Error('The live server is taking too long. Pending answers stay on this device; retry before the deadline.');
      if (e instanceof TypeError) throw Error('Cannot reach the live quiz server. Check the Internet connection and keep the exact quiz link open.');
      throw e;
    } finally { clearTimeout(timeout); }
  }
  function configure(value) {
    var next = normalize(value);
    if (!next) throw Error('Enter a valid HTTPS backend URL. Local testing may use http://127.0.0.1 or http://localhost.');
    safeSet(next);
    var u = new URL(location.href); u.searchParams.set('api', next); u.hash = '';
    location.replace(u.href);
  }
  function forget() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    var u = new URL(location.href); u.searchParams.delete('api'); u.hash = '';
    location.replace(u.href);
  }
  async function test(value) {
    var target = normalize(value || base);
    if (!target) throw Error('Enter a backend URL first.');
    var response = await fetch(target + '/healthz', {cache:'no-store', credentials:'omit'});
    var data = await response.json();
    if (!response.ok || !data.live || data.bankId !== cfg.bankId || data.questionCount !== cfg.questionCount) throw Error('That server is reachable, but it is not the matching 30-question Packet Quest backend.');
    return data;
  }

  window.PacketAPI = {
    call:call, base:base, label:originLabel(), configured:!!base, normalizeBase:normalize,
    configure:configure, forget:forget, test:test, shareBase:shareBase,
    now:function () { return stamp + performance.now() - received; }, verified:function () { return verified; }
  };
}());
