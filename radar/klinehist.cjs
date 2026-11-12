'use strict';
/* KH-1113 K 线历史（给新版 TradingView 图表用）：klineHist(net, addr, pool, interval, beforeMs)
   回传 [{ t 毫秒（K 棒开始）, o, h, l, c, v 美金成交量 }]，旧到新；最后一根是「到现在为止」的那根，画面再用成交明细即时更新。
   资料来源顺序：① 还在发射台曲线上的币＝雷达自己读链记的成交（远端多半还没收录）② GeckoTerminal（免费、不用金钥，不花 AVE 额度；
   每个 IP 每分钟约 30 次 → 本机令牌桶限速＋快取）③ AVE（经转接站，共用额度）④ OKX（玩家自己的金钥，有开才用）⑤ 雷达读链记的成交（已上外盘、上面都读不到时）。
   资料源没有的周期（3 小时、6 小时、3 天、周、月）用小周期合并；周线＝周一开始、月线＝日历月（跟其他图同一套格子 kline.cjs）。 */
const KL = require('./kline.cjs');

const SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '3h': 10800, '6h': 21600, '12h': 43200, '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2592000 };
/* GeckoTerminal 只有 day(1)／hour(1,4,12)／minute(1,5,15)：[时间单位, aggregate, 几根合成一根] */
const GT = { '1m': ['minute', 1, 1], '5m': ['minute', 5, 1], '15m': ['minute', 15, 1], '1h': ['hour', 1, 1], '3h': ['hour', 1, 3], '6h': ['hour', 1, 6], '12h': ['hour', 12, 1], '1d': ['day', 1, 1], '3d': ['day', 1, 3], '1w': ['day', 1, 7], '1M': ['day', 1, 31] };
const GT_NET = { bsc: 'bsc', robinhood: 'robinhood', solana: 'solana', base: 'base', eth: 'eth' }; /* 技术用：GeckoTerminal 的链代号（11/13 查过 /networks 有 robinhood） */
const BARS = 300; /* 技术用：一次给几根 */
const GT_CAP = 8, GT_REFILL_MS = 2200, GT_WAIT_MS = 2500, GT_COOL_MS = 20e3; /* 技术用：GeckoTerminal 令牌桶（最多存 8 个、每 2.2 秒补 1 个≈每分钟 27 次，低于它公布的 30 次）／没令牌最多等多久／被回 429 后停多久（这段时间改用 AVE／OKX） */
const POOL_TTL = 30 * 60e3; /* 技术用：币→池子 对应快取多久 */
const ttlOf = (tf) => (SEC[tf] <= 300 ? 15e3 : SEC[tf] <= 3600 ? 30e3 : 120e3); /* 技术用：K 线快取多久（最新一根画面用成交即时更新） */

let D = {}; /* 依赖：aveCandles, aveOK, MK, V4B, V4R, AVT, OKM */
function install(deps) { D = deps || {}; }
const B = { tok: GT_CAP, at: Date.now(), cool: 0, n: 0, n429: 0 };
function take() { const now = Date.now(); B.tok = Math.min(GT_CAP, B.tok + (now - B.at) / GT_REFILL_MS); B.at = now; if (now < B.cool || B.tok < 1) return false; B.tok -= 1; return true; }
async function gtToken() { const end = Date.now() + GT_WAIT_MS; for (;;) { if (take()) return true; if (Date.now() >= end || Date.now() < B.cool) return false; await new Promise((r) => setTimeout(r, 250)); } }
async function gt(u) { if (!(await gtToken())) return null; B.n++; const r = await fetch('https://api.geckoterminal.com/api/v2/networks/' + u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) }).catch(() => null); if (!r) return null; if (r.status === 429) { B.n429++; B.cool = Date.now() + GT_COOL_MS; return null; } if (!r.ok) return { err: r.status }; return r.json().catch(() => null); }

const CK = new Map(), INF = new Map(), PL = new Map();
const isEvm = (a) => /^0x[0-9a-f]{40}$/.test(a), isPool = (p) => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(p);
/* 找池子：画面给的 → 发射台上外盘的池子（雷达读链）→ AVE 主池（快取里有就用）→ GeckoTerminal 流动性最大的池 */
async function poolOf(net, addr, pool) {
  if (net !== 'solana' && isPool(pool)) return pool; if (net === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool || '')) return pool;
  const k = net + '|' + addr, c = PL.get(k); if (c && Date.now() - c.at < POOL_TTL) return c.v;
  let v = '';
  try { const ch = net === 'robinhood' ? 'robinhood' : net; const a = D.AVT?.get(ch + addr)?.v?.pair?.addr; if (a && (net === 'solana' || isPool(String(a).toLowerCase()))) v = net === 'solana' ? a : String(a).toLowerCase(); } catch {}
  if (!v && GT_NET[net]) { const j = await gt(`${GT_NET[net]}/tokens/${addr}/pools?page=1`); const L = Array.isArray(j?.data) ? j.data : []; const best = L.map((p) => ({ a: String(p?.attributes?.address || ''), r: +p?.attributes?.reserve_in_usd || 0 })).filter((x) => x.a).sort((x, y) => y.r - x.r)[0]; if (best) v = net === 'solana' ? best.a : best.a.toLowerCase(); }
  if (v) { PL.set(k, { at: Date.now(), v }); if (PL.size > 500) PL.delete(PL.keys().next().value); }
  return v;
}
/* 雷达自己读链记的成交（发射台曲线币；已上外盘的币 graduated＝true） */
function local(net, addr, sec) {
  const src = net === 'bsc' ? [D.MK, D.V4B] : net === 'robinhood' ? [D.V4R] : [];
  for (const s of src) { try { if (!s || !s.has || !s.has(addr)) continue; const inf = s.info?.(addr) || {}; const r = s.candles(addr, sec); return { grad: !!inf.grad, pool: /^0x[0-9a-f]{40}$/.test(inf.pool || '') ? inf.pool : '', bars: Array.isArray(r) ? r : null, quoteWait: r?.err === 'quote' }; } catch {} }
  return null;
}
async function fromGt(net, pool, addr, tf, beforeMs) {
  if (!GT_NET[net] || !pool) return null; const [u, ag, mult] = GT[tf] || GT['5m']; const lim = Math.min(1000, BARS * mult);
  const q = `${GT_NET[net]}/pools/${pool}/ohlcv/${u}?aggregate=${ag}&limit=${lim}&currency=usd` + (addr ? `&token=${encodeURIComponent(addr)}` : '&token=base') + (beforeMs > 0 ? `&before_timestamp=${Math.floor(beforeMs / 1000)}` : '');
  const j = await gt(q); if (!j || j.err) return null; const L = (j.data?.attributes?.ohlcv_list || []).map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 })).filter((x) => x.t > 0 && x.h > 0).reverse();
  return L;
}
async function fromAve(net, id, tf) { if (!D.aveOK?.() || !id) return null; try { const L = await D.aveCandles(net, id, tf); return Array.isArray(L) && L.length ? L.filter((x) => !x.gap) : null; } catch { return null; } }
async function fromOkx(net, addr, tf, beforeMs) { try { if (!D.OKM?.ready?.(net)) return null; const L = await D.OKM.candles(net, addr, tf, beforeMs); return L && L.length ? L : null; } catch { return null; } }

async function hist0(net, addr, pool, tf, beforeMs) {
  const sec = SEC[tf]; const out = { src: '', pool: '', bars: [] };
  const loc = isEvm(addr) ? local(net, addr, sec) : null;
  if (loc && !loc.grad && loc.bars && loc.bars.length >= 2 && !(beforeMs > 0)) { out.src = 'chain'; out.bars = loc.bars; return out; } /* ① 曲线上的币 */
  if (loc && loc.grad && loc.pool) pool = loc.pool; /* 已上外盘：看上外盘的池子（画面给的可能是没人交易的旧池） */
  const P = await poolOf(net, addr, pool); out.pool = P;
  let L = await fromGt(net, P, addr, tf, beforeMs); if (L && L.length) out.src = 'gt'; /* ② GeckoTerminal */
  if (!out.src && !(beforeMs > 0)) { L = await fromAve(net, P || addr, tf); if (!L && P && P !== addr) L = await fromAve(net, addr, tf); if (L && L.length) out.src = 'ave'; } /* ③ AVE（没有往回翻页） */
  if (!out.src) { L = await fromOkx(net, addr, tf, beforeMs); if (L && L.length) out.src = 'okx'; } /* ④ OKX */
  if (!out.src && loc && loc.bars && loc.bars.length) { L = loc.bars; out.src = 'chain'; } /* ⑤ 读链记的 */
  if (!out.src) { if (loc?.quoteWait) out.err = 'quote'; return out; }
  L = KL.aggregate(L, sec); if (beforeMs > 0) L = L.filter((x) => x.t < beforeMs);
  L = KL.fillGaps(L, sec, BARS, beforeMs > 0 ? 0 : Date.now()); out.bars = L.slice(-BARS).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0 }));
  return out;
}
/* 同一个查询同时只跑一次＋短快取 */
async function hist(net, addr, pool, tf, beforeMs) {
  const k = [net, addr, pool, tf, beforeMs || 0].join('|'); const c = CK.get(k); if (c && Date.now() - c.at < ttlOf(tf)) return c.v; if (INF.has(k)) return INF.get(k);
  const p = hist0(net, addr, pool, tf, beforeMs).then((v) => { if (v.bars.length) { CK.set(k, { at: Date.now(), v }); if (CK.size > 300) CK.delete(CK.keys().next().value); } else if (c) return c.v; return v; }).finally(() => INF.delete(k));
  INF.set(k, p); return p;
}
function stat() { return { gt: { tokens: Math.floor(B.tok), cooling: B.cool > Date.now(), calls: B.n, n429: B.n429 }, cache: CK.size }; }
module.exports = { install, hist, stat, SEC };
