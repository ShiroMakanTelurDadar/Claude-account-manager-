// Halaman chat: kolom chat di kiri, panel di kanan (Cek akun, Pancing akun, Input file, Output file, List akun).
// Dibuka dari tombol "💬 Chat" di halaman utama (list akun). Tombol panah bulat di pojok kolom chat = kembali ke halaman utama.
//
// Pesan dikirim lewat sesi tersembunyi (GeckoBrowser.bait mode "work", sama seperti estafet) memakai akun yang dipilih di List akun.
//   Pesan pertama membuka chat baru di claude.ai, pesan berikutnya memakai alamat chat yang sama (percakapan nyambung).
//   Input file : file teks dari perangkat, ikut terkirim sebagai blok "FILE: nama" di pesan berikutnya.
//   Output file: blok "FILE: path" + kode di balasan Claude disimpan otomatis, bisa disalin ke folder Download.
// Penyimpanan file: <app files>/Projects/_chat/{In,Out} (awalan "_" = tidak muncul di daftar proyek estafet).
(function () {
  'use strict';
  const RC = window.RelayCore;
  const g = () => (typeof P !== 'undefined' && P.GeckoBrowser) || null;
  const hasNative = () => { const G = g(); return !!(typeof native !== 'undefined' && native && G && G.bait && G.projWrite); };

  const ROOT = '_chat';
  const WORK_TIMEOUT = 10 * 60 * 1000;   // ms: batas satu balasan
  const MAX_FILE = 300 * 1024;           // byte: batas ukuran satu file input
  const MAX_MSGS = 60;                   // pesan yang disimpan per akun
  const FILE_HINT = 'Kalau kamu menulis file, tulis tiap file LENGKAP: satu baris `FILE: path/relatif.ext` lalu satu blok kode berisi seluruh isi file. Jangan pakai sandbox atau artifact.';

  // ---------- Penyimpanan file (native; cadangan localStorage supaya tampilan bisa dicoba di browser biasa) ----------
  const lsKey = (p) => 'camchat:' + p;
  const fs = {
    async write(path, content) {
      if (hasNative()) { await g().projWrite({ path, content, append: false }); return; }
      try { localStorage.setItem(lsKey(path), content); } catch (_) {}
    },
    async read(path) {
      if (hasNative()) { const r = await g().projRead({ path }); return r && r.exists ? r.content : null; }
      try { return localStorage.getItem(lsKey(path)); } catch (_) { return null; }
    },
    async list(dir) {
      if (hasNative()) { const r = await g().projList({ path: dir }); return ((r && r.items) || []).map((x) => (typeof x === 'string' ? { path: x } : x)); }
      const pre = lsKey(dir + '/');
      const out = [];
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(pre)) out.push({ path: k.slice(pre.length) }); } } catch (_) {}
      return out;
    },
    async del(path) {
      if (hasNative()) { await g().projDelete({ path }); return; }
      try { localStorage.removeItem(lsKey(path)); } catch (_) {}
    },
    async exp(path, name) {
      if (hasNative() && g().projExport) { return g().projExport({ path, name }); }
      const c = await fs.read(path);
      if (c == null) throw new Error('file tidak ada');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([c], { type: 'text/plain' }));
      a.download = name;
      a.click();
      return { where: 'Download/' + name };
    },
  };

  // ---------- Riwayat percakapan per akun ----------
  const convs = new Map();   // id akun -> { url, msgs: [{role:'user'|'ai'|'sys', text}] }
  const convKey = (id) => (window.Auth && Auth.key ? Auth.key('chat_' + id) : 'chat_' + id);
  function conv(id) {
    if (convs.has(id)) return convs.get(id);
    let c = null;
    try { c = JSON.parse(localStorage.getItem(convKey(id)) || 'null'); } catch (_) {}
    if (!c || !Array.isArray(c.msgs)) c = { url: '', msgs: [] };
    convs.set(id, c);
    return c;
  }
  function saveConv(id) {
    const c = conv(id);
    if (c.msgs.length > MAX_MSGS) c.msgs = c.msgs.slice(-MAX_MSGS);
    try { localStorage.setItem(convKey(id), JSON.stringify(c)); } catch (_) {}
  }

  // ---------- Keadaan tampilan ----------
  let page = null;
  let selId = null;
  let sending = null;        // id akun yang sedang menunggu balasan
  let msgsEl = null, inputEl = null, sendBtn = null, whoEl = null;
  let inEl = null, outEl = null, accEl = null, fileIn = null;
  let timer = null;
  let inFiles = [];          // [{path, on}]
  let outFiles = [];         // [{path}]
  const off = new Set();     // file input yang tidak dicentang (tidak ikut terkirim)

  const sel = () => (typeof accounts !== 'undefined' ? accounts : []).find((a) => a.id === selId) || null;
  const isLimit = (a) => a.status === 'working';
  const name = (a) => (typeof shortName === 'function' ? shortName(a.name) : a.name);

  // ---------- Isi pesan: teks + blok kode (tanpa innerHTML) ----------
  function fillBody(box, text) {
    box.replaceChildren();
    const parts = String(text || '').split(/```/);
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const nl = p.indexOf('\n');
        const code = nl >= 0 && /^[\w+#.-]*$/.test(p.slice(0, nl).trim()) ? p.slice(nl + 1) : p;
        box.append(el('pre', { class: 'cmcode', text: code.replace(/\n$/, '') }));
      } else if (p.trim()) {
        box.append(el('div', { class: 'cmtext', text: p.replace(/^\n+|\n+$/g, '') }));
      }
    });
    if (!box.childNodes.length) box.append(el('div', { class: 'cmtext', text: '' }));
  }

  function renderMsgs() {
    if (!msgsEl) return;
    const a = sel();
    const stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
    if (!a) { msgsEl.replaceChildren(el('div', { class: 'cmempty', text: 'Pilih akun di List akun.' })); return; }
    const c = conv(a.id);
    const kids = c.msgs.map((m) => {
      const b = el('div', { class: `cpmsg ${m.role}` });
      fillBody(b, m.text);
      return b;
    });
    if (sending === a.id) kids.push(el('div', { class: 'cpmsg ai wait', text: 'Claude sedang menjawab...' }));
    if (!kids.length) kids.push(el('div', { class: 'cmempty', text: `Chat dengan ${name(a)}.\nKetik pesan di bawah.` }));
    msgsEl.replaceChildren(...kids);
    if (stick || sending) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- Panel kanan ----------
  async function refreshFiles() {
    try {
      inFiles = (await fs.list(ROOT + '/In')).map((f) => ({ path: f.path, on: !off.has(f.path) }));
      outFiles = await fs.list(ROOT + '/Out');
    } catch (_) { inFiles = []; outFiles = []; }
    renderFiles();
  }

  function fileRow(f, kind) {
    const nm = el('span', { class: 'cfname', text: f.path, title: f.path });
    const kids = [];
    if (kind === 'in') {
      kids.push(el('input', { type: 'checkbox', checked: f.on ? 'checked' : null, 'aria-label': 'Ikut terkirim', onchange: (e) => { if (e.target.checked) off.delete(f.path); else off.add(f.path); } }));
    }
    kids.push(nm);
    if (kind === 'out') kids.push(el('button', { type: 'button', class: 'cfbtn', text: '⬇', 'aria-label': 'Salin ke Download', onclick: () => exportOut(f.path) }));
    kids.push(el('button', { type: 'button', class: 'cfbtn', text: '✕', 'aria-label': 'Hapus', onclick: () => delFile(kind, f.path) }));
    return el('div', { class: 'cfile' }, ...kids);
  }

  function renderFiles() {
    if (inEl) inEl.replaceChildren(...(inFiles.length ? inFiles.map((f) => fileRow(f, 'in')) : [el('div', { class: 'cfnone', text: 'Kosong' })]));
    if (outEl) outEl.replaceChildren(...(outFiles.length ? outFiles.map((f) => fileRow(f, 'out')) : [el('div', { class: 'cfnone', text: 'Kosong' })]));
  }

  async function addInput(files) {
    let n = 0;
    for (const f of files) {
      if (f.size > MAX_FILE) { toast(`"${f.name}" terlalu besar (maks ${Math.round(MAX_FILE / 1024)} KB).`); continue; }
      let t = '';
      try { t = await f.text(); } catch (_) { t = ''; }
      if (!t || t.indexOf('\u0000') >= 0) { toast(`"${f.name}" bukan file teks.`); continue; }
      const safe = (RC && RC.safePath ? RC.safePath(f.name) : f.name) || f.name.replace(/[^\w.-]/g, '_');
      await fs.write(`${ROOT}/In/${safe}`, t);
      off.delete(safe);
      n++;
    }
    if (n) toast(`${n} file input ditambahkan. Ikut terkirim di pesan berikutnya.`);
    await refreshFiles();
  }

  async function delFile(kind, path) {
    try { await fs.del(`${ROOT}/${kind === 'in' ? 'In' : 'Out'}/${path}`); } catch (_) {}
    off.delete(path);
    await refreshFiles();
  }

  async function exportOut(path) {
    try {
      const r = await fs.exp(`${ROOT}/Out/${path}`, `chat__${path.replace(/\//g, '__')}`);
      toast(r && r.where ? 'Disalin ke ' + r.where : 'File disalin ke folder Download.', 5000);
    } catch (e) { toast('Gagal menyalin file: ' + ((e && e.message) || e)); }
  }

  function renderAccounts() {
    if (!accEl) return;
    const list = typeof accounts !== 'undefined' ? accounts : [];
    if (!list.length) { accEl.replaceChildren(el('div', { class: 'cfnone', text: 'Belum ada akun' })); return; }
    accEl.replaceChildren(...list.map((a) => {
      const lim = isLimit(a);
      let sub = lim ? 'Limit' : 'Free';
      if (lim && a.resetAt) sub += ' · ' + atShort(a.resetAt);
      if (sending === a.id) sub = 'Menjawab...';
      return el('button', { type: 'button', class: `cacc ${a.id === selId ? 'on' : ''} ${lim ? 'lim' : 'free'}`, onclick: () => pick(a.id) },
        el('i', { class: 'cdot' }),
        el('span', { class: 'cainfo' }, el('b', { text: name(a) }), el('small', { text: sub })));
    }));
  }

  function renderWho() {
    if (!whoEl) return;
    const a = sel();
    whoEl.textContent = a ? name(a) : 'Belum ada akun';
  }

  function pick(id) {
    selId = id;
    renderAccounts(); renderWho(); renderMsgs();
    updateSend();
  }

  function updateSend() {
    if (sendBtn) sendBtn.disabled = !!sending;
  }

  // ---------- Kirim ----------
  function bestReply(res) {
    const p = String(res.partial || '');
    if (res.state === 'limit') return p;
    const t = /^why:/.test(String(res.text || '')) ? '' : String(res.text || '');
    return t.length >= p.length ? t : p;
  }

  async function send() {
    const a = sel();
    if (!a) { toast('Pilih akun dulu di List akun.'); return; }
    if (sending) return;
    const text = inputEl.value.trim();
    if (!text) return;
    if (!hasNative()) { toast('Kirim chat hanya jalan di APK terbaru.'); return; }
    if (typeof checking !== 'undefined' && checking) { toast('Tunggu pengecekan akun selesai dulu.'); return; }
    if (isLimit(a) && a.resetAt && Date.parse(a.resetAt) > Date.now()) {
      if (!confirm(`Akun ${name(a)} masih Limit sampai ${atShort(a.resetAt)}. Tetap coba kirim?`)) return;
    }

    // Rakit pesan: file input yang dicentang + teks
    const attach = [];
    let attachChars = 0;
    for (const f of inFiles.filter((x) => x.on)) {
      const c = await fs.read(`${ROOT}/In/${f.path}`);
      if (c == null) continue;
      attachChars += c.length;
      attach.push(`FILE: ${f.path}\n\`\`\`\n${c}\n\`\`\``);
    }
    const prompt = (attach.length ? `Berikut file yang saya lampirkan:\n\n${attach.join('\n\n')}\n\n` : '') + text + '\n\n---\n' + FILE_HINT;

    const c = conv(a.id);
    c.msgs.push({ role: 'user', text: text + (attach.length ? `\n\n📎 ${attach.length} file input terlampir` : '') });
    saveConv(a.id);
    inputEl.value = '';
    autosize();
    sending = a.id;
    checking = true;   // cegah cek otomatis memakai sesi tersembunyi selama chat berjalan
    const G = g();
    try { if (G.keepAlive) G.keepAlive({ on: true }).catch(() => {}); } catch (_) {}
    renderMsgs(); renderAccounts(); updateSend();
    void attachChars;

    let res;
    try {
      res = await G.bait({ accountId: a.id, url: c.url || CLAUDE_URL, mode: 'work', command: prompt, timeoutMs: WORK_TIMEOUT });
    } catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
    sending = null;
    checking = false;
    try {
      const want = !!(typeof settings !== 'undefined' && settings.firstDone && (settings.autoMin || settings.quietOn));
      if (!want && G.keepAlive) G.keepAlive({ on: false }).catch(() => {});
    } catch (_) {}

    await handleResult(a, c, text, res);
    saveConv(a.id);
    renderMsgs(); renderAccounts(); updateSend();
    refreshFiles();
  }

  async function handleResult(a, c, text, res) {
    const state = res.state || 'fail';
    const reply = bestReply(res);
    if (res.error === 'busy') { c.msgs.pop(); inputEl.value = text; autosize(); toast('Sesi tersembunyi sedang dipakai proses lain. Coba lagi sebentar.'); return; }
    if (res.error === 'cancel') { c.msgs.push({ role: 'sys', text: 'Dibatalkan.' }); return; }
    if (/^https:\/\/claude\.ai\/chat\//.test(res.url || '')) c.url = res.url;

    if (state === 'loggedout') {
      if (typeof noteCheck === 'function') noteCheck(a, 'loggedout', Date.now());
      c.msgs.push({ role: 'sys', text: `Akun ${name(a)} belum login. Buka lewat Connect di halaman utama, login, lalu kirim lagi.` });
      return;
    }
    if (state === 'limit') {
      try { if (window.Relay && Relay.markLimit) Relay.markLimit(a, res.text, res.url); else if (typeof onLimitSeen === 'function') onLimitSeen(a.id, res.text, res.url, Date.now()); } catch (_) {}
      if (reply) c.msgs.push({ role: 'ai', text: reply });
      c.msgs.push({ role: 'sys', text: `Akun ${name(a)} kena limit${a.resetAt ? ' (reset ' + atShort(a.resetAt) + ')' : ''}. Pilih akun lain di List akun lalu kirim lagi.` });
      await saveFiles(reply);
      return;
    }
    if (!reply) {
      const why = typeof baitWhy === 'function' ? baitWhy(res.text) : '';
      c.msgs.push({ role: 'sys', text: 'Tidak ada balasan' + (why ? ': ' + why : '.') + ' Coba kirim lagi.' });
      return;
    }
    c.msgs.push({ role: 'ai', text: reply });
    if (state !== 'done' && state !== 'paused') c.msgs.push({ role: 'sys', text: 'Balasan mungkin terpotong.' });
    await saveFiles(reply);
  }

  // Simpan file dari balasan ke Out
  async function saveFiles(reply) {
    if (!RC || !reply) return;
    let n = 0;
    for (const f of RC.extractFiles(reply)) {
      try { await fs.write(`${ROOT}/Out/${f.path}`, f.content); n++; } catch (_) {}
    }
    if (n) toast(`${n} file hasil disimpan di Output file.`, 5000);
  }

  function newChat() {
    const a = sel();
    if (!a) return;
    if (sending) { toast('Tunggu balasan selesai dulu.'); return; }
    const c = conv(a.id);
    if (!c.msgs.length && !c.url) return;
    if (!confirm(`Mulai chat baru untuk ${name(a)}? Riwayat di sini dihapus (chat di claude.ai tidak).`)) return;
    c.url = ''; c.msgs = [];
    saveConv(a.id);
    renderMsgs();
  }

  function autosize() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ---------- Buka / tutup ----------
  function prepare() {
    if (!page) build();
    const list = typeof accounts !== 'undefined' ? accounts : [];
    if (!sel()) selId = (list.find((a) => !isLimit(a)) || list[0] || {}).id || null;
    pick(selId);
    refreshFiles();
  }

  function open() {
    prepare();
    page.style.transform = '';
    page.classList.remove('drag');
    page.classList.add('show');
    document.body.classList.add('chat-open');
    if (!(history.state && history.state.cam === 'chat')) { try { history.pushState({ cam: 'chat' }, ''); } catch (_) {} }
    clearInterval(timer);
    timer = setInterval(() => { renderAccounts(); }, 2000);
  }

  function close(fromPop) {
    if (!page || !page.classList.contains('show')) return;
    page.style.transform = '';
    page.classList.remove('drag', 'show');
    document.body.classList.remove('chat-open');
    clearInterval(timer);
    if (!fromPop) { try { if (history.state && history.state.cam === 'chat') history.back(); } catch (_) {} }
  }

  window.addEventListener('popstate', () => close(true));

  // ---------- Geser ----------
  // Halaman utama: geser ke kiri = buka halaman chat (halaman ikut mengikuti jari). Halaman chat: geser ke kanan dari tepi kiri
  // atau dari baris atas kolom chat = kembali. Geser hanya dianggap kalau gerakannya jelas mendatar.
  const EDGE = 36;       // px: lebar zona tepi kiri untuk geser kembali
  const START = 12;      // px: gerak minimal sebelum arah dikunci
  let sw = null;         // {x, y, mode:'open'|'close', locked, w}

  function swipeBlocked(t) {
    if (!t || !t.closest) return false;
    if (t.closest('input, textarea, select, .cmcode, .cpcode, .cropview')) return true;
    if (document.getElementById('auth')) return true;                         // layar login
    if (document.querySelector('.rmodal, .rdrawer.open, .hdrawer.open, .rbackdrop.show, .cbackdrop.show')) return true;   // jendela / slide lain terbuka
    return false;
  }

  document.addEventListener('touchstart', (e) => {
    sw = null;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const opened = !!(page && page.classList.contains('show'));
    if (swipeBlocked(e.target)) return;
    if (!opened) sw = { x: t.clientX, y: t.clientY, mode: 'open', locked: false, w: window.innerWidth };
    else if (t.clientX <= EDGE || (e.target.closest && e.target.closest('.cphead'))) sw = { x: t.clientX, y: t.clientY, mode: 'close', locked: false, w: window.innerWidth };
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!sw) return;
    const t = e.touches[0];
    const dx = t.clientX - sw.x, dy = t.clientY - sw.y;
    if (!sw.locked) {
      if (Math.abs(dy) > START && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }   // gerak tegak = gulir biasa
      if (Math.abs(dx) < START || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if ((sw.mode === 'open' && dx > 0) || (sw.mode === 'close' && dx < 0)) { sw = null; return; }
      sw.locked = true;
      if (sw.mode === 'open') prepare();
      page.classList.add('drag');
    }
    const w = sw.w;
    const x = sw.mode === 'open' ? Math.max(0, w + dx) : Math.min(w, Math.max(0, dx));
    page.style.transform = `translateX(${x}px)`;
    sw.dx = dx;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  function endSwipe() {
    if (!sw || !sw.locked) { sw = null; return; }
    const s = sw; sw = null;
    const far = Math.abs(s.dx || 0) > s.w * 0.25;
    page.classList.remove('drag');
    page.style.transform = '';
    if (s.mode === 'open') { if (far) open(); }
    else if (far) close(false); else page.classList.add('show');
  }
  document.addEventListener('touchend', endSwipe, { passive: true });
  document.addEventListener('touchcancel', endSwipe, { passive: true });

  function build() {
    const holdBtn = (cls, text, hint, run) => {
      const b = el('button', { type: 'button', class: `tbtn ${cls} hold chbtn`, text, title: hint, 'aria-label': hint });
      holdPress(b, 1000, run, () => toast(hint));
      return b;
    };
    const checkB = el('button', { type: 'button', class: 'tbtn primary chbtn', text: '⟳ Cek akun', 'aria-label': 'Cek semua akun', onclick: () => { if (typeof checking !== 'undefined' && checking) toast('Sedang mengecek akun, tunggu sebentar.'); else { toast('Mengecek semua akun...'); checkAll(); } } });
    const baitB = holdBtn('', '🎣 Pancing akun', 'Tahan 1 detik: pancing semua akun sekarang, lalu cek', () => { if (typeof checking !== 'undefined' && checking) toast('Sedang mengecek akun, tunggu sebentar.'); else { toast('Memancing semua akun...'); baitNow(); } });

    fileIn = el('input', { type: 'file', multiple: 'multiple', accept: 'text/*,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.kt,.html,.css,.csv,.xml,.yml,.yaml,.txt,.sh,.sql,.c,.cpp,.h,.go,.rs,.php,.rb', hidden: true, onchange: async (e) => { const fl = Array.from(e.target.files || []); e.target.value = ''; if (fl.length) await addInput(fl); } });
    inEl = el('div', { class: 'cflist' });
    outEl = el('div', { class: 'cflist' });
    accEl = el('div', { class: 'cflist caccs' });

    whoEl = el('b', { class: 'cwho', text: '' });
    msgsEl = el('div', { class: 'cpmsgs', 'aria-live': 'polite' });
    inputEl = el('textarea', { class: 'cinput', rows: '1', placeholder: 'kolom chat', 'aria-label': 'Kolom chat', autocomplete: 'off' });
    inputEl.addEventListener('input', autosize);
    sendBtn = el('button', { type: 'button', class: 'btn sm csend', text: '➤', 'aria-label': 'Kirim', onclick: send });

    const back = el('button', { type: 'button', class: 'cback', 'aria-label': 'Kembali ke halaman utama', onclick: () => close(false) },
      (() => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.4'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M19 12H5M11 6l-6 6 6 6');
        s.append(p);
        return s;
      })());

    const chatCol = el('section', { class: 'cchat', 'aria-label': 'Chat' },
      el('div', { class: 'cphead' }, back, whoEl, el('button', { type: 'button', class: 'cnew', text: '＋ Baru', onclick: newChat })),
      msgsEl,
      el('div', { class: 'cbar' }, inputEl, sendBtn));

    const side = el('aside', { class: 'cside', 'aria-label': 'Panel' },
      checkB, baitB,
      el('div', { class: 'cpanel' },
        el('div', { class: 'cptitle' }, el('span', { text: 'Input file' }), el('button', { type: 'button', class: 'cfbtn add', text: '＋', 'aria-label': 'Tambah file input', onclick: () => fileIn.click() })),
        inEl),
      el('div', { class: 'cpanel' }, el('div', { class: 'cptitle' }, el('span', { text: 'Output file' })), outEl),
      el('div', { class: 'cpanel grow' }, el('div', { class: 'cptitle' }, el('span', { text: 'List akun' })), accEl),
      fileIn);

    page = el('div', { class: 'chatpage', role: 'dialog', 'aria-label': 'Halaman chat' }, chatCol, side);
    document.body.append(page);
  }

  window.ChatPage = { open, close };
})();
