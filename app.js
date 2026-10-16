const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TABS = ['items', 'history', 'categories', 'margin'];
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayKeys = () => {
  const d = new Date();
  return { day: localDay(d), month: localDay(d).slice(0, 7), year: String(d.getFullYear()) };
};

const state = {
  user: null,
  tab: 'items',
  categories: [],
  items: [],
  item: null,
  stockItem: null,
  costSize: null,
  proof: null,
  hist: new Map(), // id -> baris riwayat terakhir yang ditampilkan
  mtype: 'day',
  mdate: todayKeys(),
  mdata: null,
  mrows: [],
  sale: null,
  marginReq: 0,
};
const TYPE_LABEL = { initial: 'Stok awal', in: 'Masuk', out: 'Keluar', set: 'Koreksi' };
const QTY_LABEL = { in: 'Jumlah masuk', out: 'Jumlah keluar', set: 'Stok sebenarnya' };
const MAX_PHOTO = 5 * 1024 * 1024;
const isSuper = () => !!state.user && state.user.role === 'superadmin';
const roleLabel = (r) => (r === 'superadmin' ? 'Super admin' : 'Admin');

// ---------- Helpers ----------
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    location.replace('/login.html'); // sesi habis / belum login
    throw new Error('Sesi berakhir, silakan masuk lagi');
  }
  if (!res.ok) throw new Error(data.error || 'Terjadi kesalahan');
  return data;
}
const jsonOpts = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const fmtDate = (s) =>
  new Date(s.replace(' ', 'T') + 'Z').toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
const fmtNum = (n) => Number(n).toLocaleString('id-ID');
const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const fmtRp = (n) => (n == null ? '—' : rupiah.format(n));
const photoUrl = (f) => `/uploads/${encodeURIComponent(f)}`;
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}
const savedName = () => localStorage.getItem('stok_name') || '';
const rememberName = (n) => n && localStorage.setItem('stok_name', n);

// ---------- Input harga dengan pemisah ribuan (3.000.000) ----------
const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');
const groupDigits = (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
function setMoney(el, n) {
  el.value = n == null || n === '' ? '' : groupDigits(String(n));
}
document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches || !el.matches('input.money')) return;
  const pos = el.selectionStart ?? el.value.length;
  const before = digitsOf(el.value.slice(0, pos)).length; // jumlah digit di kiri kursor
  el.value = groupDigits(digitsOf(el.value).replace(/^0+(?=\d)/, '').slice(0, 13));
  let idx = 0;
  let seen = 0;
  while (idx < el.value.length && seen < before) {
    if (/\d/.test(el.value[idx])) seen++;
    idx++;
  }
  el.setSelectionRange(idx, idx);
});
// Ganti nilai input harga di FormData menjadi angka murni sebelum dikirim
function moneyFD(fd, form) {
  $$('input.money[name]', form).forEach((el) => fd.set(el.name, digitsOf(el.value)));
  return fd;
}

// ---------- Foto ----------
function bindPreview(input, img) {
  input.addEventListener('change', () => {
    if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    const file = input.files[0];
    img.hidden = !file;
    if (file) img.src = URL.createObjectURL(file);
  });
}
function readPhoto(fd, errEl) {
  const file = fd.get('photo');
  if (file && file.size === 0) fd.delete('photo'); // foto opsional
  else if (file && file.size > MAX_PHOTO) {
    errEl.textContent = 'Ukuran foto maksimal 5 MB';
    return false;
  }
  return true;
}
// Ambil file dari input tersembunyi, validasi ukuran, lalu reset agar bisa memilih file yang sama lagi
function pickedFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return null;
  if (file.size > MAX_PHOTO) {
    toast('Ukuran foto maksimal 5 MB');
    return null;
  }
  return file;
}

// ---------- Dialog konfirmasi ----------
function confirmAction({ title, html, okText, danger = true }) {
  return new Promise((resolve) => {
    const d = $('#dlgConfirm');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = html;
    const ok = $('#confirmOk');
    ok.textContent = okText;
    ok.classList.toggle('danger-solid', danger);
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

// ---------- Navigasi ----------
function showTab(name) {
  if (name === 'margin' && !isSuper()) name = 'items';
  state.tab = name;
  $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  TABS.forEach((t) => ($(`#tab-${t}`).hidden = t !== name));
  $('#view-item').hidden = true;
  if (name === 'history') loadHistory().catch((e) => toast(e.message));
  if (name === 'categories') renderCategories();
  if (name === 'margin') {
    syncNav();
    loadMargin().catch((e) => toast(e.message));
  }
}
$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.tab = btn.dataset.tab;
    if (location.hash.startsWith('#/item/')) location.hash = ''; // memicu route()
    else showTab(btn.dataset.tab);
  })
);
function route() {
  const m = location.hash.match(/^#\/item\/(\d+)$/);
  if (m) {
    TABS.forEach((t) => ($(`#tab-${t}`).hidden = true));
    $('#view-item').hidden = false;
    loadItemPage(Number(m[1]));
  } else {
    showTab(state.tab);
  }
}
window.addEventListener('hashchange', route);
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

// ---------- Akun ----------
$('#btnLogout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.replace('/login.html');
});
$('#btnPassword').addEventListener('click', () => {
  $('#formPassword').reset();
  $('#errPassword').textContent = '';
  $('#dlgPassword').showModal();
});
$('#formPassword').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  if (f.next !== f.confirm) {
    $('#errPassword').textContent = 'Password baru dan pengulangannya tidak sama';
    return;
  }
  try {
    await api('/api/change-password', jsonOpts('POST', { current: f.current, next: f.next }));
    $('#dlgPassword').close();
    toast('Password diganti');
  } catch (err) {
    $('#errPassword').textContent = err.message;
  }
});

// ---------- Kategori ----------
async function loadCategories() {
  state.categories = await api('/api/categories');
  const filter = $('#filterCategory');
  const selected = filter.value;
  filter.innerHTML =
    '<option value="">Semua kategori</option>' +
    state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  filter.value = state.categories.some((c) => String(c.id) === selected) ? selected : '';
  renderCategories();
}

function renderCategories() {
  const box = $('#categoriesTable');
  if (!state.categories.length) {
    box.innerHTML = '<div class="empty">Belum ada kategori. Tambahkan kategori pertama di atas.</div>';
    return;
  }
  box.innerHTML = `<table>
    <thead><tr><th>Nama kategori</th><th class="num">Jumlah barang</th><th></th></tr></thead>
    <tbody>${state.categories
      .map(
        (c) => `<tr>
        <td class="item-name">${esc(c.name)}</td>
        <td class="num">${fmtNum(c.item_count)}</td>
        <td class="actions-cell">
          <button class="btn small danger" data-del-cat="${c.id}" ${c.item_count ? 'disabled title="Masih dipakai barang"' : ''}>Hapus</button>
        </td></tr>`
      )
      .join('')}</tbody></table>`;
}

$('#formCategory').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#categoryName');
  try {
    await api('/api/categories', jsonOpts('POST', { name: input.value }));
    input.value = '';
    await loadCategories();
    toast('Kategori tersimpan');
  } catch (err) {
    toast(err.message);
  }
});
$('#categoriesTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-del-cat]');
  if (!btn || !confirm('Hapus kategori ini?')) return;
  try {
    await api(`/api/categories/${btn.dataset.delCat}`, { method: 'DELETE' });
    await loadCategories();
    toast('Kategori dihapus');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Daftar barang & dashboard ----------
const statusBadge = (st) =>
  st === 'kurang'
    ? '<span class="badge short">Barang kurang</span>'
    : st === 'menipis'
    ? '<span class="badge low">Menipis</span>'
    : '<span class="muted">Aman</span>';

async function loadItems() {
  const params = new URLSearchParams();
  const q = $('#search').value.trim();
  if (q) params.set('search', q);
  if ($('#filterCategory').value) params.set('category_id', $('#filterCategory').value);
  if ($('#filterStatus').value) params.set('status', $('#filterStatus').value);
  const [items, summary] = await Promise.all([api('/api/items?' + params), api('/api/summary')]);
  state.items = items;
  renderItems();
  renderSummary(summary);
}

// Dashboard selalu menghitung semua barang, tidak terpengaruh filter pencarian
function renderSummary(s) {
  $('#summary').innerHTML = `
    <div class="stat"><b>${fmtNum(s.items)}</b><span>Jenis barang</span></div>
    <div class="stat"><b>${fmtNum(s.units)}</b><span>Total unit di gudang</span></div>
    <button class="stat clickable ${s.menipis ? 'warn' : ''}" data-status="menipis"><b>${fmtNum(s.menipis)}</b><span>Stok menipis</span></button>
    <button class="stat clickable ${s.kurang ? 'warn' : ''}" data-status="kurang"><b>${fmtNum(s.kurang)}</b><span>Barang kurang</span></button>`;
}
$('#summary').addEventListener('click', (e) => {
  const b = e.target.closest('[data-status]');
  if (!b) return;
  $('#filterStatus').value = $('#filterStatus').value === b.dataset.status ? '' : b.dataset.status;
  loadItems().catch((err) => toast(err.message));
});

function renderItems() {
  const box = $('#itemsTable');
  if (!state.items.length) {
    const filtering = $('#search').value.trim() || $('#filterCategory').value || $('#filterStatus').value;
    box.innerHTML = `<div class="empty">${
      filtering ? 'Tidak ada barang yang cocok dengan pencarian.' : 'Belum ada barang. Klik “Tambah barang” untuk mulai.'
    }</div>`;
    return;
  }
  box.innerHTML = `<table>
    <thead><tr><th>Nama barang</th><th>Kategori</th><th class="num">Total stok</th><th>Ukuran</th><th>Status</th><th></th></tr></thead>
    <tbody>${state.items
      .map((i) => {
        const thumb = i.photo
          ? `<img class="thumb sm" src="${photoUrl(i.photo)}" alt="" loading="lazy">`
          : '<span class="thumb sm empty-thumb" aria-hidden="true"></span>';
        return `<tr>
          <td><a class="item-link" href="#/item/${i.id}">${thumb}<span class="item-name">${esc(i.name)}</span></a></td>
          <td><span class="badge">${esc(i.category_name)}</span></td>
          <td class="num ${i.stock < 0 ? 'minus' : ''}">${fmtNum(i.stock)} ${esc(i.unit)}</td>
          <td>${i.size_count ? `${fmtNum(i.size_count)} ukuran` : '<span class="muted">—</span>'}</td>
          <td>${statusBadge(i.status)}</td>
          <td class="actions-cell">
            <button class="btn small primary" data-stock="${i.id}">Update stok</button>
            <a class="btn small" href="#/item/${i.id}">Detail</a>
          </td></tr>`;
      })
      .join('')}</tbody></table>`;
}
const reloadItems = debounce(() => loadItems().catch((e) => toast(e.message)));
$('#search').addEventListener('input', reloadItems);
$('#filterCategory').addEventListener('change', reloadItems);
$('#filterStatus').addEventListener('change', reloadItems);
$('#itemsTable').addEventListener('click', (e) => {
  const s = e.target.closest('[data-stock]');
  if (s) openStockDialog(Number(s.dataset.stock));
});

// ---------- Tambah barang ----------
bindPreview($('#itemPhotoInput'), $('#itemPhotoPreview'));

function addSizeRow(label = '', stock = '') {
  const row = document.createElement('div');
  row.className = 'size-row';
  row.innerHTML = `
    <input class="sz-label" placeholder="Ukuran, mis. M" maxlength="20" aria-label="Nama ukuran" value="${esc(label)}">
    <input class="sz-stock" type="number" min="0" step="1" placeholder="Stok" aria-label="Stok ukuran" value="${esc(stock)}">
    <input class="sz-cost money super-only" inputmode="numeric" autocomplete="off" placeholder="Modal (Rp)" aria-label="Harga modal ukuran">
    <button type="button" class="btn small danger" data-rm>Hapus</button>`;
  $('#sizeRows').appendChild(row);
}
function toggleSizes() {
  const on = $('#hasSizes').checked;
  $('#sizesBox').hidden = !on;
  $('#stockField').hidden = on;
  $('#itemCostField').hidden = on;
  if (on && !$('#sizeRows').children.length) addSizeRow();
}
$('#hasSizes').addEventListener('change', toggleSizes);
$('#btnAddSizeRow').addEventListener('click', () => addSizeRow());
$('#sizeRows').addEventListener('click', (e) => e.target.closest('[data-rm]')?.closest('.size-row').remove());

$('#btnAddItem').addEventListener('click', () => {
  const form = $('#formItem');
  form.reset();
  $('#errItem').textContent = '';
  $('#itemPhotoPreview').hidden = true;
  $('#sizeRows').innerHTML = '';
  toggleSizes();
  form.elements.updated_by.value = savedName();
  const has = state.categories.length > 0;
  $('#itemCategory').innerHTML = has
    ? state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
    : '<option value="">— belum ada kategori —</option>';
  $('#noCategoryHint').hidden = has;
  form.querySelector('button[type="submit"]').disabled = !has;
  $('#dlgItem').showModal();
});

$('#formItem').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = moneyFD(new FormData(e.target), e.target);
  if (!readPhoto(fd, $('#errItem'))) return;
  if (!isSuper()) fd.delete('cost_price'); // modal hanya untuk super admin
  if ($('#hasSizes').checked) {
    const sizes = $$('.size-row')
      .map((r) => ({
        label: $('.sz-label', r).value,
        stock: $('.sz-stock', r).value,
        cost_price: isSuper() ? digitsOf($('.sz-cost', r).value) : '',
      }))
      .filter((s) => s.label.trim() || s.stock !== '' || s.cost_price !== '');
    if (!sizes.length) {
      $('#errItem').textContent = 'Isi minimal satu ukuran, atau matikan pilihan “punya ukuran”';
      return;
    }
    fd.set('sizes', JSON.stringify(sizes));
  }
  try {
    const item = await api('/api/items', { method: 'POST', body: fd });
    rememberName(fd.get('updated_by'));
    $('#dlgItem').close();
    await Promise.all([loadCategories(), loadItems()]);
    toast('Barang ditambahkan');
    location.hash = `#/item/${item.id}`;
  } catch (err) {
    $('#errItem').textContent = err.message;
  }
});

// ---------- Update stok ----------
bindPreview($('#photoInput'), $('#photoPreview'));

function updateQtyLabel() {
  const form = $('#formStock');
  const type = form.querySelector('input[name="type"]:checked').value;
  $('#qtyLabel').textContent = QTY_LABEL[type];
  form.elements.quantity.min = type === 'set' ? 0 : 1;
  const out = type === 'out';
  $('#priceField').hidden = !out;
  form.elements.sell_price.required = out;
  updateStockWarn();
}
// Peringatan jika stok akan menjadi minus (tetap boleh disimpan)
function updateStockWarn() {
  const item = state.stockItem;
  const f = $('#formStock');
  const warn = $('#stockWarn');
  if (!item || f.querySelector('input[name="type"]:checked').value !== 'out') {
    warn.hidden = true;
    return;
  }
  const qty = Number(f.elements.quantity.value) || 0;
  let current = item.stock;
  if (item.has_sizes) {
    const s = item.sizes.find((x) => String(x.id) === $('#stockSize').value);
    current = s ? s.stock : 0;
  }
  const after = current - qty;
  warn.hidden = !(qty > 0 && after < 0);
  if (!warn.hidden) warn.textContent = `Stok ${item.has_sizes ? 'ukuran ini ' : ''}akan menjadi ${fmtNum(after)} dan berstatus “Barang kurang”.`;
}
$('#formStock').addEventListener('input', updateStockWarn);
$('#formStock').addEventListener('change', updateStockWarn);
$$('#formStock input[name="type"]').forEach((r) => r.addEventListener('change', updateQtyLabel));

async function openStockDialog(id, sizeId) {
  try {
    const item = await api(`/api/items/${id}`);
    state.stockItem = item;
    const form = $('#formStock');
    form.reset();
    $('#errStock').textContent = '';
    $('#photoPreview').hidden = true;
    form.elements.updated_by.value = savedName();
    $('#sizeField').hidden = !item.has_sizes;
    $('#stockSize').required = !!item.has_sizes;
    $('#stockSize').innerHTML = item.sizes
      .map((s) => `<option value="${s.id}">${esc(s.label)} (stok ${fmtNum(s.stock)})</option>`)
      .join('');
    if (sizeId) $('#stockSize').value = String(sizeId);
    $('#stockInfo').textContent = `${item.name}, total stok ${fmtNum(item.stock)} ${item.unit}`;
    updateQtyLabel();
    $('#dlgStock').showModal();
  } catch (err) {
    toast(err.message);
  }
}

$('#formStock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const item = state.stockItem;
  const fd = moneyFD(new FormData(e.target), e.target);
  if (!item.has_sizes) fd.delete('size_id');
  if (fd.get('type') !== 'out') fd.delete('sell_price');
  if (!readPhoto(fd, $('#errStock'))) return;
  try {
    await api(`/api/items/${item.id}/stock`, { method: 'POST', body: fd });
    rememberName(fd.get('updated_by'));
    $('#dlgStock').close();
    await loadItems();
    if (location.hash === `#/item/${item.id}`) await loadItemPage(item.id);
    toast('Stok diperbarui');
  } catch (err) {
    $('#errStock').textContent = err.message;
  }
});

// ---------- Tambah ukuran ----------
$('#formSize').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(moneyFD(new FormData(e.target), e.target));
  if (!isSuper()) delete f.cost_price;
  const id = state.item.id;
  try {
    await api(`/api/items/${id}/sizes`, jsonOpts('POST', f));
    rememberName(f.updated_by);
    $('#dlgSize').close();
    await loadItems();
    await loadItemPage(id);
    toast('Ukuran ditambahkan');
  } catch (err) {
    $('#errSize').textContent = err.message;
  }
});

function openSizeDialog() {
  const item = state.item;
  const form = $('#formSize');
  form.reset();
  $('#errSize').textContent = '';
  form.elements.updated_by.value = savedName();
  const carry = !item.has_sizes && item.stock > 0;
  $('#sizeInfo').textContent = carry
    ? `Stok barang saat ini (${fmtNum(item.stock)} ${item.unit}) akan dipindahkan ke ukuran pertama ini.`
    : `Tambahkan ukuran baru untuk ${item.name}.`;
  $('#sizeStockLabel').textContent = carry ? 'Tambahan stok untuk ukuran ini' : 'Stok ukuran ini';
  $('#dlgSize').showModal();
}

// ---------- Edit barang & modal (super admin) ----------
function openEditDialog() {
  const i = state.item;
  const f = $('#formEdit');
  f.reset();
  $('#errEdit').textContent = '';
  f.elements.name.value = i.name;
  setMoney(f.elements.cost_price, i.cost_price);
  $('#editCostField').hidden = !!i.has_sizes;
  $('#editCostHint').hidden = !i.has_sizes;
  $('#dlgEdit').showModal();
}
$('#formEdit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const i = state.item;
  const f = e.target.elements;
  const body = { name: f.name.value };
  if (!i.has_sizes) body.cost_price = digitsOf(f.cost_price.value);
  try {
    await api(`/api/items/${i.id}`, jsonOpts('PATCH', body));
    $('#dlgEdit').close();
    await loadItems();
    await loadItemPage(i.id);
    toast('Barang diperbarui');
  } catch (err) {
    $('#errEdit').textContent = err.message;
  }
});

function openCostDialog(sizeId) {
  const size = state.item.sizes.find((s) => s.id === sizeId);
  if (!size) return;
  state.costSize = size;
  const f = $('#formCost');
  f.reset();
  $('#errCost').textContent = '';
  $('#costInfo').textContent = `${state.item.name}, ukuran ${size.label}`;
  setMoney(f.elements.cost_price, size.cost_price);
  $('#dlgCost').showModal();
}
$('#formCost').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.item.id;
  try {
    await api(`/api/items/${id}/sizes/${state.costSize.id}`, jsonOpts('PATCH', { cost_price: digitsOf(e.target.elements.cost_price.value) }));
    $('#dlgCost').close();
    await loadItemPage(id);
    toast('Modal disimpan');
  } catch (err) {
    $('#errCost').textContent = err.message;
  }
});

// ---------- Stok minimal (admin dan super admin) ----------
function openMinDialog() {
  const i = state.item;
  const f = $('#formMin');
  f.reset();
  $('#errMin').textContent = '';
  $('#minInfo').textContent = `${i.name}, stok saat ini ${fmtNum(i.stock)} ${i.unit}`;
  f.elements.min_stock.value = i.min_stock;
  $('#dlgMin').showModal();
}
$('#formMin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = state.item.id;
  try {
    await api(`/api/items/${id}/min-stock`, jsonOpts('PATCH', { min_stock: e.target.elements.min_stock.value }));
    $('#dlgMin').close();
    await loadItems();
    await loadItemPage(id);
    toast('Stok minimal disimpan');
  } catch (err) {
    $('#errMin').textContent = err.message;
  }
});

// ---------- Upload / ganti foto barang ----------
$('#itemPhotoUpload').addEventListener('change', async (e) => {
  const file = pickedFile(e.target);
  if (!file || !state.item) return;
  const id = state.item.id;
  const fd = new FormData();
  fd.append('photo', file);
  try {
    await api(`/api/items/${id}/photo`, { method: 'POST', body: fd });
    await loadItems();
    await loadItemPage(id);
    toast('Foto barang disimpan');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Halaman detail barang ----------
async function loadItemPage(id) {
  const box = $('#view-item');
  try {
    const item = await api(`/api/items/${id}`);
    state.item = item;
    renderItemPage(item);
    await loadItemHistory(id);
  } catch (err) {
    box.innerHTML = `<a class="back" href="#">← Kembali ke daftar barang</a><div class="table-wrap"><div class="empty">${esc(err.message)}</div></div>`;
  }
}

function renderItemPage(i) {
  const sup = isSuper();
  const photo = i.photo
    ? `<a href="${photoUrl(i.photo)}" target="_blank" rel="noopener"><img src="${photoUrl(i.photo)}" alt="Foto ${esc(i.name)}"></a>`
    : '<div class="no-photo">Belum ada foto</div>';
  // Admin hanya bisa menambah foto jika belum ada; super admin juga bisa mengganti
  const photoBtn = !i.photo
    ? '<button class="btn small" data-act="photo">Upload foto</button>'
    : sup
    ? '<button class="btn small" data-act="photo">Ganti foto</button>'
    : '';
  const sizes = i.has_sizes
    ? `<h3>Stok per ukuran</h3>
       <div class="table-wrap"><table>
        <thead><tr><th>Ukuran</th><th class="num">Stok</th>${sup ? '<th class="num">Modal / unit</th>' : ''}<th></th></tr></thead>
        <tbody>${i.sizes
          .map(
            (s) => `<tr><td class="item-name">${esc(s.label)}${s.stock < 0 ? ' <span class="badge short">Kurang</span>' : ''}</td>
              <td class="num ${s.stock < 0 ? 'minus' : ''}">${fmtNum(s.stock)} ${esc(i.unit)}</td>
              ${sup ? `<td class="num">${s.cost_price == null ? '<span class="muted">belum diisi</span>' : fmtRp(s.cost_price)}</td>` : ''}
              <td class="actions-cell">
                <button class="btn small primary" data-act="stock" data-size="${s.id}">Update stok</button>
                ${sup ? `<button class="btn small" data-act="cost" data-size="${s.id}">Edit modal</button>` : ''}
              </td></tr>`
          )
          .join('')}</tbody></table></div>`
    : '';
  const costLine =
    sup && !i.has_sizes
      ? `<p>Harga modal: <b>${i.cost_price == null ? '<span class="muted">belum diisi</span>' : fmtRp(i.cost_price)}</b> per ${esc(i.unit)}</p>`
      : '';
  $('#view-item').innerHTML = `
    <a class="back" href="#">← Kembali ke daftar barang</a>
    <div class="detail">
      <div>
        <div class="detail-photo">${photo}</div>
        <div class="photo-actions">${photoBtn}</div>
      </div>
      <div class="detail-info">
        <h2>${esc(i.name)}</h2>
        <p><span class="badge">${esc(i.category_name)}</span> ${i.status === 'aman' ? '' : statusBadge(i.status)}</p>
        <p class="big ${i.stock < 0 ? 'minus' : ''}">${fmtNum(i.stock)} <small>${esc(i.unit)}</small></p>
        <p class="muted">Total stok${i.has_sizes ? ` dari ${i.sizes.length} ukuran` : ''}.</p>
        <p>Stok minimal: <b>${fmtNum(i.min_stock)}</b> ${esc(i.unit)} <button class="btn small" data-act="min">Ubah</button></p>
        ${costLine}
        <p class="muted">Ditambahkan ${fmtDate(i.created_at)}</p>
        <div class="detail-actions">
          ${i.has_sizes ? '' : '<button class="btn primary" data-act="stock">Update stok</button>'}
          <button class="btn" data-act="addsize">Tambah ukuran</button>
          ${sup ? '<button class="btn" data-act="edit">Edit barang</button>' : ''}
          ${sup ? '<button class="btn danger" data-act="delete">Hapus barang</button>' : ''}
        </div>
      </div>
    </div>
    ${sizes}
    <h3>Riwayat barang ini</h3>
    <div class="hist-box" id="itemHist" data-scope="item" data-item="${i.id}"></div>`;
}

$('#view-item').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || !state.item) return;
  const item = state.item;
  const sizeId = b.dataset.size ? Number(b.dataset.size) : undefined;
  switch (b.dataset.act) {
    case 'stock': return openStockDialog(item.id, sizeId);
    case 'addsize': return openSizeDialog();
    case 'edit': return openEditDialog();
    case 'cost': return openCostDialog(sizeId);
    case 'min': return openMinDialog();
    case 'photo': return $('#itemPhotoUpload').click();
    case 'delete': {
      const okay = await confirmAction({
        title: 'Hapus barang?',
        html: `<p><b>${esc(item.name)}</b> akan dihapus permanen beserta semua ukuran, foto, dan riwayatnya.</p>
               <p>Penjualan barang ini juga hilang dari margin. Tindakan ini tidak bisa dibatalkan.</p>`,
        okText: 'Ya, hapus barang',
      });
      if (!okay) return;
      try {
        await api(`/api/items/${item.id}`, { method: 'DELETE' });
        toast('Barang dihapus');
        location.hash = '';
        await Promise.all([loadCategories(), loadItems()]);
      } catch (err) {
        toast(err.message);
      }
    }
  }
});

// ---------- Riwayat ----------
function historyBox(rows, showItem) {
  if (!rows.length) return '<div class="table-wrap"><div class="empty">Belum ada riwayat.</div></div>';
  const sup = isSuper();
  state.hist = new Map(rows.map((r) => [r.id, r]));
  const bulk = sup
    ? `<div class="bulkbar"><span class="muted">Centang riwayat, lalu pilih tindakan.</span>
        <span class="bulk-actions">
          <button class="btn small hist-cancel" disabled>Batalkan terpilih</button>
          <button class="btn small danger hist-del" disabled>Hapus terpilih</button>
        </span></div>`
    : '';
  const body = rows
    .map((h) => {
      const cls = h.change > 0 ? 'plus' : h.change < 0 ? 'minus' : 'muted';
      const sign = h.change > 0 ? '+' : h.change < 0 ? '−' : '';
      const cancelled = !!h.cancelled_at;
      return `<tr class="${cancelled ? 'is-cancelled' : ''}">
        ${sup ? `<td><input type="checkbox" class="hist-row" data-hid="${h.id}" aria-label="Pilih riwayat"></td>` : ''}
        <td class="muted">${fmtDate(h.created_at)}</td>
        ${showItem ? `<td><a class="item-name" href="#/item/${h.item_id}">${esc(h.item_name)}</a></td>` : ''}
        <td>${h.size_label ? esc(h.size_label) : '<span class="muted">—</span>'}</td>
        <td><span class="badge ${h.type === 'in' ? 'in' : h.type === 'out' ? 'out' : ''}">${TYPE_LABEL[h.type]}</span>${
          cancelled ? `<br><span class="badge cancelled" title="Dibatalkan ${esc(fmtDate(h.cancelled_at))}">Dibatalkan</span>` : ''
        }</td>
        <td class="num ${cls}">${sign}${fmtNum(Math.abs(h.change))}</td>
        <td class="num">${h.sell_price == null ? '<span class="muted">—</span>' : fmtRp(h.sell_price)}${
          sup && h.type === 'out' && h.cost_at_sale != null ? `<br><small class="muted">modal ${fmtRp(h.cost_at_sale)}</small>` : ''
        }</td>
        <td class="num">${fmtNum(h.stock_after)} ${esc(h.unit)}</td>
        <td>${h.updated_by ? esc(h.updated_by) : '<span class="muted">—</span>'}${
          sup && h.account ? `<br><small class="muted">${roleLabel(h.account)}</small>` : ''
        }</td>
        <td>${esc(h.note) || '<span class="muted">—</span>'}</td>
        <td class="proof">${
          h.photo
            ? `<a href="${photoUrl(h.photo)}" target="_blank" rel="noopener"><img class="thumb" src="${photoUrl(h.photo)}" alt="Foto bukti" loading="lazy"></a>
               <button class="btn small" data-proof="${h.id}">Ganti foto</button>`
            : `<button class="btn small" data-proof="${h.id}">Tambah foto</button>`
        }</td></tr>`;
    })
    .join('');
  return `${bulk}<div class="table-wrap"><table class="wide">
    <thead><tr>${sup ? '<th><input type="checkbox" class="hist-all" aria-label="Pilih semua"></th>' : ''}
      <th>Waktu</th>${showItem ? '<th>Barang</th>' : ''}<th>Ukuran</th><th>Jenis</th>
      <th class="num">Perubahan</th><th class="num">Harga jual / unit</th><th class="num">Stok akhir</th>
      <th>Diupdate oleh</th><th>Catatan</th><th>Bukti</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

async function loadHistory() {
  const q = $('#searchHistory').value.trim();
  const rows = await api('/api/history' + (q ? '?search=' + encodeURIComponent(q) : ''));
  $('#historyTable').innerHTML = historyBox(rows, true);
}
async function loadItemHistory(id) {
  const rows = await api(`/api/items/${id}/history`);
  const box = $('#itemHist');
  if (box) box.innerHTML = historyBox(rows, false);
}
$('#searchHistory').addEventListener('input', debounce(() => loadHistory().catch((e) => toast(e.message))));

function updateBulk(box) {
  const n = $$('.hist-row:checked', box).length;
  const cancel = $('.hist-cancel', box);
  const del = $('.hist-del', box);
  cancel.disabled = del.disabled = n === 0;
  cancel.textContent = n ? `Batalkan terpilih (${n})` : 'Batalkan terpilih';
  del.textContent = n ? `Hapus terpilih (${n})` : 'Hapus terpilih';
}
document.addEventListener('change', (e) => {
  const box = e.target.closest('.hist-box');
  if (!box) return;
  if (e.target.matches('.hist-all')) {
    $$('.hist-row', box).forEach((c) => (c.checked = e.target.checked));
    updateBulk(box);
  } else if (e.target.matches('.hist-row')) updateBulk(box);
});

// Setelah riwayat berubah, muat ulang daftar barang dan tampilan yang sedang terbuka
async function afterHistoryChange(box) {
  await loadItems();
  if (box.dataset.scope === 'item') await loadItemPage(Number(box.dataset.item));
  else await loadHistory();
}
const selectedHistory = (box) => $$('.hist-row:checked', box).map((c) => state.hist.get(Number(c.dataset.hid))).filter(Boolean);

async function bulkCancel(box) {
  const rows = selectedHistory(box);
  const can = rows.filter((h) => !h.cancelled_at && h.type !== 'initial');
  if (!can.length) {
    toast('Riwayat terpilih tidak bisa dibatalkan (sudah dibatalkan atau berupa stok awal)');
    return;
  }
  // Ringkasan efek ke stok per barang/ukuran
  const effects = new Map();
  can.forEach((h) => {
    const k = h.item_name + (h.size_label ? ` (${h.size_label})` : '');
    effects.set(k, (effects.get(k) || 0) - h.change);
  });
  const lines = [...effects].slice(0, 8).map(([k, v]) => `<li>${esc(k)}: <b>${v > 0 ? '+' : v < 0 ? '−' : ''}${fmtNum(Math.abs(v))}</b></li>`);
  if (effects.size > 8) lines.push(`<li>dan ${effects.size - 8} lainnya</li>`);
  const sales = can.filter((h) => h.type === 'out' && h.sell_price != null).length;
  const skipped = rows.length - can.length;
  const okay = await confirmAction({
    title: `Batalkan ${can.length} riwayat?`,
    html: `<p><b>Stok dikembalikan</b> seperti sebelum update tersebut:</p><ul>${lines.join('')}</ul>
           ${sales ? `<p><b>${fmtNum(sales)} penjualan</b> akan dihapus dari perhitungan margin.</p>` : ''}
           <p>Catatannya tetap tampil di riwayat dengan tanda “Dibatalkan”.${skipped ? ` ${skipped} riwayat dilewati (sudah dibatalkan atau stok awal).` : ''}</p>`,
    okText: 'Ya, batalkan riwayat',
  });
  if (!okay) return;
  try {
    const r = await api('/api/history/cancel', jsonOpts('POST', { ids: can.map((h) => h.id) }));
    toast(`${r.cancelled} riwayat dibatalkan, stok dikembalikan`);
    await afterHistoryChange(box);
  } catch (err) {
    toast(err.message);
  }
}

async function bulkDelete(box) {
  const rows = selectedHistory(box);
  if (!rows.length) return;
  const sales = rows.filter((h) => h.type === 'out' && h.sell_price != null && !h.cancelled_at).length;
  const okay = await confirmAction({
    title: `Hapus ${rows.length} riwayat?`,
    html: `<p>Catatan akan dihapus permanen dan tidak bisa dikembalikan.</p>
           <p><b>Stok barang tidak berubah.</b> Jika ingin stok kembali, pilih “Batalkan terpilih”.</p>
           ${sales ? `<p>${fmtNum(sales)} penjualan yang dihapus juga hilang dari margin.</p>` : ''}`,
    okText: 'Ya, hapus riwayat',
  });
  if (!okay) return;
  try {
    await api('/api/history/delete', jsonOpts('POST', { ids: rows.map((h) => h.id) }));
    toast('Riwayat dihapus, stok tidak berubah');
    await afterHistoryChange(box);
  } catch (err) {
    toast(err.message);
  }
}

document.addEventListener('click', (e) => {
  const cancel = e.target.closest('.hist-cancel');
  if (cancel) return bulkCancel(cancel.closest('.hist-box'));
  const del = e.target.closest('.hist-del');
  if (del) return bulkDelete(del.closest('.hist-box'));
  // Tambah / ganti foto bukti
  const proof = e.target.closest('[data-proof]');
  if (proof) {
    state.proof = { id: Number(proof.dataset.proof), box: proof.closest('.hist-box') };
    $('#proofInput').click();
  }
});

$('#proofInput').addEventListener('change', async (e) => {
  const file = pickedFile(e.target);
  const target = state.proof;
  if (!file || !target) return;
  const fd = new FormData();
  fd.append('photo', file);
  try {
    await api(`/api/history/${target.id}/photo`, { method: 'POST', body: fd });
    toast('Foto bukti disimpan');
    if (target.box.dataset.scope === 'item') await loadItemHistory(Number(target.box.dataset.item));
    else await loadHistory();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Margin (super admin) ----------
const NAV_LABEL = { day: 'Hari ini', month: 'Bulan ini', year: 'Tahun ini' };

function syncNav() {
  $$('.seg-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.type === state.mtype));
  const nav = $('#periodNav');
  nav.hidden = state.mtype === 'all';
  if (state.mtype === 'all') return;
  const el = $('#mDate');
  el.type = state.mtype === 'day' ? 'date' : state.mtype === 'month' ? 'month' : 'number';
  if (state.mtype === 'year') {
    el.min = 2000;
    el.max = 2100;
    el.step = 1;
  }
  el.value = state.mdate[state.mtype];
  $('#mToday').textContent = NAV_LABEL[state.mtype];
}

$('#periodBtns').addEventListener('click', (e) => {
  const b = e.target.closest('[data-type]');
  if (!b) return;
  state.mtype = b.dataset.type;
  syncNav();
  loadMargin().catch((err) => toast(err.message));
});
function shiftPeriod(dir) {
  const t = state.mtype;
  const v = state.mdate[t];
  if (t === 'day') {
    const [y, m, d] = v.split('-').map(Number);
    state.mdate.day = localDay(new Date(y, m - 1, d + dir));
  } else if (t === 'month') {
    const [y, m] = v.split('-').map(Number);
    const dt = new Date(y, m - 1 + dir, 1);
    state.mdate.month = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
  } else {
    state.mdate.year = String(Number(v) + dir);
  }
  syncNav();
  loadMargin().catch((err) => toast(err.message));
}
$('#mPrev').addEventListener('click', () => shiftPeriod(-1));
$('#mNext').addEventListener('click', () => shiftPeriod(1));
$('#mToday').addEventListener('click', () => {
  state.mdate = todayKeys();
  syncNav();
  loadMargin().catch((err) => toast(err.message));
});
$('#mDate').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.mdate[state.mtype] = e.target.value;
  loadMargin().catch((err) => toast(err.message));
});

const fmtDayKey = (k, long) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'short',
    ...(long ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  });
};
function bucketLabel(key, bucket, long) {
  if (bucket === 'hour') return long ? `${fmtDayKey(key.slice(0, 10))} ${key.slice(11)}` : key.slice(11);
  if (bucket === 'year') return key;
  if (bucket === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('id-ID', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  return fmtDayKey(key, long);
}
const BUCKET_NAME = { hour: 'jam', day: 'hari', month: 'bulan', year: 'tahun' };

function periodTitle(d) {
  if (d.type === 'all') return 'Semua penjualan';
  if (d.type === 'year') return `Tahun ${d.date}`;
  if (d.type === 'month') {
    const [y, m] = d.date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('id-ID', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  const [y, m, dd] = d.date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function profitChart(series, bucket) {
  if (!series.length) return '<div class="empty">Belum ada data untuk digambar.</div>';
  const W = 800, H = 280, L = 64, R = 12, T = 16, B = 36;
  const pw = W - L - R;
  const ph = H - T - B;
  const vals = series.map((s) => s.profit);
  const max = Math.max(0, ...vals);
  const min = Math.min(0, ...vals);
  const span = max - min || 1;
  const y = (v) => T + ((max - v) / span) * ph;
  const y0 = y(0);
  const bw = pw / series.length;
  const bar = Math.min(bw * 0.7, 48);
  const step = Math.ceil(series.length / 12);
  const compact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
  let g = '';
  [...new Set([max, 0, min])].forEach((t) => {
    g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="grid"/>
          <text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" class="axis">${compact.format(t)}</text>`;
  });
  series.forEach((s, i) => {
    const cx = L + bw * i + bw / 2;
    const yv = y(s.profit);
    const h = s.profit ? Math.max(Math.abs(yv - y0), 1.5) : 0;
    const top = s.profit < 0 ? y0 : y0 - h;
    g += `<rect x="${cx - bar / 2}" y="${top}" width="${bar}" height="${h}" rx="2" class="${s.profit < 0 ? 'neg' : 'pos'}">
            <title>${esc(bucketLabel(s.key, bucket, true))}: ${esc(fmtRp(s.profit))}</title></rect>`;
    if (i % step === 0) g += `<text x="${cx}" y="${H - 12}" text-anchor="middle" class="axis">${esc(bucketLabel(s.key, bucket))}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grafik keuntungan per ${BUCKET_NAME[bucket]}">${g}</svg></div>`;
}

async function loadMargin(more = false) {
  const req = ++state.marginReq;
  const p = new URLSearchParams({ type: state.mtype, tzo: String(-new Date().getTimezoneOffset()) }); // zona waktu setempat
  if (state.mtype !== 'all') p.set('date', state.mdate[state.mtype]);
  if (more) p.set('offset', String(state.mrows.length));
  const d = await api('/api/margin?' + p);
  if (req !== state.marginReq) return; // ada permintaan yang lebih baru
  if (more) state.mrows.push(...d.rows);
  else {
    state.mdata = d;
    state.mrows = [...d.rows];
  }
  renderMargin();
}

function renderMargin() {
  const d = state.mdata;
  const s = d.summary;
  const box = $('#marginBody');
  if (!s.sales) {
    box.innerHTML = `<p class="muted period-title">${esc(periodTitle(d))}</p>
      <div class="table-wrap"><div class="empty">Belum ada penjualan pada periode ini.<br>
      Penjualan tercatat saat stok dikurangi dengan mengisi harga jual.</div></div>`;
    return;
  }
  const pct = s.revenue_costed > 0 ? (s.profit / s.revenue_costed) * 100 : null;
  const notice = s.no_cost
    ? `<p class="notice">${fmtNum(s.no_cost)} penjualan belum punya harga modal sehingga belum dihitung sebagai keuntungan. Klik “Edit” pada rincian penjualan untuk mengisi modalnya.</p>`
    : '';

  const byItem = `<table><thead><tr><th>Barang</th><th class="num">Terjual</th><th class="num">Pendapatan</th><th class="num">Keuntungan</th></tr></thead>
    <tbody>${d.by_item
      .map(
        (r) => `<tr>
        <td><a class="item-name" href="#/item/${r.item_id}">${esc(r.item_name)}</a>${r.size_label ? ` <span class="badge">${esc(r.size_label)}</span>` : ''}</td>
        <td class="num">${fmtNum(r.units)}</td>
        <td class="num">${fmtRp(r.revenue)}</td>
        <td class="num ${r.profit == null ? 'muted' : r.profit < 0 ? 'minus' : 'plus'}">${r.profit == null ? 'modal belum diisi' : fmtRp(r.profit)}${
          r.profit != null && r.no_cost ? ' <small class="muted">(sebagian)</small>' : ''
        }</td></tr>`
      )
      .join('')}</tbody></table>`;

  const detail = `<table class="wide"><thead><tr><th>Waktu</th><th>Barang</th><th>Ukuran</th><th class="num">Jumlah</th>
      <th class="num">Harga jual</th><th class="num">Modal</th><th class="num">Keuntungan</th><th>Dijual oleh</th><th></th></tr></thead>
    <tbody>${state.mrows
      .map(
        (r) => `<tr>
        <td class="muted">${fmtDate(r.created_at)}</td>
        <td><a class="item-name" href="#/item/${r.item_id}">${esc(r.item_name)}</a></td>
        <td>${r.size_label ? esc(r.size_label) : '<span class="muted">—</span>'}</td>
        <td class="num">${fmtNum(r.qty)}</td>
        <td class="num">${fmtRp(r.sell_price)}</td>
        <td class="num">${r.cost_price == null ? '<span class="muted">belum diisi</span>' : fmtRp(r.cost_price)}</td>
        <td class="num ${r.profit == null ? 'muted' : r.profit < 0 ? 'minus' : 'plus'}">${r.profit == null ? '—' : fmtRp(r.profit)}</td>
        <td>${r.updated_by ? esc(r.updated_by) : '<span class="muted">—</span>'}${
          r.account ? `<br><small class="muted">${roleLabel(r.account)}</small>` : ''
        }</td>
        <td class="actions-cell"><button class="btn small" data-edit-sale="${r.id}">Edit</button></td></tr>`
      )
      .join('')}</tbody></table>`;

  const hasMore = state.mrows.length < s.sales;
  box.innerHTML = `
    <p class="muted period-title">${esc(periodTitle(d))}</p>
    <div class="summary">
      <div class="stat"><b>${fmtNum(s.units)}</b><span>Unit terjual dalam ${fmtNum(s.sales)} penjualan</span></div>
      <div class="stat"><b>${fmtRp(s.revenue)}</b><span>Pendapatan</span></div>
      <div class="stat"><b>${fmtRp(s.cost)}</b><span>Modal barang terjual</span></div>
      <div class="stat ${s.profit < 0 ? 'warn' : 'good'}"><b>${fmtRp(s.profit)}</b><span>Keuntungan${pct == null ? '' : `, margin ${pct.toLocaleString('id-ID', { maximumFractionDigits: 1 })}%`}</span></div>
    </div>
    ${notice}
    <h3>Grafik keuntungan per ${BUCKET_NAME[d.bucket]}</h3>
    <div class="table-wrap pad">${profitChart(d.series, d.bucket)}</div>
    <h3>Keuntungan per barang</h3>
    <div class="table-wrap">${byItem}</div>
    <h3>Rincian penjualan</h3>
    <div class="table-wrap">${detail}</div>
    <p class="muted more-row">Menampilkan ${fmtNum(state.mrows.length)} dari ${fmtNum(s.sales)} penjualan.
      ${hasMore ? '<button class="btn small" id="mMore">Muat lebih banyak</button>' : ''}</p>`;
}

$('#marginBody').addEventListener('click', (e) => {
  if (e.target.closest('#mMore')) return loadMargin(true).catch((err) => toast(err.message));
  const b = e.target.closest('[data-edit-sale]');
  if (b) openSaleDialog(Number(b.dataset.editSale));
});

// Edit harga jual & modal pada satu penjualan: riwayat dan keuntungan ikut diperbarui
function openSaleDialog(id) {
  const r = state.mrows.find((x) => x.id === id);
  if (!r) return;
  state.sale = r;
  const f = $('#formSale');
  f.reset();
  $('#errSale').textContent = '';
  $('#saleInfo').textContent = `${r.item_name}${r.size_label ? `, ukuran ${r.size_label}` : ''}, ${fmtNum(r.qty)} unit, ${fmtDate(r.created_at)}`;
  setMoney(f.elements.sell_price, r.sell_price);
  setMoney(f.elements.cost_price, r.cost_price);
  updateSaleProfit();
  $('#dlgSale').showModal();
}
function updateSaleProfit() {
  const r = state.sale;
  const f = $('#formSale').elements;
  const sellD = digitsOf(f.sell_price.value);
  const costD = digitsOf(f.cost_price.value);
  $('#applyEmptyField').hidden = costD === '';
  $('#saleProfit').innerHTML =
    costD === ''
      ? 'Modal kosong: penjualan ini belum dihitung sebagai keuntungan.'
      : sellD === ''
      ? ''
      : `Keuntungan penjualan ini: <b>${fmtRp((Number(sellD) - Number(costD)) * r.qty)}</b> (${fmtNum(r.qty)} unit)`;
}
$('#formSale').addEventListener('input', updateSaleProfit);
$('#formSale').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const r = await api(
      `/api/history/${state.sale.id}/prices`,
      jsonOpts('PATCH', {
        sell_price: digitsOf(f.sell_price.value),
        cost_price: digitsOf(f.cost_price.value),
        apply_to_empty: f.apply_to_empty.checked,
      })
    );
    $('#dlgSale').close();
    await loadMargin();
    toast(r.also_updated ? `Harga diperbarui, ${r.also_updated} penjualan lain ikut terisi modalnya` : 'Harga diperbarui, keuntungan dihitung ulang');
  } catch (err) {
    $('#errSale').textContent = err.message;
  }
});

// ---------- Mulai ----------
(async function init() {
  try {
    state.user = await api('/api/me');
    document.body.dataset.role = state.user.role;
    $('#tabMargin').hidden = !isSuper();
    $('#whoami').textContent = `${state.user.username} (${roleLabel(state.user.role)})`;
    await Promise.all([loadCategories(), loadItems()]);
    route();
  } catch (err) {
    toast(err.message);
  }
})();
