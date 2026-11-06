
// 只在有 .sign/ave_key.txt 的电脑跑（Nancy 的雷达）；金钥不会离开这台电脑，也不会写进任何档案或日志
// ① 每 5 分钟抓一轮清单（约 50 单位）② 每 2 分钟把看盘上 AVE 清单没有的新币批次补查（50 个 100 单位）
// 整理成 data/ave_board.json；用量记在 data/ave_usage.json，一天超过 3 万单位自动放慢并提醒一次
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://prod.ave-api.com';
const LISTS = [
  ['platform', 'tag=flap_in_new&limit=100', 10], ['platform', 'tag=flap_in_almost&limit=100', 10], ['platform', 'tag=flap_in_hot&limit=100', 10],
  ['platform', 'tag=flap_out_new&limit=100', 10], ['platform', 'tag=flap_out_hot&limit=100', 10],
  ['trending', 'chain=bsc&page_size=100', 5], ['trending', 'chain=robinhood&page_size=100', 5],
];
const DAY_SOFT = 30000; // 一天超过这么多单位就放慢
/* AVE 是看盘的主要资料。要加别的发射台清单（例如 AVE 文件里的其他 tag），写在 data/ave_lists.json：
   { "lists": [["platform", "tag=xxx_in_new&limit=100", 10], ...] }。每一轮花的单位不会超过原本的预算（ROUND_CU），清单多了就轮流抓（每个清单更新慢一点），不会多花额度。 */
const ROUND_CU = LISTS.reduce((a, x) => a + x[2], 0);
/*MC121 多链看盘：Solana（pump 发射台＋热门）、Ethereum、Base（热门）。每轮另外最多花 MC_ROUND_CU 单位、清单轮流抓（不加新的定时器；放慢模式时不抓） */
const MC_LISTS = [['trending', 'chain=solana&page_size=100', 5], ['platform', 'tag=pump_in_new&limit=100', 10], ['platform', 'tag=pump_in_hot&limit=100', 10], ['platform', 'tag=pump_out_new&limit=100', 10], ['platform', 'tag=pump_out_hot&limit=100', 10], ['trending', 'chain=eth&page_size=100', 5], ['trending', 'chain=base&page_size=100', 5]];
const MC_ROUND_CU = 20; /* 运作（AVE 额度）：多链清单每 5 分钟一轮最多花几个单位；全部轮完约 15 分钟 */
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const okUrl = (u) => (/^https:\/\/[^\s"'<>]{4,300}$/.test(String(u || '')) ? String(u) : '');
const today = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

export function addAveUsage(DIR, cu) { /* 雷达视窗那边（合约分析、K 线）也会呼叫，所以单独汇出 */
  const f = join(DIR, 'data', 'ave_usage.json'); let u = {}; try { u = JSON.parse(readFileSync(f, 'utf8')); } catch {}
  if (u.d !== today()) u = { d: today(), cu: 0, calls: 0, prev: u.d ? { d: u.d, cu: u.cu } : u.prev };
  u.cu += cu; u.calls = (u.calls || 0) + 1; u.at = Date.now(); try { writeFileSync(f, JSON.stringify(u)); } catch {} return u.cu;
}

export function startAve({ DIR, log, tg }) {
  const KF = join(DIR, '.sign', 'ave_key.txt'); if (!existsSync(KF)) return null;
  const key = () => { try { return readFileSync(KF, 'utf8').trim(); } catch { return ''; } };
  const OUT = join(DIR, 'data', 'ave_board.json'), WANT = join(DIR, 'data', 'ave_want.json');
  let B = { at: 0, m: { bsc: {}, rh: {} }, cols: {} }; try { const o = JSON.parse(readFileSync(OUT, 'utf8')); if (o?.m) B = { ...B, ...o }; } catch {}
  const usedToday = () => { try { const u = JSON.parse(readFileSync(join(DIR, 'data', 'ave_usage.json'), 'utf8')); return u.d === today() ? u.cu : 0; } catch { return 0; } };
  let warned = '', busy = false, busy2 = false, fails = 0, lastList = 0; const ASKED = new Map(); /* 查过但 AVE 还没收录的币，10 分钟内不重查 */
  
  const UP_MAX_BYTES = 1.7e6; /* 技术用：转接站收的上传上限是 1.8MB（relay/worker.js BOARD_MAX_BYTES），留一点给签名 */
  const fitBoard = (txt) => { if (Buffer.byteLength(txt) <= UP_MAX_BYTES - 200) return txt; let o; try { o = JSON.parse(txt); } catch { return ''; } const inCol = new Set(Object.values(o.cols || {}).flat().map(String)); const all = []; for (const [ch, M] of Object.entries(o.m || {})) for (const [a, v] of Object.entries(M || {})) if (!inCol.has(a)) all.push([ch, a, +(v?.u || 0)]); all.sort((x, y) => x[2] - y[2]); /* 先拿掉不在任何榜单、最久没更新的币（只影响上传的那份，本机资料不动） */ let i = 0; for (let g = 0; g < 20 && i < all.length; g++) { const n = Math.max(1, Math.ceil(all.length / 10)); for (const [ch, a] of all.slice(i, i + n)) delete o.m[ch][a]; i += n; const t2 = JSON.stringify(o); if (Buffer.byteLength(t2) <= UP_MAX_BYTES - 200) return t2; } return ''; };
  let upAt = 0; async function upload(txt) { if (Date.now() - upAt < 110e3) return; upAt = Date.now(); try { const PK = process.env.RCR_ONLINE_KEY || join(DIR, '.sign_radar', 'online.pem'), RS = join(DIR, 'data', 'remote_src.json'); if (!existsSync(PK) || !existsSync(RS)) return; /* 上传看盘资料只用线上金钥（路径可用环境变数 RCR_ONLINE_KEY 改；没有就不签、不上传）；发布金钥不在这里用 */ const R = JSON.parse(readFileSync(RS, 'utf8')); const relay = String((R.R || R).relay || ''); if (!/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.workers\.dev$/.test(relay)) return; const { createPrivateKey, sign } = await import('node:crypto'); txt = fitBoard(txt); if (!txt) { log('AVE 看盘资料太大，裁剪后还是超过转接站上限，这次没上传'); return; } const sig = sign(null, Buffer.from(txt), createPrivateKey(readFileSync(PK))).toString('base64'); const body = JSON.stringify({ data: txt, sig }); if (Buffer.byteLength(body) > UP_MAX_BYTES) { log('AVE 看盘资料超过转接站上限，这次没上传'); return; } const r = await fetch(relay + '/aveboard', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30000) }); if (!r.ok) log('AVE 看盘资料上传转接站失败 ' + r.status); } catch (e) { log('AVE 看盘资料上传失败 ' + String(e.message || e).slice(0, 80)); } }
  const save = () => { B.at = Date.now(); const tmp = OUT + '.w'; let txt = ''; try { txt = JSON.stringify(B); writeFileSync(tmp, txt); renameSync(tmp, OUT); } catch {} if (txt) upload(txt).catch(() => {}); };
  async function call(path, cu, body) {
    const r = await fetch(BASE + path, { method: body ? 'POST' : 'GET', headers: { 'X-API-KEY': key(), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    addAveUsage(DIR, cu); const j = await r.json().catch(() => null); if (!r.ok || !j || j.status !== 1) throw new Error(`AVE ${r.status} ${String(j?.msg || '').slice(0, 60)}`); return j.data;
  }
  function pack(t) {
    const tid = String(t.token_id || ''); const j0 = tid.lastIndexOf('-'); const addr = tid.slice(0, j0), chain = tid.slice(j0 + 1); const evm = /^0x[0-9a-fA-F]{40}$/.test(addr); if (!evm && !(chain === 'solana' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr))) return null; /*MC121 Solana 合约是 base58（分大小写，不转小写）*/
    const v = {
      n: String(t.name || '').slice(0, 40), s: String(t.symbol || '').slice(0, 20), h: num(t.holders), bt: num(t.buy_tax), st: num(t.sell_tax),
      rs: num(t.risk_score), rl: num(t.ave_risk_level), hp: t.is_honeypot === true || t.is_honeypot === '1' || t.is_honeypot === 1 ? 1 : t.is_honeypot === false || t.is_honeypot === '0' || t.is_honeypot === 0 ? 0 : null, /* -1／没给＝不知道（不是「不是貔貅」） */ mint: t.is_mintable === '1' || t.has_mint_method === 1 || t.has_mint_method === '1' ? 1 : 0,
      lg: okUrl(t.logo_url), tx: num(t.tx_count_24h), v24: num(t.tx_volume_u_24h ?? t.token_tx_volume_usd_24h), mc: num(t.market_cap), tvl: num(t.main_pair_tvl ?? t.tvl),
      pg: num(t.progress ?? t.launch_progress ?? t.bonding_curve_progress), /* 内盘进度（AVE 有给才有） */
      lp: num(t.launch_price), cp: num(t.current_price_usd), ca: num(t.created_at), pl: String(t.issue_platform || '').slice(0, 20),
      bv1: num(t.token_buy_tx_volume_usd_1h), sv1: num(t.token_sell_tx_volume_usd_1h), bv24: num(t.token_buy_tx_volume_usd_24h), sv24: num(t.token_sell_tx_volume_usd_24h), hi24: num(t.token_price_24h_high), lo24: num(t.token_price_24h_low), u: Date.now(),
      
      mk1: num(t.token_makers_1h), mk24: num(t.token_makers_24h), tx1: num(t.token_tx_count_1h), by24: num(t.token_buyers_24h), sl24: num(t.token_sellers_24h), v5: num(t.token_tx_volume_usd_5m), v1: num(t.token_tx_volume_usd_1h), c5: num(t.token_price_change_5m), c1: num(t.token_price_change_1h), c24: num(t.token_price_change_24h ?? t.price_change_24h),
    };
    for (const k of Object.keys(v)) if (v[k] === null || v[k] === '') delete v[k];
    return [chain === 'robinhood' ? 'rh' : chain, evm ? addr.toLowerCase() : addr, v];
  }
  const put = (p) => { if (!p) return; const M = (B.m[p[0]] = B.m[p[0]] || {}); M[p[1]] = { ...(M[p[1]] || {}), ...p[2] }; };
  /* 资料进来只走这两个入口（现在是定时抓，之后换 AVE WebSocket 推送也是呼叫这两个，看盘那边不用改） */
  const ingestList = (tag, arr) => { const out = []; for (const t of arr || []) { const p = pack(t); if (!p) continue; put(p); out.push(p[1]); } B.cols[tag] = out; B.colsAt = B.colsAt || {}; B.colsAt[tag] = Date.now(); return out.length; };
  const ingestTokens = (arr) => { let n = 0; for (const t of arr || []) { const p = pack(t); if (p) { put(p); n++; } } return n; };
  let rot = 0, mcRot = 0; const lists = () => { try { const j = JSON.parse(readFileSync(join(DIR, 'data', 'ave_lists.json'), 'utf8')); const L = (Array.isArray(j?.lists) ? j.lists : []).filter((x) => Array.isArray(x) && (x[0] === 'platform' || x[0] === 'trending') && /^[a-z0-9_=&]{3,80}$/i.test(String(x[1])) && Number(x[2]) > 0 && Number(x[2]) <= 20).slice(0, 40); return L.length ? L : LISTS; } catch { return LISTS; } };
  function prune() { const now = Date.now(); for (const M of Object.values(B.m)) for (const [a, v] of Object.entries(M)) if (now - (v.u || 0) > 3 * 3600e3) delete M[a]; }
  function slowCheck() { const cu = usedToday(); if (cu < DAY_SOFT) return false; if (warned !== today()) { warned = today(); log(`[AVE] 今天已用 ${cu} 单位，自动放慢`); tg?.(`📊 AVE 额度提醒：今天已用 ${cu} 单位（超过 ${DAY_SOFT}），雷达已自动放慢更新（清单改 15 分钟一次、新币不补查）。额度不够可以找 AVE 加。`).catch?.(() => {}); } return true; }
  async function listTick() {
    if (busy) return; const slow = slowCheck(); if (slow && Date.now() - lastList < 15 * 60e3) return; busy = true; lastList = Date.now();
    try { let n = 0;
      const LL = lists(); let spent = 0; /* 每轮最多花原本的预算，清单多就轮流 */
      for (let i = 0; i < LL.length; i++) { const [kind, q, cu] = LL[(rot + i) % LL.length]; if (spent + cu > ROUND_CU) { rot = (rot + i) % LL.length; break; } spent += cu; if (i === LL.length - 1) rot = 0;
        try { const d = await call(kind === 'platform' ? '/v2/tokens/platform?' + q : '/v2/tokens/trending?' + q, cu);
          const arr = Array.isArray(d) ? d : d?.tokens || []; const k = kind === 'platform' ? (q.match(/tag=([a-z0-9_]+)/i) || [, 'x'])[1] : 'trend_' + (q.match(/chain=([a-z]+)/) || [, 'x'])[1];
          n += ingestList(k, arr); } catch (e) { log('[AVE] ' + kind + ' ' + e.message); }
        await new Promise((r) => setTimeout(r, 400)); }
      if (!slow) { let mcSpent = 0; for (let i = 0; i < MC_LISTS.length; i++) { const [kind, q, cu] = MC_LISTS[mcRot % MC_LISTS.length]; if (mcSpent + cu > MC_ROUND_CU) break; mcSpent += cu; mcRot = (mcRot + 1) % MC_LISTS.length; /*MC121*/
        try { const d = await call(kind === 'platform' ? '/v2/tokens/platform?' + q : '/v2/tokens/trending?' + q, cu); const arr = Array.isArray(d) ? d : d?.tokens || []; const k = kind === 'platform' ? (q.match(/tag=([a-z0-9_]+)/i) || [, 'x'])[1] : 'trend_' + (q.match(/chain=([a-z]+)/) || [, 'x'])[1]; n += ingestList(k, arr); } catch (e) { log('[AVE] 多链 ' + kind + ' ' + e.message); }
        await new Promise((r) => setTimeout(r, 400)); } }
      if (n) { prune(); save(); fails = 0; } else if (++fails === 3) log('[AVE] 连续 3 轮读不到资料（金钥过期或额度用完？）');
    } finally { busy = false; }
  }
  async function wantTick() { /* 看盘上 AVE 清单没有的币（多半是刚开盘的新币），直接查 */
    if (busy2 || slowCheck()) return; busy2 = true;
    try { let W = {}; try { W = JSON.parse(readFileSync(WANT, 'utf8')); } catch { return; } if (Date.now() - (+W.at || 0) > 10 * 60e3) return;
      const ids = []; const now = Date.now();
      for (const [ch, list] of [['bsc', W.bsc], ['rh', W.rh]]) for (const a of Array.isArray(list) ? list : []) { const x = String(a).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(x)) continue; const have = B.m[ch]?.[x]; if (have && now - (have.u || 0) < 30 * 60e3) continue; if (now - (ASKED.get(x) || 0) < 30 * 60e3) continue; ids.push(x + '-' + (ch === 'rh' ? 'robinhood' : 'bsc')); }
      let n = 0; for (let i = 0; i < Math.min(ids.length, 100); i += 50) { try { const part = ids.slice(i, i + 50); for (const id of part) ASKED.set(id.split('-')[0], Date.now()); if (ASKED.size > 5000) ASKED.clear(); const d = await call('/v2/tokens/search', 100, { token_ids: part }); n += ingestTokens(Array.isArray(d) ? d : d?.tokens || []); } catch (e) { log('[AVE] 补查 ' + e.message); break; } }
      if (n) save();
    } finally { busy2 = false; }
  }
  
  let busy3 = false; async function smartTick() { if (busy3) return; busy3 = true;
    try { const SM = {}, SW = {}; for (const [ch, q] of [['bsc', 'bsc'], ['rh', 'robinhood']]) { try { const d = await call('/v2/address/smart_wallet/list?chain=' + q, 5); const L = Array.isArray(d) ? d : [];
        SW[ch] = L.slice(0, 100).map((w) => ({ a: String(w.wallet_address || '').toLowerCase(), pr: num(w.total_profit_rate), p: num(w.total_profit), n: num(w.total_trades), w9: num(w.profit_above_900_percent_num), w3: num(w.profit_300_900_percent_num), t: num(w.last_trade_time), r: String(w.remark || '').slice(0, 30) })).filter((w) => /^0x[0-9a-f]{40}$/.test(w.a));
        const M = (SM[ch] = {}); for (const w of L) for (const it of Array.isArray(w.tag_items) ? w.tag_items : []) { const a = String(it.address || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) continue; const o = (M[a] = M[a] || { n: 0, v: 0, s: String(it.symbol || '').slice(0, 20), w: [] }); o.n++; o.v += num(it.volume) || 0; if (o.w.length < 8) o.w.push(String(w.wallet_address || '').toLowerCase()); } } catch (e) { log('[AVE] 聪明钱 ' + e.message); } }
      if (Object.keys(SM).length) { B.sm = SM; B.sw = SW; B.smAt = Date.now(); save(); } } finally { busy3 = false; } }
  
  let busy4 = false; async function hotTick() { if (busy4 || slowCheck()) return; busy4 = true;
    try { const all = []; for (const [ch, M] of Object.entries(B.m)) { if (ch !== 'bsc' && ch !== 'rh') continue; /*MC121 热门补查照旧只补 BNB Chain／Robinhood*/ for (const [a, v] of Object.entries(M)) all.push([ch, a, +v.v24 || 0]); } all.sort((x, y) => y[2] - x[2]);
      const ids = all.slice(0, 50).map(([ch, a]) => a + '-' + (ch === 'rh' ? 'robinhood' : 'bsc')); if (!ids.length) return; const d = await call('/v2/tokens/search', 100, { token_ids: ids }); let n = 0; for (const t of Array.isArray(d) ? d : d?.tokens || []) { put(pack(t)); n++; } if (n) save(); } catch (e) { log('[AVE] 热门补查 ' + e.message); } finally { busy4 = false; } }
  const htParse = (L) => { /* KOL-AVE：AVE 持有人 new_tags → 各类人数／占比（%）。en 有写就照 en 判断（type 编号可能会变），en 空白才看 type；同一个持有人每类只算一次 */
  const C = { kol: [/^kol$/i, '31'], sm: [/^smart\s*money$/i, '30'], wh: [/^whale$/i, '39'], bu: [/^bundle/i, '36'], ca: [/^cabal$/i, '35'], ph: [/^phishing/i, '34'] };
  const rs = L.map((x) => Number(x?.balance_ratio) || 0); const isPct = rs.reduce((a, b) => a + b, 0) > 1.0001; const o = { n: L.length, all: [] }; for (const k of Object.keys(C)) o[k] = { n: 0, p: 0 }; o.kol.w = [];
  L.forEach((x, i) => { let G = x?.new_tags; if (typeof G === 'string') { try { G = JSON.parse(G); } catch { G = []; } } const a = String(x?.holder || x?.address || x?.wallet_address || '').toLowerCase(); if (/^0x[0-9a-f]{40}$/.test(a)) o.all.push(a); const hit = new Set(); let nick = '';
    for (const t of Array.isArray(G) ? G : []) { if (!t || typeof t !== 'object') continue; const en = String(t.en ?? '').trim(), ty = String(t.type ?? '').trim(); for (const [k, [re, code]] of Object.entries(C)) if (en ? re.test(en) : ty === code) { hit.add(k); if (k === 'kol' && !nick) nick = String(t.nick_name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30); } }
    if (hit.has('kol') && !nick) nick = String(x?.addr_alias || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30); /* nick_name 空白时用 AVE 的地址别名 */
    for (const k of hit) { o[k].n++; o[k].p += isPct ? rs[i] : rs[i] * 100; } if (hit.has('kol') && o.kol.w.length < 20 /* 显示用：最多列几位 */) o.kol.w.push({ a, nm: nick }); });
  for (const k of Object.keys(C)) o[k].p = Math.round(o[k].p * 10) / 10; return o; };
  /* KOL-AVE（v1.0.2）：看盘前排代币的持有人标签（卡片显示「🎙 KOL×n」；引擎读不到 main.cjs 的资料时也会参考）。
     每轮从每个榜单前几名里挑最久没查的几个币，查 /v2/tokens/holders（top100 的 new_tags 只有 TOPn，holders 才有 KOL 等标签）；B.ht[ch][币] = { at, n, k（KOL 人数）, kn（KOL 名字）, sm, wh, bu:[人数, 占比%], ca, ph } */
  const HT_BATCH = 15; /* 吞吐量：每轮查几个币（AVE 额度；其余下一轮轮到） */ const HT_TOPN = 10; /* 吞吐量：每个榜单看前几名 */ const HT_FRESH_MS = 30 * 60e3; /* 运作：同一个币多久重查 */ const HT_MAX = 400; /* 技术用：最多记几个币（上传大小） */
  let busy5 = false; async function htTick() { if (busy5 || slowCheck()) return; busy5 = true;
    try { const now = Date.now(); B.ht = B.ht || { bsc: {}, rh: {} }; for (const ch of ['bsc', 'rh']) B.ht[ch] = B.ht[ch] || {};
      const cand = new Map(); for (const L of Object.values(B.cols || {})) for (const a of (Array.isArray(L) ? L : []).slice(0, HT_TOPN)) { const ch = B.m.bsc?.[a] ? 'bsc' : B.m.rh?.[a] ? 'rh' : ''; if (ch) cand.set(ch + ':' + a, [ch, a, +B.m[ch][a].v24 || 0]); }
      const pick = [...cand.values()].filter(([ch, a]) => !(now - (+B.ht[ch][a]?.at || 0) < HT_FRESH_MS)).sort((x, y) => (+B.ht[x[0]][x[1]]?.at || 0) - (+B.ht[y[0]][y[1]]?.at || 0) || y[2] - x[2]).slice(0, HT_BATCH);
      let n = 0; for (const [ch, a] of pick) { try { const d = await call(`/v2/tokens/holders/${a}-${ch === 'rh' ? 'robinhood' : 'bsc'}?limit=100`, 10); const L = Array.isArray(d) ? d : Array.isArray(d?.list) ? d.list : []; if (!L.length) continue; const o = htParse(L);
          B.ht[ch][a] = { at: Date.now(), n: o.n, k: o.kol.n, kn: o.kol.w.map((w) => w.nm).filter(Boolean).slice(0, 5), sm: o.sm.n, wh: o.wh.n, bu: [o.bu.n, o.bu.p], ca: [o.ca.n, o.ca.p], ph: [o.ph.n, o.ph.p] }; n++; } catch (e) { log('[AVE] 持有人标签 ' + e.message); break; } await new Promise((r) => setTimeout(r, 100 /* 技术用：两次呼叫之间隔一下 */)); }
      for (const ch of ['bsc', 'rh']) { const E = Object.entries(B.ht[ch]).filter(([, v]) => now - (+v.at || 0) < 3 * 3600e3 /* 运作：太旧的拿掉 */).sort((x, y) => y[1].at - x[1].at).slice(0, HT_MAX); B.ht[ch] = Object.fromEntries(E); }
      if (n) save(); } finally { busy5 = false; } }
  setTimeout(htTick, 100e3); setInterval(htTick, 10 * 60e3).unref(); /* KOL-AVE：定时跑，第一次在清单之后 */
  setTimeout(listTick, 15e3); setInterval(listTick, 5 * 60e3).unref(); setInterval(wantTick, 2 * 60e3).unref();
  setTimeout(smartTick, 40e3); setInterval(smartTick, 10 * 60e3).unref(); setTimeout(hotTick, 90e3); setInterval(hotTick, 15 * 60e3).unref();
  log('[AVE] 资料同步启动（清单每 5 分钟、新币补查每 2 分钟）');
  return { listTick, wantTick, smartTick, hotTick, htTick, /* KOL-AVE */ ingestList: (tag, arr) => { const n = ingestList(tag, arr); if (n) save(); return n; }, ingestTokens: (arr) => { const n = ingestTokens(arr); if (n) save(); return n; } };
}
