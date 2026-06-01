// ==UserScript==
// @name         NTUH 手術排程自動化
// @namespace    https://ihisaw.ntuh.gov.tw/
// @version      1.1.1
// @description  批次執行術前評估、當日評估、同意書綁定
// @author       YT
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/SimpleQueryOpSchedule_New.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/PreOperativeAssessment_New.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/DayOperativeAssessment.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentBinding.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentFormManagement.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/op-automation.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/op-automation.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* global Sys, $ */

    const PATH = window.location.pathname;

    // ═══════════════════════════════════════════════════════════
    // 共用工具
    // ═══════════════════════════════════════════════════════════

    const hasOpener = window.opener && (() => {
        try { return window.opener.location.origin === window.location.origin; }
        catch (e) { return false; }
    })();

    // 只有 URL 帶有 ntuh_token 參數，且 opener 確實是 orchestrator 頁面，才視為 orchestrator 開啟的視窗
    // 這樣手動開啟或 Portal 自己開的 popup 都不會被自動執行
    const ntuhToken = new URLSearchParams(window.location.search).get('ntuh_token');
    const isOrchestratorWindow = hasOpener && !!ntuhToken && (() => {
        try { return window.opener.location.href.includes('SimpleQueryOpSchedule_New'); }
        catch (e) { return false; }
    })();

    function clickRadio(el) {
        if (!el) return;
        el.checked = true;
        if (el.onclick) el.onclick();
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('click',  { bubbles: true }));
    }

    function waitForPostback(fn) {
        if (window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
            const prm = Sys.WebForms.PageRequestManager.getInstance();
            const handler = function () {
                prm.remove_endRequest(handler);
                setTimeout(fn, 300);
            };
            prm.add_endRequest(handler);
        } else {
            setTimeout(fn, 800);
        }
    }

    // 子視窗回傳：夾帶 token，讓主頁驗證是自己開的視窗
    function notify(msg) {
        if (!hasOpener) return;
        const token = sessionStorage.getItem('ntuh_window_token') || '';
        window.opener.postMessage({ ntuh: true, msg, token }, window.location.origin);
    }

    function makeFAB({ label, color, hoverColor, onClick }) {
        const fab = document.createElement('button');
        fab.innerText = label;
        Object.assign(fab.style, {
            position: 'fixed', bottom: '30px', right: '30px', zIndex: '99999',
            padding: '12px 20px', background: color, color: '#fff',
            border: 'none', borderRadius: '8px', fontSize: '15px',
            fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        });
        fab.addEventListener('mouseenter', () => { if (!fab.disabled) fab.style.background = hoverColor; });
        fab.addEventListener('mouseleave', () => { if (!fab.disabled) fab.style.background = color; });
        fab.addEventListener('click', () => {
            fab.disabled = true;
            fab.innerText = '⏳ 執行中...';
            fab.style.background = '#6c757d';
            onClick(fab);
        });
        document.body.appendChild(fab);
        return fab;
    }

    // ═══════════════════════════════════════════════════════════
    // 模組路由
    // ═══════════════════════════════════════════════════════════

    function init() {
        if (PATH.includes('SimpleQueryOpSchedule_New'))    return moduleOrchestrator();
        if (PATH.includes('PreOperativeAssessment_New'))   return modulePreop();
        if (PATH.includes('DayOperativeAssessment'))       return moduleDay();
        if (PATH.includes('ConsentBinding') ||
            PATH.includes('ConsentFormManagement'))        return moduleConsent();
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE A：主頁 Orchestrator
    // ═══════════════════════════════════════════════════════════

    function moduleOrchestrator() {

        // 產生唯一 token（每次開子視窗前產生，傳入子視窗的 sessionStorage）
        function genToken() {
            return `ntuh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        }

        // 開子視窗，等待夾帶正確 token 的 postMessage
        function openAndWait(url, acceptedMsgs) {
            return new Promise((resolve) => {
                const msgs  = Array.isArray(acceptedMsgs) ? acceptedMsgs : [acceptedMsgs];
                const token = genToken();

                // 把 token 寫入 sessionStorage，子視窗同源可讀到
                // 但 sessionStorage 不跨視窗，改用 URL hash 傳遞
                const urlWithToken = url + (url.includes('?') ? '&' : '?') + `ntuh_token=${token}`;
                const win = window.open(urlWithToken, '_blank',
                    'width=1200,height=800,top=0,left=0,toolbar=no,resizable=yes,scrollbars=yes');

                function onMessage(event) {
                    if (event.origin !== window.location.origin) return;
                    // 必須是 ntuh 腳本送出的訊息（有 ntuh 標記）
                    if (!event.data?.ntuh) return;
                    // token 必須吻合（驗證是自己開的視窗）
                    if (event.data.token !== token) return;
                    // 訊息內容必須在預期清單內
                    if (!msgs.includes(event.data.msg)) return;

                    window.removeEventListener('message', onMessage);
                    try { win.close(); } catch (e) {}
                    resolve(event.data.msg);
                }
                window.addEventListener('message', onMessage);

                // 60 秒逾時保護
                setTimeout(() => {
                    window.removeEventListener('message', onMessage);
                    try { win.close(); } catch (e) {}
                    resolve('timeout');
                }, 60000);
            });
        }

        function getNewPageUrl(pageId, opScheduleIdse) {
            return new Promise((resolve, reject) => {
                const QueryObj = {
                    Session:        document.getElementById('lblPageInfo').getAttribute('SESSION'),
                    HospCode:       document.getElementById('lblPageInfo').getAttribute('HOSPCODE'),
                    EmpNo:          document.getElementById('lblPageInfo').getAttribute('EMPNO'),
                    PageId:         pageId,
                    RoleName:       (document.querySelector('input[name=rdoRoleGroupName]:checked') || {}).value || '',
                    OpScheduleIdse: opScheduleIdse
                };
                $.ajax({
                    url: 'handler/OpCommonHandler.ashx?Mode=GetNewPageUrl',
                    data: encodeURIComponent(JSON.stringify(QueryObj)),
                    type: 'post', contentType: 'application/json; charset=utf-8', dataType: 'json',
                    success: function (result) {
                        if (result.IsSuccess) resolve(result.SuccessMessage.split('|')[0]);
                        else reject(result.ErrorMessage);
                    },
                    error: reject
                });
            });
        }

        function isPreopDone(row) {
            const btn = row.querySelector('span[onclick*="PreOperativeAssessment_New"]');
            if (!btn) return false;
            // btn-success / btn-done = 已確認送出，跳過
            // btn-warning / btn-temp = 暫存，還是要進去按儲存
            return btn.classList.contains('btn-success') || btn.classList.contains('btn-done');
        }
        function isDayDone(row) {
            const btn = row.querySelector('span[onclick*="DayOperativeAssessment"]');
            if (!btn) return false;
            return btn.classList.contains('btn-success') || btn.classList.contains('btn-done') ||
                   btn.classList.contains('btn-warning') || btn.classList.contains('btn-temp');
        }
        function isConsentDone(row) {
            const btn = row.querySelector('span[onclick*="ConsentBinding"]');
            if (!btn) return false;
            return btn.classList.contains('btn-success') || btn.classList.contains('btn-done');
        }

        const PREOP_LABEL = {
            'ntuh_preop_done': '✓', 'timeout': '逾時',
        };
        const DAY_LABEL = {
            'ntuh_day_done': '✓', 'ntuh_day_notyet': '未達當日', 'timeout': '逾時',
        };
        const CONSENT_LABEL = {
            'ntuh_consent_done': '✓', 'ntuh_consent_already': '已全部綁定',
            'ntuh_consent_none': '查無同意書', 'ntuh_consent_fail': '失敗', 'timeout': '逾時',
        };

        async function processOnePatient(row, statusEl) {
            const opIdse = row.getAttribute('opscheduleidse');
            if (!opIdse) return null;

            const patName = (row.querySelector('td:nth-child(8) span') || {}).innerText?.trim() || opIdse;
            statusEl.innerText = `處理中：${patName}`;
            const result = { name: patName, preop: '', day: '', consent: '' };

            if (isPreopDone(row)) {
                result.preop = '已完成';
            } else {
                try {
                    const url = await getNewPageUrl('PreOperativeAssessment_New', opIdse);
                    const msg = await openAndWait(url, ['ntuh_preop_done', 'timeout']);
                    result.preop = PREOP_LABEL[msg] || msg;
                } catch (e) { result.preop = '失敗'; }
            }

            if (isDayDone(row)) {
                result.day = '已完成';
            } else {
                try {
                    const url = await getNewPageUrl('DayOperativeAssessment', opIdse);
                    const msg = await openAndWait(url, ['ntuh_day_done', 'ntuh_day_notyet', 'timeout']);
                    result.day = DAY_LABEL[msg] || msg;
                } catch (e) { result.day = '失敗'; }
            }

            if (isConsentDone(row)) {
                result.consent = '已綁定';
            } else {
                try {
                    const url = await getNewPageUrl('ConsentBinding', opIdse);
                    const msg = await openAndWait(url, [
                        'ntuh_consent_done', 'ntuh_consent_already',
                        'ntuh_consent_none', 'ntuh_consent_fail', 'timeout'
                    ]);
                    result.consent = CONSENT_LABEL[msg] || msg;
                } catch (e) { result.consent = '失敗'; }
            }

            statusEl.innerText = `完成：${patName}`;
            return result;
        }

        async function runAll(fab, statusEl) {
            const rows = Array.from(
                document.querySelectorAll('#tbBodyOpSchedule tr[opscheduleidse]')
            ).filter(row => !row.classList.contains('disabled'));

            if (rows.length === 0) {
                fab.innerText = '⚠️ 查無病人資料';
                fab.style.background = '#fd7e14';
                statusEl.innerText = '請先執行查詢';
                return;
            }

            const summary = [];
            for (let i = 0; i < rows.length; i++) {
                statusEl.innerText = `第 ${i + 1} / ${rows.length} 位...`;
                const result = await processOnePatient(rows[i], statusEl);
                if (result) summary.push(result);
                await new Promise(r => setTimeout(r, 500));
            }

            fab.innerText = `✅ 全部完成（${rows.length} 位）`;
            fab.style.background = '#198754';
            statusEl.innerText = `全部 ${rows.length} 位處理完畢`;

            const lines = summary.map(r =>
                `${r.name}　估（${r.preop}）、當（${r.day}）、同（${r.consent}）`
            );
            alert('═══ 批次執行結果 ═══\n\n' + lines.join('\n'));
        }

        const statusEl = document.createElement('div');
        Object.assign(statusEl.style, {
            position: 'fixed', bottom: '90px', right: '30px', zIndex: '99999',
            background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '6px 12px',
            borderRadius: '6px', fontSize: '13px', maxWidth: '260px', display: 'none',
        });
        document.body.appendChild(statusEl);

        makeFAB({
            label: '⚡ 批次執行 估・當・同',
            color: '#dc3545', hoverColor: '#b02a37',
            onClick: (fab) => { statusEl.style.display = 'block'; runAll(fab, statusEl); }
        });
    }

    // ═══════════════════════════════════════════════════════════
    // 子視窗共用：從 URL 讀取主頁塞入的 token，存入 sessionStorage
    // ═══════════════════════════════════════════════════════════

    function loadTokenFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const token  = params.get('ntuh_token');
        if (token) sessionStorage.setItem('ntuh_window_token', token);
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE B：術前評估
    // ═══════════════════════════════════════════════════════════

    function modulePreop() {
        loadTokenFromUrl();

        function isAlreadyDone() {
            const info = document.getElementById('NTUHWeb1_LastTimePreAssessConfirmInfo');
            return info && info.innerText.trim() !== '';
        }

        function step1() {
            if (isAlreadyDone()) { notify('ntuh_preop_done'); return; }
            const radio = document.getElementById('NTUHWeb1_SubPhysicalExam_NormalRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step2); }
            else step2();
        }
        function step2() {
            const radio = document.getElementById('NTUHWeb1_rbl_subbleeding_0');
            if (radio && !radio.checked) clickRadio(radio);
            step3();
        }
        function step3() {
            const hasRadio  = document.getElementById('NTUHWeb1_SubOperationHistory_HasRadio');
            const noneRadio = document.getElementById('NTUHWeb1_SubOperationHistory_NoneRadio');
            const textarea  = document.getElementById('NTUHWeb1_SubOperationHistory_DescriptionTextBox');
            const hasData   = hasRadio?.checked && textarea?.value.trim() !== '';
            if (hasData) { step4(); return; }
            if (noneRadio && !noneRadio.checked) { clickRadio(noneRadio); waitForPostback(step4); }
            else step4();
        }
        function step4() {
            const radio = document.getElementById('NTUHWeb1_SubBloodTransHistory_NoneRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step5); }
            else step5();
        }
        function step5() {
            const radio = document.getElementById('NTUHWeb1_SubBloodReaction_NoneRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step6); }
            else step6();
        }
        function step6() {
            const radio = document.getElementById('NTUHWeb1_NoNeedBloodTransRadio');
            if (radio && !radio.checked) clickRadio(radio);
            step7();
        }
        function step7() {
            const radio = document.getElementById('NTUHWeb1_SubPrepareBloodAmount_NoneRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step8); }
            else step8();
        }
        function step8() {
            const radio = document.getElementById('NTUHWeb1_rdblExpectedBloodLoss_0');
            if (radio && !radio.checked) clickRadio(radio);
            step9();
        }
        function step9() {
            const radio = document.getElementById('NTUHWeb1_SubSpecialInstruction_NoneRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step10); }
            else step10();
        }
        function step10() {
            const diagText = document.getElementById('NTUHWeb1_LabelPreOPDiagnosis')?.innerText.trim() || '';
            const cb = document.getElementById('NTUHWeb1_CheckBoxOther');
            if (cb && !cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
            const tb = document.getElementById('NTUHWeb1_TextBoxOther');
            if (tb) { tb.value = diagText; tb.dispatchEvent(new Event('input', { bubbles: true })); }
            step11();
        }
        function step11() {
            const btn = document.getElementById('NTUHWeb1_ConfirmAssessment');
            if (!btn) { notify('ntuh_preop_done'); return; }
            if (isOrchestratorWindow) sessionStorage.setItem('ntuh_preop_submitted', '1');
            btn.click();
        }

        function checkAfterReload() {
            if (!isOrchestratorWindow) return;
            if (sessionStorage.getItem('ntuh_preop_submitted') === '1') {
                sessionStorage.removeItem('ntuh_preop_submitted');
                setTimeout(() => notify('ntuh_preop_done'), 500);
            }
        }

        checkAfterReload();
        if (isOrchestratorWindow && !sessionStorage.getItem('ntuh_preop_submitted')) {
            setTimeout(step1, 800);
        } else if (!isOrchestratorWindow) {
            makeFAB({ label: '⚡ 自動填寫術前評估', color: '#0d6efd', hoverColor: '#0b5ed7',
                onClick: () => step1() });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE C：當日評估
    // ═══════════════════════════════════════════════════════════

    function moduleDay() {
        loadTokenFromUrl();

        function isAlreadyDone() {
            const info = document.getElementById('NTUHWeb1_LastTimeDayAssessConfirmInfo');
            return info && info.innerText.trim() !== '';
        }

        function step1() {
            if (isAlreadyDone()) { notify('ntuh_day_done'); return; }
            const radio = document.getElementById('NTUHWeb1_SubAbnormalCondition_NoneRadio');
            if (radio && !radio.checked) { clickRadio(radio); waitForPostback(step2); }
            else step2();
        }
        function step2() {
            const radio = document.getElementById('NTUHWeb1_NormalRadio');
            if (radio && !radio.checked) clickRadio(radio);
            step3();
        }
        function step3() {
            const btn = document.getElementById('NTUHWeb1_ConfirmOPDateAssessment');
            if (!btn) { notify('ntuh_day_done'); return; }
            if (btn.disabled) { notify('ntuh_day_notyet'); return; }
            if (isOrchestratorWindow) sessionStorage.setItem('ntuh_day_submitted', '1');
            btn.click();
        }

        function checkAfterReload() {
            if (!isOrchestratorWindow) return;
            if (sessionStorage.getItem('ntuh_day_submitted') === '1') {
                sessionStorage.removeItem('ntuh_day_submitted');
                setTimeout(() => notify('ntuh_day_done'), 500);
            }
        }

        checkAfterReload();
        if (isOrchestratorWindow && !sessionStorage.getItem('ntuh_day_submitted')) {
            setTimeout(step1, 800);
        } else if (!isOrchestratorWindow) {
            makeFAB({ label: '⚡ 自動填寫當日評估', color: '#198754', hoverColor: '#146c43',
                onClick: () => step1() });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE D：同意書綁定
    // ═══════════════════════════════════════════════════════════

    function moduleConsent() {
        loadTokenFromUrl();

        const MAX_WAIT = 10000;
        const POLL     = 300;
        let waited     = 0;

        function waitForList(cb) {
            const tbody   = document.getElementById('tbBodyConsentFormInfo');
            const loading = document.getElementById('divConsentLoading');
            const bodyDiv = document.getElementById('divConsentBidingBody');
            const loaded  = tbody && tbody.children.length > 0 &&
                            (!loading || loading.style.display === 'none') &&
                            (!bodyDiv || bodyDiv.style.display !== 'none');
            if (!loaded) {
                waited += POLL;
                if (waited >= MAX_WAIT) { cb('timeout'); return; }
                setTimeout(() => waitForList(cb), POLL);
                return;
            }
            cb('loaded');
        }

        function run() {
            waitForList((status) => {
                if (status === 'timeout') { notify('ntuh_consent_fail'); return; }

                const tbody = document.getElementById('tbBodyConsentFormInfo');
                if (!tbody || tbody.innerText.trim() === '查無資料') {
                    notify('ntuh_consent_none'); return;
                }

                const unboundIcons = document.querySelectorAll(
                    '#tbBodyConsentFormInfo .bindConsent i.fa-square'
                );
                if (unboundIcons.length === 0) {
                    notify('ntuh_consent_already'); return;
                }

                const icon = unboundIcons[0];
                const row  = icon.closest('tr');
                if (!row?.dataset.consentidse) { notify('ntuh_consent_fail'); return; }

                // 靜默攔截 alert，結果透過統整訊息呈現
                const origAlert = window.alert;
                window.alert = function (msg) {
                    window.alert = origAlert;
                    notify(msg?.includes('成功') ? 'ntuh_consent_done' : 'ntuh_consent_fail');
                };

                icon.click();
            });
        }

        if (isOrchestratorWindow) {
            run();
        } else {
            makeFAB({ label: '⚡ 自動綁定同意書', color: '#6f42c1', hoverColor: '#5936a2',
                onClick: () => { waited = 0; run(); } });
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 啟動
    // ═══════════════════════════════════════════════════════════

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
