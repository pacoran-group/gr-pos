/**
 * Rumus tagihan tutup-kamar - SATU sumber kebenaran.
 *
 * Dipakai server-side (tutup-kamar + laporan Tutup Hari + GET /trans/:id)
 * supaya semua tempat memakai kode yang sama persis.
 *
 * DUA model, dipilih per-transaksi lewat `trans.billing_mode`
 * (di-snapshot saat buka kamar - lihat migration 016):
 *
 *  - 'inclusive' (LAMA, default utk transaksi lama): harga menu = harga
 *    final; Service Charge SUDAH termasuk di dalamnya (dihitung mundur utk
 *    ditampilkan, tidak ditambah); tidak ada pajak terpisah.
 *
 *  - 'plusplus'  (BARU): harga menu = DPP MURNI. Service Charge x%
 *    DITAMBAH di atas DPP. Pajak Restoran (PB1) y% DITAMBAH di atas
 *    (DPP + Service Charge). Item ber-`sc_tax_exempt=1` (kategori Rokok)
 *    BEBAS SC & pajak. grand_total = DPP + SC + Pajak.
 *
 * `trans`  : baris web_tr_trans (member_disc_fnb, member_disc_room,
 *            promo_disc_fnb, service_charge_pct, billing_mode, resto_tax_pct,
 *            initial_paid_amount - semua NOT NULL DEFAULT).
 * `details`: array baris web_tr_trans_details (butuh .subtotal; utk
 *            'plusplus' & inklusif-berpajak juga .sc_tax_exempt). Boleh array
 *            satu/dua elemen sintetis [{subtotal, sc_tax_exempt}] utk laporan.
 */
const { carveInclusive } = require('../config/billing');

function computeBill(trans, details) {
  const mode = (trans.billing_mode || 'inclusive') === 'plusplus' ? 'plusplus' : 'inclusive';
  return mode === 'plusplus'
    ? computeBillPlusPlus(trans, details)
    : computeBillInclusive(trans, details);
}

// --- Model INKLUSIF: harga sudah final ---------------------------------
//  resto_tax_pct = 0 -> hanya SC yg inklusif (perilaku 3 Sep 2026).
//  resto_tax_pct > 0 -> SC + Pajak Restoran (PB1) inklusif; rokok bebas.
//                       DPP/SC/PB1 dikupas mundur utk struk & laporan.
function computeBillInclusive(trans, details) {
  const rows = Array.isArray(details) ? details : [];
  const fnb_gross = rows.reduce((sum, d) => sum + Number(d.subtotal), 0);

  const member_disc_fnb = Number(trans.member_disc_fnb);
  const member_disc_room = Number(trans.member_disc_room);
  const promo_disc_fnb = Number(trans.promo_disc_fnb || 0);
  const disc_total = member_disc_fnb + member_disc_room + promo_disc_fnb;

  const service_charge_pct = Number(trans.service_charge_pct);
  const resto_tax_pct = Number(trans.resto_tax_pct || 0);

  const net_incl = fnb_gross - disc_total; // total inklusif yang dibayar tamu
  const grand_total = net_incl;
  const initial_paid_amount = Number(trans.initial_paid_amount);
  const sisa_bayar = Math.max(0, grand_total - initial_paid_amount);

  if (resto_tax_pct > 0) {
    // Harga sudah mengandung SC + PB1. Kupas balik dari porsi non-rokok.
    const exempt_gross = rows.reduce(
      (s, d) => s + (Number(d.sc_tax_exempt) ? Number(d.subtotal) : 0),
      0
    );
    const taxable_gross = fnb_gross - exempt_gross;
    const taxable_net = Math.max(0, taxable_gross - disc_total); // diskon dibebankan ke non-rokok
    const exempt_net = exempt_gross;
    const carved = carveInclusive(taxable_net, service_charge_pct, resto_tax_pct);
    const net_dpp = carved.dpp + exempt_net;

    return {
      billing_mode: 'inclusive',
      price_includes_tax: true,
      fnb_gross,
      taxable_gross,
      exempt_gross,
      member_disc_fnb,
      member_disc_room,
      promo_disc_fnb,
      disc_total,
      net_dpp,
      net_fnb: net_dpp + carved.service_charge, // DPP + SC (pendapatan ex-pajak)
      fnb_ex_service: net_dpp,
      service_charge_pct,
      service_charge: carved.service_charge,
      resto_tax_pct,
      resto_tax: carved.resto_tax,
      grand_total,
      initial_paid_amount,
      sisa_bayar,
    };
  }

  // resto_tax_pct = 0: hanya SC inklusif (perilaku lama).
  const net_fnb = net_incl;
  const service_charge = Math.round(net_fnb - net_fnb / (1 + service_charge_pct / 100));
  const fnb_ex_service = net_fnb - service_charge;

  return {
    billing_mode: 'inclusive',
    price_includes_tax: false,
    fnb_gross,
    member_disc_fnb,
    member_disc_room,
    promo_disc_fnb,
    disc_total,
    net_fnb,
    fnb_ex_service,
    service_charge_pct,
    service_charge,
    resto_tax_pct: 0,
    resto_tax: 0,
    grand_total,
    initial_paid_amount,
    sisa_bayar,
  };
}

// --- Model BARU: "++" (Service Charge + Pajak Restoran DITAMBAH) -------
function computeBillPlusPlus(trans, details) {
  const rows = Array.isArray(details) ? details : [];
  const fnb_gross = rows.reduce((s, d) => s + Number(d.subtotal), 0);
  const exempt_gross = rows.reduce(
    (s, d) => s + (Number(d.sc_tax_exempt) ? Number(d.subtotal) : 0),
    0
  );
  const taxable_gross = fnb_gross - exempt_gross;

  const member_disc_fnb = Number(trans.member_disc_fnb);
  const member_disc_room = Number(trans.member_disc_room);
  const promo_disc_fnb = Number(trans.promo_disc_fnb || 0);
  const disc_total = member_disc_fnb + member_disc_room + promo_disc_fnb;

  // Diskon dibebankan ke porsi NON-rokok (rokok tak pernah didiskon).
  const taxable_dpp = Math.max(0, taxable_gross - disc_total);
  const exempt_dpp = exempt_gross;
  const net_dpp = taxable_dpp + exempt_dpp;

  const service_charge_pct = Number(trans.service_charge_pct) || 0;
  const resto_tax_pct = Number(trans.resto_tax_pct) || 0;
  const service_charge = Math.round((taxable_dpp * service_charge_pct) / 100);
  const resto_tax = Math.round(((taxable_dpp + service_charge) * resto_tax_pct) / 100);

  const grand_total = net_dpp + service_charge + resto_tax;

  const initial_paid_amount = Number(trans.initial_paid_amount);
  const sisa_bayar = Math.max(0, grand_total - initial_paid_amount);

  return {
    billing_mode: 'plusplus',
    fnb_gross,
    taxable_gross,
    exempt_gross,
    member_disc_fnb,
    member_disc_room,
    promo_disc_fnb,
    disc_total,
    net_dpp,
    taxable_dpp,
    exempt_dpp,
    // alias kompat utk pembaca lama (checkout lama, dll):
    net_fnb: net_dpp,
    fnb_ex_service: net_dpp, // DPP di model ini memang sudah ex-Service Charge
    service_charge_pct,
    service_charge,
    resto_tax_pct,
    resto_tax,
    grand_total,
    initial_paid_amount,
    sisa_bayar,
  };
}

module.exports = { computeBill, computeBillInclusive, computeBillPlusPlus };
