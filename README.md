# Timur Jaya – Monitoring Stok Barang (v4)

Backend Node.js (Express + SQLite), frontend HTML/CSS/JS tanpa build step.

## Akun awal

| Peran |
|---|
| Admin |
| Super admin |

Akun dibuat sekali saat server pertama kali jalan (password disimpan ter-hash). Ganti lewat tombol **Ganti password**.
Untuk deployment, isi password awal lewat environment variable `ADMIN_PASSWORD` dan `SUPERADMIN_PASSWORD`.

## Menjalankan

```bash
npm install
npm start
```

Buka http://localhost:3000.

## Hak akses

| Fitur | Admin | Super admin |
|---|---|---|
| Tambah barang, kategori, ukuran | ya (tanpa harga modal) | ya (bisa isi modal) |
| Update stok, foto bukti, ubah stok minimal | ya | ya |
| Upload foto barang yang belum punya foto | ya | ya |
| Ganti foto barang yang sudah ada, ganti nama barang | tidak | ya |
| Lihat dan ubah harga modal | tidak | ya |
| Halaman Margin, ubah harga jual dan modal penjualan | tidak | ya |
| Batalkan riwayat, hapus riwayat, hapus barang | tidak | ya |
| Kolom "Diupdate oleh" di riwayat | nama saja | nama + Admin / Super admin |

Pembatasan diterapkan di server: harga modal dan akun pengupdate tidak dikirim ke admin sama sekali.

## Stok dan status barang

- Stok boleh minus. Barang keluar melebihi stok tetap tersimpan, dan form menampilkan peringatan.
- Status barang:
  - **Barang kurang**: stok total minus, atau salah satu ukuran minus.
  - **Menipis**: stok 0 atau lebih, tetapi sama dengan atau di bawah stok minimal.
  - **Aman**: selain itu.
- Dashboard menampilkan jumlah jenis barang, total unit, barang menipis, dan barang kurang. Angkanya menghitung semua barang dan tidak terpengaruh filter pencarian. Kartu menipis dan barang kurang bisa diklik untuk memfilter.
- Pencarian dapat menggabungkan nama, kategori, dan status sekaligus.
- Koreksi stok ("isi stok sebenarnya") tetap tidak boleh negatif.

## Harga jual, modal, dan margin

- Saat stok dikurangi (barang keluar), harga jual per unit wajib diisi.
- Modal barang (atau tiap ukuran) diisi super admin di halaman detail barang. Modal saat barang terjual **disimpan pada penjualan itu**.
- Mengubah modal di halaman barang hanya berlaku untuk penjualan berikutnya. Keuntungan penjualan yang sudah tercatat tidak berubah.
- Harga jual dan modal sebuah penjualan diubah super admin lewat tombol **Edit** pada Rincian penjualan di halaman Margin. Perubahan ikut tampil di riwayat dan keuntungan dihitung ulang. Ada opsi untuk mengisi juga penjualan lain barang yang sama yang modalnya masih kosong.
- Keuntungan = (harga jual − modal) × jumlah, hanya dari riwayat barang keluar yang tidak dibatalkan.
- Periode margin: **Harian** (pilih tanggal, grafik per jam), **Bulanan** (pilih bulan, grafik per hari), **Tahunan** (pilih tahun, grafik per bulan), **Semua** (seluruh penjualan; grafik per bulan, atau per tahun jika lebih dari 36 bulan). Tombol ‹ › untuk pindah periode. Pengelompokan mengikuti zona waktu browser.
- Barang keluar yang dicatat sebelum fitur harga jual ada tidak punya harga jual, sehingga tidak masuk perhitungan margin.

## Batalkan dan hapus riwayat (super admin)

Centang satu atau beberapa riwayat di tab Riwayat atau halaman detail barang, lalu pilih tindakan. Keduanya meminta konfirmasi dengan rincian dampaknya.

| | Batalkan | Hapus |
|---|---|---|
| Stok | dikembalikan (perubahan riwayat itu dibalik) | tidak berubah |
| Penjualan di margin | dihapus dari perhitungan | hilang karena catatannya dihapus |
| Catatan di riwayat | tetap tampil, bertanda "Dibatalkan" | dihapus permanen |

Catatan: riwayat "Stok awal" tidak bisa dibatalkan (hanya dihapus). Kolom "Stok akhir" pada riwayat adalah angka saat update terjadi dan tidak dihitung ulang setelah ada pembatalan.

## Environment variable (opsional)

| Nama | Fungsi |
|---|---|
| `PORT` | Port server (default 3000) |
| `ADMIN_PASSWORD`, `SUPERADMIN_PASSWORD` | Password awal akun (hanya dipakai saat akun dibuat) |
| `COOKIE_SECURE=true` | Aktifkan jika situs diakses lewat HTTPS |
| `TRUST_PROXY=true` | Aktifkan jika berada di belakang reverse proxy |

## Update dari versi lama

1. Backup folder `data/` dan `uploads/`.
2. Hentikan server, timpa file dengan versi baru (jangan hapus `data/` dan `uploads/`).
3. `npm install` lalu `npm start`.

Pada start pertama, tabel barang dan ukuran dibangun ulang satu kali agar stok boleh minus. Data tidak hilang.

## Git

`.gitignore` mengecualikan `data/` (database), `uploads/` (foto), dan `.env`.
Commit dan push sekaligus: `npm run push -- "pesan commit"`.
