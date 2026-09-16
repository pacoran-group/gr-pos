/**
 * Worker PENGIRIM transactional outbox: baris `web_sync_outbox` -> endpoint
 * ingest pusat (n8n workflow `01-ingest-outbox.json`, path `gr-pos/outbox`).
 *
 * Pembagian tugas dengan `SYNC_OUTBOX_ENABLED` (config/unit.js):
 *   - SYNC_OUTBOX_ENABLED  -> apakah service bisnis (stock / dailyClose /
 *     hotelFnb) MENULIS baris ke web_sync_outbox. Sudah ada sejak migration 004.
 *   - SYNC_SENDER_ENABLED  -> apakah worker INI mengirim baris itu ke pusat.
 *     Terpisah supaya baris boleh menumpuk dulu (endpoint belum ada) lalu
 *     dikuras belakangan tanpa kehilangan apa pun.
 *
 * Pola (sama seperti roomPlayer.flushOutbox):
 *   - tiap tick: ambil <= SYNC_SENDER_BATCH baris `sent_at IS NULL` yang
 *     belum melewati batas attempts, kirim satu-per-satu (webhook n8n proses
 *     1 event per panggilan), ORDER BY created_at supaya urutan kejadian
 *     kira-kira terjaga.
 *   - sukses (HTTP 2xx) -> stamp `sent_at`, kosongkan `last_error`.
 *   - gagal -> `attempts++`, simpan `last_error` (255 char). Kalau error-nya
 *     "endpoint tak terjangkau" (DNS / connect / timeout) -> hentikan sisa
 *     batch tick ini (percuma, penyebabnya sama) dan lanjut tick berikutnya.
 *     Kalau endpoint hidup tapi menolak SATU baris -> lanjut ke baris lain.
 *   - attempts >= SYNC_SENDER_MAX_ATTEMPTS -> baris "beku": tidak diambil
 *     lagi oleh query normal (biar tidak menahan antrean), dicatat error
 *     keras. Reset `attempts = 0` lewat SQL/endpoint untuk mencoba lagi.
 *
 * Idempotensi ada di sisi pusat (workflow 01: `ON CONFLICT (event_uid)
 * DO NOTHING` untuk stock_movement, upsert per (unit, business_date) untuk
 * daily_close), jadi kirim-ulang setelah crash sebelum stamp `sent_at` aman.
 *
 * Aggregate yang belum dikenal pusat (mis. 'hotel_fnb_close', 'trans_closed')
 * tetap dikirim: workflow 01 membalas 200 tanpa menulis apa-apa, jadi baris
 * ikut ter-stamp `sent_at`. Kalau nanti pusat menambah handler-nya, itu
 * urusan backfill terpisah.
 */
const { pool } = require('../config/db');
const U = require('../config/unit');

const ENABLED = U.SYNC_SENDER_ENABLED;
const INGEST_URL = U.SYNC_INGEST_URL;
const INGEST_TOKEN = U.SYNC_INGEST_TOKEN;
const BATCH = U.SYNC_SENDER_BATCH;
const MAX_ATTEMPTS = U.SYNC_SENDER_MAX_ATTEMPTS;
const TIMEOUT_MS = U.SYNC_SENDER_TIMEOUT_MS;
const INTERVAL_MS = U.SYNC_SENDER_INTERVAL_MS;

let sending = false;
let lastRun = null; // ringkasan tick terakhir, dibaca GET /api/sync/outbox/status

/** true kalau error = endpoint tidak terjangkau (bukan penolakan per-baris). */
function isConnError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true; // timeout kita sendiri
  const code = err.code || (err.cause && err.cause.code);
  if (
    ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(
      code
    )
  ) {
    return true;
  }
  return /fetch failed|network|socket hang up|other side closed/i.test(err.message || '');
}

/** Kirim 1 baris outbox. Throw kalau non-2xx / gagal jaringan / timeout. */
async function postOne(row) {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INGEST_TOKEN ? { Authorization: `Bearer ${INGEST_TOKEN}` } : {}),
      },
      // Bentuk body = kolom web_sync_outbox apa adanya. Workflow 01 baca
      // body.aggregate / body.unit_id / body.payload.
      body: JSON.stringify({
        event_uid: row.event_uid,
        aggregate: row.aggregate,
        aggregate_id: row.aggregate_id,
        unit_id: row.unit_id,
        payload,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status}${text ? ' ' + text.slice(0, 150) : ''}`);
      e.httpStatus = res.status;
      throw e;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 1 tick worker. Return ringkasan { at, checked, sent, failed, connDown }. */
async function flushOnce() {
  if (sending || !ENABLED) return lastRun;
  if (!INGEST_URL) {
    console.warn('[outboxSender] SYNC_SENDER_ENABLED=on tapi SYNC_INGEST_URL kosong - dilewati.');
    return lastRun;
  }
  if (typeof fetch !== 'function') {
    console.error('[outboxSender] global fetch tidak tersedia (butuh Node >= 18) - worker tidak jalan.');
    return lastRun;
  }

  sending = true;
  const run = { at: new Date().toISOString(), checked: 0, sent: 0, failed: 0, connDown: false };
  try {
    const [rows] = await pool.query(
      `SELECT event_uid, aggregate, aggregate_id, unit_id, payload, attempts
         FROM web_sync_outbox
        WHERE sent_at IS NULL AND attempts < ?
        ORDER BY created_at
        LIMIT ?`,
      [MAX_ATTEMPTS, BATCH]
    );
    run.checked = rows.length;

    for (const row of rows) {
      try {
        await postOne(row);
        await pool.query('UPDATE web_sync_outbox SET sent_at = NOW(), last_error = NULL WHERE event_uid = ?', [
          row.event_uid,
        ]);
        run.sent++;
      } catch (err) {
        run.failed++;
        const attempts = row.attempts + 1;
        await pool.query('UPDATE web_sync_outbox SET attempts = ?, last_error = ? WHERE event_uid = ?', [
          attempts,
          String(err.message || err).slice(0, 255),
          row.event_uid,
        ]);
        if (attempts >= MAX_ATTEMPTS) {
          console.error(
            `[outboxSender] GAGAL PERMANEN event ${row.event_uid} (aggregate=${row.aggregate}, attempts=${attempts}): ${err.message} - baris dibekukan, cek manual lalu set attempts=0 untuk coba lagi.`
          );
        }
        if (isConnError(err)) {
          run.connDown = true;
          break; // endpoint bermasalah menyeluruh - stop, tick berikutnya lanjut
        }
      }
    }

    if (run.sent || run.failed) {
      console.log(
        `[outboxSender] tick: terkirim ${run.sent}, gagal ${run.failed}` +
          (run.connDown ? ' (endpoint tidak terjangkau - berhenti sampai tick berikutnya)' : '')
      );
    }
  } catch (err) {
    console.error('[outboxSender] flushOnce error:', err.message);
    run.error = err.message;
  } finally {
    sending = false;
    lastRun = run;
  }
  return run;
}

/** Ringkasan antrean outbox untuk panel dashboard / debugging. */
async function getStatus() {
  const [[c]] = await pool.query(
    `SELECT
       SUM(sent_at IS NULL AND attempts < ?)  AS pending,
       SUM(sent_at IS NULL AND attempts >= ?) AS stuck,
       SUM(sent_at IS NOT NULL AND sent_at >= NOW() - INTERVAL 1 DAY) AS sent_24h,
       MIN(CASE WHEN sent_at IS NULL THEN created_at END) AS oldest_pending_at
     FROM web_sync_outbox`,
    [MAX_ATTEMPTS, MAX_ATTEMPTS]
  );
  return {
    enabled: ENABLED,
    ingest_url_set: Boolean(INGEST_URL),
    pending: Number(c.pending || 0),
    stuck: Number(c.stuck || 0),
    sent_24h: Number(c.sent_24h || 0),
    oldest_pending_at: c.oldest_pending_at || null,
    last_run: lastRun,
    config: { batch: BATCH, interval_ms: INTERVAL_MS, max_attempts: MAX_ATTEMPTS, timeout_ms: TIMEOUT_MS },
  };
}

/** Pasang worker. `timers` = array setInterval handle utk shutdown rapi. */
function start(timers) {
  if (!ENABLED) {
    console.log('[outboxSender] STANDBY (SYNC_SENDER_ENABLED != on) - baris web_sync_outbox menumpuk sampai worker dinyalakan.');
    return;
  }
  if (!INGEST_URL) {
    console.warn('[outboxSender] SYNC_SENDER_ENABLED=on TAPI SYNC_INGEST_URL kosong - worker tidak dijadwalkan.');
    return;
  }
  console.log(
    `[outboxSender] ENABLED -> ${INGEST_URL} (tiap ${Math.round(INTERVAL_MS / 1000)}s, batch ${BATCH}, timeout ${Math.round(
      TIMEOUT_MS / 1000
    )}s, beku setelah ${MAX_ATTEMPTS}x gagal)`
  );
  setTimeout(flushOnce, 15000);
  timers.push(setInterval(flushOnce, INTERVAL_MS));
}

module.exports = { start, flushOnce, getStatus };
