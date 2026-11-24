// Aufnahmeraum: Videocall (WebRTC, Peer-to-Peer), lokale MP3-Aufnahme je Teilnehmer,
// frei verschiebbare/skalierbare Videokacheln, Chat, Backups.
import { $, $$, esc, api, toast, fmtTime, fmtBytes, clientId, modal, confirmDialog, copyText, downloadBlob, icon, logoHtml } from './common.js';
import { TrackRecorder, Uploader } from './recorder.js';
import * as idb from './idb.js';
import { locale } from './i18n.js';

const roomId = location.pathname.split('/')[2];
const myId = clientId();
const prefs = Object.assign({ ec: true, ns: false, agc: false, bitrate: 192, autoDl: false, mic: '', cam: '', vres: 1080, vfps: 30, mirror: true, eco: false },
  JSON.parse(localStorage.getItem('ps_prefs') || '{}'));
const savePrefs = () => localStorage.setItem('ps_prefs', JSON.stringify(prefs));

let config = { iceServers: [] };
let roomInfo = null;
let localStream = null;
let myName = localStorage.getItem('ps_name') || '';
let backupDir = null;
let ws = null, wsReady = false, wsRetry = 0, leaving = false;
let clockOffset = 0, bestRtt = Infinity;
const peers = new Map(); // clientId -> Peer
let rec = null, recSession = null;
const uploader = new Uploader();
let mctx = null; // AudioContext für Pegelanzeigen

const serverNow = (local = Date.now()) => local + clockOffset;

// ---------------- Start ----------------
init().catch(e => { console.error(e); toast(e.message, { error: true, ms: 8000 }); });

async function init() {
  [config, roomInfo] = await Promise.all([api('/api/config'), api(`/api/rooms/${roomId}/public`).catch(() => null)]);
  if (!roomInfo) {
    document.body.innerHTML = '<div style="display:grid;place-items:center;height:100%"><div class="card"><h2>Raum nicht gefunden</h2><p class="muted">Der Einladungslink ist ungültig oder der Raum wurde gelöscht.</p></div></div>';
    return;
  }
  document.title = `${roomInfo.name} · Remote Booth`;
  $('#verInfo').textContent = 'Version ' + (config.version || '?');
  $('#roomTitle').textContent = roomInfo.name;
  $('#nameIn').value = myName;
  $('#optEc').checked = prefs.ec; $('#optNs').checked = prefs.ns; $('#optAgc').checked = prefs.agc;
  $('#bitrateSel').value = String(prefs.bitrate);
  $('#vresSel').value = String(prefs.vres); $('#vfpsSel').value = String(prefs.vfps);
  $('#optMirror').checked = prefs.mirror;
  $('#optEco').checked = prefs.eco;
  $('#optEco').onchange = () => { prefs.eco = $('#optEco').checked; savePrefs(); applyVideoQuality(); };
  $('#optMirror').onchange = () => setMirror($('#optMirror').checked);
  applyMirror();
  $('#vresSel').onchange = $('#vfpsSel').onchange = () => { readLobbyPrefs(); applyVideoQuality(); };
  $('#optAutoDl').checked = prefs.autoDl;
  $('#optAutoDl').addEventListener('change', () => { prefs.autoDlTouched = true; readLobbyPrefs(); });
  if (!window.isSecureContext) {
    toast('Mikrofon/Kamera brauchen HTTPS (oder localhost). Siehe Anleitung.', { error: true, ms: 15000 });
  }
  setupBackupButton();
  for (const id of ['optEc', 'optNs', 'optAgc']) $('#' + id).onchange = () => { readLobbyPrefs(); startPreview(); };
  $('#micSel').onchange = () => { prefs.mic = $('#micSel').value; savePrefs(); startPreview(); };
  $('#camSel').onchange = () => { prefs.cam = $('#camSel').value; savePrefs(); startPreview(); };
  $('#joinBtn').onclick = join;
  $('#nameIn').addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  await startPreview();
  uploader.kick(); // evtl. Reste aus früheren Sitzungen hochladen
}

function readLobbyPrefs() {
  prefs.vres = +$('#vresSel').value; prefs.vfps = +$('#vfpsSel').value;
  prefs.ec = $('#optEc').checked; prefs.ns = $('#optNs').checked; prefs.agc = $('#optAgc').checked;
  prefs.bitrate = +$('#bitrateSel').value; prefs.autoDl = $('#optAutoDl').checked;
  savePrefs();
}

// ---------------- Medien ----------------
function audioConstraints() {
  return {
    deviceId: prefs.mic ? { exact: prefs.mic } : undefined,
    echoCancellation: prefs.ec, noiseSuppression: prefs.ns, autoGainControl: prefs.agc,
    channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
  };
}
// Auflösung (Höhe) → Breite (16:9) und maximale Video-Bitrate für den Call
const VRES = { 480: [854, 1.2e6], 720: [1280, 2.5e6], 1080: [1920, 5e6], 1440: [2560, 9e6], 2160: [3840, 16e6] };
// Energiesparmodus: höchstens 720p / 24 fps / 1,5 Mbit/s – spart auf Laptops deutlich Akku
const effRes = () => (prefs.eco ? Math.min(720, +prefs.vres || 720) : (+prefs.vres || 1080));
const effFps = () => (prefs.eco ? Math.min(24, +prefs.vfps || 24) : (+prefs.vfps || 30));
function videoConstraints() {
  const h = effRes(), w = (VRES[h] || VRES[1080])[0];
  return {
    deviceId: prefs.cam && prefs.cam !== 'none' ? { exact: prefs.cam } : undefined,
    width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: effFps(), max: effFps() },
  };
}
function videoMaxBitrate() {
  if (prefs.eco) return 1.5e6;
  const b = (VRES[effRes()] || VRES[1080])[1];
  return Math.round(b * (effFps() > 30 ? 1.5 : 1));
}
// H.264 bevorzugen: wird auf Mac (und den meisten PCs) von der Grafikhardware kodiert/dekodiert.
// VP8 (Browser-Standard) läuft dagegen komplett auf der CPU und kostet viel Akku.
function preferH264(pc) {
  if (!window.RTCRtpTransceiver || !('setCodecPreferences' in RTCRtpTransceiver.prototype)) return;
  const caps = RTCRtpReceiver.getCapabilities?.('video');
  if (!caps) return;
  const rank = c => {
    if (!/h264/i.test(c.mimeType)) return 9;
    const f = c.sdpFmtpLine || '';
    if (/packetization-mode=1/.test(f) && /profile-level-id=42e0/i.test(f)) return 0; // Constrained Baseline – überall Hardware
    if (/packetization-mode=1/.test(f)) return 1;
    return 2;
  };
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  if (rank(sorted[0]) === 9) return; // kein H.264 verfügbar
  for (const tr of pc.getTransceivers()) {
    const kind = tr.receiver?.track?.kind || tr.sender?.track?.kind;
    if (kind !== 'video' || tr.stopped || tr.currentDirection === 'stopped') continue;
    try { tr.setCodecPreferences(sorted); } catch (e) { console.warn('Codec-Auswahl', e); }
  }
}
// Browser drosseln Video standardmäßig auf ~2,5 Mbit/s – hier die gewünschte Qualität freigeben
async function tuneVideoSender(sender) {
  if (!sender || !sender.track || sender.track.kind !== 'video') return;
  try {
    sender.track.contentHint = 'motion';
    const prm = sender.getParameters();
    if (!prm.encodings || !prm.encodings.length) return;
    prm.encodings[0].maxBitrate = videoMaxBitrate();
    prm.encodings[0].maxFramerate = +prefs.vfps || 30;
    prm.encodings[0].scaleResolutionDownBy = 1;
    prm.degradationPreference = 'maintain-resolution'; // lieber weniger fps als unscharf
    await sender.setParameters(prm);
  } catch (e) { console.warn('Video-Parameter', e); }
}
const camInfo = () => {
  const st = localStream?.getVideoTracks()[0]?.getSettings();
  return st && st.width ? `${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} fps` : '';
};
async function applyVideoQuality() {
  const t = localStream?.getVideoTracks()[0];
  if (!t) return;
  const c = videoConstraints();
  delete c.deviceId;
  try { await t.applyConstraints(c); } catch (e) { console.warn(e); }
  const st = screenStream?.getVideoTracks()[0];
  if (st) { try { await st.applyConstraints({ frameRate: { ideal: screenFps(), max: screenFps() } }); } catch { /* egal */ } }
  for (const p of peers.values()) { await tuneVideoSender(p.videoSender); await tuneScreenSender(p.screenSender); }
  updateCamInfo();
}
// Spiegeln betrifft nur die eigene Anzeige – gesendet wird immer das Originalbild
function applyMirror() {
  $('#pvBox')?.classList.toggle('mirror', !!prefs.mirror);
  tiles.get('me')?.el.classList.toggle('mirror', !!prefs.mirror);
}
function setMirror(on) {
  prefs.mirror = on; savePrefs(); applyMirror();
  const cb = $('#optMirror'); if (cb) cb.checked = on;
}
function updateCamInfo() {
  const el = $('#pvRes');
  if (el) el.textContent = camInfo();
}

async function getMedia() {
  const wantVideo = prefs.cam !== 'none';
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: wantVideo ? videoConstraints() : false });
  } catch (e) {
    if (e.name === 'OverconstrainedError' || e.name === 'NotFoundError') {
      // Gespeichertes Gerät nicht mehr vorhanden → Standard
      prefs.mic = ''; if (prefs.cam !== 'none') prefs.cam = '';
      try { return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: wantVideo ? videoConstraints() : false }); } catch { /* weiter */ }
    }
    if (wantVideo) {
      toast('Kamera nicht verfügbar – nur Audio.', { error: true });
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
    }
    throw e;
  }
}

async function fillDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const mics = devs.filter(d => d.kind === 'audioinput');
  const cams = devs.filter(d => d.kind === 'videoinput');
  const curMic = localStream?.getAudioTracks()[0]?.getSettings().deviceId || prefs.mic;
  const curCam = prefs.cam === 'none' ? 'none' : (localStream?.getVideoTracks()[0]?.getSettings().deviceId || prefs.cam);
  const fill = (sel, list, cur, none) => {
    sel.innerHTML = (none ? '<option value="none">Keine Kamera</option>' : '') +
      list.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || (none ? 'Kamera ' : 'Mikrofon ') + (i + 1))}</option>`).join('');
    if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
  };
  for (const sel of $$('#micSel, [data-dev=mic]')) fill(sel, mics, curMic, false);
  for (const sel of $$('#camSel, [data-dev=cam]')) fill(sel, cams, curCam, true);
}

let previewMeterStop = null;
async function startPreview() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  try { localStream = await getMedia(); } catch (e) {
    toast('Kein Zugriff auf Mikrofon: ' + e.message, { error: true, ms: 8000 });
    return;
  }
  $('#pv').srcObject = localStream;
  $('#pvNoCam').classList.toggle('hidden', localStream.getVideoTracks().length > 0);
  updateCamInfo();
  await fillDevices();
  previewMeterStop && previewMeterStop();
  ensureMctx();
  const lvl = levelOf(localStream);
  let raf;
  const loop = () => { $('#pvMeter').style.width = (lvl() * 100).toFixed(1) + '%'; raf = requestAnimationFrame(loop); };
  loop();
  previewMeterStop = () => cancelAnimationFrame(raf);
}

function ensureMctx() {
  if (!mctx) mctx = new AudioContext({ latencyHint: 'playback' }); // größere Puffer = weniger CPU-Aufwachen
  if (mctx.state === 'suspended') mctx.resume().catch(() => {});
  return mctx;
}

function levelOf(stream) {
  if (!stream.getAudioTracks().length) return () => 0;
  const src = mctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
  const an = mctx.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let smooth = 0;
  return () => {
    an.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v; }
    const db = 20 * Math.log10(peak + 1e-9);
    const v = Math.max(0, Math.min(1, (db + 60) / 60));
    smooth = v > smooth ? v : smooth * 0.85 + v * 0.15;
    return smooth;
  };
}

// ---------------- Backup-Ordner ----------------
function setupBackupButton() {
  const btn = $('#backupBtn');
  const supported = 'showDirectoryPicker' in window;
  const render = () => {
    btn.innerHTML = `${icon.folder}<span>${backupDir ? 'Backup-Ordner: ' + esc(backupDir.name) : 'Backup-Ordner auf diesem Rechner wählen'}</span>`;
    btn.classList.toggle('on', !!backupDir);
  };
  render();
  if (!supported) {
    btn.disabled = true;
    const tail = ' Die Sicherung im Browser-Speicher läuft trotzdem, und mit dem Schalter darunter wird sie nach jeder Aufnahme automatisch als MP3 heruntergeladen.';
    let why;
    if (!window.isSecureContext) why = 'Gesperrt, weil die Seite nicht über https geöffnet ist. Bitte die https-Adresse (z. B. https://podcast.deine-domain.de) statt der IP-Adresse verwenden.';
    else if (navigator.brave) why = 'Brave hat diese Funktion standardmäßig abgeschaltet: brave://flags/#file-system-access-api aufrufen, auf „Enabled“ stellen, Brave neu starten.';
    else if (/Android|iPhone|iPad/i.test(navigator.userAgent)) why = 'Auf Smartphones/Tablets nicht verfügbar.';
    else why = 'Dein Browser kann nicht direkt in einen Ordner schreiben – das geht in Chrome, Edge und Opera am Computer (nicht in Firefox und Safari).';
    $('#backupHint').textContent = why + tail;
    btn.title = why;
    if (!prefs.autoDlTouched) { $('#optAutoDl').checked = true; prefs.autoDl = true; }
    return;
  }
  $('#backupHint').textContent = 'Zusätzlich zur Browser-Sicherung wird jede Aufnahme live in diesen Ordner geschrieben.';
  btn.onclick = async () => {
    try { backupDir = await window.showDirectoryPicker({ id: 'podcast-backup', mode: 'readwrite' }); render(); } catch { /* abgebrochen */ }
  };
}

// ---------------- Raum betreten ----------------
async function join() {
  myName = $('#nameIn').value.trim();
  if (!myName) { $('#nameIn').focus(); toast('Bitte einen Namen eingeben.'); return; }
  if (!localStream) { await startPreview(); if (!localStream) return; }
  localStorage.setItem('ps_name', myName);
  readLobbyPrefs();
  ensureMctx();
  previewMeterStop && previewMeterStop();
  $('#lobby').classList.add('hidden');
  $('#studio').classList.remove('hidden');
  buildStudioChrome();
  if (isMobile()) { layoutMode = 'spotlight'; $('#side').classList.add('closed'); }
  addTile('me', { name: myName, local: true, stream: localStream });
  layoutTiles(true);
  connectWs();
  startMeterLoop();
  refreshBackups();
  setInterval(tickTimer, 500);
}

function buildStudioChrome() {
  $('#homeLink').innerHTML = logoHtml + '<span class="hide-sm">Remote Booth</span>';
  if (!config.admin) $('#homeLink').removeAttribute('href');
  $('#roomName').textContent = roomInfo.name;
  $('#inviteBtn').innerHTML = icon.link + '<span>Einladungslink kopieren</span>';
  $('#inviteBtn').onclick = async () => { await copyText(`${location.origin}/r/${roomId}`); toast('Link kopiert – an deinen Gast schicken.'); };
  $('#markerBtn').innerHTML = icon.flag;
  $('#screenBtn').innerHTML = icon.screen;
  if (!navigator.mediaDevices?.getDisplayMedia || /Android|iPhone|iPad/i.test(navigator.userAgent)) $('#screenBtn').classList.add('hidden');
  $('#screenBtn').onclick = () => (screenStream ? stopScreen() : startScreen());
  $('#attachBtn').innerHTML = icon.clip;
  $('#attachBtn').onclick = () => $('#chatFile').click();
  $('#chatFile').onchange = () => { for (const f of $('#chatFile').files) uploadChatFile(f); $('#chatFile').value = ''; };
  setupChatDrop();
  $('#layoutBtn').innerHTML = icon.grid;
  $('#settingsBtn').innerHTML = icon.settings;
  $('#sideBtn').innerHTML = icon.chat;
  $('#leaveBtn').innerHTML = icon.leave;
  renderMicCam();
  renderRecBtn();
  $('#micBtn').onclick = toggleMic;
  $('#camBtn').onclick = toggleCam;
  $('#recBtn').onclick = onRecClick;
  $('#markerBtn').onclick = setMarker;
  $('#layoutBtn').onclick = () => { mainKey = null; layoutMode = layoutMode === 'grid' ? 'spotlight' : 'grid'; layoutTiles(true); toast(layoutMode === 'grid' ? 'Raster-Ansicht' : 'Fokus-Ansicht'); };
  $('#settingsBtn').onclick = openSettings;
  $('#sideBtn').onclick = () => { $('#side').classList.toggle('closed'); setTimeout(() => layoutTiles(false), 0); };
  $('#leaveBtn').onclick = leave;
  for (const b of $$('.tabs button')) b.onclick = () => {
    $$('.tabs button').forEach(x => x.classList.toggle('active', x === b));
    $$('.tabpane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
    if (b.dataset.tab === 'backups') refreshBackups();
    if (b.dataset.tab === 'chat') { b.textContent = 'Chat'; $('#chatIn').focus(); }
  };
  $('#chatForm').onsubmit = e => {
    e.preventDefault();
    const text = $('#chatIn').value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    $('#chatIn').value = '';
  };
  window.addEventListener('resize', () => layoutTiles(false));
  // Drehen des Geräts: Layout nach dem Umbau neu berechnen
  window.addEventListener('orientationchange', () => setTimeout(() => layoutTiles(true), 300));
  $('#sideClose').innerHTML = icon.x;
  $('#sideClose').onclick = () => { $('#side').classList.add('closed'); setTimeout(() => layoutTiles(false), 0); };
  window.addEventListener('beforeunload', e => {
    if (rec || Object.values(uploader.progress).some(p => !p.finalized)) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'm' || e.key === 'M') toggleMic();
    else if (e.key === 'v' || e.key === 'V') toggleCam();
    else if (e.key === 'k' || e.key === 'K') setMarker();
  });
  uploader.addEventListener('progress', () => { renderUploadBadge(); sendStatusSoon(); refreshBackupsSoon(); });
}

// ---------------- WebSocket ----------------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}&clientId=${myId}&name=${encodeURIComponent(myName)}`);
  ws.onopen = () => { wsReady = true; wsRetry = 0; $('#connBadge').classList.add('hidden'); syncClock(); };
  ws.onclose = e => {
    wsReady = false;
    if (leaving) return;
    if (e.code === 4001) { toast('Der Raum ist voll.', { error: true, ms: 8000 }); return; }
    if (e.code === 4000) { toast('Dieser Raum wurde in einem anderen Tab geöffnet.', { error: true, ms: 8000 }); return; }
    $('#connBadge').classList.remove('hidden');
    setTimeout(connectWs, Math.min(10000, 1000 * 2 ** wsRetry++));
  };
  ws.onmessage = e => onWsMessage(JSON.parse(e.data));
}
function wsSend(msg) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; }

// Uhr-Abgleich mit dem Server (wie NTP): nötig, damit die Spuren beider Teilnehmer exakt übereinanderliegen
function syncClock() {
  let n = 0;
  const t = setInterval(() => {
    if (!wsSend({ type: 'ping', t0: Date.now() }) || ++n >= 8) clearInterval(t);
  }, 150);
}
setInterval(() => { if (wsReady) { bestRtt *= 1.5; syncClock(); } }, 30000);

async function onWsMessage(m) {
  switch (m.type) {
    case 'pong': {
      const t1 = Date.now();
      const rtt = t1 - m.t0;
      if (rtt <= bestRtt) { bestRtt = rtt; clockOffset = m.ts - (m.t0 + rtt / 2); }
      break;
    }
    case 'welcome': {
      if (m.serverTime && bestRtt === Infinity) clockOffset = m.serverTime - Date.now();
      for (const p of peers.values()) p.close();
      peers.clear();
      for (const p of m.peers) createPeer(p.clientId, p.name, p.status, true);
      if (Array.isArray(m.history)) { $('#chatLog').innerHTML = ''; seenFiles.clear(); m.history.forEach(h => addChat(h, true)); }
      sendStatus();
      // Aufnahme-Zustand abgleichen (z. B. nach Verbindungsabbruch)
      if (m.recording) onRecStart(m.recording);
      else if (recSession) wsSend({ type: 'rec-resume', sessionId: recSession.sessionId });
      renderPeople();
      break;
    }
    case 'peer-joined':
      peers.get(m.clientId)?.close();
      createPeer(m.clientId, m.name, {}, false);
      toast(`${m.name} ist beigetreten`);
      sendStatus();
      renderPeople();
      break;
    case 'peer-left': {
      const p = peers.get(m.clientId);
      if (p) { toast(`${p.name} hat den Raum verlassen`); p.close(); peers.delete(m.clientId); removeTile(m.clientId); layoutTiles(true); }
      renderPeople();
      break;
    }
    case 'peer-name': { const p = peers.get(m.clientId); if (p) { p.name = m.name; updateTileName(m.clientId, m.name); renderPeople(); } break; }
    case 'peer-status': {
      const p = peers.get(m.clientId);
      if (p) { p.status = m.status || {}; applyPeerStatus(p); renderPeople(); }
      break;
    }
    case 'signal': peers.get(m.from)?.onSignal(m.data); break;
    case 'chat': addChat(m); break;
    case 'rec-start': onRecStart(m); break;
    case 'rec-stop': if (recSession && m.sessionId === recSession.sessionId) { toast(`Aufnahme beendet${m.by ? ' von ' + m.by : ''}`); stopLocal(); } break;
    case 'marker': toast(`🚩 Marker bei ${fmtTime(m.t)}${m.by ? ' (' + m.by + ')' : ''}`); break;
    default: break;
  }
}

// ---------------- WebRTC (Perfect Negotiation) ----------------
class Peer {
  // initiator = wir sind neu im Raum und starten die Verbindung. Die Gegenseite fügt ihre Spuren
  // erst beim Beantworten des Angebots hinzu – so gibt es keine gleichzeitigen Angebote.
  constructor(id, name, status, initiator) {
    this.id = id; this.name = name; this.status = status || {};
    this.polite = myId < id;
    this.makingOffer = false; this.ignoreOffer = false;
    this.stream = new MediaStream();
    this.pc = new RTCPeerConnection({ iceServers: config.iceServers });
    this.audioSender = null; this.videoSender = null;
    this.tracksAdded = false;
    if (initiator) this.addLocalTracks();
    else this.fallbackTimer = setTimeout(() => this.addLocalTracks(), 4000);
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        this.send({ description: this.pc.localDescription });
      } catch (e) { console.warn(e); } finally { this.makingOffer = false; }
    };
    this.pc.onicecandidate = ({ candidate }) => { if (candidate) this.send({ candidate }); };
    // Eine Spur gilt erst als aktiv, wenn tatsächlich Daten ankommen (unmute)
    const useTrack = track => {
      if (this.stream.getTracks().includes(track)) return;
      for (const old of this.stream.getTracks().filter(t => t.kind === track.kind)) this.stream.removeTrack(old);
      this.stream.addTrack(track);
      const tile = tiles.get(this.id);
      if (tile) {
        tile.video.srcObject = this.stream;
        tile.video.play().catch(() => {});
        if (track.kind === 'audio') tile.level = levelOf(this.stream);
      }
      applyPeerStatus(this);
    };
    this.videoBySid = new Map(); // Stream-ID → Videospur (Kamera und Bildschirm unterscheiden)
    this.pc.ontrack = ({ track, streams }) => {
      const sid = streams?.[0]?.id;
      if (track.kind === 'video' && sid) {
        this.videoBySid.set(sid, track);
        const st = this.status || {};
        if (sid === st.screen || (st.camStream && sid !== st.camStream)) { this.showScreen(track); return; }
      }
      const hasKind = this.stream.getTracks().some(t => t.kind === track.kind && !t.muted && t.readyState === 'live');
      if (!track.muted || !hasKind) useTrack(track);
      track.addEventListener('unmute', () => { useTrack(track); applyPeerStatus(this); });
      track.addEventListener('mute', () => applyPeerStatus(this));
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      const tile = tiles.get(this.id);
      if (tile) {
        tile.conn.textContent = st === 'connected' ? '' : st === 'failed'
          ? 'Keine direkte Verbindung möglich – TURN-Server einrichten (siehe Anleitung)'
          : st === 'disconnected' ? 'Verbindung unterbrochen …' : 'Verbinde …';
      }
      if (st === 'failed') this.pc.restartIce();
      if (st === 'connected') { tuneVideoSender(this.videoSender); tuneScreenSender(this.screenSender); logCodec(this); }
    };
    addTile(id, { name, local: false, stream: this.stream });
    tiles.get(id).conn.textContent = 'Verbinde …';
    layoutTiles(true);
  }
  addLocalTracks() {
    clearTimeout(this.fallbackTimer);
    if (this.tracksAdded) return;
    this.tracksAdded = true;
    for (const t of localStream.getTracks()) {
      const s = this.pc.addTrack(t, localStream);
      if (t.kind === 'audio') this.audioSender = s; else this.videoSender = s;
    }
    if (screenStream) this.addScreen();
    preferH264(this.pc);
  }
  addScreen() {
    const t = screenStream?.getVideoTracks()[0];
    if (!t || this.screenSender) return;
    this.screenSender = this.pc.addTrack(t, screenStream);
    preferH264(this.pc);
    setTimeout(() => tuneScreenSender(this.screenSender), 1500);
  }
  removeScreen() {
    if (!this.screenSender) return;
    try { this.pc.removeTrack(this.screenSender); } catch { /* egal */ }
    this.screenSender = null;
  }
  send(data) { wsSend({ type: 'signal', to: this.id, data }); }
  async onSignal({ description, candidate }) {
    try {
      if (description) {
        const collision = description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          this.addLocalTracks();
          preferH264(this.pc);
          await this.pc.setLocalDescription();
          this.send({ description: this.pc.localDescription });
        }
      } else if (candidate) {
        try { await this.pc.addIceCandidate(candidate); } catch (e) { if (!this.ignoreOffer) console.warn(e); }
      }
    } catch (e) { console.warn('Signalisierung', e); }
  }
  async setVideoTrack(track) {
    if (!this.tracksAdded) return; // wird beim Verbindungsaufbau ohnehin übernommen
    if (this.videoSender) await this.videoSender.replaceTrack(track);
    else if (track) this.videoSender = this.pc.addTrack(track, localStream);
    if (track) { preferH264(this.pc); setTimeout(() => tuneVideoSender(this.videoSender), 1500); }
  }
  async setAudioTrack(track) { if (this.audioSender) await this.audioSender.replaceTrack(track); }
  showScreen(track) {
    const key = this.id + ':screen';
    if (tiles.get(key)?.track === track) return;
    const t = addTile(key, { name: `Bildschirm von ${this.name}`, screen: true, stream: new MediaStream([track]) });
    t.track = track;
    track.addEventListener('ended', () => this.hideScreen());
    screenLayout();
  }
  hideScreen() {
    if (!tiles.has(this.id + ':screen')) return;
    removeTile(this.id + ':screen');
    screenLayout();
  }
  close() { clearTimeout(this.fallbackTimer); try { this.pc.close(); } catch { /* egal */ } removeTile(this.id); removeTile(this.id + ':screen'); screenLayout(); }
}

function createPeer(id, name, status, initiator) {
  const p = new Peer(id, name, status, initiator);
  peers.set(id, p);
  return p;
}

// ---------------- Kacheln ----------------
const tiles = new Map();
// Mobil: Touch-Bedienung oder schmaler Bildschirm → Vollflächen-Layout, Antippen statt Ziehen/Doppelklick
const isMobile = () => matchMedia('(pointer: coarse)').matches || innerWidth < 760 || innerHeight < 500;
const isPortrait = () => innerHeight >= innerWidth;
let mainKey = null; // auf Mobilgeräten angetippte Hauptkachel
let zTop = 10;
let layoutMode = 'grid';
const hue = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

function addTile(key, { name, local, stream, screen }) {
  if (tiles.has(key)) removeTile(key);
  const el = document.createElement('div');
  el.className = 'tile' + (screen ? ' screen contain' : local ? ' local' : '');
  el.innerHTML = `
    <video autoplay playsinline ${local || screen ? 'muted' : ''}></video>
    <div class="ph hidden"><div class="avatar" style="background:hsl(${hue(name)} 55% 45%)">${esc(initials(name))}</div></div>
    <div class="conn"></div>
    <div class="tl"></div>
    <div class="tools">
      ${local && !screen ? `<button data-a="mirror" title="Eigenes Bild spiegeln an/aus">⇋</button>` : ''}
      <button data-a="fit" title="Ganzes Bild / Ausfüllen">${icon.maximize}</button>
    </div>
    ${local && screen ? '<div class="sinfo hidden"></div>' : ''}
    <div class="label"><span class="nm"></span><b class="micoff hidden">${icon.micOff}</b><div class="lvl"><i></i></div></div>
    <div class="rz nw" data-c="nw"></div><div class="rz ne" data-c="ne"></div><div class="rz sw" data-c="sw"></div><div class="rz se" data-c="se"></div>`;
  $('#stage').appendChild(el);
  const t = {
    key, el, local, name, video: $('video', el), ph: $('.ph', el), conn: $('.conn', el), tl: $('.tl', el),
    nm: $('.nm', el), micoff: $('.micoff', el), lvlBar: $('.lvl i', el), frac: null, level: () => 0, max: null, screen: !!screen,
  };
  t.nm.textContent = name + (local && !screen ? ' (du)' : '');
  if (screen) { $('.lvl', el).remove(); el.classList.add('noph'); }
  t.video.srcObject = stream;
  t.video.play().catch(() => {});
  if (!screen && stream.getAudioTracks().length) t.level = levelOf(stream);
  $('[data-a=fit]', el).onclick = e => { e.stopPropagation(); el.classList.toggle('contain'); };
  const mb = $('[data-a=mirror]', el);
  if (mb) mb.onclick = e => { e.stopPropagation(); setMirror(!prefs.mirror); toast(prefs.mirror ? 'Eigenes Bild gespiegelt' : 'Eigenes Bild seitenrichtig'); };
  makeDraggable(t);
  tiles.set(key, t);
  if (local && !screen) { updateLocalTile(); el.classList.toggle('mirror', !!prefs.mirror); }
  return t;
}
function removeTile(key) { const t = tiles.get(key); if (t) { t.el.remove(); tiles.delete(key); } }
function updateTileName(key, name) { const t = tiles.get(key); if (t) { t.name = name; t.nm.textContent = name; $('.avatar', t.el).textContent = initials(name); } }

function updateLocalTile() {
  const t = tiles.get('me');
  if (!t) return;
  const hasCam = localStream.getVideoTracks().some(v => v.readyState === 'live');
  t.ph.classList.toggle('hidden', hasCam);
  t.micoff.classList.toggle('hidden', micOn());
  // Nur zuweisen, wenn nötig – jede Neuzuweisung startet das Video neu (= Flackern)
  if (t.video.srcObject !== localStream) { t.video.srcObject = localStream; t.video.play().catch(() => {}); }
  const badges = [];
  if (rec) badges.push(`<span class="badge rec"><span class="dot pulse"></span>REC</span>`);
  const up = myUploadText();
  if (up) badges.push(`<span class="badge ${up.ok ? 'ok' : ''}">${esc(up.text)}</span>`);
  setBadges(t, badges.join(''));
}

function setBadges(t, html) {
  if (t.badgeHtml === html) return; // unverändert → nichts neu zeichnen (sonst flackert die REC-Animation)
  t.badgeHtml = html;
  t.tl.innerHTML = html;
}

function applyPeerStatus(p) {
  const t = tiles.get(p.id);
  if (!t) return;
  const s = p.status || {};
  // Bildschirmfreigabe des Partners ein-/ausblenden
  if (s.screen && !tiles.has(p.id + ':screen')) { const tr = p.videoBySid?.get(s.screen); if (tr && tr.readyState === 'live') p.showScreen(tr); }
  else if (!s.screen && tiles.has(p.id + ':screen')) p.hideScreen();
  // Platzhalter nur, wenn die Kamera wirklich aus ist – kurze Bildaussetzer (Track „muted“ bei
  // schwankender Bandbreite) sollen nicht zwischen Bild und Platzhalter hin- und herspringen.
  const hasVideo = p.stream.getVideoTracks().some(v => v.readyState === 'live') && (t.video.videoWidth > 0 || p.stream.getVideoTracks().some(v => !v.muted));
  const showPh = s.cam === false || !hasVideo;
  if (t.phShown !== showPh) { t.phShown = showPh; t.ph.classList.toggle('hidden', !showPh); }
  t.micoff.classList.toggle('hidden', s.mic !== false);
  const badges = [];
  if (s.rec) badges.push(`<span class="badge rec"><span class="dot pulse"></span>REC</span>`);
  if (s.upload) badges.push(`<span class="badge ${s.uploadOk ? 'ok' : ''}">${esc(s.upload)}</span>`);
  setBadges(t, badges.join(''));
}

function stageRect() { return $('#stage').getBoundingClientRect(); }

function applyFrac(t) {
  const r = stageRect();
  const f = t.frac;
  t.el.style.left = f.x * r.width + 'px';
  t.el.style.top = f.y * r.height + 'px';
  t.el.style.width = f.w * r.width + 'px';
  t.el.style.height = f.h * r.height + 'px';
}

// Automatische Anordnung: Raster (gleich groß) oder Fokus (Gast groß, Rest klein)
function layoutTiles(animate) {
  const list = [...tiles.values()];
  if (!list.length) return;
  const r = stageRect();
  if (r.width < 10) return;
  list.forEach(t => t.el.classList.toggle('anim', !!animate));
  if (isMobile()) { layoutMobile(list, r); if (animate) setTimeout(() => list.forEach(t => t.el.classList.remove('anim')), 300); return; }
  const gap = 18;
  if (layoutMode === 'spotlight' && list.length > 1) {
    const main = list.find(t => t.screen && !t.local) || list.find(t => t.screen) || list.find(t => !t.local) || list[0];
    const others = list.filter(t => t !== main);
    let w = r.width - gap * 2, h = r.height - gap * 2;
    if (w / h > 16 / 9) w = h * 16 / 9; else h = w * 9 / 16;
    if (list.some(t => t.screen)) { w = Math.min(r.width - gap * 2 - Math.max(200, r.width * 0.2) - gap, w); h = w * 9 / 16; }
    const hasScreen = list.some(t => t.screen);
    main.frac = { x: (hasScreen ? gap : (r.width - w) / 2) / r.width, y: (r.height - h) / 2 / r.height, w: w / r.width, h: h / r.height };
    const sw = Math.max(200, r.width * 0.2), sh = sw * 9 / 16;
    others.forEach((t, i) => {
      t.frac = { x: (r.width - sw - gap) / r.width, y: (r.height - (sh + gap) * (i + 1)) / r.height, w: sw / r.width, h: sh / r.height };
    });
    main.el.style.zIndex = ++zTop;
    others.forEach(t => (t.el.style.zIndex = ++zTop));
  } else {
    const n = list.length;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const w = Math.min((r.width - gap * (cols + 1)) / cols, ((r.height - gap * (rows + 1)) / rows) * 16 / 9);
      if (!best || w > best.w) best = { cols, rows, w };
    }
    const { cols, rows, w } = best;
    const h = w * 9 / 16;
    const totalH = rows * h + (rows - 1) * gap;
    list.forEach((t, i) => {
      const row = Math.floor(i / cols);
      const inRow = Math.min(cols, n - row * cols);
      const rowW = inRow * w + (inRow - 1) * gap;
      const x = (r.width - rowW) / 2 + (i % cols) * (w + gap);
      const y = (r.height - totalH) / 2 + row * (h + gap);
      t.frac = { x: x / r.width, y: y / r.height, w: w / r.width, h: h / r.height };
    });
  }
  list.forEach(t => { t.max = null; applyFrac(t); });
  if (animate) setTimeout(() => list.forEach(t => t.el.classList.remove('anim')), 300);
}

// Mobil-Layout:
//  Fokus  – Hauptkachel füllt die Fläche, die anderen schweben als kleine Bild-im-Bild-Fenster in der Ecke
//  Raster – Kacheln teilen sich die Fläche (Hochformat untereinander, Querformat nebeneinander)
function layoutMobile(list, r) {
  const gap = 8;
  list.forEach(t => t.el.classList.remove('main', 'pip'));
  if (layoutMode === 'spotlight' && list.length > 1) {
    let main = (mainKey && tiles.get(mainKey)) || null;
    if (!main) main = list.find(t => t.screen && !t.local) || list.find(t => t.screen) || list.find(t => !t.local) || list[0];
    const others = list.filter(t => t !== main);
    main.frac = { x: 0, y: 0, w: 1, h: 1 };
    main.el.classList.add('main');
    main.el.style.zIndex = 5;
    const portrait = isPortrait();
    const pw = portrait ? Math.min(150, r.width * 0.3) : Math.min(200, r.width * 0.22);
    const ph = portrait ? pw * 4 / 3 : pw * 9 / 16;
    others.forEach((t, i) => {
      t.el.classList.add('pip');
      const y = r.height - (ph + gap) * (i + 1) - 4;
      t.frac = { x: (r.width - pw - gap - 4) / r.width, y: Math.max(gap, y) / r.height, w: pw / r.width, h: ph / r.height };
      t.el.style.zIndex = 10 + i;
    });
  } else {
    const n = list.length, portrait = isPortrait();
    const cols = portrait ? (n <= 2 ? 1 : 2) : (n <= 3 ? n : Math.ceil(n / 2));
    const rows = Math.ceil(n / cols);
    const w = (r.width - gap * (cols + 1)) / cols, h = (r.height - gap * (rows + 1)) / rows;
    list.forEach((t, i) => {
      const row = Math.floor(i / cols), col = i % cols;
      const inRow = Math.min(cols, n - row * cols);
      const off = (r.width - (inRow * w + (inRow - 1) * gap)) / 2;
      t.frac = { x: (off + col * (w + gap)) / r.width, y: (gap + row * (h + gap)) / r.height, w: w / r.width, h: h / r.height };
    });
  }
  list.forEach(t => { t.max = null; applyFrac(t); });
}

// Ziehen zum Verschieben, Ecken zum Vergrößern, Doppelklick = maximieren
function makeDraggable(t) {
  const el = t.el;
  let start = null;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.tools')) return;
    el.style.zIndex = ++zTop;
    const corner = e.target.dataset?.c || null;
    const r = stageRect();
    start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, corner, r, ratio: el.offsetWidth / el.offsetHeight, moved: false, time: Date.now() };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 8) return; // kleine Wackler beim Antippen ignorieren
    if (isMobile() && el.classList.contains('main')) return; // Hauptkachel auf dem Handy bleibt fest
    start.moved = true;
    const { r } = start;
    let { l, t: top, w, h } = start;
    if (!start.corner) {
      l = Math.max(-w * 0.6, Math.min(r.width - w * 0.4, l + dx));
      top = Math.max(0, Math.min(r.height - 40, top + dy));
    } else {
      const c = start.corner;
      const minW = 160;
      let nw = c.includes('e') ? w + dx : w - dx;
      nw = Math.max(minW, Math.min(r.width, nw));
      // Seitenverhältnis beibehalten (Shift = frei)
      let nh = e.shiftKey ? Math.max(100, c.includes('s') ? h + dy : h - dy) : nw / start.ratio;
      nh = Math.min(r.height, nh);
      if (c.includes('w')) l = l + (w - nw);
      if (c.includes('n')) top = top + (h - nh);
      w = nw; h = nh;
    }
    Object.assign(el.style, { left: l + 'px', top: top + 'px', width: w + 'px', height: h + 'px' });
  });
  const end = () => {
    if (!start) return;
    if (!start.moved) {
      start = null;
      el.classList.remove('dragging');
      if (isMobile() && !el.classList.contains('main')) { mainKey = t.key; layoutMode = 'spotlight'; layoutTiles(true); }
      return;
    }
    const r = start.r;
    t.frac = { x: el.offsetLeft / r.width, y: el.offsetTop / r.height, w: el.offsetWidth / r.width, h: el.offsetHeight / r.height };
    start = null;
    el.classList.remove('dragging');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', e => {
    if (e.target.closest('.tools')) return;
    el.classList.add('anim');
    if (t.max) { t.frac = t.max; t.max = null; }
    else {
      t.max = { ...t.frac };
      const r = stageRect();
      let w = r.width - 24, h = r.height - 24;
      if (w / h > 16 / 9) w = h * 16 / 9; else h = w * 9 / 16;
      t.frac = { x: (r.width - w) / 2 / r.width, y: (r.height - h) / 2 / r.height, w: w / r.width, h: h / r.height };
      el.style.zIndex = ++zTop;
    }
    applyFrac(t);
    setTimeout(() => el.classList.remove('anim'), 300);
  });
}

// Pegelanzeigen: 10× pro Sekunde reicht (statt bei jedem Bildschirmbild, auf ProMotion-Displays 120×)
function startMeterLoop() {
  setInterval(() => {
    if (document.hidden) return;
    for (const t of tiles.values()) {
      if (t.screen) continue;
      const v = t.local && !micOn() ? 0 : t.level();
      const w = (v * 100).toFixed(0) + '%';
      if (t.lvlW !== w) { t.lvlW = w; t.lvlBar.style.width = w; }
      const sp = v > 0.42;
      if (t.sp !== sp) { t.sp = sp; t.el.classList.toggle('speaking', sp); }
    }
  }, 100);
}

// ---------------- Mikro / Kamera ----------------
const micOn = () => localStream?.getAudioTracks().some(t => t.enabled) ?? false;
const camOn = () => localStream?.getVideoTracks().some(t => t.readyState === 'live') ?? false;

function renderMicCam() {
  $('#micBtn').innerHTML = micOn() ? icon.mic : icon.micOff;
  $('#micBtn').classList.toggle('off', !micOn());
  $('#camBtn').innerHTML = camOn() ? icon.cam : icon.camOff;
  $('#camBtn').classList.toggle('off', !camOn());
}
function toggleMic() {
  const on = !micOn();
  localStream.getAudioTracks().forEach(t => (t.enabled = on));
  renderMicCam(); updateLocalTile(); sendStatus();
  if (!on && rec) toast('Stummgeschaltet – deine Spur nimmt jetzt Stille auf.');
}
async function toggleCam() {
  if (camOn()) {
    for (const t of localStream.getVideoTracks()) { t.stop(); localStream.removeTrack(t); }
    for (const p of peers.values()) await p.setVideoTrack(null);
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      const track = s.getVideoTracks()[0];
      localStream.addTrack(track);
      for (const p of peers.values()) await p.setVideoTrack(track);
      if (prefs.cam === 'none') { prefs.cam = ''; savePrefs(); }
    } catch (e) { toast('Kamera nicht verfügbar: ' + e.message, { error: true }); }
  }
  renderMicCam(); updateLocalTile(); sendStatus();
}

async function openSettings() {
  const m = modal(`<h2>Geräte & Audio</h2>
    <div class="col" style="gap:14px">
      <label class="field">Mikrofon<select data-dev="mic" ${rec ? 'disabled' : ''}></select></label>
      <label class="field">Kamera<select data-dev="cam"></select></label>
      <div class="row" style="gap:12px">
        <label class="field grow">Videoauflösung<select data-v="vres">${[480, 720, 1080, 1440, 2160].map(v => `<option value="${v}" ${+prefs.vres === v ? 'selected' : ''}>${v === 2160 ? '4K (2160p)' : v + 'p'}</option>`).join('')}</select></label>
        <label class="field grow">Bildrate<select data-v="vfps">${[24, 25, 30, 50, 60].map(v => `<option value="${v}" ${+prefs.vfps === v ? 'selected' : ''}>${v} fps</option>`).join('')}</select></label>
      </div>
      <label class="check"><span class="switch"><input type="checkbox" data-mirror ${prefs.mirror ? 'checked' : ''}><span></span></span>Eigenes Kamerabild spiegeln</label>
      <label class="check"><span class="switch"><input type="checkbox" data-eco ${prefs.eco ? 'checked' : ''}><span></span></span>Energiesparmodus (Video max. 720p / 24 fps – schont den Akku)</label>
      <div class="muted" style="font-size:12px">Kamera liefert gerade: <b>${esc(camInfo() || '–')}</b>. Das Video wird nicht aufgenommen, höhere Werte verbessern nur das Bild im Call.</div>
      <div class="row wrap" style="gap:16px">
        <label class="check"><span class="switch"><input type="checkbox" data-o="ec" ${prefs.ec ? 'checked' : ''} ${rec ? 'disabled' : ''}><span></span></span>Echounterdrückung</label>
        <label class="check"><span class="switch"><input type="checkbox" data-o="ns" ${prefs.ns ? 'checked' : ''} ${rec ? 'disabled' : ''}><span></span></span>Rauschfilter</label>
        <label class="check"><span class="switch"><input type="checkbox" data-o="agc" ${prefs.agc ? 'checked' : ''} ${rec ? 'disabled' : ''}><span></span></span>Auto-Pegel</label>
      </div>
      ${rec ? '<div class="hint">Mikrofon und Audiofilter lassen sich während einer Aufnahme nicht ändern.</div>' : ''}
      <div class="row" style="justify-content:flex-end"><span class="muted grow" style="font-size:12px">Version ${esc(config.version || '?')}</span><button class="btn" data-x>Abbrechen</button><button class="btn primary" data-ok>Übernehmen</button></div>
    </div>`);
  await fillDevices();
  $('[data-x]', m).onclick = () => m.close();
  $('[data-ok]', m).onclick = async () => {
    const mic = $('[data-dev=mic]', m).value, cam = $('[data-dev=cam]', m).value;
    const o = k => $(`[data-o=${k}]`, m).checked;
    m.close();
    const audioChanged = !rec && (mic !== prefs.mic || o('ec') !== prefs.ec || o('ns') !== prefs.ns || o('agc') !== prefs.agc);
    const curCam = localStream.getVideoTracks()[0]?.getSettings().deviceId || 'none';
    const camChanged = cam !== curCam;
    setMirror($('[data-mirror]', m).checked);
    const ecoChanged = $('[data-eco]', m).checked !== !!prefs.eco;
    prefs.eco = $('[data-eco]', m).checked;
    const vres = +$('[data-v=vres]', m).value, vfps = +$('[data-v=vfps]', m).value;
    const qualityChanged = ecoChanged || vres !== +prefs.vres || vfps !== +prefs.vfps;
    prefs.mic = mic; prefs.ec = o('ec'); prefs.ns = o('ns'); prefs.agc = o('agc'); prefs.cam = cam;
    prefs.vres = vres; prefs.vfps = vfps;
    savePrefs();
    try {
      if (audioChanged) {
        const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() });
        const nt = s.getAudioTracks()[0];
        const wasOn = micOn();
        for (const t of localStream.getAudioTracks()) { t.stop(); localStream.removeTrack(t); }
        nt.enabled = wasOn;
        localStream.addTrack(nt);
        for (const p of peers.values()) await p.setAudioTrack(nt);
        tiles.get('me').level = levelOf(localStream);
      }
      if (camChanged) {
        for (const t of localStream.getVideoTracks()) { t.stop(); localStream.removeTrack(t); }
        let track = null;
        if (cam !== 'none') {
          const s = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
          track = s.getVideoTracks()[0];
          localStream.addTrack(track);
        }
        for (const p of peers.values()) await p.setVideoTrack(track);
      } else if (qualityChanged) {
        await applyVideoQuality();
      }
      if (camOn() && (camChanged || qualityChanged)) setTimeout(() => toast(`Kamera: ${camInfo()}`), 600);
    } catch (e) { toast('Gerät konnte nicht gewechselt werden: ' + e.message, { error: true }); }
    renderMicCam(); updateLocalTile(); sendStatus();
  };
}

// ---------------- Status an andere ----------------
let statusTimer = null;
function sendStatusSoon() { clearTimeout(statusTimer); statusTimer = setTimeout(sendStatus, 400); }
function sendStatus() {
  const up = myUploadText();
  wsSend({ type: 'status', status: { mic: micOn(), cam: camOn(), rec: !!rec, upload: up?.text || '', uploadOk: !!up?.ok,
    camStream: localStream?.id || '', screen: screenStream ? screenStream.id : '' } });
  updateLocalTile();
  renderPeople();
}

function myUploadText() {
  // Zustand der eigenen (neuesten) Spur
  const id = rec?.trackId || lastTrackId;
  if (!id) return null;
  const p = uploader.progress[id];
  if (rec) {
    if (!p) return { text: 'Upload startet …' };
    const behind = rec.chunks - (p.sent || 0);
    return behind <= 3 ? { text: 'Upload live ✓', ok: true } : { text: `Upload ${behind}s im Rückstand` };
  }
  if (!p) return null;
  if (p.finalized) return { text: 'Auf Server gesichert ✓', ok: true };
  const pct = p.total ? Math.floor((p.sent / p.total) * 100) : 0;
  return { text: `Upload ${pct}%` };
}

function renderUploadBadge() {
  const b = $('#uploadBadge');
  const up = myUploadText();
  if (!up) { b.style.display = 'none'; return; }
  b.style.display = '';
  b.className = 'badge' + (up.ok ? ' ok' : ' warn');
  b.textContent = up.text;
  updateLocalTile();
}

function setHtml(el, html) { if (el && el.__html !== html) { el.__html = html; el.innerHTML = html; } }
function renderPeople() {
  const box = $('#peopleList');
  if (!box) return;
  const target = { set innerHTML(h) { setHtml(box, h); } };
  const row = (name, s, me) => `<div class="part">
    <div class="avatar" style="background:hsl(${hue(name)} 55% 45%)">${esc(initials(name))}</div>
    <div class="grow"><div style="font-weight:600"><span translate="no">${esc(name)}</span>${me ? ' <span class="muted">(du)</span>' : ''}</div>
      <div class="muted" style="font-size:12px">${s.mic === false ? 'stumm' : 'Mikro an'} · ${s.cam ? 'Kamera an' : 'Kamera aus'}${s.screen ? ' · teilt Bildschirm' : ''}${s.upload ? ' · ' + esc(s.upload) : ''}</div></div>
    ${s.rec ? '<span class="badge rec"><span class="dot pulse"></span>REC</span>' : ''}</div>`;
  const up = myUploadText();
  target.innerHTML = row(myName, { mic: micOn(), cam: camOn(), rec: !!rec, upload: up?.text, screen: !!screenStream }, true) +
    [...peers.values()].map(p => row(p.name, p.status || {}, false)).join('');
}

// ---------------- Aufnahme ----------------
let lastTrackId = null;

function onRecClick() {
  if (recSession) {
    confirmDialog('Aufnahme für alle beenden?', { ok: 'Aufnahme beenden', danger: true }).then(ok => {
      if (!ok) return;
      if (!wsSend({ type: 'rec-stop', sessionId: recSession?.sessionId })) stopLocal();
    });
  } else {
    if (!wsSend({ type: 'rec-start' })) toast('Keine Verbindung zum Server.', { error: true });
    $('#recBtn').disabled = true;
    setTimeout(() => ($('#recBtn').disabled = false), 1500);
  }
}

async function onRecStart(info) {
  if (recSession && recSession.sessionId === info.sessionId) return;
  if (rec) await stopLocal();
  recSession = { sessionId: info.sessionId, startAt: info.startAt };
  renderRecBtn();
  const r = new TrackRecorder({
    stream: localStream, sessionId: info.sessionId, roomId, roomName: roomInfo.name, name: myName,
    clientId: myId, bitrate: prefs.bitrate, serverNow, backupDir,
  });
  rec = r;
  lastTrackId = r.trackId;
  r.addEventListener('chunk', () => { uploader.kick(); renderUploadBadge(); });
  r.addEventListener('warn', e => toast(e.detail, { error: true, ms: 6000 }));
  try {
    await r.start();
    toast(info.by && info.by !== myName ? `Aufnahme gestartet von ${info.by}` : 'Aufnahme läuft');
  } catch (e) {
    console.error(e);
    toast('Aufnahme konnte nicht starten: ' + e.message, { error: true, ms: 10000 });
    rec = null;
  }
  renderRecBtn(); sendStatus();
}

async function stopLocal() {
  const r = rec;
  rec = null;
  recSession = null;
  renderRecBtn();
  if (!r) return;
  await r.stop();
  uploader.kick();
  sendStatus();
  refreshBackups();
  if (prefs.autoDl) {
    const blob = await idb.trackBlob(r.trackId);
    downloadBlob(blob, `${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}_${myName}_backup.mp3`);
  }
}

function renderRecBtn() {
  const b = $('#recBtn');
  const on = !!recSession;
  b.classList.toggle('recording', on);
  b.innerHTML = on ? `${icon.stop}<span class="lbl">Aufnahme stoppen</span>` : `${icon.rec}<span class="lbl">Aufnahme starten</span>`;
  b.title = on ? 'Aufnahme stoppen' : 'Aufnahme starten';
  $('#recBadge').classList.toggle('hidden', !on);
  $('#floatRec').classList.toggle('hidden', !on);
  document.body.classList.toggle('is-rec', on);
  $('#markerBtn').disabled = !on;
}

function tickTimer() {
  const el = $('#timer');
  const txt = !recSession ? (rec ? '…' : '0:00') : fmtTime((serverNow() - recSession.startAt) / 1000);
  if (el.textContent !== txt) el.textContent = txt;
  el.style.color = recSession ? '#ff8a96' : '';
  if (recSession) {
    if ($('#recBadgeTime').textContent !== txt) $('#recBadgeTime').textContent = txt;
    if ($('#floatTime').textContent !== txt) $('#floatTime').textContent = txt;
    const up = myUploadText();
    const u = up ? (up.ok ? '✓' : up.text.replace('Upload ', '↑')) : '';
    if ($('#floatUp').textContent !== u) $('#floatUp').textContent = u;
  }
}

function setMarker() {
  if (!recSession) return;
  wsSend({ type: 'marker', label: 'Marker' });
}

// ---------------- Chat ----------------
const seenFiles = new Set();
// Links in Chat-Texten anklickbar machen
const linkify = t => esc(t).replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

function fileCard(f) {
  const ext = (f.name.split('.').pop() || '').slice(0, 4).toUpperCase();
  const isImg = /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(f.type);
  const isAudio = /^audio\//i.test(f.type);
  const isVideo = /^video\/(mp4|webm|quicktime)$/i.test(f.type);
  return `<div class="file">
      ${isImg ? `<a href="${esc(f.url)}?inline" target="_blank" rel="noopener"><img src="${esc(f.url)}?inline" alt="" loading="lazy"></a>` : ''}
      ${isAudio ? `<audio controls preload="none" src="${esc(f.url)}?inline"></audio>` : ''}
      ${isVideo ? `<video controls preload="metadata" src="${esc(f.url)}?inline"></video>` : ''}
      <div class="row" style="gap:10px"><span class="ext">${esc(ext || 'DATEI')}</span>
        <div class="grow" style="min-width:0"><div class="fn" title="${esc(f.name)}" translate="no">${esc(f.name)}</div><div class="muted" style="font-size:11.5px">${fmtBytes(f.size)}</div></div>
        <a class="btn sm icon" href="${esc(f.url)}" download="${esc(f.name)}" title="Herunterladen">${icon.download}</a></div>
    </div>`;
}

function addChat(m, fromHistory = false) {
  const me = m.from === myId;
  if (m.kind === 'file') {
    if (seenFiles.has(m.file.id)) return;
    seenFiles.add(m.file.id);
    $(`#chatLog [data-pending="${m.file.id}"]`)?.remove();
  }
  const el = document.createElement('div');
  el.className = 'msg' + (me ? ' me' : '');
  el.innerHTML = `<div class="who"><span translate="no">${esc(m.name)}</span> · ${new Date(m.ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</div>` +
    (m.kind === 'file' ? fileCard(m.file) : `<div class="txt" translate="no">${linkify(m.text)}</div>`);
  $('#chatLog').appendChild(el);
  $('#chatLog').scrollTop = 1e9;
  if (fromHistory) return;
  const tab = $('.tabs button[data-tab=chat]');
  if (!me && (!tab.classList.contains('active') || $('#side').classList.contains('closed'))) {
    tab.textContent = 'Chat •';
    toast(m.kind === 'file' ? `${m.name} hat „${m.file.name}“ geteilt` : `${m.name}: ${m.text.slice(0, 80)}`);
  }
}

// Datei in 8-MB-Stücken hochladen (funktioniert auch durch Cloudflare mit großen Dateien)
async function uploadChatFile(file) {
  const box = $('#chatLog');
  const el = document.createElement('div');
  el.className = 'msg me pending';
  el.innerHTML = `<div class="who">${esc(myName)} · wird hochgeladen</div><div class="file"><div class="row" style="gap:10px">
      <div class="grow" style="min-width:0"><div class="fn" translate="no">${esc(file.name)}</div><div class="muted" style="font-size:11.5px" data-st>${fmtBytes(file.size)} · 0 %</div></div>
      <button class="btn sm icon ghost" data-cancel title="Abbrechen">${icon.x}</button></div><div class="progress" style="margin-top:8px"><i></i></div></div>`;
  box.appendChild(el); box.scrollTop = 1e9;
  $('.tabs button[data-tab=chat]').click();
  let cancelled = false;
  $('[data-cancel]', el).onclick = () => { cancelled = true; el.remove(); };
  const base = `/api/rooms/${encodeURIComponent(roomId)}/files`;
  try {
    const init = await api(base, { method: 'POST', body: { name: file.name, size: file.size, type: file.type, from: myId, by: myName } });
    el.dataset.pending = init.id;
    const chunk = init.chunk || 8 * 1024 * 1024;
    let off = 0, tries = 0;
    while (off < file.size && !cancelled) {
      try {
        const r = await api(`${base}/${init.id}/chunk?offset=${off}`, { method: 'PUT', body: file.slice(off, off + chunk) });
        off = r.received; tries = 0;
      } catch (e) {
        if (++tries > 5) throw e;
        await new Promise(r => setTimeout(r, 1500 * tries));
      }
      const pct = file.size ? Math.floor((off / file.size) * 100) : 100;
      $('[data-st]', el).textContent = `${fmtBytes(off)} von ${fmtBytes(file.size)} · ${pct} %`;
      $('.progress i', el).style.width = pct + '%';
    }
    if (cancelled) return;
    await api(`${base}/${init.id}/complete`, { method: 'POST', body: {} });
  } catch (e) {
    $('.who', el).textContent = 'Upload fehlgeschlagen';
    $('[data-st]', el).textContent = e.message;
    el.classList.add('failed');
    toast(`„${file.name}“ konnte nicht geteilt werden: ${e.message}`, { error: true, ms: 7000 });
  }
}

function setupChatDrop() {
  const zone = $('#side');
  let depth = 0;
  zone.addEventListener('dragenter', e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); depth++; zone.classList.add('dropping'); } });
  zone.addEventListener('dragover', e => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('dropping'); } });
  zone.addEventListener('drop', e => {
    depth = 0; zone.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) uploadChatFile(f);
  });
  // Bilder aus der Zwischenablage direkt in den Chat einfügen
  $('#chatIn').addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    files.forEach(f => uploadChatFile(f.name && f.name !== 'image.png' ? f : new File([f], `Bild-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}.png`, { type: f.type })));
  });
}

// ---------------- Bildschirm teilen ----------------
let screenStream = null;
let layoutBeforeScreen = null;

function screenLayout() {
  const any = [...tiles.values()].some(t => t.screen);
  if (any && layoutMode !== 'spotlight') { layoutBeforeScreen = layoutMode; layoutMode = 'spotlight'; }
  else if (!any && layoutBeforeScreen) { layoutMode = layoutBeforeScreen; layoutBeforeScreen = null; }
  layoutTiles(true);
}

const screenFps = () => (prefs.eco ? 15 : 30);
async function tuneScreenSender(sender) {
  if (!sender?.track) return;
  try {
    const prm = sender.getParameters();
    if (!prm.encodings?.length) return;
    // 30 fps für flüssige Bewegungen (Videos, Scrollen); im Energiesparmodus 15 fps
    prm.encodings[0].maxBitrate = prefs.eco ? 1.5e6 : 6e6;
    prm.encodings[0].maxFramerate = screenFps();
    prm.encodings[0].scaleResolutionDownBy = 1;
    prm.degradationPreference = 'maintain-resolution'; // Text soll scharf bleiben – bei Engpass lieber weniger fps
    await sender.setParameters(prm);
  } catch (e) { console.warn('Bildschirm-Parameter', e); }
}

async function startScreen() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: screenFps(), max: screenFps() }, width: { max: 2560 }, height: { max: 1440 } },
      audio: false,
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('Bildschirm konnte nicht geteilt werden: ' + e.message, { error: true });
    screenStream = null;
    return;
  }
  const track = screenStream.getVideoTracks()[0];
  try { track.contentHint = 'detail'; } catch { /* egal */ }
  try { await track.applyConstraints({ frameRate: { ideal: screenFps(), max: screenFps() } }); } catch { /* egal */ }
  track.addEventListener('ended', () => stopScreen()); // „Freigabe beenden“ im Browser
  sendStatus(); // erst ankündigen, dann Spur senden → Partner ordnet sie richtig zu
  addTile('me:screen', { name: 'Dein Bildschirm', local: true, screen: true, stream: screenStream });
  for (const p of peers.values()) if (p.tracksAdded) p.addScreen();
  screenLayout();
  renderScreenBtn();
  clearInterval(screenInfoTimer); screenInfoTimer = setInterval(updateScreenInfo, 2000); updateScreenInfo();
}

// Anzeige auf der eigenen Bildschirm-Kachel: Auflösung, tatsächliche fps, Codec und ob die Grafikhardware kodiert
let screenInfoTimer = null;
const HW_ENC = /videotoolbox|mediafoundation|accelerator|vaapi|nvenc|qsv|amf|v4l2|mediacodec|external/i;
async function updateScreenInfo() {
  const tile = tiles.get('me:screen');
  if (!screenStream || !tile) return;
  const st = screenStream.getVideoTracks()[0]?.getSettings() || {};
  let txt = st.width ? `${st.width}×${st.height} · ${Math.round(st.frameRate || 0)} fps` : '';
  const sender = [...peers.values()].map(p => p.screenSender).find(Boolean);
  if (sender) {
    try {
      const stats = await sender.getStats();
      const codecs = {}; let out = null;
      stats.forEach(r => { if (r.type === 'codec') codecs[r.id] = r.mimeType; if (r.type === 'outbound-rtp' && r.kind === 'video') out = r; });
      if (out) {
        if (out.frameWidth) txt = `${out.frameWidth}×${out.frameHeight} · ${Math.round(out.framesPerSecond || 0)} fps`;
        const codec = (codecs[out.codecId] || '').replace(/^video\//, '');
        const hw = out.powerEfficientEncoder ?? (out.encoderImplementation ? HW_ENC.test(out.encoderImplementation) : null);
        if (codec) txt += ` · ${codec}${hw == null ? '' : hw ? ' · Hardware' : ' · Software'}`;
        if (out.encoderImplementation) tile.el.querySelector('.sinfo').title = out.encoderImplementation;
      }
    } catch { /* egal */ }
  }
  const box = tile.el.querySelector('.sinfo');
  if (box) { box.textContent = txt; box.classList.toggle('hidden', !txt); }
}

function stopScreen() {
  if (!screenStream) return;
  clearInterval(screenInfoTimer); screenInfoTimer = null;
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  for (const p of peers.values()) p.removeScreen();
  removeTile('me:screen');
  sendStatus();
  screenLayout();
  renderScreenBtn();
}
function renderScreenBtn() {
  $('#screenBtn').classList.toggle('on', !!screenStream);
  $('#screenBtn').title = screenStream ? 'Bildschirmfreigabe beenden' : 'Bildschirm teilen';
}

// Welcher Codec läuft? (in der Browser-Konsole sichtbar, hilft bei der Akku-Fehlersuche)
async function logCodec(p) {
  try {
    const stats = await p.pc.getStats();
    const codecs = {};
    stats.forEach(r => { if (r.type === 'codec') codecs[r.id] = r.mimeType; });
    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') console.info(`[Remote Booth] Video an ${p.name}: ${codecs[r.codecId] || '?'}, Encoder: ${r.encoderImplementation || '?'}`);
    });
  } catch { /* egal */ }
}

// ---------------- Lokale Backups ----------------
let backupsTimer = null;
function refreshBackupsSoon() { clearTimeout(backupsTimer); backupsTimer = setTimeout(refreshBackups, 1000); }
async function refreshBackups() {
  const box = $('#backupList');
  if (!box) return;
  const pane = box.closest('.tabpane');
  if (pane && pane.classList.contains('hidden')) return; // unsichtbar → nicht ständig neu aufbauen
  const list = (await idb.allTracks().catch(() => [])).filter(t => t.roomId === roomId).sort((a, b) => b.createdAt - a.createdAt);
  if (!list.length) { box.innerHTML = '<div class="muted">Noch keine Aufnahmen in diesem Browser.</div>'; }
  else {
    box.innerHTML = list.map(t => {
      const p = uploader.progress[t.trackId];
      const sent = p?.sent ?? t.uploadedNext ?? 0;
      let st;
      if (t.orphan) st = '<span class="badge warn">Nur lokal (Session gelöscht)</span>';
      else if (t.finalized) st = '<span class="badge ok">Auf Server ✓</span>';
      else if (rec && rec.trackId === t.trackId) st = '<span class="badge rec">Läuft</span>';
      else st = `<span class="badge warn">Upload ${t.chunks ? Math.floor((sent / t.chunks) * 100) : 0}%</span>`;
      return `<div class="rec-item" data-id="${esc(t.trackId)}">
        <div class="row"><div class="grow"><div class="title"><span translate="no">${esc(t.name)}</span> · ${new Date(t.createdAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })}</div>
        <div class="sub">${fmtTime(t.duration || 0)} · ${t.bitrate} kbit/s</div></div>${st}</div>
        <div class="row">
          <button class="btn sm" data-a="dl">${icon.download}MP3</button>
          ${!t.finalized && !t.orphan ? `<button class="btn sm" data-a="retry">${icon.upload}Erneut senden</button>` : ''}
          <div class="grow"></div>
          <button class="btn sm icon danger" data-a="del" title="Lokale Kopie löschen">${icon.trash}</button>
        </div></div>`;
    }).join('');
    for (const el of $$('.rec-item', box)) {
      const id = el.dataset.id;
      const t = list.find(x => x.trackId === id);
      $('[data-a=dl]', el).onclick = async () => downloadBlob(await idb.trackBlob(id), `${t.name}_${new Date(t.createdAt).toISOString().slice(0, 16).replace(/[T:]/g, '-')}.mp3`);
      const retry = $('[data-a=retry]', el);
      if (retry) retry.onclick = () => { uploader.kick(); toast('Upload wird erneut versucht'); };
      $('[data-a=del]', el).onclick = async () => {
        if (rec && rec.trackId === id) return toast('Läuft gerade.');
        const ok = await confirmDialog(t.finalized ? 'Lokale Kopie löschen? (Auf dem Server bleibt sie erhalten.)' : 'Achtung: Diese Spur ist noch NICHT vollständig auf dem Server. Wirklich löschen?', { ok: 'Löschen', danger: true });
        if (ok) { await idb.deleteTrack(id); refreshBackups(); }
      };
    }
  }
  const info = await idb.storageInfo();
  if (info?.quota) $('#storageInfo').textContent = `Browser-Speicher: ${fmtBytes(info.usage)} von ${fmtBytes(info.quota)} belegt`;
}

// ---------------- Verlassen ----------------
async function leave() {
  if (rec) {
    const ok = await confirmDialog('Du nimmst gerade auf. Deine Aufnahme beenden und den Raum verlassen?', { ok: 'Verlassen', danger: true });
    if (!ok) return;
    await stopLocal();
  }
  const pending = await uploader.pendingCount();
  if (pending) {
    const ok = await confirmDialog('Es werden noch Daten hochgeladen. Trotzdem verlassen? (Die lokale Sicherung bleibt erhalten und wird beim nächsten Öffnen weiter hochgeladen.)', { ok: 'Verlassen' });
    if (!ok) return;
  }
  leaving = true;
  try { ws.close(); } catch { /* egal */ }
  for (const p of peers.values()) p.close();
  localStream?.getTracks().forEach(t => t.stop());
  location.href = config.admin ? '/' : location.pathname;
}
