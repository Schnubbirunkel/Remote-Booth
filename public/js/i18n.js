// Mehrsprachigkeit
// Die Oberfläche ist auf Deutsch geschrieben. Für andere Sprachen übersetzt dieses Modul Texte beim Anzeigen:
// Textknoten und die Attribute title/placeholder/aria-label – auch alles, was später per Script entsteht.
// Wörterbücher liegen in /js/i18n/<code>.js: { exact: { 'Deutsch': 'Übersetzung' }, patterns: { 'Export {n} %': 'Export {n} %' } }.
// Neue Sprache: Datei anlegen und unten in LANGS eintragen. Eigene Inhalte (Namen, Chat, Notizen) tragen translate="no".
import en from './i18n/en.js';

export const LANGS = [
  { code: 'de', name: 'Deutsch', dict: null },
  { code: 'en', name: 'English', dict: en },
];
const STORE_KEY = 'rb_lang';

function detect() {
  let stored = '';
  try { stored = localStorage.getItem(STORE_KEY) || ''; } catch { /* privat */ }
  if (stored && LANGS.some(l => l.code === stored)) return stored;
  for (const nl of navigator.languages || [navigator.language || '']) {
    const c = String(nl).slice(0, 2).toLowerCase();
    if (LANGS.some(l => l.code === c)) return c;
  }
  const def = document.documentElement.dataset.defaultLang;
  if (def && LANGS.some(l => l.code === def)) return def;
  return 'en';
}
let LANG = detect();
// raw = gespeicherte Auswahl ('' = automatisch), sonst die aktive Sprache
export function currentLang(raw = false) {
  if (!raw) return LANG;
  try { return localStorage.getItem(STORE_KEY) || ''; } catch { return ''; }
}
export function setLang(code) {
  try { if (code) localStorage.setItem(STORE_KEY, code); else localStorage.removeItem(STORE_KEY); } catch { /* privat */ }
}
export const locale = () => (LANG === 'de' ? 'de-DE' : LANG === 'en' ? 'en-GB' : LANG);

// Kleine Sprachauswahl (Login, Vorraum): <span data-lang-picker></span> wird automatisch befüllt
export function mountLangPicker(el) {
  if (!el) return;
  const cur = currentLang(true);
  el.innerHTML = `<select class="lang-pick" aria-label="Sprache"><option value="">Automatisch (Browser)</option>${
    LANGS.map(l => `<option value="${l.code}" translate="no" ${l.code === cur ? 'selected' : ''}>${l.name}</option>`).join('')}</select>`;
  el.querySelector('select').onchange = e => { setLang(e.target.value); location.reload(); };
}

// ---------- Übersetzen ----------
const dict = LANGS.find(l => l.code === LANG)?.dict || null;
const exact = new Map(Object.entries(dict?.exact || {}));
const patterns = Object.entries(dict?.patterns || {}).map(([src, dst]) => {
  const names = [];
  // {name} = beliebiger Text, {#n} = Zahl/Zeit (z. B. 3, 1.5, 0:12, −16)
  const re = new RegExp('^' + src.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{(#?\w+)\}/g, (_, n) => { names.push(n); return n[0] === '#' ? '([-−+]?[\\d.,:]+)' : '(.+?)'; }) + '$', 's');
  return { re, names, dst };
});
const cache = new Map();
const LETTERS = /[A-Za-zÄÖÜäöüß]{2}/;

function lookup(s) {
  if (exact.has(s)) return exact.get(s);
  for (const p of patterns) {
    const m = s.match(p.re);
    if (!m) continue;
    let out = p.dst;
    p.names.forEach((n, i) => { out = out.split('{' + n + '}').join(translate(m[i + 1])); });
    return out;
  }
  return null;
}
// Übersetzt einen Text; Leerraum am Rand bleibt erhalten, zusammengesetzte Texte („A · B“) werden teilweise übersetzt
export function translate(text) {
  if (!dict || text == null) return text;
  const s = String(text);
  if (!LETTERS.test(s)) return s;
  if (cache.has(s)) return cache.get(s);
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
  const core = s.slice(lead.length, s.length - trail.length).replace(/\s+/g, ' ');
  let out = lookup(core);
  if (out == null) {
    for (const sep of [' · ', ' – ', ': ', ' — ']) {
      if (!core.includes(sep)) continue;
      const parts = core.split(sep), tr = parts.map(p => lookup(p.trim()) ?? null);
      if (tr.some(x => x != null)) { out = parts.map((p, i) => (tr[i] != null ? p.replace(p.trim(), tr[i]) : p)).join(sep); break; }
    }
  }
  const res = out == null ? s : lead + out + trail;
  if (cache.size > 5000) cache.clear();
  cache.set(s, res);
  return res;
}
// Für Texte im Script (Canvas, prompt, Titel): t('Deutsch {x}', { x: 1 })
export function t(text, vars) {
  let s = translate(text);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split('{' + k + '}').join(String(v));
  return s;
}

// ---------- Oberfläche ----------
const ATTRS = ['title', 'placeholder', 'aria-label'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);
const skipEl = el => !el || SKIP.has(el.nodeName) || (el.closest && el.closest('[translate="no"], [contenteditable="true"]'));
function doText(node) {
  const v = node.nodeValue;
  if (!v || !LETTERS.test(v) || skipEl(node.parentElement)) return;
  const tr = translate(v);
  if (tr !== v) node.nodeValue = tr;
}
function doAttrs(el) {
  if (!el || !el.closest || el.closest('[translate="no"]')) return;
  for (const a of ATTRS) {
    const v = el.getAttribute && el.getAttribute(a);
    if (v && LETTERS.test(v)) { const tr = translate(v); if (tr !== v) el.setAttribute(a, tr); }
  }
}
function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1 || skipEl(root)) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === 1 && skipEl(n) ? (doAttrs(n), NodeFilter.FILTER_REJECT) : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
}

document.documentElement.lang = LANG;
if (dict) {
  const run = () => {
    walk(document.body);
    if (document.title) document.title = translate(document.title);
    new MutationObserver(list => {
      for (const m of list) {
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doAttrs(m.target);
        else for (const n of m.addedNodes) walk(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    document.documentElement.classList.remove('i18n-pending');
  };
  if (document.body) run(); else document.addEventListener('DOMContentLoaded', run);
} else document.documentElement.classList.remove('i18n-pending');
const mountPickers = () => document.querySelectorAll('[data-lang-picker]').forEach(mountLangPicker);
if (document.body) mountPickers(); else document.addEventListener('DOMContentLoaded', mountPickers);

// Native Dialoge übersetzen (prompt/confirm werden an einigen Stellen genutzt)
const _prompt = window.prompt.bind(window), _confirm = window.confirm.bind(window);
window.prompt = (msg, def) => _prompt(translate(msg), def);
window.confirm = msg => _confirm(translate(msg));
