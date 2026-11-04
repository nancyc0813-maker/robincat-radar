// 罗宾猫雷达 · 聪明钱包：用户标记的钱包（做市商、大户）＋自动找到的「相关钱包」，只要对某个币有动作就通知
// 全部本地跑：直接查链上转账记录（BSC、Robinhood Chain），不用任何 AI、不花钱
const T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; const TX_CHECK_MAX = 8; /* 技术用：同一轮同一个币最多查几笔交易是谁送出的（节点额度）；超过还没找到自己送的＝读不到、不算买过 */
const SKIP = new Set(['0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0x0bd7d308f8e1639fab988df18a8011f41eacad73']); // WBNB、稳定币、Robinhood WETH：不算「对项目动作」
const FUND = new Set(['0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x0bd7d308f8e1639fab988df18a8011f41eacad73']);
const lc = (x) => String(x || '').toLowerCase(); const pad = (a) => '0x' + lc(a).slice(2).padStart(64, '0'); const ADDR_CHUNK = 200; /* 节点限制：一次 eth_getLogs 带的地址数（分批查，名单全部都会看到；不是名单上限） */
export function startSmart({ rpc, log, tg, S, save, radarSet }) {
  const RH = 'https://rpc.mainnet.chain.robinhood.com';
  const rhRpc = async (m, p) => { const j = await (await fetch(RH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(20000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const CH = { bsc: { rpc, step: 1200, name: 'BNB Chain' }, robinhood: { rpc: rhRpc, step: 6000, name: 'Robinhood' } }; /* step＝一次最多往回读几个区块（节点限制；更早的接着下一轮读） */
  const NRn = (k) => globalThis.NR?.num?.(k) ?? null, NRon = (k) => !!globalThis.NR?.on?.(k);
  S.smartW = S.smartW || {}; const Z = S.smartW; Z.last = Z.last || {}; Z.related = Z.related || {}; Z.seen = Z.seen || {}; Z.events = Z.events || []; /* 用自己的栏位，不跟其他功能的资料混在一起 */
  const list = () => { const o = {}; for (const x of Array.isArray(radarSet()['smart.wallets']) ? radarSet()['smart.wallets'] : []) { const a = lc(x?.addr); if (/^0x[0-9a-f]{40}$/.test(a)) o[a] = String(x.label || '聪明钱包').slice(0, 30); } if (NRon('smart.related')) for (const [a, r] of Object.entries(Z.related)) /* 「相关钱包也算」＝你的开关，预设关 */ if (!o[a] && o[r.of]) o[a] = (o[r.of] || '') + ' 的相关钱包'; return o; };
  const symCache = {};
  async function symOf(ch, c) { const k = ch + c; if (symCache[k]) return symCache[k]; try { const h = await CH[ch].rpc('eth_call', [{ to: c, data: '0x95d89b41' }, 'latest']); const b = Buffer.from(h.slice(2), 'hex'); const n = b.length >= 96 ? Number(BigInt('0x' + b.slice(32, 64).toString('hex'))) : 0; symCache[k] = (n ? b.slice(64, 64 + Math.min(n, 20)).toString('utf8') : b.toString('utf8')).replace(/\0/g, '').trim() || c.slice(0, 8); } catch { symCache[k] = c.slice(0, 8); } return symCache[k]; }
  let busy = false;
  async function tick() {
    if (busy) return; busy = true; try {
      const L = list(); const addrs = Object.keys(L); if (!addrs.length) return;
      for (const [ch, C] of Object.entries(CH)) {
        let head; try { head = parseInt(await C.rpc('eth_blockNumber', []), 16); } catch { continue; }
        let from = Z.last[ch] ? Z.last[ch] + 1 : head - 200; if (head - from > C.step) from = head - C.step; if (from > head) continue;
        const q = (topics) => C.rpc('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16), topics }]).catch(() => null);
        let outL = [], inL = []; for (let i = 0; i < addrs.length; i += ADDR_CHUNK) { const padded = addrs.slice(i, i + ADDR_CHUNK).map(pad); const o1 = await q([T, padded]); const i1 = await q([T, null, padded]); if (o1 == null || i1 == null) { outL = null; break; } outL.push(...o1); inL.push(...i1); } if (outL == null) inL = null; /* 名单全部都看：节点一次能带的地址有限 → 分批查；有一批读不到＝这轮整个重来（不会跳过任何钱包） */
        if (outL == null && inL == null) continue; Z.last[ch] = head;
        const acts = {};
        for (const [l, dir] of [...(inL || []).map((l) => [l, '买']), ...(outL || []).map((l) => [l, '卖'])]) {
          const tok = lc(l.address); const who = lc('0x' + (dir === '买' ? l.topics[2] : l.topics[1]).slice(26)); const other = lc('0x' + (dir === '买' ? l.topics[1] : l.topics[2]).slice(26));
          if (!L[who]) continue;
          if (dir === '卖' && FUND.has(tok) && !L[other] && other !== '0x' + '0'.repeat(40)) { // 聪明钱包把钱转给别人 → 可能是它的小号
            const code = await C.rpc('eth_getCode', [other, 'latest']).catch(() => '0x'); if (NRon('smart.related') && code === '0x' && !Z.related[other] && (NRn('smart.relatedMax') == null || Object.keys(Z.related).length < NRn('smart.relatedMax'))) { /* 最多记几个相关钱包＝你的设定（没填＝不限） */ Z.related[other] = { of: Z.related[who]?.of || who, at: Date.now(), ch }; log(`[聪明钱包] 找到相关钱包 ${other}（${L[who]} 转钱给它）`); } }
          if (SKIP.has(tok)) continue;
          const k = ch + '|' + tok + '|' + dir; (acts[k] = acts[k] || { ch, tok, dir, who: new Set(), n: 0, tx: l.transactionHash, txs: new Set(), blk: l.blockNumber, by: who }).who.add(who); acts[k].n++; if (l.transactionHash) acts[k].txs.add(l.transactionHash);
        }
        for (const A of Object.values(acts)) {
          const key = A.ch + A.tok + A.dir; Z.nt = Z.nt || {}; const prev = Z.nt[key]; const dm = NRn('smart.dedupMin'); const dup = !!(prev && dm != null && Date.now() - prev < dm * 60e3); /* 同一个币同方向多久内只通知一次＝你的设定（没填＝每次都通知）；「聪明钱包买过」的时间照样记 */
          /* 要知道延迟多久；「买」只算钱包自己送出的交易（别人空投、硬塞进来的垃圾币不算） */
          let ago = ''; let unk = 0; if (A.dir === '买') { /* 每一笔交易都看是谁送出的；至少一笔是聪明钱包自己送的才算「买」；读不到＝不算买过（读不到＝不买） */ let own = 0, gift = 0; for (const h of [...A.txs].slice(0, TX_CHECK_MAX)) { let tx = null; try { tx = await C.rpc('eth_getTransactionByHash', [h]); } catch {} if (!tx) { unk = 1; continue; } const fromW = String(tx.from || '').toLowerCase(); if (A.who.has(fromW) || L[fromW]) own = 1; else gift = 1; } if (own) unk = 0; else if (gift && !unk) A.gift = 1; if (A.txs.size > TX_CHECK_MAX && !own) unk = 1; } try { const b = A.blk ? await C.rpc('eth_getBlockByNumber', [A.blk, false]) : null; const sec = b ? Math.max(0, Math.round(Date.now() / 1000 - parseInt(b.timestamp, 16))) : null; if (sec != null) ago = sec < 90 ? `｜链上 ${sec} 秒前` : `｜链上 ${Math.round(sec / 60)} 分钟前`; } catch {}
          if (!A.gift && !unk) Z.seen[key] = Date.now(); if (dup) continue; Z.nt[key] = Date.now(); /* 别人硬塞进来的不算「买过」 */
          const sym = await symOf(A.ch, A.tok); const names = [...A.who].map((a) => L[a]).join('、');
          const ev = { at: Date.now(), ch: A.ch, tok: A.tok, sym, dir: A.dir, who: [...A.who], names, gift: A.gift ? 1 : 0, ...(unk ? { unk: 1 } : {}) }; Z.events.push(ev); if (Z.events.length > 300) Z.events.splice(0, Z.events.length - 300);
          await tg(`🦋 聪明钱包${A.gift ? '收到别人转进来的币（不是它自己买）' : unk ? '收到币（读不到是不是它自己买的，不算买过）' : A.dir === '买' ? '在买' : '在卖'}：${sym}（${CH[A.ch].name}）\n${names}${A.who.size > 1 ? ` 等 ${A.who.size} 个钱包` : ''}｜${A.n} 笔${ago}\n${A.tok}`).catch(() => {});
        }
      }
      { const ever = (NRon('rh.needSmart') && NRn('rh.smartWinH') == null) || (NRon('gen.needSmart') && NRn('gen.smartWinH') == null); const keepMs = Math.max((NRn('smart.dedupMin') ?? 0) * 60e3, (NRn('rh.smartWinH') ?? 0) * 3600e3, (NRn('gen.smartWinH') ?? 0) * 3600e3); if (!ever) for (const [k, t] of Object.entries(Z.seen)) if (Date.now() - t > keepMs) delete Z.seen[k]; for (const [k, t] of Object.entries(Z.nt || {})) if (Date.now() - t > (NRn('smart.dedupMin') ?? 0) * 60e3) delete Z.nt[k]; } /* 记录至少留到你设的时间窗（「买过就算」＝一直留），不会被偷偷截短 */
      save();
    } catch (e) { log('[聪明钱包] 出错 ' + e.message); } finally { busy = false; }
  }
  setInterval(tick, 20e3).unref(); setTimeout(tick, 20e3); log('[聪明钱包] 监控启动');
}
