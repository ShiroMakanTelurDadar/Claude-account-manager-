// Continue membuka claude.ai di browser GeckoView (sesi login terpisah per akun)
openAccount = async function (a, text) {
  await copyText(text);
  const G = P.GeckoBrowser;
  if (native && G) {
    try {
      await G.open({ accountId: a.id, url: CLAUDE_URL });
      return;
    } catch (e) { console.error(e); }
  }
  await openClaude();
};
