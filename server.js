const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ======================================================================
// Database & migrasi (aman untuk database versi lama)
// ======================================================================
const db = new Database(path.join(DATA_DIR, 'stok.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Stok boleh minus, jadi tabel tidak memakai CHECK (stock >= 0)
const ITEMS_SQL = `
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    unit TEXT NOT NULL DEFAULT 'pcs',
    stock INTEGER NOT NULL DEFAULT 0,
    min_stock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    photo TEXT,
    has_sizes INTEGER NOT NULL DEFAULT 0,
    cost_price INTEGER
  )`;
const SIZES_SQL = `
  CREATE TABLE IF NOT EXISTS item_sizes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    label TEXT NOT NULL COLLATE NOCASE,
    stock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cost_price INTEGER,
    UNIQUE (item_id, label)
  )`;

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ${ITEMS_SQL};
  ${SIZES_SQL};
  CREATE TABLE IF NOT EXISTS stock_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    type TEXT NOT NULL CHECK (type IN ('initial','in','out','set')),
    change INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    note TEXT,
    photo TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    size_id INTEGER,
    size_label TEXT,
    updated_by TEXT,
    account TEXT,
    sell_price INTEGER,
    cost_price INTEGER,
    cancelled_at TEXT,
    cancelled_by TEXT
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','superadmin'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL
  );
`);

function addColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// Kolom yang ditambahkan di versi-versi sebelumnya (untuk database lama)
addColumn('items', 'photo', 'TEXT');
addColumn('items', 'has_sizes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('items', 'cost_price', 'INTEGER');
addColumn('item_sizes', 'cost_price', 'INTEGER');
addColumn('stock_history', 'size_id', 'INTEGER');
addColumn('stock_history', 'size_label', 'TEXT');
addColumn('stock_history', 'updated_by', 'TEXT');
addColumn('stock_history', 'account', 'TEXT');
addColumn('stock_history', 'sell_price', 'INTEGER');
addColumn('stock_history', 'cost_price', 'INTEGER');
addColumn('stock_history', 'cancelled_at', 'TEXT');
addColumn('stock_history', 'cancelled_by', 'TEXT');

// Database lama punya CHECK (stock >= 0): bangun ulang tabelnya satu kali agar stok bisa minus.
function dropStockCheck(table, createSql) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || !/CHECK\s*\(\s*stock\s*>=\s*0\s*\)/i.test(row.sql)) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(createSql.replace(`CREATE TABLE IF NOT EXISTS ${table}`, `CREATE TABLE ${table}_new`));
    const cols = db.prepare(`PRAGMA table_info(${table}_new)`).all().map((c) => c.name).join(', ');
    db.exec(`INSERT INTO ${table}_new (${cols}) SELECT ${cols} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
    db.exec('COMMIT');
    console.log(`Tabel ${table} diperbarui agar stok boleh minus.`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
dropStockCheck('items', ITEMS_SQL);
dropStockCheck('item_sizes', SIZES_SQL);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_items_category ON items(category_id);
  CREATE INDEX IF NOT EXISTS idx_history_item ON stock_history(item_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_sizes_item ON item_sizes(item_id);
  CREATE INDEX IF NOT EXISTS idx_history_type_time ON stock_history(type, created_at);
`);

// ======================================================================
// Akun & password
// ======================================================================
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Akun awal dibuat SEKALI saat belum ada. Password bisa diganti dari menu "Ganti password".
// Untuk produksi, sebaiknya isi lewat environment variable agar tidak tersimpan di kode.
const SEED_USERS = [
  ['admin', process.env.ADMIN_PASSWORD || 'test123', 'admin'],
  ['superadmin', process.env.SUPERADMIN_PASSWORD || 'test234', 'superadmin'],
];
for (const [username, password, role] of SEED_USERS) {
  if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?,?,?)').run(
      username,
      hashPassword(password),
      role
    );
    console.log(`Akun "${username}" (${role}) dibuat.`);
  }
}

// ======================================================================
// Session (cookie httpOnly)
// ======================================================================
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function cookieToken(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}
function setSessionCookie(res, value, maxAgeSec) {
  const parts = [`sid=${value}`, 'HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSec}`];
  if (process.env.COOKIE_SECURE === 'true') parts.push('Secure'); // aktifkan jika memakai HTTPS
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ======================================================================
// Upload foto
// ======================================================================
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new Error('Foto harus berformat JPG, PNG, atau WebP')),
});
const unlinkPhotos = (files) =>
  files.filter(Boolean).forEach((f) => fs.unlink(path.join(UPLOAD_DIR, path.basename(f)), () => {}));

// ======================================================================
// Helper umum
// ======================================================================
class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const toInt = (v) => (/^-?\d+$/.test(String(v).trim()) ? parseInt(v, 10) : NaN);
const blank = (v) => v === '' || v == null;
const validBy = (v) => {
  const s = clean(v);
  return s.length >= 2 && s.length <= 60 ? s : null;
};
const BY_ERROR = 'Nama pengupdate wajib diisi (2–60 karakter)';

// Uang (rupiah bulat). Kosong -> null, valid -> angka, tidak valid -> undefined
function parseMoney(v) {
  if (blank(v)) return null;
  const n = toInt(v);
  if (Number.isNaN(n) || n < 0 || n > 1e12) return undefined;
  return n;
}
const MONEY_ERROR = 'Harga harus berupa angka rupiah 0 atau lebih';

const isSuper = (req) => req.user.role === 'superadmin';

// Admin tidak boleh melihat harga modal maupun akun pengupdate
function redactItem(item, req) {
  if (!isSuper(req)) {
    delete item.cost_price;
    if (item.sizes) item.sizes.forEach((s) => delete s.cost_price);
  }
  return item;
}
function redactHistory(rows, req) {
  if (!isSuper(req)) rows.forEach((r) => { delete r.cost_at_sale; delete r.account; delete r.cancelled_by; });
  return rows;
}

const insHistory = db.prepare(`
  INSERT INTO stock_history
    (item_id, type, change, stock_after, note, photo, size_id, size_label, updated_by, account, sell_price, cost_price)
  VALUES
    (@item_id, @type, @change, @stock_after, @note, @photo, @size_id, @size_label, @updated_by, @account, @sell_price, @cost_price)`);
const logHistory = (o) =>
  insHistory.run({ note: null, photo: null, size_id: null, size_label: null, sell_price: null, cost_price: null, ...o });

const syncTotal = (itemId) =>
  db
    .prepare('UPDATE items SET stock = (SELECT COALESCE(SUM(stock),0) FROM item_sizes WHERE item_id = ?) WHERE id = ?')
    .run(itemId, itemId);

// ======================================================================
// App & middleware
// ======================================================================
const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '100kb' }));

// Debug: log each request path for troubleshooting "Cannot GET /"
app.use((req, res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

// Ensure the root path serves the login page directly (helps clients that
// request `/` to receive content instead of relying on middleware redirect)
// NOTE: root handling moved below session parsing so we can serve the
// main app (`index.html`) to authenticated users and the login page to guests.

// Baca session dari cookie
app.use((req, res, next) => {
  req.user = null;
  const token = cookieToken(req);
  if (token) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, s.token_hash
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256(token), Date.now());
    if (row) req.user = row;
  }
  next();
});

// Serve root according to authentication: index.html for logged-in users,
// login.html for unauthenticated clients. Placed after session parsing.
app.get('/', (req, res) => {
  if (req.user) return res.sendFile(path.join(__dirname, 'index.html'));
  return res.sendFile(path.join(__dirname, 'login.html'));
});

const requireAuth = (req, res, next) => (req.user ? next() : fail(res, 401, 'Silakan masuk terlebih dahulu'));
const requireSuper = (req, res, next) =>
  req.user.role === 'superadmin' ? next() : fail(res, 403, 'Hanya super admin yang dapat melakukan ini');

// ----- Login / logout -----
const attempts = new Map(); // ip -> { n, t }
app.post('/api/login', (req, res) => {
  const now = Date.now();
  const a = attempts.get(req.ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) Object.assign(a, { n: 0, t: now });
  if (a.n >= 10) return fail(res, 429, 'Terlalu banyak percobaan. Coba lagi dalam 15 menit');

  const username = clean(req.body.username);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    a.n++;
    attempts.set(req.ip, a);
    return fail(res, 401, 'Username atau password salah');
  }
  attempts.delete(req.ip);

  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)').run(
    sha256(token),
    user.id,
    now + SESSION_MS
  );
  setSessionCookie(res, token, SESSION_MS / 1000);
  res.json({ username: user.username, role: user.role });
});

app.post('/api/logout', (req, res) => {
  const token = cookieToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ username: req.user.username, role: req.user.role }));

// ----- Penjaga halaman: hanya halaman login yang publik -----
const PUBLIC_FILES = new Set(['/login.html', '/login.js', '/style.css']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || PUBLIC_FILES.has(req.path) || req.user) return next();
  if (req.path.startsWith('/uploads/')) return fail(res, 401, 'Silakan masuk terlebih dahulu');
  if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'))) return res.redirect('/login.html');
  return res.status(401).end();
});
app.use('/api', requireAuth);
app.use('/uploads', express.static(UPLOAD_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=86400') }));
// Serve static files from project root so login assets work when there's no `public/` folder.
app.use(express.static(__dirname));
// Explicit routes for login assets (and optional favicon)
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'login.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/favicon.ico', (req, res) => {
  const p = path.join(__dirname, 'favicon.ico');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.status(204).end();
});

// ----- Ganti password -----
app.post('/api/change-password', (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const next = typeof req.body.next === 'string' ? req.body.next : '';
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(current, user.password_hash)) return fail(res, 400, 'Password lama salah');
  if (next.length < 8) return fail(res, 400, 'Password baru minimal 8 karakter');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, req.user.token_hash);
  res.json({ ok: true });
});

// ======================================================================
// Kategori
// ======================================================================
app.get('/api/categories', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT c.id, c.name, COUNT(i.id) AS item_count
         FROM categories c LEFT JOIN items i ON i.category_id = c.id
         GROUP BY c.id ORDER BY c.name`
      )
      .all()
  );
});

app.post('/api/categories', (req, res) => {
  const name = clean(req.body.name);
  if (!name) return fail(res, 400, 'Nama kategori wajib diisi');
  if (name.length > 60) return fail(res, 400, 'Nama kategori maksimal 60 karakter');
  try {
    const info = db.prepare('INSERT INTO categories (name) VALUES (?)').run(name);
    res.status(201).json({ id: info.lastInsertRowid, name, item_count: 0 });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return fail(res, 409, 'Kategori sudah ada');
    throw e;
  }
});

app.delete('/api/categories/:id', (req, res) => {
  const id = toInt(req.params.id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM items WHERE category_id = ?').get(id).n;
  if (used > 0) return fail(res, 409, `Kategori masih dipakai oleh ${used} barang`);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ======================================================================
// Barang
// Status: "kurang" jika stok minus (total atau salah satu ukuran),
//         "menipis" jika stok <= batas minimum, selain itu "aman".
// ======================================================================
const STATUS_SQL = `(CASE
  WHEN i.stock < 0 OR EXISTS (SELECT 1 FROM item_sizes z WHERE z.item_id = i.id AND z.stock < 0) THEN 'kurang'
  WHEN i.stock <= i.min_stock THEN 'menipis'
  ELSE 'aman' END)`;
const STATUSES = ['aman', 'menipis', 'kurang'];

const ITEM_SELECT = `
  SELECT i.id, i.name, i.unit, i.stock, i.min_stock, i.photo, i.has_sizes, i.cost_price, i.created_at,
         i.category_id, c.name AS category_name, ${STATUS_SQL} AS status,
         (SELECT COUNT(*) FROM item_sizes s WHERE s.item_id = i.id) AS size_count
  FROM items i JOIN categories c ON c.id = i.category_id`;

function getItemFull(id) {
  const item = db.prepare(ITEM_SELECT + ' WHERE i.id = ?').get(id);
  if (!item) return null;
  item.sizes = db.prepare('SELECT id, label, stock, cost_price FROM item_sizes WHERE item_id = ? ORDER BY id').all(id);
  return item;
}
const sendItem = (req, res, id, status = 200) => res.status(status).json(redactItem(getItemFull(id), req));

// Ringkasan dashboard (tidak terpengaruh filter pencarian)
app.get('/api/summary', (req, res) => {
  res.json(
    db
      .prepare(
        `SELECT COUNT(*) AS items,
                COALESCE(SUM(CASE WHEN i.stock > 0 THEN i.stock ELSE 0 END), 0) AS units,
                COALESCE(SUM(${STATUS_SQL} = 'menipis'), 0) AS menipis,
                COALESCE(SUM(${STATUS_SQL} = 'kurang'), 0) AS kurang
         FROM items i`
      )
      .get()
  );
});

// Cari berdasarkan nama, kategori, dan status sekaligus
app.get('/api/items', (req, res) => {
  const q = clean(req.query.search);
  const cat = toInt(req.query.category_id);
  const status = clean(req.query.status);
  const where = [];
  const params = [];
  if (q) {
    where.push(`i.name LIKE ? ESCAPE '\\'`);
    params.push('%' + q.replace(/[\\%_]/g, '\\$&') + '%');
  }
  if (!Number.isNaN(cat)) {
    where.push('i.category_id = ?');
    params.push(cat);
  }
  if (status) {
    if (!STATUSES.includes(status)) return fail(res, 400, 'Status tidak valid');
    where.push(`${STATUS_SQL} = ?`);
    params.push(status);
  }
  const sql = ITEM_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY i.name COLLATE NOCASE';
  res.json(db.prepare(sql).all(...params).map((r) => redactItem(r, req)));
});

app.get('/api/items/:id', (req, res) => {
  const id = toInt(req.params.id);
  if (!getItemFull(id)) return fail(res, 404, 'Barang tidak ditemukan');
  sendItem(req, res, id);
});

// Tambah barang (multipart: foto opsional; sizes = JSON string opsional). Modal hanya diproses untuk super admin.
app.post('/api/items', upload.single('photo'), (req, res) => {
  const bad = (msg, code = 400) => {
    unlinkPhotos([req.file && req.file.filename]);
    return fail(res, code, msg);
  };
  const b = req.body;
  const name = clean(b.name);
  const unit = clean(b.unit) || 'pcs';
  const categoryId = toInt(b.category_id);
  const by = validBy(b.updated_by);
  const minStock = blank(b.min_stock) ? 0 : toInt(b.min_stock);
  const sup = isSuper(req);

  if (!name) return bad('Nama barang wajib diisi');
  if (name.length > 120) return bad('Nama barang maksimal 120 karakter');
  if (Number.isNaN(categoryId)) return bad('Kategori wajib dipilih');
  if (!by) return bad(BY_ERROR);
  if (Number.isNaN(minStock) || minStock < 0) return bad('Stok minimal harus angka 0 atau lebih');
  if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) return bad('Kategori tidak ditemukan');

  // Ukuran (opsional)
  let sizes = [];
  if (b.sizes) {
    try {
      sizes = JSON.parse(b.sizes);
    } catch {
      return bad('Data ukuran tidak valid');
    }
    if (!Array.isArray(sizes)) return bad('Data ukuran tidak valid');
  }
  if (sizes.length > 30) return bad('Maksimal 30 ukuran');
  const parsed = [];
  const seen = new Set();
  for (const s of sizes) {
    if (!s || typeof s !== 'object') return bad('Data ukuran tidak valid');
    const label = clean(s.label);
    const st = blank(s.stock) ? 0 : toInt(s.stock);
    const cost = sup ? parseMoney(s.cost_price) : null;
    if (!label) return bad('Nama ukuran tidak boleh kosong');
    if (label.length > 20) return bad(`Nama ukuran "${label}" terlalu panjang (maks. 20 karakter)`);
    if (Number.isNaN(st) || st < 0) return bad(`Stok ukuran "${label}" harus angka 0 atau lebih`);
    if (cost === undefined) return bad(`Modal ukuran "${label}": ${MONEY_ERROR}`);
    if (seen.has(label.toLowerCase())) return bad(`Ukuran "${label}" dobel`);
    seen.add(label.toLowerCase());
    parsed.push({ label, stock: st, cost });
  }

  const hasSizes = parsed.length > 0;
  let stock = 0;
  let itemCost = null;
  if (hasSizes) stock = parsed.reduce((sum, s) => sum + s.stock, 0);
  else {
    stock = blank(b.stock) ? 0 : toInt(b.stock);
    if (Number.isNaN(stock) || stock < 0) return bad('Stok awal harus angka 0 atau lebih');
    itemCost = sup ? parseMoney(b.cost_price) : null;
    if (itemCost === undefined) return bad(`Modal: ${MONEY_ERROR}`);
  }

  const create = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO items (name, category_id, unit, stock, min_stock, photo, has_sizes, cost_price) VALUES (?,?,?,?,?,?,?,?)'
      )
      .run(name, categoryId, unit, stock, minStock, req.file ? req.file.filename : null, hasSizes ? 1 : 0, itemCost);
    const itemId = info.lastInsertRowid;
    const base = { item_id: itemId, type: 'initial', note: 'Barang baru ditambahkan', updated_by: by, account: req.user.username };
    if (hasSizes) {
      for (const s of parsed) {
        const r = db
          .prepare('INSERT INTO item_sizes (item_id, label, stock, cost_price) VALUES (?,?,?,?)')
          .run(itemId, s.label, s.stock, s.cost);
        logHistory({ ...base, change: s.stock, stock_after: s.stock, size_id: r.lastInsertRowid, size_label: s.label });
      }
    } else {
      logHistory({ ...base, change: stock, stock_after: stock });
    }
    return itemId;
  });
  sendItem(req, res, create(), 201);
});

// Ubah nama dan/atau modal barang tanpa ukuran (hanya super admin).
// Modal di sini hanya berlaku untuk penjualan BERIKUTNYA. Penjualan lama tidak berubah.
app.patch('/api/items/:id', requireSuper, (req, res) => {
  const id = toInt(req.params.id);
  const item = db.prepare('SELECT id, has_sizes FROM items WHERE id = ?').get(id);
  if (!item) return fail(res, 404, 'Barang tidak ditemukan');
  const b = req.body;

  let name = null;
  if ('name' in b) {
    name = clean(b.name);
    if (!name) return fail(res, 400, 'Nama barang wajib diisi');
    if (name.length > 120) return fail(res, 400, 'Nama barang maksimal 120 karakter');
  }
  let setCost = false;
  let cost = null;
  if ('cost_price' in b) {
    if (item.has_sizes) return fail(res, 400, 'Barang ini memakai ukuran. Atur modal di tiap ukuran');
    cost = parseMoney(b.cost_price);
    if (cost === undefined) return fail(res, 400, MONEY_ERROR);
    setCost = true;
  }

  db.transaction(() => {
    if (name !== null) db.prepare('UPDATE items SET name = ? WHERE id = ?').run(name, id);
    if (setCost) db.prepare('UPDATE items SET cost_price = ? WHERE id = ?').run(cost, id);
  })();
  sendItem(req, res, id);
});

// Ubah stok minimal (admin dan super admin)
app.patch('/api/items/:id/min-stock', (req, res) => {
  const id = toInt(req.params.id);
  const min = toInt(req.body.min_stock);
  if (Number.isNaN(min) || min < 0 || min > 1e9) return fail(res, 400, 'Stok minimal harus angka 0 atau lebih');
  const info = db.prepare('UPDATE items SET min_stock = ? WHERE id = ?').run(min, id);
  if (!info.changes) return fail(res, 404, 'Barang tidak ditemukan');
  sendItem(req, res, id);
});

// Ubah modal satu ukuran (hanya super admin). Hanya berlaku untuk penjualan berikutnya.
app.patch('/api/items/:id/sizes/:sizeId', requireSuper, (req, res) => {
  const id = toInt(req.params.id);
  const sizeId = toInt(req.params.sizeId);
  const size = db.prepare('SELECT id FROM item_sizes WHERE id = ? AND item_id = ?').get(sizeId, id);
  if (!size) return fail(res, 404, 'Ukuran tidak ditemukan');
  const cost = parseMoney(req.body.cost_price);
  if (cost === undefined) return fail(res, 400, MONEY_ERROR);
  db.prepare('UPDATE item_sizes SET cost_price = ? WHERE id = ?').run(cost, sizeId);
  sendItem(req, res, id);
});

// Upload / ganti foto barang. Admin hanya boleh jika barang belum punya foto; super admin boleh mengganti.
app.post('/api/items/:id/photo', upload.single('photo'), (req, res) => {
  const bad = (msg, code = 400) => {
    unlinkPhotos([req.file && req.file.filename]);
    return fail(res, code, msg);
  };
  if (!req.file) return bad('Pilih foto terlebih dahulu');
  const id = toInt(req.params.id);
  const item = db.prepare('SELECT id, photo FROM items WHERE id = ?').get(id);
  if (!item) return bad('Barang tidak ditemukan', 404);
  if (item.photo && !isSuper(req)) return bad('Hanya super admin yang dapat mengganti foto yang sudah ada', 403);
  db.prepare('UPDATE items SET photo = ? WHERE id = ?').run(req.file.filename, id);
  unlinkPhotos([item.photo]);
  sendItem(req, res, id);
});

// Tambah ukuran ke barang yang sudah ada
app.post('/api/items/:id/sizes', (req, res) => {
  const id = toInt(req.params.id);
  const label = clean(req.body.label);
  const by = validBy(req.body.updated_by);
  const stock = blank(req.body.stock) ? 0 : toInt(req.body.stock);
  const givenCost = isSuper(req) ? parseMoney(req.body.cost_price) : null;
  if (!label) return fail(res, 400, 'Nama ukuran wajib diisi');
  if (label.length > 20) return fail(res, 400, 'Nama ukuran maksimal 20 karakter');
  if (!by) return fail(res, 400, BY_ERROR);
  if (Number.isNaN(stock) || stock < 0) return fail(res, 400, 'Stok harus angka 0 atau lebih');
  if (givenCost === undefined) return fail(res, 400, `Modal: ${MONEY_ERROR}`);

  const run = db.transaction(() => {
    const item = db.prepare('SELECT id, stock, has_sizes, cost_price FROM items WHERE id = ?').get(id);
    if (!item) return { code: 404, msg: 'Barang tidak ditemukan' };
    if (db.prepare('SELECT 1 FROM item_sizes WHERE item_id = ? AND label = ?').get(id, label))
      return { code: 409, msg: `Ukuran "${label}" sudah ada` };
    if (db.prepare('SELECT COUNT(*) AS n FROM item_sizes WHERE item_id = ?').get(id).n >= 30)
      return { code: 400, msg: 'Maksimal 30 ukuran' };

    // Barang yang tadinya tanpa ukuran: stok dan modal lamanya pindah ke ukuran pertama ini
    const carried = item.has_sizes ? 0 : item.stock;
    const cost = givenCost !== null ? givenCost : item.has_sizes ? null : item.cost_price;
    const total = carried + stock;
    const r = db
      .prepare('INSERT INTO item_sizes (item_id, label, stock, cost_price) VALUES (?,?,?,?)')
      .run(id, label, total, cost);
    if (!item.has_sizes) db.prepare('UPDATE items SET has_sizes = 1, cost_price = NULL WHERE id = ?').run(id);
    syncTotal(id);
    logHistory({
      item_id: id,
      type: 'initial',
      change: total,
      stock_after: total,
      note: carried ? `Ukuran baru ditambahkan (stok lama ${carried} dipindahkan ke ukuran ini)` : 'Ukuran baru ditambahkan',
      size_id: r.lastInsertRowid,
      size_label: label,
      updated_by: by,
      account: req.user.username,
    });
    return { ok: true };
  });
  const result = run();
  if (!result.ok) return fail(res, result.code, result.msg);
  sendItem(req, res, id, 201);
});

// Update stok. Nama pengupdate wajib; foto bukti opsional; size_id wajib jika barang berukuran;
// harga jual (per unit) wajib saat barang keluar. Stok boleh menjadi minus.
app.post('/api/items/:id/stock', upload.single('photo'), (req, res) => {
  const id = toInt(req.params.id);
  const type = clean(req.body.type);
  const qty = toInt(req.body.quantity);
  const sizeId = toInt(req.body.size_id);
  const by = validBy(req.body.updated_by);
  const note = clean(req.body.note).slice(0, 300);
  const bad = (msg, code = 400) => {
    unlinkPhotos([req.file && req.file.filename]);
    return fail(res, code, msg);
  };

  if (!by) return bad(BY_ERROR);
  if (!['in', 'out', 'set'].includes(type)) return bad('Jenis perubahan tidak valid');
  if (Number.isNaN(qty)) return bad('Jumlah harus berupa angka');
  if (type === 'set' ? qty < 0 : qty <= 0) return bad(type === 'set' ? 'Stok sebenarnya tidak boleh negatif' : 'Jumlah harus lebih dari 0');
  if (qty > 1e9) return bad('Jumlah terlalu besar');

  let sellPrice = null;
  if (type === 'out') {
    sellPrice = parseMoney(req.body.sell_price);
    if (sellPrice === null) return bad('Harga jual wajib diisi saat mengurangi stok');
    if (sellPrice === undefined) return bad(`Harga jual: ${MONEY_ERROR}`);
  }

  const run = db.transaction(() => {
    const item = db.prepare('SELECT id, stock, has_sizes, cost_price FROM items WHERE id = ?').get(id);
    if (!item) return { code: 404, msg: 'Barang tidak ditemukan' };

    let size = null;
    let current = item.stock;
    let costNow = item.cost_price;
    if (item.has_sizes) {
      if (Number.isNaN(sizeId)) return { code: 400, msg: 'Pilih ukuran yang akan diupdate' };
      size = db.prepare('SELECT id, label, stock, cost_price FROM item_sizes WHERE id = ? AND item_id = ?').get(sizeId, id);
      if (!size) return { code: 404, msg: 'Ukuran tidak ditemukan' };
      current = size.stock;
      costNow = size.cost_price;
    }

    const after = type === 'in' ? current + qty : type === 'out' ? current - qty : qty;

    if (size) {
      db.prepare('UPDATE item_sizes SET stock = ? WHERE id = ?').run(after, size.id);
      syncTotal(id);
    } else {
      db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(after, id);
    }
    logHistory({
      item_id: id,
      type,
      change: after - current,
      stock_after: after,
      note: note || null,
      photo: req.file ? req.file.filename : null,
      size_id: size ? size.id : null,
      size_label: size ? size.label : null,
      updated_by: by,
      account: req.user.username,
      sell_price: sellPrice,
      cost_price: type === 'out' ? costNow : null, // modal saat terjual disimpan; tidak ikut berubah saat modal barang diubah
    });
    return { ok: true };
  });

  const result = run();
  if (!result.ok) return bad(result.msg, result.code);
  sendItem(req, res, id);
});

// Hapus barang (hanya super admin)
app.delete('/api/items/:id', requireSuper, (req, res) => {
  const id = toInt(req.params.id);
  const item = db.prepare('SELECT id, photo FROM items WHERE id = ?').get(id);
  if (!item) return fail(res, 404, 'Barang tidak ditemukan');
  const photos = db
    .prepare('SELECT photo FROM stock_history WHERE item_id = ? AND photo IS NOT NULL')
    .all(id)
    .map((r) => r.photo);
  db.transaction(() => {
    db.prepare('DELETE FROM stock_history WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM item_sizes WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  })();
  unlinkPhotos([item.photo, ...photos]);
  res.json({ ok: true });
});

// ======================================================================
// Histori
// ======================================================================
const HISTORY_SELECT = `
  SELECT h.id, h.item_id, i.name AS item_name, i.unit, h.type, h.change, h.stock_after,
         h.size_label, h.note, h.photo, h.updated_by, h.account, h.sell_price,
         h.cost_price AS cost_at_sale, h.created_at, h.cancelled_at, h.cancelled_by
  FROM stock_history h JOIN items i ON i.id = h.item_id`;

app.get('/api/items/:id/history', (req, res) => {
  const rows = db.prepare(HISTORY_SELECT + ' WHERE h.item_id = ? ORDER BY h.id DESC LIMIT 500').all(toInt(req.params.id));
  res.json(redactHistory(rows, req));
});

app.get('/api/history', (req, res) => {
  const q = clean(req.query.search);
  const params = [];
  let where = '';
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
    where = ` WHERE (i.name LIKE ? ESCAPE '\\' OR h.updated_by LIKE ? ESCAPE '\\')`;
    params.push(like, like);
  }
  const rows = db.prepare(HISTORY_SELECT + where + ' ORDER BY h.id DESC LIMIT 300').all(...params);
  res.json(redactHistory(rows, req));
});

// Tambah / ganti foto bukti pada riwayat (admin dan super admin)
app.post('/api/history/:id/photo', upload.single('photo'), (req, res) => {
  const bad = (msg, code = 400) => {
    unlinkPhotos([req.file && req.file.filename]);
    return fail(res, code, msg);
  };
  if (!req.file) return bad('Pilih foto terlebih dahulu');
  const row = db.prepare('SELECT id, photo FROM stock_history WHERE id = ?').get(toInt(req.params.id));
  if (!row) return bad('Riwayat tidak ditemukan', 404);
  db.prepare('UPDATE stock_history SET photo = ? WHERE id = ?').run(req.file.filename, row.id);
  unlinkPhotos([row.photo]);
  res.json({ photo: req.file.filename });
});

function parseIds(body) {
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.map(toInt).filter((n) => !Number.isNaN(n)))] : [];
  if (!ids.length) throw new HttpError(400, 'Pilih riwayat terlebih dahulu');
  if (ids.length > 500) throw new HttpError(400, 'Maksimal 500 riwayat sekali proses');
  return ids;
}
const handle = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof HttpError) return fail(res, e.code, e.message);
    throw e;
  }
};

// HAPUS riwayat terpilih (hanya super admin). Stok TIDAK berubah.
// Penjualan yang dihapus ikut hilang dari margin karena catatannya tidak ada lagi.
app.post('/api/history/delete', requireSuper, handle((req, res) => {
  const ids = parseIds(req.body);
  const ph = ids.map(() => '?').join(',');
  const photos = db
    .prepare(`SELECT photo FROM stock_history WHERE id IN (${ph}) AND photo IS NOT NULL`)
    .all(...ids)
    .map((r) => r.photo);
  const info = db.prepare(`DELETE FROM stock_history WHERE id IN (${ph})`).run(...ids);
  unlinkPhotos(photos);
  res.json({ deleted: info.changes });
}));

// BATALKAN riwayat terpilih (hanya super admin).
// Stok dikembalikan seperti sebelum update (perubahan dibalik), dan jika itu penjualan maka tidak lagi
// dihitung di margin. Catatan tetap tampil dengan tanda "Dibatalkan".
app.post('/api/history/cancel', requireSuper, handle((req, res) => {
  const ids = parseIds(req.body);
  const run = db.transaction(() => {
    let cancelled = 0;
    let skipped = 0;
    for (const id of ids) {
      const h = db.prepare('SELECT * FROM stock_history WHERE id = ?').get(id);
      if (!h || h.cancelled_at || h.type === 'initial') {
        skipped++;
        continue;
      }
      if (h.size_id != null) {
        const ok = db.prepare('SELECT 1 FROM item_sizes WHERE id = ? AND item_id = ?').get(h.size_id, h.item_id);
        if (!ok) throw new HttpError(409, `Ukuran pada riwayat #${id} sudah tidak ada`);
        db.prepare('UPDATE item_sizes SET stock = stock - ? WHERE id = ?').run(h.change, h.size_id);
        syncTotal(h.item_id);
      } else {
        const item = db.prepare('SELECT has_sizes FROM items WHERE id = ?').get(h.item_id);
        if (item.has_sizes)
          throw new HttpError(409, `Riwayat #${id} dibuat sebelum barang memakai ukuran sehingga tidak bisa dibatalkan. Gunakan koreksi stok.`);
        db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?').run(h.change, h.item_id);
      }
      db.prepare('UPDATE stock_history SET cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ? WHERE id = ?').run(
        req.user.username,
        id
      );
      cancelled++;
    }
    if (!cancelled) throw new HttpError(400, 'Tidak ada riwayat yang bisa dibatalkan (sudah dibatalkan atau berupa stok awal)');
    return { cancelled, skipped };
  });
  res.json(run());
}));

// Ubah harga jual dan modal pada satu penjualan (hanya super admin, dari halaman Margin).
// Memperbarui riwayat dan menghitung ulang keuntungan penjualan tersebut.
app.patch('/api/history/:id/prices', requireSuper, (req, res) => {
  const id = toInt(req.params.id);
  const h = db.prepare('SELECT id, item_id, size_id, type, cancelled_at FROM stock_history WHERE id = ?').get(id);
  if (!h) return fail(res, 404, 'Riwayat tidak ditemukan');
  if (h.type !== 'out') return fail(res, 400, 'Hanya riwayat barang keluar yang memiliki harga jual');
  if (h.cancelled_at) return fail(res, 409, 'Riwayat ini sudah dibatalkan');
  const sell = parseMoney(req.body.sell_price);
  if (sell === null) return fail(res, 400, 'Harga jual wajib diisi');
  if (sell === undefined) return fail(res, 400, `Harga jual: ${MONEY_ERROR}`);
  const cost = parseMoney(req.body.cost_price);
  if (cost === undefined) return fail(res, 400, `Modal: ${MONEY_ERROR}`);

  let also = 0;
  db.transaction(() => {
    db.prepare('UPDATE stock_history SET sell_price = ?, cost_price = ? WHERE id = ?').run(sell, cost, id);
    // Opsional: isi juga penjualan lain barang/ukuran yang sama yang modalnya masih kosong
    if (req.body.apply_to_empty && cost !== null) {
      also = db
        .prepare(
          `UPDATE stock_history SET cost_price = ?
           WHERE item_id = ? AND size_id IS ? AND type = 'out' AND cost_price IS NULL
             AND cancelled_at IS NULL AND sell_price IS NOT NULL AND id <> ?`
        )
        .run(cost, h.item_id, h.size_id, id).changes;
    }
  })();
  res.json({ ok: true, also_updated: also });
});

// ======================================================================
// Margin (hanya super admin)
// keuntungan = (harga jual - modal saat terjual) x jumlah, hanya dari riwayat barang keluar
// yang tidak dibatalkan. Periode: day / month / year (memilih tanggal/bulan/tahun) atau all.
// ======================================================================
const BUCKET_FMT = { hour: '%Y-%m-%d %H:00', day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };
const ROWS_PAGE = 200;
const pad2 = (n) => String(n).padStart(2, '0');

function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

app.get('/api/margin', requireSuper, (req, res) => {
  const type = String(req.query.type || 'day');
  if (!['day', 'month', 'year', 'all'].includes(type)) return fail(res, 400, 'Periode tidak valid');
  let tzo = toInt(req.query.tzo);
  if (Number.isNaN(tzo) || tzo < -720 || tzo > 840) tzo = 0;
  const tzMod = `${tzo >= 0 ? '+' : '-'}${Math.abs(tzo)} minutes`;
  const offsetParam = toInt(req.query.offset);
  const offset = Number.isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
  const today = new Date(Date.now() + tzo * 60000).toISOString().slice(0, 10);

  let date = clean(req.query.date);
  let kind = 'month';
  let keys = [];
  let start = null;
  let end = null;

  if (type === 'day') {
    date = date || today;
    if (!validDay(date)) return fail(res, 400, 'Tanggal tidak valid');
    kind = 'hour';
    keys = Array.from({ length: 24 }, (_, h) => `${date} ${pad2(h)}:00`);
    start = date;
    end = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  } else if (type === 'month') {
    date = date || today.slice(0, 7);
    const m = /^(\d{4})-(\d{2})$/.exec(date);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return fail(res, 400, 'Bulan tidak valid');
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    kind = 'day';
    keys = Array.from({ length: days }, (_, i) => `${date}-${pad2(i + 1)}`);
    start = date;
    end = new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7);
  } else if (type === 'year') {
    date = date || today.slice(0, 4);
    if (!/^\d{4}$/.test(date) || Number(date) < 1900 || Number(date) > 2200) return fail(res, 400, 'Tahun tidak valid');
    kind = 'month';
    keys = Array.from({ length: 12 }, (_, i) => `${date}-${pad2(i + 1)}`);
    start = date;
    end = String(Number(date) + 1);
  } else {
    date = '';
  }

  const W = `h.type = 'out' AND h.sell_price IS NOT NULL AND h.cancelled_at IS NULL`;
  let filter = '1 = 1';
  let fparams = [];
  if (start !== null) {
    filter = `datetime(h.created_at, ?) >= ? AND datetime(h.created_at, ?) < ?`;
    fparams = [tzMod, start, tzMod, end];
  } else {
    // "Semua": grafik per bulan (maks. 36 bulan), selebihnya per tahun
    const mm = db
      .prepare(`SELECT MIN(datetime(h.created_at, ?)) AS a, MAX(datetime(h.created_at, ?)) AS b FROM stock_history h WHERE ${W}`)
      .get(tzMod, tzMod);
    if (mm.a) {
      const y1 = Number(mm.a.slice(0, 4));
      const m1 = Number(mm.a.slice(5, 7));
      const y2 = Number(mm.b.slice(0, 4));
      const m2 = Number(mm.b.slice(5, 7));
      const span = y2 * 12 + m2 - (y1 * 12 + m1) + 1;
      if (span <= 36) {
        kind = 'month';
        for (let i = 0; i < span; i++) keys.push(new Date(Date.UTC(y1, m1 - 1 + i, 1)).toISOString().slice(0, 7));
      } else {
        kind = 'year';
        for (let y = y1; y <= y2; y++) keys.push(String(y));
      }
    }
  }

  const FROM = `FROM stock_history h JOIN items i ON i.id = h.item_id WHERE ${W} AND ${filter}`;
  const QTY = '(-h.change)';
  const PROFIT = `CASE WHEN h.cost_price IS NOT NULL THEN (h.sell_price - h.cost_price) * ${QTY} END`;

  const summary = db
    .prepare(
      `SELECT COUNT(*) AS sales,
              COALESCE(SUM(${QTY}), 0) AS units,
              COALESCE(SUM(h.sell_price * ${QTY}), 0) AS revenue,
              COALESCE(SUM(CASE WHEN h.cost_price IS NOT NULL THEN h.cost_price * ${QTY} END), 0) AS cost,
              COALESCE(SUM(${PROFIT}), 0) AS profit,
              COALESCE(SUM(CASE WHEN h.cost_price IS NOT NULL THEN h.sell_price * ${QTY} END), 0) AS revenue_costed,
              COALESCE(SUM(h.cost_price IS NULL), 0) AS no_cost
       ${FROM}`
    )
    .get(...fparams);

  const seriesRows = db
    .prepare(
      `SELECT strftime('${BUCKET_FMT[kind]}', datetime(h.created_at, ?)) AS k,
              COALESCE(SUM(${PROFIT}), 0) AS profit,
              COALESCE(SUM(h.sell_price * ${QTY}), 0) AS revenue
       ${FROM} GROUP BY k ORDER BY k`
    )
    .all(tzMod, ...fparams);
  const byKey = new Map(seriesRows.map((r) => [r.k, r]));
  const series = keys.map((k) => ({ key: k, profit: byKey.get(k)?.profit || 0, revenue: byKey.get(k)?.revenue || 0 }));

  const byItem = db
    .prepare(
      `SELECT h.item_id, i.name AS item_name, h.size_label,
              SUM(${QTY}) AS units,
              SUM(h.sell_price * ${QTY}) AS revenue,
              SUM(${PROFIT}) AS profit,
              SUM(h.cost_price IS NULL) AS no_cost
       ${FROM} GROUP BY h.item_id, h.size_label ORDER BY revenue DESC LIMIT 300`
    )
    .all(...fparams);

  const rows = db
    .prepare(
      `SELECT h.id, h.created_at, h.item_id, i.name AS item_name, h.size_label, ${QTY} AS qty,
              h.sell_price, h.cost_price, h.updated_by, h.account, ${PROFIT} AS profit
       ${FROM} ORDER BY h.id DESC LIMIT ? OFFSET ?`
    )
    .all(...fparams, ROWS_PAGE, offset);

  res.json({ type, date, bucket: kind, summary, series, by_item: byItem, rows, page: ROWS_PAGE, offset });
});

// ======================================================================
// Error handler
// ======================================================================
app.use('/api', (req, res) => fail(res, 404, 'Endpoint tidak ditemukan'));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran foto maksimal 5 MB' : 'Gagal mengunggah foto');
  }
  if (err.message && err.message.startsWith('Foto harus')) return fail(res, 400, err.message);
  if (err.type === 'entity.parse.failed') return fail(res, 400, 'Format data tidak valid');
  console.error(err);
  fail(res, 500, 'Terjadi kesalahan pada server');
});

app.listen(PORT, () => console.log(`Timur Jaya berjalan di http://localhost:${PORT}`));
