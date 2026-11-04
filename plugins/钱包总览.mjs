// 钱包总览（官方范本，只看不买）：两条链的余额一次看完，钱不够打下一笔会提醒你。
// 每分钟更新，显示在雷达「🧩 我的面板」。想加别的资料？叫你的 AI 照这个档案改（api.balances 读余额、api.fetchJson 读公开行情、api.panel 交给雷达显示）。
export const meta = {
  id: 'wallets', name: '钱包总览', nameEn: 'Wallet overview', everySec: 60, dayUsd: 0,
  desc: '只看不买：每个钱包在 BNB Chain、Robinhood 的余额合计；钱不够打下一笔（照你设定的每笔金额自动算）会在面板标出来。', descEn: 'View only: balances on BSC and Robinhood per wallet, with low-balance warnings.',
};
export async function tick(api) {
  const b = await api.balances(); const items = [];
  if (!b || !Array.isArray(b.w) || !b.w.length) { api.panel({ title: '钱包总览', items: [{ type: 'alert', text: '还读不到钱包余额：请先在「设定 → 钱包」登入，雷达开着约 1 分钟后就会出现。', tone: 'warn' }] }); return; }
  const bp = Number(b.bnbUsd) > 0 ? Number(b.bnbUsd) : null, ep = Number(b.ethUsd) > 0 ? Number(b.ethUsd) : null; /*AMT-10 价格 ≤0＝读不到（不当成 $0）*/ const f = (v, d) => (Number(v) || 0).toFixed(d);
  /* 她 11/2 05:11：不另外设提醒门槛（跟雷达自己的余额提醒重复），直接照「每笔金额」算够不够打下一笔 */
  const cp = b.caps || {}; const gasB = Number(cp.gasBnb) > 0 ? Number(cp.gasBnb) : null; /* ZR-1103：手续费 BNB＝你在底线填的「至少留 BNB」，没填＝未填（不估） */ const gasU = gasB != null && bp != null ? gasB * bp : 0; const needB = Math.max(Number(cp.bscMint) || 0, Number(cp.bscTok) || 0) + gasU; const needR = Math.max(Number(cp.rh) || 0, Number(cp.rhMint) || 0);
  let tb = 0, tr = 0, part = false; const rows = []; const g = (v, d) => (v == null ? '—' : f(v, d));
  let tbU = false, trU = false; /*AMT-10 有余额但读不到价格＝这份值多少不知道 */
  for (const w of b.w) { if (w.bsc?.BNB == null || w.bsc?.USDT == null || w.bsc?.USDC == null || w.rh?.ETH == null) part = true; const bsc = bp == null && Number(w.bsc?.BNB) > 0 ? null : (w.bsc?.BNB || 0) * (bp || 0) + (w.bsc?.USDT || 0) + (w.bsc?.USDC || 0); const rh = ep == null && Number(w.rh?.ETH) > 0 ? null : (w.rh?.ETH || 0) * (ep || 0); if (bsc == null) { tbU = true; part = true; } else tb += bsc; if (rh == null) { trU = true; part = true; } else tr += rh;
    rows.push([w.name, g(w.bsc?.BNB, 4), g(w.bsc?.USDT, 2), g(w.bsc?.USDC, 2), g(w.rh?.ETH, 5), bsc == null || rh == null ? '—' : '$' + f(bsc + rh, 1)]);
    if (bsc != null && needB > 0 && bsc < needB) items.push({ type: 'alert', text: `[${w.name}] BNB Chain 只剩约 ${f(bsc, 1)}U，不够打下一笔（要约 ${f(needB, 1)}U）。叫你的 AI 换一些 BNB 进来（手续费也要 BNB）。`, tone: 'dn' });
    if (w.rh?.ETH != null && rh != null && needR > 0 && rh < needR) items.push({ type: 'alert', text: `[${w.name}] Robinhood 链上 ETH 约 ${f(rh, 1)}U，不够打下一笔（要约 ${f(needR, 1)}U）。雷达不能帮你跨链，叫你的 AI 把 BNB 跨到 Robinhood 换成 ETH。`, tone: 'dn' }); }
  items.unshift({ type: 'stat', label: '全部合计', value: tbU || trU ? '—' : '$' + f(tb + tr, 1), sub: `${b.w.length} 个钱包` }, { type: 'stat', label: 'BNB Chain', value: tbU ? '—' : '$' + f(tb, 1), sub: `BNB ${bp == null ? '—（读不到价格）' : '$' + f(bp, 0)}` }, { type: 'stat', label: 'Robinhood', value: trU ? '—' : '$' + f(tr, 1), sub: `ETH ${ep == null ? '—（读不到价格）' : '$' + f(ep, 0)}` });
  if (gasB == null) items.push({ type: 'text', text: '手续费 BNB：未填（到「设定 → 底线」填「买入／铸造后至少留 BNB」，这里才会把手续费算进去）' });
  items.push({ type: 'table', cols: ['钱包', 'BNB', 'USDT', 'USDC', 'ETH（Robinhood）', '合计'], rows });
  const s = api.state; s.h = Array.isArray(s.h) ? s.h : []; /* NEW-100 */ if (!part) s.h.push([Date.now(), +(tb + tr).toFixed(2)]); else items.push({ type: 'text', text: '有些余额或价格这一分钟读不到（节点／行情没回应），这一分钟不记走势，下一分钟会再读。' }); if (s.h.length > 1440) s.h.splice(0, s.h.length - 1440);
  /* 她 11/2 15:13：走势要能看 1 天到一个月 → 每分钟的留 1 天，另外每小时记一笔、留 31 天 */
  s.hh = Array.isArray(s.hh) ? s.hh : []; if (!part && (!s.hh.length || Date.now() - s.hh[s.hh.length - 1][0] >= 3600e3)) s.hh.push([Date.now(), +(tb + tr).toFixed(2)]); if (s.hh.length > 24 * 31) s.hh.splice(0, s.hh.length - 24 * 31);
  const t1 = s.h.length ? s.h[0][0] : Date.now(); const pts = [...s.hh.filter((q) => q[0] < t1), ...s.h];
  if (pts.length > 1) items.push({ type: 'line', label: '钱包总值走势（美元）', points: pts, ranges: [1, 3, 7, 14, 30] });
  api.panel({ title: '钱包总览', items });
}
