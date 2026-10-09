#!/usr/bin/env node
/**
 * 构建后处理：扫描打包产物 index.html 中所有「可执行的内联 <script>」
 * （无 src、且非 text/x-template），逐个计算 SHA-256，并把 hash 注入到
 * CSP 的 script-src 指令里。这样既能保留防主题闪烁等必要的内联引导脚本，
 * 又不必在 CSP 中放开 'unsafe-inline'，注入的任意内联脚本仍会被拦截。
 *
 * 用法: node tools/inject-csp-hash.cjs [html文件，默认 dist/index.html]
 */
const fs = require('fs');
const crypto = require('crypto');

const file = process.argv[2] || 'dist/index.html';
let html = fs.readFileSync(file, 'utf8');

const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const hashes = [];
let m;
while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;                              // 外部脚本，由 'self'/https 放行
    if (/type\s*=\s*["']text\/x-template["']/.test(attrs)) continue;    // 模板，不执行
    if (!body.trim()) continue;                                         // 空脚本
    const digest = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
    hashes.push("'sha256-" + digest + "'");
}

if (!hashes.length) {
    console.log('[inject-csp-hash] 未发现可执行内联脚本，无需注入 hash');
    process.exit(0);
}

html = html.replace(/script-src[^;]*/, (seg) => {
    const base = seg.replace(/'sha256-[^']+'/g, '').replace(/\s+$/, '');
    return base + ' ' + hashes.join(' ');
});

fs.writeFileSync(file, html);
console.log('[inject-csp-hash] 已向 ' + file + ' 注入 ' + hashes.length + ' 个内联脚本 hash：');
hashes.forEach(h => console.log('  ' + h));
