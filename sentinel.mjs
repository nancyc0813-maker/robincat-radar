// 罗宾猫雷达 · 🛡 安全哨兵（SEN-1103）
// 只看、只提醒：盯你的钱包、你持有／在打的项目、假币／地址投毒、显示资料验证。
// 不会挡单、不会自动取消授权、不会自动卖——要不要处理，由你自己按。
// 每一类都有自己的开关（全部预设关）；「多少才算」的数字全部由你在设定填，没填＝照说明（不比对或每一笔都提醒），程式里没有门槛。
// 提醒存在 data/sentinel.json（画面用的最近一页）和 data/sentinel.jsonl（全部记录，不删）；开了 sentinel.tg 才发 TG（只发给你自己，不发群）。
// 取消授权：只有你在「🛡 安全哨兵」按「去取消授权」并确认后，才用币安钱包的 approvals revoke 送出（只把对方的权限拿掉，不动你的币）。
// 查链上资料用雷达原本的多节点轮替（rpc／logsRpc）；节点出错＝这一段下一轮重查，不会跳过（画面显示「还在补查」）。
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const TP = {
  APPROVAL: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  APPROVAL_ALL: '0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31',
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  UPGRADED: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
  ADMIN: '0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f',
  BEACON: '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e',
  OWNER: '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0',
  PAUSED: '0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258',
  UNPAUSED: '0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa',
  ROLE: '0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d',
  P2PERMIT: '0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec',
  P2APPROVAL: '0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b',
  BURN: '0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496',
};
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'; /* EIP-1967 实作地址槽位 */
const SEL = { owner: '0x8da5cb5b', symbol: '0x95d89b41', name: '0x06fdde03', decimals: '0x313ce567', totalSupply: '0x18160ddd', getPair: '0xe6a43905' };
const MINT_GET = { '0xa035b1fe': 'price()', '0x6817c76c': 'mintPrice()', '0x13faede6': 'cost()', '0xd5abeb01': 'maxSupply()', '0x32cb6b0c': 'MAX_SUPPLY()', '0x355274ea': 'cap()' };
const PANCAKE_V2 = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const SIGN = { remote: '公告／手机转接站／推荐名单', xheat: 'X 热度', inv: '邀请排行／热门社群', bl: '官方黑名单', xw: 'X 帐号监测', aveboard: 'AVE 看盘资料' };
const ZERO = '0x' + '0'.repeat(40);
const MAX256 = (1n << 256n) - 1n, MAX160 = (1n << 160n) - 1n; /* ABI 的最大值＝「无限额度」 */
/* 运作常数：只影响多久查一次、一次查多少（节点额度），不影响提醒什么；没查完的排队下一轮继续 */
const PL = { loopMs: 60e3, firstMs: 20e3, apMs: 300e3, span: 2000, spans: 5, batch: 40, txBatch: 40, view: 300, keep: 5000, page: 100, word: 64 };

export function startSentinel(D) {
  const { DIR, S, save, WALLETS, rpc, logsRpc, log, tgSay, nOnce } = D;
  const NR = () => globalThis.NR;
  const on = (k) => { try { return !!NR()?.on(k); } catch { return false; } };
  const num = (k) => { try { const v = NR()?.num(k); return v == null || !Number.isFinite(+v) ? null : +v; } catch { return null; } };
  const F = join(DIR, 'data', 'sentinel.json'), FL = join(DIR, 'data', 'sentinel.jsonl'), FIN = join(DIR, 'data', 'sentinel_in.jsonl'), FSIG = join(DIR, 'data', 'sig_state.json'), FRM = join(DIR, 'data', 'remote.json');
  const lc = (x) => String(x || '').toLowerCase();
  const A40 = /^0x[0-9a-f]{40}$/;
  const pad = (a) => '0x' + lc(a).replace(/^0x/, '').padStart(PL.word, '0');
  const tAddr = (t) => '0x' + lc(t).substring(PL.word - 38);
  const word = (h, i) => { const s = String(h || '').replace(/^0x/, ''); const x = s.substring(i * PL.word, (i + 1) * PL.word); return x ? BigInt('0x' + x) : null; };
  const wAddr = (h, i) => { const v = word(h, i); return v == null ? '' : '0x' + v.toString(16).padStart(40, '0'); };
  const short = (a) => (A40.test(a) ? a.substring(0, 8) + '…' + a.substring(a.length - 6) : String(a || ''));
  const hx = (n) => '0x' + n.toString(16);
  const errT = (e) => String(e?.message || e || '').substring(0, 160);

  const SS = (S.sent = S.sent || {}); for (const k of ['cur', 'ap', 'apMark', 'ws', 'pj', 'mp', 'cp', 'keys', 'fake']) SS[k] = SS[k] || {}; SS.txq = SS.txq || []; SS.rh = SS.rh || []; SS.pend = Array.isArray(SS.pend) ? SS.pend : [];
  const FL_MAX = 8 * 1024 * 1024; /* 运作：提醒记录档的大小上限（位元组），只管磁碟空间 */
  let V = { alerts: [], n: 0 }; try { const o = JSON.parse(readFileSync(F, 'utf8')); if (Array.isArray(o.alerts)) V = { alerts: o.alerts, n: +o.n || o.alerts.length }; } catch {}
  const STT = { chains: {}, ap: '', err: '' };
  const radarHash = new Set(SS.rh); const radarTo = new Set();
  let sends = {}; const explained = {};

  /* 雷达自己送的交易：包住每个钱包的 baw，记下送出的交易编号（只读回传文字，不改任何参数） */
  const SEND = (a) => (a[0] === 'contract-call' && a[1] === 'execute') || (a[0] === 'market-order' && a[1] === 'swap') || (a[0] === 'approvals' && a[1] === 'revoke');
  const pendHit = (w, toks, h) => { const i = SS.pend.findIndex((p) => p.w === w && toks.some((t) => t && p.toks.includes(t))); if (i < 0) return false; SS.pend.splice(i, 1); if (h) { radarHash.add(h); SS.rh.push(h); } return true; }; /* C2：钱包＋代币对得上「结果不明的那笔」→ 用掉这笔记录，同一笔交易的其他事件也认得 */
  function wrapBaw() { for (const W of WALLETS) { if (!W.baw || W.baw._sent) continue; const o = W.baw; const nw = Object.assign(async (a, ...r) => { const res = await o(a, ...r); try { const unk = !res?.j?.success && (res?.timeout || /結果不明|结果不明|timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(String(res?.t || ''))); if (Array.isArray(a) && SEND(a) && (res?.j?.success || unk)) { const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? lc(a[i + 1]) : ''; }; const h0 = lc(res?.j?.data?.txHash || res?.j?.data?.hash || ''); const hs = /^0x[0-9a-f]{64}$/.test(h0) ? [h0] : res?.j?.success ? [...new Set(String(res.t || '').toLowerCase().match(/0x[0-9a-f]{64}/g) || [])] : []; for (const h of hs) { radarHash.add(h); SS.rh.push(h); } while (SS.rh.length > PL.keep) radarHash.delete(SS.rh.shift()); /* C1：只记你下单时的 --to（不再把回传文字里所有地址都当成雷达的） */ const to0 = arg('--to'); if (A40.test(to0)) radarTo.add(to0);
          if (!hs.length) { SS.pend.push({ w: W.addr, at: Date.now(), toks: [arg('--fromToken'), arg('--toToken'), to0].filter((x) => A40.test(x)) }); while (SS.pend.length > PL.keep) SS.pend.shift(); } /* C2：结果不明（或没拿到交易编号）的那笔先记下来，之后链上看到就认得是雷达送的 */
          const cid = arg('--binanceChainId'); const ck = (chains().find((c) => c.cid === cid) || chains()[0]).id + ':' + W.addr; sends[ck] = (sends[ck] || 0) + 1; /* C4：每条链分开算；一次下单算一笔 */ } } catch {} return res; }, o, { _sent: 1 }); W.baw = nw; } }

  const chains = () => { const L = [{ id: 'bsc', cid: '56', rpc, logs: (p) => logsRpc([p]), ex: 'https://bscscan.com' }]; const r = D.rhRpc?.(); if (typeof r === 'function') L.push({ id: 'rh', cid: '4663', rpc: r, logs: (p) => r('eth_getLogs', [p]), ex: 'https://explorer.chain.robinhood.com' }); return L; };
  const chOf = (id) => chains().find((c) => c.id === id);
  const txUrl = (ch, h) => `${ch.ex}/tx/${h}`, adUrl = (ch, a) => `${ch.ex}/address/${a}`;
  const wName = (a) => (WALLETS.find((w) => w.addr === lc(a)) || {}).name || short(a);

  /* 代币资讯（名称、小数位），只读 */
  const META = new Map();
  const str = (h) => { try { const s = String(h || '').replace(/^0x/, ''); if (!s) return ''; let b; if (s.length === PL.word) b = Buffer.from(s, 'hex'); else { const off = Number(word(s, 0)) * 2; const n = Number(BigInt('0x' + s.substring(off, off + PL.word))); b = Buffer.from(s.substring(off + PL.word, off + PL.word + n * 2), 'hex'); } return b.toString('utf8').replace(/\0+$/, '').trim(); } catch { return ''; } };
  const ecall = (ch, to, data) => ch.rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
  async function meta(ch, t) { const k = ch.id + ':' + t; if (META.has(k)) return META.get(k); const [s, n, d] = await Promise.all([ecall(ch, t, SEL.symbol), ecall(ch, t, SEL.name), ecall(ch, t, SEL.decimals)]); const m = { sym: str(s), name: str(n), dec: d && d !== '0x' ? Number(word(d, 0)) : null }; if (s != null || n != null) META.set(k, m); return m; }
  const amtTxt = (raw, dec) => { if (raw === MAX256 || raw === MAX160) return '无限额度'; if (dec == null) return raw.toString() + '（最小单位）'; const b = 10n ** BigInt(dec); const i = raw / b, f = (raw % b).toString().padStart(dec, '0').replace(/0+$/, ''); return i.toString() + (f ? '.' + f : ''); };

  /* 提醒：存档＋画面＋（开了 sentinel.tg 才）TG */
  function alert(a) {
    if (a.key) { if (SS.keys[a.key]) return null; SS.keys[a.key] = Date.now(); const ks = Object.keys(SS.keys); if (ks.length > PL.keep) for (const k of ks.slice(0, ks.length - PL.keep)) delete SS.keys[k]; }
    const x = { id: Date.now().toString(36) + Math.random().toString(36).substring(2, 7), at: Date.now(), ...a }; delete x.key;
    V.alerts.unshift(x); V.n++; while (V.alerts.length > PL.view) V.alerts.pop();
    try { if (statSync(FL).size > FL_MAX) renameSync(FL, FL + '.1'); } catch {} /* CHAIN-1104：提醒记录档太大就换新档（旧的留一份 .1），不会一直长大 */
    try { appendFileSync(FL, JSON.stringify(x) + '\n'); } catch {}
    log(`🛡 安全哨兵｜${x.title}${x.det ? '：' + x.det : ''}`);
    if (on('sentinel.tg') && !a.quiet) tgSay(`🛡 安全哨兵｜${x.title}\n${x.det || ''}${x.url ? '\n' + x.url : ''}${x.sug ? '\n建议：' + x.sug : ''}${x.rv?.length ? '\n到雷达「⚙️ 设定 → 🛡 安全哨兵」按「去取消授权」就能取消' /* NAV9 */ : ''}`).catch(() => {});
    return x;
  }
  function write() {
    const lab = {}; for (const a of V.alerts) if (a.p && a.lab && !a.rd) { (lab[a.p] = lab[a.p] || []); if (!lab[a.p].includes(a.lab)) lab[a.p].push(a.lab); }
    const o = { at: Date.now(), on: STT.on || {}, st: STT, n: V.n, alerts: V.alerts, proj: lab, fake: SS.fake, q: SS.txq.length };
    try { const t = F + '.w'; writeFileSync(t, JSON.stringify(o)); renameSync(t, F); } catch {}
  }

  /* 你持有／在打的项目（不挑、不截：全部都看） */
  function projects() {
    const m = new Map(); const add = (ch, c, why, name) => { c = lc(c); if (!A40.test(c)) return; const k = ch + ':' + c; if (!m.has(k)) m.set(k, { k, ch, c, why: new Set(), name: '' }); const o = m.get(k); o.why.add(why); if (name && !o.name) o.name = String(name).substring(0, 40); };
    for (const t of S.dyn || []) if (!t.closed) add('bsc', t.addr, 'hold', t.sym);
    for (const [c, P] of Object.entries(S.rh?.pos || {})) if (Object.values(P.w || {}).some((w) => !w.closed)) add('rh', c, 'hold', P.sym);
    for (const [c, P] of Object.entries(S.paid || {})) { const done = Object.values(P.done || {}).some((x) => x === 'minted' || x === 'free'); const going = P.pick?.data != null || (P.replay && P.nrJ?.buy); if (!done && !going) continue; add('bsc', c, 'mint', P.name); if (done && P.token) add('bsc', P.token, 'hold', P.name); }
    for (const [c, M] of Object.entries(S.rh?.mint || {})) if (M.done && Object.keys(M.done).length) add('rh', c, 'mint', M.name || M.sym);
    for (const [c, M] of Object.entries(S.bscNft?.m || {})) if (M.done && Object.keys(M.done).length) add('bsc', c, 'mint', M.name || M.sym);
    return [...m.values()];
  }
  const pjOf = (k) => (SS.pj[k] = SS.pj[k] || {});
  const insiders = (p) => { const o = pjOf(p.k); const dep = lc(S.deployer?.[p.c] || S.paid?.[p.c]?.deployer || ''); return new Set([o.owner, dep].filter((x) => A40.test(x) && x !== ZERO)); };
  const norm = (s) => String(s || '').normalize('NFKC').replace(/[\s​-‏⁠﻿]/g, '').toLowerCase();

  /* ① 你的钱包：授权清单比对（币安钱包的 approvals list） */
  async function approvalsDiff() {
    if (Date.now() - (SS.apAt || 0) < PL.apMs) return; SS.apAt = Date.now(); const bad = [];
    for (const W of WALLETS) {
      const r = await W.baw(['approvals', 'list', '--limit', String(PL.page)]).catch(() => null); if (!r?.j?.success) { bad.push(W.name); continue; }
      const cur = {}; for (const x of r.j?.data?.list || []) { const tok = lc(x.tokenContract), sp = lc(x.spender); if (!A40.test(tok) || !A40.test(sp)) continue; const cid = String(x.binanceChainId || x.chainId || '56'); cur[cid + ':' + tok + ':' + sp] = { cid, tok, sp, amt: String(x.amount ?? x.allowance ?? x.value ?? ''), sym: String(x.tokenSymbol || ''), spn: String(x.spenderName || x.spenderLabel || ''), type: String(x.type || 'approve') }; }
      const prev = SS.ap[W.addr]; if (prev && SS.txq.some((q) => (q.t === 'ap' || q.t === 'p2') && (q.tp?.[1] ? '0x' + lc(q.tp[1]).substring(PL.word - 38) : '') === W.addr)) { SS.apAt = 0; continue; } /* C3：这个钱包还有授权事件在排队 → 这轮先不比，下轮查完再比 */ SS.ap[W.addr] = cur; if (!prev) continue; /* 第一次只记下来 */
      for (const [k, x] of Object.entries(cur)) {
        const p = prev[k]; if (p && p.amt === x.amt) continue; const mk = W.addr + ':' + x.tok + ':' + x.sp; if (SS.apMark[mk]) { delete SS.apMark[mk]; continue; } /* 链上事件已经提醒过 */
        const inf = /unlimit|infinite|max/i.test(x.amt) || x.amt === MAX256.toString() || x.amt === MAX160.toString();
        alert({ cat: 'wallet', kind: p ? 'apChg' : 'apNew', ch: x.cid === '4663' ? 'rh' : 'bsc', w: W.addr, title: `[${W.name}] ${p ? '授权额度变了' : '多了一笔授权'}：${x.sym || short(x.tok)} → ${x.spn || short(x.sp)}`, det: `代币 ${x.tok}\n对方（spender）${x.sp}${x.spn ? '（' + x.spn + '）' : ''}\n额度 ${inf ? '⚠️ 无限额度' : x.amt || '读不到'}${p ? '（原本 ' + (p.amt || '读不到') + '）' : ''}\n拿到授权的合约可以随时转走你这个币（最多到额度）。如果不是你做的，请马上取消`, url: adUrl(chOf(x.cid === '4663' ? 'rh' : 'bsc') || chains()[0], x.sp), sug: '去取消授权', rv: [{ w: W.addr, cid: x.cid, tok: x.tok, sp: x.sp, type: x.type }], key: 'apb:' + W.addr + ':' + k + ':' + x.amt });
      }
    }
    STT.ap = bad.length ? `读不到授权清单：${bad.join('、')}（钱包连线可能断了，下一轮再试）` : '';
  }
  const rvFor = (w, tok, sp) => { const L = Object.values(SS.ap[w] || {}).filter((x) => x.tok === tok && (!sp || x.sp === sp)); return L.map((x) => ({ w, cid: x.cid, tok: x.tok, sp: x.sp, type: x.type })); };

  /* ① 你的钱包：交易次数（雷达没送的交易）、钱包程式权限（EIP-7702 委托） */
  async function walletState() {
    const L = chains(); const got = {};
    for (const W of WALLETS) { const tot = {}; let ok = true; /* C4：每条链分开比（交易次数、雷达送的笔数都照链算） */
      for (const ch of L) { try { const n = parseInt(await ch.rpc('eth_getTransactionCount', [W.addr, 'latest']), 16); const code = lc(await ch.rpc('eth_getCode', [W.addr, 'latest'])); const k = ch.id + ':' + W.addr; const o = (SS.ws[k] = SS.ws[k] || {}); const h = createHash('sha256').update(code).digest('hex');
          if (o.code != null && o.code !== h) alert({ cat: 'wallet', kind: 'code', ch: ch.id, w: W.addr, title: `[${W.name}] 钱包的程式权限变了`, det: code && code !== '0x' ? `现在钱包挂着一段程式（${/^0xef0100/.test(code) ? '委托给 0x' + code.substring(8, 48) : '合约程式'}）。这代表钱包的操作权限可能交给了别的合约。如果不是你在币安钱包设定的，请马上联系币安客服` : '钱包原本挂的程式被拿掉了（委托取消）', url: adUrl(ch, W.addr), sug: '确认是不是你自己在币安钱包改的', key: 'code:' + k + ':' + h });
          o.code = h; if (o.n == null) o.n = n; tot[ch.id] = n - o.n; o.n = n; } catch (e) { ok = false; STT.err = '钱包状态读不到：' + errT(e); } }
      if (!ok) continue; got[W.addr] = 1;
      for (const ch of L) { const ck = ch.id + ':' + W.addr; const t = tot[ch.id] || 0; const s = sends[ck] || 0, ex = explained[ck] || 0; const o = (SS.ws['all:' + ck] = SS.ws['all:' + ck] || { bal: 0 });
        if (!t && !s) { if (o.bal < 0) o.bal = 0; } else o.bal += t - s - ex; /* 雷达送出但还没上链的，下一轮补回来 */
        const pend = SS.txq.some((q) => q.ch === ch.id && (q.t === 'out' || q.t === 'ap' || q.t === 'p2') && (q.tp?.[1] ? '0x' + lc(q.tp[1]).substring(PL.word - 38) : '') === W.addr); /* 还有这个钱包的交易在排队 → 下一轮查完再算 */
        if (o.bal > 0 && !pend) { alert({ cat: 'wallet', kind: 'extraTx', ch: ch.id, w: W.addr, title: `[${W.name}] 钱包多了 ${o.bal} 笔雷达记录里没有的交易`, det: '可能是你自己在币安钱包 App 做的，或雷达换币时顺带的授权；都不是的话，钱包可能被别人操作了', url: adUrl(ch, W.addr), sug: '到区块浏览器看这几笔交易，不认得就去取消授权、联系币安客服', quiet: 0 }); o.bal = 0; } }
    }
    for (const a of Object.keys(got)) for (const ch of L) { sends[ch.id + ':' + a] = 0; explained[ch.id + ':' + a] = 0; }
  }

  /* 查事件：节点说一次太多 → 拆小再查；其他错误 → 往上丢，这一段下一轮重查 */
  async function logsSplit(ch, q, addrs, from, to) {
    try { return await ch.logs({ ...q, ...(addrs ? { address: addrs } : {}), fromBlock: hx(from), toBlock: hx(to) }); }
    catch (e) { const big = /limit|too many|exceed|range|size/i.test(errT(e)); if (!big) throw e; if (addrs && addrs.length > 1) { const h = addrs.length >> 1; return [...await logsSplit(ch, q, addrs.slice(0, h), from, to), ...await logsSplit(ch, q, addrs.slice(h), from, to)]; } if (to > from) { const m = from + ((to - from) >> 1); return [...await logsSplit(ch, q, addrs, from, m), ...await logsSplit(ch, q, addrs, m + 1, to)]; } throw e; }
  }
  const lk = (ch, l) => ch.id + ':' + lc(l.transactionHash) + ':' + parseInt(l.logIndex || '0x0', 16);
  const enq = (it) => { SS.txq.push(it); };

  async function scanRange(ch, from, to, SW, P) {
    const wt = WALLETS.map((w) => pad(w.addr)); if (!wt.length) return;
    if (SW.wallet) {
      for (const l of await logsSplit(ch, { topics: [[TP.APPROVAL, TP.APPROVAL_ALL], wt] }, null, from, to)) enq({ t: 'ap', ch: ch.id, k: lk(ch, l), a: lc(l.address), tp: l.topics, d: l.data, h: lc(l.transactionHash) });
      for (const l of await logsSplit(ch, { topics: [[TP.P2PERMIT, TP.P2APPROVAL], wt] }, [PERMIT2], from, to)) enq({ t: 'p2', ch: ch.id, k: lk(ch, l), a: lc(l.address), tp: l.topics, d: l.data, h: lc(l.transactionHash) });
    }
    if (SW.wallet || SW.fake) for (const l of await logsSplit(ch, { topics: [TP.TRANSFER, wt] }, null, from, to)) { const h = lc(l.transactionHash); if (radarHash.has(h)) { const t2 = tAddr(l.topics[2]); cpAdd(tAddr(l.topics[1]), t2); continue; } enq({ t: 'out', ch: ch.id, k: lk(ch, l), a: lc(l.address), tp: l.topics, d: l.data, h }); }
    if (SW.fake) for (const l of await logsSplit(ch, { topics: [TP.TRANSFER, null, wt] }, null, from, to)) { const h = lc(l.transactionHash); if (radarHash.has(h)) continue; enq({ t: 'in', ch: ch.id, k: lk(ch, l), a: lc(l.address), tp: l.topics, d: l.data, h }); }
    if (SW.proj && P.length) { const by = new Map(); for (const p of P) { by.set(p.c, p); const pr = pjOf(p.k).pair; if (A40.test(pr || '')) by.set(pr, p); } const addrs = [...by.keys()];
      for (let i = 0; i < addrs.length; i += PL.batch) for (const l of await logsSplit(ch, {}, addrs.slice(i, i + PL.batch), from, to)) onProj(ch, l, by.get(lc(l.address)));
    }
  }
  const cpAdd = (w, x) => { if (!A40.test(x) || !A40.test(w)) return; const L = (SS.cp[w] = SS.cp[w] || []); if (!L.includes(x)) { L.push(x); while (L.length > PL.keep) L.shift(); } };

  /* ② 项目：合约事件 */
  function onProj(ch, l, p) {
    if (!p) return; const t0 = lc(l.topics?.[0]); const a = lc(l.address); const isPair = a !== p.c; const nm = p.name || short(p.c); const base = { cat: 'proj', ch: ch.id, p: p.k, url: txUrl(ch, l.transactionHash) };
    if (isPair) { if (t0 === TP.BURN) enq({ t: 'burn', ch: ch.id, k: lk(ch, l), a, pk: p.k, tp: l.topics, d: l.data, h: lc(l.transactionHash) }); return; }
    if (t0 === TP.UPGRADED || t0 === TP.BEACON) { const impl = tAddr(l.topics[1]); pjOf(p.k).impl = impl; alert({ ...base, kind: 'upgrade', lab: '合约升级过', title: `${nm}：合约被升级了（换了新程式）`, det: `新程式地址 ${impl}\n升级后合约可以做原本做不到的事（例如改税、冻结、增发）。合约 ${p.c}`, sug: '先看清楚新程式，再决定要不要继续拿／继续打', key: 'up:' + p.k + ':' + impl }); return; }
    if (t0 === TP.ADMIN) { const nw = wAddr(l.data, 1); alert({ ...base, kind: 'admin', lab: '管理员换人', title: `${nm}：合约管理员（admin）换人了`, det: `新管理员 ${nw}\n管理员可以升级合约。合约 ${p.c}`, sug: '到区块浏览器看这笔交易', key: 'adm:' + p.k + ':' + nw }); return; }
    if (t0 === TP.OWNER) { const nw = tAddr(l.topics[2]), od = tAddr(l.topics[1]); pjOf(p.k).owner = nw; const gone = nw === ZERO; alert({ ...base, kind: 'owner', lab: gone ? '' : 'owner 换人', quiet: gone, title: `${nm}：${gone ? '项目方放弃了合约权限（owner 设成空地址）' : '合约 owner 换人了'}`, det: `原本 ${od}\n现在 ${nw}\n合约 ${p.c}`, sug: gone ? '' : '新 owner 能改合约设定，留意接下来的动作', key: 'own:' + p.k + ':' + nw }); return; }
    if (t0 === TP.PAUSED || t0 === TP.UNPAUSED) { const ps = t0 === TP.PAUSED; alert({ ...base, kind: 'pause', lab: ps ? '合约暂停中' : '', title: `${nm}：合约${ps ? '被暂停了（可能不能买卖／转帐）' : '解除暂停'}`, det: `合约 ${p.c}`, sug: ps ? '先别加码，等解除暂停' : '', key: 'pz:' + lk(ch, l) }); return; }
    if (t0 === TP.ROLE) { const acc = tAddr(l.topics[2]); alert({ ...base, kind: 'role', lab: '权限给了新地址', title: `${nm}：合约把一个管理权限给了新地址`, det: `拿到权限的地址 ${acc}\n合约 ${p.c}`, sug: '到区块浏览器看这个地址是谁', key: 'role:' + lk(ch, l) }); return; }
    if (t0 === TP.TRANSFER) { if (!p.why.has('hold')) return; const fr = tAddr(l.topics[1]); if (insiders(p).has(fr)) enq({ t: 'osell', ch: ch.id, k: lk(ch, l), a, pk: p.k, tp: l.topics, d: l.data, h: lc(l.transactionHash) }); return; }
    if (t0 === TP.APPROVAL || t0 === TP.APPROVAL_ALL) return;
    const o = pjOf(p.k); o.ut = o.ut || []; if (o.ut.includes(t0)) return; /* 这种事件以前查过是一般人触发的 */
    enq({ t: 'other', ch: ch.id, k: lk(ch, l), a, pk: p.k, tp: l.topics, h: lc(l.transactionHash) });
  }

  /* 排队的工作（要查交易发起人、代币名称）：每轮做一批，剩下的下一轮继续，不丢 */
  async function txWork() {
    const TX = new Map(); const getTx = async (ch, h) => { const k = ch.id + h; if (!TX.has(k)) TX.set(k, await ch.rpc('eth_getTransactionByHash', [h]).catch(() => null)); return TX.get(k); };
    const n = Math.min(SS.txq.length, PL.txBatch); const keep = [];
    for (const it of SS.txq.splice(0, n)) { const ch = chOf(it.ch); if (!ch) continue; try { const r = await work(ch, it, getTx); if (r === 'retry') keep.push(it); } catch (e) { STT.err = '查交易出错（下一轮再查）：' + errT(e); keep.push(it); } }
    SS.txq.unshift(...keep);
  }
  const heldNames = () => { const m = new Map(); for (const p of projects()) { const nm = norm(p.name); if (nm) m.set(nm, p); } for (const t of S.dyn || []) if (!t.closed && norm(t.sym)) m.set(norm(t.sym), { k: 'bsc:' + lc(t.addr), c: lc(t.addr), ch: 'bsc', name: t.sym }); return m; };
  async function work(ch, it, getTx) {
    const SW = STT.on || {}; const tp = it.tp || [];
    if (it.t === 'ap' || it.t === 'p2') { if (!SW.wallet) return; const w = tAddr(tp[1]); const p2 = it.t === 'p2'; const tok = p2 ? tAddr(tp[2]) : it.a; const sp = p2 ? tAddr(tp[3]) : tAddr(tp[2]);
      const all = lc(tp[0]) === TP.APPROVAL_ALL; let amt = null, nft = '';
      if (all) { if (!word(it.d, 0)) return; } else if (!p2 && tp[3] != null) { if (sp === ZERO) return; nft = '#' + BigInt(tp[3]).toString(); } else { amt = word(it.d, 0) ?? 0n; if (!amt) return; }
      const tx = radarHash.has(it.h) ? null : await getTx(ch, it.h); if (!radarHash.has(it.h) && !tx) return 'retry'; const byRadar = radarHash.has(it.h) || (tx && lc(tx.from) === w && (radarTo.has(sp) || pendHit(w, [tok, sp, lc(tx.to)], it.h)));
      if (tx && lc(tx.from) === w) explained[ch.id + ':' + w] = (explained[ch.id + ':' + w] || 0) + 1; /* 钱包自己签的这笔已经单独提醒（或是雷达的），不再算进「多出来的交易」 */
      const m = await meta(ch, tok); const other = tx && lc(tx.from) !== w; SS.apMark[w + ':' + tok + ':' + sp] = 1;
      const what = all ? '全部 NFT（setApprovalForAll）' : nft ? 'NFT ' + nft : amtTxt(amt, m.dec);
      alert({ cat: 'wallet', kind: p2 ? 'permit2' : 'apLog', ch: ch.id, w, quiet: byRadar, title: `[${wName(w)}] ${other ? '⚠️ 别人替你开了一笔授权' : byRadar ? '雷达送的交易里有授权' : '钱包开了一笔授权'}：${m.sym || short(tok)} → ${short(sp)}`, det: `代币 ${tok}\n对方（spender）${sp}\n额度 ${what}${p2 ? '（透过 Permit2）' : ''}${other ? `\n这笔交易是 ${tx.from} 送的，不是你的钱包——很可能是你签过的 Permit 签名被拿来用了` : ''}${byRadar ? '\n雷达下单时顺带的授权（你确认过）' : ''}`, url: txUrl(ch, it.h), sug: '去取消授权', rv: all || p2 ? rvFor(w, tok, sp) : rvFor(w, tok, sp).length ? rvFor(w, tok, sp) : ch.id === 'bsc' ? [{ w, cid: ch.cid, tok, sp, type: 'approve' }] : [], key: 'apl:' + it.k });
      return; }
    if (it.t === 'out') { const w = tAddr(tp[1]), to = tAddr(tp[2]); const tx = await getTx(ch, it.h); if (!tx) return 'retry'; const fr = lc(tx.from); const v = tp[3] != null ? null : word(it.d, 0) ?? 0n; const m = await meta(ch, it.a); const what = tp[3] != null ? 'NFT #' + BigInt(tp[3]).toString() : amtTxt(v, m.dec) + ' ' + (m.sym || short(it.a));
      if (fr === w) { cpAdd(w, to); explained[ch.id + ':' + w] = (explained[ch.id + ':' + w] || 0) + 1; const txTo = lc(tx.to); /* C1：直接转币（交易对象就是这个币）一律提醒，除非交易编号是雷达的 */ if (radarHash.has(it.h) || (radarTo.has(txTo) && txTo !== it.a)) return; if (pendHit(w, [it.a, txTo], it.h)) { if (SW.wallet) alert({ cat: 'wallet', kind: 'ownTx', ch: ch.id, w, quiet: 1, title: `[${wName(w)}] 雷达送的交易（结果不明的那笔）：转出 ${what}`, det: `转给 ${to}\n这笔对得上雷达之前送出、结果不明的那笔单（同一个钱包、同一个币）`, url: txUrl(ch, it.h), sug: '', key: 'otxp:' + it.k }); return; } if (SW.wallet) alert({ cat: 'wallet', kind: 'ownTx', ch: ch.id, w, title: `[${wName(w)}] 钱包转出 ${what}（雷达记录里没有这笔）`, det: `转给 ${to}\n如果是你自己在币安钱包 App 做的，可以忽略；不是的话，钱包可能被别人操作了`, url: txUrl(ch, it.h), sug: '不认得这笔就联系币安客服', key: 'otx:' + it.k }); return; }
      if (v === 0n) { if (SW.fake) alert({ cat: 'fake', kind: 'poison0', ch: ch.id, w, title: `[${wName(w)}] 可能是地址投毒：有人用你的地址发了一笔 0 金额的转帐`, det: `收款地址 ${to}\n交易是 ${fr} 送的，不是你。目的是让你的转帐记录出现一个长得很像的地址——以后转帐不要从记录里复制地址`, url: txUrl(ch, it.h), sug: '转帐前一定逐字核对完整地址', key: 'p0:' + it.k }); return; }
      if (SW.wallet) alert({ cat: 'wallet', kind: 'drain', ch: ch.id, w, title: `[${wName(w)}] ⚠️ 你的 ${what} 被别人转走了`, det: `转到 ${to}\n这笔交易是 ${fr} 送的（不是你的钱包），代表对方手上有这个币的授权`, url: txUrl(ch, it.h), sug: '马上取消这个币的所有授权', rv: rvFor(w, it.a), key: 'dr:' + it.k });
      return; }
    if (it.t === 'in') { if (!SW.fake) return; const w = tAddr(tp[2]), fr = tAddr(tp[1]); const tok = it.a; const held = projects().some((p) => p.c === tok);
      if (!held && !SS.fake[it.ch + ':' + tok]) { const m = await meta(ch, tok); const H = heldNames(); const like = H.get(norm(m.sym)) || H.get(norm(m.name)); if (like && like.c !== tok) { SS.fake[it.ch + ':' + tok] = { sym: m.sym || m.name, like: like.c, at: Date.now() }; alert({ cat: 'fake', kind: 'fake', ch: ch.id, w, p: it.ch + ':' + tok, lab: '可能是假币／地址投毒', title: `[${wName(w)}] 可能是假币／地址投毒：收到一个跟你持有的「${like.name || m.sym}」同名的币`, det: `收到的币 ${tok}（${m.sym || '?'}${m.name && m.name !== m.sym ? ' / ' + m.name : ''}）\n你真正持有的是 ${like.c}\n别去卖它、别去它说的网站领奖励（常常是要你授权的骗局）；雷达不会把它算进持仓价值`, url: txUrl(ch, it.h), sug: '不要碰它', key: 'fk:' + it.ch + ':' + tok }); } }
      const hN = num('sentinel.poisonHead'), tN = num('sentinel.poisonTail'); if (hN != null && tN != null && hN >= 1 && tN >= 1) { const ref = [...(SS.cp[w] || []), ...WALLETS.map((x) => x.addr)]; const hh = (x) => x.substring(2, 2 + hN), tt = (x) => x.substring(x.length - tN); const sim = ref.find((x) => x !== fr && hh(x) === hh(fr) && tt(x) === tt(fr)); if (sim) alert({ cat: 'fake', kind: 'lookalike', ch: ch.id, w, title: `[${wName(w)}] 可能是地址投毒：收到长得很像的地址转来的币`, det: `来源 ${fr}\n很像你用过的 ${sim}（开头 ${hN} 码、结尾 ${tN} 码一样，照你的设定比对）\n下次转帐不要从记录里复制这个地址`, url: txUrl(ch, it.h), sug: '转帐前逐字核对完整地址', key: 'lk:' + w + ':' + fr }); }
      return; }
    if (it.t === 'burn' || it.t === 'osell' || it.t === 'other') { if (!SW.proj) return; const p = projects().find((x) => x.k === it.pk); if (!p) return; const ins = insiders(p); const nm = p.name || short(p.c); const tx = await getTx(ch, it.h); if (!tx) return 'retry'; const fr = lc(tx.from);
      if (it.t === 'burn') { const to = tAddr(tp[2]); if (!ins.has(fr) && !ins.has(to)) return; alert({ cat: 'proj', kind: 'lpPull', ch: ch.id, p: p.k, lab: '项目方撤过池子', title: `${nm}：项目方从池子撤出流动性`, det: `撤出的人 ${ins.has(fr) ? fr : to}（项目方／部署者）\n池子 ${it.a}\n池子变浅，价格可能大跌、可能卖不出去`, url: txUrl(ch, it.h), sug: '自己决定要不要先卖', key: 'lp:' + it.k }); return; }
      if (it.t === 'osell') { const fr2 = tAddr(tp[1]), to = tAddr(tp[2]); const v = word(it.d, 0) ?? 0n; const o = pjOf(p.k); if (o.ts == null) { const r = await ecall(ch, p.c, SEL.totalSupply); if (r == null) return 'retry'; o.ts = (word(r, 0) ?? 0n).toString(); } const ts = BigInt(o.ts || '0'); const pct = ts > 0n ? Number(v * 1000000n / ts) / 10000 : null; const lim = num('sentinel.ownerSellPct'); if (lim != null && (pct == null || pct < lim)) return; const m = await meta(ch, p.c);
        alert({ cat: 'proj', kind: 'ownerSell', ch: ch.id, p: p.k, lab: '项目方在转出／卖', title: `${nm}：项目方转出 ${amtTxt(v, m.dec)} 个${pct != null ? `（总量的 ${pct}%）` : ''}`, det: `从 ${fr2}（项目方／部署者）\n到 ${to}${to === pjOf(p.k).pair ? '（池子＝卖出）' : ''}${lim != null ? `\n照你的设定：总量 ${lim}% 以上才提醒` : ''}`, url: txUrl(ch, it.h), sug: '自己决定要不要先卖', key: 'os:' + it.k }); return; }
      const t0 = lc(tp[0]); if (!ins.has(fr)) { const o = pjOf(p.k); o.ut = o.ut || []; if (!o.ut.includes(t0)) o.ut.push(t0); return; }
      alert({ cat: 'proj', kind: 'ownerOp', ch: ch.id, p: p.k, lab: '项目方改过合约设定', title: `${nm}：项目方对合约做了一个操作`, det: `送出的人 ${fr}（项目方／部署者）\n事件 ${t0.substring(0, 10)}\n可能是改税、黑名单、限额、暂停这类设定，请到区块浏览器看这笔交易`, url: txUrl(ch, it.h), sug: '看清楚改了什么再决定', key: 'op:' + it.k }); return; }
  }

  /* ② 项目：直接读合约（升级、owner、铸造价格／上限），轮流读，全部都会轮到 */
  async function projReads(P) {
    if (!P.length) return; SS.pri = (SS.pri || 0) % P.length; const part = []; for (let i = 0; i < Math.min(PL.batch, P.length); i++) part.push(P[(SS.pri + i) % P.length]); SS.pri = (SS.pri + part.length) % P.length;
    for (const p of part) { const ch = chOf(p.ch); if (!ch) continue; const o = pjOf(p.k); const nm = p.name || short(p.c);
      try { const sl = await ch.rpc('eth_getStorageAt', [p.c, SLOT_IMPL, 'latest']); const impl = wAddr(sl, 0); if (impl && impl !== ZERO) { if (o.impl && o.impl !== impl) alert({ cat: 'proj', kind: 'upgrade', ch: ch.id, p: p.k, lab: '合约升级过', title: `${nm}：合约被升级了（换了新程式）`, det: `原本 ${o.impl}\n现在 ${impl}\n合约 ${p.c}`, url: adUrl(ch, p.c), sug: '先看清楚新程式，再决定要不要继续拿／继续打', key: 'up:' + p.k + ':' + impl }); o.impl = impl; } } catch {}
      { const r = await ecall(ch, p.c, SEL.owner); if (r && r !== '0x') { const ow = wAddr(r, 0); if (o.owner && o.owner !== ow) alert({ cat: 'proj', kind: 'owner', ch: ch.id, p: p.k, lab: ow === ZERO ? '' : 'owner 换人', quiet: ow === ZERO, title: `${nm}：${ow === ZERO ? '项目方放弃了合约权限' : '合约 owner 换人了'}`, det: `原本 ${o.owner}\n现在 ${ow}\n合约 ${p.c}`, url: adUrl(ch, p.c), key: 'own:' + p.k + ':' + ow }); o.owner = ow; } }
      if (p.ch === 'bsc' && p.why.has('hold') && !o.pair) { const r = await ecall(ch, PANCAKE_V2, SEL.getPair + pad(p.c).substring(2) + pad(WBNB).substring(2)); const pr = r ? wAddr(r, 0) : ''; if (pr && pr !== ZERO) o.pair = pr; }
      if (p.why.has('mint')) { const P0 = S.paid?.[p.c]; const stamp = String(P0?.pick?.at || P0?.replay?.learnedAt || ''); if (!stamp) continue; const cur = {}; for (const sel of Object.keys(MINT_GET)) { const r = await ecall(ch, p.c, sel); if (r && r !== '0x' && String(r).length >= 2 + PL.word) cur[sel] = (word(r, 0) ?? 0n).toString(); }
        const b = SS.mp[p.k]; if (!b || b.stamp !== stamp) { SS.mp[p.k] = { stamp, v: cur }; continue; }
        for (const [sel, v] of Object.entries(cur)) if (b.v[sel] != null && b.v[sel] !== v) alert({ cat: 'proj', kind: 'mintChg', ch: ch.id, p: p.k, lab: '铸造价格／上限改过', title: `${nm}：铸造的 ${MINT_GET[sel]} 在你学到打法之后改了`, det: `原本 ${b.v[sel]}\n现在 ${v}（合约原始数字）\n你存的打法可能付错钱或打不到，送出前会再预演`, url: adUrl(ch, p.c), sug: '重新看一下打法和金额', key: 'mp:' + p.k + ':' + sel + ':' + v });
        b.v = { ...b.v, ...cur }; }
    }
  }

  /* ④ 显示资料验证、手机连线 */
  function dataCheck(onD) {
    let lines = []; try { if (existsSync(FIN)) { const t = FIN + '.run'; renameSync(FIN, t); lines = readFileSync(t, 'utf8').split('\n').filter(Boolean); unlinkSync(t); } } catch {}
    if (!onD) return;
    for (const l of lines) { let o; try { o = JSON.parse(l); } catch { continue; } if (o.k === 'phone') alert({ cat: 'data', kind: 'phone', title: `有新的手机连上你的雷达（现在 ${+o.n || '?'} 台在线）`, det: '如果不是你的手机，请到雷达「⚙️ 设定 → 📱 连结手机」按「解除旧手机」重新配对', sug: '确认是不是你的手机' }); }
    let sg = {}; try { sg = JSON.parse(readFileSync(FSIG, 'utf8')) || {}; } catch {}
    for (const [what, v] of Object.entries(sg)) { if (v?.ok === 0) { if (nOnce('sent:sig:' + what, 'bad')) alert({ cat: 'data', kind: 'sig', title: `官方显示资料的签名对不上：${SIGN[what] || what}`, det: '雷达没有使用这份资料（可能是网路被动过手脚或资料被换掉）。下单、设定都不受影响', sug: '先别相信这段时间画面上的公告／名单；持续出现请回报' }); } else nOnce('sent:sig:' + what, 'ok'); }
    try { const r = JSON.parse(readFileSync(FRM, 'utf8')); const rl = String(r?.relay || ''); if (SS.relay != null && rl && SS.relay !== rl) alert({ cat: 'data', kind: 'relay', title: '手机转接站的网址换了', det: `原本 ${SS.relay || '（没有）'}\n现在 ${rl}\n这是官方签名过的资料；手机要重新扫描配对才会用新的`, sug: '确认雷达是官方版本，再重新配对手机' }); if (rl) SS.relay = rl; } catch {}
  }

  /* 你按的：取消授权（只取消，不转钱）、知道了 */
  async function order(o) {
    const a = V.alerts.find((x) => x.id === String(o.aid || '')); if (!a) { await tgSay('🛡 这则提醒已经找不到（可能太旧），请到区块浏览器或币安钱包取消授权'); return; }
    if (o.type === 'sentAck') { a.rd = 1; write(); return; }
    const r = a.rv?.[+o.i]; const W = r && WALLETS.find((w) => w.addr === r.w); if (!r || !W) { await tgSay('🛡 找不到要取消的授权或钱包'); return; }
    const res = await W.baw(['approvals', 'revoke', '--binanceChainId', String(r.cid), '--tokenContract', r.tok, '--spender', r.sp, '--type', r.type || 'approve']).catch((e) => ({ t: errT(e) }));
    const ok = !!res?.j?.success; r.done = ok ? 1 : 0; r.err = ok ? '' : String(res?.j?.error?.message || res?.t || '').substring(0, 120); if (ok) a.rd = 1; write();
    log(`🛡 取消授权 [${W.name}] ${r.tok} → ${r.sp}：${ok ? '已送出' : '失败 ' + r.err}`);
    await tgSay(ok ? `🛡 已送出取消授权：[${W.name}] ${r.tok} → ${r.sp}` : `🛡 取消授权失败：${r.err || '原因读不到'}（可以到币安钱包 App 的授权管理手动取消）`);
  }

  async function run() {
    const SW = { wallet: on('sentinel.wallet'), proj: on('sentinel.proj'), fake: on('sentinel.fake'), data: on('sentinel.data') }; STT.on = { ...SW, tg: on('sentinel.tg') }; STT.err = '';
    wrapBaw(); dataCheck(SW.data);
    if (!SW.wallet) { SS.ap = {}; SS.ws = {}; sends = {}; SS.pend = []; }
    const scanning = SW.wallet || SW.proj || SW.fake; const P = SW.proj ? projects() : [];
    for (const ch of chains()) { if (!scanning) { delete SS.cur[ch.id]; STT.chains[ch.id] = null; continue; }
      try { const head = parseInt(await ch.rpc('eth_blockNumber', []), 16); if (SS.cur[ch.id] == null) SS.cur[ch.id] = head + 1; let from = SS.cur[ch.id], n = 0; const Pc = P.filter((p) => p.ch === ch.id);
        while (from <= head && n < PL.spans) { const to = Math.min(head, from + PL.span - 1); await scanRange(ch, from, to, SW, Pc); SS.cur[ch.id] = to + 1; from = to + 1; n++; }
        STT.chains[ch.id] = { head, behind: Math.max(0, head - SS.cur[ch.id] + 1), at: Date.now(), err: '' }; }
      catch (e) { STT.chains[ch.id] = { ...(STT.chains[ch.id] || {}), at: Date.now(), err: '节点出错，这一段下一轮重查：' + errT(e) }; } }
    if (!scanning) SS.txq = [];
    if (SW.proj) await projReads(P).catch((e) => { STT.err = '读合约出错：' + errT(e); });
    if (SS.txq.length) await txWork();
    if (SW.wallet) await approvalsDiff().catch((e) => { STT.ap = '授权清单读不到：' + errT(e); }); /* C3：先查完逐笔的授权事件，再比对授权清单（不会两边各提醒一次） */
    if (SW.wallet) await walletState(); /* 先把逐笔的交易查完，再算「多出来的交易」，不会重复提醒 */
    STT.q = SS.txq.length; STT.at = Date.now(); write(); save();
  }
  let busy = false; const tick = async () => { if (busy) return; busy = true; try { await run(); } catch (e) { STT.err = errT(e); log('安全哨兵 ' + errT(e)); try { write(); } catch {} } finally { busy = false; } };
  setInterval(tick, PL.loopMs).unref?.(); setTimeout(tick, PL.firstMs).unref?.();
  wrapBaw();
  return { order, tick, _work: work, _onProj: onProj, _projects: projects, _V: () => V, _STT: STT };
}
