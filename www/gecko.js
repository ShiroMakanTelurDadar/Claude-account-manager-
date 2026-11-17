// Tombol Continue membuka claude.ai di browser GeckoView (sesi login terpisah per akun)
doContinue = async function (a) {
  await copyText(a.command || DEFAULT_CMD);
  const G = P.GeckoBrowser;
  if (native && G) {
    try {
      await G.open({ accountId: a.id, url: CLAUDE_URL });
      toast(`Command disalin. Tempel di kolom chat (tahan, lalu Tempel). Akun: ${a.name}`);
      return;
    } catch (e) { console.error(e); }
  }
  await openClaude();
  toast(`Command disalin. Buka akun "${a.name}" lalu tempel.`);
};
