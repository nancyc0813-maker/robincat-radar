// 罗宾猫雷达 引擎 — 链上新项目监测、你自己开的买卖策略、持仓止盈止损。
// 全部在本地跑：扫 BSC 新合约 → 模拟 → 用 baw CLI 自动打 → 开池后照规则自动卖 → Telegram 通知。不使用任何 AI。
// 停止：在同资料夹放 WATCH_STOP 档。设定见 config.example.json。
import { execFile, execFileSync } from 'node:child_process';
import { openSync, readSync, closeSync } from 'node:fs';
import { appendFileSync, writeFileSync, readFileSync, existsSync, statSync, renameSync, copyFileSync, unlinkSync, mkdirSync, readdirSync, chmodSync } from 'node:fs';
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module'; import { AsyncLocalStorage } from 'node:async_hooks'; const ACK = new AsyncLocalStorage(); /* 这张单你是否按了「仍然执行」 */ const GATE_CTX = new AsyncLocalStorage(); /* GATE-1：这一笔是谁下的（TG 指令＝src:tg）——统一动作闸门用 */ const FACK = new Set(), FACKA = new Set(); /* 强制打时按了「仍然执行」的合约／也勾了「我看懂了」授权的 */ globalThis.ACK_STORE = () => ACK.getStore(); /* rh.mjs／bscnft.mjs 读：这张单是不是你按了「仍然执行」 */
const DIR = dirname(fileURLToPath(import.meta.url));
/* HN-FIX 11/5：电脑名是中文时，币安 baw 把它放进 HTTP 标头会出错（登入、扫码、下单全卡）→ 只对 baw 子程序换成英文设备名 */
{ try { const _os = await import('node:os'); const _h = _os.hostname(); if (/[^\x20-\x7e]/.test(_h)) { const _fs = await import('node:fs'); const _p = join(DIR, 'data', 'hn_shim.cjs'); const _safe = 'RobinCat-' + Buffer.from(_h).toString('hex').slice(0, 8); _fs.mkdirSync(join(DIR, 'data'), { recursive: true }); _fs.writeFileSync(_p, "const os=require('os');os.hostname=()=>" + JSON.stringify(_safe) + ";require('module').syncBuiltinESMExports();\n"); const _o = String(process.env.NODE_OPTIONS || ''); if (!_o.includes('hn_shim.cjs')) process.env.NODE_OPTIONS = (_o + ' --require ' + JSON.stringify(_p)).trim(); } } catch {} }
const SELF = fileURLToPath(import.meta.url), SELF_MT = statSync(SELF).mtimeMs;
const LOG = join(DIR, 'data', 'watch.log'), STATE = join(DIR, 'data', 'watch_state.json');
if (process.argv.includes('--tg-login')) { /* 选用功能：TG 群组监控的一次性登入（金钥、手机、登入码都由使用者自己在这个视窗输入，只存在本机 data/tg_user.json） */
  const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); const rl = (await import('node:readline')).createInterface({ input: process.stdin, output: process.stdout }); const ask = (q) => new Promise((r) => rl.question(q, (x) => r(x.trim()))); const askHidden = (q) => new Promise((r) => { const w0 = rl._writeToOutput; rl._writeToOutput = (str) => { if (str.includes(q)) w0.call(rl, str); else if (/\r?\n/.test(str)) w0.call(rl, '\n'); }; rl.question(q, (x) => { rl._writeToOutput = w0; r(x.trim()); }); }); /* 输入密码时不显示 */
  try { req.resolve('telegram'); } catch { console.log('第一次使用，正在安装 TG 套件（约 20MB）…'); (await import('node:child_process')).execSync('npm i telegram@2.26.22 --no-audit --no-fund', { cwd: DIR, stdio: 'inherit', shell: true }); }
  const { TelegramClient } = req('telegram'); const { StringSession } = req('telegram/sessions');
  console.log('=== TG 群组监控：一次性登入（只读你加入的群，不会发任何讯息）===\n先到 my.telegram.org 网站 → API development tools 建立一个 App（平台选 Desktop），就会看到 api_id 和 api_hash\n');
  const apiId = Number(await ask('api_id（一串数字）：')), apiHash = await ask('api_hash（一串英文数字）：');
  if (!apiId || !/^[0-9a-f]{32}$/i.test(apiHash)) { console.log('格式不对，请重新执行'); process.exit(1); }
  const cl = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 });
  await cl.start({ phoneNumber: () => ask('手机号码（含国码、去掉开头的 0，例如 +886912345678）：'), phoneCode: () => ask('登入码（在 TG App 里官方「Telegram」帐号传给你的讯息）：'), password: () => askHidden('两步骤验证密码（输入时不会显示；没设定就直接按 Enter）：'), /* 密码不显示在画面上 */ onError: (e) => console.log('错误：', e.message) });
  mkdirSync(join(DIR, 'data'), { recursive: true }); writeFileSync(join(DIR, 'data', 'tg_user.json'), JSON.stringify({ apiId, apiHash, session: cl.session.save() }));
  console.log('\n✅ 登入成功，工具会自动读你加入的群组（只读不发）。这个视窗可以关掉了。\n⚠️ data/tg_user.json 等于你的 TG 登入，不要传给别人；不想用了就删掉这个档案。'); await cl.disconnect(); rl.close(); process.exit(0);
}
{ /* 同时跑两份会重复铸造、重复卖、互相覆盖记录 → 只允许一份在跑 */ const lk = join(DIR, 'data', 'watch.lock'); const LOCK_STALE_MS = 180e3; /* 运作：锁档太久没更新＝之前那份已经不在了（电脑重开后 PID 可能被别的程式用掉） */ try { let old = 0, at = 0; if (existsSync(lk)) { const raw = readFileSync(lk, 'utf8'); try { const o = JSON.parse(raw); if (o && typeof o === 'object') { old = +o.pid || 0; at = +o.at || 0; } else old = Number(raw) || 0; } catch { old = Number(raw) || 0; } } if (old && old !== process.pid) { let alive = false; try { process.kill(old, 0); alive = !(at > 0) || Date.now() - at < LOCK_STALE_MS; /* RVFIX E5：旧格式（纯 pid）或 at 读不到＝只要 pid 活着就算另一份在跑 */ } catch {} /* PID 还在而且锁档最近有更新才算另一份在跑 */ if (alive) { console.log(`已经有一份在执行（PID ${old}），这份不重复启动`); process.exit(9); } /* 用 9 告诉启动脚本「已经有一份」→ 这个多出来的启动脚本直接结束，不会一直空转 */ } const lkW = () => { try { writeFileSync(lk + '.tmp', JSON.stringify({ pid: process.pid, at: Date.now() })); renameSync(lk + '.tmp', lk); } catch {} }; lkW(); setInterval(lkW, 30e3).unref(); process.on('exit', () => { try { if ((JSON.parse(readFileSync(lk, 'utf8'))?.pid) === process.pid) unlinkSync(lk); } catch {} }); } catch {} }
const ts = () => new Date().toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' });
function logTail() { try { const sz = statSync(LOG).size, n = Math.min(sz, LOG_TAIL); const b = Buffer.alloc(n); const fd = openSync(LOG, 'r'); try { readSync(fd, b, 0, n, sz - n); } finally { closeSync(fd); } return b.toString('utf8'); } catch { return ''; } } const LOG_TAIL = 5e6; /* 统计只读日志最后一段 */ let LOG_N = 0; const LOG_MAX = 20e6; /* 运作：日志档太大就换新的（旧的留一份 .1） */ const log = (s) => { try { if (++LOG_N % 500 === 0 && existsSync(LOG) && statSync(LOG).size > LOG_MAX) renameSync(LOG, LOG + '.1'); appendFileSync(LOG, `[${ts()}] ${s}\n`); } catch {} };
/* 一键更新时，正在跑的启动档（start_loop.bat／.sh、.vbs、.command）不能直接覆盖（cmd／bash 是边跑边读档，写一半会坏）→ 更新先存成「档名.new」，
   下次启动时再换上：.vbs／.sh／.command 在这里用换名（换名不影响正在跑的 bash）；Windows 的 start_loop.bat 正在跑引擎，由 start_loop.bat 自己开头换 */
const LAUNCH_RE = /^(start_loop\.(bat|sh)|[^\/]+\.(vbs|command))$/;
function swapLaunchers(dir = DIR, plat = process.platform) { const done = []; let L = []; try { L = readdirSync(dir); } catch { return done; } for (const n of L) { if (!n.endsWith('.new')) continue; const base = n.slice(0, -4); if (!LAUNCH_RE.test(base)) continue; if (base === 'start_loop.bat' && plat === 'win32') continue; try { let mode = null; try { mode = statSync(join(dir, base)).mode & 0o777; } catch { if (/\.(sh|command)$/.test(base)) mode = 0o755; } if (mode != null) { try { chmodSync(join(dir, n), mode); } catch {} } /* 保留原本的执行权限（Mac／Linux） */ renameSync(join(dir, n), join(dir, base)); done.push(base); } catch (e) { log('启动档换新失败 ' + base + '：' + e.message); } } if (done.length) log('一键更新：启动档换成新版 ' + done.join('、')); return done; }
globalThis.__swapLaunchers = swapLaunchers; /* 测试用 */ swapLaunchers();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIG = (() => { /* UIFIX4：缺 config.json → 用 config.example.json 产生（钱包清空，等你在雷达画面连钱包）；格式坏掉照旧报错（画面会显示原因） */ const f = join(DIR, 'config.json'); if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let ex = {}; try { ex = JSON.parse(readFileSync(join(DIR, 'config.example.json'), 'utf8')) || {}; } catch {} ex.wallets = []; try { writeFileSync(f, JSON.stringify(ex, null, 2)); console.error('UIFIX4：没有 config.json，已用 config.example.json 产生（还没有钱包：只读、不买，请在雷达画面连钱包）'); } catch {} return ex; })();
const USDT = '0x55d398326f99059ff775485246999027b3197955', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';
const NATIVE_BNB = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // 卖出一律换回 BNB
const ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e', FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; // 币安 Agent ID 登记合约：合约码里出现它 = 只限 Agent ID
const INFRA = new Set(['0x' + REGISTRY]); // Agent ID 登记合约本身不是铸造项目
const T_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const T_SWAP = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// 手动追踪的持仓（config.json 的 tokens）。cost = 每个钱包的成本（U）；both = 每个钱包都有这个成本；hold = 不自动卖只通知；sellNow = 立刻全部卖出
const TOKENS = (CONFIG.tokens || []).map((t) => ({ ...t, addr: t.addr.toLowerCase() }));
// 卖出规则（付费币到价就执行；免费币只通知），可在 config.json 的 rules 覆写
const ruleTxt = () => { const a = []; if (Number.isFinite(RULE.backX)) a.push(`${RULE.backX} 倍回本`); for (const [x, p] of RULE.steps || []) a.push(`${x} 倍卖 ${p}%`); if (Number.isFinite(RULE.crash)) a.push(`回本前从最高回落 ${Math.round(RULE.crash * 100)}% 全卖`); if (Number.isFinite(RULE.crashAfterBack)) a.push(`回本后回落 ${Math.round(RULE.crashAfterBack * 100)}% 卖出`); if (RULE.moonPct) a.push(`回本后留 ${RULE.moonPct}% 长抱`); return a.length ? a.join('、') : '你没开任何自动卖出规则（只通知）'; }; /* 只列你开著的规则 */
const NR_SELLNM = { sl: '止损', trail: '追踪止损', tp: '止盈', back: '回本', steps: '分批卖', crash: '回落全卖', timeStop: '时间止损', dump: '砸盘／抽池先跑' };
function nrPickSell(hit, key, o, label) { const NR_SELL_SAFE = ['sl', 'trail', 'crash', 'dump', 'timeStop', 'tp', 'steps', 'back']; /* RVFIX E2：没排顺序时的保底顺序＝卖得最多的优先（止损／追踪止损／回落／开发者跑路／时间止损＝全卖，排前面；分批类排后面） */ /* 只有一个触发就照它；同时触发多个照你排的顺序；你没排（或有没排到的）→ 卖出是保护不是花钱：照保底顺序卖「最保守」的那个，并发一次 TG 提醒去排顺序 */ if (hit.length <= 1) return hit[0] || ''; const ord = nrStr(key).split(/[,，\s]+/).filter(Boolean); if (hit.every((h) => ord.includes(h))) return hit.slice().sort((a, b) => ord.indexOf(a) - ord.indexOf(b))[0]; const idx = (h) => { const i = NR_SELL_SAFE.indexOf(h); return i < 0 ? NR_SELL_SAFE.length : i; }; const safe = hit.slice().sort((a, b) => idx(a) - idx(b))[0]; const sig = hit.join(); if (o.ordWarn !== sig) { o.ordWarn = sig; const m = `${label}：${hit.map((h) => NR_SELLNM[h] || h).join('、')} 同时触发，但你还没排「卖出同时触发时的顺序」→ 这次照最保守的卖：${NR_SELLNM[safe] || safe}。请到设定 → 卖出排好顺序`; log(m); tg('⚠️ 卖出顺序还没排，同时触发时先照最保守的卖：' + m).catch(() => {}); try { const f = join(DIR, 'data', 'sell_order_missing.json'); let A0 = []; try { A0 = JSON.parse(readFileSync(f, 'utf8')); } catch {} A0 = (Array.isArray(A0) ? A0 : []).filter((x) => x.label !== label); A0.push({ at: Date.now(), key, label, hit }); writeFileSync(f + '.tmp', JSON.stringify(A0.slice(-SELL_ORD_KEEP))); renameSync(f + '.tmp', f); } catch {} } return safe; } const SELL_ORD_KEEP = 100; /* 技术用：画面提示最多留几则 */
globalThis.NR_PICKSELL = nrPickSell;
const RULE = {
  // 付费币卖出规则＝你的设定（sell.*），没开就不卖
  backX: Infinity, steps: [], crash: Infinity, /* 卖出规则全部在你的设定里（sell.*），这里不留官方数字 */
  crashAfterBack: Infinity, moonPct: 0, /* 长抱通知倍数＝notify.moonX */
  fastMin: 30, /* 只是检查频率（刚开池时看得比较密），不影响卖不卖 */ 
  drop: Infinity, dropWaitMin: 0, // 免费币回落自动卖＝你的设定 sell.freeDrop
  /* 通知倍数＝notify.multX（没开＝不通知） */
};

let TG = null;
const TG_API = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}$/.test(String(process.env.RCR_TG_API || '')) ? process.env.RCR_TG_API : 'https://api.telegram.org'; /* TGE2E：Bot API 位置。只接受「本机」网址（端到端测试用的假 Telegram）；其他一律官方——环境变数不能把你的 bot token 导到别的伺服器 */
{ const a = CONFIG.telegram?.botToken || process.env.TG_BOT_TOKEN, b = CONFIG.telegram?.chatId || process.env.TG_CHAT_ID; if (a && b) TG = { a, b }; }
// 只有要买卖、要使用者决定的才响铃；其他（自动铸、收到币、登入成功…）静音送达
const isFreeMintNote = (t) => /^🆓/u.test(t) || (/^🆕/u.test(t) && ((__t2s) => __t2s.includes('🤖 已自动铸造') || __t2s.includes('🤖 已自動鑄造'))(t));
/* TG 通知照类别由你决定（tg.cat.*：空白＝不发、1＝静音发、2＝响铃发）。类别只看讯息开头的符号（事实分类），没有任何数字 */
const TG_CAT = (t) => { t = String(t); if (/^(🛒|💰)/u.test(t)) return 'trade'; if (/^🆓/u.test(t)) return 'free'; if (/^🚀/u.test(t)) return 'open'; if (/^🔥/u.test(t) && /\d+(\.\d+)? ?[倍x]/.test(t) && !/搶打|抢打|發現|发现/.test(t)) return 'mult'; if (/^(⚠️|⏰|🔑|🛑)/u.test(t)) return 'warn'; if (/^(🆕|🌐|🏗|🔥|💬|🦋|🔔|📣)/u.test(t)) return 'disc'; return 'other'; };
const tgMode = (t) => { const v = Number(radarSet()['tg.cat.' + TG_CAT(t)]); return v === 1 || v === 2 ? v : 0; };
/* 同一件事的通知：空白＝只通知一次（状态变了才再通知）；你填了 notify.repeatMin＝隔这么多分钟可以再通知一次 */
function nOnce(key, state = '1') { S.nOnce = S.nOnce || {}; const o = S.nOnce[key]; const rm = nrNum('notify.repeatMin'); if (o && o.s === String(state) && (rm == null || Date.now() - o.t < rm * 60e3)) return false; S.nOnce[key] = { s: String(state), t: Date.now() }; return true; }
function nClear(key) { if (S.nOnce && S.nOnce[key]) { delete S.nOnce[key]; } }
const atHour = (k) => { const h = nrNum(k); return h != null && new Date().getHours() === Math.round(h); }; /* 定时报告：你填的整点（本机时间）；空白＝不发 */



const GROUP_ID = CONFIG.telegram?.groupChatId || ''; // 可选：也发到 TG 群（买入、开池、倍数、卖出）
const groupSent = new Map();
async function toGroup(text) { /* 每一类都要你打开 grp.post.* */ 
  if (!TG || !GROUP_ID || !nrOn('grp.on')) return; /* 群播报总开关 grp.on 也要开 */
  let msg = '', key = '';
  const ca = (text.match(/0x[a-fA-F0-9]{40}/) || [])[0] || '';
  
  if (/^🛒/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(|]+)/) || [])[1]?.trim() || ''; const pct = (text.match(/進度約?\s*(\d+)%/) || [])[1]; msg = `🎯 打了付费项目：${name || '新项目'}${pct ? `（铸造进度约 ${pct}%）` : ''}\n合约：${ca}`; key = 'mint:' + ca.toLowerCase(); }
  /* 打到什么都在大群通知（免费也发），开盘也通知 */
  if (!msg && /^🆓/u.test(text)) { const name = (text.match(/項目[：:]\s*([^\n（(]+)/) || [])[1]?.trim() || ''; msg = `🎁 打了免费项目：${name || '新项目'}\n合约：${ca}`; key = 'free:' + ca.toLowerCase(); }
  if (!msg && /^🚀/u.test(text) && ((__t2s) => __t2s.includes('开池') || __t2s.includes('開池'))(text)) { const sym = (text.match(/^🚀\s*(\S+)/u) || [])[1] || ''; const tok = (text.match(/合約 (0x[a-fA-F0-9]{40})/) || [])[1] || ca; msg = `🚀 ${sym} 开盘了${(text.match(/開池了（([^）]+)）/) || [])[1] ? '（' + text.match(/開池了（([^）]+)）/)[1].replace('配對', '配对') + '）' : ''}\n合约：${tok}`; key = 'open:' + tok.toLowerCase(); }
  if (!msg && /^⚠️ 很[熱热][門门]但工具打不了/u.test(text)) { const m = text.match(/打不了：(.+?)（(\d+) 個錢包在打(?:，進度約 (\d+)%)?）/u); msg = `🔥 很热门但雷达打不了：${m?.[1] || '新项目'}${m ? `（${m[2]} 个钱包在打${m[3] ? `，进度约 ${m[3]}%` : ''}）` : ''}\n要的话请自己到官网手动打\n合约：${ca}`; key = 'hot:' + ca.toLowerCase(); }
  if (!msg || !ca) return; if (!nrOn('grp.post.' + key.split(':')[0])) return;
  { const cl = ca.toLowerCase(); S.grpOnce = S.grpOnce || {}; const gk = (key.startsWith('open:') || key.startsWith('hot:')) ? key : cl; if (S.grpOnce[gk]) return; S.grpOnce[gk] = 1; } /* 同一个合约群里只播一次（打到／进度播报择一，开盘另外播） */
  if (!nOnce('grp:' + key)) return;
  try { await fetch(`${TG_API}/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: safeOut('📡 Agent ID 播报\n' + msg, 1), disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function freeProgWatch() { // 免费项目也看铸造进度（已铸造／总量），过你设的进度播报到群
  S.freeTrack = S.freeTrack || {};
  for (const [c, F] of Object.entries(S.freeTrack)) { if (F.nextAt && Date.now() < F.nextAt) continue;
    if (!trackOk(F) || F.done) { delete S.freeTrack[c]; continue; } /* 追踪多久＝你的 track.maxAgeH */
    const tsR = await call(c, '0x18160ddd'); if (!tsR || tsR.length < 66) { F.done = 1; continue; } const sup = Number(BigInt(tsR.slice(0, 66)));
    let max = 0; for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { max = x; break; } } }
    if (!max) { F.miss = (F.miss || 0) + 1; F.nextAt = Date.now() + Math.min(F.miss, 6) * 10 * 60e3; continue; } 
    const pct = sup / max, prev = F.p; F.p = pct;
    { const gp = nrOn('grp.on') ? nrNum('grp.progPct') : null; /* 群播报进度＝你的设定（没开＝不播） */ if (gp != null && pct >= gp / 100 && (prev == null || prev < gp / 100)) { const nm = tokStr(await call(c, '0x06fdde03')) || ''; await groupProgress(c, nm, pct, gp); } }
    if (pct >= 1) F.done = 1;
    await sleep(100);
  }
}
async function groupProgress(c, name, pct, gp) { // 铸造进度第一次超过你设的 grp.progPct → 播报到群，同一个项目只发一次
  S.g70 = S.g70 || {}; if (gp == null || !nrOn('grp.on') || !TG || !GROUP_ID || S.g70[c]) return;
  if (nrOn('grp.skipDrain')) try { const d = S.deployer?.[c] || (await deployerOf(c)); if (d && (S.black?.[d] || S.paid?.[c]?.drain)) { S.g70[c] = 'skip'; log(`群播报略过 ${name || c}：黑名单／钱被转走（你开了 grp.skipDrain）`); return; } } catch {} /* 黑名单/抽走过资金的开发者，不推给群 */
  S.g70[c] = 'wait'; { const ws = nrNum('grp.waitSec'); if (ws != null && ws > 0) await sleep(ws * 1e3); } /* 先等几秒（跟「打了」那则合并）＝你的 grp.waitSec */
  if (S.grpOnce?.[c]) { S.g70[c] = 'merged'; return; }
  { 
    const sd = nrOn('grp.skipSerial') ? await serialDev(c).catch(() => '') : ''; if (sd) { S.g70[c] = 'skip-serial'; log(`群播报略过 ${name || c}：${sd}`); return; }
    const ao = nrOn('grp.needAgent') ? await agentOnly(c).catch(() => '') : 'x'; if (!ao) { S.g70[c] = 'skip-notagent'; log(`群播报略过 ${name || c}：不是 Agent ID 专属项目`); return; }
    const P = S.paid?.[c]; if (P && nrNum('grp.agMin') != null && !P.heatAt) await heatOf(c, P).catch(() => {});
    
    if (nrOn('grp.skipDrain') && await othersPay(c).catch(() => 0)) { const dr = await drainCheck(c, 1n).catch(() => ''); if (dr) { S.g70[c] = 'skip-drain'; log(`群播报略过 ${name || c}：${dr}`); return; } }
    const gam = nrNum('grp.agMin'); const ag = P?.agents || 0; if (gam != null && ag < gam) { S.g70[c] = 'skip-agents'; log(`群播报略过 ${name || c}：只有 ${ag} 个 Agent ID 钱包在打（你设要 ${gam} 个以上）`); return; } 
  }
  S.g70[c] = ts(); S.grpOnce = S.grpOnce || {}; S.grpOnce[c] = 1;
  const text = `📡 Agent ID 播报\n🔥 ${name || '新项目'} 铸造进度已超过 ${gp}%（目前 ${Math.round(pct * 100)}%）\n合约：${c}`;
  log('群播报: ' + text.replace(/\n/g, ' | '));
  try { await fetch(`${TG_API}/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: GROUP_ID, text: safeOut(text, 1), disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) }); } catch {}
}
async function riskNote(c) { /* 看合约有没有「增发／暂停／黑名单／改税」这类开发者权限，只提醒不挡 */
  try { const code = (await rpc('eth_getCode', [c, 'latest'])) || ''; if (code.length < 10) return '';
    const has = (sels) => sels.some((x) => code.includes('63' + x)); const f = [];
    if (has(['40c10f19'])) f.push('可增发');
    if (has(['8456cb59', '02329a29'])) f.push('可暂停交易');
    if (has(['f9f92be4', '44337ea1', '0ecb93c0', '1a895266'])) f.push('有黑名单');
    if (has(['8c0b5e22', 'c0246668', '5342acb4', 'aa4b6fca', '061c82d0'])) f.push('可改税/限额');
    if (!f.length) return ''; const ow = await call(c, '0x8da5cb5b'); if (ow && BigInt(ow.slice(0, 66)) === 0n) return '';
    return '\n⚠️ 合约权限提醒：' + f.join('、') + '（开发者还没放弃权限）';
  } catch { return ''; } }
async function honeypotCheck(W, t, st, bal) { /* 开池时模拟「把币转进池子」（卖出第一步），转不过去很可能是貔貅 */
  if (st.hpChecked || !st.pair || !/^0x[0-9a-f]{40}$/.test(st.pair) || !(bal > 0n)) return; st.hpChecked = 1;
  try { await rpc('eth_call', [{ from: W.addr, to: t.addr, data: '0xa9059cbb' + wa(st.pair) + w(bal / 100n || 1n) }, 'latest']); }
  catch (e) { await tg(`⚠️ [${W.name}] ${t.sym} 开池了，但模拟卖出失败，可能是貔貅（只能买不能卖），自动卖出可能会失败\n${t.addr}`); }
}
async function approvalPatrol() { /* 要不要自动取消无限授权＝你的 risk.autoRevoke，不取消的合约＝你自己填的 risk.revokeKeep */
  S.apSeen = S.apSeen || {}; const keep = new Set(nrStr('risk.revokeKeep').toLowerCase().split(/[\s,，;；]+/).filter((x) => /^0x[0-9a-f]{40}$/.test(x))); const all = [];
  for (const W of WALLETS) { const r = await W.baw(['approvals', 'list', '--limit', '100']); const L = r.j?.data?.list || []; if (!r.j?.success) continue;
    for (const x of L) { const sp = String(x.spender || '').toLowerCase(), tk = String(x.tokenContract || '').toLowerCase(), nm = String(x.spenderName || x.spenderLabel || ''), amt = String(x.amount ?? x.allowance ?? x.value ?? '');
      const lab = nm ? `（钱包标示：${nm}）` : '（钱包没有标示名称）'; /* 名称只是事实标签（币安钱包给的），不拿来判断要不要提醒 */
      const unlimited = /unlimit|infinite|max/i.test(amt) || amt.replace(/\D/g, '').length >= 30 || x.isUnlimited === true;
      const key = W.addr + sp + tk; all.push({ w: W.name, tok: x.tokenSymbol || tk, tokC: tk, sp, name: nm, amt, unlimited: unlimited ? 1 : 0, keep: keep.has(sp) ? 1 : 0, first: S.apSeen[key] || Date.now() });
      if (unlimited && NR.on('risk.autoRevoke') && !keep.has(sp)) { const rv = await W.baw(['approvals', 'revoke', '--binanceChainId', String(x.binanceChainId || x.chainId || 56), '--tokenContract', x.tokenContract, '--spender', x.spender, '--type', x.type || 'approve']); const ok = !!rv.j?.success; log(`[授权巡逻][${W.name}] 无限授权 ${x.tokenSymbol || tk} → ${sp}${lab}：${ok ? '已取消' : '取消失败'}（你开了「自动取消无限授权」）`); if (!S.apSeen[key]) { S.apSeen[key] = Date.now(); await tg(`⚠️ [${W.name}] 无限额度授权：${x.tokenSymbol || tk} → ${sp}${lab}\n${ok ? '✅ 已自动取消（你开了「自动取消无限授权」；不想取消的合约填在「不自动取消的合约」）' : '❌ 自动取消失败，请到 revoke.cash 手动取消'}`).catch(() => {}); } }
      else if (!S.apSeen[key]) { S.apSeen[key] = Date.now(); await tg(`🔎 [${W.name}] 钱包有一笔授权：${x.tokenSymbol || tk} → ${sp}${lab}，额度 ${amt || '?'}${unlimited ? '（无限）' : ''}\n如果不是你做的，请到 revoke.cash 取消`).catch(() => {}); }
    } }
  try { writeFileSync(join(DIR, 'data', 'approvals.json'), JSON.stringify({ at: Date.now(), list: all })); } catch {}
  save();
}
async function flapApprovalWatch() { if (!FLAP_BAN) return; /* 定期查钱包授权：有授权给 Flap 就立刻取消并通知（换币路由可能自己产生授权） */
  for (const W of WALLETS) { const r = await W.baw(['approvals', 'list', '--limit', '100']); const L = r.j?.data?.list || [];
    for (const x of L) { const sp = String(x.spender || '').toLowerCase(); if (!FLAP_BLOCK.has(sp) && !/flap/i.test(String(x.spenderName || ''))) continue;
      const rv = await W.baw(['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', x.tokenContract, '--spender', x.spender, '--type', x.type || 'approve']);
      await tg(`⚠️ [${W.name}] 发现授权给 Flap（${x.tokenSymbol || x.tokenContract}），${rv.j?.success ? '已自动取消' : '自动取消失败，请手动取消：' + (rv.j?.error?.message || rv.t).slice(0, 80)}`); } }
}
async function lowBnbWatch() { /* BNB 快不够付 gas 时提醒＝你的 notify.lowBnb（同一个钱包低于门槛只提醒一次，补回去再低才会再提醒） */
  for (const W of WALLETS) { const b = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18; const lim = nrNum('notify.lowBnb');
    if (lim == null || !(b < lim)) { nClear('lowBnb:' + W.name); continue; } if (nOnce('lowBnb:' + W.name)) { await tg(`⚠️ [${W.name}] BNB 快不够了：剩 ${b.toFixed(4)} BNB，可能付不出 gas，免费项目也会打不了，请补一点 BNB`); } }
}
function pruneState() { /* 状态档定期瘦身，避免越来越大、越存越慢 */
  const cut = (o, max) => { const k = Object.keys(o || {}); if (k.length > max) for (const x of k.slice(0, k.length - max)) delete o[x]; };
  cut(S.seenMints, 10000); cut(S.g70, 3000); cut(S.grpOnce, 5000); cut(S.missed, 500); cut(S.deployer, 8000); cut(S.depFrom, 8000); cut(S.devs, 1500); cut(S.lrnBack, 500); cut(S.bornBlk, 10000); /* 技术用：存档大小 */
  /* 超过你设的追踪时间、没打过的项目记录清掉（没设＝不清） */ for (const [c, P] of Object.entries(S.paid || {})) if (!trackOk(P) && !Object.keys(P.done || {}).length) delete S.paid[c];
  for (const [k, st] of Object.entries(S.tokens || {})) if (st.holders && (st.done || st.stage === 9 || Object.keys(st.holders).length > 3000)) { if (st.done || st.stage === 9) delete st.holders; else cut(st.holders, 3000); }
  if (S.bscNft?.m) for (const M of Object.values(S.bscNft.m)) if (M.m) cut(M.m, MINTER_MEM0);
  if (S.rh?.mint) for (const M of Object.values(S.rh.mint)) if (M.m) cut(M.m, MINTER_MEM0);
  if (S.trades?.length > 1000) S.trades = S.trades.slice(-1000);
  for (const st of Object.values(S.tokens || {})) if (st.holders) cut(st.holders, 20000);
  /* H4-H5 技术用 记忆体上限：没开「追踪时间」时也不会无限长大（最久没动静、没打过、没持仓的先移除） */
  const held = new Set([...(S.dyn || []).filter((t) => !t.closed).map((t) => String(t.addr).toLowerCase()), ...Object.keys(S.rh?.pos || {})]);
  const keepTop = (o, max, at, keep) => { if (!o) return; const k = Object.keys(o); if (k.length <= max) return; const rm = k.filter((c) => !keep(c, o[c])).sort((a, b) => (at(o[a]) || 0) - (at(o[b]) || 0)); for (const c of rm.slice(0, k.length - max)) delete o[c]; };
  const doneAny = (M) => M && M.done && Object.keys(M.done).length > 0;
  keepTop(S.bscNft?.m, PRUNE.mint, (M) => M.last || M.at, (c, M) => !!S.paid?.[c] || held.has(c) || doneAny(M));
  keepTop(S.rh?.mint, PRUNE.mint, (M) => M.last || M.at, (c, M) => held.has(c) || doneAny(M));
  keepTop(S.paid, PRUNE.paid, (P) => P.at, (c, P) => doneAny(P) || FORCE.has(c) || held.has(c));
  { const k = Object.keys(S.agTokChk || {}); if (k.length > PRUNE.agTok) { for (const c of k.slice(0, k.length - PRUNE.agTok)) { if (held.has(c)) continue; delete S.agTokChk[c]; if (S.agTok?.[c] !== 'buy') delete S.agTok?.[c]; delete S.agTokFirst?.[c]; delete S.agTokWhy?.[c]; } } cut(S.agTok, PRUNE.agTok); cut(S.agTokFirst, PRUNE.agTok); cut(S.agTokWhy, PRUNE.agTok); }
  cut(S.isNft, PRUNE.big); cut(S.apSeen, PRUNE.mid); cut(S.freeTrack, PRUNE.mid); cut(S.callSeen, PRUNE.mid); cut(S.callHits, PRUNE.small); cut(S.urlHits, PRUNE.small); cut(S.urlNoted, PRUNE.small); cut(S.inscNoted, PRUNE.small); if (S.flapAgent?.names) cut(S.flapAgent.names, PRUNE.mid);
}
const MINTER_MEM0 = 3000; /* 技术用：每个项目记住的铸造者数，跟 bscnft.mjs／rh.mjs 的 MINTER_MEM 一致 */ const PRUNE = { mint: 3000, paid: 5000, agTok: 20000, big: 20000, mid: 5000, small: 3000 }; /* 技术用：存档里各种记录最多留几个（记忆体／存档大小），不影响买卖判断 */
async function dailyReport() { /* 每日总结：几点发＝你的 report.dailyHour（空白＝不发） */
  const day = new Date().toDateString(); if (!atHour('report.dailyHour') || S.dailyAt === day) return; S.dailyAt = day; save(); /* 几点发＝你的 report.dailyHour（空白＝不发） */
  let um = 0; try { const today = ts().split(/\s/)[0]; um = new Set(logTail().split('\n').filter((l) => l.startsWith('[' + today) && l.includes('] 打不了 ')).map((l) => (l.match(/0x[a-f0-9]{40}/) || [''])[0])).size; } catch {}
  const today2 = ts().split(/\s/)[0]; const ms = Object.entries(S.missed || {}).filter(([, m]) => String(m.at).startsWith(today2)).slice(-8);
  const missTxt = ms.length ? `\n今天快卖完却没打到的 ${ms.length} 个：\n` + ms.map(([c, m]) => `· ${m.name}：${m.why}`).join('\n') : '\n今天没有错过快卖完的项目';
  const esTxt = ESTOP() ? `\n\n⚠️ 雷达还在紧急全停（已 ${Math.max(1, Math.round((Date.now() - (radarSet().estop?.at || Date.now())) / 86400e3))} 天）：不会买，持仓照止盈止损卖。要重新开始请在电脑雷达按「重新设定」` : '';
  await tgSay(`🌙 每日总结${esTxt}${missTxt}\n今天有 ${um} 个项目打不了（要官网签名、白名单或模拟失败），只记在记录里${UPD.on && nrOn('report.showGroup') ? `\n\n官方群：${UPD.group}` : ''}`); await cmdStats().catch(() => {});
}
async function lockNote(c, wAddr) { /* 买到的币现在能不能转：模拟转 1 单位到黑洞地址，被挡就提醒（像 aiagentbsc 的白名单锁） */
  const toks = [...new Set([c, ...(S.dyn || []).filter((t) => t.only === wAddr).slice(-3).map((t) => t.addr)])];
  for (const t of toks) { const dR = await call(t, '0x313ce567'); if (!(dR && dR.length >= 66)) continue; /* NFT 没有小数位数，不能用转代币的方式测 */ const b = big(await call(t, '0x70a08231' + wa(wAddr))); if (!(b > 0n)) continue;
    try { await rpc('eth_call', [{ from: wAddr, to: t, data: '0xa9059cbb' + wa('0x000000000000000000000000000000000000dead') + w(1n) }, 'latest']); return ''; }
    catch (e) { return `\n⚠️ 这个币现在转不出去（${String(e.message).slice(0, 40)}）：可能要等开发者开放交易，也可能是貔貅`; } }
  return '';
}

/* 防「GRAM 备注假公告」这类手法——币名、NFT 资料、群里的网址都是任何人都能写的，
   发 TG 前统一过滤：不在白名单的网址一律拿掉；发大群时连裸网域也拿掉；冒充官方要人转钱的字眼整句拿掉 */
const SAFE_HOSTS = /(^|\.)(binance\.com|binance\.info|bscscan\.com|github\.com|t\.me|nightshift\.fans|dexscreener\.com|geckoterminal\.com|element\.market|robinhood\.com|blockscout\.com)$/i;
function safeOut(text, group) {
  let t = String(text || '').replace(/https?:\/\/([^\s/?#)）]+)[^\s)）]*/gi, (u, h) => (SAFE_HOSTS.test(h) ? u : '[连结已移除]'));
  if (group) t = t.replace(/\b(?![\w-]*\.ai\b)[\w-]+(?:\.[\w-]+)*\.(?:xyz|com|io|org|net|app|online|fun|site|top|cc|me|link|vip|pro|club|live|info|finance|money|gg)\b(?!\/nancy)/gi, (d) => (SAFE_HOSTS.test(d) ? d : '[网址已移除]'));
  t = t.split('\n').map((l) => (/(保险箱|保[險险]箱|安全账户|安全[帳帐][戶户]|遭遇黑客|遭到攻[擊击]|被黑客|[請请][將将][資资]金|请将资金|转入以下|[轉转]入以下|官方公告.*(转|[轉转]))/.test(l) ? '[可疑内容已移除]' : l)).join('\n');
  return t.slice(0, 4000);
}
const T2S_A="丟並佇佔來倉個們偵備傳價優兌內兩冊別刪則剛創動勵區卻參問啟單嚴國圍圖執報場塊塵壞夠夾學實審寫寬寶將專尋對導層屬帳帶幣幫幾庫廠廢張強彈後從復態慮戰戲戶掃掛換搶擇擊擋據擠擬敗數斷於時暫會東條棄標樣機檔檢檻權歡歸殺決沒淨減測湊準滿漲濾瀏為無熱燒爭爾狀獎獨現產當發監盤確碼礎稅種稱穩筆節範簡簽紀約級細組結絕給統經維網線編緩縮總績繞繼續罵聰聲聽腦與舊萬蓋處號補裝裡複見規視覽觀訂計訊討記設許註詞詢試話誌認語誤說調請論證議護讀變讓負貨貴買費貼資賣賺購贔蹤較載輔輕輪輯輸轉迴這連進遊運過達遠選還邊邏釣鈴銘錄錢錯鍵鎖鏈鐘鑄鑰長門閉開間關隊階際隨險難電靜響頁項順須預領頭頻顆題額類顯風餘馬騙驗驟魚麼點齊龍",T2S_B="丢并伫占来仓个们侦备传价优兑内两册别删则刚创动励区却参问启单严国围图执报场块尘坏够夹学实审写宽宝将专寻对导层属帐带币帮几库厂废张强弹后从复态虑战戏户扫挂换抢择击挡据挤拟败数断于时暂会东条弃标样机档检槛权欢归杀决没净减测凑准满涨滤浏为无热烧争尔状奖独现产当发监盘确码础税种称稳笔节范简签纪约级细组结绝给统经维网线编缓缩总绩绕继续骂聪声听脑与旧万盖处号补装里复见规视览观订计讯讨记设许注词询试话志认语误说调请论证议护读变让负货贵买费贴资卖赚购赑踪较载辅轻轮辑输转回这连进游运过达远选还边逻钓铃铭录钱错键锁链钟铸钥长门闭开间关队阶际随险难电静响页项顺须预领头频颗题额类显风余马骗验骤鱼么点齐龙";const T2S=new Map([...T2S_A].map((c,i)=>[c,[...T2S_B][i]]));const toS = (x) => String(x).replace(/[\u4e00-\u9fff]/g, (c) => T2S.get(c) || c); /* 发给用户的讯息统一简体 */
const PLUG_LAST = new Map(); async function tg(text) { text = toS(text); { const pm = /^\[插件 ([^\]]{1,60})\]/.exec(String(text)); if (pm) { if (PLUG_LAST.get(pm[1]) === text) return; PLUG_LAST.set(pm[1], text); } } /* 同一个外挂连续发一样的通知只发一次 */ ordResNote(text);  /* 发现新合约这类通知预设不发，只发有动作的（买到、卖出、错误、钱包登出）；设定可以打开 */ if (ESTOP() && /^(🆕|🌐|🏗|🔥|📣|⏰|🔔)/u.test(String(text))) { text = String(text) + '\n🛑 全停中，不会买'; } /* 全停只停买，发现的项目照样通知 */ /* 全停期间只发卖出结果和错误，发现新项目这类通知不发 */ if (/^🛒/u.test(text)) { const m = text.match(/\n(0x[a-fA-F0-9]{40})\n/); if (m) { text += await riskNote(m[1].toLowerCase()); const wn = (text.match(/^🛒 \[([^\]]+)\]/u) || [])[1]; const W = WALLETS.find((x) => x.name === wn); if (W) text += await lockNote(m[1].toLowerCase(), W.addr).catch(() => ''); } } log('TG: ' + text.replace(/\n/g, ' | ')); toGroup(text).catch(() => {}); const md = tgMode(text); if (!TG || !md) return; /* 你没打开这一类＝只写日志 */ try { await fetch(`${TG_API}/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text: safeOut(text, 0), disable_web_page_preview: true, disable_notification: md !== 2 }), signal: AbortSignal.timeout(10000) }); } catch {} }

const RPCS_USER = (() => { try { const z = JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8'))['rpc.list']; return Array.isArray(z) ? z.filter((u) => /^https:\/\/[^\s@/]+(\/[^\s]*)?$/.test(String(u))).slice(0, 5) : []; } catch { return []; } })(); /* 用户在雷达「设定」贴的节点排第一，内建的当备用 */
const RPCS0 = Array.isArray(CONFIG.rpcs) && CONFIG.rpcs.length ? CONFIG.rpcs : ['https://bsc-rpc.publicnode.com', 'https://bsc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.binance.org', 'https://bsc-dataseed2.binance.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc.blockrazor.xyz', 'https://bsc.meowrpc.com', 'https://bsc-mainnet.public.blastapi.io', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com'] /* 内建节点清单（只有 publicnode 支援查事件记录，其他的只拿来读合约） */; // 可在 config.json 的 rpcs 换成自己的节点（公共节点常被限流）
const RPCS = [...new Set(RPCS0)]; /* RVFIX E7：你贴的节点要先问过是哪条链，确认不是别条链才排进来用（检查完之前先用内建的） */
/* 你在设定贴的节点先问它是哪条链（eth_chainId），不是 BSC（0x38）就不用它并告诉你；问不到的照用（可能只是暂时连不上） */ if (RPCS_USER.length) (async () => { const bad = []; for (const u of RPCS_USER) { try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000) })).json(); if (r && typeof r.result === 'string' && r.result.toLowerCase() !== '0x38') bad.push([u, r.result]); } catch {} } const rhU = bad.filter(([, c]) => parseInt(c, 16) === 4663).map(([u]) => u); if (rhU.length) { globalThis.RH_USER_RPCS = rhU; for (const u of rhU) globalThis.RH_ADD_RPC?.(u); } /* 是 Robinhood 链（4663）的节点 → 改给 Robinhood 用 */ { const good = RPCS_USER.filter((u) => !bad.some(([b]) => b === u)); for (const u of good) { const i = RPCS.indexOf(u); if (i >= 0) RPCS.splice(i, 1); } RPCS.unshift(...good); RPC_BAD.clear(); } /* 确认过的用户节点排第一 */ if (!bad.length) return; const msg = '⚠️ 你在「设定 → 节点」填的这些节点不是 BSC 链，雷达没有用它们：\n' + bad.map(([u, c]) => `· ${u.replace(/^(https:\/\/[^/]+).*/, '$1')}（链编号 ${parseInt(c, 16) || c}${parseInt(c, 16) === 4663 ? '：是 Robinhood 链，已改用在 Robinhood' : ''}）`).join('\n'); try { writeFileSync(join(DIR, 'data', 'rpc_bad_user.json'), JSON.stringify({ at: Date.now(), bad: bad.map(([u, c]) => ({ u, chainId: c })) })); } catch {} setTimeout(() => { try { log(msg); tg(msg).catch(() => {}); } catch {} }, 5e3); })();
let ri = 0;
/* PERF2-1104 节点竞速：开机（和之后每 RPC_RACE_MS）同时问所有内建节点 eth_chainId，最快回的 BSC 节点排第一个先用。
   玩家自己在「设定 → 节点」填的节点永远排最前面、不参加比赛。这只是决定「先问哪一个」，每次查询还是只打一个节点（rpc() 本身不动） */
const RPC_RACE_MS = 10 * 60e3, RPC_RACE_TO = 4000; /* 技术用：多久重新比一次／比赛时每个节点最多等多久 */
async function rpcRace() { try { if (RPCS_USER.length) return; const t0 = Date.now(); const R = await Promise.all(RPCS.map(async (u, i) => { try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(RPC_RACE_TO) })).json(); return r && String(r.result).toLowerCase() === '0x38' ? [Date.now() - t0, i] : null; } catch { return null; } })); const best = R.filter(Boolean).sort((a, b) => a[0] - b[0])[0]; if (best) ri = best[1]; } catch {} }
setTimeout(() => rpcRace(), 0).unref?.(); setInterval(() => rpcRace(), RPC_RACE_MS).unref?.();

const RPC_BAD = new Map(), LOG_BAD = new Map(); /* 很多免费节点不给查事件记录（eth_getLogs 回 limit exceeded／not supported） */ const isRevert = (m) => /revert|invalid opcode|out of gas|execution|VM Exception|invalid jump|stack/i.test(String(m || ''));
async function rpc(method, params) {
  let last; const now = Date.now(); const order = []; for (let i = 0; i < RPCS.length; i++) { const u = RPCS[(ri + i) % RPCS.length]; if ((RPC_BAD.get(u) || 0) <= now && !(method === 'eth_getLogs' && (LOG_BAD.get(u) || 0) > now)) order.push([u, (ri + i) % RPCS.length]); }
  if (!order.length) for (let i = 0; i < RPCS.length; i++) order.push([RPCS[(ri + i) % RPCS.length], (ri + i) % RPCS.length]);
  for (const [u, idx] of order) { try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) })).json();
      if (r.error) { if (isRevert(r.error.message)) { ri = idx; throw Object.assign(new Error(r.error.message), { revert: true, data: typeof r.error.data === 'string' ? r.error.data : r.error.data?.data || r.error.data?.result || '' }); } /* 带上合约回的错误资料（自订错误要用） */ throw new Error(r.error.message); } ri = idx; globalThis._rpcDown = 0; return r.result; }
    catch (e) { if (e.revert) throw e; last = e; if (method === 'eth_getLogs') LOG_BAD.set(u, Date.now() + 600e3); else RPC_BAD.set(u, Date.now() + 60e3); } } /* 查事件失败只冷冻这个节点的「查事件」，一般读取照用 */
  if (!globalThis._rpcDown) globalThis._rpcDown = Date.now(); if (Date.now() - globalThis._rpcDown > 120e3 && Date.now() - (globalThis._rpcDownTg || 0) > 3600e3) { globalThis._rpcDownTg = Date.now(); log('节点连不上，请到设定填一个'); try { writeFileSync(join(DIR, 'data', 'rpc_down.json'), JSON.stringify({ at: Date.now() })); } catch {} tg('⚠️ 节点连不上，请到雷达「设定 → 节点」填一个你自己的节点').catch(() => {}); } 
  throw last;
}
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const wa = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const call = (to, data) => rpc('eth_call', [{ to, data }, 'latest']).catch(() => null);
const big = (h) => (h && h !== '0x' ? BigInt(h.slice(0, 66)) : 0n);
async function usdtFree(W) { const b = big(await call(USDT, '0x70a08231' + wa(W.addr))); if (W !== WALLETS[0]) return b; const r = BigInt(Math.floor((globalThis.PLUG_RESERVE_FN?.() || 0) * 1e6)) * 10n ** 12n; return b > r ? b - r : 0n; } /* 扣掉外挂今天还要用的 USDT，雷达铸造不会吃掉外挂的本金（不够就照旧把 BNB 换成 USDT） */
const parseOut = (res) => (e, so, se) => { const t = String(so || se || e?.message || ''); if (e && (e.killed || e.signal || e.code === 'ETIMEDOUT' || e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(String(e.message || '')))) return res({ t: 'TIMEOUT(killed) ' + t, j: null, timeout: 1 }); let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} res({ t, j, ok0: !e }); };
// 每个钱包一个 baw（币安 Agentic Wallet CLI）。第二个以后的钱包用独立的 BINANCE_BAW_DIR / BINANCE_INSTANCE_ID（见 README）
/* 送给 baw 的参数一律先检查格式（地址＝0x＋40 码、数量＝数字、calldata＝0x 十六进位），不对就不执行；能直接用 node 跑 baw 就不经过 shell */
const BAW_ADDR_F = new Set(['--tokenContract', '--spender', '--to', '--from', '--fromToken', '--toToken', '--address', '--owner', '--contract']), BAW_NUM_F = new Set(['--fromTokenQty', '--value', '--binanceChainId', '--chainId', '--limit']);
function bawArgsBad(args, sh) { for (let i = 0; i < args.length; i++) { const a = String(args[i]); const f = String(args[i - 1] || ''); if (f === '--message') { if (sh ? !/^"(?:[^"`$\\]|\\[nrt"\\/])*"$|^[A-Za-z0-9_.:\/@=,+\-]*$/.test(a) : a.length > 4000) return '--message 格式不对'; continue; } /* 登入签名的讯息：经过 shell 时不能有会被 shell 解读的字元 */ if (!/^[A-Za-z0-9_.:\/@=,+\-]*$/.test(a)) return `参数格式不对：${a.slice(0, 40)}`; if (BAW_ADDR_F.has(f) && !/^0x[0-9a-fA-F]{40}$/.test(a)) return `${f} 不是合约地址：${a.slice(0, 50)}`; if (BAW_NUM_F.has(f) && !/^\d+(\.\d+)?(e[-+]?\d+)?$/i.test(a)) return `${f} 不是数字：${a.slice(0, 30)}`; if (f === '--inputData' && !/^0x([0-9a-fA-F]{2})*$/.test(a)) return '--inputData 不是十六进位'; if (f === '--slippage' && !/^(auto|\d+(\.\d+)?)$/.test(a)) return '--slippage 格式不对'; } return ''; }
const BAW_SEND = /^(market-order swap|contract-call execute|approvals revoke|sign-message execute)$/;
/*BINDSH108*/const bawShNow = (fn) => !!fn?.sh || (!!fn?.maybeSh && !existsSync(BAW_BIN)); /* 这次呼叫会不会经过 shell（bawGuard 检查和 bindSign 包引号用同一个判断） */
const bawGuard = (fn) => Object.assign((args, timeout) => { const bad = bawArgsBad(args || [], bawShNow(fn)); if (bad) { log('⛔ baw 参数检查没过，没执行：' + bad); return Promise.resolve({ t: '参数检查没过：' + bad, j: { success: false, error: { message: '参数检查没过：' + bad } } }); } return fn(args, timeout).then((r) => { if (r && !r.j && !r.timeout && r.ok0 && BAW_SEND.test(String((args || [])[0]) + ' ' + String((args || [])[1]))) return { ...r, t: 'TIMEOUT(结果不明：送出后读不懂回应) ' + r.t, timeout: 1 }; return r; }); /* 会花钱的指令正常结束却读不懂回应＝结果不明 */ }, fn.sh ? { sh: 1 } : fn.maybeSh ? { maybeSh: 1 } : {}); /*BINDSH108 把 maybeSh 带出去*/
function makeBaw(wc) { return bawGuard(makeBaw0(wc)); }
let _bawG; function bawGlobalEntry() { if (_bawG !== undefined) return _bawG; _bawG = ''; const rel = join('@binance', 'agentic-wallet', 'dist', 'index.js'); const roots = []; try { roots.push(String(execFileSync('npm', ['root', '-g'], { shell: true, windowsHide: true, timeout: 15000, encoding: 'utf8' })).trim()); } catch {} const nd = dirname(process.execPath); roots.push(join(nd, 'node_modules'), join(nd, '..', 'lib', 'node_modules')); if (process.env.APPDATA) roots.push(join(process.env.APPDATA, 'npm', 'node_modules')); for (const r of roots) { if (!r) continue; const f = join(r, rel); if (existsSync(f)) { _bawG = f; break; } } return _bawG; } /* 找全域安装的 baw 主程式（npm root -g 是固定指令、没有使用者输入）；找不到才用 shell 的 baw */
function makeBaw0(wc) {
  if (!wc.bawDir) { const g = bawGlobalEntry(); if (g) return (args, timeout = 180000) => new Promise((res) => execFile(process.execPath, [g, ...args, '--json'], { windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))); return Object.assign((args, timeout = 180000) => new Promise((res) => execFile('baw', [...args, '--json'], { shell: true, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))), { sh: 1 }); }
  const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, wc.bawDir), BINANCE_INSTANCE_ID: wc.instanceId || wc.name };
  const bin = join(DIR, wc.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
  return (args, timeout = 180000) => new Promise((res) => execFile(process.execPath, [bin, ...args, '--json'], { env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res)));
}

const WCFG = (() => { try { return JSON.parse(readFileSync(join(DIR, 'data', 'radar_wallets_cfg.json'), 'utf8')); } catch { return { add: [], hidden: [] }; } })();
const BAW_BIN = join(DIR, 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js');
const bawFor = (w) => { const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, 'data', w.bawDir), BINANCE_INSTANCE_ID: w.instanceId }; return bawGuard(Object.assign((args, timeout = 180000) => existsSync(BAW_BIN) ? new Promise((res) => execFile(process.execPath, [BAW_BIN, ...args, '--json'], { env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))) : new Promise((res) => execFile('baw', [...args, '--json'], { shell: true, env, windowsHide: true, timeout, maxBuffer: 4 << 20 }, parseOut(res))), { maybeSh: 1 })); }; 
/* 原因：baw 把登入资料存在系统钥匙圈（Windows 凭证管理员／Mac 钥匙圈）的同一个位置，
   每个钱包的登入资料夹分开也没用，后登入的会盖掉前一个。Windows 用 setup_wallet2.bat 装的独立 baw 有停用钥匙圈，但 Mac 跟「雷达里新增钱包」都没有。
   → 第二个以后的钱包一律用独立的 baw（data 外的 baw2pkg），并停用它的钥匙圈，登入资料只存在各自的资料夹 */
async function ensureBaw2() {
  try {
    const pk = join(DIR, 'baw2pkg');
    const kill = () => { for (const q of [join(pk, 'node_modules', '@binance', 'agentic-wallet', 'node_modules', '@github'), join(pk, 'node_modules', '@github')]) if (existsSync(q)) { renameSync(q, join(pk, 'keytar_disabled_' + Date.now())); log('第二个以后的钱包：已停用系统钥匙圈，钱包之间不会再互相挤掉登入'); } };
    if (existsSync(BAW_BIN)) { kill(); return; }
    if (!(WCFG.add || []).length) return;
    mkdirSync(pk, { recursive: true }); log('有第二个钱包：正在安装独立的 baw（约 1～2 分钟，只要一次）…');
    const env = { ...process.env, PATH: [process.env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin'].join(process.platform === 'win32' ? ';' : ':') };
    await new Promise((res) => execFile(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '@binance/agentic-wallet@1.12.0', '--prefix', pk, '--no-audit', '--no-fund'], { shell: process.platform === 'win32', env, windowsHide: true, timeout: 300000 }, (e) => { if (e) log('独立 baw 安装失败：' + String(e.message).slice(0, 120)); res(); }));
    kill(); if (existsSync(BAW_BIN)) log('独立 baw 装好了：第二个以后的钱包请在雷达「设定 → 钱包」重新扫码登入一次');
  } catch (e) { log('独立 baw 准备失败 ' + e.message); }
}
ensureBaw2();
const wHidden = new Set((WCFG.hidden || []).map((a) => String(a).toLowerCase()));
const walFromCfg = (wc) => ({ name: wc.name, addr: wc.address.toLowerCase(), baw: makeBaw(wc) }); /* UIFIX4：config.json 的钱包（开机和「新增钱包」共用这一份；之后新增的经 WALLETS.push 自动包上闸门） */
const walFromAdd = (w) => ({ name: String(w.name).slice(0, 30), addr: w.address.toLowerCase(), baw: bawFor(w), added: 1 }); /* UIFIX4：雷达画面新增的钱包（开机和即时新增共用） */
const WALLETS = (Array.isArray(CONFIG.wallets) ? CONFIG.wallets : []).filter((wc) => /^0x[0-9a-fA-F]{40}$/.test(String(wc?.address || ''))).map(walFromCfg); /* UIFIX4：只收真的地址（范本的 0xYourAgentWallet 不算） */
for (const w of WCFG.add || []) { if (/^0x[0-9a-fA-F]{40}$/.test(w.address) && !WALLETS.some((x) => x.addr === w.address.toLowerCase())) WALLETS.push(walFromAdd(w)); }
{ const keep = WALLETS.filter((w) => !wHidden.has(w.addr)); WALLETS.splice(0, WALLETS.length, ...keep); } /*RISK-FIX 11：钱包全部被隐藏＝视为没有钱包（只读、不买、不下单），不再把隐藏的钱包全部拿回来用 */
if (!WALLETS.length) console.error('UIFIX4：还没有钱包 → 引擎照常跑（只读：看盘、通知照常），不买、不铸造、不下单；在雷达「设定 → 钱包」连好钱包后自动重新载入'); /* UIFIX4：没有钱包不退出 */
const NO_WALLET = () => !WALLETS.length; /* UIFIX4：没有钱包＝一律不买 */
let ME = WALLETS[0]?.addr || ''; /* UIFIX4：新增／删除钱包会即时更新 */
function keccak256(str) { /* 小型 keccak256（BigInt 版），算 Agent ID 编号用 */
  const M = (1n << 64n) - 1n, RC = [], R = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44], P = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];
  let r = 1n; for (let i = 0; i < 24; i++) { let c = 0n; for (let j = 0; j < 7; j++) { r = ((r << 1n) ^ ((r >> 7n) * 0x71n)) & 0xffn; if (r & 2n) c ^= 1n << ((1n << BigInt(j)) - 1n); } RC.push(c); }
  const rot = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M;
  const b = [...Buffer.from(str, 'utf8')]; b.push(1); while (b.length % 136) b.push(0); b[b.length - 1] |= 0x80;
  const s = Array(25).fill(0n);
  for (let o = 0; o < b.length; o += 136) {
    for (let i = 0; i < 17; i++) { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[o + i * 8 + k]); s[i] ^= v; }
    for (let rd = 0; rd < 24; rd++) {
      const C = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const d = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
      let t = s[1]; for (let i = 0; i < 24; i++) { const j = P[i], u = s[j]; s[j] = rot(t, R[i]); t = u; }
      for (let y = 0; y < 25; y += 5) { const a = s.slice(y, y + 5); for (let x = 0; x < 5; x++) s[y + x] = a[x] ^ (~a[(x + 1) % 5] & M & a[(x + 2) % 5]); }
      s[0] ^= RC[rd];
    }
  }
  let h = ''; for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) h += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, '0'); return h;
}

/* 每个钱包自己的 Agent ID 编号 = keccak256(名称去掉 .ai)；有些项目铸造时要带这个编号（像 SYNAPE 的 mint(agentTokenId)） */
for (const W of WALLETS) W.agentId = keccak256(W.name.toLowerCase().replace(/\.ai$/, ''));

let S = { tokens: {}, lastBlock: 0, seenMints: {}, lastLoginAlert: 0 };
try { S = { ...S, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
for (const k of Object.keys(S.tokens)) delete S.tokens[k].verified;
function dynOwn() { /*RISK-FIX2-3：旧版持仓（没有 only／both）的成本原本挂在「现在的第一个钱包」，删掉第一个钱包会搬家 → 补上 only＝旧版第一个钱包 S.stMe0（没有就用当时的第一个钱包）；有 only／both 的不动 */
  if (!S.stMe0 && WALLETS[0]) S.stMe0 = WALLETS[0].addr; const o = String(S.stMe0 || '').toLowerCase(); if (!o) return; let n = 0; for (const x of S.dyn || []) if (x && !x.only && !x.both) { x.only = o; n++; } if (n) { log(`旧持仓 ${n} 笔补上所属钱包（成本跟着当时的第一个钱包）`); save(); } }
if (!S.stMe0 && WALLETS[0]) S.stMe0 = WALLETS[0].addr; /*RISK-FIX 4：旧版持仓记录「没有前缀的键」属于开机时的第一个钱包；记下来，之后删掉／换掉第一个钱包也找得到正确的旧记录 */
let _saveLast = ''; const saveNow = () => { try { const j = JSON.stringify(S); if (j !== _saveLast) { writeFileSync(STATE + '.tmp', j); renameSync(STATE + '.tmp', STATE); _saveLast = j; } } catch {} _saveAt = Date.now(); _saveDirty = false; }; /* 内容没变就不写档 */
let _saveAt = 0, _saveDirty = false, _saveT = null;

const save = () => { _saveDirty = true; if (_saveT) return; const wait = Math.max(0, 3000 - (Date.now() - _saveAt)); _saveT = setTimeout(() => { _saveT = null; if (_saveDirty) saveNow(); }, wait); };
process.on('exit', () => { if (_saveDirty) saveNow(); });
function hidAllChk(boot) { /*V101-4：钱包全部删除（隐藏）＝没有钱包 → 这些钱包的持仓不会再自动止盈止损、也不会再提醒；提醒一次（TG＋雷达通知条，只提醒，不改任何设定）。开机＋删除／新增钱包当下检查 */ try {
  const hf = join(DIR, 'data', 'hid_all.json'); const all = !WALLETS.length && wHidden.size > 0; const pos = all ? (S.dyn || []).filter((x) => x && !x.closed && (!x.only || wHidden.has(String(x.only).toLowerCase()))) : [];
  if (pos.length) { const sig = [...wHidden].sort().join(','); const syms = [...new Set(pos.map((x) => String(x.sym || '').slice(0, 20)))].slice(0, 10); /* 技术用：通知里最多列几个代号（只是显示） */ let o = null; try { o = JSON.parse(readFileSync(hf, 'utf8')); } catch {}
    if (!o || o.sig !== sig || o.n !== pos.length) { try { mkdirSync(join(DIR, 'data'), { recursive: true }); writeFileSync(hf, JSON.stringify({ at: o && o.sig === sig ? o.at : Date.now(), sig, n: pos.length, syms })); } catch {} }
    if (S.hidAllSig !== sig) { S.hidAllSig = sig; save(); setTimeout(() => { tg(`⚠️ 你把雷达的钱包全部删除了：雷达现在等于没有钱包。\n这些钱包的持仓不会再自动卖（${pos.length} 个：${syms.join('、')}），也不会再止盈止损、提醒；币还在你的钱包里。\n要恢复：到雷达「设定 → 钱包」把钱包加回来；或自己到钱包里卖`).catch(() => {}); }, boot ? HID_TG_WAIT : 0); } }
  else { try { if (existsSync(hf)) unlinkSync(hf); } catch {} if (S.hidAllSig) { delete S.hidAllSig; save(); } } } catch {} }
const HID_TG_WAIT = 20e3; /*V101-4 技术用：开机后等 TG 连线好再发这则提醒（不是交易数字）*/
hidAllChk(1);
try { dynOwn(); } catch (e) { log('dynOwn ' + e.message); } /*RISK-FIX2-3 开机补一次*/ // 先写暂存档再换名，当机也不会把状态档写坏

// ---------- 持仓 ----------
const XQ = ['0x4902c5ebc598265ed2212b559b042de8a5eeec3f', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436', '0x205812cdbed920aff76c6580abd681a46d11efc7', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1']; 
const dsCache = new Map();
async function dexScreener(addr) { /* 不管跟什么币配对、在哪个 DEX（V2／V3／其他），都要查得到开盘——用 DexScreener 当保险（结果短暂快取，只是少打请求） */ /* 池子不管多小都算（取流动性最大的那个）；最低流动性＝你的 gen.minLiqUsd／bsc.tokMinLiqBnb */
  const k = dsCache.get(addr); if (k && Date.now() - k.t < 60e3) return k.v;
  let v = null; try { const j = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addr, { signal: AbortSignal.timeout(10000) })).json(); const ps = (j.pairs || []).filter((p) => p.chainId === 'bsc' && String(p.baseToken?.address || '').toLowerCase() === addr); if (ps.length) { ps.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)); const p = ps[0]; v = { pair: String(p.pairAddress).toLowerCase(), dex: p.dexId + (p.labels?.length ? ' ' + p.labels.join('') : ''), quote: p.quoteToken?.symbol || '', px: Number(p.priceUsd) || 0, liq: p.liquidity?.usd || 0 }; } } catch {}
  if (!v) v = await geckoPool(addr); /* NOV 的池子开在 PancakeSwap Infinity，DexScreener 一直没收录，工具以为没开盘、也读不到价格 → 再用 GeckoTerminal 查（Infinity、Uniswap v4、V3 都有） */
  dsCache.set(addr, { t: Date.now(), v }); return v;
}
const GPC = new Map(); let gpLast = 0; /* GeckoTerminal 免费版每分钟次数很少，持仓多的时候会把额度用光 → 结果快取、两次请求之间隔开（只是避开限流） */
const GP_WAIT_MAX_MS = 20e3; /* 技术用：GeckoTerminal 限流排队最多等多久 */ async function geckoPool(addr) { const c = GPC.get(addr); if (c && Date.now() - c.t < 600e3) return c.v; const w = gpLast + 2500 - Date.now(); gpLast = Math.max(Date.now(), gpLast + 2500); if (w > 0) { if (w > GP_WAIT_MAX_MS) return null; /* 排太久＝这次读不到（不用过期的旧价格） */ await sleep(w); } const v = await geckoPool0(addr); GPC.set(addr, { t: Date.now(), v }); if (GPC.size > 500) GPC.delete(GPC.keys().next().value); return v; }
async function geckoPool0(addr) {
  try {
    const j = await (await fetch(`https://api.geckoterminal.com/api/v2/networks/bsc/tokens/${addr}/pools`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })).json();
    const ps = (j.data || []).map((p) => { const a = p.attributes || {}, base = String(p.relationships?.base_token?.data?.id || '').toLowerCase().endsWith(addr); return { id: String(a.address || '').toLowerCase(), name: a.name || '', dex: String(p.relationships?.dex?.data?.id || 'gecko'), px: Number(base ? a.base_token_price_usd : a.quote_token_price_usd) || 0, liq: Number(a.reserve_in_usd) || 0 }; }).filter((x) => x.px > 0).sort((x, y) => y.liq - x.liq); /* 读得到价格的池子都算，取流动性最大的 */
    if (!ps.length) return null; const p = ps[0];
    return { pair: /^0x[0-9a-f]{40}$/.test(p.id) ? p.id : 'gt:' + p.id, dex: p.dex, quote: (p.name.split('/')[1] || '').trim().split(' ')[0], px: p.px, liq: p.liq };
  } catch { return null; }
}
async function poolOpen(tk) { /* 有没有已经开池（任何配对、任何 DEX）：V2 常见报价币＋DexScreener */
  for (const q of [WBNB, USDT, USD1, ...XQ]) { const pr = await cc(FACTORY, '0xe6a43905' + wa(tk) + wa(q), 60e3); if (pr && BigInt(pr) > 0n) { const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n) return true; } }
  return !!(await dexScreener(tk));
}
async function findPair(t) {
  for (const q of [USDT, WBNB, USD1, ...XQ]) { const r = await call(FACTORY, '0xe6a43905' + wa(t.addr) + wa(q)); const p = r ? '0x' + r.slice(-40) : null; if (!p || /^0x0{40}$/.test(p)) continue; const rs = await call(p, '0x0902f1ac'); if (!rs || BigInt('0x' + rs.slice(2, 66)) === 0n || BigInt('0x' + rs.slice(66, 130)) === 0n) continue; /* 有池子但没加流动性 = 还没真的开盘 */ return { pair: p, quote: q }; }
  { const d = await dexScreener(t.addr); if (d) return { pair: d.pair, ds: 1, dex: d.dex, quote: d.quote }; } /* V2 的 BNB/USDT/USD1/Flap 报价币都没有 → 用 DexScreener 找任何池子 */
  return null;
}
async function valueUsd(t, amt) { // 全部卖掉约可换多少 USDT
  if (amt <= 0n) return 0;
  let best = null; for (const path of [[t.addr, USDT], [t.addr, WBNB, USDT], [t.addr, USD1], ...XQ.flatMap((q) => [[t.addr, q, WBNB, USDT], [t.addr, q, USDT]])]) { const r = await call(ROUTER, '0xd06ca61f' + w(amt) + w(64) + w(path.length) + path.map(wa).join('')); if (r) { const x = Number(BigInt('0x' + r.slice(-64))) / 1e18; if (best == null || x > best) best = x; } } // 取所有池子里最好的价格，避免被很小的池子误判
  if (nrOn('sell.dsValue.on')) { const hc = nrNum('sell.dsHaircutPct'); if (hc != null) { const d = await dexScreener(t.addr); if (d?.px > 0) { const dec = await tokDec(t.addr).catch(() => null); if (dec != null) { const dv = (Number(amt) / 10 ** dec) * d.px * (1 - hc / 100); if (best == null || dv > best) best = dv; } /* 小数位数读不到就不用这个估价 */ } } } /* 路由报价读不到（V3／其他 DEX）或比较低时，要不要改用 DexScreener 价格估、打几折＝你的 sell.dsValue.on／sell.dsHaircutPct；没开或没填＝只用路由报价，读不到就是「读不到价格」（不卖、会通知） */
  return best;
}
async function flow(t, st, from, to) { // 新钱包数、成交笔数
  try {
    const tr = await rpc('eth_getLogs', [{ address: t.addr, topics: [T_TRANSFER], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
    st.holders = st.holders || {}; let fresh = 0;
    for (const l of tr) { const toA = '0x' + l.topics[2].slice(26); if (!st.holders[toA]) { st.holders[toA] = 1; fresh++; } }
    let swaps = 0; if (st.pair && /^0x[0-9a-f]{40}$/.test(st.pair)) swaps = (await rpc('eth_getLogs', [{ address: st.pair, topics: [T_SWAP], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }])).length;
    return { fresh, swaps };
  } catch { return { fresh: 0, swaps: 0 }; }
}
const decCache = new Map();
async function tokDec(a) { if (!decCache.has(a)) { const r = await call(a, '0x313ce567'); const d = r && r.length >= 66 ? Number(BigInt(r.slice(0, 66))) : NaN; if (!(Number.isInteger(d) && d >= 0 && d <= 77)) return null; decCache.set(a, d); } return decCache.get(a); } /* 读不到小数位数＝null（这一轮不动作，不记住失败）；0 位小数也可以 */
function trackFromSim(W, sim, sym, costUsd) { 
  let unk = null; { /* 付了钱成本却记成 0 → 用模拟里实际付出的 BNB／USDT 补算；ZR-W1：读不到 BNB 价格就记「成本未知」，读到才补上，在那之前不自动卖 */
    const paidBnb = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((x, b) => x - Number(b.change), 0) / 1e18;
    const paidU = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase() === USDT && Number(b.change) < 0).reduce((x, b) => x - Number(b.change), 0) / 1e18;
    if (!(costUsd > 0) && (paidBnb > 0 || paidU > 0)) { const px = S.lastBnbUsd; const paidTxt = `${paidBnb > 0 ? paidBnb.toFixed(4) + ' BNB ' : ''}${paidU > 0 ? paidU.toFixed(2) + ' USDT' : ''}`;
      if (!(paidBnb > 0) || px > 0) { costUsd = (paidBnb > 0 ? paidBnb * px : 0) + paidU; tg(`⚠️ [${W.name}] ${noLink(sym || '')} 有付钱（${paidTxt}）但当下没拿到成本，${paidBnb > 0 ? '用上一次读到的 BNB 价格' : '照付出的 USDT'}记成本 ${costUsd.toFixed(2)}U，照付费币规则卖`).catch(() => {}); }
      else { unk = { paidBnb, paidU }; tg(`⚠️ [${W.name}] ${noLink(sym || '')} 有付钱（${paidTxt}）但读不到 BNB 价格，成本先记「未知」。\n读到价格才补上成本、照付费币规则卖；在那之前不自动卖，要卖在 TG 打「卖 ${noLink(sym || '')}」`).catch(() => {}); } }
  }
  try { for (const b of sim?.balanceChanges || []) { if (String(b.owner).toLowerCase() !== W.addr || !(Number(b.change) > 0)) continue; const a = String(b.contractAddress || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || a.startsWith('0xeeee') || a === USDT || a === WBNB) continue; if (String(b.tokenType || '') !== 'Erc20') continue; if (!rcvOk(W, a)) { log(`[${W.name}] ${sym || a}：预演说会收到，但交易收据里没有转进来，不加入持仓`); continue; } /* 只追踪 ERC20 代币，NFT 不追 */
    S.dyn = S.dyn || []; { const ex = S.dyn.find((t) => t.addr === a && t.only === W.addr && !t.closed); if (ex && costUsd > 0) { ex.cost = +((ex.cost > 0 ? ex.cost : 0) + costUsd).toFixed(2); log(`[${W.name}] ${ex.sym} 加码，成本累加到约 ${ex.cost}U`); } if (ex && unk) { ex.costUnk = 1; ex.paidBnb = (ex.paidBnb > 0 ? ex.paidBnb : 0) + unk.paidBnb; ex.paidU = (ex.paidU > 0 ? ex.paidU : 0) + unk.paidU; log(`[${W.name}] ${ex.sym} 加码，这笔成本未知（读到 BNB 价格才补上，先不自动卖）`); } /* 同一个币再买，成本要累加，不然倍数算错、会提早出本 */ } if (!S.dyn.some((t) => t.addr === a && t.only === W.addr && !t.closed)) { S.dyn.push({ sym: sym || a.slice(0, 8), addr: a, cost: +(costUsd > 0 ? costUsd : 0).toFixed(2), ...(unk ? { costUnk: 1, paidBnb: unk.paidBnb, paidU: unk.paidU } : {}), only: W.addr, boughtAt: Date.now() }); log(`[${W.name}] ${sym || a} 加入持仓监控（${unk ? '成本未知，读到 BNB 价格才补上' : '成本约 ' + (costUsd > 0 ? costUsd : 0).toFixed(2) + 'U'}）`); } } } catch {}
}
const fmtUnits = (v, d) => { v = BigInt(v); if (v < 0n) v = 0n; const D = 10n ** BigInt(d); const i = v / D, f = v % D; const fs = d > 0 ? f.toString().padStart(d, '0').replace(/0+$/, '') : ''; return fs ? `${i}.${fs}` : `${i}`; }; /* 精确换算（wei → 数量字串） */
const SELL_SEQ = new WeakMap(); /*RISK-FIX2-1：每个币的记录每完成一笔卖出 +1（持仓检查读余额前记下，成本更新前比对：变了＝这一轮读到的余额可能是卖出前的）*/
const RACE_SKIP_MAX = 12; /*RISK-FIX2-1 技术常数（不是交易数字）：同一币连续几轮略过「成本更新」后强制更新一次并记日志；持仓检查一轮至少 5 秒，12 轮≈1 分钟以上，比一般卖单（等 15 秒＋收据）久 */
const ptxSeq = (a) => { const q = globalThis.PLUG_TX?.seqBy; return q ? (q.get(String(a).toLowerCase()) || 0) + (q.get('*') || 0) : 0; }; /*RISK-FIX2-1：外挂交易序号（只算这个币＋不知道是哪个币的合约互动）*/
const PQ_READ = new WeakMap(), PQ_N = new WeakMap(), PQ_W = new WeakMap(); /*V101-5：每个币的记录「读余额前」的外挂交易序号、连续略过几次卖出 */
function plugRaceSell(t, st) { /*V101-5：外挂正在／刚交易这个币（余额已变、外挂帐本还没更新）→ 雷达照余额算的数量可能会卖到外挂的币（或少卖）→ 这次先不卖；连续 RACE_SKIP_MAX 次后照卖（记日志），免得外挂一直交易时雷达永远卖不了 */
  const P = globalThis.PLUG_TX; if (!P || !PQ_READ.has(st)) return ''; const k = String(t.addr).toLowerCase(); const r = ptxSeq(k) !== PQ_READ.get(st) ? '外挂刚交易这个币' : P.busy.has('*') || P.busy.has(k) ? '外挂正在交易这个币' : '';
  if (!r) { PQ_N.delete(st); return ''; } const n = (PQ_N.get(st) || 0) + 1; if (n > RACE_SKIP_MAX) { PQ_N.delete(st); log(`${t.sym} 连续 ${n - 1} 次因为${r}没卖，这次照卖（外挂帐本可能还没更新）`); return ''; } PQ_N.set(st, n); return r; }
function costRace(W, t, st, sq0, pq0) { /*RISK-FIX2-1：这一轮要不要略过「成本更新」（回传原因；空字串＝照常更新）——卖单进行中、读余额后有卖单完成、外挂正在／刚交易这个币（雷达扣外挂部位有时间差）。只略过成本，卖出判断照跑 */
  if (SELLING.has(W.name + '|' + t.addr)) return '卖单进行中'; if ((SELL_SEQ.get(st) || 0) !== sq0) return '读余额后有卖单成交';
  const P = globalThis.PLUG_TX; if (!P) return ''; const k = String(t.addr).toLowerCase(); if (ptxSeq(k) !== pq0) return '外挂刚交易'; return P.busy.has('*') || P.busy.has(k) ? '外挂交易进行中' : ''; }
function addCostEx(W, a, usd, why) { /*RISK-FIX2-2：同币同钱包已有持仓（没结束）→ 这笔买入的钱加进成本（比照 trackFromSim；平均买入价由持仓检查照「钱先记、币到了再算」更新）；回传有没有这笔持仓 */
  const ex = (S.dyn || []).find((x) => x.addr === String(a).toLowerCase() && x.only === W.addr && !x.closed); if (!ex) return false;
  if (usd > 0) { ex.cost = +((ex.cost > 0 ? ex.cost : 0) + usd).toFixed(2); log(`[${W.name}] ${ex.sym} ${why}加码，成本累加到约 ${ex.cost}U`); } return true; }
const SELLING = new Set(); const TIMEOUT_RE = /timed? ?out|ETIMEDOUT|killed|SIGTERM/i; /* 送出逾时的样子（技术用） */
async function sell(t, st, amt, why, W = WALLETS[0]) {
  const sk = W.name + '|' + t.addr; if (SELLING.has(sk)) return false; SELLING.add(sk); INFLIGHT++; try { return await sellInner(t, st, amt, why, W); } finally { INFLIGHT--; SELLING.delete(sk); } /* 01:17 CENSUS 卖单送出后刚好程序更新重启，等成交、发 💰、记帐的步骤被砍掉；卖出也算「交易进行中」，重启要等它做完 */ /* 同一个币同时只卖一次（TG 指令和自动卖不会撞） */
}
async function sellInner(t, st, amt, why, W) { const cB0 = st.cB; /*RISK-FIX2-1 卖单开始时持仓检查最后看到的余额*/
  if (CONFL && !/指示/.test(why)) { if (st.conflLog !== CONFL) { st.conflLog = CONFL; log(`[${W.name}] ${t.sym} 想自动卖（${why}），但另一个雷达正在用同一个钱包（${CONFL}）→ 这次先不卖，避免两边重复卖；关掉其中一个就会恢复`); } return false; } 
  { const pr = plugRaceSell(t, st); if (pr) { globalThis.LAST_SELL_ERR = `⏳ ${pr}（外挂帐本还没更新，现在算的数量可能会卖到外挂的币），这次先不卖，等一下再试`; if (PQ_N.get(st) === 1 || PQ_W.get(st) !== why) { PQ_W.set(st, why); log(`[${W.name}] ${t.sym} ${pr}，这次先不卖（${why}）`); } return false; } } /*V101-5（同一个原因只记第一次）*/
  { const live = (S.dyn || []).find((x) => x.addr === t.addr && x.only === W.addr && !x.closed); if (live?.hold && !/指示/.test(why)) { log(`${t.sym} 设定为等使用者通知，不自动卖（${why}）`); return false; } } /* 以最新设定为准，避免背景用旧清单卖掉（币安无忧 19:56） */
  if (st.sellPend && !/指示/.test(why)) { globalThis.LAST_SELL_ERR = '上一笔卖单结果待确认'; return false; } /*V105-FIX2：上一笔结果待确认 → 自动卖不送（你手动按的卖照送：数量照现在链上余额算）*/
  const dec = await tokDec(t.addr); if (dec == null) { log(`[${W.name}] ${t.sym} 读不到小数位数，这次不卖`); return false; } /* 外挂自己的部位已经在 holdW 先从余额扣掉（再算百分比） */ const qty = fmtUnits(BigInt(amt), dec); // 依代币小数位数算数量（精确，不经过浮点）
  if (!(Number(qty) > 0)) return false;
  const bnb0 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const tb0 = await call(t.addr, '0x70a08231' + wa(W.addr)); /* 送出前的代币余额（逾时时用来判断有没有卖掉） */
  const r = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', qty, '--fromToken', t.addr, '--toToken', NATIVE_BNB]);
  log(`卖 ${t.sym} ${qty}: ${r.t.slice(0, 600)}`);
  if (!r.j && TIMEOUT_RE.test(r.t || '')) { /* 逾时＝结果不明（可能已上链）：不算失败、不算进「失败几次放弃」；先记下来，余额变少才算这条规则做完，没变就照你的 sell.pendMin 到期后再试 */
    st.sellPend = { at: Date.now(), bal0: tb0 == null ? null : big(tb0).toString(), why, snap: { done2: [...(st.done2 || [])], stage: st.stage ?? 0, sellNowDone: !!st.sellNowDone, moonPend: st.moonPend || 0 } };
    await tg(`⚠️ [${W.name}] ${t.sym} 卖出结果不明（送出逾时，可能已经成交）（${why}）\n先不重复卖：等读到余额变化再决定；余额变少＝这笔算卖掉`).catch(() => {}); return 'pend'; }
  if (!r.j?.success) { st.sellFail = (st.sellFail || 0) + 1; st.sellFailAt = Date.now(); const msg = (r.j?.error?.message || r.t).slice(0, 200); globalThis.LAST_SELL_ERR = msg; log(`[${W.name}] ${t.sym} 卖出失败第 ${st.sellFail} 次：${msg.replace(/\n/g, ' ')}`);
    /* 放弃／不通知都照你的设定（没开＝一直重试、第 1 次失败通知一次） */
    const gu = nrNum('sell.giveUpN'), fm = nrNum('notify.sellFailMinUsd'); const small = fm != null && st.curV != null && st.curV < fm;
    if (gu != null && st.sellFail >= gu) { st.stage = 9; st.gaveUp = ts(); log(`[${W.name}] ${t.sym} 卖了 ${st.sellFail} 次都失败（你设 ${gu} 次放弃），不再自动卖`); }
    if (!small && st.sellFail === 1) await tg(`⚠️ [${W.name}] ${t.sym} 想卖但失败（${why}）\n${msg}\n之后会自动重试，不再重复通知；卖掉时会发 💰 通知`);
    return false; }
  const tS0 = Date.now(); { /*V105-FIX2 SELL-PEND：只有收据 status＝0x1 才算卖掉；收据 0x0＝失败；没交易编号／查不到收据＝结果待确认（不改持仓、不记成交、不重复卖）*/
    const txh = String(r.j?.data?.txHash || ''); const hOk = /^0x[0-9a-f]{64}$/i.test(txh); const rc = hOk ? await waitRc(txh).catch(() => null) : null;
    if (rc && rc.status === '0x0') { st.sellFail = (st.sellFail || 0) + 1; st.sellFailAt = Date.now(); const msg = '交易上链了但失败（合约拒绝）' + txh; globalThis.LAST_SELL_ERR = msg; log(`[${W.name}] ${t.sym} 卖出失败第 ${st.sellFail} 次：${msg}`);
      const gu = nrNum('sell.giveUpN'); if (gu != null && st.sellFail >= gu) { st.stage = 9; st.gaveUp = ts(); log(`[${W.name}] ${t.sym} 卖了 ${st.sellFail} 次都失败（你设 ${gu} 次放弃），不再自动卖`); }
      if (st.sellFail === 1) await tg(`⚠️ [${W.name}] ${t.sym} 想卖但失败（${why}）\n${msg}\n币还在钱包里，之后会自动重试；卖掉时会发 💰 通知`).catch(() => {}); return false; }
    if (!rc || rc.status !== '0x1') { const pw = !hOk ? '钱包回成功但没给交易编号' : '一直查不到交易收据';
      st.sellPend = { at: Date.now(), bal0: tb0 == null ? null : big(tb0).toString(), tx: hOk ? txh : null, why, snap: { done2: [...(st.done2 || [])], stage: st.stage ?? 0, sellNowDone: !!st.sellNowDone, moonPend: st.moonPend || 0 } }; save();
      log(`[${W.name}] ${t.sym} 卖出结果待确认（${pw}）：先不改持仓、不记成交（${why}）`);
      await tg(`⚠️ [${W.name}] ${t.sym} 卖出结果待确认（${pw}，可能成交也可能没成交）（${why}）\n先不改持仓、不记成交、不重复卖：等读到余额变化或交易收据再决定${hOk ? '\n交易 ' + txh : ''}`).catch(() => {}); return 'pend'; } }
  st.sellFail = 0;
  await sleep(Math.max(0, 15000 - (Date.now() - tS0))); /*V105-FIX2：等收据的时间算进原本等余额更新的时间（卖单总时间不变长）*/
  const bnb1 = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  const got = Number(bnb1 - bnb0) / 1e18, px = await bnbUsd().catch(() => 0), gotU = got * px; // 卖出实际换回多少（使用者想知道每笔拿回多少钱）
  const amtB0 = await (async () => { try { if (tb0 == null || String(tb0).length < 66) return null; const nb = await plugNet(W, t.addr, big(tb0)); return nb != null && nb > 0n ? Number(nb) / 10 ** dec : null; } catch { return null; } })(); /*AMT-4 卖之前的余额（不含外挂的部位）；读不到就照原本的算法*/
  S.trades = S.trades || []; const cp = t.cost > 0 && amtB0 > 0 ? +(Math.max(0, costRem(t.cost, st, amtB0) - (+st.pendU > 0 && !(amtB0 > +st.cB) ? +st.pendU : 0)) * Math.min(1, Number(qty) / amtB0)).toFixed(2) /*RISK-FIX2-1 付了钱、币还没到（pendU，卖前余额没比上次多）不算卖掉；币已经到了（余额变多）就算进去*/ : t.cost > 0 && st.qty0 > 0 ? +(t.cost * Math.min(1, Number(qty) / st.qty0)).toFixed(2) : 0; /*AMT-4 这笔卖掉的成本＝剩下的成本×卖掉的比例*/ /* 这一笔卖掉的部分对应多少成本（分批卖才不会算成大亏） */ const unk = !(got > 0) || !(px > 0); /* 等一下之后余额没增加（还没上链／同时有别的交易）＝换回多少不明，不算亏、不算进连亏 */ S.trades.push({ sym: t.sym, addr: t.addr, w: W.name, bnb: unk ? null : +got.toFixed(6), usd: unk ? null : +gotU.toFixed(2), cost: t.cost || 0, cp, manual: t.src === 'manual' ? 1 : 0, at: ts(), why }); if (cp > 0 && Number.isFinite(+st.costLeft)) st.costLeft = Math.max(0, +st.costLeft - cp); /*AMT-2 卖掉那部分的成本从「剩下的成本」扣掉（下一轮持仓检查会照余额重算）*/ { const soldN = Number(qty), base = amtB0 > 0 ? amtB0 : +st.cB > 0 ? +st.cB : 0; if (soldN > 0 && base > 0 && st.cB != null && Number.isFinite(+st.cL)) { if (st.cB !== cB0) { log(`[${W.name}] ${t.sym} 卖单进行中持仓检查已经强制更新过成本，这笔卖出的成本交给下一轮持仓检查照余额扣（不扣第二次）`); } /*RISK-FIX2-1：卖单期间被强制更新（RACE_SKIP_MAX）过＝持仓检查已经照它看到的余额算过*/ else { const f = Math.min(1, soldN / base); const arr = amtB0 > 0 && amtB0 > +st.cB; const pu = +st.pendU > 0 && !arr ? Math.min(+st.pendU, +st.cL) : 0; st.cL = Math.max(0, pu + (+st.cL - pu) * (1 - f)); st.cB = Math.max(0, +st.cB * (1 - f)); if (arr && +st.pendU > 0) st.pendU = +st.pendU * (1 - f); st.costLeft = st.cL; } } } /*RISK-FIX2-1：加码的币已经到了（卖前余额比上次多）→ 加码的钱一起照比例扣*/ /*RISK-FIX 6：卖出成交就马上照卖掉的比例减少「剩下的成本 cL」和「上次看到的余额 cB」——卖完、下一轮持仓检查前又加码时，下一轮看到的是加码多出来的颗数（平均买入价、倍数＝现价÷平均买入价才对） */ SELL_SEQ.set(st, (SELL_SEQ.get(st) || 0) + 1); /*RISK-FIX2-1：卖出后的成本只由上面这一处更新；持仓检查读余额后有卖单完成就略过这一轮的成本更新（不会再照余额扣一次） */
  await tg(`💰 [${W.name}] 已卖出 ${t.sym}（${why}）\n数量 ${qty}${got > 0 ? `\n换回 ${got.toFixed(5)} BNB（约 ${gotU.toFixed(2)}U）` : ''}\n订单 ${r.j.data?.orderId || ''}`);
  return true;
}

/* 每个钱包每个币的记录键（跟 holdW 一样）＋扣掉外挂自己的部位（雷达不会卖到外挂的币） */
/*AMT-FIX 金额：持仓「剩下部分的成本」——卖掉一部分照数量比例减少，加码照平均价重算；只算钱，不改任何买卖规则 */
function costRem(cost, st, balN) { cost = Number(cost) || 0; if (!(cost > 0)) return 0; st = st || {}; /* 跟持仓检查（AMT-4）同一套算法，但不改记录：上次检查后余额变少照比例扣、成本变多加上去（刚加码／刚卖、检查还没跑也对） */
  if (st.cSeen != null && Number.isFinite(+st.cL) && st.cB != null) { let l = +st.cL; if (balN != null && Number.isFinite(balN) && balN < st.cB) { const pu = +st.pendU > 0 ? Math.min(+st.pendU, l) : 0; l = st.cB > 0 ? pu + (l - pu) * (balN / st.cB) : pu; } /*RISK-FIX2-1 还没到货的钱不照比例扣*/ if (cost !== +st.cSeen) l = cost > +st.cSeen ? l + (cost - st.cSeen) : (st.cSeen > 0 ? l * (cost / st.cSeen) : cost); return Math.max(0, Math.min(cost, l)); }
  if (st.qty0 > 0 && balN != null && Number.isFinite(balN)) return cost * Math.min(1, balN / st.qty0); return cost; } /* 旧资料（还没有 cL）：照原本的原始持有量算 */
const AMT_POS_KEYS = ['stage', 'done2', 'qty0', 'peak', 'peakAt', 'ppeak', 'ppeakAt', 'notified', 'sellNowDone', 'slHit', 'trHit', 'crashHit', 'dropHit', 'dropWarnedPeak', 'basePx', 'fpp', 'moon', 'moonPend', 'done', 'doneAt', 'gaveUp', 'sellFail', 'sellFailAt', 'sellPend', 'curV', 'last', 'cL', 'cSeen', 'cB', 'costLeft', 'ap', 'pendU', 'lastInc', 'mx', 'lastBal', 'balInit', 'noPxAt', 'noPxWarn', 'costUnkWarn', 'conflLog', 'pendSold', 'raceN'];
function amtNewPos(st) { for (const k of AMT_POS_KEYS) delete st[k]; st.peak = 0; st.peakAt = 0; st.sold = 0; } /* 同一个币卖光后又买＝新的一笔：上一笔的卖出进度／高点／成本清掉（池子资料保留） */
function stKey(W, t) { const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0; const sfx = dupSym ? '#' + t.addr.slice(2, 8) : ''; const nk = '@' + W.addr + ':' + t.sym + sfx; if (!S.tokens[nk]) { if (!S.stMe0 && WALLETS[0]) S.stMe0 = WALLETS[0].addr; const lk = (W.addr === S.stMe0 ? t.sym : W.name + ':' + t.sym) + sfx; if (S.tokens[lk]) { S.tokens[nk] = S.tokens[lk]; delete S.tokens[lk]; save(); } } return nk; } /*RISK-FIX 4：记录键固定用钱包地址（@地址:代号）——删掉第一个钱包后其他钱包的记录不会对错、分批止盈不会重卖；旧键（第一个钱包没有前缀、其他「名字:代号」）第一次读到就搬过来 */
async function plugNet(W, addr, balAll) { const ph = globalThis.PLUG_HELD?.(addr, W.addr) || 0; if (!(ph > 0)) return balAll; /*PLUG-FIX：只扣「这个钱包」里的外挂部位（外挂部位记着买入钱包）*/ const dq = await tokDec(addr); if (dq == null) return null; const [pi, pf = ''] = String(ph.toFixed(Math.min(dq, 18))).split('.'); const sub = BigInt(pi) * 10n ** BigInt(dq) + (pf ? BigInt(pf.padEnd(dq, '0').slice(0, dq) || '0') : 0n); return balAll > sub ? balAll - sub : 0n; }
async function openWatch(head) { /* 还没开盘的持仓独立快速查，不跟旧持仓排队；ZR-W1：所有还没开盘的都查（不限买了多久），一轮查完才开下一轮 */
  for (const W of WALLETS) for (const t0 of (S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    if (t0.closed) continue; /*AMT-7*/
    const t = { ...t0, cost: (t0.only || t0.both || W.addr === ME) ? t0.cost : 0 };
    const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0;
    const key = stKey(W, t); /*RISK-FIX 4*/
    const st = S.tokens[key]; if (!st || st.pair || st.done || !st.checked) continue;
    const p = await findPair(t).catch(() => null); if (!p || st.pair) continue;
    st.pair = p.pair; if (p.ds) { st.pairDs = 1; st.pairInfo = `${p.dex}，跟 ${p.quote} 配对`; } st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400;
    const balR = await call(t.addr, '0x70a08231' + wa(W.addr)).catch(() => null); const bal = balR ? big(balR) : 0n;
    if (bal > 0n) await honeypotCheck(W, t, st, bal).catch(() => {});
    await tg(`🚀 ${t.sym} 开池了（${st.pairInfo || 'PancakeSwap'}）\n合约 ${t.addr}\n池子 ${p.pair}\n开始追踪价格，达到高点会自动卖`);
  }
}
async function holdings(head, onlyFast = false) {
  await Promise.all(WALLETS.map((W) => holdW(W, head, onlyFast).catch((e) => log('holdings ' + W.name + ' ' + e.message))));
}
async function holdW(W, head, onlyFast) { // 所有钱包同时跑（速战：卖单不排队）
  for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    if (t0.closed) continue; /*AMT-7 已结束的旧持仓不再跑（重买是新的一笔）*/
    const t = { ...t0, cost: (t0.only || t0.both || W.addr === ME) ? t0.cost : 0, hold: t0.hold || t0.autoSell === false || ((t0.src === 'manual' || t0.src === 'force') && !t0.tpsl) }; /* 手动／一键买／强制打的，有设止盈止损就照设定卖，没设才只通知；单笔「自动卖」关掉的也只通知 */
    const dupSym = TOKENS.concat(S.dyn || []).filter((x) => (!x.only || x.only === W.addr) && x.sym === t.sym && x.addr !== t.addr).length > 0; 
    const key = stKey(W, t); /*RISK-FIX 4*/
    const st = (S.tokens[key] = S.tokens[key] || { hist: [], peak: 0, peakAt: 0, sold: 0 });
    if (t0.boughtAt) { /*AMT-7 卖光后重买（boughtAt 不同）→ 卖出状态重来；旧资料：只有「旧的那笔已结束且这份记录卡在卖完／放弃」才重设 */ if (st.posAt == null) { const old = (S.dyn || []).some((x) => x !== t0 && x.closed && x.addr === t0.addr && x.only === t0.only && +x.closed <= +t0.boughtAt); if (old && (st.stage === 9 || st.gaveUp || st.sellNowDone)) amtNewPos(st); st.posAt = t0.boughtAt; } else if (st.posAt !== t0.boughtAt) { amtNewPos(st); st.posAt = t0.boughtAt; } }
    if (onlyFast && !(st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done)) continue;
    if (!onlyFast && st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done && st.pair) continue; /* 刚开盘那段（RULE.fastMin，只是检查频率）只交给密集检查，完整检查跳过，避免重复部分卖出 */
    if (!onlyFast && st.done && st.doneAt && Date.now() - st.doneAt < 30 * 60e3) continue; /* 卖完（余额 0）的旧持仓隔一阵子才重查余额（只是检查频率），整轮更快 */
    if (t0.costUnk) { const bp = await bnbUsd().catch(() => 0); /* 成本未知（付钱时读不到 BNB 价格）→ 读到价格才补上成本；在那之前不跑任何卖出规则 */
      if (Number.isFinite(bp) && bp > 0) { t0.cost = +((t0.cost > 0 ? t0.cost : 0) + (t0.paidBnb > 0 ? t0.paidBnb * bp : 0) + (t0.paidU > 0 ? t0.paidU : 0)).toFixed(2); delete t0.costUnk; delete t0.paidBnb; delete t0.paidU; t.cost = (t0.only || t0.both || W.addr === ME) ? t0.cost : 0; delete st.costUnkWarn; save(); await tg(`✅ [${W.name}] ${t.sym} 读到 BNB 价格了，成本补记为 ${t0.cost}U，开始照付费币规则卖`).catch(() => {}); }
      else { if (!st.costUnkWarn) { st.costUnkWarn = 1; log(`[${W.name}] ${t.sym} 成本未知（读不到 BNB 价格），先不自动卖`); } continue; } }
    const noPx = async () => { if (!(t.cost > 0) || t.hold || st.done || st.stage >= 9) return; st.noPxAt = st.noPxAt || Date.now(); if (!st.noPxWarn && nrOn('notify.noPx') && Date.now() - st.noPxAt >= (nrNum('notify.noPxMin') ?? 0) * 60e3) { /* 照你的开关 */ st.noPxWarn = 1; await tg(`⚠️ [${W.name}] ${t.sym} 读不到价格／余额（节点或行情来源断线）。\n这段时间雷达没办法帮你止盈止损，读到之后会自动恢复并通知你。很担心的话可以先自己卖。\n${t.addr}`).catch(() => {}); } }; /* 读不到数据就是没在保护你的钱 → 要讲 */
    const sq0 = SELL_SEQ.get(st) || 0, pq0 = ptxSeq(t.addr); PQ_READ.set(st, pq0); /*RISK-FIX2-1 读余额前记下；V101-5 卖出前比对*/
    const balR = await call(t.addr, '0x70a08231' + wa(W.addr)); if (balR == null || balR === '0x' || String(balR).length < 66) { await noPx(); continue; } /* 回 '0x'／太短＝读不到，不当成 0 */ const balAll = big(balR); let bal = balAll; { const ph = globalThis.PLUG_HELD?.(t.addr, W.addr) || 0; /*PLUG-FIX*/ if (ph > 0) { const dq = await tokDec(t.addr); if (dq == null) continue; const [pi, pf = ''] = String(ph.toFixed(Math.min(dq, 18))).split('.'); const sub = BigInt(pi) * 10n ** BigInt(dq) + (pf ? BigInt(pf.padEnd(dq, '0').slice(0, dq) || '0') : 0n); bal = balAll > sub ? balAll - sub : 0n; } } /* 先扣掉外挂自己的部位，再算要卖几 %（雷达不会卖到外挂的币） */
    if (st.sellPend) { const sp = st.sellPend; const pm = nrNum('sell.pendMin'); /* 卖出结果不明 → 等余额 */
      if (sp.bal0 != null && balAll < BigInt(sp.bal0)) { delete st.sellPend; st.pendSold = { why: sp.why }; /*RISK-FIX2-1：下面持仓检查照余额扣成本时，补记这笔卖出*/ log(`[${W.name}] ${t.sym} 之前逾时的卖单：余额变少了，算卖掉（${sp.why}）`); await tg(`✅ [${W.name}] ${t.sym} 之前结果不明的卖单已经成交（余额变少了）：${sp.why}`).catch(() => {}); }
      else if (sp.tx && await (async () => { const rc = await rpc('eth_getTransactionReceipt', [sp.tx]).catch(() => null); if (rc?.status === '0x0') { const sn = sp.snap || {}; st.done2 = sn.done2 || []; st.stage = sn.stage ?? 0; st.sellNowDone = !!sn.sellNowDone; st.moonPend = sn.moonPend || 0; delete st.sellPend; log(`[${W.name}] ${t.sym} 待确认的卖单：收据显示失败，算没卖掉，规则恢复（${sp.why}）`); return true; } if (rc?.status === '0x1') { delete st.sellPend; st.pendSold = { why: sp.why }; log(`[${W.name}] ${t.sym} 待确认的卖单：收据显示成功，算卖掉（${sp.why}）`); await tg(`✅ [${W.name}] ${t.sym} 之前待确认的卖单已经成交（收据成功）：${sp.why}`).catch(() => {}); return true; } return false; })()) { /*V105-FIX2 收据确认*/ }
      else if (pm != null && Date.now() - sp.at >= pm * 60e3) { const sn = sp.snap || {}; st.done2 = sn.done2 || []; st.stage = sn.stage ?? 0; st.sellNowDone = !!sn.sellNowDone; st.moonPend = sn.moonPend || 0; delete st.sellPend; log(`[${W.name}] ${t.sym} 之前逾时的卖单：等了 ${pm} 分钟余额没变，算没卖掉，规则恢复（你的 sell.pendMin）`); }
      else { continue; } } /* 还在等：这一轮不跑任何卖出规则，避免重复卖 */
    if (t0.pending && balAll > 0n) { delete t0.pending; await tg(`✅ [${W.name}] ${t.sym} 之前结果不明的买入：读到余额了，开始照规则追踪`).catch(() => {}); save(); } else if (t0.pending) continue; /* 结果不明的部位，读到余额才开始跑卖出规则 */
    const prevBal = BigInt(st.lastBal || '0'); st.lastBal = bal.toString();
    if (bal > prevBal && st.balInit) { const v0 = await valueUsd(t, bal - prevBal); await tg(`🎁 [${W.name}] 收到 ${t.sym} ${await (async () => { const dq = await tokDec(t.addr); return dq == null ? '（读不到小数位数，数量不显示）' : (Number(bal - prevBal) / 10 ** dq).toLocaleString() + ' 颗'; })()}${v0 != null ? '，约值 ' + v0.toFixed(2) + 'U' : '（还没有池子可以报价）'}\n会自动追踪，到高点就卖`); }
    st.balInit = true;
    if (bal === 0n) { st.done = true; st.doneAt = Date.now(); continue; }
    if (bal > 0n && st.done && st.stage !== 9) { delete st.done; delete st.doneAt; } /* 又有余额（之前误判 0）→ 恢复止盈止损 */
    if (st.pair && !st.verified && !st.pairDs) { const rs = await call(st.pair, '0x0902f1ac'); if (rs == null) { /* 查询失败：先不判断 */ } else if (BigInt('0x' + rs.slice(2, 66)) === 0n) { delete st.pair; st.checked = true; } if (rs != null) st.verified = true; } // 储备是 0 的空池子不算，清掉重找
    if (!st.pair) {
      const p = await findPair(t);
      const first = !st.checked; st.checked = true;
      if (p) { st.pair = p.pair; if (p.ds) { st.pairDs = 1; st.pairInfo = `${p.dex}，跟 ${p.quote} 配对`; } st.openAt = st.openAt || Date.now(); st.fromBlock = head - 400; if (!first) await honeypotCheck(W, t, st, bal); if (!first) await tg(`🚀 ${t.sym} 开池了（${st.pairInfo || 'PancakeSwap'}）\n合约 ${t.addr}\n池子 ${p.pair}\n开始追踪价格，达到高点会自动卖`); }
      else { { const nph = NR.on('risk.localBlack') ? NR.num('risk.noPoolH') : null; if (nph != null && t0.deployer && t0.boughtAt && Date.now() - t0.boughtAt > nph * 3600e3) blacklist(t0.deployer, `${t.sym} 打完 ${nph} 小时还没开池`); } continue; }
    }
    const v = await valueUsd(t, bal); if (v == null) { await noPx(); continue; } st.curV = v; if (st.noPxAt) { if (st.noPxWarn) await tg(`✅ [${W.name}] ${t.sym} 又读得到价格了（约 ${v.toFixed(2)}U），止盈止损恢复正常`).catch(() => {}); st.noPxAt = 0; st.noPxWarn = 0; }
    // 用「每颗价格」算高点和倍数
    const dec = await tokDec(t.addr); if (dec == null) { st.last = { v, at: ts() }; continue; } /* 读不到小数位数 → 这轮不动作 */ const balN = Number(bal) / 10 ** dec || 1e-18; const px = v / balN;
    let race = costRace(W, t, st, sq0, pq0); if (race) { st.raceN = (+st.raceN || 0) + 1; if (st.raceN > RACE_SKIP_MAX) { log(`[${W.name}] ${t.sym} 连续 ${st.raceN - 1} 轮${race}、成本没更新 → 强制更新一次（RISK-FIX2-1）`); race = ''; } } if (!race) st.raceN = 0;
    if (race) { if (+st.ap > 0) st.mx = px / st.ap; } /*RISK-FIX2-1：卖单／外挂交易进行中或刚完成 → 这一轮只略过成本更新（成本只由卖出那一处更新，不会扣两次）；下面的止盈止损／急跌判断照跑 */ else
    { /*AMT-4 平均买入价 st.ap（每颗多少 U）：只由真的花钱买入（含加码）决定；别人转进来、没花钱的币（空投、转帐）不改平均价，但算进数量和现值；卖出时平均价不变、剩下的成本 cL 照数量比例减少。
      倍数＝现价÷平均买入价：qty0＝总成本÷平均价，所以原本「vFull÷成本」的通知／止盈止损规则都变成这个口径（规则本身没改）。旧资料第一次照原本的原始持有量定平均价 */
      const c = t.cost > 0 ? +t.cost : 0;
      if (st.cSeen == null || !Number.isFinite(+st.cL) || st.cB == null) { if (!st.qty0 || balN > st.qty0 * 1.0001) st.qty0 = balN; /* 原始持有量 */ st.cL = c * Math.min(1, balN / st.qty0); st.ap = c > 0 && st.qty0 > 0 ? c / st.qty0 : 0; st.pendU = 0; st.lastInc = 0; }
      else { const cB = +st.cB, cS = +st.cSeen, dc = c - cS; let dq = balN - cB, inc = 0; st.pendU = +st.pendU > 0 ? +st.pendU : 0; st.ap = +st.ap > 0 ? +st.ap : 0;
        if (dq < 0) { const l0 = +st.cL, pu = Math.min(st.pendU, l0); st.cL = cB > 0 ? pu + (l0 - pu) * (balN / cB) : pu; /*RISK-FIX2-1 还没到货的钱不照比例扣*/ if (st.pendSold) { S.trades = S.trades || []; S.trades.push({ sym: t.sym, addr: t.addr, w: W.name, bnb: null, usd: null, cost: t.cost || 0, cp: +Math.max(0, l0 - st.cL).toFixed(2), manual: t.src === 'manual' ? 1 : 0, at: ts(), why: st.pendSold.why, pend: 1 }); } } /*RISK-FIX2-1：逾时后确认成交的卖单补记（换回多少不明＝不算亏）*/ /* 余额变少（卖掉／转走）→ 剩下的成本照数量比例减少，平均价不变 */
        if (dc > 0) { if (!(cS > 0) || !(st.ap > 0)) { st.cL = +st.cL + dc; st.ap = balN > 0 ? st.cL / balN : 0; st.pendU = 0; if (dq > 0) dq = 0; } /* 之前没有成本（成本后补）：现在拿著的都算买的 */
          else { const qP = Math.max(0, +st.cL - st.pendU) / st.ap; const qN = dq > 0 ? dq : (+st.lastInc > 0 ? +st.lastInc : 0); /* 这次花的钱买到的颗数：同一轮多出来的，或上一轮刚多出来的（币比成本先读到） */
            if (qN > 0) { st.ap = (qP * st.ap + st.pendU + dc) / (qP + qN); st.pendU = 0; if (dq > 0) dq = 0; } else st.pendU += dc; /* 钱先记、币还没到 → 等币到再算平均价 */ st.cL = +st.cL + dc; } }
        else if (dc < 0) { const k = cS > 0 ? c / cS : 0; st.cL = +st.cL * k; st.ap *= k; st.pendU *= k; } /* 手动改成本：照比例 */
        if (dq > 0) { if (st.pendU > 0 && st.ap > 0) { const qP = Math.max(0, +st.cL - st.pendU) / st.ap; st.ap = (qP * st.ap + st.pendU) / (qP + dq); st.pendU = 0; } else inc = dq; } /* 有付了钱还没到的币 → 算买的；没有＝别人转进来，平均价不变 */
        st.lastInc = inc; st.cL = Math.max(0, Math.min(c, +st.cL));
        if (c > 0 && st.ap > 0) st.qty0 = c / st.ap; else if (!st.qty0 || balN > st.qty0 * 1.0001) st.qty0 = balN; }
      st.cSeen = c; st.cB = balN; st.costLeft = st.cL; st.mx = st.ap > 0 ? px / st.ap : null; delete st.pendSold; /*AMT-2 剩下部分的成本、倍数（画面／手机用）*/ }
    const vFull = px * st.qty0; // 如果还拿著全部，现在值多少（算倍数用）
    const cRem = costRem(t.cost, st, balN); const apTxt = st.ap > 0 ? `平均买入价 ${(+st.ap).toPrecision(4)}U、现价 ${px.toPrecision(4)}U` : ''; const cTxt = t.cost > 0 && cRem.toFixed(2) !== (+t.cost).toFixed(2) ? `剩下部分成本 ${cRem.toFixed(2)}U（总成本 ${t.cost}U${apTxt ? '；' + apTxt : ''}）` : `成本 ${t.cost}U${apTxt ? '（' + apTxt + '）' : ''}`; /*AMT-3 讯息里倍数＝现价÷平均买入价，同一则讯息附上这两个价格（金额是剩下部分的成本和现值）*/
    const from = Math.max(st.fromBlock || head - 20, head - 2000); const f = await flow(t, st, from, head); st.fromBlock = head + 1;
    const now = Date.now(); st.hist.push({ t: now, v, fresh: f.fresh, swaps: f.swaps }); st.hist = st.hist.filter((h) => now - h.t < 20 * 60e3);
    if (v > st.peak) { st.peak = v; st.peakAt = now; }
    if (px > (st.ppeak || 0)) { st.ppeak = px; st.ppeakAt = now; }
    const sum = (a, b, k) => st.hist.filter((h) => now - h.t >= a * 1000 && now - h.t < b * 1000).reduce((s, h) => s + h[k], 0);
    const fresh5 = sum(0, 300, 'fresh'), swaps5 = sum(0, 300, 'swaps'), swapsPrev5 = sum(300, 600, 'swaps');
    if (st.stage == null) st.stage = 0;
    if (st.stage >= 9) { st.last = { v, at: ts() }; continue; }
    if (st.sellFail && now - (st.sellFailAt || 0) < Math.min(2, 2 ** (st.sellFail - 1)) * 60e3) { st.last = { v, at: ts() }; continue; } // 卖不掉：重试间隔逐次拉长（有上限），不狂重试（只是重试频率）
    st.notified = st.notified || [];
    if (t.cost > 0 && !t.hold && !t.custom) for (const x of ZR_LIST('notify.multX')) if (vFull >= t.cost * x && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.sym} 到 ${x} 倍了！（${cTxt}，现在持仓约 ${v.toFixed(2)}U）\n照规则：${ruleTxt()}`); }
    if (t.sellNow) { if (!st.sellNowDone) { if (await sell(t, st, bal, '你指示全部卖出', W)) { st.sellNowDone = true; st.stage = 9; } } continue; }
    if (t0.tpsl && t.cost > 0 && !t.hold) { /* 用户自己设的止盈止损 */ const T = t0.tpsl; st.done2 = st.done2 || []; const xNow = vFull / t.cost;
      if (v > 0 && v >= ZR_MINV()) { /* 最小卖出金额＝你的设定 */
        const slNow = T.sl > 0 && xNow <= 1 - T.sl / 100; st.slHit = slNow ? (st.slHit || 0) + 1 : 0; const peakV = (st.ppeak || 0) * st.qty0; const trNow = T.trail > 0 && peakV > t.cost && px < st.ppeak * (1 - T.trail / 100); st.trHit = trNow ? (st.trHit || 0) + 1 : 0; /* 连续几次才算＝你的设定 sell.confirmN（没填＝1 次） */
        const tpL = (T.tp || []).find(([up]) => !st.done2.includes('tp' + up) && xNow >= 1 + up / 100); const hit = []; if (slNow && st.slHit >= ZR_CONF()) hit.push('sl'); if (trNow && st.trHit >= ZR_CONF()) hit.push('trail'); if (tpL) hit.push('tp');
        const pick = nrPickSell(hit, 'sell.order', st, `[${W.name}] ${t.sym}`); /* 卖出同时触发时照你排的顺序 */
        if (pick === 'sl') { if (await sell(t, st, bal, `止损：跌了 ${T.sl}% 以上，全部卖出（${cTxt}，现在约 ${v.toFixed(2)}U）`, W)) st.stage = 9; }
        else if (pick === 'trail') { if (await sell(t, st, bal, `追踪止损：从最高点回落 ${T.trail}%，全部卖出（约 ${v.toFixed(2)}U）`, W)) st.stage = 9; }
        else if (pick === 'tp') { const [up, pc] = tpL; if (await sell(t, st, (bal * BigInt(Math.round(pc))) / 100n, `止盈：涨 ${up}%，卖出 ${pc}%（持仓约 ${v.toFixed(2)}U）`, W)) { st.done2.push('tp' + up); if (pc >= 100) st.stage = 9; } }
      }
      st.last = { v, at: ts() }; continue;
    }
    if (!(t.cost > 0) || t.hold) { // 免费的、或使用者说先别卖的
      if (!st.basePx) st.basePx = px; // 免费币以开池后第一个价格当基准
      for (const x of ZR_LIST('notify.multX')) { const hit = t.hold && t.cost > 0 ? vFull >= t.cost * x : px >= st.basePx * x; /* 通知倍数＝你的设定 notify.multX（没开＝不通知） */ if (hit && !st.notified.includes(x)) { st.notified.push(x); await tg(`🔥 [${W.name}] ${t.hold ? '' : '免费币 '}${t.sym} 涨到${t.hold ? '成本' : '开池价'}的 ${x} 倍！市值约 ${v.toFixed(2)}U\n${t.hold ? '你说先别卖，要卖在 TG 打「卖 ' + t.sym + '」' : (Number.isFinite(RULE.drop) ? '从最高价回落 ' + Math.round(RULE.drop * 100) + '% 会自动全卖；' : '你没开「免费币回落自动卖」，不会自动卖；') + '想先卖在 TG 打「卖 ' + t.sym + '」'}`); } }
      if (st.openAt && now - st.openAt >= (RULE.dropWaitMin || 0) * 60e3 && px > (st.fpp || 0)) st.fpp = px; /* 开池后几分钟才开始算最高价＝你的设定 */
      const dropNow = !t.hold && st.fpp > 0 && px < st.fpp * (1 - RULE.drop) && v > 0 && v >= ZR_MINV(); st.dropHit = dropNow ? (st.dropHit || 0) + 1 : 0; /* 连续几次才算＝你的设定 */
      if (dropNow && st.dropHit >= ZR_CONF()) { // 免费币从最高价回落（你设的 sell.freeDrop）全卖
        if (await sell(t, st, bal, `免费币从最高价回落 ${Math.round(RULE.drop * 100)}%，全部卖出（约 ${v.toFixed(2)}U）`, W)) { st.stage = 9; continue; }
      }
      if (t.hold && Number.isFinite(RULE.drop) && px < st.ppeak * (1 - RULE.drop) && st.dropWarnedPeak !== st.ppeak) { st.dropWarnedPeak = st.ppeak; await tg(`⚠️ [${W.name}] ${t.sym} 从最高价回调 ${Math.round(RULE.drop * 100)}%，现在约 ${v.toFixed(2)}U\n你说先别卖，不会自动卖，要卖在 TG 打「卖 ${t.sym}」`); }
      st.last = { v, at: ts() }; continue;
    }
    if (!(v > 0) || v < ZR_MINV()) { st.last = { v, at: ts() }; continue; } /* 低于你设的最小卖出金额不卖（没设＝只要有价值就照规则） */
    st.done2 = st.done2 || [];
    const backDone = st.done2.includes('back');
    if (backDone && st.moonPend && RULE.moonPct) { st.moon = ((bal * BigInt(Math.max(0, Math.min(100, Math.round(RULE.moonPct))))) / 100n).toString(); delete st.moonPend; log(`[${W.name}] ${t.sym} 回本后留 ${RULE.moonPct}% 长抱（不自动卖${ZR_LIST('notify.moonX').length ? '，' + ZR_LIST('notify.moonX').join('／') + ' 倍通知' : ''}）`); }
    const moon = backDone && st.moon ? BigInt(st.moon) : 0n; const freeAmt = bal > moon ? bal - moon : 0n;
    if (moon > 0n && freeAmt === 0n) { /* 只剩长抱那份：不自动卖，通知倍数＝你的设定 notify.moonX */
      for (const x of ZR_LIST('notify.moonX')) if (vFull >= t.cost * x && !st.done2.includes('m' + x)) { st.done2.push('m' + x); await tg(`🔥 [${W.name}] ${t.sym} 长抱那份到 ${x} 倍了！（${cTxt}，现在约 ${v.toFixed(2)}U）\n照设定不自动卖，要卖在 TG 打「卖 ${t.sym}」或「卖 ${t.sym} 一半」`); }
      st.last = { v, at: ts() }; continue;
    }
    const crash = backDone ? RULE.crashAfterBack : RULE.crash; /* 回本前／回本后各照你的设定，没开就不卖 */
    const crashNow = st.ppeak > 0 && px < st.ppeak * (1 - crash); st.crashHit = crashNow ? (st.crashHit || 0) + 1 : 0; /* 连续几次才算＝你的设定 */
    const stepL = RULE.steps.find(([x]) => !st.done2.includes('s' + x) && vFull >= t.cost * x); const hit = []; if (crashNow && st.crashHit >= ZR_CONF()) hit.push('crash'); if (!backDone && vFull >= t.cost * RULE.backX) hit.push('back'); if (stepL) hit.push('steps');
    const pick = nrPickSell(hit, 'sell.order', st, `[${W.name}] ${t.sym}`); /* 卖出同时触发时照你排的顺序 */
    if (pick === 'crash') {
      if (await sell(t, st, moon > 0n ? freeAmt : bal, `从最高价回落 ${Math.round(crash * 100)}%，${moon > 0n ? `卖出长抱以外的部分（留 ${RULE.moonPct}% 长抱）` : '全部卖出'}（约 ${v.toFixed(2)}U）`, W)) { if (!(moon > 0n)) st.stage = 9; }
    } else if (pick === 'back') {
      const pct = Math.min(100, Math.ceil((t.cost / v) * 100 * (1 + (nrNum('sell.backFeePct') ?? 0) / 100))); /* 多卖几 % 补手续费＝你的设定（没开＝刚好成本） */
      if (await sell(t, st, (bal * BigInt(pct)) / 100n, `到 ${RULE.backX} 倍，卖 ${pct}% 拿回本钱 ${t.cost}U（持仓约 ${v.toFixed(2)}U）`, W)) { st.done2.push('back'); if (pct < 100) st.moonPend = 1; }
    } else if (pick === 'steps') { const [x, pc] = stepL; if (await sell(t, st, ((moon > 0n ? freeAmt : bal) * BigInt(Math.max(1, Math.min(100, Math.round(pc))))) / 100n , `到 ${x} 倍，卖出 ${pc}%${moon > 0n ? '（长抱那份不动）' : ''}（持仓约 ${v.toFixed(2)}U）`, W)) st.done2.push('s' + x); }
    st.last = { v, fresh5, swaps5, swapsPrev5, at: ts() };
  }
}

// ---------- 新的 Agent ID 专属铸造 ----------
const CANDS = [['mint()', '0x1249c58b'], ['freeMint()', '0x5b70ea9f'], ['claim()', '0x4e71d92d'], ['mint(1)', '0xa0712d68' + w(1)], ['publicMint()', '0x26092b83'], ['commitFreeMint()', '0x74d04cfc'], ['registerForRewards()', '0x9f92d0dd'], ['freeMint(1)', '0x7c928fe9' + w(1)], ['claim(1)', '0x379607f5' + w(1)], ['mintFree()', '0x8ab53447'], ['claimFree()', '0xf366afc9'], ['agentMint()', '0x1be3587a']];
// ---- keccak256（算 CREATE2 地址用）----
const KRC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const KROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M64 = (1n << 64n) - 1n; const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakHex(hex) {
  const msg = Buffer.from(hex, 'hex'); const rate = 136; const padLen = rate - (msg.length % rate); const p = Buffer.concat([msg, Buffer.alloc(padLen)]); p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[y + x] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], KROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= KRC[r];
    }
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8); return out.toString('hex');
}
const DEPLOYERS = ['0x4e59b44847b379578588920ca78fbf26c0b4956c', '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed', '0x0000000000ffe8b47b3e2130213b802212439497', '0x914d7fec6aac8cd542e72bca78b30650d45643d7'];

// ---------- 聪明钱包：之前赚钱项目（JAGENT/SWARM/BIBIAI/BNBS…）最早去打的 Agent ID 钱包；他们一动手就提早检查 ----------
const WINNERS = ['0x8e6442663a4f8c50b6132c68d42a30e7dfe4ae15', '0x04fd77c2f97d044b3c719282fd0a0568f4254afa', '0x415aac3e46264c046d103c994a1da71f05c547f9', '0x171f264f938d55d968afc5d6b133c4157a61f05f'];
let SMART = new Set(S.smart || []);
async function buildSmart() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16); const cnt = {};
  for (const a of WINNERS) {
    try {
      const has = async (b) => (((await rpc('eth_getCode', [a, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
      let lo = head - 400000, hi = head; if (await has(lo)) continue;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
      const tos = [];
      for (let f = hi; f < Math.min(head, hi + 60000) && tos.length < 300; f += 3000) {
        const logs = await rpc('eth_getLogs', [{ address: a, fromBlock: '0x' + f.toString(16), toBlock: '0x' + (f + 2999).toString(16), topics: [T_TRANSFER, '0x' + '0'.repeat(64)] }]).catch(() => []);
        for (const l of logs || []) { const t = '0x' + l.topics[2].slice(26); if (!tos.includes(t)) tos.push(t); if (tos.length >= 300) break; }
      }
      for (const t of tos) cnt[t] = (cnt[t] || 0) + 1;
    } catch (e) { log('smart ' + a + ' ' + e.message); }
  }
  for (const W of WALLETS) delete cnt[W.addr];
  const sN = nrOn('smart.auto') ? nrNum('smart.autoN') : null; if (sN == null) { SMART = new Set(); S.smart = []; return; } /* 没开＝不自动产生聪明钱名单 */ const list = Object.entries(cnt).filter(([, c]) => c >= sN).map(([t]) => t);
  if (list.length) { SMART = new Set(list); S.smart = list; S.smartAt = Date.now(); log(`聪明钱包名单更新：${list.length} 个`); }
}

// ---------- 保险：同一个合约短时间被很多钱包呼叫（像奶宝龙开打）→ 立刻检查是不是 Agent ID 专属 ----------
const HOT = new Map(), hotChecked = new Map();
/* 「是不是 Agent ID 项目」——事实：合约码里有 Agent ID 登记合约就是。没写的：只有你开了 disc.agentShare，
   才看打它的钱包（取样 disc.sampleN 个，空白＝全部）持有 Agent ID 的比例有没有到你填的 disc.agentSharePct %；没开＝不算 Agent ID 项目 */
async function agShare(addrs) { const pct = nrOn('disc.agentShare') ? nrNum('disc.agentSharePct') : null; const sn = nrNum('disc.sampleN'); const L = [...addrs].filter((a) => /^0x[0-9a-f]{40}$/.test(a)).slice(0, sn != null && sn >= 1 ? Math.round(sn) : undefined); if (pct == null || !L.length) return { ok: false, n: 0, of: 0, share: null };
  const res = await rpcBatch(L.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); let n = 0, of = 0;
  L.forEach((a, i) => { const r = res[i]; if (r === undefined) return; of++; const y = !!r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n; agentCache.set(a, y); if (y) n++; });
  return { ok: of > 0 && (n / of) * 100 >= pct, n, of, share: of ? n / of : null }; }
const discMin = () => { const x = nrNum('disc.minWallets'); return x != null && x >= 1 ? x : 1; }; /* 至少几个不同钱包才去检查（空白＝1 个） */
const DISC_PER_ROUND = 30; /* 运作：每轮最多检查几个（节点额度），没轮到的照钱包数排队、下一轮继续，不会丢 */
const DISC_RECHECK_MS = 600e3; /* 运作：没确认是 Agent ID 项目的，隔这么久、而且打它的钱包变多了，才再查一次 */
globalThis.DISC_Q = 0;

const noLink = (x) => String(x || '').replace(/https?:\/\/\S+|www\.\S+|\b[\w-]+\.(xyz|com|io|org|net|app|online|fun|site|top|cc|me|link|vip|pro|club|live|info)\b\S*/gi, '[连结已移除]').slice(0, 160); 
const DEX_SEL = /^0x(7ff36ab5|18cbafe5|38ed1739|8803dbee|fb3bdb41|4a25d94a|5c11d795|b6f9de95|791ac947|ded9382a|5b0d5984|e8e33700|f305d719|baa2abde|02751cec|af2979eb|04e45aaf|414bf389|c04b8d59|db3e2198|f28c0498|472b43f3|b858183f|09b81346|5ae401dc|ac9650d8|1f0464d1|3593564c|24856bc3|12aa3caf|0502b1c5|e449022e)/; /* 事实：PancakeSwap／Uniswap V2・V3、通用路由、1inch 的换币／加减流动性函式（不是铸造） */
const INSC = new Map(); 
const AGH = new Map(); 
const AG_SKIP = new Set(['0x55d398326f99059ff775485246999027b3197955', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x10ed43c718714eb63d5aa57b78b54704e256024e', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', '0x1a0a18ac4becddbd6389559687d1a73d8927e416', '0xca11bde05977b3631167028862be2a173976ca11', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0xe9e7cea3dedca5984780bafc599bd69add087d56', '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', '0x2170ed0880ac9a755fd29b2688956bd959f933f8', '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82']); /* USDT、WBNB、路由、Multicall、BUSD、FDUSD、USDC、BTCB、ETH、CAKE */
function agNote(t) { try {
  if (!t.to || !t.from) return; const inp = (t.input || '0x').toLowerCase(); const sel = inp.slice(0, 10); const from = t.from.toLowerCase(); let tok = t.to.toLowerCase();
  if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d)/.test(sel)) return;
  const pw = { '0x7ff36ab5': 1, '0xb6f9de95': 1, '0xfb3bdb41': 1, '0x38ed1739': 2, '0x5c11d795': 2, '0x8803dbee': 2 }[sel];
  if (pw) { const off = parseInt(inp.slice(10 + pw * 64, 10 + pw * 64 + 64), 16) * 2; const n = parseInt(inp.slice(10 + off, 10 + off + 64), 16); if (!(n >= 2 && n <= 5)) return; tok = '0x' + inp.slice(10 + off + 64 * n + 24, 10 + off + 64 * n + 64); }
  if (AG_SKIP.has(tok) || INFRA.has(tok)) return;
  let m = AGH.get(tok); if (!m) { if (AGH.size > 30000) return; m = new Map(); AGH.set(tok, m); } m.set(from, Date.now());
} catch {} }
function countHot(txs) {
  for (const t of txs) agNote(t);
  const now = Date.now(); if (!SMART.size && S.smart?.length) SMART = new Set(S.smart);
  for (const t of txs) {
    { const inp = (t.input || '').toLowerCase(); if (inp.startsWith('0x646174613a') && inp.length < 4000) { let txt = ''; try { txt = Buffer.from(inp.slice(2), 'hex').toString('utf8'); } catch {} const tick = (txt.match(/"tick"\s*:\s*"([^"]{1,40})"/i) || [])[1]; const p = (txt.match(/"p"\s*:\s*"([^"]{1,30})"/i) || [])[1] || ''; const k = tick ? `${p}:${tick}`.toLowerCase() : 'to:' + String(t.to || '').toLowerCase(); let h = INSC.get(k); if (!h || now - h.at > 180e3) { h = { from: new Set(), at: now, to: String(t.to || '').toLowerCase(), sample: txt.slice(0, 160) }; INSC.set(k, h); } h.from.add(String(t.from).toLowerCase()); if (INSC.size > 5000) for (const [kk, hh] of INSC) if (now - hh.at > 180e3) INSC.delete(kk); continue; } }
    const recv = (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n; // 直接转 BNB 就铸（像 BNBS）
    if (!t.to) continue; { const mx = nrNum('disc.maxCallBnb'); if (mx != null && Number(BigInt(t.value || '0x0')) / 1e18 > mx) continue; } /* 呼叫金额上限＝你的设定（空白＝不限） */ if (DEX_SEL.test(t.input || '')) continue; // 呼叫金额上限只看你的 disc.maxCallBnb
    if (/^0x(a9059cbb|095ea7b3|23b872dd|d0e30db0|2e1a7d4d|39509351|a457c2d7)/.test(t.input || '')) continue; // 转帐、授权、存取这类不是铸造
    const k = t.to.toLowerCase(); let h = HOT.get(k); if (!h) { h = { from: new Set(), at: now, sel: new Map() }; HOT.set(k, h); }
    if (now - h.at > 180e3) { h.from.clear(); h.at = now; h.sel.clear(); h.smart = new Set(); h.vals = new Map(); }
    if (SMART.has(t.from.toLowerCase())) (h.smart = h.smart || new Set()).add(t.from.toLowerCase());
    h.from.add(t.from.toLowerCase()); const sl = (t.input || '').slice(0, 10); h.sel.set(sl, (h.sel.get(sl) || 0) + 1); if (recv) { h.vals = h.vals || new Map(); const vv = BigInt(t.value).toString(); h.vals.set(vv, (h.vals.get(vv) || 0) + 1); }
  }
  if (HOT.size > 20000) for (const [k, h] of HOT) if (now - h.at > 180e3) HOT.delete(k);
}
// ---------- 第三道保险：直接看「铸造事件」（不管合约怎么部署、付多少钱）----------
// 每个区块所有 Transfer(from=0x0) 都看：同一个代币／NFT 短时间内被铸给很多不同钱包（几个＝你的发现设定）→ 找出大家呼叫的合约 → 判断是不是 Agent ID 专属 → 照规则打
const MINTS = new Map(), mintChecked = new Map();
const ZERO32 = '0x' + '0'.repeat(64);
async function mintLogs(from, to) {

  try { const r = await (await fetch('https://bsc.drpc.org', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [T_TRANSFER, ZERO32] }] }), signal: AbortSignal.timeout(10000) })).json(); if (Array.isArray(r.result)) return r.result; } catch {}

  const out = [], nodes = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc-dataseed1.ninicoin.io', 'https://bsc-rpc.publicnode.com'];
  await Promise.all(Array.from({ length: to - from + 1 }, (_, i) => from + i).map(async (b, i) => {
    for (let k = 0; k < nodes.length; k++) { try { const r = await (await fetch(nodes[(i + k) % nodes.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockReceipts', params: ['0x' + b.toString(16)] }), signal: AbortSignal.timeout(12000) })).json(); if (Array.isArray(r.result)) { for (const rc of r.result) for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics[1] === ZERO32 && l.topics[2]) out.push(l); return; } } catch {} }
  }));
  return out;
}
async function fullCode(c, code) { /* 代理合约一律追到背后的真正程式——EIP-1967、Beacon 槽位、程式里写死的 Beacon／实作地址、最小代理（EIP-1167） */
  code = String(code || '').toLowerCase(); if (code.length < 4 || code.length >= 4000 || code.includes(REGISTRY)) return code;
  const add = async (a) => { const x = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || '').toLowerCase(); code += x; return x; };
  try { const impl = await rpc('eth_getStorageAt', [c, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (impl && BigInt(impl) !== 0n) await add('0x' + impl.slice(-40)); } catch {}
  try { const bc = await rpc('eth_getStorageAt', [c, '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', 'latest']); if (bc && BigInt(bc) !== 0n) { const r = await call('0x' + bc.slice(-40), '0x5c60da1b'); if (r && BigInt(r) !== 0n) await add('0x' + r.slice(-40)); } } catch {}
  const emb0 = []; { const h = code.replace(/^0x/, '').slice(0, 1200); const m1167 = h.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af4/); if (m1167) emb0.push('0x' + m1167[1]); for (let i = 0; i + 42 <= h.length; i += 2) { const op = h.slice(i, i + 2); if (op === '73') { emb0.push('0x' + h.slice(i + 2, i + 42)); i += 40; } else if (op === '7f') { const wv = h.slice(i + 2, i + 66); if (/^0{24}/.test(wv)) emb0.push('0x' + wv.slice(24)); i += 64; } else { const n = parseInt(op, 16); if (n >= 0x60 && n <= 0x7f) i += (n - 0x5f) * 2; } } } 
  const emb = [...new Set(emb0)].filter((a) => !/^0x0{40}$/.test(a) && a.length === 42).slice(0, 3);
  for (const a of emb) { if (code.includes(REGISTRY)) break; const r = await call(a, '0x5c60da1b'); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) !== 0n) await add('0x' + r.slice(-40)); else await add(a); }
  return code;
}
async function mintScan(head) {
  if (!S.mintBlock || head - S.mintBlock > 300) S.mintBlock = head - 5;
  const to = Math.min(head, S.mintBlock + 60); if (to <= S.mintBlock) return;
  const logs = await mintLogs(S.mintBlock + 1, to); S.mintBlock = to;
  const now = Date.now();
  for (const l of logs) {
    const a = l.address.toLowerCase(); let m = MINTS.get(a); if (!m) { m = { at: now, to: new Set(), txs: [] }; MINTS.set(a, m); }
    if (now - m.at > 1800e3) { m.at = now; m.to.clear(); m.txs = []; } // 累计（慢热的项目也抓得到；看多久＝你的设定）
    m.to.add('0x' + l.topics[2].slice(26)); if (m.txs.length < 8) m.txs.push(l.transactionHash);
  }
  if (MINTS.size > 30000) for (const [k, m] of MINTS) if (now - m.at > 1800e3) MINTS.delete(k);
  { const q = [...MINTS].filter(([a, m]) => !S.seenMints[a] && m.to.size >= discMin() && (!mintChecked.has(a) || (m.to.size > mintChecked.get(a).n && Date.now() - mintChecked.get(a).t > DISC_RECHECK_MS))).sort((x, y) => y[1].to.size - x[1].to.size); globalThis.DISC_Q = Math.max(0, q.length - DISC_PER_ROUND);
  for (const [a, m] of q.slice(0, DISC_PER_ROUND)) { /* 照钱包数多的先查；没轮到的排队（不丢） */
    mintChecked.set(a, { n: m.to.size, t: Date.now() }); if (mintChecked.size > 20000) mintChecked.delete(mintChecked.keys().next().value);
    await checkMinted(a, m).catch((e) => log('mintScan ' + a + ' ' + e.message));
  } }
}
const CLAIM = new Set();
async function checkMinted(tok, m) {
  // 找出大家实际呼叫的合约（铸造合约可能跟代币合约不同）
  const txs = (await Promise.all(m.txs.slice(0, 6).map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter(Boolean);
  const cnt = {}; for (const t of txs) if (t.to) cnt[t.to.toLowerCase()] = (cnt[t.to.toLowerCase()] || 0) + 1;
  const target = Object.entries(cnt).sort((x, y) => y[1] - x[1])[0]?.[0]; if (!target) return;
  if (S.seenMints[target] || S.seenMints[tok] || CLAIM.has(target)) return; CLAIM.add(target); // 同一个合约只让一个流程处理，避免重复打
  // 是不是 Agent ID 专属：合约码有登记合约，或铸到的钱包六成以上有 .ai 身份
  let code = ((await rpc('eth_getCode', [target, 'latest']).catch(() => '')) || '').toLowerCase();
  code = await fullCode(target, code);
  const tcode = tok === target ? code : ((await rpc('eth_getCode', [tok, 'latest']).catch(() => '')) || '').toLowerCase();
  let gated = code.includes(REGISTRY) || tcode.includes(REGISTRY), share = 0;
  if (!gated) { /* 合约没写 Agent ID 检查 → 只有你开了 disc.agentShare 才看打它的钱包 */
    const A = await agShare(m.to); share = A.share || 0; if (!A.ok) { CLAIM.delete(target); log(`铸造监测：${target} 合约里没有 Agent ID 检查${A.of ? `，打它的钱包 ${A.n}/${A.of} 持有 Agent ID` : ''}${nrOn('disc.agentShare') ? '（没到你设的比例）' : '（你没开「用打它的钱包判断」）'}，不当成 Agent ID 项目`); return; }
    gated = true;
  }
  if (INFRA.has(target) || INFRA.has(tok)) return; // Agent ID 登记合约本身不是项目
  S.seenMints[target] = ts(); S.seenMints[tok] = ts();
  const name = tokStr(await call(tok, '0x06fdde03')) || tokStr(await call(target, '0x06fdde03'));
  // 先试常见免费函式；不行就「照别人的呼叫内容重播」（不含别人地址的才重播）
  let minted = '';
  const sampleTx = txs.find((t) => t.to && t.to.toLowerCase() === target);
  for (const W of WALLETS) {
    let ff = await findFree(W.addr, target, code);
    if (!ff && sampleTx && sampleTx.input.length >= 10 && !badSel(sampleTx.input) && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase())) {
      for (const v of nearFree()) { try { await rpc('eth_call', [{ from: W.addr, to: target, data: sampleTx.input, value: '0x' + v.toString(16) }, 'latest']); const nm = '重播' + sampleTx.input.slice(0, 10) + '@' + target.slice(2, 10); if (!CANDS.some((c) => c[0] === nm)) CANDS.push([nm, sampleTx.input]); ff = { n: nm, v }; break; } catch {} }
    }
    if (ff) minted += `[${W.name}] ` + queueMint(target, ff.n, W, ff.v) + '\n';
  }
  if (!minted) {
    S.paid = S.paid || {};
    const val = sampleTx ? BigInt(sampleTx.value || '0x0') : 0n;
    const noAddr = sampleTx && !sampleTx.input.toLowerCase().includes(sampleTx.from.slice(2).toLowerCase());
    S.paid[target] = { at: Date.now(), name, done: {}, wallets: m.to.size, ...((sampleTx?.input || '0x') === '0x' && val > 0n ? { recvValue: val.toString(), recvSeen: m.to.size } : {}), ...(noAddr && sampleTx.input !== '0x' && !badSel(sampleTx.input) ? { replay: { data: sampleTx.input, value: val.toString() } } : {}) };
  }
  await tg(`🔥 发现正在被铸造的 Agent ID 项目${name ? '：' + name : ''}（最近铸给 ${m.to.size} 个钱包${share ? `，${Math.round(share * 100)}% 有 .ai 身份` : ''}）\n${target}\n${minted || '⚪ 不是免费的 → 已加入追踪，打不打照你的条件'}`);
}

async function inscScan() { /* 热门铭文：通知＝你的 notify.insc／notify.inscMin（铭文不自动打） */
  S.inscNoted = S.inscNoted || {};
  for (const [k, h] of INSC) {
    if (!nrOn('notify.insc') || (nrNum('notify.inscMin') != null && h.from.size < nrNum('notify.inscMin')) || S.inscNoted[k]) continue; /* 铭文通知＝你的设定 */
    const A = await agShare(h.from); const n = A.n, sample = { length: A.of || 0 };
    S.inscNoted[k] = ts(); const ks = Object.keys(S.inscNoted); if (ks.length > 2000) delete S.inscNoted[ks[0]];
    if (nrNum('notify.inscMin') == null) nrDecSkip('insc', k, k, '（注明）「铭文通知最少几个钱包」没填＝不设门槛'); /* RVFIX 7 */ if (nrOn('disc.agentShare') && !A.ok) { log(`铭文 ${k}：${h.from.size} 个钱包在写，持有 Agent ID ${n}/${sample.length}（没到你设的比例），不通知`); continue; }
    log(`🔥 热门铭文：${k}（${h.from.size} 个钱包${sample.length ? `，${n}/${sample.length} 持有 Agent ID` : ''}）`);
    await tg(`🔥 热门 Agent ID 铭文：${k.replace(/^to:/, '送到 ')}\n最近 ${h.from.size} 个钱包在写${sample.length ? `，其中 ${n}/${sample.length} 持有 Agent ID` : ''}\n内容范例：${noLink(h.sample)}\n铭文工具不会自动打，要的话请自己手动`);
  }
}
async function hotScan() {
  inscScan().catch((e) => log('inscScan ' + e.message));
  const q = [...HOT].filter(([c, h]) => !INFRA.has(c) && !CLAIM.has(c) && !S.seenMints[c] && h.from.size >= discMin() && (!hotChecked.has(c) || (h.from.size > hotChecked.get(c).n && Date.now() - hotChecked.get(c).t > DISC_RECHECK_MS))).sort((x, y) => y[1].from.size - x[1].from.size); globalThis.DISC_Q = (globalThis.DISC_Q || 0) + Math.max(0, q.length - DISC_PER_ROUND);
  for (const [c, h] of q.slice(0, DISC_PER_ROUND)) { /* 门槛＝你的 disc.minWallets；照钱包数排队 */
    CLAIM.add(c); hotChecked.set(c, { n: h.from.size, t: Date.now() }); if (hotChecked.size > 5000) hotChecked.delete(hotChecked.keys().next().value);
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase();
    code = await fullCode(c, code);
    let viaAgents = 0;
    if (!code.includes(REGISTRY)) {
      // 合约码里没有 Agent ID 登记合约（可能用后端签名验证，像灯笼镇、Silicon Dreamers）→ 改看「打它的人是不是大多持有 Agent ID」
      if (code.length <= 2) { CLAIM.delete(c); continue; } /* 事实：没有合约程式码 */
      const A = await agShare(h.from); if (!A.ok) { CLAIM.delete(c); continue; } /* 只有你开了 disc.agentShare 才用打它的钱包判断 */
      viaAgents = A.share;
    }
    S.seenMints[c] = ts();
    const name = tokStr(await call(c, '0x06fdde03'));
    // 热门呼叫的函式也加入候选（不在 CANDS 里的铸造函式名）
    const topSel = [...h.sel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    let minted = '';
    for (const W of WALLETS) {
      let ff = await findFree(W.addr, c, code);
      if (!ff && topSel && topSel.length === 10 && !badSel(topSel)) for (const v of nearFree()) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: topSel, value: '0x' + v.toString(16) }, 'latest']); { const nm = '热门函式' + topSel + '@' + c.slice(2, 10); if (!CANDS.some((x) => x[0] === nm)) CANDS.push([nm, topSel]); ff = { n: nm, v }; } break; } catch {} }
      if (ff) minted += `[${W.name}] ` + queueMint(c, ff.n, W, ff.v) + '\n';
    }
    if (!minted) {
      S.paid = S.paid || {};
      // 转 BNB 就铸的：取大家最常转的金额当「一份的价格」
      const top = [...(h.vals || new Map()).entries()].sort((a, b) => b[1] - a[1])[0];
      S.paid[c] = { at: Date.now(), name, done: {}, wallets: h.from.size, ...(top && nrNum('bsc.learnMinN') != null && top[1] >= nrNum('bsc.learnMinN') ? { recvValue: top[0], recvSeen: top[1] } : {}) }; /* 几笔一样的金额才当「一份的价格」＝你的 bsc.learnMinN（空白＝最常见的那个） */
    }
    await tg(`🔥 发现正在被抢打的 Agent ID 项目${name ? '：' + name : ''}${viaAgents ? `（合约没写 Agent ID 检查，但打它的钱包 ${Math.round(viaAgents * 100)}% 持有 .ai 身份，可能是后端签名验证）` : ''}（最近 ${h.from.size} 个钱包${h.smart?.size ? '，其中聪明钱包 ' + h.smart.size + ' 个' : ''}）\n${c}\n${minted || '⚪ 不是免费的 → 已加入追踪，打不打照你的条件'}\nhttps://bscscan.com/address/${c}`);
  }
}

const BG = []; let bgRun = 0; // 背景工作伫列（最多同时 3 个）
function bgJob(fn) { BG.push(fn); pumpBG(); }
function pumpBG() { while (bgRun < 3 && BG.length) { const f = BG.shift(); bgRun++; f().catch((e) => log('bg ' + e.message)).finally(() => { bgRun--; pumpBG(); }); } }
async function scanNew(head) {
  if (!S.lastBlock) S.lastBlock = head - 5;
  if (head - S.lastBlock > 1500) { log(`扫描落后太多（${head - S.lastBlock} 块），跳到最新`); S.lastBlock = head - 200; }

  const to = Math.min(head, S.lastBlock + 400);
  const nums = []; for (let b = S.lastBlock + 1; b <= to; b++) nums.push(b);
  const blocks = new Map(); let idx = 0;
  const fetchBlk = async (b) => { for (let k = 0; k < RPCS.length; k++) { const u = RPCS[(b + k) % RPCS.length]; try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] }), signal: AbortSignal.timeout(15000) })).json(); if (r.result) return r.result; } catch {} } return null; };
  await Promise.all(Array.from({ length: 24 }, async () => { while (idx < nums.length) { const b = nums[idx++]; const blk = await fetchBlk(b); if (blk) { countHot(blk.transactions); } if (blk) blocks.set(b, blk.transactions.filter((t) => !t.to || ((t.input || '').length > 2000 && ((t.input || '').toLowerCase().includes(REGISTRY) || DEPLOYERS.includes(t.to.toLowerCase()))))); else blocks.set(b, null); } }));
  let done = S.lastBlock;
  for (const b of nums) { if (blocks.get(b) == null) break; done = b; }
  if (done === S.lastBlock && nums.length) { log('scan 抓区块失败 ' + nums[0]); return; }
  S.scanLag = head - done;
  for (let b = S.lastBlock + 1; b <= done; b++) {
    for (const tx of blocks.get(b) || []) {
      // 新合约有三种出生方式：①直接部署 ②透过 CREATE2 部署器（灯笼镇就是这种）③由别的工厂合约建立
      const inp = (tx.input || '').toLowerCase();
      if (tx.to && !(inp.length > 2000 && (inp.includes(REGISTRY) || DEPLOYERS.includes(tx.to.toLowerCase())))) continue;
      let cs = [];
      try {
        if (!tx.to) { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.contractAddress) cs = [rc.contractAddress.toLowerCase()]; }
        else if (tx.to.toLowerCase() === '0x4e59b44847b379578588920ca78fbf26c0b4956c') { const salt = inp.slice(2, 66), init = inp.slice(66); cs = ['0x' + keccakHex('ff' + tx.to.slice(2).toLowerCase() + salt + keccakHex(init)).slice(24)]; }
        else { const rc = await rpc('eth_getTransactionReceipt', [tx.hash]); if (rc?.status !== '0x1') continue; const as = [...new Set((rc.logs || []).map((l) => l.address.toLowerCase()))]; for (const a of as) { const before = await rpc('eth_getCode', [a, '0x' + (b - 1).toString(16)]).catch(() => '0x'); if (!before || before === '0x') cs.push(a); } }
      } catch { continue; }
      for (const c of cs) try {
        if (S.seenMints[c]) continue;
        let code = (await rpc('eth_getCode', [c, 'latest'])) || '';
        code = await fullCode(c, code); /* 代理合约（各种写法）都追到背后真正的程式 */
        if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
        S.seenMints[c] = ts(); S.bornBlk = S.bornBlk || {}; S.bornBlk[c] = b; /* 合约在哪一块建立（往前找别人的铸造时找到这里就停） */ S.deployer = S.deployer || {}; S.deployer[c] = (tx.from || '').toLowerCase(); S.depFrom = S.depFrom || {}; S.depFrom[c] = S.deployer[c]; noteDev(S.deployer[c], c);
        bgJob(async () => {
        const ok = [];
        let feeV = 0n; { const ff = await findFree(ME, c, code); if (ff) { ok.push(ff.n); feeV = ff.v || 0n; } }
        const str = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; } };
        let name = str(await call(c, '0x06fdde03'));
        if (!name) for (const sel of ['0xfc0c546a']) { const r = await call(c, sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { const ta = '0x' + r.slice(26, 66); const n2 = str(await call(ta, '0x06fdde03')), s2 = str(await call(ta, '0x95d89b41')); if (n2) { name = `${n2}${s2 ? ' ($' + s2 + ')' : ''}`; break; } } }
        const lc = code.toLowerCase();
        const pay = lc.includes('55d398326f99059ff775485246999027b3197955') ? '要付 USDT' : lc.includes('8ac76a51cc950d9822d68b83fe1ad97b32cd580d') ? '要付 USDC' : '可能要付 BNB';
        const factoryLike = ['27cca59f', '7d38bb0d', '1737a4bd'].some((x) => code.includes(x)) || /(6c61756e6368|666163746f7279)/.test(code.toLowerCase());
        if (factoryLike) await tg(`🏗 发现疑似新的 Agent ID 发射台／工厂合约${name ? '：' + name : ''}\n${c}\n可能是像 ToshX、Flap Agent 这种平台，可以自己到 BscScan 查看`);
        let minted = '';
        for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
        if (!ok.length) { S.paid = S.paid || {}; S.paid[c] = { at: Date.now(), name, done: {} }; }
        await tg(`🆕 发现新的 Agent ID 专属合约${name ? '：' + name : ''}\n${c}\n${ok.length ? (feeV > 0n ? `⚠️ 模拟可以铸，但要付 ${Number(feeV) / 1e18} BNB 手续费 → 照规则当「付费项目」处理（不是免费）` : '✅ 模拟确认：免费可铸') + `（函数 ${ok.join('、')}）\n我们的处理：\n` + (minted || '（还没动作）\n') : `⚪ 现在不是免费的（${pay}，或还没开）→ 已加入追踪：\n· 免费 → 进度和 Agent ID 钱包数都达到门槛 → 自动打\n· 要付任何手续费 → 当付费：照你「付费铸造」的设定（金额、条件都是你填的）`}\nhttps://bscscan.com/address/${c}`);
        }); // 背景处理新合约（模拟、铸造、通知），扫描不用等
      } catch {}
    }
  }
  
  if (!globalThis._hsBusy) { globalThis._hsBusy = true; hotScan().catch((e) => log('hotScan ' + e.message)).finally(() => { globalThis._hsBusy = false; }); }
  if (!globalThis._msBusy) { globalThis._msBusy = true; mintScan(done).catch((e) => log('mintScan ' + e.message)).finally(() => { globalThis._msBusy = false; }); }
  { /* 代理合约扫描：被限流就换节点；全部被限流先暂停一下（技术用），之后从没扫到的区块补扫，不跳过 */
    S.proxyFrom = S.proxyFrom || S.lastBlock + 1; if (done - S.proxyFrom > 3000) S.proxyFrom = done - 3000;
    if (Date.now() > (globalThis._proxyPause || 0)) { const to = Math.min(done, S.proxyFrom + 500); try { await proxyScan(S.proxyFrom, to); S.proxyFrom = to + 1; globalThis._proxyFails = 0; } catch (e) { globalThis._proxyFails = (globalThis._proxyFails || 0) + 1; globalThis._proxyPause = Date.now() + 30e3; if (globalThis._proxyFails === 1 || globalThis._proxyFails % 20 === 0) log(`proxyScan 所有节点都被限流（第 ${globalThis._proxyFails} 次），暂停一下后补扫：${e.message.slice(0, 80)}`); } }
  }
  S.lastBlock = done;
}

// ---------- 工厂合约建出来的代理合约（像 AIDROP 金库）：用「代理升级」事件抓 ----------
const T_BEACON_UP = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e'; // BeaconUpgraded(address)
const T_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';  // Upgraded(address)
const implCache = new Map();
const VAULT_FACTORIES = ['0x90497450f2a706f1951b5bdda52b4e5d16f34c06']; // Flap 金库工厂（AIDROP 就是它建的）
const LOG_NODES = ['https://bsc-rpc.publicnode.com', 'https://bsc.blockpi.network/v1/rpc/public', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://binance.llamarpc.com', 'https://bsc.publicnode.com'];
let logNi = 0; const logBad = new Map();
async function logsRpc(params) { /* 查事件用的多节点轮替：某个节点被限流就暂时冷却、换下一个（技术用） */
  let last; for (let i = 0; i < LOG_NODES.length; i++) { const u = LOG_NODES[(logNi + i) % LOG_NODES.length]; if ((logBad.get(u) || 0) > Date.now()) continue;
    try { const r = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params }), signal: AbortSignal.timeout(12000) })).json(); if (r.error) throw new Error(r.error.message); if (!Array.isArray(r.result)) throw new Error('bad result'); logNi = (logNi + i) % LOG_NODES.length; return r.result; }
    catch (e) { last = e; logBad.set(u, Date.now() + 120e3); } }
  throw last || new Error('所有节点冷却中');
}
async function proxyScan(from, to) {
  if (to < from) return;
  // 公用节点不允许不带地址的 getLogs，所以盯 Flap 金库工厂：它每建一个新金库就有事件，再从那笔交易收据找新代理合约
  const fl = await logsRpc([{ address: VAULT_FACTORIES, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]);
  const txs = [...new Set((fl || []).map((l) => l.transactionHash))];
  const logs = [];
  for (const h of txs) { const rc = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); for (const l of rc?.logs || []) if (l.topics[0] === T_BEACON_UP || l.topics[0] === T_UPGRADED) logs.push(l); }
  for (const l of logs) {
    const c = l.address.toLowerCase(); if (S.seenMints[c]) continue;
    let impl = '0x' + l.topics[1].slice(26);
    if (l.topics[0] === T_BEACON_UP) { const r = await call(impl, '0x5c60da1b'); if (!r) continue; impl = '0x' + r.slice(-40); }
    if (!implCache.has(impl)) { const code = (await rpc('eth_getCode', [impl, 'latest']).catch(() => '')) || ''; implCache.set(impl, code); if (implCache.size > 500) implCache.delete(implCache.keys().next().value); }
    const code = implCache.get(impl);
    if (!code.toLowerCase().includes(REGISTRY) && !code.includes('9f92d0dd')) continue;
    S.seenMints[c] = ts();
    let minted = '';
    for (const W of WALLETS) { const ff = await findFree(W.addr, c, code); const f = ff?.n; if (f) minted += `[${W.name}] ` + queueMint(c, f, W, ff.v) + '\n'; }
    await tg(`🧩 发现工厂建立的 Agent ID 合约（代理合约，像 AIDROP 那种）\n${c}\n${minted || '⚪ 目前模拟不能免费参加（可能要付费或还没开）'}`);
  }
}

// ---------- 自动铸造（使用者要求开启）：只铸 0 元、无授权、不扣使用者任何资产的 ----------
// 「几乎免费」：有些项目要付一点防女巫手续费；要不要试、最多多少＝你的 bsc.nearFree／bsc.nearFreeBnb
const nearFree = () => { /* 要不要试「只收一点手续费」的铸造、最多多少＝你的设定；下面这串只是模拟时试的金额 */ const m = NR.on('bsc.nearFree') ? NR.num('bsc.nearFreeBnb') : null; if (m == null) return [0n]; const cap = BigInt(Math.round(m * 1e18)); const L = NEAR_FREE.filter((v) => v <= cap); if (!L.includes(cap)) L.push(cap); return L; };
const NEAR_FREE = [0n, 10n ** 14n, 22n * 10n ** 13n, 3n * 10n ** 14n, 5n * 10n ** 14n, 10n ** 15n];
const capOf = (c) => (FORCE.has(c) && Number(S.forceUsd?.[c]) > 0 ? Number(S.forceUsd[c]) : PAID.maxUsd); 
async function findFree(from, c, code) {
  for (const [n, d] of CANDS) { if (n.includes('@') && !n.endsWith('@' + c.slice(2, 10))) continue; if (n.includes('#') && !n.includes('#' + (WALLETS.find((x) => x.addr === from)?.name || '?') + '@')) continue; if (d.length < 10 || badSel(d) || !code.includes(d.slice(2, 10))) continue; /* 空呼叫（直接转 0 BNB）不算铸造 */ const dd = /重播|[熱热][門门]函式/.test(n) ? freshDeadline(d) : d; for (const v of nearFree()) { try { await rpc('eth_call', [{ from, to: c, data: dd, value: '0x' + v.toString(16) }, 'latest']); return { n, v }; } catch {} } }
  const W0 = WALLETS.find((x) => x.addr === from); /* 要带自己 Agent ID 编号的铸造：mint(编号)、claim(编号) */
  if (W0?.agentId) for (const sel of ['a0712d68', '379607f5', '6a627842']) { if (!code.includes(sel)) continue; const d = '0x' + sel + W0.agentId, n = `带Agent编号${sel}#${W0.name}@${c.slice(2, 10)}`; for (const v of nearFree()) { try { await rpc('eth_call', [{ from, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); if (!CANDS.some((x) => x[0] === n)) CANDS.push([n, d]); return { n, v }; } catch {} } }
  return null;
}
// 铸造排队：每个钱包一条队伍在背景跑（交易要一笔一笔送），不卡住扫描
const MQ = new Map();

const BAD_SEL = new Set(['0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde', '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6']);
const badSel = (d) => BAD_SEL.has(String(d || '').slice(0, 10).toLowerCase());
const freeNoted = new Map(); // 免费 mint 通知：同一个项目等两个钱包都打完，合成一则
function noteFree(c, W, name = '') { const first = !freeNoted.has(c); if (first) freeNoted.set(c, new Set()); freeNoted.get(c).add(W.name); if (first) setTimeout(async () => { const ok = freeNoted.get(c) || new Set(); freeNoted.delete(c); const nm = name || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10); await tg(`🆓 打了免费项目：${nm}（${WALLETS.map((x) => x.name + (ok.has(x.name) ? ' ✅' : ' ❌')).join('、')}）\n${c}`).catch(() => {}); }, 150e3); }
const MQK = new Set(); /* 同一个合约＋钱包同时只排一个铸造工作，避免重复打 */
const QLOG = {};
function queueMint(c, fname, W, v) {
  const qk = c + '|' + W.name; if (MQK.has(qk)) return '⏳ 已在排队中'; if (S.paid?.[c]?.done?.[W.name] && S.paid[c].done[W.name] !== 'pool-open') return '✅ 这个钱包已经打过';
  MQK.add(qk);
  const prev = MQ.get(W.name) || Promise.resolve();
  const job = prev.then(() => autoMintMax(c, fname, W, v)).finally(() => MQK.delete(qk)).then(async (m) => { if (m.startsWith('🤖') || ((__t2s) => __t2s.includes('结果不明') || __t2s.includes('結果不明'))(m)) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; S.paid[c].done[W.name] = m.startsWith('🤖') ? 'free' : 'unknown'; } else if (!m.startsWith('⏸') && !m.startsWith('✅')) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; } { const lk = c + '|' + W.name, mk = m.startsWith('⏸') ? m.replace(/[\d.]+/g, '#') : ''; QLOG[lk] = QLOG[lk] || {}; if (!mk || QLOG[lk].m !== mk || Date.now() - QLOG[lk].t > 3600e3) { QLOG[lk] = { m: mk, t: Date.now() }; log(`[${W.name}] ${c} ${m.replace(/\n/g, ' | ')}`); } } /* 同样的「先追踪」一小时只记一次，数字变了也不重复记 */ if (m.startsWith('🤖')) { S.freeTrack = S.freeTrack || {}; S.freeTrack[c] = S.freeTrack[c] || { at: Date.now() }; } if (m.startsWith('🤖')) noteFree(c, W); }).catch((e) => log(`[${W.name}] 铸造失败 ${c} ${e.message}`));
  MQ.set(W.name, job);
  return '⏳ 已排入检查（照规则决定打不打，结果会再通知）';
}

// 每个钱包可以打多份的（每钱包上限 >1），模拟还能过就继续打，最多 MAX_REPEAT 次
const MAX_REPEAT = () => { const v = NR.num('bsc.maxRepeat'); if (v == null) return 1; return Math.max(1, Math.floor(v)); }; /* RVFIX 7：同一个钱包免费的最多打几份＝你的设定；没填＝不加打免费份；要付钱的份数照 bsc.paidShares（判断日志会注明） */
async function autoMintMax(c, fname, W, val = 0n) { /* 免费的连打＝bsc.maxRepeat；要付钱的打几份＝bsc.paidShares（没填＝付费的不自动打） */
  const pN = NR.num('bsc.paidShares'); const pMax = pN == null ? null : Math.floor(pN);
  if (val > 0n && pMax == null) return `⏸ 还没填「付费铸造：每个钱包打几份」，这笔要付 ${Number(val) / 1e18} BNB，不自动打`;
  const d = Object.fromEntries(CANDS)[fname]; let first = await autoMint(c, fname, W, val), n = first.startsWith('🤖') ? 1 : 0, pc = n && val > 0n ? 1 : 0; if (n && NR.num('bsc.maxRepeat') == null) nrDecSkip('bsc', c, fname, '（注明）没填「每个钱包最多」，所以不加打免费份；要付钱的份数照「付费铸造：每个钱包打几份」' + (pMax == null ? '（没填＝付费的不自动打）' : '（' + pMax + ' 份）'));
  while (n > 0 && (n < MAX_REPEAT() || (pMax != null && pc < pMax))) {
    await sleep(6000);
    let v2 = null; if (n < MAX_REPEAT()) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x0' }, 'latest']); v2 = 0n; } catch {} }
    if (v2 == null) { /* 下一份要付钱：照你的 bsc.paidShares；金额只试你「几乎免费」设定里的金额 */
      if (pMax == null) { log(`[${W.name}] ${c} 下一份要付钱：还没填「付费铸造：每个钱包打几份」，不再连打`); break; }
      if (pc >= pMax) break;
      for (const v of nearFree()) { if (v <= 0n) continue; try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); v2 = v; break; } catch {} }
      if (v2 == null) break;
    }
    const m = await autoMint(c, fname, W, v2); if (!m.startsWith('🤖')) break; n++; if (v2 > 0n) pc++;
  }
  return n > 1 ? first + `\n（同一个钱包共打了 ${n} 份${pc ? '，其中付费 ' + pc + ' 份' : ''}）` : first;
}
const fpCache = new Map();
async function freeProgress(c) { /* 免费项目的进度：已铸造／总量；读不到回传 null（短暂快取，技术用） */
  const k = fpCache.get(c); if (k && Date.now() - k.t < 30e3) return k.p;
  let p = null; const decR = await call(c, '0x313ce567'); const isErc20 = !!(decR && decR.length >= 66 && BigInt(decR.slice(0, 66)) > 0n && BigInt(decR.slice(0, 66)) <= 36n); /* ERC20 常常一开始就全部发行，用「已发行÷总量」会误判成已铸完 */
  const tmR = isErc20 ? null : await call(c, '0xa2309ff8'); /* 先看「实际铸出数」totalMinted；totalSupply 会含项目方预留，只看它会把还没铸完的读成已铸完 */
  const tsR = isErc20 ? null : (tmR && tmR.length >= 66 ? tmR : await call(c, '0x18160ddd'));
  if (tsR && tsR.length >= 66) { const sup = Number(BigInt(tsR.slice(0, 66))); for (const sel of ['0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0xe985e367', '0xf1aee5a2', '0x0f2cdd6c', '0xa0e23ebd']) { const r = await call(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x >= sup && x < 1e15) { p = sup / x; break; } } } }
  if (p == null) { const code = (await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''; const pr = await progressOf(c, code.toLowerCase(), '').catch(() => ({})); if (pr.progress > 0) p = pr.progress; }
  fpCache.set(c, { t: Date.now(), p }); return p;
}
async function progressSweep() { /* 每分钟用轻量方式只读进度（每轮几个＝节点额度，照上次读的时间轮流），符合你「快速检查」设定的会移到快速名单 */
  const now = Date.now(); const list = Object.entries(S.paid || {}).filter(([c, P]) => !P.unmintable && (P.progress || 0) < 0.999 && trackOk(P) && !WALLETS.every((W) => P.done?.[W.name])).sort((x, y) => (x[1].sweepAt || 0) - (y[1].sweepAt || 0)).slice(0, 80);
  let i = 0; await Promise.all(Array.from({ length: 6 }, async () => { while (i < list.length) { const [c, P] = list[i++]; try { if (P.progAt && Date.now() - P.progAt < 180e3) { P.sweepAt = Date.now(); continue; } /* 正式检查刚读过的不覆盖（避免读法不同把已卖完的又拉回快速名单、占名额） */ let fp = null; if (P.soldSel) { /* bibiai AGENT ID 用「已售／总量」才读得到（已售 a2309ff8、总量 a0e23ebd），一般免费读法读不到 → 一直读成没进度、没回头看 */ const sr = await call(c, P.soldSel); const sold = sr && sr.length >= 66 ? Number(BigInt(sr.slice(0, 66))) : null; if (sold > 0) { if (P.capSel && capTimeSels().has(capSelK(P.capSel))) P.capSel = undefined; /*V104-CAPSANE：旧版记住的时间函式重找*/ if (P.capSel === undefined) P.capSel = (await findCapSel(c, await fullCode(c, await codeOf(c)).catch(() => ''), sold).catch(() => '')) || ''; if (P.capSel) { const cr = await call(c, '0x' + P.capSel); const cap = cr && cr.length >= 66 ? Number(BigInt(cr.slice(0, 66))) : 0; if (capOk(P.capSel, cap, sold, P, c)) fp = sold / cap; /*V104-CAPSANE*/ } } }
      if (fp == null) fp = await freeProgress(c); P.sweepAt = Date.now(); if (fp != null && fp > 0) { if (zrQuick(c, { ...P, progress: fp }) && !zrQuick(c, P) && !P.swLog) { P.swLog = 1; log(`进度扫描：${P.name || c} 进度 ${Math.round(fp * 100)}%，移到快速检查`); } if (!P.progAt || fp < 1) P.progress = fp; /* 读到多少记多少；粗读到已满不盖掉正式读法（正式检查会确认是否售罄） */ } } catch {} } }));
}
/* ①同名重发不打（几小时内算同名＝你的 bsc.cloneWinH）②免费铸造卡住就停（几小时没动＝你的 bsc.stallH）；开关预设关 */
const baseNm = (n) => String(n || '').replace(/\s*[（(]\s*\$?[^)）]*[)）]\s*$/, '').replace(/^\$/, '').trim().toLowerCase();
async function cloneStall(c, val = 0n) {
  const set = radarSet(); const P = S.paid?.[c]; const now = Date.now();
  { const pw = await preventWhy(c).catch(() => ''); if (pw) return pw; }
  const cwH = NR.num('bsc.cloneWinH'); if (NR.on('bsc.cloneSkip') && cwH != null) {
    let nm = P?.name || ''; if (!baseNm(nm) || /^([頻频]道[項项]目|搜寻项目)$/.test(nm)) { if (P && P.nm == null) P.nm = tokStr(await call(c, '0x06fdde03').catch(() => '')) || ''; nm = P?.nm || nm; }
    const b = baseNm(nm);
    if (b.length >= 2) { S.nameSeen = S.nameSeen || {}; const m = (S.nameSeen[b] = S.nameSeen[b] || {}); if (!m[c]) m[c] = P?.at || now;
      for (const [k, t] of Object.entries(m)) if (now - t > 2 * cwH * 3600e3) delete m[k]; /* 运作：记得的时间＝你填的「几小时内算同名」的两倍，够比对就好 */
      const mine = m[c]; const earlier = Object.entries(m).filter(([k, t]) => k !== c && t < mine && mine - t < cwH * 3600e3).length;
      if (earlier >= 1) return `同名「${b}」${cwH} 小时内已经出现过 ${earlier} 个合约（这是第 ${earlier + 1} 个，像在钓自动铸造）`; }
  }
  if (NR.on('bsc.stallSkip') && NR.num('bsc.stallH') != null && val === 0n && P && (P.progress || 0) > 0 && P.progress < 1) {
    if (P._lp !== P.progress) { P._lp = P.progress; P.pMoveAt = now; }
    if (P.pMoveAt && now - P.pMoveAt > NR.num('bsc.stallH') * 3600e3) return `免费铸造卡在 ${Math.floor(P.progress * 100)}% 超过 ${NR.num('bsc.stallH')} 小时没动`;
  }
  return '';
}
/* ①只信模拟 ②可升级合约不打 ③先小额试水 ④每日亏损保险丝 ⑤官方共享黑名单 */
const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const UPG = new Map();
function hasOp(code, op) { const h = String(code || '').replace(/^0x/, ''); for (let i = 0; i < h.length; i += 2) { const b = parseInt(h.substr(i, 2), 16); if (b === op) return true; if (b >= 0x60 && b <= 0x7f) i += (b - 0x5f) * 2; } return false; }
async function upgradable(a) {
  a = String(a || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return ''; const k = UPG.get(a); if (k && Date.now() - k.t < 3600e3) return k.r; let r = '';
  const UNK = '合约读不到，没办法确认是不是代理／可升级合约（你开着「可升级的合约不打」→ 这次不打，下一轮再查）'; /* 读不到≠安全，不记快取 */
  try { const code = String(await rpc('eth_getCode', [a, 'latest']) || '').toLowerCase(); if (code.length <= 2) return UNK;
    if (code.includes('363d3d373d3d3d363d73')) r = '代理合约（EIP-1167 复制品，背后的逻辑项目方可以换掉）';
    else { for (const sl of [EIP1967_IMPL, EIP1967_BEACON]) { const v = await rpc('eth_getStorageAt', [a, sl, 'latest']).catch(() => null); if (v == null || !/^0x[0-9a-f]*$/i.test(v)) return UNK; if (v.length > 2 && BigInt(v) > 0n) { r = sl === EIP1967_BEACON ? '信标代理合约（Beacon，项目方随时能换掉合约规则）' : '可升级合约（项目方随时能换掉合约规则）'; break; } } }
    if (!r && code.length < 600 && hasOp(code, 0xf4)) r = '代理合约（背后的逻辑项目方可以换掉）';
  } catch { return UNK; } UPG.set(a, { t: Date.now(), r }); return r;
}
const BL = { at: 0, c: new Set(), d: new Set() };
function blackOf(c) {
  if (Date.now() - BL.at > 60e3) { BL.at = Date.now(); try { const j = JSON.parse(readFileSync(join(DIR, 'data', 'blacklist.json'), 'utf8')); BL.c = new Set((j.c || []).map((x) => String(x).toLowerCase())); BL.d = new Set((j.d || []).map((x) => String(x).toLowerCase())); } catch {} }
  c = String(c || '').toLowerCase(); if (BL.c.has(c)) return '在官方黑名单（其他雷达回报过是诈骗）'; const dep = (S.depFrom || {})[c]; if (dep && BL.d.has(String(dep).toLowerCase())) return '部署者在官方黑名单'; return '';
}
async function preventWhy(c) {
  const set = radarSet();
  if (NR.on('risk.blacklist')) { const b = blackOf(c); if (b) return b; }
  if (NR.on('risk.noProxy')) { const u = await upgradable(c); if (u) return u; } /* 可能误挡正常项目 → 预设关，用户自己决定 */
  return '';
}
/* ④ 每日亏损保险丝：今天卖出的币合计亏超过设定（数字＝你的 risk.dayLoss，没填＝不用）→ 全部自动买暂停，只发一次 TG；要自己按「自动买」才会再开 */
const J_SLACK_MS = 3600e3; /* 技术用：日记照时间往回读，多读一段避免同时写入的先后误差 */ function lossToday() {
  try { const d0 = new Date(); d0.setHours(0, 0, 0, 0); const t0 = d0.getTime(); let loss = 0;
    const lines = readFileSync(join(DIR, 'data', 'journal.jsonl'), 'utf8').split('\n'); /* 从今天开始的每一笔全部算 */
    for (let i = lines.length - 1; i >= 0; i--) { const l = lines[i]; if (!l.trim()) continue; let x; try { x = JSON.parse(l); } catch { continue; } if ((x.at || 0) < t0 - J_SLACK_MS) break; if ((x.at || 0) < t0 || x.side !== '卖' || !(+x.cp > 0) || x.usd == null || (x.manual && Number(radarSet()['risk.lossManual']) !== 1)) continue; loss += (+x.cp) - (+x.usd || 0); } 
    return loss; } catch { return 0; }
}
setInterval(() => { try { const cap = NR.num('risk.dayLoss'); /* 没开／没填就不用 */ if (!(cap > 0)) return; const k = new Date().toDateString(); if (S.fuseDay === k) return; const loss = lossToday(); if (loss <= cap) return;
  S.fuseDay = k; writeFileSync(join(DIR, 'data', 'pause_buy.txt'), String(Date.now())); save(); log(`保险丝：今天卖出合计净亏 ${loss.toFixed(1)}U（赚的已经抵掉），超过 ${cap}U，全部自动买已暂停`);
  tg(`🧯 保险丝跳了：今天卖出的币合计净亏约 ${loss.toFixed(1)}U（赚的已经抵掉亏的；上限 ${cap}U），所有自动买已暂停。\n卖出、止盈照常。确认没问题后，在雷达右上角按「自动买」再打开。`).catch(() => {}); } catch {} }, 120e3).unref();
async function autoMint(c, fname, W = WALLETS[0], val = 0n) {
  if (ESTOP() && val > 0n) return '⏸ 紧急全停中，不打（全停只停买）'; /* 免费项目照样判断、照你的开关通知（全停中一律不打） */
  if (!FORCE.has(c) && val > 0n) { if (radarOff()) return '⏸ 雷达暂停中（或时段外、紧急全停），不自动打'; if (Number(radarSet()['bsc.mintAuto']) !== 1) return '⏸ 你没开「铸造代币」，不自动打'; if (Number(radarSet()['bscnft.auto']) !== 1 && await isNft(c).catch(() => true)) return '⏸ 这是 NFT，你没开「铸造 NFT」，不打'; } 
  /* 进场＝你的条件；每笔都模拟、不能授权、不能扣到预期外的资产 */
  const FC = FORCE.has(c), FW = []; /* 强制打（你按的）时，你的规则只当警告：没按「我知道风险，仍然执行」→ 回需要确认；按了 → 记下来照打 */
  const fwarn = (why, conseq) => { FW.push(why); if (FACK.has(c)) return ''; const t = '⚠️需要确认：' + why + '——' + conseq + '（按「我知道风险，仍然执行」才会打）'; fsW(c, W, t); return t; };
  { const sd = await serialDev(c); if (sd) { if (FC) { const t = fwarn(sd, '这个部署者短时间发了很多项目，常见是批量收割，付的钱可能拿不回来'); if (t) return t; } else { S.paid = S.paid || {}; if (S.paid[c]) { S.paid[c].serialLog = 1; S.paid[c].lastReason = sd + '，照规则不打'; } return `⛔ ${sd}，照规则不打`; } } } 
  if (!FORCE.has(c)) { const ck = await cloneStall(c, val); if (ck) { if (S.paid?.[c]) S.paid[c].lastReason = ck + '，照规则不打'; return `⛔ ${ck}，照规则不打`; } }
  if (val > 0n) { /* 「付手续费的免费」一律当付费——要不要打照你的条件 */
    if (NR.on('bsc.needWalletLimit') && !(await walletLimit(c))) { if (!FC) return `⏸ 要付 ${Number(val) / 1e18} BNB 手续费（当付费），但合约没有每个钱包上限的规定，照规则不打`; const t = fwarn('合约没有每个钱包上限（你开着「一定要有每个钱包上限」）', '少数钱包可以把名额全部打走，你付的手续费可能白付'); if (t) return t; } 
    if (await isNft(c).catch(() => true)) { const fpN = await freeProgress(c); { const ng = nftGate(fpN, S.paid?.[c], c); if (ng) { if (!FC) return '⏸ ' + ng; const t = fwarn(ng, '没达到你设的 NFT 条件，买到的 NFT 可能没人接、卖不掉'); if (t) return t; } } if (NR.on('bsc.needWalletLimit') && !(await walletLimit(c, true))) { if (!FC) return '⏸ NFT 一定要有「每个钱包上限」，照规则不打'; const t = fwarn('NFT 没有每个钱包上限', '少数钱包可以把名额全部打走，你付的钱可能白付'); if (t) return t; } if (NR.on('bscnft.imgCheck')) { const nw = await nftStrict(c); if (nw) { if (!FC) return '⏸ ' + nw + '，照规则不打'; const t = fwarn(nw, '没过你开的 NFT 图片检查，可能是仿冒或空壳项目，付的钱可能拿不回来'); if (t) return t; } } }
  }
  const fp = await freeProgress(c);
  const agentsN = S.paid?.[c]?.agents || 0; /* 只算 Agent ID 钱包 */ /* 进度／钱包数＝你的条件 */
  if (FORCE.has(c) && (ESTOP() || MANUAL_OFF() || CONFL)) return '⏸ 强制打不执行：' + (ESTOP() ? '紧急全停中' : CONFL ? '另一个雷达正在用同一个钱包' : '「手动买卖」没打开'); if (FC) nrForceLog(c, S.paid?.[c]?.name, FW); if (!FORCE.has(c)) { const P0 = S.paid?.[c] || {}; const MJ = nrMintJ(P0, fp == null ? 0 : fp); nrDecLog('bsc', c, P0.name, MJ); if (S.paid?.[c]) S.paid[c].nrJ = nrJLabel(MJ); if (MJ.buy !== true) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {}, waitHot: 1 }; S.paid[c].nrJ = nrJLabel(MJ); nrMissTg(c, S.paid[c], fp == null ? 0 : fp, MJ); return '⏸ ' + MJ.text + '，先追踪'; } } /* 照你的条件和组合方式判断（读不到进度：照你选的「不买／用备用条件」） */
  if (fp != null && !(S.xHits || {})[c]) globalThis.xCheck?.(c, S.paid?.[c]?.name || '').catch(() => {}); /* 通过链上条件的免费项目：背景去 X 查一下（只记录／提醒，不挡） */
  if (fp == null && NR.on('bsc.skipIfPoolOpen')) { let tk = c; const tr0 = await call(c, '0xfc0c546a'); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tk = '0x' + tr0.slice(26, 66); if (await poolOpen(tk)) return '⏸ 读不到进度、已经开池，不铸造（你开了「读不到进度时已开池就不铸」）'; }
  if (val === 0n && await othersPay(c).catch(() => 0)) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '', done: {} }; const P0 = S.paid[c]; P0.needLearn = 1; P0.freePhase = 1; if (P0.done) for (const W0 of WALLETS) if (P0.done[W0.name] === 'free-notify') delete P0.done[W0.name]; return '💱 第一份免费、大家都在付费打 → 改用付费规则（照抄别人的付费打法）'; } 
  if (val === 0n && !FORCE.has(c) && !(NR.on('bsc.freeAuto') && !radarOff() && Number(radarSet()['bsc.mintAuto']) === 1 && !(Number(radarSet()['bscnft.auto']) !== 1 && await isNft(c).catch(() => true)))) { if (NR.on('bsc.freeNotify')) await freeNotify(c, S.paid?.[c]?.name || '', fp, agentsN || 0); return NR.on('bsc.freeNotify') ? '🔔 免费项目达到条件，已通知（你设的是只通知）' : '⏸ 免费项目：没有自动打（没开「免费铸造自动打」或雷达暂停中）'; } /* 免费要不要自动打＝你的开关 */
  if (val > 0n) { /* 读不到 BNB 价格就不打；手续费也算进每天上限 */ const px0 = await bnbUsd().catch(() => 0); if (!(px0 > 0)) return '⏸ 读不到 BNB 价格，算不出手续费值多少，没有铸'; const cp = capOf(c); if (cp == null) return '⏸ 你还没填「每个项目每笔最多」，没有铸'; const fu = (Number(val) / 1e18) * px0; if (fu > cp) return `⏸ 手续费约 ${fu.toFixed(2)}U，超过 ${cp}U 上限，没有铸`; if (!FORCE.has(c) && (PAID.dayUsd == null || paidDayUsd(W) + fu > PAID.dayUsd)) return '⏸ 今天铸造额度用完（或没填「每天最多」），没有铸'; if (FORCE.has(c) && PAID.dayUsd != null && paidDayUsd(W) + fu > PAID.dayUsd) return '⏸ 强制打也算进「每天最多」：今天铸造额度用完，没有铸'; }
  let d = Object.fromEntries(CANDS)[fname]; if (d && /重播|[熱热][門门]函式/.test(fname)) d = freshDeadline(d); /* 照抄的免费铸造也换新期限 */
  const today = new Date().toDateString(); if (S.mintDay !== today) { S.mintDay = today; S.mintCount = 0; }
  S.mintCnt = S.mintCnt && S.mintCnt.d === today ? S.mintCnt : { d: today }; /* 没有隐藏的每天笔数上限（每天几个免费＝risk.freePerDay，花多少＝bsc.mintDayUsd） */
  const bnb = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0');
  { const mg = NR.num('risk.minGasBnb'); if (mg != null && Number(bnb) / 1e18 < mg) return `⚠️ 钱包 BNB 只剩 ${(Number(bnb) / 1e18).toFixed(6)}，低于你设的「至少要有」${mg} BNB，没有铸`; } /* gas 底线＝你的 risk.minGasBnb；没填＝不另外设底线，付不付得起由预演决定 */
  { const rb = await riskBlock(W, c, val, d, val === 0n); if (rb) return '⏸ 风控：' + rb + '，没有铸'; }
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', c, '--value', val.toString(), '--inputData', d]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) return '❌ 预演失败，没有铸：' + (p.j?.error?.message || '').slice(0, 120);
  { const fg = flapGuard(c, d, sim); if (fg) return '⛔ ' + fg + '，没有铸'; }
  const losing = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !(String(b.contractAddress).toLowerCase().startsWith('0xeeee') && -Number(b.change) <= Number(val) && val > 0n)); /* 风控：扣的 BNB 不能比说好的多 */
  if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length || losing.length) return '⚠️ 预演显示有授权或会扣你的资产，安全起见没有铸';
  if (!FORCE.has(c) && Number(radarSet()['bscnft.auto']) !== 1 && (sim?.balanceChanges || []).some((b) => String(b.owner).toLowerCase() === W.addr && /^erc(721|1155)$/i.test(String(b.tokenType || '')) && Number(b.change) > 0)) return '⏸ 预演显示会拿到 NFT，但你没开「铸造 NFT」，不打'; 
  { const dr = await drainCheck(c, val, d); if (dr) return '⛔ ' + dr + '，没有铸'; }
  if (!(sim?.balanceChanges || []).some((b) => String(b.owner).toLowerCase() === W.addr && (Number(b.change) > 0 || (/Erc721|Erc1155/i.test(b.tokenType || '') && !(Number(b.change) < 0))))) return '⚪ 预演显示拿不到东西（可能铸给别人或净额为 0），没有铸'; 
  for (let i = 0; i < 30 && (globalThis.PLUG_INFLIGHT || 0) > 0 && W === WALLETS[0]; i++) await sleep(500); /* 外挂正在用同一个钱包送交易 → 最多等 15 秒 */ INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && TIMEOUT_RE.test(x.t || '')) { if (val > 0n) { const pz = await bnbUsd().catch(() => 0); if (pz > 0) addPaidUsd(W, (Number(val) / 1e18) * pz); } return '⚠️ 送出结果不明（逾时），可能已上链，先不重打（额度先照可能花掉的算）'; } 
  if (!x.j?.success) return '❌ 送出失败：' + (x.j?.error?.message || x.t).slice(0, 120);
  S.mintCount++; S.mintCnt[W.name] = (S.mintCnt[W.name] || 0) + 1; riskAfter(W, c, x.j.data?.txHash || '', val, val === 0n); if (val > 0n) { const pz = await bnbUsd().catch(() => 0); if (pz > 0) addPaidUsd(W, (Number(val) / 1e18) * pz); } /* 手续费型也算进「每天最多」 */
  // 免费铸造拿到的代币也加入持仓追踪（成本 0 → 通知倍数＝你的 notify.multX；回落自动卖＝你的 sell.freeDrop）
  for (const b of sim?.balanceChanges || []) { if (String(b.owner).toLowerCase() !== W.addr || b.tokenType !== 'Erc20' || !(Number(b.change) > 0)) continue; const ta = String(b.contractAddress).toLowerCase(); S.dyn = S.dyn || []; { const ex0 = S.dyn.find((t) => t.addr === ta && t.only === W.addr && !t.closed); if (ex0 && ex0.cost > 0 && val > 0n) { const pz = await bnbUsd().catch(() => 0); if (pz > 0) addCostEx(W, ta, (Number(val) / 1e18) * pz, '铸造'); } } /*RISK-FIX2-2 付费铸造又拿到已有持仓的币：铸造费加进成本（免费币维持免费）*/ if (!addCostEx(W, ta, 0, '')) { const sy = tokStr(await call(ta, '0x95d89b41')) || ta.slice(0, 8); S.dyn.push({ sym: sy, addr: ta, cost: 0, only: W.addr, boughtAt: Date.now() }); } }
  for (const b of sim?.balanceChanges || []) if (String(b.owner).toLowerCase() === W.addr && /Erc721|Erc1155/i.test(b.tokenType || '')) { S.nftCols = S.nftCols || {}; S.nftCols[String(b.contractAddress).toLowerCase()] = 1; } // 记下持有的 NFT 系列（之后定期看成交量）
  const got = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr).map((b) => (b.tokenType === 'Erc721' ? 'NFT ×1' : b.tokenType + ' +' + b.change)).join('、');
  return `🤖 已自动铸造 ${fname}${got ? '（' + got + '）' : ''}${fname.startsWith('commit') ? '\n（这种是两步式，还要 reveal 才拿到，手动处理）' : ''}\n交易 ${x.j.data?.txHash || x.j.data?.orderId || ''}`;
}

// ---------- AIDROP 金库：出现新类型的事件（例如开放领取/发放）就通知 ----------
const AIDROP_VAULT = (CONFIG.watchVault || '').toLowerCase(); // 可选：要盯的 Flap 金库（例如 AIDROP）
async function aidropWatch(head) {
  if (!AIDROP_VAULT) return;
  S.aidrop = S.aidrop || { topics: {}, from: head - 2000 };
  try {
    const logs = await rpc('eth_getLogs', [{ address: AIDROP_VAULT, fromBlock: '0x' + Math.max(S.aidrop.from, head - 4000).toString(16), toBlock: '0x' + head.toString(16) }]);
    const first = Object.keys(S.aidrop.topics).length === 0;
    let alerted = false;
    for (const l of logs) { const t0 = l.topics[0]; if (['0x8a587a0e', '0xe988651c'].includes(t0.slice(0, 10))) { S.aidrop.topics[t0] = 1; continue; } if (!S.aidrop.topics[t0]) { S.aidrop.topics[t0] = 1; if (!first && !alerted && (alerted = true)) await tg(`📣 AIDROP 金库出现新的链上动作（新事件类型）\n可能是开放领取或开始发放，请自行查看\n交易 ${l.transactionHash}`); } }
    S.aidrop.from = head + 1;
  } catch {}
}

// ---------- ToshX：Agent ID 专属的小额 IGO（要付钱，不自动买）。有新项目就分析后 TG 通知 ----------
const TOSH_FACTORIES = [['BNB', '0x091d0cbd1e3b7d8b2a6fd8e0795b784eddffb590'], ['USDT', '0x8296fa2d430dcf25233a39cc3306ee503967a6bb']];
const TOSH_SCAN_PER = 60; /* 技术用：每轮查几个已建立的项目（节点额度），轮流查完全部 */ async function toshWatch() {
  S.tosh = S.tosh || { counts: {} };
  for (const [quote, f] of TOSH_FACTORIES) {
    const r = await call(f, '0x27cca59f'); if (!r) continue; const n = Number(BigInt(r.slice(0, 66)));
    const prev = S.tosh.counts[f];
    if (prev === undefined) { S.tosh.counts[f] = n; continue; } // 第一次只记数量，不通知旧项目
    for (let i = prev; i < n; i++) {
      try {
        const L = await call(f, '0x7b443a76' + w(i)); const W4 = L.slice(2).match(/.{64}/g);
        const token = '0x' + W4[0].slice(24), hook = '0x' + W4[1].slice(24), creator = '0x' + W4[2].slice(24), createdAt = Number(BigInt('0x' + W4[3]));
        const str = async (sel) => { const h = await call(token, sel); try { const x = h.slice(2); const len = Number(BigInt('0x' + x.slice(64, 128))); return Buffer.from(x.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return '?'; } };
        const name = await str('0x06fdde03'), sym = await str('0x95d89b41');

        let byCreator = 0; for (const [, f2] of TOSH_FACTORIES) { const c2 = await call(f2, '0x27cca59f'); const n2 = c2 ? Number(BigInt(c2.slice(0, 66))) : 0; const K0 = (S.tosh.rot = S.tosh.rot || {})[f2] || 0; const kEnd = Math.min(n2, K0 + TOSH_SCAN_PER); S.tosh.rot[f2] = kEnd >= n2 ? 0 : kEnd; for (let k = K0; k < kEnd; k++) { const L2 = await call(f2, '0x7b443a76' + w(k)); if (L2 && L2.slice(2).match(/.{64}/g)[2].slice(24) === creator.slice(2)) byCreator++; } }
        // 官网资料（简介、推特、TG）
        let meta = null; try { const j = await (await fetch('https://toshx.xyz/api/projects', { signal: AbortSignal.timeout(10000) })).json(); meta = (j.data || []).find((p) => String(p.token_address).toLowerCase() === token); } catch {}
        const raisedRaw = quote === 'BNB' ? await rpc('eth_getBalance', [hook, 'latest']).catch(() => '0x0') : await call(USDT, '0x70a08231' + wa(hook));
        const raised = Number(BigInt(raisedRaw || '0x0')) / 1e18;
        const flags = [];
        if (!meta) flags.push('官网还没有资料（可能是测试盘）');
        if (meta && !meta.twitter) flags.push('没有推特');
        if (meta && !meta.website) flags.push('没有官网');
        if (byCreator > 0) flags.push(`同一个创建者发过的项目（这轮轮查到的）：${byCreator} 个（含这个）`); /* 只写事实 */
        const desc = (meta?.description || '').replace(/\s+/g, ' ').slice(0, 220);
        const verdict = nrOn('notify.toshFlags') && flags.length ? '事实：' + flags.join('、') : ''; /* 列出事实（官网／推特／同创建者）＝你的开关 notify.toshFlags（预设关）；不下结论 */
        /* 通不通知＝你的 notify.tosh（预设关）；只通知平台币相关＝你的 notify.toshPlatOnly（预设关）。平台币只是标签，照事实写 */
        const PLATFORM_DEPLOYER = '0x790091e8965ecc1adfa40aa9b95515c6289dce9d'; // TOSH 平台币的建立者
        const isPlatform = creator.toLowerCase() === PLATFORM_DEPLOYER || /platform token|平台币|平台幣|platform coin/i.test((meta?.description || '') + name);
        if (!nrOn('notify.tosh')) { log(`ToshX 新项目 ${name}(${sym})：你没开「ToshX 新项目通知」，不通知`); continue; } if (!isPlatform && nrOn('notify.toshPlatOnly')) { log(`ToshX 新项目 ${name}(${sym}) 不是平台币，你开了「只通知平台币」，不通知`); continue; }
        await tg(`🚀 ToshX ${isPlatform ? '平台币相关' : '一般'}新项目：${name}（$${sym}）\n报价币：${quote} · 已募到约 ${raised.toFixed(3)} ${quote}\n建立时间：${new Date(createdAt * 1000).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' })}\n${desc ? '简介：' + desc + '\n' : ''}${meta?.twitter ? 'X：' + meta.twitter + '\n' : ''}${meta?.telegram ? 'TG：' + meta.telegram + '\n' : ''}代币 ${token}\n${verdict}\n规则：每个 Agent ID 一份额度，通常开卖几分钟就满。要打的话手动处理「打 ${sym}」和每个钱包打多少\nhttps://toshx.xyz/launchpad`);
      } catch (e) { log('tosh err ' + e.message); }
    }
    S.tosh.counts[f] = n;
  }
}

// ---------- Flap「ID AGENT CURVE」：只限 Agent ID 的曲线发射台，有新盘就分析后 TG ----------
const FLAP_READER = '0x18aa6c93f1887a243fdc348c9a77f5136555174a';
const FLAP_QUOTES = { '0x4902c5ebc598265ed2212b559b042de8a5eeec3f': 'BNCB', '0x02fca66c1d1afb4e2a7884261eb00f63598a7436': 'NVDAB', '0x205812cdbed920aff76c6580abd681a46d11efc7': 'QQQB', '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1': 'SPCXB' };
function decStrAt(hex, byteOff) { const h = hex.replace(/^0x/, ''); const len = Number(BigInt('0x' + h.slice(byteOff * 2, byteOff * 2 + 64))); return Buffer.from(h.slice(byteOff * 2 + 64, byteOff * 2 + 64 + len * 2), 'hex').toString('utf8'); }
async function flapAgentWatch() {
  S.flapAgent = S.flapAgent || { total: null, names: {} };
  const p0 = await call(FLAP_READER, '0x8f82e165' + w(0) + w(1)); if (!p0) return;
  const total = Number(BigInt('0x' + p0.slice(2 + 128, 2 + 192)));
  if (S.flapAgent.total === null) { S.flapAgent.total = total; return; }
  for (let i = S.flapAgent.total; i < total; i++) {
    try {
      const pg = await call(FLAP_READER, '0x8f82e165' + w(i) + w(1)); const W5 = pg.slice(2).match(/.{64}/g); const off = Number(BigInt('0x' + W5[0])) / 32; const m = '0x' + W5[off + 1].slice(24);
      const st = await call(FLAP_READER, '0x51c023e2' + wa(m)); const SW = st.slice(2).match(/.{64}/g);
      const t0 = Number(BigInt('0x' + SW[0])) / 32, inner = t0 + Number(BigInt('0x' + SW[t0])) / 32;
      const name = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner])) / 32) * 32), sym = decStrAt(st, (inner + Number(BigInt('0x' + SW[inner + 1])) / 32) * 32);
      const buyTax = Number(BigInt('0x' + SW[inner + 5])) / 100, sellTax = Number(BigInt('0x' + SW[inner + 6])) / 100, maxW = Number(BigInt('0x' + SW[inner + 11])) / 100;
      const quote = '0x' + SW[t0 + 1].slice(24); const qn = /^0x0{40}$/.test(quote) ? 'BNB' : FLAP_QUOTES[quote] || quote.slice(0, 10);
      const key = (sym || name).toLowerCase(); const dup = S.flapAgent.names[key]; S.flapAgent.names[key] = (dup || 0) + 1;
      const flags = []; /* 税只列数字（下面有） */ if (dup) flags.push('跟风同名（之前已有同名盘）'); if (/<|script|onerror|http/i.test(name + sym)) flags.push('⚠️ 名称含可疑程式码，别在网页上点');
      const verdict = flags.length ? '事实：' + flags.join('、') : ''; /* 只列事实，不下结论 */
      if (!/^(flap|flapx)$/i.test(sym.trim())) { log(`Flap Agent 新盘 ${name}(${sym}) 是发射台代币，按规则不通知`); continue; }
      await tg(`🦋 Flap ID AGENT CURVE 新盘：${name.slice(0, 40)}（${sym.slice(0, 20)}）\n底池：${qn} · 税 ${buyTax}%/${sellTax}% · 单钱包上限 ${maxW}%\n${verdict}\n市场 ${m}\n要打的话手动处理「打 ${sym.slice(0, 20)}」和金额`);
    } catch (e) { log('flapAgent err ' + e.message); }
  }
  S.flapAgent.total = total;
}

// ---------- AI 钱包登入状态 ----------
// ---------- 使用者确认：Agent ID 专属的「付费」铸造也自动打（有预算上限＋过滤）----------
// 使用者手动指定「直接打」的项目（不看进度门槛与防钓鱼，只受你填的金额上限与模拟安全检查）
const FORCE = new Set(); /* 强制打名单：只由雷达画面下的已签章订单（radar_orders.json 的 mint 单）加入；config.json 不再有 forceMint 入口（以前写在 config 的合约会被每轮自动当强制打，绕过自动总开关） */ if (Array.isArray(CONFIG.forceMint) && CONFIG.forceMint.length) log('config.json 的 forceMint 已停用（不会自动打）；要强制打请在雷达画面按「⚡ 强制打」');
const PAID = {
  
  /* 每笔／每天金额只看你的设定（下面 defineProperties） */
};
Object.defineProperties(PAID, { keepBnb0: { value: 0 }, maxUsd: { get: () => NR.num('bsc.mintUsd'), configurable: true }, dayUsd: { get: () => NR.num('bsc.mintDayUsd'), configurable: true }, keepBnb: { get: () => NR.num('risk.keepBnb') ?? 0, configurable: true } }); /* 每笔／每天／保留 BNB 全部看你的设定；底线关掉或没填 = 0（只检查这笔交易本身） */
const codeCache = new Map();
async function codeOf(a) { if (codeCache.has(a)) return codeCache.get(a); const v = await rpc('eth_getCode', [a, 'latest']).catch(() => null); if (v && v !== '0x') { codeCache.set(a, v.toLowerCase()); if (codeCache.size > CODE_CACHE_MAX) codeCache.delete(codeCache.keys().next().value); } return (v || '').toLowerCase(); } /* 读失败不记（下次再读）；快取有上限 */ const CODE_CACHE_MAX = 2000; /* 运作：合约程式码快取几个 */
async function bnbUsd() {
  const p = await call(FACTORY, '0xe6a43905' + wa(WBNB) + wa(USDT)); const pair = '0x' + (p || '').slice(26); const r = await call(pair, '0x0902f1ac'); const t0 = await call(pair, '0x0dfe1681');
  if (!r || !t0) return S.lastBnbUsd || 0; const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130)); const px = t0.slice(26) === WBNB.slice(2) ? Number(b) / Number(a) : Number(a) / Number(b); if (Number.isFinite(px) && px > 0) { S.lastBnbUsd = px; return px; } return S.lastBnbUsd || 0; /* 只排除读坏的值（不是有限正数）；节点没回／读坏 → 用上一次真的读到的价格，都没有就是 0＝读不到 */
}
const tokStr = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8'); } catch { return ''; } };
async function readLimit(W, c) { 
  const code = ((await codeOf(c)) || '').toLowerCase(); const has = (s) => code.includes(s); const num = (r) => (r && r.length >= 66 ? BigInt(r.slice(0, 66)) : null); const me = wa(W.addr); const lim = [];
  for (const s of ['d872e413', 'b399b0bc', 'b0b5230f', '7aa9a9d8']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { lim.push(x); break; } }
  let per = null; for (const s of ['453c2310', 'b228d925', '0f2cdd6c', 'f516a2e6', '3c8463a1', 'a4183dbe', '6ac8c1b7']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per == null) for (const s of ['1cee24f5', 'ef23b3a3']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x > 0n && x < 1000000n) { per = x; break; } }
  if (per != null) { let mine = 0n; for (const s of ['1e7269c5', '3cef28d2', 'dc33e681', 'fddcb5ea', 'f5eb42dc', '7b622c72']) if (has(s)) { const x = num(await call(c, '0x' + s + me)); if (x != null && x < 1000000n) { mine = x; break; } } lim.push(per > mine ? per - mine : 0n); }
  for (const s of ['f968adbe', 'f43a22dc', 'de7fcb1d']) if (has(s)) { const x = num(await call(c, '0x' + s)); if (x != null && x > 0n && x < 1000000n) { lim.push(x); break; } }
  return lim.length ? lim.reduce((a, b) => (b < a ? b : a)) : null;
}
async function fitShares(W, c, data, v) { // 份数：先读项目方开放几份；读不到再自动降到 5、3、2、1 份试
  const ws = data.slice(10).match(/.{64}/g) || []; if (!ws.length) return data;
  let n0 = BigInt('0x' + ws[0]); if (n0 < 1n || n0 > 100n) return data;
  const lim = await readLimit(W, c).catch(() => null);
  if (lim != null) { if (lim === 0n) throw new Error('这个钱包的额度已经用完'); if (lim < n0) { log(`读到项目方开放份数 ${lim}，照这个打：${c}`); n0 = lim; } }
  const nOrig = BigInt('0x' + ws[0]);
  for (const n of [n0, ...[5n, 3n, 2n, 1n].filter((x) => x < n0)]) {
    const d2 = data.slice(0, 10) + w(n) + ws.slice(1).join(''); const vv = (BigInt(v || 0) * n) / nOrig; /* 份数降了，付的钱也要按比例降 */
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + vv.toString(16) }, 'latest']); if (n !== n0) log(`份数降到 ${n} 份才打得了：${c}`); return d2; } catch {}
  }
  return data;
}
const REFUND_SELS = ['590e1ae3', 'b5545a3c', '278ecde1', '5b7baf64', '110f8874', '16bfe25c', '38e771ab', 'b2d5ae44', 'fa89401a', 'bffa55d5', '68ec0d99', '74c1b1c9', 'b30196e5', 'c033a490', '4c4a386f', 'd233e4eb']; // 退款相关函式：refund()、claimRefund()、refundOpen()、refundable(address)…
const scaleV = (d0, d1, v) => { /* 份数从 d0 的第一个参数变成 d1 的，金额按比例调整 */ try { const a = BigInt('0x' + d0.slice(10, 74)), b = BigInt('0x' + d1.slice(10, 74)); if (a >= 1n && a <= 100n && b >= 1n && b < a) return (BigInt(v) * b) / a; } catch {} return BigInt(v); };
async function safeAddrs(W, c, data, v) { 
  let ws = data.slice(10).match(/.{64}/g) || []; const me = W.addr.slice(2).toLowerCase();
  if (W.agentId) { let sw = 0; for (let i = 0; i < ws.length; i++) { const x = ws[i].toLowerCase(); if (/^0{24}/.test(x) || BigInt('0x' + x) < 2n ** 128n || x === W.agentId) continue; const o = await call('0x' + REGISTRY, '0x6352211e' + x); if (o && BigInt(o.slice(0, 66)) > 0n && o.slice(26, 66).toLowerCase() !== me) { ws[i] = W.agentId; sw = 1; } } if (sw) { data = data.slice(0, 10) + ws.join(''); log(`照抄前把别人的 Agent ID 编号换成自己的：${c}`); } } /* 照抄的交易带著别人的 Agent ID 编号 → 换成自己的 */
  const skip = new Set([me, c.slice(2).toLowerCase(), USDT.slice(2).toLowerCase(), WBNB.slice(2).toLowerCase()]);
  const idx = ws.map((x, i) => [x.toLowerCase(), i]).filter(([x]) => /^0{24}[0-9a-f]{40}$/.test(x) && x.slice(24, 32) !== '00000000' && !skip.has(x.slice(24))).map(([, i]) => i);
  if (!idx.length) return data;
  for (const r of [me.padStart(64, '0'), '0'.repeat(64)]) {
    const d2 = data.slice(0, 10) + ws.map((x, i) => (idx.includes(i) ? r : x)).join('');
    try { await rpc('eth_call', [{ from: W.addr, to: c, data: d2, value: '0x' + BigInt(v || 0).toString(16) }, 'latest']); log(`照抄前把别人的地址换成${r === '0'.repeat(64) ? '零地址' : '自己的地址'}：${c}`); return d2; } catch {}
  }
  throw new Error('交易里有别人的地址，换成自己或零地址都打不了，安全起见不打');
}
async function revokeOnFail(W, token, spender, fn) { 
  try { return await fn(); } catch (e) { try { await previewExec(W, token, '0x095ea7b3' + wa(spender) + w(0), 0n, () => ''); log(`[${W.name}] 铸造失败，已取消对 ${spender} 的授权`); } catch (e2) { log(`[${W.name}] 取消授权失败 ${e2.message}`); } throw e; }
}
/* 全部禁止授权给 Flap。Flap 的合约一律不互动、不授权 */
const FLAP_BLOCK = new Set(['0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0', '0x90497450f2a706f1951b5bdda52b4e5d16f34c06', '0x18aa6c93f1887a243fdc348c9a77f5136555174a', '0x8b4329947e34b6d56d71a3385cac122bade7d78d', '0x5dd913731c12ad8df3e574859fde45412bf4aad9']);
let FLAP_BAN = false; /* 跟 Flap 互动＝你的开关 risk.flapBan（applySettings 定期更新） */
function flapGuard(to, data, sim) {
  if (!FLAP_BAN) return '';
  if (FLAP_BLOCK.has(String(to).toLowerCase())) return '禁止跟 Flap 合约互动';
  const d = String(data || '').toLowerCase(); if (/^0x(095ea7b3|39509351)/.test(d) && FLAP_BLOCK.has('0x' + d.slice(34, 74))) return '禁止授权给 Flap';
  if ((sim?.allowanceChanges || []).some((a) => FLAP_BLOCK.has(String(a.spender).toLowerCase()))) return '会授权给 Flap，禁止';
  return '';
}
const notesArr = (n) => (Array.isArray(n) ? n : n ? [String(n)] : []); /* version.json notes：阵列；一段字也收 */
const ORD_RES_F = join(DIR, 'data', 'radar_order_res.json'), ORD_RES_TTL = 24 * 3600e3; /* 运作：画面只要最近的结果（确认框用）；旧的在 TG／日志 */
/* 每张单的结果给明确的 ok：成功送出＝true；被挡／被拒／失败／读不到／要确认＝false；结果不明（逾时、可能已成交）或还在处理中＝不给 ok */
function ordOk(t) { t = String(t || ''); if (/结果不明|可能已成交|可能已经成交|逾时/.test(t)) return undefined; if (/^⚠️需要确认/m.test(t)) return false; if (/^✅/m.test(t)) return true; /* 每一行的开头都算（前面常有「🖥 雷达手动买 X」一行）；成功那行开头是 ✅ 时，后面附的警告字眼（像「模拟卖出失败」）不算失败 */ if (/^(❌|⛔|🔒|🛑|⏸)/m.test(t) || /没执行|不执行|没买|没卖|没铸造|没送出|拒绝|不能|失败|超过你设|读不到|没开|格式不对|不在雷达里|登入过期/.test(t)) return false; if (/中…$|中\.\.\.$/.test(t.trim())) return undefined; if (/✅|已买|已送出|已卖出|已铸造|已取消授权|已更新/.test(t)) return true; return undefined; }
/* FR-1104：手动单结果的英文版（画面英文模式用）：常见的结果给英文；对不上的不给（成功／失败对不上句子的也不给；画面只显示「✅ Done／❌ Failed — details in the live log」，不夹中文原句）。由上往下，先对到的算 */
const ORD_RES_EN = [
 [/紧急全停/, '🛑 Emergency stop is on — no buying or approvals (selling still works)'],
 [/没有雷达画面的签章/, '❌ This order has no radar-window signature — not executed'],
 [/「手动买卖」没打开|手动买已关闭/, '🔒 “Manual trading” is off — not buying'],
 [/邀请码绑定/, '🔒 Invite-code binding is not done yet — you can only view and sell'],
 [/另一个雷达/, '⏸ Another radar is using the same wallet — not executed'],
 [/请在电脑/, '🖥 Please do this in the radar on your computer'],
 [/卖出顺序/, '⚠️ Sell order is not set — check Settings → sell order'],
 [/不会把钱转出去/, '⛔ The radar never transfers funds out — not sent'],
 [/自动买总开关没开|雷达暂停中/, '⏸ Auto-buy is off (or paused / outside hours / setup not finished) — not executed'],
 [/没有先过手机额度检查/, '❌ Phone order skipped the phone-limit check — not sent'],
 [/你没开「自动交易允许授权」/, '⏸ Auto trade hit an approval and “Allow approvals in auto trading” is off — logged only'],
 [/不是雷达的邀请绑定/, '⛔ Not the radar invite-binding message — not signed'],
 [/参数格式不对|格式不对/, '❌ Invalid order format — not executed'],
 [/上一笔卖单还在送/, '⏳ Previous sell is still pending — try again shortly'],
 [/没收到要卖几/, '❌ Sell percentage missing — please press again in the radar'],
 [/不是合约/, '⚠️ This address is not a contract on BNB Chain — not bought'],
 [/工具里没有这个铸造项目/, '❌ This mint project is not in the tool — not executed'],
 [/已经没有这个币|已经没有了|之前就卖光/, 'ℹ️ Wallet no longer holds this token — removed from Holdings', 1],
 [/排队中/, '⏳ Received and queued — result in about 1–3 minutes', 1],
 [/额度|上限/, '⏸ Limit reached (daily or per-order cap) — not executed'],
 [/读不到/, '⏸ Could not read the data needed — not executed (safe default)'],
 [/已送出|已经送出/, '✅ Sent', 1],
];
function ordResEn(t, ok) { try { const s0 = String(t || ''), ack = /需要确认/.test(s0), s = ack ? s0.replace(/⚠️\s*需要确认[^：:]*[：:]?/, '') : s0; let hit = ''; for (const [re, en, good] of ORD_RES_EN) if ((good ? ok !== false : ok !== true) && re.test(s)) { hit = en; break; } /* 成功的单不配「挡下」类的英文、失败的不配「已送出」 */ if (!ack) return hit; return (/需要确认授权/.test(s0) ? '⚠️ Needs your confirmation: this order APPROVES a token to another address' : '⚠️ Needs your confirmation') + (hit ? ' — ' + hit : ''); } catch {} return ''; } /* 要你确认的单：英文写「需要确认」＋对得到的原因 */
function ordResNote(text) { try { const id = ACK.getStore()?.id; if (!id) return; const t = String(text || ''); if (phoneGate.pend?.has(String(id))) phoneSpent(id, t); /* RVFIX E3：手机单（phoneGate 放行过的）在这里结算额度 */ const k = t.indexOf('⚠️需要确认'); let o = {}; try { o = JSON.parse(readFileSync(ORD_RES_F, 'utf8')) || {}; } catch {} const now = Date.now(); for (const [x, v] of Object.entries(o)) if (!(now - (v?.at || 0) < ORD_RES_TTL)) delete o[x];
  const prev = o[id]?.r || ''; const r = k >= 0 ? t.slice(k) : prev.startsWith('⚠️需要确认') ? prev : t; const okv = ordOk(r); const ok0 = o[id]?.ok; const en = ordResEn(r, okv); o[id] = { r: r.slice(0, 1500), at: now, ...(en ? { en } : {}), ...(okv === undefined ? (ok0 !== undefined && /中…|中\.\.\./.test(r) ? { ok: ok0 } : {}) : { ok: okv }) }; const tmp = ORD_RES_F + '.w'; writeFileSync(tmp, JSON.stringify(o)); renameSync(tmp, ORD_RES_F); } catch {} } 
let INFLIGHT = 0; // 正在送出的交易数（重启前要等它归零，避免重打）
/* 发射平台曲线上的币也要能直接卖。Aizo：直接呼叫代币合约 burn(数量, 最少拿回, 期限) 换回 BNB（看过链上真实成交确认的作法）。
   先用 eth_call 问「卖这些能拿回多少 BNB」，最少拿回＝报价扣掉你的 sell.curveSlip（没填＝照报价），再走同一套预演防盗检查才送出 */
const CURVES = { '0xb995508476dec1ff929d91a6f0400892ae2a71c9': { name: 'Aizo', sel: '0xb8192205' } };
async function curveQuote(c, W, amt) { const dl = Math.floor(Date.now() / 1000) + 600; const r = await rpc('eth_call', [{ from: W.addr, to: c, data: CURVES[c].sel + w(amt) + w(0) + w(dl) }, 'latest']); return big(r); }
async function curveSell(c, W, amt) { if (!(amt > 0n)) return false; const q = await curveQuote(c, W, amt); if (!(q > 0n)) throw new Error('曲线报价是 0'); const cs = NR.num('sell.curveSlip'); const minOut = cs != null && cs > 0 ? (q * BigInt(Math.round((100 - Math.min(cs, 100)) * 100))) / 10000n : q; const dl = Math.floor(Date.now() / 1000) + 600;
  const data = CURVES[c].sel + w(amt) + w(minOut) + w(dl);
  const cx = await previewExec(W, c, data, 0n, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '会授权或交出钱包权限'; const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr); if (mine.some((b) => !String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && String(b.contractAddress).toLowerCase() !== c && Number(b.change) < 0)) return '会扣你别的币'; if (!mine.some((b) => String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) > 0)) return '预演看不到拿回 BNB'; return ''; }, null, { manual: true });
  if (!cx?.rc) { log(`[${W.name}] ${CURVES[c].name} 曲线卖出已送出，但查不到收据 → 结果待确认`); return 'pend'; } /*V105-FIX2*/ log(`[${W.name}] ${CURVES[c].name} 曲线卖出：约拿回 ${(Number(q) / 1e18).toFixed(5)} BNB`); return true; }
async function previewExec(W, to, data, valueWei, check, recheck = null, opts = {}) {
  const p = await W.baw(['contract-call', 'preview', '--binanceChainId', '56', '--from', W.addr, '--to', to, '--value', valueWei.toString(), '--inputData', data]);
  const sim = p.j?.data?.simulationResult, rid = p.j?.data?.requestId;
  if (!p.j?.success || !rid) throw new Error('预演失败 ' + (p.j?.error?.message || p.t).slice(0, 120) + (valueWei > 0n ? pbHint(p.j?.error?.message || p.t) : '')); 
  const ackd = !!(opts.ack || ACK.getStore()?.ack || FACK.has(String(to).toLowerCase())), isManual = !!(opts.manual || ACK.getStore() || FORCE.has(String(to).toLowerCase()));
  const apprX = (sim?.allowanceChanges || []).some((x) => String(x.spender || '').toLowerCase() !== String(to).toLowerCase()) || !!(sim?.authorityChanges || []).length; /* 授权给别的地址／交出钱包权限 */
  const unsafe = (m) => { /* 工具的判断只是警告，决定权在你 */
    if (apprX) { /* 授权给别的地址／交出钱包权限 */
      const det = (sim?.allowanceChanges || []).map((x) => { const a = String(x.amount ?? x.allowance ?? x.value ?? ''); const inf = /unlimit|infinite|max/i.test(a) || x.isUnlimited === true || /^(0x)?f{60,}$/i.test(a) || a.replace(/\D/g, '').length >= 70; return `代币 ${x.tokenContract || x.contractAddress || x.token || '?'} → 对方 ${x.spender || '?'}，额度 ${inf ? '无限额度' : a || '?'}`; }).join('；') + ((sim?.authorityChanges || []).length ? '；会交出钱包权限' : '');
      const st = ACK.getStore() || {}; const okAppr = ackd && (opts.ackAppr || st.appr || FACKA.has(String(to).toLowerCase()));
      if (okAppr || (!isManual && nrOn('auto.allowApproval'))) { log(`⚠️ [${W.name}] 会授权：${det}（${okAppr ? '你确认过「我看懂了」' : '你开了「自动交易允许授权」'}），照送`); { const L0 = (sim?.allowanceChanges || []).map((x) => ({ tk: String(x.tokenContract || x.contractAddress || x.token || '').toLowerCase(), sp: String(x.spender || '').toLowerCase() })).filter((x) => /^0x[0-9a-f]{40}$/.test(x.tk) && /^0x[0-9a-f]{40}$/.test(x.sp)); if (L0.length) { S.lastAppr = { w: W.addr, name: W.name, at: Date.now(), L: L0 }; save(); } } tgSay(`⚠️ [${W.name}] 已送出含「授权」的交易（${okAppr ? '你手动确认' : '你开了「自动交易允许授权」'}）：${det}\n授权后对方可以随时转走你这个代币。要取消授权：在 TG 回「取消授权」（会再问你一次），或到雷达「钱包健检」按取消授权\n${to}`).catch(() => {}); return; } /* 一定发给你（不受通知分类影响） */
      throw new Error((isManual ? '⚠️需要确认授权：' : '') + '预演不安全：' + m + '。' + det + '。授权后对方可以随时转走你这个代币，可能是盗币' + (isManual ? '（要勾「我看懂了」再按「我知道风险，仍然执行」才会送）' : '（自动：你没开「自动交易允许授权」，只记录不送）'));
    }
    if (ackd) { log(`⚠️ [${W.name}] 预演判断：${m} —— 你按了「我知道风险，仍然执行」，照送`); return; }
    if (!isManual && nrOn('auto.sendOnPreviewFail')) { log(`⚠️ [${W.name}] 预演判断：${m} —— 你开了「预演不过也送出」，照送（可能白烧 gas 或拿不到东西）`); tg(`⚠️ [${W.name}] 预演判断不安全仍然送出（你开了「预演不过也送出」）：${m}\n${to}`).catch(() => {}); return; }
    throw new Error((isManual ? '⚠️需要确认：' : '') + '预演不安全：' + m + (isManual ? '（按「我知道风险，仍然执行」才会送）' : '（自动：你没开「预演不过也送出」，只记录不送）'));
  };
  { const fg = flapGuard(to, data, sim); if (fg) unsafe(fg); }
  { const why = check(sim); if (why) unsafe(why); } const fsC = String(to).toLowerCase(); if (FSA.has(fsC)) fsStage(fsC, 'simulate', `[${W.name}] 预演通过`);
  if (!opts.manual && !FORCE.has(String(to).toLowerCase()) && Number(radarSet()['bscnft.auto']) !== 1 && (sim?.balanceChanges || []).some((b) => String(b.owner).toLowerCase() === W.addr && /^erc(721|1155)$/i.test(String(b.tokenType || '')) && Number(b.change) > 0)) throw new Error('预演显示会拿到 NFT，但你没开「铸造 NFT」，不打（这是你的开关）'); 
  if (!opts.manual && !opts.noDrain) { const dr = await drainCheck(to, valueWei, data); if (dr) unsafe(dr); }
  { const outBnb = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress || '').toLowerCase().startsWith('0xeeee') && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0); if (outBnb > Number(valueWei) * 1.0000001 + 1) unsafe('会扣的 BNB 比说好的多'); }
  if (recheck) { const r2 = await recheck(); if (r2) throw new Error('送出前再确认不通过：' + r2); } // 送出前再确认价格
  for (let i = 0; i < 30 && (globalThis.PLUG_INFLIGHT || 0) > 0 && W === WALLETS[0]; i++) await sleep(500); /* 外挂正在用同一个钱包送交易 → 最多等 15 秒 */ INFLIGHT++; let x; try { x = await W.baw(['contract-call', 'execute', '--requestId', rid]); } finally { INFLIGHT--; }
  if (!x.j && /timed? ?out|ETIMEDOUT|killed/i.test(x.t || '')) throw new Error('结果不明：送出逾时，可能已上链，先不重打');
  if (!x.j?.success) throw new Error('送出失败 ' + (x.j?.error?.message || x.t).slice(0, 120) + (valueWei > 0n ? pbHint(x.j?.error?.message || x.t) : ''));
  riskAfter(W, to, x.j.data?.txHash || '', 0n, false, false);
  { const txh = x.j.data?.txHash || ''; if (FSA.has(fsC)) fsStage(fsC, 'sending', `[${W.name}] 已送出 ${txh.slice(0, 10)}…，等收据`); const rc = await waitRc(txh); 
    { const rv = { at: Date.now(), rc: !!rc, got: rc ? rcGot(rc, W.addr) : new Set() }; RCV.set(W.addr + '|' + fsC, rv); RCV.set(W.addr, rv); } /* 按钱包＋合约存（同一个钱包同时打两个项目时不会互相盖掉） */
    if (rc && rc.status === '0x0') { if (FSA.has(fsC)) fsStage(fsC, 'sending', `[${W.name}] 交易上链了但失败（合约拒绝）`); throw new Error('交易上链了但失败（合约拒绝）' + txh); }
    if (FSA.has(fsC)) fsStage(fsC, 'sending', rc ? `[${W.name}] 收据：成功（区块 ${parseInt(rc.blockNumber, 16)}）` : `[${W.name}] 60 秒内还没查到收据，先当作已送出（请到钱包确认）`);
    return { tx: txh, sim, rc }; }
}
async function poolOut(amtIn, from, to) { // 池子现在买得到多少（没池子回 0）
  const r = await call(ROUTER, '0xd06ca61f' + w(amtIn) + w(64) + w(2) + wa(from) + wa(to)); if (!r || r.length < 2 + 64 * 4) return 0n; return BigInt('0x' + r.slice(2 + 64 * 3, 2 + 64 * 4));
}
const gotTok = (sim, W) => (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) > 0).reduce((a, b) => a + Number(b.change), 0);
// 铸造进度：先找「已售／上限」这类函式；找不到就看「铸造池剩多少币」（合约刚部署时持有的币 vs 现在）
const SOLD_SELS = ['a2309ff8', 'f4514d2e', '505e05fd', 'cc84efea', '192fc516', '9106d7ba', '67153ab4', 'f3f8a4fd', '06ed0717', '9659867e', '4f02c420', '1f21bfbf'];
/* V104-CAPSANE：下面两个清单里可能混到时间函式（例如 d8f93498＝OPEN_AT()），一律再经过 capOk() 检查 */
const CAP_SELS = ['d8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', 'd5abeb01', '32cb6b0c', '06517a29', '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e', '355274ea', '85e3f997'];
/* V104-CAPSANE（用户 @yongc2025 回报）：找「总份额」时会读到时间常量（PAUSE_DURATION()、openAt()、OPEN_AT() 这类）当成总量 → 进度完全错。
   ① 名称含下面这些字的函式不当总量（用名称算出 4 码编号排除）；② 总量一定要 ≥ 已售，而且不能像 Unix 时间戳（秒或毫秒）；
   不合理＝读不到总量（进度读不到 → 照你的 bsc.goPct.miss：不买或你选的备用条件），不会拿去算百分比。 */
const CAP_TIME_WORDS = ['pause', 'duration', 'period', 'delay', 'time', 'open', 'close', 'start', 'end', 'deadline'];
const CAP_TIME_PRE = ['', 'mint', 'sale', 'public', 'presale', 'whitelist', 'wl', 'claim', 'refund', 'reveal', 'lock', 'unlock', 'trading', 'launch', 'round', 'phase', 'stage', 'auction', 'pool', 'last', 'next', 'cooldown', 'vesting', 'release'];
const CAP_TIME_SUF = ['', 'At', 'Time', 'Timestamp', 'Block', 'Duration', 'Period', 'Delay', 'Ts', 'Date'];
const CAP_TS_YEARS = 30; /* 技术用：离现在前后这么多年内的数字当成时间戳（秒或毫秒），不是交易数字 */
let CAP_TIME_SELS = null;
function capTimeSels() { /* 名称 → 4 码编号（第一次用到才算，之后记住）；驼峰（openAt）和大写底线（OPEN_AT）两种写法都算 */
  if (CAP_TIME_SELS) return CAP_TIME_SELS; const M = new Map(); const up = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  for (const p of CAP_TIME_PRE) for (const w of CAP_TIME_WORDS) for (const x of CAP_TIME_SUF) for (const nm of [p ? p + up(w) + x : w + x, [p, w, x.replace(/[A-Z]/g, (m) => '_' + m).replace(/^_/, '')].filter(Boolean).join('_').toUpperCase()]) { const k = keccakHex(Buffer.from(nm + '()').toString('hex')).slice(0, 8); if (!M.has(k)) M.set(k, nm); }
  return (CAP_TIME_SELS = M);
}
const capSelK = (sel) => String(sel || '').toLowerCase().replace(/^0x/, '');
function capLooksTs(x) { const s = Date.now() / 1e3, y = CAP_TS_YEARS * 365 * 86400; return (x >= s - y && x <= s + y) || (x >= (s - y) * 1e3 && x <= (s + y) * 1e3); }
function capBadWhy(sel, x, sold) { const k = capSelK(sel); const nm = k ? capTimeSels().get(k) : null; if (nm) return `函式 ${nm}() 是时间设定，不是总量`; if (!(Number.isFinite(x) && x > 0)) return '读到 0 或不是数字'; if (sold != null && x < sold) return `比已售 ${sold} 还小`; if (capLooksTs(x)) return '数字像时间戳（秒／毫秒），不是总量'; return ''; }
function capOk(sel, x, sold, P, c) { const why = capBadWhy(sel, x, sold); if (why && P) { const k = capSelK(sel) || '?'; P.capRej = P.capRej || {}; if (!P.capRej[k]) { P.capRej[k] = 1; log(`${P.name || c || ''}：总量候选 0x${k} 读到 ${x}，${why} → 不当总份额（读不到总量＝进度读不到，照你的「读不到进度时」规则）`); } } return !why; }
async function progressOf(c, code, tokAddr) {
  let sold = null, cap = null;
  for (const s of SOLD_SELS) { if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { sold = Number(BigInt(r.slice(0, 66))); break; } }
  if (sold != null) for (const s of CAP_SELS) { if (!code.includes(s) || capTimeSels().has(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 10 && x >= sold && x < 1e12 && capOk(s, x, sold)) { cap = x; break; } /*V104-CAPSANE*/ } }
  if (sold != null && cap) return { progress: sold / cap, sold, cap, how: '已售／上限' };
  S.prog = S.prog || {}; let pg = S.prog[c];
  const tok = tokAddr || c;
  if (!pg) {
    const head = parseInt(await rpc('eth_blockNumber', []), 16);
    const has = async (b) => (((await rpc('eth_getCode', [c, '0x' + b.toString(16)]).catch(() => '0x')) || '0x').length > 2);
    let lo = head - 400000, hi = head; if (await has(lo)) { S.prog[c] = { none: 1 }; return { progress: 0, sold, cap }; }
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (await has(m)) hi = m; else lo = m; }
    let init = 0n; for (const b of [hi, hi + 1, hi + 5, hi + 20]) { const r = await rpc('eth_call', [{ to: tok, data: '0x70a08231' + wa(c) }, '0x' + b.toString(16)]).catch(() => null); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { init = BigInt(r.slice(0, 66)); break; } }
    pg = S.prog[c] = init > 0n ? { init: init.toString(), tok } : { none: 1 };
  }
  if (pg.none) return { progress: 0, sold, cap };
  const now = big(await call(pg.tok, '0x70a08231' + wa(c)));
  const init = BigInt(pg.init);
  /* 一开始就全部发行、合约里还放了一大笔要加池子的币 → 用「剩余÷初始」会严重低估。有总份数时，改用「已发出 ÷ 每份数量 ÷ 总份数」 */
  if (pg.cap != null && !pg.capChk) pg.cap = null; /*V104-CAPSANE：旧版存的总份数没检查过 → 重读*/ if (pg.cap == null) { pg.cap = 0; pg.capChk = 1; for (const s of CAP_SELS) { if (capTimeSels().has(s)) continue; if (!code.includes(s)) continue; const r = await call(c, '0x' + s); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 100 && x <= 1e7 && capOk(s, x, null)) { pg.cap = x; pg.capSel = s; break; } } } }
  if (pg.cap && !pg.unit) { try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: pg.tok, fromBlock: '0x' + (head - 3000).toString(16), toBlock: '0x' + head.toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(24) + c.slice(2)] }]).catch(() => []); const cnt = {}; for (const l of L || []) { const v = l.data; cnt[v] = (cnt[v] || 0) + 1; } const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0]; const sn = nrNum('bsc.shareInferN'); if (top && sn != null && top[1] >= sn) pg.unit = BigInt(top[0]).toString(); } catch {} } /* 每份几颗：几笔一样的数量才算＝你的 bsc.shareInferN（空白＝不推算，进度读不到） */
  if (pg.cap && pg.unit && BigInt(pg.unit) > 0n) { const soldN = Number((init - now) / BigInt(pg.unit)); if (capOk(pg.capSel, pg.cap, soldN)) return { progress: soldN / pg.cap, sold: soldN, cap: pg.cap, how: '已发出份数／总份数' }; } /*V104-CAPSANE：已发出比总份数还多＝总份数不合理 → 不用它（不再夹成满格当售罄）*/
  return { progress: Number(init - now) / Number(init), sold, cap, how: '铸造池剩余' };
}


// ---------- 第三层：查项目方底细 ----------
async function deployerOf(c) {
  S.deployer = S.deployer || {}; if (S.deployer[c]) return S.deployer[c];
  const ow = await call(c, '0x8da5cb5b'); if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) return (S.deployer[c] = '0x' + ow.slice(26, 66));
  return '';
}
// 重复 DEV：同一个部署者短时间发很多项目 → 次数／时间＝你的设定 risk.repeatDev*
/* 部署者记录留多久＝开着的规则里 risk.serialDevH／risk.repeatDevH 较大的那个；有开着的规则没填时间、或都没开＝不设时间窗（全部留着）。每个部署者最多留的笔数＝设定里「发了几个以上」能填的最大值，所以计数不会被截断 */
function devKeepMs() { const hs = []; if (NR.on('risk.serialDev')) hs.push(NR.num('risk.serialDevH')); if (NR.on('risk.repeatDev')) hs.push(NR.num('risk.repeatDevH')); if (!hs.length || hs.some((h) => h == null)) return null; const mh = Math.max(...hs); return mh * 3600e3; }
const devKeepN = () => Math.max(...['risk.serialDevN', 'risk.repeatDevN'].map((k) => +(SCHEMA.find((i) => i.k === k)?.max) || 0));
function noteDev(dep, c) { if (!dep) return; S.devs = S.devs || {}; const now = Date.now(); const keep = devKeepMs(), kn = devKeepN(); let arr = (S.devs[dep] || []).filter((x) => (keep == null || now - x.t < keep) && x.c !== c); arr.push({ t: now, c }); if (kn > 0 && arr.length > kn) arr = arr.slice(arr.length - kn); delete S.devs[dep]; S.devs[dep] = arr; /* 重新放到最后：存档时清旧记录，清的是最久没出现的部署者 */
  (async () => { let n = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')); if (!n) { const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) n = tokStr(await call('0x' + tr.slice(26, 66), '0x95d89b41')); } const e = (S.devs[dep] || []).find((x) => x.c === c); if (e && n) e.n = n; })().catch(() => {}); }

const devKey = (x) => String(x.n || S.paid?.[x.c]?.name || x.c).toLowerCase().replace(/\s*\(.*?\)\s*/g, '').replace(/^\$/, '').trim();

let AG_MIN = 0, GO_PCT = 0; /* 进度／钱包门槛＝你的设定 bsc.goPct／bsc.agMin（没开＝不设门槛） */
// ---------- 风控 ----------
const RISK = { get dayBnb() { return NR.num('risk.feeDayBnb'); }, get freePerDay() { return NR.num('risk.freePerDay'); }, get gasMax() { return NR.num('risk.gasMaxBnb'); }, get gasMaxPaid() { return NR.num('risk.gasMaxPaidBnb'); }, get revMax() { return NR.num('risk.revMax'); } }; /* 全部是你的设定 */ // 每钱包每天手续费＋gas 上限、免费每天最多几个、单笔 gas 上限、同合约上链失败几次就停
function riskDay() { const d = new Date().toDateString(); if (!S.risk || S.risk.d !== d) S.risk = { d, spend: {}, free: {}, warned: {}, rev: (S.risk && S.risk.rev) || {} }; return S.risk; }
const UPG_SLOTS = ['0x360894a13ba1a3210667c828492db98dca3e2076cc3735a8ce03b6d4d6b6bbc', '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50', '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036a5a723fd8ee048ed3f8c3'];
async function upgradeable(c) { /* 可升级代理合约：项目方事后能把程式（包括保本机制）整个换掉 */ S.upg = S.upg || {}; if (S.upg[c] != null) return !!S.upg[c]; let u = 0; for (const sl of UPG_SLOTS) { const v = await rpc('eth_getStorageAt', [c, sl, 'latest']).catch(() => null); if (v && /[1-9a-f]/i.test(v.slice(2))) { u = 1; break; } } S.upg[c] = u; return !!u; }
async function drainCheck(c, valueWei, data = '') { const dMin = NR.num('bsc.drainMinBnb'); if (!NR.on('bsc.drainSkip') || dMin == null) return ''; /* 门槛＝你的设定 */ /* 付费的钱要留在合约里（开池当流动性／打不满能退款）。模拟只看得到自己钱包的变化，所以改看合约里实际剩多少 BNB：合约里剩的钱低于你填的数字又没开池＝钱被转走，退款是假的，不打 */
  if (!valueWei || !(BigInt(valueWei) > 0n)) return '';
  S.drainC = S.drainC || {}; const k = S.drainC[c]; if (k && Date.now() - k.t < 60e3) return k.r; /* 短暂快取（只是少打请求），打之前等于重查 */
  let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66);
  let bal = 0; for (const a of [c] /* 钱流只看铸造合约，token() 可能被指到有钱的热门币 */) bal += Number(BigInt((await rpc('eth_getBalance', [a, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
  if (bal < dMin) { /* 有的合约收到 BNB 会换成 USDT／WBNB 存着，不是被转走；只多算这两种公认的币（假不了），门槛一样是你填的数字 */ const px = await bnbUsd().catch(() => 0); for (const a of [c].filter(Boolean)) { const wb = await call(WBNB, '0x70a08231' + wa(a)).catch(() => null); if (wb && wb.length >= 66) bal += Number(BigInt(wb.slice(0, 66))) / 1e18; const us = await call(USDT, '0x70a08231' + wa(a)).catch(() => null); if (us && us.length >= 66 && Number.isFinite(px) && px > 0) bal += Number(BigInt(us.slice(0, 66))) / 1e18 / px; } }
  const pair = await call(FACTORY, '0xe6a43905' + wa(c) /* 不信 token()，免得指到有池子的热门币 */ + wa(WBNB)).catch(() => null); const hasPool = !!(pair && pair.length >= 66 && BigInt(pair.slice(0, 66)) > 0n);
  let r = bal < dMin && !hasPool ? `合约里只剩 ${bal.toFixed(4)} BNB（含换成 USDT／WBNB 的部分），付的钱被转走了（退款／开池可能是假的）` : '';
  S.drainC[c] = { t: Date.now(), r }; return r;
}
async function ownerHeavy(c, name) { /* 项目方自己留太多币的提醒：比例＝你的设定 bsc.ownerWarnPct（没开＝不查） */
  const owP = NR.on('bsc.ownerWarn') ? NR.num('bsc.ownerWarnPct') : null; if (owP == null) return; 
  S.ownW = S.ownW || {}; if (S.ownW[c]) return; S.ownW[c] = 1;
  let tok = c; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66);
  const ts0 = big(await call(tok, '0x18160ddd')); if (!(ts0 > 0n)) return;
  const who = new Set(); const ow = await call(c, '0x8da5cb5b'); if (ow && ow.length >= 66 && BigInt(ow.slice(0, 66)) > 0n) who.add('0x' + ow.slice(26, 66).toLowerCase()); const dep = (S.depFrom || {})[c]; if (dep) who.add(dep.toLowerCase());
  for (const a of who) { const code = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '0x')) || '0x'); if (code.length > 2) continue; const b = big(await call(tok, '0x70a08231' + wa(a))); const pct = Number((b * 10000n) / ts0) / 100; if (pct > owP) { log(`⚠️ ${name || c}：项目方钱包 ${a.slice(0, 10)}… 持有 ${pct}% 的币`); await tg(`⚠️ ${name || c} 达到进场条件，但项目方钱包自己持有 ${pct}% 的币，开池后可能被砸盘（目前只警告、照规则还是会打）\n${c}`); return; } }
}
// ---------- TG 群组监控：用自己的 TG 帐号在本机「只读」自己加入的群组；免费、不花 AI 用量 ----------
// 要用的人自己执行 tg_login.bat（或 node watch.mjs --tg-login）登入一次；没登入就完全不跑；只抓讯息里的合约地址、统计几个群在讨论，不存讯息内容；打不打还是照链上规则
// ---------- 群里传的热门网址----------
const URL_SKIP = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.(org|me)|binance\.(com|info)|github\.com|dexscreener\.com|bscscan\.com|etherscan\.io|youtube\.com|youtu\.be|google\.com|gmgn\.ai|geckoterminal\.com|coingecko\.com|coinmarketcap\.com|four\.meme|pancakeswap\.finance|medium\.com|discord\.(gg|com)|instagram\.com|tiktok\.com|okx\.com|bitget\.com|debank\.com|dextools\.io|ave\.ai|mirror\.xyz|notion\.(so|site)|gitbook\.io|docs\.google\.com|linktr\.ee|bit\.ly|tinyurl\.com|facebook\.com|reddit\.com|weibo\.com|bilibili\.com|apple\.com|claude\.ai|openai\.com|chatgpt\.com|pump\.fun|flap\.sh|axiom\.trade|bullx\.io|photon-sol\.tinyastro\.io|poocoin\.app|birdeye\.so|solscan\.io|basescan\.org|arbiscan\.io|tronscan\.org|dexview\.com|web3\.okx\.com|debot\.ai|xxyy\.io|binance\.us|bnbchain\.org)$/i; 
const tgWin = () => { const x = nrNum('tgmon.winH'); return x != null ? x * 3600e3 : Infinity; }; const tgMinG = () => nrNum('tgmon.minGroups'), tgMinS = () => nrNum('tgmon.minSenders'); const tgGE = (v, m) => m != null && v >= m; /* 空白＝这条不用（不会触发） */
function noteUrls(t, m, chatId) {
  const urls = [...(t.match(/https?:\/\/[^\s<>"'）)】]+/gi) || [])]; for (const e of m.entities || []) if (e.url) urls.push(e.url);
  for (const d of t.match(/\b[a-z0-9][a-z0-9-]{1,40}\.(xyz|fun|online|io|app|site|ai|top|meme|vip|pro|club|live|link|cc|me|world|tech|finance|money|gg|lol|wtf|bot|agent|net|org|com)\b/gi) || []) urls.push('https://' + d);
  S.urlHits = S.urlHits || {}; const sender = String(m.senderId || m.fromId?.userId || '?');
  for (const u of new Set(urls)) { let host = ''; try { host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; } if (!host.includes('.') || URL_SKIP.test(host)) continue;
    const h = (S.urlHits[host] = S.urlHits[host] || { chats: {}, senders: {}, first: Date.now(), url: u }); h.chats[chatId] = Date.now(); h.senders[sender] = Date.now(); }
}
async function siteScan(host, url) { /* 只读网页文字：不连钱包、不签名、不执行网站上的程式；只抓网页里列出的合约地址 */
  { const h0 = String(host || '').toLowerCase().replace(/^\[|\]$/g, ''); if (!h0 || /^[\d.]+$/.test(h0) || h0.includes(':') || /(^|\.)(localhost|local|lan|internal|home|intranet|corp)$/.test(h0) || !h0.includes('.')) { log(`网站检查：${h0 || '?'} 是 IP／内网位址，不去读（避免被拿来探你家里的网路）`); return { title: '', cs: [] }; } } 
  
  const GEN = new Set(['0xca11bde05977b3631167028862be2a173976ca11', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0xffffffffffffffffffffffffffffffffffffffff', '0x000000000022d473030f116ddee9f6b43ac78ba3']);
  const pick = (t) => [...new Set([...String(t).matchAll(/(?<![0-9a-fA-F])0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))].filter((a) => !INFRA.has(a) && !GEN.has(a) && !/^0x0{40}$/.test(a) && !/^0x(.{4})\1{9}$/.test(a) && a !== USDT && a !== WBNB);
  const codeChk = new Map(); const real = async (t) => { const out = []; for (const a of pick(t)) { /* 网页上的地址全部检查（有快取） */ if (!codeChk.has(a)) { const cd = ((await rpc('eth_getCode', [a, 'latest']).catch(() => '')) || ''); codeChk.set(a, cd.length > 2); } if (codeChk.get(a)) out.push(a); } return out; };
  const get = async (u) => { try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000) }); let fh = ''; try { fh = new URL(r.url).hostname.toLowerCase().replace(/^www\./, ''); } catch {} if (!r.ok || (fh && fh !== host && !fh.endsWith('.' + host))) return ''; const tx = await r.text(); return tx.slice(0, 3e6); } catch { return ''; } };
  let html = await get(url.startsWith('https://') ? url : 'https://' + host + '/'); if (!html && url !== 'https://' + host + '/') html = await get('https://' + host + '/');
  let text = html; const title = noLink(((html.match(/<title[^>]*>([^<]{1,80})/i) || [])[1] || '').trim());
  if (!(await real(html)).length) for (const src of [...new Set([...html.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+\.(?:json|js)(?:\?[^"']*)?)["']/gi)].map((x) => x[1]))].sort((x, y) => (y.endsWith('.json') ? 1 : 0) - (x.endsWith('.json') ? 1 : 0)).slice(0, 5)) { /* 网站常把合约地址放在 deployment.json 或主程式档里 */ let su = ''; try { su = new URL(src, 'https://' + host + '/').href; } catch { continue; } text += await get(su); }
  if (!(await real(text)).length) for (const ep of ['/api/stats', '/api/config', '/api/info', '/api/contract', '/api/contracts', '/api/token', '/api/mint', '/api/status', '/config.json', '/deployment.json', '/contracts.json']) { text += await get('https://' + host + ep); if ((await real(text)).length) break; } /* 像 BAO AGENT 合约只放在网站的资料介面（/api/stats）里 */
  const cs = (await real(text)).slice(0, 8);
  return { title, cs };
}
async function agentOnly(c) { /* 群里丢的网址，要先确认是不是「Agent ID（AI 代理人）才能打」的项目 */
  S.agentOnly = S.agentOnly || {}; if (S.agentOnly[c]) return S.agentOnly[c]; /* 「不是」不永久记住（之后人多了／你改设定会再查） */
  let r = ''; try {
    let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); code = await fullCode(c, code).catch(() => code);
    if (code.includes(REGISTRY)) r = '合约里有 Agent ID 检查';
    else { /* 合约没写（可能是官网签名验证）→ 看最近打它的钱包是不是大多持有 Agent ID */
      const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 3000).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
      const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
      if (hs.length && nrOn('disc.agentShare')) { const txs = await rpcBatch(hs.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))); const fr = [...new Set(txs.map((t) => String(t?.from || '').toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
        const A = await agShare(fr); if (A.ok) r = `打它的钱包 ${A.n}/${A.of} 持有 Agent ID`; } /* 同一套判断（你开了 disc.agentShare 才看） */
    }
  } catch {}
  S.agentOnly[c] = r; return r;
}
async function findByHot(title, host) { /* 网站把合约藏起来 → 看现在 Agent ID 钱包正在大量打哪些合约，名字跟网站对得上的就是它 */
  const words = [...new Set(String(title + ' ' + host.split('.')[0]).toLowerCase().match(/[a-z0-9一-鿿]{4,}/g) || [])].filter((w) => !/^(agent|mint|meme|token|launch|https|www|fair|curve|chain|smart|binance)$/.test(w));
  if (!words.length) return [];
  const top = [...HOT.entries()].filter(([a, h]) => h.from.size >= discMin() && !INFRA.has(a)).sort((a, b) => b[1].from.size - a[1].from.size).slice(0, DISC_PER_ROUND); /* 照钱包数排，每次比对的数量只是节点额度 */
  const out = [];
  for (const [a] of top) { let nm = (tokStr(await call(a, '0x06fdde03')) + ' ' + tokStr(await call(a, '0x95d89b41'))).toLowerCase(); if (!nm.trim()) { const tr = await call(a, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) { const t = '0x' + tr.slice(26, 66); nm = (tokStr(await call(t, '0x06fdde03')) + ' ' + tokStr(await call(t, '0x95d89b41'))).toLowerCase(); } } const nn = nm.replace(/[^a-z0-9一-鿿]/g, ''); if (nn && words.some((w) => nn.includes(w) || w.includes(nn))) out.push(a); }
  return out;
}
async function hotUrls() {
  if (!S.urlHits) return; S.urlNoted = S.urlNoted || {}; 
  for (const [host, h] of Object.entries(S.urlHits)) {
    for (const o of [h.chats, h.senders]) for (const [k, t] of Object.entries(o)) if (Date.now() - t > tgWin()) delete o[k];
    const nc = Object.keys(h.chats).length, ns = Object.keys(h.senders).length; if (!nc && Date.now() - h.first > tgWin()) { delete S.urlHits[host]; continue; }
    if (h.retryAt && Date.now() > h.retryAt && !h.found) { h.rn = (h.rn || 0) + 1; h.retryAt = Date.now() + Math.min(2 ** h.rn, 30) * 60e3; /* 运作：找不到就越隔越久再找，不放弃 */ const fh = await findByHot(h.title || '', host).catch(() => []); const ok = []; for (const c of fh) if (await agentOnly(c)) ok.push(c); if (ok.length) { h.found = 1; for (const c of ok) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: h.title || host, done: {}, fromUrl: host, needLearn: 1 }; } log(`🌐 ${host}：从 Agent ID 钱包正在打的合约里找到 ${ok.join('、')}`); await tg(`🌐 找到 ${host} 的合约了（从 Agent ID 钱包正在打的合约比对名字）：\n${ok.join('\n')}\n已加入追踪，照规则决定打不打`); } continue; }
    const hit = tgGE(nc, tgMinG()) || tgGE(ns, tgMinS()); if (S.urlNoted[host] || !hit) continue; /* 几个群／几个人＝你的 tgmon.minGroups／minSenders（空白＝不用） */ S.urlNoted[host] = ts();
    const { title, cs: cs0 } = await siteScan(host, h.url).catch(() => ({ title: '', cs: [] }));
    if (!cs0.length) { const fh = await findByHot(title, host).catch(() => []); for (const c of fh) cs0.push(c); if (!fh.length) { h.rn = 0; h.retryAt = Date.now() + 60e3; h.title = title; } } /* 网站上找不到合约 → 从 Agent ID 钱包正在打的热门合约里比对名字；找不到就越隔越久再找（技术用），不放弃 */
    const cs = [], why = {}; for (const c of cs0) { if (!nrOn('tgmon.agentOnly')) { cs.push(c); why[c] = ''; continue; } const w = await agentOnly(c); if (w) { cs.push(c); why[c] = w; } } /* 只追 Agent ID 专属＝你的开关 tgmon.agentOnly（预设关） */
    if (cs0.length && !cs.length) { log(`🌐 热门网址：${host}（${nc} 个群、${ns} 个人在传）网站上的合约都不是 Agent ID 专属项目，略过：${cs0.join('、')}`); continue; }
    for (const c of cs) { S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: title || host, done: {}, fromUrl: host, needLearn: 1 }; (S.grpHits = S.grpHits || {})[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }; Object.assign(S.grpHits[c].chats, h.chats); }
    log(`🌐 热门网址：${host}（${nc} 个群、${ns} 个人在传）${title ? '「' + title + '」' : ''} → 网站上的合约：${cs.join('、') || '找不到'}`);
    await tg(`🌐 ${nc + ' 个群、' + ns + ' 个人'}在传：${host}${title ? '\n' + title : ''}\n${cs.length ? 'Agent ID 专属的合约（已加入追踪，打不打照链上规则）：\n' + cs.map((c) => c + '（' + why[c] + '）').join('\n') : '网站上找不到合约地址（可能要连钱包后才显示），要看的话手动处理'}`);
  }
  const ks = Object.keys(S.urlHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.urlHits[k];
  const kn = Object.keys(S.urlNoted); if (kn.length > 3000) for (const k of kn.slice(0, kn.length - 3000)) delete S.urlNoted[k];
}
let _tgc = null, _tgBusy = false, _tgDialogsAt = 0, _tgDialogs = [];
const TG_GRP_PER_MIN = 12; async function tgGroupWatch() {
  const f = join(DIR, 'data', 'tg_user.json'); if (!nrOn('tgmon.on') || !existsSync(f) || _tgBusy) return; /* 群监测＝你的开关 tgmon.on（预设关） */ _tgBusy = true;
  try {
    if (!_tgc) { const { createRequire } = await import('module'); const req = createRequire(import.meta.url); const { TelegramClient } = req('telegram'); const { StringSession } = req('telegram/sessions'); const u = JSON.parse(readFileSync(f, 'utf8')); _tgc = new TelegramClient(new StringSession(u.session), u.apiId, u.apiHash, { connectionRetries: 5 }); try { _tgc.setLogLevel('none'); } catch {} await _tgc.connect(); log('TG 群组监控：已连线（只读）'); }
    if (Date.now() - _tgDialogsAt > 600e3) { _tgDialogs = (await _tgc.getDialogs({ limit: 300 })).filter((d) => d.isGroup || d.isChannel); _tgDialogsAt = Date.now(); try { writeFileSync(join(DIR, 'data', 'tg_groups.txt'), _tgDialogs.map((d) => `${d.isChannel && !d.isGroup ? '频道' : '群组'}\t${d.entity?.username ? '@' + d.entity.username : '-'}\t${String(d.title || d.name || '').replace(/\s+/g, ' ')}`).join('\n')); } catch {} }
    S.tgLast = S.tgLast || {}; S.grpHits = S.grpHits || {}; let n = 0;
    const rot = (S.tgRot || 0) % Math.max(1, _tgDialogs.length); const DL = [..._tgDialogs.slice(rot), ..._tgDialogs.slice(0, rot)]; let lastI = rot; /* 轮流：这次读不完的群下次先读，不会一直轮不到 */
    for (const d of DL) { lastI++;
      const id = String(d.id); const top = d.message?.id || 0; const last = S.tgLast[id];
      if (last == null) { S.tgLast[id] = top; continue; } /* 第一次只记位置，不回头读旧讯息 */
      if (top <= last) continue; if (n++ >= TG_GRP_PER_MIN) { S.tgRot = (lastI - 1) % Math.max(1, _tgDialogs.length); break; } /* 技术用：每分钟读几个有新讯息的群（TG 限流），没读到的下一分钟接着读 */
      await sleep(1500);
      const msgs = await _tgc.getMessages(d.entity, { limit: 50, minId: last }).catch(() => []);
      let mx = last; for (const m of msgs) { if (m.id > mx) mx = m.id; const t = String(m.message || ''); noteUrls(t, m, id); for (const c of new Set((t.match(/0x[a-fA-F0-9]{40}/g) || []).map((x) => x.toLowerCase()))) { if (INFRA.has(c)) continue; const h = (S.grpHits[c] = S.grpHits[c] || { chats: {}, first: Date.now(), names: [] }); h.chats[id] = Date.now(); const nm = String(d.title || d.name || '').slice(0, 20); if (nm && !h.names.includes(nm)) h.names.push(nm); } }
      { const skipped = top - last - msgs.length; if (skipped > 0) { S.tgSkip = S.tgSkip || {}; S.tgSkip[id] = (S.tgSkip[id] || 0) + skipped; log(`群监测：「${String(d.title || d.name || id).slice(0, 20)}」新讯息太多，这次只读最新的 ${msgs.length} 则，略过 ${skipped} 则较旧的（技术用：每次读取上限）`); } } /* 略过的要说 */
      S.tgLast[id] = Math.max(mx, top);
    }
    for (const [c, h] of Object.entries(S.grpHits)) {
      for (const [k, t] of Object.entries(h.chats)) if (Date.now() - t > tgWin()) delete h.chats[k];
      const cnt = Object.keys(h.chats).length; if (!cnt && Date.now() - h.first > tgWin()) { delete S.grpHits[c]; continue; }
      if (tgGE(cnt, tgMinG()) && !h.noted) { h.noted = 1; const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || ''); if (code.length <= 2) continue;
        if (nrOn('tgmon.agentOnly')) { const ao = await agentOnly(c); if (!ao) { log(`💬 ${cnt} 个群在讨论 ${c}，但不是 Agent ID 专属项目，略过（你开了 tgmon.agentOnly）`); continue; } }
        let nm = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
        S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: nm, done: {}, fromGroups: cnt, needLearn: 1 };
        log(`💬 TG 群组热议：${nm} ${c} 有 ${cnt} 个群在讨论（${h.names.slice(0, 5).join('、')}），加入追踪，照链上规则决定打不打`);
        await tg(`💬 ${cnt + ' 个 TG 群在讨论'}：${nm}\n${h.names.slice(0, 5).join('、')}\n${c}\n已加入追踪，打不打照链上规则（进度、Agent ID 钱包数、保本）`); }
    }
    const ks = Object.keys(S.grpHits); if (ks.length > 5000) for (const k of ks.slice(0, ks.length - 5000)) delete S.grpHits[k];
    await hotUrls().catch((e) => log('热门网址：' + String(e.message || e).slice(0, 80)));
  } catch (e) { log('TG 群组监控：' + String(e.message || e).slice(0, 100)); if (/AUTH_KEY|SESSION|UNREGISTERED|revoked/i.test(String(e.message))) { _tgc = null; if (nOnce('tgAuth')) { await tg('⚠️ TG 群组监控登入失效了，请重新执行 tg_login.bat（或在工具资料夹执行 node watch.mjs --tg-login）'); } } }
  finally { _tgBusy = false; }
}
setInterval(() => { tgGroupWatch().catch(() => {}); }, 60e3);
const grpN = (c) => Object.keys(S.grpHits?.[c]?.chats || {}).length; const grpTxt = (c) => { const n = grpN(c); return n ? `\n💬 ${n} 个 TG 群在讨论${(S.grpHits[c].names || []).length ? '（' + S.grpHits[c].names.slice(0, 3).join('、') + '）' : ''}` : ''; }; 
const paidDayUsd = (W) => { const d = new Date().toDateString(); if (!S.paidUsd || S.paidUsd.d !== d) S.paidUsd = { d }; return S.paidUsd[W.name] || 0; };
const addPaidUsd = (W, u) => { paidDayUsd(W); S.paidUsd[W.name] = (S.paidUsd[W.name] || 0) + (Number(u) || 0); save(); };
const LIMIT_NAMES = ['maxPerWallet', 'maxMintPerWallet', 'MAX_PER_WALLET', 'MAX_MINT_PER_WALLET', 'maxPerAddress', 'MAX_PER_ADDRESS', 'maxMintsPerWallet', 'walletLimit', 'mintLimit', 'perWalletLimit', 'maxPerUser', 'maxPerAccount', 'maxMintPerAddress', 'MAX_MINT_PER_ADDRESS', 'maxMintAmountPerWallet', 'maxPerAgent', 'MAX_PER_AGENT', 'maxUnitsPerWallet', 'MAX_UNITS_PER_WALLET', 'maxMintPerAgent', 'quotaPerAgent', 'baseQuota', 'BASE_QUOTA', 'maxPerID', 'perAddressLimit', 'MAX_PER_TX', 'maxPerTx', 'maxMintPerTx', 'MAX_MINT_PER_TX', 'maxMintAmountPerTx', 'maxPerTransaction']; /* 「每笔上限」也算有上限 */
const TX_LIMIT = new Set(['MAX_PER_TX', 'maxPerTx', 'maxMintPerTx', 'MAX_MINT_PER_TX', 'maxMintAmountPerTx', 'maxPerTransaction']);
async function walletLimit(c, strict = false) { /* 要有「每个钱包最多几份」规定的项目才打（特别是 NFT）——没有上限的，项目方或少数人可以无限灌 */
  S.wlim = S.wlim || {}; const ck = strict ? c + ':w' : c; if (S.wlim[ck] != null) return S.wlim[ck];
  let lim = 0; try { let code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); code = await fullCode(c, code).catch(() => code);
    for (const nm of LIMIT_NAMES) { if (strict && TX_LIMIT.has(nm)) continue; const sel = keccakHex(Buffer.from(nm + '()').toString('hex')).slice(0, 8); if (!code.includes(sel)) continue; const r = await call(c, '0x' + sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x >= 1 && x <= 10000) { lim = x; break; } } } } catch {}
  S.wlim[ck] = lim; return lim;
}
// 进度、Agent 钱包数、预算＝你的设定 bscnft.*；图片资料要真的打得开、不能重复用别人的图 ----------
async function isNft(c) { S.isNft = S.isNft || {}; if (S.isNft[c] != null) return !!S.isNft[c]; /* 读不到就丢错（呼叫的地方当 NFT 处理、下次再查），并加 ERC-165 介面检查 */
  let code = ((await rpc('eth_getCode', [c, 'latest'])) || '').toLowerCase(); if (!code || code === '0x') throw new Error('读不到合约程式码');
  code = await fullCode(c, code).catch(() => code);
  let v = /63(c87b56dd|0e89341c|6352211e|f242432a)/.test(code) || code.includes('c87b56dd') || code.includes('0e89341c') ? 1 : 0;
  if (!v) for (const iid of ['80ac58cd', 'd9b67a26']) { const r = await call(c, '0x01ffc9a7' + iid.padEnd(64, '0')).catch(() => null); if (r && /^0x0*1$/.test(r)) { v = 1; break; } }
  S.isNft[c] = v; return !!v; }
const gw = (u) => String(u || '').trim().replace(/^ipfs:\/\/(ipfs\/)?/i, 'https://ipfs.io/ipfs/').replace(/^ar:\/\//i, 'https://arweave.net/');
async function nftStrict(c) {
  S.nftOk = S.nftOk || {}; const k = S.nftOk[c]; if (k && (k.r === '' || Date.now() - k.t < 1800e3)) return k.r;
  let r = '';
  try {
    const str = (x) => { try { const b = Buffer.from(x.slice(2), 'hex'); const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + n).toString('utf8').trim(); } catch { return ''; } };
    let uri = ''; for (const [sel, id] of [['c87b56dd', 1n], ['c87b56dd', 0n], ['0e89341c', 1n], ['0e89341c', 0n]]) { const x = await call(c, '0x' + sel + w(id)); if (x && x.length > 130) { uri = str(x); if (uri) break; } }
    if (!uri) r = 'NFT 读不到图片资料';
    else {
      let meta = null;
      if (/^data:application\/json;base64,/i.test(uri)) { try { meta = JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString('utf8')); } catch {} }
      else if (/^data:application\/json/i.test(uri)) { try { meta = JSON.parse(decodeURIComponent(uri.slice(uri.indexOf(',') + 1))); } catch {} }
      else { try { const rs = await fetch(gw(uri), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) }); if (rs.ok) meta = JSON.parse((await rs.text()).slice(0, 2e5)); } catch {} }
      const img = meta && (meta.image || meta.image_url || meta.animation_url);
      if (!img) r = 'NFT 图片资料打不开或里面没有图片';
      else {
        let hash = '';
        if (/^data:image\//i.test(img)) hash = createHash('sha256').update(String(img)).digest('hex');
        else { try { const ri = await fetch(gw(img), { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); if (ri.ok) { const buf = Buffer.from(await ri.arrayBuffer()); if (buf.length > 200) hash = createHash('sha256').update(buf.subarray(0, 512e3)).digest('hex'); } } catch {} }
        if (!hash) r = 'NFT 图片打不开';
        else { /* 有人会用同一张图重复开盘 → 同一张图（内容一样）出现在别的合约就不打 */
          S.nftImg = S.nftImg || {}; const urlKey = 'u:' + gw(img).toLowerCase(); const first = S.nftImg[hash] || S.nftImg[urlKey];
          if (first && first !== c) r = `NFT 图片跟另一个合约 ${first.slice(0, 10)}… 一模一样，疑似重复用同一张图开盘`;
          else { S.nftImg[hash] = c; S.nftImg[urlKey] = c; const ks = Object.keys(S.nftImg); if (ks.length > 20000) for (const kk of ks.slice(0, 2000)) delete S.nftImg[kk]; }
        }
      }
    }
  } catch { r = 'NFT 图片检查失败'; }
  S.nftOk[c] = { t: Date.now(), r }; return r;
}
async function othersPay(c) { /* 「第一份免费、之后付费」（像牛来）要当付费看——看最近别人打它是不是大多有付 BNB */
  const opP = NR.on('bsc.othersPay') ? NR.num('bsc.othersPayPct') : null; if (opP == null) return 0; 
  S.othersPay = S.othersPay || {}; const k = S.othersPay[c]; if (k && Date.now() - k.t < 600e3) return k.v;
  let v = 0; try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - 2000).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => []);
    const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-20); if (hs.length > 0) { const txs = await rpcBatch(hs.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))); const ok = txs.filter((t) => t && String(t.to || '').toLowerCase() === c); const paid = ok.filter((t) => BigInt(t.value || '0x0') > 0n).length; if (ok.length > 0 && paid / ok.length >= opP / 100) v = 1; /* 比例＝你的设定，不另设最少几笔 */ } } catch {}
  S.othersPay[c] = { t: Date.now(), v }; return v;
}
async function freeNotify(c, name, prog, agents) { /* 免费项目大多不会真的发射、还是坏人掏钱的入口 → 不自动打，达到条件只通知，使用者要打再手动 */
  S.freeNote = S.freeNote || {}; if (S.freeNote[c]) return; S.freeNote[c] = ts(); const ks = Object.keys(S.freeNote); if (ks.length > 3000) delete S.freeNote[ks[0]];
  let nm = name; if (!nm || /[頻频]道[項项]目/.test(nm)) nm = tokStr(await call(c, '0x95d89b41')) || tokStr(await call(c, '0x06fdde03')) || c.slice(0, 10);
  const nj = await nftJunk(c).catch(() => ''); if (nj) { log(`免费项目 ${nm} 达到条件但 ${nj}，不通知`); return; }
  nm = noLink(nm);
  log(`🔔 免费项目达到条件（只通知、不自动打）：${nm} ${c}`);
  await tg(`🔔 免费项目达到你的条件（你设定只通知、不自动打）：${nm}\n进度 ${prog != null ? Math.floor(prog * 100) + '%' : '读不到'} · ${agents || 0} 个 Agent ID 钱包在打${grpTxt(c)}\n${c}\n${UPD.on ? '要打的话请自己手动铸造' : '要打的话手动处理「打 ' + nm + '」'}`);
}
async function nftJunk(c) { /* NFT 的图片连结是假的或空的（像 ipfs://sniper-test-nft/1）就不打——批量掏手续费的垃圾项目连图都没做 */
  if (!NR.on('risk.nftJunk')) return ''; 
  S.nftJunk = S.nftJunk || {}; if (S.nftJunk[c] != null) return S.nftJunk[c];
  const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); let fc = code; try { fc = await fullCode(c, code); } catch {}
  if (!fc.includes('c87b56dd')) return (S.nftJunk[c] = ''); /* 不是 NFT（没有 tokenURI） */
  const str = (r) => { try { const b = Buffer.from(r.slice(2), 'hex'); const n = Number(BigInt('0x' + b.slice(32, 64).toString('hex'))); return b.slice(64, 64 + n).toString('utf8').trim(); } catch { return ''; } };
  let uri = null; for (const id of [1n, 0n]) { const r = await call(c, '0xc87b56dd' + w(id)); if (r && r.length > 130) { uri = str(r); break; } if (r) uri = uri ?? ''; }
  if (uri == null) return ''; /* 读不到（可能还没铸出任何一个），先不判断 */
  const ok = /^data:/i.test(uri) || /^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(uri) || /^ar:\/\/[A-Za-z0-9_-]{30,}/.test(uri) || /^ipfs:\/\/(ipfs\/)?(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})/.test(uri);
  return (S.nftJunk[c] = ok ? '' : `NFT 图片连结是${uri ? '假的（' + uri.slice(0, 40) + '）' : '空的'}`);
}
/* V104-FREEPATH（用户 @yhz2004 回报）：照抄打法的付款状态 —— 'free'＝value 读得到且＝0、不付代币；'paid'＝要付 BNB 或代币；'unknown'＝读不到（不打，不当免费放行） */
function replayPayState(r) { if (!r || typeof r.data !== 'string' || !/^0x[0-9a-f]*$/i.test(r.data)) return 'unknown'; let v, pa = 0n; try { if (r.value == null || r.value === '') return 'unknown'; v = BigInt(r.value); if (r.payAmt != null && r.payAmt !== '') pa = BigInt(r.payAmt); } catch { return 'unknown'; } if (v < 0n || pa < 0n) return 'unknown'; if (r.payTok) return 'paid'; if (pa > 0n) return 'unknown'; /* 有付款数量却不知道付什么代币 */ return v > 0n ? 'paid' : 'free'; }
async function riskBlock(W, c, valWei, data, isFree, paid = false) { /* 回传不打的原因；空字串＝可以打 */
  const R = riskDay();
  { const nj = await nftJunk(c).catch(() => ''); if (nj) return nj + '，疑似垃圾项目'; }
  if (RISK.revMax != null && (R.rev[c] || 0) >= RISK.revMax) return `这个合约上链失败 ${R.rev[c]} 次，不再试（避免一直烧 gas）`;
  if (!paid && RISK.dayBnb != null && (R.spend[W.name] || 0) >= RISK.dayBnb) { if (!R.warned[W.name]) { R.warned[W.name] = 1; tg(`⚠️ [${W.name}] 今天手续费＋gas 已花 ${(R.spend[W.name]).toFixed(4)} BNB，达到每日上限 ${RISK.dayBnb} BNB，今天停止自动打（卖出不受影响）`).catch(() => {}); } return `今天手续费＋gas 已达 ${RISK.dayBnb} BNB 上限`; }
  if (isFree && RISK.freePerDay != null && !(R.free[W.name] || []).includes(c) && (R.free[W.name] || []).length >= RISK.freePerDay) return `今天已自动打 ${RISK.freePerDay} 个免费项目，达到上限`;
  const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18;
  if (bal - Number(valWei) / 1e18 < PAID.keepBnb) return PAID.keepBnb > 0 ? `BNB 低于你设的保留额 ${PAID.keepBnb}，只留给卖出用` : 'BNB 不够付这笔';
  try { const g = await rpc('eth_estimateGas', [{ from: W.addr, to: c, data, value: '0x' + BigInt(valWei).toString(16) }]); const gp = await rpc('eth_gasPrice', []); const fee = (Number(BigInt(g)) * Number(BigInt(gp))) / 1e18; const gmx = paid ? RISK.gasMaxPaid : RISK.gasMax; if (gmx != null && fee > gmx) return `预估 gas ${fee.toFixed(5)} BNB 太高`; } catch { if (isFree && RISK.gasMax != null) return '读不到 gas 预估（你开了 gas 上限），先不打'; } /*V104-FREEPATH：免费路径读不到＝不打*/
  return '';
}
function riskAfter(W, c, tx, valWei, isFree, countFee = true) { /* 送出后记帐：手续费＋实际 gas；上链失败次数 */
  const R = riskDay(); if (countFee) R.spend[W.name] = (R.spend[W.name] || 0) + Number(valWei) / 1e18; if (isFree) { const f = (R.free[W.name] = Array.isArray(R.free[W.name]) ? R.free[W.name] : []); if (!f.includes(c)) f.push(c); }
  if (!tx || !/^0x[0-9a-f]{64}$/i.test(tx)) return;
  (async () => { for (let i = 0; i < 6; i++) { await sleep(5000); const r = await rpc('eth_getTransactionReceipt', [tx]).catch(() => null); if (!r) continue; const gas = (Number(BigInt(r.gasUsed || '0x0')) * Number(BigInt(r.effectiveGasPrice || '0x0'))) / 1e18; const R2 = riskDay(); R2.spend[W.name] = (R2.spend[W.name] || 0) + gas; if (r.status === '0x0') { R2.rev[c] = (R2.rev[c] || 0) + 1; log(`[${W.name}] 上链失败（白烧 gas ${gas.toFixed(5)} BNB）：${c}，今天第 ${R2.rev[c]} 次`); } save(); return; } })().catch(() => {});
}
async function serialDev(c) { const sdN = NR.on('risk.serialDev') ? NR.num('risk.serialDevN') : null; if (sdN == null) return ''; const sdH = NR.num('risk.serialDevH'); /* 内建规矩变按键 */ const dep = (S.depFrom || {})[c]; if (!dep) return ''; /* 只用「实际送出部署交易的钱包」判断，不用 owner()（发射台的项目 owner 常是同一个平台，会误杀） */ const n = new Set(((S.devs || {})[dep] || []).filter((x) => sdH == null || Date.now() - x.t < sdH * 3600e3).map((x) => x.c)).size; return n >= sdN ? `同一个部署者 ${dep.slice(0, 10)}… ${sdH != null ? sdH + ' 小时内' : '最近'}部署了 ${n} 个项目` : ''; }
function isRepeatDev(dep) { const rN = NR.on('risk.repeatDev') ? NR.num('risk.repeatDevN') : null; if (rN == null || !dep) return false; const rH = NR.num('risk.repeatDevH'); return new Set(((S.devs || {})[dep] || []).filter((x) => rH == null || Date.now() - x.t < rH * 3600e3).map(devKey)).size >= rN; } 
function blacklist(dep, why) { if (!dep || !NR.on('risk.localBlack')) return; S.black = S.black || {}; if (!S.black[dep]) { S.black[dep] = { at: ts(), why }; log(`黑名单：${dep}（${why}）`); } }

/* 热度等级＝你的「快速检查」设定 zrQuick() */
function markUnmintable(c, P, sym, progress, why = '要官网签名或白名单') { P.lastReason = why;
  if (P.unmintable) return; P.unmintable = ts(); P.unmintableAt = Date.now();
  log(`打不了 ${c}（${sym}）：${why}`);
  if (nrOn('notify.unmintable') && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= (nrNum('notify.unmintableAg') ?? 0)) tg( /* 通知＝你的设定 */`⚠️ 很热门但工具打不了：${noLink(sym || P.name || '新项目')}（${Math.max(P.agents || 0, HOT.get(c)?.from.size || 0)} 个钱包在打${progress > 0 ? '，进度约 ' + Math.round(progress * 100) + '%' : ''}）\n原因：${why}\n要的话请自己到官网手动打\n${c}`).catch(() => {}); /* FIST 这种很热但打不了的要通知 */
}
/* 追踪多久＝你的 track.maxAgeH（空白＝一直追踪） */
function trackOk(P) { const h = nrOn('track.maxAgeH.on') ? nrNum('track.maxAgeH') : null; return h == null || Date.now() - (P?.at || 0) < h * 3600e3; }
function noteFail(c, P, sym, progress) { P.cf = (P.cf || 0) + 1; const fN = nrOn('mint.failN.on') ? nrNum('mint.failN') : null; if (fN == null) { if (P.cf % 10 === 1) log(`模拟铸造失败 ${P.cf} 次：${sym || c}（你没设「失败几次先暂停」，会一直重试）`); return; } if (P.cf >= fN) markUnmintable(c, P, sym, progress, '模拟铸造一直失败，可能已卖完、要官网签名、白名单或已关闭'); } /* 失败几次先暂停＝你的 mint.failN */
const agentCache = new Map(); // 地址 → 有没有 .ai Agent ID
const MAP_CAP = 200000, DS_CAP = 5000, NEG_TTL_MS = 6 * 3600e3; /* 运作：记忆体上限／重查间隔 */ setInterval(() => { for (const [a, v] of agentCache) if (v === false) agentCache.delete(a); if (agentCache.size > MAP_CAP) agentCache.clear(); if (NONCE.size > MAP_CAP) NONCE.clear(); if (dsCache.size > DS_CAP) dsCache.clear(); }, NEG_TTL_MS).unref(); /* 「没有」的结果过一段时间重查；快取有上限 */
async function rpcBatch(reqs) { const out = []; for (let i = 0; i < reqs.length; i += 100) { for (const u of ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc.publicnode.com']) { let got = 0; try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqs.slice(i, i + 100).map((r, k) => ({ jsonrpc: '2.0', id: i + k, ...r }))), signal: AbortSignal.timeout(20000) })).json(); for (const r of (Array.isArray(j) ? j : [])) if (r.result !== undefined) { out[r.id] = r.result; got++; } } catch {} if (got) break; } } return out; } /* 只用一个节点，被限流时整批查不到 → Agent ID 人数算成 0（GOOSE 534 人在打却显示 0） */
const NEWAG = { at: 0, set: new Set(), busy: false }, NONCE = new Map();
async function newAgents() { /* 防小号凑数：刚注册多久内的 Agent ID 钱包不算＝你的 bsc.agMinAgeH（没开＝不过滤；从 Agent ID 合约的铸造记录读，定期更新） */
  const agH = NR.on('bsc.agFilter') ? NR.num('bsc.agMinAgeH') : null; if (agH == null || agH <= 0) return new Set(); /* 刚注册多久内不算＝你的设定 */ const span = Math.ceil((agH * 3600) / BSC_BLK_S), segs = Math.ceil(span / 5000); if (NEWAG.h !== agH) { NEWAG.h = agH; NEWAG.at = 0; }
  if (NEWAG.busy || Date.now() - NEWAG.at < 15 * 60e3) return NEWAG.set; NEWAG.busy = true;
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const set = new Set(); let ok = 0;
    for (let b = head - span; b <= head; b += 5000) { const q = [{ address: '0x' + REGISTRY, fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 4999, head).toString(16), topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '0'.repeat(64)] }]; const L = await rpc('eth_getLogs', q).catch(() => logsRpc(q).catch(() => null)); if (L) { ok++; for (const l of L) if (l.topics?.[2]) set.add('0x' + l.topics[2].slice(26).toLowerCase()); } }
    if (ok >= Math.ceil((segs * 20) / 24)) { NEWAG.set = set; NEWAG.at = Date.now(); } } finally { NEWAG.busy = false; } return NEWAG.set; }
const AGTOK = { usd: null, dayUsd: null, need: 0, winMin: null, minLiqBnb: 0, maxTax: Infinity, maxBundle: Infinity, maxTop10: Infinity, minReal: 0 }; /* AI 热门代币全部＝你的设定（applySettings 读 bsc.tok*）；这里只是「没设定」：金额空＝不自动买、「至少」＝0、「最多」＝不设上限 */
const tokDayUsd = (W) => { const d = new Date().toDateString(); if (!S.tokUsd || S.tokUsd.d !== d) S.tokUsd = { d }; return S.tokUsd[W.name] || 0; };

const RADAR = { set: {}, at: 0 };
const SCHEMA = (() => { try { return JSON.parse(readFileSync(join(DIR, 'radar', 'settings_schema.json'), 'utf8')).items || []; } catch { return []; } })();
/* GATE-2 · 守护签章：允许外挂、外挂开关（plug.*.on）、手机（phone.*）、自动交易允许授权（auto.allowApproval）、预演不安全也照送（auto.sendOnPreviewFail）
   只能玩家在雷达画面按（雷达主程式跳视窗确认后，用这台电脑产生的金钥签章，存 data/guard.json；私钥用系统加密存 data/guard_key.bin）。
   引擎读设定时核对：没有签章或对不上（例如 AI／别的程式直接改档）＝当作没开，发 TG＋写 data/guard_alert.json 给画面显示 */
const GUARD_KEY = (k) => /^plug\..+\.on$/.test(k) || /^phone\./.test(k) || k === 'auto.allowApproval' || k === 'auto.sendOnPreviewFail';
const guardOn = (v) => !(v == null || v === '' || v === false || Number(v) === 0);
const guardMsg = (kind, k, v) => Buffer.from('rcr-guard-v1\n' + kind + '\n' + k + '\n' + JSON.stringify(v));
let GUARD = { mt: -1, g: null, why: '' }; const GUARD_BAD = { set: [], ok: [] }; let GUARD_SEEN = '';
const GUARD_USED = () => { try { const x = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0; return (Array.isArray(S.trades) && S.trades.length > 0) || (Array.isArray(S.dyn) && S.dyn.length > 0) || Object.values(S.paid || {}).some((P) => Object.values((P && P.done) || {}).some((v) => v && v !== 'free-notify')) || Number(S.estopAt) > 0 || !!S.guardPubBy || Number(S.guardPubAt) > 0 || (x(S.tokens) && Object.values(S.tokens).some((t) => t && (Number(t.sold) > 0 || t.posAt != null))); } catch { return true; } }; /* GUARD-FIRST：只有「真的用过」才算历史（成交／持仓／真的铸造过／按过全停／以前记过金钥）；纯扫链（lastBlock、seenMints、paid 只有通知、devs）不算 —— 以前引擎只要在雷达第一次写 guard.json 前重启过一次，全新安装也会跳「金钥换了」视窗 */
const GUARD_HIST0 = GUARD_USED(); /* 引擎启动时 watch_state 就已经有真的使用历史 */
function guardHist() { if (GUARD_HIST0 || GUARD_USED()) return true; try { if (JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8')).setupDone) return true; } catch {} for (const f of ['gate_log.jsonl', 'gate_log.prev.jsonl', 'guard_confirm.json']) { try { statSync(join(DIR, 'data', f)); return true; } catch {} } try { if (Object.keys(JSON.parse(readFileSync(join(DIR, 'data', 'plugins_ok.json'), 'utf8')) || {}).length) return true; } catch {} return false; } /* GUARD-FIRST：允许过外挂／电脑确认过金钥也算用过 */ /* 用过的雷达（设定完成／持仓／判断日志）却没记住金钥＝金钥记录被删，不是第一次安装 */
function guardPcOk(pub) { try { const c = JSON.parse(readFileSync(join(DIR, 'data', 'guard_confirm.json'), 'utf8')); const from = String(S.guardPub || ''); if (!c || c.pub !== pub || String(c.from || '') !== from) return false;
    if (!cryptoVerify(null, guardMsg('confirm', from, pub + '\n' + String(c.at || '')), createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), Buffer.from(String(c.sig || ''), 'base64'))) return false;
    S.guardPub = pub; S.guardPubBy = 'pc'; S.guardPubAt = Date.now(); save(); const note = '新金钥已由电脑确认，如果不是你本人请回「全停」';
    try { if (typeof gateLog === 'function') gateLog({ w: '', cmd: 'guardKey', kind: '电脑确认', from: 'pc', target: pub, ok: 1, why: note, checks: [['电脑视窗确认', 1], [from ? '接在原本的金钥后面' : '引擎没记住旧金钥（有历史，不是第一次安装）', 1]] }); } catch {}
    try { writeFileSync(join(DIR, 'data', 'guard_notice.json'), JSON.stringify({ at: Date.now(), by: 'pc', pub, msg: note })); } catch {} log('[守护] ' + note);
    try { Promise.resolve(tgSay('🛡 ' + note)).catch(() => {}); } catch {} return true; } catch { return false; } } /* 主程式跳系统视窗、用户按「确认是我」才会写 guard_confirm.json（用新金钥签、绑住引擎原本记住的金钥）；接受但标记「电脑确认」、写判断日志、画面提示一次、TG 通知 */
function guardLoad() { const f = join(DIR, 'data', 'guard.json'); let mt = 0; try { mt = statSync(f).mtimeMs; } catch {} if (mt === GUARD.mt) return GUARD; GUARD = { mt, g: null, why: '' };
  if (!mt) { GUARD.why = '还没在雷达画面打开过这些设定（没有 data/guard.json）'; return GUARD; }
  try { const j = JSON.parse(readFileSync(f, 'utf8')); const pub = String(j.pub || ''); if (!pub) throw new Error('没有金钥'); if (!S.guardPub && !guardHist()) { S.guardPub = pub; S.guardPubBy = 'first'; save(); } /* 真正全新安装（没有任何历史）才第一次记住这台雷达的守护金钥 */
    if (pub !== S.guardPub && !guardPcOk(pub)) { GUARD.why = S.guardPub ? '守护金钥换了（不是这台雷达原本的金钥）' : '引擎没有记住守护金钥，但这台雷达已经用过（金钥记录可能被删掉）'; GUARD.newPub = pub; return GUARD; }
    GUARD.g = { key: createPublicKey({ key: Buffer.from(pub, 'base64'), format: 'der', type: 'spki' }), set: j.set || {}, ok: j.ok || {} }; } catch (e) { GUARD.why = 'data/guard.json 读不懂：' + e.message; } return GUARD; }
function guardValid(kind, k, v) { try { const G = guardLoad().g; const r = G && Object.hasOwn(G[kind] || {}, k) ? G[kind][k] : null; if (!r || JSON.stringify(r.v) !== JSON.stringify(v)) return false; return cryptoVerify(null, guardMsg(kind, k, v), G.key, Buffer.from(String(r.sig || ''), 'base64')); } catch { return false; } }
function guardReport(kind, bad) { GUARD_BAD[kind] = bad; const all = [...GUARD_BAD.set, ...GUARD_BAD.ok]; const key = all.join(',') + '|' + (GUARD.why || ''); if (key === GUARD_SEEN) return; GUARD_SEEN = key; /* 原因变了（例如金钥被换）也要再提醒 */
  try { writeFileSync(join(DIR, 'data', 'guard_alert.json'), JSON.stringify({ at: Date.now(), keys: all, why: GUARD.why || '', whyEn: !GUARD.why ? '' : /没有 data\/guard\.json/.test(GUARD.why) ? 'These settings were never turned on in the radar window (no data/guard.json)' : /换了/.test(GUARD.why) ? 'The guard key changed (it is not this radar\'s original key)' : /没有记住/.test(GUARD.why) ? 'The engine has no saved guard key, but this radar was used before (the key record may have been deleted)' : /读不懂/.test(GUARD.why) ? 'data/guard.json could not be read' : '', newPub: GUARD.newPub || '', msg: all.length ? '这些设定不是在雷达画面改的，已当作关闭：' + all.join('、') : '' })); } catch {}
  if (!all.length) return; log('[守护] 这些设定不是在雷达画面改的，已当作关闭：' + all.join('、') + (GUARD.why ? '（' + GUARD.why + '）' : ''));
  try { Promise.resolve(tgSay(`🛡 这些设定不是在雷达画面改的，已当作关闭：${all.join('、')}${GUARD.why ? '\n原因：' + GUARD.why : ''}\n是你自己要开的：请在电脑雷达画面重新打开（会跳视窗确认）。${GUARD.newPub ? '\n只有你刚重装雷达／换电脑，才回「确认新金钥」（或在电脑雷达跳出的视窗按「确认是我」）。' : ''}`)).catch(() => {}); } catch {} }
function guardSettings(z) { guardLoad(); /* 每次读设定都核对金钥（没开任何受保护设定也要：电脑确认／金钥被换的提示才会出来） */ const bad = []; for (const k of Object.keys(z)) if (GUARD_KEY(k) && guardOn(z[k]) && !guardValid('set', k, z[k])) { bad.push(k); delete z[k]; } guardReport('set', bad); return z; }
function guardGet(kind, k) { try { const G = guardLoad().g; const r = G && Object.hasOwn(G[kind] || {}, k) ? G[kind][k] : null; return r && guardValid(kind, k, r.v) ? r.v : null; } catch { return null; } } /* 读一个有签章的值（没有／不对＝null） */
function gateEstop() { const z = radarSet(); if (z.estop) return true; if (S.estopOn !== 1) return false; const t = Number(guardGet('set', 'estop.cleared')); return !(t > 0 && t >= (S.estopAt || 0)); } /* 全停只有雷达画面「重新设定」能解除（主程式会签 estop.cleared）；把设定档改掉／删掉都解除不了 */
const GATE_ORD_FREE = new Set(['update', 'ghNote', 'health', 'lookup', 'analyze', 'rescan', 'mintHist', 'shareInfo', 'shareMint', 'previewMint']); /* 不碰钱包的单：不用签章（phoneSet 会改设定／带撤销内容 → 要签章，FR-1104） */
function gateOrdOk(o) { try { if (!o || typeof o !== 'object') return false; if (GATE_ORD_FREE.has(o.type)) return true; const { gsig, ...rest } = o; if (!gsig) return false; const G = guardLoad().g; if (!G) return false; return cryptoVerify(null, guardMsg('ord', String(o.id || ''), rest), G.key, Buffer.from(String(gsig), 'base64')); } catch { return false; } } /* 画面／手机下的单由主程式签章；直接写 data/radar_orders.json 的单不算 */
Object.defineProperty(globalThis, 'GUARD_OK', { value: Object.freeze((m) => { const o = {}, bad = []; for (const [f, h] of Object.entries(m && typeof m === 'object' ? m : {})) { if (guardValid('ok', f, h)) o[f] = h; else bad.push('允许外挂 ' + f); } guardReport('ok', bad); return o; }), writable: false, configurable: false, enumerable: false }); /* plugins.mjs 读「允许外挂」清单时用；冻结：别的程式码换不掉 */
/* GATE-2-END */
function radarSet() { if (Date.now() - RADAR.at > 15e3) { RADAR.at = Date.now(); let ok = true; try { RADAR.set = guardSettings(JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8')) || {}); /* GATE-2：没签章的敏感设定当作没开 */ RADAR.bad = 0; } catch (e) { ok = false; if (!existsSync(join(DIR, 'data', 'radar_settings.json'))) { RADAR.set = {}; ok = true; } else if (!RADAR.bad) { RADAR.bad = 1; log('设定档读不到（可能正在写入或坏掉），先照上一次读到的设定继续：' + e.message); } } if (ok) applySettings(RADAR.set); /* 设定档坏掉时不会把全部开关当成关（包括紧急全停） */ } return RADAR.set; }

/* ===== 你的设定：程式里不留任何官方／内建的设定数字；每条规则＝开关＋你自己填的数字 ===== */
const NR_FLOOR = new Set(['risk.codeScan', 'risk.needHp', 'risk.autoSkipHoneypot', 'risk.keepBnb.on', 'bsc.priceDrift', 'bsc.sharePriceGuard', 'rh.keepEth.on', 'mint.costTol']);
const NR_NEED = {"bscnft.agMax": "bscnft.agGate", "bsc.agMax": "bsc.agMin.on", "grp.progPct": "grp.on", "grp.agMin": "grp.on", "quick.progPct": "quick.on", "quick.agMin": "quick.on", "quick.grpN": "quick.on", "sell.minUsd": "sell.minUsd.on", "sell.giveUpN": "sell.giveUpN.on", "sell.pendMin": "sell.pendMin.on", "notify.sellFailMinUsd": "notify.sellFailMin.on", "notify.lowBnb": "notify.lowBnb.on", "notify.unmintableAg": "notify.unmintable", "mint.failN": "mint.failN.on", "mint.retryN": "mint.failN.on", "smart.autoN": "smart.auto", "sell.backFeePct": "sell.backFee.on", "bsc.new1hMin": "bsc.new1hMin.on", "weekly.day": "weekly.on", "weekly.hour": "weekly.on", "mine.remindHour": "mine.remind", "risk.keepBnb": "risk.keepBnb.on", "risk.minGasBnb": "risk.keepBnb.on", "risk.keepBnbPlug": "risk.keepBnb.on", "rh.keepEth": "rh.keepEth.on", "rh.minGasEth": "rh.keepEth.on", "bsc.maxPriceDrift": "bsc.priceDrift", "mint.costTolPct": "mint.costTol", "mint.costTolUsd": "mint.costTol", "risk.noPoolH": "risk.localBlack", "risk.revokeKeep": "risk.autoRevoke", "risk.serialDevN": "risk.serialDev", "risk.serialDevH": "risk.serialDev", "risk.repeatDevN": "risk.repeatDev", "risk.repeatDevH": "risk.repeatDev", "risk.firstWinH": "risk.firstOnly", "risk.probeWaitSec": "risk.probe", "risk.feeDayBnb": "risk.feeDayBnb.on", "risk.gasMaxBnb": "risk.gasMax.on", "risk.gasMaxPaidBnb": "risk.gasMax.on", "risk.revMax": "risk.revMax.on", "risk.freePerDay": "risk.freePerDay.on", "risk.dayLoss": "risk.dayLoss.on", "risk.lossStreak": "risk.lossStreak.on", "risk.hourFrom": "risk.hoursOn", "risk.hourTo": "risk.hoursOn", "bsc.realNonce": "bsc.real", "bsc.realMinBnb": "bsc.real", "bsc.earlyBlocks": "bsc.bundleDef", "bsc.freshNonce": "bsc.bundleDef", "bsc.sameAmtN": "bsc.bundleDef", "bsc.goPct": "bsc.goPct.on", "bsc.agMin": "bsc.agMin.on", "bsc.agOldNonce": "bsc.agFilter", "bsc.agMinAgeH": "bsc.agFilter", "bsc.othersPayPct": "bsc.othersPay", "bsc.nearFreeBnb": "bsc.nearFree", "bsc.maxRepeat": "bsc.maxRepeat.on", "bsc.minPoolBnb": "bsc.minPoolBnb.on", "bsc.minSold": "bsc.minSold.on", "bsc.minRaisedBnb": "bsc.minSold.on", "bsc.maxPoolShare": "bsc.maxPoolShare.on", "bsc.maxContractAgeH": "bsc.maxContractAgeH.on", "bsc.replayBumpMax": "bsc.replayBump.on", "bsc.drainMinBnb": "bsc.drainSkip", "bsc.stallH": "bsc.stallSkip", "bsc.cloneWinH": "bsc.cloneSkip", "bsc.ownerWarnPct": "bsc.ownerWarn", "bscnft.agGoPct": "bscnft.agGate", "bscnft.agMin": "bscnft.agGate", "bscnft.agUsd": "bscnft.agUsd.on", "bsc.tokNeed": "bsc.tokNeed.on", "bsc.tokWinMin": "bsc.tokNeed.on", "bsc.tokMaxAgeH": "bsc.tokMaxAgeH.on", "bsc.tokMinLiqBnb": "bsc.tokMinLiqBnb.on", "bsc.tokMaxTax": "bsc.tokMaxTax.on", "bsc.tokMaxBundle": "bsc.tokMaxBundle.on", "bsc.tokMaxTop10": "bsc.tokMaxTop10.on", "bsc.tokMinReal": "bsc.tokMinReal.on", "bsc.tokSlipMax": "bsc.tokSlip.on", "bsc.tokSlipPad": "bsc.tokSlip.on", "bsc.tokMaxPos": "bsc.tokMaxPos.on", "gen.maxPos": "gen.maxPos.on", "gen.maxAgeMin": "gen.maxAgeMin.on", "gen.minLiqUsd": "gen.minLiqUsd.on", "gen.mcMin": "gen.mcMin.on", "gen.mcMax": "gen.mcMax.on", "gen.minBuys": "gen.minBuys.on", "gen.maxTax": "gen.maxTax.on", "gen.maxBundle": "gen.maxBundle.on", "gen.maxTop10": "gen.maxTop10.on", "gen.minReal": "gen.minReal.on", "gen.washBuys": "gen.antiWash", "gen.washSells": "gen.antiWash", "gen.smartWinH": "gen.needSmart", "sell.backX": "sell.backX.on", "sell.crash": "sell.crash.on", "sell.crashAfterBack": "sell.crashAfterBack.on", "sell.steps": "sell.steps.on", "sell.moonPct": "sell.moonPct.on", "sell.freeDrop": "sell.freeDrop.on", "sell.freeDropWaitMin": "sell.freeDrop.on", "manual.defUsd": "manual.defUsd.on", "manual.maxTax": "manual.maxTax.on", "buy.splitUsd": "buy.split.on", "buy.split3Usd": "buy.split.on", "buy.retrySlip": "buy.retrySlip.on", "buy.sandWarnPct": "buy.sandWarn.on", "rh.maxPos": "rh.maxPos.on", "rh.maxAgeMin": "rh.maxAgeMin.on", "rh.minLiqUsd": "rh.minLiqUsd.on", "rh.minRealBuyers": "rh.minRealBuyers.on", "rh.oldNonce": "rh.real", "rh.minEth": "rh.real", "rh.earlySec": "rh.bundleDef", "rh.freshNonce": "rh.bundleDef", "rh.sameAmtN": "rh.bundleDef", "rh.maxBundle": "rh.maxBundle.on", "rh.blackBundlePct": "rh.blackBundle", "rh.maxTop10": "rh.maxTop10.on", "rh.maxDev": "rh.maxDev.on", "rh.maxRoundTrip": "rh.maxRoundTrip.on", "rh.mcMin": "rh.mcMin.on", "rh.mcMax": "rh.mcMax.on", "rh.washBuys": "rh.antiWash", "rh.washSells": "rh.antiWash", "rh.smartWinH": "rh.needSmart", "rh.mintMinReal": "rh.mintMinReal.on", "rh.mintWinMin": "rh.mintMinReal.on", "rh.mintMaxFresh": "rh.mintMaxFresh.on", "rh.mintFreshNonce": "rh.mintMaxFresh.on", "rh.lpDrop": "rh.lpDrop.on", "rh.bundleSellPct": "rh.bundleSellPct.on", "rh.devSellPct": "rh.devSellRun", "rh.backX": "rh.backX.on", "rh.steps": "rh.steps.on", "rh.crash": "rh.crash.on", "rh.crashAfterBack": "rh.crashAfterBack.on", "rh.timeStopMin": "rh.timeStopMin.on", "rh.timeStopX": "rh.timeStopMin.on", "rh.sellSlip": "rh.sellSlip.on", "bscnft.minReal": "bscnft.minReal.on", "bscnft.winMin": "bscnft.minReal.on", "bscnft.oldNonce": "bscnft.real", "bscnft.minBnb": "bscnft.real", "bscnft.maxFresh": "bscnft.maxFresh.on", "bscnft.freshNonce": "bscnft.maxFresh.on", "tpsl.tp": "tpsl.on", "tpsl.sl": "tpsl.on", "tpsl.trail": "tpsl.on", "gen.kolMin": "gen.kolMin.on", "gen.kolBkH": "gen.kolMin.on", "rh.kolMin": "rh.kolMin.on", "rh.kolBkH": "rh.kolMin.on"}; /* KOL-AVE */ /* 数字 → 管它的开关 */
const NR_EXCL = [["bsc.freeAuto", "bsc.freeNotify", "bsc.freeNotify"], ["xwatch.mint", "bsc.freeNotify", "bsc.freeNotify"], ["tgch.mint", "bsc.freeNotify", "bsc.freeNotify"]]; /* [甲, 乙, 两个都开时照哪个]（互斥的开关：两个都开时照「只通知」） */
const BSC_BLK_S = 0.45; /* BNB Chain 出块时间（秒），只用来把「小时」换成区块数 */
function nrRaw(k) { return radarSet()[k]; }
function nrOn0(k) { const v = nrRaw(k); if (v == null || v === '') return NR_FLOOR.has(k); return v === true || Number(v) === 1; }
function nrOn(k) { if (!nrOn0(k)) return false; for (const [a, b, safe] of NR_EXCL) { if (k !== a && k !== b) continue; const o = k === a ? b : a; if (k !== safe && nrOn0(o)) return false; } return true; }
function nrNum(k) { const sw = NR_NEED[k] ?? SCHEMA.find((i) => i.k === k)?.need; if (sw && !nrOn(sw)) return null; const v = nrRaw(k); if (v == null || v === '' || typeof v === 'boolean' || typeof v === 'object') return null; const x = Number(v); if (!Number.isFinite(x)) return null; return x; /* 照你填的用，不夹；超过工具能力（schema cap）＝警告＋照这条的「读不到时」 */ }
function nrStr(k) { const sw = NR_NEED[k] ?? SCHEMA.find((i) => i.k === k)?.need; if (sw && !nrOn(sw)) return ''; const v = nrRaw(k); return v == null || typeof v === 'object' ? '' : String(v).trim(); }
function nrSteps(k) { return nrStr(k).split(/[,，;；\s]+/).filter(Boolean).map((x) => x.split(/[:：]/).map(Number)).filter((p) => p.length === 2 && p[0] > 1 && p[1] > 0 && p[1] <= 100).sort((p, q) => p[0] - q[0]); } /* 你填几档就几档 */
const NR = { on: nrOn, num: nrNum, str: nrStr, steps: nrSteps, floor: (k) => NR_FLOOR.has(k), excl: NR_EXCL, dec: (sid, id, name, J) => nrDecLog(sid, id, name, J, 1) /* Robinhood 卖出也能写判断日志 */ };
globalThis.NR = NR;
/* 每个条件：读不到这个资料时（1 不买／2 用备用条件，备用条件的数字也是你填的）。没有「跳过这个条件」。
   底线是另一层：不参加组合，开着的底线一定要过。每次买／不买都把逐条结果写进日志（data/decisions.jsonl）。 */
const NR_SNAME = { bsc: '铸造代币（AI 项目）', tok: 'AI 热门代币', gen: '一般新币', rh: 'Robinhood 热门代币', rhmint: 'Robinhood 铸造', nft: 'BNB Chain NFT 铸造', mine: '挖矿流动性提醒', agc: 'AGC 挖矿' };
const nrFmt = (v) => (typeof v === 'number' ? (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) : v);
const nrPairK = (c) => (c.op === '>=' ? c.k + '.hi' : c.op === '<=' ? c.k + '.lo' : null); /* 另一边的 key */
function nrRange(c) { const a = nrNum(c.k), pk = nrPairK(c), b = pk ? nrNum(pk) : null; return c.op === '>=' ? { lo: a, hi: b } : { lo: b, hi: a }; }
function nrCap(k) { const it = SCHEMA.find((i) => i.k === k); const m = it?.cap?.max; return typeof m === 'number' && Number.isFinite(m) ? m : null; } /* 工具量得到的最大值（没写＝没有上限） */
function nrBeyondCap(c) { if (c.op !== '>=' && c.op !== '<=') return false; const cap = nrCap(c.k); if (cap == null) return false; const r = nrRange(c); return (r.lo != null && r.lo > cap) || (r.hi != null && r.hi > cap); }
function nrCondOn(c) { if (c.op === 'yes') return nrOn(c.k); if (c.op === '>=' || c.op === '<=') { const r = nrRange(c); return r.lo != null || r.hi != null; } return nrNum(c.k) != null; }
function nrJudge(sid, conds, opt = {}) { /* conds: [{k, name, unit, v（数字／true false；null＝读不到；undefined＝还没查）, op: '>=' | '<=' | 'yes', bk: () => ({ ok, txt }) | null}] */
  const z = radarSet(); const en = conds.filter(nrCondOn); const lines = []; const out = (buy, why) => ({ buy, why, lines, text: (lines.length ? lines.join('　') + ' → ' : '') + (buy ? '买' : '不买' + (why ? '（' + why + '）' : '')) });
  if (!en.length) return out(false, '还没设条件，不会买');
  const mode = opt.mode ?? Number(z[sid + '.combine']); if (![1, 2, 3].includes(mode)) return out(false, '还没选「条件怎么组合」，不会买');
  const need = mode === 1 ? en.length : mode === 2 ? 1 : Number(z[sid + '.combineN']);
  if (mode === 3 && !(Number.isInteger(need) && need >= 1 && need <= en.length)) return out(false, `「至少过 N 个」要重新选（现在开着 ${en.length} 个条件）`);
  let pass = 0, pend = 0;
  for (let c of en) {
    const need1 = c.op === 'yes' || c.op === 'is' ? null : nrNum(c.k), u = c.unit || '';
    if (c.v === undefined) { pend++; lines.push(`… ${c.name} 还没查`); continue; }
    if (c.v !== null && c.v !== undefined && nrBeyondCap(c)) { lines.push(`⚠️ ${c.name}：你填的数字超过工具量得到的上限（最多 ${nrFmt(nrCap(c.k))}${u}），超过的部分做不到 → 当成读不到`); c = { ...c, v: null }; } 
    if (c.v === null) {
      if (Number(z[c.k + '.miss']) === 2 && c.bk) { const b = c.bk(); if (b && b.ok != null) { lines.push(`${b.ok ? '✅' : '❌'} ${b.txt}（${c.name}读不到，用你的备用条件）`); if (b.ok) pass++; continue; } lines.push(`⚠️ ${c.name}读不到${c.missWhy ? '（' + c.missWhy + '）' : ''}，备用条件也没填好／读不到`); return out(false, c.name + '读不到'); }
      lines.push(`⚠️ ${c.name}读不到${c.missWhy ? '（' + c.missWhy + '）' : ''}${c.bk ? '（没开「读不到时用备用条件」）' : ''}`); /* 「→ 不买」由结尾统一加，不重复 */ return out(false, c.name + '读不到');
    }
    const rg = c.op === '>=' || c.op === '<=' ? nrRange(c) : null; /* 介于 lo 到 hi（只填一边＝另一边不限） */
    const ok = c.op === 'yes' || c.op === 'is' ? !!c.v : (rg.lo == null || c.v >= rg.lo) && (rg.hi == null || c.v <= rg.hi);
    lines.push(c.op === 'yes' || c.op === 'is' ? `${ok ? '✅' : '❌'} ${c.name}` : `${ok ? '✅' : '❌'} ${c.name} ${nrFmt(c.v)}${u}（你设${rg.lo != null && rg.hi != null ? '介于 ' + nrFmt(rg.lo) + ' 到 ' + nrFmt(rg.hi) : rg.lo != null ? '至少 ' + nrFmt(rg.lo) : '最多 ' + nrFmt(rg.hi)}${u}）`); if (ok) pass++;
  }
  if (pend) return out(pass + pend >= need ? null : false, pass + pend >= need ? '' : '前面的条件已经不够');
  return out(pass >= need, pass >= need ? '' : mode === 1 ? '不是全部都过' : mode === 2 ? '一个都没过' : `只过 ${pass} 个，要 ${need} 个`);
}
const NR_DLOG = new Map();
function nrDecLog(sid, id, name, J, force) { /* 逐条判断原因：同一个项目结果没变就不重复写 */
  try { const sw = { bsc: 'bsc.mintAuto', tok: 'bsc.tokAuto', gen: 'gen.auto', rh: 'rh.auto', rhmint: 'rh.mintAuto', nft: 'bscnft.auto' }[sid]; if (!force && sw && Number(radarSet()[sw]) !== 1) return; /* 策略没开就不写（不然日志会很吵） */ const key = sid + id; const sig = J.text; if (NR_DLOG.get(key) === sig) return; NR_DLOG.set(key, sig); if (NR_DLOG.size > 5000) NR_DLOG.clear();
    log(`[判断·${NR_SNAME[sid] || sid}] ${name || id}：${J.text}`);
    const f = join(DIR, 'data', 'decisions.jsonl'); appendFileSync(f, JSON.stringify({ at: Date.now(), sid, id, name: String(name || '').slice(0, 40), stage: 'cond', buy: !!J.buy, lines: J.lines, why: J.why || '' }) + '\n'); /* stage cond＝「条件通过／没过」；实际有没有买到另外写一笔 stage result（nrDecRes） */
    try { if (statSync(f).size > 3e6) { const L = readFileSync(f, 'utf8').split('\n'); writeFileSync(f + '.tmp', L.slice(-4000).join('\n')); renameSync(f + '.tmp', f); } } catch {} } catch {} /* 瘦身先写暂存档再换名（不会写一半）；技术用：档案大小 */
}
const DEC_CP = new Map(), DEC_RES = new Map(); function nrDecRes(sid, id, name, res, why) { /* 条件通过之后，实际结果（买到／结果不明／没买：额度、预演、全停、逾时…）也写进判断日志 */ try { const t = { bought: '✅ 实际买到', unknown: '⚠️ 已送出但结果不明（可能已成交）', none: '⏸ 条件都过了但没买' }[res] || res; const w = String(why || '').replace(/\n/g, ' ').slice(0, 160); const rk = sid + id, rs = res + '|' + w; if (DEC_RES.get(rk) === rs) return; DEC_RES.set(rk, rs); if (DEC_RES.size > 5000) DEC_RES.clear(); /* 同一个项目结果没变就不重复写 */ log(`[判断·${NR_SNAME[sid] || sid}] ${name || id}：${t}${w ? '：' + w : ''}`); appendFileSync(join(DIR, 'data', 'decisions.jsonl'), JSON.stringify({ at: Date.now(), sid, id, name: String(name || '').slice(0, 40), stage: 'result', res, buy: res === 'bought', lines: [t + (w ? '：' + w : '')], why: w }) + '\n'); } catch {} }
function nrDecSkip(sid, id, name, why) { if (!why) return; const last = NR_DLOG.get(sid + id) || ''; if (last.includes(why)) return; nrDecLog(sid, id, name, { buy: false, text: '不买：' + why, lines: ['⛔ ' + why], why }, 1); } /* 条件以外的「不买」（保护、读不到资料…）也写判断日志；同一个原因不重复写 */
function nrForceLog(c, name, warns, MJ) { /* 强制打一定写判断日志（不管策略开没开）：「强制打（你按的）」＋你按了仍然执行的警告＋你的条件当下的结果（只记录） */ const lines = ['强制打（你按的）', ...(warns || []).map((w) => '⚠️ 你按了「我知道风险，仍然执行」：' + w), ...(MJ?.lines?.length ? ['（你的条件当下结果，只记录：）', ...MJ.lines] : [])]; nrDecLog('bsc', c, name, { buy: true, text: lines.join('；'), lines, why: '' }, 1); }
const nrTgWhy = (J) => (J && nrOn('tg.reasons') && J.lines?.length ? '\n判断原因：\n' + J.lines.join('\n') : ''); /* 你的开关「TG 逐条列出判断原因」 */
NR.judge = nrJudge; NR.decLog = nrDecLog; NR.tgWhy = nrTgWhy;

/* ① MINTW：每个铸造项目「谁在打」— 每个钱包最早／最近在哪个区块打（data/minters.json，重开也接得上）。
   统计：AI 钱包（有 Agent ID）／一般钱包／还在查／总共、最近 1 小时新增几个、5／15／60 分钟内有几个在打。
   「最近 1 小时新增」只有在统计满 1 小时、中间没有漏看（太热、只抓到最近 800 笔）时才算得准，不然＝读不到（null）。 */
const MW_GONE_MAX = 200000; /*V104-NEW1HLB 技术用：最多记几个被丢掉的钱包（记忆体上限）；超过就不再给下限（照旧读不到），不是交易数字*/
const MINTW = new Map(); let MW_LOADED = 0, MW_SAVED = 0; const MW_F = join(DIR, 'data', 'minters.json');
function mwLoad() { if (MW_LOADED) return; MW_LOADED = 1; try { const j = JSON.parse(readFileSync(MW_F, 'utf8')); for (const [c, o] of Object.entries(j || {})) if (S.paid?.[c] && o && o.w) MINTW.set(c, { w: new Map(Object.entries(o.w)), cov: +o.cov || 0, head: +o.head || 0, gapAt: +o.gapAt || 0, since: +o.since || Date.now(), cut: o.cut ? 1 : 0, gone: new Set(Array.isArray(o.gone) ? o.gone : []), goneUnk: o.goneUnk || (o.cut && !Array.isArray(o.gone)) ? 1 : 0 }); } catch {} } /*V104-NEW1HLB：旧版截断过、没记被丢掉的钱包 → 下限不保证，照旧读不到*/
function mwSave() { if (Date.now() - MW_SAVED < 60e3) return; MW_SAVED = Date.now(); try { const o = {}; for (const [c, M] of MINTW) { if (!S.paid?.[c]) { MINTW.delete(c); continue; } o[c] = { w: Object.fromEntries(M.w), cov: M.cov, head: M.head, gapAt: M.gapAt, since: M.since, cut: M.cut || 0, gone: M.gone?.size ? [...M.gone] : undefined, goneUnk: M.goneUnk || 0 }; } writeFileSync(MW_F, JSON.stringify(o)); } catch {} }
function mwUpdate(c, P, head, span, hashes, fst, last) {
  const trunc = hashes.length >= 4000; const from = trunc && hashes.length ? hashes[hashes.length - 1][1] : head - span; const now = Date.now();
  let M = MINTW.get(c); if (!M) { M = { w: new Map(), cov: from, head, gapAt: trunc ? now : 0, since: now, cut: 0 }; MINTW.set(c, M); } else if (from > M.head + 1) M.gapAt = now; /* 这次看的范围跟上次接不起来＝中间漏看 */
  const gk = (a) => String(a).toLowerCase().slice(-12); if (!M.gone) M.gone = new Set(); /*V104-NEW1HLB：截断时被丢掉的钱包（地址后 12 码）；之后又来打＝老钱包，不算新增*/
  for (const [a, l] of last) { const f0 = fst.get(a) ?? l; const r = M.w.get(a); if (!r) M.w.set(a, [M.gone.size && M.gone.has(gk(a)) ? 0 : f0, l]); else { if (f0 < r[0]) r[0] = f0; if (l > r[1]) r[1] = l; } }
  M.head = Math.max(M.head, head);
  if (M.w.size > 6000) { const all = [...M.w.entries()].sort((x, y) => y[1][1] - x[1][1]); for (const [a] of all.slice(5000)) M.gone.add(gk(a)); if (M.gone.size > MW_GONE_MAX) { M.goneUnk = 1; M.gone.clear(); } M.w = new Map(all.slice(0, 5000)); M.cut = 1; }
  const B = (m) => Math.ceil((m * 60) / BSC_BLK_S); let ai = 0, gen = 0, unk = 0, n1 = 0, n1ai = 0, w5 = 0, w15 = 0, w60 = 0;
  for (const [a, [f0, l]] of M.w) { const k = agentCache.get(a); if (k === true) ai++; else if (k === false) gen++; else unk++; if (f0 >= head - B(60)) { n1++; if (k === true) n1ai++; } if (l >= head - B(5)) w5++; if (l >= head - B(15)) w15++; if (l >= head - B(60)) w60++; }
  const gap = M.gapAt && now - M.gapAt < 3600e3; const ok1h = M.cov <= head - B(60) && !gap && !M.cut; const lb1h = !ok1h && M.cut && !M.goneUnk && M.cov <= head - B(60) && !gap; /*V104-NEW1HLB：只因为钱包太多被截断 → 留下来的新钱包数＝「至少」下限*/
  P.mw = { ai, gen, unk, tot: M.w.size, new1h: ok1h ? n1 : null, new1hLb: lb1h ? n1 : null, new1hRaw: n1, new1hAi: n1ai, w5, w15, w60, at: now, since: M.since, part: trunc ? 1 : 0, why1h: ok1h ? '' : lb1h ? `钱包太多，只留最近 5000 个：至少 ${n1} 个（已截断）` : M.cut ? '钱包太多，只留最近 5000 个' : gap ? '最近 1 小时有一段太热、没抓完整' : '开始统计还不到 1 小时' };
  mwSave();
}
/* ② 强制打进度（data/force_status.json）：每次请求一个编号，每个阶段记时间；提早结束一定写原因 */
const FS_F = join(DIR, 'data', 'force_status.json'); const FSA = new Map(), FSWHY = new Map(), RCV = new Map();
function fsAll() { try { const j = JSON.parse(readFileSync(FS_F, 'utf8')); return j && Array.isArray(j.list) ? j : { list: [] }; } catch { return { list: [] }; } }
function fsPut(fn) { try { const D = fsAll(); fn(D); D.list = D.list.slice(-20); D.at = Date.now(); writeFileSync(FS_F, JSON.stringify(D)); } catch {} }
function fsNew(c, name, usd) { const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 4)).slice(-6).toUpperCase(); FSA.set(c, id); FSWHY.delete(c); fsPut((D) => D.list.push({ id, c, name: String(name || '').slice(0, 40), usd: Number(usd) > 0 ? Number(usd) : null, at: Date.now(), state: 'queued', st: [{ s: 'queued', at: Date.now(), t: '已排队：等目前的检查做完才开始（还没执行）' }] })); return id; }
function fsStage(c, s0, t) { const id = FSA.get(String(c || '').toLowerCase()); if (!id) return; fsPut((D) => { const r = D.list.find((x) => x.id === id); if (!r || r.state === 'done') return; r.state = 'running'; const tt = String(t || '').slice(0, 220); const L0 = r.st[r.st.length - 1]; if (L0 && L0.s === s0 && L0.t === tt) return; if (r.st.length < 40) r.st.push({ s: s0, at: Date.now(), t: tt }); }); }
function fsEnd(c, ok, t, extra = {}) { const id = FSA.get(c); if (!id) return; FSA.delete(c); fsPut((D) => { const r = D.list.find((x) => x.id === id); if (!r) return; Object.assign(r, extra, { state: 'done', ok: !!ok, reason: String(t || '').slice(0, 300), end: Date.now() }); r.st.push({ s: 'result', at: Date.now(), t: String(t || '').slice(0, 220) }); }); }
const fsW = (c, W, t) => { if (FSA.has(c)) { fsStage(c, 'wallet', `[${W.name}] ${t}`); FSWHY.set(c, t); } };
/* 付款要不要多带一点＝你的 bsc.payBufPct（单位 %）；没填＝按报价刚好付、刚好换，不多带 */
const payBufPct = () => { const p = NR.num('bsc.payBufPct'); return p != null && p > 0 ? p : 0; };
const pbF = () => 1 + payBufPct() / 100; /* 金额 × 这个＝要准备的钱 */
const pbW = (wei) => (BigInt(wei) * BigInt(Math.round((100 + payBufPct()) * 100))) / 10000n; /* 同上，wei 版（百分比换成万分位算） */
const PB_SHORT = /insufficient|not enough|underpa|too low|msg\.value|MAX_COST|wrong (amount|value|price)|incorrect (amount|value|price|payment)|invalid (amount|value|price|payment)|余额不足|不足/i; /* 只用来决定要不要在原因后面加说明，不影响打不打 */
const pbHint = (msg) => (!payBufPct() && PB_SHORT.test(String(msg || '')) ? '（付款是按报价刚好付、没多带：可能价格刚变或金额不够；要多带请填「付款多带 %」）' : '');
const pbSwapHint = () => (payBufPct() ? '' : '（BNB 是按报价刚好换 USDT、没多带，滑点后可能差一点；要多带请填「付款多带 %」）');
/* 合约的「自订错误」翻成白话（用 keccak 算 4 码，只是翻译原因，不影响打不打）；不认得的照原样显示 0x 编号 */
let CUSTOM_ERR = null; const CUSTOM_ERR_SIGS = () => Object.fromEntries([['AgentIdRequired()', '需要钱包持有 SPACE ID Agent ID'], ['InvalidPayment()', '付的金额不对'], ['IncorrectPayment()', '付的金额不对'], ['WrongPayment()', '付的金额不对'], ['InsufficientPayment()', '付的钱不够'], ['InsufficientFunds()', '付的钱不够'], ['MaxSupplyReached()', '已经铸完（总量满了）'], ['MaxSupplyExceeded()', '已经铸完（总量满了）'], ['ExceedsMaxSupply()', '已经铸完（总量满了）'], ['SoldOut()', '已经卖完'], ['ExceedsMaxPerWallet()', '这个钱包已经打到上限'], ['MaxPerWalletReached()', '这个钱包已经打到上限'], ['MaxPerWalletExceeded()', '这个钱包已经打到上限'], ['AlreadyMinted()', '这个钱包已经铸过'], ['NotStarted()', '还没开始'], ['MintNotStarted()', '还没开始'], ['MintNotActive()', '现在没开放铸造'], ['SaleNotActive()', '现在没开放'], ['MintEnded()', '铸造已经结束'], ['Paused()', '合约暂停中'], ['EnforcedPause()', '合约暂停中'], ['InvalidSignature()', '签名不对（要项目方的签名才能打）'], ['InvalidProof()', '不在白名单（证明不对）'], ['NotWhitelisted()', '不在白名单'], ['NotAllowlisted()', '不在白名单'], ['InvalidQuantity()', '数量不对'], ['ZeroAddress()', '地址是 0'], ['Unauthorized()', '没有权限'], ['OwnableUnauthorizedAccount(address)', '只有合约拥有者可以做'], ['ReentrancyGuardReentrantCall()', '重复呼叫被挡'], ['ERC20InsufficientBalance(address,uint256,uint256)', '代币余额不够'], ['ERC20InsufficientAllowance(address,uint256,uint256)', '授权额度不够']].map(([sig, zh]) => [keccakHex(Buffer.from(sig).toString('hex')).slice(0, 8), { sig: sig.replace(/\(.*$/, ''), zh }]));
function revData(e) { const d = String(e?.data?.data ?? e?.data ?? ''); if (/^0x[0-9a-fA-F]{8}/.test(d)) return d.toLowerCase(); const m = String(e?.message ?? e ?? '').match(/(?:execution reverted|data)[^0x]*?(0x[0-9a-fA-F]{8}[0-9a-fA-F]*)/i); return m ? m[1].toLowerCase() : ''; }
function revDecode(d) { const sel = d.slice(2, 10); if (sel === '08c379a0' && d.length >= 138) { try { const n = Number(BigInt('0x' + d.slice(74, 138))); return Buffer.from(d.slice(138, 138 + n * 2), 'hex').toString('utf8'); } catch {} } if (sel === '4e487b71') return '合约程式出错（panic 0x' + d.slice(-2) + '）'; if (!CUSTOM_ERR) CUSTOM_ERR = CUSTOM_ERR_SIGS(); const k = CUSTOM_ERR[sel]; /* 第一次用到才算（keccak） */ return k ? `合约拒绝：${k.zh}（${k.sig}）` : `合约拒绝：自订错误 0x${sel}`; }
const revWhy = (e) => { let r = String(e?.message ?? e ?? '').replace(/^.*?execution reverted:?\s*/i, '').replace(/\s+/g, ' ').trim(); const d = revData(e); if (d && (!r || /^0x[0-9a-fA-F]+$/.test(r) || /custom error|unknown/i.test(r) || r.toLowerCase().includes(d.slice(0, 10)))) r = revDecode(d); r = r.slice(0, 120) || '合约拒绝（没给原因）'; return r + pbHint(r); }; /* 金额不够时说明没多带 */
async function waitRc(h) { if (!/^0x[0-9a-fA-F]{64}$/.test(h || '')) return null; for (let i = 0; i < 20; i++) { await sleep(3000); const r = await rpc('eth_getTransactionReceipt', [h]).catch(() => null); if (r && r.status) return r; } return null; }
const TRANSFER_T = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function rcGot(rc, addr) { const me = '0x' + wa(addr); const g = new Set(); for (const l of rc?.logs || []) if (l.topics?.[0] === TRANSFER_T && l.topics.length === 3 && String(l.topics[2]).toLowerCase() === me) g.add(String(l.address).toLowerCase()); return g; }
const rcvOk = (W, a, c) => { const R = RCV.get(c ? W.addr + '|' + String(c).toLowerCase() : W.addr); if (!R || Date.now() - R.at > 180e3 || !R.rc) return true; return R.got.has(String(a || '').toLowerCase()); }; /* 有收据：只登记收据里真的转进这个钱包的币 */
function nrMintJ(P, prog) { return nrJudge('bsc', [
  { k: 'bsc.goPct', name: '进度', unit: '%', op: '>=', v: prog > 0 ? Math.round(prog * 1000) / 10 : null, bk: () => { const w = nrNum('bsc.heatWinMin'), a = nrNum('bsc.heatAgMin'); if (w == null || a == null) return null; if (P?.heatWin == null || P.heatWinMin !== w) return { ok: null }; return { ok: P.heatWin >= a, txt: `最近 ${w} 分钟有 ${P.heatWin} 个 Agent 钱包在打（你设至少 ${a} 个）` }; } },
  { k: 'bsc.agMin', name: P?.agTrunc ? 'Agent 钱包（现在，还在数）≥' : 'Agent 钱包（现在）', unit: ' 个', op: '>=', v: P?.agNowAt ? P.agNow : P?.heatAt ? null : undefined }, { k: 'bsc.agMax', name: P?.agTrunc ? 'Agent 钱包（现在 ≥' + (P.agNow ?? '-') + '，还在数）' : 'Agent 钱包（现在）', unit: ' 个', op: '<=', v: P?.agNowAt ? (P.agTrunc ? null : P.agNow) : P?.heatAt ? null : undefined, missWhy: P?.agNowAt && P.agTrunc ? `工具最多只能看到 ${nrCap('bsc.agMax') ?? '-'} 个（${SCHEMA.find((i) => i.k === 'bsc.agMax')?.cap?.zh || ''}），这一轮还没数完` : '' }, /* 还在数时「至少」可以先过，「最多」＝读不到 */ /* 介于 ___ 到 ___，两个都可以不填；用现在的数量 */
  (() => { const c0 = { k: 'bsc.new1hMin', name: '最近 1 小时新增钱包', unit: ' 个', op: '>=' }; const m = P?.mw; if (!m) return { ...c0, v: undefined }; if (Date.now() - (m.at || 0) > 20 * 60e3) return { ...c0, v: null }; if (m.new1h != null) return { ...c0, v: m.new1h }; if (m.new1hLb != null) { const r = nrRange(c0); const okLb = r.hi == null && r.lo != null && m.new1hLb >= r.lo; return { ...c0, name: `最近 1 小时新增钱包（≥${m.new1hLb}，已截断）`, v: okLb ? m.new1hLb : null, missWhy: okLb ? '' : r.hi != null ? `钱包太多已截断，只知道至少 ${m.new1hLb} 个，判断不了「最多」` : `钱包太多已截断，只知道至少 ${m.new1hLb} 个，还不到你设的下限（真实数字可能更多）` }; } return { ...c0, v: null }; })() ]); } /*V104-NEW1HLB：截断时用「至少 N」下限判断：下限已达到「至少」＝过；没达到或有填「最多」＝读不到（照规则不买），不默认通过*/ /* v＝null（读不到：统计不满 1 小时、太热没抓完整、太久没更新）→ 不买 */
const nrJLabel = (J) => ({ buy: J.buy === true, why: (J.lines || []).filter((l) => /^(❌|⚠️)/.test(l)).join('；') || J.why || '', at: Date.now() }); /* 给画面标「✅ 符合／❌ 不打：哪个条件没过」 */
function nrMissTg(c, P, prog, J) { /* 读不到进度、你没选「用备用条件」→ 不买，并告诉你一次 */ if (!P || P.missTg || prog > 0 || nrNum('bsc.goPct') == null || Number(radarSet()['bsc.goPct.miss']) === 2) return; P.missTg = 1; const m = `读不到进度，没开『读不到进度时用钱包数判断』，跳过：${P.name || ''} ${c}`; log(m); if (Number(radarSet()['bsc.mintAuto']) === 1) tg('⏸ ' + m + nrTgWhy(J)).catch(() => {}); }
const nrPct = (k) => { const x = nrNum(k); return x == null ? null : x / 100; };
/* 确认次数＝你的设定（没填＝1 次就算）；最小卖出金额、通知倍数、快速检查名单都只看你的设定 */
const ZR_CONF = () => { const x = nrNum('sell.confirmN'); return x != null && x >= 1 ? Math.round(x) : 1; };
const ZR_MINV = () => (nrOn('sell.minUsd.on') ? nrNum('sell.minUsd') ?? 0 : 0);
const ZR_LIST = (k) => (nrOn(k + '.on') ? nrStr(k).split(/[,，;；\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b).slice(0, 12) : []);
function zrQuick(c, P) { /* 快速检查名单＝强制打、你自己加的项目，加上你在「快速检查」设的条件（没开＝只有这两种） */ if (FORCE.has(c) || P.fromUrl || P.fromCall) return true; if (!nrOn('quick.on')) return false;
  const pg = nrNum('quick.progPct'), am = nrNum('quick.agMin'), gn = nrNum('quick.grpN'); const prog = Math.max(P.progress || 0, fpCache.get(c)?.p || 0);
  return (pg != null && prog >= pg / 100) || (am != null && Math.max(P.agents || 0, HOT.get(c)?.from.size || 0) >= am) || (gn != null && grpN(c) >= gn); }
const nrLo = (k, div = 1) => { const x = nrNum(k); return x == null ? 0 : x / div; }; /* 「至少」类：没开／没填 = 不设门槛 */
const nrHi = (k, div = 1) => { const x = nrNum(k); return x == null ? Infinity : x / div; }; /* 「最多」类：没开／没填 = 不设上限 */
const blackOn = (d) => !!d && nrOn('risk.localBlack') && !!S.black?.[d];
const agOldN = () => (nrOn('bsc.agFilter') ? nrNum('bsc.agOldNonce') ?? 0 : 0);
const tokSlip = (bt, st) => { const mx = nrNum('bsc.tokSlipMax'); if (mx == null) return 'auto'; const t = (Number.isFinite(bt) ? bt : 0) + (Number.isFinite(st) ? st : 0) + (nrNum('bsc.tokSlipPad') ?? 0); return String(Math.max(0, Math.min(mx, Math.ceil(t)))); }; 
const splitParts = (u) => { const a = nrNum('buy.splitUsd'), b = nrNum('buy.split3Usd'); return b != null && u >= b ? 3 : a != null && u >= a ? 2 : 1; };
let DRIFT_NOTE = 0; const driftWhy = (now, quoted) => { if (!nrOn('bsc.priceDrift')) return ''; const d = nrNum('bsc.maxPriceDrift'); if (d == null) { if (!DRIFT_NOTE) { DRIFT_NOTE = 1; log('底线「送出前价格又涨了就取消」开着，但没填容差＝这条不生效（填了才会检查）'); } return ''; } /* 底线开着但数字空白＝不生效（不当成 0%） */ const lim = d != null ? (quoted * BigInt(Math.round((100 + d) * 100))) / 10000n : quoted; return now > lim ? `价格刚刚涨了超过 ${d ?? 0}%（你的底线设定）` : ''; };
function nftGate(prog, P, c) { if (!nrOn('bscnft.agGate')) return ''; /* 付费 NFT 另外的门槛：照你的条件全部要过（NR.judge），逐条写判断日志 */ const ag = P?.agNowAt ? P.agNow : null, tr = !!P?.agTrunc;
  const J = nrJudge('nftg', [{ k: 'bscnft.agGoPct', name: 'NFT 进度', unit: '%', op: '>=', v: prog == null ? null : Math.round(prog * 1000) / 10 }, { k: 'bscnft.agMin', name: 'NFT Agent 钱包', unit: ' 个', op: '>=', v: ag }, { k: 'bscnft.agMax', name: 'NFT Agent 钱包', unit: ' 个', op: '<=', v: tr ? null : ag, missWhy: tr ? '还在数，没看完' : undefined }], { mode: 1 });
  if (!J.lines.length && J.buy === false) return ''; /* 门槛开着但一个数字都没填＝没有门槛 */ if (c) nrDecLog('nft', c, P?.name, J, 1); return J.buy === true ? '' : 'NFT 门槛：' + J.text; }
const nftBud = () => (nrOn('bscnft.agUsd.on') && nrNum('bscnft.agUsd') != null ? nrNum('bscnft.agUsd') : PAID.maxUsd);
globalThis.NR_WLIMIT = (c, strict) => walletLimit(c, strict); globalThis.NR_NFTSTRICT = (c) => nftStrict(c); /* 给 bscnft.mjs 用：NFT 也可以套「每个钱包上限」「图片检查」 */
function applySettings(set) { /* 全部照你的设定（data/radar_settings.json）。没开／没填 → 「至少」类当作不设门槛、「最多」类当作不设上限、金额没填就不自动买。程式里没有任何预设数字 */
  GO_PCT = nrLo('bsc.goPct', 100); AG_MIN = Math.round(nrLo('bsc.agMin'));
  AGTOK.usd = nrNum('bsc.tokUsd'); AGTOK.dayUsd = nrNum('bsc.tokDayUsd'); AGTOK.winMin = nrNum('bsc.tokWinMin'); AGTOK.need = nrNum('bsc.tokNeed') != null && AGTOK.winMin != null ? Math.round(nrNum('bsc.tokNeed')) : 0;
  AGTOK.minLiqBnb = nrLo('bsc.tokMinLiqBnb'); AGTOK.maxTax = nrHi('bsc.tokMaxTax'); AGTOK.maxBundle = nrHi('bsc.tokMaxBundle', 100); AGTOK.maxTop10 = nrHi('bsc.tokMaxTop10', 100); AGTOK.minReal = Math.round(nrLo('bsc.tokMinReal'));
  RULE.backX = nrHi('sell.backX'); RULE.crash = nrHi('sell.crash', 100); RULE.crashAfterBack = nrHi('sell.crashAfterBack', 100); RULE.steps = nrSteps('sell.steps'); RULE.moonPct = nrNum('sell.moonPct') ?? 0; RULE.drop = nrHi('sell.freeDrop', 100); RULE.dropWaitMin = nrNum('sell.freeDropWaitMin') ?? 0;
  FLAP_BAN = nrOn('risk.flapBan');
  globalThis.RH_APPLY?.(set, SCHEMA);
}
setInterval(() => { try { radarSet(); } catch {} }, 15e3).unref();
const BINDF = join(DIR, 'data', 'bind.json'); let BJ = { at: 0, ok: false };
function bindJoinOk() { if (Date.now() - BJ.at < 10e3) return BJ.ok; BJ.at = Date.now(); const c = String(radarSet()['ref.code'] || '').toLowerCase(); try { const B = JSON.parse(readFileSync(BINDF, 'utf8')); BJ.ok = !!(B.join?.sig && B.join.code === c && WALLETS.some((w) => w.addr === B.join.wallet)); } catch { BJ.ok = false; } return BJ.ok; } /* 邀请码要用钱包签好名才算数 */ /*RISK-FIX 4：雷达里任何一个还在的钱包签的都算（删掉第一个钱包不会锁住） */
function lockWhy() { /*RISK-FIX 4：锁住的原因（画面／TG 讲清楚） */ if (CONFL) return '（另一个雷达正在用同一个钱包：' + CONFL + '）'; try { const B = JSON.parse(readFileSync(BINDF, 'utf8')); if (B.join?.sig && !WALLETS.some((w) => w.addr === B.join.wallet)) return '（绑定邀请码的钱包已经从雷达删除，雷达正在用现在的第一个钱包重新签名：不花钱、不送交易）'; if (B.err) return '（钱包签名没成功：' + String(B.err).slice(0, 80) + '）'; } catch {} return ''; }
/* 同一台电脑开了两个雷达又用同一个钱包 → 会重复下单。全电脑共用一个锁：先开的那个照常，后开的自动停买并提醒 */
const LOCKD = join(process.env.USERPROFILE || process.env.HOME || DIR, '.robincat'); let CONFL = '';
function otherEngine() { for (const W of WALLETS) { try { const o = JSON.parse(readFileSync(join(LOCKD, W.addr + '.json'), 'utf8')); if (o.dir !== DIR && Date.now() - (o.at || 0) < 90e3) return o.dir || '?'; } catch {} } return ''; }
function lockBeat() { try { mkdirSync(LOCKD, { recursive: true }); const other = otherEngine(); if (!other) for (const W of WALLETS) writeFileSync(join(LOCKD, W.addr + '.json'), JSON.stringify({ dir: DIR, pid: process.pid, at: Date.now() }));
    const cf = join(DIR, 'data', 'conflict.json'); if (other) { writeFileSync(cf, JSON.stringify({ dir: other, at: Date.now() })); if (CONFL !== other) { CONFL = other; log('⚠️ 同一个钱包已经有另一个罗宾猫雷达在跑（' + other + '），这个先停买'); tgSay('⚠️ 你的电脑同时开了两个罗宾猫雷达，而且用同一个钱包（另一个在：' + other + '）。为了不重复下单，这个已经自动停买。请关掉旧的那个。').catch(() => {}); } } else { CONFL = ''; if (existsSync(cf)) unlinkSync(cf); } } catch {} }
setTimeout(lockBeat, 3000); setInterval(lockBeat, 30e3);
const OWNER_OK = (() => { let v = null; return () => { if (v !== null) return v; v = false; try { const R = createRequire(import.meta.url)('./repo.cjs'); const sg = Buffer.from(readFileSync(join(DIR, '.sign', 'owner.sig'), 'utf8').trim(), 'base64'); v = !!R.PUB_OK && sg.length === 64 && cryptoVerify(null, Buffer.from('rcr-owner-v1:' + R.OWNER), createPublicKey({ key: Buffer.from(R.PUBKEY, 'base64'), format: 'der', type: 'spki' }), sg); } catch {} return v; }; })(); /* 作者本人版：.sign/owner.sig 要用官方公钥验得过（只有资料夹不算） */
const LOCKED = () => !!CONFL || existsSync(join(DIR, 'radar', 'main.cjs')) && !OWNER_OK() && !bindJoinOk(); /* 开源版：没完成邀请绑定 → 雷达手动单、TG 买卖指令全部挡掉 */
/* 官方远端停买（remote.json 的 kill）已经拿掉：官方不能远端控制你的工具。签名公告只是文字，不改任何设定 */

const hoursBlock = () => { if (!NR.on('risk.hoursOn')) return false; const f0 = NR.num('risk.hourFrom'), t0 = NR.num('risk.hourTo'); if (f0 == null || t0 == null) { if (!HB_BAD) { HB_BAD = 1; log('⚠️ 你开了「只在这几点自动买」但几点到几点没填 → 读不到＝自动买先不动，请到设定填好（RVFIX E6）'); } return true; } if (!(Number.isInteger(f0) && f0 >= 0 && f0 <= 23 && Number.isInteger(t0) && t0 >= 1 && t0 <= 24)) { if (!HB_BAD) { HB_BAD = 1; log('⚠️ 自动买时段设定不合法（几点到几点要是 0–23／1–24 的整数）→ 自动买先不动，请到设定改'); } return true; } HB_BAD = 0; const f = f0, t = t0; const h = new Date().getHours(); return f < t ? !(h >= f && h < t) : !(h >= f || h < t); }; let HB_BAD = 0; /* 不夹数字：超出范围＝设定不合法，自动买不动 */
setInterval(() => { try { const n = Math.floor(NR.num('risk.lossStreak') ?? 0); /* 没开／没填 = 不用 */ if (!(n > 0) || existsSync(join(DIR, 'data', 'pause_buy.txt'))) return; const since = +S.streakAt || 0; const sells = readFileSync(join(DIR, 'data', 'journal.jsonl'), 'utf8').split('\n').slice(-500).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && x.side === '卖' && +x.cp > 0 && x.usd != null && (x.at || 0) > since && !(x.manual && Number(radarSet()['risk.lossManual']) !== 1)); 
  const last = sells.slice(-n); if (last.length < n || !last.every((x) => (+x.usd || 0) < +x.cp)) return; S.streakAt = Date.now(); save(); writeFileSync(join(DIR, 'data', 'pause_buy.txt'), String(Date.now())); log(`连续亏了 ${n} 笔，自动暂停买入`); tgSay(`⏸ 连续亏了 ${n} 笔，已自动暂停买入（卖出照常）。看过没问题再到雷达按「▶ 恢复」，或在 TG 打「恢复」`).catch(() => {}); } catch {} }, 60e3);
/* 🎁 空投与每日任务 — 用户在雷达记的「每天要做」的任务，晚上 8 点还没打勾就在 TG 提醒一次 */
const TASK_PER_MSG = 30; /* 技术用：一则讯息列几个（TG 单则长度） */ setInterval(() => { try { const d = new Date(); if (!atHour('report.taskHour')) return; const day = d.toDateString(); if (S.taskRemind === day) return; const T = (radarSet().tasks || []).filter((x) => x && x.daily && x.done !== new Date(Date.now() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10)); S.taskRemind = day; save(); if (!T.length) return; (async () => { for (let i = 0; i < T.length; i += TASK_PER_MSG) await tgSay((i ? '（续）' : '🎁 今天还没做的每日任务：') + '\n' + T.slice(i, i + TASK_PER_MSG).map((x) => '☐ ' + String(x.name).slice(0, 40)).join('\n') + (i + TASK_PER_MSG >= T.length ? '\n做完到雷达「🎁 空投」页打勾' : '')).catch(() => {}); })(); /* 全部列出，太多分几则发 */ } catch {} }, 5 * 60e3);
const ESTOP = () => gateEstop(); /* 🛑 紧急全停＝不能买、只能卖（照设定卖或手动卖）；要重新设定才能打开 */
function tpslNorm(o) { if (!o || typeof o !== 'object') return null; let tp = Array.isArray(o.tp) ? o.tp : String(o.tp || '').split(/[,，\s]+/).filter(Boolean).map((x) => x.split(/[:：]/)); tp = tp.map((p) => [Number(p[0]), Number(p[1])]).filter(([u, p]) => u > 0 && p > 0 && p <= 100).sort((p, q) => p[0] - q[0]); /* 你填几档就几档 */ const sl = Math.min(99, Math.max(0, Number(o.sl) || 0)), trail = Math.min(99, Math.max(0, Number(o.trail) || 0)); if (!tp.length && !sl && !trail) return null; return { tp, sl, trail }; }
const TPSL_DEF = () => { const z = radarSet(); return Number(z['tpsl.on']) === 1 ? tpslNorm({ tp: z['tpsl.tp'], sl: z['tpsl.sl'], trail: z['tpsl.trail'] }) : null; }; /* 像其他平台一样，手动买时设的止盈止损，买到后照这个卖（紧急全停时也照卖） */
const tpslTxt = (T) => T ? [...(T.tp || []).map(([u, p]) => `涨 ${u}% 卖 ${p}%`), T.sl ? `跌 ${T.sl}% 全卖` : '', T.trail ? `从最高回落 ${T.trail}% 全卖` : ''].filter(Boolean).join('、') : '';
function forceTag(W) { const now = Date.now(); for (const t of S.dyn || []) if (t.only === W.addr && !t.src && now - (t.boughtAt || 0) < 5 * 60e3) { t.src = 'force'; const T = TPSL_DEF(); if (T) t.tpsl = T; } }

const CSE_SEL = { pause: ['8456cb59', '16c38b3c', '1031e36e', 'c2e5ec04', 'f275f64b', '8f70ccf7', '7185f163', 'e01af92c'], blacklist: ['f9f92be4', '455a4396', '153b0d1e', '44337ea1', '9cfe42da', '9c0db5f3', 'd34628cc', '00b8cf2a', '342aa8b5', 'a0e38492', 'fb2f3492', 'ca6507af', '8d1fdf2f', 'e724529c'], upgrade: ['3659cfe6', '4f1ef286', 'd784d426'] };
const CSE_RPC = { bsc: ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io'], robinhood: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com'] };
const CSE = new Map();
async function cseRpc(net, method, params) { for (const u of CSE_RPC[net]) { try { const j = await (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(8000) })).json(); if (j && 'result' in j) return j.result; } catch {} } return null; }
async function codeRisk(net, addr) { /* 回传要挡的原因（空字串 = 没问题或读不到） */
  if (Number(radarSet()['risk.codeScan']) === 0) return ''; addr = String(addr).toLowerCase(); const k = net + addr, c = CSE.get(k); if (c && Date.now() - c.at < 30 * 60e3) return c.why;
  let why = '', unread = 0; try { const code0 = await cseRpc(net, 'eth_getCode', [addr, 'latest']); /* 底线开着、资料读不到＝不买 */ if (code0 == null) { unread = 1; why = '代码扫描：读不到合约程式码（节点没回应），底线开着 → 不买'; } let code = String(code0 || '0x').toLowerCase(); if (code0 != null && code.length <= 2) why = '代码扫描：这个地址没有合约程式码 → 不买';
    if (code.length > 2) { const slot = await cseRpc(net, 'eth_getStorageAt', [addr, '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc', 'latest']); if (slot == null) { unread = 1; why = '代码扫描：读不到是不是可升级合约（节点没回应），底线开着 → 不买'; } const proxy = !!(slot && /^0x0*[1-9a-f]/.test(slot));
      if (proxy) { const ic = String(await cseRpc(net, 'eth_getCode', ['0x' + String(slot).slice(-40), 'latest']) || '').toLowerCase(); if (ic.length > 2) code += ic.slice(2); }
      const ow = await cseRpc(net, 'eth_call', [{ to: addr, data: '0x8da5cb5b' }, 'latest']); const owner = ow && ow.length >= 66 ? '0x' + ow.slice(26, 66) : ''; const live = !(owner && /^0x(0{40}|0{36}dead)$/.test(owner));
      const has = (g) => CSE_SEL[g].some((x) => code.includes('63' + x)); const bad = [];
      if (proxy) bad.push('可升级合约（随时能换掉程式）'); else if (live && has('upgrade')) bad.push('可升级');
      if (live && has('pause')) bad.push('项目方能冻结交易'); if (live && has('blacklist')) bad.push('项目方能拉黑钱包');
      if (bad.length) why = '代码扫描：' + bad.join('、'); } } catch { unread = 1; why = why || '代码扫描：读取出错，底线开着 → 不买'; } 
  if (!unread) CSE.set(k, { at: Date.now(), why }); if (CSE.size > 500) CSE.delete(CSE.keys().next().value); return why; }
globalThis.CODE_RISK = codeRisk;
const MANUAL_OFF = () => Number(radarSet()['manual.buy']) === 0; /* 重新设定时没打开「手动买卖」 */
const buyBlock = () => NO_WALLET() ? '👛 雷达还没连钱包：现在只能看，不能买卖。请到电脑雷达「设定 → 钱包」新增并连接钱包' : ESTOP() ? '🛑 紧急全停中，不能买（只能卖）。要买请在电脑雷达右上角按「重新设定」' : MANUAL_OFF() ? '🔒 手动买已关闭。要用请在电脑雷达右上角按「重新设定」把「手动买卖」打开' : '';
const radarOff = () => NO_WALLET() || ESTOP() || LOCKED() || hoursBlock() || !!CONFL || existsSync(join(DIR, 'data', 'pause_buy.txt')) || !nrOn('auto') || !radarSet().setupDone; /* RVFIX 7：总开关 auto 接受 true／1 */ /* 自动买／自动铸造总开关 auto（预设关，雷达右上角「自动买」）；全停、没完成邀请绑定、暂停、还没完成第一次设定 → 自动的都不动（卖出照常） */
function estopSet(by) { const sf = join(DIR, 'data', 'radar_settings.json'); let z = null, zf = ''; for (const f of [sf, sf + '.bak']) { try { const o = JSON.parse(readFileSync(f, 'utf8')); if (o && typeof o === 'object') { z = o; zf = f; break; } } catch {} } if (!z) { z = {}; log('全停：设定档读不到（也没有备份），用空设定写入全停'); } /* 设定档坏掉也一定要写进全停 */ try { if (!z.estop) { z.estop = { at: Date.now(), by }; z.auto = false; try { if (zf === sf) copyFileSync(sf, sf + '.bak'); } catch {} /* 设定档坏掉时不要拿坏的盖掉备份 */ writeFileSync(sf + '.tmp' + process.pid, JSON.stringify(z, null, 1)); renameSync(sf + '.tmp' + process.pid, sf); /* 先写暂存档再换名（不会写一半）；留 .bak */ estopReassert(by); } } catch (e) { log('全停写入失败 ' + e.message); } RADAR.at = 0; estopWatch(); return ESTOP(); }
const ESTOP_RECHECK_MS = [1000, 2000, 3000, 5000, 8000]; /* 运作：全停写入后重读确认的时间点 */
function estopReassert(by, n = 0) { /* RVFIX E7：设定档可能同时被雷达主程式用旧副本整个写回（双写）→ 全停写进去后几秒内重读，不见了就再写一次 */ if (n >= ESTOP_RECHECK_MS.length) return; setTimeout(() => { try { const z = JSON.parse(readFileSync(join(DIR, 'data', 'radar_settings.json'), 'utf8')); if (z && typeof z === 'object' && !z.estop) { log('🛑 全停刚写进设定档就被别的程式盖掉了（设定档双写），再写一次'); estopSet(by); return; } } catch {} estopReassert(by, n + 1); }, ESTOP_RECHECK_MS[n]).unref(); }
function estopMsg(by) { return `🛑 已紧急全停${by ? '（' + (by === 'TG' ? '在 TG 按的' : '在电脑上按的') + '）' : ''}。\n• 不会再买任何东西（自动买、手动买、强制打、挖矿、TG 买都关了）\n• 已经买的币照你设定的止盈止损继续卖，你也可以随时手动卖（TG 打「卖 币名」）\n• 要重新开始：在电脑雷达右上角按「重新设定」`; }
let ESTOP_SEEN = null;
function estopWatch() { const on = ESTOP(); if (ESTOP_SEEN === null) { ESTOP_SEEN = on; S.estopOn = on ? 1 : 0; return; } if (on === ESTOP_SEEN) return; ESTOP_SEEN = on;
  if (on) { /* 刚全停：清掉排队中的买单 */ const n0 = FORCE.size + (S.forceAdd || []).length; FORCE.clear(); S.forceAdd = []; S.forceUsd = {};
    S.estopOn = 1; S.estopAt = Date.now(); S.estopCleared = n0; save(); log(`🛑 紧急全停：不再买；清掉排队中的买单 ${n0} 笔；持仓照止盈止损卖`); const by = radarSet().estop?.by; if (by !== 'TG') tgSay(estopMsg(by || 'radar')).catch(() => {}); }
  else { S.estopOn = 0; save(); log('▶ 重新设定完成，解除紧急全停'); tgSay('▶ 雷达已重新设定，解除紧急全停。只有你刚刚打开的功能会动。').catch(() => {}); } }
const SELF_FILE = fileURLToPath(import.meta.url);
const APPR_PAGE = 100; /* 币安钱包授权清单一次读几笔（API 分页大小） */ const ORD_SEEN = new Set(); let LK_SEQ = 0; /* 只保留最新一次搜寻的结果 */
async function radarOrders() {
  const q = join(DIR, 'data', 'radar_orders.json'); if (!existsSync(q)) return;
  const tmp = q + '.run'; try { renameSync(q, tmp); } catch { return; }
  let arr = []; try { arr = JSON.parse(readFileSync(tmp, 'utf8')) || []; } catch {} try { unlinkSync(tmp); } catch {}
  for (const o of arr) { /* 读到的单全部处理，不丢 */
    ACK.enterWith({ ack: o.ack === true || o.ack === 1, appr: o.ackAppr === true || o.ackAppr === 1, id: o.id ? String(o.id).slice(0, 60) : '' , src: o.src === 'phone' ? 'phone' : 'radar' }); /* id＝这张单的结果要写回画面 */ /* 雷达／手机下的单＝手动；ack＝你按了「仍然执行」 */
    if (o.id) { if (ORD_SEEN.has(o.id)) continue; ORD_SEEN.add(o.id); if (ORD_SEEN.size > 500) ORD_SEEN.delete(ORD_SEEN.values().next().value); } if (!gateOrdOk(o)) { const m = `❌ 这张单（${String(o.type || '?').slice(0, 20)}）没有雷达画面的签章，没执行：不是在雷达画面／手机下的单（有程式直接写 data/radar_orders.json？）`; log(m); ordResNote(m); await tgSay('🛡 ' + m).catch(() => {}); continue; } /* GATE-2：下单档要有主程式签章 */ 
    if (o.src === 'phone') { const pr = await phoneGate(o).catch((e) => '❌ 手机下单检查出错，没执行：' + String(e.message || e).slice(0, 80)); if (pr) { log('📱 手机下单没执行：' + pr); await tgSay('📱 ' + pr).catch(() => {}); continue; } } { const gst = ACK.getStore(); if (gst && o.src === 'phone') gst.phoneOk = 1; } /* GATE-1：手机单过了 phoneGate 才能送 */ /* 手机来的单：引擎自己再挡一次（不只靠画面） */
    if (o.type === 'update') { const m = await doUpdate().catch((e) => '⚠️ 更新出错：' + String(e.message || e).slice(0, 100)); try { writeFileSync(join(DIR, 'data', 'update_result.json'), JSON.stringify({ at: Date.now(), msg: m })); } catch {} log(m); await tgSay('🔄 ' + m).catch(() => {}); continue; }
    if (o.type === 'health') { (async () => { /* 🩺 钱包健检 — 余额够不够付手续费、有没有给不认识的合约授权、持仓有没有归零的 */ const out = { at: Date.now(), w: [] };
        for (const W of WALLETS) { const it = { name: W.name, addr: W.addr, warn: [], ok: [] };
          try { it.bnb = Number(big(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; { const kb = NR.num('risk.keepBnb'); kb != null && it.bnb < kb ? it.warn.push(`BNB 只剩 ${it.bnb.toFixed(4)}，低于你设的保留 ${kb}`) : it.ok.push(`BNB ${it.bnb.toFixed(4)}`); } } catch {}
          try { it.usdt = Number(await usdtFree(W)) / 1e18; } catch {}
          try { if (RH?.ethBal) { it.eth = await RH.ethBal(W.addr); if (it.eth != null) { const ke = NR.num('rh.keepEth'); ke != null && it.eth < ke ? it.warn.push(`Robinhood 上 ETH 只剩 ${it.eth.toFixed(5)}，低于你设的保留 ${ke}`) : it.ok.push(`Robinhood ETH ${it.eth.toFixed(5)}`); } } } catch {}
          try { const r = await W.baw(['approvals', 'list', '--limit', String(APPR_PAGE)]); if (r.j?.success) { const L = r.j?.data?.list || []; const unk = L; it.appr = L.length; it.apprMore = L.length >= APPR_PAGE ? 1 : 0; it.unk = unk.map((x) => ({ tok: x.tokenSymbol || String(x.tokenContract || '').slice(0, 10), sp: String(x.spenderName || x.spenderLabel || x.spender || '').slice(0, 42), amt: String(x.amount ?? x.allowance ?? '').slice(0, 24) })); unk.length ? it.warn.push(`还开着 ${unk.length} 笔授权${it.apprMore ? '（一次只读得到这么多，可能还有更多）' : ''}，列在下面；不是你给的话，到 revoke.cash 取消`) : it.ok.push('没有开着的授权'); } else it.warn.push('读不到授权清单（钱包连线可能断了，到「设定 → 钱包」重新连接）'); } catch {}
          it.nWarn = it.warn.length; /* 不打官方分数，只给要注意的项目数 */ out.w.push(it); }
        try { writeFileSync(join(DIR, 'data', 'health.json'), JSON.stringify(out)); } catch {} })().catch(() => {}); continue; }
    if (o.type === 'ghNote') { const tx = String(o.text || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').slice(0, 600); log(tx.split('\n')[0]); await tgSay(tx).catch(() => {}); continue; } /* GHM-1104：GitHub 观察的提醒（你开了通知才会有），只是通知，不是下单 */
    if (o.type === 'phoneSet') { const tx = String(o.text || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 1500); log('📱 手机改了设定：' + tx); const code = phUndoAdd(o.prev, o.apply, tx); await tgSay('📱 手机改了设定：' + tx + (code ? `\n不是你改的或想改回来：回「撤销 ${code}」（${PH_UNDO_TTL / 3600e3} 小时内有效）` : '')).catch(() => {}); continue; } /* 只是通知（设定已经由电脑雷达检查、写好），不是下单 */
    if (NO_WALLET() && !['addWallet', 'removeWallet', 'analyze', 'mintHist', 'lookup'].includes(o.type)) { log('👛 还没有钱包，雷达下单被挡：' + o.type); await tgSay('👛 雷达还没连钱包：现在只能看，不能买卖。请到电脑雷达「设定 → 钱包」新增并连接钱包').catch(() => {}); continue; } /* UIFIX4 */
    if (!['addWallet', 'removeWallet', 'analyze', 'mintHist'].includes(o.type) && LOCKED()) { log('🔒 还没完成邀请绑定，雷达下单被挡：' + o.type); await tgSay('🔒 还没完成邀请码绑定' + lockWhy() + '：现在只能看，不能买卖。请在雷达填邀请码、完成绑定') /*RISK-FIX 4*/.catch(() => {}); continue; } 
    if (o.type === 'addWallet' || o.type === 'removeWallet') { const f = join(DIR, 'data', 'radar_wallets_cfg.json'); const cfg = { add: [], hidden: [], ...WCFG }; const a = String(o.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
      if (o.type === 'addWallet') { cfg.hidden = (cfg.hidden || []).filter((x) => x !== a); if (!WALLETS.some((w) => w.addr === a) && !cfg.add.some((w) => w.address.toLowerCase() === a)) { const id = 'w' + Date.now().toString(36); cfg.add.push({ name: String(o.name || 'wallet').replace(/[^\w.\-\u4e00-\u9fff]/g, '').slice(0, 30) || 'wallet', address: a, bawDir: 'baw_' + id, instanceId: 'radar-' + id }); } }
      else { const held = (S.dyn || []).filter((t) => t.only === a && !t.closed).length; if (WALLETS.filter((w) => w.addr !== a).length < 1) { await tgSay('❌ 没有删除：至少要留一个钱包').catch(() => {}); continue; } cfg.add = cfg.add.filter((w) => w.address.toLowerCase() !== a); if (!cfg.hidden.includes(a)) cfg.hidden.push(a); if (held) await tgSay(`⚠️ 已移除钱包 ${a.slice(0, 8)}…，它还有 ${held} 个持仓，雷达之后不会再帮它卖，请自己处理`).catch(() => {}); }
      writeFileSync(f, JSON.stringify(cfg, null, 1)); Object.assign(WCFG, cfg); const wr = walApply(o.type, a, cfg); log(`雷达${o.type === 'addWallet' ? '新增' : '移除'}钱包 ${a}（立即生效）`); await tgSay(wr).catch(() => {}); continue; } /* UIFIX4：钱包名单在引擎里立刻生效（不靠重新启动） */
    if (o.type === 'lookup') { const seq = ++LK_SEQ; (async () => { 
      const q = String(o.q || '').trim().slice(0, 300); const out = { q, at: Date.now(), found: [], err: '' }; let cs = [];
      try { const inUrl = [...new Set((q.match(/0x[0-9a-fA-F]{40}/g) || []).map(x => x.toLowerCase()))]; if (inUrl.length) cs = inUrl; else { let u = q; if (!/^https?:\/\//i.test(u)) u = 'https://' + u; const host = new URL(u).hostname.toLowerCase().replace(/^www\./, ''); const r = await Promise.race([siteScan(host, u).catch(() => ({ cs: [] })), new Promise((ok) => setTimeout(() => ok({ cs: [], slow: 1 }), 12e3))]); if (r.slow) out.err = '这个网站读太久，请改贴合约地址'; cs = r.cs || []; out.title = r.title || ''; if (!cs.length && !out.err) out.err = '这个网址里找不到合约地址'; } } catch (e) { out.err = '格式不对：请贴合约地址（0x 开头 42 码）或网址'; }
      const LKF = join(DIR, 'data', 'radar_lookup.json'); const quick = []; const W_ = (v) => { if (seq === LK_SEQ) writeFileSync(LKF, JSON.stringify(v)); }; W_({ ...out, partial: 1 });
      const str = (r) => { try { const h = r.slice(2); const len = Number(BigInt('0x' + h.slice(64, 128))); return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/[\u0000-\u001f]/g, '').slice(0, 60); } catch { return ''; } };
      let hostW = ''; try { hostW = new URL(/^https?:/i.test(q) ? q : 'https://' + q).hostname.replace(/^www\./, '').split('.')[0].toLowerCase(); } catch {}
      out.found = await Promise.all(cs.map(async (c) => { try { const code = await rpc('eth_getCode', [c, 'latest']).catch(() => '0x'); const rhCode = await cseRpc('robinhood', 'eth_getCode', [c, 'latest']).catch(() => null); const onRh = !!rhCode && rhCode !== '0x'; if (!code || code === '0x') return { c, kind: 'wallet', why: onRh ? '这是 Robinhood 链的合约（BNB Chain 上没有）：请到「AI专属 → Robinhood」看，或直接在 Robinhood 看盘找' : 'BSC 上这不是合约（一般钱包，或是别条链的合约）' };
        const name = str(await call(c, '0x06fdde03')), sym = str(await call(c, '0x95d89b41')); const isTok = !!(await call(c, '0x313ce567')) && !!sym;
        const nm = `${name} ${sym}`.toLowerCase(); const hw = hostW.replace(/[^a-z0-9]/g, ''); const self = !!nm.trim() && !!hw && nm.replace(/[^a-z0-9]/g, '').includes(hw); /* 事实＝合约名称里有这个网址的名字 */
        const P = S.paid?.[c]; const base = { c, name: name || P?.name || '', sym, self, tracked: !!P, ...(onRh ? { why: '⚠️ 同一个地址在 Robinhood 链上也有合约，这里显示和操作的都是 BNB Chain 的，确认是你要的那条链' } : {}) };
        if (P) { base.prog = Math.round((P.progress || 0) * 100); base.ag = P.agents || 0; base.why = String(P.lastReason || '').slice(0, 80); base.no = !!P.unmintable || /不打/.test(base.why); /* 引擎自己记的「不打」 */ }
        if (isTok) return { ...base, kind: 'token' };
        quick.push({ ...base, kind: 'checking' }); W_({ ...out, found: quick.slice(), partial: 1 });
        const ff = await Promise.race([(async () => findFree(WALLETS[0]?.addr || '0x000000000000000000000000000000000000dEaD', c, await fullCode(c, code).catch(() => code)))().catch(() => null), new Promise((ok) => setTimeout(() => ok('slow'), 8000))]); 
        if (ff === 'slow') return { ...base, kind: P ? 'paid' : 'other', why: base.why || '模拟太久没结果：可能要付费或需要特定条件，按强制打时工具会再试' };
        if (!ff) return { ...base, kind: P ? 'paid' : 'other', why: base.why || (P ? '' : '模拟没找到免费／小额的铸造方式：可能是付费项目、还没开放、已铸完，或根本不是铸造合约') };
        const fee = Number(ff.v || 0n) / 1e18; return { ...base, kind: 'mint', fee, feeUsd: await (async () => { if (!fee) return 0; const px = await bnbUsd().catch(() => 0); return px > 0 ? Math.round(fee * px * 100) / 100 : null; })() }; 
      } catch (e) { return { c, kind: 'other', why: '读取失败：' + e.message.slice(0, 60) }; } }));
      out.found.sort((a, b) => (b.self - a.self) || ((b.kind === 'mint') - (a.kind === 'mint')));
      W_(out); log(`雷达搜寻 ${q}：${out.found.length} 个合约`); })().catch((e) => log('雷达搜寻出错 ' + e.message)); continue; }
    const c = String(o.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || Date.now() - (o.at || 0) > 5 * 60e3) continue; /* 过期的旧单（例如重开前按的）不执行，只会挡、不会多买 */
    if (['buy', 'mint', 'nftmint', 'shareMint'].includes(o.type)) { const bb = buyBlock(); if (bb) { log(`雷达${o.type === 'buy' ? '手动买' : '铸造'} ${o.name || c}：${bb}`); try { writeFileSync(join(DIR, 'data', 'buy_block.json'), JSON.stringify({ at: Date.now(), c, name: o.name || '', msg: bb })); } catch {} continue; } } /* 全停／手动买关闭时，雷达、手机送来的买单一律不执行 */
    if (o.type === 'sentRevoke' || o.type === 'sentAck') { if (globalThis.SENTINEL) globalThis.SENTINEL.order(o).catch((e) => log('安全哨兵 ' + e.message)); else log('安全哨兵模组没载入'); continue; } /* 你按的「去取消授权」／「知道了」（取消授权只拿掉对方权限，不转钱） */
    if (o.type === 'mintpick') { if (globalThis.MINTPICK) globalThis.MINTPICK.order(o, c).catch((e) => log('选打法出错 ' + e.message)); else log('选打法模组没载入'); continue; } /* 列出／预演／存起来／送出（送出一样挡紧急全停、手动买卖关、两个雷达） */
    if (o.type === 'shareInfo') { shareInfo(c).catch((e) => log('份数资讯 ' + e.message)); continue; } 
    if (o.type === 'shareMint') { (async () => { const r = await shareMint(c, o.n, o.w, o.maxBnb).catch((e) => '❌ ' + e.message); log('雷达按份数铸造 ' + c + ' ' + r.replace(/\n/g, ' ')); await tgSay('🖥 雷达铸造 ' + (o.name || c.slice(0, 8)) + '：\n' + r).catch(() => {}); try { writeFileSync(join(DIR, 'data', 'share_last.json'), JSON.stringify({ c, at: Date.now(), r })); } catch {} })(); continue; }
    if (o.type === 'track') { S.paid = S.paid || {}; if (!S.paid[c]) { S.paid[c] = { at: Date.now(), name: String(o.name || '').slice(0, 40) || '搜寻项目', done: {}, fromUrl: 'search', needLearn: 1 }; save(); log(`雷达搜寻：${c} 加入追踪（照一般规则）`); } continue; }
    if (o.type === 'analyze' || o.type === 'mintHist') { (async () => { const isRh = Number(o.chain) === 4663; let r;
        try { if (o.type === 'analyze') r = isRh ? (RH ? await RH.analyze(c, null, true) : { ok: false, why: 'Robinhood 模组没载入' }) : (BA ? await Promise.race([BA.analyze(c, o.pool), new Promise((ok) => setTimeout(() => ok({ ok: false, why: '查太久（交易太多），稍后再试' }), 40e3))]) : { ok: false, why: '模组没载入' });
          else r = isRh ? { pts: [], why: 'Robinhood 的铸造时间线还不支援' } : BA ? await BA.mintTimeline(c) : { pts: [] }; } catch (e) { r = { ok: false, why: e.message.slice(0, 80) }; }
        const f = r?.facts ? { bundlePct: r.facts.bundlePct, top10: r.facts.top10, realBuyers: r.facts.realBuyers, devPct: r.facts.devPct ?? null } : null;
        writeFileSync(join(DIR, 'data', o.type === 'analyze' ? 'radar_analyze.json' : 'radar_minthist.json'), JSON.stringify({ c, at: Date.now(), chain: isRh ? 4663 : 56, ok: r?.ok !== false, why: r?.why || '', facts: f, pts: r?.pts || null, nft: r?.nft || false })); })().catch(() => {}); continue; } /* 详情页用：深度检查、铸造走势（只读） */
    if (o.type === 'nftmint' && BN) { await tgSay('🖥 雷达手动铸造 BSC NFT ' + (o.name || c) + '：预演中…').catch(() => {}); const r = await BN.manualMint(c, o.usd, { ack: o.ack === true || o.ack === 1, w: o.w ? String(o.w).toLowerCase() : '' }).catch((e) => '⚠️ ' + e.message); log('雷达手动铸造 BSC NFT ' + (o.name || c) + '：' + r); continue; }
    if (o.type === 'sell' && !(Number(o.pct) > 0 && Number(o.pct) <= 100)) { log(`雷达卖出 ${o.name || c}：没收到要卖几 %，没卖`); await tgSay(`🖥 卖 ${o.name || c}：没收到要卖几 %，没卖（请在雷达重按一次）`).catch(() => {}); continue; } 
    if (o.chain && Number(o.chain) !== 56) { if (Number(o.chain) === 4663 && o.type === 'previewMint' && RH) { const r = await RH.previewMint(c).catch((e) => ({ err: e.message })); writeFileSync(join(DIR, 'data', 'rh_preview.json'), JSON.stringify(r, null, 1)); continue; } if (Number(o.chain) === 4663 && o.type === 'mint' && RH) { await tgSay('🖥 雷达手动铸造 Robinhood ' + (o.name || c) + '：预演中…').catch(() => {}); const r = await RH.manualMint(c, o.usd, { ack: o.ack === true || o.ack === 1, w: o.w ? String(o.w).toLowerCase() : '' }).catch((e) => '⚠️ ' + e.message); log('雷达手动铸造 Robinhood ' + (o.name || c) + '：' + r); continue; } if (Number(o.chain) === 4663 && o.type === 'sell' && RH) { const r = await RH.manualSell(c, o.pct, o.w).catch((e) => '⚠️ ' + e.message); log('雷达手动卖 Robinhood ' + (o.name || c) + '：' + r); await tgSay('🖥 Robinhood 卖 ' + Number(o.pct) + '% ' + (o.name || c) + '\n' + r).catch(() => {}); continue; } if (Number(o.chain) === 4663 && o.type === 'buy' && RH) { await tgSay('🖥 雷达手动买 Robinhood ' + (o.name || c) + '：检查中…').catch(() => {}); const r = await RH.manualBuy(c, Number(o.eth) > 0 ? Number(o.eth) * (await RH.ethUsd().catch(() => 0)) : (Number(o.usd) || 0), { usdg: o.pay === 'USDG', w: o.w, tpsl: 'tpsl' in o ? tpslNorm(o.tpsl) : TPSL_DEF(), ack: o.ack === true || o.ack === 1 }) /* 一键买可设 ETH 金额；只用选的钱包 */.catch((e) => '⚠️ ' + e.message); log('雷达手动买 Robinhood ' + (o.name || c) + '：' + r); await tgSay('🖥 Robinhood ' + (o.name || c) + '\n' + r).catch(() => {}); } continue; } /* 别条链的合约绝不拿到 BSC 买 */
    if (o.type === 'mint') { if (!S.paid?.[c] && o.src === 'search') { S.paid = S.paid || {}; S.paid[c] = { at: Date.now(), name: String(o.name || '搜寻项目').slice(0, 40), done: {}, fromUrl: 'search', needLearn: 1 }; } if (!S.paid?.[c]) { fsNew(c, o.name, o.usd); fsEnd(c, false, '工具里没有这个铸造项目（雷达没追踪到这个合约），没执行'); await tgSay(`🖥 雷达强制打 ${o.name || c}：工具里没有这个铸造项目，没执行`).catch(() => {}); continue; } if (S.forceDone) delete S.forceDone[c]; FORCE.add(c); if (o.ack === true || o.ack === 1) FACK.add(c); else FACK.delete(c); if (o.ackAppr === true || o.ackAppr === 1) FACKA.add(c); else FACKA.delete(c); S.forceAdd = [...new Set([...(S.forceAdd || []), c])]; if (Number(o.usd) > 0) { S.forceUsd = S.forceUsd || {}; S.forceUsd[c] = Number(o.usd); } save(); const fid = fsNew(c, o.name, capOf(c)); log(`雷达强制打 ${o.name || c}（编号 ${fid}）：加入指定要打名单，排队中`); await tgSay(`🖥 雷达强制打 ${o.name || c}（编号 ${fid}）：已收到、排队中（还没执行），开始检查后约 1～3 分钟回报结果（这次最多付 ${capOf(c)}U；跳过防钓鱼门槛，只查会不会被盗）`).catch(() => {}); if (S.paid?.[c]) delete S.paid[c].unmintable; (async () => { const b0 = { ...(S.paid?.[c]?.done || {}) }; const n0 = (S.dyn || []).length; let busyMiss = 0; try { for (let i = 0; i < 120 && busyP.has(c); i++) await sleep(1000); if (busyP.has(c)) busyMiss = 1; else fsStage(c, 'checking', '开始检查：进度、名额、打法'); if (!busyMiss) await Promise.race([paidLoop('one', c), sleep(180e3)]); } catch (e) { log('强制打 ' + e.message); } const P2 = S.paid?.[c]; const dn = P2?.done || {}; const okW = WALLETS.filter((W) => /minted|free/.test(String(dn[W.name] || '')) && !b0[W.name]).map((W) => W.name); const ok = okW.length > 0; const allMine = WALLETS.length > 0 && WALLETS.every((W) => b0[W.name]); const soldOut = !ok && !allMine && (!!P2?.soldOut || /已经铸完|售罄/.test(String(P2?.lastReason || ''))); const why = ok ? '' : busyMiss ? '一般检查一直在处理这个项目（等太久），这次没执行、没有送出交易，可以再按一次' : allMine ? '我的钱包都已经铸过这个项目了（不是项目售罄）' : soldOut ? '项目已售罄（名额没了），不是你的钱包铸过' : String(FSWHY.get(c) || P2?.lastReason || (P2?.progress != null ? '没打成功（原因没记到；最后读到进度 ' + Math.round(P2.progress * 100) + '%，详细看记录）' : '没打成功（原因没记到，详细看记录）')).replace(/，?照[規规][則则]不打/, ''); /* 分清「项目已售罄」和「我的钱包已铸」 */ const added = (S.dyn || []).length > n0; const msg = ok ? `✅ 强制打 ${o.name || c} 成功${okW.length ? '（' + okW.join('、') + '）' : ''}${added ? '，已加入持仓' : '；交易收据里没看到代币转进来，没加入持仓（请到钱包确认有没有收到）'}` : `❌ 强制打 ${o.name || c} 没打成：${why}`; try { writeFileSync(join(DIR, 'data', 'force_last.json'), JSON.stringify({ c, name: o.name || '', at: Date.now(), ok, msg })); } catch {} fsEnd(c, ok, ok ? msg : why, { soldOut: soldOut ? 1 : 0, mine: allMine ? 1 : 0, okW, ag: { peak: P2?.agents ?? null, now: P2?.agNow ?? null, at: P2?.agNowAt || null, trunc: P2?.agTrunc ? 1 : 0 } , mw: P2?.mw || null, prog: P2?.progress != null ? Math.round(P2.progress * 1000) / 10 : null, progAt: P2?.progAt || null }); if (!ok) { FORCE.delete(c); S.forceAdd = (S.forceAdd || []).filter((x) => x !== c); if (S.forceUsd) delete S.forceUsd[c]; save(); } /* 没打成就从强制名单拿掉，不然会在背景一直重试，几小时后（补了 BNB、钱包重连）突然买进 */ log(msg); tgSay(msg).catch(() => {}); })(); continue; } /* 强制打常常是快没了，不能等下一轮 */
    if (o.type === 'rescan') { let n = 0; for (const [c2, P] of Object.entries(S.paid || {})) if (trackOk(P)) { P.sweepAt = 0; P.progAt = 0; n++; } log(`雷达按了刷新：${n} 个铸造项目马上重查进度`); continue; } 
    if (o.type === 'tpsl') { const T = 'tpsl' in o ? tpslNorm(o.tpsl) : undefined; let n = 0; if (Number(o.chain) === 4663) { if (RH?.setTpsl) n = RH.setTpsl(c, T, o.autoSell); } else for (const t of (S.dyn || []).filter((x) => x.addr === c && !x.closed && (!o.w || x.only === String(o.w).toLowerCase()))) { if (T !== undefined) { if (T) t.tpsl = T; else delete t.tpsl; } if (o.autoSell === false) t.autoSell = false; else if (o.autoSell === true) delete t.autoSell; n++; } save(); log(`雷达改止盈止损 ${o.name || c}：${T ? tpslTxt(T) : T === null ? '不设' : '不变'}${o.autoSell === false ? '（自动卖关）' : o.autoSell === true ? '（自动卖开）' : ''}，${n} 笔`); continue; } /* 持仓每一笔可以改止盈止损、关掉自动卖 */
    if (o.type === 'buy') { const r = await tgBuy(c, Number(o.usd) || 0 , { pay: o.pay, w: o.w, bnb: o.bnb, name: o.name, ...('tpsl' in o ? { tpsl: o.tpsl } : {}) }).catch((e) => '⚠️ 下单出错：' + e.message); log(`雷达手动买 ${o.name || c}：${r}`); await tgSay(`🖥 雷达手动买 ${o.name || c}\n${r}`).catch(() => {}); }
    else if (o.type === 'sell') { let any = false, gone = 0; for (const t of (S.dyn || []).filter((x) => x.addr === c && !x.closed && (!o.w || x.only === String(o.w).toLowerCase()))) { const W = t.only ? WALLETS.find((w) => w.addr === t.only) : WALLETS[0]; if (!W) { await tgSay(`🖥 ${t.sym}：买它的钱包已经从雷达删除，雷达没办法帮它卖，请到那个钱包自己卖`).catch(() => {}); continue; } const pqM = ptxSeq(c); /*V101-5 读余额前记下*/ const rawB = await call(c, '0x70a08231' + wa(W.addr)).catch(() => null); if (!rawB || rawB === '0x') { await tgSay(`🖥 ${t.sym}：读不到 [${W.name}] 的余额（节点没回应），等一下再按一次卖`).catch(() => {}); any = true; continue; } const bal = big(rawB); if (bal <= 0n) { t.closed = Date.now(); t.closedBy = 'empty'; gone++; await tgSay(`🖥 ${t.sym}：[${W.name}] 里已经没有这个币了（之前就卖光了），已从持仓拿掉`).catch(() => {}); continue; } any = true; const balN = await plugNet(W, c, bal); if (balN == null) { await tgSay(`🖥 ${t.sym}：读不到小数位数，没办法扣掉外挂的部位，这次没卖`).catch(() => {}); continue; } const amt = (balN * BigInt(Math.round(Number(o.pct) * 100))) / 10000n; /* 百分比 → 万分比（单位换算）；H7-H6 先扣外挂部位 */ const k = stKey(W, t); S.tokens = S.tokens || {}; if (!S.tokens[k]) S.tokens[k] = { hist: [], peak: 0, peakAt: 0, sold: 0 }; /* 用这个钱包这个币自己的记录 */ PQ_READ.set(S.tokens[k], pqM); /*V101-5*/ if (SELLING.has(W.name + '|' + t.addr)) { await tgSay(`🖥 ${t.sym}：[${W.name}] 上一笔卖单还在送（等成交），这张先不卖，等一下再按一次`).catch(() => {}); continue; } globalThis.LAST_SELL_ERR = ''; const ok = CURVES[c] ? await curveSell(c, W, amt).catch((e) => (/結果不明|结果不明/.test(String(e?.message || '')) ? 'pend' : (log('曲线卖出错 ' + e.message), false))) : await sell(t, S.tokens?.[k] || {}, amt, '指示：雷达手动卖', W).catch((e) => (log('雷达卖出错 ' + e.message), false)); if (ok === 'pend' && CURVES[c] && S.tokens[k] && !S.tokens[k].sellPend) { const st0 = S.tokens[k]; st0.sellPend = { at: Date.now(), bal0: bal.toString(), tx: null, why: '指示：雷达手动卖（曲线）', snap: { done2: [...(st0.done2 || [])], stage: st0.stage ?? 0, sellNowDone: !!st0.sellNowDone, moonPend: st0.moonPend || 0 } }; save(); } /*V105-FIX2：曲线卖出结果不明／查不到收据＝待确认*/ if (ok === true && Number(o.pct) >= 100) { t.closed = Date.now(); t.closedBy = 'sold'; } /* 全卖成功就马上从持仓拿掉，不用等定时清理 */ let dead = false; if (!ok && /liquidity/i.test(globalThis.LAST_SELL_ERR || '')) { t.closed = Date.now(); t.closedBy = 'noliq'; dead = true; } /* 卖不掉的死币也从列表拿掉 */ log(`雷达手动卖 ${t.sym} ${Number(o.pct)}%：${ok === 'pend' ? '结果不明（逾时）' : ok ? '成功' : '没卖成'}`); await tgSay(`🖥 雷达手动卖 ${t.sym} ${Number(o.pct)}%（[${W.name}]）：${ok === 'pend' ? '⚠️ 卖出结果不明（送出逾时，可能已成交），先不重复卖，等读到余额变化再决定' : ok ? '✅ 已送出' : '❌ 没卖成：' + sellWhy(globalThis.LAST_SELL_ERR) + (dead ? '。已从持仓列表拿掉（币还在你钱包里）' : '')}`).catch(() => {}); } if (!any) { save(); await tgSay(`🖥 雷达：${o.name || c} 钱包里已经没有了（之前就卖光了），已从持仓面板移除`).catch(() => {}); } }
  }
}
/* 「没卖成，看 log」看不懂 → 直接说原因 */
function sellWhy(m) { m = String(m || ''); if (/^⏳ /.test(m)) return m.slice(2); /*V101-5 雷达自己先不卖的原因，原样显示*/ if (/insufficient liquidity|liquidity/i.test(m)) return '池子里几乎没钱了，没人接得住，卖不出去。这种币基本归零，放着不管就好（不会再扣你钱）'; if (/honeypot|transfer|TRANSFER_FROM_FAILED/i.test(m)) return '这个币不让卖（可能是貔貅或被限制转帐）'; if (/gas|insufficient funds|balance/i.test(m)) return '钱包里付手续费的币不够（BNB Chain 用 BNB、Robinhood 用 ETH），先转一点进来'; if (/slippage|price impact/i.test(m)) return '价格跳太大（滑点），等一下再试或少卖一点'; return m ? '交易所回：' + m.slice(0, 120) : '没有拿到原因，等一下再试一次'; }
globalThis.sellWhy = sellWhy;


const FB_CFG = (() => { try { return JSON.parse(readFileSync(join(DIR, '.sign', 'referral_bot.json'), 'utf8')); } catch { return null; } })();
const FB_MAX_BYTES = 5e6; /* 技术用：反馈档容量 */ if (FB_CFG?.token) { const FBF = join(DIR, 'data', 'feedback.jsonl'); const api = (m, b) => fetch(`${TG_API}/bot${FB_CFG.token}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}), signal: AbortSignal.timeout(35000) }).then((r) => r.json());
  let fbBusy = false; const fbPoll = async () => { if (fbBusy) return; fbBusy = true; try { const j = await api('getUpdates', { offset: (S.fbOff || 0) + 1, timeout: 25, allowed_updates: ['message'] });
    for (const u of j.result || []) { S.fbOff = u.update_id; const m = u.message; if (!m?.from || m.chat?.type !== 'private') continue; const txt = String(m.text || m.caption || '').trim();
      if (!txt || /^\/start\b/.test(txt)) { await api('sendMessage', { chat_id: m.chat.id, text: '👋 这里是罗宾猫雷达的反馈信箱。\n直接把你想要的功能、遇到的问题打出来送出就好（在雷达按「💡 反馈」会帮你整理好格式）。\nNancy 会看过每一则，好的建议会做进下一个官方版本。\n（我们会存你的 TG 名称／帐号，只用来回复你）' }).catch(() => {}); continue; }
      const k = new Date().toDateString(); S.fbDay = S.fbDay?.k === k ? S.fbDay : { k, n: {} }; const n = (S.fbDay.n[m.from.id] || 0) + 1; S.fbDay.n[m.from.id] = n; const fbMax = nrNum('report.fbDayMax'); if (fbMax != null && n > fbMax) continue; /* 同一人一天最多收几则＝你的 report.fbDayMax（空白＝不限） */
      try { if (existsSync(FBF) && statSync(FBF).size > FB_MAX_BYTES) renameSync(FBF, FBF.replace(/\.jsonl$/, '.1.jsonl')); } catch {} /* 容量（档案太大换新的，旧的留一份） */ appendFileSync(FBF, JSON.stringify({ id: u.update_id, rt: Date.now(), at: (m.date || 0) * 1000 || Date.now(), uid: m.from.id, user: m.from.username || '', name: [m.from.first_name, m.from.last_name].filter(Boolean).join(' ').slice(0, 40), text: txt.slice(0, 3000) }) + '\n');
      await api('sendMessage', { chat_id: m.chat.id, text: fbMax != null && n === fbMax ? `✅ 收到了，谢谢！（今天已经收满 ${fbMax} 则，明天再来～）` : '✅ 收到了，谢谢你的反馈！Nancy 会看。' }).catch(() => {}); }
    if (j.ok === false && Date.now() - (globalThis._fbErrAt || 0) > 3600e3) { globalThis._fbErrAt = Date.now(); log('反馈机器人收不到讯息：' + String(j.description || '').slice(0, 120)); }
    if ((j.result || []).length) save(); } catch (e) { if (Date.now() - (globalThis._fbErrAt || 0) > 3600e3) { globalThis._fbErrAt = Date.now(); log('反馈机器人出错：' + e.message.slice(0, 100)); } } finally { fbBusy = false; } };
  setInterval(fbPoll, 30e3).unref(); setTimeout(fbPoll, 10e3);
  setInterval(() => { const d = new Date(); if (!atHour('report.fbHour') || S.fbDigest === d.toDateString()) return; S.fbDigest = d.toDateString(); save(); try { const all = readFileSync(FBF, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); const nw = all.filter((x) => (x.rt ?? x.at) > (S.fbSeen || 0)); /* 用收到的时间比（不是 TG 送出时间） */ S.fbSeen = Date.now(); save(); if (!nw.length) return;
    tgSay(`💡 今天收到 ${nw.length} 则用户反馈（${[...new Set(nw.map((x) => x.uid))].length} 个人）\n${nw.slice(0, 5).map((x) => '• ' + x.text.replace(/\s+/g, ' ').slice(0, 60)).join('\n')}${nw.length > 5 ? '\n…' : ''}\n全部在雷达「⚙️ 设定 → 反馈收件箱」`) /* NAV9 */.catch(() => {}); } catch {} }, 5 * 60e3).unref(); }
let roBusy = false; setInterval(() => { if (roBusy) return; roBusy = true; ACK.run({}, () => radarOrders()).catch((e) => log('radarOrders ' + e.message)).finally(() => { roBusy = false; }); }, 800).unref(); 
const holdClean = async () => { try { let n = 0; for (const t of S.dyn || []) { if (t.closed || Date.now() - (t.boughtAt || 0) < 30 * 60e3) continue; const W = WALLETS.find((w) => w.addr === t.only); if (!W) continue; const raw = await call(t.addr, '0x70a08231' + wa(W.addr)).catch(() => null); if (!raw || raw === '0x') continue; /* 节点没回应不能当成 0（CHYAI 被误删） */ const b = big(raw); if (b <= 0n) { t.closed = Date.now(); t.closedBy = 'empty'; n++; } } if (n) { save(); log(`持仓面板：${n} 个已经卖光的币移除`); }
  } catch {} }; setInterval(holdClean, 10 * 60e3).unref(); setTimeout(holdClean, 30e3); /* 已经卖光的不要再显示在面板、也不要再叫用户卖 */

const RULE_FIELDS = { name: 's', liqUsd: 'n', liqBnb: 'n', agents: 'n', progress: 'n', buyTax: 'n', sellTax: 'n', realBuyers: 'n', bundlePct: 'n', top10Pct: 'n' };
globalThis.CUSTOM_SKIP = (info) => { const rules = Array.isArray(radarSet().rules) ? radarSet().rules : [];
  for (const r of rules) { try { if (!r || r.off || !RULE_FIELDS[r.field]) continue; if (r.chain && r.chain !== 'all' && r.chain !== info.chain) continue;
    const v = r.field === 'name' ? `${info.name || ''} ${info.sym || ''}`.toLowerCase() : r.field === 'progress' ? (info.progress != null ? info.progress * 100 : null) : info[r.field];
    if (v == null) continue; const want = RULE_FIELDS[r.field] === 's' ? String(r.value || '').toLowerCase().trim() : Number(r.value); if (RULE_FIELDS[r.field] === 's' ? !want : !Number.isFinite(want)) continue;
    const hit = r.op === 'contains' ? String(v).includes(want) : r.op === '<' ? Number(v) < want : r.op === '>' ? Number(v) > want : false;
    if (hit) return `${r.field} ${r.op} ${r.value}${r.note ? '（' + String(r.note).slice(0, 40) + '）' : ''}`; } catch {} } return ''; };

let _loginBusy = false;
/* 新增／登出钱包要马上反应 → 每分钟查一次登入状态；登出的钱包所有买卖、铸造都先跳过（不会一直失败、乱发通知），重新连接就自动恢复 */
/* 送出前一刻再挡一次（卖、撤销授权照常）
   ② 参数只能是位址／数字／十六进位：第一个钱包是用命令列呼叫的，节点或项目方回来的资料如果夹带特殊字元就挡下，防止被塞指令 */
const BAW_STABLE = new Set(['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '0x55d398326f99059ff775485246999027b3197955', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', '0x5fc5360d0400a0fd4f2af552add042d716f1d168']);
const bawArg = (a, k) => { const i = a.indexOf(k); return i >= 0 ? String(a[i + 1] || '').toLowerCase() : ''; };
function bawBlock(W, a) {
  if (!Array.isArray(a)) return '参数格式不对';
  for (let i = 0; i < a.length; i++) { const x = a[i]; if (a[0] === 'sign-message' && a[i - 1] === '--message') { if (typeof x === 'string' ? /[&|<>^%`$\r\n]/.test(x) : false) return '签名内容里有不该出现的字元，为了安全没有送出'; continue; } if (typeof x !== 'string' || !/^[A-Za-z0-9_.:\-]{0,40000}$/.test(x)) return '交易参数里有不该出现的字元，为了安全没有送出'; }
  if (W.off && ['market-order', 'contract-call'].includes(a[0])) return `${W.name} 钱包登入过期，先跳过（到雷达「设定 → 钱包」重新连接）`;
  if (ESTOP() && a[0] === 'contract-call' && a[1] === 'execute') { const rid = bawArg(a, '--requestId'); if (RID_BUY.get(rid) !== false) return '紧急全停中，不送出（预演后才按全停，这笔买入取消）'; }
  if (ESTOP()) {
    if (a[0] === 'contract-call' && a[1] === 'preview') { const d = bawArg(a, '--inputData'); const revoke = /^0x095ea7b3[0-9a-f]{64}0{64}$/.test(d); const to = String(bawArg(a, '--to') || '').toLowerCase(); const curveSellOk = !!(typeof CURVES !== 'undefined' && CURVES[to] && d.startsWith(CURVES[to].sel) && BigInt(bawArg(a, '--value') || '0') === 0n); /* 全停时自动卖、手动卖都要照常 → 曲线上的币卖出（不付钱、呼叫该币的卖出函式）放行 */ const agcBack = agcClaimOnly(to, d, BigInt(bawArg(a, '--value') || '0')); /*V105-FIX1：AGC 领回（只收不付）全停也放行预演，跟送出时 RID_BUY 同一个判断*/ if (!curveSellOk && !agcBack && (!revoke || BigInt(bawArg(a, '--value') || '0') > 0n)) return '紧急全停中，不送出（只能卖）'; }
    if (a[0] === 'market-order' && a[1] === 'swap') { const f = bawArg(a, '--fromToken'), t2 = bawArg(a, '--toToken'); if (BAW_STABLE.has(f) && !BAW_STABLE.has(t2)) return '紧急全停中，不买（只能卖）'; }
  }
  return '';
}
const RID_BUY = new Map(); /* 每个预演单号记下「是不是买入」（卖出／撤销授权＝false），全停时送出前查它 */
const bawBuyLike = (a) => { const d = bawArg(a, '--inputData'); const v = BigInt(bawArg(a, '--value') || '0'); const to = String(bawArg(a, '--to') || '').toLowerCase(); const revoke = /^0x095ea7b3[0-9a-f]{64}0{64}$/.test(d) && v === 0n; const curveSell = !!(typeof CURVES !== 'undefined' && CURVES[to] && d.startsWith(CURVES[to].sel) && v === 0n); return !(revoke || curveSell || agcClaimOnly(to, d, v)); }; /* AGC-BACK：AGC 领回（只收不付）跟卖出同一类 */
/* GATE-1 · 统一动作闸门：买／卖／授权／转出／签名全部从这里过（每个钱包真正的币安钱包 CLI 只包在闸门里面，没有别的路可以送交易）
   ① 只认识雷达用到的钱包指令，其他指令一律不送
   ② 参数格式、钱包登入、紧急全停（bawBlock，原本的检查照旧）
   ③ 转出（转帐／代转／NFT 转移、直接把币打到个人钱包）一律不送：雷达不会把你的钱转给任何人
   ④ 签名只签「邀请绑定」那一种；授权（approve／Permit）：手机下的单不行，自动交易要你开「自动交易允许授权」
   ⑤ 买入：雷达／TG 手动＝「手动买卖」开关＋邀请绑定；手机＝还要先过手机额度检查 phoneGate；强制打＝「手动买卖」开关；自动＝总开关 auto（含暂停、时段、绑定、第一次设定）
   ⑥ 卖出、撤销授权照常（紧急全停也能卖）
   ⑦ 读不到资料／判断出错：只能「不买」（卖出、撤销照常）
   每一笔送出（和被挡下的）都写一行到 data/gate_log.jsonl：谁下的、哪一种、每一项检查过没过 */
const GATE_CMDS = new Set(['wallet status', 'wallet settings', 'auth signin', 'auth verify', 'approvals list', 'approvals revoke', 'market-order quote', 'market-order swap', 'contract-call preview', 'contract-call execute', 'sign-message preview', 'sign-message execute', 'sign-message result']);
const GATE_SEND = new Set(['approvals revoke', 'market-order swap', 'contract-call execute', 'sign-message execute']);
const GATE_QUOTE = new Set([...BAW_STABLE, '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409']); /* 换回这些币＝卖出（原生币／WBNB／USDT／USDC／FDUSD／USDG） */
const GATE_XFER = /^0x(a9059cbb|23b872dd|42842e0e|b88d4fde|f242432a|2eb2c2d6|4000aea0|88d695b2|9bd9bbc6|62ad1b83|1296ee62|d8fbe994|c1d34b89)/; /* 转帐／代转／NFT 转移／批次转／ERC777／ERC1363 */
const GATE_APPR = /^0x(095ea7b3|39509351|d73dd623|cae9ca51|a22cb465|d505accf|8fcbaf0c|2b67b570|2a2d80d1|30f28b7a|edd9444b|137c29fe|fe8ec1a7|36c78516|0d58b1db|87517c45|959b8c3f|3177029f)/; /* 授权／加授权／全部授权／Permit／Permit2 */
const RID_KIND = new Map(); /* 预演单号 → 这笔是哪一种（送出时照这个判断） */ const RID_KIND_MAX = 4000; /*RISK-FIX 5 技术用：预演单号记录的记忆体上限（超过才丢最旧的；跟买入记录 RID_BUY 分开算，签名／卖出预演单号不会刚记就被丢） */
let GATE_DAY = '';
function gateLog(rec) { try { const f = join(DIR, 'data', 'gate_log.jsonl'); const d = new Date().toDateString(); if (GATE_DAY !== d) { try { if (statSync(f).mtime.toDateString() !== d) renameSync(f, join(DIR, 'data', 'gate_log.prev.jsonl')); } catch {} GATE_DAY = d; } appendFileSync(f, JSON.stringify({ at: Date.now(), ...rec }) + '\n'); } catch {} } /* 只留今天＋前一份 */
function gateFrom(target) { const g = GATE_CTX.getStore(); if (g?.src) return g.src; const st = ACK.getStore(); if (st) return st.src === 'phone' ? 'phone' : 'radar'; if (target && FORCE.has(target)) return 'force'; return 'auto'; }
function gateSignOk(a) { const m0 = String(bawArg(a, '--message') || '').replace(/\\+"/g, '"').replace(/\s+/g, ''); const me = (m0.match(/"params":\["(0x[0-9a-f]{40})"/) || [])[1] || '-';
  const m = m0.replace(/\{"name":"verifyingcontract","type":"address"\}/g, '').replace(/"verifyingcontract":"(0x[0-9a-f]{40})"/g, (x, v) => (v === me || /^0x0{40}$/.test(v) ? '' : x)); /* BIND-FIX：verifyingContract 只准是自己钱包或零地址（Bind 的写法之一），其他地址照挡 */
  return /"primarytype":"bind"/.test(m) && /"name":"robincatradar"/.test(m) && !/verifyingcontract|permit|spender|allowance|order/.test(m); } /* bawArg 已经转小写 */
async function gateIsEoa(a, to) { const cid = bawArg(a, '--binanceChainId'); const code = cid === '56' ? await rpc('eth_getCode', [to, 'latest']) : cid === '4663' && RH?.rpc ? await RH.rpc('eth_getCode', [to, 'latest']) : null; if (typeof code !== 'string') throw new Error('读不到对方地址是不是合约'); return code === '0x' || code === ''; }
async function gateKind(a) {
  const c = String(a[0]) + ' ' + String(a[1]);
  if (!GATE_CMDS.has(c)) return { c, kind: 'unknown' };
  if (c === 'approvals revoke') return { c, kind: 'revoke', target: bawArg(a, '--tokenContract') };
  if (c === 'market-order swap') { const f = bawArg(a, '--fromToken'), t = bawArg(a, '--toToken'); const qf = GATE_QUOTE.has(f), qt = GATE_QUOTE.has(t); return { c, kind: qf && qt ? 'convert' : qt ? 'sell' : 'buy', target: qt ? f : t }; }
  if (c === 'contract-call preview') { const d = bawArg(a, '--inputData'), to = bawArg(a, '--to'), v = BigInt(bawArg(a, '--value') || '0');
    if (GATE_XFER.test(d)) return { c, kind: 'transfer', target: to };
    if (/^0x095ea7b3[0-9a-f]{64}0{64}$/.test(d) && v === 0n) return { c, kind: 'revoke', target: to };
    if (/^0xa22cb465[0-9a-f]{64}0{64}$/.test(d) && v === 0n) return { c, kind: 'revoke', target: to }; /* setApprovalForAll(x, false) */
    if (GATE_APPR.test(d)) return { c, kind: 'approve', target: '0x' + d.slice(34, 74) }; /* 来源看「授权给谁」（强制打的合约） */
    if (v > 0n && (d === '0x' || d === '') && await gateIsEoa(a, to)) return { c, kind: 'transfer', target: to }; /* 直接把原生币打给个人钱包＝转出 */
    return { c, kind: bawBuyLike(a) ? 'buy' : 'sell', target: to }; }
  if (c === 'contract-call execute') { const k = RID_KIND.get(bawArg(a, '--requestId')); return k ? { c, kind: k.kind, target: k.target } : { c, kind: 'buy', target: '', why0: '预演单号查不到（当成买入）' }; }
  if (c === 'sign-message preview') return { c, kind: gateSignOk(a) ? 'sign' : 'sign-bad' };
  if (c === 'sign-message execute') { const k = RID_KIND.get(bawArg(a, '--requestId')); return { c, kind: k?.kind === 'sign' ? 'sign' : 'sign-bad' }; }
  return { c, kind: 'read' };
}
async function actionGate(W, a) {
  let K = { c: Array.isArray(a) ? String(a[0]) + ' ' + String(a[1]) : '?', kind: '?' }; const checks = []; const from0 = () => { try { return gateFrom(K.target); } catch { return '?'; } };
  const out = (ok, why) => { const send = GATE_SEND.has(K.c); if (send || !ok) gateLog({ w: W.name, cmd: K.c, kind: K.kind, from: from0(), target: K.target || '', ok: ok ? 1 : 0, why: why || '', checks }); return { ok, why: why || '', kind: K.kind, target: K.target || '', rec: ok && (K.c === 'contract-call preview' || K.c === 'sign-message preview') }; };
  const need = (name, pass, why) => { checks.push([name, pass ? 1 : 0]); return pass ? '' : why; };
  try {
    if (!Array.isArray(a)) return out(false, '参数格式不对');
    K = await gateKind(a);
    { const w = need('指令白名单', K.kind !== 'unknown', `雷达不认识的钱包指令「${K.c}」，为了安全没有送出`); if (w) return out(false, w); }
    { const why0 = bawBlock(W, a); const w = need('格式／登入／紧急全停', !why0, why0); if (w) return out(false, w); }
    if (K.kind === 'read') return out(true);
    const from = gateFrom(K.target); const st = ACK.getStore() || {};
    { const w = need('手机额度检查', from !== 'phone' || (Object.hasOwn(st, 'phoneOk') && st.phoneOk === 1), '手机下的单没有先过手机额度检查，没送出'); if (w) return out(false, w); } /* hasOwn：原型被污染（Object.prototype.phoneOk）也骗不过 */
    { const w = need('不转出', K.kind !== 'transfer', '雷达不会把钱转出去（转帐／代转／转给个人钱包），这笔没送出'); if (w) return out(false, w); }
    { const w = need('只签邀请绑定', K.kind !== 'sign-bad', '要签的内容不是雷达的邀请绑定（可能是授权／Permit 之类），没签'); if (w) return out(false, w); }
    if (K.kind === 'sell' || K.kind === 'revoke' || K.kind === 'sign' || K.kind === 'convert') return out(true);
    { const w = need('钱包还在雷达', WALLETS.includes(W), `钱包 ${W.name} 已经从雷达删除（或隐藏），不再用它买入／授权`); if (w) return out(false, w); } /*RISK-FIX 3：删掉的钱包（外挂或别的模组还拿着旧的）只能卖，不能买 */ /* 卖出、撤销授权、邀请绑定签名、稳定币互换：照常 */
    if (K.c === 'contract-call preview' && K.kind === 'buy') return out(true); /* 预演不花钱；真正送出（execute）时才检查买入开关 */
    /* 下面：买入、授权 */
    { const w = need('设定档在', existsSync(join(DIR, 'data', 'radar_settings.json')), '设定档 data/radar_settings.json 不见了（被删或还没建立），读不到设定只能不买'); if (w) return out(false, w); }
    { const w = need('紧急全停', !ESTOP(), '🛑 紧急全停中，不买、不授权（只能卖）'); if (w) return out(false, w); }
    if (K.kind === 'approve') { const w = need('授权', from === 'auto' ? nrOn('auto.allowApproval') : from !== 'phone', from === 'phone' ? '手机不能送「授权」类的单（授权后对方可以转走你的代币），请在电脑雷达上操作' : '自动交易遇到「授权」：你没开「自动交易允许授权」，只记录不送'); if (w) return out(false, w); }
    if (from === 'auto') { const w = need('自动买总开关', !radarOff(), '⏸ 自动买总开关没开（或暂停中、时段外、还没完成邀请绑定／第一次设定），自动的不买'); if (w) return out(false, w); return out(true, K.why0 || ''); }
    { const w = need('手动买卖开关', !MANUAL_OFF(), '🔒「手动买卖」没打开，不买'); if (w) return out(false, w); }
    { const w = need('邀请绑定', !LOCKED(), '🔒 还没完成邀请码绑定' + lockWhy() + '：现在只能看、只能卖') /*RISK-FIX 4：讲原因*/; if (w) return out(false, w); }
    if (from === 'force') { const w = need('同钱包另一个雷达', !CONFL, '另一个雷达正在用同一个钱包，强制打不执行'); if (w) return out(false, w); }
    return out(true, K.why0 || '');
  } catch (e) {
    const sellish = K.kind === 'sell' || K.kind === 'revoke';
    checks.push(['读得到资料', 0]);
    return sellish ? out(true, '闸门判断出错，但这是卖出／撤销授权，照常：' + String(e?.message || e)) : out(false, '读不到资料／判断出错，只能不买：' + String(e?.message || e));
  }
}
function guardBaw(W) { if (W._g) return; W._g = 1; const o = W.baw; const g = async (a, ...r) => { const G = await actionGate(W, a); if (!G.ok) { if (!/登入过期/.test(G.why)) log(`[安全] ${W.name} 挡下一笔：${G.why}`); return { t: G.why, j: { success: false, error: { message: G.why } } }; } const res = await o(a, ...r); if (G.rec) { try { const rid = String(res?.j?.data?.requestId || '').toLowerCase(); if (rid) { RID_KIND.set(rid, { kind: G.kind, target: G.target }); if (a[0] === 'contract-call') RID_BUY.set(rid, bawBuyLike(a)); if (RID_BUY.size > 2000) RID_BUY.delete(RID_BUY.keys().next().value); if (RID_KIND.size > RID_KIND_MAX) RID_KIND.delete(RID_KIND.keys().next().value); /*RISK-FIX 5*/ } } catch {} } return res; }; if (o.sh) g.sh = o.sh; if (o.maybeSh) g.maybeSh = o.maybeSh; /*BINDSH108*/ g._gate = 1; W.baw = g; } /* GATE-1：闸门包在最里层（直接包住真正的币安钱包 CLI）；外面再包一层（例如安全哨兵记录交易）照样要先过闸门 */
for (const W of WALLETS) guardBaw(W);
{ const _push = WALLETS.push; Object.defineProperty(WALLETS, 'push', { value: function (...ws) { for (const w of ws) guardBaw(w); return _push.apply(this, ws); }, writable: false, configurable: false }); } /* GATE-1：之后新增的钱包也一定先包上闸门 */
try { for (const W of WALLETS) W.off = !!(S.wOff || {})[W.addr]; } catch {} /* 重开后先沿用上次的登入状态 */
/* UIFIX4：新增／删除钱包立即生效 —— 直接改 WALLETS（同一个阵列，其他模组拿到的也跟着变）、马上重写 data/radar_wallets.json；删掉的钱包之后不再轮询、不再拿来买卖 */
function walApply(type, a, cfg) { const rm = type === 'removeWallet';
  if (rm) { wHidden.add(a); const i = WALLETS.findIndex((w) => w.addr === a); if (i >= 0) WALLETS.splice(i, 1); }
  else { wHidden.delete(a); if (!WALLETS.some((w) => w.addr === a)) { const wc = (Array.isArray(CONFIG.wallets) ? CONFIG.wallets : []).find((x) => String(x?.address || '').toLowerCase() === a); const e = (cfg.add || []).find((x) => String(x.address || '').toLowerCase() === a); if (wc) WALLETS.push(walFromCfg(wc)); else if (e && /^0x[0-9a-fA-F]{40}$/.test(String(e.address || ''))) WALLETS.push(walFromAdd(e)); } }
  ME = WALLETS[0]?.addr || ''; try { dynOwn(); } catch {} try { hidAllChk(0); } catch {} /*V101-4*/ /*RISK-FIX2-3：开机时没有钱包、之后才加的也补上*/
  try { const f = join(DIR, 'data', 'radar_wallets.json'); let j = {}; try { j = JSON.parse(readFileSync(f, 'utf8')) || {}; } catch {} const old = new Map((Array.isArray(j.list) ? j.list : []).map((x) => [String(x?.addr || '').toLowerCase(), x])); writeFileSync(f, JSON.stringify({ at: Date.now(), list: WALLETS.map((W) => old.get(W.addr) || { name: W.name, addr: W.addr, status: 'UNCONNECTED' }) })); } catch {}
  setTimeout(() => { radarWalletPoll(); }, 0);
  const W = WALLETS.find((w) => w.addr === a); return rm ? `✅ 已删除钱包 ${a.slice(0, 8)}…（立即生效：雷达不再用它买卖）` : W ? `✅ 已新增钱包 ${W.name}（立即生效）：请在雷达「设定 → 钱包」按它旁边的「连接（扫码）」` : `❌ 新增钱包失败：${a.slice(0, 8)}…`; }
async function radarWalletPoll(force) { try { const out = []; for (const W of WALLETS) { guardBaw(W); const r = await W.baw(['wallet', 'status'], 60000); const st = r.j?.data?.status || 'UNKNOWN'; if (st !== 'UNKNOWN') { const off = st !== 'CONNECTED'; W.off = off; S.wOff = S.wOff || {}; const seen = W.addr in S.wOff; if (!seen) { S.wOff[W.addr] = off; save(); } /* 第一次看到只记下来，不通知 */ else if (off !== !!S.wOff[W.addr]) { S.wOff[W.addr] = off; save(); log(`[钱包] ${W.name} ${off ? '登出了，自动买卖先跳过这个钱包' : '重新连上了，恢复正常'}`); if (off) { if (!globalThis._loginNowBusy) { globalThis._loginNowBusy = 1; loginCheck().catch((e) => log('loginCheck ' + e.message)).finally(() => { globalThis._loginNowBusy = 0; }); } } /*V102-LOGOUT1：登出只发 loginCheck 那一则（有连结和配对码），这里不再另外发 */ else tg(`✅ ${W.name} 钱包重新连上了，恢复自动买卖`).catch(() => {}); } } out.push({ name: W.name, addr: W.addr, status: st === 'UNKNOWN' && S.wOff && W.addr in S.wOff ? (S.wOff[W.addr] ? 'UNCONNECTED' : 'CONNECTED') : st, ...(st === 'UNKNOWN' ? { stale: 1 } : {}) }); } writeFileSync(join(DIR, 'data', 'radar_wallets.json'), JSON.stringify({ at: Date.now(), list: out })); } catch (e) { log('radarWalletPoll ' + e.message); } }
setInterval(async () => { const q = join(DIR, 'data', 'radar_login_req.json'); if (_loginBusy || !existsSync(q)) return; let req = {}; try { req = JSON.parse(readFileSync(q, 'utf8')); } catch {} try { unlinkSync(q); } catch {} if (Date.now() - (req.at || 0) > 120e3) return;
  const W = WALLETS[Math.max(0, Math.min(WALLETS.length - 1, Number(req.i) || 0))]; const out = join(DIR, 'data', 'radar_login.json'); _loginBusy = true;
  try { writeFileSync(out, JSON.stringify({ state: 'wait', wallet: W.name, at: Date.now() }));
    const si = await W.baw(['auth', 'signin'], 60000); const url = si.j?.data?.urlForWeb, code = si.j?.data?.pairingCode, id = si.j?.data?.qrCodeId;
    if (!id && /ALREADY_CONNECTED/i.test(JSON.stringify(si.j || si.t || ''))) { W.off = false; S.wOff = S.wOff || {}; S.wOff[W.addr] = false; save(); writeFileSync(out, JSON.stringify({ state: 'ok', wallet: W.name, why: '', already: 1, at: Date.now() })); radarWalletPoll(true).catch(() => {}); return; } 
    if (!id || !/^https:\/\/app\.binance\.com\//.test(String(url))) { writeFileSync(out, JSON.stringify({ state: 'fail', wallet: W.name, why: String(si.j?.error?.message || si.t).slice(0, 120), at: Date.now() })); return; } /* 只认币安官方网址 */
    writeFileSync(out, JSON.stringify({ state: 'qr', wallet: W.name, url, code, expire: Number(si.j?.data?.expireAt) || null, at: Date.now() }));
    const v = await W.baw(['auth', 'verify', '--qrCodeId', id], 330000); const ok = v.j?.data?.status === 'SUCCESS';
    writeFileSync(out, JSON.stringify({ state: ok ? 'ok' : 'fail', wallet: W.name, why: ok ? '' : String(v.j?.data?.status || v.j?.error?.message || '').slice(0, 80), at: Date.now() })); if (ok) await tg(`✅ ${W.name} 在雷达连接成功`).catch(() => {});
  } catch (e) { writeFileSync(out, JSON.stringify({ state: 'fail', wallet: W.name, why: e.message.slice(0, 80), at: Date.now() })); } finally { _loginBusy = false; radarWalletPoll(); } }, 3e3).unref();
const PAY_TOK = { BNB: NATIVE_BNB, USDT, USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' };
const PX_TOK = { BTC: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', SOL: '0x570a5d26f7765ecb712c0924e4de545b89fd43df' }; /* UIFIX4：底部状态列的 BTC／SOL 价格＝BNB Chain 上的 BTCB／SOL 代币，跟 BNB 价格同一个来源（PancakeSwap 池子储备）；只显示，不拿来判断任何事 */
async function pairPx(tok, quote) { try { const p = await call(FACTORY, '0xe6a43905' + wa(tok) + wa(quote)); const pair = '0x' + String(p || '').slice(26); if (!/^0x[0-9a-fA-F]{40}$/.test(pair) || /^0x0{40}$/.test(pair)) return null; const r = await call(pair, '0x0902f1ac'); const t0 = await call(pair, '0x0dfe1681'); if (!r || !t0 || r.length < 130) return null;
  const a = BigInt(r.slice(0, 66)), b = BigInt('0x' + r.slice(66, 130)); if (!(a > 0n && b > 0n)) return null; const px = String(t0).slice(26).toLowerCase() === tok.slice(2).toLowerCase() ? Number(b) / Number(a) : Number(a) / Number(b); return Number.isFinite(px) && px > 0 ? px : null; } catch { return null; } }
async function tokUsd(tok, bp) { const u = await pairPx(tok, USDT); if (u != null) return u; const w = bp > 0 ? await pairPx(tok, WBNB) : null; return w != null ? w * bp : null; } /* 读不到＝null（画面显示「-」，不当成 0） */
async function radarBalPoll() { try { const bp = await bnbUsd().catch(() => 0); const ep = RH?.ethUsd ? await RH.ethUsd().catch(() => 0) : 0; const w = [];
  for (const W of WALLETS) { const b = { name: W.name, addr: W.addr, bsc: {}, rh: {} }; { const rd = async (fn) => { for (let i = 0; i < 3; i++) { const h = await fn().catch(() => null); if (h && /^0x[0-9a-f]+$/i.test(h)) return Number(big(h)) / 1e18; } return null; }; /* 节点没回应不能当成 0（走势图会掉一根） */ b.bsc.BNB = await rd(() => rpc('eth_getBalance', [W.addr, 'latest'])); for (const k of ['USDT', 'USDC']) b.bsc[k] = await rd(() => call(PAY_TOK[k], '0x70a08231' + wa(W.addr))); } if (RH?.ethBal) b.rh.ETH = await RH.ethBal(W.addr).catch(() => null); w.push(b); }
  S.curveVal = S.curveVal || {}; for (const t of (S.dyn || []).filter((x) => !x.closed && CURVES[x.addr])) { try { const W = WALLETS.find((x) => x.addr === t.only); if (!W) continue; const bal = big(await call(t.addr, '0x70a08231' + wa(W.addr))); S.curveVal[t.addr + ':' + t.only] = bal > 0n ? (Number(await curveQuote(t.addr, W, bal)) / 1e18) * bp : 0; } catch {} } /* 曲线上的币：用曲线报价算现值 */
  writeFileSync(join(DIR, 'data', 'radar_bal.json'), JSON.stringify({ at: Date.now(), bnbUsd: bp, ethUsd: ep, btcUsd: await tokUsd(PX_TOK.BTC, bp), solUsd: await tokUsd(PX_TOK.SOL, bp), w, caps: { bscMint: PAID.maxUsd, bscTok: AGTOK.usd, rh: RH?.RHC?.usd ?? null, rhMint: RH?.RHC?.mintUsd ?? null, gasBnb: PAID.keepBnb } })); /* 每笔金额：给「钱包总览」算还够打几笔 */
  if (RH?.RHC && !radarOff() && (RH.RHC.auto === 1 || RH.RHC.mintAuto === 1) && ep > 0) { const need = Math.max(RH.RHC.usd ?? 0, RH.RHC.mintUsd ?? 0); const low = need > 0 ? w.filter((b) => b.rh.ETH != null && b.rh.ETH * ep < need) : [];
    if (!low.length) nClear('rhLow'); else if (nOnce('rhLow', low.map((b) => b.name).join())) { save(); tg(`⚠️ Robinhood 自动打是开着的，但这些钱包在 Robinhood 链上的 ETH 不够打一笔：\n${low.map((b) => `[${b.name}] ${b.rh.ETH.toFixed(5)} ETH（约 ${(b.rh.ETH * ep).toFixed(1)}U）`).join('\n')}\n雷达没办法帮你跨链。👉 请叫你的 AI 把 BNB 跨链换成 Robinhood 链（4663）上的 ETH，或到「设定」关掉 Robinhood 自动打。`).catch(() => {}); } } } catch (e) { log('radarBalPoll ' + e.message); } }
setInterval(radarBalPoll, 60e3).unref(); setTimeout(radarBalPoll, 8e3); /* 雷达下单视窗显示每个钱包的余额，不够就提醒 */
setInterval(() => radarWalletPoll(), 60e3).unref(); setTimeout(() => radarWalletPoll(), 8e3);
if ((S.forceAdd || []).length) { const n0 = S.forceAdd.length; S.forceAdd = []; S.forceUsd = {}; save(); try { const D = fsAll(); for (const r of D.list) if (r.state !== 'done') Object.assign(r, { state: 'done', ok: false, reason: '重开后已清空强制打排队（没有执行），要打请再按一次', end: Date.now() }); writeFileSync(FS_F, JSON.stringify({ ...D, at: Date.now() })); } catch {} log(`重开后已清空强制打排队（${n0} 个）`); setTimeout(() => tgSay(`🧹 重开后已清空强制打排队（${n0} 个，都没有执行），要打请在雷达再按一次`).catch(() => {}), 20e3); } /* 强制打只在同一次执行内有效 */
let RH = null; try { const { startRH } = await import('./rh.mjs?v=' + Date.now()); RH = startRH({ WALLETS, log, tg, S, save, radarOff, confl: () => CONFL }); /*RISK-FIX 1*/ globalThis.RH_APPLY = RH.apply; RADAR.at = 0; radarSet(); } catch (e) { log('Robinhood 模组载入失败 ' + e.message); } /* Robinhood Chain 自动打 */
let BA = null; try { const { makeBscAnalyze } = await import('./bscanal.mjs?v=' + Date.now()); BA = makeBscAnalyze({ rpc, rpcBatch, log }); } catch (e) { log('BSC 深度检查模组载入失败 ' + e.message); } /* BSC 也要捆绑检查 */
let BN = null; try { const { startBscNft } = await import('./bscnft.mjs?v=' + Date.now()); BN = startBscNft({ rpc, rpcBatch, WALLETS, log, tg, S, save, radarOff, radarSet, previewExec, bnbUsd }); } catch (e) { log('BSC NFT 载入失败 ' + e.message); } /* BSC NFT 铸造 */
try { if (OWNER_OK() && existsSync(join(DIR, '.sign', 'ave_key.txt'))) { /* 作者本人版（owner.sig 验过）才跑 AVE 看盘资料整理 */ const { startAve } = await import('./ave.mjs?v=' + Date.now()); startAve({ DIR, log, tg: tgSay }); } } catch (e) { log('AVE 资料载入失败 ' + e.message); } /* AVE 合作资料（只有放了金钥的电脑会跑） */
try { const { startSmart } = await import('./smart.mjs?v=' + Date.now()); startSmart({ rpc, log, tg, S, save, radarSet }); } catch (e) { log('聪明钱包载入失败 ' + e.message); } /* 聪明钱包监控，本地跑 */
try { const { startSmartFind } = await import('./smartfind.mjs?v=' + Date.now()); startSmartFind({ DIR, rpc, log }); } catch (e) { log('找聪明钱载入失败 ' + e.message); } 
/* ── AGC-BACK（老板 11/5：AGC 挖矿放回工具，照一般挖矿项目的机制走）
   agcc.fun「免费挖」：押 BNB 换份数，到期领回 BNB＋AGC。清单里跟其他挖矿项目一样（AI专属 → ⛏ AI挖矿），雷达多会的只有「挖」和「领回」：
   · 挖：开关 agc.auto（预设关）＋你填的「每个钱包每天最多几份」agc.maxShares（没填＝不挖）；选填条件「AGC 池子流动性介于」agc.poolMin／agc.poolMax（填了才算，读不到＝不挖）
   · 合约的事实（每份押多少 BNB、押多久才能领回、一次最多领几笔、暂停到什么时候、奖励币地址）每一轮从链上读；读不到＝这一轮不挖。程式里没有金额、没有份数
   · 只做 mintFree（挖）／claimFree（领回）；入池挖 mintPool／claimReward 不做。推荐人一律填零地址（不帮任何人拿推荐）
   · 每一笔都走统一动作闸门（W.baw → actionGate）：挖＝买入（自动买总开关、紧急全停、邀请绑定照常挡）；领回＝只收不付（预演确认只会收到、没有授权才送），紧急全停也照领
   · 开关关掉后：雷达自己挖的那几笔照样到期领回（是你的 BNB）；你在工具外挖的，开关开着才帮你领
   · 每个钱包每一轮的「挖／不挖」都逐条写进判断日志（data/decisions.jsonl） ── */
const AGC = { c: '0x6288dfe86f22b53eeb6886ae2d78941de7483743', mint: '0x0db5ae5a', claim: '0x73fc9ccc', cnt: '0x52c5dc15', pos: '0x7adab542', price: '0xdf1fb713', delay: '0x190da595', batch: '0x950bff9f', until: '0xda748b10', tok: '0x9de60b03',
  err: { f947691f: '这个钱包没有 Agent ID（合约要求要有）', '54a41c8f': '今天的额度已经用完（合约回的）', '7e1f5a77': '这一期已经卖完', '98d4901c': '押的金额跟合约要的不一样', '9811e0c7': '份数是零' }, stopDay: new Set(['f947691f', '54a41c8f', '7e1f5a77']) };
const AGC_T = { tick: 30 * 60e3, first: 90e3, day: 86400 }; /* 技术用：多久看一次、开机后多久第一次看；day＝一天的秒数（合约用「区块时间 ÷ 一天」算今天是第几天）。都跟要不要挖无关 */
function agcClaimOnly(to, d, v) { return v === 0n && String(to || '').toLowerCase() === '0x6288dfe86f22b53eeb6886ae2d78941de7483743' && /^0x73fc9ccc/i.test(String(d || '')); } /* 闸门分类用：AGC 领回（claimFree、不带 BNB）＝只收不付，跟卖出同一类（紧急全停也能领回自己押的 BNB）；送出前预演照样要确认只会收到 */
const agcW = (r, i) => (typeof r === 'string' && /^0x[0-9a-f]*$/i.test(r) && r.length >= 2 + 64 * (i + 1) ? BigInt('0x' + r.slice(2 + 64 * i, 2 + 64 * (i + 1))) : null);
const agcH = (sec) => +(Number(sec) / 3600).toFixed(1); /* 显示用：秒 → 小时 */
const agcB = (wei) => { try { return (Number(BigInt(wei)) / 1e18).toFixed(4).replace(/\.?0+$/, ''); } catch { return '?'; } }; /* 显示用：wei → BNB／AGC */
async function agcRd(data, from, value) { try { return await rpc('eth_call', [{ ...(from ? { from } : {}), to: AGC.c, data, ...(value != null ? { value: '0x' + value.toString(16) } : {}) }, 'latest']); } catch (e) { return e?.revert ? { revert: String(e.data || '') } : null; } }
async function agcFacts() { /* 合约事实：每一轮重读，读不到＝null */
  const one = async (s) => { const r = await agcRd(s); return typeof r === 'string' ? agcW(r, 0) : null; };
  const f = { price: await one(AGC.price), delay: await one(AGC.delay), batch: await one(AGC.batch), until: await one(AGC.until), tok: null, now: null };
  { const t = await one(AGC.tok); f.tok = t != null && t > 0n ? '0x' + t.toString(16).padStart(40, '0') : null; }
  try { const b = await rpc('eth_getBlockByNumber', ['latest', false]); const ts = Number(BigInt(b?.timestamp)); f.now = Number.isFinite(ts) && ts > 0 ? ts : null; } catch {}
  return f;
}
async function agcPositions(addr) { /* 这个钱包在合约里的每一笔免费挖 [{ i, t, shares, bnb, agc, claimed }]；读不到＝null */
  const n = agcW(await agcRd(AGC.cnt + wa(addr)), 0); if (n == null) return null; if (n === 0n) return [];
  const r = await agcRd(AGC.pos + wa(addr) + w(0) + w(n)); if (typeof r !== 'string' || agcW(r, 1) !== n) return null;
  const out = []; for (let i = 0; i < Number(n); i++) { const g = (k) => agcW(r, 2 + i * 5 + k); if (g(4) == null) return null; out.push({ i, t: Number(g(0)), shares: Number(g(1)), bnb: g(2), agc: g(3), claimed: g(4) !== 0n }); }
  return out;
}
async function agcTry(W, n, price) { /* 先用一般 eth_call 模拟（不花钱、不经钱包）：合约肯不肯让这个钱包挖 n 份 */
  const r = await agcRd(AGC.mint + w(n) + w(0), W.addr, price * BigInt(n)); if (typeof r === 'string') return { ok: 1 }; if (r == null) return { why: '读不到（节点没回应）' };
  const d = String(r.revert || ''); const sel = d.slice(2, 10).toLowerCase(); const arg = agcW('0x' + d.slice(10), 0);
  return { sel, arg: arg != null ? Number(arg) : null, why: AGC.err[sel] || '合约拒绝' + (sel ? '（' + sel + '）' : '') };
}
function agcWrite(v) { try { const f = join(DIR, 'data', 'mine_adp.json'); writeFileSync(f + '.tmp', JSON.stringify({ at: Date.now(), agc: v })); renameSync(f + '.tmp', f); } catch {} } /* 给画面／持仓／手机看（只显示） */
function agcSay(text) { log(String(text).replace(/\n/g, ' ')); if (nrOn('agc.tg')) tg(text).catch(() => {}); } /* TG＝你的开关 agc.tg（预设关） */
function agcMineOf(st) { /* 雷达自己挖的那几笔（第几笔）；mints 是 11/2～11/3 那一版记的格式，一起认 */
  const a = Array.isArray(st?.mine) ? st.mine : []; const b = Array.isArray(st?.mints) ? st.mints.filter((m) => m && !m.old && !m.claimed).map((m) => m.i) : [];
  return new Set([...a, ...b].filter((i) => Number.isInteger(i) && i >= 0));
}
let AGC_BUSY = 0;
async function agcTick() {
  if (AGC_BUSY) return; AGC_BUSY = 1;
  try {
    S.agc = S.agc && typeof S.agc === 'object' ? S.agc : {};
    const on = nrOn('agc.auto'); const maxN = nrNum('agc.maxShares'); const pMin = nrNum('agc.poolMin'), pMax = nrNum('agc.poolMax'); const warnH = nrNum('agc.warnH');
    const view = { on: on ? 1 : 0, maxN, poolMin: pMin, poolMax: pMax, facts: null, pool: null, wallets: [] };
    const F = await agcFacts();
    view.facts = { price: F.price != null ? F.price.toString() : null, delay: F.delay != null ? Number(F.delay) : null, batch: F.batch != null ? Number(F.batch) : null, until: F.until != null ? Number(F.until) : null, tok: F.tok, now: F.now };
    const day = F.now != null ? Math.floor(F.now / AGC_T.day) : null; const paused = F.until != null && F.now != null ? F.until > BigInt(F.now) : null;
    const poolOn = on && (pMin != null || pMax != null);
    if (poolOn && F.tok) { const d = await dexScreener(F.tok); const x = d ? Number(d.liq) : NaN; view.pool = Number.isFinite(x) ? x : null; }
    for (const W of [...WALLETS]) {
      const st = (S.agc[W.addr] = S.agc[W.addr] && typeof S.agc[W.addr] === 'object' ? S.agc[W.addr] : {}); const mine = agcMineOf(st);
      const row = { w: W.name, addr: W.addr, n: null, lockedWei: null, lockedN: null, due: null, nextAt: null, today: null, why: '' }; view.wallets.push(row);
      const P = await agcPositions(W.addr);
      if (!P) { row.why = '读不到这个钱包在合约里的纪录'; if (on) nrDecLog('agc', W.addr, 'AGC·' + W.name, { buy: false, text: '⚠️ 读不到这个钱包在合约里的纪录 → 不挖', lines: ['⚠️ 读不到这个钱包在合约里的纪录'], why: '读不到' }, 1); continue; }
      const open = P.filter((p) => !p.claimed); row.n = P.length; row.lockedN = open.length; row.lockedWei = open.reduce((a, p) => a + p.bnb, 0n).toString();
      row.today = day != null ? P.filter((p) => Math.floor(p.t / AGC_T.day) === day).reduce((a, p) => a + p.shares, 0) : null;
      let due = null; if (F.delay != null && F.now != null) { due = open.filter((p) => p.t + Number(F.delay) <= F.now); row.due = due.length; const nx = open.filter((p) => p.t + Number(F.delay) > F.now).map((p) => p.t + Number(F.delay)); row.nextAt = nx.length ? Math.min(...nx) * 1000 : null; }
      /* ① 到期的先领回（只收不付）：雷达挖的一定领；你在工具外挖的，开关开着才领 */
      const pick = (due || []).filter((p) => on || mine.has(p.i));
      if (pick.length && !W.off) {
        const per = F.batch != null && F.batch > 0n ? Number(F.batch) : 1; /* 一次最多领几笔＝合约的 MAX_BATCH；读不到就一笔一笔领 */
        for (let k = 0; k < pick.length; k += per) { const ch = pick.slice(k, k + per); const back = ch.reduce((a, p) => a + p.bnb, 0n), got = ch.reduce((a, p) => a + p.agc, 0n);
          const data = AGC.claim + w(32) + w(ch.length) + ch.map((p) => w(p.i)).join('');
          try {
            await previewExec(W, AGC.c, data, 0n, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化'; const me = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr); if (me.some((b) => Number(b.change) < 0)) return '领回时会扣钱'; if (!me.some((b) => Number(b.change) > 0)) return '预演显示什么都收不到（可能已经领过）'; return ''; }, null, { noDrain: true });
            for (const p of ch) mine.delete(p.i); st.mine = [...mine]; delete st.mints; save(); row.lockedN -= ch.length; row.due -= ch.length; row.lockedWei = (BigInt(row.lockedWei) - back).toString();
            agcSay(`⛏ [${W.name}] AGC 领回 ${ch.length} 笔：退回 ${agcB(back)} BNB＋约 ${agcB(got)} AGC`);
          } catch (e) {
            log(`[AGC][${W.name}] 领回第 ${ch.map((p) => p.i + 1).join('、')} 笔没成功：${String(e?.message || e).slice(0, 120)}`);
            if (warnH != null && warnH > 0 && F.now != null) { st.warned = st.warned && typeof st.warned === 'object' ? st.warned : {}; const late = ch.filter((p) => !st.warned[p.i] && agcH(F.now - (p.t + Number(F.delay))) >= warnH);
              if (late.length) { for (const p of late) st.warned[p.i] = 1; save(); tg(`⚠️ [${W.name}] AGC 第 ${late.map((p) => p.i + 1).join('、')} 笔到期超过 ${warnH} 小时（你设的）还领不回来，请到 agcc.fun 自己看看（合约可能被暂停）`).catch(() => {}); } }
          } }
      }
      /* ② 挖：开关＋你填的份数＋（选填）池子条件，全部过了才挖；读不到任何一项＝不挖 */
      if (!on) continue;
      const lines = ['✅ 自动挖 AGC（你开的）']; let stop = '', n = 0;
      const no = (why, line) => { if (line) lines.push(line); stop = stop || why; };
      if (maxN == null) no('每天最多几份没填', '⚠️ 每个钱包每天最多几份：没填 → 不挖');
      else if (!(Number.isInteger(maxN) && maxN >= 1)) no('份数要是正整数', `⚠️ 每个钱包每天最多几份：${maxN}（要是正整数）→ 不挖`);
      if (!stop) { if (F.price == null || !(F.price > 0n)) no('读不到每份押多少', '⚠️ 每份要押多少 BNB 读不到 → 不挖'); else if (day == null) no('读不到区块时间', '⚠️ 区块时间读不到 → 不挖'); else if (paused == null) no('读不到合约有没有暂停', '⚠️ 读不到合约有没有暂停 → 不挖'); else if (paused) no('合约暂停中', `⏸ 合约暂停中（到 ${new Date(Number(F.until) * 1000).toLocaleString()}）→ 不挖`); }
      if (!stop) { const left = maxN - row.today; lines.push(`${left > 0 ? '✅' : '❌'} 今天已挖 ${row.today} 份（你设每个钱包每天最多 ${maxN} 份）`); if (left <= 0) no('今天份数到了'); else n = left; }
      if (!stop && poolOn) { if (view.pool == null) no('AGC 池子流动性读不到', '⚠️ AGC 池子流动性读不到 → 不挖'); else { const okP = (pMin == null || view.pool >= pMin) && (pMax == null || view.pool <= pMax); lines.push(`${okP ? '✅' : '❌'} AGC 池子流动性 ${Math.round(view.pool)}U（你设${pMin != null && pMax != null ? '介于 ' + pMin + ' 到 ' + pMax : pMin != null ? '至少 ' + pMin : '最多 ' + pMax}U）`); if (!okP) no('池子流动性不在你设的范围'); } }
      if (!stop && st.skipDay === day) no('今天合约已经说不行', `⏸ 今天合约已经回过「${st.skipWhy || '不行'}」，明天（合约换日）再试`);
      if (!stop && W.off) no('钱包没登入', '⏸ 这个钱包没登入 → 不挖');
      if (!stop && radarOff()) no('自动买总开关没开', '⏸ 自动买总开关没开（或暂停中、紧急全停、时段外、还没完成邀请绑定／第一次设定）→ 不挖');
      let bal = null; if (!stop) { try { bal = big(await rpc('eth_getBalance', [W.addr, 'latest'])); } catch { bal = null; }
        if (bal == null) no('BNB 余额读不到', '⚠️ BNB 余额读不到 → 不挖');
        else { const keepWei = BigInt(Math.round(Number(PAID.keepBnb) * 1e18)); const can = bal > keepWei ? Number((bal - keepWei) / F.price) : 0; const ok = can >= 1; lines.push(`${ok ? '✅' : '❌'} BNB 余额 ${agcB(bal)}（每份押 ${agcB(F.price)}${PAID.keepBnb > 0 ? '，你设至少留 ' + PAID.keepBnb : ''}）够挖 ${can} 份`); if (!ok) no('BNB 不够'); else n = Math.min(n, can); } }
      if (!stop) { /* 合约肯给几份：先用模拟问（不花钱）；额度不够就照合约说剩几份 */
        while (n >= 1) { const r = await agcTry(W, n, F.price); if (r.ok) break;
          if (r.sel === '54a41c8f' && r.arg != null && r.arg >= 1 && r.arg < n) { lines.push(`… 合约说今天只剩 ${r.arg} 份`); n = r.arg; continue; }
          if (AGC.stopDay.has(r.sel)) { st.skipDay = day; st.skipWhy = r.why; save(); }
          no(r.why, `❌ 模拟挖 ${n} 份：${r.why} → 不挖`); n = 0; break; } }
      const J = { buy: !stop && n >= 1, lines, why: stop, text: lines.join('　') + ' → ' + (!stop && n >= 1 ? `挖 ${n} 份` : '不挖' + (stop ? '（' + stop + '）' : '')) };
      nrDecLog('agc', W.addr, 'AGC·' + W.name, J, 1); if (!J.buy) continue;
      const val = F.price * BigInt(n); const idx = P.length;
      try {
        await previewExec(W, AGC.c, AGC.mint + w(n) + w(0), val, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化'; const out = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !String(b.contractAddress || '').toLowerCase().startsWith('0xeeee')); return out.length ? '会扣到别的币' : ''; }, null, { noDrain: true });
        mine.add(idx); st.mine = [...mine]; delete st.mints; save(); row.today += n; row.lockedN += 1; row.lockedWei = (BigInt(row.lockedWei) + val).toString();
        nrDecLog('agc', W.addr, 'AGC·' + W.name, { buy: true, lines: [...lines, `✅ 实际挖到 ${n} 份`], why: '', text: J.text + '　✅ 实际挖到' }, 1);
        agcSay(`⛏ [${W.name}] AGC 挖了 ${n} 份（押 ${agcB(val)} BNB；合约说 ${F.delay != null ? agcH(F.delay) + ' 小时' : '到期'}后可以领回 BNB＋AGC，雷达会自动领）`);
      } catch (e) {
        const m = String(e?.message || e); nrDecLog('agc', W.addr, 'AGC·' + W.name, { buy: false, lines: [...lines, '⛔ ' + m.slice(0, 120)], why: m.slice(0, 80), text: J.text + '　⛔ 没送出：' + m.slice(0, 120) }, 1);
        if (/結果不明|结果不明/.test(m)) { st.skipDay = day; st.skipWhy = '送出结果不明'; save(); tg(`⚠️ [${W.name}] AGC 送出结果不明，今天先不再试，请到 agcc.fun 看看`).catch(() => {}); }
      }
    }
    agcWrite(view);
  } finally { AGC_BUSY = 0; }
}
/* AGC-BACK END */
setTimeout(() => agcTick().catch((e) => log('AGC ' + e.message)), AGC_T.first); setInterval(() => agcTick().catch((e) => log('AGC ' + e.message)), AGC_T.tick); /* AGC-BACK 排程 */
try { const { startAir } = await import('./air.mjs?v=' + Date.now()); startAir({ DIR, WALLETS, rpc, log, tgSay, radarSet }); } catch (e) { log('空投页载入失败 ' + e.message); } 
try { const { startMintPick } = await import('./mintpick.mjs?v=' + Date.now()); globalThis.MINTPICK = startMintPick({ scanBack, DIR, S, save, WALLETS, rpc, rpcBatch, logsRpc, log, tg, freshDeadline, safeAddrs, revWhy, badSel, bnbUsd, previewExec, drainCheck, trackFromSim, codeOf, fullCode, estop: () => ESTOP(), manualOff: () => MANUAL_OFF(), confl: () => !!CONFL, locked: () => LOCKED(), keepBnb: () => PAID.keepBnb }); } catch (e) { log('选打法模组载入失败 ' + e.message); } /* 认不出打法的项目让你自己选 */
try { const { startSentinel } = await import('./sentinel.mjs?v=' + Date.now()); globalThis.SENTINEL = startSentinel({ DIR, S, save, WALLETS, rpc, logsRpc, log, tgSay, nOnce, rhRpc: () => RH?.rpc || null }); } catch (e) { log('安全哨兵载入失败 ' + e.message); } /* 🛡 安全哨兵（只提醒，全部预设关） */
try { const { startElysium } = await import('./elysium.mjs?v=' + Date.now()); globalThis.ELYSIUM = startElysium({ DIR, log, radarSet }); } catch (e) { log('Elysium 监测载入失败 ' + e.message); } /* ELY107 🌐 Elysium 只读监测：不给钱包、不签名、不送交易；开关 ely.on 预设关 */
try { const { startJournal } = await import('./journal.mjs?v=' + Date.now()); startJournal({ DIR, S, save, WALLETS, log, tg }); } catch (e) { log('交易日记载入失败 ' + e.message); } /* 交易日记，全部本地跑 */
try { const { startPlugins } = await import('./plugins.mjs?v=' + Date.now()); await startPlugins({ DIR, WALLETS, log, tg, S, save, radarOff, radarSet, rpc, walletBusy: () => INFLIGHT > 0, keepBnb: () => PAID.keepBnb /* 传读取函式，设定改了马上生效 */, bnbUsd }); } catch (e) { log('外挂载入器失败 ' + e.message); } /* 量化外挂（网格、定投…），要在雷达按允许才载入 */
const AUTO_INFL = new Set(); /* 自动策略之间不重复买同一个币（一个在买时，另一个跳过） */
async function tgBuy(ca, usd, opt = {}) { if (!opt.auto) return tgBuy0(ca, usd, opt); const k = String(ca || '').toLowerCase(); if (AUTO_INFL.has(k) || S.agTok?.[k] === 'buy') return '⏳ 另一个自动策略正在买／已经买了这个币，这次不重复买'; AUTO_INFL.add(k); try { return await tgBuy0(ca, usd, opt); } finally { AUTO_INFL.delete(k); } }
async function tgBuy0(ca, usd, opt = {}) { { const bb = opt.auto ? (ESTOP() ? '🛑 紧急全停中，自动买不执行' : '') : buyBlock(); if (bb) return bb; } /* 自动买不看「手动买卖」开关 */ if (LOCKED()) return '🔒 还没完成邀请码绑定：现在只能看，不能买卖'; /* TG 指令「/打 合约 金额U」：用第一个钱包透过币安钱包买（曲线盘、已上池子都一样） */
  ca = ca.toLowerCase(); usd = Number(usd) > 0 ? Number(usd) : Number(opt.bnb) > 0 ? 0 : NR.num('manual.defUsd') ?? 0; /* 没写金额＝用你设的预设金额，没设就不买 */ /* 金额由用户自己决定 */ const price = await bnbUsd().catch(() => 0); if (!(price > 0)) return '读不到 BNB 价格，稍后再试';
  let hp = null; try { hp = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${ca}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); } catch {} /* 手动买也先过貔貅／税率检查 */
  const ackB = !!(opt.ack || ACK.getStore()?.ack); const ackW = []; /* 手动买＝只警告，你按「我知道风险，仍然执行」才送；自动买＝照你的开关 */
  if (hp?.honeypotResult?.isHoneypot === true) { if (opt.auto) { if (NR.on('risk.autoSkipHoneypot')) return '❌ 没买：模拟卖出失败，是貔貅（你开着「自动买跳过貔貅」底线）'; } else if (!ackB) return '⚠️需要确认：honeypot.is 模拟卖出失败，很可能是貔貅——买进去之后可能卖不掉，这笔钱可能全部拿不回来（按「我知道风险，仍然执行」才会买）'; else ackW.push('貔貅（模拟卖出失败）'); }
  const hbt = Number(hp?.simulationResult?.buyTax), hst = Number(hp?.simulationResult?.sellTax);
  const mxT = opt.maxTax !== undefined ? opt.maxTax : NR.num('manual.maxTax'); if (mxT != null && (hbt > mxT || hst > mxT)) { if (opt.auto) return `❌ 没买：税超过你设的上限（买 ${hbt}%／卖 ${hst}%，你的上限 ${mxT}%）`; if (!ackB) return `⚠️需要确认：税超过你设的上限（买 ${hbt}%／卖 ${hst}%，你的上限 ${mxT}%）——买进时先被扣 ${hbt}%，之后卖出再被扣 ${hst}%，例如买 100U 卖掉大约只剩 ${Math.max(0, Math.round((100 - hbt) * (100 - hst) / 100))}U（按「我知道风险，仍然执行」才会买）`; ackW.push(`税超过你的上限（买 ${hbt}%／卖 ${hst}%）`); } /* 一般新币自动买用自己的税上限，不跟 AI 热门代币的设定绑在一起 */
  const hpWarn = ackW.length ? `\n⚠️ 你按了「我知道风险，仍然执行」：${ackW.join('；')}` : hp?.simulationSuccess ? `\n🛡 貔貅检查通过（买税 ${hbt}%／卖税 ${hst}%）` : '\n⚠️ 查不到貔貅检查结果（可能还在曲线盘、没上池子），照你的指示已买，风险自负';
  const wq = String(opt.w || '').toLowerCase(); const W = wq ? WALLETS.find((x) => x.addr === wq) : WALLETS.find((x) => !x.off) || WALLETS[0]; if (!W) return '❌ 你选的钱包不在雷达里了，没买'; if (W.off) return `❌ 你选的钱包 ${W.name} 登入过期，请先重新连接，没买`; /* 你选了钱包就只用那个，找不到不会换别的钱包；没选才用第一个有登入的 */ const pay = Number(opt.bnb) > 0 ? 'BNB' : PAY_TOK[opt.pay] ? opt.pay : 'BNB'; if (Number(opt.bnb) > 0) usd = Number(opt.bnb) * price; /* 一键买可以直接设「几 BNB」→ 用 BNB 付这么多，不换算、不换币 */ 
  if (!(usd > 0)) return '❌ 没写要买多少（在设定的「下单方式」可以设「没写金额时默认买多少」）';
  const bnbHave = Number(big(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; const have = pay === 'BNB' ? bnbHave : pay === 'USDT' ? Number(await usdtFree(W)) / 1e18 : Number(big(await call(PAY_TOK[pay], '0x70a08231' + wa(W.addr)))) / 1e18; /* USDT 扣掉外挂（网格／定投）今天要用的 */
  if (pay !== 'BNB' && NR.num('risk.minGasBnb') != null && bnbHave < NR.num('risk.minGasBnb')) return `❌ [${W.name}] BNB 只剩 ${bnbHave.toFixed(4)}，付不起手续费（gas）。用 ${pay} 买也要一点 BNB 当手续费，而且之后卖出也要。\n👉 请先换一点 BNB 到这个钱包当手续费`; const need = pay === 'BNB' ? usd / price + PAID.keepBnb : usd; /* BNB 付的话留一点当之后卖出的手续费 */
  if (have < need) return `❌ 余额不够：[${W.name}] 只有 ${have.toFixed(pay === 'BNB' ? 4 : 2)} ${pay}（约 ${(pay === 'BNB' ? have * price : have).toFixed(1)}U），这次要 ${pay === 'BNB' ? (usd / price).toFixed(4) + ' BNB＋手续费' : usd + ' ' + pay}。\n👉 请叫你的 AI 把钱包里的其他币换成 ${pay}，或在雷达改用别的币付`;
  /* 防夹：用币安钱包自己的「自动滑点」＋防夹（MEV 保护）；自动滑点买不进去要不要改滑点重试＝你的 buy.retrySlip；拆几笔＝你的设定 */
  let sandPx = 0, sandB0 = 0n, sandDec = 18; try { const dx = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/' + ca, { signal: AbortSignal.timeout(8000) })).json(); sandPx = Number((dx?.pairs || []).filter((p) => p.chainId === 'bsc').sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0]?.priceUsd) || 0; sandB0 = big(await call(ca, '0x70a08231' + wa(W.addr))); sandDec = Number(big(await call(ca, '0x313ce567'))) || 18; } catch {}
  const parts = splitParts(usd); /* 拆单＝你的设定 */ let okN = 0, unkN = 0, lastErr = '';
  for (let k = 0; k < parts; k++) { const part = usd / parts; const q = pay === 'BNB' ? (part / price).toFixed(6) : part.toFixed(4);
    const go = (sl) => W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', q, '--fromToken', pay === 'BNB' ? NATIVE_BNB : PAY_TOK[pay], '--toToken', ca, '--slippage', sl]);
    let sw = await go('auto'); if (!sw.j?.success && (!sw.j && TIMEOUT_RE.test(sw.t || ''))) { unkN++; lastErr = '结果不明：送出逾时，可能已经成交，为了不重复买没有再试（看 TG／钱包确认）'; break; } { const rs = NR.num('buy.retrySlip'); if (!sw.j?.success && rs != null) { log(`[${W.name}] 自动滑点没成交，改 ${rs}% 再试一次：` + String(sw.j?.error?.message || sw.t).slice(0, 80)); sw = await go(String(rs)); if (!sw.j && TIMEOUT_RE.test(sw.t || '')) { unkN++; lastErr = '结果不明：改滑点再试那笔送出逾时，可能已经成交，没有再试'; break; } } } 
    if (sw.j?.success) okN++; else { lastErr = String(sw.j?.error?.message || sw.t).slice(0, 100); break; } if (k < parts - 1) await sleep(1500); }
  if (unkN) { const uU = usd * (okN + unkN) / parts; S.dyn = S.dyn || []; const ex = S.dyn.find((x) => x.addr === ca && x.only === W.addr && !x.closed); if (ex) { ex.cost = +((+ex.cost || 0) + uU).toFixed(2); ex.pending = 1; } else S.dyn.push({ sym: String(opt.name || '').slice(0, 24) || ca.slice(0, 8), addr: ca, cost: +uU.toFixed(2), only: W.addr, boughtAt: Date.now(), src: 'manual', pending: 1 }); save(); return `⚠️ [${W.name}] 买入结果不明：${lastErr}\n先照可能花掉的 ${uU.toFixed(2)}U 记成本／额度，持仓标「结果不明」，读到余额会自动接着追踪`; } /* 不明≠失败 */
  if (!okN) return '❌ 买入失败：' + lastErr; if (okN < parts) usd = usd * okN / parts;
  let sandWarn = ''; try { if (sandPx > 0) { await sleep(2500); const got = Number(big(await call(ca, '0x70a08231' + wa(W.addr))) - sandB0) / 10 ** sandDec; if (got > 0) { const paid = usd / got, over = (paid / sandPx - 1) * 100 - (Number.isFinite(hbt) ? hbt : 0); if (NR.num('buy.sandWarnPct') != null && over >= NR.num('buy.sandWarnPct')) { sandWarn = `\n⚠️ 这笔成交价比市价贵约 ${over.toFixed(0)}%（扣掉买税后），可能被夹子夹了或池子太小滑点大。下次可以买少一点、分开买，或等池子大一点`; log(`[${W.name}] 防夹提醒 ${ca} 贵 ${over.toFixed(1)}%`); } } } } catch {}
  S.dyn = S.dyn || []; { const ex = S.dyn.find((x) => x.addr === ca && x.only === W.addr && !x.closed); const tps = opt.tpsl === undefined ? TPSL_DEF() : tpslNorm(opt.tpsl); if (ex) { ex.cost = +((+ex.cost || 0) + usd).toFixed(2); if (opt.tpsl !== undefined || (tps && !ex.tpsl)) ex.tpsl = tps || undefined; } /* 同一个币再买一次，成本要加上去，不然盈亏会算错 */ else { let nm = String(opt.name || '').slice(0, 24); if (!nm) { try { nm = tokStr(await call(ca, '0x95d89b41')).slice(0, 24); } catch {} } /* TGE2E：TG「打 合约」没有名字 → 读链上代号，之后才能用「卖 代号」卖；读不到才用地址开头 */ S.dyn.push({ sym: nm || ca.slice(0, 8), addr: ca, cost: usd, only: W.addr, boughtAt: Date.now(), src: 'manual', ...(tps ? { tpsl: tps } : {}) }); } } /* 持仓分「一般代币（手动／一键买）」和「AI 专属」 */ save(); return `✅ [${W.name}] 已用 ${pay} 买入 ${+usd.toFixed(2)}U，加入持仓监控` + (((S.dyn || []).find((x) => x.addr === ca && x.only === W.addr && !x.closed) || {}).tpsl ? `\n📉 止盈止损：${tpslTxt(S.dyn.find((x) => x.addr === ca && x.only === W.addr && !x.closed).tpsl)}` : '\n（没设止盈止损：不会自动卖，要卖自己按）') + hpWarn + sandWarn;
}
/* ZR-W3 运作常数 */
const CAND_STALE_MS = 10 * 60e3; /* 运作：雷达写的候选档太久没更新＝雷达没开，不拿旧资料来买 */
const GEN_RECHK_MS = 10 * 60e3; /* 运作：没过条件的候选隔这么久再看一次（不是丢掉） */
const AG_CHK_MS = 60e3, AG_RECHK_MS = 10 * 60e3; /* 运作：AI 热门代币同一个币最快多久查一次／「先不打」的隔多久再查 */

const NONCE_TTL_MS = 30 * 60e3; /* 运作：钱包交易次数的快取时间 */
const AN_TIMEOUT_MS = 45e3; /* 运作：持币分析等太久就当读不到 */
// BNB Chain「一般新币自动买」（Flap／Four／Genius／V4 新币）。预设关闭，玩家自己在「自订策略 → 一般代币」新增才会动；每条规则都是开关＋数字 ──
async function genScan() {
  const z = radarSet(); if (!Number(z['gen.auto']) || radarOff() || LOCKED()) return;
  const n = (k) => NR.num(k); const on = (k) => NR.on(k); 
  let J; try { J = JSON.parse(readFileSync(join(DIR, 'data', 'bsc_cand.json'), 'utf8')); } catch { return; } if (!(Number(J.at) > 0) || Date.now() - J.at > CAND_STALE_MS) return; /* 雷达没开就没有候选 */
  const now = Date.now(), today = new Date().toDateString(); S.gen = S.gen || {}; if (S.genDay?.d !== today) S.genDay = { d: today, u: 0 };
  const usd = n('gen.usd'), dayUsd = n('gen.dayUsd'), maxPos = n('gen.maxPos'); if (usd == null || dayUsd == null) return;
  let openN = (S.dyn || []).filter((t) => t.src === 'gen' && !t.closed).length; if (maxPos > 0 && openN >= maxPos) return; if (S.genDay.u + usd > dayUsd) return;
  const held = new Set((S.dyn || []).map((t) => String(t.addr).toLowerCase()));
  const perRound = n('gen.perRound'); let tried = 0; /* 每轮最多下单几次＝你的设定（没填＝不限，照每笔／每天／持有上限） */
  for (const x of (J.list || [])) { /* 候选全部看，不截断 */
    if (perRound != null && tried >= perRound) break; if (maxPos > 0 && openN >= maxPos) break; if (S.genDay.u + usd > dayUsd) break;
    const c = String(x.c || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(c) || held.has(c)) continue; const g = S.gen[c]; if (g && (g.final || now - g.at < GEN_RECHK_MS)) continue;
    const sym = String(x.sym || '').slice(0, 24) || c.slice(0, 8); const ageMin = Number(x.at) > 0 ? (now - x.at) / 60e3 : null; /* 读不到开盘时间＝读不到 */
    const no = (why, final) => { S.gen[c] = { at: now, why, final: !!final }; if (why !== '已买') nrDecSkip('gen', c, sym, why); }; /* 每一个「不买」都写判断日志 */
    if (x.curve && on('gen.skipCurve')) { no('还在发射平台曲线上（没毕业），自动买只买已上池子的币'); continue; }
    { const k = sym.toLowerCase(); S.genSym = S.genSym || {}; const f0 = S.genSym[k]; const fwH = n('risk.firstWinH'), fwMs = fwH != null ? fwH * 3600e3 : Infinity; if (!f0 || now - f0.t > fwMs) S.genSym[k] = { c, t: now }; else if (f0.c !== c && on('risk.firstOnly')) { no(`同名币${fwH != null ? ' ' + fwH + ' 小时内' : ''}只买第一个（防抄名钓鱼）`, 1); continue; } }
    const o = { age: ageMin, liq: +x.liq > 0 ? +x.liq : null, mc: +x.mc > 0 ? +x.mc : null, /* 0／空＝读不到 */ buys: Number.isFinite(+x.b) ? +x.b : null, x: !!x.x, smart: !!(S.smartW?.seen?.['bsc' + c + '买'] && (n('gen.smartWinH') == null || now - S.smartW.seen['bsc' + c + '买'] < n('gen.smartWinH') * 3600e3)), call: !!S.callHits?.[c], ...kolO('gen', 'bsc', c) /* KOL-AVE */ }; const GJ = () => nrJudge('gen', genConds(o)); /* 条件照你的组合方式 */
    { const J = GJ(); if (J.buy === false) { nrDecLog('gen', c, sym, J); no(J.why); continue; } }
    if (on('gen.antiWash') && n('gen.washBuys') != null && n('gen.washSells') != null && !(Number.isFinite(+x.b) && Number.isFinite(+x.s) && x.b != null && x.s != null)) { no('假热度检查读不到 1 小时买卖笔数（你开了「假热度」）'); continue; } 
    if (on('gen.antiWash') && n('gen.washBuys') != null && n('gen.washSells') != null && +x.b >= n('gen.washBuys') && +x.s <= n('gen.washSells')) { no('假热度（只有买没有卖）', 1); continue; }
    const dep = await deployerOf(c).catch(() => ''); if (dep && (blackOn(dep) || isRepeatDev(dep))) { no('部署者在黑名单或大量部署', 1); continue; }
    if (['gen.maxBundle', 'gen.maxTop10', 'gen.minReal'].some((k) => n(k) != null)) { const A = BA ? await Promise.race([BA.analyze(c, '').catch((e) => ({ ok: false, why: e.message })), new Promise((ok) => setTimeout(() => ok({ ok: false, why: '查太久' }), AN_TIMEOUT_MS))]) : null; const F = A?.ok ? A.facts || {} : null; o.bundle = F && F.bundlePct != null ? F.bundlePct * 100 : null; o.top10 = F ? F.top10 * 100 : null; o.real = F ? F.realBuyers : null; /* 查不到＝读不到（照你选的） */
      const J = GJ(); if (J.buy === false) { nrDecLog('gen', c, sym, J); no(J.why); continue; } }
    { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'general', c, sym, liqUsd: x.liq, mc: x.mc, ageMin, buys1h: x.b, sells1h: x.s }); if (cs) { no('自订规则不打：' + cs, 1); continue; } }
    { let hp = null; try { hp = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${c}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); } catch {} const bt = Number(hp?.simulationResult?.buyTax), st = Number(hp?.simulationResult?.sellTax); /* 自动买比手动严格：查不到模拟卖出结果就不买 */
      { const cr = await codeRisk('bsc', c).catch(() => ''); if (cr) { no(cr, 1); continue; } }
      if (hp?.honeypotResult?.isHoneypot === true && NR.on('risk.autoSkipHoneypot')) { no('貔貅（模拟卖出失败；你开着「自动买跳过貔貅」底线）', 1); continue; } if (NR.on('risk.needHp') && hp?.honeypotResult?.isHoneypot !== true && (!hp?.simulationSuccess || !(bt >= 0) || !(st >= 0))) { no('查不到貔貅检查结果'); continue; } o.tax = Number.isFinite(bt) && Number.isFinite(st) ? Math.max(bt, st) : null; }
    const GJF = GJ(); nrDecLog('gen', c, sym, GJF); if (GJF.buy !== true) { no(GJF.why || '没过你的条件'); continue; } 
    no('已买', 1); save(); /* 先记下来：同一个币不会因为重试买两次 */
    const r = await tgBuy(c, usd, { auto: 1, name: sym, maxTax: null }).catch((e) => '❌ ' + e.message); /* 跟一键买走同一套：赑貅／税检查、余额、自动滑点＋防夹、拆单、防夹提醒 */
    if (/^⚠️ \[[^\]]*\] 买入结果不明/.test(r)) { S.genDay.u += usd; save(); await tg(`⚠️ 一般新币自动买：${sym} ${r}\n${c}`).catch(() => {}); } /* 结果不明照可能花掉的算额度 */
    else if (/^✅/.test(r)) { S.genDay.u += usd; for (const t of S.dyn || []) if (t.addr === c && !t.src2) { t.src = 'gen'; t.src2 = 1; } save(); await tg(`🚀 一般新币自动买：${sym}（${x.plat || ''}）| 市值 $${Math.round(x.mc || 0)} · 流动性 $${Math.round(x.liq || 0)} · 1 小时 ${x.b} 买／${x.s} 卖\n${r}\n${c}` + nrTgWhy(GJF)); }
    else { S.gen[c] = { at: now, why: r.slice(0, 60), final: /[贔赑貔]貅/.test(r) }; log(`[一般新币] ${sym} 没买：${r.slice(0, 120)}`); }
    nrDecRes('gen', c, sym, /^✅/.test(r) ? 'bought' : /买入结果不明/.test(r) ? 'unknown' : 'none', /^✅/.test(r) ? '' : r); 
    tried++; if (/^✅/.test(r)) { openN++; held.add(c); } /* 照你的每轮／每天／持有上限 */
  }
}

/* 按「份数」铸造（Share Mint 这类）：雷达自己看别人成功的铸造交易，算出「每份多少 BNB」，再用模拟试出「每个钱包最多几份」；用户填份数，照份数铸 ── */
const SHARE_F = join(DIR, 'data', 'share_info.json');
async function shareLearn(c) {
  const samples = []; const P = S.paid?.[c];
  if (P?.replay?.data && BigInt(P.replay.value || 0) > 0n) samples.push({ data: String(P.replay.data), value: BigInt(P.replay.value), from: '' });
  try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const hs = new Set();
    for (let to = head, k = 0; to > head - 40000 && hs.size < 40 && k < 8; to -= 5000, k++) { const L = await logsRpc([{ address: c, fromBlock: '0x' + Math.max(1, to - 4999).toString(16), toBlock: '0x' + to.toString(16) }]).catch(() => []); for (const l of (L || []).reverse()) { hs.add(l.transactionHash); if (hs.size >= 40) break; } }
    const txs = await rpcBatch([...hs].map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    for (const t of txs || []) { if (!t || String(t.to || '').toLowerCase() !== c) continue; const v = BigInt(t.value || '0x0'); if (v <= 0n) continue; samples.push({ data: String(t.input), value: v, from: String(t.from).toLowerCase() }); } } catch {}
  if (!samples.length) return { c, ok: 0, why: '还没看到别人付 BNB 成功铸造的交易，算不出每份价格' };
  const bySel = {}; for (const s of samples) (bySel[s.data.slice(0, 10)] = bySel[s.data.slice(0, 10)] || []).push(s);
  const [sel, arr] = Object.entries(bySel).sort((a, b) => b[1].length - a[1].length)[0];
  const words = (d) => (d.slice(10).match(/.{64}/g) || []).map((x) => BigInt('0x' + x));
  const nW = words(arr[0].data).length; let idx = -1, unit = 0n;
  for (let i = 0; i < nW && idx < 0; i++) { const ks = arr.map((s) => words(s.data)[i]); if (ks.some((k) => !(k >= 1n && k <= 100000n))) continue; const us = arr.map((s, j) => (s.value % ks[j] === 0n ? s.value / ks[j] : -1n)); if (us.some((u) => u <= 0n)) continue; if (us.every((u) => u === us[0]) && (arr.length > 1 ? new Set(ks.map(String)).size > 1 || ks[0] > 1n : ks[0] >= 1n)) { idx = i; unit = us[0]; } }
  if (idx < 0) { const vs = arr.map((s) => s.value).sort((a, b) => (a < b ? -1 : 1)); unit = vs[Math.floor(vs.length / 2)]; } /* 没有份数参数：一次就是一份 */
  return { c, ok: 1, sel, idx, unit: unit.toString(), tpl: arr[0].data, from: arr[0].from, n: arr.length, at: Date.now() };
}
function shareData(info, W, n) { let d = info.tpl.slice(10); if (info.from) d = d.split(info.from.slice(2).padStart(64, '0')).join(W.addr.slice(2).padStart(64, '0')); const ws = d.match(/.{64}/g) || []; if (info.idx >= 0) ws[info.idx] = w(n); return info.tpl.slice(0, 10) + ws.join(''); }
async function shareCap(info, W) { if (info.idx < 0) { const ws = (info.tpl.slice(10).match(/.{64}/g) || []); for (let i = 0; i < ws.length && info.idx < 0; i++) { if (BigInt('0x' + ws[i]) !== 1n) continue; const t = { ...info, idx: i }; try { await rpc('eth_call', [{ from: W.addr, to: info.c, data: shareData(t, W, 2), value: '0x' + (BigInt(info.unit) * 2n).toString(16) }, 'latest']); info.idx = i; } catch {} } if (info.idx < 0) return 1; } let ok = 0; for (const n of [1, 2, 3, 5, 10, 20, 50, 100]) { try { await rpc('eth_call', [{ from: W.addr, to: info.c, data: shareData(info, W, n), value: '0x' + (BigInt(info.unit) * BigInt(n)).toString(16) }, 'latest']); ok = n; } catch { break; } } return ok; }
async function shareInfo(c) { const info = INFRA.has(c) || ['0x10ed43c718714eb63d5aa57b78b54704e256024e', '0x13f4ea83d0bd40e75c8222255bc855a974568dd4', '0x1b81d678ffb9c0263b24a97847620c99d213eb14'].includes(c) ? { c, ok: 0, why: '这是交易所路由／基础合约，不是铸造合约' } : await shareLearn(c); if (info.ok) { const W = WALLETS.find((x) => !x.off) || WALLETS[0]; info.cap = W ? await shareCap(info, W).catch(() => 0) : 0; const px = await bnbUsd().catch(() => 0); info.unitBnb = Number(BigInt(info.unit)) / 1e18; info.unitUsd = px ? +(info.unitBnb * px).toFixed(2) : 0; const P = S.paid?.[c]; if (P) { info.prog = P.progress > 0 ? Math.round(P.progress * 100) : null; /*V104-CAPSANE：读不到＝不显示百分比*/ info.ag = P.agents || 0; } }
  let all = {}; try { all = JSON.parse(readFileSync(SHARE_F, 'utf8')); } catch {} all[c] = info; const ks = Object.keys(all); if (ks.length > 50) for (const k of ks.slice(0, ks.length - 50)) delete all[k]; writeFileSync(SHARE_F, JSON.stringify(all)); return info; }
async function shareMint(c, n, wAddr, maxBnb) {
  if (LOCKED()) return '🔒 还没完成邀请码绑定：现在只能看，不能买卖';
  const wq = String(wAddr || '').toLowerCase(); const W = wq ? WALLETS.find((x) => x.addr === wq) : WALLETS.find((x) => !x.off); if (!W) return wq ? '❌ 你选的钱包不在雷达里了，没铸造' : '❌ 没有连上的钱包'; if (W.off) return `❌ ${W.name} 钱包登入过期，请先重新连接`; 
  const bk = c + '|' + W.addr; if (SHARE_BUSY.has(bk)) return `⏳ [${W.name}] 这个项目正在铸造，等它做完`; { const P0 = S.paid?.[c]; if (P0?.done?.[W.name] === 'unknown') return `⚠️ [${W.name}] 上一次铸造结果不明（可能已成交），为了不重复付钱先不重打；确认钱包后再处理`; } SHARE_BUSY.add(bk); try { /* 同一个钱包同一个项目一次只铸一笔 */
  const info = await shareLearn(c); if (!info.ok) return '❌ ' + info.why; n = Math.max(1, Math.min(100, Math.round(+n || 1))); if (info.idx < 0 && n > 1) n = 1;
  const val = BigInt(info.unit) * BigInt(n); const data = shareData(info, W, n);
  if (NR.on('bsc.sharePriceGuard') && !(+maxBnb > 0)) return '❌ 没有收到你确认的金额，为了安全没有铸造（请重新按一次）'; if (NR.on('bsc.sharePriceGuard') && Number(val) / 1e18 > +maxBnb) return `❌ 价格变了：现在要 ${(Number(val) / 1e18).toFixed(6)} BNB，比你确认的 ${(+maxBnb).toFixed(6)} BNB 高，为了安全没有铸造（重新看一下再决定）`; if (ESTOP()) return '🛑 紧急全停中，不铸造';
  try { const r = await previewExec(W, c, data, val, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化'; const out = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && Number(b.change) < 0 && !String(b.contractAddress || '').toLowerCase().startsWith('0xeeee')); return out.length ? '会扣到别的币' : ''; }, null, { manual: true });
    const P = (S.paid = S.paid || {})[c] || (S.paid[c] = { at: Date.now(), name: '搜寻项目', done: {}, fromUrl: 'search' }); P.done = P.done || {}; P.done[W.name] = 'minted'; save();
    return `✅ [${W.name}] 已铸造 ${n} 份（付 ${(Number(val) / 1e18).toFixed(4)} BNB）\n交易 ${r.tx}`; }
  catch (e) { if (/結果不明|结果不明/.test(e.message)) { const P = (S.paid = S.paid || {})[c] || (S.paid[c] = { at: Date.now(), name: '搜寻项目', done: {}, fromUrl: 'search' }); P.done = P.done || {}; P.done[W.name] = 'unknown'; try { const pz = await bnbUsd(); if (pz > 0) addPaidUsd(W, (Number(val) / 1e18) * pz); } catch {} save(); return `⚠️ [${W.name}] 铸造结果不明（送出逾时，可能已上链），为了不重复付钱先不重打；请看钱包／TG 确认`; } return '❌ 铸造没送出：' + String(e.message).slice(0, 120); }
  } finally { SHARE_BUSY.delete(bk); }
}
const SHARE_BUSY = new Set(); 

const tokConds = (o) => [ /* AI 热门代币的条件（照你的组合方式） */
  { k: 'bsc.tokNeed', name: 'Agent 钱包在交易', unit: ' 个', op: '>=', v: o.ag }, { k: 'bsc.tokMaxAgeH', name: '是新币（没超过你设的小时数）', op: 'is', v: o.young },
  { k: 'bsc.tokMinLiqBnb', name: '池子', unit: ' BNB', op: '>=', v: o.liq }, { k: 'bsc.tokMaxTax', name: '买卖税（取高的）', unit: '%', op: '<=', v: o.tax },
  { k: 'bsc.tokMaxBundle', name: '捆绑钱包持有', unit: '%', op: '<=', v: o.bundle }, { k: 'bsc.tokMaxTop10', name: '前 10 大持有', unit: '%', op: '<=', v: o.top10 }, { k: 'bsc.tokMinReal', name: '1 小时真实买家', unit: ' 个', op: '>=', v: o.real } ];
/* KOL-AVE（v1.0.2）：「KOL 持有」条件（gen.kolMin／rh.kolMin：开关＋你填的人数，预设关）＝AVE 持有人前 100 名里被 AVE 标成 KOL 的钱包数。
   资料：雷达视窗（main.cjs）用 AVE 查好写的 data/ave_tags.json（你开着这个条件才查：一般新币候选＋引擎要的币），或看盘资料 ave_board.json 的 ht（作者电脑查的前排币），取比较新的。
   官方 KOL 名单只显示，不算在这里（说明书规矩 12）。刚请视窗查、还在等＝「还没查」；等太久、资料太旧、AVE 读不到＝读不到（null）→ 照你选的 *.kolMin.miss：不买，或用备用条件「你标记的聪明钱包在 N 小时内买过」（N 也是你填的）。 */
const KOL_STALE_MS = 15 * 60e3; /* 运作：持有人标签超过这么久＝太旧（视窗那边定时重查） */ const KOL_WAIT_MS = 3 * 60e3; /* 运作：请视窗查之后等多久还没有＝读不到 */
const KOLC = { t: { at: 0, v: null }, b: { at: 0, v: null } }; const KOLW = new Map(); let KOLW_AT = 0;
function kolRead(w, f, ms) { const c = KOLC[w]; if (Date.now() - c.at < ms) return c.v; c.at = Date.now(); try { c.v = JSON.parse(readFileSync(join(DIR, 'data', f), 'utf8')); } catch { c.v = null; } return c.v; }
function kolTags(ch, c) { const a = kolRead('t', 'ave_tags.json', 5e3 /* 运作：几秒重读一次 */)?.[ch]?.[c], b = kolRead('b', 'ave_board.json', 30e3 /* 运作：几秒重读一次 */)?.ht?.[ch]?.[c]; const A1 = a && a.ok ? a : null, B1 = b && Number.isFinite(+b.k) ? { at: +b.at || 0, ok: 1, k: +b.k } : null; return A1 && B1 ? (A1.at >= B1.at ? A1 : B1) : A1 || B1 || (a ? { ...a, ok: 0 } : null); }
function kolWant(ch, c) { const now = Date.now(); if (!KOLW.has(ch + ':' + c)) KOLW.set(ch + ':' + c, now); for (const [k, t] of KOLW) if (now - t > 10 * 60e3 /* 运作：请求留多久 */) KOLW.delete(k); if (now - KOLW_AT < 5e3) return; KOLW_AT = now;
  const o = { at: now, bsc: [], rh: [] }; for (const k of KOLW.keys()) { const [h, x] = k.split(':'); (o[h] || (o[h] = [])).push(x); } try { const f = join(DIR, 'data', 'ave_tag_want.json'); writeFileSync(f + '.w', JSON.stringify(o)); renameSync(f + '.w', f); } catch {} }
function kolBought(ch, c) { /* ch：'bsc'｜'rh' → { v: 几位 KOL 持有（undefined＝还在查，null＝读不到）, why } */
  c = String(c || '').toLowerCase(); const e = kolTags(ch, c); if (e && e.ok && Date.now() - e.at < KOL_STALE_MS) { KOLW.delete(ch + ':' + c); return { v: +e.k || 0, why: '' }; }
  const t0 = KOLW.get(ch + ':' + c); kolWant(ch, c); if (!t0 || Date.now() - t0 < KOL_WAIT_MS) return { v: undefined, why: '' };
  return { v: null, why: e && !e.ok ? (e.why === 'relay' ? '转接站还没更新，读不到持有人标签' : 'AVE 持有人资料读不到') : e ? 'AVE 持有人资料太旧' : '雷达视窗没开或 AVE 读不到' };
}
function kolBk(sid, ch, c) { /* 备用条件：你标记的聪明钱包在 N 小时内买过（N＝你填的 *.kolBkH；没填＝备用条件没填好 → 不买） */
  const h = nrNum(sid + '.kolBkH'); if (h == null) return null; const t = S.smartW?.seen?.[(ch === 'rh' ? 'robinhood' : 'bsc') + String(c || '').toLowerCase() + '买']; const ok = !!(t && Date.now() - t < h * 3600e3); return { ok, txt: `你标记的聪明钱包 ${h} 小时内${ok ? '买过' : '没买过'}` };
}
function kolO(sid, ch, c) { if (!nrOn(sid + '.kolMin.on')) return {}; const K = kolBought(ch, c); return { kol: K.v, kolWhy: K.why || undefined, kolBk: () => kolBk(sid, ch, c) }; }
globalThis.kolO = kolO; /* rh.mjs 也用同一套 */
const genConds = (o) => [ /* 一般新币的条件 */
  { k: 'gen.maxAgeMin', name: '开盘时间', unit: ' 分钟', op: '<=', v: o.age }, { k: 'gen.minLiqUsd', name: '流动性', unit: ' U', op: '>=', v: o.liq },
  { k: 'gen.mcMin', name: '市值', unit: ' U', op: '>=', v: o.mc }, { k: 'gen.mcMax', name: '市值', unit: ' U', op: '<=', v: o.mc }, { k: 'gen.minBuys', name: '1 小时买单', unit: ' 笔', op: '>=', v: o.buys },
  { k: 'gen.maxTax', name: '买卖税（取高的）', unit: '%', op: '<=', v: o.tax }, { k: 'gen.maxBundle', name: '捆绑钱包持有', unit: '%', op: '<=', v: o.bundle }, { k: 'gen.maxTop10', name: '前 10 大持有', unit: '%', op: '<=', v: o.top10 },
  { k: 'gen.minReal', name: '真实买家', unit: ' 个', op: '>=', v: o.real }, { k: 'gen.needX', name: '有官方 X', op: 'yes', v: o.x }, { k: 'gen.needSmart', name: '你标记的聪明钱包买过', op: 'yes', v: o.smart }, { k: 'gen.needCall', name: '有 KOL 喊单', op: 'yes', v: o.call }, { k: 'gen.kolMin', name: 'KOL 持有', unit: ' 位', op: '>=', v: o.kol, missWhy: o.kolWhy, bk: o.kolBk } ]; /* KOL-AVE */
async function agTokScan() {
  if (radarOff() || Number(radarSet()['bsc.tokAuto']) !== 1 || AGTOK.usd == null || AGTOK.dayUsd == null) return; /* 每笔／每天没填就不买 */ /* 新装好所有买入开关预设关，要自己打开 */ /* BSC 热门代币有自己的开关 */
  const now = Date.now(); S.agTok = S.agTok || {};
  const mintToks = new Set(Object.values(S.paid || {}).map((P) => P.tok).filter(Boolean)); for (const c of Object.keys(S.paid || {})) mintToks.add(c);
  const held = new Set((S.dyn || []).map((t) => String(t.addr).toLowerCase()));
  const cands = [];
  if (AGTOK.winMin == null) { AGH.clear(); if (!S.agTokNoWin) { S.agTokNoWin = 1; nrDecLog('tok', '-', 'AI 热门代币', { buy: false, text: '⚠️ 你没填「几分钟内」(bsc.tokWinMin) → Agent 钱包数读不到 → 不买', lines: ['⚠️ 你没填「几分钟内」(bsc.tokWinMin) → Agent 钱包数读不到'], why: '几分钟内没填' }, 1); log('AI 热门代币：没填「几分钟内」→ 钱包数读不到，不买'); } return; } S.agTokNoWin = 0; /* 「几分钟内」空白＝读不到（不买），不替你假设时间 */
  for (const [c, m] of AGH) { for (const [a, t] of m) if (now - t > AGTOK.winMin * 60e3) m.delete(a); if (!m.size) { AGH.delete(c); continue; } if (nrJudge('tok', tokConds({ ag: m.size })).buy !== false && !S.agTok[c] && !mintToks.has(c) && !held.has(c) && !(S.agTokChk?.[c] > now - AG_CHK_MS)) cands.push([c, m]); }
  const tpr = NR.num('bsc.tokPerRound'); const lc = (x) => (Number(S.agTokChk?.[x]) > 0 ? Number(S.agTokChk[x]) : 0); cands.sort((a, b) => lc(a[0]) - lc(b[0]) || b[1].size - a[1].size); /* 轮流：最久没查的先查 */
  for (const [c, m] of (tpr != null ? cands.slice(0, tpr) : cands)) { /* 每轮查几个＝你的设定 bsc.tokPerRound（没填＝全部）；没轮到的下一轮先查 */
    (S.agTokChk = S.agTokChk || {})[c] = now;
    const snd = [...m.keys()]; const unknown = snd.filter((a) => !agentCache.has(a)); /* 全部查（rpcBatch 自己分批），查不到的下一轮再查 */
    if (unknown.length) { const res = await rpcBatch(unknown.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); unknown.forEach((a, i) => { if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n); }); }
    const fresh = await newAgents().catch(() => new Set());
    const need = snd.filter((a) => agentCache.get(a) && !fresh.has(a) && agOldN() > 0 && !(NONCE.get(a)?.n >= agOldN()) && !(now - (NONCE.get(a)?.t ?? -Infinity) < NONCE_TTL_MS)); if (need.length) { const res = await rpcBatch(need.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] }))); need.forEach((a, i) => { if (res[i] !== undefined) NONCE.set(a, { n: parseInt(res[i], 16) || 0, t: Date.now() }); }); }
    const ag = snd.filter((a) => agentCache.get(a) && !fresh.has(a) && (agOldN() === 0 || (NONCE.get(a)?.n ?? (nrOn('bsc.agNonceMiss') ? Infinity : -1)) >= agOldN())).length;
    const o = { ag }; const TJ = () => nrJudge('tok', tokConds(o)); if (TJ().buy === false) continue; 
    const dec = await call(c, '0x313ce567'); if (!(dec && dec.length >= 66)) { S.agTok[c] = 'not-token'; continue; } /* 不是代币（像铸造合约、游戏合约）不在这里处理 */
    const sym = tokStr(await call(c, '0x95d89b41')) || c.slice(0, 8);
    const skip = (why, later) => { nrDecSkip('tok', c, sym, why); /* 每一个「不买」都写判断日志 */ const rH = NR.num('bsc.tokRetryH'); if (later && (rH == null || now - (S.agTokFirst?.[c] || now) < rH * 3600e3)) { (S.agTokFirst = S.agTokFirst || {})[c] = S.agTokFirst[c] || now; S.agTokChk[c] = now + AG_RECHK_MS - AG_CHK_MS; if (S.agTokWhy?.[c] !== why) { (S.agTokWhy = S.agTokWhy || {})[c] = why; log(`AI 热门代币 ${sym}（${ag} 个 Agent ID 钱包／${AGTOK.winMin ?? '-'} 分钟）先不打：${why}（${AG_RECHK_MS / 60e3} 分钟后再查${rH != null ? '，最多 ' + rH + ' 小时（你的设定）' : '，会一直重查'}）`); } return; } S.agTok[c] = 'skip'; log(`AI 热门代币 ${sym}（${ag} 个 Agent ID 钱包／${AGTOK.winMin ?? '-'} 分钟）不打：${why}${later ? '（重查超过你设的 ' + rH + ' 小时，不再查）' : ''}`); }; /* 重查多久＝你的设定 bsc.tokRetryH（没填＝一直重查，不放弃） */
    if (USD1 && c === String(USD1).toLowerCase()) { S.agTok[c] = 'stable'; continue; }
    { const tmh = NR.num('bsc.tokMaxAgeH'); if (tmh != null) { const head = parseInt(await rpc('eth_blockNumber', []), 16); const oc = await rpc('eth_getCode', [c, '0x' + Math.max(1, head - Math.round((tmh * 3600) / BSC_BLK_S)).toString(16)]).catch(() => null); o.young = oc == null ? null : !(oc.length > 2); } } { const J = TJ(); if (J.buy === false) { nrDecLog('tok', c, sym, J); S.agTok[c] = 'skip'; continue; } } /* 「是新币」是你的条件之一 */ /* 只打新项目，CAKE、BTCB 这种老币很多 AI 在交易也不买 */
    const dep = await deployerOf(c).catch(() => ''); if (dep && (blackOn(dep) || isRepeatDev(dep))) { skip('部署者在黑名单或大量部署'); continue; }
    const price = await bnbUsd().catch(() => 0); if (!(price > 0)) continue;
    const p = await findPair({ addr: c }).catch(() => null); if (!p) { skip('没有池子（还在发射平台曲线上，或还没开盘）', 1); continue; }
    let liqBnb = 0; if (!p.ds) { const rs = await call(p.pair, '0x0902f1ac'); const t0 = await call(p.pair, '0x0dfe1681'); if (rs && t0) { const r0 = BigInt('0x' + rs.slice(2, 66)), r1 = BigInt('0x' + rs.slice(66, 130)); const qIs0 = ('0x' + t0.slice(26)).toLowerCase() !== c; const qr = Number(qIs0 ? r0 : r1) / 1e18; const q = String(p.quote).toLowerCase(); liqBnb = q === WBNB ? qr : qr / price; } } else { const d = await dexScreener(c).catch(() => null); liqBnb = d?.liq ? d.liq / 2 / price : 0; }
    o.liq = liqBnb; { const J = TJ(); if (J.buy === false) { nrDecLog('tok', c, sym, J); skip(J.why, 1); continue; } } 
    let hp = null; try { hp = await (await fetch(`https://api.honeypot.is/v2/IsHoneypot?address=${c}&chainID=56`, { signal: AbortSignal.timeout(15000) })).json(); } catch {}
    const bt = Number(hp?.simulationResult?.buyTax), st = Number(hp?.simulationResult?.sellTax);
    if (hp?.honeypotResult?.isHoneypot === true && NR.on('risk.autoSkipHoneypot')) { skip('模拟卖出失败，是貔貅（你开著「自动买跳过貔貅」底线）'); continue; } if (NR.on('risk.needHp') && (!hp || (hp.honeypotResult?.isHoneypot !== false && hp.honeypotResult?.isHoneypot !== true) || !hp.simulationSuccess || !(bt >= 0) || !(st >= 0))) { skip('貔貅检查查不到结果', 1); continue; } { const cr = await codeRisk('bsc', c).catch(() => ''); if (cr) { skip(cr); continue; } } /* AI 热门代币也跑代码扫描（底线） */
    o.tax = Number.isFinite(bt) && Number.isFinite(st) ? Math.max(bt, st) : null;
    let AF = null; if (['bsc.tokMaxBundle', 'bsc.tokMaxTop10', 'bsc.tokMinReal'].some((k) => NR.num(k) != null)) { const A = BA ? await Promise.race([BA.analyze(c, p.pair).catch((e) => ({ ok: false, why: e.message })), new Promise((ok) => setTimeout(() => ok({ ok: false, why: '查太久' }), AN_TIMEOUT_MS))]) : null; /* 开了捆绑／前 10 大／真实买家条件才查；查不到＝读不到（照你选的） */
      if (A?.ok) { AF = A.facts; o.bundle = AF.bundlePct != null ? AF.bundlePct * 100 : null; o.top10 = AF.top10 * 100; o.real = AF.realBuyers; } else { o.bundle = o.top10 = o.real = null; } }
    const TJF = TJ(); nrDecLog('tok', c, sym, TJF); if (TJF.buy !== true) { skip(TJF.why || '没过你的条件', 1); continue; }
    { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'token', c, sym: typeof sym !== 'undefined' ? sym : '', agents: ag, buyTax: bt, sellTax: st, liqBnb, bundlePct: AF && AF.bundlePct != null ? AF.bundlePct * 100 : null, top10Pct: AF ? AF.top10 * 100 : null, realBuyers: AF ? AF.realBuyers : null }); if (cs) { skip('自订规则不打：' + cs); nrDecRes('tok', c, sym, 'none', '自订规则：' + cs); continue; } }
    { const tmp = NR.num('bsc.tokMaxPos'); if (tmp != null && new Set((S.dyn || []).filter((t) => t.tok && !t.closed).map((t) => t.addr)).size >= tmp) { log(`AI 热门代币 ${sym} 符合条件，但已经持有 ${tmp} 个（你的设定），先不打`); nrDecRes('tok', c, sym, 'none', `已经持有 ${tmp} 个（你的上限）`); continue; } }
    if (AUTO_INFL.has(c)) { log(`AI 热门代币 ${sym}：另一个自动策略正在买这个币，这次不重复买`); nrDecRes('tok', c, sym, 'none', '另一个自动策略正在买'); continue; } 
    S.agTok[c] = 'buy'; save(); const TR = { b: 0, u: 0, why: [] }; /* 每个钱包的实际结果 */
    for (const W of WALLETS) {
      const left = Math.min(AGTOK.usd, AGTOK.dayUsd - tokDayUsd(W)); if (!(left > 0)) { log(`[${W.name}] AI 热门代币今天额度用完（${AGTOK.dayUsd}U），${sym} 不打`); TR.why.push(`[${W.name}] 今天额度用完`); continue; }
      const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => '0x0')) || '0x0')) / 1e18; const bnb = left / price; if (bal - bnb < PAID.keepBnb) { log(`[${W.name}] BNB 不够，${sym} 不打`); TR.why.push(`[${W.name}] BNB 不够`); continue; }
      const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', bnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', c, '--slippage', tokSlip(bt, st)]);
      if (!sw.j && TIMEOUT_RE.test(sw.t || '')) { TR.u++; S.tokUsd[W.name] = tokDayUsd(W) + left; S.dyn = S.dyn || []; if (!addCostEx(W, c, +left.toFixed(2), 'AI 热门代币（结果不明）')) S.dyn.push({ sym, addr: c, cost: +left.toFixed(2), only: W.addr, boughtAt: Date.now(), tok: 1, pending: 1 }); /*RISK-FIX2-2*/ save(); await tg(`⚠️ [${W.name}] AI 热门代币 ${sym} 买入结果不明（送出逾时，可能已经成交），先不重复买；今天额度先照 ${left.toFixed(1)}U 算，读到余额会自动接着追踪 | ${c}`).catch(() => {}); continue; } 
      if (!sw.j?.success) { log(`[${W.name}] AI 热门代币 ${sym} 买入失败：${String(sw.j?.error?.message || sw.t).slice(0, 100)}`); TR.why.push(`[${W.name}] 买入失败：${String(sw.j?.error?.message || sw.t).slice(0, 60)}`); continue; }
      TR.b++; S.tokUsd[W.name] = tokDayUsd(W) + left; S.dyn = S.dyn || []; if (!addCostEx(W, c, +left.toFixed(2), 'AI 热门代币')) S.dyn.push({ sym, addr: c, cost: +left.toFixed(2), only: W.addr, boughtAt: Date.now(), tok: 1 }); /*RISK-FIX2-2*/ save();
      await tg(`🛒 [${W.name}] 自动打了 AI 热门项目：${sym} | ${AGTOK.winMin ?? '-'} 分钟内 ${ag} 个 Agent ID 钱包在互动 · 每个钱包 ${left.toFixed(1)}U · 税 买 ${bt}%／卖 ${st}% · 池子约 ${liqBnb.toFixed(1)} BNB | ${c}` + nrTgWhy(TJF));
    }
    nrDecRes('tok', c, sym, TR.b ? 'bought' : TR.u ? 'unknown' : 'none', TR.b ? '' : TR.why.join('；')); 
  }
}
async function heatOf(c, P) { // 算热度：最近一段区块有几个不同的 Agent ID 钱包参与铸造（扫描范围是技术用的区块数）
  const head = parseInt(await rpc('eth_blockNumber', []), 16); let tok = ''; const tr = await call(c, '0xfc0c546a'); if (tr && tr.length >= 66 && BigInt(tr.slice(0, 66)) > 0n) tok = '0x' + tr.slice(26, 66).toLowerCase();
  const last = new Map(), txb = new Map(), fst = new Map(); /* fst＝这次看到每个钱包最早的区块 */ const skip = new Set([c, tok, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead']);
  mwLoad(); const span = P.heatAt && MINTW.has(c) ? 6000 : 20000; /* 重开后没有钱包记录 → 从头扫一次 */ // 第一次扫比较长一段，之后只看最近一段（累计数取最大值；技术用）
  for (let b = head - span; b <= head; b += 10000) {
    const q = [{ address: c , fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]; const L = await rpc('eth_getLogs', q).catch(() => logsRpc(q).catch(() => [])); /* 预设节点限流时改用多节点，热度（参与人数）才算得准 */
    for (const l of L || []) { if (!l.transactionHash) continue; const bn = parseInt(l.blockNumber, 16); if (!txb.has(l.transactionHash) || txb.get(l.transactionHash) < bn) txb.set(l.transactionHash, bn); }
  }
  
  const AGN_MAX = 4000; /* 一轮看的笔数有技术上限（分批查）；没看完的标「还在数」，不会当成数完 */ const hashes = [...txb.entries()].sort((x, y) => y[1] - x[1]).slice(0, AGN_MAX); let agPend = txb.size > AGN_MAX ? 1 : 0;
  if (hashes.length) { const txs = await rpcBatch(hashes.map(([h]) => ({ method: 'eth_getTransactionByHash', params: [h] }))); hashes.forEach(([h, bn], i) => { if (txs[i] === undefined) agPend++; const a = String(txs[i]?.from || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || skip.has(a)) return; if (!last.has(a) || last.get(a) < bn) last.set(a, bn); if (!fst.has(a) || fst.get(a) > bn) fst.set(a, bn); }); }
  const unknown = [...last.keys()].filter((a) => !agentCache.has(a)).slice(0, AGN_MAX);
  if (unknown.length) { const res = await rpcBatch(unknown.map((a) => ({ method: 'eth_call', params: [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(a) }, 'latest'] }))); unknown.forEach((a, i) => { if (res[i] !== undefined) agentCache.set(a, !!res[i] && res[i].length >= 66 && BigInt(res[i].slice(0, 66)) > 0n); }); }
  const fresh = await newAgents().catch(() => new Set()); /* 防小号凑数：刚注册多久内不算＝你的 bsc.agMinAgeH、交易次数少于几笔不算＝你的 bsc.agOldNonce（没开＝不过滤） */
  { const need = [...last.keys()].filter((a) => agentCache.get(a) && !fresh.has(a) && agOldN() > 0 && !(NONCE.get(a)?.n >= agOldN()) && !(Date.now() - (NONCE.get(a)?.t || 0) < 30 * 60e3)).slice(0, AGN_MAX); if (need.length) { const res = await rpcBatch(need.map((a) => ({ method: 'eth_getTransactionCount', params: [a, 'latest'] }))); need.forEach((a, i) => { if (res[i] !== undefined) NONCE.set(a, { n: parseInt(res[i], 16) || 0, t: Date.now() }); }); } }
  const hwM = NR.num('bsc.heatWinMin'), hwB = hwM ? Math.ceil((hwM * 60) / BSC_BLK_S) : 0; let hwN = 0; /* 备用条件「最近 N 分钟」＝你填的 */
  for (const a of last.keys()) { if (!agentCache.has(a)) agPend++; else if (agentCache.get(a) && !fresh.has(a) && agOldN() > 0 && NONCE.get(a)?.n == null && !nrOn('bsc.agNonceMiss')) agPend++; } /* 还没查到的钱包 → 现在的数量只是「至少」 */
  let agents = 0, burst = 0; for (const [a, bn] of last) if (agentCache.get(a) && !fresh.has(a) && (agOldN() === 0 || (NONCE.get(a)?.n ?? (nrOn('bsc.agNonceMiss') ? Infinity : -1)) >= agOldN())) { agents++; if (bn >= head - 400) burst++; if (hwB && bn >= head - hwB) hwN++; }
  P.agents = Math.max(P.agents || 0, agents); P.burst = burst; P.heatAt = Date.now(); P.heatWin = hwB ? hwN : null; P.heatWinMin = hwM;
  P.agNow = agents; P.agNowAt = Date.now(); P.agTrunc = agPend > 0 ? 1 : 0; P.agPend = agPend; if (agPend) log(`Agent 钱包：${P.name || c} 现在 ≥${agents}（还在数，${agPend} 笔／个还没查完）`); try { mwUpdate(c, P, head, span, hashes, fst, last); } catch (e) { log('钱包统计出错 ' + e.message); } /* 最高 vs 现在（附取样时间）＋全部钱包统计 */
}
const HEAT_PER_ROUND = 8; /* 运作：节点额度 */
const hkC = (c, P) => (P.heatAt || 0) + (zrQuick(c, P) ? 0 : 540e3); /* 只是检查间隔（技术用） */
async function heatWatch() { // 背景：替追踪中的付费项目算热度，看不懂的合约顺便学别人的打法（不拖慢快速检查）
  const sig = (c, P) => (zrQuick(c, P) && !P.heatAt ? 1 : 0); /* 频道／群组／网址来的新项目优先算热度 */
  const ents = Object.entries(S.paid || {}).filter(([c, P]) => !INFRA.has(c) && !P.unmintable && (P.progress || 0) < 0.999 && !WALLETS.every((W) => P.done?.[W.name]) && trackOk(P) )
    .sort((a, b) => (sig(b[0], b[1]) - sig(a[0], a[1])) || ((b[1].needLearn && zrQuick(b[0], b[1])) - (a[1].needLearn && zrQuick(a[0], a[1]))) || (hkC(a[0], a[1]) - hkC(b[0], b[1])) || ((b[1].at || 0) - (a[1].at || 0))).slice(0, HEAT_PER_ROUND); /* 运作：每轮算几个热度（节点额度），照上次算的时间轮流，每个都会轮到 */
  for (const [c, P] of ents) {
    try {
      await heatOf(c, P).catch((e) => log('heat ' + c + ' ' + e.message)); /* 算热度被节点限流时，学打法也跟著被跳过 → 分开处理 */
      if (!P.pick && (P.needLearn || (sig(c, P) || zrQuick(c, P)) && !P.replay && !P.recvValue) && (!P.replay || Date.now() - (P.replay.learnedAt || 0) > 120e3) && zrQuick(c, P)) { /* 很热门但认不出打法的，要自己去找别人怎么打到的——频道／群组／网址来的热门项目一加入就马上去学别人的铸造交易 */ const lr = await learnReplay(c).catch(() => null); if (lr?.recv) { P.recvValue = lr.recv; P.recvSeen = lr.recvSeen; P.recvVals = lr.recvVals; P.replay = { hot: lr.hot, learnedAt: lr.learnedAt }; delete P.needLearn; log(`学到 ${P.name || c} 的打法：直接转 ${Number(BigInt(lr.recv)) / 1e18} BNB 就铸造（${lr.recvSeen} 笔）`); } else if (lr) P.replay = lr; }
    } catch (e) { log('heat ' + c + ' ' + e.message); }
  }
}
function freshDeadline(data) { /* 照抄的交易里如果有「期限」（看起来像时间戳记的数字），换成稍后的时间（技术用），不然旧交易一定过期失败 */
  const now = Math.floor(Date.now() / 1000); const ws = data.slice(10).match(/.{64}/g) || []; let ch = 0;
  const out = ws.map((x) => { const v = BigInt('0x' + x); if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) { ch = 1; return (BigInt(now + 900)).toString(16).padStart(64, '0'); } return x; });
  return ch ? data.slice(0, 10) + out.join('') : data;
}
async function findCapSel(c, code, sold) { /* 从合约码找无参数函式，回传「像总量」的（大于已售、整百、≤1 千万），优先 10000 */
  const hex = String(code || '').toLowerCase().replace(/^0x/, ''); const sels = new Set(); for (let i = 0; i < hex.length - 10; i += 2) if (hex.slice(i, i + 2) === '63') sels.add(hex.slice(i + 2, i + 10));
  const cand = []; for (const sel of [...sels].slice(0, 160)) { if (capTimeSels().has(sel)) continue; /*V104-CAPSANE：PAUSE_DURATION() 这类时间函式不试*/ const r = await call(c, '0x' + sel); if (!r || r.length !== 66) continue; const v = Number(BigInt(r)); if (v > sold && v <= 1e7 && v % 100 === 0 && capOk(sel, v, sold)) cand.push([sel, v]); }
  if (!cand.length) return ''; cand.sort((x, y) => (y[1] === 10000) - (x[1] === 10000) || x[1] - y[1]); log(`找到 ${c} 的总量函式 0x${cand[0][0]} = ${cand[0][1]}`); return cand[0][0];
}
/* 最近的区块找不到别人成功的铸造 → 每一轮再往前翻几页（技术用：一页的区块数、每轮翻几页＝节点额度），记住翻到哪，下一轮接着翻，直到找到或翻到合约建立的那一块；不会默默放弃 */
const BACK_PAGE = 5000, BACK_PAGES = 2; /* 运作：查事件一次的区块数／每轮翻几页（节点额度），不影响买不买 */
async function scanBack(c, head) { S.lrnBack = S.lrnBack || {}; const B = (S.lrnBack[c] = S.lrnBack[c] || { cur: head - LRN_WIN - 1, pages: 0 }); const born = Math.max(1, Number(S.bornBlk?.[c]) || 1); if (B.done) return { logs: [], B };
  for (let k = 0; k < BACK_PAGES; k++) { const to = B.cur, from = Math.max(born, to - BACK_PAGE + 1); if (to < born) { B.done = 1; break; } let L = null; try { L = await logsRpc([{ address: c, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16) }]); } catch { L = null; } if (L == null) { B.err = Date.now(); break; } /* 节点没回：游标不动，下一轮重查这一页 */ B.cur = from - 1; B.pages++; B.at = Date.now(); if (from <= born) B.done = 1; if (L.length) return { logs: L, B }; }
  if (B.done && !B.doneLog) { B.doneLog = 1; log(`往前找 ${c} 的铸造：一路查到合约建立的那一块（第 ${born} 块，共 ${B.pages} 页）都没有成功的铸造交易`); } return { logs: [], B }; }
const LRN_WIN = 1500; /* 运作：先看最近这么多块（节点额度） */
async function learnReplay(c) { // 学别人最近成功的铸造：最常见的函式、要付多少 BNB／USDT、最近有几个钱包在打
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const L = await logsRpc([{ address: c, fromBlock: '0x' + (head - LRN_WIN).toString(16), toBlock: '0x' + head.toString(16) }]).catch(() => rpc('eth_getLogs', [{ address: c, fromBlock: '0x' + (head - LRN_WIN).toString(16), toBlock: 'latest' }]).catch(() => [])); /* 预设节点查事件常被限流（limit exceeded）→ 学不到打法；改用多节点轮替 */
  const r0 = await learnFrom(c, L, head); if (r0) { if (S.lrnBack) delete S.lrnBack[c]; return r0; }
  for (let i = 0; i < 3; i++) { const { logs, B } = await scanBack(c, head); if (!logs.length) return null; const r1 = await learnFrom(c, logs, head); if (r1) { log(`往前找到 ${c} 以前成功的铸造（第 ${parseInt(logs[0].blockNumber, 16)} 块附近，翻了 ${B.pages} 页）`); return { ...r1, old: 1 }; } } /* 这页有事件但没有成功的铸造 → 同一轮再往前翻（同一轮翻的页数有上限＝节点额度，技术用；下一轮接着翻） */
  return null;
}
async function learnFrom(c, L, head) {
  const hs = [...new Set((L || []).map((l) => l.transactionHash))].slice(-40);
  const all = (await Promise.all(hs.map((h) => rpc('eth_getTransactionByHash', [h]).catch(() => null)))).filter((t) => t && t.to && t.to.toLowerCase() === c);
  const txs = all.filter((t) => t.input && t.input.length >= 10 && !badSel(t.input) && !t.input.toLowerCase().includes(t.from.slice(2).toLowerCase()));
  { 
    const plain = all.filter((t) => (t.input || '0x') === '0x' && BigInt(t.value || '0x0') > 0n);
    if (nrNum('bsc.learnMinN') != null && plain.length >= nrNum('bsc.learnMinN') && plain.length >= txs.length) { /* 空白＝不用这个学法 */ /* 几笔才算＝你的 bsc.learnMinN */ const vc = {}; for (const t of plain) { const v = BigInt(t.value).toString(); vc[v] = (vc[v] || 0) + 1; } const top = Object.entries(vc).sort((x, y) => y[1] - x[1])[0]; const hot = new Set(plain.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size; return { recv: top[0], recvSeen: top[1], recvVals: Object.keys(vc), hot, learned: 1, learnedAt: Date.now() }; }
  }
  if (!txs.length) return null;
  const cnt = {}; for (const t of txs) cnt[t.input.slice(0, 10)] = (cnt[t.input.slice(0, 10)] || 0) + 1;
  const sel = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
  const cands = txs.filter((t) => t.input.startsWith(sel)).reverse().sort((a, b) => a.input.length - b.input.length); // 优先学最简单的那种（别人带了自己的 NFT 编号等额外参数的，照抄会失败）
  for (const pick of cands.slice(0, 3)) {
    const rc = await rpc('eth_getTransactionReceipt', [pick.hash]).catch(() => null); if (!rc || rc.status !== '0x1') continue;
    let payTok = '', payAmt = '0';
    for (const l of rc.logs || []) if (l.topics?.[0] === T_TRANSFER && l.topics.length === 3 && ('0x' + l.topics[1].slice(26)).toLowerCase() === pick.from.toLowerCase()) { payTok = l.address.toLowerCase(); payAmt = BigInt(l.data).toString(); break; }
    const hot = new Set(txs.filter((t) => parseInt(t.blockNumber, 16) >= head - 400).map((t) => t.from.toLowerCase())).size;
    return { data: pick.input, value: BigInt(pick.value).toString(), payTok, payAmt, hot, learned: 1, learnedAt: Date.now() };
  }
  return null;
}
async function repeatDevOk(dep, c, P) {
  const mine = devKey({ c, n: P.name });
  const others = ((S.devs || {})[dep] || []).filter((x) => x.c !== c);
  if (others.some((x) => devKey(x) === mine)) return '同名重新部署';
  for (const x of others) { // 他之前的项目有没有正常开盘（池子还有钱、没被抽走）
    let tk = x.c; /* 不信 token()，免得骗子把它指到热门币来洗白 */
    for (const q of [WBNB, USDT]) { const pr = await call(FACTORY, '0xe6a43905' + wa(tk) + wa(q)); if (!pr || !(BigInt(pr) > 0n)) continue; const rs = await call('0x' + pr.slice(26), '0x0902f1ac'); if (rs && BigInt('0x' + rs.slice(2, 66)) > 0n && BigInt('0x' + rs.slice(66, 130)) > 0n) return '之前有项目正常开盘'; }
  }
  return '';
}
const memoC = new Map(); const cc = async (to, data, ttl = 600e3) => { const k = to + data, m = memoC.get(k); if (m && Date.now() - m.t < ttl) return m.v; const v = await call(to, data); memoC.set(k, { v, t: Date.now() }); if (memoC.size > 20000) memoC.clear(); return v; }; // 不常变的合约资料快取，加快检查
const busyP = new Set(); // 同一个项目同时只处理一次（快速检查和一般检查分开跑，避免重复打）
const DAYRES = {};
const QUICK_PER_ROUND = 12, REST_PER_ROUND = 16; /* 运作：节点额度，不是门槛 */
async function paidLoop(mode = 'all', shard = null) {
  S.paid = S.paid || {}; S.dyn = S.dyn || []; S.paidSpend = S.paidSpend || {};
  const today = new Date().toDateString(); if (S.paidSpend.day !== today) S.paidSpend = { day: today };
  let price = 0;
  if (!S.forceDone) S.forceDone = {};
  S.thrNow = { go: NR.num('bsc.goPct') != null ? GO_PCT : null, ag: NR.num('bsc.agMin') != null ? AG_MIN : null }; /* 没开＝null（画面显示「没设」） */ /* 把引擎实际用的门槛给画面，「符合条件」才不会跟引擎不一致 */
  for (const c of FORCE) if (S.forceDone[c] && S.paid[c]) delete S.paid[c];
  for (const c of FORCE) if (!S.paid[c] && !S.forceDone[c]) S.paid[c] = { at: Date.now(), name: '', done: {} };
  // 快速检查名单（强制打、你自己加的、符合你「快速检查」设定的）每轮都看；其余轮流，每轮补到 16 个
  const all = Object.entries(S.paid);
  
  const hotP = all.filter(([c, P]) => FORCE.has(c) || (zrQuick(c, P) /* 快速检查名单＝你的设定 */ && (P.progress || 0) < 0.999 && !P.unmintable && (FORCE.has(c) || !P.serialLog))).filter(([c, P]) => !WALLETS.every((W) => P.done[W.name])).sort((a, b) => (FORCE.has(b[0]) ? 1 : 0) - (FORCE.has(a[0]) ? 1 : 0) /* 强制打永远排第一 */ || (b[1].progress || 0) - (a[1].progress || 0) || (b[1].agents || 0) - (a[1].agents || 0)).slice(0, QUICK_PER_ROUND); /* 运作：快速检查一轮最多几个（节点额度）；排不进的留在一般轮查，不会丢 */
  // 快速检查（mode='hot'）只看你的快速名单；一般检查（mode='rest'）在背景轮流看其他的，互不拖慢
  const rest = mode === 'hot' ? [] : all.filter((e) => !hotP.includes(e) && trackOk(e[1]) /* 追踪中的都轮 */).sort((a, b) => ((a[1].lastTry || 0) - (b[1].lastTry || 0)) || ((b[1].at || 0) - (a[1].at || 0))).slice(0, REST_PER_ROUND); /* 运作：一般轮查每轮几个（节点额度），照上次检查时间轮流，每个都会轮到 */
  const ents = mode === 'one' ? all.filter((e) => e[0] === shard) : mode === 'rest' ? rest : mode === 'hot' ? (shard == null ? hotP : hotP.filter((e, i) => i % 3 === shard)) : hotP.concat(rest); /* 快速检查分 3 组同时跑 */
  for (const [c, P] of ents) {
    if (INFRA.has(c)) { delete S.paid[c]; continue; } // Agent ID 登记合约本身不是项目（注册 .ai 身份），不打
    if (busyP.has(c)) continue; busyP.add(c); const tE = Date.now();
    try {
    P.lastTry = Date.now(); if (WALLETS.every((W) => P.done[W.name])) { if (FORCE.has(c)) { S.forceDone = S.forceDone || {}; S.forceDone[c] = 1; FSWHY.set(c, '我的钱包都已经铸过这个项目了（不是项目售罄）'); } delete S.paid[c]; continue; }
    if (!trackOk(P)) { delete S.paid[c]; continue; } 
    if (P.serialLog && !FORCE.has(c)) continue; if (!FORCE.has(c)) { const ck = await cloneStall(c).catch(() => ''); if (ck) { if (P.lastReason !== ck + '，照规则不打') { P.lastReason = ck + '，照规则不打'; log(`跳过 ${P.name || c}：${ck}`); } continue; } } 
    const code = await codeOf(c); if (!code || code === '0x') { const w0 = '合约程式码读不到（节点没回应），这轮先跳过，下一轮再查'; if (P.lastReason !== w0) { P.lastReason = w0; log(`${P.name || c}：${w0}`); } continue; } /* 读不到不当成别的合约种类 */
    // 发现时还没开的「免费」铸造：之后每分钟重试，一开就自动打
    const fcd = (GO_PCT > 0 && (P.progress || 0) >= GO_PCT - 0.02) || zrQuick(c, P) ? 20e3 : 120e3; /* 快到你的进度门槛、或在你的快速检查名单里 → 比较快重试（只是重试频率） */
    if (Date.now() - (P.freeTryAt || 0) > fcd && !((P.progress || 0) > 0 && P.progress < GO_PCT - 0.02 && Date.now() - (P.freeTryAt || 0) < 600e3)) { /* 进度离你的门槛还远的免费项目隔久一点才模拟（只是频率） */ P.freeTryAt = Date.now(); for (const W of WALLETS) { if (P.done[W.name] || W.off) continue; /* 断开的钱包不用再模拟（白花节点额度） */ { const ff = await findFree(W.addr, c, code); if (!ff || P.qAt?.[W.name] > Date.now() - (fcd - 5e3)) continue; P.qAt = P.qAt || {}; P.qAt[W.name] = Date.now(); queueMint(c, ff.n, W, ff.v); P.freeLogAt = P.freeLogAt || {}; if (!(Date.now() - (P.freeLogAt[W.name] || 0) < 3600e3)) { P.freeLogAt[W.name] = Date.now(); log(`[${W.name}] 之前还没开的 ${P.name || c} 现在开了（免费），照规则检查（免费只通知不自动打）`); } /* 运作：同一个项目一小时只记一次（避免日志被淹没） */ } } }
    let kind = code.includes('e38fd349') && code.includes('68bce8cd') ? 'bnb' : code.includes('725c4058') && code.includes('94bf804d') ? 'usdt' : null;
    let unit = 0n; // 一般 NFT：mint(数量) 付「单价 × 数量」BNB（像 Sentient Syndicate 的 PRICE）
    if (!kind && code.includes('a0712d68')) for (const sel of ['8d859f3e', 'a035b1fe', '6817c76c', '13faede6', '817b1cd2']) { if (!code.includes(sel)) continue; const r = await cc(c, '0x' + sel); if (r && r.length >= 66 && BigInt(r.slice(0, 66)) > 0n) { unit = BigInt(r.slice(0, 66)); kind = 'gen'; break; } }
    if (!kind && P.recvValue) kind = 'recv';
    if (P.pick?.appr && !FORCE.has(c) && !nrOn('auto.allowApproval')) { const w0 = '你选的打法是转帐／授权类函式：自动打要你另外开「自动交易允许授权」(auto.allowApproval)，没开只记录不送'; if (P.lastReason !== w0) { P.lastReason = w0; log(`${P.name || c}：${w0}`); } continue; } 
    if (P.pick?.data != null) { P.replay = { ...P.pick, src: 'user', learnedAt: Date.now(), hot: P.replay?.hot || 0 }; if (!kind || kind === 'recv') kind = 'replay'; } /* 你在「选打法」存的打法优先 */
    if (P.replay && badSel(P.replay.data) && !(P.pick?.appr && P.replay.src === 'user')) delete P.replay; /* 你看懂警告后存的授权类打法不删（送出前预演还会再问／照 auto.allowApproval） */
    if (!kind && P.replay?.data) kind = 'replay'; // 少见的铸造函式：照别人的呼叫内容与金额打
    
    if (!kind || kind === 'replay') P.needLearn = 1; // 看不懂的合约：交给背景的热度监测去学别人的打法，这里不等
    if (!kind) { P.noKind = P.noKind || Date.now(); if (FORCE.has(c)) P.lastReason = '还看不懂这个合约怎么铸造（正在学别人的打法；也可以在雷达点「⚠️ 认不出打法 — 点这里自己选」），这次没打'; else if (!P.noKindLog) { P.noKindLog = 1; log(`${P.name || c}：认不出打法，雷达会继续学别人的打法；你也可以在雷达点「⚠️ 认不出打法 — 点这里自己选」`); } continue; } if (P.noKind) { delete P.noKind; delete P.noKindLog; } 
    if (P.unmintable && P.unmintableAt && nrNum('mint.pauseMin') != null && Date.now() - P.unmintableAt > nrNum('mint.pauseMin') * 60e3 && (nrNum('mint.retryN') == null || (P.umN || 0) < nrNum('mint.retryN'))) { P.umN = (P.umN || 0) + 1; /* 暂停后再试几轮＝你的设定（没填＝一直再试） */ delete P.unmintable; P.fail = 0; P.cf = 0; }
    if (P.unmintable && !FORCE.has(c)) continue;
    let soldR = await call(c, kind === 'bnb' ? '0xa2309ff8' : kind === 'gen' ? '0x18160ddd' : '0x192fc516');
    if (!(soldR && soldR.length >= 66) && (kind === 'replay' || kind === 'recv')) { if (P.soldSel) soldR = await call(c, P.soldSel); else for (const sel of ['0x02c7e7af', '0xa2309ff8', '0x9106d7ba', '0xf4514d2e', '0x505e05fd', '0x3a98ef39']) { const r = await cc(c, sel, 60e3); if (r && r.length >= 66) { soldR = r; P.soldSel = sel; break; } } }
    const sold = soldR && soldR.length >= 66 ? Number(BigInt(soldR.slice(0, 66))) : null; if (sold != null) P._sold = sold;
    let cap = null; /*V104-CAPSANE：以前先读 0xa0e23ebd 当总量，它其实是 openAt()（开放时间）→ 拿掉*/ if (!cap) for (const sel of ['0xd8f93498', '0xcef6feda', '0x29b80536', '0xd5abeb01', '0x32cb6b0c', '0x355274ea', '0x3a1d8d3a', '0xf1aee5a2', '0x85e3f997']) { if (capTimeSels().has(capSelK(sel))) continue; const r = await cc(c, sel); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && sold != null && x >= sold && x < 1e12 && capOk(sel, x, sold, P, c)) { cap = x; break; } } }
    if (!cap && sold != null && sold > 0) { /* 总量函式不在常见清单时，自动从合约里找「总量」函式并记住 */
      if (P.capSel && capTimeSels().has(capSelK(P.capSel))) P.capSel = undefined; /*V104-CAPSANE：旧版记住的时间函式（PAUSE_DURATION() 这类）重找*/
      if (P.capSel === undefined) P.capSel = await findCapSel(c, code, sold).catch(() => '') || '';
      if (P.capSel) { const r = await cc(c, '0x' + P.capSel, 600e3); if (r && r.length >= 66) { const x = Number(BigInt(r.slice(0, 66))); if (x > 0 && x < 1e9 && capOk(P.capSel, x, sold, P, c)) cap = x; } } /*V104-CAPSANE：总量要 ≥ 已售、不像时间戳；不合理＝读不到总量（不再把已售当总量算成满格）*/
    }
    let tokAddr0 = ''; { const tr0 = await cc(c, '0xfc0c546a', 3600e3); if (tr0 && tr0.length >= 66 && BigInt(tr0.slice(0, 66)) > 0n) tokAddr0 = '0x' + tr0.slice(26, 66); } if (tokAddr0) P.tok = tokAddr0.toLowerCase(); /* 记下铸造项目的代币，AI 热门代币不会去买它 */
    let progress = cap && sold != null ? sold / cap : 0, how = '已售／上限';
    if (!(progress > 0)) { const pr = await progressOf(c, code, tokAddr0); progress = pr.progress || 0; how = pr.how || ''; }
    /* 读到的进度就是读到的；读不到＝读不到，照你的 bsc.goPct.miss */
    const prevProg = P.progress; P.progress = progress; P.progAt = Date.now();
    if (P.pick?.data != null) kind = 'replay'; /* 进度照合约本身读，打法用你选的 */
    if ((P.soldOut || progress >= 1) && !P.noRefundLog && !P.serialLog && !String(P.lastReason || '').includes('保本') && !String(P.lastReason || '').includes('部署者') && !(await serialDev(c).catch(() => '')) && !WALLETS.some((W) => P.done[W.name] && !['pool-open', 'fail', 'unknown'].includes(P.done[W.name]))) { /* 照规则不打（没有保本）的不算错过 */ S.missed = S.missed || {}; if (!S.missed[c]) { S.missed[c] = { name: P.name || c.slice(0, 10), at: ts(), why: P.lastReason || (P.unmintable ? '打不了' : '还没找到能打的方式') }; log(`错过 ${c}（${S.missed[c].name}）：进度已 ${Math.round(progress * 100)}%，我们没打到，原因：${S.missed[c].why}`); } } /* 让自己更聪明：记下快卖完却没打到的项目和原因，每晚总结列出来，方便找出要补的漏洞 */
    { const gp = nrOn('grp.on') ? nrNum('grp.progPct') : null; if (gp != null && progress >= gp / 100 && (prevProg == null || prevProg < gp / 100)) groupProgress(c, P.name, progress, gp).catch(() => {}); } /* 群播报＝你的 grp.progPct */
    { const now = Date.now(); P.ph = (P.ph || []).filter((x) => now - x.t < 15 * 60e3); if (!P.ph.length || now - P.ph[P.ph.length - 1].t > 10e3) P.ph.push({ t: now, p: progress }); }
    if ((progress >= 1 && cap && sold != null && sold >= cap) || (FORCE.has(c) && progress >= 0.999)) { P.lastReason = '已经铸完（名额没了）'; P.soldOut = 1; if (FORCE.has(c)) { fsStage(c, 'checking', `项目已售罄：进度 ${Math.round(progress * 1000) / 10}%（${how}${sold != null ? '，已售 ' + sold + (cap ? '／' + cap : '') : ''}）`); FSWHY.set(c, '项目已售罄（名额没了），不是你的钱包铸过'); FORCE.delete(c); S.forceAdd = (S.forceAdd || []).filter((x) => x !== c); S.forceDone = S.forceDone || {}; S.forceDone[c] = 1; } continue; } 
    price = price || (await bnbUsd());
    const forced = FORCE.has(c); if (forced) fsStage(c, 'checking', `进度 ${progress > 0 ? Math.round(progress * 1000) / 10 + '%（' + how + '）' : '读不到'}${sold != null ? ' · 已售 ' + sold + (cap ? '／' + cap : '') : ''} · Agent 钱包 最高 ${P.agents ?? '-'}／现在 ${P.agNow ?? '-'}${P.agNowAt ? '（' + new Date(P.agNowAt).toTimeString().slice(0, 5) + ' 取样）' : ''}`);
    
    const MJ = nrMintJ(P, progress); /* 照你的条件和组合方式判断；读不到进度时照你选的（不买／用备用条件），不会偷偷改用钱包数 */ if (!forced) nrDecLog('bsc', c, P.name, MJ); else nrForceLog(c, P.name, [], MJ); P.nrJ = nrJLabel(MJ); if (MJ.buy === true && / → 不买/.test(P.lastReason || '')) P.lastReason = ''; /* 清单每一列都标你的条件结果 */
    if (!forced && MJ.buy !== true) { P.lastReason = MJ.text; nrMissTg(c, P, progress, MJ); continue; }
    if (!forced) DEC_CP.set(c, { d0: { ...(P.done || {}) }, P }); /* 条件通过 → 这一轮结束时记下实际结果 */
    if (!forced) { const sd = await serialDev(c); if (sd) { if (!P.serialLog) { P.serialLog = 1; P.lastReason = sd + '，照规则不打'; if (S.missed?.[c]) delete S.missed[c]; log(`跳过 ${P.name || c}：${sd}，照规则不打`); } continue; } }
    const payState = kind === 'replay' ? replayPayState(P.replay) : 'paid', freeOk = payState === 'free'; /*V104-FREEPATH：已验证零付款才走免费路径*/
    if (!forced && payState === 'unknown') { const w0 = '读不到这个打法要不要付款（付款状态未知），照规则不打'; if (P.lastReason !== w0) { P.lastReason = w0; log(`跳过 ${P.name || c}：${w0}`); } continue; } /* 未知＝拒绝，不当免费放行 */
    { /* 风险变大了——付费项目一定要有保本机制（打不满可以退款），没有就不打。看合约（含代理背后的实作）有没有退款函式 */
      const paying = !freeOk;
      if (!forced && !paying && !P.pick /* 你选的打法不会被换掉 */ && nrOn('bsc.relearnPaid') && await othersPay(c).catch(() => 0)) { P.needLearn = 1; P.freePhase = 1; delete P.replay; continue; } /* 学到的是免费那份、但大家都在付费打 → 改学付费的打法＝你的开关 bsc.relearnPaid（预设关） */
      if (!forced && !paying && !NR.on('bsc.freeAuto')) { if (NR.on('bsc.freeNotify')) await freeNotify(c, P.name, progress > 0 ? progress : null, P.agents).catch(() => {}); for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'free-notify'; continue; } /* 免费要不要自动打＝你的开关（两个都开时照「只通知」） */ 
      /* 要不要有「每个钱包上限」＝你的 bsc.needWalletLimit */
      if (!forced && paying && await isNft(c).catch(() => true)) { let why = nftGate(progress, P, c); if (!why && NR.on('bsc.needWalletLimit') && !(await walletLimit(c, true))) why = 'NFT 一定要有「每个钱包上限」（只有每笔上限不算）'; if (!why && NR.on('bscnft.imgCheck')) why = await nftStrict(c); if (why) { if (P.nftWhy !== why) { P.nftWhy = why; P.lastReason = why; log(`跳过 ${P.name || c}：${why}`); } continue; } P.isNftBuy = 1; }
      if (!forced && paying && NR.on('bsc.needWalletLimit')) { if (P.wlim == null) P.wlim = await walletLimit(c); if (!P.wlim) { if (!P.noLimLog) { P.noLimLog = 1; P.lastReason = '没有每个钱包上限的规定，照规则不打'; log(`跳过 ${P.name || c}：合约没有「每个钱包最多几份」的规定，照规则不打`); } continue; } }

    }
    if (!forced && freeOk) { /*V104-FREEPATH：免费项目不套付费经济条件（总盘至少 BNB、已募 BNB、最多占总盘 %、付费预算）；「已售至少 N 份」照套，开着读不到＝不打*/
      const msd = NR.num('bsc.minSold'), soldN = sold != null && sold < 1e9 ? sold : null; const why = msd == null ? '' : soldN == null ? '读不到已售份数，你开了「已售至少」' : soldN < msd ? `已售只有 ${soldN} 份，你设要 ${msd} 份以上` : '';
      if (why) { if (P.fishWhy !== why.slice(0, 6)) { P.fishWhy = why.slice(0, 6); P.lastReason = why + '，先不打'; log(`跳过 ${P.name || c}：${why}，先不打（之后达标会再检查）`); } continue; } P.maxOurBnb = 0;
    }
    if (!forced && !freeOk) { /* 防定点钓鱼（项目方把总份额调很小，少数人就能把进度灌过门槛）：① 总盘至少 ② 已售至少 ③ 最多占总盘几 % —— 全部＝你的设定，开着读不到＝不打 */
      let unitBnb = 0; try { if (kind === 'bnb') { const q = await cc(c, '0x68bce8cd' + w(1), 300e3); if (q && q.length >= 66) unitBnb = Number(BigInt(q.slice(0, 66))) / 1e18; } else if (kind === 'gen') unitBnb = Number(unit) / 1e18; else if (kind === 'replay' && P.replay?.value && !P.replay?.payTok) { const a1 = /^0x[0-9a-f]{8}([0-9a-f]{64})/i.exec(P.replay.data || ''); let u = a1 ? Number(BigInt('0x' + a1[1])) : 1; if (!(u >= 1 && u <= 1000)) u = 1; unitBnb = Number(BigInt(P.replay.value)) / 1e18 / u; } } catch {}
      const soldN = sold != null && sold < 1e9 ? sold : null, capN = cap != null && cap < 1e9 ? cap : null;
      let why = '';
      const mpb = NR.num('bsc.minPoolBnb'), msd = NR.num('bsc.minSold'), mrb = NR.num('bsc.minRaisedBnb'); /* 防定点钓鱼的门槛＝你的设定 */
      if (mpb != null && !(unitBnb > 0 && capN)) why = `读不到总盘大小（份数或每份价格），你开了「总盘至少 ${mpb} BNB」`; 
      else if (mpb != null && capN * unitBnb < mpb) why = `总盘太小（${capN} 份 × ${unitBnb.toFixed(4)} BNB ≈ ${(capN * unitBnb).toFixed(2)} BNB，你设要 ${mpb} BNB 以上），可能是定点钓鱼`;
      else if (soldN == null && (msd != null || mrb != null)) why = '读不到已售份数，你开了「已售至少」'; 
      else if (soldN != null && (msd != null || mrb != null) && !((msd != null && soldN >= msd) || (mrb != null && unitBnb > 0 && soldN * unitBnb >= mrb))) why = `已售只有 ${soldN} 份${unitBnb > 0 ? '（约 ' + (soldN * unitBnb).toFixed(2) + ' BNB）' : ''}，你设要${msd != null ? ' ' + msd + ' 份以上' : ''}${msd != null && mrb != null ? '或' : ''}${mrb != null ? '已募 ' + mrb + ' BNB 以上' : ''}`;
      if (why) { if (P.fishWhy !== why.slice(0, 6)) { P.fishWhy = why.slice(0, 6); P.lastReason = why + '，先不打'; log(`跳过 ${P.name || c}：${why}，先不打（之后达标会再检查）`); } continue; }
      { const mps = NR.num('bsc.maxPoolShare'); if (mps != null && !(unitBnb > 0 && capN)) { const w7 = '读不到总盘大小，算不出你设的「最多占总盘 %」，先不打'; if (P.lastReason !== w7) { P.lastReason = w7; log(`跳过 ${P.name || c}：${w7}`); } continue; } P.maxOurBnb = mps != null && unitBnb > 0 && capN ? (capN * unitBnb * mps / 100) / WALLETS.length : 0; }
    }
    const gate = forced || MJ.buy === true; 
    if (gate && !forced) { const cs = globalThis.CUSTOM_SKIP?.({ chain: 'bsc', type: 'mint', c, name: P.name || '', progress, agents: P.agents || 0 }); if (cs) { if (P.customWhy !== cs) { P.customWhy = cs; P.lastReason = '自订规则不打：' + cs; log(`${P.name || c} 自订规则不打：${cs}`); } continue; } }
    if (gate && ESTOP()) { if (forced) P.lastReason = '紧急全停中，强制打也不打'; if (!P.estopLogged) { P.estopLogged = 1; log(`${P.name || c} 符合条件，但紧急全停中，不打（强制打也不打）`); } continue; }
    if (forced && (CONFL || MANUAL_OFF())) { const why = CONFL ? '另一个雷达正在用同一个钱包' : '「手动买卖」没打开'; if (P.lastReason !== why + '，强制打不执行') { P.lastReason = why + '，强制打不执行'; log(`${P.name || c}：${why}，强制打不执行`); } continue; } 
    if (gate && !forced && Number(radarSet()['bscnft.auto']) !== 1 && await isNft(c).catch(() => true)) { if (!P.nftOffLog) { P.nftOffLog = 1; P.lastReason = '这是 NFT，你没开「NFT 自动铸造」，不打'; log(`跳过 ${P.name || c}：是 NFT，「NFT 自动铸造」没开（只开代币铸造不会打 NFT）`); } continue; } /* 用户没开 NFT 却铸到 NFT查不出是不是 NFT 也当 NFT（宁可不打） */
    if (gate && !forced && (radarOff() || Number(radarSet()['bsc.mintAuto']) !== 1)) { if (!P.pauseLogged) { P.pauseLogged = 1; log(`${P.name || c} 符合条件，但雷达设成暂停／不自动打，所以不打`); } continue; } 
    if (!forced && !P.goLogged) { P.goLogged = 1; globalThis.xCheck?.(c, P.name).catch(() => {}); ownerHeavy(c, P.name).catch(() => {}); log(`进场 ${c}：${MJ.text}（累计 ${P.agents ?? '-'} 个代理人、最近 ${P.burst ?? '-'} 个），进度 ${progress > 0 ? Math.round(progress * 100) + '%' : '读不到'}`); }
    // 防钓鱼：同款合约批量部署、假进度 —— 次数／钱包数＝你的设定
    if (!forced) { const dep0 = P.deployer !== undefined ? P.deployer : await deployerOf(c); P.deployer = dep0; if (blackOn(dep0)) { if (!P.blackLogged) { P.blackLogged = 1; log(`跳过 ${c}：部署者 ${dep0} 在黑名单（${S.black[dep0].why}）`); } continue; } } 
    /* 这里原本有一段 if (!gate) {…}（新钱包部署者、重复 DEV 要 40 个钱包、钱流），但走到这里 gate 一定是 true，永远不会执行 → 删掉 */
    // 只打新的 → 两天前就部署的老合约不打
    if (!forced && NR.num('bsc.maxContractAgeH') != null) { const cah = NR.num('bsc.maxContractAgeH'); if (P.old == null || P.oldH !== cah) { /* 老合约（两天前就存在）不管门槛有没有过都不打 */ const head = parseInt(await rpc('eth_blockNumber', []), 16); const o = await rpc('eth_getCode', [c, '0x' + Math.max(1, head - Math.round((cah * 3600) / BSC_BLK_S)).toString(16)]).catch(() => '0x'); P.old = !!o && o.length > 2; P.oldH = cah; } if (P.old) { for (const W of WALLETS) P.done[W.name] = P.done[W.name] || 'old'; continue; } }

    if (!forced && NR.on('bsc.skipIfPoolOpen') && !(progress > 0)) { const tk = tokAddr0 || c; if (await poolOpen(tk)) { if (!P.poolSkipLog) { P.poolSkipLog = 1; log(`跳过 ${c}：已经开池交易，读不到进度时不在开池后铸（之后读到进度会再照你的条件判断）`); } continue; } } 
    const limitUsd = Infinity;
    let tokAddr = ''; const tr = await cc(c, '0xfc0c546a', 3600e3); if (tr && tr.length >= 66) tokAddr = '0x' + tr.slice(26, 66);
    const sym = tokAddr ? tokStr(await cc(tokAddr, '0x95d89b41', 3600e3)) || P.name || c.slice(0, 8) : P.name || c.slice(0, 8);
    await Promise.all(WALLETS.map(async (W) => { 
      if (W.off) { if (!P.offLog?.[W.name]) { P.offLog = P.offLog || {}; P.offLog[W.name] = 1; log(`[${W.name}] 钱包登出中，${P.name || c} 先不用这个钱包打（重新连上后自动恢复）`); } return; } 
      if (P.done[W.name]) { if (forced) fsW(c, W, '这个钱包之前已经铸过（' + P.done[W.name] + '），这次不打'); return; }
      if (!forced && WALLETS.length > 1 && W !== WALLETS[0] && !P.probeOk && NR.on('risk.probe')) { /* ③ 先小额试水：第一个钱包真的收到东西，第二个钱包才打 */ if (P.done[WALLETS[0].name] !== 'minted') { P.probeWait = P.probeWait || Date.now(); const pw = NR.num('risk.probeWaitSec'); if (pw != null && Date.now() - P.probeWait > pw * 1000 && !P.done[W.name]) { P.done[W.name] = 'probe-skip'; log(`试水：${P.name || c} 第一个钱包 ${pw} 秒内没打成，第二个钱包不打这个项目`); } return; } /* 第一个钱包没打成，第二个钱包一律不打 */ else { const A = WALLETS[0].addr; let got = 0n; for (const t of [P.tok, c].filter(Boolean)) { const r = await call(t, '0x70a08231' + wa(A)).catch(() => ''); if (r && r.length >= 66) got += BigInt(r.slice(0, 66)); } if (!(got > 0n)) { if (!P.probeLog) { P.probeLog = 1; log(`试水：${P.name || c} 第一个钱包还没真的收到东西，第二个钱包先不打`); } return; } P.probeOk = 1; } }
      if (!forced && !freeOk) { const rb = await riskBlock(W, c, 0n, '0x', false, true).catch(() => ''); /*V104-FREEPATH：免费的风控在送出前用最终 calldata 检查*/ if (rb) { if (P.riskLog !== rb) { P.riskLog = rb; log(`[${W.name}] 风控暂停 ${P.name || c}：${rb}`); } return; } }
      if (forced ? capOf(c) == null : !freeOk && (PAID.maxUsd == null || PAID.dayUsd == null)) { /*V104-FREEPATH：免费不需要付费预算*/ const why = forced ? '强制打要先填这次最多付多少 U（或在设定填「每个项目每笔最多」）' : '你没填「每个项目每笔最多」或「每天最多」，不自动打'; if (P.lastReason !== why) { P.lastReason = why; log(`${P.name || c}：${why}`); } return; } 
      const budU = forced ? capOf(c) : freeOk ? 0 /*V104-FREEPATH：免费＝预算 0，不占每天付费额度*/ : Math.min(P.isNftBuy ? nftBud() : PAID.maxUsd, PAID.dayUsd - paidDayUsd(W) - (DAYRES[W.name] || 0), P.maxOurBnb > 0 && price > 0 ? P.maxOurBnb * price : 1e9); /* 合计不超过总盘几 %＝你的 bsc.maxPoolShare */ /* NFT 预算＝你的设定 bscnft.agUsd */ if (!(freeOk && !forced) && budU < 1) { if (P.dayCapLog !== new Date().toDateString()) { P.dayCapLog = new Date().toDateString(); log(`[${W.name}] 今天付费已达 ${PAID.dayUsd}U 上限，${P.name || c} 不打`); } return; } 
      if (!forced) DAYRES[W.name] = (DAYRES[W.name] || 0) + budU; 
      try {
        price = price || (await bnbUsd());
        const spent = S.paidSpend[W.name] || 0;
        const bal = Number(BigInt((await rpc('eth_getBalance', [W.addr, 'latest'])) || '0x0')) / 1e18;
        let n = 10, costWei = 0n;
        if (kind === 'replay' && P.replay.payTok) { // 付 USDT 的铸造（像 BITO）：换 USDT → 授权 → 照别人的方式打，份数＝你的单次预算买得起几份
          if (P.replay.payTok !== USDT) { if (!P.payTokLogged) { P.payTokLogged = 1; log(`跳过 ${c}：要付的代币不是 USDT（${P.replay.payTok}）`); } return; }
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; }
          let data = freshDeadline(P.replay.data), need = BigInt(P.replay.payAmt || '0'); const ws = data.slice(10).match(/.{64}/g) || [];
          if (ws.length === 3 && need > 0n) { const n0 = BigInt('0x' + ws[0]), mx = BigInt('0x' + ws[2]); if (n0 > 0n && n0 <= 100n && mx >= need && mx <= (need * 12n) / 10n) { const unit = need / n0; let nn = budU > 0 && unit > 0n ? BigInt(Math.floor((budU * 1e18) / (Number(unit) * pbF()))) : 1n; if (nn < 1n) nn = 1n; /* 份数＝你的单次预算买得起几份（不另设上限，超过合约限制会在预演挡下） */ const mp = pbW(unit * nn); data = data.slice(0, 10) + w(nn) + ws[1] + w(mp); need = mp; } }
          if (!(need > 0n) || Number(need) / 1e18 > budU) return;
          let ub = (await usdtFree(W));
          if (ub < need) { const nb = ((Number(need - ub) / 1e18) * pbF()) / price; if (nb > bal - PAID.keepBnb) return; const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', nb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]); if (!sw.j?.success) throw new Error('BNB 换 USDT 失败 ' + (sw.j?.error?.message || sw.t).slice(0, 100)); for (let i = 0; i < 30 && ub < need; i++) { await sleep(3000); ub = (await usdtFree(W)); } if (ub < need) throw new Error('USDT 没到帐' + pbSwapHint()); }
          const v = BigInt(P.replay.value || '0'); if (v > 0n && ((Number(v) / 1e18) * pbF() > bal - PAID.keepBnb || Number(need) / 1e18 + (Number(v) / 1e18) * price > budU)) return; /* 付 USDT 的同时若还要附 BNB，也要算进预算 */ 
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(need), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授权对象不对' : ''));
          const r = await revokeOnFail(W, USDT, c, async () => { try { data = await safeAddrs(W, c, data, v); data = await fitShares(W, c, data, v); } catch (e) { if (/[額额]度|quota|已打[滿满]/.test(e.message)) P.done[W.name] = 'full'; else noteFail(c, P, sym, progress); throw e; } return previewExec(W, c, data, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.authorityChanges?.length) return '有权限变化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => { const a = String(b.contractAddress).toLowerCase(); return a !== USDT && !a.startsWith('0xeeee'); })) return '会扣到 USDT/BNB 以外的资产';
            if (out.filter((b) => String(b.contractAddress).toLowerCase() === USDT).reduce((a, b) => a - Number(b.change), 0) > Number(need) * pbF()) return '扣的 USDT 超过预算'; return '';
          }); });
          const paidU = (r.sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr && String(b.contractAddress).toLowerCase() === USDT && Number(b.change) < 0).reduce((a, b) => a - Number(b.change), 0) / 1e18; const usd = paidU > 0 ? paidU : Number(need) / 1e18; S.paidSpend[W.name] = spent + usd / price; P.done[W.name] = 'minted'; /* 记实际扣掉的 USDT */
          if (paidU > 0 && paidU < (Number(need) / 1e18) * 0.99) previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(0n), 0n, () => '').catch(() => {}); /* 授权没用完就收回 */
          if (tokAddr && rcvOk(W, tokAddr, c) && !addCostEx(W, tokAddr, +usd.toFixed(2), '铸造')) /*RISK-FIX2-2*/ S.dyn.push({ sym, addr: tokAddr.toLowerCase(), cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          addPaidUsd(W, usd);
          if (forced) forceTag(W); await tg(`🛒 [${W.name}] ${forced ? '手动强制打了' : '自动打了'}付费 Agent ID 项目：${sym}（照别人的方式，付 USDT）${grpTxt(c)}\n花约 ${usd.toFixed(2)} USDT · ${progress > 0 ? '进度约 ' + Math.round(progress * 100) + '%' : '最近 ' + (P.replay.hot || 0) + ' 个钱包在打'}\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'replay') {
          if (Date.now() - (P.replay.learnedAt || 0) > 90e3) { const lr = await learnReplay(c).catch(() => null); if (lr) P.replay = { ...P.replay, ...lr }; } /* 用最新的别人交易（价格参数要新） */
          let v = BigInt(P.replay.value || '0'); let vb = Number(v) / 1e18;
          if (price && vb * price > budU && P.replay.data && !P.pick /* 你选的打法不改份数，超过预算就说超过 */) { /* 学到的金额超过你的预算时，第一个参数是份数就按比例降份数＋金额 */
            
            const cands = []; for (let k = 0; k < 4; k++) { const wk = P.replay.data.slice(10 + k * 64, 74 + k * 64); if (wk.length !== 64) break; const n0 = Number(BigInt('0x' + wk)); if (!(n0 >= 2 && n0 <= 100)) continue; const n1 = Math.floor((budU / (vb * price)) * n0); if (n1 < 1) { P._minU = (vb * price) / n0; continue; } cands.push({ k, n0, n1, data: P.replay.data.slice(0, 10 + k * 64) + n1.toString(16).padStart(64, '0') + P.replay.data.slice(74 + k * 64), v: (v * BigInt(n1)) / BigInt(n0) }); }
            let pick = null; if (cands.length > 1) for (const x of cands) { try { await rpc('eth_call', [{ from: W.addr, to: c, data: freshDeadline(x.data), value: '0x' + x.v.toString(16) }, 'latest']); pick = x; break; } catch {} }
            pick = pick || cands[0]; if (pick) { v = pick.v; vb = Number(v) / 1e18; P.replay = { ...P.replay, data: pick.data, value: v.toString() }; log(`照抄金额超过预算，第 ${pick.k + 1} 个参数当份数 ${pick.n0}→${pick.n1}：${c}`); }
          }
          if ((!price && !(freeOk && !forced && v === 0n)) || vb * price > budU || vb * pbF() > bal - PAID.keepBnb) { P.lastReason = !price ? '读不到 BNB 价格，这次没打' : vb * price > budU ? `一份就要约 ${(P._minU && P._minU < vb * price ? P._minU : vb * price).toFixed(1)}U，超过这次预算 ${Number(budU).toFixed(0)}U` : `钱包 BNB 不够（要约 ${vb.toFixed(4)} BNB，还要留手续费）`; return; } 
          let rdata = freshDeadline(P.replay.data); try { rdata = await safeAddrs(W, c, rdata, v); const rd0 = rdata; rdata = await fitShares(W, c, rdata, v); v = scaleV(rd0, rdata, v); vb = Number(v) / 1e18; } catch (e) { if (/[額额]度|quota|已打[滿满]/.test(e?.message || '')) P.done[W.name] = 'full'; else noteFail(c, P, sym, progress); return; } /* 付 BNB 的照抄也要换掉别人的地址、自动调份数 */
          { /* 先换最新样本再试，再试提高价格上限（＝你的 bsc.replayBumpMax，只在交易内容里有跟付款金额一样的上限数字时） */
            const ok = async (d, val) => { try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x' + val.toString(16) }, 'latest']); return true; } catch (e) { P._rv = revWhy(e); return false; } };
            let good = await ok(rdata, v); P._baseVb = vb; /* 加价前的金额：只有这部分算进每日总上限 */
            if (!good && !P.pick /* 不重学别人的 */) { const lr = await learnReplay(c).catch(() => null); if (lr?.data) { P.replay = { ...P.replay, ...lr }; const v2 = BigInt(lr.value || '0'); let d2 = freshDeadline(lr.data); let v2s = v2; try { d2 = await safeAddrs(W, c, d2, v2); const dd = d2; d2 = await fitShares(W, c, d2, v2); v2s = scaleV(dd, d2, v2); } catch {} if ((Number(v2s) / 1e18) * price <= budU && (Number(v2s) / 1e18) * pbF() <= bal - PAID.keepBnb && await ok(d2, v2s)) /* 重新学到的金额也要在你的预算和余额内 */ { rdata = d2; v = v2s; vb = Number(v) / 1e18; good = true; } } }
            const bmx = NR.num('bsc.replayBumpMax'); /* 照抄加价最多几 %＝你的设定（没开＝不加价） */
            if (!good && v > 0n && bmx != null && !P.pick /* 你填的金额不自动加价 */) for (const pct of [...new Set([2, 5, 10, 20, Math.round(bmx)].filter((x) => x > 0 && x <= bmx))].sort((a, b) => a - b).map((x) => 100n + BigInt(x))) { /* 跟单涨价最多加几 %＝你的 bsc.replayBumpMax（没开＝不加价） */ /* 一路试到你设的加价上限，金额在你的预算与余额内 */
              const vU = (v * pct) / 100n; if ((Number(vU) / 1e18) * price > (forced ? capOf(c) : budU * (1 + bmx / 100)) || (Number(vU) / 1e18) * pbF() > bal - PAID.keepBnb) break;
              const ws = rdata.slice(10).match(/.{64}/g) || []; let hit = 0; const d3 = rdata.slice(0, 10) + ws.map((x) => { const y = BigInt('0x' + x); if (y > 0n && y === v) { hit = 1; /* 参数刚好等于这笔金额才换 */ return vU.toString(16).padStart(64, '0'); } return x; }).join('');
              if (await ok(hit ? d3 : rdata, vU)) { rdata = hit ? d3 : rdata; v = vU; vb = Number(v) / 1e18; good = true; log(`照抄时金额 +${pct - 100n}% 才过：${c}`); P.replay = { ...P.replay, data: rdata, value: v.toString() }; break; }
            }
            if (!good && P.pick && (forced ? FACK.has(c) : nrOn('auto.sendOnPreviewFail'))) log(`[${W.name}] ${P.name || c} 用你选的打法预演没过（${P._rv || '原因读不到'}），${forced ? '你按了「我知道风险，仍然执行」' : '你开了「预演不过也送出」(auto.sendOnPreviewFail)'}，照送`); /* 预演没过 */ else if (!good) { P.lastReason = '预演没过' + (P.pick ? '（用你选的打法）' : '') + '：' + (P._rv || '原因读不到') + (P.pick && !forced ? '，只记录不送（「预演不过也送出」没开）' : P.pick ? '；要的话可以在「选打法」按「我知道风险，仍然送出」' : ''); if (forced) fsW(c, W, P.lastReason); noteFail(c, P, sym, progress); return; } /* 失败几次才标打不了＝你的 mint.failN */
          }
          const freeGo = freeOk && !forced; let fOut = 1; /*V104-FREEPATH*/
          if (freeGo) { if (v !== 0n) { P.lastReason = '学到的打法变成要付款，这一轮不打（下一轮照付费规则重新判断）'; P.needLearn = 1; return; } const rbF = await riskBlock(W, c, 0n, rdata, true, false).catch((e) => '风控检查读不到（' + String(e?.message || e).slice(0, 60) + '）'); if (rbF) { if (P.riskLog !== rbF) { P.riskLog = rbF; log(`[${W.name}] 风控暂停 ${P.name || c}（免费）：${rbF}`); } P.lastReason = '风控：' + rbF; return; } } /* 用最终真的 calldata：免费次数／每日手续费／gas 上限／BNB 保留额 */
          const r = await previewExec(W, c, rdata, v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            fOut = !sim || mine.some((b) => Number(b.change) < 0) || !!sim?.allowanceChanges?.length || !!sim?.authorityChanges?.length ? 1 : 0; /*V104-FREEPATH：预演读不到或会扣任何资产＝不是已验证零付款*/
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * pbF()) return '会扣到 BNB 以外或超过金额';
            if (!mine.some((b) => Number(b.change) > 0)) return '模拟没拿到东西'; return '';
          }, freeGo ? async () => (fOut ? '免费照抄的预演读不到或显示会扣款（不是零付款），不送' : '') : null);
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          if (!(v > 0n)) { if (freeGo) riskAfter(W, c, '', 0n, true, false); /*V104-FREEPATH：算进「每天最多几个免费项目」（gas 已由送出时记帐）*/ trackFromSim(W, r.sim, sym, 0); noteFree(c, W, sym); return; }
          trackFromSim(W, r.sim, sym, vb * price); 
          addPaidUsd(W, vb * price); /* 加价的部分也算进「每天最多」（介面写的是每天总上限） */ /* 跟单加价的部分不算进每日总上限 */
          if (forced) forceTag(W); await tg(`🛒 [${W.name}] ${forced ? '手动强制打了' : '自动打了'}付费 Agent ID 项目：${sym}（照别人的铸造方式）${grpTxt(c)}\n花 ${vb.toFixed(4)} BNB（约 ${(vb * price).toFixed(1)}U）· 进度约 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'recv') {
          let v = BigInt(P.recvValue);
          if (price && (Number(v) / 1e18) * price > budU) { /* 大家最常转的金额超过你的预算时，改用别人转过、在预算内最大的金额 */
            const ok = (P.recvVals || []).map((x) => BigInt(x)).filter((x) => (Number(x) / 1e18) * price <= budU).sort((x, y) => (x > y ? -1 : 1)); if (ok.length) v = ok[0]; }
          const vb = Number(v) / 1e18;
          if (!price || vb * price > budU || vb * pbF() > bal - PAID.keepBnb) return;
          try { await rpc('eth_call', [{ from: W.addr, to: c, value: '0x' + v.toString(16) }, 'latest']); } catch (e) { P.lastReason = '预演没过：' + revWhy(e); if (forced) fsW(c, W, P.lastReason); noteFail(c, P, sym, progress); delete P.recvValue; delete P.replay; P.needLearn = 1; return; } /* 预演没过就重学别人的金额 */ // 不能铸（没资格、已打过、额度满）
          const r = await previewExec(W, c, '0x', v, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * pbF()) return '会扣到 BNB 以外或超过金额';
            if (!mine.some((b) => Number(b.change) > 0)) return '模拟没拿到代币'; return '';
          });
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          addPaidUsd(W, vb * price); 
          const ta = tokAddr0 || c; if (rcvOk(W, ta, c) && !addCostEx(W, ta, +(vb * price).toFixed(2), '铸造')) /*RISK-FIX2-2*/ S.dyn.push({ sym, addr: ta, cost: +(vb * price).toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          await tg(`🛒 [${W.name}] 自动打了「转 BNB 铸造」项目：${sym}\n转 ${vb} BNB（约 ${(vb * price).toFixed(1)}U，${P.recvSeen} 个钱包都转这个金额）· 进度约 ${Math.round(progress * 100)}%（${how}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'gen') {
          let data = '';
          for (; n >= 1; n--) { costWei = unit * BigInt(n); if ((Number(costWei) / 1e18) * pbF() > bal - PAID.keepBnb || !price || (Number(costWei) / 1e18) * price > budU) continue; data = '0xa0712d68' + w(n); try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + costWei.toString(16) }, 'latest']); break; } catch (e) { P._rv = revWhy(e); } }
          if (n < 1) { P.lastReason = P._rv ? '预演没过：' + P._rv : '预算或 BNB 不够，一份都买不起'; if (forced) fsW(c, W, P.lastReason); noteFail(c, P, sym, progress); return; }
          const r = await previewExec(W, c, data, costWei, (sim) => {
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * pbF()) return '会扣到 BNB 以外或超过价格';
            if (!mine.some((b) => Number(b.change) > 0)) return '模拟没拿到东西'; return '';
          });
          const vb = Number(costWei) / 1e18; S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          trackFromSim(W, r.sim, sym, vb * price);
          addPaidUsd(W, (vb * price));
          if (forced) forceTag(W); await tg(`🛒 [${W.name}] ${forced ? '手动强制打了' : '自动打了'}付费 Agent ID 项目：${sym}${grpTxt(c)}\n${n} 份，花 ${vb.toFixed(4)} BNB（约 ${(vb * price).toFixed(1)}U）· 进度约 ${Math.round(progress * 100)}%（${sold ?? '?'}／${cap ?? '?'}）\n${c}\n交易 ${r.tx}`);
          return;
        }
        if (kind === 'bnb') {
          for (; n >= 1; n--) { const q = await call(c, '0x68bce8cd' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && (Number(costWei) / 1e18) * pbF() <= bal - PAID.keepBnb && price && (Number(costWei) / 1e18) * pbF() * price <= budU) break; } // 买得起的最多份数（留 gas）
          if (n < 1) { P.lastReason = `每份太贵，超过这次预算 ${Math.round(budU)}U`; return; } // 太贵：先不打
          const v = pbW(costWei), vb = Number(v) / 1e18;
          if (bal - vb < PAID.keepBnb) return;
          const data = '0xe38fd349' + w(n) + wa('0x0000000000000000000000000000000000000000') + w(v);
          try { await rpc('eth_call', [{ from: W.addr, to: c, data, value: '0x' + v.toString(16) }, 'latest']); } catch (e) { P.lastReason = '预演没过：' + revWhy(e); if (forced) fsW(c, W, P.lastReason); noteFail(c, P, sym, progress); return; } // 还没开或没资格
          const pool = tokAddr ? Number(await poolOut(v, WBNB, tokAddr)) : 0;
          const r = await previewExec(W, c, data, v, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已开池，铸造没有比池子便宜`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '有授权变化';
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => !String(b.contractAddress).toLowerCase().startsWith('0xeeee')) || out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * pbF()) return '会扣到 BNB 以外的资产或超过报价';
            if (!mine.some((b) => Number(b.change) > 0)) return '模拟没拿到代币'; return '';
          }, async () => { const q2 = await call(c, '0x68bce8cd' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return driftWhy(c2, costWei); }); /* 送出前再查一次价格 */
          S.paidSpend[W.name] = spent + vb; P.done[W.name] = 'minted';
          const usd = vb * price; const tka0 = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; const got = (r.sim?.balanceChanges || []).some((x) => String(x.owner).toLowerCase() === W.addr && Number(x.change) > 0 && String(x.contractAddress || '').toLowerCase() === String(tka0 || '').toLowerCase()); const tka = tka0 && got && rcvOk(W, tka0, c) ? tka0 : ''; if (!tka) trackFromSim(W, r.sim, sym, usd); if (tka && !addCostEx(W, tka, +usd.toFixed(2), '铸造')) /*RISK-FIX2-2*/ S.dyn.push({ sym, addr: tka.toLowerCase(), cost: +usd.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now(), ...(FORCE.has(c) ? { hold: true } : {}) }); // 使用者指定的项目照免费币处理：只通知不自动卖
          addPaidUsd(W, usd);
          if (forced) forceTag(W); await tg(`🛒 [${W.name}] ${forced ? '手动强制打了' : '自动打了'}付费 Agent ID 项目：${sym}${grpTxt(c)}\n${n} 份，花 ${vb.toFixed(4)} BNB（约 ${usd.toFixed(1)}U）· 已售 ${sold ?? '?'} 份 · 进度约 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入监控：${ruleTxt()}`);
        } else {
          for (; n >= 1; n--) { const q = await call(c, '0x725c4058' + w(n)); costWei = q ? BigInt(q.slice(0, 66)) : 0n; if (costWei > 0n && price && ((Number(costWei) / 1e18) * pbF()) / price <= bal - PAID.keepBnb && Number(costWei) / 1e18 <= budU) break; }
          if (n < 1) { P.lastReason = `每份太贵，超过这次预算 ${Math.round(budU)}U`; return; } // 太贵：先不打
          const cu = Number(costWei) / 1e18, needBnb = (cu * pbF()) / price;
          if (!price || bal - needBnb < PAID.keepBnb) return;
          const data = '0x94bf804d' + w(n) + wa('0x0000000000000000000000000000000000000000');
          let ub = (await usdtFree(W));
          if (ub < costWei) {
            const sw = await W.baw(['market-order', 'swap', '--binanceChainId', '56', '--fromTokenQty', needBnb.toFixed(6), '--fromToken', NATIVE_BNB, '--toToken', USDT]);
            if (!sw.j?.success) throw new Error('BNB 换 USDT 失败 ' + (sw.j?.error?.message || sw.t).slice(0, 100));
            for (let i = 0; i < 30 && ub < costWei; i++) { await sleep(3000); ub = (await usdtFree(W)); }
            if (ub < costWei) throw new Error('USDT 没到帐' + pbSwapHint());
          }
          await previewExec(W, USDT, '0x095ea7b3' + wa(c) + w(costWei), 0n, (sim) => ((sim?.allowanceChanges || []).some((a) => String(a.spender).toLowerCase() !== c) ? '授权对象不对' : ''));
          const pool = tokAddr ? Number(await poolOut(costWei, USDT, tokAddr)) : 0;
          const r = await revokeOnFail(W, USDT, c, () => previewExec(W, c, data, 0n, (sim) => {
            if (pool > 0 && gotTok(sim, W) < pool * 1.1) log(`注意：${c} 已开池，铸造没有比池子便宜`);
            const mine = (sim?.balanceChanges || []).filter((b) => String(b.owner).toLowerCase() === W.addr);
            const out = mine.filter((b) => Number(b.change) < 0); if (out.some((b) => String(b.contractAddress).toLowerCase() !== USDT) || out.reduce((a, b) => a - Number(b.change), 0) > Number(costWei) * pbF()) return '会扣到 USDT 以外或超过报价';
            if (!mine.some((b) => Number(b.change) > 0)) return '模拟没拿到代币'; return '';
          }, async () => { const q2 = await call(c, '0x725c4058' + w(n)); const c2 = q2 ? BigInt(q2.slice(0, 66)) : 0n; return driftWhy(c2, costWei); })); /* 送出前再查一次价格 */
          S.paidSpend[W.name] = spent + needBnb; P.done[W.name] = 'minted';
          const tku = tokAddr && !/^0x0{40}$/i.test(tokAddr) ? tokAddr : tokAddr0; if (!tku) trackFromSim(W, r.sim, sym, cu); if (tku && rcvOk(W, tku, c) && !addCostEx(W, tku, +cu.toFixed(2), '铸造')) /*RISK-FIX2-2*/ S.dyn.push({ sym, addr: tku.toLowerCase(), cost: +cu.toFixed(2), only: W.addr, deployer: P.deployer, boughtAt: Date.now() });
          addPaidUsd(W, cu);
          if (forced) forceTag(W); await tg(`🛒 [${W.name}] ${forced ? '手动强制打了' : '自动打了'}付费 Agent ID 项目：${sym}${grpTxt(c)}\n${n} 份，花 ${cu.toFixed(2)} USDT（由 BNB 换）· 已售 ${sold ?? '?'} 份 · 进度约 ${Math.round(progress * 100)}%\n${c}\n交易 ${r.tx}\n已加入监控：${ruleTxt()}`);
        }
      } catch (e) { if (forced) fsW(c, W, '没打成：' + String(e.message || e).slice(0, 160)); if (((__t2s) => __t2s.includes('结果不明') || __t2s.includes('結果不明'))(e.message)) { P.done[W.name] = 'unknown'; log(`paid ${c} ${W.name} ${e.message}`); await tg(`⚠️ [${W.name}] ${sym} 送出结果不明（逾时），为避免重打已停止，请到钱包确认有没有打到\n${c}`); return; } if (((__t2s) => __t2s.includes('已开池') || __t2s.includes('已開池'))(e.message)) { P.done[W.name] = 'pool-cheaper'; log(`paid ${c} ${W.name} ${e.message}`); return; } if (/[價价]格[剛刚][剛刚][漲涨]了/.test(e.message)) { log(`paid ${c} ${W.name} ${e.message}（下一轮再打）`); return; } P.failW = P.failW || {}; P.failW[W.name] = (P.failW[W.name] || 0) + 1; P.fail = (P.fail || 0) + 1; log(`paid ${c} ${W.name} ${e.message}`); const fN = nrOn('mint.failN.on') ? nrNum('mint.failN') : null; /* 失败几次放弃＝你的 mint.failN（没设＝一直重试） */ if (fN != null && kind === 'replay' && P.fail >= fN) { markUnmintable(c, P, sym, progress, '照别人的方式预演一直失败'); return; } if (fN != null && P.failW[W.name] >= fN) { P.done[W.name] = 'fail'; await tg(`⚠️ [${W.name}] 付费项目 ${sym} 自动打失败，已放弃：${e.message.slice(0, 150)}\n${c}`); } } finally { if (!forced) DAYRES[W.name] = Math.max(0, (DAYRES[W.name] || 0) - budU); }
    }));
    } finally { if (!DEC_CP.has(c) && P?.lastReason && !FORCE.has(c)) { try { nrDecSkip('bsc', c, P.name, String(P.lastReason).slice(0, 200)); } catch {} } /* 铸造保护挡下的（克隆、连续部署、可升级合约、读不到…）也写判断日志 */ { const cp = DEC_CP.get(c); if (cp) { DEC_CP.delete(c); const nw = Object.entries(cp.P.done || {}).filter(([k, v]) => cp.d0[k] !== v).map(([, v]) => v); const res = nw.includes('minted') ? 'bought' : nw.includes('unknown') ? 'unknown' : 'none'; try { nrDecRes('bsc', c, cp.P.name, res, res === 'none' ? (cp.P.lastReason || '这一轮没送出') : ''); } catch {} } } busyP.delete(c); const dt = Date.now() - tE; if (dt > 10e3) log(`检查 ${c} 花了 ${Math.round(dt / 1000)} 秒（${mode}）`); }
  }
}

async function loginCheck() {
  for (const W of WALLETS) {
    const r = await W.baw(['wallet', 'status'], 60000);
    if (r.j?.data?.status === 'CONNECTED') {
      // 开发者模式到期提醒（提前几小时＝你的 notify.devModeH）
      const st = await W.baw(['wallet', 'settings'], 60000); const exp = Date.parse(st.j?.data?.devMode?.expiresAt || '');
      S.devAlert = S.devAlert || {};
      if (exp && nrNum('notify.devModeH') != null && exp - Date.now() < nrNum('notify.devModeH') * 3600e3 && S.devAlert[W.name] !== exp) { S.devAlert[W.name] = exp; await tg(`⏰ ${W.name} 的开发者模式将在 ${new Date(exp).toLocaleString('zh-TW', { hour12: false, timeZone: CONFIG.timeZone || 'Asia/Taipei' })} 到期\n到期后自动铸造／自动卖出会停，请在那个帐号的币安 App → Agentic Wallet → 设定 重新开启开发者模式`); }
      if (st.j?.data?.devMode && st.j.data.devMode.enabled === false && S.devAlert[W.name + ':off'] !== 1) { S.devAlert[W.name + ':off'] = 1; await tg(`⚠️ ${W.name} 的开发者模式已关闭，自动操作会失败，请在 App 重新开启`); }
      if (st.j?.data?.devMode?.enabled) S.devAlert[W.name + ':off'] = 0;
      if (S.lastLoginAlert?.[W.name]) delete S.lastLoginAlert[W.name]; nClear('login:' + W.name); /* 重新连上了：下次再断才通知 */
      continue;
    }
    S.lastLoginAlert = S.lastLoginAlert && typeof S.lastLoginAlert === 'object' ? S.lastLoginAlert : {};
    { const L0 = S.lastLoginAlert[W.name]; const la = L0 && typeof L0 === 'object' ? L0 : { n: 0 }; if (!nOnce('login:' + W.name)) continue; S.lastLoginAlert[W.name] = { n: (la.n || 0) + 1, at: Date.now() }; } /* 同一次断开只提醒一次；你填了 notify.repeatMin 才会隔一段时间再提醒 */
    const si = await W.baw(['auth', 'signin'], 60000); const url = si.j?.data?.urlForWeb, code = si.j?.data?.pairingCode, id = si.j?.data?.qrCodeId; const expAt = Number(si.j?.data?.expireAt) || 0; const expM = expAt > Date.now() ? Math.ceil((expAt - Date.now()) / 60e3) : null;
    { const nn = S.lastLoginAlert[W.name].n; /*V102-LOGOUT1*/ await tg(`🔑 ${W.name} 的 AI 钱包登入断开了：这个钱包的自动买卖、铸造、自动卖出会暂停（其他钱包照常）。\n${url ? '要重新连上：用「' + W.name + '」那个币安帐号的手机点这个连结确认（' + (expM != null ? '约 ' + expM + ' 分钟内有效' : '有效时间很短，尽快') + '）：\n' + url + '\n配对码 ' + code + '\n或到雷达「设定 → 钱包」重新连接' : '要重新连上：到雷达「设定 → 钱包」重新连接（扫码登入）'}，连上后会自动恢复。\n\n（第 ${nn} 次提醒。如果是你自己故意断开的，不用理会。）`); }
    if (id) { const v = await W.baw(['auth', 'verify', '--qrCodeId', id], 330000); if (v.j?.data?.status === 'SUCCESS') await tg(`✅ ${W.name} 重新登入成功`); }
  }
}


const ELEMENT_EX = '0xb3e3dfcb2d9f3dde16d78b9e6eb3538eb32b5ae1';
const T_721_FILLED = '0x9c248aa1a265aa616f707b979d57f4529bb63a4fc34dc7fc61fdddc18410f74e'; // Element ERC721SellOrderFilled
function nftVolH() { return nrOn('notify.nftVol') && nrNum('notify.nftVolX') != null ? nrNum('notify.nftVolH') : null; } 
async function nftVolWatch() {
  S.nftCols = S.nftCols || {}; S.nftVol = S.nftVol || {};
  const vH = nftVolH(); if (vH == null) return; /* 没开／没填就不查 */
  const head = parseInt(await rpc('eth_blockNumber', []), 16), from = head - Math.ceil(vH * 3600 / BSC_BLK_S); // 你设的小时数换成区块数

  const fills = {};
  for (let b = from; b <= head; b += 10000) {
    const L = await rpc('eth_getLogs', [{ address: ELEMENT_EX, topics: [T_721_FILLED], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 9999, head).toString(16) }]).catch(() => []);
    for (const l of L || []) { const w = l.data.slice(2).match(/.{64}/g) || []; const col = '0x' + (w[7] || '').slice(24); if (!S.nftCols[col]) continue; const isBnb = (w[4] || '').endsWith('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'); const px = Number(BigInt('0x' + (w[5] || '0'))) / 1e18; (fills[col] = fills[col] || []).push(isBnb ? px : null); }
    await sleep(200);
  }

  for (const col of Object.keys(S.nftCols)) {
    let moves = 0;
    for (let b = from; b <= head; b += 50000) { const L = await rpc('eth_getLogs', [{ address: col, topics: [T_TRANSFER], fromBlock: '0x' + b.toString(16), toBlock: '0x' + Math.min(b + 49999, head).toString(16) }]).catch(() => []); for (const l of L || []) if (l.topics.length === 4 && !/^0x0+$/.test(l.topics[1])) moves++; }
    let held = 0; for (const W of WALLETS) { const r = await call(col, '0x70a08231' + wa(W.addr)); if (r && r.length >= 66) held += Number(BigInt(r.slice(0, 66))); }
    const f = fills[col] || [], prev = S.nftVol[col];
    const px = f.filter((x) => x != null), vol = px.reduce((a, b) => a + b, 0);
    const vx = nrOn('notify.nftVol') ? nrNum('notify.nftVolX') : null; const hot = vx != null && held > 0 && vol > 0 && px.length > 0 && prev && prev.f > 0 && prev.h === vH && px.length >= vx * prev.f; /* 没有上一次（或区间改过）＝没得比，不通知 */
    if (hot) {
      const name = tokStr(await call(col, '0x06fdde03')) || col.slice(0, 10);
      await tg(`🦋 NFT 成交量变多：${name}\n钱包共持有 ${held} 张\n过去 ${vH} 小时 Element 成交 ${f.length} 笔${prev ? '（上次 ' + (prev.f || 0) + ' 笔）' : ''}${px.length ? `，成交价 ${Math.min(...px).toFixed(4)}～${Math.max(...px).toFixed(4)} BNB，合计 ${vol.toFixed(4)} BNB` : ''}\n转手 ${moves} 次${prev ? '（上次 ' + (prev.t || 0) + ' 次）' : ''}\n${col}\nhttps://element.market/assets/bsc/${col}/1\n要挂单或卖手动处理`);
    }
    S.nftVol[col] = { f: f.length, t: moves, held, h: vH, at: ts() };
    await sleep(150);
  }
  log(`NFT 成交量检查完成：${Object.keys(S.nftCols).length} 个系列`);
}


// ── TG 指令：使用者直接在机器人打「卖 XXX」「卖 XXX 一半」「余额」，几秒内执行，不经过 Claude ──

const OFFI = createRequire(import.meta.url)('./repo.cjs'); /* 官方来源只写在 repo.cjs */
const UPD = { on: true, ver: '1.0.9', repo: OFFI.REPO, group: 't.me/nancy_c0813' }; /* 只提醒不自动更新；引导用户加入使用者的 TG 群 */
const verGt = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function updCheck(quiet = false) {
  if (!UPD.on) return null;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${UPD.repo}/main/version.json?t=${Date.now()}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return null;
    const v = await r.json(); const UF = join(DIR, 'data', 'update_avail.json'); if (!v.version || !verGt(v.version, UPD.ver)) { try { if (existsSync(UF)) unlinkSync(UF); } catch {} return null; } UPD.latest = v; /* 没有自动安装（就算官方标「重要」也只通知，你自己按才更新；签名照验） */ try { writeFileSync(UF, JSON.stringify({ version: String(v.version).slice(0, 20), cur: UPD.ver, notes: notesArr(v.notes).slice(0, 12).map((x) => String(x).slice(0, 200)), at: Date.now() })); } catch {} /* 没设 TG 的人也看得到 → 雷达画面右上角显示「有新版」 */
    if (!quiet && S.updNotified !== v.version && nrOn('update.notify')) { /* 只说有新版：这里读到的版本号、说明没有签名，不转发 */ /* 只提醒、不自动更新；TG 提醒＝你的开关 update.notify（预设关；雷达画面的新版提示照样有） */
      S.updNotified = v.version; save();
      const msg = '🔔 罗宾猫雷达有新版，按更新会先验签（在 TG 回「更新」，或在雷达按更新）';
      log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg);
    }
    return v;
  } catch { return null; }
}
/* 一键更新：下载 GitHub 上「官方签名过的清单」radar/official.json＋official.sig，用内建公钥验签（假的、被改过的一律拒绝），
   每个档案下载后比对清单里的 sha256；全部下载、校验、语法检查都过了才一次换上（换之前先备份）。都在用户自己电脑，不碰钱包 */
const OFFI_PUB = OFFI.PUBKEY; /* PUBKEY_PLACEHOLDER（还没设）→ 下面验签一定失败 → 拒绝更新 */
/* 一键更新的档名检查：要是正规写法（posix 正规化后一模一样）、不分大小写比对；不能碰 data/、.sign*、node_modules、.git、config.json；解析后一定要在雷达资料夹里面 */
function updPathBad(f) { f = String(f || ''); if (!/^[\w\-.\/一-龥]+$/.test(f) || f.includes('\\') || f.startsWith('/')) return true; const n = posix.normalize(f); if (n !== f || n.startsWith('../') || n === '..' || n.split('/').some((x) => x === '..' || x === '.' || x === '')) return true; const lo = n.toLowerCase(); const top = lo.split('/')[0]; if (['data', 'node_modules', '.git'].includes(top) || top.startsWith('.sign') || lo === 'config.json' || lo.endsWith('/config.json')) return true; const abs = resolve(DIR, n), root = resolve(DIR); return !(abs.startsWith(root + sep) && abs.length > root.length + 1); }
async function doUpdateAll(v) {
  const RAW = `https://raw.githubusercontent.com/${UPD.repo}/main/`;
  const get = async (f) => { const r = await fetch(RAW + f.split('/').map(encodeURIComponent).join('/') + '?t=' + Date.now(), { signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(f + ' ' + r.status); return Buffer.from(await r.arrayBuffer()); };
  let man, sig; try { man = await get('radar/official.json'); sig = Buffer.from((await get('radar/official.sig')).toString('utf8').trim(), 'base64'); } catch { return '⚠️ 下载新版清单失败，等一下再试'; }
  const { createPublicKey, verify } = await import('node:crypto');
  try { if (!verify(null, man, createPublicKey({ key: Buffer.from(OFFI_PUB, 'base64'), format: 'der', type: 'spki' }), sig)) return '⛔ 新版签名不对（不是官方发的），为了安全已拒绝更新'; } catch { return '⛔ 新版签名验证失败，已拒绝更新'; }
  let M; try { M = JSON.parse(man.toString('utf8')); } catch { return '⛔ 新版清单格式不对，已拒绝'; }
  { let seq0 = 0; try { seq0 = Number(JSON.parse(readFileSync(join(DIR, 'radar', 'official.json'), 'utf8')).seq) || 0; } catch {} if (!Number.isSafeInteger(M.seq) || !(M.seq > seq0)) return '⛔ 新版清单不比目前的新（可能是降级攻击），已拒绝'; if (!/^\d+(\.\d+){0,3}$/.test(String(M.version || ''))) return '⛔ 新版清单没有版本号，已拒绝'; } /* 防降级：签过的清单编号（seq）一定要比手上的大；版本号和说明只认签过的清单 */
  v = { version: String(M.version), notes: Array.isArray(M.notes) ? M.notes.map((x) => String(x).slice(0, 300)) : [], seq: M.seq };
  const want = []; for (const [f, h] of Object.entries(M.files || {})) { if (updPathBad(f)) return '⛔ 新版清单里有异常路径（' + String(f).slice(0, 60) + '），已拒绝'; let cur = ''; try { cur = createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex'); } catch {} if (cur !== h && LAUNCH_RE.test(f)) { try { if (createHash('sha256').update(readFileSync(join(DIR, f) + '.new')).digest('hex') === h) continue; } catch {} } /* 启动档新版已经在 .new 等着换 */ if (cur !== h) want.push([f, h]); }
  if (!want.length) return `目前已经是最新版`;
  const got = []; for (const [f, h] of want) { let b; try { b = await get(f); } catch { return `⚠️ 下载 ${f} 失败，等一下再试（还没改动任何档案）`; } if (createHash('sha256').update(b).digest('hex') !== h) return `⚠️ ${f} 校验不符（GitHub 刚更新、快取还没同步），稍后再试（还没改动任何档案）`; got.push([f, b]); }
  const tmpD = join(DIR, 'data', 'update_tmp'); mkdirSync(tmpD, { recursive: true });
  for (const [f, b] of got) if (/\.(mjs|cjs|js)$/.test(f)) { const t = join(tmpD, f.replace(/[\/]/g, '_')); writeFileSync(t, b); const bad = await new Promise((res) => execFile(process.execPath, ['--check', t], { windowsHide: true, timeout: 60000 }, (e, o, er) => res(e ? String(er || e.message) : ''))); try { unlinkSync(t); } catch {} if (bad) return `⛔ 新版 ${f} 语法检查没过，已取消（还没改动任何档案）`; }
  const bkName = 'update_backup_' + new Date().toISOString().slice(0, 16).replace(/[:T-]/g, ''); const bk = join(DIR, 'data', bkName); mkdirSync(bk, { recursive: true });
  
  if (!OFFI.PUB_OK) return '⛔ 官方签名公钥还没设定（repo.cjs 的 PUBKEY），为了安全不更新'; let mine = []; try { const OLD = JSON.parse(readFileSync(join(DIR, 'radar', 'official.json'), 'utf8')).files || {}; mine = got.map(([f]) => f).filter((f) => { if (!OLD[f] || (LAUNCH_RE.test(f) && existsSync(join(DIR, f) + '.new'))) return false; try { return createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex') !== OLD[f]; } catch { return false; } }); } catch {}
  for (const [f] of got) { const src = join(DIR, f); if (existsSync(src)) { mkdirSync(dirname(join(bk, f)), { recursive: true }); copyFileSync(src, join(bk, f)); } }
  const later = []; for (const [f, b] of got) { mkdirSync(dirname(join(DIR, f)), { recursive: true }); if (LAUNCH_RE.test(f)) { writeFileSync(join(DIR, f) + '.new', b); later.push(f); } else writeFileSync(join(DIR, f), b); } /* 启动档先存 .new，下次启动才换上 */ if (later.length) log('一键更新：这些启动档正在用，先存成 .new，下次启动时换上：' + later.join('、'));
  try { writeFileSync(join(DIR, 'data', 'update_pending.json'), JSON.stringify({ at: Date.now(), v: v.version, bk: bkName, files: got.map(([f]) => f) })); } catch {} /* 新版启动不正常 → 雷达提醒（不自动还原） */
  writeFileSync(join(DIR, 'radar', 'official.json'), man); writeFileSync(join(DIR, 'radar', 'official.sig'), sig.toString('base64')); try { writeFileSync(join(DIR, 'version.json'), JSON.stringify(v, null, 2)); } catch {} /* 本机版本号也要跟着更新，不然画面一直以为没更新 */
  const shell = got.some(([f]) => /^radar\/[^\/]+\.cjs$/.test(f)), ui = got.some(([f]) => f.startsWith('radar/'));
  if (shell || ui) writeFileSync(join(DIR, 'data', shell ? 'relaunch.req' : 'reload.req'), String(Date.now()));
  log(`一键更新：已换上 ${got.length} 个档案（v${v.version}），旧档备份在 data/${bkName}`);
  if (mine.length) { try { writeFileSync(join(DIR, 'data', 'my_changes.md'), `# 更新前你改过的档案（v${v.version}，${new Date().toLocaleString()}）\n\n更新时这些档案被换成官方新版，你原本改过的版本完整备份在 data/${bkName}/ 里：\n\n${mine.map((f) => `- ${f}  →  data/${bkName}/${f}`).join('\n')}\n\n## 把改动加回去\n把下面这段贴给你的 AI（Claude Code／Codex／Cursor）：\n\n> 罗宾猫雷达刚更新到 v${v.version}。请先读 AI说明书.md，再比对 data/${bkName}/ 里我改过的旧档和现在的新档，新版结构改了很多：请照新的 AI说明书 把「我自己加的功能」重新加一次（能做成外挂 plugins/*.mjs 就做成外挂；买卖功能一定要是开关＋我自己填的数字、预设关、没有偷偷的备用路径、接上逐条判断日志），官方新版的修正都要保留；不准碰私钥、不准转钱；改完执行 node --check 确认能跑，然后告诉我改了什么。\n`); } catch {} }
  return `✅ 已更新到 v${v.version}（${got.length} 个档案，设定都保留）。${shell ? '雷达会自动重开一次。' : ''}引擎会自动重启载入。${mine.length ? `\n\n✋ 你（或你的 AI）改过 ${mine.length} 个档案：${mine.slice(0, 5).join('、')}${mine.length > 5 ? ' 等' : ''}。改过的旧档都备份在 data/${bkName}，你之前用 AI 加的功能已经备份；新版结构改了很多，请让你的 AI 照新的《AI说明书》重新加一次（建议做成外挂）。打开 data/my_changes.md，把里面那段贴给你的 AI 就好。` : ''}`;
}
async function doUpdate() {
  if (!UPD.on) return '这个版本不自动更新';
  const v = UPD.latest && verGt(UPD.latest.version, UPD.ver) ? UPD.latest : await updCheck(true); if (!v) return `目前已经是最新版 v${UPD.ver}`;
  if (v.files) return await doUpdateAll(v); /* 一键更新 — 多档一起更新，验官方签名 */
  return '⚠️ 新版资料不完整（缺官方签名的档案清单），为了安全没有更新'; /* 只走「验官方签名」的一键更新 */
}
async function groupInvite() { if (!UPD.on || !nrOn('report.showGroup') || S.grpInvited === 1) return; S.grpInvited = 1; save(); const msg = `👋 欢迎使用罗宾猫雷达 v${UPD.ver}\n加入官方 TG 群，第一时间收到：\n• 工具更新通知\n• 打到什么项目、哪个开盘的即时播报\n• 使用教学与问题解答\n👉 ${UPD.group}`; log(msg.replace(/\n/g, ' | ')); console.log('\n' + '='.repeat(48) + '\n' + msg + '\n' + '='.repeat(48) + '\n'); await tgSay(msg); }
const UPD_STABLE_S = 600; /* 新版跑多久没出错才算稳定（秒；没到就重开会回到更新前的档案） */
async function tgSay(text) { text = toS(text); ordResNote(text); if (!TG) return; log('TG回复: ' + text.replace(/\n/g, ' | ')); for (let k = 0; k < 2; k++) { try { const j = await (await fetch(`${TG_API}/bot${TG.a}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TG.b, text: safeOut(text, 0), disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) })).json(); if (j?.ok) return true; if (j?.error_code === 429 && !k) { await sleep(Math.min(60, +(j.parameters?.retry_after || 1)) * 1000); continue; } log('TG 发送失败：' + String(j?.description || '').slice(0, 100)); return false; } catch { return false; } } return false; } /* 回传有没有送成功；被限流等一下再送一次 */
function findTok(q, W) {
  q = q.toLowerCase();
  const L = TOKENS.concat(S.dyn || []).filter((t) => (!t.only || t.only === W.addr) && (t.sym.toLowerCase() === q || t.addr === q)); /* 先找还没结束的；同名的不只一个 → 要你给地址 */
  const open = L.filter((t) => !t.closed); const pool = open.length ? open : L; if (pool.length > 1 && !/^0x[0-9a-f]{40}$/.test(q) && new Set(pool.map((t) => t.addr)).size > 1) return { amb: pool.map((t) => t.addr) }; return pool[0];
}
async function cmdSell(q, pc) { if (pc === true) pc = 50; else if (!(pc > 0)) pc = 100; const half = pc < 100; /* pc＝卖几 % */
  const head = parseInt(await rpc('eth_blockNumber', []), 16);
  const jobs = WALLETS.map(async (W) => {
    const t0 = findTok(q, W); if (!t0) return `[${W.name}] 找不到 ${q}`; if (t0.amb) return `[${W.name}] 有好几个叫 ${q} 的币，请用合约地址卖：\n${t0.amb.join('\n')}`;
    const pqM = ptxSeq(t0.addr); /*V101-5 读余额前记下*/ const bR = await call(t0.addr, '0x70a08231' + wa(W.addr)); if (bR == null || bR === '0x') return `[${W.name}] 读不到 ${t0.sym} 的余额，等一下再试`; const bal0 = big(bR); if (bal0 === 0n) return `[${W.name}] 没有 ${t0.sym}`;
    const bal = await plugNet(W, t0.addr, bal0); if (bal == null) return `[${W.name}] 读不到小数位数，没卖`; if (bal === 0n) return `[${W.name}] ${t0.sym} 都是外挂的部位，雷达不卖`; 
    const key = stKey(W, t0);
    const st = (S.tokens[key] = S.tokens[key] || { hist: [], peak: 0, peakAt: 0, sold: 0 }); PQ_READ.set(st, pqM); /*V101-5*/
    if (SELLING.has(W.name + '|' + t0.addr)) return `⏳ [${W.name}] ${t0.sym} 上一笔卖单还在送（等成交），这张先不卖，等一下再下`; /* 同一个币同时只卖一次 */
    const ok = await sell(t0, st, half ? (bal * BigInt(Math.round(pc * 100))) / 10000n : bal, half ? `你在 TG 指示卖 ${pc}%` : '你在 TG 指示全部卖出', W);
    if (ok === true && !half) { st.stage = 9; st.done = true; }
    return ok === 'pend' ? `⚠️ [${W.name}] ${t0.sym} 卖出结果不明（逾时，可能已成交），先不重复卖` : ok ? `✅ [${W.name}] ${t0.sym} 已卖出 ${pc}%` : `❌ [${W.name}] ${t0.sym} 卖出失败${globalThis.LAST_SELL_ERR ? '：' + sellWhy(globalThis.LAST_SELL_ERR) : ''}`;
  });
  const res = (await Promise.all(jobs)).filter(Boolean); save();
  await tgSay(`📋 卖 ${q}${half ? ' ' + pc + '%' : ''} 结果：\n` + (res.length ? res.join('\n') : '没有钱包有这个币')); /* 每个指令都回一则总结（成功的也列） */
  void head;
}
async function cmdBalance() {
  const lines = await Promise.all(WALLETS.map(async (W) => { const b = Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18; return `${W.name}：${b.toFixed(5)} BNB`; }));
  await tgSay('💼 钱包余额\n' + lines.join('\n'));
}
async function cmdHold() {
  const out = [];
  for (const W of WALLETS) for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr))); if (bal === 0n) continue;
    const v = await valueUsd(t0, bal).catch(() => null); const line = `[${W.name}] ${t0.sym}：${v == null ? '还没有池子' : '约 ' + v.toFixed(2) + 'U'}`;
    if (!out.includes(line)) out.push(line);
  }
  await tgSay('📦 还没卖的币\n' + (out.length ? out.join('\n') : '没有') + '\n（NFT 不在这里，NFT 成交量变多会另外通知）');
}
async function holdReport(title = '📦 持仓总结') { /* 持仓总结：成本、现值、倍数、状态；几点发＝你的 report.holdHours */
  const rows = [], noPool = [], dust = []; let tc = 0, tv = 0; /* 断开的钱包也被列出来 → 标注「已断开」；同一个合约不重复算；同名不同合约加地址尾码 */
  const L = (W) => String.fromCharCode(65 + Math.max(0, WALLETS.indexOf(W))); const symN = {}; for (const t of TOKENS.concat(S.dyn || [])) { const k = String(t.sym || ''); (symN[k] = symN[k] || new Set()).add(String(t.addr || '').toLowerCase()); }
  const nm = (t) => (symN[t.sym]?.size > 1 ? `${t.sym}(${String(t.addr).slice(-4)})` : t.sym);
  for (const W of WALLETS) { const seenA = new Set(); for (const t0 of TOKENS.concat(S.dyn || [])) {
    if (t0.only && t0.only !== W.addr) continue;
    if (t0.closed) continue; /*AMT-7*/
    const ta = String(t0.addr || '').toLowerCase(); if (seenA.has(ta)) continue; seenA.add(ta);
    const bal = big(await call(t0.addr, '0x70a08231' + wa(W.addr)).catch(() => null)); if (!(bal > 0n)) continue;
    const v = await valueUsd(t0, bal).catch(() => null); const wn = L(W) + (W.off ? '・已断开' : '');
    if (v == null) { if (!noPool.includes(nm(t0))) noPool.push(nm(t0)); continue; }
    if (ZR_MINV() > 0 && v < ZR_MINV()) { if (!dust.includes(nm(t0))) dust.push(nm(t0)); continue; } 
    const st = (S.tokens || {})[stKey(W, t0)] || {}; /*AMT-9 跟持仓检查同一个记录*/ const cost0 = (t0.only || t0.both || W.addr === ME) ? (Number(t0.cost) || 0) : 0; const dqR = await tokDec(t0.addr).catch(() => null); const cost = costRem(cost0, st, dqR != null ? Number(bal) / 10 ** dqR : null); const x = st.ap > 0 && dqR != null && Number(bal) > 0 ? (v / (Number(bal) / 10 ** dqR)) / st.ap : cost > 0 ? v / cost : 0; /*AMT-3 倍数＝现价÷平均买入价（旧资料没有平均价才用 现值÷剩下的成本）*/
    const status = t0.costUnk ? '成本未知（读到 BNB 价格才补上，先不自动卖）' : t0.hold ? '只通知' : t0.custom ? '特殊规则' : (st.done2 || []).includes('back') ? (st.moon ? `已回本，含 ${RULE.moonPct}% 长抱` : '已回本，照策略持有') : cost > 0 ? '照策略持有' : '免费币';
    tc += cost; tv += v; rows.push({ v, line: `${nm(t0)}（钱包${wn}）${cost > 0 ? `成本 ${cost.toFixed(1)}U → ` : ''}约 ${v.toFixed(2)}U${x ? `（${x.toFixed(2)} 倍）` : ''} · ${status}` });
  } }
  rows.sort((a, b) => b.v - a.v);
  const offW = WALLETS.filter((W) => W.off); const msg = `${title}（${WALLETS.map((W) => `钱包${L(W)}＝${W.name}${W.off ? '（已断开）' : ''}`).join('、')}）\n${rows.length ? rows.map((r) => '· ' + r.line).join('\n') : '目前没有有价格的持仓'}\n\n有价格的合计：约 ${tv.toFixed(2)}U${tc ? `（这些持仓剩下部分的成本合计 ${tc.toFixed(1)}U）` : ''}${noPool.length ? `\n还没开池（${noPool.length} 个）：${noPool.join('、')}` : ''}${dust.length ? `\n不到 ${ZR_MINV()}U 的零头（你设的最小卖出金额）：${dust.join('、')}` : ''}${offW.length ? `\n\n（${offW.map((W) => W.name).join('、')} 已断开：钱包地址是公开的，雷达还是能从链上读到余额，但不能帮它买卖；重新连接后才会照策略卖）` : ''}`;
  await tgSay(msg);
}
setInterval(() => { const d0 = new Date(), h = d0.getHours(), k = d0.toDateString() + '-' + h; const hs = nrStr('report.holdHours').split(/[,，\s]+/).filter((x) => x !== '').map(Number); if (hs.includes(h) && S.holdRepAt !== k) { S.holdRepAt = k; save(); holdReport().catch((e) => log('holdReport ' + e.message)); } }, 60e3).unref();
async function cmdStats() {
  // 免费项目：所有「已自动铸造」的记录都算（含一发现就马上打的），用合约地址去重；「现在开了」那种用名称对回合约；扣掉早上 0 BNB bug 的假铸造
  const free = new Set(), bog = new Set(), paidC = new Set(); let paid = 0; const n2a = {};
  try {
    const lines = logTail().split('\n');
    for (const l of lines) { const m = l.match(/(?:[專专][屬属]合[約约]|[項项]目)：([^|（(\n]+?)\s*(?:（[^|]*）)?\s*\|\s*(0x[a-fA-F0-9]{40})/); if (m && !n2a[m[1].trim().toLowerCase()]) n2a[m[1].trim().toLowerCase()] = m[2].toLowerCase(); }
    for (const l of lines) {
      if (l.includes('🛒')) { paid++; const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) paidC.add(c[1].toLowerCase()); }
      if (!((__t2s) => __t2s.includes('已自动铸造') || __t2s.includes('已自動鑄造'))(l)) continue;
      const nm = l.match(/[項项]目\s*([^\n（(|]+?)\s*[現现]在[開开]了/); let key = '';
      if (nm) key = n2a[nm[1].trim().toLowerCase()] || 'N:' + nm[1].trim().toLowerCase();
      else { const c = l.match(/(?<![0-9a-fA-Fx])(0x[a-fA-F0-9]{40})(?![0-9a-fA-F])/); if (c) key = c[1].toLowerCase(); }
      if (!key) continue;
      (/重播0x(（| \||$)/.test(l) ? bog : free).add(key);
    }
    for (const k of bog) free.delete(k);
  } catch {}
  const tr = S.trades || [], by = {};
  for (const x of tr) { const k = x.sym; by[k] = by[k] || { usd: 0, n: 0 }; by[k].usd += x.usd; by[k].n++; }
  const px = await bnbUsd().catch(() => 0); let tot = 0; for (const W of WALLETS) tot += Number(BigInt(await rpc('eth_getBalance', [W.addr, 'latest']))) / 1e18;
  const lines = Object.entries(by).map(([k, v]) => `${k}：卖 ${v.n} 笔，拿回约 ${v.usd.toFixed(2)}U`);
  await tgSay(`📊 战绩\n自动打的免费项目：${free.size} 个\n付费打的：${paidC.size} 个项目（${paid} 笔）\n${lines.length ? '有记录的卖出：\n' + lines.join('\n') + '\n' : ''}钱包现在共 ${tot.toFixed(4)} BNB（约 ${(tot * px).toFixed(2)}U）`);
}
/* 手机下单：拒绝手机按的「授权确认」；买入／铸造要在你填的手机每日额度 phone.dayUsd 内（空白＝手机不能买）；换算不到美元＝不买 */
const PHONE_BUY = new Set(['buy', 'mint', 'nftmint', 'shareMint']);
async function phoneGate(o) {
  if (o.ackAppr === true || o.ackAppr === 1) return '手机不能确认「授权」类的单（授权后对方可以转走你的代币），请在电脑雷达上操作';
  const isBuy = PHONE_BUY.has(o.type) || (o.type === 'mintpick' && o.op === 'send'); if (!isBuy) return '';
  const cap = nrNum('phone.dayUsd'); if (cap == null) return '手机买入／铸造没开：要先在电脑雷达「设定」填「手机每天最多花多少 U」（phone.dayUsd）';
  let usd = null; const bnb = Number(o.bnb) > 0 ? Number(o.bnb) : Number(o.maxBnb) > 0 ? Number(o.maxBnb) : /^(\d+|0x[0-9a-fA-F]+)$/.test(String(o.value || '')) && BigInt(o.value) > 0n ? Number(BigInt(o.value)) / 1e18 : 0; const freeMp = o.type === 'mintpick' && /^(0|0x0*)$/.test(String(o.value ?? '')); /* 不付钱的铸造（只花手续费）算 0U */
  if (Number(o.usd) > 0) usd = Number(o.usd); else if (bnb > 0) { const px = await bnbUsd().catch(() => 0); if (px > 0) usd = bnb * px; } else if (Number(o.eth) > 0) { const px = await (globalThis.RH_ETHUSD?.() || 0); if (px > 0) usd = Number(o.eth) * px; }
  if (freeMp) usd = 0; else if (!(usd > 0)) return '读不到这张单要花多少 U（金额或价格读不到），手机下单没执行';
  const day = new Date().toDateString(); S.phoneDay = S.phoneDay?.d === day ? S.phoneDay : { d: day, u: 0 };
  if (S.phoneDay.u + usd > cap) return `超过你设的手机每日额度（今天已用 ${S.phoneDay.u.toFixed(2)}U，这张约 ${usd.toFixed(2)}U，上限 ${cap}U），没执行`;
  (phoneGate.pend ||= new Map()).set(String(o.id || ''), usd); return ''; /* RVFIX E3：这里只检查；真的送出（成功或结果不明）才扣额度（phoneSpent），被挡／需要确认／失败不扣，确认后重送同一张单也不会扣两次 */
}
/* phoneGate.pend：单号 → 这张单的金额（phoneGate 放行后、结果出来前） */
function phoneSpent(id, text) { const t = String(text || ''); if (/中…$|中\.\.\.$/.test(t.trim())) return; /* 「预演中…」这种还没结果的不算 */ const PP = phoneGate.pend || new Map(); const usd = PP.get(String(id || '')); PP.delete(String(id || '')); if (!(usd > 0)) return; if (!(/^✅/m.test(t) || /结果不明|可能已成交|可能已经成交|逾时|結果不明/.test(t) || /^🛒/m.test(t))) return; /* 没买成不扣 */ const day = new Date().toDateString(); S.phoneDay = S.phoneDay?.d === day ? S.phoneDay : { d: day, u: 0 }; S.phoneDay.u = +(S.phoneDay.u + usd).toFixed(4); save(); log(`📱 手机额度：这张单算 ${usd.toFixed(2)}U，今天已用 ${S.phoneDay.u.toFixed(2)}U`); }
let TG_SKEW = 0, TG_ERR = null; const TG_OLD_S = 120, TG_ERR_WAIT_MS = 15e3; /* 运作：多旧的指令不执行（秒，全停除外）／TG 出错后等多久再问 */
const TG_OWNER = String(CONFIG.telegram?.ownerId || ''); /* 可选：你的 TG 使用者编号（指令从群里下时才需要） */
function tgMine(m) { if (!m || String(m.chat?.id) !== String(TG.b)) return false; if (m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date || m.via_bot) return false; if (m.chat?.type === 'private') return true; if (TG_OWNER && String(m.from?.id) === TG_OWNER) return true; if (!TG_NOTE) { TG_NOTE = 1; log('TG：指令只收你跟机器人的私讯；你设定的是群组，群里的指令不执行（要在群里下指令，请在 config.json 的 telegram.ownerId 填你自己的 TG 使用者编号）'); } return false; } let TG_NOTE = 0; 
/* 手机改设定的 TG 撤销：每次修改给一个代码（跟确认码同一套），回「撤销 代码」就把这次改的项目改回去；之后又被改过的项目不动、会说明 */
const PH_UNDO = new Map(); const PH_UNDO_TTL = 24 * 3600e3, PH_UNDO_MAX = 20; /* 运作：撤销多久内有效／最多记几次 */ const PH_UNDO_DENY = /^(estop|phone\.|plug\.|invite|bind|wallet)/; /* 手机本来就改不到的不还原 */
function phUndoAdd(prev, apply, text) { if (!prev || !apply || typeof prev !== 'object' || typeof apply !== 'object') return ''; const now = Date.now(); for (const [k, v] of PH_UNDO) if (now - v.at > PH_UNDO_TTL) PH_UNDO.delete(k); while (PH_UNDO.size >= PH_UNDO_MAX) PH_UNDO.delete(PH_UNDO.keys().next().value); let code; do { code = String(Math.floor(Math.random() * 9000) + 1000); } while (PH_UNDO.has(code) || TG_CONFIRM.has(code)); PH_UNDO.set(code, { prev, apply, text: String(text || '').slice(0, 300), at: now }); return code; }
function phUndoRun(code) { const U = PH_UNDO.get(code); if (!U || Date.now() - U.at > PH_UNDO_TTL) { PH_UNDO.delete(code); return '没有这个撤销代码（或已经超过 ' + PH_UNDO_TTL / 3600e3 + ' 小时），没改'; } const sf = join(DIR, 'data', 'radar_settings.json'); let z; try { z = JSON.parse(readFileSync(sf, 'utf8')); } catch { return '读不到设定档，没改（请到电脑雷达自己改回来）'; } if (!z || typeof z !== 'object') return '设定档格式不对，没改';
  let okK = null; try { const a = JSON.parse(readFileSync(join(DIR, 'data', 'phone_edit_keys.json'), 'utf8')); if (Array.isArray(a)) okK = new Set(a.map(String)); } catch {} /* FR-1104：手机白名单（主程式 phEditList 写的）；读不到＝一个都不还原 */
  const done = [], skip = []; for (const [k, v] of Object.entries(U.prev)) { if (PH_UNDO_DENY.test(k) || !okK || !okK.has(k)) { skip.push(k + '（手机改不到的项目）'); continue; } if (JSON.stringify(z[k] ?? null) !== JSON.stringify(U.apply[k] ?? null)) { skip.push(k + '（之后又被改过）'); continue; } if (v === null) delete z[k]; else z[k] = v; done.push(k); }
  if (done.length) { try { copyFileSync(sf, sf + '.bak'); } catch {} try { writeFileSync(sf + '.tmp' + process.pid, JSON.stringify(z, null, 1)); renameSync(sf + '.tmp' + process.pid, sf); RADAR.at = 0; } catch (e) { return '写回设定档失败，没改：' + String(e.message).slice(0, 80); } }
  PH_UNDO.delete(code); try { appendFileSync(join(DIR, 'data', 'phone_settings.jsonl'), JSON.stringify({ at: Date.now(), by: 'tg-undo', code, done, skip }) + '\n'); } catch {} log(`TG 撤销手机修改 ${code}：还原 ${done.join('、') || '（没有）'}${skip.length ? '；没动 ' + skip.join('、') : ''}`);
  return `↩️ 已撤销手机的这次修改（${U.text.slice(0, 120)}）\n改回去的：${done.length ? done.join('、') : '没有'}${skip.length ? '\n没动的：' + skip.join('、') : ''}\n电脑雷达设定会自动更新`; }
const TG_CONFIRM = new Map(); const TG_CONFIRM_MS = 60e3; /* 等你确认的动作：每个都有自己的代码（「确认 代码」）；已经有一个在等时不收新的，先处理前一个 */
function tgAsk(item) { const now = Date.now(); for (const [k, v] of TG_CONFIRM) if (now - v.at > TG_CONFIRM_MS) TG_CONFIRM.delete(k); const cur = [...TG_CONFIRM.entries()][0]; if (cur) return { busy: cur[0] }; let code; do { code = String(Math.floor(Math.random() * 9000) + 1000); } while (TG_CONFIRM.has(code)); TG_CONFIRM.set(code, { ...item, at: now }); return { code }; } /* TG 要你回「确认」的动作，过一段时间就失效 */
async function tgCmdLoop() {
  if (!TG) return;
  if (S.tgOff == null) { try { const r = await (await fetch(`${TG_API}/bot${TG.a}/getUpdates?timeout=0`)).json(); const u = r.result || []; S.tgOff = u.length ? u[u.length - 1].update_id + 1 : 0; save(); } catch { S.tgOff = 0; } }
  for (;;) {
    try {
      const resp = await fetch(`${TG_API}/bot${TG.a}/getUpdates?timeout=25&offset=${S.tgOff}&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'edited_message']))}`, { signal: AbortSignal.timeout(35000) }); const r = await resp.json();
      { const sd = Date.parse(resp.headers.get('date') || ''); if (Number.isFinite(sd)) TG_SKEW = sd - Date.now(); } /* 用 Telegram 伺服器的时间校正（电脑时钟不准也不会误判太旧） */
      if (r.ok === false) { const code = r.error_code, ra = +(r.parameters?.retry_after || 0); const why = code === 409 ? '同一个机器人 token 有另一个程式在收讯息（两个雷达或别的 bot 程式在用同一个 token）' : code === 401 ? '机器人 token 无效（被撤销或打错）' : String(r.description || '').slice(0, 120); if (TG_ERR !== code) { TG_ERR = code; log('TG 收不到指令：' + why + ((code === 401 || code === 409) ? '。如果 token 可能外流，请到 @BotFather 用 /revoke 换新的 token，再到雷达设定填新的' : '')); } try { writeFileSync(join(DIR, 'data', 'tg_status.json'), JSON.stringify({ at: Date.now(), ok: false, code, why })); } catch {} await sleep(Math.max(ra * 1000, TG_ERR_WAIT_MS)); continue; } /* 出错不要一直狂问 */
      if (TG_ERR !== null) { TG_ERR = null; log('TG 指令恢复正常'); try { writeFileSync(join(DIR, 'data', 'tg_status.json'), JSON.stringify({ at: Date.now(), ok: true })); } catch {} }
      const tgNow = () => (Date.now() + TG_SKEW) / 1000;
      { const ES_RE = /^(暫停|暂停|全停|紧急全停|緊急全停|pause|stop)$/i; if ((r.result || []).some((u) => u.message && tgMine(u.message) && ES_RE.test(String(u.message.text || '').trim().replace(/^\//, '')))) estopSet('TG'); } /* 全停不看多旧，一律执行 */ /* 同一批里有「全停」→ 先停，再处理排在前面的买单（买单会被全停挡下） */
      for (const u of r.result || []) {
        S.tgOff = u.update_id + 1; save();
        if (u.edited_message) { if (tgMine(u.edited_message) && u.edited_message.text) await tgSay('编辑过的指令不会执行，请重新发送一则新的讯息'); continue; } 
        const m = u.message; if (!m || !tgMine(m) || !m.text) continue; // 只听使用者本人（T5：私讯、不是转发、不是透过别的 bot）
        const txt = m.text.trim().replace(/^\//, '');
        if (tgNow() - m.date > TG_OLD_S && !/^(暫停|暂停|全停|紧急全停|緊急全停|pause|stop)$/i.test(txt)) { await tgSay(`这则指令是 ${Math.round((tgNow() - m.date) / 60)} 分钟前发的（雷达刚才没在线），为了安全没执行：「${txt.slice(0, 40)}」。要的话请重新发一次`); continue; } // 太旧的指令不执行（全停除外）
        let mm;
        if (LOCKED() && /^(?:\/?(?:打|buy)\s|賣|卖|sell|\S+\s*(?:全出|全賣|全卖|出一半|賣一半|卖一半)$)/i.test(txt)) { await tgSay('🔒 还没完成邀请码绑定：现在只能看，不能买卖'); }
        else if ((mm = txt.match(/^(?:賣|卖|sell)\s*(\S+?)(一半|half|\d+(?:\.\d+)?%)$/i)) /* RVFIX E7：「卖ABC一半」「卖ABC25%」没空格也认得（先试这个，不然币名会把「一半」吃掉） */ || (mm = txt.match(/^(?:賣|卖|sell)\s*(\S+)(?:\s+(一半|半|half|\d+(?:\.\d+)?\s*%))?$/i)) || (mm = txt.match(/^(\S+?)\s*(?:全出|全賣|全卖)$/i))) { /* 比例前面要空格（币名本身可能有「半」字）；支援「卖 币名 百分比」 */
          const pc = !mm[2] ? 100 : /%/.test(mm[2]) ? Number(mm[2].replace(/[%\s]/g, '')) : 50; if (!(pc > 0 && pc <= 100)) { await tgSay('比例要介于 0～100%，没卖'); } else { await tgSay(`⚡ 收到，${mm[1]} 所有钱包${pc === 100 ? '全部卖出' : `各卖 ${pc}%`}中…`);
          cmdSell(mm[1], pc).catch((e) => tgSay('⚠️ 卖出出错：' + e.message)); }
        } else if ((mm = txt.match(/^(\S+?)\s*(?:出一半|賣一半|卖一半)$/i))) {
          await tgSay(`⚡ 收到，${mm[1]} 所有钱包各卖一半中…`); cmdSell(mm[1], 50).catch((e) => tgSay('⚠️ 卖出出错：' + e.message));
        } else if (/^(确认新金钥|確認新金鑰)$/.test(txt)) { const G = guardLoad(); if (G.newPub) { S.guardPub = G.newPub; S.guardPubBy = 'tg'; S.guardPubAt = Date.now(); save(); try { if (typeof gateLog === 'function') gateLog({ w: '', cmd: 'guardKey', kind: 'TG 确认', from: 'tg', target: G.newPub, ok: 1, why: 'TG 回「确认新金钥」', checks: [['TG 确认', 1]] }); } catch {} GUARD.mt = -1; RADAR.at = 0; await tgSay('✅ 已改用新的守护金钥。之前被当作关闭的设定，请在电脑雷达画面重新打开（会跳视窗确认）'); } else await tgSay('守护金钥没有变，不用确认'); } /* GATE-2 */
        else if (/^(餘額|余额|錢包|钱包|balance)$/i.test(txt)) { cmdBalance().catch(() => {}); }
        else if (/^(持倉|持仓|holdings?)$/i.test(txt)) { holdReport('📦 持仓').catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^(暫停|暂停|全停|紧急全停|緊急全停|pause|stop)$/i.test(txt)) { const okE = estopSet('TG'); await tgSay(okE ? estopMsg('TG') : '⚠️ 全停没有写进去（设定档写不进去，可能被别的程式占用或磁碟满了）。请马上在电脑雷达按「🛑 紧急全停」，或关掉雷达。'); } /* 照实际有没有生效回复 */
        else if (/^(恢復|恢复|resume)$/i.test(txt)) { if (ESTOP()) await tgSay('🛑 雷达现在是紧急全停。为了安全，TG 不能直接恢复，请在电脑雷达右上角按「重新设定」，一项一项确认要打开的功能。'); else { const pf = join(DIR, 'data', 'pause_buy.txt'); let had = false; try { if (existsSync(pf)) { unlinkSync(pf); had = true; } } catch {} await tgSay(had ? '▶ 已解除「自动买暂停」（保险丝或暂停造成的），自动买照你的策略开关继续。要开关个别策略请到电脑雷达「🎯 自订策略」。' : '▶ 雷达没有紧急全停，也没有暂停。要开关个别策略请到电脑雷达「🎯 自订策略」。'); } } 
        else if (/^\/?(?:打|buy)(\s|$)/i.test(txt)) { const m = txt.match(/^\/?(?:打|buy)\s+(0x[0-9a-fA-F]{40})(?:\s+(\d+(?:\.\d+)?)\s*(?:u|U|usdt|USDT)?)?$/i); /* 整句要完全符合格式 */ if (!m) { await tgSay('格式不对，没买。请打：打 合约地址 金额\n例如：打 0x1234…abcd 10（10U；不写金额＝用你设的预设金额）'); } else { const ca = m[1].toLowerCase(); const [cb, cr] = await Promise.all([rpc('eth_getCode', [ca, 'latest']).catch(() => null), cseRpc('robinhood', 'eth_getCode', [ca, 'latest']).catch(() => null)]); const onB = !!cb && cb !== '0x', onR = !!cr && cr !== '0x'; /* TG 买入只走 BNB Chain，Robinhood 的合约不要被当成 BSC 买 */ if (cb == null) { await tgSay('⚠️ 读不到这个合约（节点没回应），没买，等一下再试'); } else if (!onB && onR) { await tgSay('⚠️ 这是 Robinhood 链的合约，TG 指令只能买 BNB Chain 的币。Robinhood 的请在雷达「Robinhood」看盘里买。'); } else if (onB && onR) { await tgSay('⚠️ 这个地址在 BNB Chain 和 Robinhood 都有合约，为了避免买错链，TG 指令不执行。请在雷达里选好链再买。'); } else if (!onB) { await tgSay('⚠️ 这个地址在 BNB Chain 上不是合约（可能打错了、或是钱包地址），没买'); } else { const usd = m[2] ? Number(m[2]) : 0; const W0 = WALLETS.find((x) => !x.off) || WALLETS[0]; const dU = NR.num('manual.defUsd'); await tgSay(`⚡ 收到，用 [${W0?.name || '?'}] 买 ${usd > 0 ? usd + 'U' : dU != null ? dU + 'U（你设的预设金额）' : '（没写金额、也没设预设金额 → 不会买）'}，下单中…`); tgBuy(ca, usd /* 没写金额＝照你的 manual.defUsd，没开就不买 */).catch((e) => '⚠️ 下单出错：' + e.message).then((r) => { if (/^⚠️需要确认：/.test(String(r))) { const q = tgAsk({ k: 'buy', ca, usd }); r = String(r) + (q.code ? `\n\n要照买的话 60 秒内回「确认 ${q.code}」；不回就不买` : `\n\n还有一个等你确认的动作（代码 ${q.busy}），这张没排进去：先回「确认 ${q.busy}」或「取消 ${q.busy}」，再重新下单`); } return tgSay(r); }).catch(() => {}); } } } /* 不等买完，TG 的「全停」马上读得到；T9／T10 */
        else if (/^(取消授权|取消授權|revoke)$/i.test(txt)) { const A0 = S.lastAppr; if (!A0?.L?.length) await tgSay('没有雷达最近送出的授权记录。要取消别的授权请到雷达「钱包健检」'); else { const q = tgAsk({ k: 'revoke' }); if (!q.code) await tgSay(`还有一个等你确认的动作（代码 ${q.busy}），先回「确认 ${q.busy}」或「取消 ${q.busy}」再来取消授权`); else await tgSay(`要取消 [${A0.name}] 最近一次授权吗？\n${A0.L.map((x) => `代币 ${x.tk} → 对方 ${x.sp}`).join('\n')}\n取消授权不会转钱，只是拿掉对方的权限（要付一点手续费）。\n60 秒内回「确认 ${q.code}」才会执行`); } } 
        else if ((mm = txt.match(/^(?:确认|確認|confirm)\s*(\d{4})?$/i))) { const code = mm[1] || ''; const C0 = code ? TG_CONFIRM.get(code) : null; if (C0) TG_CONFIRM.delete(code); if (!code) await tgSay(TG_CONFIRM.size ? `请连代码一起回：「确认 ${[...TG_CONFIRM.keys()][0]}」` : '没有等你确认的动作'); else if (!C0 || Date.now() - C0.at > TG_CONFIRM_MS) await tgSay('没有这个代码的确认（或已经超过 60 秒），没执行'); else if (C0.k === 'revoke') { const A0 = S.lastAppr; const W = WALLETS.find((x) => x.addr === A0?.w); if (!W) await tgSay('那个钱包已经不在雷达里了，没执行'); else { const out = []; for (const x of A0.L) { const r0 = await W.baw(['approvals', 'revoke', '--binanceChainId', '56', '--tokenContract', x.tk, '--spender', x.sp, '--type', 'approve']); out.push(`${x.tk.slice(0, 8)}… → ${x.sp.slice(0, 8)}…：${r0.j?.success ? '✅ 已取消' : r0.timeout ? '⚠️ 结果不明（逾时），请到钱包健检确认' : '❌ ' + String(r0.j?.error?.message || r0.t).slice(0, 80)}`); } if (out.every((l) => l.includes('✅'))) { delete S.lastAppr; save(); } await tgSay(`[${W.name}] 取消授权：\n` + out.join('\n')); } } else if (C0.k === 'buy') { tgSay('⚡ 收到确认，下单中…').catch(() => {}); ACK.run({ ack: true }, () => tgBuy(C0.ca, C0.usd)).catch((e) => '⚠️ 下单出错：' + e.message).then((r) => tgSay(r)).catch(() => {}); } } 
        else if ((mm = txt.match(/^(?:取消|cancel)\s*(\d{4})$/i))) { await tgSay(TG_CONFIRM.delete(mm[1]) ? `已取消（代码 ${mm[1]}），没执行` : '没有这个代码的确认'); } /* 代码确认 */
        else if ((mm = txt.match(/^(?:撤销|撤銷|undo)\s*(\d{4})$/i))) { await tgSay(phUndoRun(mm[1])); } /* 手机改设定的撤销（只收本人私聊，tgMine 已经挡过） */
        else if (/^(戰績|战绩|統計|统计|stats?)$/i.test(txt)) { cmdStats().catch((e) => tgSay('⚠️ ' + e.message)); }
        else if (/^\/?(version|版本)$/i.test(txt)) { (async () => { const lv = await updCheck(true).catch(() => null); await tgSay(`罗宾猫雷达 v${UPD.ver}${UPD.on ? (lv ? '\n有新版，回「更新」会先验签再更新' : '\n已经是最新版') : ''}`); })().catch(() => {}); } /* 不等，全停照样马上处理 */ /* 用户不知道自己是哪一版 → TG 回「版本」就告诉他 */
        else if (/^(update|更新)$/i.test(txt)) { if (!UPD.on) await tgSay('这个版本不自动更新'); else { await tgSay('⚡ 收到，下载新版并安检中…'); doUpdate().catch((e) => '⚠️ 更新出错：' + e.message).then((x) => tgSay(x)).catch(() => {}); } } 
        else if (/^(help|指令|說明|说明)$/i.test(txt)) await tgSay('可用指令：\n卖 XXX → 所有钱包全卖\n卖 XXX 一半 → 各卖一半\n卖 XXX 25% → 各卖 25%\n打 合约 金额 → 买（BNB Chain）\n全停 → 紧急全停\n取消授权 → 取消雷达最近一次授权\n（也可打「XXX 全出」「XXX 出一半」）\n余额 → 看各钱包 BNB\n持仓 → 还没卖的币和现值\n战绩 → 上线以来打了多少、卖了多少');
        else await tgSay('看不懂这个指令，没执行。回「指令」看可以用的指令'); /* 认不得的都回复 */
      }
    } catch { await sleep(3000); }
  }
}

let TGQ_BUSY = false; async function tgQDrain() { if (TGQ_BUSY) return; const qf = join(DIR, 'data', 'tg_q.json'); if (!existsSync(qf)) return; TGQ_BUSY = true; try { const wf = qf + '.sending'; let q = []; if (existsSync(wf)) { try { q = JSON.parse(readFileSync(wf, 'utf8')); } catch {} } else { try { renameSync(qf, wf); } catch { return; } try { q = JSON.parse(readFileSync(wf, 'utf8')); } catch {} } /* 先换名再读：雷达同时写进来的新提醒会写到新的 tg_q.json，不会被盖掉 */ q = (Array.isArray(q) ? q : []).filter(Boolean); let i = 0; for (; i < q.length; i++) { const m = q[i]; const ago = +m.at > 0 ? Math.floor((Date.now() - m.at) / 60e3) : 0; const ok = await tgSay((ago > 0 ? `（${ago} 分钟前的提醒）\n` : '') + String(m.text || '').slice(0, TG_MAXLEN)).catch(() => false); if (!ok && TG) break; if (i % TGQ_SAVE_EVERY === 0) { try { writeFileSync(wf, JSON.stringify(q.slice(i + 1))); } catch {} } await sleep(TGQ_GAP_MS); } if (i >= q.length) { try { unlinkSync(wf); } catch {} } else { try { writeFileSync(wf, JSON.stringify(q.slice(i))); } catch {} } } finally { TGQ_BUSY = false; } } const TGQ_GAP_MS = 1100, TGQ_SAVE_EVERY = 5; /* 运作：TG 每则间隔（限流）、每送几则记一次进度 */
const TG_MAXLEN = 3500; /* 单则字数（TG 上限 4096） */ const WD_MIN = 8, WD_MIN_TX = 11; /* 看门狗：主回圈多久没动就重启（分钟；有交易在送多给一点时间） */
let lastLoopAt = Date.now(); const LOOP_SAVE_MS = 30e3, WD_GAP_MS = 90e3; /* 运作：主回圈存档间隔／看门狗两次检查间隔超过这么久＝电脑刚睡醒 */
setInterval(() => { { const n = Date.now(); if (globalThis._wdPrev && n - globalThis._wdPrev > WD_GAP_MS) lastLoopAt = n; globalThis._wdPrev = n; /* 电脑睡醒（计时器停了很久）先不算卡住 */ const wd = INFLIGHT > 0 ? WD_MIN_TX : WD_MIN; if (Date.now() - lastLoopAt > wd * 60e3) { log(`看门狗：主回圈卡住超过 ${wd} 分钟，自动重启`); try { save(); } catch {} process.exit(3); } } }, 30e3).unref();
async function main() {
  log('启动监测'); setTimeout(() => groupInvite().catch(() => {}), 20e3);
  GATE_CTX.run({ src: 'tg' }, () => tgCmdLoop()).catch((e) => log('tgCmd ' + e.message)); /* GATE-1：TG 指令＝手动 */
  let lastHold = 0, lastLogin = 0;
  for (;;) {
    try { if (statSync(SELF).mtimeMs !== SELF_MT) { if ((INFLIGHT > 0 || globalThis._xBusy) && !globalThis._waitSince) globalThis._waitSince = Date.now(); if ((INFLIGHT === 0 && !globalThis._xBusy) || Date.now() - (globalThis._waitSince || 0) > 300e3) { log('程序更新，重启'); save(); process.exit(0); } } } catch {} // 有交易正在送出就先等它送完（等太久就照样重启）
    if (UPD.on && existsSync(join(DIR, 'UPDATE'))) { try { unlinkSync(join(DIR, 'UPDATE')); } catch {} doUpdate().then((m) => { log(m); console.log('\n' + m + '\n'); tgSay(m); }).catch((e) => log('update ' + e.message)); }
    if (UPD.on && (!globalThis._updAt || Date.now() - globalThis._updAt > 30 * 60e3)) { globalThis._updAt = Date.now(); updCheck().catch(() => {}); } // 定时看 GitHub 有没有新版
    if (existsSync(join(DIR, 'WATCH_STOP'))) { log('WATCH_STOP，退出'); save(); process.exit(0); }
    try {
      const head = parseInt(await rpc('eth_blockNumber', []), 16);
      const tS = Date.now(); try { await scanNew(head); } catch (e) { if (Date.now() - (globalThis._scanErrAt || 0) > 600e3) { globalThis._scanErrAt = Date.now(); log('扫描新合约：节点限流，这轮先略过（下一轮会补扫）' + String(e.message || '').slice(0, 60)); } } /* 节点限流不能让整轮后面的工作（热门代币、开盘侦测、付费检查…）一起跳过 */ if (Date.now() - tS > 20e3) log(`扫描一轮花了 ${Math.round((Date.now() - tS) / 1000)} 秒`);
      if (!globalThis._agBusy && Date.now() - (globalThis._agAt || 0) > 60e3) { globalThis._agBusy = true; globalThis._agAt = Date.now(); agTokScan().catch((e) => log('agTok ' + e.message)).finally(() => { globalThis._agBusy = false; }); } if (!globalThis._genBusy && Date.now() - (globalThis._genAt || 0) > 60e3) { globalThis._genBusy = true; globalThis._genAt = Date.now(); genScan().catch((e) => log('gen ' + e.message)).finally(() => { globalThis._genBusy = false; }); } /* AI 热门代币每分钟检查 */
      if (!globalThis._openBusy && Date.now() - (globalThis._openAt || 0) > 15e3) { globalThis._openBusy = true; globalThis._openAt = Date.now(); openWatch(head).catch((e) => log('openWatch ' + e.message)).finally(() => { globalThis._openBusy = false; }); } /* 开盘侦测（检查频率） */
      { const fast = Object.values(S.tokens).some((st) => st.openAt && Date.now() - st.openAt < RULE.fastMin * 60e3 && st.stage !== 9 && !st.done); const full = Date.now() - lastHold > 5000; if (!globalThis._holdBusy && full) { lastHold = Date.now(); globalThis._holdBusy = true; const tH = Date.now(); holdings(head, false).catch((e) => log('holdings ' + e.message)).finally(() => { globalThis._holdBusy = false; if (Date.now() - tH > 20e3) log(`持仓检查花了 ${Math.round((Date.now() - tH) / 1000)} 秒`); }); } if (fast && !globalThis._fastBusy && Date.now() - (globalThis._fastAt || 0) > 15e3) { globalThis._fastBusy = true; globalThis._fastAt = Date.now(); holdings(head, true).catch((e) => log('holdings fast ' + e.message)).finally(() => { globalThis._fastBusy = false; }); } } /* 刚开盘（RULE.fastMin 内）的币独立密集看价格，不等完整检查跑完 */ /* 持仓检查放背景，同时只跑一个，避免重复卖 */
      if (!globalThis._flapAt || Date.now() - globalThis._flapAt > 30e3) { globalThis._flapAt = Date.now(); if (!globalThis._flapBusy) { globalThis._flapBusy = true; flapAgentWatch().catch((e) => log('flap ' + e.message)).finally(() => { globalThis._flapBusy = false; }); } }
      if (!globalThis._toshAt || Date.now() - globalThis._toshAt > 60e3) { globalThis._toshAt = Date.now(); if (!globalThis._toshBusy) { globalThis._toshBusy = true; toshWatch().catch((e) => log('tosh ' + e.message)).finally(() => { globalThis._toshBusy = false; }); } }
      if (!globalThis._miscAt || Date.now() - globalThis._miscAt > 600e3) { globalThis._miscAt = Date.now(); lowBnbWatch().catch(() => {}); flapApprovalWatch().catch((e) => log('flapApproval ' + e.message)); approvalPatrol().catch((e) => log('approvalPatrol ' + e.message)); } /* 定时看 BNB 够不够（门槛＝你的设定） */
      dailyReport().catch((e) => log('daily ' + e.message));
      if (!globalThis._pruneAt || Date.now() - globalThis._pruneAt > 3600e3) { globalThis._pruneAt = Date.now(); pruneState(); }
      if (!globalThis._aidropAt || Date.now() - globalThis._aidropAt > 120e3) { globalThis._aidropAt = Date.now(); const tA = Date.now(); await aidropWatch(head); if (Date.now() - tA > 20e3) log(`aidrop 检查花了 ${Math.round((Date.now() - tA) / 1000)} 秒`); }
      for (let k = 0; k < 3; k++) { const bk = '_paidBusy' + k, ak = '_paidAt' + k; if (!globalThis[bk] && (!globalThis[ak] || Date.now() - globalThis[ak] > 15e3)) { globalThis[ak] = Date.now(); globalThis[bk] = true; paidLoop('hot', k).catch((e) => log('paidLoop ' + e.message)).finally(() => { globalThis[bk] = false; globalThis._paidDur = Math.round((Date.now() - globalThis[ak]) / 1000); }); } } /* 快速检查：分组同时跑（检查频率） */
      if (!globalThis._swBusy && (!globalThis._swAt || Date.now() - globalThis._swAt > 60e3)) { globalThis._swAt = Date.now(); globalThis._swBusy = true; progressSweep().catch((e) => log('sweep ' + e.message)).finally(() => { globalThis._swBusy = false; }); } // 每分钟轻量读进度
      if (!globalThis._restBusy && (!globalThis._restAt || Date.now() - globalThis._restAt > 60e3)) { globalThis._restAt = Date.now(); globalThis._restBusy = true; paidLoop('rest').catch((e) => log('paidRest ' + e.message)).finally(() => { globalThis._restBusy = false; }); } // 一般检查：约每分钟 // 背景跑，不卡住扫描
      { const sk = JSON.stringify([nrOn('smart.auto'), nrNum('smart.autoN'), WINNERS.length]); if (!globalThis._smartBusy && globalThis._smartKey !== sk) { globalThis._smartKey = sk; S.smartAt = Date.now(); globalThis._smartBusy = true; buildSmart().catch((e) => log('smart ' + e.message)).finally(() => { globalThis._smartBusy = false; }); } } /* 赢家钱包是固定的，结果只跟你的设定有关 → 设定变了（或重开）才重算 */
      try { estopWatch(); } catch {}
      tgQDrain().catch(() => {}); /* 背景送，不卡主回圈；雷达视窗的 AVE 提醒交给引擎用用户自己的 TG 发 */
      if (process.uptime() > UPD_STABLE_S && existsSync(join(DIR, 'data', 'update_pending.json'))) { try { renameSync(join(DIR, 'data', 'update_pending.json'), join(DIR, 'data', 'update_ok.json')); log(`新版已稳定运行 ${Math.round(UPD_STABLE_S / 60)} 分钟`); } catch {} }
      if (!globalThis._heatBusy && Date.now() - (globalThis._heatAt || 0) > 20e3) { globalThis._heatAt = Date.now(); globalThis._heatBusy = true; heatWatch().catch((e) => log('heatWatch ' + e.message)).finally(() => { globalThis._heatBusy = false; }); } // 热度监测（背景）
      if (!globalThis._fpBusy && Date.now() - (globalThis._fpAt || 0) > 300e3) { globalThis._fpAt = Date.now(); globalThis._fpBusy = true; freeProgWatch().catch((e) => log('freeProg ' + e.message)).finally(() => { globalThis._fpBusy = false; }); } // 免费项目进度（定时）
      if (!globalThis._nftBusy && nftVolH() != null && Date.now() - (S.nftVolAt || 0) > nftVolH() * 3600e3) { S.nftVolAt = Date.now(); globalThis._nftBusy = true; nftVolWatch().catch((e) => log('nftVol ' + e.message)).finally(() => { globalThis._nftBusy = false; }); } // 照你设的 notify.nftVolH 看 NFT 成交量（背景）
      if (Date.now() - lastLogin > 600e3) { lastLogin = Date.now(); loginCheck().catch(() => {}); }
      lastLoopAt = Date.now(); if (Date.now() - _saveAt > LOOP_SAVE_MS) save(); /* 主回圈定时存一次（有变化的地方本来就会自己存；内容没变不写档） */ writeFileSync(join(DIR, 'data', 'watch_heartbeat.txt'), Date.now() + ' ' + ts() + ' 扫描落后 ' + (S.scanLag ?? '?') + ' 块 · 付费检查一轮 ' + (globalThis._paidDur ?? '?') + ' 秒');
      { const lb = nrNum('notify.lagBlocks'); if (lb == null || S.scanLag == null || S.scanLag <= lb) nClear('lag'); } if (nrNum('notify.lagBlocks') != null && S.scanLag != null && S.scanLag > nrNum('notify.lagBlocks') && nOnce('lag')) { await tg(`⚠️ 新合约扫描落后 ${S.scanLag} 个区块（约 ${Math.round(S.scanLag * BSC_BLK_S / 60)} 分钟），可能是公用节点变慢，手动处理`); }
    } catch (e) { lastLoopAt = Date.now(); try { writeFileSync(join(DIR, 'data', 'watch_heartbeat.txt'), Date.now() + ' ' + ts() + ' 节点连不上：' + String(e.message || '').slice(0, 80)); } catch {} /* 出错（像断网）也算有在跑，不会被看门狗一直重启 */ log('出错 ' + e.message + ' @' + String(e.stack || '').split('\n').slice(1, 3).map((x) => x.trim().replace(/^at /, '').replace(/\(?file:.*?([^/\\]+\.mjs)/, '$1')).join(' < ').slice(0, 160)); }
    await sleep(1000);
  }
}
process.on('uncaughtException', (e) => log('uncaught ' + e.message));
process.on('unhandledRejection', (e) => log('unhandled ' + (e?.message || e)));
main();

/* 不送交易、不花 gas、不动钱。
   签好的结果存 data/bind.json，雷达画面再把它交给官方 TG 机器人登记；机器人会核对签名，别人冒用你的钱包地址也签不出来。 */
let BIND = null; try { BIND = await import('./bind.mjs'); } catch (e) { log('邀请绑定模组载入失败 ' + e.message); }
const BIND_UNSUP = /953004|don'?t support signing|not support/i; /* BIND-FIX：币安说「不支援这种讯息」 */
const BIND_DEV = /35180\d|developer ?mode|dev ?mode/i; /* BIND-FIX：开发者模式没开／过期 */
const BIND_BACKOFF = [60e3, 600e3, 3600e3, 86400e3]; /* 技术用：绑定签名失败后多久自动再试（1 分钟、10 分钟、1 小时，之后一天一次），不会每分钟一直送预览、一直跳币安通知 */
const BIND_FMT = 'b3'; /*BINDSH108：修好 shell 引号后旧的失败次数作废、马上重试*/ /* 技术用：签名写法版本，雷达更新后重新算失败次数 */
async function bindSign(kind, code) { const W = WALLETS[0]; if (!W || !BIND) throw new Error('还没有钱包');
  /* BIND-FIX 11/5：照币安说明书送 {method, params}；依序试 BIND.BIND_VC 的写法，只有币安回「不支援这种讯息」(953004) 才换下一种，其他错误（开发者模式没开、登入过期…）立刻停，不连发。
     拿掉旧的「换一种引号再送一次」：那次送的是被包成字串的 JSON，币安一定拒绝，还会盖掉第一次真正的错误 */
  let p = null, vf = '';
  for (const vc of BIND.BIND_VC || ['']) { vf = vc;
    const msg = JSON.stringify({ method: 'eth_signTypedData_v4', params: [W.addr, JSON.stringify(BIND.bindTyped(kind, code, W.addr, vc))] });
    p = await W.baw(['sign-message', 'preview', '--binanceChainId', '56', '--message', bawShNow(W.baw) ? JSON.stringify(msg) : msg, /*BINDSH108*/ '--signType', 'EIP712'], 60000);
    if ((p.j?.success && p.j?.data?.requestId) || !BIND_UNSUP.test(String(p.j?.error?.message || p.j?.error?.code || p.t || ''))) break; }
  const rid = p.j?.data?.requestId; if (!p.j?.success || !rid) { const em = String(p.j?.error?.message || p.t || ''); throw new Error('签名预览失败 ' + em.slice(0, 100) + (BIND_DEV.test(em) ? '（要先在币安 App 的 Agentic 钱包设定打开「开发者模式」）' : '')); }
  let pm = {}; try { pm = JSON.parse(p.j.data.parsedMessage?.message || '{}'); } catch {} if (pm && pm.message && typeof pm.message === 'object') pm = pm.message; /* parsedMessage 可能是整份 typed data */
  if (pm.code !== code || String(pm.wallet || '').toLowerCase() !== W.addr || pm.kind !== kind) throw new Error('要签的内容跟预期不一样，已取消');
  const x = await W.baw(['sign-message', 'execute', '--requestId', rid], 60000); let d = x.j?.data;
  for (let i = 0; i < 5 && d && !d.signature && d.orderId; i++) { await sleep(3000); d = (await W.baw(['sign-message', 'result', '--order-id', d.orderId], 60000)).j?.data || d; }
  if (!d?.signature) throw new Error('签名失败 ' + String(x.j?.error?.message || x.t || '').slice(0, 100));
  const sig = String(d.signature).replace(/^0x/, '').slice(0, 128), v = parseInt(d.signatureRecovery || '0', 16) % 27;
  if (!BIND.verifyBind(kind, code, W.addr, sig, v)) throw new Error('签名核对不过');
  return { kind, code, wallet: W.addr, sig, v, vf: vf ? (vf === 'self' ? 's' : 'z') : '', at: Date.now() }; } /* BIND-FIX：vf＝用哪种写法签的（只是纪录，送机器人的内容不变） */
setInterval(async () => { if (globalThis._bindBusy || !WALLETS[0] || !BIND) return; const S = radarSet(); let B = {}; try { B = JSON.parse(readFileSync(BINDF, 'utf8')); } catch {}
  const W = WALLETS[0], want = [];
  const rc = String(S['ref.code'] || '').toLowerCase(); if (BIND.CODE_RE.test(rc) && !(B.join?.code === rc && WALLETS.some((x) => x.addr === B.join?.wallet))) want.push(['join', rc]); /*RISK-FIX 4：签过的钱包还在就不重签 */
  const mc = String(S['ref.mine'] || '').toLowerCase(); if (BIND.CODE_RE.test(mc) && !(B.code?.code === mc && WALLETS.some((x) => x.addr === B.code?.wallet))) want.push(['code', mc]); /*RISK-FIX 4*/
  const wk = JSON.stringify([BIND_FMT, W.addr, want]), en = B.errKey === wk ? Number(B.errN) || 0 : 0; /* BIND-FIX：同一组（版本、钱包、码）失败几次 */
  if (!want.length || (en > 0 && Date.now() - B.errAt < BIND_BACKOFF[Math.min(en, BIND_BACKOFF.length) - 1])) return;
  globalThis._bindBusy = 1; try { for (const [k, c] of want) { B[k] = await bindSign(k, c); log(`[邀请] 主钱包已签好${k === 'join' ? '邀请码 ' : '专属邀请码申请 '}${c}（只是签名，没有送交易）`); } B.err = ''; B.errAt = 0; B.errN = 0; B.errKey = ''; }
  catch (e) { const n = en + 1, wait = BIND_BACKOFF[Math.min(n, BIND_BACKOFF.length) - 1]; B.err = String(e.message || e).slice(0, 150) + `（${wait >= 3600e3 ? Math.round(wait / 3600e3) + ' 小时' : Math.round(wait / 60e3) + ' 分钟'}后自动再试）`; B.errAt = Date.now(); B.errKey = wk; B.errN = n; log('[邀请] ' + B.err); }
  finally { try { writeFileSync(BINDF, JSON.stringify(B)); } catch {} globalThis._bindBusy = 0; } }, 15000);

/* 拿掉「USDT 自动换回 BNB」——一键买可以直接选用 BNB 或 U 付，不替用户互换（浪费时间和手续费） */


async function callChannelWatch() { /* 监测你自己在雷达「设定 → 监测的 TG 频道」填的公开频道（data/tg_channels.txt 一行一个频道名；没填＝不监测，没有内建频道），频道贴的合约自动加入追踪，照同一套规则决定打不打；在本机跑，不花钱、不花 Claude 用量 */
  let chs = []; try { const f = join(DIR, 'data', 'tg_channels.txt'); if (existsSync(f)) { const l = readFileSync(f, 'utf8').split(/\r?\n/).map((x) => x.trim().replace(/^@|^https?:\/\/t\.me\/(s\/)?/i, '').replace(/\/.*$/, '')).filter((x) => /^[A-Za-z0-9_]{4,40}$/.test(x)); chs = [...new Set(l)]; } } catch {}
  S.callSeen = S.callSeen || {}; S.callHits = S.callHits || {};
  for (const ch of chs) { /* 空清单＝不监测 */
    let html = ''; try { html = await (await fetch('https://t.me/s/' + ch, { signal: AbortSignal.timeout(15000) })).text(); } catch { continue; }
    const posts = html.split(`data-post="${ch}/`).slice(1); const first = !S.callSeen['init:' + ch]; S.callSeen['init:' + ch] = 1;
    for (const p of posts) { const id = parseInt(p, 10); const key = ch + '/' + id; if (!id || S.callSeen[key]) continue; S.callSeen[key] = ts(); if (first) continue; /* 新加的频道：加入前的贴文只记下来，不回头打 */
      const text = p.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' '); const name = (text.match(/\$([A-Za-z0-9_一-鿿]{2,20})/) || [])[1] || '';
      const addrs = [...new Set((text.match(/0x[a-fA-F0-9]{40}/g) || []).map((x) => x.toLowerCase()))];
      for (const c of addrs) { if (INFRA.has(c)) continue; const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); if (code.length <= 2) continue;
        const hits = (S.callHits[c] = S.callHits[c] || []); if (!hits.includes(ch)) hits.push(ch); (S.callLog = S.callLog || []).push({ c, src: String(ch).slice(0, 40), at: Date.now() }); if (S.callLog.length > 600) S.callLog.splice(0, S.callLog.length - 600); /* 信号页喊单流＋车头榜 */
        S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: name ? '$' + name : '频道项目', done: {}, fromCall: key, needLearn: 1 }; S.paid[c].calls = hits.length;
        log(`频道 ${ch} 第 ${id} 则：${name ? '$' + name + ' ' : ''}${c} 加入追踪（目前 ${hits.length} 个频道提到：${hits.join('、')}；照规则：进度和钱包数都达到门槛才打）`);
        if (nrOn('tgch.mint')) for (const W of WALLETS) { const ff = await findFree(W.addr, c, code).catch(() => null); if (ff) queueMint(c, ff.n, W, ff.v); } else if (nrOn0('tgch.mint') && nrOn0('bsc.freeNotify')) nrDecSkip('bsc', c, '', '「频道贴的免费铸造直接打」和「免费只通知」都开着（互斥）→ 照「只通知」，没打'); } /* 频道贴的免费铸造直接排队打＝你的开关 tgch.mint（预设关） */
    }
  }
  const ks = Object.keys(S.callSeen).filter((k) => !k.startsWith('init:')); if (ks.length > 2000) for (const k of ks.slice(0, ks.length - 2000)) delete S.callSeen[k];
  const hk = Object.keys(S.callHits); if (hk.length > 3000) for (const k of hk.slice(0, hk.length - 3000)) delete S.callHits[k];
}
/* 用户申请、她审核过的 X 帐号由官方统一监测，贴了合约就发布到 robincat-radar-data/xwatch.json；雷达下载后存 data/xwatch.json，这里当成频道贴文处理 */
async function xHitWatch() { if (!nrOn('xwatch.on')) return; /* X 监测＝你的开关 xwatch.on（预设关） */ let X = null; try { X = JSON.parse(readFileSync(join(DIR, 'data', 'xwatch.json'), 'utf8')); } catch { return; }
  S.callSeen = S.callSeen || {}; S.callHits = S.callHits || {}; const first = !S.callSeen['init:x'];
  for (const it of (X.hits || []).slice(-300)) { const key = 'x:' + it.id; if (!it.id || !/^0x[0-9a-f]{40}$/.test(it.c || '') || S.callSeen[key]) continue; S.callSeen[key] = ts(); if (first) continue; /* 第一次只记下不回头；之后读到的都加入追踪 */
    const c = it.c; if (INFRA.has(c)) continue; const code = ((await rpc('eth_getCode', [c, 'latest']).catch(() => '')) || '').toLowerCase(); if (code.length <= 2) continue; const src = '𝕏 @' + String(it.h || '').slice(0, 20);
    const hits = (S.callHits[c] = S.callHits[c] || []); if (!hits.includes(src)) hits.push(src); (S.callLog = S.callLog || []).push({ c, src: String(src).slice(0, 40), at: Date.now() }); if (S.callLog.length > 600) S.callLog.splice(0, S.callLog.length - 600); /* 信号页喊单流＋车头榜 */
    S.paid = S.paid || {}; if (!S.paid[c]) S.paid[c] = { at: Date.now(), name: '频道项目', done: {}, fromCall: key, needLearn: 1 }; S.paid[c].calls = hits.length;
    log(`${src} 贴了 ${c}，加入追踪（照规则：进度和钱包数都达到门槛才打）`);
    if (nrOn('xwatch.mint')) for (const W of WALLETS) { const ff = await findFree(W.addr, c, code).catch(() => null); if (ff) queueMint(c, ff.n, W, ff.v); } else if (nrOn0('xwatch.mint') && nrOn0('bsc.freeNotify')) nrDecSkip('bsc', c, '', '「X 监测免费铸造直接打」和「免费只通知」都开着（互斥）→ 照「只通知」，没打'); } /* 免费铸造直接排队打＝xwatch.mint（预设关） */
  S.callSeen['init:x'] = 1; }
setInterval(() => { if (globalThis._callBusy) return; globalThis._callBusy = true; callChannelWatch().then(() => xHitWatch()).catch((e) => log('call ' + e.message)).finally(() => { globalThis._callBusy = false; }); }, 60e3);
