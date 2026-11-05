// 罗宾猫雷达 · 空投页（引擎这边）：截止日／领取日 TG 提醒、链上自动打勾、钱包交互统计
// 只读链上资料，不下单、不碰钱。结果写 data/air_state.json 给雷达画面看。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
export function startAir({ DIR, WALLETS, rpc, log, tgSay, radarSet }) {
  const F = join(DIR, 'data', 'air_state.json');
  let A = (() => { try { return JSON.parse(readFileSync(F, 'utf8')); } catch { return {}; } })();
  A.auto = A.auto || {}; A.days = A.days || {}; A.sent = A.sent || {};
  const save = () => { try { writeFileSync(F, JSON.stringify(A)); } catch {} };
  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10); };
  const tasks = () => (Array.isArray(radarSet().tasks) ? radarSet().tasks : []).filter((x) => x && x.id);
  const RH = 'https://rpc.mainnet.chain.robinhood.com';
  const rhRpc = async (m, p) => { const j = await (await fetch(RH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }), signal: AbortSignal.timeout(15000) })).json(); if (j.error) throw new Error(j.error.message); return j.result; };
  const R = (ch) => (ch === 'rh' ? rhRpc : rpc);

  // ① ⑤ 截止日前一天、领取日当天：发一次 TG。几点以后才发＝你的设定 air.remindHour（没填＝当天第一次检查就发）
  function remind() {
    const z0 = radarSet(); const on = (k) => Number(z0[k]) === 1; if (!on('air.remind') && !on('air.liveClaimTg') && !on('air.fundTg')) return; /* 空投 TG 提醒＝你的开关（预设关） */
    const d = today(), h = new Date().getHours(); const rh0 = Number(radarSet()['air.remindHour']); if (radarSet()['air.remindHour'] != null && radarSet()['air.remindHour'] !== '' && Number.isFinite(rh0) && h < rh0) return; const msg = [];
    if (on('air.remind')) for (const x of tasks()) {
      if (x.deadline && x.deadline === addDays(d, 1) && A.sent['dl' + x.id] !== d && !x.closed) { A.sent['dl' + x.id] = d; msg.push(`⏰ 明天截止：${x.name}${x.url ? '\n' + x.url : ''}`); }
      if (x.claimAt && x.claimAt === d && A.sent['cl' + x.id] !== d) { A.sent['cl' + x.id] = d; msg.push(`🎉 今天可以领：${x.name}${x.url ? '\n' + x.url : ''}`); }
    }
    /* 清单里追踪的空投，airdrops.io 显示「可以领了」→ 发一次 TG */
    if (on('air.liveClaimTg')) try { const H = JSON.parse(readFileSync(join(DIR, 'data', 'air_hot.json'), 'utf8')); const live = new Map((H.list || []).filter((y) => y.claim).map((y) => [y.url, y])); for (const x of tasks()) { if (x.closed || !x.url || !live.has(x.url) || A.sent['cl' + x.id + 'live']) continue; A.sent['cl' + x.id + 'live'] = Date.now(); msg.push(`🎉 可以领了：${x.name}\n${x.url}\n（领取前先确认网址是官方的，不要连主钱包到不认识的网站）`); } } catch {}
    /* 清单里追踪的空投，本地查到融资了 → 发一次 TG */
    if (on('air.fundTg')) try { const H = JSON.parse(readFileSync(join(DIR, 'data', 'air_hot.json'), 'utf8')); const fm = new Map((H.list || []).filter((y) => y.det?.fund && y.det?.fsrc).map((y) => [y.url, y])); for (const x of tasks()) { const y = fm.get(x.url); if (x.closed || !x.url || !y || A.sent['fd' + x.id]) continue; A.sent['fd' + x.id] = Date.now(); msg.push(`💰 查到融资：${x.name}\n${y.det.fund}${y.det.led ? '（' + y.det.led + '）' : ''} · 来源 ${y.det.fsrc}${y.det.fsnip ? '\n' + String(y.det.fsnip).slice(0, 300) : ''}`); } } catch {}
    if (msg.length) { save(); tgSay('🎁 空投提醒\n' + msg.join('\n\n')).catch(() => {}); }
  }
  const TXC = new Map(), BTC = new Map(); /* 技术用快取：交易→送出的钱包、区块→时间 */
  const txFrom = async (ch, h) => { if (!h) return null; const k = ch + h; if (TXC.has(k)) return TXC.get(k); try { const t = await R(ch)('eth_getTransactionByHash', [h]); const f = t?.from ? String(t.from).toLowerCase() : null; if (f) { TXC.set(k, f); if (TXC.size > 5000) TXC.delete(TXC.keys().next().value); } return f; } catch { return null; } };
  const blkTs = async (ch, bn) => { const k = ch + bn; if (BTC.has(k)) return BTC.get(k); try { const b = await R(ch)('eth_getBlockByNumber', [bn, false]); const t = b?.timestamp ? parseInt(b.timestamp, 16) : null; if (t != null) { BTC.set(k, t); if (BTC.size > 5000) BTC.delete(BTC.keys().next().value); } return t; } catch { return null; } };
  // ② 链上自动打勾：任务填了合约，今天这个钱包有跟它互动（事件里出现这个钱包）就打勾
  let busy = 0;
  async function autoCheck() {
    if (busy) return; busy = 1;
    try {
      const d = today(); const T = tasks().filter((x) => x.daily && /^0x[0-9a-fA-F]{40}$/.test(x.contract || '')); if (!T.length) return; /* 你清单里的任务全部都查 */
      for (const x of T) {
        const ch = x.chain === 'rh' ? 'rh' : 'bsc'; const ws = (Array.isArray(x.wallets) && x.wallets.length ? x.wallets : WALLETS.map((w) => w.addr)).map((a) => String(a).toLowerCase());
        const st = (A.auto[x.id] = A.auto[x.id]?.d === d ? A.auto[x.id] : { d, w: [], from: 0 }); const need = ws.filter((a) => !st.w.includes(a)); if (!need.length) continue;
        const head = parseInt(await R(ch)('eth_blockNumber', []), 16); const day0 = new Date(d + 'T00:00:00').getTime(); const bps = ch === 'rh' ? 4 : 2.2; /* 链的出块速度估计，只用来决定从哪一块开始读（是不是今天由区块时间判断） */
        let from = Math.max(st.from || 0, head - Math.ceil(((Date.now() - day0) / 1000) * bps)); const pads = need.map((a) => '0x000000000000000000000000' + a.slice(2));
        for (let b = from; b <= head; b += 5000) { const to = Math.min(b + 4999, head); let L = []; try { L = await R(ch)('eth_getLogs', [{ address: x.contract.toLowerCase(), fromBlock: '0x' + b.toString(16), toBlock: '0x' + to.toString(16) }]); } catch { break; } for (const l of L || []) { const tp = (l.topics || []).map((t) => t.toLowerCase()); const dat = String(l.data || '').toLowerCase(); const hit = need.filter((a, i) => !st.w.includes(a) && (tp.includes(pads[i]) || dat.includes(pads[i].slice(26)))); if (!hit.length) continue;
            /* 只有「这个钱包自己送出的交易」而且「今天的区块」才打勾（别人转给你、昨天的都不算）；读不到就这次不打勾 */ const tx = await txFrom(ch, l.transactionHash); if (!tx || !hit.includes(tx)) continue; const ts = await blkTs(ch, l.blockNumber); if (ts == null || ts * 1000 < day0) continue; st.w.push(tx); } st.from = to + 1; }
        save();
      }
    } catch (e) { log('空投自动打勾 ' + e.message); } finally { busy = 0; }
  }
  // ⑦ 钱包交互统计：每天记一次交易笔数，算活跃天数
  async function stats() {
    const d = today();
    for (const W of WALLETS) { const a = W.addr; const o = (A.days[a] = A.days[a] || { bsc: {}, rh: {} });
      for (const ch of ['bsc', 'rh']) { try { const n = parseInt(await R(ch)('eth_getTransactionCount', [a, 'latest']), 16); if (Number.isFinite(n)) o[ch][d] = n; } catch {} const ks = Object.keys(o[ch]).sort(); if (ks.length > 400) for (const k of ks.slice(0, ks.length - 400)) delete o[ch][k]; } }
    save();
  }
  // ⑧ 挖矿部位：你参加的挖矿（官方清单里按了「提醒我」的、你自己加的）→ data/mine_pos.json 给持仓页。读得到才给数字，读不到＝null，不猜
  const A40 = (x) => (/^0x[0-9a-fA-F]{40}$/.test(String(x || '')) ? String(x).toLowerCase() : '');
  const mineMine = () => { const z = radarSet(); let R = {}; try { R = JSON.parse(readFileSync(join(DIR, 'data', 'remote.json'), 'utf8')) || {}; } catch {} const sid = (x) => String(x?.id || '').replace(/[^\w.-]/g, '').slice(0, 40); const star = new Set(Array.isArray(z['mine.star']) ? z['mine.star'].map(String) : []);
    const of = (Array.isArray(R.mine) ? R.mine : []).filter((x) => x && /^https:\/\//.test(String(x.url || ''))).map((x) => ({ ...x, _id: 'of:' + (sid(x) || String(x.url).slice(8, 120)), _src: 'official' })).filter((x) => star.has(x._id));
    const my = (Array.isArray(z['mine.my']) ? z['mine.my'] : []).filter((x) => x && /^https:\/\//.test(String(x.url || ''))).map((x) => ({ ...x, _id: 'my:' + sid(x), _src: 'mine' }));
    const adp = []; /* AGC-BACK：雷达会挖的 AGC —— 你按了「提醒我」、开了自动挖、或钱包里还有押着的，就列进挖矿部位（数字照引擎读到的 data/mine_adp.json；读不到＝null） */
    try { const J = JSON.parse(readFileSync(join(DIR, 'data', 'mine_adp.json'), 'utf8')); const v = J?.agc; if (v && typeof v === 'object') { const ws = Array.isArray(v.wallets) ? v.wallets : []; const f = v.facts && typeof v.facts === 'object' ? v.facts : {};
      const sum = (k) => { const a = ws.map((x) => x?.[k]).filter((x) => Number.isFinite(x)); return a.length ? a.reduce((p, q) => p + q, 0) : null; };
      let lw = null; for (const x of ws) if (/^\d+$/.test(String(x?.lockedWei ?? ''))) lw = lw == null ? BigInt(x.lockedWei) : lw + BigInt(x.lockedWei);
      const nx = ws.map((x) => x?.nextAt).filter((x) => Number.isFinite(x) && x > 0); const lockedN = sum('lockedN');
      if (star.has('ad:agc') || +v.on === 1 || lockedN > 0) adp.push({ name: 'AGC', url: 'https://agcc.fun', chain: 'bsc', rewardTok: A40(f.tok), status: Number.isFinite(f.until) && Number.isFinite(f.now) ? (f.until > f.now ? '' : 'live') : '', _id: 'ad:agc', _src: 'adp',
        _agc: { on: +v.on === 1 ? 1 : 0, maxN: Number.isFinite(v.maxN) ? v.maxN : null, lockedWei: lw != null ? lw.toString() : null, lockedN, due: sum('due'), nextAt: nx.length ? Math.min(...nx) : null, today: sum('today'), at: +J.at || null } }); } } catch {}
    /* POL-MINE：雷达会参与的 Pol · Proof of Liquidity —— 你按了「提醒我」、开了自动参与、或钱包里还有仓位，就列进挖矿部位（数字照引擎读到的 data/mine_adp.json；读不到＝null） */
    try { const J = JSON.parse(readFileSync(join(DIR, 'data', 'mine_adp.json'), 'utf8')); const v = J?.pol; if (v && typeof v === 'object') { const ws = Array.isArray(v.wallets) ? v.wallets : []; const f = v.facts && typeof v.facts === 'object' ? v.facts : {};
      const sum = (k) => { const a = ws.map((x) => x?.[k]).filter((x) => Number.isFinite(x)); return a.length ? a.reduce((p, q) => p + q, 0) : null; };
      let cw = null; for (const x of ws) if (/^\d+$/.test(String(x?.claimWei ?? ''))) cw = cw == null ? BigInt(x.claimWei) : cw + BigInt(x.claimWei);
      const nx = ws.map((x) => x?.nextAt).filter((x) => Number.isFinite(x) && x > 0); const shares = sum('shares');
      if (star.has('ad:pol') || +v.on === 1 || shares > 0) adp.push({ name: 'Pol · Proof of Liquidity', url: 'https://proofmine.fun', chain: 'bsc', rewardTok: '0xbea84fadd77644b92ea1c5f3ce335666489fe5f7', status: f.launched === 1 ? 'live' : f.launched === 0 ? 'soon' : '', _id: 'ad:pol', _src: 'adp',
        _pol: { on: +v.on === 1 ? 1 : 0, maxDay: Number.isFinite(v.maxDay) ? v.maxDay : null, perTx: Number.isFinite(v.perTx) ? v.perTx : null, slip: Number.isFinite(v.slip) ? v.slip : null, launched: f.launched === 1 ? 1 : f.launched === 0 ? 0 : null, shares, open: sum('open'), due: sum('due'), claimWei: cw != null ? cw.toString() : null, nextAt: nx.length ? Math.min(...nx) : null, today: sum('today'), at: +v.at || null } }); } } catch {}
    return [...of, ...my, ...adp]; };
  const dsTok = async (tok) => { try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tok, { signal: AbortSignal.timeout(15000) })).json(); const ps = (Array.isArray(j?.pairs) ? j.pairs : []).filter((p) => String(p?.baseToken?.address || '').toLowerCase() === tok); if (!ps.length) return { px: null, liq: null }; const top = ps.reduce((a, b) => ((+b?.liquidity?.usd || 0) > (+a?.liquidity?.usd || 0) ? b : a)); const px = +top.priceUsd; const liq = +top?.liquidity?.usd; return { px: px > 0 ? px : null, liq: Number.isFinite(liq) && liq >= 0 ? liq : null }; } catch { return { px: null, liq: null }; } };
  const decOf = async (ch, tok) => { try { const r = await R(ch)('eth_call', [{ to: tok, data: '0x313ce567' }, 'latest']); return r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : null; } catch { return null; } };
  const balOf = async (ch, tok, a) => { try { const r = await R(ch)('eth_call', [{ to: tok, data: '0x70a08231' + a.slice(2).padStart(64, '0') }, 'latest']); return r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null; } catch { return null; } };
  const fmtQ = (b, d) => { const s0 = b.toString().padStart(d + 1, '0'); const i = s0.slice(0, s0.length - d), f = d ? s0.slice(-d).replace(/0+$/, '') : ''; return f ? i + '.' + f : i; };
  let mpBusy = 0; const MP = new Map(); /* 这一轮读到的价格／池子（流动性提醒共用） */
  async function minePos() { if (mpBusy) return; mpBusy = 1; try { const L = mineMine(); const out = []; MP.clear();
    for (const x of L) { const ch = x.chain === 'rh' ? 'rh' : x.chain === 'bsc' ? 'bsc' : ''; const tok = A40(x.rewardTok); const it = { id: x._id, src: x._src, name: String(x.name || '').slice(0, 40), url: String(x.url).slice(0, 200), chain: x.chain || '', token: tok || null, status: ['live', 'soon', 'ended'].includes(x.status) ? x.status : null, costUsd: Number.isFinite(+x.costUsd) && x.costUsd !== '' && x.costUsd != null && +x.costUsd >= 0 ? +x.costUsd : null, qty: null, priceUsd: null, valueUsd: null, liqUsd: null, wallets: [], why: '', ...(x._agc ? { agc: x._agc } : {}), ...(x._pol ? { pol: x._pol } : {}) }; /* POL-MINE */ /* AGC-BACK：押着多少、可领几笔（只显示） */
      if (!tok) { it.why = '没有奖励代币合约，读不到数量'; out.push(it); continue; } if (!ch) { it.why = '这条链雷达读不到'; out.push(it); continue; }
      const d = await decOf(ch, tok); const q = await dsTok(tok); it.priceUsd = q.px; it.liqUsd = q.liq; MP.set(x._id, { x, ...q });
      let tot = 0n, allOk = d != null; for (const W of WALLETS) { const b = d == null ? null : await balOf(ch, tok, W.addr); if (b == null) allOk = false; else tot += b; const qty = b == null ? null : fmtQ(b, d); it.wallets.push({ w: W.name, addr: W.addr, qty, valueUsd: qty != null && q.px != null ? Math.round(Number(qty) * q.px * 100) / 100 : null }); }
      if (allOk) { it.qty = fmtQ(tot, d); if (q.px != null) it.valueUsd = Math.round(Number(it.qty) * q.px * 100) / 100; } else it.why = d == null ? '读不到代币小数位数' : '有钱包读不到余额';
      out.push(it); }
    try { writeFileSync(join(DIR, 'data', 'mine_pos.json.tmp'), JSON.stringify({ at: Date.now(), items: out })); renameSync(join(DIR, 'data', 'mine_pos.json.tmp'), join(DIR, 'data', 'mine_pos.json')); } catch {}
    liqRemind(); } catch (e) { log('挖矿部位 ' + e.message); } finally { mpBusy = 0; } }
  // ⑨ 挖矿池子流动性提醒：开关 mine.liqRemind（预设关）＋你填的「介于 mine.liqMin 到 mine.liqMax」U；读不到就不提醒；同一个项目进入区间只提醒一次（离开区间后再进来会再提醒）
  function liqRemind() { const NR = globalThis.NR; const on = (k) => (NR?.on ? NR.on(k) : Number(radarSet()[k]) === 1); const num = (k) => (NR?.num ? NR.num(k) : null);
    if (!on('mine.liqRemind')) return; const lo = num('mine.liqMin'), hi = num('mine.liqMax'); if (lo == null && hi == null) return; A.liq = A.liq || {}; const notes = [];
    for (const [id, { x, liq }] of MP) { const nm = String(x.name || '').slice(0, 40); const lines = [];
      if (liq == null) { lines.push('… 池子流动性读不到 → 不提醒'); } else { if (lo != null) lines.push(`${liq >= lo ? '✅' : '❌'} 池子流动性 ${Math.round(liq)}U（你设至少 ${lo}U）`); if (hi != null) lines.push(`${liq <= hi ? '✅' : '❌'} 池子流动性 ${Math.round(liq)}U（你设最多 ${hi}U）`); }
      const hit = liq != null && (lo == null || liq >= lo) && (hi == null || liq <= hi); try { NR?.decLog?.('mine', id, nm, { buy: hit, text: (hit ? '提醒：' : '不提醒：') + lines.join('；'), lines, why: hit ? '' : lines.find((l) => !l.startsWith('✅')) || '' }, 1); } catch {}
      if (!hit) { if (A.liq[id] && liq != null) delete A.liq[id]; continue; } if (A.liq[id]) continue; A.liq[id] = Date.now();
      const r = x.risk && typeof x.risk === 'object' ? String(x.risk.text || '').slice(0, 200) : ''; const risk = r ? `⚠️ 风险提醒：${r}${x.risk.src ? '（来源：' + String(x.risk.src).slice(0, 40) + '）' : ''}` : '⚠️ 风险提醒：挖矿项目常被 DappBay 等安全网站标红色警报（合约有风险、可能拿不回本金），参与前请自己查清楚';
      notes.push({ at: Date.now(), id, name: nm, liqUsd: Math.round(liq), text: `⛏ ${nm} 的池子流动性到了你设的范围：约 ${Math.round(liq)}U\n${risk}\n${String(x.url || '').slice(0, 160)}` }); }
    if (!notes.length) return; save(); try { const f = join(DIR, 'data', 'mine_alerts.json'); let old = []; try { old = JSON.parse(readFileSync(f, 'utf8')); } catch {} const all = [...(Array.isArray(old) ? old : []), ...notes].slice(-MINE_ALERT_KEEP); writeFileSync(f + '.tmp', JSON.stringify(all)); renameSync(f + '.tmp', f); } catch {}
    for (const n of notes) tgSay(n.text + '\n（只是提醒，雷达不会帮你挖）').catch(() => {}); }
  const MINE_ALERT_KEEP = 200; /* 技术用：画面通知最多留几则 */
  setInterval(() => minePos().catch(() => {}), 10 * 60e3); setTimeout(() => minePos().catch(() => {}), 50e3);
  setInterval(remind, 10 * 60e3); setTimeout(remind, 30e3);
  setInterval(() => autoCheck().catch(() => {}), 30 * 60e3); setTimeout(() => autoCheck().catch(() => {}), 60e3);
  setInterval(() => stats().catch(() => {}), 60 * 60e3); setTimeout(() => stats().catch(() => {}), 45e3);
  log('空投页：提醒、链上自动打勾、钱包统计已启动');
}
