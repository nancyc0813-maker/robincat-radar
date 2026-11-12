// SCOUT-1112 罗宾猫雷达 · 转接站统一扫「新发射台」（Nancy：不要开关、自动加进看板）
// 只读：向公开节点读「从 0 地址铸造」的事件（JSON-RPC 只用 eth_chainId／eth_blockNumber／eth_getLogs／eth_getCode），全世界只有转接站一个在扫，所有雷达共用结果。
// 找法：同一个「合约」在一段时间内收到好几个不同新币的第一笔铸造 → 这个合约很可能是发射台。
// 看盘本来就有（AVE 清单里已经有）的币＝已知发射台，跳过；剩下的发射台，它发的新币向 AVE 问一次资料，放进看盘「新币」栏（清单名 scout_<合约前 8 码>_in_new）。
// 不连钱包、不签名、不送交易、不会买。名字：照 worker.js 的 PAD_NAMES；没有就写「未命名 0x…」。
const SC = {
  span: 40,          /* 技术用：一次 eth_getLogs 查几块（公开节点有上限；被拒自动减半） */
  spanMin: 2,        /* 技术用：减半最少到几块 */
  maxLag: 400,       /* 技术用：落后超过几块就跳到最新（看的是一段时间内的多个新币，漏一小段不影响） */
  perRun: 4,         /* 技术用：每次最多查几段 */
  winS: 3600,        /* 显示用：看最近几秒内的铸造（1 小时） */
  minN: 2,           /* 显示用：同一个合约发了 2 个以上新币才列（只发 1 个的多半是一般合约） */
  detailN: 8,        /* 技术用：每次最多向 AVE 问几个新币的资料（额度） */
  padMax: 30,        /* 显示用：最多列几个发射台 */
  tokPerPad: 30,     /* 显示用：每个发射台在看盘最多放几个币 */
  candMax: 3000,     /* 技术用：最多追几个候选合约 */
  codeMax: 5000,     /* 技术用：「是不是合约」快取上限 */
  to: 12000,         /* 技术用：等节点几毫秒 */
  backoffS: 60,      /* 技术用：节点出错后等几秒再试 */
};
const READ_ONLY = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_getCode']);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', ZERO_T = '0x' + '0'.repeat(64);
const A40 = /^0x[0-9a-f]{40}$/;
/* 链：看盘代号、AVE 代号、公开节点（按顺序轮流；出错换下一个） */
const CHAINS = [
  { k: 'bsc', ave: 'bsc', id: 56, rpcs: ['https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://bsc-rpc.publicnode.com'] },
  { k: 'rh', ave: 'robinhood', id: 4663, rpcs: ['https://rpc.mainnet.chain.robinhood.com'] },
];
async function rpc(u, method, params) {
  if (!READ_ONLY.has(method)) throw new Error('read-only');
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(SC.to) });
  if (!r.ok) throw new Error('http ' + r.status); const j = await r.json(); if (j?.error) throw Object.assign(new Error(String(j.error.message || 'rpc').slice(0, 80)), { rpc: 1 }); return j.result;
}
/* 一条链扫一次：新区块的铸造 → 依收到铸造的合约分组 */
async function scanChain(T, c, now) {
  if ((T.wait || 0) > now) return;
  const u = c.rpcs[(T.ri || 0) % c.rpcs.length];
  try {
    if (!T.ok?.[u]) { const id = parseInt(await rpc(u, 'eth_chainId', []), 16); if (id !== c.id) { T.ri = (T.ri || 0) + 1; return; } (T.ok = T.ok || {})[u] = 1; }
    const head = parseInt(await rpc(u, 'eth_blockNumber', []), 16); if (!(head > 0)) throw new Error('head');
    if (T.next == null || head - T.next > SC.maxLag) T.next = Math.max(0, head - SC.maxLag);
    let span = SC.span;
    for (let i = 0; i < SC.perRun && T.next <= head; i++) {
      const to = Math.min(head, T.next + span - 1); let L;
      try { L = await rpc(u, 'eth_getLogs', [{ fromBlock: '0x' + T.next.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, ZERO_T] }]); }
      catch (e) { if (e.rpc && span > SC.spanMin) { span = Math.max(SC.spanMin, span >> 1); i--; continue; } throw e; }
      for (const g of Array.isArray(L) ? L : []) { const tp = g?.topics; if (!Array.isArray(tp) || tp.length !== 3) continue; const tok = String(g.address || '').toLowerCase(), rc = ('0x' + String(tp[2]).slice(-40)).toLowerCase(); if (!A40.test(tok) || !A40.test(rc) || rc === tok || /^0x0{40}$|^0x0{36}dead$/.test(rc)) continue;
        const C = (T.cand[rc] = T.cand[rc] || { t: {}, last: 0 }); if (!C.t[tok]) C.t[tok] = now; C.last = now; }
      T.next = to + 1;
    }
    T.err = ''; T.fail = 0;
  } catch (e) { T.err = String(e.message || e).slice(0, 80); T.fail = (T.fail || 0) + 1; T.ri = (T.ri || 0) + 1; T.wait = now + SC.backoffS * 1000; }
}
/* 整理：过期的拿掉；同一个合约有 ≥ minN 个新币、是合约、不在看盘已知清单里 → 发射台；它的新币问 AVE 放进看盘 */
export async function scoutRun(o, S, aveCall, pack, put, names) {
  const now = Date.now(); o.scout = o.scout || {}; const SS = o.scout; /* 候选只放在这个执行个体的记忆体（不存进储存，避免太大）；重启就从最新区块重新看 */ SS.at = now; let budget = SC.detailN;
  const known = new Set(); for (const [tag, L] of Object.entries(S.cols || {})) if (!/^scout_/.test(tag)) for (const a of L || []) known.add(a); /* AVE 清单里已经有的币 */
  const pads = [];
  for (const c of CHAINS) {
    const T = (SS[c.k] = SS[c.k] || { cand: {}, code: {} }); await scanChain(T, c, now);
    const ent = Object.entries(T.cand); for (const [a, C] of ent) { for (const [t, at] of Object.entries(C.t)) if (now - at > SC.winS * 1000) delete C.t[t]; if (!Object.keys(C.t).length) delete T.cand[a]; }
    if (Object.keys(T.cand).length > SC.candMax) { const old = Object.entries(T.cand).sort((x, y) => x[1].last - y[1].last).slice(0, Object.keys(T.cand).length - SC.candMax); for (const [a] of old) delete T.cand[a]; }
    const top = Object.entries(T.cand).filter(([, C]) => Object.keys(C.t).length >= SC.minN).sort((x, y) => Object.keys(y[1].t).length - Object.keys(x[1].t).length).slice(0, SC.padMax * 2);
    for (const [a, C] of top) {
      if (T.code[a] === undefined) { try { const cd = await rpc(c.rpcs[(T.ri || 0) % c.rpcs.length], 'eth_getCode', [a, 'latest']); T.code[a] = typeof cd === 'string' && cd.length > 2 ? 1 : 0; const ks = Object.keys(T.code); if (ks.length > SC.codeMax) delete T.code[ks[0]]; } catch { continue; } }
      if (!T.code[a]) continue; /* 收到铸造的是一般钱包＝不是发射台 */
      const toks = Object.entries(C.t).sort((x, y) => y[1] - x[1]).map(([t]) => t);
      if (toks.some((t) => known.has(t))) { C.known = 1; continue; } /* 看盘已经有它的币（AVE 认得的发射台，例 Four、Flap）→ 不重复 */
      if (C.known) continue;
      const tag = 'scout_' + a.slice(2, 10) + '_in_new'; const have = new Set(S.cols[tag] || []); const L = [];
      for (const t of toks.slice(0, SC.tokPerPad)) { if (have.has(t) || (S.m[c.k] && S.m[c.k][t])) { L.push(t); continue; } if (budget <= 0) continue; if ((C.miss?.[t] || 0) > now) continue; budget--;
        try { const d = await aveCall(o, '/v2/tokens/' + t + '-' + c.ave, 5); const tk = d?.token || d; const p = pack(tk); if (p && p[0] === c.k && p[1] === t) { if (!p[2].pl) p[2].pl = names[a] || ''; put(S, p, now); L.push(t); } else (C.miss = C.miss || {})[t] = now + SC.winS * 1000; } catch { (C.miss = C.miss || {})[t] = now + SC.backoffS * 1000; } }
      if (L.length) { S.cols[tag] = L; S.colsAt[tag] = now; pads.push({ ch: c.k, a, n: Object.keys(C.t).length, name: names[a] || '', tag }); }
    }
  }
  for (const tag of Object.keys(S.cols)) if (/^scout_/.test(tag) && !pads.some((p) => p.tag === tag)) { delete S.cols[tag]; delete S.colsAt[tag]; } /* 一段时间没再发币的发射台从看盘拿掉 */
  SS.pads = pads.slice(0, SC.padMax); SS.err = CHAINS.map((c) => (SS[c.k]?.err ? c.k + ': ' + SS[c.k].err : '')).filter(Boolean).join('; ');
}
