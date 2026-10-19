/* eslint-env node */
// 靜態稽核 DevTools 單檔產物：語法、metadata、shim 覆蓋率、manifest／manager 一致性。
// 零外部依賴，可在本機或 CI 執行。
//
// 用法：
//   node tools/audit-snippets.js
//   node tools/audit-snippets.js --dir /tmp/out --src /tmp/src   # 稽核其他目錄（自我測試用）
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
};
const SNIPPET_DIR = path.resolve(opt('--dir', path.join(ROOT, 'scripts/devtools-snippets')));
const SRC_DIR = path.resolve(opt('--src', path.join(ROOT, 'scripts')));

const errors = [];
const warnings = [];
const fail = (file, message) => errors.push(`${file}: ${message}`);
const warn = (file, message) => warnings.push(`${file}: ${message}`);

// 僅計入程式碼（移除註解與字串常值中的雜訊，避免誤判）
const codeOnly = source => source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const files = () => fs.readdirSync(SNIPPET_DIR).filter(name => name.endsWith('.devtools.js'));

function shimImplementedApis() {
    const shim = fs.readFileSync(path.join(ROOT, 'tools/devtools-shim.js'), 'utf8');
    return new Set([...shim.matchAll(/\b(GM_[A-Za-z]+)\s*[:(]\s*(?:function|\()?/g)].map(m => m[1]));
}

function checkSnippet(name, implemented) {
    const source = fs.readFileSync(path.join(SNIPPET_DIR, name), 'utf8');
    const code = codeOnly(source);

    try {
        new vm.Script(source, { filename: name });
    } catch (error) {
        fail(name, `語法錯誤：${error.message}`);
        return;
    }

    if (/==UserScript==/.test(source)) fail(name, '殘留 UserScript metadata');
    if (/@require/.test(source)) fail(name, '殘留 @require');
    if (/https:\/\/(raw\.)?githubusercontent\.com\/[^\s"']+\.js/.test(source)) {
        warn(name, '內容含遠端腳本網址（應為單檔自足才對）');
    }

    const shimCount = (source.match(/__NTUH_DEVTOOLS_SHIM__/g) || []).length;
    if (shimCount === 0) fail(name, '缺少 GM_* 相容層');
    if (!/_manager\.devtools\.js$/.test(name) && shimCount > 2) warn(name, `相容層出現 ${shimCount} 次，疑似重複前置`);
    if (!/_manager\.devtools\.js$/.test(name) && !/^\/\* NTUH/.test(source)) warn(name, '缺少產物說明 banner');

    // GM API 覆蓋率：腳本用到但 shim 未實作的 API，會在 DevTools 模式直接 ReferenceError
    const used = new Set([...code.matchAll(/\b(GM_[A-Za-z]+)/g)].map(m => m[1]));
    used.delete('GM_info');
    const missing = [...used].filter(api => !implemented.has(api) && !new RegExp(`\\b${api}\\b[\\s\\S]{0,80}?(?:undefined|typeof)`).test(code));
    if (missing.length > 0) fail(name, `shim 未實作卻被使用：${missing.join(', ')}`);

    // 跨來源請求需自行降級，否則在 DevTools 模式會靜默失敗
    if (/GM_xmlhttpRequest/.test(code) && !/(undefined|typeof|__NTUH_DEVTOOLS_SHIM__|catch)/.test(code)) {
        warn(name, '使用 GM_xmlhttpRequest 但未見降級／例外處理');
    }
}

function checkManifest(names) {
    const file = path.join(SNIPPET_DIR, 'manifest.json');
    if (!fs.existsSync(file)) {
        fail('manifest.json', '缺少 manifest.json');
        return;
    }
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail('manifest.json', `無法解析：${error.message}`);
        return;
    }
    const listed = new Set(manifest.map(item => item.file));
    manifest.forEach(item => {
        const target = path.join(SNIPPET_DIR, item.file);
        if (!fs.existsSync(target)) {
            fail('manifest.json', `列出不存在的檔案：${item.file}`);
            return;
        }
        const actual = fs.statSync(target).size / 1024;
        if (Math.abs(actual - item.sizeKb) > Math.max(1, item.sizeKb * 0.05)) {
            fail('manifest.json', `${item.file} 大小不符（清單 ${item.sizeKb} KB / 實測 ${actual.toFixed(1)} KB）`);
        }
    });
    names.filter(name => !name.startsWith('_manager') && !listed.has(name))
        .forEach(name => fail('manifest.json', `漏列檔案：${name}`));
}

function checkManager() {
    const file = path.join(SNIPPET_DIR, '_manager.devtools.js');
    if (!fs.existsSync(file)) {
        warn('_manager.devtools.js', '尚未產生管理器');
        return;
    }
    const source = fs.readFileSync(file, 'utf8');
    const sandbox = {
        console: { log() { }, error() { }, warn() { } },
        document: {
            getElementById: () => null,
            createElement: () => ({
                style: {}, children: [], innerHTML: '', textContent: '', title: '', type: '', checked: false, value: '',
                appendChild(c) { this.children.push(c); return c; }, addEventListener() { }, querySelector() {
                    return { style: {}, textContent: '', addEventListener() { }, appendChild() { }, querySelector: () => null, innerHTML: '' };
                }, querySelectorAll: () => [], remove() { }
            }),
            body: { appendChild() { } },
            addEventListener() { }
        },
        localStorage: { getItem: () => null, setItem() { }, removeItem() { } },
        CustomEvent: class { }, Event: class { }, setTimeout: () => 0, clearTimeout() { },
        fetch: () => Promise.reject(new Error('offline')), TextDecoder, URL, URLSearchParams, JSON, Object, Array, Math
    };
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox);
    try {
        vm.runInContext(source, context, { filename: '_manager.devtools.js' });
    } catch (error) {
        fail('_manager.devtools.js', `執行時拋錯：${error.message}`);
        return;
    }
    const registry = sandbox.window.__NTUH_SNIPPET_REGISTRY__;
    if (!Array.isArray(registry) || registry.length === 0) {
        fail('_manager.devtools.js', 'registry 為空或無法解析');
        return;
    }
    const ids = new Set();
    registry.forEach(item => {
        if (!item.id || !item.label) fail('_manager.devtools.js', 'registry 條目缺少 id／label');
        if (ids.has(item.id)) fail('_manager.devtools.js', `registry id 重複：${item.id}`);
        ids.add(item.id);
        if (typeof item.code !== 'string' || item.code.length < 200) fail('_manager.devtools.js', `registry 條目程式碼異常：${item.id}`);
    });
    const expected = files().filter(name => !name.startsWith('_manager')).length;
    if (registry.length !== expected) {
        fail('_manager.devtools.js', `打包支數不符（registry ${registry.length} / 目錄 ${expected}）`);
    }
    if (!sandbox.window.__NTUH_SNIPPET_MANAGER__) fail('_manager.devtools.js', '未匯出管理器 API');
}

function main() {
    if (!fs.existsSync(SNIPPET_DIR)) {
        console.error(`✗ 找不到目錄 ${SNIPPET_DIR}，請先執行 node tools/build-devtools-inject.js --all`);
        process.exitCode = 1;
        return;
    }
    const implemented = shimImplementedApis();
    const names = files();
    names.forEach(name => checkSnippet(name, implemented));
    checkManifest(names);
    checkManager();

    console.log(`稽核 ${names.length} 支單檔（目錄：${path.relative(ROOT, SNIPPET_DIR) || '.'}）`);
    if (warnings.length > 0) {
        console.log(`\n⚠ 警告 ${warnings.length} 項（不影響建置）`);
        warnings.forEach(item => console.log('  - ' + item));
    }
    if (errors.length > 0) {
        console.log(`\n✗ 錯誤 ${errors.length} 項`);
        errors.forEach(item => console.log('  - ' + item));
        process.exitCode = 1;
        return;
    }
    console.log('\n✓ 靜態稽核全數通過');
}

main();
