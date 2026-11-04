// 【范例③·建议单】回调建议单：你选的币跌到你填的价格以下，就在「我的面板」放一个「买」的建议按钮（金额是你填的）。
// 这个外挂自己不下单：你按了按钮，雷达会先显示链上读到的代币名和地址，再进雷达的下单框（金额、余额、防盗检查），你确认才会买。
// 因为程式里有「买」按钮，雷达会把它标成「会花钱」的外挂，允许时会警告你；设定页的数字要全部填完它才会跑。
// 读不到价格就不出建议。要用：把这个档复制到 plugins/ 资料夹，到雷达「小工具」按允许，再到设定页打开、填数字。

// 给 AI：这是「需要动作」的标准写法——只送建议单给玩家确认，绝对不自动买卖。重点：
// - 只用 api.panel 的 action 项目（act、chain、c 合约、usd 玩家填的金额），不呼叫 api 的买、卖、合约互动。
// - 程式里出现 b-u-y 这个字（action 的 act 值）→ 雷达判定「会花钱」：玩家允许时看到警告、数字全部要填完才跑。这是刻意的，不要用拆字绕过。
// - 金额、价格都是玩家填的；读不到价格＝不出建议；每一轮都写逐条判断日志。

const COINS = [ // 选单内容：显示名、币安公开行情交易对、BNB Chain 上的代币合约（公开资料，不是买卖数字）
  { zh: 'ETH', pair: 'ETHUSDT', c: '0x2170ed0880ac9a755fd29b2688956bd959f933f8' },
  { zh: 'BTCB', pair: 'BTCUSDT', c: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c' },
];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isOn = (v) => Number(v) === 1;

export const meta = {
  id: 'ex_dip_suggest',
  name: '回调建议单（范例）',
  nameEn: 'Dip suggestion (example)',
  desc: '不自动下单：你选的币跌到你填的价格以下，就在「我的面板」放一个建议按钮（金额是你填的）；你按了、在雷达下单框确认才会买。读不到价格就不出建议。',
  descEn: 'Never trades by itself: when your coin drops below your price, shows a suggestion button (your amount) in My panels; nothing happens until you press it and confirm in the radar order box.',
  uses: ['fetchJson', 'log', 'notify', 'panel'],
  settings: [
    { k: 'coin', opts: COINS.map((c, v) => ({ v, zh: c.zh, en: c.zh })), zh: '看哪个币', en: 'Coin', dzh: '在 BNB Chain 上的代币', den: 'Token on BNB Chain' },
    { k: 'below', min: 0, unit: '美元', zh: '价格低于多少美元就出建议', en: 'Suggest when price below (USD)', dzh: '你自己填', den: 'Your number' },
    { k: 'usd', min: 0, unit: 'U', zh: '建议单的金额', en: 'Suggested amount', dzh: '只是按钮带进下单框的金额，下单框里还可以改；外挂不会自己花', den: 'Prefilled in the order box; the plugin never spends it' },
    { k: 'tg', type: 'bool', zh: '出建议时也发 TG', en: 'Also send TG', dzh: '关着＝只在面板显示', den: 'Off = panel only' },
  ],
};

export async function tick(api) {
  const S = api.settings(); const st = api.state;
  const c = isNum(S.coin) ? COINS[S.coin] : null;
  // 雷达对「会花钱」的外挂：数字没填完根本不会呼叫 tick；这里再挡一次，没填就不做事
  if (!c || !isNum(S.below) || !isNum(S.usd)) { api.log('还有设定没填（币、价格、金额）→ 不做事'); return; }

  // ① 读价格：读不到就不出建议，并把旧的建议按钮拿掉（不让玩家照着旧资料按）
  let px = null;
  try { const j = await api.fetchJson(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${c.pair}`); const v = Number(j?.price); if (Number.isFinite(v) && v > 0) px = v; }
  catch (e) { api.log(`读不到 ${c.zh} 价格（${String(e?.message || e)}）→ 不出建议`); }
  if (px == null) {
    api.panel({ title: '回调建议单（范例）', items: [{ type: 'alert', text: `${c.zh} 价格这一轮读不到，先不出建议（下一轮再读）。`, tone: 'warn' }] });
    st.shown = false; return;
  }

  // ② 逐条判断日志
  const ok = px < S.below;
  api.log(`${ok ? '✅' : '❌'} ${c.zh} ${px} 美元（你设低于 ${S.below}）→ ${ok ? `出建议单 ${S.usd}U（等你确认）` : '不出建议'}`);

  // ③ 动作：只放建议按钮；从「没过」变成「过」时才发一次 TG
  if (ok && !st.shown && isOn(S.tg)) api.notify(`${c.zh} 跌到 ${px} 美元（你设低于 ${S.below}）。到雷达「我的面板」看建议单，你确认才会下单。`);
  st.shown = ok;
  const items = [{ type: 'stat', label: c.zh, value: '$' + px, sub: `你设低于 ${S.below}`, tone: ok ? 'dn' : '' }];
  if (ok) items.push(
    { type: 'alert', text: `${c.zh} 低于你设的价格。下面的按钮只是建议：按了会先显示链上代币名和地址，再进雷达下单框，你确认才会买。`, tone: 'info' },
    { type: 'action', act: 'buy', chain: 'bsc', c: c.c, name: c.zh, label: `建议：买 ${c.zh} ${S.usd}U`, usd: S.usd },
  );
  else items.push({ type: 'text', text: '还没低于你设的价格，没有建议单。' });
  api.panel({ title: '回调建议单（范例）', items });
}
