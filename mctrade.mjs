// 罗宾猫雷达 · 多链手动买卖（MCT-1111）
// 钱包（币安 AI 钱包 baw）自己回报支援哪些链（data/wallet_chains.json，引擎启动／重新登入时读）→ 支援的链就能在雷达手动买卖。
// 只做「你按了才买／卖」：自动策略、止盈止损、铸造在这些链都不跑。所有送出一律经过 W.baw（外面已包 actionGate：紧急全停、手动买卖开关、邀请绑定都照查）。
// 送出后一定照币安文件轮询 market-order list 到 FINISHED／FAILED 才回报结果（orderId 不等于成交），有 refund 就说是部分成交。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const MCT_CHAINS = { /* 雷达链代号 → 币安 binanceChainId＋原生币地址（币安 baw 文件 SKILL.md 的 token 表） */
  eth: { id: '1', nat: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', sym: 'ETH' },
  base: { id: '8453', nat: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', sym: 'ETH' },
  arbitrum: { id: '42161', nat: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', sym: 'ETH' },
  polygon: { id: '137', nat: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', sym: 'POL' },
  solana: { id: 'CT_501', nat: 'So11111111111111111111111111111111111111111', sym: 'SOL' }, /*SOL-13 币安文件：Solana 原生币地址、链代号 CT_501*/
};
const T = { pollMs: 3000, pollMax: 40, keep: 30 }; /* 技术用：轮询订单状态的间隔、最多几次（约 2 分钟）、结果档留几笔（只影响显示） */
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, EVM = /^0x[0-9a-fA-F]{40}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function mctAddr(ch, a) { a = String(a || '').trim(); return ch === 'solana' ? (B58.test(a) ? a : '') : (EVM.test(a) ? a.toLowerCase() : ''); }

export function mctSupported(DIR, ch, wName) { /* 这个钱包有没有回报支援这条链 */
  const C = MCT_CHAINS[ch]; if (!C) return false;
  try { const o = JSON.parse(readFileSync(join(DIR, 'data', 'wallet_chains.json'), 'utf8')); const ws = o?.kinds?.binance?.wallets || {};
    const L = wName ? [ws[wName]] : Object.values(ws); return L.some((w) => w && w.ok && Array.isArray(w.ids) && w.ids.map(String).includes(C.id)); } catch { return false; }
}

function result(DIR, rec) { const f = join(DIR, 'data', 'mc_trade.json'); let a = []; try { a = JSON.parse(readFileSync(f, 'utf8')); if (!Array.isArray(a)) a = []; } catch {} a.unshift(rec); a = a.slice(0, T.keep); try { writeFileSync(f + '.tmp', JSON.stringify(a)); renameSync(f + '.tmp', f); } catch {} }

async function waitOrder(W, id, cid) { /* 轮询到终态（币安文件规定：orderId 只是送出） */
  for (let i = 0; i < T.pollMax; i++) { await sleep(T.pollMs);
    let r; try { r = await W.baw(['market-order', 'list', '--orderId', String(id), '--binanceChainId', cid], 30000); } catch { continue; }
    const L = r?.j?.data?.list; const x = Array.isArray(L) ? L.find((y) => String(y?.orderId) === String(id)) || L[0] : null; const st = String(x?.status || '');
    if (st === 'FINISHED' || st === 'FAILED') return x; }
  return { status: 'PENDING' };
}

/* o：{ type:'buy'|'sell', mc:'eth'|'base'|'arbitrum'|'polygon'|'solana', c, amt（买：原生币数量）, pct（卖：1–100）, w（钱包地址，可空）, slip（滑点 %，可空＝币安预设）, name } */
export async function mctOrder(o, { DIR, WALLETS, log, tgSay }) {
  const ch = String(o.mc || ''); const C = MCT_CHAINS[ch]; const name = String(o.name || '').slice(0, 40);
  const done = (ok, msg, extra = {}) => { const rec = { at: Date.now(), ch, c: String(o.c || ''), type: o.type, name, w: String(o._w || ''), ok: ok ? 1 : 0, msg: String(msg).slice(0, 300), ...extra }; result(DIR, rec); log(`🌐 ${ch} ${o.type === 'buy' ? (o.auto ? '自动买' : '手动买') : '手动卖'} ${name || o.c}：${msg}`); tgSay(`${o.auto ? '🤖 自动' : '🖥 '}${C?.sym ? ch.toUpperCase() : ch} ${o.type === 'buy' ? '买' : '卖'} ${name || o.c}\n${msg}`).catch(() => {}); return rec; };
  if (!C) return done(false, '雷达不认识这条链，没送出');
  const c = mctAddr(ch, o.c); if (!c) return done(false, '合约地址格式不对，没送出');
  const wa = String(o.w || '').toLowerCase(); const sup = (x) => x && mctSupported(DIR, ch, x.name); let W = wa ? (WALLETS || []).find((x) => String(x.addr || '').toLowerCase() === wa && sup(x)) : null;
  if (!wa && !W) { const P = o.type === 'buy' ? globalThis.PICK_BUY_W?.(c) : null; W = (P && sup(P)) ? P : (WALLETS || []).find((x) => sup(x) && !x.off) || null; } /*DUALW-13 买：主钱包优先（要支援这条链）；卖：有支援这条链、有登入的钱包（单子会带当初买的钱包）*/
  if (!W) return done(false, '你的钱包没有回报支援这条链（或选的钱包不支援），没送出');
  o._w = String(W.addr || '').toLowerCase();
  const slip = Number(o.slip) > 0 && Number(o.slip) <= 50 ? String(+o.slip) : null; /* 没填＝用币安预设滑点 */
  let a;
  if (o.type === 'buy') { const amt = Number(o.amt); if (!(amt > 0)) return done(false, `没填要花多少 ${C.sym}，没送出`);
    a = ['market-order', 'swap', '--binanceChainId', C.id, '--fromTokenQty', String(+amt.toPrecision(10)), '--fromToken', C.nat, '--toToken', c]; }
  else if (o.type === 'sell') { const pct = Number(o.pct); if (!(pct > 0 && pct <= 100)) return done(false, '没收到要卖几 %，没卖');
    let bal = 0; try { const r = await W.baw(['wallet', 'balance', '--tokenAddress', c, '--binanceChainId', C.id, '--hideLowValue', 'false'], 60000); const L = Array.isArray(r?.j?.data) ? r.j.data : []; const x = L.find((y) => String(y?.address || '').toLowerCase() === c.toLowerCase()) || L[0]; bal = Number(x?.balance) || 0; } catch {}
    if (!(bal > 0)) return done(false, '钱包里读不到这个币的余额，没卖');
    const q = pct >= 100 ? bal : bal * pct / 100; a = ['market-order', 'swap', '--binanceChainId', C.id, '--fromTokenQty', String(+q.toPrecision(12)), '--fromToken', c, '--toToken', C.nat]; }
  else return done(false, '不认识的单种，没送出');
  if (slip) a.push('--slippage', slip);
  let r; try { r = await W.baw(a, 90000); } catch (e) { return done(false, '送出失败：' + String(e?.message || e).slice(0, 160)); }
  if (r?.j?.data?.final?.status === 'FAILED') return done(false, '❌ 没成交（链上失败：可能滑点、流动性不够或路由问题），钱没花掉', { id: String(r.j.data.orderId || '') });
  const id = r?.j?.data?.orderId; if (!r?.j?.success || !id) return done(false, '没送出：' + String(r?.j?.error?.message || r?.j?.message || r?.t || '没有回原因').slice(0, 160));
  const x = r.j.data.final || (log(`🌐 ${ch} 已送出单号 ${id}，确认成交中…`), await waitOrder(W, id, C.id)); /* 引擎外层（SWAPWAIT）通常已经查到结果 */
  if (x.status === 'FINISHED') { const rf = Array.isArray(x.refund) ? x.refund.filter((y) => y && Number(y.amount) > 0) : []; const got = x.toTokenActualQty ? `收到 ${x.toTokenActualQty} ${x.toTokenName || ''}` : '';
    return done(true, `✅ 成交 ${got}${rf.length ? `（部分成交，退回 ${rf.map((y) => y.amount + ' ' + (y.symbol || '')).join('、')}）` : ''}`, { tx: String(x.txHash || ''), id: String(id) }); }
  if (x.status === 'FAILED') return done(false, '❌ 没成交（链上失败：可能滑点、流动性不够或路由问题），钱没花掉', { id: String(id) });
  return done(false, `⏳ 送出了，但约 2 分钟还没确认成交（单号 ${id}），请到币安 App 看结果`, { id: String(id), pending: 1 });
}
