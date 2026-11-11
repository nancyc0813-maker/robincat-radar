// 罗宾猫雷达 · 🌐 Elysium 链新币监测（ELY-107）—— 只看，绝对没有买卖
// Elysium＝Kinetiq 给 Hyperliquid 做的 L2（gas 用 HYPE）。主网已于 11/9 上线（chainId 99901）。
// 这个模组只读节点（JSON-RPC 只准 eth_chainId／eth_blockNumber／eth_getLogs／eth_call 四种），
// 不接钱包、不签名、不送交易、不碰 WALLETS／baw／统一动作闸门；拿不到钱包，也没有送交易的程式码。
// 开关 ely.on（预设关）：关着＝完全不连线。节点清单 ely.rpc、最多留几个 ely.keepN、排除清单 ely.excl 都在设定页，玩家可以改。
// 读不到就显示「读不到」，不猜数字；节点出错会退避（越错等越久），避免打爆社群节点。
// 结果写 data/elysium.json（画面／手机读），判断记录写进雷达日志（每个新代币一行：✅／❌ 理由 → 显示／不显示）。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

/* 技术用常数：只管多久问一次节点、一次问多少、出错等多久、记忆体上限；不影响「显示什么」，跟买卖无关（这个功能没有买卖） */
const EC = {
  chainId: 99901,          /* 技术用：Elysium 的链编号（0x1863d）；连线前核对，不对就停 */
  pollMs: 5000,            /* 技术用：多久问一次新区块 */
  idleMs: 5000,            /* 技术用：开关关着时多久看一次设定（不连线） */
  span: 1000,              /* 技术用：一次 eth_getLogs 最多查几块（节点上限 2000，留一半余裕；结果太多会自动减半） */
  spanMin: 25,             /* 技术用：自动减半最少到几块 */
  spansPerTick: 4,         /* 技术用：一轮最多补几段（落后太多分几轮慢慢补） */
  timeoutMs: 10000,        /* 技术用：等节点回应多久 */
  backoffMs: 5000,         /* 技术用：出错后第一次等多久 */
  backoffMaxMs: 300000,    /* 技术用：出错最多等多久 */
  metaTry: 5,              /* 技术用：名称／符号读不到最多再试几轮 */
  metaPerTick: 8,          /* 技术用：一轮最多读几个代币的名称 */
  evMax: 5000,             /* 技术用：每个代币最多记几笔（超过显示「至少」） */
  keepMax: 500,            /* 技术用：画面最多留几个代币（玩家填更多也只到这里，画面会写） */
  keepNone: 100,           /* 技术用：玩家没填「最多留几个」时画面留几个（只影响显示几行） */
  win10: 10 * 60e3,        /* 显示用：「最近 10 分钟」统计窗口（老板指定的显示栏位，不是门槛） */
  win60: 60 * 60e3,        /* 显示用：「最近 1 小时」统计窗口（老板指定的显示栏位，不是门槛） */
  writeMs: 3000,           /* 技术用：最多几秒写一次 data/elysium.json */
  logKeep: 40,             /* 技术用：画面上留几行判断记录 */
  rpcMax: 5,               /* 技术用：节点清单最多几个 */
  word: 64,                /* 技术用：ABI 一个字的长度（16 进位字数） */
  strMax: 64,              /* 技术用（ELY107-FIX）：链上名称／符号最多留几个字（攻击者可控，防 data/elysium.json 被超长名称撑爆；只影响显示） */
};
const READ_ONLY = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getLogs', 'eth_call']); /* 只准这四种「读」的指令；送交易／签名的指令一律不认识 */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_T = '0x' + '0'.repeat(EC.word);
const SEL = { name: '0x06fdde03', symbol: '0x95d89b41', decimals: '0x313ce567', totalSupply: '0x18160ddd' };
const A40 = /^0x[0-9a-f]{40}$/;

/* 节点网址：只收 https（本机 127.0.0.1／localhost 可以用 http，给自己架的节点或测试用）；不收帐号密码 */
export function elyRpcList(s) {
  const out = [];
  for (const x of String(s || '').split(/[\s,，;；]+/).filter(Boolean)) {
    let u; try { u = new URL(x); } catch { continue; }
    if (u.username || u.password) continue;
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) continue;
    if (!out.includes(u.href)) out.push(u.href);
    if (out.length >= EC.rpcMax) break;
  }
  return out;
}
export function elyExcl(s) { const a = new Set(), sy = new Set(); for (const x of String(s || '').split(/[\s,，;；]+/).filter(Boolean)) { const v = x.toLowerCase(); if (A40.test(v)) a.add(v); else sy.add(v); } return { a, sy }; }

/* 只读 JSON-RPC：方法不在白名单就丢错（这个模组里没有任何送交易的路径） */
export async function elyCall(url, method, params, ms = EC.timeoutMs) {
  if (!READ_ONLY.has(method)) throw new Error('只读模组不送这个指令：' + method);
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), redirect: 'error', signal: AbortSignal.timeout(ms) }); /* ELY107-FIX：不跟随转址，节点网址不能被转去打别的地方 */
  if (!r.ok) throw new Error('节点回 HTTP ' + r.status);
  const j = await r.json();
  if (j && j.error) { const e = new Error('节点错误：' + String(j.error.message || j.error.code || '').slice(0, 120)); e.rpc = j.error; throw e; }
  if (!j || !('result' in j)) throw new Error('节点回应格式不对');
  return j.result;
}

const hexN = (h) => { try { const v = BigInt(h); return v; } catch { return null; } };
/* ELY107-FIX：去掉控制字元、方向控制（RLO 等）、零宽字元、坏掉的 UTF-8，再截到 strMax 个字 */
function cleanS(t) { return [...String(t).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\ufffd]/g, '').trim()].slice(0, EC.strMax).join('').trim(); }
function decStr(h) { /* ABI string 或 bytes32；读不懂＝null（画面写「读不到」） */
  const s = String(h || '').replace(/^0x/, ''); if (!s || !/^[0-9a-f]*$/i.test(s)) return null;
  try {
    if (s.length >= EC.word * 2) { const off = Number(BigInt('0x' + s.slice(0, EC.word))); const p = off * 2; const len = Number(BigInt('0x' + s.slice(p, p + EC.word))); if (len >= 0 && p + EC.word + len * 2 <= s.length) { const t = cleanS(Buffer.from(s.slice(p + EC.word, p + EC.word + Math.min(len, EC.strMax * 4) * 2), 'hex').toString('utf8')); return t || null; } } /* ELY107-FIX：最多解 strMax×4 个位元组 */
    if (s.length === EC.word) { const t = cleanS(Buffer.from(s, 'hex').toString('utf8').replace(/\u0000+$/g, '')); return t || null; }
  } catch {}
  return null;
}

export function startElysium(D) {
  const { DIR, log, radarSet } = D;
  const F = join(DIR, 'data', 'elysium.json');
  const NR = () => globalThis.NR;
  const on = () => { try { return !!NR()?.on('ely.on'); } catch { return false; } };
  const SCH = (() => { try { return JSON.parse(readFileSync(join(DIR, 'radar', 'settings_schema.json'), 'utf8')).items || []; } catch { return []; } })();
  /* 文字设定：设定档里没有这一项＝用设定页的预设（写在 settings_schema.json，画面看得到、可以改）；玩家清空＝空白 */
  const txt = (k) => { let z = {}; try { z = radarSet() || {}; } catch {} const v = z[k]; if (v === undefined || v === null) { const d = SCH.find((i) => i.k === k)?.def; return d == null ? '' : String(d); } return typeof v === 'object' ? '' : String(v).trim(); };
  const keepN = () => { let v = null; try { v = NR()?.num('ely.keepN'); } catch {} if (v == null || !Number.isFinite(+v) || +v < 1) return { n: EC.keepNone, why: 'none' }; const n = Math.floor(+v); return n > EC.keepMax ? { n: EC.keepMax, why: 'cap' } : { n, why: '' }; };

  const T = new Map(); /* 合约 → { c, first, name, sym, dec, ts, mTry, ev: [[t, to, mint]], trunc, ex } */
  let lastK = '', st = { code: 'off', msg: '' }, rpcs = [], rpcKey = '', cur = -1, verified = new Set(), bad = {}, next = null, fails = 0, waitTill = 0, lastW = 0, head = null, logs = [];
  const say = (s) => { try { log('🌐 Elysium ' + s); } catch {} logs.push({ at: Date.now(), t: String(s).slice(0, 300) }); if (logs.length > EC.logKeep) logs = logs.slice(-EC.logKeep); };
  const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
  const errT = (e) => String(e?.name === 'TimeoutError' ? '节点逾时没回应' : e?.message || e || '').slice(0, 160);

  function view(force) {
    const now = Date.now(); const sk = st.code + '|' + T.size; if (!force && now - lastW < EC.writeMs && sk === lastK) return; lastW = now; lastK = sk; /* 状态或代币数变了马上写，其他最多几秒写一次 */
    const K = keepN(); const ex = elyExcl(txt('ely.excl'));
    const all = [...T.values()];
    let nEx = 0; const L = [];
    for (const x of all) { if (ex.a.has(x.c) || (x.sym && ex.sy.has(x.sym.toLowerCase())) || (x.name && ex.sy.has(x.name.toLowerCase()))) { nEx++; continue; }
      const w = (ms) => { const t0 = now - ms; const rc = new Set(); let m = 0, tr = 0; for (const [t, to, mint] of x.ev) { if (t < t0) continue; rc.add(to); if (mint) m++; else tr++; } return { w: rc.size, m, tr }; };
      const a = w(EC.win10), b = w(EC.win60);
      L.push({ c: x.c, name: x.name, sym: x.sym, dec: x.dec, ts: x.ts, first: x.first, w10: a.w, w60: b.w, m10: a.m, m60: b.m, t10: a.tr, t60: b.tr, trunc: x.trunc ? 1 : 0, meta: x.name != null || x.sym != null ? 1 : x.mTry >= EC.metaTry ? -1 : 0 }); }
    L.sort((p, q) => q.first - p.first); /* 「只留最近 N 个」＝最近出现的 N 个 */
    const keep = L.slice(0, K.n);
    const o = { v: 1, at: now, on: on() ? 1 : 0, st, chainId: EC.chainId, rpc: rpcs.map(host), rpcNow: cur >= 0 ? host(rpcs[cur]) : '', head, next, keepN: K.n, keepWhy: K.why, keepMax: EC.keepMax, nAll: all.length, nEx, since: SINCE, win: [EC.win10, EC.win60], list: keep, log: logs.slice(-EC.logKeep) };
    try { writeFileSync(F + '.w', JSON.stringify(o)); renameSync(F + '.w', F); } catch {}
  }
  let SINCE = 0;
  function reset(code, msg) { T.clear(); next = null; head = null; cur = -1; verified = new Set(); bad = {}; fails = 0; waitTill = 0; SINCE = 0; st = { code, msg }; }

  async function rpcPick() { /* 依序找一个核对过链编号的节点；链编号不对的节点停用（画面写原因），直到你改节点清单或关掉再打开 */
    for (let i = 0; i < rpcs.length; i++) { const k = (cur < 0 ? i : (cur + i) % rpcs.length); const u = rpcs[k]; if (bad[u]) continue; if (verified.has(u)) { cur = k; return u; }
      try { const id = hexN(await elyCall(u, 'eth_chainId', [])); if (id !== BigInt(EC.chainId)) { bad[u] = '链编号不对：节点回 ' + (id == null ? '读不懂' : id.toString()) + '，Elysium 应该是 ' + EC.chainId; say(`❌ 节点 ${host(u)} ${bad[u]} → 停用这个节点（不连线）`); continue; }
        verified.add(u); cur = k; say(`✅ 节点 ${host(u)} 链编号 ${EC.chainId} 核对通过 → 开始只读监测`); return u; } catch (e) { throw Object.assign(new Error(`${host(u)}：${errT(e)}`), { node: u }); } }
    return null;
  }

  async function meta(x, u) {
    const g = async (s) => { try { return await elyCall(u, 'eth_call', [{ to: x.c, data: s }, 'latest']); } catch { return null; } };
    const [n, s, d, t] = await Promise.all([g(SEL.name), g(SEL.symbol), g(SEL.decimals), g(SEL.totalSupply)]);
    x.mTry++;
    if (x.name == null) x.name = decStr(n); if (x.sym == null) x.sym = decStr(s);
    if (x.dec == null) { const v = hexN(d); x.dec = v != null && v <= 255n ? Number(v) : null; }
    { const v = hexN(t); if (v != null) x.ts = v.toString(); }
  }

  async function tick() {
    if (!on()) { if (st.code !== 'off') { reset('off', ''); say('监测关了 → 不连线'); view(true); } return; } /* 关着：不连线，只在刚关掉时写一次档 */
    const rk = txt('ely.rpc'); if (rk !== rpcKey) { rpcKey = rk; rpcs = elyRpcList(rk); reset('start', ''); }
    if (!rpcs.length) { st = { code: 'norpc', msg: '节点清单是空的或格式不对（只收 https 网址）→ 不连线、读不到' }; view(); return; }
    if (rpcs.every((u) => bad[u])) { st = { code: 'badchain', msg: Object.values(bad)[0] + '。已停止（改节点清单或关掉再打开才会重试）' }; view(); return; }
    if (Date.now() < waitTill) { view(); return; } /* 退避中：不打节点，只更新画面档时间（画面才不会误以为引擎停了） */
    try {
      const u = await rpcPick(); if (!u) { st = { code: 'badchain', msg: Object.values(bad)[0] || '没有可用节点' }; view(true); return; }
      const h = Number(hexN(await elyCall(u, 'eth_blockNumber', []))); if (!Number.isFinite(h) || h < 0) throw new Error('区块高度读不懂');
      head = h; if (next == null) { next = h + 1; SINCE = Date.now(); say(`从区块 ${h + 1} 开始看（打开的那一刻开始，不回头查旧的）`); }
      let span = EC.span, loops = 0;
      while (next <= head && loops < EC.spansPerTick) {
        const to = Math.min(head, next + span - 1); let L;
        try { L = await elyCall(u, 'eth_getLogs', [{ fromBlock: '0x' + next.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER] }]); }
        catch (e) { if (e.rpc && span > EC.spanMin) { span = Math.max(EC.spanMin, Math.floor(span / 2)); continue; } throw e; } /* 结果太多＝分小段再查 */
        if (!Array.isArray(L)) throw new Error('eth_getLogs 回应格式不对');
        for (const g of L) {
          const tp = g && Array.isArray(g.topics) ? g.topics : []; if (tp.length !== 3 || String(tp[0]).toLowerCase() !== TRANSFER) continue; /* ERC20 的 Transfer 是 3 个 topic（NFT 是 4 个，不算） */
          const c = String(g.address || '').toLowerCase(); if (!A40.test(c)) continue;
          const fromZ = String(tp[1]).toLowerCase() === ZERO_T; const to = '0x' + String(tp[2]).toLowerCase().slice(-40);
          const bt = hexN(g.blockTimestamp); const t = bt != null && bt > 0n ? Number(bt) * 1000 : Date.now(); /* 节点有给区块时间就用，没有＝雷达看到的时间 */
          let x = T.get(c);
          if (!x) { if (!fromZ) continue; /* 只有「从 0 地址铸出来」才算发现新代币 */
            x = { c, first: t, name: null, sym: null, dec: null, ts: null, mTry: 0, ev: [], trunc: 0 }; T.set(c, x); x.fresh = 1; }
          if (x.ev.length >= EC.evMax) { x.ev.shift(); x.trunc = 1; }
          x.ev.push([t, to, fromZ ? 1 : 0]);
        }
        next = to + 1; loops++;
      }
      /* 名称／符号：新代币先读；读完写判断记录 */
      let n = 0; for (const x of T.values()) { if (n >= EC.metaPerTick) break; if ((x.name == null && x.sym == null) && x.mTry < EC.metaTry) { n++; await meta(x, u); }
        if (x.fresh && (x.name != null || x.sym != null || x.mTry >= EC.metaTry)) { x.fresh = 0; const ex = elyExcl(txt('ely.excl')); const hit = ex.a.has(x.c) || (x.sym && ex.sy.has(x.sym.toLowerCase())) || (x.name && ex.sy.has(x.name.toLowerCase()));
          say(`新代币 ${x.sym ?? '（符号读不到）'} ${x.c}：✅ 从 0 地址铸出（Transfer） ${hit ? '❌ 在你的排除清单（ely.excl）→ 不显示' : '✅ 不在你的排除清单 → 显示'}（只看，不买卖）`); } }
      /* 一小时前的纪录丢掉；代币太多时只留最近出现的（技术上限的几倍，防记忆体） */
      const t0 = Date.now() - EC.win60; for (const x of T.values()) { while (x.ev.length && x.ev[0][0] < t0) x.ev.shift(); }
      if (T.size > EC.keepMax * 2) { const arr = [...T.values()].sort((p, q) => q.first - p.first); for (const x of arr.slice(EC.keepMax * 2)) T.delete(x.c); }
      fails = 0; st = { code: next <= head ? 'catch' : 'ok', msg: next <= head ? `还在补区块（落后 ${head - next + 1} 块）` : '' }; view();
    } catch (e) {
      fails++; const w = Math.min(EC.backoffMaxMs, EC.backoffMs * 2 ** Math.min(fails - 1, 16)); waitTill = Date.now() + w;
      if (e.node) { verified.delete(e.node); cur = (rpcs.indexOf(e.node) + 1) % rpcs.length; } else if (cur >= 0) { verified.delete(rpcs[cur]); cur = (cur + 1) % rpcs.length; }
      st = { code: 'err', msg: `读不到（${errT(e)}），${Math.round(w / 1000)} 秒后重试`, retryAt: waitTill };
      if (fails === 1 || fails % 10 === 0) say(`❌ ${st.msg}`); view(true);
    }
  }
  let busy = 0, stopped = 0;
  const loop = async () => { if (stopped) return; if (!busy) { busy = 1; try { await tick(); } catch (e) { try { log('🌐 Elysium 出错 ' + errT(e)); } catch {} } finally { busy = 0; } } setTimeout(loop, on() ? EC.pollMs : EC.idleMs); };
  view(true); setTimeout(loop, 0);
  return { stop: () => { stopped = 1; }, _T: T, _st: () => st, tick };
}
