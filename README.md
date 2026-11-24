# Flutter Build Bot (Panel)

Bot Telegram: kirim ZIP project Flutter -> dibuild di GitHub Actions -> APK dikirim balik. Jalan di panel (Node.js), tanpa VPS.

## File
- `index.js` menu utama bot
- `telegram.js` ID owner (+ username owner)
- `setting.js` token bot, apiId/apiHash, foto, channel, GitHub, limit
- `lib/` db, github, mtproto, builder
- Workflow `build.yml` & `build-web.yml` dibuat OTOMATIS oleh bot di repo GitHub (lib/setup.js)

## Setup
1. Buat repo GitHub (private boleh). Tidak perlu upload yml: bot membuat/menimpa otomatis saat start, lewat tombol Setup GitHub Otomatis, atau `/setupgithub`.
2. Repo > Settings > Actions: aktifkan Actions. Buat token (classic) scope `repo` + `workflow`.
3. Isi `setting.js`: botToken, github.token, github.repo, channel, logChannel, photoUrl.
4. Isi `telegram.js`: ID Telegram owner.
5. Jadikan bot **admin** di channel (untuk cek follow & kirim notif).
6. ZIP > 20MB sampai 2GB: isi `apiId` & `apiHash` dari https://my.telegram.org. Tanpa ini, ZIP maks 20MB (atau kirim link direct).
7. Panel: upload semua file, Startup command `npm install && node index.js` (atau `npm start`), Node 18+.
   Pastikan disk panel >= 2x ukuran ZIP terbesar.

## Role & command
| Role | Akses |
|---|---|
| member | semua fitur build, 5 credit gratis, habis -> reset 24 jam |
| reseller | build unlimited, `/addcredit` |
| owner | semuanya + `/addreseller` (`/address`), `/addowner`, `/delreseller`, `/maintenance on\|off`, `/ban`, `/unban`, `/broadcast`, `/stats` |

`/addcredit ID [jumlah]` (default 5).

## Server (multi repo) - owner
- `/addserver owner/repo [nama]` tambah server (bot otomatis memasang workflow di repo itu; token GitHub harus punya akses ke repo tsb)
- `/delserver ID`, `/setcost ID credit` (biaya credit per build di server itu, berlaku untuk member)
- `/setharga credit|reseller teks` mengatur daftar harga yang tampil di menu Credit
- Panel Owner > Kelola Server: nyalakan/matikan server
Setelah user kirim ZIP, user memilih server (kalau hanya 1 server aktif, langsung jalan).

 Owner = ID di `telegram.js` + yang ditambah lewat `/addowner`.

## Copy Tampilan (gambar -> Dart)
Menu 🎨 Copy Tampilan: user kirim file `.dart`, gambar UI, dan teks prompt; bot memakai Claude API untuk menulis ulang file Dart agar tampilannya sama dengan gambar.
Provider AI bisa dipilih di `ai.provider`: `gemini` (gratis), `openai` (OpenAI-compatible: Groq/OpenRouter gratis, isi `ai.baseUrl` + `ai.model`), atau `anthropic` (Claude API, berbayar). Isi `ai.apiKey` atau env `AI_API_KEY`. Bisa ganti `ai.provider` ke `anthropic` (berbayar). Biaya credit diatur di `ai.cost`.

## 🛠 Fix Base/API (khusus VIP)
- Role **VIP** (bukan member/reseller; owner boleh). Harga & masa aktif diatur owner.
- User kirim ZIP project (Node.js / Python / PHP, tanpa pubspec.yaml) + opsional tempel log error → bot kirim `fixed_*.zip` + `FIX_REPORT.txt`.
- Bot TIDAK menjalankan kode user: hanya cek sintaks (`node --check`, `ast.parse`, `php -l`), cek require/import & dependensi, lalu AI memperbaiki. Bahasa lain (Go/Java/Ruby/TS) hanya via AI + log yang ditempel.
- Token/secret disamarkan sebelum dikirim ke AI. Batas harian: `fix.dailyLimit` di setting.js.
- Butuh API key AI (gratis via Gemini/Groq/OpenRouter, atau Claude API berbayar) di `setting.js` / env `AI_API_KEY`. Server opsional: `python3`, `php` untuk lint.
- Command owner: `/addvip ID [hari]`, `/delvip ID`, `/setvipdays N`, `/setharga vip Rp30.000`.

## 🧱 HTML → APK
Menu **HTML → APK**: kirim ZIP web, lalu NAMA app dan ICON (wajib),  (berisi `index.html`, boleh di dalam folder). Workflow `build-html.yml` (dibuat otomatis oleh Setup GitHub / `/buildyml`) membungkus web ke aplikasi Android WebView (tanpa Flutter/npm), APK ditandatangani otomatis dan dikirim ke user. Nama app diambil dari `<title>`. Biasanya selesai ±2-3 menit.

## 💾 Backup (owner)
`/backup` atau tombol di Panel Owner: ZIP **semua file** bot (kode + setting + data, tanpa node_modules). Otomatis tiap `backup.autoHours` jam. Restore data user: kirim ZIP backup dengan caption `/restore`.

## 🧬 Buat Base ZIP (VIP/owner)
Pilih jenis (Flutter App / Node.js API / Bot Telegram / Web HTML) lalu tulis tema bebas (mis. "toko kopi, warna coklat"). AI membuat project starter, bot mengecek sintaks (`node --check`, JSON) dan memperbaiki 1x otomatis, lalu mengirim ZIP. Batas harian: `base.dailyLimit` di setting.js. Base Flutter tanpa folder android/ otomatis dilengkapi saat build (`flutter create`).

## 🛡 Anti-Gagal (otomatis)
Sebelum tiap build bot memastikan workflow terbaru terpasang di repo (cache 10 menit). Kalau workflow tidak terbaca/nonaktif, bot memulihkannya (aktifkan Actions & workflow, pasang ulang) lalu mengulang build sekali. Runner mati di awal build juga diulang sekali. Download ZIP diulang sampai 3x. Matikan dengan `antiFail: false` di setting.js.

## 🐞 Lapor Bug/Error
Menu **🐞 Lapor Bug/Error** (juga tombol di pesan build gagal): user kirim teks/screenshot/log (maks 5 laporan/hari) → diteruskan ke owner dengan tombol **🐞 Bug** / **😶 Biarkan**. Keputusan owner otomatis diberitahukan ke user.

## 💾 Penjaga GB
- Disk panel: sebelum download bot cek sisa disk (`gb.minFreeGB`) dan total file sementara (`gb.maxTmpGB`); kalau penuh, build ditolak sopan & credit dikembalikan.
- Kuota harian per user (GB, reset 00:00 WIB): member/vip/reseller di `gb.quota`, bisa diubah owner: `/setquota member 5`. Owner tanpa batas.
- File sementara menganggur otomatis dibersihkan tiap 30 menit dan saat start. Owner: `/gb` (status), `/bersihkan`, tombol **💾 GB & Disk**.
- Menu fitur VIP (Fix Base/API, Buat Base ZIP) hanya tampil untuk VIP/owner.

## 📦 ZIP → APK Android (menggantikan Build Web)
Menu **ZIP → APK Android**: kirim ZIP project Android Studio (Java/Kotlin, ada `settings.gradle`; boleh di dalam folder). Workflow `build-android.yml` memilih Java sesuai versi Gradle project (8/11/17), membuat `gradlew` kalau hilang, memasang platform SDK yang dibutuhkan, build Release/Debug, lalu menandatangani APK release otomatis. Build Web (Flutter web) sudah dihapus; file `build-web.yml` lama di repo boleh dihapus manual.

## 🧰 Tools: TikTok Downloader
Menu **Tools → TikTok Downloader**: kirim link TikTok, bot mengirim video HD tanpa watermark (+ tombol audio MP3; slideshow foto didukung). Memakai layanan pihak ketiga (TikWM, `tools.tiktokApi` di setting.js, bisa diganti kalau mati). Batas `tools.tiktok.dailyLimit` per user per hari. Video >50MB dikirim sebagai link download langsung.

## 🎟 Kode Redeem (owner)
`/gencode credit [jumlah_kode] [maks_pemakai] [hari]` membuat kode (mis. `BLD-ABCD-EFGH`), `/listcode` melihat yang aktif, `/delcode KODE|semua` menghapus. User menukar lewat `/redeem KODE` atau Credit → 🎟 Redeem Kode. Satu user hanya bisa memakai satu kode sekali; 5x salah = diblokir 1 jam.
