// Web Worker: wandelt die Samples während der Aufnahme direkt in MP3 um (LAME in JavaScript).
// So entsteht keinerlei Last auf dem Server.
importScripts('/vendor/lame.js');

let enc = null;
let pending = [];
let pendingBytes = 0;
let seq = 0;
let lastEmit = 0;
let samples = 0;
let sampleRate = 48000;
let left = new Int16Array(0);

function emit(force) {
  if (!pendingBytes) return;
  const now = Date.now();
  if (!force && now - lastEmit < 1000) return;
  const out = new Uint8Array(pendingBytes);
  let o = 0;
  for (const p of pending) { out.set(p, o); o += p.length; }
  pending = []; pendingBytes = 0; lastEmit = now;
  postMessage({ type: 'chunk', seq: seq++, data: out.buffer, duration: samples / sampleRate }, [out.buffer]);
}

onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    sampleRate = m.sampleRate;
    enc = new lamejs.Mp3Encoder(1, m.sampleRate, m.bitrate);
    seq = 0; samples = 0; lastEmit = Date.now();
  } else if (m.type === 'data') {
    const f = m.data;
    // Float32 → Int16, in 1152er-Blöcken an LAME
    const all = new Int16Array(left.length + f.length);
    all.set(left);
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      all[left.length + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    samples += f.length;
    let i = 0;
    for (; i + 1152 <= all.length; i += 1152) {
      const mp3 = enc.encodeBuffer(all.subarray(i, i + 1152));
      if (mp3.length) { pending.push(new Uint8Array(mp3)); pendingBytes += mp3.length; }
    }
    left = all.slice(i);
    emit(false);
  } else if (m.type === 'flush') {
    if (left.length) {
      const mp3 = enc.encodeBuffer(left);
      if (mp3.length) { pending.push(new Uint8Array(mp3)); pendingBytes += mp3.length; }
      left = new Int16Array(0);
    }
    const fin = enc.flush();
    if (fin.length) { pending.push(new Uint8Array(fin)); pendingBytes += fin.length; }
    emit(true);
    postMessage({ type: 'done', chunks: seq, duration: samples / sampleRate });
  }
};
