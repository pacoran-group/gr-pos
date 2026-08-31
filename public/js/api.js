// Wrapper fetch API kecil: otomatis menyisipkan JWT & terminal_id, dan
// menerjemahkan error 409 ROOM_LOCKED jadi pesan yang jelas ke kasir.

const API_BASE = ''; // sama origin dengan halaman ini (server Express menyajikan frontend + API)

function getToken() {
  return localStorage.getItem('gr_pos_token');
}
function getTerminalId() {
  // Nama terminal dihapus dari layar login (29 Agu 2026 - tidak dibutuhkan).
  // Tetap kirim nilai konstan supaya kolom audit created_at_terminal terisi.
  return 'WEB';
}
function getUser() {
  const raw = localStorage.getItem('gr_pos_user');
  return raw ? JSON.parse(raw) : null;
}
function setSession(token, user) {
  localStorage.setItem('gr_pos_token', token);
  localStorage.setItem('gr_pos_user', JSON.stringify(user));
}
function clearSession() {
  localStorage.removeItem('gr_pos_token');
  localStorage.removeItem('gr_pos_user');
}
function setTerminalId(id) {
  localStorage.setItem('gr_pos_terminal_id', id);
}

// Idempotency key generator - lihat komentar di Api.bukaKamar di bawah.
// crypto.randomUUID() tersedia di semua browser modern (Chrome/Edge yang
// dipakai kasir); fallback sederhana disediakan untuk jaga-jaga saja.
function newRequestKey() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
  return 'rk-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

async function apiFetch(path, options = {}) {
  const headers = Object.assign(
    { 'Content-Type': 'application/json', 'X-Terminal-Id': getTerminalId() },
    options.headers || {}
  );
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  const res = await fetch(API_BASE + path, { ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* respons tanpa body (jarang) */
  }

  if (res.status === 401) {
    clearSession();
    window.location.href = '/index.html?expired=1';
    throw new Error('Sesi berakhir, silakan login ulang.');
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request gagal (${res.status})`);
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
}

const Api = {
  login: (username, password) =>
    apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, terminal_id: getTerminalId() }),
    }),
  getRooms: () => apiFetch('/api/rooms'),
  softLock: (roomId) => apiFetch(`/api/rooms/${roomId}/soft-lock`, { method: 'POST' }),
  releaseSoftLock: (roomId) => apiFetch(`/api/rooms/${roomId}/soft-lock`, { method: 'DELETE' }),
  setMaintenance: (roomId, reason) =>
    apiFetch(`/api/rooms/${roomId}/maintenance`, { method: 'POST', body: JSON.stringify({ reason }) }),
  clearMaintenance: (roomId) => apiFetch(`/api/rooms/${roomId}/maintenance`, { method: 'DELETE' }),
  // Nyalakan/matikan aplikasi pemutar lagu di dalam room (via m_room.is_active
  // di server lama). state: 'on' | 'off'. Khusus admin/supervisor.
  setRoomPlayer: (roomId, state) =>
    apiFetch(`/api/rooms/${roomId}/player`, { method: 'POST', body: JSON.stringify({ state }) }),

  // requestKey (idempotency key): sekali-pakai per PERCOBAAN aksi, dibuat di
  // pemanggil (orders.html/checkout.html) lewat newRequestKey() dan HARUS
  // dipakai ulang kalau meng-retry percobaan yang sama (mis. setelah error
  // jaringan) - baru dibuat baru kalau memang aksi baru. Ini mencegah kelas
  // bug "order duplikat" yang ditemukan di sistem lama (kirim ulang akibat
  // timeout, tanpa deteksi sudah pernah diterima) - lihat project doc
  // diagnosis-sync-issue.md.
  bukaKamar: (payload, requestKey) =>
    apiFetch('/api/trans/buka-kamar', { method: 'POST', body: JSON.stringify({ ...payload, request_key: requestKey }) }),
  getTrans: (transId) => apiFetch(`/api/trans/${transId}`),
  tambahOrder: (transId, items, requestKey) =>
    apiFetch(`/api/trans/${transId}/tambah-order`, { method: 'POST', body: JSON.stringify({ items, request_key: requestKey }) }),
  // Void 1 item (butuh otorisasi supervisor/admin di body). body: { detail_id, void_qty, reason, approver_username, approver_password }
  voidItem: (transId, body, requestKey) =>
    apiFetch(`/api/trans/${transId}/void-item`, { method: 'POST', body: JSON.stringify({ ...body, request_key: requestKey }) }),
  // Tukar item: void sebagian 1 item + tambah item pengganti, 1x otorisasi.
  // body: { detail_id, void_qty, reason, add_items:[{product_id,qty}], approver_username, approver_password }
  exchangeItem: (transId, body, requestKey) =>
    apiFetch(`/api/trans/${transId}/exchange`, { method: 'POST', body: JSON.stringify({ ...body, request_key: requestKey }) }),
  tambahJam: (transId) => apiFetch(`/api/trans/${transId}/tambah-jam`, { method: 'POST' }),
  tutupKamar: (transId, paymentMethod, requestKey) =>
    apiFetch(`/api/trans/${transId}/tutup-kamar`, {
      method: 'POST',
      body: JSON.stringify({ payment_method: paymentMethod, request_key: requestKey }),
    }),
  batalTrans: (transId) => apiFetch(`/api/trans/${transId}/batal`, { method: 'POST' }),

  getProducts: () => apiFetch('/api/catalog/products'),
  getMembers: () => apiFetch('/api/catalog/members'),
  getCategories: () => apiFetch('/api/catalog/categories'),

  // --- Manajemen Produk (admin/supervisor) - CRUD m_product ---
  listManagedProducts: (params = {}) => {
    const q = new URLSearchParams();
    if (params.q) q.set('q', params.q);
    if (params.category) q.set('category', params.category);
    if (params.status && params.status !== 'all') q.set('status', params.status);
    const s = q.toString();
    return apiFetch('/api/products' + (s ? '?' + s : ''));
  },
  createProduct: (body) => apiFetch('/api/products', { method: 'POST', body: JSON.stringify(body) }),
  updateProduct: (id, body) =>
    apiFetch(`/api/products/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),

  // --- Promo (admin/supervisor) - B1G1 & paket harga tetap, auto-apply ---
  listPromos: () => apiFetch('/api/promos'),
  createPromo: (body) => apiFetch('/api/promos', { method: 'POST', body: JSON.stringify(body) }),
  updatePromo: (id, body) =>
    apiFetch(`/api/promos/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) }),
  deletePromo: (id) => apiFetch(`/api/promos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Inventory / stok (modul FASE 1). Mutasi: admin/supervisor/gudang. ---
  listInventory: (params = {}) => {
    const q = new URLSearchParams();
    if (params.q) q.set('q', params.q);
    if (params.low) q.set('low', '1');
    const s = q.toString();
    return apiFetch('/api/inventory' + (s ? '?' + s : ''));
  },
  getStockMovements: (productId) => apiFetch(`/api/inventory/${encodeURIComponent(productId)}/movements`),
  restock: (productId, body) =>
    apiFetch(`/api/inventory/${encodeURIComponent(productId)}/restock`, { method: 'POST', body: JSON.stringify(body) }),
  adjustStock: (productId, body) =>
    apiFetch(`/api/inventory/${encodeURIComponent(productId)}/adjust`, { method: 'POST', body: JSON.stringify(body) }),

  // Sinkron master-data (m_product/m_room/dst) dari server lama 154 -> Server02.
  syncMasterData: () => apiFetch('/api/sync/master', { method: 'POST' }),
  getLastMasterSync: () => apiFetch('/api/sync/master/last'),
  // Status room menurut cache 154 + room "orphan" (aktif di 154 tapi gr-pos
  // tak punya transaksinya - biasanya ditangani aplikasi lama / Plan B).
  getLegacyRooms: () => apiFetch('/api/sync/legacy-rooms'),

  // --- Laporan Tutup Hari / End-of-Day (admin/supervisor) ---
  getDailyReport: (date) => apiFetch('/api/reports/daily' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  closeDaily: (date, send) =>
    apiFetch('/api/reports/daily/close', { method: 'POST', body: JSON.stringify({ date, send: !!send }) }),
  getDailyHistory: (limit = 30) => apiFetch(`/api/reports/daily/history?limit=${limit}`),
  getStoredDailyClose: (businessDate) => apiFetch(`/api/reports/daily/${businessDate}`),
  resendDailyClose: (businessDate) =>
    apiFetch(`/api/reports/daily/${businessDate}/resend`, { method: 'POST' }),
  // Unduh CSV lewat fetch manual (apiFetch selalu parse JSON) + trigger <a download>.
  downloadDailyCsv: async (date, stored = false) => {
    const path = stored
      ? `/api/reports/daily/${date}?format=csv`
      : `/api/reports/daily?format=csv&date=${encodeURIComponent(date)}`;
    const res = await fetch(API_BASE + path, {
      headers: { Authorization: 'Bearer ' + getToken(), 'X-Terminal-Id': getTerminalId() },
    });
    if (!res.ok) throw new Error('Gagal unduh CSV (' + res.status + ').');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `tutup-hari_${date}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  // --- Modul F&B Hotel ---
  createHotelOrder: (body) =>
    apiFetch('/api/hotel-fnb/orders', { method: 'POST', body: JSON.stringify(body) }),
  listHotelOrders: (date) =>
    apiFetch('/api/hotel-fnb/orders' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  cancelHotelOrder: (id, reason) =>
    apiFetch(`/api/hotel-fnb/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getHotelFnbReport: (date) =>
    apiFetch('/api/hotel-fnb/daily' + (date ? `?date=${encodeURIComponent(date)}` : '')),
  closeHotelFnb: (date, send) =>
    apiFetch('/api/hotel-fnb/daily/close', { method: 'POST', body: JSON.stringify({ date, send: !!send }) }),
  getHotelFnbHistory: (limit = 30) => apiFetch(`/api/hotel-fnb/daily/history?limit=${limit}`),
  getStoredHotelFnb: (bd) => apiFetch(`/api/hotel-fnb/daily/${bd}`),
  resendHotelFnb: (bd) => apiFetch(`/api/hotel-fnb/daily/${bd}/resend`, { method: 'POST' }),
  downloadHotelFnbCsv: async (date, stored = false) => {
    const path = stored
      ? `/api/hotel-fnb/daily/${date}?format=csv`
      : `/api/hotel-fnb/daily?format=csv&date=${encodeURIComponent(date)}`;
    const res = await fetch(API_BASE + path, {
      headers: { Authorization: 'Bearer ' + getToken(), 'X-Terminal-Id': getTerminalId() },
    });
    if (!res.ok) throw new Error('Gagal unduh CSV (' + res.status + ').');
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: `fnb-hotel_${date}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },

  getDapurQueue: () => apiFetch('/api/print-queue/dapur'),
  ackPrint: (id) => apiFetch(`/api/print-queue/${id}/ack`, { method: 'POST' }),
  markSiap: (id) => apiFetch(`/api/print-queue/${id}/siap`, { method: 'POST' }),
  getPesananSiapNotif: () => apiFetch('/api/print-queue/notify/pesanan-siap'),
  ackPesananSiap: (id) => apiFetch(`/api/print-queue/notify/pesanan-siap/${id}/ack`, { method: 'POST' }),
};
