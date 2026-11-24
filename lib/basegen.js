// Generator base project (ZIP) dengan tema custom, dibuat AI. Kode TIDAK dijalankan, hanya dicek sintaks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const S = require('../setting');
const { askText } = require('./uicopy');
const { parseBlocks } = require('./fixer');

const TYPES = {
  flutter: {
    label: '📱 Flutter App',
    need: ['pubspec.yaml', 'lib/main.dart'],
    spec: 'Aplikasi Flutter (Material 3, Dart null-safety, Flutter stable terbaru). Hanya package resmi Flutter SDK; boleh tambah `shared_preferences` dan `http` bila perlu, TANPA package lain. Tanpa font/aset eksternal (pakai Icons dan warna). Buat 3-5 layar contoh yang sesuai tema, navigasi (BottomNavigationBar/NavigationBar), dan ThemeData lengkap (colorScheme dari seed warna tema, light+dark). Sertakan pubspec.yaml (sdk: ">=3.3.0 <4.0.0"), lib/main.dart dan file lib/ lain, analysis_options.yaml. JANGAN buat folder android/ios/web (dibuat otomatis saat build).',
  },
  api: {
    label: '🌐 Node.js REST API',
    need: ['package.json', 'index.js'],
    spec: 'REST API Node.js (CommonJS, Express). Struktur rapi: index.js, routes/, controllers/ atau satu file per resource, middleware error handler, CORS, validasi input, .env.example, README.md singkat cara jalan. Data contoh disimpan di file JSON/memori (tanpa database eksternal). Endpoint CRUD sesuai tema + /health. package.json lengkap dengan "start" script dan dependensi yang benar-benar dipakai.',
  },
  bot: {
    label: '🤖 Bot Telegram (Node.js)',
    need: ['package.json', 'index.js'],
    spec: 'Bot Telegram Node.js memakai telegraf v4 (CommonJS). index.js, config.js (token dari process.env.BOT_TOKEN), folder commands/ atau handlers, menu inline keyboard, /start /help, fitur contoh sesuai tema, penyimpanan JSON sederhana. Sertakan .env.example, package.json (dengan "start"), README.md. Bot hanya untuk keperluan wajar (hiburan, toko, info, utilitas), bukan spam/phishing/penipuan.',
  },
  html: {
    label: '🧱 Web HTML/CSS/JS',
    need: ['index.html'],
    spec: 'Website/aplikasi web statis: index.html, style.css, script.js (tanpa framework/CDN, jalan offline). Responsif mobile-first, tema warna lewat CSS variables, beberapa section/halaman contoh sesuai tema. Cocok dibungkus menu HTML → APK (index.html di root).',
  },
};

const SYSTEM = `Kamu generator project starter ("base") berkualitas. Tulis project LENGKAP yang langsung jalan, tanpa placeholder/TODO kosong, tanpa komentar berlebihan.
Aturan keras:
- Output HANYA blok file, tiap file dengan format persis:
=== FILE: path/relatif ===
isi file
=== END ===
- Path relatif tanpa awalan folder project, tanpa "..", tanpa path absolut.
- Jangan sertakan rahasia/token asli. Jangan buat kode berbahaya, malware, phishing, spam, pencurian data, atau penipuan; kalau tema meminta itu, buat base yang aman versi biasa-nya saja.
- Setelah blok file, tulis satu baris "CATATAN:" berisi ringkasan 1-3 kalimat (bahasa Indonesia): cara menjalankan & fitur tema.`;

function safePath(p) {
  const n = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!n || n.startsWith('/') || n.split('/').includes('..') || /^[a-zA-Z]:/.test(n)) return null;
  return n;
}

function lint(files) {
  const errs = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
  try {
    for (const [f, c] of files) {
      if (/\.(js|cjs|mjs)$/i.test(f)) {
        const fp = path.join(tmp, path.basename(f) + '.' + Math.random().toString(36).slice(2) + path.extname(f));
        fs.writeFileSync(fp, c);
        const r = spawnSync(process.execPath, ['--check', fp], { encoding: 'utf8', timeout: 15000 });
        if (r.status !== 0) errs.push(`${f}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'syntax error'}`);
      } else if (/\.json$/i.test(f)) {
        try { JSON.parse(c); } catch (e) { errs.push(`${f}: JSON tidak valid (${e.message})`); }
      }
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return errs;
}

function check(type, files) {
  const errs = [];
  for (const n of TYPES[type].need) if (!files.has(n)) errs.push(`file wajib tidak ada: ${n}`);
  if (type === 'api' || type === 'bot') {
    const pj = files.get('package.json');
    try { if (pj && !JSON.parse(pj).dependencies) errs.push('package.json tanpa dependencies'); } catch {}
  }
  return errs.concat(lint(files));
}

async function run({ type, theme, onStep }) {
  const T = TYPES[type];
  if (!T) return { ok: false, msg: 'Jenis base tidak dikenal.' };
  const cfg = S.base || {};
  const maxFiles = cfg.maxFiles || 25, maxBytes = cfg.maxFileBytes || 60000;
  const step = (t) => onStep && onStep(t);
  const clean = String(theme || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
  if (clean.length < 3) return { ok: false, msg: 'Tema terlalu pendek. Jelaskan temanya, contoh: "toko kopi, warna coklat hangat".' };

  let prompt = `Jenis project: ${T.label}\nSpesifikasi: ${T.spec}\n\nTEMA/KUSTOM dari pengguna (terapkan pada nama, warna, teks, data contoh, fitur):\n"""${clean}"""`;
  let files = new Map(), notes = '', errs = [];
  for (let round = 1; round <= 2; round++) {
    step(round === 1 ? 'AI menulis project...' : 'Memperbaiki error yang terdeteksi...');
    const out = await askText(SYSTEM, round === 1 ? prompt : `${prompt}\n\nHasil sebelumnya punya masalah:\n${errs.join('\n')}\n\nTulis ULANG seluruh project (semua file) dengan masalah itu diperbaiki.`);
    const parsed = parseBlocks(out);
    files = new Map();
    for (const [k, v] of parsed.files) {
      const p = safePath(k);
      if (p && v.length <= maxBytes) files.set(p, v.replace(/\s+$/, '') + '\n');
    }
    notes = parsed.notes;
    if (files.size > maxFiles) return { ok: false, msg: `Hasil AI terlalu banyak file (${files.size}). Coba tema lebih sederhana.` };
    step('Mengecek hasil...');
    errs = check(type, files);
    if (!errs.length) break;
  }
  if (errs.length && files.size === 0) return { ok: false, msg: 'AI tidak menghasilkan file. Coba ulang dengan tema lain.' };

  const z = new AdmZip();
  for (const [f, c] of files) z.addFile(f, Buffer.from(c));
  const readme = `BASE ${T.label}\nTema: ${clean}\n\n${notes || ''}\n${errs.length ? `\nPERINGATAN (belum lolos pengecekan otomatis):\n${errs.join('\n')}\n` : ''}\nDibuat otomatis oleh AI: periksa kode sebelum dipakai di produksi.\n`;
  if (!files.has('README.md')) z.addFile('README.md', Buffer.from(readme));
  return { ok: true, zip: z.toBuffer(), files: [...files.keys()], notes, warnings: errs, label: T.label };
}

module.exports = { run, TYPES };
