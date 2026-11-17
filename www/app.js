const DEFAULT_CMD = 'Lanjutkan task sebelumnya dari bagian terakhir yang belum selesai.';
const CLAUDE_URL = 'https://claude.ai/new';
const STORE_KEY = 'accounts';

const Cap = window.Capacitor || {};
const P = Cap.Plugins || {};
const native = !!(Cap.isNativePlatform && Cap.isNativePlatform());

let accounts = [];

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
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
async function saveAccounts() {
  const raw = JSON.stringify(accounts);
  try {
    if (native && P.Preferences) await P.Preferences.set({ key: STORE_KEY, value: raw });
    else localStorage.setItem(STORE_KEY, raw);
  } catch {}
}

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
        body: 'Jatah token sudah kembali. Ketuk untuk lanjutkan task.',
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
  if (ms <= 0) return 'Sudah reset, siap lanjut';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}j ${pad(Math.floor((s % 3600) / 60))}m ${pad(s % 60)}d lagi`;
}

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

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 4500);
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

async function doContinue(a) {
  await copyText(a.command || DEFAULT_CMD);
  await openClaude();
  toast(`Command disalin. Buka akun "${a.name}" lalu tempel (tahan kolom chat → Tempel).`);
}
// ---------- Kartu akun ----------
function card(a) {
  const working = a.status === 'working';
  const ready = working && a.resetAt && Date.parse(a.resetAt) <= Date.now();

  const top = el('div', { class: 'top' },
    el('input', {
      class: 'name', value: a.name,
      onchange: (e) => { a.name = e.target.value.trim() || a.name; commit(); },
    }),
    el('button', {
      class: 'icon', title: 'Hapus akun', text: '✕',
      onclick: () => {
        if (confirm(`Hapus akun "${a.name}"?`)) {
          accounts = accounts.filter((x) => x.id !== a.id);
          commit();
        }
      },
    }),
  );

  const badgeText = working
    ? 'Working'
    : (a.percent < 100 ? `Free · sisa token ${a.percent}%` : 'Free · token 100%');

  const statusRow = el('div', { class: 'statusrow' },
    el('span', { class: `badge ${working ? 'working' : 'free'}`, text: badgeText }),
    el('label', { class: 'switch' },
      el('input', { type: 'checkbox', checked: working, onchange: (e) => setStatus(a, e.target.checked ? 'working' : 'free') }),
      el('span', { class: 'slider' }),
    ),
  );

  let body;
  if (working) {
    body = el('div', { class: 'field' },
      el('label', { text: 'Token reset pada (jam & tanggal)' }),
      el('input', {
        type: 'datetime-local',
        value: a.resetAt ? toLocalInput(a.resetAt) : '',
        onchange: (e) => {
          if (!e.target.value) return;
          a.resetAt = new Date(e.target.value).toISOString();
          a.notified = false;
          commit();
        },
      }),
      el('div', { class: 'row' },
        el('span', { class: 'resettext', text: 'Cepat atur:' }),
        ...[1, 2, 3, 5].map((h) => el('button', { type: 'button', class: 'chip', text: `+${h} jam`, onclick: () => setResetIn(a, h) })),
      ),
      el('div', { class: `countdown${ready ? ' ready' : ''}`, 'data-reset': a.resetAt || '' }),
      el('div', { class: 'resettext', text: a.resetAt ? `Reset: ${fmt.format(new Date(a.resetAt))}` : '' }),
    );
  } else {
    body = el('div', { class: 'field' },
      el('label', { text: 'Sisa token (%), isi jika di bawah 100' }),
      el('input', {
        type: 'number', min: '0', max: '100', inputmode: 'numeric', value: String(a.percent),
        onchange: (e) => {
          const n = Math.max(0, Math.min(100, parseInt(e.target.value, 10)));
          a.percent = Number.isNaN(n) ? 100 : n;
          commit();
        },
      }),
    );
  }

  const cmdField = el('div', { class: 'field' },
    el('label', { text: 'Command yang disalin saat Continue' }),
    el('textarea', {
      rows: '2', value: a.command || DEFAULT_CMD,
      onchange: (e) => { a.command = e.target.value; commit(); },
    }),
  );

  const btn = el('button', { class: 'continue', text: '▶ Continue', onclick: () => doContinue(a) });

  return el('section', { class: `card ${working ? 'working' : ''}${ready ? ' ready' : ''}` },
    top, statusRow, body, cmdField, btn);
}

function render() {
  document.getElementById('list').replaceChildren(...accounts.map(card));
  document.getElementById('empty').hidden = accounts.length > 0;
  const free = accounts.filter((a) => a.status === 'free').length;
  document.getElementById('summary').textContent =
    `${accounts.length} akun · ${free} Free · ${accounts.length - free} Working`;
  tick();
}

function tick() {
  document.querySelectorAll('[data-reset]').forEach((node) => {
    const iso = node.getAttribute('data-reset');
    if (!iso) { node.textContent = ''; return; }
    const ms = Date.parse(iso) - Date.now();
    node.textContent = countdownText(ms);
    node.classList.toggle('ready', ms <= 0);
  });
}

document.getElementById('addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('newName');
  const name = input.value.trim();
  if (!name) return;
  accounts.push({
    id: uid(), name, status: 'free', percent: 100,
    resetAt: null, notified: false, command: DEFAULT_CMD,
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
