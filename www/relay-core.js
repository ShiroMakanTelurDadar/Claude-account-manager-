// Logika murni estafet (tanpa tampilan dan tanpa akses perangkat), supaya bisa diuji di Node.
// Dipakai relay.js lewat window.RelayCore. Isi: pembaca file dari balasan Claude, pembaca rencana, penyusun prompt, pemilih akun.
(function (root) {
  'use strict';

  const MAX_STEPS = 12;
  const MAX_OUTPUTS = 4;          // file per langkah
  const NEEDS_BUDGET = 60000;     // karakter: batas isi file Out yang disertakan di prompt satu langkah
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

  // ---------- Rencana ----------
  // Balasan langkah 0 harus memuat satu blok ```json berisi {summary, steps:[{title, instructions, outputs, needs}]}
  // Cadangan kalau blok kode tidak terbaca (pagar ``` hilang, bahasa blok aneh, dsb.): cari objek JSON berisi "steps" langsung di teks
  function findJsonWithSteps(text) {
    const s = String(text || '');
    let tried = 0;
    for (let i = s.indexOf('{'); i >= 0 && tried < 60; i = s.indexOf('{', i + 1)) {
      tried++;
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let k = i; k < s.length; k++) {
        const c = s[k];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}' && --depth === 0) {
          try {
            const j = JSON.parse(s.slice(i, k + 1));
            if (j && Array.isArray(j.steps)) return j;
          } catch (_) { /* bukan objek yang dicari */ }
          break;
        }
      }
    }
    return null;
  }

  function parsePlan(md) {
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
    if (!raw.steps.length) return { ok: false, err: 'daftar langkah kosong' };
    if (raw.steps.length > MAX_STEPS) return { ok: false, err: `terlalu banyak langkah (${raw.steps.length}, maksimal ${MAX_STEPS})` };
    const steps = [];
    const allOutputs = new Set();
    for (let i = 0; i < raw.steps.length; i++) {
      const s = raw.steps[i] || {};
      const outputs = [...new Set((Array.isArray(s.outputs) ? s.outputs : []).map(safePath).filter(Boolean))];
      if (!outputs.length) return { ok: false, err: `langkah ${i + 1} tidak punya file hasil yang valid` };
      if (outputs.length > MAX_OUTPUTS) return { ok: false, err: `langkah ${i + 1} punya ${outputs.length} file (maksimal ${MAX_OUTPUTS})` };
      const dup = outputs.find((o) => allOutputs.has(o));
      if (dup) return { ok: false, err: `file "${dup}" muncul di dua langkah` };
      // needs hanya boleh menunjuk file dari langkah sebelumnya
      const needs = [...new Set((Array.isArray(s.needs) ? s.needs : []).map(safePath).filter((p) => p && allOutputs.has(p)))];
      outputs.forEach((o) => allOutputs.add(o));
      steps.push({
        id: 's' + (i + 1),
        title: String(s.title || `Langkah ${i + 1}`).trim().slice(0, 80),
        instructions: String(s.instructions || s.title || '').trim().slice(0, 2500),
        outputs,
        needs,
      });
    }
    return { ok: true, plan: { summary: String(raw.summary || '').trim().slice(0, SUMMARY_MAX), steps } };
  }

  // ---------- Prompt ----------
  const OUTPUT_RULES = [
    'ATURAN KELUARAN (wajib):',
    '- Jangan menjalankan perintah, jangan membuat file di sandbox, jangan memakai artifact. Tulis semuanya langsung di jawaban ini.',
    '- Tiap file ditulis LENGKAP (tidak boleh dipotong, tidak boleh "sisanya sama"). Format: satu baris `FILE: path/relatif.ext`, tepat di bawahnya satu blok kode berisi seluruh isi file.',
    '- Tulis hanya file yang diminta langkah ini. Jangan tulis file lain.',
    '- Akhiri jawaban dengan satu blok kode berbahasa `state` (maksimal 8 baris): keputusan penting dan hal yang perlu diketahui langkah berikutnya.',
  ].join('\n');

  function buildPlanPrompt(brief, inFiles) {
    const b = String(brief || '').trim().slice(0, BRIEF_MAX);
    const files = (inFiles || []).map((f) => `### ${f.path}\n${f.content}`).join('\n\n');
    return [
      'Kamu akan mengerjakan proyek di bawah ini, tetapi pekerjaannya dibagi menjadi langkah-langkah kecil yang dikerjakan di chat terpisah (kadang oleh akun berbeda yang tidak tahu apa-apa soal chat ini).',
      'SEKARANG JANGAN MENGERJAKAN APA PUN. Hanya buat rencana.',
      '',
      'PROYEK:',
      b,
      files ? '\nLAMPIRAN:\n' + files : '',
      '',
      'Balas dengan SATU blok kode berbahasa `json` berisi persis bentuk ini, tanpa tulisan lain di luar blok:',
      '```json',
      '{',
      '  "summary": "ringkasan proyek, tujuan, teknologi, dan aturan penting (maksimal 1200 karakter), cukup untuk dipahami orang yang belum melihat apa pun",',
      '  "steps": [',
      '    { "title": "judul pendek", "instructions": "apa yang harus dikerjakan di langkah ini, rinci dan mandiri", "outputs": ["src/contoh.js"], "needs": [] }',
      '  ]',
      '}',
      '```',
      'Syarat rencana:',
      `- Maksimal ${MAX_STEPS} langkah. Tiap langkah menghasilkan 1 sampai ${MAX_OUTPUTS} file teks (kode atau dokumen), tiap file idealnya di bawah 300 baris.`,
      '- "outputs" = path relatif file yang dihasilkan langkah itu. Satu file hanya boleh ada di satu langkah.',
      '- "needs" = file hasil LANGKAH SEBELUMNYA yang benar-benar harus dibaca untuk mengerjakan langkah ini (kosongkan kalau tidak perlu). Semakin sedikit semakin baik.',
      '- Hanya file teks. Jangan merencanakan gambar, video, atau file biner. Render atau build dilakukan di luar chat.',
    ].filter((x) => x !== '').join('\n');
  }

  // Prompt satu langkah. Berisi paket serah-terima: ringkasan proyek, daftar progres, file yang dibutuhkan, lalu instruksi langkah.
  // got = path hasil yang sudah ada untuk langkah ini (dari percobaan sebelumnya): tidak ditulis ulang.
  function buildStepPrompt(o) {
    const { plan, step, index, progress, needFiles, got, brief, inFiles } = o;
    let inUsed = 0;
    const ins = [];
    for (const f of inFiles || []) {
      if (inUsed + f.content.length > IN_BUDGET) continue;
      inUsed += f.content.length;
      ins.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
    const missing = step.outputs.filter((p) => !(got || []).includes(p));
    let used = 0;
    const needs = [];
    const skipped = [];
    for (const f of needFiles || []) {
      if (used + f.content.length > NEEDS_BUDGET) { skipped.push(f.path); continue; }
      used += f.content.length;
      needs.push(`### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``);
    }
    return [
      `Kamu melanjutkan proyek yang dikerjakan bertahap. Ini langkah ${index + 1} dari ${plan.steps.length}. Kamu belum pernah melihat chat sebelumnya, semua yang perlu diketahui ada di bawah.`,
      '',
      'RINGKASAN PROYEK:',
      plan.summary || String(brief || '').slice(0, SUMMARY_MAX),
      '',
      'PROGRES SAAT INI:',
      progress,
      ins.length ? '\nFILE LAMPIRAN PROYEK (dari pemilik proyek):\n' + ins.join('\n\n') : '',
      needs.length ? '\nFILE HASIL LANGKAH SEBELUMNYA YANG KAMU BUTUHKAN:\n' + needs.join('\n\n') : '',
      skipped.length ? `\n(File ini terlalu besar untuk disertakan dan tidak perlu dibaca ulang: ${skipped.join(', ')})` : '',
      '',
      `TUGAS LANGKAH INI: ${step.title}`,
      step.instructions,
      '',
      `File yang harus kamu tulis: ${missing.map((p) => '`' + p + '`').join(', ')}`,
      (got || []).length ? `File ini sudah selesai dan TIDAK boleh ditulis ulang: ${got.join(', ')}` : '',
      '',
      OUTPUT_RULES,
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
      lines.push(`- ${mark} ${s.id} ${s.title} — file: ${s.outputs.join(', ')}`);
    }
    const notes = plan.steps.filter((s) => (stepState[s.id] || {}).note);
    if (notes.length) {
      lines.push('', '## Catatan dari langkah selesai');
      for (const s of notes) lines.push(`- ${s.id}: ${stepState[s.id].note.replace(/\n+/g, ' / ')}`);
    }
    return lines.join('\n');
  }

  // ---------- Akun ----------
  // Pilih akun berikutnya dari pool (urutan = prioritas). Akun Limit yang jam resetnya sudah lewat dianggap bisa dipakai.
  // skip = Set id akun yang dilewati untuk putaran ini (belum login, gagal berulang).
  // Hasil: {account} | {wait: ms-epoch jam reset paling awal} | {none: true}
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

  const api = { safePath, safeName, extractBlocks, extractFiles, extractState, parsePlan, buildPlanPrompt, buildStepPrompt, buildProgress, pickAccount, OUTPUT_RULES, MAX_STEPS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RelayCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
