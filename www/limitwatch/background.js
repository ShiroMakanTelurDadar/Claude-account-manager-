// Meneruskan status halaman dari content script ke aplikasi (native).
// type "pageState": laporan limit/busy/reset/idle (tanpa balasan)
// type "getCode"  : minta kode login terakhir yang terbaca dari email, balasan {code, at} atau {}
browser.runtime.onMessage.addListener((msg) => {
  if (!msg) return;
  if (msg.type === 'pageState' && typeof msg.state === 'string') {
    browser.runtime.sendNativeMessage('browser', msg).catch(() => {});
  } else if (msg.type === 'getCode') {
    return browser.runtime.sendNativeMessage('browser', msg).catch(() => null);
  }
});
