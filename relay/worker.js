// 罗宾猫雷达 · 手机转接站（Cloudflare Worker + Durable Object）
// 只做一件事：把「电脑雷达」和「手机页面」之间的加密讯息互相转送。
// 金钥只在电脑和手机上（QR 码里，网址 # 后面的部分不会送到伺服器），转接站看不到内容、也伪造不了指令。
import { DurableObject } from 'cloudflare:workers';
import { ICONS } from './icons.js';
import PHONE from './phone.html';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/* ── 邀请码核对（她 11/3 14:32：只有绑定了有效邀请码的雷达能用手机连结）──
   ① 名单：官方发布到 GitHub robincat-radar-data/invites.json（repo.cjs 的 DATA），有官方签名（Ed25519），这里核对签名才相信
   ② 本人：电脑雷达附上「钱包签的邀请绑定」（EIP-712），这里还原出签名的钱包，必须是名单里的钱包
   改自己电脑上的程式跳过邀请码画面，在这里还是过不了 */
import OFFI from '../repo.cjs'; /* NEW-100：官方来源只写在 repo.cjs（打包时一起包进来） */
const OFFICIAL_PUB = OFFI.PUBKEY;
const INV_URL = OFFI.DATA_RAW + 'invites.json';
const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => Uint8Array.from(h.match(/../g) || [], (x) => parseInt(x, 16));
const kh = (s) => keccak_256(enc.encode(s));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const pad32 = (h) => unhex(h.padStart(64, '0'));
const BIND_ZERO = '0x0000000000000000000000000000000000000000'; /* BIND-FIX 11/5：绑定签名 domain 三种写法（没有／自己钱包／零地址 verifyingContract），跟 bind.mjs BIND_VC 一样 */
function bindDigest(kind, code, wallet, vc = '') {
  const dom = vc ? keccak_256(cat(kh('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), kh('RobinCat Radar'), kh('1'), pad32((56).toString(16)), pad32(vc.slice(2)))) : keccak_256(cat(kh('EIP712Domain(string name,string version,uint256 chainId)'), kh('RobinCat Radar'), kh('1'), pad32((56).toString(16))));
  const st = keccak_256(cat(kh('Bind(string kind,string code,address wallet)'), kh(kind), kh(code), pad32(wallet.slice(2))));
  return keccak_256(cat(unhex('1901'), dom, st));
}
function recover(digest, sig, v) { const s = secp256k1.Signature.fromCompact(sig).addRecoveryBit(v); const pub = s.recoverPublicKey(digest).toRawBytes(false); return '0x' + hex(keccak_256(pub.slice(1)).slice(12)); }
let INV = { at: 0, rw: null, raw: '' }; let INV_SEQ = 0; const INV_RETRY_BACK = 9 * 60e3; /* 运作：失败后把「上次抓」往前推，约 1 分钟后再试 */
/* OPS-RT4：名单要 type＝'invites'、seq 不能比上次收过的旧（seq 记在 Durable Object「sig-seq」，全球一致、重部署也记得）→ 回放旧名单（已撤销的码／钱包复活）、拿别种签名档冒充都不收 */
async function seqOk(env, type, seq) { if (!Number.isSafeInteger(seq) || !(seq > 0)) return false; try { const r = await (await env.ROOM.get(env.ROOM.idFromName('sig-seq')).fetch('https://do/_seq?' + new URLSearchParams({ t: type, s: String(seq) }))).json(); return !!r.ok; } catch { return false; } }
async function members(env) {
  if (Date.now() - INV.at < 10 * 60e3) return INV.rw;
  try {
    const j = await (await fetch(INV_URL + '?t=' + Math.floor(Date.now() / 300e3), { cf: { cacheTtl: 120 } })).json();
    const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(OFFICIAL_PUB), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify']);
    if (!(await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(atob(j.sig), (c) => c.charCodeAt(0)), enc.encode(j.data)))) throw new Error('bad sig');
    const D = JSON.parse(j.data); if (D.type !== 'invites') throw new Error('bad type'); if (!(D.seq >= INV_SEQ) || !(await seqOk(env, 'invites', D.seq))) throw new Error('old');
    if (Array.isArray(D.rw)) INV = { at: Date.now(), rw: new Set(D.rw), raw: JSON.stringify({ data: j.data, sig: j.sig }) }; INV_SEQ = D.seq;
  } catch { INV.at = Date.now() - INV_RETRY_BACK; } /* H8-D14：读不到时不要每个请求都重抓（隔一分钟再试）；读到旧的／不对的就继续用手上的 */
  return INV.rw;
}
/* PHONE-1：线上金钥（AVE 看盘上传、作者手机通行证）只用环境变数 ONLINE_PUBKEY（Ed25519 SPKI DER base64），不用发布金钥 PUBKEY。
   值由 `node sign_radar.mjs onlinekey <树>` 产生。没设 → 回 null（呼叫的地方一律拒绝），不会退回用发布金钥 */
async function onlineVerify(env, sigB64, data) {
  const pk = String(env?.ONLINE_PUBKEY || '').trim(); if (!pk) return null;
  if (typeof sigB64 !== 'string' || typeof data !== 'string') return false;
  try { const key = await crypto.subtle.importKey('spki', Uint8Array.from(atob(pk), (c) => c.charCodeAt(0)), { name: 'Ed25519' }, false, ['verify']); return await crypto.subtle.verify({ name: 'Ed25519' }, key, Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0)), enc.encode(data)); } catch { return false; }
}
async function checkBind(env, o) { /* o＝{ w, k, c, s, v }（POST /session 的内容，不在网址里） */
  const w = String(o?.w || '').toLowerCase(), k = o?.k, c = String(o?.c || '').toLowerCase(), s = String(o?.s || '').toLowerCase(), v = Number(o?.v);
  if (!/^0x[0-9a-f]{40}$/.test(w) || !['join', 'code'].includes(k) || !/^[a-z0-9]{3,10}$/.test(c) || !/^[0-9a-f]{128}$/.test(s)) return '这台雷达还没完成邀请码绑定（要先在雷达输入邀请码、用钱包签名绑定）';
  if (!(await inList(env, w))) return INV.rw ? '这个钱包的邀请码绑定还没生效（刚绑定的话等几分钟）' : '暂时读不到邀请名单，等一下再试';
  let ok = false; for (const vc of ['', w, BIND_ZERO]) { try { const d = bindDigest(k, c, w, vc); for (const r of (v === 0 || v === 1) ? [v, 1 - v] : [0, 1]) if (recover(d, s, r) === w) { ok = true; break; } } catch {} if (ok) break; } /* BIND-FIX */
  return ok ? '' : '邀请绑定的签名核对不过';
}
async function inList(env, w) { const rw = await members(env); if (!rw) return false; const h = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('rcrelay1:' + w))).slice(0, 12)); return rw.has(h); }
/* ── OPS-RT15：短时效通行证（session token）。绑定签名／作者通行证只在 POST /session 的内容里出现一次，换到 { t, exp }；
   之后 HTTP（/ave、/aveboard）用 header x-rc-session、手机连结的电脑端 WebSocket 用「连上后第一则讯息 {"auth": t}」。网址里不再有任何签名。
   t＝base64url(JSON{id,c,r,exp}).HMAC；HMAC 金钥用 Cloudflare 秘密变数 SESSION_KEY，没设就由 Durable Object「sess-key」第一次自动产生并保存。
   有效时间＝wrangler.toml 的 SESSION_TTL_S（营运设定，没设就不发通行证）。钱包的通行证每次使用都再对一次邀请名单（被撤销就失效） ── */
const b64u = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (t) => { const x = t.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(x + '='.repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
let SKEY = null;
async function sessKey(env) { if (SKEY) return SKEY; let raw = String(env?.SESSION_KEY || '').trim(); if (!raw) raw = await (await env.ROOM.get(env.ROOM.idFromName('sess-key')).fetch('https://do/_skey')).text(); if (!raw) throw new Error('no key'); SKEY = await crypto.subtle.importKey('raw', enc.encode(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); return SKEY; }
async function sessMake(env, claims) { const ttl = envNum(env, 'SESSION_TTL_S'); if (ttl == null) return null; const exp = Date.now() + ttl * 1000; const p = b64u(enc.encode(JSON.stringify({ ...claims, exp }))); const sg = new Uint8Array(await crypto.subtle.sign('HMAC', await sessKey(env), enc.encode('rcsess1:' + p))); return { t: p + '.' + b64u(sg), exp }; }
async function sessCheck(env, t) { try { t = String(t || ''); const m = t.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/); if (!m) return null; if (!(await crypto.subtle.verify('HMAC', await sessKey(env), unb64u(m[2]), enc.encode('rcsess1:' + m[1])))) return null;
  const C = JSON.parse(new TextDecoder().decode(unb64u(m[1]))); if (!C || typeof C.id !== 'string' || !(Date.now() < C.exp)) return null; if (C.id !== 'owner' && !(await inList(env, C.id))) return null; return C; } catch { return null; } }
const sessOf = async (req, env) => { const C = await sessCheck(env, req.headers.get('x-rc-session')); return C && C.u !== 'avews' ? C : null; }; /*RISK-FIX 7：手机的推送通行证（u=avews）只能连 /avews，不能查 /ave、/aveboard */
const SESS_BODY_MAX = 4 * 1024; /* 运作：POST /session 内容上限（绑定签名约 300 字） */
async function sessionNew(req, env) { const t = await req.text(); if (t.length > SESS_BODY_MAX) return J({ err: 'too big' }, 413); let o; try { o = JSON.parse(t); } catch { return J({ err: 'bad json' }, 400); } if (!o || typeof o !== 'object') return J({ err: 'bad json' }, 400);
  let claims;
  if (o.from != null) { /*RISK-FIX 7：用电脑的通行证换一张给手机的「只能连 /avews」通行证（u=avews；不能再拿来换、不能当电脑端） */ const P = await sessCheck(env, String(o.from)); if (!P || P.u === 'avews' || o.u !== 'avews') return J({ err: 'session' }, 401);
    let S2 = null; try { S2 = await sessMake(env, { id: P.id, c: String(P.c || ''), ...(P.r ? { r: P.r } : {}), u: 'avews' }); } catch {} if (!S2) return J({ err: 'SESSION_TTL_S not set in wrangler.toml [vars]' }, 503); return J(S2); }
  if (o.o) { const room = String(o.room || ''); if (!ROOM_RE.test(room)) return J({ err: 'bad room' }, 400); /* 作者本人的雷达：线上金钥 online.pem 签「rcrelay1-owner:房间号」，用 ONLINE_PUBKEY 核对；通行证只能用在这个房间（和 AVE） */
    const ok = await onlineVerify(env, String(o.o).replace(/-/g, '+').replace(/_/g, '/'), 'rcrelay1-owner:' + room); if (ok === null) return J({ err: '转接站还没设 ONLINE_PUBKEY，作者通行证核对不了' }, 503); if (!ok) return J({ err: '官方通行证核对不过' }, 403); claims = { id: 'owner', c: '', r: room, u: o.u === 'ave' ? 'ave' : 'pc' }; } /*RISK-FIX 7：通行证带用途（pc＝手机连结的电脑端，绑这个房间；ave＝只查 AVE） */
  else { const why = await checkBind(env, o); if (why) return J({ err: why }, 403); const room = o.room == null ? '' : String(o.room); if (room && !ROOM_RE.test(room)) return J({ err: 'bad room' }, 400); claims = { id: String(o.w).toLowerCase(), c: String(o.c).toLowerCase(), ...(room ? { r: room, u: 'pc' } : { u: 'ave' }) }; } /*RISK-FIX 7：一般钱包的电脑端通行证也绑房间 */
  let S = null; try { S = await sessMake(env, claims); } catch {} if (!S) return J({ err: 'SESSION_TTL_S not set in wrangler.toml [vars]' }, 503); return J(S); }
/* ── 11/3 她选 3：用户点开币也看到 AVE 数据。金钥只在这里（Cloudflare 秘密变数 AVE_KEY），不给用户。
   只准查白名单里的「读取」接口；同样的查询大家共用快取；每天有总用量上限，超过就暂停到隔天，不会把额度用爆 ── */
const AVE_OK = [[/^\/v2\/tokens\/0x[0-9a-f]{40}-(bsc|robinhood)$/, 3, 5], [/^\/v2\/contracts\/0x[0-9a-f]{40}-(bsc|robinhood)$/, 1800, 10], [/^\/v2\/tokens\/top100\/0x[0-9a-f]{40}-(bsc|robinhood)\?limit=100$/, 60, 10], [/^\/v2\/klines\/(token|pair)\/0x[0-9a-f]{40}(_[a-z0-9]+)?-(bsc|robinhood)\?interval=(1|5|15|60|240|1440)&limit=(200|600|1000)$/, 5, 10], [/^\/v2\/address\/walletinfo\?chain=(bsc|robinhood)&wallet_address=0x[0-9a-f]{40}$/, 1800, 5], [/^\/v2\/address\/walletinfo\/tokens\?chain=(bsc|robinhood)&pageSize=100&wallet_address=0x[0-9a-f]{40}$/, 1800, 10], [/^\/v2\/address\/smart_wallet\/list\?chain=(bsc|robinhood)(&sort=(profit|win_rate|total_profit|pnl))?$/, 3600, 5]];
const MC = new Map(), MC_MAX = 2000; /* H8-D5：这个执行个体自己的快取（*.workers.dev 上 caches.default 可能不生效） */
const mcGet = (k) => { const v = MC.get(k); if (!v) return null; if (Date.now() > v.exp) { MC.delete(k); return null; } return v.body; };
const mcPut = (k, body, ttlS) => { MC.set(k, { body, exp: Date.now() + ttlS * 1000 }); if (MC.size > MC_MAX) MC.delete(MC.keys().next().value); };
const envNum = (env, k) => { const v = Number(env?.[k]); return Number.isFinite(v) && v > 0 ? v : null; }; /* 没设＝不限（只有总上限） */
const J = (o, st = 200, ttl = 0) => new Response(JSON.stringify(o), { status: st, headers: { ...SEC, 'content-type': 'application/json', 'cache-control': ttl ? `public, max-age=${ttl}` : 'no-store' } });
async function aveProxy0(req, u, env) { /* AVE-WSS：外面包了一层 aveProxy（同时的相同请求只打一次、太快时排队） */
  const p = String(u.searchParams.get('p') || ''); const rule = AVE_OK.find(([re]) => re.test(p)); if (!rule || !env.AVE_KEY) return J({ err: 'not allowed' }, 400);
  const S = await sessOf(req, env); if (!S) return J({ err: 'session' }, 401); /* OPS-RT15：只认 header 里的通行证 */
  { const b = mcGet(p); if (b) return new Response(b, { headers: { ...SEC, 'content-type': 'application/json', 'x-cache': 'mem' } }); }
  const ck = new Request('https://ave-cache.robincat/' + p); const hit = await caches.default.match(ck); if (hit) return new Response(hit.body, { headers: { ...SEC, 'content-type': 'application/json', 'x-cache': 'hit' } });
  const w = S.id === 'owner' ? 'owner' : String(S.id).slice(0, 64), code = S.id === 'owner' ? '' : String(S.c || '').slice(0, 16); const bg = u.searchParams.get('bg') === '1'; /* OPS-RT6：计量键只来自通行证（作者固定 owner），不能自己填 */
  /* H8-D2：全部用量记在同一个 Durable Object（全球一致）：总额度、每个钱包每天的额度（AVE_USER_DAY_CU）、每个钱包每秒几次（AVE_USER_RPS）、送到 AVE 的总速度；背景查询让你点的先 */
  const ev = (k) => String(envNum(env, k) ?? ''); /* 额度全部是 wrangler.toml [vars] 的营运设定；没设＝那一项不限 */
  const mq = new URLSearchParams({ cu: String(rule[2]), w, code, bg: bg ? '1' : '0', ucap: ev('AVE_USER_DAY_CU'), urps: ev('AVE_USER_RPS'), ccap: ev('AVE_CODE_DAY_CU'), grps: ev('AVE_GLOBAL_RPS'), cap: ev('AVE_DAY_CU'), bgpct: ev('AVE_BG_STOP_PCT') });
  const m = await (await env.ROOM.get(env.ROOM.idFromName('ave-meter')).fetch('https://do/_meter?' + mq)).json();
  if (['daily cap', 'user cap', 'code cap', 'bg paused'].includes(m.deny)) return J({ err: m.deny }, 429); if (m.deny) return new Response(JSON.stringify({ err: m.deny }), { status: 429, headers: { ...SEC, 'content-type': 'application/json', 'retry-after': '2' } });
  const r = await fetch('https://prod.ave-api.com' + p, { headers: { 'X-API-KEY': String(env.AVE_KEY).trim() } }); const body = await r.text();
  if (r.status === 429) return new Response(JSON.stringify({ err: 'ave busy' }), { status: 503, headers: { ...SEC, 'content-type': 'application/json', 'retry-after': '2' } }); /* H8-D2 */
  if (!r.ok) return J({ err: 'ave ' + r.status }, 502);
  let good = false; try { good = JSON.parse(body)?.status === 1; } catch {} if (!good) return new Response(body, { status: 502, headers: { ...SEC, 'content-type': 'application/json', 'cache-control': 'no-store' } }); /* H8-D7：AVE 回错误就不快取 */
  mcPut(p, body, rule[1]); const resp = new Response(body, { headers: { ...SEC, 'content-type': 'application/json', 'cache-control': `public, max-age=${rule[1]}` } }); await caches.default.put(ck, resp.clone()); return resp;
}
let BOARD_MEM = { at: 0, body: '' }; const BOARD_MEM_MS = 60e3, BOARD_MAX_BYTES = 1.8e6; /* 运作：看盘资料在记忆体留 60 秒／上传大小上限（位元组） */
async function aveBoard(req, u, env) {
  const stub = env.ROOM.get(env.ROOM.idFromName('ave-board'));
  if (req.method === 'POST') { const t = await req.text(); if (enc.encode(t).length > BOARD_MAX_BYTES) return J({ err: 'too big' }, 413); /* H8-D6：照位元组算 */ let j; try { j = JSON.parse(t); } catch { return J({ err: 'bad json' }, 400); }
    const ok = await onlineVerify(env, j && j.sig, j && j.data); if (ok === null) return J({ err: 'ONLINE_PUBKEY not set: run `node sign_radar.mjs onlinekey <tree>` and put the printed key in wrangler.toml [vars] ONLINE_PUBKEY' }, 503); if (!ok) return J({ err: 'bad sig' }, 403);
    try { const at = +JSON.parse(j.data).at || 0; if (Math.abs(Date.now() - at) > 15 * 60e3) return J({ err: 'stale' }, 400); } catch { return J({ err: 'bad sig' }, 403); }
    await stub.fetch('https://do/_board', { method: 'PUT', body: t }); BOARD_MEM = { at: Date.now(), body: t }; return J({ ok: 1 }); }
  if (!(await sessOf(req, env))) return J({ err: 'session' }, 401); /* OPS-RT15 */
  if (BOARD_MEM.body && Date.now() - BOARD_MEM.at < BOARD_MEM_MS) return new Response(BOARD_MEM.body, { headers: { ...SEC, 'content-type': 'application/json', 'x-cache': 'mem' } }); /* H8-D5 */
  const ck = new Request('https://ave-cache.robincat/board'); const hit = await caches.default.match(ck); if (hit) return new Response(hit.body, { headers: { ...SEC, 'content-type': 'application/json' } });
  const r = await stub.fetch('https://do/_board'); if (!r.ok) return J({ err: 'no board yet' }, 404); const bt = await r.text(); BOARD_MEM = { at: Date.now(), body: bt }; const resp = new Response(bt, { headers: { ...SEC, 'content-type': 'application/json', 'cache-control': 'public, max-age=60' } }); await caches.default.put(ck, resp.clone()); return resp;
}


/* ── AVE-WSS（11/4）：AVE 即时推送中继。用户（雷达画面）连 /avews（WebSocket），连上后第一则讯息 {"auth": 通行证}（跟 /ave 同一个通行证，网址里没有任何签名）。
   转接站用金钥连 AVE WSS（金钥只在 Cloudflare 秘密变数 AVE_KEY，不给用户、不印出来）；全部用户共用同一个集线器物件「ave-wss」的上游连线：
   相同订阅合并成一个、没人看了就退订、上游断线自动重连（心跳照 AVE 文件：{"method":"ping"} → "pong"）。
   转给用户的只有整理过的栏位（不转 AVE 原文）。只开放三种：价格 p（代币）、成交 x（代币的全部池子）、K 线 k（池子＋周期）。 ── */
const AVE_WSS_UP = 'https://wss.ave-api.xyz'; /* AVE 文件的 wss://wss.ave-api.xyz（Workers 用 https＋Upgrade 连） */
const aveWsUrl = (env) => { const t = String(env?.AVE_WSS_TEST_URL || ''); return /^http:\/\/127\.0\.0\.1:\d+$/.test(t) ? t : AVE_WSS_UP; }; /* 测试用：只认本机假伺服器；正式部署不要设 AVE_WSS_TEST_URL */
const AVEWS_UP_MAX = 5; /* 运作：AVE API Level 2 方案整个金钥最多 5 条 WSS 连线（全部用户共用）→ 转接站最多开 5 条 */
const AVEWS_UP_SPREAD = 100; /* 运作：每条上游连线放到这么多个订阅，还有空的连线就开下一条分摊（速度优先） */
const AVEWS_UP_SUBS = 1000; /* 运作：单条上游连线最多放几个订阅（AVE 没公布单条上限，待 AVE 确认后调整） */
const AVEWS_USER_SUBS = 60; /* 运作（防滥用，不是交易数字）：每个用户（同一个钱包／作者）全部连线加起来最多同时订阅几个 */
const AVEWS_USER_PC_CONN = 1, AVEWS_USER_PH_CONN = 3; /*RISK-FIX 12 运作（防滥用）：同一个用户同时几条连线——电脑 1 条、手机连结最多 3 台，分开算：电脑重连只换掉旧的电脑连线，手机超过只关最旧的手机，手机不会踢掉电脑 */
const AVEWS_PROTO = 'rcave1'; /*RISK-FIX 8 技术用：/avews 的子协定名（Sec-WebSocket-Protocol：rcave1, 通行证） */
const AVEWS_IP_PEND_MAX = 4; /*RISK-FIX 8 运作（防滥用）：同一个 IP 同时几条还在验证通行证的 /avews 连线 */
const AVEWS_IP_FAIL_MAX = 20, AVEWS_IP_FAIL_WIN_MS = 60e3; /*RISK-FIX 8 运作（防滥用）：同一个 IP 一分钟内通行证不对几次就先拒绝 */
const AVEWS_IP_MEM = 5000; /*RISK-FIX 8 技术用：记 IP 的表上限（超过清空重记） */
const AVEWS_METER_MS = 60e3; /*RISK-FIX 10 技术用：WSS 用量多久写一次进 ave-meter（只记录，不设上限） */
const AVEWS_CMD_WIN_MS = 10e3, AVEWS_CMD_MAX = 30; /* 运作（防滥用）：每条连线每 10 秒最多送几则指令 */
const AVEWS_MSG_MAX = 16 * 1024; /* 技术用：用户送来的单则讯息大小上限（位元组） */
const AVEWS_PING_MS = 20e3, AVEWS_DEAD_MS = 65e3; /* 技术用：对 AVE 送心跳的间隔／多久收不到任何东西就当断线重连 */
const AVEWS_RETRY_MS = [1e3, 3e3, 10e3, 30e3]; /* 技术用：上游断线后第 1、2、3、4 次以上重连前等多久 */
const AVEWS_IDLE_MS = 60e3; /* 技术用：上游没有订阅多久后关掉（省连线） */
const AVEWS_AUTH_MS = 15e3; /* 技术用：用户连上后几秒内要送通行证 */
const AVEWS_TICK_MS = 5e3; /* 技术用：集线器巡逻间隔（心跳、逾时、过期通行证） */
const AVEWS_BAD_MS = 5 * 60e3; /* 技术用：AVE 拒绝的订阅多久后才再试 */
const AVEWS_PRICE_BATCH = 50; /* 技术用：价格订阅一则最多带几个币 */
const AVEWS_PEND_MAX = 2000; /* 技术用：等 AVE 回覆的订阅请求记录上限 */
const AVEWS_ID = /^0x[0-9a-f]{40}-(bsc|robinhood)$/; const AVEWS_IV = ['s1', '1', '5', '15', '30', '60', '120', '240', '1440', '10080'];
function awKey(it) { if (!Array.isArray(it)) return ''; const t = String(it[0] ?? ''), id = String(it[1] ?? '').toLowerCase(), iv = String(it[2] ?? '').toLowerCase(); if (!AVEWS_ID.test(id)) return ''; if (t === 'p' || t === 'x') return t + '|' + id; if (t === 'k' && AVEWS_IV.includes(iv)) return 'k|' + id + '|' + iv; return ''; }
const awItem = (k) => k.split('|');
function awParams(keys) { const P = [], pr = []; for (const k of keys) { const [t, id, iv] = k.split('|'); const j = id.lastIndexOf('-'), a = id.slice(0, j), ch = id.slice(j + 1);
    if (t === 'p') pr.push(k); else if (t === 'x') P.push([['multi_tx', a, ch], [k]]); else P.push([['kline', a, iv === 's1' ? 's1' : 'k' + iv, ch], [k]]); }
  for (let i = 0; i < pr.length; i += AVEWS_PRICE_BATCH) { const ks = pr.slice(i, i + AVEWS_PRICE_BATCH); P.push([['price', ks.map((k) => k.split('|')[1])], ks]); } return P; }
const awN = (v) => { const x = Number(v); return v === '' || v == null || !Number.isFinite(x) ? null : x; };
const awL = (v) => String(v ?? '').toLowerCase();
const AW_IP = new Map(); /*RISK-FIX 8：每个 IP 正在验证几条／最近失败几次（这个执行个体自己的记录） */
async function aveWsRoute(req, env) { if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426, headers: SEC }); if (!env.AVE_KEY) return J({ err: 'not allowed' }, 503);
  /*RISK-FIX 8：升级前先验通行证（放在 Sec-WebSocket-Protocol），没通过的不会进到集线器、不占连线 */
  const ip = String(req.headers.get('cf-connecting-ip') || '?').slice(0, 64), now = Date.now(); let G = AW_IP.get(ip); if (!G) { if (AW_IP.size >= AVEWS_IP_MEM) AW_IP.clear(); AW_IP.set(ip, (G = { p: 0, f: [] })); } G.f = G.f.filter((t) => now - t < AVEWS_IP_FAIL_WIN_MS);
  if (G.p >= AVEWS_IP_PEND_MAX || G.f.length >= AVEWS_IP_FAIL_MAX) return new Response('too many', { status: 429, headers: SEC });
  const pr = String(req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim()); const t = pr[0] === AVEWS_PROTO ? String(pr[1] || '') : '';
  G.p++; let C = null; try { C = t ? await sessCheck(env, t) : null; } catch { C = null; } finally { G.p--; }
  if (!C) { G.f.push(now); return new Response('session', { status: 401, headers: SEC }); }
  const fw = new Request('https://do/_avews', req); fw.headers.set('x-rc-aw', JSON.stringify({ id: C.id, exp: C.exp, ph: C.u === 'avews' ? 1 : 0 })); /* 这个标头只由转接站自己填（盖掉外面送来的） */
  return env.ROOM.get(env.ROOM.idFromName('ave-wss')).fetch(fw); }
/* AVE-WSS（11/4）REST 速度＋额度：AVE L2 方案整个金钥每秒最多 20 次（超过会被 AVE 拒绝，反而更慢）。
   ① 同一个查询正在问 AVE 时，其他人直接等同一个结果（不再打一次 AVE、不算额度）；② 转接站的全体速度（wrangler.toml AVE_GLOBAL_RPS）满了就短暂排队再送，不直接回错误。
   快取只用来合并同一瞬间的重复请求（时间见 AVE_OK），不拿旧资料冒充即时资料 */
const AVE_INFL = new Map(); const AVE_Q_TRIES = 6, AVE_Q_WAIT_MS = 250; /* 技术用：全体速度满了最多排队几次／每次等多久 */
async function aveProxy(req, u, env) {
  const p = String(u.searchParams.get('p') || ''); if (!AVE_OK.find(([re]) => re.test(p)) || !env.AVE_KEY) return J({ err: 'not allowed' }, 400);
  if (!(await sessOf(req, env))) return J({ err: 'session' }, 401); /* 先验通行证，才可以共用别人正在查的结果 */
  const f = AVE_INFL.get(p); if (f) { const b = await f; if (b) return new Response(b, { headers: { ...SEC, 'content-type': 'application/json', 'x-cache': 'join' } }); }
  let done = null; AVE_INFL.set(p, new Promise((ok) => { done = ok; }));
  try { let r = null; for (let i = 0; i < AVE_Q_TRIES; i++) { r = await aveProxy0(req, u, env); if (r.status !== 429 || !r.headers.get('retry-after')) break; await new Promise((ok) => setTimeout(ok, AVE_Q_WAIT_MS)); } /* 只有「太快」（有 retry-after）才排队；额度用完不排 */
    let b = null; if (r.status === 200) { try { b = await r.clone().text(); } catch {} } done(b); return r; }
  catch (e) { done(null); throw e; } finally { AVE_INFL.delete(p); }
}


const ROOM_RE = /^[A-Za-z0-9_-]{32}$/;
const MAX_MSG = 600 * 1024; // 单则讯息上限（看盘资料约 50～150KB）
const MAX_PHONES = 3;
const ENV_RE = /^\{"e":"[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}"\}$/; // S6：加密封包格式（iv 长度固定）
const FRAME_WIN_MS = 10e3, FRAME_MAX = 200; // 运作：每条连线每 10 秒最多转送几则
const PC_LOCK_MS = 7 * 86400e3; // 运作：房间绑定的电脑身分多久没出现才可以换
const G_RE = /^[A-Za-z0-9_-]{43}$/; // RT-11：手机闸门密钥（base64url，长度见正则），电脑连线时带 g=
const PH_TS_MS = 5 * 60e3; // 运作：手机连线证明（ts＋HMAC）的有效时间（防重放用）

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000',
};
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#0b0d11"/><circle cx="96" cy="96" r="70" fill="none" stroke="#22c55e" stroke-width="6" opacity=".55"/><circle cx="96" cy="96" r="44" fill="none" stroke="#22c55e" stroke-width="5" opacity=".8"/><path d="M96 96 L150 52" stroke="#22c55e" stroke-width="7" stroke-linecap="round"/><circle cx="96" cy="96" r="9" fill="#f0b90b"/></svg>`;
const MANIFEST = JSON.stringify({ name: '罗宾猫雷达', short_name: '罗宾猫雷达', scope: '/', display: 'standalone', background_color: '#0b0d11', theme_color: '#0b0d11', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] });

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (u.pathname === '/aveboard' && (req.method === 'GET' || req.method === 'POST')) return aveBoard(req, u, env);
    if (u.pathname === '/session' && req.method === 'POST') return sessionNew(req, env); /* OPS-RT15 */
    if (req.method !== 'GET') return new Response('method', { status: 405 });
    if (u.pathname === '/ave') return aveProxy(req, u, env);
    if (u.pathname === '/avews') return aveWsRoute(req, env); /* AVE-WSS（11/4）：即时推送（WebSocket） */
    if (u.pathname === '/avestat') { const C = await sessOf(req, env); if (!C || C.id !== 'owner') return J({ err: 'session' }, 401); return J(await (await env.ROOM.get(env.ROOM.idFromName('ave-meter')).fetch('https://do/_meter_get')).json()); } /*RISK-FIX 10：只有作者通行证看得到今天的 AVE 用量（REST 单位＋WSS 订阅／推送），跟 AVE 对帐用 */
    if (u.pathname === '/invites.json') { await members(env); return INV.raw ? new Response(INV.raw, { headers: { ...SEC, 'content-type': 'application/json', 'cache-control': 'public, max-age=120' } }) : J({ err: 'not loaded' }, 503); } /* H2-M2：邀请名单镜像（原样的官方签名档，雷达照样核对签名） */
    if (u.pathname === '/' || u.pathname === '/index.html') return new Response(PHONE, { headers: { ...SEC, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-security-policy': CSP } });
    if (u.pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { ...SEC, 'content-type': 'application/manifest+json', 'cache-control': 'max-age=3600' } });
    { const im = u.pathname.match(/^\/icon-(180|192|512)\.png$/); if (im) { const b = atob(ICONS[im[1]]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return new Response(a, { headers: { ...SEC, 'content-type': 'image/png', 'cache-control': 'max-age=86400' } }); } }
    if (u.pathname === '/icon.svg') return new Response(ICON, { headers: { ...SEC, 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' } });
    if (u.pathname === '/health') return new Response('ok', { headers: SEC });
    const m = u.pathname.match(/^\/ws\/([^/]+)$/);
    if (m) {
      const role = u.searchParams.get('r');
      if (!ROOM_RE.test(m[1]) || (role !== 'pc' && role !== 'ph')) return new Response('bad room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const fw = new Request(req); fw.headers.delete('x-rc-pcid'); fw.headers.set('x-rc-room', m[1]); /* S5：这些标头只能由转接站自己填 */
      /* OPS-RT15：电脑端不在网址带签名 → 连上后第一则讯息 {"auth": 通行证}，由房间物件核对（核对前收不到也送不出任何讯息） */
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(fw);
    }
    return new Response('not found', { status: 404, headers: SEC });
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // 心跳：回 pong 不会叫醒转接站，也不计费
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  sockets(role, skip) { return this.ctx.getWebSockets(role).filter((w) => w !== skip && w.readyState === 1 && (role !== 'pc' || this.authed(w))); } /* OPS-RT15：电脑端要先过通行证才算连上 */
  authed(w) { try { return !!w.deserializeAttachment()?.ok; } catch { return false; } }
  sys(ws, o) { try { ws.send(JSON.stringify({ sys: o })); } catch {} }
  refuse(why, code) { const [c, s] = Object.values(new WebSocketPair()); s.accept(); s.send(JSON.stringify({ sys: { deny: why } })); s.close(code, 'denied'); return new Response(null, { status: 101, webSocket: c }); }
  async phGate(iu) {
    /* NAV9：连结手机在「⚙️ 设定」底下 */
    const g = await this.ctx.storage.get('g'); if (!g) return '电脑雷达还没开启手机验证（请把电脑雷达更新到新版、重新打开「⚙️ 设定 → 📱 连结手机」）';
    const ts = Number(iu.searchParams.get('ts')), h = String(iu.searchParams.get('h') || ''); const room = iu.pathname.split('/').pop();
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > PH_TS_MS || !/^[A-Za-z0-9_-]{43}$/.test(h)) return '手机连线证明过期或格式不对（请检查手机时间，或重新扫 QR 码）';
    this.hUsed = this.hUsed || new Map(); const now = Date.now(); for (const [k, t] of this.hUsed) if (now - t > PH_TS_MS * 2) this.hUsed.delete(k); if (this.hUsed.has(h)) return '手机连线证明已经用过（重放）';
    let ok = false; try { const k = await crypto.subtle.importKey('raw', Uint8Array.from(atob(g.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']); ok = await crypto.subtle.verify('HMAC', k, Uint8Array.from(atob(h.replace(/-/g, '+').replace(/_/g, '/') + '='), (c) => c.charCodeAt(0)), enc.encode('rcph1:' + room + ':' + ts)); } catch {}
    if (!ok) return '手机配对金钥不对（请回电脑重新扫 QR 码）'; this.hUsed.set(h, now); return '';
  }
  presence(skip) {
    const pcOn = this.sockets('pc', skip).length > 0, n = this.sockets('ph', skip).length;
    for (const w of this.sockets('ph', skip)) this.sys(w, { pc: pcOn });
    for (const w of this.sockets('pc', skip)) this.sys(w, { ph: n });
  }
  async fetch(req) {
    const iu = new URL(req.url);
    if (iu.pathname === '/_avews') return this.hubAccept(req); /* AVE-WSS：集线器（外面只有 /avews 会转到这里，物件名固定 ave-wss） */
    if (iu.pathname === '/_meter') { /* H8-D2：总额度＋每个钱包每天额度＋每秒速度（全部在这一个物件里，全球一致） */
      const q = iu.searchParams, now = Date.now(), d = new Date(now + 8 * 3600e3).toISOString().slice(0, 10); const cu = Math.max(0, Math.min(100, +q.get('cu') || 0)); const w = String(q.get('w') || '').slice(0, 64), bg = q.get('bg') === '1';
      const num = (k) => { const v = Number(q.get(k)); return Number.isFinite(v) && v > 0 ? v : null; }; const ucap = num('ucap'), urps = num('urps'), grps = num('grps'), cap = num('cap'), ccap = num('ccap'), bgpct = num('bgpct'); const code = String(q.get('code') || '').slice(0, 16); /* OPS-RT6 */
      let m = (await this.ctx.storage.get('m')) || { d, cu: 0, u: {}, c: {} }; if (m.d !== d) m = { d, cu: 0, u: {}, c: {} }; m.u = m.u || {}; m.c = m.c || {};
      this.gq = (this.gq || []).filter((t) => now - t < 1000); this.uq = this.uq || new Map(); const uq = (this.uq.get(w) || []).filter((t) => now - t < 1000);
      let deny = ''; if (cap != null && m.cu + cu > cap) deny = 'daily cap'; else if (bg && cap != null && bgpct != null && m.cu * 100 >= cap * bgpct) deny = 'bg paused'; /* OPS-RT6：全体用到营运设定的比例 → 先停背景查询 */ else if (code && ccap != null && (m.c[code] || 0) + cu > ccap) deny = 'code cap'; /* OPS-RT6：每个邀请码每天的额度 */ else if (w && ucap != null && (m.u[w] || 0) + cu > ucap) deny = 'user cap'; else if (w && urps != null && uq.length >= urps) deny = 'slow down'; else if (grps != null && (this.gq.length >= grps || (bg && this.gq.length >= Math.ceil(grps / 2)))) deny = 'busy'; /* 背景查询只能用一半的速度，你点的优先 */
      if (!deny) { m.cu += cu; if (w) m.u[w] = (m.u[w] || 0) + cu; if (code) m.c[code] = (m.c[code] || 0) + cu; this.gq.push(now); uq.push(now); this.uq.set(w, uq); if (this.uq.size > 5000) this.uq.clear(); await this.ctx.storage.put('m', m); }
      return new Response(JSON.stringify({ d, cu: m.cu, ucu: w ? m.u[w] || 0 : 0, deny })); }
    if (iu.pathname === '/_meter_ws') { /*RISK-FIX 10：WSS 用量（每天一份，跟 REST 额度同一个记录；只记录、不设上限） */ const q = iu.searchParams, d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); const n = (k) => { const v = Number(q.get(k)); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0; };
      let m = (await this.ctx.storage.get('m')) || { d, cu: 0, u: {}, c: {} }; if (m.d !== d) m = { d, cu: 0, u: {}, c: {} }; const W = (m.ws = m.ws || { sub: 0, unsub: 0, push: 0, rx: 0, peak: 0, now: 0 });
      for (const k of ['sub', 'unsub', 'push', 'rx']) W[k] += n(k); W.peak = Math.max(W.peak, n('peak')); W.now = n('now'); W.at = Date.now(); await this.ctx.storage.put('m', m); return new Response('ok'); }
    if (iu.pathname === '/_meter_get') { const m = (await this.ctx.storage.get('m')) || null; return new Response(JSON.stringify(m ? { d: m.d, cu: m.cu, ws: m.ws || null } : {})); } /*RISK-FIX 10*/
    if (iu.pathname === '/_seq') { /* OPS-RT4：签名资料 seq 只能往前（全球一致） */ const t = String(iu.searchParams.get('t') || '').slice(0, 20), sq = Number(iu.searchParams.get('s')); if (!t || !Number.isSafeInteger(sq)) return new Response(JSON.stringify({ ok: false }));
      const k = 'seq:' + t, last = await this.ctx.storage.get(k); if (Number.isSafeInteger(last) && sq < last) return new Response(JSON.stringify({ ok: false, last })); if (!(sq === last)) await this.ctx.storage.put(k, sq); return new Response(JSON.stringify({ ok: true })); }
    if (iu.pathname === '/_skey') { /* OPS-RT15：没设 SESSION_KEY 时，通行证的 HMAC 金钥第一次自动产生、存在这个物件里（外面连不到这个路径：/ws/ 房间号格式不同） */ let k = await this.ctx.storage.get('skey'); if (!k) { const b = new Uint8Array(32); crypto.getRandomValues(b); k = [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); await this.ctx.storage.put('skey', k); } return new Response(k); }
    if (iu.pathname === '/_board') { if (req.method === 'PUT') { await this.ctx.storage.put('b', await req.text()); return new Response('ok'); } const b = await this.ctx.storage.get('b'); return b ? new Response(b) : new Response('none', { status: 404 }); }
    const role = iu.searchParams.get('r');
    if (role === 'pc') { /* OPS-RT15：电脑端先接起来但「还没验证」：连上后第一则讯息要是 {"auth": 通行证}，过了才绑房间、才算连上（见 pcAuth）。同时只留最新一条还没验证的连线 */
      for (const w of this.ctx.getWebSockets('pc')) if (!this.authed(w)) { try { w.close(4008, 'auth pending replaced'); } catch {} }
      const pair = new WebSocketPair(); const [client, server] = Object.values(pair); this.ctx.acceptWebSocket(server, ['pc']);
      const g = String(iu.searchParams.get('g') || ''); server.serializeAttachment({ ok: 0, room: String(req.headers.get('x-rc-room') || ''), g: G_RE.test(g) ? g : '' });
      return new Response(null, { status: 101, webSocket: client }); }
    if (role === 'ph') { /* RT-11：手机连线要带 ts＋h＝HMAC(g, 'rcph1:'+房间+':'+ts)；满了拒绝新的，不踢已连上的 */
      const why = await this.phGate(iu); if (why) return this.refuse(why, 4003);
      if (this.sockets('ph').length >= MAX_PHONES) return this.refuse('这个配对已经有 ' + MAX_PHONES + ' 台手机连着，这台先不接（请关掉其他手机的页面，或等它们断线后再试）', 4001); }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    this.presence();
    return new Response(null, { status: 101, webSocket: client });
  }
  /* ── AVE-WSS 集线器（只在名为 ave-wss 的这一个物件里跑）：全部用户共用最多 AVEWS_UP_MAX 条上游连线；订阅表在记忆体，物件被系统重启过就请用户端重送 ── */
  hub() { if (this.H) return this.H; const H = (this.H = { ref: new Map(), cs: new Map(), at: new Map(), cnt: new Array(AVEWS_UP_MAX).fill(0), up: [], bad: new Map(), rid: 0, tick: null, lastUp: -1, st: { sub: 0, unsub: 0, push: 0, rx: 0, peak: 0 }, stAt: Date.now() }); /*RISK-FIX 10：H.st＝还没写进 ave-meter 的 WSS 用量 */
    for (const w of this.ctx.getWebSockets('avews')) if (this.awA(w).ok) this.sys(w, { resub: 1 }); return H; }
  awA(w) { try { return w.deserializeAttachment() || {}; } catch { return {}; } }
  atSet(k, i) { const H = this.hub(); H.at.set(k, i); H.cnt[i]++; }
  atDel(k) { const H = this.hub(); const i = H.at.get(k); if (i == null) return; H.at.delete(k); H.cnt[i]--; if (!H.cnt[i] && H.up[i]) H.up[i].idle = Date.now(); }
  hubAccept(req) { if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 }); this.hub(); const [client, server] = Object.values(new WebSocketPair()); let V = null; try { V = JSON.parse(req.headers.get('x-rc-aw') || 'null'); } catch {} if (!V || typeof V.id !== 'string' || !(Date.now() < +V.exp)) return new Response('session', { status: 401 }); /*RISK-FIX 8：只收转接站验过通行证的连线 */
    this.ctx.acceptWebSocket(server, ['avews']); server.serializeAttachment({ ok: 1, ann: 0, id: V.id, exp: +V.exp, ph: V.ph ? 1 : 0, at: Date.now() }); this.hubTick(); return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': AVEWS_PROTO } }); }
  hubTick() { const H = this.hub(); if (!H.tick) H.tick = setInterval(() => this.hubPatrol(), AVEWS_TICK_MS); }
  hubPatrol() { const H = this.hub(), now = Date.now(); const socks = this.ctx.getWebSockets('avews');
    for (const w of socks) { const A = this.awA(w); if (!A.ok) { if (now - A.at > AVEWS_AUTH_MS) { try { w.close(4003, 'auth timeout'); } catch {} this.hubDrop(w); } } else if (!(now < A.exp)) { this.sys(w, { expired: 1 }); try { w.close(4001, 'session expired'); } catch {} this.hubDrop(w); } }
    H.up.forEach((U, i) => { if (!U) return; if (U.pend.size > AVEWS_PEND_MAX) U.pend.clear(); if (!U.ws) return; if (now - U.rx > AVEWS_DEAD_MS) { this.upDown(i); return; }
      if (now - U.ping >= AVEWS_PING_MS) { U.ping = now; try { U.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: ++H.rid })); } catch { this.upDown(i); return; } }
      if (!H.cnt[i] && now - U.idle > AVEWS_IDLE_MS) this.upClose(i); });
    H.st.peak = Math.max(H.st.peak, H.at.size); const idle = !socks.length && !H.up.some((U) => U && (U.ws || U.wait || U.busy)); if (!socks.length || now - H.stAt >= AVEWS_METER_MS) this.hubMeter(); /* 没有用户连着就马上写（不用等满 AVEWS_METER_MS） */
    if (idle) { clearInterval(H.tick); H.tick = null; } }
  hubMeter() { /*RISK-FIX 10：WSS 用量写进 ave-meter（订阅／退订几个、转给用户几则、AVE 送来几则、同时订阅最多几个）；只记录，方便跟 AVE 对帐 */ const H = this.hub(), s = H.st; H.stAt = Date.now(); if (!(s.sub || s.unsub || s.push || s.rx || s.peak)) return;
    const q = new URLSearchParams({ sub: String(s.sub), unsub: String(s.unsub), push: String(s.push), rx: String(s.rx), peak: String(Math.max(s.peak, H.at.size)), now: String(H.at.size) }); H.st = { sub: 0, unsub: 0, push: 0, rx: 0, peak: H.at.size };
    try { this.env.ROOM.get(this.env.ROOM.idFromName('ave-meter')).fetch('https://do/_meter_ws?' + q).catch(() => {}); } catch {} }
  hubUpNow() { const H = this.hub(); for (let i = 0; i < AVEWS_UP_MAX; i++) if (H.cnt[i] && !(H.up[i] && H.up[i].ws)) return 0; return 1; }
  hubUpNote() { const H = this.hub(), u = this.hubUpNow(); if (u === H.lastUp) return; H.lastUp = u; for (const w of this.ctx.getWebSockets('avews')) if (this.awA(w).ok) this.sys(w, { up: u }); }
  hubPlace(k) { const H = this.hub(); if (H.at.has(k)) return true; let best = -1, bn = Infinity, free = -1;
    for (let i = 0; i < AVEWS_UP_MAX; i++) { const U = H.up[i], used = !!H.cnt[i] || !!(U && (U.ws || U.busy || U.wait)); if (!used) { if (free < 0) free = i; continue; } if (H.cnt[i] < AVEWS_UP_SUBS && H.cnt[i] < bn) { best = i; bn = H.cnt[i]; } }
    if (free >= 0 && (best < 0 || bn >= AVEWS_UP_SPREAD)) best = free; if (best < 0) return false; this.atSet(k, best); return true; }
  hubSend(k, m) { const H = this.hub(), S = H.ref.get(k); if (!S) return; const s = JSON.stringify(m); for (const w of S) { try { w.send(s); H.st.push++; } catch {} } } /*RISK-FIX 10：记推送量 */
  hubDrop(ws) { const H = this.hub(); const s = H.cs.get(ws); if (!s) return; H.cs.delete(ws); for (const k of s) { const S = H.ref.get(k); if (S) { S.delete(ws); if (!S.size) H.ref.delete(k); } } this.hubFlush(); }
  hubSet(ws, A, list) { const H = this.hub(), now = Date.now(); const want = []; for (const it of list.slice(0, AVEWS_USER_SUBS * 4)) { const k = awKey(it); if (k && !want.includes(k)) want.push(k); }
    let other = 0; for (const [w, s] of H.cs) if (w !== ws && this.awA(w).id === A.id) other += s.size;
    const room = Math.max(0, AVEWS_USER_SUBS - other); const ok = [], cut = [], full = [], bad = [];
    for (const k of want) { const bu = H.bad.get(k); if (ok.length >= room) cut.push(k); else if (bu && bu > now) bad.push(k); else if (this.hubPlace(k)) ok.push(k); else full.push(k); }
    const old = H.cs.get(ws) || new Set(), nw = new Set(ok); for (const k of old) if (!nw.has(k)) { const S = H.ref.get(k); if (S) { S.delete(ws); if (!S.size) H.ref.delete(k); } }
    for (const k of nw) { let S = H.ref.get(k); if (!S) H.ref.set(k, (S = new Set())); S.add(ws); } H.cs.set(ws, nw);
    this.sys(ws, { set: ok.length, cut: cut.map(awItem), full: full.map(awItem), bad: bad.map(awItem), up: this.hubUpNow() }); this.hubFlush(); }
  hubFlush() { const H = this.hub(), subs = new Map(), uns = new Map(); const add = (M, i, k) => { if (!M.has(i)) M.set(i, []); M.get(i).push(k); };
    for (const [k, i] of [...H.at]) { const S = H.ref.get(k); if (S && S.size) continue; this.atDel(k); const U = H.up[i]; if (U && U.sent.has(k)) { U.sent.delete(k); if (U.ws) add(uns, i, k); } }
    for (const [k, i] of H.at) { const U = H.up[i]; if (!U || !U.ws) { this.upOpen(i); continue; } if (!U.sent.has(k)) { U.sent.add(k); add(subs, i, k); } }
    for (const [M, method] of [[uns, 'unsubscribe'], [subs, 'subscribe']]) for (const [i, ks] of M) { const U = H.up[i]; if (!U || !U.ws) continue;
      for (const [params, kk] of awParams(ks)) { const id = ++H.rid; if (method === 'subscribe') U.pend.set(id, kk); try { U.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id })); H.st[method === 'subscribe' ? 'sub' : 'unsub'] += kk.length; } catch {} } } /*RISK-FIX 10：记订阅／退订几个 */
    this.hubUpNote(); }
  hubBad(ks) { const H = this.hub(), now = Date.now(); for (const k of ks) { H.bad.set(k, now + AVEWS_BAD_MS); const S = H.ref.get(k); if (S) for (const w of S) { const s = H.cs.get(w); if (s) s.delete(k); this.sys(w, { bad: [awItem(k)] }); } H.ref.delete(k); }
    if (H.bad.size > AVEWS_PEND_MAX) for (const [k, t] of H.bad) if (t < now) H.bad.delete(k); this.hubFlush(); }
  async upOpen(i) { const H = this.hub(); const U = (H.up[i] = H.up[i] || { ws: null, sent: new Set(), pend: new Map(), retry: 0, rx: 0, ping: 0, idle: Date.now(), wait: null, busy: false }); if (U.ws || U.busy || U.wait) return; U.busy = true;
    try { const r = await fetch(aveWsUrl(this.env), { headers: { Upgrade: 'websocket', 'X-API-KEY': String(this.env.AVE_KEY || '').trim() } }); const ws = r.webSocket; if (!ws) throw new Error('upstream ' + r.status); ws.accept();
      U.ws = ws; U.sent = new Set(); U.pend = new Map(); U.rx = U.ping = Date.now(); U.retry = 0;
      ws.addEventListener('message', (e) => { if (U.ws === ws) this.upRx(i, U, e.data); }); ws.addEventListener('close', () => { if (U.ws === ws) this.upDown(i); }); ws.addEventListener('error', () => { if (U.ws === ws) this.upDown(i); });
    } catch { U.busy = false; this.upDown(i); return; } U.busy = false; this.hubTick(); this.hubFlush(); }
  upDown(i) { const H = this.hub(), U = H.up[i]; if (!U) return; const ws = U.ws; U.ws = null; U.sent = new Set(); U.pend = new Map(); if (ws) { try { ws.close(1000, 'bye'); } catch {} }
    this.hubUpNote(); if (H.cnt[i] && !U.wait) { const ms = AVEWS_RETRY_MS[Math.min(U.retry, AVEWS_RETRY_MS.length - 1)]; U.retry++; U.wait = setTimeout(() => { U.wait = null; this.upOpen(i); }, ms); } }
  upRetry1(i, U, ks) { /*RISK-FIX 9：整批被拒的订阅一个一个重送（单个再被拒才算 bad） */ const H = this.hub(); for (const k of ks) { if (H.at.get(k) !== i || !U.ws || !H.ref.has(k)) continue; for (const [params, kk] of awParams([k])) { const id = ++H.rid; U.pend.set(id, kk); try { U.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'subscribe', params, id })); H.st.sub += kk.length; } catch {} } } }
  upClose(i) { const U = this.hub().up[i]; if (!U) return; if (U.wait) { clearTimeout(U.wait); U.wait = null; } const ws = U.ws; U.ws = null; U.sent = new Set(); if (ws) { try { ws.close(1000, 'idle'); } catch {} } }
  upRx(i, U, data) { U.rx = Date.now(); if (typeof data !== 'string' || data.trim() === 'pong') return; let j; try { j = JSON.parse(data); } catch { return; } if (!j || typeof j !== 'object') return;
    this.hub().st.rx++; /*RISK-FIX 10*/
    if (j.error != null && j.id != null) { const ks = U.pend.get(j.id); U.pend.delete(j.id); if (ks && ks.length > 1) this.upRetry1(i, U, ks); else if (ks) this.hubBad(ks); return; } /* AVE 拒绝这个订阅 → 告诉用户端（改回定时查询） */ /*RISK-FIX 9：一整批（价格订阅一则带好几个币）被拒 → 拆成一个一个重送，只把真的不行的标 bad */
    const R = j.result; if (!R || typeof R !== 'object') return; if (!R.topic && j.id != null) U.pend.delete(j.id);
    if (R.topic === 'price' && Array.isArray(R.prices)) { for (const q of R.prices) { if (!q || typeof q !== 'object') continue; const ch = awL(q.chain), p = { u: awN(q.uprice), c24: awN(q.price_change_24h), c: awN(q.price_change ?? q.change), tvl: awN(q.tvl), v24: awN(q.volume_24_u), n24: awN(q.tx_count_24h), tm: awN(q.time) };
        for (const a of new Set([awL(q.target_token), awL(q.pair)])) if (a) this.hubSend('p|' + a + '-' + ch, { t: 'p', id: a + '-' + ch, p }); } return; }
    if (R.topic === 'kline' && R.kline && typeof R.kline === 'object') { const id = awL(R.id), iv = awL(R.interval).replace(/^k/, ''), k = R.kline.usd; if (!k || typeof k !== 'object') return;
      this.hubSend('k|' + id + '|' + iv, { t: 'k', id, iv, k: { t: awN(k.time), o: awN(k.open), h: awN(k.high), l: awN(k.low), c: awN(k.close), v: awN(k.volume) } }); return; }
    if (R.topic === 'tx' && R.tx && typeof R.tx === 'object') { const x = R.tx, ch = awL(x.chain), fa = awL(x.from_address), ta = awL(x.to_address);
      for (const a of new Set([awL(x.target_token), fa, ta])) { if (!a || (a !== fa && a !== ta)) continue; const b = a === ta ? 1 : 0; const id = a + '-' + ch;
        this.hubSend('x|' + id, { t: 'x', id, x: { tm: awN(x.time), blk: awN(x.block_number), h: String(x.transaction ?? '').slice(0, 100), w: awL(x.wallet_address || x.sender).slice(0, 64), usd: awN(x.amount_usd), b, p: awN(b ? x.to_price_usd : x.from_price_usd), amt: awN(b ? x.to_amount : x.from_amount) } }); } return; }
    const D = R.data; if (D && typeof D === 'object' && D.event === 'switch_main_pair') { const ch = awL(D.chain), tok = awL(D.token), np = awL(D.new_main_pair), op = awL(D.old_main_pair); if (!tok || !np) return; const m = { t: 'sw', id: tok + '-' + ch, np: np + '-' + ch };
      this.hubSend('p|' + m.id, m); this.hubSend('x|' + m.id, m); if (op) for (const k of this.hub().ref.keys()) if (k.startsWith('k|' + op + '-' + ch + '|')) this.hubSend(k, m); } }
  async hubMsg(ws, msg) { if (typeof msg !== 'string' || msg.length > AVEWS_MSG_MAX) { try { ws.close(1009, 'too big'); } catch {} this.hubDrop(ws); return; }
    { const now = Date.now(); this.aq = this.aq || new WeakMap(); const q = (this.aq.get(ws) || []).filter((t) => now - t < AVEWS_CMD_WIN_MS); if (q.length >= AVEWS_CMD_MAX) { this.sys(ws, { slow: 1 }); return; } q.push(now); this.aq.set(ws, q); } /* 防滥用：每条连线每 10 秒最多 AVEWS_CMD_MAX 则指令 */
    let o = null; try { o = JSON.parse(msg); } catch {} if (!o || typeof o !== 'object') return; const A = this.awA(ws); this.hubTick();
    if (typeof o.auth === 'string') { const C = await sessCheck(this.env, o.auth); if (!C || (A.ok && A.id !== C.id)) { this.sys(ws, { deny: 'session' }); try { ws.close(4003, 'denied'); } catch {} this.hubDrop(ws); return; }
      const ph = A.ok ? (A.ph ? 1 : 0) : C.u === 'avews' ? 1 : 0; ws.serializeAttachment({ ok: 1, ann: 1, id: C.id, exp: C.exp, ph, at: A.at }); if (A.ok && A.ann) { this.sys(ws, { reauth: 'ok' }); return; } /*RISK-FIX 8：升级时验过（ann 0）→ 第一则 auth 才算正式连上；之后的 auth＝换新通行证 */
      const mine = this.ctx.getWebSockets('avews').filter((w) => w !== ws && this.awA(w).ok && this.awA(w).id === C.id && !!this.awA(w).ph === !!ph).sort((a, b) => this.awA(a).at - this.awA(b).at); /*RISK-FIX 12：电脑、手机分开算，只关同一种的最旧连线 */
      while (mine.length >= (ph ? AVEWS_USER_PH_CONN : AVEWS_USER_PC_CONN)) { const w = mine.shift(); try { w.close(4000, 'replaced'); } catch {} this.hubDrop(w); }
      this.sys(ws, { auth: 'ok', max: AVEWS_USER_SUBS, up: this.hubUpNow() }); return; }
    if (!A.ok) { try { ws.close(4003, 'denied'); } catch {} this.hubDrop(ws); return; }
    if (!A.ann) { this.sys(ws, { need: 'auth' }); return; } /*V101-3：升级时验过、还没送 auth（ann 0）→ 只收 auth；不然不送 auth 直接订阅会绕过每用户连线上限 */
    if (Array.isArray(o.set)) this.hubSet(ws, A, o.set); }
  async pcAuth(ws, msg) { /* OPS-RT15：电脑端第一则讯息＝{"auth": 通行证}。S5：房间绑定电脑身分——第一次通过的钱包（或作者通行证）锁住这个房间；别的钱包进不来、踢不掉原本的电脑。原身分 PC_LOCK_MS 没出现才可以换 */
    const A = (() => { try { return ws.deserializeAttachment() || {}; } catch { return {}; } })(); let t = ''; try { t = String(JSON.parse(msg)?.auth || ''); } catch {}
    const C = t ? await sessCheck(this.env, t) : null; if (!C || !(C.u === 'pc' || (C.u == null && C.id === 'owner')) || C.r !== A.room) { /*RISK-FIX 7：一律要「电脑端用途、这个房间」的通行证（手机拿到的推送通行证、只给 AVE 用的、别的房间的都不行；改版前发的作者通行证本来就绑房间，照旧认） */ this.sys(ws, { deny: '电脑端通行证核对不过（请在雷达重新打开「⚙️ 设定 → 📱 连结手机」）' }); try { ws.close(4003, 'denied'); } catch {} return; }
    const id = C.id, L = (await this.ctx.storage.get('pc')) || null, now = Date.now();
    if (L && L.id !== id && now - (+L.at || 0) < PC_LOCK_MS) { this.sys(ws, { deny: '这个手机配对房间已经绑定了别的钱包（换钱包的话请在雷达重新产生手机 QR 码）' }); try { ws.close(4003, 'denied'); } catch {} return; }
    await this.ctx.storage.put('pc', { id, at: now });
    if (A.g) await this.ctx.storage.put('g', A.g); /* RT-11：只有通过房间绑定的电脑能设手机闸门（g＝HMAC(配对金钥, 'rcph-gate-v1:'+房间)，转接站拿到也解不开讯息） */
    for (const w of this.sockets('pc')) { try { w.close(4000, 'replaced'); } catch {} }
    ws.serializeAttachment({ ...A, ok: 1, id }); this.sys(ws, { auth: 'ok' }); this.presence(); }
  async webSocketMessage(ws, msg) {
    if (this.ctx.getTags(ws)[0] === 'avews') return this.hubMsg(ws, msg); /* AVE-WSS */
    if (this.ctx.getTags(ws)[0] === 'pc' && !this.authed(ws)) { if (typeof msg === 'string' && msg.length <= SESS_BODY_MAX) await this.pcAuth(ws, msg); else { try { ws.close(4003, 'denied'); } catch {} } return; } /* OPS-RT15 */
    if (typeof msg !== 'string' || msg.length > MAX_MSG || !ENV_RE.test(msg)) return; // 只转送加密封包（S6：iv 固定 12 位元组＝16 字、密文至少含 16 位元组验证码），其他一律丢掉
    { const now = Date.now(); this.fq = this.fq || new WeakMap(); const q = (this.fq.get(ws) || []).filter((t) => now - t < FRAME_WIN_MS); if (q.length >= FRAME_MAX) return; q.push(now); this.fq.set(ws, q); } /* S5：每条连线每 10 秒最多转送 FRAME_MAX 则，超过的丢掉 */
    const role = this.ctx.getTags(ws)[0]; const to = role === 'pc' ? 'ph' : 'pc';
    if (role === 'pc') { const L = await this.ctx.storage.get('pc'); if (L && Date.now() - (+L.at || 0) > 3600e3) await this.ctx.storage.put('pc', { ...L, at: Date.now() }); } /* 绑定身分的「最后出现时间」每小时更新一次 */
    for (const w of this.sockets(to)) { try { w.send(msg); } catch {} }
  }
  async webSocketClose(ws, code) { if (this.ctx.getTags(ws)[0] === 'avews') { this.hubDrop(ws); try { ws.close(1000, 'bye'); } catch {} return; } try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} this.presence(ws); }
  async webSocketError(ws) { if (this.ctx.getTags(ws)[0] === 'avews') { this.hubDrop(ws); return; } try { ws.close(1011, 'error'); } catch {} this.presence(ws); }
}
