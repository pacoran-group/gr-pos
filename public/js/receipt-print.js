// =====================================================================
// Cetak struk lewat DIALOG PRINT BROWSER (driver Windows biasa) - TANPA QZ Tray.
//
// Dipakai oleh js/qz-print.js saat FORCE_BROWSER_PRINT = true (mode demo) atau
// saat library QZ tidak termuat. Isi struk tetap dibuat oleh formatter di
// qz-print.js, jadi rincian (termasuk baris Service Charge) identik dengan
// struk produksi - hanya jalur kirim ke printer yang beda.
//
// Muat file ini SEBELUM js/qz-print.js.
//
// Tip demo tanpa klik: jalankan Chrome dengan flag --kiosk-printing supaya
// job langsung keluar ke printer default tanpa dialog konfirmasi.
// =====================================================================

const ReceiptPrint = (() => {
  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // Render array baris teks jadi <pre> monospace selebar kertas thermal, lalu
  // panggil print() lewat iframe tersembunyi. Ukuran font dihitung otomatis
  // supaya baris terlebar muat di area cetak (~72mm dari kertas 80mm), jadi
  // struk 32 kolom (slip/tiket) maupun 42 kolom (billing/tagihan) sama-sama rapi.
  //
  // MENGEMBALIKAN PROMISE yang baru selesai setelah dialog print browser
  // ditutup (event 'afterprint', dgn fallback timeout kalau event itu tidak
  // pernah muncul). WAJIB - buka-kamar & tambah-order sering mengirim 2 print
  // job sekaligus (slip gudang + struk billing) yang dicetak berurutan lewat
  // `await QzPrint.printJob(job)` di orders.html/checkout.html. Kalau fungsi
  // ini resolve seketika (versi lama), job ke-2 memanggil print() cuma
  // ~200ms setelah job ke-1 - browser cuma bisa tampilkan 1 dialog print per
  // tab, jadi dialog kedua sering "hilang"/diabaikan dan struk yang
  // seharusnya keluar (mis. struk billing saat Buka Kamar) tidak pernah
  // muncul (dilaporkan user 2026-09-15).
  function printLines(lines, opts) {
    return new Promise((resolve) => {
      printLinesSync(lines, opts, resolve);
    });
  }

  function printLinesSync(lines, opts, done) {
    const o = opts || {};
    const title = o.title || 'Struk';
    const paperMM = o.widthMM || 80;
    const printableMM = paperMM - 8; // margin fisik kiri-kanan printer thermal

    const arr = Array.isArray(lines) ? lines : String(lines).split('\n');
    const maxCols = Math.max(10, ...arr.map((l) => l.length));

    // Lebar 1 karakter monospace ~= 0.6 * font-size. Cari font-size (px) agar
    // maxCols * 0.6 * fs <= printableMM (dikonversi ke px pada 96dpi: 1mm=3.78px).
    const printablePx = printableMM * 3.78;
    let fontPx = printablePx / (maxCols * 0.6);
    fontPx = Math.max(8, Math.min(13, fontPx)); // jaga tetap terbaca

    const text = escapeHtml(arr.join('\n'));

    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(
      '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
      '<style>' +
      '@page{size:' + paperMM + 'mm auto;margin:0}' +
      'html,body{margin:0;padding:0}' +
      'body{width:' + paperMM + 'mm}' +
      'pre{margin:0;padding:4mm 3mm 10mm;' +
      "font-family:'Consolas','Courier New',monospace;" +
      'font-size:' + fontPx.toFixed(1) + 'px;line-height:1.38;' +
      'white-space:pre-wrap;word-break:break-word}' +
      '</style></head><body><pre>' + text + '</pre></body></html>'
    );
    doc.close();

    const w = iframe.contentWindow;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      setTimeout(() => iframe.remove(), 300);
      done();
    };
    // 'afterprint' terpicu begitu dialog print (di-print ATAU dibatalkan)
    // ditutup - itu sinyal yang benar utk "aman lanjut ke struk berikutnya".
    w.addEventListener('afterprint', finish);
    // Fallback kalau 'afterprint' tak pernah muncul (browser lawas, print
    // diblokir, dsb) - jangan sampai antrian struk berikutnya nge-hang selamanya.
    setTimeout(finish, 20000);
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch (e) {
        finish();
      }
    }, 200);
  }

  return { printLines };
})();
