// Sistem tema. Tema dipilih di Control > Tema, disimpan di perangkat, dan dipasang sebelum halaman tampil.
// Menambah tema baru: tambah satu entri di THEMES, lalu tambah blok html[data-theme="id"] di theme.css.
(() => {
  'use strict';
  const KEY = 'theme';
  // colors = isi kotak pilihan di Control (tiga warna palet, dari kiri atas ke kanan bawah)
  const THEMES = [
    { id: 'default', name: 'Default', colors: ['#04070c', '#38bdf8', '#bae6fd'], bar: '#04070c' },
    { id: 'oracle', name: 'Oracle', colors: ['#0a0504', '#dc2626', '#fbbf24'], bar: '#0a0504' },
  ];
  const byId = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
  const read = () => { try { return localStorage.getItem(KEY) || 'default'; } catch (_) { return 'default'; } };

  function apply(id) {
    const t = byId(id);
    document.documentElement.setAttribute('data-theme', t.id);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t.bar);
    return t.id;
  }

  window.Theme = {
    list: THEMES,
    get: () => byId(read()).id,
    set(id) {
      const t = apply(id);
      try { localStorage.setItem(KEY, t); } catch (_) { /* tema tetap terpasang untuk sesi ini */ }
      window.dispatchEvent(new Event('themechange'));
    },
  };

  apply(read());
  // meta theme-color belum ada saat skrip ini jalan di <head>: pasang ulang setelah dokumen siap
  document.addEventListener('DOMContentLoaded', () => apply(read()));
})();
