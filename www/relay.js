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

  const STEP_TIMEOUT = 40 * 60 * 1000;   // ms: batas MUTLAK satu tahap (sejak halaman siap). Tahap yang masih jalan tidak boleh dipotong lalu diulang dari awal; macet dideteksi terpisah (why:stuck)
  const PLAN_TIMEOUT = 6 * 60 * 1000;
  const DUMP_TIMEOUT = 120000;
  const MAX_TRIES = 3;                   // langkah yang selesai dijawab tapi file hasilnya tetap tidak lengkap: menyerah setelah ini
  const MAX_FAILS = 2;                   // gagal berturut-turut di satu akun sebelum akun itu dilewati
  const WAIT_COND_MS = 10 * 60 * 1000;   // syarat Wi-Fi / charging belum terpenuhi: cek lagi lewat alarm (bukan polling)
  const KEEP_CHATS = 2;                  // chat estafet yang disimpan per akun di claude.ai; yang lebih lama dihapus
  const RAW_KEEP = 8;                    // jumlah balasan mentah terakhir yang disimpan per proyek

  const STATUS_LABEL = {
    queued: 'Antre', running: 'Berjalan', waiting_limit: 'Menunggu limit', waiting_login: 'Perlu login',
    waiting_cond: 'Menunggu Wi-Fi/charging', waiting_manual: 'Perlu bantuan manual',
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
  const saveJob = (job) => {
    RC.timerTick(job, Date.now());
    const i = jobs.findIndex((x) => x.name === job.name);
    if (i >= 0) jobs[i] = job;   // tampilan (chat.js) membaca daftar ini: timer ikut hidup
    return fs.write(jp(job.name, 'State/job.json'), JSON.stringify(job, null, 1));
  };
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
  // Menunggu reset: tanpa polling. Hanya satu pewaktu JS (kalau aplikasi hidup) + alarm sistem (membangunkan walau layar mati / app ditutup).
  function armWake(job) {
    clearTimeout(wakers.get(job.name));
    wakers.delete(job.name);
    const waitingJob = (job.status === 'waiting_limit' || job.status === 'waiting_cond') && job.waitUntil;
    if (!waitingJob) { waiting.delete(job.name); try { const G = g(); if (G && G.relayAlarm) G.relayAlarm({ project: job.name, at: 0 }).catch(() => {}); } catch (_) {} return; }
    if (job.status === 'waiting_limit') waiting.set(job.name, job.waitUntil); else waiting.delete(job.name);
    const ms = Math.max(1000, job.waitUntil - Date.now() + 3000);
    if (ms < 2147000000) wakers.set(job.name, setTimeout(() => { wakers.delete(job.name); runJob(job.name); }, ms));
    try { const G = g(); if (G && G.relayAlarm) G.relayAlarm({ project: job.name, at: job.waitUntil + 3000 }).catch(() => {}); } catch (_) {}
    if (typeof scheduleAll === 'function') scheduleAll();
  }

  // Layanan latar depan: wake = true hanya saat tahap aktif; saat menunggu cukup notifikasi persisten.
  function keepOn(wake, text) { try { const G = g(); if (G && G.keepAlive) G.keepAlive({ on: true, wake: !!wake, text: text || '' }).catch(() => {}); } catch (_) {} }
  function keepOff() {
    try {
      const G = g();
      const want = !!(typeof settings !== 'undefined' && settings.firstDone && (settings.autoMin || settings.quietOn));
      const anyWait = jobs.some((j) => j.status === 'waiting_limit' || j.status === 'waiting_cond');
      if (anyWait) keepOn(false, 'Menunggu reset limit (hemat baterai)');
      else if (!want && G && G.keepAlive) G.keepAlive({ on: false }).catch(() => {});
    } catch (_) {}
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

  // ---------- Hapus chat lama ----------
  // Tiap langkah membuat chat baru di claude.ai. Paket serah-terima dibuat dari penyimpanan aplikasi (progress.md, file Out), bukan dari
  // chat lama, jadi chat yang sudah selesai tidak dibaca lagi. Yang disimpan hanya KEEP_CHATS terbaru per akun, sisanya dihapus lewat sesi tersembunyi.
  // Daftar chat disimpan di _chats/registry.json: { idAkun: [{url, at, project, fails}] }.
  const CHAT_RE = /^https:\/\/claude\.ai\/chat\/[0-9a-f-]{36}/i;
  async function loadReg() { try { const t = await fs.read('_chats/registry.json'); return t ? JSON.parse(t) : {}; } catch (_) { return {}; } }
  async function trimChats(run, a, url, project) {
    const G = g();
    const reg = await loadReg();
    const list = reg[a.id] = reg[a.id] || [];
    const m = CHAT_RE.exec(url || '');
    if (m && !list.some((x) => x.url === m[0])) list.push({ url: m[0], at: Date.now(), project, fails: 0 });
    list.sort((x, y) => x.at - y.at);
    while (list.length > KEEP_CHATS && !run.cancel) {
      const old = list[0];
      let dr;
      try { dr = await G.bait({ accountId: a.id, url: old.url, mode: 'delete', timeoutMs: 150000 }); }
      catch (e) { dr = { state: 'fail' }; }
      if (dr.error === 'cancel' || dr.error === 'busy' || run.cancel) break;
      if (dr.state === 'deleted') { list.shift(); await logEv(project, 'chat-del', { account: a.name }); continue; }
      // Gagal (mis. chat sudah dihapus manual, atau halaman belum siap): coba lagi di langkah berikutnya, menyerah setelah 3 kali
      old.fails = (old.fails || 0) + 1;
      await logEv(project, 'chat-del-fail', { account: a.name, try: old.fails, why: typeof baitWhy === 'function' ? baitWhy(dr.text) : '' });
      if (old.fails >= 3) { list.shift(); continue; }
      break;
    }
    await fs.write('_chats/registry.json', JSON.stringify(reg));
  }

  // ---------- Prompt ----------
  // File lampiran proyek (In/, selain brief.md). Hanya teks yang ditempel ke prompt; zip/biner dilampirkan sebagai file di tahap 1 (lihat attachmentsFor).
  const BIN_RE = /\.(zip|glb|gltf|pmx|vrm|fbx|png|jpe?g|gif|webp|mp4|mp3|wav|ttf|otf|woff2?)$/i;
  async function readInFiles(name) {
    const out = [];
    for (const f of await fs.list(jp(name, 'In'))) {
      if (f.path === 'brief.md' || BIN_RE.test(f.path)) continue;
      const c = await fs.read(jp(name, 'In/' + f.path));
      if (c != null) out.push({ path: f.path, content: c });
    }
    return out;
  }
  // Lampiran yang diunggah ke chat tahap ini (path relatif terhadap Projects). Tahap N>1: hanya zip tahap sebelumnya. Tahap 1: zip dari In/.
  async function attachmentsFor(job, cur) {
    if (cur.kind !== 'step') return [];
    if (cur.index > 0) return [jp(job.name, 'Out/' + job.plan.steps[cur.index - 1].zip)];
    const ins = (await fs.list(jp(job.name, 'In'))).filter((f) => /\.zip$/i.test(f.path)).slice(0, RC.MAX_ATTACH);
    return ins.map((f) => jp(job.name, 'In/' + f.path));
  }
  function hintFor(job) { return RC.budgetHint(job.stats); }
  const maxStages = () => RC.clampSteps((typeof settings !== 'undefined' && settings.maxStages) || RC.MAX_STEPS);
  async function promptFor(job, cur) {
    if (cur.kind === 'plan') return RC.buildPlanPrompt(await fs.read(jp(job.name, 'In/brief.md')) || '', await readInFiles(job.name), { maxSteps: maxStages(), hint: hintFor(job) });
    if (cur.kind === 'split') return RC.buildSplitPrompt(job.plan, cur.index, job.split && job.split.why, Math.max(2, Math.min(5, maxStages() - job.plan.steps.length + 1)));
    return RC.buildStepPrompt({
      plan: job.plan, step: cur.step, index: cur.index, inFiles: await readInFiles(job.name), hint: hintFor(job),
      prevZip: cur.index > 0 ? job.plan.steps[cur.index - 1].zip : '',
      progress: RC.buildProgress(job.name, job.plan, job.steps), brief: await fs.read(jp(job.name, 'In/brief.md')) || '',
    });
  }
  const writeProgress = (job) => fs.write(jp(job.name, 'State/progress.md'), RC.buildProgress(job.name, job.plan, job.steps));

  function curStep(job) {
    if (!job.plan) return { kind: 'plan' };
    if (job.split && job.split.go) return { kind: 'split', index: job.split.index };
    for (let i = 0; i < job.plan.steps.length; i++) {
      const s = job.plan.steps[i];
      if ((job.steps[s.id] || {}).status !== 'done') return { kind: 'step', step: s, index: i };
    }
    return null;
  }

  // ---------- Satu putaran job ----------
  let running = null;   // {name, cancel}

  async function deviceOk() {
    if (typeof settings === 'undefined' || !(settings.relayWifi || settings.relayCharge)) return '';
    try {
      const d = await g().deviceState();
      if (settings.relayWifi && !d.wifi) return 'menunggu Wi-Fi';
      if (settings.relayCharge && !d.charging) return 'menunggu charger';
    } catch (_) { /* tidak bisa membaca: jangan menahan */ }
    return '';
  }

  async function askBatteryOnce() {
    try {
      if (typeof settings === 'undefined' || settings.battAsked) return;
      const st = await g().bgStatus();
      settings.battAsked = true;
      if (typeof saveSettings === 'function') saveSettings();
      if (st && st.battery === false) {
        toast('Izinkan aplikasi diabaikan dari penghematan baterai supaya estafet jalan saat HP tidur.', 8000);
        await g().bgOpen({ what: 'battery' });
      }
    } catch (_) { /* abaikan */ }
  }

  async function runJob(name) {
    if (running) { toast('Ada proyek lain yang sedang berjalan.'); return; }
    const G = g();
    if (!ready()) { toast('Butuh APK versi terbaru (fitur estafet belum ada di APK ini).'); return; }
    { const j0 = await loadJob(name); if (j0 && !j0.plan) { const b0 = await fs.read(jp(name, 'In/brief.md')); if (!b0 || b0.trim().length < 20) { toast('Tulis brief proyek di kolom chat dulu (minimal 20 karakter).', 6000); return; } } }
    if (typeof checking !== 'undefined' && (checking || (typeof resumeBusy !== 'undefined' && resumeBusy))) { toast('Tunggu pengecekan akun selesai dulu.'); return; }
    const run = { name, cancel: false };
    running = run;
    checking = true;   // cegah cek otomatis memakai sesi tersembunyi selama job (satu sesi GeckoView hidup sekali)
    await askBatteryOnce();
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
      await refreshJobs();
      keepOff();
    }
  }

  async function loop(run) {
    const name = run.name;
    const G = g();
    let job = await loadJob(name);
    if (!job) throw new Error('job.json tidak ditemukan');
    job.stats = job.stats || { runs: [], streak: {} };
    job.stageFails = job.stageFails || {};
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
        job.status = 'done'; await saveJob(job);
        { const v = RC.timerView(job, Date.now()); await logEv(name, 'done', v ? { total: v.total, work: v.work, wait: v.wait } : {}); }
        await notifyNow(`Proyek "${name}" selesai`, 'Semua tahap sudah dikerjakan. Zip terakhir = hasil akhir.', name);
        return;
      }
      const cond = await deviceOk();
      if (cond) {
        job.status = 'waiting_cond'; job.waitUntil = Date.now() + WAIT_COND_MS; job.error = 'Syarat belum terpenuhi: ' + cond;
        await saveJob(job); await logEv(name, 'wait-cond', { why: cond });
        armWake(job);
        return;
      }
      const pick = RC.pickAccount(accounts, job.pool, Date.now(), skip);
      if (pick.wait) {
        job.status = 'waiting_limit'; job.waitUntil = pick.wait; await saveJob(job);
        await logEv(name, 'wait-limit', { until: new Date(pick.wait).toISOString() });
        armWake(job);
        await notifyNow(`Semua akun limit`, `Proyek "${name}" dilanjutkan otomatis jam ${atShort(new Date(pick.wait).toISOString())}.`, name);
        return;
      }
      if (pick.none) {
        job.status = 'waiting_login'; job.error = 'Tidak ada akun di pool yang bisa dipakai (belum login atau gagal berulang).';
        await saveJob(job); await logEv(name, 'no-account');
        await notifyNow(`Proyek "${name}" berhenti`, 'Tidak ada akun yang bisa dipakai. Cek login akun.', name);
        return;
      }
      const a = pick.account;
      const tag = cur.kind === 'step' ? cur.step.id : cur.kind;
      const prompt = await promptFor(job, cur);
      let uploads = [];
      try { uploads = await attachmentsFor(job, cur); } catch (_) { uploads = []; }
      if (cur.kind === 'step' && cur.index > 0 && !(await fs.list(jp(name, 'Out'))).some((f) => f.path === job.plan.steps[cur.index - 1].zip)) {
        // zip tahap sebelumnya hilang (dihapus): tahap itu diulang
        const prev = job.plan.steps[cur.index - 1];
        job.steps[prev.id] = { status: 'pending', got: [] };
        await logEv(name, 'zip-missing', { zip: prev.zip });
        continue;
      }
      job.lastAccount = a.name; job.status = 'running'; job.current = tag;
      await saveJob(job);
      keepOn(true, `Mengerjakan ${tag} · ${shortName(a.name)}`);
      await logEv(name, 'send', { tag, account: a.name, chars: prompt.length, attach: uploads.length });
      renderList();

      let res;
      const t0 = Date.now();
      try {
        res = await G.bait({
          accountId: a.id, url: CLAUDE_URL, mode: 'work', command: prompt, uploads,
          expect: cur.kind === 'step' ? cur.step.zip : '', timeoutMs: cur.kind === 'step' ? STEP_TIMEOUT : PLAN_TIMEOUT,
        });
      } catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
      res.ms = Date.now() - t0;
      if (res.error === 'cancel' || run.cancel) break;
      if (res.error === 'busy') {
        job.status = 'queued'; job.error = 'Sesi tersembunyi sedang dipakai proses lain. Coba lagi sebentar.';
        await saveJob(job); return;
      }
      const verdict = await handleResult(job, cur, tag, a, res, skip, fails);
      await saveJob(job);
      if (res.state !== 'loggedout') { try { await trimChats(run, a, res.url, name); } catch (_) {} }
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

  // ---------- Pengukuran jatah ----------
  // Hitung tahap yang selesai berturut-turut oleh satu akun. Saat akun itu kena limit, satu "putaran" dicatat: itulah ukuran jatah akun.
  function countDone(job, a) { job.stats.streak[a.id] = (job.stats.streak[a.id] || 0) + 1; }
  function endRun(job, a) {
    const done = job.stats.streak[a.id] || 0;
    job.stats.streak[a.id] = 0;
    job.stats.runs.push({ acc: a.id, done, limited: true, at: Date.now() });
    if (job.stats.runs.length > 30) job.stats.runs.shift();
    return done;
  }

  // Pindahkan zip hasil dari _incoming ke Out/<zip tahap>. Hanya yang benar-benar zip (awalan PK) dan tidak kosong yang diterima.
  async function takeZip(job, step, res) {
    const dl = (Array.isArray(res.downloads) ? res.downloads : []).filter((d) => d && d.zip && d.size > 100);
    if (!dl.length) return false;
    const base = step.zip.replace(/\.zip$/i, '').toLowerCase();
    const pick = dl.filter((d) => String(d.name || '').toLowerCase().includes(base)).pop() || dl[dl.length - 1];
    await g().projMove({ from: pick.path, to: jp(job.name, 'Out/' + step.zip) });
    for (const d of dl) if (d !== pick) await fs.del(d.path).catch(() => {});
    await logEv(job.name, 'zip', { zip: step.zip, from: pick.name, size: pick.size });
    return true;
  }

  // Memproses hasil satu percobaan. Mengembalikan 'stop' kalau job harus berhenti, selain itu lanjut ke putaran berikutnya.
  async function handleResult(job, cur, tag, a, res, skip, fails) {
    const name = job.name;
    const state = res.state || 'fail';
    const text = bestText(res);
    const why = typeof baitWhy === 'function' ? baitWhy(res.text) : '';

    // Timer: lama percobaan ini ditambahkan ke tahap (atau ke rencana)
    if (cur.kind === 'step') { const s0 = job.steps[cur.step.id] = job.steps[cur.step.id] || { status: 'pending', got: [] }; s0.ms = (s0.ms || 0) + (res.ms || 0); }
    else job.planMs = (job.planMs || 0) + (res.ms || 0);

    // Simpan jejak mentah (balasan + data percakapan) untuk diperiksa. Yang lama dibuang.
    job.seq = (job.seq || 0) + 1;
    job.raw = job.raw || [];
    if (text) { await fs.write(jp(name, `State/raw/${tag}-${job.seq}.md`), text); job.raw.push(`State/raw/${tag}-${job.seq}.md`); }
    if (res.data) { await fs.write(jp(name, `State/raw/${tag}-${job.seq}.json`), res.data); job.raw.push(`State/raw/${tag}-${job.seq}.json`); }
    while (job.raw.length > RAW_KEEP * 2) await fs.del(jp(name, job.raw.shift())).catch(() => {});
    await logEv(name, 'result', { tag, account: a.name, ms: res.ms || 0, state, sent: !!res.sent, chars: text.length, dl: (res.downloads || []).length, timedOut: !!res.timedOut, why, cards: String(res.cards || '').slice(0, 300), diag: String(res.diag || '').slice(0, 300) });

    if (state === 'loggedout') {
      skip.add(a.id);
      if (typeof noteCheck === 'function') noteCheck(a, 'loggedout', Date.now());
      return 'next';
    }
    if (state === 'limit') { markLimit(a, res.text, res.url); endRun(job, a); }
    if (state === 'fail' && /^why:challenge/.test(String(res.text || ''))) skip.add(a.id);

    // Lampiran gagal terpasang: bukan salah akun. Dua kali berturut-turut -> jalur manual (user pilih file sekali).
    if (res.upload) {
      job.uploadFails = (job.uploadFails || 0) + 1;
      if (job.uploadFails >= 2) return manual(job, cur, a, 'Lampiran otomatis gagal: ' + String(res.upload).slice(0, 160));
      return 'next';
    }
    job.uploadFails = 0;

    // Gagal tanpa hasil apa pun dan tanpa prompt terkirim (halaman tidak siap dsb.)
    if (state === 'fail' && !text && !res.sent) {
      const n = (fails.get(a.id) || 0) + 1;
      fails.set(a.id, n);
      if (n >= MAX_FAILS) skip.add(a.id);
      job.tries = job.tries || {};
      job.tries[tag + ':fail'] = (job.tries[tag + ':fail'] || 0) + 1;
      if (job.tries[tag + ':fail'] >= MAX_TRIES * 2) return fail(job, `Gagal terus di ${tag}: ${why || 'tidak diketahui'}`);
      return 'next';
    }
    fails.delete(a.id);

    const counted = state !== 'limit';

    // ---- Rencana ----
    if (cur.kind === 'plan') {
      const r = RC.parsePlan(text, maxStages());
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
        await logEv(name, 'plan-bad', { err: r.err, try: job.tries.plan, head: text.slice(0, 140), tail: text.slice(-100) });
        if (job.tries.plan >= MAX_TRIES) return fail(job, 'Rencana gagal dibuat ' + MAX_TRIES + 'x: ' + r.err);
      }
      return 'next';
    }

    // ---- Pecah tahap ----
    if (cur.kind === 'split') {
      const r = RC.applySplit(job.plan, cur.index, text, maxStages());
      if (r.ok) {
        const old = job.steps; const steps = {};
        r.plan.steps.forEach((s, i) => { const prev = i < cur.index ? old['s' + (i + 1)] : null; steps[s.id] = prev || { status: 'pending', got: [] }; });
        job.plan = r.plan; job.steps = steps; job.split = null; job.stageFails = {}; job.tries = {};
        await fs.write(jp(name, 'State/plan.json'), JSON.stringify(r.plan, null, 1));
        await writeProgress(job);
        await logEv(name, 'split-ok', { steps: r.plan.steps.length });
        return 'next';
      }
      job.tries = job.tries || {};
      job.tries.split = (job.tries.split || 0) + (counted ? 1 : 0);
      job.error = 'Pecahan belum valid: ' + r.err;
      if (job.tries.split >= MAX_TRIES) { job.split = null; return fail(job, 'Tahap gagal dipecah: ' + r.err); }
      return 'next';
    }

    // ---- Tahap: berhasil kalau zip hasil sudah diunduh ----
    const st = job.steps[cur.step.id] = job.steps[cur.step.id] || { status: 'pending', got: [] };
    let got = false;
    try { got = await takeZip(job, cur.step, res); } catch (e) { await logEv(name, 'zip-err', { msg: String((e && e.message) || e) }); }
    // Balasan selesai tapi zip belum terunduh: coba ambil lagi dari chat yang sama (tanpa kirim ulang prompt, jatah akun tidak terbuang)
    if (!got && (state === 'done' || state === 'paused') && CHAT_RE.test(res.url || '')) {
      try {
        const r2 = await g().bait({ accountId: a.id, url: res.url, mode: 'collect', expect: cur.step.zip, timeoutMs: 120000 });
        await logEv(name, 'collect', { tag, state: r2.state, dl: (r2.downloads || []).length, cards: String(r2.cards || '').slice(0, 400) });
        got = await takeZip(job, cur.step, r2);
        if (!got && r2.cards) res.cards = r2.cards;
      } catch (e) { await logEv(name, 'zip-err', { msg: String((e && e.message) || e) }); }
    }
    if (got) {
      st.status = 'done'; st.doneAt = Date.now(); st.accountId = a.id;
      const note = RC.extractState(text);
      if (note) st.note = note;
      job.stageFails[cur.step.id] = [];
      countDone(job, a);
      await writeProgress(job);
      await logEv(name, 'step-done', { tag, account: a.name, ms: st.ms || 0 });
      return 'next';
    }

    // Tidak ada zip. Kalau prompt sudah terkirim, ini tahap yang gagal di akun ini (jatah terbuang).
    if (res.sent) {
      const list = job.stageFails[cur.step.id] = job.stageFails[cur.step.id] || [];
      list.push(a.id);
      await logEv(name, 'stage-fail', { tag, account: a.name, n: list.length, state });
      // Anti-buang akun: gagal di 2 akun berbeda berturut-turut -> berhenti, jangan ke akun ketiga
      if (RC.shouldStopStage(list)) {
        job.split = { index: cur.index, why: `${tag} gagal di 2 akun berturut-turut (${state})`, go: false };
        return fail(job, `Tahap ${tag} gagal di 2 akun berturut-turut tanpa zip. Berhenti supaya akun lain tidak terbuang. Saran: ketuk "✂ Pecah tahap" agar tahap ini dibagi lebih kecil.`);
      }
    }
    if (state !== 'limit') {
      job.tries = job.tries || {};
      job.tries[tag] = (job.tries[tag] || 0) + 1;
      job.error = `Tahap ${tag} selesai dijawab tapi zip tidak terunduh${res.cards ? ' (' + String(res.cards).slice(0, 120) + ')' : ''}`;
      await logEv(name, 'no-zip', { tag, try: job.tries[tag] });
      if (job.tries[tag] >= MAX_TRIES) return fail(job, `Tahap ${tag}: zip tidak terunduh ${MAX_TRIES}x. ${job.error}`);
    }
    return 'next';
  }

  async function fail(job, msg) {
    job.status = 'failed'; job.error = msg;
    await logEv(job.name, 'failed', { msg });
    await notifyNow(`Proyek "${job.name}" gagal`, msg, job.name);
    return 'stop';
  }

  // Jalur manual: lampiran otomatis gagal. Browser aplikasi dibuka di chat baru, lampiran sudah disiapkan: user cukup ketuk "+" lalu pilih
  // "Tambah file" (apa pun yang dipilih, aplikasi menjawab pemilih file dengan zip tahap sebelumnya), kirim prompt (sudah disalin), tunggu selesai,
  // lalu ketuk "Ambil hasil" di kartu proyek.
  async function manual(job, cur, a, why) {
    job.status = 'waiting_manual'; job.error = why;
    job.manual = { tag: cur.kind === 'step' ? cur.step.id : cur.kind, accountId: a.id };
    await logEv(job.name, 'manual', { why });
    try {
      const prompt = await promptFor(job, cur);
      const up = await attachmentsFor(job, cur);
      await g().setUploads({ uploads: up });
      await openAccount(a, prompt, CLAUDE_URL, false);
    } catch (e) { await logEv(job.name, 'manual-err', { msg: String((e && e.message) || e) }); }
    await notifyNow(`Proyek "${job.name}" butuh bantuan`, 'Lampiran otomatis gagal. Ikuti langkah di browser aplikasi.', job.name);
    return 'stop';
  }

  // Ambil zip dari chat terakhir di browser aplikasi (setelah jalur manual selesai)
  async function collectManual(name) {
    if (running) { toast('Ada proyek yang sedang berjalan.'); return; }
    const job = await loadJob(name);
    if (!job || !job.plan) { toast('Rencana belum ada.'); return; }
    const cur = curStep(job);
    if (!cur || cur.kind !== 'step') { toast('Tidak ada tahap yang menunggu.'); return; }
    let url = '';
    try { url = (await g().lastChatUrl()).url || ''; } catch (_) {}
    if (!CHAT_RE.test(url)) { toast('Belum ada chat yang terbaca. Buka dulu chat tahap ini di browser aplikasi.', 6000); return; }
    const acc = accounts.find((x) => x.id === (job.manual && job.manual.accountId)) || accounts[0];
    checking = true;
    let res;
    try { res = await g().bait({ accountId: acc.id, url, mode: 'collect', expect: cur.step.zip, timeoutMs: 120000 }); }
    catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
    finally { checking = false; }
    let ok = false;
    try { ok = await takeZip(job, cur.step, res); } catch (_) {}
    if (ok) {
      job.steps[cur.step.id] = { status: 'done', got: [], doneAt: Date.now(), accountId: acc.id, ms: (job.steps[cur.step.id] || {}).ms || 0 };
      job.status = 'queued'; job.error = ''; job.manual = null; job.stageFails = {};
      await writeProgress(job); await saveJob(job); await logEv(name, 'step-done', { tag: cur.step.id, account: acc.name, via: 'manual' });
      toast('Zip diambil. Ketuk Lanjut untuk tahap berikutnya.', 6000);
    } else toast('Zip belum terunduh: ' + ((typeof baitWhy === 'function' && baitWhy(res.text)) || res.state || ''), 8000);
    await refreshJobs();
  }

  // Pecah tahap yang gagal di 2 akun menjadi tahap lebih kecil (satu balasan teks berisi JSON), lalu lanjut seperti biasa
  async function splitStage(name) {
    const job = await loadJob(name);
    if (!job || !job.split) { toast('Tidak ada tahap yang perlu dipecah.'); return; }
    if (job.plan.steps.length >= maxStages()) { toast(`Sudah ${job.plan.steps.length} tahap (batas ${maxStages()}). Naikkan batas di Pengaturan estafet, atau tunggu reset / pakai akun berbayar.`, 8000); return; }
    job.split.go = true; job.status = 'queued'; job.error = ''; job.stageFails = {};
    await saveJob(job);
    await runJob(name);
  }

  // ---------- Proyek: buat, hapus, ekspor ----------
  async function createProject(name, brief, pool) {
    const dirs = await fs.dirs('');
    if (dirs.includes(name)) throw new Error('Nama proyek sudah dipakai');
    if (brief) await fs.write(jp(name, 'In/brief.md'), brief);
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
    try { window.dispatchEvent(new Event('relaychange')); } catch (_) {}
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
    if (j.plan) info.push(`Tahap ${done}/${total}${cur ? ` · berikutnya: ${cur.title}` : ''}`);
    else info.push('Rencana belum dibuat');
    { const m = RC.measure(j.stats); if (m.known) info.push(`Jatah terukur: ±${m.avg.toFixed(1)} tahap per akun (${m.n} akun limit)`); }
    info.push(...RC.timeLines(j, Date.now()));
    if (j.lastAccount) info.push(`Akun terakhir: ${shortName(j.lastAccount)}`);
    if (j.error && j.status !== 'done') info.push(j.error);
    const bar = el('div', { class: 'rbar' }, el('i', { style: `width:${total ? Math.round((done / total) * 100) : 0}%` }));
    const btns = [];
    if (isRun) btns.push(el('button', { type: 'button', class: 'btn-g rb', text: '■ Batal', onclick: () => cancelRun() }));
    else if (j.status !== 'done') btns.push(el('button', { type: 'button', class: 'btn sm rb', text: j.plan || j.status !== 'queued' ? '▶ Lanjut' : '▶ Mulai', onclick: () => runJob(j.name) }));
    if (!isRun && j.split && j.status === 'failed') btns.push(el('button', { type: 'button', class: 'btn sm rb', text: '✂ Pecah tahap', onclick: () => splitStage(j.name) }));
    if (!isRun && j.status === 'waiting_manual') btns.push(el('button', { type: 'button', class: 'btn sm rb', text: '📥 Ambil hasil', onclick: () => collectManual(j.name) }));
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
    const tl = RC.timeLines(await loadJob(name), Date.now());
    const rows = t.split('\n').filter(Boolean).slice(-40).reverse().map((l) => {
      try {
        const o = JSON.parse(l);
        const { t: at, ev, ...rest } = o;
        for (const k of ['ms', 'total', 'work', 'wait']) if (typeof rest[k] === 'number') { rest[k] = RC.fmtDur(rest[k]); }
        const d = new Date(at);
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        return `${hm} ${ev} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
      } catch (_) { return l; }
    });
    const m = modal(
      el('b', { text: `Log: ${name}` }),
      el('pre', { class: 'rlog', text: (tl.length ? tl.join('\n') + '\n\n' : '') + (rows.join('\n') || 'Belum ada catatan.') }),
      el('button', { type: 'button', class: 'btn sm', text: 'Tutup', onclick: () => m.remove() }),
    );
  }

  // Form proyek baru: hanya judul dan akun. Brief ditulis nanti di kolom chat halaman proyek (halaman estafet), bukan di sini.
  // Akun dipilih dengan mengetuk gelembungnya. Angka di gelembung = urutan prioritas = urutan ketukan.
  // onCreated(nama) dipanggil setelah proyek dibuat.
  function newProjectForm(onCreated) {
    if (!accounts.length) { toast('Tambahkan akun dulu.'); return; }
    const nameIn = el('input', { placeholder: 'Judul proyek (huruf, angka, - atau _)', autocomplete: 'off', maxlength: '40' });
    // pool = id akun yang dicentang, urut sesuai ketukan. Awalnya semua akun yang tidak limit, urut daftar.
    let pool = accounts.filter((a) => a.status !== 'working').map((a) => a.id);
    const poolEl = el('div', { class: 'rpool' });
    const paint = () => {
      poolEl.replaceChildren(...accounts.map((a) => {
        const i = pool.indexOf(a.id);
        const on = i >= 0;
        return el('button', {
          type: 'button', class: `rchip ${on ? 'on' : ''}`, 'aria-pressed': on ? 'true' : 'false',
          onclick: () => { if (on) pool = pool.filter((x) => x !== a.id); else pool.push(a.id); paint(); },
        },
          el('span', { class: 'rnum', text: on ? String(i + 1) : '' }),
          el('span', { class: 'rnm', text: shortName(a.name) + (a.status === 'working' ? ' (limit)' : '') }),
        );
      }));
    };
    paint();
    const errEl = el('div', { class: 'hint2 rerr' });
    const m = modal(
      el('b', { text: 'Proyek baru' }), nameIn,
      el('div', { class: 'hint2', text: 'Ketuk akun yang dipakai. Angka = urutan prioritas. Akun limit atau belum login dilewati.' }), poolEl, errEl,
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: 'Batal', onclick: () => m.remove() }),
        el('button', {
          type: 'button', class: 'btn sm rb', text: 'Buat',
          onclick: async () => {
            const name = RC.safeName(nameIn.value);
            if (!name) { errEl.textContent = 'Judul proyek kosong atau tidak valid.'; return; }
            if (!pool.length) { errEl.textContent = 'Pilih minimal satu akun.'; return; }
            try { await createProject(name, '', pool); } catch (e) { errEl.textContent = String((e && e.message) || e); return; }
            m.remove();
            await refreshJobs();
            toast(`Proyek "${name}" dibuat. Tulis brief di kolom chat.`, 5000);
            if (typeof onCreated === 'function') onCreated(name);
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

  // ---------- Uji sebelum dipakai penuh ----------
  // (a) Unggah: lampirkan file uji ke chat baru lewat sentuhan asli + onFilePrompt, TANPA mengirim apa pun.
  // (b) Unduh: buka chat yang punya kartu zip, klik ikon unduh, lihat apakah zip masuk (nama, ukuran, awalan PK).
  async function testTransfer(kind, accountId, url, out) {
    if (!ready()) { out('Butuh APK versi terbaru.'); return; }
    if (running || (typeof checking !== 'undefined' && checking)) { out('Ada proses lain yang berjalan. Tunggu dulu.'); return; }
    checking = true;
    let res;
    try {
      if (kind === 'up') {
        await fs.write('_test/uji-unggah.zip', 'PK-uji-unggah: ini bukan zip sungguhan, hanya file uji.');
        out('Membuka chat baru di belakang layar, menekan "+", memilih file uji...');
        res = await g().bait({ accountId, url: CLAUDE_URL, mode: 'uploadtest', uploads: ['_test/uji-unggah.zip'], timeoutMs: 120000 });
      } else {
        if (!CHAT_RE.test(url)) { out('Alamat harus berbentuk https://claude.ai/chat/... (chat yang punya kartu zip).'); return; }
        out('Membuka chat, mencari kartu zip, mengklik unduh...');
        res = await g().bait({ accountId, url, mode: 'collect', expect: '', timeoutMs: 120000 });
      }
    } catch (e) { res = { state: 'fail', text: 'why:error ' + ((e && e.message) || e) }; }
    finally { checking = false; }
    if (res.error) { out('Gagal: ' + (res.error === 'busy' ? 'sesi tersembunyi sedang dipakai.' : res.error)); return; }
    const lines = [];
    if (kind === 'up') {
      lines.push(res.state === 'uploaded' ? 'BERHASIL: file uji terlampir di chat baru (tidak ada yang dikirim).' : 'GAGAL: ' + String(res.text || res.state).slice(0, 400));
      lines.push('Tampilan sesi: ' + (res.view || '?') + (res.view === 'none' ? ' (tanpa tampilan tersembunyi, sentuhan asli tidak bisa dikirim: beri izin "Tampil di atas aplikasi lain")' : ''));
    } else {
      const dl = Array.isArray(res.downloads) ? res.downloads : [];
      if (res.state === 'collected' && dl.length) {
        for (const d of dl) lines.push(`BERHASIL: ${d.name} · ${Math.round(d.size / 1024)} KB · ${d.zip ? 'zip valid (PK)' : 'BUKAN zip'}`);
        const first = dl.find((d) => d.zip);
        if (first) { try { const r = await g().projExport({ path: first.path, name: 'uji-' + first.name }); lines.push('Disalin ke ' + (r.where || 'Download')); } catch (_) {} }
        for (const d of dl) await fs.del(d.path).catch(() => {});
      } else lines.push('GAGAL: ' + String(res.text || res.state).slice(0, 500));
    }
    if (res.cards) lines.push('Catatan selector: ' + String(res.cards).slice(0, 500));
    if (res.diag) lines.push('Diagnosa: ' + String(res.diag).slice(0, 300));
    out(lines.join('\n'));
  }

  function transferForm() {
    const sel = el('select', { class: 'tsel' }, ...accounts.map((a) => el('option', { value: a.id, text: shortName(a.name) })));
    const urlIn = el('input', { placeholder: 'Uji unduh: tempel https://claude.ai/chat/... (chat dengan kartu zip)', autocomplete: 'off' });
    const outEl = el('pre', { class: 'rlog', text: 'Uji (a) unggah dan (b) unduh. Keduanya memakai akun yang dipilih. Jalankan dulu sebelum proyek besar.' });
    const m = modal(
      el('b', { text: 'Uji file: unggah dan unduh' }), sel, urlIn, outEl,
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn sm rb', text: '(a) Uji unggah', onclick: () => testTransfer('up', sel.value, '', (t) => { outEl.textContent = t; }) }),
        el('button', { type: 'button', class: 'btn sm rb', text: '(b) Uji unduh', onclick: () => testTransfer('down', sel.value, urlIn.value.trim(), (t) => { outEl.textContent = t; }) }),
      ),
      el('button', { type: 'button', class: 'btn-g rb', text: 'Tutup', onclick: () => m.remove() }),
    );
  }

  function settingsForm() {
    if (typeof settings === 'undefined') return;
    const mx = el('input', { type: 'number', min: '1', max: '30', value: String(settings.maxStages || 10), class: 'tsel' });
    const mk = (label, key) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!settings[key];
      return { cb, row: el('label', { class: 'hint2' }, cb, ' ' + label) };
    };
    const w = mk('Jalankan tahap hanya saat tersambung Wi-Fi', 'relayWifi');
    const c = mk('Jalankan tahap hanya saat sedang mengisi daya', 'relayCharge');
    const m = modal(
      el('b', { text: 'Pengaturan estafet' }),
      el('div', { class: 'hint2', text: 'Maksimal tahap per proyek (bawaan 10, tahap dijalankan satu per satu):' }), mx, w.row, c.row,
      el('div', { class: 'hint2', text: 'Saat menunggu reset limit tidak ada polling: hanya alarm sistem dan notifikasi persisten.' }),
      el('div', { class: 'rbtns' },
        el('button', { type: 'button', class: 'btn-g rb', text: 'Batal', onclick: () => m.remove() }),
        el('button', { type: 'button', class: 'btn sm rb', text: 'Simpan', onclick: () => {
          settings.maxStages = RC.clampSteps(mx.value);
          settings.relayWifi = w.cb.checked; settings.relayCharge = c.cb.checked;
          if (typeof saveSettings === 'function') saveSettings();
          m.remove(); toast('Pengaturan estafet disimpan.');
        } }),
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
        el('button', { type: 'button', class: 'btn sm rb', text: '+ Proyek baru', onclick: () => newProjectForm() }),
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
    // Tombol "Proyek estafet" di halaman utama tidak dipasang lagi: estafet dibuka dengan geser ke kiri (lihat chat.js). Slide ini tetap ada di kode.
    void mount;
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
    // Alarm reset berbunyi saat aplikasi hidup
    try { if (g() && g().addListener) g().addListener('relayWake', (ev) => { if (ev && ev.project) runJob(ev.project); }); } catch (_) {}
    // Job yang terputus karena aplikasi dimatikan sistem: status tersimpan di disk, jadi lanjut dari tahap yang belum punya zip.
    // Job yang menunggu limit: pasang lagi pewaktu dan alarmnya.
    const names = (await fs.dirs('')).filter((n) => !n.startsWith('_'));
    let launch = '';
    try { launch = ((await g().takeLaunch()) || {}).project || ''; } catch (_) {}
    for (const n of names) {
      const j = await loadJob(n);
      if (!j) continue;
      if (j.status === 'running') { if (j.timer) { j.timer.mode = ''; j.timer.since = 0; } j.status = 'queued'; j.error = 'Terputus (aplikasi dimatikan sistem). Dilanjutkan dari tahap yang belum selesai.'; await saveJob(j); if (n === launch || j.autoResume) launch = launch || n; }
      else if (j.status === 'waiting_limit' || j.status === 'waiting_cond') armWake(j);
    }
    await refreshJobs();
    if (launch) setTimeout(() => runJob(launch), 1500);
  }

  window.Relay = {
    runJob, createProject, refreshJobs, dumpChat, markLimit, splitStage, collectManual, transferForm, settingsForm, testTransfer,
    // dipakai halaman estafet (chat.js)
    ready, fs, loadJob, saveJob, modal, newProjectForm, dumpForm, showLog, exportProject, deleteProject, cancelRun, armWake,
    isRunning: (n) => !!(running && (!n || running.name === n)),
    getJobs: () => jobs,
    statusText,
  };
  if (window.Auth && Auth.ready) Auth.ready.then(() => setTimeout(init, 300)); else setTimeout(init, 1500);
})();
