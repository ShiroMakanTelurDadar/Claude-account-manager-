// Memindai halaman claude.ai. Mengirim potongan teks hanya jika banner limit
// dengan jam reset muncul, contoh: "You are out of free messages until 4:00 PM".
(function () {
  const RE = /(out of (free )?messages|kehabisan pesan)[^\n]{0,40}(until|hingga|sampai)\s+\d{1,2}[:.]\d{2}/i;
  let last = '';

  function scan() {
    const body = document.body;
    if (!body) return;
    const t = body.innerText || '';
    const m = RE.exec(t);
    if (!m) { last = ''; return; }
    const snippet = t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
    if (snippet === last) return;
    last = snippet;
    browser.runtime.sendMessage({ type: 'pageText', text: snippet });
  }

  setInterval(scan, 3000);
  scan();
})();
