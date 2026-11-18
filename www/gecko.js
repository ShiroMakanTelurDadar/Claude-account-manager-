// Continue dan Connect membuka claude.ai di browser GeckoView (sesi login terpisah per akun)
openAccount = async function (a, text, url, send = true) {
  if (text) await copyText(text);
  const G = P.GeckoBrowser;
  if (native && G) {
    try {
      await G.open({ accountId: a.id, url: url || CLAUDE_URL, email: loginEmail(a), command: send ? (text || '') : '' });
      return;
    } catch (e) { console.error(e); }
  }
  await openClaude(url);
};
