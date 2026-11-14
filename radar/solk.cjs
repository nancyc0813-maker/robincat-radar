/* SOLK-1114 Solana pump.fun 内盘币：雷达本机读链组 1 秒／5 秒／15 秒 K 线（只读、不进任何买卖判断）
   为什么：GeckoTerminal 的 1 秒线 11/14 实测落后 3 分钟以上；GMGN／AVE 的秒线都是自己读链。
   做法：代币页开着的那一个币，对公开节点 WSS 送一个 logsSubscribe（mentions＝这个币的 mint；11/14 实测 api.mainnet-beta 可用、
   区块时间→收到 中位约 1.3–1.4 秒），收到 pump.fun TradeEvent（跟 kolfeed.cjs 同一个解码）就在本机记成交、聚合成 K 线。
   限制：只有订阅之后的成交（更早的历史画面接 GeckoTerminal 分钟线）；已上 PumpSwap 的币事件格式不同 → 不在这里处理（画面照旧用 GeckoTerminal 并标实测延迟）。
   跟 kolfeed 共用 Solana 订阅上限：这里最多 1 个订阅，kolfeed 那边少订 1 个（globalThis.SOLK_N）。 */
const RP = require('./rpcpool.cjs');
const KF = require('./kolfeed.cjs');
const [WSS, IDLE_MS, KEEP_N, BACK_MS, PUMP_SUP] = ['wss://api.mainnet-beta.solana.com', 60e3, 20000, 5e3, 1e9]; /* 技术用：节点（11/14 实测 publicnode 订阅会漏，用 mainnet-beta）、画面多久没来要资料就关订阅、最多留几笔成交、断线多久后重连、pump.fun 代币总量（固定 10 亿，算市值用） */
const ERR_N = 80; /* 技术用：错误讯息给画面的长度上限 */
const S = { mint: '', ws: null, st: 'off', err: '', since: 0, tr: [], seen: new Set(), at: 0, sid: null, lag: [], solUsd: () => null };
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function install(o) { if (o && typeof o.solUsd === 'function') S.solUsd = o.solUsd; }
function stop() { if (S.ws) try { S.ws.close(); } catch {} S.ws = null; S.mint = ''; S.st = 'off'; S.tr = []; S.seen.clear(); S.lag = []; globalThis.SOLK_N = 0; }
function open() { const m = S.mint; S.st = 'conn'; S.err = ''; globalThis.SOLK_N = 1; let rid = 1;
  S.ws = RP.wsOpen(WSS, { onOpen: () => { S.st = 'on'; S.ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'logsSubscribe', params: [{ mentions: [m] }, { commitment: 'processed' }] })); },
    onMsg: (t) => { if (S.mint !== m) return; let j; try { j = JSON.parse(t); } catch { return; } if (j.error) { S.err = String(j.error.message || 'rpc').slice(0, ERR_N); return; } const v = j.params?.result?.value; if (!v || v.err || !v.signature) return;
      if (S.seen.has(v.signature)) return; S.seen.add(v.signature); if (S.seen.size > KEEP_N) S.seen.clear(); const rt = Date.now();
      for (const x of tradeEv(v.logs)) { if (x.mint !== m || !(x.vtok > 0) || !(x.vsol > 0)) continue; S.tr.push({ ts: x.ts, rt, sol: x.sol, tok: x.tok, vsol: x.vsol, vtok: x.vtok, buy: x.buy, w: x.user, sig: v.signature }); if (x.ts > 0) { S.lag.push(rt / 1000 - x.ts); if (S.lag.length > KEEP_N) S.lag.shift(); } }
      if (S.tr.length > KEEP_N) S.tr.splice(0, S.tr.length - KEEP_N); },
    onClose: (why) => { if (S.mint !== m) return; S.st = 'retry'; S.err = String(why || '').slice(0, ERR_N); S.ws = null; setTimeout(() => { if (S.mint === m && !S.ws) open(); }, BACK_MS); } }); }
/*RV8-7 TradeEvent 解码（照 pump.fun 官方 IDL：github.com/pump-fun/pump-public-docs idl/pump.json，commit 639b87f；位移含开头的 discriminator 位元组）：
   8 mint、40 sol_amount、48 token_amount、56 is_buy、57 user、89 timestamp、97 virtual_sol_reserves、105 virtual_token_reserves。
   K 线价格用成交后的虚拟储备（virtual_sol_reserves ÷ virtual_token_reserves），跟 pump.fun 曲线报价同一个算法，不用这笔成交的平均价 */
const [OFF_VSOL, OFF_VTOK, EV_MIN] = [97, 105, 113]; /* 技术用：官方 IDL 的栏位位移、含虚拟储备的最短长度 */
function tradeEv(logs) { const base = KF.pumpTrades(logs); if (!base.length) return []; const raw = []; for (const l of Array.isArray(logs) ? logs : []) { if (typeof l !== 'string' || !l.startsWith('Program data: ')) continue; let b; try { b = Buffer.from(l.slice(14), 'base64'); } catch { continue; } if (b.length >= EV_MIN && b.subarray(0, 8).equals(PUMP_EV)) raw.push(b); }
  return base.map((x, i) => { const b = raw[i]; return b ? { ...x, vsol: Number(b.readBigUInt64LE(OFF_VSOL)) / LAMPORTS, vtok: Number(b.readBigUInt64LE(OFF_VTOK)) / TOK_DEC } : { ...x, vsol: 0, vtok: 0 }; }); }
const PUMP_EV = require('crypto').createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8); /* = 官方 IDL discriminator [189,219,127,211,78,230,97,238] */
const [LAMPORTS, TOK_DEC] = [1e9, 1e6]; /* 技术用：lamports 换 SOL、pump.fun 代币小数位数（官方） */
/* 画面要哪个币就订哪个（同一时间只订一个）；画面一段时间没来要资料就关 */
function watch(mint) { mint = String(mint || ''); if (!B58.test(mint)) return { err: 'mint' }; S.at = Date.now();
  if (S.mint !== mint) { stop(); const cap = KF.T?.solMax; const used = Math.min(Object.keys(KF._S?.list?.solana || {}).length, cap || 0); if (cap && used >= cap) return { err: 'cap' }; S.mint = mint; S.since = Date.now(); open(); }
  return { ok: 1 }; }
setInterval(() => { if (S.mint && Date.now() - S.at > IDLE_MS) stop(); }, IDLE_MS).unref?.();
/* 组 K 线：秒数 sec（1／5／15），时间用区块时间（秒）；价格＝SOL÷代币×SOL 美金价（读不到 SOL 价＝只给 SOL 计价，画面不画美金） */
function bars(mint, sec) { const r = watch(mint); if (r.err) return r; sec = [1, 5, 15, 30].includes(+sec) ? +sec : 1; /*SEC30-1114 加半分钟一根（照币安钱包、OKX 的秒线周期）*/ const u = S.solUsd(); const out = []; let cur = null;
  for (const x of S.tr.slice().sort((a, b) => a.ts - b.ts)) { if (!(x.ts > 0)) continue; const p = (x.vsol / x.vtok) * (u || 1); /*RV8-7 成交后的曲线价格（虚拟储备）*/ const k = Math.floor(x.ts / sec) * sec; const v = x.sol * (u || 1);
    if (!cur || cur.t !== k) { cur = { t: k * 1000, o: p, h: p, l: p, c: p, v }; out.push(cur); } else { cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p; cur.v += v; } }
  const L = S.lag.slice().sort((a, b) => a - b); const last = S.tr.at(-1);
  return { src: 'chain', st: S.st, err: S.err, since: S.since, n: S.tr.length, usd: !!u, sup: PUMP_SUP, lagMed: L.length ? +L[Math.floor(L.length / 2)].toFixed(2) : null, lagN: L.length, last: last ? { ts: last.ts, rt: last.rt } : null, bars: out }; }
module.exports = { install, watch, bars, stop, _S: S };
