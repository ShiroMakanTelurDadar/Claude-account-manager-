// Estafet: satu proyek dipecah jadi langkah kecil yang dikerjakan di chat baru, dan kalau akun kena limit, langkah yang sama diulang
// di akun berikutnya. Semua keadaan dipegang aplikasi (bukan Claude), jadi limit mendadak tidak menghilangkan hasil yang sudah tersimpan.
//
//   Penyimpanan  : <files>/Projects/<nama>/{In,Out,State}   (lewat plugin native projWrite / projRead / projList / projDelete)
//   In/brief.md  : brief dari pengguna
//   State/job.json, plan.json, progress.md, log.jsonl, raw/  : keadaan job, rencana, progres, catatan kejadian, balasan mentah + data percakapan
//   Out/         : file hasil tiap langkah
//
// Memakai sesi tersembunyi pancingan (mode "work" / "dump" di GeckoBrowser.bait). Logika murni ada di relay-core.js.
(function () {
  'use strict';
  const RC = window.RelayCore;
  const g = () => (typeof P !== 'undefined' && P.GeckoBrowser) || null;
  const ready = () => { const G = g(); return !!(typeof native !== 'undefined' && native && G && G.bait && G.projWrite); };

  const STEP_TIMEOUT = 12 * 60 * 1000;   // ms: batas satu langkah (sejak halaman siap)
  const PLAN_TIMEOUT = 6 * 60 * 1000;
  const DUMP_TIMEOUT = 120000;
  const MAX_TRIES = 3;                   // langkah yang selesai dijawab tapi file hasilnya tetap tidak lengkap: menyerah setelah ini
  const MAX_FAILS = 2;                   // gagal berturut-turut di satu akun sebelum akun itu dilewati
  const RAW_KEEP = 8;                    // jumlah balasan mentah terakhir yang disimpan per proyek

  const STATUS_LABEL = {
    queued: 'Antre', running: 'Berjalan', waiting_limit: 'Menunggu limit', waiting_login: 'Perlu login',
    done: 'Selesai', failed: 'Gagal', cancelled: 'Dibatalkan',
  };

  // ---------- File ----------
  const fs = {
    async write(path, content, append) { await g().projWrite({ path, content, append: !!append }); },
    async read(path) { const r = await g().projRead({ path }); return r && r.exists ? r.content : null; },
    async list(path) { const r = await g().projList({ path }); return (r && r.items) || []; },
    async dirs(path) { const r = await g().projList({ path, dirs: true }); return (r && r.items) || []; },
    async del(path) { await g().projDelete({ path }); },
  };
  const jp = (name, rest) => `${name}/${rest}`;

  async function loadJob(name) {
    try { const t = await fs.read(jp(name, 'State/job.json')); return t ? JSON.parse(t) : null; } catch (_) { return null; }
  }
  const saveJob = (job) => fs.write(jp(job.name, 'State/job.json'), JSON.stringify(job, null, 1));
  const logEv = (name, ev, extra) => fs.write(jp(name, 'State/log.jsonl'), JSON.stringify(Object.assign({ t: Date.now(), ev }, extra || {})) + '\n', true).catch(() => {});

  // ---------- Notifikasi ----------
  const hashId = (s) => { let h = 7; for (const c of s) h = (h * 33 + c.charCodeAt(0)) | 0; return (Math.abs(h) % 2147000000) + 100; };
  const waiting = new Map();   // nama proyek -> jam (ms) akun pertama reset
  // app.js (scheduleAll) menghapus semua notifikasi terjadwal lalu memasang ulang. Ini menitipkan notifikasi proyek ke daftar itu.
  window.relayNotifItems = () => [...waiting].filter(([, t]) => t > Date.now()).map(([name, t]) => ({
    id: hashId('w:' + name),
    title: `Proyek "${name}" bisa dilanjutkan`,
    body: 'Limit akun sudah reset. Ketuk untuk melanjutkan.',
    schedule: { at: new Date(t), allowWhileIdle: true },
    extra: { kind: 'relay', project: name },
  }));
  async function notifyNow(title, body, name) {
    try { toast(`${title}. ${body}`, 7000); } catch (_) {}
    try {
      if (P.LocalNotifications) await P.LocalNotifications.schedule({ notifications: [{ id: hashId('n:' + name + Date.now()), title, body, extra: { kind: 'relay', project: '' } }] });
    } catch (_) {}
  }
  const wakers = new Map();
  function armWake(job) {
    clearTimeout(wakers.get(job.name));
    wakers.delete(job.name);
    if (job.status !== 'waiting_limit' || !job.waitUntil) { waiting.delete(job.name); return; }
    waiting.set(job.name, job.waitUntil);
    const ms = Math.max(1000, job.waitUntil - Date.now() + 3000);
    if (ms < 2147000000) wakers.set(job.name, setTimeout(() => { wakers.delete(job.name); runJob(job.name); }, ms));
    if (typeof scheduleAll === 'function') scheduleAll();
  }

  // ---------- Akun ----------
  // Akun baru saja terbukti limit. Pastikan jam resetnya di masa depan, kalau tidak pemilih akun akan memakainya lagi dan job berputar terus
  // (mis. waktu manual lama yang sudah lewat, atau teks limit tidak terbaca).
  function markLimit(a, text, url) {
    onLimitSeen(a.id, text, url, Date.now());
    const ok = a.status === 'working' && a.resetAt && Date.parse(a.resetAt) > Date.now() + 30000;
    if (ok) return;
    const p = typeof parseResetAt === 'function' ? parseResetAt(text || '') : null;
    const future = p && p.getTime() > Date.now() ? p : null;
    a.status = 'working'; a.notified = false;
    a.resetAt = (future || new Date(Date.now() + 5 * 3600e3)).toISOString();
    a.resetSrc = future ? 'auto' : 'default';
    commit();
  }

  // ---------- Prompt ----------
  async function promptFor(job, cur) {
    if (cur.kind === 'plan') return RC.buildPlanPrompt(await fs.read(jp(job.name, 'In/brief.md')) || '', []);
    const st = job.steps[cur.step.id] || {};
    const needFiles = [];
    for (const p of cur.step.needs) {
      const c = await fs.read(jp(job.name, 'Out/' + p));
      if (c != null) needFiles.push({ path: p, content: c });
    }
    return RC.buildStepPrompt({
      plan: job.plan, step: cur.step, index: cur.index, got: st.got || [], needFiles,
      progress: RC.buildProgress(job.name, job.plan, job.steps), brief: await fs.read(jp(job.name, 'In/brief.md')) || '',
    });
  }
  const writeProgress = (job) => fs.write(jp(job.name, 'State/progress.md'), RC.buildProgress(job.name, job.plan, job.steps));

  function curStep(job) {
    if (!job.plan) return { kind: 'plan' };
    for (let i = 0; i < job.plan.steps.length; i++) {
      const s = job.plan.steps[i];
      if ((job.steps[s.id] || {}).status !== 'done') return { kind: 'step', step: s, index: i };
    }
    return null;
  }

  // ---------- Satu putaran job ----------
  let running = null;   // {name, cancel}

  async function runJob(name) {
    if (running) { toast('Ada proyek lain yang sedang berjalan.'); return; }
    const G = g();
    if (!ready()) { toast('Butuh APK versi terbaru (fitur estafet belum ada di APK ini).'); return; }
    if (typeof checking !== 'undefined' && (checking || (typeof resumeBusy !== 'undefined' && resumeBusy))) { toast('Tunggu pengecekan akun selesai dulu.'); return; }
    const run = { name, cancel: false };
    running = run;
    checking = true;   // cegah cek otomatis memakai sesi tersembunyi selama job
    try { if (G.keepAlive) G.keepAlive({ on: true }).catch(() => {}); } catch (_) {}
    renderList();
    try {
      await loop(run);
    } catch (e) {
      try {
        const job = await loadJob(name);
        if (job) { job.status = 'failed'; job.error = 'Error: ' + ((e && e.message) || e); await saveJob(job); await logEv(name, 'error', { msg: job.error }); }
      } catch (_) {}
    } finally {
      running = null;
      checking = false;
      try {
        const want = !!(typeof settings !== 'undefined' && settings.firstDone && (settings.autoMin || settings.quietOn));
        if (!want && G.keepAlive) G.keepAlive({ on: false }).catch(() => {});
      } catch (_) {}
      await refreshJobs();
    }
  }

  async function loop(run) {
    const name = run.name;
    const G = g();
    let job = await loadJob(name);
    if (!job) throw new Error('job.json tidak ditemukan');
    const skip = new Set();
    const fails = new Map();
    job.status = 'running'; job.error = ''; job.waitUntil = 0;
    await saveJob(job);
    await logEv(name, 'start', { pool: job.pool.length });
    armWake(job);
    renderList();

    while (!run.cancel) {
      const cur = curStep(job);
      if (!cur) {
        job.status = 'done'; await saveJob(job); await logEv(name, 'done');
        await notifyNow(`Proyek "${name}" selesai`, 'Semua langkah sudah dikerjakan.', name);
        return;
      }
      const pick = RC.pickAccount(accounts, job.pool, Date.now(), skip);
      if (pick.wait) {
        job.status = 'waiting_limit'; job.waitUntil = pick.wait; await saveJob(job);
        await logEv(name, 'wait-limit', { until: new Date(pick.wait).toISOString() });
        armWake(job);
        toast(`Semua akun limit. Dilanjutkan otomatis jam ${atShort(new Date(pick.wait).toISOString())}.`, 7000);
        return;
      }
      if (pick.none) {
        job.status = 'waiting_login'; job.error = 'Tidak ada akun di pool yang bisa dipakai (belum login atau gagal berulang).';
        await saveJob(job); await logEv(name, 'no-account');
        await notifyNow(`Proyek "${name}" berhenti`, 'Tidak ada akun yang bisa dipakai. Cek login akun.', name);
        return;
      }
      const a = pick.account;
      const tag = cur.kind === 'plan' ? 'plan' : cur.step.id;
      const prompt = await promptFor(job, cur);
      job.lastAccount = a.name; job.status = 'running'; job.current = tag;
      await saveJob(job);
      await logEv(name, 'send', { tag, account: a.name, chars: prompt.length });
      renderList();

      let res;
      try {
        res = await G.bait({ accountId: a.id, url: CLAUDE_URL, mode: 'work', command: prompt, timeoutMs: cur.kind === 'plan' ? PLAN_TIMEOUT : STEP_TIMEOUT });
      } catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
      if (res.error === 'cancel' || run.cancel) break;
      if (res.error === 'busy') {
        job.status = 'queued'; job.error = 'Sesi tersembunyi sedang dipakai proses lain. Coba lagi sebentar.';
        await saveJob(job); return;
      }
      const verdict = await handleResult(job, cur, tag, a, res, skip, fails);
      await saveJob(job);
      if (verdict === 'stop') { renderList(); return; }
    }
    if (run.cancel) {
      job = (await loadJob(name)) || job;
      job.status = 'cancelled'; job.error = ''; await saveJob(job); await logEv(name, 'cancelled');
    }
  }

  // Teks terbaik dari satu hasil: balasan akhir kalau selesai, kalau tidak salinan parsial terakhir
  function bestText(res) {
    const p = String(res.partial || '');
    if (res.state === 'limit') return p;   // pada limit, "text" adalah tulisan banner, bukan balasan Claude
    const t = /^why:/.test(String(res.text || '')) ? '' : String(res.text || '');
    return t.length >= p.length ? t : p;
  }

  // Memproses hasil satu percobaan. Mengembalikan 'stop' kalau job harus berhenti, selain itu lanjut ke putaran berikutnya.
  async function handleResult(job, cur, tag, a, res, skip, fails) {
    const name = job.name;
    const state = res.state || 'fail';
    const text = bestText(res);
    const why = typeof baitWhy === 'function' ? baitWhy(res.text) : '';

    // Simpan jejak mentah (balasan + data percakapan) untuk diperiksa. Yang lama dibuang.
    job.seq = (job.seq || 0) + 1;
    job.raw = job.raw || [];
    if (text) { await fs.write(jp(name, `State/raw/${tag}-${job.seq}.md`), text); job.raw.push(`State/raw/${tag}-${job.seq}.md`); }
    if (res.data) { await fs.write(jp(name, `State/raw/${tag}-${job.seq}.json`), res.data); job.raw.push(`State/raw/${tag}-${job.seq}.json`); }
    while (job.raw.length > RAW_KEEP * 2) await fs.del(jp(name, job.raw.shift())).catch(() => {});
    await logEv(name, 'result', { tag, account: a.name, state, chars: text.length, timedOut: !!res.timedOut, why });

    if (state === 'loggedout') {
      skip.add(a.id);
      if (typeof noteCheck === 'function') noteCheck(a, 'loggedout', Date.now());
      return 'next';
    }
    if (state === 'limit') markLimit(a, res.text, res.url);
    const challenge = state === 'fail' && /^why:challenge/.test(String(res.text || ''));
    if (challenge) skip.add(a.id);
    if (state === 'fail' && !text) {
      // Gagal tanpa hasil apa pun
      const n = (fails.get(a.id) || 0) + 1;
      fails.set(a.id, n);
      if (n >= MAX_FAILS) skip.add(a.id);
      job.tries = job.tries || {};
      job.tries[tag + ':fail'] = (job.tries[tag + ':fail'] || 0) + 1;
      if (job.tries[tag + ':fail'] >= MAX_TRIES * 2) return fail(job, `Gagal terus di ${tag}: ${why || 'tidak diketahui'}`);
      return 'next';
    }
    fails.delete(a.id);

    // Ada teks (utuh atau parsial): selamatkan apa yang utuh
    const counted = state !== 'limit';   // limit bukan salah langkah ini; selain itu (selesai tapi kurang, timeout, tak dikenal) dihitung supaya tidak berputar selamanya
    if (cur.kind === 'plan') {
      const r = RC.parsePlan(text);
      if (r.ok) {
        job.plan = r.plan; job.steps = {};
        for (const s of r.plan.steps) job.steps[s.id] = { status: 'pending', got: [] };
        await fs.write(jp(name, 'State/plan.json'), JSON.stringify(r.plan, null, 1));
        await writeProgress(job);
        await logEv(name, 'plan', { steps: r.plan.steps.length });
        return 'next';
      }
      if (counted) {
        job.tries = job.tries || {};
        job.tries.plan = (job.tries.plan || 0) + 1;
        job.error = 'Rencana belum valid: ' + r.err;
        // Bentuk balasan dicatat supaya penyebab bisa dilihat: blok apa saja yang terbaca (bahasa:utuh/terbuka:panjang), awal dan akhir teks
        await logEv(name, 'plan-bad', {
          err: r.err, try: job.tries.plan,
          blocks: RC.extractBlocks(text).map((b) => `${b.lang || '-'}:${b.complete ? 'utuh' : 'terbuka'}:${b.content.length}`),
          head: text.slice(0, 140), tail: text.slice(-100),
        });
        if (job.tries.plan >= MAX_TRIES) return fail(job, 'Rencana gagal dibuat ' + MAX_TRIES + 'x: ' + r.err);
      }
      return 'next';
    }

    const st = job.steps[cur.step.id] = job.steps[cur.step.id] || { status: 'pending', got: [] };
    st.got = st.got || [];
    const wanted = new Set(cur.step.outputs);
    let saved = 0;
    for (const f of RC.extractFiles(text)) {
      if (!wanted.has(f.path) || st.got.includes(f.path)) continue;
      await fs.write(jp(name, 'Out/' + f.path), f.content);
      st.got.push(f.path);
      saved++;
    }
    if (saved) await logEv(name, 'files', { tag, saved, got: st.got.length, of: cur.step.outputs.length });
    if (cur.step.outputs.every((p) => st.got.includes(p))) {
      st.status = 'done'; st.doneAt = Date.now(); st.accountId = a.id;
      const note = RC.extractState(text);
      if (note) st.note = note;
      await writeProgress(job);
      await logEv(name, 'step-done', { tag, account: a.name });
      return 'next';
    }
    if (counted) {
      job.tries = job.tries || {};
      job.tries[tag] = (job.tries[tag] || 0) + 1;
      const missing = cur.step.outputs.filter((p) => !st.got.includes(p));
      job.error = `Langkah ${tag} belum lengkap, kurang: ${missing.join(', ')}`;
      await logEv(name, 'incomplete', { tag, missing, try: job.tries[tag] });
      if (job.tries[tag] >= MAX_TRIES) return fail(job, `Langkah ${tag} gagal ${MAX_TRIES}x, file kurang: ${missing.join(', ')}`);
    }
    return 'next';
  }

  async function fail(job, msg) {
    job.status = 'failed'; job.error = msg;
    await logEv(job.name, 'failed', { msg });
    await notifyNow(`Proyek "${job.name}" gagal`, msg, job.name);
    return 'stop';
  }

  // ---------- Proyek: buat, hapus, ekspor ----------
  async function createProject(name, brief, pool) {
    const dirs = await fs.dirs('');
    if (dirs.includes(name)) throw new Error('Nama proyek sudah dipakai');
    await fs.write(jp(name, 'In/brief.md'), brief);
    const job = { v: 1, name, createdAt: Date.now(), status: 'queued', pool, plan: null, steps: {}, tries: {}, raw: [], seq: 0, waitUntil: 0, error: '' };
    await saveJob(job);
    await logEv(name, 'created', { pool: pool.length });
    return job;
  }

  async function exportProject(name) {
    const files = await fs.list(jp(name, 'Out'));
    if (!files.length) { toast('Belum ada file hasil untuk diekspor.'); return; }
    let n = 0;
    for (const f of files) {
      try { await g().projExport({ path: jp(name, 'Out/' + f.path), name: `${name}__${f.path.replace(/\//g, '__')}` }); n++; } catch (_) {}
    }
    toast(`${n} file hasil disalin ke folder Download.`, 6000);
  }

  async function deleteProject(name) {
    if (running && running.name === name) { toast('Batalkan dulu proyek yang sedang berjalan.'); return; }
    if (!confirm(`Hapus proyek "${name}" beserta semua filenya (In, Out, State)?`)) return;
    clearTimeout(wakers.get(name)); wakers.delete(name); waiting.delete(name);
    await fs.del(name);
    if (typeof scheduleAll === 'function') scheduleAll();
    await refreshJobs();
  }

  // ---------- Uji: ambil data percakapan sebuah chat ----------
  // Menjawab pertanyaan penting: apakah isi perintah/kode sandbox, rujukan file, dan teks yang sempat tertulis sebelum limit tersimpan di server?
  async function dumpChat(accountId, url, out) {
    if (!ready()) { out('Butuh APK versi terbaru.'); return; }
    if (running) { out('Ada proyek yang sedang berjalan. Tunggu atau batalkan dulu.'); return; }
    if (typeof checking !== 'undefined' && checking) { out('Tunggu pengecekan akun selesai dulu.'); return; }
    if (!/^https:\/\/claude\.ai\/chat\/[0-9a-f-]{36}/i.test(url)) { out('Alamat harus berbentuk https://claude.ai/chat/...'); return; }
    checking = true;
    out('Mengambil data percakapan di belakang layar...');
    let res;
    try { res = await g().bait({ accountId, url, mode: 'dump', timeoutMs: DUMP_TIMEOUT }); }
    catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
    finally { checking = false; }
    if (res.error) { out('Gagal: ' + (res.error === 'busy' ? 'sesi tersembunyi sedang dipakai.' : res.error)); return; }
    if (res.state !== 'dumped' || !res.data) { out('Gagal membaca chat: ' + ((typeof baitWhy === 'function' && baitWhy(res.text)) || res.state || 'tidak diketahui')); return; }
    let d = null;
    try { d = JSON.parse(res.data); } catch (_) {}
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = `_dump/dump-${stamp}.json`;
    await fs.write(file, res.data);
    let where = '';
    try { const r = await g().projExport({ path: file, name: `dump-${stamp}.json` }); where = r && r.where ? r.where : ''; } catch (_) {}
    const lines = [];
    if (!d) lines.push('Data tidak bisa dibaca sebagai JSON.');
    else if (d.err) lines.push('API percakapan gagal: ' + d.err);
    else {
      lines.push(`Ukuran data percakapan: ${Math.round((d.size || 0) / 1024)} KB${d.raw ? '' : ' (mentah tidak disimpan, terlalu besar)'}`);
      lines.push(`Perintah / kode sandbox yang terbaca (tool_use): ${(d.tools || []).length}`);
      const names = [...new Set((d.tools || []).map((t) => t.name))].slice(0, 6);
      if (names.length) lines.push('Nama tool: ' + names.join(', '));
      lines.push(`Rujukan file yang terbaca: ${(d.files || []).length}`);
      if (d.parseErr) lines.push('Catatan: ' + d.parseErr);
    }
    lines.push(`Teks balasan terakhir di halaman: ${(res.text || '').length} karakter.`);
    lines.push(where ? 'Disalin ke ' + where : 'Disimpan di folder aplikasi: Projects/' + file);
    out(lines.join('\n'));
  }

  // ---------- Tampilan ----------
  let drawer = null;
  let backdrop = null;
  let listEl = null;
  let jobs = [];

  async function refreshJobs() {
    if (!ready()) { jobs = []; renderList(); return; }
    const names = (await fs.dirs('')).filter((n) => !n.startsWith('_'));
    const out = [];
    for (const n of names) { const j = await loadJob(n); if (j) out.push(j); }
    out.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    jobs = out;
    renderList();
  }

  function statusText(j) {
    let t = STATUS_LABEL[j.status] || j.status;
    if (running && running.name === j.name) t = STATUS_LABEL.running;
    if (j.status === 'waiting_limit' && j.waitUntil) t += ` · reset ${atShort(new Date(j.waitUntil).toISOString())}`;
    return t;
  }

  function renderList() {
    if (!listEl) return;
    if (!ready()) {
      listEl.replaceChildren(el('p', { class: 'hint2 rempty', text: 'Fitur ini hanya jalan di APK terbaru. Pasang APK hasil build terbaru dulu.' }));
      return;
    }
    if (!jobs.length) {
      listEl.replaceChildren(el('p', { class: 'hint2 rempty', text: 'Belum ada proyek. Ketuk "+ Proyek baru".' }));
      return;
    }
    listEl.replaceChildren(...jobs.map(card));
  }

  function card(j) {
    const isRun = !!(running && running.name === j.name);
    const total = j.plan ? j.plan.steps.length : 0;
    const done = j.plan ? j.plan.steps.filter((s) => (j.steps[s.id] || {}).status === 'done').length : 0;
    const cur = j.plan ? j.plan.steps.find((s) => (j.steps[s.id] || {}).status !== 'done') : null;
    const info = [];
    if (j.plan) info.push(`Langkah ${done}/${total}${cur ? ` · berikutnya: ${cur.title}` : ''}`);
    else info.push('Rencana belum dibuat');
    if (j.lastAccount) info.push(`Akun terakhir: ${shortName(j.lastAccount)}`);
    if (j.error && j.status !== 'done') info.push(j.error);
    const bar = el('div', { class: 'rbar' }, el('i', { style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));
    const btns = [];
    if (isRun) btns.push(el('button', { type: 'button', class: 'btn-g rb', text: '■ Batal', onclick: () => cancelRun() }));
    else if (j.status !== 'done') btns.push(el('button', { type: 'button', class: 'btn sm rb', text: j.plan || j.status !== 'queued' ? '▶ Lanjut' : '▶ Mulai', onclick: () => runJob(j.name) }));
    btns.push(
      el('button', { type: 'button', class: 'btn-g rb', text: '📄 Log', onclick: () => showLog(j.name) }),
      el('button', { type: 'button', class: 'btn-g rb', text: '⬇ Hasil', onclick: () => exportProject(j.name) }),
      el('button', { type: 'button', class: 'btn-g rb', text: '🗑', 'aria-label': 'Hapus proyek', onclick: () => deleteProject(j.name) }),
    );
    return el('div', { class: `ritem ${j.status === 'failed' ? 'bad' : ''}` },
      el('div', { class: 'rtop' }, el('b', { class: 'rname', text: j.name }), el('span', { class: 'rbadge', text: statusText(j) })),
      bar,
      ...info.map((t) => el('div', { class: 'hint2', text: t })),
      el('div', { class: 'rbtns' }, ...btns),
    );
  }

  function cancelRun() {
    if (!running) return;
    running.cancel = true;
    try { const G = g(); if (G && G.cancelCheck) G.cancelCheck(); } catch (_) {}
    toast('Membatalkan proyek...');
  }

  // Jendela kecil di tengah layar
  function modal(...kids) {
    const box = el('div', { class: 'rbox', role: 'dialog' }, ...kids);
    const m = el('div', { class: 'rmodal', onclick: (e) => { if (e.target === m) m.remove(); } }, box);
    document.body.append(m);
    return m;
  }

  async function showLog(name) {
    const t = (await fs.read(jp(name, 'State/log.jsonl'))) || '';
    const rows = t.split('\n').filter(Boolean).slice(-40).reverse().map((l) => {
      try {
        const o = JSON.parse(l);
        const { t: at, ev, ...rest } = o;
        const d = new Date(at);
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return `${hm} ${ev} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
      } catch (_) { return l; }
    });
    const m = modal(
      el('b', { text: `Log: ${name}` }),
      el('pre', { class: 'rlog', text: rows.join('\n') || 'Belum ada catatan.' }),
      el('button', { type: 'button', class: 'btn sm', text: 'Tutup', onclick: () => m.remove() }),
    );
  }

  function newProjectForm() {
    if (!accounts.length) { toast('Tambahkan akun dulu.'); return; }
    const nameIn = el('input', { placeholder: 'Nama proyek (huruf, angka, - atau _)', autocomplete: 'off', maxlength: '40' });
    const briefIn = el('textarea', { rows: '7', placeholder: 'Brief proyek: apa yang mau dibuat, teknologi, aturan penting. Semakin jelas semakin baik.' });
    const order = accounts.map((a) => ({ a, on: a.status !== 'working' }));
    const poolEl = el('div', { class: 'rpool' });
    const paint = () => {
      poolEl.replaceChildren(...order.map((o, i) => el('div', { class: 'rpick' },
        el('label', {}, el('input', { type: 'checkbox', checked: o.on ? 'checked' : null, onchange: (e) => { o.on = e.target.checked; } }), el('span', { text: ` ${i + 1}. ${shortName(o.a.name)}${o.a.status === 'working' ? ' (limit)' : ''}` })),
        el('span', {},
          el('button', { type: 'button', class: 'btn-g rmv', text: '▲', onclick: () => { if (i > 0) { [order[i - 1], order[i]] = [order[i], order[i - 1]]; paint(); } } }),
          el('button', { type: 'button', class: 'btn-g rmv', text: '▼', onclick: () => { if (i < order.length - 1) { [order[i + 1], order[i]] = [order[i], order[i + 1]]; paint(); } } }),
        ),
      )));
    };
    paint();
    const errEl = el('div', { class: 'hint2 rerr' });
    const m = modal(
      el('b', { text: 'Proyek baru' }), nameIn, briefIn,
      el('div', { class: 'hint2', text: 'Akun yang dipakai, urutan = prioritas. Akun limit atau belum login dilewati.' }), poolEl, errEl,
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: 'Batal', onclick: () => m.remove() }),
        el('button', {
          type: 'button', class: 'btn sm rb', text: 'Buat',
          onclick: async () => {
            const name = RC.safeName(nameIn.value);
            const brief = briefIn.value.trim();
            const pool = order.filter((o) => o.on).map((o) => o.a.id);
            if (!name) { errEl.textContent = 'Nama proyek kosong atau tidak valid.'; return; }
            if (brief.length < 20) { errEl.textContent = 'Brief terlalu pendek.'; return; }
            if (!pool.length) { errEl.textContent = 'Pilih minimal satu akun.'; return; }
            try { await createProject(name, brief, pool); } catch (e) { errEl.textContent = String((e && e.message) || e); return; }
            m.remove();
            await refreshJobs();
            toast(`Proyek "${name}" dibuat. Ketuk ▶ Mulai.`);
          },
        }),
      ),
    );
  }

  function dumpForm() {
    const urlIn = el('input', { placeholder: 'https://claude.ai/chat/...', autocomplete: 'off' });
    const sel = el('select', { class: 'tsel' }, ...accounts.map((a) => el('option', { value: a.id, text: shortName(a.name) })));
    const outEl = el('pre', { class: 'rlog', text: 'Pilih akun pemilik chat, tempel alamat chat yang terpotong limit, lalu Ambil.' });
    const m = modal(
      el('b', { text: 'Uji: ambil data percakapan' }),
      el('div', { class: 'hint2', text: 'Hasilnya disalin ke folder Download (dump-....json). Dari sini terlihat apakah kode sandbox, file, dan teks sebelum limit tersimpan di server.' }),
      sel, urlIn, outEl,
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: 'Tutup', onclick: () => m.remove() }),
        el('button', { type: 'button', class: 'btn sm rb', text: 'Ambil', onclick: () => dumpChat(sel.value, urlIn.value.trim(), (t) => { outEl.textContent = t; }) }),
      ),
    );
  }

  function openDrawer() { if (!drawer) return; refreshJobs(); backdrop.classList.add('show'); drawer.classList.add('open'); }
  function closeDrawer() { if (!drawer) return; backdrop.classList.remove('show'); drawer.classList.remove('open'); }

  function build() {
    backdrop = el('div', { class: 'rbackdrop', onclick: closeDrawer });
    listEl = el('div', { class: 'rlist' });
    drawer = el('aside', { class: 'rdrawer', 'aria-label': 'Proyek estafet' },
      el('div', { class: 'hhead' },
        el('span', { class: 'htitle', text: 'Proyek estafet' }),
        el('button', { type: 'button', class: 'hx', text: '✕', 'aria-label': 'Tutup', onclick: closeDrawer }),
      ),
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn sm rb', text: '+ Proyek baru', onclick: newProjectForm }),
        el('button', { type: 'button', class: 'btn-g rb', text: '🔬 Uji chat', onclick: dumpForm }),
      ),
      listEl,
    );
    document.body.append(backdrop, drawer);
    // Tombol pembuka: di bawah baris alat (Cek akun, Auto cek, 🎣, 🌙)
    const mount = () => {
      const anchor = document.querySelector('.autohint') || document.querySelector('.tools');
      if (!anchor || document.getElementById('relayBtn')) return !!anchor;
      anchor.after(el('button', { id: 'relayBtn', type: 'button', class: 'tbtn relaybtn', text: '📁 Proyek estafet', onclick: openDrawer }));
      return true;
    };
    let tries = 0;
    const t = setInterval(() => { if (mount() || ++tries > 40) clearInterval(t); }, 250);
    renderList();
  }

  async function init() {
    build();
    if (!ready()) return;
    try {
      if (P.LocalNotifications) P.LocalNotifications.addListener('localNotificationActionPerformed', (ev) => {
        const x = (ev.notification && ev.notification.extra) || {};
        if (x.kind === 'relay' && x.project) runJob(x.project);
      });
    } catch (_) {}
    // Job yang terputus karena aplikasi ditutup: tandai supaya jelas. Job yang menunggu limit: pasang lagi pewaktu dan notifikasinya.
    const names = (await fs.dirs('')).filter((n) => !n.startsWith('_'));
    for (const n of names) {
      const j = await loadJob(n);
      if (!j) continue;
      if (j.status === 'running') { j.status = 'queued'; j.error = 'Terputus (aplikasi tertutup). Ketuk Lanjut.'; await saveJob(j); }
      else if (j.status === 'waiting_limit') armWake(j);
    }
    await refreshJobs();
  }

  window.Relay = { runJob, createProject, refreshJobs, dumpChat };
  if (window.Auth && Auth.ready) Auth.ready.then(() => setTimeout(init, 300)); else setTimeout(init, 1500);
})();
