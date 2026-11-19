// Meneruskan laporan halaman dan permintaan email login dari content script ke aplikasi (native).
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  if (msg.type === 'pageState' && typeof msg.state === 'string') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
    return undefined;
  }
  if (msg.type === 'commandDone' || msg.type === 'baitResult' || msg.type === 'usage') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
    return undefined;
  }
  if (msg.type === 'loginHelp') {
    // Jawaban native (email akun dan command Continue) dikembalikan ke content script
    return browser.runtime.sendNativeMessage('browser', msg).catch(() => null);
  }
  return undefined;
});
