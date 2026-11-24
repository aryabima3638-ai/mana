// =====================================================
//  index.js  -  MENU UTAMA BOT FLUTTER BUILD
// =====================================================
const { Telegraf, Markup } = require('telegraf');
const S = require('./setting');
const T = require('./telegram');
const fs = require('fs');
const path = require('path');
const db = require('./lib/db');
const mt = require('./lib/mtproto');
const builder = require('./lib/builder');
const setup = require('./lib/setup');
const uicopy = require('./lib/uicopy');
const fixer = require('./lib/fixer');
const basegen = require('./lib/basegen');
const gb = require('./lib/gb');
const tools = require('./lib/tools');
const { esc, sleep, fmtDur, fmtBytes } = require('./lib/util');

if (!S.botToken || S.botToken.startsWith('ISI_')) {
  console.error('❌ Isi botToken di setting.js (atau env BOT_TOKEN) dulu.');
  process.exit(1);
}

const bot = new Telegraf(S.botToken, { handlerTimeout: 60000 });
const btn = Markup.button;
const kb = (rows) => Markup.inlineKeyboard(rows);
const pending = new Map(); // uid -> { kind, mode, at }
const uiState = new Map(); // uid -> { dart, image, prompt, at, busy, msgId }
const baseState = new Map(); // uid -> { type, theme, busy, at }
const fixState = new Map(); // uid -> { file, note, at, busy, msgId }
const memberCache = new Map(); // uid -> { ok, at }
const lastHit = new Map();
let photoId = null;

const BADGE = { owner: '👑 OWNER', reseller: '🏪 RESELLER', vip: '💎 VIP', member: '👤 MEMBER' };
const creditEmptyText = () =>
  `CREDIT ANDA SUDAH HABIS!!! SILAHKAN BELI CREDIT/TUNGGU 1 HARI LAGI UNTUK MENDAPATKAN CREDIT ANDA KEMBALI\nOWNER : ${T.ownerUsername}`;
const denyReseller = '⚠️ <b>WARNING!</b>\nHanya role di atas member yang bisa memakai command ini!';
const denyOwner = '⚠️ <b>WARNING!</b>\nHanya role <b>OWNER</b> yang bisa memakai command ini!';

// ---------------- helper tampilan ----------------
async function sendPhotoMsg(chatId, caption, extra = {}) {
  try {
    const m = await bot.telegram.sendPhoto(chatId, photoId || S.photoUrl, { caption, parse_mode: 'HTML', ...extra });
    if (m.photo) photoId = m.photo[m.photo.length - 1].file_id;
    return m;
  } catch {
    return bot.telegram.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  }
}

async function show(ctx, text, keyboard) {
  const extra = { parse_mode: 'HTML', ...keyboard };
  const msg = ctx.callbackQuery?.message;
  if (msg?.photo && text.length <= 1000) {
    try { await ctx.editMessageCaption(text, extra); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  } else if (msg && !msg.photo) {
    try { await ctx.editMessageText(text, { ...extra, disable_web_page_preview: true }); return; } catch (e) {
      if (/not modified/i.test(e.description || e.message)) return;
    }
  }
  if (text.length <= 1000) await sendPhotoMsg(ctx.chat.id, text, keyboard);
  else await ctx.reply(text, { ...extra, disable_web_page_preview: true });
}

async function logChannel(text) {
  try { await sendPhotoMsg(S.logChannel, text); } catch (e) { console.error('[log channel]', e.description || e.message); }
}

const who = (u) => `${esc(u.name)}${u.username ? ' (@' + esc(u.username) + ')' : ''} • <code>${u.id}</code>`;

async function isMember(uid) {
  const c = memberCache.get(uid);
  if (c && Date.now() - c.at < 60000) return c.ok;
  let ok = false;
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, uid);
    ok = ['member', 'administrator', 'creator'].includes(m.status) || (m.status === 'restricted' && m.is_member);
  } catch (e) {
    console.error('[cek member]', e.description || e.message, '-> pastikan bot admin di channel');
  }
  memberCache.set(uid, { ok, at: Date.now() });
  return ok;
}

// ---------------- menu ----------------
function mainKb(uid) {
  const role = db.roleOf(uid);
  const rows = [
    [btn.callback('📦 ZIP → APK Android', 'b:android'), btn.callback('📱 Build Flutter', 'b:flutter')],
    [btn.callback('🧱 HTML → APK', 'b:html')],
    [btn.callback('👤 Profil', 'profile'), btn.callback('💳 Credit', 'credit')],
    [btn.callback('📜 Riwayat', 'history'), btn.callback('📊 Status Build', 'status')],
    [btn.callback('🎨 Copy Tampilan (Gambar → Dart)', 'ui')],
    [btn.callback('🧰 Tools', 'tools'), btn.callback('🐞 Lapor Bug/Error', 'bug')],
  ];
  if (role === 'vip' || role === 'owner') rows.push([btn.callback('🛠 Fix Base/API', 'fix'), btn.callback('🧬 Buat Base ZIP', 'base')]);
  if (role === 'reseller' || role === 'owner') rows.push([btn.callback('🏪 Panel Reseller', 'reseller')]);
  if (role === 'owner') rows.push([btn.callback('👑 Panel Owner', 'owner')]);
  rows.push([btn.callback('❓ Bantuan', 'help'), btn.url('📢 Channel', S.channel.link)]);
  return kb(rows);
}

const creditText = (u, role) => {
  if (db.isUnlimited(u.id)) return '♾ Unlimited';
  db.refill(u);
  if (u.credits > 0) return `${u.credits} credit`;
  const left = Math.max(0, u.emptyAt + S.limits.refillHours * 3600e3 - Date.now());
  return `0 (reset ${fmtDur(left)} lagi)`;
};

function mainText(u) {
  const role = db.roleOf(u.id);
  return `🤖 <b>FLUTTER BUILD BOT</b>\n━━━━━━━━━━━━━━\n👤 ${esc(u.name)}\n🆔 <code>${u.id}</code>\n🎖 Role: <b>${BADGE[role]}</b>\n💳 Credit: <b>${creditText(u, role)}</b>\n🛠 Bot: ${db.data.maintenance ? '🔴 Maintenance' : '🟢 Online'}\n━━━━━━━━━━━━━━\nPilih menu di bawah 👇`;
}

const showMain = (ctx) => show(ctx, mainText(db.data.users[ctx.from.id]), mainKb(ctx.from.id));

function joinScreen(ctx) {
  return show(ctx,
    `👋 Halo <b>${esc(ctx.from.first_name)}</b>!\n\n🤖 <b>FLUTTER BUILD BOT</b>\nBuild Flutter jadi APK langsung dari ZIP source (sampai 2GB).\n\n⚠️ Untuk memakai bot, kamu wajib:\n1️⃣ Follow channel dulu\n2️⃣ Tekan tombol <b>Verifikasi</b>`,
    kb([[btn.url('📢 Follow Channel', S.channel.link)], [btn.callback('✅ Verifikasi', 'verify')]]));
}

// ---------------- middleware ----------------
bot.catch((err, ctx) => console.error('[bot error]', ctx?.updateType, err.message));

bot.use(async (ctx, next) => {
  if (!ctx.from || ctx.chat?.type !== 'private') return; // hanya chat pribadi
  const { user, isNew } = db.ensure(ctx.from);
  if (isNew) {
    logChannel(`🆕 <b>USER BARU /START</b>\n━━━━━━━━━━━━━━\n👤 ${who(user)}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  if (user.banned && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery('🚫 Kamu diblokir.', { show_alert: true }).catch(() => {});
    return ctx.reply('🚫 Kamu diblokir dari bot ini.');
  }
  // anti spam
  const now = Date.now();
  if (now - (lastHit.get(ctx.from.id) || 0) < 500) {
    if (ctx.callbackQuery) ctx.answerCbQuery().catch(() => {});
    return;
  }
  lastHit.set(ctx.from.id, now);
  // maintenance (owner bebas)
  if (db.data.maintenance && !db.isOwner(ctx.from.id)) {
    if (ctx.callbackQuery) return ctx.answerCbQuery(S.texts.maintenance, { show_alert: true }).catch(() => {});
    return ctx.reply(`🚧 <b>${esc(S.texts.maintenance)}</b>`, { parse_mode: 'HTML' });
  }
  // wajib follow channel
  const free = ctx.callbackQuery?.data === 'verify' || ctx.message?.text?.startsWith('/start');
  if (!free && !db.isOwner(ctx.from.id) && !(await isMember(ctx.from.id))) {
    if (ctx.callbackQuery) ctx.answerCbQuery('Follow channel dulu!', { show_alert: true }).catch(() => {});
    return joinScreen(ctx);
  }
  return next();
});

// ---------------- start & verifikasi ----------------
bot.start(async (ctx) => {
  pending.delete(ctx.from.id);
  const u = db.data.users[ctx.from.id];
  if (db.isOwner(ctx.from.id) || (u.verified && (await isMember(ctx.from.id)))) return showMain(ctx);
  return joinScreen(ctx);
});

bot.action('verify', async (ctx) => {
  memberCache.delete(ctx.from.id);
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCbQuery('❌ Kamu belum follow channel! Follow dulu lalu tekan Verifikasi.', { show_alert: true });
  }
  await ctx.answerCbQuery('✅ Verifikasi berhasil!');
  const u = db.data.users[ctx.from.id];
  const first = !u.verified;
  u.verified = true; db.save();
  if (first) {
    logChannel(`✅ <b>USER BARU TERVERIFIKASI</b>\n━━━━━━━━━━━━━━\n👤 ${who(u)}\n🎖 Role: ${BADGE[db.roleOf(u.id)]}\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n👥 Total user: <b>${Object.keys(db.data.users).length}</b>`);
  }
  // logo + menu muncul setelah berhasil join
  try { await ctx.deleteMessage(); } catch {}
  await sendPhotoMsg(ctx.chat.id, `🎉 <b>Verifikasi berhasil!</b>\nSelamat datang, ${esc(u.name)}.\n\n` + mainText(u), mainKb(u.id));
});

bot.action('menu', async (ctx) => { await ctx.answerCbQuery(); pending.delete(ctx.from.id); if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id); if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id); ttState.delete(ctx.from.id); return showMain(ctx); });

// ---------------- menu build ----------------
const backBtn = [btn.callback('⬅️ Kembali', 'menu')];

function needCredit(ctx) {
  if (db.canBuild(ctx.from.id)) return false;
  show(ctx, `❌ <b>${esc(creditEmptyText())}</b>`, kb([backBtn]));
  return true;
}

function screenZip(ctx) {
  const p = pending.get(ctx.from.id);
  const big = mt.isReady() ? 'sampai 2GB' : 'maks 20MB (isi apiId/apiHash agar bisa 2GB)';
  return show(ctx,
    `📦 <b>${p.kind === 'android' ? `ZIP → APK ANDROID ${p.mode.toUpperCase()}` : p.kind === 'html' ? 'HTML → APK' : `BUILD FLUTTER ${p.mode.toUpperCase()}`}</b>\n\nKirim sekarang:\n• File <b>.ZIP</b> project ${p.kind === 'html' ? 'web (HTML/CSS/JS)' : p.kind === 'android' ? 'Android Studio (Gradle)' : 'Flutter'} (${big})\n• atau <b>link direct</b> ke ZIP (https://...)\n\n📌 ZIP harus berisi ${p.kind === 'android' ? '<code>settings.gradle</code> dan module app (boleh di dalam folder). Hasil: APK siap install.' : p.kind === 'html' ? '<code>index.html</code> (boleh di dalam folder). Setelah ZIP, bot minta <b>NAMA</b> dan <b>ICON</b> aplikasi (wajib). Hasil: APK siap install.' : '<code>pubspec.yaml</code>.'}\n💳 Biaya credit tergantung server.\n📨 <i>ZIP yang kamu kirim juga diteruskan ke owner bot, dan status build (nama, jenis, hasil) diumumkan di grup bot.</i>`,
    kb([[btn.callback('❌ Batal', 'menu')]]));
}

function askZip(ctx, kind, mode) {
  ttState.delete(ctx.from.id);
  if (!baseState.get(ctx.from.id)?.busy) baseState.delete(ctx.from.id);
  if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id);
  if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id);
  pending.set(ctx.from.id, { kind, mode, at: Date.now() });
  return screenZip(ctx);
}

bot.action('b:android', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return show(ctx, '📦 <b>ZIP → APK ANDROID</b>\nUntuk project Android Studio (Java/Kotlin, Gradle) bukan Flutter.\n\n🚀 <b>Release</b> - APK final, sudah ditandatangani\n🐞 <b>Debug</b> - build lebih cepat',
    kb([[btn.callback('🚀 Build Release', 'ba:release'), btn.callback('🐞 Build Debug', 'ba:debug')], backBtn]));
});
bot.action(/^ba:(release|debug)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (needCredit(ctx)) return;
  return askZip(ctx, 'android', ctx.match[1]);
});

bot.action('b:html', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return askZip(ctx, 'html', 'release');
});

bot.action('b:flutter', async (ctx) => {
  await ctx.answerCbQuery();
  if (builder.getJob(ctx.from.id)) return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (needCredit(ctx)) return;
  return show(ctx, '📱 <b>BUILD FLUTTER</b>\nPilih tipe build:\n\n🚀 <b>Release</b> - APK final, ukuran kecil\n🐞 <b>Debug</b> - APK debug, build lebih cepat',
    kb([[btn.callback('🚀 Build Release', 'bf:release'), btn.callback('🐞 Build Debug', 'bf:debug')], backBtn]));
});

bot.action(/^bf:(release|debug)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (needCredit(ctx)) return;
  return askZip(ctx, 'flutter', ctx.match[1]);
});

const serverLoad = (id) => builder.allJobs().filter((j) => j.server.id === id).length;

async function stage(ctx, src) {
  const p = pending.get(ctx.from.id);
  if (!p || Date.now() - p.at > 15 * 60e3) {
    pending.delete(ctx.from.id);
    return ctx.reply('⚠️ Pilih menu build dulu (Flutter / ZIP → APK Android / HTML → APK) baru kirim ZIP.');
  }
  if (!db.enabledServers().length) { pending.delete(ctx.from.id); return ctx.reply('❌ Belum ada server aktif. Hubungi owner ' + T.ownerUsername); }
  const pre = gb.precheck(ctx.from.id, src.type === 'tg' ? src.size || 0 : 0);
  if (!pre.ok) { pending.delete(ctx.from.id); return ctx.reply(`💾 ${pre.msg}`); }
  p.src = src; p.at = Date.now();
  if (p.kind === 'html' && !(p.appName && p.icon)) { p.appName = null; p.icon = null; return htmlAsk(ctx, p); }
  return pickServer(ctx);
}

function pickServer(ctx) {
  const list = db.enabledServers();
  if (list.length === 1) return startOn(ctx, list[0]);
  const rows = list.map((sv) => [btn.callback(`🖥 ${sv.label} • ${serverLoad(sv.id) ? '🟡 ' + serverLoad(sv.id) + ' aktif' : '🟢 kosong'} • 💳${sv.cost}`, `sv:${sv.id}`)]);
  rows.push([btn.callback('❌ Batal', 'menu')]);
  return show(ctx, '🖥 <b>PILIH SERVER</b>\n━━━━━━━━━━━━━━\nData diterima ✅\nPilih server untuk build.\n💳 = credit yang dipakai per build.', kb(rows));
}

// ---- HTML → APK: nama & icon wajib ----
const cleanName = (t) => String(t || '').replace(/[^A-Za-z0-9 _.\-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
function htmlAsk(ctx, p) {
  if (!p.appName) {
    p.step = 'name';
    return ctx.reply('✅ ZIP diterima.\n\n1️⃣ <b>Kirim NAMA aplikasi</b> (wajib).\nHuruf/angka/spasi, maks 30 karakter. Contoh: <code>Toko Saya</code>', { parse_mode: 'HTML', ...kb([[btn.callback('❌ Batal', 'menu')]]) });
  }
  p.step = 'icon';
  return ctx.reply(`✅ Nama: <b>${esc(p.appName)}</b>\n\n2️⃣ <b>Kirim ICON aplikasi</b> (wajib): foto/gambar PNG/JPG, sebaiknya persegi (512×512).\nKirim sebagai <b>file</b> kalau mau kualitas penuh.`, { parse_mode: 'HTML', ...kb([[btn.callback('❌ Batal', 'menu')]]) });
}
function isImg(b) {
  return b.length > 12 && ((b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) || (b[0] === 0xff && b[1] === 0xd8) || (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'));
}
// true kalau pesan ditangani alur HTML (nama/icon)
async function htmlAccept(ctx, kind) {
  const p = pending.get(ctx.from.id);
  if (!p || p.kind !== 'html' || !p.src || !p.step) return false;
  if (kind === 'text' && p.step === 'name') {
    const n = cleanName(ctx.message.text);
    if (n.length < 2) { await ctx.reply('❌ Nama tidak valid. Pakai huruf/angka/spasi (min 2, maks 30 karakter).'); return true; }
    p.appName = n; p.at = Date.now();
    await htmlAsk(ctx, p);
    return true;
  }
  if (p.step !== 'icon') return false;
  let fileId, size;
  if (kind === 'photo') { const ph = ctx.message.photo.slice(-1)[0]; fileId = ph.file_id; size = ph.file_size || 0; }
  else if (kind === 'doc') {
    const d = ctx.message.document;
    if (!/\.(png|jpe?g|webp)$/i.test(d.file_name || '') && !/^image\//.test(d.mime_type || '')) return false;
    fileId = d.file_id; size = d.file_size || 0;
  } else return false;
  if (size > 5 * 1024 * 1024) { await ctx.reply('❌ Icon terlalu besar (maks 5MB).'); return true; }
  try {
    const buf = await fetchBuf(fileId, 5 * 1024 * 1024);
    if (!isImg(buf)) { await ctx.reply('❌ File itu bukan gambar PNG/JPG/WEBP yang valid. Kirim ulang icon.'); return true; }
    p.icon = buf; p.step = null; p.at = Date.now();
  } catch (e) { await ctx.reply(`❌ Gagal membaca icon (${e.message}). Kirim ulang.`); return true; }
  await ctx.reply(`✅ Icon diterima.\n📱 Nama: <b>${esc(p.appName)}</b>`, { parse_mode: 'HTML' });
  await pickServer(ctx);
  return true;
}

async function startOn(ctx, sv) {
  const p = pending.get(ctx.from.id);
  if (!p?.src) return;
  if (!db.canBuild(ctx.from.id, sv.cost)) {
    const u = db.data.users[ctx.from.id];
    pending.delete(ctx.from.id);
    return ctx.reply(u.credits > 0 ? `❌ Credit kurang. Server ini butuh ${sv.cost} credit (saldo ${u.credits}).\nOWNER : ${T.ownerUsername}` : `❌ ${creditEmptyText()}`);
  }
  pending.delete(ctx.from.id);
  const r = await builder.start(bot, { uid: ctx.from.id, chatId: ctx.chat.id, kind: p.kind, mode: p.mode, src: p.src, html: p.kind === 'html' ? { name: p.appName, icon: p.icon } : null, server: sv, name: [ctx.from.first_name, ctx.from.username ? '@' + ctx.from.username : ''].filter(Boolean).join(' ') });
  if (!r.ok && r.reason === 'credit') return ctx.reply(`❌ ${creditEmptyText()}`);
  if (!r.ok && r.reason === 'busy') return ctx.reply('⚠️ Kamu masih punya build yang berjalan.');
}


bot.action(/^rt:(\w+)$/, async (ctx) => {
  if (db.data.maintenance && !db.isOwner(ctx.from.id)) return ctx.answerCbQuery(S.texts.maintenance, { show_alert: true });
  const r = await builder.acceptRetry(bot, ctx.from.id, ctx.chat.id, ctx.match[1]);
  if (!r.ok && r.reason === 'busy') return ctx.answerCbQuery('Kamu masih punya build berjalan.', { show_alert: true });
  if (!r.ok && r.reason === 'credit') return ctx.answerCbQuery('Credit tidak cukup.', { show_alert: true });
  if (!r.ok) return ctx.answerCbQuery('Tawaran ulang sudah kedaluwarsa. Kirim ZIP lagi.', { show_alert: true });
  await ctx.answerCbQuery('Build diulang...');
  try { await ctx.deleteMessage(); } catch {}
});
bot.action(/^rtn:(\w+)$/, async (ctx) => {
  builder.declineRetry(ctx.match[1]);
  await ctx.answerCbQuery('Oke, tidak diulang.');
  try { await ctx.deleteMessage(); } catch {}
});

bot.action(/^sv:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const sv = db.serverById(ctx.match[1]);
  if (!sv || !sv.enabled) return ctx.answerCbQuery('Server tidak tersedia.', { show_alert: true });
  if (!pending.get(ctx.from.id)?.src) return ctx.answerCbQuery('Sesi habis, kirim ZIP lagi.', { show_alert: true });
  try { await ctx.deleteMessage(); } catch {}
  return startOn(ctx, sv);
});

// ---------------- Copy Tampilan (gambar -> Dart) ----------------
const AI_OK = () => S.ai && S.ai.apiKey && !S.ai.apiKey.startsWith('ISI_');

async function fetchBuf(fileId, max) {
  const link = await bot.telegram.getFileLink(fileId);
  const res = await fetch(link.href, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error('terlalu besar');
  return buf;
}

function uiText(u) {
  const cost = !db.isUnlimited(u.uid) ? `${S.ai.cost} credit` : 'gratis';
  return `🎨 <b>COPY TAMPILAN</b>\n━━━━━━━━━━━━━━\n1️⃣ File Dart: ${u.dart ? '✅ ' + esc(u.dart.name) : '⬜ belum'}\n2️⃣ Gambar UI: ${u.image ? '✅ diterima' : '⬜ belum'}\n3️⃣ Prompt: ${u.prompt ? '✅ ' + esc(u.prompt.slice(0, 80)) : '⬜ (opsional, kirim teks)'}\n━━━━━━━━━━━━━━\nKirim <b>file .dart</b> (maks ${Math.round(S.ai.maxDartBytes / 1024)}KB), <b>gambar</b> tampilan yang mau ditiru (foto/PNG/JPG), dan <b>teks prompt</b>. Urutan bebas.\n💳 Biaya: ${cost}\n🔒 <i>File & gambar diproses oleh AI.</i>`;
}
const uiKb = (u) => kb([
  ...(u.dart && u.image ? [[btn.callback('🚀 Proses Sekarang', 'ui:go')]] : []),
  [btn.callback('🗑 Reset', 'ui:reset'), btn.callback('⬅️ Kembali', 'menu')],
]);

async function uiRefresh(ctx, u) {
  if (u.msgId) { try { await bot.telegram.deleteMessage(ctx.chat.id, u.msgId); } catch {} }
  const m = await ctx.reply(uiText(u), { parse_mode: 'HTML', ...uiKb(u) });
  u.msgId = m.message_id;
}

bot.action('ui', async (ctx) => {
  await ctx.answerCbQuery();
  if (!AI_OK()) return show(ctx, '🎨 <b>COPY TAMPILAN</b>\nFitur belum aktif: owner belum mengisi API key AI di setting.js.', kb([backBtn]));
  pending.delete(ctx.from.id);
  if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id);
  const u = { uid: ctx.from.id, dart: null, image: null, prompt: '', at: Date.now(), busy: false, msgId: null };
  uiState.set(ctx.from.id, u);
  try { await ctx.deleteMessage(); } catch {}
  return uiRefresh(ctx, u);
});

bot.action('ui:reset', async (ctx) => {
  await ctx.answerCbQuery('Direset');
  const old = uiState.get(ctx.from.id);
  if (old?.busy) return ctx.answerCbQuery('Sedang diproses, tunggu selesai.', { show_alert: true });
  const u = { uid: ctx.from.id, dart: null, image: null, prompt: '', at: Date.now(), busy: false, msgId: old?.msgId };
  uiState.set(ctx.from.id, u);
  return uiRefresh(ctx, u);
});

bot.action('ui:go', async (ctx) => {
  const uid = ctx.from.id;
  const u = uiState.get(uid);
  if (!u || !u.dart || !u.image) return ctx.answerCbQuery('Kirim file .dart dan gambarnya dulu.', { show_alert: true });
  if (u.busy) return ctx.answerCbQuery('Sedang diproses...', { show_alert: true });
  const cost = S.ai.cost;
  if (!db.canBuild(uid, cost) || !db.charge(uid, cost)) {
    await ctx.answerCbQuery();
    return ctx.reply(`❌ ${creditEmptyText()}`);
  }
  await ctx.answerCbQuery('Memproses...');
  u.busy = true;
  const wait = await ctx.reply('⏳ <b>AI sedang menyalin tampilan ke Dart...</b>\nBiasanya 30–120 detik.', { parse_mode: 'HTML' });
  (async () => {
    try {
      const r = await uicopy.generate({ name: u.dart.name, dart: u.dart.text, image: u.image, prompt: u.prompt });
      const base = u.dart.name.replace(/\.dart$/i, '');
      await bot.telegram.sendDocument(ctx.chat.id, { source: Buffer.from(r.code, 'utf8'), filename: `${base}_copy.dart` }, {
        caption: `✅ <b>Tampilan disalin ke Dart</b>\n${esc((r.notes || '').slice(0, 800))}\n\n⚠️ Cek dulu sebelum dipakai; AI bisa meleset di detail.`.slice(0, 1000),
        parse_mode: 'HTML',
      });
      uiState.delete(uid);
    } catch (e) {
      db.refund(uid, cost);
      u.busy = false;
      await bot.telegram.sendMessage(ctx.chat.id, `❌ <b>Gagal</b>\n${esc(e.message).slice(0, 500)}\n💳 Credit dikembalikan.`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      u.busy = false;
      bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    }
  })();
});

// return true kalau pesan ini ditangani fitur Copy Tampilan
async function uiAccept(ctx, kind) {
  const u = uiState.get(ctx.from.id);
  if (!u) return false;
  if (!u.busy && Date.now() - u.at > 30 * 60e3) { uiState.delete(ctx.from.id); return false; }
  if (u.busy) { await ctx.reply('⏳ Masih diproses, tunggu selesai.'); return true; }
  u.at = Date.now();
  try {
    if (kind === 'text') {
      u.prompt = ctx.message.text.trim().slice(0, 1500);
    } else if (kind === 'photo') {
      const ph = ctx.message.photo[ctx.message.photo.length - 1];
      const buf = await fetchBuf(ph.file_id, S.ai.maxImageBytes);
      u.image = { b64: buf.toString('base64'), mime: 'image/jpeg' };
    } else {
      const d = ctx.message.document;
      if (/\.dart$/i.test(d.file_name || '')) {
        if (d.file_size > S.ai.maxDartBytes) { await ctx.reply(`❌ File Dart ${fmtBytes(d.file_size)} terlalu besar (maks ${Math.round(S.ai.maxDartBytes / 1024)}KB). Pakai satu file layar saja.`); return true; }
        const buf = await fetchBuf(d.file_id, S.ai.maxDartBytes);
        u.dart = { name: d.file_name, text: buf.toString('utf8') };
      } else if (/^image\/(png|jpeg|webp|gif)$/i.test(d.mime_type || '')) {
        const buf = await fetchBuf(d.file_id, S.ai.maxImageBytes);
        u.image = { b64: buf.toString('base64'), mime: d.mime_type.toLowerCase() };
      } else {
        return false; // bukan .dart / gambar -> biarkan handler ZIP
      }
    }
  } catch (e) {
    await ctx.reply(`❌ Gagal membaca file/gambar (${e.message}). Maks gambar ${fmtBytes(S.ai.maxImageBytes)}.`);
    return true;
  }
  await uiRefresh(ctx, u);
  return true;
}

bot.on('photo', async (ctx) => {
  if (await bugAccept(ctx, 'photo')) return;
  if (await htmlAccept(ctx, 'photo')) return;
  if (!(await uiAccept(ctx, 'photo'))) return ctx.reply('⚠️ Buka menu 🎨 Copy Tampilan dulu untuk mengirim gambar.');
});

// ---------------- Fix Base/API (khusus VIP) ----------------
const canFix = (id) => ['vip', 'owner'].includes(db.roleOf(id));
const FIX_FILE = /\.(zip|js|cjs|mjs|py|php)$/i;

function fixText(u) {
  const role = db.roleOf(u.uid);
  const left = role === 'owner' ? '♾' : `${Math.max(0, S.fix.dailyLimit - (db.data.users[u.uid]?.fixDay === new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10) ? db.data.users[u.uid].fixCount || 0 : 0))}/${S.fix.dailyLimit}`;
  return `🛠 <b>FIX BASE / API</b>\n━━━━━━━━━━━━━━\n1️⃣ File: ${u.file ? '✅ ' + esc(u.file.name) + ' (' + fmtBytes(u.file.buf.length) + ')' : '⬜ kirim <b>ZIP project</b> (atau 1 file .js/.py/.php)'}\n2️⃣ Log error: ${u.note ? '✅ ' + u.note.length + ' karakter' : '⬜ (opsional) tempel teks error/log di chat'}\n━━━━━━━━━━━━━━\n✔ Node.js • Python • PHP (base bot WA/Telegram/Discord, REST API, dll)\n✔ Project tanpa pubspec.yaml (bukan Flutter) cocoknya di sini\n🎟 Sisa hari ini: <b>${left}</b>${role === 'vip' ? ` • 💎 VIP s/d ${new Date(db.data.users[u.uid].vipUntil).toLocaleDateString('id-ID')}` : ''}\n🔒 <i>Token umum disamarkan sebelum dikirim ke AI. Kode tidak pernah dijalankan oleh bot.</i>`;
}
const fixKb = (u) => kb([
  ...(u.file ? [[btn.callback('🚀 Proses Sekarang', 'fix:go')]] : []),
  [btn.callback('🗑 Reset', 'fix:reset'), btn.callback('⬅️ Kembali', 'menu')],
]);
async function fixRefresh(ctx, u) {
  if (u.msgId) { try { await bot.telegram.deleteMessage(ctx.chat.id, u.msgId); } catch {} }
  const m = await ctx.reply(fixText(u), { parse_mode: 'HTML', ...fixKb(u) });
  u.msgId = m.message_id;
}

bot.action('fix', async (ctx) => {
  await ctx.answerCbQuery();
  if (!canFix(ctx.from.id)) {
    return show(ctx, `🔒 <b>FIX BASE / API</b>\nFitur ini <b>khusus role VIP</b> (member & reseller tidak bisa).\n\nPerbaiki error project Node.js / Python / PHP otomatis: kirim ZIP-nya, bot cari error lalu kirim ZIP hasil perbaikan.\n\n💎 Harga VIP: <b>${esc(db.data.prices.vip)}</b> / ${db.data.vipDays} hari\nBeli: ${T.ownerUsername}`, kb([backBtn]));
  }
  if (!AI_OK()) return show(ctx, '🛠 <b>FIX BASE / API</b>\nFitur belum aktif: owner belum mengisi API key AI di setting.js.', kb([backBtn]));
  pending.delete(ctx.from.id);
  if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id);
  const u = { uid: ctx.from.id, file: null, note: '', at: Date.now(), busy: false, msgId: null };
  fixState.set(ctx.from.id, u);
  try { await ctx.deleteMessage(); } catch {}
  return fixRefresh(ctx, u);
});

bot.action('fix:reset', async (ctx) => {
  await ctx.answerCbQuery('Direset');
  const old = fixState.get(ctx.from.id);
  if (old?.busy) return ctx.answerCbQuery('Sedang diproses, tunggu selesai.', { show_alert: true });
  const u = { uid: ctx.from.id, file: null, note: '', at: Date.now(), busy: false, msgId: old?.msgId };
  fixState.set(ctx.from.id, u);
  return fixRefresh(ctx, u);
});

bot.action('fix:go', async (ctx) => {
  const uid = ctx.from.id;
  const u = fixState.get(uid);
  if (!canFix(uid)) return ctx.answerCbQuery('Masa VIP kamu sudah habis.', { show_alert: true });
  if (!u || !u.file) return ctx.answerCbQuery('Kirim ZIP/file project dulu.', { show_alert: true });
  if (u.busy) return ctx.answerCbQuery('Sedang diproses...', { show_alert: true });
  if (!db.fixTake(uid, S.fix.dailyLimit)) return ctx.answerCbQuery(`Batas harian ${S.fix.dailyLimit}x tercapai. Coba lagi besok.`, { show_alert: true });
  await ctx.answerCbQuery('Memproses...');
  u.busy = true;
  const wait = await ctx.reply('⏳ <b>Memperbaiki project...</b>', { parse_mode: 'HTML' });
  let lastEdit = 0;
  const onStep = (t) => {
    if (Date.now() - lastEdit < 1500) return;
    lastEdit = Date.now();
    bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `⏳ <b>Memperbaiki project...</b>\n${esc(t)}`, { parse_mode: 'HTML' }).catch(() => {});
  };
  (async () => {
    try {
      const r = await fixer.run({ name: u.file.name, buf: u.file.buf, note: u.note, onStep });
      if (!r.ok) {
        db.fixGive(uid);
        await bot.telegram.sendMessage(ctx.chat.id, `ℹ️ <b>Belum ada yang bisa diperbaiki</b>\n<pre>${esc(r.msg).slice(0, 3000)}</pre>\nKamu bisa tempel log error di chat lalu tekan 🚀 Proses lagi (jatah hari ini dikembalikan).`, { parse_mode: 'HTML' });
        return;
      }
      const base = u.file.name.replace(/\.[^.]+$/, '');
      await bot.telegram.sendDocument(ctx.chat.id, { source: r.zip, filename: `fixed_${base}.zip` }, {
        caption: `✅ <b>Selesai diperbaiki</b>\n${esc(r.report).slice(0, 850)}`.slice(0, 1000), parse_mode: 'HTML',
      });
      if (r.report.length > 850) await bot.telegram.sendMessage(ctx.chat.id, `<pre>${esc(r.report).slice(0, 3500)}</pre>`, { parse_mode: 'HTML' }).catch(() => {});
      fixState.delete(uid);
    } catch (e) {
      db.fixGive(uid);
      await bot.telegram.sendMessage(ctx.chat.id, `❌ <b>Gagal</b>\n${esc(e.message).slice(0, 500)}\n🎟 Jatah hari ini dikembalikan.`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      u.busy = false;
      bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    }
  })();
});

// true kalau pesan ditangani fitur Fix
async function fixAccept(ctx, kind) {
  const u = fixState.get(ctx.from.id);
  if (!u) return false;
  if (!u.busy && Date.now() - u.at > 30 * 60e3) { fixState.delete(ctx.from.id); return false; }
  if (!canFix(ctx.from.id)) { fixState.delete(ctx.from.id); return false; }
  if (u.busy) { await ctx.reply('⏳ Masih diproses, tunggu selesai.'); return true; }
  u.at = Date.now();
  if (kind === 'text') {
    const t = ctx.message.text.trim();
    u.note = (u.note ? u.note + '\n' : '') + t;
    u.note = u.note.slice(0, 6000);
  } else {
    const d = ctx.message.document;
    if (!FIX_FILE.test(d.file_name || '')) return false; // bukan file project -> biarkan handler lain
    if (d.file_size > S.fix.maxZipBytes) { await ctx.reply(`❌ File ${fmtBytes(d.file_size)} terlalu besar (maks ${fmtBytes(S.fix.maxZipBytes)}). Hapus node_modules / folder besar dari ZIP.`); return true; }
    try {
      const buf = await fetchBuf(d.file_id, S.fix.maxZipBytes);
      u.file = { name: d.file_name, buf };
    } catch (e) {
      await ctx.reply(`❌ Gagal membaca file (${e.message}).`);
      return true;
    }
  }
  await fixRefresh(ctx, u);
  return true;
}

// ---------------- Buat Base ZIP (VIP/owner) ----------------
const baseKb = () => kb([
  ...Object.entries(basegen.TYPES).map(([k, t]) => [btn.callback(t.label, `base:t:${k}`)]),
  [btn.callback('⬅️ Kembali', 'menu')],
]);
bot.action('base', async (ctx) => {
  await ctx.answerCbQuery();
  if (!canFix(ctx.from.id)) {
    return show(ctx, `🔒 <b>BUAT BASE ZIP</b>\nFitur ini <b>khusus role VIP</b> (member & reseller tidak bisa).\n\nBot membuat project starter (Flutter / API / Bot Telegram / Web) dengan <b>tema sesuai maumu</b>, langsung jadi ZIP.\n\n💎 Harga VIP: <b>${esc(db.data.prices.vip)}</b> / ${db.data.vipDays} hari\nBeli: ${T.ownerUsername}`, kb([backBtn]));
  }
  if (!AI_OK()) return show(ctx, '🧬 <b>BUAT BASE ZIP</b>\nFitur belum aktif: owner belum mengisi API key AI di setting.js.', kb([backBtn]));
  if (!baseState.get(ctx.from.id)?.busy) baseState.delete(ctx.from.id);
  return show(ctx, '🧬 <b>BUAT BASE ZIP</b>\n━━━━━━━━━━━━━━\nPilih jenis base:\n\n<i>Setelah itu kamu tulis TEMA-nya (bebas), contoh:\n"toko kopi, warna coklat hangat, ada keranjang"\n"aplikasi catatan gelap minimalis ala hacker"</i>', baseKb());
});
bot.action(/^base:t:(\w+)$/, async (ctx) => {
  if (!canFix(ctx.from.id)) return ctx.answerCbQuery('Khusus VIP/owner', { show_alert: true });
  const type = ctx.match[1];
  if (!basegen.TYPES[type]) return ctx.answerCbQuery('Jenis tidak dikenal');
  if (baseState.get(ctx.from.id)?.busy) return ctx.answerCbQuery('Sedang diproses...', { show_alert: true });
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  if (!uiState.get(ctx.from.id)?.busy) uiState.delete(ctx.from.id);
  if (!fixState.get(ctx.from.id)?.busy) fixState.delete(ctx.from.id);
  baseState.set(ctx.from.id, { type, busy: false, at: Date.now() });
  return show(ctx, `🧬 <b>${esc(basegen.TYPES[type].label)}</b>\n\n✍️ <b>Tulis TEMA / kustom</b> yang kamu mau (nama, warna, gaya, fitur).\nMaks 500 karakter.`, kb([[btn.callback('⬅️ Ganti Jenis', 'base')]]));
});
async function baseAccept(ctx) {
  const st = baseState.get(ctx.from.id);
  if (!st) return false;
  if (!canFix(ctx.from.id)) { baseState.delete(ctx.from.id); return false; }
  if (st.busy) { await ctx.reply('⏳ Masih diproses, tunggu selesai.'); return true; }
  if (Date.now() - st.at > 30 * 60e3) { baseState.delete(ctx.from.id); return false; }
  const theme = ctx.message.text.trim();
  if (theme.startsWith('/')) return false;
  const uid = ctx.from.id;
  if (!db.baseTake(uid, S.base.dailyLimit)) { await ctx.reply(`❌ Batas harian ${S.base.dailyLimit}x tercapai. Coba lagi besok.`); return true; }
  st.busy = true;
  const wait = await ctx.reply('⏳ <b>Membuat base...</b>', { parse_mode: 'HTML' });
  let last = 0;
  const onStep = (t) => {
    if (Date.now() - last < 1500) return;
    last = Date.now();
    bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, `⏳ <b>Membuat base...</b>\n${esc(t)}`, { parse_mode: 'HTML' }).catch(() => {});
  };
  (async () => {
    try {
      const r = await basegen.run({ type: st.type, theme, onStep });
      if (!r.ok) { db.baseGive(uid); await bot.telegram.sendMessage(ctx.chat.id, `ℹ️ ${esc(r.msg)}\n(jatah hari ini dikembalikan)`, { parse_mode: 'HTML' }); return; }
      const slug = theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'base';
      await bot.telegram.sendDocument(ctx.chat.id, { source: r.zip, filename: `base-${st.type}-${slug}.zip` }, {
        caption: `✅ <b>Base ${esc(r.label)} jadi</b>\n🎨 Tema: ${esc(theme.slice(0, 120))}\n📄 ${r.files.length} file${r.warnings.length ? `\n⚠️ ${r.warnings.length} peringatan (lihat README.md di ZIP)` : ''}\n${esc((r.notes || '').slice(0, 450))}`.slice(0, 1000),
        parse_mode: 'HTML',
      });
      baseState.delete(uid);
    } catch (e) {
      db.baseGive(uid);
      await bot.telegram.sendMessage(ctx.chat.id, `❌ <b>Gagal</b>\n${esc(e.message).slice(0, 500)}\n🎟 Jatah hari ini dikembalikan.`, { parse_mode: 'HTML' }).catch(() => {});
    } finally {
      st.busy = false;
      bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
    }
  })();
  return true;
}

// ---------------- Lapor Bug/Error ----------------
const bugState = new Map(); // uid -> { at }
const ownerIdList = () => [...new Set([...T.ownerIds.map(Number), ...Object.values(db.data.users).filter((u) => u.role === 'owner').map((u) => u.id)])];
const BUG_DAILY = 5;
bot.action('bug', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  bugState.set(ctx.from.id, { at: Date.now() });
  return ctx.reply('🐞 <b>LAPOR BUG / ERROR</b>\n━━━━━━━━━━━━━━\nTulis masalahnya sekarang (bisa kirim <b>teks</b>, <b>screenshot</b>, atau <b>file log</b>). Jelaskan: apa yang kamu lakukan dan apa error-nya.\n\n📨 <i>Laporan diteruskan ke owner bot beserta ID Telegram & riwayat build terakhirmu.</i>', { parse_mode: 'HTML', ...kb([[btn.callback('❌ Batal', 'bugx')]]) });
});
bot.action('bugx', async (ctx) => {
  bugState.delete(ctx.from.id);
  await ctx.answerCbQuery('Dibatalkan');
  try { await ctx.deleteMessage(); } catch {}
});
async function bugAccept(ctx, kind) {
  const st = bugState.get(ctx.from.id);
  if (!st) return false;
  if (Date.now() - st.at > 20 * 60e3) { bugState.delete(ctx.from.id); return false; }
  const m = ctx.message;
  let text = '';
  if (kind === 'text') { text = m.text.trim(); if (text.startsWith('/')) return false; }
  else text = (m.caption || '').trim();
  if (kind === 'doc' && (m.document.file_size || 0) > 20 * 1024 * 1024) { await ctx.reply('❌ File terlalu besar (maks 20MB).'); return true; }
  const uid = ctx.from.id;
  const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const u = db.stub(uid);
  if (u.bugDay !== today) { u.bugDay = today; u.bugCount = 0; }
  if (u.bugCount >= BUG_DAILY) { bugState.delete(uid); await ctx.reply(`❌ Batas ${BUG_DAILY} laporan per hari tercapai.`); return true; }
  u.bugCount++;
  bugState.delete(uid);
  const last = [...db.data.history].reverse().find((h) => h.uid === uid);
  const rep = { id: db.data.nextReportId++, uid, name: who(db.data.users[uid] || { id: uid }), text: text.slice(0, 1500), media: kind === 'text' ? null : kind, status: 'baru', at: Date.now(), last: last ? `${last.tag} • ${last.kind} • ${last.status}` : '-', msgs: [] };
  db.data.reports.push(rep);
  if (db.data.reports.length > 500) db.data.reports.shift();
  db.save();
  const head = `🐞 <b>LAPORAN #${rep.id}</b>\n👤 ${rep.name} • <code>${uid}</code>\n🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}\n🧾 Build terakhir: <code>${esc(rep.last)}</code>\n\n${esc(rep.text || (kind === 'text' ? '' : '(lampiran saja)'))}`;
  const markup = kb([[btn.callback('🐞 Bug', `bg:ok:${rep.id}`), btn.callback('😶 Biarkan', `bg:ig:${rep.id}`)]]);
  for (const oid of ownerIdList()) {
    try {
      if (kind === 'text') { const r = await bot.telegram.sendMessage(oid, head.slice(0, 3900), { parse_mode: 'HTML', ...markup }); rep.msgs.push([oid, r.message_id]); }
      else { const r = await bot.telegram.copyMessage(oid, ctx.chat.id, m.message_id, { caption: head.slice(0, 1000), parse_mode: 'HTML', ...markup }); rep.msgs.push([oid, r.message_id]); }
    } catch (e) { console.error('[bug->owner]', oid, e.description || e.message); }
  }
  db.save();
  await ctx.reply(`✅ Laporan <b>#${rep.id}</b> terkirim ke owner. Kamu akan diberi kabar setelah ditinjau.`, { parse_mode: 'HTML' });
  return true;
}
bot.action(/^bg:(ok|ig):(\d+)$/, async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const rep = db.data.reports.find((r) => r.id === Number(ctx.match[2]));
  if (!rep) return ctx.answerCbQuery('Laporan tidak ditemukan.', { show_alert: true });
  if (rep.status !== 'baru') return ctx.answerCbQuery(`Sudah diputuskan: ${rep.status}`, { show_alert: true });
  const bug = ctx.match[1] === 'ok';
  rep.status = bug ? 'bug' : 'dibiarkan'; rep.by = ctx.from.id; rep.decidedAt = Date.now();
  db.save();
  await ctx.answerCbQuery(bug ? 'Ditandai sebagai BUG' : 'Dibiarkan');
  for (const [cid, mid] of rep.msgs || []) {
    bot.telegram.editMessageReplyMarkup(cid, mid, undefined, { inline_keyboard: [[{ text: bug ? '🐞 Ditandai BUG' : '😶 Dibiarkan', callback_data: 'noop' }]] }).catch(() => {});
  }
  notify(rep.uid, bug
    ? `🐞 Laporan <b>#${rep.id}</b> kamu diterima sebagai <b>BUG</b>. Owner akan memperbaikinya. Terima kasih sudah melapor!`
    : `😶 Laporan <b>#${rep.id}</b> sudah ditinjau owner dan <b>tidak ditindaklanjuti</b> (bukan bug / tidak bisa diperbaiki saat ini).\nKalau menurutmu ini penting, kirim laporan baru dengan detail lebih lengkap.`);
});
bot.action('noop', (ctx) => ctx.answerCbQuery());

// ---------------- Tools: TikTok Downloader ----------------
const ttState = new Map(); // uid -> { at, busy }
const ttCache = new Map(); // key -> { music, at }
bot.action('tools', async (ctx) => {
  await ctx.answerCbQuery();
  ttState.delete(ctx.from.id);
  return show(ctx, '🧰 <b>TOOLS</b>\n━━━━━━━━━━━━━━\nPilih alat:', kb([[btn.callback('🎵 TikTok Downloader (HD, tanpa logo)', 'tt')], backBtn]));
});
bot.action('tt', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  ttState.set(ctx.from.id, { at: Date.now(), busy: false });
  return show(ctx, '🎵 <b>TIKTOK DOWNLOADER</b>\n━━━━━━━━━━━━━━\nKirim <b>link video TikTok</b> (tiktok.com / vt.tiktok.com / vm.tiktok.com).\n\n✔ Video HD tanpa watermark/logo\n✔ Bisa ambil audio MP3-nya\n✔ Foto slideshow juga didukung\n\n<i>Unduh hanya video milikmu atau yang kreatornya mengizinkan, dan hormati hak cipta. Proses memakai layanan pihak ketiga, jadi sesekali bisa gagal.</i>', kb([[btn.callback('⬅️ Tools', 'tools')]]));
});
async function ttAccept(ctx) {
  const uid = ctx.from.id;
  const st = ttState.get(uid);
  if (!st) return false;
  if (Date.now() - st.at > 30 * 60e3) { ttState.delete(uid); return false; }
  const text = ctx.message.text || '';
  if (text.startsWith('/')) return false;
  const url = tools.extractUrl(text);
  if (!url) { await ctx.reply('❌ Kirim link TikTok yang valid, contoh: https://vt.tiktok.com/xxxx/'); return true; }
  if (st.busy) { await ctx.reply('⏳ Masih memproses link sebelumnya.'); return true; }
  const day = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const u = db.stub(uid);
  if (u.ttDay !== day) { u.ttDay = day; u.ttCount = 0; }
  const lim = S.tools?.tiktok?.dailyLimit ?? 20;
  if (!db.isOwner(uid) && u.ttCount >= lim) { await ctx.reply(`❌ Batas ${lim} unduhan per hari tercapai. Coba lagi besok.`); return true; }
  st.busy = true; st.at = Date.now();
  const wait = await ctx.reply('⏳ Mengambil video...');
  const edit = (t) => bot.telegram.editMessageText(ctx.chat.id, wait.message_id, undefined, t).catch(() => {});
  try {
    const r = await tools.resolve(url);
    const cap = `✅ <b>TikTok${r.author ? ' @' + esc(r.author) : ''}</b>${r.title ? '\n' + esc(r.title.slice(0, 180)) : ''}\n🎞 Tanpa watermark`;
    const mkMusic = () => {
      if (!r.music) return undefined;
      const key = Math.random().toString(36).slice(2, 10);
      ttCache.set(key, { music: r.music, title: r.title, at: Date.now() });
      for (const [k, v] of ttCache) if (Date.now() - v.at > 20 * 60e3) ttCache.delete(k);
      return kb([[btn.callback('🎵 Ambil Audio MP3', `ttm:${key}`)]]);
    };
    if (r.images.length && !r.hd && !r.sd) {
      await edit('⏳ Mengirim foto...');
      await bot.telegram.sendMediaGroup(ctx.chat.id, r.images.map((x, i) => ({ type: 'photo', media: x, ...(i === 0 ? { caption: cap, parse_mode: 'HTML' } : {}) })));
      if (r.music) await bot.telegram.sendMessage(ctx.chat.id, '🎵 Audio slideshow:', { ...mkMusic() });
    } else {
      const cands = [r.hd, r.sd].filter(Boolean);
      if (!cands.length) throw new Error('Link video tidak tersedia dari layanan.');
      let sent = false, bigLink = null;
      for (const [i, link] of cands.entries()) {
        await edit(i === 0 && r.hd ? '⏳ Mengunduh video HD...' : '⏳ Mengunduh video...');
        const f = await tools.fetchBuffer(link);
        if (f.tooBig) { bigLink = bigLink || link; continue; }
        await edit('⏳ Mengirim ke Telegram...');
        await bot.telegram.sendVideo(ctx.chat.id, { source: f.buf, filename: `tiktok-${r.id || Date.now()}.mp4` }, { caption: cap + (i === 0 && r.hd ? ' • HD' : ''), parse_mode: 'HTML', supports_streaming: true, ...mkMusic() });
        sent = true; break;
      }
      if (!sent) {
        if (!bigLink) throw new Error('Gagal mengunduh video.');
        await bot.telegram.sendMessage(ctx.chat.id, `${cap}\n\n⚠️ Video lebih dari 50MB, tidak bisa dikirim lewat bot.\n<a href="${esc(bigLink)}">⬇️ Download langsung</a>`, { parse_mode: 'HTML', ...mkMusic() });
      }
    }
    u.ttCount++; db.save();
  } catch (e) {
    await ctx.reply(`❌ ${esc(e.message).slice(0, 300)}\nCoba lagi sebentar lagi atau kirim link lain.`, { parse_mode: 'HTML' });
  } finally {
    st.busy = false; st.at = Date.now();
    bot.telegram.deleteMessage(ctx.chat.id, wait.message_id).catch(() => {});
  }
  return true;
}
bot.action(/^ttm:(\w+)$/, async (ctx) => {
  const c = ttCache.get(ctx.match[1]);
  if (!c) return ctx.answerCbQuery('Tombol kedaluwarsa, kirim ulang link.', { show_alert: true });
  await ctx.answerCbQuery('Mengunduh audio...');
  try {
    const f = await tools.fetchBuffer(c.music);
    if (f.tooBig) return ctx.reply('⚠️ Audio terlalu besar.');
    await bot.telegram.sendAudio(ctx.chat.id, { source: f.buf, filename: 'tiktok-audio.mp3' }, { title: (c.title || 'TikTok audio').slice(0, 60) });
  } catch (e) { await ctx.reply(`❌ Gagal mengambil audio: ${esc(e.message).slice(0, 200)}`, { parse_mode: 'HTML' }); }
});

// ---------------- Kode Redeem ----------------
const redeemState = new Map(); // uid -> at
const redeemFail = new Map();  // uid -> { n, until }
const fmtCode = (c, d) => `<code>${c}</code> • +${d.credit} credit • ${d.used.length}/${d.max} dipakai${d.exp ? ' • s/d ' + new Date(d.exp).toLocaleDateString('id-ID') : ''}`;
async function doRedeem(ctx, input) {
  const uid = ctx.from.id;
  if (db.isUnlimited(uid)) return ctx.reply('♾ Role kamu sudah unlimited, tidak perlu credit.');
  const f = redeemFail.get(uid);
  if (f && f.until > Date.now()) return ctx.reply(`⛔ Terlalu banyak kode salah. Coba lagi ${Math.ceil((f.until - Date.now()) / 60000)} menit lagi.`);
  const r = db.redeem(uid, input);
  if (!r.ok) {
    if (r.reason === 'notfound') {
      const n = (f && f.until <= Date.now() ? 0 : f?.n || 0) + 1;
      redeemFail.set(uid, { n, until: n >= 5 ? Date.now() + 60 * 60e3 : 0 });
    }
    const m = { notfound: '❌ Kode tidak ditemukan.', expired: '⌛ Kode sudah kedaluwarsa.', already: 'ℹ️ Kamu sudah pernah memakai kode ini.', full: '❌ Kode sudah habis dipakai.' }[r.reason];
    return ctx.reply(m);
  }
  redeemFail.delete(uid);
  return ctx.reply(`🎉 <b>Redeem berhasil!</b>\n+${r.credit} credit\nSaldo sekarang: <b>${r.balance}</b>`, { parse_mode: 'HTML' });
}
bot.command('redeem', async (ctx) => {
  const [code] = args(ctx);
  if (!code) { redeemState.set(ctx.from.id, Date.now()); return ctx.reply('🎟 Kirim kode redeem kamu sekarang (contoh: BLD-ABCD-EFGH).'); }
  return doRedeem(ctx, code);
});
bot.action('redeem', async (ctx) => {
  await ctx.answerCbQuery();
  pending.delete(ctx.from.id);
  redeemState.set(ctx.from.id, Date.now());
  return show(ctx, '🎟 <b>REDEEM KODE</b>\nKirim kode kamu di chat ini (contoh: <code>BLD-ABCD-EFGH</code>).', kb([[btn.callback('⬅️ Kembali', 'credit')]]));
});
async function redeemAccept(ctx) {
  const at = redeemState.get(ctx.from.id);
  if (!at) return false;
  redeemState.delete(ctx.from.id);
  if (Date.now() - at > 10 * 60e3) return false;
  const t = ctx.message.text.trim();
  if (t.startsWith('/')) return false;
  await doRedeem(ctx, t);
  return true;
}
// owner: buat / lihat / hapus kode
bot.command('gencode', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [cr, cnt, mx, dy] = args(ctx).map((x) => (x === undefined ? undefined : parseInt(x, 10)));
  const credit = cr, count = cnt ?? 1, max = mx ?? 1, days = dy ?? 0;
  if (!(credit >= 1 && credit <= 100000) || !(count >= 1 && count <= 50) || !(max >= 1 && max <= 100000) || !(days >= 0 && days <= 3650)) {
    return ctx.reply('Format: <code>/gencode credit [jumlah_kode] [maks_pemakai] [hari_berlaku]</code>\n\nContoh:\n<code>/gencode 10</code> → 1 kode, +10 credit, 1x pakai\n<code>/gencode 5 20</code> → 20 kode berbeda, +5 credit, masing-masing 1x\n<code>/gencode 3 1 100 7</code> → 1 kode untuk 100 orang, +3 credit, berlaku 7 hari', { parse_mode: 'HTML' });
  }
  const codes = db.createCodes({ credit, count, max, days, by: ctx.from.id });
  return ctx.reply(`✅ <b>${codes.length} kode dibuat</b> (+${credit} credit, ${max}x pakai${days ? ', ' + days + ' hari' : ', tanpa batas waktu'})\n\n${codes.map((c) => `<code>${c}</code>`).join('\n')}\n\nUser memakai: /redeem KODE atau menu Credit → 🎟 Redeem.`, { parse_mode: 'HTML' });
});
bot.command('listcode', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const all = Object.entries(db.data.codes).filter(([, d]) => d.used.length < d.max && (!d.exp || d.exp > Date.now()));
  if (!all.length) return ctx.reply('Tidak ada kode aktif.');
  return ctx.reply(`🎟 <b>Kode aktif (${all.length})</b>\n${all.slice(0, 40).map(([c, d]) => fmtCode(c, d)).join('\n')}${all.length > 40 ? '\n…' : ''}`, { parse_mode: 'HTML' });
});
bot.command('delcode', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [c] = args(ctx);
  if (c === 'semua') { const n = Object.keys(db.data.codes).length; db.data.codes = {}; db.save(); return ctx.reply(`🗑 ${n} kode dihapus.`); }
  const key = c && Object.keys(db.data.codes).find((k) => k.replace(/-/g, '') === c.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  if (!key) return ctx.reply('Format: <code>/delcode KODE</code> atau <code>/delcode semua</code>', { parse_mode: 'HTML' });
  delete db.data.codes[key]; db.save();
  return ctx.reply(`🗑 Kode ${key} dihapus.`);
});

async function onZipDocument(ctx) {
  const d = ctx.message.document;
  if (!pending.get(ctx.from.id)) return ctx.reply('⚠️ Pilih menu build dulu (Flutter / ZIP → APK Android / HTML → APK) baru kirim ZIP.');
  if (!/\.(zip|rar|7z|tgz|tar\.gz|tar)$/i.test(d.file_name || '') && !/zip|rar|7z|tar|gzip|octet-stream/i.test(d.mime_type || '')) return ctx.reply('❌ File harus berformat <b>.zip</b> (juga .rar / .7z / .tar.gz)', { parse_mode: 'HTML' });
  if (d.file_size > S.limits.maxZipBytes) return ctx.reply(`❌ File terlalu besar (${fmtBytes(d.file_size)}). Maksimal ${fmtBytes(S.limits.maxZipBytes)}.`);
  if (d.file_size > 20 * 1024 * 1024 && !mt.isReady()) {
    return ctx.reply(`❌ ZIP ${fmtBytes(d.file_size)} > 20MB. Owner belum mengaktifkan MTProto (apiId/apiHash).\nSolusi: kirim <b>link direct</b> ZIP kamu.`, { parse_mode: 'HTML' });
  }
  return stage(ctx, { type: 'tg', fileId: d.file_id, size: d.file_size, msgId: ctx.message.message_id, name: d.file_name });
}
bot.on('document', async (ctx) => {
  if (bugState.has(ctx.from.id) && (await bugAccept(ctx, 'doc'))) return;
  if (await tryRestore(ctx)) return;
  if (await htmlAccept(ctx, 'doc')) return;
  if (uiState.has(ctx.from.id) && (await uiAccept(ctx, 'doc'))) return;
  if (fixState.has(ctx.from.id) && (await fixAccept(ctx, 'doc'))) return;
  return onZipDocument(ctx);
});

bot.on('text', async (ctx, next) => {
  if (redeemState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await redeemAccept(ctx))) return;
  if (ttState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await ttAccept(ctx))) return;
  if (bugState.has(ctx.from.id) && (await bugAccept(ctx, 'text'))) return;
  if (baseState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await baseAccept(ctx))) return;
  if (await htmlAccept(ctx, 'text')) return;
  if (uiState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await uiAccept(ctx, 'text'))) return;
  if (fixState.has(ctx.from.id) && !pending.get(ctx.from.id) && (await fixAccept(ctx, 'text'))) return;
  const t = ctx.message.text.trim();
  if (pending.get(ctx.from.id) && /^https?:\/\/\S+$/i.test(t)) return stage(ctx, { type: 'url', url: t });
  return next();
});

bot.action(/^cancel:(\d+)$/, async (ctx) => {
  const uid = Number(ctx.match[1]);
  if (uid !== ctx.from.id && !db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Bukan build kamu.', { show_alert: true });
  const ok = builder.cancel(uid, 'user');
  return ctx.answerCbQuery(ok ? '🛑 Membatalkan build...' : 'Build sudah selesai.', { show_alert: !ok });
});

// ---------------- profil, credit, riwayat, status, bantuan ----------------
bot.action('profile', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  return show(ctx, `👤 <b>PROFIL</b>\n━━━━━━━━━━━━━━\nNama: ${esc(u.name)}\nID: <code>${u.id}</code>\nRole: <b>${BADGE[role]}</b>\nCredit: <b>${creditText(u, role)}</b>\n${role === 'vip' ? `💎 VIP sampai: <b>${new Date(u.vipUntil).toLocaleDateString('id-ID')}</b> (${Math.max(0, Math.ceil((u.vipUntil - Date.now()) / 86400e3))} hari lagi)\n` : ''}Kuota hari ini: <b>${gb.fmt(db.gbUsed(u.id))} / ${gb.fmt(gb.quotaOf(role))}</b>\nTotal build: <b>${u.builds}</b>\nBergabung: ${new Date(u.joinedAt).toLocaleDateString('id-ID')}`, kb([backBtn]));
});

bot.action('credit', async (ctx) => {
  await ctx.answerCbQuery();
  const u = db.data.users[ctx.from.id];
  const role = db.roleOf(u.id);
  const info = !db.isUnlimited(u.id)
    ? `Member dapat <b>${S.limits.freeCredit} credit gratis</b>. Kalau habis, tunggu ${S.limits.refillHours} jam atau beli credit.\n`
    : 'Role kamu <b>unlimited build</b>.\n';
  return show(ctx, `💳 <b>CREDIT</b>\n━━━━━━━━━━━━━━\nSaldo: <b>${creditText(u, role)}</b>\n${info}\n\n💰 <b>Harga</b>\n• Credit: ${esc(db.data.prices.credit)}\n• Jadi reseller: ${esc(db.data.prices.reseller)}\n${role === 'vip' || role === 'owner' ? `• Perpanjang VIP: ${esc(db.data.prices.vip)} / ${db.data.vipDays} hari\n` : ''}\nBeli: ${T.ownerUsername}`, kb([[btn.callback('🎟 Redeem Kode', 'redeem')], backBtn]));
});

bot.action('history', async (ctx) => {
  await ctx.answerCbQuery();
  const h = db.data.history.filter((x) => x.uid === ctx.from.id).slice(-8).reverse();
  const em = { sukses: '✅', gagal: '❌', error: '⚠️', maintenance: '🚧', dibatalkan: '🛑', stuck: '⌛' };
  const body = h.length
    ? h.map((x) => `${em[x.status] || '•'} ${x.kind === 'android' ? 'Android ' + x.mode : x.kind === 'web' ? 'Web' : x.kind === 'html' ? 'HTML→APK' : 'Flutter ' + x.mode} • ${x.status} • ${fmtDur(x.dur)}\n   ${new Date(x.at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`).join('\n')
    : 'Belum ada riwayat build.';
  return show(ctx, `📜 <b>RIWAYAT BUILD</b>\n━━━━━━━━━━━━━━\n${body}`, kb([backBtn]));
});

bot.action('status', async (ctx) => {
  await ctx.answerCbQuery();
  const j = builder.getJob(ctx.from.id);
  if (!j) return show(ctx, '📊 <b>STATUS BUILD</b>\nTidak ada build yang berjalan.', kb([backBtn]));
  return show(ctx, builder.render(j), kb([[btn.callback('❌ Batalkan', `cancel:${j.uid}`)], backBtn]));
});

bot.action('help', async (ctx) => {
  await ctx.answerCbQuery();
  return show(ctx, `❓ <b>BANTUAN</b>\n━━━━━━━━━━━━━━\n${['vip', 'owner'].includes(db.roleOf(ctx.from.id)) ? '🧬 Buat Base ZIP: pilih jenis + tulis tema, bot membuat project starter\n🛠 Fix Base/API: kirim ZIP project Node.js/Python/PHP yang error, bot memperbaiki otomatis\n' : ''}🎨 Copy Tampilan: kirim file .dart + gambar UI + prompt, AI menyalin tampilan ke Dart\n\n1. Pilih Build Flutter / ZIP → APK Android / HTML → APK\n2. Kirim ZIP project (atau link direct)\n3. Tunggu, hasil APK dikirim otomatis\n4. Kalau gagal, log error lengkap dikirim\n\n<b>Command</b>\n/start • menu utama\n/redeem &lt;kode&gt; • tukar kode credit\n/addcredit &lt;id&gt; [jumlah] • reseller/owner\n/addreseller &lt;id&gt; • owner\n/addowner &lt;id&gt; • owner\n\nOwner: ${T.ownerUsername}`, kb([backBtn]));
});

// ---------------- panel reseller & owner ----------------
bot.action('reseller', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isUnlimited(ctx.from.id)) return ctx.answerCbQuery('Khusus reseller/owner', { show_alert: true });
  return show(ctx, `🏪 <b>PANEL RESELLER</b>\n━━━━━━━━━━━━━━\nTambah credit user:\n<code>/addcredit ID_USER [jumlah]</code>\n\nContoh: <code>/addcredit 123456789 10</code>\n(jumlah kosong = ${S.limits.freeCredit})\n\n💰 Harga credit: ${esc(db.data.prices.credit)}\n💰 Harga reseller: ${esc(db.data.prices.reseller)}`, kb([backBtn]));
});

function ownerPanel() {
  const on = db.data.maintenance;
  return {
    text: `👑 <b>PANEL OWNER</b>\n━━━━━━━━━━━━━━\n🛠 Maintenance: <b>${on ? '🔴 ON' : '🟢 OFF'}</b>\n🔧 Build aktif: <b>${builder.allJobs().length}</b>\n🛡 Anti-Gagal: <b>${S.antiFail === false ? '🔴 OFF' : '🟢 ON'}</b> • pulih otomatis ${(db.data.stats.healed || 0)}x\n\nCommand:\n/addcredit • /addreseller • /addowner\n/gencode • /listcode • /delcode • /addserver • /dellser • /setcost • /setharga\n/addvip • /delvip • /setvipdays\n/gb • /setquota • /bersihkan • /backup • /restore • /buildyml • /setupgithub • /delreseller • /ban • /unban • /cekuser\n/broadcast • /maintenance on|off`,
    keyboard: kb([
      [btn.callback(on ? '🟢 Matikan Maintenance' : '🔴 Nyalakan Maintenance', 'mt:toggle')],
      [btn.callback('📊 Statistik', 'stats'), btn.callback('🔧 Build Aktif', 'active')],
      [btn.callback('🖥 Kelola Server', 'servers'), btn.callback('⚙️ Setup GitHub', 'setupgh')],
      [btn.callback('📄 Buat build.yml Baru', 'buildyml'), btn.callback('💾 GB & Disk', 'gbinfo')],
      [btn.callback('💾 Backup Semua File', 'backup')],
      backBtn,
    ]),
  };
}

bot.action('owner', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

function setMaintenance(on) {
  db.data.maintenance = on; db.save();
  return on ? builder.abortAllForMaintenance() : 0;
}

bot.action('mt:toggle', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const n = setMaintenance(!db.data.maintenance);
  await ctx.answerCbQuery(db.data.maintenance ? `Maintenance ON, ${n} build dihentikan` : 'Maintenance OFF', { show_alert: true });
  const p = ownerPanel();
  return show(ctx, p.text, p.keyboard);
});

async function runSetup() {
  const out = [];
  for (const sv of db.data.servers) {
    try { out.push(`✅ ${sv.label} (${sv.repo})\n${await setup.ensure(sv)}`); }
    catch (e) { out.push(`❌ ${sv.label} (${sv.repo}): ${e.message.slice(0, 200)}`); }
  }
  return `⚙️ <b>Setup GitHub</b>\n<pre>${esc(out.join('\n\n') || 'Belum ada server')}</pre>`;
}
bot.action('setupgh', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Menyiapkan GitHub...');
  return show(ctx, await runSetup(), kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});
bot.command('setupgithub', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return ctx.reply(await runSetup(), { parse_mode: 'HTML' });
});


// ---------------- Backup (khusus owner) ----------------
const AdmZip = require('adm-zip');
const BK_SKIP = new Set(['node_modules', '.git', 'tmp', '.npm']);
function addDir(z, dir, rel) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (BK_SKIP.has(f.name) || f.name.endsWith('.tmp')) continue;
    const full = path.join(dir, f.name);
    const r = rel ? `${rel}/${f.name}` : f.name;
    if (f.isDirectory()) addDir(z, full, r);
    else if (rel === 'data' && f.name === 'db.json') continue; // diganti snapshot terbaru dari memori
    else { try { z.addFile(r, fs.readFileSync(full)); } catch {} }
  }
}
// backup SEMUA file bot (kode, setting, data) kecuali node_modules
function makeBackup() {
  const z = new AdmZip();
  addDir(z, __dirname, '');
  z.addFile('data/db.json', Buffer.from(db.snapshot()));
  return z.toBuffer();
}
const backupName = () => `backup-semua-file-${new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
async function sendBackup(chatId, _full, auto) {
  const n = Object.keys(db.data.users).length;
  const buf = makeBackup();
  const caption = `💾 <b>Backup ${auto ? 'otomatis ' : ''}SEMUA FILE</b>\n👥 ${n} user • 🖥 ${db.data.servers.length} server • ${fmtBytes(buf.length)}\n⚠️ Berisi token/API key (setting.js). Simpan rahasia!\nRestore data user: kirim ZIP ini ke bot dengan caption <code>/restore</code> (file kode: ekstrak manual).`;
  if (buf.length > 49 * 1024 * 1024) return bot.telegram.sendMessage(chatId, '❌ Backup > 50MB, tidak bisa dikirim lewat bot.');
  return bot.telegram.sendDocument(chatId, { source: buf, filename: backupName() }, { caption, parse_mode: 'HTML' });
}
bot.command('backup', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  await sendBackup(ctx.chat.id, true, false);
});
bot.action('backup', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Membuat backup...');
  return sendBackup(ctx.chat.id, false, false);
});
// restore: owner kirim .zip/.json dengan caption /restore
async function tryRestore(ctx) {
  const cap = ctx.message.caption || '';
  if (!/^\/restore\b/i.test(cap)) return false;
  if (!db.isOwner(ctx.from.id)) { await ctx.reply(denyOwner, { parse_mode: 'HTML' }); return true; }
  const d = ctx.message.document;
  try {
    if (d.file_size > 30 * 1024 * 1024) throw new Error('File terlalu besar.');
    const buf = await fetchBuf(d.file_id, 30 * 1024 * 1024);
    let text;
    if (/\.zip$/i.test(d.file_name || '')) {
      const zz = new AdmZip(buf);
      const e = zz.getEntry('data/db.json') || zz.getEntry('db.json');
      if (!e) throw new Error('data/db.json tidak ada di dalam ZIP.');
      text = e.getData().toString('utf8');
    } else text = buf.toString('utf8');
    JSON.parse(text); // validasi sebelum menimpa
    await sendBackup(ctx.chat.id, false, false).catch(() => {}); // cadangan data sekarang, jaga-jaga
    const r = db.restore(text);
    await ctx.reply(`✅ Restore berhasil: ${r.users} user, ${r.servers} server.\n(Backup data sebelum restore sudah dikirim di atas.)`);
  } catch (e) {
    await ctx.reply(`❌ Restore gagal: ${esc(e.message)}`);
  }
  return true;
}
// backup otomatis harian ke semua owner
function scheduleBackup() {
  const hrs = S.backup?.autoHours ?? 24;
  if (!hrs) return;
  setInterval(() => {
    for (const id of T.ownerIds) sendBackup(id, false, true).catch(() => {});
  }, hrs * 3600e3).unref();
}

// ---- Penjaga GB (owner) ----
bot.command('gb', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return ctx.reply(gb.report(), { parse_mode: 'HTML' });
});
bot.action('gbinfo', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery();
  return show(ctx, gb.report(), kb([[btn.callback('🧹 Bersihkan File Sementara', 'gbclean')], [btn.callback('⬅️ Panel Owner', 'owner')]]));
});
bot.action('gbclean', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const r = gb.cleanup(10);
  await ctx.answerCbQuery(`Dihapus ${r.n} item (${gb.fmt(r.bytes)})`, { show_alert: true });
  return show(ctx, gb.report(), kb([[btn.callback('🧹 Bersihkan File Sementara', 'gbclean')], [btn.callback('⬅️ Panel Owner', 'owner')]]));
});
bot.command('bersihkan', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const r = gb.cleanup(10); // file menganggur > 10 menit (build yang sedang jalan aman)
  return ctx.reply(`🧹 Dihapus ${r.n} item (${gb.fmt(r.bytes)}).`);
});
bot.command('setquota', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [role, n] = args(ctx);
  const v = parseFloat(n);
  if (!['member', 'vip', 'reseller'].includes(role) || !(v > 0 && v <= 1000)) return ctx.reply('Format: <code>/setquota member|vip|reseller GB</code>\nContoh: <code>/setquota member 5</code>', { parse_mode: 'HTML' });
  db.data.quota[role] = v; db.save();
  return ctx.reply(`✅ Kuota harian ${role}: ${v} GB`);
});

// ---- Generator build.yml baru (owner) ----
async function sendYmls(ctx) {
  const bad = setup.selfCheck();
  if (bad.length) return ctx.reply(`❌ Template workflow bermasalah:\n<pre>${esc(bad.join('\n'))}</pre>`, { parse_mode: 'HTML' });
  for (const [name, y] of Object.entries(setup.files())) {
    await ctx.replyWithDocument({ source: Buffer.from(y), filename: name }, { caption: `📄 ${name} (terbaru, auto-detect versi Flutter + fallback)` });
  }
  return ctx.reply('✅ Build.yml baru dibuat & lolos pengecekan.\nPasang otomatis ke semua server (repo) sekarang?', kb([
    [btn.callback('⚙️ Pasang Otomatis ke Semua Server', 'setupgh2')],
    [btn.callback('⬅️ Panel Owner', 'owner')],
  ]));
}
bot.command('buildyml', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  return sendYmls(ctx);
});
bot.action('buildyml', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Membuat build.yml...');
  return sendYmls(ctx);
});
bot.action('setupgh2', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  await ctx.answerCbQuery('Memasang ke GitHub...');
  return ctx.reply(await runSetup(), { parse_mode: 'HTML' });
});

function serverPanel() {
  const rows = db.data.servers.map((sv) => `#${sv.id} <b>${esc(sv.label)}</b> ${sv.enabled ? '🟢' : '🔴'}\n   <code>${esc(sv.repo)}</code> • 💳${sv.cost} • aktif ${serverLoad(sv.id)}`);
  return {
    text: `🖥 <b>KELOLA SERVER</b>\n━━━━━━━━━━━━━━\n${rows.join('\n') || 'Belum ada server.'}\n\n<code>/addserver owner/repo [nama]</code>\n<code>/dellser owner/repo</code>\n<code>/setcost ID credit</code>\n<code>/setharga credit|reseller teks</code>`,
    keyboard: kb([
      ...db.data.servers.map((sv) => [btn.callback(`${sv.enabled ? '🔴 Matikan' : '🟢 Nyalakan'} #${sv.id} ${sv.label}`, `svt:${sv.id}`)]),
      [btn.callback('⬅️ Panel Owner', 'owner')],
    ]),
  };
}
bot.action('servers', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const p = serverPanel();
  return show(ctx, p.text, p.keyboard);
});
bot.action(/^svt:(\d+)$/, async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.answerCbQuery('Khusus owner', { show_alert: true });
  const sv = db.serverById(ctx.match[1]);
  if (sv) { sv.enabled = !sv.enabled; db.save(); }
  await ctx.answerCbQuery(sv ? (sv.enabled ? 'Server aktif' : 'Server dimatikan') : 'Tidak ada');
  const p = serverPanel();
  return show(ctx, p.text, p.keyboard);
});

bot.command('addserver', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [repo, ...lab] = args(ctx);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return ctx.reply('Format: <code>/addserver owner/repo [nama server]</code>', { parse_mode: 'HTML' });
  if (db.data.servers.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) return ctx.reply('❌ Repo itu sudah jadi server.');
  const m = await ctx.reply('⏳ Memeriksa repo & memasang workflow...');
  const sv = { id: 0, repo, label: lab.join(' ').slice(0, 24) || '', branch: S.github.branch };
  try {
    const rep = await setup.ensure(sv);
    const real = db.addServer(repo, sv.label);
    real.branch = sv.branch; db.save();
    return ctx.reply(`✅ Server <b>#${real.id} ${esc(real.label)}</b> ditambahkan.\n<pre>${esc(rep)}</pre>`, { parse_mode: 'HTML' });
  } catch (e) {
    return ctx.reply(`❌ Gagal: ${esc(e.message).slice(0, 400)}\nPastikan repo ada & token punya akses (repo + workflow).`, { parse_mode: 'HTML' });
  }
});

// /delserver | /dellserver | /dellser  <owner/repo | nama | ID>
const normRepo = (x) => String(x || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase();
bot.command(['delserver', 'dellserver', 'dellser'], async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const q = args(ctx).join(' ').trim();
  if (!q) return ctx.reply('Format: <code>/dellser owner/repo</code>\n(atau nama server / ID). Lihat daftar di Kelola Server.', { parse_mode: 'HTML' });
  const nq = normRepo(q);
  const all = db.data.servers;
  let hits = all.filter((x) => normRepo(x.repo) === nq);
  if (!hits.length) hits = all.filter((x) => String(x.label).toLowerCase() === q.toLowerCase());
  if (!hits.length && /^\d+$/.test(q)) hits = all.filter((x) => x.id === Number(q));
  if (!hits.length) hits = all.filter((x) => normRepo(x.repo).split('/')[1] === nq); // nama repo saja
  if (!hits.length) return ctx.reply(`❌ Server "${esc(q)}" tidak ditemukan.\nTersedia:\n${all.map((x) => `#${x.id} ${esc(x.label)} • <code>${esc(x.repo)}</code>`).join('\n') || '-'}`, { parse_mode: 'HTML' });
  if (hits.length > 1) return ctx.reply(`⚠️ Ada ${hits.length} server cocok, tulis <code>owner/repo</code> lengkap:\n${hits.map((x) => `<code>${esc(x.repo)}</code>`).join('\n')}`, { parse_mode: 'HTML' });
  const sv = hits[0];
  if (serverLoad(sv.id)) return ctx.reply('❌ Masih ada build aktif di server itu.');
  if (all.length === 1) return ctx.reply('❌ Ini satu-satunya server. Tambah server lain dulu dengan /addserver.');
  db.delServer(sv.id);
  return ctx.reply(`✅ Server #${sv.id} ${esc(sv.label)} (<code>${esc(sv.repo)}</code>) dihapus.`, { parse_mode: 'HTML' });
});

bot.command('setcost', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id, n] = args(ctx);
  const sv = db.serverById(id);
  const c = parseInt(n, 10);
  if (!sv || !Number.isInteger(c) || c < 1 || c > 1000) return ctx.reply('Format: /setcost ID_SERVER jumlah_credit (1-1000)');
  sv.cost = c; db.save();
  return ctx.reply(`✅ Biaya ${sv.label}: ${c} credit/build (berlaku untuk member).`);
});

bot.command('addvip', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id, d] = args(ctx);
  if (!validId(id)) return ctx.reply('Format: <code>/addvip ID_USER [hari]</code>\nContoh: <code>/addvip 123456789 30</code>', { parse_mode: 'HTML' });
  const r = db.roleOf(id);
  if (r === 'owner' || r === 'reseller') return ctx.reply(`❌ User itu sudah ${BADGE[r]}. VIP hanya untuk member.`);
  const days = d === undefined ? db.data.vipDays : parseInt(d, 10);
  if (!Number.isInteger(days) || days < 1 || days > 3650) return ctx.reply('❌ Jumlah hari tidak valid (1 - 3650).');
  const u = db.addVip(id, days);
  const until = new Date(u.vipUntil).toLocaleDateString('id-ID');
  notify(id, `💎 Kamu sekarang <b>VIP</b> selama <b>${days} hari</b> (sampai ${until}).\nFitur 🛠 Fix Base/API sudah aktif. Ketik /start.`);
  return ctx.reply(`✅ <code>${id}</code> jadi 💎 VIP +${days} hari (sampai ${until}).`, { parse_mode: 'HTML' });
});

bot.command('delvip', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id) || !db.delVip(id)) return ctx.reply('❌ ID bukan VIP aktif. Format: /delvip ID_USER');
  return ctx.reply(`✅ VIP <code>${id}</code> dicabut.`, { parse_mode: 'HTML' });
});

bot.command('setvipdays', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const n = parseInt(args(ctx)[0], 10);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return ctx.reply('Format: /setvipdays jumlah_hari (1-3650)');
  db.data.vipDays = n; db.save();
  return ctx.reply(`✅ Masa VIP bawaan: ${n} hari.`);
});

bot.command('setharga', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [k, ...rest] = args(ctx);
  const txt = rest.join(' ').trim().slice(0, 120);
  if (!['credit', 'reseller', 'vip'].includes(k) || !txt) return ctx.reply('Format:\n/setharga credit Rp2.000 / credit\n/setharga reseller Rp50.000\n/setharga vip Rp30.000\n(hari VIP: /setvipdays 30)');
  db.data.prices[k] = txt; db.save();
  return ctx.reply(`✅ Harga ${k}: ${txt}`);
});

bot.action('stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const us = Object.values(db.data.users);
  const c = (r) => us.filter((u) => db.roleOf(u.id) === r).length;
  const s = db.data.stats;
  return show(ctx, `📊 <b>STATISTIK</b>\n━━━━━━━━━━━━━━\n👥 User: <b>${us.length}</b> (verified ${us.filter((u) => u.verified).length})\n👑 Owner ${c('owner')} • 🏪 Reseller ${c('reseller')} • 💎 VIP ${c('vip')} • 👤 Member ${c('member')}\n🏗 Total build: <b>${s.builds}</b>\n✅ Sukses ${s.ok} • ❌ Gagal ${s.fail}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

bot.action('active', async (ctx) => {
  await ctx.answerCbQuery();
  if (!db.isOwner(ctx.from.id)) return;
  const js = builder.allJobs();
  const body = js.length
    ? js.map((j) => `• <code>${j.uid}</code> ${j.kind} ${j.mode} • ${esc(j.server.label)} • ${fmtDur(Date.now() - j.startedAt)} • ${esc(j.steps.find((s) => s.st === 'run')?.t || '...')}`).join('\n')
    : 'Tidak ada build aktif.';
  return show(ctx, `🔧 <b>BUILD AKTIF</b>\n━━━━━━━━━━━━━━\n${body}`, kb([[btn.callback('⬅️ Panel Owner', 'owner')]]));
});

// ---------------- command ----------------
const args = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);
const validId = (s) => /^\d{5,15}$/.test(s || '');
const notify = (id, text) => bot.telegram.sendMessage(id, text, { parse_mode: 'HTML' }).catch(() => {});

bot.command('addcredit', async (ctx) => {
  if (!db.isUnlimited(ctx.from.id)) return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id, n] = args(ctx);
  if (!validId(id)) return ctx.reply('Format: <code>/addcredit ID_USER [jumlah]</code>', { parse_mode: 'HTML' });
  const amount = n === undefined ? S.limits.freeCredit : parseInt(n, 10);
  if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return ctx.reply('❌ Jumlah credit tidak valid (1 - 100000).');
  const u = db.addCredit(id, amount);
  notify(id, `💳 Kamu mendapat <b>+${amount} credit</b>!\nSaldo sekarang: <b>${u.credits}</b>`);
  return ctx.reply(`✅ Berhasil menambah <b>${amount} credit</b> ke <code>${id}</code>.\nSaldo: ${u.credits}`, { parse_mode: 'HTML' });
});

async function roleCmd(ctx, role) {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id)) return ctx.reply(`Format: <code>${ctx.message.text.split(' ')[0]} ID_USER</code>`, { parse_mode: 'HTML' });
  if (role === 'reseller' && db.isOwner(id)) return ctx.reply('❌ User itu sudah OWNER.');
  db.setRole(id, role);
  notify(id, `🎉 Role kamu sekarang <b>${BADGE[role]}</b>!\nKetik /start untuk membuka menu.`);
  return ctx.reply(`✅ <code>${id}</code> sekarang <b>${BADGE[role]}</b>.`, { parse_mode: 'HTML' });
}
bot.command(['addreseller', 'address'], (ctx) => roleCmd(ctx, 'reseller'));
bot.command('addowner', (ctx) => roleCmd(ctx, 'owner'));

bot.command('delreseller', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  if (!validId(id) || db.data.users[id]?.role !== 'reseller') return ctx.reply('❌ ID bukan reseller. Format: /delreseller ID_USER');
  db.setRole(id, 'member');
  return ctx.reply(`✅ <code>${id}</code> dikembalikan jadi MEMBER.`, { parse_mode: 'HTML' });
});

bot.command('maintenance', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const [a] = args(ctx);
  if (!['on', 'off'].includes((a || '').toLowerCase())) return ctx.reply('Format: /maintenance on|off');
  const on = a.toLowerCase() === 'on';
  const n = setMaintenance(on);
  return ctx.reply(on ? `🔴 Maintenance ON. ${n} build user dihentikan.` : '🟢 Maintenance OFF. Bot kembali normal.');
});

for (const [cmd, val] of [['ban', true], ['unban', false]]) {
  bot.command(cmd, async (ctx) => {
    if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
    const [id] = args(ctx);
    if (!validId(id) || db.isOwner(id)) return ctx.reply(`Format: /${cmd} ID_USER (owner tidak bisa di-ban)`);
    db.stub(id).banned = val; db.save();
    if (val) builder.cancel(id, 'user');
    return ctx.reply(`✅ <code>${id}</code> ${val ? 'diblokir' : 'dibuka blokirnya'}.`, { parse_mode: 'HTML' });
  });
}

bot.command('cekuser', async (ctx) => {
  if (!db.isUnlimited(ctx.from.id)) return ctx.reply(denyReseller, { parse_mode: 'HTML' });
  const [id] = args(ctx);
  const u = db.data.users[id];
  if (!u) return ctx.reply('❌ User tidak ditemukan.');
  return ctx.reply(`👤 ${who(u)}\nRole: ${BADGE[db.roleOf(id)]}\nCredit: ${creditText(u, db.roleOf(id))}\nBuild: ${u.builds}\nVerified: ${u.verified ? 'ya' : 'belum'}\nBanned: ${u.banned ? 'ya' : 'tidak'}`, { parse_mode: 'HTML' });
});

bot.command('stats', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const s = db.data.stats;
  return ctx.reply(`👥 User: ${Object.keys(db.data.users).length}\n🏗 Build: ${s.builds} (✅ ${s.ok} / ❌ ${s.fail})\n🔧 Aktif: ${builder.allJobs().length}\n🛠 Maintenance: ${db.data.maintenance ? 'ON' : 'OFF'}`);
});

bot.command('broadcast', async (ctx) => {
  if (!db.isOwner(ctx.from.id)) return ctx.reply(denyOwner, { parse_mode: 'HTML' });
  const text = ctx.message.text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim();
  if (!text) return ctx.reply('Format: /broadcast teks pesan');
  const ids = Object.values(db.data.users).filter((u) => u.verified).map((u) => u.id);
  await ctx.reply(`📢 Mengirim ke ${ids.length} user...`);
  (async () => {
    let ok = 0, fail = 0;
    for (const id of ids) {
      try { await bot.telegram.sendMessage(id, `📢 <b>PENGUMUMAN</b>\n\n${esc(text)}`, { parse_mode: 'HTML' }); ok++; } catch { fail++; }
      await sleep(60);
    }
    notify(ctx.from.id, `✅ Broadcast selesai. Terkirim ${ok}, gagal ${fail}.`);
  })();
});

// ---------------- jalankan ----------------
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e?.message || e));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

(async () => {
  await mt.init();
  const me = await bot.telegram.getMe();
  console.log(`✅ Bot @${me.username} berjalan | Owner: ${T.ownerIds.join(', ')}`);
  try {
    const m = await bot.telegram.getChatMember(S.channel.id, me.id);
    if (!['administrator', 'creator'].includes(m.status)) console.warn('⚠️ Bot BUKAN admin di channel! Jadikan admin agar verifikasi & notifikasi jalan.');
  } catch (e) {
    console.warn('⚠️ Channel tidak terbaca:', e.description || e.message, '-> cek setting.js channel.id & jadikan bot admin.');
  }
  for (const sv of db.data.servers) setup.ensure(sv).then((r) => console.log(`[setup ${sv.label}]\n` + r)).catch((e) => console.warn(`⚠️ Setup ${sv.label} gagal:`, e.message));
  scheduleBackup();
  gb.schedule();
  bot.launch({ dropPendingUpdates: true }).catch((e) => { console.error('Gagal launch:', e.message); process.exit(1); });
})();
