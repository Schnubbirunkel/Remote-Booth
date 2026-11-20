// Gemeinsame Helfer für alle Seiten
import './i18n.js';
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export async function api(path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin', signal };
  if (method !== 'GET') opts.priority = 'high';
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(path, opts);
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* kein JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Fehler ${res.status}`), { status: res.status, data });
  return data;
}

export function toast(msg, { error = false, ms = 3200 } = {}) {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, ms);
}

export function fmtTime(sec, withMs = false) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const pad = n => String(n).padStart(2, '0');
  let out = (h ? h + ':' + pad(m) : m) + ':' + pad(s);
  if (withMs) out += '.' + String(Math.floor((sec % 1) * 10));
  return out;
}

export function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}

export function clientId() {
  let id = localStorage.getItem('ps_client');
  if (!id) { id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('ps_client', id); }
  return id;
}

export function modal(html, { onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal">${html}</div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  back.addEventListener('mousedown', e => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  back.close = close;
  return back;
}

export function confirmDialog(text, { ok = 'OK', cancel = 'Abbrechen', danger = false } = {}) {
  return new Promise(resolve => {
    let result = false;
    const m = modal(`<h2>${esc(text)}</h2><div class="row" style="justify-content:flex-end;margin-top:20px">
      <button class="btn" data-x>${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    { onClose: () => resolve(result) });
    m.querySelector('[data-x]').onclick = () => m.close();
    m.querySelector('[data-ok]').onclick = () => { result = true; m.close(); };
    m.querySelector('[data-ok]').focus();
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// Einfache Inline-Icons (Lucide-Stil, selbst gezeichnet)
const P = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const icon = {
  mic: P('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8 21h8"/>'),
  micOff: P('<path d="M3 3l18 18M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.7-1.3M19 10a7 7 0 0 1-1.2 3.9M5 10a7 7 0 0 0 10.8 5.9M12 17v4M8 21h8"/>'),
  cam: P('<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>'),
  camOff: P('<path d="M3 3l18 18M16 16H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2M10 6h4a2 2 0 0 1 2 2v4M16 10l6-3v10l-3-1.5"/>'),
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor"/></svg>',
  link: P('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  leave: P('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  chat: P('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  settings: P('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  download: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  folder: P('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  trash: P('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
  edit: P('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  plus: P('<path d="M12 5v14M5 12h14"/>'),
  scissors: P('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12"/>'),
  volOff: P('<path d="M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6"/>'),
  undo: P('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  redo: P('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>'),
  back: P('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
  flag: P('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>'),
  maximize: P('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
  grid: P('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  upload: P('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  check: P('<path d="M20 6L9 17l-5-5"/>'),
  skipBack: P('<path d="M11 19l-9-7 9-7zM22 19l-9-7 9-7z"/>'),
  skipFwd: P('<path d="M13 19l9-7-9-7zM2 19l9-7-9-7z"/>'),
  wave: P('<path d="M2 12h2M6 8v8M10 4v16M14 7v10M18 10v4M22 12h0"/>'),
  x: P('<path d="M18 6L6 18M6 6l12 12"/>'),
  ripple: P('<path d="M3 6h7M3 18h18M14 6h7M10 3v6M14 3v6"/><path d="M17 12H7m3-3-3 3 3 3"/>'),
  rippleAll: P('<path d="M3 5h18M3 12h18M3 19h18"/><path d="M15 8.5H8m2-2-2 2 2 2M15 15.5H8m2-2-2 2 2 2"/>'),
  norm: P('<path d="M3 12h3l3-8 4 16 3-8h5"/><path d="M3 4h18M3 20h18" opacity=".45"/>'),
  screen: P('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6"/>'),
  clip: P('<path d="M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'),
};

export const logoHtml = `<span class="logo">${P('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4"/>')}</span>`;
