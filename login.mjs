// 登录 config.json 里第 N 个钱包（预设第 1 个）：node login.mjs 2
// 会印出登录连结，用这个钱包的币安 App 在手机上点开确认（约 5 分钟内有效）
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = dirname(fileURLToPath(import.meta.url));
/* HN-FIX 11/5：电脑名是中文时，币安 baw 把它放进 HTTP 标头会出错（登入、扫码、下单全卡）→ 只对 baw 子程序换成英文设备名 */
{ try { const _os = await import('node:os'); const _h = _os.hostname(); if (/[^\x20-\x7e]/.test(_h)) { const _fs = await import('node:fs'); const _p = join(DIR, 'data', 'hn_shim.cjs'); const _safe = 'RobinCat-' + Buffer.from(_h).toString('hex').slice(0, 8); _fs.mkdirSync(join(DIR, 'data'), { recursive: true }); _fs.writeFileSync(_p, "const os=require('os');os.hostname=()=>" + JSON.stringify(_safe) + ";require('module').syncBuiltinESMExports();\n"); const _o = String(process.env.NODE_OPTIONS || ''); if (!_o.includes('hn_shim.cjs')) process.env.NODE_OPTIONS = (_o + ' --require ' + JSON.stringify(_p)).trim(); } } catch {} }
const CONFIG = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8'));
const wc = CONFIG.wallets[(Number(process.argv[2]) || 1) - 1];
if (!wc) { console.error('config.json 里找不到这个钱包（先执行 node setup.mjs 设定钱包）'); process.exit(1); }
const run = (args, timeout = 60000) => new Promise((res) => {
  const cb = (e, so, se) => { const t = String(so || se || e?.message || ''); let j = null; try { j = JSON.parse(t.slice(t.indexOf('{'))); } catch {} res({ t, j }); };
  if (!wc.bawDir) return execFile('baw', [...args, '--json'], { shell: true, timeout }, cb);
  const env = { ...process.env, BINANCE_BAW_DIR: join(DIR, wc.bawDir), BINANCE_INSTANCE_ID: wc.instanceId || wc.name };
  execFile(process.execPath, [join(DIR, wc.bawPkg || 'baw2pkg', 'node_modules', '@binance', 'agentic-wallet', 'dist', 'index.js'), ...args, '--json'], { env, timeout }, cb);
});
const si = await run(['auth', 'signin']);
const d = si.j?.data; if (!d?.qrCodeId) { console.log('❌ 拿不到登录连结（baw 没装好或网络不通）。之后可以在雷达「设定 → 钱包」重新扫码，或再执行一次：node login.mjs ' + (Number(process.argv[2]) || 1) + '\n' + si.t.slice(0, 300)); process.exit(1); }
console.log(`\n[${wc.name}] 用手机打开这个连结确认登录：\n${d.urlForWeb}\n配对码：${d.pairingCode}\n等待确认中…`);
const v = await run(['auth', 'verify', '--qrCodeId', d.qrCodeId], 330000);
console.log(v.j?.data?.status === 'SUCCESS' ? '✅ 登录成功' : '❌ 登录没有完成（连结过期或没有确认）。之后可以在雷达「设定 → 钱包」重新扫码，或再执行一次：node login.mjs ' + (Number(process.argv[2]) || 1) + '\n' + v.t.slice(0, 300));
