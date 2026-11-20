// Effekt-Definitionen (Noise Gate, EQ, Kompressor, Limiter) – gemeinsam für Vorschau und Export.
// Die Vorschau nutzt Web-Audio-Knoten, der Export die entsprechenden ffmpeg-Filter (server/audio.js).

export const FX_SCHEMA = {
  gate: {
    title: 'Noise Gate',
    desc: 'Senkt Hintergrundrauschen und Atmer in Sprechpausen ab.',
    params: [
      { k: 'threshold', label: 'Schwelle', min: -80, max: -10, step: 1, unit: 'dB' },
      { k: 'range', label: 'Absenkung', min: -60, max: 0, step: 1, unit: 'dB' },
      { k: 'attack', label: 'Öffnen', min: 0.5, max: 50, step: 0.5, unit: 'ms', log: true },
      { k: 'release', label: 'Schließen', min: 10, max: 1000, step: 1, unit: 'ms', log: true },
    ],
  },
  eq: {
    title: 'Equalizer',
    desc: 'Klangfarbe: Trittschall weg, Mulm raus, mehr Präsenz.',
    params: [
      { k: 'hp', label: 'Low-Cut', min: 20, max: 300, step: 1, unit: 'Hz', log: true },
      { k: 'lowGain', label: 'Bass', min: -12, max: 12, step: 0.5, unit: 'dB', center: true },
      { k: 'lowFreq', label: 'Bass-Frequenz', min: 40, max: 400, step: 1, unit: 'Hz', log: true },
      { k: 'm1Gain', label: 'Mitten', min: -12, max: 12, step: 0.5, unit: 'dB', center: true },
      { k: 'm1Freq', label: 'Mitten-Frequenz', min: 100, max: 2000, step: 1, unit: 'Hz', log: true },
      { k: 'm2Gain', label: 'Präsenz', min: -12, max: 12, step: 0.5, unit: 'dB', center: true },
      { k: 'm2Freq', label: 'Präsenz-Frequenz', min: 1000, max: 8000, step: 10, unit: 'Hz', log: true },
      { k: 'highGain', label: 'Höhen', min: -12, max: 12, step: 0.5, unit: 'dB', center: true },
      { k: 'highFreq', label: 'Höhen-Frequenz', min: 3000, max: 18000, step: 100, unit: 'Hz', log: true },
    ],
  },
  comp: {
    title: 'Kompressor',
    desc: 'Gleicht laute und leise Passagen an – die Stimme wirkt dichter.',
    params: [
      { k: 'threshold', label: 'Schwelle', min: -60, max: 0, step: 1, unit: 'dB' },
      { k: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, unit: ':1', log: true },
      { k: 'attack', label: 'Attack', min: 0.5, max: 100, step: 0.5, unit: 'ms', log: true },
      { k: 'release', label: 'Release', min: 20, max: 1000, step: 5, unit: 'ms', log: true },
      { k: 'makeup', label: 'Aufholverstärkung', min: 0, max: 24, step: 0.5, unit: 'dB' },
    ],
  },
  limiter: {
    title: 'Limiter',
    desc: 'Harte Obergrenze für diese Spur – fängt einzelne Lacher oder Ausrufe ab.',
    params: [
      { k: 'ceiling', label: 'Obergrenze', min: -24, max: 0, step: 0.1, unit: 'dB' },
      { k: 'release', label: 'Release', min: 10, max: 500, step: 5, unit: 'ms', log: true },
    ],
  },
};

export const MASTER_SCHEMA = {
  limiter: {
    title: 'Limiter (Summe)',
    desc: 'Verhindert Übersteuerung im fertigen Mix. Wird nach der Lautheitsangleichung angewendet.',
    params: [
      { k: 'ceiling', label: 'Obergrenze', min: -12, max: 0, step: 0.1, unit: 'dB' },
      { k: 'release', label: 'Release', min: 10, max: 500, step: 5, unit: 'ms', log: true },
    ],
  },
};

export const FX_DEFAULTS = {
  gate: { on: false, threshold: -45, range: -25, attack: 5, release: 150 },
  eq: { on: false, hp: 80, lowGain: 0, lowFreq: 120, m1Gain: 0, m1Freq: 300, m2Gain: 0, m2Freq: 3000, highGain: 0, highFreq: 10000 },
  comp: { on: false, threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 4 },
  limiter: { on: false, ceiling: -3, release: 50 },
};
export const MASTER_DEFAULTS = { limiter: { on: true, ceiling: -1, release: 50 } };

export const PRESETS = {
  off: { label: 'Alles aus', fx: { gate: { on: false }, eq: { on: false }, comp: { on: false }, limiter: { on: false } } },
  natural: {
    label: 'Sprache – natürlich',
    fx: {
      gate: { on: true, threshold: -50, range: -15, attack: 5, release: 200 },
      eq: { on: true, hp: 80, lowGain: 0, lowFreq: 120, m1Gain: -1.5, m1Freq: 300, m2Gain: 1.5, m2Freq: 3000, highGain: 1.5, highFreq: 10000 },
      comp: { on: true, threshold: -22, ratio: 2.5, attack: 15, release: 200, makeup: 3 },
    },
  },
  radio: {
    label: 'Sprache – Radio/Broadcast',
    fx: {
      gate: { on: true, threshold: -45, range: -25, attack: 3, release: 150 },
      eq: { on: true, hp: 90, lowGain: 3, lowFreq: 120, m1Gain: -3, m1Freq: 300, m2Gain: 3, m2Freq: 3000, highGain: 2, highFreq: 10000 },
      comp: { on: true, threshold: -26, ratio: 4, attack: 5, release: 120, makeup: 6 },
      limiter: { on: true, ceiling: -3, release: 50 },
    },
  },
  noisy: {
    label: 'Lauter Raum / Rauschen',
    fx: {
      gate: { on: true, threshold: -40, range: -35, attack: 3, release: 120 },
      eq: { on: true, hp: 120, lowGain: -2, lowFreq: 150, m1Gain: -2, m1Freq: 400, m2Gain: 2, m2Freq: 3000, highGain: -1, highFreq: 9000 },
      comp: { on: true, threshold: -24, ratio: 3, attack: 10, release: 150, makeup: 4 },
      limiter: { on: true, ceiling: -3, release: 50 },
    },
  },
  music: {
    label: 'Musik/Jingle – nur leicht',
    fx: { gate: { on: false }, eq: { on: false }, comp: { on: true, threshold: -14, ratio: 2, attack: 20, release: 250, makeup: 1 }, limiter: { on: true, ceiling: -2, release: 80 } },
  },
};

// Vollständige Effekt-Einstellungen (fehlende Werte mit Standardwerten auffüllen)
export function fullFx(fx) {
  const out = {};
  for (const k of Object.keys(FX_DEFAULTS)) out[k] = { ...FX_DEFAULTS[k], ...(fx?.[k] || {}) };
  return out;
}
export function fullMaster(m) {
  const out = {};
  for (const k of Object.keys(MASTER_DEFAULTS)) out[k] = { ...MASTER_DEFAULTS[k], ...(m?.[k] || {}) };
  return out;
}
export function applyPreset(fx, name) {
  const p = PRESETS[name];
  if (!p) return fx;
  const out = fullFx(fx);
  for (const k of Object.keys(p.fx)) out[k] = { ...out[k], ...p.fx[k] };
  return out;
}
export const fxActive = fx => !!fx && Object.values(fx).some(s => s && s.on);

// Regler-Position ↔ Wert (für Frequenzen/Zeiten logarithmisch)
export function toSlider(p, v) {
  if (!p.log) return v;
  return (Math.log(v / p.min) / Math.log(p.max / p.min)) * 1000;
}
export function fromSlider(p, s) {
  if (!p.log) return +s;
  const v = p.min * Math.pow(p.max / p.min, s / 1000);
  return Math.round(v / p.step) * p.step;
}
export function fmtParam(p, v) {
  if (p.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' kHz' : Math.round(v) + ' Hz';
  if (p.unit === ':1') return (+v).toFixed(1) + ':1';
  if (p.unit === 'ms') return (v < 10 ? (+v).toFixed(1) : Math.round(v)) + ' ms';
  const s = (+v).toFixed(p.step < 1 ? 1 : 0);
  return (p.center && v > 0 ? '+' : '') + s + ' dB';
}

// Web-Audio-Kompressor hebt intern automatisch an (Spezifikation: "makeup gain").
// Für eine ehrliche Vorschau rechnen wir diesen Anteil wieder heraus (Näherung).
export function webAudioAutoMakeupDb(threshold, knee, ratio) {
  const kneeEnd = threshold + knee;
  const atKneeEnd = threshold + knee / ratio;
  const out0 = kneeEnd >= 0 ? threshold + (0 - threshold) / ratio : atKneeEnd + (0 - kneeEnd) / ratio;
  return -out0 * 0.6;
}
