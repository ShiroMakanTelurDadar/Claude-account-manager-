// Meneruskan laporan halaman dan permintaan bantuan login dari content script ke aplikasi (native).
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return undefined;
  if (msg.type === 'pageState' && typeof msg.state === 'string') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
    return undefined;
  }
  if (msg.type === 'loginHelp') {
    // Jawaban native (email akun dan kode terbaru) dikembalikan ke content script
    return browser.runtime.sendNativeMessage('browser', msg).catch(() => null);
  }
  return undefined;
});
