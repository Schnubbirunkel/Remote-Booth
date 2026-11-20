// Remote Booth – kleiner Node-Server.
// Aufgaben: statische Seiten, WebRTC-Signalisierung (WebSocket), Entgegennahme der
// MP3-Häppchen, Wellenformen und Export per ffmpeg. Keine Medienverarbeitung während
// der Aufnahme – der Videocall läuft direkt zwischen den Browsern (Peer-to-Peer).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const Store = require('./store');
const Settings = require('./settings');
const { Worker } = require('worker_threads');

// Rechenaufgabe in einem eigenen Thread (echte Parallelität); Abbruch über job.cancelled / Abbrechen-Knopf
function runWorker(kind, args, job, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(path.join(__dirname, 'export-worker.js'), { workerData: { kind, args } });
    const cancel = () => { try { w.postMessage({ cancel: true }); } catch { /* beendet */ } };
    if (job) { (job.workers = job.workers || new Set()).add(cancel); if (job.cancelled) cancel(); }
    let settled = false;
    const fin = (fn, v) => { if (!settled) { settled = true; job?.workers?.delete(cancel); fn(v); } };
    w.on('message', m => {
      if (m.progress != null) onProgress && onProgress(m.progress);
      else if (m.done) fin(resolve, m.result);
      else if (m.error) fin(reject, Object.assign(new Error(m.error), { cancelled: m.cancelled }));
    });
    w.on('error', e => fin(reject, e));
    w.on('exit', code => fin(code === 0 ? resolve : reject, code === 0 ? null : new Error(`Rechen-Thread beendet (${code})`)));
  });
}
const audio = require('./audio');

const PORT = parseInt(process.env.PORT || '8080', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const MAX_PEERS = parseInt(process.env.MAX_PEERS || '4', 10);
// Optionaler Exportordner (im Container, z. B. /exports) – fertige MP3s landen dort je Aufnahme in einem Unterordner
// Pfade auf einem Netzlaufwerk unter /media werden direkt benutzt (/media ist mit „rslave“ eingebunden, so taucht
// eine erst nach dem Start eingehängte Freigabe auch im Container auf). Andere Pfade kommen über eigene Mounts.
const viaMedia = (hostPath, mount) => (hostPath && hostPath.startsWith('/media/') && fs.existsSync('/media') ? hostPath : mount);
// Vorgaben aus Umgebungsvariablen (ältere Installationen); in der Oberfläche gewählte Ordner haben Vorrang
const ENV_EXPORT_DIR = process.env.EXPORT_DIR ? viaMedia(process.env.EXPORT_PATH_HOST || process.env.EXPORT_DIR, process.env.EXPORT_DIR) : '';
const ENV_RECORDINGS_DIR = process.env.RECORDINGS_DIR ? viaMedia(process.env.RECORDINGS_PATH_HOST || '', process.env.RECORDINGS_DIR) : '';
const TMP_DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'tmp'); // Zwischendateien bleiben lokal
const PUID = parseInt(process.env.PUID || '', 10), PGID = parseInt(process.env.PGID || '', 10);
// Dateien im Chat: Obergrenze pro Datei (MB). Hochgeladen wird in 8-MB-Stücken (passt durch Cloudflare).
const CHAT_FILE_MAX_MB = parseInt(process.env.CHAT_FILE_MAX_MB || '2048', 10);
const APP_VERSION = require('../package.json').version;
const LAME_FILE = require.resolve('@breezystack/lamejs').replace(/lamejs\.(js|iife\.js)$/, 'lamejs.iife.js');

fs.mkdirSync(DATA_DIR, { recursive: true });
const settings = new Settings(DATA_DIR);
// Ordner: Einstellung → Umgebungsvariable → Standard im Datenordner
const recordingsDir = () => settings.get('recordingsDir') || ENV_RECORDINGS_DIR || path.join(DATA_DIR, 'sessions');
const exportDir = () => settings.get('exportDir') || ENV_EXPORT_DIR || path.join(DATA_DIR, 'exports');
const store = new Store(DATA_DIR, { recordingsDir: recordingsDir(), recordingsLabel: recordingsDir(), extraDirs: settings.get('recordingsHistory', []) });
fs.rmSync(TMP_DIR, { recursive: true, force: true }); fs.mkdirSync(TMP_DIR, { recursive: true });

// Mediapool (global, projektübergreifend)
// Ablage: LIBRARY_PATH (z. B. Netzlaufwerk), sonst/ersatzweise lokal unter DATA_DIR/library.
// Wird die Freigabe erreichbar, ziehen lokal liegende Einträge automatisch dorthin um.
const LIB_LOCAL = path.join(DATA_DIR, 'library');
let LIB_HOST = '';
let LIB_REMOTE = settings.get('libraryDir') || (process.env.LIBRARY_DIR ? viaMedia(process.env.LIBRARY_PATH_HOST || '', process.env.LIBRARY_DIR) : '');
fs.mkdirSync(LIB_LOCAL, { recursive: true });
if (LIB_REMOTE && Store.sameDir(LIB_REMOTE, LIB_LOCAL)) LIB_REMOTE = '';
let libState = { ok: false, why: '' }, libCheckedAt = 0, libLogged = false;
function libDir() {
  if (!LIB_REMOTE) return LIB_LOCAL;
  if (Date.now() - libCheckedAt > 20000) {
    libCheckedAt = Date.now();
    const was = libState.ok;
    libState = Store.usableDir(LIB_REMOTE);
    if (libState.ok) libMigrate();
    if (was !== libState.ok || !libLogged) libLogged = true, console.log(libState.ok ? `Media pool: ${LIB_REMOTE}` : `WARNING – media pool folder not reachable (${libState.why}) – using the app data folder for now`);
  }
  return libState.ok ? LIB_REMOTE : LIB_LOCAL;
}
// Lokale Einträge auf die Freigabe verschieben (bisheriger Pool bzw. während eines Ausfalls hochgeladene Dateien)
function libMigrate(FROM = LIB_LOCAL) {
  const LIB_LOCAL_ = FROM;
  const read = d => { try { return JSON.parse(fs.readFileSync(path.join(d, 'library.json'), 'utf8')); } catch { return []; } };
  const local = read(LIB_LOCAL_);
  if (!local.length) return;
  const remote = read(LIB_REMOTE);
  const have = new Set(remote.map(x => x.id));
  let moved = 0;
  for (const it of local) {
    if (have.has(it.id)) continue;
    try {
      for (const f of [it.file, it.file + '.peaks']) {
        const src = path.join(LIB_LOCAL_, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(LIB_REMOTE, f));
      }
      remote.push(it); moved++;
    } catch (e) { console.warn('Media pool: moving failed for', it.name, e.message); return; }
  }
  const tmp = path.join(LIB_REMOTE, 'library.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(remote, null, 1)); fs.renameSync(tmp, path.join(LIB_REMOTE, 'library.json'));
  for (const it of local) for (const f of [it.file, it.file + '.peaks']) fs.rmSync(path.join(LIB_LOCAL_, f), { force: true });
  fs.rmSync(path.join(LIB_LOCAL_, 'library.json'), { force: true });
  if (moved) console.log(`Media pool: moved ${moved} file(s) to ${LIB_REMOTE}`);
}
const libIndex = () => path.join(libDir(), 'library.json');
function setLibraryDir(dir) {
  const from = libDir();
  LIB_REMOTE = dir && !Store.sameDir(dir, LIB_LOCAL) ? dir : '';
  libCheckedAt = 0; libLogged = false;
  const to = libDir();
  if (to !== from && !Store.sameDir(to, from)) { const keep = LIB_REMOTE; LIB_REMOTE = to; try { libMigrate(from); } finally { LIB_REMOTE = keep; } }
}
const LIB_CATS = ['Intro', 'Outro', 'Jingle', 'Soundeffekt', 'Musik', 'Sonstiges'];
const libCat = c => LIB_CATS.find(x => x.toLowerCase() === String(c || '').toLowerCase()) || 'Sonstiges';
function libLoad() { try { return JSON.parse(fs.readFileSync(libIndex(), 'utf8')); } catch { return []; } }
function libSave(list) { const f = libIndex(); fs.writeFileSync(f + '.tmp', JSON.stringify(list, null, 1)); fs.renameSync(f + '.tmp', f); }
function libList() { return libLoad().sort((a, b) => LIB_CATS.indexOf(a.category) - LIB_CATS.indexOf(b.category) || a.name.localeCompare(b.name, 'de')); }
function libGuessCat(name) {
  const n = name.toLowerCase();
  if (/intro|opener|opening/.test(n)) return 'Intro';
  if (/outro|ending|abspann/.test(n)) return 'Outro';
  if (/jingle|trenner|stinger|sting|bumper/.test(n)) return 'Jingle';
  if (/sfx|effekt|effect|applaus|lach|ding|whoosh|swoosh|boom|klick|click/.test(n)) return 'Soundeffekt';
  if (/musik|music|bed|loop|song/.test(n)) return 'Musik';
  return 'Sonstiges';
}
async function libAdd(data, filename, category) {
  let ext = path.extname(filename).toLowerCase();
  if (!['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm'].includes(ext)) ext = '.mp3';
  const id = 'l' + Store.id(8);
  const file = path.join(libDir(), id + ext);
  fs.writeFileSync(file, data);
  let duration;
  try { duration = await audio.probeDuration(file); } catch (e) { fs.rmSync(file, { force: true }); throw new Error('Datei konnte nicht gelesen werden: ' + e.message); }
  try { await audio.computePeaks(file, file + '.peaks'); } catch { /* optional */ }
  const name = path.basename(filename, path.extname(filename)).slice(0, 80) || 'Audio';
  const item = { id, name, file: id + ext, bytes: data.length, duration, category: category ? libCat(category) : libGuessCat(name), added: Date.now() };
  const list = libLoad(); list.push(item); libSave(list);
  return item;
}

// ---------- Auth (optional) ----------
const secretFile = path.join(DATA_DIR, 'secret');
if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString('hex'));
const SECRET = fs.readFileSync(secretFile, 'utf8').trim();
// Passwort: Umgebungsvariable APP_PASSWORD (falls gesetzt) oder in der Oberfläche festgelegt (gehasht in settings.json)
const passwordActive = () => !!APP_PASSWORD || settings.hasPassword();
const setupRequired = () => !APP_PASSWORD && !settings.isSetUp();
const adminToken = () => crypto.createHmac('sha256', SECRET).update('admin:' + (APP_PASSWORD || settings.get('passwordHash', 'none'))).digest('base64url');
const checkPassword = pw => (APP_PASSWORD
  ? (() => { const a = Buffer.from(String(pw || '')), b = Buffer.from(APP_PASSWORD); return a.length === b.length && crypto.timingSafeEqual(a, b); })()
  : settings.checkPassword(pw));
const authCookie = req => `ps_auth=${adminToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isAdmin = req => !setupRequired() && (!passwordActive() || cookies(req).ps_auth === adminToken());

// ---------- ICE-Server (STUN/TURN) ----------
function iceServers() {
  if (process.env.ICE_SERVERS) {
    try { return JSON.parse(process.env.ICE_SERVERS); } catch { console.warn('ICE_SERVERS is not valid JSON'); }
  }
  const list = [];
  const stun = process.env.STUN_URL ?? 'stun:stun.l.google.com:19302';
  if (stun) list.push({ urls: stun.split(',').map(s => s.trim()) });
  if (process.env.TURN_URL) {
    const urls = process.env.TURN_URL.split(',').map(s => s.trim());
    if (process.env.TURN_SECRET) {
      // Zeitlich begrenzte Zugangsdaten (coturn: use-auth-secret / static-auth-secret)
      const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:podcast`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      list.push({ urls, username, credential });
    } else {
      list.push({ urls, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
    }
  }
  return list;
}

// ---------- HTTP-Helfer ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.webm': 'audio/webm', '.aac': 'audio/aac', '.webmanifest': 'application/manifest+json',
};

function send(res, code, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, {
    'Content-Type': isObj ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > limit) { reject(Object.assign(new Error('Zu groß'), { status: 413 })); req.destroy(); return; }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 2 * 1024 * 1024);
  try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw Object.assign(new Error('Ungültiges JSON'), { status: 400 }); }
}

// Datei mit Range-Unterstützung (wichtig zum Spulen im Editor)
const AUDIO_CHUNK = 1024 * 1024;
function sendFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, 'Nicht gefunden'); }
  if (!st.isFile()) return send(res, 404, 'Nicht gefunden');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), ...extraHeaders };
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range && st.size > 0) {
    let start = range[1] ? parseInt(range[1], 10) : 0;
    let end = range[2] ? parseInt(range[2], 10) : st.size - 1;
    if (!range[1] && range[2]) { start = Math.max(0, st.size - parseInt(range[2], 10)); end = st.size - 1; }
    end = Math.min(end, st.size - 1);
    // Audio für den Player in Häppchen (1 MB ≈ 1 min) ausliefern: Der Browser holt den Rest per
    // Folge-Anfrage. So blockieren lange Audio-Streams keine Verbindungen, und kleine Anfragen
    // (Speichern, Abgleich) kommen auch über langsame Leitungen/Tunnel sofort durch.
    if (/^audio\//.test(type) && !extraHeaders['Content-Disposition']) end = Math.min(end, start + AUDIO_CHUNK - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// Cache-Busting: Alle Verweise auf eigene .js/.css-Dateien bekommen ?v=<Version>.
// So kann nach einem Update weder der Browser noch Cloudflare alte Dateien ausliefern.
const VER_Q = `v=${encodeURIComponent(APP_VERSION)}`;
function versionRefs(text, ext) {
  if (ext === '.html') {
    return text.replace(/((?:src|href)=")(\/(?:js|css|vendor)\/[^"?]+\.(?:js|css))"/g, `$1$2?${VER_Q}"`);
  }
  // JS: import … from './x.js', import('./x.js'), sowie feste Pfade wie '/js/rec-worklet.js'
  return text
    .replace(/(from\s+['"])(\.\/[^'"?]+\.js)(['"])/g, `$1$2?${VER_Q}$3`)
    .replace(/(import\(\s*['"])(\.\/[^'"?]+\.js)(['"])/g, `$1$2?${VER_Q}$3`)
    .replace(/(['"])(\/(?:js|vendor)\/[^'"?]+\.js)(['"])/g, `$1$2?${VER_Q}$3`);
}
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' };

function serveStatic(req, res, pathname) {
  if (pathname === '/vendor/lame.js') return sendFile(req, res, LAME_FILE, { 'Cache-Control': 'public, max-age=86400' });
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Verboten');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.js') {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return send(res, 404, 'Nicht gefunden'); }
    // Worklet: gemeinsamen Effekt-Code voranstellen (derselbe Code rechnet den Export)
    if (pathname === '/js/fx-worklet.js') text = fs.readFileSync(path.join(PUBLIC_DIR, 'js', 'dsp-core.js'), 'utf8') + '\n' + text;
    if (ext === '.html') {
      const dl = String(settings.get('language', '') || process.env.DEFAULT_LANGUAGE || '').replace(/[^a-z-]/gi, '');
      text = text.replace(/<html lang="de">/, `<html lang="${dl || 'en'}" data-default-lang="${dl}" class="i18n-pending">`)
        .replace('</head>', '<style>html.i18n-pending body{visibility:hidden}</style><script>setTimeout(function(){document.documentElement.classList.remove("i18n-pending")},1500)</script></head>');
    }
    const body = Buffer.from(versionRefs(text, ext));
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': body.length, ...NO_STORE });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  sendFile(req, res, file, NO_STORE);
}

let exportDirError = '';
function exportDirUsable() {
  const EXPORT_DIR = exportDir();
  // Echter Schreibtest; legt höchstens den Exportordner selbst an (nie Platzhalter auf der lokalen Platte)
  const r = Store.usableDir(EXPORT_DIR);
  exportDirError = r.ok ? '' : `${EXPORT_DIR}: ${r.why}`;
  return r.ok;
}
// Exportierte Dateien für alle beschreibbar machen (z. B. über SMB/ZimaOS-Dateimanager löschbar)
function openUp(p, isDir) {
  try { fs.chmodSync(p, isDir ? 0o777 : 0o666); } catch { /* egal */ }
  if (Number.isFinite(PUID)) { try { fs.chownSync(p, PUID, Number.isFinite(PGID) ? PGID : PUID); } catch { /* egal */ } }
}
// Unterordner im Exportordner heißt wie das Projekt (nur unzulässige Zeichen entfernt)
const exportFolderName = s => String(s.name || 'Projekt').normalize('NFC').replace(/:/g, '-').replace(/[\/\\:*?"<>|\x00-\x1f]+/g, ' ')
  .replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120) || 'Projekt';
function exportFilePath(s, x) {
  if (x.path) return x.path; // ab 1.0: voller Pfad gespeichert (bleibt gültig, auch wenn der Exportordner wechselt)
  if (x.dir === 'ext') return path.join(exportDir(), x.folder, x.name);
  return path.join(store.sessionDir(s.id), 'out', x.name);
}

const safeName = s => String(s || 'spur').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'spur';

// Zugriff auf Session: Admin oder Gast mit passendem Raum-Schlüssel (X-Room)
function canWriteSession(req, s) {
  return isAdmin(req) || (s && req.headers['x-room'] === s.roomId);
}

function publicSession(s) {
  return { ...s, live: !!(rooms.get(s.roomId)?.recording?.sessionId === s.id) };
}

// ---------- Export-Jobs ----------
const jobs = new Map(); // sessionId -> {state, progress, step, error}

// Spuren (v2) für ffmpeg vorbereiten: Eingangsdateien sammeln, Clips darauf verweisen lassen
function lanesV2(s, { bypassFx = false, laneIds = null, includeMuted = false } = {}) {
  const edl = s.edl;
  const files = [], idx = new Map(), seekable = [], durations = [];
  const inputOf = srcId => {
    if (idx.has(srcId)) return idx.get(srcId);
    const t = s.tracks.find(x => x.id === srcId);
    if (!t) return null;
    const file = store.trackFile(s, t);
    if (!fs.existsSync(file) || !fs.statSync(file).size) return null;
    idx.set(srcId, files.length); files.push(file);
    seekable.push(t.kind === 'rec'); // Aufnahmen sind CBR-MP3 → exakt anspringbar
    durations.push(+t.duration || 0);
    return files.length - 1;
  };
  const lanes = [];
  let totalDur = 0;
  for (const id of edl.laneOrder || []) {
    if (laneIds && !laneIds.includes(id)) continue;
    const L = edl.tracks?.[id] || {};
    if (L.mute && !includeMuted) continue;
    const clips = [];
    for (const c of (edl.clips || []).filter(c => c.lane === id)) {
      const input = inputOf(c.src);
      if (input == null || !(c.len > 0)) continue;
      clips.push({ input, in: Math.max(0, +c.in || 0), len: +c.len, start: Math.max(0, +c.start || 0), gainDb: Math.max(-120, Math.min(24, +c.gainDb || 0)), fadeIn: Math.max(0, +c.fadeIn || 0), fadeOut: Math.max(0, +c.fadeOut || 0) });
      totalDur = Math.max(totalDur, (+c.start || 0) + (+c.len));
    }
    lanes.push({ id, name: L.name || 'Spur', clips, fx: bypassFx || L.fxOff ? null : L.fx, env: L.env || [], mutes: L.mutes || [], gainDb: +L.gainDb || 0 });
  }
  return { files, seekable, durations, lanes: lanes.filter(l => l.clips.length), totalDur };
}

async function runExportV2(s, opts, job, { useExt, folder, outDir, dir }) {
  const all = lanesV2(s, { bypassFx: !!opts.bypassFx });
  if (!all.lanes.length) throw new Error('Keine Spuren mit Audio vorhanden.');
  const base = {
    totalDur: all.totalDur,
    fadeIn: Math.max(0, +opts.fadeIn || 0), fadeOut: Math.max(0, +opts.fadeOut || 0),
    loudnorm: opts.loudnorm ? Math.max(-30, Math.min(-10, +opts.loudnorm)) : 0,
    channels: opts.channels === 2 ? 2 : 1,
    bitrate: [64, 96, 128, 160, 192, 256, 320].includes(+opts.bitrate) ? +opts.bitrate : 128,
    title: s.name,
    limiter: opts.bypassFx ? null : (s.edl.master?.limiter || { on: true, ceiling: -1, release: 50 }),
  };
  const slug = safeName(s.name).slice(0, 30) + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const list = [{ kind: 'mix', name: `${slug}-mix.mp3`, lanes: all.lanes, opt: base }];
  if (opts.singleTracks) for (const l of all.lanes) {
    list.push({ kind: 'track', name: `${slug}-${safeName(l.name)}.mp3`, lanes: [l],
      opt: { ...base, fadeIn: 0, fadeOut: 0, loudnorm: opts.loudnormTracks ? base.loudnorm : 0 } });
  }
  const results = new Array(list.length);
  const W = audio.EXPORT_WORKERS;
  job.outFiles = list.map(j => path.join(outDir, j.name));
  const t0 = Date.now();
  const finish = (j, k, outFile, editedDur) => {
    if (useExt) openUp(outFile, false);
    results[k] = { kind: j.kind, name: j.name, size: fs.statSync(outFile).size, duration: editedDur, createdAt: Date.now(),
      dir: useExt ? 'ext' : 'out', folder, hostPath: useExt ? path.join(exportDir(), folder, j.name) : null, path: path.join(outDir, j.name) };
  };
  // Platz für Zwischendateien (32 Bit float je Spur, lokal)?
  const tmpBytes = (all.lanes.length + all.files.length) * all.totalDur * 48000 * 4 * base.channels * 1.1;
  let freeBytes = Infinity;
  try { const st = fs.statfsSync(TMP_DIR); freeBytes = st.bavail * st.bsize; } catch { /* unbekannt */ }
  const twoStage = freeBytes > tmpBytes + 500e6;

  if (twoStage) {
    const tmpDir = path.join(TMP_DIR, `export-${s.id}-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const prog0 = new Array(all.files.length).fill(0), prog1 = new Array(all.lanes.length).fill(0), prog2 = new Array(list.length).fill(0);
    const sum = arr => arr.reduce((x, y) => x + y, 0);
    // Gewichte grob nach gemessener Dauer der Phasen (dekodieren / Spuren / Mix)
    const upd = () => { job.progress = 0.14 * sum(prog0) / Math.max(1, prog0.length) + 0.36 * sum(prog1) / prog1.length + 0.5 * sum(prog2) / prog2.length; };
    try {
      // Stufe 0: jede benutzte Audiodatei einmal dekodieren (parallel) – Schnitte sind danach exakte Lesezugriffe
      const tS = Date.now(), stamp = l => console.log(`  Export ${s.id}: ${l} after ${((Date.now() - tS) / 1000).toFixed(1)} s`);
      job.step = `Aufnahmen werden dekodiert (${Math.min(W, all.files.length)} parallel)`;
      const srcRaw = all.files.map((f, i) => ({ path: path.join(tmpDir, `src${i}.f32`) }));
      const expect = all.files.map((_, i) => Math.max(1, (all.durations[i] || all.totalDur) * 48000 * 4 * base.channels));
      const watch = setInterval(() => { srcRaw.forEach((r, i) => { try { prog0[i] = Math.min(1, fs.statSync(r.path).size / expect[i]); } catch { /* noch nicht da */ } }); upd(); }, 1000);
      try {
        await audio.pool(all.files.map((_, i) => i), W, async i => {
          await audio.decodeSourceRaw({ file: all.files[i], channels: base.channels, outFile: srcRaw[i].path, job });
          prog0[i] = 1; upd();
        }, job);
      } finally { clearInterval(watch); }
      stamp('decoded');
      // Stufe 1: jede Spur (Clips, Effekte, Hüllkurve) parallel als Rohdatei – je Spur ein eigener Rechen-Thread
      const laneRaw = all.lanes.map((l, i) => path.join(tmpDir, `lane${i}.f32`));
      job.step = `Spuren werden bearbeitet (${Math.min(W, all.lanes.length)} parallel)`;
      const order1 = all.lanes.map((_, i) => i).sort((x, y) => (all.lanes[y].fx ? 1 : 0) - (all.lanes[x].fx ? 1 : 0));
      try {
        await audio.pool(order1, W, async i => {
          await runWorker('lane', { lane: all.lanes[i], srcPaths: srcRaw.map(r => r.path), totalDur: all.totalDur,
            channels: base.channels, outFile: laneRaw[i] }, job, p => { prog1[i] = p; upd(); });
        }, job);
      } finally { for (const r of srcRaw) fs.rmSync(r.path, { force: true }); }
      stamp('tracks processed');
      // Stufe 2: Gesamtmix und Einzelspuren parallel
      job.step = list.length > 1 ? `Mix und Einzelspuren werden erstellt (${Math.min(W, list.length)} parallel)` : 'Gesamtmix wird erstellt';
      const order = list.map((j, k) => k).sort((x, y) => (list[x].kind === 'mix' ? -1 : list[y].kind === 'mix' ? 1 : 0));
      await audio.pool(order, W, async k => {
        const j = list[k];
        const idx = j.kind === 'mix' ? all.lanes.map((_, i) => i) : [all.lanes.indexOf(j.lanes[0])];
        const outFile = path.join(outDir, j.name);
        await runWorker('mix', { inputs: idx.map(i => laneRaw[i]), channels: base.channels, totalDur: all.totalDur,
          fadeIn: j.opt.fadeIn, fadeOut: j.opt.fadeOut, loudnorm: j.opt.loudnorm, limiter: j.opt.limiter, bitrate: j.opt.bitrate,
          title: j.opt.title, outFile, workDir: tmpDir }, job, p => { prog2[k] = p; upd(); });
        prog2[k] = 1; upd();
        finish(j, k, outFile, all.totalDur);
      }, job);
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  } else {
    // Einstufig (eine Spur, ein Kern oder wenig Speicherplatz): Ausgaben parallel, jede in einem Durchgang
    const prog = new Array(list.length).fill(0);
    job.step = list.length > 1 && W > 1 ? `Mix und Einzelspuren werden erstellt (${Math.min(W, list.length)} parallel)` : 'Gesamtmix wird erstellt';
    await audio.pool(list, W, async (j, k) => {
      const used = [...new Set(j.lanes.flatMap(l => l.clips.map(c => c.input)))];
      const remap = new Map(used.map((inp, q) => [inp, q]));
      const lanes = j.lanes.map(l => ({ ...l, clips: l.clips.map(c => ({ ...c, input: remap.get(c.input) })) }));
      const { graph, editedDur } = audio.buildGraphV2(lanes, j.opt);
      const outFile = path.join(outDir, j.name);
      await audio.renderGraph({ files: used.map(u => all.files[u]), graph, dur: editedDur, opts: j.opt, outFile, workDir: TMP_DIR,
        threads: W > 1 ? 1 : undefined, job, onProgress: p => { prog[k] = p; job.progress = prog.reduce((x, y) => x + y, 0) / list.length; } });
      prog[k] = 1;
      finish(j, k, outFile, editedDur);
    }, job);
  }
  console.log(`Export ${s.id}: ${list.length} file(s), ${all.lanes.length} tracks, ${twoStage ? 'two-stage' : 'single-stage'}, ${W} parallel, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  s.exports = [...results, ...(s.exports || [])].slice(0, 30);
  store.saveSession(s);
  job.state = 'done'; job.progress = 1; job.step = 'Fertig'; job.results = results; job.endedAt = Date.now();
}

async function runExport(s, opts) {
  const job = { state: 'running', progress: 0, step: 'Vorbereiten …', error: null, startedAt: Date.now() };
  jobs.set(s.id, job);
  const dir = store.sessionDir(s.id);
  const useExt = exportDirUsable();
  const folder = useExt ? exportFolderName(s) : null;
  const outDir = useExt ? path.join(exportDir(), folder) : path.join(dir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  if (useExt) openUp(outDir, true);
  else console.warn(`Export folder ${exportDir()} not writable – saving inside the project folder`);
  try {
    if (s.edl?.version === 2) return await runExportV2(s, opts, job, { useExt, folder, outDir, dir });
    const edl = s.edl || { cuts: [], tracks: {} };
    const tracks = [];
    for (const t of s.tracks) {
      const e = edl.tracks?.[t.id] || {};
      if (e.mute) continue;
      const file = store.trackFile(s, t);
      if (!fs.existsSync(file) || fs.statSync(file).size === 0) continue;
      const dur = await audio.probeDuration(file);
      if (t.duration == null || Math.abs((t.duration || 0) - dur) > 0.05) { t.duration = dur; }
      const offset = t.kind === 'extra' ? (+e.offset || 0) : (t.offset || 0) + (+e.nudgeMs || 0) / 1000;
      tracks.push({ t, file, offset, dur, gainDb: +e.gainDb || 0, mutes: e.mutes || [], fx: opts.bypassFx || e.fxOff ? null : e.fx, env: e.env || [] });
    }
    if (!tracks.length) throw new Error('Keine Spuren mit Audio vorhanden.');
    const totalDur = Math.max(...tracks.map(x => x.offset + x.dur));
    const base = {
      cuts: edl.cuts || [], totalDur,
      fadeIn: Math.max(0, +opts.fadeIn || 0), fadeOut: Math.max(0, +opts.fadeOut || 0),
      loudnorm: opts.loudnorm ? Math.max(-30, Math.min(-10, +opts.loudnorm)) : 0,
      channels: opts.channels === 2 ? 2 : 1,
      bitrate: [64, 96, 128, 160, 192, 256, 320].includes(+opts.bitrate) ? +opts.bitrate : 128,
      title: s.name,
      limiter: opts.bypassFx ? null : (edl.master?.limiter || { on: true, ceiling: -1, release: 50 }),
    };
    const slug = safeName(s.name).slice(0, 30) + '-' + new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const jobsList = [{ kind: 'mix', name: `${slug}-mix.mp3`, inputs: tracks }];
    if (opts.singleTracks) {
      for (const x of tracks) {
        jobsList.push({ kind: 'track', name: `${slug}-${safeName(x.t.name)}.mp3`, inputs: [x], loudnorm: opts.loudnormTracks ? base.loudnorm : 0 });
      }
    }
    const results = [];
    for (let i = 0; i < jobsList.length; i++) {
      const j = jobsList[i];
      job.step = j.kind === 'mix' ? 'Gesamtmix wird erstellt' : `Einzelspur: ${j.inputs[0].t.name}`;
      const outFile = path.join(outDir, j.name);
      const opt = { ...base, loudnorm: j.kind === 'mix' ? base.loudnorm : j.loudnorm };
      if (j.kind === 'track') opt.fadeIn = opt.fadeOut = 0;
      const dur = await audio.renderFile({
        files: j.inputs.map(x => x.file),
        inputs: j.inputs.map(x => ({ offset: x.offset, gainDb: x.gainDb, mutes: x.mutes, fx: x.fx, env: x.env })),
        opts: opt, outFile, workDir: dir,
        onProgress: p => { job.progress = (i + p) / jobsList.length; },
      });
      if (useExt) openUp(outFile, false);
      results.push({ kind: j.kind, name: j.name, size: fs.statSync(outFile).size, duration: dur, createdAt: Date.now(),
        dir: useExt ? 'ext' : 'out', folder, hostPath: useExt ? path.join(exportDir(), folder, j.name) : null, path: path.join(outDir, j.name) });
    }
    s.exports = [...results, ...(s.exports || [])].slice(0, 30);
    store.saveSession(s);
    job.state = 'done'; job.progress = 1; job.step = 'Fertig'; job.results = results;
  } catch (e) {
    if (job.cancelled) {
      // Halbfertige und bereits fertige Dateien dieses Laufs entfernen
      for (const f of job.outFiles || []) fs.rmSync(f, { force: true });
      job.state = 'cancelled'; job.step = 'Abgebrochen'; job.error = null;
      console.log(`Export ${s.id} cancelled`);
      return;
    }
    console.error('Export error', e);
    job.state = 'error'; job.error = e.message;
  } finally { delete job.procs; }
}

// ---------- Einstellungen & Ordnerauswahl ----------
// Freigegebene Wurzeln für die Ordnerauswahl (im Container). ZimaOS/CasaOS: /DATA und /media sind 1:1 eingebunden.
function browseRoots() {
  // Der eigene Datenordner ist immer dabei, damit die Standard-Ordner gültig bleiben
  const list = [...(process.env.BROWSE_ROOTS || '/DATA,/media,/mnt,/srv').split(','), DATA_DIR].map(x => x.trim()).filter(Boolean);
  const out = [];
  for (const r of list) {
    try {
      if (!fs.statSync(r).isDirectory()) continue;
      if (out.some(o => Store.sameDir(o.path, r))) continue;
      out.push({ path: r, label: r === DATA_DIR ? `${r} (app data)` : r });
    } catch { /* nicht vorhanden */ }
  }
  return out;
}
function insideRoots(p) {
  if (!p || typeof p !== 'string' || !p.startsWith('/')) return null;
  let real;
  try { real = fs.realpathSync(path.resolve(p)); } catch { return null; }
  for (const r of browseRoots()) {
    let rr; try { rr = fs.realpathSync(r.path); } catch { continue; }
    if (real === rr || real.startsWith(rr + '/')) return path.resolve(p);
  }
  return null;
}
function settingsView() {
  const st = d => { const u = Store.usableDir(d); return { path: d, ok: u.ok, why: u.ok ? '' : u.why }; };
  return {
    language: settings.get('language', ''),
    passwordFromEnv: !!APP_PASSWORD, hasPassword: passwordActive(),
    recordingsDir: st(recordingsDir()), exportDir: st(exportDir()), libraryDir: st(LIB_REMOTE || LIB_LOCAL),
    roots: browseRoots(), version: APP_VERSION,
  };
}
// Gemeinsam für Ersteinrichtung und Einstellungen; liefert eine Fehlermeldung oder ''
async function applySettings(b, { setup }) {
  const patch = {};
  if (b.language !== undefined) patch.language = ['de', 'en', ''].includes(b.language) || /^[a-z]{2}$/.test(b.language) ? b.language : '';
  for (const key of ['recordingsDir', 'exportDir', 'libraryDir']) {
    if (b[key] === undefined || b[key] === null || b[key] === '') continue;
    const dir = insideRoots(String(b[key]));
    if (!dir) return `Ordner nicht freigegeben: ${b[key]}`;
    const u = Store.usableDir(dir);
    if (!u.ok) return `Ordner nicht beschreibbar (${u.why}): ${dir}`;
    patch[key] = dir;
  }
  if (!APP_PASSWORD && (setup || b.newPassword !== undefined || b.noPassword)) {
    if (!setup && settings.hasPassword() && !settings.checkPassword(b.currentPassword)) return 'Das aktuelle Passwort ist falsch.';
    if (b.noPassword) settings.setPassword('');
    else {
      const pw = String(b.newPassword ?? b.password ?? '');
      if (pw.length < 6) return 'Das Passwort muss mindestens 6 Zeichen lang sein.';
      settings.setPassword(pw);
    }
  }
  const before = { rec: recordingsDir(), lib: LIB_REMOTE || LIB_LOCAL };
  if (patch.recordingsDir && patch.recordingsDir !== before.rec) {
    patch.recordingsHistory = [...new Set([...settings.get('recordingsHistory', []), before.rec])];
  }
  settings.set(patch);
  if (patch.recordingsDir && patch.recordingsDir !== before.rec) store.setRecordingsDir(patch.recordingsDir);
  if (patch.libraryDir && patch.libraryDir !== before.lib) setLibraryDir(patch.libraryDir);
  return '';
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname.split('/').filter(Boolean).slice(1); // ohne "api"
  const m = req.method;

  if (p[0] === 'config' && m === 'GET') {
    return send(res, 200, { version: APP_VERSION, iceServers: iceServers(), authRequired: passwordActive(), admin: isAdmin(req), maxPeers: MAX_PEERS,
      setupRequired: setupRequired(), language: settings.get('language', ''),
      ...(setupRequired() ? { defaults: { recordingsDir: recordingsDir(), exportDir: exportDir(), libraryDir: LIB_REMOTE || LIB_LOCAL } } : {}),
      exportDir: isAdmin(req) && exportDirUsable() ? exportDir() : null,
      exportDirError: isAdmin(req) ? exportDirError : '' });
  }
  if (p[0] === 'login' && m === 'POST') {
    const body = await readJson(req);
    if (passwordActive() && !checkPassword(body.password)) {
      await new Promise(r => setTimeout(r, 800));
      return send(res, 401, { error: 'Falsches Passwort' });
    }
    return send(res, 200, { ok: true }, { 'Set-Cookie': authCookie(req) });
  }
  // Ersteinrichtung: nur solange noch kein Passwort festgelegt ist
  if (p[0] === 'setup' && m === 'POST') {
    if (!setupRequired()) return send(res, 409, { error: 'Die Einrichtung ist bereits abgeschlossen.' });
    const b = await readJson(req);
    const err = await applySettings(b, { setup: true });
    if (err) return send(res, 400, { error: err });
    return send(res, 200, { ok: true }, { 'Set-Cookie': authCookie(req) });
  }
  // Ordnerauswahl (Einstellungen / Ersteinrichtung)
  if (p[0] === 'fs' && (isAdmin(req) || setupRequired())) {
    if (m === 'GET') {
      const q = url.searchParams.get('path') || '';
      if (!q) return send(res, 200, { path: '', parent: null, dirs: browseRoots().map(d => ({ name: d.label, path: d.path })) });
      const dir = insideRoots(q);
      if (!dir) return send(res, 403, { error: 'Dieser Ordner ist nicht freigegeben.' });
      let dirs = [];
      try {
        dirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({ name: e.name, path: path.join(dir, e.name) })).sort((x, y) => x.name.localeCompare(y.name, 'de'));
      } catch (e) { return send(res, 400, { error: `Ordner kann nicht gelesen werden (${e.code || e.message})` }); }
      const root = browseRoots().find(r => dir === r.path || dir.startsWith(r.path + '/'));
      const usable = Store.usableDir(dir);
      return send(res, 200, { path: dir, parent: dir === root.path ? '' : path.dirname(dir), dirs, writable: usable.ok, why: usable.ok ? '' : usable.why });
    }
    if (p[1] === 'mkdir' && m === 'POST') {
      const b = await readJson(req);
      const parent = insideRoots(String(b.path || ''));
      const name = String(b.name || '').trim();
      if (!parent || !name || /[\/\\]|^\.\.?$/.test(name)) return send(res, 400, { error: 'Ungültiger Ordnername' });
      try { fs.mkdirSync(path.join(parent, name)); openUp(path.join(parent, name), true); } catch (e) { return send(res, 400, { error: `Ordner konnte nicht angelegt werden (${e.code || e.message})` }); }
      return send(res, 200, { path: path.join(parent, name) });
    }
  }
  if (p[0] === 'settings' && isAdmin(req)) {
    if (m === 'GET') return send(res, 200, settingsView());
    if (m === 'PATCH') {
      const err = await applySettings(await readJson(req), { setup: false });
      if (err) return send(res, 400, { error: err });
      return send(res, 200, settingsView(), passwordActive() ? { 'Set-Cookie': authCookie(req) } : {});
    }
  }
  if (p[0] === 'time') return send(res, 200, { ts: Date.now() });

  // Öffentliche Raum-Infos (für Gäste mit Link)
  if (p[0] === 'rooms' && p[1] && p[2] === 'public' && m === 'GET') {
    const r = store.getRoom(p[1]);
    if (!r) return send(res, 404, { error: 'Raum nicht gefunden' });
    const live = rooms.get(r.id);
    return send(res, 200, { id: r.id, name: r.name, peers: live ? live.clients.size : 0 });
  }

  // ---- Dateien im Chat (Gast-fähig: wer den Raumlink hat, darf teilen und herunterladen) ----
  if (p[0] === 'rooms' && p[1] && p[2] === 'files') {
    const r = store.getRoom(p[1]);
    if (!r) return send(res, 404, { error: 'Raum nicht gefunden' });
    const dir = path.join(DATA_DIR, 'chatfiles', r.id);
    const metaFile = id => path.join(dir, id + '.json');
    const readMeta = id => { try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return null; } };
    const fid = p[3] ? String(p[3]).replace(/[^\w-]/g, '') : '';

    if (!fid && m === 'POST') { // Upload anmelden
      const b = await readJson(req);
      const size = Math.max(0, Math.floor(+b.size || 0));
      if (size > CHAT_FILE_MAX_MB * 1024 * 1024) return send(res, 413, { error: `Datei zu groß (max. ${CHAT_FILE_MAX_MB} MB)` });
      fs.mkdirSync(dir, { recursive: true });
      const meta = {
        id: Store.id(9), name: path.basename(String(b.name || 'datei')).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 160) || 'datei',
        type: String(b.type || 'application/octet-stream').slice(0, 100), size, received: 0,
        from: String(b.from || '').slice(0, 40), by: String(b.by || '').slice(0, 60), createdAt: Date.now(), done: false,
      };
      fs.writeFileSync(path.join(dir, meta.id), Buffer.alloc(0));
      fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
      return send(res, 200, { id: meta.id, chunk: 8 * 1024 * 1024 });
    }
    const meta = fid && readMeta(fid);
    if (!meta) return send(res, 404, { error: 'Datei nicht gefunden' });
    const file = path.join(dir, meta.id);

    if (p[4] === 'chunk' && m === 'PUT') {
      const offset = parseInt(url.searchParams.get('offset'), 10);
      if (meta.done) return send(res, 409, { error: 'Bereits abgeschlossen' });
      if (offset !== meta.received) return send(res, 200, { received: meta.received });
      const data = await readBody(req, 9 * 1024 * 1024);
      if (meta.received + data.length > meta.size) return send(res, 400, { error: 'Mehr Daten als angekündigt' });
      if (fs.statSync(file).size !== meta.received) fs.truncateSync(file, meta.received);
      fs.appendFileSync(file, data);
      meta.received += data.length;
      fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
      return send(res, 200, { received: meta.received });
    }
    if (p[4] === 'complete' && m === 'POST') {
      if (meta.received !== meta.size) return send(res, 400, { error: 'Upload unvollständig' });
      meta.done = true;
      fs.writeFileSync(metaFile(meta.id), JSON.stringify(meta));
      const live = rooms.get(r.id);
      const msg = { type: 'chat', kind: 'file', from: meta.from, name: meta.by, ts: Date.now(),
        file: { id: meta.id, name: meta.name, size: meta.size, type: meta.type, url: `/api/rooms/${r.id}/files/${meta.id}` } };
      if (live) { pushHistory(live, msg); broadcast(live, msg); }
      return send(res, 200, { ok: true });
    }
    if (!p[4] && (m === 'GET' || m === 'HEAD')) {
      if (!meta.done) return send(res, 409, { error: 'Upload läuft noch' });
      const inline = url.searchParams.has('inline') && /^(image|audio|video)\//.test(meta.type) && !/svg/.test(meta.type);
      return sendFile(req, res, file, {
        'Content-Type': inline ? meta.type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
        'X-Content-Type-Options': 'nosniff',
      });
    }
  }

  // ---- Upload durch Teilnehmer (Gast-fähig) ----
  if (p[0] === 'sessions' && p[1] && p[2] === 'tracks') {
    const s = store.getSession(p[1]);
    if (!s) return send(res, 404, { error: 'Session nicht gefunden' });
    if (!canWriteSession(req, s)) return send(res, 403, { error: 'Kein Zugriff' });

    if (!p[3] && m === 'POST') { // Spur anmelden
      const b = await readJson(req);
      const id = String(b.trackId || '').replace(/[^\w-]/g, '').slice(0, 40);
      if (!id) return send(res, 400, { error: 'trackId fehlt' });
      let t = s.tracks.find(x => x.id === id);
      if (!t) {
        t = {
          id, kind: 'rec', name: String(b.name || 'Teilnehmer').slice(0, 60), clientId: String(b.clientId || '').slice(0, 40),
          file: `${id}.mp3`, startServerTime: +b.startServerTime || Date.now(),
          sampleRate: +b.sampleRate || 48000, bitrate: +b.bitrate || 192, bytes: 0, nextSeq: 0, ended: false, duration: null,
        };
        t.offset = (t.startServerTime - s.startAt) / 1000;
        s.tracks.push(t);
        fs.writeFileSync(store.trackFile(s, t), Buffer.alloc(0));
        store.saveSession(s);
      }
      return send(res, 200, { next: t.nextSeq });
    }
    const t = s.tracks.find(x => x.id === p[3]);
    if (!t) return send(res, 404, { error: 'Spur nicht gefunden' });

    if (p[4] === 'chunk' && m === 'POST') {
      const seq = parseInt(url.searchParams.get('seq'), 10);
      const data = await readBody(req);
      if (seq !== t.nextSeq) return send(res, 200, { next: t.nextSeq });
      const file = store.trackFile(s, t);
      // Falls ein früherer Schreibvorgang abgebrochen ist: auf letzten bestätigten Stand kürzen
      try { if (fs.statSync(file).size !== t.bytes) fs.truncateSync(file, t.bytes); } catch { fs.writeFileSync(file, Buffer.alloc(0)); t.bytes = 0; }
      fs.appendFileSync(file, data);
      t.bytes += data.length;
      t.nextSeq++;
      store.saveSession(s);
      return send(res, 200, { next: t.nextSeq });
    }
    if (p[4] === 'status' && m === 'GET') return send(res, 200, { next: t.nextSeq, ended: t.ended });
    if (p[4] === 'end' && m === 'POST') {
      const b = await readJson(req);
      t.ended = true;
      t.totalChunks = +b.totalChunks || t.nextSeq;
      t.duration = +b.duration || null;
      store.saveSession(s);
      return send(res, 200, { ok: true, complete: t.nextSeq >= t.totalChunks });
    }
  }

  // ---- Ab hier nur Admin ----
  if (!isAdmin(req)) return send(res, 401, { error: 'Anmeldung erforderlich' });

  // ---- Mediapool: Intros, Outros, Jingles, Soundeffekte – in allen Projekten verfügbar ----
  if (p[0] === 'library') {
    if (!p[1] && m === 'GET') return send(res, 200, libList());
    if (!p[1] && m === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'audio.mp3');
      const data = await readBody(req, 300 * 1024 * 1024);
      try { return send(res, 200, await libAdd(data, name, decodeURIComponent(req.headers['x-category'] || ''))); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (p[1] === 'fromsession' && m === 'POST') {
      const b = await readJson(req);
      const s = store.getSession(String(b.sid || ''));
      const t = s?.tracks.find(x => x.id === b.trackId);
      if (!t) return send(res, 404, { error: 'Audiodatei nicht gefunden' });
      const file = store.trackFile(s, t);
      try { return send(res, 200, await libAdd(fs.readFileSync(file), (b.name || t.name) + path.extname(t.file), b.category)); }
      catch (e) { return send(res, 400, { error: e.message }); }
    }
    const item = p[1] && libLoad().find(x => x.id === p[1]);
    if (p[1] && !item) return send(res, 404, { error: 'Nicht im Mediapool' });
    if (item && !p[2] && m === 'PATCH') {
      const b = await readJson(req);
      const list = libLoad();
      const it = list.find(x => x.id === item.id);
      if (typeof b.name === 'string' && b.name.trim()) it.name = b.name.trim().slice(0, 80);
      if (typeof b.category === 'string') it.category = libCat(b.category);
      libSave(list);
      return send(res, 200, it);
    }
    if (item && !p[2] && m === 'DELETE') {
      libSave(libLoad().filter(x => x.id !== item.id));
      fs.rmSync(path.join(libDir(), item.file), { force: true });
      fs.rmSync(path.join(libDir(), item.file + '.peaks'), { force: true });
      return send(res, 200, { ok: true });
    }
    if (item && p[2] === 'audio') return sendFile(req, res, path.join(libDir(), item.file), { 'Cache-Control': 'private, max-age=31536000, immutable' });
  }

  if (p[0] === 'presets') {
    if (!p[1] && m === 'GET') return send(res, 200, store.listPresets());
    if (!p[1] && m === 'POST') return send(res, 200, store.savePreset(await readJson(req)));
    if (p[1] && m === 'DELETE') { store.deletePreset(p[1]); return send(res, 200, { ok: true }); }
  }

  if (p[0] === 'rooms') {
    if (!p[1] && m === 'GET') {
      return send(res, 200, store.listRooms().map(r => ({ ...r, peers: rooms.get(r.id)?.clients.size || 0 })));
    }
    if (!p[1] && m === 'POST') { const b = await readJson(req); return send(res, 200, store.createRoom(b.name)); }
    if (p[1] && m === 'PATCH') { const b = await readJson(req); return send(res, 200, store.renameRoom(p[1], b.name) || {}); }
    if (p[1] && m === 'DELETE') {
      store.deleteRoom(p[1]);
      fs.rmSync(path.join(DATA_DIR, 'chatfiles', String(p[1]).replace(/[^\w-]/g, '')), { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
  }

  if (p[0] === 'sessions') {
    if (!p[1] && m === 'GET') return send(res, 200, store.listSessions().map(publicSession));
    const s = store.getSession(p[1]);
    if (!s) return send(res, 404, { error: 'Session nicht gefunden' });

    if (!p[2] && m === 'GET') return send(res, 200, publicSession(s));
    if (!p[2] && m === 'PATCH') {
      const b = await readJson(req);
      const by = String(b.clientId || '').slice(0, 40);
      // Schutz vor Überschreiben: Bearbeitungen tragen die Revision mit, auf der sie beruhen.
      // Hat inzwischen ein anderes Gerät gespeichert, gibt es 409 statt stillem Überschreiben.
      if (b.edl && b.baseRev != null && !b.force && +b.baseRev !== (s.rev || 0)) {
        return send(res, 409, { error: 'conflict', rev: s.rev || 0, revBy: s.revBy || '', edl: s.edl, name: s.name });
      }
      if (typeof b.name === 'string') s.name = b.name.slice(0, 120);
      if (b.edl && typeof b.edl === 'object') {
        s.edl = { cuts: Array.isArray(b.edl.cuts) ? b.edl.cuts : [], tracks: b.edl.tracks || {}, markers: b.edl.markers || [], master: b.edl.master || {} };
        if (b.edl.version === 2) Object.assign(s.edl, {
          version: 2, laneOrder: Array.isArray(b.edl.laneOrder) ? b.edl.laneOrder : [], clips: Array.isArray(b.edl.clips) ? b.edl.clips : [],
          groups: b.edl.groups || {}, knownSources: Array.isArray(b.edl.knownSources) ? b.edl.knownSources : [],
        });
      }
      if (b.edl || typeof b.name === 'string') { s.rev = (s.rev || 0) + 1; s.revBy = by; s.revAt = Date.now(); }
      store.saveSession(s);
      return send(res, 200, { ok: true, updatedAt: s.updatedAt, rev: s.rev || 0 });
    }
    // Kleine Abfrage für den Abgleich zwischen Geräten
    if (p[2] === 'rev' && m === 'GET') return send(res, 200, { rev: s.rev || 0, revBy: s.revBy || '', revAt: s.revAt || 0, notesAt: s.notesAt || 0, notesBy: s.notesBy || '' });
    // Notizblock im Editor (eigenes Feld, damit Tippen keine Bearbeitungs-Konflikte auslöst)
    if (p[2] === 'notes' && (m === 'PUT' || m === 'POST')) {
      const b = await readJson(req);
      s.notes = String(b.notes || '').slice(0, 200000);
      s.notesAt = Date.now(); s.notesBy = String(b.clientId || '').slice(0, 40);
      store.saveSession(s);
      return send(res, 200, { ok: true, notesAt: s.notesAt });
    }
    // Abspielposition & Ansicht (Zoom, Scroll) – gemeinsam für alle Geräte, ohne Revision
    if (p[2] === 'view' && (m === 'POST' || m === 'PATCH')) {
      const b = await readJson(req);
      s.view = { playhead: Math.max(0, +b.playhead || 0), pps: Math.max(0.1, Math.min(1000, +b.pps || 40)), scrollLeft: Math.max(0, +b.scrollLeft || 0), at: Date.now() };
      store.saveSession(s);
      return send(res, 200, { ok: true });
    }
    if (!p[2] && m === 'DELETE') { store.deleteSession(s.id); return send(res, 200, { ok: true }); }

    if (p[2] === 'tracks' && p[3]) {
      const t = s.tracks.find(x => x.id === p[3]);
      if (!t) return send(res, 404, { error: 'Spur nicht gefunden' });
      const file = store.trackFile(s, t);
      // Spur duplizieren: eigene Kopie der Datei (Löschen der einen Spur betrifft die andere nicht),
      // Einstellungen (Effekte, Hüllkurve, Lautstärke …) werden mitkopiert
      if (p[4] === 'duplicate' && m === 'POST') {
        const id = 'x' + Store.id(6);
        const copy = { ...t, id, kind: 'extra', name: (t.name + ' (Kopie)').slice(0, 60), file: id + path.extname(t.file) };
        fs.copyFileSync(file, store.trackFile(s, copy));
        try { fs.copyFileSync(file + '.peaks', store.trackFile(s, copy) + '.peaks'); } catch { /* wird neu berechnet */ }
        s.tracks.splice(s.tracks.indexOf(t) + 1, 0, copy);
        s.edl = s.edl || { cuts: [], tracks: {} };
        const src = JSON.parse(JSON.stringify(s.edl.tracks?.[t.id] || {}));
        if (t.kind !== 'extra') { src.offset = (t.offset || 0) + (+src.nudgeMs || 0) / 1000; delete src.nudgeMs; }
        s.edl.tracks[id] = src;
        s.rev = (s.rev || 0) + 1; s.revBy = String(url.searchParams.get('clientId') || ''); s.revAt = Date.now();
        store.saveSession(s);
        return send(res, 200, copy);
      }
      if (p[4] === 'audio') {
        const dl = url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${safeName(t.name)}${path.extname(t.file)}"` } : {};
        return sendFile(req, res, file, dl);
      }
      if (p[4] === 'peaks') {
        try {
          const peaks = await audio.computePeaks(file, file + '.peaks');
          return send(res, 200, peaks, { 'Content-Type': 'application/octet-stream', 'X-Peaks-Per-Sec': String(audio.PEAKS_PER_SEC) });
        } catch (e) { return send(res, 500, { error: e.message }); }
      }
      if (!p[4] && m === 'DELETE') {
        s.tracks = s.tracks.filter(x => x !== t);
        s.rev = (s.rev || 0) + 1; s.revBy = String(url.searchParams.get('clientId') || ''); s.revAt = Date.now();
        if (s.edl?.tracks) delete s.edl.tracks[t.id];
        fs.rmSync(file, { force: true }); fs.rmSync(file + '.peaks', { force: true });
        store.saveSession(s);
        return send(res, 200, { ok: true });
      }
      if (!p[4] && m === 'PATCH') {
        const b = await readJson(req);
        if (typeof b.name === 'string') t.name = b.name.slice(0, 60);
        s.rev = (s.rev || 0) + 1; s.revBy = String(b.clientId || ''); s.revAt = Date.now();
        store.saveSession(s);
        return send(res, 200, { ok: true, rev: s.rev });
      }
    }

    // Datei aus dem Mediapool ins Projekt kopieren
    if (p[2] === 'fromlibrary' && m === 'POST') {
      const b = await readJson(req);
      const item = libLoad().find(x => x.id === b.id);
      if (!item) return send(res, 404, { error: 'Nicht im Mediapool' });
      const id = 'x' + Store.id(6);
      const t = { id, kind: 'extra', name: item.name.slice(0, 60), file: id + path.extname(item.file), offset: 0, bytes: item.bytes, ended: true, duration: item.duration, lib: item.id };
      const src = path.join(libDir(), item.file);
      fs.copyFileSync(src, store.trackFile(s, t));
      try { fs.copyFileSync(src + '.peaks', store.trackFile(s, t) + '.peaks'); } catch { /* wird bei Bedarf berechnet */ }
      s.tracks.push(t);
      s.rev = (s.rev || 0) + 1; s.revBy = String(b.clientId || ''); s.revAt = Date.now();
      store.saveSession(s);
      return send(res, 200, t);
    }

    // Zusätzliche Audiodatei (Intro, Outro, Jingle …) hochladen
    if (p[2] === 'extra' && m === 'POST') {
      const name = decodeURIComponent(req.headers['x-filename'] || 'audio.mp3');
      let ext = path.extname(name).toLowerCase();
      if (!['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.webm'].includes(ext)) ext = '.mp3';
      const data = await readBody(req, 300 * 1024 * 1024);
      const id = 'x' + Store.id(6);
      const t = { id, kind: 'extra', name: path.basename(name, path.extname(name)).slice(0, 60), file: id + ext, offset: 0, bytes: data.length, ended: true, duration: null };
      fs.writeFileSync(store.trackFile(s, t), data);
      try { t.duration = await audio.probeDuration(store.trackFile(s, t)); } catch (e) {
        fs.rmSync(store.trackFile(s, t), { force: true });
        return send(res, 400, { error: 'Datei konnte nicht gelesen werden: ' + e.message });
      }
      s.tracks.push(t);
      s.edl = s.edl || { cuts: [], tracks: {} };
      if (s.edl.version !== 2) s.edl.tracks[id] = { offset: 0, gainDb: -6 };
      s.rev = (s.rev || 0) + 1; s.revBy = String(req.headers['x-client'] || ''); s.revAt = Date.now();
      store.saveSession(s);
      return send(res, 200, t);
    }

    if (p[2] === 'duration' && m === 'POST') {
      // Dauer aller Spuren neu messen (z. B. nach Upload-Ende)
      for (const t of s.tracks) {
        try { t.duration = await audio.probeDuration(store.trackFile(s, t)); } catch { /* leer */ }
      }
      store.saveSession(s);
      return send(res, 200, publicSession(s));
    }

    // Spuren messen (für „Normalisieren“ im Editor) – läuft im Hintergrund, Fortschritt per Abfrage
    if (p[2] === 'analyze') {
      const key = s.id + ':analyze';
      if (m === 'GET') return send(res, 200, jobs.get(key) || { state: 'idle' });
      if (m === 'POST') {
        if (jobs.get(key)?.state === 'running') return send(res, 409, { error: 'Messung läuft bereits' });
        const b = await readJson(req);
        const ids = Array.isArray(b.trackIds) ? b.trackIds.map(String) : [];
        const job = { state: 'running', progress: 0, step: 'Vorbereiten …', results: {}, error: null };
        jobs.set(key, job);
        (async () => {
          try {
            if (s.edl?.version === 2) {
              const prog = new Array(ids.length).fill(0);
              job.step = ids.length > 1 ? `Messe ${ids.length} Spuren (${Math.min(audio.EXPORT_WORKERS, ids.length)} parallel)` : 'Messe Spur';
              // Gleicher schneller Weg wie beim Export: dekodieren → Clips/Effekte/Hüllkurve → messen (ohne Spurlautstärke)
              await audio.pool(ids, audio.EXPORT_WORKERS, async (id, i) => {
                const one = lanesV2(s, { laneIds: [id], includeMuted: true });
                if (!one.lanes.length) { job.results[id] = { lufs: null, peak: null }; return; }
                const dir = path.join(TMP_DIR, `analyze-${s.id}-${id}-${Date.now()}`);
                fs.mkdirSync(dir, { recursive: true });
                const pr = x => { prog[i] = x; job.progress = prog.reduce((a, b) => a + b, 0) / ids.length; };
                try {
                  const srcRaw = one.files.map((_, k) => ({ path: path.join(dir, `src${k}.f32`) }));
                  for (let k = 0; k < one.files.length; k++) await audio.decodeSourceRaw({ file: one.files[k], channels: 1, outFile: srcRaw[k].path });
                  pr(0.25);
                  const out = path.join(dir, 'lane.f32');
                  await runWorker('lane', { lane: { ...one.lanes[0], gainDb: 0 }, srcPaths: srcRaw.map(r => r.path), totalDur: one.totalDur, channels: 1, outFile: out }, null, x => pr(0.25 + 0.6 * x));
                  job.results[id] = await audio.measureRaw({ file: out, channels: 1 });
                  pr(1);
                } finally { fs.rmSync(dir, { recursive: true, force: true }); }
              });
              job.state = 'done'; job.progress = 1; job.step = 'Fertig';
              return;
            }
            const edl = s.edl || { cuts: [], tracks: {} };
            const list = s.tracks.filter(t => ids.includes(t.id));
            const files = [];
            for (const t of s.tracks) {
              const file = store.trackFile(s, t);
              if (!fs.existsSync(file) || !fs.statSync(file).size) continue;
              const e = edl.tracks?.[t.id] || {};
              const dur = await audio.probeDuration(file);
              const offset = t.kind === 'extra' ? (+e.offset || 0) : (t.offset || 0) + (+e.nudgeMs || 0) / 1000;
              files.push({ t, file, e, dur, offset });
            }
            const totalDur = Math.max(1, ...files.map(x => x.offset + x.dur));
            const todo = files.filter(x => list.includes(x.t));
            for (let i = 0; i < todo.length; i++) {
              const x = todo[i];
              job.step = `Messe „${x.t.name}“ (${i + 1}/${todo.length})`;
              const r = await audio.analyzeTrack({
                file: x.file, totalDur, workDir: TMP_DIR,
                input: { offset: x.offset, mutes: x.e.mutes || [], fx: x.e.fxOff ? null : x.e.fx, env: x.e.env || [] },
                cuts: edl.cuts || [],
                onProgress: pr => { job.progress = (i + pr) / todo.length; },
              });
              job.results[x.t.id] = r;
            }
            job.state = 'done'; job.progress = 1; job.step = 'Fertig';
          } catch (e) { console.error('Messung', e); job.state = 'error'; job.error = e.message; }
        })();
        return send(res, 200, { ok: true });
      }
    }

    if (p[2] === 'export') {
      if (m === 'POST') {
        if (jobs.get(s.id)?.state === 'running') return send(res, 409, { error: 'Export läuft bereits' });
        const opts = await readJson(req);
        runExport(s, opts);
        return send(res, 200, { ok: true });
      }
      if (m === 'GET') {
        const j = jobs.get(s.id);
        if (!j) return send(res, 200, { state: 'idle' });
        return send(res, 200, { ...j, procs: undefined, outFiles: undefined, workers: undefined, elapsed: (j.endedAt || Date.now()) - j.startedAt });
      }
      if (m === 'DELETE') {
        const j = jobs.get(s.id);
        if (!j || j.state !== 'running') return send(res, 200, { ok: true, state: j?.state || 'idle' });
        j.cancelled = true; j.step = 'Wird abgebrochen …';
        for (const pr of j.procs || []) { try { pr.kill('SIGTERM'); } catch { /* schon beendet */ } }
        for (const c of j.workers || []) c();
        return send(res, 200, { ok: true });
      }
    }
    if (p[2] === 'files' && p[3]) {
      const name = path.basename(decodeURIComponent(p[3]));
      const entry = (s.exports || []).find(x => x.name === name) || { name };
      const file = exportFilePath(s, entry);
      if (m === 'DELETE') {
        fs.rmSync(file, { force: true });
        s.exports = (s.exports || []).filter(x => x.name !== name);
        store.saveSession(s);
        return send(res, 200, { ok: true });
      }
      return sendFile(req, res, file, { 'Content-Disposition': `attachment; filename="${name}"` });
    }
  }
  return send(res, 404, { error: 'Unbekannter Endpunkt' });
}

// ---------- HTTP-Server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/' ) return serveStatic(req, res, '/index.html');
    if (/^\/r\/[\w-]+\/?$/.test(url.pathname)) return serveStatic(req, res, '/room.html');
    if (/^\/edit\/[\w-]+\/?$/.test(url.pathname)) return serveStatic(req, res, '/editor.html');
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.end();
  }
});

// ---------- WebSocket: Signalisierung, Uhr-Abgleich, Aufnahmesteuerung ----------
const rooms = new Map(); // roomId -> {clients: Map, recording}
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

function pushHistory(room, msg) {
  room.history = room.history || [];
  room.history.push(msg);
  if (room.history.length > 300) room.history.splice(0, room.history.length - 300);
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, c] of room.clients) if (id !== exceptId && c.ws.readyState === 1) c.ws.send(data);
}

function stopRecording(roomId, room, by) {
  if (!room.recording) return;
  const s = store.getSession(room.recording.sessionId);
  if (s) { s.stoppedAt = Date.now(); store.saveSession(s); }
  broadcast(room, { type: 'rec-stop', sessionId: room.recording.sessionId, by });
  room.recording = null;
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const r = store.getRoom(url.searchParams.get('room'));
  if (!r) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => onConnection(ws, r, url));
});

function onConnection(ws, r, url) {
  const clientId = (url.searchParams.get('clientId') || Store.id(6)).replace(/[^\w-]/g, '').slice(0, 40);
  let name = String(url.searchParams.get('name') || 'Gast').slice(0, 60);
  let room = rooms.get(r.id);
  if (!room) { room = { clients: new Map(), recording: null, emptyTimer: null }; rooms.set(r.id, room); }
  clearTimeout(room.emptyTimer);

  const old = room.clients.get(clientId);
  if (old) { try { old.ws.close(4000, 'replaced'); } catch { /* egal */ } room.clients.delete(clientId); }
  if (room.clients.size >= MAX_PEERS) { ws.close(4001, 'Raum ist voll'); return; }

  const me = { ws, name, status: {}, alive: true };
  room.clients.set(clientId, me);
  ws.send(JSON.stringify({
    type: 'welcome', you: clientId, room: { id: r.id, name: r.name },
    peers: [...room.clients].filter(([id]) => id !== clientId).map(([id, c]) => ({ clientId: id, name: c.name, status: c.status })),
    recording: room.recording, serverTime: Date.now(), history: room.history || [],
  }));
  broadcast(room, { type: 'peer-joined', clientId, name }, clientId);

  ws.on('pong', () => { me.alive = true; });
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'ping': ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, ts: Date.now() })); break;
      case 'signal': {
        const target = room.clients.get(msg.to);
        if (target) target.ws.send(JSON.stringify({ type: 'signal', from: clientId, data: msg.data }));
        break;
      }
      case 'name':
        me.name = name = String(msg.name || name).slice(0, 60);
        broadcast(room, { type: 'peer-name', clientId, name }, clientId);
        break;
      case 'status':
        me.status = msg.status || {};
        broadcast(room, { type: 'peer-status', clientId, status: me.status }, clientId);
        break;
      case 'chat': {
        const text = String(msg.text || '').slice(0, 4000);
        if (!text.trim()) break;
        const out = { type: 'chat', from: clientId, name, text, ts: Date.now() };
        pushHistory(room, out);
        broadcast(room, out);
        break;
      }
      case 'rec-start': {
        if (room.recording) { ws.send(JSON.stringify({ type: 'rec-start', ...room.recording })); break; }
        const s = store.createSession(r);
        room.recording = { sessionId: s.id, startAt: s.startAt, by: name };
        broadcast(room, { type: 'rec-start', ...room.recording });
        break;
      }
      case 'rec-stop':
        if (room.recording) stopRecording(r.id, room, name);
        else if (msg.sessionId) ws.send(JSON.stringify({ type: 'rec-stop', sessionId: msg.sessionId, by: name }));
        break;
      case 'rec-resume': {
        // Nach Server-Neustart/Verbindungsabbruch: laufende Aufnahme wieder anmelden
        const s = store.getSession(String(msg.sessionId || ''));
        if (room.recording) {
          if (room.recording.sessionId !== msg.sessionId) ws.send(JSON.stringify({ type: 'rec-start', ...room.recording }));
        } else if (s && s.roomId === r.id && !s.stoppedAt) {
          room.recording = { sessionId: s.id, startAt: s.startAt, by: name };
          broadcast(room, { type: 'rec-start', ...room.recording });
        } else {
          ws.send(JSON.stringify({ type: 'rec-stop', sessionId: msg.sessionId, by: 'System' }));
        }
        break;
      }
      case 'marker': {
        if (!room.recording) break;
        const s = store.getSession(room.recording.sessionId);
        if (!s) break;
        const mk = { t: (Date.now() - s.startAt) / 1000, label: String(msg.label || 'Marker').slice(0, 80), by: name };
        s.markers.push(mk);
        store.saveSession(s);
        broadcast(room, { type: 'marker', ...mk });
        break;
      }
      default: break;
    }
  });
  ws.on('close', () => {
    if (room.clients.get(clientId)?.ws !== ws) return;
    room.clients.delete(clientId);
    broadcast(room, { type: 'peer-left', clientId });
    if (room.clients.size === 0) {
      // Leerer Raum: laufende Aufnahme nach 2 Minuten automatisch beenden
      room.emptyTimer = setTimeout(() => {
        if (room.clients.size === 0) stopRecording(r.id, room, 'System');
      }, 120000);
    }
  });
}

// Verbindungen am Leben halten (Proxies/Tunnel trennen sonst inaktive Sockets)
setInterval(() => {
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* egal */ }
    }
  }
}, 25000);

server.listen(PORT, () => {
  console.log(exportDirUsable() ? `Export folder: ${exportDir()}` : `WARNING – export folder not writable (${exportDirError}). Exports are saved inside the project folder.`);
  libCheckedAt = 0; if (!LIB_REMOTE) console.log(`Media pool: ${LIB_LOCAL}`); else libDir();
  console.log(store.recState.ok || !store.recDir ? `Recordings folder: ${recordingsDir()}` : `WARNING – recordings folder not reachable (${store.recState.why}): ${recordingsDir()}. New recordings go to the app data folder for now.`);
  console.log(`Export: up to ${audio.EXPORT_WORKERS} parallel jobs (${audio.EXPORT_CPU} % of ${audio.CPU_COUNT} threads)`);
  console.log(`Remote Booth ${APP_VERSION} listening on port ${PORT} (data: ${DATA_DIR})${setupRequired() ? ' – open the web interface to finish setup' : passwordActive() ? ' – password protection on' : ' – no password set'}`);
});
