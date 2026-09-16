// Terapkan tema tersimpan SEBELUM halaman dirender - hindari kedip gelap->terang.
// Dimuat sinkron di <head> tiap halaman (sebelum <body> tampil).
// Default = dark (tanpa atribut). Tombol toggle + penyimpanan ada di js/layout.js.
(function () {
  try {
    if (localStorage.getItem('grpos-theme') === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  } catch (e) { /* localStorage bisa diblokir - abaikan, pakai default dark */ }
})();
