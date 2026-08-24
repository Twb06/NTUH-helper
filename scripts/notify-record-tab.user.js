// ==UserScript==
// @name         NTUH 照會紀錄新分頁
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0
// @description  QueryNotifyRecordByDr / NotifyOtherDoctor：攔截 window.open，將照會目標頁改以新分頁開啟，避免額外彈窗或重複分頁
// @author       Twb06
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/QueryNotifyRecordByDr.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/notify-record-tab.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/notify-record-tab.user.js
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    /* global unsafeWindow */

    // ─── 根因說明 ─────────────────────────────────────────────
    //
    // QueryNotifyRecordByDr.aspx 上的「查」與「回」按鈕觸發
    // ASP.NET WebForms 的 __doPostBack；伺服器處理後，回應的
    // inline script 呼叫 window.open('NotifyOtherDoctor.aspx?...')
    // 以彈出視窗開啟照會頁面。
    //
    // 舊版修正錯誤地將 form.target 指向新分頁，導致：
    //   1. 新分頁載入與目前頁面一模一樣的 postback 回應（重複頁面）
    //   2. window.open 在新分頁 context 執行，不受舊覆寫影響
    //
    // 正確策略：
    //   - 完全不動 form.target，讓 postback 在目前分頁正常執行
    //   - 在 document-start 覆寫 window.open，讓所有照會目標
    //     URL（NotifyOtherDoctor.aspx?...）改以 _blank 新分頁開啟
    //   - 因為 @run-at document-start，覆寫在頁面任何 inline
    //     script 執行前即已生效，全頁 postback 後重載也一樣
    //
    // ────────────────────────────────────────────────────────

    const LOG = '[NotifyRecordTab]';

    // 需要攔截並改以新分頁開啟的 URL pattern（照會目標頁）
    const NOTIFY_URL_PATTERN = /NotifyOtherDoctor\.aspx/i;

    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const _originalOpen = pageWin.open.bind(pageWin);

    /**
     * 覆寫 window.open：
     *   - about:blank / 空字串 → 保留原行為（讓網站內部邏輯正常運作）
     *   - 符合 NOTIFY_URL_PATTERN 的 URL → 強制 _blank 新分頁
     *   - 其餘 URL → 保留原行為，不干預
     */
    pageWin.open = function ntuhNotifyOpenInterceptor(url, name, features) {
        if (!url || url === 'about:blank') {
            return _originalOpen(url, name, features);
        }
        if (NOTIFY_URL_PATTERN.test(url)) {
            console.log(LOG, 'window.open 攔截 →', url, '→ 新分頁');
            return _originalOpen(url, '_blank');
        }
        return _originalOpen(url, name, features);
    };

    console.log(LOG, 'window.open 覆寫完成（', pageWin.location.pathname, '）');
})();

// ─── 驗證方式 ─────────────────────────────────────────────────
//
// QueryNotifyRecordByDr.aspx — 「查」流程
//   1. 開啟 https://ihisaw.ntuh.gov.tw/.../QueryNotifyRecordByDr.aspx
//   2. 點擊任一列的「查」連結
//   3. 預期：目前頁面維持不動（或重整後仍停留在 QueryNotifyRecordByDr.aspx）
//            NotifyOtherDoctor.aspx?... 在新分頁開啟，不彈出視窗
//            不出現與目前頁面相同的重複分頁
//
// QueryNotifyRecordByDr.aspx — 「回」流程
//   1. 同上，點擊「回」連結
//   2. 預期：同「查」流程
//
// NotifyOtherDoctor.aspx — popup 按鈕
//   1. 在新開的照會頁點擊任一 popup 按鈕（如 EMR、進度記錄等）
//   2. 預期：目標頁在新分頁開啟，不彈出視窗
//
// 主控台驗證：
//   開啟 DevTools > Console，應可看到：
//   [NotifyRecordTab] window.open 覆寫完成 ( /WebApplication/InPatient/Ward/QueryNotifyRecordByDr.aspx )
//   點擊後應看到：
//   [NotifyRecordTab] window.open 攔截 → https://...NotifyOtherDoctor.aspx?... → 新分頁
// ─────────────────────────────────────────────────────────────
