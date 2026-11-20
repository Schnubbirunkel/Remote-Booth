// Dateibasierte Ablage: Räume und Aufnahme-Sessions als JSON im DATA_DIR.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Liegt ein Ordner unter /media wirklich auf dem eingebundenen Netzlaufwerk? (Nach einem Neustart ist die
// Freigabe evtl. noch nicht eingehängt – dann wäre der Ordner nur ein leerer Platzhalter auf der lokalen Platte.)
function onMountedShare(dir) {
  try {
    if (!dir.startsWith('/media/') || !fs.existsSync('/media')) return true;
    return fs.statSync(dir).dev !== fs.statSync('/media').dev;
  } catch { return false; }
}
// Ordner benutzbar? Fehlt er, wird er nur angelegt, wenn der übergeordnete Ordner schon auf der Freigabe liegt.
function usableDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent) || !onMountedShare(parent)) return { ok: false, why: 'Ordner nicht gefunden (Netzlaufwerk nicht eingebunden?)' };
      fs.mkdirSync(dir);
    }
    if (!onMountedShare(dir)) return { ok: false, why: 'Netzlaufwerk ist nicht eingebunden' };
    const probe = path.join(dir, `.schreibtest-${process.pid}`);
    fs.writeFileSync(probe, 'ok'); fs.rmSync(probe, { force: true });
    return { ok: true };
  } catch (e) { return { ok: false, why: e.code || e.message }; }
}

class Store {
  constructor(dataDir, { recordingsDir = '', recordingsLabel = '', extraDirs = [] } = {}) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, 'sessions'); // lokal (AppData) – Rückfall und alte Projekte
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.recDir = recordingsDir && !Store.sameDir(recordingsDir, this.sessionsDir) ? recordingsDir : '';
    this.recLabel = recordingsLabel || recordingsDir;
    this.recState = { ok: false, why: '' };
    this.dirs = new Map(); // Projekt-ID → Ordner
    this.roomsFile = path.join(dataDir, 'rooms.json');
    this.rooms = this._readJson(this.roomsFile, []);
    this.presetsFile = path.join(dataDir, 'presets.json');
    this.presets = this._readJson(this.presetsFile, []);
    this.sessions = new Map();
    this._scan(this.sessionsDir);
    // Frühere Aufnahmeordner weiter einlesen, damit ältere Projekte nach einem Ordnerwechsel sichtbar bleiben
    this.extraDirs = [...new Set(extraDirs)].filter(d => d && d !== this.recDir);
    this._scanExtra();
    this.checkRecordings();
  }

  _scanExtra() {
    for (const d of this.extraDirs) { try { if (fs.existsSync(d) && Store.onMountedShare(d)) this._scan(d); } catch { /* nicht erreichbar */ } }
  }
  // Aufnahmeordner zur Laufzeit wechseln (Einstellungen)
  setRecordingsDir(dir, label = dir) {
    if (this.recDir && this.recDir !== dir) this.extraDirs.push(this.recDir);
    this.recDir = dir && !Store.sameDir(dir, this.sessionsDir) ? dir : '';
    this.recLabel = label;
    this.recState = { ok: false, why: '' };
    this.recCheckedAt = 0;
    return this.checkRecordings();
  }

  static sameDir(a, b) {
    try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
  }
  _scan(root) {
    let n = 0;
    for (const id of fs.readdirSync(root)) {
      if (this.sessions.has(id)) continue;
      const meta = this._readJson(path.join(root, id, 'meta.json'), null);
      if (meta) { this.sessions.set(id, meta); this.dirs.set(id, path.join(root, id)); n++; }
    }
    return n;
  }
  // Aufnahmeordner prüfen (beim Start, vor jeder neuen Aufnahme und beim Auflisten – höchstens alle 20 s)
  checkRecordings(force = true) {
    if (!this.recDir) return this.recState;
    if (!force && Date.now() - (this.recCheckedAt || 0) < 20000) return this.recState;
    this.recCheckedAt = Date.now();
    this._scanExtra();
    const was = this.recState.ok;
    this.recState = usableDir(this.recDir);
    if (this.recState.ok) {
      const n = this._scan(this.recDir);
      if (!was && this.recScannedOnce) console.log(`Recordings folder reachable again: ${this.recLabel}${n ? ` (${n} projects loaded)` : ''}`);
      this.recScannedOnce = true;
    } else if (was) console.warn(`WARNING – recordings folder not reachable (${this.recState.why}): ${this.recLabel}`);
    return this.recState;
  }

  _readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  }

  _writeJson(file, data) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  static id(bytes = 9) {
    return crypto.randomBytes(bytes).toString('base64url');
  }

  // ---------- Räume ----------
  listRooms() { return this.rooms; }
  getRoom(id) { return this.rooms.find(r => r.id === id) || null; }
  createRoom(name) {
    const room = { id: Store.id(12), name: String(name || 'Podcast').slice(0, 80), createdAt: Date.now() };
    this.rooms.push(room);
    this._writeJson(this.roomsFile, this.rooms);
    return room;
  }
  renameRoom(id, name) {
    const r = this.getRoom(id);
    if (!r) return null;
    r.name = String(name).slice(0, 80);
    this._writeJson(this.roomsFile, this.rooms);
    return r;
  }
  deleteRoom(id) {
    this.rooms = this.rooms.filter(r => r.id !== id);
    this._writeJson(this.roomsFile, this.rooms);
  }

  // ---------- Eigene FX-Vorlagen ----------
  listPresets() { return this.presets; }
  savePreset({ name, fx, auto, autoName, master }) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error('Name fehlt'), { status: 400 });
    auto = ['none', 'name', 'all'].includes(auto) ? auto : 'none';
    // Es kann nur eine Vorlage „für alle“ geben und nur eine pro Sprechername
    const norm = v => String(v || '').trim().toLowerCase();
    for (const p of this.presets) {
      if (auto === 'all' && p.auto === 'all') p.auto = 'none';
      if (auto === 'name' && p.auto === 'name' && norm(p.autoName) === norm(autoName)) p.auto = 'none';
    }
    let p = this.presets.find(x => norm(x.name) === norm(name));
    if (!p) { p = { id: Store.id(6), createdAt: Date.now() }; this.presets.push(p); }
    Object.assign(p, { name, fx: fx || {}, master: master || null, auto, autoName: auto === 'name' ? String(autoName || '').trim().slice(0, 60) : '', updatedAt: Date.now() });
    this._writeJson(this.presetsFile, this.presets);
    return p;
  }
  deletePreset(id) {
    this.presets = this.presets.filter(p => p.id !== id);
    this._writeJson(this.presetsFile, this.presets);
  }

  // ---------- Sessions ----------
  sessionDir(id) { return this.dirs.get(id) || path.join(this.sessionsDir, id); }
  listSessions() { this.checkRecordings(false); return [...this.sessions.values()].sort((a, b) => b.createdAt - a.createdAt); }
  getSession(id) { return this.sessions.get(id) || null; }
  saveSession(s) {
    s.updatedAt = Date.now();
    this._writeJson(path.join(this.sessionDir(s.id), 'meta.json'), s);
  }
  createSession(room) {
    const id = new Date().toISOString().slice(0, 10) + '-' + Store.id(6);
    // Neue Aufnahmen auf das Netzlaufwerk – ist es gerade nicht erreichbar, lokal (es geht nichts verloren)
    const root = this.recDir && this.checkRecordings().ok ? this.recDir : this.sessionsDir;
    if (this.recDir && root !== this.recDir) console.warn(`Recordings folder not reachable (${this.recState.why}) – storing ${id} in the app data folder`);
    fs.mkdirSync(path.join(root, id), { recursive: true });
    this.dirs.set(id, path.join(root, id));
    const s = {
      id,
      roomId: room.id,
      name: `${room.name} – ${new Date().toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' })}`,
      createdAt: Date.now(),
      startAt: Date.now(),
      stoppedAt: null,
      tracks: [],
      markers: [],
      edl: { cuts: [], tracks: {} },
      exports: [],
    };
    this.sessions.set(id, s);
    this.saveSession(s);
    return s;
  }
  deleteSession(id) {
    const dir = this.sessionDir(id);
    this.sessions.delete(id);
    this.dirs.delete(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  trackFile(s, t) { return path.join(this.sessionDir(s.id), t.file); }
}

Store.usableDir = usableDir;
Store.onMountedShare = onMountedShare;
module.exports = Store;
