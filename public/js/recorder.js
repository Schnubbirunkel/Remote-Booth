// Aufnahme einer Spur: Mikrofon → AudioWorklet → MP3-Worker → IndexedDB (+ optional Backup-Datei)
// → Upload-Warteschlange zum Server. Jede Stufe ist unabhängig: fällt das Netz aus,
// läuft die Aufnahme lokal weiter und wird später nachgeladen.
import * as idb from './idb.js';

export class TrackRecorder extends EventTarget {
  constructor({ stream, sessionId, roomId, roomName, name, clientId, bitrate = 192, serverNow, backupDir }) {
    super();
    Object.assign(this, { stream, sessionId, roomId, roomName, name, clientId, bitrate, serverNow, backupDir });
    this.trackId = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    this.chunks = 0;
    this.duration = 0;
    this.writable = null;
    this.writeChain = Promise.resolve();
    this.state = 'idle';
  }

  async start() {
    this.state = 'starting';
    // Ausschließlich die Audiospur aufnehmen
    const audioOnly = new MediaStream(this.stream.getAudioTracks());
    // 48 kHz bevorzugt; Firefox erlaubt das nur, wenn das Mikrofon dieselbe Rate hat → sonst Standardrate
    try {
      this.ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
      this.src = this.ctx.createMediaStreamSource(audioOnly);
    } catch {
      try { await this.ctx?.close(); } catch { /* egal */ }
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      this.src = this.ctx.createMediaStreamSource(audioOnly);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    await this.ctx.audioWorklet.addModule('/js/rec-worklet.js');
    this.sampleRate = this.ctx.sampleRate;
    this.node = new AudioWorkletNode(this.ctx, 'rec-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.src.connect(this.node).connect(this.sink).connect(this.ctx.destination);

    this.worker = new Worker('/js/mp3-worker.js');
    this.worker.postMessage({ type: 'init', sampleRate: this.sampleRate, bitrate: this.bitrate });
    this.q = Promise.resolve();
    this.worker.onmessage = e => { this.q = this.q.then(() => this._onWorker(e.data)).catch(err => console.error(err)); };
    this.doneP = new Promise(r => { this._done = r; });

    this.node.port.onmessage = e => {
      const m = e.data;
      if (m.first !== undefined) {
        // Zuordnung AudioContext-Zeit ↔ Server-Zeit für exakte Spur-Synchronisation:
        // Der erste Block wurde vor (currentTime − firstCtx) Sekunden erfasst.
        const firstCtx = m.first / this.sampleRate;
        const perf = performance.now() - Math.max(0, this.ctx.currentTime - firstCtx) * 1000;
        const local = performance.timeOrigin + perf;
        this.startServerTime = Math.round(this.serverNow(local));
        this._registerLocal();
      } else if (m.data) {
        this.worker.postMessage({ type: 'data', data: m.data }, [m.data.buffer]);
      } else if (m.done) {
        this.worker.postMessage({ type: 'flush' });
      }
    };

    if (this.backupDir) {
      try {
        const fname = `${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}_${safe(this.name)}_${this.sessionId}.mp3`;
        const fh = await this.backupDir.getFileHandle(fname, { create: true });
        this.writable = await fh.createWritable();
        this.backupFile = fname;
      } catch (e) {
        console.warn('Backup-Datei nicht möglich', e);
        this.dispatchEvent(new CustomEvent('warn', { detail: 'Backup-Ordner nicht beschreibbar – Sicherung läuft nur im Browser.' }));
      }
    }
    this.state = 'recording';
  }

  async _registerLocal() {
    await idb.putTrack({
      trackId: this.trackId, sessionId: this.sessionId, roomId: this.roomId, roomName: this.roomName,
      name: this.name, clientId: this.clientId, createdAt: Date.now(), startServerTime: this.startServerTime,
      sampleRate: this.sampleRate, bitrate: this.bitrate, chunks: 0, uploadedNext: 0, ended: false,
      finalized: false, duration: 0, registered: false,
    });
    this.registered = true;
    this.dispatchEvent(new Event('registered'));
  }

  async _onWorker(m) {
    if (m.type === 'chunk') {
      if (!this.registered) await new Promise(r => this.addEventListener('registered', r, { once: true }));
      await idb.putChunk(this.trackId, m.seq, m.data);
      this.chunks = m.seq + 1;
      this.duration = m.duration;
      await idb.updateTrack(this.trackId, { chunks: this.chunks, duration: m.duration });
      if (this.writable) {
        const data = m.data;
        this.writeChain = this.writeChain.then(() => this.writable.write(data)).catch(err => {
          console.warn('Backup-Schreibfehler', err); this.writable = null;
        });
      }
      this.dispatchEvent(new CustomEvent('chunk', { detail: { seq: m.seq, duration: m.duration } }));
    } else if (m.type === 'done') {
      await idb.updateTrack(this.trackId, { ended: true, chunks: m.chunks, duration: m.duration });
      this._done(m);
    }
  }

  async stop() {
    if (this.state !== 'recording') return;
    this.state = 'stopping';
    this.node.port.postMessage('stop');
    const res = await Promise.race([this.doneP, new Promise(r => setTimeout(() => r(null), 8000))]);
    try { this.src.disconnect(); this.node.disconnect(); } catch { /* egal */ }
    this.worker.terminate();
    await this.ctx.close().catch(() => {});
    if (this.writable) { await this.writeChain; await this.writable.close().catch(() => {}); }
    this.state = 'stopped';
    return res;
  }
}

const safe = s => String(s).replace(/[^\w\-äöüÄÖÜß ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 30) || 'spur';

// ---------- Upload-Warteschlange ----------
// Lädt alle lokal gespeicherten, noch nicht vollständig übertragenen Spuren hoch.
// Läuft nach einem Neuladen der Seite automatisch weiter.
export class Uploader extends EventTarget {
  constructor() {
    super();
    this.busy = false;
    this.again = false;
    this.progress = {}; // trackId -> {sent, total, ended, finalized, error}
  }
  kick() {
    if (this.busy) { this.again = true; return; }
    this._loop();
  }
  async _loop() {
    this.busy = true;
    do {
      this.again = false;
      let tracks = [];
      try { tracks = await idb.allTracks(); } catch (e) { console.warn(e); }
      for (const t of tracks) {
        if (t.finalized || t.orphan) continue;
        try { await this._uploadTrack(t); }
        catch (e) {
          this.progress[t.trackId] = { ...(this.progress[t.trackId] || {}), error: e.message };
          this._emit();
          if (e.status === 404 || e.status === 403) { await idb.updateTrack(t.trackId, { orphan: true }); continue; }
          await new Promise(r => setTimeout(r, 3000));
          this.again = true;
        }
      }
    } while (this.again);
    this.busy = false;
  }
  async _req(url, opts, roomId) {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), 'X-Room': roomId }, credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch { /* egal */ }
    if (!res.ok) throw Object.assign(new Error(data?.error || 'HTTP ' + res.status), { status: res.status });
    return data;
  }
  async _uploadTrack(t) {
    const base = `/api/sessions/${encodeURIComponent(t.sessionId)}/tracks`;
    if (!t.registered) {
      const r = await this._req(base, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: t.trackId, name: t.name, clientId: t.clientId, startServerTime: t.startServerTime, sampleRate: t.sampleRate, bitrate: t.bitrate }),
      }, t.roomId);
      t = await idb.updateTrack(t.trackId, { registered: true, uploadedNext: r.next });
    }
    let next = t.uploadedNext || 0;
    for (;;) {
      const cur = await idb.getTrack(t.trackId);
      if (!cur) return;
      if (next >= cur.chunks) {
        if (cur.ended && !cur.finalized) {
          await this._req(`${base}/${t.trackId}/end`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ totalChunks: cur.chunks, duration: cur.duration }),
          }, t.roomId);
          await idb.updateTrack(t.trackId, { finalized: true });
          this.progress[t.trackId] = { sent: next, total: cur.chunks, ended: true, finalized: true };
          this._emit();
        }
        return;
      }
      const ch = await idb.getChunk(t.trackId, next);
      if (!ch) { next++; continue; }
      const r = await this._req(`${base}/${t.trackId}/chunk?seq=${next}`, { method: 'POST', body: ch.data }, t.roomId);
      next = r.next;
      await idb.updateTrack(t.trackId, { uploadedNext: next });
      this.progress[t.trackId] = { sent: next, total: cur.chunks, ended: cur.ended, finalized: false };
      this._emit();
    }
  }
  _emit() { this.dispatchEvent(new Event('progress')); }

  // Noch nicht übertragene Daten?
  async pendingCount() {
    const tracks = await idb.allTracks().catch(() => []);
    return tracks.filter(t => !t.finalized && !t.orphan).length;
  }
}
