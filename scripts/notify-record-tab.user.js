// ==UserScript==
// @name         NTUH 照會紀錄新分頁
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.2
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

    const LOG = '[NotifyRecordTab]';
    const PATH = window.location.pathname;
    const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const isQueryNotifyRecordPage = /QueryNotifyRecordByDr\.aspx/i.test(PATH);
    const isNotifyOtherDoctorPage = /NotifyOtherDoctor\.aspx/i.test(PATH);

    if (!isQueryNotifyRecordPage && !isNotifyOtherDoctorPage) {
        return;
    }

    const _originalOpen = pageWin.open.bind(pageWin);

    /**
     * QueryNotifyRecordByDr 的 postback 可能開啟 NotifyOtherDoctor，
     * NotifyOtherDoctor 的 popup 按鈕則可能開啟 EMR、病程、檢驗等不同頁面，
     * 因此兩頁都攔截所有非空白 URL，而不是只比對單一目標頁。
     *
     *   - 完全不動 form.target，讓 postback 在目前分頁正常執行
     *   - 在兩個頁面都於 document-start 覆寫 window.open，讓網站 popup
     *     的非空白目標改以 _blank 新分頁開啟
     *   - 因為 @run-at document-start，覆寫在頁面任何 inline
     *     script 執行前即已生效，全頁 postback 後重載也一樣
     *   - about:blank / 空字串 → 保留原行為（網站內部建立暫時視窗時需要）
     *   - 其餘 URL → 強制 _blank 新分頁
     */
    pageWin.open = function ntuhNotifyOpenInterceptor(url, name, features) {
        if (!url || url === 'about:blank') {
            return _originalOpen(url, name, features);
        }
        console.log(LOG, 'window.open 攔截 →', url, '→ 新分頁');
        return _originalOpen(url, '_blank');
    };

    console.log(LOG, 'window.open 覆寫完成（', PATH, '）');
})();
