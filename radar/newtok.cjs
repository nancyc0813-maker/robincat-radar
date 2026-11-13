'use strict';
/* NEWTOK-1113 新币秒级资料层（照 GMGN／Axiom 新币栏）：AVE 的发射台清单只能照成交额／TVL 排（AVE 官方 data-api-doc），WebSocket 也只有价格／成交／K 线，
   Solana／Base 的新币要晚好几分钟才进清单。用户 11/13 同意加资料来源（由主线转达）：
   ① Solana：PumpPortal 公开即时推送 wss://pumpportal.fun/api/data（官方文件 https://pumpportal.fun/data-api/real-time：subscribeNewToken／subscribeMigration 免费、不用金钥；
      「PLEASE ONLY USE ONE WEBSOCKET CONNECTION AT A TIME」，一直开很多条会被暂时封锁）。整个雷达只开这一条，两个订阅走同一条。
   ② Base：自己读链（跟 Robinhood 的 v4.cjs 同一套做法：公开节点 eth_getLogs 轮询），盯
      Clanker v4 工厂 TokenCreated（地址：github.com/clanker-devco/v4-contracts README「Base Mainnet v4.0 Clanker」；事件：同仓库 src/interfaces/IClanker.sol）
      Doppler Airlock Create／Migrate（地址：github.com/whetstoneresearch/doppler deployments/8453.md「Airlock」；事件：同仓库 src/Airlock.sol；Bankr 用 Doppler 发币）。
   规则：只读、不下单、不送任何使用者资料；有人在看那条链的看盘才连／才读，闲置就停；断线／出错照「指数退避＋随机」重试（Google SRE 书〈Handling Overload〉）；
   读不到就照旧只用 AVE 清单（这里只是「加」新币，不会把 AVE 的币拿掉）。收到的币只放进「新开盘」，上外盘事件只拿来记「上外盘时间」。 */
const RP = require('./rpcpool.cjs');
const URL_PP = 'wss://pumpportal.fun/api/data';
const T = { idleMs: 300e3, keep: 300, back0: 1e3, backMax: 120e3, stableMs: 30e3, silentMs: 300e3, ageMax: 3600, basePollMs: 2500, baseSpan: 20000, baseProbe: 1000 }; /* 技术用：多久没人看就停、每条链最多记几个新币、重连等待（起始／上限）、连线撑多久才算稳（才把等待归零）、连着却多久没任何讯息就重连、新币留几秒、Base 多久读一次链、一次 eth_getLogs 最多几块（节点上限 50000，实测见回报）、量出块速度时往回看几块 */
const okMint = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));
const okEvm = (a) => /^0x[0-9a-f]{40}$/.test(String(a || ''));
const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>"'`]/g, '').trim().slice(0, n);
const jitter = (back) => back / 2 + Math.random() * back / 2; /* 退避＋随机：等待时间在 back 的一半到全部之间随机，很多台电脑同时断线也不会同一秒一起重连 */
const nextBack = (b) => Math.min(T.backMax, b ? b * 2 : T.back0);
const nowS = () => Math.floor(Date.now() / 1000); /* 技术用：毫秒换秒 */
function mkStore() { return { list: new Map(), migr: new Map(), n: 0, mig: 0 }; }
function keepN(M) { while (M.size > T.keep) M.delete(M.keys().next().value); }
const ST = { solana: mkStore(), base: mkStore() };

/* ── Solana：PumpPortal（一条连线） ── */
const S = { ws: null, st: 'off', want: 0, err: '', back: 0, timer: null, connAt: 0, msgAt: 0, okAt: 0, wd: null };
const PP_PL = { pump: 'pump.fun', bonk: 'letsbonk.fun' }; /* PumpPortal 的 pool 栏位 → 发射台名称（画面短名会变成 Pump／Letsbonk） */
function ppMsg(t) { let j; try { j = JSON.parse(t); } catch { return; } S.msgAt = Date.now(); if (!j || typeof j !== 'object') return; const Z = ST.solana;
  if (j.txType === 'create' && okMint(j.mint)) { if (Z.list.has(j.mint)) return; const now = Date.now(); const pool = txt(j.pool, 20);
    Z.list.set(j.mint, { c: j.mint, s: txt(j.symbol, 20), n: txt(j.name, 40), at: now, ca: Math.floor(now / 1000), /* PumpPortal 没给区块时间，用收到的时间（实测比区块时间晚约 1 秒，见回报） */ mcSol: Number.isFinite(+j.marketCapSol) ? +j.marketCapSol : null, dev: okMint(j.traderPublicKey) ? j.traderPublicKey : '', pl: PP_PL[pool] || pool || 'pump.fun' });
    Z.n++; keepN(Z.list); return; }
  if (j.txType === 'migrate' && okMint(j.mint)) { Z.mig++; if (!Z.migr.has(j.mint)) Z.migr.set(j.mint, nowS()); keepN(Z.migr); } }
function ppOpen() { if (S.ws || !S.want) return; S.st = 'conn'; S.connAt = Date.now();
  S.ws = RP.wsOpen(URL_PP, { onOpen: () => { S.st = 'on'; S.err = ''; S.okAt = Date.now(); S.msgAt = Date.now(); try { S.ws.send(JSON.stringify({ method: 'subscribeNewToken' })); S.ws.send(JSON.stringify({ method: 'subscribeMigration' })); } catch {} },
    onMsg: ppMsg, onClose: (why) => { const up = S.okAt && Date.now() - S.okAt; S.ws = null; S.st = 'off'; S.okAt = 0; S.err = String(why || '').slice(0, 60); if (!S.want) return;
      S.back = up >= T.stableMs ? T.back0 : nextBack(S.back); /* 连上又马上被关（例如被暂时封锁）＝等待照样加倍，不会狂连 */ clearTimeout(S.timer); S.timer = setTimeout(ppOpen, jitter(S.back)); } }); }
function ppClose() { S.want = 0; clearTimeout(S.timer); clearInterval(S.wd); S.wd = null; if (S.ws) { try { S.ws.close(); } catch {} S.ws = null; } S.st = 'off'; }
function ppWatch() { if (S.st === 'on' && Date.now() - S.msgAt > T.silentMs && S.ws) { try { S.ws.close(); } catch {} } } /* 连着却很久没任何讯息（半开的连线）→ 关掉，onClose 会照退避重连 */

/* ── Base：读链（Clanker v4 工厂＋Doppler Airlock） ── */
const BASE = {
  clanker: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', airlock: '0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12',
  tCreated: '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67', /* keccak256("TokenCreated(address,address,address,string,string,string,string,string,int24,address,bytes32,address,address,address,uint256,address[])") */
  tCreate: '0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab', /* keccak256("Create(address,address,address,address)") */
  tMigrate: '0x2a05bb717043f3a794e94382bf63f2e275ecafc41be9b63c34f16d58da9822ca', /* keccak256("Migrate(address,address)") */
};
const B = { st: 'off', want: 0, err: '', last: 0, back: 0, timer: null, busy: 0, okAt: 0, bts: new Map(), blkMs: 0 };
const W = (d, i) => d.slice(2 + 64 * i, 2 + 64 * (i + 1));
const A = (w) => '0x' + String(w).slice(-40).toLowerCase();
function S_(d, i, n) { try { const off = Number(BigInt('0x' + W(d, i))) * 2; const len = Number(BigInt('0x' + d.slice(2 + off, 2 + off + 64))); return txt(Buffer.from(d.slice(2 + off + 64, 2 + off + 64 + len * 2), 'hex').toString('utf8'), n); } catch { return ''; } }
const rpc = (m, p) => RP.rpc('base', m, p, 12000);
async function blkTs(hex) { if (B.bts.has(hex)) return B.bts.get(hex); const b = await rpc('eth_getBlockByNumber', [hex, false]); const t = parseInt(b?.timestamp, 16); if (!(t > 0)) throw new Error('no ts'); B.bts.set(hex, t); if (B.bts.size > T.keep) B.bts.delete(B.bts.keys().next().value); return t; }
async function erc20Str(addr, sel) { try { const r = await rpc('eth_call', [{ to: addr, data: sel }, 'latest']); return r && r.length >= 130 ? S_(r, 0, 40) : ''; } catch { return ''; } } /* symbol()=0x95d89b41、name()=0x06fdde03（ERC-20 标准） */
async function baseLog(l) { const Z = ST.base; const t0 = l.topics?.[0], a = String(l.address || '').toLowerCase();
  if (a === BASE.clanker && t0 === BASE.tCreated) { const c = A(l.topics[1]); if (!okEvm(c) || Z.list.has(c)) return; const ctx = S_(l.data, 5, 200); let pl = 'clanker'; try { if (/^bankr$/i.test(String(JSON.parse(ctx)?.interface || ''))) pl = 'bankr'; } catch {} /* Clanker 自己的索引（clanker.world）用 tokenContext 的 interface 分是哪个介面发的 */
    Z.list.set(c, { c, s: S_(l.data, 3, 20), n: S_(l.data, 2, 40), at: Date.now(), ca: await blkTs(l.blockNumber), dev: A(W(l.data, 0)), pl }); Z.n++; keepN(Z.list); return; }
  if (a === BASE.airlock && t0 === BASE.tCreate) { const c = A(W(l.data, 0)); if (!okEvm(c) || Z.list.has(c)) return; const [s, n] = await Promise.all([erc20Str(c, '0x95d89b41'), erc20Str(c, '0x06fdde03')]);
    Z.list.set(c, { c, s, n, at: Date.now(), ca: await blkTs(l.blockNumber), dev: '', pl: 'doppler' }); Z.n++; keepN(Z.list); return; }
  if (a === BASE.airlock && t0 === BASE.tMigrate) { const c = A(l.topics[1]); if (!okEvm(c)) return; Z.mig++; if (!Z.migr.has(c)) Z.migr.set(c, await blkTs(l.blockNumber).catch(() => nowS())); keepN(Z.migr); } }
async function baseTick() { if (!B.want || B.busy) return; B.busy = 1; let wait = T.basePollMs;
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); if (!(head > 0)) throw new Error('head');
    if (!B.blkMs) { const [h1, h0] = await Promise.all([blkTs('0x' + head.toString(16)), blkTs('0x' + (head - T.baseProbe).toString(16))]); B.blkMs = Math.max(1, ((h1 - h0) * 1000) / T.baseProbe); } /* Base 出块速度用链上实测（11/13 量到约 200 毫秒一块，不写死） */
    const back = Math.min(T.baseSpan * 2, Math.ceil((T.ageMax * 1000) / B.blkMs)); /* 第一次／停很久再开：只补「新币留几秒」那么久 */
    let from = B.last ? B.last + 1 : head - back; if (head - from > back) from = head - back;
    while (from <= head) { const to = Math.min(head, from + T.baseSpan - 1);
      const L = await rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), address: [BASE.clanker, BASE.airlock], topics: [[BASE.tCreated, BASE.tCreate, BASE.tMigrate]] }]);
      for (const l of Array.isArray(L) ? L : []) { if (l.removed) continue; await baseLog(l); } B.last = to; from = to + 1; }
    B.st = 'on'; B.err = ''; B.back = 0; B.okAt = Date.now(); }
  catch (e) { B.st = 'down'; B.err = String(e?.message || e).slice(0, 80); B.back = nextBack(B.back); wait = jitter(B.back); }
  finally { B.busy = 0; } clearTimeout(B.timer); if (B.want) B.timer = setTimeout(baseTick, wait); }
function baseClose() { B.want = 0; clearTimeout(B.timer); B.st = 'off'; }

/* ── 给主程式 ── */
const idle = {};
/* 多链看盘要这条链时叫一次：确保连着／读着；T.idleMs 内没人再要就停 */
function touch(ch = 'solana') { if (ch === 'solana') { S.want = 1; ppOpen(); if (!S.wd) S.wd = setInterval(ppWatch, T.stableMs); }
  else if (ch === 'base') { if (!B.want) { B.want = 1; baseTick(); } } else return;
  clearTimeout(idle[ch]); idle[ch] = setTimeout(() => (ch === 'solana' ? ppClose() : baseClose()), T.idleMs); }
const has = (ch) => !!ST[ch];
/* 现在资料来源是不是活的（活的才让主程式把 AVE 的同类清单放慢） */
function live(ch) { return ch === 'solana' ? S.st === 'on' : ch === 'base' ? B.st === 'on' && Date.now() - B.okAt < T.stableMs : false; }
/* 给看盘：最近的新币（新到旧），建立超过 ageMax 秒的不给 */
function fresh(ch = 'solana') { const Z = ST[ch]; if (!Z) return []; const now = nowS(); return [...Z.list.values()].filter((x) => now - x.ca < T.ageMax).sort((a, b) => b.ca - a.ca); }
function migrated(ch, m) { if (m === undefined) { m = ch; ch = 'solana'; } return ST[ch]?.migr.get(m) || null; }
function ver(ch) { const Z = ST[ch]; return Z ? Z.n + Z.mig : 0; }
/* 资料来源有涵盖到的 AVE 清单 tag（来源活着时，主程式把这些清单的背景补抓放慢；Bankr 走 Doppler 是第三方文件说的，没写进来） */
const COVER = { solana: ['pump_in_new'], base: ['clanker_in_new'] };
function covers(ch, tag) { return live(ch) && (COVER[ch] || []).includes(tag); }
function stat() { return { solana: { st: S.st, n: ST.solana.n, mig: ST.solana.mig, err: S.err, msgAt: S.msgAt, keep: ST.solana.list.size }, base: { st: B.st, n: ST.base.n, mig: ST.base.mig, err: B.err, last: B.last, keep: ST.base.list.size } }; }
function closeAll() { ppClose(); baseClose(); }
module.exports = { touch, has, live, fresh, migrated, ver, covers, stat, close: closeAll, _S: S, _B: B, _ST: ST, _ppMsg: ppMsg, _baseTick: baseTick };
