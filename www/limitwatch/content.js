// Memindai halaman claude.ai tiap 3 detik dan melapor ke aplikasi lewat background.js.
// Status yang dilaporkan (satu per pindaian, urutan prioritas), hanya saat berubah kecuali busy:
//   loggedout : halaman login (akun belum login)
//   limit     : banner limit aktif, contoh "You are out of free messages until 4:00 PM",
//               atau popup "Upgrade to keep chatting ... It resets at 2:50 PM"
//   busy      : Claude sedang berpikir / menjalankan command (heartbeat tiap pindaian)
//   reset     : limit sudah selesai, contoh "Stopped by a usage limit. You can try again now" + tombol Try again / Continue
//   resume    : ada tombol "Continue" / "Try again" di chat (tombol Continue di aplikasi jadi hijau)
//   idle      : kolom chat siap dan tidak ada yang berjalan
// Halaman login dikenali dari teks header (LOGIN_HEAD_RE). Lalu kolom email dicari lewat teks "Masukkan email Anda" (EMAIL_PROMPT_RE)
// dan diisi dengan email akun dari aplikasi. Hanya diisi (paste), tidak ditekan Continue: link login dari email tetap dibuka manual.
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
  // Teks header yang menandakan halaman login, dan teks di dekat kolom email
  const LOGIN_HEAD_RE = /AI untuk pemecahan masalah|AI for problem[- ]solving/i;
  const EMAIL_PROMPT_RE = /Masukkan email Anda|Enter your email/i;
  const EMAIL_SEL = 'input[type="email"], input[name="email"], input[autocomplete="email"], input[autocomplete="username"]';
  const COMPOSER_SEL = 'div[contenteditable="true"], textarea, [data-testid="chat-input"]';
  const SEND_SEL = 'button[aria-label*="send" i], button[aria-label*="kirim" i]';
  // Tombol kirim di halaman login. Teks harus persis, jadi "Continue with Google" tidak ikut.
  const EMAIL_BTN_RE = /^(continue with email|continue|log ?in|sign ?in)$/i;

  let lastLimit = '';
  let lastState = '';
  let loginBusy = false;
  const filledEls = new WeakSet();   // kolom yang sudah diisi, supaya tidak menimpa ketikan pengguna
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

  // Teks header halaman (tagline login ada di sini), atau 600 huruf pertama bila tidak ada elemen header
  function headerText() {
    let t = '';
    for (const e of document.querySelectorAll('header, [role="banner"], h1, h2')) t += ' ' + (e.innerText || e.textContent || '');
    return t || (document.body.innerText || '').slice(0, 600);
  }

  function isLoginPage() {
    if (LOGIN_HEAD_RE.test(headerText())) return true;
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

  const TEXT_INPUT_SEL = 'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"]):not([type="button"])';

  // Kolom email: cari lewat teks "Masukkan email Anda" (placeholder, label, atau teks di dekat kolom), lalu selector biasa
  function findEmailInput() {
    for (const el of document.querySelectorAll(TEXT_INPUT_SEL)) {
      const hint = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '');
      if (EMAIL_PROMPT_RE.test(hint) && visible(el)) return el;
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.nodeValue || '').trim();
      if (!t || t.length > 80 || !EMAIL_PROMPT_RE.test(t) || !visible(n.parentElement)) continue;
      let box = n.parentElement;
      for (let i = 0; box && i < 5; i++, box = box.parentElement) {
        const inp = box.querySelector(TEXT_INPUT_SEL);
        if (inp && visible(inp)) return inp;
      }
    }
    return pick(EMAIL_SEL);
  }

  async function loginAssist() {
    if (loginBusy) return;
    loginBusy = true;
    try {
      const help = await browser.runtime.sendMessage({ type: 'loginHelp' });
      if (!help) return;
      // Layar email: isi email akun (paste saja, tidak menekan tombol lanjut)
      const emailEl = findEmailInput();
      if (emailEl && help.email && !emailEl.value && !filledEls.has(emailEl)) {
        filledEls.add(emailEl);
        fill(emailEl, String(help.email));
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

  // ---------- Pancingan ----------
  // Dijalankan hanya di sesi latar belakang yang diminta aplikasi (loginHelp -> bait = 'send' atau 'verify').
  //  send   : buka chat baru, ketik ".", kirim, tekan Stop secepat mungkin, lalu laporkan limit / free.
  //  verify : buka lagi chat pancingan, baca apakah ada status limit di sana, lalu hapus chat itu.
  let baitAsked = false;    // mode pancingan sudah ditanyakan ke aplikasi
  let baitStarted = false;  // pancingan sudah mulai jalan di halaman ini

  // Teks status limit yang sedang tampil di halaman ('' kalau tidak ada)
  function limitText() {
    const t = (document.body && document.body.innerText) || '';
    let m = LIMIT_RE.exec(t);
    if (m) return t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20);
    m = POPUP_RE.exec(t);
    if (m) return t.slice(m.index, m.index + 320);
    return '';
  }

  function findStopButton() {
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
      if (label && STOP_LABEL_RE.test(label) && visible(b)) return b;
    }
    return null;
  }

  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step || 100);
    }
  }

  function chatId() {
    const m = /^\/chat\/([0-9a-f-]{8,})/i.exec(location.pathname);
    return m ? m[1] : '';
  }

  function baitDone(mode, outcome, text, deleted) {
    send({ type: 'baitResult', mode, outcome, text: text || '', url: location.href, deleted: !!deleted });
  }

  // ---- Alat bantu pancingan ----
  // Kolom chat yang sebenarnya. Di sesi latar belakang semua elemen dianggap "terlihat", jadi textarea atau
  // contenteditable tersembunyi bisa terpilih lebih dulu. Karena itu kolom chat utama diprioritaskan.
  function findComposer() {
    const prefs = ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea'];
    for (const sel of prefs) {
      for (const e of document.querySelectorAll(sel)) {
        if (e.disabled || e.readOnly || e.getAttribute('aria-hidden') === 'true') continue;
        const t = e.matches('[contenteditable="true"], textarea') ? e : e.querySelector('[contenteditable="true"], textarea');
        if (t && visible(t)) return t;
      }
    }
    return null;
  }

  function composerText(box) {
    if (!box || !box.isConnected) return '';
    const v = box.tagName === 'TEXTAREA' ? box.value : (box.innerText || box.textContent || '');
    return String(v).replace(/[\u200b\s]+/g, '');
  }

  // Masukkan teks ke kolom chat, lalu pastikan benar-benar masuk. Mencoba beberapa cara berurutan.
  async function putText(box, text) {
    const has = () => composerText(box).includes(text);
    box.focus();
    if (!box.isContentEditable) { fill(box, text); await sleep(200); return has(); }
    // Cara 1: perintah editor bawaan browser (butuh dokumen terfokus)
    try { const sel = window.getSelection(); if (sel) sel.selectAllChildren(box); } catch (e) { /* abaikan */ }
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, text);
    await sleep(250);
    if (has()) return true;
    // Cara 2: event beforeinput yang dikenali editor ProseMirror
    box.focus();
    try { box.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true })); } catch (e) { /* abaikan */ }
    await sleep(250);
    if (has()) return true;
    // Cara 3: tulis langsung ke isi kolom lalu beri tahu editor lewat event input
    box.innerHTML = '';
    const p = document.createElement('p');
    p.textContent = text;
    box.appendChild(p);
    try { box.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true })); }
    catch (e) { box.dispatchEvent(new Event('input', { bubbles: true })); }
    await sleep(350);
    return has();
  }

  function findSendBtn() {
    return Array.from(document.querySelectorAll(SEND_SEL))
      .find((b) => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true') || null;
  }

  function pressEnter(box) {
    box.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      box.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Laporan gagal membawa kode alasan ("why:...") supaya penyebabnya tampil di riwayat aplikasi
  function baitFail(code) { baitDone('send', 'fail', 'why:' + code); }

  // Teks balasan Claude yang sudah mulai muncul ('' kalau belum ada huruf sama sekali)
  const REPLY_SELS = ['[data-is-streaming="true"]', '[data-testid="assistant-message"]', '.font-claude-response', '.font-claude-message'];
  function replyText() {
    for (const sel of REPLY_SELS) {
      for (const e of document.querySelectorAll(sel)) {
        const t = (e.innerText || e.textContent || '').replace(/[\u200b\s]+/g, '');
        if (t.length > 0) return t;
      }
    }
    return '';
  }

  // Kirim "." ke chat baru. Tunggu sampai Claude benar-benar membalas (sesedikit apa pun hurufnya), lalu langsung Stop.
  // Popup upgrade / banner limit muncul = akun limit. Ada balasan = akun free. Tidak ada keduanya sampai batas waktu = gagal.
  async function baitSend() {
    const box = await waitFor(findComposer, 30000, 150);
    if (!box) {
      if (isLoginPage()) baitDone('send', 'loggedout', '');
      else baitFail('no-composer');
      return;
    }
    await sleep(600);   // beri waktu banner limit muncul
    const pre = limitText();
    if (pre) { baitDone('send', 'limit', pre); return; }   // sudah limit sebelum kirim

    if (!(await putText(box, '.'))) { baitFail('text-not-inserted'); return; }

    // Kirim: tombol kirim dulu, kalau belum aktif pakai Enter
    let method = 'button';
    const btn = await waitFor(findSendBtn, 3000, 50);
    if (btn) btn.click();
    else { method = 'enter'; pressEnter(box); }

    // Pindai cepat. Urutan keputusan tiap putaran:
    //  1. popup upgrade / banner limit  -> limit
    //  2. ada huruf balasan Claude      -> tekan Stop segera -> free
    //  3. tombol Stop sudah lama tampil tapi balasan tidak terbaca (tampilan berubah) -> Stop -> free
    // Pesan yang belum terkirim sesudah 2,5 detik dicoba dengan cara kirim yang satunya (sekali).
    const sentAt = Date.now();
    const WAIT_REPLY = 40000;   // batas tunggu respon Claude sesudah kirim
    let submittedAt = 0;
    let stopSeenAt = 0;
    let retried = false;
    let verdict = '';
    let lim = '';
    for (let i = 0; Date.now() - sentAt < WAIT_REPLY; i++) {
      lim = limitText();
      if (lim) { verdict = 'limit'; break; }
      if (!submittedAt && (chatId() || !composerText(box))) submittedAt = Date.now();
      if (replyText()) { verdict = 'free'; break; }
      const stop = findStopButton();
      if (stop) {
        submittedAt = submittedAt || Date.now();
        stopSeenAt = stopSeenAt || Date.now();
        if (Date.now() - stopSeenAt > 12000) { verdict = 'free'; break; }
      }
      if (!submittedAt && !retried && Date.now() - sentAt > 2500) {
        retried = true;
        const b2 = findSendBtn();
        if (method === 'enter' && b2) b2.click();
        else pressEnter(box);
      }
      await sleep(30);
    }
    if (verdict === 'free') {
      // Hentikan balasan secepatnya. Limit kadang baru tampil sesaat sesudah Stop, jadi cek sekali lagi.
      const stop = findStopButton();
      if (stop) stop.click();
      await sleep(500);
      lim = limitText();
      if (lim) verdict = 'limit';
    }
    if (verdict === 'limit') { baitDone('send', 'limit', lim); return; }
    // Tunggu alamat chat baru (/chat/...) supaya bisa dibuka lagi dan dihapus nanti
    await waitFor(() => chatId(), 4000, 100);
    if (verdict === 'free') baitDone('send', 'free', '');
    else baitFail(submittedAt ? 'no-response' : 'not-submitted');
  }

  // Continue otomatis di sesi tersembunyi: tekan Continue / Try again kalau ada, kalau tidak ketik command lalu kirim.
  // Sesudah terkirim, halaman dibiarkan hidup beberapa detik supaya pesan pasti sampai ke server (respon Claude TIDAK dihentikan).
  async function baitContinue(cmd) {
    const box = await waitFor(findComposer, 20000, 150);
    if (!box) {
      if (isLoginPage()) baitDone('continue', 'loggedout', '');
      else baitFail('no-composer');
      return;
    }
    await sleep(1500);   // beri waktu banner limit dan tombol Continue muncul
    const pre = limitText();
    if (pre) { baitDone('continue', 'limit', pre); return; }   // masih limit: jangan kirim

    let method = 'button';
    if (clickByText(RESUME_BTN_RE)) {
      method = 'resume';
    } else {
      if (!cmd) { baitFail('no-command'); return; }
      if (!(await putText(box, cmd))) { baitFail('text-not-inserted'); return; }
      const btn = await waitFor(findSendBtn, 3000, 50);
      if (btn) btn.click();
      else { method = 'enter'; pressEnter(box); }
    }

    // Tunggu bukti terkirim: Claude mulai bekerja, atau kolom chat kosong, atau muncul limit
    const sentAt = Date.now();
    let submittedAt = 0;
    let retried = false;
    for (;;) {
      const now = Date.now();
      if (now - sentAt > 9000) break;
      const lim = limitText();
      if (lim) { baitDone('continue', 'limit', lim); return; }
      if (isBusy()) { submittedAt = now; break; }
      if (method !== 'resume' && !submittedAt && (chatId() !== '' && !composerText(box))) submittedAt = now;
      if (method !== 'resume' && !submittedAt && !composerText(box)) submittedAt = now;
      if (submittedAt) break;
      if (!retried && now - sentAt > 3000) {
        retried = true;
        if (method === 'resume') clickByText(RESUME_BTN_RE);
        else if (method === 'enter') { const b2 = findSendBtn(); if (b2) b2.click(); else pressEnter(box); }
        else pressEnter(box);
      }
      await sleep(200);
    }
    if (!submittedAt) { baitFail('not-submitted'); return; }
    await sleep(4000);   // biarkan permintaan sampai ke server
    const lim2 = limitText();
    if (lim2) { baitDone('continue', 'limit', lim2); return; }
    baitDone('continue', 'sent', '');
  }

  // Hapus chat lewat API claude.ai (cara utama)
  async function deleteChatApi(id) {
    try {
      const res = await fetch('/api/organizations', { credentials: 'include' });
      if (!res.ok) return false;
      const orgs = await res.json();
      for (const o of (Array.isArray(orgs) ? orgs : [])) {
        if (!o || !o.uuid) continue;
        const r = await fetch('/api/organizations/' + o.uuid + '/chat_conversations/' + id, { method: 'DELETE', credentials: 'include' });
        if (r.ok || r.status === 204) return true;
      }
    } catch (e) { /* lanjut ke cara cadangan */ }
    return false;
  }

  // Hapus chat lewat menu halaman (cadangan, bergantung pada tampilan claude.ai)
  async function deleteChatUi(id) {
    try {
      const menu = Array.from(document.querySelectorAll('button')).find((b) =>
        /chat options|more options|options|opsi/i.test(b.getAttribute('aria-label') || '') && visible(b));
      if (!menu) return false;
      menu.click();
      await sleep(500);
      const del = Array.from(document.querySelectorAll('[role="menuitem"], button')).find((b) =>
        /^(delete|hapus)$/i.test((b.innerText || '').trim()) && visible(b));
      if (!del) return false;
      del.click();
      await sleep(500);
      const dels = Array.from(document.querySelectorAll('button')).filter((b) =>
        /^(delete|hapus)$/i.test((b.innerText || '').trim()) && visible(b));
      if (dels.length) dels[dels.length - 1].click();
      await sleep(1200);
      return chatId() !== id;
    } catch (e) { return false; }
  }

  // Buka chat pancingan: baca status limit di dalamnya, lalu hapus chat
  async function baitVerify() {
    const ready = await waitFor(() => pick(COMPOSER_SEL) || limitText(), 20000, 150);
    if (!ready) { baitDone('verify', isLoginPage() ? 'loggedout' : 'fail', ''); return; }
    await sleep(1500);   // beri waktu banner limit muncul
    const lim = limitText();
    const id = chatId();
    let deleted = false;
    if (id) deleted = (await deleteChatApi(id)) || (await deleteChatUi(id));
    baitDone('verify', lim ? 'limit' : 'free', lim, deleted);
  }

  async function baitAssist() {
    if (baitStarted || baitAsked) return;
    let help;
    try { help = await browser.runtime.sendMessage({ type: 'loginHelp' }); } catch (e) { return; }
    if (!help) return;   // ekstensi belum siap, tanya lagi pada pindaian berikutnya
    if (help.wait) return;   // halaman belum di-refresh oleh aplikasi, tanya lagi pada pindaian berikutnya
    baitAsked = true;
    if (!help.bait) return;
    baitStarted = true;
    try {
      if (help.bait === 'send') await baitSend();
      else if (help.bait === 'verify') await baitVerify();
      else if (help.bait === 'continue') await baitContinue(String(help.baitCmd || ''));
    } catch (e) { baitDone(help.bait, 'fail', 'why:error ' + String(e).slice(0, 80)); }
  }

  function report(state, text, url) {
    send({ type: 'pageState', state, text: text || '', url });
  }

  function scan() {
    const body = document.body;
    if (!body) return;
    baitAssist();
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
