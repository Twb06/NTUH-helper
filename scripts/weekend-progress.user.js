// ==UserScript==
// @name         NTUH Weekend Progress
// @namespace    https://ihisaw.ntuh.gov.tw/
// @version      1.7.0
// @description  例假日病程批次工具：週五預寫週末草稿（每日各指定 VS，可由主治班表自動帶入員編）／當日確認草稿（帶入 TPR 與導管）／複製最新 Progress Note 填 stable 後送出
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://ehisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ehisaw.ntuh.gov.tw
// ==/UserScript==

(function () {
    'use strict';

    /* global __doPostBack, $SelectedNote, CopyNoteToNewRecord, Sys */

    const STORAGE_KEY = 'ntuh_weekend_progress';
    const OPTIONS_KEY = 'ntuh_weekend_options';   // 記住上次選擇（含員編）
    const PATH = window.location.pathname;

    const KEEP_PLAN_TEXT = 'Keep current management';

    const DEFAULT_OPTIONS = {
        reviewer: 'keep',   // 'keep' = 維持原本 VS；'unify' = 統一填入員編
        reviewerId: '',
        plan: 'copy',       // 'copy' = 複製上一則；'keep' = 填入 Keep current management
        mode: 'copy',       // 'prewrite' = 週五預寫草稿；'confirm' = 當日確認草稿；'copy' = 複製最新一則
        days: 2,            // prewrite：往後幾天
        vsids: [],          // prewrite：第 1、2、… 天的覆核 VS（員編）
    };

    const DRAFT_HOUR = '09';  // 預寫草稿的時間
    const MAX_DAYS = 7;

    function loadOptions() {
        try {
            return Object.assign({}, DEFAULT_OPTIONS,
                JSON.parse(localStorage.getItem(OPTIONS_KEY)) || {});
        } catch { return Object.assign({}, DEFAULT_OPTIONS); }
    }
    function saveOptions(o) {
        try { localStorage.setItem(OPTIONS_KEY, JSON.stringify(o)); } catch { /* */ }
    }

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

    if (PATH.includes('NoticeDrScheduling.aspx')) { onReady(captureSchedule, 1500); }
    else if (PATH.includes('OpenWard.aspx')) onReady(initOrchestrator, 1500);
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

        createFAB();
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
        }, state.options?.mode === 'prewrite' ? 180000 : 90000);
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

    function startBatch(options) {
        const patients = getPatients();
        if (patients.length === 0) { alert('找不到病人清單'); return; }

        const state = { running: true, patients, currentIndex: 0, results: [], options: options || DEFAULT_OPTIONS };
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

    // --- Orchestrator UI ---

    // 共用右下角 dock：同頁多支腳本的浮動按鈕排進同一個容器，避免互相覆蓋（誰先載入誰建立）
    function getDock() {
        let d = document.getElementById('ntuh-dock');
        if (!d) {
            d = document.createElement('div');
            d.id = 'ntuh-dock';
            d.style.cssText = 'position:fixed;right:8px;bottom:64px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font:14px system-ui,sans-serif';
            document.body.appendChild(d);
        }
        return d;
    }

    function createFAB() {
        if (document.getElementById('ntuh-batch-fab')) return;

        const fab = document.createElement('button');
        fab.type = 'button';
        fab.id = 'ntuh-batch-fab';
        fab.textContent = '週末病程';
        fab.onclick = () => { showOptionsDialog(); };
        // 與晨間簡報同一做法：複製「歷史」按鈕的 class／style 插在它後面（外觀與字重自動一致）；
        // 晨間簡報已在的話接在它後面，順序固定為 歷史 → 晨間簡報 → 週末病程
        const anchor = document.getElementById('NTUHWeb1_QueryInPatientPersonAccountControl1_ButtonBedPatientHistory')
            || document.querySelector('[id$="QueryInPatientPersonAccountControl1_ButtonBedPatientHistory"]');
        if (anchor) {
            fab.className = anchor.className;
            fab.style.cssText = anchor.style.cssText;
            const prev = document.getElementById('ntuh-mb-btn') || anchor;
            prev.insertAdjacentElement('afterend', fab);
            fab.before(document.createTextNode(' '));
            return;
        }
        Object.assign(fab.style, {
            pointerEvents: 'auto',
            padding: '8px 14px', background: '#e67e22', color: '#fff',
            border: 'none', borderRadius: '18px', fontSize: '14px',
            fontWeight: 'bold', cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
        });
        fab.onmouseenter = () => { fab.style.background = '#d35400'; };
        fab.onmouseleave = () => { fab.style.background = '#e67e22'; };
        getDock().appendChild(fab);
    }

    function showOptionsDialog() {
        const patients = getPatients();
        if (patients.length === 0) { alert('找不到病人清單'); return; }

        const saved = loadOptions();
        // 預設模式依星期：週五 → 預寫；週六日 → 確認草稿；其他 → 上次用的（沒有就複製）
        const dow = new Date().getDay();
        const defaultMode = dow === 5 ? 'prewrite' : (dow === 6 || dow === 0) ? 'confirm' : (saved.mode || 'copy');
        const defaultDays = Math.min(Math.max(saved.days || 2, 1), MAX_DAYS);

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', zIndex: '999999',
            background: 'rgba(0,0,0,0.5)', display: 'flex',
            alignItems: 'center', justifyContent: 'center',
        });

        const box = document.createElement('div');
        Object.assign(box.style, {
            background: '#fff', borderRadius: '12px', padding: '24px',
            maxWidth: '480px', width: '90%', maxHeight: '90vh', overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px',
            color: '#222', boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        });
        box.addEventListener('click', e => e.stopPropagation());

        box.innerHTML = `
            <div style="font-size:17px;font-weight:bold;text-align:center">⚡ 週末病程（${patients.length} 位）</div>

            <div>
                <div style="font-weight:bold;margin-bottom:6px">模式</div>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-mode" value="prewrite"> 週五預寫：建立假日的草稿並暫存（復健科）
                </label>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-mode" value="confirm"> 當日確認：把今天的草稿帶入 TPR／導管後送出
                </label>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-mode" value="copy"> 複製最新一則（Subjective 填 stable）後送出
                </label>
            </div>

            <div id="wp-sec-prewrite" style="background:#f7f7f7;border-radius:8px;padding:10px 12px">
                <div style="margin-bottom:8px">
                    往後幾天：<input type="number" id="wp-days" min="1" max="${MAX_DAYS}" style="width:50px;padding:3px 6px;border:1px solid #bbb;border-radius:4px">
                    <span style="color:#777;font-size:12px">（時間 ${DRAFT_HOUR}:00，Plan＝${KEEP_PLAN_TEXT}，Assessment 清空）</span>
                </div>
                <div id="wp-vs-list"></div>
                <div id="wp-sch-status" style="margin-top:6px;font-size:12px;color:#777"></div>
            </div>

            <div id="wp-sec-reviewer">
                <div style="font-weight:bold;margin-bottom:6px">覆核者</div>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-rev" value="keep"> 維持原本 VS
                </label>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-rev" value="unify"> 統一填入員編
                    <input type="text" id="wp-rev-id" placeholder="員編" maxlength="12"
                        style="width:110px;margin-left:6px;padding:3px 6px;border:1px solid #bbb;border-radius:4px">
                </label>
            </div>

            <div id="wp-sec-plan">
                <div style="font-weight:bold;margin-bottom:6px">Plan</div>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-plan" value="copy"> 複製上一則
                </label>
                <label style="display:block;margin:4px 0;cursor:pointer">
                    <input type="radio" name="wp-plan" value="keep"> 填入「${KEEP_PLAN_TEXT}」
                </label>
            </div>

            <div id="wp-warn" style="display:none;color:#c0392b;font-weight:bold"></div>

            <div style="display:flex;gap:8px;justify-content:flex-end">
                <button id="wp-cancel" style="padding:8px 18px;background:#ccc;color:#333;border:none;border-radius:6px;cursor:pointer">取消</button>
                <button id="wp-go" style="padding:8px 22px;background:#e67e22;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer">開始執行</button>
            </div>
        `;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const modeRadios = [...box.querySelectorAll('input[name="wp-mode"]')];
        const revRadios  = [...box.querySelectorAll('input[name="wp-rev"]')];
        const planRadios = [...box.querySelectorAll('input[name="wp-plan"]')];
        const idInput    = box.querySelector('#wp-rev-id');
        const daysInput  = box.querySelector('#wp-days');
        const vsList     = box.querySelector('#wp-vs-list');
        const warn       = box.querySelector('#wp-warn');
        const secPre     = box.querySelector('#wp-sec-prewrite');
        const secRev     = box.querySelector('#wp-sec-reviewer');
        const secPlan    = box.querySelector('#wp-sec-plan');

        (modeRadios.find(r => r.value === defaultMode) || modeRadios[0]).checked = true;
        (revRadios.find(r => r.value === saved.reviewer) || revRadios[0]).checked = true;
        (planRadios.find(r => r.value === saved.plan) || planRadios[0]).checked = true;
        idInput.value = saved.reviewerId || '';
        daysInput.value = defaultDays;

        const curMode = () => modeRadios.find(r => r.checked)?.value || 'copy';

        // 每天一個 VS 欄位：優先帶入主治班表的當日值班員編；
        // 沒班表的天，第 1 天改動會連動其他沒班表、也沒手改過的天
        let schedule = loadSchedule();
        const vsDefault = (saved.vsids || []).find(Boolean) || '';
        const schStatus = box.querySelector('#wp-sch-status');
        const renderVs = () => {
            const n = Math.min(Math.max(parseInt(daysInput.value, 10) || 1, 1), MAX_DAYS);
            const old = [...vsList.querySelectorAll('input')].map(i => ({ v: i.value, edited: i.dataset.edited === '1' }));
            vsList.innerHTML = '';
            let have = 0;
            for (let i = 0; i < n; i++) {
                const row = document.createElement('div');
                row.style.cssText = 'margin:4px 0';
                const lab = document.createElement('span');
                lab.style.cssText = 'display:inline-block;width:150px';
                const dt = addDays(i + 1);
                const sch = schedule[dateKey(dt)];
                lab.textContent = `+${i + 1} 天（${dt.getMonth() + 1}/${dt.getDate()}）VS：`;
                const inp = document.createElement('input');
                inp.type = 'text'; inp.maxLength = 12; inp.placeholder = '員編';
                inp.style.cssText = 'width:110px;padding:3px 6px;border:1px solid #bbb;border-radius:4px';
                const o = old[i];
                if (o?.edited) { inp.value = o.v; inp.dataset.edited = '1'; }
                else if (sch) inp.value = sch.n;
                else inp.value = o?.v || saved.vsids?.[i] || vsDefault;
                if (sch) { inp.dataset.sch = '1'; have++; }
                inp.addEventListener('input', () => { inp.dataset.edited = '1'; });
                row.append(lab, inp);
                if (sch?.name) {
                    const nm = document.createElement('span');
                    nm.textContent = ' ' + sch.name;
                    nm.style.cssText = 'margin-left:6px;color:#555';
                    row.appendChild(nm);
                }
                vsList.appendChild(row);
            }
            const first = vsList.querySelector('input');
            first?.addEventListener('input', () => {
                vsList.querySelectorAll('input').forEach(i => {
                    if (i !== first && !i.dataset.sch && i.dataset.edited !== '1') i.value = first.value;
                });
            });
            schStatus.innerHTML = have === n
                ? `主治班表：${n} 天皆已帶入（員編請核對）`
                : `主治班表：${have}/${n} 天有資料；缺的請先<a href="${SCHEDULE_URL}" target="_blank" style="color:#2c5f8a">開一次排班頁</a>（會自動記下）`;
        };
        daysInput.addEventListener('change', renderVs);
        renderVs();
        // 每次開對話框都背景抓一次當月班表（伺服器記得最後選的科部，直接 GET ?op=query 就有班表；失敗就維持快取）
        fetchScheduleBestEffort(ok => { if (ok) { schedule = loadSchedule(); renderVs(); } });

        const syncId = () => {
            const unify = revRadios.find(r => r.checked)?.value === 'unify';
            idInput.disabled = !unify;
            idInput.style.opacity = unify ? '1' : '0.45';
        };
        const syncMode = () => {
            const m = curMode();
            secPre.style.display = m === 'prewrite' ? '' : 'none';
            secRev.style.display = m === 'prewrite' ? 'none' : '';
            secPlan.style.display = m === 'copy' ? '' : 'none';  // 確認草稿不動 Plan
        };
        revRadios.forEach(r => r.addEventListener('change', syncId));
        modeRadios.forEach(r => r.addEventListener('change', syncMode));
        idInput.addEventListener('focus', () => {
            revRadios.find(r => r.value === 'unify').checked = true;
            syncId();
        });
        syncId();
        syncMode();

        const close = () => overlay.remove();
        box.querySelector('#wp-cancel').onclick = close;
        overlay.onclick = close;

        box.querySelector('#wp-go').onclick = () => {
            const mode = curMode();
            const options = {
                mode,
                reviewer: revRadios.find(r => r.checked)?.value || 'keep',
                reviewerId: idInput.value.trim(),
                plan: planRadios.find(r => r.checked)?.value || 'copy',
                days: parseInt(daysInput.value, 10) || 1,
                vsids: [...vsList.querySelectorAll('input')].map(i => i.value.trim()),
            };
            if (mode === 'prewrite') {
                if (options.vsids.some(v => !v)) {
                    warn.textContent = '請填好每一天的覆核 VS 員編';
                    warn.style.display = 'block';
                    return;
                }
            } else if (options.reviewer === 'unify' && !options.reviewerId) {
                warn.textContent = '請輸入要統一填入的員編';
                warn.style.display = 'block';
                idInput.focus();
                return;
            }
            saveOptions(options);
            close();
            startBatch(options);
        };
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
            pointerEvents: 'auto',
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
        getDock().appendChild(el);
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

    function getBatchOptions() {
        try {
            const state = JSON.parse(
                window.opener?.sessionStorage?.getItem(STORAGE_KEY)
            );
            return Object.assign({}, DEFAULT_OPTIONS, state?.options || {});
        } catch { return Object.assign({}, DEFAULT_OPTIONS); }
    }

    // ── Plan：把所有有內容的 PAP Plan 欄位改成 Keep current management ──
    function applyPlanOption(options) {
        if (options.plan !== 'keep') return;
        let filled = 0;
        for (let i = 1; i <= 20; i++) {
            const plan = document.getElementById(
                `NTUHWeb1_ProgressNoteMainTab_ucPAP_txbPlan${i}`
            );
            if (!plan) continue;
            if (plan.disabled || !plan.offsetParent) continue;  // 跳過隱藏的 PAP 模板
            fillField(`NTUHWeb1_ProgressNoteMainTab_ucPAP_txbPlan${i}`, KEEP_PLAN_TEXT);
            filled++;
        }
        return filled;
    }

    // ── 覆核者：統一填入員編 ──
    // 欄位樣式：NTUHWeb1_<Tab>MainTab_ucDoctorInfo_vsid
    const REVIEWER_FIELD_IDS = [
        'NTUHWeb1_ProgressNoteMainTab_ucDoctorInfo_vsid',
        'NTUHWeb1_BlankNoteMainTab_ucDoctorInfo_vsid',
    ];

    function findReviewerField() {
        for (const id of REVIEWER_FIELD_IDS) {
            const el = document.getElementById(id);
            if (el && !el.disabled && el.offsetParent) return el;
        }
        // fallback：任何可見的 ucDoctorInfo_vsid（其他 Note 類型）
        return [...document.querySelectorAll('input[id$="ucDoctorInfo_vsid"]')]
            .find(el => !el.disabled && el.offsetParent) || null;
    }

    function applyReviewerOption(options) {
        if (options.reviewer !== 'unify' || !options.reviewerId) return true;
        const el = findReviewerField();
        if (!el) return false;
        el.value = options.reviewerId;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
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
        const mode = getBatchOptions().mode;
        if (mode === 'prewrite') { prewriteProcess(); return; }
        if (mode === 'confirm') { confirmDraftProcess(); return; }

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

        // 覆核者（Blank Note 無 PAP，不套用 Plan 選項）
        const blankOptions = getBatchOptions();
        if (!applyReviewerOption(blankOptions)) {
            resultLabel += ' (覆核者未填)';
        }

        await new Promise(r => setTimeout(r, blankOptions.reviewer === 'unify' ? 1200 : 300));

        if (!contentField.value.trim()) {
            fillField('NTUHWeb1_BlankNoteMainTab_txbBlankContnt', 'stable');
            await new Promise(r => setTimeout(r, 300));
        }

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

        // Plan 與覆核者
        const options = getBatchOptions();
        applyPlanOption(options);
        const reviewerOk = applyReviewerOption(options);
        if (!reviewerOk) resultLabel += ' (覆核者未填)';

        // 覆核者欄位可能觸發 autopostback 帶出姓名，多等一會兒
        await new Promise(r => setTimeout(r, options.reviewer === 'unify' ? 1200 : 300));

        // postback 後若欄位被重繪清空，補回來
        const subjEl = document.getElementById('NTUHWeb1_ProgressNoteMainTab_txbSubject');
        if (subjEl && !subjEl.value.trim()) {
            fillField('NTUHWeb1_ProgressNoteMainTab_txbSubject', 'stable');
            applyPlanOption(options);
            if (reviewerOk) applyReviewerOption(options);
            await new Promise(r => setTimeout(r, 300));
        }

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
    // MODULE C：預寫草稿／確認草稿（週五預寫 → 假日當天確認）
    // ═══════════════════════════════════════════════════════════

    const P = 'NTUHWeb1_ProgressNoteMainTab_';
    const $id = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // 等下一次 UpdatePanel postback 結束（先註冊再 click）；timeout 保底
    function nextPostback(timeout = 5000) {
        return new Promise(resolve => {
            let done = false, handler = null, prm = null;
            const fin = () => {
                if (done) return;
                done = true;
                if (prm && handler) prm.remove_endRequest(handler);
                setTimeout(resolve, 400);
            };
            if (window.Sys?.WebForms?.PageRequestManager) {
                prm = Sys.WebForms.PageRequestManager.getInstance();
                handler = fin;
                prm.add_endRequest(handler);
            }
            setTimeout(fin, timeout);
        });
    }

    async function clickAndWait(el, timeout) {
        const wait = nextPostback(timeout);
        el.click();
        await wait;
    }

    function dateKey(d) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d; }

    // 統一讀取病程清單（兩種 DOM：grvSOList／tblNoteList）
    // → [{ type, mmdd, flag, link }]，type 已轉小寫
    function scanNotes() {
        const out = [];
        for (let i = 0; i < 80; i++) {
            const typeEl = $id(`NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_Type`);
            if (!typeEl) break;
            const nameEl = $id(`NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_NoteName`);
            const dateEl = $id(`NTUHWeb1_ucProgressNoteList_grvSOList_ctrl${i}_InsertDateTime`);
            const type = typeEl.textContent.trim();
            const name = nameEl?.textContent?.trim() || '';
            out.push({
                type: isProgressNote(type, name) ? 'progress' : type,
                mmdd: dateEl?.textContent?.trim() || '',
                flag: (typeEl.closest('tr')?.textContent || '').includes('暫') ? 'draft' : '',
                link: nameEl,
            });
        }
        if (out.length) return out;
        document.querySelectorAll('#tblNoteList tbody tr[notetype]').forEach(tr => {
            if (tr.getAttribute('islastverion') === 'false') return;
            const dt = (tr.getAttribute('insertdatetime') || '').split(' ')[0].replace(/\//g, '-');
            const cf = (tr.getAttribute('completeflag') || '').trim();
            out.push({
                type: tr.getAttribute('notetype'),
                mmdd: dt.slice(5),
                flag: cf === 'R' || cf === 'V' ? 'done' : 'draft',
                link: tr.querySelector('a.candidateNameTD'),
            });
        });
        return out;
    }

    // ── 日期／時間：沿用同學版的「穩定偵測」——表單載入後會自己重設日期，
    //    要等值停止變動再改，改完還要再穩定一秒才算數 ──
    function setDraftDateTime(target) {
        const want = dateKey(target);
        return new Promise(resolve => {
            const start = Date.now();
            let lastKey = null, lastChange = start;
            const iv = setInterval(() => {
                const now = Date.now();
                const h = $id(P + 'ucInsertDateTime_HourInput');
                if (h && h.value !== DRAFT_HOUR) h.value = DRAFT_HOUR;
                if (now - start > 15000) { clearInterval(iv); resolve(false); return; }

                const y = $id(P + 'ucInsertDateTime_YearInput');
                const m = $id(P + 'ucInsertDateTime_MonthInput');
                const d = $id(P + 'ucInsertDateTime_DayInput');
                if (!(y && m && d && y.value && m.value && d.value)) return;

                const key = `${y.value}-${m.value}-${d.value}`;
                if (key !== lastKey) { lastKey = key; lastChange = now; return; }
                if (now - lastChange < 500) return;

                if (key !== want) {
                    y.value = String(target.getFullYear());
                    m.value = String(target.getMonth() + 1).padStart(2, '0');
                    d.value = String(target.getDate()).padStart(2, '0');
                    lastKey = want; lastChange = now;
                    return;
                }
                if (now - lastChange >= 1000 && h?.value === DRAFT_HOUR) {
                    clearInterval(iv);
                    resolve(true);
                }
            }, 150);
        });
    }

    async function createDraft(offset, vsid) {
        const target = addDays(offset);
        const tag = `+${offset}天(${target.getMonth() + 1}/${target.getDate()})`;

        const insertBtn = $id('NTUHWeb1_btnInsertProgressNote');
        if (!insertBtn) return `${tag}：找不到新增Progress按鈕`;
        insertBtn.click();   // 實測不觸發 UpdatePanel endRequest，不等 postback；由下面的日期穩定偵測接手
        await sleep(300);

        if (!(await setDraftDateTime(target))) return `${tag}：日期欄位未穩定`;

        const f = {
            vsid: $id(P + 'ucDoctorInfo_vsid'),
            assess: $id(P + 'ucPAP_txbAssessment1'),
            plan: $id(P + 'ucPAP_txbPlan1'),
            save: $id(P + 'btnSaveProgressNote'),
        };
        const missing = Object.keys(f).filter(k => !f[k]);
        if (missing.length) return `${tag}：欄位不存在(${missing.join(',')})`;

        // 與同學版一致：直接賦值、不觸發事件（避免 autopostback 重繪洗掉其他欄位）
        f.vsid.value = vsid;
        f.assess.value = '';
        f.plan.value = KEEP_PLAN_TEXT.toLowerCase();
        f.save.click();   // 同上：不觸發 endRequest，固定等待讓暫存送出
        await sleep(1500);
        return null;
    }

    // 全部建完後再看清單（清單不一定即時刷新，所以只當提示、不當失敗）
    async function verifyDrafts(offsets) {
        const want = offsets.map(o => dateKey(addDays(o)).slice(5));
        for (let i = 0; i < 15; i++) {
            const notes = scanNotes();
            if (!notes.length) return '清單讀不到，未驗證';
            const have = new Set(notes.filter(n => n.type === 'progress').map(n => n.mmdd));
            const missing = want.filter(m => !have.has(m));
            if (!missing.length) return '';
            await sleep(400);
        }
        return `清單暫未見 ${want.filter(m => !new Set(scanNotes().map(n => n.mmdd)).has(m)).join('、')}（可能只是尚未刷新，請抽查）`;
    }

    async function prewriteProcess() {
        try {
            const opts = getBatchOptions();
            const existing = new Set(scanNotes().filter(n => n.type === 'progress').map(n => n.mmdd));
            const made = [], skipped = [], problems = [];

            for (let i = 0; i < opts.days; i++) {
                const offset = i + 1;
                const vsid = opts.vsids[i] || opts.vsids[0] || '';
                const mmdd = dateKey(addDays(offset)).slice(5);
                if (existing.has(mmdd)) { skipped.push(`+${offset}`); continue; }
                const err = await createDraft(offset, vsid);
                if (err) { problems.push(err); break; }  // 失敗就停，避免後面疊出殘缺草稿
                made.push(`+${offset}`);
            }

            const vmsg = made.length ? await verifyDrafts(made.map(x => +x.slice(1))) : '';
            const parts = [];
            if (made.length) parts.push(`✓ 已建草稿 ${made.join(' ')}`);
            if (vmsg) parts.push(`⚠ ${vmsg}`);
            if (skipped.length) parts.push(`已存在略過 ${skipped.join(' ')}`);
            if (problems.length) parts.push(`⚠ ${problems.join('；')}`);
            notifyOpener((parts.join('；') || '無需建立'));
        } catch (e) {
            notifyOpener('預寫錯誤：' + (e?.message || e));
        }
    }

    // ── 當日確認：選取今日草稿 → 清 Subjective/填 stable → TPR → 導管 → 送出 ──

    function waitHasData(id, timeout) {
        return new Promise(resolve => {
            const ok = () => $id(id)?.getAttribute('hasdata') === 'Y';
            if (ok()) { resolve(true); return; }
            const start = Date.now();
            const iv = setInterval(() => {
                if (ok()) { clearInterval(iv); resolve(true); }
                else if (Date.now() - start > timeout) { clearInterval(iv); resolve(false); }
            }, 50);
        });
    }

    // 生命徵象 accordion 的「選取」連結：T/P/R/BP/…（沿用同學版的 ctrl 0-3,5）
    const TPR_ITEMS = [0, 1, 2, 3, 5].map(n => `ctl00_VitalSignList_ctrl${n}_lkbSelectData`);

    async function pullVitals() {
        const header = $id('ui-accordion-accordion-header-0');
        if (!header) return '生命徵象區塊不存在';
        header.click();
        const has = await waitHasData('divVitalSignData', 5000);

        const clickItems = () => TPR_ITEMS.map($id).filter(Boolean).forEach(b => b.click());
        const obj = $id(P + 'txbObject');
        const assess = $id(P + 'ucPAP_txbAssessment1');
        // 與同學版一致：Objective、Assessment 各清空後點一次欄位再帶入 TPR
        if (obj) { obj.value = ''; obj.click(); clickItems(); }
        if (assess) { assess.value = ''; assess.click(); clickItems(); }
        return has ? '' : '無生命徵象';
    }

    async function pullCatheters() {
        const bsi = $id(P + 'txbBSIBundle');
        const header = $id('ui-accordion-accordion-header-1');
        if (!bsi || !header) return '';
        bsi.value = '';
        bsi.click();
        header.click();
        await waitHasData('divBSIData', 5000);
        for (let i = 0; ; i++) {
            const b = $id(`ctl00_BSIList_ctrl${i}_lkbSelectData`);
            if (!b) break;
            b.click();
        }
        return '';
    }

    async function confirmDraftProcess() {
        try {
            const today = dateKey(new Date()).slice(5);
            const todays = scanNotes().filter(n => n.type === 'progress' && n.mmdd === today && n.link);
            if (!todays.length) { notifyOpener('無今日草稿'); return; }
            const pick = todays.find(n => n.flag === 'draft') || todays[0];

            await clickAndWait(pick.link, 6000);

            const confirmBtn = $id(P + 'btnConfirmProgressNote');
            if (!confirmBtn || !confirmBtn.offsetParent || confirmBtn.disabled) {
                notifyOpener('今日病程已送出');
                return;
            }

            const opts = getBatchOptions();
            const notes = [];

            // Subjective：空的才補 stable
            const subj = $id(P + 'txbSubject');
            if (!subj) { notifyOpener('Subjective 欄位不存在'); return; }
            if (!subj.value.trim()) fillField(P + 'txbSubject', 'stable');

            const vErr = await pullVitals();
            if (vErr) notes.push(vErr);
            await pullCatheters();

            // 覆核者（預設維持草稿上週五指定的 VS）
            if (!applyReviewerOption(opts)) notes.push('覆核者未填');

            // 時間超過 10 點系統會擋，壓回 10
            const hour = $id(P + 'ucInsertDateTime_HourInput');
            if (hour) {
                const h = parseInt(hour.value, 10);
                if (!isNaN(h) && h > 10) { hour.value = '10'; notes.push('時間改回10點'); }
            }

            await sleep(opts.reviewer === 'unify' ? 1200 : 300);

            await clickAndWait(confirmBtn, 6000);

            // 驗證：只有 tblNoteList 版本有可靠的 completeflag；grvSOList 的「暫」判斷未實測，不拿來擋
            if ($id('tblNoteList')) {
                const mine = scanNotes().filter(n => n.type === 'progress' && n.mmdd === today);
                if (mine.length && mine.every(n => n.flag === 'draft')) {
                    notifyOpener('⚠ 送出後仍是草稿，請手動確認' + (notes.length ? `（${notes.join('、')}）` : ''));
                    return;
                }
            }
            notifyOpener('✓ 已送出' + (notes.length ? `（${notes.join('、')}）` : ''));
        } catch (e) {
            notifyOpener('確認錯誤：' + (e?.message || e));
        }
    }

    // ═══════════════════════════════════════════════════════════
    // MODULE D：主治班表 → 每日值班員編（給預寫模式的 VS 欄位預設值）
    //   排班頁 NoticeDrScheduling.aspx 的 #tblContent：每天一格，
    //   <font class="tooltip">姓名<br>(簡碼:…)<br>8日8時~9日8時<font class="tooltiptext">員編</font></font>
    //   員編是 6 碼字串（前面有 0，如 005941），一律當字串。
    // ═══════════════════════════════════════════════════════════

    const SCHEDULE_KEY = 'ntuh_dr_schedule';   // { 'YYYY-MM-DD': { n: 員編, name } }
    const SCHEDULE_URL = 'https://ehisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx?op=query';

    function loadSchedule() {
        try { return JSON.parse(GM_getValue(SCHEDULE_KEY, '{}')) || {}; } catch { return {}; }
    }
    function saveSchedule(sch) {
        try { GM_setValue(SCHEDULE_KEY, JSON.stringify(sch)); } catch { /* */ }
    }

    // 解析一份排班頁文件 → { y, m, entries } 或 null（沒有班表／月份對不上）
    function parseScheduleDoc(doc) {
        const table = doc.getElementById('tblContent');
        if (!table) return null;
        const cells = [];
        table.querySelectorAll('font.tooltip').forEach(el => {
            const empNo = (el.querySelector('.tooltiptext')?.textContent || '').trim();
            if (!empNo) return;
            const first = [...el.childNodes].find(n => n.nodeType === 3 && n.textContent.trim());
            const m = (el.textContent || '').replace(empNo, '').match(/(\d+)日\d+時\s*[~～]/);
            if (!m) return;
            const td = el.closest('td');
            cells.push({
                day: +m[1],
                col: td?.parentElement ? [...td.parentElement.children].indexOf(td) : -1,  // 0＝星期日
                empNo,
                name: first ? first.textContent.trim() : '',
            });
        });
        if (!cells.length) return null;

        // 月份：優先頁面文字，其次由今天往前後找「每格星期幾都對得上」的月份
        const text = doc.body?.textContent || '';
        const cand = [];
        let mm = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (mm) cand.push([+mm[1], +mm[2]]);
        mm = text.match(/(\d{2,3})\s*年\s*(\d{1,2})\s*月/);
        if (mm && +mm[1] < 200) cand.push([+mm[1] + 1911, +mm[2]]);
        const now = new Date();
        for (let k = 0; k <= 24; k++) {
            for (const off of (k ? [k, -k] : [0])) {
                const d = new Date(now.getFullYear(), now.getMonth() + off, 1);
                cand.push([d.getFullYear(), d.getMonth() + 1]);
            }
        }
        const fits = ([y, mo]) => cells.every(c => {
            const d = new Date(y, mo - 1, c.day);
            return d.getMonth() === mo - 1 && (c.col < 0 || d.getDay() === c.col);
        });
        const hit = cand.find(fits);
        if (!hit) return null;

        const entries = {};
        cells.forEach(c => {
            entries[dateKey(new Date(hit[0], hit[1] - 1, c.day))] = { n: c.empNo, name: c.name };
        });
        return { y: hit[0], m: hit[1], entries };
    }

    // 併入儲存：整月覆蓋、清掉 45 天前的舊資料
    function mergeSchedule(parsed) {
        const sch = loadSchedule();
        const prefix = `${parsed.y}-${String(parsed.m).padStart(2, '0')}-`;
        Object.keys(sch).forEach(k => { if (k.startsWith(prefix)) delete sch[k]; });
        Object.assign(sch, parsed.entries);
        const cutoff = dateKey(addDays(-45));
        Object.keys(sch).forEach(k => { if (k < cutoff) delete sch[k]; });
        saveSchedule(sch);
        return Object.keys(parsed.entries).length;
    }

    // 排班頁：看到班表就記下來（每月開一次即可）
    function captureSchedule() {
        let tries = 0;
        const iv = setInterval(() => {
            tries++;
            const parsed = parseScheduleDoc(document);
            if (parsed) {
                clearInterval(iv);
                const n = mergeSchedule(parsed);
                const t = document.createElement('div');
                t.textContent = `已記下 ${parsed.y}/${parsed.m} 主治班表（${n} 天），週末病程預寫可自動帶入員編`;
                t.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:rgba(0,0,0,.85);color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif';
                document.body.appendChild(t);
                setTimeout(() => t.remove(), 4000);
            } else if (tries >= 20) clearInterval(iv);
        }, 500);
    }

    // 病房列表：試著直接抓排班頁（跨網域，靠 GM_xmlhttpRequest 帶 ehisaw 的 cookie；失敗就靜默，改用已記下的資料）
    function fetchScheduleBestEffort(cb) {
        try {
            GM_xmlhttpRequest({
                method: 'GET', url: SCHEDULE_URL, timeout: 8000,
                onload(res) {
                    try {
                        const doc = new DOMParser().parseFromString(res.responseText, 'text/html');
                        const parsed = parseScheduleDoc(doc);
                        if (parsed) { mergeSchedule(parsed); cb(true); } else cb(false);
                    } catch { cb(false); }
                },
                onerror() { cb(false); }, ontimeout() { cb(false); },
            });
        } catch { cb(false); }
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

                const reviewerOk = applyReviewerOption(getBatchOptions());

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
                    notifyOpener('✓ (從admission建立)' + (reviewerOk ? '' : ' (覆核者未填)'));
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
