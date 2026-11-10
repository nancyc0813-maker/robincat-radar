/* NEW-100 · 罗宾猫雷达的官方来源 —— 只改这里（引擎 watch.mjs、雷达 radar/main.cjs、手机中继 relay/worker.js 都读这个档）
   OWNER／NAME：程式的 GitHub 仓库（版本检查、一键更新）
   DATA：官方签名过的「显示用」资料（公告、手机中继网址、空投、KOL 名单）所在的仓库
   PUBKEY：官方签名公钥（Ed25519，SPKI DER，base64）。换成 PUBKEY_PLACEHOLDER 就等于「没有官方签名」：一键更新、远端显示资料都会拒绝。
   ONLINE_PUB：线上金钥 online.pem 的公钥（AVE 看盘资料、作者手机通行证用；跟 PUBKEY 不同把）。由 `node sign_radar.mjs onlinekey <树>` 自动写进来；空字串＝雷达不收看盘资料（AVE 看板显示「读不到」，不报错）
   X_ACC／TG_ACC／TG_BOT：官方帐号（雷达「打开网址」只有这些帐号的页面和官方仓库不跳警告）
   签名：/tmp/rel1017/sign_radar.mjs（读 .sign_radar/private.pem，签之前会核对私钥跟这里的公钥是同一对） */
'use strict';
const OWNER = 'nancyc0813-maker';
const NAME = 'robincat-radar';
const DATA = 'robincat-radar-data'; /* 官方签名过的显示资料仓库 */
/* 作者的邀请码／连结（只在用户自己按的时候打开） */
const REF_AVE_URL = 'https://share.ave.ai/?lang=zh&code=nancy.c0813';
const REF_BINANCE_CODE = 'HI444QQY';
const REF_BINANCE_URL = 'https://web3.binance.com/referral?ref=' + REF_BINANCE_CODE;
const PUBKEY = 'MCowBQYDK2VwAyEAens/SqtK4KkmLBB3gSAxamce9VYy9v+urlWdCqX6bcc='; /* 11/3 Nancy 在自己电脑产生（私钥只在她电脑 .sign_radar/private.pem） */
const ONLINE_PUB = 'MCowBQYDK2VwAyEA6yiFLuIICmiINfXUBFCf6/bUDGZK+Hx4ecwv9AiqtEM='; /* OPS-ONL：sign_radar.mjs onlinekey 会自动填（同时写进 relay/wrangler.toml 的 ONLINE_PUBKEY） */
const INV_PUB = 'MCowBQYDK2VwAyEA4O54gks7IbGD46tBgxOfijr9iyyij6a9NhE1GzeVawI='; /* V120-INV：邀请／积分／黑名单专用金钥（私钥只在转接站，主私钥不离开 Nancy 电脑）；只认 type＝invites／points／blacklist */
const X_ACC = 'nancy_c813', TG_ACC = 'nancy_c0813', TG_BOT = 'RobinCatRadar_bot'; /* OPS-RT14：官方帐号 */
module.exports = {
  OWNER, NAME, DATA, PUBKEY, ONLINE_PUB, INV_PUB, X_ACC, TG_ACC, TG_BOT, REF_AVE_URL, REF_BINANCE_CODE, REF_BINANCE_URL,
  REPO: OWNER + '/' + NAME,
  URL: 'https://github.com/' + OWNER + '/' + NAME,
  RAW: 'https://raw.githubusercontent.com/' + OWNER + '/' + NAME + '/main/',
  DATA_API: 'https://api.github.com/repos/' + OWNER + '/' + DATA + '/contents/',
  DATA_RAW: 'https://raw.githubusercontent.com/' + OWNER + '/' + DATA + '/main/',
  PUB_OK: PUBKEY !== 'PUBKEY_PLACEHOLDER' && /^[A-Za-z0-9+/=]{40,}$/.test(PUBKEY),
};
