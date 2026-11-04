// 罗宾猫雷达 · 空投页（雷达这边）：热门空投（airdrops.io）、网址防钓鱼检查
// 她 11/2 23:00：空投独立成一页。这里只做「读」，不碰钱包、不下单。
// ZR-1103：清单不筛、不截（抓到几个就列几个）；板块／钓鱼检查只贴「事实标签」；「潜力项目」的 TVL 门槛、新网域天数都是你的设定（没填＝不用）
const fs = require('fs'), path = require('path');
function startAir({ DATA, browse }) {
  const setOn = (k) => { try { const v = JSON.parse(fs.readFileSync(path.join(DATA, 'radar_settings.json'), 'utf8'))?.[k]; return v === true || v === 1 || v === '1'; } catch { return false; } }; /* 你的开关（没开＝关） */
  const setNum = (k) => { try { const v = JSON.parse(fs.readFileSync(path.join(DATA, 'radar_settings.json'), 'utf8'))?.[k]; const x = Number(v); return v == null || v === '' || !Number.isFinite(x) ? null : x; } catch { return null; } }; /* 你的设定（没填＝null） */
  const HOTF = path.join(DATA, 'air_hot.json');
  const DETAIL_BUDGET = 20, RISK_BUDGET = 25, FUND_BUDGET = 6; /* 每轮最多抓几个详情页／查几个网址／查几个融资（网路量）；查过的有快取，下一轮轮到别的，全部都会查到 */
  let HOT = (() => { try { return JSON.parse(fs.readFileSync(HOTF, 'utf8')); } catch { return { at: 0, list: [] }; } })(), busy = 0;
  const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&#039;/g, "'").replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
  /* 11/3 她：空投页细节全做 — 板块、链、成本难度、融资、规模、步骤、来源数、防钓鱼、资金风险 */
  const SECT = [['perp', /\bperps?\b|perpetual|futures|leverage|derivative|dydx|hyperliquid/i], ['ai', /\bAI\b|\bagents?\b|\bLLMs?\b|inference|\bGPUs?\b|depin/], ['predict', /prediction market|predict|\bbets?\b|betting/i], ['dex', /\bdex\b|\bswaps?\b|\bamm\b|liquidity pool/i], ['stable', /stablecoin|yield-bearing dollar|\bpayments?\b|neobank/i], ['restake', /restak|liquid stak|\bvalidators?\b|\blst\b|\blrt\b/i], ['lend', /\blend(ing)?\b|\bborrow|money market|\bvaults?\b/i], ['testnet', /testnet|devnet/i], ['chain', /layer ?[12]\b|\bl[12]\b|rollup|\bmainnet\b|own chain|blockchain launch/i], ['privacy', /privacy|\bprivate\b|zero-knowledge|\bzk\b/i], ['game', /\bgames?\b|gaming|play-to/i], ['nft', /\bnfts?\b|mint pass|collectibles?/i], ['social', /\bsocial\b|tweet|\byap|kaito|creator|referral|\binvite|quests?\b|\bcontest\b/i], ['wallet', /wallet app|browser extension|crypto wallet/i], ['rwa', /\brwa\b|real[- ]world asset|tokeniz/i], ['bridge', /\bbridge\b|cross-chain|interop/i]];
  const LLC = { Derivatives: 'perp', Dexs: 'dex', Lending: 'lend', 'Yield Aggregator': 'lend', Yield: 'lend', 'Liquid Restaking': 'restake', Restaking: 'restake', RWA: 'rwa', 'Prediction Market': 'predict', Gaming: 'game', 'NFT Marketplace': 'nft', 'Cross Chain Bridge': 'bridge', Privacy: 'privacy', 'Stablecoin Issuer': 'stable', CDP: 'stable', Launchpad: 'dex', 'AI Agents': 'ai' };
  const sectOf = (t) => { const out = []; for (const [k, re] of SECT) if (re.test(t)) out.push(k); if (!out.length && /\btrad(e|es|ed|ing)\b/i.test(t)) out.push('trade'); return out; }; /* 板块＝文字里出现这些字（事实标签），全部列出 */
  const MONEY = /deposit|stake|staking|trade|trading|swap|bridge|lend|borrow|provide liquidity|\blp\b|buy|mint|leverage|bet/i;
  function parse(html, kind) {
    const out = [];
    for (const part of String(html).split('<article ').slice(1)) {
      if (!/airdrop-click/.test(part.slice(0, 400))) continue;
      const a = (n) => (part.match(new RegExp(n + '="([^"]*)"')) || [])[1] || '';
      const url = (part.match(/<a href=["']?(https:\/\/airdrops\.io\/[a-z0-9-]+\/)["']?>\s*<h3>/i) || [])[1] || '';
      const name = strip((part.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1]);
      if (!url || !name) continue;
      const img = (part.match(/data-src="(https:\/\/airdrops\.io\/wp-content\/[^"]+)"/) || [])[1] || '';
      const act = strip((part.match(/Actions:\s*<span>([\s\S]*?)<\/span>/) || [])[1]).slice(0, 160);
      const d = (s) => (/^\d{8}/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '');
      const badges = [...part.matchAll(/class="badge-([\w-]+)"/g)].map((m) => m[1]);
      const req = ['telegram', 'twitter', 'discord', 'email-address', 'phone', 'kyc'].filter((k) => a('data-' + k + '-required') === '1').map((k) => k.replace('-address', ''));
      out.push({ name: name.slice(0, 60), url, img, heat: +a('data-temperature') || 0, ends: d(a('data-ends')), start: d(a('data-start')), pub: d(a('data-published')), confirmed: badges.includes('confirmed') || /\bconfirmed\b/.test(part.slice(0, 400)), claim: badges.includes('claim-live'), kyc: a('data-kyc-required') === '1', req, host: (part.match(/data-outbound-host="([^"]+)"/) || [])[1] || '', act, kind });
    }
    return out;
  }
  function parseDetail(h) {
    const t = strip(String(h).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' '));
    const g = String(h).slice(String(h).indexOf('aidrop-grid-wrapper')).slice(0, 4000);
    const cell = (k) => (g.match(new RegExp('<h2>' + k + '</h2>\\s*<div class="score-value[^"]*">\\s*<span class="sv-label">([^<]+)<')) || [])[1] || '';
    const chains = ((t.match(/Chain:\s*([^]*?)\s+(?:Ongoing|Ended|Upcoming|Confirmed|Potential|Claim|Jump to|Updated|New\b)/) || [])[1] || '').split(',').map((x) => x.trim()).filter((x) => x && x.length < 30).slice(0, 8);
    const det = ((t.match(/Airdrop Details\s+([^]*?)(?:Key Parameters|How to Participate|Step 1)/) || [])[1] || '').slice(0, 600);
    const alloc = ((t.match(/(?:Airdrop )?Allocation\s*:\s*([^:]{3,90}?)(?:\s+[A-Z][a-z]+(?: [A-Z][a-z]+)*\s*:|$)/) || [])[1] || '').trim();
    const raised = (t.match(/(?:raised|raising|secured|funding of|backed with)\s+(?:over |about |around |a total of )?(\$\s?[\d.,]+\s*(?:million|billion|[MBK])\b)/i) || [])[1] || '';
    const led = ((t.match(/(?:led by|backed by|investors? (?:include|including)|from investors such as)\s+([A-Z][\w.&' -]{2,80}?)(?:[.,;]| and other| among| as well)/) || [])[1] || '').trim();
    const steps = +((t.match(/·\s*(\d+)\s*steps/) || [])[1] || 0);
    const ticker = ((t.match(/Ticker:\s*([A-Z0-9$]{2,12})\b/) || [])[1] || '');
    return { chains, diff: cell('Difficulty'), cost: cell('Cost to Farm'), fund: cell('Funding') || raised.replace(/\s+/g, ' '), led: led.slice(0, 60), alloc: alloc.slice(0, 90), steps, ticker, desc: det.slice(0, 280), at: Date.now() };
  }
  let LL = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'air_llama.json'), 'utf8')); } catch { return { at: 0, m: {}, pot: [] }; } })();
  const nk = (s) => String(s || '').toLowerCase().replace(/\b(protocol|finance|network|labs|chain|exchange|dex|airdrop)\b/g, '').replace(/[^a-z0-9]/g, '');
  async function llama() {
    if (Date.now() - (LL.at || 0) < 12 * 3600e3 && (LL.potMin ?? null) === setNum('air.potMinTvl')) return; /* 资料快取；你改了门槛就重算 */
    try { const L = await (await fetch('https://api.llama.fi/protocols', { signal: AbortSignal.timeout(60000) })).json(); if (!Array.isArray(L)) return; const m = {}, pot = []; const potMin = setNum('air.potMinTvl'); /* ZR-1103：「还没发币的大项目」TVL 至少多少＝你的设定（没填＝不列这个清单）；不再用官方门槛和官方排除的类别 */
      for (const p of L) { const k = nk(p.name); if (!k || k.length < 3) continue; const v = { n: String(p.name).slice(0, 40), c: String(p.category || '').slice(0, 30), tvl: Math.round(p.tvl || 0), tok: !!(p.symbol && p.symbol !== '-'), ch: (p.chains || []).slice(0, 4), u: String(p.url || '').slice(0, 120) }; if (!m[k] || v.tvl > m[k].tvl) m[k] = v; if (potMin != null && !v.tok && !p.parentProtocol && v.tvl >= potMin) pot.push(v); }
      pot.sort((a, b) => b.tvl - a.tvl); LL = { at: Date.now(), m, pot, potMin }; try { fs.writeFileSync(path.join(DATA, 'air_llama.json'), JSON.stringify(LL)); } catch {} } catch {}
  }
  /* 11/3 她：融资抓不全 → 本地自己查（用雷达里看不见的浏览器视窗打开项目官网／文件／部落格），
     刚上线的项目查得比较勤，之后放慢（只是查资料的频率）。查到就存 data/air_fund.json，不花 AI 用量。 */
  const FUNDF = path.join(DATA, 'air_fund.json');
  let FD = (() => { try { return JSON.parse(fs.readFileSync(FUNDF, 'utf8')); } catch { return {}; } })();
  const saveFD = () => { try { fs.writeFileSync(FUNDF, JSON.stringify(FD)); } catch {} };
  const AMT = '\\$\\s?[\\d.,]+\\s*(?:million|billion|[MBK])\\b';
  const amtOf = (t) => { const s = String(t || ''); const pats = [new RegExp('(?:total (?:funding|raised|funds raised)|funding raised|fundraising|融资总额|总融资)\\s*[:：]?\\s*(' + AMT + ')', 'i'), new RegExp('(?:raised|raises|raising|secured|secures|closes|closed)\\s+(?:a |an |over |about |around |nearly |more than |a total of )?(' + AMT + ')', 'i'), new RegExp('(' + AMT + ')\\s+(?:seed|series [a-e]|strategic|private|funding|round|raise)\\b', 'i')]; for (const re of pats) { const m = s.match(re); if (m) { const a = m[1].replace(/\s+/g, ' ').replace(/^\$ /, '$'); return Object.assign(new String(a), { snip: s.slice(Math.max(0, m.index - SNIP), m.index + m[0].length + SNIP).replace(/\s+/g, ' ').trim() }); } } return ''; }; /* C6：(raise|round) 要整个字；一起带回官网原文前后一段，让你自己判断是不是项目本身的融资 */
  const SNIP = 80; /* 运作：官网原文前后各带几个字（只是显示） */
  const snipTxt = (sn) => (sn ? `官网原文：…${String(sn).replace(/[\u0000-\u001f<>]/g, '')}…（金额是在官网文字里找到的，未必是项目本身的融资）` : '');
  const ledOf = (t) => { const v = ((String(t || '').match(/(?:led by|co-led by|backed by|investors? (?:include|including)|participation from)\s+([A-Z][\w.&' -]{2,80}?)(?:[.,;\n]| and other| among| as well| with participation)/) || [])[1] || '').trim().slice(0, 60); return /^[A-Z0-9$]{2,8}$/.test(v) || v.length < 4 ? '' : v; };
  async function fundOne(x) {
    if (typeof browse !== 'function') return null;
    const name = String(x.name || '').replace(/\s*airdrop\s*$/i, '').trim(); const k = nk(name); if (!k) return null;
    const tries = [];
    /* RootData 打不开（空白页）、CryptoRank 有防机器人验证 → 不绕过，改查项目自己的网站：首页、关于、文件、部落格。查不到的由每天 15:00 的空投扫描补 */
    if (x.host) { const h = String(x.host).replace(/^www\./, ''); for (const u of ['https://' + x.host + '/', 'https://' + h + '/about', 'https://docs.' + h + '/', 'https://blog.' + h + '/', 'https://' + h + '/blog']) tries.push(async () => { const d = await browse(u); if (!d?.text || /cloudflare|安全验证|安全驗證|verify you are human|just a moment/i.test(d.title + ' ' + d.text.slice(0, 300))) return null; const f = amtOf(d.text); return f ? { fund: String(f), snip: snipTxt(f.snip), led: ledOf(d.text), src: '官网', url: u } : null; }); }
    for (const t of tries) { try { const r = await t(); if (r) return r; } catch {} }
    return null;
  }
  let fbusy = 0;
  async function fundTick(list) {
    if (fbusy || typeof browse !== 'function') return; fbusy = 1;
    try {
      const now = Date.now(); let n = 0;
      for (const x of list) {
        if (x.det?.fund) continue; const k = nk(x.name); if (!k) continue;
        const o = FD[k] || { first: now, last: 0, tries: 0 };
        const young = now - o.first < 14 * 86400e3; const due = !o.last || (o.fund ? false : now - o.last > (young ? 86400e3 : 7 * 86400e3));
        if (!due) continue; if (++n > FUND_BUDGET) break;
        const r = await fundOne(x).catch(() => null);
        FD[k] = { ...o, last: Date.now(), tries: (o.tries || 0) + 1, ...(r ? { fund: r.fund, snip: r.snip || '', led: r.led, src: r.src, url: r.url, at: Date.now() } : {}) }; saveFD();
      }
    } finally { fbusy = 0; }
  }
  const fundOf = (x) => { const f = FD[nk(x.name)]; return f?.fund ? f : null; };
  async function refresh(force) {
    if (busy || (!force && Date.now() - (HOT.at || 0) < 3 * 3600e3 && HOT.list?.length && HOT.v === 2)) return; busy = 1;
    try {
      const got = [];
      for (const [k, u] of [['hot', 'https://airdrops.io/hot/'], ['latest', 'https://airdrops.io/latest/'], ['confirmed', 'https://airdrops.io/confirmed/']]) {
        try { const t = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) })).text(); got.push(...parse(t, k)); } catch {}
      }
      const m = new Map(); for (const x of got) { const o = m.get(x.url); m.set(x.url, o ? { ...o, heat: Math.max(o.heat, x.heat), kinds: [...new Set([...(o.kinds || [o.kind]), x.kind])], claim: o.claim || x.claim, confirmed: o.confirmed || x.confirmed } : { ...x, kinds: [x.kind] }); }
      const list = [...m.values()].sort((a, b) => b.heat - a.heat); /* ZR-1103：抓到的全部列出 */
      const old = new Map((HOT.list || []).map((x) => [x.url, x])); let n = 0;
      for (const x of list) { const o = old.get(x.url); if (o?.det && Date.now() - (o.det.at || 0) < 24 * 3600e3) { x.det = o.det; continue; } if (n >= DETAIL_BUDGET) { if (o?.det) x.det = o.det; continue; } n++; try { x.det = parseDetail(await (await fetch(x.url, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) })).text()); } catch { if (o?.det) x.det = o.det; } await new Promise((r) => setTimeout(r, 800)); }
      await llama();
      for (const x of list) { const txt = [x.name, x.act, x.det?.desc].join(' '); x.sect = sectOf(txt); x.money = MONEY.test(x.act + ' ' + (x.det?.desc || '')) && !/^free$/i.test(x.det?.cost || ''); const L = LL.m?.[nk(x.name)]; if (L) { x.llama = L; const lk = LLC[L.c]; if (lk && !x.sect.includes(lk)) x.sect = [lk, ...x.sect]; } x.src = 1 + (L ? 1 : 0); const o = old.get(x.url); if (o?.risk && Date.now() - (o.risk.at || 0) < 24 * 3600e3) x.risk = o.risk; }
      for (const x of list.filter((y) => y.host && !y.risk).slice(0, RISK_BUDGET)) { try { const r = await checkUrl('https://' + x.host); x.risk = { lvl: r.lvl, why: r.why, age: r.age ?? null, at: Date.now() }; } catch {} }
      for (const x of list) { if (x.det && !x.det.fund) { const f = fundOf(x); if (f) { x.det.fund = f.fund; if (!x.det.led && f.led) x.det.led = f.led; x.det.fsrc = f.src; x.det.fsnip = f.snip || ''; x.src = (x.src || 1) + 1; } } }
      if (list.length) { HOT = { v: 2, at: Date.now(), list, pot: LL.pot || [] }; try { fs.writeFileSync(HOTF, JSON.stringify(HOT)); } catch {} }
      setTimeout(() => fundTick(list).then(() => { let ch = 0; for (const x of HOT.list || []) { if (x.det && !x.det.fund) { const f = fundOf(x); if (f) { x.det.fund = f.fund; if (!x.det.led && f.led) x.det.led = f.led; x.det.fsrc = f.src; x.det.fsnip = f.snip || ''; ch = 1; } } } if (ch) try { fs.writeFileSync(HOTF, JSON.stringify(HOT)); } catch {} }).catch(() => {}), 5000);
    } finally { busy = 0; }
  }
  setTimeout(() => refresh().catch(() => {}), 20e3); setInterval(() => refresh().catch(() => {}), 30 * 60e3);

  // ── 防钓鱼：看网址长相＋网域多新（RDAP，公开免费），只给提醒，不会挡 ──
  const BRAND = ['binance', 'pancakeswap', 'metamask', 'trustwallet', 'okx', 'bybit', 'bitget', 'coinbase', 'uniswap', 'opensea', 'galxe', 'layer3', 'zealy', 'robinhood', 'gmgn', 'dexscreener', 'four', 'flap', 'telegram', 'twitter', 'airdrops', 'debank', 'zksync', 'arbitrum', 'optimism', 'base', 'linea', 'scroll', 'blast', 'jupiter', 'phantom', 'rabby', 'safepal', 'tokenpocket', 'ledger', 'trezor'];
  const OFFICIAL = new Set(['binance.com', 'pancakeswap.finance', 'metamask.io', 'trustwallet.com', 'okx.com', 'bybit.com', 'bitget.com', 'coinbase.com', 'uniswap.org', 'opensea.io', 'galxe.com', 'app.galxe.com', 'layer3.xyz', 'zealy.io', 'robinhood.com', 'gmgn.ai', 'dexscreener.com', 'four.meme', 'flap.sh', 't.me', 'telegram.org', 'x.com', 'twitter.com', 'airdrops.io', 'debank.com', 'zksync.io', 'arbitrum.io', 'optimism.io', 'base.org', 'linea.build', 'scroll.io', 'blast.io', 'jup.ag', 'phantom.app', 'rabby.io', 'safepal.com', 'tokenpocket.pro', 'ledger.com', 'trezor.io', 'bscscan.com', 'etherscan.io', 'github.com', 'discord.com', 'discord.gg', 'medium.com', 'youtube.com', 'google.com', 'notion.so', 'gitbook.io']);
  const HOSTED = ['github.com', 'github.io', 'gitbook.io', 'gitbook.com', 'notion.so', 'notion.site', 'medium.com', 'mirror.xyz', 'substack.com', 'sites.google.com', 'docs.google.com', 'forms.gle', 'youtube.com', 'youtu.be', 't.me', 'x.com', 'twitter.com', 'discord.gg', 'discord.com', 'linktr.ee', 'vercel.app', 'netlify.app', 'pages.dev', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'wixsite.com', 'blogspot.com', 'webflow.io', 'carrd.co']; /* 运作：谁都能在上面开页面的平台（只当提醒，不挡） */
  const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const RDAP = new Map();
  async function checkUrl(u) {
    const why = []; let lvl = 0; let host = '';
    try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); host = x.hostname.toLowerCase(); if (x.protocol !== 'https:') { why.push('不是 https 加密连线'); lvl = Math.max(lvl, 1); } if (x.username || x.password) { why.push('网址里藏了帐号密码（常见骗术）'); lvl = 2; } } catch { return { lvl: 2, why: ['网址格式不对'], host: '' }; }
    const parts = host.split('.'); const root = parts.slice(-2).join('.'); const name = parts.slice(-2, -1)[0] || '';
    const hz = HOSTED.find((d) => host === d || host.endsWith('.' + d)) || ''; if (hz) { why.push(`这是任何人都能开页面的网站（${hz}），网址是这里不代表是官方，要自己确认是不是项目方本人的页面`); lvl = Math.max(lvl, 1); } /* CHAIN-1104 D10＋C5：用户自己开页面的平台不能算「官方网域」，而且下面的检查照做（不提早结束） */
    if (!hz && (OFFICIAL.has(host) || OFFICIAL.has(root))) return { lvl, why: lvl ? why : ['常见的官方网域'], host };
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) { why.push('直接用 IP，不是网域'); lvl = 2; }
    if (host.includes('xn--')) { why.push('用了长得像英文的特殊字（xn--）'); lvl = 2; }
    if (setOn('air.tldWarn') && /\.(zip|mov|xyz|top|click|live|site|online|icu|buzz|rest|monster|cfd|sbs)$/.test(host)) { why.push('后缀常被拿来做钓鱼站（你开了「可疑后缀提醒」）'); lvl = Math.max(lvl, 1); } /* CHAIN-1104：这份后缀名单是工具自己的判断 → 改成你的开关 air.tldWarn（预设关） */
    if (parts.length > 2) why.push(`网址有 ${parts.length - 2} 层子网域`); /* ZR-1103：只写事实，不再用官方层数判可疑 */
    const COMMON = new Set(['finance', 'network', 'protocol', 'airdrop', 'claim', 'wallet', 'chain', 'swap', 'labs', 'token', 'money', 'games', 'space', 'trade', 'basic', 'based']);
    const bh = hz ? host.slice(0, -hz.length).replace(/\.$/, '') : host; /* C5：在别人平台上开的页面，只看平台前面那段（例如 binance-claim.pages.dev 看 binance-claim） */
    for (const b of BRAND) { const seg = bh.replace(/\./g, '-').split('-').filter((x) => !COMMON.has(x)); if (seg.some((s) => s === b) || (b.length >= 6 && seg.some((s) => s !== b && s.length >= 5 && lev(s, b) <= (b.length >= 8 ? 2 : 1)))) { why.push(`像在模仿「${b}」但不是官方网域`); lvl = 2; break; } }
    let age = null; if (!hz) try { let r = RDAP.get(root); if (!r || Date.now() - r.at > 86400e3) { const j = await (await fetch('https://rdap.org/domain/' + root, { signal: AbortSignal.timeout(10000) })).json(); const ev = (j.events || []).find((e) => /registration/i.test(e.eventAction)); r = { at: Date.now(), reg: ev ? Date.parse(ev.eventDate) : 0 }; RDAP.set(root, r); } if (r.reg) { age = Math.floor((Date.now() - r.reg) / 86400e3); const nd = setNum('air.newDomainDays'); if (nd != null && age < nd) { why.push(`网域才注册 ${age} 天（你设 ${nd} 天内算新）`); lvl = Math.max(lvl, 1); } } } catch {} /* ZR-1103：几天内算「新网域」＝你的设定（没填＝只显示注册天数） */
    if (age != null && !why.some((w) => /注册/.test(w))) why.push(`网域已注册 ${age} 天`); if (!lvl) why.push(age != null ? '没看到可疑的地方' : '没看到可疑的地方（查不到注册日期）');
    return { lvl, why, host, age };
  }
  return { hot: () => HOT, refresh, checkUrl, fundOne, fundTick };
}
module.exports = { startAir };
