// 罗宾猫雷达 · ✋ 选打法（MPK-1103）
// 雷达认不出怎么铸造的项目，不再默默跳过：列出选项让你自己选，存在这个合约上（S.paid[合约].pick，src:'user'）。
//   (a) 最近别人成功的铸造交易 → 照这笔打
//   (b) 合约程式里找到的函式（扫 bytecode 的 4 byte 函式码，试探哪些可能收 BNB）→ 选一个、自己填金额和参数
//   (c) 自己贴 calldata + 金额
// 存好之后：强制打、自动打（还是要过你自己的策略条件）都会用这个打法。
// 安全：程式里没有任何买卖数字（金额一律你填）；送出前一定先预演（eth_call）；预演没过 → 显示原因和大概会白烧多少手续费，
// 你按「我知道风险，仍然送出」才送（自动打照你的开关 auto.sendOnPreviewFail，预设关＝只记录不送）。
// 紧急全停／「手动买卖」关着／两个雷达同时开 → 不送，讯息写是哪个开关。转帐／授权类的函式码：标 ⚠️，要你按「我看懂了」＋「我知道风险，仍然执行」才送（ZR-INT-MPK）。
const NAMES = { '1249c58b': 'mint()', 'a0712d68': 'mint(uint256)', '6a627842': 'mint(address)', '40c10f19': 'mint(address,uint256)', '94bf804d': 'mint(uint256,address)', '40d097c3': 'safeMint(address)', 'a1448194': 'safeMint(address,uint256)', '26092b83': 'publicMint()', '2db11544': 'publicMint(uint256)', 'b3ab66b0': 'publicSaleMint(uint256)', 'efd0cbf9': 'mintPublic(uint256)', '4e71d92d': 'claim()', '379607f5': 'claim(uint256)', '1e83409a': 'claim(address)', 'aad3ec96': 'claim(address,uint256)', 'a6f2ae3a': 'buy()', 'd96a094a': 'buy(uint256)', 'f088d547': 'buy(address)', 'ec8ac4d8': 'buyTokens(address)', '64edfbf0': 'purchase()', 'efef39a1': 'purchase(uint256)', 'd0e30db0': 'deposit()', 'b6b55f25': 'deposit(uint256)', 'd7bb99ba': 'contribute()', 'd11711a2': 'participate()', 'b688a363': 'join()', '1aa3a008': 'register()', 'e97dcb62': 'enter()', '8467be0d': 'batchMint(uint256)', '20e409b4': 'mintBatch(uint256)', '8b4379bc': 'mintWithReferral(uint256,address)', 'ba41b0c6': 'mint(uint256,bytes32[])', 'b77a147b': 'mint(bytes32[])', 'd2cab056': 'whitelistMint(uint256,bytes32[])', '5b70ea9f': 'freeMint()', '7c928fe9': 'freeMint(uint256)', 'e59c6339': 'mintAgent(uint256)', '755edd17': 'mintTo(address)', '449a52f8': 'mintTo(address,uint256)', 'd1a93d18': 'buyShares(uint256)' };
/* 只读或项目方专用的函式：不列出来（按了也没用，或根本是项目方的权限） */
const HIDE = new Set(['a035b1fe', '8d859f3e', '6817c76c', '13faede6', '18160ddd', 'd5abeb01', '32cb6b0c', '8da5cb5b', '06fdde03', '95d89b41', '313ce567', '70a08231', '5c975abb', '68428a1b', '3ccfd60b', '715018a6', 'f2fde38b', '91b7f5ed', '8456cb59', '3f4ba83a', '55f804b3', 'c87b56dd', '6352211e', '01ffc9a7', 'ac9650d8', 'dd62ed3e', '081812fc', 'e985e9c5', '0e89341c', '00fdd58e', '4e1273f4', '3644e515', '7ecebe00']);
const HEX = /^0x([0-9a-f]{8}([0-9a-f]{64})*)?$/;
const SCAN_BLOCKS = 5000, SCAN_STEPS = 6, MAX_TX = 40, MAX_ROWS = 15, MAX_SEL = 80; /* 运作：查多少区块／几笔（节点额度），不影响买不买 */

export function startMintPick(D) {
  const { DIR, S, save, WALLETS, rpc, rpcBatch, logsRpc, log, tg } = D;
  const F = DIR + '/data/mintpick.json'; const busy = new Set();
  const lc = (x) => String(x || '').toLowerCase();
  const readAll = async () => { try { const { readFileSync } = await import('node:fs'); return JSON.parse(readFileSync(F, 'utf8')) || {}; } catch { return {}; } };
  let putQ = Promise.resolve(); const put = (c, part) => (putQ = putQ.then(() => put0(c, part)).catch(() => {})); /* BUG10：写档排队，不会两笔同时写互相盖掉 */
  const put0 = async (c, part) => { const { writeFileSync, renameSync } = await import('node:fs'); const all = await readAll(); all[c] = { ...(all[c] || {}), ...part, at: Date.now() }; const ks = Object.keys(all).sort((a, b) => (all[a].at || 0) - (all[b].at || 0)); for (const k of ks.slice(0, Math.max(0, ks.length - 12))) delete all[k]; const tmp = F + '.w'; writeFileSync(tmp, JSON.stringify(all)); renameSync(tmp, F); };
  const wallet = (a) => WALLETS.find((x) => x.addr === lc(a)) || null;
  const liveW = () => WALLETS.filter((x) => !x.off);
  const bnb = (wei) => Number(BigInt(wei || 0)) / 1e18;
  const errTxt = (e) => String(e?.message ?? e ?? '');
  const reasonOf = (e) => { const m = errTxt(e); const r = m.replace(/^.*?execution reverted:?\s*/i, '').trim(); return /execution reverted/i.test(m) ? r : null; }; /* null＝不是合约拒绝（节点问题） */
  const words = (d) => (String(d).slice(10).match(/.{64}/g) || []);
  const hint = (x, from) => { const v = BigInt('0x' + x); if (/^0{24}[0-9a-f]{40}$/.test(x) && x.slice(24, 32) !== '00000000') return '0x' + x.slice(24) === from ? '地址（就是送出的人）' : '地址'; const now = Math.floor(Date.now() / 1000); if (v > BigInt(now - 30 * 86400) && v < BigInt(now + 30 * 86400)) return '像时间（期限会换新）'; if (v < 10n ** 15n) return '数字 ' + v.toString(); return '大数字'; };
  const gasPrice = async () => { try { return BigInt(await rpc('eth_gasPrice', [])); } catch { return null; } };
  function check(o) { const data = lc(o.data).trim(), value = String(o.value ?? '').trim(); if (!HEX.test(data)) return { err: 'calldata 格式不对（要 0x 开头、8 码函式码＋每个参数 64 码）' }; if (!/^\d+$/.test(value)) return { err: '你还没填金额（BNB）' }; if (data === '0x' && BigInt(value) === 0n) return { err: '没有 calldata 时金额不能是 0' }; return { data, value, appr: D.badSel(data) ? 1 : 0 }; } /* ZR-INT-MPK：转帐／授权类的函式不拒绝，标出来，送出时要你看懂警告再确认 */

  async function list(c) { /* (a)＋(b) */
    const out = { txs: [], fns: [], err: '', px: await D.bnbUsd().catch(() => 0) || 0 };
    try { const head = parseInt(await rpc('eth_blockNumber', []), 16); const hs = new Set();
      for (let to = head, k = 0; k < SCAN_STEPS && hs.size < MAX_TX; to -= SCAN_BLOCKS, k++) { const L = await logsRpc([{ address: c, fromBlock: '0x' + Math.max(1, to - SCAN_BLOCKS + 1).toString(16), toBlock: '0x' + to.toString(16) }]).catch(() => []); for (const l of (L || []).slice().reverse()) { if (l.transactionHash) hs.add(l.transactionHash); if (hs.size >= MAX_TX) break; } }
      if (!hs.size && D.scanBack) { for (let i = 0; i < 3 && !hs.size; i++) { const { logs, B } = await D.scanBack(c, head); for (const l of logs.slice().reverse()) { if (l.transactionHash) hs.add(l.transactionHash); if (hs.size >= MAX_TX) break; } out.back = { cur: B.cur, pages: B.pages, done: B.done ? 1 : 0 }; if (!logs.length) break; } } /* ZR-FIX15：最近都没有 → 接着往前翻（记住翻到哪，下次再按接着翻，直到合约建立的那一块） */
      const H = [...hs]; const txs = await rpcBatch(H.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] }))); const rcs = await rpcBatch(H.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
      const rows = []; H.forEach((h, i) => { const t = txs[i], r = rcs[i]; if (!t || lc(t.to) !== c || !r || r.status !== '0x1') return; const input = lc(t.input || '0x'); if (input !== '0x' && input.length < 10) return; /* ZR-INT-MPK：转帐／授权类的也列出来（标 ⚠️） */ const from = lc(t.from);
        let payTok = ''; for (const l of r.logs || []) if (l.topics?.[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && l.topics.length === 3 && '0x' + String(l.topics[1]).slice(26).toLowerCase() === from) { payTok = lc(l.address); break; }
        const sel = input.slice(2, 10); rows.push({ h, bn: parseInt(t.blockNumber, 16), from, value: BigInt(t.value || '0x0').toString(), data: input, sel: sel ? '0x' + sel : '', fn: sel ? NAMES[sel] || '' : '（直接转 BNB）', args: words(input).slice(0, 8).map((x) => ({ x, t: hint(x, from) })), more: Math.max(0, words(input).length - 8), gas: String(parseInt(r.gasUsed || '0x0', 16) || ''), payTok, hasMe: input.includes(from.slice(2)), warn: D.badSel(input) ? '⚠️ 转帐／授权类的函式：送出后对方可能可以转走你的代币' : '' }); });
      rows.sort((a, b) => b.bn - a.bn); const top = rows.slice(0, MAX_ROWS);
      const bns = [...new Set(top.map((x) => x.bn))]; const bl = await rpcBatch(bns.map((n) => ({ method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), false] }))); const tsOf = new Map(bns.map((n, i) => [n, bl[i]?.timestamp ? parseInt(bl[i].timestamp, 16) * 1000 : 0]));
      out.txs = top.map((x) => ({ ...x, t: tsOf.get(x.bn) || 0 }));
    } catch (e) { out.err = '查别人的交易失败：' + errTxt(e).slice(0, 80); }
    try { const W = liveW()[0] || WALLETS[0]; const from = W?.addr || '0x000000000000000000000000000000000000dead'; const code = lc(await D.fullCode(c, await D.codeOf(c)).catch(() => D.codeOf(c))).replace(/^0x/, '');
      const sels = []; for (let i = 0; i + 10 <= code.length && sels.length < MAX_SEL * 2; i += 2) if (code.slice(i, i + 2) === '63') { const s = code.slice(i + 2, i + 10); if (!sels.includes(s)) sels.push(s); }
      const cand = sels.filter((s) => !HIDE.has(s) && s !== '00000000' && s !== 'ffffffff').sort((a, b) => (!!NAMES[b] - !!NAMES[a])).slice(0, MAX_SEL);
      const probe = async (s, v) => { try { const r = await rpc('eth_call', [{ from, to: c, data: '0x' + s + '0'.repeat(256), value: v }, 'latest']); return { ok: 1, ret: r }; } catch (e) { return { ok: 0, why: reasonOf(e) }; } };
      const res = []; for (let i = 0; i < cand.length; i += 10) res.push(...await Promise.all(cand.slice(i, i + 10).map(async (s) => { const [p0, p1] = await Promise.all([probe(s, '0x0'), probe(s, '0x1')]);
        let pay = 'unk'; if (p1.ok || p1.why) pay = 'pay'; else if (p0.ok && String(p0.ret || '0x').length > 2 && !NAMES[s]) pay = 'view'; else if (p0.ok || p0.why) pay = 'nopay';
        return { sel: '0x' + s, fn: NAMES[s] || '', pay, why: (p1.why || p0.why || '').slice(0, 80), warn: D.badSel('0x' + s) ? '⚠️ 转帐／授权类的函式' : '' }; })));
      const rank = { pay: 0, unk: 1, nopay: 2 }; out.fns = res.filter((x) => x.pay !== 'view').sort((a, b) => (!!b.fn - !!a.fn) || rank[a.pay] - rank[b.pay]);
    } catch (e) { out.fnErr = '扫合约函式失败：' + errTxt(e).slice(0, 80); }
    return out;
  }

  async function preview(c, data, value, ws, gasHint) { /* 跟真的送出一样：期限换新 → 别人的地址换成你的 → eth_call */
    const v = BigInt(value); const gp = await gasPrice(); const rows = [];
    for (const W of ws) { const row = { w: W.addr, name: W.name };
      try { let d = D.freshDeadline(data); try { d = await D.safeAddrs(W, c, d, v); } catch (e) { row.ok = 0; row.why = errTxt(e).slice(0, 120); rows.push(row); continue; } row.data = d; row.swapped = d !== D.freshDeadline(data) ? 1 : 0;
        try { await rpc('eth_call', [{ from: W.addr, to: c, data: d, value: '0x' + v.toString(16) }, 'latest']); row.ok = 1; try { const g = BigInt(await rpc('eth_estimateGas', [{ from: W.addr, to: c, data: d, value: '0x' + v.toString(16) }])); if (gp) row.fee = (Number(g * gp) / 1e18).toFixed(6); } catch {} }
        catch (e) { const r = reasonOf(e); row.ok = 0; row.why = r == null ? '节点没回应，预演没跑完：' + errTxt(e).slice(0, 80) : D.revWhy(e); row.node = r == null ? 1 : 0; if (gp) { const g = BigInt(Number(gasHint) > 0 ? Math.round(Number(gasHint)) : 21000); row.waste = (Number(g * gp) / 1e18).toFixed(6); row.wasteAtLeast = Number(gasHint) > 0 ? 0 : 1; } } /* 白烧手续费：有参考交易就用它实际用掉的 gas，没有就是「至少」 */
      } catch (e) { row.ok = 0; row.why = errTxt(e).slice(0, 120); }
      rows.push(row); }
    return rows;
  }

  async function send(c, o, P) { /* 你在面板按「送出」：一个钱包送一笔 */
    if (D.locked()) return { ok: 0, why: '🔒 还没完成邀请码绑定：现在只能看，不能买卖' };
    if (D.estop()) return { ok: 0, why: '🛑「紧急全停」开着，不送出（要先在雷达关掉紧急全停）' };
    if (D.manualOff()) return { ok: 0, why: '「手动买卖」开关没打开，不送出（在雷达「设定」打开手动买卖）' };
    if (D.confl()) return { ok: 0, why: '另一个罗宾猫雷达正在用同一个钱包，不送出（先关掉另一个）' };
    const W = wallet(o.w); if (!W) return { ok: 0, why: '没选钱包' }; if (W.off) return { ok: 0, why: `[${W.name}] 登入过期，请先重新连接` };
    const k = check(o); if (k.err) return { ok: 0, why: k.err }; const v = BigInt(k.value);
    if (P.done?.[W.name] === 'unknown' && !o.ack) return { ok: 0, need: 'ack', why: `⚠️需要确认：[${W.name}] 上一笔用这个打法送出的结果不明（可能已经上链），再送可能会铸两次、付两次钱` }; /* CHAIN-1104 */
    if (k.appr && !(o.ack && o.ackAppr)) return { ok: 0, need: 'ackAppr', why: `⚠️需要确认授权：函式 ${k.data.slice(0, 10)} 是转帐／授权类的。送出后对方可能可以随时转走你的代币，可能是盗币。要按「我看懂了」再按「我知道风险，仍然执行」` }; /* ZR-INT-MPK */
    const bal = BigInt((await rpc('eth_getBalance', [W.addr, 'latest']).catch(() => null)) || '0x0'); const keep = D.keepBnb(); if (bnb(v) > bnb(bal) - keep) return { ok: 0, why: keep > 0 ? `[${W.name}] BNB 不够：要付 ${bnb(v)} BNB，还要留你设的「保留 BNB」${keep}（risk.keepBnb）` : `[${W.name}] BNB 不够：要付 ${bnb(v)} BNB` };
    const pv = (await preview(c, k.data, k.value, [W], o.gas))[0];
    if (!pv.data) return { ok: 0, why: pv.why || '组不出交易' };
    if (!pv.ok && !o.ack) return { ok: 0, need: 'ack', why: pv.why, waste: pv.waste, wasteAtLeast: pv.wasteAtLeast };
    { const dr = await D.drainCheck(c, v, pv.data).catch(() => ''); if (dr) return { ok: 0, why: '「防抽干」检查没过（bsc.drainSkip）：' + dr }; }
    if (!pv.ok) log(`[${W.name}] 选打法 ${P.name || c}：预演没过（${pv.why}），你按了「我知道风险，仍然送出」`);
    try { const r = await D.previewExec(W, c, pv.data, v, (sim) => { if (sim?.allowanceChanges?.length || sim?.authorityChanges?.length) return '会授权或交出钱包权限'; const out = (sim?.balanceChanges || []).filter((b) => lc(b.owner) === W.addr && Number(b.change) < 0); if (out.some((b) => !lc(b.contractAddress).startsWith('0xeeee'))) return '会扣到 BNB 以外的币'; if (out.reduce((a, b) => a - Number(b.change), 0) > Number(v) * 1.0000001 + 1) return '会扣的 BNB 比你填的多'; return ''; }, null, { manual: true, ack: !!o.ack, ackAppr: !!o.ackAppr }); /* ZR-INT-MPK：不另给容差（只容小数误差） */
      const px = await D.bnbUsd().catch(() => 0); P.done = P.done || {}; P.done[W.name] = 'minted'; try { D.trackFromSim(W, r.sim, P.name || c.slice(0, 8), px > 0 ? bnb(v) * px : 0); } catch {} save();
      const m = `✋ [${W.name}] 用你选的打法铸造 ${P.name || c.slice(0, 8)}：付 ${bnb(v)} BNB${px > 0 ? '（约 ' + (bnb(v) * px).toFixed(2) + 'U）' : ''}${pv.ok ? '' : '（预演没过，你选了仍然送出）'}\n${c}\n交易 ${r.tx}`; log(m.replace(/\n/g, ' ')); tg(m).catch(() => {});
      return { ok: 1, tx: r.tx || '', why: '' };
    } catch (e) { const m = errTxt(e); if (/結果不明|结果不明|timed? ?out|ETIMEDOUT|killed|SIGTERM/i.test(m)) { P.done = P.done || {}; P.done[W.name] = 'unknown'; save(); const mu = `⚠️ [${W.name}] 选打法 ${P.name || c.slice(0, 8)}：送出后结果不明（逾时），可能已经上链。先到区块浏览器看钱包 ${W.addr}，不要马上重送\n${c}`; log(mu.replace(/\n/g, ' ')); tg(mu).catch(() => {}); return { ok: 0, unknown: 1, why: '⚠️ 结果不明（逾时），可能已经上链；先到区块浏览器确认，不要马上重送' }; } /* CHAIN-1104：逾时＝结果不明，不是「没送」 */ if (/^⚠️需要确认授权/.test(m) && !(o.ack && o.ackAppr)) return { ok: 0, need: 'ackAppr', why: m.replace(/^⚠️需要确认授权：/, '').slice(0, 300) }; if (/^⚠️需要确认/.test(m) && !o.ack) return { ok: 0, need: 'ack', why: m.replace(/^⚠️需要确认：/, '').slice(0, 160) }; return { ok: 0, why: /[預预]演失[敗败]/.test(m) ? '币安钱包自己的预演也没过，钱包不让送出（雷达没办法强送）：' + m.replace(/^[預预]演失[敗败]\s*/, '').slice(0, 120) : m.slice(0, 160) }; }
  }

  async function order(o, c) {
    const op = String(o.op || ''); const P = S.paid?.[c]; const rid = String(o.id || '');
    if (!P) return put(c, { [op]: { rid, at: Date.now(), err: '工具里没有这个铸造项目（雷达没追踪到这个合约）' } });
    if (op === 'list') { if (busy.has('l' + c)) return; busy.add('l' + c); try { await put(c, { list: { rid, at: Date.now(), busy: 1 } }); const r = await list(c); await put(c, { list: { rid, at: Date.now(), ...r } }); log(`选打法 ${P.name || c}：别人的交易 ${r.txs.length} 笔、合约函式 ${r.fns.length} 个`); } finally { busy.delete('l' + c); } return; }
    if (op === 'preview') { const k = check(o); if (k.err) return put(c, { preview: { rid, at: Date.now(), err: k.err } }); const ws = o.w ? [wallet(o.w)].filter(Boolean) : liveW(); if (!ws.length) return put(c, { preview: { rid, at: Date.now(), err: '没有连上的钱包' } }); const rows = await preview(c, k.data, k.value, ws, o.gas); return put(c, { preview: { rid, at: Date.now(), data: k.data, value: k.value, rows } }); }
    if (op === 'set') { const k = check(o); if (k.err) return put(c, { set: { rid, at: Date.now(), err: k.err } }); if (k.appr && !(o.ack && o.ackAppr)) return put(c, { set: { rid, at: Date.now(), need: 'ackAppr', err: `⚠️需要确认授权：函式 ${k.data.slice(0, 10)} 是转帐／授权类的。存起来之后强制打／自动打都会送出它，对方可能可以随时转走你的代币，可能是盗币。要按「我看懂了」再按「我知道风险，仍然执行」才会存（自动打另外要开「自动交易允许授权」）` } }); /* BUG6 */ P.pick = { appr: k.appr ? 1 : 0, data: k.data, value: k.value, src: 'user', how: ['tx', 'fn', 'paste'].includes(o.how) ? o.how : 'paste', label: String(o.label || '').slice(0, 80), from: /^0x[0-9a-f]{40}$/.test(lc(o.from)) ? lc(o.from) : '', gas: Number(o.gas) > 0 ? Math.round(Number(o.gas)) : 0, at: Date.now() }; delete P.unmintable; delete P.unmintableAt; P.cf = 0; P.fail = 0; delete P.noKind; P.lastReason = ''; save(); log(`选打法 ${P.name || c}：存好你选的打法（${P.pick.how}，${bnb(k.value)} BNB，函式 ${k.data.slice(0, 10)}）；强制打和自动打（还要过你的条件）都会用它`); return put(c, { set: { rid, at: Date.now(), ok: 1 } }); }
    if (op === 'clear') { delete P.pick; delete P.replay; P.needLearn = 1; save(); log(`选打法 ${P.name || c}：清掉你选的打法，回到雷达自己学`); return put(c, { set: { rid, at: Date.now(), ok: 1, cleared: 1 } }); }
    if (op === 'send') { const key = 's' + c + lc(o.w); if (busy.has(key)) return put(c, { send: { rid, at: Date.now(), ok: 0, why: '这个钱包正在送，等结果' } }); busy.add(key); try { await put(c, { send: { rid, at: Date.now(), busy: 1 } }); const r = await send(c, o, P); return put(c, { send: { rid, at: Date.now(), ...r } }); } finally { busy.delete(key); } }
  }
  return { order, _t: { list, preview, send, check } };
}
