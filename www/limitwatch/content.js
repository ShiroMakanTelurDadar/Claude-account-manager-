// Memindai halaman claude.ai tiap 3 detik dan melapor ke aplikasi lewat background.js.
// Status yang dilaporkan (satu per pindaian, urutan prioritas):
//   limit : banner limit aktif, contoh "You are out of free messages until 4:00 PM"
//   busy  : Claude sedang berpikir / menjalankan command (dikirim ulang tiap pindaian sebagai heartbeat)
//   reset : limit sudah selesai, contoh "Stopped by a usage limit. You can try again now" + tombol Try again / Continue
//   idle  : tidak ada yang berjalan (dikirim sekali saat berpindah dari busy)
// Selain itu: kalau halaman login meminta kode verifikasi, kode yang terbaca aplikasi dari email
// ditempel otomatis ke kolom kodenya.
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

  // Halaman login yang meminta kode dari email
  const CODE_PAGE_RE = /verification code|verify your email|enter (the |your )?(\d-digit |6-digit )?code|check your email|kode verifikasi|masukkan kode|periksa email|cek email/i;
  // Kode yang masuk sampai sekian ms sebelum kolom kode muncul masih dianggap milik permintaan ini
  const CODE_SLACK_MS = 90000;

  let lastLimit = '';
  let lastState = 'idle';
  let codeSeenAt = 0;     // kapan kolom kode pertama terlihat di halaman ini
  let lastFilledAt = 0;   // waktu terima kode yang terakhir ditempel
  let codeBusy = false;

  function send(msg) {
    try { browser.runtime.sendMessage(msg); } catch (e) { /* abaikan */ }
  }

  function visible(el) {
    return !!(el && (el.offsetParent !== null || el.getClientRects().length));
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

  function scan() {
    const body = document.body;
    if (!body) return;
    const t = body.innerText || '';
    const url = location.href;

    // 1. Limit aktif
    const m = LIMIT_RE.exec(t);
    if (m) {
      const snippet = t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
      if (snippet !== lastLimit) {
        lastLimit = snippet;
        send({ type: 'pageState', state: 'limit', text: snippet, url });
      }
      lastState = 'limit';
      return;
    }
    lastLimit = '';

    // 2. Claude sedang bekerja
    if (isBusy()) {
      send({ type: 'pageState', state: 'busy', text: '', url });
      lastState = 'busy';
      return;
    }

    // 3. Limit sudah reset
    if (RESET_RE.test(t) || (LIMIT_WORD_RE.test(t) && hasResumeButton())) {
      if (lastState !== 'reset') send({ type: 'pageState', state: 'reset', text: 'usage limit reset', url });
      lastState = 'reset';
      return;
    }

    // 4. Tidak ada apa-apa
    if (lastState === 'busy') send({ type: 'pageState', state: 'idle', text: '', url });
    lastState = 'idle';
  }

  // ---------- Tempel kode login ----------
  function findCodeInputs() {
    const all = Array.from(document.querySelectorAll('input')).filter((i) =>
      visible(i) && !i.disabled && !i.readOnly && /^(text|tel|number|)$/i.test(i.type || ''));
    const single = all.filter((i) => {
      const hint = [i.autocomplete, i.name, i.id, i.placeholder, i.getAttribute('aria-label') || ''].join(' ');
      return /one-time-code/i.test(i.autocomplete || '')
        || /\b(code|kode|otp)\b|verif/i.test(hint)
        || (i.inputMode === 'numeric' && (i.maxLength < 0 || i.maxLength >= 4));
    });
    if (single.length) return single.slice(0, 1);
    // Kolom kode yang dipecah satu angka per kotak
    const boxes = all.filter((i) => i.maxLength === 1);
    return boxes.length >= 4 ? boxes : [];
  }

  function setValue(inp, v) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(inp, v);
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillCode(inputs, code) {
    if (inputs.length === 1) {
      inputs[0].focus();
      setValue(inputs[0], code);
    } else {
      inputs.forEach((inp, i) => {
        inp.focus();
        setValue(inp, code[i] || '');
      });
    }
  }

  async function codeTick() {
    if (codeBusy) return;
    const inputs = findCodeInputs();
    const t = (document.body && document.body.innerText) || '';
    const isCodePage = inputs.length && (CODE_PAGE_RE.test(t) || /one-time-code/i.test(inputs[0].autocomplete || ''));
    if (!isCodePage) { codeSeenAt = 0; return; }
    if (!codeSeenAt) codeSeenAt = Date.now();
    codeBusy = true;
    try {
      const res = await browser.runtime.sendMessage({ type: 'getCode' });
      if (res && res.code && res.at > lastFilledAt && res.at >= codeSeenAt - CODE_SLACK_MS) {
        fillCode(inputs, String(res.code));
        lastFilledAt = res.at;
      }
    } catch (e) { /* abaikan */ }
    codeBusy = false;
  }

  setInterval(scan, 3000);
  setInterval(codeTick, 1500);
  scan();
})();
