// 【范例②·看板】主流币行情看板：BNB、ETH、BTC 的现价、今天涨跌、成交额，加上你选的币的走势图。
// 资料来源：币安公开行情（data-api.binance.vision，只读）；也顺便列出雷达清单里的 AI 铸造项目。
// 只显示、不判断、不通知、不会花钱。读不到的资料显示「—」或写「读不到」，不会用旧资料假装成新的。
// 要用：把这个档复制到 plugins/ 资料夹，到雷达「小工具」按允许、到设定页打开，就会出现在「我的面板」。

// 给 AI：这是「看板类」的标准写法（新增一个面板的资料来源）。重点：
// - 只用 api.fetchJson（白名单网站）、api.projects() 读资料，用 api.panel() 交给雷达画；不要去改 radar/ui/index.html。
// - 每一种资料分开读、分开处理：一个来源读不到，只在面板标出来，其他照常显示。
// - 看板没有买卖判断，所以不需要判断日志；但读不到资料一样要写一行原因。

const COINS = [ // 要显示的币（只是显示清单，不是买卖数字）
  { zh: 'BNB', pair: 'BNBUSDT' },
  { zh: 'ETH', pair: 'ETHUSDT' },
  { zh: 'BTC', pair: 'BTCUSDT' },
];
const API = 'https://data-api.binance.vision/api/v3';
const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fx = (v, d) => (v == null ? '—' : v.toFixed(d));
const big = (v) => (v == null ? '—' : v.toLocaleString('en-US', { notation: 'compact' })); // 显示用：大数字缩写成 K／M／B

export const meta = {
  id: 'ex_market_board',
  name: '行情看板（范例）',
  nameEn: 'Market board (example)',
  desc: '只显示：BNB、ETH、BTC 现价、今天涨跌、成交额＋你选的币的走势图，以及雷达清单里的 AI 铸造项目。读不到的显示「—」。',
  descEn: 'Display only: BNB/ETH/BTC price, daily change, volume, a chart of your chosen coin, and the radar AI mint list.',
  uses: ['fetchJson', 'projects', 'log', 'panel'],
  settings: [
    { k: 'chart', opts: COINS.map((c, v) => ({ v, zh: c.zh, en: c.zh })), zh: '走势图看哪个币', en: 'Chart coin', dzh: '没选＝不画走势图', den: 'Not chosen = no chart' },
  ],
};

export async function tick(api) {
  const S = api.settings(); const items = [];

  // 资料来源 1：币安一日行情（一次读三个币）
  const q = encodeURIComponent(JSON.stringify(COINS.map((c) => c.pair)));
  let rows = null;
  try { const j = await api.fetchJson(`${API}/ticker/24hr?symbols=${q}`); if (Array.isArray(j)) rows = j; else api.log('行情资料格式不对 → 面板标「读不到」'); }
  catch (e) { api.log(`读不到币安行情（${String(e?.message || e)}）→ 面板标「读不到」`); }
  if (rows) {
    const tb = [];
    for (const c of COINS) {
      const r = rows.find((x) => x?.symbol === c.pair) || {};
      const px = n(r.lastPrice), ch = n(r.priceChangePercent), vol = n(r.quoteVolume), hi = n(r.highPrice), lo = n(r.lowPrice);
      items.push({ type: 'stat', label: c.zh, value: px == null ? '读不到' : '$' + px, sub: ch == null ? '今天涨跌：—' : `今天 ${ch > 0 ? '+' : ''}${fx(ch, 2)}%`, tone: ch == null ? '' : ch > 0 ? 'up' : ch < 0 ? 'dn' : '' });
      tb.push([c.zh, px == null ? '—' : String(px), hi == null ? '—' : String(hi), lo == null ? '—' : String(lo), big(vol)]);
    }
    items.push({ type: 'table', cols: ['币', '现价', '今天最高', '今天最低', '成交额（USDT）'], rows: tb });
  } else items.push({ type: 'alert', text: '币安行情这一轮读不到，下一轮会再读。', tone: 'warn' });

  // 资料来源 2：你选的币的走势（币安 K 线，收盘价）
  const c = n(S.chart) != null ? COINS[S.chart] : null;
  if (!c) items.push({ type: 'text', text: '到「设定」选「走势图看哪个币」，这里就会画走势图。' });
  else {
    try {
      const k = await api.fetchJson(`${API}/klines?symbol=${c.pair}&interval=1h`);
      const pts = Array.isArray(k) ? k.map((r) => [n(r?.[0]), n(r?.[4])]).filter((p) => p[0] != null && p[1] != null) : [];
      if (pts.length) items.push({ type: 'line', label: `${c.zh} 收盘价（美元，每小时）`, points: pts });
      else { api.log(`${c.zh} 走势资料格式不对 → 不画图`); items.push({ type: 'text', text: `${c.zh} 走势这一轮读不到。` }); }
    } catch (e) { api.log(`读不到 ${c.zh} 走势（${String(e?.message || e)}）→ 不画图`); items.push({ type: 'text', text: `${c.zh} 走势这一轮读不到。` }); }
  }

  // 资料来源 3：雷达清单里的 AI 铸造项目（只读）
  try {
    const P = await api.projects();
    if (Array.isArray(P) && P.length) items.push({ type: 'table', cols: ['名称', '进度', 'AI 钱包', '打过', '雷达判断'], rows: P.map((p) => [String(p.name || p.contract || ''), p.progress == null ? '读不到' : p.progress + '%', String(p.aiWallets ?? '—'), p.minted ? '是' : '否', String(p.verdict || '')]) });
    else items.push({ type: 'text', text: '雷达清单里还没有 AI 铸造项目。' });
  } catch (e) { api.log(`读不到雷达项目清单（${String(e?.message || e)}）`); items.push({ type: 'text', text: '雷达项目清单这一轮读不到。' }); }

  api.panel({ title: '行情看板（范例）', items });
}
