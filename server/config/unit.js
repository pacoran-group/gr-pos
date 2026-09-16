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
 *
 * SYNC_SENDER_* : konfigurasi worker PENGIRIM outbox ke pusat
 * (services/outboxSender.service.js). Terpisah dari SYNC_OUTBOX_ENABLED yang
 * hanya mengatur PENULISAN baris. Default off: baris boleh menumpuk dulu,
 * dikuras begitu SYNC_INGEST_URL menunjuk webhook n8n yang hidup.
 */
const UNIT_ID = process.env.UNIT_ID || 'UNIT-LOCAL';
const UNIT_NAME = process.env.UNIT_NAME || 'Unit Lokal';
const WAREHOUSE_ID = process.env.WAREHOUSE_ID || `WH-${UNIT_ID}`;
const SYNC_OUTBOX_ENABLED = String(process.env.SYNC_OUTBOX_ENABLED || 'on').toLowerCase() === 'on';

const SYNC_SENDER_ENABLED = String(process.env.SYNC_SENDER_ENABLED || 'off').toLowerCase() === 'on';
const SYNC_INGEST_URL = process.env.SYNC_INGEST_URL || '';
const SYNC_INGEST_TOKEN = process.env.SYNC_INGEST_TOKEN || '';
const SYNC_SENDER_INTERVAL_MS = Number(process.env.SYNC_SENDER_INTERVAL_MS) || 60000;
const SYNC_SENDER_BATCH = Number(process.env.SYNC_SENDER_BATCH) || 100;
const SYNC_SENDER_MAX_ATTEMPTS = Number(process.env.SYNC_SENDER_MAX_ATTEMPTS) || 20;
const SYNC_SENDER_TIMEOUT_MS = Number(process.env.SYNC_SENDER_TIMEOUT_MS) || 15000;

module.exports = {
  UNIT_ID,
  UNIT_NAME,
  WAREHOUSE_ID,
  SYNC_OUTBOX_ENABLED,
  SYNC_SENDER_ENABLED,
  SYNC_INGEST_URL,
  SYNC_INGEST_TOKEN,
  SYNC_SENDER_INTERVAL_MS,
  SYNC_SENDER_BATCH,
  SYNC_SENDER_MAX_ATTEMPTS,
  SYNC_SENDER_TIMEOUT_MS,
};
