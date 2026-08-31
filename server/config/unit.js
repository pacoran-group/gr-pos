/**
 * Identitas UNIT + SUB-GUDANG untuk deployment ini. Di-set per venue lewat
 * .env (UNIT_ID / UNIT_NAME / WAREHOUSE_ID). Dipakai stock.service untuk
 * men-stamp unit_id/warehouse_id di tiap baris stok & mutasi, supaya skema
 * lokal identik dengan yang dibutuhkan DB konsolidasi PUSAT (banyak unit /
 * banyak gudang) - lihat migration 004_create_inventory.sql.
 *
 * Default aman dipakai apa adanya untuk dev / venue tunggal: satu unit,
 * satu sub-gudang. Wajib diisi eksplisit begitu >1 unit menulis ke DB
 * konsolidasi yang sama.
 *
 * SYNC_OUTBOX_ENABLED: kalau 'on' (default), tiap mutasi stok juga ditulis
 * ke web_sync_outbox untuk kelak dikirim worker ke sistem pusat. Set 'off'
 * kalau endpoint pusat belum ada dan tidak ingin baris outbox menumpuk.
 */
const UNIT_ID = process.env.UNIT_ID || 'UNIT-LOCAL';
const UNIT_NAME = process.env.UNIT_NAME || 'Unit Lokal';
const WAREHOUSE_ID = process.env.WAREHOUSE_ID || `WH-${UNIT_ID}`;
const SYNC_OUTBOX_ENABLED = String(process.env.SYNC_OUTBOX_ENABLED || 'on').toLowerCase() === 'on';

module.exports = { UNIT_ID, UNIT_NAME, WAREHOUSE_ID, SYNC_OUTBOX_ENABLED };
