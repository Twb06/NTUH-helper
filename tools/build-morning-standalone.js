/* eslint-env node */
// node tools/build-morning-standalone.js
// 把 morning-briefing.user.js 連同 lib/news2.js 與簡化版 OuterData 呼叫合併成免 @require 的單檔，
// 輸出到 scripts/standalone/。標頭刻意移除 @require/@updateURL/@downloadURL。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const main = read('scripts/morning-briefing.user.js');
const news = read('scripts/lib/news2.js');
const end = main.indexOf('// ==/UserScript==') + '// ==/UserScript=='.length;
const head = main.slice(0, end).split('\n')
    .filter((l) => !/^\/\/ @(require|updateURL|downloadURL)\s/.test(l))
    .join('\n').replace(/(\/\/ @version\s+\S+)/, '$1-standalone');

const shim = `// ── 內嵌：簡化版 OuterData 呼叫（同時最多 3 個請求、預設 12 秒逾時，可由 options.timeoutMs 覆寫）──
(function () {
    'use strict';
    if (window.NTUHAsmx) return;
    let active = 0;
    const queue = [];
    async function withSlot(task) {
        if (active >= 3) await new Promise((release) => queue.push(release));
        active += 1;
        try { return await task(); } finally { active -= 1; const next = queue.shift(); if (next) next(); }
    }
    async function outerData(datatype, options) {
        const context = (options && options.context) || {};
        const url = window.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
            + 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';
        return withSlot(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), (options && options.timeoutMs) || 12000);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ jsonstring: JSON.stringify(context), datatype }),
                    signal: ctrl.signal,
                    credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                let v = j && j.d;
                if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } }
                return (v && v.Html) || '';
            } finally { clearTimeout(timer); }
        });
    }
    const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');
    window.NTUHAsmx = { outerData, parseHtml };
})();
`;

const out = `${head}\n\n// ── 內嵌：NEWS2 核心 ──\n${news}\n\n${shim}\n// ── 主程式 ──${main.slice(end)}`;
const dest = path.join(root, 'scripts/standalone/morning-briefing.standalone.user.js');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log('wrote', path.relative(root, dest), out.split('\n').length, 'lines');
