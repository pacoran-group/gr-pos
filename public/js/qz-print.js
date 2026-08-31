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

  function formatBillingRoom(payload, width = 42) {
    const out = [];
    out.push(center('GRAND ROYAL', width));
    out.push(center('STRUK BILLING ROOM', width));
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
    out.push(twoCol('Dibayar', rupiah(payload.paid_amount), width));
    out.push(`Metode: ${payload.payment_method || 'cash'}`);
    out.push(line(width, '='));
    out.push('Trans: ' + payload.trans_id);
    out.push(center('-- lembar 1: tamu, lembar 2: arsip --', width));
    return out;
  }

  function formatTagihanAkhir(payload, width = 42) {
    const out = [];
    out.push(center('GRAND ROYAL', width));
    out.push(center('TAGIHAN AKHIR', width));
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
    out.push(twoCol('Service Charge', rupiah(payload.service_charge), width));
    out.push(twoCol('GRAND TOTAL', rupiah(payload.grand_total), width));
    out.push(twoCol('Sudah Dibayar', rupiah(payload.initial_paid_amount), width));
    out.push(twoCol('SISA BAYAR', rupiah(payload.sisa_bayar), width));
    if (payload.final_payment_method) out.push(`Dibayar via: ${payload.final_payment_method.toUpperCase()}`);
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
    out.push(center('== F&B HOTEL ==', width));
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
    let lines;
    switch (job.print_type) {
      case 'slip_gudang':
        lines = formatSlipGudang(job.payload);
        break;
      case 'billing_room':
        lines = formatBillingRoom(job.payload);
        break;
      case 'tagihan_akhir':
        lines = formatTagihanAkhir(job.payload);
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

  return { printJob, ensureConnected, formatSlipGudang, formatBillingRoom, formatTagihanAkhir, formatTiketDapur, formatSlipRetur, formatTiketDapurBatal, formatSlipFnbHotel };
})();
