// AIRLOCAL-1126 测试：每日空投雷达（时间、只推新的、事实分组、一则讯息、今日无新项目）＋空投清单引擎／视窗轮流更新。不连网（fetch 是假的）、不发 TG。
import test from 'node:test'; import assert from 'node:assert/strict'; import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module'; import { spawn } from 'node:child_process';
import { buildReport, parseHM, startAirReport } from '../../airreport.mjs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DAY = 86400e3; const at = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi).getTime(); const NOW = at(2026, 11, 26, 15, 5);
const item = (n, o = {}) => ({ name: 'P' + n, url: `https://airdrops.io/p${n}/`, heat: n, pub: '2026-11-25', kinds: ['latest'], act: 'Trade', ...o });

test('parseHM：HH:MM 才算，其他＝没填', () => { assert.deepEqual(parseHM('15:00'), { h: 15, mi: 0 }); assert.deepEqual(parseHM('9：30'), { h: 9, mi: 30 }); for (const v of ['', null, '25:00', '15', 'abc']) assert.equal(parseHM(v), null); });
test('没有新项目 → 「今日无新项目」，标题＋DYOR，没有赞助行', () => { const r = buildReport({ list: [item(1, { pub: '2026-10-01' })], at: NOW, days: 3, now: NOW }); assert.match(r.text, /^🪂 每日空投雷达 11\/26/); assert.match(r.text, /今日无新项目/); assert.match(r.text, /DYOR/); assert.ok(!/AVE|赞助|贊助/.test(r.text)); assert.equal(r.items.length, 0); });
test('只列最近 N 天、没推过、没截止的；分组只看事实（可领取／已确认／热门／最新）', () => {
  const list = [item(1, { claim: true }), item(2, { confirmed: true, det: { fund: '$10M', led: 'Paradigm', fsrc: 'blog.x' } }), item(3, { kinds: ['hot', 'latest'] }), item(4), item(5, { pub: '2026-11-01' }), item(6, { ends: '2026-11-20' }), item(7, { pub: '' })];
  const r = buildReport({ list, at: NOW, days: 3, sent: { [list[3].url]: NOW - DAY }, firstSeen: { [list[6].url]: NOW - 3600e3 }, now: NOW });
  const names = r.items.map((x) => x.name); assert.deepEqual(names, ['P1', 'P2', 'P3', 'P7']); /* P4 推过、P5 太旧、P6 已截止；P7 没有收录日＝用第一次看到 */
  const t = r.text; assert.ok(t.indexOf('✅ 已经可以领取') < t.indexOf('📌 已确认会空投') && t.indexOf('📌') < t.indexOf('🔥 热门榜上') && t.indexOf('🔥') < t.indexOf('🆕 最新收录'));
  assert.match(t, /融资：\$10M（Paradigm）（来源：blog\.x）/); assert.ok(!/推荐|值得|建议参与/.test(t.replace('不是推荐', '')), '不下判断'); });
test('一则讯息：很多新项目也不超过 Telegram 上限，放不下的写「另有 N 个」', () => { const list = Array.from({ length: 300 }, (_, i) => item(i, { act: 'x'.repeat(100) })); const r = buildReport({ list, at: NOW, days: 3, now: NOW }); assert.ok(r.text.length <= 4096, `${r.text.length}`); assert.match(r.text, /另有 \d+ 个新项目放不下/); assert.ok(r.items.length > 0 && r.items.length < 300); });
function env(set, list = [item(1), item(2, { confirmed: true })]) { const DIR = mkdtempSync(join(tmpdir(), 'air-')); mkdirSync(join(DIR, 'data')); writeFileSync(join(DIR, 'data', 'air_hot.json'), JSON.stringify({ v: 2, at: NOW - 600e3, list }));
  const sent = []; const clock = { t: NOW }; let ok = true; const R = startAirReport({ DIR, radarSet: () => set, send: async (t) => { sent.push(t); return ok; }, log: () => {}, now: () => clock.t }); R.stop(); return { DIR, R, sent, clock, fail: (v) => { ok = !v; } }; }
test('开关＋时间＋天数都要有才发；时间到才发、一天一次、推过的不再推', async () => {
  let E = env({ 'air.daily.on': 0, 'air.daily.time': '15:00', 'air.daily.days': 3 }); assert.equal((await E.R.tick()).sent, false); assert.equal(E.sent.length, 0);
  E = env({ 'air.daily.on': 1, 'air.daily.days': 3 }); assert.match((await E.R.tick()).why, /几点发/);
  E = env({ 'air.daily.on': 1, 'air.daily.time': '15:00' }); assert.match((await E.R.tick()).why, /最近几天/);
  E = env({ 'air.daily.on': 1, 'air.daily.time': '15:30', 'air.daily.days': 3 }); assert.equal((await E.R.tick()).sent, false, '还没到 15:30');
  E = env({ 'air.daily.on': 1, 'air.daily.time': '15:00', 'air.daily.days': 3 }); const r1 = await E.R.tick(); assert.equal(r1.sent, true); assert.equal(r1.n, 2); assert.equal((await E.R.tick()).sent, false, '今天发过了');
  E.clock.t += DAY; const r2 = await E.R.tick(); assert.equal(r2.sent, true); assert.match(r2.text, /今日无新项目/, '第二天：推过的不再推');
  const st = JSON.parse(readFileSync(join(E.DIR, 'data', 'air_daily.json'), 'utf8')); assert.equal(Object.keys(st.sent).length, 2, '推过的存档（重开也记得）'); });
test('TG 没送出 → 不算发过，下次再试', async () => { const E = env({ 'air.daily.on': 1, 'air.daily.time': '15:00', 'air.daily.days': 3 }); E.fail(true); assert.equal((await E.R.tick()).sent, false); E.fail(false); assert.equal((await E.R.tick()).sent, true); });
test('TG 类别：🪂 自己一类（tg.cat.air），可以只开这一类；群组要另外开', () => { const s = readFileSync(join(ROOT, 'watch.mjs'), 'utf8'); assert.match(s, /if \(\/\^🪂\/u\.test\(t\)\) return 'air';/); const i = s.indexOf('async function airSay'); const f = s.slice(i, i + 900);
  assert.match(f, /const md = tgMode\(text\)/); assert.match(f, /if \(md\) ok = /); assert.match(f, /GROUP_ID && nrOn\('air\.daily\.group'\)/); const S = JSON.parse(readFileSync(join(ROOT, 'radar', 'settings_schema.json'), 'utf8')); for (const k of ['tg.cat.air', 'air.daily.on', 'air.daily.time', 'air.daily.days', 'air.daily.group']) assert.ok(S.items.some((x) => x.k === k), k); });
test('空投清单：另一边（视窗／引擎）正在抓 → 这边不抓；对方不在了才抓；对方抓完的档案这边读得到', async (t) => { const DATA = mkdtempSync(join(tmpdir(), 'airh-')); let n = 0; const f0 = globalThis.fetch; globalThis.fetch = async () => { n++; return { text: async () => '', json: async () => [] }; }; t.after(() => { globalThis.fetch = f0; });
  const other = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)']); t.after(() => other.kill('SIGKILL')); writeFileSync(join(DATA, 'air_refresh.lock'), JSON.stringify({ pid: other.pid, at: Date.now() }));
  const A = createRequire(import.meta.url)('../../radar/air.cjs').startAir({ DATA, browse: null }); await A.refresh(true); assert.equal(n, 0, '对方在抓：这边不抓');
  writeFileSync(join(DATA, 'air_hot.json'), JSON.stringify({ v: 2, at: Date.now(), list: [item(9)] })); assert.equal(A.hot().list[0].name, 'P9', '对方抓完写的档案这边要读到');
  other.kill('SIGKILL'); await new Promise((r) => other.on('exit', r)); await A.refresh(true); assert.ok(n > 0, '对方不在了：这边自己抓'); assert.ok(!existsSync(join(DATA, 'air_refresh.lock')), '抓完把锁删掉'); });
test('读不到空投清单 → 不发（不能说成「今日无新项目」）；发之前会先叫清单更新', async () => { const DIR = mkdtempSync(join(tmpdir(), 'air-')); mkdirSync(join(DIR, 'data')); const sent = []; let rf = 0;
  const R = startAirReport({ DIR, radarSet: () => ({ 'air.daily.on': 1, 'air.daily.time': '15:00', 'air.daily.days': 3 }), send: async (t) => { sent.push(t); return true; }, log: () => {}, refresh: async () => { rf++; }, now: () => NOW }); R.stop();
  const r = await R.tick(); assert.equal(r.sent, false); assert.match(r.why, /还没有资料/); assert.equal(sent.length, 0); assert.equal(rf, 1);
  writeFileSync(join(DIR, 'data', 'air_hot.json'), JSON.stringify({ v: 2, at: NOW, list: [item(1)] })); assert.equal((await R.tick()).sent, true); });
/* TGSAY-1126：没有分类的 TG 讯息（tgSay）照 tg.cat.say；空白＝照以前；安全相关、指令回覆一律照发 */
function sayMode(set, store = null) { const s = readFileSync(join(ROOT, 'watch.mjs'), 'utf8'); const a = s.indexOf('const TGS_SAFE ='), b = s.indexOf('async function tgSay(', a); assert.ok(a > 0 && b > a);
  return new Function('radarSet', 'GATE_CTX', s.slice(a, b) + '; return { tgSayMode, TGS_M };')(() => set, { getStore: () => store }); }
test('tg.cat.say：空白＝跟以前一样响铃发；1 静音；2 响铃；3 不发', () => { const msg = '🖥 雷达手动买 X\n✅ 成交';
  let F = sayMode({}); assert.equal(F.tgSayMode(msg), F.TGS_M.ring, '旧用户没设＝照以前');
  F = sayMode({ 'tg.cat.say': 1 }); assert.equal(F.tgSayMode(msg), F.TGS_M.silent); F = sayMode({ 'tg.cat.say': 2 }); assert.equal(F.tgSayMode(msg), F.TGS_M.ring); F = sayMode({ 'tg.cat.say': 3 }); assert.equal(F.tgSayMode('🌙 每日总结'), F.TGS_M.mute); });
test('tg.cat.say＝不发：安全相关、TG 指令回覆照样发', () => { const F = sayMode({ 'tg.cat.say': 3 });
  for (const m of ['🛑 已紧急全停（在电脑上按的）', '🛡 这些设定不是在雷达画面改的', '⏸ 连续亏了 3 笔，已自动暂停买入', '👛 雷达的钱包还没连上', '🔒 还没完成邀请码绑定', '⚠️ [w] 已送出含「授权」的交易', '⚠️ 你的电脑同时开了两个罗宾猫雷达，而且用同一个钱包', '⚠️ 卖出出错：x', '▶ 雷达已重新设定，解除紧急全停。']) assert.equal(F.tgSayMode(m), F.TGS_M.ring, m);
  assert.equal(sayMode({ 'tg.cat.say': 3 }, { src: 'tg' }).tgSayMode('💼 钱包余额'), 2, 'TG 指令的回覆一定发'); assert.equal(F.tgSayMode('🔄 重要更新（自动）：已更新'), F.TGS_M.mute); });
test('只收每日空投雷达的设定：其他类别全部不发', () => { const S = JSON.parse(readFileSync(join(ROOT, 'radar', 'settings_schema.json'), 'utf8')); const say = S.items.find((x) => x.k === 'tg.cat.say'); assert.ok(say.opts.some((o) => o.v === 3), '要有「不发」');
  const cats = S.items.filter((x) => /^tg\.cat\./.test(x.k)).map((x) => x.k).sort(); assert.ok(cats.includes('tg.cat.air') && cats.includes('tg.cat.say')); });

/* AIRFB-1126：首页被 Cloudflare 挡 → 记原因、改用网站地图；清单太旧要照实说 */
test('清单比「最近 N 天」还旧 → 照实说清单停在哪天，不说「今日无新项目」', () => { const r = buildReport({ list: [item(1)], at: NOW - 10 * DAY, days: 3, now: NOW }); assert.ok(r.stale); assert.match(r.text, /空投清单停在 11\/16/); assert.ok(!/今日无新项目/.test(r.text)); assert.match(r.text, /DYOR/); assert.equal(r.items.length, 0); });
test('备用来源（网站地图）的项目：标明来源、没有状态标签；图片上传月份是新的、而且来源最近有更新才列（旧项目更新不算）', () => {
  const sm = (n, upd, ym) => ({ name: 'S' + n, url: `https://airdrops.io/s${n}/`, upd, ym, via: 'sitemap', kind: 'sitemap', heat: 0 });
  const list = [sm(1, '2026-11-25', '2026-11'), sm(2, '2026-10-01', '2026-11'), sm(3, '2026-11-26', '2024-09')];
  const r = buildReport({ list, at: NOW, days: 3, now: NOW, src: 'sitemap' }); assert.deepEqual(r.items.map((x) => x.name), ['S1'], 'S2 来源很久没更新、S3 是旧项目（2024 年的图片）只是更新');
  assert.match(r.text, /网站地图（首页读不到，用备用来源）/); assert.match(r.text, /🆕 新收录（备用来源：网站地图/); assert.match(r.text, /来源更新：2026-11-25｜图片上传：2026-11/); assert.ok(!/📌 已确认会空投|🔥 热门榜上/.test(r.text)); });
test('首页回 Cloudflare 验证页 → 记下原因、改用网站地图（只用网址／来源更新日）', async (t) => { const DATA = mkdtempSync(join(tmpdir(), 'airfb-')); const f0 = globalThis.fetch; const logs = []; t.after(() => { globalThis.fetch = f0; });
  const SM = '<?xml version="1.0"?><urlset><url><loc>https://airdrops.io/flop-labs/</loc><lastmod>2026-11-25T15:52:31+00:00</lastmod><image:image><image:loc>https://airdrops.io/wp-content/uploads/2026/08/x.png</image:loc></image:image></url><url><loc>https://airdrops.io/blog/x/</loc><lastmod>2026-11-25</lastmod></url></urlset>';
  globalThis.fetch = async (u) => { u = String(u); const res = (status, body) => ({ ok: status === 200, status, text: async () => body, json: async () => [] });
    if (/sitemap_index/.test(u)) return res(200, '<sitemapindex><sitemap><loc>https://airdrops.io/project-sitemap2.xml</loc><lastmod>2026-01-01T00:00:00+00:00</lastmod></sitemap><sitemap><loc>https://airdrops.io/project-sitemap1.xml</loc><lastmod>2026-11-25T16:10:52+00:00</lastmod></sitemap><sitemap><loc>https://airdrops.io/post-sitemap.xml</loc><lastmod>2026-11-26</lastmod></sitemap></sitemapindex>');
    if (/project-sitemap1/.test(u)) return res(200, SM); if (/airdrops\.io\/(hot|latest|confirmed|flop)/.test(u)) return res(403, '<title>Just a moment...</title>'); return res(200, '[]'); };
  const A = createRequire(import.meta.url)('../../radar/air.cjs').startAir({ DATA, browse: null, log: (s) => logs.push(s) }); await A.refresh(true);
  const H = A.hot(); assert.equal(H.src, 'sitemap'); assert.equal(H.list.length, 1); assert.equal(H.list[0].name, 'Flop Labs'); assert.equal(H.list[0].upd, '2026-11-25'); assert.equal(H.list[0].ym, '2026-08'); assert.ok(!H.list[0].det?.desc, '详情页会被挡：不去抓');
  const D = JSON.parse(readFileSync(join(DATA, 'air_fetch.json'), 'utf8')); assert.deepEqual(D.pages.map((p) => p.status), [403, 403, 403]); assert.match(D.pages[0].why, /Cloudflare/); assert.equal(D.fallback.file, 'https://airdrops.io/project-sitemap1.xml');
  assert.ok(logs.some((l) => /Cloudflare 验证页.*改用网站地图：1 个/.test(l)), logs.join('\n')); });

/* AIRS-1126：首页回 200 却读不到项目 → 存样本（标头＋开头一段）；标准格式读不到时用宽松读法 */
test('回 200 但格式不同：宽松读法找项目连结（分类／部落格不算），并存样本档', async (t) => { const DATA = mkdtempSync(join(tmpdir(), 'airs-')); const f0 = globalThis.fetch; t.after(() => { globalThis.fetch = f0; });
  const alt = '<html><nav><a href="/blog/">Blog</a><a href="https://airdrops.io/categories/ai/">AI</a></nav><div class="card"><a href="/flop-labs/"><h2>Flop Labs Airdrop</h2></a></div><div><a href="https://airdrops.io/deca/" title="Deca"><img src="x"></a></div>' + 'x'.repeat(9000) + '</html>';
  globalThis.fetch = async (u) => { u = String(u); const H = new Headers({ 'content-type': 'text/html', 'cf-cache-status': 'HIT' }); const res = (status, body) => ({ ok: status === 200, status, headers: H, text: async () => body, json: async () => [] });
    if (/airdrops\.io\/(hot|latest|confirmed)\//.test(u)) return res(200, /confirmed/.test(u) ? alt : '<html><body>nothing</body></html>'); if (/sitemap_index/.test(u)) return res(200, '<sitemapindex></sitemapindex>'); return res(200, '[]'); };
  const A = createRequire(import.meta.url)('../../radar/air.cjs').startAir({ DATA, browse: null }); await A.refresh(true);
  const H = A.hot(); assert.deepEqual(H.list.map((x) => x.name).sort(), ['Deca', 'Flop Labs']); assert.ok(H.list.every((x) => x.confirmed && x.via === 'loose'), '出现在「已确认」页');
  const D = JSON.parse(readFileSync(join(DATA, 'air_fetch.json'), 'utf8')); const c = D.pages.find((p) => p.k === 'confirmed'), h = D.pages.find((p) => p.k === 'hot'); assert.equal(c.loose, 1); assert.equal(h.n, 0); assert.match(h.why, /页面格式变了/);
  const S = readFileSync(join(DATA, 'air_fetch_sample_hot.html'), 'utf8'); assert.match(S, /HTTP 200/); assert.match(S, /cf-cache-status: HIT/); assert.match(S, /nothing/);
  const S2 = readFileSync(join(DATA, 'air_fetch_sample_confirmed.html'), 'utf8'); assert.ok(S2.length < 4096 + 600, `样本有上限（${S2.length}）`); });
test('AIRW-1127 只列值得做的：可领取／已确认／有融资才列；写明没有代币的不列；详情没读到先不列也不记成推过', () => {
  const L = [item(1, { confirmed: true }), item(2, { det: { fund: '$8M' } }), item(3, { det: { fund: '' } }), item(4, { confirmed: true, det: { desc: 'There is no DECA airdrop and no token.' } }), item(5, { det: undefined }), item(6, { claim: true })];
  const r = buildReport({ list: L, at: NOW, days: 3, now: NOW, worth: true });
  assert.deepEqual(r.items.map((x) => x.name).sort(), [L[0].name, L[1].name, L[5].name].sort());
  assert.match(r.text, /另有 2 个没融资、也没确认会空投，没列；1 个项目资料还没读到/);
  const off = buildReport({ list: L, at: NOW, days: 3, now: NOW }); assert.equal(off.items.length, 6, '没开＝全部列');
});
test('AIRW-1127 全部不值得做 → 「今日没有值得做的新项目」＋另有 N 个', () => { const r = buildReport({ list: [item(1, { det: { fund: '' } })], at: NOW, days: 3, now: NOW, worth: true }); assert.match(r.text, /今日没有值得做的新项目/); assert.match(r.text, /另有 1 个/); assert.equal(r.items.length, 0); });
test('AIRH3-1127 宽松读法抓到的（没有收录日、可能是导览页）日报不列', () => { const r = buildReport({ list: [item(1, { via: 'loose', pub: '' })], at: NOW, days: 3, now: NOW, firstSeen: { [item(1).url]: NOW } }); assert.equal(r.items.length, 0); });
