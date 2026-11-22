const OLD_CMD = 'Lanjutkan task sebelumnya dari bagian terakhir yang belum selesai.';
const DEFAULT_CMD = 'Lanjutkan project "{project}" dari bagian terakhir yang belum selesai.';
const CLAUDE_URL = 'https://claude.ai/new';
const LOGIN_URL = 'https://claude.ai/login';
// Kunci penyimpanan per pengguna: diisi setelah login (lihat Auth.key di auth.js)
let STORE_KEY = 'accounts';
let SETTINGS_KEY = 'settings';
let HISTORY_KEY = 'history';
const HISTORY_MAX = 100;         // jumlah riwayat yang disimpan (yang paling lama dibuang)

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
const CHECK_TIMEOUT = 58000;     // ms: batas waktu cek satu akun di belakang layar. Cek berhenti begitu hasil jelas. Kalau 25 detik belum ada hasil, halaman di-refresh sekali dan ditunggu sampai batas ini (sekitar 25 + 30 detik)
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
// lastAuto = patokan jadwal cek otomatis berikutnya.
// quietOn/quietStart/quietEnd = jam tenang (tidak ada cek otomatis berkala). quietEndDay / quietPreDay = tanggal cek jam tenang terakhir (sekali per hari).
// firstDone = cek pertama kali pakai sudah dijalankan.
const settings = { autoMin: 60, lastAuto: 0, baitOn: true, lastBait: 0, quietOn: true, quietStart: '01:00', quietEnd: '05:00', quietEndDay: '', quietPreDay: '', firstDone: false };

// ---------- Fitur pancingan ----------
// Tiap akun: chat baru -> kirim "." -> respon Claude dihentikan secepatnya -> catat limit / free di memori sementara.
// Sesi pertama = tombol 🎣 (cek otomatis menunggu itu). Sesudahnya tiap BAIT_INTERVAL (3 jam): begitu cek otomatis mau jalan dan sudah 3 jam sejak pancingan terakhir, cek itu didahului pancingan.
const BAIT_INTERVAL = 3 * 3600 * 1000;
const BAIT_TIMEOUT = 85000;      // ms: batas waktu satu langkah pancingan per akun (muat halaman + tunggu balasan Claude)
let baitMemory = new Map();      // id akun -> {state, text, chatUrl, at, verified, deleted, mismatch}. Hanya di RAM, dikosongkan begitu pengecekan selesai memakainya.
let quietBtn = null;              // tombol 🌙 jam tenang
let baitRunBtn = null;           // tombol 🎣: ketuk = ON / OFF pancingan, tahan 1 detik = pancing sekarang

// ---------- Continue di latar belakang dan pantau "selesai berpikir" ----------
const CONTINUE_TIMEOUT = 50000;  // ms: batas waktu kirim Continue di sesi tersembunyi (termasuk muat + refresh halaman)
const WATCH_EVERY = 60000;       // ms: jeda pengecekan ulang akun yang Claude-nya sedang bekerja
const WATCH_MAX = 90 * 60 * 1000;   // ms: berhenti memantau kalau tidak selesai-selesai
const watching = new Map();      // id akun -> waktu mulai dipantau (Claude terlihat bekerja, menunggu selesai)
let watchNext = 0;               // ms: waktu pantau berikutnya

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
      migrateMemo(a);
    }
    return list;
  } catch { return []; }
}
async function saveAccounts() {
  syncBg();
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
      if (typeof st.baitOn === 'boolean') settings.baitOn = st.baitOn;
      if (typeof st.lastBait === 'number') settings.lastBait = st.lastBait;
      if (typeof st.quietOn === 'boolean') settings.quietOn = st.quietOn;
      if (/^\d{2}:\d{2}$/.test(st.quietStart || '')) settings.quietStart = st.quietStart;
      if (/^\d{2}:\d{2}$/.test(st.quietEnd || '')) settings.quietEnd = st.quietEnd;
      if (typeof st.quietEndDay === 'string') settings.quietEndDay = st.quietEndDay;
      if (typeof st.quietPreDay === 'string') settings.quietPreDay = st.quietPreDay;
      // Pengguna lama (pengaturan sudah tersimpan sebelum fitur ini) tidak dianggap pemakaian pertama
      settings.firstDone = typeof st.firstDone === 'boolean' ? st.firstDone : true;
    }
  } catch {}
  // Pemakaian pertama: hitungan jadwal mulai dari sekarang
  if (!settings.lastAuto) { settings.lastAuto = Date.now(); saveSettings(); }
  // lastBait = 0 (belum pernah memancing): pancingan otomatis baru aktif setelah tombol 🎣 dijalankan sekali. Cek otomatis tidak menunggu itu.
}
// ---------- Riwayat pancingan & pengecekan ----------
// Tiap item: {id, at (ms), kind: 'check' | 'bait', ok (true = berhasil dijalankan), detail}
let histLog = [];
let histDrawer = null;           // elemen slide riwayat
let histBackdrop = null;
let histListEl = null;
let histImgEl = null;            // wallpaper slide riwayat (seluruh tinggi slide)
let histImgUrl = null;           // object URL gambar buatan pengguna

async function loadHistory() {
  try {
    const raw = native && P.Preferences
      ? (await P.Preferences.get({ key: HISTORY_KEY })).value
      : localStorage.getItem(HISTORY_KEY);
    const list = JSON.parse(raw || '[]');
    histLog = Array.isArray(list)
      ? list.filter((h) => h && typeof h.at === 'number' && (h.kind === 'check' || h.kind === 'bait')).slice(0, HISTORY_MAX)
      : [];
  } catch { histLog = []; }
}
async function saveHistory() {
  const raw = JSON.stringify(histLog);
  try {
    if (native && P.Preferences) await P.Preferences.set({ key: HISTORY_KEY, value: raw });
    else localStorage.setItem(HISTORY_KEY, raw);
  } catch {}
}
function addHistory(kind, ok, detail, at, info) {
  const item = { id: uid(), at: at || Date.now(), kind, ok: !!ok, detail: detail || '' };
  if (info && info.fails && info.fails.length) item.info = info;
  histLog.unshift(item);
  histLog.sort((x, y) => y.at - x.at);
  if (histLog.length > HISTORY_MAX) histLog.length = HISTORY_MAX;
  saveHistory();
  renderHistory();
}

async function saveSettings() {
  syncBg();
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
    const extra = ev.notification.extra || {};
    if (extra.kind === 'done') return;   // notifikasi "Claude selesai": cukup membuka aplikasi
    const a = accounts.find((x) => x.id === extra.accountId);
    if (a) { a.notified = true; autoResume(a, 'timer'); }
  });
}

// Notifikasi "Claude selesai": dikirim saat akun yang tadinya bekerja kini idle (bukan limit)
async function notifyDone(a) {
  toast(`Claude di "${shortName(a.name)}" sudah selesai.`, 6000);
  if (!native || !P.LocalNotifications) return;
  try {
    await P.LocalNotifications.schedule({ notifications: [{
      id: (notifId(a.id) + 7) % 2147483000 + 1,
      title: `${shortName(a.name)}: Claude sudah selesai`,
      body: 'Chat selesai diproses. Buka aplikasi untuk melanjutkan.',
      extra: { accountId: a.id, kind: 'done' },
    }] });
  } catch (e) { console.error(e); }
}

// Dipanggil tiap ada status baru dari halaman (browser atau cek). Mencatat akun yang sedang bekerja,
// dan memberi notifikasi saat pekerjaan itu selesai (idle). Limit / Continue / belum login: pantauan dihentikan, status berubah seperti biasa.
function trackWork(a, state) {
  if (state === 'busy') {
    if (!watching.has(a.id)) watching.set(a.id, Date.now());
    return;
  }
  if (!watching.has(a.id)) return;
  if (state === 'idle') { watching.delete(a.id); notifyDone(a); }
  else if (state !== 'unknown') watching.delete(a.id);
}

// Akun yang Claude-nya sedang bekerja dicek ulang tiap menit (di belakang layar) sampai selesai
function watchBusy() {
  if (!native || !watching.size || checking || resumeBusy) return;
  const now = Date.now();
  if (now < watchNext) return;
  const list = [];
  for (const [id, since] of watching) {
    const a = accounts.find((x) => x.id === id);
    if (!a || now - since > WATCH_MAX) { watching.delete(id); continue; }
    if (now - (busyAt.get(id) || 0) < BUSY_TTL) continue;   // browser terbuka dan masih melapor langsung
    list.push(a);
  }
  watchNext = now + WATCH_EVERY;
  if (list.length) runChecks(list, { silent: true, auto: true }).then(() => { watchNext = Date.now() + WATCH_EVERY; });
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

function abortReason(code) {
  return code === 'browser' ? 'gagal: browser aplikasi sedang terbuka' : 'gagal: pengecekan lain masih berjalan';
}

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
const LIMIT_RE = /out of (free )?messages|usage limit|limit (will )?reset|kehabisan pesan|batas penggunaan|upgrade to keep chatting|keep chatting with claude pro|free messages return|keep going now with pro|free usage ran out|usage ran out|hit your [^\n]{0,40}limit/i;

// "until 4:00 PM", "resets at 2:50 PM" atau "hingga 16.00" -> waktu berikutnya dengan jam itu (dihitung dari saat banner terlihat)
function parseResetAt(text, ref = Date.now()) {
  const m = /(?:until|hingga|sampai|resets?(?:\s+at)?|returns?(?:\s+at)?|reset pada)\s+(\d{1,2})[:.](\d{2})\s*(AM|PM)?/i.exec(text);
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
  limitCore(a, parsed, url, ref);
}

// Pasang status Limit dari jam reset (at boleh kosong = jam tidak diketahui). Dipakai oleh teks limit dan data pemakaian.
function limitCore(a, at, url, ref) {
  limitSeenAt.set(a.id, ref);
  busyAt.delete(a.id);
  // Simpan link chat tempat limit muncul, supaya Continue membuka chat itu
  const chat = /^https:\/\/claude\.ai\/chat\//.test(url || '') ? url : null;
  const chatChanged = !!chat && a.chatUrl !== chat;
  if (chatChanged) a.chatUrl = chat;
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
  toast(`Limit terdeteksi di "${a.name}". Status: Limit, Pending Project sampai limit reset.`);
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
  trackWork(a, state);
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

// ---------- Waktu reset manual (opsi kedua) ----------
// Dipakai kalau jam reset yang terbaca aplikasi salah. Ketuk kolom "Reset" di baris akun.
function openResetEditor(a) {
  if (a.status !== 'working') { toast('Atur waktu reset hanya saat status Limit.'); return; }
  const inp = el('input', { type: 'datetime-local' });
  inp.value = toLocalInput(a.resetAt || new Date().toISOString());
  const info = el('div', { class: 'hint2', text: resetSource(a) || 'Waktu reset belum diatur.' });
  const save = () => {
    if (!inp.value) { toast('Pilih tanggal dan jam dulu.'); return; }
    const t = new Date(inp.value).getTime();
    if (Number.isNaN(t)) { toast('Waktu tidak valid.'); return; }
    closeModal();
    setResetManual(a, new Date(t).toISOString());
    toast(`Waktu reset manual: ${atShort(a.resetAt)}.`);
  };
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Waktu reset manual' }),
    el('div', { class: 'hint2', text: 'Pakai kalau jam di aplikasi beda dengan jam di web Claude. Waktu manual dipertahankan sampai limit selesai atau kamu tekan "Pakai otomatis".' }),
    inp,
    info,
    el('div', { class: 'chips' },
      ...[1, 2, 3, 5].map((h) => el('button', { type: 'button', class: 'chip', text: `+${h} jam`, onclick: () => { closeModal(); setResetIn(a, h); } })),
      a.resetSrc === 'manual' ? el('button', { type: 'button', class: 'chip', text: '↺ Pakai otomatis', onclick: () => { closeModal(); useAutoReset(a); } }) : null,
    ),
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Batal', onclick: closeModal }),
      el('button', { type: 'button', class: 'btn sm', text: 'Simpan', onclick: save }),
    ),
  );
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

// ---------- NOTE: satu tulisan di akun, sekaligus penanda berwarna dan catatan ----------
// Model lama (banyak note, tiap note punya nama + isi) digabung jadi satu: a.memo = {text, color}
function migrateMemo(a) {
  if (a.memo && typeof a.memo === 'object') {
    if (typeof a.memo.text !== 'string') a.memo.text = '';
    if (typeof a.memo.color !== 'string') a.memo.color = NOTE_COLORS[0];
  } else {
    const old = Array.isArray(a.notes) ? a.notes : [];
    a.memo = {
      text: old.map((n) => [n.name, n.text].filter(Boolean).join(': ')).join('\n'),
      color: (old[0] && old[0].color) || NOTE_COLORS[0],
    };
  }
  a.notes = [];
}

// Ketuk tulisan NOTE di akun: pilih warna penanda dan tulis catatan. Close note menyimpan otomatis.
function openMemo(a) {
  const memo = a.memo;
  let timer;
  const area = el('textarea', { class: 'nedit', placeholder: 'Tulis catatan untuk akun ini...' });
  area.value = memo.text || '';
  area.addEventListener('input', () => {
    memo.text = area.value;
    clearTimeout(timer);
    timer = setTimeout(saveAccounts, 400);
  });
  const sw = NOTE_COLORS.map((c) => {
    const b = el('button', {
      type: 'button', class: 'swatch', 'aria-label': `Warna ${c}`,
      onclick: () => { memo.color = c; sw.forEach((x) => x.classList.toggle('on', x === b)); saveAccounts(); },
    });
    b.style.background = c;
    if (c === memo.color) b.classList.add('on');
    return b;
  });
  const close = () => {
    clearTimeout(timer);
    memo.text = area.value;
    closeModal();
    commit();
  };
  openModal(close,
    el('div', { class: 'mtitle', text: `NOTE · ${shortName(a.name)}` }),
    el('div', { class: 'swatches' }, ...sw),
    area,
    el('div', { class: 'mact between' },
      el('button', { type: 'button', class: 'btn-g', text: 'Kosongkan', onclick: () => { area.value = ''; memo.text = ''; saveAccounts(); } }),
      el('button', { type: 'button', class: 'btn sm', text: 'Close note', onclick: close }),
    ),
  );
  area.focus();
}

// ---------- Backup data ----------
// Dua cara: teks (salin / tempel) atau file (.json di folder Download).
const stamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

// Simpan teks sebagai file. Di aplikasi lewat plugin native (folder Download), di browser lewat unduhan biasa.
async function saveBackupFile(json) {
  const name = `claude-account-manager-${stamp()}.json`;
  const G = P.GeckoBrowser;
  if (native && G && G.saveFile) {
    try {
      const res = await G.saveFile({ name, content: json, mime: 'application/json' });
      toast(`Backup disimpan: ${res.where || name}`, 7000);
      return;
    } catch (e) {
      toast(`Gagal menyimpan file (${(e && e.message) || 'error'}). Pakai Salin teks.`, 6000);
      return;
    }
  }
  try {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(`Backup diunduh: ${name}`, 6000);
  } catch { toast('Gagal menyimpan file. Pakai Salin teks.', 5000); }
}

// Ekspor: semua akun, setelan, link chat, dan note
function exportData() {
  const json = JSON.stringify({ v: 1, accounts });
  const area = el('textarea', { class: 'nedit', readonly: true });
  area.value = json;
  area.style.minHeight = '26vh';
  area.addEventListener('focus', () => area.select());
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Ekspor data' }),
    el('div', { class: 'hint2', text: 'Pilih salah satu: simpan sebagai file, atau salin teksnya dan simpan di tempat aman. Isinya termasuk link chat dan catatan.' }),
    area,
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Tutup', onclick: closeModal }),
      el('button', {
        type: 'button', class: 'btn-g', text: 'Salin teks',
        onclick: async () => { await copyText(json); toast('Backup disalin ke clipboard.'); },
      }),
      el('button', { type: 'button', class: 'btn sm', text: 'Simpan file', onclick: () => saveBackupFile(json) }),
    ),
  );
}

// Impor: dari teks yang ditempel atau dari file. Akun dengan id sama diperbarui, yang baru ditambahkan.
function importData() {
  const area = el('textarea', { class: 'nedit', placeholder: 'Tempel isi backup di sini, atau pilih file...' });
  area.style.minHeight = '26vh';
  const picker = el('input', { type: 'file', accept: '.json,application/json,text/plain', hidden: true });
  picker.addEventListener('change', () => {
    const f = picker.files && picker.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { area.value = String(rd.result || ''); toast(`File "${f.name}" dibaca. Tekan Pulihkan.`, 4000); };
    rd.onerror = () => toast('File tidak bisa dibaca.');
    rd.readAsText(f);
    picker.value = '';
  });
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
      migrateMemo(a);
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
    el('div', { class: 'hint2', text: 'Tempel teks hasil Ekspor data, atau pilih file backup (.json). Akun yang sudah ada diperbarui, akun baru ditambahkan.' }),
    area,
    picker,
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Batal', onclick: closeModal }),
      el('button', { type: 'button', class: 'btn-g', text: 'Pilih file', onclick: () => picker.click() }),
      el('button', { type: 'button', class: 'btn sm', text: 'Pulihkan', onclick: run }),
    ),
  );
  area.focus();
}

// ---------- Slide riwayat (dari kiri, kurang dari setengah layar) ----------
function fmtHistTime(ms) {
  const d = new Date(ms);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderHistory() {
  if (!histListEl) return;
  if (!histLog.length) {
    histListEl.replaceChildren(el('p', { class: 'hint2 hempty', text: 'Belum ada riwayat. Riwayat muncul setelah pancingan atau pengecekan dijalankan.' }));
    return;
  }
  histListEl.replaceChildren(...histLog.map((h) => el('div', {
    class: `hitem tap ${h.ok ? 'ok' : 'bad'}`, role: 'button', tabindex: '0',
    onclick: () => showHistDetail(h),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showHistDetail(h); } },
  },
    el('div', { class: 'hrow' },
      el('span', { class: 'hkind', text: h.kind === 'bait' ? '🎣 Pancingan' : '⟳ Pengecekan' }),
      el('span', { class: 'hbadge', text: h.ok ? 'Berhasil' : 'Gagal' }),
    ),
    el('div', { class: 'htime', text: fmtHistTime(h.at) }),
    h.detail ? el('div', { class: 'hdet', text: h.detail }) : null,
    el('div', { class: 'hmore', text: h.ok ? 'Ketuk untuk detail' : 'Ketuk: lihat penyebab gagal' }),
  )));
}

// ---------- Detail riwayat: penyebab gagal dijelaskan lengkap ----------
// Catat satu kegagalan (atau akun belum login) dari hasil G.check / G.bait
function noteFail(fails, a, step, res) {
  if (!res || res.error) return;
  const st = res.state || 'unknown';
  if (st !== 'unknown' && st !== 'fail' && st !== 'loggedout') return;
  const m = /^why:(\S+)(.*)$/.exec(res.text || '');
  fails.push({
    who: shortName(a.name), step, state: st,
    why: m ? m[1] : '', extra: m ? m[2].trim().slice(0, 160) : '',
    diag: String(res.diag || '').slice(0, 320),
  });
  if (fails.length > 24) fails.length = 24;
}

function parseDiag(d) {
  const o = {};
  for (const part of String(d || '').split('; ')) {
    const i = part.indexOf('=');
    if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
  }
  return o;
}

// Penjelasan dan saran untuk satu kegagalan. Kembali {cause, fix}
function explainFail(f) {
  const d = parseDiag(f.diag);
  const hello = d.hello && d.hello !== 'tidak' ? d.hello : '';
  if (f.state === 'loggedout' || f.why === 'loggedout') {
    return { cause: 'Akun ini belum login di browser aplikasi (halaman yang terbuka adalah halaman login Claude).', fix: 'Tekan Connect / Login pada akun ini, masuk ke Claude sekali, lalu cek lagi.' };
  }
  if (/PEMERIKSAAN KEAMANAN/.test(hello) || f.why === 'challenge') {
    return { cause: 'claude.ai menampilkan pemeriksaan keamanan ("Verify you are human" / Cloudflare) di browser tersembunyi, sehingga halaman chat tidak pernah tampil.', fix: 'Buka akun ini lewat tombol Connect, selesaikan pemeriksaan sekali, lalu coba lagi. Kalau terus muncul, jangan terlalu sering mengecek (naikkan jeda cek otomatis).' };
  }
  switch (f.why) {
    case 'no-composer':
      return { cause: 'Halaman terbuka tetapi kolom chat tidak ditemukan dalam 30 detik. Biasanya akun belum login, atau halaman yang tampil bukan halaman chat' + (f.extra ? ` (${f.extra})` : '') + '.', fix: 'Pastikan akun sudah login lewat Connect. Kalau sudah login, tampilan claude.ai mungkin berubah: perbarui fungsi composer() di limitwatch/content.js.' };
    case 'text-not-inserted':
      return { cause: 'Kolom chat ketemu tapi titik (".") tidak berhasil diketik ke dalamnya.', fix: 'Cara mengisi kolom chat di claude.ai mungkin berubah: perbarui setValue() di limitwatch/content.js.' };
    case 'not-submitted':
      return { cause: 'Teks sudah masuk kolom chat tetapi pesan tidak terkirim (tombol kirim tidak ditemukan atau tidak bisa ditekan).', fix: 'Perbarui SEND_LABEL_RE / sendBtn() di limitwatch/content.js sesuai tombol kirim claude.ai sekarang.' };
    case 'no-response':
      return { cause: 'Pesan terkirim tetapi Claude tidak mulai membalas dan tidak muncul popup limit dalam batas waktu.', fix: 'Coba lagi nanti. Kalau terus begini, jaringan lambat atau Claude sedang bermasalah.' };
    case 'error':
      return { cause: `Skrip di halaman mengalami error${f.extra ? `: ${f.extra}` : ''}.`, fix: 'Kirim detail teknis ini untuk diperbaiki.' };
    default:
      break;
  }
  // Timeout / tidak terbaca: halaman tidak melapor sama sekali. Penyebabnya dibaca dari diagnosa native.
  if (d.ext && d.ext !== 'ok' && d.ext !== '?') {
    return { cause: `Ekstensi pembaca halaman gagal dipasang di browser aplikasi (${d.ext}). Tanpa ekstensi, halaman tidak bisa dibaca.`, fix: 'Pasang ulang APK terbaru. Pastikan folder www/limitwatch (manifest.json, background.js, content.js) ikut ter-build.' };
  }
  if (d.muat === 'tidak mulai') {
    return { cause: 'Halaman claude.ai tidak pernah mulai dimuat di browser tersembunyi.', fix: 'Cek koneksi internet. Kalau internet normal, tutup aplikasi sepenuhnya lalu buka lagi (mesin browser tersembunyi mungkin macet).' };
  }
  if (d.muat === 'gagal') {
    return { cause: 'Halaman claude.ai gagal dimuat (internet putus, sangat lambat, atau claude.ai tidak terjangkau).', fix: 'Cek koneksi internet lalu ulangi.' };
  }
  if (d.muat === 'belum selesai') {
    return { cause: 'Halaman claude.ai terlalu lama dimuat sampai batas waktu habis (internet lambat).', fix: 'Coba lagi saat koneksi lebih baik.' };
  }
  if (d.hello === 'tidak') {
    return { cause: 'Halaman sudah terbuka, tetapi skrip pembaca (limitwatch/content.js) tidak berjalan di halaman itu, jadi tidak ada laporan sama sekali. Penyebab paling mungkin: isi content.js salah atau rusak, atau ekstensi belum aktif di sesi ini.', fix: 'Pastikan limitwatch/content.js adalah skrip pembaca halaman (bukan skrip menu Control), lalu build ulang APK.' };
  }
  if (hello) {
    return { cause: 'Skrip pembaca berjalan di halaman, tetapi tidak menemukan tanda status yang dikenal (kolom chat, banner limit, atau halaman login) sampai batas waktu habis.', fix: 'Tampilan claude.ai mungkin berubah, atau halaman macet di layar lain. Lihat alamat halaman di detail teknis; perbarui pola di limitwatch/content.js.' };
  }
  return { cause: 'Halaman tidak melapor sampai batas waktu habis (timeout). Riwayat lama tidak menyimpan diagnosa, jadi penyebab pastinya tidak diketahui.', fix: 'Jalankan pengecekan lagi dengan APK versi baru: riwayat berikutnya akan memuat diagnosa lengkap.' };
}

let histDetailEl = null;
function closeHistDetail() { if (histDetailEl) { histDetailEl.remove(); histDetailEl = null; } }

function showHistDetail(h) {
  closeHistDetail();
  const fails = (h.info && h.info.fails) || [];
  const kids = [
    el('div', { class: 'hdhead' },
      el('b', { text: h.kind === 'bait' ? '🎣 Pancingan' : '⟳ Pengecekan' }),
      el('span', { class: `hbadge ${h.ok ? '' : 'badx'}`, text: h.ok ? 'Berhasil' : 'Gagal' }),
    ),
    el('div', { class: 'htime', text: fmtHistTime(h.at) }),
    el('p', { class: 'hdbody', text: h.detail || '-' }),
  ];

  // Kelompokkan kegagalan yang penyebabnya sama (misal 7 akun gagal karena hal yang sama)
  const groups = new Map();
  for (const f of fails) {
    const ex = explainFail(f);
    const key = ex.cause + '|' + ex.fix;
    if (!groups.has(key)) groups.set(key, { ex, items: [] });
    groups.get(key).items.push(f);
  }
  if (!fails.length && !h.ok) {
    const ex = explainFail({ state: 'unknown', why: /timeout/.test(h.detail || '') ? 'timeout' : '', diag: '' });
    groups.set('lama', { ex, items: [] });
  }
  for (const { ex, items } of groups.values()) {
    const accs = [...new Set(items.map((f) => `${f.who} (${f.step})`))];
    kids.push(el('div', { class: 'hdgrp' },
      el('div', { class: 'hdlbl', text: 'Penyebab' }),
      el('p', { class: 'hdtxt', text: ex.cause }),
      el('div', { class: 'hdlbl', text: 'Yang bisa dilakukan' }),
      el('p', { class: 'hdtxt', text: ex.fix }),
      accs.length ? el('div', { class: 'hdlbl', text: `Akun terdampak (${accs.length})` }) : null,
      accs.length ? el('p', { class: 'hdtxt', text: accs.join(', ') }) : null,
      items[0] && (items[0].diag || items[0].extra)
        ? el('pre', { class: 'hdtech', text: `Detail teknis: ${items[0].diag || ''}${items[0].extra ? `\n${items[0].extra}` : ''}` })
        : null,
    ));
  }
  if (h.ok && !fails.length) kids.push(el('p', { class: 'hint2', text: 'Tidak ada masalah pada proses ini.' }));

  const box = el('div', { class: 'hdbox', role: 'dialog', 'aria-label': 'Detail riwayat' }, ...kids,
    el('button', { type: 'button', class: 'btn sm hdclose', text: 'Tutup', onclick: closeHistDetail }));
  histDetailEl = el('div', { class: 'hdmodal', onclick: (e) => { if (e.target === histDetailEl) closeHistDetail(); } }, box);
  document.body.append(histDetailEl);
}

function initHistory() {
  histBackdrop = el('div', { class: 'hbackdrop', onclick: closeHistory });
  histListEl = el('div', { class: 'hlist' });
  histDrawer = el('aside', { class: 'hdrawer', 'aria-label': 'Riwayat', 'aria-hidden': 'true' },
    el('div', { class: 'hhead' },
      el('span', { class: 'htitle', text: 'Riwayat' }),
      el('button', { type: 'button', class: 'hx', text: '✕', 'aria-label': 'Tutup riwayat', onclick: closeHistory }),
    ),
    histListEl,
    el('button', {
      type: 'button', class: 'btn-g hclear', text: 'Hapus riwayat',
      onclick: () => {
        if (!histLog.length || !confirm('Hapus semua riwayat?')) return;
        histLog = [];
        saveHistory();
        renderHistory();
      },
    }),
  );
  // Ekspor + Impor sebaris: total 2 baris di bawah (Hapus riwayat, lalu Ekspor | Impor)
  histDrawer.append(el('div', { class: 'hbtns' },
    el('button', { type: 'button', class: 'btn-g hclear', text: '⬇ Ekspor', 'aria-label': 'Ekspor data', onclick: () => { closeHistory(); exportData(); } }),
    el('button', { type: 'button', class: 'btn-g hclear', text: '⬆ Impor', 'aria-label': 'Impor data', onclick: () => { closeHistory(); importData(); } }),
  ));
  // Wallpaper slide: memenuhi seluruh tinggi slide, di belakang semua isi
  histImgEl = el('div', { class: 'himg', 'aria-hidden': 'true' }, el('img', { alt: '', draggable: 'false' }));
  histDrawer.prepend(histImgEl);
  window.addEventListener('cam:histbg', applyHistImg);
  applyHistImg();
  document.body.append(histBackdrop, histDrawer);
  const menu = document.getElementById('menuBtn');
  if (menu) menu.addEventListener('click', openHistory);
  renderHistory();
}

// Gambar bawah slide riwayat: buatan pengguna (Control > Tampilan > Slide riwayat) atau gambar bawaan
async function applyHistImg() {
  if (!histImgEl) return;
  const img = histImgEl.firstChild;
  let rec = null;
  try { rec = window.Auth && Auth.media ? await Auth.media.get('hist') : null; } catch {}
  if (histImgUrl) { URL.revokeObjectURL(histImgUrl); histImgUrl = null; }
  histImgEl.classList.toggle('isdefault', !(rec && rec.blob));   // gambar bawaan tema punya posisi sendiri (lihat theme.css)
  if (rec && rec.blob) { histImgUrl = URL.createObjectURL(rec.blob); img.src = histImgUrl; }
  else img.src = (window.Auth && Auth.media && Auth.media.HIST_DEFAULT_URL) || 'assets/history-petronas.jpg';
}

// Gambar beranda: buatan pengguna (Control > Tampilan > Beranda); kosong = gambar bawaan
let homeImgUrl = null;
async function applyHomeImg() {
 try {
  const bg = document.querySelector('.bg');
  if (!bg) return;
  let box = bg.querySelector('.homeimg');
  if (!box) { box = el('div', { class: 'homeimg', 'aria-hidden': 'true' }, el('img', { alt: '', draggable: 'false' })); bg.append(box); }
  let rec = null;
  try { rec = window.Auth && Auth.media ? await Auth.media.get('home') : null; } catch {}
  if (homeImgUrl) { URL.revokeObjectURL(homeImgUrl); homeImgUrl = null; }
  if (rec && rec.blob) { homeImgUrl = URL.createObjectURL(rec.blob); box.firstChild.src = homeImgUrl; box.classList.add('on'); }
  else { box.firstChild.src = (window.Auth && Auth.media && Auth.media.HOME_DEFAULT_URL) || 'assets/home-petronas.jpg'; box.classList.add('on'); }
 } catch (e) { console.error('homeimg', e); }
}
window.addEventListener('cam:homebg', applyHomeImg);
// Ganti tema: gambar beranda dan riwayat ikut berganti (bawaan tema atau gambar buatan pengguna untuk tema itu)
window.addEventListener('themechange', () => { applyHomeImg(); applyHistImg(); });
applyHomeImg();

function openHistory() {
  if (!histDrawer) return;
  renderHistory();
  histBackdrop.classList.add('show');
  histDrawer.classList.add('open');
  histDrawer.setAttribute('aria-hidden', 'false');
}

function closeHistory() {
  if (!histDrawer) return;
  histBackdrop.classList.remove('show');
  histDrawer.classList.remove('open');
  histDrawer.setAttribute('aria-hidden', 'true');
}

function initTools() {
  const s = document.getElementById('summary');
  if (!s) return;
  checkBtn = el('button', { type: 'button', class: 'tbtn primary', text: '⟳ Cek akun', title: 'Cek semua akun', onclick: checkAll });
  autoSel = el('select', { class: 'tsel', 'aria-label': 'Cek otomatis', onchange: onAutoChange });
  for (const [m, label] of AUTO_OPTS) {
    autoSel.append(el('option', { value: String(m), text: m ? `⏱ ${label}` : '⏱ Mati' }));
  }
  autoSel.value = String(settings.autoMin);
  // 🎣 = pancing sekarang: harus DITAHAN 1 detik (anti kepencet). ON / OFF = sekali pencet.
  // 🎣 satu tombol: ketuk sekali = pancingan ON / OFF (tepi hijau / merah), tahan 1 detik = pancing sekarang
  baitRunBtn = el('button', { type: 'button', class: 'tbtn sq hold baitsw', text: '🎣', title: 'Tahan 1 detik: pancing sekarang, lalu cek semua akun', 'aria-label': 'Tahan 1 detik untuk memancing sekarang' });
  holdPress(baitRunBtn, 1000, () => { if (checking) toast('Sedang mengecek akun, tunggu sebentar.'); else baitNow(); }, () => toast('Pancingan hanya manual. Tahan tombol 🎣 selama 1 detik.'));
  updateBaitBtn();
  autoHint = el('div', { class: 'hint2 autohint' });
  quietBtn = el('button', { type: 'button', class: 'tbtn sq', text: '🌙', title: 'Jam tenang', 'aria-label': 'Atur jam tenang', onclick: openQuietEditor });
  const tools = el('div', { class: 'tools' }, checkBtn, autoSel, baitRunBtn, quietBtn);
  s.after(tools);
  tools.after(autoHint);
  updateAutoHint();
}

// Tombol yang baru jalan kalau ditahan ms milidetik. Lepas / geser sebelum waktunya = batal (onShort dipanggil kalau cuma diketuk).
function holdPress(btn, ms, onDone, onShort) {
  let timer = null;
  const stop = () => { if (timer) { clearTimeout(timer); timer = null; } btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', () => {
    if (btn.disabled) return;
    stop();
    btn.classList.add('holding');
    timer = setTimeout(() => {
      timer = null;
      btn.classList.remove('holding');
      try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) { /* tidak apa-apa */ }
      onDone();
    }, ms);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(type, () => {
      const pending = timer !== null;
      stop();
      if (pending && type === 'pointerup' && onShort) onShort();
    });
  }
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Isi kolom di baris akun yang Free: kapan terakhir dicek (abu-abu kalau sudah lebih dari 30 menit)
function tokenCell(a) {
  const now = Date.now();
  const c = a.check;
  return {
    k: 'Dicek', v: c ? ago(now - c.at) : '—',
    cls: c && now - c.at > 30 * 60000 ? 'stale' : '',
    title: c ? `Terakhir dicek ${new Date(c.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Belum pernah dicek',
  };
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
  const resetDone = resumable && c.state === 'reset';
  return {
    working, list, ms, waiting, over, loggedOut, resumable, resetDone,
    busy: live || checkBusy,
    busyFromCheck: !live && checkBusy,
    checkAge: c ? now - c.at : 0,
    can: resumable || over || (!waiting && list.length > 0),   // timer limit habis = Continue aktif (walau tanpa project)
  };
}

// Keterangan di samping tombol Continue. Kondisi:
//  - belum login                         -> "Belum login"
//  - limit aktif (pending sampai reset)  -> "Pending Project"
//  - Claude sedang berpikir / bekerja    -> "There is Project in progress"
//  - tidak ada apa-apa                   -> "No projects in progress"
function noteText(v) {
  if (v.loggedOut) return 'Belum login · tekan 🔗';
  if (v.resumable) return v.resetDone ? 'Limit selesai · tekan Continue' : 'Continue / Try again terdeteksi · tekan Continue';
  if (v.over) return 'Limit selesai · tekan Continue';
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
    // Tanpa project: Continue tetap aktif (state 'reset') supaya chat yang terhenti bisa dilanjutkan dengan satu ketukan
    if (!p) a.check = { state: 'reset', at: Date.now() };
    else if (a.check && (a.check.state === 'reset' || a.check.state === 'resume')) a.check = { state: 'idle', at: Date.now() };
    commit();

    const src = reason === 'page' ? 'Chat menampilkan "You can try again now"'
      : reason === 'check' ? 'Cek akun: limit sudah tidak aktif'
      : 'Hitung mundur limit selesai';
    const rest = a.projects.length ? ` Sisa ${a.projects.length} project, tekan Continue lagi.` : '';
    toast(p
      ? `${src}. Limit "${a.name}" sudah reset. Continue otomatis: "${p.name}". Status: Free.${rest}`
      : `${src}. Limit "${a.name}" sudah reset. Status: Free. Tombol Continue aktif.`, 6500);
    if (!p) return;
    await new Promise((r) => setTimeout(r, RESUME_DELAY));
    const text = buildCommand(a, p);
    // Kirim di belakang layar; browser baru dibuka kalau gagal
    checkingId = a.id;
    refreshChecking();
    let r;
    try { r = await sendContinueBackground(a, text); } finally { checkingId = null; refreshChecking(); }
    if (r.ok) { markWorking(a); commit(); }
    else if (r.limit) { a.projects.unshift(p); commit(); }   // ternyata masih limit: project dikembalikan
    else {
      await openAccount(a, text, a.chatUrl);
      await new Promise((res) => setTimeout(res, 1500));
    }
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
  trackWork(a, state);
  if (state === 'busy') busyAt.set(a.id, at); else busyAt.delete(a.id);
  if (/^https:\/\/claude\.ai\/chat\//.test(res.url || '') && !a.chatUrl) a.chatUrl = res.url;

  if (state === 'limit') {
    onLimitSeen(a.id, res.text, res.url, at);          // set Limit + jam reset dari banner / popup
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
  checkBtn.textContent = text || '⟳ Cek akun';
  checkBtn.disabled = !!text;
  if (baitRunBtn) baitRunBtn.classList.toggle('busy', !!text);
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
  const startedAt = Date.now();
  let known = 0;   // jumlah akun yang halamannya terbaca (bukan "tidak terbaca")
  const fails = [];   // catatan kegagalan per akun untuk detail riwayat
  const rows = [];    // hasil per akun, ditulis ke riwayat
  try {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!accounts.includes(a)) continue;
      if (!opts.silent) {
        checkingId = a.id;
        setCheckBtn(list.length > 1 ? `Cek ${i + 1}/${list.length}...` : 'Mengecek...');
        refreshChecking();
      }
      let res;
      try {
        res = await G.check({ accountId: a.id, url: a.chatUrl || CLAUDE_URL, timeoutMs: CHECK_TIMEOUT });
      } catch (e) { res = { state: 'unknown' }; }
      // Ada browser terbuka atau cek lain berjalan: hentikan, jangan timpa status akun dengan "tidak terbaca"
      if (res.error) { aborted = res.error; break; }
      applyCheck(a, res);
      if (res.state && res.state !== 'unknown') known++;
      noteFail(fails, a, 'Cek', res);
      lastLabel = CHECK_LABEL[res.state] || CHECK_LABEL.unknown;
      tally[lastLabel] = (tally[lastLabel] || 0) + 1;
      rows.push(`${shortName(a.name)}: ${lastLabel}`);
    }
  } finally {
    checking = false;
    checkingId = null;
    setCheckBtn(null);
    refreshChecking();
    updateAutoHint();
  }
  if (opts.silent) return !aborted;   // pantauan internal: tanpa riwayat dan tanpa toast
  {
    const who = opts.label || (opts.auto ? 'Otomatis' : 'Manual');
    const sum = list.length === 1
      ? `${shortName(list[0].name)}: ${lastLabel || CHECK_LABEL.unknown}`
      : (rows.length && rows.length <= 6 ? rows.join(', ') : Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', '));
    addHistory('check', !aborted && known > 0,
      aborted ? `${who} · ${abortReason(aborted)}${sum ? ` (${sum})` : ''}`
        : `${who} · ${sum || 'tidak ada hasil'}`, startedAt, { fails });
  }
  if (aborted) {
    if (!opts.auto) toast(aborted === 'browser' ? 'Tutup browser aplikasi dulu, lalu cek lagi.' : 'Pengecekan lain masih berjalan.');
    return false;
  }
  if (!opts.auto || !document.hidden) {
    const head = opts.label ? 'Status diperbarui. ' : opts.auto ? 'Cek otomatis selesai. ' : 'Cek selesai. ';
    toast(list.length === 1
      ? `Cek "${shortName(list[0].name)}": ${lastLabel || CHECK_LABEL.unknown}.`
      : head + Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ') + '.', 6000);
  }
  return true;
}

function baitDue() { return settings.baitOn && settings.lastBait > 0 && Date.now() - settings.lastBait >= BAIT_INTERVAL; }
function checkAll() { return runChecks(accounts.slice()); }
// Tombol 🎣: jalankan pancingan + pengecekan sekarang (tidak menunggu 3 jam, tetap jalan walau pancingan OFF)
function baitNow() { return runBaitCycle(accounts.slice()); }
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

// Layanan latar depan (notifikasi kecil) menjaga aplikasi tetap hidup selama cek otomatis atau pancingan aktif
let keepAliveOn = null;
function syncKeepAlive() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.keepAlive) return;
  const want = !!(settings.autoMin || settings.quietOn);
  if (want === keepAliveOn) return;
  keepAliveOn = want;
  try { G.keepAlive({ on: want }).catch(() => { keepAliveOn = null; }); } catch { keepAliveOn = null; }
}

function updateAutoHint() {
  syncKeepAlive();
  if (!autoHint) return;
  let t;
  if (checking) {
    t = 'Sedang mengecek akun di belakang layar...';
  } else if (!settings.autoMin) {
    t = 'Cek otomatis mati. Pakai tombol ⟳ di tiap akun atau "Cek semua akun".';
  } else if (inQuiet()) {
    t = `Jam tenang sampai ${settings.quietEnd}. Tidak ada cek otomatis berkala.`;
  } else {
    const next = Math.max(settings.lastAuto + settings.autoMin * 60000, Date.now());
    const hm = new Date(next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    t = `Cek otomatis berikutnya sekitar ${hm}.`;
  }
  if (settings.quietOn && !checking && !inQuiet()) t += ` Jam tenang ${settings.quietStart}-${settings.quietEnd}.`;
  if (autoHint.textContent !== t) autoHint.textContent = t;
}

// ---------- Cek saat aplikasi ditutup ----------
// Jadwal (berkala, sebelum / sesudah jam tenang) juga dijalankan native lewat alarm sistem, supaya tetap jalan walau aplikasi ditutup.
// syncBg mengirim pengaturan + daftar akun ke native. drainBg mengambil hasil cek yang dijalankan native saat aplikasi tertutup.
let bgReady = false;   // false sampai hasil native diambil, supaya data lama tidak menimpa data native
let bgSyncTimer = null;
function syncBg(now = false) {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.bgConfigure || !bgReady) return;
  clearTimeout(bgSyncTimer);
  const push = () => {
    const payload = {
      on: !!(settings.autoMin || settings.quietOn),
      autoMin: settings.autoMin,
      quietOn: settings.quietOn,
      quietStart: settings.quietStart,
      quietEnd: settings.quietEnd,
      lastAuto: settings.lastAuto,
      quietEndDay: settings.quietEndDay,
      quietPreDay: settings.quietPreDay,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name || '', url: a.chatUrl || CLAUDE_URL, limit: a.status === 'working' })),
    };
    try { return G.bgConfigure(payload).catch(() => {}); } catch { return null; }
  };
  if (now) return push();
  bgSyncTimer = setTimeout(push, 1500);
  return null;
}

async function drainBg() {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.bgTake) return;
  let r;
  try { r = await G.bgTake(); } catch { return; }
  if (!r) return;
  let changed = false;
  if (typeof r.lastAuto === 'number' && r.lastAuto > settings.lastAuto) { settings.lastAuto = r.lastAuto; changed = true; }
  if (typeof r.quietEndDay === 'string' && r.quietEndDay > settings.quietEndDay) { settings.quietEndDay = r.quietEndDay; changed = true; }
  if (typeof r.quietPreDay === 'string' && r.quietPreDay > settings.quietPreDay) { settings.quietPreDay = r.quietPreDay; changed = true; }
  for (const run of (r.runs || [])) {
    const rows = [];
    let known = 0;
    for (const it of (run.items || [])) {
      const a = accounts.find((x) => x.id === it.id);
      if (!a) continue;
      applyCheck(a, { state: it.state, text: it.text, url: it.url });
      if (it.state && it.state !== 'unknown') known++;
      rows.push(`${shortName(a.name)}: ${CHECK_LABEL[it.state] || CHECK_LABEL.unknown}`);
    }
    const first = (run.items || [])[0] || {};
    const where = first.view ? `, tampilan: ${first.view}` : '';
    const sum = rows.length ? rows.join(', ') : (run.err ? abortReason(run.err) : 'tidak ada hasil');
    addHistory('check', !run.err && known > 0, `${run.label || 'Otomatis'} (aplikasi tertutup${where}) · ${sum}`, run.at);
  }
  if (changed) saveSettings();
}

// ---------- Jam tenang ----------
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const nowMin = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function inQuiet(d = new Date()) {
  if (!settings.quietOn) return false;
  const s0 = toMin(settings.quietStart);
  const e0 = toMin(settings.quietEnd);
  const n = nowMin(d);
  if (s0 === e0) return false;
  return s0 < e0 ? (n >= s0 && n < e0) : (n >= s0 || n < e0);
}
// Akun yang tidak sedang Limit. Hanya akun ini yang dicek berkala (akun Limit cukup menunggu jam reset-nya).
const checkable = () => accounts.filter((a) => a.status !== 'working');

function openQuietEditor() {
  const G = P.GeckoBrowser;
  const bgInfo = el('div', { class: 'hint2', text: 'Memeriksa izin...' });
  const showBg = async () => {
    if (!native || !G || !G.bgStatus) { bgInfo.textContent = 'Fitur ini ada di aplikasi Android versi terbaru (APK baru).'; return; }
    try {
      const r = await G.bgStatus();
      bgInfo.textContent = `Tampil di atas aplikasi lain: ${r.overlay ? 'diizinkan' : 'BELUM diizinkan'}. Baterai tanpa batasan: ${r.battery ? 'ya' : 'BELUM'}. Alarm tepat waktu: ${r.exact ? 'ya' : 'BELUM'}.`;
    } catch { bgInfo.textContent = 'Status izin tidak terbaca.'; }
  };
  const bgOpen = (what) => async () => {
    try { await G.bgOpen({ what }); } catch { toast('Tidak bisa membuka pengaturan.'); }
  };
  const bgTest = async () => {
    if (!native || !G || !G.bgTest) { toast('Perlu APK terbaru.'); return; }
    await syncBg(true);
    try { await G.bgTest(); } catch { toast('Uji gagal dijadwalkan.'); return; }
    toast('Uji jalan 20 detik lagi. Tutup aplikasi sekarang, lalu buka lagi. Hasilnya ada di Riwayat.', 9000);
  };
  showBg();
  const on = el('input', { type: 'checkbox' });
  on.checked = settings.quietOn;
  const st = el('input', { type: 'time' });
  st.value = settings.quietStart;
  const en = el('input', { type: 'time' });
  en.value = settings.quietEnd;
  const save = () => {
    if (!st.value || !en.value) { toast('Isi jam mulai dan jam selesai dulu.'); return; }
    settings.quietOn = on.checked;
    settings.quietStart = st.value;
    settings.quietEnd = en.value;
    settings.quietEndDay = '';
    settings.quietPreDay = '';
    saveSettings();
    updateAutoHint();
    closeModal();
    toast(settings.quietOn ? `Jam tenang ${settings.quietStart}-${settings.quietEnd}.` : 'Jam tenang dimatikan.');
  };
  openModal(closeModal,
    el('div', { class: 'mtitle', text: 'Jam tenang' }),
    el('div', { class: 'hint2', text: 'Selama jam tenang tidak ada cek otomatis berkala. Beberapa menit sebelum jam tenang, semua akun yang belum Limit dicek sekali. Begitu jam tenang selesai, akun yang belum Limit dicek lagi. Akun Limit tidak dibuka halamannya, cukup menunggu jam reset.' }),
    el('label', { class: 'hint2' }, on, ' Aktifkan jam tenang'),
    el('div', { class: 'hint2', text: 'Mulai' }), st,
    el('div', { class: 'hint2', text: 'Selesai' }), en,
    el('div', { class: 'mtitle', text: 'Cek saat aplikasi ditutup' }),
    el('div', { class: 'hint2', text: 'Jadwal cek tetap jalan lewat alarm sistem walau aplikasi ditutup. Butuh izin di bawah. Di Xiaomi: aktifkan Autostart, kunci aplikasi di daftar aplikasi terbaru, dan atur baterai ke "Tanpa batasan".' }),
    bgInfo,
    el('div', { class: 'chips' },
      el('button', { type: 'button', class: 'chip', text: 'Izin tampil di atas aplikasi lain', onclick: bgOpen('overlay') }),
      el('button', { type: 'button', class: 'chip', text: 'Baterai tanpa batasan', onclick: bgOpen('battery') }),
      el('button', { type: 'button', class: 'chip', text: 'Alarm tepat waktu', onclick: bgOpen('exact') }),
      el('button', { type: 'button', class: 'chip', text: '↻ Periksa izin', onclick: showBg }),
      el('button', { type: 'button', class: 'chip', text: 'Uji 20 detik', onclick: bgTest }),
    ),
    el('div', { class: 'mact' },
      el('button', { type: 'button', class: 'btn-g', text: 'Batal', onclick: closeModal }),
      el('button', { type: 'button', class: 'btn sm', text: 'Simpan', onclick: save }),
    ),
  );
}

// Pemicu cek terjadwal selain interval: pertama kali dipakai, sebelum jam tenang, sesudah jam tenang.
// Dipanggil tiap detik. Hanya jalan kalau aplikasi hidup di jam itu (tidak mengejar jadwal yang terlewat saat aplikasi tertutup).
async function runScheduledTriggers() {
  if (!native || checking || resumeBusy || !accounts.length) return;
  const nowMs = Date.now();
  if (nowMs < autoHoldUntil) return;
  const now = new Date(nowMs);
  const today = dayKey(now);
  const finish = (ok, setKey) => {
    if (!ok) return;
    setKey();
    settings.lastAuto = Date.now();
    saveSettings();
    updateAutoHint();
  };

  // 1. Pertama kali dipakai: cek semua akun
  if (!settings.firstDone) {
    autoHoldUntil = nowMs + 60000;
    finish(await runChecks(accounts.slice(), { auto: true, label: 'Pertama kali dipakai' }), () => { settings.firstDone = true; });
    return;
  }
  if (!settings.quietOn) return;
  const s0 = toMin(settings.quietStart);
  const e0 = toMin(settings.quietEnd);
  if (s0 === e0) return;
  const n = nowMin(now);

  // 2. Jam tenang baru selesai (sampai 20 menit sesudahnya): cek akun yang belum Limit
  if ((n - e0 + 1440) % 1440 < 20 && settings.quietEndDay !== today) {
    autoHoldUntil = nowMs + 60000;
    const list = checkable();
    if (!list.length) { settings.quietEndDay = today; saveSettings(); return; }
    finish(await runChecks(list, { auto: true, label: 'Selesai jam tenang' }), () => { settings.quietEndDay = today; });
    return;
  }

  // 3. 5 menit sebelum jam tenang mulai: cek akun yang belum Limit
  const untilStart = (s0 - n + 1440) % 1440;
  if (untilStart > 0 && untilStart <= 5 && settings.quietPreDay !== today) {
    autoHoldUntil = nowMs + 60000;
    const list = checkable();
    if (!list.length) { settings.quietPreDay = today; saveSettings(); return; }
    finish(await runChecks(list, { auto: true, label: 'Sebelum jam tenang' }), () => { settings.quietPreDay = today; });
  }
}

// Cek berkala (30 menit, 1 jam, 2 jam, 5 jam). Tidak jalan saat jam tenang. Hanya akun yang belum Limit.
function maybeAutoCheck() {
  if (!native || !settings.autoMin || checking || resumeBusy || !accounts.length) return;
  if (inQuiet()) return;
  const now = Date.now();
  if (now < settings.lastAuto + settings.autoMin * 60000 || now < autoHoldUntil) return;
  autoCheck();
}

async function autoCheck() {
  autoHoldUntil = Date.now() + 60000;   // kalau ditunda (browser terbuka), coba lagi semenit kemudian
  const list = checkable();
  const ok = list.length ? await runChecks(list, { auto: true }) : true;
  if (ok) {
    settings.lastAuto = Date.now();
    saveSettings();
    updateAutoHint();
  }
}

// ---------- Pancingan ----------
function updateBaitBtn() {
  if (!baitRunBtn) return;
  // Pancingan tidak lagi jalan otomatis, jadi tidak ada penanda ON / OFF
  baitRunBtn.classList.remove('on', 'off');
}

function toggleBait() {
  settings.baitOn = !settings.baitOn;
  if (settings.baitOn && settings.lastBait) settings.lastBait = Date.now();   // dari OFF ke ON: hitungan 3 jam mulai dari sekarang (kalau belum pernah memancing, tetap langsung)
  saveSettings();
  updateBaitBtn();
  updateAutoHint();
  toast(settings.baitOn
    ? 'Pancingan ON. Jalan tiap 3 jam, mendahului cek otomatis.'
    : 'Pancingan OFF. Cek otomatis berjalan seperti biasa.');
}

const BAIT_LABEL = { limit: 'limit', free: 'free', loggedout: 'belum login', fail: 'gagal' };
// Alasan pancingan gagal (dikirim halaman sebagai "why:kode")
const BAIT_WHY = {
  'no-composer': 'kolom chat tidak ditemukan',
  'text-not-inserted': 'titik tidak masuk ke kolom chat',
  'not-submitted': 'pesan tidak terkirim',
  'no-response': 'pesan terkirim tapi Claude tidak membalas dan tidak ada popup limit',
  timeout: 'halaman tidak melapor (timeout)',
};
function baitWhy(text) {
  const m = /^why:(\S+)(.*)$/.exec(text || '');
  if (!m) return '';
  return BAIT_WHY[m[1]] || (m[1] === 'error' ? `error skrip${m[2]}` : m[1]);
}

// Pasang hasil pancingan ke akun: limit -> status Limit (+ jam reset dari teks), free -> limit dianggap selesai
function applyBait(a, state, text) {
  if (state === 'limit') {
    const t = LIMIT_RE.test(text || '') ? text : `out of messages ${text || ''}`;
    onLimitSeen(a.id, t, '', Date.now());
    if (a.status !== 'working') {
      // Teks limit tidak terbaca atau jam sudah lewat: tetap tandai Limit karena pancingan melihat status limit
      a.status = 'working';
      a.notified = false;
      a.resetAt = new Date(Date.now() + 5 * 3600e3).toISOString();
      a.resetSrc = 'default';
      commit();
    }
  } else if (state === 'free' && a.status === 'working') {
    markLimitOver(a, 'check');
  }
}

// Satu sesi pancingan untuk semua akun, lalu pengecekan:
//  1. Pancingan tiap akun (chat baru, kirim ".", Stop). Hasil dicatat di baitMemory.
//  2. Tiap akun: buka chat pancingan, bandingkan dengan memori, tentukan limit / free, hapus chat pancingan.
//  3. Kembali ke chat utama (link di banner) dan cek seperti biasa.
// Mengembalikan true kalau selesai, false kalau tidak jalan atau ditunda.
async function runBaitCycle(list, opts = {}) {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.bait || !G.check) return runChecks(list, opts);   // APK lama tanpa pancingan: cek biasa
  if (checking) { if (!opts.auto) toast('Pengecekan lain masih berjalan.'); return false; }
  if (!list.length) return false;
  checking = true;
  updateAutoHint();
  baitMemory = new Map();
  const tally = {};
  let aborted = '';
  let abortedAt = '';   // 'bait' atau 'check': tahap tempat pembatalan terjadi
  let usable = 0;   // jumlah akun yang pancingannya menghasilkan limit / free
  const baitStartedAt = Date.now();
  let checkStartedAt = 0;
  let checkDone = 0;
  let checkKnown = 0;
  const checkTally = {};
  const failWhy = {};   // alasan pancingan gagal -> jumlah akun
  const fails = [];     // catatan kegagalan per akun untuk detail riwayat
  try {
    // Tahap 1: pancingan semua akun
    for (let i = 0; i < list.length && !aborted; i++) {
      const a = list[i];
      if (!accounts.includes(a)) continue;
      checkingId = a.id;
      setCheckBtn(`Pancing ${i + 1}/${list.length}...`);
      refreshChecking();
      let res;
      try { res = await G.bait({ accountId: a.id, url: CLAUDE_URL, mode: 'send', timeoutMs: BAIT_TIMEOUT }); }
      catch (e) { res = { state: 'fail' }; }
      if (res.error) { aborted = res.error; abortedAt = 'bait'; break; }
      noteFail(fails, a, 'Pancing', res);
      const why = res.state === 'fail' ? baitWhy(res.text) : '';
      baitMemory.set(a.id, {
        why, state: res.state, text: why ? '' : (res.text || ''),
        chatUrl: /^https:\/\/claude\.ai\/chat\//.test(res.url || '') ? res.url : '',
        at: Date.now(), verified: false, deleted: false, mismatch: false,
      });
    }

    // Tahap 2 dan 3: per akun, bandingkan lalu hapus chat pancingan, lalu cek chat utama
    for (let i = 0; i < list.length && !aborted; i++) {
      const a = list[i];
      if (!accounts.includes(a)) continue;
      const mem = baitMemory.get(a.id);
      checkingId = a.id;
      setCheckBtn(`Cek ${i + 1}/${list.length}...`);
      refreshChecking();

      let verdict = mem ? mem.state : '';
      let text = mem ? mem.text : '';
      if (mem && mem.chatUrl) {
        let vr;
        try { vr = await G.bait({ accountId: a.id, url: mem.chatUrl, mode: 'verify', timeoutMs: BAIT_TIMEOUT }); }
        catch (e) { vr = { state: 'fail' }; }
        if (vr.error) { aborted = vr.error; abortedAt = 'bait'; break; }
        if (vr.state === 'fail') noteFail(fails, a, 'Verifikasi', vr);
        if (vr.state === 'limit' || vr.state === 'free') {
          mem.verified = true;
          mem.deleted = !!vr.deleted;
          mem.mismatch = vr.state !== mem.state;
          verdict = vr.state;                    // isi chat pancingan jadi patokan
          text = vr.text || mem.text;
          mem.state = verdict;
        }
      }
      if (mem) {
        if (verdict === 'limit' || verdict === 'free') { usable++; applyBait(a, verdict, text); }
        tally[BAIT_LABEL[verdict] || verdict] = (tally[BAIT_LABEL[verdict] || verdict] || 0) + 1;
        if (verdict === 'fail') { const w = mem.why || 'tidak diketahui'; failWhy[w] = (failWhy[w] || 0) + 1; }
      }

      // Kembali ke chat utama dan cek seperti biasa
      if (!checkStartedAt) checkStartedAt = Date.now();
      let res;
      try { res = await G.check({ accountId: a.id, url: a.chatUrl || CLAUDE_URL, timeoutMs: CHECK_TIMEOUT }); }
      catch (e) { res = { state: 'unknown' }; }
      if (res.error) { aborted = res.error; abortedAt = 'check'; break; }
      applyCheck(a, res);
      noteFail(fails, a, 'Cek', res);
      checkDone++;
      if (res.state && res.state !== 'unknown') checkKnown++;
      const cl = CHECK_LABEL[res.state] || CHECK_LABEL.unknown;
      checkTally[cl] = (checkTally[cl] || 0) + 1;
    }
  } finally {
    checking = false;
    checkingId = null;
    setCheckBtn(null);
    refreshChecking();
    updateAutoHint();
    baitMemory = new Map();   // memori sementara dihapus segera setelah dipakai pengecekan (juga kalau dibatalkan)
  }
  {
    const who = opts.auto ? 'Otomatis' : 'Manual';
    const baitSum = Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ');
    const baitFail = abortedAt === 'bait';
    const whySum = Object.entries(failWhy).map(([k, n]) => `${k} (${n})`).join(', ');
    const baitTail = whySum ? ` — penyebab gagal: ${whySum}` : '';
    addHistory('bait', !baitFail && usable > 0,
      baitFail ? `${who} · ${abortReason(aborted)}${baitSum ? ` (${baitSum})` : ''}`
        : usable > 0 ? `${who} · ${baitSum}${baitTail}`
        : `${who} · tidak ada akun yang terpancing (${baitSum || 'belum login / gagal'})${baitTail}`, baitStartedAt, { fails: fails.filter((f) => f.step !== 'Cek') });
    if (checkDone > 0 || abortedAt === 'check') {
      const chkSum = Object.entries(checkTally).map(([k, n]) => `${n} ${k}`).join(', ');
      const chkFail = abortedAt === 'check';
      addHistory('check', !chkFail && checkKnown > 0,
        chkFail ? `${who} · ${abortReason(aborted)}${chkSum ? ` (${chkSum})` : ''}` : `${who} · ${chkSum}`,
        checkStartedAt || Date.now(), { fails: fails.filter((f) => f.step === 'Cek') });
    }
  }
  if (aborted) {
    if (!opts.auto) toast(aborted === 'browser' ? 'Tutup browser aplikasi dulu, lalu cek lagi.' : 'Pengecekan lain masih berjalan.');
    return false;
  }
  // Sesi pancingan selesai (walau hasilnya gagal): hitungan 3 jam untuk pancingan otomatis berikutnya dimulai
  settings.lastBait = Date.now();
  saveSettings();
  if (!opts.auto || !document.hidden) {
    toast('Pancingan + cek selesai. ' + Object.entries(tally).map(([k, n]) => `${n} ${k}`).join(', ') + '.', 6500);
  }
  return true;
}

// Tombol Continue manual (untuk project sisa atau saat auto-continue belum jalan)
// Kirim Continue / command ke chat akun di sesi tersembunyi (browser tidak dibuka).
// Hasil: {ok:true} | {ok:false, limit:true} | {ok:false, why}
async function sendContinueBackground(a, text) {
  const G = P.GeckoBrowser;
  if (!native || !G || !G.bait) return { ok: false, why: 'APK lama belum mendukung' };
  let res;
  try {
    res = await G.bait({ accountId: a.id, url: a.chatUrl || CLAUDE_URL, mode: 'continue', command: text, timeoutMs: CONTINUE_TIMEOUT });
  } catch (e) { return { ok: false, why: 'error' }; }
  if (res.error) return { ok: false, why: 'ada pengecekan lain yang berjalan' };
  if (res.state === 'sent') return { ok: true };
  if (res.state === 'limit') { onLimitSeen(a.id, res.text, res.url, Date.now()); return { ok: false, limit: true }; }
  if (res.state === 'loggedout') return { ok: false, why: 'akun belum login' };
  return { ok: false, why: baitWhy(res.text) || 'tidak terkirim' };
}

// Setelah Continue terkirim, Claude bekerja: tandai busy dan pantau sampai selesai (notifikasi)
function markWorking(a) {
  a.check = { state: 'busy', at: Date.now() };
  watching.set(a.id, Date.now());
  watchNext = Date.now() + WATCH_EVERY;
}

async function doContinue(a) {
  if (checking || resumeBusy) { toast('Tunggu proses lain selesai dulu.'); return; }
  const v = view(a);
  if (!v.can) {
    toast(v.waiting ? `Limit belum reset. Tunggu ${countdownShort(v.ms)}.` : 'Tidak ada project yang terhenti.');
    return;
  }
  const p = a.projects[0];
  const text = p ? buildCommand(a, p) : OLD_CMD;
  // Terkirim langsung di belakang layar. Browser baru dibuka kalau pengiriman otomatis gagal.
  resumeBusy = true;
  checkingId = a.id;   // tepi kartu menyala selama Continue dikirim di belakang layar
  refreshChecking();
  toast(`Mengirim Continue ke "${shortName(a.name)}"...`, 3000);
  let r;
  try { r = await sendContinueBackground(a, text); } finally { resumeBusy = false; checkingId = null; refreshChecking(); }
  if (r.limit) {
    toast(`Akun "${shortName(a.name)}" masih limit. Status diperbarui, Continue tidak dikirim.`, 6000);
    return;
  }
  if (!r.ok) {
    toast(`Kirim otomatis gagal (${r.why}). Membuka browser...`, 5000);
    await openAccount(a, text, a.chatUrl, true);
  }
  a.projects.shift();
  if (a.status === 'working') freeUp(a);
  if (r.ok) markWorking(a);
  else a.check = { state: 'idle', at: Date.now() };   // matikan warna hijau sampai halaman melapor lagi
  commit();
  const rest = a.projects.length ? ` Sisa ${a.projects.length} project, tekan Continue lagi.` : '';
  toast(r.ok
    ? `Continue terkirim ke chat "${shortName(a.name)}". Notifikasi muncul saat Claude selesai.${rest}`
    : `Continue dikirim lewat browser ke chat "${shortName(a.name)}". Kalau tidak terkirim, command sudah disalin: tempel di chat.${rest}`, 6000);
}

// ---------- Kartu akun ----------
function buildCard(a, index) {
  const r = {};

  // Baris 1: status | akun | waktu reset | status proyek
  r.sw = el('input', {
    type: 'checkbox', 'aria-label': 'Free atau Limit',
    onchange: (e) => setStatus(a, e.target.checked ? 'working' : 'free'),
  });
  r.stlabel = el('span', { class: 'stlabel' });
  r.acctT = el('span', { class: 'acctT' });
  r.memo = el('button', {
    type: 'button', class: 'memo', 'aria-label': 'Buka NOTE akun',
    onclick: (e) => { e.stopPropagation(); openMemo(a); },
  });
  r.acct = el('div', {
    class: 'col acct', role: 'button', tabindex: '0',
    onclick: () => toggleOpen(a.id),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleOpen(a.id); } },
  }, r.acctT, r.memo);
  r.rstK = el('span', { class: 'k' });
  r.rstV = el('span', { class: 'v' });
  r.prjK = el('span', { class: 'k', text: 'Proyek' });
  r.prjV = el('span', { class: 'v' });

  const r1 = el('div', { class: 'r1' },
    el('label', { class: 'col stat' }, el('span', { class: 'sw' }, r.sw, el('i')), r.stlabel),
    r.acct,
    el('div', { class: 'col rst', role: 'button', tabindex: '0', title: 'Ketuk untuk atur waktu reset manual', onclick: () => openResetEditor(a) }, r.rstK, r.rstV),
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
      el('label', { class: 'chk' }, r.notesChk, el('span', { text: 'Tampilkan NOTE di akun ini (ketuk tulisan NOTE untuk menulis dan memilih warna)' })),
    ),
    el('div', { class: 'field only-working' },
      el('label', { text: 'Limit reset pada (otomatis dari chat, bisa diatur manual)' }),
      r.when,
      el('div', { class: 'chips' },
        el('span', { class: 'hint2', text: 'Atur manual:' }),
        el('select', {
          class: 'tsel quick', 'aria-label': 'Atur reset cepat',
          onchange: (e) => { const h = parseInt(e.target.value, 10); e.target.value = ''; if (h) setResetIn(a, h); },
        }, el('option', { value: '', text: '+ jam dari sekarang' }), ...[1, 2, 3, 5].map((h) => el('option', { value: String(h), text: `+${h} jam` }))),
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

  if (!v.working) {
    const tc = tokenCell(a);
    r.rstK.textContent = tc.k;
    r.rstV.textContent = tc.v;
    r.rstV.className = `v ${tc.cls}`;
    r.rstV.title = tc.title;
  }
  r.cd.textContent = v.ms === null ? '' : countdownText(v.ms);
  r.cd.classList.toggle('done', v.over);
}

// Semua bagian kartu (dipanggil saat data berubah)
function refresh(root, a) {
  const r = root._r;
  const working = a.status === 'working';
  root.classList.toggle('open', openIds.has(a.id));
  root.classList.toggle('notes-on', !!a.notesOn);
  r.memo.hidden = !a.notesOn;
  const mt = ((a.memo && a.memo.text) || '').split('\n').find((x) => x.trim()) || '';
  r.memo.textContent = mt.trim() || 'NOTE';
  r.memo.classList.toggle('empty', !mt.trim());
  r.memo.style.setProperty('--mc', (a.memo && a.memo.color) || NOTE_COLORS[0]);
  r.sw.checked = working;
  r.stlabel.textContent = working ? 'Limit' : 'Free';
  r.acctT.textContent = shortName(a.name);
  r.acct.title = a.name;
  if (working) r.rstK.textContent = 'Reset';
  if (working) {
    r.rstV.textContent = timeShort(a) + (a.resetSrc === 'manual' ? ' ✎' : '');
    r.rstV.className = 'v';
  }
  setVal(r.name, a.name);
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
  const seg = (n, label, cls) => el('span', { class: `sg ${cls || ''}` }, el('b', { text: String(n) }), el('span', { text: label }));
  document.getElementById('summary').replaceChildren(el('div', { class: 'sumbar' },
    seg(accounts.length, 'akun'), el('i'),
    seg(free, 'Free', 'free'), el('i'),
    seg(accounts.length - free, 'Limit', 'work'),
  ));
}

function tick() {
  for (const a of accounts) {
    const root = cards.get(a.id);
    if (root) live(root, a);
  }
  checkDue();
  runScheduledTriggers();
  maybeAutoCheck();
  watchBusy();
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
    notes: [], memo: { text: '', color: NOTE_COLORS[0] }, notesOn: false, chatUrl: null,
  });
  input.value = '';
  commit();
});

(async function init() {
  await Auth.ready;   // tunggu login berhasil
  STORE_KEY = Auth.key('accounts');
  SETTINGS_KEY = Auth.key('settings');
  HISTORY_KEY = Auth.key('history');
  accounts = await loadAccounts();
  await loadSettings();
  // Jadwal cek otomatis yang terlewat saat aplikasi tertutup tidak dikejar: tidak ada pengecekan saat aplikasi dibuka
  if (settings.autoMin && Date.now() >= settings.lastAuto + settings.autoMin * 60000) { settings.lastAuto = Date.now(); saveSettings(); }
  // Akun yang terakhir terlihat bekerja: tetap dipantau, supaya "selesai" terdeteksi walau aplikasi sempat tertutup
  for (const a of accounts) {
    if (a.check && a.check.state === 'busy' && Date.now() - a.check.at < WATCH_MAX) watching.set(a.id, a.check.at);
  }
  watchNext = Date.now() + WATCH_EVERY;   // jangan langsung mengecek saat aplikasi baru dibuka
  await loadHistory();
  await initNotifications();
  initLimitWatcher();
  initTools();
  initHistory();
  render();
  await drainBg();
  bgReady = true;
  syncBg();
  if (Auth.notice) toast(Auth.notice, 9000);
  scheduleAll();
  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); drainLimitEvents(); checkDue(); drainBg(); } });
})();
