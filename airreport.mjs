// 罗宾猫雷达 · 每日空投雷达（AIRLOCAL-1126）：在你填的时间，把最近几天新出现的空投（data/air_hot.json，引擎／雷达视窗定时更新）整理成一则 TG。
// 全部是开关＋你填的数字（air.daily.on／air.daily.time／air.daily.days，预设关）；分组只看「事实」（来源标的已确认／可领取／热门榜、查到的融资、截止日），不用 AI、不打分数、不推荐。
// 推过的项目记在 data/air_daily.json，不会重复推；没有新项目就发「今日无新项目」。只读资料、不碰钱包、不下单。
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'; import { join } from 'node:path';
const T = { tickMs: 60e3, keepDays: 180, tgMax: 3900, dayMs: 86400e3 }; /* 技术用：多久检查一次时间到了没、推过的纪录留几天、一则 TG 最多几个字（Telegram 一则上限 4096）、一天几毫秒 */
const TC = { hMax: 23, mMax: 59 }; /* 时钟的范围（几点、几分），不是门槛 */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; /* 这台电脑的日期 */
export function parseHM(v) { const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(String(v ?? '')); if (!m) return null; const h = +m[1], mi = +m[2]; return h <= TC.hMax && mi <= TC.mMax ? { h, mi } : null; } /* 「HH:MM」（照这台电脑的时间）；格式不对＝null */
/* 事实分组：来源（airdrops.io）标的状态；同一个项目只放在第一个符合的组 */
const GROUPS = [['claim', '✅ 已经可以领取'], ['confirmed', '📌 已确认会空投'], ['hot', '🔥 热门榜上'], ['latest', '🆕 最新收录']];
const groupOf = (x) => (x.claim ? 'claim' : x.confirmed ? 'confirmed' : (x.kinds || [x.kind]).includes('hot') ? 'hot' : 'latest');
function line(x) { const f = []; const d = x.det || {};
  if (d.fund) f.push(`融资：${d.fund}${d.led ? '（' + d.led + '）' : ''}${d.fsrc ? '（来源：' + d.fsrc + '）' : '（来源：airdrops.io）'}`);
  if (x.llama?.tvl > 0) f.push(`TVL：$${Math.round(x.llama.tvl).toLocaleString('en-US')}（DefiLlama）`);
  if (x.ends) f.push(`截止：${x.ends}`); if (d.chains?.length) f.push(`链：${d.chains.join('、')}`); if (d.cost) f.push(`成本：${d.cost}`);
  const req = (x.req || []).length ? `要求：${x.req.join('、')}` : '';
  return [`• ${x.name}`, f.length ? '  ' + f.join('｜') : '', x.act ? `  任务：${x.act}` : '', req ? '  ' + req : '', `  ${x.url}`].filter(Boolean).join('\n'); }
/* 组出一则讯息（纯函式，给测试用）。list＝air_hot.json 的 list；sent＝推过的 {url: 时间}；firstSeen＝{url: 第一次看到的时间} */
export function buildReport({ list, at, days, sent = {}, firstSeen = {}, now = Date.now() }) {
  const d0 = new Date(now); const today = ymd(d0); const m0 = new Date(d0); m0.setHours(0, 0, 0, 0); const from = m0.getTime() - days * T.dayMs; const out = []; /* 最近 N 天＝从 N 天前的 0 点（这台电脑的时间）到现在 */
  for (const x of list || []) { if (!x?.url || sent[x.url]) continue; if (x.ends && x.ends < today) continue; /* 已经截止的不列 */
    const t = x.pub ? Date.parse(x.pub + 'T00:00:00') : firstSeen[x.url]; if (!(t >= from)) continue; out.push(x); } /* 收录日期：来源的发布日；没有就用雷达第一次看到的时间 */
  const title = `🪂 每日空投雷达 ${pad(d0.getMonth() + 1)}/${pad(d0.getDate())}`; const foot = '⚠️ 以上只列来源上的事实（状态、融资、截止日），不是推荐，参与前请自己查证（DYOR）。';
  const src = `资料：airdrops.io${at ? '，更新于 ' + `${pad(new Date(at).getMonth() + 1)}/${pad(new Date(at).getDate())} ${pad(new Date(at).getHours())}:${pad(new Date(at).getMinutes())}` : ''}；最近 ${days} 天新收录`;
  if (!out.length) return { text: [title, src, '', '今日无新项目', '', foot].join('\n'), items: [] };
  const parts = [title, src]; const used = []; let more = 0;
  for (const [g, zh] of GROUPS) { const L = out.filter((x) => groupOf(x) === g).sort((a, b) => (b.heat || 0) - (a.heat || 0)); if (!L.length) continue; let head = false;
    for (const x of L) { const s = line(x); const cur = parts.join('\n').length + s.length + foot.length + (head ? 0 : zh.length + 2) + 80; if (cur > T.tgMax) { more++; continue; } if (!head) { parts.push('', zh); head = true; } parts.push(s); used.push(x); } }
  if (more) parts.push('', `另有 ${more} 个新项目放不下（一则 TG 有字数上限），请看雷达「空投」页`);
  parts.push('', foot); return { text: parts.join('\n'), items: used };
}
export function startAirReport({ DIR, radarSet, send, log, refresh = null, now = () => Date.now() }) {
  const SF = join(DIR, 'data', 'air_daily.json'), HF = join(DIR, 'data', 'air_hot.json');
  let ST = (() => { try { return JSON.parse(readFileSync(SF, 'utf8')); } catch { return {}; } })(); ST.sent ||= {}; ST.seen ||= {};
  const save = () => { try { writeFileSync(SF + '.w', JSON.stringify(ST)); renameSync(SF + '.w', SF); } catch (e) { log('[空投日报] 存档失败 ' + e.message); } };
  const get = (k) => radarSet()[k]; const on = (k) => { const v = get(k); return v === true || Number(v) === 1; }; const num = (k) => { const v = get(k); if (v == null || v === '' || typeof v === 'boolean') return null; const x = Number(v); return Number.isFinite(x) ? x : null; };
  let warned = '', hmt = 0; const seenTick = () => { try { const st = existsSync(HF) ? readFileSync(HF) : null; if (!st) return; const H = JSON.parse(st); if ((H.at || 0) === hmt) return; hmt = H.at || 0; let ch = 0; for (const x of H.list || []) if (x?.url && !ST.seen[x.url]) { ST.seen[x.url] = now(); ch = 1; } if (ch) save(); } catch {} }; /* 每次清单更新就记「第一次看到」 */
  async function tick(force = false) { seenTick();
    if (!on('air.daily.on')) return { sent: false, why: '没开' }; const hm = parseHM(get('air.daily.time')); const days = num('air.daily.days');
    const bad = !hm ? '你没填（或格式不对）「几点发」，例 15:00' : !(days > 0) ? '你没填「最近几天新出现的」' : ''; if (bad) { if (warned !== bad) { warned = bad; log('[空投日报] 没发：' + bad); } return { sent: false, why: bad }; }
    const t = now(), d = new Date(t), today = ymd(d); if (!force && (ST.lastDay === today || d.getHours() * 60 + d.getMinutes() < hm.h * 60 + hm.mi)) return { sent: false, why: '还没到时间或今天发过了' };
    try { await refresh?.(); } catch {} /* 发之前先让清单更新（清单够新就不会重抓；另一边正在抓就用它的） */ seenTick();
    let H = null; try { H = existsSync(HF) ? JSON.parse(readFileSync(HF, 'utf8')) : null; } catch {}
    if (!H?.list?.length) { const w = '空投清单还没有资料（来源读不到），先不发，之后再试'; if (warned !== w) { warned = w; log('[空投日报] ' + w); } return { sent: false, why: w }; } /* 读不到资料＝不发（不能说成「今日无新项目」） */
    const R = buildReport({ list: H?.list || [], at: H?.at || 0, days, sent: ST.sent, firstSeen: ST.seen, now: t });
    const ok = await send(R.text).catch(() => false); if (!ok) { log('[空投日报] TG 没送出（没设机器人／这一类没开／网路），下次检查再试'); return { sent: false, why: 'TG 没送出' }; }
    for (const x of R.items) ST.sent[x.url] = t; ST.lastDay = today; const cut = t - T.keepDays * T.dayMs; for (const m of [ST.sent, ST.seen]) for (const [k, v] of Object.entries(m)) if (v < cut) delete m[k]; save(); log(`[空投日报] 已发 ${R.items.length} 个新项目`); return { sent: true, n: R.items.length, text: R.text };
  }
  const h = setInterval(() => { tick().catch((e) => log('[空投日报] 出错 ' + String(e?.message || e))); }, T.tickMs); h.unref?.();
  return { tick, stop: () => clearInterval(h), ST: () => ST };
}
