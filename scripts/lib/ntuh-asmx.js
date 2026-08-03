// ==============================================================
// NTUH ASMX Client — 共用的後端呼叫層
// --------------------------------------------------------------
// 把散在各 script 裡重複的四件事收成一支：
//   1. 剝 ASP.NET ASMX 的 { "d": "<JSON 字串>" } 雙層外殼
//   2. 逾時保護（AbortController）
//   3. 併發閘門（同時最多 N 個請求在飛，其餘排隊）
//   4. 進行中請求去重（同一份資料同時被要兩次 → 只送一次）
//
// 用法（Tampermonkey）：在 userscript 標頭加一行
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// 之後就能用全域的 window.NTUHAsmx。
//
// 注意：@require 的檔案會被 Tampermonkey 快取，改了這支之後，
//       要在 Tampermonkey 設定裡「外部資源」手動更新，或在網址後
//       加 ?v=2 之類的版本號強制重抓。
// ==============================================================

(function () {
    'use strict';

    // 已經載入過就不要重複覆蓋（多支 script 同時 @require 時會發生）
    if (window.NTUHAsmx) return;

    const VERSION = '1.0.0';

    const config = {
        maxConcurrent: 3,      // 同時最多幾個請求在飛
        timeoutMs: 12000,      // 單一請求逾時
        credentials: 'same-origin',
    };

    // ═══════════════════════════════════════════════════════════
    // 併發閘門
    // ═══════════════════════════════════════════════════════════
    // 為什麼需要：人操作網頁一分鐘點十下，程式可以一秒送三百個。
    // 批次抓 30 個病人時，沒有這道閘就是 30 個請求同時砸向院內主機。

    let activeCount = 0;
    const waitQueue = [];

    async function withSlot(task) {
        if (activeCount >= config.maxConcurrent) {
            // 先排隊：把「放行的開關」丟進佇列，等別人做完來按
            await new Promise((release) => waitQueue.push(release));
        }
        activeCount += 1;
        try {
            return await task();
        } finally {
            activeCount -= 1;
            const next = waitQueue.shift();
            if (next) next();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // ASMX 外殼剝除
    // ═══════════════════════════════════════════════════════════
    // ASP.NET 的 .asmx 回傳固定包一層 { "d": ... }，而且 d 常常
    // 是「JSON 字串」而不是物件，所以要 parse 第二次。
    // 例：{"d":"{\"Html\":\"<table>...\"}"}  →  { Html: "<table>..." }

    function unwrap(payload) {
        let value = payload;

        if (value && typeof value === 'object' && !Array.isArray(value) && 'd' in value) {
            value = value.d;
        }

        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            } catch {
                // 不是 JSON 就當純字串用，不要讓整個請求爆掉
            }
        }

        return value;
    }

    // ═══════════════════════════════════════════════════════════
    // 核心：呼叫一個 ASMX 方法
    // ═══════════════════════════════════════════════════════════

    /**
     * @param {object}  opts
     * @param {string}  opts.url        完整端點網址
     * @param {object}  opts.body       請求 body（會被 JSON.stringify）
     * @param {string} [opts.dedupeKey] 相同 key 的進行中請求會共用同一個 Promise
     * @param {number} [opts.cacheMs]   結果快取毫秒數（預設 0 = 不快取結果，只去重）
     * @param {number} [opts.timeoutMs]
     * @returns {Promise<any>} 已剝殼的回傳值
     */
    function call(opts) {
        const { url, body, dedupeKey, cacheMs = 0 } = opts;
        const timeoutMs = opts.timeoutMs ?? config.timeoutMs;
        const key = dedupeKey || `${url}::${JSON.stringify(body)}`;

        // (a) 結果快取還新鮮 → 直接給
        const cached = resultCache.get(key);
        if (cached && Date.now() - cached.at < cached.ttl) {
            return Promise.resolve(cached.value);
        }

        // (b) 已經有一個同樣的請求在飛 → 一起等它，不要再送一次
        //     注意這裡存的是「Promise 本身」而不是結果，這是去重的關鍵
        const inFlight = pending.get(key);
        if (inFlight) return inFlight;

        const promise = withSlot(async () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'X-Requested-With': 'XMLHttpRequest',
                    },
                    body: JSON.stringify(body),
                    credentials: config.credentials,
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
                return unwrap(await res.json());
            } finally {
                clearTimeout(timer);
            }
        })
            .then((value) => {
                if (cacheMs > 0) resultCache.set(key, { value, at: Date.now(), ttl: cacheMs });
                return value;
            })
            .finally(() => {
                pending.delete(key);
            });

        pending.set(key, promise);
        return promise;
    }

    const pending = new Map();      // 進行中的請求：key → Promise
    const resultCache = new Map();  // 已完成的結果：key → { value, at, ttl }

    function clearCache() {
        resultCache.clear();
    }

    // ═══════════════════════════════════════════════════════════
    // Progress Note 頁面的病人 context
    // ═══════════════════════════════════════════════════════════
    // 原本在 progress-note-data-helper 和 weekend-progress 各有一份
    // 一模一樣的實作，收斂到這裡。
    // 取值順序：頁面隱藏欄位 → 網址參數 → 空字串

    function progressNoteContext() {
        const v = (id) => document.getElementById(id)?.value || '';
        const q = new URLSearchParams(window.location.search);
        return {
            AccountIdse: v('hidAccountNo') || q.get('AccountIDSE') || '',
            PersonId: v('hidPersonId') || q.get('PersonID') || '',
            ChartNo: v('hidChartNo') || '',
            DeptCode: v('hidDeptCode') || '',
            EmpDeptCode: v('hidEmpDeptCode') || '',
        };
    }

    // 由當前頁網址推出同目錄下的 service 路徑
    // 例：.../Ward/InsertProgressNoteContent.aspx?x=1
    //  →  .../Ward/ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable
    function serviceUrl(relativePath) {
        const base = window.location.href
            .replace(/[?#].*$/, '')
            .replace(/[^/]*$/, '');
        return base + relativePath;
    }

    // ═══════════════════════════════════════════════════════════
    // 便利包裝：OuterData
    // ═══════════════════════════════════════════════════════════

    const OUTER_DATA_PATH = 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';

    /**
     * 抓 OuterData 的某個 datatype，回傳其中的 Html 字串。
     * 行為與原本各 script 內的 fetchOuterData 相同。
     * @param {string} datatype 例：'BSI'、'vitalsign'
     * @param {object} [options] { cacheMs, context }
     * @returns {Promise<string>} Html（失敗或無資料回空字串）
     */
    async function outerData(datatype, options = {}) {
        const context = options.context || progressNoteContext();
        const value = await call({
            url: serviceUrl(OUTER_DATA_PATH),
            body: {
                jsonstring: JSON.stringify(context),
                datatype,
            },
            dedupeKey: `outerdata::${datatype}::${context.AccountIdse}`,
            cacheMs: options.cacheMs ?? 0,
            timeoutMs: options.timeoutMs,
        });
        return (value && value.Html) || '';
    }

    /** 把 OuterData 回來的 Html 字串解析成 document，供後續 querySelector */
    function parseHtml(html) {
        return new DOMParser().parseFromString(html || '', 'text/html');
    }

    // ═══════════════════════════════════════════════════════════

    window.NTUHAsmx = {
        VERSION,
        config,
        call,
        unwrap,
        outerData,
        parseHtml,
        progressNoteContext,
        serviceUrl,
        clearCache,
    };
})();
