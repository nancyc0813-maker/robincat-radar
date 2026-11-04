// 【范本】我的小工具：BNB 价格高于你填的数字就提醒你（只看不买，不会花钱）
// 给 AI：这是最小可用的外挂范本。复制成新档名、改 meta.id，再改 tick() 里面的判断就是你的新功能。
// 开关预设关、数字是空的：玩家要在「设定 → 外挂 · 我的小工具（范本）」自己打开、自己填，才会动。
// 读不到价格时这一轮什么都不做（不提醒、不猜）。每一轮的判断都会逐条写进雷达日志。

// ═══════════════════════ 给 AI 的白话说明（请整段读完再改） ═══════════════════════
//
// 【这个档怎么被执行】
// - 雷达在「沙盒」里跑这个档（plugin-host.mjs）：没有网路、没有 process、不能 import、不能读写档案、
//   不能 eval／new Function。你要的所有资料和动作都只能透过 tick(api) 拿到的 api 做。
// - 档案一定要 export 两样东西：meta（说明＋设定栏位）和 async function tick(api)（每隔一段时间跑一次）。
//
// 【权限：外挂怎么「申请」能力】（外挂没有权限清单可以自己勾，规则是这样）
// 1. 玩家允许：玩家要在雷达「✨ AI 加功能 → 小工具」看过说明、按「允许」才会载入。档案改过一个字就要重新允许。
// 2. 会不会花钱＝看程式里有没有出现这几个英文字：b-u-y、s-e-l-l、c-a-l-l（整个字）。
//    雷达会先把注解（两种都算）拿掉再找；字串、变数名、网址里出现照样算（宁严勿松）。
//    出现了 → 这个外挂被当成「会花钱」：玩家允许时会看到警告，才拿得到 api 的买、卖、合约互动三个功能，
//    而且设定页每一个数字都要填完才会跑。没出现 → 只看不买，根本拿不到那三个功能。
//    所以只看不买的外挂：程式和字串里都不要写这三个字（像这个范本一样），英文说明 descEn 也算。不准用拆字、拼接绕过。
//    档名不要用 _ 开头：_ 开头的档雷达当成范本，不载入、不会出现在小工具清单。
// 3. 能读的网站：api.fetchJson 只能读说明书列的公开行情网站（例如 data-api.binance.vision、api.dexscreener.com）。
// 4. meta.uses：写你用到哪些 api，给玩家和检查工具看；雷达不靠它挡，真正的限制是上面三条＋沙盒。要跟程式实际用到的一致。
//
// 【零官方数字】
// - 会决定「买／卖／跳过／通知／标签」的数字一律不写在程式里，做成 meta.settings 的栏位让玩家自己填。
// - 栏位不要写 def（写了雷达也不用）。
// - min／max 是「合理范围」，可以不写（不写＝不限）。玩家填的数字超出范围、选了选单里没有的选项，雷达不会帮他改数字，
//   而是判定「设定不合法」：这个外挂整个先不跑，日志和 TG 写清楚是哪一栏。所以只写真的不合理的边界（例如价格不能小于 0）。
//   开关（type: 'bool'）和选单（opts）不用写 min／max。
// - 没填的数字，在 api.settings() 里是 null（或 NaN）。一律用 isNum() 检查，没填＝这条规则不用，绝对不要自己补一个数字。
// - 只有纯运作用的常数可以写在程式里（例如几秒跑一次 everySec、显示时小数点几位）。
//
// 【开关预设关】
// - 雷达会自动帮每个外挂加一个「启用」开关（设定名 on，预设关）；关着的时候 tick 根本不会被呼叫。
// - 每一条判断规则再给它自己的开关（type: 'bool'，预设关）＋数字：「开关开着＋数字有填」才算一条规则。
// - 会花钱的外挂：雷达另外加「每天最多花」（dayUsd，没填＝不花），也会受雷达暂停、额度、余额检查限制。
//
// 【读不到资料只能不做事】
// - 资料读不到、格式不对 → 写一行日志说明原因，这一轮直接 return。不准跳过这个条件、不准改用别的数字、不准猜。
// - 如果真的需要「读不到时改用备用条件」，备用条件也要是玩家自己选、自己填的栏位。
//
// 【逐条判断日志】
// - 每一轮都用 api.log 写出每一条规则的结果，格式：「✅ 名称 现在的值（你设 …）　❌ …　→ 结论」。
// - 不能只写「不提醒」「不买」；要让玩家看得出是哪一条没过、他自己设的是多少。
//
// 【api 一览】（括号里是参数；有 await 的要加 await）
//   api.id                        这个外挂的 id
//   api.settings()                读玩家在设定页填的值：on、dayUsd、加上你在 meta.settings 写的每个 k
//   api.state                     外挂自己的记忆（一般物件，会自动存档；有大小上限，不要无限累积）
//   api.log(文字)                 写进雷达日志（会截短；每一轮、每天有次数上限）
//   api.notify(文字)              发 TG 给玩家（自动加「[插件 你的档名]」开头、网址会被拿掉；次数上限比 log 小，不要每轮都发）
//   api.panel({ title, items })   在「✨ AI 加功能 → 我的面板」显示资料（只交资料，画面由雷达画；items 种类见说明书三之二）
//   await api.fetchJson(网址)     读公开行情网站的 JSON（只限白名单网站，读失败会丢错误）
//   await api.price(币)           现价（美元），币可填 BNB／ETH／BTCB／稳定币，或玩家加进「外挂可交易的币」的合约
//   await api.read(合约, 资料, 链) 读链上资料（eth_call，只读）；链填 56＝BNB Chain、4663＝Robinhood
//   await api.balances()          雷达每分钟更新的钱包余额（只有公开地址和余额）
//   await api.projects()          雷达清单里的 AI 铸造项目（合约、名称、进度、AI 钱包数…，只读）
//   await api.position(币)        这个外挂自己的持仓（会花钱的外挂才有意义）
//   await api.spentToday()        这个外挂今天花了多少 U
//   —— 下面三个只有「会花钱」的外挂拿得到（见【权限】第 2 条），这个范本没有用 ——
//   买（币, U）、卖（币, 数量）、合约互动（合约, 资料, 付多少原生币, 链）：一律经过雷达的额度、暂停、预演、防盗检查；
//   合约互动要附 BNB／ETH 时，玩家没填「每笔最多付多少」就一律不送。
//   想让玩家自己决定要不要买，用面板的 action 按钮（范例：plugins/examples/回调建议单.mjs），不要自动下单。
//
// 【做完一定要跑】
//   node --check plugins/你的档.mjs
//   node tools/guard_check.mjs --plugin plugins/你的档.mjs
// 然后用白话告诉玩家：做什么、会不会花钱、读不到资料时怎样、要他在设定页填哪些数字。玩家说好才算完成。
// ═══════════════════════════════════════════════════════════════════════════════

const PRICE_URL = 'https://data-api.binance.vision/api/v3/ticker/price?symbol=BNBUSDT'; // 资料来源（公开、只读）
const isNum = (v) => typeof v === 'number' && Number.isFinite(v); // 没填的数字会是 null／NaN → false
const isOn = (v) => Number(v) === 1; // 开关：1＝开

export const meta = {
  id: 'my_tool', // 改成你自己的：小写英文、数字、_、-；不能跟别的外挂重复，也不能用 all、on、wallets 这类保留字
  //                id、档名、名字都不能有 radar、official、security、robincat、官方、雷达、罗宾猫、哨兵（不能装成雷达或官方）
  name: '我的小工具（范本）',
  nameEn: 'My tool (template)',
  desc: '只看不买：BNB 价格高于你填的数字就在面板标出来，你打开「也发 TG」才会通知。读不到价格就不做事。',
  descEn: 'View only: marks the panel when BNB goes above your number; sends TG only if you turn it on. Does nothing when the price cannot be read.',
  uses: ['fetchJson', 'log', 'notify', 'panel'],
  // everySec：几秒跑一次（运作用的间隔）。不写＝雷达预设的间隔；雷达也有最短间隔限制。
  settings: [
    { k: 'aboveOn', type: 'bool', zh: '价格高于 ___ 就提醒', en: 'Alert when price is above ___', dzh: '开着＋下面有填数字才算这条规则', den: 'Counts only when on and the number below is filled' },
    { k: 'above', min: 0, unit: '美元', zh: 'BNB 价格高于多少美元', en: 'BNB price above (USD)', dzh: '你自己填；没填＝这条规则不用', den: 'Your number; empty = rule not used' },
    { k: 'tg', type: 'bool', zh: '也发 TG 通知', en: 'Also send TG', dzh: '关着＝只在面板和日志显示', den: 'Off = panel and log only' },
  ],
};

export async function tick(api) {
  const S = api.settings();
  const st = api.state;

  // ① 读资料：读不到 → 写原因、这一轮不做事
  let px = null;
  try {
    const j = await api.fetchJson(PRICE_URL);
    const v = Number(j?.price);
    if (Number.isFinite(v) && v > 0) px = v;
  } catch (e) {
    api.log(`读不到 BNB 价格（${String(e?.message || e)}）→ 这一轮不做事`);
    return;
  }
  if (px == null) { api.log('BNB 价格格式不对 → 这一轮不做事'); return; }

  // ② 判断：只算「开关开着＋数字有填」的规则，逐条记下来
  const lines = []; let active = 0, hit = false;
  if (isOn(S.aboveOn)) {
    if (!isNum(S.above)) lines.push('⚪ 「价格高于」开着但没填数字 → 这条不用');
    else { active++; const ok = px > S.above; if (ok) hit = true; lines.push(`${ok ? '✅' : '❌'} BNB ${px} 美元（你设高于 ${S.above}）`); }
  }
  if (!active) {
    api.log((lines.length ? lines.join('　') + '　' : '') + '没有开着又填好数字的规则 → 不提醒');
    api.panel({ title: '我的小工具（范本）', items: [{ type: 'stat', label: 'BNB', value: '$' + px }, { type: 'text', text: '到「设定」打开「价格高于 ___ 就提醒」并填数字，这里才会判断。' }] });
    return;
  }

  // ③ 逐条判断日志（每一轮都写）
  api.log(lines.join('　') + (hit ? ' → 提醒' : ' → 不提醒'));

  // ④ 动作：这个范本只显示＋（玩家开了才）通知；从「没过」变成「过」时才通知一次，不洗版
  if (hit && !st.wasHit && isOn(S.tg)) api.notify(`BNB 现在 ${px} 美元，高于你设的 ${S.above}`);
  st.wasHit = hit;
  api.panel({ title: '我的小工具（范本）', items: [
    { type: 'stat', label: 'BNB', value: '$' + px, sub: `你设高于 ${S.above}`, tone: hit ? 'up' : '' },
    { type: 'text', text: lines.join('　') },
  ] });
}
