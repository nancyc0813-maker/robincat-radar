// BOARD124 罗宾猫雷达 · 看盘新资料路线（雷达视窗这边）
// ① 看盘清单＋价格：向转接站 GET /aveboard2 拿（转接站自己抓 AVE、所有用户共用一份；不用作者电脑上传、不用签名档）。
//    只拿「上次之后有变的币」（since＝变动序号），跟旧的签名看盘档（/aveboard，持有人标签／聪明钱）合并；拿不到就照旧用签名档。
//    资料只放在记忆体，不写 ave_board.json（引擎读的那份不变）。
// ② 搜寻：自动判断链（0x＝BNB Chain／Robinhood／Ethereum／Base，base58＝Solana），查不到用 AVE 关键字搜寻（经转接站），再不行用 DexScreener 公开搜寻。
// ③ 详情成交：已上外盘、雷达读不到池子（V3／V4／Infinity）→ 用 AVE 成交（/v2/txs/swap，经转接站）；美金照这个池子的实际成交价。
// 只读：不碰钱包、不下单、不改买卖设定；读不到＝null（画面显示「读不到」），不当 0。
'use strict';
let X = null; /* install 传进来的：relay()、hdr(R)、drop()、aveGet(p, cu) */
const S = { m: {}, cols: {}, colsAt: {}, seq: 0, boot: '', at: 0, okAt: 0, tryAt: 0, busy: 0, err: '', q: null, poll: null, tagErr: {}, rev: 0 };
const FALLBACK_POLL_MS = 2000; /* 技术用：转接站没说多久刷新时的预设（转接站有给就照它的 AVE_BOARD_PRICE_S） */
const pollMs = () => { const ws = (() => { try { return !!X?.wsOn?.(); } catch { return false; } })(); /* AVE 即时推送正常（画面看得到的币价格走 /avews）→ 只照清单的频率来拿；推送断线才照价格频率补 */ if (ws && S.poll && +S.poll.list > 0) return +S.poll.list * 1000; return S.poll && +S.poll.price > 0 ? +S.poll.price * 1000 : FALLBACK_POLL_MS; };
async function pull() {
  if (!X || S.busy) return; const R = X.relay(); if (!R) { S.err = 'relay'; return; } S.busy = 1; S.tryAt = Date.now();
  try { const H = await X.hdr(R); if (!H) { S.err = 'session'; try { S.why = String(X.why?.() || '').slice(0, 120); } catch {} return; } S.why = ''; /*HOT126*/
    const r = await fetch(R + '/aveboard2?' + new URLSearchParams({ since: String(S.seq || 0), boot: S.boot || '', px: (() => { try { return X?.wsOn?.() ? '0' : '1'; } catch { return '1'; } })() }), { headers: H, signal: AbortSignal.timeout(20000) });
    if (r.status === 401) { try { X.drop(); } catch {} S.err = 'session'; S.why = 'relay 401'; return; } if (!r.ok) { S.err = 'HTTP ' + r.status; try { S.why = String((await r.json())?.err || '').slice(0, 120); } catch {} return; }
    const j = await r.json(); if (!j || j.v !== 2 || typeof j.m !== 'object') { S.err = 'bad'; return; } merge(j); S.err = j.err || ''; S.okAt = Date.now();
  } catch (e) { S.err = 'net'; S.why = String(e?.cause?.code || e?.name || e?.message || e).slice(0, 80); } finally { S.busy = 0; } } /*HOT126 连线失败＝net（原文放 why）*/
const B2_STALE_MS = 10 * 60e3; /*HOT126 技术用：跟 next.cjs 的 B2_FRESH_MS 一样，超过就算连不上（画面写原因）*/
function stat() { const fresh = !!S.okAt && Date.now() - S.okAt < B2_STALE_MS; return { ok: fresh ? 1 : 0, err: fresh ? '' : S.err || (S.okAt ? 'stale' : ''), why: fresh ? '' : S.why || '', okAt: S.okAt || 0, tryAt: S.tryAt || 0, busy: S.busy ? 1 : 0 }; }
function merge(j) {
  if (j.full || j.boot !== S.boot) S.m = {}; S.boot = String(j.boot || ''); S.seq = +j.seq || 0;
  for (const [ch, M] of Object.entries(j.m || {})) { if (!/^[a-z]{2,20}$/.test(ch) || !M || typeof M !== 'object') continue; const D = (S.m[ch] = S.m[ch] || {}); for (const [a, v] of Object.entries(M)) if (v && typeof v === 'object') D[a] = v; }
  S.cols = j.cols && typeof j.cols === 'object' ? j.cols : S.cols; S.colsAt = j.colsAt || S.colsAt; S.at = +j.at || S.at; S.q = j.q || null; S.poll = j.poll || S.poll; S.tagErr = j.tagErr || {}; S.kinds = j.kinds && typeof j.kinds === 'object' ? j.kinds : null; S.backoff = +j.backoff || 0; S.scout = j.scout && typeof j.scout === 'object' ? j.scout : S.scout; /*SCOUT-1112 转接站扫到的新发射台*/
  { const keep = new Set(Object.values(S.cols).flat()); for (const M of Object.values(S.m)) for (const a of Object.keys(M)) if (!keep.has(a) && Date.now() - (+M[a].u || 0) > 6 * 3600e3 /* 技术用：记忆体里多久没更新的币拿掉 */) delete M[a]; }
  S.rev++; }
/* 跟旧的签名看盘档合并：清单／价格以转接站为准，旧档的持有人标签（ht）、聪明钱（sm／sw）照留 */
let MG = { rev: -1, old: null, v: null };
function board(old, slow) { /*SWR-1113 slow＝多链看盘来拿：最快照转接站清单的刷新间隔（poll.list）才重拉，不照价格的间隔（推送断线时会变成每几秒拉一次整份）*/
  if (S.okAt && Date.now() - S.tryAt >= (slow && S.poll && +S.poll.list > 0 ? Math.max(pollMs(), +S.poll.list * 1000) : pollMs())) pull().catch(() => {}); else if (!S.okAt && Date.now() - S.tryAt >= 15e3 /* 技术用：转接站还没有这个功能（旧版转接站）时多久再试 */) pull().catch(() => {});
  if (!S.okAt) return old; if (MG.rev === S.rev && MG.old === old) return MG.v;
  const m = {}; for (const ch of new Set([...Object.keys(old?.m || {}), ...Object.keys(S.m)])) { const a = old?.m?.[ch] || {}, b = S.m[ch] || {}; const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = a[k] ? { ...a[k], ...v } : v; m[ch] = o; }
  const v = { ...(old || {}), at: S.at || Date.now(), m, cols: { ...(old?.cols || {}), ...S.cols }, colsAt: { ...(old?.colsAt || {}), ...S.colsAt }, kinds: S.kinds, b2: { at: S.at, okAt: S.okAt, err: S.err, q: S.q, tagErr: S.tagErr, backoff: S.backoff || 0 } };
  MG = { rev: S.rev, old, v }; return v; }
/* ② 搜寻 */
const EVM = /^0x[0-9a-fA-F]{40}$/, B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CHN = { bsc: 'bsc', robinhood: 'robinhood', solana: 'solana', eth: 'eth', base: 'base', ethereum: 'eth' };
const fin = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
function guess(q) { q = String(q || '').trim(); if (EVM.test(q)) return { kind: 'evm', c: q.toLowerCase(), chains: ['bsc', 'robinhood', 'eth', 'base'] }; if (B58.test(q) && !/^0x/.test(q)) return { kind: 'sol', c: q, chains: ['solana'] }; if (/^[\w$.\- ]{1,40}$/.test(q)) return { kind: 'kw', c: '', chains: [] }; return { kind: 'bad' }; }
async function search(o) {
  const q = String(o?.q || '').trim().slice(0, 64); const g = guess(q); if (g.kind === 'bad') return { err: 'bad', items: [] };
  const items = []; const add = (x) => { if (!x.c || !CHN[x.chain]) return; const k = x.chain + ':' + (x.chain === 'solana' ? x.c : x.c.toLowerCase()); if (items.some((y) => y.k === k)) return; items.push({ ...x, k }); };
  let src = '', why = '';
  if (X?.aveGet) { try { const p = '/v2/tokens?keyword=' + encodeURIComponent(g.kind === 'kw' ? q : g.c) + (g.kind === 'sol' ? '&chain=solana' : '') + '&limit=20'; const j = await X.aveGet(p, 5); const L = Array.isArray(j?.data) ? j.data : Array.isArray(j?.data?.tokens) ? j.data.tokens : null;
      if (L) { src = 'ave'; for (const t of L) { const ch = CHN[String(t.chain || '').toLowerCase()] || CHN[String(t.token_id || '').split('-').pop()]; const c = String(t.token || String(t.token_id || '').split('-')[0] || ''); add({ chain: ch, c: ch === 'solana' ? c : c.toLowerCase(), sym: String(t.symbol || '').slice(0, 24), name: String(t.name || '').slice(0, 40), price: fin(t.current_price_usd), mc: fin(t.market_cap), tvl: fin(t.main_pair_tvl ?? t.tvl), v24: fin(t.tx_volume_u_24h), pl: String(t.issue_platform || '').slice(0, 20), src: 'ave' }); } } else why = 'ave'; } catch { why = 'ave'; } }
  if (!items.length && g.kind === 'evm' && X?.aveGet) for (const ch of g.chains) { /* 关键字查不到（例如还在内盘、DexScreener 没池子）→ 直接问 AVE 这个合约在各链的资料 */ try { const j = await X.aveGet(`/v2/tokens/${g.c}-${ch}`, 5); const t = j?.data?.token || (j?.status === 1 ? j?.data : null); if (t && (t.symbol || t.name)) { src = 'ave'; add({ chain: ch, c: g.c, sym: String(t.symbol || '').slice(0, 24), name: String(t.name || '').slice(0, 40), price: fin(t.current_price_usd), mc: fin(t.market_cap), tvl: fin(t.main_pair_tvl ?? t.tvl), v24: fin(t.tx_volume_u_24h), pl: String(t.issue_platform || '').slice(0, 20), src: 'ave' }); break; } } catch {} }
  if (!items.length) { try { const r = await fetch('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(g.kind === 'kw' ? q : g.c), { signal: AbortSignal.timeout(12000) }); const j = await r.json(); src = src || 'dexscreener';
      for (const p of Array.isArray(j?.pairs) ? j.pairs : []) { const ch = CHN[String(p.chainId || '').toLowerCase()]; if (!ch) continue; const b = p.baseToken || {}; const c = String(b.address || ''); if (g.kind !== 'kw' && (ch === 'solana' ? c !== g.c : c.toLowerCase() !== g.c)) continue; add({ chain: ch, c: ch === 'solana' ? c : c.toLowerCase(), sym: String(b.symbol || '').slice(0, 24), name: String(b.name || '').slice(0, 40), price: fin(p.priceUsd), mc: fin(p.marketCap ?? p.fdv), tvl: fin(p.liquidity?.usd), v24: fin(p.volume?.h24), pl: String(p.dexId || '').slice(0, 20), src: 'dexscreener' }); } } catch { why = why || 'net'; } }
  items.sort((a, b) => (b.v24 ?? -1) - (a.v24 ?? -1)); return { q, kind: g.kind, src, why: items.length ? '' : why || 'none', items: items.slice(0, 30) }; }
/* ③ 已上外盘的成交（AVE） */
const PP = new Map(); /* pair → { at, v } */
async function mainPair(net, addr) { const k = net + addr, c = PP.get(k); if (c && Date.now() - c.at < 300e3 /* 技术用：主池多久重查 */) return c.v; let v = '';
  try { const r = await fetch('https://api.dexscreener.com/tokens/v1/' + (net === 'robinhood' ? 'robinhood' : 'bsc') + '/' + addr, { signal: AbortSignal.timeout(10000) }); const L = await r.json(); let best = null; for (const p of Array.isArray(L) ? L : []) if (/^0x[0-9a-fA-F]{40}$/.test(p?.pairAddress || '') && (!best || (+p.liquidity?.usd || 0) > (+best.liquidity?.usd || 0))) best = p; if (best) v = String(best.pairAddress).toLowerCase(); } catch {}
  PP.set(k, { at: Date.now(), v }); if (PP.size > 300) PP.delete(PP.keys().next().value); return v; }
async function tapeAve(net, addr, pool, tag) {
  if (!X?.aveGet) return null; net = net === 'robinhood' ? 'robinhood' : 'bsc'; let p = /^0x[0-9a-f]{40}$/.test(pool) ? pool : ''; if (!p) p = await mainPair(net, addr); if (!p) return null;
  const j = await X.aveGet(`/v2/txs/swap/${p}-${net}?limit=50&sort=desc`, 50).catch(() => null); const L = Array.isArray(j?.data?.txs) ? j.data.txs : null; if (!L) return null;
  const rows = []; for (const t of L) { const buy = String(t.to_address || '').toLowerCase() === addr, sell = String(t.from_address || '').toLowerCase() === addr; if (!buy && !sell) continue; const usd = buy ? (+t.from_amount) * (+t.from_price_usd) : (+t.to_amount) * (+t.to_price_usd); const w = String(t.sender || t.wallet_address || '').toLowerCase(); const u = Number.isFinite(usd) ? Math.round(usd * 100) / 100 : null; rows.push({ t: (+t.time) * 1000 || 0, b: buy ? 1 : 0, usd: u, p: fin(buy ? t.to_price_usd : t.from_price_usd) ?? fin(t.price_usd) /*AUD2-1113 照 AVE 网页：代币那一边的 from／to_price_usd（以前读 price_usd，AVE 成交没有这栏 → 价格全空，详情价格不会跟着成交动）*/, w, tg: tag ? tag(w, u || 0) : [] }); }
  return { src: 'ave', pair: p, at: Date.now(), rows: rows.slice(0, 60) }; }
function install(o) { X = o; }
const act = async (o) => { const a = String(o?.a || ''); if (a === 'search') return search(o); if (a === 'stat') return { okAt: S.okAt, at: S.at, err: S.err, q: S.q, tagErr: S.tagErr, n: Object.values(S.m).reduce((n, M) => n + Object.keys(M).length, 0) }; return null; };
module.exports = { install, warm, board, search, tapeAve, act, stat, _S: S, _merge: merge, _guess: guess };
/*SWR-1113 雷达刚打开、还没拿到共用看盘时：马上去拿，最多等 ms 毫秒（多链看盘切链不用等下一轮） */
function warm(ms) { if (S.okAt) return Promise.resolve(true); if (!S.busy) pull().catch(() => {}); const t0 = Date.now(); return new Promise((ok) => { const f = () => { if (S.okAt || !S.busy || Date.now() - t0 >= ms) ok(!!S.okAt); else setTimeout(f, 50 /* 技术用：多久看一次拿到没 */); }; setTimeout(f, 50 /* 技术用 */); }); }
