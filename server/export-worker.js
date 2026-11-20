// Rechen-Thread für den Export: Spur bearbeiten (Clips, Effekte, Hüllkurve) bzw. Mix/Limiter/Kodierung.
// Node rechnet JavaScript sonst auf einem einzigen Kern – so laufen mehrere Spuren wirklich parallel.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const audio = require('./audio');

const job = { cancelled: false, procs: new Set() };
parentPort.on('message', m => {
  if (m && m.cancel) {
    job.cancelled = true;
    for (const p of job.procs) { try { p.kill('SIGTERM'); } catch { /* schon beendet */ } }
  }
});

(async () => {
  const { kind, args } = workerData;
  const onProgress = p => parentPort.postMessage({ progress: p });
  try {
    let result = null;
    if (kind === 'lane') {
      const srcRaw = args.srcPaths.map(p => { const fd = fs.openSync(p, 'r'); return { fd, frames: fs.fstatSync(fd).size / (4 * args.channels) }; });
      try { await audio.renderLaneRaw({ ...args, srcRaw, job, onProgress }); }
      finally { for (const r of srcRaw) { try { fs.closeSync(r.fd); } catch { /* egal */ } } }
    } else if (kind === 'mix') {
      result = await audio.renderFromRaw({ ...args, job, onProgress });
    } else throw new Error('Unbekannte Aufgabe: ' + kind);
    parentPort.postMessage({ done: true, result });
  } catch (e) {
    parentPort.postMessage({ error: e.message, cancelled: !!(e.cancelled || job.cancelled) });
  }
})();
