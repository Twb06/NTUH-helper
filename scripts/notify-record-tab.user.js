// ==UserScript==
// @name         NTUH 照會紀錄新分頁
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.0.2
// @description  QueryNotifyRecordByDr：指定照會連結改以新分頁開啟查詢結果；NotifyOtherDoctor：popup 按鈕改以新分頁開啟正確目標
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

    function parseDoPostBack(href) {
        const match = href.match(
            /__doPostBack\(\s*(['"])(.*?)\1\s*,\s*(['"])(.*?)\3\s*\)/
        );
        if (!match) return null;
        return { eventTarget: match[2], eventArgument: match[4] };
    }

    // ═══════════════════════════════════════════════════════════
    // QueryNotifyRecordByDr.aspx — 指定照會連結在新分頁開啟
    // ═══════════════════════════════════════════════════════════

    function initQueryNotifyRecord() {
        // 僅處理目前確認的兩個連結，避免攔截頁面上的其他 postback：
        //   NTUHWeb1_NotifyDrRecord_ctl02_SelectButton（查）
        //   NTUHWeb1_NotifyDrRecord_ctl02_lbtnReply（回）
        const LINK_SELECTOR = [
            '#NTUHWeb1_NotifyDrRecord_ctl02_SelectButton',
            '#NTUHWeb1_NotifyDrRecord_ctl02_lbtnReply',
        ].join(',');

        function handleSelectClick(event) {
            const link = /** @type {HTMLAnchorElement} */ (event.currentTarget);
            const args = parseDoPostBack(link.getAttribute('href') || '');
            if (!args) return;

            event.preventDefault();
            event.stopImmediatePropagation();

            const form = document.forms[0];
            if (!form) {
                console.warn(LOG, '找不到表單');
                return;
            }

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
                setTimeout(() => { form.target = prevTarget; }, 0);
            }
        }

        function patchLinks() {
            document.querySelectorAll(LINK_SELECTOR).forEach((link) => {
                if (link.dataset.ntuhNotifyTabPatched) return;
                link.dataset.ntuhNotifyTabPatched = '1';
                link.addEventListener('click', handleSelectClick, true);
                console.log(LOG, '已綁定指定照會連結', link.id || link.textContent.trim());
            });
        }

        function init() {
            patchLinks();

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
        const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const _originalOpen = pageWin.open.bind(pageWin);

        pageWin.open = function ntuhOpenInterceptor(url, name, features) {
            if (!url || url === '' || url === 'about:blank') {
                return _originalOpen(url, name, features);
            }
            console.log(LOG, 'window.open 攔截 →', url, '→ 新分頁');
            return _originalOpen(url, '_blank');
        };

        console.log(LOG, 'window.open 已覆寫');

        function patchButton(btn) {
            if (btn.dataset.ntuhNotifyDoctorPatched) return;
            btn.dataset.ntuhNotifyDoctorPatched = '1';

            btn.addEventListener('click', function (event) {
                console.log(LOG, '按下 popup 按鈕', btn.id);

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

            const observer = new MutationObserver(patchButtons);
            observer.observe(document.documentElement, { childList: true, subtree: true });
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init, { once: true });
        } else {
            init();
        }
    }

    if (/QueryNotifyRecordByDr\.aspx/i.test(PATH)) {
        initQueryNotifyRecord();
    } else if (/NotifyOtherDoctor\.aspx/i.test(PATH)) {
        initNotifyOtherDoctor();
    }
})();
