// 罗宾猫雷达 · 雷达自己找聪明钱：GMGN 那种「哪些钱包常常很早买到后来大涨的币」，全部本地算、只读链上
// 做法：从雷达自己读链的看板资料挑「后来涨到你设的倍数」和「没涨起来」的新币 → 查开盘后你设的几分钟内买进的真人钱包 → 统计每个钱包在你设的天数内的命中次数和胜率
// 怎么算「赢／输／早／几天」全部是你的设定（smartfind.*），开关预设关；没开或必填的没填＝不算、不产生名单
// BNB Chain、Robinhood Chain 分开算（两条链会赚钱的通常不是同一批人）。结果写 data/smart_auto.json 给雷达画面看。
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x0000000000000000000000000000000000000000', DEAD = '0x000000000000000000000000000000000000dead';
export function startSmartFind({ DIR, rpc, log }) {
  const F = join(DIR, 'data', 'smart_auto.json');
  let Z = (() => { try { return JSON.parse(readFileSync(F, 'utf8')); } catch { return {}; } })();
  for (const ch of ['bsc', 'rh']) { Z[ch] = Z[ch] || { done: {}, w: {} }; }
  const save = () => { try { writeFileSync(F, JSON.stringify(Z)); } catch {} };
  const RHU = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'];
  const rhRpc = async (m, p) => { let e; for (const u of RHU) { try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(20000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; } catch (x) { e = x; } } throw e; };
  const R = { bsc: rpc, rh: rhRpc };
  const FILES = { bsc: ['market_bsc.json', 'market_bsc_v4.json'], rh: ['market_rh.json'] };
  const MARKET_MAX_TRADES = 1500; /* 看盘资料每个币最多存这么多笔（radar/market.cjs 的 MAX_TRADES）；存满代表开头被裁掉、看不到开盘 → 读不到 */
  const PICK_BUDGET = 12, RANGE = 5000; /* 每轮每边最多查几个币（读链的量；查过的记在 done，下一轮轮到别的）；一次最多读几个区块（节点限制，分段读完） */
  const NRn = (k) => globalThis.NR?.num?.(k) ?? null, NRon = (k) => !!globalThis.NR?.on?.(k);
  async function blockAt(ch, ms) { /* 用两个区块的时间推算这个时间点大约是第几块 */
    const h = await R[ch]('eth_getBlockByNumber', ['latest', false]); const head = parseInt(h.number, 16), ht = parseInt(h.timestamp, 16);
    const back = ch === 'bsc' ? 100000 : 200000; const o = await R[ch]('eth_getBlockByNumber', ['0x' + (head - back).toString(16), false]); const spb = (ht - parseInt(o.timestamp, 16)) / back;
    return { blk: Math.max(1, Math.round(head - (ht - ms / 1000) / spb)), spb, head };
  }
  async function earlyBuyers(ch, c, t0, earlySec) {
    const { blk, spb, head } = await blockAt(ch, t0); const span = Math.ceil(earlySec / spb); /* 开盘后你设的几分钟 */
    const from = Math.max(1, blk - Math.ceil(60 / spb)), to = Math.min(head, blk + span); /* 往前多读一分钟：区块时间是推算的，避免漏掉开盘那一笔 */
    const L = []; for (let a = from; a <= to; a += RANGE) { const r = await R[ch]('eth_getLogs', [{ address: c, topics: [T], fromBlock: '0x' + a.toString(16), toBlock: '0x' + Math.min(to, a + RANGE - 1).toString(16) }]); if (Array.isArray(r)) L.push(...r); }
    if (!L.length) return [];
    const snd = {}; for (const l of L) { const f = '0x' + l.topics[1].slice(26); snd[f] = (snd[f] || 0) + 1; }
    const pool = Object.entries(snd).filter(([a]) => a !== ZERO).sort((a, b) => b[1] - a[1])[0]?.[0]; /* 送出最多笔的通常是池子／曲线 */
    const out = []; for (const l of L) { const f = '0x' + l.topics[1].slice(26), to2 = '0x' + l.topics[2].slice(26); if (f !== pool || [ZERO, DEAD, c, pool].includes(to2) || out.includes(to2)) continue; out.push(to2); } /* 时间内买的全部都算 */
    const eoa = []; for (const a of out) { try { const code = await R[ch]('eth_getCode', [a, 'latest']); if (code === '0x' || code === '0x0') eoa.push(a); } catch {} }
    return eoa;
  }
  let busy = 0;
  async function run() {
    if (busy) return; busy = 1;
    try {
      const winX = NRn('smartfind.winX'), loseX = NRn('smartfind.loseX'), earlyMin = NRn('smartfind.earlyMin'), days = NRn('smartfind.days');
      if (!NRon('smartfind.on') || winX == null || loseX == null || earlyMin == null || days == null) { if (!Z.offLog) { Z.offLog = 1; log('雷达自己找聪明钱：没开，或「几倍算赢／几倍以下算输／开盘几分钟内／看几天」没填 → 不算'); } return; } Z.offLog = 0;
      const winMs = days * 86400e3, waitMs = (NRn('smartfind.waitH') ?? 0) * 3600e3, minTr = NRn('smartfind.minTr') ?? 0, minWins = NRn('smartfind.minWins');
      for (const ch of ['bsc', 'rh']) {
        const S = Z[ch]; const now = Date.now(); const toks = [];
        for (const f of FILES[ch]) { try { const j = JSON.parse(readFileSync(join(DIR, 'data', f), 'utf8')); for (const x of Object.values(j.tokens || {})) toks.push(x); } catch {} }
        const win = [], lose = []; let noOpen = 0; const AV = (() => { try { return JSON.parse(readFileSync(join(DIR, 'data', 'ave_board.json'), 'utf8'))?.m?.[ch] || {}; } catch { return {}; } })();
        for (const x of toks) { const tr0 = Array.isArray(x.tr) ? x.tr : []; if (!tr0.length || tr0.length < minTr || tr0.length >= MARKET_MAX_TRADES) continue; /* 成交笔数下限＝你的设定；存满代表看不到开盘 */
          const c = String(x.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || S.done[c]) continue;
          /* 开盘时间＝读链看到的建立时间，没有就用 AVE 的建立时间；都没有＝读不到。存下来的第一笔成交要在开盘后你设的几分钟内（看盘资料只留最近一段，旧币的开头会被裁掉）→ 不然读不到、不算 */
          const ca = +(AV[c]?.ca || 0); const t0 = +x.at > 0 ? +x.at : ca > 0 ? (ca < 1e12 ? ca * 1000 : ca) : 0; if (!(t0 > 0)) { noOpen++; continue; }
          const tr = tr0.slice().sort((a, b) => a[0] - b[0]); if (tr[0][0] * 1000 - t0 > earlyMin * 60e3) { noOpen++; continue; } if (now - t0 > winMs || now - t0 < waitMs) continue; /* 你设的天数内、开盘超过你设的小时数才判断 */
          const p0 = +tr[0][3]; /* 时间最早那一笔的价格 */ let mx = 0; for (const r of tr) if (+r[3] > mx) mx = +r[3]; if (!(p0 > 0)) continue; const m = mx / p0;
          if (m >= winX) win.push({ c, t0, m, sym: String(x.sym || '').slice(0, 20) }); else if (m < loseX) lose.push({ c, t0, m, sym: String(x.sym || '').slice(0, 20) }); }
        if (noOpen && noOpen !== S.noOpen) { S.noOpen = noOpen; log(`找聪明钱（${ch}）：${noOpen} 个币读不到开盘（看盘资料没有开盘那段），不算`); }
        win.sort((a, b) => a.t0 - b.t0); lose.sort((a, b) => a.t0 - b.t0); /* 照时间先后排队查（不挑涨最多的） */
        const pick = [...win.slice(0, PICK_BUDGET).map((x) => ({ ...x, w: 1 })), ...lose.slice(0, PICK_BUDGET).map((x) => ({ ...x, w: 0 }))];
        for (const x of pick) {
          let B = []; try { B = await earlyBuyers(ch, x.c, x.t0, earlyMin * 60); } catch (e) { continue; } S.done[x.c] = now;
          for (const a of B) { const o = (S.w[a] = S.w[a] || { win: [], lose: [] }); if (x.w) { if (!o.win.some((y) => y.c === x.c)) o.win.push({ c: x.c, sym: x.sym, x: +x.m.toFixed(1), t: x.t0 }); } else if (!o.lose.some((y) => y.c === x.c)) o.lose.push({ c: x.c, t: x.t0 }); o.last = Math.max(o.last || 0, x.t0); }
          save();
        }
        /* 只留你设的天数内的记录 */
        for (const [a, o] of Object.entries(S.w)) { o.win = o.win.filter((y) => now - y.t < winMs); o.lose = o.lose.filter((y) => now - y.t < winMs); if (!o.win.length && !o.lose.length) delete S.w[a]; }
        for (const [c, t] of Object.entries(S.done)) if (now - t > winMs) delete S.done[c];
        S.rank = Object.entries(S.w).filter(([, o]) => o.win.length > 0 && (minWins == null || o.win.length >= minWins)).map(([a, o]) => ({ a, win: o.win.length, tries: o.win.length + o.lose.length, rate: +(o.win.length / (o.win.length + o.lose.length)).toFixed(2), best: o.win.slice().sort((p, q) => q.x - p.x)[0], last: o.last })).sort((p, q) => q.win - p.win || q.rate - p.rate); /* 至少赢几次才列＝你的设定（没填＝赢过就列）；全部列出 */
        S.at = now; save();
      }
    } catch (e) { log('找聪明钱 ' + e.message); } finally { busy = 0; }
  }
  setTimeout(() => run().catch(() => {}), 90e3); setInterval(() => run().catch(() => {}), 60 * 60e3);
  log('雷达自己找聪明钱：定时算（要在设定打开、填好数字才会算；BNB Chain、Robinhood 分开）');
}
