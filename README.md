# Sekolah Siaga Panas

PWA mobile-first yang mengubah prakiraan suhu dan kelembapan menjadi satu tingkat
siaga panas yang bisa langsung ditindaklanjuti sekolah. Angka utama adalah
**puncak prakiraan selama jam sekolah**, bukan suhu saat aplikasi dibuka.

Puncak ditampilkan pada meter lima tingkat dengan kalimat waktu prakiraan yang
jelas. Antarmuka tersedia dalam Bahasa Indonesia (default), Basa Jawa, English,
dan 中文; pilihan bahasa disimpan sebagai `ssp.language`.

> **Penting:** ambang level masih sementara, belum dikalibrasi terhadap
> klimatologi setempat, dan bukan standar resmi. sWBGT di sini hanya memakai
> suhu dan kelembapan; pendekatan ini cenderung terlalu tinggi saat berawan,
> berangin, atau malam hari.

## Menjalankan secara lokal

Aplikasi tidak memiliki build step atau dependensi npm. Sajikan direktori ini
melalui HTTP:

```sh
python3 -m http.server 8000
```

Lalu buka <http://localhost:8000>. Jangan membuka `index.html` melalui `file://`;
service worker tidak akan bekerja dan geolocation membutuhkan secure context.
Browser menganggap `localhost` aman untuk pengembangan.

Untuk menguji dari ponsel melalui LAN, gunakan HTTPS. Salah satu cara:

1. Instal [mkcert](https://github.com/FiloSottile/mkcert).
2. Buat sertifikat untuk alamat IP/nama host mesin pengembangan.
3. Sajikan folder ini dengan server HTTPS dan pasang CA lokal mkcert pada
   perangkat uji.

## Alur data

- Lokasi dipilih sebagai kode desa/kelurahan (adm4) dan disimpan di
  `localStorage` sebagai `ssp.location`.
- Sumber utama adalah prakiraan BMKG melalui wrapper komunitas
  `bmkg-restapi.vercel.app`.
- Bila sumber utama gagal, respons rusak, atau mengembalikan HTTP 429, aplikasi
  beralih ke Open-Meteo jika koordinat lokasi sudah tersimpan.
- Bacaan terakhir disimpan sebagai `ssp.lastReading`. Data cache diberi tanda
  `DATA LAMA`; data berumur lebih dari 24 jam tidak menampilkan level.
- BMKG menyediakan slot 3-jam dan menghapus jam yang telah lewat. Open-Meteo
  menyediakan slot 1-jam. Aplikasi menampilkan slot asli tanpa interpolasi.
- Meter memilih nilai sWBGT tertinggi pada jam sekolah (07.00–16.59). Setelah
  jam sekolah berakhir, meter beralih ke puncak jam sekolah besok agar prakiraan
  malam tidak salah ditampilkan sebagai puncak panas sekolah hari ini.

Wrapper tersebut bukan layanan resmi BMKG dan memiliki batas bersama sekitar
30 permintaan per menit. Untuk produksi, deploy wrapper milik sendiri (misalnya
melalui Docker atau Vercel) agar batas pemakaian tidak dibagi dengan semua
pengguna layanan publik.

Alternatif yang lebih baik adalah memakai endpoint resmi:

```text
https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4={code}
```

Gunakan langsung hanya jika kebijakan CORS endpoint mengizinkannya dari origin
aplikasi. Jika tidak, panggil melalui proxy/backend milik sendiri. Setelah
berpindah endpoint, sesuaikan parser dan tetap validasi setiap field sebelum
menampilkannya.

## Verifikasi

Buat ulang ikon dan periksa ukurannya:

```sh
node tools/make-icons.mjs
sips -g pixelWidth -g pixelHeight icon-192.png icon-512.png apple-touch-icon.png
```

Checklist browser pada viewport 380 px:

1. Cari manual `Gubeng`, pilih hasil yang benar, lalu pastikan
   `ssp.location.adm4` bernilai `35.78.08.1001` dan `displayName` menyimpan
   `full_path`.
2. Muat ulang dan pastikan layar pengaturan dilewati.
3. Bandingkan nilai puncak dengan sWBGT maksimum dari JSON prakiraan mentah.
4. Blokir host BMKG dan pastikan badge Open-Meteo serta interval 1 jam muncul.
5. Uji offline: bacaan cache harus bertanda `DATA LAMA`. Ubah `fetchedAt` menjadi
   lebih dari 24 jam lalu pastikan level tidak ditampilkan.
6. Pastikan tidak ada error console. Ubah sementara path gambar logo bila perlu
   untuk memastikan mark pengganti tetap tampil saat aset gagal dimuat.

## Font dan aset

Archivo Narrow 400–700 disimpan lokal di `assets/fonts/` agar tipografi tetap
berfungsi offline. `tools/fetch-fonts.sh` mencatat sumber Google Fonts dan dapat
dipakai untuk mengunduh ulang file WOFF2. Font berlisensi SIL Open Font License
1.1.

Logo utama berada di `assets/logo/Sekolah Siaga Panas LOGO.png`. Bila aset ini
gagal dimuat, aplikasi menampilkan mark SVG inline dan lockup teks sehingga
header tidak pernah menjadi gambar rusak.

## Atribusi

- Data cuaca utama: [BMKG](https://www.bmkg.go.id/)
- Cadangan prakiraan: [Open-Meteo](https://open-meteo.com/)
- Reverse geocoding saat pengguna meminta lokasi perangkat:
  [BigDataCloud](https://www.bigdatacloud.com/)
- Kode wilayah Indonesia: Permendagri Nomor 72 Tahun 2019
