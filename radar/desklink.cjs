'use strict';
/* DESKLNK-108：桌面捷径改成真正的 Windows 捷径「罗宾猫雷达.lnk」（显示猫头图示），取代旧版的「罗宾猫雷达.vbs」（显示成脚本图示）。
   - 一键安装.bat：node radar\desklink.cjs install → 建 .lnk；建不成才退回旧的 .vbs；建好后，桌面上旧的 .vbs 只有「内容确实是指向本雷达启动脚本」才删。
   - radar/main.cjs 启动时（只限 Windows）：migrate() → 桌面有指向本雷达的旧 .vbs、没有 .lnk → 建 .lnk、删那个 .vbs；做过记在 data/desklink.json，不再重做；任何失败都静默放弃。
   只碰桌面上这两个档名，不碰其他档。路径有中文／空白、桌面在 OneDrive 都可以（PowerShell 用 -EncodedCommand 传 Unicode）。 */
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const NAME = '罗宾猫雷达';
const ROOT = path.resolve(__dirname, '..');
const W = path.win32; /* 写进捷径／旧 vbs 的都是 Windows 路径 */
const vbsOf = (root) => W.join(root, 'radar', '启动罗宾猫雷达.vbs');
const icoOf = (root) => W.join(root, 'radar', 'ui', 'logo.ico');
const oldVbsText = (root) => 'CreateObject("WScript.Shell").Run """' + vbsOf(root) + '""", 0, False\r\n';
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'"; /* PowerShell 单引号字串 */
const enc = (script) => Buffer.from(script, 'utf16le').toString('base64');
const wscript = () => W.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'wscript.exe');
/* 建捷径用的 PowerShell 指令（测试会检查这些参数） */
function psScript(lnk, root) {
  return `$ErrorActionPreference='Stop';$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${psq(lnk)});$s.TargetPath=${psq(wscript())};$s.Arguments=${psq('"' + vbsOf(root) + '"')};$s.WorkingDirectory=${psq(root)};$s.IconLocation=${psq(icoOf(root) + ',0')};$s.Description=${psq(NAME)};$s.WindowStyle=1;$s.Save()`;
}
/* 非同步执行（main.cjs 里不能卡住视窗） */
function ps(script, timeout) { return new Promise((res, rej) => { cp.execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc(script)], { encoding: 'utf8', windowsHide: true, timeout: timeout || 30000 }, (e, out) => (e ? rej(e) : res(String(out || '')))); }); }
async function desktopDir() { let d = ''; try { d = (await ps("[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Environment]::GetFolderPath('Desktop')", 20000)).trim(); } catch {} if (!d || !fs.existsSync(d)) d = path.join(os.homedir(), 'Desktop'); return d; } /* 开了 OneDrive 备份时桌面在 OneDrive 里 */
async function mkLinkWin(lnk, root) { await ps(psScript(lnk, root)); }
function readText(f) { const b = fs.readFileSync(f); if (b[0] === 0xff && b[1] === 0xfe) return b.slice(2).toString('utf16le'); if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.slice(3).toString('utf8'); return b.toString('utf8'); }
/* 旧 .vbs 是不是「指向本雷达的启动脚本」：内容必须正好是旧安装档写的那一行（路径不分大小写、\ 和 / 视为一样） */
function isOurVbs(f, root) {
  try { const st = fs.lstatSync(f); if (!st.isFile() || st.size > 4096) return false; const norm = (s) => String(s).replace(/\r?\n$/, '').replace(/\//g, '\\').toLowerCase(); return norm(readText(f)) === norm(oldVbsText(root)); } catch { return false; }
}
function lnkOk(f) { try { const st = fs.lstatSync(f); return st.isFile() && st.size > 0; } catch { return false; } }
/* 一键安装.bat 用：建 .lnk；失败才写旧 .vbs；成功后删掉确认过内容的旧 .vbs */
async function install(o = {}) {
  const root = o.root || ROOT, d = o.desktop || await desktopDir(), mk = o.mkLink || mkLinkWin;
  const lnk = path.join(d, NAME + '.lnk'), vbs = path.join(d, NAME + '.vbs');
  let made = false; try { await mk(lnk, root); made = lnkOk(lnk); } catch {}
  if (made) { let rm = false; if (fs.existsSync(vbs) && isOurVbs(vbs, root)) { try { fs.unlinkSync(vbs); rm = true; } catch {} } return { ok: true, kind: 'lnk', lnk, removedVbs: rm }; }
  try { fs.writeFileSync(vbs, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(oldVbsText(root), 'utf16le')])); return { ok: true, kind: 'vbs', vbs }; } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
}
/* main.cjs 用：已经装好的用户（一键更新不会跑安装档）。只在 Windows；只做一次；失败静默 */
async function migrate(o = {}) {
  try {
    if ((o.platform || process.platform) !== 'win32') return { skip: 'platform' };
    const root = o.root || ROOT, data = o.dataDir || path.join(root, 'data'), mark = path.join(data, 'desklink.json');
    let M = {}; try { M = JSON.parse(fs.readFileSync(mark, 'utf8')) || {}; } catch {}
    if (M.done) return { skip: 'done' }; if ((+M.fail || 0) >= 3) return { skip: 'gaveup' };
    const save = (x) => { try { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(mark, JSON.stringify({ ...M, ...x, at: Date.now() })); } catch {} };
    const d = o.desktop || await desktopDir(), mk = o.mkLink || mkLinkWin;
    const lnk = path.join(d, NAME + '.lnk'), vbs = path.join(d, NAME + '.vbs');
    if (lnkOk(lnk)) { save({ done: 1, why: 'haslnk' }); return { skip: 'haslnk' }; }
    if (!fs.existsSync(vbs)) { save({ done: 1, why: 'novbs' }); return { skip: 'novbs' }; }
    if (!isOurVbs(vbs, root)) { save({ done: 1, why: 'notours' }); return { skip: 'notours' }; }
    try { await mk(lnk, root); } catch {}
    if (!lnkOk(lnk)) { save({ fail: (+M.fail || 0) + 1 }); return { ok: false }; }
    try { fs.unlinkSync(vbs); } catch {}
    save({ done: 1, why: 'migrated' }); return { ok: true, lnk };
  } catch { return { ok: false }; }
}
module.exports = { install, migrate, psScript, isOurVbs, oldVbsText, NAME };
if (require.main === module && process.argv[2] === 'install') {
  install().then((r) => console.log(r.ok ? (r.kind === 'lnk' ? '桌面已建立「罗宾猫雷达」捷径' + (r.removedVbs ? '（旧的「罗宾猫雷达.vbs」已换掉）' : '') : '桌面已建立「罗宾猫雷达」（捷径建不成，先用旧的启动档）') : '建立桌面捷径失败，可以直接点 radar\\启动罗宾猫雷达.vbs'), () => console.log('建立桌面捷径失败，可以直接点 radar\\启动罗宾猫雷达.vbs'));
}
