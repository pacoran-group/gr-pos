const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, withTransaction } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { generateTransId } = require('../utils/idGenerator');
const { getWindowForTime, getThresholdAmount, allottedMs, CREDIT_HOURS_PER_THRESHOLD } = require('../services/threshold.service');
const { queuePrint } = require('../services/printQueue.service');
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
// MODE TEST (27 Agustus 2026) - lihat desain-teknis-room-billing.md.
// Tujuan: kasir/admin bisa buka & coba-coba kamar TANPA memicu efek
// samping ke sistem lama. Transaksi bertanda is_test=1 karena itu:
//   - TIDAK PERNAH mengantre perintah player ke server lama (buka/tutup/batal)
//   - melewati validasi threshold FnB/pembayaran
//   - TIDAK memicu print job apa pun (slip gudang/billing/tagihan/tiket dapur)
// Hanya role di TEST_MODE_ROLES yang boleh mengaktifkannya.
const TEST_MODE_ROLES = ['admin', 'supervisor'];

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
  return items.map((i) => {
    const product = byId[i.product_id];
    if (!product) throw new AppError(400, `Produk ${i.product_id} tidak ditemukan.`);
    const qty = Number(i.qty) || 0;
    if (qty <= 0) throw new AppError(400, `Qty untuk produk ${i.product_id} harus lebih dari 0.`);
    return {
      product_id: product.product_id,
      product_name_snapshot: product.product_name,
      qty,
      price: Number(product.price),
      // harga modal - di-snapshot ke web_stock_movement.unit_cost saat mutasi
      // 'sale' supaya nilai COGS bisa dihitung nanti tanpa join ke harga
      // yang berubah-ubah. Bisa null kalau m_product.harga_mdl kosong.
      cost: product.cost == null ? null : Number(product.cost),
      subtotal: Number(product.price) * qty,
      // true = perlu tiket dapur (dimasak); false = kategori "Bar" - minuman
      // siap saji/beralkohol, cukup ambil dari gudang (sudah ada di slip gudang).
      needs_cooking: Boolean(product.needs_cooking),
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
async function getServiceChargePct(conn) {
  const [rows] = await conn.query('SELECT tax_service AS service_charge_pct FROM tax_service LIMIT 1');
  return rows.length ? Number(rows[0].service_charge_pct) : 0;
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
    const { room_id, cust_name, person, waiter_id, member_id, items, initial_paid_amount, initial_payment_method, request_key, is_test } = req.body;
    if (!room_id) throw new AppError(400, 'room_id wajib diisi.');
    // Fallback kalau client lama/lupa kirim request_key: generate acak di server
    // - tidak memberi proteksi idempotency (tidak ada nilai utk dicocokkan di
    // retry berikutnya), tapi tidak memblokir alur (lihat getIdempotentResponse).
    const requestKey = request_key || crypto.randomUUID();

    const isTest = Boolean(is_test);
    if (isTest && !TEST_MODE_ROLES.includes(req.user.role)) {
      throw new AppError(403, 'Mode Test hanya bisa dipakai oleh admin/supervisor.');
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
        "SELECT trans_id FROM web_tr_trans WHERE room_id = ? AND status = 'active'",
        [room_id]
      );
      if (activeRows.length) {
        throw new AppError(409, `Kamar ${room.room_name} sedang terisi (transaksi ${activeRows[0].trans_id}).`);
      }

      // Jangan buka room yang sedang AKTIF di sistem lama (154) - hindari 2
      // sistem memperebutkan room yang sama. No-op kalau ROOM_PLAYER_SYNC off
      // atau untuk Mode Test.
      //
      // Local-first: cache status 154 (web_legacy_room_state, di-refresh
      // worker read-only tiap ~15s). Cache SEGAR & bilang menyala -> tolak
      // tanpa menyentuh 154 (hemat beban 154 saat peak). Cache basi/absen ->
      // fallback query langsung ke 154 (fail-open kalau 154 tak terhubung).
      if (!isTest) {
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
      const totalFnb = priced.reduce((sum, i) => sum + i.subtotal, 0);

      const member = await getMemberDiscount(conn, member_id);
      const memberDiscFnb = Math.round((totalFnb * Number(member.disc_fnb_pct)) / 100);
      const memberDiscRoom = 0; // model harga kamar berbasis threshold, bukan tarif tetap - lihat Open Questions

      // Promo produk (B1G1 / paket) - AUTO-APPLY atas keranjang pembukaan.
      // Mode Test tidak kena promo. Item gratis TIDAK dihitung utk threshold
      // (netFnb sudah dikurangi promo).
      const promoEval = isTest
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.evaluateActivePromos(conn, cartFromPriced(priced));
      const promoDiscFnb = promoEval.promo_disc_fnb;

      const netFnb = totalFnb - memberDiscFnb - promoDiscFnb;
      const window = getWindowForTime();
      // MODE TEST: sengaja TIDAK query m_promo/tax_service sama sekali -
      // skema tabel itu belum pernah diverifikasi (sama seperti kasus
      // m_product dulu), jadi Mode Test dibuat tidak bergantung padanya
      // supaya tidak ikut gagal kalau skemanya ternyata beda.
      const thresholdAmount = isTest ? 0 : await getThresholdAmount(conn, room.room_type, window);

      if (!isTest && netFnb < thresholdAmount) {
        throw new AppError(
          400,
          `Belum memenuhi threshold. Total pesanan Rp${netFnb.toLocaleString('id-ID')}, ` +
            `minimal Rp${thresholdAmount.toLocaleString('id-ID')} untuk kamar ${room.room_type} (${window}).`
        );
      }

      const serviceChargePct = isTest ? 0 : await getServiceChargePct(conn);
      const transId = generateTransId();
      const paidAmount = Number(initial_paid_amount) || netFnb;

      await conn.query(
        `INSERT INTO web_tr_trans
          (trans_id, room_id, room_type_snapshot, cust_name, person, waiter_id, member_id,
           member_disc_room, member_disc_fnb, promo_disc_fnb, initial_paid_amount, initial_payment_method,
           threshold_window, threshold_amount, status, service_charge_pct, is_test,
           opened_by_user_id, opened_at_terminal, start_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NOW())`,
        [
          transId, room_id, room.room_type, cust_name || 'MR. GUEST', Number(person) || 0,
          waiter_id || null, member_id || null, memberDiscRoom, memberDiscFnb, promoDiscFnb, paidAmount,
          initial_payment_method || 'cash', window, thresholdAmount, serviceChargePct, isTest ? 1 : 0,
          req.user.user_id, req.terminalId,
        ]
      );

      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, req.user.user_id, req.terminalId]
        );
      }

      // Jejak promo yang kena (snapshot utk laporan). promoEval sudah dihitung
      // dari keranjang yang sama dgn `priced` di atas.
      for (const a of promoEval.applied) {
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
      // booking (pakai `conn`). Mode Test tidak menyentuh sistem lama.
      if (!isTest) {
        await roomPlayer.enqueue(conn, {
          roomId: room_id, desiredState: 'on', reason: 'buka_kamar', transId, userId: req.user.user_id,
        });
      }
      await conn.query('DELETE FROM web_room_soft_lock WHERE room_id = ?', [room_id]);

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'buka_kamar', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ room_id, totalFnb, memberDiscFnb, thresholdAmount, window, is_test: isTest })]
      );

      // MODE TEST: tidak ada print job sama sekali (slip gudang/billing/tiket
      // dapur) - ini cuma sesi percobaan, jangan bikin gudang/dapur bingung.
      if (!isTest) {
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
            trans_id: transId,
            room_name: room.room_name,
            cust_name: cust_name || 'MR. GUEST',
            start_time: new Date().toISOString(),
            items: priced,
            total_fnb: totalFnb,
            member_disc_fnb: memberDiscFnb,
            promo_disc_fnb: promoDiscFnb,
            paid_amount: paidAmount,
            payment_method: initial_payment_method || 'cash',
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
        stock_warnings: stockWarnings,
        promo_disc_fnb: promoDiscFnb, promos_applied: promoEval.applied,
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
// VOID / TUKAR ITEM (27 Agustus 2026) - lihat migration 002_void_and_search.sql.
// Kasir tidak boleh membatalkan item sendiri: aksi ini butuh otorisasi
// supervisor/admin (kasir memasukkan username+password SPV di popup, tanpa
// logout). Total FnB otomatis benar karena semua tempat menjumlahkan
// web_tr_trans_details.subtotal - void cukup mengurangi qty/subtotal baris
// (atau menghapus baris bila qty habis). web_tr_trans_void = jejak audit.
// =====================================================================
const VOID_APPROVER_ROLES = ['supervisor', 'admin'];

/** Verifikasi kredensial supervisor/admin yang mengotorisasi void. Throw AppError kalau gagal. */
async function verifyApprover(conn, username, password) {
  if (!username || !password) throw new AppError(400, 'Username & password supervisor wajib diisi untuk otorisasi.');
  const [rows] = await conn.query(
    'SELECT user_id, full_name, role, active, password_hash FROM web_users WHERE username = ?',
    [username]
  );
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) {
    throw new AppError(401, 'Otorisasi supervisor gagal: username/password salah.');
  }
  if (!VOID_APPROVER_ROLES.includes(u.role)) {
    throw new AppError(403, `User "${username}" (${u.role}) tidak berwenang mengotorisasi void. Butuh supervisor/admin.`);
  }
  return { user_id: u.user_id, full_name: u.full_name, role: u.role };
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
// POST /api/trans/:id/void-item - batalkan sebagian/seluruh satu item,
// otorisasi supervisor/admin.
// =====================================================================
router.post('/:id/void-item', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const { detail_id, void_qty, reason, approver_username, approver_password, request_key } = req.body;
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

      const approver = await verifyApprover(conn, approver_username, approver_password);
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
// item pengganti, SATU kali otorisasi supervisor/admin. Untuk skenario upsale.
// =====================================================================
router.post('/:id/exchange', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const {
      detail_id, void_qty, reason, add_items,
      approver_username, approver_password, request_key,
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

      const approver = await verifyApprover(conn, approver_username, approver_password);

      // 1) Void sisi lama
      const voided = await voidOneLine(conn, trans, { detail_id, void_qty, reason }, approver, req);

      // 2) Tambah sisi baru (pola sama dgn POST /:id/tambah-order)
      const priced = await fetchItemsWithPrice(conn, add_items || []);
      if (!priced.length) throw new AppError(400, 'Tidak ada item pengganti yang ditambahkan.');
      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, req.user.user_id, req.terminalId]
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
// =====================================================================
router.post('/:id/tambah-order', async (req, res, next) => {
  try {
    const transId = req.params.id;
    const { items, request_key } = req.body;
    const requestKey = request_key || crypto.randomUUID();

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

      for (const item of priced) {
        await conn.query(
          `INSERT INTO web_tr_trans_details
            (trans_id, product_id, product_name_snapshot, qty, price, subtotal, added_by_user_id, added_at_terminal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [transId, item.product_id, item.product_name_snapshot, item.qty, item.price, item.subtotal, req.user.user_id, req.terminalId]
        );
      }

      // Kurangi stok sub-gudang (atomik dgn insert order). Mode Test tidak
      // menyentuh stok. Setelah early-return getIdempotentResponse & sebelum
      // saveIdempotentResponse -> retry tidak decrement dua kali.
      const stockWarnings = trans.is_test
        ? []
        : await stock.decrementForItems(conn, priced, {
            refTransId: transId, userId: req.user.user_id, terminalId: req.terminalId,
          });

      // Promo dihitung ulang atas SELURUH keranjang kumulatif (mis. beli 1 jus
      // di order awal + 1 jus sekarang -> baru dapat B1G1). Mode Test dilewati.
      const promoRes = trans.is_test
        ? { promo_disc_fnb: 0, applied: [] }
        : await promo.recomputeForTrans(conn, transId);

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tambah_order', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ items: priced })]
      );

      const [roomRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
      const cookItems = priced.filter((i) => i.needs_cooking);
      if (!trans.is_test && cookItems.length) {
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

      const response = {
        trans_id: transId, added: priced, stock_warnings: stockWarnings,
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
// POST /api/trans/:id/tambah-jam - gated: threshold harus sudah tercapai
// =====================================================================
router.post('/:id/tambah-jam', async (req, res, next) => {
  try {
    const transId = req.params.id;

    const result = await withTransaction(async (conn) => {
      const [rows] = await conn.query(
        "SELECT * FROM web_tr_trans WHERE trans_id = ? AND status = 'active' FOR UPDATE",
        [transId]
      );
      if (!rows.length) throw new AppError(404, 'Transaksi aktif tidak ditemukan.');
      const trans = rows[0];

      const [sumRows] = await conn.query(
        'SELECT COALESCE(SUM(subtotal), 0) AS total FROM web_tr_trans_details WHERE trans_id = ?',
        [transId]
      );
      // Item promo (gratis) tidak dihitung utk threshold - lihat migration 009.
      const totalFnb = Number(sumRows[0].total) - Number(trans.member_disc_fnb) - Number(trans.promo_disc_fnb || 0);

      if (totalFnb < Number(trans.threshold_amount)) {
        throw new AppError(
          400,
          `Threshold belum tercapai (Rp${totalFnb.toLocaleString('id-ID')} / Rp${Number(trans.threshold_amount).toLocaleString('id-ID')}). Tambah jam belum diperbolehkan.`
        );
      }

      await conn.query(
        `INSERT INTO web_tr_trans_extra_hours (trans_id, approved_by_user_id, approved_at_terminal)
         VALUES (?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId]
      );
      await conn.query('UPDATE web_tr_trans SET extra_hours_used = extra_hours_used + 1 WHERE trans_id = ?', [transId]);
      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tambah_jam', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({})]
      );

      return { trans_id: transId, extra_hours_used: trans.extra_hours_used + 1 };
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
      const sisaBayar = bill.sisa_bayar;

      await conn.query(
        `UPDATE web_tr_trans
         SET status = 'closed', end_time = NOW(), closed_by_user_id = ?, closed_at_terminal = ?, final_payment_method = ?
         WHERE trans_id = ?`,
        [req.user.user_id, req.terminalId, finalPaymentMethod, transId]
      );
      // Antre perintah MATIKAN player room ke server lama (154). Mode Test
      // tidak pernah menyalakan, jadi tidak perlu mematikan.
      if (!trans.is_test) {
        await roomPlayer.enqueue(conn, {
          roomId: trans.room_id, desiredState: 'off', reason: 'tutup_kamar', transId, userId: req.user.user_id,
        });
      }

      await conn.query(
        `INSERT INTO web_tr_trans_history (trans_id, action, user_id, terminal_id, detail)
         VALUES (?, 'tutup_kamar', ?, ?, ?)`,
        [transId, req.user.user_id, req.terminalId, JSON.stringify({ grandTotal, sisaBayar, is_test: Boolean(trans.is_test) })]
      );

      if (!trans.is_test) {
        const [roomRows] = await conn.query('SELECT room_name FROM m_room WHERE room_id = ?', [trans.room_id]);
        await queuePrint(conn, {
          transId,
          printType: 'tagihan_akhir',
          printerTarget: 'epson',
          destination: 'local_qz',
          payload: {
            trans_id: transId,
            room_name: roomRows[0]?.room_name,
            items: details,
            total_fnb_gross: totalFnbGross,
            member_disc_fnb: Number(trans.member_disc_fnb),
            member_disc_room: Number(trans.member_disc_room),
            promo_disc_fnb: Number(trans.promo_disc_fnb || 0),
            service_charge: serviceCharge,
            grand_total: grandTotal,
            initial_paid_amount: Number(trans.initial_paid_amount),
            sisa_bayar: sisaBayar,
            final_payment_method: finalPaymentMethod,
          },
        });
      }

      const printJobs = await fetchLocalPrintJobs(conn, transId);
      const response = { trans_id: transId, grand_total: grandTotal, sisa_bayar: sisaBayar, print_jobs: printJobs, is_test: Boolean(trans.is_test) };
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

      if (!trans.is_test) {
        await roomPlayer.enqueue(conn, {
          roomId: trans.room_id, desiredState: 'off', reason: 'batal', transId, userId: req.user.user_id,
        });
      }
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
    const [promosApplied] = await pool.query(
      'SELECT promo_id, promo_name, promo_type, discount_amount, detail FROM web_promo_applied WHERE trans_id = ?',
      [transId]
    );

    const trans = transRows[0];
    const fnbGross = details.reduce((s, d) => s + Number(d.subtotal), 0);
    const netFnb = fnbGross - Number(trans.member_disc_fnb || 0) - Number(trans.promo_disc_fnb || 0);
    const totalMs = allottedMs({
      netFnb, thresholdAmount: trans.threshold_amount, extraHours: trans.extra_hours_used,
    });
    // Mode Test tidak punya alokasi waktu (threshold 0).
    const time_credit = trans.is_test
      ? null
      : {
          net_fnb: netFnb,
          allotted_ms: totalMs,
          allotted_hours: totalMs / 3600000,
          expires_at: new Date(new Date(trans.start_time).getTime() + totalMs).toISOString(),
          hours_per_threshold: CREDIT_HOURS_PER_THRESHOLD,
        };
    res.json({ trans, details, extra_hours: extraHours, time_credit, promos_applied: promosApplied });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
