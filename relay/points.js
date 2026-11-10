// V120（11/11）由 GangPaper/points/points_engine.mjs 移植到转接站：拿掉档案读写，其余计分逻辑一字不改。
// 罗宾猫雷达 · 积分引擎（只在老板电脑的邀请机器人旁边跑；放在 GangPaper/points/，跟 ledger.mjs 同一个资料夹）
// 读：积分账本 ledger.jsonl（只追加、hash 链）＋ 机器人自己的登记 data/invites.json（I.joins／I.own／I.groups，TG uid 只在这台电脑用）
//     ＋ 规则 points_rules.json（分数、天数、防刷门槛全部在这个档，程式里没有任何预设分数／门槛：没填＝那一项不算，并列警告）
//     ＋ 链上交易次数（机器人已有的 RPC，节流；读不到＝待确认，不会用猜的）
// 写：points_cache.json（链上取样快取）、points_last.json（最近一次结果，给 TG「积分」指令和 CLI 用；含 TG uid，只在本机）
// 公开档 points.json 只放「邀请码指纹」（跟 invites.json 同一个 salt、同一个 rcv4: 算法），不放钱包地址、不放 TG。

const W_RE = /^0x[0-9a-f]{40}$/;
const DAY = 864e5, HOUR = 36e5;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const pos = (x) => (num(x) != null && x > 0 ? x : null);
const low = (x) => String(x ?? '').toLowerCase();
const day8 = (t) => new Date(t + 8 * HOUR).toISOString().slice(0, 10); /* 日期用台湾／北京时间显示 */

/* ---------------- 规则 ---------------- */
/** 读 points_rules.json。回传 { R, warn[], on:{invite,active,manual,burst,funder,created} }。缺的项目＝关掉＋警告（不补预设值） */
export function loadRules(j) { /* V120：转接站版，规则直接给物件 */
  const warn = []; const R = j && typeof j === 'object' ? j : {};
  const on = {};
  const iv = R.invite || {}; on.invite = pos(iv.points) != null && pos(iv.confirm_days) != null && pos(iv.recheck_hours) != null;
  if (!on.invite) warn.push('invite（有效邀请）的 points／confirm_days／recheck_hours 没填齐 → 邀请分先不算');
  /* RT-1105：活跃门槛（防小号做 1 笔 0.001 自转就入帐）。没填＝只要 1 笔、1 天（原本「有链上交易」的定义）并警告 */
  const gate = (o, name) => { const g = { tx: 1, days: 1 }; for (const [k, f] of [['min_tx', 'tx'], ['min_days', 'days']]) { if (o[k] == null) { warn.push(`${name}.${k} 没填 → 只要有 1 笔交易就算（容易被小号刷，建议填）`); continue; } if (!Number.isInteger(o[k]) || o[k] < 1) { warn.push(`${name}.${k} 要填 ≥1 的整数 → 先当 1`); continue; } g[f] = o[k]; } return g; };
  on.ivGate = gate(iv, 'invite');
  const ac = R.active || {}; on.active = pos(ac.points) != null && pos(ac.period_days) != null && Number.isFinite(Date.parse(R.start || ''));
  if (!on.active) warn.push('active（持续使用）的 points／period_days 或 start 没填齐 → 持续使用分先不算');
  on.acGate = gate(ac, 'active'); on.acMax = Number.isInteger(ac.max_periods) && ac.max_periods >= 1 ? ac.max_periods : null; if (on.active && on.acMax == null) warn.push('active.max_periods 没填 → 持续使用分没有上限（小号每周做几笔就能一直领）');
  on.manual = {}; for (const [k, v] of Object.entries(R.manual || {})) { if (!/^[a-z_]{2,20}$/.test(k)) { warn.push('manual 种类名不合法：' + k); continue; } if (num(v?.min) == null || num(v?.max) == null || v.min < 0 || v.max < v.min) { warn.push(`manual.${k} 的 min／max 没填好 → 这种手动分不算`); continue; } on.manual[k] = { min: v.min, max: v.max, zh: String(v.zh || k).slice(0, 20), en: String(v.en || k).slice(0, 30) }; }
  const af = R.antifraud || {};
  /* RT-1105：burst 可以填多个时间窗（1 小时／1 天／7 天…），并且按「码主这个人」合计（一个人的专属码＋钱包前 8 码一起算），防慢速刷、分散到多个码 */
  on.burstL = (Array.isArray(af.burst) ? af.burst : af.burst ? [af.burst] : []).filter((b) => pos(b?.window_hours) != null && pos(b?.max_binds) != null).map((b) => ({ W: b.window_hours * HOUR, N: b.max_binds }));
  on.burst = on.burstL.length > 0; if (!on.burst) warn.push('antifraud.burst（同一码主短时间大量绑定）没填 → 这项检查关闭');
  /* RT-1105：fresh＝没有区块浏览器也能做的「新钱包集中」：同一码主的被邀请钱包里，≥ max_wallets 个的链上交易笔数 ≤ max_nonce（刚建的小号）→ 待审。用现有的交易次数取样，不多打 RPC */
  on.fresh = pos(af.fresh?.max_wallets) != null && Number.isInteger(af.fresh?.max_nonce) && af.fresh.max_nonce >= 0; if (!on.fresh) warn.push('antifraud.fresh（新钱包集中）没填 → 这项检查关闭');
  on.funder = pos(af.funder?.max_wallets) != null; if (!on.funder) warn.push('antifraud.funder（同一资金来源）没填 → 这项检查关闭');
  on.created = pos(af.created?.window_hours) != null && pos(af.created?.max_wallets) != null; if (!on.created) warn.push('antifraud.created（钱包建立时间集中）没填 → 这项检查关闭');
  on.rpcMax = pos(R.rpc?.max_calls_per_run); on.rpcGap = num(R.rpc?.gap_ms) != null && R.rpc.gap_ms >= 0 ? R.rpc.gap_ms : null;
  if (on.rpcMax == null || on.rpcGap == null) warn.push('rpc.max_calls_per_run／gap_ms 没填 → 不查链上（链上相关的分都停在待确认）');
  on.expUrl = /^https:\/\/[^\s"'<>]+$/.test(String(R.chain?.explorer_url || '')) ? String(R.chain.explorer_url) : '';
  on.expKind = R.chain?.provider === 'nodereal' ? 'nodereal' : R.chain?.provider === 'etherscan' || R.chain?.provider == null || R.chain?.provider === '' ? 'etherscan' : '';
  if (on.expUrl && !on.expKind) { warn.push('chain.provider 只能填 etherscan 或 nodereal → 区块浏览器先不用'); on.expUrl = ''; }
  on.expMax = pos(R.chain?.max_explorer_per_run);
  if ((on.funder || on.created) && (!on.expUrl || on.expMax == null)) warn.push('chain.explorer_url／max_explorer_per_run 没填 → 查不到资金来源与钱包建立时间，funder／created 两项检查不会生效');
  on.top = pos(R.publish?.top); on.maxItems = pos(R.publish?.max_items); on.pushHours = pos(R.publish?.min_push_hours);
  if (on.top == null || on.maxItems == null || on.pushHours == null) warn.push('publish.top／max_items／min_push_hours 没填 → 不发布 points.json');
  on.enabled = R.enabled === true; if (!on.enabled) warn.push('enabled 不是 true → 积分不计算、不发布');
  return { R, warn, on };
}

/* ---------------- 链上快取 ---------------- */
/* V120：快取存在 Durable Object（呼叫端负责） */
/* 第一个 at ≥ t 的取样（并且在 t 之后 lim 毫秒内，不然不代表那个时间点） */
const sampleAt = (S, t, lim) => { for (const s of S || []) if (s[0] >= t) return lim == null || s[0] < t + lim ? s : null; return null; };

/* RT-1105：S[i]～S[j] 之间的活跃度：交易笔数（nonce 增加）、有交易的天数（相邻两笔取样之间有增加＝后一笔那天算 1 天；取样隔很久也只算 1 天，保守） */
function actOf(S, i, j) { let tx = 0; const days = new Set(); if (S[i] && S[j]) { tx = S[j][1] - S[i][1]; for (let k = i + 1; k <= j; k++) if (S[k][1] > S[k - 1][1]) days.add(day8(S[k][0])); } return { tx, days, ok: (G) => tx >= G.tx && days.size >= G.days }; }
const idxAt = (S, t, lim) => { for (let k = 0; k < (S || []).length; k++) if (S[k][0] >= t) return lim == null || S[k][0] < t + lim ? k : -1; return -1; };

/* ---------------- 主计算 ---------------- */
/**
 * computePoints({ rows, bot, rules, cache, now, owner })
 *  rows：ledger.read() 的全部行（含 void／note）；bot：{ joins, own, groups }；owner：{ codes:[…], wallet }（老板自己的码不进排行）
 * 回传 { at, persons:[…], review:[…], warn:[…], checks:{…}, need:{ nonce:[wallet…], explorer:[wallet…] } }
 */
export function computePoints({ rows, bot, rules, cache, now, owner = {} }) {
  const { R, on } = rules; const warn = [...rules.warn];
  const joins = {}; for (const [w, J] of Object.entries(bot?.joins || {})) if (J && typeof J === 'object') joins[low(w)] = J;
  const own = bot?.own || {}; const OWNC = new Set((owner.codes || []).map(low)); const OWNW = low(owner.wallet);
  const voided = new Set(rows.filter((e) => e.t === 'void').map((e) => e.d.ref));
  const live = rows.filter((e) => !voided.has(e.i));
  const approved = new Set(); for (const e of live) if (e.t === 'note') { const m = /^points:approve (\d+)$/.exec(String(e.d.text || '')); if (m) approved.add(+m[1]); }
  const uidOfW = (w) => { if (joins[w]?.uid != null && joins[w].uid !== '') return String(joins[w].uid); const o = Object.values(own).find((x) => low(x?.w) === w); return o && o.uid != null && o.uid !== '' ? String(o.uid) : ''; };
  const personOfW = (w) => (w === OWNW ? 'owner' : uidOfW(w) ? 'u' + uidOfW(w) : 'w' + w);
  /* 邀请码 → 码主（专属码看 I.own；8 码＝已生效钱包的前 8 码；老板的保留码＝owner） */
  const codeOwner = (c) => { c = low(c); if (OWNC.has(c)) return { person: 'owner', w: OWNW }; const o = own[c]; if (o && W_RE.test(low(o.w))) return { person: personOfW(low(o.w)), w: low(o.w) }; if (/^[0-9a-f]{8}$/.test(c)) { const w = Object.keys(joins).find((x) => x.slice(2, 10) === c && joins[x].ok); if (w) return { person: personOfW(w), w }; } return null; };
  const valid = (J) => !!(J && J.ok && !J.nc && !J.lost);
  const P = new Map(); const per = (k) => { if (!P.has(k)) P.set(k, { key: k, uid: k.startsWith('u') ? k.slice(1) : '', codes: new Set(), wallets: new Set(), items: [] }); return P.get(k); };

  /* ---- 绑定事件（有效邀请）---- */
  const binds = live.filter((e) => e.t === 'bind').sort((a, b) => a.at - b.at || a.i - b.i);
  const firstBind = new Map(); for (const e of binds) if (!firstBind.has(e.d.wallet)) firstBind.set(e.d.wallet, e); /* 每个钱包只能绑一次：重复送的只看最早那笔 */
  const B = [...firstBind.values()].map((e) => ({ e, w: e.d.wallet, c: e.d.inviter, J: joins[e.d.wallet], inv: codeOwner(e.d.inviter), flags: [] }));
  /* NOTG-1105（老板 11/5）：经由转接站直接绑定（via:'relay'）、还没有 TG 帐号的绑定 → 一律先进「待审」，不入帐、不算持续使用。
     原因：没有 TG 帐号就没办法「多钱包＝一个人」合并，一个人开多个钱包自己邀自己就能刷分。之后同一人用 TG 送同一份「绑定 RCB1.」补上 TG 帐号（机器人 v105:fillj）→ 下一轮自动照正常流程算；
     或老板 node points_admin.mjs approve <编号> 人工通过。这条是固定规则（不是数字），规则档不能关。 */
  for (const b of B) if (b.J && b.J.via === 'relay' && (b.J.uid == null || String(b.J.uid) === '')) b.flags.push('notg');
  /* ---- 防刷：异常自动标记（规则档有填才查）---- */
  const checks = { burst: !!on.burst, funder: !!(on.funder && on.expUrl && on.expMax != null), created: !!(on.created && on.expUrl && on.expMax != null) };
  const byCode = new Map(); for (const b of B) { if (!byCode.has(b.c)) byCode.set(b.c, []); byCode.get(b.c).push(b); }
  const winFlag = (list, tOf, W, N, tag) => { const L = list.filter((b) => tOf(b) != null).sort((a, b) => tOf(a) - tOf(b)); let i = 0; for (let j = 0; j < L.length; j++) { while (tOf(L[j]) - tOf(L[i]) > W) i++; if (j - i + 1 >= N) for (let k = i; k <= j; k++) if (!L[k].flags.includes(tag)) L[k].flags.push(tag); } };
  const byInv = new Map(); for (const b of B) { const k = b.inv ? 'p:' + b.inv.person : 'c:' + b.c; if (k === 'p:owner') continue; if (!byInv.has(k)) byInv.set(k, []); byInv.get(k).push(b); } /* 按码主这个人合计（老板自己的码不查） */
  if (checks.burst) for (const L of byInv.values()) for (const x of on.burstL) winFlag(L, (b) => b.e.at, x.W, x.N, 'burst');
  checks.fresh = !!on.fresh; if (checks.fresh) for (const L of byInv.values()) { const F = L.filter((b) => { const s0 = (cache.w[b.w]?.s || [])[0]; return s0 && s0[1] <= R.antifraud.fresh.max_nonce; }); if (F.length >= R.antifraud.fresh.max_wallets) for (const b of F) if (!b.flags.includes('fresh')) b.flags.push('fresh'); }
  if (checks.created) for (const L of byCode.values()) winFlag(L, (b) => cache.w[b.w]?.f?.at ?? null, R.antifraud.created.window_hours * HOUR, R.antifraud.created.max_wallets, 'created');
  if (checks.funder) { const ign = new Set((R.antifraud.funder.ignore || []).map(low)); const G = new Map(); for (const b of B) { const f = low(cache.w[b.w]?.f?.from); if (!W_RE.test(f) || ign.has(f)) continue; if (b.inv && f === b.inv.w && !b.flags.includes('funder_inviter')) b.flags.push('funder_inviter'); if (!G.has(f)) G.set(f, []); G.get(f).push(b); } for (const L of G.values()) if (L.length >= R.antifraud.funder.max_wallets) for (const b of L) if (!b.flags.includes('funder')) b.flags.push('funder'); }

  const review = []; const seenInvitee = new Set(); const usable = new Map(); /* 钱包 → { at：开始算持续使用的时间 } */
  const needNonce = new Map(); /* 钱包 → 需要新取样的时间点（最晚的那个边界） */
  const want = (w, t) => { if (t <= now && (!needNonce.has(w) || needNonce.get(w) < t)) needNonce.set(w, t); };
  for (const b of B) {
    const { e, w, J, inv } = b;
    if (!J || !inv) continue; /* 账本有、机器人登记没有（或码找不到码主）→ 不算 */
    if (low(J.code) !== b.c) continue; /* RT-1105：账本的邀请码要跟机器人登记的一样（void 后残留的另一笔、或账本被改，都不算） */
    const invitee = personOfW(w);
    if (inv.person === invitee || inv.w === w) continue; /* 自己邀自己（同一个 TG 帐号／同一个钱包）不算 */
    if (!valid(J)) continue; /* 还没生效、Agent ID 不见了、同一颗 Agent ID 已算过 → 不算 */
    const flagged = b.flags.length && !approved.has(e.i);
    if (flagged) review.push({ i: e.i, code: b.c, wallet: w, at: e.at, why: [...b.flags] });
    if (!flagged) usable.set(w, { at: e.at, person: invitee });
    if (seenInvitee.has(invitee)) continue; /* 一个 TG 帐号只算一次（多钱包＝一个人）：只算最早那笔 */
    seenInvitee.add(invitee);
    if (inv.person === 'owner') continue; /* 老板自己的码：不计分、不进排行 */
    if (!on.invite) continue;
    const pts = R.invite.points; const it = { k: 'inv', p: pts, at: e.at, i: e.i };
    if (flagged) { per(inv.person).items.push({ ...it, st: 'rv', why: b.flags.join(',') }); continue; }
    const okAt = num(J.okAt) ?? e.at; const ct = okAt + R.invite.confirm_days * DAY;
    const S = cache.w[w]?.s || []; const s0 = S[0];
    if (!s0) { want(w, okAt); per(inv.person).items.push({ ...it, st: 'pd', why: 'rpc' }); continue; }
    if (now < ct) { if (on.ivGate.days > 1) want(w, S[S.length - 1][0] + DAY); per(inv.person).items.push({ ...it, st: 'pd', why: 'wait', due: ct }); continue; } /* 要算「几天有交易」→ 观察期内每天取样一次 */
    const G = on.ivGate; let hit = null; for (let j = 1; j < S.length; j++) if (S[j][0] >= ct && actOf(S, 0, j).ok(G)) { hit = S[j]; break; }
    if (hit) { per(inv.person).items.push({ ...it, st: 'ok', at: hit[0] }); continue; }
    const last = S[S.length - 1]; want(w, last[0] < ct ? ct : last[0] + R.invite.recheck_hours * HOUR); /* 满期后还没看到交易：每 recheck_hours 再查一次 */
    per(inv.person).items.push({ ...it, st: 'pd', why: 'act' });
  }
  /* ---- 持续使用：每满一期（period_days），这个人任何一个有效钱包在那期有链上交易 → +points ---- */
  if (on.active) {
    const P0 = Date.parse(R.start); const PD = R.active.period_days * DAY; const byPer = new Map();
    for (const [w, u] of usable) { if (u.person === 'owner') continue; if (!byPer.has(u.person)) byPer.set(u.person, []); byPer.get(u.person).push({ w, from: Math.max(u.at, P0) }); }
    for (const [pk, ws] of byPer) {
      const anchor = Math.min(...ws.map((x) => x.from));
      for (let k = 0; anchor + (k + 1) * PD <= now; k++) {
        const s = anchor + k * PD, e2 = s + PD; let act = false, wait = false; let tx = 0; const days = new Set();
        for (const x of ws) { if (x.from > s) continue; const S = cache.w[x.w]?.s; const a = idxAt(S, s, PD), b = idxAt(S, e2, PD); if (a >= 0 && b >= 0) { const A = actOf(S, a, b); tx += A.tx; for (const d of A.days) days.add(d); } if (a >= 0 && b < 0 && now < e2 + PD) wait = true; }
        act = tx >= on.acGate.tx && days.size >= on.acGate.days; /* 这个人所有钱包合计：笔数、有交易的天数 */
        if (act && on.acMax != null && (P.get(pk)?.items || []).filter((y) => y.k === 'act' && y.st === 'ok').length >= on.acMax) break; /* RT-1105：每人最多算 max_periods 期 */
        if (act) per(pk).items.push({ k: 'act', p: R.active.points, st: 'ok', at: e2, per: k + 1 });
        else if (wait) per(pk).items.push({ k: 'act', p: R.active.points, st: 'pd', at: e2, per: k + 1, why: 'rpc' });
      }
      /* 取样计划：每个边界之后要有一笔取样 */
      const capped = on.acMax != null && (P.get(pk)?.items || []).filter((y) => y.k === 'act' && y.st === 'ok').length >= on.acMax;
      if (!capped) for (const x of ws) { const nB = Math.floor((now - anchor) / PD); for (let k = 0; k <= nB; k++) { const t = anchor + k * PD; if (t < x.from) continue; if (!sampleAt(cache.w[x.w]?.s, t, PD) && now < t + PD) want(x.w, t); }
        if (on.acGate.days > 1) { const S = cache.w[x.w]?.s || []; const l = S[S.length - 1]; if (l) want(x.w, l[0] + DAY); } } /* 要算天数 → 每天取样一次（到上限就不再取样） */
    }
  }
  /* ---- 手动加分（回报真 bug、外挂被收录、发文分享…）---- */
  for (const e of live) if (e.t === 'manual') {
    const w = e.d.wallet; const pk = personOfW(w); const r = on.manual[e.d.kind]; const q = num(e.d.qty);
    if (!r) { warn.push(`账本 #${e.i} 的手动分种类「${e.d.kind}」不在规则档 → 不算`); continue; }
    if (q == null || q < r.min || q > r.max) { warn.push(`账本 #${e.i} 的分数 ${e.d.qty} 不在 ${e.d.kind} 规则范围（${r.min}～${r.max}）→ 不算`); continue; }
    if (pk === 'owner') continue;
    per(pk).items.push({ k: 'm:' + e.d.kind, p: q, st: 'ok', at: e.at, i: e.i, note: e.d.note || '' });
  }
  /* ---- 每个人的邀请码（专属码＋已生效钱包的前 8 码）---- */
  const C_OK = /^[a-z0-9_]{3,10}$/; /* RT-1105：码一律检查格式（防注入、超长） */
  for (const [c, o] of Object.entries(own)) { const w = low(o?.w); if (!W_RE.test(w) || !C_OK.test(low(c))) continue; const pk = personOfW(w); if (P.has(pk)) { P.get(pk).codes.add(low(c)); P.get(pk).wallets.add(w); } }
  for (const [w, J] of Object.entries(joins)) { if (!J.ok) continue; const pk = personOfW(w); if (P.has(pk)) { P.get(pk).wallets.add(w); if (codeOwner(w.slice(2, 10))?.w === w) P.get(pk).codes.add(w.slice(2, 10)); } } /* RT-1105：靓号钱包撞到别人的 8 码 → 那个码只归真正的码主（跟机器人 codeOwner 同一个判断） */
  P.delete('owner');
  const persons = [...P.values()].map((p) => { const items = p.items.sort((a, b) => b.at - a.at); const sum = (st) => items.filter((x) => x.st === st).reduce((t, x) => t + x.p, 0); const own1 = [...p.codes].find((c) => own[c]) || [...p.codes].sort()[0] || ''; return { key: p.key, uid: p.uid, codes: [...p.codes].sort(), primary: own1, ok: sum('ok'), pd: sum('pd'), rv: sum('rv'), items }; });
  const ranked = persons.filter((p) => p.ok > 0).sort((a, b) => b.ok - a.ok || a.key.localeCompare(b.key)); let prev = null, rk = 0; ranked.forEach((p, i) => { if (p.ok !== prev) { rk = i + 1; prev = p.ok; } p.rk = rk; });
  /* 需要查资金来源／建立时间的钱包（只有开了那两项检查才查） */
  const needExp = (checks.funder || checks.created) ? B.filter((b) => b.J && b.J.ok && cache.w[b.w]?.f === undefined).map((b) => b.w) : [];
  /* 有效但还没有第一笔取样的钱包，也要取样（邀请判断要用） */
  for (const b of B) if (valid(b.J) && !(cache.w[b.w]?.s || []).length) want(b.w, Math.min(now, num(b.J.okAt) ?? b.e.at));
  return { at: now, persons, review: review.sort((a, b) => a.i - b.i), warn: [...new Set(warn)], checks, need: { nonce: [...needNonce.entries()].sort((a, b) => a[1] - b[1]).map(([w]) => w), explorer: needExp } };
}

/* ---------------- 链上取样（节流） ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function sample({ need, cache, rules, rpc, explorer, now = Date.now, log = () => {} }) {
  const { on } = rules; let n = 0, fail = 0, ne = 0;
  if (on.rpcMax != null && on.rpcGap != null && rpc) for (const w of need.nonce) {
    if (n >= on.rpcMax) break; n++;
    try { const h = await rpc('eth_getTransactionCount', [w, 'latest']); const v = parseInt(h, 16); if (!Number.isSafeInteger(v) || v < 0) throw new Error('bad'); const c = (cache.w[w] = cache.w[w] || {}); c.s = c.s || []; c.s.push([now(), v]); } catch { fail++; }
    if (on.rpcGap) await sleep(on.rpcGap);
  }
  if (explorer && on.expMax != null) for (const w of need.explorer) {
    if (ne >= on.expMax) break; ne++;
    try { const r = await explorer(w); if (r === undefined) continue; (cache.w[w] = cache.w[w] || {}).f = r && W_RE.test(low(r.from)) ? { from: low(r.from), at: num(r.at) } : r && num(r.at) != null ? { from: '', at: r.at } : null; } catch { /* 读不到＝下次再查 */ }
    if (on.rpcGap) await sleep(on.rpcGap);
  }
  if (fail) log(`[积分] 链上交易次数有 ${fail} 个钱包这轮读不到（相关的分维持待确认）`);
  return { rpc: n, fail, explorer: ne };
}

/** 区块浏览器：第一笔交易 → { from（资金来源；第一笔不是转入就空）, at（钱包建立时间）}；没有交易＝null；读不到＝丢错（下次再查）
 *  kind='etherscan'：BscScan／Etherscan v2 相容（txlist，金钥放 apikey 参数）
 *  kind='nodereal'：NodeReal BSC 增强 API（JSON-RPC nr_getTransactionByAddress，金钥接在网址最后） */
export function makeExplorer(url, key, fetchFn = globalThis.fetch, kind = 'etherscan') {
  if (!url || !key) return null;
  if (kind === 'nodereal') { const u = url.replace(/\/+$/, '') + '/' + encodeURIComponent(key); let id = 0;
    const call = async (w, addressType) => { const r = await fetchFn(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'nr_getTransactionByAddress', params: [{ category: ['external'], addressType, address: w, order: 'asc', excludeZeroValue: false, maxCount: '0x1' }] }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error('http ' + r.status); const j = await r.json(); if (j?.error || !j?.result || !Array.isArray(j.result.transfers)) throw new Error('nodereal'); const t = j.result.transfers[0]; if (!t) return null;
      const ts = typeof t.blockTimeStamp === 'string' && /^0x/i.test(t.blockTimeStamp) ? parseInt(t.blockTimeStamp, 16) : Number(t.blockTimeStamp); if (!Number.isFinite(ts) || ts <= 0) throw new Error('nodereal ts'); return { from: low(t.from), to: low(t.to), at: ts * 1000 }; };
    return async (w) => { const a = await call(w, 'to'), b = await call(w, 'from'); if (!a && !b) return null; const f = !b || (a && a.at <= b.at) ? a : b; return { from: f === a ? f.from : '', at: Math.min(a?.at ?? Infinity, b?.at ?? Infinity) }; }; /* 第一笔转入 vs 第一笔转出：比较早的那笔＝建立时间；比较早的是转入才有资金来源 */ }
  return async (w) => {
    const u = url + (url.includes('?') ? '&' : '?') + 'module=account&action=txlist&address=' + w + '&page=1&offset=1&sort=asc&apikey=' + encodeURIComponent(key);
    const r = await fetchFn(u, { signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('http ' + r.status); const j = await r.json();
    if (j && Array.isArray(j.result)) { const t = j.result[0]; if (!t) return null; return { from: low(t.to) === w ? low(t.from) : '', at: Number(t.timeStamp) * 1000 }; }
    if (j && String(j.message || '').startsWith('No transactions')) return null; throw new Error('explorer');
  };
}

/* ---------------- 公开档（只放邀请码指纹） ---------------- */

/** publicCodes：已公开在社群名单上的码（排行才显示码本身，其余显示指纹前 6 码） */
export function publicPayload(res, rules, { salt, it, publicCodes = new Set(), fp }) { /* V120：fp＝呼叫端给的指纹查表（跟 invites.json 同一份） */
  const { on } = rules;
  const c = {}, r = [];
  for (const p of res.persons) { if (!p.codes.length || !(p.ok || p.pd || p.rv)) continue; const idx = r.length;
    r.push({ ok: p.ok, pd: p.pd, rv: p.rv, rk: p.rk || 0 }); /* 隐私（11/5 老板）：公开档只放已入帐／待确认／审核中／名次，不放明细；明细只有本人在 TG 传「积分」看（机器人从本机账本算） */
    for (const code of p.codes) c[fp(code)] = idx; }
  const top = res.persons.filter((p) => p.rk && p.codes.length).sort((a, b) => a.rk - b.rk).slice(0, on.top).map((p) => { const pub = p.codes.find((x) => publicCodes.has(x)); return { n: pub || fp(p.primary).slice(0, 6), pub: pub ? 1 : 0, ok: p.ok, rk: p.rk }; });
  const man = {}; for (const [k, v] of Object.entries(on.manual)) man[k] = { min: v.min, max: v.max, zh: v.zh, en: v.en };
  return { v: 1, salt, it, c, r, top, rules: { invite: on.invite ? { p: rules.R.invite.points, d: rules.R.invite.confirm_days } : null, active: on.active ? { p: rules.R.active.points, d: rules.R.active.period_days } : null, manual: man, top: on.top } };
}

/* ---------------- 本机结果（给 TG 指令／CLI） ---------------- */

const KZ = { inv: ['有效邀请', 'Valid invite'], act: ['持续使用', 'Active use'] };
const WHY = { wait: ['等满观察期', 'waiting period'], act: ['等链上活动', 'waiting for on-chain activity'], rpc: ['链上资料读取中', 'reading chain data'] };
export function kindName(k, rules, en) { if (KZ[k]) return KZ[k][en ? 1 : 0]; const m = /^m:(.+)$/.exec(k); const r = m && rules?.on?.manual?.[m[1]]; return r ? (en ? r.en : r.zh) : m ? m[1] : k; }
/** TG「积分」「points」→ 用 TG uid 找到这个人，回他的积分与明细 */
export function tgReply(last, uid, rules, en) {
  if (!last || !Array.isArray(last.persons)) return en ? 'Points data is not available right now — please try again later.' : '积分资料暂时读不到，请稍后再试。';
  const p = last.persons.find((x) => x.uid !== '' && String(x.uid) === String(uid));
  if (!p) return en ? 'No points yet. Bind your wallet in the radar (or get your own invite code), invite friends and keep using it — points show up here.' : '你还没有积分。在雷达完成绑定（或申请自己的邀请码）、邀请朋友、持续使用，就会累积积分。';
  const mx = rules?.on?.maxItems || p.items.length; const st = (s) => (s === 'ok' ? '✅' : s === 'pd' ? '⏳' : '🔎');
  const lines = p.items.slice(0, mx).map((x) => `${st(x.st)} +${x.p} ${kindName(x.k, rules, en)}${x.st === 'pd' && WHY[x.why] ? (en ? ` (${WHY[x.why][1]})` : `（${WHY[x.why][0]}）`) : x.st === 'rv' ? (/(^|,)notg(,|$)/.test(String(x.why || '')) ? (en ? ' (on hold: your friend bound in the radar without Telegram — counts after they send the same RCB1. bind message to the bot in Telegram)' : '（暂缓：对方在雷达里直接绑定、还没用 TG 认领；对方在 TG 机器人送同一份「绑定 RCB1.」后就会计分）') : (en ? ' (under review)' : '（审核中）')) : ''} · ${day8(x.at).slice(5)}`);
  const t = new Date(last.at + 8 * HOUR).toISOString().slice(5, 16).replace('T', ' ');
  return en
    ? `🏅 Your points${p.primary ? ` (code ${p.primary})` : ''}\nCredited ${p.ok} · Pending ${p.pd}${p.rv ? ` · Under review ${p.rv}` : ''}\nRank: ${p.rk ? '#' + p.rk : '—'}\n\n${lines.length ? 'Details:\n' + lines.join('\n') : 'No entries yet.'}\n\n(data as of ${t} UTC+8)`
    : `🏅 你的积分${p.primary ? `（邀请码 ${p.primary}）` : ''}\n已入帐 ${p.ok} · 待确认 ${p.pd}${p.rv ? ` · 审核中 ${p.rv}` : ''}\n名次：${p.rk ? '第 ' + p.rk + ' 名' : '还没上榜'}\n\n${lines.length ? '明细：\n' + lines.join('\n') : '还没有明细。'}\n\n（资料时间 ${t}）`;
}

