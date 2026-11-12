// BOARD124 罗宾猫雷达 · 转接站自己抓的 AVE 看盘（不再靠作者电脑上传签名档）
// 只读：向 AVE 抓「各发射台清单＋热门榜」与「看得到的币的即时价格」，存在 Durable Object「ave-board2」的记忆体，所有用户共用一份。
// 有人在看才抓（共用快取）；Cron 每分钟只在最近有人看时帮忙保鲜。金钥只在 Cloudflare 秘密变数 AVE_KEY。
// 全部数字都是 wrangler.toml [vars] 的营运设定（程式里没有写死的数字）：
//   AVE_BOARD_TAGS      发射台清单 tag（逗号分隔；AVE 不认的 tag 会自动跳过 AVE_BOARD_BAD_S 秒，不会一直扣额度）
//   AVE_BOARD_TRENDING  热门榜要抓哪些链（逗号分隔，例：bsc,robinhood,solana,eth,base）
//   AVE_BOARD_LIMIT     每个 tag 一次抓几个（AVE 上限 300）；AVE_BOARD_TREND_N 热门榜每页几个（AVE 上限 100）
//   AVE_BOARD_LIST_S    清单几秒重抓一次；AVE_BOARD_PRICE_S 看得到的币价格几秒刷新一次
//   AVE_BOARD_PRICE_TOPN 每个清单前几名算「看得到」；AVE_BOARD_PRICE_N 一次价格查询最多几个（AVE 上限 200）
//   AVE_BOARD_IDLE_S    多久没人看就不再背景抓（Cron 也停）；AVE_BOARD_BAD_S AVE 不认的 tag 多久后再试
//   AVE_BOARD_KEEP_S    清单里没再出现的币留多久（往下滑看得到更多）
//   AVE_BOARD_AUTO_SUFFIX 自动找发射台：清单里看到的发射台名字（issue_platform）加这些字尾当 tag 去抓（例：_in_new,_out_hot）；留空＝不自动找
//   AVE_BOARD_AUTO_MAX  自动找最多几个发射台（照看到的币数排）
//   AVE_BOARD_KIND_NEW／AVE_BOARD_KIND_HOT 不分平台的清单 tag 放哪个分页（新创建／热门外盘），例 new／hot,bsc_hot
//   AVE_BOARD_TREND_PAGES 热门榜每条链抓几页；AVE_BOARD_SEEN_MAX 搜寻／详情查到的币最多收几个进看盘
//   AVE_BOARD_BACKOFF_S AVE 回 429／额度用尽、或当月累计到 AVE_MONTH_STOP_CU 时，看盘停多久再试
import { scoutRun } from './scout.js'; /*SCOUT-1112*/
const num = (v) => { if (v === '' || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const okUrl = (u) => (/^https:\/\/[^\s"'<>]{4,300}$/.test(String(u || '')) ? String(u) : '');
export const envN = (env, k) => { const v = Number(env?.[k]); return Number.isFinite(v) && v > 0 ? v : null; };
const envL = (env, k, re) => String(env?.[k] || '').split(',').map((s) => s.trim()).filter((s) => re.test(s));
export function b2Cfg(env) {
  return { tags: envL(env, 'AVE_BOARD_TAGS', /^[a-z0-9_]{2,40}$/), trend: envL(env, 'AVE_BOARD_TRENDING', /^[a-z]{2,20}$/), limit: envN(env, 'AVE_BOARD_LIMIT'), trendN: envN(env, 'AVE_BOARD_TREND_N'),
    listS: envN(env, 'AVE_BOARD_LIST_S'), priceS: envN(env, 'AVE_BOARD_PRICE_S'), topN: envN(env, 'AVE_BOARD_PRICE_TOPN'), priceN: envN(env, 'AVE_BOARD_PRICE_N'), idleS: envN(env, 'AVE_BOARD_IDLE_S'), badS: envN(env, 'AVE_BOARD_BAD_S'), keepS: envN(env, 'AVE_BOARD_KEEP_S'), autoSuf: envL(env, 'AVE_BOARD_AUTO_SUFFIX', /^_[a-z0-9_]{2,20}$/), autoMax: envN(env, 'AVE_BOARD_AUTO_MAX'), kNew: envL(env, 'AVE_BOARD_KIND_NEW', /^[a-z0-9_]{2,40}$/), kHot: envL(env, 'AVE_BOARD_KIND_HOT', /^[a-z0-9_]{2,40}$/), trendPages: envN(env, 'AVE_BOARD_TREND_PAGES'), seenMax: envN(env, 'AVE_BOARD_SEEN_MAX') };
}
const CH = (c) => (c === 'robinhood' ? 'rh' : c);
/* 清单 → 看盘分页（照 AVE tag 的字尾；不分平台的清单照 AVE_BOARD_KIND_NEW／_HOT；热门榜＝热门外盘；搜寻收进来的照 AVE 进度） */
export function kindOf(tag, C) { if (C.kNew.includes(tag)) return 'fresh'; if (C.kHot.includes(tag)) return 'hotdex'; if (/^trend_/.test(tag)) return 'hotdex'; if (tag === 'seen_curve') return 'fresh'; if (tag === 'seen_dex') return 'done';
  return /_in_new$/.test(tag) ? 'fresh' : /_in_almost$/.test(tag) ? 'soon' : /_in_hot$/.test(tag) ? 'hot' : /_out_hot$/.test(tag) ? 'hotdex' : /_out_new$/.test(tag) ? 'done' : ''; }
/*CARDS125 AVE 的社群连结：顶层 twitter，或 appendix（JSON 字串）里的 twitter／website／telegram */
const SOC_MAX = 200; /* 技术用：网址最长几个字 */
const sUrl = (u, re) => { const s = String(u || '').trim(); if (!s || s.length > SOC_MAX || !/^https:\/\/[^\s"'<>`\\]+$/.test(s)) return ''; try { const x = new URL(s); if (x.protocol !== 'https:' || x.username || x.password) return ''; return !re || re.test(x.hostname.toLowerCase()) ? s : ''; } catch { return ''; } };
export function socOf(t) { let a = t?.appendix; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } } if (!a || typeof a !== 'object') a = {};
  return { xl: sUrl(t?.twitter || a.twitter, /^(www\.)?(x|twitter)\.com$/), tl: sUrl(t?.telegram || a.telegram, /^(t\.me|telegram\.me)$/), wl: sUrl(t?.website || a.website) }; }
/* 跟 ave.mjs 的 pack 同一套栏位（雷达那边 next.cjs／main.cjs 不用改就看得懂）；风险栏位（hp／rs／税／可增发）原样带着，画面只标记、不藏 */
export function pack(t) {
  const tid = String(t?.token_id || (t?.token && t?.chain ? t.token + '-' + t.chain : '')); const j0 = tid.lastIndexOf('-'); const addr = tid.slice(0, j0), chain = tid.slice(j0 + 1);
  const evm = /^0x[0-9a-fA-F]{40}$/.test(addr); if (!evm && !(chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))) return null; if (!/^[a-z]{2,20}$/.test(chain)) return null;
  const v = {
    n: String(t.name || '').slice(0, 40), s: String(t.symbol || '').slice(0, 20), h: num(t.holders), bt: num(t.buy_tax), st: num(t.sell_tax),
    rs: num(t.risk_score), rl: num(t.ave_risk_level), hp: t.is_honeypot === true || t.is_honeypot === '1' || t.is_honeypot === 1 ? 1 : t.is_honeypot === false || t.is_honeypot === '0' || t.is_honeypot === 0 ? 0 : null,
    mint: t.is_mintable === '1' || t.has_mint_method === 1 || t.has_mint_method === '1' ? 1 : 0,
    lg: okUrl(t.logo_url), tx: num(t.tx_count_24h), v24: num(t.tx_volume_u_24h ?? t.token_tx_volume_usd_24h), mc: num(t.market_cap), tvl: num(t.main_pair_tvl ?? t.tvl),
    pg: num(t.progress ?? t.launch_progress ?? t.bonding_curve_progress), lp: num(t.launch_price), cp: num(t.current_price_usd), ca: num(t.created_at), pl: String(t.issue_platform || '').slice(0, 20),
    bv1: num(t.token_buy_tx_volume_usd_1h), sv1: num(t.token_sell_tx_volume_usd_1h), bv24: num(t.token_buy_tx_volume_usd_24h), sv24: num(t.token_sell_tx_volume_usd_24h), hi24: num(t.token_price_24h_high), lo24: num(t.token_price_24h_low),
    mk1: num(t.token_makers_1h), mk24: num(t.token_makers_24h), tx1: num(t.token_tx_count_1h), by24: num(t.token_buyers_24h), sl24: num(t.token_sellers_24h), v5: num(t.token_tx_volume_usd_5m), v1: num(t.token_tx_volume_usd_1h), c5: num(t.token_price_change_5m), c1: num(t.token_price_change_1h), c24: num(t.token_price_change_24h ?? t.price_change_24h),
    qs: String(t.main_pair_quote_symbol || t.quote_symbol || '').slice(0, 12),
    ...socOf(t), /*CARDS125 社群连结（AVE twitter／appendix）：只收 https、限长、X／TG 要对的网域；画面只显示，不进买卖判断*/
  };
  for (const k of Object.keys(v)) if (v[k] === null || v[k] === '') delete v[k];
  return [CH(chain), evm ? addr.toLowerCase() : addr, v];
}
/* 价格刷新（POST /v2/tokens/price）回来的格式：物件 { "addr-chain": {...} } 或阵列都收 */
export function packPrice(d) {
  const out = []; const one = (id, p) => { const s = String(id || p?.token_id || ''); const j = s.lastIndexOf('-'); if (j < 1) return; const a = s.slice(0, j), ch = s.slice(j + 1); const evm = /^0x[0-9a-fA-F]{40}$/.test(a); if (!evm && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return;
    const v = { cp: num(p?.current_price_usd ?? p?.price_usd ?? p?.price), c24: num(p?.price_change_24h ?? p?.token_price_change_24h), c1: num(p?.price_change_1h ?? p?.token_price_change_1h), c5: num(p?.price_change_5m ?? p?.token_price_change_5m), tvl: num(p?.tvl ?? p?.main_pair_tvl), mc: num(p?.market_cap), v24: num(p?.tx_volume_u_24h) };
    for (const k of Object.keys(v)) if (v[k] == null) delete v[k]; if (Object.keys(v).length) out.push([CH(ch), evm ? a.toLowerCase() : a, v]); };
  if (Array.isArray(d)) for (const p of d) one(p?.token_id, p); else if (d && typeof d === 'object') for (const [k, p] of Object.entries(d)) one(k, p);
  return out;
}
const same = (a, b) => { for (const k of Object.keys(b)) if (k !== 'u' && k !== 'ch' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false; return true; };
function put(S, p, now) { if (!p) return; const M = (S.m[p[0]] = S.m[p[0]] || {}); const o = M[p[1]]; const nv = { ...(o || {}), ...p[2] }; nv.u = now; nv.ch = o && same(o, p[2]) && o.ch ? o.ch : (S.seq = (S.seq || 0) + 1); /* ch＝变动序号（单调递增，用户端带 since＝上次的 seq 只拿有变的） */ M[p[1]] = nv; }
/* 一个 AVE 呼叫：先过额度计（当月累计；到 AVE_MONTH_STOP_CU 才拒绝），AVE 回 429／额度用尽 → 整个看盘退避 */
/*PACE-1113 看盘自己抓 AVE 要「排队慢慢抓」：以前一轮十几～三十几份清单几乎同时打，几秒内就把全体每秒上限（AVE_GLOBAL_RPS）占满，
  用户的持有人／钱包资料（背景）就被回「太忙」。现在：看盘最多用全体速度的 BOARD_RPS_SHARE，而且一轮的请求平均摊在 BOARD_SPREAD 的清单间隔里（不会在 Cron 那一刻一起冲）。
  这个物件全球只有一个（ave-board2），所以这里的排队就是看盘的总排队 */
const BOARD_RPS_SHARE = 0.6, BOARD_SPREAD = 0.8; /* 技术用：看盘最多占全体每秒上限的几成／一轮请求摊在清单间隔的几成时间里 */
function paceGap(o, fast) { const g = envN(o.env, 'AVE_GLOBAL_RPS'); const minGap = g ? 1000 / (g * BOARD_RPS_SHARE) : 0; return fast ? minGap : Math.max(minGap, o.b2gap || 0); }
async function pace(o, fast) { const gap = paceGap(o, fast); if (!gap) return; const now = Date.now(); const at = Math.max(now, o.b2next || 0); o.b2next = at + gap; if (at > now) await new Promise((ok) => setTimeout(ok, at - now)); }
async function aveCall(o, path, cu, body, fast) {
  const env = o.env; const S = o.b2; if (S.backoff > Date.now()) throw new Error('backoff'); await pace(o, fast); if (S.backoff > Date.now()) throw new Error('backoff');
  const mq = new URLSearchParams({ cu: String(cu), w: '_board', bg: '0', grps: String(envN(env, 'AVE_GLOBAL_RPS') ?? ''), mstop: String(envN(env, 'AVE_MONTH_STOP_CU') ?? ''), mwarn: String(envN(env, 'AVE_MONTH_WARN_CU') ?? ''), k: 'board_' + (String(path).match(/^\/v2\/(tokens\/(trending|platform|price)|tokens)/)?.[1] || 'other').replace(/\//g, '_') }); /*PCSTAT-1112*/
  const meter = env.ROOM.get(env.ROOM.idFromName('ave-meter')); let m = null; for (let i = 0; i < 20; i++) { if (i) mq.set('rt', '1'); m = await (await meter.fetch('https://do/_meter?' + mq)).json(); if (m.deny !== 'busy') break; await new Promise((ok) => setTimeout(ok, 120)); } /*PACE-1113 重试的那几次在统计里另外算（rt＝1），不算新的被拒*/ /* 全体速度（AVE_GLOBAL_RPS，AVE 每秒上限）满了就排队等一下，不丢这一份清单 */ S.q = { mcu: m.mcu ?? null, warn: m.mwarn ? 1 : 0, stop: m.deny === 'month cap' ? 1 : 0 };
  if (m.deny === 'month cap') { S.backoff = Date.now() + (envN(env, 'AVE_BOARD_BACKOFF_S') ?? 0) * 1000; throw new Error('month cap'); } if (m.deny) throw new Error(m.deny);
  const refund = () => meter.fetch('https://do/_meter_refund?' + new URLSearchParams({ cu: String(cu), w: '_board' })).catch(() => {});
  let r, j; try { r = await fetch('https://prod.ave-api.com' + path, { method: body ? 'POST' : 'GET', headers: { 'X-API-KEY': String(env.AVE_KEY || '').trim(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); j = await r.json().catch(() => null); } catch (e) { await refund(); throw new Error('ave unreachable'); }
  if (r.status === 429 || /quota|limit|exceed|credit/i.test(String(j?.msg || ''))) { await refund(); S.backoff = Date.now() + (envN(env, 'AVE_BOARD_BACKOFF_S') ?? 0) * 1000; S.boErr = 'AVE ' + r.status + ' ' + String(j?.msg || '').slice(0, 60); throw new Error('ave busy'); } /* 只有 AVE 真的说太快／额度用尽才退避 */
  if (!r.ok || !j || j.status !== 1) { await refund(); throw Object.assign(new Error('AVE ' + r.status + ' ' + String(j?.msg || '').slice(0, 60)), { full: String(j?.msg || '').slice(0, 4000) }); }
  return j.data;
}
async function pool(n, jobs) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.max(1, n) }, async () => { while (i < jobs.length) { const k = i++; try { out[k] = await jobs[k](); } catch (e) { out[k] = e; } } })); return out; }
export async function b2Lists(o) {
  const C = b2Cfg(o.env); const S = o.b2; const now = Date.now(); if (!o.env.AVE_KEY) { S.err = 'AVE_KEY not set'; return; } if (!C.tags.length && !C.trend.length) { S.err = 'AVE_BOARD_TAGS／AVE_BOARD_TRENDING not set'; return; }
  if (C.autoSuf.length && (!S.validAt || now - S.validAt > (C.badS || 0) * 1000)) { S.validAt = now; try { await aveCall(o, '/v2/tokens/platform?tag=x', 10); } catch (e) { const vt = (e.full || '').match(/valid tags:\s*\[([^\]]*)\]/); if (vt) S.valid = vt[1].split(/\s+/).filter((t) => /^[a-z0-9_]{2,40}$/.test(t)); } } /* 向 AVE 问一次「有效 tag 清单」（AVE 对无效 tag 会回完整清单），每 AVE_BOARD_BAD_S 秒最多一次 */
  const jobs = []; const pri = []; const tags = [...C.tags];
  if (C.autoSuf.length && S.valid?.length) { /* 自动找发射台：清单／热门榜／搜寻里看到的 issue_platform（AVE 给的发射台名字，例 four.meme、flap.sh、gang.fun）→ 在 AVE 自己回报的「有效 tag 清单」里找同名开头的 tag 来抓；AVE 没有这个发射台的 tag（例 gang.fun）就靠热门榜／搜寻收。程式里没有发射台名单 */
    const seen = new Map(); for (const M of Object.values(S.m)) for (const v of Object.values(M)) { const raw = String(v.pl || '').toLowerCase(); for (const n of new Set([raw.replace(/[^a-z0-9]/g, ''), raw.split(/[^a-z0-9]/)[0]])) if (n.length >= 2) seen.set(n, (seen.get(n) || 0) + 1); }
    const P = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, C.autoMax ?? 0); const add = []; for (const n of P) for (const t of S.valid) if (t.startsWith(n + '_') && C.autoSuf.some((suf) => t.endsWith(suf)) && !tags.includes(t)) { tags.push(t); add.push(t); } S.auto = add; }
  const prOf = (t) => (/hot/.test(t) || C.kHot.includes(t) ? 0 : /_almost$/.test(t) ? 1 : 2); /*PACE-1113 热门最重要*/
  for (const tag of tags) { if ((S.bad[tag] || 0) > now) continue; pri[jobs.length] = prOf(tag); jobs.push(async () => { const now = Date.now(); /*PACE-1113 摊开抓，用这份清单真正抓到的时间*/ try { const d = await aveCall(o, '/v2/tokens/platform?tag=' + tag + (C.limit ? '&limit=' + C.limit : ''), 10); const arr = Array.isArray(d) ? d : d?.tokens || []; const L = []; for (const t of arr) { const p = pack(t); if (p) { put(S, p, now); L.push(p[1]); } } S.cols[tag] = L; S.colsAt[tag] = now; S.ch2 = now; delete S.tagErr[tag]; } catch (e) { const m = String(e.message || e); S.tagErr[tag] = m.slice(0, 80); if (/^AVE (200|400|404)/.test(m) && C.badS) S.bad[tag] = now + C.badS * 1000; const vt = (e.full || '').match(/valid tags:\s*\[([^\]]*)\]/); if (vt) S.valid = vt[1].split(/\s+/).filter((t) => /^[a-z0-9_]{2,40}$/.test(t)); } }); }
  for (const ch of C.trend) (pri[jobs.length] = 0), jobs.push(async () => { const now = Date.now(); const L = []; try { for (let pg = 1; pg <= (C.trendPages || 1); pg++) { const d = await aveCall(o, '/v2/tokens/trending?chain=' + ch + (C.trendN ? '&page_size=' + C.trendN : '') + (C.trendPages ? '&current_page=' + pg : ''), 5); const arr = Array.isArray(d) ? d : d?.tokens || []; for (const t of arr) { const p = pack(t); if (p && !L.includes(p[1])) { put(S, p, now); L.push(p[1]); } } if (!arr.length || d?.next_page == null && !Array.isArray(d)) break; } } catch (e) { S.tagErr['trend_' + ch] = String(e.message || e).slice(0, 80); } if (L.length) { S.cols['trend_' + ch] = L; S.colsAt['trend_' + ch] = now; } }); /* 热门榜可以翻页（AVE_BOARD_TREND_PAGES） */
  { const C2 = b2Cfg(o.env); const calls = jobs.length + Math.max(0, (C2.trendPages || 1) - 1) * C2.trend.length; o.b2gap = S.listAt && C2.listS && calls ? (C2.listS * 1000 * BOARD_SPREAD) / calls : 0; } /* 第一次（物件刚醒、还没有清单）不摊开，只守速度上限，第一个用户不用等 */ /*PACE-1113 一轮的请求平均摊开（每个请求之间隔多久；pace() 照这个排）*/
  await pool(2, jobs.map((f, i) => [f, pri[i] ?? 9]).sort((a, b) => a[1] - b[1]).map((x) => x[0])); S.listAt = now; /*PACE-1113 热门清单先抓（热门榜、*_hot、*_almost），再抓新币／已发射；实际速度由 pace() 控制*/ S.err = Object.keys(S.cols).length ? '' : 'AVE lists empty';
  if (o.env.SCOUT_ON === '1') o.ctx.waitUntil(scoutRun(o, S, aveCall, pack, put, o.padNames || {}).catch((e) => { (o.scout = o.scout || {}).err = String(e?.message || e).slice(0, 80); })); /*SCOUT-1112 转接站统一扫新发射台，放进看盘「新币」栏（营运开关 SCOUT_ON；测完才开；在背景跑，不拖慢看盘）*/
  if (C.keepS) { const inCol = new Set(Object.values(S.cols).flat()); for (const M of Object.values(S.m)) for (const [a, v] of Object.entries(M)) if (!inCol.has(a) && now - (v.u || 0) > C.keepS * 1000) delete M[a]; }
}
export async function b2Prices(o) {
  const C = b2Cfg(o.env); const S = o.b2; if (!o.env.AVE_KEY || !C.priceN) return; const ids = []; const seen = new Set();
  for (const [tag, L] of Object.entries(S.cols)) for (const a of (L || []).slice(0, C.topN || 0)) { const ch = Object.keys(S.m).find((k) => S.m[k][a]); if (!ch) continue; const id = a + '-' + (ch === 'rh' ? 'robinhood' : ch); if (!seen.has(id)) { seen.add(id); ids.push(id); } }
  const now = Date.now(); S.priceAt = now; if (!ids.length) return;
  try { const d = await aveCall(o, '/v2/tokens/price', 100, { token_ids: ids.slice(0, C.priceN), tvl_min: 0 }, true); /*PACE-1113 价格不等清单的摊开间隔，只守速度上限*/ for (const p of packPrice(d)) { const M = S.m[p[0]]; if (M && M[p[1]]) put(S, p, now); } S.pOk = now; } catch (e) { S.pErr = String(e.message || e).slice(0, 80); }
}
/* 搜寻／详情查到的币（用户查 AVE /v2/tokens 的回应，转接站顺手收进看盘；不另外花 AVE 额度）：照 AVE 进度分内盘／外盘 */
const b2New = (now) => ({ m: {}, cols: {}, colsAt: {}, bad: {}, tagErr: {}, listAt: 0, priceAt: 0, seenAt: 0, q: null, seq: 0, boot: String(now) + Math.random().toString(36).slice(2, 8) });
export async function b2Add(o, list) { const C = b2Cfg(o.env); if (!C.seenMax) return; if (!o.b2) o.b2 = (await b2Load(o)) || b2New(Date.now()); const S = o.b2; const now = Date.now(); for (const t of Array.isArray(list) ? list : []) { const p = pack(t); if (!p) continue; put(S, p, now); const done = p[2].pg != null ? p[2].pg >= 100 : !p[2].pl; const k = done ? 'seen_dex' : 'seen_curve', k2 = done ? 'seen_curve' : 'seen_dex'; S.cols[k2] = (S.cols[k2] || []).filter((a) => a !== p[1]); S.cols[k] = [p[1], ...(S.cols[k] || []).filter((a) => a !== p[1])].slice(0, C.seenMax); S.colsAt[k] = now; } }
/* Durable Object 里：GET /_b2?since=变动序号&boot=…（只回传之后有变的币）；px=1＝这个用户的 AVE 推送断了，要 REST 价格；cron=1＝Cron 保鲜（只刷清单） */
const B2_CHUNK = 600; /* 技术用：存进 Durable Object 储存时每一块放几个币（单一值有大小上限） */
async function b2Load(o) { /* 物件被系统收起来再叫醒（闲置会被回收）→ 从储存读回上次的清单，不用整份重抓 */
  try { const meta = await o.ctx.storage.get('b2meta'); if (!meta || typeof meta !== 'object') return null; const S = { ...meta, m: {} }; const keys = Array.from({ length: +meta.chunks || 0 }, (_, i) => 'b2m' + i); const got = keys.length ? await o.ctx.storage.get(keys) : new Map();
    for (const k of keys) for (const [ch, a, v] of got.get(k) || []) (S.m[ch] = S.m[ch] || {})[a] = v; delete S.chunks; return S; } catch { return null; } }
async function b2Save(o) { try { const S = o.b2; const E = []; for (const [ch, M] of Object.entries(S.m)) for (const [a, v] of Object.entries(M)) E.push([ch, a, v]); const put = {}; let n = 0; for (let i = 0; i < E.length; i += B2_CHUNK) put['b2m' + n++] = E.slice(i, i + B2_CHUNK);
    const old = (await o.ctx.storage.get('b2meta'))?.chunks || 0; const { m, ...rest } = S; put.b2meta = { ...rest, chunks: n }; await o.ctx.storage.put(put); for (let i = n; i < old; i++) await o.ctx.storage.delete('b2m' + i); } catch {} }
export async function b2Handle(o, iu) {
  const C = b2Cfg(o.env); const now = Date.now(); if (!o.b2) o.b2 = await b2Load(o); o.b2 = o.b2 || b2New(now);
  const S = o.b2; const cron = iu.searchParams.get('cron') === '1'; if (!cron) S.seenAt = now;
  const idle = C.idleS && now - S.seenAt > C.idleS * 1000; if (cron && (idle || !S.seenAt)) return new Response(JSON.stringify({ idle: 1 }));
  const runL = () => { if (o.b2L) return o.b2L; o.b2L = b2Lists(o).then(() => b2Save(o)).finally(() => { o.b2L = null; }); return o.b2L; };
  const runP = () => { if (o.b2P) return o.b2P; o.b2P = b2Prices(o).finally(() => { o.b2P = null; }); return o.b2P; };
  if (!S.listAt) await runL(); else if (C.listS && now - S.listAt > C.listS * 1000) o.ctx.waitUntil(runL());
  if (C.priceS && iu.searchParams.get('px') === '1' && now - S.priceAt > C.priceS * 1000) o.ctx.waitUntil(runP()); /* 价格 REST 只在有用户说「我的推送断了」（px=1）时才跑；推送正常＝0 CU */
  if (cron) return new Response(JSON.stringify({ ok: 1 }));
  const since0 = Math.max(0, +iu.searchParams.get('since') || 0); const since = iu.searchParams.get('boot') === S.boot && since0 <= (S.seq || 0) ? since0 : 0; /* 物件重启过（boot 不同）→ 给全部 */ const m = {};
  for (const [ch, M] of Object.entries(S.m)) { const o2 = {}; for (const [a, v] of Object.entries(M)) if (!since || (v.ch || 0) > since) o2[a] = v; m[ch] = o2; }
  const at = Math.max(S.listAt || 0, S.pOk || 0);
  return new Response(JSON.stringify({ v: 2, at, seq: S.seq || 0, boot: S.boot, since, full: since ? 0 : 1, m, cols: S.cols, colsAt: S.colsAt, listAt: S.listAt, priceAt: S.pOk || 0, poll: { list: C.listS, price: C.priceS }, err: S.err || '', tagErr: S.tagErr, auto: S.auto || [], kinds: Object.fromEntries(Object.keys(S.cols).map((t) => [t, kindOf(t, C)]).filter((x) => x[1])), backoff: S.backoff > now ? S.backoff : 0, q: S.q, scout: { at: o.scout?.at || 0, pads: o.scout?.pads || [], err: o.scout?.err || '' } }));
}
