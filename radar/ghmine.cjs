// 罗宾猫雷达 · GHM-1104（Nancy 11/4，看到 siworld 想到的）：⛏ 其他链／自有网络（GitHub 观察）
// 有些挖矿项目不在 BNB Chain／Robinhood（例如自己的网络），雷达不会自动处理，只做提醒：
//   你贴 GitHub 项目网址（「我加的」）＋官方签名清单里推荐的（remote mineGh[]，只读）→ 雷达定时看最新提交、最新版本／标签，有新动态就在挖矿看盘上标一个点。
//   通知（新版本／新标签、新提交）各一个开关，预设都关；开了才发，一个新版本／标签只发一次。
// 这个档只读 GitHub 的公开资料（不登入、不带任何金钥），不碰钱包、不下单、不改你的买卖设定、不会买任何东西。
'use strict';
const fs = require('fs'), path = require('path');
/* 技术用（跟要不要买、要不要通知无关）：GitHub 免登入每个 IP 每小时只有 60 次，所以多久轮到下一个项目、一次最多等多久、
   出错后最长隔多久再试、次数快用完时留几次给你按「立即查看」、清单／文字最多存多少（防资料过大） */
const GHT = { tick: 150e3, first: 20e3, timeout: 15e3, backMax: 3600e3, keep: 3, maxRepos: 200, maxRemote: 100, txt: 140, name: 60 };
let C = { DATA: '', SET: '', remote: () => null, say: () => {}, fetch: (...a) => fetch(...a) };
const ST = { f: '', v: null, busy: 0, rot: 0, timer: null };
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);
/* owner/repo 或 https://github.com/owner/repo(.git)(/…) → 'owner/repo'；格式不对＝空字串 */
function repoKey(u) {
  let s = String(u || '').trim().replace(/^git\+/, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/[?#].*$/, '');
  const m = s.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/.*)?$/);
  if (!m || m[2] === '.' || m[2] === '..') return '';
  return (m[1] + '/' + m[2]).toLowerCase();
}
function load() { if (!ST.v) { ST.v = readJSON(ST.f, {}); if (!ST.v || typeof ST.v !== 'object') ST.v = {}; ST.v.r = ST.v.r && typeof ST.v.r === 'object' ? ST.v.r : {}; ST.v.rl = ST.v.rl || {}; } return ST.v; }
function save() { try { const tmp = ST.f + '.w' + process.pid; fs.writeFileSync(tmp, JSON.stringify(ST.v)); fs.renameSync(tmp, ST.f); } catch {} }
function settings() { const s = readJSON(C.SET, {}); return s && typeof s === 'object' ? s : {}; }
/* 官方签名清单（main.cjs 验过签名才会交给这里）：[{ repo 或 url, name, note }] */
function remoteList(D) {
  const L = Array.isArray(D?.mineGh) ? D.mineGh : [];
  const out = []; const seen = new Set();
  for (const x of L) { const k = repoKey(x?.repo || x?.url); if (!k || seen.has(k)) continue; seen.add(k); out.push({ repo: k, name: clean(x.name, GHT.name), note: clean(x.note, GHT.txt) }); if (out.length >= GHT.maxRemote) break; /* 技术用：防资料过大 */ }
  return out;
}
/* 要观察的全部项目：你加的（mine.ghMy）＋官方推荐（只读）。同一个项目只算一次，你加的优先 */
function repos() {
  const S = settings(); const M = new Map();
  for (const x of Array.isArray(S['mine.ghMy']) ? S['mine.ghMy'] : []) { const k = repoKey(x?.repo || x); if (k && !M.has(k)) M.set(k, { repo: k, src: 'my', name: clean(x?.name, GHT.name), note: clean(x?.note, GHT.txt), at: +x?.at || 0 }); }
  for (const x of C.remote()?.mineGh || []) { const k = repoKey(x?.repo); if (k && !M.has(k)) M.set(k, { repo: k, src: 'of', name: clean(x.name, GHT.name), note: clean(x.note, GHT.txt) }); }
  return [...M.values()].slice(0, GHT.maxRepos); /* 技术用：防资料过大 */
}
/* 读一个 GitHub API 网址：带上次的 ETag（没变＝304，不扣 GitHub 次数），记下剩几次、何时恢复 */
async function ghGet(url, etag) {
  const V = load(); const h = { accept: 'application/vnd.github+json', 'user-agent': 'robincat-radar', 'x-github-api-version': '2022-11-28' };
  if (etag) h['if-none-match'] = etag;
  const r = await C.fetch(url, { headers: h, signal: AbortSignal.timeout(GHT.timeout) });
  const rem = r.headers.get('x-ratelimit-remaining'), rst = r.headers.get('x-ratelimit-reset'), ra = r.headers.get('retry-after');
  if (rem != null && rem !== '' && Number.isFinite(+rem)) V.rl.rem = +rem;
  if (rst != null && rst !== '' && Number.isFinite(+rst)) V.rl.reset = +rst * 1e3;
  V.rl.at = Date.now();
  if (r.status === 304) return { same: 1, etag };
  if (r.status === 403 || r.status === 429) { /* GitHub 说次数用完／请慢一点 → 整个暂停到它说的时间 */
    const until = ra != null && Number.isFinite(+ra) ? Date.now() + +ra * 1e3 : V.rl.reset > Date.now() ? V.rl.reset : Date.now() + GHT.backMax;
    V.rl.pause = until; const e = new Error('GitHub 暂时不让查（免登入次数用完），' + new Date(until).toLocaleTimeString() + ' 后再试'); e.rl = 1; throw e;
  }
  if (r.status === 404) { const e = new Error('找不到这个项目（网址打错，或是私人项目）'); e.nf = 1; throw e; }
  if (!r.ok) throw new Error('GitHub 回应 ' + r.status);
  return { j: await r.json(), etag: r.headers.get('etag') || '' };
}
const canAsk = (manual) => { const V = load(); const now = Date.now(); if (V.rl.pause && now < V.rl.pause) return false; if (!manual && V.rl.rem != null && V.rl.rem <= GHT.keep && V.rl.reset > now) return false; return true; };
/* 查一个项目：最新提交＋最新版本（没有版本就看标签） */
async function checkRepo(k, manual) {
  const V = load(); const R = V.r[k] || (V.r[k] = { e: {} }); R.e = R.e || {};
  if (!canAsk(manual)) return R;
  const B = 'https://api.github.com/repos/' + k;
  const old = { rel: R.rel?.tag || '', sha: R.commit?.sha || '' };
  try {
    const c = await ghGet(B + '/commits?per_page=1', R.e.c);
    if (!c.same) { R.e.c = c.etag; const x = Array.isArray(c.j) ? c.j[0] : null; R.commit = x ? { sha: String(x.sha || '').slice(0, 40), at: Date.parse(x.commit?.committer?.date || x.commit?.author?.date || '') || 0, msg: clean(String(x.commit?.message || '').split('\n')[0], GHT.txt), url: /^https:\/\/github\.com\//.test(x.html_url || '') ? String(x.html_url) : 'https://github.com/' + k + '/commits' } : null; }
    if (R.noRel !== 1) { /* 有发版本的项目看 releases；没有就改看 tags（之后也照这样） */
      const r = await ghGet(B + '/releases?per_page=1', R.e.r);
      if (!r.same) { R.e.r = r.etag; const x = Array.isArray(r.j) ? r.j[0] : null; if (x) R.rel = { kind: 'release', tag: clean(x.tag_name, GHT.name), name: clean(x.name, GHT.txt), at: Date.parse(x.published_at || x.created_at || '') || 0, pre: x.prerelease ? 1 : 0, url: /^https:\/\/github\.com\//.test(x.html_url || '') ? String(x.html_url) : 'https://github.com/' + k + '/releases' }; else R.noRel = 1; }
    }
    if (R.noRel === 1) {
      const t = await ghGet(B + '/tags?per_page=1', R.e.t);
      if (!t.same) { R.e.t = t.etag; const x = Array.isArray(t.j) ? t.j[0] : null; R.rel = x ? { kind: 'tag', tag: clean(x.name, GHT.name), name: '', at: 0, url: 'https://github.com/' + k + '/releases/tag/' + encodeURIComponent(String(x.name || '')) } : null; }
    }
    R.err = ''; R.fail = 0; R.next = 0; R.checked = Date.now();
    /* 第一次查到＝当作基准，不标新动态、不通知；之后有变才算 */
    if (!R.base) { R.base = 1; R.seen = { rel: R.rel?.tag || '', sha: R.commit?.sha || '' }; }
    else {
      const S = settings(); const nm = k;
      if (R.rel?.tag && R.rel.tag !== old.rel && R.notified !== R.rel.tag) { R.newAt = Date.now(); R.notified = R.rel.tag; if (+S['mine.ghNotify'] === 1) C.say(`⛏ GitHub 观察：${nm} 有新${R.rel.kind === 'tag' ? '标签' : '版本'} ${R.rel.tag}${R.rel.name && R.rel.name !== R.rel.tag ? '（' + R.rel.name + '）' : ''}\n${R.rel.url}\n（不在 BNB Chain／Robinhood，雷达不会自动处理，只做提醒）`); }
      if (R.commit?.sha && R.commit.sha !== old.sha && old.sha) { R.newAt = Date.now(); if (+S['mine.ghNotifyCommit'] === 1 && R.cNotified !== R.commit.sha) { R.cNotified = R.commit.sha; C.say(`⛏ GitHub 观察：${nm} 有新提交「${R.commit.msg}」\n${R.commit.url}\n（不在 BNB Chain／Robinhood，雷达不会自动处理，只做提醒）`); } }
    }
  } catch (e) {
    R.err = clean(e?.message || e, GHT.txt); R.checked = Date.now();
    if (!e?.rl) { R.fail = (R.fail || 0) + 1; R.next = Date.now() + Math.min(GHT.backMax, GHT.tick * 2 ** Math.min(R.fail, GHT.keep * 2)); } /* 技术用：出错就越隔越久再试（不影响别的项目） */
  }
  save(); return R;
}
/* 轮流：每次只查一个项目（GitHub 免登入次数很少），出错的等它的退避时间到才再查 */
async function tick() {
  if (ST.busy) return; ST.busy = 1;
  try {
    const L = repos(); const V = load();
    for (const k of Object.keys(V.r)) if (!L.some((x) => x.repo === k)) delete V.r[k]; /* 你删掉的项目，资料也一起清掉 */
    if (!L.length || !canAsk(false)) return;
    const now = Date.now(); const ok = L.filter((x) => !(V.r[x.repo]?.next > now));
    if (!ok.length) return;
    /* 还没查过的先查，其余照上次查的时间轮流 */
    ok.sort((a, b) => (V.r[a.repo]?.checked || 0) - (V.r[b.repo]?.checked || 0));
    await checkRepo(ok[0].repo, false);
  } catch {} finally { ST.busy = 0; }
}
function view() {
  const V = load(); const S = settings();
  const items = repos().map((x) => { const R = V.r[x.repo] || {}; const seen = R.seen || {};
    const isNew = !!R.base && ((R.rel?.tag && R.rel.tag !== seen.rel) || (R.commit?.sha && R.commit.sha !== seen.sha));
    return { ...x, url: 'https://github.com/' + x.repo, commit: R.commit || null, rel: R.rel || null, checked: R.checked || 0, err: R.err || '', next: R.next || 0, isNew: isNew ? 1 : 0, relNew: R.base && R.rel?.tag && R.rel.tag !== seen.rel ? 1 : 0 }; });
  return { items, rl: { rem: V.rl.rem ?? null, reset: V.rl.reset || 0, pause: V.rl.pause > Date.now() ? V.rl.pause : 0 }, notify: +S['mine.ghNotify'] === 1 ? 1 : 0, notifyCommit: +S['mine.ghNotifyCommit'] === 1 ? 1 : 0, tickMs: GHT.tick };
}
async function ghm(a, o) {
  if (a === 'list') return view();
  if (a === 'seen') { const k = repoKey(o?.repo); const V = load(); const R = V.r[k]; if (R) { R.seen = { rel: R.rel?.tag || '', sha: R.commit?.sha || '' }; save(); } return view(); }
  if (a === 'check') { const k = repoKey(o?.repo); if (!k || !repos().some((x) => x.repo === k)) return { err: '不在观察清单里' }; if (ST.busy) return view(); ST.busy = 1; try { await checkRepo(k, true); } finally { ST.busy = 0; } return view(); }
  if (a === 'key') return { repo: repoKey(o?.url) };
  return { err: 'unknown' };
}
function install({ ipcMain, DATA, SET, remote, say, fetch: f }) {
  C = { ...C, DATA, SET, remote: typeof remote === 'function' ? remote : C.remote, say: typeof say === 'function' ? say : C.say, ...(typeof f === 'function' ? { fetch: f } : {}) };
  ST.f = path.join(DATA, 'gh_mine.json'); ST.v = null;
  try { ipcMain?.handle('ghm', (e, a, o) => ghm(String(a || ''), o).catch((er) => ({ err: String(er?.message || er).slice(0, GHT.txt) }))); } catch {}
  if (ST.timer) clearInterval(ST.timer);
  setTimeout(() => tick(), GHT.first).unref?.(); ST.timer = setInterval(() => tick(), GHT.tick); ST.timer.unref?.();
}
module.exports = { install, repoKey, remoteList, ghm, tick, checkRepo, _st: ST, _GHT: GHT };
