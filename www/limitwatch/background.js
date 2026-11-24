// Meneruskan laporan halaman dan permintaan email login dari content script ke aplikasi (native).
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  if (msg.type === 'pageState' && typeof msg.state === 'string') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
    return undefined;
  }
  if (msg.type === 'commandDone' || msg.type === 'baitResult' || msg.type === 'hello' || msg.type === 'workPartial') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
    return undefined;
  }
  if (msg.type === 'loginHelp' || msg.type === 'pasteCheck') {
    // Jawaban native (email akun dan command Continue) dikembalikan ke content script
    return browser.runtime.sendNativeMessage('browser', msg).catch((e) => ({ error: String((e && e.message) || e) }));
  }
  return undefined;
});
