const OLD_CMD = 'Lanjutkan task sebelumnya dari bagian terakhir yang belum selesai.';
const DEFAULT_CMD = 'Lanjutkan project "{project}" dari bagian terakhir yang belum selesai.';
const CLAUDE_URL = 'https://claude.ai/new';
const STORE_KEY = 'accounts';

const Cap = window.Capacitor || {};
const P = Cap.Plugins || {};
const native = !!(Cap.isNativePlatform && Cap.isNativePlatform());

let accounts = [];
const openIds = new Set();   // akun yang panel detailnya terbuka
const cards = new Map();     // id akun -> elemen kartu

const fmt = new Intl.DateTimeFormat('id-ID', {
  weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, '0');

// ---------- Penyimpanan ----------
async function loadAccounts() {
  try {
    const raw = native && P.Preferences
      ? (await P.Preferences.get({ key: STORE_KEY })).value
      : localStorage.getItem(STORE_KEY);
    const list = JSON.parse(raw || '[]');
    if (!Array.isArray(list)) return [];
    for (const a of list) {
      if (!Array.isArray(a.projects)) a.projects = [];
      if (typeof a.percent !== 'number') a.percent = 100;
    }
    return list;
  } catch { return []; }
}
async function saveAccounts() {
  const raw = JSON.stringify(accounts);
  try {
    if (native && P.Preferences) await P.Preferences.set({ key: STORE_KEY, value: raw });
    else localStorage.setItem(STORE_KEY, raw);
  } catch {}
}

// ---------- Command ----------
const cmdTemplate = (a) => (!a.command || a.command === OLD_CMD ? DEFAULT_CMD : a.command);
const buildCommand = (a, p) => cmdTemplate(a).split('{project}').join(p.name);

// ---------- Notifikasi (dijadwalkan di sistem, jalan walau app ditutup) ----------
const notifId = (id) => {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 2147483000 + 1;
};

async function scheduleAll() {
  if (!native || !P.LocalNotifications) return;
  const LN = P.LocalNotifications;
  try {
    const pending = await LN.getPending();
    if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications });
    const now = Date.now();
    const items = accounts
      .filter((a) => a.status === 'working' && a.resetAt && !a.notified && Date.parse(a.resetAt) > now)
      .map((a) => ({
        id: notifId(a.id),
        title: `${a.name} sudah reset`,
        body: a.projects.length
          ? `Limit reset. ${a.projects.length} project siap dilanjutkan.`
          : 'Jatah token sudah kembali.',
        schedule: { at: new Date(a.resetAt), allowWhileIdle: true },
        extra: { accountId: a.id },
      }));
    if (items.length) await LN.schedule({ notifications: items });
  } catch (e) { console.error(e); }
}

async function initNotifications() {
  if (!native || !P.LocalNotifications) return;
  const LN = P.LocalNotifications;
  try {
    const st = await LN.checkPermissions();
    if (st.display !== 'granted') await LN.requestPermissions();
  } catch {}
  LN.addListener('localNotificationActionPerformed', (ev) => {
    const a = accounts.find((x) => x.id === (ev.notification.extra || {}).accountId);
    if (a) { a.notified = true; commit(); doContinue(a); }
  });
}

// ---------- Helper UI ----------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'value') e.value = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.append(kid);
  return e;
}

function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function countdownText(ms) {
  if (ms <= 0) return 'Limit sudah reset';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}j ${pad(Math.floor((s % 3600) / 60))}m ${pad(s % 60)}d lagi`;
}

function countdownShort(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}j ${pad(m)}m` : `${pad(m)}:${pad(s % 60)}`;
}

function timeShort(a) {
  if (!a.resetAt) return '--:--';
  const d = new Date(a.resetAt);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

// Di baris, email Gmail ditampilkan tanpa @gmail.com supaya muat; nama lengkap ada di panel detail
const shortName = (n) => n.replace(/@gmail\.com$/i, '');

// ---------- Aksi ----------
function commit() {
  saveAccounts();
  scheduleAll();
  render();
}

function setStatus(a, status) {
  a.status = status;
  a.notified = false;
  if (status === 'working') {
    a.resetAt = a.resetAt || new Date(Date.now() + 5 * 3600e3).toISOString();
  } else {
    a.resetAt = null;
    a.percent = 100;
  }
  commit();
}

function setResetIn(a, hours) {
  a.resetAt = new Date(Date.now() + hours * 3600e3).toISOString();
  a.notified = false;
  commit();
}

function addProject(a, name) {
  name = name.trim();
  if (!name) return;
  if (a.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
  a.projects.push({ id: uid(), name });
  commit();
}

function removeProject(a, id) {
  a.projects = a.projects.filter((p) => p.id !== id);
  commit();
}

function toggleOpen(id) {
  if (openIds.has(id)) openIds.delete(id); else openIds.add(id);
  const root = cards.get(id);
  if (root) root.classList.toggle('open', openIds.has(id));
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toast._t);
  clearTimeout(toast._h);
  toast._t = setTimeout(() => {
    t.classList.remove('show');
    toast._h = setTimeout(() => { t.hidden = true; }, 300);
  }, 4500);
}

async function copyText(text) {
  try {
    if (native && P.Clipboard) await P.Clipboard.write({ string: text });
    else await navigator.clipboard.writeText(text);
  } catch {}
}

async function openClaude() {
  try {
    if (native && P.AppLauncher) await P.AppLauncher.openUrl({ url: CLAUDE_URL });
    else window.open(CLAUDE_URL, '_blank');
  } catch { window.open(CLAUDE_URL, '_blank'); }
}

// gecko.js menimpa fungsi ini supaya Continue membuka browser GeckoView per akun
async function openAccount(a, text) {
  await copyText(text);
  await openClaude();
}

// ---------- Status turunan satu akun ----------
function view(a) {
  const working = a.status === 'working';
  const list = working ? a.projects : [];
  const ms = working && a.resetAt ? Date.parse(a.resetAt) - Date.now() : null;
  const waiting = ms !== null && ms > 0;
  const over = ms !== null && ms <= 0;
  return { working, list, ms, waiting, over, can: over && list.length > 0 };
}

function noteText(v) {
  if (!v.list.length) return 'No projects in progress';
  const names = v.list.map((p) => p.name).join(', ');
  return v.waiting ? `Reset ${countdownShort(v.ms)} · ${names}` : `Siap lanjut · ${names}`;
}

async function doContinue(a) {
  const v = view(a);
  if (!v.can) {
    toast(!v.working ? 'Akun ini tidak sedang kena limit.'
      : v.waiting ? `Limit belum reset. Tunggu ${countdownShort(v.ms)}.`
      : 'Tidak ada project yang terhenti.');
    return;
  }
  const p = a.projects[0];
  await openAccount(a, buildCommand(a, p));
  a.projects.shift();
  commit();
  toast(`Command untuk "${p.name}" disalin. Tempel di chat.`
    + (a.projects.length ? ` Sisa ${a.projects.length} project, tekan Continue lagi.` : ''));
}

// ---------- Kartu akun ----------
function buildCard(a, index) {
  const r = {};

  // Baris 1: status | akun | waktu reset | status proyek
  r.sw = el('input', {
    type: 'checkbox', 'aria-label': 'Free atau Working',
    onchange: (e) => setStatus(a, e.target.checked ? 'working' : 'free'),
  });
  r.stlabel = el('span', { class: 'stlabel' });
  r.acctT = el('span', { class: 'acctT' });
  r.acct = el('div', {
    class: 'col acct', role: 'button', tabindex: '0',
    onclick: () => toggleOpen(a.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(a.id); } },
  }, r.acctT);
  r.rstK = el('span', { class: 'k' });
  r.rstV = el('span', { class: 'v' });
  r.prjK = el('span', { class: 'k', text: 'Proyek' });
  r.prjV = el('span', { class: 'v' });

  const r1 = el('div', { class: 'r1' },
    el('label', { class: 'col stat' }, el('span', { class: 'sw' }, r.sw, el('i')), r.stlabel),
    r.acct,
    el('div', { class: 'col rst' }, r.rstK, r.rstV),
    el('div', { class: 'col prj' }, r.prjK, r.prjV),
  );

  // Baris 2: continue + keterangan
  r.go = el('button', { type: 'button', class: 'go', onclick: () => doContinue(a) },
    el('span', { text: 'Continue' }), el('span', { class: 'arr', text: '→' }));
  r.note = el('span', { class: 'note' });
  const chev = el('button', { type: 'button', class: 'chev', 'aria-label': 'Detail akun', onclick: () => toggleOpen(a.id) });
  const r2 = el('div', { class: 'r2' }, r.go, r.note, chev);

  // Panel detail
  r.name = el('input', {
    class: 'dname', placeholder: 'Nama akun', autocomplete: 'off',
    onchange: (e) => { a.name = e.target.value.trim() || a.name; commit(); },
  });
  const del = el('button', {
    type: 'button', class: 'btn-d', text: 'Hapus',
    onclick: () => {
      if (confirm(`Hapus akun "${a.name}"?`)) {
        accounts = accounts.filter((x) => x.id !== a.id);
        openIds.delete(a.id);
        commit();
      }
    },
  });

  r.pct = el('input', {
    type: 'number', min: '0', max: '100', inputmode: 'numeric',
    onchange: (e) => {
      const n = Math.max(0, Math.min(100, parseInt(e.target.value, 10)));
      a.percent = Number.isNaN(n) ? 100 : n;
      commit();
    },
  });

  r.when = el('input', {
    type: 'datetime-local',
    onchange: (e) => {
      if (!e.target.value) return;
      a.resetAt = new Date(e.target.value).toISOString();
      a.notified = false;
      commit();
    },
  });
  r.cd = el('div', { class: 'cd' });
  r.full = el('div', { class: 'hint2' });

  r.plist = el('div', { class: 'plist' });
  r.pin = el('input', { placeholder: 'Nama project yang terhenti', autocomplete: 'off' });

  r.cmd = el('textarea', {
    rows: '2',
    onchange: (e) => { a.command = e.target.value; commit(); },
  });

  const detail = el('div', { class: 'dwrap' }, el('div', { class: 'dinner' }, el('div', { class: 'dpad' },
    el('div', { class: 'drow' }, r.name, del),
    el('div', { class: 'field only-free' }, el('label', { text: 'Sisa token (%)' }), r.pct),
    el('div', { class: 'field only-working' },
      el('label', { text: 'Limit reset pada (jam & tanggal)' }),
      r.when,
      el('div', { class: 'chips' },
        el('span', { class: 'hint2', text: 'Cepat atur:' }),
        ...[1, 2, 3, 5].map((h) => el('button', { type: 'button', class: 'chip', text: `+${h} jam`, onclick: () => setResetIn(a, h) })),
      ),
      r.cd, r.full,
    ),
    el('div', { class: 'field only-working' },
      el('label', { text: 'Project terhenti karena limit' }),
      r.plist,
      el('form', {
        class: 'padd',
        onsubmit: (e) => { e.preventDefault(); addProject(a, r.pin.value); r.pin.value = ''; },
      }, r.pin, el('button', { type: 'submit', class: 'btn sm', text: 'Tambah' })),
    ),
    el('div', { class: 'field' },
      el('label', { text: 'Command (pakai {project} untuk nama project)' }),
      r.cmd,
    ),
  )));

  const root = el('section', { class: 'acc enter' }, r1, r2, detail);
  root.style.setProperty('--i', index);
  root._r = r;
  root.addEventListener('animationend', (e) => {
    if (e.target === root && e.animationName === 'rise') root.classList.remove('enter');
  });
  return root;
}

const setVal = (inp, val) => {
  if (document.activeElement !== inp && inp.value !== val) inp.value = val;
};

function renderProjects(r, a) {
  const sig = a.projects.map((p) => `${p.id}:${p.name}`).join('|');
  if (r._sig === sig) return;
  r._sig = sig;
  r.plist.replaceChildren(...(a.projects.length
    ? a.projects.map((p) => el('span', { class: 'pchip' },
        el('span', { text: p.name }),
        el('button', { type: 'button', 'aria-label': `Hapus ${p.name}`, text: '✕', onclick: () => removeProject(a, p.id) })))
    : [el('span', { class: 'hint2', text: 'Belum ada. Tambahkan project yang terhenti saat kena limit.' })]));
}

// Bagian yang berubah tiap detik (timer)
function live(root, a) {
  const r = root._r;
  const v = view(a);
  root.classList.toggle('is-working', v.working);
  root.classList.toggle('is-free', !v.working);
  root.classList.toggle('waiting', v.working && v.waiting);
  root.classList.toggle('ready', v.can);
  r.go.disabled = !v.can;
  r.note.textContent = noteText(v);

  let pt = 'Idle', pc = 'idle';
  if (v.list.length && v.waiting) { pt = `Paused ${v.list.length}`; pc = 'paused'; }
  else if (v.list.length && v.over) { pt = `Ready ${v.list.length}`; pc = 'ready'; }
  r.prjV.textContent = pt;
  r.prjV.className = `v ${pc}`;

  r.cd.textContent = v.ms === null ? '' : countdownText(v.ms);
  r.cd.classList.toggle('done', v.over);
}

// Semua bagian kartu (dipanggil saat data berubah)
function refresh(root, a) {
  const r = root._r;
  const working = a.status === 'working';
  root.classList.toggle('open', openIds.has(a.id));
  r.sw.checked = working;
  r.stlabel.textContent = working ? 'Working' : 'Free';
  r.acctT.textContent = shortName(a.name);
  r.acct.title = a.name;
  r.rstK.textContent = working ? 'Reset' : 'Token';
  r.rstV.textContent = working ? timeShort(a) : `${a.percent}%`;
  setVal(r.name, a.name);
  setVal(r.pct, String(a.percent));
  setVal(r.when, a.resetAt ? toLocalInput(a.resetAt) : '');
  setVal(r.cmd, cmdTemplate(a));
  r.full.textContent = a.resetAt ? `Reset: ${fmt.format(new Date(a.resetAt))}` : '';
  renderProjects(r, a);
  live(root, a);
}

function render() {
  const list = document.getElementById('list');
  const seen = new Set();
  let created = 0;

  accounts.forEach((a, i) => {
    let root = cards.get(a.id);
    if (!root) {
      root = buildCard(a, created++);
      cards.set(a.id, root);
    }
    refresh(root, a);
    if (list.children[i] !== root) list.insertBefore(root, list.children[i] || null);
    seen.add(a.id);
  });

  for (const [id, root] of cards) {
    if (seen.has(id)) continue;
    cards.delete(id);
    root.classList.add('leaving');
    setTimeout(() => root.remove(), 260);
  }

  document.getElementById('empty').hidden = accounts.length > 0;
  const free = accounts.filter((a) => a.status === 'free').length;
  document.getElementById('summary').replaceChildren(
    el('span', { class: 'pill', text: `${accounts.length} akun` }),
    el('span', { class: 'pill free', text: `${free} Free` }),
    el('span', { class: 'pill work', text: `${accounts.length - free} Working` }),
  );
}

function tick() {
  for (const a of accounts) {
    const root = cards.get(a.id);
    if (root) live(root, a);
  }
}

document.getElementById('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('newName');
  const name = input.value.trim();
  if (!name) return;
  accounts.push({
    id: uid(), name, status: 'free', percent: 100,
    resetAt: null, notified: false, command: DEFAULT_CMD, projects: [],
  });
  input.value = '';
  commit();
});

(async function init() {
  accounts = await loadAccounts();
  await initNotifications();
  render();
  scheduleAll();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
})();
