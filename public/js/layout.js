// Sidebar + topbar bersama - dipanggil dari tiap halaman lewat renderLayout().
// Vanilla JS murni (tanpa build step), supaya semua halaman punya tampilan
// yang konsisten tanpa duplikasi HTML sidebar di tiap file.

const ICONS = {
  grid: '<path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  door: '<path d="M6 3h9v18H6z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12.5" cy="12" r="0.8" fill="currentColor"/>',
  receipt: '<path d="M6 2h12v20l-2-1.3L14 22l-2-1.3L10 22l-2-1.3L6 22V2z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9 7h6M9 11h6M9 15h4" stroke="currentColor" stroke-width="1.4"/>',
  box: '<path d="M3 7l9-4 9 4-9 4-9-4z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 7v10l9 4 9-4V7M12 11v10" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  chart: '<path d="M4 20V10M11 20V4M18 20v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  gear: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  bell: '<path d="M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M10 19a2 2 0 004 0" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M20 20l-4.3-4.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M16 17l5-5-5-5M21 12H9" stroke="currentColor" stroke-width="1.6" fill="none"/>',
  help: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M9.5 9a2.5 2.5 0 115 .3c0 1.7-2.5 1.7-2.5 3.4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><circle cx="12" cy="17" r="0.8" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  clock: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  users: '<circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 20c0-3.3 2.7-5 6-5s6 1.7 6 5" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="17" cy="9" r="2.3" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M15.5 20c.3-2.4 1.8-3.8 4-4.3" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  cash: '<rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  qr: '<rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="3" y="14" width="7" height="7" stroke="currentColor" stroke-width="1.4" fill="none"/><rect x="14" y="14" width="3" height="3" fill="currentColor"/><rect x="18" y="18" width="3" height="3" fill="currentColor"/>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M2.5 10h19" stroke="currentColor" stroke-width="1.5"/>',
  member: '<circle cx="12" cy="8" r="3.4" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M5 20c0-3.9 3.1-6 7-6s7 2.1 7 6" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  tag: '<path d="M3 12l9-9 8 8-9 9-8-8z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="8.5" cy="8.5" r="1.4" fill="currentColor"/>',
  pulse: '<path d="M3 12h4l2.5-7 4 14 2.5-7H21" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  sun: '<circle cx="12" cy="12" r="4.2" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  moon: '<path d="M20.5 14.3A8.2 8.2 0 019.7 3.5a8.2 8.2 0 1010.8 10.8z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
};

// ---- Tema gelap/terang -------------------------------------------------
// Tema awal sudah dipasang oleh js/theme-boot.js (di <head>). Fungsi di sini
// dipakai tombol toggle di sidebar untuk mengganti + menyimpan pilihan.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  const light = theme === 'light';
  if (light) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('grpos-theme', light ? 'light' : 'dark'); } catch (e) {}
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    // tombol menampilkan tujuan aksi: saat gelap -> ikon matahari (ke terang)
    btn.innerHTML = icon(light ? 'moon' : 'sun', 16);
    btn.title = light ? 'Mode gelap' : 'Mode terang';
  }
}
function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
}

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html', i: 'grid' },
  // "Rooms" dihapus (dulu cuma alias /dashboard.html). "Orders" disembunyikan
  // dari sidebar - selalu diakses lewat klik kamar di Dashboard - tapi
  // halamannya tetap boleh dibuka (hidden:true = tidak dirender, tetap lolos guard).
  { key: 'orders', label: 'Orders', href: '/orders.html', i: 'receipt', hidden: true },
  { key: 'fnb-hotel', label: 'F&B Hotel', href: '/fnb-hotel.html', i: 'receipt' },
  { key: 'products', label: 'Produk', href: '/products.html', i: 'tag' },
  { key: 'promo', label: 'Promo', href: '/promo.html', i: 'plus' },
  { key: 'inventory', label: 'Inventory', href: '/inventory.html', i: 'box' },
  // Pengeluaran: form sederhana di gr-pos (migration 013), menggantikan alur
  // "scan QR -> form n8n" yang tidak jalan. Halaman gate ke admin/supervisor.
  { key: 'pengeluaran', label: 'Pengeluaran', href: '/pengeluaran.html', i: 'cash' },
  { key: 'kasir', label: 'Tutup Kasir', href: '/tutup-kasir.html', i: 'cash' },
  { key: 'reports', label: 'Reports', href: '/reports.html', i: 'chart' },
  { key: 'laporan-void', label: 'Laporan Void', href: '/laporan-void.html', i: 'chart' },
  { key: 'analitik', label: 'Analitik', href: '/analitik.html', i: 'pulse' },
  { key: 'settings', label: 'Settings', href: '/settings.html', i: 'gear' },
];

// Pembatasan menu per-role. Role yang TIDAK terdaftar di sini melihat SEMUA
// menu (perilaku lama - mis. admin/head_karaoke/supervisor/dapur/waiter). Role
// yang terdaftar HANYA melihat key yang disebut di bawah, dan kalau membuka
// halaman lain lewat URL langsung / bookmark lama akan ditendang balik ke
// halaman pertama jatahnya (lihat guard di renderLayout).
//   gudang      -> cuma Inventory
//   kasir       -> Room Monitor + Orders/Checkout + F&B Hotel (tanpa Produk,
//                  Promo, Inventory, Pengeluaran, Reports, Analitik, Settings)
//   head_unit   -> semua menu KECUALI Analitik (juga tidak bisa set kamar
//                  Maintenance - lihat canManageRooms di dashboard.html &
//                  gate server di rooms.routes.js)
//   head_karaoke-> tidak didaftarkan di sini = semua menu terbuka (setara admin)
const ROLE_NAV = {
  gudang: ['inventory'],
  // 'orders' tetap di daftar BOLEH (dibuka lewat klik kamar) walau tidak
  // muncul di sidebar (hidden:true).
  kasir: ['dashboard', 'orders', 'fnb-hotel', 'kasir'],
  head_unit: ['dashboard', 'orders', 'fnb-hotel', 'products', 'promo', 'inventory',
    'pengeluaran', 'kasir', 'reports', 'laporan-void', 'settings'],
};

// Halaman awal (setelah login / setelah guard menendang) untuk role terbatas.
// Default = menu pertama di jatahnya.
const ROLE_HOME = {
  gudang: '/inventory.html',
  kasir: '/dashboard.html',
};

// Daftar key menu yang boleh diakses role ini; null = tanpa batas (semua menu).
function allowedNavKeys(role) {
  return ROLE_NAV[role] || null;
}

function initials(name) {
  return (name || '?').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

/**
 * Render sidebar + topbar. Panggil di awal <body> setiap halaman:
 *   <div id="shell"></div>
 *   <script>renderLayout({ active: 'dashboard', title: 'Dashboard', subtitle: '...', mount: '#shell' })</script>
 * Isi konten halaman ditaruh di dalam <div class="content" id="pageContent">...</div>
 * (dibuat manual di HTML, DI LUAR #shell, lalu dipindah oleh script ke dalam .main)
 */
function renderLayout({ active, title, subtitle, badgeHtml, onSearch }) {
  if (!getToken()) { window.location.href = '/index.html'; return; }
  const user = getUser() || {};

  // Role terbatas (mis. gudang): saring menu ke jatahnya, dan kalau halaman
  // yang dibuka di luar jatah (ketik URL langsung / bookmark lama) -> lempar
  // balik ke halaman pertama yang boleh. Guard ini jalan di SETIAP halaman
  // karena renderLayout dipanggil di semua halaman ber-shell.
  const allowed = allowedNavKeys(user.role);
  // Guard akses halaman: pakai daftar key yang BOLEH (termasuk yang hidden).
  const allowedKeys = allowed || NAV_ITEMS.map((it) => it.key);
  if (allowed && !allowedKeys.includes(active)) {
    window.location.replace(ROLE_HOME[user.role] || '/dashboard.html');
    return;
  }
  // Sidebar: hanya item yang boleh DAN tidak hidden.
  const visibleNav = NAV_ITEMS.filter((it) => !it.hidden && allowedKeys.includes(it.key));

  const navHtml = visibleNav.map((item) => `
    <a class="nav-item ${item.key === active ? 'active' : ''}" href="${item.href}">
      ${icon(item.i)}<span>${item.label}</span>
    </a>
  `).join('');

  const shell = document.getElementById('shell');
  shell.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="logo-dot">GR</div>
          <div>
            <div class="name">Grand Royal</div>
            <div class="sub">POS System</div>
          </div>
        </div>
        <nav class="nav-list">${navHtml}</nav>
        ${allowed ? '' : `<button class="btn-new-session" id="btnNewSessionNav">${icon('plus', 16)} New Session</button>`}
        <div class="sidebar-footer">
          <div class="avatar">${initials(user.full_name)}</div>
          <div class="who">
            <div class="name">${user.full_name || '-'}</div>
            <div class="role">${user.role || ''}</div>
          </div>
          <button title="Ganti tema" id="btnThemeToggle">${icon('sun', 16)}</button>
          <button title="Bantuan" onclick="alert('Hubungi admin/supervisor untuk bantuan teknis.')">${icon('help', 16)}</button>
          <button title="Keluar" id="btnLogoutNav">${icon('logout', 16)}</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="search">
            ${icon('search', 15)}
            <input id="globalSearch" placeholder="Search rooms, orders, or items..." />
          </div>
          <div class="titlewrap" style="flex:2;text-align:right">
            <h1>${title || ''}</h1>
            ${subtitle ? `<p>${subtitle}</p>` : ''}
          </div>
          ${badgeHtml || ''}
          <a id="shiftPill" href="/tutup-kasir.html" title="Tutup Kasir / Shift"
             style="display:none;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;
                    font-size:11.5px;font-weight:700;text-decoration:none;white-space:nowrap"></a>
          <button class="icon-btn" title="Notifikasi">${icon('bell', 16)}</button>
        </header>
        <main class="content" id="pageContentMount"></main>
      </div>
    </div>
  `;

  // pindahkan konten halaman (#pageContent, ditulis manual di body) ke dalam mount point
  const pageContent = document.getElementById('pageContent');
  if (pageContent) document.getElementById('pageContentMount').appendChild(pageContent);

  // sinkronkan ikon tombol tema dgn tema yang sudah aktif, lalu pasang toggle
  applyTheme(currentTheme());
  document.getElementById('btnThemeToggle').addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });

  // Logout = TUTUP KASIR. Kalau user punya shift terbuka -> popup tutup kasir
  // (isi kas fisik, lihat selisih) sebelum logout. Kalau tidak -> logout biasa.
  document.getElementById('btnLogoutNav').addEventListener('click', async () => {
    const plainLogout = () => { clearSession(); window.location.href = '/index.html'; };
    if (typeof Api === 'undefined' || !Api.currentShift || !['kasir', 'admin', 'head_karaoke', 'head_unit', 'supervisor'].includes(user.role)) {
      return plainLogout();
    }
    let cur = null;
    try { cur = await Api.currentShift(); } catch (e) { return plainLogout(); }
    if (!cur || !cur.shift) return plainLogout();
    openShiftCloseModal(cur.shift.id, cur.report, plainLogout);
  });
  const btnNewSession = document.getElementById('btnNewSessionNav');
  if (btnNewSession) btnNewSession.addEventListener('click', () => {
    window.location.href = '/orders.html';
  });

  // Kotak search di topbar: hanya aktif kalau halaman memberi callback onSearch
  // (mis. Orders & Room Detail memfilter daftar menu). Di halaman lain kotak
  // ini disembunyikan supaya tidak jadi kontrol mati.
  const searchBox = document.querySelector('.topbar .search');
  const searchInput = document.getElementById('globalSearch');
  if (typeof onSearch === 'function' && searchInput) {
    let t;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value.trim().toLowerCase();
      t = setTimeout(() => onSearch(v), 120);
    });
  } else if (searchBox) {
    searchBox.style.display = 'none';
  }

  // Pil status shift di topbar. Kasir: selalu tampil (hijau=buka / kuning=belum).
  // admin/head_karaoke/head_unit/supervisor: hanya tampil kalau kebetulan punya shift terbuka.
  if (['kasir', 'admin', 'head_karaoke', 'head_unit', 'supervisor'].includes(user.role) && typeof Api !== 'undefined' && Api.currentShift) {
    const pill = document.getElementById('shiftPill');
    Api.currentShift().then(({ shift }) => {
      if (!pill) return;
      if (shift) {
        pill.textContent = `🟢 Kasir buka ${(shift.opened_at || '').slice(11, 16)}`;
        pill.style.background = 'var(--green-dim)';
        pill.style.color = 'var(--green)';
        pill.style.display = 'inline-flex';
      } else if (user.role === 'kasir') {
        pill.textContent = '⚪ Kasir belum dibuka';
        pill.style.background = 'var(--yellow, #ffd166)';
        pill.style.color = '#3a2c00';
        pill.style.display = 'inline-flex';
      }
    }).catch(() => {});
  }
}

function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// Popup Tutup Kasir saat logout. `report` = hasil Api.currentShift().report.
// onLogout() = lakukan clearSession + redirect ke /index.html.
function openShiftCloseModal(shiftId, report, onLogout) {
  const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
  const c = (report && report.cash) || {};
  const t = (report && report.totals) || {};
  const methods = (report && report.by_method) || [];
  const wrap = document.createElement('div');
  wrap.className = 'modal-overlay';
  wrap.innerHTML = `
    <div class="modal-box" style="max-width:420px">
      <h3>Tutup Kasir</h3>
      <p class="muted">Shift ditutup lalu kamu logout. Cocokkan kas fisik di laci.</p>
      <table class="summary-table" style="margin:0 0 10px">
        <tbody>
          ${methods.map((m) => `<tr><td>${m.method} (${m.count})</td><td class="num">${rp(m.amount)}</td></tr>`).join('')}
          <tr><td><b>Total diterima</b></td><td class="num"><b>${rp(t.collected)}</b></td></tr>
          <tr><td>Modal Kasir</td><td class="num">${rp(c.opening_float)}</td></tr>
          <tr><td>Penjualan tunai</td><td class="num">${rp(c.cash_sales)}</td></tr>
          <tr><td><b>Kas seharusnya</b></td><td class="num"><b>${rp(c.expected_cash)}</b></td></tr>
        </tbody>
      </table>
      <label class="field-label">Kas fisik dihitung (Rp)</label>
      <input class="field" id="skCounted" type="number" min="0" value="${Number(c.expected_cash || 0)}" />
      <div class="totals-row" style="font-weight:700"><span>Selisih</span><span id="skVar">Rp0</span></div>
      <label class="field-label">Catatan (opsional)</label>
      <input class="field" id="skNote" placeholder="mis. selisih tukar uang kecil" />
      <div id="skErr" class="error-text" style="display:none;margin-top:6px"></div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">
        <button class="btn btn-primary" id="skClose" style="flex:1 1 100%">Tutup Kasir &amp; Logout</button>
        <button class="btn btn-outline" id="skSkip" style="flex:1">Logout (shift tetap buka)</button>
        <button class="btn btn-outline" id="skCancel" style="flex:1">Batal</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const expected = Number(c.expected_cash || 0);
  const countedEl = wrap.querySelector('#skCounted');
  const varEl = wrap.querySelector('#skVar');
  const errEl = wrap.querySelector('#skErr');
  function upd() {
    const d = (Number(countedEl.value) || 0) - expected;
    varEl.textContent = (d > 0 ? '+' : '') + rp(d);
    varEl.style.color = d === 0 ? 'var(--green)' : 'var(--red)';
  }
  countedEl.addEventListener('input', upd); upd();

  const close = () => wrap.remove();
  wrap.querySelector('#skCancel').addEventListener('click', close);
  wrap.querySelector('#skSkip').addEventListener('click', onLogout);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

  wrap.querySelector('#skClose').addEventListener('click', async () => {
    const btn = wrap.querySelector('#skClose');
    btn.disabled = true; errEl.style.display = 'none';
    try {
      const { report: final } = await Api.closeShift(shiftId, Number(countedEl.value) || 0, wrap.querySelector('#skNote').value.trim());
      // cetak setoran kalau printer tersedia di halaman ini
      if (typeof QzPrint !== 'undefined' && QzPrint.formatShiftClose && typeof ReceiptPrint !== 'undefined') {
        try {
          const u = getUser() || {};
          ReceiptPrint.printLines(
            QzPrint.formatShiftClose({ cashier_name: u.full_name || u.username, report: final }),
            { title: 'Tutup Kasir' }
          );
        } catch (e) { /* cetak gagal - laporan tetap tersimpan & masuk EOD */ }
      }
      const v = Number((final.cash || {}).variance || 0);
      alert('Kasir ditutup.\nKas seharusnya: ' + rp(final.cash.expected_cash) +
        '\nKas dihitung: ' + rp(final.cash.counted_cash) +
        '\nSelisih: ' + (v > 0 ? '+' : '') + rp(v) + (v === 0 ? ' (PAS)' : (v > 0 ? ' (LEBIH)' : ' (KURANG)')));
      onLogout();
    } catch (e) {
      errEl.textContent = e.message; errEl.style.display = 'block'; btn.disabled = false;
    }
  });
}

function formatDuration(startIso) {
  const ms = Date.now() - new Date(startIso).getTime();
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Hitung mundur ke waktu kedaluwarsa. Setelah lewat -> overtime (hitung maju,
// ditandai merah oleh pemanggil). Format HH:MM:SS seperti POS lama.
function formatCountdown(expiresIso) {
  const diffMs = new Date(expiresIso).getTime() - Date.now();
  const overtime = diffMs < 0;
  let s = Math.floor(Math.abs(diffMs) / 1000);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const t = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return { text: overtime ? `+${t}` : t, overtime };
}

function rupiah(n) {
  return 'Rp' + Number(n || 0).toLocaleString('id-ID');
}
