
// 全部在你电脑上算，不用 AI：交易日记（data/journal.jsonl）＋逐条判断日志（data/decisions.jsonl）＋看盘存下来的成交（回测资料，data/market_*.json）
// ＋最近一次回测（data/backtest_last.json）。只产生报告；建议一律用「问句」，绝对不会自己改你的设定。
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SNAME = { bsc: '铸造代币（AI 项目）', tok: 'AI 热门代币', gen: '一般新币', rh: 'Robinhood 热门代币', rhmint: 'Robinhood 铸造', nft: 'BNB Chain NFT 铸造', force: '强制打', manual: '手动买', plug: '外挂／小工具', other: '其他' };
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const readJ = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const md = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
/* 判断日志的一行 → 条件名称：「✅ 进度 N%（你设至少 X%）」→「进度」 */
export function condName(line) { const m = /^(✅|❌|⚠️|…)\s*(.+)$/.exec(String(line || '')); if (!m) return null; let t = m[2].replace(/（.*$/, '').replace(/读不到.*$/, '').replace(/还没查.*$/, '').replace(/\s*→.*$/, '').trim(); t = t.replace(/\s+-?[\d.,]+\s*\S*$/, '').trim(); return t ? { ok: m[1] === '✅', bad: m[1] === '❌' || m[1] === '⚠️', name: t.slice(0, 30) } : null; }

/* 行情资料（看盘读链存下来的最近成交）：某个币在 t 之后的价格表现（只算比值，不需要换算成美元） */
function priceIndex(DIR) { const T = {}; for (const f of ['market_bsc.json', 'market_bsc_v4.json', 'market_rh.json']) { const D = readJ(join(DIR, 'data', f), null); for (const [c, x] of Object.entries(D?.tokens || {})) if (Array.isArray(x?.tr) && x.tr.length) T[String(c).toLowerCase()] = x.tr; } return T; }
export function after(tr0, tMs) { if (!Array.isArray(tr0) || !tr0.length) return null; const tr = tr0.slice().sort((a, b) => a[0] - b[0]); /* 成交不一定照时间排 */ const t = tMs / 1000; let p0 = null, i0 = -1; for (let i = 0; i < tr.length; i++) { if (tr[i][0] <= t) { p0 = tr[i][3]; i0 = i; } else break; } if (p0 == null) return null; if (!(p0 > 0)) return null; let hi = p0; for (let i = i0 + 1; i < tr.length; i++) hi = Math.max(hi, tr[i][3]); const last = tr[tr.length - 1][3]; return { peak: hi / p0, last: last / p0, n: tr.length - i0 - 1 }; }

export function buildWeekly({ DIR, S = {}, now = Date.now(), days = 7 } = {}) { /* 统计门槛照你的设定 */ const SET0 = readJ(join(DIR, 'data', 'radar_settings.json'), {}) || {}; const numS = (k) => { const v = SET0[k]; return v == null || v === '' || !isFinite(+v) ? null : +v; }; const UPX = numS('weekly.upX'), DNP = numS('weekly.dnPct');
  const since = now - days * 86400e3;
  const J = readLines(join(DIR, 'data', 'journal.jsonl')).filter((x) => x.at >= since && x.at <= now);
  const DEC = readLines(join(DIR, 'data', 'decisions.jsonl')).filter((x) => x.at <= now); /* 买的那笔判断可能在这周之前，全部都读 */
  const BT = readJ(join(DIR, 'data', 'backtest_last.json'), null);
  const PX = priceIndex(DIR);
  /* 哪个策略买的：判断日志里「买」的那一笔（id＝代币或铸造合约）＋持仓标记 */
  /* 「条件通过」(stage cond) 不等于买到。实际买到＝判断日志的结果记录 res=bought，或交易日记里真的有这个币的买进 */
  const realBuy = new Set(); for (const d of DEC) if (d.stage === 'result' && d.res === 'bought') realBuy.add(String(d.id || '').toLowerCase());
  const mintTok0 = new Map(); for (const [c, P] of Object.entries(S.paid || {})) if (P?.tok) mintTok0.set(String(P.tok).toLowerCase(), String(c).toLowerCase());
  for (const x of readLines(join(DIR, 'data', 'journal.jsonl'))) if (x.side === '买' && x.token) { const tk = String(x.token).toLowerCase(); realBuy.add(tk); if (mintTok0.has(tk)) realBuy.add(mintTok0.get(tk)); }
  const decBuy = new Map(); for (const d of DEC) { const id = String(d.id || '').toLowerCase(); if (d.stage !== 'result' && d.buy && realBuy.has(id)) decBuy.set(id, d); }
  const dynTag = new Map(); for (const t of S.dyn || []) { const a = String(t.addr || '').toLowerCase(); dynTag.set(a, t.src === 'force' ? 'force' : t.src === 'manual' ? 'manual' : t.src === 'gen' ? 'gen' : t.tok ? 'tok' : 'bsc'); }
  const mintTok = new Map(); for (const [c, P] of Object.entries(S.paid || {})) if (P?.tok) mintTok.set(String(P.tok).toLowerCase(), c);
  const stratOf = (x) => { const tk = String(x.token || '').toLowerCase(); if (/^外挂/.test(x.src || '')) return 'plug'; if (/NFT/.test(x.src || '') || x.note === 'NFT') return x.chain === 'Robinhood' ? 'rhmint' : 'nft'; if (x.chain === 'Robinhood') return /铸造/.test(x.src || '') ? 'rhmint' : decBuy.get(tk)?.sid || 'rh'; const d = decBuy.get(tk) || decBuy.get(mintTok.get(tk) || '-'); if (dynTag.get(tk) === 'force' || dynTag.get(tk) === 'manual') return dynTag.get(tk); return d?.sid || dynTag.get(tk) || 'other'; };
  /* 每个币：买进多少、卖回多少（E1：照合约地址分；卖出只有币名的旧记录才用币名配对；分批卖用那一笔对应的成本 cp 算已实现损益；失败的卖出不算） */
  const symTok = new Map(); for (const x of J) if (x.side === '买' && x.token) { const k = (x.chain || '') + '|' + String(x.sym || '').toLowerCase(); const tk = String(x.token).toLowerCase(); symTok.set(k, symTok.has(k) && symTok.get(k) !== tk ? '' : tk); }
  const keyOf = (x) => { const tk = String(x.token || '').toLowerCase(); if (tk) return (x.chain || '') + '|' + tk; const t2 = symTok.get((x.chain || '') + '|' + String(x.sym || '').toLowerCase()); return (x.chain || '') + '|' + (t2 || 'sym:' + String(x.sym || '').toLowerCase()); };
  const isFail = (x) => !!x.fail || /（失败）/.test(String(x.note || ''));
  const by = {}; let unkN = 0; for (const x of J) { if (x.side !== '买' && isFail(x)) continue; const k = keyOf(x); const o = (by[k] = by[k] || { sym: x.sym || '', chain: x.chain || '', token: '', buy: 0, sell: 0, sells: 0, unk: 0, real: 0, realOk: true, notes: [], first: x.at, strat: null }); if (!o.token && x.token) o.token = String(x.token).toLowerCase(); if (!o.token && k.split('|')[1].startsWith('0x')) o.token = k.split('|')[1];
    if (x.side === '买') { o.buy += +x.usd || 0; o.strat = o.strat || stratOf(x); continue; }
    if (x.usd == null || !isFinite(+x.usd)) { o.unk++; unkN++; continue; } /* 换回多少不明：不算卖出、不算结束 */
    o.sell += +x.usd; o.sells++; if (+x.cp > 0) o.real += +x.usd - +x.cp; else o.realOk = false; if (x.note) o.notes.push(String(x.note)); }
  const heldTok = new Set([...(S.dyn || []).filter((t) => !t.closed).map((t) => 'BSC|' + String(t.addr || '').toLowerCase()), ...Object.entries(S.rh?.pos || {}).filter(([, P]) => Object.keys(P?.w || {}).length).map(([c]) => 'Robinhood|' + String(c).toLowerCase())]);
  const heldSym = new Set([...(S.dyn || []).filter((t) => !t.closed).map((t) => 'BSC|' + String(t.sym || '').toLowerCase()), ...Object.values(S.rh?.pos || {}).filter((P) => Object.keys(P?.w || {}).length).map((P) => 'Robinhood|' + String(P?.sym || '').toLowerCase())]);
  const isHeld = (o) => (o.token ? heldTok.has(o.chain + '|' + o.token) : heldSym.has(o.chain + '|' + String(o.sym).toLowerCase()));
  const pos = Object.values(by).filter((o) => o.buy > 0 || o.sells > 0 || o.unk > 0); for (const o of pos) o.strat = o.strat || 'other';
  for (const o of pos) { o.held = isHeld(o); o.isClosed = o.sells > 0 && !o.held && !o.unk; o.pnl = o.sells ? (o.realOk ? r2(o.real) : o.buy > 0 && o.isClosed ? r2(o.sell - o.buy) : null) : null; }
  const closed = pos.filter((o) => o.isClosed && o.pnl != null);
  const partial = r2(pos.filter((o) => !o.isClosed && o.pnl != null).reduce((a, o) => a + o.pnl, 0));
  const win = closed.filter((o) => o.pnl >= 0).length; const buyU = r2(pos.reduce((a, o) => a + o.buy, 0)), sellU = r2(pos.reduce((a, o) => a + o.sell, 0)); const pnl = r2(closed.reduce((a, o) => a + o.pnl, 0));
  const best = closed.filter((o) => o.pnl >= 0).sort((a, b) => b.pnl - a.pnl).map((o) => ({ sym: o.sym, pnl: o.pnl, strat: SNAME[o.strat] || o.strat })), worst = closed.filter((o) => o.pnl < 0).sort((a, b) => a.pnl - b.pnl).map((o) => ({ sym: o.sym, pnl: o.pnl, strat: SNAME[o.strat] || o.strat })); /* 赚的、赔的全部列（不只前几名） */
  const sm = {}; for (const o of pos) { const s0 = (sm[o.strat] = sm[o.strat] || { k: o.strat, name: SNAME[o.strat] || o.strat, n: 0, closed: 0, win: 0, pnl: 0, buy: 0 }); s0.n++; s0.buy = r2(s0.buy + o.buy); if (o.isClosed && o.pnl != null) { s0.closed++; s0.pnl = r2(s0.pnl + o.pnl); if (o.pnl >= 0) s0.win++; } else if (o.pnl != null) s0.pnl = r2(s0.pnl + o.pnl); }
  const byStrat = Object.values(sm).sort((a, b) => a.pnl - b.pnl);
  /* 哪些条件「过了」的那几笔赚／赔 */
  const cm = {}; for (const o of closed) { const d = decBuy.get(o.token) || decBuy.get(mintTok.get(o.token) || '-'); if (!d) continue; for (const l of d.lines || []) { const c = condName(l); if (!c || !c.ok) continue; const k = (SNAME[d.sid] || d.sid) + '｜' + c.name; const e = (cm[k] = cm[k] || { strat: SNAME[d.sid] || d.sid, name: c.name, n: 0, win: 0, pnl: 0 }); e.n++; e.pnl = r2(e.pnl + o.pnl); if (o.pnl >= 0) e.win++; } }
  const byCond = Object.values(cm).sort((a, b) => a.pnl - b.pnl);
  /* 跳过的项目后来怎样：每个项目看这周最后一次「不买」的判断 */
  const lastSkip = new Map(); const bought = realBuy; for (const d of DEC) { if (d.at < since || d.stage === 'result' || d.buy) continue; const id = String(d.id || '').toLowerCase(); if (bought.has(id)) continue; const p = lastSkip.get(id); if (!p || d.at > p.at) lastSkip.set(id, d); }
  const sk = { n: lastSkip.size, withData: 0, up2: 0, dn50: 0, upX: UPX, dnPct: DNP, list: [], blockers: {}, mint: { n: 0, filled: 0, unknown: 0 } };
  for (const [id, d] of lastSkip) {
    const fails = (d.lines || []).map(condName).filter((c) => c && c.bad).map((c) => c.name);
    if (d.sid === 'bsc' || d.sid === 'nft' || d.sid === 'rhmint') { sk.mint.n++; const P = S.paid?.[id]; const full = !!S.missed?.[id] || !!P?.soldOut || (P?.progress != null && P.progress >= 1); if (full) { sk.mint.filled++; sk.list.push({ name: d.name || id.slice(0, 8), sid: d.sid, what: '后来铸满了', fails }); for (const f0 of fails) sk.blockers[f0] = (sk.blockers[f0] || 0) + 1; } else if (!P) sk.mint.unknown++; continue; }
    const a = after(PX[id], d.at); if (!a) continue; sk.withData++;
    if (UPX != null && a.peak >= UPX) { sk.up2++; for (const f0 of fails) sk.blockers[f0] = (sk.blockers[f0] || 0) + 1; }
    if (DNP != null && a.last <= 1 - DNP / 100) sk.dn50++;
    sk.list.push({ name: d.name || id.slice(0, 8), sid: d.sid, peak: r2(a.peak), last: r2(a.last), fails });
  }
  sk.list.sort((x, y) => (y.what ? 1 : 0) - (x.what ? 1 : 0) || (y.peak || 0) - (x.peak || 0)); /* 铸满的先列，其他照最高涨幅；全部列出 */
  const blockers = Object.entries(sk.blockers).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n); delete sk.blockers;
  /* 建议：一律是问句，不给数字、不会自己改设定 */
  const Q = [];
  if (!J.length) Q.push('这一周没有成交：是策略没开、还是条件太严？要不要到「自订策略」看看每个策略的判断说明？');
  for (const b of blockers) Q.push(`「${b.name}」挡掉了 ${b.n} 个后来${UPX != null ? '涨到 ' + UPX + ' 倍以上（或铸满）' : '铸满'}的项目，要不要重新看一下这个条件的数字？`);
  for (const c of byCond) if (c.pnl < 0) Q.push(`${c.strat}：过了「${c.name}」才买的 ${c.n} 笔合计 ${c.pnl}U，这个条件是不是还不够严？`);
  if (BT && !BT.err && BT.done > 0 && closed.length > 0 && (BT.rate || 0) > win / closed.length) Q.push(`回测的胜率（${Math.round(BT.rate * 100)}%）比实际（${Math.round((win / closed.length) * 100)}%）高，是不是实际买入时机比回测晚（速度、滑点）？`);
  const R = { at: now, from: since, to: now, days, trades: { n: J.length, pos: pos.length, closed: closed.length, open: pos.filter((o) => !o.isClosed).length, win, rate: closed.length ? r2(win / closed.length) : null, buyU, sellU, pnl, partial, unk: unkN }, best, worst, byStrat, byCond, skipped: { ...sk, blockers }, backtest: BT && !BT.err ? { at: BT.at || null, net: BT.net || '', n: BT.n || 0, done: BT.done || 0, rate: BT.rate ?? null, pnl: BT.pnl ?? null, params: BT.params || null } : null, questions: Q };
  R.text = weeklyText(R); return R;
}

export function weeklyText(R) {
  const T = R.trades, L = [];
  L.push(`📊 罗宾猫雷达 · 每周检讨（${md(R.from)}～${md(R.to)}）`);
  L.push(`交易 ${T.n} 笔｜买进 ${T.buyU}U｜卖回 ${T.sellU}U`);
  L.push(`已结束 ${T.closed} 个，赚的 ${T.win} 个${T.rate != null ? `（胜率 ${Math.round(T.rate * 100)}%）` : ''}｜已结束的损益 ${T.pnl >= 0 ? '+' : ''}${T.pnl}U｜还拿着 ${T.open} 个${T.partial ? `（已卖掉部分的损益 ${T.partial >= 0 ? '+' : ''}${T.partial}U）` : ''}${T.unk ? `｜卖出结果不明 ${T.unk} 笔（没算进去）` : ''}`);
  if (R.best.length) L.push('最好：' + R.best.map((o) => `${o.sym} ${o.pnl >= 0 ? '+' : ''}${o.pnl}U`).join('、'));
  if (R.worst.length) L.push('最差：' + R.worst.map((o) => `${o.sym} ${o.pnl}U`).join('、'));
  if (R.byStrat.length) { L.push('', '各策略：'); for (const s of R.byStrat) L.push(`· ${s.name}：${s.n} 笔，已结束 ${s.closed}（赚 ${s.win}），损益 ${s.pnl >= 0 ? '+' : ''}${s.pnl}U`); }
  if (R.byCond.length) { L.push('', '条件（过了这个条件才买的那几笔）：'); for (const c of R.byCond) L.push(`· ${c.strat}「${c.name}」：${c.n} 笔，合计 ${c.pnl >= 0 ? '+' : ''}${c.pnl}U`); }
  const K = R.skipped; L.push('', `跳过的项目：${K.n} 个${K.withData ? `（有行情的 ${K.withData} 个${K.upX != null ? `：后来最高涨到 ${K.upX} 倍以上 ${K.up2} 个` : ''}${K.dnPct != null ? `${K.upX != null ? '、' : '：'}跌 ${K.dnPct}% 以上 ${K.dn50} 个` : ''}${K.upX == null && K.dnPct == null ? '；「涨到几倍／跌多少」的统计要先在设定填数字' : ''}）` : ''}${K.mint.n ? `｜铸造项目 ${K.mint.n} 个，后来铸满 ${K.mint.filled} 个` : ''}`);
  if (K.n && !K.withData && !K.mint.filled) L.push('（行情资料只保留最近一段时间，比较早跳过的看不到后来的表现）');
  for (const x of K.list) L.push(`· ${x.name}：${x.what || `最高 ${x.peak} 倍、现在 ${x.last} 倍`}${x.fails.length ? `（挡下的条件：${x.fails.join('、')}）` : ''}`);
  if (K.blockers.length) L.push('最常挡掉「后来会涨／铸满」的条件：' + K.blockers.map((b) => `${b.name}×${b.n}`).join('、'));
  if (R.backtest) L.push('', `最近一次回测（${R.backtest.at ? md(R.backtest.at) : '-'}）：${R.backtest.done} 笔、胜率 ${R.backtest.rate != null ? Math.round(R.backtest.rate * 100) + '%' : '-'}、损益 ${R.backtest.pnl ?? '-'}U`);
  if (R.questions.length) { L.push('', '想一想（雷达不会自己改你的设定）：'); for (const q of R.questions) L.push('❓ ' + q); }
  return L.join('\n');
}

export function listWeekly(DIR) { const out = []; try { const d = join(DIR, 'data', 'weekly'); if (!existsSync(d)) return out; for (const f of readdirSync(d).filter((x) => /^\d{4}-\d{2}-\d{2}(-\d{2})?\.json$/.test(x)).sort().reverse()) { const j = readJ(join(d, f), null); if (j) out.push(j); } } catch {} return out; }
