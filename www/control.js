// Menu Control (tombol di beranda): info akun, ganti kode, hapus akun, dan gambar / video latar halaman login.
(() => {
  'use strict';

  const Auth = window.Auth;
  const btn = document.getElementById('ctlBtn');
  if (!Auth || !btn) return;

  const MAX_VIDEO = 30 * 1024 * 1024;   // 30 MB
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

  let backdrop = null, sheet = null, bodyEl = null, prevUrl = null;

  // ---------- Sheet ----------
  function close() {
    if (!sheet) return;
    sheet.classList.remove('open');
    backdrop.classList.remove('show');
    const s = sheet, b = backdrop;
    sheet = backdrop = bodyEl = null;
    if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = null; }
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

    // --- Akun ---
    const accMsg = msgEl();
    bodyEl.append(h('div', { class: 'csec' },
      h('h3', { text: 'Akun' }),
      h('div', { class: 'crow' }, h('span', { text: 'Masuk sebagai' }), h('b', { text: Auth.user.name })),
      cbtn('Ganti kode sandi', () => changeCode(accMsg), 'alt'),
      cbtn('Keluar', () => Auth.logout()),
      cbtn('Hapus akun ini', () => deleteAccount(accMsg), 'danger'),
      accMsg,
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
    const file = h('input', { type: 'file', accept: 'image/*,video/*', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (f) await pick(f, bgMsg);
    });
    bodyEl.append(h('div', { class: 'csec' },
      h('h3', { text: 'Tampilan login' }),
      h('div', { class: 'crow' },
        pv,
        h('p', { class: 'cnote', text: 'Gambar atau video latar di halaman login. Rasio 9:16 (potret). Gambar bisa digeser dan di-zoom sebelum disimpan.' }),
      ),
      file,
      cbtn('Pilih gambar / video', () => file.click()),
      rec ? cbtn('Kembalikan bawaan', async () => { await Auth.media.clear(); say(bgMsg, 'Dikembalikan ke gambar bawaan.', true); await build(); }, 'alt') : null,
      bgMsg,
    ));
  }

  // ---------- Pilih media ----------
  async function pick(f, out) {
    say(out, '');
    try {
      if (f.type.startsWith('video/')) {
        if (f.size > MAX_VIDEO) { say(out, 'Video terlalu besar (maks 30 MB).'); return; }
        await Auth.media.set({ kind: 'video', blob: f, type: f.type });
        say(out, 'Video latar disimpan.', true);
        await build();
      } else if (f.type.startsWith('image/')) {
        const blob = await cropImage(f);
        if (!blob) return;
        await Auth.media.set({ kind: 'image', blob, type: blob.type });
        say(out, 'Gambar latar disimpan.', true);
        await build();
      } else say(out, 'File harus gambar atau video.');
    } catch (e) {
      console.error(e);
      say(out, 'Gagal menyimpan. Coba file lain.');
    }
  }

  // Crop 9:16: geser dengan jari, zoom dengan slider. Mengembalikan Blob JPEG atau null bila dibatalkan.
  function cropImage(file) {
    return new Promise((resolve) => {
      const VW = 216, VH = 384;
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
          out.width = Auth.media.W; out.height = Auth.media.H;
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
            h('h3', { text: 'Atur gambar latar (9:16)' }),
            h('div', { class: 'cropwrap' }, h('div', { class: 'cropview' }, cv)),
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

  // ---------- Kode & hapus akun ----------
  function modal(title, ...kids) {
    const m = h('div', { class: 'cmodal' }, h('div', { class: 'cbox' }, h('h3', { text: title }), ...kids));
    document.body.append(m);
    return m;
  }

  async function changeCode(out) {
    say(out, '');
    const inp = h('input', { class: 'afld', type: 'password', placeholder: 'Kode sandi saat ini', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const err = msgEl();
    const ok = cbtn('Ganti kode', async () => {
      if (!inp.value) { say(err, 'Isi kode saat ini.'); return; }
      ok.disabled = true;
      try {
        const r = await Auth.changeCode(inp.value);
        if (r.err) { say(err, r.err); return; }
        m.remove();
        showCode(r.code);
      } catch (e) { console.error(e); say(err, 'Terjadi kesalahan. Coba lagi.'); } finally { ok.disabled = false; }
    });
    const m = modal('Ganti kode sandi', inp, err, h('div', { class: 'cbtns' }, cbtn('Batal', () => m.remove(), 'alt'), ok));
    inp.focus();
  }

  function showCode(code) {
    const box = h('div', { class: 'codebox', text: code });
    const err = msgEl();
    const m = modal('Kode sandi baru',
      box,
      h('p', { class: 'cnote' }, h('b', { text: 'Catat sekarang. ' }), 'Kode hanya tampil satu kali dan tidak bisa dilihat lagi.'),
      err,
      h('div', { class: 'cbtns' },
        cbtn('Salin', async () => { try { await navigator.clipboard.writeText(code); say(err, 'Kode disalin.', true); } catch { say(err, 'Gagal menyalin. Catat manual.'); } }, 'alt'),
        cbtn('Sudah dicatat', () => m.remove()),
      ),
    );
  }

  async function deleteAccount(out) {
    say(out, '');
    const inp = h('input', { class: 'afld', type: 'password', placeholder: 'Kode sandi untuk konfirmasi', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const err = msgEl();
    const del = cbtn('Hapus permanen', async () => {
      if (!inp.value) { say(err, 'Isi kode sandi.'); return; }
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
