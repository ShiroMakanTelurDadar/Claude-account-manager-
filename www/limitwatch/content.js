// Memindai halaman claude.ai tiap 3 detik dan melapor ke aplikasi lewat background.js.
// Status yang dilaporkan (satu per pindaian, urutan prioritas), hanya saat berubah kecuali busy:
//   loggedout : halaman login (akun belum login)
//   limit     : banner limit aktif, contoh "You are out of free messages until 4:00 PM"
//   busy      : Claude sedang berpikir / menjalankan command (heartbeat tiap pindaian)
//   reset     : limit sudah selesai, contoh "Stopped by a usage limit. You can try again now" + tombol Try again / Continue
//   idle      : kolom chat siap dan tidak ada yang berjalan
// Di halaman login, skrip ini juga mengisi email akun dan kode verifikasi (dari notifikasi Gmail) secara otomatis.
// Semua pola ada di bagian atas supaya gampang disesuaikan kalau tampilan claude.ai berubah.
(function () {
  // Banner limit dengan jam reset
  const LIMIT_RE = /(out of (free )?messages|kehabisan pesan)[^\n]{0,40}(until|hingga|sampai)\s+\d{1,2}[:.]\d{2}/i;
  // Limit sudah reset
  const RESET_RE = /you can try again now|stopped by a usage limit[^\n]{0,60}try again|dapat mencoba lagi sekarang|bisa coba lagi sekarang/i;
  // Tombol yang menandakan chat bisa dilanjutkan (hanya dihitung kalau halaman menyebut usage limit)
  const RESUME_BTN_RE = /^(try again|continue|coba lagi|lanjutkan)$/i;
  const LIMIT_WORD_RE = /usage limit|batas penggunaan/i;
  // Tombol yang muncul selama Claude bekerja (tombol kirim berubah jadi kotak stop)
  const STOP_LABEL_RE = /^(stop|stop response|stop generating|stop task|interrupt|hentikan)\b/i;
  // Teks status yang berdiri sendiri saat Claude bekerja, contoh "Working on it" atau "Run command".
  // Harus satu teks utuh, supaya kalimat "working on it" di dalam pesan chat tidak ikut terhitung.
  // "Ran 5 commands" (sudah selesai) sengaja tidak cocok.
  const BUSY_TEXT_RE = /^(working on it|thinking|run(ning)? (a |\d+ )?commands?|sedang bekerja|sedang berpikir|menjalankan perintah)\s*(\.{2,}|…)?$/i;

  // Halaman dan kolom login
  const LOGIN_PATH_RE = /^\/(login|logout|signup|sign-in)/i;
  const EMAIL_SEL = 'input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"]';
  const CODE_SEL = 'input[autocomplete="one-time-code"], input[name*="code" i], input[placeholder*="code" i], input[inputmode="numeric"]';
  const COMPOSER_SEL = 'div[contenteditable="true"], textarea, [data-testid="chat-input"]';
  // Tombol kirim di halaman login. Teks harus persis, jadi "Continue with Google" tidak ikut.
  const EMAIL_BTN_RE = /^(continue with email|continue|log ?in|sign ?in)$/i;
  const CODE_BTN_RE = /^(continue|verify|log ?in|sign ?in|submit)$/i;

  let lastLimit = '';
  let lastState = '';
  let loginBusy = false;
  let lastEmailAt = 0;

  function send(msg) {
    try { browser.runtime.sendMessage(msg); } catch (e) { /* abaikan */ }
  }

  function visible(el) {
    if (!el) return false;
    // Sesi latar belakang (pengecekan akun) tidak punya layar: ukuran viewport 0, anggap terlihat
    if (window.innerWidth === 0 || window.innerHeight === 0) return true;
    return el.offsetParent !== null || el.getClientRects().length > 0;
  }

  function pick(sel) {
    const list = document.querySelectorAll(sel);
    for (const e of list) if (visible(e)) return e;
    return null;
  }

  function hasResumeButton() {
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const t = (b.innerText || b.textContent || '').trim();
      if (RESUME_BTN_RE.test(t) && visible(b)) return true;
    }
    return false;
  }

  function hasBusyText() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').trim();
      if (t.length > 0 && t.length < 30 && BUSY_TEXT_RE.test(t) && visible(n.parentElement)) return true;
    }
    return false;
  }

  function isBusy() {
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    if (hasBusyText()) return true;
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
      if (label && STOP_LABEL_RE.test(label) && visible(b)) return true;
    }
    return false;
  }

  function isLoginPage() {
    if (LOGIN_PATH_RE.test(location.pathname)) return true;
    return !!pick(EMAIL_SEL) && !pick(COMPOSER_SEL);
  }

  // ---------- Login otomatis ----------
  // Isi kolom dengan cara yang dikenali React: setter bawaan lalu event input
  function fill(el, v) {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    if (desc && desc.set) desc.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function clickByText(re) {
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const t = (b.innerText || b.textContent || '').trim();
      if (re.test(t) && visible(b) && !b.disabled) { b.click(); return true; }
    }
    return false;
  }

  function submitFor(inputEl, re) {
    setTimeout(() => {
      if (clickByText(re)) return;
      const form = inputEl.form;
      if (form && form.requestSubmit) { form.requestSubmit(); return; }
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }, 500);
  }

  // Kode 6 digit bisa berupa satu kolom atau enam kotak satu digit
  function fillCode(code) {
    const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]')).filter(visible);
    if (boxes.length >= code.length) {
      for (let i = 0; i < code.length; i++) fill(boxes[i], code[i]);
      return true;
    }
    const one = pick(CODE_SEL);
    if (!one) return false;
    fill(one, code);
    submitFor(one, CODE_BTN_RE);
    return true;
  }

  async function loginAssist() {
    if (loginBusy) return;
    loginBusy = true;
    try {
      const help = await browser.runtime.sendMessage({ type: 'loginHelp' });
      if (!help) return;
      // Layar kode: isi kode terbaru dari Gmail (atau dari clipboard bila persis 6 digit)
      const hasCodeField = !!pick(CODE_SEL) || document.querySelectorAll('input[maxlength="1"]').length >= 6;
      if (hasCodeField && help.code) { fillCode(String(help.code)); return; }
      // Layar email: isi email akun lalu lanjut. Jeda 90 detik supaya email login tidak terkirim berulang.
      const emailEl = pick(EMAIL_SEL);
      if (emailEl && help.email && !emailEl.value && Date.now() - lastEmailAt > 90000) {
        lastEmailAt = Date.now();
        fill(emailEl, String(help.email));
        submitFor(emailEl, EMAIL_BTN_RE);
      }
    } catch (e) { /* abaikan */ } finally { loginBusy = false; }
  }

  function report(state, text, url) {
    send({ type: 'pageState', state, text: text || '', url });
  }

  function scan() {
    const body = document.body;
    if (!body) return;
    const t = body.innerText || '';
    const url = location.href;

    // 0. Belum login
    if (isLoginPage()) {
      if (lastState !== 'loggedout') report('loggedout', 'login', url);
      lastState = 'loggedout';
      loginAssist();
      return;
    }

    // 1. Limit aktif
    const m = LIMIT_RE.exec(t);
    if (m) {
      const snippet = t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
      if (snippet !== lastLimit) {
        lastLimit = snippet;
        report('limit', snippet, url);
      }
      lastState = 'limit';
      return;
    }
    lastLimit = '';

    // 2. Claude sedang bekerja
    if (isBusy()) {
      report('busy', '', url);
      lastState = 'busy';
      return;
    }

    // 3. Limit sudah reset
    if (RESET_RE.test(t) || (LIMIT_WORD_RE.test(t) && hasResumeButton())) {
      if (lastState !== 'reset') report('reset', 'usage limit reset', url);
      lastState = 'reset';
      return;
    }

    // 4. Kolom chat siap dan tidak ada apa-apa
    if (pick(COMPOSER_SEL)) {
      if (lastState !== 'idle') report('idle', '', url);
      lastState = 'idle';
    }
  }

  setInterval(scan, 3000);
  scan();
})();
