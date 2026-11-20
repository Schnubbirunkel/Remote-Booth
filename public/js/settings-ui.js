// Ersteinrichtung, Einstellungen und Ordnerauswahl (Dateibrowser auf dem Server)
import { $, $$, esc, api, toast, modal, icon } from './common.js';
import { LANGS, currentLang, setLang, t } from './i18n.js';

// ---------- Ordnerauswahl ----------
export function pickFolder(start = '', { title = 'Ordner wählen' } = {}) {
  return new Promise(resolve => {
    let chosen = null;
    const m = modal(`
      <h2>${esc(title)}</h2>
      <div class="fp-path mono" data-path translate="no"></div>
      <div class="fp-list" data-list><div class="muted fp-empty">Lädt …</div></div>
      <div class="fp-state" data-state></div>
      <div class="row fp-actions">
        <button class="btn" data-mk>${icon.plus}Neuer Ordner</button>
        <div class="grow"></div>
        <button class="btn" data-x>Abbrechen</button>
        <button class="btn primary" data-ok disabled>Diesen Ordner wählen</button>
      </div>`, { onClose: () => resolve(chosen) });
    m.querySelector('.modal').classList.add('fp');
    let cur = '';
    const show = async dir => {
      let r;
      try { r = await api('/api/fs' + (dir ? '?path=' + encodeURIComponent(dir) : '')); }
      catch (e) { toast(e.message, { error: true }); if (dir) return show(''); return; }
      cur = r.path;
      const pe = $('[data-path]', m); pe.textContent = cur || t('Speicherorte');
      const items = [];
      if (cur) items.push(`<button class="fp-item up" data-go="${esc(r.parent || '')}">${icon.back || '↑'}<span>..</span></button>`);
      for (const d of r.dirs) items.push(`<button class="fp-item" data-go="${esc(d.path)}">${icon.folder}<span translate="no">${esc(d.name)}</span></button>`);
      $('[data-list]', m).innerHTML = items.join('') || '<div class="muted fp-empty">Keine Unterordner</div>';
      for (const b of $$('[data-go]', m)) b.onclick = () => show(b.dataset.go);
      const st = $('[data-state]', m);
      if (!cur) st.innerHTML = '<span class="muted">Wähle einen Speicherort. Netzlaufwerke findest du unter /media.</span>';
      else if (r.writable) st.innerHTML = '<span class="badge ok">beschreibbar</span>';
      else st.innerHTML = `<span class="badge warn">nicht beschreibbar</span> <span class="muted">${esc(r.why || '')}</span>`;
      $('[data-ok]', m).disabled = !cur || !r.writable;
      $('[data-mk]', m).disabled = !cur;
    };
    $('[data-x]', m).onclick = () => m.close();
    $('[data-ok]', m).onclick = () => { chosen = cur; m.close(); };
    $('[data-mk]', m).onclick = async () => {
      const name = prompt('Name des neuen Ordners');
      if (!name) return;
      try { const r = await api('/api/fs/mkdir', { method: 'POST', body: { path: cur, name } }); show(r.path); }
      catch (e) { toast(e.message, { error: true }); }
    };
    // Mit dem Ordner beginnen, der schon eingestellt ist (falls erreichbar)
    show(start || '').catch(() => show(''));
  });
}

const FOLDERS = [
  { key: 'recordingsDir', label: 'Aufnahmen', hint: 'Projekte mit den aufgenommenen Spuren (je Projekt ein Unterordner)' },
  { key: 'exportDir', label: 'Exporte', hint: 'Fertige MP3s – je Projekt ein Unterordner mit dem Projektnamen' },
  { key: 'libraryDir', label: 'Mediapool', hint: 'Intros, Outros, Jingles und Soundeffekte für alle Projekte' },
];

function folderRows(values) {
  return FOLDERS.map(f => {
    const v = values[f.key] || {};
    const p = typeof v === 'string' ? v : v.path || '';
    const bad = typeof v === 'object' && v.ok === false;
    return `<div class="st-folder" data-key="${f.key}">
      <div class="st-fl"><b>${esc(f.label)}</b><span class="muted">${esc(f.hint)}</span></div>
      <div class="row st-fv"><span class="mono st-path" data-p translate="no">${esc(p)}</span>${bad ? `<span class="badge warn" title="${esc(v.why || '')}">nicht erreichbar</span>` : ''}
        <button type="button" class="btn sm" data-pick>${icon.folder}Ändern …</button></div>
    </div>`;
  }).join('');
}
function wireFolderRows(root, values) {
  for (const row of $$('.st-folder', root)) {
    const key = row.dataset.key, f = FOLDERS.find(x => x.key === key);
    $('[data-pick]', row).onclick = async () => {
      const cur = typeof values[key] === 'string' ? values[key] : values[key]?.path;
      const p = await pickFolder(cur, { title: `Ordner für ${f.label}` });
      if (!p) return;
      values[key] = p;
      $('[data-p]', row).textContent = p;
      row.dataset.changed = '1';
      const b = $('.badge', row); if (b) b.remove();
    };
  }
}
const langOptions = sel => [['', 'Automatisch (Browser)'], ...LANGS.map(l => [l.code, l.name])]
  .map(([c, n]) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');

// ---------- Ersteinrichtung ----------
export function renderSetup(el, cfg) {
  const values = { ...(cfg.defaults || {}) };
  el.innerHTML = `
    <form class="card col setup" id="setupForm">
      <div class="brand">${cfg.brandHtml || ''}</div>
      <div><h1>Willkommen bei Remote Booth</h1>
      <p class="muted">Ein paar Einstellungen, dann kann es losgehen. Alles lässt sich später unter „Einstellungen“ ändern.</p></div>
      <label class="field">Sprache<select id="setupLang">${langOptions(currentLang(true))}</select></label>
      <fieldset class="col st-group"><legend>Zugang</legend>
        <label class="field">Passwort<input type="password" id="setupPw" autocomplete="new-password" minlength="6"></label>
        <label class="field">Passwort wiederholen<input type="password" id="setupPw2" autocomplete="new-password"></label>
        <label class="check"><input type="checkbox" id="setupNoPw"> Ohne Passwort (nur sinnvoll, wenn die App ausschließlich im Heimnetz erreichbar ist)</label>
      </fieldset>
      <fieldset class="col st-group"><legend>Speicherorte</legend>${folderRows(values)}</fieldset>
      <button class="btn primary" id="setupGo">Einrichtung abschließen</button>
    </form>`;
  wireFolderRows(el, values);
  $('#setupLang', el).onchange = e => { setLang(e.target.value); location.reload(); };
  $('#setupNoPw', el).onchange = e => { $('#setupPw', el).disabled = $('#setupPw2', el).disabled = e.target.checked; };
  $('#setupForm', el).onsubmit = async e => {
    e.preventDefault();
    const noPassword = $('#setupNoPw', el).checked;
    const pw = $('#setupPw', el).value;
    if (!noPassword && pw.length < 6) return toast('Das Passwort muss mindestens 6 Zeichen lang sein.', { error: true });
    if (!noPassword && pw !== $('#setupPw2', el).value) return toast('Die beiden Passwörter stimmen nicht überein.', { error: true });
    const body = { language: $('#setupLang', el).value, noPassword, password: noPassword ? '' : pw };
    for (const f of FOLDERS) body[f.key] = typeof values[f.key] === 'string' ? values[f.key] : values[f.key]?.path;
    try { await api('/api/setup', { method: 'POST', body }); location.reload(); }
    catch (err) { toast(err.message, { error: true }); }
  };
}

// ---------- Einstellungen ----------
export async function openSettings() {
  let s;
  try { s = await api('/api/settings'); } catch (e) { return toast(e.message, { error: true }); }
  const values = { recordingsDir: s.recordingsDir, exportDir: s.exportDir, libraryDir: s.libraryDir };
  const m = modal(`
    <h2>Einstellungen</h2>
    <div class="col" style="gap:18px">
      <label class="field">Sprache<select data-lang>${langOptions(s.language)}</select></label>
      <fieldset class="col st-group"><legend>Speicherorte</legend>${folderRows(values)}
        <p class="muted st-note">Ein neuer Aufnahmeordner gilt für neue Aufnahmen; bestehende Projekte bleiben, wo sie sind, und weiterhin sichtbar. Der Mediapool zieht in den neuen Ordner um.</p>
      </fieldset>
      <fieldset class="col st-group"><legend>Passwort</legend>
        ${s.passwordFromEnv ? '<p class="muted">Das Passwort ist über die Umgebungsvariable APP_PASSWORD festgelegt und lässt sich hier nicht ändern.</p>' : `
        ${s.hasPassword ? '<label class="field">Aktuelles Passwort<input type="password" data-cur autocomplete="current-password"></label>' : ''}
        <label class="field">Neues Passwort<input type="password" data-new autocomplete="new-password"></label>
        <label class="field">Neues Passwort wiederholen<input type="password" data-new2 autocomplete="new-password"></label>
        <p class="muted st-note">Leer lassen, um das Passwort nicht zu ändern.</p>`}
      </fieldset>
      <p class="muted st-note">Remote Booth ${esc(s.version)}</p>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px;gap:8px">
      <button class="btn" data-x>Abbrechen</button><button class="btn primary" data-save>Speichern</button>
    </div>`);
  m.querySelector('.modal').classList.add('settings');
  wireFolderRows(m, values);
  $('[data-x]', m).onclick = () => m.close();
  $('[data-save]', m).onclick = async () => {
    const body = { language: $('[data-lang]', m).value };
    for (const row of $$('.st-folder[data-changed]', m)) body[row.dataset.key] = values[row.dataset.key];
    const nw = $('[data-new]', m)?.value || '';
    if (nw) {
      if (nw.length < 6) return toast('Das Passwort muss mindestens 6 Zeichen lang sein.', { error: true });
      if (nw !== $('[data-new2]', m).value) return toast('Die beiden Passwörter stimmen nicht überein.', { error: true });
      body.newPassword = nw; body.currentPassword = $('[data-cur]', m)?.value || '';
    }
    try {
      await api('/api/settings', { method: 'PATCH', body });
      const langChanged = (body.language || '') !== (s.language || '');
      if (langChanged) setLang(body.language);
      m.close();
      toast('Einstellungen gespeichert');
      if (langChanged) location.reload();
    } catch (e) { toast(e.message, { error: true }); }
  };
}
