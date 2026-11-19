// Sistem login lokal (tanpa server).
// - Banyak pengguna dalam satu aplikasi (MAX_USERS). Data tiap pengguna disimpan terpisah di perangkat.
// - Kode sandi dibuat acak oleh aplikasi dan hanya ditampilkan sekali. Yang disimpan hanya hash (PBKDF2), bukan kodenya.
// - Tiap pengguna punya ID acak tersembunyi. ID ini dipakai untuk nama penyimpanan dan ikut dalam hash,
//   jadi username yang sama yang dibuat ulang tidak akan tertukar dengan data lama.
// - Percobaan salah dibatasi (kunci sementara yang makin lama).
// - Lupa kode: kode lama tidak bisa dilihat lagi. Kode baru dibuat setelah verifikasi sidik jari / PIN HP.
(() => {
  'use strict';

  const Cap = window.Capacitor || {};
  const P = Cap.Plugins || {};
  const native = !!(Cap.isNativePlatform && Cap.isNativePlatform());

  const USERS_KEY = 'auth_users';
  const MAX_USERS = 3;
  const PBKDF2_ITER = 200000;
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 32 huruf/angka, tanpa O 0 I 1 supaya tidak salah baca
  const CODE_LEN = 7;                                     // 7 x 5 bit = 35 bit acak. Makin panjang makin aman (12 = 60 bit).
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

  function genCode() {
    const bytes = rand(CODE_LEN);
    let s = '';
    for (const b of bytes) s += ALPHABET[b & 31];        // 256 habis dibagi 32, jadi tidak bias
    return CODE_LEN > 8 ? s.match(/.{1,4}/g).join('-') : s;
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

  async function setCode(u) {
    const code = genCode();
    u.salt = b64(rand(16));
    u.iter = PBKDF2_ITER;
    u.hash = b64(await derive(code, u.salt, u.id, u.iter));
    u.fails = 0;
    u.lockUntil = 0;
    return code;
  }

  async function createUser(rawName) {
    const name = String(rawName || '').trim();
    if (!NAME_RE.test(name)) return { err: 'Username 3-20 karakter: huruf, angka, titik, atau garis bawah.' };
    if (findUser(name)) return { err: 'Username sudah dipakai di aplikasi ini.' };
    if (users.length >= MAX_USERS) return { err: `Aplikasi ini sudah berisi ${MAX_USERS} akun. Hapus salah satu lewat menu Control (setelah login) untuk membuat yang baru.` };
    const u = { id: hex(rand(16)), name, key: name.toLowerCase(), created: Date.now(), bio: false, bioAsked: false, lastLogin: 0, resetAt: 0 };
    const code = await setCode(u);
    // Pengguna pertama mengambil alih data lama (dari versi tanpa login) supaya tidak hilang.
    if (!users.length) {
      for (const k of LEGACY_KEYS) {
        const v = await kv.get(k);
        if (v != null) { await kv.set(userKey(u, k), v); await kv.del(k); }
      }
    }
    users.push(u);
    await saveUsers();
    return { code, user: u };
  }

  async function verify(u, code) {
    return same(await derive(code, u.salt, u.id, u.iter || PBKDF2_ITER), unb64(u.hash));
  }

  const lockLeft = (u) => Math.max(0, (u.lockUntil || 0) - Date.now());
  const secs = (ms) => Math.ceil(ms / 1000);
  const GENERIC_ERR = 'Username atau kode salah.';

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

  // ---------- Verifikasi perangkat (sidik jari / PIN HP) ----------
  const DA = () => P.DeviceAuth;
  async function deviceAvailable() {
    try { return !!(DA() && (await DA().status()).available); } catch { return false; }
  }
  async function deviceVerify(title, subtitle) {
    try {
      await DA().authenticate({ title, subtitle });
      return true;
    } catch { return false; }
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
    user: null,          // {id, name, bio}
    notice: '',          // pesan sesudah login (mis. kode pernah direset)
    key: (name) => (Auth.user ? `u_${Auth.user.id}_${name}` : name),
    deviceAvailable, deviceVerify,
    logout() { location.reload(); },
    userCount: () => users.length,
    async setBio(on) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return false;
      if (on && !(await deviceVerify('Aktifkan masuk cepat', 'Verifikasi dengan sidik jari / PIN HP'))) return false;
      u.bio = !!on; u.bioAsked = true;
      await saveUsers();
      Auth.user.bio = u.bio;
      return true;
    },
    // Ganti kode: wajib kode lama. Mengembalikan {code} atau {err}.
    async changeCode(oldCode) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      const left = lockLeft(u);
      if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
      if (!(await verify(u, oldCode))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
        await saveUsers();
        return { err: 'Kode saat ini salah.' };
      }
      const code = await setCode(u);
      await saveUsers();
      return { code };
    },
    // Kode baru lewat verifikasi sidik jari / PIN HP, tanpa kode lama. Mengembalikan {code} atau {err}.
    async newCodeByDevice() {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      if (!(await deviceVerify('Buat kode baru', 'Verifikasi dengan sidik jari / PIN HP'))) return { err: 'Verifikasi dibatalkan atau gagal.' };
      const code = await setCode(u);
      await saveUsers();
      return { code };
    },
    // Hapus akun yang sedang login beserta datanya. Wajib kode.
    async deleteCurrent(code) {
      const u = users.find((x) => x.id === Auth.user.id);
      if (!u) return { err: 'Akun tidak ditemukan.' };
      const left = lockLeft(u);
      if (left) return { err: `Terlalu banyak percobaan. Coba lagi dalam ${secs(left)} detik.` };
      if (!(await verify(u, code))) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= FREE_TRIES) u.lockUntil = Date.now() + Math.min(LOCK_MAX, LOCK_BASE * 2 ** (u.fails - FREE_TRIES));
        await saveUsers();
        return { err: 'Kode salah.' };
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
  const inCode = field('aCode', 'Kode sandi', 'password', { autocomplete: 'off' });
  const eye = h('button', { type: 'button', class: 'aeye', text: 'Lihat', 'aria-label': 'Tampilkan kode', onclick: () => {
    const show = inCode.type === 'password';
    inCode.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Sembunyi' : 'Lihat';
  } });
  const loginBtn = gbtn('Login', doLogin);
  const bioBtn = gbtn('Masuk dengan sidik jari / PIN HP', doBio, true);
  bioBtn.hidden = true;
  const sLogin = h('section', { class: 'scr', 'data-s': 'login' },
    h('h2', { text: 'Login' }),
    inUser,
    h('div', { class: 'afrow' }, inCode, eye),
    h('div', { class: 'aside' }, link('Lupa kode?', () => go('forgot'))),
    loginBtn, bioBtn,
  );

  // Layar: buat akun
  const inNew = field('aNew', 'Pilih username', 'text', { maxlength: '20' });
  const createBtn = gbtn('Buat akun', doCreate);
  const sCreate = h('section', { class: 'scr', 'data-s': 'create' },
    h('h2', { text: 'Buat akun' }),
    inNew,
    h('p', { class: 'ahint', text: 'Setelah itu aplikasi membuat kode sandi acak untukmu. Kode hanya tampil satu kali.' }),
    createBtn,
  );

  // Layar: tampilkan kode (sekali)
  const codeBox = h('div', { class: 'codebox', 'aria-live': 'polite' });
  const codeTitle = h('h2');
  const savedChk = h('input', { type: 'checkbox', id: 'aSaved' });
  const codeNext = gbtn('Lanjut ke login', () => { codeBox.textContent = ''; go('login'); });
  codeNext.disabled = true;
  savedChk.addEventListener('change', () => { codeNext.disabled = !savedChk.checked; });
  const copyBtn = gbtn('Salin kode', async () => {
    try { await navigator.clipboard.writeText(codeBox.dataset.v || ''); say('Kode disalin.', true); } catch { say('Gagal menyalin. Catat kodenya secara manual.'); }
  }, true);
  const sCode = h('section', { class: 'scr', 'data-s': 'code' },
    codeTitle,
    codeBox,
    h('p', { class: 'ahint warn', text: 'Catat kode ini sekarang. Aplikasi tidak menyimpan kodenya dan tidak bisa menampilkannya lagi.' }),
    copyBtn,
    h('label', { class: 'achk' }, savedChk, h('span', { text: 'Saya sudah menyimpan kode ini' })),
    codeNext,
  );

  // Layar: lupa kode
  const inForgot = field('aForgot', 'Username', 'text');
  const inWipe = field('aWipe', 'Ketik username lagi untuk konfirmasi', 'text');
  const forgotBtn = gbtn('Verifikasi & buat kode baru', doForgot);
  const wipeBtn = gbtn('Hapus akun ini & buat ulang', doWipe, true);
  const forgotInfo = h('p', { class: 'ahint' });
  const sForgot = h('section', { class: 'scr', 'data-s': 'forgot' },
    h('h2', { text: 'Lupa kode' }),
    inForgot,
    forgotInfo,
    forgotBtn,
    inWipe, wipeBtn,
  );

  const panel = h('div', { class: 'auth-panel' }, sLogin, sCreate, sCode, sForgot, msg,
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

  let screen = 'login';
  let forgotUser = null;
  function go(name) {
    screen = name;
    say('');
    for (const s of panel.querySelectorAll('.scr')) s.hidden = s.dataset.s !== name;
    for (const s of panel.querySelectorAll('.abq')) s.hidden = s.dataset.for !== name;
    if (name === 'login') { inCode.value = ''; inCode.type = 'password'; eye.textContent = 'Lihat'; refreshBio(); }
    if (name === 'forgot') prepForgot();
    if (name === 'create') inNew.value = '';
  }

  function showCode(title, code) {
    codeTitle.textContent = title;
    codeBox.textContent = code;
    codeBox.dataset.v = code;
    savedChk.checked = false;
    codeNext.disabled = true;
    go('code');
    codeBox.textContent = code;
    for (const s of panel.querySelectorAll('.abq')) s.hidden = true;
  }

  async function refreshBio() {
    bioBtn.hidden = true;
    if (!users.some((u) => u.bio)) return;
    if (await deviceAvailable()) bioBtn.hidden = screen !== 'login';
  }

  async function doLogin() {
    const name = inUser.value.trim();
    const code = inCode.value;
    if (!name || !code) { say('Isi username dan kode sandi.'); return; }
    busy(loginBtn, true);
    try {
      const r = await tryLogin(name, code);
      if (r.err) { say(r.err); return; }
      await finish(r.user, true);
    } catch (e) {
      console.error(e);
      say('Terjadi kesalahan. Coba lagi.');
    } finally { busy(loginBtn, false); }
  }

  async function doBio() {
    let u = findUser(inUser.value);
    if (!u) {
      const list = users.filter((x) => x.bio);
      if (list.length === 1) u = list[0];
      else { say('Isi username dulu, lalu tekan tombol ini.'); return; }
    }
    if (!u.bio) { say('Masuk cepat belum diaktifkan untuk akun ini. Login dengan kode dulu, lalu aktifkan di menu Control.'); return; }
    const ok = await deviceVerify('Masuk sebagai ' + u.name, 'Verifikasi dengan sidik jari / PIN HP');
    if (!ok) { say('Verifikasi dibatalkan atau gagal.'); return; }
    await finish(u, false);
  }

  async function doCreate() {
    busy(createBtn, true);
    try {
      const r = await createUser(inNew.value);
      if (r.err) { say(r.err); return; }
      inUser.value = r.user.name;
      showCode('Kode sandi kamu', r.code);
    } catch (e) {
      console.error(e);
      say('Gagal membuat akun. Coba lagi.');
    } finally { busy(createBtn, false); }
  }

  async function prepForgot() {
    const avail = await deviceAvailable();
    forgotInfo.textContent = avail
      ? 'Kode lama tidak bisa dilihat lagi karena tidak disimpan. Verifikasi dengan sidik jari / PIN HP, lalu aplikasi membuat kode baru. Data akun tetap ada.'
      : 'HP ini tidak punya sidik jari atau kunci layar yang bisa dipakai, jadi kode baru tidak bisa dibuat dengan aman. Satu-satunya cara: hapus akun ini (datanya ikut terhapus) lalu buat ulang.';
    forgotBtn.hidden = !avail;
    inWipe.hidden = avail;
    wipeBtn.hidden = avail;
    if (!inForgot.value) inForgot.value = inUser.value;
  }

  async function doForgot() {
    const u = findUser(inForgot.value);
    if (!u) { say('Username tidak ditemukan di aplikasi ini.'); return; }
    if (!(await deviceVerify('Buat kode baru untuk ' + u.name, 'Verifikasi dengan sidik jari / PIN HP'))) { say('Verifikasi dibatalkan atau gagal.'); return; }
    busy(forgotBtn, true);
    try {
      const code = await setCode(u);
      u.resetAt = Date.now();
      await saveUsers();
      inUser.value = u.name;
      showCode('Kode baru kamu', code);
    } catch (e) {
      console.error(e);
      say('Gagal membuat kode baru. Coba lagi.');
    } finally { busy(forgotBtn, false); }
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

  async function finish(u, byCode) {
    const notice = u.resetAt && u.resetAt > (u.lastLogin || 0)
      ? `Kode akun ini direset pada ${new Date(u.resetAt).toLocaleString('id-ID')}.` : '';
    u.lastLogin = Date.now();
    await saveUsers();
    Auth.user = { id: u.id, name: u.name, bio: !!u.bio };
    Auth.notice = notice;
    // Tawarkan masuk cepat sekali saja, sesudah login dengan kode
    if (byCode && !u.bio && !u.bioAsked && (await deviceAvailable())) {
      u.bioAsked = true;
      await saveUsers();
      if (confirm('Aktifkan masuk cepat dengan sidik jari / PIN HP untuk akun ini?\n\nKode sandi tetap berlaku. Ini bisa diubah di menu Control.')) {
        if (await deviceVerify('Aktifkan masuk cepat', 'Verifikasi dengan sidik jari / PIN HP')) {
          u.bio = true; Auth.user.bio = true;
          await saveUsers();
        }
      }
    }
    root.classList.add('out');
    document.body.classList.remove('locked');
    setTimeout(() => root.remove(), 450);
    resolveReady(Auth.user);
  }

  // Enter = login / aksi utama layar aktif
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    ({ login: doLogin, create: doCreate, forgot: doForgot }[screen] || (() => {}))();
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
