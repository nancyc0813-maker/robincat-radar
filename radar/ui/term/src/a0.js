/* ===== 技术常数（TV2-1114）：新看盘终端只做画面，下面的数字全部只影响版面／显示／读取频率；买卖金额、门槛全部是玩家自己填（预设空），下单转呼叫旧画面流程经 actionGate ===== */
const [CNT_10,CNT_100,CNT_12,CNT_14,CNT_2,CNT_200,CNT_24,CNT_3,CNT_30,CNT_4,CNT_40,CNT_400,CNT_5,CNT_50,CNT_500,CNT_6,CNT_60,CNT_8,CNT_80,CNT_81]=[10,100,12,14,2,200,24,3,30,4,40,400,5,50,500,6,60,8,80,81];/* 技术用：一次画几列／几张卡、最多留几笔在画面、卷到底再补几列、截断长度，只影响显示 */
const [MS_1000,MS_15,MS_20000,MS_3000,MS_3600000,MS_5000,MS_600,MS_6000,MS_60000,MS_8000,MS_9000,MS_15000]=[1000,15,20000,3000,3600e3,5000,600,6000,60000,8000,9000,15000];/* 技术用：毫秒（秒换毫秒、画面向主程式轮询的间隔、快取多久算旧、提示停留时间），只影响读取频率与显示 */
const [TS_1E12]=[1e12];/* 技术用：毫秒时间戳的判断（大于这个数＝毫秒，否则是秒），单位换算 */
const [UI_0,UI_10,UI_100,UI_1000,UI_14,UI_15,UI_180,UI_1E18,UI_1E9,UI_2,UI_20,UI_24,UI_26,UI_28,UI_3,UI_30,UI_3600,UI_4,UI_40,UI_48,UI_5,UI_50,UI_6,UI_60,UI_7,UI_72,UI_8,UI_86400,UI_90,UI_9999]=[0,10,100,1000,14,15,180,1e18,1e9,2,20,24,26,28,3,30,3600,4,40,48,5,50,6,60,7,72,8,86400,90,9999];/* 技术用：画面显示用的小数字（小数位数、动画步数、分页数、风险颜色红黄绿门槛——只影响颜色，画面有写「只影响显示」），不进任何买卖、跳过、排除、通知判断 */
const PX_TOKMIN=104,PX_MCMIN=52;/* 技术用（只影响排版）：清单太窄时代币栏／市值栏最少多宽（代币名看得到） */
const [PX_0P2,PX_0P5,PX_0P8,PX_10,PX_1000,PX_120,PX_14,PX_15,PX_1600,PX_170,PX_200,PX_25,PX_260,PX_3,PX_30,PX_4,PX_40,PX_600,PX_760,PX_8,PX_960,PX_9999]=[.2,.5,.8,10,1000,120,14,15,1600,170,200,25,260,3,30,4,40,600,760,8,960,9999];/* 技术用：版面像素（窄面板少显示几栏、手机宽度断点、选单位置、列高、栏宽），只影响版面 */
const [SEC_1000,SEC_120,SEC_60,SEC_86400]=[1000,120,60,86400];/* 技术用：秒（年龄显示切换单位、刚上线标亮、延迟换算），只影响显示 */
const [FR_0P01,FR_0P38,FR_0P42,FR_0P45,FR_0P48,FR_0P5,FR_0P52,FR_0P55,FR_0P58,FR_0P62,FR_1EM12]=[.01,.38,.42,.45,.48,.5,.52,.55,.58,.62,1e-12];/* 技术用：版面比例（预设布局的栏宽、面板高度比例），只影响版面 */
const SLIP_MAX=100;/* 技术用（格式检查，不是建议值）：滑点上限＝钱包官方允许的最大值（币安 baw market-order.md「0–100」、OKX onchainos validators.rs「0（不含）–100」），跟 mctrade.mjs MCT_SLIP_MAX 同一个 */
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
const UNK=[];/* 钱包回报、雷达还不认得的链（主程式 mc chains 的 unknown）：只提示「等雷达更新才会开放买卖」，不开放 */
async function loadModes(){if(!R)return;try{const r=await R.mc('chains');for(const c of r?.chains||[]){const k=CHOF[c.k];if(!k)continue;MODE[k]=c.mode;if(c.pads)PADF[k]=1}UNK.length=0;UNK.push(...(r?.unknown||[]));const told=LS.g('unkTold',[]);const fresh=UNK.filter(u=>!told.includes(u.kind+':'+u.id));if(fresh.length){LS.s('unkTold',[...told,...fresh.map(u=>u.kind+':'+u.id)].slice(-50));toast(L(`钱包新支援 ${fresh.map(u=>(u.name||u.id)).join('、')}：等雷达更新才会开放买卖`,`Your wallet now supports ${fresh.map(u=>u.name||u.id).join(', ')}: trading opens after a radar update`))}}catch(e){console.error(e)}try{paintTop()}catch{}}
const isOwnTrade=ch=>ch==='bsc'||ch==='rh';/* 雷达原本的下单程式（qbBuy／qsSell）；其他可交易的链走 mctrade（旧画面 mctBuy／mctSell） */

/* ===== 代币：把各来源的列整理成同一种物件（读不到＝null） ===== */
const num=v=>v==null||v===''||!isFinite(+v)?null:+v;
function tokFrom(ch,x,grp,src){const c0=String(x.c||'');if(!c0)return null;const c=ch==='sol'?c0:c0.toLowerCase();const id=ch+':'+c;let t=BYID.get(id);
 if(!t){t={id,chain:ch,c,s:'',n:'',hue:hash(c)%360,ch:{m1:null,m5:null,h1:null,h24:null},vol:{m1:null,m5:null,h1:null,h24:null},txn:{m1:null,m5:null,h1:null,h24:null},bs:{h24:null},grp,real:1,sup:null,top10:null,devp:null,snp:null,ins:null,bnd:null,cab:null,phi:null,kol:null,smart:null,pg:null,rs:null,btax:null,stax:null,tax:null,lockp:null,born:null,pl:'',dev:'',devN:null,ath:null,net:null,meta:null,zh:'',desc:null,first:Date.now()};BYID.set(id,t);TOK[ch].push(t)}
 t.seen=Date.now();if(grp&&grp!=='big')t.grp=grp;else if(!t.grp)t.grp='big';
 const s=x.s??x.sym;if(s)t.s=String(s).slice(0,40);const n=x.n??x.name??x.nm;if(n)t.n=String(n).slice(0,80);if(!t.s)t.s=c.slice(0,CNT_6);
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
 const ca=num(x.ca??(x.at?x.at/MS_1000:null));if(ca!=null&&ca>0)t.born=ca>TS_1E12?ca/MS_1000:ca;
 const pl=x.pl||x.plat||x.platAve;if(pl)t.pl=String(pl);if(x.eco)t.eco=String(x.eco);
 if(x.xl!=null)t.hasX=!!x.xl;if(x.wl!=null)t.hasW=!!x.wl;if(x.tl!=null)t.hasT=!!x.tl;if(x.xl)t.xu=x.xl;if(x.wl)t.wu=x.wl;if(x.tl)t.tu=x.tl;
 if(x.hp)t.hp=1;const kn=num(x.kol);if(kn!=null)t.kol=kn;
 if(src)t.src=src;return t}
/* 只有持有人前 10、开发、狙击、老鼠仓、捆绑：看得到的卡才问主程式（cardRisk，AVE 清单／持有人资料，没有就不显示） */
function applyRisk(ch,M){for(const [a,v] of Object.entries(M||{})){const t=BYID.get(ch+':'+(ch==='sol'?a:a.toLowerCase()));if(!t||!v)continue;const f=(k,q)=>{const x=num(v[q]);if(x!=null)t[k]=x};f('top10','t10');f('devp','dv');f('snp','sn');f('ins','rat');f('bnd','bu')}}
const HOT={};/* 每条链 AVE 热门榜的顺序（RANKAVE：热门／涨幅／跌幅用它） */
const LOAD={at:{},busy:{},err:{},first:{},src:{}};
const MCTAB=[['fresh','new'],['soon','soon'],['done','out'],['hot','big']];
async function loadChain(ch,force){if(!R||LOAD.busy[ch])return;if(!force&&Date.now()-(LOAD.at[ch]||UI_0)<(OWNB3.has(ch)?2500:MS_9000))return;LOAD.busy[ch]=1;const before=new Set(TOK[ch].filter(t=>t.grp==='new').map(t=>t.id));const grpNow=new Map(TOK[ch].map(t=>[t.id,t.grp]));
 try{if(ch==='ely'){/* Elysium：雷达自己读链（ely.on 打开才有，资料在 snapshot().ely）；只看 */const E=__tvO.snap()?.ely;if(!E||!E.on)LOAD.err[ch]=L('Elysium 看盘没打开（到设定 → Elysium 打开，只看）','Elysium board is off (turn it on in Settings; view only)');else{for(const x of E.list||[])tokFrom(ch,{c:x.c||x.addr,s:x.sym||x.s,n:x.name||x.n,mc:x.mc,ca:x.at?x.at/MS_1000:x.ca},'new','ely');LOAD.err[ch]=''}}else if(OWNB3.has(ch)){const v=await R.b3(NETOF[ch]);if(v&&v.cols){const C=v.cols;const seenG=new Map();for(const [k,g] of [['new','new'],['soon','soon'],['out','out']])for(const x of C[k]||[]){const t=tokFrom(ch,x,g,'b3');if(t)seenG.set(t.id,g)}HOT[ch]=[];for(const x of C.hot||[]){const t=tokFrom(ch,x,null,'b3');if(t){HOT[ch].push(t.id);if(!seenG.has(t.id))t.grp=t.grp&&t.grp!=='big'&&grpNow.get(t.id)?t.grp:'big'}}for(const [id,g] of seenG){const t=BYID.get(id);if(t)t.grp=g}LOAD.err[ch]=v.err||'';if(ch==='bsc')FEAST.v=v.feast||null}else LOAD.err[ch]=v?.err||'b3'}
  else{const out=await Promise.all(MCTAB.map(([tab])=>R.mc('board',{chain:NETOF[ch],tab}).catch(()=>null)));const seenG=new Map();MCTAB.forEach(([tab,g],i)=>{const v=out[i];if(!v||v.err)return;if(tab==='hot')HOT[ch]=[];for(const x of v.items||[]){const t=tokFrom(ch,x,g==='big'?null:g,'mc');if(!t)continue;if(g==='big'){HOT[ch].push(t.id);if(!seenG.has(t.id)&&!(grpNow.get(t.id)&&grpNow.get(t.id)!=='big'))t.grp='big'}else seenG.set(t.id,g)}});for(const [id,g] of seenG){const t=BYID.get(id);if(t)t.grp=g}LOAD.err[ch]=out.every(v=>!v||v.err)?(out[0]?.err||'mc'):''}
 }catch(e){LOAD.err[ch]=String(e?.message||e).slice(0,80)}finally{LOAD.busy[ch]=0;LOAD.at[ch]=Date.now()}
 /* 新开盘新进来的 → 推进三栏（第一次载入不推，免得一次滑进一百张） */
 if(LOAD.first[ch]&&ch===ST.chain){for(const t of TOK[ch])if(t.grp==='new'&&!before.has(t.id)&&grpNow.get(t.id)==null)for(const h of TRH)h.push('new',t)}
 LOAD.first[ch]=1;prune(ch)}
function prune(ch){const keep=new Set([...ST.wl,ST.focus,TKP&&TKP.t&&TKP.t.id].filter(Boolean));const cut=Date.now()-MS_15*MS_60000;const a=TOK[ch];for(let i=a.length-1;i>=0;i--){const t=a[i];if(t.seen<cut&&!keep.has(t.id)&&!t.ref){a.splice(i,1);BYID.delete(t.id)}}}
/* 别的地方（喊单、KOL 动态、自选）提到但还不在清单里的币：先做一个小物件，之后看盘资料到了会补齐 */
function stubTok(ch,c,o={}){if(!CH[ch]||!c)return null;const id=ch+':'+(ch==='sol'?c:String(c).toLowerCase());let t=BYID.get(id);if(t){t.ref=1;if(!(t.mc>0)&&o.mc>0)t.mc=o.mc;if(!t.s&&o.sym)t.s=o.sym;return t}t=tokFrom(ch,{c,s:o.sym||'',mc:o.mc,lg:o.img},'big','ref');if(t){t.ref=1;t.seen=Date.now()+MS_3600000}return t}
let RISKT=0;async function riskVisible(){if(!R||!R.cardRisk||Date.now()-RISKT<MS_8000)return;RISKT=Date.now();const ch=ST.chain;const ids=[...new Set([...ROOTEL.querySelectorAll('[data-t]')].map(e=>e.dataset.t).filter(id=>id&&id.startsWith(ch+':')))].slice(0,60);if(!ids.length)return;try{const M=await R.cardRisk(NETOF[ch],ids.map(id=>id.slice(ch.length+1)));applyRisk(ch,M)}catch{}}

/* ===== K 线、成交、详情（看哪个币才拿哪个币；同一个币短时间内不重拿） ===== */
const KC=new Map();/* 'id|tf' → {at,bars(秒),src,busy} */
const KTF={'1s':'1s','1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1d':'1d'};
function kKey(t,tf){return t.id+'|'+tf}
/* SOLK-1114 Solana pump.fun 内盘币的 1s／5s／15s：主程式本机读链（radar.solk）；已上外盘或其他链照旧 GeckoTerminal */
const solLocal=t=>!!(t&&t.chain==='sol'&&/^pump([._ -]?fun)?$/i.test(String(t.pl||''))&&(t.grp==='new'||t.grp==='soon')&&R&&R.solk);
const lsec=tf=>['1s','5s','15s','30s'].includes(tf)?TF.find(x=>x[0]===tf)[1]:0;const secLocal=t=>!!t&&(solLocal(t)||isOwnTrade(t.chain));/*SEC30-1114 秒线 1s／5s／15s／30s：照币安钱包（1秒／5秒／30秒）、OKX（1秒／30秒）；只给雷达自己读链的链（Solana pump 内盘、BNB Chain／Robinhood）*//* 本机秒线的秒数照 K 线周期表 TF */
function kGetLocal(t,tf){const k=kKey(t,tf);let e=KC.get(k);if(!e){e={at:0,bars:[],busy:0,src:'',err:'',local:1,dl:[],lastTs:0,dlag:null,dlagN:0};KC.set(k,e)}if(!e.busy&&Date.now()-e.at>MS_1000){e.busy=1;R.solk(t.c,lsec(tf)).then(r=>{if(!r||r.err){e.err=r?.err==='cap'?L('Solana 订阅已满（跟 KOL 动态共用上限）','Solana subscription cap reached (shared with KOL feed)'):String(r?.err||'');return}e.err=r.st==='on'?'':r.st;e.src='chain';if(!r.usd){e.bars=[];e.err=L('SOL 美金价读不到，先不画','SOL price unavailable');return}e.bars=(r.bars||[]).map(b=>({t:Math.floor(b.t/MS_1000),o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}));if(!t.sup&&r.sup)t.sup=r.sup;const L0=r.last;if(L0&&L0.ts&&L0.ts!==e.lastTs){e.lastTs=L0.ts;e.dl.push(Date.now()/MS_1000-L0.ts);if(e.dl.length>CNT_200)e.dl.shift();const D=e.dl.slice().sort((a,b)=>a-b);e.dlag=+D[Math.floor(D.length/2)].toFixed(2);e.dlagN=D.length}for(const h of CHARTS)h.update()}).catch(er=>{e.err=String(er?.message||er)}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
function kGet(t,tf){if(lsec(tf)&&solLocal(t))return kGetLocal(t,tf);if(lsec(tf)&&isOwnTrade(t.chain)&&!kGet.inner)return kGetOwn(t,tf);if(lsec(tf))tf='1s';const k=kKey(t,tf);let e=KC.get(k);const fresh=tf==='1s'?MS_3000:tf==='1m'?MS_8000:MS_20000;if(!e){e={at:0,bars:[],busy:0,src:'',err:''};KC.set(k,e)}if(!e.busy&&Date.now()-e.at>fresh&&R){e.busy=1;R.klineHist(NETOF[t.chain],t.c,t.pool||'',KTF[tf]||'5m',0,true).then(r=>{const B=Array.isArray(r?.bars)?r.bars:Array.isArray(r)?r:[];e.bars=B.filter(b=>b&&b.t>0&&b.c>0).map(b=>({t:Math.floor(b.t/MS_1000),o:+b.o,h:+b.h,l:+b.l,c:+b.c,v:+b.v||0,gap:b.gap?1:0}));e.src=r?.src||'';if(r?.pool&&!t.pool)t.pool=r.pool;e.err=B.length?'':r?.err==='nochain'?L('这条链的 K 线还没接','Candles for this chain are not wired yet'):r?.err==='busy'?L('资料来源忙，自动重试中','Data source busy, retrying automatically'):r?.err==='nopool'?L('未开盘（还没有交易池）','Not launched yet (no pool)'):String(r?.err||'');e.busyErr=!B.length&&r?.err==='busy';e.code=B.length?'':String(r?.err||'');/*KNET-1114 限速＝照实说、自动重试；没有来源的链不说「还没有成交」*/if(r?.sup>0&&!t.sup)t.sup=r.sup;const lb=e.bars.at(-1);if(lb&&!(t.p>0))t.p=lb.c;for(const h of CHARTS)h.update()}).catch(er=>{e.err=String(er?.message||er).slice(0,60)}).finally(()=>{e.busy=0;e.at=e.busyErr?Date.now()-fresh+MS_3000:Date.now()})}return e}
/*SEC1S-1114 BNB Chain／Robinhood 秒线：照币安钱包／OKX 的 1 秒线（即时）。内盘币＝雷达读链记的 K 线（原本就有，这里只合成 5s／15s／30s）；
  已上外盘＝雷达读链的成交明细（主程式 tape，0.8 秒快取）在画面合成秒线，比 GeckoTerminal（11/14 实测慢 3 分钟以上）快；雷达开始看之前的部分照旧用 GeckoTerminal 补。成交只放记忆体 */
const OWNACC=new Map();
function aggSec(rows,sec){const B=new Map();for(const x of rows){const b=Math.floor(x.t/sec)*sec;let o=B.get(b);if(!o){o={t:b,o:x.o??x.p,h:x.h??x.p,l:x.l??x.p,c:x.c??x.p,v:0,f:x.t,z:x.t};B.set(b,o)}else{if(x.t<o.f){o.o=x.o??x.p;o.f=x.t}if(x.t>=o.z){o.c=x.c??x.p;o.z=x.t}o.h=Math.max(o.h,x.h??x.p);o.l=Math.min(o.l,x.l??x.p)}o.v+=(x.usd??x.v)||0}return [...B.values()].sort((a,b)=>a.t-b.t).map(o=>({t:o.t,o:o.o,h:o.h,l:o.l,c:o.c,v:o.v}))}
function fillSec(L,sec,n){if(!L.length)return L;const out=[];const end=Math.floor(nowS()/sec)*sec;for(let i=0;i<L.length;i++){out.push(L[i]);const nx=i+1<L.length?L[i+1].t:end+sec;for(let tt=L[i].t+sec;tt<nx;tt+=sec){out.push({t:tt,o:L[i].c,h:L[i].c,l:L[i].c,c:L[i].c,v:0,gap:1});if(out.length>n*CNT_4)out.splice(0,n)}}return out.slice(-n)}
function kGetOwn(t,tf){const sec=lsec(tf);kGet.inner=1;let b;try{b=kGet(t,'1s')}finally{kGet.inner=0}
 const k=kKey(t,tf)+'|own';let e=KC.get(k);if(!e){e={at:0,bars:[],busy:0,src:'',err:'',own:1,dl:[],last:0,dlag:null,dlagN:0};KC.set(k,e)}
 e.busy=b.busy&&!b.at;e.at=b.at||e.at;e.err=b.err;e.code=b.code;
 if(b.src==='chain'){e.src=L('雷达读链（内盘成交）','Radar on-chain (bonding curve)');e.bars=sec>1?aggSec(b.bars,sec):b.bars;return e}
 const T=trGet(t,1);let A=OWNACC.get(t.id);if(!A){A=new Map();OWNACC.set(t.id,A)}
 for(const x of T.rows){if(!(x.p>0)||!x.tm)continue;const key=x.k||(x.tm+'|'+x.who+'|'+x.usd);if(A.has(key))continue;A.set(key,{t:x.tm/MS_1000,p:x.p,usd:x.usd});if(x.tm>e.last){if(e.last){e.dl.push(Date.now()/MS_1000-x.tm/MS_1000);if(e.dl.length>CNT_200)e.dl.shift();const D=e.dl.slice().sort((a,c)=>a-c);e.dlag=+D[Math.floor(D.length/2)].toFixed(2);e.dlagN=D.length}e.last=x.tm}}
 while(A.size>CNT_200*CNT_10)A.delete(A.keys().next().value);
 const tape=aggSec([...A.values()],sec);const first=tape.length?tape[0].t:Infinity;const hist=aggSec((b.bars||[]).filter(x=>x.t<first).map(x=>({...x})),sec);
 const all=hist.concat(tape);e.bars=fillSec(all,sec,CNT_200+UI_100);e.src=tape.length?(L('雷达读链成交','Radar on-chain trades')+(hist.length?' ＋ GeckoTerminal':'')):b.src;if(tape.length){e.err='';e.code=''}return e}

const TC=new Map();/* 成交 id → {at,rows,src} */
function trGet(t,fast){let e=TC.get(t.id);if(!e){e={at:0,rows:[],busy:0,src:'',err:''};TC.set(t.id,e)}const own=isOwnTrade(t.chain);/*KNET-1114 BNB Chain／Robinhood＝雷达读链＋AVE；其他链＝GeckoTerminal 成交明细（主程式 tape 转给 klinehist.trades），它本身约慢几十秒，所以问得比 BNB Chain 慢（省共用限速）*/const gap=own?(fast?MS_1000:MS_5000):e.err==='busy'?MS_3000:MS_15000;if(!e.busy&&Date.now()-e.at>gap&&R&&R.tape){e.busy=1;R.tape(NETOF[t.chain],t.c,t.pool||'',false).then(r=>{const rows=Array.isArray(r?.rows)?r.rows:[];e.src=r?.src==='gt'?'GeckoTerminal':r?.src==='none'?'':r?.src||'';e.err=rows.length?'':String(r?.err||'');e.rows=rows.map(x=>{const tags=(x.tg||[]).map(String);const tag=tags.find(g=>/kol/i.test(g))?'kol':tags.find(g=>/sm|smart/i.test(g))?'smart':tags.find(g=>/dev/i.test(g))?'dev':tags.find(g=>/sn/i.test(g))?'snp':tags.find(g=>/rat|ins/i.test(g))?'rat':tags.find(g=>/bu|bnd/i.test(g))?'bnd':tags.find(g=>/me|mine/i.test(g))?'me':'';const p=+x.p||null;return {k:String(x.k||''),tm:+x.t||0,t:Math.floor((+x.t||0)/MS_1000),buy:!!x.b,usd:+x.usd||0,p,mc:p&&t.sup?p*t.sup:null,tag,who:String(x.w||''),hue:hash(String(x.w||''))%360}});for(const h of TRADEH)h.redraw&&h.redraw()}).catch(()=>{}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
const TRADEH=new Set();
const DC=new Map();/* 详情（tokenDetail）：风险、持有人标签、池子 */
function dGet(t){let e=DC.get(t.id);if(!e){e={at:0,d:null,busy:0};DC.set(t.id,e)}if(!e.busy&&Date.now()-e.at>MS_60000&&R){e.busy=1;const p=isOwnTrade(t.chain)?R.tokenDetail(NETOF[t.chain],t.c):R.mc('detail',{chain:NETOF[t.chain],c:t.c});p.then(d=>{e.d=d||null;dApply(t,d)}).catch(()=>{}).finally(()=>{e.busy=0;e.at=Date.now()})}return e}
function dApply(t,d){if(!d)return;const P=d.pair||{};const tok=d.tok||{};/* RV8-9 不拿 DexScreener 的交易对当 K 线池子（quq 实测：DexScreener 给的是一天成交只有几千美金的小池，K 线会是空的）；池子由主程式 klineHist 自己挑（回传 r.pool） */const p=num(P.price??tok.price);if(p>0)t.p=p;const mc=num(P.mcap??P.fdv??tok.mc);if(mc>0)t.mc=mc;if(t.mc>0&&t.p>0)t.sup=t.mc/t.p;const lq=num(P.liq??tok.liq);if(lq!=null)t.l=lq;
 if(P.chg){for(const [k,q] of [['m5','m5'],['h1','h1'],['h24','h24']]){const v=num(P.chg[q]);if(v!=null&&t.ch[k]==null)t.ch[k]=v}}
 const H=d.aveH;if(H){if(num(H.top10)!=null)t.top10=num(H.top10);t.hold=H}
 const S=d.safety||{};if(num(S.buyTax)!=null)t.btax=num(S.buyTax);if(num(S.sellTax)!=null)t.stax=num(S.sellTax);if(S.honeypot===true)t.hp=1;
 const A=d.aveB||{};if(num(A.rs)!=null)t.rs=num(A.rs);if(num(A.h)!=null)t.h=num(A.h);
 t.scan=d.scan||t.scan||null;t.det=d;try{if(TKP.t===t)paintTokRight()}catch{}}
if(R&&R.onTokenDetailMore)R.onTokenDetailMore(m=>{try{const ch=CHOF[m?.net];if(!ch)return;const t=BYID.get(ch+':'+String(m.addr||'').toLowerCase());if(!t)return;const e=DC.get(t.id);if(e&&e.d)Object.assign(e.d,m.v||{});dApply(t,Object.assign({},e?.d||{},m.v||{}))}catch{}});

/* ===== 动态：喊单（signals）、KOL／聪明钱（kolFeed）、本机统计（kfLocal）、AVE 讯号（需要转接站更新或自己的 AVE 金钥） ===== */
const FEAST={v:null};const RT={at:{},err:{}};
async function loadCalls(){if(!R)return;try{const r=await R.signals();const out=[];for(const g of r?.feed||[]){const ch=CHOF[g.ch]||CHOF[NETOF[g.ch]]||(g.ch==='rh'?'rh':null);if(!ch)continue;const t=stubTok(ch,g.c,{sym:g.sym,mc:g.mc,img:g.img});if(!t)continue;for(const s of g.srcs||[]){if(s.ty==='smart')continue;const tg=s.ty==='tg';const name=String(s.src||'').replace(/^𝕏\s*/,'');out.push({id:'c'+hash(g.k+'|'+s.src+'|'+s.at),tk:t.id,tg,name,hue:hash(name)%360,ts:(s.at||g.last)/MS_1000,at:g.mc0>0?g.mc0:null,max:g.max||null,late:!!g.late,reso:!!g.reso,n:g.n})}}out.sort((a,b)=>b.ts-a.ts);const old=new Set(FEED.calls.map(c=>c.id));const nw=out.filter(c=>!old.has(c.id));FEED.calls=out.slice(0,400);FEED.rank=r?.rank||[];RT.err.calls=r?.err||'';if(RT.at.calls&&nw.length){for(const c of nw.slice(0,CNT_10).reverse())pushFeed('calls',c)}RT.at.calls=Date.now()}catch(e){RT.err.calls=String(e?.message||e).slice(0,60)}}
async function loadKol(){if(!R||!R.kolFeed)return;try{const r=await R.kolFeed(300);const out=[];for(const e of r?.items||[]){const ch=CHOF[e.ch];if(!ch)continue;const t=stubTok(ch,e.c,{sym:e.sym,mc:e.mc});if(!t)continue;const name=e.nm||sAddr(String(e.w||''));out.push({id:'s'+hash(String(e.h||'')+e.w+e.c+e.side),tk:t.id,kind:e.kind==='kol'?'kol':e.kind==='trk'?'trk':'smart',name,w:e.w,hue:hash(String(e.w||''))%360,buy:e.side==='buy',usd:num(e.usd),mc:num(e.mc0),ts:(e.ts||e.at)/MS_1000,lat:e.ts&&e.at?(e.at-e.ts)/MS_1000:null})}out.sort((a,b)=>b.ts-a.ts);const old=new Set(FEED.smart.map(s=>s.id));const nw=out.filter(s=>!old.has(s.id));FEED.smart=out;FEED.kstat=r?.stat||null;RT.err.kol=r?.err||'';if(RT.at.kol&&nw.length)for(const s of nw.slice(0,CNT_10).reverse())pushFeed('smart',s);RT.at.kol=Date.now()}catch(e){RT.err.kol=String(e?.message||e).slice(0,60)}}
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
