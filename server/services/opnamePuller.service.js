/**
 * Worker PENARIK approval Stock Opname: poll berkala ke webhook n8n
 * `05-opname-signer.json` (path `gr-pos/opname/pending`) minta blob
 * persetujuan holding yang sudah ditandatangani & menunggu unit ini, lalu
 * terapkan OTOMATIS lewat `opnameApproval.service.js` `applyApprovalBlob()`
 * - fungsi SAMA yang dipakai jalur impor manual
 * (`POST /api/inventory/opname/:id/import-approval`, tetap hidup sbg
 * fallback kalau worker ini mati / n8n tidak terjangkau).
 *
 * Arah kebalikan dari `outboxSender.service.js` (yang KIRIM baris keluar);
 * pola workernya sengaja dibuat identik: tick berkala, `sending` guard,
 * status ringkas utk panel dashboard, isConnError utk bedakan "endpoint tak
 * terjangkau" (stop batch, coba lagi tick berikutnya) vs "1 blob ditolak"
 * (lanjut ke blob lain, JANGAN sampai 1 blob rusak memblokir sisanya -
 * unit lain / opname lain tetap harus jalan).
 *
 * actorUserId dikirim NULL - semua kolom user_id terkait (web_stock_opname,
 * web_opname_approval_used, web_stock_movement) memang NULL-able (lihat
 * migration 004/014/019), jadi tidak perlu sentinel angka; NULL disini
 * berarti "diterapkan otomatis, bukan oleh user yang login".
 */
const { UNIT_ID } = require('../config/unit');
const OPNAME = require('../config/opname');
const opnameApproval = require('./opnameApproval.service');

const ENABLED = OPNAME.OPNAME_POLL_ENABLED;
const POLL_URL = OPNAME.OPNAME_POLL_URL;
const POLL_TOKEN = OPNAME.OPNAME_POLL_TOKEN;
const INTERVAL_MS = OPNAME.OPNAME_POLL_INTERVAL_MS;
const TIMEOUT_MS = 15000;

let polling = false;
let lastRun = null; // ringkasan tick terakhir, dibaca GET /api/sync/opname-pull/status

/** true kalau error = endpoint tidak terjangkau (bukan penolakan per-blob). */
function isConnError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
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

/** Ambil blob yang menunggu unit ini. Throw kalau non-2xx / gagal jaringan / timeout. */
async function fetchPending() {
  const url = `${POLL_URL}${POLL_URL.includes('?') ? '&' : '?'}unit_id=${encodeURIComponent(UNIT_ID)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: POLL_TOKEN ? { Authorization: `Bearer ${POLL_TOKEN}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const e = new Error(`HTTP ${res.status}${text ? ' ' + text.slice(0, 150) : ''}`);
      e.httpStatus = res.status;
      throw e;
    }
    const body = await res.json();
    return Array.isArray(body.blobs) ? body.blobs : [];
  } finally {
    clearTimeout(timer);
  }
}

/** 1 tick worker. Return ringkasan { at, fetched, applied, failed, connDown }. */
async function flushOnce() {
  if (polling || !ENABLED) return lastRun;
  if (!POLL_URL) {
    console.warn('[opnamePuller] OPNAME_POLL_ENABLED=on tapi OPNAME_POLL_URL kosong - dilewati.');
    return lastRun;
  }
  if (typeof fetch !== 'function') {
    console.error('[opnamePuller] global fetch tidak tersedia (butuh Node >= 18) - worker tidak jalan.');
    return lastRun;
  }

  polling = true;
  const run = { at: new Date().toISOString(), fetched: 0, applied: 0, failed: 0, connDown: false };
  try {
    let blobs;
    try {
      blobs = await fetchPending();
    } catch (err) {
      run.connDown = isConnError(err);
      run.error = err.message;
      console.error(`[opnamePuller] tidak bisa mengambil antrean: ${err.message}`);
      return run;
    }
    run.fetched = blobs.length;

    for (const blob of blobs) {
      const opnameId = blob && blob.signed ? (() => {
        try {
          return JSON.parse(blob.signed).opname_id;
        } catch {
          return null;
        }
      })() : null;
      try {
        if (!opnameId) throw new Error('Blob tidak punya opname_id yang bisa dibaca.');
        await opnameApproval.applyApprovalBlob({ opnameId, blob, actorUserId: null, terminalId: null });
        run.applied++;
      } catch (err) {
        run.failed++;
        console.error(`[opnamePuller] GAGAL terapkan blob (opname_id=${opnameId || '?'}): ${err.message}`);
      }
    }

    if (run.fetched) {
      console.log(`[opnamePuller] tick: diambil ${run.fetched}, diterapkan ${run.applied}, gagal ${run.failed}`);
    }
  } catch (err) {
    console.error('[opnamePuller] flushOnce error:', err.message);
    run.error = err.message;
  } finally {
    polling = false;
    lastRun = run;
  }
  return run;
}

/** Ringkasan poll utk panel dashboard / debugging. */
async function getStatus() {
  return {
    enabled: ENABLED,
    poll_url_set: Boolean(POLL_URL),
    unit_id: UNIT_ID,
    last_run: lastRun,
    config: { interval_ms: INTERVAL_MS, timeout_ms: TIMEOUT_MS },
  };
}

/** Pasang worker. `timers` = array setInterval handle utk shutdown rapi. */
function start(timers) {
  if (!ENABLED) {
    console.log('[opnamePuller] STANDBY (OPNAME_POLL_ENABLED != on) - approval holding hanya lewat impor manual.');
    return;
  }
  if (!POLL_URL) {
    console.warn('[opnamePuller] OPNAME_POLL_ENABLED=on TAPI OPNAME_POLL_URL kosong - worker tidak dijadwalkan.');
    return;
  }
  console.log(`[opnamePuller] ENABLED -> ${POLL_URL} (tiap ${Math.round(INTERVAL_MS / 1000)}s, unit ${UNIT_ID})`);
  setTimeout(flushOnce, 20000);
  timers.push(setInterval(flushOnce, INTERVAL_MS));
}

module.exports = { start, flushOnce, getStatus };
