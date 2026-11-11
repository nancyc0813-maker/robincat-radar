// 罗宾猫雷达 · 各链发射台自动买（MCA-1112）
// 候选：雷达视窗照你的设定去 AVE 抓（data/mca_cand.json）。引擎这里照你的条件判断（NR.judge，跟其他策略同一套组合方式），
// 过了就用 mctrade 送单——一样经过 W.baw 的统一动作闸门（自动买总开关、紧急全停、邀请绑定、钱包支援这条链都照查）。
// 全部开关预设关、数字空白：没开 mca.on、没选链、没填每笔金额、没填每天最多几笔、没选条件组合方式 → 不买。读不到资料＝不买。
// 同一个币只会自动买一次（记在 data/mca_state.json）。每个判断都写进逐条判断日志。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const MA = {
  loopMs: 15000,        /* 技术用：多久判断一轮 */
  staleMs: 180000,      /* 技术用：候选清单超过 3 分钟没更新＝雷达视窗没开或 AVE 读不到 → 当成读不到（不买） */
  keepBought: 5000,     /* 技术用：记住买过的币最多几个 */
  logRepeatMs: 600000,  /* 技术用：同一个币、同一个结果，10 分钟内只写一次判断日志 */
};
export const MCA_CHAINS = { solana: 'SOL', base: 'ETH' };
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

/* 条件：v＝null 读不到；跟 settings_schema.json 的 cond:'mca' 一一对应 */
export const mcaConds = (x, now = Date.now()) => [
  { k: 'mca.mcMin', name: '市值', unit: ' U', op: '>=', v: x.mc ?? null },
  { k: 'mca.mcMax', name: '市值', unit: ' U', op: '<=', v: x.mc ?? null },
  { k: 'mca.hMin', name: '持有人', unit: ' 个', op: '>=', v: x.h ?? null },
  { k: 'mca.ageMax', name: '发币多久', unit: ' 分钟', op: '<=', v: x.ca > 0 ? Math.max(0, (now / 1000 - (x.ca > 1e12 ? x.ca / 1000 : x.ca)) / 60) : null },
  { k: 'mca.pgMin', name: '内盘进度', unit: '%', op: '>=', v: x.pg ?? null },
  { k: 'mca.liqMin', name: '流动性', unit: ' U', op: '>=', v: x.tvl ?? null },
  { k: 'mca.v1Min', name: '1 小时成交量', unit: ' U', op: '>=', v: x.v1 ?? null },
  { k: 'mca.noHoney', name: 'AVE 没标成貔貅', op: 'yes', v: x.hp === 0 ? true : x.hp === 1 ? false : null },
];

export function startMcAuto({ DIR, WALLETS, log, tgSay, MCT }) {
  const NR = () => globalThis.NR;
  const on = (k) => { try { return !!NR()?.on(k); } catch { return false; } };
  const num = (k) => { try { const v = NR()?.num(k); return v == null || !Number.isFinite(+v) ? null : +v; } catch { return null; } };
  const SF = join(DIR, 'data', 'mca_state.json'), CF = join(DIR, 'data', 'mca_cand.json');
  let ST = { bought: {}, day: { d: today(), n: 0 }, seen: {} }; try { const o = JSON.parse(readFileSync(SF, 'utf8')); if (o && typeof o === 'object') ST = { bought: o.bought || {}, day: o.day || { d: today(), n: 0 }, seen: {} }; } catch {}
  const save = () => { try { writeFileSync(SF + '.w', JSON.stringify({ bought: ST.bought, day: ST.day })); renameSync(SF + '.w', SF); } catch {} };
  let staleSaid = 0, busy = 0, stopped = 0;
  const dec = (x, J) => { const key = x.ch + '|' + x.c, t = J.text || ''; const o = ST.seen[key]; if (o && o.t === t && Date.now() - o.at < MA.logRepeatMs) return; ST.seen[key] = { t, at: Date.now() }; try { NR()?.decLog?.('mca', x.c, `${x.sym || x.c.slice(0, 8)}（${x.ch}／${x.pad}）`, J); } catch { log(`[发射台自动买] ${x.sym} ${x.ch}：${t}`); } };

  async function tick() {
    if (!on('mca.on')) return;
    if (ST.day.d !== today()) { ST.day = { d: today(), n: 0 }; save(); }
    let C = null; try { C = JSON.parse(readFileSync(CF, 'utf8')); } catch {}
    if (!C || !Array.isArray(C.items) || Date.now() - (+C.at || 0) > MA.staleMs) { if (!staleSaid) { staleSaid = 1; log('[发射台自动买] 候选清单读不到或太旧（雷达视窗没开、AVE 读不到）→ 不买'); } return; } staleSaid = 0;
    const dayN = num('mca.dayN'); const seenNow = new Set();
    for (const x of C.items) {
      const key = x.ch + '|' + x.c; if (seenNow.has(key)) continue; seenNow.add(key); if (ST.bought[key]) continue;
      if (!MCA_CHAINS[x.ch]) continue;
      if (!on('mca.ch.' + x.ch)) continue; /* 没开的链＝根本不看（雷达视窗也不会抓） */
      const amt = num('mca.amt.' + x.ch); if (amt == null) { dec(x, { buy: false, text: `不买：你没填 ${x.ch} 每笔花多少 ${MCA_CHAINS[x.ch]}`, lines: [], why: '没填每笔金额' }); continue; }
      if (dayN == null) { dec(x, { buy: false, text: '不买：你没填「每天最多自动买几笔」', lines: [], why: '没填每天上限' }); continue; }
      if (ST.day.n >= dayN) { dec(x, { buy: false, text: `不买：今天已经自动买 ${ST.day.n} 笔（你设每天最多 ${dayN} 笔）`, lines: [], why: '到每天上限' }); continue; }
      let J; try { J = NR()?.judge ? NR().judge('mca', mcaConds(x)) : { buy: false, text: '设定还没载入，不会买', lines: [] }; } catch (e) { J = { buy: false, text: '判断出错，不买：' + String(e?.message || e).slice(0, 80), lines: [] }; }
      dec(x, J); if (!J.buy) continue;
      let cs = null; try { cs = globalThis.CUSTOM_SKIP?.({ chain: x.ch, type: 'token', c: x.c, sym: x.sym, mcUsd: x.mc, holders: x.h }); } catch {} if (cs) { dec(x, { buy: false, text: '不买：你的「我的规则」挡下：' + String(cs).slice(0, 80), lines: [], why: '我的规则' }); continue; }
      ST.bought[key] = Date.now(); ST.day.n++; { const ks = Object.keys(ST.bought); if (ks.length > MA.keepBought) for (const k of ks.slice(0, ks.length - MA.keepBought)) delete ST.bought[k]; } save(); /* 先记下来再送：送单出错也不会同一个币一直重送 */
      const r = await MCT.mctOrder({ type: 'buy', mc: x.ch, c: x.c, amt, name: x.sym || x.n || '', auto: 1 }, { DIR, WALLETS, log, tgSay }).catch((e) => ({ ok: 0, msg: String(e?.message || e) }));
      log(`[发射台自动买] ${x.sym} ${x.ch}（${x.pad}）${r?.ok ? '✅ 已买' : '没买成：' + String(r?.msg || '').slice(0, 120)}`);
    }
  }
  const loop = async () => { if (stopped) return; if (!busy) { busy = 1; try { await tick(); } catch (e) { try { log('[发射台自动买] 出错 ' + String(e?.message || e).slice(0, 160)); } catch {} } finally { busy = 0; } } setTimeout(loop, MA.loopMs); };
  setTimeout(loop, MA.loopMs);
  return { stop: () => { stopped = 1; }, tick, _st: () => ST };
}
