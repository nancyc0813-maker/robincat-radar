#!/usr/bin/env node
/* TV2-1114 新看盘终端：把 radar/ui/term/src 的原始码组成雷达画面实际载入的两个档
   - radar/ui/term/tv2.js ：a0（资料桥）＋a1–a6 依序串起来，整段包进一个函式（不跟旧画面的全域变数撞名）
   - radar/ui/term/tv2.css：所有选择器加上 #tv2 前缀（不影响旧画面）；@keyframes 名称加 tv2 前缀（不跟旧画面的动画撞名）
   用法：node tools/term_build.mjs（只读 src、只写这两个档；不连网、不碰设定） */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'radar', 'ui', 'term', 'src');
const OUT = join(ROOT, 'radar', 'ui', 'term');
const JS = ['a0.js', 'a1.js', 'a2.js', 'a3.js', 'a4.js', 'a6.js', 'a5.js'];
const js = JS.map((f) => `/* ---- ${f} ---- */\n` + readFileSync(join(SRC, f), 'utf8')).join('\n');
writeFileSync(join(OUT, 'tv2.js'), `/* 罗宾猫雷达 新看盘终端（TV2-1114）——由 tools/term_build.mjs 从 radar/ui/term/src 产生，请改 src 再重新产生 */\n${readFileSync(join(SRC, 'g0.js'), 'utf8')}\n(function(){'use strict';\nif(window.__tv2)return;window.__tv2=1;\ntry{\n${js}\n}catch(e){console.error('[tv2]',e);try{window.__tv2Fail&&window.__tv2Fail(e)}catch{}}\n})();\n`);

/* ---- CSS 加前缀 ---- */
let css = readFileSync(join(SRC, 'style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const kf = [...css.matchAll(/@keyframes\s+([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
const ROOTSEL = /^(:root|html|body)/;
function scopeSel(s) {
  s = s.trim(); if (!s) return s;
  if (/^(from|to|\d+%)$/.test(s)) return s;
  if (s === '*') return '#tv2,#tv2 *';
  let m = s.match(/^((?::root|html|body)(?:\[[^\]]+\])*)+/);
  if (m) { const attrs = (m[0].match(/\[[^\]]+\]/g) || []).join(''); const rest = s.slice(m[0].length); return '#tv2' + attrs + rest; }
  m = s.match(/^((?:\[data-(?:theme|mode)[^\]]*\])+)(.*)$/);
  if (m) return '#tv2' + m[1] + m[2];
  return '#tv2 ' + s;
}
function splitSel(sel) { const out = []; let d = 0, cur = ''; for (const ch of sel) { if (ch === '(' || ch === '[') d++; if (ch === ')' || ch === ']') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; }
function walk(s) { let out = '', i = 0;
  while (i < s.length) {
    const ob = s.indexOf('{', i); if (ob < 0) { out += s.slice(i); break; }
    const head = s.slice(i, ob).trim();
    let d = 1, j = ob + 1; while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
    const body = s.slice(ob + 1, j - 1);
    if (/^@keyframes/.test(head)) out += head.replace(/@keyframes\s+([A-Za-z0-9_-]+)/, '@keyframes tv2$1') + '{' + body + '}\n';
    else if (/^@(media|container|supports)/.test(head)) out += head + '{' + walk(body) + '}\n';
    else if (/^@/.test(head)) out += head + '{' + body + '}\n';
    else out += splitSel(head).map(scopeSel).join(',') + '{' + body + '}\n';
    i = j;
  }
  return out; }
css = walk(css);
if (kf.length) { const re = new RegExp('(animation(?:-name)?\\s*:[^;}]*?)\\b(' + kf.join('|') + ')\\b', 'g'); let prev; do { prev = css; css = css.replace(re, '$1tv2$2'); } while (css !== prev); }
writeFileSync(join(OUT, 'tv2.css'), '/* 罗宾猫雷达 新看盘终端（TV2-1114）——由 tools/term_build.mjs 产生，请改 src/style.css 再重新产生 */\n' + css);
console.log('tv2.js', js.length, 'tv2.css', css.length, 'keyframes', kf.length);
