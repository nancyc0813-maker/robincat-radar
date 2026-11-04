#!/usr/bin/env node
// zero_check.mjs — "零官方数字" checker for 罗宾猫雷达.（tools/ 版：也能只查一个档；不扫 tools/、.sign*；由 tools/guard_check.mjs 呼叫）
// Usage: node zero_check.mjs <tree> [--allow allowlist.json] [--json out.json] [--quiet]
// Scans .mjs/.cjs/.js/.html/.json (skips node_modules, package-lock.json, dist/, *.min.js).
// Exit 1 if any violation is not covered by the allowlist. Every allowlist entry MUST have a "reason".
//
// Rules (deliberately over-inclusive; false positives go to the allowlist WITH a reason):
//   FALLBACK      `?? <num>` / `|| <num>`                       (hidden default value)
//   CMP           numeric literal next to < > <= >= == === != !==  (threshold), except 0/1/-1
//   MINMAX        Math.min/Math.max with a numeric literal arg ≥2 (hidden cap/floor)
//   SLICE         .slice(0, N) / .slice(-N) with N ≥ 2              (hidden "only first N" rule)
//   OBJNUM        `key: <num>` in object literal, num not 0/1        (default/threshold tables)
//   PARAMDEF      `(x = <num>)` default parameter, num not 0/1
//   TIMEWIN       literal time spans (e.g. 30*60e3, 3600e3, 864e5)   (time windows that may gate decisions)
//   COMMENT_NUM   comment with 数字+(个|笔|%|U|小时|分钟|倍|天|秒|块|BNB|ETH|美金|x) threshold-looking text
//   STRING_NUM    UI/TG string literal with the same pattern (labels/warnings stating thresholds)
//   KWLIST        regex literal with >=3 word alternatives (keyword blacklist / labeling list)
//   SCHEMA_DEF    settings_schema.json item with "def" (only floor bools may carry def:1)
//   NUMSTR        numeric string literal like '0.3' / '15' (slippage / amounts passed as strings)
//   FALLBACK0     `|| 0` / `?? 0` feeding a comparison (missing data silently becomes 0)
//   SCHEMA_TXT    settings_schema.json text mentioning a hard-coded number in prose (最多 N / 连续 N 次 / 每 N 分钟…)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--')) || '.';
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const HERE = dirname(fileURLToPath(import.meta.url));
const allowPath = opt('--allow') || join(HERE, 'zero_allowlist.json');
const quiet = args.includes('--quiet');

// ---------- allowlist ----------
let allow = [];
if (existsSync(allowPath)) {
  const j = JSON.parse(readFileSync(allowPath, 'utf8'));
  allow = (j.entries || j).map((e, i) => {
    if (!e.reason || String(e.reason).trim().length < 4) { console.error(`allowlist entry #${i} has no reason → refused`); process.exit(2); }
    return { ...e, _file: e.file ? new RegExp(e.file) : null, _match: e.match ? new RegExp(e.match) : null, _rule: e.rule ? new RegExp(`^(${e.rule})$`) : null, hits: 0 };
  });
}
const allowed = (v) => allow.find((a) => (!a._rule || a._rule.test(v.rule)) && (!a._file || a._file.test(v.file)) && (!a._match || a._match.test(v.near ?? v.snip)) && (a.value === undefined || String(a.value) === String(v.value)) && (!a.values || a.values.map(String).includes(String(v.value).replace(/^-/, ''))));

// ---------- file walk ----------
const files = [];
if (statSync(root).isFile()) files.push(root); else (function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n); const st = statSync(p);
    if (st.isDirectory()) { if (n === 'node_modules' || n === 'dist' || n === '.git' || n === 'data' || n === 'tools' || n.startsWith('.sign')) continue; walk(p); continue; }
    if (n === 'package-lock.json' || n.endsWith('.min.js')) continue;
    if (/allowlist.*\.json$|^allow_.*\.json$/.test(n) || n === 'guard_rules.json') continue; /* 白名单／检查规则档本身是资料（里面就是被允许的数字），不扫 */
    if (['.mjs', '.cjs', '.js', '.html', '.json'].includes(extname(n))) files.push(p);
  }
})(root);

// ---------- tiny JS tokenizer (comments, strings, templates, regex, numbers, punct) ----------
function tokenize(src, base = 0) {
  const T = []; let i = 0; const n = src.length; const tplStack = [];
  const prevSig = () => { for (let k = T.length - 1; k >= 0; k--) if (T[k].t !== 'c') return T[k]; return null; };
  const regexOk = () => { const p = prevSig(); if (!p) return true; if (p.t === 'num' || p.t === 'str' || p.t === 're' || p.t === 'tpl') return false; if (p.t === 'id') return /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/.test(p.v); if (p.t === 'p') return !/^[)\]}]$/.test(p.v); return true; };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; T.push({ t: 'c', v: src.slice(i, j), at: base + i }); i = j; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; T.push({ t: 'c', v: src.slice(i, j), at: base + i }); i = j; continue; }
    if (c === '<' && src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); const j = e < 0 ? n : e + 3; T.push({ t: 'c', v: src.slice(i, j), at: base + i }); i = j; continue; }
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; } T.push({ t: 'str', v: src.slice(i + 1, j), at: base + i }); i = j + 1; continue; }
    if (c === '`' || (c === '}' && tplStack.length && tplStack[tplStack.length - 1] === 0)) {
      if (c === '}') tplStack.pop();
      let j = i + 1; let s = '';
      while (j < n && src[j] !== '`') { if (src[j] === '\\') { s += src[j] + src[j + 1]; j += 2; continue; } if (src[j] === '$' && src[j + 1] === '{') break; s += src[j]; j++; }
      T.push({ t: 'tpl', v: s, at: base + i });
      if (src[j] === '$') { tplStack.push(0); i = j + 2; } else i = j + 1;
      continue;
    }
    if (c === '{' && tplStack.length) { tplStack[tplStack.length - 1]++; T.push({ t: 'p', v: c, at: base + i }); i++; continue; }
    if (c === '}' && tplStack.length && tplStack[tplStack.length - 1] > 0) { tplStack[tplStack.length - 1]--; T.push({ t: 'p', v: c, at: base + i }); i++; continue; }
    if (c === '/' && regexOk()) { let j = i + 1, cls = false; while (j < n && src[j] !== '\n') { if (src[j] === '\\') { j += 2; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; j++; } let k = j + 1; while (k < n && /[a-z]/i.test(src[k])) k++; T.push({ t: 're', v: src.slice(i + 1, j), at: base + i }); i = k; continue; }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) { const m = /^(0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|(\d[\d_]*)?\.?\d[\d_]*([eE][+-]?\d+)?n?)/.exec(src.slice(i, i + 80)); T.push({ t: 'num', v: m[0], at: base + i }); i += m[0].length; continue; }
    if (/[A-Za-z_$\u00c0-\uffff]/.test(c)) { const m = /^[A-Za-z_$0-9\u00c0-\uffff]+/.exec(src.slice(i, i + 200)); T.push({ t: 'id', v: m[0], at: base + i }); i += m[0].length; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const m3 = /^(===|!==|\?\?=|\?\?|\?\.|>>>|<=|>=|==|!=|&&|\|\||=>|\*\*|\+\+|--|\.\.\.)/.exec(src.slice(i, i + 3));
    if (m3) { T.push({ t: 'p', v: m3[0], at: base + i }); i += m3[0].length; continue; }
    T.push({ t: 'p', v: c, at: base + i }); i++;
  }
  return T;
}
const numVal = (s) => { try { const t = s.replace(/_/g, '').replace(/n$/, ''); return Number(t); } catch { return NaN; } };
const trivial = (v) => v === 0 || v === 1 || v === -1;
const TIME_RE = /^(\d+e3|\d+e4|\d+e5|\d+e6|\d+e7|60000|3600000|86400000|864e5|36e5|6e4|\d+_?000)$/;
// threshold-looking number+unit in prose
const NUMUNIT = /(?<![\w.#\/-])(\d+(?:\.\d+)?)\s*(?:～|~|-|到)?\s*(?:\d+(?:\.\d+)?)?\s*(个|笔|%|％|U\b|u\b|小时|分钟|分鐘|小時|倍|天|秒|块|區塊|区块|BNB|ETH|美金|万|x\b|X\b|次|份|位|档|h\b|min\b)/;

const out = [];
function lineCol(src, at) { let l = 1, last = 0; for (let k = src.indexOf('\n'); k >= 0 && k < at; k = src.indexOf('\n', k + 1)) { l++; last = k + 1; } return [l, at - last + 1]; }
function snippet(src, at, len = 70) { return src.slice(Math.max(0, at - len), at + len).replace(/\s+/g, ' '); }
// allowlist entries are matched against a NARROW window (±45 chars) so one plumbing pattern nearby cannot hide a decision literal

function scanJS(src, file, base = 0, full = src) {
  const T = tokenize(src, base);
  const sig = T.filter((t) => t.t !== 'c');
  const add = (rule, tok, value, extra = '') => { const [l, c] = lineCol(full, tok.at); out.push({ rule, file, line: l, col: c, value, snip: snippet(full, tok.at), near: snippet(full, tok.at, 45), ctx: extra }); };
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k]; const p = sig[k - 1] || {}; const q = sig[k + 1] || {}; const pp = sig[k - 2] || {};
    if (t.t === 'num') {
      const v = numVal(t.v); const neg = p.v === '-' && !/^(num|id|str)$/.test(pp.t) && pp.v !== ')' && pp.v !== ']';
      const cmpBefore = /^(<|>|<=|>=|==|===|!=|!==)$/.test(neg ? pp.v : p.v); const cmpAfter = /^(<|>|<=|>=|==|===|!=|!==)$/.test(q.v);
      if ((p.v === '??' || p.v === '||') || (neg && (pp.v === '??' || pp.v === '||'))) {
        if (!trivial(v)) { add('FALLBACK', t, t.v); continue; }
        // `|| 0` / `?? 0` / `|| 1`: only a problem when the defaulted value feeds a comparison (missing data silently becomes 0/1 in a decision)
        const near = sig.slice(k + 1, k + 4).map((x) => x.v); let d = 0, j = k - 1; for (; j >= 0 && j > k - 30; j--) { if (sig[j].v === ')') d++; else if (sig[j].v === '(') { if (d === 0) break; d--; } }
        const before = j >= 0 ? (sig[j - 1] || {}).v : '';
        if (near.some((x) => /^(<|>|<=|>=)$/.test(x)) || /^(<|>|<=|>=)$/.test(before || '')) add('FALLBACK0', t, t.v);
        continue; }
      if ((cmpBefore || cmpAfter) && !trivial(v)) { add('CMP', t, t.v); continue; }
      if (TIME_RE.test(t.v) || (q.v === '*' && (sig[k + 2] || {}).t === 'num' && /^(6e4|60e3|60000|36e5|3600e3|864e5|1e3|1000|60|3600)$/.test(sig[k + 2].v) && v >= 2)) { add('TIMEWIN', t, t.v); continue; }
      if (q.v === ')' && (p.v === ',' || p.v === '(') ) {
        // Math.min / Math.max argument?
        let d = 0, j = k; for (; j >= 0; j--) { if (sig[j].v === ')') d++; if (sig[j].v === '(') { if (d === 0) break; d--; } }
        const fn = (sig[j - 1] || {}).v, obj = (sig[j - 3] || {}).v;
        if (obj === 'Math' && (fn === 'min' || fn === 'max') && !trivial(v)) { add('MINMAX', t, t.v); continue; }
        if (fn === 'slice' && v >= 2 && !(sig[j + 1] && sig[j + 1].t === 'num' && sig[j + 1] === t)) { add('SLICE', t, t.v); continue; }
      }
      if (p.v === '-' && pp.v === '(' && (sig[k - 3] || {}).v === 'slice' && v >= 2) { add('SLICE', t, '-' + t.v); continue; }
      if (p.v === ':' && (pp.t === 'id' || pp.t === 'str') && !trivial(v) && (sig[k - 3] || {}).v !== '?' ) { // object literal (rough: not ternary)
        // avoid ternary `a ? b : 3` : look back for '?' at same depth before '{' or ','
        let d = 0, isTern = false; for (let j = k - 2; j >= 0 && j > k - 40; j--) { const s = sig[j].v; if (s === ')' || s === ']' || s === '}') d++; else if (s === '(' || s === '[' || s === '{') { if (d === 0) break; d--; } else if (d === 0 && s === ',') break; else if (d === 0 && s === '?') { isTern = true; break; } }
        if (!isTern) { add('OBJNUM', t, t.v, pp.v); continue; }
      }
      if (p.v === '=' && pp.t === 'id' && ((sig[k - 3] || {}).v === '(' || (sig[k - 3] || {}).v === ',') && q.v !== '=' && !trivial(v)) {
        // default param or plain assignment in let a=…, b=… ; only flag if inside parens of a function signature
        let d = 0, j = k; for (; j >= 0; j--) { if (sig[j].v === ')') d++; if (sig[j].v === '(') { if (d === 0) break; d--; } }
        if (j >= 0) { let d2 = 0, e = k; for (; e < sig.length; e++) { if (sig[e].v === '(') d2++; if (sig[e].v === ')') { if (d2 === 0) break; d2--; } } if ((sig[e + 1] || {}).v === '=>' || (sig[e + 1] || {}).v === '{') { add('PARAMDEF', t, t.v); continue; } }
      }
    }
    if (t.t === 're') { const alts = t.v.split('|').filter((a) => /[A-Za-z\u4e00-\u9fff]{2,}/.test(a)); if (alts.length >= 3) add('KWLIST', t, t.v.slice(0, 60)); }
    if (t.t === 'str' && /^\d+(\.\d+)?$/.test(t.v) && Number(t.v) > 0 && Number(t.v) !== 1 && !/^(0x|\d{6,})/.test(t.v) && !/^(56|4663)$/.test(t.v)) add('NUMSTR', t, "'" + t.v + "'");
    if ((t.t === 'str' || t.t === 'tpl') && /[\u4e00-\u9fff]/.test(t.v)) { const m = NUMUNIT.exec(t.v); if (m && !trivial(Number(m[1]))) add('STRING_NUM', t, m[0]); }
  }
  for (const t of T) if (t.t === 'c') { const m = NUMUNIT.exec(t.v); if (m && !trivial(Number(m[1]))) { const [l, c] = lineCol(full, t.at); out.push({ rule: 'COMMENT_NUM', file, line: l, col: c, value: m[0], snip: t.v.slice(0, 160).replace(/\s+/g, ' ') }); } }
}

function scanHTML(src, file) {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(src))) scanJS(m[1], file, m.index + m[0].indexOf(m[1]), src);
  // HTML comments and visible text outside scripts
  const stripped = src.replace(/<script\b[\s\S]*?<\/script>/gi, (s) => ' '.repeat(s.length));
  const rc = /<!--([\s\S]*?)-->/g; while ((m = rc.exec(stripped))) { const k = NUMUNIT.exec(m[1]); if (k && !trivial(Number(k[1]))) { const [l, c] = lineCol(src, m.index); out.push({ rule: 'COMMENT_NUM', file, line: l, col: c, value: k[0], snip: m[1].slice(0, 160) }); } }
  const rt = />([^<]*[\u4e00-\u9fff][^<]*)</g; while ((m = rt.exec(stripped))) { const k = NUMUNIT.exec(m[1]); if (k && !trivial(Number(k[1]))) { const [l, c] = lineCol(src, m.index); out.push({ rule: 'STRING_NUM', file, line: l, col: c, value: k[0], snip: m[1].trim().slice(0, 160) }); } }
}

function scanJSON(src, file) {
  let j; try { j = JSON.parse(src); } catch { return; }
  const rel = file;
  if (/settings_schema\.json$/.test(file)) {
    for (const it of j.items || []) {
      const ln = (() => { const at = src.indexOf(`"k": "${it.k}"`); return at < 0 ? 0 : lineCol(src, at)[0]; })();
      if ('def' in it && !(it.type === 'bool' && it.floor && it.def === 1) && !(it.type === 'bool' && it.def === 0)) out.push({ rule: 'SCHEMA_DEF', file: rel, line: ln, col: 1, value: `${it.k}=${JSON.stringify(it.def)}`, snip: it.zh || '' });
      if ('def' in it && it.type !== 'bool') out.push({ rule: 'SCHEMA_DEF', file: rel, line: ln, col: 1, value: `${it.k}=${JSON.stringify(it.def)}`, snip: 'number item must not have def' });
      for (const f of ['zh', 'en', 'dzh', 'den', 'xzh']) {
        const t = it[f] || ''; const m = /(最多|最少|至少|连续|每|约|多卖|超过|不到|only|max|at most|every|up to)\s*\D{0,4}(\d+(?:\.\d+)?)\s*(个|笔|%|小时|分钟|倍|天|秒|次|档|块|hours?|min|minutes?|x|times)/i.exec(t);
        if (m) out.push({ rule: 'SCHEMA_TXT', file: rel, line: ln, col: 1, value: `${it.k}.${f}: ${m[0]}`, snip: t.slice(0, 160) });
      }
      for (const f of ['phzh', 'phen']) if (it[f] && /\d/.test(it[f])) out.push({ rule: 'SCHEMA_TXT', file: rel, line: ln, col: 1, value: `${it.k}.${f}: ${it[f]}`, snip: 'placeholder states an official-looking number' });
    }
    return;
  }
  // other JSON: any numeric leaf not 0/1 is reported (configs, official lists)
  (function walk(o, path) {
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, path + '[' + i + ']'));
    if (o && typeof o === 'object') return Object.entries(o).forEach(([k, v]) => walk(v, path ? path + '.' + k : k));
    if (typeof o === 'number' && !trivial(o)) { const key = path.split('.').pop(); const at = src.indexOf(`"${key}"`); out.push({ rule: 'JSON_NUM', file: rel, line: at < 0 ? 0 : lineCol(src, at)[0], col: 1, value: `${path}=${o}`, snip: path }); }
    if (typeof o === 'string' && /[\u4e00-\u9fff]/.test(o)) { const m = NUMUNIT.exec(o); if (m && !trivial(Number(m[1]))) out.push({ rule: 'STRING_NUM', file: rel, line: 0, col: 1, value: m[0], snip: path + ': ' + o.slice(0, 120) }); }
  })(j, '');
}

for (const f of files) {
  const src = readFileSync(f, 'utf8'); const rel = (relative(root, f) || basename(f)).split('\\').join('/');
  const ext = extname(f);
  if (ext === '.json') scanJSON(src, rel); else if (ext === '.html') scanHTML(src, rel); else scanJS(src, rel);
}

const viol = [], ok = [];
for (const v of out) { const a = allowed(v); if (a) { a.hits++; ok.push({ ...v, reason: a.reason }); } else viol.push(v); }
const by = {}; for (const v of viol) { by[v.rule] = (by[v.rule] || 0) + 1; }
const byFile = {}; for (const v of viol) { byFile[v.file] = (byFile[v.file] || 0) + 1; }
if (!quiet) for (const v of viol) console.log(`${v.rule.padEnd(11)} ${v.file}:${v.line}:${v.col}  [${v.value}]  ${v.snip}`);
console.log('\n== zero_check summary ==');
console.log('files scanned:', files.length, '| findings:', out.length, '| allowlisted:', ok.length, '| VIOLATIONS:', viol.length);
console.log('by rule:', JSON.stringify(by));
console.log('by file:', JSON.stringify(byFile));
const unused = allow.filter((a) => !a.hits); if (unused.length) console.log('allowlist entries with no hits (stale?):', unused.length);
const jo = opt('--json'); if (jo) writeFileSync(jo, JSON.stringify({ viol, ok }, null, 1));
process.exit(viol.length ? 1 : 0);
