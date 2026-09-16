const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { generateTransId } = require('../utils/idGenerator');
const { getWindowForTime, getThresholdAmount, allottedMs, CREDIT_HOURS_PER_THRESHOLD, PAYMENT_SPARE_MIN, COMP_DEFAULT_HOURS, TEST_MODE_MINUTES } = require('../services/threshold.service');
const { queuePrint } = require('../services/printQueue.service');
const { UNIT_NAME } = require('../config/unit'); // nama outlet di header struk
const { BILLING_MODE, RESTO_TAX_PCT, isScTaxExempt, priceIncludesTax, grossUpPrice } = require('../config/billing');
const { getOpenShiftId } = require('../services/cashierShift.service');
const { SHIFT_REQUIRED } = require('../config/shift');
const roomPlayer = require('../services/roomPlayer.service');
const legacyRoomState = require('../services/legacyRoomState.service');
const stock = require('../services/stock.service');
const promo = require('../services/promo.service');
const { computeBill } = require('../services/bill');

/** Agregasi array `priced` (hasil fetchItemsWithPrice) jadi keranjang
 *  { product_id, qty, price } per produk - untuk evaluasi promo sebelum
 *  baris web_tr_trans_details ditulis (dipakai di buka-kamar). */
function cartFromPriced(priced) {
  const m = new Map();
  for (const it of priced || []) {
    const k = String(it.product_id);
    const e = m.get(k) || { product_id: k, qty: 0, price: Number(it.price) };
    e.qty += Number(it.qty);
    m.set(k, e);
  }
  return [...m.values()];
}

const router = express.Router();
router.use(requireAuth);

// CATATAN (27 Agustus 2026): status "room menyala" TIDAK lagi ditulis ke
// m_room di database gr-pos (Server02). Aplikasi pemutar lagu di dalam room
// polling `m_room.is_active` di server LAMA (10.0.0.154), jadi buka/tutup
// kamar meng-antre-kan perintah ke web_room_player_outbox (roomPlayer.enqueue)
// yang dikirim worker ke 154. Lihat services/roomPlayer.service.js &
// migration 003_room_player_outbox.sql. Kolom m_room.status TIDAK dipakai.

// =====================================================================
// MODE TEST = TES FISIK ROOM (direvisi 31 Agustus 2026).
// Tujuan: sebelum tamu datang, staf masuk ke room untuk cek lagu & mic
// benar-benar bunyi. Transaksi bertanda is_test=1:
//   - MENYALAKAN player room di server lama (154) - inti tes fisik
//   - melewati validasi threshold FnB/pembayaran
//   - TIDAK memicu print job apa pun (slip gudang/billing/tagihan/tiket dapur)
//   - TIDAK menggerakkan stok, TIDAK masuk omzet/laporan Tutup Hari
//   - player DImatikan lagi saat "Selesai Tes" (tutup-kamar) atau otomatis
//     oleh worker testMode setelah TEST_MODE_MINUTES (services/testMode.service.js)
// Boleh dipakai kasir & waiter (tanpa otorisasi SPV) - merekalah yang keliling
// cek room tiap sebelum buka.
const TEST_MODE_ROLES = ['kasir', 'waiter', 'supervisor', 'admin'];

// =====================================================================
// COMP ROOM - VIP / VVIP (31 Agustus 2026) - lihat migration 010_comp_room.sql.
// Buka kamar TANPA memenuhi threshold F&B, dengan alokasi waktu MANUAL
// (comp_hours). Beda dari Mode Test: sesi ini NYATA - player 154 nyala,
// struk & tiket tercetak, stok bergerak, tagihan akhir menagih konsumsi asli.
// Wajib otorisasi admin/supervisor (verifyApprover, sama seperti Void).
// VVIP = comp_hours default (COMP_DEFAULT_HOURS); VIP = kasir isi jamnya.
// Keduanya bisa diperpanjang lewat "+ Add Time".
// =====================================================================
const COMP_MAX_HOURS = 24;

// id shift kasir yang sedang buka utk user ini (utk menandai pembayaran).
// Kalau SHIFT_REQUIRED='on' dan tak ada shift buka -> tolak.
async function resolveShiftId(conn, req) {
  const sid = await getOpenShiftId(conn, req.user.user_id);
  if (SHIFT_REQUIRED && sid == null) {
    throw new AppError(409, 'Buka Kasir dulu (menu Kasir) sebelum memproses pembayaran.');
  }
  return sid;
}

async function fetchItemsWithPrice(conn, items) {
  if (!items || !items.length) return [];
  const ids = items.map((i) => i.product_id);
  // CATATAN (27 Agustus 2026): dua perbaikan dari versi sebelumnya:
  // 1. Nama kolom m_product diperbaiki ke skema asli produksi (prod_id,
  //    prod_desc, harga_jual) - versi lama pakai nama generik yang tidak
  //    ada di tabel sungguhan, jadi query ini gagal total sebelumnya (lihat
  //    juga perbaikan yang sama di catalog.routes.js). prod_id di-CAST ke
  //    CHAR supaya konsisten dgn product_id VARCHAR(25) di
  //    web_tr_trans_details/web_product_routing.
  // 2. Join dipindah dari web_category_routing (routing per-KATEGORI, sudah
  //    di-supersede) ke web_product_routing (routing per-PRODUK, final -
  //    lihat desain-teknis-room-billing.md bagian 4 & update 27 Agustus
  //    2026). Kategori/produk yang belum dikonfigurasi di web_product_routing
  //    default needs_cooking = 1 (aman, dianggap perlu tiket dapur).
  const [rows] = await conn.query(
    `SELECT CAST(p.prod_id AS CHAR) AS product_id, p.prod_desc AS product_name,
            p.harga_jual AS price, p.harga_mdl AS cost, p.category AS category_id,
            COALESCE(r.needs_cooking, 1) AS needs_cooking
     FROM m_product p
     LEFT JOIN web_product_routing r ON r.product_id = CAST(p.prod_id AS CHAR)
     WHERE p.prod_id IN (${ids.map(() => '?').join(',')})`,
    ids
  );
  const byId = Object.fromEntries(rows.map((r) => [r.product_id, r]));
  // Kalau harga yang ditagih sudah termasuk SC + Pajak Restoran, gross-up
  // harga DPP (m_product.harga_jual) di sini. Rokok tidak di-gross-up.
  const scPct = priceIncludesTax() ? await getServiceChargePct(conn) : 0;

  return items.map((i) => {
    const product = byId[i.product_id];
    if (!product) throw new AppError(400, `Produk ${i.product_id} tidak ditemukan.`);
    const qty = Number(i.qty) || 0;
    if (qty <= 0) throw new AppError(400, `Qty untuk produk ${i.product_id} harus lebih dari 0.`);
    const exempt = isScTaxExempt(product.category_id) ? 1 : 0;
    const dppPrice = Number(product.price);
    const sellPrice = priceIncludesTax()
      ? grossUpPrice(dppPrice, exempt, scPct, RESTO_TAX_PCT)
      : dppPrice;
    return {
      product_id: product.product_id,
      product_name_snapshot: product.product_name,
      qty,
      price: sellPrice,        // harga yang ditagih (inklusif kalau priceIncludesTax)
      dpp_price: dppPrice,     // referensi
      // harga modal - di-snapshot ke web_stock_movement.unit_cost saat mutasi
      // 'sale' supaya nilai COGS bisa dihitung nanti tanpa join ke harga
      // yang berubah-ubah. Bisa null kalau m_product.harga_mdl kosong.
      cost: product.cost == null ? null : Number(product.cost),
      subtotal: sellPrice * qty,
      // true = perlu tiket dapur (dimasak); false = kategori "Bar" - minuman
      // siap saji/beralkohol, cukup ambil dari gudang (sudah ada di slip gudang).
      needs_cooking: Boolean(product.needs_cooking),
      // true = kategori Rokok -> BEBAS Service Charge & Pajak Restoran.
      sc_tax_exempt: exempt,
    };
  });
}

// CATATAN (27 Agustus 2026): skema asli m_member = id_member, ktp,
// nama_member, alamat, telp, disc_room, disc_fnb, tgl_expired. Tidak ada
// member_id / disc_*_pct / active. Alias dipakai supaya pemanggil tetap
// menerima { disc_room_pct, disc_fnb_pct }. "Aktif" = belum lewat expired.
async function getMemberDiscount(conn, memberId) {
  if (!memberId) return { disc_room_pct: 0, disc_fnb_pct: 0 };
  const [rows] = await conn.query(
    `SELECT disc_room AS disc_room_pct, disc_fnb AS disc_fnb_pct
     FROM m_member WHERE id_member = ? AND tgl_expired >= CURDATE()`,
    [memberId]
  );
  if (!rows.length) throw new AppError(400, `Member ${memberId} tidak ditemukan/tidak aktif.`);
  return rows[0];
}

// CATATAN (27 Agustus 2026): tabel tax_service asli = room_tax, food_tax,
// tax_service (semua int). Tidak ada kolom service_charge_pct - query lama
// unknown column. Kolom `tax_service` itu sendiri adalah persen service
// charge yang dipakai. NB: threshold.service.js / m_promo BELUM diverifikasi
// terhadap skema asli - hanya dipakai di buka-kamar NON-test.
let _scPctCache = null; // di-memo utk lifetime proses (restart kalau tarif berubah)
async function getServiceChargePct(conn) {
  if (_scPctCache == null) {
    const [rows] = await conn.query('SELECT tax_service AS service_charge_pct FROM tax_service LIMIT 1');
    _scPctCache = rows.length ? Number(rows[0].service_charge_pct) : 0;
  }
  return _scPctCache;
}

// =====================================================================
// Idempotency key - lihat catatan lengkap di migration 001 &
// diagnosis-sync-issue.md ("Root cause order duplikat"). Dipanggil di
// DALAM withTransaction yang sama dengan logika utama endpoint, supaya
// pengecekan + penyimpanan hasil atomik dengan insert transaksi/order-nya.
// =====================================================================

/**
 * Cek apakah request_key ini sudah pernah diproses sebelumnya untuk endpoint
 * ini. Kalau sudah, kembalikan hasil yang tersimpan dari percobaan pertama
 * (retry disebabkan mis. timeout jaringan - server sebenarnya sudah sukses
 * memproses permintaan yang sama sebelumnya, jadi jangan diulang).
 *
 * SELECT ... FOR UPDATE di sini SENGAJA dipakai walau baris belum tentu ada
 * - di InnoDB (REPEATABLE READ, default) ini mengambil gap lock yang mencegah
 * transaksi lain meng-INSERT baris dengan key yang sama sebelum transaksi ini
 * commit/rollback, jadi 2 request dengan request_key IDENTIK yang datang
 * nyaris bersamaan tetap diproses berurutan (bukan race).
 */
async function getIdempotentResponse(conn, endpoint, requestKey) {
  if (!requestKey) return null; // tidak ada key dikirim - lewati (fallback aman, tidak memblokir)
  const [rows] = await conn.query(
    'SELECT response_snapshot FROM web_idempotency_key WHERE endpoint = ? AND request_key = ? FOR UPDATE',
    [endpoint, requestKey]
  );
  if (!rows.length) return null;
  const snap = rows[0].response_snapshot;
  return typeof snap === 'string' ? JSON.parse(snap) : snap;
}

/** Simpan hasil sukses supaya retry dengan request_key yang sama nanti mengembalikan hasil ini, bukan mengulang insert. */
async function saveIdempotentResponse(conn, endpoint, requestKey, transId, response) {
  if (!requestKey) return;
  await conn.query(
    'INSERT INTO web_idempotency_key (endpoint, request_key, trans_id, response_snapshot) VALUES (?, ?, ?, ?)',
    [endpoint, requestKey, transId || null, JSON.stringify(response)]
  );
}

/** Ambil print job yang baru saja di-queue utk trans ini dgn destination local_qz (utk dicetak lokal segera) */
async function fetchLocalPrintJobs(conn, transId) {
  const [rows] = await conn.query(
    `SELECT id, print_type, printer_target, payload_snapshot
     FROM web_print_log
     WHERE trans_id = ? AND destination = 'local_qz' AND status = 'pending'
     ORDER BY id`,
    [transId]
  );
  return rows.map((r) => ({
    print_log_id: r.id,
    print_type: r.print_type,
    printer_target: r.printer_target,
    payload: typeof r.payload_snapshot === 'string' ? JSON.parse(r.payload_snapshot) : r.payload_snapshot,
  }));
}

// =====================================================================
// POST /api/trans/buka-kamar
// Aksi ATOMIK, simetris dari terminal manapun (lihat desain-teknis-room-billing.md #3)
// =====================================================================
router.post('/buka-kamar', async (req, res, next) => {
  try {
    const {
      room_id, cust_name, person, waiter_id, member_id, items,
      initial_paid_amount, initial_payment_method, request_key, is_test,
      rate_mode, comp_hours, comp_reason, approver_username, approver_password,
      id_card_shown,
    } = req.body;
    if (!room_id) throw new AppError(400, 'room_id wajib diisi.');
    // Fallback kalau client lama/lupa kirim request_key: generate acak di server
    // - tidak memberi proteksi idempotency (tidak ada nilai utk dicocokkan di
    // retry berikutnya), tapi tidak memblokir alur (lihat getIdempotentResponse).
    const requestKey = request_key || crypto.randomUUID();

    const isComp = rate_mode === 'comp';
    const isTest = Boolean(is_test) && !isComp; // comp menang kalau keduanya terkirim
    if (Boolean(is_test) && isComp) {
      throw new AppError(400, 'Tidak bisa memakai Mode Test dan VIP/VVIP sekaligus.');
    }
    if (isTest && !TEST_MODE_ROLES.includes(req.user.role)) {
      throw new AppError(403, 'Mode Test (tes fisik room) hanya untuk kasir/waiter/supervisor/admin.');
    }

    const result = await withTransaction(async (conn) => {
      // --- Cek dulu apakah request ini (persis) sudah pernah sukses diproses
      // sebelumnya - kalau ya, kembalikan hasil yang sama, JANGAN buka kamar
      // dua kali. Ini yang menutup celah "order duplikat" akibat retry
      // jaringan (lihat diagnosis-sync-issue.md).
      const cachedBukaKamar = await getIdempotentResponse(conn, 'buka_kamar', requestKey);
      if (cachedBukaKamar) return cachedBukaKamar;

      // --- KUNCI UTAMA: mengunci baris kamar ini sampai transaction selesai.
      // Kalau terminal lain mencoba Buka Kamar utk room yang sama di saat
      // bersamaan, request itu akan menunggu/gagal timeout di sini
      // (lihat desain-teknis-room-billing.md bagian 2.1).
      const [roomRows] = await conn.query('SELECT * FROM m_room WHERE room_id = ? FOR UPDATE', [room_id]);
      if (!roomRows.length) throw new AppError(404, `Kamar ${room_id} tidak ditemukan.`);
      const room = roomRows[0];

      const [maintRows] = await conn.query(
        'SELECT reason FROM web_room_maintenance WHERE room_id = ? AND is_maintenance = 1',
        [room_id]
      );
      if (maintRows.length) {
        throw new AppError(409, `Kamar ${room.room_name} sedang maintenance: ${maintRows[0].reason || '-'}`);
      }

      const [activeRows] = await conn.query(
        "SELECT trans_id, is_test FROM web_tr_trans WHERE room_id = ? AND status = 'active'",
        [room_id]
      );
      if (activeRows.length) {
        throw new AppError(
          409,
          activeRows[0].is_test
            ? `Kamar ${room.room_name} sedang DITES (cek lagu/mic). Tekan "Selesai Tes" dulu sebelum menerima tamu.`
            : `Kamar ${room.room_name} sedang terisi (transaksi ${activeRows[0].trans_id}).`
        );
      }

      // Jangan buka room yang sedang AKTIF di sistem lama (154) - hindari 2
      // sistem memperebutkan room yang sama. No-op kalau ROOM_PLAYER_SYNC off.
      // Berlaku JUGA untuk Mode Test: tes fisik room kini menyalakan player di
      // 154, jadi jangan menes room yang sedang dipakai tamu di sistem lama.
      //
      // Local-first: cache status 154 (web_legacy_room_state, di-refresh
      // worker read-only tiap ~15s). Cache SEGAR & bilang menyala -> tolak
      // tanpa menyentuh 154 (hemat beban 154 saat peak). Cache basi/absen ->
      // fallback query langsung ke 154 (fail-open kalau 154 tak terhubung).
      {
        const ls = await legacyRoomState.check(conn, room_id);
        if (ls.known && ls.is_active && !ls.stale) {
          throw new AppError(
            409,
            `Kamar ${room.room_name} sedang AKTIF di sistem lama. Tutup dulu di sistem lama sebelum dibuka dari POS baru.`
          );
        }
        if (!ls.known || ls.stale) {
          await roomPlayer.assertRoomAvailableOnLegacy(room_id);
        }
      }

      const priced = await fetchItemsWithPrice(conn, items);

      // Promo produk (B1G1 / paket) - AUTO-APPLY atas keranjang pembukaan ASLI
      // (sebelum item hadiah check-in disisipkan). Mode Test tidak kena promo.
      const promoEval = isTest
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.evaluateActivePromos(conn, cartFromPriced(priced));

      // Diskon member dihitung atas item yang DIBAYAR saja (belum termasuk hadiah).
      const paidFnb = priced.reduce((sum, i) => sum + i.subtotal, 0);
      const member = await getMemberDiscount(conn, member_id);
      const memberDiscFnb = Math.round((paidFnb * Number(member.disc_fnb_pct)) / 100);
      const memberDiscRoom = 0; // model harga kamar berbasis threshold, bukan tarif tetap - lihat Open Questions

      // Promo "Hadiah Check-in" (type 'checkin_gift') - hanya di buka-kamar,
      // non-test. Item hadiah disisipkan ke `priced` (ikut cetak tiket dapur/
      // slip gudang + kurangi stok) lalu di-nol-kan lewat promo_disc_fnb, jadi
      // netFnb & threshold waktu TIDAK terpengaruh.
      const giftApplied = [];
      if (!isTest) {
        const gifts = await promo.evaluateCheckinGifts(conn, { idShown: Boolean(id_card_shown) });
        for (const g of gifts) {
          let gp;
          try {
            [gp] = await fetchItemsWithPrice(conn, [{ product_id: g.product_id, qty: g.free_qty }]);
          } catch (e) {
            // Produk hadiah hilang dari m_product -> jangan gagalkan buka-kamar,
            // cukup lewati promo hadiah ini.
            console.warn(`[promo] hadiah check-in "${g.name}" dilewati: ${e.message}`);
            continue;
          }
          priced.push(gp);
          giftApplied.push({
            promo_id: g.promo_id,
            promo_name: g.name,
            promo_type: 'checkin_gift',
            discount_amount: gp.subtotal,
            detail: {
              product_id: gp.product_id, free_qty: gp.qty, unit_price: gp.price,
              requires_id_check: g.requires_id_check, id_card_shown: Boolean(id_card_shown),
            },
          });
        }
      }
      const giftDisc = giftApplied.reduce((s, a) => s + a.discount_amount, 0);

      const totalFnb = paidFnb + giftDisc; // = SUM(priced.subtotal) termasuk hadiah
      const promoDiscFnb = promoEval.promo_disc_fnb + giftDisc;

      const netFnb = totalFnb - memberDiscFnb - promoDiscFnb; // hadiah saling hapus
      const window = getWindowForTime();
      // MODE TEST: sengaja TIDAK query m_promo/tax_service sama sekali -
      // skema tabel itu belum pernah diverifikasi (sama seperti kasus
      // m_product dulu), jadi Mode Test dibuat tidak bergantung padanya
      // supaya tidak ikut gagal kalau skemanya ternyata beda.
      // COMP (VIP/VVIP): threshold_amount TETAP dihitung dengan nilai asli
      // (bukan 0) supaya laporan Tutup Hari bisa menampilkan nilai komplimen
      // yang ditanggung - hanya GATE-nya yang dilewati di bawah.
      const thresholdAmount = isTest ? 0 : await getThresholdAmount(conn, room.room_type, window);

      // COMP (VIP/Komplimen): butuh peran admin/supervisor. Kalau yang LOGIN
      // sudah admin/supervisor -> pakai identitas sesinya, tak perlu ketik
      // ulang password (UI baru: tombol "Buka VIP" hanya muncul di komputer
      // admin). Peran lain -> tetap wajib kredensial approver (kompat lama).
      let compApprover = null;
      let compHours = null;
      if (isComp) {
        compApprover = VOID_APPROVER_ROLES.includes(req.user.role)
          ? { user_id: req.user.user_id, full_name: req.user.full_name || req.user.username, role: req.user.role }
          : await verifyApprover(conn, approver_username, approver_password);
        const raw = comp_hours === undefined || comp_hours === null || comp_hours === ''
          ? COMP_DEFAULT_HOURS
          : Number(comp_hours);
        if (!(raw > 0) || raw > COMP_MAX_HOURS) {
          throw new AppError(400, `comp_hours harus antara 0 dan ${COMP_MAX_HOURS} jam.`);
        }
        compHours = raw;
      }

      // Threshold = minimum belanja F&B (basis DPP). Kalau harga sudah
      // inklusif SC+pajak, bandingkan porsi DPP-nya, bukan angka inklusif.
      const grossDpp = priced.reduce((s, i) => s + Number(i.dpp_price != null ? i.dpp_price : i.price) * i.qty, 0);
      const netForThreshold = priceIncludesTax()
        ? Math.max(0, grossDpp - memberDiscFnb - promoDiscFnb)
        : netFnb;
      if (!isTest && !isComp && netForThreshold < thresholdAmount) {
        throw new AppError(
          400,
          `Belum memenuhi threshold. Belanja F&B (DPP) Rp${netForThreshold.toLocaleString('id-ID')}, ` +
            `minimal Rp${thresholdAmount.toLocaleString('id-ID')} untuk kamar ${room.room_type} (${window}).`
        );
      }

      const serviceChargePct = isTest ? 0 : await getServiceChargePct(conn);
      // Model tagihan di-snapshot per transaksi supaya struk & laporan lama
      // tetap konsisten walau config berubah. Test = tak ada bill -> inclusive.
      const billingMode = isTest ? 'inclusive' : BILLING_MODE;
      const restoTaxPct = isTest ? 0 : RESTO_TAX_PCT;
      const transId = generateTransId();
      // Model bayar-per-order (harga inklusif): pembayaran pembukaan = PENUH.
      const paidAmount = priceIncludesTax() ? netFnb : (Number(initial_paid_amount) || netFnb);

      await conn.query(
        `INSERT INTO web_tr_trans
          (trans_id, room_id, room_type_snapshot, cust_name, person, waiter_id, member_id,
           member_disc_room, member_disc_fnb, promo_disc_fnb, initial_paid_amount, initial_payment_method,
           threshold_window, threshold_amount, status, service_charge_pct, billing_mode, resto_tax_pct, is_test,
           rate_mode, comp_hours, comp_reason, comp_approved_by_user_id,
           opened_by_user_id, opened_at_terminal, start_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          transId, room_id, room.room_type, cust_name || 'MR. GUEST', Number(person) || 0,
          waiter_id || null, member_id || null, memberDiscRoom, memberDiscFnb, promoDiscFnb, paidAmount,
          initial_payment_method || 'cash', window, thresholdAmount, serviceChargePct, billingMode, restoTaxPct, isTest ? 1 : 0,
          isComp ? 'comp' : 'threshold', compHours, isComp ? (comp_reason || null) : null,
          compApprover ? compApprover.user_id : null,
          req.user.user_id, req.terminalId,
        ]
      );

      // Pembayaran order pembukaan (bayar-per-order). Dicatat SELALU supaya
      // paid_total = SUM(web_tr_trans_payments.amount) konsisten.
      const bukaShiftId = await resolveShiftId(conn, req);
      const [bukaPay] = await conn.query(
        `INSERT INTO web_tr_trans_payments
           (trans_id, shift_id, kind, amount, method, paid_by_user_id, paid_at_terminal, note)
         VALUES (?, ?, 'buka', ?, ?, ?, ?, ?)`,
        [transId, bukaShiftId, paidAmount, initial_payment_method || 'cash', req.user.user_id, req.terminalId, 'order pembukaan']
      );
      const bukaPaymentId = bukaPay.insertId;

      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, sc_tax_exempt, payment_id, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, item.sc_tax_exempt ? 1 : 0, bukaPaymentId, req.user.user_id, req.terminalId]
        );
      }

      // Jejak promo yang kena (snapshot utk laporan): B1G1/bundle + hadiah check-in.
      for (const a of [...promoEval.applied, ...giftApplied]) {
        await conn.query(
          `INSERT INTO web_promo_applied
             (trans_id, promo_id, promo_name, promo_type, discount_amount, detail)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [transId, a.promo_id, a.promo_name, a.promo_type, a.discount_amount, JSON.stringify(a.detail || null)]
        );
      }

      // Kurangi stok sub-gudang (atomik dgn insert order di atas). Tidak
      // pernah memblokir - kalau stok kurang, decrementForItems hanya
      // mengembalikan daftar warning utk ditampilkan ke kasir. Mode Test
      // TIDAK menggerakkan stok (konsisten: sesi percobaan tidak menyentuh
      // apa pun yang nyata). Ditaruh SETELAH early-return getIdempotentResponse
      // & SEBELUM saveIdempotentResponse -> retry tidak decrement dua kali.
      const stockWarnings = isTest
        ? []
        : await stock.decrementForItems(conn, priced, {
            refTransId: transId, userId: req.user.user_id, terminalId: req.terminalId,
          });

      // Antre perintah NYALAKAN player room ke server lama (154). Atomik dgn
      // booking (pakai `conn`). Mode Test IKUT menyalakan player - itu inti tes
      // fisik: staf masuk room, cek lagu & mic. Player dimatikan lagi saat
      // "Selesai Tes" (tutup-kamar) atau otomatis oleh worker testMode setelah
      // TEST_MODE_MINUTES.
      await roomPlayer.enqueue(conn, {
        roomId: room_id, desiredState: 'on',
        reason: isTest ? 'test_open' : 'buka_kamar',
        transId, userId: req.user.user_id,
      });
      await conn.query('DELETE FROM web_room_soft_lock WHERE room_id = ?', [room_id]);

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'buka_kamar', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({
          room_id, totalFnb, memberDiscFnb, thresholdAmount, window, is_test: isTest,
          rate_mode: isComp ? 'comp' : 'threshold',
          ...(isComp ? { comp_hours: compHours, comp_reason: comp_reason || null, comp_approved_by: compApprover.full_name } : {}),
          ...(giftApplied.length ? { checkin_gifts: giftApplied.map((g) => g.detail.product_id), id_card_shown: Boolean(id_card_shown) } : {}),
        })]
      );

      // MODE TEST: tidak ada print job sama sekali (slip gudang/billing/tiket
      // dapur) - ini cuma sesi percobaan, jangan bikin gudang/dapur bingung.
      if (!isTest) {
        // Pratinjau tagihan utk struk deposit (billing_room) - pakai rumus
        // yang sama dgn tutup-kamar & laporan.
        const billPreview = computeBill(
          {
            member_disc_fnb: memberDiscFnb, member_disc_room: memberDiscRoom, promo_disc_fnb: promoDiscFnb,
            service_charge_pct: serviceChargePct, billing_mode: billingMode, resto_tax_pct: restoTaxPct,
            initial_paid_amount: paidAmount,
          },
          priced
        );
        // --- 2 print job sekaligus, dari terminal yang sama, ke 2 printer berbeda ---
        await queuePrint(conn, {
          transId,
          printType: 'slip_gudang',
          printerTarget: 'thermal',
          destination: 'local_qz',
          payload: {
            trans_id: transId,
            room_name: room.room_name,
            items: priced.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })), // tanpa harga
          },
        });
        await queuePrint(conn, {
          transId,
          printType: 'billing_room',
          printerTarget: 'epson',
          destination: 'local_qz',
          payload: {
            outlet_name: UNIT_NAME,
            trans_id: transId,
            room_name: room.room_name,
            cust_name: cust_name || 'MR. GUEST',
            start_time: new Date().toISOString(),
            items: priced,
            billing_mode: billPreview.billing_mode,
            price_includes_tax: !!billPreview.price_includes_tax,
            total_fnb: totalFnb,
            fnb_dpp: billPreview.net_dpp != null ? billPreview.net_dpp : billPreview.fnb_ex_service,
            exempt_gross: billPreview.exempt_gross || 0,
            member_disc_fnb: memberDiscFnb,
            promo_disc_fnb: promoDiscFnb,
            service_charge_pct: billPreview.service_charge_pct,
            service_charge: billPreview.service_charge,
            resto_tax_pct: billPreview.resto_tax_pct || 0,
            resto_tax: billPreview.resto_tax || 0,
            grand_total: billPreview.grand_total,
            paid_amount: paidAmount,
            paid_lunas: paidAmount >= billPreview.grand_total,
            payment_method: initial_payment_method || 'cash',
            rate_mode: isComp ? 'comp' : 'threshold',
            comp_note: isComp ? `VIP/VVIP - tanpa minimum F&B - alokasi ${compHours} jam` : null,
          },
        });
        // Tiket dapur - HANYA item yang perlu dimasak (needs_cooking = 1).
        // Item kategori "Bar" (minuman siap saji/beralkohol) TIDAK dapat tiket
        // dapur terpisah - sudah tercakup di slip gudang di atas (dikonfirmasi
        // user: "yang dimaksud dengan bar adalah gudang tersebut").
        const cookItems = priced.filter((i) => i.needs_cooking);
        if (cookItems.length) {
          await queuePrint(conn, {
            transId,
            printType: 'tiket_dapur',
            printerTarget: 'thermal',
            destination: 'dapur_screen',
            payload: {
              trans_id: transId,
              room_id,
              room_name: room.room_name,
              items: cookItems.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
            },
          });
        }
      }

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = {
        trans_id: transId, room_name: room.room_name, print_jobs: printJobs, is_test: isTest,
        rate_mode: isComp ? 'comp' : 'threshold', comp_hours: compHours,
        test_expires_at: isTest ? new Date(Date.now() + TEST_MODE_MINUTES * 60000).toISOString() : null,
        test_minutes: isTest ? TEST_MODE_MINUTES : null,
        stock_warnings: stockWarnings,
        promo_disc_fnb: promoDiscFnb,
        promos_applied: [...promoEval.applied, ...giftApplied],
        checkin_gifts: giftApplied.map((g) => ({
          promo_name: g.promo_name,
          product_name: (priced.find((p) => p.product_id === g.detail.product_id) || {}).product_name_snapshot || g.detail.product_id,
          qty: g.detail.free_qty,
        })),
      };
      await saveIdempotentResponse(conn, 'buka_kamar', requestKey, transId, response);
      return response;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// VOID / TUKAR ITEM (27 Agustus 2026; direvisi 9 Sep 2026).
// Lihat migration 002_void_and_search.sql.
//
// REVISI 9 Sep 2026: Void & Tukar Item hanya bisa dilakukan lewat login
// ADMIN (endpoint di-gate `requireRole('admin')`, tombolnya pun cuma muncul
// di UI untuk admin). Tidak ada lagi popup username+password SPV di terminal
// kasir - jadi password admin tidak pernah diketik di komputer kasir.
// Praktiknya: kasir memanggil admin, admin void dari komputer admin.
//
// Total FnB otomatis benar karena semua tempat menjumlahkan
// web_tr_trans_details.subtotal - void cukup mengurangi qty/subtotal baris
// (atau menghapus baris bila qty habis). web_tr_trans_void = jejak audit.
// =====================================================================
const VOID_APPROVER_ROLES = ['supervisor', 'admin']; // dipakai juga oleh gate comp/VIP

/**
 * Aktor void = user yang sedang login, WAJIB admin. Tidak ada verifikasi
 * password terpisah: kalau sudah bisa login admin, dia berwenang.
 * Bentuk kembaliannya sama dgn verifyApprover lama (dipakai voidOneLine).
 */
function requireAdminActor(req) {
  if (!req.user || req.user.role !== 'admin') {
    throw new AppError(403, 'Void / Tukar Item hanya bisa dilakukan lewat login admin (di komputer admin).');
  }
  return { user_id: req.user.user_id, full_name: req.user.full_name || req.user.username, role: 'admin' };
}

/**
 * Membatalkan sebagian/seluruh satu baris web_tr_trans_details. Dipanggil di
 * dalam withTransaction yang sudah mengunci baris web_tr_trans-nya.
 * Mengembalikan ringkasan { detail_id, product_id, product_name, void_qty, subtotal_voided }.
 */
async function voidOneLine(conn, trans, { detail_id, void_qty, reason }, approver, req) {
  const [dRows] = await conn.query(
    'SELECT * FROM web_tr_trans_details WHERE id = ? AND trans_id = ? FOR UPDATE',
    [detail_id, trans.trans_id]
  );
  if (!dRows.length) throw new AppError(404, `Item pesanan (detail ${detail_id}) tidak ditemukan di transaksi ini.`);
  const row = dRows[0];

  const vq = Number(void_qty);
  if (!Number.isInteger(vq) || vq <= 0 || vq > row.qty) {
    throw new AppError(400, `Qty void tidak valid. Item ini qty-nya ${row.qty}, minta void ${void_qty}.`);
  }

  const subtotalVoided = Number(row.price) * vq;
  const remaining = row.qty - vq;
  if (remaining === 0) {
    await conn.query('DELETE FROM web_tr_trans_details WHERE id = ?', [row.id]);
  } else {
    await conn.query(
      'UPDATE web_tr_trans_details SET qty = ?, subtotal = price * ? WHERE id = ?',
      [remaining, remaining, row.id]
    );
  }

  // Kembalikan stok yang di-void ke sub-gudang (atomik dgn perubahan baris
  // di atas). Mode Test tidak menyentuh stok. Meng-cover void-item DAN sisi
  // void dari exchange (keduanya lewat voidOneLine).
  if (!trans.is_test) {
    await stock.returnForItems(
      conn,
      [{
        product_id: row.product_id,
        product_name_snapshot: row.product_name_snapshot,
        qty: vq,
        detail_id: remaining === 0 ? null : row.id,
      }],
      { refTransId: trans.trans_id, reason: 'void_return', userId: req.user.user_id, terminalId: req.terminalId }
    );
  }

  await conn.query(
    `INSERT INTO web_tr_trans_void
      (trans_id, detail_id, product_id, product_name_snapshot, void_qty, price, subtotal_voided,
       reason, requested_by_user_id, approved_by_user_id, approved_at_terminal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trans.trans_id, remaining === 0 ? null : row.id, row.product_id, row.product_name_snapshot,
      vq, row.price, subtotalVoided, reason || null, req.user.user_id, approver.user_id, req.terminalId,
    ]
  );

  await conn.query(
    `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
     VALUES (?, 'void_item', ?, ?, ?)`,
    [
      trans.trans_id, req.user.user_id, req.terminalId,
      JSON.stringify({
        detail_id: row.id, product_id: row.product_id, product_name: row.product_name_snapshot,
        void_qty: vq, subtotal_voided: subtotalVoided, reason: reason || null,
        approved_by: approver.full_name, approver_role: approver.role,
      }),
    ]
  );

  // Cetak slip retur (kecuali sesi Mode Test - tidak memicu cetakan apa pun).
  if (!trans.is_test) {
    const [rRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
    const roomName = rRows[0]?.room_name || `Room ${trans.room_id}`;
    const [routeRows] = await conn.query(
      'SELECT COALESCE(needs_cooking, 1) AS needs_cooking FROM web_product_routing WHERE product_id = ?',
      [String(row.product_id)]
    );
    const needsCooking = routeRows.length ? Boolean(routeRows[0].needs_cooking) : true;

    await queuePrint(conn, {
      transId: trans.trans_id,
      printType: 'slip_retur',
      printerTarget: 'thermal',
      destination: 'local_qz',
      payload: {
        trans_id: trans.trans_id,
        room_name: roomName,
        items: [{ product_name: row.product_name_snapshot, qty: vq }],
        reason: reason || null,
        approved_by: approver.full_name,
      },
    });
    if (needsCooking) {
      await queuePrint(conn, {
        transId: trans.trans_id,
        printType: 'tiket_dapur_batal',
        printerTarget: 'thermal',
        destination: 'dapur_screen',
        payload: {
          trans_id: trans.trans_id,
          room_id: trans.room_id,
          room_name: roomName,
          items: [{ product_name: row.product_name_snapshot, qty: vq }],
        },
      });
    }
  }

  return {
    detail_id: row.id,
    product_id: row.product_id,
    product_name: row.product_name_snapshot,
    void_qty: vq,
    subtotal_voided: subtotalVoided,
  };
}

// =====================================================================
// POST /api/trans/:id/void-item - batalkan sebagian/seluruh satu item.
// KHUSUS ADMIN (lihat catatan revisi 9 Sep 2026 di atas).
// =====================================================================
router.post('/:id/void-item', requireRole('admin'), async (req, res, next) => {
  try {
    const transId = req.params.id;
    const { detail_id, void_qty, reason, request_key } = req.body;
    const requestKey = request_key || crypto.randomUUID();

    const result = await withTransaction(async (conn) => {
      const cached = await getIdempotentResponse(conn, 'void_item', requestKey);
      if (cached) return cached;

      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      const approver = requireAdminActor(req);
      const voided = await voidOneLine(conn, trans, { detail_id, void_qty, reason }, approver, req);

      // Void bisa menghilangkan item yang tadinya memicu promo -> hitung ulang.
      const promoRes = trans.is_test
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.recomputeForTrans(conn, transId);

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = {
        trans_id: transId, voided, print_jobs: printJobs,
        promo_disc_fnb: promoRes.promo_disc_fnb, promos_applied: promoRes.applied,
      };
      await saveIdempotentResponse(conn, 'void_item', requestKey, transId, response);
      return response;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// POST /api/trans/:id/exchange - tukar item: void sebagian satu item + tambah
// item pengganti. KHUSUS ADMIN (sama seperti void-item).
// =====================================================================
router.post('/:id/exchange', requireRole('admin'), async (req, res, next) => {
  try {
    const transId = req.params.id;
    const {
      detail_id, void_qty, reason, add_items, request_key,
    } = req.body;
    const requestKey = request_key || crypto.randomUUID();

    const result = await withTransaction(async (conn) => {
      const cached = await getIdempotentResponse(conn, 'exchange', requestKey);
      if (cached) return cached;

      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      const approver = requireAdminActor(req);

      // 1) Void sisi lama
      const voided = await voidOneLine(conn, trans, { detail_id, void_qty, reason }, approver, req);

      // 2) Tambah sisi baru (pola sama dgn POST /:id/tambah-order)
      const priced = await fetchItemsWithPrice(conn, add_items || []);
      if (!priced.length) throw new AppError(400, 'Tidak ada item pengganti yang ditambahkan.');
      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, sc_tax_exempt, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, item.sc_tax_exempt ? 1 : 0, req.user.user_id, req.terminalId]
        );
      }

      // Kurangi stok utk item pengganti (sisi void sudah dikembalikan oleh
      // voidOneLine di atas). Mode Test tidak menyentuh stok.
      const stockWarnings = trans.is_test
        ? []
        : await stock.decrementForItems(conn, priced, {
            refTransId: transId, userId: req.user.user_id, terminalId: req.terminalId,
          });

      // Hitung ulang promo atas keranjang setelah void + item pengganti.
      const promoRes = trans.is_test
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.recomputeForTrans(conn, transId);

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tambah_order', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ items: priced, via: 'exchange', exchange_for: voided })]
      );

      const [roomRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
      const cookItems = priced.filter((i) => i.needs_cooking);
      if (!trans.is_test) {
        // slip gudang utk item pengganti (tanpa harga - sama seperti buka-kamar)
        await queuePrint(conn, {
          transId,
          printType: 'slip_gudang',
          printerTarget: 'thermal',
          destination: 'local_qz',
          payload: {
            trans_id: transId,
            room_name: roomRows[0]?.room_name,
            items: priced.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
          },
        });
        if (cookItems.length) {
          await queuePrint(conn, {
            transId,
            printType: 'tiket_dapur',
            printerTarget: 'thermal',
            destination: 'dapur_screen',
            payload: {
              trans_id: transId,
              room_id: trans.room_id,
              room_name: roomRows[0]?.room_name,
              items: cookItems.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
            },
          });
        }
      }

      // 3) Peringatan threshold (TIDAK memblok - SPV sudah menyetujui pertukaran)
      const [sumRows] = await conn.query(
        'SELECT COALESCE(SUM(subtotal), 0) AS total FROM web_tr_trans_details WHERE trans_id = ?',
        [transId]
      );
      const netFnb = Number(sumRows[0].total) - Number(trans.member_disc_fnb) - promoRes.promo_disc_fnb;
      const thresholdAmount = Number(trans.threshold_amount);
      const threshold_warning =
        !trans.is_test && netFnb < thresholdAmount
          ? `Setelah tukar, total FnB Rp${netFnb.toLocaleString('id-ID')} di bawah threshold Rp${thresholdAmount.toLocaleString('id-ID')}.`
          : null;

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = {
        trans_id: transId, voided, added: priced, threshold_warning,
        stock_warnings: stockWarnings, print_jobs: printJobs,
        promo_disc_fnb: promoRes.promo_disc_fnb, promos_applied: promoRes.applied,
      };
      await saveIdempotentResponse(conn, 'exchange', requestKey, transId, response);
      return response;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// POST /api/trans/:id/tambah-order
//   body: { items, paid_amount?, payment_method?, request_key? }
// Harga inklusif: kasir bebas pilih per-ronde:
//   - kirim paid_amount (>= total ronde)  -> DIBAYAR sekarang (struk LUNAS)
//   - tanpa paid_amount                   -> MASUK TAGIHAN, dibayar saat checkout
// Dapur/gudang selalu dapat tiket item ronde ini (tanpa nominal).
// =====================================================================
router.post('/:id/tambah-order', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const { items, paid_amount, payment_method, request_key } = req.body;
    const requestKey = request_key || crypto.randomUUID();
    const validMethods = ['cash', 'qris', 'card'];
    const method = validMethods.includes(payment_method) ? payment_method : 'cash';

    const result = await withTransaction(async (conn) => {
      const cachedTambahOrder = await getIdempotentResponse(conn, 'tambah_order', requestKey);
      if (cachedTambahOrder) return cachedTambahOrder;

      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      const priced = await fetchItemsWithPrice(conn, items);
      if (!priced.length) throw new AppError(400, 'Tidak ada item yang ditambahkan.');

      const roundTotal = priced.reduce((s, i) => s + Number(i.subtotal), 0);
      const inclusiveTax = priceIncludesTax() && !trans.is_test;
      const wantsPayNow = inclusiveTax && paid_amount != null && Number(paid_amount) > 0;

      // --- pembayaran ronde ini (opsional) ---
      let paymentId = null;
      let paidNow = false;
      if (wantsPayNow) {
        const paid = Number(paid_amount);
        if (!Number.isFinite(paid) || paid < roundTotal) {
          throw new AppError(400, `Pembayaran (Rp${(paid || 0).toLocaleString('id-ID')}) kurang dari total order Rp${roundTotal.toLocaleString('id-ID')}.`);
        }
        const shiftId = await resolveShiftId(conn, req);
        const [pay] = await conn.query(
          `INSERT INTO web_tr_trans_payments
             (trans_id, shift_id, kind, amount, method, paid_by_user_id, paid_at_terminal, note)
           VALUES (?, ?, 'tambah', ?, ?, ?, ?, ?)`,
          [transId, shiftId, roundTotal, method, req.user.user_id, req.terminalId, 'tambah item (dibayar saat order)']
        );
        paymentId = pay.insertId;
        paidNow = true;
      }

      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, sc_tax_exempt, payment_id, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, item.sc_tax_exempt ? 1 : 0, paymentId, req.user.user_id, req.terminalId]
        );
      }

      const stockWarnings = trans.is_test
        ? []
        : await stock.decrementForItems(conn, priced, {
            refTransId: transId, userId: req.user.user_id, terminalId: req.terminalId,
          });

      // Promo kumulatif (Mode Test dilewati). Catatan: kalau promo lintas-ronde
      // aktif (B1G1) di model bayar-per-order, perlu logika rekonsiliasi -
      // saat ini tak ada promo/member di data.
      const promoRes = trans.is_test
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.recomputeForTrans(conn, transId);

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, ?, ?, ?, ?)`,
        [transId, paidNow ? 'bayar_order' : 'tambah_order', req.user.user_id, req.terminalId,
          JSON.stringify({ items: priced, round_total: roundTotal, ...(paidNow ? { paid: roundTotal, method } : { on_tab: true }) })]
      );

      const [roomRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
      const roomName = roomRows[0]?.room_name || `Room ${trans.room_id}`;
      const cookItems = priced.filter((i) => i.needs_cooking);
      const takeItems = priced.filter((i) => !i.needs_cooking);

      if (!trans.is_test) {
        // Tiket dapur - HANYA item ronde ini yang perlu dimasak.
        if (cookItems.length) {
          await queuePrint(conn, {
            transId, printType: 'tiket_dapur', printerTarget: 'thermal', destination: 'dapur_screen',
            payload: {
              trans_id: transId, room_id: trans.room_id, room_name: roomName,
              items: cookItems.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
            },
          });
        }
        // Slip ambil gudang - item ronde ini yang tidak dimasak (minuman/rokok/snack).
        if (takeItems.length) {
          await queuePrint(conn, {
            transId, printType: 'slip_gudang', printerTarget: 'thermal', destination: 'local_qz',
            payload: {
              trans_id: transId, room_name: roomName,
              items: takeItems.map((i) => ({ product_name: i.product_name_snapshot, qty: i.qty })),
            },
          });
        }
        // Struk order utk tamu - hanya item ronde ini, ditandai LUNAS.
        const roundBill = computeBill(
          {
            member_disc_fnb: 0, member_disc_room: 0, promo_disc_fnb: 0,
            service_charge_pct: trans.service_charge_pct, billing_mode: trans.billing_mode,
            resto_tax_pct: trans.resto_tax_pct, initial_paid_amount: roundTotal,
          },
          priced
        );
        const [[psum]] = await conn.query(
          'SELECT COALESCE(SUM(amount), 0) AS t FROM web_tr_trans_payments WHERE trans_id = ?',
          [transId]
        );
        await queuePrint(conn, {
          transId, printType: 'struk_order', printerTarget: 'epson', destination: 'local_qz',
          payload: {
            outlet_name: UNIT_NAME,
            trans_id: transId,
            room_name: roomName,
            items: priced,
            billing_mode: roundBill.billing_mode,
            price_includes_tax: !!roundBill.price_includes_tax,
            fnb_dpp: roundBill.net_dpp != null ? roundBill.net_dpp : roundBill.fnb_ex_service,
            exempt_gross: roundBill.exempt_gross || 0,
            service_charge_pct: roundBill.service_charge_pct,
            service_charge: roundBill.service_charge,
            resto_tax_pct: roundBill.resto_tax_pct || 0,
            resto_tax: roundBill.resto_tax || 0,
            grand_total: roundTotal,
            paid_lunas: paidNow,
            on_tab: inclusiveTax && !paidNow, // masuk tagihan, ditagih saat checkout
            payment_method: paidNow ? method : null,
            session_paid_total: Number(psum.t),
          },
        });
      }

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = {
        trans_id: transId, added: priced, round_total: roundTotal,
        paid: paidNow ? roundTotal : 0, on_tab: inclusiveTax && !paidNow,
        stock_warnings: stockWarnings,
        print_jobs: printJobs,
        promo_disc_fnb: promoRes.promo_disc_fnb, promos_applied: promoRes.applied,
      };
      await saveIdempotentResponse(conn, 'tambah_order', requestKey, transId, response);
      return response;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// POST /api/trans/:id/adjust-time  { delta_minutes: <signed int> }
// Tambah (delta > 0) / kurangi (delta < 0) waktu kamar secara MANUAL.
//  - Menambah waktu di mode 'threshold' tetap butuh threshold tercapai.
//  - Mengurangi waktu bebas, tapi total waktu hasil tidak boleh negatif.
//  - Mode Test tidak bisa diubah.
// Disimpan net di web_tr_trans.extra_minutes; tiap aksi 1 baris di
// web_tr_trans_extra_hours (delta_minutes) + 1 baris history 'tambah_jam'.
// =====================================================================
router.post('/:id/adjust-time', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const delta = Math.trunc(Number(req.body.delta_minutes));
    if (!Number.isFinite(delta) || delta === 0) {
      throw new AppError(400, 'delta_minutes harus bilangan bulat bukan nol.');
    }
    if (Math.abs(delta) > 12 * 60) {
      throw new AppError(400, 'Sekali ubah maksimal 12 jam (720 menit).');
    }

    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];
      if (trans.is_test) throw new AppError(400, 'Sesi Mode Test tidak bisa diubah waktunya.');

      // Menambah waktu di mode threshold: threshold F&B harus sudah tercapai
      // DARI YANG SUDAH DIBAYAR - payment_id IS NULL berarti item itu "masuk
      // tagihan" (belum dibayar, lihat tambah-order di atas). Tanpa filter
      // ini, tamu bisa order banyak F&B tanpa bayar sekarang lalu tetap lolos
      // threshold dan dapat waktu tambahan gratis padahal belum ada uang
      // masuk sama sekali (2026-09-15, laporan user).
      //
      // Batas TOTAL waktu tambahan manual (bukan cuma gerbang sekali-lewat):
      // waktu dasar (flat CREDIT_HOURS_PER_THRESHOLD sekali threshold
      // tercapai) sudah "dibayar" oleh 1 kelipatan threshold pertama - setiap
      // kelipatan threshold TAMBAHAN yang sudah dibayar membuka 1 blok
      // CREDIT_HOURS_PER_THRESHOLD tambahan lagi. Sebelum ini extra_minutes
      // tidak dibatasi sama sekali (staf bisa +12 jam berkali-kali begitu
      // threshold tercapai SEKALI saja, walau cuma bayar pas-pasan) -
      // dilaporkan user 2026-09-15 (bayar ~Rp400rb utk threshold Rp200rb,
      // seharusnya maks +2 jam manual tapi bisa nambah sampai +10 jam).
      let maxExtraMinutes = Infinity;
      if (delta > 0 && trans.rate_mode !== 'comp') {
        const [sumRows] = await conn.query(
          'SELECT COALESCE(SUM(subtotal), 0) AS total FROM web_tr_trans_details WHERE trans_id = ? AND payment_id IS NOT NULL',
          [transId]
        );
        const totalFnb =
          Number(sumRows[0].total) - Number(trans.member_disc_fnb) - Number(trans.promo_disc_fnb || 0);
        const threshold = Number(trans.threshold_amount);
        if (totalFnb < threshold) {
          throw new AppError(
            400,
            `Threshold belum tercapai (Rp${totalFnb.toLocaleString('id-ID')} / Rp${threshold.toLocaleString('id-ID')}). Tidak bisa menambah waktu.`
          );
        }
        const multiples = threshold > 0 ? Math.floor(totalFnb / threshold) : 1;
        maxExtraMinutes = Math.max(0, multiples - 1) * CREDIT_HOURS_PER_THRESHOLD * 60;
      }

      const newExtra = Number(trans.extra_minutes || 0) + delta;
      const baseMin =
        (trans.rate_mode === 'comp' ? Number(trans.comp_hours || 0) : CREDIT_HOURS_PER_THRESHOLD) * 60 +
        PAYMENT_SPARE_MIN;
      if (baseMin + newExtra < 0) {
        throw new AppError(400, 'Pengurangan melebihi total waktu kamar.');
      }
      if (delta > 0 && newExtra > maxExtraMinutes) {
        const maxJam = Math.floor(maxExtraMinutes / 60);
        const maxMenit = maxExtraMinutes % 60;
        throw new AppError(
          400,
          `Pembayaran F&B baru cukup untuk maksimal +${maxJam}j ${maxMenit}m waktu tambahan manual (sudah dipakai ${Math.floor(Number(trans.extra_minutes || 0) / 60)}j ${Number(trans.extra_minutes || 0) % 60}m). Tambah pembayaran F&B dulu utk kelipatan threshold berikutnya.`
        );
      }

      await conn.query('UPDATE web_tr_trans SET extra_minutes = ? WHERE trans_id = ?', [newExtra, transId]);
      await conn.query(
        `INSERT INTO web_tr_trans_extra_hours (trans_id, delta_minutes, approved_by_user_id, approved_at_terminal)
         VALUES (?, ?, ?, ?)`,
        [transId, delta, req.user.user_id, req.terminalId]
      );
      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tambah_jam', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ delta_minutes: delta, extra_minutes_after: newExtra })]
      );

      return { trans_id: transId, delta_minutes: delta, extra_minutes: newExtra };
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// POST /api/trans/:id/tutup-kamar
// =====================================================================
router.post('/:id/tutup-kamar', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const { payment_method, request_key } = req.body || {};
    const validMethods = ['cash', 'qris', 'card'];
    const finalPaymentMethod = validMethods.includes(payment_method) ? payment_method : null;
    const requestKey = request_key || crypto.randomUUID();

    const result = await withTransaction(async (conn) => {
      const cachedTutupKamar = await getIdempotentResponse(conn, 'tutup_kamar', requestKey);
      if (cachedTutupKamar) return cachedTutupKamar;

      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      const [details] = await conn.query('SELECT * FROM web_tr_trans_details WHERE trans_id = ?', [transId]);
      // Rumus tagihan = server/services/bill.js (dipakai juga oleh laporan Tutup Hari).
      const bill = computeBill(trans, details);
      const totalFnbGross = bill.fnb_gross;
      const serviceCharge = bill.service_charge;
      const grandTotal = bill.grand_total;

      // Bayar-per-order: total yang sudah dibayar = SUM(web_tr_trans_payments).
      // Checkout normal = rekap, sisa 0. Kalau ada kekurangan (kasir lupa
      // menagih 1 ronde) & kasir memberi metode bayar -> tagih kekurangannya.
      const [[paySum]] = await conn.query(
        'SELECT COALESCE(SUM(amount), 0) AS t FROM web_tr_trans_payments WHERE trans_id = ?',
        [transId]
      );
      let paidTotal = Number(paySum.t);
      let sisaBayar = Math.max(0, Math.round(grandTotal - paidTotal));
      let settledAtCheckout = false;
      if (sisaBayar > 0 && finalPaymentMethod) {
        const settleShiftId = await resolveShiftId(conn, req);
        await conn.query(
          `INSERT INTO web_tr_trans_payments
             (trans_id, shift_id, kind, amount, method, paid_by_user_id, paid_at_terminal, note)
           VALUES (?, ?, 'settle', ?, ?, ?, ?, ?)`,
          [transId, settleShiftId, sisaBayar, finalPaymentMethod, req.user.user_id, req.terminalId, 'pelunasan tagihan saat checkout']
        );
        paidTotal += sisaBayar;
        sisaBayar = 0;
        settledAtCheckout = true;
      }
      const isLunas = sisaBayar === 0;

      await conn.query(
        `UPDATE web_tr_trans
         SET status = 'closed', end_time = NOW(), closed_by_user_id = ?, closed_at_terminal = ?, final_payment_method = ?
         WHERE trans_id = ?`,
        [req.user.user_id, req.terminalId, finalPaymentMethod, transId]
      );
      // Antre perintah MATIKAN player room ke server lama (154). Berlaku juga
      // utk Mode Test - "Selesai Tes" harus mematikan player yang tadi
      // dinyalakan saat mulai tes.
      await roomPlayer.enqueue(conn, {
        roomId: trans.room_id, desiredState: 'off',
        reason: trans.is_test ? 'test_close' : 'tutup_kamar',
        transId, userId: req.user.user_id,
      });

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tutup_kamar', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ grandTotal, paidTotal, sisaBayar, is_test: Boolean(trans.is_test) })]
      );

      if (!trans.is_test) {
        const [roomRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
        await queuePrint(conn, {
          transId,
          printType: 'tagihan_akhir',
          printerTarget: 'epson',
          destination: 'local_qz',
          payload: {
            outlet_name: UNIT_NAME,
            trans_id: transId,
            room_name: roomRows[0]?.room_name,
            items: details,
            billing_mode: bill.billing_mode,
            price_includes_tax: !!bill.price_includes_tax,
            total_fnb_gross: totalFnbGross,
            member_disc_fnb: Number(trans.member_disc_fnb),
            member_disc_room: Number(trans.member_disc_room),
            promo_disc_fnb: Number(trans.promo_disc_fnb || 0),
            fnb_ex_service: bill.fnb_ex_service,
            exempt_gross: bill.exempt_gross || 0,
            service_charge_pct: bill.service_charge_pct,
            service_charge: serviceCharge,
            resto_tax_pct: bill.resto_tax_pct || 0,
            resto_tax: bill.resto_tax || 0,
            grand_total: grandTotal,
            paid_total: paidTotal,
            sisa_bayar: sisaBayar,
            is_lunas: isLunas,
            // rekap murni hanya kalau harga inklusif DAN tidak ada pembayaran
            // di langkah checkout ini (semua sudah dibayar per-ronde).
            is_recap: bill.price_includes_tax === true && !settledAtCheckout,
            settled_at_checkout: settledAtCheckout,
            final_payment_method: finalPaymentMethod,
          },
        });
      }

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = { trans_id: transId, grand_total: grandTotal, paid_total: paidTotal, sisa_bayar: sisaBayar, is_lunas: isLunas, print_jobs: printJobs, is_test: Boolean(trans.is_test) };
      await saveIdempotentResponse(conn, 'tutup_kamar', requestKey, transId, response);
      return response;
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// POST /api/trans/:id/batal - khusus admin/supervisor
// =====================================================================
router.post('/:id/batal', requireRole('admin', 'supervisor'), async (req, res, next) => {
  try {
    const transId = req.params.id;
    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      await conn.query("UPDATE web_tr_trans SET status = 'cancelled' WHERE trans_id = ?", [transId]);

      // Kembalikan stok semua baris yang MASIH tertagih (item yang sudah
      // di-void sebelumnya sudah dikembalikan oleh voidOneLine). Mode Test
      // tidak menyentuh stok. Aman dari double-run: retry 'batal' kena
      // SELECT ... status='active' FOR UPDATE yang kosong -> 404 sebelum sini.
      if (!trans.is_test) {
        const [remaining] = await conn.query(
          `SELECT product_id, product_name_snapshot, SUM(qty) AS qty
             FROM web_tr_trans_details WHERE trans_id = ?
            GROUP BY product_id, product_name_snapshot`,
          [transId]
        );
        await stock.returnForItems(
          conn,
          remaining.map((r) => ({
            product_id: r.product_id,
            product_name_snapshot: r.product_name_snapshot,
            qty: Number(r.qty),
          })),
          { refTransId: transId, reason: 'cancel_return', userId: req.user.user_id, terminalId: req.terminalId }
        );
      }

      // Matikan player - juga utk Mode Test (tes fisik menyalakannya).
      await roomPlayer.enqueue(conn, {
        roomId: trans.room_id, desiredState: 'off',
        reason: trans.is_test ? 'test_close' : 'batal',
        transId, userId: req.user.user_id,
      });
      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'batal', ?, ?, '{}')`,
        [transId, req.user.user_id, req.terminalId]
      );
      return { trans_id: transId, status: 'cancelled' };
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/trans/:id
router.get('/:id', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const [transRows] = await pool.query('SELECT * FROM web_tr_trans WHERE trans_id = ?', [transId]);
    if (!transRows.length) throw new AppError(404, 'Transaksi tidak ditemukan.');
    const [details] = await pool.query('SELECT * FROM web_tr_trans_details WHERE trans_id = ?', [transId]);
    const [extraHours] = await pool.query('SELECT * FROM web_tr_trans_extra_hours WHERE trans_id = ?', [transId]);
    const [payments] = await pool.query(
      'SELECT id, kind, amount, method, note, created_at FROM web_tr_trans_payments WHERE trans_id = ? ORDER BY id',
      [transId]
    );
    const [promosApplied] = await pool.query(
      'SELECT promo_id, promo_name, promo_type, discount_amount, detail FROM web_promo_applied WHERE trans_id = ?',
      [transId]
    );

    const trans = transRows[0];
    const fnbGross = details.reduce((s, d) => s + Number(d.subtotal), 0);
    const netFnb = fnbGross - Number(trans.member_disc_fnb || 0) - Number(trans.promo_disc_fnb || 0);
    const extraMinutes = Number(trans.extra_minutes || 0);
    const totalMs = allottedMs({
      extraMinutes, rateMode: trans.rate_mode, compHours: trans.comp_hours,
    });
    // Mode Test tidak punya alokasi waktu. Selain itu: waktu FLAT =
    // base_hours (2j) + spare bayar + penyesuaian manual (extra_minutes).
    const time_credit = trans.is_test
      ? null
      : {
          net_fnb: netFnb,
          allotted_ms: totalMs,
          allotted_hours: totalMs / 3600000,
          expires_at: new Date(new Date(trans.start_time).getTime() + totalMs).toISOString(),
          hours_per_threshold: CREDIT_HOURS_PER_THRESHOLD, // kompat lama
          base_hours: trans.rate_mode === 'comp'
            ? (trans.comp_hours == null ? null : Number(trans.comp_hours))
            : CREDIT_HOURS_PER_THRESHOLD,
          payment_spare_min: PAYMENT_SPARE_MIN,
          extra_minutes: extraMinutes,
          rate_mode: trans.rate_mode,
          comp_hours: trans.comp_hours == null ? null : Number(trans.comp_hours),
        };
    // Mode Test = tes fisik room: player nyala, auto-mati TEST_MODE_MINUTES
    // sejak start_time (atau saat staf tekan "Selesai Tes").
    const test_session = trans.is_test
      ? {
          minutes: TEST_MODE_MINUTES,
          expires_at: new Date(new Date(trans.start_time).getTime() + TEST_MODE_MINUTES * 60000).toISOString(),
        }
      : null;
    // Rincian tagihan (rumus tunggal server/services/bill.js) - klien
    // (checkout.html / room-detail.html) TIDAK menghitung ulang, cukup pakai ini.
    // `sisa_bayar` dari computeBill hanya memperhitungkan initial_paid_amount;
    // di model bayar-per-order sisa nyata = grand_total - SUM(payments).
    let bill = trans.is_test ? null : computeBill(trans, details);
    const paid_total = payments.reduce((s, p) => s + Number(p.amount), 0);
    if (bill) {
      bill = { ...bill, paid_total, sisa_bayar: Math.max(0, Math.round(bill.grand_total - paid_total)) };
    }
    res.json({ trans, details, extra_hours: extraHours, payments, paid_total, time_credit, test_session, bill, promos_applied: promosApplied });
  } catch (err) {
    next(err);
  }
});

// =====================================================================
// GET /api/trans/:id/receipts
// Daftar struk PELANGGAN yang pernah dibuat utk transaksi ini
// (billing_room = order pembukaan, struk_order = tiap ronde tambah,
// tagihan_akhir = rekap/close). Dipakai utk CEK & CETAK ULANG kalau ada
// struk yang hilang/terlewat. Tiket dapur/gudang TIDAK termasuk (itu
// dokumen internal tanpa nominal).
// =====================================================================
router.get('/:id/receipts', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, print_type, printer_target, status, payload_snapshot, created_at
         FROM web_print_log
        WHERE trans_id = ? AND print_type IN ('billing_room','struk_order','tagihan_akhir')
        ORDER BY id`,
      [req.params.id]
    );
    const LABEL = { billing_room: 'Order Pembukaan', struk_order: 'Struk Order (tambah)', tagihan_akhir: 'Rekap / Close Room' };
    res.json({
      receipts: rows.map((r) => {
        const payload = typeof r.payload_snapshot === 'string' ? JSON.parse(r.payload_snapshot) : r.payload_snapshot;
        return {
          print_log_id: r.id,
          print_type: r.print_type,
          printer_target: r.printer_target,
          label: LABEL[r.print_type] || r.print_type,
          status: r.status,
          created_at: r.created_at,
          grand_total: payload ? (payload.grand_total != null ? payload.grand_total : payload.total_fnb) : null,
          paid_lunas: payload ? !!(payload.paid_lunas || payload.is_lunas) : null,
          on_tab: payload ? !!payload.on_tab : false,
          payload,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
