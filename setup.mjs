// 一键安装的设定向导：一步步问钱包和 TG，自动生成 config.json（由「一键安装.bat」呼叫，也可以单独执行：node setup.mjs）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
const DIR = dirname(fileURLToPath(import.meta.url));
/* H2：AI 帮忙安装时没办法回答问题 → 可以用参数或环境变数直接给（不问问题） */
const ARG = {}; { const a = process.argv.slice(2); for (let i = 0; i < a.length; i++) { const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(a[i]); if (!m) continue; ARG[m[1]] = m[2] != null ? m[2] : (a[i + 1] != null && !a[i + 1].startsWith('--') ? a[++i] : '1'); } }
const opt = (k, e) => String(ARG[k] ?? process.env[e] ?? '').trim();
const A = { name1: opt('name1', 'RC_NAME1'), addr1: opt('addr1', 'RC_ADDR1'), name2: opt('name2', 'RC_NAME2'), addr2: opt('addr2', 'RC_ADDR2'), tok: opt('tg-token', 'RC_TG_TOKEN'), chat: opt('tg-chat', 'RC_TG_CHAT') };
const isAddr0 = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
if (A.name1 || A.addr1) { /* 不问问题的装法 */
  const bad = []; if (!A.name1) bad.push('--name1（第 1 个钱包的 .ai 名称）'); if (!isAddr0(A.addr1)) bad.push('--addr1（第 1 个钱包地址 0x 开头 42 字）');
  if ((A.name2 || A.addr2) && (!A.name2 || !isAddr0(A.addr2))) bad.push('--name2／--addr2（第 2 个钱包，两个都要给）');
  if (A.tok && !/^\d+:[\w-]{20,}$/.test(A.tok)) bad.push('--tg-token（BotFather 给的 Bot Token）'); if (A.tok && !/^-?\d+$/.test(A.chat)) bad.push('--tg-chat（数字 chat id）');
  if (bad.length) { console.log('设定参数不对：' + bad.join('、')); process.exit(1); }
  const f0 = join(DIR, 'config.json'); const c0 = JSON.parse(readFileSync(existsSync(f0) ? f0 : join(DIR, 'config.example.json'), 'utf8'));
  c0.wallets = [{ name: A.name1, address: A.addr1.toLowerCase() }]; if (A.name2) c0.wallets.push({ name: A.name2, address: A.addr2.toLowerCase(), bawDir: 'baw2', bawPkg: 'baw2pkg', instanceId: 'wallet-2' });
  c0.telegram = c0.telegram || {}; if (A.tok) { c0.telegram.botToken = A.tok; c0.telegram.chatId = A.chat; }
  delete c0.paid; delete c0.rules;
  writeFileSync(f0, JSON.stringify(c0, null, 2)); writeFileSync(join(DIR, 'data_wallets.txt'), String(c0.wallets.length));
  console.log('✅ 设定已存到 config.json（' + c0.wallets.length + ' 个钱包' + (A.tok ? '、TG 通知' : '') + '）。买卖数字一律没设，要玩家自己到雷达「设定」页填。'); process.exit(0);
}
if (!process.stdin.isTTY) { /* 不是真的终端机（例如 AI 帮忙执行）又没给参数 → 不要卡住，印出该用的指令 */
  if (existsSync(join(DIR, 'config.json'))) { try { const c1 = JSON.parse(readFileSync(join(DIR, 'config.json'), 'utf8')); writeFileSync(join(DIR, 'data_wallets.txt'), String((c1.wallets || []).length || 1)); } catch {} console.log('已经有 config.json，保留原本的设定（要重设请加参数，见下方）'); }
  console.log('\n这里没办法问问题。请先问玩家钱包资料，然后用这个指令设定（[] 里的可以不填）：');
  console.log('  node setup.mjs --name1 abc.ai --addr1 0x你的钱包地址 [--name2 def.ai --addr2 0x第二个钱包] [--tg-token 123456:ABC... --tg-chat 123456789]');
  console.log('（一键安装.bat／一键安装-Mac.command 也可以加同样的参数）'); process.exit(0);
}
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, ok = () => true, def = '') => { for (;;) { const a = (await rl.question(q)).trim() || def; if (ok(a)) return a; console.log('  格式不对，请再输入一次'); } };
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
const f = join(DIR, 'config.json');
const cfg = JSON.parse(readFileSync(existsSync(f) ? f : join(DIR, 'config.example.json'), 'utf8'));
if (existsSync(f)) { const again = await ask('已经有 config.json，要重新设定吗？(y/N) ', () => true, 'n'); if (!/^y/i.test(again)) { console.log('保留原本的设定'); writeFileSync(join(DIR, 'data_wallets.txt'), String((cfg.wallets || []).length)); rl.close(); process.exit(0); } }
console.log('\n=== 第 1 步：Agent ID 钱包 ===');
console.log('在币安 App → 钱包 → Agentic Wallet 可以看到你的 .ai 名称和钱包地址（0x 开头）');
const w1 = { name: await ask('第 1 个钱包的 .ai 名称（例如 abc.ai）：', (a) => a.length > 0), address: (await ask('第 1 个钱包地址（0x…）：', isAddr)).toLowerCase() };
cfg.wallets = [w1];
const more = await ask('有第 2 个 Agent ID 钱包要一起用吗？(y/N) ', () => true, 'n');
if (/^y/i.test(more)) cfg.wallets.push({ name: await ask('第 2 个钱包的 .ai 名称：', (a) => a.length > 0), address: (await ask('第 2 个钱包地址（0x…）：', isAddr)).toLowerCase(), bawDir: 'baw2', bawPkg: 'baw2pkg', instanceId: 'wallet-2' });
console.log('\n=== 第 2 步：Telegram 通知（可以跳过，直接按 Enter）===');
console.log('1) 在 TG 搜 @BotFather → 输入 /newbot → 照指示取名 → 会给你一串 Bot Token');
console.log('2) 在 TG 搜 @userinfobot → 按 Start → 它回的 Id 就是你的 chat id');
console.log('3) 记得先去跟你的机器人说一句话（按 Start），它才能发讯息给你');
cfg.telegram = cfg.telegram || {};
cfg.telegram.botToken = await ask('Bot Token：', (a) => !a || /^\d+:[\w-]{20,}$/.test(a), cfg.telegram.botToken || '');
if (cfg.telegram.botToken) cfg.telegram.chatId = await ask('你的 chat id：', (a) => /^-?\d+$/.test(a), cfg.telegram.chatId || '');
console.log('\n=== 买卖金额 ===');
console.log('这个向导不设任何金额或门槛。每笔金额、每天上限、买卖条件都要你自己到雷达「设定」页填；没填的功能不会买。');
writeFileSync(f, JSON.stringify(cfg, null, 2));
writeFileSync(join(DIR, 'data_wallets.txt'), String(cfg.wallets.length));
console.log('\n✅ 设定已存到 config.json（之后想改可以重新执行 node setup.mjs）\n');
rl.close();
