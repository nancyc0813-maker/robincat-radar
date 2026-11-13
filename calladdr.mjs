// 罗宾猫雷达 · CALLADDR-1113 喊单贴文里的合约地址（X／TG 频道／TG 群／机器人共用）
// 以前只认 0x（BNB Chain 那种），Solana 喊单（base58 地址）全部漏掉；X Layer／Base／Arbitrum 等 EVM 链的 0x 合约在 BNB Chain 查不到程式码也被丢掉。
// 这里只负责「从文字挑出像合约的地址」和「查它是哪条链的真合约」，不下单、不碰钱包；查到的只进喊单流（讯号页），BNB Chain 的币照原本的流程。
// 判断真合约：EVM 先照原本问 BNB Chain 有没有程式码（呼叫的人自己做）；Solana 和其他 EVM 链问 DexScreener 有没有交易对（公开免费，雷达本来就在用）。
// 基础币（SOL／USDC／USDT…）和系统程式地址先排除；地址同时出现在好几条链（EVM 同一个地址可以在很多链都有）＝取流动性最大的那条。

const B58 = /(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])/g; /* 前后不能接任何英数字（不然 0x 地址中间的一段也会被当成 base58） */
const EVM = /(?<![0-9a-fA-Fx])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
/* Solana 不是代币的常见地址（系统程式、代币程式、发射台程式、基础币）：贴文里常出现，但不是「喊的币」 */
export const SOL_BASE = new Set([
  'So11111111111111111111111111111111111111112', /* WSOL */
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', /* USDC */
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', /* USDT */
  '11111111111111111111111111111111', /* System Program */
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', /* SPL Token Program */
  'TokenzQdBNbLqP5VEhdkAS6EHB7d2TQ3XqC7XqyzaYK', /* Token-2022 Program */
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', /* Associated Token Program */
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', /* pump.fun 程式 */
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', /* PumpSwap 程式 */
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', /* Jupiter */
  'ComputeBudget111111111111111111111111111111',
]);
/* EVM 不是代币的地址：零地址、全 e／全 f 的占位、Multicall3、Permit2 */
const EVM_BASE = new Set(['0x0000000000000000000000000000000000000000', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0xffffffffffffffffffffffffffffffffffffffff', '0xca11bde05977b3631167028862be2a173976ca11', '0x000000000022d473030f116ddee9f6b43ac78ba3']);
/* DexScreener 的 chainId → 雷达的链代号（雷达十条链；其他链的币不收） */
export const DS_CH = { bsc: 'bsc', solana: 'solana', base: 'base', ethereum: 'eth', robinhood: 'robinhood', xlayer: 'xlayer', arbitrum: 'arbitrum', polygon: 'polygon', monad: 'monad', hyperevm: 'hyperevm' };

/* 从一段文字挑地址：evm（小写）、sol（大小写原样）。base58 要同时有数字和英文字母（一般英文长字不会被当成地址） */
export function pickAddrs(text) {
  const t = String(text || '');
  const evm = [...new Set([...t.matchAll(EVM)].map((m) => m[0].toLowerCase()))].filter((a) => !EVM_BASE.has(a) && !/^0x(.{4})\1{9}$/.test(a));
  const sol = [...new Set([...t.matchAll(B58)].map((m) => m[0]))].filter((a) => !SOL_BASE.has(a) && /[1-9]/.test(a) && /[A-HJ-NP-Za-km-z]/.test(a) && !/^0x/i.test(a));
  return { evm, sol };
}

/* 基础币（交易对里通常是报价那一边）：DexScreener 把它当 baseToken 回来＝不是喊的币 */
const isBaseSym = (s) => /^(w?(sol|eth|bnb|okb|pol|matic|mon|hype)|usd[tcg1]|usdt0|dai|fdusd)$/i.test(String(s || '')); /* 技术用：基础币／稳定币代号 */

/* 问 DexScreener：回 Map(地址 → { ch, sym, mc, liq })；没有交易对的不在里面（＝还不能确认是真合约）。fetchJ 由呼叫的人给（带逾时） */
export async function resolveAddrs({ evm = [], sol = [] }, fetchJ, per = 30) {
  const out = new Map(); const take = (ps, want) => { for (const p of Array.isArray(ps) ? ps : []) { const ch = DS_CH[p?.chainId]; const a0 = String(p?.baseToken?.address || ''); const a = /^0x/i.test(a0) ? a0.toLowerCase() : a0; if (!ch || !want.has(a) || isBaseSym(p?.baseToken?.symbol)) continue; const liq = +p?.liquidity?.usd || 0; const o = out.get(a); if (!o || liq > o.liq) out.set(a, { ch, sym: String(p.baseToken.symbol || '').slice(0, 20), mc: +(p.marketCap || p.fdv) || 0, liq }); } };
  for (let i = 0; i < sol.length; i += per) { const part = sol.slice(i, i + per); try { take(await fetchJ('https://api.dexscreener.com/tokens/v1/solana/' + part.join(',')), new Set(part)); } catch {} }
  for (const a of evm) { try { const j = await fetchJ('https://api.dexscreener.com/latest/dex/tokens/' + a); take(j?.pairs, new Set([a])); } catch {} } /* EVM 不知道是哪条链 → 一个地址问一次（跨链） */
  return out;
}
