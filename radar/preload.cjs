/* 罗宾猫雷达 · 画面与主程序之间的桥（contextIsolation 开、nodeIntegration 关、sandbox 开）
   只开放画面真的会用到的功能；每个参数先检查型别和长度，不对就改成空值再送（主程序那边还会再检查一次） */
const { contextBridge, ipcRenderer } = require('electron');
const S = (x, n = 300) => (x == null ? '' : String(x).slice(0, n)); /* 文字：限长 */
const N = (x) => { const v = Number(x); return Number.isFinite(v) ? v : 0; }; /* 数字：不是数字就当 0 */
const O = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {}); /* 物件 */
const A = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []); /* 阵列：限笔数 */
const B = (x) => !!x;
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('radar', {
  snapshot: () => call('snapshot'),
  zoomSet: (f) => call('zoomSet', N(f)), zoomGet: () => call('zoomGet'), onZoom: (fn) => { if (typeof fn === 'function') ipcRenderer.on('zoomChanged', (e, f, eff) => fn(N(f), N(eff))); /*ZOOM112*/ }, /* ZOOM110 画面大小 */
  uiLang: (l) => call('uiLang', l === 'en' ? 'en' : 'zh'), /* I18N-FIX：介面语言告诉主程式（对话框、通知、系统匣） */
  schema: () => call('schema'),
  pnlHist: (r) => call('pnlHist', S(r, 20)),
  updRepair: () => call('updRepair'), /* 更新后引擎起不来 →「重新下载这一版」 */
  logTail: (n) => call('logTail', N(n)),
  nx: (a, o) => call('nx', S(a, 40), O(o)), /* radar/next.cjs 的功能 */
  ghm: (a, o) => call('ghm', S(a, 40), O(o)), /* GHM-1104 GitHub 观察（只读） */
  invReload: () => call('invReload'),
  bindRelay: (k) => call('bindRelay', k === 'code' ? 'code' : 'join'), /* V105-1：雷达内直接绑定（送到转接站，不经过 TG） */
  bindRelayStat: (id) => call('bindRelayStat', S(id, 40)), /* V105-1：查绑定结果 */
  bindRelayNow: (k) => call('bindRelayNow', k === 'code' ? 'code' : 'join'), /* BAUTO108：画面「重送」＝请主程式马上自动送一次 */
  guardAsk: () => call('guardAsk'), /* WAL-GATE：再跳一次守护金钥确认视窗 */
  invCheck: (c) => call('invCheck', S(c, 80)),
  hotBoard: (n) => call('hotBoard', S(n, 20)),
  smartAuto: () => call('smartAuto'),
  airHot: (f) => call('airHot', B(f)),
  airCheck: (u) => call('airCheck', S(u, 2000)),
  airState: () => call('airState'),
  aveStats: (n) => call('aveStats', S(n, 20)),
  holdHealth: () => call('holdHealth'),
  walletPnl: (f) => call('walletPnl', B(f)),
  tape: (n, a, p) => call('tape', S(n, 20), S(a, 64), S(p, 80)),
  /*FBM-BEGIN*/walletInfo: (n, a) => call('walletInfo', S(n, 20), S(a, 64)), /* 交易者钱包页（AVE 唯读） *//*FBM-END*/
  livePx: (n, a, p) => call('livePx', S(n, 20), S(a, 64), S(p, 80)),
  aveWsPhSess: () => call('aveWsPhSess'), /*RISK-FIX 7：给手机的 AVE 推送通行证（只能连 /avews） */
  aveWsSess: () => call('aveWsSess'), /* AVE-WSS：即时推送通行证（主程序向转接站换，画面拿去连 /avews） */
  aveWsState: (s) => call('aveWsState', S(s, 10)), /* AVE-WSS：画面回报推送状态 */
  kolStats: (f) => call('kolStats', B(f)),
  signals: () => call('signals'),
  missed: () => call('missed'),
  backtest: (o) => call('backtest', O(o)),
  imgData: (u) => call('imgData', S(u, 2000)),
  candles: (n, p, tf) => call('candles', S(n, 20), S(p, 80), S(tf, 10)),
  login: (i) => call('login', N(i)),
  copyGuide: (x) => call('copyGuide', S(x, 600)),
  plugins: () => call('plugins'),
  approvePlugin: (f, h) => call('approvePlugin', S(f, 200), S(h, 128)),
  importAI: (k, n, b) => call('importAI', S(k, 40), S(n, 200), S(b, 2e6)),
  journal: () => call('journal'),
  exportJournal: (rows) => call('exportJournal', A(rows, 50000)),
  donate: () => call('donate'),
  copyText: (t) => call('copyText', S(t, 200)),
  checkToken: (a) => call('checkToken', S(a, 200)),
  tokenDetail: (n, a) => call('tokenDetail', S(n, 20), S(a, 64)),
  tokenQuick: (n, a) => call('tokenQuick', S(n, 20), S(a, 64)),
  tokenPre: (n, L) => call('tokenPre', S(n, 20), A(L, 50).map((a) => S(a, 64))), /* SPEED113 看盘先预抓前几个币（数量是你的设定 board.preN） */
  tokenWarm: (n, a) => call('tokenWarm', S(n, 20), S(a, 64)), /* PERF2-1104 滑鼠停在列上先预热（只做不花额度的检查） */
  onTokenDetailMore: (cb) => { if (typeof cb !== 'function') return; ipcRenderer.on('tokenDetailMore', (e, m) => { try { cb(m); } catch {} }); }, /* 风险／持有人后到 */
  hist: (k) => call('hist', S(k, 120)),
  news: () => call('news'),
  tgCheck: (n) => call('tgCheck', S(n, 80)),
  xKeysStatus: () => call('xKeysStatus'),
  saveXKeys: (a, b) => call('saveXKeys', S(a, 300), S(b, 300)),
  feedback: () => call('feedback'),
  tgChannels: () => call('tgChannels'),
  tgChannelsSave: (l) => call('tgChannelsSave', A(l, 500).map((x) => S(x, 80))),
  saveSettings: (s) => call('saveSettings', O(s)),
  pause: (on) => call('pause', B(on)),
  restartEngine: () => call('restartEngine'),
  order: (o) => call('order', O(o)), /* 桌面下的单：主程序会拿掉 src:'phone' */
  phoneOrder: (o) => call('phoneOrder', O(o)), /* 手机经转接站送来、由画面转送的单：主程序一律标 src:'phone' */
  open: (u) => call('open', S(u, 2000)),
  qr: (t) => call('qr', S(t, 300)),
  phOwner: (r) => call('phOwner', S(r, 40)),
  phSession: (r) => call('phSession', S(r, 40)), /* OPS-RT15：手机连结电脑端通行证（连上 /ws 后第一则讯息送 {auth}） */
  phSetLog: (o) => call('phSetLog', O(o)),
  phEditKeys: () => call('phEditKeys'), /* SWFIX-M5：手机能改哪些（主程式的白名单） */
  phSaveSettings: (s) => call('phSaveSettings', O(s)), /* SWFIX-M5：手机改设定只走这里，主程式核对白名单 */
});
