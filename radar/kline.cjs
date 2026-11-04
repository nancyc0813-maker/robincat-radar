'use strict';
/* KQ-1104：K 线共用的时间格子（只是画图用的管线，不影响买卖）。
   周线＝每周一 00:00 UTC 开始；月线＝每个日历月 1 号 00:00 UTC 开始；其他周期＝从 1970 起整除。
   本地成交、AVE、GeckoTerminal 合并、电脑和手机即时跳动都用同一套，K 棒才不会对不齐。 */
const WEEK = 604800, MONTH = 2592000, MON_OFF = 345600; /* 运作：一周秒数／「月线」代号秒数／1970-01-01 是周四，往后几天到周一的秒数 */
function bStart(tSec, sec) {
  if (sec === MONTH) { const d = new Date(tSec * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  if (sec === WEEK) return Math.floor((tSec - MON_OFF) / WEEK) * WEEK + MON_OFF;
  return Math.floor(tSec / sec) * sec;
}
function bNext(tSec, sec) {
  if (sec === MONTH) { const d = new Date(bStart(tSec, sec) * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000; }
  return bStart(tSec, sec) + sec;
}
/* 把 K 棒（t 毫秒）按格子合并、排序 */
function aggregate(L, sec) {
  const M = new Map();
  for (const x of [...L].sort((a, b) => a.t - b.t)) { const b = bStart(Math.floor(x.t / 1000), sec) * 1000; const o = M.get(b); if (!o) M.set(b, { t: b, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v || 0 }); else { o.h = Math.max(o.h, x.h); o.l = Math.min(o.l, x.l); o.c = x.c; o.v += x.v || 0; } }
  return [...M.values()].sort((a, b) => a.t - b.t);
}
/* 没有成交的格子补一根平的 K 棒（开高低收＝前一根收盘、量 0、gap: 1），横轴时间才是真的；给 nowMs 时最后一根之后到现在的格子也补；从最新往回补，补到 cap 根就停 */
function fillGaps(L, sec, cap, nowMs) {
  if (!L.length) return L; L = L.slice(); if (nowMs > 0) { const last = L[L.length - 1]; const nb = bStart(Math.floor(nowMs / 1000), sec) * 1000; for (let n = bNext(last.t / 1000, sec) * 1000, k = 0; n <= nb && k < cap; n = bNext(n / 1000, sec) * 1000, k++) L.push({ t: n, o: last.c, h: last.c, l: last.c, c: last.c, v: 0, gap: 1 }); } const out = [L[L.length - 1]];
  for (let i = L.length - 2; i >= 0 && out.length < cap; i--) { const a = L[i];
    for (let n = bStart(out[0].t / 1000 - 1, sec) * 1000; n > a.t && out.length < cap; n = bStart(n / 1000 - 1, sec) * 1000) out.unshift({ t: n, o: a.c, h: a.c, l: a.c, c: a.c, v: 0, gap: 1 });
    if (out.length < cap) out.unshift(a); }
  return out;
}
/* 雷达自己记的成交 → K 棒。u＝报价币美金价；读不到（0）就不画（不把 BNB 当美金） */
function fromTrades(tr, sec, u, cap, nowMs) {
  if (!(u > 0)) return { err: 'quote' };
  const seen = new Set(), T = [];
  for (const r of tr || []) { const k = r[5] ? 'k' + r[5] : r.slice(0, 5).join('|'); if (seen.has(k)) continue; seen.add(k); if (!(r[3] > 0)) continue; T.push(r); }
  T.sort((a, b) => a[0] - b[0]);
  const M = new Map();
  for (const r of T) { const t = bStart(r[0], sec) * 1000, p = r[3] * u; const o = M.get(t); if (!o) M.set(t, { t, o: p, h: p, l: p, c: p, v: r[2] * u }); else { o.h = Math.max(o.h, p); o.l = Math.min(o.l, p); o.c = p; o.v += r[2] * u; } }
  return fillGaps([...M.values()].sort((a, b) => a.t - b.t), sec, cap, nowMs);
}
/* 一段时间的涨跌：基准＝这段时间开始「之前」最后一笔的价格；之前没有成交就用这段时间第一笔；都没有＝null（显示「—」，不是 0） */
function winChg(tr, startSec, px) {
  if (!(px > 0)) return null; let pre = null, first = null;
  for (const r of tr || []) { if (!(r[3] > 0)) continue; if (r[0] < startSec) { if (!pre || r[0] >= pre[0]) pre = r; } else if (!first || r[0] < first[0]) first = r; }
  const base = pre || first; return base ? (px / base[3] - 1) * 100 : null;
}
module.exports = { bStart, bNext, aggregate, fillGaps, fromTrades, winChg, WEEK, MONTH };
