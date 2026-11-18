// Memindai halaman claude.ai tiap 3 detik dan melapor ke aplikasi lewat background.js.
// Status yang dilaporkan (satu per pindaian, urutan prioritas), hanya saat berubah kecuali busy:
//   loggedout : halaman login (akun belum login)
//   limit     : banner limit aktif, contoh "You are out of free messages until 4:00 PM",
//               atau popup "Upgrade to keep chatting ... It resets at 2:50 PM"
//   busy      : Claude sedang berpikir / menjalankan command (heartbeat tiap pindaian)
//   reset     : limit sudah selesai, contoh "Stopped by a usage limit. You can try again now" + tombol Try again / Continue
//   resume    : ada tombol "Continue" / "Try again" di chat (tombol Continue di aplikasi jadi hijau)
//   idle      : kolom chat siap dan tidak ada yang berjalan
// Di halaman login, skrip ini juga mengisi email akun secara otomatis.
// Di halaman chat, kalau aplikasi mengirim command (tombol Continue), skrip menekan Continue / Try again atau mengetik command lalu mengirimnya.
// Semua pola ada di bagian atas supaya gampang disesuaikan kalau tampilan claude.ai berubah.
(function () {
  // Banner limit dengan jam reset
  const LIMIT_RE = /(out of (free )?messages|kehabisan pesan)[^\n]{0,40}(until|hingga|sampai)\s+\d{1,2}[:.]\d{2}/i;
  // Popup limit di tengah chat, contoh "Upgrade to keep chatting. You hit your 5-hour message limit. It resets at 2:50 PM"
  const POPUP_RE = /upgrade to keep chatting|you hit your [^\n]{0,40}limit|you've hit your [^\n]{0,40}limit|upgrade untuk terus mengobrol/i;
  // Limit sudah reset
  const RESET_RE = /you can try again now|stopped by a usage limit[^\n]{0,60}try again|dapat mencoba lagi sekarang|bisa coba lagi sekarang/i;
  // Tombol yang menandakan chat bisa dilanjutkan
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
  const COMPOSER_SEL = 'div[contenteditable="true"], textarea, [data-testid="chat-input"]';
  const SEND_SEL = 'button[aria-label*="send" i], button[aria-label*="kirim" i]';
  // Tombol kirim di halaman login. Teks harus persis, jadi "Continue with Google" tidak ikut.
  const EMAIL_BTN_RE = /^(continue with email|continue|log ?in|sign ?in)$/i;

  let lastLimit = '';
  let lastState = '';
  let loginBusy = false;
  let lastEmailAt = 0;
  let cmdBusy = false;     // sedang menjalankan command dari aplikasi
  let cmdFinished = false; // command sudah dijalankan (atau memang tidak ada)
  let cmdText = null;      // null = belum ditanyakan ke aplikasi

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

  async function loginAssist() {
    if (loginBusy) return;
    loginBusy = true;
    try {
      const help = await browser.runtime.sendMessage({ type: 'loginHelp' });
      if (!help) return;
      // Layar email: isi email akun lalu lanjut. Jeda 90 detik supaya email login tidak terkirim berulang.
      const emailEl = pick(EMAIL_SEL);
      if (emailEl && help.email && !emailEl.value && Date.now() - lastEmailAt > 90000) {
        lastEmailAt = Date.now();
        fill(emailEl, String(help.email));
        submitFor(emailEl, EMAIL_BTN_RE);
      }
    } catch (e) { /* abaikan */ } finally { loginBusy = false; }
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Ketik command ke kolom chat lalu kirim
  async function typeAndSend(text) {
    const box = pick('div[contenteditable="true"], textarea');
    if (!box) return false;
    box.focus();
    if (box.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      fill(box, text);
    }
    await sleep(700);
    const send = Array.from(document.querySelectorAll(SEND_SEL)).find((b) => visible(b) && !b.disabled);
    if (send) { send.click(); return true; }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    return true;
  }

  // Tombol Continue di aplikasi: aplikasi membuka chat dan mengirim command lewat skrip ini.
  // Kalau ada tombol Continue / Try again di chat, tombol itu ditekan. Kalau tidak ada, command diketik dan dikirim.
  async function commandAssist() {
    if (cmdBusy || cmdFinished) return;
    cmdBusy = true;
    try {
      if (cmdText === null) {
        const help = await browser.runtime.sendMessage({ type: 'loginHelp' });
        cmdText = help && help.command ? String(help.command) : '';
      }
      if (!cmdText) { cmdFinished = true; return; }
      if (!pick(COMPOSER_SEL)) return;   // chat belum siap, coba lagi pada pindaian berikutnya
      await sleep(1500);                 // beri waktu tombol Continue muncul
      cmdFinished = true;
      if (!clickByText(RESUME_BTN_RE)) await typeAndSend(cmdText);
      send({ type: 'commandDone' });
    } catch (e) { /* abaikan */ } finally { cmdBusy = false; }
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
    // 1b. Popup "Upgrade to keep chatting": limit habis di tengah chat
    const pm = POPUP_RE.exec(t);
    if (pm) {
      const snippet = t.slice(pm.index, pm.index + 320);
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
      commandAssist();
      return;
    }

    // 3b. Tombol Continue / Try again terlihat di chat
    if (hasResumeButton()) {
      if (lastState !== 'resume') report('resume', 'continue button', url);
      lastState = 'resume';
      commandAssist();
      return;
    }

    // 4. Kolom chat siap dan tidak ada apa-apa
    if (pick(COMPOSER_SEL)) {
      if (lastState !== 'idle') report('idle', '', url);
      lastState = 'idle';
      commandAssist();
    }
  }

  setInterval(scan, 3000);
  scan();
})();
