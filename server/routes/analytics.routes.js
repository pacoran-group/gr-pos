/**
 * Analitik / Insight manajemen - laporan agregat lintas-hari untuk top
 * management (performa unit, heatmap jam x hari, produk fast/slow moving,
 * bauran pembayaran, insight otomatis).
 *
 * Read-only, admin / supervisor. Sumber: web_tr_trans + web_tr_trans_details
 * (status='closed', is_test=0). Model pendapatan sama dgn EOD:
 * pendapatan = F&B bersih (SC inklusif) = Σ subtotal − diskon member − promo.
 *
 * Hari usaha memakai EOD_CUTOFF_HOUR (karaoke lewat tengah malam), jadi
 * transaksi jam 02:00 masuk hari sebelumnya - konsisten dgn laporan Tutup Hari.
 */
const express = require('express');
const { pool } = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { EOD_CUTOFF_HOUR } = require('../config/report');
const { businessDayRange } = require('../services/dailyClose.service');
const { UNIT_ID, UNIT_NAME } = require('../config/unit');

const router = express.Router();
router.use(requireAuth);
// head_unit SENGAJA tidak dimasukkan - Analitik disembunyikan dari role ini.
const MANAGE = ['admin', 'head_karaoke', 'supervisor'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DOW_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const rp = (n) => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');

// hari usaha dari end_time: kalau jam < cutoff, hitung hari sebelumnya
function businessDateOf(dt) {
  const d = new Date(dt);
  if (d.getHours() < EOD_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return ymd(d);
}

router.get('/overview', requireRole(...MANAGE), async (req, res, next) => {
  try {
    const today = new Date();
    const defFrom = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29);
    const from = DATE_RE.test(req.query.from || '') ? req.query.from : ymd(defFrom);
    const to = DATE_RE.test(req.query.to || '') ? req.query.to : ymd(today);
    const start = businessDayRange(from).start_str;
    const end = businessDayRange(to).end_str;
    const win = [start, end];

    // --- per transaksi (untuk KPI, harian, heatmap, per kamar, pembayaran) ---
    const [tx] = await pool.query(
      `SELECT t.trans_id, t.room_id, t.room_type_snapshot, t.person, t.start_time, t.end_time,
              t.rate_mode, t.comp_hours, t.threshold_amount,
              t.member_disc_fnb, t.member_disc_room, t.promo_disc_fnb,
              t.billing_mode, t.service_charge_pct, t.resto_tax_pct,
              t.initial_paid_amount, t.initial_payment_method, t.final_payment_method,
              COALESCE(r.room_name, CONCAT('Room ', t.room_id)) AS room_name,
              COALESCE(SUM(d.subtotal), 0) AS fnb_gross,
              COALESCE(SUM(CASE WHEN d.sc_tax_exempt = 1 THEN d.subtotal ELSE 0 END), 0) AS fnb_exempt_gross
         FROM web_tr_trans t
         LEFT JOIN web_tr_trans_details d ON d.trans_id = t.trans_id
         LEFT JOIN m_room r ON r.room_id = t.room_id
        WHERE t.status = 'closed' AND t.is_test = 0
          AND t.end_time >= ? AND t.end_time < ?
        GROUP BY t.trans_id`,
      win
    );

    // --- produk + kategori ---
    const [prod] = await pool.query(
      `SELECT d.product_id, MAX(d.product_name_snapshot) AS name,
              COALESCE(MAX(p.category), '-') AS category,
              SUM(d.qty) AS qty, SUM(d.subtotal) AS value
         FROM web_tr_trans_details d
         JOIN web_tr_trans t ON t.trans_id = d.trans_id
         LEFT JOIN m_product p ON CAST(p.prod_id AS CHAR) = d.product_id
        WHERE t.status = 'closed' AND t.is_test = 0
          AND t.end_time >= ? AND t.end_time < ?
        GROUP BY d.product_id
        ORDER BY qty DESC`,
      win
    );

    // ---------- agregasi di JS ----------
    const daily = new Map();          // bd -> {revenue, txn, guests}
    const heat = new Map();           // "dow-hour" -> {txn, revenue}
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, txn: 0, revenue: 0 }));
    const byType = new Map();
    const byRoom = new Map();
    const payAmt = { tunai: 0, qris: 0, kartu: 0, lainnya: 0 };
    const payTxn = { tunai: 0, qris: 0, kartu: 0, lainnya: 0 };
    const dowAgg = Array.from({ length: 7 }, () => ({ revenue: 0, txn: 0, days: new Set() }));

    let revenue = 0, guests = 0, compCount = 0, compValue = 0;
    let heatMax = 0;

    const normPay = (v) => {
      const s = String(v == null ? '' : v).trim().toLowerCase();
      if (s === 'cash') return 'tunai';
      if (s === 'qris') return 'qris';
      if (s === 'debit' || s === 'credit' || s === 'card') return 'kartu';
      return 'lainnya';
    };

    for (const t of tx) {
      // "Pendapatan" = DPP F&B bersih + Service Charge (Pajak Restoran TIDAK
      // dihitung - itu titipan pajak). Model lama 'inclusive': fnb_gross sudah
      // mengandung SC, jadi net di bawah sudah = DPP+SC. Model 'plusplus':
      // fnb_gross = DPP murni -> SC ditambahkan di sini (rokok dikecualikan).
      const netVal = Number(t.fnb_gross) - Number(t.member_disc_fnb) - Number(t.member_disc_room) - Number(t.promo_disc_fnb);
      const taxablePart = Math.max(0, netVal - Number(t.fnb_exempt_gross || 0));
      const taxPct = Number(t.resto_tax_pct || 0);
      let net = netVal;
      if (t.billing_mode === 'plusplus') {
        // fnb_gross = DPP -> tambahkan SC (Pajak Restoran tidak dihitung).
        net += Math.round((taxablePart * Number(t.service_charge_pct || 0)) / 100);
      } else if (taxPct > 0) {
        // Harga inklusif SC+PB1 -> kupas Pajak Restoran dari porsi non-rokok.
        net -= Math.round((taxablePart * taxPct) / (100 + taxPct));
      }
      revenue += net;
      guests += Number(t.person) || 0;

      const bd = businessDateOf(t.end_time);
      const dRec = daily.get(bd) || { revenue: 0, txn: 0, guests: 0 };
      dRec.revenue += net; dRec.txn += 1; dRec.guests += Number(t.person) || 0;
      daily.set(bd, dRec);

      const st = new Date(t.start_time);
      const dow = st.getDay();
      const hr = st.getHours();
      const hk = `${dow}-${hr}`;
      const hRec = heat.get(hk) || { txn: 0, revenue: 0 };
      hRec.txn += 1; hRec.revenue += net;
      heat.set(hk, hRec);
      if (hRec.txn > heatMax) heatMax = hRec.txn;
      hourly[hr].txn += 1; hourly[hr].revenue += net;

      // dow agregat pakai hari USAHA supaya "Sabtu" konsisten dgn tanggal usaha
      const bdDate = new Date(bd + 'T12:00:00');
      const bdow = bdDate.getDay();
      dowAgg[bdow].revenue += net; dowAgg[bdow].txn += 1; dowAgg[bdow].days.add(bd);

      const rt = t.room_type_snapshot || '(lainnya)';
      const tRec = byType.get(rt) || { room_type: rt, txn: 0, revenue: 0 };
      tRec.txn += 1; tRec.revenue += net; byType.set(rt, tRec);

      const rRec = byRoom.get(t.room_name) || { room_name: t.room_name, txn: 0, revenue: 0 };
      rRec.txn += 1; rRec.revenue += net; byRoom.set(t.room_name, rRec);

      const dep = normPay(t.initial_payment_method);
      const fin = normPay(t.final_payment_method);
      const paid = Number(t.initial_paid_amount) || 0;
      const sisa = Math.max(0, net - paid);
      payAmt[dep] += Math.min(paid, net); payTxn[dep] += paid > 0 ? 1 : 0;
      payAmt[fin] += sisa; payTxn[fin] += sisa > 0 ? 1 : 0;

      if (t.rate_mode === 'comp') { compCount += 1; compValue += Number(t.threshold_amount) || 0; }
    }

    const dailyArr = [...daily.entries()]
      .map(([date, v]) => ({ date, dow: new Date(date + 'T12:00:00').getDay(), ...v, revenue: Math.round(v.revenue) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const nDays = dailyArr.length || 1;
    const itemsSold = prod.reduce((s, p) => s + Number(p.qty), 0);

    // weekday vs weekend (rata-rata per hari)
    const wk = { we: { rev: 0, d: new Set() }, wd: { rev: 0, d: new Set() } };
    for (const d of dailyArr) {
      const bucket = (d.dow === 0 || d.dow === 5 || d.dow === 6) ? wk.we : wk.wd;
      bucket.rev += d.revenue; bucket.d.add(d.date);
    }
    const weAvg = wk.we.d.size ? wk.we.rev / wk.we.d.size : 0;
    const wdAvg = wk.wd.d.size ? wk.wd.rev / wk.wd.d.size : 0;

    const byTypeArr = [...byType.values()]
      .map((v) => ({ ...v, revenue: Math.round(v.revenue), avg: Math.round(v.revenue / v.txn), share: revenue ? v.revenue / revenue : 0 }))
      .sort((a, b) => b.revenue - a.revenue);
    const topRooms = [...byRoom.values()]
      .map((v) => ({ ...v, revenue: Math.round(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue).slice(0, 12);

    const heatCells = [...heat.entries()].map(([k, v]) => {
      const [d, h] = k.split('-').map(Number);
      return { dow: d, hour: h, txn: v.txn, revenue: Math.round(v.revenue) };
    });

    // kategori
    const catMap = new Map();
    for (const p of prod) {
      const c = p.category || '-';
      const rec = catMap.get(c) || { category: c, qty: 0, value: 0 };
      rec.qty += Number(p.qty); rec.value += Number(p.value); catMap.set(c, rec);
    }
    const categoryMix = [...catMap.values()].map((v) => ({ ...v, value: Math.round(v.value) })).sort((a, b) => b.value - a.value);

    const productsFast = prod.slice(0, 15).map((p) => ({
      product_id: p.product_id, name: p.name, category: p.category,
      qty: Number(p.qty), value: Math.round(Number(p.value)),
    }));
    const productsSlow = prod.filter((p) => Number(p.qty) > 0).slice(-8).reverse().map((p) => ({
      product_id: p.product_id, name: p.name, category: p.category,
      qty: Number(p.qty), value: Math.round(Number(p.value)),
    }));

    const paymentMix = ['tunai', 'qris', 'kartu', 'lainnya'].map((m) => ({
      method: m, txn: payTxn[m], amount: Math.round(payAmt[m]),
    }));

    // ---------- insight otomatis ----------
    const insights = [];
    if (dailyArr.length) {
      const bestDow = dowAgg
        .map((v, i) => ({ dow: i, avg: v.days.size ? v.revenue / v.days.size : 0, txn: v.txn }))
        .filter((v) => v.avg > 0)
        .sort((a, b) => b.avg - a.avg)[0];
      if (bestDow) {
        insights.push(`Hari teramai: ${DOW_ID[bestDow.dow]} — rata-rata ${rp(bestDow.avg)}/hari.`);
      }

      // jendela 3 jam tersibuk
      let bestWin = { h: 20, txn: 0 };
      for (let h = 0; h < 24; h++) {
        const s = hourly[h].txn + hourly[(h + 1) % 24].txn + hourly[(h + 2) % 24].txn;
        if (s > bestWin.txn) bestWin = { h, txn: s };
      }
      const totalTxn = tx.length || 1;
      insights.push(`Jam sibuk: ${pad(bestWin.h)}:00–${pad((bestWin.h + 3) % 24)}:00 — ${Math.round((bestWin.txn / totalTxn) * 100)}% dari seluruh transaksi.`);
    }
    if (prod.length) {
      insights.push(`Produk terlaris: ${prod[0].name} — ${Number(prod[0].qty).toLocaleString('id-ID')} terjual (${rp(prod[0].value)}).`);
      const deadish = prod.filter((p) => Number(p.qty) > 0).slice(-1)[0];
      if (deadish && prod.length > 5) insights.push(`Paling lambat: ${deadish.name} — hanya ${Number(deadish.qty)} terjual sepanjang periode.`);
    }
    if (byTypeArr.length) {
      insights.push(`Tipe kamar penyumbang terbesar: ${byTypeArr[0].room_type} — ${Math.round(byTypeArr[0].share * 100)}% pendapatan.`);
    }
    if (tx.length) {
      insights.push(`Rata-rata belanja per sesi: ${rp(revenue / tx.length)} · per tamu: ${rp(guests ? revenue / guests : 0)}.`);
    }
    if (weAvg && wdAvg) {
      insights.push(`Akhir pekan (Jum–Min) ${(weAvg / wdAvg).toFixed(1)}× lipat rata-rata hari kerja.`);
    }
    if (compCount) {
      insights.push(`Sesi komplimen VIP/VVIP: ${compCount} — nilai threshold ditanggung ${rp(compValue)}.`);
    }

    res.json({
      unit: { unit_id: UNIT_ID, unit_name: UNIT_NAME },
      range: { from, to, start, end, cutoff_hour: EOD_CUTOFF_HOUR },
      kpi: {
        revenue: Math.round(revenue),
        txn: tx.length,
        guests,
        days: dailyArr.length,
        avg_txn: tx.length ? Math.round(revenue / tx.length) : 0,
        avg_day: Math.round(revenue / nDays),
        items_sold: itemsSold,
        comp_count: compCount,
        comp_value: Math.round(compValue),
        weekend_avg_day: Math.round(weAvg),
        weekday_avg_day: Math.round(wdAvg),
      },
      daily: dailyArr,
      heatmap: { max: heatMax, cells: heatCells },
      hourly: hourly.map((h) => ({ ...h, revenue: Math.round(h.revenue) })),
      by_room_type: byTypeArr,
      top_rooms: topRooms,
      products_fast: productsFast,
      products_slow: productsSlow,
      category_mix: categoryMix,
      payment_mix: paymentMix,
      insights,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
