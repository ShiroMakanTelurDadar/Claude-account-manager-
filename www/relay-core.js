// Logika murni estafet (tanpa tampilan dan tanpa akses perangkat), supaya bisa diuji di Node.
// Dipakai relay.js lewat window.RelayCore. Isi: pembaca file dari balasan Claude, pembaca rencana, penyusun prompt, pemilih akun.
(function (root) {
  'use strict';

  const MAX_STEPS = 10;           // tahap per proyek (bawaan; bisa diatur di pengaturan estafet)
  const HARD_MAX_STEPS = 30;
  const MAX_ATTACH = 4;           // lampiran zip per tahap (batas claude.ai 20 file; dibuat kecil supaya hemat)
  const SUMMARY_MAX = 1500;
  const IN_BUDGET = 30000;        // karakter: batas isi file Input yang disertakan di prompt
  const BRIEF_MAX = 12000;

  // ---------- Path ----------
  // Path relatif yang aman di dalam folder Out. Kembalikan '' kalau tidak aman.
  function safePath(p) {
    let s = String(p || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    s = s.replace(/^`+|`+$/g, '').replace(/^\*+|\*+$/g, '');
    if (!s || s.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(s) || /[\0:*?"<>|]/.test(s) || s.length > 120) return '';
    if (/\/\//.test(s) || s.endsWith('/')) return '';
    return s;
  }

  // Nama proyek yang aman dipakai sebagai nama folder
  function safeName(n) {
    return String(n || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  }

  // ---------- Blok kode dari balasan ----------
  // Balasan (markdown buatan content.js) berisi blok ```bahasa ... ```. Blok yang tidak tertutup = file setengah jadi (complete: false).
  // Sebuah blok dianggap file kalau tepat sebelumnya ada baris "FILE: path" (boleh diberi #, **, atau backtick).
  const FILE_LINE = /^\s*(?:#{1,6}\s*)?(?:\*\*)?\s*`?FILE\s*:\s*`?([^\s`*]+)`?\s*(?:\*\*)?\s*$/i;
  function extractBlocks(md) {
    const lines = String(md || '').split('\n');
    const out = [];
    let pending = '';
    let blank = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const f = FILE_LINE.exec(line);
      if (f) { pending = safePath(f[1]); blank = 0; continue; }
      const open = /^(`{3,})([\w+.#-]*)\s*$/.exec(line);
      if (open) {
        const fence = open[1];
        const body = [];
        let complete = false;
        let j = i + 1;
        for (; j < lines.length; j++) {
          if (new RegExp('^`{' + fence.length + ',}\\s*$').test(lines[j])) { complete = true; break; }
          body.push(lines[j]);
        }
        out.push({ lang: (open[2] || '').toLowerCase(), path: pending, content: body.join('\n'), complete });
        pending = '';
        blank = 0;
        i = complete ? j : lines.length;
        continue;
      }
      if (!line.trim()) { if (++blank > 2) pending = ''; continue; }
      pending = '';   // tulisan lain di antara baris FILE dan blok kode: baris FILE itu batal
      blank = 0;
    }
    return out;
  }

  // File utuh (blok tertutup, ada path). Path yang sama muncul dua kali: yang terakhir dipakai.
  function extractFiles(md) {
    const map = new Map();
    for (const b of extractBlocks(md)) {
      if (!b.path || !b.complete) continue;
      map.set(b.path, { path: b.path, lang: b.lang, content: b.content });
    }
    return [...map.values()];
  }

  // Blok terakhir berbahasa "state" yang utuh: catatan keputusan untuk langkah berikutnya
  function extractState(md) {
    const bs = extractBlocks(md).filter((b) => b.lang === 'state' && b.complete);
    return bs.length ? bs[bs.length - 1].content.trim().slice(0, 1500) : '';
  }

  // ---------- Tahap ----------
  const stageName = (i) => 'stage_' + String(i + 1).padStart(2, '0') + '.zip';   // i = indeks 0
  const clampSteps = (n) => Math.max(1, Math.min(HARD_MAX_STEPS, Math.floor(Number(n)) || MAX_STEPS));

  // Balasan langkah 0 harus memuat satu blok ```json berisi {summary, steps:[{title, instructions}]}
  // Cadangan kalau blok kode tidak terbaca: cari objek JSON berisi "steps" langsung di teks
  function findJsonWithSteps(text) {
    const s = String(text || '');
    let tried = 0;
    for (let i = s.indexOf('{'); i >= 0 && tried < 60; i = s.indexOf('{', i + 1)) {
      tried++;
      let depth = 0, inStr = false, esc = false;
      for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try { const j = JSON.parse(s.slice(i, k + 1)); if (j && Array.isArray(j.steps)) return j; } catch (_) { /* bukan objek yang dicari */ }
          break;
        }
      }
    }
    return null;
  }

  // Tiap tahap otomatis menghasilkan SATU zip kumulatif: stage_NN.zip (isi proyek sampai tahap itu). Tahap N hanya melampirkan stage_(N-1).zip.
  function parsePlan(md, maxSteps) {
    const max = clampSteps(maxSteps || MAX_STEPS);
    const blocks = extractBlocks(md).filter((b) => b.complete);
    let raw = null;
    let err = 'tidak ada JSON rencana di balasan';
    for (const b of blocks) {
      if (b.lang && b.lang !== 'json' && b.lang !== 'plan') continue;
      try {
        const j = JSON.parse(b.content);
        if (j && Array.isArray(j.steps)) { raw = j; break; }
        err = 'json tidak punya daftar "steps"';
      } catch (e) { err = 'json tidak valid: ' + e.message; }
    }
    if (!raw) raw = findJsonWithSteps(md);
    if (!raw) return { ok: false, err };
    if (!raw.steps.length) return { ok: false, err: 'daftar tahap kosong' };
    if (raw.steps.length > max) return { ok: false, err: `terlalu banyak tahap (${raw.steps.length}, maksimal ${max})` };
    const steps = raw.steps.map((s, i) => {
      s = s || {};
      return {
        id: 's' + (i + 1),
        title: String(s.title || `Tahap ${i + 1}`).trim().slice(0, 80),
        instructions: String(s.instructions || s.title || '').trim().slice(0, 2500),
        zip: stageName(i),
      };
    });
    return { ok: true, plan: { summary: String(raw.summary || '').trim().slice(0, SUMMARY_MAX), steps } };
  }

  // Ganti satu tahap dengan beberapa tahap lebih kecil. Total tahap tidak boleh melebihi max. Tahap setelahnya dinomori ulang (zip lama belum ada, jadi aman).
  function applySplit(plan, stepIndex, md, maxSteps) {
    const max = clampSteps(maxSteps || MAX_STEPS);
    const r = parsePlan(md, HARD_MAX_STEPS);
    if (!r.ok) return r;
    const total = plan.steps.length - 1 + r.plan.steps.length;
    if (total > max) return { ok: false, err: `hasil pecahan membuat total ${total} tahap (maksimal ${max})` };
    const raw = plan.steps.slice(0, stepIndex).concat(r.plan.steps, plan.steps.slice(stepIndex + 1));
    const steps = raw.map((s, i) => Object.assign({}, s, { id: 's' + (i + 1), zip: stageName(i) }));
    return { ok: true, plan: Object.assign({}, plan, { steps }) };
  }

  // ---------- Pengukuran jatah akun ----------
  // stats = { runs: [{acc, done, limited}] }: berapa tahap selesai oleh satu akun berturut-turut sebelum limit.
  function measure(stats) {
    const runs = ((stats && stats.runs) || []).filter((r) => r.limited);
    if (!runs.length) return { known: false, avg: 0, n: 0 };
    const avg = runs.reduce((s, r) => s + r.done, 0) / runs.length;
    return { known: true, avg, n: runs.length };
  }
  function budgetHint(stats) {
    const m = measure(stats);
    if (!m.known) return '';
    if (m.avg < 1) return 'CATATAN JATAH: akun-akun sebelumnya kehabisan jatah sebelum satu tahap selesai. Kerjakan tahap ini SEHEMAT mungkin: kode ringkas, jangan jalankan banyak percobaan, jangan menjelaskan panjang.';
    return `CATATAN JATAH: rata-rata satu akun menyelesaikan sekitar ${m.avg.toFixed(1)} tahap sebelum limit. Tetap hemat: jangan menjalankan perintah yang tidak perlu.`;
  }
  // Aturan anti-buang akun: tahap yang sama gagal tanpa hasil di 2 akun BERBEDA berturut-turut -> berhenti.
  function shouldStopStage(failAccounts) {
    const f = failAccounts || [];
    return f.length >= 2 && f[f.length - 1] !== f[f.length - 2];
  }

  // ---------- Prompt ----------
  const MODEL_RULES = [
    'ATURAN MODEL KARAKTER (.pmx / .vrm / FBX):',
    '- Model asli TIDAK diunggah ke chat dan kamu TIDAK membuat model karakter. Kode membaca model dari `public/model/` lewat `public/model/model.json` (mendukung `.vrm` dan `.pmx`).',
    '- Kalau file model tidak ada, kode memakai placeholder mannequin sederhana, sehingga `tsc` tetap lolos tanpa model asli.',
    '- Sediakan `src/rigMap.ts` (pemetaan nama bone) dan `src/expressionMap.ts` (pemetaan morph / ekspresi), plus composition `PoseDebug`.',
    '- Kalau kamu butuh nama bone/morph yang sebenarnya, minta saja pemilik proyek menempelkan daftar namanya sebagai teks kecil. Jangan minta file model.',
  ].join('\n');

  function stageRules(zip, prevZip) {
    return [
      'ATURAN TAHAP (wajib):',
      '- Kamu BOLEH memakai sandbox, tapi KERJA CEPAT: tulis file langsung, jangan `npm install`, jangan merender atau menjalankan proyek, jangan mengulang pengecekan. Cukup periksa sintaks ringan (misalnya `node --check` / `python -m py_compile`) bila perlu.',
      '- Jangan menulis penjelasan panjang. Tulis kode, buat zip, tampilkan zip, dan akhiri dengan blok `state`.',
      prevZip
        ? `- Lampiran chat ini: \`${prevZip}\` = isi proyek sampai tahap sebelumnya. Ekstrak dulu ke folder kerja, lanjutkan dari situ, jangan menulis ulang dari nol.`
        : '- Ini tahap pertama: mulai dari kosong (kecuali ada lampiran dari pemilik proyek).',
      `- Hasil akhir tahap ini = SATU file zip bernama persis \`${zip}\` di /mnt/user-data/outputs/, berisi SELURUH proyek sampai tahap ini (kumulatif), dengan struktur folder proyek di akar zip.`,
      '- Jangan masukkan: node_modules, out/, dist/, build/, file video, dan model biner (.glb .pmx .vrm .fbx). Usahakan zip di bawah 25 MB.',
      `- Setelah zip jadi, tampilkan sebagai file yang bisa diunduh (present_files) dan jangan menulis zip lain.`,
      '- Akhiri jawaban dengan satu blok kode berbahasa `state` (maksimal 8 baris): keputusan penting dan hal yang perlu diketahui tahap berikutnya.',
    ].join('\n');
  }

  function buildPlanPrompt(brief, inFiles, opts) {
    const o = opts || {};
    const max = clampSteps(o.maxSteps || MAX_STEPS);
    const b = String(brief || '').trim().slice(0, BRIEF_MAX);
    const files = (inFiles || []).map((f) => `### ${f.path}\n${f.content}`).join('\n\n');
    return [
      'Kamu akan mengerjakan proyek di bawah ini, tetapi pekerjaannya dibagi menjadi TAHAP kecil yang dikerjakan di chat terpisah (kadang oleh akun berbeda yang tidak tahu apa-apa soal chat ini). Tiap tahap menghasilkan satu zip kumulatif.',
      'SEKARANG JANGAN MENGERJAKAN APA PUN. Hanya buat rencana.',
      '',
      'PROYEK:',
      b,
      files ? '\nLAMPIRAN:\n' + files : '',
      '',
      MODEL_RULES,
      '',
      'Balas dengan SATU blok kode berbahasa `json` berisi persis bentuk ini, tanpa tulisan lain di luar blok:',
      '```json',
      '{',
      '  "summary": "ringkasan proyek, tujuan, teknologi, struktur folder, dan aturan penting (maksimal 1200 karakter), cukup untuk dipahami orang yang belum melihat apa pun",',
      '  "steps": [',
      '    { "title": "judul pendek", "instructions": "apa yang harus dikerjakan di tahap ini, rinci dan mandiri" }',
      '  ]',
      '}',
      '```',
      'Syarat rencana:',
      `- Maksimal ${max} tahap. Tahap 1 = kerangka proyek + timing. Lalu satu scene 3D per tahap, satu scene 2D per tahap, dan seterusnya.`,
      '- Tiap tahap HARUS kecil: cukup dikerjakan dalam satu chat pendek (beberapa file, tanpa riset panjang). Lebih baik tahap kecil dan banyak daripada tahap besar.',
      '- Tiap tahap mengubah proyek yang sama dan menghasilkan satu zip kumulatif; jangan merencanakan nama file zip, aplikasi yang menentukan.',
      '- Jangan merencanakan render video atau pembuatan model karakter. Render dilakukan di luar chat.',
      o.hint ? '\n' + o.hint : '',
    ].filter((x) => x !== '').join('\n');
  }

  function buildSplitPrompt(plan, index, why, maxNew) {
    const s = plan.steps[index];
    return [
      'Sebuah tahap proyek terlalu besar: dua chat berturut-turut kehabisan jatah sebelum selesai. SEKARANG JANGAN MENGERJAKAN APA PUN. Pecah tahap ini menjadi beberapa tahap yang jauh lebih kecil.',
      '',
      'RINGKASAN PROYEK:', plan.summary,
      '',
      `TAHAP YANG DIPECAH: ${s.title}`, s.instructions,
      why ? '\nCatatan kegagalan: ' + why : '',
      '',
      `Balas dengan SATU blok kode \`json\` bentuk {"summary": "", "steps": [{"title": "", "instructions": ""}]} berisi 2 sampai ${maxNew} tahap pengganti saja (bukan seluruh proyek). Tidak ada tulisan lain.`,
    ].filter((x) => x !== '').join('\n');
  }

  // Prompt satu tahap: paket serah-terima (ringkasan, progres, aturan). Berkas lama dilampirkan sebagai zip, bukan ditempel.
  function buildStepPrompt(o) {
    const { plan, step, index, progress, brief, inFiles, prevZip, hint } = o;
    let inUsed = 0;
    const ins = [];
    for (const f of inFiles || []) {
      if (inUsed + f.content.length > IN_BUDGET) continue;
      inUsed += f.content.length;
      ins.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
    return [
      `Kamu melanjutkan proyek yang dikerjakan bertahap. Ini tahap ${index + 1} dari ${plan.steps.length}. Kamu belum pernah melihat chat sebelumnya, semua yang perlu diketahui ada di bawah.`,
      '',
      'RINGKASAN PROYEK:',
      plan.summary || String(brief || '').slice(0, SUMMARY_MAX),
      '',
      'PROGRES SAAT INI:',
      progress,
      ins.length ? '\nCATATAN DARI PEMILIK PROYEK:\n' + ins.join('\n\n') : '',
      '',
      `TUGAS TAHAP INI: ${step.title}`,
      step.instructions,
      '',
      MODEL_RULES,
      '',
      stageRules(step.zip, prevZip),
      hint ? '\n' + hint : '',
    ].filter((x) => x !== '').join('\n');
  }

  // ---------- Progres ----------
  // progress.md dibuat ulang oleh aplikasi dari rencana dan hasil, bukan ditulis Claude, jadi selalu utuh walau Claude terputus.
  function buildProgress(name, plan, stepState) {
    const lines = [`# Progres: ${name}`, ''];
    if (!plan) { lines.push('Rencana belum dibuat.'); return lines.join('\n'); }
    for (const s of plan.steps) {
      const st = stepState[s.id] || {};
      const mark = st.status === 'done' ? '[x]' : '[ ]';
      lines.push(`- ${mark} ${s.id} ${s.title} — zip: ${s.zip}`);
    }
    const notes = plan.steps.filter((s) => (stepState[s.id] || {}).note);
    if (notes.length) {
      lines.push('', '## Catatan dari tahap selesai');
      for (const s of notes) lines.push(`- ${s.id}: ${stepState[s.id].note.replace(/\n+/g, ' / ')}`);
    }
    return lines.join('\n');
  }

  // ---------- Akun ----------
  // Pilih akun berikutnya dari pool (urutan = prioritas). Akun Limit yang jam resetnya sudah lewat dianggap bisa dipakai.
  // skip = Set id akun yang dilewati untuk putaran ini. Hasil: {account} | {wait: ms-epoch jam reset paling awal} | {none: true}
  function pickAccount(accounts, pool, now, skip) {
    let earliest = 0;
    for (const id of pool) {
      const a = accounts.find((x) => x.id === id);
      if (!a || (skip && skip.has(id))) continue;
      if (a.check && a.check.state === 'loggedout') continue;
      if (a.status === 'working') {
        const t = a.resetAt ? Date.parse(a.resetAt) : 0;
        if (t && t > now) { if (!earliest || t < earliest) earliest = t; continue; }
      }
      return { account: a };
    }
    return earliest ? { wait: earliest } : { none: true };
  }

  // ---------- Timer ----------
  // job.timer = { firstAt, lastAt, endAt, workMs, waitMs, mode: 'work'|'wait'|'', since }
  //   work = status running (kirim prompt, Claude bekerja). wait = menunggu reset limit / syarat Wi-Fi-charging.
  //   Status lain (queued, failed, cancelled) tidak dihitung ke work/wait. Total = dari mulai pertama sampai selesai (atau aktivitas terakhir).
  // Dipanggil tiap job disimpan (saveJob): menutup segmen lama, membuka segmen sesuai status baru.
  function timerTick(job, now) {
    const t = job.timer = job.timer || { firstAt: 0, lastAt: 0, endAt: 0, workMs: 0, waitMs: 0, mode: '', since: 0 };
    if (t.mode && t.since) {
      const d = Math.max(0, now - t.since);
      if (t.mode === 'work') t.workMs += d; else t.waitMs += d;
    }
    const s = job.status;
    const m = s === 'running' ? 'work' : (s === 'waiting_limit' || s === 'waiting_cond') ? 'wait' : '';
    if (m && !t.firstAt) t.firstAt = now;
    t.mode = m; t.since = m ? now : 0; t.lastAt = now;
    if (s === 'done') { if (!t.endAt) t.endAt = now; } else t.endAt = 0;
    return t;
  }
  // Angka untuk ditampilkan (termasuk segmen yang sedang jalan). null = belum pernah mulai.
  function timerView(job, now) {
    const t = job && job.timer;
    if (!t || !t.firstAt) return null;
    let work = t.workMs || 0, wait = t.waitMs || 0;
    if (t.mode && t.since) {
      const d = Math.max(0, now - t.since);
      if (t.mode === 'work') work += d; else wait += d;
    }
    const end = t.endAt || (t.mode ? now : t.lastAt) || now;
    return { work, wait, total: Math.max(0, end - t.firstAt), running: !!t.mode };
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), d = s % 60;
    if (h) return `${h}j ${String(m).padStart(2, '0')}m`;
    if (m) return `${m}m ${String(d).padStart(2, '0')}d`;
    return `${d}d`;
  }
  // Baris teks untuk kartu / log. Satu baris waktu + (kalau ada) satu baris rata-rata per tahap.
  function timeLines(job, now) {
    const v = timerView(job, now);
    if (!v) return [];
    const out = [`⏱ Total ${fmtDur(v.total)} · kerja ${fmtDur(v.work)}${v.wait >= 1000 ? ' · tunggu limit ' + fmtDur(v.wait) : ''}`];
    const ms = Object.values((job && job.steps) || {}).filter((s) => s && s.status === 'done' && s.ms > 0).map((s) => s.ms);
    if (ms.length) out.push(`⏱ Rata-rata per tahap ${fmtDur(ms.reduce((a, b) => a + b, 0) / ms.length)} (${ms.length} tahap)`);
    return out;
  }

  const api = {
    timerTick, timerView, fmtDur, timeLines,
    safePath, safeName, extractBlocks, extractFiles, extractState, parsePlan, applySplit, buildPlanPrompt, buildSplitPrompt, buildStepPrompt,
    buildProgress, pickAccount, measure, budgetHint, shouldStopStage, stageName, clampSteps, MODEL_RULES, MAX_STEPS, MAX_ATTACH,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RelayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
