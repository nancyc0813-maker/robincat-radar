'use strict';
/*SOLKFIX-1117 K 棒组装的单元测试（只测纯函式，不连网）：node tools/test_kbars.cjs，全部通过才能发版 */
const assert = require('assert');
const path = require('path');
const { agg } = require(path.join(__dirname, '..', 'radar', 'solk.cjs'));
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('✅ ' + name); };
/* 三笔成交：秒 100、100、101；价格＝vsol／vtok；量＝sol（没有 SOL 美金价时 u＝1） */
const tr = [{ ts: 100, vsol: 30, vtok: 10, sol: 1 }, { ts: 100, vsol: 50, vtok: 10, sol: 2 }, { ts: 101, vsol: 40, vtok: 10, sol: 4 }];
ok('1 秒一根：秒 100 两笔合成一根、秒 101 一根', () => {
  const B = agg(tr, 1, 0); assert.strictEqual(B.length, 2);
  assert.deepStrictEqual(B[0], { t: 100000, o: 3, h: 5, l: 3, c: 5, v: 3 });
  assert.deepStrictEqual(B[1], { t: 101000, o: 4, h: 4, l: 4, c: 4, v: 4 }); });
ok('5 秒一根：三笔在同一格', () => { const B = agg(tr, 5, 0); assert.strictEqual(B.length, 1); assert.deepStrictEqual(B[0], { t: 100000, o: 3, h: 5, l: 3, c: 4, v: 7 }); });
ok('乘上 SOL 美金价', () => { const B = agg(tr, 1, 2); assert.deepStrictEqual(B[0], { t: 100000, o: 6, h: 10, l: 6, c: 10, v: 6 }); });
ok('顺序打乱也一样（照时间排）', () => { const B = agg([tr[2], tr[1], tr[0]], 1, 0); assert.strictEqual(B.length, 2); assert.strictEqual(B[0].v, 3); });
ok('没有时间或代币数量为 0 的成交跳过', () => { const B = agg([{ ts: 0, vsol: 1, vtok: 1, sol: 1 }, { ts: 100, vsol: 1, vtok: 0, sol: 1 }], 1, 0); assert.strictEqual(B.length, 0); });
console.log(`全部通过（${n} 项）`); process.exit(0);
