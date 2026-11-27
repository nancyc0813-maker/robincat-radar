// 罗宾猫雷达 · 空投页（雷达这边）：热门空投（airdrops.io）、网址防钓鱼检查
// 她 11/2 23:00：空投独立成一页。这里只做「读」，不碰钱包、不下单。
// ZR-1103：清单不筛、不截（抓到几个就列几个）；板块／钓鱼检查只贴「事实标签」；「潜力项目」的 TVL 门槛、新网域天数都是你的设定（没填＝不用）
const fs = require('fs'), path = require('path');
function startAir({ DATA, browse, log = () => {} }) {
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
      const url = (part.match(/<a href=["']?(https:\/\/airdrops\.io\/[a-z0-9-]+\/)["']?[^>]*>\s*<h3\b[^>]*>/i) || [])[1] || ''; /*AIRH3-1127 11/27 实测 airdrops.io 的标题改成 <h3 translate="no">，旧写法认不到＝0 个项目、才掉进宽松读法 */
      const name = strip((part.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
      if (!url || !name) continue;
      const img = (part.match(/data-src="(https:\/\/airdrops\.io\/wp-content\/[^"]+)"/) || [])[1] || '';
      const act = strip((part.match(/Actions:\s*<span>([\s\S]*?)<\/span>/) || [])[1]).slice(0, 160);
      const d = (s) => (/^\d{8}/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : '');
      const badges = [...part.matchAll(/class="badge-([\w-]+)"/g)].map((m) => m[1]);
      const req = ['telegram', 'twitter', 'discord', 'email-address', 'phone', 'kyc'].filter((k) => a('data-' + k + '-required') === '1').map((k) => k.replace('-address', ''));
      out.push({ name: name.slice(0, 60), url, img, heat: +a('data-temperature') || 0, ends: d(a('data-ends')), start: d(a('data-start')), pub: d(a('data-published')), ended: /\bended\b/.test(part.slice(0, 400)), confirmed: badges.includes('confirmed') || /\bconfirmed\b/.test(part.slice(0, 400)), claim: badges.includes('claim-live'), kyc: a('data-kyc-required') === '1', req, host: (part.match(/data-outbound-host="([^"]+)"/) || [])[1] || '', act, kind });
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
  /*AIRFB-1126 备用来源：airdrops.io 的网站地图（sitemap_index.xml → 最近更新的那份 project-sitemap）。11/26 实测：首页／项目页对程式回 Cloudflare 验证页（403），网站地图照样 200。
     只有网址、来源更新日、图片；名称从网址转（例 flop-labs → Flop Labs）。不知道已确认／热门／可领取 */
  const CHAL = /Just a moment|cf-chl|challenge-platform|Attention Required/i;
  const AS = { sampleLen: 4096, deepPages: 30, deepGapMs: 600, deepStop: 2 }; /* 技术用：存几个字的样本；AIRDEEP-1127「最新」往后翻几页（越后面越旧）、每页间隔、连续几页都没有进行中的就停（网路量），不是买卖门槛 */
  /*AIRS-1126 宽松读法：标准格式读不到时，找页面里指向项目页（airdrops.io/<名字>/）的连结；网站自己的分类／说明页不算。来自「已确认」页的标已确认、「热门」页的标热门（就是它出现在哪一页的事实） */
  const NOT_PROJ = new Set(['blog', 'categories', 'category', 'latest', 'hot', 'confirmed', 'page', 'tag', 'author', 'feed', 'search', 'visit', 'about', 'contact', 'faq', 'privacy-policy', 'terms', 'advertise', 'submit', 'wp-content', 'wp-admin', 'wp-json', 'speculative', 'ended', 'upcoming', 'potential', 'guides', 'newsletter', 'login', 'register', 'cart', 'shop']);
  function parseLoose(html, kind) { const out = [], seen = new Set();
    for (const m of String(html).matchAll(/<a\b[^>]*href=["']?(?:https:\/\/airdrops\.io)?\/([a-z0-9-]+)\/["']?[^>]*>([\s\S]{0,400}?)<\/a>/gi)) { const sl = m[1].toLowerCase(); if (NOT_PROJ.has(sl) || seen.has(sl)) continue; const ttl = (m[0].match(/title=["']([^"']+)["']/) || [])[1] || ''; const name = strip(m[2]) || strip(ttl); if (!name || name.length < 2 || /^(read more|more|view|details?|learn more)$/i.test(name)) continue;
      seen.add(sl); out.push({ name: name.replace(/\s*airdrop\s*$/i, '').slice(0, 60), url: 'https://airdrops.io/' + sl + '/', img: '', heat: 0, ends: '', start: '', pub: '', confirmed: kind === 'confirmed', claim: false, kind, via: 'loose' }); }
    return out; }
  const xmlTags = (x, tag) => [...String(x).matchAll(new RegExp('<' + tag + '>([^<]*)</' + tag + '>', 'g'))].map((m) => m[1].trim());
  const slugName = (u) => { const sl = (String(u).match(/airdrops\.io\/([a-z0-9-]+)\/?$/i) || [])[1] || ''; return sl.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 60); };
  function parseSitemap(xml) { const out = []; for (const b of String(xml).split('<url>').slice(1)) { const loc = xmlTags(b, 'loc')[0] || ''; if (!/^https:\/\/airdrops\.io\/[a-z0-9-]+\/$/i.test(loc)) continue; const name = slugName(loc); if (!name) continue; const img = (b.match(/<image:loc>([^<]+)<\/image:loc>/) || [])[1] || ''; const ym = [...b.matchAll(/wp-content\/uploads\/(\d{4})\/(\d{2})\//g)].map((m) => m[1] + '-' + m[2]).sort()[0] || ''; /* 图片上传的年月（最早那张）≈ 收录的月份 */ out.push({ name, url: loc, img, ym, upd: (xmlTags(b, 'lastmod')[0] || '').slice(0, 10), heat: 0, kind: 'sitemap', via: 'sitemap' }); } return out; }
  async function sitemapList() { const H = { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) };
    const r = await fetch('https://airdrops.io/sitemap_index.xml', H); const ix = await r.text(); if (!r.ok || CHAL.test(ix)) return { list: [], why: '网站地图也读不到（' + (CHAL.test(ix) ? 'Cloudflare 验证页' : 'HTTP ' + r.status) + '）' };
    const maps = String(ix).split('<sitemap>').slice(1).map((b) => ({ loc: xmlTags(b, 'loc')[0] || '', mod: xmlTags(b, 'lastmod')[0] || '' })).filter((x) => /project-sitemap\d*\.xml$/.test(x.loc)).sort((a, b) => (b.mod > a.mod ? 1 : b.mod < a.mod ? -1 : 0));
    if (!maps.length) return { list: [], why: '网站地图里没有项目清单' }; const r2 = await fetch(maps[0].loc, { ...H, signal: AbortSignal.timeout(20000) }); const t2 = await r2.text(); const list = r2.ok ? parseSitemap(t2) : []; return { list, file: maps[0].loc, why: list.length ? '' : '项目清单读不到（HTTP ' + r2.status + '）' }; }
  /*AIRLOCAL-1126 雷达视窗跟引擎都会跑这个（视窗关着时引擎照样更新）：开始前先读档案（另一边可能刚更新完）；同一时间只有一边在抓（data/air_refresh.lock，抓完删；那个程式已经不在＝不算） */
  const LKF = path.join(DATA, 'air_refresh.lock'); const AL = { lockMs: 900e3 }; /* 技术用：锁多久没更新就当对方当掉了 */
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } };
  const reload = () => { try { const st = fs.statSync(HOTF); if (st.mtimeMs === reload.mt) return; reload.mt = st.mtimeMs; const d = JSON.parse(fs.readFileSync(HOTF, 'utf8')); if ((d.at || 0) >= (HOT.at || 0)) HOT = d; } catch {} };
  const lockBusy = () => { try { const o = JSON.parse(fs.readFileSync(LKF, 'utf8')); return o.pid !== process.pid && Date.now() - (o.at || 0) < AL.lockMs && alive(o.pid); } catch { return false; } };
  async function refresh(force) {
    reload(); if (busy || (!force && Date.now() - (HOT.at || 0) < 3 * 3600e3 && HOT.list?.length && HOT.v === 2)) return; if (lockBusy()) return; busy = 1; try { fs.writeFileSync(LKF, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch {}
    try {
      const got = []; const diag = { at: Date.now(), pages: [], src: 'html' }; /*AIRFB-1126 每一页抓到什么都记下来（data/air_fetch.json＋日志），抓到 0 个要看得出原因 */
      for (const [k, u] of [['hot', 'https://airdrops.io/hot/'], ['latest', 'https://airdrops.io/latest/'], ['confirmed', 'https://airdrops.io/confirmed/']]) {
        const d = { k, status: null, n: 0, why: '' };
        try { const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) }); d.status = r.status; const t = await r.text(); let p = parse(t, k); if (!p.length && r.ok && !CHAL.test(t)) { p = parseLoose(t, k); if (p.length) d.loose = 1; } d.n = p.length; got.push(...p); if (!p.length) d.why = CHAL.test(t) ? 'Cloudflare 验证页（网站挡了这个程式）' : r.ok ? '页面格式变了（读不到项目）' : 'HTTP ' + r.status;
          if (r.ok && (!p.length || d.loose)) { d.sample = 'air_fetch_sample_' + k + '.html'; try { const hd = [...r.headers].map(([a, b]) => a + ': ' + b).join('\n'); fs.writeFileSync(path.join(DATA, d.sample), `<!-- ${u}\nHTTP ${r.status}\n${hd}\nbody ${t.length} 字 -->\n` + t.slice(0, AS.sampleLen)); } catch {} } } catch (e) { d.why = '连不上：' + String(e?.message || e).slice(0, 80); } /*AIRS-1126 回 200 却读不到项目：把回应的标头和开头一段存起来（每页一个档、覆盖），看得到程式实际收到什么 */
        diag.pages.push(d);
      }
      if (got.length) { /*AIRDEEP-1127 首页三页只有最前面一小段：往后翻「最新」的分页，把还在进行中的项目都收进来（11/27 实测 TermiX、42 都在后面的分页） */
        const dp = { k: 'latest+', pages: 0, n: 0 }; let empty = 0;
        for (let pg = 2; pg <= AS.deepPages; pg++) { try { const r = await fetch(`https://airdrops.io/latest/page/${pg}/`, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) }); if (!r.ok) break; const p = parse(await r.text(), 'latest'); if (!p.length) break; dp.pages = pg; const live = p.filter((x) => !x.ended || x.claim); dp.n += live.length; got.push(...live); empty = live.length ? 0 : empty + 1; if (empty >= AS.deepStop) break; } catch { break; } await new Promise((res) => setTimeout(res, AS.deepGapMs)); }
        diag.pages.push(dp); }
      if (!got.length) { const fb = await sitemapList().catch((e) => ({ list: [], why: String(e?.message || e).slice(0, 80) })); diag.src = 'sitemap'; diag.fallback = { n: fb.list.length, why: fb.why || '', file: fb.file || '' }; got.push(...fb.list); } /* 首页都读不到 → 备用：网站地图（只有网址、名称、来源更新日；没有状态标签、热度） */
      try { fs.writeFileSync(path.join(DATA, 'air_fetch.json'), JSON.stringify(diag)); } catch {}
      { const sig = JSON.stringify([diag.src, diag.pages.map((p) => [p.k, p.n, p.why]), diag.fallback]); if (sig !== refresh.lastSig) { refresh.lastSig = sig; log(`[空投清单] airdrops.io：${diag.pages.map((p) => `${p.k} ${p.n} 个${p.why ? '（' + p.why + '）' : ''}`).join('、')}${diag.fallback ? `；首页都读不到，改用网站地图：${diag.fallback.n} 个${diag.fallback.why ? '（' + diag.fallback.why + '）' : ''}` : ''}`); } }
      const m = new Map(); for (const x of got) { const o = m.get(x.url); m.set(x.url, o ? { ...o, heat: Math.max(o.heat, x.heat), kinds: [...new Set([...(o.kinds || [o.kind]), x.kind])], claim: o.claim || x.claim, confirmed: o.confirmed || x.confirmed } : { ...x, kinds: [x.kind] }); }
      const list = [...m.values()].filter((x) => !x.ended || x.claim).sort((a, b) => b.heat - a.heat); /* ZR-1103：抓到的全部列出（AIRDEEP-1127：来源标「已结束」又不能领取的不列） */
      const old = new Map((HOT.list || []).map((x) => [x.url, x])); let n = diag.src === 'sitemap' ? DETAIL_BUDGET : 0; /* 备用来源时详情页一样会被挡：不抓（沿用以前抓到的） */
      for (const x of [...list].sort((a, b) => String(b.pub || '').localeCompare(String(a.pub || '')))) { const o = old.get(x.url); if (o?.det && Date.now() - (o.det.at || 0) < 24 * 3600e3) { x.det = o.det; continue; } /*AIRDEEP-1127 详情页先抓最新收录的（日报要用），旧的慢慢轮 */ if (n >= DETAIL_BUDGET) { if (o?.det) x.det = o.det; continue; } n++; try { x.det = parseDetail(await (await fetch(x.url, { headers: { 'user-agent': 'Mozilla/5.0 RobinCatRadar' }, signal: AbortSignal.timeout(20000) })).text()); } catch { if (o?.det) x.det = o.det; } await new Promise((r) => setTimeout(r, 800)); }
      await llama();
      for (const x of list) { const txt = [x.name, x.act, x.det?.desc].join(' '); x.sect = sectOf(txt); x.money = MONEY.test(x.act + ' ' + (x.det?.desc || '')) && !/^free$/i.test(x.det?.cost || ''); const L = LL.m?.[nk(x.name)]; if (L) { x.llama = L; const lk = LLC[L.c]; if (lk && !x.sect.includes(lk)) x.sect = [lk, ...x.sect]; } x.src = 1 + (L ? 1 : 0); const o = old.get(x.url); if (o?.risk && Date.now() - (o.risk.at || 0) < 24 * 3600e3) x.risk = o.risk; }
      for (const x of list.filter((y) => y.host && !y.risk).slice(0, RISK_BUDGET)) { try { const r = await checkUrl('https://' + x.host); x.risk = { lvl: r.lvl, why: r.why, age: r.age ?? null, at: Date.now() }; } catch {} }
      for (const x of list) { if (x.det && !x.det.fund) { const f = fundOf(x); if (f) { x.det.fund = f.fund; if (!x.det.led && f.led) x.det.led = f.led; x.det.fsrc = f.src; x.det.fsnip = f.snip || ''; x.src = (x.src || 1) + 1; } } }
      if (list.length) { HOT = { v: 2, at: Date.now(), list, pot: LL.pot || [], src: diag.src }; try { fs.writeFileSync(HOTF, JSON.stringify(HOT)); } catch {} }
      setTimeout(() => fundTick(list).then(() => { let ch = 0; for (const x of HOT.list || []) { if (x.det && !x.det.fund) { const f = fundOf(x); if (f) { x.det.fund = f.fund; if (!x.det.led && f.led) x.det.led = f.led; x.det.fsrc = f.src; x.det.fsnip = f.snip || ''; ch = 1; } } } if (ch) try { fs.writeFileSync(HOTF, JSON.stringify(HOT)); } catch {} }).catch(() => {}), 5000);
    } finally { busy = 0; try { fs.rmSync(LKF, { force: true }); } catch {} }
  }
  setTimeout(() => refresh().catch(() => {}), 20e3).unref?.(); setInterval(() => refresh().catch(() => {}), 30 * 60e3).unref?.(); /* unref：不会因为这个计时器让程式关不掉 */

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
  return { hot: () => { reload(); return HOT; }, refresh, checkUrl, fundOne, fundTick, parseSitemap, parseLoose };
}
module.exports = { startAir };
