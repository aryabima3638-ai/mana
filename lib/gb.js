// Penjaga GB: ruang disk panel, kuota harian per user, dan pembersihan file sementara
const fs = require('fs');
const path = require('path');
const S = require('../setting');
const db = require('./db');
const { mkdirp } = require('./util');

const TMP = path.join(__dirname, '..', 'data', 'tmp');
mkdirp(TMP);
const GB = 1024 ** 3;
const cfg = () => S.gb || {};
const fmt = (b) => (b === Infinity ? '∞' : (b / GB).toFixed(b / GB >= 10 ? 0 : 2) + ' GB');

function dirSize(d) {
  let t = 0;
  try {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      try { t += f.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch {}
    }
  } catch {}
  return t;
}
function disk() {
  try { const s = fs.statfsSync(TMP); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; }
}
function quotaOf(role) {
  if (role === 'owner') return Infinity;
  const q = { member: 3, vip: 10, reseller: 20, ...(cfg().quota || {}), ...(db.data.quota || {}) };
  return (q[role] ?? 3) * GB;
}
const usedToday = (uid) => db.gbUsed(uid);

// Cek ruang disk sebelum download (size = ukuran file, 0 = belum diketahui)
function checkDisk(size = 0) {
  const c = cfg();
  const minFree = (c.minFreeGB ?? 1.5) * GB;
  const maxTmp = (c.maxTmpGB ?? 10) * GB;
  const need = size * 1.3 + (size ? 0 : 0.3 * GB);
  const d = disk();
  if (d && d.free - need < minFree) return { ok: false, msg: `Penyimpanan server hampir penuh (sisa ${fmt(d.free)}). Coba lagi beberapa menit lagi.` };
  if (dirSize(TMP) + size > maxTmp) return { ok: false, msg: `Antrean file sementara server sedang penuh (batas ${fmt(maxTmp)}). Coba lagi beberapa menit lagi.` };
  return { ok: true };
}
// Cek kuota harian user
function checkQuota(uid, size = 0) {
  const q = quotaOf(db.roleOf(uid));
  const used = usedToday(uid);
  if (used + size > q) return { ok: false, msg: `Kuota harian ${fmt(q)} habis (terpakai ${fmt(used)}). Kuota reset tiap hari pukul 00:00 WIB.` };
  return { ok: true };
}
function precheck(uid, size = 0) {
  const a = checkQuota(uid, size); if (!a.ok) return a;
  return checkDisk(size);
}
// Bersihkan file sementara yang menganggur
function cleanup(maxAgeMin) {
  const age = (maxAgeMin ?? cfg().tmpMaxAgeMin ?? 60) * 60e3;
  let n = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(TMP, { withFileTypes: true })) {
      const p = path.join(TMP, f.name);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs > age) { bytes += f.isDirectory() ? dirSize(p) : st.size; fs.rmSync(p, { recursive: true, force: true }); n++; }
      } catch {}
    }
  } catch {}
  return { n, bytes };
}
function schedule() {
  cleanup(0); // saat start: tidak ada build aktif, bersihkan semua sisa
  setInterval(() => cleanup(), 30 * 60e3).unref();
}
function report() {
  const d = disk();
  const g = db.data.gb || { total: 0, users: {} };
  const top = Object.entries(g.users || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const q = (r) => fmt(quotaOf(r));
  return `💾 <b>PENYIMPANAN & GB</b>\n━━━━━━━━━━━━━━\n🖴 Disk: ${d ? `sisa <b>${fmt(d.free)}</b> dari ${fmt(d.total)}` : 'tidak terbaca'}\n🗂 File sementara: <b>${fmt(dirSize(TMP))}</b> (batas ${fmt((cfg().maxTmpGB ?? 10) * GB)})\n📈 Diproses hari ini: <b>${fmt(g.total || 0)}</b>\n\n🎟 Kuota harian: member ${q('member')} • VIP ${q('vip')} • reseller ${q('reseller')} • owner ∞\n${top.length ? '\n🏆 Pemakai terbanyak hari ini:\n' + top.map(([u, b], i) => `${i + 1}. <code>${u}</code> • ${fmt(b)}`).join('\n') : ''}\n\n<code>/setquota member|vip|reseller GB</code>\n<code>/bersihkan</code> hapus file sementara`;
}
module.exports = { checkDisk, checkQuota, precheck, cleanup, schedule, report, quotaOf, usedToday, fmt, dirSize, disk };
