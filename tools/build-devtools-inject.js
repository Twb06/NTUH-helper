/* eslint-env node */
// 產生「可直接貼進 DevTools」的單檔版本（不連任何外部網址、不依賴 Tampermonkey）。
//
// 用法：
//   node tools/build-devtools-inject.js                     # 只建 NTUH-diagcertificate-filler
//   node tools/build-devtools-inject.js scripts/foo.user.js # 指定單一腳本
//   node tools/build-devtools-inject.js --all               # 全部 scripts/*.user.js，並產生清單 README.md 與 manifest.json
const fs = require('node:fs');
const path = require('node:path');

const SCRIPTS_DIR = path.join(__dirname, '../scripts');
const OUT_DIR = path.join(SCRIPTS_DIR, 'devtools-snippets');
const SHIM_FILE = path.join(__dirname, 'devtools-shim.js');
const DEFAULT_SCRIPT = 'NTUH-diagcertificate-filler.user.js';

const banner = (name, notes) => `/* NTUH 診斷書助手工具箱 — DevTools 單檔版（自動產生，請勿手改）
 * 來源：scripts/${name}
 * 用法：於對應頁面開啟 DevTools → Sources → Snippets → 貼上本檔 → Ctrl+Enter
 * 特性：不載入外部資源、不需 Tampermonkey；GM_* 由相容層以 fetch／localStorage 實作。
 * 限制：跨來源 GM_xmlhttpRequest 會遭 CORS 阻擋${notes ? '\n * 注意：' + notes : ''}
 */
`;

const stripMetadata = source => source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');

// 只在腳本本身會做跨來源請求時提出警告（同院區網域不算）
function crossOriginHosts(source) {
    return [...source.matchAll(/@connect\s+(\S+)/g)].map(match => match[1])
        .filter(host => !/^(hchhisaw|hisaw|hchihisaw|ihisaw)\.ntuh\.gov\.tw$/.test(host));
}

function buildOne(fileName, shim) {
    const source = fs.readFileSync(path.join(SCRIPTS_DIR, fileName), 'utf8');
    const body = stripMetadata(source);
    const risky = [...new Set(crossOriginHosts(source))].sort();
    const usesGmRequest = /GM_xmlhttpRequest/.test(body);
    const notes = risky.length && usesGmRequest
        ? `本腳本會做跨來源 GM_xmlhttpRequest（${risky.join(', ')}），DevTools 模式下該功能會被 CORS 阻擋。`
        : '';
    const output = banner(fileName, notes) + shim + '\n' + body;
    const outName = fileName.replace(/\.user\.js$/, '') + '.devtools.js';
    fs.writeFileSync(path.join(OUT_DIR, outName), output, 'utf8');
    return { fileName, outName, sizeKb: (Buffer.byteLength(output) / 1024).toFixed(1), risky, usesGmRequest };
}

function main() {
    const args = process.argv.slice(2);
    const all = args.includes('--all');
    const explicit = args.find(arg => !arg.startsWith('--'));
    const shim = fs.readFileSync(SHIM_FILE, 'utf8');
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const files = all
        ? fs.readdirSync(SCRIPTS_DIR).filter(name => name.endsWith('.user.js')).sort()
        : [path.basename(explicit || DEFAULT_SCRIPT)];

    const results = files.map(fileName => {
        try {
            return buildOne(fileName, shim);
        } catch (error) {
            console.error(`✗ ${fileName}: ${error.message}`);
            return { fileName, error: error.message };
        }
    });

    // 供 README 同步與 snippet manager 使用的機器可讀清單
    const manifest = results.filter(result => !result.error).map(result => ({
        file: result.outName,
        source: result.fileName,
        sizeKb: Number(result.sizeKb),
        crossOriginHosts: result.risky.length && result.usesGmRequest ? result.risky : []
    }));
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    results.forEach(result => {
        if (result.error) return;
        const flag = result.risky.length && result.usesGmRequest ? '  ⚠ 跨來源限制' : '';
        console.log(`${result.outName}  ${result.sizeKb} KB${flag}`);
    });

    if (all) {
        const lines = [
            '# DevTools 單檔版（自動產生，請勿手改）',
            '',
            '本目錄由 CI 全自動產生：修改 `scripts/*.user.js` 並 push 後，Actions 會執行測試、重建全部單檔，並自動提交回本目錄。**請勿手動編輯本目錄任何檔案**（會被下一次 CI 覆蓋）。',
            '',
            '## 使用方式',
            '',
            '1. 在目標頁面按 **F12** 開啟 DevTools',
            '2. 切到 **Sources → Snippets**',
            '3. 按 **＋ New snippet**，命名後把對應 `*.devtools.js` 整個內容貼進去',
            '4. 之後在此頁面點擊該 snippet → **Ctrl + Enter** 執行',
            '',
            '單檔已內含 `GM_*` 相容層（localStorage 版本的值儲存、`window.open` 開分頁、`fetch` 版請求），因此不需安裝 Tampermonkey。',
            '',
            '## 各腳本狀態',
            '',
            '| 檔案 | 大小 | 跨來源 GM_xmlhttpRequest |',
            '|---|---|---|',
            ...results.filter(result => !result.error).map(result =>
                `| ${result.outName} | ${result.sizeKb} KB | ${result.risky.length && result.usesGmRequest ? '⚠ ' + result.risky.join(', ') : '—'} |`),
            '',
            '> **限制**：`GM_xmlhttpRequest` 以 `fetch` 實作，跨來源請求會被 CORS 阻擋；標示 ⚠ 的腳本在 DevTools 模式下該功能會失效（腳本應自行跳過並提示，不可靜默失敗）。',
            '> 表格中的網域取自腳本的 `@connect` 宣告，其中可能包含選用性資源（例如 PDF worker），該部分在 DevTools 模式同樣無法取得，但不影響主要流程。',
            '',
            '## 本地重建',
            '',
            '```bash',
            'node tools/test-diagcertificate.js             # 回歸測試',
            'node tools/build-devtools-inject.js --all      # 重建本目錄全部單檔',
            'node tools/build-devtools-inject.js scripts/foo.user.js   # 只建單一腳本',
            '```'
        ];
        fs.writeFileSync(path.join(OUT_DIR, 'README.md'), lines.join('\n') + '\n', 'utf8');
        console.log(`\n已寫入 ${path.join(OUT_DIR, 'README.md')}`);
    }
}

main();
