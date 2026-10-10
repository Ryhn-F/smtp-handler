# DentisAI Mailer (penerima "Send Email Hook" Supabase)

Layanan kecil (Node.js + Express + Nodemailer) yang menerima permintaan dari **Supabase Auth**
setiap kali Supabase perlu mengirim email akun (konfirmasi pendaftaran, atur ulang kata sandi,
dst.), lalu mengirim email itu lewat SMTP milik kita. Alamatnya: `https://mailer.ryhnfir.dev`.

> Catatan penting: versi lama layanan ini adalah "formulir kontak" yang mengirim email ke
> kotak masuk pemilik dari endpoint publik tanpa autentikasi. Itu **sudah dihapus** (endpoint
> `/api/send-email` dan paket `cors`), karena bisa disalahgunakan sebagai pengirim spam.

## Cara kerja singkat

1. Pengguna mendaftar / lupa kata sandi di aplikasi.
2. Supabase memanggil `POST https://mailer.ryhnfir.dev/hooks/send-email` dengan data JSON dan
   **tanda tangan** (standar [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)).
3. Layanan ini memeriksa tanda tangan lebih dulu. Jika salah atau kedaluwarsa, ditolak (401).
4. Jika benar: membuat tautan `https://<proyek>.supabase.co/auth/v1/verify?token=...&type=...&redirect_to=...`,
   mengisi templat email Bahasa Indonesia (HTML + teks biasa), lalu mengirimnya **hanya ke alamat
   milik pengguna di payload** (bukan ke pemilik, bukan ke alamat lain).
5. Membalas `200 {}` bila sukses. Bila gagal, membalas kode non-200 dengan bentuk
   `{"error":{"http_code":503,"message":"..."}}`.

Isi email hanya tautan atau kode verifikasi. **Tidak ada data anak** dan tidak ada klaim kesehatan.

## Endpoint

| Endpoint | Fungsi |
|---|---|
| `POST /hooks/send-email` | Hook Supabase (butuh tanda tangan valid) |
| `GET /` | Cek hidup (teks biasa) |
| `GET /healthz` | `{"status":"ok","configured":true/false}`, tanpa rahasia |

## Variabel lingkungan (`.env` atau pengaturan hosting)

Jangan commit file `.env` (sudah ada di `.gitignore`).

| Variabel | Wajib | Keterangan |
|---|---|---|
| `SEND_EMAIL_HOOK_SECRET` | ya | Rahasia hook, format `v1,whsec_<base64>`. Tanpa ini layanan menjawab **503** (aman gagal-tutup). |
| `SUPABASE_URL` | ya | Mis. `https://abcd1234.supabase.co`. Dipakai membuat tautan verifikasi. Harus `https` (kecuali localhost). |
| `MAIL_FROM` | ya | Pengirim, mis. `DentisAI <no-reply@auth.ryhnfir.dev>`. |
| `SMTP_HOST` | ya | Mis. `smtp.resend.com`. |
| `SMTP_PORT` | tidak | Default `587`. Resend memakai `465`. |
| `SMTP_SECURE` | tidak | `true` untuk port 465. Bila kosong: otomatis `true` jika port 465. |
| `SMTP_USER` | ya | Mis. `resend`. |
| `SMTP_PASS` | ya | Kata sandi/API key SMTP. |
| `SMTP_REQUIRE_TLS` | tidak | Default `true` (wajib STARTTLS bila bukan port 465). Isi `false` hanya untuk relay lokal. |
| `ALLOWED_REDIRECT_PREFIXES` | disarankan | Daftar awalan alamat tujuan setelah verifikasi, dipisah koma. Mis. `https://app.ryhnfir.dev/auth/callback,dentisai://auth/callback`. Alamat di luar daftar dibuang dari tautan (Supabase memakai Site URL). Kosong = semua `redirect_to` dibuang. |
| `PORT` | tidak | Default `5000`. |
| `TRUST_PROXY` | tidak | Default `false`. Bila di belakang reverse proxy/Cloudflare/Nginx, isi jumlah proxy (mis. `1`) agar IP asli terbaca. Jangan isi `true` kecuali paham risikonya (IP bisa dipalsukan). |
| `RATE_LIMIT_EMAIL_PER_HOUR` | tidak | Default `5` email per alamat penerima per jam. |
| `RATE_LIMIT_IP_PER_HOUR` | tidak | Default `300` permintaan per IP per jam. |
| `RATE_LIMIT_WINDOW_MS` | tidak | Default `3600000` (1 jam). |
| `SMTP_CONNECTION_TIMEOUT_MS`, `SMTP_GREETING_TIMEOUT_MS`, `SMTP_SOCKET_TIMEOUT_MS`, `SMTP_SEND_DEADLINE_MS` | tidak | Default 3000 / 3000 / 4000 / 4200 ms. Supabase hanya memberi hook sekitar **5 detik**, jadi jangan dinaikkan banyak. |

Variabel lama `RECEIVER_EMAIL` **tidak dipakai lagi** dan boleh dihapus.

## Rahasia hook (`SEND_EMAIL_HOOK_SECRET`)

Ada dua cara; pilih satu dan pastikan nilainya **sama persis** di Supabase dan di server ini.

1. **Dibuat otomatis oleh Supabase.** Dashboard Supabase, Authentication, Hooks, Send Email,
   pilih HTTPS, isi URL `https://mailer.ryhnfir.dev/hooks/send-email`, lalu klik "Generate secret".
   Salin nilainya (berbentuk `v1,whsec_...`) ke `SEND_EMAIL_HOOK_SECRET` di server ini.
2. **Kita buat sendiri (rencana tim).** Orkestrator proyek membuat rahasia dan menaruhnya di
   `supabase/config.toml` sebagai `secrets = "env(SEND_EMAIL_HOOK_SECRET)"`; pemilik memasang
   **nilai yang sama** sebagai `SEND_EMAIL_HOOK_SECRET` di server ini. Untuk membuat rahasia:

   ```bash
   node scripts/make-test-webhook.js --gen-secret
   ```

   Hasilnya satu baris `v1,whsec_...`. Perlakukan seperti kata sandi: jangan dikirim lewat chat
   terbuka, jangan di-commit. Bila bocor, buat yang baru dan ganti di kedua tempat.

## Menjalankan

```bash
npm install
npm test            # 38 tes, tanpa internet dan tanpa SMTP asli
npm start           # membaca .env (dotenv), mendengarkan di PORT
```

Persyaratan: Node.js 20 atau lebih baru.

### Deploy / restart (oleh pemilik)

- Pasang/ubah variabel lingkungan di server, lalu **restart** proses (mis. `pm2 restart ...` atau
  restart service). Perubahan `.env` baru terbaca setelah restart.
- Pastikan `https://mailer.ryhnfir.dev` diteruskan (reverse proxy) ke `PORT` dengan TLS valid.
- Cek: `curl https://mailer.ryhnfir.dev/healthz` harus `{"status":"ok","configured":true}`.
  Jika `configured` bernilai `false`, ada variabel wajib yang belum diisi (nama variabel yang
  kurang tercatat di log saat start; nilai tidak pernah dicatat).

## Uji manual dengan curl

Server berjalan lokal dengan `SEND_EMAIL_HOOK_SECRET` yang sama, lalu:

```bash
# mencetak perintah curl berisi permintaan bertanda tangan (berlaku 5 menit)
node scripts/make-test-webhook.js --email alamat-anda@contoh.com --type signup

# atau langsung kirim ke server lokal
node scripts/make-test-webhook.js --email alamat-anda@contoh.com --send --url http://localhost:5000
```

Opsi: `--type signup|invite|magiclink|recovery|email_change|reauthentication`,
`--new-email`, `--secure` (email_change dengan dua token), `--redirect <url>`.
Hasil yang diharapkan: `200 {}` dan email masuk. **Jangan** memakai alamat orang lain.
Permintaan tanpa tanda tangan (`curl -X POST .../hooks/send-email -d '{}'`) harus dijawab 401.

## Mengaktifkan hook di Supabase (setelah server siap)

1. Server sudah jalan dan `healthz` menunjukkan `configured: true`.
2. Supabase, Authentication, Hooks, Send Email: aktifkan, pilih HTTPS, URL
   `https://mailer.ryhnfir.dev/hooks/send-email`, rahasia sama dengan server.
3. Daftarkan alamat tujuan verifikasi di Authentication, URL Configuration (Redirect URLs), dan
   samakan dengan `ALLOWED_REDIRECT_PREFIXES`.
4. Uji daftar akun dengan email sendiri dan pastikan email konfirmasi tiba.
5. Jika hook aktif, pengaturan SMTP bawaan Supabase tidak dipakai lagi untuk email Auth.

## Templat email

Folder `templates/`: satu berkas `.html` dan satu `.txt` untuk tiap jenis email. Placeholder:
`{{ConfirmationURL}}` dan `{{Token}}`. Nilai selalu di-escape (HTML) dan tidak diproses ulang.
Komentar HTML tidak ikut terkirim.

| Jenis | Templat | Subjek |
|---|---|---|
| signup | `confirmation` | Konfirmasi email akun DentisAI |
| recovery | `recovery` | Atur ulang kata sandi DentisAI |
| magiclink | `magic_link` | Masuk ke akun DentisAI |
| invite | `invite` (baru) | Undangan akun DentisAI |
| email_change (alamat baru) | `email_change` | Konfirmasi perubahan email DentisAI |
| email_change (alamat lama, bila "Secure email change" aktif) | `email_change_current` (baru) | Persetujuan perubahan email DentisAI |
| reauthentication | `reauthentication` (kode 6 digit, tanpa tautan) | Kode verifikasi DentisAI |

Templat `confirmation`, `recovery`, `email_change`, `magic_link`, `reauthentication` disalin dari
`backend/supabase/templates/` yang sudah ditinjau. Templat `invite` dan `email_change_current`
**baru dan belum ditinjau pemilik/drg**. Teks tidak memakai frasa terlarang
(`docs/style/forbidden_phrases.md`); ada tes yang memeriksanya.

## Catatan keamanan

- Tanda tangan diperiksa atas **body mentah** sebelum JSON dibaca: HMAC-SHA256 atas
  `webhook-id.webhook-timestamp.body`, perbandingan waktu-konstan, beberapa tanda tangan
  (dipisah spasi) diterima bila salah satu cocok, selisih waktu maksimum ±5 menit.
- Pesan `webhook-id` yang sudah berhasil diproses dan terulang dijawab 200 tanpa kirim ulang.
- Tanpa rahasia valid, layanan **gagal-tutup**: 503.
- Alamat penerima hanya dari payload bertanda tangan (`user.email`; untuk `email_change` juga
  `user.new_email`). Tidak ada alamat penerima dari env.
- Batas laju di memori (hilang saat restart, hanya untuk satu instance): per penerima dan per IP.
- Log hanya berisi id pesan, jenis aksi, status, jumlah, durasi, dan kode galat SMTP. **Tidak**
  pernah memuat email, token, tautan, atau isi body (dijaga oleh `src/logger.js` dan tes).
- Tidak ada CORS (komunikasi server ke server), batas body 64 KB, `x-powered-by` dimatikan.
- Tautan `redirect_to` divalidasi terhadap daftar putih (batas segmen jalur, bukan sekadar awalan
  teks) sebagai lapisan tambahan di atas daftar Redirect URLs Supabase.
- Tipe email di luar daftar (`email`, notifikasi perubahan, dll.) ditolak 400. Jangan aktifkan
  email notifikasi Supabase sebelum templatnya ditambahkan di sini.
- Jalankan `npm audit` berkala. Terakhir: 0 kerentanan (nodemailer dinaikkan ke 10.x).

## Yang belum terverifikasi: [PERLU VERIFIKASI]

- Dokumentasi Supabase (diperiksa 2026-10-10) menyatakan hook HTTPS harus selesai dalam sekitar
  5 detik, hanya status 429 dan 503 yang diulang (butuh header `Retry-After`), dan respons harus
  `application/json`. Status 400/403 dari hook dapat dilaporkan Supabase sebagai 500 kepada
  pengguna. Bentuk galat `{"error":{"http_code","message"}}` tercantum di contoh dokumentasi
  (Resend); untuk HTTPS hook, dokumentasi tidak menetapkan skema galat baku.
- Field `user.new_email` pada `email_change` tidak ada di skema payload yang didokumentasikan;
  kode mengandalkannya. Uji alur ganti email di proyek nyata sebelum diandalkan. Jika tidak ada,
  permintaan ditolak 400 (tidak mengirim ke alamat salah).
- Pemetaan token pada `email_change` mengikuti dokumentasi (alamat lama: `token_hash_new`;
  alamat baru: `token_hash`; nama field memang tertukar). Perlu diuji nyata.
- Panjang kode OTP: dokumentasi menyebut 6 digit; kode menerima 6 sampai 10 digit.
- Rahasia ganda untuk rotasi (dipisah `|`) disebut "direncanakan" oleh Supabase; belum didukung di sini.
- Format `webhook-id` dibatasi `[A-Za-z0-9_:-]`; bila Supabase memakai karakter lain, permintaan
  asli akan ditolak 401 (terlihat di log sebagai `reason:bad_headers`).
