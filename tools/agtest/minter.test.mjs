// MINTER-1126 回归测试：代币跟铸造合约分开（AGC：代币 0x63de…、铸造合约 0x6288…，claimFree(uint256[])／claimReward(uint256[])），要看铸造合约才判断得出是 Agent ID 专属。不连网（节点是假的）。
import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs'; import { join, dirname } from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..'); const SRC = readFileSync(join(ROOT, 'watch.mjs'), 'utf8');
const REGISTRY = '60b9262456de011f7d15a54cdd8c48baaa8b022f'; const TOK = '0x63dea5acdbe1f27c968907d08610a5f0a0284ba6', MINTER = '0x6288dfe86f22b53eeb6886ae2d78941de7483743';
function load(chain) { const a = SRC.indexOf('const MG = { slots:'), b = SRC.indexOf('async function checkMinted(', a); assert.ok(a > 0 && b > a, '找不到铸造合约判断');
  const rpc = async (m, p) => { if (m === 'eth_getCode') return chain.code[p[0]] || '0x'; if (m === 'eth_getStorageAt') return (chain.slots[p[0]] || {})[parseInt(p[1], 16)] || '0x' + '0'.repeat(64); throw new Error(m); };
  return new Function('rpc', 'fullCode', 'REGISTRY', SRC.slice(a, b) + '; return { minterGate, mintersOf, arrArg };')(rpc, async (_a, c) => c, REGISTRY); }
const claimFree = (ids) => '0x73fc9ccc' + (32).toString(16).padStart(64, '0') + ids.length.toString(16).padStart(64, '0') + ids.map((i) => i.toString(16).padStart(64, '0')).join('');
const txs = [{ to: MINTER, from: '0x08c4937606cc643ac5ae6cd09eace942ba369151', input: claimFree([22]), value: '0x0' }, { to: MINTER, from: '0xbc8b', input: claimFree([]), value: '0x0' }, { to: MINTER, from: '0xa935', input: '0xc94c7ff4' + claimFree([0, 1]).slice(10), value: '0x0' }];
test('AGC：代币合约没有 Agent ID 检查，铸造合约有 → 找到铸造合约、判断成 Agent ID 专属', async () => {
  const F = load({ code: { [TOK]: '0x6080' + 'ab'.repeat(50) + MINTER.slice(2), [MINTER]: '0x6080' + 'cd'.repeat(50) + REGISTRY + 'ef' }, slots: {} });
  assert.deepEqual(await F.mintersOf(TOK, txs), [MINTER]); assert.equal(await F.minterGate(TOK), '', '代币本身没有'); assert.equal(await F.minterGate(MINTER), '合约里有 Agent ID 检查'); });
test('登记合约只放在铸造合约的设定（储存槽）里 → 也算 Agent ID 专属', async () => { const F = load({ code: { [MINTER]: '0x6080' + 'cd'.repeat(80) }, slots: { [MINTER]: { 3: '0x000000000000000000000000' + REGISTRY } } }); assert.equal(await F.minterGate(MINTER), '合约设定里放着 Agent ID 登记合约'); });
test('什么都没有 → 不是（不会只因为参数是一串编号就当成 Agent ID 专属）', async () => { const F = load({ code: { [MINTER]: '0x6080' + 'cd'.repeat(80) }, slots: {} }); assert.equal(await F.minterGate(MINTER), ''); assert.ok(F.arrArg(claimFree([22])) && F.arrArg(claimFree([])), 'claimFree(uint256[]) 认得出参数是一串编号（只写进说明）'); assert.ok(!F.arrArg('0x40c10f19' + '0'.repeat(128))); assert.equal(await F.minterGate('0x' + '9'.repeat(40)), '', '没有合约码'); });
test('代币自己铸的（to＝代币）不算另外的铸造合约', async () => { const F = load({ code: {}, slots: {} }); assert.deepEqual(await F.mintersOf(TOK, [{ to: TOK }, { to: null }, { to: MINTER }, { to: MINTER }]), [MINTER]); });
test('接线：铸造监测（checkMinted）和群里网址检查（agentOnly）都会看铸造合约', () => { const c = SRC.slice(SRC.indexOf('async function checkMinted('), SRC.indexOf('async function inscScan(')); assert.match(c, /await mintersOf\(tok, txs\)/); assert.match(c, /await minterGate\(a\)/);
  const o = SRC.slice(SRC.indexOf('async function agentOnly('), SRC.indexOf('async function agentOnly(') + 2500); assert.match(o, /mintersOf\(c, mt\)/); assert.match(o, /minterGate\(a\)/); });
