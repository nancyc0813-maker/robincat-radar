#!/usr/bin/env node
// 罗宾猫雷达 · 防破坏检查（guard_check）
// 抓：偷塞的程式码、官方数字、隐藏规则、偷偷的备用买卖路径、新的外连网域、碰私钥／转钱的程式、绕过「统一动作闸门」的送交易。
// 不挡正常扩充：外挂（plugins/*.mjs）用 --plugin 检查；玩家自己的 AI 改了核心档用 --local（只列出、不阻挡）。
//
// 用法（在雷达资料夹里跑）：
//   node tools/guard_check.mjs                         发布模式：有任何问题＝FAIL（结束码 1）
//   node tools/guard_check.mjs --pre-sign              发布前、还没重签 official.json 时：清单／指纹不符只警告，其他照样 FAIL
//   node tools/guard_check.mjs --local                 玩家电脑：改了核心档不阻挡，只列出「改了哪些、哪些绕过闸门／新网域／新数字」，
//                                                      写 data/guard_status.json 给雷达画面显示「核心档已被修改（未签名）」
//   node tools/guard_check.mjs --plugin plugins/x.mjs  检查一个外挂：违规会用白话说「哪里不行、应该怎么改」（给 AI 看），有问题结束码 1
// 其他：--root <雷达资料夹>（预设＝tools 的上一层）  --json <输出.json>  --zero-allow <零官方数字白名单>  --quiet
// 白名单：tools/guard_rules.json（网域、已知的合法例外；每一条都要写理由）。tools/ 底下的档也在官方签名清单里，被改掉发布检查会抓到。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, dirname, resolve, extname, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const has = (n) => argv.includes(n);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(opt('--root') || join(HERE, '..'));
const MODE = has('--plugin') ? 'plugin' : has('--local') ? 'local' : 'release';
const PRESIGN = has('--pre-sign');
const QUIET = has('--quiet');
const RULES_FILE = join(HERE, 'guard_rules.json');
const ZERO = join(HERE, 'zero_check.mjs');
const ZALLOW = opt('--zero-allow') || join(HERE, 'zero_allowlist.json');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rel = (p) => relative(ROOT, p).split(sep).join('/');
const out = { mode: MODE, root: ROOT, at: Date.now(), fail: [], warn: [], info: [] };
const F = (rule, file, line, msg, fix, extra) => out.fail.push({ rule, file, line, msg, fix: fix || '', ...(extra || {}) });
const Wn = (rule, file, line, msg, fix) => out.warn.push({ rule, file, line, msg, fix: fix || '' });

let RULES = { domains: {}, allow: [] };
try { RULES = JSON.parse(readFileSync(RULES_FILE, 'utf8')); } catch (e) { console.error('⛔ 读不到 tools/guard_rules.json：' + e.message); process.exit(2); }
for (const [i, a] of (RULES.allow || []).entries()) if (!a.reason || String(a.reason).trim().length < 4) { console.error(`⛔ guard_rules.json allow 第 ${i} 条没写理由，拒绝`); process.exit(2); }
for (const [h, why] of Object.entries(RULES.domains || {})) if (!why || String(why).trim().length < 2) { console.error(`⛔ guard_rules.json 网域 ${h} 没写理由，拒绝`); process.exit(2); }

// ---------- 读档 ----------
const CODE_EXT = new Set(['.mjs', '.cjs', '.js', '.html', '.bat', '.cmd', '.command', '.sh', '.vbs', '.ps1', '.toml']);
const JS_EXT = new Set(['.mjs', '.cjs', '.js', '.html']);
const SKIP_DIR = new Set(['node_modules', 'dist', 'data', '.git', '.sign', '.sign_radar', 'tools']);
function walk(d, acc = []) { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) { if (!SKIP_DIR.has(n)) walk(p, acc); continue; } if (CODE_EXT.has(extname(n)) && !n.endsWith('.min.js')) acc.push(p); } return acc; }

/* 把注释换成空白（保留换行，行号不变）；codeOnly 另外把字串内容也换成空白（只看程式本身） */
function strip(src, ext) {
  if (!JS_EXT.has(ext)) { // 批次档／shell／vbs：整行注释拿掉
    const re = ext === '.vbs' ? /^\s*(?:'|rem\b)/i : ext === '.bat' || ext === '.cmd' ? /^\s*(?:rem\b|::)/i : /^\s*#/;
    const nc = src.split('\n').map((l) => (re.test(l) && !/^#!/.test(l) ? '' : l)).join('\n'); return { nc, code: nc, strs: [] };
  }
  let nc = '', code = '', i = 0; const n = src.length; const strs = []; const blank = (s) => s.replace(/[^\n]/g, ' ');
  const prevSig = () => { const m = /[^\s]\s*$/.exec(code); return m ? m[0].trim() : ''; };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; nc += blank(src.slice(i, j)); code += blank(src.slice(i, j)); i = j; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; nc += blank(src.slice(i, j)); code += blank(src.slice(i, j)); i = j; continue; }
    if (c === '<' && src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); const j = e < 0 ? n : e + 3; nc += blank(src.slice(i, j)); code += blank(src.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'" || c === '`') { let j = i + 1; while (j < n && src[j] !== c && (c === '`' || src[j] !== '\n')) { if (src[j] === '\\') j++; j++; } const s = src.slice(i, Math.min(j + 1, n)); strs.push({ at: i, v: s.slice(1, -1) }); nc += s; code += c + blank(s.slice(1, -1)) + (s.length > 1 ? c : ''); i = j + 1; continue; }
    if (c === '/' && /^$|[(,=:[!&|?{};+\-*%<>~^]$|\b(return|typeof|case|in|of)$/.test(prevSig())) { let j = i + 1, cls = false; while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; } if (src[j] === '/') { const s = src.slice(i, j + 1); nc += s; code += '/' + blank(s.slice(1, -1)) + '/'; i = j + 1; continue; } }
    nc += c; code += c; i++;
  }
  return { nc, code, strs };
}
const lineOf = (src, at) => { let l = 1; for (let k = src.indexOf('\n'); k >= 0 && k < at; k = src.indexOf('\n', k + 1)) l++; return l; };
const FILES = new Map(); /* rel → { src, nc, code, strs, ext } */
function load(p) { const r = rel(p); if (FILES.has(r)) return FILES.get(r); const src = readFileSync(p, 'utf8'); const ext = extname(p); const o = { abs: p, src, ext, ...strip(src, ext) }; FILES.set(r, o); return o; }

// ---------- 核心规则（每条：抓什么、为什么危险、应该怎么改） ----------
const CORE = [
  { id: 'BAW_RAW', re: /agentic-wallet|baw2pkg|\bBAW_BIN\b|BINANCE_BAW_DIR|BINANCE_INSTANCE_ID/, msg: '直接叫币安钱包 CLI（baw）——会绕过统一动作闸门', fix: '要送交易只能用雷达给的钱包物件 W.baw（引擎内）或外挂的 api.buy／api.sell／api.call，它们都会先过统一动作闸门（紧急全停、总开关、手动开关、手机额度）' },
  { id: 'BAW_SWAP', re: /\.baw\s*=(?!=)|\bbaw\s*:/, msg: '换掉／自己定义钱包送交易的函式（可能绕过统一动作闸门）', fix: '不要换掉或重新定义 W.baw（要记录交易就像安全哨兵那样包一层、里面照样呼叫原本的 W.baw）；新钱包请用 WALLETS.push(...)（会自动包上闸门）' },
  { id: 'RAW_SIGN', re: /eth_sendRawTransaction|eth_sendTransaction|\beth_sign\b|personal_sign|eth_signTypedData|signTransaction|sendTransaction|\bsignMessage\s*\(|\bnew\s+(?:ethers\.)?Wallet\b|privateKeyToAccount|fromMnemonic|createWalletClient|HDNodeWallet/, msg: '自己签名／送交易（不经过币安钱包和统一动作闸门）', fix: '雷达不在本机签交易：一律交给币安钱包（W.baw），由统一动作闸门检查' },
  { id: 'WEB3_LIB', re: /(?:from\s+|require\(\s*|import\(\s*)['"`](?:ethers|viem|web3|@ethersproject\/[\w-]+|tronweb|@solana\/web3\.js|bip39|ethereumjs-wallet|@noble\/secp256k1)['"`]/, msg: '载入可以签交易／产生私钥的套件', fix: '不需要这些套件：读链上用 rpc／eth_call，送交易交给币安钱包（W.baw）' },
  { id: 'SECRET', re: /private\.pem|\.pem['"`]|\bid_rsa\b|keystore|wallet\.dat|mnemonic|seed[ _-]?phrase|\.sign_radar|Login Data|Local State|['"`]Cookies['"`]|find-generic-password|dump-keychain|\bcmdkey\b|CredRead|CredEnum|ProtectedData|dpapi/i, msg: '碰私钥、助记词、钥匙圈、浏览器登入资料', fix: '雷达不需要也不准读这些；钱包登入一律走币安钱包扫码' },
  { id: 'ENV_EXFIL', re: /JSON\.stringify\(\s*process\.env\b|Object\.(?:entries|keys|values)\(\s*process\.env\b|body\s*:[^\n]*process\.env\b/, msg: '把整包环境变数拿出来（可能把密钥送出去）', fix: '只读需要的那一个环境变数，不要整包传' },
  { id: 'DYN_CODE', re: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(\s*['"`]|\bvm\s*\.\s*(?:runIn\w+|Script|compileFunction|SourceTextModule)|runInNewContext|data:(?:text|application)\/javascript|--experimental-network-imports|--experimental-vm-modules|WebAssembly\.(?:instantiate|compile)|setTimeout\(\s*['"`]|setInterval\(\s*['"`]/, msg: '动态执行程式码（eval／new Function／远端或字串载入）', fix: '把要跑的程式直接写在档案里；不要从字串、网址或下载的内容执行程式' },
  { id: 'DYN_IMPORT', re: /\bimport\s*\(\s*(?!['"`](?:\.\.?\/|node:|[a-z@][\w@/.-]*['"`]))|\brequire\s*\(\s*(?!['"`])|\bimport\b[^;\n]*?['"`]https?:|createRequire\([^)]*\)\(\s*(?!['"`])/, msg: '载入的模组名称不是写死的（可能远端／动态载入）', fix: "用固定的相对路径，例如 import('./xxx.mjs')；不要用变数或网址" },
  { id: 'SHELL_NET', re: /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|certutil|bitsadmin|DownloadString|DownloadFile|Start-BitsTransfer)\b|\bnc\s+-e\b|bash\s+-i\b|powershell[^\n]*-e(?:nc|ncodedcommand)?\s/i, msg: '叫外部程式下载／连网', fix: '用 Node 的 fetch（网域要在白名单里）' },
  { id: 'CHILD_PROC', re: /child_process|\bexecSync\b|\bspawnSync\b/, msg: '开外部程式', fix: '新功能不要开外部程式；需要的话请玩家自己决定（这是核心档修改）' },
  { id: 'TOOLS_IMPORT', re: /['"`]\.{1,2}\/tools\//, msg: '执行档去载入 tools/（检查工具不是给执行档用的）', fix: '不要从执行档载入 tools/ 底下的档' },
];
/* 统一动作闸门一定要在（watch.mjs）：少任何一个＝闸门被拿掉或改坏 */
const GATE_MUST = [
  ['async function actionGate(W, a)', '统一动作闸门函式 actionGate'],
  ['const G = await actionGate(W, a);', 'W.baw 送出前先过 actionGate'],
  ['g._gate = 1; W.baw = g; }', '闸门直接包住真正的币安钱包 CLI'],
  ['for (const W of WALLETS) guardBaw(W);', '每个钱包都包上闸门'],
  ["Object.defineProperty(WALLETS, 'push'", '之后新增的钱包也包上闸门'],
  ["need('紧急全停', !ESTOP()", '买入／授权检查紧急全停'],
  ["need('自动买总开关', !radarOff()", '自动买检查总开关 auto'],
  ["need('手动买卖开关', !MANUAL_OFF()", '手动买检查「手动买卖」开关'],
  ["need('手机额度检查', from !== 'phone' || (Object.hasOwn(st, 'phoneOk') && st.phoneOk === 1)", '手机单要先过 phoneGate（hasOwn：原型污染骗不过）'],
  ["need('设定档在', existsSync(join(DIR, 'data', 'radar_settings.json'))", '设定档不见＝读不到设定＝不买'],
  ['const ESTOP = () => gateEstop();', '紧急全停只有画面「重新设定」能解除（改档／删档解除不了）'],
  ['if (!gateOrdOk(o))', '下单档要有主程式签章（直接写 data/radar_orders.json 不算）'],
  ["Object.defineProperty(globalThis, 'GUARD_OK'", '允许外挂的验签函式冻结在 globalThis（换不掉）'],
  ['function guardSettings(z)', '没签章的敏感设定当作没开'],
  ["need('不转出', K.kind !== 'transfer'", '转出一律不送'],
  ["need('只签邀请绑定', K.kind !== 'sign-bad'", '签名只签邀请绑定'],
  ["need('指令白名单', K.kind !== 'unknown'", '只认识雷达用到的钱包指令'],
  ["'读不到资料／判断出错，只能不买：'", '读不到资料只能「不买」'],
  ["gst.phoneOk = 1", '手机单过了 phoneGate 才标记'],
  ["src: o.src === 'phone' ? 'phone' : 'radar' });", '雷达／手机单记来源'],
  ["GATE_CTX.run({ src: 'tg' }, () => tgCmdLoop())", 'TG 指令＝手动'],
  ['gateLog({', '逐条判断日志 data/gate_log.jsonl'],
];
/* 主程式（radar/main.cjs）这边一定要在的：少任何一个＝签章被拿掉或改坏 */
const MAIN_MUST = [
  ['guardStartup(); /* GATE-2 */', '启动先用真正的金钥写 guard.json（别人塞的金钥不会被记住）'],
  ['arr.push(ordSign({ ...o, at: Date.now(), id }))', '画面／手机的单都签章'],
  ['guardAfterSave(fin, s, cur); setWrite(fin);', '先签章再写设定档'],
  ["guardPut(j, 'set', 'estop.cleared'", '解除全停要签 estop.cleared'],
  ['if (!guardApprove(file, hash))', '允许外挂要签章'],
];
/* OLDWORD：以前的工具／以前版本的字眼（关键字清单用 base64 存：这个档自己不能被「字眼检查」扫到；解开是 [正则, 说明] 的清单，不是程式） */
const OLDWORD_D = JSON.parse(Buffer.from('eyJpdGVtcyI6IFtbIm1hbnVhbF9taW50XFwuanNvbnx0Z192aXBcXC50eHR8XFxiVklQX0lEU1xcYnxcXGJ2aXBPa1xcYnxcXGJsb2FkVmlwXFxifHZpcFBlckhvdXJ8YWdlbnRpZGNhbGwiLCAi5pen5bel5YW355qE5qGj5qGI5o6l5Y+j77yP5YaF5bu65p2l5rqQIl0sIFsidXBkYXRlX25ld1xcLm1qc3x1cGRhdGVfYmFja3VwXFwubWpzfGJhY2t1cF9wcmV2XFwubWpzIiwgIuaXp+eahOWNleaho+abtOaWsO+8j+iHquWKqOi/mOWOnyJdLCBbIkFnZW50IElEIFNuaXBlcnxhZ2VudGlkLXNuaXBlcnxHYW5nUGFwZXJ85omT54uX5bel5YW3fHJvYmluY2F0LXNlbnRpbmVsIiwgIuaXp+S6p+WTgeWQje+8j+aXp+i1hOaWmeWkuSJdLCBbIig/PCFbXFx3LV0pcmFkYXItZGF0YVxcYiIsICLml6fku5PlupPlkI0gcmFkYXItZGF0Ye+8iOeOsOWcqOaYryByb2JpbmNhdC1yYWRhci1kYXRh77yJIl0sIFsiXFxidjFcXC4wXFwuMVswLTRdXFxifFxcYnYyXFwuXFxkK1xcLlxcZCtcXGIiLCAi5pen54mI5pys5Y+3Il0sIFsiZGVsZXRlIGNmZ1xcLig/OnBhaWR8cnVsZXMpfGZpeGVkX3RoclxcLnR4dHzmsqHmnInov4Hnp7t85rKS5pyJ6YG356e7fOayoeacieaXp+eJiHzml6fniYjnlKjmiLd85YCL5Lq654mIfOS4quS6uueJiCIsICLml6fniYjov4Hnp7vvvI/ml6fniYjor7Tms5UiXV0sICJtc2ciOiAi5pen54mI5q6L55WZ77yaIiwgImZpeCI6ICLliKDmjonmiJbmlLnmiJDlj6rmj4/ov7DnjrDlnKjnmoTooYzkuLrvvIjop4EgTEVHQUNZX1BVUkdF77yJIn0=', 'base64').toString('utf8'));
const OLDWORD = OLDWORD_D.items.map(([re, why]) => [new RegExp(re), why]);
function allowedHit(rule, file, lineTxt) {
  for (const a of RULES.allow || []) { if (a.rule !== rule) continue; if (a.file && !new RegExp(a.file).test(file)) continue; if (a.match && !new RegExp(a.match).test(lineTxt)) continue; a._hits = (a._hits || 0) + 1; return a._hits <= (a.max ?? 1) ? a : null; }
  return null;
}
function scanCore(r) {
  const o = FILES.get(r); const hits = []; const L = o.nc.split('\n');
  for (const R of CORE) { const g = new RegExp(R.re.source, R.re.flags.includes('g') ? R.re.flags : R.re.flags + 'g'); L.forEach((t, k) => { g.lastIndex = 0; if (!g.test(t)) return; if (allowedHit(R.id, r, t)) return; hits.push({ rule: R.id, file: r, line: k + 1, msg: R.msg, fix: R.fix, snip: t.trim().slice(0, 160) }); }); }
  /* 网域：只看程式（含字串），注释里的网址不算 */
  const hre = /\b(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g; let m;
  while ((m = hre.exec(o.nc))) { const h = m[1].toLowerCase().replace(/\.$/, ''); if (!Object.hasOwn(RULES.domains || {}, h)) hits.push({ rule: 'DOMAIN', file: r, line: lineOf(o.nc, m.index), msg: `新的外连网域 ${h}（不在白名单）`, fix: '只能连白名单里的网站（tools/guard_rules.json 的 domains）。真的需要新网站：由维护者确认后加进白名单并写理由，重新签名发布', host: h }); }
  if (r === 'watch.mjs') for (const [s, what] of GATE_MUST) if (!o.src.includes(s)) hits.push({ rule: 'GATE', file: r, line: 0, msg: `统一动作闸门被拿掉或改坏：少了「${what}」`, fix: '送交易／签名／授权一定要经过 actionGate；不要改闸门本身（patches/gate.py 会重建）' });
  if (r === 'radar/main.cjs') for (const [s, what] of MAIN_MUST) if (!o.src.includes(s)) hits.push({ rule: 'GATE', file: r, line: 0, msg: `守护签章被拿掉或改坏：少了「${what}」`, fix: '画面按的设定／下单都要由主程式签章；不要改签章本身（patches/gate.py 会重建）' });
  return hits;
}
function scanOldWord(r) { const o = FILES.get(r); const hits = []; o.src.split('\n').forEach((t, k) => { for (const [re, why] of OLDWORD) if (re.test(t) && !allowedHit('OLDWORD', r, t)) hits.push({ rule: 'OLDWORD', file: r, line: k + 1, msg: OLDWORD_D.msg + why, fix: OLDWORD_D.fix, snip: t.trim().slice(0, 160) }); }); return hits; }

// ---------- 零官方数字（tools/zero_check.mjs） ----------
function zero(target, allow) {
  const dir = mkdtempSync(join(tmpdir(), 'gc-')); const jf = join(dir, 'z.json');
  try { const r = spawnSync(process.execPath, [ZERO, target, '--allow', allow, '--json', jf, '--quiet'], { encoding: 'utf8', maxBuffer: 64 << 20 }); if (!existsSync(jf)) return { err: (r.stderr || r.stdout || 'zero_check 没跑起来').slice(-400), viol: [] }; return JSON.parse(readFileSync(jf, 'utf8')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const ZMSG = { FALLBACK: '读不到资料时偷偷用一个写死的数字（隐藏预设值）', CMP: '拿写死的数字当门槛做判断', MINMAX: '写死的上下限', SLICE: '写死「只取前几个」', OBJNUM: '写死的预设值／门槛表', PARAMDEF: '函式参数写死预设数字', TIMEWIN: '写死的时间窗', COMMENT_NUM: '注释写着门槛数字', STRING_NUM: '画面文字写着门槛数字', KWLIST: '关键字黑名单／贴标签清单（隐藏规则）', SCHEMA_DEF: '设定项目带官方预设值', NUMSTR: '数字写成字串（滑点／金额）', FALLBACK0: '读不到资料就当 0 继续判断', SCHEMA_TXT: '设定说明写死数字' };
const ZFIX = '把这个数字做成设定（开关＋玩家自己填的数字、预设关）；读不到资料或没填＝不买，不要用写死的数字代替。纯技术用的（逾时、分页大小）请在旁边注释「技术用」并加进零官方数字白名单、写理由';

// ---------- 官方清单 ----------
function manifest() {
  const mf = join(ROOT, 'radar', 'official.json'), sf = join(ROOT, 'radar', 'official.sig');
  if (!existsSync(mf)) return { err: '没有 radar/official.json' };
  const man = readFileSync(mf); let M = {}; try { M = JSON.parse(man); } catch { return { err: 'official.json 不是有效的 JSON' }; }
  let sig = 'no-sig'; try { const R = createRequire(import.meta.url)(join(ROOT, 'repo.cjs')); if (!R.PUB_OK) sig = 'no-pubkey'; else if (!existsSync(sf)) sig = 'no-sig'; else sig = verify(null, man, createPublicKey({ key: Buffer.from(R.PUBKEY, 'base64'), format: 'der', type: 'spki' }), Buffer.from(readFileSync(sf, 'utf8').trim(), 'base64')) ? 'ok' : 'bad'; } catch (e) { sig = 'error:' + e.message.slice(0, 80); }
  const files = M.files || {}; const modified = [], missing = [];
  for (const [f, h] of Object.entries(files)) { const p = join(ROOT, f); if (!existsSync(p)) missing.push(f); else if (sha(readFileSync(p)) !== h) modified.push(f); }
  return { files, sig, modified, missing };
}
const EXEC_EXT = new Set(['.mjs', '.cjs', '.js', '.html', '.bat', '.cmd', '.command', '.sh', '.vbs', '.ps1']);
function executables() { const acc = []; (function w(d) { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) { if (['node_modules', 'data', '.git', '.sign', '.sign_radar'].includes(n)) continue; if (rel(p) === 'relay') continue; /* relay/ 另外部署到 Cloudflare，不在本机执行 */ w(p); continue; } if (EXEC_EXT.has(extname(n))) acc.push(rel(p)); } })(ROOT); return acc; }

// ---------- 外挂规则 ----------
function pluginCtx() {
  const pm = existsSync(join(ROOT, 'plugins.mjs')) ? readFileSync(join(ROOT, 'plugins.mjs'), 'utf8') : ''; const ph = existsSync(join(ROOT, 'plugin-host.mjs')) ? readFileSync(join(ROOT, 'plugin-host.mjs'), 'utf8') : '';
  const hosts = [...(/const DATA_HOSTS = new Set\(\[([^\]]*)\]/.exec(pm)?.[1] || '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const deny = [...(/const DENY_SEL = \[([\s\S]*?)\];/.exec(pm)?.[1] || '').replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([0-9a-f]{8})'/g)].map((x) => x[1]);
  let seg = /const api = Object\.freeze\(\{([\s\S]*?)\}\);\n/.exec(ph)?.[1] || ''; seg = seg.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''"); for (let k = 0, prev = ''; k < 50 && prev !== seg; k++) { prev = seg; seg = seg.replace(/\([^()]*\)|\{[^{}]*\}|\[[^[\]]*\]/g, ''); }
  const api = new Set([...seg.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)/g)].map((x) => x[1]));
  return { hosts, deny, api };
}
const P_TRADES = /\b(buy|sell|call|limitBuy|limitSell)\b/; /* 跟 plugins.mjs 一样：程式里出现这几个字就当会花钱 */
function checkPlugin(abs) {
  const r = rel(abs); const errs = [], warns = []; const E = (line, msg, fix) => errs.push({ rule: 'PLUGIN', file: r, line, msg, fix }); const Wx = (line, msg, fix) => warns.push({ rule: 'PLUGIN', file: r, line, msg, fix });
  if (!existsSync(abs)) { E(0, '找不到这个外挂档', '确认路径，例如 plugins/我的外挂.mjs'); return { errs, warns }; }
  if (!/^plugins\/[^/]+\.mjs$/.test(r)) Wx(0, '外挂要放在雷达资料夹的 plugins/ 底下、副档名 .mjs，雷达才会载入', '把档案移到 plugins/ 底下');
  const C = pluginCtx(); const o = load(abs); const trades = P_TRADES.test(o.src.replace(/\/\/[^\n]*/g, ''));
  const chk = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' }); if (chk.status !== 0) E(0, '语法错误：' + (chk.stderr || '').split('\n').filter((x) => /Error|^\s*\^/.test(x)).slice(0, 2).join(' ').slice(0, 200), '照错误讯息把语法修好，再跑一次 node --check');
  if (!/export\s+const\s+meta\s*=/.test(o.code)) E(0, '缺 export const meta（外挂的名字、id、说明）', "加上：export const meta = { id: 'my_tool', name: '我的小工具', everySec: 60, desc: '做什么、会不会花钱' };");
  else { const id = /\bid\s*:\s*['"`]([^'"`]*)['"`]/.exec(o.nc.slice(o.nc.search(/export\s+const\s+meta/)))?.[1]; if (!id || !/^[a-z0-9_-]{1,32}$/.test(id)) E(lineOf(o.src, o.src.search(/export\s+const\s+meta/)), 'meta.id 只能用小写英文、数字、_、-（1～32 字）', "例如 id: 'grid_bnb'"); }
  if (!/export\s+(?:async\s+)?function\s+tick\s*\(/.test(o.code) && !/export\s+const\s+tick\s*=/.test(o.code)) E(0, '缺 export async function tick(api)（雷达每一轮会呼叫它）', 'export async function tick(api) { /* 在这里写要做的事 */ }');
  const L = o.code.split('\n'), N = o.nc.split('\n');
  const each = (lines, re, fn) => lines.forEach((t, k) => { const g = new RegExp(re.source, re.flags.replace('g', '') + 'g'); let m; while ((m = g.exec(t))) fn(k + 1, m, t); });
  each(L, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bimport\s*\.\s*meta\b|^\s*export\s+[^;\n]*\bfrom\b/, (ln) => E(ln, '外挂不能载入任何模组（import／require）', '删掉 import／require。读公开行情用 await api.fetchJson(网址)，读链上用 await api.read(合约, 资料, 链)，余额用 await api.balances()，价格用 await api.price(币)'));
  each(L, /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon|importScripts)\b/, (ln, m) => E(ln, `外挂不能自己连网（${m[1]}）`, '改用 await api.fetchJson(网址)，而且只能读白名单里的公开行情网站：' + C.hosts.join('、')));
  each(L, /\b(process|globalThis|global|module|exports|Deno|Bun|__proto__|constructor|setPrototypeOf|getPrototypeOf|Reflect|eval|Function|WebAssembly|SharedArrayBuffer|Atomics)\b/, (ln, m) => E(ln, `外挂不能碰系统或动态执行程式（${m[1]}）`, '只用 tick(api) 拿到的 api 功能；不要用 eval、Function、process、globalThis、constructor'));
  each(N, /agentic-wallet|\bbaw\b|contract-call|market-order|sign-message|\bapprovals\b|eth_send\w*|eth_sign\w*|personal_sign|signTransaction|sendTransaction|signMessage|signTypedData|privateKey|private_key|mnemonic|keystore|seed ?phrase|\.pem\b/i, (ln, m) => E(ln, `外挂不能自己签名、送交易或碰私钥（${m[0]}）`, '买用 await api.buy(币, 金额U)，卖用 await api.sell(币, 数量)，合约互动用 await api.call(合约, 资料, 金额, 链)；这些都会经过雷达的统一动作闸门（紧急全停、自动买总开关、这个外挂每天额度）'));
  for (const s of o.strs) { const v = s.v.toLowerCase(); const ln = lineOf(o.src, s.at);
    const hx = /0x([0-9a-f]+)/g; let m; while ((m = hx.exec(v))) { const h = m[1]; for (const sel of C.deny) for (let i = h.indexOf(sel); i >= 0; i = h.indexOf(sel, i + 1)) if (i % 2 === 0) { E(ln, `外挂不能转帐、授权或 Permit（资料里有函式代码 0x${sel}）`, '外挂只能用 api.buy／api.sell 换币；转帐、授权、Permit 一律不行（雷达送出前也会挡掉）'); i = h.length; } }
    if (/\b(transfer|transferfrom|approve|increaseallowance|setapprovalforall|permit|safetransferfrom|operatorsend|authorizeoperator|transferandcall|approveandcall)\s*\(/.test(v)) E(ln, '外挂不能转帐／授权（字串里有 transfer／approve／permit 这类函式）', '外挂只能用 api.buy／api.sell 换币；转帐、授权、Permit 一律不行');
    const ur = /\b(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*)/g; while ((m = ur.exec(v))) if (!C.hosts.includes(m[1])) E(ln, `外挂只能读白名单里的公开行情网站，「${m[1]}」不在里面`, '改用这些网站：' + C.hosts.join('、') + '。真的需要别的网站：要由玩家自己决定、请维护者加进 plugins.mjs 的 DATA_HOSTS（那是核心档修改，雷达会显示「核心档已被修改」）'); }
  each(L, /\bapi\s*\.\s*([A-Za-z_]\w*)/, (ln, m) => { if (!C.api.has(m[1])) E(ln, `没有 api.${m[1]} 这个功能`, '能用的只有：api.' + [...C.api].join('、api.')); });
  each(L, /\bapi\s*\[/, (ln) => E(ln, '不要用 api[...] 动态取功能', '直接写 api.名字（例如 api.buy）'));
  if (!trades) each(L, /\bapi\s*\.\s*(buy|sell|call|limitBuy|limitSell)\b/, (ln, m) => E(ln, `程式有 api.${m[1]}，但雷达会把这个外挂当成「只看不买」（买卖字样被同一行前面的 // 盖掉，例如网址里的 //），到时 api.${m[1]} 不存在`, '把 api.buy／api.sell／api.call 那一段放到没有 // 的那一行（网址用 api.fetchJson 时另起一行），让雷达看得出这个外挂会花钱；玩家按「允许」时也会看到提醒'));
  if (trades) {
    each(N, /catch\s*(?:\([^)]*\))?\s*\{[^}]*\bapi\s*\.\s*buy\b/, (ln) => E(ln, '出错／读不到资料时去买（偷偷的备用买入路径）', '读不到资料或出错时只能「不买」：catch 里不要呼叫 api.buy'));
    each(N, /\bapi\s*\.\s*buy\s*\([^,()]+,\s*-?[\d.]+(?:e\d+)?\s*\)/, (ln) => E(ln, '买入金额写死在程式里（官方数字）', "金额用玩家自己填的设定：在 meta.settings 加 { k: 'usd', zh: '每次买多少 U', min: 0, max: … }，程式里用 api.settings().usd；没填就不买"));
  }
  each(L, /while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/, (ln) => Wx(ln, '无穷回圈：外挂每一轮会被叫一次，不需要自己转圈', '把回圈拿掉，每次 tick 做一轮就好；多久跑一次用 meta.everySec'));
  const z = zero(abs, join(tmpdir(), 'guard-no-allow.json'));
  if (z.err) Wx(0, '零官方数字检查没跑起来：' + z.err, '确认 tools/zero_check.mjs 存在');
  for (const v of z.viol || []) { if (/\b(?:min|max|step|everySec)\s*:\s*-?[\d.]+(?:e\d+)?\b/.test(v.near || '') && v.rule === 'OBJNUM') continue; /* 设定栏位的范围、多久跑一次：技术用 */
    const msg = `写死的数字 ${v.value}：${ZMSG[v.rule] || v.rule}`; const fix = "做成设定让玩家自己填：在 meta.settings 加 { k: '名字', zh: '说明', min: …, max: … }，程式里用 api.settings().名字 读；没填＝不买。纯显示用（例如图表留几笔）可以留着";
    (trades && !['COMMENT_NUM', 'STRING_NUM'].includes(v.rule) ? E : Wx)(v.line, msg + `（${String(v.snip || '').trim().slice(0, 80)}）`, fix); }
  return { errs, warns, trades };
}

/* GATE-2：只能在雷达画面按的设定（外挂允许、plug.*.on、phone.*、auto.allowApproval、auto.sendOnPreviewFail）有没有被直接写档 */
function directWrites() {
  const D = join(ROOT, 'data'); const rj = (f, d) => { try { return JSON.parse(readFileSync(join(D, f), 'utf8')); } catch { return d; } };
  const KEY = (k) => /^plug\..+\.on$/.test(k) || /^phone\./.test(k) || k === 'auto.allowApproval' || k === 'auto.sendOnPreviewFail';
  const on = (v) => !(v == null || v === '' || v === false || Number(v) === 0);
  const G = rj('guard.json', null); const pin = rj('watch_state.json', {})?.guardPub || ''; const hits = []; let pk = null, why = '';
  if (!G) why = '没有 data/guard.json'; else if (pin && G.pub !== pin) why = 'data/guard.json 的金钥跟引擎记住的不一样（可能被换掉）'; else { try { pk = createPublicKey({ key: Buffer.from(String(G.pub || ''), 'base64'), format: 'der', type: 'spki' }); } catch { why = 'data/guard.json 金钥读不懂'; } }
  const ok = (kind, k, v) => { try { const r = pk && G[kind]?.[k]; return !!r && JSON.stringify(r.v) === JSON.stringify(v) && verify(null, Buffer.from('rcr-guard-v1\n' + kind + '\n' + k + '\n' + JSON.stringify(v)), pk, Buffer.from(String(r.sig || ''), 'base64')); } catch { return false; } };
  const fix = '这些只能玩家自己在雷达画面按（会跳视窗确认）。AI 不准直接写档；要开请玩家到雷达画面重新打开';
  for (const [k, v] of Object.entries(rj('radar_settings.json', {}) || {})) if (KEY(k) && on(v) && !ok('set', k, v)) hits.push({ rule: 'DIRECT_WRITE', file: 'data/radar_settings.json', line: 0, msg: `「${k}」=${JSON.stringify(v)} 没有雷达画面的签章（直接写档）${why ? '：' + why : ''}`, fix });
  for (const [f, h] of Object.entries(rj('plugins_ok.json', {}) || {})) if (!ok('ok', f, h)) hits.push({ rule: 'DIRECT_WRITE', file: 'data/plugins_ok.json', line: 0, msg: `「允许外挂 ${f}」没有雷达画面的签章（直接写档）${why ? '：' + why : ''}`, fix });
  return hits;
}

// ---------- 执行 ----------
function printList(title, arr, icon) { if (!arr.length) return; console.log(`\n${icon} ${title}（${arr.length}）`); for (const x of arr.slice(0, 400)) { console.log(`  ${x.file || ''}${x.line ? ':' + x.line : ''}  [${x.rule}] ${x.msg}${x.snip ? '\n      └ ' + x.snip : ''}`); if (x.fix) console.log(`      👉 应该怎么改：${x.fix}`); } if (arr.length > 400) console.log(`  …还有 ${arr.length - 400} 条（用 --json 看全部）`); }

if (MODE === 'plugin') {
  const p = resolve(ROOT, opt('--plugin') || ''); const { errs, warns, trades } = checkPlugin(p);
  out.fail.push(...errs); out.warn.push(...warns);
  console.log(`🧩 外挂检查：${rel(p)}（${trades ? '会花钱：有 buy／sell／call' : '只看不买'}）`);
  printList('一定要改（不改雷达不会让它买卖／玩家不该按允许）', errs, '❌'); printList('建议改', warns, '⚠️');
  console.log(errs.length ? `\n❌ 外挂检查没过：${errs.length} 个问题。把上面「应该怎么改」照做，改完再跑：node --check ${rel(p)} 和 node tools/guard_check.mjs --plugin ${rel(p)}` : `\n✅ 外挂检查通过${warns.length ? `（有 ${warns.length} 个建议）` : ''}。还是要在雷达「外挂」页看过说明、自己按「允许」才会载入。`);
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
  process.exit(errs.length ? 1 : 0);
}

const all = walk(ROOT).map(load).map((o) => rel(o.abs));
const M = manifest();
if (MODE === 'release') {
  for (const r of all) out.fail.push(...scanCore(r));
  for (const r of [...all, ...['README.md', 'AI说明书.md', 'LICENSE', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'].filter((f) => existsSync(join(ROOT, f)) && !FILES.has(f)).map((f) => { load(join(ROOT, f)); return f; })]) out.fail.push(...scanOldWord(r));
  const z = zero(ROOT, ZALLOW); if (z.err) F('ZERO', '', 0, '零官方数字检查没跑起来：' + z.err, '确认 tools/zero_check.mjs 和 tools/zero_allowlist.json 都在');
  for (const v of z.viol || []) F('ZERO', v.file, v.line, `官方数字 ${v.value}：${ZMSG[v.rule] || v.rule}`, ZFIX, { snip: String(v.snip || '').trim().slice(0, 160) });
  for (const f of existsSync(join(ROOT, 'plugins')) ? readdirSync(join(ROOT, 'plugins')).filter((x) => x.endsWith('.mjs')) : []) { const { errs } = checkPlugin(join(ROOT, 'plugins', f)); out.fail.push(...errs); }
  const soft = PRESIGN ? (rule, file, line, msg, fix) => Wn(rule, file, line, msg + '（签名前：先警告）', fix) : F;
  if (M.err) soft('OFFICIAL', 'radar/official.json', 0, M.err, '跑 node sign_radar.mjs manifest <树> 重新签');
  else {
    if (M.sig !== 'ok') soft('OFFICIAL', 'radar/official.sig', 0, `官方清单签名不对（${M.sig}）`, '用官方私钥重新签：node sign_radar.mjs manifest <树>');
    for (const f of M.missing) soft('OFFICIAL', f, 0, '官方清单里有、但档案不见了', '补回档案或重新签清单');
    for (const f of M.modified) soft('OFFICIAL', f, 0, '跟官方清单的指纹不一样（改过、还没重签）', '确认改动没问题后重新签：node sign_radar.mjs manifest <树>');
    for (const f of executables()) if (!Object.hasOwn(M.files, f)) soft('OFFICIAL', f, 0, '不在官方签名清单（official.json）里的执行档', '不是官方的就删掉；是官方的就加进 sign_radar.mjs 的 OFFICIAL 清单后重新签');
  }
} else { /* local：不阻挡，只列出 */
  const changed = new Set(M.err ? all : M.modified.filter((f) => FILES.has(f) || existsSync(join(ROOT, f))));
  const added = M.err ? [] : executables().filter((f) => !Object.hasOwn(M.files, f) && !f.startsWith('plugins/') && !f.startsWith('tools/'));
  for (const f of added) changed.add(f);
  const find = []; for (const r of all) if (changed.has(r)) find.push(...scanCore(r));
  const z = zero(ROOT, ZALLOW); const nums = (z.viol || []).filter((v) => changed.has(v.file)).map((v) => ({ rule: 'ZERO', file: v.file, line: v.line, msg: `新数字 ${v.value}：${ZMSG[v.rule] || v.rule}`, fix: ZFIX, snip: String(v.snip || '').trim().slice(0, 160) }));
  const plugins = []; for (const f of existsSync(join(ROOT, 'plugins')) ? readdirSync(join(ROOT, 'plugins')).filter((x) => x.endsWith('.mjs')) : []) { const p = 'plugins/' + f; if (!M.err && M.files[p] && !M.modified.includes(p)) continue; /* 官方外挂没改过：不用再查 */ const { errs, warns, trades } = checkPlugin(join(ROOT, p)); plugins.push({ file: p, ok: !errs.length, trades: !!trades, errors: errs.map((e) => ({ line: e.line, msg: e.msg, fix: e.fix })), warnings: warns.length }); }
  const cat = (k) => find.filter((x) => k.includes(x.rule));
  const direct = directWrites();
  const status = { at: Date.now(), mode: 'local', signature: M.err ? 'missing' : M.sig, directWrites: direct.length, unsigned: !!(changed.size || M.missing?.length || (M.sig && M.sig !== 'ok')),
    label: changed.size || M.missing?.length ? '核心档已被修改（未签名）' : M.sig && M.sig !== 'ok' ? '官方清单签名不对' : direct.length ? '有设定不是在雷达画面改的（已当作关闭）' : '',
    modified: [...changed].filter((f) => !added.includes(f)), added, missing: M.missing || [],
    findings: { gate: cat(['GATE', 'BAW_RAW', 'BAW_SWAP', 'RAW_SIGN', 'WEB3_LIB']), domains: cat(['DOMAIN']), secrets: cat(['SECRET', 'ENV_EXFIL']), dynamic: cat(['DYN_CODE', 'DYN_IMPORT', 'SHELL_NET', 'CHILD_PROC', 'TOOLS_IMPORT']), numbers: nums, directWrites: direct },
    plugins };
  out.status = status;
  try { mkdirSync(join(ROOT, 'data'), { recursive: true }); writeFileSync(join(ROOT, 'data', 'guard_status.json'), JSON.stringify(status, null, 1)); } catch (e) { console.error('写不进 data/guard_status.json：' + e.message); }
  console.log(`🛡 本机检查（不阻挡）：${status.label || '核心档跟官方签名一样'}`);
  if (status.modified.length) console.log('  改过的核心档：' + status.modified.join('、'));
  if (status.added.length) console.log('  新增的执行档：' + status.added.join('、'));
  if (status.missing.length) console.log('  不见的核心档：' + status.missing.join('、'));
  printList('直接写档的敏感设定（不是在雷达画面按的，引擎当作没开）', direct, '✍️');
  printList('绕过统一动作闸门／自己签名送交易', status.findings.gate, '⛔'); printList('新的外连网域', status.findings.domains, '🌐'); printList('碰私钥／密钥外传', status.findings.secrets, '🔑'); printList('动态执行／开外部程式', status.findings.dynamic, '⚙️'); printList('新加的官方数字', status.findings.numbers, '🔢');
  for (const p of plugins) console.log(`  🧩 ${p.file}：${p.ok ? '✅ 通过' : `❌ ${p.errors.length} 个问题（跑 node tools/guard_check.mjs --plugin ${p.file} 看怎么改）`}`);
  console.log('  （结果写在 data/guard_status.json；雷达画面会显示。要改回官方版：在雷达按「重新下载这一版」）');
  if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
  process.exit(0);
}

const unused = (RULES.allow || []).filter((a) => !a._hits); if (unused.length && !QUIET) out.info.push(`guard_rules.json 有 ${unused.length} 条例外没用到（可能过时）：` + unused.map((a) => a.rule + ' ' + (a.file || '') + ' ' + (a.match || '')).join(' ｜ ').slice(0, 600));
const by = {}; for (const x of out.fail) by[x.rule] = (by[x.rule] || 0) + 1;
if (!QUIET) printList('FAIL', out.fail, '❌'); if (!QUIET) printList('警告', out.warn, '⚠️'); for (const i of out.info) console.log('ℹ️ ' + i);
console.log(`\n== guard_check（${PRESIGN ? '发布前／签名前' : '发布模式'}）== 扫了 ${all.length} 个档 | FAIL ${out.fail.length} ${JSON.stringify(by)} | 警告 ${out.warn.length}`);
console.log(out.fail.length ? '❌ FAIL：上面每一条都要处理（或确认是合法例外，加进 tools/guard_rules.json 并写理由）' : '✅ PASS');
if (opt('--json')) writeFileSync(opt('--json'), JSON.stringify(out, null, 1));
process.exit(out.fail.length ? 1 : 0);
