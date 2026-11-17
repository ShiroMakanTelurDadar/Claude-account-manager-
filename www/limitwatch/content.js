// Memindai halaman claude.ai tiap 3 detik dan melapor ke aplikasi lewat background.js.
// Status yang dilaporkan (satu per pindaian, urutan prioritas):
//   limit : banner limit aktif, contoh "You are out of free messages until 4:00 PM"
//   busy  : Claude sedang berpikir / menjalankan command (dikirim ulang tiap pindaian sebagai heartbeat)
//   reset : limit sudah selesai, contoh "Stopped by a usage limit. You can try again now" + tombol Try again / Continue
//   idle  : tidak ada yang berjalan (dikirim sekali saat berpindah dari busy)
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

  let lastLimit = '';
  let lastState = 'idle';

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

  setInterval(scan, 3000);
  scan();
})();
