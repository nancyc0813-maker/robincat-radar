// 【范例①·只看不买】涨跌提醒：你选的币从「基准价」涨或跌超过你填的 % 就发 TG 通知你。
// 基准价＝开始看的价格；每次通知后，基准价换成通知当下的价格（不会一直重复通知同一段涨跌）。
// 「涨超过」「跌超过」各有自己的开关和数字，都预设关、都空白；读不到价格这一轮就什么都不做。
// 不会下单、不会花钱。要用：把这个档复制到 plugins/ 资料夹，到雷达「小工具」按允许，再到设定页打开、填数字。

// 给 AI：这是「只读通知类」的标准写法。重点：
// - 程式和字串里没有 b-u-y／s-e-l-l／c-a-l-l 这几个字 → 雷达判定只看不买，拿不到下单功能。
// - 币用选单（opts）让玩家选；没选＝不做事。数字没填＝那条规则不用。
// - 每一轮都写逐条判断日志（✅／❌＋你设多少），读不到资料写原因后 return。

const COINS = [ // 选单内容：显示名＋币安公开行情的交易对（资料来源，不是买卖数字）
  { zh: 'BNB', pair: 'BNBUSDT' },
  { zh: 'ETH', pair: 'ETHUSDT' },
  { zh: 'BTC', pair: 'BTCUSDT' },
];
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isOn = (v) => Number(v) === 1;

export const meta = {
  id: 'ex_move_alert',
  name: '涨跌提醒（范例）',
  nameEn: 'Move alert (example)',
  desc: '只看不买：你选的币从基准价涨／跌超过你填的 % 就发 TG。基准价＝开始看的价格，每次通知后换成当下价格。读不到价格就不做事。',
  descEn: 'View only: TG alert when your coin moves up/down more than your % from the base price. Does nothing when the price cannot be read.',
  uses: ['fetchJson', 'log', 'notify', 'panel'],
  settings: [
    { k: 'coin', opts: COINS.map((c, v) => ({ v, zh: c.zh, en: c.zh })), zh: '看哪个币', en: 'Coin', dzh: '没选＝不做事', den: 'Not chosen = does nothing' },
    { k: 'upOn', type: 'bool', zh: '涨超过 ___% 就通知', en: 'Alert when up more than ___%', dzh: '开着＋下面有填才算', den: 'Counts only when on and filled' },
    { k: 'upPct', min: 0, unit: '%', zh: '涨超过几 %', en: 'Up more than (%)', dzh: '从基准价算；你自己填', den: 'From the base price; your number' },
    { k: 'dnOn', type: 'bool', zh: '跌超过 ___% 就通知', en: 'Alert when down more than ___%', dzh: '开着＋下面有填才算', den: 'Counts only when on and filled' },
    { k: 'dnPct', min: 0, unit: '%', zh: '跌超过几 %', en: 'Down more than (%)', dzh: '从基准价算；你自己填', den: 'From the base price; your number' },
  ],
};

export async function tick(api) {
  const S = api.settings(); const st = api.state;
  const c = isNum(S.coin) ? COINS[S.coin] : null;
  if (!c) { api.log('还没选「看哪个币」→ 不做事'); api.panel({ title: '涨跌提醒（范例）', items: [{ type: 'text', text: '到「设定」选一个币、打开涨或跌的开关并填 %。' }] }); return; }

  // ① 读价格：读不到就不做事
  let px = null;
  try { const j = await api.fetchJson(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${c.pair}`); const v = Number(j?.price); if (Number.isFinite(v) && v > 0) px = v; }
  catch (e) { api.log(`读不到 ${c.zh} 价格（${String(e?.message || e)}）→ 这一轮不做事`); return; }
  if (px == null) { api.log(`${c.zh} 价格格式不对 → 这一轮不做事`); return; }

  // ② 基准价：换了币或第一次看 → 现在的价格当基准，这一轮不判断
  st.base = st.base && typeof st.base === 'object' ? st.base : {};
  if (!isNum(st.base[c.pair])) { st.base[c.pair] = px; api.log(`${c.zh} 开始看，基准价 ${px} 美元（这一轮不判断）`); return; }
  const base = st.base[c.pair]; const chg = (px - base) / base * 100;

  // ③ 逐条判断（只算开着＋有填的）
  const lines = []; let active = 0, hit = '';
  if (isOn(S.upOn)) { if (!isNum(S.upPct)) lines.push('⚪ 「涨超过」开着但没填 % → 这条不用'); else { active++; const ok = chg > S.upPct; if (ok) hit = '涨'; lines.push(`${ok ? '✅' : '❌'} 涨 ${chg.toFixed(2)}%（你设超过 ${S.upPct}%）`); } }
  if (isOn(S.dnOn)) { if (!isNum(S.dnPct)) lines.push('⚪ 「跌超过」开着但没填 % → 这条不用'); else { active++; const ok = -chg > S.dnPct; if (ok) hit = '跌'; lines.push(`${ok ? '✅' : '❌'} 跌 ${(-chg).toFixed(2)}%（你设超过 ${S.dnPct}%）`); } }
  const head = `${c.zh} ${px} 美元，基准 ${base}：`;
  if (!active) { api.log(head + (lines.length ? lines.join('　') + '　' : '') + '没有开着又填好的规则 → 不通知'); }
  else api.log(head + lines.join('　') + (hit ? ` → 通知（${hit}）` : ' → 不通知'));

  // ④ 动作：只通知；通知后基准价换成现在的价格
  if (hit) { api.notify(`${c.zh} ${hit}了 ${Math.abs(chg).toFixed(2)}%：${base} → ${px} 美元（你设${hit}超过 ${hit === '涨' ? S.upPct : S.dnPct}%）`); st.base[c.pair] = px; }
  api.panel({ title: '涨跌提醒（范例）', items: [
    { type: 'stat', label: c.zh, value: '$' + px, sub: `基准 $${base}（${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%）`, tone: chg > 0 ? 'up' : chg < 0 ? 'dn' : '' },
    { type: 'text', text: active ? lines.join('　') : '还没有开着又填好的规则（到设定打开「涨超过」或「跌超过」并填 %）。' },
  ] });
}
