// 罗宾猫邀请绑定：EIP-712 签名（钱包签一段文字，不送交易、不花 gas、不动钱）＋验证
// 绑定内容：kind（join=我被谁邀请 / code=我申请这个邀请码）、code、wallet
const KRC = [1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n];
const KROT = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
const M64 = (1n << 64n) - 1n; const rotl = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function keccakHex(hex) {
  const msg = Buffer.from(hex, 'hex'); const rate = 136; const padLen = rate - (msg.length % rate); const p = Buffer.concat([msg, Buffer.alloc(padLen)]); p[msg.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) A[i] ^= p.readBigUInt64LE(off + i * 8);
    for (let r = 0; r < 24; r++) {
      const C = [0, 1, 2, 3, 4].map((x) => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
      for (let x = 0; x < 5; x++) { const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) A[y + x] ^= D; }
      const B = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], KROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & M64 & B[((x + 2) % 5) + 5 * y]);
      A[0] ^= KRC[r];
    }
  }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(A[i], i * 8); return out.toString('hex');
}
const kh = (s) => keccakHex(Buffer.from(s, 'utf8').toString('hex'));
const pad = (h) => h.padStart(64, '0');
const T_DOM = kh('EIP712Domain(string name,string version,uint256 chainId)');
const T_BIND = kh('Bind(string kind,string code,address wallet)');
export const CODE_RE = /^[a-z0-9]{3,10}$/; /* H2：跟雷达画面 refOk／main.cjs CODE_OK 同一套字元（只能小写英文＋数字） */
export function bindTyped(kind, code, wallet) {
  return { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }], Bind: [{ name: 'kind', type: 'string' }, { name: 'code', type: 'string' }, { name: 'wallet', type: 'address' }] }, primaryType: 'Bind', domain: { name: 'RobinCat Radar', version: '1', chainId: 56 }, message: { kind, code, wallet: wallet.toLowerCase() } };
}
export function bindDigest(kind, code, wallet) {
  const dom = keccakHex(T_DOM + kh('RobinCat Radar') + kh('1') + pad((56).toString(16)));
  const st = keccakHex(T_BIND + kh(kind) + kh(code) + pad(wallet.toLowerCase().replace(/^0x/, '')));
  return keccakHex('1901' + dom + st);
}
// secp256k1 公钥还原（纯 BigInt）
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const Gx = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, Gy = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const md = (a, m) => ((a % m) + m) % m;
const pw = (b, e, m) => { let r = 1n; b = md(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
const inv = (a, m) => pw(a, m - 2n, m);
/* Jacobian 座标（不用每步做模反元素），算得快；机器人收到绑定讯息时不会卡住引擎 */
function jdbl(X, Y, Z) { if (Y === 0n) return [0n, 1n, 0n]; const YY = Y * Y % P, S = 4n * X * YY % P, M = 3n * X * X % P; const X3 = md(M * M - 2n * S, P); return [X3, md(M * (S - X3) - 8n * YY * YY, P), 2n * Y * Z % P]; }
function jadd(A, B) { if (A[2] === 0n) return B; if (B[2] === 0n) return A; const Z1Z1 = A[2] * A[2] % P, Z2Z2 = B[2] * B[2] % P; const U1 = A[0] * Z2Z2 % P, U2 = B[0] * Z1Z1 % P, S1 = A[1] * B[2] % P * Z2Z2 % P, S2 = B[1] * A[2] % P * Z1Z1 % P;
  if (U1 === U2) return S1 === S2 ? jdbl(A[0], A[1], A[2]) : [0n, 1n, 0n]; const H = md(U2 - U1, P), R = md(S2 - S1, P), HH = H * H % P, HHH = H * HH % P, V = U1 * HH % P; const X3 = md(R * R - HHH - 2n * V, P); return [X3, md(R * (V - X3) - S1 * HHH, P), A[2] * B[2] % P * H % P]; }
function jmul(k, Pt) { let R = [0n, 1n, 0n], Q = [Pt[0], Pt[1], 1n]; k = md(k, N); while (k > 0n) { if (k & 1n) R = jadd(R, Q); Q = jdbl(Q[0], Q[1], Q[2]); k >>= 1n; } return R; }
function jaff(J) { if (J[2] === 0n) return null; const zi = inv(J[2], P), z2 = zi * zi % P; return [J[0] * z2 % P, J[1] * z2 % P * zi % P]; }
export function recoverAddr(digestHex, sigHex, recId) {
  const s0 = sigHex.replace(/^0x/, ''); const r = BigInt('0x' + s0.slice(0, 64)), s = BigInt('0x' + s0.slice(64, 128));
  let v = recId != null ? Number(recId) : s0.length >= 130 ? parseInt(s0.slice(128, 130), 16) : 0; if (v >= 27) v -= 27;
  if (r <= 0n || r >= N || s <= 0n || s >= N || (v !== 0 && v !== 1)) return '';
  const x = r; const y2 = md(x * x * x + 7n, P); let y = pw(y2, (P + 1n) / 4n, P); if (y * y % P !== y2) return ''; if ((y & 1n) !== BigInt(v)) y = P - y;
  const e = BigInt('0x' + digestHex); const ri = inv(r, N);
  const Q = jaff(jadd(jmul(md(s * ri, N), [x, y]), jmul(md(-e * ri, N), [Gx, Gy]))); if (!Q) return '';
  return '0x' + keccakHex(pad(Q[0].toString(16)) + pad(Q[1].toString(16))).slice(24);
}
export function verifyBind(kind, code, wallet, sigHex, recId) {
  try { const d = bindDigest(kind, code, wallet); const s = String(sigHex).replace(/^0x/, ''); for (const v of recId != null && recId !== '' ? [Number(recId) % 27, 1 - Number(recId) % 27] : [0, 1]) { if (recoverAddr(d, s.slice(0, 128), v) === wallet.toLowerCase()) return true; } } catch {} return false;
}
