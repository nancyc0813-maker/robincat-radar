'use strict';
/* GTMKT-1114 新开盘补强：AVE 没有新币来源的链改用 GeckoTerminal（用户 11/14 同意「没有办法连接数据的想办法突破」，由主线转达；照 DexScreener「New pairs」、GMGN 新交易对的做法）：
   /networks/{n}/new_pools（官方 docs.coingecko.com/reference/latest-pools-network：48 小时内建立的池子，一页 20 个）
   补 Arbitrum／Polygon／HyperEVM（AVE 没有发射台 tag），以及 AVE new 清单 0 笔的 Robinhood／X Layer／Monad／Elysium。
   热门／涨幅／跌幅不用这里（主线 11/14 实测 AVE /v2/tokens/trending 这几条链都有资料，照共用看盘排）。
   GeckoTerminal 收的都是 DEX 池子（11/14 实测 Monad 没有 nad.fun 曲线池、X Layer 没有 flap 曲线池），看不出这个币是不是从发射台毕业来的 → 一律只放「新开盘」，不硬分「已上外盘」。
   规则：只读；有人在看那条链才抓（画面来要才抓，过期才在背景重抓）；资料留在记忆体；所有请求走 gtlim 共用限速（429 自动退避）；读不到＝不加，AVE 的照旧。
   排除：池子的主币是稳定币／主流币（USDC/WETH 这类）＝换钱用的池子，不是新币。 */
const GL = require('./gtlim.cjs');
const NET = { robinhood: 'robinhood', xlayer: 'x-layer', monad: 'monad', hyperevm: 'hyperevm', elysium: 'elysium', arbitrum: 'arbitrum', polygon: 'polygon_pos' }; /* 雷达链代号 → GeckoTerminal network id（11/14 实测 /networks/{id}/new_pools 都回 200） */
const NEW_CH = new Set(['arbitrum', 'polygon', 'hyperevm', 'xlayer', 'monad', 'elysium', 'robinhood']); /* 新开盘要补的链 */
const T = { newMs: 30e3, errMs: 15e3, keep: 200, lat: 200 }; /* 技术用：新池多久重抓（GeckoTerminal 免费版本身也有快取）、读失败多久后再试、每条链最多记几个新池、延迟样本留几个 */
const isBaseSym = (s) => /^(w?(eth|bnb|okb|pol|matic|mon|hype|btc)|cbbtc|usd[tcg1₮]|usd₮0|usdt0|usdc\.e|busd|dai|fdusd|eure|musd|xaut0?)$/i.test(String(s || '').trim()); /* 技术用：稳定币／主流币代号（换钱用的池子，不是「币」） */
const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>"'`]/g, '').trim().slice(0, n);
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const okEvm = (a) => /^0x[0-9a-f]{40}$/.test(a);
function rowOf(p, inc) { const a = p?.attributes || {}; const tid = String(p?.relationships?.base_token?.data?.id || ''); const c = tid.slice(tid.lastIndexOf('_') + 1).toLowerCase(); /* id 像 polygon_pos_0x…（链代号本身有底线）→ 取最后一段 */ if (!okEvm(c)) return null;
  const tk = inc.get(tid) || {}; const nm = String(a.name || ''); const sym = txt(tk.symbol || nm.split(' / ')[0], 20); if (isBaseSym(sym)) return null;
  const ch = a.price_change_percentage || {}, v = a.volume_usd || {}, tx = a.transactions || {}; const tn = (k) => (tx[k] ? (+tx[k].buys || 0) + (+tx[k].sells || 0) : null);
  const ca = Date.parse(a.pool_created_at || ''); const img = /^https:\/\/[^\s"'<>]{4,300}$/.test(String(tk.image_url || '')) ? String(tk.image_url) : '';
  return { c, pool: String(a.address || '').toLowerCase(), sym, name: txt(tk.name || '', 40), lg: img, price: num(a.base_token_price_usd), mc: num(a.market_cap_usd), fdv: num(a.fdv_usd), liq: num(a.reserve_in_usd),
    v5: num(v.m5), v1: num(v.h1), v6: num(v.h6), v24: num(v.h24), c5: num(ch.m5), c1: num(ch.h1), c6: num(ch.h6), c24: num(ch.h24), tx1: tn('h1'), tx24: tn('h24'),
    by24: tx.h24 ? num(tx.h24.buyers) : null, sl24: tx.h24 ? num(tx.h24.sellers) : null, ca: Number.isFinite(ca) ? Math.floor(ca / 1000) : null, dex: txt(p?.relationships?.dex?.data?.id, 40), src: 'geckoterminal' }; }
function parse(j) { const inc = new Map(); for (const x of Array.isArray(j?.included) ? j.included : []) if (x?.type === 'token' && x.id) inc.set(String(x.id), x.attributes || {}); return (Array.isArray(j?.data) ? j.data : []).map((p) => rowOf(p, inc)).filter(Boolean); }
const errTxt = (st) => (st === 'limit' ? 'GeckoTerminal 限速中（雷达自己排队，稍后自动更新）' : st === 429 ? 'GeckoTerminal 忙（被限流，自动退避后再试）' : st === 'net' ? '连不上 GeckoTerminal' : 'GeckoTerminal 回 ' + st);
async function fetchList(path, bg) { const r = await GL.main().get(path, { bg }); if (r.st !== 200) return { err: errTxt(r.st) }; return { L: parse(r.j) }; }

/* ── ② 新开盘 ── */
const NP = new Map(); /* 链 → { at, list: Map(合约 → row＋pt), err, busy, first, want, lat:[] } */
async function newFetch(ch) { const n = NET[ch]; const e = NP.get(ch); if (!e || e.busy) return; e.busy = 1;
  try { const r = await fetchList(`networks/${n}/new_pools?page=1&include=base_token`, 1); const now = Date.now(); if (!r.L) { e.err = r.err; e.at = now - T.newMs + T.errMs; return; }
    for (const x of r.L) { const o = e.list.get(x.c); if (o) { e.list.set(x.c, { ...x, pt: o.pt, pool: o.pool || x.pool }); continue; } x.pt = now; e.list.set(x.c, x);
      if (e.first && x.ca) { e.lat.push({ c: x.c, d: now - x.ca * 1000 }); if (e.lat.length > T.lat) e.lat.shift(); } } /* 第一次抓到的是积压的旧池子，不算延迟；之后新出现的＝池子建立时间 → 雷达看到的时间 */
    while (e.list.size > T.keep) e.list.delete(e.list.keys().next().value); e.first = 1; e.at = now; e.err = ''; } finally { e.busy = 0; } }
/* 多链看盘要这条链的新开盘时叫：过期就背景重抓（不挡画面），回现在有的（新到旧） */
function fresh(ch) { if (!NEW_CH.has(ch)) return []; let e = NP.get(ch); if (!e) { e = { at: 0, list: new Map(), err: '', busy: 0, first: 0, lat: [] }; NP.set(ch, e); } e.want = Date.now();
  if (Date.now() - e.at > T.newMs) newFetch(ch).catch(() => {}); return [...e.list.values()].sort((a, b) => (b.ca ?? 0) - (a.ca ?? 0)); }
function ver(ch) { const e = NP.get(ch); return e ? e.at : 0; }
function latStat(ch) { const L = (NP.get(ch)?.lat || []).map((x) => x.d).sort((a, b) => a - b); if (!L.length) return { n: 0 }; const q = (p) => L[Math.min(L.length - 1, Math.floor(p * L.length))]; return { n: L.length, p50: q(0.5), max: L[L.length - 1], min: L[0] }; }
function stat() { const o = { lim: GL.main().stat(), fresh: {} }; for (const [k, e] of NP) o.fresh[k] = { at: e.at, n: e.list.size, err: e.err, lat: latStat(k) }; return o; }
module.exports = { NET, NEW_CH, fresh, ver, stat, latStat, _parse: parse, _NP: NP, _newFetch: newFetch };
