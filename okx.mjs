// 罗宾猫雷达 · OKX AI 钱包（Agentic Wallet，onchainos CLI）转接（OKX-13）
// 雷达所有买卖都经过 watch.mjs 的统一闸门 actionGate，而闸门只认币安钱包（baw）的指令格式。
// 这个档把「币安格式的指令」翻成 onchainos 指令：闸门照样看得懂、照样检查（紧急全停、手动买卖开关、邀请绑定、参数格式），闸门本身一个字都不改。
// 只翻译这几种：wallet status／settings／chains、market-order swap（买卖）、market-order list（查结果）、wallet balance（查余额）。
// 其他指令（铸造 contract-call、签名、授权撤销…）一律回「OKX 钱包不支援」，不会偷偷换别的方式做。
// 官方文件：https://web3.okx.com/zh-hans/onchainos/dev-docs/home/what-is-onchainos ；指令说明 github.com/okx/onchainos-skills
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const OKX_BIN = (() => { const h = process.env.USERPROFILE || homedir(); for (const p of [join(h, '.local', 'bin', 'onchainos.exe'), join(h, '.local', 'bin', 'onchainos')]) if (existsSync(p)) return p; return 'onchainos'; })();
const T = { cmd: 120000, pollMs: 3000, pollN: 30 }; /* 技术用：单一指令逾时、查交易状态的间隔与次数（约 1.5 分钟），不影响买卖条件 */
const ARG_OK = /^[A-Za-z0-9_.:\/@=,+\-]*$/; /* 跟 baw 参数检查同一套字元（不经过 shell） */

export function okxRun(args, timeout = T.cmd) {
  return new Promise((res) => { if (!args.every((a) => ARG_OK.test(String(a)))) return res({ t: '参数格式不对', j: { ok: false, error: '参数格式不对' } });
    execFile(OKX_BIN, args.map(String), { windowsHide: true, timeout, maxBuffer: 4 << 20 }, (e, so, se) => { const t = String(so || se || e?.message || ''); let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} res({ t, j, code: e?.code ?? 0, timeout: !!(e && (e.killed || e.signal)) }); }); });
}
const arg = (a, f) => { const i = a.indexOf(f); return i >= 0 ? String(a[i + 1] ?? '') : ''; };
const fail = (m) => ({ t: m, j: { success: false, error: { message: m } } });
const okj = (data) => ({ t: '', j: { success: true, data } });
const BSOL = 'So11111111111111111111111111111111111111111', OSOL = '11111111111111111111111111111111'; const tok = (t) => (t === BSOL ? OSOL : t); /*SOL-13 币安 SOL 原生币地址 → OKX 的写法*/
const chainOf = (a) => { const c = arg(a, '--binanceChainId') || '56'; return c === 'CT_501' ? '501' : c; };

export function makeOkxBaw(w) { const addr = String(w.address || w.addr || '').toLowerCase();
  let solAddr = ''; const walletFor = async (ch) => { if (ch !== '501') return addr; if (!solAddr) { const r = await okxRun(['wallet', 'addresses', '--chain', '501'], 60000); const m = JSON.stringify(r.j?.data || {}).match(/[1-9A-HJ-NP-Za-km-z]{32,44}/); solAddr = m ? m[0] : ''; } return solAddr; }; /*SOL-13 Solana 要用 OKX 帐号的 Solana 地址*/
  const f = async (a, timeout) => { a = (a || []).map(String); const c = a[0] + ' ' + a[1];
    if (c === 'wallet status') { const r = await okxRun(['wallet', 'status'], timeout); if (!r.j) return fail('读不到 OKX 钱包状态：' + (r.t || '').slice(0, 120)); const d = r.j.data || {}; return okj({ status: r.j.ok && d.loggedIn ? 'CONNECTED' : 'NOT_LOGGED_IN', okx: 1 }); }
    if (c === 'wallet settings') return okj({ okx: 1 }); /* OKX 没有开发者模式这类设定 */
    if (c === 'wallet chains') { const r = await okxRun(['wallet', 'chains'], timeout); if (!r.j?.ok) return fail(String(r.j?.error || r.t || '').slice(0, 160)); const L = Array.isArray(r.j.data) ? r.j.data : (r.j.data?.chains || []);
      return okj(L.map((x) => { const id = String(x?.realChainIndex ?? x?.chainIndex ?? ''); return { binanceChainId: id === '501' ? 'CT_501' : id, simpleName: String(x?.showName || x?.chainName || '') }; }).filter((x) => x.binanceChainId)); }
    if (c === 'wallet balance') { const ch = chainOf(a), tk = arg(a, '--tokenAddress'); const r = await okxRun(['wallet', 'balance', '--chain', ch, ...(tk ? ['--token-address', tk] : [])], timeout); if (!r.j?.ok) return fail(String(r.j?.error || r.t || '').slice(0, 160));
      const D = Array.isArray(r.j.data) ? r.j.data : [r.j.data]; const out = []; for (const d of D) for (const x of (d?.tokenAssets || d?.assets || [])) out.push({ address: String(x?.tokenAddress || ''), symbol: x?.symbol, balance: String(x?.balance ?? '0') }); return okj(out); }
    if (c === 'market-order swap') { const ch = chainOf(a); const wal = await walletFor(ch); if (!wal) return fail('读不到 OKX 帐号的 Solana 地址，没送出'); const q = ['swap', 'execute', '--from', tok(arg(a, '--fromToken')), '--to', tok(arg(a, '--toToken')), '--readable-amount', arg(a, '--fromTokenQty'), '--chain', ch, '--wallet', wal]; const sl = arg(a, '--slippage'); if (sl && sl !== 'auto') q.push('--slippage', sl);
      const r = await okxRun(q, timeout || T.cmd); if (r.code === 2 || r.j?.confirming) return fail('OKX 钱包要求你确认这笔交易（' + String(r.j?.message || '').slice(0, 120) + '），雷达不会替你确认，没送出');
      if (!r.j?.ok) return { ...fail(String(r.j?.error || r.t || 'OKX 没回结果').slice(0, 200)), timeout: r.timeout ? 1 : 0 };
      const d = r.j.data || {}; const tx = String(d.swapTxHash || ''), oid = String(d.swapOrderId || ''); if (!tx && !oid) return fail('OKX 回了成功但没有交易编号');
      /* 等链上结果（wallet history）：SUCCESS＝成交；ERROR／CANCELLED＝没成交 */
      let st = 'PENDING'; for (let i = 0; i < T.pollN && st === 'PENDING'; i++) { await new Promise((z) => setTimeout(z, T.pollMs)); const h = await okxRun(['wallet', 'history', '--chain', ch, ...(tx ? ['--tx-hash', tx] : ['--order-id', oid])], 60000); const x = Array.isArray(h.j?.data?.orderList) ? h.j.data.orderList[0] : (h.j?.data || null); const s = String(x?.txStatus || ''); if (s === 'SUCCESS') st = 'FINISHED'; else if (s === 'ERROR' || s === 'CANCELLED') st = 'FAILED'; }
      const final = { status: st, txHash: tx, fromTokenQty: String(d.fromAmount ?? ''), toTokenActualQty: '', toTokenName: '', refund: [] };
      if (st === 'FAILED') return { t: 'OKX 交易链上失败', j: { success: false, error: { message: '链上没成交（OKX 交易失败：可能滑点、流动性或路由问题），钱没花掉' }, data: { orderId: tx || oid, final } } };
      return okj({ orderId: tx || oid, txHash: tx, status: st, ...(st === 'FINISHED' ? { final } : {}) }); } /* 还在等＝照旧回送出（跟币安查不到结果时一样） */
    if (c === 'market-order quote') { const r = await okxRun(['swap', 'quote', '--from', tok(arg(a, '--fromToken')), '--to', tok(arg(a, '--toToken')), '--readable-amount', arg(a, '--fromTokenQty'), '--chain', chainOf(a)], timeout); if (!r.j?.ok) return fail(String(r.j?.data?.reason || r.j?.error || r.t || '报不出价').slice(0, 160));
      const d = Array.isArray(r.j.data) ? r.j.data[0] : r.j.data; const dec = Number(d?.toToken?.decimal ?? d?.toToken?.decimals); const raw = Number(d?.toTokenAmount); const amt = Number.isFinite(raw) && Number.isInteger(dec) ? raw / 10 ** dec : NaN;
      return okj({ toCoinAmount: Number.isFinite(amt) ? String(amt) : '', priceImpact: d?.priceImpactPercent ?? null, okx: 1 }); } /* 唯读报价（雷达送单前先确认报得出价） */
    if (c === 'market-order list') return okj({ list: [] }); /* OKX 在送出时就查过结果了 */
    return fail('OKX 钱包不支援这个动作（' + c.slice(0, 40) + '）：铸造、签名、授权撤销请用币安 AI 钱包');
  };
  return Object.assign(f, { okx: 1 });
}

/* 画面「连接 OKX 钱包」用：登入（浏览器 Email／Google／Apple）→ 取 EVM 地址 */
export async function okxLoginInit() { const r = await okxRun(['wallet', 'login', '--phase', 'init'], 60000); if (!r.j?.ok) return { err: r.j ? String(r.j.error || '').slice(0, 200) : (r.code === 'ENOENT' ? 'noBin' : String(r.t || '').slice(0, 200)) }; const d = r.j.data || {}; return { url: String(d.loginUrl || ''), sid: String(d.authSessionId || ''), opened: !!d.opened }; }
export async function okxLoginPoll(sid) { const r = await okxRun(['wallet', 'login', '--phase', 'poll', ...(sid ? ['--session-id', String(sid)] : [])], 180000); if (!r.j?.ok) return { err: String(r.j?.error || r.t || '').slice(0, 200) }; return { ok: 1 }; }
export async function okxEvmAddr() { const r = await okxRun(['wallet', 'addresses', '--chain', '1'], 60000); const s = JSON.stringify(r.j?.data || {}); const m = s.match(/0x[0-9a-fA-F]{40}/); return m ? m[0].toLowerCase() : ''; }
