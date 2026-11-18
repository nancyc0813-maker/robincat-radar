'use strict';
/* GTLIM-1114 GeckoTerminal 共用限速（用户 11/14 同意「没有办法连接数据的想辦法突破」，由主线转达）：
   GeckoTerminal 免金钥公开 API 每个 IP 大约每分钟 30 次（官方 https://www.geckoterminal.com/dex-api：付费版「from 30 calls/min to 500 calls/min」）。
   整个雷达（同一台电脑同一个 IP）合计压在每分钟 20 次以内：雷达视窗（radar/main.cjs、klinehist、gtmkt）共用一个桶 T.mainPerMin，
   引擎（watch.mjs／rh.mjs，另一个程序）另一个桶 T.engPerMin，两个加起来＝20。
   令牌桶：最多存 T.cap 个、照每分钟额度慢慢补；背景抓（bg）要留 T.fgKeep 个给画面正在等的（K 线、排行），不会把画面卡住。
   被回 429 → 整个桶停一阵（指数退避＋随机，起始 T.cool0、上限 T.coolMax；Google SRE 书〈Handling Overload〉），成功一次就归零。
   只读、不带任何使用者资料。 */
const T = { mainPerMin: 15, engPerMin: 5, cap: 3, fgKeep: 1, waitMs: 2500, priWaitMs: 15000, stepMs: 200, cool0: 20e3, coolMax: 300e3, toMs: 12000 }; /* 技术用：视窗／引擎每分钟几次（合计 20，低于官方约 30）、桶最多存几个、背景要留几个给画面、拿不到令牌最多等多久、多久看一次、429 后停多久（起始／上限）、逾时 */
const BASE = 'https://api.geckoterminal.com/api/v2/';
const jitter = (b) => b / 2 + Math.random() * b / 2;
function mk(perMin) {
  const refill = 60e3 / perMin; const B = { tok: T.cap, at: Date.now(), cool: 0, back: 0, n: 0, n429: 0, nDeny: 0, log: [] };
  function take(bg, pri) { const now = Date.now(); B.tok = Math.min(T.cap, B.tok + (now - B.at) / refill); B.at = now; if (now < B.cool) return false; if (B.tok < (pri ? 1 : 1 + T.fgKeep)) return false; B.tok -= 1; return true; } /*GTQ-1115 三级：使用者正在看的代币页 K 线（pri）可以拿最后一个令牌；其他画面（总览小图、排行）跟背景一样要留一个给它——打开代币页时 K 线不用排在小图后面*/
  async function token(bg, waitMs, pri) { const end = Date.now() + (waitMs == null ? (pri ? T.priWaitMs : T.waitMs) : waitMs); for (;;) { if (take(bg, pri)) return true; if (Date.now() >= end || (Date.now() < B.cool && !(pri && B.cool < end))) { B.nDeny++; return false; } await new Promise((r) => setTimeout(r, T.stepMs)); } } /*RV12-6 使用者正在看的 K 线（pri）排队等令牌（最多 T.priWaitMs，冷却会在这之前结束也照等），第一次打开不再直接回「资料来源忙」；其他照旧最多等 T.waitMs*/
  /* 读一个网址（networks/... 这种相对路径）。回 { st, j }；没令牌／冷却中 st＝'limit'，网路错 st＝'net' */
  async function get(path, o) { o = o || {}; if (!(await token(!!o.bg, o.waitMs, !!o.pri && !o.bg))) return { st: 'limit', j: null }; B.n++; const now = Date.now(); B.log.push(now); while (B.log.length && now - B.log[0] > 60e3) B.log.shift(); /* 技术用：记最近一分钟实际打了几次（自我检查用） */
    let r; try { r = await fetch(BASE + path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(T.toMs) }); } catch { return { st: 'net', j: null }; }
    if (r.status === 429) { B.n429++; B.back = B.back ? Math.min(T.coolMax, B.back * 2) : T.cool0; B.cool = Date.now() + jitter(B.back); return { st: 429, j: null }; }
    B.back = 0; if (!r.ok) return { st: r.status, j: null }; const j = await r.json().catch(() => null); return { st: j ? 200 : 'json', j }; }
  function stat() { const now = Date.now(); return { perMin, tokens: Math.floor(B.tok), cooling: B.cool > now ? Math.round((B.cool - now) / 1000) : 0, calls: B.n, lastMin: B.log.filter((t) => now - t <= 60e3).length, n429: B.n429, denied: B.nDeny }; }
  return { get, token, take, stat, _B: B };
}
let MAIN = null, ENG = null;
const main = () => MAIN || (MAIN = mk(T.mainPerMin));
const engine = () => ENG || (ENG = mk(T.engPerMin));
module.exports = { main, engine, mk, T, BASE };
