// ==UserScript==
// @name         NTUH 照會紀錄新分頁
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.0.0
// @description  QueryNotifyRecordByDr：點「查」改以新分頁開啟查詢結果；NotifyOtherDoctor：popup 按鈕改以新分頁開啟正確目標
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

    // ═══════════════════════════════════════════════════════════
    // 工具
    // ═══════════════════════════════════════════════════════════

    /**
     * 從 javascript:__doPostBack('target','arg') href 取出參數
     * @param {string} href
     * @returns {{ eventTarget: string, eventArgument: string } | null}
     */
    function parseDoPostBack(href) {
        const match = href.match(
            /__doPostBack\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3\s*\)/
        );
        if (!match) return null;
        return { eventTarget: match[2], eventArgument: match[4] };
    }

    // ═══════════════════════════════════════════════════════════
    // QueryNotifyRecordByDr.aspx — 點「查」在新分頁開啟查詢結果
    // ═══════════════════════════════════════════════════════════

    function initQueryNotifyRecord() {
        const LINK_SELECTOR = 'a[href*="__doPostBack"]';

        /**
         * 攔截「查」連結的 click：
         *  1. 阻止原始 href 執行
         *  2. 以一次性命名 context 開啟新分頁
         *  3. 將表單 target 指向該 context，執行 postback
         *  4. 立即還原 form.target，避免後續提交也被重導
         * @param {MouseEvent} event
         */
        function handleSelectClick(event) {
            const link = /** @type {HTMLAnchorElement} */ (event.currentTarget);
            const args = parseDoPostBack(link.getAttribute('href') || '');
            if (!args) return;

            // 阻止原始 javascript: href，防止雙重執行
            event.preventDefault();
            event.stopImmediatePropagation();

            const form = document.forms[0];
            if (!form) {
                console.warn(LOG, '找不到表單');
                return;
            }

            // 建立一次性命名 browsing context（新分頁），表單提交目標指向它
            const tabName = 'ntuh_consult_' + Date.now();
            window.open('about:blank', tabName);

            const prevTarget = form.getAttribute('target') || '';
            form.target = tabName;

            try {
                const pageDoPostBack = unsafeWindow.__doPostBack;
                if (typeof pageDoPostBack !== 'function') {
                    console.error(LOG, '__doPostBack 不存在');
                    return;
                }
                console.log(LOG, 'postback →', args.eventTarget, args.eventArgument, '→ tab:', tabName);
                pageDoPostBack(args.eventTarget, args.eventArgument);
            } catch (e) {
                console.error(LOG, 'postback 失敗', e);
            } finally {
                // form.submit() 雖然是同步呼叫，但瀏覽器在 call stack 清空後才執行導航，
                // 因此使用 setTimeout 延後還原 target，確保提交指向正確的 context
                setTimeout(() => { form.target = prevTarget; }, 0);
            }
        }

        /**
         * 為尚未綁定的「查」連結掛上 click 攔截
         */
        function patchLinks() {
            document.querySelectorAll(LINK_SELECTOR).forEach((link) => {
                if (link.dataset.ntuhNotifyTabPatched) return;
                link.dataset.ntuhNotifyTabPatched = '1';
                link.addEventListener('click', handleSelectClick, true);
                console.log(LOG, '已綁定連結', link.id || link.textContent.trim());
            });
        }

        function init() {
            patchLinks();

            // UpdatePanel / AJAX 更新後重新掃描
            const observer = new MutationObserver(patchLinks);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // NotifyOtherDoctor.aspx — popup 按鈕改以新分頁開啟目標
    // ═══════════════════════════════════════════════════════════

    /**
     * 這些按鈕的 onclick 會呼叫 WebForm_DoPostBackWithOptions；
     * 伺服器回應後，網站端本身呼叫 window.open(targetUrl, ...) 開啟 popup。
     * 作法：在 document-start 覆寫 unsafeWindow.open，
     *   將 popup 重導為新分頁（不改動 form.target，避免 postback 回應跑到錯誤 context）。
     *
     * 對每個按鈕另掛 click 攔截，確保原始 onclick 只執行一次，
     * 防止多重綁定或 UpdatePanel 重繪後重複觸發。
     */

    const POPUP_BUTTON_IDS = [
        'NTUHWeb1_btnPopupEMR',
        'NTUHWeb1_btnPopupProgressNote',
        'NTUHWeb1_btnPopupVitalSign',
        'NTUHWeb1_btnPopupAdmissionNote',
        'NTUHWeb1_btnPopupReport',
        'NTUHWeb1_btnPopupNursingHealthEducationNote',
        'NTUHWeb1_btnPopupPACS',
        'NTUHWeb1_btnBloodRecord',
        'NTUHWeb1_btnPopupNursingProgressNote',
        'NTUHWeb1_btnPopupStablePatientTransmission',
        'NTUHWeb1_btnPopupConsentForm',
    ];

    function initNotifyOtherDoctor() {
        // ── 1. 覆寫 window.open（在 document-start 最早時機執行）──────────
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const _originalOpen = pageWin.open.bind(pageWin);

        pageWin.open = function ntuhOpenInterceptor(url, name, features) {
            // 空白或 about:blank：保留原始行為（ASP.NET 可能用來建立 postback iframe）
            if (!url || url === '' || url === 'about:blank') {
                return _originalOpen(url, name, features);
            }
            // 其餘 popup 全改為新分頁
            console.log(LOG, 'window.open 攔截 →', url, '→ 新分頁');
            return _originalOpen(url, '_blank');
        };

        console.log(LOG, 'window.open 已覆寫');

        // ── 2. 防止 submit 按鈕被重複綁定 ─────────────────────────────────
        /**
         * 攔截 popup submit 按鈕，確保：
         *  - onclick（WebForm_DoPostBackWithOptions）只執行一次
         *  - button name/value 正確傳至伺服器（不直接呼叫 form.submit()）
         *  - 已覆寫的 window.open 會在伺服器回應後以新分頁開啟目標
         * @param {HTMLInputElement} btn
         */
        function patchButton(btn) {
            if (btn.dataset.ntuhNotifyDoctorPatched) return;
            btn.dataset.ntuhNotifyDoctorPatched = '1';

            btn.addEventListener('click', function (event) {
                // 若 onclick 已被 ASP.NET 設定，讓它正常執行（帶有 name/value）；
                // 不另外呼叫 form.submit()，避免遺失 submit button 資訊。
                // 僅記錄以便除錯。
                console.log(LOG, '按下 popup 按鈕', btn.id);

                // 若因 UpdatePanel 等原因按鈕沒有 onclick，給出警告
                if (!event.defaultPrevented && !btn.onclick && btn.form) {
                    console.warn(LOG, btn.id, '無 onclick，可能行為異常');
                }
            }, false);

            console.log(LOG, '已綁定按鈕', btn.id);
        }

        function patchButtons() {
            POPUP_BUTTON_IDS.forEach((id) => {
                const btn = document.getElementById(id);
                if (btn) patchButton(btn);
            });
        }

        function init() {
            patchButtons();

            // UpdatePanel / DOM 重繪後重新掃描
            const observer = new MutationObserver(patchButtons);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 依頁面路徑分派
    // ═══════════════════════════════════════════════════════════

    if (/QueryNotifyRecordByDr\.aspx/i.test(PATH)) {
        initQueryNotifyRecord();
    } else if (/NotifyOtherDoctor\.aspx/i.test(PATH)) {
        initNotifyOtherDoctor();
    }
})();
