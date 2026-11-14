'use strict';
/* ===== 罗宾猫雷达 新看盘终端（TV2-1114）：资料全部来自主程式，下单转呼叫旧画面流程 ===== */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const LS={g(k,d){try{const v=localStorage.getItem('rc2_'+k);return v==null?d:JSON.parse(v)}catch{return d}},s(k,v){try{localStorage.setItem('rc2_'+k,JSON.stringify(v))}catch{}}};
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return h>>>0}
const nowS=()=>Date.now()/MS_1000;

/* ===== 语言 ===== */
const ST={lang:__tvO.lang(),theme:LS.g('theme','brand'),mode:LS.g('mode','dark'),chain:LS.g('chain','bsc'),estop:0};
const L=(zh,en)=>ST.lang==='en'?(en??zh):zh;

/* ===== 格式 ===== */
const SUB='₀₁₂₃₄₅₆₇₈₉';
function fU(n,pre='$'){if(n==null||n==='')return '—';n=+n;if(!isFinite(n))return '—';const s=n<0?'-':'';const a=Math.abs(n);let r;
 if(a>=1e12)r=(a/1e12).toFixed(a>=1e13?1:2)+'T';/*FMT-1114 照 GMGN／DexScreener 用 K／M／B／T*/else if(a>=1e9)r=(a/1e9).toFixed(a>=1e10?1:2)+'B';else if(a>=1e6)r=(a/1e6).toFixed(a>=1e7?1:2)+'M';else if(a>=1e3)r=(a/MS_1000).toFixed(a>=1e4?1:2)+'K';else r=a>=100?a.toFixed(0):a>=1?a.toFixed(2):a.toFixed(3);
 return s+pre+r.replace(/\.0+([KMBT]?)$/,'$1').replace(/(\.\d*?)0+([KMBT])$/,'$1$2').replace(/\.([KMBT])$/,'$1')}
function fN(n){if(n==null||n==='')return '—';n=+n;if(!isFinite(n))return '—';const a=Math.abs(n);if(a>=1e6)return (n/1e6).toFixed(2).replace(/\.?0+$/,'')+'M';if(a>=1e4)return (n/MS_1000).toFixed(1).replace(/\.0$/,'')+'K';if(a>=1e3)return (n/MS_1000).toFixed(2).replace(/\.?0+$/,'')+'K';return String(Math.round(n))}
function fP(p,pre='$'){p=+p;if(!(p>0))return '—';if(p>=UI_1000)return pre+p.toLocaleString('en-US',{maximumFractionDigits:0});if(p>=1)return pre+p.toFixed(p>=100?2:4);
 const z=Math.floor(-Math.log10(p));if(z>=UI_4){const d=Math.round(p*Math.pow(10,z+3));return pre+'0.0'+String(z).split('').map(c=>SUB[+c]).join('')+String(Math.min(d,999))}
 return pre+p.toPrecision(4)}
function fPct(v,d=1){if(v==null||v==='')return '—';v=+v;if(!isFinite(v))return '—';const a=Math.abs(v);const t=a>=1000?fN(a):a.toFixed(a>=100?0:a>0&&a*CNT_10<1&&d<UI_2?UI_2:d);/* RV8-9 来源有给值但很小（例如 -0.02%）：显示两位，不四舍五入成 0.0% */if(/^0(\.0+)?$/.test(t))return t+'%';return (v>0?'+':v<0?'-':'')+t+'%'}/* 四舍五入成 0 就不带正负号（不出现 -0.0%） */
function fAge(s){if(s==null||!isFinite(s))return '—';s=Math.max(0,Math.floor(s));if(s<UI_60)return s+(L('秒','s'));if(s<UI_3600)return Math.floor(s/60)+L('分','m');if(s<UI_86400)return Math.floor(s/3600)+L('时','h');if(s<UI_86400*30)return Math.floor(s/86400)+L('天','d');if(s<UI_86400*365)return Math.floor(s/86400/30)+L('月','mo');return Math.floor(s/86400/365)+L('年','y')}
function fAgeS(s){if(s==null||!isFinite(s))return '—';s=Math.max(0,Math.floor(s));if(s<UI_60)return s+'s';if(s<UI_3600)return Math.floor(s/60)+'m';if(s<UI_86400)return Math.floor(s/3600)+'h';if(s<UI_86400*365)return Math.floor(s/86400)+'d';return (s/86400/365).toFixed(1).replace(/\.0$/,'')+'y'}/* 全站年龄同一套单位：s／m／h／d／y */
const fx=(v,d=0)=>v==null||!isFinite(+v)?'—':(+v).toFixed(d);
const ageOf=t=>t&&t.born?nowS()-t.born:null;
const sAddr=c=>(c=String(c??'')).length>CNT_12?c.slice(0,4)+'…'+c.slice(-4):c;
const cls=v=>v>0?'up':v<0?'dn':'t3';

/* ===== 图示（自绘线条） ===== */
const IP={
 grip:'<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
 x:'<path d="M17.8 3h3.1l-6.8 7.8L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.3-8.3L2 3h6.4l4.4 5.8z" fill="currentColor" stroke="none"/>',
 web:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
 tg:'<path d="m21 4-18 7.2 5.6 2 2 6.3 3.2-3.6 4.8 3.6z" /><path d="m8.6 13.2 8.4-5.6-6.3 7"/>',
 srch:'<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
 star:'<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
 bolt:'<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="none"/>',
 user:'<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>',
 users:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1.2-3.4 3.6-5 6.5-5s5.3 1.6 6.5 5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 15c2 .6 3.3 2.2 4 5"/>',
 crown:'<path d="m3 8 4.5 4L12 5l4.5 7L21 8l-2 11H5z"/>',
 brain:'<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1"/>',
 copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
 max:'<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',min:'<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
 close:'<path d="M6 6l12 12M18 6 6 18"/>',
 chev:'<path d="m6 9 6 6 6-6"/>',back:'<path d="M15 5l-7 7 7 7"/>',
 link:'<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
 open:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
 pin:'<path d="M9 3h6l-1 6 4 4H6l4-4zM12 13v8"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
 sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
 moon:'<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
 stop:'<rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" stroke="none"/>',
 bell:'<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
 eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
 flame:'<path d="M12 22c4 0 7-2.7 7-7 0-3-1.6-5.4-3.5-7.3.2 2-.7 3.3-1.8 3.8C13.8 7.8 12 5 9 2c.3 3.2-1.4 5.3-3 7.2C4.8 10.6 5 12.6 5 15c0 4.3 3 7 7 7z"/>',
 wallet:'<path d="M3 7a2 2 0 0 1 2-2h13v4"/><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5a2 2 0 0 1-2-2z"/><circle cx="16" cy="14.5" r="1.2" fill="currentColor"/>',
 chat:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.7A8 8 0 1 1 21 12z"/>',
 brief:'<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
 radio:'<circle cx="12" cy="12" r="2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2"/>',
 radar:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 18 6"/>',
 spark:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
 chart:'<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
 list:'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
 cols:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
 trend:'<path d="m3 17 6-6 4 4 8-8M15 7h6v6"/>',
 trophy:'<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
 tag:'<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
 layers:'<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
 save:'<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8M8 21v-7h8v7"/>',
 rat:'<path d="M5 15c0-4 3-7 7-7 3 0 5 2 6 4l3 1-2 2c-1 2-4 3-7 3H7a2 2 0 0 1-2-3z"/><circle cx="15" cy="12" r=".8" fill="currentColor"/>',
 target:'<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
 pkg:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
 code:'<path d="m8 8-5 4 5 4M16 8l5 4-5 4"/>',
 shield:'<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>',
 pause:'<path d="M9 5v14M15 5v14"/>',
 info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
 share:'<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
 lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
 filter:'<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
 reset:'<path d="M4 12a8 8 0 1 0 2.3-5.6L4 8.7M4 4v4.7h4.7"/>',
 send:'<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
 globe2:'<circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>',
 aa:'<path d="M4 18 8.5 6 13 18M5.6 14h5.8M15 11.5c.8-1 1.8-1.5 3-1.5 1.8 0 3 1 3 3v5M21 15c-1-.6-2-.8-3-.8-1.7 0-3 .8-3 2.1 0 1.2 1 1.9 2.3 1.9 1.6 0 2.8-.9 3.7-2.2"/>'
};
/* 图示：同一份 SVG sprite，用 <use> 引用（每个图示只有两个节点，画面元素少很多） */
const I=(k,c='')=>`<svg class="i ${c}" viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-${k}"/></svg>`;
(()=>{const d=document.createElement('div');d.innerHTML=`<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">${Object.entries(IP).map(([k,v])=>`<symbol id="ic-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('')}</svg>`;ROOTEL.prepend(d.firstChild)})();
const LOGO=`<svg viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="lgS" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FFD54A"/><stop offset="1" stop-color="#FF8A3D"/></linearGradient></defs><path d="M6 11.5 7.6 3.8l5.6 4.6M26 11.5l-1.6-7.7-5.6 4.6" fill="#1C2029" stroke="url(#lgS)" stroke-width="1.8" stroke-linejoin="round"/><circle cx="16" cy="18" r="11" fill="#141821" stroke="url(#lgS)" stroke-width="1.8"/><circle cx="16" cy="18" r="6" fill="none" stroke="rgba(240,185,11,.35)" stroke-width="1"/><path d="M16 18 22.5 12.5" stroke="#FFD54A" stroke-width="1.4" stroke-linecap="round" opacity=".8"/><circle cx="16" cy="18" r="1.6" fill="#FFD54A"/><circle cx="21.5" cy="21.5" r="1.3" fill="#3CE3A0"/></svg>`;

/* ===== 资料（全部来自主程式；见 a0.js） ===== */
/* 十条链＋更多链 Elysium。能不能下单不写死：canTrade 读主程式 mcMode（a0 MODE）。ep＝这条链有没有发射台三栏资料（主程式 b3 三栏或 mc chains 的 pads） */
const CH={bsc:{name:'BNB Chain',s:'BSC',u:'BNB',col:'#F0B90B',pad:['four.meme','flap.sh'],ep:1},
 rh:{name:'Robinhood',s:'RH',u:'ETH',col:'#2EBD85',pad:[],ep:1},
 sol:{name:'Solana',s:'SOL',u:'SOL',col:'#9B6BFF',pad:['pump.fun'],ep:1},
 base:{name:'Base',s:'BASE',u:'ETH',col:'#3D7BFF',pad:[]},
 eth:{name:'Ethereum',s:'ETH',u:'ETH',col:'#8A9BFF',pad:[]},
 xl:{name:'X Layer',s:'XL',u:'OKB',col:'#C9CED6',pad:[]},
 arb:{name:'Arbitrum',s:'ARB',u:'ETH',col:'#28A0F0',pad:[]},
 poly:{name:'Polygon',s:'POL',u:'POL',col:'#A47BFF',pad:[]},
 monad:{name:'Monad',s:'MON',u:'MON',col:'#836EF9',pad:[]},
 hype:{name:'HyperEVM',s:'HYPE',u:'HYPE',col:'#50E3C2',pad:[]},
 ely:{name:'Elysium',s:'ELY',u:'ELY',col:'#E7A6FF',pad:[],more:1}};
for(const k of Object.keys(CH))Object.defineProperty(CH[k],'bal',{get:()=>balTxt(k)});
const canTrade=ch=>MODE[ch]==='trade';
const chEp=ch=>!!(CH[ch]&&(CH[ch].ep||PADF[ch]));
const PIN0=['bsc','rh','sol','base','eth'];
const CHS=Object.keys(CH);
const MAJ=[['BTC',null,null],['ETH',null,null],['SOL',null,null],['BNB',null,null]];
const PADS={'pump.fun':['P','#2BB673'],'four.meme':['4','#E8A33B'],'flap.sh':['F','#7A6CFF'],'web3.binance.com':['B','#D9A400'],'believe.app':['b','#3D7BFF'],'bags.fm':['G','#9C5BD9'],'flap_pool_launch':['F','#7A6CFF'],'open.four':['4','#E8A33B'],'four_agent_meme':['4','#E8A33B'],'ponsv2':['P','#2EBD85'],'pons.family':['P','#2EBD85'],'app.long.xyz':['L','#2EBD85'],'fun.noxa.fi':['N','#2EBD85'],'bankr.bot':['B','#3D7BFF'],'virtuals.io':['V','#3D7BFF'],'o1.exchange':['O','#3D7BFF'],'trench.today':['T','#6F8BFF'],'sender.family':['S','#6F8BFF'],'x.flap.sh':['X','#7A6CFF'],'nad.fun':['N','#836EF9'],'clanker.world':['C','#3D7BFF']};
/* 叙事板块：AVE /v2/ranks/topics 能当板块的六个（11/14 实测）；哪个币属于哪个板块只照 AVE 回的清单，不用名称猜 */
const META=[['meme','Meme','Meme'],['ai','AI','AI'],['rwa','RWA','RWA'],['gamefi','GameFi','GameFi'],['depin','Depin','Depin'],['l2','L2','L2']];
const TOK=Object.fromEntries(Object.keys(CH).map(k=>[k,[]])),BYID=new Map();
if(!CH[ST.chain])ST.chain='bsc';

/* ===== K 线：主程式 klineHist（见 a0 kGet），秒为单位 ===== */
const TF=[['1s',1],['5s',5],['15s',15],['30s',30],['1m',60],['5m',300],['15m',900],['1h',3600],['4h',14400],['1d',86400]];
function bars(t,tf){return kGet(t,tf).bars}

/* ===== 交易、持有人：主程式 tape／tokenDetail（见 a0） ===== */
const dn=n=>{n=String(n??'');return n==='¤'?L('我','Me'):/^0x[0-9a-fA-F]{40}$/.test(n)||n.length>CNT_30?sAddr(n):n};
const TAGS=[['kol','KOL','KOL'],['smart','聪明钱','Smart'],['rat','老鼠仓','Insider'],['snp','狙击','Sniper'],['dev','DEV','DEV'],['bnd','捆绑','Bundle'],['cab','隐藏集团','Cabal'],['phi','钓鱼','Phishing'],['whale','巨鲸','Whale'],['me','我的','Mine']];
function genTrades(t){return trGet(t).rows}
/* 持有人：主程式 tokenDetail 的 aveH（AVE 持有人标签：KOL／聪明钱／巨鲸／捆绑／阴谋集团／钓鱼＋前10 合计）。雷达目前只拿到「有标签的钱包」和占比合计，不是完整前 100 名单 */
const HTAG={kol:'kol',sm:'smart',smart:'smart',whale:'whale',bundle:'bnd',bu:'bnd',cabal:'cab',cab:'cab',phishing:'phi',phi:'phi',dev:'dev',sniper:'snp',sn:'snp',rat:'rat',insider:'rat'};
function genHolders(t){dGet(t);const H=t.hold;const out=[];const T=H&&H.tags&&typeof H.tags==='object'?H.tags:null;if(T)for(const [k,g] of Object.entries(T)){const tag=HTAG[k];if(!tag||!g||!Array.isArray(g.w))continue;for(const w of g.w){const a=String(w.a||w.addr||'');if(!a)continue;out.push({tag,who:w.nm||a,adr:a,hue:hash(a)%360,pct:num(w.p??w.pct),val:null,avg:null,pnl:null,view:''})}}
 out.sort((a,b)=>(b.pct??-1)-(a.pct??-1));return out}
