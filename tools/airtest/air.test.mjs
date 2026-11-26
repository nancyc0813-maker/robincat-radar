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
