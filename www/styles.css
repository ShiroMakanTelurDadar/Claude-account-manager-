// Pembaca halaman claude.ai (ekstensi limitwatch). Berjalan di dalam halaman claude.ai milik sesi GeckoView aplikasi.
// Tugasnya:
//   1. Melaporkan status halaman ke aplikasi: limit, busy, resume, idle, loggedout (pesan "pageState").
//   2. Mengisi email di halaman login dan mengirim command Continue (pesan "loginHelp" / "commandDone").
//   3. Pancingan di sesi tersembunyi: mode "send" (kirim "."), "verify" (baca lalu hapus chat), "continue" (kirim command).
//      Hasilnya dikirim sebagai "baitResult". Kalau gagal, teksnya berbentuk "why:kode detail".
// Kata-kata deteksi ada di bagian atas (LIMIT_RE, RESUME_BTN_RE). Ubah di sini kalau tampilan claude.ai berubah.
(() => {
  'use strict';
  if (window.__limitwatch) return;
  window.__limitwatch = true;

  const LIMIT_RE = /out of (free )?messages|usage limit|limit (will )?reset|kehabisan pesan|batas penggunaan|upgrade to keep chatting|keep chatting with claude pro|free messages return|keep going now with pro|free usage ran out|usage ran out|hit your [^\n]{0,40}limit/i;
  // Potongan teks yang mungkin bagian dari banner limit (teks banner sering terpecah per elemen, mis. link "messages")
  const FRAG_RE = /out of|usage|limit|upgrade|chatting|return|ran out|free|kehabisan|batas/i;
  const RESUME_BTN_RE = /^(continue|try again|retry|lanjutkan|coba lagi)$/i;
  const CHALLENGE_RE = /just a moment|attention required|verify you are human|checking your browser|performing security verification/i;
  const SEND_LABEL_RE = /^(send|send message|kirim|kirim pesan)/i;
  const STOP_LABEL_RE = /^(stop|stop response|stop generating|berhenti|hentikan)/i;
  // Teks status yang berdiri sendiri saat Claude bekerja ("Working on it", "Run a command"). "Ran 5 commands" (sudah selesai) sengaja tidak cocok.
  const BUSY_TEXT_RE = /^(working on it|thinking|run(ning)? (a |\d+ )?commands?|sedang bekerja|sedang berpikir|menjalankan perintah)\s*(\.{2,}|…)?$/i;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const send = async (m) => {
    try { return await browser.runtime.sendMessage(m); } catch (_) { return null; }
  };
  // Sesi tersembunyi tidak punya layar, jadi ukuran elemen bisa 0. Jangan pakai ukuran: cukup cek tidak di-hide lewat CSS.
  const vis = (e) => {
    if (!e || !e.isConnected) return false;
    try {
      if (typeof e.checkVisibility === 'function') return e.checkVisibility({ visibilityProperty: true });
      const cs = getComputedStyle(e);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (_) { return true; }
  };
  const txt = (e) => ((e && (e.innerText || e.textContent)) || '').replace(/\s+/g, ' ').trim();
  const labelOf = (b) => (b.getAttribute('aria-label') || txt(b) || '').trim();

  function click(e) {
    try {
      e.focus && e.focus();
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
    } catch (_) { try { e.click(); } catch (__) { /* abaikan */ } }
  }

  // ---------- Elemen halaman ----------
  function composer() {
    const sel = 'div.ProseMirror[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[contenteditable="true"], textarea';
    for (const e of document.querySelectorAll(sel)) {
      if (!vis(e) || e.closest('[role="dialog"]')) continue;
      return e;
    }
    return null;
  }
  const composerText = (c) => (c ? (c.value !== undefined ? c.value : c.innerText || c.textContent || '') : '').replace(/​/g, '').trim();

  function buttons() { return [...document.querySelectorAll('button, [role="button"]')].filter(vis); }
  const sendBtn = () => buttons().find((b) => SEND_LABEL_RE.test(labelOf(b)) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
  const stopBtn = () => buttons().find((b) => STOP_LABEL_RE.test(labelOf(b)));
  const resumeBtn = () => buttons().find((b) => RESUME_BTN_RE.test(txt(b)));

  const isChallenge = () => CHALLENGE_RE.test((document.title || '') + ' ' + ((document.body && document.body.innerText) || '').slice(0, 700));

  function isLoggedOut() {
    if (composer()) return false;
    if (/^\/(login|logout|signup|onboarding)/.test(location.pathname)) return true;
    if ([...document.querySelectorAll('input[type="email"]')].some(vis)) return true;
    return buttons().some((b) => /^continue with (google|email|apple|sso)/i.test(txt(b)));
  }

  // Banner / popup limit. Cocokkan teks gabungan elemen (bukan per node teks), karena banner terpecah:
  // "You are out of free " + <a>messages</a> + " until 5:20 AM". Teks di dalam pesan chat diabaikan.
  const CHAT_SEL = '[data-testid="user-message"], [class*="font-claude-message"], [class*="font-claude-response"], [class*="font-user-message"], [data-is-streaming]';
  const HAS_TIME = /\d{1,2}[:.]\d{2}/;
  function limitText() {
    if (!document.body) return '';
    if (!LIMIT_RE.test(document.body.textContent || '')) return '';
    const found = [];
    const seen = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const v = n.nodeValue;
      if (!v || v.length > 300 || !FRAG_RE.test(v)) continue;
      let e = n.parentElement;
      if (!e || !vis(e)) continue;
      for (let i = 0; i < 5 && e; i++, e = e.parentElement) {
        const t = txt(e);
        if (t.length > 300) break;
        if (!LIMIT_RE.test(t)) continue;
        if (seen.has(e)) break;
        seen.add(e);
        if (!e.closest(CHAT_SEL)) found.push(t);
        break;
      }
    }
    if (!found.length) return '';
    // utamakan teks yang memuat jam reset (banner dan popup bisa muncul bersamaan)
    return (found.find((t) => HAS_TIME.test(t)) || found[0]).slice(0, 300);
  }

  function hasBusyText() {
    if (!document.body) return false;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const v = (n.nodeValue || '').trim();
      if (v.length > 0 && v.length < 30 && BUSY_TEXT_RE.test(v) && vis(n.parentElement)) return true;
    }
    return false;
  }

  const hasMessages = () => !!document.querySelector('[data-testid="user-message"], [class*="font-claude-message"], [class*="font-claude-response"], [data-test-render-count]');

  function readState() {
    const lt = limitText();
    // Tombol Continue / Try again terlihat dan teks limit tanpa jam reset (mis. "Paused when your free usage ran out"): sudah bisa dilanjutkan
    if (lt && !(HAS_TIME.test(lt) || !resumeBtn())) return { state: 'resume', text: '' };
    if (lt) return { state: 'limit', text: lt };
    if (isLoggedOut()) return { state: 'loggedout', text: '' };
    if (stopBtn() || hasBusyText()) return { state: 'busy', text: '' };
    if (resumeBtn()) return { state: 'resume', text: '' };
    // Di chat yang sudah ada, "free" baru pasti kalau pesan chat sudah tampil dan tidak ada tanda limit. Kolom chat saja belum cukup.
    if (composer()) return (/^\/chat\//.test(location.pathname) && !hasMessages()) ? { state: 'unknown', text: '' } : { state: 'idle', text: '' };
    return { state: 'unknown', text: '' };
  }

  // ---------- Mengisi dan mengirim ----------
  function setValue(el, value) {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.focus();
    try {
      const sel = window.getSelection();
      const r = document.createRange();
      r.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(r);
      if (!document.execCommand('insertText', false, value)) throw new Error('execCommand');
    } catch (_) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    }
  }

  async function waitFor(fn, ms, step = 200) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }

  // Isi kolom chat lalu kirim. Hasil: kode kegagalan ('' = terkirim).
  async function typeAndSend(text) {
    const c = await waitFor(composer, 25000);
    if (!c) return 'no-composer';
    c.focus();
    setValue(c, text);
    await sleep(400);
    if (!composerText(composer()).includes(text.trim().slice(0, 20))) {
      setValue(c, text);   // coba sekali lagi
      await sleep(400);
      if (!composerText(composer()).includes(text.trim().slice(0, 20))) return 'text-not-inserted';
    }
    const pressEnter = () => {
      c.focus();
      for (const t of ['keydown', 'keypress', 'keyup']) {
        c.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    };
    const submitted = () => stopBtn() || !composerText(composer());
    const b = await waitFor(sendBtn, 3000, 150);
    if (b) click(b); else pressEnter();
    if (await waitFor(submitted, 3500, 150)) return '';
    // Belum terkirim: coba cara satunya (tombol kirim <-> Enter), sekali
    const b2 = sendBtn();
    if (b) pressEnter(); else if (b2) click(b2); else pressEnter();
    const sent = await waitFor(() => submitted() || (hasMessages() && !composerText(composer())), 6000, 150);
    return sent ? '' : 'not-submitted';
  }

  const where = () => `url=${location.pathname} judul=${(document.title || '').slice(0, 40)}`;

  // ---------- Pancingan ----------
  async function stopResponse() {
    for (let i = 0; i < 6; i++) {
      const b = stopBtn();
      if (b) { click(b); await sleep(300); }
      if (!stopBtn()) return;
    }
  }

  async function waitOutcome(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const lt = limitText();
      if (lt) { await stopResponse(); return { outcome: 'limit', text: lt }; }
      if (isLoggedOut()) return { outcome: 'loggedout', text: '' };
      if (stopBtn() || document.querySelector('[class*="font-claude-message"], [class*="font-claude-response"]')) {
        await stopResponse();
        await sleep(700);
        const again = limitText();   // limit kadang muncul sesaat setelah respon mulai
        return again ? { outcome: 'limit', text: again } : { outcome: 'free', text: '' };
      }
      await sleep(200);
    }
    return null;
  }

  async function deleteChat() {
    const triggers = [...document.querySelectorAll('button[aria-haspopup="menu"], button[aria-label*="options" i], button[aria-label*="menu" i], [data-testid*="chat-menu" i]')].filter(vis);
    for (const t of triggers) {
      click(t);
      await sleep(500);
      const item = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] button')].find((e) => /^(delete|hapus)/i.test(txt(e)));
      if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(200); continue; }
      click(item);
      await sleep(600);
      const ok = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((e) => /^(delete|hapus)/i.test(txt(e)));
      if (ok) { click(ok); await sleep(1500); return true; }
    }
    return false;
  }

  async function runBait(help) {
    const mode = help.bait;
    let res = { outcome: 'fail', text: 'why:no-response', deleted: false };
    try {
      if (!(await waitFor(() => composer() || isLoggedOut() || isChallenge(), 30000))) {
        res = { outcome: 'fail', text: 'why:no-composer ' + where() };
      } else if (isChallenge()) {
        res = { outcome: 'fail', text: 'why:challenge ' + where() };
      } else if (isLoggedOut()) {
        res = { outcome: 'loggedout', text: '' };
      } else if (mode === 'send' || mode === 'continue') {
        const cmd = mode === 'send' ? '.' : (help.baitCmd || 'Continue');
        const err = await typeAndSend(cmd);
        if (err) res = { outcome: 'fail', text: `why:${err} ${where()}` };
        else {
          const r = await waitOutcome(mode === 'send' ? 40000 : 15000);
          if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
          else if (mode === 'continue') res = { outcome: r.outcome === 'free' ? 'sent' : r.outcome, text: r.text };
          else res = r;
        }
      } else if (mode === 'verify') {
        const r = await waitFor(() => limitText() || hasMessages(), 25000, 300);
        if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
        else {
          const lt = limitText();
          res = lt ? { outcome: 'limit', text: lt } : { outcome: 'free', text: '' };
          res.deleted = await deleteChat();
        }
      }
    } catch (e) {
      res = { outcome: 'fail', text: `why:error ${(e && e.message) || e}` };
    }
    await send({ type: 'baitResult', outcome: res.outcome, text: res.text || '', url: location.href, deleted: !!res.deleted });
  }

  // ---------- Isi email dan command ----------
  async function fillEmail(email) {
    const end = Date.now() + 25000;
    while (Date.now() < end) {
      const i = [...document.querySelectorAll('input[type="email"]')].find(vis);
      if (i) {
        if (!i.value) { i.focus(); setValue(i, email); }
        return;
      }
      if (composer()) return;
      await sleep(800);
    }
  }

  async function sendCommand(text) {
    const err = await typeAndSend(text);
    if (!err) await send({ type: 'commandDone' });
  }

  // ---------- Pelaporan status ----------
  function startReporting() {
    let last = '';
    let lastAt = 0;
    const tick = () => {
      const s = readState();
      if (s.state === 'unknown') return;   // halaman belum siap: jangan dilaporkan
      const key = `${s.state}|${s.text}|${location.pathname}`;
      const now = Date.now();
      if (key !== last || (s.state === 'busy' && now - lastAt > 4000)) {
        last = key;
        lastAt = now;
        send({ type: 'pageState', state: s.state, text: s.text, url: location.href });
      }
    };
    setInterval(tick, 1000);
    tick();
    // Kalau 15 detik tidak ada status yang dikenal: kirim sonde supaya aplikasi bisa menampilkan apa yang dilihat skrip
    setTimeout(() => {
      if (last) return;
      const n = (q) => document.querySelectorAll(q).length;
      const sonde = `sonde: composer=${composer() ? 1 : 0} editable=${n('[contenteditable="true"]')} textarea=${n('textarea')} tombol=${n('button')} panjang=${((document.body && document.body.innerText) || '').length} lebar=${window.innerWidth}`;
      send({ type: 'hello', url: location.href, title: sonde, challenge: isChallenge() });
    }, 15000);
  }

  // ---------- Tombol Paste email (tombol melayang aplikasi) ----------
  // Aplikasi menandai permintaan paste; skrip ini menanyakannya tiap 600 ms dan mengisi kolom yang sedang aktif.
  function pasteTarget() {
    const a = document.activeElement;
    if (a && a !== document.body && vis(a) && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return a;
    return [...document.querySelectorAll('input[type="email"]')].find(vis) || composer();
  }
  function startPasteWatcher() {
    setInterval(async () => {
      if (document.hidden) return;
      const r = await send({ type: 'pasteCheck' });
      if (!r || !r.paste || !r.email) return;
      const t = pasteTarget();
      if (t) { t.focus(); setValue(t, r.email); }
    }, 600);
  }

  async function main() {
    // Tanda hidup: aplikasi tahu skrip ini benar-benar jalan di halaman (dipakai untuk penjelasan kalau gagal)
    send({ type: 'hello', url: location.href, title: document.title || '', challenge: isChallenge() });

    let help = null;
    for (let i = 0; i < 80; i++) {   // halaman belum di-refresh: native menjawab wait=true
      help = await send({ type: 'loginHelp' });
      if (!help || !help.wait) break;
      await sleep(500);
    }
    help = help || {};
    if (help.bait) { await runBait(help); return; }
    if (help.email) fillEmail(help.email);
    startReporting();
    if (help.command) sendCommand(help.command);
    startPasteWatcher();
  }

  main().catch((e) => { send({ type: 'hello', url: location.href, title: 'error: ' + ((e && e.message) || e), challenge: false }); });
})();
