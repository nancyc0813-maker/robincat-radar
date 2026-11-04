// BSC 代币深度检查（11/2 她：「当然要补」）：捆绑比例、前 10 大持有、真实买家
// 跟 Robinhood 同一套算法，但 BSC 的公开节点一次只能查一小段区块，所以：
//   1) 只看最近一段（WINDOW_H 小时）的转帐记录：公开节点一次只能查一小段区块；记录太多没读完 → 整个当「读不到」（不会拿不完整的数字去判断）
//   2) 持有量用 balanceOf 直接问链上（不是用转帐记录推算），比较准
// 只读链上资料，不会送任何交易。
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
const lc = (x) => String(x || '').toLowerCase();
const big = (h) => { try { return h && h !== '0x' ? BigInt(h) : 0n; } catch { return 0n; } };
const wa = (a) => lc(a).replace(/^0x/, '').padStart(64, '0');

export function makeBscAnalyze({ rpc, rpcBatch, log = () => {} }) {
  const BPS = 2.2; // 链的出块速度：BSC 每秒约几个区块
  const WINDOW_H = 6, MAX_LOGS = 8000, TIME_BUDGET_MS = 12e3, SEG = 2000, PAR = 6; /* 读资料的量（不是买卖门槛）：往回读几小时、最多几笔、最多几秒、一次几个区块、同时几段；没读完 → 读不到 */
  const CACHE = new Map();
  /* 11/2 反向抓错：工具的 rpc() 会轮流试好几个节点，有的节点不支援查记录 → 一次检查拖很久。查记录改成直接问支援的节点、没回就换下一个 */
  const LOG_NODES = ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com'];
  async function getLogs(params) { let last; for (const u of LOG_NODES) { try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params }), signal: AbortSignal.timeout(6000) })).json(); if (j.error) { last = new Error(j.error.message); if (/limit|range|too many|exceed/i.test(j.error.message)) throw last; continue; } return j.result; } catch (e) { last = e; if (/limit|range|too many|exceed/i.test(e.message)) throw e; } } return await rpc('eth_getLogs', params).catch(() => { throw last; }); }
  async function seg(c, a, b, topics, depth = 0) { /* 一段查不了（结果太多）就切半再查 */
    try { return (await getLogs([{ fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), address: c, topics }])) || []; }
    catch (e) { if (depth > 2 || b - a < 200) throw e; const m = Math.floor((a + b) / 2); return [...await seg(c, a, m, topics, depth + 1), ...await seg(c, m + 1, b, topics, depth + 1)]; } }
  async function logsOf(c, from, to, topics = [TRANSFER], maxLogs = MAX_LOGS) { /* 几段同时查 */
    const parts = []; for (let b = to; b >= from; b -= SEG) parts.push([Math.max(from, b - SEG + 1), b]); /* 从最新往回查 */
    const out = new Array(parts.length); let k = 0, total = 0, bad = false; const t0 = Date.now();
    await Promise.all(Array.from({ length: PAR }, async () => { while (k < parts.length && total < maxLogs && Date.now() - t0 < TIME_BUDGET_MS) { const n = k++; out[n] = await seg(c, parts[n][0], parts[n][1], topics).catch(() => { bad = true; return []; }); total += out[n].length; } }));
    const L = out.filter(Boolean).reverse().flat(); L.partial = bad || k < parts.length; return L; /* ZR-1103：没读完（太多笔、太久、某段查不到）→ 标 partial，交给呼叫的地方当「读不到」 */
  }
  async function analyze(c, poolHint, opt = {}) {
    /* NR-1103（11/3 Nancy）：「真人买家」「捆绑钱包」怎么算＝你的设定（bsc.real／bsc.bundleDef）；没开就不过滤／不算，程式里不留数字 */ const NR = globalThis.NR; const D = { real: NR ? NR.on('bsc.real') : false, rn: NR?.num('bsc.realNonce') ?? 0, rb: NR?.num('bsc.realMinBnb') ?? 0, eb: NR?.num('bsc.earlyBlocks') ?? null, fn: NR?.num('bsc.freshNonce') ?? null, sn: NR?.num('bsc.sameAmtN') ?? null };
    c = lc(c); const ck = CACHE.get(c + JSON.stringify(D)); if (ck && Date.now() - ck.at < (opt.maxAgeMs ?? 120e3)) return ck.v;
    const head = parseInt(await rpc('eth_blockNumber', []), 16); const from = head - Math.ceil(BPS * 3600 * WINDOW_H);
    const raw = await logsOf(c, from, head);
    if (raw.partial) return { ok: false, why: '转帐记录太多或节点没回应，没读完整（读不到）' };
    if (!raw.length) return { ok: false, why: `最近 ${WINDOW_H} 小时没有转帐记录（读不到）` };
    const tf = raw.filter((l) => l.topics?.length >= 3).map((l) => ({ from: lc('0x' + l.topics[1].slice(26)), to: lc('0x' + l.topics[2].slice(26)), v: big(l.data), b: parseInt(l.blockNumber, 16), tx: l.transactionHash }));
    const supply = big(await rpc('eth_call', [{ to: c, data: '0x18160ddd' }, 'latest']).catch(() => '0x'));
    if (supply <= 0n) return { ok: false, why: '读不到总量' };
    // 池子 = 出现在最多笔交易里的转出方
    const cnt = new Map(); for (const t of tf) if (t.from !== ZERO) cnt.set(t.from, (cnt.get(t.from) || new Set()).add(t.tx));
    let pool = /^0x[0-9a-f]{40}$/.test(lc(poolHint)) ? lc(poolHint) : null; if (!pool || !cnt.has(pool)) pool = [...cnt.entries()].sort((a, b) => b[1].size - a[1].size)[0]?.[0];
    const byTx = new Map(); for (const t of tf) { if (!byTx.has(t.tx)) byTx.set(t.tx, []); byTx.get(t.tx).push(t); }
    const buys = [];
    for (const arr of byTx.values()) { const net = new Map(); for (const t of arr) { net.set(t.from, (net.get(t.from) || 0n) - t.v); net.set(t.to, (net.get(t.to) || 0n) + t.v); }
      if ((net.get(pool) || 0n) < 0n) { const [who, v] = [...net.entries()].filter(([a, x]) => a !== pool && a !== ZERO && a !== c && x > 0n).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0] || []; if (who) buys.push({ who, v, b: arr[0].b }); } }
    // 真实持有量：直接问链上
    const recv = new Map(); for (const t of tf) if (t.to !== ZERO && t.to !== DEAD) recv.set(t.to, (recv.get(t.to) || 0n) + t.v);
    const cand = [...recv.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).map(([a]) => a); /* ZR-1103：收过币的钱包全部都查余额 */
    const bals = await rpcBatch(cand.map((a) => ({ method: 'eth_call', params: [{ to: c, data: '0x70a08231' + wa(a) }, 'latest'] })));
    const bal = new Map(cand.map((a, i) => [a, big(bals[i])]));
    const skipA = new Set([pool, ZERO, DEAD, c]);
    const holders = [...bal.entries()].filter(([a, v]) => v > 0n && !skipA.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
    const pct = (v) => Number((v * 10000n) / supply) / 10000;
    const top10 = pct(holders.slice(0, 10).reduce((s, [, v]) => s + v, 0n));
    const share = (set) => pct([...set].reduce((s, a) => s + (bal.get(a) > 0n ? bal.get(a) : 0n), 0n));
    // 开盘那几个区块一起买的（只有池子是这段时间内开的才算得出来）
    let early = new Set(); let poolNew = false;
    if (pool && buys.length) { const firstB = Math.min(...buys.map((x) => x.b)); const pc = await rpc('eth_getCode', [pool, '0x' + Math.max(0, from).toString(16)]).catch(() => '0x1'); poolNew = !pc || pc === '0x'; if (poolNew && D.eb != null) early = new Set(buys.filter((x) => x.b <= firstB + D.eb).map((x) => x.who)); }
    // 钱包新旧
    const hourAgo = head - Math.ceil(BPS * 3600);
    const recentBuyers = [...new Set(buys.filter((x) => x.b >= hourAgo).map((x) => x.who))]; /* ZR-1103：全部都算 */
    const chk = [...new Set([...(D.real ? recentBuyers : []), ...(D.fn != null ? holders.map(([a]) => a) : [])])]; /* 只在你开了「真人／新开钱包」定义时才查 */
    const nn = await rpcBatch(chk.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] })));
    const N = new Map(chk.map((a, i) => [a, nn[i] == null ? -1 : parseInt(nn[i], 16)]));
    const bb = !D.real ? [] : await rpcBatch(recentBuyers.map((a) => ({ method: 'eth_getBalance', params: [a, 'latest'] })));
    const EB = new Map(recentBuyers.map((a, i) => [a, bb[i] == null ? -1 : Number(big(bb[i])) / 1e18]));
    const realBuyers = D.real ? recentBuyers.filter((a) => N.get(a) >= D.rn && EB.get(a) >= D.rb).length : recentBuyers.length; /* 真人 = 交易够多次＋钱包里真的有 BNB（数字是你的设定） */
    const fresh = new Set(D.fn == null ? [] : holders.map(([a]) => a).filter((a) => N.get(a) >= 0 && N.get(a) <= D.fn));
    const grp = new Map(); for (const x of buys) { const s = x.v.toString(); const k = s.length + ':' + s.slice(0, 2); if (!grp.has(k)) grp.set(k, new Set()); grp.get(k).add(x.who); }
    const same = new Set(); for (const g of grp.values()) if (D.sn != null && g.size >= D.sn) g.forEach((a) => same.add(a));
    const bundle = new Set([...early, ...fresh, ...same]); bundle.delete(pool);
    const v = { ok: true, facts: { bundlePct: NR?.on?.('bsc.bundleDef') ? share(bundle) : null /* 捆绑怎么算没开＝读不到（不当成 0%） */, top10, realBuyers, buyers1h: recentBuyers.length, fresh: fresh.size, sameAmt: same.size, early: early.size, poolNew, pool, holdersSeen: holders.length } };
    CACHE.set(c + JSON.stringify(D), { at: Date.now(), v }); if (CACHE.size > 300) CACHE.delete(CACHE.keys().next().value);
    return v;
  }
  // 铸造进度走势（她 11/2 03:24「线图都没波动」）：直接用链上的铸造记录（从 0 地址转出）还原最近一段时间的累计铸造（只是画图）
  const MT = new Map(); const CHART_STEP_MS = 10 * 60e3; /* 走势图每格的时间（画图用） */
  async function mintTimeline(c, nowProg) {
    { const k = MT.get(lc(c)); if (k && Date.now() - k.at < 90e3) return k.v; }
    c = lc(c); let tok = c; try { const r = await rpc('eth_call', [{ to: c, data: '0xfc0c546a' }, 'latest']); if (r && r.length >= 66 && big(r.slice(0, 66)) > 0n) tok = '0x' + r.slice(26, 66); } catch {}
    const head = parseInt(await rpc('eth_blockNumber', []), 16); const from = head - Math.ceil(BPS * 3600 * WINDOW_H); const now = Date.now();
    const raw = await logsOf(tok, from, head, [TRANSFER, '0x' + '0'.repeat(64)]);
    const ev = raw.map((l) => ({ b: parseInt(l.blockNumber, 16), to: lc('0x' + String(l.topics?.[2] || '').slice(26)), v: 1n })); /* 算「铸造次数」（不管 NFT 还是代币都一样好懂） */
    if (!ev.length) return { pts: [], n: 0 };
    const tOf = (b) => now - ((head - b) / BPS) * 1000; const BK = CHART_STEP_MS; const t0 = tOf(from);
    let i = 0;
    let cum2 = 0n; i = 0; const out = []; const seen2 = new Set();
    for (let t = t0 + BK; t <= now + BK; t += BK) { while (i < ev.length && tOf(ev[i].b) <= t) { cum2 += ev[i].v; seen2.add(ev[i].to); i++; } out.push({ t: Math.min(t, now), n: Number(cum2), w: seen2.size }); }
    const v = { pts: out, n: ev.length, tok, nft: raw.some((l) => l.topics?.length >= 4) }; MT.set(c, { at: Date.now(), v }); if (MT.size > 200) MT.delete(MT.keys().next().value); return v;
  }
  return { analyze, mintTimeline };
}
