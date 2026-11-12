// 罗宾猫雷达 · 🆕 新发射台发现（PADSCOUT-1112）—— 只看、只通知，绝对没有买卖
// 原理：新币被「从 0 地址铸出」时，发射台通常把整批新币先铸给自己（曲线／金库合约）。
//       同一个「合约」在你填的时间内收到很多个不同新币的第一笔铸造 → 这个合约很可能是发射台。
// 这个模组只读节点（JSON-RPC 只准 eth_chainId／eth_blockNumber／eth_getLogs／eth_getCode／eth_call），
// 不接钱包、不签名、不送交易、不碰 WALLETS／baw／统一动作闸门。
// 设定（全部预设关／空白）：pads.on 总开关、pads.ch.<链> 每条链、pads.minTok＋pads.winMin「几分钟内发出几个新币才算」（没填＝不判断）、
//   pads.ignore 不看的合约、pads.tg 也发 TG、pads.rpc.<链> 节点清单（预设公开节点，设定页可改）。
// 结果写 data/padscout.json（画面读）；每个新发现写一行判断记录进雷达日志。重开后已发现的会从档案读回来（不会重复通知）。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/* 技术用常数：只管多久问一次节点、一次问多少、出错等多久、记忆体上限；不影响「什么算发射台」（那个是玩家填的 pads.minTok／pads.winMin） */
const PC = {
  pollMs: 4000,          /* 技术用：每 4 秒轮到下一条打开的链（链多就每条间隔长一点，不会同时打很多节点） */
  idleMs: 5000,          /* 技术用：开关关着时多久看一次设定（不连线） */
  span: 40,              /* 技术用：一次 eth_getLogs 最多查几块（公开节点有上限；结果太多会自动减半） */
  spanMin: 2,            /* 技术用：减半最少到几块 */
  spansPerTick: 3,       /* 技术用：轮到一条链时最多查几段 */
  maxLag: 400,           /* 技术用：落后超过几块就直接跳到最新（发现发射台是看「一段时间内的多个新币」，漏一小段不影响；画面会写跳过几块） */
  timeoutMs: 15000,      /* 技术用：等节点回应多久 */
  backoffMs: 8000,       /* 技术用：出错后第一次等多久 */
  backoffMaxMs: 300000,  /* 技术用：出错最多等多久 */
  codeMax: 20000,        /* 技术用：「是不是合约」的快取最多几个地址 */
  tokMax: 3000,          /* 技术用：每个候选合约最多记几个新币（超过只留最近的） */
  candMax: 5000,         /* 技术用：每条链最多追几个候选合约（超过丢最久没动的） */
  sample: 5,
  newLb: 2000,          /* 技术用：确认「是不是新币」往回看几块（这段时间里有更早的转帐＝旧币，例如借贷凭证、跨链包装币） */
  newPerTick: 12,       /* 技术用：每轮最多确认几个币是不是新的（节点额度） */
  newMax: 20000,        /* 技术用：「是不是新币」快取最多几个 */             /* 显示用：每个发射台画面上列几个最近的新币 */
  keep: 300,             /* 技术用：已发现的发射台最多留几个 */
  writeMs: 3000,         /* 技术用：最多几秒写一次 data/padscout.json */
  logKeep: 60,           /* 技术用：画面上留几行判断记录 */
  rpcMax: 5,             /* 技术用：每条链节点清单最多几个 */
  strMax: 40,            /* 技术用：链上名称／符号最多留几个字（攻击者可控） */
};
/* 链：雷达代号、链编号（连线前核对，不对就停用那个节点）、名称 */
export const PAD_CHAINS = [['bsc', 56, 'BNB Chain'], ['robinhood', 4663, 'Robinhood'], ['base', 8453, 'Base'], ['eth', 1, 'Ethereum'], ['arbitrum', 42161, 'Arbitrum'], ['polygon', 137, 'Polygon'], ['xlayer', 196, 'X Layer'], ['monad', 143, 'Monad']];
const READ_ONLY = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_getCode', 'eth_call']);
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_T = '0x' + '0'.repeat(64);
const A40 = /^0x[0-9a-f]{40}$/;
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41' };
/* 已知的发射台（只用来贴名字，不影响发现；不在这里的一样会被发现，只是名字要等 AVE 回来才有） */
export const KNOWN = { bsc: { '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0': 'Flap', '0x5c952063c7fc8610ffdb798152d69f0b9550762b': 'Four.meme' } };

export function padRpcList(s) {
  const out = [];
  for (const x of String(s || '').split(/[\s,，;；]+/).filter(Boolean)) {
    let u; try { u = new URL(x); } catch { continue; }
    if (u.username || u.password) continue;
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) continue;
    if (!out.includes(u.href)) out.push(u.href);
    if (out.length >= PC.rpcMax) break;
  }
  return out;
}
/*PADNAME-1112：发射台名字由雷达自动配（引擎写 data/pad_names.json：内建＋自动学到＋转接站名单），这里只拿来显示 */
export function padIgnore(s) { const a = new Set(); for (const x of String(s || '').split(/[\s,，;；]+/).filter(Boolean)) { const v = x.toLowerCase(); if (A40.test(v)) a.add(v); } return a; }

export async function padCall(url, method, params, ms = PC.timeoutMs) {
  if (!READ_ONLY.has(method)) throw new Error('只读模组不送这个指令：' + method);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('节点回 HTTP ' + r.status);
  let j; try { j = await r.json(); } catch { throw new Error('节点回应不是 JSON'); }
  if (j && j.error) { const e = new Error('节点错误：' + String(j.error.message || j.error.code || '').slice(0, 120)); e.rpc = j.error; throw e; }
  if (!j || !('result' in j)) throw new Error('节点回应格式不对');
  return j.result;
}
const hexN = (h) => { try { return BigInt(h); } catch { return null; } };
function cleanS(t) { return [...String(t).replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿�]/g, '').trim()].slice(0, PC.strMax).join('').trim(); }
function decStr(h) { const s = String(h || '').replace(/^0x/, ''); if (!s || !/^[0-9a-f]*$/i.test(s)) return null;
  try { if (s.length >= 128) { const p = Number(BigInt('0x' + s.slice(0, 64))) * 2; const len = Number(BigInt('0x' + s.slice(p, p + 64))); if (len >= 0 && len <= 256 && p + 64 + len * 2 <= s.length) { const t = cleanS(Buffer.from(s.slice(p + 64, p + 64 + len * 2), 'hex').toString('utf8')); return t || null; } }
    if (s.length === 64) { const t = cleanS(Buffer.from(s, 'hex').toString('utf8').replace(/\u0000+$/g, '')); return t || null; } } catch {}
  return null; }

/* 纯函式（测试用）：一个候选合约在时间窗内收到几个不同新币的第一笔铸造 */
export function padCount(toks, now, winMs) { let n = 0; for (const t of toks.values()) if (now - t.at <= winMs) n++; return n; }

export function startPadScout(D) {
  const { DIR, log, radarSet, tg } = D;
  const F = join(DIR, 'data', 'padscout.json');
  const NR = () => globalThis.NR;
  const on = (k) => { try { return !!NR()?.on(k); } catch { return false; } };
  const num = (k) => { try { const v = NR()?.num(k); return v == null || !Number.isFinite(+v) ? null : +v; } catch { return null; } };
  const SCH = (() => { try { return JSON.parse(readFileSync(join(DIR, 'radar', 'settings_schema.json'), 'utf8')).items || []; } catch { return []; } })();
  const txt = (k) => { let z = {}; try { z = radarSet() || {}; } catch {} const v = z[k]; if (v === undefined || v === null) { const d = SCH.find((i) => i.k === k)?.def; return d == null ? '' : String(d); } return typeof v === 'object' ? '' : String(v).trim(); };

  let PNF = { at: 0, m: new Map() }; const padNamesFile = () => { if (Date.now() - PNF.at > 30e3) { PNF.at = Date.now(); try { const j = JSON.parse(readFileSync(join(DIR, 'data', 'pad_names.json'), 'utf8')); PNF.m = new Map(Object.entries(j?.names || {}).filter(([a, n]) => A40.test(a) && typeof n === 'string').map(([a, n]) => [a, cleanS(n).slice(0, 24)])); } catch {} } return PNF.m; }; /* 只有 BNB Chain 有自动配名字 */
  /* 每条链的状态 */
  const C = {}; for (const [k, id, nm] of PAD_CHAINS) C[k] = { k, id, nm, rpcKey: null, rpcs: [], cur: -1, ok: new Set(), bad: {}, next: null, head: null, fails: 0, wait: 0, st: { code: 'off', msg: '' }, cand: new Map(), code: new Map(), skipped: 0, since: 0 };
  /* 已发现的发射台（重开读回来，不重复通知） */
  let FOUND = []; try { const o = JSON.parse(readFileSync(F, 'utf8')); if (Array.isArray(o?.found)) FOUND = o.found.filter((x) => x && A40.test(String(x.a)) && C[x.ch]).slice(0, PC.keep); } catch {}
  let logs = [], lastW = 0, rr = 0;
  const say = (s) => { try { log('🆕 新发射台 ' + s); } catch {} logs.push({ at: Date.now(), t: String(s).slice(0, 300) }); if (logs.length > PC.logKeep) logs = logs.slice(-PC.logKeep); };
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const errT = (e) => String(e?.name === 'TimeoutError' ? '节点逾时没回应' : e?.message || e || '').slice(0, 160);

  function view(force) {
    const now = Date.now(); if (!force && now - lastW < PC.writeMs) return; lastW = now;
    const ch = {}; for (const x of Object.values(C)) ch[x.k] = { on: on('pads.ch.' + x.k) ? 1 : 0, nm: x.nm, st: x.st, head: x.head, next: x.next, rpc: x.rpcs.map(host), rpcNow: x.cur >= 0 ? host(x.rpcs[x.cur]) : '', cand: x.cand.size, skipped: x.skipped, since: x.since };
    const UN = padNamesFile(); const o = { v: 1, at: now, on: on('pads.on') ? 1 : 0, minTok: num('pads.minTok'), winMin: num('pads.winMin'), ch, found: FOUND.map((f) => (f.ch === 'bsc' && !f.known && UN.has(f.a) ? { ...f, known: UN.get(f.a) } : f)), log: logs.slice(-PC.logKeep) };
    try { writeFileSync(F + '.w', JSON.stringify(o)); renameSync(F + '.w', F); } catch {}
  }
  function reset(x, code, msg) { x.cur = -1; x.ok = new Set(); x.bad = {}; x.next = null; x.head = null; x.fails = 0; x.wait = 0; x.cand.clear(); x.skipped = 0; x.since = 0; x.st = { code, msg }; }

  async function pick(x) {
    for (let i = 0; i < x.rpcs.length; i++) { const k = x.cur < 0 ? i : (x.cur + i) % x.rpcs.length; const u = x.rpcs[k]; if (x.bad[u]) continue; if (x.ok.has(u)) { x.cur = k; return u; }
      try { const id = hexN(await padCall(u, 'eth_chainId', [])); if (id !== BigInt(x.id)) { x.bad[u] = `链编号不对：节点回 ${id == null ? '读不懂' : id.toString()}，${x.nm} 应该是 ${x.id}`; say(`${x.nm} ❌ 节点 ${host(u)} ${x.bad[u]} → 停用这个节点`); continue; }
        x.ok.add(u); x.cur = k; return u; } catch (e) { throw Object.assign(new Error(`${host(u)}：${errT(e)}`), { node: u }); } }
    return null;
  }
  async function isContract(x, u, a) { if (x.code.has(a)) return x.code.get(a); const c = await padCall(u, 'eth_getCode', [a, 'latest']); const v = typeof c === 'string' && c.length > 2; x.code.set(a, v); if (x.code.size > PC.codeMax) x.code.delete(x.code.keys().next().value); return v; }
  async function isNew(u, t, b) { /* true＝这个币在第一次铸造之前没有任何转帐（新币）；false＝之前就有（旧币）；null＝读不到 */
    if (!Number.isFinite(b) || b <= 0) return null; let lb = PC.newLb;
    while (lb >= 1) { const from = Math.max(0, b - lb); try { const L = await padCall(u, 'eth_getLogs', [{ address: t, fromBlock: '0x' + from.toString(16), toBlock: '0x' + (b - 1).toString(16), topics: [TRANSFER] }]); return Array.isArray(L) ? L.length === 0 : null; } catch (e) { if (!e.rpc) return null; lb = Math.floor(lb / 2); } }
    return null; }
  async function lpLike(u, toks) { for (const c of toks) { try { const r = await padCall(u, 'eth_call', [{ to: c, data: '0x0dfe1681' }, 'latest']); if (typeof r === 'string' && /^0x0{24}[0-9a-f]{40}$/i.test(r) && !/^0x0{64}$/.test(r)) return true; } catch {} } return false; } /* token0()：LP 凭证才有 */
  async function meta(u, c) { const g = async (s) => { try { return await padCall(u, 'eth_call', [{ to: c, data: s }, 'latest']); } catch { return null; } }; const [n, s] = await Promise.all([g(SEL.name), g(SEL.symbol)]); return { n: decStr(n), s: decStr(s) }; }

  async function tickChain(x) {
    const rk = txt('pads.rpc.' + x.k); if (rk !== x.rpcKey) { x.rpcKey = rk; x.rpcs = padRpcList(rk); reset(x, 'start', ''); }
    if (!x.rpcs.length) { x.st = { code: 'norpc', msg: '节点清单是空的或格式不对（只收 https 网址）→ 不连线' }; return; }
    if (x.rpcs.every((u) => x.bad[u])) { x.st = { code: 'badchain', msg: Object.values(x.bad)[0] + '。已停止（改节点清单才会重试）' }; return; }
    if (Date.now() < x.wait) return;
    try {
      const u = await pick(x); if (!u) { x.st = { code: 'badchain', msg: Object.values(x.bad)[0] || '没有可用节点' }; return; }
      const h = Number(hexN(await padCall(u, 'eth_blockNumber', []))); if (!Number.isFinite(h) || h < 0) throw new Error('区块高度读不懂');
      x.head = h; if (x.next == null) { x.next = h + 1; x.since = Date.now(); say(`${x.nm} 从区块 ${h + 1} 开始看（打开的那一刻开始，不回头查旧的）`); }
      if (h - x.next + 1 > PC.maxLag) { x.skipped += h - PC.maxLag - x.next + 1; x.next = h - PC.maxLag + 1; }
      let span = PC.span, loops = 0; const now = Date.now();
      while (x.next <= x.head && loops < PC.spansPerTick) {
        const to = Math.min(x.head, x.next + span - 1); let L;
        try { L = await padCall(u, 'eth_getLogs', [{ fromBlock: '0x' + x.next.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER, ZERO_T] }]); }
        catch (e) { if (e.rpc && span > PC.spanMin) { span = Math.max(PC.spanMin, Math.floor(span / 2)); continue; } throw e; }
        if (!Array.isArray(L)) throw new Error('eth_getLogs 回应格式不对');
        for (const g of L) { const tp = g && Array.isArray(g.topics) ? g.topics : []; if (tp.length !== 3) continue; /* ERC20 的 Transfer（NFT 是 4 个 topic，不算） */
          const tok = String(g.address || '').toLowerCase(), to2 = '0x' + String(tp[2]).toLowerCase().slice(-40); if (!A40.test(tok) || !A40.test(to2) || to2 === tok || /^0x0{40}$|^0x0{36}dead$/.test(to2)) continue;
          let cd = x.cand.get(to2); if (!cd) { if (x.cand.size >= PC.candMax) { let old = null, ot = Infinity; for (const [a, v] of x.cand) if (v.last < ot) { ot = v.last; old = a; } if (old) x.cand.delete(old); } cd = { toks: new Map(), last: now }; x.cand.set(to2, cd); }
          if (!cd.toks.has(tok)) { cd.toks.set(tok, { at: now, b: parseInt(g.blockNumber, 16) }); if (cd.toks.size > PC.tokMax) cd.toks.delete(cd.toks.keys().next().value); } cd.last = now; }
        x.next = to + 1; loops++;
      }
      await judge(x, u);
      x.fails = 0; x.st = { code: x.next <= x.head ? 'catch' : 'ok', msg: x.next <= x.head ? `还在补区块（落后 ${x.head - x.next + 1} 块）` : '' };
    } catch (e) {
      x.fails++; const w = Math.min(PC.backoffMaxMs, PC.backoffMs * 2 ** Math.min(x.fails - 1, 16)); x.wait = Date.now() + w;
      if (e.node) { x.ok.delete(e.node); x.cur = (x.rpcs.indexOf(e.node) + 1) % x.rpcs.length; } else if (x.cur >= 0) { x.ok.delete(x.rpcs[x.cur]); x.cur = (x.cur + 1) % x.rpcs.length; }
      x.st = { code: 'err', msg: `读不到（${errT(e)}），${Math.round(w / 1000)} 秒后重试`, retryAt: x.wait };
      if (x.fails === 1 || x.fails % 10 === 0) say(`${x.nm} ❌ ${x.st.msg}`);
    }
  }

  async function judge(x, u) {
    const minTok = num('pads.minTok'), winMin = num('pads.winMin'); if (minTok == null || winMin == null) return; /* 没填＝不判断（不用程式里的数字代替） */
    const now = Date.now(), win = winMin * 60e3, ign = padIgnore(txt('pads.ignore')); const budget = { n: PC.newPerTick }; x.newTok = x.newTok || new Map();
    for (const [a, cd] of x.cand) { for (const [t, v] of cd.toks) if (now - v.at > win) cd.toks.delete(t); if (!cd.toks.size) { x.cand.delete(a); continue; }
      const n = padCount(cd.toks, now, win); const old = FOUND.find((f) => f.ch === x.k && f.a === a);
      if (old) { old.n = Math.max(old.n || 0, n); old.last = now; old.sample = [...cd.toks.keys()].slice(-PC.sample); continue; }
      if (n < minTok) continue;
      if (ign.has(a)) continue;
      { let nNew = 0, unk = 0; for (const [t, v] of cd.toks) { let k = x.newTok.get(t); if (k === undefined) { if (budget.n <= 0) { unk++; continue; } budget.n--; k = await isNew(u, t, v.b); x.newTok.set(t, k); if (x.newTok.size > PC.newMax) x.newTok.delete(x.newTok.keys().next().value); } if (k === true) nNew++; else if (k === null) unk++; if (nNew >= minTok) break; }
        if (nNew < minTok) continue; } /* 只算真的是新币的（往回看一段没有更早的转帐）；还没确认完的下一轮再算 */
      if (!(await isContract(x, u, a))) continue; /* 收到铸造的是一般钱包＝不是发射台 */
      if (x.notPad?.has(a)) continue; if (await lpLike(u, [...cd.toks.keys()].slice(-3))) { (x.notPad = x.notPad || new Set()).add(a); say(`${x.nm} ${a}：收到的是流动性凭证（LP，有 token0）→ 是 DEX 手续费／流动性合约，不是发射台`); continue; } /* Uniswap／Pancake 的 feeTo 会收到很多不同 LP 的铸造，不能当发射台 */
      const sample = [...cd.toks.keys()].slice(-PC.sample); const m = await meta(u, sample[sample.length - 1]);
      const known = (x.k === 'bsc' ? padNamesFile().get(a) : '') || KNOWN[x.k]?.[a] || '';
      const f = { ch: x.k, a, n, first: now, last: now, sample, known, tokN: m.n, tokS: m.s };
      FOUND.unshift(f); if (FOUND.length > PC.keep) FOUND = FOUND.slice(0, PC.keep);
      const line = `${x.nm} ${known ? `已知发射台 ${known}` : '疑似新发射台'} ${a}：✅ 合约 ✅ ${winMin} 分钟内发出 ${n} 个新币（你设至少 ${minTok} 个）${known ? '' : ' → 通知（只看，不买）'}`;
      say(line);
      if (!known && on('pads.tg')) { try { await tg(`🆕 发现疑似新发射台（${x.nm}）\n${a}\n${winMin} 分钟内发出 ${n} 个新币，例如 ${m.s || m.n || sample[sample.length - 1]}\n只通知，不会自动买。不想看这个合约：设定 → 新发射台 → 不看的合约`); } catch {} }
    }
  }

  async function tick() {
    if (!on('pads.on')) { if (Object.values(C).some((x) => x.st.code !== 'off')) { for (const x of Object.values(C)) reset(x, 'off', ''); say('关了 → 不连线'); view(true); } return; }
    const L = Object.values(C).filter((x) => on('pads.ch.' + x.k)); for (const x of Object.values(C)) if (!L.includes(x) && x.st.code !== 'off') reset(x, 'off', '');
    if (!L.length) { view(); return; }
    if (num('pads.minTok') == null || num('pads.winMin') == null) { for (const x of L) if (x.st.code !== 'nonum') { reset(x, 'nonum', '还没填「至少发出几个新币」和「在几分钟内」→ 不连线、不判断'); } view(); return; } /* 没填数字＝不判断，也就不用连线 */
    const x = L[rr++ % L.length]; await tickChain(x); view();
  }
  let busy = 0, stopped = 0;
  const loop = async () => { if (stopped) return; if (!busy) { busy = 1; try { await tick(); } catch (e) { try { log('🆕 新发射台 出错 ' + errT(e)); } catch {} } finally { busy = 0; } } setTimeout(loop, on('pads.on') ? PC.pollMs : PC.idleMs); };
  view(true); setTimeout(loop, 0);
  return { stop: () => { stopped = 1; }, _C: C, tick, judge, _found: () => FOUND };
}
