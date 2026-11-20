// Einstellungen, die in der Oberfläche geändert werden (Passwort, Sprache, Ordner).
// Gespeichert in DATA_DIR/settings.json. Umgebungsvariablen bleiben als Vorgabe gültig.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Settings {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'settings.json');
    this.data = {};
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* erster Start */ }
  }
  get(key, fallback = undefined) { return this.data[key] !== undefined ? this.data[key] : fallback; }
  set(patch) {
    for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete this.data[k]; else this.data[k] = v; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---------- Passwort (scrypt) ----------
  setPassword(pw) {
    if (!pw) { this.set({ passwordHash: undefined, passwordSalt: undefined, noPassword: true }); return; }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
    this.set({ passwordHash: hash, passwordSalt: salt, noPassword: undefined });
  }
  checkPassword(pw) {
    const { passwordHash, passwordSalt } = this.data;
    if (!passwordHash || !passwordSalt) return false;
    const a = Buffer.from(passwordHash, 'hex');
    const b = crypto.scryptSync(String(pw || ''), passwordSalt, 32);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  hasPassword() { return !!this.data.passwordHash; }
  // Ersteinrichtung abgeschlossen? (Passwort gesetzt oder bewusst ohne Passwort)
  isSetUp() { return this.hasPassword() || !!this.data.noPassword; }
}

module.exports = Settings;
