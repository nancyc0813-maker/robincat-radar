// 罗宾猫雷达 · NX-1103（Nancy 11/3）雷达视窗这边的新功能，集中在这个档，main.cjs 只接几个小钩子：
//  ① 铸造卡片的钱包统计（AI 钱包／一般钱包／总共、最近 1 小时新增、活跃）② 强制打进度（编号＋每个阶段）
//  ③ 挖矿清单（AI专属 ⛏ AI挖矿／一般代币 ⛏ 挖矿）：整理官方清单＋你自己加的，补「合约有没有验证」「奖励币池子多大」（只读）
//  ④ 每周检讨（产生／列出，全部本地算）⑤ 看盘：AVE 资料优先（链上读到的只当「链上即时」先显示）＋发射台筛选按钮照实际有币的平台自动产生
// 这个档只读资料、整理给画面看；不碰钱包、不下单、不会改你的买卖设定。
'use strict';
const fs = require('fs'), path = require('path');
let C = { ROOT: '', DATA: '', SET: '' };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const A40 = (a) => (/^0x[0-9a-fA-F]{40}$/.test(String(a || '')) ? String(a).toLowerCase() : '');
const HTTPS = (u) => (/^https:\/\/[^\s"'<>]{4,300}$/.test(String(u || '')) ? String(u) : '');
const fin = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/* ───── ③ 挖矿 ───── */
const KINDS = { interact: ['交互奖励', 'Interaction rewards'], stake: ['质押挖矿', 'Staking'], lp: ['LP 挖矿', 'LP mining'], checkin: ['每日签到', 'Daily check-in'], agent: ['AI 挖矿', 'AI mining'], other: ['其他', 'Other'] };
const CHAINS = { bsc: ['BNB Chain', 56], rh: ['Robinhood', 4663], eth: ['Ethereum', 1], base: ['Base', 8453], arb: ['Arbitrum', 42161], sol: ['Solana', 0], other: ['其他', 0] };
function riskFields(x) { /* ZR-INT-MINE：官方资料给的风险提醒（例如 DappBay 红色警报）。只显示、只提醒，不会拿掉项目，引擎也不看；没给＝什么都不加（不自己推测） */
  const r = x && typeof x.risk === 'object' && x.risk ? x.risk : null; const text = r ? String(r.text || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 200) : '';
  return { risk: text ? { src: String(r.src || '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40), level: ['red', 'yellow', 'info'].includes(r.level) ? r.level : '', text } : null, riskUrl: text ? HTTPS(x.riskUrl) : '' };
}
function mineFields(x) { /* 官方清单（remote.json mine[]）新增的栏位：全部白名单检查，格式不对就当没填 */
  x = x || {}; const o = {};
  o.id = String(x.id || '').replace(/[^\w.-]/g, '').slice(0, 40);
  o.scope = x.scope === 'gen' ? 'gen' : 'ai'; /* 没写 scope 的项目当成 AI 挖矿 */
  o.kind = KINDS[x.kind] ? x.kind : ''; o.cost = x.cost === 'free' || x.cost === 'deposit' ? x.cost : '';
  { const n = fin(x.costUsd); o.costUsd = n != null && n >= 0 && n < 1e6 ? n : null; }
  o.chain = CHAINS[x.chain] ? x.chain : ''; o.status = ['live', 'soon', 'ended'].includes(x.status) ? x.status : '';
  o.rewardTok = A40(x.rewardTok); o.approve = x.approve === 1 || x.approve === true ? 1 : x.approve === 0 || x.approve === false ? 0 : null;
  o.verified = x.verified === 1 || x.verified === true ? 1 : null;
  { const t = typeof x.startAt === 'number' ? x.startAt : Date.parse(String(x.startAt || '')); o.startAt = Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : null; } /* 选填：开始时间（ISO 字串、秒或毫秒都收），画面用来显示倒数；没填＝不显示 */
  Object.assign(o, riskFields(x)); /* ZR-INT-MINE */
  return o;
}
function mineNorm(x, src) { const url = HTTPS(x?.url); if (!url) return null; const f = mineFields(x); return { ...f, id: (src === 'mine' ? 'my:' : 'of:') + (f.id || url.slice(8, 120)), src, name: String(x.name || '').slice(0, 40) || url.replace(/^https:\/\//, '').slice(0, 30), url, note: String(x.note || '').slice(0, 160), c: A40(x.c), down: +x.down || 0, at: +x.at || 0 }; }
/* AGC-BACK：雷达学会「怎么挖、怎么领回」的项目（内建）。跟其他挖矿项目同一张清单、同一套筛选和提醒；
   差别只在雷达可以帮你挖 —— 开关和数字在「设定 → 更多设定 → ⛏ AGC 挖矿」由你自己填（预设关）。
   合约事实（每份押多少、多久能领回、有没有暂停、奖励币）由引擎从链上读、写 data/mine_adp.json，这里只拿来显示 */
const ADP = [{ adp: 'agc', id: 'agc', name: 'AGC', url: 'https://agcc.fun', scope: 'ai', kind: 'agent', cost: 'deposit', chain: 'bsc', c: '0x6288dfe86f22b53eeb6886ae2d78941de7483743', approve: 0,
  note: '押 BNB 换份数，到期领回 BNB＋AGC（钱包要有 Agent ID）。雷达学会了怎么挖、怎么领回：开关和份数在设定里由你填，预设关。',
  noteEn: 'Lock BNB for shares, then claim the BNB back plus AGC when due (the wallet needs an Agent ID). The radar knows how to mint and claim this one: the switch and share count are yours to set in Settings, off by default.',
  risk: { src: '', level: 'yellow', text: '押的 BNB 锁在项目合约里，到期才领得回；项目方可以暂停合约，暂停期间领不回也挖不了；AGC 价格可能大跌。只是提醒，挖不挖你自己决定。' },
  riskEn: 'The BNB you lock stays in the project contract until it is due; the project can pause the contract (no claiming or minting while paused); AGC can drop sharply. Just a notice — whether to mine is your call.' }];
function mineAdp() { const J = readJSON(path.join(C.DATA, 'mine_adp.json'), null); const out = [];
  const S40 = (x) => String(x ?? '').replace(/[\u0000-\u001f<>]/g, '').slice(0, 40); const WEI = (x) => (/^\d{1,40}$/.test(String(x ?? '')) ? String(x) : null);
  for (const a of ADP) { const m = mineNorm(a, 'adp'); if (!m) continue; m.id = 'ad:' + a.id; m.adp = a.adp; m.noteEn = a.noteEn; m.riskEn = a.riskEn;
    const v = J && J[a.adp] && typeof J[a.adp] === 'object' ? J[a.adp] : null; const f = v && v.facts && typeof v.facts === 'object' ? v.facts : null;
    if (f && A40(f.tok)) m.rewardTok = A40(f.tok);
    const known = !!f && Number.isFinite(f.until) && Number.isFinite(f.now); m.status = known ? (f.until > f.now ? '' : 'live') : ''; m.paused = known && f.until > f.now ? f.until * 1000 : 0;
    m.adpV = v ? { at: +J.at || 0, on: v.on ? 1 : 0, maxN: fin(v.maxN), price: f ? WEI(f.price) : null, delay: f ? fin(f.delay) : null,
      wallets: (Array.isArray(v.wallets) ? v.wallets : []).map((x) => ({ w: S40(x?.w), lockedWei: WEI(x?.lockedWei), lockedN: fin(x?.lockedN), due: fin(x?.due), nextAt: fin(x?.nextAt), today: fin(x?.today), why: S40(x?.why) })) } : null;
    out.push(m); }
  return out; }
let MI = null; const miF = () => path.join(C.DATA, 'mine_info.json');
function mineInfo() { if (!MI) MI = readJSON(miF(), { c: {}, t: {} }); return MI; }
function mineAll(v, set) {
  const I = mineInfo(); const out = [];
  for (const x of v?.remote?.mine || readJSON(path.join(C.DATA, 'remote.json'), {}).mine || []) { const m = mineNorm(x, 'official'); if (m) out.push(m); }
  try { for (const m of mineAdp()) out.push(m); } catch {} /* AGC-BACK */
  for (const x of Array.isArray(set?.['mine.my']) ? set['mine.my'] : []) { const m = mineNorm(x, 'mine'); if (m) { m.id = 'my:' + String(x.id || '').replace(/[^\w.-]/g, '').slice(0, 40); out.push(m); } }
  for (const m of out) { const ci = m.c ? I.c[m.chain + ':' + m.c] : null; if (m.verified !== 1 && ci?.v === true) m.verified = 1; m.vAt = ci?.at || null; const ti = m.rewardTok ? I.t[m.rewardTok] : null; m.pool = ti && ti.pool != null ? Math.round(ti.pool) : null; m.poolAt = ti?.at || null; }
  return out;
}
async function getJ(u) { const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } }); if (r.status === 404) return { _404: 1 }; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
const ENRICH_BUDGET = 6; let ENB = 0; async function mineEnrich() { /* 每轮最多查 ENRICH_BUDGET 个（网路量）；查过的有快取、下一轮轮到别的。只读公开资料，不影响买卖 */
  if (ENB) return; ENB = 1; try { const I = mineInfo(); const set = readJSON(C.SET, {}); const L = mineAll({ remote: readJSON(path.join(C.DATA, 'remote.json'), {}) }, set); let n = 0; const now = Date.now();
    for (const m of L) { if (n >= ENRICH_BUDGET) break;
      if (m.c && CHAINS[m.chain]?.[1] && m.chain !== 'rh') { const k = m.chain + ':' + m.c; if (!(I.c[k] && now - I.c[k].at < 1800e3)) { n++; try { const j = await getJ(`https://sourcify.dev/server/check-by-addresses?addresses=${m.c}&chainIds=${CHAINS[m.chain][1]}`); const r0 = Array.isArray(j) ? j[0] : null; I.c[k] = { v: r0 && (r0.status === 'perfect' || r0.status === 'partial' || (Array.isArray(r0.chainIds) && r0.chainIds.length)) ? true : null, at: now }; } catch { I.c[k] = { v: null, at: now - 1500e3 }; } } }
      if (m.rewardTok && n < ENRICH_BUDGET) { const k = m.rewardTok; if (!(I.t[k] && now - I.t[k].at < 1800e3)) { n++; try { const j = await getJ('https://api.dexscreener.com/latest/dex/tokens/' + k); const ps = Array.isArray(j?.pairs) ? j.pairs : []; I.t[k] = { pool: ps.length ? Math.max(...ps.map((p) => +p?.liquidity?.usd || 0)) : 0, at: now }; } catch { I.t[k] = { pool: null, at: now - 1500e3 }; } } }
    }
    if (n) { const keep = (o) => { for (const [k, x] of Object.entries(o)) if (now - (x.at || 0) > 7 * 86400e3) delete o[k]; }; keep(I.c); keep(I.t); fs.writeFileSync(miF(), JSON.stringify(I)); }
  } catch {} finally { ENB = 0; } }

/* ───── ⑤ 看盘：AVE 优先＋发射台筛选 ───── */
const PADN = { flap: 'Flap', genius: 'Genius', four: 'Four.meme', pons: 'Pons', long: 'Long', bankr: 'Bankr' };
const ALIAS = { fourmeme: 'four', four: 'four', flap: 'flap', flapsh: 'flap', genius: 'genius', pons: 'pons', long: 'long', bankr: 'bankr' };
const NOPAD = /^(pancake|pancakeswap|pancakev2|pancakev3|uniswap|uniswapv2|uniswapv3|uniswapv4|uni|biswap|thena|sushi|sushiswap|apeswap|babyswap|mdex|dex|v2|v3|v4|other|unknown|none|null)?$/;
const nk = (s) => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]/g, '').slice(0, 20);
function padOf(x, av) { /* 发射台：雷达自己链上认得的优先，其次 AVE 的 issue_platform；都没有＝直接在 DEX 开的新池 */
  if (PADN[x.plat]) return [x.plat, PADN[x.plat]];
  const n = nk(av?.pl); if (n && ALIAS[n]) return [ALIAS[n], PADN[ALIAS[n]]]; if (n && !NOPAD.test(n)) return ['p_' + n, String(av.pl).replace(/^https?:\/\//, '').slice(0, 16)];
  if (x.plat === 'other') return ['otherpad', '']; return ['new', ''];
}
const BORN_TOL = 120; const TFK = ['m1', 'm5', 'm15', 'h1', 'h6', 'h24']; const TFS = { m1: 60, m5: 300, m15: 900, h1: 3600, h6: 21600, h24: 86400 };
function aveItem(a, v, col) { const ca = +v.ca > 0 ? (+v.ca > 1e12 ? +v.ca : +v.ca * 1000) : null; /* CHAIN-1104 D12：AVE 的 created_at 可能是秒也可能是毫秒 */ const at = ca ?? (v.u || Date.now()); const o = { c: a, plat: '', sym: v.s || a.slice(0, 8), nm: v.n || '', at, dev: '', prog: v.pg ?? null, grad: col === 'done', gradAt: col === 'done' ? at : 0, pool: '', q: '', chg: {}, vol: {}, tx: {}, price: v.cp > 0 ? v.cp : null, mc: v.mc > 0 ? v.mc : null, liq: v.tvl > 0 ? v.tvl : null, /* CHAIN-1104 D8：读不到＝null（「—」），不是 $0 */ n: 0, curve: col !== 'done', src: 'ave', platAve: v.pl || '' }; return o; } /* 各时间段的数字：先用雷达自己的成交算（winFill），AVE 有的再盖过去 */
const KLN = require('./kline.cjs');
function winFill(x, raw) { /* NX-1103（Nancy 21:47）：AVE 没给的时间段，用雷达自己存的链上成交补算（不多花 AVE 额度） */
  if (raw && Array.isArray(raw.x?.tr) && raw.x.tr.length) { const tr = raw.x.tr, u = raw.u || 0, now = Date.now() / 1000, px = tr[tr.length - 1][3]; let lt = tr[0]; for (const q of tr) if (q[0] >= lt[0]) lt = q; const pxL = lt[3]; /* KQ-1104：最新一笔（照时间，不照顺序） */ x.la = x.la || tr[tr.length - 1][0] * 1000;
    for (const k of TFK) { if (x.tx?.[k] && x.vol?.[k] != null && x.chg?.[k] != null && x.src !== 'ave') continue; const R = tr.filter((q) => q[0] >= now - TFS[k]); let b = 0, s0 = 0, v = 0; const w = new Set(); for (const q of R) { q[1] ? b++ : s0++; v += q[2]; if (q[4]) w.add(q[4]); } x.tx[k] = { b, s: s0, u: w.size }; x.vol[k] = u > 0 ? Math.round(v * u) : x.vol[k] ?? null; if (x.chg[k] == null || x.src !== 'ave') { const wc = KLN.winChg(tr, now - TFS[k], pxL); x.chg[k] = wc ?? x.chg[k] ?? null; } /* KQ-1104：基准＝窗口开始前最后一笔；读不到＝null（「—」），不是 0 */ } x.winSrc = 'chain'; }
  for (const k of TFK) if (!x.tx[k]) { x.tx[k] = { b: 0, s: 0, u: 0 }; x.txUnk = 1; } }

/* PER-1103（Nancy）：看盘的时间段 1分 5分 15分 30分 1小时 4小时 24小时 7天。AVE 有的（5m=c5、1h=c1、24h=c24）用 AVE；
   其他用雷达自己读链存的成交算：基准＝窗口开始前最后一笔成交价；币在窗口内才出生、而且雷达从出生就有记录→用第一笔；
   都没有（例如雷达手上的成交记录不够早，看不到开头）→ null（画面显示「—」，不补假数字）。成交笔数／人数／成交量也补上新的时间段 */
const PERS = { m1: 60, m5: 300, m15: 900, m30: 1800, h1: 3600, h4: 14400, h24: 86400, d7: 604800 }; const PER_AVE = { m5: 'c5', h1: 'c1', h24: 'c24' };
function allChg(x, raw, v) { x.chg = x.chg || {}; x.tx = x.tx || {}; x.vol = x.vol || {}; const tr = raw && Array.isArray(raw.x?.tr) ? raw.x.tr : null; const now = Date.now() / 1000;
  let px = 0; if (tr) for (let i = tr.length - 1; i >= 0; i--) if (+tr[i][3] > 0) { px = +tr[i][3]; break; }
  const born = tr && tr.length && x.at > 0 && Math.abs(tr[0][0] - x.at / 1000) <= BORN_TOL; /* 雷达从出生就有成交记录（区块时间跟 AVE 的建立时间有误差，容许 BORN_TOL 秒） */
  for (const [k, s] of Object.entries(PERS)) {
    if (tr && tr.length && !['m1', 'm5', 'm15', 'h1', 'h6', 'h24'].includes(k)) { const R = tr.filter((q) => q[0] >= now - s); let b = 0, s0 = 0, vv = 0; const w = new Set(); for (const q of R) { q[1] ? b++ : s0++; vv += +q[2] || 0; if (q[4]) w.add(q[4]); } x.tx[k] = { b, s: s0, u: w.size }; x.vol[k] = raw.u > 0 ? Math.round(vv * raw.u) : null; }
    const ak = PER_AVE[k]; if (ak && v && v[ak] != null && isFinite(+v[ak])) { x.chg[k] = +v[ak]; continue; }
    if (!tr || !tr.length || !(px > 0)) { if (!(typeof x.chg[k] === 'number' && isFinite(x.chg[k]))) x.chg[k] = null; continue; } /* 没有本机成交：只留别的资料源真的给的数字（GeckoTerminal） */
    let base = 0; for (let i = tr.length - 1; i >= 0; i--) { const q = tr[i]; if (q[0] <= now - s && +q[3] > 0) { base = +q[3]; break; } }
    if (!base && born && x.at / 1000 >= now - s) { const f0 = tr.find((q) => +q[3] > 0); base = f0 ? +f0[3] : 0; }
    x.chg[k] = base > 0 ? (px / base - 1) * 100 : null; } }
function aveNums(x, v) { /* 显示的数字以 AVE 为准（有才盖过去） */
  if (v.cp > 0) x.price = v.cp; if (v.mc > 0) x.mc = v.mc; if (v.tvl > 0) x.liq = v.tvl; if (v.h != null) x.holders = v.h; if (v.pg != null) x.prog = v.pg;
  x.vol = x.vol || {}; x.chg = x.chg || {}; if (v.v5 != null) x.vol.m5 = Math.round(v.v5); if (v.v1 != null) x.vol.h1 = Math.round(v.v1); if (v.v24 != null) x.vol.h24 = Math.round(v.v24);
  if (v.c5 != null) x.chg.m5 = v.c5; if (v.c1 != null) x.chg.h1 = v.c1; if (v.c24 != null) x.chg.h24 = v.c24;
  const nn0 = (n) => (n != null && +n >= 0 ? +n : null); x.txN = { h1: nn0(v.tx1), h24: nn0(v.tx) }; /* CHAIN-1104 D12：笔数不会是负的，怪数字＝读不到 */ if (!x.nm && v.n) x.nm = v.n; if ((!x.sym || /^0x/.test(x.sym)) && v.s) x.sym = v.s; if (!x.img && /^https:\/\//.test(v.lg || '')) x.img = v.lg; x.platAve = v.pl || ''; x.src = 'ave';
}
let LSRC = null, LAVE = null; /* BOARD-V3：最近一次看盘用的读链模组和 AVE 资料（boardPage 往回读用） */
function board(net, r, A, SRC) { if (SRC) LSRC = SRC; if (A) LAVE = A; const soonPct = fin(readJSON(C.SET, {})?.['board.soonPct']); /* ZR-1103：进度几 % 以上放「即将发射」＝你的设定（没填＝只照 AVE 自己的分类） */
  try { if (!r || !Array.isArray(r.cols) || !r.cols.length) return r; const k = net === 'robinhood' ? 'rh' : 'bsc'; const M = A?.m?.[k] || {}; const AC = A?.cols || {}; const CA = A?.colsAt || {};
    const col = {}; for (const c of r.cols) col[c.k] = c; if (!col.fresh || !col.soon || !col.done) return r;
    const where = new Map(); for (const c of r.cols) for (const x of c.items || []) where.set(String(x.c).toLowerCase(), c.k);
    /* AVE 发射台清单：新创建／即将发射（快满）／已迁移 */
    const want = new Map(); const rank = { fresh: 1, soon: 2, done: 3 };
    for (const [tag, list] of Object.entries(AC)) { if (/^trend_/.test(tag) || !Array.isArray(list)) continue; if (CA[tag] && Date.now() - CA[tag] > 30 * 60e3) continue;
      for (const a0 of list) { const a = String(a0).toLowerCase(); const v = M[a]; if (!v) continue; const to = /_out_/.test(tag) ? 'done' : /_in_almost/.test(tag) ? 'soon' : /_in_hot/.test(tag) ? ((soonPct != null && v.pg != null && v.pg >= soonPct) || net === 'robinhood' ? 'soon' : 'fresh') : /_in_/.test(tag) ? 'fresh' : null; if (to && (!want.has(a) || rank[to] > rank[want.get(a)])) want.set(a, to); } }
    const aveSoon = [...want.values()].includes('soon'); /* UIFIX4：AVE 这次有没有给「快满」分类 */ let added = 0, moved = 0;
    for (const [a, to] of want) { const cur = where.get(a); if (cur === to) continue; if (cur) { const it = col[cur].items.find((x) => String(x.c).toLowerCase() === a); if (!it || (cur === 'done' && to !== 'done')) continue; col[cur].items = col[cur].items.filter((x) => x !== it); if (to === 'done') { it.grad = true; it.gradAt = it.gradAt || Date.now(); } col[to].items.push(it); moved++; } else { col[to].items.push(aveItem(a, M[a], to)); added++; } where.set(a, to); }
    const srcs = SRC ? (net === 'robinhood' ? [SRC.V4R] : [SRC.MK, SRC.V4B]) : []; const RAW = srcs.filter((S0) => S0?.raw).map((S0) => S0.raw()); const rawOf = (c) => { for (const R of RAW) { const x = R.tokens?.[c]; if (x) { let u = 0; try { u = R.usd(x) || 0; } catch {} return { x, u }; } } return null; };
    let chainOnly = 0; const seen = new Set(); for (const c of r.cols) for (const x of c.items) { if (seen.has(x)) continue; seen.add(x); x.chg = x.chg || {}; x.vol = x.vol || {}; x.tx = x.tx || {}; const a0 = String(x.c).toLowerCase(); const v = M[a0]; const rw = rawOf(a0); if (v || !x.tx.h1) winFill(x, rw); if (v) aveNums(x, v); else { x.src = x.src === 'ave' ? 'ave' : 'chain'; chainOnly++; } try { allChg(x, rw, v); } catch {} }
    col.fresh.items.sort((a, b) => (b.at || 0) - (a.at || 0)); col.soon.items.sort(net === 'robinhood' ? (a, b) => (b.vol?.h1 || 0) - (a.vol?.h1 || 0) : (a, b) => (b.prog || 0) - (a.prog || 0)); col.done.items.sort((a, b) => (b.gradAt || b.at || 0) - (a.gradAt || a.at || 0));
    /* ZR-1103：每一栏全部列出，不截 */
    r.aveSrc = { added, moved, chainOnly, at: A?.at || null };
    { /* NX-1103（Nancy 21:46）：栏位＝新创建｜即将发射｜🔥 热门内盘｜已发射（新外盘／热门外盘在画面切）；顺序由画面照你选的排序和时间段排 */
      const curve = []; const s2 = new Set(); for (const x of col.fresh.items.concat(col.soon.items)) if (!s2.has(x.c)) { s2.add(x.c); curve.push(x); }
      /* UIFIX4（老板 11/4）：即将发射 ① 你填了 board.soonPct → 进度 ≥ 你的门槛；② 没填、AVE 有给「快满」分类 → 照 AVE；③ 都没有 → 内盘（曲线）上有进度的全部放进来、进度最高的排前面（只是排名，不需要门槛数字；画面每栏取 BOARD_SHOW 个）。排序：有进度资料就照进度（Robinhood 也是），都没有才照近 1 小时成交量 */
      if (soonPct != null) col.soon.items = curve.filter((x) => x.prog != null && x.prog >= soonPct); else if (!aveSoon) col.soon.items = curve.filter((x) => x.prog != null && !x.grad);
      { const vh = (a, b) => (b.vol?.h1 || 0) - (a.vol?.h1 || 0); col.soon.items.sort(col.soon.items.some((x) => x.prog != null) ? (a, b) => ((b.prog ?? -1) - (a.prog ?? -1)) || vh(a, b) : vh); }
      col.soon.rank = soonPct != null || !aveSoon ? 1 : 0; /* UIFIX5：即将发射是从内盘算的（不是 AVE 分类）→ 画面让「即将发射」显示的币不再出现在「新创建」 */
      col.soon.zh = '🚀 即将发射'; col.soon.en = '🚀 About to launch'; col.done.zh = '✅ 已发射'; col.done.en = '✅ Launched'; col.fresh.zh = '🆕 新创建'; col.fresh.en = '🆕 New';
      /* BOARD-V2（11/4）：🔥 热门外盘＝已发射、在外盘交易的币，照近 1 小时成交热度排（笔数→成交量→最后成交）；只排序、不过滤、没有门槛数字；读不到（链上没记录、AVE 也没给）的排后面并标 heatUnk */
      const HW = 'h1'; const heat = (x) => { const tn = x.txN?.[HW]; const t = x.txUnk ? (tn != null && isFinite(+tn) ? +tn : null) : (x.tx?.[HW]?.b || 0) + (x.tx?.[HW]?.s || 0); const v0 = x.vol?.[HW]; const v = v0 != null && isFinite(+v0) ? +v0 : null; return { t, v, unk: t == null && v == null ? 1 : 0 }; };
      const dex = col.done.items.map((x) => { const h = heat(x); x.heatUnk = h.unk; return [x, h]; }).sort((p, q) => (p[1].unk - q[1].unk) || ((q[1].t || 0) - (p[1].t || 0)) || ((q[1].v || 0) - (p[1].v || 0)) || ((q[0].la || 0) - (p[0].la || 0))).map((p) => p[0]);
      r.cols = [col.fresh, col.soon, { k: 'hot', zh: '🔥 热门内盘', en: '🔥 Hot on curve', items: curve }, { k: 'hotdex', zh: '🔥 热门外盘', en: '🔥 Hot DEX', items: dex }, col.done]; }
  } catch {}
  try { plats(net, r); } catch {}
  return r;
}
function plats(net, r) { /* 发射台按钮：全部＋现在有币的平台（照币数排）＋其他发射台＋其他新池；新平台自动出现 */
  const cnt = new Map(), nm = new Map(); let tot = 0; const all = [...new Set(r.cols.flatMap((c) => c.items || []))]; /* 同一个币可能同时在「新创建」和「热门内盘」（BOARD-V2：或「已发射」和「热门外盘」），只算一次 */
  for (const x of all) { if (x.curve == null) x.curve = !x.grad && (x.plat === 'four' || x.plat === 'flap' || x.dex === 'four-meme'); const [pk, name] = padOf(x, { pl: x.platAve }); x.platK = pk; if (name) nm.set(pk, name); cnt.set(pk, (cnt.get(pk) || 0) + 1); tot++; }
  const named = [...cnt.entries()].filter(([k]) => k !== 'new' && k !== 'otherpad').sort((a, b) => b[1] - a[1]); const show = new Set(named.slice(0, 8).map(([k]) => k));
  let other = cnt.get('otherpad') || 0; for (const [k, n] of named) if (!show.has(k)) other += n;
  for (const x of all) { x.platN = nm.get(x.platK) || ''; x.plat = show.has(x.platK) ? x.platK : x.platK === 'new' ? 'new' : 'otherpad'; delete x.platK; }
  const P = [{ k: 'all', zh: '全部', en: 'All', n: tot }]; for (const [k, n] of named) if (show.has(k)) P.push({ k, zh: nm.get(k) || k, en: nm.get(k) || k, n });
  if (other) P.push({ k: 'otherpad', zh: '其他发射台', en: 'Other launchpads', n: other }); if (cnt.get('new')) P.push({ k: 'new', zh: '其他新池', en: 'Other new pools', n: cnt.get('new') });
  r.plats = P; return r;
}

/* ───── BOARD-V3（老板 11/4）：外盘两栏（热门外盘、已发射）往下滑到底 → 向链上往回读更早的一页；新创建不够时也用它补（新装好也立刻有）。
   读的是发射平台在链上的实际事件（建立／上外盘），跟雷达开多久无关；本机快取只是加速，不是资料的边界。只读公开节点＋DexScreener 公开行情，不碰钱包、不下单。
   cursor＝下一页从哪个区块往回读（画面原样送回来）；end＝已经读到链的开头。 ───── */
const PGS = {}; const PG_N = 20; /* 运作：一页最多几个币 */ const PG_CALLS = 8; /* 运作：一次最多查几段区块（网路量；不够一页就先回传，画面继续往前） */
const PG_SPAN = { bsc: 5000, robinhood: 20000 }; /* 运作：一段区块的起始大小（节点嫌大会自动减半、没东西会自动加倍） */ const PG_SPAN_MIN = 50, PG_SPAN_MAX = 200000; /* 运作：一段区块最小／最大 */
const DS_N = 30; /* 运作：DexScreener 一次查几个（它的上限） */
async function blkTs(R, n) { const b = await R('eth_getBlockByNumber', ['0x' + Math.max(0, n).toString(16), false]); return b && b.timestamp ? parseInt(b.timestamp, 16) * 1000 : null; }
async function dsFill(net, L) { const ch = net === 'robinhood' ? 'robinhood' : 'bsc'; const f = (v) => (v != null && v !== '' && isFinite(+v) ? +v : null);
  for (let i = 0; i < L.length; i += DS_N) { const part = L.slice(i, i + DS_N); try { const r = await fetch('https://api.dexscreener.com/tokens/v1/' + ch + '/' + part.map((x) => x.c).join(','), { signal: AbortSignal.timeout(12000) }); if (!r.ok) continue; const ps = await r.json(); const best = {};
    for (const p of Array.isArray(ps) ? ps : []) { const a = String(p?.baseToken?.address || '').toLowerCase(); const lq = f(p?.liquidity?.usd); if (!best[a] || (lq != null && (best[a].lq == null || lq > best[a].lq))) best[a] = { p, lq }; }
    for (const x of part) { const b = best[x.c]; if (!b) continue; const p = b.p;
      if (x.price == null) x.price = f(p.priceUsd); if (x.mc == null) x.mc = f(p.marketCap) ?? f(p.fdv); if (x.liq == null) x.liq = f(p.liquidity?.usd);
      for (const k of ['m5', 'h1', 'h24']) { if (x.vol[k] == null && f(p.volume?.[k]) != null) x.vol[k] = Math.round(+p.volume[k]); if (x.chg[k] == null && f(p.priceChange?.[k]) != null) x.chg[k] = +p.priceChange[k]; const t = p.txns?.[k]; if (t && f(t.buys) != null && f(t.sells) != null) { x.txN = x.txN || {}; if (x.txN[k] == null) x.txN[k] = +t.buys + +t.sells; } }
      if (!x.sym || /^0x/.test(x.sym)) x.sym = String(p.baseToken?.symbol || x.sym || '').slice(0, 24); if (!x.nm) x.nm = String(p.baseToken?.name || '').slice(0, 40); if (!x.img && /^https:\/\//.test(p.info?.imageUrl || '')) x.img = p.info.imageUrl; } } catch {} } }
async function boardPage(o) {
  const net = o.net === 'robinhood' || o.net === 'rh' ? 'robinhood' : 'bsc'; const kind = o.col === 'fresh' ? 'create' : o.col === 'done' || o.col === 'hotdex' ? 'grad' : '';
  if (!kind) return { err: '这一栏不用往回读' };
  const S = LSRC ? (net === 'robinhood' ? [LSRC.V4R] : [LSRC.MK, LSRC.V4B]).filter((s) => s && typeof s.older === 'function' && typeof s.rpc === 'function') : [];
  if (!S.length) return { err: '读链模组还没准备好，稍后再试' };
  const R = S[0].rpc; const st = (PGS[net] = PGS[net] || { span: PG_SPAN[net] });
  const head = parseInt(await R('eth_blockNumber', []), 16); if (!(head > 0)) return { err: '读不到最新区块' };
  let hi = Number.isFinite(+o.cursor) && +o.cursor > 0 ? Math.min(Math.floor(+o.cursor), head) : head;
  if (!(+o.cursor > 0) && +o.before > 0) { /* 第一页：从画面上最旧那个币的时间附近开始（往新的方向多留一半，宁可重复不要漏；画面会去掉重复） */
    try { const back = Math.min(head - 1, PG_SPAN_MAX); const ht = await blkTs(R, head), bt = await blkTs(R, head - back); const ms = ht && bt && ht > bt ? (ht - bt) / back : null; if (ms && ht > +o.before) hi = Math.max(1, head - Math.floor((ht - +o.before) / ms / 2)); } catch {} }
  const got0 = []; let calls = 0, lo = hi;
  while (got0.length < PG_N && calls < PG_CALLS && hi >= 0) {
    calls++; lo = Math.max(0, hi - st.span + 1); let got;
    try { got = (await Promise.all(S.map((s) => s.older(kind, lo, hi)))).flat(); }
    catch (e) { const m = String(e?.message || e); if (/limit|range|too many|exceed|results|size|block/i.test(m) && st.span > PG_SPAN_MIN) { st.span = Math.max(PG_SPAN_MIN, Math.floor(st.span / 2)); continue; } if (got0.length) break; return { err: '这一页读不到：' + m.slice(0, 80) }; }
    got0.push(...got); hi = lo - 1; if (!got.length && st.span < PG_SPAN_MAX) st.span = Math.min(PG_SPAN_MAX, st.span * 2); else if (got.length > PG_N && st.span > PG_SPAN_MIN) st.span = Math.max(PG_SPAN_MIN, Math.floor(st.span / 2)); }
  got0.sort((a, b) => b.blk - a.blk);
  if (got0.length > PG_N) { const cb = got0[PG_N - 1].blk; const k = got0.findIndex((e) => e.blk < cb); if (k > 0) { got0.length = k; hi = cb - 1; } } /* 一段读到太多：这页只给到第 PG_N 个所在的区块为止，游标接在后面（同一区块的不拆开，不会漏） */
  const seen = new Set(); const L = [];
  for (const e of got0) { const c = String(e?.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || seen.has(c)) continue; seen.add(c); L.push({ ...e, c }); }
  { /* 时间：节点有给区块时间就用；没给就用这一页头尾两个区块的真实时间内插 */ const need = L.filter((e) => !(e.ts > 0)); if (need.length) { const b1 = need[0].blk, b0 = need[need.length - 1].blk; const t1 = await blkTs(R, b1).catch(() => null); const t0 = b0 === b1 ? t1 : await blkTs(R, b0).catch(() => null); for (const e of need) e.ts = t1 && t0 ? (b1 === b0 ? t1 : t0 + ((e.blk - b0) * (t1 - t0)) / (b1 - b0)) : null; } }
  const M = LAVE?.m?.[net === 'robinhood' ? 'rh' : 'bsc'] || {}; const g = kind === 'grad';
  const items = L.map((e) => { const x = { c: e.c, plat: e.plat || '', sym: e.sym || '', nm: e.nm || '', at: g ? null : e.ts, dev: e.dev || '', prog: g ? 100 : null, grad: g, gradAt: g ? e.ts || 0 : 0, pool: e.pool || '', q: '', chg: {}, vol: {}, tx: {}, price: null, mc: null, liq: null, n: 0, curve: !g, src: 'chain', old: 1, txUnk: 1 }; const v = M[e.c]; if (v) { try { aveNums(x, v); } catch {} x.src = 'ave'; } return x; });
  await dsFill(net, items);
  for (const x of items) { x.tx = {}; x.txUnk = 1; const [pk, name] = padOf(x, { pl: x.platAve }); x.platN = name || ''; x.plat = PADN[pk] ? pk : pk === 'new' ? 'new' : 'otherpad'; }
  return { items, cursor: hi > 0 ? hi : 0, end: hi > 0 ? 0 : 1 }; }

/* ───── ① ② 看盘快照补资料 ───── */
function aug(v, S) {
  if (!v) return v; const set = readJSON(C.SET, {});
  for (const x of v.board || []) { const P = S?.paid?.[x.c]; if (!P) continue; const m = P.mw; if (m) x.mw = { ai: m.ai, gen: m.gen, unk: m.unk, tot: m.tot, n1: m.new1h, n1lb: m.new1hLb ?? null /*V104-NEW1HLB*/, n1r: m.new1hRaw, n1ai: m.new1hAi, w5: m.w5, w15: m.w15, w60: m.w60, at: m.at, why: m.why1h || '', part: m.part || 0, since: m.since }; x.agP = P.agents ?? null; x.agN = P.agNow ?? null; x.agT = P.agTrunc ? 1 : 0; /* AGN-1103 */ x.agAt = P.agNowAt || null; if (P.soldOut) x.soldOut = 1; if (/^0x[0-9a-fA-F]{40}$/.test(String(P.tok || ''))) x.tok = String(P.tok).toLowerCase(); /* AI-BOARD5：铸出来的代币地址（看开盘用） */ }
  { const F = readJSON(path.join(C.DATA, 'force_status.json'), null); v.forceStat = F && Array.isArray(F.list) ? F.list.slice(-8).reverse() : []; }
  try { const L = mineAll(v, set); v.mineL = { ai: L.filter((m) => m.scope === 'ai'), gen: L.filter((m) => m.scope === 'gen') }; } catch { v.mineL = { ai: [], gen: [] }; }
  try { const d = path.join(C.DATA, 'weekly'); if (fs.existsSync(d)) { const f = fs.readdirSync(d).filter((x) => /^\d{4}-\d{2}-\d{2}(-\d{2})?\.json$/.test(x)).sort().pop(); if (f) { const j = readJSON(path.join(d, f), null); if (j) v.weeklyLast = { at: j.at, auto: j.auto ? 1 : 0, f }; } } } catch {}
  try { const SN = readJSON(path.join(C.DATA, 'sentinel.json'), null); /* SEN-1103：🛡 安全哨兵 — 提醒清单、项目标签、假币不算持仓价值 */ if (SN) { v.sentinel = { at: SN.at, on: SN.on || {}, st: SN.st || {}, n: SN.n, q: SN.q, alerts: Array.isArray(SN.alerts) ? SN.alerts : [] }; const lab = SN.proj || {}, fk = SN.fake || {};
    for (const x of v.board || []) { const L = lab['bsc:' + x.c]; if (L && L.length) x.note = '🛡 ' + L.join('、') + (x.note ? ' · ' + x.note : ''); }
    for (const h of v.hold || []) { const k = (h.chain === 'rh' ? 'rh:' : 'bsc:') + String(h.addr).toLowerCase(); const L = lab[k]; if (L && L.length) h.sw = L.join('、'); if (fk[k]) { h.sw = '可能是假币／地址投毒'; h.fake = 1; h.value = null; } } } } catch {}
  try { const Y = readJSON(path.join(C.DATA, 'elysium.json'), null); v.ely = Y && typeof Y === 'object' && !Array.isArray(Y) ? Y : null; } catch { v.ely = null; } /* ELY107：🌐 Elysium（只看） */
  return v;
}

/* ───── UIFIX4：引擎起不来时，画面要显示原因 → 读引擎主控台日志（data/watch_console.log）结尾，找最后一个错误，分类成白话（只读） ───── */
const ENG_TAIL = 16384; /* 技术用：读日志结尾多少位元组 */
function engErr() { const f = path.join(C.DATA, 'watch_console.log'); let st; try { st = fs.statSync(f); } catch { return { code: 'nolog' }; }
  let b = Buffer.alloc(0); try { const n = Math.min(st.size, ENG_TAIL); b = Buffer.alloc(n); const fd = fs.openSync(f, 'r'); fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd); } catch {}
  let txt = b.toString('utf8'); if (/\uFFFD/.test(txt)) { try { txt = new TextDecoder('gbk').decode(b); } catch {} } /* Windows 命令列的中文错误是 GBK */
  const L = txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); const RE = /Error|ERR_|Cannot find|not recognized|不是内部或外部命令|command not found|not found|config\.json|Unexpected token|EACCES|EPERM|ENOSPC|ENOENT|EADDRINUSE|UIFIX4/;
  let i = L.length - 1; while (i >= 0 && !RE.test(L[i])) i--; if (i < 0) return { code: 'none', at: st.mtimeMs };
  const raw = L[i].replace(/[\u0000-\u001f]/g, ' ').slice(0, 200); const near = L.slice(Math.max(0, i - 3), i + 2).join(' ');
  let code = 'other', arg = ''; let m;
  if (/UIFIX4：还没有钱包|UIFIX4：没有 config\.json/.test(raw)) code = 'nowallet';
  else if ((m = /Cannot find module '([^']+)'/.exec(near))) { code = 'module'; arg = path.basename(m[1]).slice(0, 60); }
  else if (/config\.json/.test(near) && /JSON|Unexpected|position/.test(near)) code = 'config';
  else if (/not recognized|不是内部或外部命令|command not found|node: not found/.test(near)) code = 'node';
  else if (/SyntaxError|Unexpected token/.test(near)) code = 'syntax';
  else if (/EACCES|EPERM/.test(near)) code = 'perm';
  else if (/ENOSPC/.test(near)) code = 'disk';
  return { code, arg, raw, at: st.mtimeMs }; }

/* ───── AI-BOARD5（老板 11/4）：AI专属铸造看盘。热门开盘／已开盘／已铸完往下捲 → 向雷达已有的铸造项目历史（watch_state＋radar_hist）往回读一页；
   代币查 DexScreener 公开行情（有交易对＝已开盘）、NFT／Robinhood 进度读链上 totalSupply ÷ maxSupply（读不到＝null，画面写读不到）。只读，不碰钱包、不下单 ───── */
const MB_PG = 20; /* 运作：一页看几个铸造项目 */ const MB_PROG_TTL = 60e3; /* 运作：链上进度快取多久 */ const MB_PROG_N = 40; /* 运作：一次最多读几个合约的进度 */
const MBP = new Map(); const MB_MAX = ['0xd5abeb01', '0x32cb6b0c', '0x355274ea']; /* maxSupply()／MAX_SUPPLY()／cap() 的函式选择码 */
function mbRpc(net) { const S = LSRC ? (net === 'rh' ? [LSRC.V4R] : [LSRC.MK, LSRC.V4B]).filter((s) => s && typeof s.rpc === 'function') : []; return S[0] ? S[0].rpc : null; }
async function mbProgOne(R, c) { const h = MBP.get(c); if (h && Date.now() - h.at < MB_PROG_TTL) return h.p;
  const q = async (d) => { try { const r = await R('eth_call', [{ to: c, data: d }, 'latest']); return typeof r === 'string' && /^0x[0-9a-fA-F]{64}/.test(r) ? BigInt(r.slice(0, 66)) : null; } catch { return null; } };
  const tot = await q('0x18160ddd'); let mx = null; if (tot != null) for (const d of MB_MAX) { const v = await q(d); if (v != null && v > 0n) { mx = v; break; } }
  const p = tot != null && mx != null ? Math.min(100, Number((tot * 10000n) / mx) / 100) : null; MBP.set(c, { at: Date.now(), p }); if (MBP.size > 3000) MBP.delete(MBP.keys().next().value); return p; }
async function mintProg(o) { const net = o.net === 'rh' ? 'rh' : 'bsc'; const R = mbRpc(net); if (!R) return { err: '读链模组还没准备好，稍后再试' }; const cs = (Array.isArray(o.cs) ? o.cs : []).map(A40).filter(Boolean).slice(0, MB_PROG_N); const p = {}; await Promise.all(cs.map(async (c) => { p[c] = await mbProgOne(R, c); })); return { p }; }
function mbCands(net, kind) { const S = readJSON(path.join(C.DATA, 'watch_state.json'), {}) || {}; const H = readJSON(path.join(C.DATA, 'radar_hist.json'), {}) || {}; const out = new Map();
  const add = (c, o) => { c = A40(c); if (!c || out.has(c)) return; out.set(c, { c, ...o }); }; const dn = (D) => (D && typeof D === 'object' && Object.keys(D).length ? 1 : 0);
  if (net === 'bsc' && kind === 'tok') for (const [c, Pp] of Object.entries(S.paid || {})) add(c, { tok: A40(Pp.tok), name: String(Pp.name || '').slice(0, 40), at: +Pp.at || 0, prog: Pp.progress > 0 ? Math.round(Pp.progress * 100) : null /*V104-CAPSANE：读不到＝不显示百分比*/, done: Object.values(Pp.done || {}).some((x) => x === 'minted' || x === 'free') ? 1 : 0 });
  if (net === 'bsc' && kind === 'nft') for (const [c, M] of Object.entries(S.bscNft?.m || {})) add(c, { name: String(M.name || M.sym || '').slice(0, 40), at: +M.first || 0, done: dn(M.done) });
  if (net === 'rh') for (const [c, M] of Object.entries(S.rh?.mint || {})) if (!!M.nft === (kind === 'nft')) add(c, { name: String(M.name || M.sym || '').slice(0, 40), at: +M.first || 0, done: dn(M.done) });
  const pre = net === 'rh' ? 'rh:' : kind === 'nft' ? 'nft:' : 'bsc:'; if (!(net === 'rh' && kind === 'nft')) for (const [k, a] of Object.entries(H)) if (k.startsWith(pre) && Array.isArray(a) && a.length) add(k.slice(pre.length), { name: '', at: +a[0]?.t || 0, hist: 1 });
  return [...out.values()].sort((a, b) => b.at - a.at); }
async function mintPage(o) { const net = o.net === 'rh' ? 'rh' : 'bsc'; const kind = o.kind === 'nft' ? 'nft' : 'tok'; const L = mbCands(net, kind); const i0 = Number.isFinite(+o.cursor) && +o.cursor > 0 ? Math.floor(+o.cursor) : 0; const part = L.slice(i0, i0 + MB_PG); const nxt = i0 + part.length; const end = nxt >= L.length ? 1 : 0;
  if (kind === 'tok') { const ch = net === 'rh' ? 'robinhood' : 'bsc'; const items = part.map((x) => ({ ...x, q: x.tok || x.c })); let ok = 0, er = '';
    for (let i = 0; i < items.length; i += DS_N) { const Q = items.slice(i, i + DS_N); try { const r = await fetch('https://api.dexscreener.com/tokens/v1/' + ch + '/' + Q.map((x) => x.q).join(','), { signal: AbortSignal.timeout(12000) }); if (!r.ok) { er = 'DexScreener ' + r.status; continue; } const ps = await r.json(); ok++; const best = {};
      for (const p of Array.isArray(ps) ? ps : []) { const a = String(p?.baseToken?.address || '').toLowerCase(); const lq = fin(p?.liquidity?.usd); if (!best[a] || (lq != null && (best[a].lq == null || lq > best[a].lq))) best[a] = { p, lq }; }
      for (const x of Q) { const b = best[x.q]; if (!b) continue; const p = b.p; x.opened = 1; x.pair = A40(p.pairAddress); x.dex = String(p.dexId || '').slice(0, 20); x.pairAt = fin(p.pairCreatedAt); x.price = fin(p.priceUsd); x.mc = fin(p.marketCap) ?? fin(p.fdv); x.liq = fin(p.liquidity?.usd); x.vol = { h1: fin(p.volume?.h1), h24: fin(p.volume?.h24) }; x.chg = { h1: fin(p.priceChange?.h1), h24: fin(p.priceChange?.h24) }; const t = p.txns?.h24; x.tx24 = t && fin(t.buys) != null && fin(t.sells) != null ? +t.buys + +t.sells : null; if (!x.name) x.name = String(p.baseToken?.symbol || p.baseToken?.name || '').slice(0, 40); if (/^https:\/\//.test(p.info?.imageUrl || '')) x.img = String(p.info.imageUrl).slice(0, 300); } } catch (e) { er = String(e?.message || e).slice(0, 80); } }
    if (items.length && !ok) return { err: '这一页读不到：' + (er || 'DexScreener 没回应') };
    return { items: items.filter((x) => x.opened), cursor: nxt, end }; }
  const R = mbRpc(net); if (!R) return { err: '读链模组还没准备好，稍后再试' };
  const items = []; for (const x of part) { const p = await mbProgOne(R, x.c); if (p != null && p >= 100) items.push({ ...x, prog: p }); } /* 进度满＝已铸完 */
  return { items, cursor: nxt, end }; }

/* ───── ④ 每周检讨 ───── */
async function weeklyMod() { const { pathToFileURL } = require('url'); return import(pathToFileURL(path.join(C.ROOT, 'weekly.mjs')).href); }
const SEN_PAGE = 100; /* SEN-1103：记录一次读几则（分页大小，运作用） */
async function nx(a, o = {}) {
  if (a === 'weeklyList') { const W = await weeklyMod(); return W.listWeekly(C.ROOT); }
  if (a === 'weeklyMake') { const W = await weeklyMod(); const S = readJSON(path.join(C.DATA, 'watch_state.json'), {}); const R = W.buildWeekly({ DIR: C.ROOT, S, now: Date.now() }); R.auto = 0; const d = new Date(); const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}`; fs.mkdirSync(path.join(C.DATA, 'weekly'), { recursive: true }); fs.writeFileSync(path.join(C.DATA, 'weekly', key + '.json'), JSON.stringify(R)); return R; }
  if (a === 'btSave') { const r = o?.r || {}; const p = o?.p || {}; const keep = { at: Date.now(), net: String(p.net || ''), params: Object.fromEntries(Object.entries(p).filter(([k, x]) => /^[a-zA-Z]{1,12}$/.test(k) && (typeof x === 'number' || (typeof x === 'string' && x.length < 30)))), n: +r.n || 0, done: +r.done || 0, win: +r.win || 0, rate: fin(r.rate), pnl: fin(r.pnl), spent: fin(r.spent) }; fs.writeFileSync(path.join(C.DATA, 'backtest_last.json'), JSON.stringify(keep)); return true; }
  if (a === 'sentHist') { /* SEN-1103：全部提醒记录，一页一页读（只读） */ const f = path.join(C.DATA, 'sentinel.jsonl'); if (!fs.existsSync(f)) return { list: [], total: 0 }; const L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); const sk = Number.isFinite(+o?.skip) && +o.skip > 0 ? Math.floor(+o.skip) : 0; const end = Math.max(L.length - sk, 0); const part = L.slice(Math.max(end - SEN_PAGE, 0), end).reverse().map((x) => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean); return { list: part, total: L.length }; }
  if (a === 'sentNote') { if (o?.k === 'phone') { try { fs.appendFileSync(path.join(C.DATA, 'sentinel_in.jsonl'), JSON.stringify({ k: 'phone', n: Number(o.n) || 0, at: Date.now() }) + '\n'); } catch {} } return true; } /* SEN-1103：画面看到手机在线数变多 → 交给引擎（你开了才提醒） */
  if (a === 'mineEnrich') { await mineEnrich(); return true; }
  if (a === 'boardPage') return boardPage(o && typeof o === 'object' ? o : {}); /* BOARD-V3 */
  if (a === 'engErr') return engErr(); /* UIFIX4 */
  if (a === 'mintPage') return mintPage(o && typeof o === 'object' ? o : {}); /* AI-BOARD5 */
  if (a === 'mintProg') return mintProg(o && typeof o === 'object' ? o : {}); /* AI-BOARD5 */
  return null;
}
function install({ ipcMain, ROOT, DATA, SET }) { C = { ROOT, DATA, SET }; try { ipcMain.handle('nx', (e, a, o) => nx(String(a || ''), o).catch((er) => ({ err: String(er?.message || er).slice(0, 120) }))); } catch {} setTimeout(() => mineEnrich().catch(() => {}), 8e3); setInterval(() => mineEnrich().catch(() => {}), 60e3).unref?.(); }
module.exports = { install, aug, board, plats, mineFields, riskFields, mineNorm, padOf, _setC: (c) => { C = c; MI = null; } };
