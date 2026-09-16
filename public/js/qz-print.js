// =====================================================================
// Modul cetak lokal via QZ Tray.
//
// CARA KERJA (ringkas): QZ Tray adalah aplikasi kecil yang wajib di-install
// di SETIAP komputer yang mau mencetak (Komputer A, B, C) - jalan sebagai
// background service dan membuka koneksi websocket lokal (127.0.0.1) yang
// bisa diakses oleh halaman web ini untuk mengirim print job ke printer
// FISIK yang terpasang di komputer itu. Jadi kalau kasir login di Komputer
// A dan menekan "Buka Kamar", struknya keluar di printer yang nempel di
// Komputer A - BUKAN di komputer lain. Ini yang membuat 2 struk sekaligus
// (thermal gudang + epson billing) bisa keluar dari terminal manapun.
//
// SETUP YANG PERLU DILAKUKAN DI SETIAP KOMPUTER (A, B, C) - lihat README.md:
// 1. Install QZ Tray dari https://qz.io/download/ (gratis).
// 2. Pastikan qz-tray.js (library client) bisa diakses oleh halaman ini -
//    kalau LAN Grand Royal tidak selalu ada internet, download qz-tray.js
//    dari https://github.com/qzind/tray/releases lalu taruh di
//    public/vendor/qz-tray.js dan ganti tag <script> di file HTML dari CDN
//    ke "/vendor/qz-tray.js".
// 3. Di layar Setelan (lihat settings.html), isi NAMA PERSIS printer thermal
//    & epson sesuai yang muncul di "Devices and Printers" Windows komputer
//    itu - disimpan per-browser (localStorage), karena tiap komputer bisa
//    beda nama printer.
// 4. (Opsional, direkomendasikan) Setup sertifikat QZ Tray supaya tidak
//    muncul popup "Allow/Block" tiap kali mau print - lihat dokumentasi QZ
//    Tray "Custom signing" - di luar scope kode ini karena spesifik per
//    instalasi/organisasi.
// =====================================================================

const QzPrint = (() => {
  let connected = false;

  // -------------------------------------------------------------------
  // MODE DEMO: cetak lewat dialog print browser (driver Windows biasa) ke
  // printer thermal, TANPA QZ Tray & tanpa printer 2-ply. Isi struk identik
  // (formatter di bawah tetap dipakai) - hanya jalur kirimnya yang beda.
  // Set ke false untuk kembali ke jalur produksi (QZ Tray + ESC/POS raw).
  // Butuh js/receipt-print.js dimuat sebelum file ini.
  // -------------------------------------------------------------------
  const FORCE_BROWSER_PRINT = true;

  async function ensureConnected() {
    if (typeof qz === 'undefined') {
      throw new Error('Library qz-tray.js belum termuat. Cek koneksi internet / file vendor/qz-tray.js.');
    }
    if (connected && qz.websocket.isActive()) return;
    await qz.websocket.connect();
    connected = true;
  }

  function getPrinterName(target) {
    // target: 'thermal' | 'epson'
    const key = target === 'epson' ? 'gr_pos_printer_epson' : 'gr_pos_printer_thermal';
    const name = localStorage.getItem(key);
    if (!name) {
      throw new Error(
        `Nama printer "${target}" belum diatur untuk komputer ini. Buka halaman Setelan (settings.html) dulu.`
      );
    }
    return name;
  }

  async function printRaw(printerTarget, textLines) {
    // Mode demo / QZ Tray tidak tersedia -> lempar ke dialog print browser.
    if (FORCE_BROWSER_PRINT || typeof qz === 'undefined') {
      if (typeof ReceiptPrint === 'undefined') {
        throw new Error('Cetak browser butuh js/receipt-print.js (muat sebelum qz-print.js).');
      }
      // WAJIB di-await - printLines baru resolve setelah dialog print browser
      // ditutup, supaya print job berikutnya (kalau ada, mis. slip gudang +
      // struk billing dari 1 aksi Buka Kamar) menunggu giliran alih-alih
      // memanggil window.print() hampir bersamaan (lihat catatan di
      // receipt-print.js - itu yang bikin struk ke-2 sering tidak muncul).
      await ReceiptPrint.printLines(textLines, { title: 'Struk (' + printerTarget + ')' });
      return;
    }
    await ensureConnected();
    const printerName = getPrinterName(printerTarget);
    const config = qz.configs.create(printerName);
    const ESC = '\x1b';
    const CUT = ESC + 'i'; // partial cut - SESUAIKAN dgn command ESC/POS printer yang dipakai kalau berbeda
    const data = [
      { type: 'raw', format: 'plain', data: textLines.join('\n') + '\n\n\n' + CUT },
    ];
    await qz.print(config, data);
  }

  // --- Formatter struk (plain text, monospace) ---
  // WIDTH disesuaikan lebar kertas: 32 utk thermal 80mm font besar (umum),
  // 42 utk Epson TM-U220 (umum) - SESUAIKAN kalau hasil cetak terpotong/tidak center.
  function rupiah(n) {
    return 'Rp' + Number(n || 0).toLocaleString('id-ID');
  }
  function center(text, width) {
    const pad = Math.max(0, Math.floor((width - text.length) / 2));
    return ' '.repeat(pad) + text;
  }
  function line(width, ch = '-') {
    return ch.repeat(width);
  }
  function twoCol(left, right, width) {
    const gap = Math.max(1, width - left.length - right.length);
    return left + ' '.repeat(gap) + right;
  }

  function formatSlipGudang(payload, width = 32) {
    const out = [];
    out.push(center('SLIP AMBIL GUDANG', width));
    out.push(center(payload.room_name || '', width));
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name}`);
    }
    out.push(line(width));
    out.push('Trans: ' + payload.trans_id);
    out.push(new Date().toLocaleString('id-ID'));
    return out;
  }

  // Nama outlet di header struk. Dikirim server dari .env (UNIT_NAME utk
  // karaoke/resto, HOTEL_NAME utk F&B hotel); fallback kalau tidak terkirim.
  function outletHeader(payload, fallback) {
    return String(payload.outlet_name || fallback).toUpperCase();
  }

  // Baris banner "DUPLIKAT" utk cetak ulang struk (payload.is_duplicate).
  function dupBanner(payload, width) {
    return payload && payload.is_duplicate
      ? [center('*** DUPLIKAT / CETAK ULANG ***', width)]
      : [];
  }

  // Rincian DPP / Service Charge / Pajak Restoran / Grand Total.
  //  price_includes_tax=true -> harga sudah termasuk SC+PB1, dikupas sbg info.
  //  billing_mode='plusplus'  -> SC & Pajak DITAMBAH di bawah.
  //  selain itu               -> SC inklusif, tanpa pajak.
  function billBreakdownLines(payload, width) {
    const pct = (p) => (p != null && p !== '' && Number(p) ? ' ' + p + '%' : '');
    const dpp = payload.fnb_ex_service != null ? payload.fnb_ex_service : payload.fnb_dpp;
    const rows = [];
    if (payload.price_includes_tax) {
      // Rincian pajak (informasi) - grand total tidak bertambah.
      if (dpp != null) rows.push(twoCol('Nilai barang (DPP)', rupiah(dpp), width));
      if (payload.exempt_gross) rows.push(twoCol('  rokok (bebas SC & pajak)', rupiah(payload.exempt_gross), width));
      rows.push(twoCol('Service Charge' + pct(payload.service_charge_pct), rupiah(payload.service_charge), width));
      if (Number(payload.resto_tax_pct)) rows.push(twoCol('Pajak Restoran' + pct(payload.resto_tax_pct), rupiah(payload.resto_tax), width));
      rows.push(line(width));
      rows.push(twoCol('GRAND TOTAL', rupiah(payload.grand_total), width));
      rows.push(center('(SC & Pajak Restoran sudah termasuk harga)', width));
    } else if (payload.billing_mode === 'plusplus') {
      if (dpp != null) rows.push(twoCol('Subtotal (DPP)', rupiah(dpp), width));
      if (payload.exempt_gross) rows.push(twoCol('  rokok (bebas SC & pajak)', rupiah(payload.exempt_gross), width));
      rows.push(twoCol('Service Charge' + pct(payload.service_charge_pct), rupiah(payload.service_charge), width));
      if (Number(payload.resto_tax_pct)) rows.push(twoCol('Pajak Restoran' + pct(payload.resto_tax_pct), rupiah(payload.resto_tax), width));
      rows.push(line(width));
      rows.push(twoCol('GRAND TOTAL', rupiah(payload.grand_total), width));
    } else {
      if (dpp != null) rows.push(twoCol('Sub Total (DPP)', rupiah(dpp), width));
      rows.push(twoCol('Service Charge' + pct(payload.service_charge_pct), rupiah(payload.service_charge), width));
      rows.push(twoCol('GRAND TOTAL', rupiah(payload.grand_total), width));
      rows.push(center('(Service Charge sudah termasuk)', width));
    }
    return rows;
  }

  // Struk mini per ronde tambah item. Item ronde ini saja.
  function formatStrukOrder(payload, width = 42) {
    const out = [];
    out.push(center(outletHeader(payload, 'Grand Royal Resto'), width));
    out.push(center('STRUK ORDER', width));
    out.push(...dupBanner(payload, width));
    out.push(line(width, '='));
    out.push(`Kamar : ${payload.room_name || ''}`);
    out.push(`Waktu : ${new Date(payload.created_at || Date.now()).toLocaleString('id-ID')}`);
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name_snapshot || item.product_name || ''}`);
      out.push(twoCol('', rupiah(item.subtotal), width));
    }
    out.push(line(width));
    out.push(...billBreakdownLines(payload, width));
    out.push(line(width));
    if (payload.on_tab) {
      out.push(center('*** BELUM DIBAYAR ***', width));
      out.push(center('Ditagih saat CHECKOUT / close room', width));
    } else {
      out.push(center(payload.paid_lunas ? '*** LUNAS ***' : '*** BELUM LUNAS ***', width));
      out.push(`Metode: ${(payload.payment_method || 'cash').toUpperCase()}`);
    }
    if (payload.session_paid_total != null) {
      out.push(twoCol('Total dibayar sesi ini', rupiah(payload.session_paid_total), width));
    }
    out.push(line(width, '='));
    out.push('Trans: ' + payload.trans_id);
    return out;
  }

  function formatBillingRoom(payload, width = 42) {
    const out = [];
    out.push(center(outletHeader(payload, 'Grand Royal Resto'), width));
    out.push(center('STRUK BILLING ROOM', width));
    out.push(...dupBanner(payload, width));
    out.push(line(width, '='));
    out.push(`Kamar : ${payload.room_name || ''}`);
    out.push(`Tamu  : ${payload.cust_name || ''}`);
    out.push(`Waktu : ${new Date(payload.start_time || Date.now()).toLocaleString('id-ID')}`);
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name_snapshot}`);
      out.push(twoCol('', rupiah(item.subtotal), width));
    }
    out.push(line(width));
    out.push(twoCol('Total FnB', rupiah(payload.total_fnb), width));
    if (payload.member_disc_fnb) out.push(twoCol('Diskon Member', '-' + rupiah(payload.member_disc_fnb), width));
    out.push(line(width));
    out.push(...billBreakdownLines(payload, width));
    out.push(twoCol('Dibayar', rupiah(payload.paid_amount), width));
    out.push(`Metode: ${payload.payment_method || 'cash'}`);
    if (payload.paid_lunas) out.push(center('*** LUNAS ***', width));
    out.push(line(width, '='));
    out.push('Trans: ' + payload.trans_id);
    out.push(center('-- lembar 1: tamu, lembar 2: arsip --', width));
    return out;
  }

  function formatTagihanAkhir(payload, width = 42) {
    const out = [];
    out.push(center(outletHeader(payload, 'Grand Royal Resto'), width));
    out.push(center(payload.is_recap ? 'REKAP TAGIHAN (CLOSE ROOM)' : 'TAGIHAN AKHIR', width));
    out.push(...dupBanner(payload, width));
    out.push(line(width, '='));
    out.push(`Kamar : ${payload.room_name || ''}`);
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name_snapshot}`);
      out.push(twoCol('', rupiah(item.subtotal), width));
    }
    out.push(line(width));
    out.push(twoCol('Total FnB', rupiah(payload.total_fnb_gross), width));
    if (payload.member_disc_fnb) out.push(twoCol('Diskon Member FnB', '-' + rupiah(payload.member_disc_fnb), width));
    if (payload.member_disc_room) out.push(twoCol('Diskon Member Room', '-' + rupiah(payload.member_disc_room), width));
    out.push(line(width));
    out.push(...billBreakdownLines(payload, width));
    if (payload.is_recap) {
      out.push(line(width));
      out.push(twoCol('Total dibayar', rupiah(payload.paid_total != null ? payload.paid_total : payload.grand_total), width));
      out.push(center(payload.is_lunas ? '*** SEMUA SUDAH DIBAYAR - LUNAS ***' : '*** KURANG BAYAR Rp' + Number(payload.sisa_bayar || 0).toLocaleString('id-ID') + ' ***', width));
    } else {
      out.push(twoCol('Sudah Dibayar', rupiah(payload.paid_total != null ? payload.paid_total : payload.initial_paid_amount), width));
      out.push(twoCol('SISA BAYAR', rupiah(payload.sisa_bayar), width));
      if (payload.final_payment_method) out.push(`Dibayar via: ${payload.final_payment_method.toUpperCase()}`);
    }
    out.push(line(width, '='));
    out.push('Trans: ' + payload.trans_id);
    return out;
  }

  function formatTiketDapur(payload, width = 32) {
    const out = [];
    out.push(center('TIKET DAPUR', width));
    out.push(center(payload.room_name || '', width));
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name}`);
    }
    out.push(line(width));
    out.push(new Date().toLocaleTimeString('id-ID'));
    return out;
  }

  // Slip retur/batal item (void diotorisasi supervisor) - dicetak ke printer
  // thermal gudang supaya stok/gudang tahu barang kembali.
  function formatSlipRetur(payload, width = 32) {
    const out = [];
    out.push(center('SLIP RETUR / BATAL', width));
    out.push(center(payload.room_name || '', width));
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`-${item.qty}x ${item.product_name}`);
    }
    out.push(line(width));
    if (payload.reason) out.push('Alasan : ' + payload.reason);
    if (payload.approved_by) out.push('Disetujui: ' + payload.approved_by);
    out.push('Trans: ' + payload.trans_id);
    out.push(new Date().toLocaleString('id-ID'));
    return out;
  }

  // Slip arsip order F&B Hotel - dicetak di printer thermal kasir. Harga
  // menu = harga final (inklusif); komponen SC hanya rincian info.
  function formatSlipFnbHotel(payload, width = 32) {
    const out = [];
    out.push(center(outletHeader(payload, 'Royal Inn'), width));
    out.push(center('F&B HOTEL', width));
    out.push(center('Kamar ' + (payload.hotel_room_no || '-'), width));
    if (payload.cust_name) out.push(center(payload.cust_name, width));
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`${item.qty}x ${item.product_name_snapshot || item.product_name || ''}`);
      out.push(twoCol('', rupiah(item.subtotal), width));
    }
    out.push(line(width));
    out.push(twoCol('TOTAL', rupiah(payload.total_amount), width));
    out.push(`(termasuk SC ${payload.sc_pct || 7}% ${rupiah(payload.sc_component)})`);
    out.push(line(width));
    out.push('Order: ' + payload.order_id);
    if (payload.created_by) out.push('Input: ' + payload.created_by);
    out.push(new Date().toLocaleString('id-ID'));
    return out;
  }

  // Struk TUTUP KASIR / shift - dicetak on-demand dari halaman tutup-kasir.
  function formatShiftClose(payload, width = 32) {
    const r = payload.report || {};
    const s = r.shift || {};
    const c = r.cash || {};
    const t = r.totals || {};
    const out = [];
    out.push(center(outletHeader(payload, 'Grand Royal Resto'), width));
    out.push(center('TUTUP KASIR / SHIFT', width));
    out.push(line(width, '='));
    out.push('Kasir : ' + (payload.cashier_name || '-'));
    out.push('Term. : ' + (s.terminal_id || '-'));
    out.push('Buka  : ' + (s.opened_at || '-'));
    out.push('Tutup : ' + (s.closed_at || '-'));
    out.push(line(width));
    for (const m of r.by_method || []) {
      out.push(twoCol(m.method + ' (' + m.count + ')', rupiah(m.amount), width));
    }
    out.push(twoCol('TOTAL DITERIMA', rupiah(t.collected), width));
    out.push(center('(ini omset shift, modal TIDAK termasuk)', width));
    out.push(line(width));
    out.push(twoCol('Modal Kasir', rupiah(c.opening_float), width));
    out.push(twoCol('Penjualan tunai', rupiah(c.cash_sales), width));
    out.push(twoCol('KAS SEHARUSNYA', rupiah(c.expected_cash), width));
    out.push(center('(cocokkan laci - bukan omset)', width));
    out.push(twoCol('KAS DIHITUNG', rupiah(c.counted_cash), width));
    const v = Number(c.variance || 0);
    out.push(twoCol('SELISIH', (v > 0 ? '+' : '') + rupiah(v), width));
    out.push(center(v === 0 ? '*** PAS ***' : (v > 0 ? '*** LEBIH ***' : '*** KURANG ***'), width));
    out.push(line(width));
    out.push(twoCol('Kamar dibuka', String(t.rooms_opened || 0), width));
    out.push(twoCol('Kamar ditutup', String(t.rooms_closed || 0), width));
    if (s.note) out.push('Catatan: ' + s.note);
    out.push(line(width, '='));
    out.push(center(new Date().toLocaleString('id-ID'), width));
    return out;
  }

  // Tiket batal ke layar dapur - membatalkan item yang tadinya perlu dimasak.
  function formatTiketDapurBatal(payload, width = 32) {
    const out = [];
    out.push(center('== BATAL / RETUR ==', width));
    out.push(center(payload.room_name || '', width));
    out.push(line(width));
    for (const item of payload.items || []) {
      out.push(`BATAL ${item.qty}x ${item.product_name}`);
    }
    out.push(line(width));
    out.push(new Date().toLocaleTimeString('id-ID'));
    return out;
  }

  /** Cetak satu print job dari hasil API (print_type + printer_target + payload) */
  async function printJob(job) {
    // Di mode demo (cetak browser ke thermal 80mm) paksa struk billing/tagihan
    // ke 32 kolom biar rapi & fontnya masih besar; jalur QZ pakai default 42
    // (Epson 2-ply) dengan lulus `undefined`.
    const wideW = FORCE_BROWSER_PRINT ? 32 : undefined;
    let lines;
    switch (job.print_type) {
      case 'slip_gudang':
        lines = formatSlipGudang(job.payload);
        break;
      case 'billing_room':
        lines = formatBillingRoom(job.payload, wideW);
        break;
      case 'tagihan_akhir':
        lines = formatTagihanAkhir(job.payload, wideW);
        break;
      case 'struk_order':
        lines = formatStrukOrder(job.payload, wideW);
        break;
      case 'tiket_dapur':
        lines = formatTiketDapur(job.payload);
        break;
      case 'slip_retur':
        lines = formatSlipRetur(job.payload);
        break;
      case 'tiket_dapur_batal':
        lines = formatTiketDapurBatal(job.payload);
        break;
      case 'slip_fnb_hotel':
        lines = formatSlipFnbHotel(job.payload);
        break;
      default:
        throw new Error('Jenis struk tidak dikenal: ' + job.print_type);
    }
    await printRaw(job.printer_target, lines);
  }

  return { printJob, ensureConnected, formatSlipGudang, formatBillingRoom, formatTagihanAkhir, formatStrukOrder, formatShiftClose, formatTiketDapur, formatSlipRetur, formatTiketDapurBatal, formatSlipFnbHotel };
})();
