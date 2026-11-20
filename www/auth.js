// Sistem login lokal (tanpa server).
// - Banyak pengguna dalam satu aplikasi (MAX_USERS). Data tiap pengguna disimpan terpisah di perangkat.
// - Sandi 6 angka dibuat pengguna sendiri (bisa diganti di menu Control). Yang disimpan hanya hash (PBKDF2), bukan sandinya.
// - Tiap pengguna punya ID acak tersembunyi. ID ini dipakai untuk nama penyimpanan dan ikut dalam hash,
//   jadi username yang sama yang dibuat ulang tidak akan tertukar dengan data lama.
// - Percobaan salah dibatasi (kunci sementara yang makin lama).
// - Kode pemulihan (12 huruf/angka) dibuat otomatis, bisa dilihat di Control, dan dipakai di "Lupa sandi" untuk membuat sandi baru tanpa kehilangan data.
//   Kode disimpan terenkripsi (AES-GCM, kunci dari sandi) dan hash-nya disimpan untuk verifikasi. Kalau kode pemulihan juga hilang: hapus akun.
// - Lupa sandi: sandi lama tidak bisa dilihat lagi. Satu-satunya cara: hapus akun itu lalu buat ulang.
(() => {
  'use strict';

  const Cap = window.Capacitor || {};
  const P = Cap.Plugins || {};
  const native = !!(Cap.isNativePlatform && Cap.isNativePlatform());

  const USERS_KEY = 'auth_users';
  const MAX_USERS = 3;
  const PBKDF2_ITER = 200000;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 huruf/angka, tanpa O 0 I 1 supaya tidak salah baca
  const REC_LEN = 12;                                     // 12 x 5 bit = 60 bit acak
  const PIN_RE = /^\d{6}$/;                               // sandi baru: tepat 6 angka
  const PIN_ERR = 'Sandi harus tepat 6 angka.';
  const FREE_TRIES = 5;                                   // percobaan salah sebelum dikunci
  const LOCK_BASE = 30000;                                // ms, dikali 2 setiap percobaan salah berikutnya
  const LOCK_MAX = 15 * 60000;
  const NAME_RE = /^[A-Za-z0-9_.]{3,20}$/;
  const LEGACY_KEYS = ['accounts', 'settings', 'history'];

  // ---------- Penyimpanan ----------
  const kv = {
    async get(k) {
      try {
        return native && P.Preferences ? (await P.Preferences.get({ key: k })).value : localStorage.getItem(k);
      } catch { return null; }
    },
    async set(k, v) {
      if (native && P.Preferences) await P.Preferences.set({ key: k, value: v });
      else localStorage.setItem(k, v);
    },
    async del(k) {
      try {
        if (native && P.Preferences) await P.Preferences.remove({ key: k });
        else localStorage.removeItem(k);
      } catch {}
    },
  };

  // Media latar halaman login (gambar / video) disimpan di IndexedDB karena bisa besar.
  const DB_NAME = 'cam-media';
  const idb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const idbOp = async (mode, fn) => {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = fn(db.transaction('kv', mode).objectStore('kv'));
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  };
  const media = {
    DEFAULT_URL: 'assets/login-default.jpg',
    W: 720, H: 1280,                 // ukuran hasil crop gambar; rasio 9:16
    RATIO: 9 / 16,
    async get() { try { return (await idbOp('readonly', (s) => s.get('bg'))) || null; } catch { return null; } },
    async set(rec) { await idbOp('readwrite', (s) => s.put(rec, 'bg')); },
    async clear() { try { await idbOp('readwrite', (s) => s.delete('bg')); } catch {} },
  };

  // ---------- Kripto ----------
  const enc = new TextEncoder();
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');

  function genRecCode() {
    const bytes = rand(REC_LEN);
    let c = '';
    for (const b of bytes) c += ALPHABET[b & 31];        // 256 habis dibagi 32, jadi tidak bias
    return c.match(/.{4}/g).join('-');
  }
  const normCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function derive(code, saltB64, id, iter) {
    const key = await crypto.subtle.importKey('raw', enc.encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array([...unb64(saltB64), ...enc.encode(id)]);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
    return new Uint8Array(bits);
  }
  function same(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  // ---------- Kode pemulihan ----------
  async function aesKey(pin, u) {
    const base = await crypto.subtle.importKey('raw', enc.encode(normCode(pin)), 'PBKDF2', false, ['deriveKey']);
    const salt = new Uint8Array([...unb64(u.esalt), ...enc.encode('rk' + u.id)]);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function sealRec(u, pin, code) {
    if (!u.esalt) u.esalt = b64(rand(16));
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(pin, u), enc.encode(code)));
    u.renc = b64(new Uint8Array([...iv, ...ct]));
  }
  async function openRec(u, pin) {
    if (!u.renc || !u.esalt) return null;
    try {
      const all = unb64(u.renc);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await aesKey(pin, u), all.slice(12));
      return new TextDecoder().decode(pt);
    } catch { return null; }
  }
  async function newRecovery(u, pin) {
    const code = genRecCode();
    u.rsalt = b64(rand(16));
    u.rhash = b64(await derive(code, u.rsalt, 'rec' + u.id, PBKDF2_ITER));
    await sealRec(u, pin, code);
    return code;
  }
  const verifyRec = async (u, code) => !!u.rhash && same(await derive(code, u.rsalt, 'rec' + u.id, PBKDF2_ITER), unb64(u.rhash));

  // ---------- Daftar pengguna ----------
  let users = [];
  async function loadUsers() {
    try {
      const l = JSON.parse((await kv.get(USERS_KEY)) || '[]');
      users = Array.isArray(l) ? l.filter((u) => u && u.id && u.name && u.hash && u.salt) : [];
    } catch { users = []; }
  }
  const saveUsers = () => kv.set(USERS_KEY, JSON.stringify(users));
  const findUser = (name) => users.find((u) => u.key === String(name || '').trim().toLowerCase());
  const userKey = (u, name) => `u_${u.id}_${name}`;

  async function setCode(u, code) {
    u.salt = b64(rand(16));
    u.iter = PBKDF2_ITER;
    u.hash = b64(await derive(code, u.salt, u.id, u.iter));
    u.fails = 0;
    u.lockUntil = 0;
    return code;
  }

  async function createUser(rawName, pin) {
    const name = String(rawName || '').trim();
    if (!NAME_RE.test(name)) return { err: 'Username 3-20 karakter: huruf, angka, titik, atau garis bawah.' };
    if (!PIN_RE.test(pin || '')) return { err: PIN_ERR };
    if (findUser(name)) return { err: 'Username sudah dipakai di aplikasi ini.' };
    if (users.length >= MAX_USERS) return { err: `Aplikasi ini sudah berisi ${MAX_USERS} akun. Hapus salah satu lewat menu Control (setelah login) untuk membuat yang baru.` };
    const u = { id: hex(rand(16)), name, key: name.toLowerCase(), created: Date.now(), lastLogin: 0, resetAt: 0, pin: true };
    await setCode(u, pin);
    await newRecovery(u, pin);
    // Pengguna pertama mengambil alih data lama (dari versi tanpa login) supaya tidak hilang.
    if (!users.length) {
      for (const k of LEGACY_KEYS) {
        const v = await kv.get(k);
        if (v != null) { await kv.set(userKey(u, k), v); await kv.del(k); }
      }
    }
    users.push(u);
    await saveUsers();
    return { user: u };
  }

  async function verify(u, code) {
    return same(await derive(code, u.salt, u.id, u.iter || PBKDF2_ITER), unb64(u.hash));
  }

  const lockLeft = (u) => Math.max(0, (u.lockUntil || 0) - Date.now());
  const secs = (ms) => Math.ceil(ms / 1000);
  const GENERIC_ERR = 'Username atau sandi salah.';

  async function tryLogin(name, code) {
    const u = findUser(name);
    if (!u) {
      // Hitungan waktu dibuat mirip supaya username yang ada tidak bisa ditebak dari kecepatan jawaban
      await derive(code || 'x', b64(new Uint8Array(16)), 'none', PBKDF2_ITER);
      return { err: GENERIC_ERR };
    }
    const left = lockLeft(u);
    if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
    if (await verify(u, code)) {
      u.fails = 0; u.lockUntil = 0;
      return { user: u };
    }
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
    await saveUsers();
    const left2 = lockLeft(u);
    return { err: left2 ? `${GENERIC_ERR} Dikunci ${secs(left2)} detik.` : `${GENERIC_ERR} Sisa percobaan: ${FREE_TRIES - u.fails}.` };
  }

  // ---------- DOM kecil ----------
  function h(tag, props = {}, ...kids) {
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
  }

  function mediaEl(rec, url) {
    if (rec && rec.kind === 'video') {
      const v = h('video', { src: url, loop: true, autoplay: true, playsinline: true, 'aria-hidden': 'true' });
      v.muted = true;
      v.setAttribute('muted', '');
      v.addEventListener('canplay', () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); }, { once: true });
      return v;
    }
    return h('img', { src: url, alt: '', draggable: 'false' });
  }

  // ---------- Sesi ----------
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const Auth = {
    ready, media, native, MAX_USERS, NAME_RE,
    user: null,          // {id, name}
    notice: '',          // pesan sesudah login
    key: (name) => (Auth.user ? `u_${Auth.user.id}_${name}` : name),
    rec: '',             // kode pemulihan (hanya di memori, selama sesi)
    logout() { location.reload(); },
    userCount: () => users.length,
    // Ganti sandi: wajib sandi lama. Mengembalikan {ok} atau {err}.
    async changeCode(oldCode, newPin) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      const left = lockLeft(u);
      if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
      if (!(await verify(u, oldCode))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
        await saveUsers();
        return { err: 'Sandi saat ini salah.' };
      }
      if (!PIN_RE.test(newPin || '')) return { err: PIN_ERR };
      const keep = Auth.rec || (await openRec(u, oldCode));
      await setCode(u, newPin);
      u.pin = true;
      Auth.rec = keep || (await newRecovery(u, newPin));
      if (keep) await sealRec(u, newPin, keep);
      await saveUsers();
      return { ok: true };
    },
    // Buat kode pemulihan baru (kode lama tidak berlaku lagi). Wajib sandi. Mengembalikan {code} atau {err}.
    async newRecovery(pin) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      const left = lockLeft(u);
      if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
      if (!(await verify(u, pin))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
        await saveUsers();
        return { err: 'Sandi salah.' };
      }
      Auth.rec = await newRecovery(u, pin);
      await saveUsers();
      return { code: Auth.rec };
    },
    // Hapus akun yang sedang login beserta datanya. Wajib sandi.
    async deleteCurrent(code) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      const left = lockLeft(u);
      if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
      if (!(await verify(u, code))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
        await saveUsers();
        return { err: 'Sandi salah.' };
      }
      await wipeUser(u);
      return { ok: true };
    },
  };
  window.Auth = Auth;

  async function wipeUser(u) {
    for (const k of LEGACY_KEYS) await kv.del(userKey(u, k));
    users = users.filter((x) => x.id !== u.id);
    await saveUsers();
  }

  // Sandi baru lewat kode pemulihan. Data akun tetap. Mengembalikan {ok} atau {err}.
  async function resetByRecovery(name, rcode, newPin) {
    const u = findUser(name);
    if (!u || !u.rhash) { await derive('x', b64(new Uint8Array(16)), 'none', PBKDF2_ITER); return { err: 'Username atau kode pemulihan salah.' }; }
    const left = lockLeft(u);
    if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
    if (!PIN_RE.test(newPin || '')) return { err: PIN_ERR };
    if (!(await verifyRec(u, rcode))) {
      u.fails = (u.fails || 0) + 1;
      if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
      await saveUsers();
      return { err: 'Username atau kode pemulihan salah.' };
    }
    await setCode(u, newPin);
    u.pin = true;
    await sealRec(u, newPin, genRecCodeNorm(rcode));
    u.resetAt = Date.now();
    await saveUsers();
    return { ok: true, user: u };
  }
  const genRecCodeNorm = (c) => { const n = normCode(c); return n.length === REC_LEN ? n.match(/.{4}/g).join('-') : n; };

  // ---------- Layar login ----------
  const root = h('div', { id: 'auth', class: 'auth', role: 'dialog', 'aria-label': 'Login' });
  document.body.classList.add('locked');

  const msg = h('p', { class: 'amsg', role: 'alert', 'aria-live': 'polite' });
  const say = (t, ok) => { msg.textContent = t || ''; msg.classList.toggle('ok', !!ok); };

  function field(id, ph, type, extra = {}) {
    return h('input', { id, class: 'afld', placeholder: ph, 'aria-label': ph, type, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...extra });
  }
  const gbtn = (text, onclick, alt) => h('button', { type: 'button', class: `gbtn${alt ? ' alt' : ''}`, text, onclick });
  const link = (text, onclick) => h('button', { type: 'button', class: 'alink', text, onclick });
  const busy = (btn, on, label) => {
    if (on) { btn.dataset.l = btn.textContent; btn.textContent = label || 'Memproses...'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.l || btn.textContent; btn.disabled = false; }
  };

  // Layar: login
  const inUser = field('aUser', 'Username', 'text', { autocomplete: 'username' });
  const inCode = field('aCode', 'Sandi', 'password', { autocomplete: 'off', maxlength: '12' });
  const eye = h('button', { type: 'button', class: 'aeye', text: 'Lihat', 'aria-label': 'Tampilkan sandi', onclick: () => {
    const show = inCode.type === 'password';
    inCode.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Sembunyi' : 'Lihat';
  } });
  const loginBtn = gbtn('Login', doLogin);
  const sLogin = h('section', { class: 'scr', 'data-s': 'login' },
    h('h2', { text: 'Login' }),
    inUser,
    h('div', { class: 'afrow' }, inCode, eye),
    h('div', { class: 'aside' }, link('Lupa sandi?', () => go('forgot'))),
    loginBtn,
  );

  // Layar: buat akun
  const inNew = field('aNew', 'Pilih username', 'text', { maxlength: '20' });
  const numAttrs = { maxlength: '6', inputmode: 'numeric', pattern: '[0-9]*' };
  const inPin = field('aPin', 'Sandi 6 angka', 'password', numAttrs);
  const inPin2 = field('aPin2', 'Ulangi sandi', 'password', numAttrs);
  const createBtn = gbtn('Buat akun', doCreate);
  const sCreate = h('section', { class: 'scr', 'data-s': 'create' },
    h('h2', { text: 'Buat akun' }),
    inNew,
    inPin,
    inPin2,
    h('p', { class: 'ahint', text: 'Sandi 6 angka buatanmu sendiri. Bisa diganti nanti di menu Control.' }),
    createBtn,
  );

  // Layar: lupa sandi (kode pemulihan; hapus akun hanya sebagai jalan terakhir)
  const inForgot = field('aForgot', 'Username', 'text');
  const inRec = field('aRec', 'Kode pemulihan (XXXX-XXXX-XXXX)', 'text', { autocapitalize: 'characters', maxlength: '14' });
  const inRecPin = field('aRecPin', 'Sandi baru (6 angka)', 'password', numAttrs);
  const inRecPin2 = field('aRecPin2', 'Ulangi sandi baru', 'password', numAttrs);
  const recBtn = gbtn('Atur sandi baru', doRecover);
  const inWipe = field('aWipe', 'Ketik username lagi untuk konfirmasi', 'text');
  const wipeBtn = gbtn('Hapus akun ini & buat ulang', doWipe, true);
  const wipeBox = h('div', { class: 'wipebox', hidden: true }, inWipe, wipeBtn);
  const wipeLink = link('Tidak punya kode pemulihan?', () => { wipeBox.hidden = !wipeBox.hidden; });
  const sForgot = h('section', { class: 'scr', 'data-s': 'forgot' },
    h('h2', { text: 'Lupa sandi' }),
    inForgot,
    inRec,
    inRecPin,
    inRecPin2,
    recBtn,
    h('div', { class: 'aside' }, wipeLink),
    h('p', { class: 'ahint', text: 'Kode pemulihan ada di menu Control (setelah login). Tanpa kode itu, satu-satunya cara: hapus akun (datanya ikut terhapus) lalu buat ulang.' }),
    wipeBox,
  );

  const panel = h('div', { class: 'auth-panel' }, sLogin, sCreate, sForgot, msg,
    h('div', { class: 'abottom' },
      h('span', { class: 'abq', 'data-for': 'login' }, 'Belum punya akun? ', link('Buat akun', () => go('create'))),
      h('span', { class: 'abq', 'data-for': 'create' }, 'Sudah punya akun? ', link('Login', () => go('login'))),
      h('span', { class: 'abq', 'data-for': 'forgot' }, link('Kembali ke login', () => go('login'))),
    ),
  );

  const mediaBg = h('div', { class: 'auth-bg', 'aria-hidden': 'true' });
  const mediaCard = h('div', { class: 'auth-media', 'aria-hidden': 'true' });
  const card = h('div', { class: 'auth-card' },
    mediaCard,
    h('div', { class: 'auth-welcome', text: 'WELCOME' }),
    h('div', { class: 'auth-fade' }),
    panel,
  );
  const foot = h('footer', { class: 'auth-foot' },
    h('img', { class: 'auth-logo', src: 'assets/logo.gif', alt: 'Logo' }),
    h('b', { text: 'ShiroNeko' }),
    h('span', { text: '© Eternals Studio 2026' }),
  );
  root.append(mediaBg, h('div', { class: 'auth-wrap' }, card, foot));

  // Papan angka hanya untuk akun dengan sandi 6 angka (akun lama punya kode huruf+angka)
  inUser.addEventListener('input', () => {
    const u = findUser(inUser.value);
    inCode.setAttribute('inputmode', u && u.pin ? 'numeric' : 'text');
  });

  let screen = 'login';
  let forgotUser = null;
  function go(name) {
    screen = name;
    say('');
    for (const s of panel.querySelectorAll('.scr')) s.hidden = s.dataset.s !== name;
    for (const s of panel.querySelectorAll('.abq')) s.hidden = s.dataset.for !== name;
    if (name === 'login') { inCode.value = ''; inCode.type = 'password'; eye.textContent = 'Lihat'; }
    if (name === 'forgot') { if (!inForgot.value) inForgot.value = inUser.value; inRec.value = ''; inRecPin.value = ''; inRecPin2.value = ''; wipeBox.hidden = true; }
    if (name === 'create') { inNew.value = ''; inPin.value = ''; inPin2.value = ''; }
  }

  async function doLogin() {
    const name = inUser.value.trim();
    const code = inCode.value;
    if (!name || !code) { say('Isi username dan sandi.'); return; }
    busy(loginBtn, true);
    try {
      const r = await tryLogin(name, code);
      if (r.err) { say(r.err); return; }
      await finish(r.user, code);
    } catch (e) {
      console.error(e);
      say('Terjadi kesalahan. Coba lagi.');
    } finally { busy(loginBtn, false); }
  }

  async function doCreate() {
    if (inPin.value !== inPin2.value) { say('Sandi dan ulangi sandi tidak sama.'); return; }
    busy(createBtn, true);
    try {
      const r = await createUser(inNew.value, inPin.value);
      if (r.err) { say(r.err); return; }
      inUser.value = r.user.name;
      inUser.dispatchEvent(new Event('input'));
      go('login');
      say('Akun dibuat. Login dengan sandi kamu.', true);
    } catch (e) {
      console.error(e);
      say('Gagal membuat akun. Coba lagi.');
    } finally { busy(createBtn, false); }
  }

  async function doRecover() {
    if (!inForgot.value.trim() || !inRec.value.trim()) { say('Isi username dan kode pemulihan.'); return; }
    if (inRecPin.value !== inRecPin2.value) { say('Sandi baru dan ulangi tidak sama.'); return; }
    busy(recBtn, true);
    try {
      const r = await resetByRecovery(inForgot.value, inRec.value, inRecPin.value);
      if (r.err) { say(r.err); return; }
      inUser.value = r.user.name;
      inUser.dispatchEvent(new Event('input'));
      go('login');
      say('Sandi baru dipasang. Login dengan sandi baru.', true);
    } catch (e) {
      console.error(e);
      say('Terjadi kesalahan. Coba lagi.');
    } finally { busy(recBtn, false); }
  }

  async function doWipe() {
    const u = findUser(inForgot.value);
    if (!u) { say('Username tidak ditemukan di aplikasi ini.'); return; }
    if (inWipe.value.trim().toLowerCase() !== u.key) { say('Konfirmasi username tidak cocok.'); return; }
    await wipeUser(u);
    inWipe.value = ''; inForgot.value = '';
    go('create');
    say('Akun dihapus. Buat akun baru dengan username yang sama atau yang lain.', true);
  }

  async function finish(u, code) {
    const notice = u.resetAt && u.resetAt > (u.lastLogin || 0)
      ? `Sandi akun ini direset pada ${new Date(u.resetAt).toLocaleString('id-ID')}.` : '';
    u.lastLogin = Date.now();
    Auth.user = { id: u.id, name: u.name };
    Auth.notice = notice;
    // Kode pemulihan: buka dengan sandi yang baru diketik. Akun lama yang belum punya dibuatkan sekarang.
    Auth.rec = (await openRec(u, code)) || '';
    if (!Auth.rec) {
      Auth.rec = await newRecovery(u, code);
      Auth.notice = (notice ? notice + ' ' : '') + 'Kode pemulihan dibuat. Catat di menu Control.';
    }
    await saveUsers();
    root.classList.add('out');
    document.body.classList.remove('locked');
    setTimeout(() => root.remove(), 450);
    resolveReady(Auth.user);
  }

  // Enter = login / aksi utama layar aktif
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    ({ login: doLogin, create: doCreate, forgot: doRecover }[screen] || (() => {}))();
  });

  (async function start() {
    document.body.append(root);
    await loadUsers();
    // Latar: media buatan pengguna, atau gambar bawaan
    const rec = await media.get();
    const url = rec ? URL.createObjectURL(rec.blob) : media.DEFAULT_URL;
    mediaBg.append(mediaEl(rec, url));
    mediaCard.append(mediaEl(rec, url));
    // Belum ada akun sama sekali: langsung ke pembuatan akun
    go(users.length ? 'login' : 'create');
    if (!users.length) say('Belum ada akun. Buat username dulu.', true);
  })();
})();
