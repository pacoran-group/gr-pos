/**
 * Verifikasi blob persetujuan Stock Opname dari holding. Lihat migration 019
 * & server/config/opname.js & public/opname-signer.html.
 *
 * Bentuk blob (dibuat halaman signer holding, offline):
 *   {
 *     "alg": "ES256",
 *     "signed": "<STRING JSON PERSIS yang ditandatangani>",
 *     "sig": "<base64 / base64url ECDSA P-256 (P1363 r||s) atas bytes 'signed'>"
 *   }
 * `signed` di-parse jadi payload:
 *   { v, opname_id, unit_id, decision: 'approved'|'rejected',
 *     reviewed_by, reviewed_at, nonce, note?, items: [{product_id, approved_qty}] }
 *
 * Verifikasi bytes 'signed' apa adanya (bukan re-serialize) -> tidak ada
 * masalah kanonikalisasi JSON.
 */
const crypto = require('crypto');
const { withTransaction } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { UNIT_ID } = require('../config/unit');
const { OPNAME_APPLY_PUBKEYS } = require('../config/opname');
const stock = require('./stock.service');

function toPublicKey(k) {
  const s = String(k).trim();
  if (s.includes('BEGIN')) return crypto.createPublicKey(s); // PEM
  return crypto.createPublicKey({ key: Buffer.from(s, 'base64'), format: 'der', type: 'spki' });
}

function b64ToBuf(s) {
  // terima base64 atau base64url
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** @returns {object} payload yang sudah terverifikasi tanda tangannya */
function verifyApprovalBlob(blob) {
  if (!OPNAME_APPLY_PUBKEYS.length) {
    throw new AppError(500, 'OPNAME_APPLY_PUBKEY belum diset di .env - tidak bisa memverifikasi persetujuan holding.');
  }
  let obj;
  try {
    obj = typeof blob === 'string' ? JSON.parse(blob) : blob;
  } catch (e) {
    throw new AppError(400, 'Blob persetujuan bukan JSON yang valid.');
  }
  if (!obj || typeof obj.signed !== 'string' || typeof obj.sig !== 'string') {
    throw new AppError(400, 'Format blob salah (butuh field "signed" & "sig").');
  }
  const data = Buffer.from(obj.signed, 'utf8');
  const sig = b64ToBuf(obj.sig);

  let ok = false;
  for (const k of OPNAME_APPLY_PUBKEYS) {
    try {
      const keyObj = toPublicKey(k);
      if (crypto.verify('sha256', data, { key: keyObj, dsaEncoding: 'ieee-p1363' }, sig)) {
        ok = true;
        break;
      }
    } catch (e) {
      /* coba public key berikutnya */
    }
  }
  if (!ok) throw new AppError(401, 'Tanda tangan holding TIDAK valid.');

  let payload;
  try {
    payload = JSON.parse(obj.signed);
  } catch (e) {
    throw new AppError(400, 'Isi "signed" bukan JSON.');
  }
  if (!payload || !payload.opname_id || !payload.unit_id || !payload.nonce) {
    throw new AppError(400, 'Payload approval kurang lengkap (opname_id / unit_id / nonce).');
  }
  if (!['approved', 'rejected'].includes(payload.decision)) {
    throw new AppError(400, 'decision harus "approved" atau "rejected".');
  }
  if (payload.decision === 'approved' && !Array.isArray(payload.items)) {
    throw new AppError(400, 'items[] wajib ada untuk decision "approved".');
  }
  return payload;
}

/**
 * Verifikasi + terapkan 1 blob persetujuan holding untuk opname `opnameId`.
 * Dipakai dari 2 tempat:
 *   - route POST /opname/:id/import-approval (impor manual, actorUserId =
 *     req.user.user_id, dari upload file lama)
 *   - opnamePuller.service.js (impor OTOMATIS hasil poll ke n8n, actorUserId
 *     = null - semua kolom user_id terkait memang NULL-able, berarti
 *     "diterapkan otomatis, bukan oleh user yang login")
 *
 * Lempar AppError kalau blob tidak valid / opname_id-unit_id tidak cocok /
 * sesi bukan 'pending' / nonce sudah dipakai - pemanggil (route atau poller)
 * yang menentukan bagaimana errornya ditangani (respons HTTP vs log + lanjut
 * ke blob berikutnya).
 */
async function applyApprovalBlob({ opnameId, blob, actorUserId, terminalId = null }) {
  const payload = verifyApprovalBlob(blob);
  if (String(payload.opname_id) !== String(opnameId)) {
    throw new AppError(400, `Blob ini untuk opname ${payload.opname_id}, bukan ${opnameId}.`);
  }
  if (String(payload.unit_id) !== String(UNIT_ID)) {
    throw new AppError(403, `Blob ini untuk unit "${payload.unit_id}", bukan unit ini ("${UNIT_ID}").`);
  }
  const reviewedAt = (() => {
    const d = new Date(payload.reviewed_at);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  })().toISOString().slice(0, 19).replace('T', ' ');
  const rawBlob = typeof blob === 'string' ? blob : JSON.stringify(blob);

  const result = await withTransaction(async (conn) => {
    const [[header]] = await conn.query('SELECT status FROM web_stock_opname WHERE opname_id = ? FOR UPDATE', [
      opnameId,
    ]);
    if (!header) throw new AppError(404, 'Sesi opname tidak ditemukan.');
    if (header.status !== 'pending') throw new AppError(409, `Sesi ini sudah berstatus '${header.status}'.`);

    // anti-replay
    const [[used]] = await conn.query('SELECT nonce FROM web_opname_approval_used WHERE nonce = ?', [payload.nonce]);
    if (used) throw new AppError(409, 'File persetujuan ini SUDAH pernah dipakai (nonce terpakai).');
    await conn.query('INSERT INTO web_opname_approval_used (nonce, opname_id, used_by_user_id) VALUES (?, ?, ?)', [
      payload.nonce,
      opnameId,
      actorUserId,
    ]);

    if (payload.decision === 'rejected') {
      await conn.query(
        `UPDATE web_stock_opname
           SET status = 'rejected', approved_by_holding = ?, approval_nonce = ?, approval_at = ?,
               approval_blob = ?, reject_note = ?, applied_at = CURRENT_TIMESTAMP
         WHERE opname_id = ?`,
        [payload.reviewed_by || null, payload.nonce, reviewedAt, rawBlob, (payload.note || '').slice(0, 500) || null, opnameId]
      );
      return { status: 'rejected', items: [] };
    }

    // approved: petakan qty disetujui holding
    const byPid = new Map();
    for (const it of payload.items) {
      const q = Number(it.approved_qty);
      if (!Number.isInteger(q) || q < 0) {
        throw new AppError(400, `approved_qty produk ${it.product_id} tidak valid (${it.approved_qty}).`);
      }
      byPid.set(String(it.product_id), q);
    }
    const [items] = await conn.query('SELECT product_id, note FROM web_stock_opname_item WHERE opname_id = ?', [
      opnameId,
    ]);
    for (const it of items) {
      if (!byPid.has(String(it.product_id))) {
        throw new AppError(400, `Holding belum menyetujui qty untuk produk ${it.product_id} - blob tidak mencakup semua item sesi ini.`);
      }
    }

    const out = [];
    for (const it of items) {
      const approvedQty = byPid.get(String(it.product_id));
      const r = await stock.applyOpnameItem(conn, {
        productId: it.product_id,
        qtyPhysical: approvedQty,
        opnameId,
        note: it.note,
        userId: actorUserId,
        terminalId,
      });
      await conn.query('UPDATE web_stock_opname_item SET applied_delta = ?, approved_qty = ? WHERE opname_id = ? AND product_id = ?', [
        r.delta,
        approvedQty,
        opnameId,
        it.product_id,
      ]);
      out.push({ product_id: it.product_id, approved_qty: approvedQty, delta: r.delta, qty_after: r.qty_after });
    }
    await conn.query(
      `UPDATE web_stock_opname
         SET status = 'applied', applied_by_user_id = ?, approved_by_holding = ?, approval_nonce = ?,
             approval_at = ?, approval_blob = ?, applied_at = CURRENT_TIMESTAMP
       WHERE opname_id = ?`,
      [actorUserId, payload.reviewed_by || null, payload.nonce, reviewedAt, rawBlob, opnameId]
    );
    return { status: 'applied', items: out };
  });

  return { opname_id: opnameId, decision: payload.decision, approved_by_holding: payload.reviewed_by || null, ...result };
}

module.exports = { verifyApprovalBlob, applyApprovalBlob };
