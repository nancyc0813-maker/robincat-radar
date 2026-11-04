// 罗宾猫雷达 · 交易日记：每一笔买卖都记下来（data/journal.jsonl），用户在雷达「持仓 → 交易日记」自己查询、汇出
// 做法：定时比对状态（持仓成本变多 = 买、卖出记录变多 = 卖），所以不管是哪个功能下的单都记得到
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
const COST_EPS = 0.001; /* 成本差小于这个（U）当成小数点误差，不是一笔买入 */
export function startJournal({ DIR, S, save, WALLETS, log, tg }) {
  const F = join(DIR, 'data', 'journal.jsonl');
  const wn = (a) => (WALLETS.find((w) => w.addr === a) || {}).name || (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const J_MAX = 20e6, J_KEEP = 50000; /* 技术用：日记档太大时只留最近的一段（档案大小），不影响买卖 */
  const put = (r) => { try { appendFileSync(F, JSON.stringify({ at: Date.now(), ...r }) + '\n'); if (statSync(F).size > J_MAX) { const L = readFileSync(F, 'utf8').split('\n').filter(Boolean); writeFileSync(F + '.tmp', L.slice(-J_KEEP).join('\n') + '\n'); renameSync(F + '.tmp', F); } } catch (e) { log('日记写入失败 ' + e.message); } };
  const JID = new Set(); try { for (const l of readFileSync(F, 'utf8').slice(-4e6).split('\n')) { if (!l.includes('"jid"')) continue; try { const x = JSON.parse(l); if (x.jid) JID.add(String(x.jid)); } catch {} } } catch {} /*RISK-FIX3 H：已经记过的（重开雷达时状态还没存档也不会重记） */
  const putJ = (jid, r) => { jid = String(jid); if (JID.has(jid)) return; JID.add(jid); if (JID.size > 60000) { const it = JID.values(); for (let i = 0; i < 20000; i++) JID.delete(it.next().value); } put({ ...r, jid }); };
  const tkJ = (t) => [t.at, t.sym, t.w, t.usd, t.pct ?? '', t.c || t.addr || ''].join('|');
  const jk = (t) => t.addr + '|' + t.only + (t.boughtAt ? '|' + t.boughtAt : ''); /*AMT-1 每一笔持仓自己的键（卖光后重买＝新的一笔）*/ const rk = (c, a, w) => c + '|' + a + (w && w.at ? '|' + w.at : '');
  function snap() {
    const tk = (t) => t ? [t.at, t.sym, t.w, t.usd].join('|') : ''; const last = (a) => tk((a || [])[(a || []).length - 1]);
    const o = { dyn: {}, rh: {}, btK: last(S.trades), rhK: last(S.rh?.trades), rmK: last(S.rh?.mintLog), bnK: last(S.bscNft?.log), plK: {} };
    for (const t of S.dyn || []) { if (t.closed) continue; o.dyn[jk(t)] = +(t.cost || 0); } /*AMT-1 已结束的不算*/
    for (const [c, P] of Object.entries(S.rh?.pos || {})) for (const [a, w] of Object.entries(P.w || {})) o.rh[rk(c, a, w)] = +(w.cost || 0);
    for (const [id, p] of Object.entries(S.plug || {})) o.plK[id] = last(p.trades);
    return o;
  }
  if (!S.jPrev) { S.jPrev = snap(); save(); } /* 从现在开始记 */
  const after = (a, k) => { a = a || []; if (!k) return a; for (let i = a.length - 1; i >= 0; i--) if ([a[i].at, a[i].sym, a[i].w, a[i].usd].join('|') === k) return a.slice(i + 1); const tv = (v) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : Date.parse(String(v).replace(/\//g, '-')) || 0); const t0 = tv(k.split('|')[0]); return a.filter((x) => tv(x.at) > t0); }; /* 用最后一笔的内容对，不用位置，旧记录被裁掉也不会漏记 */
  function tick() { try {
    const P = S.jPrev, N = snap();
    for (const t of S.dyn || []) { if (t.closed) continue; const k = jk(t); const d = +(t.cost || 0) - (P.dyn[k] ?? P.dyn[t.addr + '|' + t.only] ?? 0); /*AMT-1 旧格式的键相容*/ if (d > COST_EPS) putJ('b|' + k + '|' + (+(t.cost || 0)).toFixed(4), { chain: 'BSC', src: '雷达', side: '买', sym: t.sym, token: t.addr, wallet: wn(t.only), usd: +d.toFixed(2) }); }
    for (const t of P.btK === undefined ? (S.trades || []).slice(P.bt || 0) : after(S.trades, P.btK)) putJ('s|' + tkJ(t), { chain: 'BSC', src: '雷达', side: '卖', sym: t.sym, ...(t.addr ? { token: String(t.addr).toLowerCase() } : {}), wallet: t.w, usd: t.usd, got: t.bnb ? t.bnb + ' BNB' : '', note: t.why || '', cp: t.cp || 0, manual: t.manual || 0 }); /* 带合约地址（同名币分得开） */
    for (const [c, Q] of Object.entries(S.rh?.pos || {})) for (const [a, w] of Object.entries(Q.w || {})) { const d = +(w.cost || 0) - ((P.rh || {})[rk(c, a, w)] || 0); /*AMT-1 没有 at 的旧部位键跟以前一样*/ if (d > COST_EPS) putJ('rb|' + rk(c, a, w) + '|' + (+(w.cost || 0)).toFixed(4), { chain: 'Robinhood', src: '雷达', side: '买', sym: Q.sym, token: c, wallet: wn(a), usd: +d.toFixed(2) }); }
    for (const t of P.rhK === undefined ? (S.rh?.trades || []).slice(P.rht || 0) : after(S.rh?.trades, P.rhK)) putJ('rs|' + tkJ(t), { chain: 'Robinhood', src: '雷达', side: '卖', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.ok ? (t.usd ?? null) : null, note: `${t.pct}%｜${t.why}${t.ok ? '' : '（失败）'}`, cp: t.ok ? (t.cp || 0) : 0, manual: t.manual || 0, ...(t.ok ? {} : { fail: 1 }) }); /* 失败的卖出明确标 fail（每周检讨不算） */
    if (P.rmK !== undefined) for (const t of after(S.rh?.mintLog, P.rmK).filter((x) => x.nft)) putJ('rm|' + tkJ(t), { chain: 'Robinhood', src: '雷达 铸造', side: '买', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.usd, note: t.nft ? 'NFT' : '' });
    if (P.bnK !== undefined) for (const t of after(S.bscNft?.log, P.bnK)) putJ('bn|' + tkJ(t), { chain: 'BSC', src: '雷达 NFT 铸造', side: '买', sym: t.sym, token: t.c, wallet: wn(t.w), usd: t.usd, note: 'NFT' });
    for (const [id, p] of Object.entries(S.plug || {})) for (const t of P.plK === undefined ? (p.trades || []).slice((P.pl || {})[id] || 0) : after(p.trades, P.plK[id])) putJ('pl|' + id + '|' + tkJ(t) + '|' + (t.side || ''), { chain: 'BSC', src: '外挂 ' + id, side: t.side, sym: t.sym, wallet: wn(t.w), usd: t.usd, got: t.got || '', stable: t.stable || '' });
    const ch = JSON.stringify(N) !== JSON.stringify(P); S.jPrev = N; if (ch) save(); /* 没变就不存档 */
  } catch (e) { log('日记出错 ' + e.message); } }
  setInterval(tick, 10e3).unref();
  // ── 每周检讨：你的开关（预设关）＋你选的星期几、几点（电脑时间）；全部本地算、不用 AI；建议只用问句，不会改设定 ──
  const setv = () => { try { return JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8')) || {}; } catch { return {}; } };
  const on = (k) => (globalThis.NR?.on ? globalThis.NR.on(k) : Number(setv()[k]) === 1);
  const numv = (k) => { if (globalThis.NR?.num) return globalThis.NR.num(k); const v = setv()[k]; return v == null || v === '' ? null : Number(v); };
  const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  async function weekly(force) { try {
    const now = new Date(); const key = dkey(now);
    if (!force) { if (!on('weekly.on')) return null; const d = numv('weekly.day'), h = numv('weekly.hour'); if (!(d >= 1 && d <= 7) || !(Number.isInteger(h) && h >= 0 && h <= 23)) return null; /* 没选星期几／几点＝不产生 */ const wd = now.getDay() === 0 ? 7 : now.getDay(); if (wd !== d || now.getHours() !== h || S.weeklyAt === key) return null; S.weeklyAt = key; save(); }
    const { buildWeekly } = await import('./weekly.mjs'); const R = buildWeekly({ DIR, S, now: Date.now() }); R.auto = force ? 0 : 1;
    mkdirSync(join(DIR, 'data', 'weekly'), { recursive: true }); writeFileSync(join(DIR, 'data', 'weekly', key + (force ? '-' + String(now.getHours()).padStart(2, '0') : '') + '.json'), JSON.stringify(R));
    if (!force && on('weekly.tg')) tg?.(R.text)?.catch?.(() => {}); log('每周检讨已产生' + (force ? '（手动）' : '')); return R;
  } catch (e) { log('每周检讨出错 ' + e.message); return null; } }
  setInterval(() => { weekly(false); }, 60e3).unref();
  // ── 挖矿每日提醒：你的开关（预设关）＋你选的几点；只提醒你按了「⏰ 提醒我」的项目，不会帮你挖 ──
  const riskTxt = (x) => { const r = x && typeof x.risk === 'object' && x.risk ? x.risk : null; const t = r ? String(r.text || '').slice(0, 200) : ''; return t ? `\n  ⚠️ 风险提醒：${t}${r.src ? '（来源：' + String(r.src).slice(0, 40) + '）' : ''}${/^https:\/\//.test(String(x.riskUrl || '')) ? ' ' + String(x.riskUrl).slice(0, 200) : ''}` : ''; }; /* 只照资料里写的，不自己推测 */
  function mineRemind() { try {
    if (!on('mine.remind')) return; const h = numv('mine.remindHour'); const now = new Date(); if (!(Number.isInteger(h) && now.getHours() === h)) return; const key = dkey(now); if (S.mineRemAt === key) return;
    const z = setv(); const star = new Set(Array.isArray(z['mine.star']) ? z['mine.star'].map(String) : []); if (!star.size) return; S.mineRemAt = key; save();
    let R = {}; try { R = JSON.parse(readFileSync(join(DIR, 'data', 'remote.json'), 'utf8')) || {}; } catch {}
    const sid = (x) => String(x.id || '').replace(/[^\w.-]/g, '').slice(0, 40); /* 跟画面（radar/next.cjs）同一套编号 */ const all = [...(Array.isArray(R.mine) ? R.mine : []).map((x) => ({ ...x, _id: 'of:' + (sid(x) || String(x.url || '').slice(8, 120)) })), ...(Array.isArray(z['mine.my']) ? z['mine.my'] : []).map((x) => ({ ...x, _id: 'my:' + sid(x) }))].filter((x) => x && star.has(x._id) && x.status !== 'ended' && /^https:\/\//.test(String(x.url || '')));
    if (!all.length) return; tg?.(`⏰ 挖矿提醒（你按了「提醒我」的项目）\n` + all.map((x) => `· ${String(x.name || '').slice(0, 40)}${x.cost === 'free' ? '（免费）' : x.cost === 'deposit' ? '（要存钱）' : ''}${x.kind === 'checkin' ? ' · 每日签到' : ''}${riskTxt(x)}\n  ${String(x.url || '').slice(0, 120)}`).join('\n') + '\n（只是提醒，雷达不会帮你挖）')?.catch?.(() => {}); log('挖矿提醒已发 ' + all.length + ' 个');
  } catch (e) { log('挖矿提醒出错 ' + e.message); } }
  setInterval(mineRemind, 60e3).unref();
  /* 清单项目有「开始时间」→ 到点发一次 TG（开关 mine.startRemind，预设关）；只在雷达开着、看到它还没开始时才会提醒（不会补发过去的） */
  function mineStartRemind() { try {
    if (!on('mine.startRemind')) return; /* 开始时间提醒＝你的开关（预设关） */ let R = {}; try { R = JSON.parse(readFileSync(join(DIR, 'data', 'remote.json'), 'utf8')) || {}; } catch { return; } /* 这次读不到（可能正在写）→ 下次再看，不清记录 */
    const z = setv(); const sid = (x) => String(x.id || '').replace(/[^\w.-]/g, '').slice(0, 40);
    const all = [...(Array.isArray(R.mine) ? R.mine : []).map((x) => ({ ...x, _id: 'of:' + (sid(x) || String(x.url || '').slice(8, 120)) })), ...(Array.isArray(z['mine.my']) ? z['mine.my'] : []).map((x) => ({ ...x, _id: 'my:' + sid(x) }))].filter((x) => x && /^https:\/\//.test(String(x.url || '')));
    const live = all.filter((x) => x.status !== 'ended'); /* 已结束的不提醒（跟每日提醒一样） */
    const now = Date.now(); S.mineStart = S.mineStart || {}; let ch = 0; const due = [];
    for (const x of live) { const t0 = typeof x.startAt === 'number' ? x.startAt : Date.parse(String(x.startAt || '')); if (!Number.isFinite(t0) || !(t0 > 0)) continue; const t = t0 < 1e12 ? t0 * 1000 : t0; const k = x._id + '@' + t; const st = S.mineStart[k];
      if (t > now) { if (!st) { S.mineStart[k] = 'wait'; ch = 1; } continue; } if (st === 'wait') { S.mineStart[k] = 'sent'; ch = 1; due.push(x); } }
    for (const k of Object.keys(S.mineStart)) { const id = k.slice(0, k.lastIndexOf('@')); if (!all.some((x) => x._id === id)) { delete S.mineStart[k]; ch = 1; } } /* 清单拿掉的项目，记录也清掉 */
    if (ch) save(); if (!due.length) return;
    tg?.(`⏰ 挖矿开始了\n` + due.map((x) => `· ${String(x.name || '').slice(0, 40)}${riskTxt(x)}\n  ${String(x.url || '').slice(0, 120)}`).join('\n') + '\n（只是提醒，雷达不会帮你挖；不想收到可以在设定关掉「挖矿开始时间提醒」）')?.catch?.(() => {}); log('挖矿开始提醒已发 ' + due.length + ' 个');
  } catch (e) { log('挖矿开始提醒出错 ' + e.message); } }
  setInterval(mineStartRemind, 60e3).unref(); globalThis.__mineStartRemind = mineStartRemind; /* 测试用 */
  globalThis.__mineRemind = mineRemind; /* 测试用 */
  return { weekly };
}
