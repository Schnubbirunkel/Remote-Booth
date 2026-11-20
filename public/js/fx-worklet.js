// Editor-Vorschau: Effektkette und Summen-Limiter als AudioWorklet.
// Der Server stellt beim Ausliefern dsp-core.js voran (globalThis.PSDSP) – derselbe Code rechnet auch den Export.
const { FxChain, Limiter, fullFx } = globalThis.PSDSP;

class PsFx extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.chain = new FxChain(sampleRate, 1);
    const o = options && options.processorOptions;
    if (o && o.fx !== undefined) this.chain.set(o.fx, !!o.off);
    this.port.onmessage = e => { if (e.data && e.data.fx !== undefined) this.chain.set(e.data.fx, !!e.data.off); };
    this.t = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const n = out[0].length;
    if (!inp || !inp.length) { out[0].fill(0); return true; }
    // Mono: Kanäle mitteln (die Spur ist mono)
    const o = out[0];
    if (inp.length === 1) o.set(inp[0]);
    else { for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < inp.length; c++) s += inp[c][i]; o[i] = s / inp.length; } }
    this.chain.process([o], n);
    if ((this.t += n) > sampleRate / 20) {
      this.t = 0;
      const ch = this.chain;
      this.port.postMessage({ gate: ch.gate.reductionDb, comp: ch.comp.reductionDb, lim: ch.limOn ? ch.lim.reductionDb : 0 });
    }
    return true;
  }
}
registerProcessor('ps-fx', PsFx);

class PsMasterLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.lim = new Limiter(sampleRate, 2);
    this.on = true;
    this.port.onmessage = e => { const l = e.data || {}; this.on = !!l.on; this.lim.set(l); };
    this.t = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || out.length < 2) return true;
    const n = out[0].length;
    if (!inp || !inp.length) { out[0].fill(0); out[1].fill(0); }
    else { out[0].set(inp[0]); out[1].set(inp[1] || inp[0]); }
    this.lim.process([out[0], out[1]], n); // auch „aus“ durchlaufen, damit die Verzögerung gleich bleibt
    if ((this.t += n) > sampleRate / 20) { this.t = 0; this.port.postMessage({ lim: this.on ? this.lim.reductionDb : 0 }); }
    return true;
  }
}
registerProcessor('ps-master-limiter', PsMasterLimiter);
