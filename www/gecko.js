// Continue dan Connect membuka claude.ai di browser GeckoView (sesi login terpisah per akun)
openAccount = async function (a, text, url) {
  if (text) await copyText(text);
  const G = P.GeckoBrowser;
  if (native && G) {
    try {
      await G.open({ accountId: a.id, url: url || CLAUDE_URL });
      return;
    } catch (e) { console.error(e); }
  }
  await openClaude(url);
};

// ---------- Baca kode login dari email ----------
// Tombol untuk mengaktifkan akses notifikasi (sekali saja) + toast saat kode tertangkap
const _initTools = initTools;
initTools = function () {
  _initTools();
  const G = P.GeckoBrowser;
  const tools = document.querySelector('.tools');
  if (!native || !G || !G.isListenerEnabled || !tools) return;

  const btn = el('button', { type: 'button', class: 'tbtn', text: '✉ Baca kode email' });
  const refreshBtn = async () => {
    try {
      const r = await G.isListenerEnabled();
      btn.textContent = r.enabled ? '✉ Kode email: AKTIF' : '✉ Aktifkan baca kode email';
    } catch {}
  };
  btn.addEventListener('click', async () => {
    const r = await G.isListenerEnabled().catch(() => ({}));
    if (r.enabled) { toast('Baca kode email sudah aktif. Kode Claude akan disalin dan ditempel otomatis.'); return; }
    toast('Aktifkan "Claude Account Manager" di layar yang terbuka. Kalau tidak bisa dicentang: Info aplikasi > ⋮ > Izinkan setelan terbatas.', 8000);
    try { await G.openListenerSettings(); } catch {}
  });
  tools.append(btn);
  refreshBtn();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshBtn(); });
};

if (native && P.GeckoBrowser && P.GeckoBrowser.addListener) {
  P.GeckoBrowser.addListener('mailCode', (ev) => {
    toast(`Kode login Claude ${ev.code} disalin${ev.email ? ' (' + ev.email + ')' : ''}.`);
  });
}
