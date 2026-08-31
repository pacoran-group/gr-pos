/**
 * Rumus tagihan tutup-kamar - SATU sumber kebenaran.
 *
 * Sebelumnya rumus ini di-inline di server/routes/trans.routes.js
 * (tutup-kamar) dan diulang di public/checkout.html & public/room-detail.html
 * (sisi klien). Diekstrak ke sini supaya server-side (tutup-kamar +
 * laporan Tutup Hari) memakai kode yang sama persis dan tidak menyimpang.
 *
 * Model pendapatan gr-pos: pendapatan = F&B bersih + service charge.
 * Tidak ada charge sewa kamar/waktu, tidak ada PPN terpisah.
 *
 * `trans`  : baris web_tr_trans (butuh member_disc_fnb, member_disc_room,
 *            promo_disc_fnb, service_charge_pct, initial_paid_amount - semua
 *            NOT NULL DEFAULT di migration, jadi Number() tidak akan NaN).
 * `details`: array baris web_tr_trans_details (butuh .subtotal). Boleh juga
 *            array satu elemen [{ subtotal: <gross hasil SUM di SQL> }].
 */
function computeBill(trans, details) {
  const rows = Array.isArray(details) ? details : [];
  const fnb_gross = rows.reduce((sum, d) => sum + Number(d.subtotal), 0);

  const member_disc_fnb = Number(trans.member_disc_fnb);
  const member_disc_room = Number(trans.member_disc_room);
  const promo_disc_fnb = Number(trans.promo_disc_fnb || 0);
  const disc_total = member_disc_fnb + member_disc_room + promo_disc_fnb;

  const net_fnb = fnb_gross - member_disc_fnb - member_disc_room - promo_disc_fnb;

  const service_charge_pct = Number(trans.service_charge_pct);
  const service_charge = Math.round((net_fnb * service_charge_pct) / 100);

  const grand_total = net_fnb + service_charge;

  const initial_paid_amount = Number(trans.initial_paid_amount);
  const sisa_bayar = Math.max(0, grand_total - initial_paid_amount);

  return {
    fnb_gross,
    member_disc_fnb,
    member_disc_room,
    promo_disc_fnb,
    disc_total,
    net_fnb,
    service_charge_pct,
    service_charge,
    grand_total,
    initial_paid_amount,
    sisa_bayar,
  };
}

module.exports = { computeBill };
