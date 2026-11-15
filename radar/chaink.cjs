'use strict';
/*CHAINK-1115 BNB Chain／Robinhood 已上外盘的币：1 分以上的 K 线也由雷达自己读链上成交来画（照 GMGN／AVE：新币的图从第一笔成交开始画，前面不补空白）。
  以前 1m／5m 只能等 GeckoTerminal（免金钥有每分钟次数上限、同一个 IP 大家共用），被限速时开代币页要等很久才有图。
  做法：代币页打开 → 先读主池最近一小段区块的 Swap 事件（几百毫秒就有图）→ 背景一段一段往回补 → 之后每隔几秒读新区块接上。
  GeckoTerminal 只拿来补比读链更早的历史（低优先、拿不到也不影响已经读到的部分）。只读，不碰钱包、不下单。 */
const KL = require('./kline.cjs');

const T = { firstSpan: { bsc: 600, robinhood: 3000 }, chunk: { bsc: 5000, robinhood: 30000 }, backMax: { bsc: 48000, robinhood: 200000 }, liveMs: 2500, firstMore: 3, backErrMax: 2, keep: 8, rowsMax: 20000, idleMs: 120e3 }; /* 技术用（只影响画图）：第一段读几个区块（几分钟）、往回每段几个区块（公开节点单次查事件上限内）、最多往回几个区块（几小时）、多久读一次新区块、第一次没读到成交时先多读几段、往回读失败几次就停、同时记几个币、每个币最多记几笔、多久没人看就停 */
const V2_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', V3_SWAP_UNI = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', V3_SWAP_CAKE = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83';
let D = {}; /* 依赖：rpc(net, method, params)、qUsd(net, quote)、v4(net, id, addr)、blkMs */
function install(deps) { D = deps || {}; }
const S = new Map(); /* net|pool|addr → 状态 */
const hex = (n) => '0x' + Math.max(0, n).toString(16);
const big = (h) => { try { return BigInt('0x' + (h || '0')); } catch { return 0n; } };
const i256 = (h) => { const v = big(h); return v >= 1n << 255n ? v - (1n << 256n) : v; };

async function meta(net, pool) { const c = (d) => D.rpc(net, 'eth_call', [{ to: pool, data: d }, 'latest']); const [t0, t1] = await Promise.all([c('0x0dfe1681'), c('0xd21220a7')]); if (!t0 || !t1 || t0.length < 66 || t1.length < 66) return null;
  const m = { t0: '0x' + t0.slice(26).toLowerCase(), t1: '0x' + t1.slice(26).toLowerCase() }; const rs = await c('0x0902f1ac'); m.v2 = !!(rs && rs.length >= 130); if (!m.v2) { const fe = await c('0xddca3f43'); m.v3 = !!(fe && fe.length >= 66); } if (!m.v2 && !m.v3) return null;
  const dc = async (t) => { try { const n = parseInt(await D.rpc(net, 'eth_call', [{ to: t, data: '0x313ce567' }, 'latest']), 16); return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null; } catch { return null; } }; [m.d0, m.d1] = await Promise.all([dc(m.t0), dc(m.t1)]); return m; }

/* 一段区块的 Swap 事件 → [{t 毫秒, p 美金价, v 美金量}] */
function decode(st, L, aBlk, aTs) { const out = []; const m = st.m, isT0 = m.t0 === st.addr; const dT = isT0 ? m.d0 : m.d1, dQ = isT0 ? m.d1 : m.d0; if (dT == null || dQ == null || !(st.qu > 0)) return out;
  for (const l of L) { const d = String(l.data || '').slice(2); let a0i, a1i, a0o, a1o; if (m.v3) { const s0 = i256(d.slice(0, 64)), s1 = i256(d.slice(64, 128)); a0i = s0 > 0n ? s0 : 0n; a0o = s0 < 0n ? -s0 : 0n; a1i = s1 > 0n ? s1 : 0n; a1o = s1 < 0n ? -s1 : 0n; } else { a0i = big(d.slice(0, 64)); a1i = big(d.slice(64, 128)); a0o = big(d.slice(128, 192)); a1o = big(d.slice(192, 256)); }
    const tokIn = isT0 ? a0i : a1i, tokOut = isT0 ? a0o : a1o, qIn = isT0 ? a1i : a0i, qOut = isT0 ? a1o : a0o; const b = tokOut > 0n; const tn = Number(b ? tokOut : tokIn) / 10 ** dT, qn = Number(b ? qIn : qOut) / 10 ** dQ; if (!(tn > 0) || !(qn > 0)) continue;
    const blk = parseInt(l.blockNumber, 16); const bt = l.blockTimestamp ? parseInt(l.blockTimestamp, 16) || 0 : 0; const t = bt > 0 ? bt * 1000 : aTs - (aBlk - blk) * (D.blkMs?.[st.net] || 0); if (!(t > 0)) continue;
    const v = qn * st.qu; out.push({ t, p: v / tn, v, k: String(l.transactionHash || '').slice(2, 14) + ':' + parseInt(l.logIndex, 16) }); }
  return out; }
function add(st, rows) { for (const r of rows) { if (st.seen.has(r.k)) continue; st.seen.add(r.k); st.rows.push(r); } st.rows.sort((a, b) => a.t - b.t); if (st.rows.length > T.rowsMax) { const cut = st.rows.splice(0, st.rows.length - T.rowsMax); for (const r of cut) st.seen.delete(r.k); } st.ver++; }
async function logs(st, from, to) { return D.rpc(st.net, 'eth_getLogs', [{ address: st.pool, topics: [st.m.v3 ? [V3_SWAP_UNI, V3_SWAP_CAKE] : V2_SWAP], fromBlock: hex(from), toBlock: hex(to) }]); }

async function first(st) { const hb = await D.rpc(st.net, 'eth_getBlockByNumber', ['latest', false]); const head = parseInt(hb?.number, 16), hts = parseInt(hb?.timestamp, 16) * 1000; if (!head || !(hts > 0)) throw new Error('head');
  if (st.v4) { const r = await D.v4(st.net, st.pool, st.addr); if (!r || !Array.isArray(r.rows)) throw new Error('v4'); add(st, r.rows.filter((x) => x.p > 0).map((x) => ({ t: x.t, p: x.p, v: x.usd || 0, k: x.k || x.tx }))); st.head = head; st.done = true; return; } /* V4 池：PoolManager 的事件一次读完（同 tape） */
  st.m = await meta(st.net, st.pool); if (!st.m) throw new Error('meta'); const q = st.m.t0 === st.addr ? st.m.t1 : st.m.t0; st.qu = await D.qUsd(st.net, q); if (!(st.qu > 0)) throw new Error('quote');
  const from = head - T.firstSpan[st.net]; const L = await logs(st, from, head); if (!Array.isArray(L)) throw new Error('logs'); add(st, decode(st, L, head, hts)); st.head = head; st.hts = hts; st.back = from - 1; st.ok = true;
  for (let i = 0; i < T.firstMore && !st.rows.length && st.back > 0; i++) { const to = st.back, fr = Math.max(0, to - T.chunk[st.net] + 1); const L2 = await logs(st, fr, to); if (!Array.isArray(L2)) break; add(st, decode(st, L2, head, hts)); st.back = fr - 1; } } /* 冷门币：最近这一小段没成交就先多读几段再回画面（不然第一张图是空的）*/
async function deepen(st) { const lim = st.head - T.backMax[st.net]; while (!st.stop && st.back > lim && st.back > 0) { const to = st.back, from = Math.max(lim, to - T.chunk[st.net] + 1); const L = await logs(st, from, to); if (!Array.isArray(L)) { st.backErr = (st.backErr || 0) + 1; if (st.backErr > T.backErrMax) break; continue; } add(st, decode(st, L, st.head, st.hts)); st.back = from - 1; st.backN = (st.backN || 0) + 1; } st.done = true; }
async function live(st) { if (st.v4 || !st.ok || st.liveBusy || Date.now() - st.liveAt < T.liveMs) return; st.liveBusy = true; try { const hb = await D.rpc(st.net, 'eth_getBlockByNumber', ['latest', false]); const head = parseInt(hb?.number, 16), hts = parseInt(hb?.timestamp, 16) * 1000; if (head > st.head) { const L = await logs(st, st.head + 1, head); if (Array.isArray(L)) { add(st, decode(st, L, head, hts)); st.head = head; } } } catch {} finally { st.liveBusy = false; st.liveAt = Date.now(); } }

/* 画面问：回目前读到的 K 棒（第一次会等第一段读完；之后不等，背景补） */
async function bars(net, addr, pool, sec) { if (!D.rpc || !/^0x[0-9a-f]{40}([0-9a-f]{24})?$/.test(pool || '')) return null; const k = net + '|' + pool + '|' + addr; let st = S.get(k);
  if (!st) { st = { net, addr, pool, v4: pool.length === 66, rows: [], seen: new Set(), ver: 0, liveAt: 0, at: Date.now() }; S.set(k, st); if (S.size > T.keep) { const [ok, old] = S.entries().next().value; old.stop = true; S.delete(ok); }
    st.init = first(st).then(() => { if (!st.v4) deepen(st).catch(() => { st.done = true; }); }).catch((e) => { st.err = String(e?.message || e); }); }
  st.at = Date.now(); await st.init; if (st.err && !st.rows.length) return { err: st.err, bars: [] }; live(st);
  const L = KL.aggregate(st.rows.map((r) => ({ t: r.t, o: r.p, h: r.p, l: r.p, c: r.p, v: r.v })), sec); const t0 = st.rows.length ? st.rows[0].t : null;
  return { bars: L, first: t0, done: !!st.done, n: st.rows.length, ver: st.ver }; }
setInterval(() => { const now = Date.now(); for (const [k, st] of S) if (now - st.at > T.idleMs) { st.stop = true; S.delete(k); } }, T.idleMs).unref?.();
function stat() { return [...S.values()].map((s) => ({ net: s.net, pool: s.pool, n: s.rows.length, done: !!s.done, backN: s.backN || 0, err: s.err || '' })); }
module.exports = { install, bars, stat, T };
