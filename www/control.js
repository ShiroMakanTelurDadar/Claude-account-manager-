// Menu Control (tombol di beranda): info akun, ganti sandi, kode pemulihan, hapus akun, dan gambar / video latar halaman login.
(() => {
  'use strict';

  const Auth = window.Auth;
  const btn = document.getElementById('ctlBtn');
  if (!Auth || !btn) return;

  const MAX_VIDEO = 30 * 1024 * 1024;   // 30 MB
  const HIST_FRAC = 1;                  // gambar slide riwayat memenuhi seluruh tinggi layar (samakan dengan --himg-h di styles.css)
  let flashBg = '', flashHist = '';     // pesan yang tampil setelah menu dibangun ulang
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false) continue;
      e.append(c.nodeType ? c : document.createTextNode(c));
    }
    return e;
  };

  let backdrop = null, sheet = null, bodyEl = null, prevUrl = null, prevHistUrl = null;

  // ---------- Sheet ----------
  function close() {
    if (!sheet) return;
    sheet.classList.remove('open');
    backdrop.classList.remove('show');
    const s = sheet, b = backdrop;
    sheet = backdrop = bodyEl = null;
    if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = null; }
    if (prevHistUrl) { URL.revokeObjectURL(prevHistUrl); prevHistUrl = null; }
    setTimeout(() => { s.remove(); b.remove(); }, 300);
  }

  async function open() {
    if (sheet || !Auth.user) return;
    backdrop = h('div', { class: 'cbackdrop', onclick: close });
    bodyEl = h('div');
    sheet = h('div', { class: 'csheet', role: 'dialog', 'aria-label': 'Control' },
      h('div', { class: 'chead', }, h('b', { text: 'Control' }), h('button', { type: 'button', class: 'cx', text: '✕', 'aria-label': 'Tutup', onclick: close })),
      bodyEl,
    );
    document.body.append(backdrop, sheet);
    await build();
    requestAnimationFrame(() => { backdrop.classList.add('show'); sheet.classList.add('open'); });
  }

  const msgEl = () => h('p', { class: 'cmsg', role: 'alert' });
  const say = (el, t, ok) => { el.textContent = t || ''; el.classList.toggle('ok', !!ok); };
  const cbtn = (text, onclick, cls = '') => h('button', { type: 'button', class: `cbtn ${cls}`.trim(), text, onclick });

  async function build() {
    if (!bodyEl) return;
    bodyEl.textContent = '';

    // --- Akun (2 baris: info, lalu 3 tombol kecil) ---
    const accMsg = msgEl();
    bodyEl.append(h('div', { class: 'csec' },
      h('div', { class: 'crow' }, h('span', { text: 'Masuk sebagai' }), h('b', { text: Auth.user.name })),
      h('div', { class: 'cacts' },
        cbtn('Ganti sandi', () => changeCode(accMsg), 'alt'),
        cbtn('Keluar', () => Auth.logout(), 'alt'),
        cbtn('Hapus', () => deleteAccount(accMsg), 'danger'),
      ),
      accMsg,
    ));

    // --- Kode pemulihan (selalu bisa dilihat di sini) ---
    const recMsg = msgEl();
    const codeEl = h('code', { class: 'rcode' });
    let shown = false;
    const eyeBtn = cbtn('Lihat', () => { shown = !shown; paint(); }, 'alt');
    const paint = () => { codeEl.textContent = shown ? (Auth.rec || '-') : '••••-••••-••••'; eyeBtn.textContent = shown ? 'Sembunyi' : 'Lihat'; };
    paint();
    bodyEl.append(h('div', { class: 'csec' },
      h('div', { class: 'crow' }, h('span', { text: 'Kode pemulihan' }), codeEl),
      h('div', { class: 'cacts' },
        eyeBtn,
        cbtn('Salin', async () => {
          try { await navigator.clipboard.writeText(Auth.rec || ''); say(recMsg, 'Kode disalin.', true); } catch { say(recMsg, 'Gagal menyalin. Catat manual.'); }
        }, 'alt'),
        cbtn('Buat baru', () => newRecovery(recMsg, () => { shown = true; paint(); }), 'danger'),
      ),
      h('p', { class: 'cnote', text: 'Dipakai di "Lupa sandi" untuk membuat sandi baru tanpa kehilangan data. Catat di tempat aman.' }),
      recMsg,
    ));

    // --- Tampilan login ---
    const rec = await Auth.media.get();
    if (!bodyEl) return;
    if (prevUrl) URL.revokeObjectURL(prevUrl);
    prevUrl = rec ? URL.createObjectURL(rec.blob) : null;
    const url = prevUrl || Auth.media.DEFAULT_URL;
    const pv = h('div', { class: 'cprev' });
    if (rec && rec.kind === 'video') {
      const v = h('video', { src: url, loop: true, playsinline: true });
      v.muted = true; v.setAttribute('muted', '');
      v.addEventListener('canplay', () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); }, { once: true });
      pv.append(v);
    } else pv.append(h('img', { src: url, alt: '', draggable: 'false' }));

    const bgMsg = msgEl();
    if (flashBg) { say(bgMsg, flashBg, true); flashBg = ''; }
    const file = h('input', { type: 'file', accept: 'image/*,video/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (f) await pick(f, bgMsg);
    });
    // --- Gambar slide riwayat (satu bubble dengan Tampilan login) ---
    const hrec = await Auth.media.get('hist');
    if (!bodyEl) return;
    if (prevHistUrl) URL.revokeObjectURL(prevHistUrl);
    prevHistUrl = hrec && hrec.blob ? URL.createObjectURL(hrec.blob) : null;
    const hpv = h('div', { class: 'cprev fade', style: `aspect-ratio:${histRatio().toFixed(3)}` },
      h('img', { src: prevHistUrl || Auth.media.HIST_DEFAULT_URL, alt: '', draggable: 'false' }));
    const hMsg = msgEl();
    if (flashHist) { say(hMsg, flashHist, true); flashHist = ''; }
    const hfile = h('input', { type: 'file', accept: 'image/*', hidden: true });
    hfile.addEventListener('change', async () => {
      const f = hfile.files && hfile.files[0];
      hfile.value = '';
      if (f) await pickHist(f, hMsg);
    });

    bodyEl.append(h('div', { class: 'csec' },
      h('h3', { text: 'Tampilan' }),
      h('p', { class: 'csub', text: 'Halaman login' }),
      h('div', { class: 'crow' },
        pv,
        h('p', { class: 'cnote', text: 'Gambar atau video latar di halaman login. Rasio 9:16 (potret). Gambar bisa digeser dan di-zoom sebelum disimpan.' }),
      ),
      file,
      cbtn('Pilih gambar / video', () => file.click()),
      rec ? cbtn('Kembalikan bawaan', async () => { await Auth.media.clear(); flashBg = 'Dikembalikan ke gambar bawaan.'; await build(); }, 'alt') : null,
      bgMsg,
      h('div', { class: 'cdiv' }),
      h('p', { class: 'csub', text: 'Slide riwayat' }),
      h('div', { class: 'crow' },
        hpv,
        h('p', { class: 'cnote', text: 'Gambar di bagian bawah slide riwayat (setengah tinggi slide, tombol tampil di atasnya). Ujung atasnya otomatis memudar menyatu dengan warna dasar. Gambar bisa digeser dan di-zoom sebelum disimpan.' }),
      ),
      hfile,
      cbtn('Pilih gambar', () => hfile.click()),
      hrec ? cbtn('Kembalikan bawaan', async () => { await Auth.media.clear('hist'); notifyHist(); flashHist = 'Dikembalikan ke gambar bawaan.'; await build(); }, 'alt') : null,
      hMsg,
    ));
  }

  // Rasio kotak gambar slide riwayat (lebar slide : sepertiga tinggi layar), dibatasi supaya crop tetap nyaman
  function histRatio() {
    const w = Math.min(window.innerWidth * 0.46, 360);
    const hh = window.innerHeight * HIST_FRAC;
    return Math.min(1.1, Math.max(0.18, w / hh));
  }
  const notifyHist = () => window.dispatchEvent(new Event('cam:histbg'));

  async function pickHist(f, out) {
    say(out, '');
    try {
      if (!f.type.startsWith('image/')) { say(out, 'Untuk slide riwayat, file harus gambar.'); return; }
      const ratio = histRatio();
      const blob = await cropImage(f, { ratio, outW: 720, title: 'Atur gambar slide riwayat' });
      if (!blob) return;
      await Auth.media.set({ kind: 'image', blob, type: blob.type }, 'hist');
      notifyHist();
      flashHist = 'Gambar slide riwayat disimpan.';
      await build();
    } catch (e) {
      console.error(e);
      say(out, 'Gagal menyimpan. Coba file lain.');
    }
  }

  // ---------- Pilih media ----------
  async function pick(f, out) {
    say(out, '');
    try {
      if (f.type.startsWith('video/')) {
        if (f.size > MAX_VIDEO) { say(out, 'Video terlalu besar (maks 30 MB).'); return; }
        await Auth.media.set({ kind: 'video', blob: f, type: f.type });
        flashBg = 'Video latar disimpan.';
        await build();
      } else if (f.type.startsWith('image/')) {
        const blob = await cropImage(f);
        if (!blob) return;
        await Auth.media.set({ kind: 'image', blob, type: blob.type });
        flashBg = 'Gambar latar disimpan.';
        await build();
      } else say(out, 'File harus gambar atau video.');
    } catch (e) {
      console.error(e);
      say(out, 'Gagal menyimpan. Coba file lain.');
    }
  }

  // Crop dengan rasio bebas (bawaan 9:16): geser dengan jari, zoom dengan slider. Mengembalikan Blob JPEG atau null bila dibatalkan.
  function cropImage(file, opt = {}) {
    const ratio = opt.ratio || 9 / 16;
    const outW = opt.outW || Auth.media.W;
    const title = opt.title || 'Atur gambar latar (9:16)';
    return new Promise((resolve) => {
      const VW = 216, VH = Math.round(VW / ratio);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(url); alert('Gambar tidak bisa dibaca.'); resolve(null); };
      img.onload = () => {
        const dpr = 2;
        const cv = h('canvas', { width: VW * dpr, height: VH * dpr });
        const ctx = cv.getContext('2d');
        const base = Math.max(VW / img.width, VH / img.height);   // skala minimum agar menutup
        let zoom = 1, ox = 0, oy = 0;                              // offset dari tengah (px tampilan)
        const clamp = () => {
          const w = img.width * base * zoom, hh = img.height * base * zoom;
          ox = Math.min((w - VW) / 2, Math.max(-(w - VW) / 2, ox));
          oy = Math.min((hh - VH) / 2, Math.max(-(hh - VH) / 2, oy));
        };
        const draw = () => {
          clamp();
          const w = img.width * base * zoom, hh = img.height * base * zoom;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, VW, VH);
          ctx.drawImage(img, (VW - w) / 2 + ox, (VH - hh) / 2 + oy, w, hh);
        };
        let drag = null;
        cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox, oy }; cv.setPointerCapture(e.pointerId); });
        cv.addEventListener('pointermove', (e) => {
          if (!drag) return;
          const r = cv.getBoundingClientRect();
          ox = drag.ox + (e.clientX - drag.x) * (VW / r.width);
          oy = drag.oy + (e.clientY - drag.y) * (VH / r.height);
          draw();
        });
        const end = () => { drag = null; };
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);

        const zoomEl = h('input', { type: 'range', class: 'cropzoom', min: '1', max: '4', step: '0.01', value: '1', 'aria-label': 'Zoom' });
        zoomEl.addEventListener('input', () => { zoom = parseFloat(zoomEl.value); draw(); });

        const done = (blob) => { URL.revokeObjectURL(url); modal.remove(); resolve(blob); };
        const save = h('button', { type: 'button', class: 'cbtn', text: 'Simpan', onclick: () => {
          clamp();
          const out = document.createElement('canvas');
          out.width = outW; out.height = Math.round(outW / ratio);
          const k = out.width / VW;
          const w = img.width * base * zoom * k, hh = img.height * base * zoom * k;
          const c = out.getContext('2d');
          c.fillStyle = '#000'; c.fillRect(0, 0, out.width, out.height);
          c.drawImage(img, (out.width - w) / 2 + ox * k, (out.height - hh) / 2 + oy * k, w, hh);
          out.toBlob((b) => done(b), 'image/jpeg', 0.9);
        } });
        const cancel = h('button', { type: 'button', class: 'cbtn alt', text: 'Batal', onclick: () => done(null) });
        const modal = h('div', { class: 'cmodal' },
          h('div', { class: 'cbox' },
            h('h3', { text: title }),
            h('div', { class: 'cropwrap' }, h('div', { class: 'cropview', style: `height:${VH}px` }, cv)),
            zoomEl,
            h('div', { class: 'cbtns' }, cancel, save),
          ),
        );
        document.body.append(modal);
        draw();
      };
      img.src = url;
    });
  }

  // ---------- Sandi & hapus akun ----------
  function modal(title, ...kids) {
    const m = h('div', { class: 'cmodal' }, h('div', { class: 'cbox' }, h('h3', { text: title }), ...kids));
    document.body.append(m);
    return m;
  }

  async function changeCode(out) {
    say(out, '');
    const num = { class: 'afld', type: 'password', maxlength: '12', autocomplete: 'off', inputmode: 'numeric', spellcheck: 'false' };
    const cur = h('input', { ...num, placeholder: 'Sandi saat ini' });
    const nw = h('input', { ...num, maxlength: '6', placeholder: 'Sandi baru (6 angka)' });
    const nw2 = h('input', { ...num, maxlength: '6', placeholder: 'Ulangi sandi baru' });
    const err = msgEl();
    const ok = cbtn('Simpan', async () => {
      if (!cur.value) { say(err, 'Isi sandi saat ini.'); return; }
      if (!/^\d{6}$/.test(nw.value)) { say(err, 'Sandi baru harus tepat 6 angka.'); return; }
      if (nw.value !== nw2.value) { say(err, 'Sandi baru dan ulangi tidak sama.'); return; }
      ok.disabled = true;
      try {
        const r = await Auth.changeCode(cur.value, nw.value);
        if (r.err) { say(err, r.err); return; }
        m.remove();
        say(out, 'Sandi diganti.', true);
      } catch (e) { console.error(e); say(err, 'Terjadi kesalahan. Coba lagi.'); } finally { ok.disabled = false; }
    });
    const m = modal('Ganti sandi', cur, nw, nw2, err, h('div', { class: 'cbtns' }, cbtn('Batal', () => m.remove(), 'alt'), ok));
    cur.focus();
  }

  async function newRecovery(out, onDone) {
    say(out, '');
    const inp = h('input', { class: 'afld', type: 'password', placeholder: 'Sandi untuk konfirmasi', autocomplete: 'off', spellcheck: 'false' });
    const err = msgEl();
    const ok = cbtn('Buat baru', async () => {
      if (!inp.value) { say(err, 'Isi sandi.'); return; }
      ok.disabled = true;
      try {
        const r = await Auth.newRecovery(inp.value);
        if (r.err) { say(err, r.err); return; }
        m.remove();
        onDone();
        say(out, 'Kode pemulihan baru dibuat. Catat sekarang.', true);
      } catch (e) { console.error(e); say(err, 'Terjadi kesalahan. Coba lagi.'); } finally { ok.disabled = false; }
    });
    const m = modal('Buat kode pemulihan baru?',
      h('p', { class: 'cnote', text: 'Kode pemulihan yang lama tidak berlaku lagi.' }),
      inp, err,
      h('div', { class: 'cbtns' }, cbtn('Batal', () => m.remove(), 'alt'), ok),
    );
    inp.focus();
  }

  async function deleteAccount(out) {
    say(out, '');
    const inp = h('input', { class: 'afld', type: 'password', placeholder: 'Sandi untuk konfirmasi', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const err = msgEl();
    const del = cbtn('Hapus permanen', async () => {
      if (!inp.value) { say(err, 'Isi sandi.'); return; }
      del.disabled = true;
      try {
        const r = await Auth.deleteCurrent(inp.value);
        if (r.err) { say(err, r.err); return; }
        Auth.logout();
      } catch (e) { console.error(e); say(err, 'Terjadi kesalahan. Coba lagi.'); } finally { del.disabled = false; }
    }, 'danger');
    const m = modal('Hapus akun ini?',
      h('p', { class: 'cnote', text: 'Semua data akun ' + Auth.user.name + ' (daftar akun Claude, riwayat, pengaturan) ikut terhapus dan tidak bisa dikembalikan.' }),
      inp, err,
      h('div', { class: 'cbtns' }, cbtn('Batal', () => m.remove(), 'alt'), del),
    );
    inp.focus();
  }

  // ---------- Pasang ----------
  btn.addEventListener('click', open);
})();
