const OLD_CMD = 'Lanjutkan task sebelumnya dari bagian terakhir yang belum selesai.';
const DEFAULT_CMD = 'Lanjutkan project "{project}" dari bagian terakhir yang belum selesai.';
const CLAUDE_URL = 'https://claude.ai/new';
const LOGIN_URL = 'https://claude.ai/login';
const STORE_KEY = 'accounts';
const SETTINGS_KEY = 'settings';

const Cap = window.Capacitor || {};
const P = Cap.Plugins || {};
const native = !!(Cap.isNativePlatform && Cap.isNativePlatform());

let accounts = [];
const openIds = new Set();   // akun yang panel detailnya terbuka
const cards = new Map();     // id akun -> elemen kartu

// Status sesaat dari halaman claude.ai (tidak disimpan ke penyimpanan)
const BUSY_TTL = 12000;          // ms: busy dianggap berhenti kalau tidak ada heartbeat selama ini
const RESUME_DELAY = 2500;       // ms: jeda supaya info reset sempat terbaca sebelum browser terbuka
const RESUME_GUARD = 60000;      // ms: cegah auto-continue ganda untuk akun yang sama
const busyAt = new Map();        // id akun -> waktu terakhir Claude terlihat bekerja
const limitSeenAt = new Map();   // id akun -> waktu banner limit terakhir terlihat
const resumeAt = new Map();      // id akun -> waktu auto-continue terakhir
const resumeWhy = new Map();     // id akun -> sumber pemicu ('page' atau 'check') untuk teks info
const CHECK_TIMEOUT = 24000;     // ms: batas waktu cek satu akun di belakang layar
const RESUME_TTL = 2 * 3600 * 1000;     // ms: tombol Continue hijau dianggap basi kalau tidak ada laporan baru selama ini
const CHECK_BUSY_TTL = 10 * 60 * 1000;  // ms: hasil cek "busy" dianggap basi setelah ini
let checking = false;            // sedang cek semua akun
let resumeBusy = false;          // sedang membuka browser untuk auto-continue (satu akun pada satu waktu)
let checkBtn = null;             // tombol "Cek semua akun"
let checkingId = null;           // akun yang sedang dicek di belakang layar
let autoSel = null;              // pilihan interval cek otomatis
let autoHint = null;             // teks jadwal cek otomatis
let autoHoldUntil = 0;           // ms: jeda sebelum cek otomatis dicoba lagi (mis. browser sedang terbuka)
// Pilihan interval cek otomatis (menit). 0 = mati.
const AUTO_OPTS = [[0, 'Mati'], [30, '30 menit'], [60, '1 jam'], [120, '2 jam'], [300, '5 jam']];
const settings = { autoMin: 60, lastAuto: 0 };   // lastAuto = patokan jadwal cek otomatis berikutnya

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

async function loadSettings() {
  try {
    const raw = native && P.Preferences
      ? (await P.Preferences.get({ key: SETTINGS_KEY })).value
      : localStorage.getItem(SETTINGS_KEY);
    const st = JSON.parse(raw || 'null');
    if (st && typeof st === 'object') {
      if (AUTO_OPTS.some(([m]) => m === st.autoMin)) settings.autoMin = st.autoMin;
      if (typeof st.lastAuto === 'number') settings.lastAuto = st.lastAuto;
    }
  } catch {}
  // Pemakaian pertama: hitungan jadwal mulai dari sekarang
  if (!settings.lastAuto) { settings.lastAuto = Date.now(); saveSettings(); }
}
async function saveSettings() {
  const raw = JSON.stringify(settings);
  try {
    if (native && P.Preferences) await P.Preferences.set({ key: SETTINGS_KEY, value: raw });
    else localStorage.setItem(SETTINGS_KEY, raw);
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
    if (a) { a.notified = true; autoResume(a, 'timer'); }
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

// Jam (dan tanggal kalau bukan hari ini) dari waktu ISO
function atShort(iso) {
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`;
}

// Asal waktu reset: 'auto' (terbaca dari banner chat), 'manual' (diatur pengguna), 'default' (perkiraan 5 jam)
function resetSource(a) {
  if (!a.resetAt) return '';
  if (a.resetSrc === 'manual') {
    return `Manual${a.resetAuto ? ` · terbaca otomatis: ${atShort(a.resetAuto)}` : ' · belum ada waktu otomatis'}`;
  }
  if (a.resetSrc === 'auto') return 'Otomatis (terbaca dari chat Claude)';
  if (a.resetSrc === 'default') return 'Perkiraan 5 jam (belum terbaca dari chat). Akan diganti otomatis kalau terdeteksi.';
  return '';
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

// Email untuk login otomatis: isian khusus, atau nama akun kalau berbentuk email
const loginEmail = (a) => (a.email && a.email.includes('@') ? a.email : (a.name.includes('@') ? a.name : ''));

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return 'baru saja';
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m lalu` : `${Math.floor(m / 60)}j lalu`;
}

const CHECK_LABEL = {
  limit: 'limit aktif', busy: 'sedang bekerja', reset: 'limit sudah selesai',
  resume: 'bisa dilanjutkan (Continue / Try again)', idle: 'tidak ada project berjalan', loggedout: 'belum login', unknown: 'tidak terbaca',
};

// Catat status terakhir yang terlihat di halaman akun (dari browser maupun dari cek latar belakang).
// Laporan yang lebih tua dari yang tercatat diabaikan.
function noteCheck(a, state, at) {
  const c = a.check;
  if (c && at < c.at) return;
  if (!c || c.state !== state) { a.check = { state, at }; saveAccounts(); }
  else c.at = at;   // tanpa simpan, supaya heartbeat busy tidak menulis terus
}

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
    if (!a.resetAt) { a.resetAt = new Date(Date.now() + 5 * 3600e3).toISOString(); a.resetSrc = 'default'; }
  } else {
    a.resetAt = null;
    a.resetSrc = null;
    a.resetAuto = null;
    a.percent = 100;
  }
  commit();
}

// Atur waktu reset manual (opsi kedua). Dipertahankan sampai limit selesai atau tombol "Pakai otomatis" ditekan.
function setResetManual(a, iso) {
  a.resetAt = iso;
  a.resetSrc = 'manual';
  a.notified = false;
  commit();
}

function setResetIn(a, hours) {
  setResetManual(a, new Date(Date.now() + hours * 3600e3).toISOString());
}

// Kembali ke waktu otomatis dari aplikasi
function useAutoReset(a) {
  a.notified = false;
  if (a.resetAuto && Date.parse(a.resetAuto) > Date.now()) {
    a.resetAt = a.resetAuto;
    a.resetSrc = 'auto';
    toast(`Memakai waktu otomatis: ${atShort(a.resetAt)}.`);
  } else {
    a.resetSrc = 'default';
    toast('Belum ada waktu otomatis dari chat. Akan dipakai begitu terdeteksi.');
  }
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

function toast(msg, ms = 4500) {
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
  }, ms);
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
  if (checking) { toast('Tunggu pengecekan akun selesai dulu.'); return; }
  await openAccount(a, '', a.chatUrl || LOGIN_URL);
  toast(a.chatUrl
    ? `Membuka chat akun "${a.name}".`
    : `Login ke akun "${a.name}" di browser ini. Login tersimpan terpisah untuk akun ini.`);
}

// ---------- Deteksi limit dari browser aplikasi ----------
const LIMIT_RE = /out of (free )?messages|usage limit|limit (will )?reset|kehabisan pesan|batas penggunaan/i;

// "until 4:00 PM" atau "hingga 16.00" -> waktu berikutnya dengan jam itu (dihitung dari saat banner terlihat)
function parseResetAt(text, ref = Date.now()) {
  const m = /(?:until|hingga|sampai)\s+(\d{1,2})[:.](\d{2})\s*(AM|PM)?/i.exec(text);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = (m[3] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const d = new Date(ref);
  d.setHours(h, min, 0, 0);
  if (d.getTime() <= ref) d.setDate(d.getDate() + 1);
  return d;
}

function onLimitSeen(accountId, text, url, evAt) {
  const a = accounts.find((x) => x.id === accountId);
  if (!a || !LIMIT_RE.test(text || '')) return;
  const ref = evAt || Date.now();
  // Banner lama (mis. dari antrean): kalau jam resetnya sudah lewat, abaikan
  const parsed = parseResetAt(text, ref);
  if (parsed && parsed.getTime() <= Date.now()) return;
  limitSeenAt.set(a.id, ref);
  busyAt.delete(a.id);
  // Simpan link chat tempat limit muncul, supaya Continue membuka chat itu
  const chat = /^https:\/\/claude\.ai\/chat\//.test(url || '') ? url : null;
  const chatChanged = !!chat && a.chatUrl !== chat;
  if (chatChanged) a.chatUrl = chat;
  const at = parsed;
  // Waktu otomatis selalu dicatat, walau waktu manual sedang dipakai (ditampilkan sebagai pembanding)
  const autoChanged = !!at && a.resetAuto !== at.toISOString();
  if (at) a.resetAuto = at.toISOString();
  if (a.status === 'working' && a.resetAt) {
    // Waktu manual dipertahankan sampai pengguna menekan "Pakai otomatis"
    if (a.resetSrc === 'manual') {
      if (chatChanged || autoChanged) commit();
      return;
    }
    if (!at || Math.abs(Date.parse(a.resetAt) - at.getTime()) < 60000) {
      if (at && a.resetSrc !== 'auto') a.resetSrc = 'auto';
      if (chatChanged || autoChanged) commit();
      return;
    }
  }
  a.status = 'working';
  a.notified = false;
  a.resetAt = (at || new Date(Date.now() + 5 * 3600e3)).toISOString();
  a.resetSrc = at ? 'auto' : 'default';
  commit();
  toast(`Limit terdeteksi di "${a.name}". Status: Working, Pending Project sampai limit reset.`);
}

// Tandai limit sudah selesai sekarang. checkDue yang menjalankan auto-continue, satu akun pada satu waktu.
function markLimitOver(a, why) {
  resumeWhy.set(a.id, why);
  a.resetAt = new Date().toISOString();
  commit();
}

// Limit sudah selesai menurut halaman ("You can try again now" / tombol Try again / Continue)
function onResetSeen(accountId, url, evAt) {
  const a = accounts.find((x) => x.id === accountId);
  // Hanya berlaku saat akun sedang pending karena limit. Teks lama di riwayat chat diabaikan.
  if (!a || a.status !== 'working') return;
  // Laporan yang lebih tua dari banner limit terakhir sudah usang
  if ((evAt || Date.now()) < (limitSeenAt.get(a.id) || 0)) return;
  if (/^https:\/\/claude\.ai\/chat\//.test(url || '')) a.chatUrl = url;
  markLimitOver(a, 'page');
}

// Satu pintu untuk semua laporan dari halaman: limit, busy, reset, idle, loggedout
function onPageEvent(ev) {
  const a = accounts.find((x) => x.id === ev.accountId);
  if (!a) return;
  const state = ev.state || 'limit';
  const at = ev.at || Date.now();
  noteCheck(a, state, at);
  if (state === 'busy') {
    busyAt.set(a.id, Math.max(busyAt.get(a.id) || 0, at));
    tick();
  } else if (state === 'idle') {
    if (at >= (busyAt.get(a.id) || 0)) busyAt.delete(a.id);
    tick();
  } else if (state === 'loggedout') {
    busyAt.delete(a.id);
    render();
  } else if (state === 'resume') {
    // Tombol Continue / Try again terlihat di chat: simpan link chat supaya tombol Continue membuka chat yang benar
    busyAt.delete(a.id);
    if (/^https:\/\/claude\.ai\/chat\//.test(ev.url || '') && a.chatUrl !== ev.url) { a.chatUrl = ev.url; saveAccounts(); }
    tick();
  } else if (state === 'reset') {
    onResetSeen(a.id, ev.url, at);
  } else {
    onLimitSeen(a.id, ev.text, ev.url, at);
  }
}

function initLimitWatcher() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.addListener) return;
  G.addListener('pageText', onPageEvent);
  drainLimitEvents();
}

// Ambil laporan halaman yang tertangkap saat layar utama di belakang browser
async function drainLimitEvents() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.takePending) return;
  try {
    const res = await G.takePending();
    for (const it of (res.items || [])) onPageEvent(it);
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
  checkBtn = el('button', { type: 'button', class: 'tbtn', text: '⟳ Cek semua akun', onclick: checkAll });
  autoSel = el('select', { class: 'tsel', 'aria-label': 'Cek otomatis', onchange: onAutoChange });
  for (const [m, label] of AUTO_OPTS) {
    autoSel.append(el('option', { value: String(m), text: m ? `Auto cek: ${label}` : 'Auto cek: Mati' }));
  }
  autoSel.value = String(settings.autoMin);
  autoHint = el('div', { class: 'hint2 autohint' });
  const tools = el('div', { class: 'tools' },
    checkBtn,
    autoSel,
    el('button', { type: 'button', class: 'tbtn', text: '⬇ Ekspor data', onclick: exportData }),
    el('button', { type: 'button', class: 'tbtn', text: '⬆ Impor data', onclick: importData }),
  );
  s.after(tools);
  tools.after(autoHint);
  updateAutoHint();
}

// ---------- Status turunan satu akun ----------
function view(a) {
  const working = a.status === 'working';
  const list = a.projects;
  const ms = working && a.resetAt ? Date.parse(a.resetAt) - Date.now() : null;
  const waiting = ms !== null && ms > 0;
  const over = ms !== null && ms <= 0;
  const now = Date.now();
  const live = now - (busyAt.get(a.id) || 0) < BUSY_TTL;
  const c = a.check;
  const checkBusy = !!c && c.state === 'busy' && now - c.at < CHECK_BUSY_TTL;
  const loggedOut = !!c && c.state === 'loggedout';
  // Chat menampilkan Continue / Try again (atau limit sudah selesai) dan Claude tidak sedang bekerja
  const resumable = !!c && (c.state === 'resume' || c.state === 'reset') && now - c.at < RESUME_TTL && !live;
  return {
    working, list, ms, waiting, over, loggedOut, resumable,
    busy: live || checkBusy,
    busyFromCheck: !live && checkBusy,
    checkAge: c ? now - c.at : 0,
    can: resumable || (!waiting && list.length > 0),
  };
}

// Keterangan di samping tombol Continue. Kondisi:
//  - belum login                         -> "Belum login"
//  - limit aktif (pending sampai reset)  -> "Pending Project"
//  - Claude sedang berpikir / bekerja    -> "There is Project in progress"
//  - tidak ada apa-apa                   -> "No projects in progress"
function noteText(v) {
  if (v.loggedOut) return 'Belum login · tekan 🔗';
  if (v.resumable) return 'Continue / Try again terdeteksi · tekan Continue';
  if (v.waiting) return `Pending Project · ${countdownShort(v.ms)}`;
  if (v.busy) return 'There is Project in progress' + (v.busyFromCheck ? ` · cek ${ago(v.checkAge)}` : '');
  if (v.list.length) return `Pending Project · siap lanjut (${v.list.length})`;
  return 'No projects in progress';
}

// Akun kembali Free (hitung mundur selesai atau limit sudah reset)
function freeUp(a) {
  a.status = 'free';
  a.resetAt = null;
  a.resetSrc = null;
  a.resetAuto = null;
  a.percent = 100;
  a.notified = false;
}

// Limit sudah reset: jalankan Continue otomatis (tanpa konfirmasi), beri info, lalu status jadi Free.
// why: 'timer' = hitung mundur selesai, 'page' = chat menampilkan "You can try again now"
async function autoResume(a, why) {
  if (a.status !== 'working') return;
  // Satu browser dibuka pada satu waktu. Akun lain menunggu giliran (dicoba lagi di tick berikutnya).
  if (resumeBusy || checking) return;
  if (Date.now() - (resumeAt.get(a.id) || 0) < RESUME_GUARD) return;
  resumeBusy = true;
  try {
    resumeAt.set(a.id, Date.now());
    busyAt.delete(a.id);
    const reason = resumeWhy.get(a.id) || why;
    resumeWhy.delete(a.id);

    const p = a.projects.shift();
    freeUp(a);
    if (a.check && (a.check.state === 'reset' || a.check.state === 'resume')) a.check = { state: 'idle', at: Date.now() };
    commit();

    const src = reason === 'page' ? 'Chat menampilkan "You can try again now"'
      : reason === 'check' ? 'Cek akun: limit sudah tidak aktif'
      : 'Hitung mundur limit selesai';
    const rest = a.projects.length ? ` Sisa ${a.projects.length} project, tekan Continue lagi.` : '';
    toast(p
      ? `${src}. Limit "${a.name}" sudah reset. Continue otomatis: "${p.name}". Status: Free.${rest}`
      : `${src}. Limit "${a.name}" sudah reset. Status: Free.`, 6500);
    if (!p) return;
    await new Promise((r) => setTimeout(r, RESUME_DELAY));
    await openAccount(a, buildCommand(a, p), a.chatUrl);
    await new Promise((r) => setTimeout(r, 1500));
  } finally {
    resumeBusy = false;
  }
}

// Akun yang hitung mundurnya sudah habis -> auto-continue + Free. Hanya saat app terlihat,
// supaya browser tidak dibuka dari latar belakang. Kalau app tertutup, notifikasi yang memicunya.
function checkDue() {
  if (document.hidden || resumeBusy || checking) return;
  const now = Date.now();
  for (const a of accounts.slice()) {
    if (a.status === 'working' && a.resetAt && Date.parse(a.resetAt) <= now) {
      autoResume(a, 'timer');
      break;   // satu akun per pengecekan
    }
  }
}

// ---------- Cek akun di belakang layar ----------
// Hasil satu cek: {state, text, url}. state: limit, busy, reset, idle, loggedout, unknown
function applyCheck(a, res) {
  const at = Date.now();
  const state = res.state || 'unknown';
  a.check = { state, at };
  if (state === 'busy') busyAt.set(a.id, at); else busyAt.delete(a.id);
  if (/^https:\/\/claude\.ai\/chat\//.test(res.url || '') && !a.chatUrl) a.chatUrl = res.url;

  if (state === 'limit') {
    onLimitSeen(a.id, res.text, res.url, at);          // set Working + jam reset dari banner
  } else if (state === 'reset') {
    if (a.status === 'working') markLimitOver(a, 'page');
  } else if (state === 'idle' && a.status === 'working' && a.resetAt && Date.parse(a.resetAt) > at) {
    // Chat terbuka normal tanpa banner limit: limit sudah tidak aktif
    markLimitOver(a, 'check');
  }
  commit();
}

function setCheckBtn(text) {
  if (!checkBtn) return;
  checkBtn.textContent = text || '⟳ Cek semua akun';
  checkBtn.disabled = !!text;
}

// Perbarui tombol ⟳ di semua kartu (aktif / sedang mengecek)
function refreshChecking() {
  for (const a of accounts) {
    const root = cards.get(a.id);
    if (root) live(root, a);
  }
}

// Cek satu atau beberapa akun berurutan di belakang layar. Hasil tiap akun langsung dipasang ke kartunya.
// opts.auto: dipicu jadwal (toast hanya muncul kalau aplikasi sedang terlihat)
// Mengembalikan true kalau pengecekan selesai, false kalau tidak jalan atau ditunda.
async function runChecks(list, opts = {}) {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.check) { if (!opts.auto) toast('Cek akun hanya jalan di aplikasi Android.'); return false; }
  if (checking) { if (!opts.auto) toast('Pengecekan lain masih berjalan.'); return false; }
  if (!list.length) { if (!opts.auto) toast('Belum ada akun.'); return false; }
  checking = true;
  updateAutoHint();
  const tally = {};
  let aborted = '';
  let lastLabel = '';
  try {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!accounts.includes(a)) continue;
      checkingId = a.id;
      setCheckBtn(list.length > 1 ? `Cek ${i + 1}/${list.length}...` : 'Mengecek...');
      refreshChecking();
      let res;
      try {
        res = await G.check({ accountId: a.id, url: a.chatUrl || CLAUDE_URL, timeoutMs: CHECK_TIMEOUT });
      } catch (e) { res = { state: 'unknown' }; }
      // Ada browser terbuka atau cek lain berjalan: hentikan, jangan timpa status akun dengan "tidak terbaca"
      if (res.error) { aborted = res.error; break; }
      applyCheck(a, res);
      lastLabel = CHECK_LABEL[res.state] || CHECK_LABEL.unknown;
      tally[lastLabel] = (tally[lastLabel] || 0) + 1;
    }
  } finally {
    checking = false;
    checkingId = null;
    setCheckBtn(null);
    refreshChecking();
    updateAutoHint();
  }
  if (aborted) {
    if (!opts.auto) toast(aborted === 'browser' ? 'Tutup browser aplikasi dulu, lalu cek lagi.' : 'Pengecekan lain masih berjalan.');
    return false;
  }
  if (!opts.auto || !document.hidden) {
    const head = opts.auto ? 'Cek otomatis selesai. ' : 'Cek selesai. ';
    toast(list.length === 1
      ? `Cek "${shortName(list[0].name)}": ${lastLabel || CHECK_LABEL.unknown}.`
      : head + Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ') + '.', 6000);
  }
  return true;
}

function checkAll() { return runChecks(accounts.slice()); }
function checkOne(a) { return runChecks([a]); }

// ---------- Cek otomatis berkala ----------
function onAutoChange() {
  const m = parseInt(autoSel.value, 10) || 0;
  // Dari mati ke aktif: hitungan mulai dari sekarang
  if (!settings.autoMin && m) settings.lastAuto = Date.now();
  settings.autoMin = m;
  saveSettings();
  updateAutoHint();
  const label = (AUTO_OPTS.find(([x]) => x === m) || [0, ''])[1];
  toast(m ? `Cek otomatis semua akun tiap ${label}.` : 'Cek otomatis dimatikan.');
}

function updateAutoHint() {
  if (!autoHint) return;
  let t;
  if (!settings.autoMin) {
    t = 'Cek otomatis mati. Pakai tombol ⟳ di tiap akun atau "Cek semua akun".';
  } else if (checking) {
    t = 'Sedang mengecek akun di belakang layar...';
  } else {
    const next = Math.max(settings.lastAuto + settings.autoMin * 60000, Date.now());
    const hm = new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    t = `Cek otomatis berikutnya sekitar ${hm}.`;
  }
  if (autoHint.textContent !== t) autoHint.textContent = t;
}

// Dipanggil tiap detik dan saat aplikasi dibuka lagi. Kalau jadwal terlewat (aplikasi tertutup), langsung dijalankan.
function maybeAutoCheck() {
  if (!native || !settings.autoMin || checking || resumeBusy || !accounts.length) return;
  const now = Date.now();
  if (now < settings.lastAuto + settings.autoMin * 60000 || now < autoHoldUntil) return;
  autoCheck();
}

async function autoCheck() {
  autoHoldUntil = Date.now() + 60000;   // kalau ditunda (browser terbuka), coba lagi semenit kemudian
  const ok = await runChecks(accounts.slice(), { auto: true });
  if (ok) { settings.lastAuto = Date.now(); saveSettings(); updateAutoHint(); }
}

// Tombol Continue manual (untuk project sisa atau saat auto-continue belum jalan)
async function doContinue(a) {
  if (checking) { toast('Tunggu pengecekan akun selesai dulu.'); return; }
  const v = view(a);
  if (!v.can) {
    toast(v.waiting ? `Limit belum reset. Tunggu ${countdownShort(v.ms)}.` : 'Tidak ada project yang terhenti.');
    return;
  }
  const p = a.projects[0];
  // Browser membuka chat lalu menekan Continue / Try again. Kalau tombolnya tidak ada, command diketik dan dikirim.
  // Command juga disalin ke clipboard sebagai cadangan.
  await openAccount(a, p ? buildCommand(a, p) : OLD_CMD, a.chatUrl, true);
  a.projects.shift();
  if (a.status === 'working') freeUp(a);
  // Matikan warna hijau sampai halaman melapor lagi
  a.check = { state: 'idle', at: Date.now() };
  commit();
  toast(`Continue dikirim ke chat "${shortName(a.name)}". Kalau tidak terkirim, command sudah disalin: tempel di chat.`
    + (a.projects.length ? ` Sisa ${a.projects.length} project, tekan Continue lagi.` : ''), 6000);
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
  r.chkBtn = el('button', {
    type: 'button', class: 'link', text: '⟳',
    title: 'Cek akun ini di belakang layar', 'aria-label': 'Cek akun ini',
    onclick: () => checkOne(a),
  });
  const r2 = el('div', { class: 'r2' }, r.go, r.note, r.chkBtn, link, chev);

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
      setResetManual(a, new Date(e.target.value).toISOString());
    },
  });
  r.src = el('div', { class: 'hint2 srcline' });
  r.useAuto = el('button', { type: 'button', class: 'chip', text: '↺ Pakai otomatis', onclick: () => useAutoReset(a) });
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
  r.email = el('input', {
    type: 'email', inputmode: 'email', placeholder: 'email@gmail.com', autocomplete: 'off',
    onchange: (e) => {
      const v = e.target.value.trim();
      if (v && !v.includes('@')) {
        toast('Email tidak valid.');
        e.target.value = a.email || '';
        return;
      }
      a.email = v || null;
      commit();
    },
  });
  r.chk = el('div', { class: 'hint2' });
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
      el('label', { text: 'Email login otomatis (kosongkan jika nama akun sudah berupa email)' }),
      r.email,
      r.chk,
    ),
    el('div', { class: 'field' },
      el('label', { class: 'chk' }, r.notesChk, el('span', { text: 'Pasang note di akun ini' })),
    ),
    el('div', { class: 'field only-free' }, el('label', { text: 'Sisa token (%)' }), r.pct),
    el('div', { class: 'field only-working' },
      el('label', { text: 'Limit reset pada (otomatis dari chat, bisa diatur manual)' }),
      r.when,
      el('div', { class: 'chips' },
        el('span', { class: 'hint2', text: 'Atur manual:' }),
        ...[1, 2, 3, 5].map((h) => el('button', { type: 'button', class: 'chip', text: `+${h} jam`, onclick: () => setResetIn(a, h) })),
        r.useAuto,
      ),
      r.src,
      r.cd, r.full,
    ),
    el('div', { class: 'field only-working proj' },
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
  root.classList.toggle('busy', v.busy && !v.waiting);
  root.classList.toggle('ready', v.can && !v.resumable);
  root.classList.toggle('resume', v.resumable);
  root.classList.toggle('has-pj', v.list.length > 0);
  r.go.disabled = !v.can;
  r.note.textContent = noteText(v);
  const mine = checkingId === a.id;
  r.chkBtn.disabled = checking;
  r.chkBtn.textContent = mine ? '…' : '⟳';
  root.classList.toggle('checking', mine);

  let pt = 'Idle', pc = 'idle';
  if (v.resumable) { pt = 'Resume'; pc = 'resume'; }
  else if (v.waiting) { pt = v.list.length ? `Paused ${v.list.length}` : 'Paused'; pc = 'paused'; }
  else if (v.busy) { pt = 'Running'; pc = 'running'; }
  else if (v.list.length) { pt = `Ready ${v.list.length}`; pc = 'ready'; }
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
  r.rstV.textContent = working ? timeShort(a) + (a.resetSrc === 'manual' ? ' ✎' : '') : `${a.percent}%`;
  setVal(r.name, a.name);
  setVal(r.pct, String(a.percent));
  setVal(r.when, a.resetAt ? toLocalInput(a.resetAt) : '');
  setVal(r.cmd, cmdTemplate(a));
  setVal(r.chat, a.chatUrl || '');
  setVal(r.email, a.email || '');
  r.chk.textContent = a.check
    ? `Dicek ${new Date(a.check.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}: ${CHECK_LABEL[a.check.state] || CHECK_LABEL.unknown}`
    : 'Belum pernah dicek. Tekan ⟳ di baris akun ini atau "Cek semua akun".';
  r.notesChk.checked = !!a.notesOn;
  r.full.textContent = a.resetAt ? `Reset: ${fmt.format(new Date(a.resetAt))}` : '';
  r.src.textContent = resetSource(a);
  r.useAuto.hidden = a.resetSrc !== 'manual';
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
  checkDue();
  maybeAutoCheck();
  updateAutoHint();
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
  await loadSettings();
  await initNotifications();
  initLimitWatcher();
  initTools();
  render();
  scheduleAll();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); drainLimitEvents(); checkDue(); maybeAutoCheck(); } });
})();
