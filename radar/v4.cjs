// 罗宾猫雷达：V4 类发射台读取器（她 11/2：Genius 要接、Robinhood 的 Pons／Long 要接）。
// 这些发射台都把曲线盘做成 Uniswap V4／PancakeSwap Infinity 的「Hook」：盯主合约（PoolManager）的「新池建立」和「成交」事件，
// 只收挂着已知发射台 Hook 的池子（Robinhood 也收其他 Hook 和一般新池），自己算价格、市值、成交、买卖笔数。只读公开节点，不碰钱包。
const fs = require('fs');
const path = require('path');
const KL = require('./kline.cjs'); const RP = require('./rpcpool.cjs'); /* KQ-1104：K 线共用格子 */

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_TOKENS = 20000, TR_TOKENS = 3000; /* BOARD-V3 技术用：储存上限（快取最多几个币、其中几个留成交明细）；不是列表的边界，已发射的币往下滑会向链上往回读 */
const CFG = {
  rh: {
    name: 'robinhood', file: 'market_rh.json', rpcs: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com'], span: 1000, backfill: 36000,
    pm: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    init: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', hookWord: 2, // Initialize(id, c0, c1, fee, tickSpacing, hooks, sqrtPriceX96, tick)
    swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
    hooks: { '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044': 'pons', '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544': 'long' }, suffix: { long: '1e18' }, ds: 'robinhood',
    anyHook: true, plainPools: true,
    quotes: { [ZERO]: ['ETH', 18, 'eth'], '0x0bd7d308f8e1639fab988df18a8011f41eacad73': ['WETH', 18, 'eth'], '0x5fc5360d0400a0fd4f2af552add042d716f1d168': ['USDG', 6, 'usd'] },
    priceSym: 'ETHUSDT', sup: 1e9,
  },
  bsc: {
    name: 'bsc', file: 'market_bsc_v4.json', rpcs: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io'], span: 1500, backfill: 60000,
    pm: '0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b', // PancakeSwap Infinity CLPoolManager
    init: '0x426cc62fe6a33a40ba2788c2c87a9c34ee4582b95bc9fa5a7bb7ae70b750b99c', hookWord: 0, // Initialize(id, c0, c1, hooks, fee, parameters, sqrtPriceX96, tick)
    swap: '0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237',
    hooks: { '0x8e6f8ebbd62b60085b703c40b460dae802edc51b': 'genius', '0xff17f41c5efd6cce944af0912f300097d62df5c9': 'genius' },
    anyHook: true, plainPools: true, /*BOARD124 其他 Infinity 新池也收（标「其他新池」，画面可筛掉）*/ suffix: {}, ds: 'bsc',
    /* Genius 曲线阶段不在交易池上：盯工厂的 TokenLaunched，再盯每个曲线合约的 Buy／Sell／CurveCompleted（她 11/2：Genius 要接） */
    gfac: '0x37ee8aee29c5efd3c1a7eda6df3f510779928a37', gLaunch: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607', gBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455', gSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df', gDone: '0xc65a4c73cfd820dccb7079db9e52bb2c09dfd56f9221e7d815e201b726b5c39d', gSellable: 714.3e6,
    quotes: { [ZERO]: ['BNB', 18, 'bnb'], '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': ['WBNB', 18, 'bnb'], '0x55d398326f99059ff775485246999027b3197955': ['USDT', 18, 'usd'], '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d': ['USD1', 18, 'usd'], '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': ['USDC', 18, 'usd'] },
    priceSym: 'BNBUSDT', sup: 1e9,
  },
};
const W = (d, i) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
const A = (w) => '0x' + String(w).slice(-40).toLowerCase();
const I128 = (w) => { let b = BigInt('0x' + (w || '0')); if (b >= 1n << 255n) b -= 1n << 256n; return b; };
function S(d) { try { const off = Number(BigInt('0x' + d.slice(2, 66))) * 2; const len = Number(BigInt('0x' + d.slice(2 + off, 2 + off + 64))); return Buffer.from(d.slice(2 + off + 64, 2 + off + 64 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 24); } catch { return ''; } }

function startV4(chain, { DATA }) {
  const C = CFG[chain]; const FILE = path.join(DATA, C.file);
  let D = { block: 0, pools: {}, tokens: {}, seen: {}, xq: {}, curves: {} };
  try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  D.seen = D.seen || {}; D.xq = D.xq || {}; D.curves = D.curves || {}; for (const x of Object.values(D.tokens)) if (x.plat === 'long' && !String(x.c).endsWith('1e18')) x.plat = 'bankr';
  const st = { ok: false, err: '', lastAt: 0, head: 0, headTs: 0, headAt: 0, blockMs: chain === 'rh' ? 105 : 450 };
  let ri = 0, px = 0, pxAt = 0;
  async function rpc(method, params) { return RP.rpc(C.name === 'robinhood' ? 'robinhood' : 'bsc', method, params, 15000); } /* NODE-1113：节点池（玩家自己的节点优先、公开节点备用；查事件被拒的节点先不问） */
  async function price() { if (Date.now() - pxAt < 60e3 && px) return px; try { const j = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + C.priceSym, { signal: AbortSignal.timeout(8000) })).json(); if (+j.price > 0) { px = +j.price; pxAt = Date.now(); } } catch {} return px; }
  const qUsd = (q) => { const m = C.quotes[q]; if (m) return m[2] === 'usd' ? 1 : px; return D.xq[q]?.usd || 0; };
  const qDec = (q) => C.quotes[q]?.[1] ?? (D.xq[q]?.dOk === 1 ? D.xq[q].d : null); /* CHAIN-1104 D9：报价币小数位数读不到＝null（这笔不算价），不当成 18 */
  const tsOf = (blk) => (st.headTs ? st.headTs - (st.head - blk) * st.blockMs : Date.now());

  const lk = (l) => (l.transactionHash ? String(l.transactionHash).slice(2, 14) + ':' + parseInt(l.logIndex, 16) : ''); /* KQ-1104：同一则事件重抓不重复记 */
  const dup = (x, k) => !!k && x.tr.some((r) => r[5] === k);
  function onLog(l) {
    const t0 = l.topics[0], d = l.data, t = tsOf(parseInt(l.blockNumber, 16));
    if (C.gfac) { const a = l.address.toLowerCase();
      if (a === C.gfac && t0 === C.gLaunch) { const tok = A(l.topics[1]), cv = A(l.topics[2]), q = A(W(d, 0)); D.curves[cv] = { tok, q }; if (!C.quotes[q]) D.xq[q] = D.xq[q] || { d: 0, usd: 0 }; if (!D.tokens[tok]) D.tokens[tok] = { c: tok, plat: 'genius', at: t, q, tr: [], grad: 0, gradAt: 0, curve: cv, sold: 0, dev: A(l.topics[3]) }; return; }
      const G = D.curves[a]; if (G) { const x = D.tokens[G.tok]; if (!x) return;
        if (t0 === C.gBuy || t0 === C.gSell) { const buy = t0 === C.gBuy; const qdG = qDec(G.q); if (qdG == null) return; const qn = Number(BigInt('0x' + W(d, buy ? 0 : 1))) / 10 ** qdG, tn = Number(BigInt('0x' + W(d, buy ? 1 : 0))) / 1e18; if (!(tn > 0)) return;
          { const k = lk(l); if (dup(x, k)) return; x.tr.push([Math.round(t / 1000), buy ? 1 : 0, +qn.toPrecision(6), +(qn / tn).toPrecision(6), A(l.topics[buy ? 2 : 1]).slice(2, 10), ...(k ? [k] : [])]); } if (x.tr.length > 1500) x.tr.splice(0, x.tr.length - 1500); x.p = qn / tn; x.lt = t; x.sold = (x.sold || 0) + (buy ? tn : -tn); x.prog = Math.max(0, Math.min(100, (x.sold / C.gSellable) * 100)); }
        else if (t0 === C.gDone) { x.grad = 1; x.gradAt = t; x.prog = 100; }
        return; } }
    if (t0 === C.init) {
      const id = l.topics[1], c0 = A(l.topics[2]), c1 = A(l.topics[3]), hook = A(W(d, C.hookWord));
      const plat = C.hooks[hook] || (hook !== ZERO && C.anyHook ? 'other' : hook === ZERO ? 'dex' : '');
      for (const a of [c0, c1]) D.seen[a] = (D.seen[a] || 0) + 1;
      let q = C.quotes[c0] ? c0 : C.quotes[c1] ? c1 : '';
      /* 她 11/2：Long 的币是跟「股票代币」配对（NVDA、TSLA…），不是 ETH → 用官方规则（Long 的币地址结尾是 1e18）分出哪个是新币；
         其他发射台遇到不认识的报价币：被很多池子用过的那个才是报价币（新币只会出现一次） */
      if (!q && (C.hooks[hook] || C.anyHook)) { const sf = C.suffix[plat]; if (sf) q = c0.endsWith(sf) && !c1.endsWith(sf) ? c1 : c1.endsWith(sf) && !c0.endsWith(sf) ? c0 : ''; if (!q && D.seen[c0] !== D.seen[c1]) q = D.seen[c0] > D.seen[c1] ? c0 : c1; if (q) D.xq[q] = D.xq[q] || { d: 0, usd: 0 }; }
      let qUnk = 0; if (!q && plat) { q = c0; qUnk = 1; } /*BOARD124 报价币认不出：先收、标「报价币不明」（美金读不到＝null），不丢*/
      if (!q) return; const tok = q === c0 ? c1 : c0; if (C.quotes[tok] || (D.xq[tok] && !qUnk)) return;
      const known = D.tokens[tok];
      if (!plat && !known) return;
      if (hook === ZERO && known && known.plat !== 'dex') { known.grad = 1; known.gradAt = t; known.pool = id; D.pools[id] = { tok, q, t0: q === c0 }; return; }
      if (hook === ZERO && !C.plainPools && !known) return;
      D.pools[id] = { tok, q, t0: q === c0 };
      if (!known) D.tokens[tok] = { c: tok, plat: plat === 'long' && !tok.endsWith('1e18') ? 'bankr' : plat || 'dex', /* 她 11/2：Bankr（Muse 生态）跟 Long 用同一套 Doppler 合约；Long 的币地址结尾是 1e18，其他的标 Bankr 等 */ at: t, pool: id, q, tr: [], grad: plat === 'dex' ? 1 : 0, gradAt: plat === 'dex' ? t : 0, ...(qUnk ? { qUnk: 1 } : {}) };
    } else if (t0 === C.swap) {
      const P = D.pools[l.topics[1]]; if (!P) return; const x = D.tokens[P.tok]; if (!x) return;
      const a0 = I128(W(d, 0)), a1 = I128(W(d, 1)); const qa = P.t0 ? a0 : a1, ta = P.t0 ? a1 : a0; if (!qa || !ta) return;
      const qd = qDec(P.q); if (qd == null) return; const qn = Math.abs(Number(qa)) / 10 ** qd, tn = Math.abs(Number(ta)) / 1e18; if (!(tn > 0)) return;
      const buy = ta > 0n; /* V4 的成交数字是「交易者这边」的变化：拿到代币＝买 */
      { const k = lk(l); if (dup(x, k)) return; x.tr.push([Math.round(t / 1000), buy ? 1 : 0, +qn.toPrecision(6), +(qn / tn).toPrecision(6), '', ...(k ? [k] : [])]); } if (x.tr.length > 1500) x.tr.splice(0, x.tr.length - 1500);
      x.p = qn / tn; x.lt = t; x.q = P.q; /* sender 是路由合约不是真人 → 不算人数 */
    }
  }
  async function names() { const L = Object.values(D.tokens).filter((x) => !x.nmTried).slice(0, 12); for (const x of L) { x.nmTried = 1; try { x.sym = x.sym || S(await rpc('eth_call', [{ to: x.c, data: '0x95d89b41' }, 'latest'])); } catch {} try { const r = await rpc('eth_call', [{ to: x.c, data: '0x18160ddd' }, 'latest']); const v = Number(BigInt(r)) / 1e18; if (v > 0) x.sup = v; } catch {} }
    for (const [a, o] of Object.entries(D.xq)) if (o.dOk !== 1) { try { const r = await rpc('eth_call', [{ to: a, data: '0x313ce567' }, 'latest']); const n = r && r.length >= 66 ? Number(BigInt(r)) : NaN; if (Number.isInteger(n) && n >= 0 && n <= 77) { o.d = n; o.dOk = 1; } } catch {} } /* CHAIN-1104 D9：读失败不记住，下一轮再读 */ }
  let xqAt = 0;
  async function xqPrices() { /* 股票代币等报价币的美金价：DexScreener 公开接口，2 分钟一次 */ if (Date.now() - xqAt < 120e3) return; xqAt = Date.now(); const L = Object.keys(D.xq); if (!L.length) return; /*BOARD124 报价币不设上限：每 30 个一批（DexScreener 一次的上限）*/
    for (let i = 0; i < L.length; i += 30) try { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/${C.ds}/${L.slice(i, i + 30).join(',')}`, { signal: AbortSignal.timeout(10000) })).json(); const best = {}; for (const p of Array.isArray(ps) ? ps : []) { const a = String(p.baseToken?.address || '').toLowerCase(); const lq = +p.liquidity?.usd || 0; if (+p.priceUsd > 0 && (!best[a] || lq > best[a].lq)) best[a] = { v: +p.priceUsd, lq }; } for (const [a, b] of Object.entries(best)) if (D.xq[a]) D.xq[a].usd = b.v; } catch {} }
  async function head() { const b = await rpc('eth_getBlockByNumber', ['latest', false]); const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16) * 1000; if (st.head && n > st.head && ts > st.headTs) st.blockMs = Math.max(50, Math.min(3000, (ts - st.headTs) / (n - st.head))); st.head = n; st.headTs = ts; return n; }
  let busy = false, SP = C.span; const GADR_N = 10; /* 技术用：公开节点 getLogs 一次最多 10 个地址 */
  async function tick() {
    if (busy) return; busy = true;
    try { await price(); const n = await head(); let from = D.block ? D.block + 1 : n - C.backfill; if (n - from > C.backfill) from = n - C.backfill;
      let k = 0; while (from <= n && k++ < 12) { const to = Math.min(n, from + SP - 1); let L; try { L = await rpc('eth_getLogs', [{ address: C.pm, topics: [[C.init, C.swap]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); } catch (e) { if (/limit|range|too many|exceed/i.test(String(e.message)) && !/address/i.test(String(e.message)) && SP > 50) { SP = Math.max(50, Math.floor(SP / 2)); continue; } throw e; } /*ENG111-P12b：「地址太多」不是区段太大，不减半（以前会一直减半、游标卡住）*/ if (C.gfac) { const adr = [C.gfac, ...Object.keys(D.curves).filter((cv) => !D.tokens[D.curves[cv].tok]?.grad)].slice(0, 200); try { let G2 = []; for (let gi = 0; gi < adr.length; gi += GADR_N) G2 = G2.concat(await rpc('eth_getLogs', [{ address: adr.slice(gi, gi + GADR_N), topics: [[C.gLaunch, C.gBuy, C.gSell, C.gDone]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]) || []); /*ENG111-P12b：公开节点一次最多查 10 个地址，分批查*/ L = L.concat(G2).sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16)); } catch (e) { if (/limit|range|too many|exceed/i.test(String(e.message)) && !/address/i.test(String(e.message)) && SP > 50) { SP = Math.max(50, Math.floor(SP / 2)); continue; } throw e; } /*ENG111-P12b：「地址太多」不是区段太大，不减半（以前会一直减半、游标卡住）*/ }
        for (const l of L) { try { onLog(l); } catch {} } D.block = to; from = to + 1; }
      if (SP < C.span) SP = Math.min(C.span, SP + 50); await names(); await xqPrices(); st.ok = true; st.err = ''; st.lastAt = Date.now(); st.behind = n - D.block;
    } catch (e) { st.ok = false; st.err = String(e.message || e).slice(0, 120); } finally { busy = false; }
  }
  function prune() { /* BOARD-V3：不照时间删；超过储存上限才从最久没动静的开始清 */ const act = (x) => Math.max(+x.at > 0 ? +x.at : 0, +x.lt > 0 ? +x.lt : 0); const LL = Object.values(D.tokens).sort((a, b) => act(b) - act(a)); for (const x of LL.slice(MAX_TOKENS)) delete D.tokens[x.c]; for (const x of LL.slice(TR_TOKENS, MAX_TOKENS)) if (x.tr.length) x.tr = []; const live = new Set(Object.keys(D.tokens)); for (const [id, P] of Object.entries(D.pools)) if (!live.has(P.tok)) delete D.pools[id]; for (const [cv, G] of Object.entries(D.curves)) if (!live.has(G.tok)) delete D.curves[cv]; const sk = Object.keys(D.seen); if (sk.length > 20000) for (const k of sk) if (D.seen[k] < 2) delete D.seen[k]; }
  function save() { try { prune(); fs.writeFileSync(FILE, JSON.stringify(D)); } catch {} }
  setInterval(tick, 3000); setTimeout(tick, 800); setInterval(save, 60e3); setInterval(() => { supFill().catch(() => {}); }, 3000); /*AUDIT125-B*/

  const TF = { m1: 60, m5: 300, m15: 900, h1: 3600, h6: 21600, h24: 86400 };
/*AUDIT125-B 供应量读链上 totalSupply（÷10^decimals，存在 x.sup，跟着本机资料存档）；读不到＝市值读不到（null），不拿 10 亿冒充。每轮只补几个（技术用，节点额度） */
  const SUP_BATCH = 10, SUP_RETRY_MS = 10 * 60e3; let supBusy = 0;
  async function supFill() { if (supBusy) return; supBusy = 1; try { const now = Date.now(); const L = Object.values(D.tokens).filter((x) => !(x.sup > 0) && !(now - (x.supAt || 0) < SUP_RETRY_MS)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, SUP_BATCH);
    for (const x of L) { x.supAt = now; try { const [t, d] = await Promise.all([rpc('eth_call', [{ to: x.c, data: '0x18160ddd' }, 'latest']), rpc('eth_call', [{ to: x.c, data: '0x313ce567' }, 'latest'])]); if (!/^0x[0-9a-f]{1,64}$/i.test(String(t || '')) || !/^0x[0-9a-f]{1,64}$/i.test(String(d || ''))) continue; const ts = BigInt(t), dec = Number(BigInt(d)); if (ts > 0n && dec <= 36) x.sup = Number(ts) / 10 ** dec; } catch {} } } finally { supBusy = 0; } }
  function view(x) { const now = Date.now() / 1000, u = x.qUnk ? 0 : qUsd(x.q); /*BOARD124 报价币不明＝美金读不到*/ const o = { ...(x.qUnk ? { qUnk: 1 } : {}), c: x.c, plat: x.plat, curve: !x.grad && x.plat !== 'dex' && x.plat !== 'other', sym: x.sym || x.c.slice(0, 8), at: x.at || 0, prog: x.prog ?? null, dev: x.dev || '', grad: !!x.grad, gradAt: x.gradAt || 0, pool: x.c, q: x.q || '', chg: {}, vol: {}, tx: {} };
    const p = x.p || 0; const ok = p > 0 && u > 0; o.price = ok ? p * u : null; o.mc = ok && x.sup > 0 ? p * x.sup * u : null; /*AUDIT125-B 供应量读链上（supFill）；读不到＝null，不用设定档的 C.sup 冒充*/ o.liq = null; /*AMT-11 读不到价格／报价币美元价＝null（画面显示「—」），不显示 $0（跟 market.cjs 一样）*/
    for (const [k, s] of Object.entries(TF)) { const R = x.tr.filter((r) => r[0] >= now - s); let b = 0, se = 0, v = 0; const w = new Set(); for (const r of R) { r[1] ? b++ : se++; v += r[2]; w.add(r[4]); } o.vol[k] = u > 0 ? Math.round(v * u) : null; o.tx[k] = { b, s: se, u: w.size }; o.chg[k] = KL.winChg(x.tr, now - s, p); /* KQ-1104 */ }
    o.n = x.tr.length; o.la = x.tr.length ? x.tr[x.tr.length - 1][0] * 1000 : +x.lt > 0 ? +x.lt : 0; /* BOARD-V3 */ /* NX-1103：最后成交时间 */ return o; }
  function items() { return Object.values(D.tokens).filter((x) => x.at || x.tr.length || x.lt).map(view); }
  async function older(kind, lo, hi) { /* BOARD-V3：往回读某段区块的发射平台事件（只读；画面往下滑才会叫）。BNB Chain：建立＝Genius 工厂 TokenLaunched、上外盘＝挂 Genius Hook 的新池；Robinhood：建立＝挂发射台 Hook 的新池、上外盘＝一般新池 */
    const fb = '0x' + lo.toString(16), tb = '0x' + hi.toString(16); const tsOfL = (l) => (l.blockTimestamp ? (typeof l.blockTimestamp === 'string' ? parseInt(l.blockTimestamp, 16) : +l.blockTimestamp) * 1000 : null);
    if (C.gfac && kind === 'create') { const L = await rpc('eth_getLogs', [{ address: C.gfac, topics: [[C.gLaunch]], fromBlock: fb, toBlock: tb }]); return (Array.isArray(L) ? L : []).map((l) => ({ c: A(l.topics[1]), dev: A(l.topics[3]), blk: parseInt(l.blockNumber, 16), ts: tsOfL(l), plat: 'genius' })); }
    const L = await rpc('eth_getLogs', [{ address: C.pm, topics: [[C.init]], fromBlock: fb, toBlock: tb }]); const out = [];
    for (const l of Array.isArray(L) ? L : []) { try { const c0 = A(l.topics[2]), c1 = A(l.topics[3]), hook = A(W(l.data, C.hookWord)); const plat = C.hooks[hook] || (hook !== ZERO && C.anyHook ? 'other' : hook === ZERO ? 'dex' : ''); if (!plat) continue;
      const want = kind === 'grad' ? (C.gfac ? !!C.hooks[hook] : hook === ZERO) : (!C.gfac && hook !== ZERO); if (!want) continue;
      let q = C.quotes[c0] ? c0 : C.quotes[c1] ? c1 : ''; if (!q) { const sf = C.suffix[plat]; if (sf) q = c0.endsWith(sf) && !c1.endsWith(sf) ? c1 : c1.endsWith(sf) && !c0.endsWith(sf) ? c0 : ''; } if (!q) continue; const tok = q === c0 ? c1 : c0; if (C.quotes[tok]) continue;
      out.push({ c: tok, pool: tok, blk: parseInt(l.blockNumber, 16), ts: tsOfL(l), plat: plat === 'long' && !tok.endsWith('1e18') ? 'bankr' : plat === 'dex' ? (D.tokens[tok]?.plat || 'dex') : plat }); } catch {} }
    return out; }
  function board() { const V = items();
    const curve = V.filter((x) => !x.grad), fresh = curve.slice().sort((a, b) => b.at - a.at), hot = curve.filter((x) => (x.tx.h1.b + x.tx.h1.s) > 0).sort((a, b) => (b.vol.h1 || 0) - (a.vol.h1 || 0)), done = V.filter((x) => x.grad).sort((a, b) => (b.gradAt || b.at) - (a.gradAt || a.at)); /* ZR-INT：清单不截断，全部列出（「热门」＝最近 1 小时有成交，事实） */
    return { cols: [{ k: 'fresh', zh: '🆕 新创建', en: '🆕 New', items: fresh }, { k: 'soon', zh: '🔥 曲线上最热', en: '🔥 Hottest on curve', items: hot }, { k: 'done', zh: '✅ 已迁移／新池', en: '✅ Migrated / new pools', items: done }], src: 'chain', at: st.lastAt, total: V.length, err: (st.ok || (st.lastAt && Date.now() - st.lastAt < 60e3)) ? (st.behind > 3000 ? '正在补抓之前的资料…' : '') : (st.err ? '读链暂时不顺：' + st.err : '读取中…'), lagMs: st.lastAt ? Date.now() - st.lastAt : null }; }
  function candles(c, sec) { const x = D.tokens[String(c || '').toLowerCase()]; if (!x || !x.tr.length) return []; const r = KL.fromTrades(x.tr, sec, qUsd(x.q), CD_CAP); return r.err ? { err: r.err } : r; } /* KQ-1104：照时间合并＋排序＋去重＋补空格；报价币美金价没读到就不画 */
  const CD_CAP = 160; /* 运作：一次画几根 */
  /* 远端设定：新的发射台 Hook、备用节点，不用发新版（只接受格式正确的地址和 https 节点） */
  function extra(hooks = {}, rpcs = []) { for (const [h, p] of Object.entries(hooks || {})) if (/^0x[0-9a-f]{40}$/.test(String(h).toLowerCase()) && /^[a-z0-9]{2,16}$/.test(String(p))) C.hooks[String(h).toLowerCase()] = String(p); for (const u of rpcs || []) if (/^https:\/\/[a-z0-9.\-\/]+$/i.test(u) && !C.rpcs.includes(u) && C.rpcs.length < 8) { C.rpcs.push(u); RP.addPub(C.name === 'robinhood' ? 'robinhood' : 'bsc', u); } } /*NODE-1113 也加进节点池*/
  return { older, rpc, board, items, candles, extra, qUsd, info: (c) => { const x = D.tokens[String(c || '').toLowerCase()]; return x ? { grad: !!x.grad, pool: '' } : null; }, raw: () => ({ tokens: D.tokens, usd: (x) => qUsd(x.q) }), /*AUDIT125-B 不再给预设供应量*/ plat: (c) => D.tokens[String(c || '').toLowerCase()]?.plat || '', has: (c) => !!D.tokens[String(c || '').toLowerCase()], status: () => ({ ...st, total: Object.keys(D.tokens).length, pools: Object.keys(D.pools).length }) };
}
module.exports = { startV4 };
