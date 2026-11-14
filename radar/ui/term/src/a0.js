/* ===== TV2-1114 新看盘终端：外框＋资料桥 =====
   画面元素的资料全部来自主程式现有 IPC（window.radar.*）：b3／mc board／kolFeed／signals／kfLocal／klineHist／tape／tokenDetail／cardRisk／pxBar／news／snapshot。
   读不到的栏位＝null＝画面不显示（不写 0、不编资料）。下单一律转呼叫旧画面原本的流程（__tvO，见 g0.js），经主程式到引擎的 actionGate。 */
const R=window.radar||null;
const ROOTEL=document.createElement('div');ROOTEL.id='tv2';
ROOTEL.innerHTML=`<div id="amb"></div><div id="nprog"></div><div id="app"><div class="top" id="top"></div><div class="esbar" id="esbar"></div><div class="wbar" id="wbar"></div><div class="body2"><div class="nav" id="nav"></div><div class="navv" id="navv"></div><div class="stage" id="tvStage"><div class="view off" id="pg"></div><div class="view" id="ws"><div class="drop"></div><div class="guide"><b></b></div></div><div class="view off" id="tok"></div><div class="drwv" id="drwv"></div><div class="drw" id="drw"></div></div></div><div class="dock" id="dock"></div></div><div class="toastw" id="toasts"></div>`;
/* 外框：新版开着时把旧画面的顶栏／主区藏起来（旧画面的程式照跑：手机连线、配乐、通知、引擎状态都不受影响）；要用旧功能时把旧主区显示在新版的舞台位置 */
const TVCSS=`html.tv2on body>header,html.tv2on body>#offb,html.tv2on #slogan{display:none!important}
html.tv2on body>main{display:none!important}
html.tv2on.tv2leg body>main{display:block!important;position:fixed!important;z-index:60;overflow:auto;top:var(--tvLegT,96px);left:var(--tvLegL,64px);right:var(--tvLegR,0px);bottom:var(--tvLegB,34px);margin:0!important;padding:12px 18px 40px!important;max-width:none!important;box-sizing:border-box;background:var(--bg,#0b0d11)}
#tv2{position:fixed;inset:0;z-index:50}html:not(.tv2on) #tv2{display:none}
#tvLegBar{display:none}html.tv2on.tv2leg #tvLegBar{display:flex;position:fixed;z-index:61;left:var(--tvLegL,64px);right:var(--tvLegR,0px);top:calc(var(--tvLegT,96px) - 30px);height:30px;align-items:center;gap:10px;padding:0 14px;font:12px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;background:#11151b;color:#aab3c0;border-bottom:1px solid rgba(255,255,255,.08)}
#tvLegBar b{color:#e8edf3}#tvLegBar button{margin-left:auto;background:none;border:1px solid rgba(255,255,255,.18);color:#e8edf3;border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit}
#tvOldBtn{display:none}html:not(.tv2on) #tvOldBtn{display:block;position:fixed;right:14px;bottom:14px;z-index:89;padding:8px 14px;border-radius:999px;border:1px solid #f0b90b;background:#14110a;color:#f0b90b;font:600 13px system-ui,"PingFang SC","Microsoft YaHei",sans-serif;cursor:pointer}`;
{const st=document.createElement('style');st.id='tv2css0';st.textContent=TVCSS;document.head.appendChild(st);const lb=document.createElement('div');lb.id='tvLegBar';document.body.appendChild(lb);const ob=document.createElement('button');ob.id='tvOldBtn';ob.textContent='切到新版看盘终端';ob.onclick=()=>tvSetLegacy(0);document.body.appendChild(ob)}
document.body.appendChild(ROOTEL);
const TV={on:(()=>{try{return localStorage.getItem('tv2Legacy')!=='1'}catch{return true}})(),leg:null,lang:'zh'};
document.documentElement.classList.toggle('tv2on',TV.on);
function tvSetLegacy(v){try{localStorage.setItem('tv2Legacy',v?'1':'0')}catch{}TV.on=!v;document.documentElement.classList.toggle('tv2on',TV.on);if(!TV.on)legLeave();else{legLeave();try{rerenderAll()}catch(e){console.error(e)}}}
/* 旧功能放进新外框：点旧画面自己的分页（旧程式会照原本的方式载入那一页），再把旧主区摆在舞台的位置 */
const LEGN={set:['自订策略','Strategies'],sig:['信号','Signals'],grp:['热门社群','Hot groups'],air:['空投','Airdrops'],nwp:['新闻','News'],sentry:['安全哨兵','Sentinel'],ai:['AI 加功能','AI add-ons'],more:['设定','Settings'],phone:['连结手机／TG 控制','Phone / TG control'],hold:['持仓','Holdings'],board:['看盘（铸造／挖矿）','Board (mint / mining)']};
function legPlace(){const s=$('#tvStage');if(!s)return;const r=s.getBoundingClientRect();const d=document.documentElement.style;d.setProperty('--tvLegT',(r.top+30)+'px');d.setProperty('--tvLegL',r.left+'px');d.setProperty('--tvLegR',Math.max(0,innerWidth-r.right)+'px');d.setProperty('--tvLegB',Math.max(0,innerHeight-r.bottom)+'px')}
function legShow(p,after){if(!TV.on)return;const a=document.querySelector(`header nav.tabs a[data-p="${p}"]`);if(!a){toast(L('旧版这一页找不到','Legacy page not found'));return}
 try{a.click()}catch(e){console.error(e)}TV.leg=p;legPlace();document.documentElement.classList.add('tv2leg');const n=LEGN[p]||[p,p];$('#tvLegBar').innerHTML=`<span>${L('雷达功能','Radar feature')}：<b>${esc(L(n[0],n[1]))}</b></span><span>${L('跟旧版同一套设定与流程（买卖一样经过统一闸门）','Same settings and flow as before (orders still go through the action gate)')}</span><button type="button" id="tvLegX">${L('关闭','Close')}</button>`;$('#tvLegX').onclick=()=>{legLeave();paintNav()};
 try{document.querySelector('body>main').scrollTop=0}catch{}if(after)setTimeout(()=>{try{after()}catch(e){console.error(e)}},80)}
function legLeave(){TV.leg=null;document.documentElement.classList.remove('tv2leg')}
addEventListener('resize',()=>{if(TV.leg)legPlace()});
function tvZoom(z){try{R&&R.zoomSet&&R.zoomSet(z/100)}catch{}}

/* ===== 链：雷达代号对照 ===== */
const NETOF={bsc:'bsc',rh:'robinhood',sol:'solana',base:'base',eth:'eth',xl:'xlayer',arb:'arbitrum',poly:'polygon',monad:'monad',hype:'hyperevm',ely:'elysium'};
const CHOF={};for(const [a,b] of Object.entries(NETOF))CHOF[b]=a;CHOF.rh='rh';
/* 能不能交易：一律照主程式 mc('chains') 回的 mode（main.cjs mcMode：BNB Chain／Robinhood 一律可；钱包支援的 ETH／Base／Arbitrum／Polygon／Solana 可手动买卖；其他只看）。还没读到之前：只有 BNB Chain／Robinhood（主程式 MC_RADAR_TRADE 固定可交易） */
const MODE={bsc:'trade',rh:'trade'};const PADF={};
const OWNB3=new Set(['bsc','rh','sol']);/* radar.b3 有三栏＋热门的链（主程式 B3 看板） */
async function loadModes(){if(!R)return;try{const r=await R.mc('chains');for(const c of r?.chains||[]){const k=CHOF[c.k];if(!k)continue;MODE[k]=c.mode;if(c.pads)PADF[k]=1}}catch(e){console.error(e)}try{paintTop()}catch{}}
const isOwnTrade=ch=>ch==='bsc'||ch==='rh';/* 雷达原本的下单程式（qbBuy／qsSell）；其他可交易的链走 mctrade（旧画面 mctBuy／mctSell） */

/* ===== 代币：把各来源的列整理成同一种物件（读不到＝null） ===== */
const num=v=>v==null||v===''||!isFinite(+v)?null:+v;
function tokFrom(ch,x,grp,src){const c0=String(x.c||'');if(!c0)return null;const c=ch==='sol'?c0:c0.toLowerCase();const id=ch+':'+c;let t=BYID.get(id);
 if(!t){t={id,chain:ch,c,s:'',n:'',hue:hash(c)%360,ch:{m1:null,m5:null,h1:null,h24:null},vol:{m1:null,m5:null,h1:null,h24:null},txn:{m1:null,m5:null,h1:null,h24:null},bs:{h24:null},grp,real:1,sup:null,top10:null,devp:null,snp:null,ins:null,bnd:null,cab:null,phi:null,kol:null,smart:null,pg:null,rs:null,btax:null,stax:null,tax:null,lockp:null,born:null,pl:'',dev:'',devN:null,ath:null,net:null,meta:null,zh:'',desc:null,first:Date.now()};BYID.set(id,t);TOK[ch].push(t)}
 t.seen=Date.now();if(grp&&grp!=='big')t.grp=grp;else if(!t.grp)t.grp='big';
 const s=x.s??x.sym;if(s)t.s=String(s).slice(0,40);const n=x.n??x.name??x.nm;if(n)t.n=String(n).slice(0,80);if(!t.s)t.s=c.slice(0,6);
 const lg=x.lg||x.img;if(lg&&/^https:\/\//.test(lg))t.lg=lg;
 const mc=num(x.mc);if(mc!=null&&mc>0)t.mc=mc;const p=num(x.price??x.cp);if(p!=null&&p>0)t.p=p;if(t.mc>0&&t.p>0)t.sup=t.mc/t.p;
 const l=num(x.tvl??x.liq);if(l!=null)t.l=l;const h=num(x.h??x.holders);if(h!=null)t.h=h;
 const c5=num(x.c5),c1=num(x.c1),c24=num(x.c24);if(c5!=null)t.ch.m5=c5;if(c1!=null)t.ch.h1=c1;if(c24!=null)t.ch.h24=c24;
 const v5=num(x.v5),v1=num(x.v1),v24=num(x.v24);if(v5!=null)t.vol.m5=v5;if(v1!=null)t.vol.h1=v1;if(v24!=null)t.vol.h24=v24;
 const tx1=num(x.tx1),tx24=num(x.tx24??x.tx);if(tx1!=null)t.txn.h1=tx1;if(tx24!=null)t.txn.h24=tx24;
 const by=num(x.by24),sl=num(x.sl24);if(by!=null&&sl!=null){t.bs.h24=[by,sl]}
 const bv1=num(x.bv1),sv1=num(x.sv1);if(bv1!=null&&sv1!=null){t.bsv1=[bv1,sv1];t.net=bv1-sv1}
 const bv24=num(x.bv24),sv24=num(x.sv24);if(bv24!=null&&sv24!=null)t.bsv24=[bv24,sv24];
 const pg=num(x.pg);if(pg!=null)t.pg=Math.max(0,Math.min(100,pg));const rs=num(x.rs);if(rs!=null)t.rs=rs;
 const bt=num(x.bt),st=num(x.st);if(bt!=null)t.btax=bt;if(st!=null)t.stax=st;if(t.btax!=null||t.stax!=null)t.tax=Math.max(t.btax||0,t.stax||0);
 const ca=num(x.ca??(x.at?x.at/1000:null));if(ca!=null&&ca>0)t.born=ca>1e12?ca/1000:ca;
 const pl=x.pl||x.plat||x.platAve;if(pl)t.pl=String(pl);if(x.eco)t.eco=String(x.eco);
 if(x.xl!=null)t.hasX=!!x.xl;if(x.wl!=null)t.hasW=!!x.wl;if(x.tl!=null)t.hasT=!!x.tl;if(x.xl)t.xu=x.xl;if(x.wl)t.wu=x.wl;if(x.tl)t.tu=x.tl;
 if(x.hp)t.hp=1;const kn=num(x.kol);if(kn!=null)t.kol=kn;
 if(src)t.src=src;return t}
/* 只有持有人前 10、开发、狙击、老鼠仓、捆绑：看得到的卡才问主程式（cardRisk，AVE 清单／持有人资料，没有就不显示） */
function applyRisk(ch,M){for(const [a,v] of Object.entries(M||{})){const t=BYID.get(ch+':'+(ch==='sol'?a:a.toLowerCase()));if(!t||!v)continue;const f=(k,q)=>{const x=num(v[q]);if(x!=null)t[k]=x};f('top10','t10');f('devp','dv');f('snp','sn');f('ins','rat');f('bnd','bu')}}
const HOT={};/* 每条链 AVE 热门榜的顺序（RANKAVE：热门／涨幅／跌幅用它） */
const LOAD={at:{},busy:{},err:{},first:{},src:{}};
const MCTAB=[['fresh','new'],['soon','soon'],['done','out'],['hot','big']];
async function loadChain(ch,force){if(!R||LOAD.busy[ch])return;if(!force&&Date.now()-(LOAD.at[ch]||0)<(OWNB3.has(ch)?2500:9000))return;LOAD.busy[ch]=1;const before=new Set(TOK[ch].filter(t=>t.grp==='new').map(t=>t.id));const grpNow=new Map(TOK[ch].map(t=>[t.id,t.grp]));
 try{if(ch==='ely'){/* Elysium：雷达自己读链（ely.on 打开才有，资料在 snapshot().ely）；只看 */const E=__tvO.snap()?.ely;if(!E||!E.on)LOAD.err[ch]=L('Elysium 看盘没打开（到设定 → Elysium 打开，只看）','Elysium board is off (turn it on in Settings; view only)');else{for(const x of E.list||[])tokFrom(ch,{c:x.c||x.addr,s:x.sym||x.s,n:x.name||x.n,mc:x.mc,ca:x.at?x.at/1000:x.ca},'new','ely');LOAD.err[ch]=''}}else if(OWNB3.has(ch)){const v=await R.b3(NETOF[ch]);if(v&&v.cols){const C=v.cols;const seenG=new Map();for(const [k,g] of [['new','new'],['soon','soon'],['out','out']])for(const x of C[k]||[]){const t=tokFrom(ch,x,g,'b3');if(t)seenG.set(t.id,g)}HOT[ch]=[];for(const x of C.hot||[]){const t=tokFrom(ch,x,null,'b3');if(t){HOT[ch].push(t.id);if(!seenG.has(t.id))t.grp=t.grp&&t.grp!=='big'&&grpNow.get(t.id)?t.grp:'big'}}for(const [id,g] of seenG){const t=BYID.get(id);if(t)t.grp=g}LOAD.err[ch]=v.err||'';if(ch==='bsc')FEAST.v=v.feast||null}else LOAD.err[ch]=v?.err||'b3'}
  else{const out=await Promise.all(MCTAB.map(([tab])=>R.mc('board',{chain:NETOF[ch],tab}).catch(()=>null)));const seenG=new Map();MCTAB.forEach(([tab,g],i)=>{const v=out[i];if(!v||v.err)return;if(tab==='hot')HOT[ch]=[];for(const x of v.items||[]){const t=tokFrom(ch,x,g==='big'?null:g,'mc');if(!t)continue;if(g==='big'){HOT[ch].push(t.id);if(!seenG.has(t.id)&&!(grpNow.get(t.id)&&grpNow.get(t.id)!=='big'))t.grp='big'}else seenG.set(t.id,g)}});for(const [id,g] of seenG){const t=BYID.get(id);if(t)t.grp=g}LOAD.err[ch]=out.every(v=>!v||v.err)?(out[0]?.err||'mc'):''}
 }catch(e){LOAD.err[ch]=String(e?.message||e).slice(0,80)}finally{LOAD.busy[ch]=0;LOAD.at[ch]=Date.now()}
 /* 新开盘新进来的 → 推进三栏（第一次载入不推，免得一次滑进一百张） */
 if(LOAD.first[ch]&&ch===ST.chain){for(const t of TOK[ch])if(t.grp==='new'&&!before.has(t.id)&&grpNow.get(t.id)==null)for(const h of TRH)h.push('new',t)}
 LOAD.first[ch]=1;prune(ch)}
function prune(ch){const keep=new Set([...ST.wl,ST.focus,TKP&&TKP.t&&TKP.t.id].filter(Boolean));const cut=Date.now()-15*60e3;const a=TOK[ch];for(let i=a.length-1;i>=0;i--){const t=a[i];if(t.seen<cut&&!keep.has(t.id)&&!t.ref){a.splice(i,1);BYID.delete(t.id)}}}
/* 别的地方（喊单、KOL 动态、自选）提到但还不在清单里的币：先做一个小物件，之后看盘资料到了会补齐 */
function stubTok(ch,c,o={}){if(!CH[ch]||!c)return null;const id=ch+':'+(ch==='sol'?c:String(c).toLowerCase());let t=BYID.get(id);if(t){t.ref=1;if(!(t.mc>0)&&o.mc>0)t.mc=o.mc;if(!t.s&&o.sym)t.s=o.sym;return t}t=tokFrom(ch,{c,s:o.sym||'',mc:o.mc,lg:o.img},'big','ref');if(t){t.ref=1;t.seen=Date.now()+3600e3}return t}
let RISKT=0;async function riskVisible(){if(!R||!R.cardRisk||Date.now()-RISKT<8000)return;RISKT=Date.now();const ch=ST.chain;const ids=[...new Set([...ROOTEL.querySelectorAll('[data-t]')].map(e=>e.dataset.t).filter(id=>id&&id.startsWith(ch+':')))].slice(0,60);if(!ids.length)return;try{const M=await R.cardRisk(NETOF[ch],ids.map(id=>id.slice(ch.length+1)));applyRisk(ch,M)}catch{}}

/* ===== K 线、成交、详情（看哪个币才拿哪个币；同一个币短时间内不重拿） ===== */
const KC=new Map();/* 'id|tf' → {at,bars(秒),src,busy} */
const KTF={'1s':'1s','1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d'};
function kKey(t,tf){return t.id+'|'+tf}
function kGet(t,tf){const k=kKey(t,tf);let e=KC.get(k);const fresh=tf==='1s'?3000:tf==='1m'?8000:20000;if(!e){e={at:0,bars:[],busy:0,src:'',err:''};KC.set(k,e)}if(!e.busy&&Date.now()-e.at>fresh&&R){e.busy=1;R.klineHist(NETOF[t.chain],t.c,t.pool||'',KTF[tf]||'5m',0,true).then(r=>{const B=Array.isArray(r?.bars)?r.bars:Array.isArray(r)?r:[];e.bars=B.filter(b=>b&&b.t>0&&b.c>0).map(b=>({t:Math.floor(b.t/1000),o:+b.o,h:+b.h,l:+b.l,c:+b.c,v:+b.v||0,gap:b.gap?1:0}));e.src=r?.src||'';if(r?.pool&&!t.pool)t.pool=r.pool;e.err=B.length?'':(r?.err||'');if(r?.sup>0&&!t.sup)t.sup=r.sup;const lb=e.bars.at(-1);if(lb&&!(t.p>0))t.p=lb.c;for(const h of CHARTS)h.update()}).catch(er=>{e.err=String(er?.message||er).slice(0,60)}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
const TC=new Map();/* 成交 id → {at,rows,src} */
function trGet(t){let e=TC.get(t.id);if(!e){e={at:0,rows:[],busy:0,src:''};TC.set(t.id,e)}if(!e.busy&&Date.now()-e.at>5000&&R&&R.tape){e.busy=1;R.tape(NETOF[t.chain],t.c,t.pool||'',false).then(r=>{const rows=Array.isArray(r?.rows)?r.rows:[];e.src=r?.src||'';e.rows=rows.map(x=>{const tags=(x.tg||[]).map(String);const tag=tags.find(g=>/kol/i.test(g))?'kol':tags.find(g=>/sm|smart/i.test(g))?'smart':tags.find(g=>/dev/i.test(g))?'dev':tags.find(g=>/sn/i.test(g))?'snp':tags.find(g=>/rat|ins/i.test(g))?'rat':tags.find(g=>/bu|bnd/i.test(g))?'bnd':tags.find(g=>/me|mine/i.test(g))?'me':'';const p=+x.p||null;return {t:Math.floor((+x.t||0)/1000),buy:!!x.b,usd:+x.usd||0,p,mc:p&&t.sup?p*t.sup:null,tag,who:String(x.w||''),hue:hash(String(x.w||''))%360}});for(const h of TRADEH)h.redraw&&h.redraw()}).catch(()=>{}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
const TRADEH=new Set();
const DC=new Map();/* 详情（tokenDetail）：风险、持有人标签、池子 */
function dGet(t){let e=DC.get(t.id);if(!e){e={at:0,d:null,busy:0};DC.set(t.id,e)}if(!e.busy&&Date.now()-e.at>60000&&R){e.busy=1;const p=isOwnTrade(t.chain)?R.tokenDetail(NETOF[t.chain],t.c):R.mc('detail',{chain:NETOF[t.chain],c:t.c});p.then(d=>{e.d=d||null;dApply(t,d)}).catch(()=>{}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
function dApply(t,d){if(!d)return;const P=d.pair||{};const tok=d.tok||{};const pool0=t.pool;if(P.addr&&!t.pool&&/^0x[0-9a-fA-F]{40}$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(P.addr).split(':')[0]))t.pool=String(P.addr).split(':')[0];if(d.pair&&typeof d.pair==='string'&&!t.pool)t.pool=d.pair;if(t.pool&&t.pool!==pool0){for(const k of [...KC.keys()])if(k.startsWith(t.id+'|')){const e=KC.get(k);if(e&&!e.bars.length)e.at=0}}const p=num(P.price??tok.price);if(p>0)t.p=p;const mc=num(P.mcap??P.fdv??tok.mc);if(mc>0)t.mc=mc;if(t.mc>0&&t.p>0)t.sup=t.mc/t.p;const lq=num(P.liq??tok.liq);if(lq!=null)t.l=lq;
 if(P.chg){for(const [k,q] of [['m5','m5'],['h1','h1'],['h24','h24']]){const v=num(P.chg[q]);if(v!=null&&t.ch[k]==null)t.ch[k]=v}}
 const H=d.aveH;if(H){if(num(H.top10)!=null)t.top10=num(H.top10);t.hold=H}
 const S=d.safety||{};if(num(S.buyTax)!=null)t.btax=num(S.buyTax);if(num(S.sellTax)!=null)t.stax=num(S.sellTax);if(S.honeypot===true)t.hp=1;
 const A=d.aveB||{};if(num(A.rs)!=null)t.rs=num(A.rs);if(num(A.h)!=null)t.h=num(A.h);
 t.scan=d.scan||t.scan||null;t.det=d;try{if(TKP.t===t)paintTokRight()}catch{}}
if(R&&R.onTokenDetailMore)R.onTokenDetailMore(m=>{try{const ch=CHOF[m?.net];if(!ch)return;const t=BYID.get(ch+':'+String(m.addr||'').toLowerCase());if(!t)return;const e=DC.get(t.id);if(e&&e.d)Object.assign(e.d,m.v||{});dApply(t,Object.assign({},e?.d||{},m.v||{}))}catch{}});

/* ===== 动态：喊单（signals）、KOL／聪明钱（kolFeed）、本机统计（kfLocal）、AVE 讯号（需要转接站更新或自己的 AVE 金钥） ===== */
const FEAST={v:null};const RT={at:{},err:{}};
async function loadCalls(){if(!R)return;try{const r=await R.signals();const out=[];for(const g of r?.feed||[]){const ch=CHOF[g.ch]||CHOF[NETOF[g.ch]]||(g.ch==='rh'?'rh':null);if(!ch)continue;const t=stubTok(ch,g.c,{sym:g.sym,mc:g.mc,img:g.img});if(!t)continue;for(const s of g.srcs||[]){if(s.ty==='smart')continue;const tg=s.ty==='tg';const name=String(s.src||'').replace(/^𝕏\s*/,'');out.push({id:'c'+hash(g.k+'|'+s.src+'|'+s.at),tk:t.id,tg,name,hue:hash(name)%360,ts:(s.at||g.last)/1000,at:g.mc0>0?g.mc0:null,max:g.max||null,late:!!g.late,reso:!!g.reso,n:g.n})}}out.sort((a,b)=>b.ts-a.ts);const old=new Set(FEED.calls.map(c=>c.id));const nw=out.filter(c=>!old.has(c.id));FEED.calls=out.slice(0,400);FEED.rank=r?.rank||[];RT.err.calls=r?.err||'';if(RT.at.calls&&nw.length){for(const c of nw.slice(0,10).reverse())pushFeed('calls',c)}RT.at.calls=Date.now()}catch(e){RT.err.calls=String(e?.message||e).slice(0,60)}}
async function loadKol(){if(!R||!R.kolFeed)return;try{const r=await R.kolFeed(300);const out=[];for(const e of r?.items||[]){const ch=CHOF[e.ch];if(!ch)continue;const t=stubTok(ch,e.c,{sym:e.sym,mc:e.mc});if(!t)continue;const name=e.nm||sAddr(String(e.w||''));out.push({id:'s'+hash(String(e.h||'')+e.w+e.c+e.side),tk:t.id,kind:e.kind==='kol'?'kol':e.kind==='trk'?'trk':'smart',name,w:e.w,hue:hash(String(e.w||''))%360,buy:e.side==='buy',usd:num(e.usd),mc:num(e.mc0),ts:(e.ts||e.at)/1000,lat:e.ts&&e.at?(e.at-e.ts)/1000:null})}out.sort((a,b)=>b.ts-a.ts);const old=new Set(FEED.smart.map(s=>s.id));const nw=out.filter(s=>!old.has(s.id));FEED.smart=out;FEED.kstat=r?.stat||null;RT.err.kol=r?.err||'';if(RT.at.kol&&nw.length)for(const s of nw.slice(0,10).reverse())pushFeed('smart',s);RT.at.kol=Date.now()}catch(e){RT.err.kol=String(e?.message||e).slice(0,60)}}
const KFL={};async function loadKfLocal(ch){if(!R||!R.kfLocal)return;try{const r=await R.kfLocal(NETOF[ch]);KFL[ch]={at:Date.now(),list:r?.list||[],live:r?.live||'off',watching:r?.watching||0,err:r?.err||''}}catch(e){KFL[ch]={at:Date.now(),list:[],err:String(e)}}}
/* AVE 公开讯号／叙事板块：主程式 term IPC（有自己的 AVE 金钥就直接问；用转接站的要等转接站加 /v2/ranks、/v2/signals 规则） */
const AVEQ={sig:{},topics:null,err:{}};
async function loadAveSig(ch){if(!R||!R.term)return;try{const r=await R.term('signals',{chain:NETOF[ch]});if(r?.err){AVEQ.err.sig=r.err;return}AVEQ.err.sig='';const L2=[];for(const g of r?.list||[]){const t=stubTok(ch,g.c,{sym:g.sym,mc:g.mcNow});if(!t)continue;L2.push({id:'g'+hash(ch+g.c+g.ts),tk:t.id,kt:g.type||'',mc:num(g.mc),mcNow:num(g.mcNow),mx:num(g.mx),ts:g.ts,n:num(g.n),w:g.w||'',buy:g.buy!==0,ac:num(g.ac)})}AVEQ.sig[ch]=L2;FEED.sig=Object.values(AVEQ.sig).flat().sort((a,b)=>b.ts-a.ts)}catch(e){AVEQ.err.sig=String(e?.message||e).slice(0,60)}}
async function loadTopics(){if(!R||!R.term)return;try{const r=await R.term('topics',{});if(r?.err){AVEQ.err.topics=r.err;return}AVEQ.err.topics='';AVEQ.topics=r?.list||[]}catch(e){AVEQ.err.topics=String(e?.message||e).slice(0,60)}}
const aveNeedTxt=()=>L('需要转接站更新或自己的 AVE 金钥','Needs a relay update or your own AVE key');
function pushFeed(k,x){const kinds=k==='calls'?['calls']:k==='smart'?['smart','kolfeed']:[k];for(const [,p] of INST)if(kinds.includes(p.p.t))p.h.push&&p.h.push(x);for(const h of PGH)if(kinds.includes(h._t))h.push&&h.push(x);if(kinds.includes(DRW.t))DRW.h&&DRW.h.push&&DRW.h.push(x);else if(k==='calls'||k==='smart'){const b=k==='calls'?'calls':'kolfeed';DRW.badge[b]=Math.min(99,(DRW.badge[b]||0)+1);paintDockBadges()}}
/* 持仓：主程式 snapshot().hold（雷达自己记的持仓，BNB Chain／Robinhood） */
function loadPos(){const S=__tvO.snap();const H=S?.hold||[];const out=[];for(const h of H){const ch=h.chain==='rh'?'rh':'bsc';const t=stubTok(ch,h.addr,{sym:h.sym});if(!t)continue;out.push({tk:t.id,sym:h.sym,cost:num(h.cost),value:num(h.value),x:num(h.x),dead:!!h.dead,wallet:h.wallet||'',plat:h.plat||''})}POS.length=0;POS.push(...out)}
/* 主币价格（底部／顶栏）：主程式 pxBar（币安公开行情，读不到用 DexScreener） */
const PX={v:null,at:0};async function loadPx(){if(!R)return;try{const r=await R.pxBar();if(r){PX.v=r;PX.at=Date.now();MAJ[0][1]=num(r.btc);MAJ[1][1]=num(r.eth);MAJ[2][1]=num(r.sol);MAJ[3][1]=num(r.bnb)}}catch{}}
const SRC={v:null};async function loadSrc(){if(!R||!R.srcStat)return;try{SRC.v=await R.srcStat()}catch{}}
/* 钱包余额（引擎写的 radar_bal.json → snapshot().bal） */
function balTxt(ch){const S=__tvO.snap();const W=S?.bal?.w||[];if(ch==='bsc'){const v=W.reduce((a,w)=>a+(+w.bnb||0),0);return W.length&&v>0?v.toFixed(4).replace(/\.?0+$/,'')+' BNB':'—'}if(ch==='rh'){const v=W.reduce((a,w)=>a+(+w.eth||+w.rhEth||0),0);return W.length&&v>0?v.toFixed(4).replace(/\.?0+$/,'')+' ETH':'—'}return '—'}
