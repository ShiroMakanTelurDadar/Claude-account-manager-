const OLD_CMD = 'Lanjutkan task sebelumnya dari bagian terakhir yang belum selesai.';
const DEFAULT_CMD = 'Lanjutkan project "{project}" dari bagian terakhir yang belum selesai.';
const CLAUDE_URL = 'https://claude.ai/new';
const LOGIN_URL = 'https://claude.ai/login';
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
      if (!Array.isArray(a.notes)) a.notes = [];
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

async function openClaude(url = CLAUDE_URL) {
  try {
    if (native && P.AppLauncher) await P.AppLauncher.openUrl({ url });
    else window.open(url, '_blank');
  } catch { window.open(url, '_blank'); }
}

// gecko.js menimpa fungsi ini supaya Continue dan Connect membuka browser GeckoView per akun
async function openAccount(a, text, url) {
  if (text) await copyText(text);
  await openClaude(url);
}

// Buka chat akun ini (kalau link sudah diisi) atau halaman login claude.ai di browser aplikasi
async function connectAccount(a) {
  await openAccount(a, '', a.chatUrl || LOGIN_URL);
  toast(a.chatUrl
    ? `Membuka chat akun "${a.name}".`
    : `Login ke akun "${a.name}" di browser ini. Login tersimpan terpisah untuk akun ini.`);
}

// ---------- Deteksi limit dari browser aplikasi ----------
const LIMIT_RE = /out of (free )?messages|usage limit|limit (will )?reset|kehabisan pesan|batas penggunaan/i;

// "until 4:00 PM" atau "hingga 16.00" -> waktu berikutnya dengan jam itu
function parseResetAt(text) {
  const m = /(?:until|hingga|sampai)\s+(\d{1,2})[:.](\d{2})\s*(AM|PM)?/i.exec(text);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date();
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

function onLimitSeen(accountId, text, url) {
  const a = accounts.find((x) => x.id === accountId);
  if (!a || !LIMIT_RE.test(text || '')) return;
  // Simpan link chat tempat limit muncul, supaya Continue membuka chat itu
  const chat = /^https:\/\/claude\.ai\/chat\//.test(url || '') ? url : null;
  const chatChanged = !!chat && a.chatUrl !== chat;
  if (chatChanged) a.chatUrl = chat;
  const at = parseResetAt(text);
  if (a.status === 'working' && a.resetAt) {
    if (!at || Math.abs(Date.parse(a.resetAt) - at.getTime()) < 60000) {
      if (chatChanged) commit();
      return;
    }
  }
  a.status = 'working';
  a.notified = false;
  a.resetAt = (at || new Date(Date.now() + 5 * 3600e3)).toISOString();
  commit();
  toast(`Limit terdeteksi di "${a.name}". Status diubah ke Working.`);
}

function initLimitWatcher() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.addListener) return;
  G.addListener('pageText', (ev) => onLimitSeen(ev.accountId, ev.text, ev.url));
  drainLimitEvents();
}

// Ambil banner limit yang tertangkap saat layar utama di belakang browser
async function drainLimitEvents() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.takePending) return;
  try {
    const res = await G.takePending();
    for (const it of (res.items || [])) onLimitSeen(it.accountId, it.text, it.url);
  } catch {}
}

// ---------- Note ----------
const NOTE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#22d3ee', '#818cf8', '#e879f9', '#f472b6', '#94a3b8'];

function closeModal() {
  const m = document.getElementById('modal');
  if (m) m.remove();
}

function openModal(onBackdrop, ...kids) {
  closeModal();
  const m = el('div', { id: 'modal', class: 'modal' }, el('div', { class: 'mbox' }, ...kids));
  m.addEventListener('click', (e) => { if (e.target === m) onBackdrop(); });
  document.body.append(m);
}

// Dialog buat note baru: nama + warna penanda
function openNoteCreate(a) {
  let color = NOTE_COLORS[0];
  const name = el('input', {
    placeholder: 'Nama note', autocomplete: 'off', maxlength: '40',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } },
  });
  const sw = NOTE_COLORS.map((c) => {
    const b = el('button', {
      type: 'button', class: 'swatch', 'aria-label': `Warna ${c}`,
      onclick: () => { color = c; sw.forEach((x) => x.classList.toggle('on', x === b)); },
    });
    b.style.background = c;
    return b;
  });
  sw[0].classList.add('on');
  function create() {
    a.notes.push({ id: uid(), name: name.value.trim() || 'Note', color, text: '' });
    closeModal();
    commit();
  }
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Buat note' }),
    name,
    el('div', { class: 'swatches' }, ...sw),
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Batal', onclick: closeModal }),
      el('button', { type: 'button', class: 'btn sm', text: 'Buat', onclick: create }),
    ),
  );
  name.focus();
}

// Jendela catatan: ketik bebas. Close note menyimpan otomatis.
function openNoteEditor(a, n) {
  let timer;
  const area = el('textarea', { class: 'nedit', placeholder: 'Ketik catatan di sini...' });
  area.value = n.text || '';
  area.addEventListener('input', () => {
    n.text = area.value;
    clearTimeout(timer);
    timer = setTimeout(saveAccounts, 400);
  });
  const close = () => {
    clearTimeout(timer);
    n.text = area.value;
    closeModal();
    commit();
  };
  const del = () => {
    if (!confirm(`Hapus note "${n.name}"?`)) return;
    clearTimeout(timer);
    a.notes = a.notes.filter((x) => x.id !== n.id);
    closeModal();
    commit();
  };
  const dot = el('span', { class: 'mdot' });
  dot.style.background = n.color;
  openModal(close,
    el('div', { class: 'mtitle' }, dot, el('span', { text: n.name })),
    area,
    el('div', { class: 'mact between' },
      el('button', { type: 'button', class: 'btn-d', text: 'Hapus', onclick: del }),
      el('button', { type: 'button', class: 'btn sm', text: 'Close note', onclick: close }),
    ),
  );
  area.focus();
}

function renderNotes(r, a) {
  const sig = a.notes.map((n) => `${n.id}:${n.name}:${n.color}`).join('|');
  if (r._nsig === sig) return;
  r._nsig = sig;
  r.nchips.replaceChildren(...a.notes.map((n) => {
    const c = el('button', {
      type: 'button', class: 'nchip',
      onclick: () => { const cur = a.notes.find((x) => x.id === n.id); if (cur) openNoteEditor(a, cur); },
    },
      el('span', { text: n.name }));
    c.style.setProperty('--nc', n.color);
    return c;
  }));
}

// ---------- Backup data ----------
// Ekspor: semua akun, setelan, link chat, dan note jadi satu teks JSON untuk disalin
function exportData() {
  const json = JSON.stringify({ v: 1, accounts });
  const area = el('textarea', { class: 'nedit', readonly: true });
  area.value = json;
  area.style.minHeight = '30vh';
  area.addEventListener('focus', () => area.select());
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Ekspor data' }),
    el('div', { class: 'hint2', text: 'Salin teks ini dan simpan di tempat aman (catatan atau chat pribadi). Isinya termasuk link chat dan catatan.' }),
    area,
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Tutup', onclick: closeModal }),
      el('button', {
        type: 'button', class: 'btn sm', text: 'Salin',
        onclick: async () => { await copyText(json); toast('Backup disalin ke clipboard.'); },
      }),
    ),
  );
}

// Impor: tempel teks backup. Akun dengan id sama diperbarui, yang baru ditambahkan.
function importData() {
  const area = el('textarea', { class: 'nedit', placeholder: 'Tempel isi backup di sini...' });
  area.style.minHeight = '30vh';
  const run = () => {
    let data;
    try { data = JSON.parse(area.value.trim()); } catch { toast('Teks backup tidak valid.'); return; }
    const list = Array.isArray(data) ? data : (data && data.accounts);
    if (!Array.isArray(list)) { toast('Tidak ada akun di backup.'); return; }
    let n = 0;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.id || !raw.name) continue;
      const a = {
        status: 'free', percent: 100, resetAt: null, notified: false, command: DEFAULT_CMD,
        projects: [], notes: [], notesOn: false, chatUrl: null, ...raw,
      };
      if (!Array.isArray(a.projects)) a.projects = [];
      if (!Array.isArray(a.notes)) a.notes = [];
      if (typeof a.percent !== 'number') a.percent = 100;
      const cur = accounts.find((x) => x.id === a.id);
      if (cur) Object.assign(cur, a); else accounts.push(a);
      n++;
    }
    if (!n) { toast('Tidak ada akun valid di backup.'); return; }
    closeModal();
    commit();
    toast(`${n} akun dipulihkan.`);
  };
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Impor data' }),
    el('div', { class: 'hint2', text: 'Tempel teks hasil Ekspor data. Akun yang sudah ada diperbarui, akun baru ditambahkan.' }),
    area,
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Batal', onclick: closeModal }),
      el('button', { type: 'button', class: 'btn sm', text: 'Pulihkan', onclick: run }),
    ),
  );
  area.focus();
}

function initTools() {
  const s = document.getElementById('summary');
  if (!s) return;
  s.after(el('div', { class: 'tools' },
    el('button', { type: 'button', class: 'tbtn', text: '⬇ Ekspor data', onclick: exportData }),
    el('button', { type: 'button', class: 'tbtn', text: '⬆ Impor data', onclick: importData }),
  ));
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
  await openAccount(a, buildCommand(a, p), a.chatUrl);
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
  const link = el('button', {
    type: 'button', class: 'link', text: '🔗',
    title: 'Hubungkan akun ke browser aplikasi', 'aria-label': 'Hubungkan akun',
    onclick: () => connectAccount(a),
  });
  const r2 = el('div', { class: 'r2' }, r.go, r.note, link, chev);

  // Baris 3: penanda note (tampil hanya jika note dipasang di akun ini)
  r.nchips = el('div', { class: 'nchips' });
  r.nbtn = el('button', {
    type: 'button', class: 'ntag', text: 'NOTE', 'aria-label': 'Buat note',
    onclick: () => openNoteCreate(a),
  });
  const r3 = el('div', { class: 'r3' }, r.nchips, r.nbtn);

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

  r.chat = el('input', {
    type: 'url', inputmode: 'url', placeholder: 'https://claude.ai/chat/...', autocomplete: 'off',
    onchange: (e) => {
      const v = e.target.value.trim();
      if (v && !/^https:\/\/claude\.ai\//.test(v)) {
        toast('Link harus diawali https://claude.ai/');
        e.target.value = a.chatUrl || '';
        return;
      }
      a.chatUrl = v || null;
      commit();
    },
  });
  r.notesChk = el('input', {
    type: 'checkbox',
    onchange: (e) => { a.notesOn = e.target.checked; commit(); },
  });

  const detail = el('div', { class: 'dwrap' }, el('div', { class: 'dinner' }, el('div', { class: 'dpad' },
    el('button', { type: 'button', class: 'connect', text: '🔗 Hubungkan akun ke browser aplikasi', onclick: () => connectAccount(a) }),
    el('div', { class: 'drow' }, r.name, del),
    el('div', { class: 'field' },
      el('label', { text: 'Link chat akun ini (dibuka oleh 🔗 dan Continue)' }),
      r.chat,
    ),
    el('div', { class: 'field' },
      el('label', { class: 'chk' }, r.notesChk, el('span', { text: 'Pasang note di akun ini' })),
    ),
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

  const root = el('section', { class: 'acc enter' }, r1, r2, r3, detail);
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
  root.classList.toggle('notes-on', !!a.notesOn);
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
  setVal(r.chat, a.chatUrl || '');
  r.notesChk.checked = !!a.notesOn;
  r.full.textContent = a.resetAt ? `Reset: ${fmt.format(new Date(a.resetAt))}` : '';
  renderProjects(r, a);
  renderNotes(r, a);
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
    notes: [], notesOn: false, chatUrl: null,
  });
  input.value = '';
  commit();
});

(async function init() {
  accounts = await loadAccounts();
  await initNotifications();
  initLimitWatcher();
  initTools();
  render();
  scheduleAll();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); drainLimitEvents(); } });
})();
