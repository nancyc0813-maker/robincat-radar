// 罗宾猫雷达 · 外挂沙盒（每个外挂一个独立小程式）
// 用 Node 权限模式启动：只能读自己和这个外挂档，不能写档、不能读其他档案、不能开别的程式；环境变数也是空的
// PLUGSEC：载入外挂之前先把网路、送讯息、碰系统的东西全部拿掉；外挂只能载入它自己，不能 import 任何模组；
// 主程式用 --disallow-code-generation-from-strings 启动这个沙盒（eval／Function 字串都不能跑）。
// 外挂要做的事（下单、查价）全部透过讯息交给主程式，主程式会照额度、暂停开关、帐本检查
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
const P = process; const file = P.argv[2];
/* ① 私有的送讯息通道：先存起来，再把 process 上的版本换成会出错的假函式（外挂拿不到原本的） */
const send0 = P.send, _send0 = P._send; const T = Object.create(P); T._send = _send0;
const send = (m) => { try { send0.call(T, m); } catch {} };
const stub = (n) => function blocked() { throw new Error('外挂沙盒不允许：' + n); };
for (const k of ['send', '_send', 'kill', 'getBuiltinModule', 'dlopen', '_linkedBinding', 'binding', 'openStdin', 'setUncaughtExceptionCaptureCallback']) { try { Object.defineProperty(P, k, { value: stub(k), writable: false, configurable: false }); } catch { try { P[k] = stub(k); } catch {} } }
const exit = (c) => { try { P.exit(c); } catch {} };
/* ② 先读外挂原始码、算 sha256，用「同一份内容」载入（检查完到载入之间档案被换掉也没用），雷达会比对这个指纹 */
let src = '', hash = '';
try { src = readFileSync(file, 'utf8'); hash = createHash('sha256').update(src).digest('hex'); } catch (e) { send({ t: 'fail', err: '读不到外挂档：' + String(e?.code || e?.message || e).slice(0, 80) }); exit(1); }
const URL0 = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
/* ③ 模组载入钩子：除了外挂自己这一份，什么都不能 import（node:fs、node:net、相对路径、网址…全部拒绝） */
registerHooks({ resolve(spec, ctx, next) { if (spec === URL0) return next(spec, ctx); throw new Error('外挂不能 import 任何模组：' + String(spec).slice(0, 60)); } });
/* ④ 拿掉网路与系统入口：fetch／WebSocket／EventSource／XMLHttpRequest／navigator／process 都不给外挂 */
for (const k of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'navigator', 'process', 'require', 'module']) { try { delete globalThis[k]; } catch {} try { if (k in globalThis) Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch {} }

let seq = 0; const wait = new Map();
const call = (name, args) => new Promise((res, rej) => { const id = ++seq; wait.set(id, { res, rej }); send({ t: 'call', id, name, args }); });
P.on('message', async (m) => {
  if (m.t === 'ret') { const w = wait.get(m.id); if (!w) return; wait.delete(m.id); m.err ? w.rej(new Error(m.err)) : w.res(m.v); return; }
  if (m.t === 'tick') {
    const state = m.state || {}; const S = m.settings || {};
    const api = Object.freeze({ id: m.id, state, settings: () => ({ ...S }), log: (x) => send({ t: 'log', m: String(x).slice(0, 300) }), notify: (x) => send({ t: 'notify', m: String(x).slice(0, 500) }), panel: (x) => { try { const j = JSON.stringify(x); if (j.length < 200000) send({ t: 'panel', p: JSON.parse(j) }); } catch {} },
      price: (t) => call('price', [t]), fetchJson: (u) => call('fetchJson', [u]), balances: () => call('balances', []), projects: () => call('projects', []), read: (to, d, ch) => call('read', [to, d, ch]), buy: (t, u) => call('buy', [t, u]), sell: (t, q) => call('sell', [t, q]), call: (to, data, v, ch) => call('call', [to, data, v, ch]), position: (t) => call('position', [t]), spentToday: () => call('spentToday', []) });
    try { await mod.tick(api); } catch (e) { send({ t: 'done', state: safe(state), err: String(e?.message || e).slice(0, 200) }); return; }
    const out = safe(state); send({ t: 'done', state: out, ...(out === undefined ? { err: '外挂的 state 存不了（不是一般资料）' } : {}) });
  }
});
function safe(x) { try { return JSON.parse(JSON.stringify(x)); } catch { return undefined; } }
P.on('disconnect', () => exit(0)); /* 主程式重开或关掉，外挂沙盒跟着结束，不会留下孤儿程式 */
let mod;
try { mod = await import(URL0); if (!mod.meta?.id || typeof mod.tick !== 'function') throw new Error('缺 meta 或 tick'); send({ t: 'meta', meta: JSON.parse(JSON.stringify(mod.meta)), hash }); }
catch (e) { send({ t: 'fail', err: String(e?.message || e).slice(0, 200) }); exit(1); }
