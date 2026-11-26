// Estafet: geser ke kiri di halaman utama (list akun) -> DAFTAR PROYEK (+ Proyek baru) -> ketuk satu proyek -> HALAMAN CHAT proyek itu:
// kolom chat di kiri (brief, rencana, tiap langkah, balasan Claude), panel di kanan (Cek akun, Pancing akun, Input file, Output file, List akun, Log).
// Panah bulat di pojok, tombol back Android, atau geser ke kanan dari tepi kiri = mundur satu halaman.
//
// Halaman ini hanya tampilan. Semua kerja estafet (rencana, langkah, ganti akun saat limit) tetap di relay.js, lewat window.Relay.
//   Kolom chat  : dibangun dari In/brief.md, State/log.jsonl, dan balasan mentah State/raw/*.md proyek yang dipilih.
//   Kotak ketik : tulis brief proyek (disimpan di In/brief.md). Hanya bisa sebelum rencana dibuat.
//   Input file  : file teks di In/ proyek (selain brief.md). Ikut ke prompt rencana dan tiap langkah.
//   Output file : file hasil di Out/ proyek. ⬇ menyalin ke folder Download.
//   List akun   : semua akun. Yang bernomor = ada di pool proyek (urutan = prioritas). Ketuk = masuk / keluar pool (saat proyek tidak berjalan).
(function () {
  'use strict';
  const RC = window.RelayCore;
  const R = () => window.Relay || null;
  const rready = () => { const r = R(); return !!(r && r.ready && r.ready()); };

  const MAX_FILE = 300 * 1024;    // byte: batas ukuran satu file input
  const LOG_SHOW = 150;           // jumlah catatan log terakhir yang ditampilkan di kolom chat

  // ---------- Keadaan ----------
  let page = null;           // halaman chat satu proyek
  let listPage = null, listEl = null;   // halaman daftar proyek
  let curName = '';          // nama proyek yang dipilih
  let job = null;            // job.json proyek itu (salinan terbaru)
  let timeline = '';         // penanda isi kolom chat terakhir (supaya tidak digambar ulang tanpa perubahan)
  let timer = null;
  let titleEl = null, actBtn = null, moreBtn = null, barEl = null, stEl = null;
  let msgsEl = null, inputEl = null, sendBtn = null;
  let inEl = null, outEl = null, accEl = null, fileIn = null, logEl = null;
  let logText = '', logMark = '';
  let inFiles = [], outFiles = [];

  const name = (a) => (typeof shortName === 'function' ? shortName(a.name) : a.name);
  const accs = () => (typeof accounts !== 'undefined' ? accounts : []);
  const jp = (rest) => `${curName}/${rest}`;
  const running = () => !!(R() && R().isRunning && R().isRunning(curName));
  const hhmm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

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
  const bubble = (role, text) => { const b = el('div', { class: `cpmsg ${role}` }); fillBody(b, text); return b; };

  // ---------- Kolom chat: alur proyek ----------
  // Satu baris log -> kalimat singkat. null = tidak ditampilkan.
  function logLine(o) {
    const acc = o.account ? ` (${shortName(o.account)})` : '';
    switch (o.ev) {
      case 'created': return 'Proyek dibuat.';
      case 'start': return `Mulai. Akun di pool: ${o.pool}.`;
      case 'send': return `${o.tag === 'plan' ? 'Meminta rencana' : 'Mengirim langkah ' + o.tag} ke ${shortName(o.account || '')}...`;
      case 'plan': return `Rencana siap: ${o.steps} langkah.`;
      case 'plan-bad': return `Rencana belum valid (${o.err || ''}), diulang. Percobaan ${o.try}.`;
      case 'files': return `${o.saved} file disimpan (${o.got}/${o.of}).`;
      case 'step-done': return `Langkah ${o.tag} selesai${acc}.`;
      case 'incomplete': return `Langkah ${o.tag} belum lengkap, kurang: ${(o.missing || []).join(', ')}`;
      case 'wait-limit': return `Semua akun limit. Lanjut otomatis jam ${atShort(o.until)}.`;
      case 'no-account': return 'Tidak ada akun yang bisa dipakai. Cek login akun.';
      case 'chat-del': return `Chat lama dihapus${acc}.`;
      case 'chat-del-fail': return `Gagal menghapus chat lama${acc} (percobaan ${o.try}).`;
      case 'cancelled': return 'Dibatalkan.';
      case 'done': return 'Proyek selesai.';
      case 'failed': return 'Gagal: ' + (o.msg || '');
      case 'error': return 'Error: ' + (o.msg || '');
      case 'result': {
        if (o.state === 'limit') return `Akun ${shortName(o.account || '')} kena limit. Pindah ke akun berikutnya.`;
        if (o.state === 'loggedout') return `Akun ${shortName(o.account || '')} belum login. Dilewati.`;
        if (o.state === 'fail') return `Gagal di ${shortName(o.account || '')}${o.why ? ': ' + o.why : ''}.`;
        return `Balasan dari ${shortName(o.account || '')}: ${o.chars} karakter${o.timedOut ? ' (waktu habis)' : ''}.`;
      }
      default: return null;
    }
  }

  async function buildTimeline() {
    const r = R();
    const fs = r.fs;
    const [brief, logTxt] = await Promise.all([fs.read(jp('In/brief.md')), fs.read(jp('State/log.jsonl'))]);
    const evs = [];
    for (const l of String(logTxt || '').split('\n')) { if (!l) continue; try { evs.push(JSON.parse(l)); } catch (_) {} }
    // Penanda perubahan: panjang log + status + jumlah balasan
    const mark = `${curName}|${evs.length}|${job && job.status}|${job && job.seq}|${running() ? 1 : 0}`;
    if (mark === timeline) return null;
    timeline = mark;

    const kids = [];
    if (brief) kids.push(bubble('user', brief));
    if (job && job.plan) {
      const lines = job.plan.steps.map((s, i) => `${(job.steps[s.id] || {}).status === 'done' ? '✓' : '○'} ${i + 1}. ${s.title}  →  ${s.outputs.join(', ')}`);
      kids.push(bubble('ai plan', 'Rencana:\n' + lines.join('\n')));
    }
    // Balasan mentah: Nth log "result" = seq N. Hanya beberapa terakhir yang masih tersimpan.
    const rawBySeq = new Map();
    for (const p of (job && job.raw) || []) { const m = /-(\d+)\.md$/.exec(p); if (m) rawBySeq.set(+m[1], p); }
    let seq = 0;
    const shown = evs.slice(-LOG_SHOW);
    const skippedResults = evs.length - shown.length ? evs.slice(0, evs.length - shown.length).filter((e) => e.ev === 'result').length : 0;
    seq = skippedResults;
    for (const o of shown) {
      if (o.ev === 'created' || o.ev === 'plan') { if (o.ev === 'plan') { /* ringkasan rencana sudah jadi gelembung sendiri */ } continue; }
      const line = logLine(o);
      if (!line) continue;
      kids.push(el('div', { class: `cpmsg sys ${/Gagal|Error|limit|belum/i.test(line) ? 'warn' : ''}`, text: `${hhmm(o.t)}  ${line}` }));
      if (o.ev === 'result') {
        seq++;
        const raw = rawBySeq.get(seq);
        if (raw && o.state !== 'limit') {
          const t = await fs.read(raw);
          if (t) kids.push(bubble('ai', t.length > 6000 ? t.slice(0, 6000) + '\n\n… (dipotong di tampilan, utuh ada di State/raw)' : t));
        }
      }
    }
    if (running()) kids.push(el('div', { class: 'cpmsg ai wait', text: `Bekerja${job && job.lastAccount ? ' di ' + shortName(job.lastAccount) : ''}... (balasan tampil setelah selesai)` }));
    if (!kids.length) kids.push(el('div', { class: 'cmempty', text: 'Tulis brief proyek di kolom chat bawah, lalu ➤.\nSetelah itu ketuk ▶ untuk mulai.' }));
    return kids;
  }

  async function renderMsgs(force) {
    if (!msgsEl) return;
    if (force) timeline = '';
    if (!rready()) { msgsEl.replaceChildren(el('div', { class: 'cmempty', text: 'Fitur estafet hanya jalan di APK terbaru.' })); return; }
    if (!curName) { timeline = ''; msgsEl.replaceChildren(el('div', { class: 'cmempty', text: 'Pilih proyek dari daftar proyek.' })); return; }
    let kids = null;
    try { kids = await buildTimeline(); } catch (_) { return; }
    if (!kids) return;
    const stick = msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 120;
    msgsEl.replaceChildren(...kids);
    if (stick) msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // ---------- Kepala: judul proyek, tombol aksi, progres ----------
  function syncJob() {
    const jobs = (R() && R().getJobs && R().getJobs()) || [];
    job = jobs.find((j) => j.name === curName) || null;
    return jobs;
  }

  function renderHead() {
    if (!titleEl) return;
    syncJob();
    titleEl.textContent = curName || '';
    const run = running();
    const has = !!job;
    actBtn.disabled = !has || (!run && job.status === 'done');
    actBtn.textContent = run ? '■' : '▶';
    actBtn.setAttribute('aria-label', run ? 'Batalkan proyek' : 'Mulai / lanjutkan proyek');
    actBtn.classList.toggle('stop', run);
    moreBtn.disabled = !has;
    const locked = !!(job && job.plan);
    inputEl.disabled = locked;
    inputEl.placeholder = locked ? 'rencana sudah dibuat' : 'kolom chat (brief proyek)';
    sendBtn.disabled = locked;
    const total = job && job.plan ? job.plan.steps.length : 0;
    const done = job && job.plan ? job.plan.steps.filter((s) => (job.steps[s.id] || {}).status === 'done').length : 0;
    barEl.firstChild.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    stEl.textContent = job ? `${R().statusText(job)}${total ? ` · langkah ${done}/${total}` : ''}` : (rready() ? '' : 'Butuh APK terbaru');
  }

  function onAct() {
    const r = R();
    if (!r || !job) return;
    if (running()) r.cancelRun(); else r.runJob(job.name);
    setTimeout(refreshAll, 400);
  }

  function onMore() {
    const r = R();
    if (!r) return;
    const m = r.modal(
      el('b', { text: curName ? `Proyek: ${curName}` : 'Menu estafet' }),
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn sm rb', text: '+ Proyek baru', onclick: () => { m.remove(); newProject(); } }),
      ),
      ...(curName ? [el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: '📄 Log', onclick: () => { m.remove(); r.showLog(curName); } }),
        el('button', { type: 'button', class: 'btn-g rb', text: '⬇ Semua hasil', onclick: () => { m.remove(); r.exportProject(curName); } }),
        el('button', { type: 'button', class: 'btn-g rb', text: '🗑 Hapus', onclick: async () => { m.remove(); const n = curName; await r.deleteProject(n); const still = (r.getJobs() || []).some((j) => j.name === n); if (!still) closeChat(false); } }),
      )] : []),
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: '🔬 Uji chat', onclick: () => { m.remove(); r.dumpForm(); } }),
        el('button', { type: 'button', class: 'btn-g rb', text: 'Tutup', onclick: () => m.remove() }),
      ),
    );
  }

  // ---------- Kotak ketik: brief proyek ----------
  // Brief disimpan di In/brief.md. Teks berikutnya (sebelum rencana dibuat) ditambahkan di bawahnya.
  async function onSend() {
    const t = inputEl.value.trim();
    if (!t) return;
    if (!rready()) { toast('Butuh APK versi terbaru (fitur estafet belum ada di APK ini).'); return; }
    if (!curName || !job) { toast('Pilih proyek dulu.'); return; }
    if (job.plan) { toast('Rencana sudah dibuat, brief tidak bisa diubah lagi.'); return; }
    if (running()) { toast('Proyek sedang berjalan.'); return; }
    const fs = R().fs;
    const old = ((await fs.read(jp('In/brief.md'))) || '').trim();
    await fs.write(jp('In/brief.md'), old ? old + '\n\n' + t : t);
    inputEl.value = '';
    autosize();
    await renderMsgs(true);
    toast('Brief disimpan. Ketuk ▶ untuk memulai.', 5000);
  }

  function autosize() {
    if (!inputEl) return;
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  }

  // ---------- Panel kanan: file ----------
  async function refreshFiles() {
    inFiles = []; outFiles = [];
    if (curName && rready()) {
      try {
        const fs = R().fs;
        inFiles = (await fs.list(jp('In'))).filter((f) => f.path !== 'brief.md');
        outFiles = await fs.list(jp('Out'));
      } catch (_) {}
    }
    renderFiles();
  }

  function fileRow(f, kind) {
    const kids = [el('span', { class: 'cfname', text: f.path, title: f.path })];
    if (kind === 'out') kids.push(el('button', { type: 'button', class: 'cfbtn', text: '⬇', 'aria-label': 'Salin ke Download', onclick: () => exportOne(f.path) }));
    kids.push(el('button', { type: 'button', class: 'cfbtn', text: '✕', 'aria-label': 'Hapus', onclick: () => delFile(kind, f.path) }));
    return el('div', { class: 'cfile' }, ...kids);
  }

  function renderFiles() {
    const none = (t) => [el('div', { class: 'cfnone', text: t })];
    if (inEl) inEl.replaceChildren(...(inFiles.length ? inFiles.map((f) => fileRow(f, 'in')) : none('Kosong')));
    if (outEl) outEl.replaceChildren(...(outFiles.length ? outFiles.map((f) => fileRow(f, 'out')) : none('Kosong')));
  }

  async function addInput(files) {
    if (!curName) { toast('Buat atau pilih proyek dulu.'); return; }
    const fs = R().fs;
    let n = 0;
    for (const f of files) {
      if (f.size > MAX_FILE) { toast(`"${f.name}" terlalu besar (maks ${Math.round(MAX_FILE / 1024)} KB).`); continue; }
      let t = '';
      try { t = await f.text(); } catch (_) { t = ''; }
      if (!t || t.indexOf('\u0000') >= 0) { toast(`"${f.name}" bukan file teks.`); continue; }
      const safe = (RC && RC.safePath ? RC.safePath(f.name) : f.name) || f.name.replace(/[^\w.-]/g, '_');
      if (safe === 'brief.md') { toast('Nama brief.md dipakai untuk brief proyek. Ganti nama file.'); continue; }
      await fs.write(jp('In/' + safe), t);
      n++;
    }
    if (n) toast(`${n} file input ditambahkan. Ikut ke rencana dan langkah berikutnya.`);
    await refreshFiles();
  }

  async function delFile(kind, path) {
    try { await R().fs.del(jp((kind === 'in' ? 'In/' : 'Out/') + path)); } catch (_) {}
    await refreshFiles();
  }

  async function exportOne(path) {
    try {
      const r = await window.Relay.fs.read(jp('Out/' + path));
      if (r == null) throw new Error('file tidak ada');
      const x = (typeof P !== 'undefined' && P.GeckoBrowser) || null;
      if (x && x.projExport) {
        const res = await x.projExport({ path: jp('Out/' + path), name: `${curName}__${path.replace(/\//g, '__')}` });
        toast(res && res.where ? 'Disalin ke ' + res.where : 'File disalin ke folder Download.', 5000);
      }
    } catch (e) { toast('Gagal menyalin file: ' + ((e && e.message) || e)); }
  }

  // ---------- Panel kanan: list akun (pool proyek) ----------
  function renderAccounts() {
    if (!accEl) return;
    const list = accs();
    if (!list.length) { accEl.replaceChildren(el('div', { class: 'cfnone', text: 'Belum ada akun' })); return; }
    const pool = (job && job.pool) || [];
    const run = running();
    accEl.replaceChildren(...list.map((a) => {
      const lim = a.status === 'working';
      const idx = pool.indexOf(a.id);
      let sub = lim ? 'Limit' : 'Free';
      if (lim && a.resetAt) sub += ' · ' + atShort(a.resetAt);
      const now = run && job && job.lastAccount === a.name;
      if (now) sub = 'Bekerja...';
      return el('button', { type: 'button', class: `cacc ${now ? 'on' : ''} ${lim ? 'lim' : 'free'} ${job && idx < 0 ? 'out' : ''}`, onclick: () => togglePool(a) },
        el('i', { class: 'cdot' }),
        el('span', { class: 'cainfo' }, el('b', { text: (idx >= 0 ? `${idx + 1}. ` : '') + name(a) }), el('small', { text: sub })));
    }));
  }

  async function togglePool(a) {
    if (!job) { toast('Buat atau pilih proyek dulu.'); return; }
    if (running()) { toast('Batalkan proyek dulu untuk mengubah akun.'); return; }
    const cur = (await R().loadJob(curName)) || job;
    const i = cur.pool.indexOf(a.id);
    if (i >= 0) { if (cur.pool.length <= 1) { toast('Minimal satu akun di pool.'); return; } cur.pool.splice(i, 1); }
    else cur.pool.push(a.id);
    await R().saveJob(cur);
    await R().refreshJobs();
    toast(i >= 0 ? `${name(a)} dikeluarkan dari pool.` : `${name(a)} masuk pool (prioritas terakhir).`);
  }

  // ---------- Log proyek (untuk ditempel saat ada error) ----------
  async function refreshLog(force) {
    if (!logEl) return;
    if (!curName || !rready()) { logText = ''; logMark = ''; logEl.textContent = 'Belum ada proyek.'; return; }
    let raw = '';
    try { raw = (await R().fs.read(jp('State/log.jsonl'))) || ''; } catch (_) {}
    const mark = `${curName}|${raw.length}|${job && job.status}|${job && job.error}`;
    if (!force && mark === logMark) return;
    logMark = mark;
    const rows = raw.split('\n').filter(Boolean).slice(-40).map((l) => {
      try {
        const o = JSON.parse(l);
        const { t: at, ev, ...rest } = o;
        const d = new Date(at);
        return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${ev}${Object.keys(rest).length ? ' ' + JSON.stringify(rest) : ''}`;
      } catch (_) { return l; }
    });
    const head = [`Proyek: ${curName}`];
    if (job) {
      head.push(`Status: ${job.status}${job.current ? ' (' + job.current + ')' : ''}${job.waitUntil ? ' sampai ' + new Date(job.waitUntil).toISOString() : ''}`);
      if (job.error) head.push('Error: ' + job.error);
      head.push('Akun: ' + accs().map((a) => `${shortName(a.name)}=${a.status === 'working' ? 'limit' : 'free'}${a.check && a.check.state === 'loggedout' ? '/logout' : ''}`).join(', '));
    }
    logText = head.join('\n') + '\n---\n' + (rows.join('\n') || 'Belum ada catatan.');
    logEl.textContent = logText;
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function copyLog() {
    await refreshLog(true);
    if (!logText) { toast('Belum ada log.'); return; }
    try { await copyText(logText); toast('Log disalin. Tinggal tempel.'); } catch (_) { toast('Gagal menyalin. Tahan teks log lalu salin manual.'); }
  }

  // ---------- Segarkan ----------
  async function refreshAll(force) {
    if (!page || !page.classList.contains('show') && !force) { /* tetap segar saat digeser */ }
    renderHead();
    renderAccounts();
    refreshLog(force);
    await renderMsgs(force);
  }

  function onJobsChange() {
    if (page && page.classList.contains('show')) { renderHead(); renderAccounts(); renderMsgs(); refreshLog(); }
    if (listPage && listPage.classList.contains('show')) renderProjects();
  }
  window.addEventListener('relaychange', onJobsChange);

  // ---------- Daftar proyek ----------
  function projCard(j) {
    const total = j.plan ? j.plan.steps.length : 0;
    const done = j.plan ? j.plan.steps.filter((s) => (j.steps[s.id] || {}).status === 'done').length : 0;
    const cur = j.plan ? j.plan.steps.find((s) => (j.steps[s.id] || {}).status !== 'done') : null;
    const info = [];
    if (j.plan) info.push(`Langkah ${done}/${total}${cur ? ` · berikutnya: ${cur.title}` : ''}`);
    else info.push('Rencana belum dibuat');
    if (j.lastAccount) info.push(`Akun terakhir: ${shortName(j.lastAccount)}`);
    if (j.error && j.status !== 'done') info.push(j.error);
    const run = !!(R() && R().isRunning && R().isRunning(j.name));
    return el('div', { class: `ritem pcard ${j.status === 'failed' ? 'bad' : ''}`, role: 'button', tabindex: '0', onclick: () => openChat(j.name) },
      el('div', { class: 'rtop' }, el('b', { class: 'rname', text: j.name }), el('span', { class: 'rbadge', text: run ? 'Berjalan' : R().statusText(j) })),
      el('div', { class: 'rbar' }, el('i', { style: `width:${total ? Math.round((done / total) * 100) : 0}%` })),
      ...info.map((t) => el('div', { class: 'hint2', text: t })));
  }

  function renderProjects() {
    if (!listEl) return;
    if (!rready()) { listEl.replaceChildren(el('div', { class: 'cmempty', text: 'Fitur estafet hanya jalan di APK terbaru.' })); return; }
    const jobs = (R().getJobs && R().getJobs()) || [];
    if (!jobs.length) { listEl.replaceChildren(el('div', { class: 'cmempty', text: 'Belum ada proyek.\nKetuk "+ Proyek baru".' })); return; }
    listEl.replaceChildren(...jobs.map(projCard));
  }

  function newProject() {
    const r = R();
    if (!rready()) { toast('Butuh APK versi terbaru (fitur estafet belum ada di APK ini).'); return; }
    r.newProjectForm((n) => openChat(n));
  }

  // ---------- Buka / tutup halaman ----------
  const shown = (p) => !!(p && p.classList.contains('show'));
  const topPage = () => (shown(page) ? page : shown(listPage) ? listPage : null);
  function push(cam) { if (!(history.state && history.state.cam === cam)) { try { history.pushState({ cam }, ''); } catch (_) {} } }
  function back(cam) { try { if (history.state && history.state.cam === cam) history.back(); } catch (_) {} }
  function showPage(p) {
    p.style.transform = '';
    p.classList.remove('drag');
    p.classList.add('show');
    document.body.classList.add('chat-open');
    clearInterval(timer);
    timer = setInterval(tick, 2000);
  }
  function hidePage(p) {
    p.style.transform = '';
    p.classList.remove('drag', 'show');
    if (!topPage()) { document.body.classList.remove('chat-open'); clearInterval(timer); }
  }
  function tick() {
    if (shown(page)) { renderHead(); renderAccounts(); renderMsgs(); refreshLog(); if (running()) refreshFiles(); }
    if (shown(listPage)) renderProjects();
  }

  function prepareList() {
    if (!listPage) buildList();
    const r = R();
    if (r && r.refreshJobs) r.refreshJobs().then(renderProjects).catch(() => {});
    renderProjects();
  }
  function openList() { prepareList(); showPage(listPage); push('list'); }
  function closeList(fromPop) {
    if (!shown(listPage)) return;
    hidePage(listPage);
    if (!fromPop) back('list');
  }

  function openChat(n) {
    if (!page) build();
    curName = n; job = null; timeline = ''; logMark = '';
    const r = R();
    if (r && r.refreshJobs) r.refreshJobs().then(() => { renderHead(); renderAccounts(); renderMsgs(true); refreshFiles(); refreshLog(true); }).catch(() => {});
    renderHead(); renderAccounts(); renderMsgs(true); refreshFiles(); refreshLog(true);
    showPage(page);
    push('chat');
  }
  function closeChat(fromPop) {
    if (!shown(page)) return;
    hidePage(page);
    if (!fromPop) back('chat');
    renderProjects();
  }

  // Tombol back Android / riwayat: halaman paling atas ditutup
  window.addEventListener('popstate', () => {
    const cam = history.state && history.state.cam;
    if (cam !== 'chat') closeChat(true);
    if (cam !== 'list' && cam !== 'chat') closeList(true);
  });

  // ---------- Geser ----------
  // Halaman utama: geser ke kiri = buka daftar proyek (halaman ikut mengikuti jari). Di daftar proyek atau halaman chat: geser ke kanan dari
  // tepi kiri atau dari baris atas = mundur satu halaman. Geser hanya dianggap kalau gerakannya jelas mendatar.
  const EDGE = 36;       // px: lebar zona tepi kiri untuk geser kembali
  const START = 12;      // px: gerak minimal sebelum arah dikunci
  let sw = null;         // {x, y, mode:'open'|'close', locked, w, p}

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
    if (swipeBlocked(e.target)) return;
    const top = topPage();
    if (!top) sw = { x: t.clientX, y: t.clientY, mode: 'open', locked: false, w: window.innerWidth, p: null };
    else if (t.clientX <= EDGE || (e.target.closest && e.target.closest('.cphead'))) sw = { x: t.clientX, y: t.clientY, mode: 'close', locked: false, w: window.innerWidth, p: top };
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
      if (sw.mode === 'open') { prepareList(); sw.p = listPage; }
      sw.p.classList.add('drag');
    }
    const w = sw.w;
    const x = sw.mode === 'open' ? Math.max(0, w + dx) : Math.min(w, Math.max(0, dx));
    sw.p.style.transform = `translateX(${x}px)`;
    sw.dx = dx;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  function endSwipe() {
    if (!sw || !sw.locked) { sw = null; return; }
    const s = sw; sw = null;
    const far = Math.abs(s.dx || 0) > s.w * 0.25;
    s.p.classList.remove('drag');
    s.p.style.transform = '';
    if (s.mode === 'open') { if (far) openList(); }
    else if (far) { if (s.p === page) closeChat(false); else closeList(false); }
    else s.p.classList.add('show');
  }
  document.addEventListener('touchend', endSwipe, { passive: true });
  document.addEventListener('touchcancel', endSwipe, { passive: true });

  function build() {
    const holdBtn = (text, hint, run) => {
      const b = el('button', { type: 'button', class: 'tbtn hold chbtn', text, title: hint, 'aria-label': hint });
      holdPress(b, 1000, run, () => toast(hint));
      return b;
    };
    const busy = () => typeof checking !== 'undefined' && checking;
    const checkB = el('button', { type: 'button', class: 'tbtn primary chbtn', text: '⟳ Cek akun', 'aria-label': 'Cek semua akun', onclick: () => { if (busy()) toast('Sedang mengecek akun, tunggu sebentar.'); else { toast('Mengecek semua akun...'); checkAll(); } } });
    const baitB = holdBtn('🎣 Pancing akun', 'Tahan 1 detik: pancing semua akun sekarang, lalu cek', () => { if (busy()) toast('Sedang mengecek akun, tunggu sebentar.'); else { toast('Memancing semua akun...'); baitNow(); } });

    fileIn = el('input', { type: 'file', multiple: 'multiple', accept: 'text/*,.md,.json,.js,.ts,.tsx,.jsx,.py,.java,.kt,.html,.css,.csv,.xml,.yml,.yaml,.txt,.sh,.sql,.c,.cpp,.h,.go,.rs,.php,.rb', hidden: true, onchange: async (e) => { const fl = Array.from(e.target.files || []); e.target.value = ''; if (fl.length) await addInput(fl); } });
    inEl = el('div', { class: 'cflist' });
    outEl = el('div', { class: 'cflist' });
    accEl = el('div', { class: 'cflist caccs' });

    titleEl = el('div', { class: 'cpsel cptit' });
    logEl = el('pre', { class: 'cplog', text: 'Belum ada proyek.' });
    actBtn = el('button', { type: 'button', class: 'cpact', text: '▶', onclick: onAct });
    moreBtn = el('button', { type: 'button', class: 'cnew', text: '⋯', 'aria-label': 'Menu estafet', onclick: onMore });
    barEl = el('div', { class: 'rbar cpbar' }, el('i', { style: 'width:0%' }));
    stEl = el('div', { class: 'cpstat', text: '' });
    msgsEl = el('div', { class: 'cpmsgs', 'aria-live': 'polite' });
    inputEl = el('textarea', { class: 'cinput', rows: '1', placeholder: 'kolom chat (brief proyek)', 'aria-label': 'Kolom chat: tulis brief proyek baru', autocomplete: 'off' });
    inputEl.addEventListener('input', autosize);
    sendBtn = el('button', { type: 'button', class: 'btn sm csend', text: '➤', 'aria-label': 'Buat proyek baru dari brief ini', onclick: onSend });

    const back = el('button', { type: 'button', class: 'cback', 'aria-label': 'Kembali ke halaman utama', onclick: () => closeChat(false) },
      (() => {
        const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.4'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', 'M19 12H5M11 6l-6 6 6 6');
        s.append(p);
        return s;
      })());

    const chatCol = el('section', { class: 'cchat', 'aria-label': 'Estafet' },
      el('div', { class: 'cphead' }, back, titleEl, actBtn, moreBtn),
      el('div', { class: 'cpinfo' }, barEl, stEl),
      msgsEl,
      el('div', { class: 'cbar' }, inputEl, sendBtn));

    const side = el('aside', { class: 'cside', 'aria-label': 'Panel' },
      checkB, baitB,
      el('div', { class: 'cpanel' },
        el('div', { class: 'cptitle' }, el('span', { text: 'Input file' }), el('button', { type: 'button', class: 'cfbtn add', text: '＋', 'aria-label': 'Tambah file input', onclick: () => { if (!curName) toast('Buat atau pilih proyek dulu.'); else fileIn.click(); } })),
        inEl),
      el('div', { class: 'cpanel' }, el('div', { class: 'cptitle' }, el('span', { text: 'Output file' })), outEl),
      el('div', { class: 'cpanel' }, el('div', { class: 'cptitle' }, el('span', { text: 'List akun' })), accEl),
      el('div', { class: 'cpanel' }, el('div', { class: 'cptitle' }, el('span', { text: 'Log proyek' }), el('button', { type: 'button', class: 'cfbtn add', text: '📋', 'aria-label': 'Salin log', onclick: copyLog })), logEl),
      fileIn);

    page = el('div', { class: 'chatpage cpchat', role: 'dialog', 'aria-label': 'Halaman chat proyek' }, chatCol, side);
    document.body.append(page);
  }

  // Halaman daftar proyek: judul, + Proyek baru, kartu proyek
  function buildList() {
    const back = el('button', { type: 'button', class: 'cback', 'aria-label': 'Kembali ke halaman utama', onclick: () => closeList(false) },
      (() => {
        const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        sv.setAttribute('viewBox', '0 0 24 24'); sv.setAttribute('fill', 'none'); sv.setAttribute('stroke', 'currentColor'); sv.setAttribute('stroke-width', '2.4'); sv.setAttribute('stroke-linecap', 'round'); sv.setAttribute('stroke-linejoin', 'round');
        const pt = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pt.setAttribute('d', 'M19 12H5M11 6l-6 6 6 6');
        sv.append(pt);
        return sv;
      })());
    listEl = el('div', { class: 'cpmsgs cplist' });
    const col = el('section', { class: 'cchat', 'aria-label': 'Daftar proyek' },
      el('div', { class: 'cphead' }, back, el('div', { class: 'cpsel cptit', text: 'Proyek estafet' }), el('button', { type: 'button', class: 'btn sm cpnew', text: '+ Proyek baru', onclick: newProject })),
      listEl);
    listPage = el('div', { class: 'chatpage projpage', role: 'dialog', 'aria-label': 'Daftar proyek estafet' }, col);
    document.body.append(listPage);
  }

  window.ChatPage = { open: openList, close: closeList };
})();
