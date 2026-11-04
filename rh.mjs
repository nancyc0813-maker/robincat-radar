// 罗宾猫雷达 · Robinhood Chain（4663）自动打
// 11/2 她定：两条链都要自动打，风险我自己抓、自己排除。Robinhood 没有 Agent ID，所以改用「真人买家＋防捆绑＋防抽池＋卖得掉」四层检查
const rhConds = (o) => [ /* NJ-1103：Robinhood 热门代币的条件（照你的组合方式）。o 里 null＝读不到、undefined＝还没查 */
  { k: 'rh.maxAgeMin', name: '开池时间', unit: ' 分钟', op: '<=', v: o.age }, { k: 'rh.minLiqUsd', name: '流动性', unit: ' U', op: '>=', v: o.liq },
  { k: 'rh.minRealBuyers', name: RHC.realWinMin != null ? `${RHC.realWinMin} 分钟内真实买家` : '真实买家（没填「几分钟内」）', unit: ' 个', op: '>=', v: RHC.realWinMin != null ? o.real : null, missWhy: RHC.realWinMin != null ? undefined : '你没填「几分钟内」' }, /* 「几分钟内」空白＝读不到（不买），不拿掉这条 */ { k: 'rh.maxBundle', name: '捆绑钱包持有', unit: '%', op: '<=', v: o.bundle },
  { k: 'rh.maxTop10', name: '前 10 大持有', unit: '%', op: '<=', v: o.top10 }, { k: 'rh.maxDev', name: '部署者自己持有', unit: '%', op: '<=', v: o.dev },
  { k: 'rh.mcMin', name: '市值', unit: ' U', op: '>=', v: o.mc }, { k: 'rh.mcMax', name: '市值', unit: ' U', op: '<=', v: o.mc }, { k: 'rh.maxRoundTrip', name: '模拟买进马上卖的亏损', unit: '%', op: '<=', v: o.rt },
  { k: 'rh.needSmart', name: '你标记的聪明钱包买过', op: 'yes', v: o.smart }, { k: 'rh.needCall', name: '被你监测的频道／帐号喊过', op: 'yes', v: o.call }, { k: 'rh.needSocial', name: '有官方 X／TG', op: 'yes', v: o.social } ];
const rhJ = (o) => (globalThis.NR?.judge ? globalThis.NR.judge('rh', rhConds(o)) : { buy: false, why: '设定还没载入', lines: [], text: '设定还没载入，不会买' });
export const RHC = { /* NR-1103（11/3 Nancy）：程式里不留任何官方数字。全部来自你的设定 rh.*；没开／没填 = 「至少」类 0、「最多」类无限大、金额 null（不自动买） */
  usd: null, dayUsd: null, /* apply() 定期照你的设定更新 */ maxPos: Infinity, maxAgeMin: Infinity, minLiqUsd: 0, minRealBuyers: 0, real: 0, oldNonce: 0, minEth: 0, earlySec: null, freshNonce: null, sameAmtN: null,
  maxBundle: Infinity, maxTop10: Infinity, maxDev: Infinity, maxRoundTrip: Infinity, lpDrop: Infinity, bundleSellPct: Infinity, backX: Infinity, steps: [], crash: Infinity, crashAfterBack: Infinity,
  auto: 0, mintAuto: 0, mintUsd: null, mintDayUsd: null, mintMinReal: 0, mintWinMin: null, mintMaxFresh: Infinity, mintFreshNonce: null,
};
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const DS_BATCH = 30; /* 接口限制：DexScreener 一次能查的地址数（分批查，全部都会查到） */ const SCAN_BUDGET = 3, LOG_BUDGET = 20000, MINT_CHECK_BUDGET = 4, NAME_BUDGET = 25, MINTER_MEM = 3000, MW_MAX = 30000, RECHECK_MS = 5 * 60e3; /* 每轮读链的量（不是买卖门槛）：超过的排队下一轮；转账记录超过 LOG_BUDGET 笔没读完 → 当「读不到」 */ 
const RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com']; /* 官方会限流 → 轮流用三个；nodeflare 限流很严，而且历史查询会回假资料，不用 */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (x) => String(x || '').toLowerCase();
const isAddr = (x) => /^0x[0-9a-f]{40}$/.test(lc(x));

export function startRH(ctx) {
  const { WALLETS, log, tg, S, save, radarOff } = ctx;
  const conflOf = () => { try { return String(ctx.confl?.() || ''); } catch { return ''; } }; /*RISK-FIX 1：另一个雷达正在用同一个钱包（引擎的 CONFL）→ 自动卖先停，避免两边重复卖 */
  const RH_SELLING = new Set(); /*RISK-FIX 2：同一个钱包同一个币同时只送一张卖单（手动卖、自动卖不会撞，剩下比例 w.rem 不会算错） */
  const remCost = (w) => (+w.cost || 0) * (Number.isFinite(+w.rem) ? Math.max(0, Math.min(1, +w.rem)) : 1); /*RISK-FIX3：剩下的成本＝总成本×剩下比例 */
  const SELL_CTX = new WeakMap(); /*RISK-FIX3 A：卖单送出当下的剩下成本 cl、平均买入价 ap0，和送单期间的加码 adds（只在记忆体） */
  const reAp = (ap0, qLeft, adds) => { let ap = ap0 > 0 ? ap0 : 0, q = qLeft; if (!Number.isFinite(q) || q < 0) return null; for (const x of adds) { if (!(x.add > 0)) continue; if (!(x.q > 0) || (!(ap > 0) && q > 0)) return null; ap = (q * ap + x.add) / (q + x.q); q += x.q; } return ap > 0 ? ap : null; }; /*RISK-FIX3：平均买入价＝（卖剩的颗数×旧平均价＋每次加码的钱）÷（颗数＋加码买到的）；读不到颗数＝null（下次持仓检查照「剩下成本÷余额」定） */
  const ACTW = new Map(); const actOn = (a) => { const s = ACTW.get(a) || new Set(); ACTW.set(a, s); const t = { ov: s.size ? 1 : 0 }; for (const o of s) o.ov = 1; s.add(t); return t; }, actOff = (a, t) => { ACTW.get(a)?.delete(t); }, touchW = (a) => { for (const o of ACTW.get(a) || []) o.ov = 1; }; /*RISK-FIX3 G：同一个钱包同时有别的买／卖／铸造 → 这笔卖出拿回多少（ETH 余额差）算不准 */
  const shut = (w) => { if (!(remCost(w) > 1e-6)) w.closed = 1; }; /*RISK-FIX3 F：全卖了，但卖的期间又加码（还有剩下成本）→ 不标已结束，继续追踪 */
  async function settlePend(c, P, W, w, nb, sp) { if (!sp || w.sellPend !== sp) return; delete w.sellPend; /*RISK-FIX3 C：逾时卖单确认成交，只结算一次 */
    const b0 = Number(BigInt(sp.bal0)), b0o = Number(BigInt(sp.bal0o ?? sp.bal0)), n = Number(nb); let cp = null, f = 0;
    if (sp.cl0 != null && b0o > 0) { f = Math.max(0, Math.min(1, (b0 - n) / b0o)); cp = +sp.cl0 * f; const left = Math.max(0, remCost(w) - cp); if (+w.cost > 0) w.rem = Math.min(1, left / +w.cost); else w.rem = (Number.isFinite(+w.rem) ? +w.rem : 1) * (1 - f); if (sp.adds?.length) { const ap = reAp(+sp.ap0, +sp.ap0 > 0 ? sp.cl0 * (1 - f) / +sp.ap0 : (sp.cl0 * (1 - f) > 1e-12 ? NaN : 0), sp.adds); if (ap) w.ap = ap; else delete w.ap; } }
    else if (b0 > 0) { const r0 = Number.isFinite(+w.rem) ? +w.rem : 1; f = Math.max(0, 1 - Math.min(1, n / b0)); cp = (+w.cost || 0) * r0 * f; w.rem = r0 * (1 - f); } /* 旧版逾时记录（没有 cl0）：照以前 AMT-2 的算法 */
    if (nb === 0n) w.closed = 1;
    R.trades = R.trades || []; R.trades.push({ sym: P.sym, c, w: W.addr, pct: +(f * 100).toFixed(1), why: sp.why + '（逾时后确认成交）', ok: true, at: Date.now(), usd: null, cp: cp == null ? null : +cp.toFixed(2), manual: P.manual ? 1 : 0 }); if (R.trades.length > 2000) R.trades.splice(0, R.trades.length - 2000); /* 拿回多少已经量不到＝null（日记照记、已实现盈亏不算这笔） */
    save(); await tg(`✅ [Robinhood][${W.name}] ${P.sym} 之前结果不明的卖单已经成交（余额变少了）：${sp.why}`).catch(() => {}); }
  S.rh = S.rh || {}; S.rh.pos = S.rh.pos || {}; S.rh.seen = S.rh.seen || {}; S.rh.black = S.rh.black || {}; S.rh.day = S.rh.day || {};
  const R = S.rh; let ri = 0;
  globalThis.RH_ADD_RPC = (u) => { u = String(u || ''); if (!/^https:\/\/[^\s@/]+(\/[^\s]*)?$/.test(u) || RPCS.includes(u)) return; RPCS.splice(1, 0, u); log('Robinhood：用上你在设定填的节点 ' + u.replace(/^(https:\/\/[^/]+).*/, '$1')); }; /* H4：你在「设定 → 节点」填的节点，雷达问过是 Robinhood 链（4663）才会加进来；查事件记录仍用第一个官方节点 */ for (const u of globalThis.RH_USER_RPCS || []) globalThis.RH_ADD_RPC(u);
  async function rpc(method, params) { let last; const LG = method === 'eth_getLogs'; /* 11/2 自查：drpc 免费版和 thirdweb 查不了转账记录 → 只用官方节点，多试几次 */ for (let i = 0; i < (LG ? 4 : RPCS.length); i++) { const u = LG ? RPCS[0] : RPCS[(ri + i) % RPCS.length]; if (LG && i) await sleep(1500); try { const rs = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20000) }); if (rs.status === 429) throw new Error('Too Many Requests'); const j = await rs.json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (e) { last = e; ri++; if (/Too Many|rate/i.test(e.message)) await sleep(800); } } throw last; }
  async function batch(calls) { const out = []; for (let i = 0; i < calls.length; i += 20) { const part = calls.slice(i, i + 20); let ok = false; for (let k = 0; k < RPCS.length && !ok; k++) { try { const j = await (await fetch(RPCS[(ri + k) % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(part.map(([m, p], n) => ({ jsonrpc: '2.0', id: n, method: m, params: p }))), signal: AbortSignal.timeout(20000) })).json(); const by = new Map((Array.isArray(j) ? j : []).map((x) => [x.id, x.result])); part.forEach((_, n) => out.push(by.get(n) ?? null)); ok = Array.isArray(j); if (!ok) throw 0; } catch { await sleep(600); } } if (!ok) part.forEach(() => out.push(null)); await sleep(300); } return out; }
  const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
  const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
  const wa = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');
  const ACKD = (opt) => !!(opt?.ack === true || opt?.ack === 1 || globalThis.ACK_STORE?.()?.ack); /* ZR-INT-ACK：这张单你按了「我知道风险，仍然执行」 */ const NEED_OK = '⚠️需要确认：'; /* 工具的判断只是警告：手动单要你按「仍然执行」才送；自动单照你的「预演不过也送出」开关 */
  const day = () => new Date().toLocaleDateString('sv-SE'); /* ZR-1103：每日额度照这台电脑的日期换日（跟 watch.mjs 一样），不再写死 UTC+8 */
  const spent = (a) => R.day[day()]?.[a] || 0;
  const addSpent = (a, u) => { const d = day(); R.day = { [d]: { ...(R.day[d] || {}), [a]: spent(a) + u } }; };
  let bps = 4; // 每秒几个区块（启动时校正）
  (async () => { try { const h = parseInt(await rpc('eth_blockNumber', []), 16); const [a, b] = await Promise.all([rpc('eth_getBlockByNumber', ['0x' + h.toString(16), false]), rpc('eth_getBlockByNumber', ['0x' + (h - 20000).toString(16), false])]); const dt = parseInt(a.timestamp, 16) - parseInt(b.timestamp, 16); if (dt > 0) bps = 20000 / dt; log(`[Robinhood] 区块速度约 ${bps.toFixed(2)} 块/秒`); } catch (e) { log('[Robinhood] 校正区块速度失败 ' + e.message); } })();

  globalThis.RH_ETHUSD = () => ethUsd(); /* 手机下单额度换算用（只读价格） */
  async function ethUsd() { /* ZR-1103：不再用官方的「价格 > 某数、池子 ≥ 某数」门槛 → 取 Robinhood 上流动性最大的 WETH 池子（假池子做不到比真池子大）；Robinhood 读不到才看全网流动性最大的 WETH 池子；都读不到＝0（读不到价格 → 不买） */
    const RH_WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', RH_USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'; /* PLUGEX-R2：Robinhood 的 ETH 价格只认这两个合约组成的池子（symbol 可以假冒，假池的流动性也可以比 Robinhood 上的真池大） */ const best = (ps, rhOnly) => (ps || []).filter((p) => (rhOnly ? (p.chainId === 'robinhood' && lc(p.baseToken?.address) === RH_WETH && lc(p.quoteToken?.address) === RH_USDG) : p.baseToken?.symbol === 'WETH') && +p.priceUsd > 0 && +p.liquidity?.usd > 0).sort((a, b) => +b.liquidity.usd - +a.liquidity.usd)[0];
    try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH%20USDG', { signal: AbortSignal.timeout(12000) })).json(); const b = best(j.pairs, true); if (b) return +b.priceUsd; } catch {}
    try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/search?q=WETH', { signal: AbortSignal.timeout(12000) })).json(); const b = best(j.pairs, false); if (b) return +b.priceUsd; } catch {} return 0; }
  async function dsInfo(addrs) { const m = new Map(); for (let i = 0; i < addrs.length; i += DS_BATCH) { try { const j = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${addrs.slice(i, i + DS_BATCH).join(',')}`, { signal: AbortSignal.timeout(12000) })).json(); for (const p of j || []) { const t = lc(p.baseToken?.address); const liq = +(p.liquidity?.usd) || 0; if (!m.has(t) || liq > m.get(t).liq) m.set(t, { price: +p.priceUsd || 0, liq, pair: lc(p.pairAddress), sym: p.baseToken?.symbol }); } } catch {} } return m; }
  async function quote(W, from, to, qty) { const r = await W.baw(['market-order', 'quote', '--binanceChainId', '4663', '--fromTokenQty', String(qty), '--fromToken', from, '--toToken', to]); if (!r.j?.success) throw new Error(String(r.j?.error?.message || r.t).slice(0, 120)); return +r.j.data.toCoinAmount; }
  async function decimals(t) { const d = await call(t, '0x313ce567'); if (!d || d.length < 66) return null; const n = Number(big(d)); return Number.isInteger(n) && n >= 0 && n <= 77 ? n : null; } /* BUG3：读不到＝null（不动作），0 位小数也可以 */
  const fmtU = (v, d) => { v = BigInt(v); const D = 10n ** BigInt(d); const i = v / D, f = v % D; const fs = d > 0 ? f.toString().padStart(d, '0').replace(/0+$/, '') : ''; return fs ? `${i}.${fs}` : `${i}`; }; /* BUG3：精确换算 */

  // ── 候选：GeckoTerminal 热门＋新池（DexScreener 补），同名多池直接跳过 ──
  async function candidates() {
    const pools = [];
    for (const k of ['new_pools', 'trending_pools']) { try { const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/robinhood/${k}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(12000) })).json(); for (const p of j.data || []) { const a = p.attributes || {}; pools.push({ c: lc(String(p.relationships?.base_token?.data?.id || '').split('_').pop()), sym: String(a.name || '').split(' / ')[0].trim(), pool: lc(a.address), liq: +a.reserve_in_usd || 0, ageMin: a.pool_created_at ? (Date.now() - Date.parse(a.pool_created_at)) / 60e3 : null, buys: a.transactions?.h1?.buys || 0, sells: a.transactions?.h1?.sells || 0 }); } } catch {} await sleep(1500); }
    { try { const seen = new Set(); /* ZR-1103：两个来源都看 */ for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1']) { const j = await (await fetch('https://api.dexscreener.com/' + u, { signal: AbortSignal.timeout(12000) })).json(); for (const x of j || []) if (x.chainId === 'robinhood') seen.add(lc(x.tokenAddress)); }
        const ids = [...seen].filter(isAddr); for (let i = 0; i < ids.length; i += DS_BATCH) { try { const ps = await (await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${ids.slice(i, i + DS_BATCH).join(',')}`, { signal: AbortSignal.timeout(12000) })).json(); for (const p of ps || []) pools.push({ c: lc(p.baseToken?.address), sym: String(p.baseToken?.symbol || ''), pool: lc(p.pairAddress), liq: +(p.liquidity?.usd) || 0, ageMin: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60e3 : null, buys: Number.isFinite(+p.txns?.h1?.buys) ? +p.txns.h1.buys : null, sells: Number.isFinite(+p.txns?.h1?.sells) ? +p.txns.h1.sells : null }); /* 读不到＝null，不当 0 */ } catch {} } } catch {} } /* 全部分批查，不丢 */ /* GeckoTerminal 被限流时改用 DexScreener，不会整个瞎掉 */
    try { const { readFileSync } = await import('node:fs'); const J = JSON.parse(readFileSync(new URL('./data/rh_cand.json', import.meta.url), 'utf8')); if (Date.now() - (J.at || 0) < 10 * 60e3) for (const x of J.list || []) pools.push({ c: lc(x.c), sym: String(x.sym || ''), pool: '', liq: +x.liq || 0, ageMin: (Date.now() - (x.at || 0)) / 60e3, buys: Number.isFinite(+x.b) && x.b !== '' && x.b != null ? +x.b : null, sells: Number.isFinite(+x.s) && x.s !== '' && x.s != null ? +x.s : null }); } catch {} /* 11/2：雷达自己读链看到的新币（Pons、Long…）也交给引擎检查 */
    const bySym = new Map(); for (const p of pools) { const s = p.sym.toUpperCase(); if (!bySym.has(s)) bySym.set(s, new Set()); bySym.get(s).add(p.c); }
    const firstOf = {}; for (const p of pools) { const k = p.sym.toUpperCase(); const fa = pools.find((x) => x.c === firstOf[k])?.ageMin; if (!firstOf[k] || (p.ageMin != null && (fa == null || p.ageMin > fa))) firstOf[k] = p.c; } /* 开池最久的＝最早发的（读不到开池时间的不算最早） */
    const seen = new Set(), out = [];
    for (const p of pools) { if (!isAddr(p.c) || seen.has(p.c)) continue; seen.add(p.c);
      if (bySym.get(p.sym.toUpperCase()).size > 1 && RHC.firstOnly === 1 && firstOf[p.sym.toUpperCase()] !== p.c) { note(p, '同名有好几个币，这个不是最早发的（仿盘），跳过'); continue; } /* 她 11/2：按键「同名仿盘不打，只认第一个」 */
      if (!(p.liq > 0)) { note(p, '流动性是 0，数据不可信'); continue; }
      { const J0 = rhJ({ age: p.ageMin, liq: p.liq }); if (J0.buy === false) { note(p, J0.text, 1); continue; } } /* NJ-1103 */
      if ((RHC.antiWash === 1 && RHC.washBuys != null && RHC.washSells != null || RHC.needBuyGtSell === 1) && (p.buys == null || p.sells == null)) { note(p, '1 小时买卖笔数读不到（你开了看买卖笔数的规则）→ 不买', 1); continue; }
      if (RHC.antiWash === 1 && RHC.washBuys != null && RHC.washSells != null && p.buys >= RHC.washBuys && p.sells <= RHC.washSells) { note(p, `1 小时买 ${p.buys}／卖 ${p.sells}，买单一面倒，像刷出来的热度`, 1); continue; } /* 她 11/2 按键：假热度不打 */
      if (RHC.needBuyGtSell === 1 && p.buys <= p.sells) { note(p, `1 小时买 ${p.buys}／卖 ${p.sells}，卖比买多`, 1); continue; }
      out.push(p); }
    return out;
  }
  function note(p, why, retry) { const o = R.seen[p.c] || {}; R.seen[p.c] = { ...o, sym: p.sym || o.sym, at: Date.now(), why, ok: false, retry: !!retry, liq: p.liq ?? o.liq }; if (RHC.auto === 1 && o.why !== why) globalThis.NR?.decLog?.('rh', p.c, p.sym, { buy: false, text: '不买：' + why, lines: ['⛔ ' + why], why }, 1); } /* 候选阶段的「不买」也写判断日志 */

  // ── 深度检查：真人买家、捆绑、持币集中、后门、卖得掉 ──
  async function analyze(c, poolHint, manual, opt = {}) {
    const head = opt.toBlock || parseInt(await rpc('eth_blockNumber', []), 16); const TB = '0x' + head.toString(16);
    let from = Math.max(0, head - Math.ceil(bps * 3600 * 6)); let logs = [], trunc = false; /* 从最近一段开始往前找到开盘（铸出）那一笔；只是读资料的分段 */
    for (let tries = 0; tries < 3; tries++) { try { logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: TB, address: c, topics: [TRANSFER] }]); } catch (e) { if (!/ranges over|block range|too many|response size/i.test(e.message)) throw e; logs = []; for (let a = from; a <= head; a += 9000) { const lg = await rpc('eth_getLogs', [{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(head, a + 8999).toString(16), address: c, topics: [TRANSFER] }]); logs.push(...lg); if (logs.length > LOG_BUDGET) { trunc = true; break; } } } /* 11/2 自查：免费节点一次只给查 1 万个区块 → 自动切段 */ if (logs.some((l) => lc('0x' + l.topics[1].slice(26)) === ZERO) || from === 0) break; from = Math.max(0, from - Math.ceil(bps * 3600 * 24)); }
    if (!logs.length) return { ok: false, why: '查不到转账记录' };
    if (!logs.some((l) => lc('0x' + l.topics[1].slice(26)) === ZERO) && from > 0) trunc = true; /* ZR-1103：没读到开盘那一段 → 持有、捆绑这些数字不完整 → 当「读不到」 */
    const tf = logs.map((l) => ({ from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)), v: big(l.data), b: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
    let supply = 0n; const bal = new Map(); const add = (a, v) => bal.set(a, (bal.get(a) || 0n) + v);
    let deployer = null; for (const t of tf) { if (t.from === ZERO) { supply += t.v; if (!deployer) deployer = t.to; } else add(t.from, -t.v); if (t.to === ZERO || t.to === DEAD) supply -= t.v; else add(t.to, t.v); }
    if (supply <= 0n) { supply = big(await call(c, '0x18160ddd')); }
    if (supply <= 0n) return { ok: false, why: '读不到总量' };
    // 池子（或 v4 的 PoolManager）= 出现在最多笔交易里的「转出方」
    const cnt = new Map(); for (const t of tf) if (t.from !== ZERO) cnt.set(t.from, (cnt.get(t.from) || new Set()).add(t.tx));
    let pool = isAddr(poolHint) ? lc(poolHint) : null; if (!pool || !cnt.has(pool)) pool = [...cnt.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0];
    const byTx = new Map(); for (const t of tf) { if (!byTx.has(t.tx)) byTx.set(t.tx, []); byTx.get(t.tx).push(t); }
    const buys = [], sells = [];
    for (const [tx, arr] of byTx) { const net = new Map(); for (const t of arr) { net.set(t.from, (net.get(t.from) || 0n) - t.v); net.set(t.to, (net.get(t.to) || 0n) + t.v); }
      const pn = net.get(pool) || 0n; const others = [...net.entries()].filter(([a]) => a !== pool && a !== ZERO && a !== c);
      if (pn < 0n) { const [who, v] = others.sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] || []; if (who && v > 0n) buys.push({ who, v, b: arr[0].b }); }
      else if (pn > 0n) { const [who, v] = others.sort((a, b) => (a[1] > b[1] ? 1 : -1))[0] || []; if (who && v < 0n) sells.push({ who, v: -v, b: arr[0].b }); } }
    if (!buys.length) return { ok: false, why: '还没有人买' };
    buys.sort((a, b) => a.b - b.b); const first = buys[0].b, earlyEnd = RHC.earlySec != null ? first + Math.max(1, Math.ceil(bps * RHC.earlySec)) : -1; /* NR-1103：开盘几秒内算捆绑＝你的设定（没开＝不算） */
    const early = new Set(buys.filter((x) => x.b <= earlyEnd).map((x) => x.who));
    const share = (set) => Number(([...set].reduce((s, a) => s + ((bal.get(a) || 0n) > 0n ? bal.get(a) : 0n), 0n) * 10000n) / supply) / 10000;
    const skipA = new Set([pool, ZERO, DEAD, c]);
    const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !skipA.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const top10 = Number((holders.slice(0, 10).reduce((s, [, v]) => s + v, 0n) * 10000n) / supply) / 10000;
    const devPct = deployer && !skipA.has(deployer) ? Number(((bal.get(deployer) || 0n) * 10000n) / supply) / 10000 : 0;
    // 钱包新旧（交易次数）
    const hourAgo = RHC.realWinMin != null ? head - Math.ceil(bps * 60 * RHC.realWinMin) : null; /* ZR-INT-RH：看多久＝你的 rh.minRealBuyersWinMin */
    const recentBuyers = hourAgo == null ? [] : [...new Set(buys.filter((x) => x.b >= hourAgo).map((x) => x.who))]; /* ZR-1103：全部都查 */
    const checkAddrs = [...new Set([...(RHC.real ? recentBuyers : []), ...(RHC.freshNonce != null ? holders.map(([a]) => a) : []), ...early])]; /* 只在你开了「真人／新开钱包」定义时才查（全部持有人，不只前几名） */
    const nonces = await batch(checkAddrs.map((a) => ['eth_getTransactionCount', [a, 'latest']]));
    const ethb = RHC.real ? await batch(recentBuyers.map((a) => ['eth_getBalance', [a, 'latest']])) : []; const EB = new Map(recentBuyers.map((a, i) => [a, ethb[i] == null ? -1 : Number(big(ethb[i])) / 1e18]));
    const N = new Map(checkAddrs.map((a, i) => [a, nonces[i] == null ? -1 : parseInt(nonces[i], 16)]));
    const realBuyers = hourAgo == null ? null : RHC.real ? recentBuyers.filter((a) => N.get(a) >= RHC.oldNonce && EB.get(a) >= RHC.minEth).length : recentBuyers.length; /* NR-1103：真人怎么算＝你的设定（没开＝都算）；真人 = 交易够多次＋钱包里真的有 ETH（假钱包每个都要押钱，成本高很多） */
    const fresh = new Set(RHC.freshNonce == null ? [] : holders.map(([a]) => a).filter((a) => N.get(a) >= 0 && N.get(a) <= RHC.freshNonce));
    // 买入数量一模一样（前两位有效数字相同；几个钱包以上算捆绑＝你的设定 rh.sameAmtN）
    const grp = new Map(); for (const x of buys) { const s = x.v.toString(); const k = s.length + ':' + s.slice(0, 2); if (!grp.has(k)) grp.set(k, new Set()); grp.get(k).add(x.who); }
    const same = new Set(); for (const g of grp.values()) if (RHC.sameAmtN != null && g.size >= RHC.sameAmtN) g.forEach((a) => same.add(a));
    const bundle = new Set([...early, ...fresh, ...same]); bundle.delete(pool);
    const bundlePct = RHC.bundleDef ? share(bundle) : null; /* 捆绑怎么算（rh.bundleDef）没开＝读不到，不当成 0% */
    // 后门：可升级合约、有 owner 又有 mint／pause／blacklist
    const code = lc(await rpc('eth_getCode', [c, 'latest']).catch(() => '0x'));
    const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']).catch(() => '0x0');
    const owner = lc('0x' + String((await call(c, '0x8da5cb5b')) || '').slice(-40));
    const hasOwner = isAddr(owner) && owner !== ZERO && owner !== DEAD;
    const back = []; if (!globalThis.NR || globalThis.NR.on('risk.codeScan')) { if (big(impl) > 0n) back.push('可升级合约（项目方能换掉程式）'); if (hasOwner) { if (code.includes('40c10f19')) back.push('项目方可以增发'); if (code.includes('8456cb59')) back.push('项目方可以暂停交易'); if (code.includes('f9f92be4') || code.includes('44337ea1')) back.push('项目方可以拉黑名单'); } } /* NR-1103：归「代码扫描」底线管（可以关） */
    const facts = { realBuyers, bundlePct, top10, devPct, early: [...early], bundle: [...bundle], pool, supply: supply.toString(), deployer };
    const why = [];
    if (R.black[lc(deployer)]) why.push('部署者在黑名单');
    if (back.length) why.push(back.join('、'));
    const o = trunc ? { age: opt.age, liq: opt.liq, real: null, bundle: null, top10: null, dev: null } : { age: opt.age, liq: opt.liq, real: realBuyers, bundle: bundlePct == null ? null : bundlePct * 100, top10: top10 * 100, dev: devPct * 100 }; facts.trunc = trunc; /* ZR-1103：转账记录没读完整 → 这几个数字算「读不到」（照 NR：读不到＝不买） */ const num = (k) => globalThis.NR?.num(k) ?? null, on = (k) => !!globalThis.NR?.on(k); /* NJ-1103：捆绑／前 10 大／部署者／真实买家改成你的条件之一（照你的组合方式） */
    if (!trunc && RHC.blackBundlePct != null && bundlePct != null && bundlePct > RHC.blackBundlePct && deployer) R.black[lc(deployer)] = { why: `捆绑超过 ${Math.round(RHC.blackBundlePct * 100)}%`, at: Date.now() };
    /* 她 11/2 按键：合约危险权限（能增发／能暂停交易／黑名单，而且开发者没放弃权限）不打；只买有官方 X／TG 的币 */
    if (RHC.noDanger === 1) { try { const code = String(await rpc('eth_getCode', [c, 'latest']) || '').toLowerCase(); if (code.length <= 2) throw new Error('empty'); const has = (sel) => code.includes('63' + sel); const own = await call(c, '0x8da5cb5b'); const owner = own && own.length >= 66 ? '0x' + own.slice(26, 66) : ''; const renounced = !owner || /^0x0{40}$/.test(owner) || owner === DEAD;
        const bad = []; if (has('40c10f19')) bad.push('能增发'); if (has('8456cb59')) bad.push('能暂停交易'); if (has('f9f92be4') || has('44337ea1') || has('1a895266')) bad.push('有黑名单'); if (bad.length && own == null) why.push(`合约有危险权限（${bad.join('、')}），读不到开发者有没有放弃 → 不买`); else if (bad.length && !renounced) why.push(`合约有危险权限（${bad.join('、')}），开发者还没放弃`); } catch { why.push('读不到合约码（你开了「不打有危险权限的合约」）→ 不买'); } } /* 读不到＝不买，不吞掉 */
    if (why.length) return { ok: false, why: why.join('；'), facts };
    if (!manual) { { const J = rhJ(o); if (J.buy === false) return { ok: false, why: J.text, facts, J }; }
      if (num('rh.mcMin') != null || num('rh.mcMax') != null) { o.mc = null; try { const ps = await (await fetch('https://api.dexscreener.com/tokens/v1/robinhood/' + c, { signal: AbortSignal.timeout(10000) })).json(); const mc = Math.max(0, ...(Array.isArray(ps) ? ps : []).map((p) => +(p.marketCap || p.fdv) || 0)); if (mc > 0) o.mc = mc; } catch {} } /* 市值读不到＝算「读不到」 */
      if (on('rh.needSmart')) o.smart = !!(S.smartW?.seen?.['robinhood' + c + '买'] && (num('rh.smartWinH') == null || Date.now() - S.smartW.seen['robinhood' + c + '买'] < num('rh.smartWinH') * 3600e3));
      if (on('rh.needCall')) o.call = !!(S.callHits?.[c]?.length);
      if (on('rh.needSocial')) { o.social = null; try { const ps = await (await fetch('https://api.dexscreener.com/tokens/v1/robinhood/' + c, { signal: AbortSignal.timeout(10000) })).json(); o.social = (Array.isArray(ps) ? ps : []).some((p) => (p.info?.socials || []).some((x) => /twitter|x\.com|telegram|t\.me/i.test((x.type || '') + ' ' + (x.url || '')))); } catch {} } /* 读不到＝算「读不到」 */
      { const J = rhJ(o); if (J.buy === false) return { ok: false, why: J.text, facts, J }; } }
    if (opt.noQuote) return { ok: true, why: '（回测）链上检查全部通过' + (manual ? '' : '：' + rhJ(o).text), facts };
    // 模拟买进马上卖：卖不掉＝可能是貔貅（自动不买；手动会警告，你按「我知道风险，仍然执行」才买）；亏多少是你的条件之一
    try { const W = WALLETS[0]; const px = await ethUsd(); if (!(px > 0)) return { ok: false, why: '读不到 ETH 价格', facts }; const eq = ((RHC.usd || 1) / px).toFixed(6); /* 只是模拟报价的大小 */
      const got = await quote(W, NATIVE, c, eq); if (!(got > 0)) return { ok: false, why: '买入报价失败', facts };
      const back2 = await quote(W, c, NATIVE, (got * 0.999).toPrecision(12)); const loss = 1 - back2 / Number(eq);
      facts.roundTrip = loss; if (!(back2 > 0)) return { ok: false, why: '模拟卖不掉（可能是貔貅）', facts }; o.rt = loss * 100;
    } catch (e) { return { ok: false, why: '模拟卖出失败（可能是貔貅）：' + e.message.slice(0, 60), facts }; }
    if (!manual) { const J = rhJ(o); return { ok: J.buy === true, why: J.text, facts, J }; }
    return { ok: true, why: '全部检查通过', facts };
  }

  async function ethBal(a) { for (let i = 0; i < 3; i++) { const h = await rpc('eth_getBalance', [a, 'latest']).catch(() => null); if (h && /^0x[0-9a-f]+$/i.test(h)) return Number(BigInt(h)) / 1e18; } return null; } /* 她 11/2 05:01：节点没回应不能当成 0（误报 ETH 不够） */
  /*AMT-FIX 加码／重买：已经卖光（closed）的当成新的一笔；还有部位的照「剩下的成本＋这次的钱」重算剩下比例 rem（之后分批卖的成本才对） */
  function wAdd(P, a, usd, q) { let w = P.w[a]; if (!w || w.closed) w = P.w[a] = { cost: 0, peak: 0, stage: 0, at: Date.now() }; const c0 = +w.cost || 0, r0 = Number.isFinite(+w.rem) ? Math.max(0, Math.min(1, +w.rem)) : 1, add = +usd || 0;
    { const ap0 = +w.ap > 0 ? +w.ap : 0, qP = ap0 > 0 ? c0 * r0 / ap0 : 0; /* 平均买入价 w.ap：只由花钱买的决定＝（手上买来的颗数×旧平均价＋这次的钱）÷（颗数＋这次买到的）；读不到这次买到几颗 → 下次持仓检查再照「剩下的成本÷余额」定 */
      if (add > 0 && q > 0 && (ap0 > 0 || !(c0 * r0 > 0))) w.ap = (qP * ap0 + add) / (qP + q); else if (add > 0) delete w.ap; }
    if (c0 > 0 && r0 < 1 && add > 0) w.rem = (c0 * r0 + add) / (c0 + add); w.cost = c0 + add; { const L = SELL_CTX.get(w)?.adds || (Array.isArray(w.sellPend?.adds) ? w.sellPend.adds : null); if (L && add > 0) L.push({ add, q: q > 0 ? q : null }); } /*RISK-FIX3 A／C：卖单还没结束时的加码 */ return w; }
  async function tokBal(c, a) { return big(await call(c, '0x70a08231' + wa(a))); }

  async function buy(c, sym, facts, manual, usdIn, opt = {}) { const USD = Number(usdIn) > 0 ? Number(usdIn) : manual ? null : RHC.usd; /* LR1-USD：手动买没金额就不买，不借用自动买的金额 */ if (!(USD > 0)) return '没填要买多少（自动买要在设定填「每笔」）'; const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', payG = !!opt.usdg; /* 她 11/2 19:27：Robinhood 可以直接用 USDG 付，不换成 ETH */
    if (!manual) { const cr = await globalThis.CODE_RISK?.('robinhood', c).catch(() => ''); if (cr) return cr + '，不自动买'; } /* 11/3 代码扫描（手动买只在画面提醒，不挡） */
    const px = await ethUsd(); if (!(px > 0)) return '读不到 ETH 价格';
    const res = [];
    const wq = lc(opt.w || ''); const WL = manual ? [wq ? WALLETS.find((x) => x.addr === wq) : WALLETS.find((x) => !x.off) || WALLETS[0]].filter(Boolean) : WALLETS; if (manual && wq && !WL.length) return '你选的钱包不在雷达里了，没买'; if (manual && WL[0]?.off) return `你选的钱包 ${WL[0].name} 登入过期，请先重新连接，没买`; /* H7-H4 */ /* 11/3：没指定钱包时用第一个有登入的 */ /* 手动／一键买只用你选的钱包（没选就第一个） */
    const sandPx = manual ? ((await dsInfo([c]).catch(() => new Map())).get(c)?.price || 0) : 0; /* 防夹提醒：买前市价 */
    for (const W of WL) {
      if (!manual && (RHC.dayUsd == null || spent(W.addr) + USD > RHC.dayUsd)) { res.push(`[${W.name}] 今天额度用完（或没填「每天最多」）`); continue; }
      const q = USD / px; const eb = await ethBal(W.addr); if (eb == null && !manual) { res.push(`[${W.name}] 读不到 ETH 余额，不打`); continue; } /* H7-H10：自动打读不到余额＝不打 */ if (payG) { const ug = Number(await tokBal(USDG, W.addr)) / 1e6; if (ug < USD) { res.push(`[${W.name}] USDG 不够（有 ${ug.toFixed(2)}，要 ${USD}）`); continue; } if (eb != null && RHC.minGasEth != null && eb < RHC.minGasEth) { res.push(`[${W.name}] ETH 只剩 ${eb.toFixed(5)}，付不起手续费（用 USDG 买也要一点 ETH）`); continue; } } else if (eb != null && eb < q + (RHC.keepEth || 0)) { res.push(`[${W.name}] Robinhood 上的 ETH 不够（有 ${eb.toFixed(5)}，要 ${(q + (RHC.keepEth || 0)).toFixed(5)}）`); continue; }
      const b0 = await tokBal(c, W.addr);
      const goRH = (sl) => W.baw(['market-order', 'swap', '--binanceChainId', '4663', '--fromTokenQty', payG ? USD.toFixed(2) : q.toFixed(6), '--fromToken', payG ? USDG : NATIVE, '--toToken', c, '--slippage', sl]); let sw = await goRH('auto'); if (!sw.j?.success && !(!sw.j && /timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(sw.t || ''))) { if (RHC.retrySlip != null) sw = await goRH(String(RHC.retrySlip)); } /* 11/3：逾时可能已成交，不再重买 */ /* 11/2 防夹：先用钱包自动滑点，买不进去才用你设的「重试滑点」（没填＝不重试） */
      log(`[Robinhood][${W.name}] 买 ${sym}：${sw.t.slice(0, 300)}`); touchW(W.addr); /*RISK-FIX3 G*/
      if (!sw.j && /timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(sw.t || '')) { if (!manual) addSpent(W.addr, USD); const mixP = R.pos[c] && !!R.pos[c].manual !== !!manual; const P = R.pos[c] || (R.pos[c] = { manual: !!manual, ...(manual && opt.tpsl ? { tpsl: opt.tpsl } : {}), dev: facts?.deployer ? lc(facts.deployer) : '', sym, at: Date.now(), w: {}, liq0: facts?.liq0 || 0, pool: facts?.pool, watch: facts?.bundle || [], supply: facts?.supply, lastB: 0, bundleSold: '0' }); if (mixP) res?.push?.(`⚠️ 这个币已经有${P.manual ? '手动' : '自动'}买的仓位，这次${manual ? '手动' : '自动'}买的部分会跟它合在一起，照「${P.manual ? (P.tpsl ? '你设的止盈止损' : '只通知、不自动卖') : '自动卖出规则'}」处理`); /* H7-H11：手动／自动买同一个币会合成一个仓位，先讲清楚 */ const w = wAdd(P, W.addr, USD); w.pending = 1; save(); res.push(`[${W.name}] ⚠️ 买入结果不明（送出逾时，可能已经成交），先不重复买；成本／额度先照 ${+USD.toFixed(2)}U 算，读到余额会自动接着追踪`); continue; } /* BUG5 */
      if (!sw.j?.success) { res.push(`[${W.name}] 买入失败：${String(sw.j?.error?.message || sw.t).slice(0, 80)}`); continue; }
      if (!manual) addSpent(W.addr, USD); /* 手动买不吃自动打的每日额度 */
      let b1 = b0; for (let i = 0; i < 20 && b1 <= b0; i++) { await sleep(3000); b1 = await tokBal(c, W.addr); }
      const mixP = R.pos[c] && !!R.pos[c].manual !== !!manual; const P = R.pos[c] || (R.pos[c] = { manual: !!manual, ...(manual && opt.tpsl ? { tpsl: opt.tpsl } : {}), dev: facts?.deployer ? lc(facts.deployer) : '', sym, at: Date.now(), w: {}, liq0: facts?.liq0 || 0, pool: facts?.pool, watch: facts?.bundle || [], supply: facts?.supply, lastB: 0, bundleSold: '0' }); if (mixP) res?.push?.(`⚠️ 这个币已经有${P.manual ? '手动' : '自动'}买的仓位，这次${manual ? '手动' : '自动'}买的部分会跟它合在一起，照「${P.manual ? (P.tpsl ? '你设的止盈止损' : '只通知、不自动卖') : '自动卖出规则'}」处理`); /* H7-H11：手动／自动买同一个币会合成一个仓位，先讲清楚 */
      if (manual && 'tpsl' in opt && P.manual) { if (opt.tpsl) P.tpsl = opt.tpsl; else if (opt.tpsl === null) delete P.tpsl; } /* 她 11/3：止盈止损 */
      const w = wAdd(P, W.addr, USD, await (async () => { try { if (!(b1 > b0)) return null; const dq = await decimals(c); return dq == null ? null : Number(b1 - b0) / 10 ** dq; } catch { return null; } })()); save(); /*AMT-4 这次买到几颗（算平均买入价）*/ if (w.sellPend && b1 > b0) w.sellPend.bal0 = (BigInt(w.sellPend.bal0) + (b1 - b0)).toString(); /*RISK-FIX3 D：逾时卖单还不明时加码 → 余额门槛加上这次买到的颗数 */
      let sw2 = ''; try { if (sandPx > 0 && b1 > b0) { const dd0 = await decimals(c); if (dd0 == null) throw 0; const got = Number(b1 - b0) / 10 ** dd0; const over = (USD / got / sandPx - 1) * 100; if (RHC.sandWarn != null && over >= RHC.sandWarn) { sw2 = `\n⚠️ 这笔成交价比市价贵约 ${over.toFixed(0)}%，可能被夹子夹了或池子太小滑点大。下次可以买少一点、分开买`; log(`[Robinhood][${W.name}] 防夹提醒 ${c} 贵 ${over.toFixed(1)}%`); } } } catch {}
      res.push(`[${W.name}] ✅ 已买 ${+USD.toFixed(2)}U` + sw2);
    }
    return res.join('\n');
  }

  async function sellPct(c, P, W, pct, why, man = false) { /*RISK-FIX 1／2：man＝你在雷达按的卖（另一个雷达在跑也照卖，跟 BNB Chain 一样）；卖单还在送 → 手动回 'busy'、自动回 false */
    if (!man) { const cf = conflOf(); if (cf) { if (P.conflLog !== cf) { P.conflLog = cf; log(`[Robinhood][${W.name}] ${P.sym} 想自动卖（${why}），但另一个雷达正在用同一个钱包（${cf}）→ 这次先不卖，避免两边重复卖；关掉其中一个就会恢复`); } return false; } }
    const sk = W.addr + '|' + c; if (RH_SELLING.has(sk)) return man ? 'busy' : false; RH_SELLING.add(sk); const wq = P.w?.[W.addr], tok = actOn(W.addr); try { const r0 = await sellPct0(c, P, W, pct, why, tok); return r0 === 'pendBusy' ? (man ? r0 : false) : r0; } finally { RH_SELLING.delete(sk); actOff(W.addr, tok); if (wq) SELL_CTX.delete(wq); } /*RISK-FIX3 A／B／G*/
  }
  async function sellPct0(c, P, W, pct, why, tok = {}) {
    const b = await tokBal(c, W.addr); { const w = P.w?.[W.addr]; if (w?.sellPend) { if (b < BigInt(w.sellPend.bal0)) await settlePend(c, P, W, w, b, w.sellPend); else return 'pendBusy'; } if (w && !w.closed) SELL_CTX.set(w, { cl: remCost(w), ap0: +w.ap > 0 ? +w.ap : 0, adds: [] }); } /*RISK-FIX3 B：上一笔逾时卖单已成交＝先结算；还不明＝这张不卖 */ if (b <= 0n) return false; const d = await decimals(c); if (d == null) { log(`[Robinhood][${W.name}] ${P.sym} 读不到小数位数，这次不卖`); return false; }
    const amt = (b * BigInt(Math.round(pct * 100))) / 10000n; if (amt <= 0n) return false; const qty = fmtU(amt, d);
    const e0 = await ethBal(W.addr).catch(() => null);
    const r = await W.baw(['market-order', 'swap', '--binanceChainId', '4663', '--fromTokenQty', qty, '--fromToken', c, '--toToken', NATIVE, '--slippage', RHC.sellSlip != null ? String(RHC.sellSlip) : 'auto']); /* NR-1103：卖出滑点＝你的设定（没开＝钱包自动滑点） */
    log(`[Robinhood][${W.name}] 卖 ${P.sym} ${pct}%（${why}）：${r.t.slice(0, 300)}`);
    if (!r.j && /timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(r.t || '')) { const w = P.w?.[W.addr]; if (w) { const X = SELL_CTX.get(w); w.sellPend = { at: Date.now(), bal0: b.toString(), bal0o: b.toString(), cl0: X ? X.cl : remCost(w), ap0: X ? X.ap0 : +w.ap > 0 ? +w.ap : 0, adds: X ? [...X.adds] : [], why, snap: { tpd: [...(w.tpd || [])], stage: w.stage || 0, si: w.si, closed: w.closed || 0, rem: w.rem, cost: +w.cost || 0 } }; } /*RISK-FIX3 C／D：记下送单当下的剩下成本、平均价、颗数 */ await tg(`⚠️ [Robinhood][${W.name}] ${P.sym} 卖出结果不明（送出逾时，可能已经成交）（${why}）\n先不重复卖：等读到余额变化再决定\n${c}`).catch(() => {}); return 'pend'; } /* BUG1 */
    const ok = !!r.j?.success; let usd = null, cp = null; if (ok) { const w = P.w?.[W.addr]; if (w) { const X = SELL_CTX.get(w), f = Math.max(0, Math.min(1, pct / 100)), cl = X ? X.cl : remCost(w), cpR = cl * f; cp = +cpR.toFixed(2); if (+w.cost > 0) w.rem = Math.min(1, Math.max(0, remCost(w) - cpR) / +w.cost); else w.rem = (Number.isFinite(+w.rem) ? +w.rem : 1) * (1 - f); if (X && X.adds.length) { const ap = reAp(X.ap0, X.ap0 > 0 ? cl * (1 - f) / X.ap0 : (cl * (1 - f) > 1e-12 ? NaN : 0), X.adds); if (ap) w.ap = ap; else delete w.ap; } } /*RISK-FIX3 A：卖掉的成本＝送单当下的剩下成本×比例；剩下成本＝现在的剩下成本（含送单期间加码）−卖掉的；平均价照卖剩颗数＋加码重算 */ try { await sleep(6000); const e1 = await ethBal(W.addr), px = await ethUsd(); if (e0 != null && e1 != null && px > 0 && !tok.ov) usd = +((e1 - e0) * px).toFixed(2); else if (tok.ov) log(`[Robinhood][${W.name}] ${P.sym} 卖出期间同一个钱包还有别的买卖，这笔拿回多少算不准 → 记「读不到」`); } catch {} } /*RISK-FIX3 G*/ /* Robinhood 卖出记下拿回多少钱，保险丝／连亏暂停才算得到 */ R.trades = R.trades || []; R.trades.push({ sym: P.sym, c, w: W.addr, pct, why, ok, at: Date.now(), usd, cp, manual: P.manual ? 1 : 0 }); if (R.trades.length > 2000) R.trades.splice(0, R.trades.length - 2000);
    const em = ok ? '' : String(r.j?.error?.message || r.t || '').slice(0, 200); W._lastErr = em; await tg(`💰 [Robinhood][${W.name}] ${P.sym} ${ok ? '已卖' : '想卖但失败'} ${pct}%（${why}）${ok ? '' : '\n原因：' + (globalThis.sellWhy ? globalThis.sellWhy(em) : em.slice(0, 100))}\n${c}`).catch(() => {}); return ok;
  }

  // ── 持仓监控（定时跑） ──
  let monBusy = false;
  async function monitor() {
    if (monBusy) return; monBusy = true; try {
      const cs = Object.keys(R.pos); if (!cs.length) return; const info = await dsInfo(cs); const head = parseInt(await rpc('eth_blockNumber', []), 16);
      for (const c of cs) { const P = R.pos[c]; const I = info.get(c); let dump = '';
        // 捆绑钱包开始卖 → 先跑
        if (RHC.devSellRun === 1 && RHC.devSellPct == null && !P.devNote) { P.devNote = 1; const t = '开了「开发者一卖就跑」但没填百分比 → 这条不会卖（填了才会生效）'; log(`[Robinhood] ${P.sym || c}：${t}`); try { globalThis.NR?.dec?.('rh', c, P.sym || c, { buy: false, text: t, lines: ['⚠️ ' + t] }); } catch {} } /* KQ-1104 */
        if ((P.watch?.length && P.pool) || (P.dev && RHC.devSellRun === 1)) { const fromB = P.lastB || head - 50; if (head > fromB) { try { const lg = await rpc('eth_getLogs', [{ fromBlock: '0x' + (fromB + 1).toString(16), toBlock: '0x' + head.toString(16), address: c, topics: [TRANSFER] }]); const ws = new Set(P.watch); let s = BigInt(P.bundleSold || '0'); for (const l of lg) { const f = lc('0x' + l.topics[1].slice(26)), t = lc('0x' + l.topics[2].slice(26)); if (ws.has(f) && t === P.pool) s += big(l.data); if (P.dev && f === P.dev && t !== P.dev) P.devOut = (BigInt(P.devOut || '0') + big(l.data)).toString(); } if (RHC.devSellRun === 1 && RHC.devSellPct != null && P.dev && P.supply && Number((BigInt(P.devOut || '0') * 10000n) / BigInt(P.supply)) / 10000 > RHC.devSellPct / 100) dump = `开发者开始卖币（转出超过总量 ${RHC.devSellPct}%）`; /* 她 11/2 按键：开发者一卖就跑 */ P.bundleSold = s.toString(); P.lastB = head; if (P.supply && Number((s * 10000n) / BigInt(P.supply)) / 10000 > RHC.bundleSellPct) dump = '捆绑钱包开始砸盘'; } catch {} } }
        if (I && P.liq0 > 0 && I.liq < P.liq0 * (1 - RHC.lpDrop)) dump = `池子流动性掉了 ${Math.round((1 - I.liq / P.liq0) * 100)}%（可能在抽池）`;
        if (I && !P.liq0) P.liq0 = I.liq;
        for (const W of WALLETS) { const w = P.w[W.addr]; if (!w || w.closed) continue; if (RH_SELLING.has(W.addr + '|' + c)) continue; /*RISK-FIX3 E：手动卖还在送，这轮不看这个钱包（成本还没扣、余额已经少了） */
          if (w.sellPend) { const sp = w.sellPend; const nb = await call(c, '0x70a08231' + wa(W.addr)); const pm = globalThis.NR?.num?.('sell.pendMin') ?? null; /* BUG1：卖出结果不明 → 余额变少才算卖掉；没变照你的 sell.pendMin 到期恢复；没设＝一直等 */ if (nb != null && big(nb) < BigInt(sp.bal0)) { await settlePend(c, P, W, w, big(nb), sp); if (w.sellPend) continue; } /*RISK-FIX3 C：剩下成本照卖掉的颗数扣、补记卖出、只结算一次 */ else if (pm != null && Date.now() - sp.at >= pm * 60e3) { const sn = sp.snap || {}; w.tpd = sn.tpd || []; w.stage = sn.stage || 0; w.si = sn.si; w.closed = sn.closed || 0; if (sn.rem != null && (sn.cost == null || +w.cost === +sn.cost)) w.rem = sn.rem; /*RISK-FIX3 D：中间有加码就不还原（加码的成本不会被盖掉） */ delete w.sellPend; log(`[Robinhood][${W.name}] ${P.sym} 逾时的卖单等了 ${pm} 分钟余额没变，算没卖掉，规则恢复`); } else continue; }
          if (w.pending) { const nb = await call(c, '0x70a08231' + wa(W.addr)); if (nb != null && big(nb) > 0n) { delete w.pending; await tg(`✅ [Robinhood][${W.name}] ${P.sym} 之前结果不明的买入／铸造：读到余额了，开始照规则追踪`).catch(() => {}); } else continue; } /* BUG5 */
          const dumpOff = (P.manual && !P.tpsl) || P.autoSell === false; if (dump && dumpOff) { if (!P.dumpWarned) { P.dumpWarned = 1; save(); await tg(`⚠️ [Robinhood] ${P.sym}：${dump}\n这是你手动／一键买的，雷达不会自动卖，要卖请自己按「卖」 | ${c}`); } } /* 她 11/2 22:15 选 B：手动／一键买的不自动卖，只提醒 */
          if (dump && !dumpOff && !I?.price) { if (await sellPct(c, P, W, 100, dump)) shut(w); continue; }
          if (!I?.price) { if (!P.manual) { P.noPxAt = P.noPxAt || Date.now(); const nm = globalThis.NR?.num?.('notify.noPxMin') ?? null; /* ZR-1103：读不到价格多久才提醒＝你的设定（没填＝第一次读不到就提醒，只提醒一次） */ if (!P.noPxWarn && globalThis.NR?.on?.('notify.noPx') && Date.now() - P.noPxAt >= (nm ?? 0) * 60e3) { P.noPxWarn = 1; /* BUG8：照你的「读不到价格提醒」开关 */ save(); await tg(`⚠️ [Robinhood] ${P.sym} 读不到价格（${nm != null ? '已经超过 ' + nm + ' 分钟，' : ''}行情来源断线）。这段时间雷达没办法帮你止盈止损，恢复后会通知你。很担心可以先自己卖。\n${c}`).catch(() => {}); } } continue; } if (P.noPxAt) { if (P.noPxWarn) await tg(`✅ [Robinhood] ${P.sym} 又读得到价格了，止盈止损恢复正常`).catch(() => {}); P.noPxAt = 0; P.noPxWarn = 0; save(); } /* 她 11/2 22:35：读不到行情要讲 */ const bR = await call(c, '0x70a08231' + wa(W.addr)); if (bR == null || bR === '0x' || String(bR).length < 66) continue; /* H7-H2／H4-H7：读不到余额＝这轮不动作（不当成 0） */ const b = big(bR); if (b <= 0n) { w.closed = 1; continue; } const d = await decimals(c); if (d == null) continue; /* H7-H2：读不到小数位数＝这轮不动作 */ const val = Number(fmtU(b, d)) * I.price; w.val = val; w.peak = Math.max(w.peak || 0, val); w.ppeak = Math.max(w.ppeak || 0, I.price); const x = (() => { const rm = Number.isFinite(+w.rem) ? Math.max(0, Math.min(1, +w.rem)) : 1, qn = Number(fmtU(b, d)); if (!(+w.ap > 0) && (w.cost || 0) * rm > 0 && qn > 0) w.ap = (w.cost * rm) / qn; /* 旧部位／读不到买到几颗：照「剩下的成本÷现在颗数」定一次平均买入价 */ return +w.ap > 0 ? I.price / w.ap : val / (((w.cost || 0) * rm) || 1); })(); w.mx = x; /*AMT-5 倍数＝现价÷平均买入价（跟 BNB Chain 同一口径；转进来没花钱的币不改平均价，卖出也不改）*/
          if (P.autoSell === false) continue; /* 她 11/3：单笔「自动卖」关掉 */
          const hit = []; if (dump && !dumpOff) hit.push('dump'); let tpL = null, stL = null; const crash = w.stage ? RHC.crashAfterBack : RHC.crash; /* NJ-1103：先列出这次触发了哪些卖出规则（全部是你开的），同时触发照你排的顺序 */
          if (P.manual) { const T = P.tpsl; if (!T && !hit.length) continue; if (T) { if (T.sl > 0 && x <= 1 - T.sl / 100) hit.push('sl'); if (T.trail > 0 && w.peak > (w.cost || 0) && I.price < w.ppeak * (1 - T.trail / 100)) hit.push('trail'); w.tpd = w.tpd || []; tpL = (T.tp || []).find(([up]) => !w.tpd.includes(up) && x >= 1 + up / 100) || null; if (tpL) hit.push('tp'); } }
          else { if (w.si == null) w.si = Math.max(0, (w.stage || 0) - 1); if (w.stage === 0 && x >= RHC.backX) hit.push('back'); stL = RHC.steps[w.si]; if (stL && x >= stL[0]) hit.push('steps'); else stL = null; if (w.ppeak > 0 && I.price < w.ppeak * (1 - crash)) hit.push('crash'); if (RHC.timeStopMin != null && RHC.timeStopX != null && w.stage === 0 && Date.now() - (P.at || Date.now()) > RHC.timeStopMin * 60e3 && x < RHC.timeStopX) hit.push('timeStop'); }
          const pick = globalThis.NR_PICKSELL ? globalThis.NR_PICKSELL(hit, 'rh.sellOrder', w, `[Robinhood] ${P.sym}`) : '';
          if (pick === 'dump') { if (await sellPct(c, P, W, 100, dump)) shut(w); }
          else if (pick === 'sl') { if (await sellPct(c, P, W, 100, `止损：跌了 ${P.tpsl.sl}% 以上`)) shut(w); }
          else if (pick === 'trail') { if (await sellPct(c, P, W, 100, `追踪止损：从最高点回落 ${P.tpsl.trail}%`)) shut(w); }
          else if (pick === 'tp') { const [up, pc] = tpL; if (await sellPct(c, P, W, pc, `止盈：涨 ${up}%，卖 ${pc}%`)) { w.tpd.push(up); if (pc >= 100) shut(w); } }
          else if (pick === 'back') { if (await sellPct(c, P, W, Math.min(100, Math.ceil((100 / x) * (1 + (globalThis.NR?.num?.('sell.backFeePct') ?? 0) / 100))), `${x.toFixed(1)} 倍，卖回本钱`)) w.stage = 1; /* ZR-1103：你的「卖回本多卖几 %」（没填＝不多卖） */ }
          else if (pick === 'steps') { if (await sellPct(c, P, W, stL[1], `${stL[0]} 倍分批卖`)) { w.si++; if (stL[1] >= 100) shut(w); } }
          else if (pick === 'crash') { if (await sellPct(c, P, W, 100, `从最高点回落 ${Math.round((1 - I.price / w.ppeak) * 100)}%`)) shut(w); }
          else if (pick === 'timeStop') { if (await sellPct(c, P, W, 100, `买进 ${RHC.timeStopMin} 分钟还没涨到 ${RHC.timeStopX} 倍，时间止损`)) shut(w); }
        }
        if (Object.values(P.w).every((w) => w.closed && !w.sellPend)) { R.done = R.done || {}; R.done[c] = { ...P, endAt: Date.now() }; delete R.pos[c]; }
      } save();
    } catch (e) { log('[Robinhood] 监控出错 ' + e.message); } finally { monBusy = false; }
  }

  // ── 扫描（定时跑） ──
  let scanBusy = false;
  async function scan() {
    if (scanBusy) return; scanBusy = true; try {
      const cs = await candidates(); let n = 0;
      for (const p of cs) { if (n >= SCAN_BUDGET) break; /* 一轮最多深查几个（读链的量）；查过的 R.seen 会跳过，下一轮轮到后面的，全部都会查到 */ if (R.pos[p.c]) continue; const o = R.seen[p.c]; if (o && (o.ok || (!o.retry && o.full)) && Date.now() - o.at < 10 * 60e3) continue; n++;
        const r = await analyze(p.c, p.pool, false, { age: p.ageMin, liq: p.liq }).catch((e) => ({ ok: false, why: '检查出错：' + e.message.slice(0, 60) }));
        R.seen[p.c] = { sym: p.sym, at: Date.now(), why: r.why, ok: r.ok, full: 1, liq: p.liq, real: r.facts?.realBuyers, bundle: r.facts?.bundlePct, top10: r.facts?.top10 }; save();
        if (RHC.auto === 1) globalThis.NR?.decLog?.('rh', p.c, p.sym, r.J || { buy: !!r.ok, text: (r.ok ? '' : '不买：') + (r.why || ''), lines: r.why ? [(r.ok ? '✅ ' : '⛔ ') + r.why] : [], why: r.ok ? '' : r.why || '' }, 1); else log(`[Robinhood] ${p.sym} ${p.c}：${r.why}`); /* 深查每一项不买的原因都写判断日志 */
        if (r.ok) { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'robinhood', type: 'token', c: p.c, sym: p.sym, liqUsd: p.liq, realBuyers: r.facts.realBuyers, bundlePct: r.facts.bundlePct == null ? null : r.facts.bundlePct * 100, top10Pct: r.facts.top10 * 100 }); if (cs) { R.seen[p.c].ok = false; R.seen[p.c].why = '自订规则不打：' + cs; if (RHC.auto === 1) globalThis.NR?.decLog?.('rh', p.c, p.sym, { buy: false, text: '不买：自订规则 ' + cs, lines: ['⛔ 自订规则：' + cs], why: '自订规则' }, 1); log(`[Robinhood] ${p.sym} 自订规则不打：${cs}`); continue; } }
        if (r.ok) { if (radarOff() || RHC.auto !== 1) { log(`[Robinhood] ${p.sym} 符合条件，但雷达设成暂停／不自动打`); continue; }
          if (Object.values(R.pos).filter((x) => !x.manual && !x.mint).length >= RHC.maxPos) { log(`[Robinhood] ${p.sym} 符合条件，但这个策略已经持有 ${RHC.maxPos} 个，先不打`); continue; } /* NR-1103：手动买、铸造的不算进去 */
          if (RHC.usd == null || RHC.dayUsd == null) { log(`[Robinhood] ${p.sym} 符合条件，但你没填「每笔」或「每天最多」，不打`); continue; }
          r.facts.liq0 = p.liq; const msg = await buy(p.c, p.sym, r.facts);
          await tg(`💰 [Robinhood] 自动打 ${p.sym}\n真实买家 ${r.facts.realBuyers ?? '没设看多久'}${RHC.realWinMin != null ? '（' + RHC.realWinMin + ' 分钟内）' : ''} 个｜捆绑 ${r.facts.bundlePct == null ? '读不到（没开捆绑定义）' : (r.facts.bundlePct * 100).toFixed(1) + '%'}｜前10大 ${(r.facts.top10 * 100).toFixed(0)}%｜模拟来回亏 ${(r.facts.roundTrip * 100).toFixed(0)}%\n${msg}\n${p.c}` + (globalThis.NR?.tgWhy?.(r.J) || '')).catch(() => {}); }
      }
      for (const [c, o] of Object.entries(R.seen)) if (Date.now() - o.at > 86400e3) delete R.seen[c];
      save();
    } catch (e) { log('[Robinhood] 扫描出错 ' + e.message); } finally { scanBusy = false; }
  }

  // ── Robinhood 铸造项目（11/2）：扫链上「从 0 地址转出」= 铸造。ZR-1103：只要有 1 笔铸造就列出来（不设官方门槛），全部轮流深查；要不要铸照你的条件 ──
  const INFRA = new Set([ /* 链上基础合约（包装币、流动性仓位凭证、金库份额）：它们的「铸出」是存款／加流动性，不是项目 */'0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x58daec3116aae6d93017baaea7749052e8a04fa7', '0x73991a25c818bf1f1128deaab1492d45638de0d3', '0xbeeff033f34c046626b8d0a041844c5d1a5409dd', '0x07f44c47743a2f36414a82b9f558ecfcf0eedcef']); 
  R.mint = R.mint || {}; R.mintDay = R.mintDay || {}; const MW = new Map();
  const RECEIPT_RE = /position|wrapped|vault|\blp\b|staked|receipt/i; /* 只用来贴标签（名字里有这些字），不会自己跳过 */
  const strOf = (h) => { try { const b = Buffer.from(String(h).slice(2), 'hex'); if (b.length >= 96) { const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + Math.min(n, 64)).toString('utf8'); } return b.toString('utf8').replace(/\0/g, ''); } catch { return ''; } };
  let mintBusy = false;
  async function scanMints() {
    if (mintBusy) return; mintBusy = true; try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16); let from = R.mintLastB ? R.mintLastB + 1 : head - 3000; if (head - from > 40000) from = head - 40000;
      for (let a = from; a <= head; a += 2500) { const b = Math.min(head, a + 2499); let logs = []; try { logs = await rpc('eth_getLogs', [{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, '0x' + '0'.repeat(64)] }]); } catch { continue; }
        const now = Date.now(); for (const l of logs) { const c = lc(l.address); if (INFRA.has(c)) continue; /* 范本交易只留最近几笔样本（找铸造方式用） */ const to = lc('0x' + l.topics[2].slice(26)); if (to === ZERO) continue;
          const M = R.mint[c] || (R.mint[c] = { first: now, nft: l.topics.length === 4, n: 0, m: {}, tx: [] }); M.n++; M.last = now; delete M.m[to]; M.m[to] = now; /* 记每个钱包最后一次铸造的时间（重新排到最后＝超过记忆上限时先丢最久没铸的） */ if (M.tx.length < 8 || Math.random() < 0.1) { M.tx.push(l.transactionHash); if (M.tx.length > 8) M.tx.shift(); } } }
      R.mintLastB = head;
      { const keepH = globalThis.NR?.num?.('track.maxAgeH') ?? null; /* ZR-1103：多久没人铸就从清单拿掉＝你的设定（没填＝一直留着） */ for (const [c, M] of Object.entries(R.mint)) { if (keepH != null && Date.now() - (M.last || M.first || Date.now()) > keepH * 3600e3) { delete R.mint[c]; continue; } const ks = Object.keys(M.m); if (ks.length > MINTER_MEM) { for (const k of ks.slice(0, ks.length - MINTER_MEM)) { M.mTruncAt = Math.max(M.mTruncAt || 0, M.m[k]); delete M.m[k]; } } } } /* 每个合约记得的铸造钱包有上限（记忆体）；超过就标记「至少」 */
      { let k = 0; for (const [c, M] of Object.entries(R.mint)) { if (M.name !== undefined) continue; if (++k > NAME_BUDGET) break; M.name = strOf(await call(c, '0x06fdde03')).slice(0, 40); M.sym = strOf(await call(c, '0x95d89b41')).slice(0, 16); } } /* 面板上先显示名字（每轮查一批，没查到的下一轮继续） */
      const win = RHC.mintWinMin; const cands = Object.entries(R.mint).map(([c, M]) => [c, M, Object.values(M.m).filter((t) => win == null || Date.now() - t < win * 60e3).length]).filter((x) => x[2] > 0).sort((a, b) => (a[1].chkAt || 0) - (b[1].chkAt || 0)); /* ZR-1103：有铸造就排进来；最久没查的先查（轮流），不再只挑最热的几个 */
      let nck = 0; for (const [c, M, recent] of cands) { M.recent = recent; if (M.chkAt && Date.now() - M.chkAt < RECHECK_MS) continue; if (++nck > MINT_CHECK_BUDGET) break; await checkMint(c, M, recent).catch((e) => log('[Robinhood 铸造] 检查出错 ' + e.message)); }
      save();
    } catch (e) { log('[Robinhood 铸造] 扫描出错 ' + e.message); } finally { mintBusy = false; }
  }
  async function checkMint(c, M, recent) {
    M.chkAt = Date.now();
    if (!M.name && M.name !== '') { M.name = strOf(await call(c, '0x06fdde03')).slice(0, 40); M.sym = strOf(await call(c, '0x95d89b41')).slice(0, 16); }
    { const m = (M.name + ' ' + M.sym).match(RECEIPT_RE); M.receipt = m ? m[0].toLowerCase() : ''; } /* ZR-1103：只当标签显示（事实：名字里有这个字），不会因此跳过或藏起来；要不要铸照你的条件 */
    const minters = Object.entries(M.m).filter(([, t]) => RHC.mintWinMin == null || Date.now() - t < RHC.mintWinMin * 60e3).map(([a]) => a); /* ZR-1103：时间内的铸造钱包全部都查 */
    const need = minters.filter((a) => !(MW.get(a)?.at > Date.now() - RECHECK_MS)); const res = await batch(need.flatMap((a) => [['eth_getTransactionCount', [a, 'latest']], ['eth_getBalance', [a, 'latest']]])); need.forEach((a, i) => { if (res[2 * i] != null && res[2 * i + 1] != null) MW.set(a, { n: parseInt(res[2 * i], 16), e: Number(big(res[2 * i + 1])) / 1e18, at: Date.now() }); }); if (MW.size > MW_MAX) MW.clear(); /* 钱包资料短暂快取，重查只问新钱包 */
    let real = 0, fresh = 0, miss = 0; minters.forEach((a) => { const w = MW.get(a); if (!w) { miss++; return; } if (!RHC.real || (w.n >= RHC.oldNonce && w.e >= RHC.minEth)) real++; if (RHC.mintFreshNonce != null && w.n <= RHC.mintFreshNonce) fresh++; });
    if (miss) { real = null; } /* 有钱包读不到 → 真人数算「读不到」（不会把读不到当成 0 或当成真人） */
    const cut = M.mTruncAt && (RHC.mintWinMin == null || Date.now() - RHC.mintWinMin * 60e3 <= M.mTruncAt); /* 你的时间范围里有钱包因为记忆上限被丢掉：真人数是「至少」（只会少算），新开钱包占比算「读不到」 */
    M.real = real; M.realAtLeast = !!cut; M.recent = recent; M.freshPct = minters.length && !miss && !cut ? fresh / minters.length * 100 : null; M.mCount = minters.length;
    // 铸造方式：找一笔「自己付钱铸给自己」的交易当范本
    M.tpl = null; for (const h of [...M.tx].reverse()) { const tx = await rpc('eth_getTransactionByHash', [h]).catch(() => null); if (!tx || !tx.to) continue; const from = lc(tx.from); if (!M.m[from]) continue; const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); const q = (rc?.logs || []).filter((l) => lc(l.address) === c && l.topics[0] === TRANSFER && l.topics[1] === '0x' + '0'.repeat(64) && lc('0x' + l.topics[2].slice(26)) === from).length || 1;
      M.tpl = { to: lc(tx.to), data: tx.input, value: BigInt(tx.value).toString(), from, q, viaOther: lc(tx.to) !== c }; break; }
    const px = await ethUsd(); M.priceUsd = M.tpl && px > 0 ? Number(BigInt(M.tpl.value)) / 1e18 * px / (M.tpl.q || 1) : null; M.costUsd = M.tpl && px > 0 ? Number(BigInt(M.tpl.value)) / 1e18 * px : null;
    const why = []; if (!M.tpl) why.push('找不到一般人自己铸造的交易（可能要白名单或签名）');
    { const MJ = globalThis.NR?.judge ? globalThis.NR.judge('rhmint', [{ k: 'rh.mintMinReal', name: RHC.mintWinMin != null ? `${RHC.mintWinMin} 分钟内真人钱包` : '真人钱包（没填「几分钟内」）', unit: ' 个', op: '>=', v: RHC.mintWinMin != null ? real : null, missWhy: RHC.mintWinMin != null ? undefined : '你没填「几分钟内」' }, /* 空白＝读不到 */ { k: 'rh.mintMaxFresh', name: '新开钱包占', unit: '%', op: '<=', v: M.freshPct }]) : null; M.J = MJ; if (!MJ || MJ.buy !== true) why.push(MJ ? MJ.text : '设定还没载入'); if (MJ && RHC.mintAuto === 1) globalThis.NR?.decLog?.('rhmint', c, M.name, MJ); } /* NJ-1103：照你的条件组合判断 */
    if (M.tpl && BigInt(M.tpl.value || '0') > 0n && !(px > 0)) why.push('读不到 ETH 价格，算不出要花多少，先不打'); /* 安全：价格读不到就不打，金额检查不会被跳过 */
    if (RHC.mintUsd == null) why.push('没填「一次铸造最多花」'); else if (M.costUsd != null && M.costUsd > RHC.mintUsd) why.push(`一次铸造要约 ${M.costUsd.toFixed(1)}U（超过设定 ${RHC.mintUsd}U）`);
    { const cr = await globalThis.CODE_RISK?.('robinhood', c).catch(() => ''); if (cr) why.push(cr); } /* NR-1103：Robinhood 铸造也跑代码扫描（底线） */
    const cs = globalThis.CUSTOM_SKIP?.({ chain: 'robinhood', type: 'mint', c, name: M.name, sym: M.sym, realBuyers: real }); if (cs) why.push('自订规则：' + cs);
    M.ok = !why.length; M.why = why.join('；') || '符合条件';
    if (M.ok && RHC.mintAuto === 1 && !radarOff() /* 「Robinhood 热门代币」和铸造是不同策略，各自开关 */ && !M.done) await doMint(c, M, false);
  }
  const MINT_BUSY = new Set(); /* BUG2 */
  async function doMint(c, M, manual, capU = 0, opt = {}) { const ack = manual && ACKD(opt); const warn = (W, m) => { /* 预演判断不安全：手动＝按了仍然执行才送；自动＝照你的「预演不过也送出」 */ if (ack) { log(`⚠️ [Robinhood 铸造][${W.name}] ${M.name || c}：${m} —— 你按了「我知道风险，仍然执行」，照送`); return false; } if (!manual && globalThis.NR?.on?.('auto.sendOnPreviewFail')) { log(`⚠️ [Robinhood 铸造][${W.name}] ${M.name || c}：${m} —— 你开了「预演不过也送出」，照送`); tg(`⚠️ [Robinhood][${W.name}] 预演判断不安全仍然送出（你开了「预演不过也送出」）：${m}\n${c}`).catch(() => {}); return false; } return (manual ? NEED_OK : '') + m + (manual ? '（按「我知道风险，仍然执行」才会送）' : '（自动：你没开「预演不过也送出」，只记录不送）'); };
    if (!M.tpl) return '没有可以照着做的铸造方式';
    const px = await ethUsd(); const out = []; M.done = M.done || {}; if (BigInt(M.tpl.value || '0') > 0n && !(px > 0) && !ack) return (manual ? NEED_OK : '') + '读不到 ETH 价格，算不出要花多少，没有铸造' + (manual ? '（按「我知道风险，仍然执行」会照送，金额上限就检查不到）' : '（等一下再试）');
    const onlyW = opt.w ? lc(opt.w) : ''; /* BUG7：你选的钱包；登出的钱包一律不用 */
    for (const W of WALLETS) { if (W.off || (onlyW && W.addr !== onlyW)) continue; if (M.done[W.addr]) continue; const bk = c + '|' + W.addr; if (MINT_BUSY.has(bk)) { out.push(`[${W.name}] 这个钱包正在铸造这个项目，等它做完`); continue; } MINT_BUSY.add(bk); try { /* BUG2：同一个项目＋钱包同时只铸一次 */
      const dd = day(); const sp = (R.mintDay[dd] || {})[W.addr] || 0; if (!manual && (RHC.mintDayUsd == null || sp + (M.costUsd || 0) > RHC.mintDayUsd)) { out.push(`[${W.name}] 今天铸造额度用完（或没填「每天铸造最多」）`); continue; }
      const data = String(M.tpl.data).toLowerCase().split(M.tpl.from.slice(2)).join(W.addr.slice(2)); // 范本里如果写了对方的地址，换成我们自己的
      const val = BigInt(M.tpl.value); { const eb2 = await ethBal(W.addr); if (eb2 == null && !manual) { out.push(`[${W.name}] 读不到 ETH 余额，不打`); continue; } if (eb2 != null && eb2 < Number(val) / 1e18 + (RHC.keepEth || 0)) { out.push(`[${W.name}] Robinhood 上的 ETH 不够`); continue; } } /* H7-H10 */
      const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '4663', '--from', W.addr, '--to', M.tpl.to, '--value', val.toString(), '--inputData', data]);
      const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId; if (!p.j?.success || !rid) { out.push(`[${W.name}] 预演失败：${String(p.j?.error?.message || p.t).slice(0, 80)}（币安钱包预演没成功就拿不到送出编号，这笔送不出去）`); continue; }
      const got = (sim?.balanceChanges || []).some((b) => lc(b.owner) === W.addr && lc(b.contractAddress) === c && Number(b.change) > 0) || (sim?.nftChanges || sim?.erc721Changes || []).length > 0;
      const ethOut = (sim?.balanceChanges || []).filter((b) => lc(b.owner) === W.addr && lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0);
      { const bad = []; if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) bad.push('⛔ 预演发现会授权或交出钱包权限（防盗）'); if ((sim?.balanceChanges || []).some((b) => lc(b.owner) === W.addr && !lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0)) bad.push('⛔ 预演显示会扣你别的币'); if (!got) bad.push('预演看不到我们会拿到东西'); if (bad.length) { const w = warn(W, bad.join('；')); if (w) { out.push(`[${W.name}] ${w}`); continue; } } } /* 11/2 BDOG 被盗事件的教训：一定先告诉你；要不要送由你决定 */
      if ((sim?.balanceChanges || []).some((b) => lc(b.owner) === W.addr && !lc(b.contractAddress).startsWith('0xeeee') && Number(b.change) < 0)) { out.push(`[${W.name}] ⛔ 预演显示会扣你别的币，不铸`); continue; }
      if (!manual && !got) { out.push(`[${W.name}] 预演看不到我们会拿到东西，不铸`); continue; }
      const capX = capU > 0 ? capU /* LR2-CAP：你当场填的上限一定照 */ : !RHC.costTol ? Infinity : RHC.mintUsd != null ? RHC.mintUsd * (1 + (RHC.costTolPct || 0) / 100) + (RHC.costTolUsd || 0) : null; /* NR-1103：容差＝你的底线设定 */ if (capX == null) { out.push(`[${W.name}] 没填这次最多花多少（设定里也没填「一次铸造最多花」），不铸`); continue; }
      if (ethOut > 0 && !(px > 0) && !ack || px > 0 && ethOut * px > capX) /* 11/3：上限只看你设的金额，不再用项目方范本的价格往上加 */ { out.push(`[${W.name}] 预演要花 ${(ethOut * px).toFixed(1)}U，超过${capU > 0 ? '你这次填的 ' + capU + 'U' : '预期'}，不铸`); continue; }
      const x = await W.baw(['contract-call', 'execute', '--requestId', rid]); touchW(W.addr); /*RISK-FIX3 G*/ log(`[Robinhood 铸造][${W.name}] ${M.name || c}：${String(x.t).slice(0, 200)}`);
      if (!x.j && /timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(x.t || '')) { M.done[W.addr] = 'unknown'; const cu0 = px > 0 ? Math.max(Number(val) / 1e18, ethOut) * px : 0; R.mintDay = { [dd]: { ...(R.mintDay[dd] || {}), [W.addr]: sp + cu0 } }; if (!M.nft) { const P = R.pos[c] || (R.pos[c] = { mint: 1, sym: M.sym || M.name, at: Date.now(), w: {}, liq0: 0, watch: [], lastB: 0, bundleSold: '0' }); const w = wAdd(P, W.addr, cu0); w.pending = 1; } out.push(`[${W.name}] ⚠️ 结果不明（逾时），可能已上链，先不重打（额度先照可能花掉的算；之后读到余额会自动接着追踪）`); continue; } /* BUG2/BUG5 */
      if (!x.j?.success) { out.push(`[${W.name}] 送出失败：${String(x.j?.error?.message || x.t).slice(0, 80)}`); continue; }
      M.done[W.addr] = Date.now(); const cu = px > 0 ? Number(val) / 1e18 * px : 0; R.mintDay = { [dd]: { ...(R.mintDay[dd] || {}), [W.addr]: sp + cu } };
      if (!M.nft) { const P = R.pos[c] || (R.pos[c] = { mint: 1, sym: M.sym || M.name, at: Date.now(), w: {}, liq0: 0, watch: [], lastB: 0, bundleSold: '0' }); const w = wAdd(P, W.addr, cu); } // 代币型：开盘后照卖出规则管
      (R.mintLog = R.mintLog || []).push({ c, sym: M.sym || M.name, w: W.addr, usd: +cu.toFixed(2), nft: M.nft, at: Date.now() }); out.push(`[${W.name}] ✅ 已铸造${cu ? `（约 ${cu.toFixed(2)}U）` : ''}`);
    } finally { MINT_BUSY.delete(bk); } }
    save(); const msg = out.join('\n'); await tg(`💰 [Robinhood] ${manual ? '手动' : '自动'}铸造 ${M.name || ''}（${M.sym || ''}）\n真人钱包 ${M.real ?? '读不到'} 个｜新开钱包 ${M.freshPct != null ? M.freshPct.toFixed(0) + '%' : '读不到'}\n${msg}\n${c}${M.nft ? '\n（这是 NFT，雷达不会自动卖，要卖请自己到市场挂单）' : ''}`).catch(() => {}); return msg;
  }
  async function previewMint(c) { c = lc(c); const M = R.mint[c]; if (!M) return { err: '没看到' }; if (!M.tpl) await checkMint(c, M, 0).catch(() => {}); if (!M.tpl) return { err: '没范本', why: M.why }; const W = WALLETS[0]; const data = String(M.tpl.data).toLowerCase().split(M.tpl.from.slice(2)).join(W.addr.slice(2));
    const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '4663', '--from', W.addr, '--to', M.tpl.to, '--value', String(M.tpl.value), '--inputData', data]); return { tpl: M.tpl, raw: String(p.t).slice(0, 4000) }; } /* 只预演、不送出（测试用） */
  async function manualMint(c, capU, opt = {}) { c = lc(c); const M = R.mint[c]; if (!M) return '雷达还没看到这个铸造项目'; if (!M.tpl) await checkMint(c, M, 0).catch(() => {}); return await doMint(c, M, true, Number(capU) || 0, opt); }
  const t3 = setInterval(() => { scanMints(); }, 60e3); t3.unref?.(); setTimeout(scanMints, 25e3);
  if (ctx.noLoop) return { analyze, RHC };
  function apply(set) { /* NR-1103：全部照你的设定；没开／没填就不套用 */ const NR = globalThis.NR; const num = (k) => (NR ? NR.num(k) : null), on = (k) => (NR ? NR.on(k) : false); const lo = (k, d = 1) => { const x = num(k); return x == null ? 0 : x / d; }, hi = (k, d = 1) => { const x = num(k); return x == null ? Infinity : x / d; };
    Object.assign(RHC, { usd: num('rh.usd'), dayUsd: num('rh.dayUsd'), maxPos: hi('rh.maxPos'), maxAgeMin: hi('rh.maxAgeMin'), minLiqUsd: lo('rh.minLiqUsd'), minRealBuyers: lo('rh.minRealBuyers'), realWinMin: num('rh.minRealBuyersWinMin'), real: on('rh.real') ? 1 : 0, oldNonce: lo('rh.oldNonce'), minEth: lo('rh.minEth'), earlySec: num('rh.earlySec'), freshNonce: num('rh.freshNonce'), sameAmtN: num('rh.sameAmtN'),
      maxBundle: hi('rh.maxBundle', 100), maxTop10: hi('rh.maxTop10', 100), maxDev: hi('rh.maxDev', 100), maxRoundTrip: hi('rh.maxRoundTrip', 100), lpDrop: hi('rh.lpDrop', 100), bundleSellPct: hi('rh.bundleSellPct', 100), backX: hi('rh.backX'), steps: NR ? NR.steps('rh.steps') : [], crash: hi('rh.crash', 100), crashAfterBack: hi('rh.crashAfterBack', 100),
      auto: Number(set?.['rh.auto']) === 1 ? 1 : 0, mintAuto: Number(set?.['rh.mintAuto']) === 1 ? 1 : 0, mintUsd: num('rh.mintUsd'), mintDayUsd: num('rh.mintDayUsd'), mintMinReal: lo('rh.mintMinReal'), mintWinMin: num('rh.mintWinMin'), mintMaxFresh: hi('rh.mintMaxFresh'), mintFreshNonce: num('rh.mintFreshNonce'),
      bundleDef: on('rh.bundleDef') ? 1 : 0, noDanger: on('rh.noDanger') ? 1 : 0, antiWash: on('rh.antiWash') ? 1 : 0, washBuys: num('rh.washBuys'), washSells: num('rh.washSells'), needBuyGtSell: on('rh.needBuyGtSell') ? 1 : 0, blackBundlePct: on('rh.blackBundle') && num('rh.blackBundlePct') != null ? num('rh.blackBundlePct') / 100 : null,
      needSocial: on('rh.needSocial') ? 1 : 0, needCall: on('rh.needCall') ? 1 : 0, needSmart: on('rh.needSmart') ? 1 : 0, smartWinH: num('rh.smartWinH'), mcMin: lo('rh.mcMin'), mcMax: lo('rh.mcMax'), timeStopMin: num('rh.timeStopMin'), timeStopX: num('rh.timeStopX'),
      devSellRun: on('rh.devSellRun') ? 1 : 0, devSellPct: num('rh.devSellPct'), sellSlip: num('rh.sellSlip'), keepEth: on('rh.keepEth.on') ? num('rh.keepEth') ?? 0 : 0, minGasEth: on('rh.keepEth.on') ? num('rh.minGasEth') : null,
      retrySlip: num('buy.retrySlip'), sandWarn: num('buy.sandWarnPct'), costTol: on('mint.costTol') ? 1 : 0, costTolPct: num('mint.costTolPct'), costTolUsd: num('mint.costTolUsd'), firstOnly: on('risk.firstOnly') ? 1 : 0 }); }
  const t1 = setInterval(() => { scan(); }, 90e3); const t2 = setInterval(() => { monitor(); }, 15e3); t1.unref?.(); t2.unref?.(); setTimeout(scan, 15e3);
  log('[Robinhood] 自动打启动');
  async function manualBuy(c, usd, opt = {}) { c = lc(c); const r = await analyze(c, null, true).catch((e) => ({ ok: false, why: e.message })); if (!r.ok) { if (!ACKD(opt) || !r.facts) return r.facts ? NEED_OK + r.why + '（按「我知道风险，仍然执行」才会买）' : '❌ 读不到这个币的资料：' + r.why; log(`⚠️ [Robinhood] 手动买 ${c}：${r.why} —— 你按了「我知道风险，仍然执行」，照买`); } const I = (await dsInfo([c])).get(c); r.facts.liq0 = I?.liq || 0; return await buy(c, I?.sym || c.slice(0, 8), r.facts, true, usd, opt); }
  async function manualSell(c, pct, only = '') { c = lc(c); pct = Number(pct); if (!(pct > 0)) return '没填要卖几 %，没有卖'; pct = Math.min(100, pct); /* ZR-1103：没填比例不会自己当成全卖 */ const P = R.pos[c]; if (!P) return '没有这个 Robinhood 持仓'; const out = []; for (const W of WALLETS) { if (only && lc(only) !== W.addr) continue; const w = P.w[W.addr]; if (!w || w.closed) continue; const ok = await sellPct(c, P, W, pct, `你在雷达按了卖 ${pct}%`, true); /*RISK-FIX 2*/ if (ok === true && pct >= 100) shut(w); out.push(`[${W.name}] ${ok === 'pendBusy' ? '⏳ 上一笔卖单结果还不明（逾时），等确认成交后再卖（不会把成本算两次）' : ok === 'busy' ? '⏳ 上一笔卖单还在送（等成交），这张先不卖，等一下再下' : ok === 'pend' ? '⚠️ 结果不明（逾时，可能已成交），先不重复卖' : ok ? '✅ 已卖' : '❌ 没卖成：' + (globalThis.sellWhy ? globalThis.sellWhy(W._lastErr) : (W._lastErr || '没有拿到原因'))}`); } if (Object.values(P.w).every((w) => w.closed && !w.sellPend)) { R.done = R.done || {}; R.done[c] = { ...P, endAt: Date.now() }; delete R.pos[c]; } save(); return out.join('\n') || '没有可卖的'; }
  function setTpsl(c, T, autoSell) { c = lc(c); const P = R.pos[c]; if (!P) return 0; if (T !== undefined) { if (T) P.tpsl = T; else delete P.tpsl; } if (autoSell === false) P.autoSell = false; else if (autoSell === true) delete P.autoSell; save(); return 1; }
  return { manualBuy, manualSell, manualMint, previewMint, analyze, RHC, apply, ethBal, ethUsd, setTpsl, rpc /* SEN-1103：安全哨兵只读查询用 */ };
}
