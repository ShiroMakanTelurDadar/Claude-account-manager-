// Pembaca halaman claude.ai (ekstensi limitwatch). Berjalan di dalam halaman claude.ai milik sesi GeckoView aplikasi.
// Tugasnya:
//   1. Melaporkan status halaman ke aplikasi: limit, busy, resume, idle, loggedout (pesan "pageState").
//   2. Mengisi email di halaman login dan mengirim command Continue (pesan "loginHelp" / "commandDone").
//   3. Pancingan di sesi tersembunyi: mode "send" (kirim "Hi"), "verify" (baca status chat pancingan), "delete" (hapus chat pancingan), "continue" (kirim command).
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
  let lastSendErr = '';
  const send = async (m) => {
    try {
      let r = await browser.runtime.sendMessage(m);
      if (typeof r === 'string') { try { r = JSON.parse(r); } catch (_) {} }   // aplikasi menjawab berupa teks JSON
      return r;
    } catch (e) { lastSendErr = String((e && e.message) || e); return null; }
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
      const para = document.createElement('p');   // struktur yang dipakai kolom chat (ProseMirror): <p>teks</p>
      para.textContent = value;
      el.replaceChildren(para);
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
    const submitted = () => !!stopBtn() || (composer() ? !composerText(composer()) : hasMessages());   // kolom chat hilang sesaat tanpa pesan = belum terkirim
    const b = await waitFor(sendBtn, 3000, 150);
    if (b) click(b); else pressEnter();
    const sent1 = await waitFor(submitted, 3500, 150);
    if (sent1) return '';
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

  // Teks balasan Claude di chat (kosong = belum ada). Dipakai pancingan: begitu ada kalimat balasan, pancingan dianggap selesai.
  const REPLY_NOISE_RE = /can make mistakes|double-check|dapat membuat kesalahan|periksa kembali/i;
  function claudeReplyText() {
    for (const e of document.querySelectorAll('[class*="font-claude-message"], [class*="font-claude-response"], [data-is-streaming]')) {
      const t = txt(e);
      if (t) return t;
    }
    // Cadangan kalau nama class berubah: teks apa pun yang muncul setelah pesan pengguna terakhir di halaman chat
    if (!/^\/chat\//.test(location.pathname)) return '';
    const users = [...document.querySelectorAll('[data-testid="user-message"]')];
    const last = users[users.length - 1];
    if (!last) return '';
    const c = composer();
    for (const e of document.querySelectorAll('p, li, pre')) {
      if (last.contains(e) || !(last.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if ((c && c.contains(e)) || e.closest('nav, aside, header, form, fieldset, [role="dialog"]') || !vis(e)) continue;
      const t = txt(e);
      if (t && !REPLY_NOISE_RE.test(t) && !LIMIT_RE.test(t)) return t;
    }
    return '';
  }

  async function waitOutcome(ms, needText) {
    const end = Date.now() + ms;
    let stopSince = 0;
    while (Date.now() < end) {
      const lt = limitText();
      if (lt) { await stopResponse(); return { outcome: 'limit', text: lt }; }
      if (isLoggedOut()) return { outcome: 'loggedout', text: '' };
      if (needText) {
        // Pancingan: selesai begitu ada kalimat balasan. Tombol stop yang menyala 8 detik tanpa teks juga dianggap sudah dibalas.
        const reply = claudeReplyText();
        let streaming = false;
        if (!reply && stopBtn()) { if (!stopSince) stopSince = Date.now(); streaming = Date.now() - stopSince > 8000; } else if (!stopBtn()) stopSince = 0;
        if (!reply && !streaming) { await sleep(200); continue; }
        await stopResponse();
        await sleep(700);
        const again = limitText();   // limit kadang muncul sesaat setelah balasan mulai
        return again ? { outcome: 'limit', text: again } : { outcome: 'free', text: '' };
      }
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

  // Cara 1: API internal claude.ai. Halaman sudah login, jadi cookie ikut terkirim. Cepat dan tidak bergantung pada tampilan.
  async function deleteChatApi() {
    const m = /^\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    if (!m) return false;
    try {
      const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
      if (!r.ok) {
        return false;
      }
      const orgs = await r.json();
      for (const o of Array.isArray(orgs) ? orgs : []) {
        if (!o || !o.uuid) continue;
        const d = await fetch(`/api/organizations/${o.uuid}/chat_conversations/${m[1]}`, { method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' } });
        if (d.ok) return true;
      }
    } catch (e) {
    }
    return false;
  }

  // Cara 2: lewat sidebar, seperti dilakukan manual di HP: buka sidebar, titik tiga di chat ini, lalu Delete (dan konfirmasi)
  const DEL_ITEM_RE = /^(delete|hapus)( chat| percakapan)?$/i;
  function findDeleteItem() {
    const c = [...document.querySelectorAll('button, [role="menuitem"], [role="option"], [role="button"], a, div, span')].filter((e) => vis(e) && DEL_ITEM_RE.test(txt(e)));
    const leaf = c.filter((e) => !c.some((o) => o !== e && e.contains(o)));   // elemen paling dalam
    const e = leaf[leaf.length - 1];   // menu yang baru muncul ada di akhir dokumen
    return e ? (e.closest('button, [role="menuitem"], [role="option"], [role="button"], a') || e) : null;
  }
  function rowMenuButton(id) {
    const link = document.querySelector(`a[href*="${id}"]`);
    if (!link) return null;
    let row = link;
    for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
      const bs = [...row.querySelectorAll('button, [role="button"]')];
      if (!bs.length) continue;
      return bs.find((b) => b.getAttribute('aria-haspopup') || /more|option|menu|action|opsi|lainnya/i.test(labelOf(b))) || bs[bs.length - 1];
    }
    return null;
  }
  async function openSidebar() {
    const cands = buttons().filter((b) => !b.getAttribute('aria-haspopup'));
    const byLabel = cands.find((b) => /sidebar|navigation|toggle|open menu|buka/i.test(labelOf(b)));
    const byPos = cands.find((b) => { const r = b.getBoundingClientRect(); return r.left < 100 && r.top < 150 && r.width > 0; });
    const t = byLabel || byPos;
    if (t) { click(t); await sleep(900); }
  }
  async function deleteChatSidebar(idArg) {
    const m = /^\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    const id = idArg || (m && m[1]);
    if (!id) return false;
    const isCur = location.pathname.includes(id);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1 || !rowMenuButton(id)) {
        await openSidebar();
        await waitFor(() => rowMenuButton(id), 3000, 200);
      }
      const dots = rowMenuButton(id);
      if (!dots) continue;
      click(dots);
      await sleep(800);
      const del = await waitFor(findDeleteItem, 2500, 200);
      if (!del) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        continue;
      }
      click(del);
      await sleep(900);
      const ok = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((e) => e !== del && vis(e) && /^(delete|hapus)\b/i.test(txt(e)));
      if (ok) click(ok);
      const gone = await waitFor(() => !document.querySelector(`a[href*="${id}"]`) || (isCur && !location.pathname.includes(id)), 4000, 300);
      if (gone || ok) return true;
    }
    return false;
  }

  // Cara 3 (cadangan terakhir): menu di header halaman chat
  async function deleteChatMenu() {
    const DEL_RE = /^(delete|hapus)\b/i;
    const title = (document.title || '').replace(/\s*[-–|]\s*Claude\s*$/i, '').trim();
    const triggers = [];
    const add = (e) => { if (e && !triggers.includes(e)) triggers.push(e); };
    if (title) buttons().filter((b) => txt(b) && (txt(b) === title || title.startsWith(txt(b)))).forEach(add);
    document.querySelectorAll('[data-testid*="chat-title" i], [data-testid*="chat-menu" i], [data-testid*="conversation" i]').forEach((e) => { if (vis(e)) add(e); });
    buttons().filter((b) => b.getAttribute('aria-haspopup') === 'menu' || /options|menu|more|opsi|lainnya|actions/i.test(labelOf(b))).forEach(add);
    const findDelete = () => {
      const all = [...document.querySelectorAll('[role="menuitem"], [role="option"], [role="menu"] button, [role="menu"] a, [role="menu"] div, [data-radix-popper-content-wrapper] button, [data-radix-popper-content-wrapper] div, [role="dialog"] button')]
        .filter((e) => vis(e) && txt(e).length < 30 && DEL_RE.test(txt(e)));
      return all.find((e) => e.getAttribute('role') === 'menuitem') || all[0];
    };
    for (const t of triggers.slice(0, 8)) {
      click(t);
      await sleep(700);
      const item = findDelete();
      if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(300); continue; }
      click(item);
      await sleep(800);
      const ok = [...document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')].find((e) => vis(e) && DEL_RE.test(txt(e)));
      if (ok) click(ok);
      await sleep(1500);
      if (ok || !/^\/chat\//.test(location.pathname)) return true;
    }
    return false;
  }

  async function deleteChat() {
    if (await deleteChatApi()) { await sleep(500); return true; }
    if (await deleteChatSidebar()) return true;
    return deleteChatMenu();
  }

  // Hapus SEMUA chat berjudul "Greeting"/"Greetings" di akun ini (chat pancingan lama yang tertinggal ikut terhapus)
  const GREETING_RE = /^greetings?$/i;
  async function deleteGreetingsApi() {   // jumlah terhapus, atau -1 kalau API tidak bisa dipakai
    let n = 0;
    try {
      const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
      if (!r.ok) return -1;
      const orgs = await r.json();
      for (const o of Array.isArray(orgs) ? orgs : []) {
        if (!o || !o.uuid) continue;
        const l = await fetch(`/api/organizations/${o.uuid}/chat_conversations`, { credentials: 'include', headers: { accept: 'application/json' } });
        if (!l.ok) continue;
        const chats = await l.json();
        for (const c of (Array.isArray(chats) ? chats : []).filter((x) => x && x.uuid && GREETING_RE.test(String(x.name || '').trim())).slice(0, 40)) {
          const d = await fetch(`/api/organizations/${o.uuid}/chat_conversations/${c.uuid}`, { method: 'DELETE', credentials: 'include', headers: { accept: 'application/json' } });
          if (d.ok) n++;
        }
      }
    } catch (e) {
      return n || -1;
    }
    return n;
  }
  async function deleteGreetingsUi() {
    const rows = () => [...document.querySelectorAll('a[href^="/chat/"]')].filter((a) => GREETING_RE.test(txt(a)))
      .map((a) => (/\/chat\/([0-9a-f-]{36})/i.exec(a.getAttribute('href')) || [])[1]).filter(Boolean);
    if (!rows().length) { await openSidebar(); await sleep(1200); }
    let n = 0;
    for (const id of [...new Set(rows())].slice(0, 10)) {
      if (await deleteChatSidebar(id)) n++;
    }
    return n;
  }
  async function deleteGreetings() {
    let n = await deleteGreetingsApi();
    if (n < 0) n = await deleteGreetingsUi();
    return Math.max(n, 0);
  }

  // ---------- Estafet: kerja satu langkah, salin balasan, ambil data percakapan ----------
  // Balasan terakhir Claude diubah ke teks bergaya markdown. Blok kode (<pre>) menjadi ```bahasa ... ```, sehingga aplikasi bisa
  // memisahkan file. Selama Claude masih menulis, blok kode terakhir dianggap belum selesai: penutup ``` sengaja dibuang.
  const MSG_SEL = '[class*="font-claude-message"], [class*="font-claude-response"]';
  function replyEls() {
    const all = [...document.querySelectorAll(MSG_SEL)].filter((e) => !(e.parentElement && e.parentElement.closest(MSG_SEL)));
    const users = [...document.querySelectorAll('[data-testid="user-message"]')];
    const last = users[users.length - 1];
    return last ? all.filter((e) => last.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) : all;
  }
  function mdOf(root) {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return; }
      if (n.nodeType !== 1) return;
      const t = n.tagName;
      if (t === 'PRE') {
        const code = n.querySelector('code');
        const body = ((code || n).textContent || '').replace(/\n$/, '');
        const lang = code ? ((/language-([\w+-]+)/.exec(code.className || '') || [])[1] || '') : '';
        if (out && !out.endsWith('\n')) out += '\n';
        out += '```' + lang + '\n' + body + '\n```\n';
        return;
      }
      if (t === 'BR') { out += '\n'; return; }
      const block = /^(P|DIV|LI|H[1-6]|UL|OL|BLOCKQUOTE|TABLE|TR)$/.test(t);
      if (block && out && !out.endsWith('\n')) out += '\n';
      if (t === 'LI') out += '- ';
      for (const c of n.childNodes) walk(c);
      if (block && !out.endsWith('\n')) out += '\n';
    };
    walk(root);
    return out;
  }
  function replyMarkdown(streaming) {
    let md = replyEls().map(mdOf).join('\n').replace(/​/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!md) md = claudeReplyText();   // cadangan kalau nama class pesan berubah: teks polos tanpa pemisah blok kode
    // Berakhir tepat di penutup blok kode = tidak ada tulisan setelahnya: selama masih mengalir, blok itu belum tentu utuh
    if (streaming && /\n```$/.test(md)) md = md.slice(0, -4).trimEnd();
    return md;
  }

  // Data percakapan dari API internal claude.ai (cookie halaman ikut terkirim). Memuat isi perintah / kode yang dijalankan Claude di
  // sandbox dan rujukan file, walau di layar semuanya tertutup ("Ran a command"). Tidak resmi: bentuk datanya bisa berubah,
  // jadi hasil mentahnya ikut disimpan untuk diperiksa.
  async function fetchConvo() {
    const m = /^\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    if (!m) return { err: 'bukan halaman chat' };
    try {
      const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
      if (!r.ok) return { err: 'organizations ' + r.status };
      const orgs = await r.json();
      let last = '';
      for (const o of Array.isArray(orgs) ? orgs : []) {
        if (!o || !o.uuid) continue;
        for (const q of ['?tree=True&rendering_mode=messages&render_all_tools=true', '']) {
          const c = await fetch(`/api/organizations/${o.uuid}/chat_conversations/${m[1]}${q}`, { credentials: 'include', headers: { accept: 'application/json' } });
          last = String(c.status);
          if (c.ok) return { text: await c.text() };
        }
      }
      return { err: 'chat_conversations ' + last };
    } catch (e) { return { err: String((e && e.message) || e) }; }
  }
  function walkJson(v, fn, depth) {
    if (v == null || depth > 40) return;
    if (Array.isArray(v)) { for (const x of v) walkJson(x, fn, depth + 1); return; }
    if (typeof v === 'object') { fn(v); for (const k of Object.keys(v)) walkJson(v[k], fn, depth + 1); }
  }
  // Ringkasan yang pasti berguna: isi tiap tool_use (nama + input) dan objek yang tampak seperti rujukan file
  function extractConvo(text) {
    const out = { tools: [], files: [] };
    let j;
    try { j = JSON.parse(text); } catch (_) { out.err = 'bukan JSON'; return out; }
    const seen = new Set();
    walkJson(j, (o) => {
      if (o.type === 'tool_use' && o.input !== undefined) {
        const input = JSON.stringify(o.input);
        out.tools.push({ name: String(o.name || ''), id: String(o.id || ''), input: input.length > 300000 ? input.slice(0, 300000) : input, cut: input.length > 300000 });
      }
      if (o.file_uuid || o.file_name || (o.file_kind && o.path)) {
        const flat = {};
        for (const k of Object.keys(o)) { const v = o[k]; if ((typeof v === 'string' && v.length < 400) || typeof v === 'number' || typeof v === 'boolean') flat[k] = v; }
        const key = JSON.stringify(flat);
        if (!seen.has(key)) { seen.add(key); out.files.push(flat); }
      }
    }, 0);
    return out;
  }
  async function buildData() {
    const c = await fetchConvo();
    if (!c.text) return JSON.stringify({ at: Date.now(), url: location.href, err: c.err || 'kosong' });
    const ex = extractConvo(c.text);
    return JSON.stringify({ at: Date.now(), url: location.href, size: c.text.length, tools: ex.tools, files: ex.files, parseErr: ex.err || '', raw: c.text.length <= 900000 ? c.text : '' });
  }


  // ---------- Estafet: unggah lampiran dan ambil zip hasil ----------
  const b64ToBytes = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const bytesToB64 = (u) => { let o = ''; for (let i = 0; i < u.length; i += 8192) o += String.fromCharCode.apply(null, u.subarray(i, i + 8192)); return btoa(o); };

  // Ambil file lampiran dari aplikasi (potongan base64) lalu pasang ke input file chat. Hasil: '' = berhasil, selain itu kode kegagalan.
  async function attachUploads(list) {
    const files = [];
    for (let i = 0; i < list.length; i++) {
      const chunks = [];
      let off = 0;
      for (let guard = 0; guard < 400; guard++) {
        const r = await send({ type: 'getUpload', i, off, len: 262144 });
        if (!r || r.error || typeof r.b64 !== 'string') return 'upload-read';
        const u = b64ToBytes(r.b64);
        chunks.push(u);
        off += u.length;
        if (r.eof || u.length === 0) break;
      }
      files.push(new File(chunks, list[i].name || ('file' + i + '.zip'), { type: 'application/zip' }));
    }
    const input = await waitFor(() => document.querySelector('input[type="file"]'), 20000);
    if (!input) return 'no-file-input';
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Tunggu nama file muncul di halaman (kartu lampiran), lalu beri waktu selesai mengunggah
    const key = String(list[0].name || '').replace(/\.zip$/i, '').toLowerCase();
    const shown = await waitFor(() => (document.body.innerText || '').toLowerCase().includes(key), 30000, 300);
    if (!shown) return 'upload-not-shown';
    await waitFor(() => !document.querySelector('[role="progressbar"], [data-testid*="upload" i][data-state="loading"]'), 60000, 500);
    await sleep(2500);
    return '';
  }

  // Cari zip hasil di percakapan lalu unduh dengan fetch (cookie halaman ikut). Hasil dikirim ke aplikasi per potongan.
  // Mengembalikan { got: jumlah file terkirim, cards: catatan diagnosis }.
  async function collectZip(expect) {
    const notes = [];
    const note = (t) => { if (notes.join(' | ').length < 900) notes.push(t); };
    const m = /^\/chat\/([0-9a-f-]{36})/i.exec(location.pathname);
    if (!m) return { got: 0, cards: 'bukan halaman chat' };
    const conv = m[1];
    const want = String(expect || '').toLowerCase();
    let orgs = [];
    try {
      const r = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
      note('org=' + r.status);
      if (r.ok) orgs = (await r.json()).map((o) => o && o.uuid).filter(Boolean);
    } catch (e) { note('org-err'); }
    // Kandidat dari JSON percakapan: jalur file sandbox dan rujukan file
    const paths = [];
    const uuids = [];
    let raw = '';
    for (const org of orgs) {
      for (const q of ['?tree=True&rendering_mode=messages&render_all_tools=true', '']) {
        try {
          const c = await fetch(`/api/organizations/${org}/chat_conversations/${conv}${q}`, { credentials: 'include', headers: { accept: 'application/json' } });
          if (c.ok) { raw = await c.text(); break; }
        } catch (_) {}
      }
      if (raw) { orgs.splice(0, orgs.length, org); break; }
    }
    note('json=' + raw.length);
    const addPath = (p) => { p = String(p).replace(/\\\//g, '/').replace(/[\\"'\s,;)]+$/, ''); if (/\.zip$/i.test(p) && !paths.includes(p)) paths.push(p); };
    for (const mm of raw.matchAll(/\/mnt\/user-data\/outputs\/[^"\\\s,;)]+/g)) addPath(mm[0]);
    if (want && !paths.some((p) => p.toLowerCase().endsWith(want))) paths.push('/mnt/user-data/outputs/' + expect);
    try {
      walkJson(JSON.parse(raw || 'null'), (o) => {
        const nm = String(o.file_name || o.name || '');
        if (o.file_uuid && /\.zip$/i.test(nm) && !uuids.includes(o.file_uuid)) uuids.push(o.file_uuid);
        if (typeof o.path === 'string') addPath(o.path);
      }, 0);
    } catch (_) {}
    for (const a of document.querySelectorAll('a[href]')) { const h = a.getAttribute('href') || ''; if (/\.zip(\?|$)/i.test(h)) note('a=' + h.slice(0, 80)); }
    paths.sort((a, b) => (b.toLowerCase().includes(want) ? 1 : 0) - (a.toLowerCase().includes(want) ? 1 : 0) || a.localeCompare(b));
    note('path=' + paths.length + ' uuid=' + uuids.length);

    const urls = [];
    for (const org of orgs) {
      for (const p of paths) {
        const e = encodeURIComponent(p);
        urls.push({ n: p.split('/').pop(), u: `/api/organizations/${org}/conversations/${conv}/wiggle/download-file?path=${e}` });
        urls.push({ n: p.split('/').pop(), u: `/api/organizations/${org}/chat_conversations/${conv}/wiggle/download-file?path=${e}` });
      }
      for (const id of uuids) {
        urls.push({ n: 'file-' + id + '.zip', u: `/api/organizations/${org}/files/${id}/content` });
        urls.push({ n: 'file-' + id + '.zip', u: `/api/${org}/files/${id}/document` });
      }
    }
    let got = 0;
    const doneNames = new Set();
    for (const it of urls) {
      if (doneNames.has(it.n)) continue;
      try {
        const r = await fetch(it.u, { credentials: 'include' });
        if (!r.ok) { note(it.n + ':' + r.status); continue; }
        const u8 = new Uint8Array(await r.arrayBuffer());
        if (u8.length < 100 || u8[0] !== 0x50 || u8[1] !== 0x4b) { note(it.n + ':bukan-zip(' + u8.length + ')'); continue; }
        const CH = 393216;
        let ok = true;
        for (let off = 0; off < u8.length; off += CH) {
          const rr = await send({ type: 'dlChunk', name: it.n, b64: bytesToB64(u8.subarray(off, off + CH)), first: off === 0, last: off + CH >= u8.length });
          if (!rr || !rr.ok) { ok = false; note(it.n + ':kirim-gagal'); break; }
        }
        if (ok) { got++; doneNames.add(it.n); note(it.n + ':ok ' + u8.length); }
      } catch (e) { note(it.n + ':err ' + String((e && e.message) || e).slice(0, 40)); }
    }
    return { got, cards: notes.join(' | ') };
  }

  // Tunggu Claude bekerja sampai selesai atau kena limit. Salinan balasan dikirim ke aplikasi tiap kali berubah (paling cepat tiap 2,5 detik),
  // sehingga kalau sesi terputus oleh limit, teks terakhir sudah ada di aplikasi. Perubahan halaman dipantau lewat MutationObserver.
  async function watchWork() {
    let dirty = true;
    const mo = new MutationObserver(() => { dirty = true; });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    const started = Date.now();
    let lastSent = '';
    let lastSentAt = 0;
    let idleSince = 0;
    const push = (md) => { lastSent = md; lastSentAt = Date.now(); return send({ type: 'workPartial', text: md }); };
    try {
      for (;;) {
        await sleep(1000);
        const lt = limitText();
        const busy = !!stopBtn() || hasBusyText();
        if (lt) {
          await stopResponse();
          const md = replyMarkdown(true);
          if (md && md !== lastSent) await push(md);
          return { outcome: 'limit', text: lt };
        }
        if (isLoggedOut()) return { outcome: 'loggedout', text: '' };
        if (isChallenge()) return { outcome: 'fail', text: 'why:challenge ' + where() };
        const md = replyMarkdown(busy);
        if (md && md !== lastSent && (dirty || Date.now() - lastSentAt > 5000) && Date.now() - lastSentAt > 2500) await push(md);
        dirty = false;
        if (!busy && md) {
          if (!idleSince) idleSince = Date.now();
          if (Date.now() - idleSince > 4000) {
            const fin = replyMarkdown(false);
            await push(fin);
            if (limitText()) return { outcome: 'limit', text: limitText() };
            return { outcome: resumeBtn() ? 'paused' : 'done', text: fin };
          }
        } else idleSince = 0;
        if (!busy && !md && Date.now() - started > 90000) return { outcome: 'fail', text: 'why:no-response ' + where() };
      }
    } finally { mo.disconnect(); }
  }

  async function runBait(help) {
    const mode = help.bait;
    let res = { outcome: 'fail', text: 'why:no-response', deleted: false };
    let pre = '';
    let data = '';
    let sent = false;
    let cards = '';
    try {
      if (!(await waitFor(() => composer() || isLoggedOut() || isChallenge(), 120000))) {
        res = { outcome: 'fail', text: 'why:no-composer ' + where() };
      } else if (isChallenge()) {
        res = { outcome: 'fail', text: 'why:challenge ' + where() };
      } else if (isLoggedOut()) {
        res = { outcome: 'loggedout', text: '' };
      } else if (mode !== 'verify' && mode !== 'delete' && mode !== 'dump' && (pre = limitText())) {
        // Banner limit sudah tampil sebelum mengirim apa pun: itu sudah jawabannya (kolom chat sering dikunci saat limit)
        res = { outcome: 'limit', text: pre };
      } else if (mode === 'dump') {
        // Hanya ambil data percakapan chat ini (tanpa mengirim apa pun). Dipakai untuk menguji apa yang tersimpan di server.
        const r = await waitFor(() => hasMessages(), 60000, 300);
        if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
        else { data = await buildData(); res = { outcome: 'dumped', text: replyMarkdown(false) }; }
      } else if (mode === 'collect') {
        // Hanya ambil zip hasil dari chat yang sudah ada (tanpa mengirim apa pun)
        const r = await waitFor(() => hasMessages(), 60000, 300);
        if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
        else {
          const c = await collectZip(help.expect || '');
          cards = c.cards;
          res = c.got ? { outcome: 'collected', text: '' } : { outcome: 'fail', text: `why:no-zip ${where()}` };
        }
      } else if (mode === 'work') {
        let upErr = '';
        if (Array.isArray(help.uploads) && help.uploads.length) upErr = await attachUploads(help.uploads);
        const err = upErr ? 'attach-' + upErr : await typeAndSend(help.baitCmd || '');
        if (err) res = limitText() ? { outcome: 'limit', text: limitText() } : { outcome: 'fail', text: `why:${err} ${where()}` };
        else {
          sent = true;
          res = await watchWork();
          if ((res.outcome === 'done' || res.outcome === 'paused') && help.expect) {
            const c = await collectZip(help.expect);
            cards = c.cards;
          }
        }
        if (res.outcome !== 'loggedout') data = await buildData();   // juga saat limit: percakapan di server tetap bisa dibaca
      } else if (mode === 'send' || mode === 'continue') {
        const cmd = mode === 'send' ? 'Hi' : (help.baitCmd || 'Continue');
        const err = await typeAndSend(cmd);
        // Gagal terkirim karena kolom chat dikunci banner limit yang baru muncul: itu hasil limit, bukan kegagalan
        if (err) res = limitText() ? { outcome: 'limit', text: limitText() } : { outcome: 'fail', text: `why:${err} ${where()}` };
        else {
          const r = await waitOutcome(mode === 'send' ? 90000 : 15000, mode === 'send');
          if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
          else if (mode === 'continue') res = { outcome: r.outcome === 'free' ? 'sent' : r.outcome, text: r.text };
          else res = r;
        }
      } else if (mode === 'verify') {
        const r = await waitFor(() => limitText() || hasMessages(), 90000, 300);
        if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
        else {
          const lt = limitText();
          res = lt ? { outcome: 'limit', text: lt } : { outcome: 'free', text: '' };
        }
      } else if (mode === 'delete') {
        // Dijalankan app setelah pancingan dan pengecekan akun ini selesai: hapus chat pancingan
        const r = await waitFor(() => hasMessages(), 60000, 300);
        if (!r) res = { outcome: 'fail', text: `why:no-response ${where()}` };
        else {
          let ok = await deleteChat();
          const swept = await deleteGreetings();   // sapu juga chat "Greeting" lain di akun ini
          if (swept > 0) ok = true;
          res = ok ? { outcome: 'deleted', text: '', deleted: true } : { outcome: 'fail', text: `why:delete-failed ${where()}` };
        }
      }
    } catch (e) {
      res = { outcome: 'fail', text: `why:error ${(e && e.message) || e}` };
    }
    await send({ type: 'baitResult', outcome: res.outcome, text: res.text || '', url: location.href, deleted: !!res.deleted, data, sent, cards });
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
    let helpErr = '';
    for (let i = 0; i < 80; i++) {   // wait=true: halaman belum di-refresh. Jawaban kosong/error: coba lagi ~10 detik (jalur ke aplikasi kadang belum siap)
      help = await send({ type: 'loginHelp' });
      if (help && help.error) { helpErr = help.error; help = null; }
      if (help && !help.wait) break;
      if (!help && i >= 20) break;
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
