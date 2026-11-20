// ffmpeg-Hilfen: Dauer ermitteln, Wellenform-Spitzenwerte, Export (Schnitt + Mix + MP3).
// ffmpeg läuft nur auf Abruf (Wellenform einmalig pro Spur, Export auf Knopfdruck)
// und mit niedriger Priorität, damit ein kleiner i3 ohne GPU nicht ins Schwitzen kommt.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PEAKS_PER_SEC = 100;
const FFMPEG_THREADS = String(process.env.FFMPEG_THREADS || 2);
// Wie viel der CPU der Export nutzen darf (Prozent aller Kerne/Threads). ffmpeg rechnet Audio-Filter
// weitgehend auf einem Kern – deshalb laufen mehrere ffmpeg-Prozesse parallel (je Spur/Ausgabe einer).
const CPU_COUNT = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
const EXPORT_CPU = Math.max(10, Math.min(100, +process.env.EXPORT_CPU || 80));
const EXPORT_WORKERS = Math.max(1, Math.min(CPU_COUNT, Math.round(CPU_COUNT * EXPORT_CPU / 100)));

function run(cmd, args, { onStdout, onStderr, job } = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(Object.assign(new Error('Abgebrochen'), { cancelled: true }));
    // "nice" senkt die CPU-Priorität; falls nicht vorhanden, direkt starten.
    const useNice = fs.existsSync('/usr/bin/nice') || fs.existsSync('/bin/nice');
    const p = useNice ? spawn('nice', ['-n', '10', cmd, ...args]) : spawn(cmd, args);
    if (job) { (job.procs = job.procs || new Set()).add(p); p.on('close', () => job.procs.delete(p)); }
    let err = '';
    p.stdout.on('data', d => onStdout && onStdout(d));
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); onStderr && onStderr(d); });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve()
      : job?.cancelled ? reject(Object.assign(new Error('Abgebrochen'), { cancelled: true }))
      : reject(new Error(`${cmd} exit ${code}: ${err.slice(-1500)}`))));
  });
}

async function probeDuration(file) {
  let out = '';
  await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], {
    onStdout: d => (out += d),
  });
  const v = parseFloat(out);
  return Number.isFinite(v) ? v : 0;
}

// Spitzenwerte (0..255) mit 100 Werten pro Sekunde, als Binärdatei gecacht.
async function computePeaks(file, cacheFile) {
  try {
    const st = fs.statSync(file);
    const cst = fs.statSync(cacheFile);
    if (cst.mtimeMs >= st.mtimeMs) return fs.readFileSync(cacheFile);
  } catch { /* neu berechnen */ }
  const rate = 8000;
  const per = rate / PEAKS_PER_SEC; // 80 Samples pro Peak
  const peaks = [];
  let cur = 0, n = 0, carry = null;
  await run('ffmpeg', ['-v', 'error', '-threads', '1', '-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], {
    onStdout: d => {
      let buf = carry ? Buffer.concat([carry, d]) : d;
      const usable = buf.length - (buf.length % 2);
      carry = usable < buf.length ? buf.subarray(usable) : null;
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > cur) cur = v;
        if (++n >= per) { peaks.push(Math.min(255, Math.round((cur / 32768) * 255))); cur = 0; n = 0; }
      }
    },
  });
  if (n > 0) peaks.push(Math.min(255, Math.round((cur / 32768) * 255)));
  const out = Buffer.from(Uint8Array.from(peaks));
  fs.writeFileSync(cacheFile, out);
  return out;
}

// ---------- Export ----------
function mergeRanges(ranges) {
  const r = (ranges || [])
    .map(([a, b]) => [Math.max(0, +a), Math.max(0, +b)])
    .filter(([a, b]) => b - a > 0.005)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const cur of r) {
    const last = out[out.length - 1];
    if (last && cur[0] <= last[1]) last[1] = Math.max(last[1], cur[1]);
    else out.push([...cur]);
  }
  return out;
}

const f = n => (Math.round(n * 1000) / 1000).toFixed(3);
const lin = db => Math.pow(10, db / 20);
const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };

// Effekte einer Spur → ffmpeg-Filter (Reihenfolge: Gate → EQ → Kompressor)
function fxFilters(fx) {
  const out = [];
  if (!fx) return out;
  const g = fx.gate;
  if (g && g.on) {
    out.push(`agate=threshold=${lin(num(g.threshold, -80, -10, -45)).toFixed(6)}:range=${Math.max(0.001, lin(num(g.range, -60, 0, -25))).toFixed(6)}` +
      `:ratio=20:attack=${num(g.attack, 0.5, 50, 5)}:release=${num(g.release, 10, 1000, 150)}:detection=rms`);
  }
  const e = fx.eq;
  if (e && e.on) {
    if (num(e.hp, 20, 300, 80) > 21) out.push(`highpass=f=${num(e.hp, 20, 300, 80)}:t=q:w=0.707`);
    const shelf = (name, fr, gain) => { if (Math.abs(gain) >= 0.1) out.push(`${name}=f=${fr}:g=${gain}:t=s:w=1`); };
    const peak = (fr, gain) => { if (Math.abs(gain) >= 0.1) out.push(`equalizer=f=${fr}:t=q:w=1:g=${gain}`); };
    shelf('bass', num(e.lowFreq, 40, 400, 120), num(e.lowGain, -15, 15, 0));
    peak(num(e.m1Freq, 100, 2000, 300), num(e.m1Gain, -15, 15, 0));
    peak(num(e.m2Freq, 1000, 8000, 3000), num(e.m2Gain, -15, 15, 0));
    shelf('treble', num(e.highFreq, 3000, 18000, 10000), num(e.highGain, -15, 15, 0));
  }
  const c = fx.comp;
  if (c && c.on) {
    out.push(`acompressor=threshold=${lin(num(c.threshold, -60, 0, -20)).toFixed(6)}:ratio=${num(c.ratio, 1, 20, 3)}` +
      `:attack=${num(c.attack, 0.1, 200, 10)}:release=${num(c.release, 10, 2000, 150)}:makeup=${Math.min(64, lin(num(c.makeup, 0, 24, 0))).toFixed(4)}` +
      `:knee=2.8:detection=rms`);
  }
  const l = fx.limiter;
  if (l && l.on) {
    out.push(`alimiter=limit=${Math.max(0.0625, lin(num(l.ceiling, -24, 0, -1))).toFixed(5)}:attack=5:release=${num(l.release, 10, 500, 50)}:level=0`);
  }
  return out;
}

// Lautstärke-Hüllkurve (wie Reaper „Volume Envelope“): Punkte [Zeit s, dB], linear interpoliert.
// Umsetzung als Kette von volume-Filtern, die jeweils nur in ihrem Abschnitt aktiv sind.
const envGain = db => (db <= -90 ? 0 : lin(Math.min(12, db)));
function envFilters(env) {
  if (!Array.isArray(env)) return [];
  const pts = env.map(([t, db]) => [Math.max(0, +t), +db]).filter(([t, db]) => Number.isFinite(t) && Number.isFinite(db)).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return [];
  const out = [];
  const g = pts.map(p => envGain(p[1]));
  const gs = v => v.toFixed(6);
  const first = pts[0][0], last = pts[pts.length - 1][0];
  if (Math.abs(g[0] - 1) > 1e-6 && first > 0) out.push(`volume=volume=${gs(g[0])}:enable='lt(t,${f(first)})'`);
  for (let i = 0; i < pts.length - 1; i++) {
    const [a] = pts[i], [b] = pts[i + 1];
    if (b - a < 1e-4) continue;
    const ga = g[i], gb = g[i + 1];
    if (Math.abs(ga - 1) < 1e-6 && Math.abs(gb - 1) < 1e-6) continue;
    const en = `enable='gte(t,${f(a)})*lt(t,${f(b)})'`;
    if (Math.abs(ga - gb) < 1e-6) out.push(`volume=volume=${gs(ga)}:${en}`);
    else out.push(`volume=volume='${gs(ga)}+(${gs(gb - ga)})*(t-${f(a)})/${f(b - a)}':eval=frame:${en}`);
  }
  if (Math.abs(g[g.length - 1] - 1) > 1e-6) out.push(`volume=volume=${gs(g[g.length - 1])}:enable='gte(t,${f(last)})'`);
  // Kleine Audio-Blöcke (5 ms), damit Rampen fein aufgelöst werden
  return out.length ? ['asetnsamples=n=240:p=0', ...out] : [];
}

// Baut den Filtergraphen für eine Liste von Eingaben.
// inputs: [{offset (s, Session-Zeit), gainDb, mutes:[[a,b]]}], Zeitachse = Session-Zeit.
function buildGraph(inputs, { cuts, totalDur, fadeIn, fadeOut, loudnorm, channels, limiter }) {
  const lines = [];
  const layout = channels === 1 ? 'mono' : 'stereo';
  inputs.forEach((inp, i) => {
    const ch = [`aformat=sample_rates=48000:channel_layouts=${layout}`, ...fxFilters(inp.fx)];
    if (inp.offset > 0.0005) ch.push(`adelay=delays=${Math.round(inp.offset * 1000)}:all=1`);
    else if (inp.offset < -0.0005) ch.push(`atrim=start=${f(-inp.offset)}`, 'asetpts=PTS-STARTPTS');
    const mutes = mergeRanges(inp.mutes);
    if (mutes.length) {
      const expr = mutes.map(([a, b]) => `between(t,${f(a)},${f(b)})`).join('+');
      ch.push(`volume=volume=0:enable='${expr}'`);
    }
    ch.push(...envFilters(inp.env));
    if (inp.gainDb) ch.push(`volume=${inp.gainDb.toFixed(2)}dB`);
    ch.push(`apad=whole_dur=${f(totalDur)}`, `atrim=end=${f(totalDur)}`);
    lines.push(`[${i}:a]${ch.join(',')}[t${i}]`);
  });
  let cur;
  if (inputs.length > 1) {
    lines.push(`${inputs.map((_, i) => `[t${i}]`).join('')}amix=inputs=${inputs.length}:duration=longest:normalize=0[mix]`);
    cur = 'mix';
  } else cur = 't0';

  // Schnitte: behaltene Segmente mit 10 ms Mini-Blenden aneinanderhängen (keine Knackser).
  const merged = mergeRanges(cuts).filter(([a]) => a < totalDur);
  let editedDur = totalDur;
  if (merged.length) {
    const keep = [];
    let pos = 0;
    for (const [a, b] of merged) {
      if (a > pos + 0.01) keep.push([pos, Math.min(a, totalDur)]);
      pos = Math.max(pos, b);
    }
    if (pos < totalDur - 0.01) keep.push([pos, totalDur]);
    editedDur = keep.reduce((s, [a, b]) => s + (b - a), 0);
    if (keep.length === 0) throw new Error('Alles wurde herausgeschnitten.');
    const labels = keep.map((_, k) => `[k${k}]`);
    lines.push(`[${cur}]asplit=${keep.length}${labels.join('')}`);
    keep.forEach(([a, b], k) => {
      const len = b - a;
      const fd = Math.min(0.01, len / 4);
      lines.push(`[k${k}]atrim=start=${f(a)}:end=${f(b)},asetpts=PTS-STARTPTS,afade=t=in:d=${f(fd)},afade=t=out:st=${f(len - fd)}:d=${f(fd)}[s${k}]`);
    });
    lines.push(`${keep.map((_, k) => `[s${k}]`).join('')}concat=n=${keep.length}:v=0:a=1[cut]`);
    cur = 'cut';
  }

  const post = [];
  if (fadeIn > 0) post.push(`afade=t=in:d=${f(fadeIn)}`);
  if (fadeOut > 0 && editedDur > fadeOut) post.push(`afade=t=out:st=${f(editedDur - fadeOut)}:d=${f(fadeOut)}`);
  if (loudnorm) post.push(`loudnorm=I=${loudnorm}:TP=-1.5:LRA=11`, 'aresample=48000');
  if (limiter && limiter.on) {
    post.push(`alimiter=limit=${Math.max(0.0625, lin(num(limiter.ceiling, -12, 0, -1))).toFixed(5)}:attack=5:release=${num(limiter.release, 10, 500, 50)}:level=0`);
  }
  if (!post.length) post.push('anull');
  lines.push(`[${cur}]${post.join(',')}[out]`);
  return { graph: lines.join(';\n'), editedDur };
}

async function renderFile({ files, inputs, opts, outFile, workDir, onProgress }) {
  const { graph, editedDur } = buildGraph(inputs, opts);
  const script = path.join(workDir, `graph-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(script, graph);
  const args = ['-y', '-v', 'error', '-threads', FFMPEG_THREADS];
  for (const fl of files) args.push('-i', fl);
  args.push('-filter_complex_script', script, '-map', '[out]',
    '-ac', String(opts.channels), '-c:a', 'libmp3lame', '-b:a', `${opts.bitrate}k`,
    '-id3v2_version', '3');
  if (opts.title) args.push('-metadata', `title=${opts.title}`);
  args.push('-progress', 'pipe:1', '-nostats', outFile);
  let buf = '';
  try {
    await run('ffmpeg', args, {
      onStdout: d => {
        buf += d;
        const m = buf.match(/out_time_us=(\d+)/g);
        if (m) {
          const us = parseInt(m[m.length - 1].split('=')[1], 10);
          onProgress && onProgress(Math.min(1, us / 1e6 / Math.max(1, editedDur)));
          buf = buf.slice(-200);
        }
      },
    });
  } finally {
    fs.rmSync(script, { force: true });
  }
  return editedDur;
}

// ================= Version 2: Spuren mit Clips =================
// Ein-/Ausblenden eines Clips: mindestens 5 ms gegen Knackser, sonst die eingestellten Fades (Viertelsinus)
function clipFades(c, fd) {
  let fi = Math.max(0, +c.fadeIn || 0), fo = Math.max(0, +c.fadeOut || 0);
  if (fi + fo > c.len) { const k = c.len / (fi + fo); fi *= k; fo *= k; }
  const fin = fi > fd ? `afade=t=in:d=${f(fi)}:curve=qsin` : `afade=t=in:d=${f(fd)}`;
  const fout = fo > fd ? `afade=t=out:st=${f(c.len - fo)}:d=${f(fo)}:curve=qsin` : `afade=t=out:st=${f(c.len - fd)}:d=${f(fd)}`;
  return fin + ',' + fout;
}

// lanes: [{ clips: [{ input, in, len, start }], fx, env, mutes, gainDb }]
// Jede Spur wird aus ihren Clips (plus Stille dazwischen) zusammengesetzt, dann laufen Effekte,
// Hüllkurve und Lautstärke der Spur – danach werden alle Spuren gemischt.
function buildGraphV2(lanes, { totalDur, fadeIn = 0, fadeOut = 0, loudnorm = 0, channels = 1, limiter = null, measure = false, raw = false }) {
  const lines = [];
  const layout = channels === 1 ? 'mono' : 'stereo';
  const zero = channels === 1 ? '0' : '0|0';
  // Wie oft wird jede Eingangsdatei benutzt? → asplit
  const uses = new Map();
  lanes.forEach(l => l.clips.forEach(c => uses.set(c.input, (uses.get(c.input) || 0) + 1)));
  const next = new Map();
  for (const [i, n] of uses) {
    const outs = Array.from({ length: n }, (_, k) => `[s${i}_${k}]`).join('');
    lines.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=${layout}${n > 1 ? `,asplit=${n}` : ''}${outs}`);
    next.set(i, 0);
  }
  const laneLabels = [];
  lanes.forEach((lane, li) => {
    const clips = lane.clips.map(c => ({ ...c })).sort((a, b) => a.start - b.start);
    const segs = [];
    let pos = 0;
    clips.forEach((c, ci) => {
      const label = `[s${c.input}_${next.get(c.input)}]`;
      next.set(c.input, next.get(c.input) + 1);
      // Überlappung (sollte der Editor verhindern): späterer Clip gewinnt, früherer wird gekürzt → hier: Anfang kürzen
      if (c.start < pos) { const d = pos - c.start; c.in += d; c.len -= d; c.start = pos; }
      if (c.len <= 0.002) { lines.push(`${label}anullsink`); return; }
      if (c.start - pos > 0.0005) {
        lines.push(`aevalsrc=${zero}:c=${layout}:s=48000:d=${f(c.start - pos)}[g${li}_${ci}]`);
        segs.push(`[g${li}_${ci}]`);
      }
      const fd = Math.min(0.005, c.len / 4);
      lines.push(`${label}atrim=start=${f(c.in)}:end=${f(c.in + c.len)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=${layout},` +
        `apad=whole_dur=${f(c.len)},atrim=end=${f(c.len)},${clipFades(c, fd)}` +
        (c.gainDb ? (c.gainDb <= -60 ? ',volume=0' : `,volume=${c.gainDb.toFixed(2)}dB`) : '') +
        // Zeitstempel aus der Sampleanzahl neu setzen: sonst bricht concat ab, wenn ein Clip genau am Dateiende endet
        `,asetpts=N/SR/TB[c${li}_${ci}]`);
      segs.push(`[c${li}_${ci}]`);
      pos = c.start + c.len;
    });
    if (!segs.length) return;
    const raw = `r${li}`;
    lines.push(segs.length > 1 ? `${segs.join('')}concat=n=${segs.length}:v=0:a=1[${raw}]` : `${segs[0]}anull[${raw}]`);
    const ch = [...fxFilters(lane.fx)];
    const mutes = mergeRanges(lane.mutes);
    if (mutes.length) ch.push(`volume=volume=0:enable='${mutes.map(([a, b]) => `between(t,${f(a)},${f(b)})`).join('+')}'`);
    ch.push(...envFilters(lane.env));
    if (lane.gainDb) ch.push(`volume=${(+lane.gainDb).toFixed(2)}dB`);
    ch.push(`apad=whole_dur=${f(totalDur)}`, `atrim=end=${f(totalDur)}`);
    lines.push(`[${raw}]${ch.join(',')}[t${li}]`);
    laneLabels.push(`[t${li}]`);
  });
  if (!laneLabels.length) throw new Error('Keine Spuren mit Audio vorhanden.');
  let cur;
  if (laneLabels.length > 1) { lines.push(`${laneLabels.join('')}amix=inputs=${laneLabels.length}:duration=longest:normalize=0[mix]`); cur = 'mix'; }
  else cur = laneLabels[0].slice(1, -1);
  lines.push(`[${cur}]${postFilters({ totalDur, fadeIn, fadeOut, loudnorm, limiter, measure, raw }).join(',')}[out]`);
  return { graph: lines.join(';\n'), editedDur: totalDur };
}

// Summenbearbeitung: Blenden, Lautheit, Limiter (raw = nichts, für Zwischendateien je Spur)
function postFilters({ totalDur, fadeIn = 0, fadeOut = 0, loudnorm = 0, limiter = null, measure = false, raw = false }) {
  const post = [];
  if (raw) return ['anull'];
  if (!measure) {
    if (fadeIn > 0) post.push(`afade=t=in:d=${f(fadeIn)}`);
    if (fadeOut > 0 && totalDur > fadeOut) post.push(`afade=t=out:st=${f(totalDur - fadeOut)}:d=${f(fadeOut)}`);
    if (loudnorm) post.push(`loudnorm=I=${loudnorm}:TP=-1.5:LRA=11`, 'aresample=48000');
    if (limiter && limiter.on) post.push(`alimiter=limit=${Math.max(0.0625, lin(num(limiter.ceiling, -12, 0, -1))).toFixed(5)}:attack=5:release=${num(limiter.release, 10, 500, 50)}:level=0`);
  } else post.push('ebur128=peak=sample:framelog=quiet');
  if (!post.length) post.push('anull');
  return post;
}

// Zweite Stufe: fertig bearbeitete Spuren (Zwischendateien) mischen + Summenbearbeitung
function buildMixGraph(n, opts) {
  const layout = opts.channels === 2 ? 'stereo' : 'mono';
  const ins = Array.from({ length: n }, (_, i) => `[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=${layout}[i${i}]`);
  const mix = n > 1 ? `${ins.map((_, i) => `[i${i}]`).join('')}amix=inputs=${n}:duration=longest:normalize=0[mix]` : '[i0]anull[mix]';
  return [...ins, mix, `[mix]${postFilters(opts).join(',')}[out]`].join(';\n');
}

async function renderGraph({ files, graph, dur, opts, outFile, workDir, onProgress, wav = false, threads = FFMPEG_THREADS, job = null }) {
  const script = path.join(workDir, `graph-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(script, graph);
  const args = ['-y', '-v', 'error', '-threads', String(threads), '-filter_complex_threads', '1'];
  for (const fl of files) args.push('-i', fl);
  args.push('-filter_complex_script', script, '-map', '[out]', '-ac', String(opts.channels));
  if (wav) args.push('-c:a', 'pcm_f32le', '-rf64', 'auto', '-f', 'wav');
  else args.push('-c:a', 'libmp3lame', '-b:a', `${opts.bitrate}k`, '-id3v2_version', '3');
  if (!wav && opts.title) args.push('-metadata', `title=${opts.title}`);
  args.push('-progress', 'pipe:1', '-nostats', outFile);
  let buf = '';
  try {
    await run('ffmpeg', args, {
      job,
      onStdout: d => {
        buf += d;
        const m = buf.match(/out_time_us=(\d+)/g);
        if (m) { onProgress && onProgress(Math.min(1, parseInt(m[m.length - 1].split('=')[1], 10) / 1e6 / Math.max(1, dur))); buf = buf.slice(-200); }
      },
    });
  } catch (e) {
    if (process.env.DEBUG_FFMPEG) { fs.copyFileSync(script, '/tmp/failed-graph.txt'); fs.writeFileSync('/tmp/failed-files.json', JSON.stringify(files)); }
    throw e;
  } finally { fs.rmSync(script, { force: true }); }
  return dur;
}

async function analyzeLaneV2({ files, lane, totalDur, workDir, onProgress, threads = FFMPEG_THREADS }) {
  const { graph } = buildGraphV2([{ ...lane, gainDb: 0 }], { totalDur, measure: true });
  const script = path.join(workDir, `analyze-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(script, graph);
  let err = '', buf = '';
  const args = ['-hide_banner', '-nostats', '-threads', String(threads)];
  for (const fl of files) args.push('-i', fl);
  args.push('-filter_complex_script', script, '-map', '[out]', '-progress', 'pipe:1', '-f', 'null', '-');
  try {
    await run('ffmpeg', args, {
      onStderr: d => { err += d; if (err.length > 60000) err = err.slice(-20000); },
      onStdout: d => {
        buf += d;
        const m = buf.match(/out_time_us=(\d+)/g);
        if (m) { onProgress && onProgress(Math.min(1, parseInt(m[m.length - 1].split('=')[1], 10) / 1e6 / Math.max(1, totalDur))); buf = buf.slice(-200); }
      },
    });
  } finally { fs.rmSync(script, { force: true }); }
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const I = parseFloat((summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/) || [])[1]);
  const peak = parseFloat((summary.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) || [])[1]);
  return { lufs: Number.isFinite(I) ? I : null, peak: Number.isFinite(peak) ? peak : null };
}

// Lautheit (LUFS, integriert nach EBU R128) und Spitzenpegel (dBFS) einer Spur messen –
// so, wie sie im Export klingt: mit Effekten, Hüllkurve, Stummschaltungen und Schnitten, aber ohne Lautstärkeregler.
async function analyzeTrack({ file, input, cuts, totalDur, workDir, onProgress }) {
  const { graph, editedDur } = buildGraph([{ ...input, gainDb: 0 }], { cuts, totalDur, fadeIn: 0, fadeOut: 0, loudnorm: 0, channels: 1, limiter: null });
  const script = path.join(workDir, `analyze-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(script, graph + ';\n[out]ebur128=peak=sample:framelog=quiet[meas]');
  let err = '', buf = '';
  try {
    await run('ffmpeg', ['-hide_banner', '-nostats', '-threads', FFMPEG_THREADS, '-i', file, '-filter_complex_script', script,
      '-map', '[meas]', '-progress', 'pipe:1', '-f', 'null', '-'], {
      onStderr: d => { err += d; if (err.length > 60000) err = err.slice(-20000); },
      onStdout: d => {
        buf += d;
        const m = buf.match(/out_time_us=(\d+)/g);
        if (m) { onProgress && onProgress(Math.min(1, parseInt(m[m.length - 1].split('=')[1], 10) / 1e6 / Math.max(1, editedDur))); buf = buf.slice(-200); }
      },
    });
  } finally { fs.rmSync(script, { force: true }); }
  const summary = err.slice(err.lastIndexOf('Summary:'));
  const I = parseFloat((summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/) || [])[1]);
  const peak = parseFloat((summary.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) || [])[1]);
  return { lufs: Number.isFinite(I) ? I : null, peak: Number.isFinite(peak) ? peak : null };
}

// Führt fn für alle Einträge aus, höchstens n gleichzeitig. Bei einem Fehler werden keine neuen gestartet.
async function pool(items, n, fn, job = null) {
  let next = 0, failed = null;
  const worker = async () => {
    while (!failed && !job?.cancelled && next < items.length) {
      const k = next++;
      try { await fn(items[k], k); } catch (e) { failed = failed || e; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  if (failed) throw failed;
  if (job?.cancelled) throw Object.assign(new Error('Abgebrochen'), { cancelled: true });
}

module.exports = { EXPORT_WORKERS, CPU_COUNT, EXPORT_CPU, pool, buildMixGraph, buildGraphV2, renderGraph, analyzeLaneV2, analyzeTrack, probeDuration, computePeaks, buildGraph, renderFile, mergeRanges, fxFilters, envFilters, PEAKS_PER_SEC };

// ======================================================================================
// Schnelle Export-Pipeline (ab 2.10)
//  Stufe 1 je Spur: Clips (Aufnahmen per Sprung an die Stelle statt asplit über die ganze Datei) → Effekte
//           → rohe 32-Bit-Samples an Node; Hüllkurve, Stummstellen und Spurlautstärke rechnet Node
//           samplegenau (in ffmpeg war das mit 5-ms-Blöcken der teuerste Teil).
//  Stufe 2: Mix (amix + Blenden) mit Lautheitsmessung → feste Verstärkung + Limiter → MP3.
//           Statt loudnorm (dynamisch, verändert den Klang, rechnet intern mit 192 kHz) eine lineare Anpassung.
// ======================================================================================
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Clip-Fades wie im Editor/ffmpeg: kurze Anti-Knack-Blenden linear (tri), eingestellte Fades als Viertelsinus (qsin)
function clipFadeGains(c, fd) {
  let fi = Math.max(0, +c.fadeIn || 0), fo = Math.max(0, +c.fadeOut || 0);
  if (fi + fo > c.len) { const k = c.len / (fi + fo); fi *= k; fo *= k; }
  return { fi: fi > fd ? fi : fd, fiQ: fi > fd, fo: fo > fd ? fo : fd, foQ: fo > fd };
}
// Hüllkurve (linear in der Amplitude, wie im Editor), Stummstellen und Spurlautstärke – samplegenau
function makeGainProcessor({ env = [], mutes = [], gainDb = 0, channels = 1, rate = 48000 }) {
  const pts = (Array.isArray(env) ? env : []).map(([t, db]) => [Math.max(0, +t), +db])
    .filter(([t, db]) => Number.isFinite(t) && Number.isFinite(db)).sort((a, b) => a[0] - b[0]);
  const G = pts.map(p => envGain(p[1]));
  const M = mergeRanges(mutes || []);
  const lane = lin(+gainDb || 0);
  const flat = !pts.length || G.every(g => Math.abs(g - 1) < 1e-7);
  if (flat && !M.length && Math.abs(lane - 1) < 1e-7) return null; // nichts zu tun
  let si = 0, mi = 0;
  const gainAt = t => {
    let g = 1;
    if (!flat) {
      if (t <= pts[0][0]) g = G[0];
      else if (t >= pts[pts.length - 1][0]) g = G[G.length - 1];
      else {
        while (si < pts.length - 2 && t >= pts[si + 1][0]) si++;
        const [a] = pts[si], [b] = pts[si + 1];
        g = b - a < 1e-4 ? G[si + 1] : G[si] + (G[si + 1] - G[si]) * (t - a) / (b - a);
      }
    }
    while (mi < M.length && t >= M[mi][1]) mi++;
    if (mi < M.length && t >= M[mi][0]) g = 0;
    return g * lane;
  };
  return (buf, frame0) => { // buf: Float32Array (verschachtelt), frame0: Index des ersten Sample-Frames
    const n = buf.length / channels;
    for (let i = 0; i < n; i++) {
      const g = gainAt((frame0 + i) / rate);
      if (g === 1) continue;
      for (let c = 0; c < channels; c++) buf[i * channels + c] *= g;
    }
  };
}

function spawnFf(args, job) {
  const useNice = fs.existsSync('/usr/bin/nice') || fs.existsSync('/bin/nice');
  const p = useNice ? spawn('nice', ['-n', '10', 'ffmpeg', ...args]) : spawn('ffmpeg', args);
  if (job) { (job.procs = job.procs || new Set()).add(p); p.on('close', () => job.procs.delete(p)); }
  return p;
}
const ffDone = (p, job, errRef) => new Promise((resolve, reject) => {
  p.on('error', reject);
  p.on('close', code => (code === 0 ? resolve()
    : job?.cancelled ? reject(Object.assign(new Error('Abgebrochen'), { cancelled: true }))
    : reject(new Error(`ffmpeg exit ${code}: ${errRef.s.slice(-1500)}`))));
});

// Stufe 0: eine Quelldatei einmal komplett als rohe float32-Samples (48 kHz) dekodieren – danach ist jeder
// Schnitt ein exakter, schneller Lesezugriff
async function decodeSourceRaw({ file, channels, outFile, job }) {
  const p = spawnFf(['-v', 'error', '-threads', '1', '-i', file, '-vn', '-ac', String(channels), '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', '-y', outFile], job);
  const err = { s: '' };
  p.stderr.on('data', d => { err.s += d; if (err.s.length > 20000) err.s = err.s.slice(-10000); });
  await ffDone(p, job, err);
}

const DSP = require('../public/js/dsp-core.js');

// Planar <-> verschachtelt
const toPlanar = (buf, C, n) => { if (C === 1) return [buf]; const out = Array.from({ length: C }, () => new Float32Array(n)); for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) out[c][i] = buf[i * C + c]; return out; };
const fromPlanar = (chs, buf, C, n) => { if (C === 1) return; for (let i = 0; i < n; i++) for (let c = 0; c < C; c++) buf[i * C + c] = chs[c][i]; };
const writeAsync = (stream, buf) => new Promise(res => { const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength); if (stream.write(b)) res(); else stream.once('drain', res); });
const endAsync = stream => new Promise((res, rej) => { stream.once('error', rej); stream.end(res); });
const cancelErr = () => Object.assign(new Error('Abgebrochen'), { cancelled: true });

// Stufe 1: eine Spur → rohe float32-Datei. Clips samplegenau aus den Quelldateien (inkl. Clip-Fades und -Lautstärke),
// dann Effekte (dsp-core.js – exakt wie in der Editor-Vorschau), dann Hüllkurve/Stummstellen/Spurlautstärke.
async function renderLaneRaw({ lane, srcRaw, totalDur, channels, outFile, job, onProgress }) {
  if (job?.cancelled) throw cancelErr();
  const R = 48000, C = channels;
  const totalFrames = Math.max(1, Math.round(totalDur * R));
  const clips = lane.clips.map(c => ({ ...c })).sort((a, b) => a.start - b.start);
  let endT = 0;
  for (const c of clips) { if (c.start < endT) { const d = endT - c.start; c.in += d; c.len -= d; c.start = endT; } endT = Math.max(endT, c.start + c.len); }
  const segs = clips.filter(c => c.len > 0.002).map(c => {
    const s0 = Math.round(c.start * R), n = Math.round(c.len * R), src = srcRaw[c.input];
    const fg = clipFadeGains(c, Math.min(0.005, c.len / 4));
    return { s0, n, in0: Math.round(c.in * R), fd: src.fd, srcFrames: src.frames,
      g: c.gainDb ? (c.gainDb <= -60 ? 0 : lin(c.gainDb)) : 1,
      fiN: Math.max(1, Math.round(fg.fi * R)), fiQ: fg.fiQ, foN: Math.max(1, Math.round(fg.fo * R)), foQ: fg.foQ };
  }).filter(s => s.s0 < totalFrames);
  const chain = new DSP.FxChain(R, C);
  chain.set(lane.fx || null, !lane.fx);
  const L = chain.latency; // Verzögerung des Limiters → am Anfang verwerfen, am Ende nachschieben
  const post = makeGainProcessor({ env: lane.env, mutes: lane.mutes, gainDb: lane.gainDb, channels: C });
  const produceBlock = (f0, n) => {
    const buf = new Float32Array(n * C);
    for (const s of segs) {
      const a = Math.max(f0, s.s0), b = Math.min(f0 + n, s.s0 + s.n);
      if (a >= b) continue;
      const off = a - s.s0, srcA = s.in0 + off, cnt = Math.min(b - a, Math.max(0, s.srcFrames - srcA));
      if (cnt <= 0) continue;
      const tmp = Buffer.allocUnsafe(cnt * C * 4);
      fs.readSync(s.fd, tmp, 0, tmp.length, srcA * C * 4);
      const src = new Float32Array(tmp.buffer, tmp.byteOffset, cnt * C);
      for (let i = 0; i < cnt; i++) {
        const k = off + i;
        let g = s.g;
        if (k < s.fiN) { const x = k / s.fiN; g *= s.fiQ ? Math.sin(Math.PI / 2 * x) : x; }
        const r = s.n - k;
        if (r <= s.foN) { const x = Math.max(0, (r - 1) / s.foN); g *= s.foQ ? Math.sin(Math.PI / 2 * x) : x; }
        if (g === 0) continue;
        const o = (a - f0 + i) * C, q = i * C;
        for (let ch = 0; ch < C; ch++) buf[o + ch] = src[q + ch] * g;
      }
    }
    return buf;
  };
  const out = fs.createWriteStream(outFile);
  const BLOCK = R;
  let written = 0, skip = L, lastP = 0;
  for (let f0 = 0; f0 < totalFrames + L; f0 += BLOCK) {
    if (job?.cancelled) { out.destroy(); throw cancelErr(); }
    const n = Math.min(BLOCK, totalFrames + L - f0);
    const buf = new Float32Array(n * C);
    if (f0 < totalFrames) buf.set(produceBlock(f0, Math.min(n, totalFrames - f0)));
    const chs = toPlanar(buf, C, n);
    chain.process(chs, n);
    fromPlanar(chs, buf, C, n);
    // Limiter-Verzögerung ausgleichen: die ersten L Frames verwerfen
    let from = 0;
    if (skip > 0) { from = Math.min(skip, n); skip -= from; }
    const m = Math.min(n - from, totalFrames - written);
    if (m > 0) {
      const part = buf.subarray(from * C, (from + m) * C);
      if (post) post(part, written);
      await writeAsync(out, part);
      written += m;
    }
    if (onProgress && written - lastP > R * 10) { lastP = written; onProgress(written / totalFrames); }
    if ((f0 / BLOCK) % 20 === 19) await new Promise(r => setImmediate(r)); // Server bleibt ansprechbar
  }
  await endAsync(out);
  onProgress && onProgress(1);
}

// Stufe 2: Rohdateien mischen (+ Blenden), optional Lautheit messen und linear anpassen, Summen-Limiter
// (dsp-core.js, wie in der Vorschau) → ffmpeg kodiert nur noch die MP3.
async function renderFromRaw({ inputs, channels, totalDur, fadeIn = 0, fadeOut = 0, loudnorm = 0, limiter = null,
  bitrate = 128, title = '', outFile, workDir, job, onProgress }) {
  const R = 48000, C = channels, BLOCK = R;
  const totalFrames = Math.max(1, Math.round(totalDur * R));
  const fds = inputs.map(fl => fs.openSync(fl, 'r'));
  const fiN = Math.round(Math.max(0, fadeIn) * R), foN = fadeOut > 0 && totalDur > fadeOut ? Math.round(fadeOut * R) : 0;
  const rd = Buffer.allocUnsafe(BLOCK * C * 4);
  const readMix = (f0, n) => {
    const buf = new Float32Array(n * C);
    for (let k = 0; k < inputs.length; k++) {
      const got = fs.readSync(fds[k], rd, 0, n * C * 4, f0 * C * 4);
      const v = new Float32Array(rd.buffer, rd.byteOffset, Math.floor(got / 4));
      for (let i = 0; i < v.length; i++) buf[i] += v[i];
    }
    if (fiN || foN) for (let i = 0; i < n; i++) {
      const k = f0 + i;
      let g = 1;
      if (k < fiN) g *= k / fiN;
      if (foN && k >= totalFrames - foN) g *= Math.max(0, (totalFrames - k) / foN);
      if (g !== 1) for (let c = 0; c < C; c++) buf[i * C + c] *= g;
    }
    return buf;
  };
  const spawnIn = args => {
    const p = spawnFf(['-hide_banner', '-nostats', '-threads', '1', '-f', 'f32le', '-ar', String(R), '-ac', String(C), '-i', 'pipe:0', ...args], job);
    const err = { s: '' };
    p.stderr.on('data', d => { err.s += d; if (err.s.length > 60000) err.s = err.s.slice(-20000); });
    p.stdin.on('error', () => { /* wird über ffDone gemeldet */ });
    return { p, err, done: ffDone(p, job, err) };
  };
  let tmpMix = null, gainDb = 0;
  try {
    let source = readMix;
    if (loudnorm) {
      // Durchgang A: mischen und Lautheit messen (BS.1770, in diesem Thread) – ohne Zwischendatei
      const meter = new DSP.LoudnessMeter(C);
      for (let f0 = 0; f0 < totalFrames; f0 += BLOCK) {
        if (job?.cancelled) throw cancelErr();
        const n = Math.min(BLOCK, totalFrames - f0);
        meter.process(toPlanar(readMix(f0, n), C, n), n);
        if (onProgress && (f0 / BLOCK) % 10 === 0) onProgress(0.25 * f0 / totalFrames);
        if ((f0 / BLOCK) % 20 === 19) await new Promise(r => setImmediate(r));
      }
      const I = meter.integrated();
      gainDb = I != null && I > -70 ? Math.max(-30, Math.min(30, loudnorm - I)) : 0;
      const g = lin(gainDb);
      source = (f0, n) => { const v = readMix(f0, n); if (g !== 1) for (let i = 0; i < v.length; i++) v[i] *= g; return v; };
    }
    // Durchgang B: (Verstärkung) → Summen-Limiter → MP3
    let ceil = limiter && limiter.on ? num(limiter.ceiling, -30, 0, -1) : null;
    if (loudnorm) ceil = Math.min(ceil == null ? -1.5 : ceil, -1.5); // Spitzen höchstens −1,5 dB
    const lim = new DSP.Limiter(R, C);
    lim.set({ on: ceil != null, ceiling: ceil == null ? 0 : ceil, release: limiter?.release ?? 50 });
    const L = ceil != null ? lim.latency : 0;
    const args = ['-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-id3v2_version', '3'];
    if (title) args.push('-metadata', `title=${title}`);
    args.push('-y', outFile);
    const enc = spawnIn(args);
    const base = loudnorm ? 0.25 : 0, span = loudnorm ? 0.75 : 1;
    let skip = L, written = 0;
    for (let f0 = 0; f0 < totalFrames + L; f0 += BLOCK) {
      if (job?.cancelled) { enc.p.kill('SIGTERM'); throw cancelErr(); }
      const n = Math.min(BLOCK, totalFrames + L - f0);
      const buf = new Float32Array(n * C);
      if (f0 < totalFrames) buf.set(source(f0, Math.min(n, totalFrames - f0)));
      if (L) { const chs = toPlanar(buf, C, n); lim.process(chs, n); fromPlanar(chs, buf, C, n); }
      let from = 0;
      if (skip > 0) { from = Math.min(skip, n); skip -= from; }
      const m = Math.min(n - from, totalFrames - written);
      if (m > 0) { await writeAsync(enc.p.stdin, buf.subarray(from * C, (from + m) * C)); written += m; }
      if (onProgress && (f0 / BLOCK) % 10 === 0) onProgress(base + span * Math.min(1, f0 / totalFrames));
      if ((f0 / BLOCK) % 20 === 19) await new Promise(r => setImmediate(r));
    }
    enc.p.stdin.end();
    await enc.done;
  } finally {
    for (const fd of fds) { try { fs.closeSync(fd); } catch { /* egal */ } }
    if (tmpMix) fs.rmSync(tmpMix, { force: true });
  }
  onProgress && onProgress(1);
  return { gainDb };
}

// Lautheit und Spitze einer rohen Datei messen
async function measureRaw({ file, channels, job }) {
  const p = spawnFf(['-hide_banner', '-nostats', '-threads', '1', '-f', 'f32le', '-ar', '48000', '-ac', String(channels), '-i', file,
    '-af', 'ebur128=peak=sample:framelog=quiet', '-f', 'null', '-'], job);
  const err = { s: '' };
  p.stderr.on('data', d => { err.s += d; if (err.s.length > 60000) err.s = err.s.slice(-20000); });
  await ffDone(p, job, err);
  const summary = err.s.slice(err.s.lastIndexOf('Summary:'));
  const I = parseFloat((summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/) || [])[1]);
  const peak = parseFloat((summary.match(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) || [])[1]);
  return { lufs: Number.isFinite(I) ? I : null, peak: Number.isFinite(peak) ? peak : null };
}
module.exports.measureRaw = measureRaw;
module.exports.decodeSourceRaw = decodeSourceRaw;
module.exports.renderLaneRaw = renderLaneRaw;
module.exports.renderFromRaw = renderFromRaw;
module.exports.makeGainProcessor = makeGainProcessor;
