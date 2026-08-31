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
};
function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24">${ICONS[name] || ''}</svg>`;
}

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', href: '/dashboard.html', i: 'grid' },
  { key: 'rooms', label: 'Rooms', href: '/dashboard.html', i: 'door' },
  { key: 'orders', label: 'Orders', href: '/orders.html', i: 'receipt' },
  { key: 'fnb-hotel', label: 'F&B Hotel', href: '/fnb-hotel.html', i: 'receipt' },
  { key: 'products', label: 'Produk', href: '/products.html', i: 'tag' },
  { key: 'promo', label: 'Promo', href: '/promo.html', i: 'plus' },
  { key: 'inventory', label: 'Inventory', href: '/inventory.html', i: 'box' },
  { key: 'reports', label: 'Reports', href: '/reports.html', i: 'chart' },
  { key: 'settings', label: 'Settings', href: '/settings.html', i: 'gear' },
];

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

  const navHtml = NAV_ITEMS.map((item) => `
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
        <button class="btn-new-session" id="btnNewSessionNav">${icon('plus', 16)} New Session</button>
        <div class="sidebar-footer">
          <div class="avatar">${initials(user.full_name)}</div>
          <div class="who">
            <div class="name">${user.full_name || '-'}</div>
            <div class="role">${user.role || ''}</div>
          </div>
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
          <button class="icon-btn" title="Notifikasi">${icon('bell', 16)}</button>
        </header>
        <main class="content" id="pageContentMount"></main>
      </div>
    </div>
  `;

  // pindahkan konten halaman (#pageContent, ditulis manual di body) ke dalam mount point
  const pageContent = document.getElementById('pageContent');
  if (pageContent) document.getElementById('pageContentMount').appendChild(pageContent);

  document.getElementById('btnLogoutNav').addEventListener('click', () => {
    clearSession();
    window.location.href = '/index.html';
  });
  document.getElementById('btnNewSessionNav').addEventListener('click', () => {
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
}

function showToast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
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
