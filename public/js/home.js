import { $, $$, esc, api, toast, fmtTime, fmtBytes, confirmDialog, copyText, icon, logoHtml } from './common.js';
import { locale } from './i18n.js';
import { renderSetup, openSettings } from './settings-ui.js';

const brand = `${logoHtml}<span>Remote Booth</span>`;
$('#brand').innerHTML = brand;
$('#loginBrand').innerHTML = brand;
$('#newRoomBtn').innerHTML = icon.plus + 'Neuer Raum';

start();

async function start() {
  const cfg = await api('/api/config');
  if (cfg.setupRequired) { $('#setup').classList.remove('hidden'); renderSetup($('#setup'), { ...cfg, brandHtml: brand }); return; }
  if (!cfg.admin) {
    $('#login').classList.remove('hidden');
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      try { await api('/api/login', { method: 'POST', body: { password: $('#pw').value } }); location.reload(); }
      catch (err) { toast(err.message, { error: true }); }
    };
    return;
  }
  $('#app').classList.remove('hidden');
  $('#settingsBtn').innerHTML = icon.settings;
  $('#settingsBtn').onclick = () => openSettings();
  if (!window.isSecureContext) $('#hostInfo').innerHTML = '<span class="badge warn">Kein HTTPS – Kamera/Mikro funktionieren nur über localhost</span>';
  $('#newRoom').onsubmit = async e => {
    e.preventDefault();
    const r = await api('/api/rooms', { method: 'POST', body: { name: $('#roomName').value.trim() || 'Podcast' } });
    $('#roomName').value = '';
    toast('Raum angelegt');
    load();
  };
  load();
  setInterval(load, 10000);
}

async function load() {
  const [rooms, sessions] = await Promise.all([api('/api/rooms'), api('/api/sessions')]);
  const roomsEl = $('#rooms');
  roomsEl.innerHTML = rooms.length ? rooms.map(r => `
    <div class="card room-card" data-id="${esc(r.id)}">
      <div class="row"><h3 class="grow" translate="no">${esc(r.name)}</h3>${r.peers ? `<span class="badge ok"><span class="dot"></span>${r.peers} online</span>` : ''}</div>
      <div class="muted mono" style="font-size:12px;word-break:break-all">${esc(location.origin)}/r/${esc(r.id)}</div>
      <div class="row">
        <a class="btn primary grow" href="/r/${esc(r.id)}">Betreten</a>
        <button class="btn icon" data-a="copy" title="Einladungslink kopieren">${icon.link}</button>
        <button class="btn icon" data-a="ren" title="Umbenennen">${icon.edit}</button>
        <button class="btn icon danger" data-a="del" title="Raum löschen">${icon.trash}</button>
      </div>
    </div>`).join('') : '<div class="card empty">Noch kein Raum. Leg oben rechts einen an.</div>';
  for (const el of $$('.room-card', roomsEl)) {
    const id = el.dataset.id;
    $('[data-a=copy]', el).onclick = async () => { await copyText(`${location.origin}/r/${id}`); toast('Einladungslink kopiert'); };
    $('[data-a=ren]', el).onclick = async () => {
      const name = prompt('Neuer Name', rooms.find(r => r.id === id).name);
      if (name) { await api(`/api/rooms/${id}`, { method: 'PATCH', body: { name } }); load(); }
    };
    $('[data-a=del]', el).onclick = async () => {
      if (await confirmDialog('Raum löschen? Der Einladungslink wird ungültig. Aufnahmen bleiben erhalten.', { ok: 'Löschen', danger: true })) {
        await api(`/api/rooms/${id}`, { method: 'DELETE' }); load();
      }
    };
  }

  $('#sessCount').textContent = sessions.length ? `${sessions.length}` : '';
  const roomName = id => rooms.find(r => r.id === id)?.name || 'gelöschter Raum';
  $('#sessions').innerHTML = sessions.length ? sessions.map(s => {
    const rec = s.tracks.filter(t => t.kind === 'rec');
    const dur = Math.max(0, ...s.tracks.map(t => (t.offset || 0) + (t.duration || 0)));
    return `<div class="sess" data-id="${esc(s.id)}">
      <div>
        <div class="row"><span class="t" translate="no">${esc(s.name)}</span>${s.live ? '<span class="badge rec"><span class="dot pulse"></span>läuft</span>' : ''}</div>
        <div class="muted" style="font-size:12.5px"><span translate="no">${esc(roomName(s.roomId))}</span> · ${new Date(s.createdAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })}${dur ? ' · ' + fmtTime(dur) : ''}</div>
        <div class="tracks">${rec.map(t => {
          const done = t.ended && t.nextSeq >= (t.totalChunks || 0);
          return `<a class="badge ${done ? 'ok' : 'warn'}" href="/api/sessions/${esc(s.id)}/tracks/${esc(t.id)}/audio?download" title="Rohspur herunterladen">${icon.download.replace('<svg', '<svg width="12" height="12"')}<span translate="no">${esc(t.name)}</span> · ${fmtBytes(t.bytes)}${done ? '' : ' · Upload läuft'}</a>`;
        }).join('') || '<span class="muted" style="font-size:12px">Keine Spuren</span>'}</div>
      </div>
      <div class="row">
        <a class="btn" href="/edit/${esc(s.id)}">${icon.scissors}Bearbeiten</a>
        <button class="btn icon danger" data-a="del" title="Aufnahme löschen">${icon.trash}</button>
      </div>
    </div>`;
  }).join('') : '<div class="empty">Noch keine Aufnahmen.</div>';
  for (const el of $$('.sess')) {
    $('[data-a=del]', el).onclick = async () => {
      if (await confirmDialog('Aufnahme mit allen Spuren und Exporten endgültig löschen?', { ok: 'Löschen', danger: true })) {
        await api(`/api/sessions/${el.dataset.id}`, { method: 'DELETE' }); load();
      }
    };
  }
}
