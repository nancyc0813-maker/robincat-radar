// 罗宾猫雷达：代币板的行情资料（她 11/2：要像 TMTN／GMGN 一样列出全部的币）。
// 雷达自己读 BNB Chain 链上：Four.meme、Flap 两个发射台的「新币建立／买／卖／进度／上 PancakeSwap」事件，
// 自己算价格、市值、进度、成交量、买卖笔数。只读公开节点，不用金钥、不花钱、不碰钱包。
// 资料存在 data/market_bsc.json（只是快取，重开不用重抓）；BOARD-V3：不照时间删币，太多才从最久没动静的清（储存上限）。更早的币画面往下滑会向链上往回读（older）。
const fs = require('fs');
const path = require('path');
const KL = require('./kline.cjs'); /* KQ-1104：K 线共用格子 */

const FOUR = '0x5c952063c7fc8610ffdb798152d69f0b9550762b';           // Four.meme TokenManager2
const FOUR_HELPER = '0xf251f83e40a78868fcfa3fa4599dad6494e46034';    // Four.meme TokenManagerHelper3（读进度用）
const FLAP = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';           // Flap Portal
const T = {
  fCreate: '0x396d5e902b675b032348d3d2e9517ee8f0c4a926603fbc075d3d282ff00cad20',
  fBuy: '0x7db52723a3b2cdd6164364b3b766e65e540d7be48ffa89582956d8eaebe62942',
  fSell: '0x0a5575b3648bae2210cee56bf33254cc1ddfbc7bf637c0af2ac18b14fb1bae19',
  fLiq: '0xc18aa71171b358b706fe3dd345299685ba21a5316c66ffa9e319268b033c44b0',
  pCreate: '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603',
  pBuy: '0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7',
  pSell: '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a',
  pProg: '0x4c35e20d1e9bce377c7d9ec1572d934e46d62961f4da8af5beb8002d5906742d',
  pQuote: '0x3ceb902d3c555c21c3415b6aa839104b18e4825b2f8324011ff979089a507a8c',
  pDex: '0x6e4f47630b8745b8cacbd44f42a8a33e7eea7cc08ef22fc7630f4f385784ff7d',
};
const TOPICS = Object.values(T);
const STABLE = new Set(['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409']); // USDT USDC USD1 FDUSD
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const SET_TTL_MS = 10e3; const MAX_TRADES = 1500;
const MAX_TOKENS = 20000, TR_TOKENS = 3000; /* BOARD-V3 技术用：储存上限——快取最多留几个币、其中最近有动静的几个留成交明细（其余只留名字价格等）。不是列表的边界：已发射的币往下滑会向链上往回读 */

const RP = require('./rpcpool.cjs'); /* NODE-1113：节点池（玩家自己的节点优先、公开节点备用；查事件被拒的节点先不问） */
async function rpc(method, params) { return RP.rpc('bsc', method, params, 12000); }
const W = (d, i) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
const A = (w) => '0x' + String(w).slice(24).toLowerCase();
const N = (w) => { try { return BigInt('0x' + (w || '0')); } catch { return 0n; } };
const F = (b, dec = 18) => Number(b) / 10 ** dec;
function S(d, i) { try { const off = Number(N(W(d, i))) * 2; const len = Number(N(d.slice(2 + off, 2 + off + 64))); return Buffer.from(d.slice(2 + off + 64, 2 + off + 64 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 40); } catch { return ''; } }

function startMarket({ DATA, log = () => {} }) {
  let spAt = 0, spV = null; const soonPctOf = () => { if (Date.now() - spAt > SET_TTL_MS) { spAt = Date.now(); try { const v = JSON.parse(fs.readFileSync(path.join(DATA, 'radar_settings.json'), 'utf8'))['board.soonPct']; spV = v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); } catch { spV = null; } } return spV; }; /* 运作：设定档每 SET_TTL_MS 读一次 */
  const FILE = path.join(DATA, 'market_bsc.json');
  let D = { block: 0, tokens: {} };
  try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch {}
  const st = { ok: false, err: '', lastAt: 0, blockMs: 450, head: 0, headAt: 0 };
  let bnbUsd = 0, bnbAt = 0;
  const quoteUsd = {}; // 其他报价币（像 BNCB）的美金价，从 DexScreener 补
  async function bnb() { if (Date.now() - bnbAt < 60e3 && bnbUsd) return bnbUsd; try { const j = await (await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT', { signal: AbortSignal.timeout(8000) })).json(); if (+j.price > 0) { bnbUsd = +j.price; bnbAt = Date.now(); } } catch {} if (!bnbUsd) try { const j = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + WBNB, { signal: AbortSignal.timeout(8000) })).json(); const p = (j || []).find((x) => +x.priceUsd > 0); if (p) { bnbUsd = +p.priceUsd; bnbAt = Date.now(); } } catch {} return bnbUsd; }
  const qUsd = (q) => (!q || q === WBNB ? bnbUsd : STABLE.has(q) ? 1 : quoteUsd[q] || 0);
  const xUsd = (x) => (x.qk ? qUsd(x.q) : 0); /* 报价币还不确定（在补抓范围之前就建立的币）→ 先不算美金，免得市值乱跳 */
  const tok = (c) => (D.tokens[c] = D.tokens[c] || { c, tr: [] });
  const tsOf = (blk) => (st.headAt ? st.headAt - (st.head - blk) * st.blockMs : Date.now());
  const needInfo = new Set();
  /*SOON-1112 Four.meme 内盘进度＝已卖出的代币 ÷ 内盘可卖代币（跟 AVE、GMGN 显示的一样）；还没读到可卖总量时才用募到的钱 ÷ 目标 */
  const fProg = (x) => { if (x.maxO > 0 && x.offers != null) x.prog = Math.max(0, Math.min(100, ((x.maxO - x.offers) / x.maxO) * 100)); else if (x.maxF > 0) x.prog = Math.min(100, (x.funds / x.maxF) * 100); };

  let LK = ''; /* KQ-1104：目前这则事件的 txHash＋logIndex（同一则事件重抓不重复记） */
  function trade(c, t, buy, qAmt, price, who, q) {
    const x = D.tokens[c]; if (!x) return; /* 存报价币数量，显示时才换美金（报价币价钱晚到也算得对） */
    if (LK && x.tr.some((r) => r[5] === LK)) return;
    x.tr.push([Math.round(t / 1000), buy ? 1 : 0, +qAmt.toPrecision(6), +price.toPrecision(6), who.slice(2, 10), ...(LK ? [LK] : [])]); if (x.tr.length > MAX_TRADES) x.tr.splice(0, x.tr.length - MAX_TRADES);
    x.p = price; x.lt = t;
  }
  function onLog(l) {
    const t0 = l.topics[0], d = l.data, a = l.address.toLowerCase(), blk = parseInt(l.blockNumber, 16), t = tsOf(blk); LK = l.transactionHash ? String(l.transactionHash).slice(2, 14) + ':' + parseInt(l.logIndex, 16) : '';
    if (a === FOUR) {
      if (t0 === T.fCreate) { const c = A(W(d, 1)); const x = tok(c); Object.assign(x, { plat: 'four', at: x.at || t, dev: A(W(d, 0)), nm: S(d, 3), sym: S(d, 4), sup: F(N(W(d, 5))) }); needInfo.add(c); }
      else if (t0 === T.fBuy || t0 === T.fSell) { const c = A(W(d, 0)); if (!D.tokens[c]) { tok(c).plat = 'four'; needInfo.add(c); } const x = D.tokens[c]; x.funds = F(N(W(d, 7))); x.offers = F(N(W(d, 6))); if (!(x.maxO > 0) && x.plat === 'four') needInfo.add(c); fProg(x); { const qa = F(N(W(d, 4))), ta = F(N(W(d, 3))); trade(c, t, t0 === T.fBuy, qa, ta > 0 ? qa / ta : F(N(W(d, 2))), A(W(d, 1))); } }
      else if (t0 === T.fLiq) { const c = A(W(d, 0)); const x = D.tokens[c]; if (x) { x.grad = 1; x.gradAt = t; x.gradEv = 1; x.prog = 100; } }
    } else if (a === FLAP) {
      if (t0 === T.pCreate) { const c = A(W(d, 3)); const x = tok(c); Object.assign(x, { plat: 'flap', at: x.at || t, dev: A(W(d, 1)), nm: S(d, 4), sym: S(d, 5), sup: 1e9, qk: 1 }); }
      else if (t0 === T.pBuy || t0 === T.pSell) { const c = A(W(d, 1)); const x = D.tokens[c] || Object.assign(tok(c), { plat: 'flap', sup: 1e9 }); { const qa = F(N(W(d, 4))), ta = F(N(W(d, 3))); if (ta > 0) trade(c, t, t0 === T.pBuy, qa, qa / ta, A(W(d, 2))); } }
      else if (t0 === T.pProg) { const x = D.tokens[A(W(d, 0))]; if (x) x.prog = Math.min(100, F(N(W(d, 1)), 16)); }
      else if (t0 === T.pQuote) { const x = tok(A(W(d, 0))); const q = A(W(d, 1)); if (q !== '0x0000000000000000000000000000000000000000') x.q = q; }
      else if (t0 === T.pDex) { const x = D.tokens[A(W(d, 0))]; if (x) { x.grad = 1; x.gradAt = t; x.gradEv = 1; x.prog = 100; x.pool = A(W(d, 1)); } }
    }
  }
  async function info() { /* Four 的进度上限、报价币：每个新币问一次官方 Helper 合约 */
    const L = [...needInfo].slice(0, 40); if (!L.length) return; L.forEach((c) => needInfo.delete(c));
    for (let i = 0; i < L.length; i += 20) { const part = L.slice(i, i + 20); let res = [];
      for (const u of RP.order('bsc', 'eth_call').slice(0, 2)) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map((c, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: FOUR_HELPER, data: '0x1f69565f' + c.slice(2).padStart(64, '0') }, 'latest'] }))), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (Array.isArray(j)) { res = []; for (const x of j) res[x.id] = x.result || ''; break; } } catch {} }
      part.forEach((c, k) => { const r = res[k] || '', x = D.tokens[c]; if (!x || r.length < 2 + 64 * 12) return; const q = A(W(r, 2)); x.q = q === '0x0000000000000000000000000000000000000000' ? '' : q; x.qk = 1; x.maxF = F(N(W(r, 10))); x.funds = F(N(W(r, 9))); x.maxO = F(N(W(r, 8))); x.offers = F(N(W(r, 7))); fProg(x); if (N(W(r, 11)) > 0n) { x.grad = 1; x.prog = 100; x.gradAt = x.gradAt || Date.now(); } }); }
  }
  async function names() { /* 在补抓范围之前就建立的币，读不到名字 → 直接问合约 symbol() */
    const L = Object.values(D.tokens).filter((x) => !x.sym && !x.nmTried).slice(0, 20); if (!L.length) return; L.forEach((x) => (x.nmTried = 1));
    let res = []; try { const r = await fetch(RP.order('bsc', 'eth_call')[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(L.map((x, k) => ({ jsonrpc: '2.0', id: k, method: 'eth_call', params: [{ to: x.c, data: '0x95d89b41' }, 'latest'] }))), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (Array.isArray(j)) for (const x of j) res[x.id] = x.result || ''; } catch {}
    L.forEach((x, k) => { const r = res[k] || ''; if (r.length >= 130) x.sym = S(r, 0); }); }
  let qAt = 0;
  async function qPrices() { if (Date.now() - qAt < 120e3) return; qAt = Date.now(); const L = [...new Set(Object.values(D.tokens).map((x) => x.q).filter((q) => q && q !== WBNB && !STABLE.has(q)))]; if (!L.length) return; /*BOARD124 报价币不设上限：每 30 个一批（DexScreener 一次的上限）*/
    for (let i = 0; i < L.length; i += 30) try { const ps = await (await fetch('https://api.dexscreener.com/tokens/v1/bsc/' + L.slice(i, i + 30).join(','), { signal: AbortSignal.timeout(10000) })).json(); const best = {}; for (const p of Array.isArray(ps) ? ps : []) { const a = String(p.baseToken?.address || '').toLowerCase(); const lq = +p.liquidity?.usd || 0; if (+p.priceUsd > 0 && (!best[a] || lq > best[a].lq)) best[a] = { v: +p.priceUsd, lq }; } for (const [a, b] of Object.entries(best)) quoteUsd[a] = b.v; } catch {} }
  async function head() { const b = await rpc('eth_getBlockByNumber', ['latest', false]); const n = parseInt(b.number, 16), ts = parseInt(b.timestamp, 16) * 1000; if (st.head && n > st.head && st.headTs) st.blockMs = Math.max(200, Math.min(3000, (ts - st.headTs) / (n - st.head) || st.blockMs)); st.head = n; st.headTs = ts; st.headAt = Math.min(Date.now(), ts + 300); return n; }
  /* NODE-1113：同一则事件（txHash＋logIndex）只处理一次 —— WSS 推来的和轮询读到的会重复 */
  const SEEN = new Set(); const SEEN_MAX = 20000; /* 技术用：记住几则 */ const once = (l) => { const k = String(l.transactionHash || '') + ':' + String(l.logIndex || ''); if (k.length > 2) { if (SEEN.has(k)) return; SEEN.add(k); if (SEEN.size > SEEN_MAX) SEEN.delete(SEEN.values().next().value); } try { onLog(l); } catch {} };
  RP.subLogs('bsc', [{ address: [FLAP, FOUR], topics: [TOPICS] }], once); /* NODE-1113：有填 WSS 才会连 */
  async function pull(from, to) { const L = await rpc('eth_getLogs', [{ address: [FLAP, FOUR], /*BOARD124 老板 11/6：所有发射台都收（Four.meme 回来）；要不要看由画面「平台」筛选决定 */ topics: [TOPICS], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); for (const l of L) once(l); return L.length; }
  let busy = false, SPAN = 1500;
  async function tick() {
    if (busy) return; busy = true;
    try { await bnb(); const n = await head();
      let from = D.block ? D.block + 1 : n - 16000; if (n - from > 16000) from = n - 16000; /* 关很久再开：最多补 2 小时 */
      while (from <= n) { const to = Math.min(n, from + (n - from > 100 ? SPAN : 200)); try { await pull(from, to); } catch (e) { if (/limit|range|too many|exceed/i.test(String(e.message)) && SPAN > 50) { SPAN = Math.max(50, Math.floor(SPAN / 2)); continue; } throw e; } D.block = to; from = to + 1; } if (SPAN < 1500) SPAN = Math.min(1500, SPAN + 50); /* 她 11/2 19:17：公用节点回「limit exceeded」→ 每次查的范围自动缩小，之后慢慢放大 */
      await info(); await names(); await qPrices(); st.ok = true; st.err = ''; st.lastAt = Date.now();
    } catch (e) { st.ok = false; st.err = String(e.message || e).slice(0, 120); } finally { busy = false; }
  }
  function prune() { /* BOARD-V3：不照时间删；快取超过储存上限才从最久没动静的开始清 */ const act = (x) => Math.max(+x.at > 0 ? +x.at : 0, +x.lt > 0 ? +x.lt : 0); const L = Object.values(D.tokens).sort((a, b) => act(b) - act(a)); for (const x of L.slice(MAX_TOKENS)) delete D.tokens[x.c]; for (const x of L.slice(TR_TOKENS, MAX_TOKENS)) if (x.tr.length) x.tr = []; }
  async function older(kind, lo, hi) { /* BOARD-V3：往回读某段区块里 Flap 的「建立」或「上外盘」事件（只读；画面往下滑才会叫） */
    const L = await rpc('eth_getLogs', [{ address: [FLAP, FOUR], topics: [kind === 'grad' ? [T.pDex, T.fLiq] : [T.pCreate, T.fCreate]], fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) }]); /*BOARD124 Four.meme 也往回读*/
    return (Array.isArray(L) ? L : []).map((l) => { const d = l.data, t0 = l.topics[0], blk = parseInt(l.blockNumber, 16), ts = l.blockTimestamp ? (typeof l.blockTimestamp === 'string' ? parseInt(l.blockTimestamp, 16) : +l.blockTimestamp) * 1000 : null;
      if (t0 === T.fLiq) return { c: A(W(d, 0)), pool: '', blk, ts, plat: 'four' }; if (t0 === T.fCreate) return { c: A(W(d, 1)), dev: A(W(d, 0)), nm: S(d, 3), sym: S(d, 4), blk, ts, plat: 'four' };
      return kind === 'grad' ? { c: A(W(d, 0)), pool: A(W(d, 1)), blk, ts, plat: 'flap' } : { c: A(W(d, 3)), dev: A(W(d, 1)), nm: S(d, 4), sym: S(d, 5), blk, ts, plat: 'flap' }; }); }
  /*GRADFILL-1114 已上外盘的「上外盘时间」：雷达没开着的时候毕业的币，以前没有毕业时间、只能照建立时间排（例：慌啥子嘛早上建立、下午才上外盘，AVE 新外盘／GMGN 已开盘照上外盘时间排，雷达照建立时间排到后面去）。
     开机后在背景往回补读最近 GF_BACK_MS 的毕业事件（只读；只有 Four.meme 加池子／Flap 上 DEX 两种事件，量很少，一次一段、节点限流就缩小范围）。只影响看盘排序和「上外盘多久」显示，不进任何买卖判断 */
  const GF_BACK_MS = 24 * 3600e3, GF_TICK_MS = 3000, GT_MAX = 5000; /* 技术用：往回补多久、多久读一段、最多记几个币（显示用快取） */
  let gf = null, gfBusy = 0, GF_SPAN = SPAN; D.gt = D.gt && typeof D.gt === 'object' ? D.gt : {};
  async function gradFill() { if (gfBusy || !st.head || !st.headTs) return; if (!gf) gf = { lo: Math.max(0, st.head - Math.ceil(GF_BACK_MS / st.blockMs)), cur: st.head }; if (gf.cur <= gf.lo) return; gfBusy = 1;
    try { const from = Math.max(gf.lo, gf.cur - GF_SPAN); const [L, b] = await Promise.all([rpc('eth_getLogs', [{ address: [FLAP, FOUR], topics: [[T.pDex, T.fLiq]], fromBlock: '0x' + from.toString(16), toBlock: '0x' + gf.cur.toString(16) }]), rpc('eth_getBlockByNumber', ['0x' + gf.cur.toString(16), false])]);
      const endTs = parseInt(b?.timestamp, 16) * 1000; if (!(endTs > 0)) throw new Error('no block time'); /* 读不到这段的区块时间＝这段下一轮重读（不猜时间） */
      for (const l of Array.isArray(L) ? L : []) { const d = l.data, blk = parseInt(l.blockNumber, 16); const bt = l.blockTimestamp != null ? (typeof l.blockTimestamp === 'string' ? parseInt(l.blockTimestamp, 16) : +l.blockTimestamp) * 1000 : NaN; const ts = bt > 0 ? bt : endTs - (gf.cur - blk) * st.blockMs; /* 节点有给事件时间就用；没给用这段最后一块的时间往回推（一段只有几分钟，误差很小） */
        const c = A(W(d, 0)); const x = D.tokens[c]; if (x) { if (!x.gradEv) { x.grad = 1; x.gradAt = ts; x.gradEv = 1; x.prog = 100; if (l.topics[0] === T.pDex) x.pool = A(W(d, 1)); } } else if (!(+D.gt[c] > 0)) D.gt[c] = ts; }
      const ks = Object.keys(D.gt); if (ks.length > GT_MAX) ks.sort((a, b2) => D.gt[a] - D.gt[b2]).slice(0, ks.length - GT_MAX).forEach((k) => delete D.gt[k]);
      gf.cur = from - 1; if (GF_SPAN < SPAN) GF_SPAN = Math.min(SPAN, GF_SPAN + 50);
    } catch (e) { if (/limit|range|too many|exceed/i.test(String(e?.message || e)) && GF_SPAN > 50) GF_SPAN = Math.max(50, Math.floor(GF_SPAN / 2)); } finally { gfBusy = 0; } }
  function save() { try { prune(); fs.writeFileSync(FILE, JSON.stringify(D)); } catch {} }
  setInterval(tick, 2500); setTimeout(tick, 500); setInterval(save, 60e3); setInterval(() => { supFill().catch(() => {}); }, 2500); /*AUDIT125-B*/ setInterval(() => { gradFill().catch(() => {}); }, GF_TICK_MS); /*GRADFILL-1114*/

  /* 给画面用：每个币算好各时间段的成交、涨跌、买卖笔数 */
  const TF = { m1: 60, m5: 300, m15: 900, h1: 3600, h6: 21600, h24: 86400 };
/*AUDIT125-B 供应量读链上 totalSupply（÷10^decimals，存在 x.sup，跟着本机资料存档）；读不到＝市值读不到（null），不拿 10 亿冒充。每轮只补几个（技术用，节点额度） */
  const SUP_BATCH = 10, SUP_RETRY_MS = 10 * 60e3; let supBusy = 0;
  async function supFill() { if (supBusy) return; supBusy = 1; try { const now = Date.now(); const L = Object.values(D.tokens).filter((x) => !(x.sup > 0) && !(now - (x.supAt || 0) < SUP_RETRY_MS)).sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, SUP_BATCH);
    for (const x of L) { x.supAt = now; try { const [t, d] = await Promise.all([rpc('eth_call', [{ to: x.c, data: '0x18160ddd' }, 'latest']), rpc('eth_call', [{ to: x.c, data: '0x313ce567' }, 'latest'])]); if (!/^0x[0-9a-f]{1,64}$/i.test(String(t || '')) || !/^0x[0-9a-f]{1,64}$/i.test(String(d || ''))) continue; const ts = BigInt(t), dec = Number(BigInt(d)); if (ts > 0n && dec <= 36) x.sup = Number(ts) / 10 ** dec; } catch {} } } finally { supBusy = 0; } }
  function view(x) { const now = Date.now() / 1000, u = xUsd(x); const out = { c: x.c, plat: x.plat, sym: x.sym || x.nm || x.c.slice(0, 8), nm: x.nm || '', at: x.at || (x.tr[0] ? x.tr[0][0] * 1000 : 0), dev: x.dev || '', prog: x.prog ?? (x.plat === 'flap' ? null : null), grad: !!x.grad, gradAt: x.gradAt || 0, pool: x.pool || (x.plat === 'four' ? x.c : ''), q: x.q || '', chg: {}, vol: {}, tx: {} };
    const px = x.p || 0; const ok = px > 0 && u > 0; out.price = ok ? px * u : null; out.mc = ok && x.sup > 0 ? px * x.sup * u : null; /*AUDIT125-B 供应量读链上（supFill）；读不到＝null，不用 10 亿*/ out.liq = x.plat === 'four' && x.funds && u > 0 ? x.funds * u : null; /* CHAIN-1104 D8：读不到价格／报价币美金价＝null（画面显示「—」），不显示 $0 */
    for (const [k, s] of Object.entries(TF)) { const R = x.tr.filter((r) => r[0] >= now - s); let b = 0, se = 0, v = 0; const w = new Set(); for (const r of R) { r[1] ? b++ : se++; v += r[2]; w.add(r[4]); } out.vol[k] = u > 0 ? Math.round(v * u) : null; out.tx[k] = { b, s: se, u: w.size }; out.chg[k] = KL.winChg(x.tr, now - s, px); /* KQ-1104：基准＝窗口开始前最后一笔；读不到＝null */ }
    out.n = x.tr.length; out.la = x.tr.length ? x.tr[x.tr.length - 1][0] * 1000 : +x.lt > 0 ? +x.lt : 0; /* NX-1103：最后成交时间（BOARD-V3：明细清掉的用最后成交时间） */ return out; }
  function board() {
    const all = Object.values(D.tokens).filter((x) => x.plat && (x.at || x.tr.length || x.lt)); /*BOARD124 不挡 Four.meme*/ const V = all.map(view);
    const sp = soonPctOf(); const isSoon = (x) => sp != null && x.prog != null && x.prog >= sp; /* ZR-INT：「即将发射」栏＝你的 board.soonPct（空白＝不分栏，全部放「新创建」）；读不到进度的放「新创建」 */
    const fresh = V.filter((x) => !x.grad && !isSoon(x)).sort((a, b) => b.at - a.at); /* ZR-INT：清单不截断，全部列出 */
    const soon = V.filter((x) => !x.grad && isSoon(x)).sort((a, b) => (b.prog || 0) - (a.prog || 0));
    const done = V.filter((x) => x.grad).sort((a, b) => (b.gradAt || b.at) - (a.gradAt || a.at));
    return { cols: [{ k: 'fresh', zh: '🆕 新创建', en: '🆕 New', items: fresh }, { k: 'soon', zh: '🚀 即将发射', en: '🚀 About to launch', items: soon }, { k: 'done', zh: '✅ 已迁移', en: '✅ Migrated', items: done }],
      src: 'chain', at: st.lastAt, total: all.length, err: (st.ok || (st.lastAt && Date.now() - st.lastAt < 60e3)) ? '' : (st.err ? '读链暂时不顺：' + st.err : '读取中…'), lagMs: st.lastAt ? Date.now() - st.lastAt : null }; }
  /* 曲线上的币没有交易池可以画 K 线 → 用链上成交自己画 */
  function candles(c, sec) { const x = D.tokens[String(c || '').toLowerCase()]; if (!x || !x.tr.length) return []; const r = KL.fromTrades(x.tr, sec, xUsd(x), CD_CAP); return r.err ? { err: r.err } : r; } /* KQ-1104：照时间合并＋排序＋去重＋补空格；报价币美金价还没读到就不画（不把 BNB 当美金） */
  const CD_CAP = 160; /* 运作：一次画几根 */
  function setQuoteUsd(q, v) { if (v > 0) quoteUsd[q] = v; }
  function quotes() { return [...new Set(Object.values(D.tokens).map((x) => x.q).filter((q) => q && q !== WBNB && !STABLE.has(q)))]; } /*BOARD124*/
  return { older, rpc, board, candles, raw: () => ({ tokens: D.tokens, usd: (x) => xUsd(x), gt: D.gt }), /*GRADFILL-1114 gt＝不在快取里的币的毕业时间（毫秒）*/ plat: (c) => D.tokens[String(c || '').toLowerCase()]?.plat || '', has: (c) => !!D.tokens[String(c || '').toLowerCase()], setQuoteUsd, quotes, qUsd, want: (c) => { c = String(c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || needInfo.size > 200) return; if (!D.tokens[c]) tok(c).plat = 'four'; const x = D.tokens[c]; if (!x.qk || !(x.maxO > 0)) needInfo.add(c); }, /*SOON-1112 看盘「即将打满」的 Four.meme 币雷达还没读过进度 → 排进下一轮读*/ info: (c) => { const x = D.tokens[String(c || '').toLowerCase()]; return x ? { grad: !!x.grad, pool: x.pool || '' } : null; }, status: () => ({ ...st, total: Object.keys(D.tokens).length }) };
}
module.exports = { startMarket };
