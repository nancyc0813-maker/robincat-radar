'use strict';
/* KH-1113 K 线历史（给新版 TradingView 图表用）：klineHist(net, addr, pool, interval, beforeMs)
   回传 [{ t 毫秒（K 棒开始）, o, h, l, c, v 美金成交量 }]，旧到新；最后一根是「到现在为止」的那根，画面再用成交明细即时更新。
   资料来源顺序：① 还在发射台曲线上的币＝雷达自己读链记的成交（远端多半还没收录）② GeckoTerminal（免费、不用金钥，不花 AVE 额度；
   每个 IP 每分钟约 30 次 → 本机令牌桶限速＋快取）③ AVE（经转接站，共用额度）④ OKX（玩家自己的金钥，有开才用）⑤ 雷达读链记的成交（已上外盘、上面都读不到时）。
   资料源没有的周期（3 小时、6 小时、3 天、周、月）用小周期合并；周线＝周一开始、月线＝日历月（跟其他图同一套格子 kline.cjs）。 */
const KL = require('./kline.cjs');

const SEC = { '1s': 1, '4h': 14400, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '3h': 10800, '6h': 21600, '12h': 43200, '1d': 86400, '3d': 259200, '1w': 604800, '1M': 2592000 };
/* GeckoTerminal 只有 day(1)／hour(1,4,12)／minute(1,5,15)：[时间单位, aggregate, 几根合成一根] */
const GT = { '4h': ['hour', 4, 1], '1m': ['minute', 1, 1], '5m': ['minute', 5, 1], '15m': ['minute', 15, 1], '1h': ['hour', 1, 1], '3h': ['hour', 1, 3], '6h': ['hour', 1, 6], '12h': ['hour', 12, 1], '1d': ['day', 1, 1], '3d': ['day', 1, 3], '1w': ['day', 1, 7], '1M': ['day', 1, 31] };
const GT_NET = { bsc: 'bsc', robinhood: 'robinhood', solana: 'solana', base: 'base', eth: 'eth', xlayer: 'x-layer', arbitrum: 'arbitrum', polygon: 'polygon_pos', monad: 'monad', hyperevm: 'hyperevm', elysium: 'elysium' }; /* 技术用：GeckoTerminal 的链代号（11/13 查过 /networks 有 robinhood；KNET-1114 11/14 逐页查 /api/v2/networks：x-layer「x Layer」、polygon_pos「Polygon POS」、arbitrum、monad、hyperevm、elysium（coingecko_asset_platform_id elysium-kinetiq＝Kinetiq 给 Hyperliquid 的 L2，跟 elysium.mjs 同一条），每条都用 trending_pools 实测有池子） */
const BARS = 300; /* 技术用：一次给几根 */
const LIVE_TTL = 1500; /*CHAINK-1115 技术用：读链画的 K 线快取多久（新成交要很快接上）*/
const POOL_TTL = 30 * 60e3; /* 技术用：币→池子 对应快取多久 */
const ttlOf = (tf) => (SEC[tf] <= 300 ? 15e3 : SEC[tf] <= 3600 ? 30e3 : 120e3); /* 技术用：K 线快取多久（最新一根画面用成交即时更新） */

let D = {}; /* 依赖：aveCandles, aveOK, MK, V4B, V4R, AVT, OKM */
function install(deps) { D = deps || {}; }
const B = { n: 0, n429: 0 }; /* 这个档自己打了几次（限速在 gtlim.cjs） */
async function gt(u, ctx, bg) { const o = bg ? { bg: 1 } : ctx && ctx.pri ? { pri: 1 } : {}; if (ctx && ctx.noWait) o.waitMs = 0; /*CHAINK-1115 已经有读链的 K 棒时，GeckoTerminal 只补更早的历史：拿不到令牌就不等*/ const r = await require('./gtlim.cjs').main().get('networks/' + u, o); if ((r.st === 'limit' || r.st === 429) && ctx) ctx.busy = 1; /*KNET-1114 限速／冷却中：回给画面「资料来源忙，自动重试中」，不是「没有成交」*/ /*GTLIM-1114 改用整个雷达共用的 GeckoTerminal 限速（以前这里自己一个桶每分钟约 27 次，加上别处会超过）*/ if (r.st === 'net' && ctx) ctx.net = 1; /*DOWN-1115 连不上（不是限速、也不是没资料）→ 画面写「读不到」*/ if (r.st === 'limit' || r.st === 429 || r.st === 'net') { if (r.st === 429) B.n429++; return null; } B.n++; if (r.st !== 200) return { err: r.st }; return r.j; }

const CK = new Map(), INF = new Map(), PL = new Map();
const isEvm = (a) => /^0x[0-9a-f]{40}$/.test(a), isPool = (p) => /^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(p);
/* 找池子：画面给的 → 发射台上外盘的池子（雷达读链）→ AVE 主池（快取里有就用）→ GeckoTerminal 流动性最大的池 */
/* GeckoTerminal 上这个币流动性最大的池子 */
const GTP = new Map(); /* 币 → GeckoTerminal 最大池（快取 POOL_TTL，免得没成交的币每次都多问一次） */
async function gtTop(net, addr, ctx, bg, by) { const k = net + '|' + addr + '|' + (by || ''), c = GTP.get(k); if (c && Date.now() - c.at < POOL_TTL) return c.v; const v = await gtTop0(net, addr, ctx, bg, by); if (v || !ctx?.busy) { GTP.set(k, { at: Date.now(), v }); if (GTP.size > 500) GTP.delete(GTP.keys().next().value); } return v; }
async function gtTop0(net, addr, ctx, bg, by) { const j = await gt(`${GT_NET[net]}/tokens/${addr}/pools?page=1`, ctx, bg); const L = Array.isArray(j?.data) ? j.data : []; const best = L.map((p) => { const A = p?.attributes || {}, x = A.transactions?.h1 || {}; return { a: String(A.address || ''), r: by === 'tx' ? (+x.buys || 0) + (+x.sells || 0) : by === 'vol' ? +A.volume_usd?.h24 || 0 : +A.reserve_in_usd || 0 }; }) /* by＝'tx'：挑最近 1 小时成交笔数最多的池子（成交明细用） */.filter((x) => x.a).sort((x, y) => y.r - x.r)[0]; return best ? (net === 'solana' ? best.a : best.a.toLowerCase()) : ''; }
/*KWHY2-1115 GeckoTerminal／AVE 都没给池子时，问 DexScreener 有没有交易池：有＝「K 线来源还没收录这个池子」（例 Robinhood 的 Uniswap V4 池 CLAU），没有才说「未开盘」（以前一律写未开盘，跟 DexScreener 看得到池子矛盾） */
const DS_NET = { bsc: 'bsc', robinhood: 'robinhood', solana: 'solana', eth: 'ethereum', base: 'base', arbitrum: 'arbitrum', polygon: 'polygon', xlayer: 'xlayer' }; /* 技术用：DexScreener 的链代号（11/15 逐条用 /tokens/v1/{链}/{币} 查过） */
const DSP = new Map(); const DS_TO_MS = 8000; /* 技术用：DexScreener 最多等几毫秒 */
/*MPOOL-1115 主池子（K 线和成交明细用同一个）：照 GMGN／AVE／DexScreener——上外盘后看 DEX 主池，不看发射台曲线；挑法＝最近一天成交额最大（一样就看流动性）。
  来源顺序：DexScreener（不占 GeckoTerminal 限速、有 V4 池）→ GeckoTerminal 币的池子清单 → AVE 交易对。例：旺财（Flap 上外盘到 Pancake 0x44ce…）、SNDKc（Base，Aerodrome 0x2836…，不是 AVE 给的 V4 池）。 */
const CURVE_DEX = new Set(['flapsh', 'fourmeme', 'four', 'pumpfun', 'pump', 'moonshot', 'letsbonk', 'bonk', 'boop', 'believe', 'virtuals']); /* 技术用：DexScreener 把发射台曲线也当一个「池」，这些 dexId 是曲线，不是上外盘的池子 */
const DS_CURVE_TTL = 60e3; /* 技术用：只看到发射台曲线时多久再问一次（上外盘要尽快发现） */
async function dsPairs(net, addr) { if (!DS_NET[net]) return null; const k = net + '|' + addr, c = DSP.get(k); if (c && Date.now() - c.at < (c.dex ? POOL_TTL : DS_CURVE_TTL)) return c.v; let L; try { const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${addr}`, { signal: AbortSignal.timeout(DS_TO_MS) }); if (!r.ok) return c ? c.v : null; const j = await r.json(); L = j && typeof j === 'object' ? (Array.isArray(j.pairs) ? j.pairs : []).filter((p) => p?.chainId === DS_NET[net]) : null; /* 没有任何交易对时 DexScreener 回 pairs: null＝真的没有，不是读不到 */ } catch { return c ? c.v : null; } if (!Array.isArray(L)) return c ? c.v : null; /* /tokens/v1 只回一个交易对（旺财只回 Flap 曲线、quq 只回小池），要用 /latest/dex/tokens 拿全部 */
  const v = L.map((p) => ({ a: net === 'solana' ? String(p?.pairAddress || '') : String(p?.pairAddress || '').toLowerCase(), dex: String(p?.dexId || ''), curve: CURVE_DEX.has(String(p?.dexId || '')), base: (net === 'solana' ? String(p?.baseToken?.address || '') : String(p?.baseToken?.address || '').toLowerCase()) === addr, vol: +p?.volume?.h24 || 0, liq: +p?.liquidity?.usd || 0 })).filter((x) => x.a); DSP.set(k, { at: Date.now(), v, dex: v.some((x) => !x.curve) }); if (DSP.size > 500) DSP.delete(DSP.keys().next().value); return v; }
const pickBest = (L) => L.slice().sort((x, y) => y.vol - x.vol || y.liq - x.liq)[0] || null;
async function mainPool(net, addr, ctx, bg) { const D0 = await dsPairs(net, addr); if (D0 === null && DS_NET[net] && ctx) ctx.dsFail = 1; if (D0 && D0.length) { const dex = D0.filter((x) => !x.curve); const pool0 = dex.length ? dex : D0; const own = pool0.filter((x) => x.base); const b = pickBest(own.length ? own : pool0); /* 这个币当「基础币」的交易对优先（DexScreener 也会列出拿它当报价币的别人的池子，例 hXMAX 被 WOLFPACK 拿来配对）*/ if (b) return { pool: b.a, dex: dex.length > 0, src: 'ds' }; }
  if (GT_NET[net]) { const g = await gtTop(net, addr, ctx, bg, 'vol'); if (g) return { pool: g, dex: true, src: 'gt' }; }
  try { const a = D.AVT?.get(net + addr)?.v?.pair?.addr; if (a && (net === 'solana' || isPool(String(a).toLowerCase()))) return { pool: net === 'solana' ? a : String(a).toLowerCase(), dex: true, src: 'ave' }; } catch {}
  return { pool: '', dex: false, src: '' }; }
async function poolOf(net, addr, pool, ctx, bg) {
  if (net !== 'solana' && isPool(pool)) return pool; if (net === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pool || '')) return pool;
  const k = net + '|' + addr, c = PL.get(k); if (c && Date.now() - c.at < POOL_TTL) return c.v;
  const v = (await mainPool(net, addr, ctx, bg)).pool; /*MPOOL-1115 跟成交明细同一个主池*/
  if (v) { PL.set(k, { at: Date.now(), v }); if (PL.size > 500) PL.delete(PL.keys().next().value); }
  return v;
}
/* 雷达自己读链记的成交（发射台曲线币；已上外盘的币 graduated＝true） */
function local(net, addr, sec) {
  const src = net === 'bsc' ? [D.MK, D.V4B] : net === 'robinhood' ? [D.V4R] : [];
  for (const s of src) { try { if (!s || !s.has || !s.has(addr)) continue; const inf = s.info?.(addr) || {}; const r = s.candles(addr, sec); return { grad: !!inf.grad, pool: /^0x[0-9a-f]{40}$/.test(inf.pool || '') ? inf.pool : '', bars: Array.isArray(r) ? r : null, quoteWait: r?.err === 'quote' }; } catch {} }
  return null;
}
async function fromGt(net, pool, addr, tf, beforeMs, ctx) {
  if (!GT_NET[net] || !pool) return null; const [u, ag, mult] = GT[tf] || GT['5m']; const lim = Math.min(1000, BARS * mult);
  const q = `${GT_NET[net]}/pools/${pool}/ohlcv/${u}?aggregate=${ag}&limit=${lim}&currency=usd` + (addr ? `&token=${encodeURIComponent(addr)}` : '&token=base') + (beforeMs > 0 ? `&before_timestamp=${Math.floor(beforeMs / 1000)}` : '');
  const j = await gt(q, ctx); if (!j || j.err) return null; const L = (j.data?.attributes?.ohlcv_list || []).map((r) => ({ t: r[0] * 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 })).filter((x) => x.t > 0 && x.h > 0).reverse();
  return L;
}
async function fromAve(net, id, tf) { if (!D.aveOK?.() || !id) return null; try { const L = await D.aveCandles(net, id, tf); return Array.isArray(L) && L.length ? L.filter((x) => !x.gap) : null; } catch { return null; } }
async function fromOkx(net, addr, tf, beforeMs) { try { if (!D.OKM?.ready?.(net)) return null; const L = await D.OKM.candles(net, addr, tf, beforeMs); return L && L.length ? L : null; } catch { return null; } }

async function hist0(net, addr, pool, tf, beforeMs, pri) {
  const sec = SEC[tf]; const out = { src: '', pool: '', bars: [] }; const ctx = { pri: !!pri };
  const loc = isEvm(addr) ? local(net, addr, sec) : null;
  let gradX = false; if (loc && !loc.grad) { const M = await mainPool(net, addr, ctx); if (M.dex && M.pool) { gradX = true; if (!isPool(pool)) pool = M.pool; } } /*MPOOL-1115 雷达没记到上外盘（例 Flap 用自订报价币上 Pancake 的旺财），但 DexScreener 已经有 DEX 池＝已上外盘，看那个池子，不再画很久以前的曲线成交*/
  if (loc && !loc.grad && !gradX && loc.bars && loc.bars.length >= 2 && !(beforeMs > 0)) { out.src = 'chain'; out.bars = loc.bars; return out; } /* ① 曲线上的币 */
  if (loc && loc.grad && loc.pool) pool = loc.pool; /* 已上外盘：看上外盘的池子（画面给的可能是没人交易的旧池） */
  const P = await poolOf(net, addr, pool, ctx); out.pool = P;
  let CB = null; if ((net === 'bsc' || net === 'robinhood') && D.chainK && P && !(beforeMs > 0) && sec >= SEC['1m']) { const r = await D.chainK(net, addr, P, sec).catch(() => null); if (r && r.bars && r.bars.length) CB = r; } /*CHAINK-1115 ② 已上外盘的 BNB Chain／Robinhood 币：读链上成交自己画（几百毫秒），不用等 GeckoTerminal*/
  if (CB) ctx.noWait = 1;
  let L = await fromGt(net, P, addr, tf, beforeMs, ctx); if (L && L.length) out.src = 'gt'; /* ③ GeckoTerminal（有读链的 K 棒时只补更早的历史） */
  if (CB) { const f0 = CB.bars[0].t; const old = (L || []).filter((x) => x.t < f0); L = old.concat(CB.bars); out.src = old.length ? 'chain+gt' : 'chain'; out.live = 1; ctx.busy = 0; }
  if (!out.src && !(beforeMs > 0)) { L = await fromAve(net, P || addr, tf); if (!L && P && P !== addr) L = await fromAve(net, addr, tf); if (L && L.length) out.src = 'ave'; } /* ③ AVE（没有往回翻页） */
  if (!out.src) { L = await fromOkx(net, addr, tf, beforeMs); if (L && L.length) out.src = 'okx'; } /* ④ OKX */
  if (!out.src && /^0x[0-9a-f]{64}$/.test(P || '') && D.v4) { const r = await D.v4(net, P, addr).catch(() => null); if (r && r.rows && r.rows.length) { L = r.rows.map((x) => ({ t: x.t, o: x.p, h: x.p, l: x.p, c: x.p, v: x.usd })); out.src = 'chain-v4'; } } /*V4T-1115 GeckoTerminal 没收录的 Uniswap V4 池（例 Robinhood 的 CLAU）：雷达自己读 PoolManager 的 Swap 事件做 K 线（AVE 也画得出来）*/
  if (!out.src && !gradX && loc && loc.bars && loc.bars.length) { L = loc.bars; out.src = 'chain'; } /* ⑤ 读链记的 */
  if (!out.src) { if (loc?.quoteWait) out.err = 'quote'; else if (ctx.busy) out.err = 'busy'; else if (ctx.net) out.err = 'down'; else if (!P && !loc) out.err = ctx.dsFail ? 'down' : 'nopool'; else if (P) out.err = 'nosrc'; /*KWHY-1114 找不到交易池、雷达也没在发射台曲线上看到＝还没开盘（AVE 空图写「未開盤」）*/ return out; }
  L = KL.aggregate(L, sec); if (beforeMs > 0) L = L.filter((x) => x.t < beforeMs);
  { const F = KL.fillGaps(L, sec, BARS, beforeMs > 0 ? 0 : Date.now()); L = L.length && !F.some((x) => !x.gap) ? KL.fillGaps(L, sec, BARS, 0) : F; } /*CHAINK-1115 最后一笔成交比 300 根还早（冷门币）：不要用补到现在的平盘把真的 K 棒全挤掉，照 GMGN 画到最后一笔为止*/ out.bars = clean(L.slice(-BARS).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0, ...(x.gap ? { gap: 1 } : {}) })));
  return out;
}
/*KDATA-1113 离谱影线（资料源单笔异常成交，例 O 33／H 4495／C 34）：原始值照留在 h／l，另外给 hc／lc＝去掉离谱部分的高低（影线超过实体 WICK_K 倍就截到实体），
  并标 ow:1；画图用 hc／lc 缩放纵轴，AVE／GMGN 一样不让单笔异常把整张图压平。开盘那根从接近 0 拉上来（o 远小于后面价格）标 op:1（画图可以不拿它撑轴） */
const WICK_K = 2, OPEN_K = 100; /* 技术用（只影响画图）：影线最多到实体的几倍、开盘价比收盘小几倍以上算「从 0 拉上来」 */
function clean(B) { for (const x of B) { const top = Math.max(x.o, x.c), bot = Math.min(x.o, x.c); x.hc = x.h > top * WICK_K ? top : x.h; x.lc = bot > 0 && x.l < bot / WICK_K ? bot : x.l; if (x.hc !== x.h || x.lc !== x.l) x.ow = 1; } if (B.length && B[0].o > 0 && B[0].c > B[0].o * OPEN_K) B[0].op = 1; return B; }
/* 成交明细里 GeckoTerminal 标为异常（is_anomalous）的不算 */
/* 同一个查询同时只跑一次＋短快取 */
async function hist(net, addr, pool, tf, beforeMs, pri) {
  const k = [net, addr, pool, tf, beforeMs || 0].join('|'); const c = CK.get(k); if (c && Date.now() - c.at < (c.v.live ? LIVE_TTL : ttlOf(tf))) return c.v; if (INF.has(k)) return INF.get(k);
  const p = hist0(net, addr, pool, tf, beforeMs, pri).then((v) => { if (v.bars.length) { CK.set(k, { at: Date.now(), v }); if (CK.size > 300) CK.delete(CK.keys().next().value); } else if (c) return c.v; return v; }).finally(() => INF.delete(k));
  INF.set(k, p); return p;
}
function stat() { return { gt: { ...require('./gtlim.cjs').main().stat(), mine: B.n, mine429: B.n429 }, cache: CK.size }; }
/*MCK-1113 成交明细（GeckoTerminal /pools/{pool}/trades，免费、不花 AVE 额度；它给最近一段时间的成交）：多链详情的 K 线最后一根即时更新、1 秒线。
  GeckoTerminal 自己约慢几十秒（11/13 实测 Solana 最新一笔约 38 秒前），所以「即时」＝跟它一样快，不是逐笔秒级 */
const TR = new Map(), TR_TTL = 3e3; /* 技术用：同一个池子的成交多久内共用一次 */
async function trades(net, addr, pool, bg, noFb) { if (!GT_NET[net]) return { rows: [], err: 'nochain' }; const ctx = {}; const P = await poolOf(net, addr, pool, ctx, bg); if (!P) return { rows: [], pool: '', ...(ctx.busy ? { err: 'busy' } : {}) }; const k = net + '|' + P + '|' + addr, c = TR.get(k); if (c && Date.now() - c.at < TR_TTL) return c.v;
  if (/^0x[0-9a-f]{64}$/.test(P) && D.v4 && D.v4ok && D.v4ok(net)) { const r = await D.v4(net, P, addr).catch(() => null); if (r && r.rows && r.rows.length) { const v4 = { rows: r.rows.slice(-BARS), pool: P }; TR.set(k, { at: Date.now(), v: v4 }); return v4; } } /*V4T-1115 雷达读得到的 V4 池（Robinhood）先读链：免费、不占 GeckoTerminal 限速*/
  const j = await gt(`${GT_NET[net]}/pools/${P}/trades`, ctx, bg); if ((!j || j.err) && !(/^0x[0-9a-f]{64}$/.test(P) && D.v4 && !ctx.busy)) return c ? c.v : { rows: [], pool: P, err: ctx.busy ? 'busy' : ctx.net ? 'down' : 'gt' }; const same = (x) => (net === 'solana' ? String(x || '') === addr : String(x || '').toLowerCase() === addr);
  const rows = (Array.isArray(j?.data) ? j.data : []).map((d) => { const a = d?.attributes || {}; const buy = same(a.to_token_address), sell = same(a.from_token_address); if ((!buy && !sell) || a.is_anomalous === true) return null; const p = +(buy ? a.price_to_in_usd : a.price_from_in_usd); const t = Date.parse(a.block_timestamp || ''); if (!(p > 0) || !(t > 0)) return null; return { t, p, usd: +a.volume_in_usd || 0, b: buy ? 1 : 0, w: String(a.tx_from_address || '').slice(0, 64), tx: String(a.tx_hash || '').slice(0, 100) }; }).filter(Boolean).sort((x, y) => x.t - y.t);
  /*TRPOOL-1115 AVE 挑的池子在 GeckoTerminal 没有成交明细（例 Base 的 SNDKc：AVE 给 Uniswap V4 池，GeckoTerminal 那个池子 0 笔；最活跃的是 Aerodrome 池，DexScreener 5 分钟 50 多笔）→ 改看 GeckoTerminal 上最近 1 小时成交最多的池子（流动性最大的可能就是同一个 V4 池） */
  if (!rows.length && /^0x[0-9a-f]{64}$/.test(P) && D.v4) { const r = await D.v4(net, P, addr).catch(() => null); if (r && r.rows && r.rows.length) { const v4 = { rows: r.rows.slice(-BARS), pool: P }; TR.set(k, { at: Date.now(), v: v4 }); return v4; } } /*V4T-1115*/
  if (!rows.length && !noFb) { const P2 = await gtTop(net, addr, ctx, bg, 'tx'); if (P2 && P2 !== P) { const r2 = await trades(net, addr, P2, bg, 1); if (r2.rows.length) { TR.set(k, { at: Date.now(), v: r2 }); return r2; } } }
  const v = { rows, pool: P }; TR.set(k, { at: Date.now(), v }); if (TR.size > 200) TR.delete(TR.keys().next().value); return v; }
/* 1 秒线：只有成交明细做得出来（AVE／GeckoTerminal 的 K 线最小 1 分钟） */
async function sec1(net, addr, pool) { const r = await trades(net, addr, pool); if (!r.rows.length) return { src: '', pool: r.pool || '', bars: [], ...(r.err === 'busy' || r.err === 'down' ? { err: r.err } : {}) }; const L = KL.aggregate(r.rows.map((x) => ({ t: x.t, o: x.p, h: x.p, l: x.p, c: x.p, v: x.usd })), 1); return { src: 'gt-trades', pool: r.pool, bars: KL.fillGaps(L, 1, BARS, Date.now()).slice(-BARS).map((x) => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0 })) }; }
/*TAPEPOOL-1115 成交明细没拿到池子时，跟 K 线用同一个挑池子的规则（AVE 交易对 → GeckoTerminal 流动性最大的池），共用快取／限速 */
async function pool(net, addr) { const ctx = {}; const v = await poolOf(net, addr, '', ctx).catch(() => ''); return { pool: v || '', busy: !!ctx.busy }; }
async function main(net, addr) { const ctx = {}; const r = await mainPool(net, addr, ctx).catch(() => null); return { ...(r || { pool: '', dex: false }), busy: !!ctx.busy }; }
module.exports = { install, hist, stat, SEC, trades, sec1, GT_NET, pool, main };
