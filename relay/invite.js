/* V120-INV（11/11）邀请／热门社群／反馈机器人搬进转接站（原本跑在 Nancy 电脑的 GangPaper/invite.mjs）。
   资料（谁绑了谁、专属码、社群申请）存在 Durable Object「inv-main」；名单用「邀请专用金钥」（env.INV_PRIV，Ed25519 PKCS8 PEM）签名，
   转接站自己提供 /invites.json，并推到 GitHub robincat-radar-data（env.GH_TOKEN）。主发布私钥不在这里。
   需要的密码（wrangler secret）：INV_PRIV、TG_BOT_TOKEN（@RobinCatRadar_bot）、TG_HOOK_SECRET、OWNER_CHAT（Nancy 的 TG 数字 id）、GH_TOKEN、INV_ADMIN_PUB（可省，汇入用＝线上金钥）
   全部没设＝这个模组不动（旧的 GangPaper 照常）。 */
import OFFI from '../repo.cjs';

const enc = new TextEncoder();
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
const CODE_RE = /^[a-z0-9_]{3,10}$/;
const OWN = 'nancy_c0813';
const NANCY_CODE = 'e53b67bb', NANCY_W = '0xe53b67bba6cb1db3fb129c461f1a603512a0ca5b';
const RESV = ['nancy', '666', '888', '000', '111', 'aaa', 'bbb', 'zzz', '444', 'ooo', 'you', 'www', 'nancy813', 'nancyc0813', 'nancy0813', 'nancyc813'];
const BLOCK = /^(admin|robincat|robin|official|guanfang|support|help|bot|radar|nancy|kefu|binance|bnb|team|system)/;
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f';
const RPCS = ['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com', 'https://bsc-dataseed1.defibit.io']; /* 技术用：BSC 公开节点 */
const INV_IT = 40000; /* 技术用：跟原本一样的 PBKDF2 次数（雷达照资料里的 it 算） */
const HASH_PER_RUN = 40; /* 技术用：每次排程最多算几个新指纹（省 CPU，没算完下一分钟继续） */
const BIND_PER_HOUR = 20; /* 技术用：每个 TG 帐号每小时最多送几次绑定（防灌） */
const FB_PER_DAY = 10; /* 技术用：每人每天最多收几则反馈 */
const GH_REPO = OFFI.OWNER + '/' + OFFI.DATA;
const BOT = 'https://t.me/' + OFFI.TG_BOT;
const GH = 'https://github.com/' + OFFI.OWNER + '/robincat-sentinel';

export const invReady = (env) => !!(env.INV_PRIV && env.TG_BOT_TOKEN && env.OWNER_CHAT);

/* ---------- 共用 ---------- */
async function rpc(method, params) { for (const u of RPCS) { try { const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j && 'result' in j) return j.result; } catch {} } throw new Error('rpc'); }
const wa = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
async function pbk(salt, pre, v) { const k = await crypto.subtle.importKey('raw', enc.encode(String(v)), 'PBKDF2', false, ['deriveBits']); return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(pre + salt), iterations: INV_IT }, k, 80))); }
async function sha(s) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))); }
function pemBytes(pem) { const b = atob(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')); return Uint8Array.from(b, (c) => c.charCodeAt(0)); }
async function signData(env, data) { const key = await crypto.subtle.importKey('pkcs8', pemBytes(env.INV_PRIV), { name: 'Ed25519' }, false, ['sign']); const s = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, enc.encode(data))); return btoa(String.fromCharCode(...s)); }
async function tgApi(env, m, b) { try { return await (await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/${m}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json(); } catch { return null; } }
const tgOwner = (env, text) => tgApi(env, 'sendMessage', { chat_id: Number(env.OWNER_CHAT), text: String(text).slice(0, 3900), disable_web_page_preview: true });

/* ---------- 名单逻辑（照 invite.mjs） ---------- */
const blank = () => ({ joins: {}, groups: {}, pend: {}, own: {}, titles: {}, tids: {}, hc: {}, salt: '', rl: {}, fb: {}, pushedH: '', pushedAt: 0, ghSha: '', log: [] });
function codeOwner(I, c) { c = String(c || '').toLowerCase(); if (RESV.includes(c) || c === NANCY_CODE) return NANCY_W; if (I.own[c]) return I.own[c].w; if (/^[0-9a-f]{8}$/.test(c)) { const w = Object.keys(I.joins).find((x) => x.slice(2, 10) === c && I.joins[x].ok); return w || ''; } return ''; }
function myCode(I, w) { if (w === NANCY_W) return 'nancy'; return Object.entries(I.own).find(([, o]) => o.w === w)?.[0] || ''; }
function codeUid(I, c) { c = String(c || '').toLowerCase(); if (I.own[c]) return I.own[c].uid; if (/^[0-9a-f]{8}$/.test(c)) { const w = Object.keys(I.joins).find((x) => x.slice(2, 10) === c && I.joins[x].ok); return w ? I.joins[w].uid : ''; } return ''; }
const codeMine = (I, c, uid) => { const u = codeUid(I, c); return u !== '' && u != null && String(u) === String(uid); };
const counted = (J) => J.ok && !J.nc && !J.lost;
const isRelayUid = (u) => /^rb:/.test(String(u));
function note(I, s) { I.log.push(new Date(Date.now() + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') + ' ' + s); if (I.log.length > 300) I.log.splice(0, I.log.length - 300); }
function rlOk(I, uid) { const now = Date.now(); const a = (I.rl[uid] || []).filter((t) => now - t < 3600e3); if (a.length >= BIND_PER_HOUR) { I.rl[uid] = a; return false; } a.push(now); I.rl[uid] = a; return true; }

/* 雷达或 TG 送来的绑定（照 onMsg 的绑定那段）：回 { ok, msg } */
function doBind(I, P, uid, user) {
  const { k: kind, c: code, w, s: sig, v } = P; const relay = isRelayUid(uid);
  if (!rlOk(I, String(uid))) return { ok: 0, msg: '绑定送太多次了，请一小时后再试' };
  if (kind === 'join') {
    const ow = codeOwner(I, code); if (!ow) return { ok: 0, msg: `找不到邀请码「${code}」，请跟邀请你的人确认` };
    if (ow === w) return { ok: 0, msg: '不能填自己的邀请码喔' };
    if (!relay && codeMine(I, code, uid)) return { ok: 0, msg: '不能用自己的邀请码喔（同一个 TG 帐号）' };
    const J0 = I.joins[w]; if (J0 && J0.code === code && J0.via === 'relay' && (J0.uid == null || J0.uid === '') && !relay) { J0.uid = uid; J0.user = user; }
    const J = I.joins[w]; if (J) return J.code === code ? { ok: 1, msg: '✅ 这个钱包已经绑定好了' } : { ok: 0, msg: `这个钱包已经绑定过邀请码「${J.code}」，每个钱包只能绑一次` };
    I.joins[w] = { code, uid: relay ? '' : uid, user, at: Date.now(), ok: false, sig, v, ...(relay ? { via: 'relay' } : {}) }; if (!relay) delete I.pend[uid]; note(I, `新绑定 ${w.slice(0, 8)}… → ${code}`);
    return { ok: 1, msg: `✅ 绑定完成！你的邀请人是「${code}」，以后不能更改。\n回到雷达，大约 10 分钟内就能打开自动买。` };
  }
  if ((RESV.includes(code) && w !== NANCY_W) || BLOCK.test(code) || /^[0-9a-f]{8}$/.test(code)) return { ok: 0, msg: `「${code}」不能申请，请换一个` };
  const O0 = I.own[code]; if (O0 && O0.w === w && O0.via === 'relay' && (O0.uid == null || O0.uid === '') && !relay) { O0.uid = uid; O0.user = user; }
  const had = myCode(I, w); if (had && had !== code) return { ok: 0, msg: `每个钱包只能有一个专属邀请码，你的是「${had}」\n${BOT}?start=${had}` };
  if (I.own[code] && I.own[code].w !== w) return { ok: 0, msg: `「${code}」已经被别人用了，请回雷达换一个` };
  if (!I.own[code]) { I.own[code] = { w, uid: relay ? '' : uid, user, at: Date.now(), sig, v, ...(relay ? { via: 'relay' } : {}) }; note(I, `新的专属邀请码 ${code}（${w.slice(0, 8)}…）`); }
  return { ok: 1, msg: `✅ 你的专属邀请码「${code}」开通了！\n邀请连结：${BOT}?start=${code}\n\n大约 10 分钟后所有雷达都认得这个码。朋友用你的连结安装、绑定，就算你的邀请。` };
}

/* TG 讯息（照 GangPaper 反馈机器人＋invite.mjs onStart/onMsg/onCmd） */
async function onTg(I, env, m, bindCheck) {
  const say = (t) => tgApi(env, 'sendMessage', { chat_id: m.chat.id, text: t, disable_web_page_preview: true });
  const uid = m.from.id, user = m.from.username || ''; let txt = String(m.text || m.caption || '').trim();
  if (String(uid) === String(env.OWNER_CHAT)) { /* 她回「通过 xxx」「拒绝 xxx」 */
    const x = txt.match(/^(通过|通過|过|過|同意|拒绝|拒絕|拒)\s*@?([A-Za-z0-9_]{4,32})$/);
    if (x) { const h = x[2].toLowerCase(); if (!I.groups[h]) { await say(`找不到 @${h} 的申请`); return; } I.groups[h].st = /通|过|過|同意/.test(x[1]) ? 'ok' : 'no'; if (I.groups[h].st === 'ok') { I.groups[h].t0 = I.titles?.[h]?.t || ''; delete I.groups[h].why; } I.pushedH = ''; await say(I.groups[h].st === 'ok' ? `✅ @${h} 已通过，几分钟内所有雷达都看得到` : `已拒绝 @${h}`); return; }
    if (/^(邀请状态|邀請狀態|invstat)$/i.test(txt)) { await say(`邀请名单：绑定 ${Object.keys(I.joins).length}（生效 ${Object.values(I.joins).filter(counted).length}）、专属码 ${Object.keys(I.own).length}、社群 ${Object.values(I.groups).filter((g) => g.st === 'ok').length}\n最近：\n${I.log.slice(-8).join('\n')}`); return; }
  }
  const sp = txt.match(/^\/start(?:@\w+)?\s+(\S+)/);
  if (sp) { let payload = sp[1]; let x; const pl = payload.toLowerCase(); if (CODE_RE.test(pl) && codeOwner(I, pl)) payload = 'ref_' + pl;
    if ((x = payload.match(/^ref_([a-z0-9_]{3,10})$/))) { I.pend[uid] = { code: x[1], at: Date.now() }; await say(`👋 欢迎！你的朋友邀请你用「罗宾猫雷达」（免费、开源、不碰私钥）。\n\n安装：把下面这一整段复制，丢给你电脑上的 AI：\n\n帮我安装 ${GH} ，我的邀请码是 ${x[1]}\n\n邀请码会自动存进雷达，不用自己填。装好、连上钱包后，雷达会提示你点一下「完成绑定」。`); return; }
    if (/^j_/.test(payload)) { await say('这是旧版雷达的登记方式，已经停用。请先把雷达更新到最新版，再到雷达里按「完成绑定」。'); return; }
    if ((x = payload.match(/^g_([a-z0-9_]{3,10})_([A-Za-z0-9_]{4,32})$/))) { const code = x[1], h = x[2].toLowerCase();
      if (I.groups[h]?.st === 'ok') { await say(`@${h} 已经在热门社群了 ✅`); return; }
      if (!codeMine(I, code, uid)) { await say('这个邀请码不是你的'); return; }
      { const og = I.groups[h]; if (og && og.st === 'wait' && String(og.uid) !== String(uid)) { await say(`@${h} 已经有人申请、正在审核中`); return; } }
      { const o2 = Object.entries(I.groups).find(([h2, g2]) => h2 !== h && g2.st === 'wait' && String(g2.uid) === String(uid)); if (o2) { await say(`你已经有一个社群在审核中（@${o2[0]}），审核完再申请下一个`); return; } }
      const again = I.groups[h]?.st === 'wait' && String(I.groups[h].uid) === String(uid); I.groups[h] = { code, uid, user, at: Date.now(), st: 'wait' };
      await say(`✅ 已送出 @${h} 的申请，审核通过后会出现在所有人的雷达「热门社群」。之后从你的邀请连结装雷达的人，都会看到你的群。`);
      if (!again) await tgOwner(env, `🆕 社群申请上榜：@${h}\n申请人：${user ? '@' + user : uid}（邀请码 ${code}）\nhttps://t.me/${h}\n\n回复「通过 ${h}」或「拒绝 ${h}」`); return; }
  }
  try { if (/%[0-9A-Fa-f]{2}/.test(txt)) txt = decodeURIComponent(txt); } catch {}
  if (/^(?:\/?(?:balance|stat|stats)|查余额|余额|查看.*余额|统计|持仓|暂停|恢复|卖\s|.*买\s*\d+\s*u)/i.test(txt) || /0x[0-9a-fA-F]{40}.*(买|卖)/.test(txt)) { await say('这里是官方反馈／邀请机器人，不能替你下单或查余额。\n遥控指令（查余额、买、卖、持仓、暂停）要传给「你自己的」TG 机器人：在雷达「✨ AI 加功能」点「帮我设定 TG 机器人遥控」，照步骤设定约 3 分钟。'); return; }
  if (/^(?:绑定|綁定|complete\s*binding|bind)$/i.test(txt)) { await say('绑定要在雷达里做：开始使用第 3 步按「完成绑定（点一下）」，钱包签名后会跳到这里，按 Start／送出就完成。\n如果出现 953004，请先在币安 App 的 Agentic 钱包打开「开发者模式」再按一次；或在雷达右上角 🔔 更新到最新版。'); return; }
  const bx = txt.match(/(?:^|[^A-Za-z0-9_-])RCB1\.([A-Za-z0-9_-]{100,140})(?![A-Za-z0-9_-])/i);
  if (!bx && /^(?:\/?(?:邀请码|邀請碼|申请邀请码|申請邀請碼|获取我的邀请码|我的邀请码|我自己的邀请码是多少|邀请码一直在申请|invite|code))\s*[?？]?$/i.test(txt)) { const mine = Object.entries(I.own).find(([, o]) => o && String(o.uid) === String(uid)); await say(mine ? `你的专属邀请码是「${mine[0]}」\n邀请连结：${BOT}?start=${mine[0]}` : '还没有邀请码可以先填「nancy」。\n想要自己的专属邀请码：在雷达完成「连接钱包」后，到雷达的「🎁 邀请好友」卡片填想要的码（3～10 个英文或数字）按「申请」，跳到这里后按 Start 就开通。'); return; }
  if (bx) { let b; try { const s = bx[1].replace(/-/g, '+').replace(/_/g, '/'); b = Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0)); } catch { return; }
    if (b.length < 89) { await say('绑定资料不完整，请回雷达再按一次「完成绑定」'); return; }
    const k = b[0] === 0x63 ? 'code' : b[0] === 0x6a ? 'join' : '', w = '0x' + hex(b.subarray(1, 21)), v = b[21], s = hex(b.subarray(22, 86)), c = new TextDecoder().decode(b.subarray(86)).toLowerCase();
    if (!k || !CODE_RE.test(c)) { await say('绑定资料不对，请回雷达再按一次'); return; }
    const P = { k, c, w, s, v }; if (!bindCheck(P)) { await say('❌ 钱包签名核对不过，没有登记。请回雷达再按一次「完成绑定」'); return; }
    await say(doBind(I, P, uid, user).msg); return; }
  if (I.pend[uid] && /0x[0-9a-fA-F]{40}/.test(txt)) { await say('现在改成在雷达里按「完成绑定」，不用贴钱包地址了。'); return; }
  if (/^\/?(积分|積分|points)(@\w+)?$/i.test(txt)) { await say('积分在雷达「🎁 邀请好友」卡片里看（每几个小时更新一次）。'); return; }
  if (!txt || /^\/start\b/.test(txt)) { await say('👋 这里是罗宾猫雷达的反馈信箱。\n直接把你想要的功能、遇到的问题打出来送出就好（在雷达按「💡 反馈」会帮你整理好格式）。\nNancy 会看过每一则，好的建议会做进下一个官方版本。'); return; }
  if (/^\//.test(txt)) return;
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); if (I.fb.d !== day) I.fb = { d: day, n: {} }; const n = (I.fb.n[uid] || 0) + 1; I.fb.n[uid] = n; if (n > FB_PER_DAY) return;
  await tgOwner(env, `💬 罗宾猫雷达新反馈 ${user ? '@' + user : (m.from.first_name || uid)}${m.photo || m.document ? '（附图片，请到机器人看）' : ''}\n${txt.slice(0, 800)}`);
  await say(n === FB_PER_DAY ? '✅ 收到了，谢谢！（今天已经收满 10 则，明天再来～）' : '✅ 收到了，谢谢你的反馈！Nancy 会看。');
}

/* 链上核对（照 verify／inv2Recheck／inv2Tid）：每次排程少量 */
async function verifyChain(I) {
  let n = 0; for (const [u, p] of Object.entries(I.pend)) if (!p || Date.now() - (p.at || 0) > 7 * 86400e3) delete I.pend[u];
  for (const [w, J] of Object.entries(I.joins)) { if (n >= 10) break;
    if (!J.ok) { if (Date.now() - J.at > 7 * 86400e3 || (J.chk && Date.now() - J.chk < 30 * 60e3)) continue; J.chk = Date.now(); n++;
      try { const b = await rpc('eth_call', [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(w) }, 'latest']); const tx = parseInt(await rpc('eth_getTransactionCount', [w, 'latest']), 16);
        if (b && BigInt(b) > 0n && tx >= 5) { J.ok = true; J.okAt = Date.now(); try { const r = await rpc('eth_call', [{ to: '0x' + REGISTRY, data: '0x2f745c59' + wa(w) + '0'.repeat(64) }, 'latest']); if (r && r.length >= 66) { const tid = BigInt(r.slice(0, 66)).toString(); J.tid = tid; const o = I.tids[tid]; if (o && o !== w && I.joins[o]) J.nc = 'dupTok'; else I.tids[tid] = w; } } catch {} note(I, `${w.slice(0, 8)}… 有效（${J.code}）`); } } catch {} continue; }
    if (J.bchk && Date.now() - J.bchk < 6 * 3600e3) continue; n++;
    try { const b = await rpc('eth_call', [{ to: '0x' + REGISTRY, data: '0x70a08231' + wa(w) }, 'latest']); if (b && /^0x[0-9a-f]*$/i.test(b)) { J.lost = BigInt(b) === 0n; J.bchk = Date.now(); } } catch {} }
}

async function titles(I) { let n = 0; for (const h of [OWN, ...Object.entries(I.groups).filter(([, g]) => g.st === 'ok').map(([h]) => h)]) { const tt = I.titles[h]; if (tt && Date.now() - tt.at < (tt.img ? 86400e3 : 3600e3)) continue; if (++n > 5) break;
  try { const html = await (await fetch('https://t.me/' + h)).text(); const m = html.match(/<meta property="og:title" content="([^"]{1,80})"/); const mi = html.match(/<meta property="og:image" content="(https:\/\/[a-z0-9.-]*telesco\.pe\/[^"]{1,900})"/); if (m) I.titles[h] = { t: m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), img: mi ? mi[1] : '', at: Date.now() }; } catch {} } }

/* 组名单（照 publish 的 inv2 新仓库那段：type invites、v4、salt、vh/ch/wk/rw/groups/gq） */
async function build(I) {
  const H = async (pre, v) => { const k = pre + v; if (I.hc[k]) return I.hc[k]; if ((I._hn = (I._hn || 0) + 1) > HASH_PER_RUN) return null; return (I.hc[k] = await pbk(I.salt, pre, v)); };
  const uset = {}; for (const [w, J] of Object.entries(I.joins)) if (counted(J)) (uset[J.code] = uset[J.code] || new Set()).add(J.uid != null && J.uid !== '' ? 'u' + J.uid : 'w' + w);
  const codes = {}; for (const [c, s] of Object.entries(uset)) codes[c] = s.size;
  const valid = [...new Set([NANCY_CODE, ...RESV, ...Object.keys(I.own), ...Object.entries(I.joins).filter(([, J]) => J.ok).map(([w]) => w.slice(2, 10)), ...Object.keys(codes).filter((c) => codeOwner(I, c))])];
  for (const [h, g] of Object.entries(I.groups)) { if (g.st !== 'ok' || h === OWN) continue; const t = I.titles?.[h]?.t; if (!t) continue; if (!g.t0) { g.t0 = t; continue; } if (t !== g.t0) { g.st = 'wait'; g.why = '改名'; I._rename = (I._rename || []).concat(h); } }
  const T = (h) => I.titles?.[h]?.t || '', IMG = (h) => I.titles?.[h]?.img || '';
  const groups = [{ h: OWN, t: T(OWN), img: IMG(OWN), n: 0, top: 1 }, ...Object.entries(I.groups).filter(([h, g]) => g.st === 'ok' && h !== OWN).map(([h, g]) => ({ h, t: T(h), img: IMG(h), code: g.code, n: codes[g.code] || 0 })).sort((a, b) => b.n - a.n)];
  const gq = Math.max(0, groups.length - 51); groups.splice(51);
  const vh = [], ch = {}, wk = []; let miss = 0;
  for (const c of valid) { const x = await H('rcv4:', c); if (x) vh.push(x); else miss++; }
  for (const [c, n] of Object.entries(codes)) { const x = await H('rcv4:', c); if (x) ch[x] = n; else miss++; }
  for (const [w, J] of Object.entries(I.joins)) if (J.ok || J.sig) { const x = await H('rcw4:', w.toLowerCase() + '|' + J.code); if (x) wk.push(x); else miss++; }
  const g2 = []; for (const { code, ...g } of groups) { if (code) { const x = await H('rcv4:', code); if (x) g2.push({ ...g, ch: x }); else miss++; } else g2.push(g); }
  const rws = new Set([NANCY_W]); for (const [w, J] of Object.entries(I.joins)) if (J.ok || J.sig) rws.add(w.toLowerCase()); for (const o of Object.values(I.own)) if (o?.w) rws.add(String(o.w).toLowerCase());
  const rw = []; for (const w of rws) rw.push((await sha('rcrelay1:' + w)).slice(0, 24));
  if (miss) return null; /* 指纹还没算完 → 这次不发布（下一分钟继续算） */
  return { type: 'invites', v: 4, salt: I.salt, it: INV_IT, vh: [...new Set(vh)].sort(), ch, wk: [...new Set(wk)].sort(), rw: rw.sort(), groups: g2, gq };
}

async function ghPut(env, I, name, body) { if (!env.GH_TOKEN) return false; const api = `https://api.github.com/repos/${GH_REPO}/contents/${name}`; const H = { Authorization: 'Bearer ' + env.GH_TOKEN, 'User-Agent': 'robincat-relay', Accept: 'application/vnd.github+json' };
  const sk = 'sha:' + name; if (!I[sk]) { const g = await fetch(api, { headers: H }).catch(() => null); if (g?.ok) I[sk] = (await g.json()).sha; }
  const r = await fetch(api, { method: 'PUT', headers: H, body: JSON.stringify({ message: name + ' ' + new Date().toISOString().slice(0, 16), content: btoa(String.fromCharCode(...enc.encode(body))), ...(I[sk] ? { sha: I[sk] } : {}) }) }).catch(() => null);
  if (!r) return false; if (r.status === 409 || r.status === 422) { I[sk] = ''; return false; } if (r.ok) { I[sk] = (await r.json()).content?.sha || ''; return true; } return false; }

/* ---------- Durable Object 里跑（物件名 inv-main） ---------- */
export async function invDo(obj, req, env, tools) {
  const iu = new URL(req.url); const st = obj.ctx.storage;
  let I = (await st.get('I')) || blank(); I = { ...blank(), ...I };
  const save = async () => { delete I._hn; await st.put('I', I); };
  if (iu.pathname === '/_inv_pub') { const p = await st.get('pub'); return p ? new Response(p, { headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ err: 'not loaded' }), { status: 503 }); }
  if (iu.pathname === '/_inv_bind') { if (!I.salt) return new Response(JSON.stringify({ wait: 1 })); /* 还没汇入资料 → 先不处理，留在队列 */ const { P } = await req.json(); const r = doBind(I, P, 'rb:' + P.w, ''); await save(); return new Response(JSON.stringify(r)); }
  if (iu.pathname === '/_inv_tg') { const up = await req.json(); const m = up.message; if (m?.from && m.chat?.type === 'private') { await onTg(I, env, m, tools.bindCheck); await save(); } return new Response('ok'); }
  if (iu.pathname === '/_inv_import') { const D = await req.json(); if (!D || typeof D.joins !== 'object' || typeof D.own !== 'object' || !/^[0-9a-f]{32}$/.test(String(D.salt || ''))) return new Response(JSON.stringify({ err: 'fmt' }), { status: 400 });
    I = { ...blank(), joins: D.joins, own: D.own, groups: D.groups || {}, pend: D.pend || {}, titles: D.titles || {}, tids: D.tids || {}, salt: D.salt, hc: D.hc || {}, seq: Math.max(+D.seq || 0, +I.seq || 0) }; note(I, `从 GangPaper 汇入：绑定 ${Object.keys(I.joins).length}、专属码 ${Object.keys(I.own).length}`); await save();
    return new Response(JSON.stringify({ ok: 1, joins: Object.keys(I.joins).length, own: Object.keys(I.own).length })); }
  if (iu.pathname === '/_inv_export') return new Response(JSON.stringify({ day: new Date().toISOString().slice(0, 10), joins: I.joins, own: I.own, groups: I.groups }));
  if (iu.pathname === '/_inv_tick') { /* 每分钟（Cron）：链上核对 → 社群标题 → 组名单 → 有变才签名发布 */
    if (!I.salt) return new Response('no data');
    try { await verifyChain(I); } catch {} try { await titles(I); } catch {}
    const core = await build(I);
    if (I._rename?.length) { for (const h of I._rename) await tgOwner(env, `⚠️ @${h} 改了群名，已先下榜。\nhttps://t.me/${h}\n\n回复「通过 ${h}」重新上榜，或「拒绝 ${h}」`); delete I._rename; }
    if (core) { const h = await sha(JSON.stringify(core)); if (h !== I.pushedH || Date.now() - (I.pushedAt || 0) > 6 * 3600e3) {
      I.seq = Math.max(Date.now(), (+I.seq || 0) + 1); const data = JSON.stringify({ ...core, at: Date.now(), seq: I.seq }); const body = JSON.stringify({ data, sig: await signData(env, data) });
      await st.put('pub', body); I.pushedH = h; I.pushedAt = Date.now(); I.ghPend = 1; } }
    if (I.ghPend) { const body = await st.get('pub'); if (body && await ghPut(env, I, 'invites.json', body)) I.ghPend = 0; }
    await save(); return new Response('ok'); }
  return new Response('not found', { status: 404 });
}
