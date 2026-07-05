// ==UserScript==
// @name         NTUH Weekend Progress
// @namespace    https://ihisaw.ntuh.gov.tw/
// @version      1.3.5
// @description  用於例假日值班批次寫病房病程：複製最新 Progress Note，Subjective 填入 stable 後確認送出
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      cdn.jsdelivr.net
// ==/UserScript==

(function () {
    'use strict';

    /* global __doPostBack, $SelectedNote, CopyNoteToNewRecord, Sys */

    const STORAGE_KEY = 'ntuh_weekend_progress';
    const PATH = window.location.pathname;

    // ═══════════════════════════════════════════════════════════
    // 共用工具
    // ═══════════════════════════════════════════════════════════

    function getState() {
        try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY)); }
        catch { return null; }
    }
    function setState(s) { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
    function clearState() { sessionStorage.removeItem(STORAGE_KEY); }

    function waitForPostback(fn) {
        if (window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager) {
            const prm = Sys.WebForms.PageRequestManager.getInstance();
            const handler = function () {
                prm.remove_endRequest(handler);
                setTimeout(fn, 400);
            };
            prm.add_endRequest(handler);
        } else {
            setTimeout(fn, 2000);
        }
    }

    function onReady(fn, delay) {
        const run = () => setTimeout(fn, delay);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', run);
        } else {
            run();
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Phase 0: 攔截 window.open（病房清單頁面，document-start 階段）
    // ═══════════════════════════════════════════════════════════

    let capturedPopup = null;
    let childMessageReceived = false;

    if (PATH.includes('OpenWard.aspx')) {
        const state = getState();
        if (state?.running) {
            const origOpen = window.open.bind(window);
            window.open = function (...args) {
                const win = origOpen(...args);
                capturedPopup = win;
                return win;
            };
            // 提早掛 message listener，不等 initOrchestrator
            let earlyResult = null;
            window.addEventListener('message', function earlyHandler(event) {
                if (event.origin !== location.origin) return;
                if (!event.data?.ntuh_weekend) return;
                childMessageReceived = true;
                earlyResult = event.data.result;
                window.removeEventListener('message', earlyHandler);
            });
            // 暴露給 initOrchestrator 使用
            window._weekendEarlyResult = () => earlyResult;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // 路由
    // ═══════════════════════════════════════════════════════════

    if (PATH.includes('OpenWard.aspx')) onReady(initOrchestrator, 1500);
    if (PATH.includes('InsertProgressNoteContent.aspx')) onReady(initChild, 2000);

    // ═══════════════════════════════════════════════════════════
    // MODULE A：Orchestrator（病房清單頁面）
    // ═══════════════════════════════════════════════════════════

    function initOrchestrator() {
        const state = getState();

        if (state?.running) {
            const origAlert = window.alert;
            window.alert = function () { /* 靜默 */ };
            window.addEventListener('beforeunload', () => { window.alert = origAlert; });

            showOrchestratorStatus(state);

            // 如果 early handler 已收到 child message，直接處理
            if (childMessageReceived && window._weekendEarlyResult) {
                addResult(state, window._weekendEarlyResult());
                try { capturedPopup?.close(); } catch (e) { /* */ }
                waitForPopupClosed(() => nextPatient(state));
                return;
            }

            listenForChildMessage(state);

            if (capturedPopup) {
                startPopupTimeout(state);
            } else {
                // 輪詢等待 popup 出現，最多 15 秒
                let pollCount = 0;
                const pollPopup = setInterval(() => {
                    pollCount++;
                    if (childMessageReceived) { clearInterval(pollPopup); return; }
                    if (capturedPopup) {
                        clearInterval(pollPopup);
                        startPopupTimeout(state);
                    } else if (pollCount >= 30) { // 15 秒
                        clearInterval(pollPopup);
                        addResult(state, '未開啟');
                        nextPatient(state);
                    }
                }, 500);
            }
            return;
        }

        if (state && !state.running && state.results?.length > 0) {
            showFinalResults(state);
            clearState();
        }

        // 強制顯示：在 console 輸入 sessionStorage.setItem('forceWeekend','1') 後重新整理
        if (sessionStorage.getItem('forceWeekend') === '1') {
            createFAB('手動啟用');
        } else {
            checkHolidayAndShowFAB();
        }
    }

    function listenForChildMessage(state) {
        window.addEventListener('message', function handler(event) {
            if (event.origin !== location.origin) return;
            if (!event.data?.ntuh_weekend) return;

            childMessageReceived = true;
            window.removeEventListener('message', handler);
            clearTimeout(state._timeout);

            addResult(state, event.data.result);
            // 主動關閉 child（防止 child 自己 close 失敗）
            try { capturedPopup?.close(); } catch (e) { /* */ }
            waitForPopupClosed(() => nextPatient(state));
        });
    }

    function waitForPopupClosed(callback) {
        if (!capturedPopup || capturedPopup.closed) {
            setTimeout(callback, 300);
            return;
        }
        let attempts = 0;
        const poll = setInterval(() => {
            attempts++;
            if (!capturedPopup || capturedPopup.closed || attempts >= 30) {
                clearInterval(poll);
                setTimeout(callback, 300);
            }
        }, 200);
    }

    function startPopupTimeout(state) {
        state._timeout = setTimeout(() => {
            if (childMessageReceived) return;
            try { capturedPopup?.close(); } catch (e) { /* */ }
            addResult(state, '逾時');
            nextPatient(state);
        }, 90000);
    }

    function getPatients() {
        const table = document.getElementById(
            'NTUHWeb1_QueryInPatientPersonAccountControl1_DataGridAccountList'
        );
        if (!table) return [];

        return [...table.rows].slice(1).map((tr, i) => {
            const ctlId = `ctl${String(i + 2).padStart(2, '0')}`;
            const nameEl = tr.querySelector(`[id$="${ctlId}_LinkPatientName"]`);
            const progEl = tr.querySelector(`[id$="${ctlId}_LinkProgressNote"]`);
            const roomEl = tr.querySelector(`[id$="${ctlId}_RoomLabel"]`);
            const bedEl  = tr.querySelector(`[id$="${ctlId}_BedLabel"]`);
            if (!nameEl || !progEl) return null;

            const href = progEl.getAttribute('href') || '';
            const m = href.match(/__doPostBack\('([^']+)'/);
            if (!m) return null;

            return {
                name: nameEl.textContent.trim(),
                bed: `${roomEl?.textContent?.trim() || ''}-${bedEl?.textContent?.trim() || ''}`,
                postbackArg: m[1],
            };
        }).filter(Boolean);
    }

    function startBatch() {
        const patients = getPatients();
        if (patients.length === 0) { alert('找不到病人清單'); return; }

        const state = { running: true, patients, currentIndex: 0, results: [] };
        setState(state);
        __doPostBack(patients[0].postbackArg, '');
    }

    function addResult(state, status) {
        const p = state.patients[state.currentIndex];
        state.results.push({ name: p?.name || '?', bed: p?.bed || '', status });
    }

    function nextPatient(state) {
        if (state._stopped) return;
        state.currentIndex++;
        if (state.currentIndex >= state.patients.length) {
            state.running = false;
            setState(state);
            // 用 GET 導航避免 POST 重送（reload 會重新觸發 __doPostBack 開 child）
            window.location.href = window.location.pathname + window.location.search;
            return;
        }
        setState(state);
        __doPostBack(state.patients[state.currentIndex].postbackArg, '');
    }

    // --- 假日判斷 ---

    function getTodayYYYYMMDD() {
        const d = new Date();
        return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    }

    function isWeekend() {
        const day = new Date().getDay();
        return day === 0 || day === 6;
    }

    // 內建 fallback：固定國定假日（月-日）
    const FIXED_HOLIDAYS = [
        '01-01', // 元旦
        '02-28', // 和平紀念日
        '10-10', // 國慶日
    ];

    function isFixedHoliday() {
        const today = getTodayMMDD();
        return FIXED_HOLIDAYS.includes(today);
    }

    function checkHolidayAndShowFAB() {
        const year = new Date().getFullYear();
        const url = `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`;
        const todayStr = getTodayYYYYMMDD();

        // 先用 GM_xmlhttpRequest 抓 API
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                onload(res) {
                    try {
                        const data = JSON.parse(res.responseText);
                        const today = data.find(d => d.date === todayStr);
                        if (today?.isHoliday) {
                            createFAB(today.description || '例假日');
                        }
                    } catch {
                        fallbackCheck();
                    }
                },
                onerror() { fallbackCheck(); },
                ontimeout() { fallbackCheck(); },
                timeout: 5000,
            });
        } catch {
            fallbackCheck();
        }
    }

    function fallbackCheck() {
        if (isWeekend() || isFixedHoliday()) {
            createFAB('例假日');
        }
    }

    // --- Orchestrator UI ---

    function createFAB(holidayLabel) {
        if (document.getElementById('ntuh-batch-fab')) return;

        const fab = document.createElement('button');
        fab.id = 'ntuh-batch-fab';
        fab.textContent = '⚡ 週末病程';
        Object.assign(fab.style, {
            position: 'fixed', bottom: '30px', right: '30px', zIndex: '99999',
            padding: '12px 20px', background: '#e67e22', color: '#fff',
            border: 'none', borderRadius: '8px', fontSize: '15px',
            fontWeight: 'bold', cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        });
        fab.onmouseenter = () => { fab.style.background = '#d35400'; };
        fab.onmouseleave = () => { fab.style.background = '#e67e22'; };
        fab.onclick = () => {
            const patients = getPatients();
            if (confirm(
                `即將對 ${patients.length} 位病人批次執行：\n` +
                `　1. 複製最新 Progress Note\n` +
                `　2. Subjective 填入 stable\n` +
                `　3. 自動帶入導管紀錄（若有）\n` +
                `　4. 確認送出\n\n確定要繼續嗎？`
            )) {
                startBatch();
            }
        };
        document.body.appendChild(fab);
    }

    function showOrchestratorStatus(state) {
        let el = document.getElementById('ntuh-batch-status');
        if (el) el.remove();

        el = document.createElement('div');
        el.id = 'ntuh-batch-status';
        const total = state.patients.length;
        const current = state.currentIndex + 1;
        const p = state.patients[state.currentIndex];

        Object.assign(el.style, {
            position: 'fixed', bottom: '30px', right: '30px', zIndex: '99999',
            background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '12px 20px',
            borderRadius: '8px', fontSize: '14px', fontWeight: 'bold',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            display: 'flex', alignItems: 'center', gap: '12px',
        });

        const text = document.createElement('span');
        text.textContent = `[${current}/${total}] 處理中：${p?.bed} ${p?.name}`;

        const stopBtn = document.createElement('button');
        stopBtn.textContent = '⛔ 終止';
        Object.assign(stopBtn.style, {
            padding: '4px 12px', background: '#e74c3c', color: '#fff',
            border: 'none', borderRadius: '4px', fontSize: '13px',
            cursor: 'pointer', fontWeight: 'bold',
        });
        stopBtn.onclick = () => {
            try { capturedPopup?.close(); } catch {}
            state.running = false;
            setState(state);
            el.remove();
            showFinalResults(state);
            clearState();
        };

        el.appendChild(text);
        el.appendChild(stopBtn);
        document.body.appendChild(el);
    }

    function showFinalResults(state) {
        const lines = state.results.map(r => `${r.bed} ${r.name}：${r.status}`);
        const text = lines.join('\n');

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '99999',
            background: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#fff', borderRadius: '12px', padding: '24px',
            maxWidth: '480px', width: '90%', maxHeight: '80vh',
            display: 'flex', flexDirection: 'column', gap: '12px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        });

        const title = document.createElement('div');
        title.textContent = '═══ 週末病程結果 ═══';
        Object.assign(title.style, {
            fontSize: '16px', fontWeight: 'bold', textAlign: 'center',
        });

        const pre = document.createElement('pre');
        pre.textContent = text;
        Object.assign(pre.style, {
            margin: '0', padding: '12px', background: '#f5f5f5',
            borderRadius: '8px', fontSize: '13px', overflowY: 'auto',
            maxHeight: '50vh', whiteSpace: 'pre-wrap',
        });

        const btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display: 'flex', gap: '8px', justifyContent: 'center',
        });

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 複製結果';
        Object.assign(copyBtn.style, {
            padding: '8px 20px', background: '#e67e22', color: '#fff',
            border: 'none', borderRadius: '6px', fontSize: '14px',
            fontWeight: 'bold', cursor: 'pointer',
        });
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(text).then(() => {
                copyBtn.textContent = '✓ 已複製';
                setTimeout(() => { copyBtn.textContent = '📋 複製結果'; }, 1500);
            });
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        Object.assign(closeBtn.style, {
            padding: '8px 20px', background: '#ccc', color: '#333',
            border: 'none', borderRadius: '6px', fontSize: '14px',
            cursor: 'pointer',
        });
        closeBtn.onclick = () => overlay.remove();

        btnRow.appendChild(copyBtn);
        btnRow.appendChild(closeBtn);
        box.appendChild(title);
        box.appendChild(pre);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE B：Child（Progress Note 頁面）
    // ═══════════════════════════════════════════════════════════

    function isAutoBatch() {
        try {
            const state = JSON.parse(
                window.opener?.sessionStorage?.getItem(STORAGE_KEY)
            );
            return state?.running === true;
        } catch { return false; }
    }

    function notifyOpener(result) {
        try {
            window.opener.postMessage(
                { ntuh_weekend: true, result },
                location.origin
            );
        } catch { /* */ }
        setTimeout(() => window.close(), 500);
    }

    function initChild() {
        if (!isAutoBatch()) return;

        const origAlert = window.alert;
        window.alert = function () { /* 靜默 */ };
        window.addEventListener('beforeunload', () => { window.alert = origAlert; });

        autoProcess();
    }

    function toMMDD(date) {
        return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    function getTodayMMDD() { return toMMDD(new Date()); }

    function getYesterdayMMDD() {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return toMMDD(d);
    }

    function isProgressNote(type, name) {
        if (type === 'progress') return true;
        if (type === 'blank' && /progress/i.test(name)) return true;
        return false;
    }

    function autoProcess() {
        const today = getTodayMMDD();

        const yesterday = getYesterdayMMDD();

        // Step 1：掃描所有 note，找病程相關紀錄
        let targetIndex = -1;
        let targetType = null;
        let targetDate = null;

        for (let i = 0; i < 60; i++) {
            const typeEl = document.getElementById(
                `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_Type`
            );
            if (!typeEl) break;
            const type = typeEl.textContent.trim();
            const nameEl = document.getElementById(
                `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_NoteName`
            );
            const name = nameEl?.textContent?.trim() || '';

            if (!isProgressNote(type, name)) continue;

            const dateEl = document.getElementById(
                `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_InsertDateTime`
            );
            const date = dateEl?.textContent?.trim() || '';

            if (date === today) {
                notifyOpener('已有今日病程');
                return;
            }

            if (targetIndex < 0) {
                targetIndex = i;
                targetType = type;
                targetDate = date;
            }
            break;
        }

        // 完全沒有 progress → 檢查 admission note
        if (targetIndex < 0) {
            let admissionIndex = -1;
            let admissionDate = null;
            for (let i = 0; i < 60; i++) {
                const typeEl = document.getElementById(
                    `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_Type`
                );
                if (!typeEl) break;
                if (typeEl.textContent.trim() === 'admission') {
                    admissionIndex = i;
                    const dateEl = document.getElementById(
                        `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_InsertDateTime`
                    );
                    if (dateEl) admissionDate = dateEl.textContent.trim();
                    break;
                }
            }

            if (admissionIndex < 0) {
                notifyOpener('請手動處理');
            } else if (admissionDate === today) {
                notifyOpener('新病人不需病程');
            } else if (admissionDate === yesterday) {
                createFromAdmission(admissionIndex);
            } else {
                notifyOpener('請手動處理');
            }
            return;
        }

        const isYesterday = targetDate === yesterday;

        // Step 2：點選該筆 note 以設定 $SelectedNote
        const nameLink = document.getElementById(
            `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${targetIndex}_NoteName`
        );
        if (!nameLink) {
            notifyOpener('選取失敗');
            return;
        }
        nameLink.click();

        // Step 3：等選取完成（postback），再複製
        waitForPostback(() => {
            if (typeof $SelectedNote === 'undefined' || !$SelectedNote.CaseSeqNo) {
                notifyOpener('選取失敗');
                return;
            }

            const copyType = targetType === 'blank' ? 'blank' : 'progress';
            const resultLabel = isYesterday ? '✓' : '✓ (非昨日)';

            let copied = false;
            const afterCopy = () => {
                if (copied) return;
                copied = true;
                // 複製 postback 完成後，用狀態偵測確認系統就緒再填入
                waitUntilReady(copyType, () => {
                    if (copyType === 'blank') {
                        fillBlankAndConfirm(resultLabel);
                    } else {
                        fillStableAndConfirm(resultLabel);
                    }
                });
            };

            waitForPostback(afterCopy);
            setTimeout(afterCopy, 3000);

            CopyNoteToNewRecord(copyType);
        });
    }

    function waitUntilReady(copyType, callback) {
        const fieldId = copyType === 'blank'
            ? 'NTUHWeb1_BlankNoteMainTab_txbBlankContnt'
            : 'NTUHWeb1_ProgressNoteMainTab_txbSubject';
        let attempts = 0;
        const maxAttempts = 30; // 每 100ms 一次，最多 3 秒
        const poll = () => {
            const field = document.getElementById(fieldId);
            if (field && !field.disabled) {
                callback();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                callback(); // fallback：3 秒到了就繼續
                return;
            }
            setTimeout(poll, 100);
        };
        poll();
    }

    async function fillBlankAndConfirm(resultLabel) {
        await new Promise(r => setTimeout(r, 500));

        // 標題統一改為 Progress（複製來的可能是 Progress/Weekly 等）
        const titleField = document.getElementById('NTUHWeb1_BlankNoteMainTab_txbBlankTitle');
        if (titleField && /progress/i.test(titleField.value)) {
            titleField.value = 'Progress';
            titleField.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const contentField = document.getElementById(
            'NTUHWeb1_BlankNoteMainTab_txbBlankContnt'
        );
        if (!contentField) {
            notifyOpener('找不到 Blank Note 內容欄位');
            return;
        }

        contentField.value = 'stable\n' + contentField.value;
        contentField.dispatchEvent(new Event('input', { bubbles: true }));
        contentField.dispatchEvent(new Event('change', { bubbles: true }));

        // 等 300ms 再按確認
        await new Promise(r => setTimeout(r, 300));

        const confirmBtn = document.getElementById(
            'NTUHWeb1_BlankNoteMainTab_btnConfirmBlankNoteByR'
        );
        if (!confirmBtn) {
            notifyOpener('找不到確認按鈕');
            return;
        }

        let confirmed = false;
        const done = () => {
            if (confirmed) return;
            confirmed = true;
            notifyOpener(resultLabel);
        };

        waitForPostback(done);
        setTimeout(done, 3000);

        confirmBtn.click();
    }

    // --- OuterData BSI 抓取 ---

    function getOuterDataParams() {
        const v = (id) => document.getElementById(id)?.value || '';
        const params = new URLSearchParams(window.location.search);
        return {
            AccountIdse: v('hidAccountNo') || params.get('AccountIDSE') || '',
            PersonId:    v('hidPersonId')  || params.get('PersonID')   || '',
            ChartNo:     v('hidChartNo')   || '',
            DeptCode:    v('hidDeptCode')  || '',
            EmpDeptCode: v('hidEmpDeptCode') || '',
        };
    }

    function outerDataUrl() {
        return window.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
            + 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';
    }

    async function fetchBSI() {
        try {
            const res = await fetch(outerDataUrl(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json; charset=utf-8' },
                body: JSON.stringify({
                    jsonstring: JSON.stringify(getOuterDataParams()),
                    datatype: 'BSI',
                }),
                credentials: 'same-origin',
            });
            if (!res.ok) return '';
            const j = await res.json();
            const html = JSON.parse(j.d).Html || '';
            return parseBSI(html);
        } catch { return ''; }
    }

    function parseBSI(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const table = doc.getElementById('tblBSIList') || doc.querySelector('table.listview');
        if (!table) return '';
        const rows = [...table.querySelectorAll('tbody tr')];
        if (!rows.length) return '';
        return rows.map(tr => {
            const cells = [...tr.querySelectorAll('td')];
            // 跳過「選」按鈕欄
            const filtered = cells.filter(td => !td.querySelector('[id*="lkbSelectData"]'));
            const item = (filtered[0]?.textContent || '').trim();
            const date = (filtered[1]?.textContent || '').trim().replace(/(\d{4})\/(\d{2})\/(\d{2})/, (m, y, mo, d) => `${mo}${d}`);
            return `[${item}]: 放置日期:${date}; 經醫師評估仍有導管留置適應症。`;
        }).join('\n');
    }

    function fillField(id, value) {
        const el = document.getElementById(id);
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    async function fillStableAndConfirm(resultLabel) {
        // 等 500ms 讓系統完全就緒再填入
        await new Promise(r => setTimeout(r, 500));

        fillField('NTUHWeb1_ProgressNoteMainTab_txbSubject', 'stable');

        // 等 300ms 再處理導管
        await new Promise(r => setTimeout(r, 300));

        // 處理導管紀錄
        const bsiSwitch = document.getElementById('NTUHWeb1_ProgressNoteMainTab_hidBSIswitch');
        const bsiField = document.getElementById('NTUHWeb1_ProgressNoteMainTab_txbBSIBundle');

        if (bsiSwitch?.value === 'Y' && bsiField && !bsiField.value.trim()) {
            const bsiText = await fetchBSI();
            fillField('NTUHWeb1_ProgressNoteMainTab_txbBSIBundle', bsiText || 'nil');
        }

        // 等 300ms 再按確認
        await new Promise(r => setTimeout(r, 300));

        const confirmBtn = document.getElementById(
            'NTUHWeb1_ProgressNoteMainTab_btnConfirmProgressNote'
        );
        if (!confirmBtn) {
            notifyOpener('找不到確認按鈕');
            return;
        }

        let confirmed = false;
        const done = () => {
            if (confirmed) return;
            confirmed = true;
            notifyOpener(resultLabel);
        };

        waitForPostback(done);
        setTimeout(done, 3000);

        confirmBtn.click();
    }

    // ═══════════════════════════════════════════════════════════
    // 從 Admission Note 建立新 Blank Note
    // ═══════════════════════════════════════════════════════════

    function createFromAdmission(admissionIndex) {
        // Step A：點選 admission note
        const nameLink = document.getElementById(
            `NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${admissionIndex}_NoteName`
        );
        if (!nameLink) {
            notifyOpener('找不到 Admission Note');
            return;
        }
        nameLink.click();

        // Step B：等 postback，擷取「醫療需求與治療計畫」
        waitForPostback(() => {
            const medicalNeeds = extractMedicalNeeds();

            // Step C：點「新增Note」建立 blank note
            const insertBtn = document.getElementById('NTUHWeb1_btnInsertBlankNote');
            if (!insertBtn) {
                notifyOpener('找不到新增Note按鈕');
                return;
            }
            insertBtn.click();

            // Step D：等 postback，填入標題和內容
            waitForPostback(() => {
                const titleField = document.getElementById(
                    'NTUHWeb1_BlankNoteMainTab_txbBlankTitle'
                );
                const contentField = document.getElementById(
                    'NTUHWeb1_BlankNoteMainTab_txbBlankContnt'
                );
                if (!titleField || !contentField) {
                    notifyOpener('找不到 Blank Note 欄位');
                    return;
                }

                titleField.value = 'Progress Note';
                titleField.dispatchEvent(new Event('change', { bubbles: true }));

                const body = medicalNeeds
                    ? 'stable\n\n' + medicalNeeds
                    : 'stable';
                contentField.value = body;
                contentField.dispatchEvent(new Event('change', { bubbles: true }));

                const confirmBtn = document.getElementById(
                    'NTUHWeb1_BlankNoteMainTab_btnConfirmBlankNoteByR'
                );
                if (!confirmBtn) {
                    notifyOpener('找不到確認按鈕');
                    return;
                }
                let confirmed = false;
                const done = () => {
                    if (confirmed) return;
                    confirmed = true;
                    notifyOpener('✓ (從admission建立)');
                };

                waitForPostback(done);
                setTimeout(done, 3000);

                confirmBtn.click();
            });
        });
    }

    function extractMedicalNeeds() {
        const tds = [...document.querySelectorAll('td.tdRecordElementBorwseSubTitle')];
        const target = tds.find(td => /醫療需求/.test(td.textContent));
        if (!target) return '';

        const tr = target.closest('tr');
        const nextRow = tr?.nextElementSibling;
        if (!nextRow) return '';

        return nextRow.textContent.trim();
    }

})();
