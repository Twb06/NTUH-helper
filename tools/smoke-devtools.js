/* eslint-env node */
// 以「無頭 Chrome + DevTools Protocol」實跑每支 DevTools 單檔，抓取載入期的例外與 console 錯誤。
// 零外部依賴（使用 Node 內建 fetch / WebSocket 與系統既有 Chrome／Edge）。
//
// 用法：
//   node tools/smoke-devtools.js
//   node tools/smoke-devtools.js --only diagcertificate
//   node tools/smoke-devtools.js --fixture tools/fixtures/mock-his.html
//   CHROME_PATH=/usr/bin/google-chrome node tools/smoke-devtools.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
};
const ONLY = opt('--only', '');
const FIXTURE = opt('--fixture', '');
const DIR = path.resolve(opt('--dir', path.join(ROOT, 'scripts/devtools-snippets')));
const TIMEOUT_MS = Number(opt('--timeout', '20000'));

// 判定為「框架／產物本身」的致命錯誤；其餘視為頁面情境差異（僅回報不判定失敗）
const FATAL_PATTERNS = [
    /GM_[A-Za-z]+ is not defined/,
    /__NTUH_DEVTOOLS_SHIM__/,
    /SyntaxError/,
    /Illegal invocation/,
    /is not a function$/,
    /Cannot read properties of undefined \(reading '(getItem|setItem|addEventListener)'\)/
];

const DEFAULT_FIXTURE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>NTUH mock</title></head>
<body><div id="NTUHWeb1_dgOpScheduleData"></div><div id="form1"></div></body></html>`;

function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        process.env.PUPPETEER_EXECUTABLE_PATH,
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
        'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    ].filter(Boolean);
    return candidates.find(candidate => fs.existsSync(candidate));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startServer(html) {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

async function launchChrome(binary, profileDir) {
    const child = spawn(binary, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--remote-allow-origins=*',
        '--remote-debugging-port=0',
        `--user-data-dir=${profileDir}`,
        'about:blank'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => reject(new Error('等待 Chrome 啟動逾時')), 30000);
        child.stderr.on('data', chunk => {
            buffer += chunk.toString();
            const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
            if (match) {
                clearTimeout(timer);
                resolve(match[1]);
            }
        });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`Chrome 結束（code ${code}）`)); });
    });
    return { child, wsUrl };
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = [];
        ws.addEventListener('message', event => {
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) reject(new Error(message.error.message));
                else resolve(message.result);
                return;
            }
            this.listeners.forEach(fn => fn(message));
        });
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            this.ws.send(JSON.stringify(payload));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`${method} 逾時`));
                }
            }, TIMEOUT_MS);
        });
    }

    on(fn) { this.listeners.push(fn); }
}

async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket 連線失敗')), { once: true });
    });
    return new Cdp(ws);
}

// 直接在 browser 端點建立並附加一個分頁，避免依賴 /json/list（headless 下不一定有既有 page target）
async function attachTarget(cdp) {
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
            const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
            return sessionId;
        } catch (error) {
            if (attempt === 19) throw error;
            await sleep(250);
        }
    }
    throw new Error('無法建立分頁');
}

function classify(messages) {
    const fatal = messages.filter(message => FATAL_PATTERNS.some(pattern => pattern.test(message)));
    return { fatal, other: messages.filter(message => !fatal.includes(message)) };
}

async function main() {
    if (!fs.existsSync(DIR)) {
        console.error(`✗ 找不到 ${DIR}，請先執行 node tools/build-devtools-inject.js --all`);
        process.exitCode = 1;
        return;
    }
    const binary = findChrome();
    if (!binary) {
        console.error('✗ 找不到 Chrome／Edge，請設定 CHROME_PATH 後重試');
        process.exitCode = 1;
        return;
    }

    const files = fs.readdirSync(DIR)
        .filter(name => name.endsWith('.devtools.js'))
        .filter(name => !ONLY || name.includes(ONLY))
        .sort();
    const fixtureHtml = FIXTURE ? fs.readFileSync(FIXTURE, 'utf8') : DEFAULT_FIXTURE;
    const fixtureLabel = FIXTURE ? path.relative(ROOT, FIXTURE) : '<內建 mock 頁面>';

    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntuh-smoke-'));
    const { server, port: httpPort } = await startServer(fixtureHtml);
    const { child, wsUrl } = await launchChrome(binary, profileDir);

    const results = [];
    try {
        const cdp = await connect(wsUrl);
        const session = await attachTarget(cdp);
        await cdp.send('Runtime.enable', {}, session);
        await cdp.send('Log.enable', {}, session);
        await cdp.send('Page.enable', {}, session);

        let collected = [];
        cdp.on(message => {
            if (message.method === 'Runtime.exceptionThrown') {
                const details = message.params.exceptionDetails;
                const text = details.exception?.description || details.text || 'unknown exception';
                collected.push(text.split('\n')[0]);
            }
            if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
                collected.push(message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
            }
            if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
                collected.push(message.params.entry.text);
            }
        });

        for (const name of files) {
            const source = fs.readFileSync(path.join(DIR, name), 'utf8');
            collected = [];
            await cdp.send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/mock` }, session);
            await sleep(300);
            let evaluateError = null;
            try {
                const outcome = await cdp.send('Runtime.evaluate', {
                    expression: source, awaitPromise: false, returnByValue: false, timeout: TIMEOUT_MS
                }, session);
                if (outcome.exceptionDetails) {
                    evaluateError = (outcome.exceptionDetails.exception?.description || outcome.exceptionDetails.text || 'unknown').split('\n')[0];
                }
            } catch (error) {
                evaluateError = error.message;
            }
            let shimOk = true;
            if (name.startsWith('_manager')) {
                const apiOk = await cdp.send('Runtime.evaluate', {
                    expression: '!!(window.__NTUH_SNIPPET_MANAGER__ && window.__NTUH_SNIPPET_MANAGER__.registry.length)',
                    returnByValue: true
                }, session).then(result => result.result?.value === true).catch(() => false);
                const panelOk = await cdp.send('Runtime.evaluate', {
                    expression: "!!document.getElementById('ntuh-snippet-manager')", returnByValue: true
                }, session).then(result => result.result?.value === true).catch(() => false);
                if (!apiOk) fatal.push('管理器 API 未匯出或 registry 為空');
                if (!panelOk) fatal.push('管理器面板未建立');
                // 實際跑一支打包腳本，確認相容層可被載入
                await cdp.send('Runtime.evaluate', {
                    expression: "(() => { const item = window.__NTUH_SNIPPET_MANAGER__.registry[0]; try { new Function(item.code)(); } catch (e) { } return item.label; })()",
                    returnByValue: true
                }, session).catch(() => { });
                shimOk = await cdp.send('Runtime.evaluate', {
                    expression: 'window.__NTUH_DEVTOOLS_SHIM__ === true', returnByValue: true
                }, session).then(result => result.result?.value === true).catch(() => false);
            } else {
                shimOk = await cdp.send('Runtime.evaluate', {
                    expression: 'window.__NTUH_DEVTOOLS_SHIM__ === true', returnByValue: true
                }, session).then(result => result.result?.value === true).catch(() => false);
            }

            const messages = [...new Set([...(evaluateError ? [evaluateError] : []), ...collected])];
            const { fatal, other } = classify(messages);
            if (!shimOk) fatal.push('相容層未載入（__NTUH_DEVTOOLS_SHIM__ 非 true）');
            results.push({ name, shimOk, fatal, other });
        }
    } finally {
        // 清理為best-effort：Windows 上 Chrome 可能尚未釋放 profile 目錄（EPERM），不可讓它影響結果
        try {
            try { child.kill(); } catch { /* ignore */ }
            server.close();
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 3000);
                child.once('exit', () => { clearTimeout(timer); resolve(); });
                if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
            });
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    fs.rmSync(profileDir, { recursive: true, force: true });
                    break;
                } catch {
                    await sleep(400);
                }
            }
        } catch (cleanupError) {
            console.warn(`（清理暫存 profile 失敗，可忽略：${cleanupError.message.split('\n')[0]}）`);
        }
    }

    const failed = results.filter(result => result.fatal.length > 0);
    console.log(`無頭 Chrome 實跑 ${results.length} 支單檔（fixture：${fixtureLabel}）\n`);
    results.forEach(result => {
        const bad = result.fatal.length > 0;
        console.log(`${bad ? '✗' : '✓'} ${result.name}${result.other.length ? `（頁面情境訊息 ${result.other.length} 則）` : ''}`);
        result.fatal.forEach(message => console.log(`    FATAL: ${message}`));
    });

    if (failed.length > 0) {
        console.log(`\n✗ ${failed.length} 支出現致命錯誤（框架／產物層級）`);
        process.exitCode = 1;
        return;
    }
    console.log('\n✓ 全部單檔載入期無框架層級錯誤');
}

main().catch(error => {
    console.error(`✗ 執行失敗：${error.message}`);
    process.exitCode = 1;
});
