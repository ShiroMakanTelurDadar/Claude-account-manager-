// Meneruskan status halaman dari content script ke aplikasi (native).
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pageState' && typeof msg.state === 'string') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
  }
});
