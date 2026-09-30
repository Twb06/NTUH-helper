/* global copy */
// ═══════════════════════════════════════════════════════════════
// OuterData datatype 探測器（console 貼上執行）
// 目的：一次試完 OuterData.asmx 的全部 datatype，回報「有沒有資料、
//       多大、多快、長什麼樣」，用來判斷哪些 tab 模式來源可以改成 fetch。
//
// 用法：在「病程紀錄編輯頁」（InsertProgressNoteContent.aspx）開 F12 →
//       Console → 整段貼上 → Enter。跑完會自動 copy() 成 JSON 到剪貼簿。
//
// 注意：只做 GET 性質的讀取，不寫入任何病歷資料。
// ═══════════════════════════════════════════════════════════════
(async () => {
    'use strict';

    // 已知的 datatype 全集（LESSONS §4）。目前實際用到的只有 vitalsign / pacs / BSI。
    const DATATYPES = [
        'vitalsign', 'BSI', 'lab', 'ultrasonic',
        'pacs', 'antibiotic', 'pathology', 'notification',
    ];

    const MAX_CONCURRENT = 2;   // 對院內主機客氣一點，不要 8 個一起射
    const TIMEOUT_MS = 30000;   // lab 可能 ~4.5s，給寬一點

    // ⚠️ HIS 頁的 date.js 把 Date.now 覆寫成回傳 Date 物件（LESSONS §0 鐵則 1）
    const ms = () => new Date().getTime();

    // 取頁面參數：尾綴選取器，不受 ASP.NET naming container 前綴影響（LESSONS §3）
    const readIdSuffix = (suffix) => {
        for (const el of document.querySelectorAll(`[id$="${suffix}" i]`)) {
            const raw = el.value ?? el.getAttribute('value') ?? el.textContent ?? '';
            const v = String(raw).trim();
            if (v) return v;
        }
        return '';
    };
    const qGet = (name) => {
        const want = name.toLowerCase();
        for (const [k, v] of new URLSearchParams(location.search)) {
            if (k.toLowerCase() === want && v) return v;
        }
        return '';
    };

    const params = {
        AccountIdse: readIdSuffix('hidAccountNo') || qGet('AccountIDSE'),
        PersonId: readIdSuffix('hidPersonId') || qGet('PersonID'),
        ChartNo: readIdSuffix('hidChartNo') || qGet('ChartNo'),
        DeptCode: readIdSuffix('hidDeptCode'),
        EmpDeptCode: readIdSuffix('hidEmpDeptCode'),
    };

    console.log('%c[probe] 解析到的參數', 'color:#2c5f54;font-weight:bold', params);
    if (!params.AccountIdse) {
        console.error('[probe] 抓不到 AccountIdse — 請確認這頁是病程紀錄編輯頁且已選好病人');
        return;
    }

    const url = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
        + 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';
    console.log('[probe] 端點', url);

    // ── 單一 datatype 探測 ───────────────────────────────────
    async function probe(datatype) {
        const t0 = ms();
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({ jsonstring: JSON.stringify(params), datatype }),
                credentials: 'same-origin',
                signal: ctrl.signal,
            });
            const elapsed = ms() - t0;
            if (!res.ok) return { datatype, ok: false, elapsed, error: 'HTTP ' + res.status };

            const rawText = await res.text();
            let html = '';
            let unwrapErr = null;
            try {
                // ASMX 雙層外殼：{"d":"{\"Html\":\"<table>…\"}"}
                const j = JSON.parse(rawText);
                const inner = typeof j.d === 'string' ? JSON.parse(j.d) : j.d;
                html = (inner && inner.Html) || '';
                // 只在「真的沒有 Html 這個 key」時才警告；Html 存在但空字串＝這病人沒這類資料，正常
                if (inner && typeof inner === 'object' && !('Html' in inner)) {
                    unwrapErr = '回傳物件沒有 Html 欄位，keys=' + Object.keys(inner).join(',');
                }
            } catch (e) {
                unwrapErr = '剝殼失敗：' + e.message;
            }

            const doc = new DOMParser().parseFromString(html || '', 'text/html');
            const tables = [...doc.querySelectorAll('table')];
            const rowCounts = tables.map((t) => t.rows.length);
            const text = (doc.body.innerText || doc.body.textContent || '')
                .replace(/\s+/g, ' ').trim();

            return {
                datatype,
                ok: true,
                elapsed,
                rawBytes: rawText.length,
                htmlBytes: html.length,
                tableCount: tables.length,
                rowCounts,
                hasData: text.length > 0,
                // 前 400 字就夠判斷「這是不是我要的東西」
                textSample: text.slice(0, 400),
                htmlSample: (html || '').slice(0, 300),
                unwrapErr,
            };
        } catch (e) {
            return {
                datatype, ok: false, elapsed: ms() - t0,
                error: e.name === 'AbortError' ? `逾時 (>${TIMEOUT_MS}ms)` : (e.message || String(e)),
            };
        } finally {
            clearTimeout(timer);
        }
    }

    // ── 併發閘門：同時最多 MAX_CONCURRENT 個 ──────────────────
    const results = [];
    const queue = [...DATATYPES];
    await Promise.all(
        Array.from({ length: MAX_CONCURRENT }, async () => {
            while (queue.length) {
                const dt = queue.shift();
                console.log('[probe] 探測中…', dt);
                results.push(await probe(dt));
            }
        }),
    );
    results.sort((a, b) => DATATYPES.indexOf(a.datatype) - DATATYPES.indexOf(b.datatype));

    // ── 摘要表 ───────────────────────────────────────────────
    console.log('%c[probe] 結果摘要', 'color:#2c5f54;font-weight:bold;font-size:14px');
    console.table(results.map((r) => ({
        datatype: r.datatype,
        狀態: r.ok ? (r.hasData ? '✅ 有資料' : '⚪ 空') : '❌ ' + r.error,
        毫秒: r.elapsed,
        HTML大小: r.htmlBytes ?? '',
        表數: r.tableCount ?? '',
        列數: Array.isArray(r.rowCounts) ? r.rowCounts.join('/') : '',
    })));

    results.forEach((r) => {
        if (r.ok && r.hasData) {
            console.log(`%c── ${r.datatype} ──`, 'color:#b0692a;font-weight:bold');
            console.log(r.textSample);
        }
        if (r.unwrapErr) console.warn(`[probe] ${r.datatype} 剝殼警告：`, r.unwrapErr);
    });

    const json = JSON.stringify(results, null, 2);
    window.__outerDataProbe = results;
    try { copy(json); console.log('%c[probe] 完整結果已複製到剪貼簿（也在 window.__outerDataProbe）', 'color:#2f7d55;font-weight:bold'); }
    catch { console.log('[probe] 自動複製失敗，請手動複製 window.__outerDataProbe'); }
})();
