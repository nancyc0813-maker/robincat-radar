'use strict';
/* KOLFEED-1113 KOL／聪明钱即时动态（照 GMGN「KOL／聪明钱成交流」、AVE 交易纪录的 KOL／聪明钱筛选）：谁、买／卖、哪个币、多少钱、当时市值、现在市值。
   名单（主程式给）：AVE 持有人 new_tags 里的 KOL／聪明钱、AVE smart_wallet/list、雷达原有的官方 KOL 钱包清单。
   不用 AVE 轮询（address/tx 每个钱包每次约 100 单位）：
   ① EVM（BNB Chain／Base／Ethereum／Polygon／Arbitrum）：公开节点 WSS eth_subscribe logs，用 topics 只订「名单地址收到／送出」的 ERC-20 Transfer（一出块就推）；
      11/13 实测 publicnode 的 HTTP eth_getLogs 不带合约地址会被拒（"Please specify an address"），WSS 订阅可以、过滤正确。
   ② 没有公开 WSS 的链（Robinhood／X Layer／Monad／HyperEVM）：HTTP eth_getLogs 轮询，每次最多 T.span 块（rpc.xlayer.tech、rpc.monad.xyz 实测有区块范围上限）。
   ③ Solana：公开节点 WSS logsSubscribe（每个钱包一个订阅；api.mainnet-beta 实测订阅太多会被关线 → 最多 T.solMax 个），收到交易签名再 getTransaction 看代币余额变化。
      PumpPortal 的 subscribeAccountTrade 要每个玩家自己的 API key＋至少 0.02 SOL 的钱包、每万则 0.01 SOL（官方文件），所以不用。
   只读、不下单、不送任何使用者资料；有人在看讯号／总览才连，闲置 T.idleMs 就关；断线照指数退避＋随机重连。买／卖只认「名单钱包自己送出的交易」（别人硬塞进来的币不算）。 */
const RP = require('./rpcpool.cjs');
const T = { idleMs: 300e3, keep: 500, chunk: 200, evmMax: 1000, solMax: 90, pollMs: 3000, span: 99, settleMs: 600, txGapMs: 350, back0: 1e3, backMax: 120e3, stableMs: 30e3, listMs: 60e3, symMax: 3000, statSaveMs: 60e3, statTok: 300, statW: 3000 }; /* 技术用：闲置多久关、记几则、一个订阅几个地址（节点限制）、EVM 每条链最多看几个钱包、Solana 最多几个订阅（节点实测）、轮询间隔、一次几块（节点上限 100）、同一笔交易等几毫秒收齐、Solana 查交易间隔、重连等待起始／上限、连线多久算稳、名单多久重整、代币资讯快取几个 ；KFSTAT-1114：本机统计多久存一次档、每个钱包最多记几个币、最多记几个钱包 */
const TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; /* ERC-20 Transfer(address,address,uint256) */
const WSS = { bsc: 'wss://bsc-rpc.publicnode.com', base: 'wss://base-rpc.publicnode.com', eth: 'wss://ethereum-rpc.publicnode.com', polygon: 'wss://polygon-bor-rpc.publicnode.com', arbitrum: 'wss://arbitrum-one-rpc.publicnode.com' };
const HTTP = { bsc: 'https://bsc-rpc.publicnode.com', base: 'https://base-rpc.publicnode.com', eth: 'https://ethereum-rpc.publicnode.com', polygon: 'https://polygon-bor-rpc.publicnode.com', arbitrum: 'https://arbitrum-one-rpc.publicnode.com', robinhood: 'https://rpc.mainnet.chain.robinhood.com', xlayer: 'https://rpc.xlayer.tech', monad: 'https://rpc.monad.xyz', hyperevm: 'https://hyperliquid-rpc.publicnode.com', elysium: 'https://rpc.elysium.kinetiq.xyz' /*ELYKOL-1114 Kinetiq 官方公开节点，chainId 99901；11/14 实测 eth_getLogs 只带 topics 可用、出块很快、最新块只落后几秒*/ };
const POLL = ['robinhood', 'xlayer', 'monad', 'hyperevm', 'elysium'];
const SOL_WSS = 'wss://api.mainnet-beta.solana.com', SOL_HTTP = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com']; /* 查交易：第一个被限流就换第二个 */
/* pump.fun 内盘成交：程式日志里就有 TradeEvent（Anchor 事件：判别码＝sha256("event:TradeEvent") 前 8 位，后面 mint 32、sol_amount u64、token_amount u64、is_buy、user 32、timestamp i64），
   11/13 实测 10 秒 480 则交易通知解出 452 个 → 这种不用再查交易（公开节点 getTransaction 会被限流），其他 DEX 才查 */
const PUMP_EV = require('crypto').createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);
const B58A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(b) { let x = BigInt('0x' + (Buffer.from(b).toString('hex') || '0')), s = ''; while (x > 0n) { s = B58A[Number(x % 58n)] + s; x /= 58n; } for (const c of b) { if (c === 0) s = '1' + s; else break; } return s; }
function pumpTrades(logs) { const out = []; for (const l of Array.isArray(logs) ? logs : []) { if (typeof l !== 'string' || !l.startsWith('Program data: ')) continue; let b; try { b = Buffer.from(l.slice(14), 'base64'); } catch { continue; } if (b.length < 97 || !b.subarray(0, 8).equals(PUMP_EV)) continue; /* 技术用：TradeEvent 最短长度（8＋32＋8＋8＋1＋32＋8） */
  out.push({ mint: b58(b.subarray(8, 40)), sol: Number(b.readBigUInt64LE(40)) / 1e9, tok: Number(b.readBigUInt64LE(48)) / 1e6, buy: b[56] === 1, user: b58(b.subarray(57, 89)), ts: Number(b.readBigInt64LE(89)) }); } return out; } /* 技术用：lamports 换 SOL、pump.fun 代币 6 位小数 */
const SOL_BASE = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']); /* WSOL／USDC／USDT：不是「买的币」 */
const isBaseSym = (s) => /^(w?(sol|eth|bnb|okb|pol|matic|mon|hype)|usd[tcg1]|usdt0|usdc\.e|busd|dai|fdusd)$/i.test(String(s || '')); /* 技术用：基础币／稳定币代号（换来换去的钱，不是买的币） */
const pad = (a) => '0x' + String(a).toLowerCase().slice(2).padStart(64, '0');
const A = (w) => '0x' + String(w).slice(-40).toLowerCase();
const jitter = (b) => b / 2 + Math.random() * b / 2; const nextBack = (b) => Math.min(T.backMax, b ? b * 2 : T.back0);
let H = { getList: () => ({}), getPx: () => null, solUsd: () => null, baseUsd: () => null, statFile: '', log: () => {} }; /*KFSTAT-1114 baseUsd(链, 代号)＝基础币美金价（主程式给，读不到＝null）；statFile＝本机统计存档*/
const S = { want: 0, idle: null, list: {}, listAt: 0, listKey: '', ev: [], n: 0, ch: {}, sol: { st: 'off' }, seen: new Set() };
async function post(u, m, p) { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); if (j.error) throw new Error(String(j.error.message || 'rpc').slice(0, 80)); return j.result; }
const TOK = new Map(); /* 链|合约 → { sym, dec } */
async function tokInfo(ch, c) { const k = ch + '|' + c; if (TOK.has(k)) return TOK.get(k); const o = { sym: '', dec: null }; try { const [s, d] = await Promise.all([post(HTTP[ch], 'eth_call', [{ to: c, data: '0x95d89b41' }, 'latest']).catch(() => ''), post(HTTP[ch], 'eth_call', [{ to: c, data: '0x313ce567' }, 'latest']).catch(() => '')]); /* symbol()／decimals()（ERC-20 标准） */
  if (s && s.length >= 130) { const n = parseInt(s.slice(66, 130), 16); o.sym = Buffer.from(s.slice(130, 130 + n * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f<>]/g, '').slice(0, 20); } else if (s && s.length === 66) o.sym = Buffer.from(s.slice(2), 'hex').toString('utf8').replace(/[\u0000-\u001f<>]/g, '').slice(0, 20);
  if (d && d.length >= 66) { const v = parseInt(d.slice(-64), 16); if (Number.isFinite(v) && v >= 0 && v <= 36) o.dec = v; } } catch {} /* 技术用：小数位合理范围 */ TOK.set(k, o); if (TOK.size > T.symMax) TOK.delete(TOK.keys().next().value); return o; }
const BTS = new Map(); async function blkTs(ch, bn) { const k = ch + bn; if (BTS.has(k)) return BTS.get(k); const b = await post(HTTP[ch], 'eth_getBlockByNumber', [bn, false]).catch(() => null); const t = parseInt(b?.timestamp, 16) || 0; BTS.set(k, t); if (BTS.size > T.keep) BTS.delete(BTS.keys().next().value); return t; }
function push(e) { e.pt = Date.now(); /* 进到动态清单的时间（量延迟用） */ if (S.seen.has(e.h + '|' + e.c + '|' + e.side)) return; S.seen.add(e.h + '|' + e.c + '|' + e.side); if (S.seen.size > T.keep * 4) S.seen.delete(S.seen.values().next().value); S.ev.push(e); S.n++; if (S.ev.length > T.keep) S.ev.splice(0, S.ev.length - T.keep); try { stAdd(e); } catch {} } /* 同一笔交易同一个币同一方向只算一次（轮询重叠／重连补抓不会重复） */

/* ── EVM：同一笔交易的 Transfer 先收齐（T.settleMs），再判断名单钱包这笔是买还是卖 ── */
const PEND = new Map(); /* 链|tx → { ch, h, bn, rt, legs: [] } */
function onEvmLog(ch, l) { if (!l || l.removed || l.topics?.[0] !== TR || l.topics.length < 3) return; const k = ch + '|' + l.transactionHash; let p = PEND.get(k); if (!p) { p = { ch, h: l.transactionHash, bn: l.blockNumber, rt: Date.now(), legs: [] }; PEND.set(k, p); setTimeout(() => settle(k).catch(() => {}), T.settleMs); } p.legs.push({ c: String(l.address).toLowerCase(), from: A(l.topics[1]), to: A(l.topics[2]), v: l.data }); }
async function settle(k) { const p = PEND.get(k); PEND.delete(k); if (!p) return; const L = S.list[p.ch] || {}; const tx = await post(HTTP[p.ch], 'eth_getTransactionByHash', [p.h]).catch(() => null); const who = String(tx?.from || '').toLowerCase(); if (!L[who]) return; /* 不是名单钱包自己送的交易＝空投／别人转进来，不算 */
  const net = {}; for (const g of p.legs) { let v = 0n; try { v = BigInt(g.v && g.v !== '0x' ? g.v : '0x0'); } catch {} if (g.to === who) net[g.c] = (net[g.c] || 0n) + v; if (g.from === who) net[g.c] = (net[g.c] || 0n) - v; }
  const ts = await blkTs(p.ch, p.bn).catch(() => 0);
  /*KFSTAT-1114 这笔交易里换出去／换进来的基础币（WETH／USDC…）算成美金＝这笔的真实金额（照 GMGN／DexScreener 成交纪录：用对手币算金额）；只有一个非基础币有变化时才这样算，其他照旧用看盘价格*/
  const legs = []; let baseUsd = 0, baseSign = 0, baseOk = 1; for (const [c, v] of Object.entries(net)) { if (v === 0n) continue; const ti = await tokInfo(p.ch, c); if (isBaseSym(ti.sym)) { const u = H.baseUsd(p.ch, ti.sym); if (!(u > 0) || ti.dec == null) { baseOk = 0; continue; } baseUsd += (Number(v < 0n ? -v : v) / 10 ** ti.dec) * u; baseSign = baseSign || (v < 0n ? -1 : 1); if ((v < 0n ? -1 : 1) !== baseSign) baseOk = 0; continue; } legs.push([c, v, ti]); }
  for (const [c, v, ti] of legs) { const px = H.getPx(p.ch, c) || {}; const sym = px.sym || ti.sym; if (isBaseSym(sym)) continue;
    const amt = ti.dec == null ? null : Number(v < 0n ? -v : v) / 10 ** ti.dec; const viaBase = legs.length === 1 && baseOk && baseUsd > 0 && baseSign === (v > 0n ? -1 : 1); const usd = viaBase ? baseUsd : amt != null && +px.cp > 0 ? amt * +px.cp : null;
    push({ at: p.rt, ts: ts ? ts * 1000 : null, ch: p.ch, w: who, nm: L[who].nm, kind: L[who].kind, side: v > 0n ? 'buy' : 'sell', c, sym, amt, usd, usdSrc: viaBase ? 'tx' : usd != null ? 'px' : '', mc0: +px.mc > 0 ? +px.mc : null, h: p.h }); } }
function evmWs(ch) { const st = (S.ch[ch] = S.ch[ch] || { st: 'off', back: 0, okAt: 0, ws: null, key: '' }); const addrs = Object.keys(S.list[ch] || {}).filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, T.evmMax); if (!S.want || !addrs.length) { if (st.ws) try { st.ws.close(); } catch {} return; }
  const key = addrs.join(','); if (st.ws && st.key === key) return; if (st.ws) { st.key = ''; try { st.ws.close(); } catch {} return; } st.key = key; st.st = 'conn'; let rid = 1;
  st.ws = RP.wsOpen(WSS[ch], { onOpen: () => { st.st = 'on'; st.okAt = Date.now(); st.err = ''; for (let i = 0; i < addrs.length; i += T.chunk) { const P = addrs.slice(i, i + T.chunk).map(pad); st.ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'eth_subscribe', params: ['logs', { topics: [TR, null, P] }] })); st.ws.send(JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'eth_subscribe', params: ['logs', { topics: [TR, P] }] })); } },
    onMsg: (t) => { let j; try { j = JSON.parse(t); } catch { return; } if (j.error) { st.err = String(j.error.message || '').slice(0, 60); return; } if (j.method === 'eth_subscription') onEvmLog(ch, j.params?.result); },
    onClose: (why) => { const up = st.okAt ? Date.now() - st.okAt : 0; st.ws = null; st.st = 'off'; st.okAt = 0; st.err = String(why || '').slice(0, 60); if (!S.want) return; st.back = up >= T.stableMs || !st.key ? T.back0 : nextBack(st.back); setTimeout(() => evmWs(ch), jitter(st.back)); } }); }
async function evmPoll(ch) { const st = (S.ch[ch] = S.ch[ch] || { st: 'off', back: 0, last: 0, busy: 0 }); if (!S.want || st.busy) return; const addrs = Object.keys(S.list[ch] || {}).filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, T.evmMax); if (!addrs.length) return; st.busy = 1;
  try { const head = parseInt(await post(HTTP[ch], 'eth_blockNumber', []), 16); let from = st.last ? st.last + 1 : head; if (head - from > T.span) from = head - T.span; /* 太久没读：只补最近 T.span 块 */
    if (from <= head) { for (let i = 0; i < addrs.length; i += T.chunk) { const P = addrs.slice(i, i + T.chunk).map(pad); for (const topics of [[TR, null, P], [TR, P]]) { const L = await post(HTTP[ch], 'eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16), topics }]); for (const l of Array.isArray(L) ? L : []) onEvmLog(ch, l); } } st.last = head; }
    st.st = 'on'; st.err = ''; st.back = 0; }
  catch (e) { st.st = 'down'; st.err = String(e?.message || e).slice(0, 60); st.back = nextBack(st.back); } finally { st.busy = 0; }
  if (S.want) setTimeout(() => evmPoll(ch), st.back ? jitter(st.back) : T.pollMs); }

/* ── Solana ── */
const SQ = []; let sqBusy = 0;
async function solTx() { if (sqBusy) return; sqBusy = 1; try { while (SQ.length && S.want) { const { sig, w, rt } = SQ.shift(); const L = S.list.solana || {}; if (!L[w]) continue;
      let r = null; for (const u of SOL_HTTP) { r = await post(u, 'getTransaction', [sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed', encoding: 'json' }]).catch(() => null); if (r) break; } await new Promise((z) => setTimeout(z, T.txGapMs));
      if (!r || r.meta?.err) continue; const keys = (r.transaction?.message?.accountKeys || []).map((k) => (typeof k === 'string' ? k : k?.pubkey)).concat(r.meta?.loadedAddresses?.writable || [], r.meta?.loadedAddresses?.readonly || []); if (keys[0] !== w) continue; /* 只算钱包自己签的（第一个签名者） */
      const bal = (arr) => { const o = {}; for (const b of arr || []) if (b.owner === w && b.mint) o[b.mint] = (o[b.mint] || 0) + (+b.uiTokenAmount?.uiAmount || 0); return o; }; const pre = bal(r.meta.preTokenBalances), pst = bal(r.meta.postTokenBalances);
      const wi = keys.indexOf(w); const solD = wi >= 0 ? ((+r.meta.postBalances?.[wi] || 0) - (+r.meta.preBalances?.[wi] || 0)) / 1e9 : null; /* 技术用：lamports 换 SOL */
      for (const m of new Set([...Object.keys(pre), ...Object.keys(pst)])) { if (SOL_BASE.has(m)) continue; const d = (pst[m] || 0) - (pre[m] || 0); if (!d) continue; const px = H.getPx('solana', m) || {}; const su = H.solUsd();
        const usd = solD != null && su > 0 && Math.sign(solD) === -Math.sign(d) ? Math.abs(solD) * su : +px.cp > 0 ? Math.abs(d) * +px.cp : null;
        push({ at: rt, ts: r.blockTime ? r.blockTime * 1000 : null, ch: 'solana', w, nm: L[w].nm, kind: L[w].kind, side: d > 0 ? 'buy' : 'sell', c: m, sym: px.sym || '', amt: Math.abs(d), usd, mc0: +px.mc > 0 ? +px.mc : null, h: sig }); } } } finally { sqBusy = 0; } }
function solWs() { const st = S.sol; const W = Object.keys(S.list.solana || {}).slice(0, Math.max(0, T.solMax - (globalThis.SOLK_N || 0))); /*SOLK-1114 代币页的本机秒线占用的订阅从上限扣掉（共用同一个上限）*/ if (!S.want || !W.length) { if (st.ws) try { st.ws.close(); } catch {} return; } const key = W.join(','); if (st.ws && st.key === key) return; if (st.ws) { st.key = ''; try { st.ws.close(); } catch {} return; }
  st.key = key; st.st = 'conn'; const sub = new Map(); let rid = 1;
  st.ws = RP.wsOpen(SOL_WSS, { onOpen: () => { st.st = 'on'; st.okAt = Date.now(); for (const w of W) { const id = rid++; sub.set(id, w); st.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'logsSubscribe', params: [{ mentions: [w] }, { commitment: 'confirmed' }] })); } },
    onMsg: (t) => { let j; try { j = JSON.parse(t); } catch { return; } if (j.id && sub.has(j.id)) { if (j.result != null) sub.set('s' + j.result, sub.get(j.id)); return; } const v = j.params?.result?.value; const w = sub.get('s' + j.params?.subscription); if (!v || !w || v.err || !v.signature) return; const rt = Date.now(); const PT = pumpTrades(v.logs).filter((x) => x.user === w); if (PT.length) { const L = S.list.solana || {}; for (const x of PT) { const px = H.getPx('solana', x.mint) || {}; const su = H.solUsd(); push({ at: rt, ts: x.ts ? x.ts * 1000 : null, ch: 'solana', w, nm: L[w]?.nm || '', kind: L[w]?.kind || '', side: x.buy ? 'buy' : 'sell', c: x.mint, sym: px.sym || '', amt: x.tok, usd: su > 0 ? x.sol * su : +px.cp > 0 ? x.tok * +px.cp : null, mc0: +px.mc > 0 ? +px.mc : null, h: v.signature }); } return; } /* 技术用：秒换毫秒 */ SQ.push({ sig: v.signature, w, rt }); if (SQ.length > T.keep) SQ.shift(); solTx(); },
    onClose: (why) => { const up = st.okAt ? Date.now() - st.okAt : 0; st.ws = null; st.st = 'off'; st.okAt = 0; st.err = String(why || '').slice(0, 60); if (!S.want) return; st.back = up >= T.stableMs || !st.key ? T.back0 : nextBack(st.back); setTimeout(solWs, jitter(st.back)); } }); }

/* ── KFSTAT-1114 雷达本机统计（照 GMGN／AVE 钱包页「已实现盈亏、胜率」的算法：平均成本法）──
   AVE smart_wallet/list 在 Base／Ethereum 是空的（主线 11/14 实测）→ 用雷达自己看到的成交（名单＝官方 KOL＋AVE 持有人标签的 KOL／聪明钱＋AVE 聪明钱清单）在本机算：
   买＝成本加进去；卖＝卖到的美金 −（平均成本 × 卖出数量）＝已实现盈亏；卖出数量超过雷达看到买进的部分不算（成本不知道，不猜）。
   胜率＝有已实现盈亏的币里，赚钱的币占几成。金额读不到的成交不算（另外记几笔）。只是显示，不进任何买卖判断。 */
const ST = { w: {}, dirty: 0, at: 0, loaded: 0 }; /* 链|钱包 → { nm, kind, t: { 合约: { ba 买数量, bu 买美金, sa 卖数量（有成本的）, ru 已实现 } }, n 成交笔数, nx 金额读不到, ux 卖出没有成本, f, l } */
function stLoad() { if (ST.loaded || !H.statFile) return; ST.loaded = 1; try { const j = JSON.parse(require('fs').readFileSync(H.statFile, 'utf8')); if (j && typeof j.w === 'object') ST.w = j.w; } catch {} }
function stSave(force) { if (!H.statFile || !ST.dirty || (!force && Date.now() - ST.at < T.statSaveMs)) return; ST.at = Date.now(); ST.dirty = 0; try { const fs = require('fs'); const tmp = H.statFile + '.w' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ v: 1, w: ST.w })); fs.renameSync(tmp, H.statFile); } catch {} }
function stAdd(e) { stLoad(); const k = e.ch + '|' + e.w; const W = (ST.w[k] = ST.w[k] || { nm: '', kind: e.kind, t: {}, n: 0, nx: 0, ux: 0, f: e.at, l: e.at }); if (e.nm) W.nm = e.nm; W.kind = e.kind || W.kind; W.n++; W.l = e.at; ST.dirty = 1;
  if (!(e.usd > 0) || !(e.amt > 0)) { W.nx++; return; } if (e.side !== 'buy' && !W.t[e.c]) { W.ux++; return; } const P = (W.t[e.c] = W.t[e.c] || { ba: 0, bu: 0, sa: 0, ru: 0, s: e.sym || '' }); if (e.sym) P.s = e.sym;
  if (e.side === 'buy') { P.ba += e.amt; P.bu += e.usd; } else { const held = P.ba - P.sa; if (!(held > 0)) { W.ux++; return; } const q = Math.min(e.amt, held); const avg = P.bu / P.ba; P.ru += e.usd * (q / e.amt) - avg * q; P.sa += q; if (q < e.amt) W.ux++; }
  const ks = Object.keys(W.t); if (ks.length > T.statTok) delete W.t[ks[0]]; const kw = Object.keys(ST.w); if (kw.length > T.statW) delete ST.w[kw[0]]; stSave(); }
/* 给画面：这条链每个钱包的已实现盈亏、胜率（照已实现盈亏排；读不到的不显示） */
function wstats(ch) { stLoad(); const out = []; for (const [k, W] of Object.entries(ST.w)) { if (!k.startsWith(ch + '|')) continue; let pnl = 0, win = 0, n = 0, bu = 0; for (const P of Object.values(W.t)) { bu += P.bu; if (P.sa > 0) { n++; pnl += P.ru; if (P.ru > 0) win++; } }
    out.push({ a: k.slice(ch.length + 1), nm: W.nm, kind: W.kind, pnl: n ? pnl : null, win: n ? (win / n) * 100 : null, closed: n, tok: Object.keys(W.t).length, buyUsd: bu, trades: W.n, nx: W.nx, ux: W.ux, f: W.f, l: W.l }); }
  return out.sort((x, y) => (y.pnl ?? -Infinity) - (x.pnl ?? -Infinity)); }

/* ── 给主程式 ── */
function refresh() { try { const L = H.getList() || {}; const key = Object.entries(L).map(([ch, m]) => ch + ':' + Object.keys(m).length).join('|') + '|' + Object.values(L).map((m) => Object.keys(m).join(',')).join('|').length; S.list = L; S.listAt = Date.now(); if (key === S.listKey) return; S.listKey = key; } catch {} for (const ch of Object.keys(WSS)) evmWs(ch); solWs(); }
let pollOn = 0, listT = null;
function touch() { const first = !S.want; S.want = 1; if (first) { refresh(); clearInterval(listT); listT = setInterval(refresh, T.listMs); if (!pollOn) { pollOn = 1; for (const ch of POLL) evmPoll(ch); } } clearTimeout(S.idle); S.idle = setTimeout(stop, T.idleMs); }
function stop() { stSave(1); S.want = 0; pollOn = 0; clearInterval(listT); for (const st of Object.values(S.ch)) if (st.ws) try { st.ws.close(); } catch {} if (S.sol.ws) try { S.sol.ws.close(); } catch {} }
/* 最近的动态（新到旧），附现在市值；市值／价格只来自主程式给的看盘资料，读不到＝null（画面不显示） */
function feed(n) { return S.ev.slice(-(n || T.keep)).reverse().map((e) => { const px = H.getPx(e.ch, e.c) || {}; return { ...e, sym: e.sym || px.sym || '', mc: +px.mc > 0 ? +px.mc : null }; }); }
function stat() { const o = { want: S.want, n: S.n, list: Object.fromEntries(Object.entries(S.list).map(([k, m]) => [k, Object.keys(m).length])), ch: {} }; for (const [k, st] of Object.entries(S.ch)) o.ch[k] = { st: st.st, err: st.err || '' }; o.ch.solana = { st: S.sol.st, err: S.sol.err || '' }; return o; }
function install(h) { H = { ...H, ...h }; }
module.exports = { pumpTrades, install, touch, stop, feed, stat, wstats, saveStats: () => stSave(1), _S: S, _ST: ST, _stAdd: stAdd, _onEvmLog: onEvmLog, T };
