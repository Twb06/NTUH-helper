// ==UserScript==
// @name         NTUH DiagCertificate & Consent Integrated Filler
// @namespace    http://tampermonkey.net/
// @version      4.2
// @description  自動填入診斷書，利用背景分頁與跨網域沙盒 (GM_setValue) 自動擷取手術同意書回傳
// @author       潘岳彤 / Twb06
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/ConfirmDiagnosisOrder*
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(function () {
    'use strict';

    // 跨分頁沙盒鍵值
    const TM_STORAGE_KEY = 'ntuh_consent_cross_domain_data';

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function initRouter() {
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");

            // 初始化接收端：監聽 Tampermonkey 沙盒的跨網域資料變動
            if (typeof GM_addValueChangeListener !== 'undefined') {
                GM_addValueChangeListener(TM_STORAGE_KEY, function(key, oldValue, newValue, remote) {
                    // remote 代表是「其他分頁」寫入的變更
                    if (remote && newValue) {
                        try {
                            const parsed = JSON.parse(newValue);
                            // 確保是剛出爐的新資料才處理
                            if (parsed && parsed.data) {
                                handleReceivedConsent(parsed.data);
                            }
                        } catch(e) {
                            console.error('[DiagFiller] 資料解析失敗', e);
                        }
                    }
                });
            }
            setTimeout(createDiagUI, 1500);
        }
        else if (currentUrl.includes('ConfirmDiagnosisOrder')) {
            console.log("[DiagFiller] 偵測到病人主畫面，啟動背景同意書擷取並準備回傳...");
            runConsentExtractorAndReturn();
        }
    }

    // =========================================================================
    // 共用工具函數與 UI 狀態
    // =========================================================================
    const ICU_SET = new Set([
        '01A1','03A1','03A2','03B','03B1','03B2',
        '03C','03C1','03C2','04A1','04A2','04B1',
        '04B2','04C1','04C2','04D1','04FI','5CVI',
        '06E1','0PII','0PIM','0PIN','0PNI','0PNO'
    ]);

    function fmtDate(s) {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `西元${d.getFullYear()}年${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日`;
    }

    function fmtDateTime(s) {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `西元${d.getFullYear()}年${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日${String(d.getHours()).padStart(2,'0')}時${String(d.getMinutes()).padStart(2,'0')}分`;
    }

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    }

    function waitForEl(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const el = document.querySelector(selector);
            if (el) return resolve(el);
            const obs = new MutationObserver(() => {
                const el = document.querySelector(selector);
                if (el) { obs.disconnect(); resolve(el); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error('timeout: ' + selector)); }, timeout);
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 修正的 simulateClick：優先使用原生 click 以避開 Sandbox View 錯誤
    function simulateClick(el) {
        if (typeof el.click === 'function') {
            el.click();
            return;
        }
        ['mousedown','mouseup','click'].forEach(type =>
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
        );
    }

    async function expandOne(btnId, waitSelector, timeoutMs = 8000) {
        if (document.querySelector(waitSelector)) return;
        const btn = document.getElementById(btnId);
        if (!btn) { console.warn('[DiagFiller] 找不到按鈕：', btnId); return; }
        simulateClick(btn);
        try { await waitForEl(waitSelector, timeoutMs); } catch(e) { console.warn('[DiagFiller] 展開逾時：', waitSelector); }
        await sleep(200);
    }

    function setDiagStatus(msg, type) {
        const el = document.getElementById('ntuh-diag-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'diag-ok' : type === 'err' ? 'diag-err' : 'diag-warn';
    }

    // =========================================================================
    // 模組一：診斷書畫面核心邏輯與資料抓取
    // =========================================================================
    function fetchInpatData() {
        const rows = [];
        const trs = Array.from(document.querySelectorAll('#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_gvwLogPatTransferBed tr.tableText2'));
        for (const tr of trs) {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 5) continue;
            const deptSpan = tds[0].querySelector('span[id*="lblDeptName"]');
            if (!deptSpan) continue;
            const fullTitle = deptSpan.getAttribute('title') || '';
            const wardMatch = fullTitle.match(/病房：\s*([^\s\n]+)/);
            const startMatch = fullTitle.match(/起日：\s*([^\s\n]+)/);
            const endMatch = fullTitle.match(/迄日：\s*([^\s\n]*)/);
            const bed = wardMatch ? wardMatch[1].trim() : '';
            const sd = startMatch ? startMatch[1].trim() : '';
            let ed = endMatch ? endMatch[1].trim() : '';
            if (ed === '0001/01/01') ed = '';
            if (sd) rows.push({ bed, start: sd, end: ed });
        }
        if (rows.length === 0) return { inpatStartDate: '', hasICU: false, icuStart: '', wardAfterICU: '' };
        let inpatStartDate = rows[0].start;
        let hasICU = false; let icuStart = ''; let wardAfterICU = '';
        const validTimeline = [rows[0]];
        for (let i = 1; i < rows.length; i++) {
            const currentEvent = rows[i - 1]; const historicalEvent = rows[i];
            if (historicalEvent.end && historicalEvent.end === currentEvent.start) {
                inpatStartDate = historicalEvent.start; validTimeline.unshift(historicalEvent);
            } else { break; }
        }
        for (const r of validTimeline) {
            const ward = r.bed;
            if (ICU_SET.has(ward)) { hasICU = true; if (!icuStart) icuStart = r.start; }
            else { if (hasICU && !wardAfterICU) wardAfterICU = r.start; }
        }
        return { inpatStartDate, hasICU, icuStart, wardAfterICU };
    }

    function fetchOpData() {
        let opDate = '', opName = '', bestDate = null;
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_dgOpScheduleData tr.tableText2'));
        for (const tr of rows) {
            const tds = tr.querySelectorAll('td'); if (tds.length < 5) continue;
            const classSpan = tds[0].querySelector('span[id*="PatClassCode"]'); if (!classSpan) continue;
            const fullTitle = classSpan.getAttribute('title') || '';
            const catMatch = fullTitle.match(/類別：\s*([^\s\n]+)/);
            const catStr = catMatch ? catMatch[1].trim() : classSpan.textContent.trim();
            if (catStr !== '住院') continue;
            const dateSpan = tds[1].querySelector('span[id*="OPDateString"]'); if (!dateSpan) continue;
            const dateStr = dateSpan.textContent.trim(); if (!dateStr.match(/^\d{4}\/\d{2}\/\d{2}$/)) continue;
            let currentOpName = '';
            const hfOpSpan = tds[3].querySelector('span[id*="lblHfMainOpMode"]');
            if (hfOpSpan && hfOpSpan.textContent.trim()) { currentOpName = hfOpSpan.textContent.trim(); }
            else { const opModeMatch = fullTitle.match(/術式：\s*([\s\S]+)$/); currentOpName = opModeMatch ? opModeMatch[1].trim() : tds[3].textContent.trim(); }
            if (currentOpName.includes('\n')) { currentOpName = currentOpName.split('\n')[0].replace(/^\d+\.\s*/, '').trim(); }
            const d = new Date(dateStr.replace(/-/g, '/'));
            if (!bestDate || d > bestDate) { bestDate = d; opDate = dateStr; opName = currentOpName; }
        }
        return { opDate, opName };
    }

    function fetchEmgData() {
        let arrivalDT = '', leaveDT = '', leaveDate = '';
        const emgRows = Array.from(document.querySelectorAll('#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_gvwEmgHistory tr.tableText2'));
        if (emgRows.length === 0) return { arrivalDT, leaveDT, leaveDate };
        const latestRow = emgRows[0]; const tds = latestRow.querySelectorAll('td');
        if (tds.length >= 2) {
            const registerSpan = tds[0].querySelector('span[id*="lblRegisterDate"]');
            if (registerSpan) { const regTitle = registerSpan.getAttribute('title'); arrivalDT = (regTitle && regTitle.match(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)) ? regTitle.trim() : registerSpan.textContent.trim(); }
            const dischargeSpan = tds[1].querySelector('span[id*="lblDischargeDate"]');
            if (dischargeSpan) { const disTitle = dischargeSpan.getAttribute('title'); leaveDT = (disTitle && disTitle.match(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/)) ? disTitle.trim() : dischargeSpan.textContent.trim(); }
        }
        if (leaveDT) leaveDate = leaveDT.substring(0, 10).trim().replace(/-/g, '/');
        return { arrivalDT, leaveDT, leaveDate };
    }

    function buildText({ fromEmg, arrivalDT, leaveDT, inpatStartDate, dept, opDate, opName, hasICU, icuStart, wardAfterICU, dischargeDate }) {
        let txt = '';
        if (fromEmg) {
            const aStr = arrivalDT ? fmtDateTime(arrivalDT) : fmtDate(inpatStartDate);
            const lStr = leaveDT ? fmtDateTime(leaveDT) : fmtDate(inpatStartDate);
            txt += `病人因上述原因，於${aStr}至本院急診就醫，於${lStr}轉至本院${dept}一般病房住院，`;
        } else { txt += `病人因上述原因，於${fmtDate(inpatStartDate)}於本院${dept}一般病房住院，`; }
        if (opDate) txt += `於${fmtDate(opDate)}接受${opName ? opName + '手術' : '手術'}，`;
        if (hasICU) { txt += `於${fmtDate(icuStart)}轉入本院加護病房治療，`; if (wardAfterICU) txt += `於${fmtDate(wardAfterICU)}轉入本院${dept}一般病房，`; }
        const dp = dischargeDate.split('/'); const dFmt = `西元${dp[0]}年${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
        txt += `於${dFmt}出院，出院後宜於門診持續追蹤治療。`;
        return txt;
    }

    function fillField(id, value) {
        const el = document.getElementById(id); if (!el) return false;
        el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    async function runDiagFiller() {
        try {
            const runBtn = document.getElementById('ntuh-diag-run'); if (runBtn) runBtn.disabled = true;
            const dischargeDate = document.getElementById('ntuh-diag-discharge').value.trim();
            if (!dischargeDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) { setDiagStatus('⚠ 請輸入正確出院日期（YYYY/MM/DD）', 'err'); if (runBtn) runBtn.disabled = false; return; }
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();

            setDiagStatus('展開住院資料…', 'warn');
            await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText');
            setDiagStatus('展開急診資料…', 'warn');
            await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText');
            setDiagStatus('展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText');

            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            try { setDiagStatus('讀取急診動向資料…', 'warn'); await sleep(200); emg = fetchEmgData(); } catch (e) { console.warn(e.message); }

            const inpat = fetchInpatData();
            const autoOp = fetchOpData();
            const hasOpUI = document.getElementById('ntuh-diag-has-op')?.checked;
            let opDate = '', opName = '';

            if (hasOpUI) {
                opDate = document.getElementById('ntuh-diag-op-date')?.value.trim() || autoOp.opDate;
                opName = document.getElementById('ntuh-diag-op-name')?.value.trim() || autoOp.opName;
            } else if (autoOp.opDate) {
                document.getElementById('ntuh-diag-has-op').checked = true; document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                document.getElementById('ntuh-diag-op-date').value = autoOp.opDate; document.getElementById('ntuh-diag-op-name').value = autoOp.opName;
                opDate = autoOp.opDate; opName = autoOp.opName;
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = !!(emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);

            const txt = buildText({
                fromEmg, arrivalDT: emg.arrivalDT, leaveDT: emg.leaveDT, inpatStartDate: inpat.inpatStartDate,
                dept, opDate, opName, hasICU: inpat.hasICU, icuStart: inpat.icuStart, wardAfterICU: inpat.wardAfterICU, dischargeDate
            });

            fillField('NTUHWeb1_InstructionSetItem', txt);
            const sdEl = document.getElementById('NTUHWeb1_tbxStartDate'); const edEl = document.getElementById('NTUHWeb1_tbxEndDate');
            const startDate = fromEmg && emg.arrivalDT ? emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/') : (cleanInpatStart || todayStr());
            if (sdEl) sdEl.value = startDate; if (edEl) edEl.value = dischargeDate;

            const cbxI = document.getElementById('NTUHWeb1_cbxI'); if (cbxI && !cbxI.checked) { cbxI.checked = true; cbxI.dispatchEvent(new Event('change', { bubbles: true })); }
            if (fromEmg) { const cbxE = document.getElementById('NTUHWeb1_cbxE'); if (cbxE && !cbxE.checked) { cbxE.checked = true; cbxE.dispatchEvent(new Event('change', { bubbles: true })); } }
            const rbnNotOri = document.getElementById('NTUHWeb1_rbnIsNotOriDoctor'); if (rbnNotOri && !rbnNotOri.checked) { rbnNotOri.checked = true; rbnNotOri.dispatchEvent(new Event('change', { bubbles: true })); }

            await sleep(300); const btnQueryDr = document.getElementById('NTUHWeb1_btnQueryDr'); if (btnQueryDr) simulateClick(btnQueryDr);
            await sleep(1500); const btnSaveTemp = document.getElementById('NTUHWeb1_btnSaveTemp'); if (btnSaveTemp) simulateClick(btnSaveTemp);

            const previewEl = document.getElementById('ntuh-diag-preview'); if (previewEl) { previewEl.style.display = 'block'; previewEl.textContent = txt; }
            setDiagStatus('✓ 填入完成！請確認後開立。', 'ok');
        } catch (e) { console.error(e); setDiagStatus('✗ 錯誤：' + e.message, 'err'); }
        const runBtn = document.getElementById('ntuh-diag-run'); if (runBtn) runBtn.disabled = false;
    }

    // =========================================================================
    // 跨網域通訊接收端：更新主畫面 UI
    // =========================================================================
    function handleReceivedConsent(list) {
        const container = document.getElementById('ntuh-diag-consent-result-box');
        if (!container) return;

        container.style.display = 'block';
        if (!list || list.length === 0) {
            container.innerHTML = `<div style="color:#a0aec0; font-size:11px; padding:4px 0;">⚠️ 未偵測到手術/術式相關同意書。</div>`;
            setDiagStatus('✓ 背景掃描完成，未發現手術/術式同意書', 'ok');
            return;
        }

        let html = `<div style="font-weight:bold; color:#ff7597; font-size:11px; margin-top:4px; border-top:1px dashed #2d3650; padding-top:6px;">📋 擷取到手術/術式同意書 (點擊開啟)：</div>`;
        html += `<ul style="margin:0; padding-left:14px; font-size:12px; line-height:1.6; max-height:150px; overflow-y:auto;">`;
        list.forEach(item => {
            html += `
                <li style="margin-bottom: 4px; list-style-type: square;">
                    <span style="color:#7a8aaa; font-size:11px;">[${item.date}]</span><br>
                    <a href="${item.url}" target="_blank" style="color:#63b3ed; font-weight:bold; text-decoration:underline;">
                        ${item.title}
                    </a>
                    <span style="color:#48bb78; font-size:11px;">(${item.status})</span>
                </li>`;
        });
        html += `</ul>`;
        container.innerHTML = html;
        setDiagStatus('✓ 同意書背景跨網讀取成功！', 'ok');
    }

    function makeDraggable(panel, handle) {
        let startX, startY, startLeft, startTop;
        handle.onmousedown = e => {
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = startLeft + 'px'; panel.style.top = startTop + 'px';
            document.onmousemove = e => {
                panel.style.left = (startLeft + e.clientX - startX) + 'px';
                panel.style.top = (startTop + e.clientY - startY) + 'px';
            };
            document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; };
        };
    }

    async function createDiagUI() {
        if (document.getElementById('ntuh-diag-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-diag-fab { position: fixed; bottom: 80px; right: 24px; width: 48px; height: 48px; border-radius: 50%; background: #2a1f3a; border: 2px solid #9a7cdc; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 99999; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: transform 0.15s, box-shadow 0.15s; user-select: none; }
            #ntuh-diag-fab:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
            #ntuh-diag-panel { position: fixed; bottom: 80px; right: 24px; width: 320px; background: #1a1f2e; border: 1px solid #2d3650; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); z-index: 99999; font-family: 'Consolas',monospace; font-size: 12px; color: #c8d3e8; overflow: hidden; display: none; }
            #ntuh-diag-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #2a1f3a; border-bottom: 1px solid #2d3650; cursor: move; user-select: none; font-size: 13px; font-weight: 600; }
            #ntuh-diag-close { background: none; border: none; color: #7a8aaa; cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; }
            #ntuh-diag-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
            #ntuh-diag-discharge-row { display: flex; align-items: center; gap: 8px; }
            #ntuh-diag-discharge { flex: 1; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8; font-size: 12px; padding: 5px 8px; }
            #ntuh-diag-run { padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #6a3cac; color: #fff; }
            #ntuh-diag-run:disabled { opacity: 0.5; cursor: not-allowed; }
            #ntuh-diag-preview { display: none; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; padding: 8px; font-size: 11px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; color: #a8c0e8; }
            .diag-ok { color: #3fb950; } .diag-err { color: #e05c5c; } .diag-warn { color: #f0a030; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-diag-fab'; fab.textContent = '📋'; document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-diag-panel';
        panel.innerHTML = `
            <div id="ntuh-diag-header"><span>📋 診斷書囑言填入</span><button id="ntuh-diag-close">✕</button></div>
            <div id="ntuh-diag-body">
                <div style="font-size:11px;color:#7a8aaa;">自動讀取病歷，填入囑言與日期。<span style="color:#f0a030;">病名請自行填寫。</span></div>
                <div id="ntuh-diag-discharge-row"><span>出院日期</span><input id="ntuh-diag-discharge" type="text" /></div>
                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-op" /> <span>有手術</span></label></div>
                <div id="ntuh-diag-op-detail" style="display:none;flex-direction:column;gap:6px;">
                    <input id="ntuh-diag-op-date" type="text" placeholder="手術日期 YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                    <input id="ntuh-diag-op-name" type="text" placeholder="手術名稱" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>
                <button id="ntuh-diag-run">✨ 自動填入囑言</button>
                <button id="ntuh-diag-open-consent" type="button" style="padding:6px 0; border:1px solid #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; font-weight:600; width:100%;">🔍 背景檢查電子同意書項目</button>
                <div id="ntuh-diag-status"></div>
                <div id="ntuh-diag-consent-result-box" style="display:none;"></div>
                <div id="ntuh-diag-preview"></div>
            </div>
        `;
        document.body.appendChild(panel);
        document.getElementById('ntuh-diag-discharge').value = todayStr();

        // 初始化自動抓取並預填手術資料
        try {
            setDiagStatus('展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText');

            const initialOpData = fetchOpData();
            if (initialOpData.opDate || initialOpData.opName) {
                document.getElementById('ntuh-diag-has-op').checked = true;
                document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                if (initialOpData.opDate) document.getElementById('ntuh-diag-op-date').value = initialOpData.opDate;
                if (initialOpData.opName) document.getElementById('ntuh-diag-op-name').value = initialOpData.opName;
            }
        } catch (e) {
            console.warn('[DiagFiller] 初始化預填手術資料失敗：', e);
        }

        document.getElementById('ntuh-diag-has-op').addEventListener('change', function() {
            const detailEl = document.getElementById('ntuh-diag-op-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                if (!document.getElementById('ntuh-diag-op-date').value) document.getElementById('ntuh-diag-op-date').value = todayStr();
            } else { detailEl.style.display = 'none'; }
        });

        fab.onclick = () => { fab.style.display = 'none'; panel.style.display = 'block'; };
        document.getElementById('ntuh-diag-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-diag-header'));
        document.getElementById('ntuh-diag-run').onclick = () => runDiagFiller();

        // 啟動背景擷取任務
        document.getElementById('ntuh-diag-open-consent').onclick = () => {
            try {
                const currentUrlParams = new URLSearchParams(window.location.search);
                let session = currentUrlParams.get('SESSION') || '';
                let accountId = currentUrlParams.get('AccountIDSE') || '';

                if (!session) { const sEl = document.querySelector('input[name*="SESSION"], input[id*="SESSION"]'); if (sEl) session = sEl.value; }
                if (!accountId) { const aEl = document.querySelector('input[name*="AccountIDSE"], input[id*="AccountIDSE"]'); if (aEl) accountId = aEl.value; }

                let personId = currentUrlParams.get('PersonID') || '';
                if (!personId) {
                    const idEl = document.getElementById('NTUHWeb1_lblPersonID') || document.getElementById('NTUHWeb1_tbxPersonID');
                    if (idEl) personId = idEl.textContent.trim() || idEl.value.trim();
                }
                if (!personId) { alert('無法取得病人 ID'); return; }

                // 強制清空舊的沙盒資料，避免顯示上一次病人的結果
                if (typeof GM_setValue !== 'undefined') {
                    GM_setValue(TM_STORAGE_KEY, '');
                }

                const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/ConfirmDiagnosisOrder.aspx` +
                                  `?SESSION=${session}&PatClass=I&AccountIDSE=${accountId}&PersonID=${personId}&Hosp=T0&EMRPop=Y`;

                setDiagStatus('⏳ 正在跨網域背景開啟並撈取資料...', 'warn');

                if (typeof GM_openInTab !== 'undefined') {
                    GM_openInTab(targetUrl, { active: false, insert: true });
                } else {
                    window.open(targetUrl, '_blank');
                }
            } catch(e) {
                console.error('[DiagFiller]', e);
                setDiagStatus('✗ 開啟失敗: ' + e.message, 'err');
            }
        };
    }

    // =========================================================================
    // 模組二：新頁面自動擷取，並使用沙盒寫入進行跨網域傳輸
    // =========================================================================
    async function runConsentExtractorAndReturn() {
        try {
            const tabSelector = 'a[href="#divPatConsent"][data-toggle="tab"]';
            await waitForEl(tabSelector, 8000);
            const tabBtn = document.querySelector(tabSelector);
            if (tabBtn) { simulateClick(tabBtn); }

            await waitForEl('#divTablePatConsent table', 8000);
            await sleep(600);

            const container = document.getElementById('divTablePatConsent');
            if (!container) return;

            const rows = Array.from(container.querySelectorAll('table tbody tr'));
            const consentList = [];

            rows.forEach(tr => {
                const url = tr.getAttribute('strurl');
                const pElements = tr.querySelectorAll('p');
                if (pElements.length >= 2) {
                    const dateStr = pElements[0].textContent.trim();
                    const titleStr = pElements[1].textContent.trim();
                    const statusStr = pElements[2] ? pElements[2].textContent.trim() : '';

                    if (titleStr.includes('術') && titleStr.includes('同意書') && url) {
                        consentList.push({ date: dateStr, title: titleStr, status: statusStr, url: url });
                    }
                }
            });

            // 將資料包裝並附帶 Timestamp 寫入篡改猴跨域沙盒資料庫
            if (typeof GM_setValue !== 'undefined') {
                const payload = JSON.stringify({
                    timestamp: Date.now(),
                    data: consentList
                });
                GM_setValue(TM_STORAGE_KEY, payload);
                console.log('[ConsentHelper] 資料已寫入跨網域沙盒', payload);
            }

            await sleep(100);
            console.log('[DiagFiller] 資料發射完畢，準備自毀分頁...');
            window.close();

        } catch (e) {
            console.error('[ConsentHelper] 背景讀取失敗或逾時：', e.message);
        }
    }

    // =========================================================================
    // 腳本進入點
    // =========================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initRouter);
    } else {
        initRouter();
    }

})();