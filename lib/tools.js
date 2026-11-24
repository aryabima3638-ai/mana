// Tools: TikTok downloader (video HD tanpa watermark) lewat layanan pihak ketiga (TikWM)
const S = require('../setting');
const { sleep } = require('./util');

const API = () => (S.tools && S.tools.tiktokApi) || 'https://www.tikwm.com/api/';
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36';
const TT_URL = /^https?:\/\/([\w-]+\.)*(tiktok\.com|tiktokv\.com|tiktokcdn\.com)(\/|$)/i;
const MAX_BYTES = 49 * 1024 * 1024; // batas kirim Bot API

function extractUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"']+/i);
  if (!m) return null;
  const u = m[0].replace(/[),.;]+$/, '');
  return TT_URL.test(u) ? u : null;
}

// CDN hasil API: hanya https & bukan alamat internal
function safeMediaUrl(u, base) {
  try {
    const x = new URL(u, base);
    if (x.protocol !== 'https:') return null;
    const h = x.hostname;
    if (/^(localhost|.*\.local|.*\.internal)$/i.test(h) || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    return x.href;
  } catch { return null; }
}

// antrean: layanan gratis membatasi 1 request/detik
let chain = Promise.resolve();
let lastAt = 0;
function throttled(fn) {
  const run = chain.then(async () => {
    const wait = 1200 - (Date.now() - lastAt);
    if (wait > 0) await sleep(wait);
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function resolve(url) {
  let last;
  for (let a = 1; a <= 3; a++) {
    try {
      const body = await throttled(async () => {
        const res = await fetch(API(), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
          body: new URLSearchParams({ url, hd: '1' }).toString(),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw Object.assign(new Error(`Layanan error HTTP ${res.status}`), { retry: res.status >= 500 || res.status === 429 });
        return res.json();
      });
      if (body.code !== 0 || !body.data) {
        const msg = String(body.msg || '');
        if (/limit|too many|second/i.test(msg)) throw Object.assign(new Error('Layanan sedang sibuk'), { retry: true });
        throw new Error(/private|not found|removed|unavailable|invalid|parse/i.test(msg) ? 'Video tidak ditemukan / privat / sudah dihapus.' : `Gagal mengambil video (${msg.slice(0, 80) || 'tidak diketahui'}).`);
      }
      const d = body.data;
      const base = new URL(API()).origin;
      return {
        id: String(d.id || ''),
        title: String(d.title || '').replace(/\s+/g, ' ').trim(),
        author: d.author?.unique_id || d.author?.nickname || '',
        duration: d.duration || 0,
        hd: safeMediaUrl(d.hdplay, base),
        sd: safeMediaUrl(d.play, base),
        music: safeMediaUrl(d.music, base),
        cover: safeMediaUrl(d.cover, base),
        images: Array.isArray(d.images) ? d.images.map((i) => safeMediaUrl(i, base)).filter(Boolean).slice(0, 10) : [],
        hdSize: d.hd_size || 0, sdSize: d.size || 0,
      };
    } catch (e) {
      last = e;
      if (e.name === 'TimeoutError') last = new Error('Layanan TikTok terlalu lama merespons.');
      if (!(e.retry || e.name === 'TimeoutError' || /fetch failed|ECONN|network/i.test(e.message))) throw last;
      await sleep(1200 * a);
    }
  }
  throw last;
}

// unduh ke Buffer dengan batas ukuran
async function fetchBuffer(url, max = MAX_BYTES) {
  const res = await fetch(url, { headers: { 'user-agent': UA, referer: 'https://www.tiktok.com/' }, signal: AbortSignal.timeout(90000), redirect: 'follow' });
  if (!res.ok) throw new Error(`Download media gagal (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > max) return { tooBig: true, size: len };
  const chunks = []; let got = 0;
  for await (const c of res.body) {
    got += c.length;
    if (got > max) return { tooBig: true, size: got };
    chunks.push(c);
  }
  return { buf: Buffer.concat(chunks), size: got };
}

module.exports = { extractUrl, resolve, fetchBuffer, MAX_BYTES };
