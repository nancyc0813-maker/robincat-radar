'use strict';
/* NODE-1113 节点池（只读查询用；不碰钱包、不送交易）。
   ① 玩家可以在「设定 → 🔌 自己的节点」填自己申请的免费节点（NodeReal／Ankr／Chainstack／QuickNode…），有填就先问它，公开节点当备用；没填＝跟以前一样只用公开节点。
      填的网址先问 eth_chainId，链不对就不用（画面写原因）。程式里不放任何金钥。
   ② 每个节点各自记「查事件记录（eth_getLogs）行不行」：回 limit exceeded／要付费／限流 → 这个节点暂时不拿来查事件（断路器），其他查询照用。
      以前 BNB 官方节点对任何 getLogs 都回 limit exceeded，雷达每次都先问它、再把「区段太大」误判成要缩小范围，看盘和成交就慢。
   ③ 有填 WSS 网址 → 订阅发射台合约的事件（新成交一出块就收到），轮询照旧当备用、同一则事件不重复记。 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const PUB = {
  bsc: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.bnbchain.org', 'https://bsc-dataseed1.defibit.io', 'https://bsc.publicnode.com', 'https://bsc-dataseed2.ninicoin.io'],
  robinhood: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org', 'https://4663.rpc.thirdweb.com'],
};
const CHAIN_ID = { bsc: '0x38', robinhood: '0x1237' }; /* 技术用：链编号（BSC 56、Robinhood 4663） */
const SET_KEYS = { bsc: ['rpc.bsc.url', 'rpc.bsc.wss'], robinhood: ['rpc.rh.url', 'rpc.rh.wss'] };
const SET_TTL_MS = 10e3; /* 技术用：设定档多久重读一次 */
const LOGS_BAD_MS = 10 * 60e3, LOGS_SOFT_MS = 60e3, NODE_BAD_MS = 30e3; /* 技术用：节点查事件被拒（从没成功过／成功过）、连不上，各暂停多久 */
const RE_LOGS_DENY = /limit exceeded|usage limit|free plan|not supported|rate limit|too many requests|api key|capacity|unauthori[sz]ed|forbidden|method not (found|allowed)|not available|429|403/i;
const RE_RANGE = /block range|range (is )?too|too many (blocks|results|logs)|query returned more than|response size|exceed(s|ed)? (the )?(max|maximum)|10000 results/i;

let DATA = '';
let SET = { at: 0, v: {} };
const N = {}; /* net → Map(url → 节点状态) */
const UCHK = new Map(); /* 玩家填的网址 → { at, ok, got }（链编号检查结果） */

function init(dataDir) { DATA = dataDir; }
function settings() {
  if (Date.now() - SET.at < SET_TTL_MS) return SET.v;
  let z = {}; try { z = JSON.parse(fs.readFileSync(path.join(DATA, 'radar_settings.json'), 'utf8')) || {}; } catch {}
  SET = { at: Date.now(), v: z }; return z;
}
const okHttps = (u) => /^https:\/\/[^\s@/]+(\/[^\s]*)?$/.test(u) && u.length <= 300;
const okWss = (u) => /^wss:\/\/[^\s@/]+(\/[^\s]*)?$/.test(u) && u.length <= 300;
function userUrl(net) { const v = String(settings()[SET_KEYS[net]?.[0]] || '').trim(); return okHttps(v) ? v : ''; }
function userWss(net) { const v = String(settings()[SET_KEYS[net]?.[1]] || '').trim(); return okWss(v) ? v : ''; }
/* 只给画面看：把网址里像金钥的部分遮起来（不写进日志） */
function mask(u) { try { const x = new URL(u); const p = x.pathname.length > 8 ? x.pathname.slice(0, 6) + '…' : x.pathname; return x.protocol + '//' + x.host + p + (x.search ? '?…' : ''); } catch { return '(格式不对)'; } }

function node(net, u, user) {
  let M = N[net]; if (!M) M = N[net] = new Map();
  let s = M.get(u); if (!s) { s = { u, user: !!user, ms: 0, okAt: 0, logsOk: 0, logsBadUntil: 0, logsWhy: '', badUntil: 0, why: '' }; M.set(u, s); }
  s.user = !!user; return s;
}
async function post(u, method, params, ms) {
  const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(ms) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (!j) { const e = new Error((r.status === 429 ? '429 ' : '') + 'http ' + r.status + ' ' + t.slice(0, 80)); e.http = r.status; throw e; }
  if (j.error) { const e = new Error(String(j.error.message || 'rpc error').slice(0, 160)); e.code = j.error.code; e.http = r.status; throw e; }
  if (!('result' in j)) throw new Error('rpc: no result');
  return j.result;
}
/* 玩家填的网址：先问链编号，对了才用；问不到（暂时连不上）先不用，1 分钟后再问 */
function userReady(net, u) {
  const c = UCHK.get(u);
  if (c && (c.ok || Date.now() - c.at < 60e3)) return !!c.ok;
  if (!c || !c.busy) { UCHK.set(u, { ...(c || {}), busy: 1, at: c?.at || 0 }); post(u, 'eth_chainId', [], 8000).then((id) => { UCHK.set(u, { at: Date.now(), ok: String(id).toLowerCase() === CHAIN_ID[net], got: String(id) }); }).catch((e) => { UCHK.set(u, { at: Date.now(), ok: false, err: String(e.message || e).slice(0, 80) }); }); }
  return false;
}
/* 这次查询要依序问哪些节点 */
function order(net, method) {
  const now = Date.now(), logs = method === 'eth_getLogs'; const pub = PUB[net] || []; const uu = userUrl(net);
  const L = []; if (uu && userReady(net, uu)) L.push(node(net, uu, 1)); for (const u of pub) L.push(node(net, u, 0));
  const good = (s) => s.badUntil < now && (!logs || s.logsBadUntil < now);
  const rank = (s) => (s.user ? 0 : 1) * 1e9 + (logs ? (s.logsOk > 0 ? 0 : 1e8) : 0) + (s.okAt ? Math.min(s.ms, 1e7) : 5e6);
  const A = L.filter(good).sort((a, b) => rank(a) - rank(b));
  const B = L.filter((s) => !good(s)).sort((a, b) => (logs ? a.logsBadUntil - b.logsBadUntil : a.badUntil - b.badUntil)); /* 全部都在暂停 → 最早恢复的先试 */
  return [...A, ...B].map((s) => s.u);
}
function noteOk(net, u, method, ms) { const s = node(net, u, u === userUrl(net)); s.okAt = Date.now(); s.ms = s.ms ? Math.round(s.ms * 0.7 + ms * 0.3) : ms; s.badUntil = 0; if (method === 'eth_getLogs') { s.logsOk++; s.logsBadUntil = 0; s.logsWhy = ''; } }
/* 回传 'range'＝区段太大（呼叫的人要缩小范围）；其他＝节点问题 */
function noteErr(net, u, method, e) {
  const s = node(net, u, u === userUrl(net)); const m = String(e?.message || e || '');
  if (method === 'eth_getLogs') {
    if (s.logsOk > 0 && RE_RANGE.test(m)) return 'range';
    if (RE_LOGS_DENY.test(m) || e?.code === -32005 || e?.http === 400) { s.logsBadUntil = Date.now() + (s.logsOk > 0 ? LOGS_SOFT_MS : LOGS_BAD_MS); s.logsWhy = m.slice(0, 80); return 'deny'; }
    if (RE_RANGE.test(m)) return 'range';
  }
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || /fetch failed|ECONN|ENOTFOUND|socket|network|http 5\d\d|429/i.test(m)) { s.badUntil = Date.now() + NODE_BAD_MS; s.why = m.slice(0, 80); }
  return 'err';
}
/* 依序问（一次只打一个节点）；区段太大的错误优先丢回去（让呼叫的人缩小范围），其他错误换下一个节点 */
async function rpc(net, method, params, ms = 12000) {
  const L = order(net, method); let last = null, range = null;
  for (const u of L) { const t0 = Date.now();
    try { const r = await post(u, method, params, ms); noteOk(net, u, method, Date.now() - t0); return r; }
    catch (e) { const k = noteErr(net, u, method, e); if (k === 'range') { range = e; break; } last = e; } }
  if (range) throw range;
  const e = new Error('节点都读不到：' + String(last?.message || 'no node').replace(/limit|exceed|range|too many/gi, '…').slice(0, 100)); e.cause = last; throw e; /* 不是区段太大，不让呼叫的人误判去缩小范围 */
}
function stat() {
  const out = {}; const now = Date.now();
  for (const net of Object.keys(PUB)) { const uu = userUrl(net), uw = userWss(net); const c = uu ? UCHK.get(uu) : null;
    out[net] = { user: uu ? { url: mask(uu), ok: !!c?.ok, why: c && !c.ok ? (c.got ? '链编号不对（' + c.got + '）' : c.err || '检查中') : '' } : null, wss: uw ? { url: mask(uw), st: WS[net]?.st || 'off', n: WS[net]?.n || 0, why: WS[net]?.why || '' } : null,
      nodes: [...(N[net]?.values() || [])].map((s) => ({ u: s.user ? mask(s.u) : s.u, user: s.user, ms: s.ms, ok: s.okAt > 0, logs: s.logsBadUntil > now ? 'off' : s.logsOk > 0 ? 'ok' : '?', logsWhy: s.logsBadUntil > now ? s.logsWhy : '', down: s.badUntil > now })) }; }
  return out;
}

/* ── 小型 WebSocket 用户端（Electron 33 的主程式没有内建 WebSocket；只用来订阅事件，收到的资料只当成「可能有新成交」） ── */
function wsOpen(url, { onOpen, onMsg, onClose }) {
  let sock = null, closed = false, buf = Buffer.alloc(0), frag = [];
  const u = new URL(url); const key = crypto.randomBytes(16).toString('base64'); const mod = u.protocol === 'wss:' ? https : http;
  const req = mod.request({ host: u.hostname, port: u.port || (u.protocol === 'wss:' ? 443 : 80), path: (u.pathname || '/') + (u.search || ''), headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }, timeout: 15000 });
  const end = (why) => { if (closed) return; closed = true; try { sock?.destroy(); } catch {} try { req.destroy(); } catch {} onClose?.(why); };
  req.on('upgrade', (res, s, head) => {
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    if (res.headers['sec-websocket-accept'] !== acc) return end('handshake');
    sock = s; s.setNoDelay(true); s.setTimeout(0); if (head && head.length) buf = Buffer.concat([buf, head]);
    s.on('data', (d) => { buf = Buffer.concat([buf, d]); parse(); }); s.on('close', () => end('closed')); s.on('error', (e) => end(String(e.message || e).slice(0, 60)));
    onOpen?.(); parse(); });
  req.on('response', (res) => end('http ' + res.statusCode)); req.on('error', (e) => end(String(e.message || e).slice(0, 60))); req.on('timeout', () => end('timeout')); req.end();
  function parse() {
    for (;;) { if (buf.length < 2) return; const b0 = buf[0], b1 = buf[1]; let len = b1 & 127, off = 2; const masked = b1 & 128;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16 << 20) return end('too big'); /* 技术用：单则讯息上限 16MB */
      const mk = masked ? 4 : 0; if (buf.length < off + mk + len) return; let p = buf.subarray(off + mk, off + mk + len); if (masked) { const m = buf.subarray(off, off + 4); p = Buffer.from(p.map((x, i) => x ^ m[i & 3])); }
      buf = buf.subarray(off + mk + len); const op = b0 & 15, fin = b0 & 128;
      if (op === 8) return end('closed'); if (op === 9) { send(p, 10); continue; } if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) { frag.push(Buffer.from(p)); if (fin) { const t = Buffer.concat(frag).toString('utf8'); frag = []; try { onMsg?.(t); } catch {} } } }
  }
  function send(data, op = 1) { if (!sock || closed) return false; const p = Buffer.isBuffer(data) ? data : Buffer.from(String(data)); const m = crypto.randomBytes(4); let h;
    if (p.length < 126) { h = Buffer.from([128 | op, 128 | p.length]); } else if (p.length < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 128 | 126; h.writeUInt16BE(p.length, 2); } else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 128 | 127; h.writeBigUInt64BE(BigInt(p.length), 2); }
    const q = Buffer.from(p.map((x, i) => x ^ m[i & 3])); try { sock.write(Buffer.concat([h, m, q])); return true; } catch { return false; } }
  return { send: (t) => send(t, 1), close: () => { try { if (sock) sock.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0])); } catch {} end('bye'); } };
}
/* 订阅事件：玩家没填 WSS 就什么都不做。断线后自动重连（越断越久，最多 WS_MAX_BACK_MS），设定改掉就关掉 */
const WS = {}; const WS_MAX_BACK_MS = 60e3, WS_IDLE_MS = 90e3; /* 技术用：重连最久等多久／多久没收到任何讯息就重连 */
function subLogs(net, filters, onLog) {
  const st = (WS[net] = WS[net] || { st: 'off', n: 0, why: '', subs: [] }); st.subs.push({ filters, onLog });
  if (st.timer) return; let back = 2000, cur = null, curUrl = '', last = 0;
  const loop = () => { const want = userWss(net);
    if (cur && (want !== curUrl || Date.now() - last > WS_IDLE_MS)) { try { cur.close(); } catch {} cur = null; }
    if (!want || cur || Date.now() < (st.retryAt || 0)) { if (!want) st.st = 'off'; return; }
    curUrl = want; st.st = 'conn'; last = Date.now(); const ids = new Map(); let rid = 1;
    cur = wsOpen(want, {
      onOpen: () => { st.st = 'on'; st.why = ''; back = 2000; last = Date.now(); for (const s of st.subs) for (const f of s.filters) { const id = rid++; ids.set(id, s); cur.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'eth_subscribe', params: ['logs', f] })); } },
      onMsg: (t) => { last = Date.now(); let j; try { j = JSON.parse(t); } catch { return; }
        if (j.id && ids.has(j.id)) { const s = ids.get(j.id); ids.delete(j.id); if (j.result) ids.set('s:' + j.result, s); else if (j.error) st.why = String(j.error.message || '订阅失败').slice(0, 80); return; }
        if (j.method === 'eth_subscription' && j.params) { const s = ids.get('s:' + j.params.subscription); const l = j.params.result; if (s && l && !l.removed) { st.n++; try { s.onLog(l); } catch {} } } },
      onClose: (why) => { cur = null; st.st = 'down'; st.why = String(why || '').slice(0, 60); st.retryAt = Date.now() + back; back = Math.min(WS_MAX_BACK_MS, back * 2); } }); };
  st.timer = setInterval(loop, 3000); loop(); /* 技术用：每 3 秒检查一次设定／连线 */
}

/* 雷达官方显示资料（remote）带来的额外公开节点：加在公开节点后面（不会排在玩家自己的节点前面） */
function addPub(net, u) { const L = PUB[net]; if (!L || !okHttps(String(u || '')) || L.includes(u) || L.length >= PUB_MAX) return; L.push(u); }
const PUB_MAX = 8; /* 技术用：每条链最多几个公开节点（跟原本 v4 的上限一样） */
module.exports = { init, addPub, rpc, order, noteOk, noteErr, stat, subLogs, userUrl, userWss, PUB, CHAIN_ID };
