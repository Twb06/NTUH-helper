/* eslint-env node */
// 依 scripts/devtools-snippets/manifest.json 重新產生 README.md 內標記區塊的內容。
// 由 CI 於建置後自動執行；本機可用 `node tools/sync-readme-devtools.js` 預覽。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const MANIFEST = path.join(ROOT, 'scripts/devtools-snippets/manifest.json');
const START = '<!-- DEVTOOLS-SYNC:START -->';
const END = '<!-- DEVTOOLS-SYNC:END -->';

const blobBase = 'https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/';

function buildBlock(manifest) {
    const limited = manifest.filter(item => item.crossOriginHosts.length > 0);
    const totalKb = manifest.reduce((sum, item) => sum + item.sizeKb, 0).toFixed(1);
    const lines = [
        `> 以下內容由 CI 依 \`scripts/devtools-snippets/manifest.json\` 自動產生（共 ${manifest.length} 支、合計約 ${totalKb} KB），請勿手動編輯本區塊。`,
        '',
        '| 單檔 | 大小 | 跨來源限制 |',
        '|---|---|---|',
        ...manifest.map(item =>
            `| [\`${item.file}\`](${blobBase}${item.file}) | ${item.sizeKb} KB | ${item.crossOriginHosts.length ? '⚠ ' + item.crossOriginHosts.join(', ') : '—'} |`),
        ''
    ];
    if (limited.length > 0) {
        lines.push(
            `**在 DevTools 模式下會失去跨來源功能的腳本（${limited.length} 支）**：`,
            '',
            ...limited.map(item => `- \`${item.source.replace(/\.user\.js$/, '')}\`（跨來源網域：${item.crossOriginHosts.join(', ')}）`),
            '',
            '> 這些腳本在 DevTools 模式會跳過該部分功能並於畫面提示；若必須使用，請改用 Tampermonkey 模式。',
            ''
        );
    }
    return lines.join('\n');
}
function main() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const readme = fs.readFileSync(README, 'utf8');
    const start = readme.indexOf(START);
    const end = readme.indexOf(END);
    if (start === -1 || end === -1 || end < start) {
        console.error(`✗ README.md 缺少標記 ${START} / ${END}`);
        process.exitCode = 1;
        return;
    }
    const eol = readme.includes('\r\n') ? '\r\n' : '\n';
    const block = buildBlock(manifest).split('\n').join(eol);
    const updated = readme.slice(0, start + START.length) + eol + block + readme.slice(end);
    if (updated === readme) {
        console.log('README DevTools 區塊已是最新');
        return;
    }
    if (process.argv.includes('--check')) {
        console.error('✗ README DevTools 區塊與 manifest.json 不一致（請執行 node tools/sync-readme-devtools.js）');
        process.exitCode = 1;
        return;
    }
    fs.writeFileSync(README, updated, 'utf8');
    console.log(`README DevTools 區塊已更新（${manifest.length} 支腳本）`);
}

main();
