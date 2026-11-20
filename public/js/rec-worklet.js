// AudioWorklet: greift die rohen Mikrofon-Samples ab (verlustfrei, ohne Browser-Codec)
// und schickt sie in 100-ms-Blöcken an den Haupt-Thread.
class RecCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate / 10);
    this.buf = new Float32Array(this.size);
    this.pos = 0;
    this.firstFrame = -1;
    this.blockStart = 0;
    this.running = true;
    this.port.onmessage = e => { if (e.data === 'stop') { this.flush(); this.running = false; this.port.postMessage({ done: true }); } };
  }
  flush() {
    if (this.pos > 0) {
      const out = this.buf.slice(0, this.pos);
      this.port.postMessage({ frame: this.blockStart, data: out }, [out.buffer]);
      this.pos = 0;
    }
  }
  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    const n = input && input[0] ? input[0].length : 128;
    if (!input || input.length === 0) {
      // Kein Signal (z. B. stummgeschaltet) – trotzdem Stille aufnehmen, damit die Zeit stimmt
      if (this.firstFrame < 0) return true;
    }
    if (this.firstFrame < 0) { this.firstFrame = currentFrame; this.port.postMessage({ first: currentFrame }); }
    for (let i = 0; i < n; i++) {
      if (this.pos === 0) this.blockStart = currentFrame + i;
      let v = 0;
      if (input && input.length) {
        for (let c = 0; c < input.length; c++) v += input[c][i];
        v /= input.length;
      }
      this.buf[this.pos++] = v;
      if (this.pos === this.size) this.flush();
    }
    return true;
  }
}
registerProcessor('rec-capture', RecCapture);
