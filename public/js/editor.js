// Mehrspur-Editor im Browser. Nicht-destruktiv: Schnitte, Stummschaltungen, Lautstärke und
// Versatz werden als Bearbeitungsliste gespeichert. Die Wiedergabe streamt die Original-MP3s,
// der fertige Mix wird beim Export einmalig per ffmpeg auf dem Server berechnet.
import { $, $$, esc, api, toast, fmtTime, fmtBytes, modal, confirmDialog, icon, clientId } from './common.js';
import { t as tr_, locale } from './i18n.js';
import { FX_SCHEMA, MASTER_SCHEMA, PRESETS, fullFx, fullMaster, applyPreset, fxActive, toSlider, fromSlider, fmtParam, webAudioAutoMakeupDb } from './fx.js';

const sid = location.pathname.split('/')[2];
const RULER = 30;
const ZMIN = 0.02, ZMAX = 400; // Zoomgrenzen in Pixel pro Sekunde
// Spurhöhe: auf schmalen Bildschirmen etwas höher, damit die Bedienelemente im Spurkopf Platz haben
let LANE = 96;
// Vertikaler Zoom: Spurhöhe frei einstellbar (pro Gerät gemerkt, Handy/Desktop getrennt)
const LANE_MIN = 40, LANE_MAX = 280;
const laneKey = () => 'ps_lane_' + (innerWidth <= 900 ? 'm' : 'd');
const laneDefault = () => (innerWidth <= 900 ? 120 : 96);
function updateLaneHeight() {
  let user = 0;
  try { user = +localStorage.getItem(laneKey()) || 0; } catch { /* egal */ }
  LANE = user ? Math.max(LANE_MIN, Math.min(LANE_MAX, user)) : laneDefault();
  document.documentElement.style.setProperty('--lane', LANE + 'px');
  // Spurköpfe: bei kleinen Höhen schrittweise Details ausblenden
  const m = innerWidth <= 900 ? 1.25 : 1;
  const root = document.documentElement.classList;
  root.toggle('lanes-s', LANE < 88 * m);
  root.toggle('lanes-xs', LANE < 68 * m);
  root.toggle('lanes-xxs', LANE < 52 * m);
}
updateLaneHeight();
const COLORS = ['#7c8cff', '#ff7a90', '#3ddc97', '#ffb547', '#4cc9f0', '#c77dff', '#f4a261'];

let session = null;
let edl = { cuts: [], tracks: {}, markers: [] };
let tracks = []; // Spuren: {id, name, color, players, gain, fxNodes}
let pps = 40; // Pixel pro Sekunde
let sel = null; // {a, b, lane} in bearbeiteter Zeit
let playhead = 0; // bearbeitete Zeit
let playing = false;
let actx = null;
const undoStack = [], redoStack = [];

const cv = $('#cv'), ctx2 = cv.getContext('2d');
const scroller = $('#scroller');

// ---------------- Zeitumrechnung (Ripple-Schnitt) ----------------
let merged = [];
function mergeCuts() {
  const r = edl.cuts.map(([a, b]) => [Math.max(0, a), b]).filter(([a, b]) => b - a > 0.005).sort((x, y) => x[0] - y[0]);
  merged = [];
  for (const c of r) {
    const last = merged[merged.length - 1];
    if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]); else merged.push([...c]);
  }
  edl.cuts = merged.map(c => [...c]);
}
function e2s(t) { let s = t; for (const [a, b] of merged) { if (a <= s) s += b - a; else break; } return s; }
function s2e(s) { let e = s; for (const [a, b] of merged) { if (b <= s) e -= b - a; else if (a < s) e -= s - a; } return e; }
const cutAt = s => merged.find(([a, b]) => s >= a && s < b);

const tEdl = id => (edl.tracks[id] = edl.tracks[id] || {});
const srcTotal = () => Math.max(1, ...(edl.clips || []).map(c => c.start + c.len));
const editTotal = () => srcTotal();
const anySolo = () => tracks.some(tr => tEdl(tr.t.id).solo);

// ---------------- Laden ----------------

let exportDir = null, exportDirError = '';
let userPresets = [];
async function init() {
  setupChrome();
  userPresets = await api('/api/presets').catch(() => []);
  api('/api/config').then(c => { exportDir = c.exportDir; exportDirError = c.exportDirError || ''; }).catch(() => {});
  session = await api(`/api/sessions/${sid}`);
  rev = session.rev || 0;
  edl = session.edl || { cuts: [], tracks: {} };
  edl.cuts = edl.cuts || []; edl.tracks = edl.tracks || {};
  if (!Array.isArray(edl.markers)) edl.markers = (session.markers || []).map(m => ({ t: m.t, label: m.label }));
  mergeCuts();
  $('#title').value = session.name;
  document.title = session.name + ' · Editor';
  await loadSources();
  const migrated = migrateToV2();
  const added = syncSources();
  await loadTracks();
  autoApplyPresets();
  if (migrated || added) save();
  if (migrated) setTimeout(() => toast('Bearbeitung auf Spuren mit Clips umgestellt – bisherige Schnitte sind erhalten.', { ms: 6000 }), 600);
  $('#loading').remove();
  setZoomFromSlider();
  // Start: dort weitermachen, wo zuletzt (auf irgendeinem Gerät) aufgehört wurde – sonst alles sichtbar
  const v = session.view;
  if (v && v.pps) {
    pps = Math.max(ZMIN, Math.min(ZMAX, v.pps));
    setSliderFromZoom();
    renderAll();
    playhead = Math.min(editTotal(), v.playhead || 0);
    scroller.scrollLeft = v.scrollLeft || 0;
    if (playhead > 0) setTimeout(() => toast(`Weiter bei ${fmtTime(playhead)}`), 400);
  } else fitAll();
  renderAll();
  renderExports();
  requestAnimationFrame(frame);
  setupSync();
  setupOverview();
  setupTrackMenu();
  setupNotes();
}

// Spuren (Lanes) aus der Bearbeitung aufbauen; Objekte mit Audio-Knoten bleiben erhalten
async function loadTracks() {
  if (!sources.size) await loadSources();
  buildLanes();
  renderHeads();
}

// ---------------- Oberfläche ----------------
function setupChrome() {
  $('#backBtn').innerHTML = icon.back;
  $('#undoBtn').innerHTML = icon.undo; $('#redoBtn').innerHTML = icon.redo;
  $('#addBtn span').outerHTML = icon.plus + '<span>Audio hinzufügen</span>';
  $('#exportBtn').innerHTML = icon.download + '<span>Exportieren</span>';
  $('#backSkip').innerHTML = icon.skipBack; $('#fwdSkip').innerHTML = icon.skipFwd;
  $('#splitBtn').innerHTML = icon.scissors + '<span>Teilen</span>';
  $('#cutBtn').innerHTML = icon.ripple + '<span>Ripple</span>';
  $('#cutAllBtn').innerHTML = icon.rippleAll + '<span>Ripple alle</span>';
  $('#delBtn').innerHTML = icon.trash + '<span>Lücke</span>';
  $('#groupBtn').innerHTML = '<b style="font-size:13px">⛓</b><span>Gruppieren</span>';
  $('#muteBtn').innerHTML = icon.volOff + '<span>Still</span>';
  $('#markBtn').innerHTML = icon.flag + '<span>Marker</span>';
  $('#bypassBtn').onclick = toggleBypass;
  $('#masterBtn').onclick = () => openFx('master');
  $('#normBtn').innerHTML = icon.norm + '<span>Normalisieren</span>';
  $('#normBtn').onclick = openNormalize;
  renderBypass();
  renderPlayBtn();

  $('#title').onchange = async () => {
    session.name = $('#title').value;
    const r = await api(`/api/sessions/${sid}`, { method: 'PATCH', body: { name: session.name, clientId: myClient } });
    if (r.rev === rev + 1) rev = r.rev; // nur eigene Änderung → kein Abgleich nötig
    toast('Name gespeichert');
  };
  $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
  $('#playBtn').onclick = togglePlay;
  $('#backSkip').onclick = () => seek(playhead - 5);
  $('#fwdSkip').onclick = () => seek(playhead + 5);
  $('#splitBtn').onclick = splitAtPlayhead;
  $('#keysBtn').onclick = showShortcuts;
  $('#vZoomIn').onclick = () => setLaneHeight(LANE * 1.25);
  $('#vZoomOut').onclick = () => setLaneHeight(LANE / 1.25);
  $('#vZoomIn').ondblclick = $('#vZoomOut').ondblclick = () => setLaneHeight(0);
  $('#mmBox').onclick = resetClipLeds;
  $('#poolBtn').innerHTML = icon.folder + '<span>Mediapool</span>';
  $('#poolBtn').onclick = () => (poolOpen ? closePool() : openPool());
  $('#keysLink') && ($('#keysLink').onclick = e => { e.preventDefault(); showShortcuts(); });
  setupToolbarFit();
  $('#cutBtn').onclick = () => deleteEdit('ripple');
  $('#cutAllBtn').onclick = () => deleteEdit('rippleAll');
  $('#delBtn').onclick = () => deleteEdit('gap');
  $('#groupBtn').onclick = () => (selClips.size >= 2 ? groupClips() : ungroupClips());
  $('#muteBtn').onclick = muteSelection;
  $('#markBtn').onclick = addMarker;
  $('#exportBtn').onclick = openExport;
  setTimeout(() => pollExport(true), 800);
  $('#addFile').onchange = uploadExtra;
  $('#zoom').oninput = () => { const center = playhead; setZoomFromSlider(); scrollTo(center); renderAll(); saveView(); };
  scroller.addEventListener('scroll', () => { draw(); updateBars(); });
  $('#tlWrap').addEventListener('scroll', updateBars);
  setupScrollbars();
  setupTouchGestures();
  setupSafariPinch();
  $('#zoomIn').onclick = () => zoomBy(1.5);
  $('#zoomOut').onclick = () => zoomBy(1 / 1.5);
  $('#fitBtn').onclick = () => { fitAll(); renderAll(); scroller.scrollLeft = 0; saveView(); };
  window.addEventListener('resize', () => { const old = LANE; updateLaneHeight(); if (old !== LANE) renderHeads(); renderAll(); });
  $('#listBtn').onclick = () => document.body.classList.toggle('show-list');
  $('.tl-area').addEventListener('wheel', onWheel, { passive: false });
  $('#ovrow').addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('pointerdown', onPointerDown);
  cv.addEventListener('pointermove', envHover);
  cv.addEventListener('dblclick', envDblClick);
  cv.addEventListener('contextmenu', envContext);
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', e => { if (saveTimer) { e.preventDefault(); e.returnValue = ''; } });
}

function setZoomFromSlider() {
  // 0..1000 → 0,02 … 400 px/s (logarithmisch) – reicht von mehreren Stunden bis zu einzelnen Silben
  const v = +$('#zoom').value / 1000;
  pps = ZMIN * Math.pow(ZMAX / ZMIN, v);
}
function setSliderFromZoom() { $('#zoom').value = Math.round((Math.log(pps / ZMIN) / Math.log(ZMAX / ZMIN)) * 1000); }
function fitAll() {
  const w = scroller.clientWidth - 20;
  pps = Math.max(ZMIN, Math.min(ZMAX, w / Math.max(1, editTotal())));
  setSliderFromZoom();
}
function scrollTo(t) { scroller.scrollLeft = Math.max(0, t * pps - scroller.clientWidth / 2); }

function renderHeads() {
  buildLanes();
  const heads = $('#heads');
  $$('.head', heads).forEach(h => h.remove());
  $('.ruler-sp', heads).innerHTML = `${tracks.length} Spuren <button class="addtrack" title="Neue leere Spur (oder Rechtsklick in diese Spalte)">+</button>`;
  $('.ruler-sp .addtrack', heads).onclick = () => newEmptyLane(null);
  for (const tr of tracks) {
    const e = tEdl(tr.id);
    const h = document.createElement('div');
    h.className = 'head';
    h.style.setProperty('--c', tr.color);
    h.dataset.tid = tr.id;
    const n = (clipIndex.get(tr.id) || []).length;
    const g = e.group && edl.groups?.[e.group];
    h.innerHTML = `
      <button class="cstrip" data-a="color" title="Spurfarbe ändern"></button>
      <div class="row" style="gap:6px"><div class="nm grow" title="${esc(tr.name)} – Doppelklick zum Umbenennen" translate="no">${esc(tr.name)}</div>
        <button class="ms fxb ${fxActive(e.fx) && !e.fxOff ? 'on' : ''} ${e.fxOff && fxActive(e.fx) ? 'byp' : ''}" data-a="fx" title="Effekte: Gate, EQ, Kompressor, Limiter">FX</button>
        <button class="ms env ${e.envShow ? 'on' : ''} ${(e.env || []).length ? 'has' : ''}" data-a="env" title="Lautstärke-Hüllkurve zeigen/bearbeiten (H)">H</button>
        <button class="ms m ${e.mute ? 'on' : ''}" data-a="m" title="Spur stumm">M</button>
        <button class="ms s ${e.solo ? 'on' : ''}" data-a="s" title="Solo (nur zum Abhören)">S</button>
      </div>
      <div class="ctl"><div class="gwrap"><canvas class="lvl" title="Pegel der Spur (nach Effekten und Lautstärke)"></canvas><input type="range" min="-24" max="24" step="0.5" value="${+e.gainDb || 0}" data-a="gain"></div><span class="db">${fmtDb(+e.gainDb || 0)}</span></div>
      <div class="ctl info"><span class="muted">${n ? n + (n === 1 ? ' Clip' : ' Clips') : 'leer – Clips hierher ziehen'}</span>
        ${g ? `<span class="gchip" style="--g:${esc(g.color || '#7c8cff')}" title="Spurgruppe: Schnitte und Verschieben wirken auf alle Spuren der Gruppe">⛓ <span translate="no">${esc(g.name)}</span></span>` : ''}</div>`;
    const gain = $('[data-a=gain]', h);
    let gainSnap = null;
    gain.onpointerdown = () => { gainSnap = JSON.stringify(edl); };
    gain.oninput = () => { $('.db', h).textContent = fmtDb(+gain.value); e.gainDb = +gain.value; draw(); };
    gain.onchange = () => { pushUndoSnapshot(gainSnap); e.gainDb = +gain.value; changed(false); };
    gain.ondblclick = () => { snapshot(); e.gainDb = 0; gain.value = 0; $('.db', h).textContent = fmtDb(0); changed(); };
    $('[data-a=m]', h).onclick = () => { snapshot(); e.mute = !e.mute; changed(); };
    $('[data-a=s]', h).onclick = () => { e.solo = !e.solo; changed(); };
    $('[data-a=fx]', h).onclick = () => openFx(tr.id);
    $('[data-a=env]', h).onclick = () => { e.envShow = !e.envShow; renderHeads(); draw(); save(); if (e.envShow) toast('Hüllkurve: Klick auf Linie = Punkt, Punkt ziehen, Doppelklick/Rechtsklick = löschen'); };
    $('[data-a=color]', h).onclick = ev => { const r = ev.target.getBoundingClientRect(); colorMenu(r.right + 6, r.top, tr); };
    $('.nm', h).ondblclick = () => renameTrack(tr);
    h.classList.toggle('selected', selTracks.has(tr.id));
    h.addEventListener('click', ev => { if (!ev.target.closest('button, input, a, select, label')) selectTrack(tr, ev); });
    heads.appendChild(h);
  }
}
const fmtDb = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';

// Leichte Variante beim Zoomen/Scrollen: nur Breite anpassen und zeichnen (Bearbeitungsliste bleibt)
function renderView() {
  const W = Math.max(scroller.clientWidth, Math.ceil((editTotal() + 30) * pps) + 200);
  $('#spacer').style.width = W + 'px';
  draw();
  updateBars();
}
function renderAll() {
  ovDirty = true;
  mergeCuts();
  buildLanes();
  const W = Math.max(scroller.clientWidth, Math.ceil((editTotal() + 30) * pps) + 200);
  $('#spacer').style.width = W + 'px';
  const H = RULER + LANE * Math.max(1, tracks.length);
  scroller.style.height = H + 'px';
  $('#spacer').style.height = H + 'px';
  renderEdits();
  updateSelUi();
  draw();
  updateBars();
}

// ---------------- Zeichnen ----------------
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = scroller.clientWidth, h = RULER + LANE * Math.max(1, tracks.length + (poolDropHint && poolDropHint.li == null ? 1 : 0));
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
  }
  const c = ctx2;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const x0 = Math.round(scroller.scrollLeft); // ganze Pixel → Wellenform wird beim Scrollen immer gleich abgetastet
  const t0 = x0 / pps;
  const xOf = t => t * pps - x0;
  const srcAt = new Float64Array(w + 1);
  for (let x = 0; x <= w; x++) srcAt[x] = t0 + x / pps;
  const solo = anySolo();
  const selLanes = selLaneSet();

  tracks.forEach((tr, i) => {
    const y = RULER + i * LANE;
    const e = tEdl(tr.id);
    c.fillStyle = i % 2 ? '#10131a' : '#0e1117';
    c.fillRect(0, y, w, LANE);
    c.fillStyle = '#232838';
    c.fillRect(0, y + LANE - 1, w, 1);
    const audible = !e.mute && (!solo || e.solo);
    const gain = Math.pow(10, (+e.gainDb || 0) / 20);
    const env = e.env || [];
    const col = audible ? tr.color : '#59607a';
    const top = y + 4, bot = y + LANE - 4, mid = (top + bot) / 2 + 6, amp = (bot - top) / 2 - 9;
    for (const cl of clipIndex.get(tr.id) || []) {
      const xa = xOf(cl.start), xb = xOf(cl.start + cl.len);
      if (xb < -2 || xa > w + 2) continue;
      const selected = selClips.has(cl.id);
      // Clip-Fläche
      c.fillStyle = col + (selected ? '40' : '22');
      roundRect(c, xa, top, Math.max(2, xb - xa), bot - top, 6); c.fill();
      // Wellenform
      const src = sources.get(cl.src);
      const cg = clipLin(cl);
      const hasFade = fadeLen(cl, 'in') > 0 || fadeLen(cl, 'out') > 0;
      if (src && src.peaks.length) {
        const pk = src.peaks, sp = src.pps;
        const ghost = col + '40';
        const xs = Math.max(0, Math.floor(xa)), xe = Math.min(w, Math.ceil(xb));
        c.fillStyle = col;
        for (let x = xs; x < xe; x++) {
          const t = srcAt[x];
          const st = cl.in + (t - cl.start);
          let ia = Math.max(0, Math.floor(st * sp)), ib = Math.min(pk.length, Math.ceil((st + 1 / pps) * sp));
          if (ib <= ia) ib = Math.min(pk.length, ia + 1);
          let m = 0;
          for (let k = ia; k < ib; k++) if (pk[k] > m) m = pk[k];
          const fg = hasFade ? clipFadeGain(cl, t) : 1;
          const base = Math.sqrt(m / 255) * gain * Math.sqrt(cg * fg);
          const eg = env.length ? envGainAt(env, t) : 1;
          if (eg < 0.999) { const hg = Math.max(1, Math.min(1, base) * amp); c.fillStyle = ghost; c.fillRect(x, mid - hg, 1, hg * 2); c.fillStyle = col; }
          const hh = Math.min(1, base * Math.sqrt(eg)) * amp;
          if (hh >= 0.5 || eg >= 0.999) c.fillRect(x, mid - Math.max(1, hh), 1, Math.max(1, hh) * 2);
        }
      }
      drawClipFades(c, cl, xa, xb, top, bot, w, selected);
      // Rahmen, Name, Gruppe
      c.lineWidth = selected ? 2 : 1;
      c.strokeStyle = selected ? '#ffffff' : col + 'aa';
      if (cl.group) c.setLineDash([5, 3]);
      roundRect(c, xa + 0.5, top + 0.5, Math.max(2, xb - xa - 1), bot - top - 1, 6); c.stroke();
      c.setLineDash([]);
      // Clip-Lautstärke: Linie ziehen = lauter/leiser
      if (xb - xa > 16) {
        const db = +cl.gainDb || 0;
        const gy = Math.round(clipGainY(db, top, bot)) + 0.5;
        const hot = gainHover === cl.id || gainDragId === cl.id;
        c.strokeStyle = db ? (hot ? '#bfe6ff' : '#7dd3fc') : (hot ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.22)');
        c.lineWidth = hot ? 2 : 1;
        c.beginPath(); c.moveTo(Math.max(xa + 2, -2), gy); c.lineTo(Math.min(xb - 2, w + 2), gy); c.stroke();
        if ((db || hot) && xb - xa > 70) {
          const txt = fmtClipDb(db);
          c.font = '600 10.5px ui-monospace, Menlo, monospace'; c.textBaseline = 'middle';
          const tw = c.measureText(txt).width + 10;
          const bx = Math.min(xb, w) - tw - 6, by = top + 2;
          if (bx > Math.max(xa, 0) + 4) {
            c.fillStyle = 'rgba(13,15,20,.85)'; roundRect(c, bx, by, tw, 14, 4); c.fill();
            c.fillStyle = db ? '#7dd3fc' : '#d6dbe8'; c.fillText(txt, bx + 5, by + 7.5);
          }
        }
      }
      if (xb - xa > 46) {
        c.save();
        c.beginPath(); c.rect(Math.max(xa, 0), top, Math.min(xb, w) - Math.max(xa, 0), 16); c.clip();
        c.font = '600 11px Inter, system-ui, sans-serif'; c.textBaseline = 'middle';
        c.fillStyle = selected ? '#fff' : '#d6dbe8';
        c.fillText((cl.group ? '⛓ ' : '') + (src ? src.t.name : tr_('fehlt')), Math.max(xa, 0) + 7, top + 9);
        c.restore();
      }
    }
    if (!audible) { c.fillStyle = 'rgba(13,15,20,.45)'; c.fillRect(0, y, w, LANE); }
    if (e.envShow || env.length) drawEnvelope(c, tr, e, y, w, srcAt, xOf);
  });

  // Bereichsauswahl
  if (sel && Math.abs(sel.b - sel.a) > 0.001) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    const xa = xOf(a), xb = xOf(b);
    c.fillStyle = 'rgba(124,140,255,.07)';
    c.fillRect(xa, RULER, Math.max(1, xb - xa), h - RULER);
    tracks.forEach((tr, i) => {
      if (!selLanes.has(tr.id)) return;
      c.fillStyle = 'rgba(124,140,255,.22)';
      c.fillRect(xa, RULER + i * LANE, Math.max(1, xb - xa), LANE);
    });
    c.fillStyle = 'rgba(124,140,255,.9)';
    c.fillRect(xa, RULER, 1, h - RULER); c.fillRect(xb, RULER, 1, h - RULER);
  }
  // Vorschau beim Ziehen aus dem Mediapool
  if (poolDropHint) {
    const { li, t: pt, len, name } = poolDropHint;
    const xa = xOf(pt), xb = xOf(pt + len);
    const yy = li == null ? RULER + tracks.length * LANE : RULER + li * LANE;
    c.fillStyle = 'rgba(124,140,255,.25)'; roundRect(c, xa, yy + 4, Math.max(4, xb - xa), LANE - 8, 6); c.fill();
    c.strokeStyle = '#7c8cff'; c.setLineDash([5, 3]); c.lineWidth = 1.5; roundRect(c, xa + .5, yy + 4.5, Math.max(4, xb - xa - 1), LANE - 9, 6); c.stroke(); c.setLineDash([]);
    c.font = '600 11px Inter, system-ui, sans-serif'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
    c.fillText((li == null ? tr_('Neue Spur:') + ' ' : '') + name, Math.max(xa, 0) + 8, yy + 14);
  }
  // Einrast-Linie beim Ziehen
  if (snapLine != null) { const xs = xOf(snapLine); c.fillStyle = '#ffd166'; c.fillRect(Math.round(xs), RULER, 1, h - RULER); }

  // Lineal
  c.fillStyle = '#141720'; c.fillRect(0, 0, w, RULER);
  c.fillStyle = '#2c3243'; c.fillRect(0, RULER - 1, w, 1);
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  const step = steps.find(s => s * pps >= 80) || 14400;
  c.font = '11px ui-monospace, Menlo, monospace';
  c.textBaseline = 'middle';
  for (let t = Math.floor(t0 / step) * step; t < t0 + w / pps + step; t += step) {
    const x = xOf(t);
    c.fillStyle = '#3a4157'; c.fillRect(Math.round(x), RULER - 9, 1, 8);
    c.fillStyle = '#8d95aa';
    c.fillText(step < 1 ? fmtTime(t, true) : fmtTime(t), x + 4, RULER / 2 - 1);
    for (let k = 1; k < 4; k++) { const xx = x + (step * pps * k) / 4; c.fillStyle = '#2c3243'; c.fillRect(Math.round(xx), RULER - 5, 1, 4); }
  }
  if (sel && sel.time && Math.abs(sel.b - sel.a) > 0.001) {
    const xa = xOf(Math.min(sel.a, sel.b)), xb = xOf(Math.max(sel.a, sel.b));
    c.fillStyle = 'rgba(124,140,255,.35)'; c.fillRect(xa, 0, Math.max(1, xb - xa), RULER - 1);
    c.fillStyle = '#9aa6ff'; c.fillRect(Math.round(xa), 0, 2, RULER); c.fillRect(Math.round(xb) - 1, 0, 2, RULER);
  }
  for (const m of edl.markers) {
    const x = xOf(m.t);
    if (x < -100 || x > w + 10) continue;
    c.fillStyle = '#ffb547';
    c.fillRect(Math.round(x), 2, 2, RULER - 4);
    c.fillRect(Math.round(x) + 2, 3, 8, 7);
    c.fillStyle = 'rgba(255,181,71,.25)';
    c.fillRect(Math.round(x), RULER, 1, h - RULER);
  }
  const xp = xOf(playhead);
  if (xp >= -2 && xp <= w + 2) {
    c.fillStyle = '#ffffff';
    c.fillRect(Math.round(xp), 0, 1.5, h);
    c.beginPath(); c.moveTo(xp - 6, 0); c.lineTo(xp + 7, 0); c.lineTo(xp + 0.5, 8); c.fill();
  }
  updateTime();
  drawOverview();
}

function updateTime() {
  $('#time').innerHTML = `${fmtTime(playhead, true)} <small>/ ${fmtTime(editTotal())}</small>`;
}

// ---------------- Maus / Tastatur ----------------
function posToTime(clientX) {
  const r = cv.getBoundingClientRect();
  return Math.max(0, Math.min(editTotal(), (clientX - r.left + scroller.scrollLeft) / pps));
}

function onPointerDown(ev) {
  if (ev.button !== 0) return;
  const r = cv.getBoundingClientRect();
  const y = ev.clientY - r.top, x = ev.clientX - r.left;
  const t = posToTime(ev.clientX);
  cv.setPointerCapture(ev.pointerId);
  if (y < RULER) {
    const hitMarker = edl.markers.find(m => Math.abs((m.t - t) * pps) < 6);
    if (ev.pointerType === 'touch') {
      const sx = ev.clientX, sl = scroller.scrollLeft;
      let moved = false;
      const tmove = e => { if (Math.abs(e.clientX - sx) > 6) moved = true; if (moved) scroller.scrollLeft = sl - (e.clientX - sx); };
      const tup = () => { cv.removeEventListener('pointermove', tmove); cv.removeEventListener('pointerup', tup); if (!moved) seek(hitMarker ? hitMarker.t : t); };
      cv.addEventListener('pointermove', tmove); cv.addEventListener('pointerup', tup);
      return;
    }
    // Ziehen = Zeitauswahl (wie Reaper), Klick = Abspielposition. Kanten einer Auswahl lassen sich verschieben.
    const startX = ev.clientX;
    let edge = null;
    if (sel && sel.time) {
      const xa = (Math.min(sel.a, sel.b)) * pps - scroller.scrollLeft, xb = Math.max(sel.a, sel.b) * pps - scroller.scrollLeft;
      if (Math.abs(x - xa) <= 6) edge = 'a'; else if (Math.abs(x - xb) <= 6) edge = 'b';
      if (edge) { const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b); sel.a = a; sel.b = b; }
    }
    let moved = false;
    const snapT = tt => { if (!ev.ctrlKey && !ev.metaKey) for (const c of [playhead, ...edl.markers.map(m => m.t), ...edl.clips.flatMap(c => [c.start, c.start + c.len])]) if (Math.abs((c - tt) * pps) < 6) return c; return tt; };
    const t0 = ev.shiftKey && sel && sel.time ? Math.min(sel.a, sel.b) : snapT(t);
    const move = e => {
      if (!moved && Math.abs(e.clientX - startX) < 4) return;
      moved = true;
      const tt = Math.max(0, snapT(posToTime(e.clientX)));
      if (edge) sel[edge] = tt;
      else { sel = { a: t0, b: tt, time: true }; selClips.clear(); }
      autoScroll(e.clientX);
      updateSelUi(); draw();
    };
    const up = () => {
      cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      if (!moved) {
        if (ev.shiftKey && sel && sel.time) { sel.b = t; updateSelUi(); draw(); return; }
        seek(hitMarker ? hitMarker.t : t);
        return;
      }
      const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
      if (b - a < 0.01) sel = null; else { sel.a = a; sel.b = b; if (!playing) seek(a, true); }
      updateSelUi(); draw();
    };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    return;
  }
  if (!tracks.length) return;
  const lane = Math.min(tracks.length - 1, Math.floor((y - RULER) / LANE));
  if (envPointerDown(ev, lane, x, y)) return;
  const hit = clipHit(lane, x, y);
  if (hit) return clipPointerDown(ev, hit, lane);
  // Leere Fläche: Bereich wählen (über mehrere Spuren ziehen möglich)
  const startX = ev.clientX;
  if (!ev.shiftKey) selClips.clear();
  if (ev.shiftKey && sel) { sel.b = t; }
  else sel = { a: t, b: t, l0: lane, l1: lane };
  let moved = false;
  const move = e => {
    if (Math.abs(e.clientX - startX) > 3) moved = true;
    if (!moved) return;
    sel.b = posToTime(e.clientX);
    sel.l1 = Math.max(0, Math.min(tracks.length - 1, Math.floor((e.clientY - cv.getBoundingClientRect().top - RULER) / LANE)));
    autoScroll(e.clientX);
    draw(); updateSelUi();
  };
  const up = () => {
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
    if (!moved && !ev.shiftKey) { sel = null; seek(t); }
    else if (sel) { const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b); sel.a = a; sel.b = b; if (!playing) seek(a, true); }
    updateSelUi(); draw();
  };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
}

function autoScroll(clientX) {
  const r = scroller.getBoundingClientRect();
  if (clientX > r.right - 30) scroller.scrollLeft += 20;
  else if (clientX < r.left + 30) scroller.scrollLeft -= 20;
}

// Mausrad/Trackpad irgendwo im Spurbereich (auch Spurköpfe, Lineal, leere Fläche, Scrollbalken, Übersicht):
//  Strg/Pinch = Zoom · waagerecht/Umschalt = Zeitachse · senkrecht = Spuren (oder Zeitachse, wenn alle Spuren passen)
function onWheel(e) {
  if (e.target.closest('.modal, .ctx, #fxPanel, #poolPanel')) return;
  e.preventDefault();
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.target.closest('#ovrow')) {
    // Alt/Option + Mausrad: Spurhöhe
    const d = e.deltaY || e.deltaX;
    setLaneHeight(LANE * Math.exp(-d * (Math.abs(d) < 30 ? 0.012 : 0.003)), e.clientY);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    zoomAt(pps * Math.exp(-e.deltaY * (Math.abs(e.deltaY) < 30 ? 0.01 : 0.0025)), e.target.closest('#heads') ? null : e.clientX);
    markManual();
    return;
  }
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? scroller.clientWidth : 1;
  let dx = e.deltaX * k, dy = e.deltaY * k;
  if (e.shiftKey && !dx) { dx = dy; dy = 0; }
  const wrap = $('#tlWrap');
  const vOverflow = wrap.scrollHeight > wrap.clientHeight + 4;
  const horizontalOnly = e.target.closest('#ovrow, #hbar');
  if (e.target.closest('#vbar')) { wrap.scrollTop += dy || dx; }
  else if (Math.abs(dy) > Math.abs(dx)) {
    if (vOverflow && !horizontalOnly) wrap.scrollTop += dy; else scroller.scrollLeft += dy;
  } else scroller.scrollLeft += dx;
  markManual();
}
// Wer selbst scrollt, dem läuft die Ansicht beim Abspielen kurz nicht hinterher
let lastManual = 0;
const markManual = () => { lastManual = performance.now(); };

function onKey(e) {
  if (e.target.closest('input, textarea, select') && e.target.type !== 'range') return;
  const k = e.key, mod = e.ctrlKey || e.metaKey;
  if (mod && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && k.toLowerCase() === 'g') { e.preventDefault(); e.shiftKey ? ungroupClips() : groupClips(); return; }
  if (mod && k.toLowerCase() === 'a') { e.preventDefault(); selClips = new Set(edl.clips.map(c => c.id)); sel = null; updateSelUi(); draw(); return; }
  if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    if (mod || e.altKey) deleteEdit('gap'); else if (e.shiftKey) deleteEdit('rippleAll'); else deleteEdit('ripple');
    return;
  }
  if (k === '?' || (k === '/' && e.shiftKey)) { e.preventDefault(); showShortcuts(); return; }
  if (mod || e.altKey) return;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 's' || k === 'S') splitAtPlayhead();
  else if (k === 'm' || k === 'M') muteSelection();
  else if (k === 'k' || k === 'K') addMarker();
  else if (k === 'b' || k === 'B') toggleBypass();
  else if (k === 'h' || k === 'H') { const ids = [...selLaneSet()]; if (ids.length) { for (const id of ids) tEdl(id).envShow = !tEdl(id).envShow; renderHeads(); draw(); } }
  else if (k === 'Escape') { if (!sel && !selClips.size) { selTracks.clear(); markHeads(); } sel = null; selClips.clear(); updateSelUi(); draw(); }
  else if (k === 'ArrowLeft') { e.preventDefault(); seek(playhead - (e.shiftKey ? 1 : 5)); }
  else if (k === 'ArrowRight') { e.preventDefault(); seek(playhead + (e.shiftKey ? 1 : 5)); }
  else if (k === 'Home') seek(0);
  else if (k === 'End') seek(editTotal());
  else if (k === '+') zoomBy(1.5);
  else if (k === '-') zoomBy(1 / 1.5);
  else if (k === '0') { fitAll(); renderAll(); scroller.scrollLeft = 0; saveView(); }
}

function updateSelUi() {
  const range = sel && Math.abs(sel.b - sel.a) > 0.01;
  const clipsSel = selClips.size > 0;
  $('#cutBtn').disabled = !(range || clipsSel);
  $('#cutAllBtn').disabled = !(range || clipsSel);
  $('#delBtn').disabled = !(range || clipsSel);
  $('#muteBtn').disabled = !range;
  $('#splitBtn').disabled = !edl.clips?.some(c => c.start < playhead - 0.01 && c.start + c.len > playhead + 0.01);
  const grouped = clipsSel && [...selClips].some(id => clipById(id)?.group);
  $('#groupBtn').disabled = !(selClips.size >= 2 || grouped);
  $('#groupBtn').querySelector('span').textContent = selClips.size < 2 && grouped ? 'Gruppe lösen' : 'Gruppieren';
  const lanesTxt = () => { const n = selLaneSet().size; return n === 1 ? ' · Spur: ' + (tracks.find(t => selLaneSet().has(t.id))?.name || '') : sel.time && !selTracks.size ? ' · alle Spuren' : ` · ${n} Spuren`; };
  $('#selInfo').textContent = range
    ? `Auswahl ${fmtTime(Math.min(sel.a, sel.b), true)} – ${fmtTime(Math.max(sel.a, sel.b), true)} (${Math.abs(sel.b - sel.a).toFixed(1)} s)${lanesTxt()}`
    : clipsSel ? `${selClips.size} Clip${selClips.size > 1 ? 's' : ''} ausgewählt` : '';
}

// ---------------- Bearbeiten ----------------
function snapshot() { undoStack.push(JSON.stringify(edl)); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; }
function pushUndoSnapshot(s) { if (s) { undoStack.push(s); redoStack.length = 0; } }
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(edl)); edl = JSON.parse(undoStack.pop()); changed(true, true); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(edl)); edl = JSON.parse(redoStack.pop()); changed(true, true); }

function changed(rerenderHeads = true, fromHistory = false) {
  mergeCuts();
  if (rerenderHeads) renderHeads();
  playhead = Math.min(playhead, editTotal());
  renderAll();
  save();
  if (playing) resyncAll();
  applyAllFx();
  if (fxOpen) renderFxPanel();
  $('#undoBtn').disabled = !undoStack.length;
  $('#redoBtn').disabled = !redoStack.length;
}

function cutSelection() { deleteEdit('ripple'); }

// Auswahl in einer Spur per Hüllkurve stillstellen (mit kurzen Rampen, ohne Knackser)
// Auswahl in den gewählten Spuren per Hüllkurve stillstellen (mit kurzen Rampen, ohne Knackser)
function muteSelection() {
  if (!sel || Math.abs(sel.b - sel.a) < 0.01) return;
  const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
  const ids = [...selLaneSet()];
  if (!ids.length) return;
  snapshot();
  for (const id of ids) {
    const e = tEdl(id);
    const env = (e.env || []).map(p => [...p]);
    const R = ENV_RAMP;
    const dbA = envDbAt(env, a - R), dbB = envDbAt(env, b + R);
    const kept = env.filter(([t]) => t < a - R - 1e-6 || t > b + R + 1e-6);
    kept.push([Math.max(0, a - R), dbA], [a, ENV_SILENT], [b, ENV_SILENT], [b + R, dbB]);
    e.env = normEnv(kept);
    e.envShow = true;
  }
  sel = null;
  changed();
  toast(`${(b - a).toFixed(1)} s in ${ids.length === 1 ? '„' + tEdl(ids[0]).name + '“' : ids.length + ' Spuren'} stillgestellt`);
}

function mergeList(list) {
  const r = list.filter(([a, b]) => b - a > 0.005).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const c of r) { const l = out[out.length - 1]; if (l && c[0] <= l[1]) l[1] = Math.max(l[1], c[1]); else out.push([...c]); }
  return out;
}

async function restoreCut(cut) {
  if (!await confirmDialog(`Schnitt (${(cut[1] - cut[0]).toFixed(1)} s) wiederherstellen?`, { ok: 'Wiederherstellen' })) return;
  snapshot();
  edl.cuts = edl.cuts.filter(c => !(Math.abs(c[0] - cut[0]) < 1e-6 && Math.abs(c[1] - cut[1]) < 1e-6));
  changed(false);
}

function addMarker() {
  snapshot();
  edl.markers.push({ t: e2s(playhead), label: `Marker ${edl.markers.length + 1}` });
  edl.markers.sort((a, b) => a.t - b.t);
  changed(false);
}

function renderEdits() {
  const items = [];
  for (const tr of tracks) for (const r of silentRegions(tEdl(tr.id).env || [])) items.push({ kind: 'mute', at: r[0], m: r, tr });
  for (const mk of edl.markers) items.push({ kind: 'marker', at: mk.t, mk });
  items.sort((a, b) => a.at - b.at);
  const box = $('#edits');
  if (!items.length) { box.innerHTML = '<div class="muted" style="font-size:13px">Noch keine Stillstellungen oder Marker. Clips anklicken zum Auswählen, Leerfläche ziehen für einen Bereich.</div>'; return; }
  box.innerHTML = items.map((it, i) => {
    if (it.kind === 'mute') return `<div class="li" data-i="${i}"><span class="k" style="background:#2a2030;color:#ff8a96">${icon.volOff}</span><a class="t grow">Still in „${esc(it.tr.name)}“ ab ${fmtTime(it.at, true)}</a><span class="muted mono">${(it.m[1] - it.m[0]).toFixed(1)} s</span><button class="btn sm" data-a="undo">Aufheben</button></div>`;
    return `<div class="li" data-i="${i}"><span class="k" style="background:#3a2e14;color:#ffb547">${icon.flag}</span><a class="t grow"><span translate="no">${esc(it.mk.label)}</span> · ${fmtTime(it.at, true)}</a><button class="btn sm" data-a="ren">Umbenennen</button><button class="btn sm icon" data-a="undo" title="Entfernen">${icon.x}</button></div>`;
  }).join('');
  for (const el of $$('.li', box)) {
    const it = items[+el.dataset.i];
    $('a.t', el).onclick = () => { seek(it.at); scrollTo(it.at); draw(); };
    $('[data-a=undo]', el).onclick = () => {
      snapshot();
      if (it.kind === 'mute') { const e = tEdl(it.tr.id); e.env = removeSilentRegion(e.env, it.m); }
      else edl.markers = edl.markers.filter(m => m !== it.mk);
      changed(false);
    };
    const ren = $('[data-a=ren]', el);
    if (ren) ren.onclick = () => { const n = prompt('Name des Markers', it.mk.label); if (n) { snapshot(); it.mk.label = n.slice(0, 80); changed(false); } };
  }
}

// ---------------- Speichern ----------------
let saveTimer = null;
let rev = 0;          // Revision der Bearbeitungen, auf der dieses Gerät gerade arbeitet
let saving = null;    // laufender Speichervorgang
// Pro Browser-Tab eigene Kennung, damit ein zweiter Tab als „anderes Gerät“ zählt, dieser Tab aber nie
const myClient = (() => {
  let t = sessionStorage.getItem('ps_tab');
  if (!t) { t = Math.random().toString(36).slice(2, 7); sessionStorage.setItem('ps_tab', t); }
  return clientId() + '.' + t;
})();

function save() {
  $('#saveState').textContent = 'Ungespeichert';
  $('#saveState').className = 'badge warn';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 700);
}

// Sofort speichern (auch vor Export/Messung). force = andere Version bewusst überschreiben.
// Speichervorgänge laufen strikt nacheinander: Was während eines laufenden Speicherns dazukommt,
// wird zu genau einem Folge-Speichern zusammengefasst (sonst würden mehrere Anfragen mit derselben
// Basis-Revision parallel losgehen und sich gegenseitig als „anderes Gerät“ melden).
let saveQueued = null;
async function saveNow(force = false) {
  clearTimeout(saveTimer); saveTimer = null;
  if (saveQueued) { saveQueued.force = saveQueued.force || force; return saveQueued.promise; }
  if (saving) {
    const q = { force };
    q.promise = saving.catch(() => {}).then(() => new Promise(r => setTimeout(r, 0))).then(() => { saveQueued = null; return saveNow(q.force); });
    saveQueued = q;
    return q.promise;
  }
  $('#saveState').textContent = 'Speichert …';
  saving = (async () => {
    const send = async f => {
      // Zeitlimit: hängt die Verbindung, wird abgebrochen und neu versucht (statt ewig „Speichert …“)
      for (let attempt = 0; ; attempt++) {
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 15000);
        try {
          return await api(`/api/sessions/${sid}`, { method: 'PATCH', body: { edl, baseRev: rev, force: f, clientId: myClient }, signal: ctl.signal });
        } catch (e) {
          if (e.status || attempt >= 3) throw e; // Server hat geantwortet (z. B. 409) oder zu viele Versuche
          $('#saveState').textContent = 'Verbindung langsam – neuer Versuch …';
          await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          // Kam die abgebrochene Anfrage doch an, ist die Revision weiter → als eigene Speicherung erkennen
          f = f || false;
        } finally { clearTimeout(to); }
      }
    };
    try {
      let r;
      try { r = await send(force); }
      catch (e) {
        // „Konflikt“ mit einem Stand, den dieser Tab selbst gespeichert hat (z. B. Antwort unterwegs verloren) → einfach überschreiben
        if (e.status === 409 && e.data?.revBy === myClient) r = await send(true);
        else throw e;
      }
      rev = r.rev;
      session.edl = edl;
      if (!saveTimer && !saveQueued) { $('#saveState').textContent = 'Gespeichert ✓'; $('#saveState').className = 'badge ok'; }
    } catch (e) {
      if (e.status === 409) { $('#saveState').textContent = 'Konflikt'; $('#saveState').className = 'badge rec'; return 'conflict'; }
      $('#saveState').textContent = 'Speichern fehlgeschlagen';
      $('#saveState').className = 'badge rec';
      toast(e.message, { error: true });
      throw e;
    }
  })();
  let result;
  try { result = await saving; } finally { saving = null; }
  if (result === 'conflict') await resolveConflict(); // erst nach Ende des Speichervorgangs (sonst Verklemmung)
}

// ---------------- Abgleich zwischen Geräten ----------------
// Alle 3 s wird nur eine Zahl (Revision) abgefragt. Hat ein anderes Gerät gespeichert und hier gibt es
// keine ungespeicherten Änderungen, wird dessen Stand übernommen. Sonst entscheidest du im Dialog.
let conflictOpen = false;
function setupSync() {
  setInterval(async () => {
    if (document.hidden || conflictOpen || saving || saveQueued) return;
    const revBefore = rev;
    let r;
    try { r = await api(`/api/sessions/${sid}/rev`); } catch { return; }
    checkRemoteNotes(r);
    // Während der Abfrage selbst gespeichert? Dann ist die Antwort veraltet – nächste Runde prüfen.
    if (saving || saveQueued || conflictOpen || rev !== revBefore) return;
    if (r.rev <= rev) return;
    // Eigene Änderung (z. B. Upload aus diesem Tab): nur die Revision nachziehen, keine Meldung
    if (r.revBy === myClient) { if (!saveTimer) rev = r.rev; else saveNow(); return; }
    if (saveTimer) { saveNow(); return; } // eigene ungespeicherte Änderungen → Speichern löst ggf. den Konflikt-Dialog aus
    await adoptRemote(`Änderungen von einem anderen Gerät übernommen`);
  }, 3000);
  // Ansicht merken: beim Verlassen/Wechseln sofort, sonst kurz nach jeder Änderung
  const flush = () => { saveViewNow(true); flushNotes(true); };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  scroller.addEventListener('scroll', () => saveView());
}

async function adoptRemote(msg) {
  const s = await api(`/api/sessions/${sid}`);
  const remote = s.edl || { cuts: [], tracks: {} };
  remote.cuts = remote.cuts || []; remote.tracks = remote.tracks || {};
  if (!Array.isArray(remote.markers)) remote.markers = [];
  undoStack.push(JSON.stringify(edl)); redoStack.length = 0; // Übernahme lässt sich mit Strg+Z zurücknehmen
  const sourcesChanged = s.tracks.map(t => t.id + ':' + t.bytes).join() !== session.tracks.map(t => t.id + ':' + t.bytes).join();
  session = s;
  edl = remote;
  rev = s.rev || 0;
  $('#title').value = s.name; document.title = s.name + ' · Editor';
  mergeCuts();
  if (sourcesChanged) await loadSources();
  migrateToV2(); syncSources();
  await loadTracks(); tracks.forEach(wireTrack);
  selClips = new Set([...selClips].filter(id => clipById(id)));
  renderHeads(); renderAll(); applyAllFx(); renderExports();
  if (fxOpen) renderFxPanel();
  if (playing) resyncAll();
  $('#undoBtn').disabled = !undoStack.length;
  $('#saveState').textContent = 'Gespeichert ✓'; $('#saveState').className = 'badge ok';
  if (msg) toast(msg, { ms: 4000 });
}

async function resolveConflict() {
  if (conflictOpen) return;
  conflictOpen = true;
  const choice = await new Promise(resolve => {
    let picked = 'mine';
    const m = modal(`<h2>Gleichzeitig auf einem anderen Gerät geändert</h2>
      <p class="muted" style="margin-top:-6px">Diese Aufnahme wurde auf einem anderen Gerät bearbeitet, während du hier Änderungen gemacht hast. Welche Version soll gelten?</p>
      <div class="col" style="gap:10px;margin-top:14px">
        <button class="btn primary" data-c="mine">Meine Version behalten (andere überschreiben)</button>
        <button class="btn" data-c="theirs">Version vom anderen Gerät übernehmen</button>
        <div class="muted" style="font-size:12px">Bei „übernehmen“ kannst du deinen Stand danach mit Strg+Z zurückholen.</div>
      </div>`, { onClose: () => resolve(picked) });
    for (const b of $$('[data-c]', m)) b.onclick = () => { picked = b.dataset.c; m.close(); };
  });
  conflictOpen = false;
  if (choice === 'theirs') await adoptRemote('Version vom anderen Gerät übernommen');
  else { await saveNow(true); toast('Deine Version wurde gespeichert'); }
}

// Abspielposition, Zoom und Scrollposition pro Aufnahme auf dem Server merken
let viewTimer = null, lastView = '';
function saveView() { clearTimeout(viewTimer); viewTimer = setTimeout(() => saveViewNow(false), 1500); }
function saveViewNow(beacon) {
  clearTimeout(viewTimer);
  const v = { playhead: Math.round(playhead * 100) / 100, pps: Math.round(pps * 1000) / 1000, scrollLeft: Math.round(scroller.scrollLeft) };
  const key = JSON.stringify(v);
  if (key === lastView) return;
  lastView = key;
  const url = `/api/sessions/${sid}/view`;
  if (beacon && navigator.sendBeacon) navigator.sendBeacon(url, new Blob([key], { type: 'application/json' }));
  else fetch(url, { method: 'POST', body: key, headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', keepalive: true }).catch(() => {});
}

// ---------------- Wiedergabe ----------------
// Jede Spur ist ein <audio>-Element (streamt per HTTP-Range, braucht kaum Speicher).
// Eine Spur dient als Taktgeber, die anderen werden nachgeführt; Schnitte werden übersprungen.
let clock = { e: 0, perf: 0 };
let lastSeekAt = 0;

// Signalweg je Spur: Quelle → Gate → EQ (5 Bänder) → Kompressor → Lautstärke → Summe → Limiter
let master = null;
let fxBypass = false;
let audioReady = null;

function ensureAudio() {
  if (audioReady) { if (actx.state === 'suspended') actx.resume(); return audioReady; }
  actx = new AudioContext();
  audioReady = (async () => {
    let worklet = true;
    try { await actx.audioWorklet.addModule('/js/fx-worklet.js'); } catch (e) { worklet = false; console.warn('Effekt-Vorschau nicht verfügbar', e); }
    const input = actx.createGain();
    // Summen-Limiter: derselbe Code wie beim Export
    let comp;
    try {
      if (!worklet) throw new Error('kein Worklet');
      comp = new AudioWorkletNode(actx, 'ps-master-limiter', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    } catch { comp = actx.createGain(); }
    input.connect(comp).connect(actx.destination);
    // Summenanzeige: L/R hinter dem Limiter
    const split = actx.createChannelSplitter(2);
    const up = actx.createGain(); // Mono → Stereo hochmischen, damit L und R anzeigen
    up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
    const anL = actx.createAnalyser(), anR = actx.createAnalyser();
    anL.fftSize = anR.fftSize = 1024;
    comp.connect(up).connect(split); split.connect(anL, 0); split.connect(anR, 1);
    master = { input, comp, an: [anL, anR], limDb: 0 };
    if (comp.port) comp.port.onmessage = ev => { master.limDb = ev.data.lim; };
    applyMaster();
    for (const tr of tracks) wireTrack(tr);
  })();
  return audioReady;
}

function wireTrack(tr) {
  if (tr.gain || !actx || !master) return;
  const n = { gateDb: 0, compDb: 0, limDb: 0 };
  n.in = actx.createGain();
  n.in.channelCount = 1; n.in.channelCountMode = 'explicit'; n.in.channelInterpretation = 'speakers';
  // Gate → EQ → Kompressor → Limiter: derselbe Code wie beim Export (dsp-core.js)
  try {
    n.fx = new AudioWorkletNode(actx, 'ps-fx', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    n.fx.port.onmessage = ev => { n.gateDb = ev.data.gate; n.compDb = ev.data.comp; n.limDb = ev.data.lim; };
  } catch { n.fx = actx.createGain(); }
  n.env = actx.createGain();
  tr.gain = actx.createGain();
  n.in.connect(n.fx).connect(n.env).connect(tr.gain).connect(master.input);
  // Pegelanzeige der Spur: nach Lautstärke/Stumm (= was in die Summe geht)
  n.an = actx.createAnalyser();
  n.an.fftSize = 1024;
  tr.gain.connect(n.an);
  tr.fxNodes = n;
  for (const p of tr.players.values()) connectPlayer(tr, p);
  applyFx(tr);
}

const dbLin = db => Math.pow(10, db / 20);
function applyFx(tr) {
  const n = tr.fxNodes;
  if (!n || !n.fx.port) return;
  const te = tEdl(tr.t.id);
  n.fx.port.postMessage({ fx: fullFx(te.fx), off: !!(fxBypass || te.fxOff) });
}
function applyMaster() {
  if (!master || !master.comp.port) return;
  const l = fullMaster(edl.master).limiter;
  master.comp.port.postMessage({ ...l, on: !!(l.on && !fxBypass) });
}
function applyAllFx() { tracks.forEach(applyFx); applyMaster(); }

function togglePlay() { playing ? pause() : play(); }
async function play() {
  await ensureAudio();
  tracks.forEach(wireTrack);
  if (playhead >= editTotal() - 0.05) playhead = 0;
  if (sel && Math.abs(sel.b - sel.a) > 0.01 && (playhead < sel.a || playhead >= sel.b)) playhead = Math.min(sel.a, sel.b);
  playing = true;
  clock = { e: playhead, perf: performance.now() };
  resyncAll();
  renderPlayBtn();
}
function pause() {
  playing = false;
  for (const tr of tracks) { for (const p of tr.players.values()) p.el.pause(); tr.active = null; }
  renderPlayBtn();
  saveView();
}
function seek(t, keepScroll) {
  playhead = Math.max(0, Math.min(editTotal(), t));
  if (!playing) saveView();
  clock = { e: playhead, perf: performance.now() };
  if (playing) resyncAll();
  if (!keepScroll) {
    const x = playhead * pps - scroller.scrollLeft;
    if (x < 0 || x > scroller.clientWidth) scrollTo(playhead);
  }
  draw();
}
function renderPlayBtn() { $('#playBtn').innerHTML = playing ? icon.pause : icon.play; }

function resyncAll() {
  lastSeekAt = performance.now();
  for (const tr of tracks) syncLane(tr, playhead, true, performance.now());
}

function frame(now) {
  requestAnimationFrame(frame);
  updateFxMeters();
  updateLevelMeters(now);
  if (!playing) return;
  // Taktgeber: eine Spur, deren Clip gerade läuft – sonst Systemuhr
  const m = tracks.find(tr => tr.active && !tr.active.p.el.paused && !tr.active.p.el.seeking && tr.active.p.el.readyState >= 3);
  if (m && now - lastSeekAt > 250) {
    const c = m.active.clip;
    const t = c.start + (m.active.p.el.currentTime - c.in);
    if (t >= c.start - 0.05 && t <= c.start + c.len + 0.05) { playhead = t; clock = { e: playhead, perf: now }; }
    else playhead = clock.e + (now - clock.perf) / 1000;
  } else {
    playhead = clock.e + (now - clock.perf) / 1000;
  }
  if (playhead >= editTotal()) { pause(); playhead = editTotal(); draw(); return; }
  if (sel && Math.abs(sel.b - sel.a) > 0.01 && playhead >= Math.max(sel.a, sel.b) && playhead - Math.max(sel.a, sel.b) < 0.3) {
    pause(); playhead = Math.max(sel.a, sel.b); draw(); return;
  }
  const solo = anySolo();
  for (const tr of tracks) {
    const e = tEdl(tr.id);
    syncLane(tr, playhead, false, now, tr === m);
    if (tr.gain) {
      const muted = e.mute || (solo && !e.solo);
      tr.gain.gain.setTargetAtTime(muted ? 0 : Math.pow(10, (+e.gainDb || 0) / 20), actx.currentTime, 0.015);
    }
    if (tr.fxNodes) {
      const p = tr.fxNodes.env.gain, t = actx.currentTime, env = e.env || [];
      p.cancelScheduledValues(t);
      p.setValueAtTime(env.length ? envGainAt(env, playhead) : 1, t);
      p.linearRampToValueAtTime(env.length ? envGainAt(env, playhead + 0.04) : 1, t + 0.04);
    }
  }
  if (now - lastManual > 1500) {
    const half = scroller.clientWidth / 2;
    const x = playhead * pps - scroller.scrollLeft;
    if (x > half) scroller.scrollLeft = playhead * pps - half;
    else if (x < 0) scroller.scrollLeft = Math.max(0, playhead * pps - 40);
  }
  draw();
}

// ---------------- Zusätzliche Audiodatei ----------------
async function uploadExtra() {
  const files = [...$('#addFile').files];
  $('#addFile').value = '';
  for (const f of files) await uploadExtraFile(f);
}
async function uploadExtraFile(f, laneId = importLane) {
  if (!f) return;
  importLane = null;
  toast(`Lade „${f.name}“ hoch …`);
  try {
    const t = await api(`/api/sessions/${sid}/extra`, { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name), 'X-Client': myClient } });
    await addSourceClip(t, laneId, Math.max(0, playhead));
  } catch (e) { toast(e.message, { error: true }); }
}

// Neue Audiodatei des Projekts als Clip einsetzen (Spur vorgegeben, freie Zusatzspur oder neue Spur)
async function addSourceClip(t, laneId, start, { reuseFree = false } = {}) {
  rev += 1;
  session = await api(`/api/sessions/${sid}`);
  await loadSources();
  snapshot();
  edl.knownSources.push(t.id);
  const src = sources.get(t.id);
  const len = src ? src.dur : (t.duration || 1);
  let lid = laneId && edl.tracks[laneId] ? laneId : null;
  if (!lid && reuseFree) lid = freeExtraLane(start, len);
  if (!lid) lid = addLane({ name: t.name, kind: 'extra', gainDb: -6 });
  const clip = { id: newId('c'), lane: lid, src: t.id, start, in: 0, len };
  edl.clips.push(clip);
  resolveOverlaps([clip]);
  selClips = new Set([clip.id]);
  await loadTracks();
  tracks.forEach(wireTrack);
  changed();
  toast(`„${t.name}“ eingefügt bei ${fmtTime(start)} in „${edl.tracks[lid].name}“ – Clip lässt sich frei verschieben.`);
}
function freeExtraLane(start, len) {
  rebuildIndex();
  return edl.laneOrder.find(id => edl.tracks[id]?.kind === 'extra' &&
    !(clipIndex.get(id) || []).some(c => c.start < start + len - 0.01 && c.start + c.len > start + 0.01)) || null;
}

// ---------------- Export ----------------
const expPrefs = Object.assign({ bitrate: 128, channels: 1, loudnorm: -16, fadeIn: 0, fadeOut: 2, singleTracks: false, loudnormTracks: false },
  JSON.parse(localStorage.getItem('ps_export') || '{}'));
// Ab 2.11 heißt die Option „Rohfassung“ (umgekehrt) – eine alte Einstellung „Effekte anwenden: aus“ einmalig zurücksetzen
if (expPrefs.v !== 2) { expPrefs.applyFx = true; expPrefs.v = 2; localStorage.setItem('ps_export', JSON.stringify(expPrefs)); }

function openExport() {
  const m = modal(`<h2>Podcast exportieren</h2>
    <div class="col" style="gap:14px">
      <div class="row" style="gap:12px">
        <label class="field grow">MP3-Bitrate<select data-k="bitrate">${[64, 96, 128, 160, 192, 256, 320].map(b => `<option value="${b}" ${expPrefs.bitrate === b ? 'selected' : ''}>${b} kbit/s</option>`).join('')}</select></label>
        <label class="field grow">Kanäle<select data-k="channels"><option value="1" ${expPrefs.channels === 1 ? 'selected' : ''}>Mono (üblich für Sprache)</option><option value="2" ${expPrefs.channels === 2 ? 'selected' : ''}>Stereo</option></select></label>
      </div>
      <label class="field">Lautheit angleichen<select data-k="loudnorm">
        <option value="-16" ${expPrefs.loudnorm === -16 ? 'selected' : ''}>−16 LUFS (Podcast-Standard, Apple/Spotify)</option>
        <option value="-19" ${expPrefs.loudnorm === -19 ? 'selected' : ''}>−19 LUFS (Mono-Empfehlung)</option>
        <option value="-14" ${expPrefs.loudnorm === -14 ? 'selected' : ''}>−14 LUFS (lauter)</option>
        <option value="0" ${!expPrefs.loudnorm ? 'selected' : ''}>Aus</option></select></label>
      <div class="row" style="gap:12px">
        <label class="field grow">Einblenden (s)<input type="number" min="0" max="10" step="0.5" data-k="fadeIn" value="${expPrefs.fadeIn}"></label>
        <label class="field grow">Ausblenden (s)<input type="number" min="0" max="15" step="0.5" data-k="fadeOut" value="${expPrefs.fadeOut}"></label>
      </div>
      <label class="check"><span class="switch"><input type="checkbox" data-k="singleTracks" ${expPrefs.singleTracks ? 'checked' : ''}><span></span></span>Zusätzlich jede Spur einzeln exportieren (geschnitten & synchron, z. B. für Audacity/Reaper)</label>
      <label class="check"><span class="switch"><input type="checkbox" data-k="loudnormTracks" ${expPrefs.loudnormTracks ? 'checked' : ''}><span></span></span>Lautheit auch bei Einzelspuren angleichen</label>
      <label class="check"><span class="switch"><input type="checkbox" data-k="rawExport" ${expPrefs.applyFx === false ? 'checked' : ''}><span></span></span>Rohfassung: ohne Effekte und Summen-Limiter (nur Schnitte und Lautstärke – z. B. zum Weiterbearbeiten in Reaper)</label>
      ${exportDirError ? `<div class="hint" style="border-color:#7a2a35;color:#ffb3bd">⚠️ Exportordner nicht beschreibbar (${esc(exportDirError)}). Der Export wird nur in AppData gespeichert.</div>` : ''}
      ${exportDir ? `<div class="hint">📁 Wird gespeichert in <b>${esc(exportDir)}</b> (Unterordner je Aufnahme) und kann zusätzlich hier heruntergeladen werden.</div>` : ''}
      <div class="hint">Der Export klingt genau wie die Wiedergabe im Editor (gleiche Effekte, gleicher Summen-Limiter). Stummgeschaltete Spuren (M) werden weggelassen, Solo dient nur zum Abhören. Der Export läuft auf dem Server mit niedriger Priorität und nutzt mehrere Kerne parallel.</div>
      <div class="col hidden" data-prog style="gap:6px"><div class="row"><span data-step class="grow muted"></span><span data-pct class="mono"></span></div><div class="progress"><i></i></div></div>
      <div class="row" style="justify-content:flex-end;gap:8px"><button class="btn danger hidden" data-cancel>Abbrechen</button><button class="btn" data-x>Schließen</button><button class="btn primary" data-go>${icon.download}Export starten</button></div>
    </div>`);
  expModal = m;
  $('[data-x]', m).onclick = () => m.close();
  $('[data-cancel]', m).onclick = cancelExport;
  if (expJob?.state === 'running') showExportRunning(m);
  $('[data-go]', m).onclick = async () => {
    const v = k => $(`[data-k=${k}]`, m);
    Object.assign(expPrefs, {
      bitrate: +v('bitrate').value, channels: +v('channels').value, loudnorm: +v('loudnorm').value,
      fadeIn: +v('fadeIn').value || 0, fadeOut: +v('fadeOut').value || 0,
      singleTracks: v('singleTracks').checked, loudnormTracks: v('loudnormTracks').checked,
      applyFx: !v('rawExport').checked,
    });
    localStorage.setItem('ps_export', JSON.stringify(expPrefs));
    await saveNow();
    try { await api(`/api/sessions/${sid}/export`, { method: 'POST', body: { ...expPrefs, bypassFx: !expPrefs.applyFx } }); }
    catch (e) { toast(e.message, { error: true }); return; }
    expJob = { state: 'running', progress: 0, step: 'Vorbereiten …' };
    showExportRunning(m);
    pollExport();
  };
}
function showExportRunning(m) {
  $('[data-go]', m).disabled = true;
  $('[data-prog]', m).classList.remove('hidden');
  $('[data-cancel]', m).classList.remove('hidden');
  $('[data-x]', m).textContent = 'Im Hintergrund weiter';
  updateExportUi();
}
async function cancelExport() {
  if (!await confirmDialog('Export abbrechen? Bereits erzeugte Dateien dieses Exports werden verworfen.', { ok: 'Export abbrechen', cancel: 'Weiter exportieren', danger: true })) return;
  try { await api(`/api/sessions/${sid}/export`, { method: 'DELETE' }); } catch (e) { toast(e.message, { error: true }); return; }
  if (expJob) expJob.step = 'Wird abgebrochen …';
  updateExportUi();
  pollExport();
}
// Fortschritt im Dialog und – wenn er geschlossen ist – auf dem Exportieren-Knopf
let expModal = null, expJob = null, expTimer = null;
setInterval(() => { if (expJob?.state === 'running') updateExportUi(); }, 1000);
function updateExportUi() {
  const j = expJob;
  const running = j?.state === 'running';
  const pct = Math.round((j?.progress || 0) * 100);
  // Vergangene Zeit (vom Server) und geschätzte Restzeit
  const el = j?.elapsed != null ? (j.elapsed + (running && j.polledAt ? Date.now() - j.polledAt : 0)) / 1000 : null;
  const p = j?.progress || 0;
  const rest = running && el > 8 && p > 0.03 ? el * (1 - p) / p : null;
  const mmss = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const restTxt = rest == null ? '' : rest < 60 ? Math.max(5, Math.round(rest / 5) * 5) + ' s' : Math.ceil(rest / 60) + ' min';
  const timeTxt = el == null ? '' : running ? `${mmss(el)} vergangen${restTxt ? ` · noch ca. ${restTxt}` : ''}` : `Dauer ${mmss(el)}`;
  const btn = $('#exportBtn');
  btn.classList.toggle('busy', running);
  btn.style.setProperty('--p', pct + '%');
  btn.innerHTML = running ? icon.download + `<span>Export ${pct} %${restTxt ? ` · ~${restTxt}` : ''}</span>` : icon.download + '<span>Exportieren</span>';
  btn.title = running ? `${j.step || ''} · ${timeTxt} – klicken für Details oder zum Abbrechen` : 'Podcast exportieren';
  const m = expModal;
  if (m?.isConnected && j) {
    $('[data-step]', m).textContent = (j.step || '') + (timeTxt ? ` · ${timeTxt}` : '');
    $('[data-pct]', m).textContent = pct + ' %';
    $('.progress i', m).style.width = pct + '%';
    $('[data-cancel]', m).disabled = !!j.cancelled || j.step === 'Wird abgebrochen …';
  }
}


async function pollExport(initial = false) {
  clearTimeout(expTimer);
  const j = await api(`/api/sessions/${sid}/export`).catch(() => null);
  if (!j) { expTimer = setTimeout(pollExport, 2000); return; }
  if (initial && j.state !== 'running') return; // beim Laden: nur laufende Exporte anzeigen
  expJob = j; j.polledAt = Date.now();
  updateExportUi();
  const m = expModal?.isConnected ? expModal : null;
  if (j.state === 'running') { expTimer = setTimeout(pollExport, m ? 1000 : 2000); return; }
  const reset = () => { if (m) { $('[data-go]', m).disabled = false; $('[data-cancel]', m).classList.add('hidden'); $('[data-x]', m).textContent = 'Schließen'; $('[data-prog]', m).classList.add('hidden'); } };
  if (j.state === 'cancelled') { toast('Export abgebrochen.'); reset(); return; }
  if (j.state === 'error') { toast('Export fehlgeschlagen: ' + j.error, { error: true, ms: 10000 }); reset(); return; }
  if (j.state === 'done') {
    session = await api(`/api/sessions/${sid}`);
    renderExports();
    // Kein automatischer Download – die Dateien liegen im Exportordner bzw. unten rechts in der Liste
    const where = j.results?.find(r => r.hostPath)?.hostPath;
    const took = j.elapsed ? ` (Dauer ${Math.floor(j.elapsed / 60000)}:${String(Math.floor(j.elapsed / 1000) % 60).padStart(2, '0')})` : '';
    toast(where ? `Export fertig${took} – gespeichert in ${where.replace(/\/[^/]+$/, '')}` : `Export fertig${took} – unten rechts herunterladen.`, { ms: 8000 });
    if (m) m.close();
  }
}

function renderExports() {
  const list = session.exports || [];
  const box = $('#exports');
  if (!list.length) { box.innerHTML = '<div class="muted" style="font-size:13px">Noch nichts exportiert.</div>'; return; }
  box.innerHTML = list.map(x => `<div class="li"><span class="k" style="background:${x.kind === 'mix' ? '#1f2a52' : '#1c2a26'};color:${x.kind === 'mix' ? '#7c8cff' : '#3ddc97'}">${icon.wave}</span>
    <a class="t grow" href="/api/sessions/${sid}/files/${encodeURIComponent(x.name)}" title="${esc(x.hostPath ? 'Gespeichert unter ' + x.hostPath + ' – Klick lädt herunter' : 'Herunterladen')}">${x.hostPath ? '📁 ' : ''}<span translate="no">${esc(x.name)}</span></a>
    <span class="muted mono" style="font-size:12px">${fmtTime(x.duration)} · ${fmtBytes(x.size)}</span>
    <button class="btn sm icon danger" data-n="${esc(x.name)}" title="Löschen">${icon.trash}</button></div>`).join('');
  for (const b of $$('[data-n]', box)) b.onclick = async () => {
    await api(`/api/sessions/${sid}/files/${encodeURIComponent(b.dataset.n)}`, { method: 'DELETE' });
    session.exports = session.exports.filter(x => x.name !== b.dataset.n);
    renderExports();
  };
}

// Laufende Uploads: Spuren regelmäßig nachladen
setInterval(async () => {
  if (!session || $('#liveBadge').classList.contains('hidden') || playing) return;
  try {
    const s = await api(`/api/sessions/${sid}`);
    const changedBytes = s.tracks.some(t => t.bytes !== session.tracks.find(x => x.id === t.id)?.bytes) || s.tracks.length !== session.tracks.length;
    session = { ...s, edl: session.edl };
    if (changedBytes) {
      await loadSources();
      for (const tr of tracks) for (const [srcId, p] of tr.players) { const st = sources.get(srcId); if (st) p.el.src = `/api/sessions/${sid}/tracks/${srcId}/audio?v=${st.t.bytes}`; }
      if (syncSources()) save(); else save();
      await loadTracks(); renderAll();
    }
  } catch { /* egal */ }
}, 8000);

// ---------------- Effekt-Panel ----------------
let fxOpen = null; // Spur-ID oder 'master'
let fxSnap = null;

function toggleBypass() {
  fxBypass = !fxBypass;
  applyAllFx();
  renderBypass();
  toast(fxBypass ? 'Effekte umgangen (Original hören)' : 'Effekte aktiv');
}
function renderBypass() {
  const b = $('#bypassBtn');
  b.innerHTML = `${icon.wave}<span>${fxBypass ? 'FX aus' : 'FX an'}</span>`;
  b.classList.toggle('on', !fxBypass);
  b.title = 'Effekte im Vergleich ein/aus hören (B)';
}

function openFx(id) {
  fxOpen = id;
  $('#fxPanel').classList.remove('hidden');
  ensureAudio().then(() => tracks.forEach(wireTrack));
  renderFxPanel();
}
function closeFx() { fxOpen = null; $('#fxPanel').classList.add('hidden'); }
function hidePoolForFx() { if (poolOpen) closePool(); }

function renderFxPanel() {
  hidePoolForFx();
  const panel = $('#fxPanel');
  const isMaster = fxOpen === 'master';
  const tr = isMaster ? null : tracks.find(x => x.t.id === fxOpen);
  if (!isMaster && !tr) { closeFx(); return; }
  const schema = isMaster ? MASTER_SCHEMA : FX_SCHEMA;
  const values = isMaster ? fullMaster(edl.master) : fullFx(tEdl(tr.t.id).fx);
  const tabs = [`<button class="${isMaster ? 'active' : ''}" data-open="master">Summe</button>`]
    .concat(tracks.map(x => `<button class="${x === tr ? 'active' : ''}" data-open="${esc(x.t.id)}" style="--c:${x.color}" translate="no"><i></i>${esc(x.t.name)}</button>`)).join('');
  panel.innerHTML = `
    <div class="fx-head"><h3>${icon.wave}Effekte</h3><div class="grow"></div><button class="btn sm icon ghost" data-close title="Schließen">${icon.x}</button></div>
    <div class="fx-tabs">${tabs}</div>
    <div class="fx-body">
      ${isMaster ? '' : `<label class="check fx-power"><span class="switch"><input type="checkbox" data-power ${tEdl(tr.t.id).fxOff ? '' : 'checked'}><span></span></span><b>Effekte dieser Spur aktiv</b><span class="muted grow" style="text-align:right;font-size:12px">${esc(tr.t.name)}</span></label>`}
      ${isMaster ? '' : `<div class="row" style="gap:8px"><select data-preset class="grow"><option value="">Vorlage anwenden …</option>
          ${userPresets.length ? `<optgroup label="Meine Vorlagen">${userPresets.map(p => `<option value="u:${esc(p.id)}" translate="no">${esc(p.name)}${p.auto === 'all' ? ' (automatisch: alle)' : p.auto === 'name' ? ` (automatisch: ${esc(p.autoName)})` : ''}</option>`).join('')}</optgroup>` : ''}
          <optgroup label="Mitgeliefert">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</optgroup></select>
        <button class="btn sm" data-copy title="Diese Einstellungen auf alle Aufnahmespuren übertragen">Auf alle</button></div>
        <div class="row" style="gap:8px"><button class="btn sm grow" data-savepreset>${icon.plus}Als Vorlage speichern</button>
        <button class="btn sm" data-managepresets ${userPresets.length ? '' : 'disabled'}>Vorlagen verwalten</button></div>`}
      ${Object.entries(schema).map(([sec, def]) => `
        <section class="fx-sec ${values[sec].on ? '' : 'off'}" data-sec="${sec}">
          <div class="row"><label class="check grow"><span class="switch"><input type="checkbox" data-on ${values[sec].on ? 'checked' : ''}><span></span></span><b>${esc(def.title)}</b></label>
            ${sec === 'gate' || sec === 'comp' || sec === 'limiter' ? `<div class="gr" title="Aktuelle Absenkung"><i></i></div><span class="mono grv"></span>` : ''}</div>
          <div class="muted fx-desc">${esc(def.desc)}</div>
          ${sec === 'eq' ? '<canvas class="eqc" width="680" height="200"></canvas>' : ''}
          ${def.params.map(p => `<div class="fx-row"><span>${esc(p.label)}</span>
            <input type="range" data-k="${p.k}" min="${p.log ? 0 : p.min}" max="${p.log ? 1000 : p.max}" step="${p.log ? 1 : p.step}" value="${toSlider(p, values[sec][p.k])}">
            <span class="mono v">${fmtParam(p, values[sec][p.k])}</span></div>`).join('')}
        </section>`).join('')}
      <div class="hint">Die Effekte wirken sofort in der Vorschau (Taste <b>B</b> = mit/ohne vergleichen) und werden beim Export exakt mit ffmpeg berechnet. Die Original-Aufnahmen bleiben unverändert.</div>
    </div>`;
  $('[data-close]', panel).onclick = closeFx;
  panel.classList.toggle('fx-off', !isMaster && !!tEdl(tr.t.id).fxOff);
  const pw = $('[data-power]', panel);
  if (pw) pw.onchange = () => {
    snapshot();
    tEdl(tr.t.id).fxOff = !pw.checked;
    panel.classList.toggle('fx-off', !pw.checked);
    applyFx(tr); save(); renderHeads();
  };
  for (const b of $$('[data-open]', panel)) b.onclick = () => openFx(b.dataset.open);
  const target = () => {
    if (isMaster) { edl.master = fullMaster(edl.master); return edl.master; }
    const e = tEdl(tr.t.id); e.fx = fullFx(e.fx); return e.fx;
  };
  const commit = () => {
    if (fxSnap) { pushUndoSnapshot(fxSnap); fxSnap = null; }
    save();
    if (tr) { const btn = $(`[data-a=fx]`, $$('.head')[tracks.indexOf(tr)]); btn && btn.classList.toggle('on', fxActive(tEdl(tr.t.id).fx) && !tEdl(tr.t.id).fxOff); }
    $('#undoBtn').disabled = !undoStack.length;
  };
  const live = () => { isMaster ? applyMaster() : applyFx(tr); drawEq(); };
  for (const secEl of $$('.fx-sec', panel)) {
    const sec = secEl.dataset.sec;
    const def = schema[sec];
    $('[data-on]', secEl).onchange = ev => {
      fxSnap = JSON.stringify(edl);
      target()[sec].on = ev.target.checked;
      secEl.classList.toggle('off', !ev.target.checked);
      live(); commit();
    };
    for (const inp of $$('input[type=range]', secEl)) {
      const p = def.params.find(x => x.k === inp.dataset.k);
      inp.onpointerdown = () => { fxSnap = JSON.stringify(edl); };
      inp.oninput = () => {
        if (!fxSnap) fxSnap = JSON.stringify(edl);
        const v = fromSlider(p, inp.value);
        const t = target()[sec];
        t[p.k] = v;
        if (!t.on) { t.on = true; $('[data-on]', secEl).checked = true; secEl.classList.remove('off'); }
        inp.nextElementSibling.textContent = fmtParam(p, v);
        live();
      };
      inp.onchange = commit;
      inp.ondblclick = () => {
        // Doppelklick: Regler auf Standardwert
        fxSnap = JSON.stringify(edl);
        const d = isMaster ? fullMaster({})[sec][p.k] : fullFx({})[sec][p.k];
        target()[sec][p.k] = d; inp.value = toSlider(p, d); inp.nextElementSibling.textContent = fmtParam(p, d);
        live(); commit();
      };
    }
  }
  const pre = $('[data-preset]', panel);
  if (pre) pre.onchange = () => {
    if (!pre.value) return;
    snapshot();
    const e = tEdl(tr.t.id);
    let label;
    if (pre.value.startsWith('u:')) {
      const up = userPresets.find(x => x.id === pre.value.slice(2));
      if (!up) return;
      e.fx = fullFx(JSON.parse(JSON.stringify(up.fx)));
      e.fxOff = false;
      label = up.name;
    } else { e.fx = applyPreset(e.fx, pre.value); label = PRESETS[pre.value].label; }
    applyFx(tr); save(); renderHeads(); renderFxPanel();
    toast(`Vorlage „${label}“ angewendet`);
  };
  const sp = $('[data-savepreset]', panel);
  if (sp) sp.onclick = () => openSavePreset(tr);
  const mp = $('[data-managepresets]', panel);
  if (mp) mp.onclick = openManagePresets;
  const cp = $('[data-copy]', panel);
  if (cp) cp.onclick = () => {
    snapshot();
    const src = fullFx(tEdl(tr.t.id).fx);
    for (const x of tracks) if (x !== tr && x.t.kind === 'rec') tEdl(x.t.id).fx = JSON.parse(JSON.stringify(src));
    applyAllFx(); save(); renderHeads();
    toast('Auf alle Aufnahmespuren übertragen');
  };
  drawEq();
}

// Frequenzgang des EQ zeichnen (gleiche Filterformeln wie in der Vorschau)
const eqCtx = new OfflineAudioContext(1, 128, 48000);
const eqF = (() => { const a = new Float32Array(240); for (let i = 0; i < a.length; i++) a[i] = 20 * Math.pow(1000, i / (a.length - 1)); return a; })();
function drawEq() {
  const cv2 = $('#fxPanel .eqc');
  if (!cv2 || fxOpen === 'master') return;
  const tr = tracks.find(x => x.t.id === fxOpen);
  const e = fullFx(tEdl(tr.t.id).fx).eq;
  const total = new Float32Array(eqF.length).fill(0);
  const mag = new Float32Array(eqF.length), ph = new Float32Array(eqF.length);
  const add = (type, f, g, q) => {
    const b = eqCtx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = g; if (q != null) b.Q.value = q;
    b.getFrequencyResponse(eqF, mag, ph);
    for (let i = 0; i < mag.length; i++) total[i] += 20 * Math.log10(mag[i] + 1e-9);
  };
  if (e.on) {
    add('highpass', e.hp, 0, -3.01); add('lowshelf', e.lowFreq, e.lowGain); add('peaking', e.m1Freq, e.m1Gain, 1);
    add('peaking', e.m2Freq, e.m2Gain, 1); add('highshelf', e.highFreq, e.highGain);
  }
  const c = cv2.getContext('2d'), W = cv2.width, H = cv2.height;
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#0e1117'; c.fillRect(0, 0, W, H);
  const yOf = db => H / 2 - (db / 18) * (H / 2 - 8);
  c.strokeStyle = '#232838'; c.lineWidth = 1; c.font = '18px ui-monospace, monospace'; c.fillStyle = '#5b6380';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = (Math.log(f / 20) / Math.log(1000)) * W;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
    c.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 4, H - 8);
  }
  for (const db of [-12, -6, 0, 6, 12]) { c.strokeStyle = db === 0 ? '#3a4157' : '#1d2230'; c.beginPath(); c.moveTo(0, yOf(db)); c.lineTo(W, yOf(db)); c.stroke(); }
  c.beginPath();
  for (let i = 0; i < total.length; i++) {
    const x = (i / (total.length - 1)) * W, y = yOf(Math.max(-18, Math.min(18, total[i])));
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.strokeStyle = e.on ? tr.color : '#3a4157'; c.lineWidth = 3; c.stroke();
  c.lineTo(W, H / 2); c.lineTo(0, H / 2); c.closePath();
  c.fillStyle = e.on ? tr.color + '22' : 'transparent'; c.fill();
}

// Anzeige der aktuellen Absenkung (Gate, Kompressor, Limiter)
function updateFxMeters() {
  if (!fxOpen || !actx) return;
  const panel = $('#fxPanel');
  const show = (sec, db) => {
    const el = $(`.fx-sec[data-sec=${sec}]`, panel);
    if (!el) return;
    const v = Math.max(0, Math.min(30, -(db || 0)));
    $('.gr i', el).style.width = (v / 30) * 100 + '%';
    $('.grv', el).textContent = v >= 0.1 ? '−' + v.toFixed(1) + ' dB' : '';
  };
  if (fxOpen === 'master') { if (master) show('limiter', playing ? master.limDb : 0); return; }
  const tr = tracks.find(x => x.t.id === fxOpen);
  if (!tr?.fxNodes) return;
  show('comp', playing ? tr.fxNodes.compDb : 0);
  show('limiter', playing ? tr.fxNodes.limDb : 0);
  show('gate', playing ? tr.fxNodes.gateDb : 0);
}

// ---------------- Lautstärke-Hüllkurve (wie Reaper „Volume Envelope“) ----------------
// Punkte [Quellzeit s, dB]; ≤ −90 dB = Stille. Zwischen den Punkten linear (Amplitude).
// Liegt hinter den Effekten (Post-FX) – Kompressor/Make-up können Stille nicht wieder anheben.
const ENV_SILENT = -100, ENV_RAMP = 0.015, ENV_PAD = 7;
const envGainOf = db => (db <= -90 ? 0 : Math.pow(10, db / 20));
function envGainAt(env, t) {
  if (!env.length) return 1;
  if (t <= env[0][0]) return envGainOf(env[0][1]);
  const n = env.length;
  if (t >= env[n - 1][0]) return envGainOf(env[n - 1][1]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (env[m][0] <= t) lo = m; else hi = m; }
  const [ta, da] = env[lo], [tb, db] = env[hi];
  const ga = envGainOf(da), gb = envGainOf(db);
  return tb - ta < 1e-9 ? gb : ga + (gb - ga) * (t - ta) / (tb - ta);
}
const gainToDb = g => (g <= 1e-5 ? ENV_SILENT : 20 * Math.log10(g));
const envDbAt = (env, t) => (env.length ? gainToDb(envGainAt(env, t)) : 0);
function normEnv(env) {
  return env.map(([t, d]) => [Math.max(0, Math.round(t * 1e4) / 1e4), Math.max(ENV_SILENT, Math.min(6, Math.round(d * 10) / 10))])
    .sort((a, b) => a[0] - b[0]);
}
// Darstellung wie ein Fader: oben +6 dB, 0 dB bei ~79 % Höhe, unten Stille
const dbToP = db => (db <= -90 ? 0 : Math.cbrt(Math.min(2, Math.pow(10, db / 20)) / 2));
function pToDb(p) {
  if (p <= 0.02) return ENV_SILENT;
  const db = 20 * Math.log10(2 * p * p * p);
  return Math.abs(db) < 0.4 ? 0 : Math.max(-80, Math.min(6, db));
}
const laneTop = i => RULER + i * LANE;
const envY = (i, db) => laneTop(i) + ENV_PAD + (1 - dbToP(db)) * (LANE - 2 * ENV_PAD);
const yToDb = (i, y) => pToDb(1 - (y - laneTop(i) - ENV_PAD) / (LANE - 2 * ENV_PAD));
const fmtEnvDb = db => (db <= -90 ? '−∞ dB' : (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');

let envDrag = null;
let envHoverPt = null;

function drawEnvelope(c, tr, e, y, w, srcAt, xOf) {
  const i = tracks.indexOf(tr);
  const env = e.env || [];
  const show = !!e.envShow;
  c.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const yy = envY(i, env.length ? gainToDb(envGainAt(env, srcAt[Math.min(x, w)])) : 0);
    x ? c.lineTo(x, yy) : c.moveTo(x, yy);
  }
  c.strokeStyle = show ? '#ffd166' : 'rgba(255,209,102,.4)';
  c.lineWidth = show ? 2 : 1;
  c.stroke();
  if (!show) return;
  c.fillStyle = 'rgba(255,209,102,.12)';
  c.fillRect(0, Math.round(envY(i, 0)), w, 1);
  for (let k = 0; k < env.length; k++) {
    const [t, db] = env[k];
    if (cutAt(t)) continue;
    const x = xOf(s2e(t));
    if (x < -6 || x > w + 6) continue;
    const yy = envY(i, db);
    const active = envDrag?.tr === tr && (envDrag.idx === k || envDrag.idxs?.includes(k));
    const hover = envHoverPt && envHoverPt.tr === tr && envHoverPt.idx === k;
    c.beginPath(); c.arc(x, yy, active || hover ? 6 : 4.5, 0, Math.PI * 2);
    c.fillStyle = active ? '#ffffff' : '#ffd166'; c.fill();
    c.strokeStyle = '#0d0f14'; c.lineWidth = 2; c.stroke();
  }
  if (envDrag?.tr === tr && envDrag.label) {
    const { lx, ly, label } = envDrag;
    c.font = '600 12px ui-monospace, Menlo, monospace';
    c.textBaseline = 'middle';
    const tw = c.measureText(label).width + 12;
    const bx = Math.max(2, Math.min(w - tw - 4, lx + 12)), by = Math.max(y + 2, Math.min(y + LANE - 22, ly - 26));
    c.fillStyle = 'rgba(13,15,20,.92)'; c.fillRect(bx, by, tw, 20);
    c.fillStyle = '#ffd166'; c.fillText(label, bx + 6, by + 10);
  }
}

// Treffer: Punkt (Radius 8 px) oder Linie (±6 px) einer sichtbaren Hüllkurve
function envHit(lane, x, y) {
  const tr = tracks[lane];
  if (!tr) return null;
  const e = tEdl(tr.t.id);
  if (!e.envShow) return null;
  const env = e.env || [];
  const x0 = scroller.scrollLeft;
  let best = null;
  env.forEach(([t, db], idx) => {
    if (cutAt(t)) return;
    const d = Math.hypot(s2e(t) * pps - x0 - x, envY(lane, db) - y);
    if (d <= 8 && (!best || d < best.d)) best = { kind: 'point', idx, d };
  });
  if (best) return { tr, e, lane, ...best };
  const s = e2s(Math.max(0, (x + x0) / pps));
  if (Math.abs(envY(lane, envDbAt(env, s)) - y) <= 6) return { tr, e, lane, kind: 'line', s };
  return null;
}

function envPointerDown(ev, lane, x, y) {
  const hit = envHit(lane, x, y);
  if (!hit) return false;
  if (ev.button !== 0) return true;
  if (ev.altKey && hit.kind === 'point') { deleteEnvPoint(hit); return true; }
  const { e, tr } = hit;
  const before = JSON.stringify(edl);
  const env = (e.env || []).map(p => [...p]);
  e.env = env;
  let moved = false;
  const startX = ev.clientX, startY = ev.clientY;
  if (hit.kind === 'point') {
    envDrag = { tr, kind: 'point', idx: hit.idx, lx: x, ly: y, label: fmtEnvDb(env[hit.idx][1]) };
  } else {
    // Abschnitt ziehen: beide angrenzenden Punkte gemeinsam (wie in Reaper)
    let a = -1;
    for (let k = 0; k < env.length; k++) if (env[k][0] <= hit.s) a = k;
    let idxs = !env.length ? [] : a < 0 ? [0] : a >= env.length - 1 ? [env.length - 1] : [a, a + 1];
    // Zwischen zwei Punkten: Bereich absenken/anheben, die beiden Punkte bleiben als Anker stehen –
    // innen entstehen automatisch zwei Punkte mit kurzer Rampe. Gibt es die Rampen schon (Bereich wurde
    // bereits gezogen), werden nur die inneren Punkte bewegt. Alt = alter Modus (Anker mitziehen).
    let plateau = null;
    if (idxs.length === 2 && !ev.altKey) {
      const [i0, i1] = idxs;
      const RMAX = 0.25;
      const hasRamps = i0 > 0 && env[i0][0] - env[i0 - 1][0] <= RMAX && i1 < env.length - 1 && env[i1 + 1][0] - env[i1][0] <= RMAX;
      if (!hasRamps) plateau = { i0, i1 };
    }
    envDrag = { tr, kind: 'line', s: hit.s, idxs, plateau, startP: idxs.map(k => dbToP(env[k][1])), baseP: dbToP(envDbAt(env, hit.s)), y0: y, lx: x, ly: y };
  }
  const rect = cv.getBoundingClientRect();
  const move = mv => {
    if (!moved && Math.hypot(mv.clientX - startX, mv.clientY - startY) < 3) return;
    moved = true;
    const mx = mv.clientX - rect.left, my = mv.clientY - rect.top;
    if (envDrag.kind === 'point') {
      const k = envDrag.idx;
      if (!mv.shiftKey) {
        const lo = k > 0 ? env[k - 1][0] + 0.001 : 0;
        const hi = k < env.length - 1 ? env[k + 1][0] - 0.001 : Infinity;
        env[k][0] = Math.max(lo, Math.min(hi, e2s(posToTime(mv.clientX))));
      }
      env[k][1] = yToDb(lane, my);
      envDrag.label = `${fmtEnvDb(env[k][1])} · ${fmtTime(s2e(env[k][0]), true)}`;
    } else {
      const dp = -(my - envDrag.y0) / (LANE - 2 * ENV_PAD);
      if (!envDrag.idxs.length) {
        env.push([envDrag.s, 0]);
        envDrag.idxs = [0]; envDrag.startP = [envDrag.baseP];
      }
      if (envDrag.plateau) {
        const { i0, i1 } = envDrag.plateau;
        const t0 = env[i0][0], t1 = env[i1][0];
        const R = Math.min(ENV_RAMP * 2, (t1 - t0) / 4);
        env.splice(i1, 0, [t0 + R, env[i0][1]], [t1 - R, env[i1][1]]);
        envDrag.idxs = [i0 + 1, i0 + 2];
        envDrag.plateau = null;
      }
      envDrag.idxs.forEach((k, j) => { env[k][1] = pToDb(Math.max(0, Math.min(1, envDrag.startP[j] + dp))); });
      envDrag.label = fmtEnvDb(env[envDrag.idxs[0]][1]) + (envDrag.idxs.length === 2 ? ` · ${(env[envDrag.idxs[1]][0] - env[envDrag.idxs[0]][0]).toFixed(2)} s` : '');
    }
    envDrag.lx = mx; envDrag.ly = my;
    draw();
  };
  const up = () => {
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
    if (!moved && hit.kind === 'line') env.push([hit.s, envDbAt(env, hit.s)]); // Klick = Punkt auf der Kurve
    envDrag = null;
    e.env = normEnv(env);
    if (JSON.stringify(edl) !== before) { pushUndoSnapshot(before); changed(false); } else draw();
  };
  cv.setPointerCapture(ev.pointerId);
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
  draw();
  return true;
}

function deleteEnvPoint(hit) {
  snapshot();
  hit.e.env = (hit.e.env || []).filter((_, k) => k !== hit.idx);
  envHoverPt = null;
  changed(false);
}
function hitFromEvent(ev) {
  const r = cv.getBoundingClientRect();
  const y = ev.clientY - r.top;
  if (y < RULER) return null;
  const lane = Math.min(tracks.length - 1, Math.floor((y - RULER) / LANE));
  return envHit(lane, ev.clientX - r.left, y);
}
function envDblClick(ev) { const h = hitFromEvent(ev); if (h?.kind === 'point') deleteEnvPoint(h); }
function envContext(ev) {
  const h = hitFromEvent(ev);
  ev.preventDefault();
  if (h) { if (h.kind === 'point') deleteEnvPoint(h); return; }
  const r = cv.getBoundingClientRect();
  const y = ev.clientY - r.top;
  if (y < RULER || !tracks.length) return;
  const li = Math.min(tracks.length - 1, Math.floor((y - RULER) / LANE));
  const hit = clipHit(li, ev.clientX - r.left, y);
  if (hit) clipMenu(ev.clientX, ev.clientY, hit); else openTrackMenu(ev.clientX, ev.clientY, tracks[li]);
}
function envHover(ev) {
  if (envDrag || ev.buttons) return;
  const hit = hitFromEvent(ev);
  const pt = hit?.kind === 'point' ? { tr: hit.tr, idx: hit.idx } : null;
  cv.style.cursor = hit ? (hit.kind === 'point' ? 'move' : 'ns-resize') : 'text';
  cv.title = hit ? (hit.kind === 'point'
    ? 'Ziehen = verschieben (Umschalt: nur Höhe) · Doppelklick, Rechtsklick oder Alt+Klick = löschen'
    : 'Klick = Punkt setzen · Ziehen = Abschnitt anheben/absenken') : '';
  let gh = null, hc = null;
  if (!hit && tracks.length) {
    const r = cv.getBoundingClientRect();
    const y = ev.clientY - r.top;
    if (y >= RULER) {
      const li = Math.min(tracks.length - 1, Math.floor((y - RULER) / LANE));
      const ch = clipHit(li, ev.clientX - r.left, y);
      if (ch) {
        hc = ch.clip.id;
        if (ch.fade) { cv.style.cursor = 'ew-resize'; cv.title = `${ch.fade === 'in' ? 'Fade-in' : 'Fade-out'} ${fadeLen(ch.clip, ch.fade).toFixed(2)} s · ziehen = länger/kürzer · Doppelklick = entfernen`; }
        else if (ch.gain) { gh = ch.clip.id; cv.style.cursor = 'ns-resize'; cv.title = `Clip-Lautstärke ${fmtClipDb(+ch.clip.gainDb || 0)} · nach oben/unten ziehen (Umschalt = fein) · Doppelklick = 0 dB`; }
        else if (ch.edge) { cv.style.cursor = 'ew-resize'; cv.title = 'Kante ziehen = Clip kürzen/verlängern'; }
        else { cv.style.cursor = 'grab'; cv.title = 'Ziehen = verschieben · Alt+Ziehen = kopieren · Linie im Clip = Lautstärke'; }
      }
    }
  }
  if (gh !== gainHover || hc !== hoverClip) { gainHover = gh; hoverClip = hc; draw(); }
  if (pt?.tr !== envHoverPt?.tr || pt?.idx !== envHoverPt?.idx) { envHoverPt = pt; draw(); }
}

// Stille Abschnitte für die Liste „Bearbeitungen“
function silentRegions(env) {
  const out = [];
  for (let k = 0; k < env.length - 1; k++) {
    if (env[k][1] <= -90 && env[k + 1][1] <= -90) {
      let j = k + 1;
      while (j < env.length - 1 && env[j + 1][1] <= -90) j++;
      out.push([env[k][0], env[j][0]]);
      k = j;
    }
  }
  return out;
}
function removeSilentRegion(env, [a, b]) {
  // Stille-Punkte samt Rampenpunkten direkt davor/danach entfernen
  return (env || []).filter(([t, db]) => !(t >= a - ENV_RAMP - 0.002 && t <= b + ENV_RAMP + 0.002 && (db <= -90 || t < a || t > b)));
}

// ---------------- Eigene FX-Vorlagen ----------------
const normName = v => String(v || '').trim().toLowerCase();

// Spuren ohne eigene Effekt-Einstellungen bekommen automatisch die passende Vorlage:
// zuerst eine Vorlage für genau diesen Sprechernamen, sonst die Vorlage „für alle neuen Spuren“.
function autoApplyPresets() {
  const applied = [];
  let snap = null;
  for (const tr of tracks) {
    if (tr.t.kind !== 'rec') continue;
    const e = tEdl(tr.id);
    if (e.fx !== undefined) continue;
    const p = userPresets.find(x => x.auto === 'name' && normName(x.autoName) === normName(tr.t.name))
      || userPresets.find(x => x.auto === 'all');
    if (!p) continue;
    if (!snap) snap = JSON.stringify(edl);
    e.fx = fullFx(JSON.parse(JSON.stringify(p.fx)));
    applied.push(`„${p.name}“ → ${tr.t.name}`);
  }
  if (applied.length) {
    pushUndoSnapshot(snap);
    renderHeads(); save();
    setTimeout(() => toast(`Vorlage automatisch angewendet: ${applied.join(', ')}`, { ms: 6000 }), 300);
  }
}

function openSavePreset(tr) {
  const e = tEdl(tr.t.id);
  const existing = userPresets.find(p => p.auto === 'name' && normName(p.autoName) === normName(tr.t.name));
  const m = modal(`<h2>Effekte als Vorlage speichern</h2>
    <div class="col" style="gap:14px">
      <label class="field">Name der Vorlage<input type="text" data-name maxlength="60" value="${esc(existing?.name || tr.t.name + ' – Stimme')}"></label>
      <div class="col" style="gap:8px">
        <div class="muted" style="font-size:12.5px;font-weight:550">Bei neuen Aufnahmen automatisch anwenden?</div>
        <label class="check"><input type="radio" name="auto" value="name" checked> Ja, auf Spuren mit dem Namen <input type="text" data-autoname value="${esc(tr.t.name)}" style="height:30px;width:150px"></label>
        <label class="check"><input type="radio" name="auto" value="all"> Ja, auf alle neuen Aufnahmespuren (wenn es keine eigene für den Namen gibt)</label>
        <label class="check"><input type="radio" name="auto" value="none"> Nein, nur von Hand auswählen</label>
      </div>
      <div class="hint">Gespeichert werden Gate, EQ, Kompressor und Limiter dieser Spur. Gibt es schon eine Vorlage mit diesem Namen, wird sie überschrieben. Automatisch angewendet wird nur auf Spuren, an deren Effekten noch nichts eingestellt wurde.</div>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Abbrechen</button><button class="btn primary" data-ok>Speichern</button></div>
    </div>`);
  $('[data-x]', m).onclick = () => m.close();
  $('[data-autoname]', m).onfocus = () => { $('input[value=name]', m).checked = true; };
  $('[data-ok]', m).onclick = async () => {
    const name = $('[data-name]', m).value.trim();
    if (!name) { $('[data-name]', m).focus(); return; }
    const auto = $('input[name=auto]:checked', m).value;
    try {
      await api('/api/presets', { method: 'POST', body: { name, fx: fullFx(e.fx), auto, autoName: $('[data-autoname]', m).value } });
      userPresets = await api('/api/presets');
      m.close();
      renderFxPanel();
      toast(`Vorlage „${name}“ gespeichert`);
    } catch (err) { toast(err.message, { error: true }); }
  };
  $('[data-name]', m).select();
}

function openManagePresets() {
  const render = () => {
    const box = $('[data-list]', m);
    if (!userPresets.length) { box.innerHTML = '<div class="muted">Keine eigenen Vorlagen.</div>'; return; }
    box.innerHTML = userPresets.map(p => {
      const fx = fullFx(p.fx);
      const on = Object.entries({ gate: 'Gate', eq: 'EQ', comp: 'Kompressor', limiter: 'Limiter' }).filter(([k]) => fx[k].on).map(([, v]) => v).join(', ') || 'keine Effekte aktiv';
      return `<div class="li"><div class="grow"><b translate="no">${esc(p.name)}</b><div class="muted" style="font-size:12px">${esc(on)} · ${p.auto === 'all' ? 'automatisch für alle neuen Spuren' : p.auto === 'name' ? `automatisch für „${esc(p.autoName)}“` : 'nur manuell'}</div></div>
        <button class="btn sm icon danger" data-del="${esc(p.id)}" title="Löschen">${icon.trash}</button></div>`;
    }).join('');
    for (const b of $$('[data-del]', box)) b.onclick = async () => {
      await api(`/api/presets/${b.dataset.del}`, { method: 'DELETE' });
      userPresets = await api('/api/presets');
      render();
      if (fxOpen) renderFxPanel();
    };
  };
  const m = modal(`<h2>Meine Vorlagen</h2><div data-list></div>
    <div class="hint" style="margin-top:14px">Ändern: Vorlage auf eine Spur anwenden, Regler anpassen und unter gleichem Namen erneut speichern.</div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn" data-x>Schließen</button></div>`);
  $('[data-x]', m).onclick = () => m.close();
  render();
}

// ---------------- Normalisieren ----------------
// Misst jede gewählte Spur auf dem Server (so wie sie im Export klingt: mit Effekten, Hüllkurve und Schnitten)
// und stellt danach den Lautstärkeregler der Spur so ein, dass sie den Zielwert erreicht.
const normPrefs = Object.assign({ mode: 'lufs', lufs: -19, peak: -1 }, JSON.parse(localStorage.getItem('ps_norm') || '{}'));

function openNormalize() {
  if (!tracks.length) return;
  const m = modal(`<h2>Spuren normalisieren</h2>
    <div class="col" style="gap:14px">
      <div class="col" style="gap:8px">
        <label class="check"><input type="radio" name="nm" value="lufs" ${normPrefs.mode === 'lufs' ? 'checked' : ''}>
          <span><b>Lautheit</b> (empfohlen für Sprache) – alle klingen gleich laut</span></label>
        <div class="row" style="padding-left:26px"><select data-lufs>${[-14, -16, -18, -19, -20, -23].map(v => `<option value="${v}" ${normPrefs.lufs === v ? 'selected' : ''}>${v} LUFS${v === -19 ? ' (gut für Einzelspuren im Mix)' : v === -16 ? ' (Podcast-Endlautheit)' : v === -23 ? ' (Rundfunk EBU R128)' : ''}</option>`).join('')}</select></div>
        <label class="check"><input type="radio" name="nm" value="peak" ${normPrefs.mode === 'peak' ? 'checked' : ''}>
          <span><b>Spitzenpegel</b> – lauteste Stelle auf einen festen Wert</span></label>
        <div class="row" style="padding-left:26px"><select data-peak>${[-0.5, -1, -2, -3, -6].map(v => `<option value="${v}" ${normPrefs.peak === v ? 'selected' : ''}>${String(v).replace('.', ',')} dBFS</option>`).join('')}</select></div>
      </div>
      <div class="col" style="gap:6px">
        <div class="muted" style="font-size:12.5px;font-weight:550">Spuren</div>
        ${tracks.map(tr => `<label class="check"><input type="checkbox" data-t="${esc(tr.t.id)}" ${tr.t.kind === 'rec' && !tEdl(tr.t.id).mute ? 'checked' : ''}>
          <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${tr.color}"></span><span translate="no">${esc(tr.t.name)}</span>${tr.t.kind === 'extra' ? ' <span class="muted">(Zusatzaudio)</span>' : ''}</label>`).join('')}
      </div>
      <div class="hint">Gemessen wird jede Spur so, wie sie im Export klingt – mit Effekten, Hüllkurve und Schnitten. Das Ergebnis wird als Lautstärke der Spur eingestellt (rückgängig mit Strg+Z). Dauer: etwa 15 Sekunden pro Stunde Audio und Spur.</div>
      <div class="col hidden" data-prog style="gap:6px"><div class="row"><span data-step class="grow muted"></span><span data-pct class="mono"></span></div><div class="progress"><i></i></div></div>
      <div class="norm-res hidden" data-res></div>
      <div class="row" style="justify-content:flex-end"><button class="btn" data-x>Schließen</button><button class="btn primary" data-go>${icon.norm}Messen & anwenden</button></div>
    </div>`);
  $('[data-x]', m).onclick = () => m.close();
  $('[data-lufs]', m).onfocus = () => { $('input[value=lufs]', m).checked = true; };
  $('[data-peak]', m).onfocus = () => { $('input[value=peak]', m).checked = true; };
  $('[data-go]', m).onclick = async () => {
    const ids = $$('[data-t]', m).filter(c => c.checked).map(c => c.dataset.t);
    if (!ids.length) { toast('Bitte mindestens eine Spur wählen.'); return; }
    Object.assign(normPrefs, { mode: $('input[name=nm]:checked', m).value, lufs: +$('[data-lufs]', m).value, peak: +$('[data-peak]', m).value });
    localStorage.setItem('ps_norm', JSON.stringify(normPrefs));
    // Aktuellen Stand (Effekte, Hüllkurve, Schnitte) speichern, damit der Server genau das misst
    await saveNow();
    try { await api(`/api/sessions/${sid}/analyze`, { method: 'POST', body: { trackIds: ids } }); }
    catch (e) { toast(e.message, { error: true }); return; }
    $('[data-go]', m).disabled = true;
    $('[data-prog]', m).classList.remove('hidden');
    $('[data-res]', m).classList.add('hidden');
    pollNormalize(m, ids);
  };
}

async function pollNormalize(m, ids) {
  const j = await api(`/api/sessions/${sid}/analyze`).catch(() => null);
  if (!j) return setTimeout(() => pollNormalize(m, ids), 1500);
  if (m.isConnected) {
    $('[data-step]', m).textContent = j.step || '';
    $('[data-pct]', m).textContent = Math.round((j.progress || 0) * 100) + ' %';
    $('.progress i', m).style.width = (j.progress || 0) * 100 + '%';
  }
  if (j.state === 'running') return setTimeout(() => pollNormalize(m, ids), 800);
  if (j.state === 'error') { toast('Messung fehlgeschlagen: ' + j.error, { error: true, ms: 8000 }); if (m.isConnected) $('[data-go]', m).disabled = false; return; }
  if (j.state !== 'done') return;
  applyNormalize(m, ids, j.results || {});
}

function applyNormalize(m, ids, results) {
  snapshot();
  const rows = [];
  const hot = []; // Spuren, deren Spitzen nach dem Anheben über −1 dBFS lägen
  const fmt = v => (v > 0 ? '+' : '') + v.toFixed(1).replace('.', ',');
  for (const id of ids) {
    const tr = tracks.find(x => x.t.id === id);
    const r = results[id];
    if (!tr || !r) continue;
    const e = tEdl(id);
    const measured = normPrefs.mode === 'lufs' ? r.lufs : r.peak;
    if (measured == null) { rows.push(`<span translate="no">${esc(tr.t.name)}</span><span class="muted">kein Signal</span><span></span>`); continue; }
    const target = normPrefs.mode === 'lufs' ? normPrefs.lufs : normPrefs.peak;
    const gain = Math.max(-24, Math.min(24, Math.round((target - measured) * 2) / 2));
    e.gainDb = gain;
    const peakAfter = r.peak != null ? r.peak + gain : null;
    const limiterOn = !e.fxOff && e.fx?.limiter?.on;
    if (normPrefs.mode === 'lufs' && peakAfter != null && peakAfter > -1 && !limiterOn) hot.push(tr);
    rows.push(`<span translate="no">${esc(tr.t.name)}</span><span class="mono muted">${fmt(measured)} ${normPrefs.mode === 'lufs' ? 'LUFS' : 'dBFS'}</span><span class="mono"><b>${fmt(gain)} dB</b></span>`);
  }
  changed();
  if (!m.isConnected) { toast('Normalisierung angewendet'); return; }
  $('[data-prog]', m).classList.add('hidden');
  const res = $('[data-res]', m);
  res.classList.remove('hidden');
  res.innerHTML = `<span class="muted" style="font-size:12px">Spur</span><span class="muted" style="font-size:12px;text-align:right">gemessen</span><span class="muted" style="font-size:12px;text-align:right">Lautstärke</span>` + rows.join('') +
    (hot.length ? `<div class="hint" style="grid-column:1/-1;margin-top:6px;border-color:#7a5a1a">⚠️ Bei ${hot.map(t => '„' + esc(t.t.name) + '“').join(', ')} lägen einzelne Spitzen über −1 dBFS.
      <button class="btn sm" data-lim style="margin-top:8px">Limiter (−1 dB) für diese Spuren einschalten</button></div>` : '');
  const lb = $('[data-lim]', res);
  if (lb) lb.onclick = () => {
    snapshot();
    for (const tr of hot) {
      const e = tEdl(tr.t.id);
      e.fx = fullFx(e.fx);
      e.fx.limiter = { ...e.fx.limiter, on: true, ceiling: -1 };
      e.fxOff = false;
      applyFx(tr);
    }
    changed();
    lb.disabled = true; lb.textContent = 'Limiter eingeschaltet ✓';
  };
  $('[data-go]', m).disabled = false;
  $('[data-go]', m).innerHTML = icon.norm + 'Erneut messen';
  toast('Normalisierung angewendet');
}

// ---------------- Zoom & Navigation ----------------
const MIN_PPS = ZMIN, MAX_PPS = ZMAX;
// Zoomen so, dass die Zeit unter clientX an derselben Stelle bleibt
function zoomAt(newPps, clientX) {
  const r = scroller.getBoundingClientRect();
  const x = clientX == null ? r.width / 2 : Math.max(0, Math.min(r.width, clientX - r.left));
  const t = (scroller.scrollLeft + x) / pps;
  pps = Math.max(MIN_PPS, Math.min(MAX_PPS, newPps));
  setSliderFromZoom();
  renderView();
  scroller.scrollLeft = Math.max(0, t * pps - x);
  draw(); updateBars();
  saveView();
}
// Knöpfe/Tasten: um den Abspielkopf, falls sichtbar, sonst um die Mitte
function zoomBy(f) {
  const r = scroller.getBoundingClientRect();
  const xp = playhead * pps - scroller.scrollLeft;
  zoomAt(pps * f, xp >= 0 && xp <= r.width ? r.left + xp : null);
}

// ---------------- Scrollbalken (immer sichtbar, Maus und Touch) ----------------
function updateBars() {
  const wrap = $('#tlWrap');
  $('#hpad').style.width = $('#heads').offsetWidth + 'px';
  $('#ovlabel').style.width = $('#heads').offsetWidth + 'px';
  const set = (bar, pos, size, total) => {
    const el = $(bar), th = $('.thumb', el);
    const horiz = el.classList.contains('h');
    const track = horiz ? el.clientWidth : el.clientHeight;
    const off = total <= size + 1;
    el.classList.toggle('off', off);
    const len = off ? track : Math.max(28, track * size / total);
    const at = off ? 0 : (track - len) * (pos / Math.max(1, total - size));
    if (horiz) { th.style.width = len + 'px'; th.style.left = at + 'px'; }
    else { th.style.height = len + 'px'; th.style.top = at + 'px'; }
  };
  set('#hbar', scroller.scrollLeft, scroller.clientWidth, scroller.scrollWidth);
  set('#vbar', wrap.scrollTop, wrap.clientHeight, wrap.scrollHeight);
}

function setupScrollbars() {
  const wrap = $('#tlWrap');
  const bind = (sel, horiz) => {
    const el = $(sel), th = $('.thumb', el);
    const target = horiz ? scroller : wrap;
    const sizeOf = () => horiz ? [target.scrollLeft, target.clientWidth, target.scrollWidth, el.clientWidth, th.offsetWidth]
      : [target.scrollTop, target.clientHeight, target.scrollHeight, el.clientHeight, th.offsetHeight];
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      const [pos, size, total, track, len] = sizeOf();
      if (total <= size + 1) return;
      const ratio = (total - size) / Math.max(1, track - len);
      const p0 = horiz ? e.clientX : e.clientY;
      if (e.target !== th) {
        // Klick auf die Schiene: eine Bildschirmbreite/-höhe in diese Richtung
        const r = el.getBoundingClientRect();
        const at = horiz ? p0 - r.left : p0 - r.top;
        const thumbAt = (horiz ? th.offsetLeft : th.offsetTop);
        const dir = at < thumbAt ? -1 : 1;
        if (horiz) target.scrollLeft += dir * size * 0.9; else target.scrollTop += dir * size * 0.9;
        return;
      }
      th.classList.add('drag');
      el.setPointerCapture(e.pointerId);
      const move = m => {
        const d = (horiz ? m.clientX : m.clientY) - p0;
        if (horiz) target.scrollLeft = pos + d * ratio; else target.scrollTop = pos + d * ratio;
        markManual();
      };
      const up = () => { th.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); saveView(); };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    });
  };
  bind('#hbar', true);
  bind('#vbar', false);
  // Mausrad über den Balken
  window.addEventListener('resize', updateBars);
}

// ---------------- Touch: Wischen, Zwei-Finger-Scrollen, Pinch-Zoom ----------------
// 1 Finger waagerecht  → Bereich wählen bzw. Hüllkurve bearbeiten (wie mit der Maus)
// 1 Finger senkrecht   → Spuren scrollen
// 2 Finger             → frei scrollen (beide Richtungen) und auseinander/zusammen = zoomen
function setupTouchGestures() {
  const wrap = $('#tlWrap');
  const pts = new Map();
  let mode = null; // 'pending' | 'single' | 'vscroll' | 'pinch' | 'done'
  let downEv = null, g = null, raf = 0;
  const centerDist = () => {
    const a = [...pts.values()];
    return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) };
  };
  cv.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    e.stopImmediatePropagation(); // Touch läuft komplett hier, nicht über onPointerDown
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cv.setPointerCapture(e.pointerId);
    if (pts.size === 1 && (mode == null || mode === 'done')) {
      mode = 'pending'; downEv = e;
      g = { x0: e.clientX, y0: e.clientY, st0: wrap.scrollTop, t0: performance.now() };
    } else if (pts.size === 2 && (mode === 'pending' || mode === 'vscroll')) {
      const c = centerDist();
      const r = scroller.getBoundingClientRect();
      mode = 'pinch';
      g = { c0: c, pps0: pps, sl0: scroller.scrollLeft, st0: wrap.scrollTop, t: (scroller.scrollLeft + c.x - r.left) / pps, left: r.left };
    }
  }, true);
  cv.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'single') return; // Maus-Logik läuft
    e.stopImmediatePropagation();
    if (mode === 'pending') {
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (Math.hypot(dx, dy) < 9) return;
      if (Math.abs(dy) > Math.abs(dx) * 1.2) { mode = 'vscroll'; }
      else {
        // Waagerechte Bewegung → wie Maus: Auswahl/Hüllkurve ab dem Startpunkt
        mode = 'single';
        onPointerDown(downEv);
        cv.dispatchEvent(new PointerEvent('pointermove', { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, pointerType: 'mouse', bubbles: true }));
        return;
      }
    }
    if (mode === 'vscroll') { wrap.scrollTop = g.st0 - (e.clientY - g.y0); markManual(); return; }
    if (mode === 'pinch' && pts.size >= 2) {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const c = centerDist();
        const nPps = Math.max(MIN_PPS, Math.min(MAX_PPS, g.pps0 * (c.d / Math.max(20, g.c0.d))));
        if (Math.abs(nPps - pps) / pps > 0.002) { pps = nPps; setSliderFromZoom(); renderView(); }
        scroller.scrollLeft = Math.max(0, g.t * pps - (c.x - g.left)); // Zeit unter den Fingern bleibt dort
        wrap.scrollTop = g.st0 - (c.y - g.c0.y);
        markManual();
        draw(); updateBars();
      });
    }
  }, true);
  const end = e => {
    if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (mode === 'single') { if (pts.size === 0) mode = null; return; } // Maus-Logik beendet sich selbst
    e.stopImmediatePropagation();
    if (mode === 'pending' && e.type === 'pointerup') {
      // Antippen = Klick (Abspielposition setzen, Punkt auf Hüllkurve, Schnitt im Lineal …)
      onPointerDown(downEv);
      cv.dispatchEvent(new PointerEvent('pointerup', { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, pointerType: 'mouse', bubbles: true }));
    }
    if (mode === 'pinch' || mode === 'vscroll') saveView();
    mode = pts.size ? 'done' : null; // nach Pinch erst alle Finger lösen, bevor etwas Neues beginnt
  };
  cv.addEventListener('pointerup', end, true);
  cv.addEventListener('pointercancel', end, true);
}

// Safari am Mac meldet Trackpad-Pinch als eigene „gesture“-Ereignisse statt Strg+Rad
function setupSafariPinch() {
  let p0 = null;
  scroller.addEventListener('gesturestart', e => { e.preventDefault(); p0 = pps; });
  scroller.addEventListener('gesturechange', e => { e.preventDefault(); if (p0) zoomAt(p0 * e.scale, e.clientX); });
  scroller.addEventListener('gestureend', e => { e.preventDefault(); p0 = null; });
}

// ---------------- Übersicht (Minimap) ----------------
// Ganze Aufnahme auf einen Blick: zusammengefasste Wellenform aller Spuren, Schnitte, Marker, Abspielkopf
// und ein Rahmen für den gerade sichtbaren Ausschnitt. Klicken/Ziehen navigiert, Ränder des Rahmens ziehen = zoomen.
let ovDirty = true;
const ovCache = document.createElement('canvas');
const ov = document.getElementById('ov');

function ovSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, ov.clientWidth), h = Math.max(1, ov.clientHeight);
  if (ov.width !== Math.round(w * dpr) || ov.height !== Math.round(h * dpr)) {
    ov.width = Math.round(w * dpr); ov.height = Math.round(h * dpr);
    ovDirty = true;
  }
  return { w, h, dpr };
}

function buildOverview(w, h, dpr) {
  ovCache.width = Math.round(w * dpr); ovCache.height = Math.round(h * dpr);
  const c = ovCache.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const total = Math.max(0.001, editTotal());
  const solo = anySolo();
  const W = Math.ceil(w);
  const secPerPx = total / w;
  const n = Math.max(1, tracks.length);
  const lh = (h - 2) / n;
  // Werte je Spur: Wellenform inkl. Clip-Lautstärke, Fades, Hüllkurve und Spurlautstärke
  const all = [];
  const lanes = tracks.map(tr => {
    const e = tEdl(tr.id);
    const vals = new Float32Array(W);
    const g0 = Math.pow(10, (+e.gainDb || 0) / 20), env = e.env || [];
    const clips = clipIndex.get(tr.id) || [];
    for (const cl of clips) {
      const src = sources.get(cl.src);
      if (!src || !src.peaks.length) continue;
      const cg = clipLin(cl), fades = fadeLen(cl, 'in') > 0 || fadeLen(cl, 'out') > 0;
      const xa = Math.max(0, Math.floor(cl.start / secPerPx)), xb = Math.min(W, Math.ceil((cl.start + cl.len) / secPerPx));
      for (let x = xa; x < xb; x++) {
        const t = Math.max(cl.start, x * secPerPx);
        const st = cl.in + (t - cl.start);
        const ia = Math.max(0, Math.floor(st * src.pps)), ib = Math.min(src.peaks.length, Math.ceil((st + secPerPx) * src.pps));
        let pk = 0;
        const step = Math.max(1, Math.floor((ib - ia) / 48));
        for (let k = ia; k < ib; k += step) if (src.peaks[k] > pk) pk = src.peaks[k];
        const v = Math.sqrt(pk / 255) * g0 * Math.sqrt(cg * (fades ? clipFadeGain(cl, t) : 1)) * (env.length ? Math.sqrt(envGainAt(env, t)) : 1);
        if (v > vals[x]) vals[x] = v;
      }
    }
    for (let x = 0; x < W; x += 3) if (vals[x] > 0.002) all.push(vals[x]);
    return { tr, e, vals, clips, off: e.mute || (solo && !e.solo) };
  });
  all.sort((p, q) => p - q);
  const ref = all.length ? all[Math.floor(all.length * 0.985)] || all[all.length - 1] : 0;
  const k = ref > 0 ? 0.95 / ref : 0;
  lanes.forEach((L, i) => {
    const y0 = 1 + i * lh, mid = y0 + lh / 2, amp = Math.max(1, lh / 2 - 0.5);
    const col = L.off ? '#4a5068' : L.tr.color;
    // Clip-Flächen: Lücken und Schnitte werden sichtbar
    c.fillStyle = col + (L.off ? '18' : '1c');
    for (const cl of L.clips) {
      const xa = cl.start / secPerPx, xb = (cl.start + cl.len) / secPerPx;
      c.fillRect(xa, y0 + 0.5, Math.max(1, xb - xa), lh - 1);
    }
    c.fillStyle = col;
    c.globalAlpha = L.off ? 0.5 : 0.95;
    for (let x = 0; x < W; x++) {
      const hh = Math.min(1, L.vals[x] * k) * amp;
      if (hh > 0.25) c.fillRect(x, mid - hh, 1, hh * 2);
    }
    c.globalAlpha = 1;
    // Schnittkanten
    c.fillStyle = 'rgba(11,13,18,.9)';
    for (const cl of L.clips) { const xa = Math.round(cl.start / secPerPx); if (xa > 0) c.fillRect(xa, y0, 1, lh); }
    if (i < n - 1 && lh >= 6) { c.fillStyle = 'rgba(255,255,255,.04)'; c.fillRect(0, Math.round(y0 + lh) - 0.5, W, 1); }
  });
  ovDirty = false;
}
// Höhe der Übersicht wächst mit der Spurzahl (Desktop bis 110 px, Handy bis 70 px)
function sizeOverviewRow() {
  const small = innerWidth <= 760 || innerHeight <= 500;
  const n = Math.max(1, tracks.length);
  const h = Math.round(Math.max(46, Math.min(small ? 70 : 110, n * (small ? 12 : 16) + 4)));
  const row = $('#ovrow');
  if (row && row.style.height !== h + 'px') { row.style.height = h + 'px'; ovDirty = true; }
}

function drawOverview() {
  if (!ov || !tracks.length) return;
  sizeOverviewRow();
  // Summenanzeige im Ruhezustand: leere Balken mit Skala
  if (!playing && metIdle) { const mb = $('#mmBar'); if (mb && mb.offsetParent) drawMeter(mb, masterMet, { horiz: true, ticks: true }); }
  const { w, h, dpr } = ovSize();
  if (ovDirty) buildOverview(w, h, dpr);
  const c = ov.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, ov.width, ov.height);
  c.drawImage(ovCache, 0, 0);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const total = Math.max(0.001, editTotal());
  const X = t => (t / total) * w;
  // Schnitte und Marker
  c.fillStyle = '#ffb547';
  for (const mk of edl.markers || []) c.fillRect(Math.round(X(s2e(mk.t))), 0, 2, h);
  // Auswahl
  if (sel && Math.abs(sel.b - sel.a) > 0.01) {
    c.fillStyle = 'rgba(124,140,255,.25)';
    c.fillRect(X(Math.min(sel.a, sel.b)), 0, Math.max(1, X(Math.abs(sel.b - sel.a))), h);
  }
  // Sichtbarer Ausschnitt
  const v0 = scroller.scrollLeft / pps, v1 = (scroller.scrollLeft + scroller.clientWidth) / pps;
  const fx0 = Math.max(0, X(v0)), fx1 = Math.min(w, Math.max(fx0 + 3, X(v1)));
  c.fillStyle = 'rgba(0,0,0,.28)';
  c.fillRect(0, 0, fx0, h); c.fillRect(fx1, 0, w - fx1, h);
  c.fillStyle = 'rgba(124,140,255,.12)';
  c.fillRect(fx0, 0, fx1 - fx0, h);
  c.strokeStyle = '#e9ecf3'; c.lineWidth = 1.5;
  c.strokeRect(fx0 + 0.75, 0.75, Math.max(2, fx1 - fx0 - 1.5), h - 1.5);
  // Abspielkopf
  c.fillStyle = '#ffffff';
  c.fillRect(Math.round(X(playhead)), 0, 1.5, h);
}

function setupOverview() {
  new ResizeObserver(() => { ovDirty = true; drawOverview(); }).observe(ov);
  const tAt = clientX => {
    const r = ov.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * editTotal();
  };
  // Ausschnitt so verschieben, dass Zeit t an Position frac (0..1) des sichtbaren Bereichs liegt
  const showAt = (t, frac) => { scroller.scrollLeft = Math.max(0, t * pps - scroller.clientWidth * frac); markManual(); };
  ov.addEventListener('pointerdown', e => {
    e.preventDefault();
    const r = ov.getBoundingClientRect();
    const total = Math.max(0.001, editTotal());
    const X = t => (t / total) * r.width;
    const v0 = scroller.scrollLeft / pps, v1 = (scroller.scrollLeft + scroller.clientWidth) / pps;
    const x = e.clientX - r.left, fx0 = X(v0), fx1 = X(v1);
    const edge = Math.abs(x - fx0) < 7 ? 'l' : Math.abs(x - fx1) < 7 ? 'r' : null;
    ov.setPointerCapture(e.pointerId);
    let move;
    if (edge) {
      // Rand ziehen: sichtbaren Ausschnitt vergrößern/verkleinern (= Zoom)
      const fixed = edge === 'l' ? v1 : v0;
      move = m => {
        const t = tAt(m.clientX);
        const a = Math.min(t, fixed), b = Math.max(t, fixed);
        if (b - a < 0.2) return;
        pps = Math.max(ZMIN, Math.min(ZMAX, scroller.clientWidth / (b - a)));
        setSliderFromZoom(); renderView();
        scroller.scrollLeft = a * pps; markManual(); draw();
      };
    } else {
      // Im Rahmen: Rahmen mitziehen. Außerhalb: dorthin springen (Klickpunkt in die Mitte), dann ziehen
      const inside = x >= fx0 && x <= fx1;
      const grab = inside ? (tAt(e.clientX) - v0) / Math.max(0.001, v1 - v0) : 0.5;
      showAt(tAt(e.clientX), grab);
      move = m => showAt(tAt(m.clientX), grab);
    }
    const up = () => { ov.removeEventListener('pointermove', move); ov.removeEventListener('pointerup', up); ov.removeEventListener('pointercancel', up); saveView(); };
    ov.addEventListener('pointermove', move); ov.addEventListener('pointerup', up); ov.addEventListener('pointercancel', up);
  });
  ov.addEventListener('dblclick', e => { seek(tAt(e.clientX), true); });
  ov.addEventListener('pointermove', e => {
    if (e.buttons) return;
    const r = ov.getBoundingClientRect();
    const total = Math.max(0.001, editTotal());
    const fx0 = (scroller.scrollLeft / pps / total) * r.width, fx1 = ((scroller.scrollLeft + scroller.clientWidth) / pps / total) * r.width;
    const x = e.clientX - r.left;
    ov.style.cursor = Math.abs(x - fx0) < 7 || Math.abs(x - fx1) < 7 ? 'ew-resize' : x >= fx0 && x <= fx1 ? 'grab' : 'pointer';
  });
}

// ---------------- Spuren: Kontextmenü, neue Spur, duplizieren, umbenennen ----------------
function contextMenu(x, y, items) {
  document.querySelector('.ctx')?.remove();
  const m = document.createElement('div');
  m.className = 'ctx';
  m.innerHTML = items.map((it, i) => it === '-' ? '<hr>' : it.title ? `<div class="ttl">${esc(it.title)}</div>`
    : `<button data-i="${i}" class="${it.danger ? 'danger' : ''}" ${it.disabled ? 'disabled' : ''}>${it.icon || ''}<span>${esc(it.label)}</span></button>`).join('');
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(innerWidth - r.width - 6, x)) + 'px';
  m.style.top = Math.max(6, Math.min(innerHeight - r.height - 6, y)) + 'px';
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  const outside = e => { if (!m.contains(e.target)) close(); };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true); }, 0);
  for (const b of $$('button', m)) b.onclick = () => { close(); items[+b.dataset.i].action(); };
}

function openTrackMenu(x, y, tr) {
  const items = [
    { title: tr ? tr.name : 'Spuren' },
    { label: 'Neue leere Spur …', icon: icon.plus, action: () => newEmptyLane(tr) },
    { label: tr ? 'Audiodatei in diese Spur einfügen …' : 'Audiodatei als neue Spur …', icon: icon.upload, action: () => { importLane = tr ? tr.id : null; $('#addFile').click(); } },
  ];
  if (tr) {
    const e = tEdl(tr.id);
    const idx = tracks.indexOf(tr);
    const groups = Object.entries(edl.groups || {});
    items.push('-',
      { label: 'Umbenennen …', icon: icon.edit, action: () => renameTrack(tr) },
      { label: 'Farbe …', icon: '<span class="sw" style="background:' + esc(tr.color) + '"></span>', action: () => colorMenu(x, y, tr) },
      { label: 'Spur duplizieren', icon: icon.plus, action: () => duplicateTrack(tr) },
      { label: 'Nach oben', icon: icon.back.replace('<svg', '<svg style="transform:rotate(90deg)"'), disabled: idx === 0, action: () => moveLane(tr, -1) },
      { label: 'Nach unten', icon: icon.back.replace('<svg', '<svg style="transform:rotate(-90deg)"'), disabled: idx === tracks.length - 1, action: () => moveLane(tr, 1) },
      '-',
      { title: 'Spurgruppe (Schnitte & Verschieben wirken gemeinsam)' },
      ...(e.group ? [{ label: `Aus Gruppe „${edl.groups[e.group]?.name || ''}“ entfernen`, icon: icon.x, action: () => setLaneGroup(tr, null) }] : []),
      ...groups.filter(([gid]) => gid !== e.group).map(([gid, g]) => ({ label: `Zu „${g.name}“ hinzufügen`, icon: '⛓', action: () => setLaneGroup(tr, gid) })),
      { label: 'Neue Gruppe mit dieser Spur', icon: '⛓', action: () => newLaneGroup(tr) },
      '-',
      { label: 'Effekte (FX) …', icon: icon.wave, action: () => openFx(tr.id) },
      { label: e.envShow ? 'Hüllkurve ausblenden' : 'Hüllkurve einblenden', icon: icon.wave, action: () => { e.envShow = !e.envShow; renderHeads(); draw(); save(); } },
      { label: e.mute ? 'Stummschaltung aufheben' : 'Spur stummschalten', icon: icon.volOff, action: () => { snapshot(); e.mute = !e.mute; changed(); } },
      '-',
      { label: 'Spur löschen …', icon: icon.trash, danger: true, action: () => deleteTrack(tr) });
  }
  contextMenu(x, y, items);
}

function setupTrackMenu() {
  const heads = $('#heads');
  const trackFor = el => { const h = el.closest('.head'); return h ? tracks.find(t => t.t.id === h.dataset.tid) || null : null; };
  heads.addEventListener('contextmenu', e => { e.preventDefault(); openTrackMenu(e.clientX, e.clientY, trackFor(e.target)); });
  // Langes Drücken auf Touch-Geräten (iOS kennt kein Kontextmenü-Ereignis)
  let lp = null;
  heads.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch' || e.target.closest('button, input, a')) return;
    const x = e.clientX, y = e.clientY, tr = trackFor(e.target);
    lp = setTimeout(() => { lp = null; openTrackMenu(x, y, tr); }, 550);
  });
  const cancel = () => { clearTimeout(lp); lp = null; };
  heads.addEventListener('pointerup', cancel); heads.addEventListener('pointercancel', cancel);
  heads.addEventListener('pointermove', e => { if (lp && e.pointerType === 'touch') cancel(); });
  // Audiodateien auf Spurköpfe oder Zeitachse ziehen = neue Spuren
  for (const zone of [heads, $('.tl-area')]) {
    zone.addEventListener('dragover', e => {
      const ty = e.dataTransfer?.types || [];
      if (ty.includes('Files') || ty.includes(POOL_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; zone.classList.add('dropping'); }
      if (ty.includes(POOL_MIME)) poolDragOver(e);
    });
    zone.addEventListener('dragleave', () => { zone.classList.remove('dropping'); poolDropHint = null; draw(); });
    zone.addEventListener('drop', async e => {
      zone.classList.remove('dropping');
      const pid = e.dataTransfer?.getData(POOL_MIME);
      if (pid) { e.preventDefault(); const at = poolDropTarget(e); poolDropHint = null; draw(); await insertFromPool(pid, at.lane, at.t); return; }
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      for (const f of e.dataTransfer.files) if (/^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name)) await uploadExtraFile(f);
    });
  }
}

async function deleteTrack(tr) {
  const n = (clipIndex.get(tr.id) || []).length;
  if (!await confirmDialog(`Spur „${tr.name}“${n ? ` mit ${n} Clip${n > 1 ? 's' : ''}` : ''} löschen? (Die Original-Aufnahmen bleiben auf dem Server erhalten.)`, { ok: 'Löschen', danger: true })) return;
  snapshot();
  edl.clips = edl.clips.filter(c => c.lane !== tr.id);
  edl.laneOrder = edl.laneOrder.filter(id => id !== tr.id);
  delete edl.tracks[tr.id];
  if (fxOpen === tr.id) closeFx();
  changed();
}

async function duplicateTrack(tr) {
  snapshot();
  const copy = JSON.parse(JSON.stringify(tEdl(tr.id)));
  copy.name = (copy.name || tr.name) + ' (Kopie)';
  copy.color = null;
  const id = addLane(copy, tr.id);
  const gmap = new Map();
  for (const c of clipIndex.get(tr.id) || []) {
    let g = null;
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, newId('g')); g = gmap.get(c.group); }
    edl.clips.push({ ...c, id: newId('c'), lane: id, group: g });
  }
  changed();
  toast(`„${copy.name}“ angelegt – mit eigenen Effekten und eigener Hüllkurve`);
}

async function renameTrack(tr) {
  const name = prompt('Name der Spur', tr.name);
  if (!name || name.trim() === tr.name) return;
  snapshot();
  tEdl(tr.id).name = name.trim().slice(0, 60);
  changed();
  if (fxOpen) renderFxPanel();
}

// ---------------- Notizblock ----------------
let notesAt = 0, notesTimer = null, notesDirty = false;
const tsRe = /\[?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d))?\]?/g;

function setupNotes() {
  const ta = $('#notes');
  ta.value = session.notes || '';
  notesAt = session.notesAt || 0;
  ta.addEventListener('input', () => {
    notesDirty = true;
    $('#notesState').textContent = '…';
    clearTimeout(notesTimer);
    notesTimer = setTimeout(() => flushNotes(false), 800);
  });
  $('#tsBtn').onclick = () => {
    const stamp = `[${fmtTime(playhead)}] `;
    const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
    const before = ta.value.slice(0, a);
    const prefix = before && !before.endsWith('\n') ? '\n' : '';
    ta.value = before + prefix + stamp + ta.value.slice(b);
    const pos = a + prefix.length + stamp.length;
    ta.focus(); ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input'));
  };
  // Doppelklick auf einen Zeitstempel (z. B. 12:34 oder [1:02:03]) springt dorthin
  ta.addEventListener('dblclick', () => {
    const p = ta.selectionStart;
    const line0 = ta.value.lastIndexOf('\n', p - 1) + 1, line1 = ta.value.indexOf('\n', p);
    const line = ta.value.slice(line0, line1 < 0 ? undefined : line1);
    for (const m of line.matchAll(tsRe)) {
      const s0 = line0 + m.index, s1 = s0 + m[0].length;
      if (p >= s0 - 1 && p <= s1 + 1) {
        const t = (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +m[4] / 10 : 0);
        if (m[1] === undefined) { /* mm:ss */ }
        seek(Math.min(editTotal(), t));
        scrollTo(playhead); draw(); saveView();
        toast(`Sprung zu ${fmtTime(t)}`);
        return;
      }
    }
  });
}

async function flushNotes(beacon) {
  if (!notesDirty) return;
  clearTimeout(notesTimer);
  const body = JSON.stringify({ notes: $('#notes').value, clientId: myClient });
  notesDirty = false;
  if (beacon && navigator.sendBeacon) { navigator.sendBeacon(`/api/sessions/${sid}/notes`, new Blob([body], { type: 'application/json' })); return; }
  try {
    const r = await api(`/api/sessions/${sid}/notes`, { method: 'PUT', body: JSON.parse(body) });
    notesAt = r.notesAt;
    $('#notesState').textContent = 'gespeichert ✓';
  } catch (e) { notesDirty = true; $('#notesState').textContent = 'nicht gespeichert'; }
}

// Notizen von einem anderen Gerät übernehmen (nur wenn hier gerade nichts Ungespeichertes steht)
async function checkRemoteNotes(r) {
  if (!r.notesAt || r.notesAt <= notesAt || notesDirty || r.notesBy === myClient) return;
  try {
    const s = await api(`/api/sessions/${sid}`);
    if (notesDirty) return;
    const ta = $('#notes');
    const a = ta.selectionStart, b = ta.selectionEnd, focused = document.activeElement === ta;
    ta.value = s.notes || '';
    notesAt = s.notesAt || r.notesAt;
    if (focused) ta.setSelectionRange(Math.min(a, ta.value.length), Math.min(b, ta.value.length));
    $('#notesState').textContent = 'aktualisiert';
  } catch { /* egal */ }
}

// Start (am Dateiende, damit alle Variablen initialisiert sind)
init().catch(e => { console.error(e); $('#loading').innerHTML = `<div class="card"><h2>Fehler</h2><p class="muted">${esc(e.message)}</p><a class="btn" href="/">Zurück</a></div>`; });



// =====================================================================
// Version 2: Spuren (Lanes) mit Clips
//   edl.laneOrder  – Reihenfolge der Spuren
//   edl.tracks[id] – Einstellungen je Spur (Name, Farbe, Lautstärke, Effekte, Hüllkurve, Gruppe …)
//   edl.clips      – { id, lane, src, start, in, len, group } (src = Audiodatei auf dem Server)
//   edl.groups     – Spurgruppen { name, color }
// =====================================================================
let sources = new Map();       // Audiodateien: id → { t, peaks, pps, dur }
let clipIndex = new Map();     // Spur-ID → Clips nach Startzeit sortiert
let selClips = new Set();      // ausgewählte Clip-IDs
let snapLine = null;           // Einrast-Position beim Ziehen (für die Anzeige)
let importLane = null;         // Ziel-Spur für „Audiodatei einfügen“
const newId = p => p + Math.random().toString(36).slice(2, 9);
const clipById = id => edl.clips?.find(c => c.id === id);
const GROUP_COLORS = ['#7c8cff', '#3ddc97', '#ffb547', '#ff7a90', '#4cc9f0', '#c77dff'];

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

async function loadSources() {
  const live = session.live || session.tracks.some(t => t.kind === 'rec' && !(t.ended && t.nextSeq >= (t.totalChunks || 0)));
  $('#liveBadge').classList.toggle('hidden', !live);
  const old = sources;
  const next = new Map();
  await Promise.all(session.tracks.map(async t => {
    const prev = old.get(t.id);
    if (prev && prev.t.bytes === t.bytes) { prev.t = t; next.set(t.id, prev); return; }
    const s = { t, peaks: new Uint8Array(0), pps: 100, dur: t.duration || 0 };
    try {
      const res = await api(`/api/sessions/${sid}/tracks/${t.id}/peaks?v=${t.bytes}`, { raw: true });
      if (!res.ok) throw new Error('Wellenform nicht verfügbar');
      s.pps = +res.headers.get('X-Peaks-Per-Sec') || 100;
      s.peaks = new Uint8Array(await res.arrayBuffer());
    } catch (e) { toast(`${t.name}: ${e.message}`, { error: true }); }
    s.dur = Math.max(t.duration || 0, s.peaks.length / s.pps);
    // Läuft die Aufnahme noch: Clips, die bis zum bisherigen Ende reichten, mitwachsen lassen
    if (prev && s.dur > prev.dur + 0.01 && edl.clips) {
      for (const c of edl.clips) if (c.src === t.id && c.in + c.len >= prev.dur - 0.06) c.len = s.dur - c.in;
    }
    next.set(t.id, s);
  }));
  sources = next;
}

// Alte Bearbeitungen (eine Datei je Spur + globale Schnitte) in Spuren mit Clips umwandeln
function migrateToV2() {
  if (edl.version === 2) return false;
  mergeCuts();
  const cuts = merged.map(c => [...c]);
  const keep = [];
  let pos = 0;
  for (const [a, b] of cuts) { if (a > pos) keep.push([pos, a]); pos = Math.max(pos, b); }
  keep.push([pos, Infinity]);
  const tracksNew = {}, laneOrder = [], clips = [];
  const recLanes = [];
  session.tracks.forEach((t, i) => {
    const e = edl.tracks[t.id] || {};
    const off = t.kind === 'extra' ? (+e.offset || 0) : (t.offset || 0) + (+e.nudgeMs || 0) / 1000;
    const dur = sources.get(t.id)?.dur || t.duration || 0;
    let env = (e.env || []).map(([tt, db]) => [s2e(tt), db]);
    for (const [a, b] of e.mutes || []) {
      const A = s2e(a), B = s2e(b);
      if (B - A > 0.005) env = env.filter(([tt]) => tt < A - 0.02 || tt > B + 0.02).concat([[Math.max(0, A - 0.01), envDbAt(env, A - 0.01)], [A, ENV_SILENT], [B, ENV_SILENT], [B + 0.01, envDbAt(env, B + 0.01)]]);
    }
    tracksNew[t.id] = {
      name: t.name, kind: t.kind === 'rec' ? 'rec' : 'extra', color: COLORS[i % COLORS.length],
      gainDb: +e.gainDb || 0, mute: !!e.mute, solo: !!e.solo, fx: e.fx, fxOff: !!e.fxOff,
      env: normEnv(env), envShow: !!e.envShow, group: null,
    };
    if (t.kind === 'rec') recLanes.push(t.id);
    laneOrder.push(t.id);
    for (const [k0, k1] of keep) {
      const a = Math.max(k0, off), b = Math.min(k1, off + dur);
      if (b - a > 0.01) clips.push({ id: newId('c'), lane: t.id, src: t.id, start: s2e(a), in: a - off, len: b - a, group: null });
    }
  });
  const groups = {};
  if (recLanes.length >= 2) {
    groups.g_talk = { name: 'Gespräch', color: GROUP_COLORS[0] };
    for (const id of recLanes) tracksNew[id].group = 'g_talk';
  }
  edl = {
    version: 2, cuts: [], tracks: tracksNew, laneOrder, clips, groups,
    knownSources: session.tracks.map(t => t.id),
    markers: (edl.markers || []).map(m => ({ ...m, t: s2e(m.t) })), master: edl.master || {},
  };
  merged = [];
  return true;
}

// Neue Audiodateien (z. B. Teilnehmer kam nach einem Abbruch neu in den Raum) automatisch einsortieren
function syncSources() {
  edl.knownSources = edl.knownSources || [];
  let added = false;
  for (const t of session.tracks) {
    if (edl.knownSources.includes(t.id)) continue;
    edl.knownSources.push(t.id);
    if (t.kind === 'extra') continue; // Zusatzaudio legt der Editor beim Hochladen selbst an
    const dur = sources.get(t.id)?.dur || t.duration || 0;
    const start = Math.max(0, t.offset || 0);
    // gleiche Person → gleiche Spur, wenn dort Platz ist
    let lid = edl.laneOrder.find(id => edl.tracks[id]?.kind === 'rec' && edl.tracks[id]?.name === t.name &&
      !edl.clips.some(c => c.lane === id && c.start < start + dur && c.start + c.len > start));
    if (!lid) lid = addLane({ name: t.name, kind: 'rec' });
    edl.clips.push({ id: newId('c'), lane: lid, src: t.id, start, in: 0, len: Math.max(0.1, dur), group: null });
    added = true;
  }
  return added;
}

// Spur-Objekte (mit Audio-Knoten) passend zu edl.laneOrder halten
function buildLanes() {
  rebuildIndex();
  const old = new Map(tracks.map(tr => [tr.id, tr]));
  tracks = (edl.laneOrder || []).filter(id => edl.tracks[id]).map((id, i) => {
    const L = edl.tracks[id];
    const tr = old.get(id) || { id, players: new Map(), active: null };
    tr.name = L.name || 'Spur';
    tr.color = L.color || COLORS[i % COLORS.length];
    tr.t = { id, name: tr.name, kind: L.kind || 'extra' }; // Kompatibilität (FX-Panel, Vorlagen, Normalisieren)
    return tr;
  });
  for (const [id, tr] of old) if (!tracks.includes(tr)) { for (const p of tr.players.values()) { p.el.pause(); p.el.src = ''; } }
}

function rebuildIndex() {
  clipIndex = new Map();
  for (const c of edl.clips || []) {
    if (!clipIndex.has(c.lane)) clipIndex.set(c.lane, []);
    clipIndex.get(c.lane).push(c);
  }
  for (const l of clipIndex.values()) l.sort((a, b) => a.start - b.start);
}

function addLane(settings, afterId = null) {
  const id = newId('L');
  edl.tracks[id] = { name: 'Spur', kind: 'extra', gainDb: 0, env: [], ...settings };
  if (!edl.tracks[id].color) edl.tracks[id].color = COLORS[(edl.laneOrder.length) % COLORS.length];
  const i = afterId ? edl.laneOrder.indexOf(afterId) : -1;
  if (i >= 0) edl.laneOrder.splice(i + 1, 0, id); else edl.laneOrder.push(id);
  return id;
}

async function newEmptyLane(after) {
  const name = prompt('Name der neuen Spur', `Spur ${tracks.length + 1}`);
  if (name == null) return;
  snapshot();
  addLane({ name: name.trim().slice(0, 60) || `Spur ${tracks.length + 1}`, kind: 'extra' }, after ? after.id : null);
  changed();
  toast('Leere Spur angelegt – Clips hineinziehen oder per Rechtsklick Audio einfügen');
}

function moveLane(tr, d) {
  const i = edl.laneOrder.indexOf(tr.id), j = i + d;
  if (i < 0 || j < 0 || j >= edl.laneOrder.length) return;
  snapshot();
  [edl.laneOrder[i], edl.laneOrder[j]] = [edl.laneOrder[j], edl.laneOrder[i]];
  changed();
}

function setLaneGroup(tr, gid) {
  snapshot();
  tEdl(tr.id).group = gid;
  // leere Gruppen aufräumen
  for (const g of Object.keys(edl.groups || {})) if (!edl.laneOrder.some(id => edl.tracks[id]?.group === g)) delete edl.groups[g];
  changed();
}
function newLaneGroup(tr) {
  const n = Object.keys(edl.groups || {}).length + 1;
  const name = prompt('Name der Spurgruppe', `Gruppe ${n}`);
  if (name == null) return;
  edl.groups = edl.groups || {};
  const gid = newId('g');
  edl.groups[gid] = { name: name.trim().slice(0, 30) || `Gruppe ${n}`, color: GROUP_COLORS[n % GROUP_COLORS.length] };
  setLaneGroup(tr, gid);
  toast('Weitere Spuren per Rechtsklick → „Zu … hinzufügen“ in die Gruppe nehmen');
}

// Farbauswahl für eine Spur
const LANE_PALETTE = ['#7c8cff', '#5b8cff', '#4cc9f0', '#2ec4b6', '#3ddc97', '#a3e635', '#ffd166', '#ffb547', '#f4a261', '#ff7a90', '#ff4d6d', '#c77dff', '#e879f9', '#94a3b8'];
function colorMenu(x, y, tr) {
  document.querySelector('.ctx')?.remove();
  const m = document.createElement('div');
  m.className = 'ctx colors';
  m.innerHTML = `<div class="ttl">Farbe für „${esc(tr.name)}“</div><div class="sws">${LANE_PALETTE.map(c => `<button data-c="${c}" style="background:${c}" class="${c === tr.color ? 'cur' : ''}" title="${c}"></button>`).join('')}</div>
    <label class="custom">Eigene Farbe <input type="color" value="${esc(/^#[0-9a-f]{6}$/i.test(tr.color) ? tr.color : '#7c8cff')}"></label>`;
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(6, Math.min(innerWidth - r.width - 6, x)) + 'px';
  m.style.top = Math.max(6, Math.min(innerHeight - r.height - 6, y)) + 'px';
  const apply = c => { snapshot(); tEdl(tr.id).color = c; ovDirty = true; changed(); };
  const close = () => { m.remove(); document.removeEventListener('pointerdown', outside, true); };
  const outside = e => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  for (const b of $$('[data-c]', m)) b.onclick = () => { apply(b.dataset.c); close(); };
  $('input[type=color]', m).onchange = e => { apply(e.target.value); close(); };
}

// ---------- Auswahl ----------
// Gewählte Spuren einer Bereichsauswahl – inklusive aller Spuren derselben Spurgruppe
let selTracks = new Set(); // markierte Spuren (Klick auf den Spurkopf)
let lastSelTrack = null;
function selLaneSet() {
  const out = new Set();
  if (sel && sel.time) {
    // Zeitauswahl aus dem Lineal: gilt für die markierten Spuren, sonst für alle
    const ids = [...selTracks].filter(id => edl.tracks[id]);
    for (const id of ids.length ? ids : edl.laneOrder) out.add(id);
  } else if (sel && sel.l0 != null) {
    const a = Math.min(sel.l0, sel.l1 ?? sel.l0), b = Math.max(sel.l0, sel.l1 ?? sel.l0);
    for (let i = a; i <= b; i++) if (tracks[i]) out.add(tracks[i].id);
  }
  for (const id of [...out]) { const g = edl.tracks[id]?.group; if (g) for (const o of edl.laneOrder) if (edl.tracks[o]?.group === g) out.add(o); }
  return out;
}
// Clip anklicken: Clip-Gruppe und (bei Spurgruppen) zeitgleiche Clips der Gruppenspuren mit auswählen
function expandSel(clip, alone = false) {
  const out = new Set([clip.id]);
  if (alone) return out;
  const add = c => {
    if (out.has(c.id) && c !== clip) return;
    out.add(c.id);
    if (c.group) for (const o of edl.clips) if (o.group === c.group && !out.has(o.id)) { out.add(o.id); add(o); }
  };
  add(clip);
  for (const id of [...out]) {
    const c = clipById(id), g = edl.tracks[c.lane]?.group;
    if (!g) continue;
    for (const o of edl.clips) {
      if (out.has(o.id) || o.lane === c.lane || edl.tracks[o.lane]?.group !== g) continue;
      const ov = Math.min(o.start + o.len, c.start + c.len) - Math.max(o.start, c.start);
      if (ov > Math.min(o.len, c.len) * 0.5) { out.add(o.id); if (o.group) add(o); }
    }
  }
  return out;
}

function clipHit(laneIdx, x, y) {
  const tr = tracks[laneIdx];
  if (!tr) return null;
  const top = RULER + laneIdx * LANE + 4, bot = RULER + (laneIdx + 1) * LANE - 4;
  if (y < top || y > bot) return null;
  const t = (x + scroller.scrollLeft) / pps;
  const list = clipIndex.get(tr.id) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    const xa = c.start * pps - scroller.scrollLeft, xb = (c.start + c.len) * pps - scroller.scrollLeft;
    if (x >= xa - 1 && x <= xb + 1) {
      if (xb - xa > 24 && y <= top + 15) {
        const hi = xa + fadeLen(c, 'in') * pps, ho = xb - fadeLen(c, 'out') * pps;
        const di = Math.abs(x - hi), dO = Math.abs(x - ho);
        if (di <= 8 && di <= dO) return { clip: c, fade: 'in', t };
        if (dO <= 8) return { clip: c, fade: 'out', t };
      }
      const edgeW = Math.min(8, (xb - xa) / 4);
      const edge = x - xa < edgeW ? 'l' : xb - x < edgeW ? 'r' : null;
      const gain = !edge && xb - xa > 16 && Math.abs(y - clipGainY(+c.gainDb || 0, top, bot)) <= 5;
      return { clip: c, edge, gain, t };
    }
  }
  return null;
}

// Einrasten an Abspielkopf, Markern, Clip-Kanten (8 px); Strg/Cmd hält das Einrasten aus
function snapDelta(times, exclude, ev) {
  if (ev.ctrlKey || ev.metaKey) { snapLine = null; return 0; }
  const cands = [0, playhead, ...edl.markers.map(m => m.t)];
  for (const c of edl.clips) if (!exclude.has(c.id)) cands.push(c.start, c.start + c.len);
  let best = null;
  for (const t of times) for (const c of cands) {
    const d = c - t;
    if (Math.abs(d) * pps <= 8 && (best == null || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
  }
  snapLine = best ? best.at : null;
  return best ? best.d : 0;
}

function clipPointerDown(ev, hit, laneIdx) {
  const clip = hit.clip;
  const startX = ev.clientX, startY = ev.clientY;
  const before = JSON.stringify(edl);
  sel = null;
  let moved = false;
  const wasSelected = selClips.has(clip.id);
  if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
    if (!wasSelected) for (const id of expandSel(clip, ev.altKey)) selClips.add(id);
  } else if (!wasSelected) selClips = expandSel(clip, ev.altKey);
  updateSelUi(); draw();
  const rect = cv.getBoundingClientRect();
  if (hit.gain) return clipGainDrag(ev, hit, laneIdx, before);
  if (hit.fade) return clipFadeDrag(ev, hit, before);

  if (hit.edge) {
    // Kante ziehen: Clip kürzen/verlängern (nur dieser Clip)
    const src = sources.get(clip.src);
    const o = { start: clip.start, in: clip.in, len: clip.len };
    const move = m => {
      if (!moved && Math.abs(m.clientX - startX) < 3) return;
      moved = true;
      let t = posToTime(m.clientX);
      t += snapDelta([t], new Set([clip.id]), m);
      if (hit.edge === 'l') {
        const minStart = Math.max(o.start - o.in, 0), maxStart = o.start + o.len - 0.05;
        const ns = Math.max(minStart, Math.min(maxStart, t));
        clip.in = o.in + (ns - o.start); clip.len = o.len - (ns - o.start); clip.start = ns;
      } else {
        const maxLen = (src ? src.dur : o.in + o.len) - o.in;
        clip.len = Math.max(0.05, Math.min(maxLen, t - o.start));
      }
      rebuildIndex(); draw();
    };
    const up = () => {
      cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      snapLine = null;
      if (moved) { resolveOverlaps([clip]); pushUndoSnapshot(before); changed(false); } else draw();
    };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    return;
  }

  // Clip(s) verschieben – auch in andere Spuren; Alt = Kopie verschieben
  let moving = null, orig = null;
  const startLane = laneIdx, t0 = posToTime(ev.clientX);
  const move = m => {
    if (!moved && Math.hypot(m.clientX - startX, m.clientY - startY) < 4) return;
    if (!moved) {
      moved = true;
      if (ev.altKey) {
        const gmap = new Map();
        const copies = [...selClips].map(id => clipById(id)).filter(Boolean).map(c => {
          let g = null;
          if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, newId('g')); g = gmap.get(c.group); }
          return { ...c, id: newId('c'), group: g };
        });
        edl.clips.push(...copies);
        selClips = new Set(copies.map(c => c.id));
      }
      moving = [...selClips].map(id => clipById(id)).filter(Boolean);
      orig = moving.map(c => ({ start: c.start, li: edl.laneOrder.indexOf(c.lane) }));
    }
    let dt = posToTime(m.clientX) - t0;
    const minStart = Math.min(...orig.map(o => o.start));
    if (minStart + dt < 0) dt = -minStart;
    const ex = new Set(moving.map(c => c.id));
    dt += snapDelta(moving.flatMap((c, i) => [orig[i].start + dt, orig[i].start + dt + c.len]), ex, m);
    if (minStart + dt < 0) dt = -minStart;
    const li = Math.max(0, Math.min(tracks.length - 1, Math.floor((m.clientY - rect.top - RULER) / LANE)));
    let dl = li - startLane;
    const minLi = Math.min(...orig.map(o => o.li)), maxLi = Math.max(...orig.map(o => o.li));
    dl = Math.max(-minLi, Math.min(tracks.length - 1 - maxLi, dl));
    moving.forEach((c, i) => { c.start = orig[i].start + dt; c.lane = edl.laneOrder[orig[i].li + dl]; });
    autoScroll(m.clientX);
    rebuildIndex(); draw();
  };
  const up = m => {
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
    snapLine = null;
    if (moved) { resolveOverlaps(moving); pushUndoSnapshot(before); changed(false); return; }
    // Klick ohne Bewegung: Abspielkopf setzen; mit Umschalt bereits gewählten Clip abwählen
    if ((ev.shiftKey || ev.ctrlKey || ev.metaKey) && wasSelected) { for (const id of expandSel(clip, ev.altKey)) selClips.delete(id); }
    else if (!ev.shiftKey && wasSelected) selClips = expandSel(clip, ev.altKey);
    seek(hit.t, true);
    updateSelUi(); draw();
  };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
}

// Verschobene/neue Clips haben Vorrang: darunterliegende Clips derselben Spur werden gekürzt/geteilt
function resolveOverlaps(movedClips) {
  const moved = new Set(movedClips.map(c => c.id));
  const add = [];
  for (const m of movedClips) {
    const mA = m.start, mB = m.start + m.len;
    for (const o of edl.clips) {
      if (moved.has(o.id) || o.lane !== m.lane || o._del) continue;
      const oA = o.start, oB = o.start + o.len;
      if (oB <= mA + 0.0005 || oA >= mB - 0.0005) continue;
      if (oA >= mA - 0.0005 && oB <= mB + 0.0005) { o._del = true; continue; }
      if (oA < mA && oB > mB) { // umschließt → teilen
        add.push({ ...o, id: newId('c'), start: mB, in: o.in + (mB - oA), len: oB - mB });
        o.len = mA - oA; continue;
      }
      if (oA < mA) o.len = mA - oA;
      else { const d = mB - oA; o.start += d; o.in += d; o.len -= d; }
    }
  }
  edl.clips = edl.clips.filter(c => !c._del && c.len > 0.002).concat(add);
  rebuildIndex();
}

// ---------- Schnitt-Werkzeuge ----------
function splitClip(c, t) {
  if (t <= c.start + 0.005 || t >= c.start + c.len - 0.005) return null;
  const right = { ...c, id: newId('c'), start: t, in: c.in + (t - c.start), len: c.start + c.len - t };
  c.len = t - c.start;
  delete right.fadeIn; delete c.fadeOut;
  edl.clips.push(right);
  return right;
}

function splitAtPlayhead() {
  const t = playhead;
  let targets = [...selClips].map(clipById).filter(c => c && c.start < t && c.start + c.len > t);
  if (!targets.length) {
    const lanes = selLaneSet();
    targets = edl.clips.filter(c => c.start < t && c.start + c.len > t && (!lanes.size || lanes.has(c.lane)));
  }
  if (!targets.length) { toast('An der Abspielposition liegt kein Clip.'); return; }
  snapshot();
  // geteilte Clip-Gruppen: rechte Hälften bilden eine neue Gruppe
  const gmap = new Map();
  for (const c of targets) {
    const r = splitClip(c, t);
    if (r && c.group) { if (!gmap.has(c.group)) gmap.set(c.group, newId('g')); r.group = gmap.get(c.group); }
  }
  changed(false);
  toast(`${targets.length} Clip${targets.length > 1 ? 's' : ''} geteilt`);
}

// Bereich [a,b] in den Spuren entfernen; ripple = spätere Clips (und Hüllkurve) rücken nach
function removeRange(a, b, laneIds, ripple) {
  const d = b - a;
  for (const c of [...edl.clips]) {
    if (!laneIds.has(c.lane)) continue;
    if (c.start < b && c.start + c.len > a) {
      const r = splitClip(c, b);
      if (r && !laneIds.has(r.lane)) continue;
      splitClip(c, a);
    }
  }
  edl.clips = edl.clips.filter(c => !(laneIds.has(c.lane) && c.start >= a - 0.0005 && c.start + c.len <= b + 0.0005));
  if (!ripple) return;
  for (const c of edl.clips) if (laneIds.has(c.lane) && c.start >= b - 0.0005) c.start -= d;
  for (const id of laneIds) {
    const e = edl.tracks[id];
    if (!e?.env?.length) continue;
    const va = envDbAt(e.env, a), vb = envDbAt(e.env, b);
    const pts = e.env.filter(([t]) => t < a || t > b).map(([t, db]) => [t > b ? t - d : t, db]);
    if (Math.abs(va - vb) > 0.1) pts.push([Math.max(0, a - 0.001), va], [a, vb]);
    e.env = normEnv(pts);
  }
}

// mode: 'ripple' (gewählte Spuren), 'rippleAll' (alle Spuren), 'gap' (Lücke lassen)
function deleteEdit(mode) {
  const range = sel && Math.abs(sel.b - sel.a) > 0.01;
  if (!range && !selClips.size) return;
  snapshot();
  if (range) {
    const a = Math.min(sel.a, sel.b), b = Math.max(sel.a, sel.b);
    const lanes = mode === 'rippleAll' ? new Set(edl.laneOrder) : selLaneSet();
    removeRange(a, b, lanes, mode !== 'gap');
    if (mode === 'rippleAll') edl.markers = edl.markers.filter(m => m.t < a || m.t > b).map(m => (m.t > b ? { ...m, t: m.t - (b - a) } : m));
    sel = null; playhead = a;
    changed(false);
    toast(mode === 'gap' ? `${(b - a).toFixed(1)} s gelöscht (Lücke bleibt)` : `${(b - a).toFixed(1)} s herausgeschnitten${mode === 'rippleAll' ? ' (alle Spuren)' : ''}`);
    return;
  }
  // Ausgewählte Clips löschen
  const del = [...selClips].map(clipById).filter(Boolean);
  if (mode === 'gap') {
    edl.clips = edl.clips.filter(c => !selClips.has(c.id));
  } else if (mode === 'rippleAll') {
    // Zeitbereiche der Clips aus allen Spuren entfernen
    const ranges = mergeList(del.map(c => [c.start, c.start + c.len]));
    for (const [a, b] of ranges.reverse()) removeRange(a, b, new Set(edl.laneOrder), true);
  } else {
    // je Spur: Clips entfernen, spätere Clips der Spur rücken nach
    const byLane = new Map();
    for (const c of del) { if (!byLane.has(c.lane)) byLane.set(c.lane, []); byLane.get(c.lane).push([c.start, c.start + c.len]); }
    edl.clips = edl.clips.filter(c => !selClips.has(c.id));
    for (const [lane, rs] of byLane) for (const [a, b] of mergeList(rs).reverse()) removeRange(a, b, new Set([lane]), true);
  }
  selClips.clear();
  changed(false);
  toast(`${del.length} Clip${del.length > 1 ? 's' : ''} gelöscht${mode === 'gap' ? ' (Lücke bleibt)' : ''}`);
}

function groupClips() {
  const list = [...selClips].map(clipById).filter(Boolean);
  if (list.length < 2) { if (list.some(c => c.group)) ungroupClips(); return; }
  snapshot();
  const g = newId('g');
  const olds = new Set(list.map(c => c.group).filter(Boolean));
  for (const c of edl.clips) if (selClips.has(c.id) || (c.group && olds.has(c.group))) c.group = g;
  changed(false);
  toast(`${list.length} Clips gruppiert – werden jetzt gemeinsam ausgewählt, verschoben und gelöscht`);
}
function ungroupClips() {
  const list = [...selClips].map(clipById).filter(c => c && c.group);
  if (!list.length) return;
  snapshot();
  for (const c of list) c.group = null;
  changed(false);
  toast('Gruppe aufgelöst');
}

// Kontextmenü auf Clips
function clipMenu(x, y, hit) {
  if (!selClips.has(hit.clip.id)) selClips = expandSel(hit.clip);
  updateSelUi(); draw();
  const grouped = [...selClips].some(id => clipById(id)?.group);
  contextMenu(x, y, [
    { title: `${selClips.size} Clip${selClips.size > 1 ? 's' : ''}` },
    { label: 'Hier teilen (S)', icon: icon.scissors, action: () => { seek(hit.t, true); splitAtPlayhead(); } },
    { label: 'Audiodatei im Mediapool speichern …', icon: icon.folder, action: () => saveToPool(hit.clip) },
    { label: 'Fades entfernen', icon: icon.x, disabled: ![...selClips].some(id => { const c = clipById(id); return c && (c.fadeIn || c.fadeOut); }), action: () => { snapshot(); for (const id of selClips) { const c = clipById(id); if (c) { delete c.fadeIn; delete c.fadeOut; } } changed(false); } },
    { label: 'Lautstärke zurücksetzen (0 dB)', icon: icon.volOff ? icon.vol || icon.volOff : '', disabled: ![...selClips].some(id => +clipById(id)?.gainDb), action: () => { snapshot(); for (const id of selClips) { const c = clipById(id); if (c) delete c.gainDb; } applyClipGains(); changed(false); } },
    { label: 'Gruppieren (Strg+G)', icon: '⛓', disabled: selClips.size < 2, action: groupClips },
    ...(grouped ? [{ label: 'Gruppe auflösen (Strg+Umschalt+G)', icon: icon.x, action: ungroupClips }] : []),
    '-',
    { label: 'Löschen – Rest rückt nach (Entf)', icon: icon.trash, danger: true, action: () => deleteEdit('ripple') },
    { label: 'Löschen – Lücke lassen (Strg+Entf)', icon: icon.trash, danger: true, action: () => deleteEdit('gap') },
  ]);
}

// ---------- Wiedergabe je Spur ----------
// Pro Spur und Audiodatei ein <audio>-Element; in einer Spur läuft immer nur der Clip unter dem Abspielkopf
function getPlayer(tr, srcId) {
  let p = tr.players.get(srcId);
  if (p) return p;
  const s = sources.get(srcId);
  const el = new Audio();
  el.preload = 'metadata'; // lädt erst beim Abspielen richtig
  el.src = `/api/sessions/${sid}/tracks/${srcId}/audio?v=${s ? s.t.bytes : 0}`;
  p = { el, node: null };
  tr.players.set(srcId, p);
  connectPlayer(tr, p);
  return p;
}
function connectPlayer(tr, p) {
  if (p.node || !actx || !tr.fxNodes) return;
  p.node = actx.createMediaElementSource(p.el);
  p.g = actx.createGain();
  p.node.connect(p.g); p.g.connect(tr.fxNodes.in);
}
function clipAt(laneId, t) {
  const list = clipIndex.get(laneId) || [];
  let lo = 0, hi = list.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, c = list[mid];
    if (c.start <= t) { if (t < c.start + c.len) { found = c; } lo = mid + 1; } else hi = mid - 1;
  }
  if (found) return found;
  for (const c of list) if (c.start <= t && t < c.start + c.len) return c;
  return null;
}
function syncLane(tr, t, force, now, isMaster = false) {
  const c = clipAt(tr.id, t);
  if (!c) { if (tr.active) { tr.active.p.el.pause(); tr.active = null; } return; }
  const p = getPlayer(tr, c.src);
  setPlayerGain(p, c, t);
  const want = c.in + (t - c.start);
  if (!tr.active || tr.active.p !== p) {
    if (tr.active) tr.active.p.el.pause();
    tr.active = { clip: c, p };
    try { p.el.currentTime = want; } catch { /* lädt noch */ }
    p.el.play().catch(() => {});
    tr.lastSeek = now;
    return;
  }
  if (tr.active.clip !== c || force) {
    tr.active.clip = c;
    try { p.el.currentTime = want; } catch { /* egal */ }
    tr.lastSeek = now;
  } else if (!isMaster && !p.el.seeking && now - (tr.lastSeek || 0) > 400 && Math.abs(p.el.currentTime - want) > 0.06) {
    p.el.currentTime = want; tr.lastSeek = now;
  }
  if (p.el.paused) p.el.play().catch(() => {});
}

// ---------- Clip-Lautstärke ----------
const CG_MIN = -48, CG_MAX = 12, CG_SILENT = -120;
let gainHover = null, gainDragId = null;
const clipLin = c => { const db = +c.gainDb || 0; return db <= CG_SILENT + 1 ? 0 : Math.pow(10, db / 20); };
const fmtClipDb = db => (db <= CG_SILENT + 1 ? '−∞ dB' : (db > 0 ? '+' : db < 0 ? '−' : '') + Math.abs(db).toFixed(1) + ' dB');
// Linie: unten = still, 0 dB bei 80 % der Höhe, oben = +12 dB (unter der Namensleiste)
function clipGainY(db, top, bot) {
  const f = db <= CG_MIN ? 0 : (Math.min(CG_MAX, db) - CG_MIN) / (CG_MAX - CG_MIN);
  return bot - 3 - f * (bot - top - 21);
}
function clipDbFromY(y, top, bot) {
  const f = (bot - 3 - y) / (bot - top - 21);
  if (f <= 0.004) return CG_SILENT;
  return Math.min(CG_MAX, CG_MIN + f * (CG_MAX - CG_MIN));
}
function setPlayerGain(p, c, t = playhead) {
  if (!p.g || !actx) return;
  const lin = c ? clipLin(c) : 1;
  const fading = c && (fadeLen(c, 'in') > 0 || fadeLen(c, 'out') > 0);
  if (!fading) {
    if (p.gv === lin && !p.ramp) return;
    p.gv = lin; p.ramp = false;
    p.g.gain.cancelScheduledValues(actx.currentTime);
    p.g.gain.setTargetAtTime(lin, actx.currentTime, 0.012);
    return;
  }
  // Fade: kurze Vorausschau-Rampe (wie bei der Hüllkurve)
  const now = actx.currentTime, LA = 0.04;
  const v0 = lin * clipFadeGain(c, t), v1 = lin * clipFadeGain(c, t + (playing ? LA : 0));
  p.g.gain.cancelScheduledValues(now);
  p.g.gain.setValueAtTime(v0, now);
  p.g.gain.linearRampToValueAtTime(v1, now + LA);
  p.gv = null; p.ramp = true;
}
function applyClipGains() { for (const tr of tracks) if (tr.active) setPlayerGain(tr.active.p, tr.active.clip); }

// ---------- Fades ----------
let hoverClip = null, fadeDrag = null;
// Länge eines Fades, begrenzt auf die Cliplänge (in + out passen immer in den Clip)
function fadeLen(c, which) {
  const fi = Math.max(0, +c.fadeIn || 0), fo = Math.max(0, +c.fadeOut || 0);
  const k = fi + fo > c.len ? c.len / (fi + fo) : 1;
  return (which === 'in' ? fi : fo) * k;
}
// Viertelsinus – entspricht ffmpeg afade curve=qsin
function clipFadeGain(c, t) {
  const rel = t - c.start, fi = fadeLen(c, 'in'), fo = fadeLen(c, 'out');
  let g = 1;
  if (fi > 0 && rel < fi) g *= Math.sin(Math.PI / 2 * Math.max(0, rel / fi));
  if (fo > 0 && rel > c.len - fo) g *= Math.sin(Math.PI / 2 * Math.max(0, (c.len - rel) / fo));
  return g;
}
function drawClipFades(c, cl, xa, xb, top, bot, w, selected) {
  if (xb - xa <= 24) return;
  const fi = fadeLen(cl, 'in'), fo = fadeLen(cl, 'out');
  const h = bot - top;
  const drawFade = (x0, x1, rising) => {
    const n = Math.max(8, Math.min(60, Math.ceil(Math.abs(x1 - x0) / 3)));
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const f = i / n, g = Math.sin(Math.PI / 2 * (rising ? f : 1 - f));
      const x = x0 + (x1 - x0) * f, y = bot - g * h;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.save();
    c.lineTo(x1, top); c.lineTo(x0, top); c.closePath();
    c.fillStyle = 'rgba(8,10,14,.55)'; c.fill();
    c.restore();
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const f = i / n, g = Math.sin(Math.PI / 2 * (rising ? f : 1 - f));
      const x = x0 + (x1 - x0) * f, y = bot - g * h;
      i ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = 'rgba(255,255,255,.8)'; c.lineWidth = 1.5; c.stroke();
  };
  c.save();
  roundRect(c, xa, top, xb - xa, h, 6); c.clip();
  if (fi > 0) drawFade(xa, xa + fi * pps, true);
  if (fo > 0) drawFade(xb - fo * pps, xb, false);
  c.restore();
  // Griffe oben in den Ecken
  const show = hoverClip === cl.id || selected || fadeDrag?.ids?.has(cl.id);
  const handle = (x, on) => {
    if (x < -8 || x > w + 8) return;
    c.fillStyle = on ? '#ffffff' : 'rgba(255,255,255,.85)';
    c.strokeStyle = 'rgba(13,15,20,.9)'; c.lineWidth = 1;
    c.beginPath(); c.rect(Math.round(x) - 4.5, top + 1.5, 9, 9); c.fill(); c.stroke();
  };
  if (show || fi > 0) handle(Math.max(xa + 5, xa + fi * pps), fi > 0);
  if (show || fo > 0) handle(Math.min(xb - 5, xb - fo * pps), fo > 0);
  // Längenanzeige beim Ziehen
  if (fadeDrag && fadeDrag.clip === cl) {
    const len = fadeLen(cl, fadeDrag.which);
    const txt = `${fadeDrag.which === 'in' ? 'Fade-in' : 'Fade-out'} ${len.toFixed(2)} s`;
    c.font = '600 11px Inter, system-ui, sans-serif'; c.textBaseline = 'middle';
    const tw = c.measureText(txt).width + 12;
    const hx = fadeDrag.which === 'in' ? xa + len * pps + 8 : xb - len * pps - tw - 8;
    const bx = Math.max(2, Math.min(w - tw - 2, hx)), by = top + 16;
    c.fillStyle = 'rgba(13,15,20,.92)'; roundRect(c, bx, by, tw, 20, 5); c.fill();
    c.fillStyle = '#fff'; c.fillText(txt, bx + 6, by + 10.5);
  }
}
function clipFadeDrag(ev, hit, before) {
  const clip = hit.clip, which = hit.fade, key = which === 'in' ? 'fadeIn' : 'fadeOut';
  const targets = [...selClips].map(clipById).filter(Boolean);
  if (!targets.includes(clip)) targets.push(clip);
  if (ev.detail >= 2) {
    for (const c of targets) delete c[key];
    pushUndoSnapshot(before); changed(false);
    toast(`${which === 'in' ? 'Fade-in' : 'Fade-out'} entfernt`, { ms: 1500 });
    return;
  }
  fadeDrag = { clip, which, ids: new Set(targets.map(c => c.id)) };
  let moved = false;
  const startX = ev.clientX;
  const move = m => {
    if (!moved && Math.abs(m.clientX - startX) < 2) return;
    moved = true;
    const t = posToTime(m.clientX);
    let len = which === 'in' ? t - clip.start : clip.start + clip.len - t;
    len = Math.max(0, len);
    // Einrasten an der Abspielposition
    const snapT = which === 'in' ? clip.start + len : clip.start + clip.len - len;
    if (!(m.ctrlKey || m.metaKey) && Math.abs((snapT - playhead) * pps) < 8) len = which === 'in' ? playhead - clip.start : clip.start + clip.len - playhead;
    for (const c of targets) {
      const other = which === 'in' ? Math.max(0, +c.fadeOut || 0) : Math.max(0, +c.fadeIn || 0);
      const v = Math.min(Math.max(0, len), Math.max(0, c.len - other));
      if (v < 0.005) delete c[key]; else c[key] = Math.round(v * 1000) / 1000;
    }
    draw();
  };
  const up = () => {
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
    fadeDrag = null;
    if (moved) { pushUndoSnapshot(before); changed(false); } else draw();
  };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}

function clipGainDrag(ev, hit, laneIdx, before) {
  const clip = hit.clip;
  const targets = [...selClips].map(clipById).filter(Boolean);
  if (!targets.includes(clip)) targets.push(clip);
  if (ev.detail >= 2) {
    for (const c of targets) delete c.gainDb;
    applyClipGains();
    pushUndoSnapshot(before); changed(false);
    toast(`Lautstärke von ${targets.length > 1 ? targets.length + ' Clips' : 'Clip'} auf 0 dB zurückgesetzt`, { ms: 1800 });
    return;
  }
  const top = RULER + laneIdx * LANE + 4, bot = RULER + (laneIdx + 1) * LANE - 4;
  const base = new Map(targets.map(c => [c.id, Math.max(CG_MIN, +c.gainDb || 0)]));
  const ref = base.get(clip.id);
  const y0 = clipGainY(+clip.gainDb || 0, top, bot);
  const startY = ev.clientY;
  let moved = false;
  gainDragId = clip.id;
  const move = m => {
    let dy = m.clientY - startY;
    if (!moved && Math.abs(dy) < 2) return;
    moved = true;
    if (m.shiftKey) dy *= 0.2;
    let db = clipDbFromY(y0 + dy, top, bot);
    if (db > CG_SILENT && Math.abs(db) < 0.35) db = 0; // rastet bei 0 dB ein
    for (const c of targets) {
      if (db <= CG_SILENT) { c.gainDb = CG_SILENT; continue; }
      const v = Math.round((base.get(c.id) + db - ref) * 10) / 10;
      if (v <= CG_MIN) c.gainDb = CG_SILENT; else if (v === 0) delete c.gainDb; else c.gainDb = Math.min(CG_MAX, v);
    }
    applyClipGains();
    draw();
  };
  const up = () => {
    cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); cv.removeEventListener('pointercancel', up);
    gainDragId = null;
    if (moved) { pushUndoSnapshot(before); changed(false); } else draw();
  };
  cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
}

// ---------- Werkzeugleiste passt sich der Breite an ----------
function setupToolbarFit() {
  const tb = $('.transport');
  const levels = ['tb1', 'tb2', 'tb3', 'tb4'];
  let raf = 0;
  const fit = () => {
    raf = 0;
    tb.classList.remove(...levels);
    for (const l of levels) {
      if (tb.scrollWidth <= tb.clientWidth + 1) break;
      tb.classList.add(l);
    }
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(fit); };
  new ResizeObserver(schedule).observe(tb);
  window.addEventListener('resize', schedule);
  fit();
}

// ---------- Übersicht der Tastenkürzel ----------
function showShortcuts() {
  if (document.querySelector('.modal.keys')) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const C = mac ? '⌘' : 'Strg', A = mac ? '⌥' : 'Alt', S = mac ? '⇧' : 'Umschalt';
  const k = (...keys) => keys.map(x => `<span class="kbd">${x}</span>`).join(' + ');
  const sec = (title, rows) => `<div class="ks"><h4>${title}</h4>${rows.map(([keys, what]) => `<div class="kr"><span class="kk">${keys}</span><span>${what}</span></div>`).join('')}</div>`;
  const m = modal(`<h2>Tastenkürzel & Maus</h2>
    <div class="keys-grid">
      ${sec('Wiedergabe & Navigation', [
        [k('Leertaste'), 'Abspielen / Pause'],
        [k('←') + ' ' + k('→'), '5 s springen (mit ' + S + ': 1 s)'],
        [k('Pos1') + ' ' + k('Ende'), 'Anfang / Ende'],
        [k('+') + ' ' + k('−') + ' ' + k('0'), 'Zoom rein / raus / alles'],
        [k(C, 'Mausrad') + ' · Pinch', 'Zoom'],
        [k(A, 'Mausrad'), 'Spurhöhe (vertikaler Zoom)'],
        ['Mausrad · 2 Finger', 'Scrollen'],
        ['Klick ins Lineal', 'Abspielposition setzen'],
        [k('K'), 'Marker setzen'],
      ])}
      ${sec('Auswahl & Clips', [
        ['Klick auf Clip', 'Clip wählen (mit Gruppe)'],
        [k(A) + ' + Klick', 'nur diesen Clip wählen'],
        [k(S) + ' / ' + k(C) + ' + Klick', 'zur Auswahl hinzufügen'],
        ['Im Zeitlineal ziehen', 'Zeitbereich wählen (markierte Spuren, sonst alle)'],
        ['Klick auf Spurkopf', 'Spur markieren (' + C + ' / ' + S + ' = mehrere)'],
        [k(S) + ' + Klick ins Lineal', 'Zeitauswahl erweitern'],
        ['Leerfläche ziehen', 'Bereich wählen (über mehrere Spuren)'],
        [k(C, 'A'), 'alle Clips wählen'],
        ['Clip ziehen', 'verschieben (auch in andere Spur)'],
        [k(A) + ' + Ziehen', 'Clip kopieren'],
        ['Kante ziehen', 'Clip kürzen / verlängern'],
        ['Linie im Clip ziehen', 'Clip lauter / leiser (' + S + ' = fein)'],
        ['Doppelklick auf Linie', 'Clip-Lautstärke auf 0 dB'],
        [k(C) + ' beim Ziehen', 'Einrasten aus'],
      ])}
      ${sec('Schneiden', [
        [k('S'), 'Clips an der Abspielposition teilen'],
        [k('Entf'), 'Ripple: löschen, gewählte Spuren rücken nach'],
        [k(S, 'Entf'), 'Ripple über alle Spuren'],
        [k(C, 'Entf'), 'löschen, Lücke bleibt'],
        [k(C, 'G'), 'Clips gruppieren'],
        [k(C, S, 'G'), 'Gruppe auflösen'],
        [k('M'), 'Bereich stillstellen (Hüllkurve)'],
      ])}
      ${sec('Spuren, Effekte & Sonstiges', [
        [k('H'), 'Hüllkurve der Spur ein/aus'],
        ['Klick auf Hüllkurve', 'Punkt setzen'],
        ['Doppelklick auf Punkt', 'Punkt löschen'],
        [k('B'), 'alle Effekte an/aus (Vergleich)'],
        ['Farbstreifen am Spurkopf', 'Spurfarbe ändern'],
        ['Rechtsklick Spurkopf', 'Spurmenü (neue Spur, Gruppe …)'],
        ['Rechtsklick auf Clip', 'Clipmenü'],
        [k(C, 'Z') + ' / ' + k(C, S, 'Z'), 'Rückgängig / Wiederholen'],
        [k('?'), 'diese Übersicht'],
      ])}
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn primary" data-close>Schließen</button></div>`);
  m.querySelector('.modal').classList.add('keys');
  m.querySelector('[data-close]').onclick = () => m.close();
}

// ---------- Mediapool (projektübergreifend: Intros, Outros, Jingles, Soundeffekte) ----------
const POOL_MIME = 'application/x-ps-pool';
const POOL_CATS = ['Intro', 'Outro', 'Jingle', 'Soundeffekt', 'Musik', 'Sonstiges'];
let pool = [], poolOpen = false, poolFilter = '', poolPrev = null, poolDropHint = null, poolDragItem = null;
const fmtDur = d => (d == null ? '–' : d < 60 ? d.toFixed(1) + ' s' : fmtTime(d));

async function openPool() {
  closeFx();
  poolOpen = true;
  $('#poolPanel').classList.remove('hidden');
  $('#poolBtn').classList.add('on');
  renderPool(true);
  try { pool = await api('/api/library'); } catch (e) { toast(e.message, { error: true }); }
  renderPool();
}
function closePool() {
  poolOpen = false;
  stopPoolPreview();
  $('#poolPanel').classList.add('hidden');
  $('#poolBtn').classList.remove('on');
}
function stopPoolPreview() {
  if (poolPrev) { poolPrev.el.pause(); poolPrev = null; }
  $$('#poolPanel .pi-play').forEach(b => { b.innerHTML = icon.play; b.classList.remove('on'); });
}
function renderPool(loading = false) {
  const panel = $('#poolPanel');
  const q = poolFilter.trim().toLowerCase();
  const items = pool.filter(it => !q || it.name.toLowerCase().includes(q) || it.category.toLowerCase().includes(q));
  const groups = POOL_CATS.map(cat => [cat, items.filter(it => it.category === cat)]).filter(([, l]) => l.length);
  panel.innerHTML = `
    <div class="fx-head"><h3>${icon.folder}Mediapool</h3><div class="grow"></div><button class="btn sm icon" data-a="close" title="Schließen">${icon.x}</button></div>
    <div class="pool-tools">
      <input type="search" data-a="q" placeholder="Suchen …" value="${esc(poolFilter)}">
      <label class="btn sm primary" title="MP3/WAV/M4A in den Mediapool laden">${icon.upload}<span>Hinzufügen</span><input type="file" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.aac" multiple hidden data-a="file"></label>
    </div>
    <div class="pool-hint">In allen Projekten verfügbar. Auf die Zeitachse ziehen oder „Einfügen“ (an der Abspielposition, in eine freie Zusatzspur).</div>
    <div class="pool-list">${loading ? '<div class="muted pool-empty">Lade …</div>' : !pool.length
      ? `<div class="pool-empty"><b>Noch leer.</b><br>Intro, Outro, Jingles oder Soundeffekte hierher ziehen oder über „Hinzufügen“ laden.</div>`
      : !groups.length ? '<div class="muted pool-empty">Nichts gefunden.</div>'
      : groups.map(([cat, l]) => `<div class="pool-cat">${esc(cat)} <span>${l.length}</span></div>` + l.map(it => `
        <div class="pool-item" draggable="true" data-id="${esc(it.id)}" title="Ziehen = auf die Zeitachse legen">
          <button class="pi-play ${poolPrev?.id === it.id ? 'on' : ''}" data-a="play" title="Vorhören">${poolPrev?.id === it.id ? icon.stop : icon.play}</button>
          <div class="pi-main"><div class="pi-name" translate="no">${esc(it.name)}</div><div class="pi-meta">${fmtDur(it.duration)}</div></div>
          <button class="btn sm" data-a="ins" title="An der Abspielposition einfügen">Einfügen</button>
          <button class="btn sm icon" data-a="more" title="Umbenennen, Kategorie, Löschen">⋯</button>
        </div>`).join('')).join('')}
    </div>`;
  $('[data-a=close]', panel).onclick = closePool;
  const qi = $('[data-a=q]', panel);
  qi.oninput = () => { poolFilter = qi.value; const pos = qi.selectionStart; renderPool(); const n = $('#poolPanel [data-a=q]'); n.focus(); n.setSelectionRange(pos, pos); };
  $('[data-a=file]', panel).onchange = e => { const fs = [...e.target.files]; e.target.value = ''; addToPool(fs); };
  for (const row of $$('.pool-item', panel)) {
    const it = pool.find(x => x.id === row.dataset.id);
    $('[data-a=play]', row).onclick = () => togglePoolPreview(it);
    $('[data-a=ins]', row).onclick = () => insertFromPool(it.id, null, Math.max(0, playhead));
    $('[data-a=more]', row).onclick = e => poolItemMenu(e.clientX, e.clientY, it);
    row.oncontextmenu = e => { e.preventDefault(); poolItemMenu(e.clientX, e.clientY, it); };
    row.ondblclick = e => { if (!e.target.closest('button')) insertFromPool(it.id, null, Math.max(0, playhead)); };
    row.ondragstart = e => { poolDragItem = it; e.dataTransfer.setData(POOL_MIME, it.id); e.dataTransfer.setData('text/plain', it.name); e.dataTransfer.effectAllowed = 'copy'; row.classList.add('dragging'); };
    row.ondragend = () => { poolDragItem = null; poolDropHint = null; row.classList.remove('dragging'); draw(); };
  }
  // Dateien direkt auf den Pool ziehen
  panel.ondragover = e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); panel.classList.add('dropping'); } };
  panel.ondragleave = e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('dropping'); };
  panel.ondrop = e => {
    panel.classList.remove('dropping');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    addToPool([...e.dataTransfer.files]);
  };
}
function togglePoolPreview(it) {
  const same = poolPrev?.id === it.id;
  stopPoolPreview();
  if (same) return;
  const el = new Audio(`/api/library/${it.id}/audio`);
  el.volume = 0.9;
  poolPrev = { id: it.id, el };
  el.onended = () => { if (poolPrev?.el === el) stopPoolPreview(); };
  el.play().catch(e => toast('Vorhören nicht möglich: ' + e.message, { error: true }));
  const b = $(`#poolPanel .pool-item[data-id="${CSS.escape(it.id)}"] .pi-play`);
  if (b) { b.innerHTML = icon.stop; b.classList.add('on'); }
}
async function addToPool(files) {
  const list = files.filter(f => /^audio\//.test(f.type) || /\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(f.name));
  if (!list.length) { toast('Bitte Audiodateien wählen (MP3, WAV, M4A …)', { error: true }); return; }
  for (const f of list) {
    toast(`Lade „${f.name}“ in den Mediapool …`, { ms: 1800 });
    try {
      const it = await api('/api/library', { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name) } });
      pool.push(it);
      toast(`„${it.name}“ liegt jetzt im Mediapool (${it.category})`);
    } catch (e) { toast(`${f.name}: ${e.message}`, { error: true }); }
  }
  pool = await api('/api/library').catch(() => pool);
  if (poolOpen) renderPool();
}
function poolItemMenu(x, y, it) {
  contextMenu(x, y, [
    { title: it.name },
    { label: 'An Abspielposition einfügen', icon: icon.plus, action: () => insertFromPool(it.id, null, Math.max(0, playhead)) },
    { label: 'Als neue Spur einfügen', icon: icon.plus, action: () => insertFromPool(it.id, '__new', Math.max(0, playhead)) },
    { label: 'Umbenennen …', icon: icon.edit, action: async () => {
      const n = prompt('Name im Mediapool', it.name);
      if (!n || !n.trim()) return;
      try { Object.assign(it, await api(`/api/library/${it.id}`, { method: 'PATCH', body: { name: n } })); renderPool(); } catch (e) { toast(e.message, { error: true }); }
    } },
    '-',
    { title: 'Kategorie' },
    ...POOL_CATS.map(cat => ({ label: (cat === it.category ? '✓ ' : '  ') + cat, action: async () => {
      try { Object.assign(it, await api(`/api/library/${it.id}`, { method: 'PATCH', body: { category: cat } })); renderPool(); } catch (e) { toast(e.message, { error: true }); }
    } })),
    '-',
    { label: 'Aus dem Mediapool löschen …', icon: icon.trash, danger: true, action: async () => {
      if (!await confirmDialog(`„${it.name}“ aus dem Mediapool löschen? Projekte, in denen die Datei schon verwendet wird, behalten ihre Kopie.`, { ok: 'Löschen', danger: true })) return;
      try { await api(`/api/library/${it.id}`, { method: 'DELETE' }); if (poolPrev?.id === it.id) stopPoolPreview(); pool = pool.filter(x => x !== it); renderPool(); } catch (e) { toast(e.message, { error: true }); }
    } },
  ]);
}
async function insertFromPool(id, laneId, start) {
  const it = pool.find(x => x.id === id);
  toast(`Füge „${it ? it.name : 'Audio'}“ ein …`, { ms: 1200 });
  try {
    const t = await api(`/api/sessions/${sid}/fromlibrary`, { method: 'POST', body: { id, clientId: myClient } });
    if (laneId === '__new') await addSourceClip(t, null, start);
    else await addSourceClip(t, laneId, start, { reuseFree: !laneId });
  } catch (e) { toast(e.message, { error: true }); }
}
// Ziel beim Ziehen aus dem Pool: Spur unter dem Mauszeiger (oder neue Spur darunter) und Zeitpunkt
function poolDropTarget(e) {
  const heads = $('#heads');
  if (heads.contains(e.target)) {
    const h = e.target.closest('.head');
    return { lane: h ? h.dataset.tid : '__new', li: h ? tracks.findIndex(t => t.id === h.dataset.tid) : null, t: Math.max(0, playhead) };
  }
  const r = cv.getBoundingClientRect();
  const y = e.clientY - r.top;
  let t = Math.max(0, posToTime(e.clientX));
  if (Math.abs((t - playhead) * pps) < 8) t = playhead;
  if (y < RULER) return { lane: null, li: null, t, auto: true };
  const li = Math.floor((y - RULER) / LANE);
  if (li >= 0 && li < tracks.length) return { lane: tracks[li].id, li, t };
  return { lane: '__new', li: null, t };
}
function poolDragOver(e) {
  const at = poolDropTarget(e);
  const it = poolDragItem;
  const hint = { li: at.li, t: at.t, len: it?.duration || 3, name: it?.name || 'Audio' };
  if (!poolDropHint || poolDropHint.li !== hint.li || Math.abs(poolDropHint.t - hint.t) > 0.005) { poolDropHint = hint; draw(); }
}
async function saveToPool(clip) {
  const src = sources.get(clip.src);
  const n = prompt('Name im Mediapool', src ? src.t.name : 'Audio');
  if (n == null) return;
  try {
    const it = await api('/api/library/fromsession', { method: 'POST', body: { sid, trackId: clip.src, name: n.trim() || (src ? src.t.name : 'Audio') } });
    toast(`„${it.name}“ im Mediapool gespeichert (${it.category}) – ab jetzt in jedem Projekt verfügbar`);
    if (poolOpen) { pool = await api('/api/library'); renderPool(); }
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------- Pegelanzeigen (Spuren + Summe) ----------
const MET_MIN = -60, MET_MAX = 3;
let metBuf = null, metLast = 0, metIdle = true;
const masterMet = [{}, {}];
// Nur neu zeichnen, wenn sich sichtbar etwas geändert hat
function metChanged(st) {
  const k = Math.round((st.peak ?? -120) * 2) + ':' + Math.round((st.rms ?? -120) * 2) + ':' + Math.round((st.hold ?? -120) * 2) + ':' + (st.clip ? 1 : 0);
  if (k === st.key) return false;
  st.key = k; return true;
}
function readLevel(an, st, now, dt) {
  if (!metBuf || metBuf.length !== an.fftSize) metBuf = new Float32Array(an.fftSize);
  let peak = 0, sum = 0;
  if (playing) {
    an.getFloatTimeDomainData(metBuf);
    for (let i = 0; i < metBuf.length; i++) { const v = Math.abs(metBuf[i]); if (v > peak) peak = v; sum += metBuf[i] * metBuf[i]; }
  }
  const pDb = peak > 0 ? 20 * Math.log10(peak) : -120;
  const rDb = sum > 0 ? 10 * Math.log10(sum / metBuf.length) : -120;
  const fall = 24 * dt; // dB pro Sekunde Rückfall
  st.peak = Math.max(pDb, (st.peak ?? -120) - fall);
  st.rms = Math.max(rDb, (st.rms ?? -120) - fall);
  if (pDb >= (st.hold ?? -120) || now - (st.holdT || 0) > 1500) { st.hold = pDb; st.holdT = now; }
  if (pDb > -0.1) st.clipT = now;
  st.clip = st.clipT && now - st.clipT < 2000;
  return st.peak > -90 || st.clip;
}
const metPos = (db, len) => Math.max(0, Math.min(1, (db - MET_MIN) / (MET_MAX - MET_MIN))) * len;
let metGrad = new Map();
function meterGradient(c, horiz, len, key) {
  const k = key + ':' + horiz + ':' + Math.round(len);
  let g = metGrad.get(k);
  if (g) return g;
  g = horiz ? c.createLinearGradient(0, 0, len, 0) : c.createLinearGradient(0, len, 0, 0);
  const at = db => (db - MET_MIN) / (MET_MAX - MET_MIN);
  g.addColorStop(0, '#2fbf71'); g.addColorStop(at(-18), '#3ddc97'); g.addColorStop(at(-12), '#c8e04a');
  g.addColorStop(at(-6), '#ffd166'); g.addColorStop(at(-2), '#ff9f43'); g.addColorStop(at(0), '#ff4d6d'); g.addColorStop(1, '#ff4d6d');
  if (metGrad.size > 60) metGrad.clear();
  metGrad.set(k, g);
  return g;
}
// Zeichnet 1..n Balken (waagerecht oder senkrecht) in eine Canvas
function drawMeter(cvEl, states, { horiz = true, ticks = false } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = cvEl.clientWidth, H = cvEl.clientHeight;
  if (!W || !H) return;
  if (cvEl.width !== Math.round(W * dpr) || cvEl.height !== Math.round(H * dpr)) { cvEl.width = Math.round(W * dpr); cvEl.height = Math.round(H * dpr); }
  const c = cvEl.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const n = states.length, gap = n > 1 ? 2 : 0;
  const tickSpace = ticks ? (horiz ? (H >= 30 ? 11 : 0) : 22) : 0;
  const len = horiz ? W : H;
  const thick = ((horiz ? H - tickSpace : W - tickSpace) - gap * (n - 1)) / n;
  const grad = meterGradient(c, horiz, len, 'm');
  states.forEach((st, i) => {
    const o = i * (thick + gap) + (horiz ? 0 : tickSpace);
    // Hintergrund
    c.fillStyle = '#0b0d12';
    if (horiz) c.fillRect(0, o, W, thick); else c.fillRect(o, 0, thick, H);
    c.fillStyle = 'rgba(255,255,255,.05)';
    const z = metPos(0, len);
    if (horiz) c.fillRect(z, o, 1, thick); else c.fillRect(o, H - z, thick, 1);
    // RMS kräftig, Spitze heller
    const pk = metPos(st.peak ?? -120, len), rm = metPos(st.rms ?? -120, len);
    c.fillStyle = grad;
    c.globalAlpha = 0.45;
    if (horiz) c.fillRect(0, o, pk, thick); else c.fillRect(o, H - pk, thick, pk);
    c.globalAlpha = 1;
    if (horiz) c.fillRect(0, o, rm, thick); else c.fillRect(o, H - rm, thick, rm);
    // Spitzenwert-Halten
    if ((st.hold ?? -120) > MET_MIN) {
      const hp = metPos(st.hold, len);
      c.fillStyle = st.hold > -0.1 ? '#ff4d6d' : st.hold > -6 ? '#ffd166' : '#d6dbe8';
      if (horiz) c.fillRect(Math.min(W - 2, hp), o, 2, thick); else c.fillRect(o, Math.max(0, H - hp - 1), thick, 2);
    }
    // Übersteuerung
    if (st.clip) {
      c.fillStyle = '#ff4d6d';
      if (horiz) c.fillRect(W - 3, o, 3, thick); else c.fillRect(o, 0, thick, 3);
    }
  });
  if (ticks && horiz && tickSpace) {
    c.font = '9px ui-monospace, Menlo, monospace'; c.textBaseline = 'bottom';
    for (const db of [0, -6, -12, -24, -48]) {
      const x = metPos(db, W);
      c.fillStyle = 'rgba(255,255,255,.12)'; c.fillRect(Math.round(x), H - tickSpace, 1, 3);
      c.fillStyle = db === 0 ? '#ff8a96' : '#6b7390';
      c.textAlign = db === 0 ? 'right' : 'center';
      c.fillText(String(db), db === 0 ? Math.min(W, x + 6) : x, H);
    }
  }
  if (ticks && !horiz) {
    c.font = '9.5px ui-monospace, Menlo, monospace'; c.textBaseline = 'middle'; c.textAlign = 'right';
    for (const db of [0, -6, -12, -18, -24, -36, -48]) {
      const y = H - metPos(db, H);
      c.fillStyle = db === 0 ? '#ff8a96' : '#6b7390';
      c.fillText(String(db), tickSpace - 5, Math.max(5, Math.min(H - 5, y)));
      c.fillStyle = 'rgba(255,255,255,.08)'; c.fillRect(tickSpace - 3, Math.round(y), 2, 1);
    }
  }
}
const MET_INTERVAL = 40; // ms → 25 Bilder/s reichen fürs Auge und sparen Akku
function updateLevelMeters(now) {
  if (metLast && now - metLast < MET_INTERVAL) return;
  const dt = metLast ? Math.min(0.15, (now - metLast) / 1000) : 0.04;
  metLast = now;
  if (!actx || !master) return;
  if (!playing && metIdle) return;
  let active = false;
  for (const tr of tracks) {
    if (!tr.fxNodes?.an) continue;
    tr.met = tr.met || {};
    if (readLevel(tr.fxNodes.an, tr.met, now, dt)) active = true;
    if (!tr.lvlEl || !tr.lvlEl.isConnected) tr.lvlEl = $(`.head[data-tid="${CSS.escape(tr.id)}"] canvas.lvl`);
    if (tr.lvlEl && metChanged(tr.met)) drawMeter(tr.lvlEl, [tr.met], { horiz: true });
  }
  master.an.forEach((an, i) => { if (readLevel(an, masterMet[i], now, dt)) active = true; });
  const mchg = metChanged(masterMet[0]) | metChanged(masterMet[1]);
  const mv = $('#mmCv');
  if (mchg && mv && mv.offsetParent) drawMeter(mv, masterMet, { horiz: false, ticks: true });
  const mb = $('#mmBar');
  if (mchg && mb && mb.offsetParent) drawMeter(mb, masterMet, { horiz: true, ticks: true });
  const pk = Math.max(masterMet[0].hold ?? -120, masterMet[1].hold ?? -120);
  const rd = $('#mmRead');
  if (rd) {
    rd.textContent = pk > -90 ? (pk > 0 ? '+' : '') + pk.toFixed(1) + ' dB' : '−∞';
    rd.classList.toggle('clip', !!(masterMet[0].clip || masterMet[1].clip));
  }
  metIdle = !playing && !active;
}
function resetClipLeds() {
  for (const st of masterMet) { st.clipT = 0; st.clip = false; st.hold = -120; }
  for (const tr of tracks) if (tr.met) { tr.met.clipT = 0; tr.met.clip = false; }
  metIdle = false;
}

// ---------- Spuren markieren (Klick auf den Spurkopf) ----------
function selectTrack(tr, ev) {
  const mod = ev.ctrlKey || ev.metaKey;
  if (ev.shiftKey && lastSelTrack && edl.tracks[lastSelTrack]) {
    const i0 = edl.laneOrder.indexOf(lastSelTrack), i1 = edl.laneOrder.indexOf(tr.id);
    if (!mod) selTracks.clear();
    for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) selTracks.add(edl.laneOrder[i]);
  } else if (mod) {
    if (selTracks.has(tr.id)) selTracks.delete(tr.id); else selTracks.add(tr.id);
    lastSelTrack = tr.id;
  } else {
    selTracks = selTracks.size === 1 && selTracks.has(tr.id) ? new Set() : new Set([tr.id]);
    lastSelTrack = tr.id;
  }
  markHeads(); updateSelUi(); draw();
}
function markHeads() {
  for (const h of $$('#heads .head')) h.classList.toggle('selected', selTracks.has(h.dataset.tid));
}

// ---------- Spurhöhe (vertikaler Zoom) ----------
function setLaneHeight(h, anchorClientY) {
  const wrap = $('#tlWrap');
  const old = LANE;
  const def = !h;
  const nh = def ? laneDefault() : Math.round(Math.max(LANE_MIN, Math.min(LANE_MAX, h)));
  if (nh === old && !def) return;
  // Stelle unter dem Mauszeiger (bzw. obere Kante) bleibt an ihrem Platz
  const wr = wrap.getBoundingClientRect();
  const off = anchorClientY != null ? Math.max(0, anchorClientY - wr.top) : 0;
  const lanePos = Math.max(0, (wrap.scrollTop + off - RULER) / old);
  try { if (def) localStorage.removeItem(laneKey()); else localStorage.setItem(laneKey(), String(nh)); } catch { /* egal */ }
  updateLaneHeight();
  renderHeads(); renderAll();
  wrap.scrollTop = Math.max(0, lanePos * LANE + RULER - off);
  updateBars();
  $('#vZoomOut').disabled = LANE <= LANE_MIN;
  $('#vZoomIn').disabled = LANE >= LANE_MAX;
}

// Test-/Debug-Zugriff (nur lesend gedacht)
if (new URLSearchParams(location.search).has('debug')) window.__ed = { get LANE() { return LANE; }, setLaneHeight, get selTracks() { return selTracks; }, get master() { return master; }, masterMet, insertFromPool, openPool, get pool() { return pool; }, applyClipGains, showShortcuts, get pps() { return pps; }, get edl() { return edl; }, get tracks() { return tracks; }, get selClips() { return selClips; }, set selClips(v) { selClips = v; }, get sel() { return sel; }, set sel(v) { sel = v; }, get playhead() { return playhead; }, seek, splitAtPlayhead, deleteEdit, groupClips, ungroupClips, addLane, changed, renderAll, updateSelUi, expandSel, clipById, colorMenu, openTrackMenu, saveNow };
