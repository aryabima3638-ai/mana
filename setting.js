// =====================================================
//  setting.js  -  PENGATURAN BOT
//  Semua nilai bisa juga diisi lewat Environment Variable panel
//  (BOT_TOKEN, GH_TOKEN, GH_REPO, API_ID, API_HASH)
// =====================================================
module.exports = {
  // ---- Bot ----
  botToken: process.env.BOT_TOKEN || 'ISI_TOKEN_BOT_DARI_BOTFATHER',

  // ---- MTProto (WAJIB kalau mau terima ZIP > 20MB sampai 2GB) ----
  // Ambil di https://my.telegram.org -> API development tools
  apiId: Number(process.env.API_ID || 0),
  apiHash: process.env.API_HASH || '',

  // ---- Logo / foto ----
  // Ditampilkan saat user berhasil join channel + di menu + di channel log
  photoUrl: 'https://telegra.ph/file/ganti-dengan-url-foto-kamu.jpg',

  // ---- Channel wajib follow ----
  // Bot HARUS jadi admin di channel ini (untuk cek member & kirim notif)
  channel: {
    id: '@namachannelkamu',               // @username channel atau -100xxxxxxxxxx
    link: 'https://t.me/namachannelkamu', // link tombol "Follow Channel"
  },
  // Channel tujuan notifikasi user baru / register (boleh sama dengan channel di atas)
  logChannel: '@namachannelkamu',

  // Grup tujuan notifikasi tiap build (mulai/sukses/gagal). Isi id grup (mis. -1001234567890) atau kosongkan = mati.
  // Bot harus jadi anggota/admin grup. sendResult:true = hasil APK/ZIP ikut dikirim ke grup (hanya file <50MB).
  buildGroup: { id: '', sendResult: false },

  // ---- GitHub ----
  github: {
    token: process.env.GH_TOKEN || 'ISI_GITHUB_TOKEN',   // scope: repo + workflow
    repo: process.env.GH_REPO || 'username/nama-repo',   // repo yang berisi .github/workflows
    branch: 'main',
    flutterWorkflow: 'build.yml',
    androidWorkflow: 'build-android.yml',
    htmlWorkflow: 'build-html.yml',
  },

  // ---- Batas & credit ----
  backup: { autoHours: 24 }, // backup otomatis ke owner (jam); 0 = mati
  limits: {
    maxZipBytes: 2 * 1024 * 1024 * 1024, // 2GB
    freeCredit: 5,                       // credit awal / maksimal isi ulang member
    refillHours: 24,                     // credit habis -> balik setelah 24 jam
    buildTimeoutMin: 60,                 // build lebih dari ini dianggap stuck -> dibatalkan
    pollSec: 5,                          // interval cek status GitHub
    maxConcurrent: 3,                    // build bersamaan maksimal (sisanya antri)
    downloadIdleSec: 90,
    retryFree: true, // ulang build setelah gagal (atas izin user) gratis; false = potong credit lagi                 // download tanpa data selama ini = stuck
  },

  // ---- AI untuk fitur Copy Tampilan ----
  // Pilih SALAH SATU provider AI (semua punya opsi GRATIS selain Claude):
  //  1) provider 'gemini'    : gratis, key dari https://aistudio.google.com/apikey, model 'gemini-3.7-flash'
  //  2) provider 'openai'    : OpenAI-compatible, cocok untuk layanan gratis seperti Groq / OpenRouter / Cerebras.
  //       Groq:       baseUrl 'https://api.groq.com/openai/v1'   (key dari console.groq.com, gratis)
  //       OpenRouter: baseUrl 'https://openrouter.ai/api/v1'     (pilih model berakhiran ":free")
  //       isi 'model' sesuai daftar model di dashboard layanan itu (nama model bisa berubah)
  //  3) provider 'anthropic' : Claude API, berbayar -> https://platform.claude.com/settings/keys
  ai: {
    provider: 'gemini',
    apiKey: process.env.AI_API_KEY || 'ISI_API_KEY_AI',
    model: 'gemini-3.7-flash', // anthropic: 'claude-sonnet-5-5' / 'claude-haiku-5-5'
    fallbackModels: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], // dicoba otomatis kalau model utama sibuk/overloaded
    baseUrl: '',               // hanya untuk provider 'openai' (lihat contoh di atas)
    maxTokens: 16000,
    timeoutSec: 300,
    maxConcurrent: 2,        // proses AI bersamaan
    cost: 1,                 // credit per proses (member). Reseller & owner gratis
    maxDartBytes: 60 * 1024, // ukuran maksimal file .dart
    maxImageBytes: 5 * 1024 * 1024,
  },

  // ---- Fitur Fix Base/API (khusus role VIP) ----
  // Tools: dailyLimit = batas pemakaian per user per hari (owner tanpa batas). tiktokApi = layanan pihak ketiga (bisa diganti kalau mati)
  tools: { tiktok: { dailyLimit: 20 }, tiktokApi: 'https://www.tikwm.com/api/' },

  // Penjaga GB: disk panel + kuota harian per user (GB, reset 00:00 WIB)
  gb: { quota: { member: 3, vip: 10, reseller: 20 }, minFreeGB: 1.5, maxTmpGB: 10, tmpMaxAgeMin: 60 },

  // Anti-Gagal: cek/pasang workflow otomatis sebelum build + pulihkan & ulang otomatis kalau workflow/runner bermasalah. false = mati.
  antiFail: true,

  // build.shrink: true = APK lebih kecil (R8, +30-60 dtk, otomatis fallback tanpa shrink kalau gagal); false = paling cepat
  build: { shrink: true },
  base: { dailyLimit: 10, maxFiles: 25, maxFileBytes: 60000 }, // fitur Buat Base ZIP (VIP/owner)
  fix: {
    dailyLimit: 10,                    // maks proses per VIP per hari (owner tanpa batas) -> menjaga biaya AI
    maxZipBytes: 15 * 1024 * 1024,     // ukuran ZIP maksimal
    maxFiles: 2000,
    maxUnzippedBytes: 60 * 1024 * 1024,
    defaultVipDays: 30,                // masa aktif VIP bawaan (bisa diubah owner: /setvipdays)
  },

  // ---- Urutan versi Flutter yang dicoba OTOMATIS oleh workflow ----
  // Mulai dari paling baru; kalau gagal karena versi tidak cocok, lanjut ke versi berikutnya.
  // value kosong = stable terbaru. Boleh wildcard seperti '3.35.x'. Makin banyak = makin kebal error (tapi worst-case makin lama)
  flutterChain: [
    { label: 'terbaru', value: '' },
    { label: '3.38.x', value: '3.38.x' },
    { label: '3.35.x', value: '3.35.x' },
    { label: '3.32.x', value: '3.32.x' },
    { label: '3.29.x', value: '3.29.x' },
    { label: '3.27.x', value: '3.27.x' },
    { label: '3.24.x', value: '3.24.x' },
    { label: '3.22.x', value: '3.22.x' },
    { label: '3.19.x', value: '3.19.x' },
    { label: '3.16.x', value: '3.16.x' },
    { label: '3.13.x', value: '3.13.x' },
    { label: '3.10.x', value: '3.10.x' },
    { label: '3.7.x', value: '3.7.x' },
    { label: '3.3.x', value: '3.3.x' },
    { label: '3.0.x', value: '3.0.x' },
  ],

  // ---- Teks ----
  texts: {
    maintenance: 'MAAF BOT SEDANG DITUTUP OLEH OWNER DIKARENAKAN ADA SEDIKIT MASALAH',
  },
};
