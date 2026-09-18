(function (root) {
  'use strict';
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function uid(bytes) {
    if (!window.crypto || !window.crypto.getRandomValues) throw Error('Open this quiz in an updated browser with secure random-number support.');
    var data = new Uint8Array(bytes || 16);
    window.crypto.getRandomValues(data);
    return Array.from(data, function (n) { return ('0' + n.toString(16)).slice(-2); }).join('');
  }
  function safeStore() {
    var fallback = {}, storage = null;
    try { storage = window.localStorage; storage.setItem('__pq5', '1'); storage.removeItem('__pq5'); } catch (e) { storage = null; }
    return {
      available: !!storage,
      get: function (k) { try { return storage ? storage.getItem(k) : (fallback[k] || null); } catch (e) { return fallback[k] || null; } },
      set: function (k, v) { fallback[k] = v; try { if (storage) { storage.setItem(k, v); return true; } } catch (e) { this.available = false; } return false; },
      remove: function (k) { delete fallback[k]; try { if (storage) storage.removeItem(k); } catch (e) {} }
    };
  }
  function timeText(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function csv(rows) {
    return '\ufeff' + rows.map(function (r) { return r.map(function (v) {
      var s = String(v == null ? '' : v);
      if (/^\s*[=+\-@]|^[\t\r]/.test(s)) s = "'" + s;
      return '"' + s.replace(/"/g, '""') + '"';
    }).join(','); }).join('\r\n');
  }
  function download(name, content, mime) {
    var url = URL.createObjectURL(new Blob([content], {type: mime || 'text/plain;charset=utf-8'}));
    var a = document.createElement('a'); a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  var toastTimer;
  function toast(message) {
    var t = document.getElementById('toast'); if (!t) return;
    t.textContent = message; t.hidden = false; clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }
  async function copy(value, target) {
    try { if (!navigator.clipboard) throw Error('No clipboard'); await navigator.clipboard.writeText(value); toast('Copied.'); }
    catch (e) { target.hidden = false; target.value = value; target.focus(); target.select(); toast('Select and copy the text shown below.'); }
  }
  // Retire ONLY this project's older offline worker/caches. API and results are never cached.
  async function retireOldCache() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    try {
      var list = await navigator.serviceWorker.getRegistrations();
      var base = new URL(document.body.classList.contains('teacher-page') ? '../' : './', location.href).href;
      await Promise.all(list.filter(function (r) { return r.scope === base; }).map(function (r) { return r.unregister(); }));
      if ('caches' in window) { var keys = await caches.keys(); await Promise.all(keys.filter(function (k) { return k.indexOf('packet-quest-cs111-') === 0; }).map(function (k) { return caches.delete(k); })); }
    } catch (e) { /* Cache cleanup must not prevent a network quiz. */ }
  }
  root.PacketCore = {escapeHTML:esc, uid:uid, safeStore:safeStore, timeText:timeText, csv:csv, download:download, toast:toast, copy:copy};
  retireOldCache();
}(window));
