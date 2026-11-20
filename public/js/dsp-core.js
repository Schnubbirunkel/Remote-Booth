// Gemeinsamer Effekt-Code für Editor-Vorschau (AudioWorklet) UND Export (Node auf dem Server).
// Was im Editor zu hören ist, ist damit exakt das, was exportiert wird.
// Bewusst ohne import/export: der Server hängt die Datei vor den Worklet-Code und lädt sie per require().
(function (root) {
  'use strict';
  const lin = db => Math.pow(10, db / 20);
  const clamp = (v, a, b, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d; };

  const DEFAULTS = {
    gate: { on: false, threshold: -45, range: -25, attack: 5, release: 150 },
    eq: { on: false, hp: 80, lowGain: 0, lowFreq: 120, m1Gain: 0, m1Freq: 300, m2Gain: 0, m2Freq: 3000, highGain: 0, highFreq: 10000 },
    comp: { on: false, threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 4 },
    limiter: { on: false, ceiling: -3, release: 50 },
  };
  const COMP_KNEE = 6; // dB, weiches Knie
  const LIMIT_LOOKAHEAD = 0.005; // s

  function fullFx(fx) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = Object.assign({}, DEFAULTS[k], (fx && fx[k]) || {});
    return out;
  }

  // ---------- Noise Gate: RMS-Detektor (10 ms), 50 ms Haltezeit, weiches Öffnen/Schließen ----------
  class Gate {
    constructor(sr) { this.sr = sr; this.env = 0; this.gain = 1; this.hold = 0; this.set({}); }
    set(p) {
      const sr = this.sr;
      this.on = !!p.on;
      this.envCoef = Math.exp(-1 / (0.01 * sr));
      this.atk = Math.exp(-1 / (Math.max(0.1, clamp(p.attack, 0.1, 200, 5)) * 0.001 * sr));
      this.rel = Math.exp(-1 / (Math.max(1, clamp(p.release, 1, 5000, 150)) * 0.001 * sr));
      const thr = lin(clamp(p.threshold, -100, 0, -45));
      this.thr2 = thr * thr;
      this.floor = lin(clamp(p.range, -100, 0, -25));
      this.holdSamples = Math.round(0.05 * sr);
    }
    process(chs, n) {
      if (!this.on) { this.gain = 1; return; }
      const C = chs.length;
      let env = this.env, gain = this.gain, hold = this.hold;
      const { envCoef, atk, rel, thr2, floor, holdSamples } = this;
      for (let i = 0; i < n; i++) {
        let s2 = 0;
        for (let c = 0; c < C; c++) s2 += chs[c][i] * chs[c][i];
        s2 /= C;
        env = envCoef * env + (1 - envCoef) * s2;
        if (env > thr2) hold = holdSamples; else if (hold > 0) hold--;
        const target = hold > 0 ? 1 : floor;
        const coef = target > gain ? atk : rel;
        gain = coef * gain + (1 - coef) * target;
        for (let c = 0; c < C; c++) chs[c][i] *= gain;
      }
      this.env = env; this.gain = gain; this.hold = hold;
    }
    get reductionDb() { return this.on ? 20 * Math.log10(this.gain + 1e-9) : 0; }
  }

  // ---------- Biquad nach Web-Audio-Spezifikation (RBJ) – identisch zum BiquadFilterNode ----------
  class Biquad {
    constructor(sr, channels) { this.sr = sr; this.z = Array.from({ length: channels }, () => [0, 0]); this.active = false; }
    set(type, f, gainDb, q) {
      const sr = this.sr;
      f = Math.max(1, Math.min(sr / 2 - 1, f));
      const w0 = 2 * Math.PI * f / sr, cs = Math.cos(w0), sn = Math.sin(w0);
      const A = Math.pow(10, gainDb / 40);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'highpass') {
        const alpha = sn / (2 * Math.pow(10, q / 20)); // Q in dB (Web Audio)
        b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
      } else if (type === 'lowshelf' || type === 'highshelf') {
        const alphaS = sn / 2 * Math.SQRT2, k = 2 * Math.sqrt(A) * alphaS;
        if (type === 'lowshelf') {
          b0 = A * ((A + 1) - (A - 1) * cs + k); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - k);
          a0 = (A + 1) + (A - 1) * cs + k; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - k;
        } else {
          b0 = A * ((A + 1) + (A - 1) * cs + k); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - k);
          a0 = (A + 1) - (A - 1) * cs + k; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - k;
        }
      } else { // peaking
        const alpha = sn / (2 * q);
        b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
      }
      this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
      this.active = true;
    }
    process(chs, n) {
      if (!this.active) return;
      const { b0, b1, b2, a1, a2 } = this;
      for (let c = 0; c < chs.length; c++) {
        const x = chs[c], z = this.z[c];
        let z1 = z[0], z2 = z[1];
        for (let i = 0; i < n; i++) { // transponierte Direktform II
          const xi = x[i], y = b0 * xi + z1;
          z1 = b1 * xi - a1 * y + z2;
          z2 = b2 * xi - a2 * y;
          x[i] = y;
        }
        z[0] = z1; z[1] = z2;
      }
    }
  }

  class EQ {
    constructor(sr, channels) {
      this.f = { hp: new Biquad(sr, channels), low: new Biquad(sr, channels), m1: new Biquad(sr, channels), m2: new Biquad(sr, channels), high: new Biquad(sr, channels) };
    }
    set(p) {
      const on = !!p.on, f = this.f;
      for (const b of Object.values(f)) b.active = false;
      if (!on) return;
      const hp = clamp(p.hp, 10, 400, 80);
      if (hp > 21) f.hp.set('highpass', hp, 0, -3.01);
      const g = (k, d) => clamp(p[k], -24, 24, d);
      if (Math.abs(g('lowGain', 0)) >= 0.1) f.low.set('lowshelf', clamp(p.lowFreq, 20, 1000, 120), g('lowGain', 0));
      if (Math.abs(g('m1Gain', 0)) >= 0.1) f.m1.set('peaking', clamp(p.m1Freq, 40, 8000, 300), g('m1Gain', 0), 1);
      if (Math.abs(g('m2Gain', 0)) >= 0.1) f.m2.set('peaking', clamp(p.m2Freq, 200, 16000, 3000), g('m2Gain', 0), 1);
      if (Math.abs(g('highGain', 0)) >= 0.1) f.high.set('highshelf', clamp(p.highFreq, 1000, 20000, 10000), g('highGain', 0));
    }
    process(chs, n) { const f = this.f; f.hp.process(chs, n); f.low.process(chs, n); f.m1.process(chs, n); f.m2.process(chs, n); f.high.process(chs, n); }
  }

  // ---------- Kompressor: Spitzenpegel, weiches Knie (6 dB), Attack/Release auf die Absenkung, Aufholverstärkung ----------
  class Compressor {
    constructor(sr) { this.sr = sr; this.gs = 0; this.set({}); }
    set(p) {
      const sr = this.sr;
      this.on = !!p.on;
      this.T = clamp(p.threshold, -80, 0, -20);
      this.R = clamp(p.ratio, 1, 50, 3);
      this.W = COMP_KNEE;
      this.aA = Math.exp(-1 / (clamp(p.attack, 0.05, 500, 10) * 0.001 * sr));
      this.aR = Math.exp(-1 / (clamp(p.release, 5, 5000, 150) * 0.001 * sr));
      this.mk = clamp(p.makeup, -24, 36, 4);
    }
    process(chs, n) {
      if (!this.on) { this.gs = 0; return; }
      const C = chs.length, { T, R, W, aA, aR, mk } = this;
      const slope = 1 / R - 1, LN = 8.685889638065035; // 20/ln(10)
      let gs = this.gs;
      for (let i = 0; i < n; i++) {
        let pk = 0;
        for (let c = 0; c < C; c++) { const v = Math.abs(chs[c][i]); if (v > pk) pk = v; }
        const x = pk > 1e-9 ? Math.log(pk) * LN : -180;
        const d = x - T;
        let gc;
        if (2 * d < -W) gc = 0;
        else if (2 * d > W) gc = slope * d;
        else { const e = d + W / 2; gc = slope * e * e / (2 * W); }
        gs = gc < gs ? aA * gs + (1 - aA) * gc : aR * gs + (1 - aR) * gc;
        const g = Math.exp((gs + mk) / LN);
        for (let c = 0; c < C; c++) chs[c][i] *= g;
      }
      this.gs = gs;
    }
    get reductionDb() { return this.on ? this.gs : 0; }
  }

  // ---------- Limiter mit 5 ms Vorausschau: Spitzen bleiben garantiert unter der Grenze ----------
  // Ablauf: nötige Absenkung je Sample → Minimum über die Vorausschau → sofort runter, langsam (Release) hoch
  // → gleitender Mittelwert über die Vorausschau (weiche Rampe) → auf das um die Vorausschau verzögerte Signal.
  class Limiter {
    constructor(sr, channels) {
      this.sr = sr; this.C = channels;
      this.L = Math.max(1, Math.round(LIMIT_LOOKAHEAD * sr));
      this.delay = Array.from({ length: channels }, () => new Float32Array(this.L));
      this.req = new Float64Array(this.L + 1);   // nötige Absenkung (Ring)
      this.dqI = new Int32Array(this.L + 2); this.dqH = 0; this.dqT = 0; // Monotone Queue für das Minimum
      this.avg = new Float64Array(this.L); this.sum = this.L; this.avg.fill(1);
      this.env = 1; this.pos = 0; this.n = 0; this.gainNow = 1;
      this.set({});
    }
    set(p) {
      this.on = !!p.on;
      this.ceil = lin(clamp(p.ceiling, -30, 0, -1));
      this.aR = Math.exp(-1 / (clamp(p.release, 5, 2000, 50) * 0.001 * this.sr));
    }
    get latency() { return this.L; }
    process(chs, n) {
      const C = this.C, L = this.L, ceil = this.ceil, aR = this.aR, req = this.req, dq = this.dqI, Q = dq.length, R = L + 1;
      const on = this.on;
      let { dqH, dqT, env, sum, pos, n: cnt } = this;
      for (let i = 0; i < n; i++) {
        let pk = 0;
        for (let c = 0; c < C; c++) { const v = Math.abs(chs[c][i]); if (v > pk) pk = v; }
        const r = on && pk > ceil ? ceil / pk : 1;
        // Minimum der nötigen Absenkung über die letzten L+1 Samples (= Vorausschau für das verzögerte Signal)
        const idx = cnt % R; req[idx] = r;
        while (dqT !== dqH && req[dq[(dqT - 1 + Q) % Q] % R] >= r && cnt - dq[(dqT - 1 + Q) % Q] <= L) dqT = (dqT - 1 + Q) % Q;
        dq[dqT] = cnt; dqT = (dqT + 1) % Q;
        while (cnt - dq[dqH] > L) dqH = (dqH + 1) % Q;
        const held = req[dq[dqH] % R];
        env = held < env ? held : aR * env + (1 - aR) * held;
        sum += env - this.avg[pos]; this.avg[pos] = env;
        const g = Math.min(1, sum / L);
        // Signal um L Samples verzögern und absenken
        for (let c = 0; c < C; c++) { const d = this.delay[c], x = chs[c][i]; chs[c][i] = d[pos] * g; d[pos] = x; }
        pos = (pos + 1) % L; cnt++;
        this.gainNow = g;
      }
      Object.assign(this, { dqH, dqT, env, sum, pos, n: cnt });
    }
    get reductionDb() { return 20 * Math.log10(this.gainNow + 1e-9); }
  }

  // ---------- Komplette Spurkette: Gate → EQ → Kompressor → Limiter ----------
  class FxChain {
    constructor(sr, channels) {
      this.gate = new Gate(sr); this.eq = new EQ(sr, channels); this.comp = new Compressor(sr); this.lim = new Limiter(sr, channels);
      this.set(null);
    }
    set(fx, off = false) {
      const f = fullFx(fx);
      const on = k => !off && !!f[k].on;
      this.gate.set({ ...f.gate, on: on('gate') });
      this.eq.set({ ...f.eq, on: on('eq') });
      this.comp.set({ ...f.comp, on: on('comp') });
      this.lim.set({ ...f.limiter, on: on('limiter') });
      this.limOn = on('limiter');
      this.any = on('gate') || on('eq') || on('comp') || on('limiter');
    }
    // Verzögerung durch den Limiter (wird beim Export ausgeglichen)
    get latency() { return this.limOn ? this.lim.latency : 0; }
    process(chs, n) {
      if (!this.any) return;
      this.gate.process(chs, n); this.eq.process(chs, n); this.comp.process(chs, n);
      if (this.limOn) this.lim.process(chs, n);
    }
  }

  // ---------- Lautheitsmessung nach ITU-R BS.1770-4 / EBU R128 (integrierte Lautheit, 48 kHz) ----------
  // K-Filter → mittlere Leistung in 400-ms-Blöcken (75 % Überlappung) → Gate −70 LUFS absolut, −10 LU relativ
  class LoudnessMeter {
    constructor(channels) {
      this.C = channels;
      this.f1 = { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 };
      this.f2 = { b0: 1, b1: -2, b2: 1, a1: -1.99004745483398, a2: 0.99007225036621 };
      this.z = Array.from({ length: channels }, () => [0, 0, 0, 0]);
      this.sub = 4800; // 100 ms
      this.acc = 0; this.cnt = 0;
      this.subs = []; // Leistung je 100-ms-Abschnitt (über Kanäle summiert)
    }
    // chs: planare Kanäle, n Samples
    process(chs, n) {
      const C = this.C, f1 = this.f1, f2 = this.f2;
      for (let i = 0; i < n; i++) {
        let e = 0;
        for (let c = 0; c < C; c++) {
          const z = this.z[c], x = chs[c][i];
          const y1 = f1.b0 * x + z[0]; z[0] = f1.b1 * x - f1.a1 * y1 + z[1]; z[1] = f1.b2 * x - f1.a2 * y1;
          const y2 = f2.b0 * y1 + z[2]; z[2] = f2.b1 * y1 - f2.a1 * y2 + z[3]; z[3] = f2.b2 * y1 - f2.a2 * y2;
          e += y2 * y2;
        }
        this.acc += e;
        if (++this.cnt === this.sub) { this.subs.push(this.acc / this.sub); this.acc = 0; this.cnt = 0; }
      }
    }
    integrated() {
      const s = this.subs, blocks = [];
      for (let i = 3; i < s.length; i++) blocks.push((s[i] + s[i - 1] + s[i - 2] + s[i - 3]) / 4);
      const L = z => -0.691 + 10 * Math.log10(z);
      const abs = blocks.filter(z => z > 0 && L(z) > -70);
      if (!abs.length) return null;
      const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
      const g = abs.filter(z => L(z) > rel);
      return g.length ? L(g.reduce((a, b) => a + b, 0) / g.length) : null;
    }
  }

  const api = { DEFAULTS, fullFx, Gate, Biquad, EQ, Compressor, Limiter, FxChain, LoudnessMeter, COMP_KNEE, LIMIT_LOOKAHEAD };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PSDSP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
