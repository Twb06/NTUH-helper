/* eslint-env node */
// 產生 snippet 管理器：把 scripts/devtools-snippets/*.devtools.js 打包成單一檔案，
// 提供啟用／停用與批次執行面板。由 CI 於建置後自動執行。
//
// 用法：
//   node tools/build-snippet-manager.js
//   node tools/build-snippet-manager.js --only NTUH-diagcertificate-filler,lab-summary
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '../scripts/devtools-snippets');
const OUT_FILE = path.join(DIR, '_manager.devtools.js');
const MANIFEST = path.join(DIR, 'manifest.json');

const runtime = `
(function () {
    'use strict';
    const STATE_KEY = 'ntuh_snippet_manager_state_v1';
    const AUTORUN_KEY = 'ntuh_snippet_manager_autorun';
    const registry = window.__NTUH_SNIPPET_REGISTRY__ || [];
    const readState = () => {
        try { return JSON.parse(window.localStorage.getItem(STATE_KEY) || '{}'); } catch (e) { return {}; }
    };
    const readAutorun = () => {
        try { return window.localStorage.getItem(AUTORUN_KEY) === '1'; } catch (e) { return false; }
    };
    const writeState = state => {
        try { window.localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
    };
    const state = readState();
    registry.forEach(item => { if (typeof state[item.id] !== 'boolean') state[item.id] = true; });
    writeState(state);
    const isEnabled = id => state[id] !== false;
    const run = item => {
        try {
            new Function(item.code)();
            console.log('[manager] ▶ 執行', item.label);
            return true;
        } catch (error) {
            console.error('[manager] ✗ 執行失敗', item.label, error);
            return false;
        }
    };
    const runEnabled = () => {
        const done = registry.filter(item => isEnabled(item.id)).map(run);
        setStatus(\`已執行 \${done.filter(Boolean).length} / \${done.length} 支腳本\`);
    };
    const existing = document.getElementById('ntuh-snippet-manager');
    if (existing) existing.remove();
    const panel = document.createElement('div');
    panel.id = 'ntuh-snippet-manager';
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;width:320px;max-height:70vh;overflow:auto;background:#141824;border:1px solid #2d3650;border-radius:10px;z-index:2147483647;font-family:Consolas,monospace;font-size:12px;color:#c8d3e8;box-shadow:0 8px 28px rgba(0,0,0,.45)';
    panel.innerHTML = \`
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#2a1f3a;border-bottom:1px solid #2d3650;">
            <strong>🧩 Snippet 管理器</strong>
            <button id="ntuh-sm-close" style="background:none;border:none;color:#7a8aaa;cursor:pointer;font-size:14px;">✕</button>
        </div>
        <div style="padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;">
            <button id="ntuh-sm-run" style="flex:1;padding:6px;border:none;border-radius:6px;background:#6a3cac;color:#fff;cursor:pointer;">▶ 執行啟用中</button>
            <button id="ntuh-sm-all" style="padding:6px;border:1px solid #2d3650;border-radius:6px;background:transparent;color:#c8d3e8;cursor:pointer;">全部啟用</button>
            <button id="ntuh-sm-none" style="padding:6px;border:1px solid #2d3650;border-radius:6px;background:transparent;color:#c8d3e8;cursor:pointer;">全部停用</button>
        </div>
        <div id="ntuh-sm-list" style="padding:0 10px 6px;"></div>
        <div style="padding:0 10px 6px;border-top:1px dashed #232a3d;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="checkbox" id="ntuh-sm-autorun">
                <span>開頁自動執行（僅在自動注入時有效，如 Local Overrides）</span>
            </label>
        </div>
        <div id="ntuh-sm-status" style="padding:6px 10px 10px;color:#7a8aaa;"></div>
    \`;
    document.body.appendChild(panel);
    const list = panel.querySelector('#ntuh-sm-list');
    const setStatus = message => { panel.querySelector('#ntuh-sm-status').textContent = message; };
    const render = () => {
        list.innerHTML = '';
        registry.forEach(item => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px dashed #232a3d;';
            const label = document.createElement('label');
            label.style.cssText = 'flex:1;display:flex;align-items:center;gap:6px;cursor:pointer;';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = isEnabled(item.id);
            box.addEventListener('change', () => { state[item.id] = box.checked; writeState(state); });
            const text = document.createElement('span');
            text.textContent = item.label + (item.crossOrigin ? ' ⚠' : '');
            if (item.crossOrigin) text.title = '跨來源功能在 DevTools 模式會失效';
            label.appendChild(box); label.appendChild(text);
            const play = document.createElement('button');
            play.textContent = '▶';
            play.style.cssText = 'background:none;border:1px solid #2d3650;border-radius:4px;color:#9a7cdc;cursor:pointer;';
            play.addEventListener('click', () => { run(item); });
            row.appendChild(label); row.appendChild(play);
            list.appendChild(row);
        });
    };
    render();
    const autoBox = panel.querySelector('#ntuh-sm-autorun');
    if (autoBox) {
        autoBox.checked = readAutorun();
        autoBox.addEventListener('change', () => {
            try { window.localStorage.setItem(AUTORUN_KEY, autoBox.checked ? '1' : '0'); } catch (e) { /* ignore */ }
        });
    }
    panel.querySelector('#ntuh-sm-run').addEventListener('click', runEnabled);
    panel.querySelector('#ntuh-sm-all').addEventListener('click', () => { registry.forEach(item => state[item.id] = true); writeState(state); render(); });
    panel.querySelector('#ntuh-sm-none').addEventListener('click', () => { registry.forEach(item => state[item.id] = false); writeState(state); render(); });
    panel.querySelector('#ntuh-sm-close').addEventListener('click', () => panel.remove());
    // 自動注入情境（Local Overrides／覆寫注入）下才會觸發：頁面載入完成後自動執行啟用中的腳本。
    // 手動執行 snippet 時頁面通常已載入完成，故不排程，避免重複執行同一批腳本。
    if (readAutorun() && document.readyState !== 'complete') {
        window.addEventListener('load', () => setTimeout(runEnabled, 1200), { once: true });
        console.log('[manager] 已啟用開頁自動執行（載入完成後 1.2 秒執行）');
    }
    console.log('[manager] 已載入 ' + registry.length + ' 支腳本；按「▶ 執行啟用中」開始');
    window.__NTUH_SNIPPET_MANAGER__ = { run, runEnabled, registry };
})();
`;

function main() {
    const args = process.argv.slice(2);
    const onlyArg = args.find(arg => arg.startsWith('--only'));
    const only = onlyArg ? (args[args.indexOf(onlyArg) + 1] || '').split(',').filter(Boolean) : null;
    const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : [];
    const entries = manifest
        .filter(item => !item.file.startsWith('_manager'))
        .filter(item => !only || only.some(key => item.file.includes(key)));

    if (entries.length === 0) {
        console.error('✗ 找不到可打包的 snippet，請先執行 node tools/build-devtools-inject.js --all');
        process.exitCode = 1;
        return;
    }

    const registry = entries.map(item => ({
        id: item.source,
        label: item.source.replace(/\.user\.js$/, ''),
        crossOrigin: item.crossOriginHosts.length > 0,
        code: fs.readFileSync(path.join(DIR, item.file), 'utf8')
    }));

    const header = `/* NTUH Snippet 管理器（自動產生，請勿手改）
 * 打包 ${registry.length} 支腳本；貼進 DevTools → Sources → Snippets 後 Ctrl+Enter 執行。
 * 面板可個別啟用／停用與批次執行，狀態存於 localStorage（依網域分開）。
 * 注意：snippet 無法自動啟動，每次頁面載入仍需手動執行本管理器一次。
 */
window.__NTUH_SNIPPET_REGISTRY__ = ${JSON.stringify(registry)};
`;
    const output = header + runtime;
    fs.writeFileSync(OUT_FILE, output, 'utf8');
    console.log(`${path.basename(OUT_FILE)}  ${(Buffer.byteLength(output) / 1024).toFixed(1)} KB（${registry.length} 支）`);
}

main();
