'use strict';
/* OKX-1113 OKX OnchainOS 行情 API（玩家自己的金钥，选填；只拿来显示，不影响买卖）。
   文件：https://web3.okx.com/onchainos/dev-docs/market/market-api-introduction
   - 基本级（Basic）：价格 /api/v6/dex/market/price、成交 /trades、K 线 /candles、代币资料 /token/basic-info
   - 进阶级（Premium）：行情统计 /price-info、持有人 /token/holder
   签名：OK-ACCESS-SIGN＝Base64(HMAC-SHA256(时间 ISO＋大写方法＋路径含查询字串＋body, secret))；另带 OK-ACCESS-KEY／OK-ACCESS-TIMESTAMP／OK-ACCESS-PASSPHRASE。
   每把金钥每月 Basic、Premium 各 10 万次免费，之后 OKX 会收费 → 本机记每月次数，到玩家设的上限（没填＝OKX_CAP_DEF）就停到下个月。
   金钥用 Electron safeStorage 加密存 data/okx_mkt_key.bin（这台电脑没有系统加密时存 data/okx_mkt_key.json，画面会标「本机保护较弱」）；金钥不回传画面、不写日志。
   ⚠️ 还没有用真的金钥测过（开发时没有金钥）：栏位名称全部照官方文件；holdPercent 的单位（% 或 0～1）文件没写，用整份加总判断。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://web3.okx.com';
const CHAIN = { bsc: '56', eth: '1', base: '8453', solana: '501' }; /* 技术用：OKX 链编号（Robinhood 等其他链开机后问 /supported/chain 才知道有没有） */
const OKX_CAP_DEF = 90000; /* 技术用：每月每一级最多几次（免费 10 万次的九成，防止被收费）；玩家可在设定改 okx.mkt.cap */
const OKX_TO_MS = 6000, OKX_RPS = 3; /* 技术用：每次最多等几毫秒／每秒最多问几次（OKX 没公布每把金钥的速度上限，保守一点） */
const TTL = { pinfo: 10e3, binfo: 24 * 3600e3, hold: 60e3, kl: 20e3, tr: 10e3, px: 5e3, chains: 24 * 3600e3 }; /* 技术用：各种资料快取多久 */

let DATA = '', SS = null, ZSET = () => ({});
let KEY = null, KEY_WEAK = false; const C = new Map(), INF = new Map(); const RQ = []; let LAST = { at: 0, err: '' }; let CHAINS = null;
function init({ DATA: d, safeStorage, zSet }) { DATA = d; SS = safeStorage || null; ZSET = zSet || ZSET; }
const KF = () => path.join(DATA, 'okx_mkt_key.bin'), KFW = () => path.join(DATA, 'okx_mkt_key.json'), UF = () => path.join(DATA, 'okx_mkt_usage.json');
function encOK() { try { return !!SS?.isEncryptionAvailable?.(); } catch { return false; } }
function loadKey() {
  if (KEY) return KEY;
  try { if (fs.existsSync(KF()) && encOK()) { KEY = JSON.parse(SS.decryptString(fs.readFileSync(KF()))); KEY_WEAK = false; return KEY; } } catch {}
  try { if (fs.existsSync(KFW())) { KEY = JSON.parse(fs.readFileSync(KFW(), 'utf8')); KEY_WEAK = true; return KEY; } } catch {}
  return null;
}
function saveKey(k, s, p) {
  k = String(k || '').trim(); s = String(s || '').trim(); p = String(p || '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(k)) return { err: 'key' }; if (!/^[A-Za-z0-9+/=_-]{8,200}$/.test(s)) return { err: 'secret' }; if (!p || p.length > 100 || /[\u0000-\u001f]/.test(p)) return { err: 'pass' };
  const o = JSON.stringify({ k, s, p });
  try { if (encOK()) { fs.writeFileSync(KF(), SS.encryptString(o)); try { fs.unlinkSync(KFW()); } catch {} KEY_WEAK = false; } else { fs.writeFileSync(KFW(), o, { mode: 0o600 }); KEY_WEAK = true; } } catch (e) { return { err: 'write' }; }
  KEY = { k, s, p }; C.clear(); CHAINS = null; return { ok: 1, weak: KEY_WEAK };
}
function clearKey() { KEY = null; C.clear(); for (const f of [KF(), KFW()]) try { fs.unlinkSync(f); } catch {} return { ok: 1 }; }
const monthOf = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7); /* 台湾时间的月份 */
function usage() { let u = {}; try { u = JSON.parse(fs.readFileSync(UF(), 'utf8')) || {}; } catch {} const mo = monthOf(); if (u.mo !== mo) u = { mo, basic: 0, premium: 0, prev: u.mo ? { mo: u.mo, basic: u.basic || 0, premium: u.premium || 0 } : u.prev }; return u; }
function cap() { const v = Number(ZSET()['okx.mkt.cap']); return ZSET()['okx.mkt.cap'] != null && ZSET()['okx.mkt.cap'] !== '' && Number.isFinite(v) && v >= 0 ? v : OKX_CAP_DEF; }
function on() { const z = ZSET(); return (z['okx.mkt.on'] === true || Number(z['okx.mkt.on']) === 1) && !!loadKey(); }
function chainId(net) { if (CHAIN[net]) return CHAIN[net]; const c = CHAINS?.v?.[net]; return c || ''; }
/* 能不能用这条链（有开、有金钥、OKX 支援这条链、这一级额度还没到上限） */
function ready(net, tier = 'basic') { if (!on()) return false; if (!chainId(net)) { if (net === 'robinhood') chainsLoad(); return false; } const u = usage(); return (u[tier] || 0) < cap(); }
async function slot() { for (;;) { const now = Date.now(); while (RQ.length && now - RQ[0] >= 1000) RQ.shift(); if (RQ.length < OKX_RPS) { RQ.push(now); return; } await new Promise((r) => setTimeout(r, 1000 - (now - RQ[0]) + 5)); } }
/* 送一次请求：先记次数（OKX 照呼叫次数算钱，失败的也可能算），到上限就不送 */
async function req(tier, method, pq, body) {
  const K = loadKey(); if (!K) return null; const u = usage(); if ((u[tier] || 0) >= cap()) { LAST = { at: Date.now(), err: 'cap:' + tier }; return null; }
  await slot(); u[tier] = (u[tier] || 0) + 1; u.at = Date.now(); try { fs.writeFileSync(UF(), JSON.stringify(u)); } catch {}
  const ts = new Date().toISOString(); const b = body == null ? '' : JSON.stringify(body);
  const sign = crypto.createHmac('sha256', K.s).update(ts + method + pq + b).digest('base64');
  try { const r = await fetch(BASE + pq, { method, headers: { 'OK-ACCESS-KEY': K.k, 'OK-ACCESS-SIGN': sign, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-PASSPHRASE': K.p, ...(b ? { 'Content-Type': 'application/json' } : {}) }, ...(b ? { body: b } : {}), signal: AbortSignal.timeout(OKX_TO_MS) });
    const j = await r.json().catch(() => null); if (!j || String(j.code) !== '0') { LAST = { at: Date.now(), err: String(j?.msg || j?.code || 'http ' + r.status).replace(/[\u0000-\u001f<>]/g, '').slice(0, 100) }; return null; }
    LAST = { at: Date.now(), err: '' }; return j.data; } catch (e) { LAST = { at: Date.now(), err: String(e?.name === 'TimeoutError' ? 'timeout' : e?.message || e).slice(0, 80) }; return null; }
}
/* 同一个请求快取＋同时只问一次 */
async function cached(k, ttl, fn) { const c = C.get(k); if (c && Date.now() - c.at < ttl) return c.v; if (INF.has(k)) return INF.get(k); const p = fn().then((v) => { if (v != null) { C.set(k, { at: Date.now(), v }); if (C.size > 500) C.delete(C.keys().next().value); } return v ?? c?.v ?? null; }).finally(() => INF.delete(k)); INF.set(k, p); return p; }
const A = (net, a) => (net === 'solana' ? String(a) : String(a).toLowerCase()); /* EVM 地址一律小写（文件规定） */
const N = (x) => { const v = Number(x); return x !== '' && x != null && Number.isFinite(v) ? v : null; };
let CH_BUSY = 0; function chainsLoad() { if (!on() || CH_BUSY || (CHAINS && Date.now() - CHAINS.at < TTL.chains)) return; CH_BUSY = 1; req('basic', 'GET', '/api/v6/dex/market/supported/chain', null).then((d) => { const v = {}; for (const x of Array.isArray(d) ? d : []) { const nm = String(x.chainName || x.chainSymbol || '').toLowerCase(); if (/robinhood/.test(nm) && x.chainIndex) v.robinhood = String(x.chainIndex); } CHAINS = { at: Date.now(), v }; }).finally(() => { CH_BUSY = 0; }); }

/* 详情页上方：价格／市值／涨跌／成交量／流动性／持有人（进阶级 price-info）＋名字／图示（基本级 basic-info，快取一天） */
async function pair(net, addr) {
  if (!ready(net, 'premium')) return null; const ci = chainId(net), a = A(net, addr), arg = [{ chainIndex: ci, tokenContractAddress: a }];
  const [pi, bi] = await Promise.all([cached('pi|' + ci + a, TTL.pinfo, () => req('premium', 'POST', '/api/v6/dex/market/price-info', arg)), ready(net, 'basic') ? cached('bi|' + ci + a, TTL.binfo, () => req('basic', 'POST', '/api/v6/dex/market/token/basic-info', arg)) : null]);
  const P = Array.isArray(pi) ? pi[0] : null; if (!P || N(P.price) == null) return null; const B = Array.isArray(bi) ? bi[0] || {} : {};
  const pairO = { addr: '', dex: '', base: { symbol: String(B.tokenSymbol || '').slice(0, 30), name: String(B.tokenName || '').slice(0, 60), address: a }, quote: { symbol: '' }, price: N(P.price), liq: N(P.liquidity), fdv: null, mcap: N(P.marketCap), chg: { m5: N(P.priceChange5M), h1: N(P.priceChange1H), h4: N(P.priceChange4H), h24: N(P.priceChange24H) }, txns: { h1: { buys: null, sells: null }, h24: { buys: null, sells: null } }, vol: { h1: N(P.volume1H), h4: N(P.volume4H), h24: N(P.volume24H) }, created: null, img: /^https:\/\//.test(B.tokenLogoUrl || '') ? String(B.tokenLogoUrl).slice(0, 300) : '', sites: [], socials: [], src: 'okx', at: N(P.time) };
  const ex = { holders: N(P.holders), hi24: N(P.maxPrice), lo24: N(P.minPrice), tx24: N(P.txs24H), tx1: N(P.txs1H), src: 'okx', at: Date.now() };
  return { pair: pairO, ex };
}
/* 持有人前 100（进阶级）：只算占比，跟 AVE 那份同样的格式（top1／top10／top100／n） */
async function holders(net, addr) {
  if (!ready(net, 'premium')) return null; const ci = chainId(net), a = A(net, addr);
  const d = await cached('ho|' + ci + a, TTL.hold, () => req('premium', 'GET', `/api/v6/dex/market/token/holder?chainIndex=${ci}&tokenContractAddress=${encodeURIComponent(a)}&limit=100`, null));
  const L = Array.isArray(d) ? d : []; if (!L.length) return null; const r = L.map((x) => N(x.holdPercent) || 0).sort((x, y) => y - x); const isPct = r.reduce((s, x) => s + x, 0) > 1.0001; const sum = (n) => +((isPct ? 1 : 100) * r.slice(0, n).reduce((s, x) => s + x, 0)).toFixed(1);
  return { top1: sum(1), top10: sum(10), top100: sum(100), n: L.length, src: 'okx', list: L.slice(0, 100).map((x) => ({ a: A(net, x.holderWalletAddress || ''), amt: N(x.holdAmount), pct: N(x.holdPercent) == null ? null : +(N(x.holdPercent) * (isPct ? 1 : 100)).toFixed(4), pnl: N(x.totalPnlUsd) })) };
}
/* K 线（基本级）：回传 [{t 毫秒, o,h,l,c, v 美金}]，旧到新 */
const BAR = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '3h': '1H', '6h': '6Hutc', '12h': '12Hutc', '1d': '1Dutc', '3d': '1Dutc', '1w': '1Wutc', '1M': '1Mutc' };
async function candles(net, addr, tf, beforeMs) {
  if (!ready(net, 'basic')) return null; const ci = chainId(net), a = A(net, addr), bar = BAR[tf] || '5m'; const lim = 299; /* 文件：一次最多 299 根 */
  const q = `/api/v6/dex/market/candles?chainIndex=${ci}&tokenContractAddress=${encodeURIComponent(a)}&bar=${bar}&limit=${lim}` + (beforeMs > 0 ? `&after=${Math.floor(beforeMs)}` : ''); /* 文件：after＝比这个时间更早的 */
  const d = await cached('kl|' + q, TTL.kl, () => req('basic', 'GET', q, null));
  return (Array.isArray(d) ? d : []).map((r) => ({ t: N(r[0]), o: N(r[1]), h: N(r[2]), l: N(r[3]), c: N(r[4]), v: N(r[6]) ?? 0 })).filter((x) => x.t > 0 && x.h > 0).sort((x, y) => x.t - y.t);
}
/* 成交（基本级）：回传成交明细列表要的格式 */
async function trades(net, addr) {
  if (!ready(net, 'basic')) return null; const ci = chainId(net), a = A(net, addr);
  const d = await cached('tr|' + ci + a, TTL.tr, () => req('basic', 'GET', `/api/v6/dex/market/trades?chainIndex=${ci}&tokenContractAddress=${encodeURIComponent(a)}&limit=60`, null));
  return (Array.isArray(d) ? d : []).map((x) => ({ k: 'okx:' + String(x.id || '').slice(-40), t: N(x.time) || 0, b: String(x.type) === 'buy' ? 1 : 0, usd: Math.round((N(x.volume) || 0) * 100) / 100, p: N(x.price), w: A(net, x.userAddress || ''), f: String(x.isFiltered) === '1' ? 1 : 0 })).filter((r) => r.t > 0);
}
function status() { const u = usage(); const K = loadKey(); return { has: !!K, weak: !!K && KEY_WEAK, on: on(), mo: u.mo, basic: u.basic || 0, premium: u.premium || 0, cap: cap(), prev: u.prev || null, lastErr: LAST.err, lastAt: LAST.at, chains: Object.keys(CHAIN).concat(Object.keys(CHAINS?.v || {})) }; }
module.exports = { init, saveKey, clearKey, status, ready, on, pair, holders, candles, trades, CHAIN };
