/**
 * Menulis entri ke web_print_log. Dipanggil dari dalam transaction yang
 * sama dengan aksi bisnisnya (buka kamar, tambah order, dst) supaya
 * konsisten - kalau transaksinya di-rollback, print job ini juga batal.
 */
async function queuePrint(conn, { transId, printType, printerTarget, destination, payload }) {
  await conn.query(
    `INSERT INTO web_print_log (trans_id, print_type, printer_target, destination, status, payload_snapshot)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [transId, printType, printerTarget, destination, JSON.stringify(payload)]
  );
}

module.exports = { queuePrint };
