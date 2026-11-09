// ==UserScript==
// @name         NTUH 手術排程自動化
// @namespace    https://ihisaw.ntuh.gov.tw/
// @version      1.3.3
// @description  批次執行術前評估、當日評估、同意書綁定（手術＋麻醉），支援依主治醫師或手術房依序查詢執行，並記憶上次輸入條件
// @author       YT
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/SimpleQueryOpSchedule_New.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/SimpleQueryOpSchedule_New.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/PreOperativeAssessment_New.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/PreOperativeAssessment_New.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/DayOperativeAssessment.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/DayOperativeAssessment.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentBinding.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentBinding.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentFormManagement.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/ConsentFormManagement.aspx*
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
    // detail = 給主頁顯示的補充說明（例如各同意書種類的結果），主頁仍以 msg 決定流程
    function notify(msg, detail) {
        if (!hasOpener) return;
        const token = sessionStorage.getItem('ntuh_window_token') || '';
        window.opener.postMessage({ ntuh: true, msg, detail: detail || '', token }, window.location.origin);
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
    // 批次搜尋條件記憶（手術房／主治醫師分開存）
    // localStorage 依 origin 分開：總院與新竹分院各自一份
    // 儲存形狀：{ room: '53、55', doctor: 'VS的ID', lastMode: 'room' }
    // ═══════════════════════════════════════════════════════════

    const BATCH_MEMORY_KEY = 'ntuh_op_batch_memory';
    const BATCH_MODES = { room: '手術房', doctor: '主治醫師' };

    function readBatchMemory() {
        try {
            const raw = window.localStorage.getItem(BATCH_MEMORY_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            // 無痕模式／儲存空間被封鎖：視同沒有記憶，不影響批次流程
            return {};
        }
    }

    function updateBatchMemory(patch) {
        try {
            const memory = Object.assign(readBatchMemory(), patch);
            window.localStorage.setItem(BATCH_MEMORY_KEY, JSON.stringify(memory));
        } catch (e) {}
    }

    function readBatchTerms(mode) {
        if (!BATCH_MODES[mode]) return '';
        const value = readBatchMemory()[mode];
        return typeof value === 'string' ? value : '';
    }

    // 內容空白＝刪除該模式的記憶（使用者清空 textarea 即代表不再帶入）
    function writeBatchTerms(mode, text) {
        if (!BATCH_MODES[mode]) return;
        const value = text == null ? '' : String(text);
        updateBatchMemory({ [mode]: value.trim() ? value : undefined, lastMode: mode });
    }

    function readBatchMode() {
        const mode = readBatchMemory().lastMode;
        return BATCH_MODES[mode] ? mode : 'room';
    }

    function writeBatchMode(mode) {
        if (!BATCH_MODES[mode]) return;
        updateBatchMemory({ lastMode: mode });
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
                    resolve({ msg: event.data.msg, detail: event.data.detail || '' });
                }
                window.addEventListener('message', onMessage);

                // 60 秒逾時保護
                setTimeout(() => {
                    window.removeEventListener('message', onMessage);
                    try { win.close(); } catch (e) {}
                    resolve({ msg: 'timeout', detail: '' });
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
            'ntuh_consent_partial': '部分', 'ntuh_consent_none': '查無同意書',
            'ntuh_consent_fail': '失敗', 'timeout': '逾時',
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
                    const reply = await openAndWait(url, ['ntuh_preop_done', 'timeout']);
                    result.preop = PREOP_LABEL[reply.msg] || reply.msg;
                } catch (e) { result.preop = '失敗'; }
            }

            if (isDayDone(row)) {
                result.day = '已完成';
            } else {
                try {
                    const url = await getNewPageUrl('DayOperativeAssessment', opIdse);
                    const reply = await openAndWait(url, ['ntuh_day_done', 'ntuh_day_notyet', 'timeout']);
                    result.day = DAY_LABEL[reply.msg] || reply.msg;
                } catch (e) { result.day = '失敗'; }
            }

            if (isConsentDone(row)) {
                result.consent = '已綁定';
            } else {
                try {
                    const url = await getNewPageUrl('ConsentBinding', opIdse);
                    const reply = await openAndWait(url, [
                        'ntuh_consent_done', 'ntuh_consent_already', 'ntuh_consent_partial',
                        'ntuh_consent_none', 'ntuh_consent_fail', 'timeout'
                    ]);
                    const label = CONSENT_LABEL[reply.msg] || reply.msg;
                    result.consent = reply.detail ? `${label} ${reply.detail}` : label;
                } catch (e) { result.consent = '失敗'; }
            }

            statusEl.innerText = `完成：${patName}`;
            return result;
        }

        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        function getScheduleRows() {
            return Array.from(
                document.querySelectorAll('#tbBodyOpSchedule tr[opscheduleidse]')
            ).filter(row => !row.classList.contains('disabled'));
        }

        function getRowsSignature() {
            return getScheduleRows()
                .map(row => row.getAttribute('opscheduleidse'))
                .join('|');
        }

        function getCellText(row, index) {
            return row.children[index]?.innerText?.trim().replace(/\s+/g, ' ') || '';
        }

        function isNoDataShown() {
            const tbody = document.getElementById('tbBodyOpSchedule');
            return !!tbody && /查無|無資料|No data/i.test(tbody.innerText || '');
        }

        async function processCurrentRows(statusEl, batchLabel) {
            const rows = getScheduleRows();

            if (rows.length === 0) {
                statusEl.innerText = '請先執行查詢';
                return { rows, summary: [] };
            }

            const summary = [];
            for (let i = 0; i < rows.length; i++) {
                statusEl.innerText = `${batchLabel}：第 ${i + 1} / ${rows.length} 位...`;
                const result = await processOnePatient(rows[i], statusEl);
                if (result) summary.push({ ...result, batch: batchLabel });
                await delay(500);
            }

            return { rows, summary };
        }

        async function runAll(fab, statusEl, options = {}) {
            const { reload = true, batchLabel = '目前列表' } = options;
            const { rows, summary } = await processCurrentRows(statusEl, batchLabel);

            if (rows.length === 0) {
                fab.innerText = '⚠️ 查無病人資料';
                fab.style.background = '#fd7e14';
                return summary;
            }

            fab.innerText = `✅ 全部完成（${rows.length} 位）`;
            fab.style.background = '#198754';
            statusEl.innerText = `全部 ${rows.length} 位處理完畢`;

            const lines = summary.map(r =>
                `${r.name}　估（${r.preop}）、當（${r.day}）、同（${r.consent}）`
            );
            if (reload) {
                alert('═══ 批次執行結果 ═══\n\n' + lines.join('\n'));
                location.reload();
            }
            return summary;
        }

        function parseBatchTerms(text) {
            return text
                .split(/[\n,，;；]+/)
                .map(term => term.trim())
                .filter(Boolean);
        }

        function normalizeRoomText(text) {
            const value = String(text || '').trim();
            if (/^\d+$/.test(value)) return String(Number(value));
            return value.toUpperCase();
        }

        function findRoomOption(term) {
            const select = document.getElementById('ddlOpRoom');
            if (!select) return null;

            const target = normalizeRoomText(term);
            return Array.from(select.options).find(option => {
                const text = normalizeRoomText(option.textContent);
                const valueParts = String(option.value || '').split(':');
                const valueTail = normalizeRoomText(valueParts[valueParts.length - 1]);
                return text === target || valueTail === target || option.value === term;
            }) || null;
        }

        function syncRoomSelect(select) {
            select.dispatchEvent(new Event('change', { bubbles: true }));

            if (window.jQuery?.fn?.multiselect) {
                try { window.jQuery(select).multiselect('refresh'); } catch (e) {}
            } else if (typeof $ === 'function' && $.fn?.multiselect) {
                try { $(select).multiselect('refresh'); } catch (e) {}
            }
        }

        function setOnlySelectedOption(select, option) {
            Array.from(select.options).forEach(item => { item.selected = item === option; });
            select.value = option.value;
            syncRoomSelect(select);
        }

        function getRoomMultiselectParts(select) {
            const wrapper = select.closest('.multiselect-native-select') || select.parentElement || document;
            const toggle = wrapper.querySelector('button.multiselect') ||
                           select.parentElement?.querySelector('button.multiselect') ||
                           document.querySelector('button.multiselect');
            const menu = wrapper.querySelector('.multiselect-container') ||
                         document.querySelector('.multiselect-container');
            return { wrapper, toggle, menu };
        }

        function isVisible(el) {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        }

        function setNativeValue(el, value) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || '0' }));
        }

        function findRoomButton(menu, term) {
            const target = normalizeRoomText(term);
            return Array.from(menu.querySelectorAll('button.multiselect-option, button.dropdown-item'))
                .filter(isVisible)
                .find(item => {
                    const text = normalizeRoomText(item.innerText);
                    return text === target || text.endsWith(target.padStart(3, '0'));
                }) || null;
        }

        async function selectRoomsByUi(terms, statusEl) {
            const select = document.getElementById('ddlOpRoom');
            if (!select) throw new Error('找不到手術房欄位');

            const options = terms.map(term => {
                const option = findRoomOption(term);
                if (!option) throw new Error(`找不到手術房：${term}`);
                return { term, option };
            });

            const { toggle, menu } = getRoomMultiselectParts(select);
            if (!toggle || !menu) {
                Array.from(select.options).forEach(item => { item.selected = false; });
                options.forEach(item => { item.option.selected = true; });
                syncRoomSelect(select);
                return;
            }

            if (!isVisible(menu)) {
                toggle.click();
                await delay(250);
            }

            const allButton = menu.querySelector('.multiselect-all.active');
            if (allButton) {
                allButton.click();
                await delay(250);
            }

            const searchInput = menu.querySelector('input[type="search"], input.multiselect-search, input[type="text"]');
            for (const item of options) {
                if (searchInput) {
                    statusEl.innerText = `手術房搜尋欄輸入：${item.term}`;
                    setNativeValue(searchInput, item.term);
                    await delay(350);
                }

                const roomButton = findRoomButton(menu, item.term);
                if (roomButton) {
                    roomButton.click();
                    await delay(250);
                } else {
                    item.option.selected = true;
                    syncRoomSelect(select);
                }

                if (searchInput) {
                    setNativeValue(searchInput, '');
                    await delay(200);
                }
            }
        }

        function waitForSearchRefresh(rowValidator = null) {
            return new Promise(resolve => {
                let done = false;
                let observer = null;
                let ajaxStopHandler = null;
                let endRequestHandler = null;
                let firstChangeAt = 0;

                function cleanup() {
                    if (observer) observer.disconnect();
                    if (ajaxStopHandler && typeof $ === 'function') {
                        try { $(document).off('ajaxStop', ajaxStopHandler); } catch (e) {}
                    }
                    if (endRequestHandler && window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
                        try {
                            Sys.WebForms.PageRequestManager.getInstance().remove_endRequest(endRequestHandler);
                        } catch (e) {}
                    }
                }

                function finish() {
                    if (done) return;
                    done = true;
                    cleanup();
                    resolve();
                }

                function hasAcceptableResult() {
                    const rows = getScheduleRows();
                    if (rows.length > 0 && (!rowValidator || rows.some(rowValidator))) return true;
                    return isNoDataShown() && firstChangeAt && Date.now() - firstChangeAt > 1200;
                }

                function maybeFinish(markChanged = false) {
                    if (markChanged && !firstChangeAt) firstChangeAt = Date.now();
                    if (!firstChangeAt) return;
                    if (hasAcceptableResult()) finish();
                }

                const tbody = document.getElementById('tbBodyOpSchedule');
                if (tbody) {
                    observer = new MutationObserver(() => maybeFinish(true));
                    observer.observe(tbody, { childList: true, subtree: true, characterData: true });
                }

                if (typeof $ === 'function') {
                    ajaxStopHandler = () => {
                        if (!firstChangeAt) firstChangeAt = Date.now();
                        setTimeout(finish, 700);
                    };
                    try { $(document).one('ajaxStop', ajaxStopHandler); } catch (e) {}
                }

                if (window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
                    endRequestHandler = () => {
                        if (!firstChangeAt) firstChangeAt = Date.now();
                        setTimeout(finish, 700);
                    };
                    try {
                        Sys.WebForms.PageRequestManager.getInstance().add_endRequest(endRequestHandler);
                    } catch (e) {}
                }

                const poll = setInterval(() => {
                    if (done) {
                        clearInterval(poll);
                        return;
                    }
                    maybeFinish();
                }, 500);

                setTimeout(() => {
                    clearInterval(poll);
                    finish();
                }, 15000);
            });
        }

        async function waitForRowsStable() {
            let stableCount = 0;
            let lastSignature = getRowsSignature();

            while (stableCount < 2) {
                await delay(400);
                const signature = getRowsSignature();
                if (signature === lastSignature) stableCount++;
                else stableCount = 0;
                lastSignature = signature;
            }
        }

        async function clickAndWaitForSearch(button, statusEl, rowValidator = null) {
            const refreshPromise = waitForSearchRefresh(rowValidator);
            button.click();
            statusEl.innerText = '等待列表更新...';
            await refreshPromise;
            await waitForRowsStable();
        }

        async function searchByDoctor(term, statusEl) {
            const input = document.getElementById('txtQueryEmpInfoByNo');
            const button = document.getElementById('btnSearchOpDoctor');
            if (!input || !button) throw new Error('找不到主治查詢欄位或按鈕');

            input.value = term;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            await clickAndWaitForSearch(button, statusEl, row => getCellText(row, 15).includes(term));
        }

        async function searchByRooms(terms, statusEl) {
            const button = document.getElementById('btnSearchByDateAndRoom');
            if (!button) throw new Error('找不到手術房查詢按鈕');

            await selectRoomsByUi(terms, statusEl);
            const roomSet = new Set(terms.map(term => normalizeRoomText(term)));
            await clickAndWaitForSearch(button, statusEl, row => roomSet.has(normalizeRoomText(getCellText(row, 5))));
        }

        async function runSearchBatches(panel, statusEl) {
            const mode = panel.querySelector('[name="ntuh-op-batch-mode"]:checked')?.value || 'room';
            const termsText = panel.querySelector('#ntuhOpBatchTerms').value;
            const terms = parseBatchTerms(termsText);
            // 按「搜尋並執行」時再存一次，避免 debounce 還沒觸發就換頁
            writeBatchTerms(mode, termsText);
            const startBtn = panel.querySelector('#ntuhOpBatchStart');

            if (terms.length === 0) {
                statusEl.style.display = 'block';
                statusEl.innerText = '請先輸入搜尋條件';
                return;
            }

            startBtn.disabled = true;
            startBtn.innerText = '執行中...';
            statusEl.style.display = 'block';

            const allSummary = [];
            if (mode === 'room') {
                const batchLabel = `手術房 ${terms.join('、')}`;

                try {
                    statusEl.innerText = `搜尋：${batchLabel}`;
                    await searchByRooms(terms, statusEl);

                    const { rows, summary } = await processCurrentRows(statusEl, batchLabel);
                    if (rows.length === 0) {
                        allSummary.push({ batch: batchLabel, name: '查無資料', preop: '-', day: '-', consent: '-' });
                    } else {
                        allSummary.push(...summary);
                    }
                } catch (e) {
                    allSummary.push({ batch: batchLabel, name: '搜尋失敗', preop: e.message || '失敗', day: '-', consent: '-' });
                    statusEl.innerText = `${batchLabel} 失敗：${e.message || e}`;
                    await delay(800);
                }

                startBtn.innerText = '完成';
                statusEl.innerText = '手術房搜尋處理完畢';

                const lines = allSummary.map(r =>
                    `[${r.batch}] ${r.name}　估（${r.preop}）、當（${r.day}）、同（${r.consent}）`
                );
                alert('═══ 批次搜尋執行結果 ═══\n\n' + lines.join('\n'));
                location.reload();
                return;
            }

            for (let i = 0; i < terms.length; i++) {
                const term = terms[i];
                const batchLabel = `主治 ${term}`;

                try {
                    statusEl.innerText = `搜尋 ${i + 1} / ${terms.length}：${batchLabel}`;
                    await searchByDoctor(term, statusEl);

                    const { rows, summary } = await processCurrentRows(statusEl, batchLabel);
                    if (rows.length === 0) {
                        allSummary.push({ batch: batchLabel, name: '查無資料', preop: '-', day: '-', consent: '-' });
                    } else {
                        allSummary.push(...summary);
                    }
                } catch (e) {
                    allSummary.push({ batch: batchLabel, name: '搜尋失敗', preop: e.message || '失敗', day: '-', consent: '-' });
                    statusEl.innerText = `${batchLabel} 失敗：${e.message || e}`;
                    await delay(800);
                }
            }

            startBtn.innerText = '完成';
            statusEl.innerText = `全部 ${terms.length} 組搜尋處理完畢`;

            const lines = allSummary.map(r =>
                `[${r.batch}] ${r.name}　估（${r.preop}）、當（${r.day}）、同（${r.consent}）`
            );
            alert('═══ 批次搜尋執行結果 ═══\n\n' + lines.join('\n'));
            location.reload();
        }

        async function runCurrentPage(panel, statusEl) {
            const currentBtn = panel.querySelector('#ntuhOpCurrentPage');

            currentBtn.disabled = true;
            currentBtn.innerText = '執行中...';
            statusEl.style.display = 'block';

            const { rows, summary } = await processCurrentRows(statusEl, '目前頁面');
            if (rows.length === 0) {
                currentBtn.innerText = '目前頁面執行';
                currentBtn.disabled = false;
                statusEl.innerText = '目前頁面查無病人資料';
                return;
            }

            currentBtn.innerText = '完成';
            statusEl.innerText = `目前頁面 ${rows.length} 位處理完畢`;

            const lines = summary.map(r =>
                `${r.name}　估（${r.preop}）、當（${r.day}）、同（${r.consent}）`
            );
            alert('═══ 目前頁面執行結果 ═══\n\n' + lines.join('\n'));
            location.reload();
        }

        function makeBatchPanel(statusEl) {
            const panel = document.createElement('div');
            panel.id = 'ntuhOpBatchPanel';
            panel.innerHTML = `
                <button type="button" id="ntuhOpPanelToggle" title="收合" style="position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;border-radius:6px;background:#f1f3f5;color:#343a40;font-weight:bold;cursor:pointer;">-</button>
                <button type="button" id="ntuhOpPanelIcon" title="展開估當同工具" style="display:none;width:48px;height:48px;border:0;border-radius:50%;background:#0d6efd;color:#fff;font-size:24px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.25);">⚡</button>
                <div id="ntuhOpPanelBody">
                    <div style="font-weight:bold;margin:0 34px 8px 0;">估・當・同批次搜尋</div>
                    <label style="margin-right:10px;"><input type="radio" name="ntuh-op-batch-mode" value="room" checked> 手術房</label>
                    <label><input type="radio" name="ntuh-op-batch-mode" value="doctor"> 主治醫師</label>
                    <textarea id="ntuhOpBatchTerms" placeholder="每行一筆，例如：VS ID&#10;或手術房：53、55（下次自動帶入）" style="width:100%;height:72px;margin-top:8px;resize:vertical;"></textarea>
                    <div id="ntuhOpMemoryHint" style="display:none;margin-top:4px;color:#6c757d;font-size:11px;">已帶入上次輸入</div>
                    <button type="button" id="ntuhOpBatchStart" style="width:100%;margin-top:8px;padding:7px 10px;border:0;border-radius:6px;background:#0d6efd;color:#fff;font-weight:bold;cursor:pointer;">搜尋並執行</button>
                    <button type="button" id="ntuhOpCurrentPage" style="width:100%;margin-top:8px;padding:7px 10px;border:1px solid #6c757d;border-radius:6px;background:#fff;color:#343a40;font-weight:bold;cursor:pointer;">目前頁面執行</button>
                </div>
            `;
            Object.assign(panel.style, {
                position: 'fixed', bottom: '30px', right: '30px', zIndex: '99999',
                width: '260px', background: '#fff', color: '#212529',
                border: '1px solid rgba(0,0,0,0.2)', borderRadius: '8px',
                padding: '12px', fontSize: '13px', boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
            });
            document.body.appendChild(panel);

            // ── 記憶：帶入上次的搜尋模式與條件（手術房／主治醫師各存一份）──
            const modeRadios = Array.from(panel.querySelectorAll('input[name="ntuh-op-batch-mode"]'));
            const termsInput = panel.querySelector('#ntuhOpBatchTerms');
            const memoryHint = panel.querySelector('#ntuhOpMemoryHint');

            let activeMode = readBatchMode();
            let saveTimer = null;

            function syncMemoryHint(fromMemory) {
                memoryHint.style.display = (fromMemory && termsInput.value.trim()) ? 'block' : 'none';
            }

            function persistTerms() {
                writeBatchTerms(activeMode, termsInput.value);
            }

            const restoredRadio = modeRadios.find(radio => radio.value === activeMode);
            if (restoredRadio) restoredRadio.checked = true;
            termsInput.value = readBatchTerms(activeMode);
            syncMemoryHint(true);

            termsInput.addEventListener('input', () => {
                syncMemoryHint(false);
                clearTimeout(saveTimer);
                saveTimer = setTimeout(persistTerms, 300);
            });
            // 切走或關頁前把 debounce 中的內容補存
            termsInput.addEventListener('blur', () => {
                clearTimeout(saveTimer);
                persistTerms();
            });

            modeRadios.forEach(radio => {
                radio.addEventListener('change', () => {
                    if (!radio.checked || radio.value === activeMode) return;
                    // 先把目前模式的內容存回，再換成新模式記住的內容
                    clearTimeout(saveTimer);
                    persistTerms();
                    activeMode = radio.value;
                    termsInput.value = readBatchTerms(activeMode);
                    writeBatchMode(activeMode);
                    syncMemoryHint(true);
                });
            });

            panel.querySelector('#ntuhOpBatchStart').addEventListener('click', () => runSearchBatches(panel, statusEl));
            panel.querySelector('#ntuhOpCurrentPage').addEventListener('click', () => runCurrentPage(panel, statusEl));
            const toggleBtn = panel.querySelector('#ntuhOpPanelToggle');
            const iconBtn = panel.querySelector('#ntuhOpPanelIcon');
            const body = panel.querySelector('#ntuhOpPanelBody');

            function setCollapsed(collapsed) {
                panel.dataset.collapsed = collapsed ? '1' : '0';
                iconBtn.style.display = collapsed ? 'block' : 'none';
                body.style.display = collapsed ? 'none' : 'block';
                toggleBtn.style.display = collapsed ? 'none' : 'block';
                panel.style.width = collapsed ? '48px' : '260px';
                panel.style.padding = collapsed ? '0' : '12px';
                panel.style.border = collapsed ? '0' : '1px solid rgba(0,0,0,0.2)';
                panel.style.background = collapsed ? 'transparent' : '#fff';
                panel.style.boxShadow = collapsed ? 'none' : '0 4px 12px rgba(0,0,0,0.25)';
                statusEl.style.bottom = collapsed ? '90px' : '230px';
            }

            toggleBtn.addEventListener('click', () => setCollapsed(true));
            iconBtn.addEventListener('click', () => setCollapsed(false));
            return panel;
        }

        const statusEl = document.createElement('div');
        Object.assign(statusEl.style, {
            position: 'fixed', bottom: '230px', right: '30px', zIndex: '99999',
            background: 'rgba(0,0,0,0.7)', color: '#fff', padding: '6px 12px',
            borderRadius: '6px', fontSize: '13px', maxWidth: '260px', display: 'none',
        });
        document.body.appendChild(statusEl);
        makeBatchPanel(statusEl);
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

        // ═══════════════════════════════════════════════════════
        // 高風險用藥（2026-10 新版表單）：三組評估結果一律選第一項
        // 抗凝血及抗血小板藥物 / SGLT2i / GLP-1
        // 舊版單一 rbl_subbleeding 欄位已由這個區塊取代
        // ═══════════════════════════════════════════════════════

        const ALERT_DRUG_RADIOS = [
            'NTUHWeb1_rbl_alertdrugs_warfarin_0',   // 無（病人無凝血功能異常或已依醫囑停藥）
            'NTUHWeb1_rbl_alertdrugs_sglt2i_0',     // 本手術不受SGLT2i影響
            'NTUHWeb1_rbl_alertdrugs_glp1_0',       // 本手術不受 GLP-1 藥物影響
        ];

        function step2(index = 0) {
            if (index >= ALERT_DRUG_RADIOS.length) { step3(); return; }
            const radio = document.getElementById(ALERT_DRUG_RADIOS[index]);
            const next  = () => step2(index + 1);
            if (!radio) { next(); return; }
            if (radio.checked) { next(); return; }

            // 表單若把這個 radio 設成 AutoPostBack，要等 postback 回來再換下一組
            const postback = /__doPostBack/.test(radio.getAttribute('onclick') || '');
            clickRadio(radio);
            if (postback) waitForPostback(next);
            else next();
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
    // MODULE D：同意書綁定（手術同意書 ＋ 麻醉同意書）
    // ═══════════════════════════════════════════════════════════
    //
    // ConsentFormManagement.aspx 以 ConsentType 區分同意書種類（同一支頁面、同一份模板）：
    //   ConsentType=S → 手術同意書；ConsentType=A → 麻醉同意書（其他代碼＝自費／一般，本模組不處理）
    // 清單與綁定都走頁面自己用的 handler（與畫面上的綁定圖示同一支 API，不另闢路徑）：
    //   Mode=QueryConsnetFormByChartNo（清單）
    //   Mode=GetOpScheduleBasicInfo（刀表基本資料 → OpDoctorName＝本刀主治）
    //   Mode=AddConsentOpSchedule（綁定；payload 需 PatChartNo + ConsentIdse + ConsentType）
    //
    // 選件規則（使用者定案）：同一主治醫師開立、醫師確認日在 3 個月內、尚未綁到任何刀，
    // 取最新一筆；該種類已綁在本刀 → 視為已完成，不重複綁（避免多綁一份）。
    // 每種種類綁完立刻回讀清單自證（IsBind=Y 且 OpScheduleIdse=本刀），不看 alert 訊息。

    // ── 純規則（零 DOM／零 AJAX，可離線測試）────────────────────

    function parseConsentDate(text) {
        const m = String(text || '').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
        if (!m) return null;
        const date = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
        return isNaN(date.getTime()) ? null : date;
    }

    // infos：QueryConsnetFormByChartNo 的 ConsentInfos
    // 回傳 status：already（本刀已綁）／candidate（有可綁對象）／none（清單空）／novalid（不符條件）
    function selectConsentCandidate(infos, options) {
        const opts = options || {};
        const opIdse = String(opts.opIdse || '');
        const months = (opts.months === null || opts.months === undefined) ? 3 : opts.months;
        const vsNames = (Array.isArray(opts.vsName) ? opts.vsName : [opts.vsName])
            .map(name => String(name || '').trim())
            .filter(Boolean);

        const items = (Array.isArray(infos) ? infos : []).filter(item => item && !item.IsDelete);
        const bound = items.find(item =>
            String(item.IsBind || '') === 'Y' && String(item.OpScheduleIdse || '') === opIdse);
        if (bound) return { status: 'already', bound, total: items.length };

        const unbound = items.filter(item => String(item.OpScheduleIdse || '') === '');
        const nameOf = item => String(item.VSEmpName || '').trim();
        // 同主治「或未指定醫師（VSEmpName 空白）」都算候選：空白那筆多半是病患已簽署、
        // 尚未由 VS 確認的新件，實務上就是這次要綁的那一張（使用者 2026-11 定案）
        const sameVs = unbound.filter(item => {
            const name = nameOf(item);
            return name === '' || vsNames.includes(name);
        });
        const blankVs = unbound.filter(item => nameOf(item) === '');

        const now = opts.now instanceof Date && !isNaN(opts.now.getTime()) ? opts.now : new Date();
        const cutoff = new Date(now.getTime());
        cutoff.setMonth(cutoff.getMonth() - months);

        const recent = sameVs.filter(item => {
            const date = parseConsentDate(item.CompleteDateString) || parseConsentDate(item.SignDateString);
            return !!date && date >= cutoff;
        });
        recent.sort((a, b) => {
            const da = parseConsentDate(a.CompleteDateString) || parseConsentDate(a.SignDateString) || new Date(0);
            const db = parseConsentDate(b.CompleteDateString) || parseConsentDate(b.SignDateString) || new Date(0);
            return db - da;
        });

        if (recent.length > 0) {
            return {
                status: 'candidate', candidate: recent[0], total: items.length,
                counts: { unbound: unbound.length, sameVs: sameVs.length, blank: blankVs.length, recent: recent.length },
            };
        }
        return {
            status: items.length === 0 ? 'none' : 'novalid',
            total: items.length,
            counts: { unbound: unbound.length, sameVs: sameVs.length, blank: blankVs.length, recent: 0 },
            // 原因要能直接指出「缺什麼」，數字給醫師判斷（種類／未綁／同主治或未指定筆數）
            reason: items.length === 0 ? '查無同意書'
                : unbound.length === 0 ? `已綁其他刀(共${items.length})`
                : sameVs.length === 0 ? `無同主治(未綁${unbound.length})`
                : `無${months}個月內(同主治${sameVs.length})`,
        };
    }

    function moduleConsent() {
        loadTokenFromUrl();

        const CONSENT_TYPES = [
            { code: 'S', label: '手術同意書' },
            { code: 'A', label: '麻醉同意書' },
        ];
        const ORDER = CONSENT_TYPES.map(type => type.code);
        const RECENT_MONTHS = 3;
        const RESULT_KEY = 'ntuh_consent_result';
        const RUN_KEY = 'ntuh_consent_run';
        const STATUS_MARK = { done: '✓', already: '=', novalid: '×', none: '−', fail: '✗' };

        function typeLabel(code) {
            const type = CONSENT_TYPES.find(item => item.code === code);
            return type ? type.label : code;
        }

        function readResults() {
            try {
                const parsed = JSON.parse(sessionStorage.getItem(RESULT_KEY) || '{}');
                return (parsed && typeof parsed === 'object') ? parsed : {};
            } catch (e) { return {}; }
        }

        function writeResults(results) {
            try { sessionStorage.setItem(RESULT_KEY, JSON.stringify(results)); } catch (e) {}
        }

        function clearRun() {
            try {
                sessionStorage.removeItem(RESULT_KEY);
                sessionStorage.removeItem(RUN_KEY);
            } catch (e) {}
        }

        // 換病人／重新執行時不可沿用上一輪結果（sessionStorage 可能被同一個 tab 重用）
        function startRun(opIdse) {
            let run = '';
            try { run = sessionStorage.getItem(RUN_KEY) || ''; } catch (e) {}
            if (run !== String(opIdse || '')) {
                try { sessionStorage.setItem(RUN_KEY, String(opIdse || '')); } catch (e) {}
                try { sessionStorage.removeItem(RESULT_KEY); } catch (e) {}
            }
        }

        function hasPendingRun(opIdse) {
            try {
                if ((sessionStorage.getItem(RUN_KEY) || '') !== String(opIdse || '')) return false;
            } catch (e) { return false; }
            return Object.keys(readResults()).length > 0;
        }

        function pageContext() {
            const el = document.getElementById('lblPageInfo');
            const params = new URLSearchParams(window.location.search);
            const pick = (name, param) => {
                let value = '';
                try { if (typeof $ === 'function' && el) value = $(el).data(name); } catch (e) {}
                if (value === null || value === undefined || value === '') {
                    value = el ? (el.getAttribute('data-' + name) || '') : '';
                }
                if (value === '') value = params.get(param) || '';
                return String(value).trim();
            };
            // 病歷號在頁面上另有顯示欄位（頁面的 BindConsent 也是讀這個）
            const chartEl = document.getElementById('txtPatChartNo');
            const chartNo = pick('patchartno', 'PatChartNo') ||
                String((chartEl && chartEl.textContent) || '').trim();
            return {
                session:     pick('session', 'SESSION'),
                hospCode:    pick('hospitalcode', 'HospCode'),
                empNo:       pick('empno', 'EmpNo'),
                chartNo,
                opIdse:      pick('opscheduleidse', 'OpScheduleIdse'),
                consentType: pick('consenttype', 'ConsentType').toUpperCase(),
            };
        }

        function callHandler(mode, payload) {
            return new Promise((resolve, reject) => {
                if (typeof $ !== 'function' || !$.ajax) {
                    reject(new Error('找不到 jQuery，無法呼叫 HIS handler'));
                    return;
                }
                $.ajax({
                    url: 'handler/ConsentFormHandler.ashx?Mode=' + mode,
                    data: encodeURIComponent(JSON.stringify(payload)),
                    type: 'post',
                    contentType: 'application/json; charset=utf-8',
                    dataType: 'json',
                    success(result) { resolve(result || {}); },
                    error(xhr, status, error) {
                        const code = (xhr && xhr.status) ? `HTTP ${xhr.status} ` : '';
                        reject(new Error(`ConsentFormHandler ${mode} ${code}失敗（${error || status}）`));
                    },
                });
            });
        }

        function basePayload(ctx) {
            return {
                Session: ctx.session,
                HospCode: ctx.hospCode,
                EmpNo: ctx.empNo,
                OpScheduleIdse: ctx.opIdse,
                ConsentType: ctx.consentType,
            };
        }

        // QueryConsnetFormByChartNo 一定要帶 PatChartNo：缺它 handler 會 NullReferenceException
        // → HTTP 500（HTML 錯誤頁），jQuery 走 error，看起來像「綁定失敗」但其實是查詢就掛了
        function chartPayload(ctx) {
            return Object.assign(basePayload(ctx), { PatChartNo: ctx.chartNo });
        }

        // 登入失效時 handler 回 IsVerified=false（頁面自己也靠這個 reload）
        function assertVerified(result) {
            if (result && result.IsVerified === false) throw new Error('住院系統登入已失效，請重新登入');
            return result;
        }

        function splitDoctorNames(value) {
            return String(value || '')
                .split(/[,，、;；\/／]/)
                .map(name => name.trim())
                .filter(Boolean);
        }

        // 診斷用：只印同意書種類、醫師、筆數與結果，不印病人姓名／病歷號
        function logDiag(code, picked, result) {
            const counts = (picked && picked.counts) || {};
            const chosen = picked && picked.candidate
                ? `${picked.candidate.ConsentIdse}／${picked.candidate.ConsentName}／${picked.candidate.VSEmpName || '(未指定)'}／${picked.candidate.CompleteDateString}`
                : '—';
            console.info('[op-automation][consent]', code, {
                total: (picked && picked.total) || 0,
                counts,
                chosen,
                status: result.status,
                reason: result.reason || '',
            });
        }

        async function bindCurrentType(ctx) {
            const finish = (picked, result) => {
                logDiag(ctx.consentType, picked, result);
                return result;
            };

            const op = assertVerified(await callHandler('GetOpScheduleBasicInfo', basePayload(ctx)));
            if (op.IsSuccess === false) throw new Error(op.ErrorMessage || '讀不到刀表基本資料');
            const vsNames = splitDoctorNames(op.OpDoctorName);
            if (vsNames.length === 0) {
                return finish(null, { status: 'fail', reason: '刀表沒有主治醫師，無法比對' });
            }

            const list = assertVerified(await callHandler('QueryConsnetFormByChartNo', chartPayload(ctx)));
            if (list.IsSuccess === false) throw new Error(list.ErrorMessage || '同意書清單查詢失敗');

            const picked = selectConsentCandidate(list.ConsentInfos, {
                opIdse: ctx.opIdse, vsName: vsNames, months: RECENT_MONTHS,
            });
            if (picked.status === 'already') {
                return finish(picked, { status: 'already', reason: (picked.bound && picked.bound.ConsentName) || '' });
            }
            if (picked.status !== 'candidate') {
                return finish(picked, { status: picked.status, reason: picked.reason || '' });
            }

            const consentIdse = picked.candidate.ConsentIdse;
            const added = assertVerified(await callHandler('AddConsentOpSchedule',
                Object.assign(chartPayload(ctx), { ConsentIdse: consentIdse })));
            if (added.IsSuccess === false) throw new Error(added.ErrorMessage || '同意書綁定失敗');

            // 回讀自證：同一 ConsentIdse 已標記綁在本刀才算成功（不看 alert 文字）
            const after = assertVerified(await callHandler('QueryConsnetFormByChartNo', chartPayload(ctx)));
            const boundNow = (after.ConsentInfos || []).some(item =>
                String(item.ConsentIdse) === String(consentIdse) &&
                String(item.IsBind || '') === 'Y' &&
                String(item.OpScheduleIdse || '') === ctx.opIdse);
            if (!boundNow) {
                return finish(picked, { status: 'fail', reason: '送出後回讀未見綁定' });
            }

            return finish(picked, { status: 'done', reason: picked.candidate.ConsentName || '' });
        }

        function navigateToType(code) {
            const url = new URL(window.location.href);
            url.searchParams.set('ConsentType', code);
            if (!url.searchParams.get('ntuh_token')) {
                const token = sessionStorage.getItem('ntuh_window_token');
                if (token) url.searchParams.set('ntuh_token', token);
            }
            window.location.replace(url.toString());
        }

        function summarize(results) {
            const shortReason = reason => {
                const text = String(reason || '').replace(/\s+/g, ' ').trim();
                if (!text) return '';
                return text.length > 20 ? text.slice(0, 20) + '…' : text;
            };
            // detail 直接帶未完成的原因，否則主頁只顯示「失敗」無法判斷要人工補什麼
            const detail = ORDER.map(code => {
                const result = results[code] || {};
                const mark = STATUS_MARK[result.status] || '?';
                const showReason = result.status && result.status !== 'done' && result.status !== 'already';
                return code + mark + (showReason ? '(' + shortReason(result.reason) + ')' : '');
            }).join(' ');
            const statuses = ORDER.map(code => (results[code] || {}).status || 'fail');
            let msg;
            if (statuses.every(status => status === 'done' || status === 'already')) {
                msg = statuses.every(status => status === 'already') ? 'ntuh_consent_already' : 'ntuh_consent_done';
            } else if (statuses.some(status => status === 'done' || status === 'already')) {
                msg = 'ntuh_consent_partial';
            } else {
                msg = 'ntuh_consent_fail';
            }
            const notes = ORDER
                .filter(code => (results[code] || {}).reason)
                .map(code => `${typeLabel(code)}：${results[code].reason}`);
            return { msg, detail, notes };
        }

        function report(results) {
            const summary = summarize(results);
            clearRun();
            if (isOrchestratorWindow) {
                notify(summary.msg, summary.detail);
            } else {
                window.alert(['同意書綁定結果：' + summary.detail].concat(summary.notes).join('\n'));
            }
        }

        async function runSequence() {
            const ctx = pageContext();
            if (!ctx.session || !ctx.opIdse || !ctx.chartNo) {
                clearRun();
                const missing = [!ctx.session && 'SESSION', !ctx.opIdse && 'OpScheduleIdse',
                    !ctx.chartNo && '病歷號'].filter(Boolean).join('／');
                if (isOrchestratorWindow) notify('ntuh_consent_fail', `缺少 ${missing}`);
                else window.alert(`同意書綁定失敗：頁面缺少 ${missing}（HIS 查詢同意書清單必須帶病歷號）`);
                return;
            }

            const results = readResults();
            const currentType = ORDER.includes(ctx.consentType) ? ctx.consentType : '';
            if (!currentType) {
                // 停在別種同意書（自費／一般）時不綁，直接切到第一種要處理的種類
                const nextCode = ORDER.find(code => !results[code]);
                if (nextCode) { navigateToType(nextCode); return; }
                report(results);
                return;
            }

            try {
                results[currentType] = await bindCurrentType(ctx);
            } catch (error) {
                results[currentType] = {
                    status: 'fail',
                    reason: (error && error.message) ? error.message : String(error),
                };
            }
            writeResults(results);

            const nextCode = ORDER.find(code => !results[code]);
            if (nextCode) { navigateToType(nextCode); return; }
            report(results);
        }

        if (isOrchestratorWindow) {
            startRun(pageContext().opIdse);
            setTimeout(runSequence, 600);
        } else if (hasPendingRun(pageContext().opIdse)) {
            // 手動模式下切換 ConsentType 會整頁重載 → 自動接續，不必再按一次
            setTimeout(runSequence, 400);
        } else {
            makeFAB({ label: '⚡ 自動綁定同意書', color: '#6f42c1', hoverColor: '#5936a2',
                onClick: () => { startRun(pageContext().opIdse); runSequence(); } });
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
