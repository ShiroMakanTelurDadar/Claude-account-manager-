// Meneruskan teks banner limit dari content script ke aplikasi (native).
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'pageText' && typeof msg.text === 'string') {
    browser.runtime.sendNativeMessage('browser', { text: msg.text }).catch(() => {});
  }
});
