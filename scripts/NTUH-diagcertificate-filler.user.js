// ==UserScript==
// @name         NTUH DiagCertificate & Consent Integrated Filler
// @namespace    http://tampermonkey.net/
// @version      1.7.2
// @description  自動填入診斷書，利用背景分頁與 postMessage 跨網域通訊自動擷取手術同意書回傳
// @author       YT / Twb06
// @updateURL    https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/NTUH-diagcertificate-filler.user.js
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @grant        GM_openInTab
// ==/UserScript==

(function () {
    'use strict';

    // 記錄目前觸發背景掃描的唯一 token，用於比對 postMessage 回傳
    let currentScanToken = null;

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function initRouter() {
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");

            // 初始化接收端：監聽子視窗以 postMessage 回傳的同意書資料
            window.addEventListener('message', function(event) {
                // 安全性：只接受來自 ihisaw.ntuh.gov.tw 的訊息
                if (!event.origin.includes('ihisaw.ntuh.gov.tw')) return;
                const msg = event.data;
                if (!msg || msg.ntuh !== true) return;
                // 比對 token，確保是本次觸發的掃描結果，防止多分頁或多次觸發混淆
                if (!currentScanToken || msg.token !== currentScanToken) {
                    console.warn('[DiagFiller] 忽略 token 不符的 postMessage', msg.token, '≠', currentScanToken);
                    return;
                }
                if (msg.data !== undefined) {
                    handleReceivedConsent(msg.data);
                    currentScanToken = null; // 使用後清除，避免重複接收
                }
            });
            setTimeout(createDiagUI, 1500);
        }
        else if (currentUrl.includes('PatientConsentOrderEntry')) {
            const ntuhToken = new URLSearchParams(window.location.search).get('ntuh_token');
            const isOrchestratorWindow = !!window.opener && !!ntuhToken;
            if (isOrchestratorWindow) {
                // 儲存 token 至 sessionStorage，避免頁面內部跳轉後遺失
                sessionStorage.setItem('ntuh_window_token', ntuhToken);
                console.log("[DiagFiller] 偵測到背景掃描分頁(PatientConsentOrderEntry)，啟動同意書擷取並準備回傳...");
                runConsentExtractorAndReturn();
            }
            // 一般主畫面瀏覽：window.opener 為 null 或無 token，不執行任何動作
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

    function parseDate(dateStr) {
        if (!dateStr) return null;
        const clean = dateStr.substring(0, 10).trim().replace(/-/g, '/');
        const d = new Date(clean);
        return isNaN(d.getTime()) ? null : d;
    }

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    }

    function waitForEl(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const check = () => {
                const selectors = selector.split(',');
                for (const sel of selectors) {
                    const el = document.querySelector(sel.trim());
                    if (el) {
                        if ((el.id && el.id.includes('Msg')) || el.className.includes('errorMsgText')) {
                            if (el.textContent.trim()) return el;
                        } else {
                            return el;
                        }
                    }
                }
                return null;
            };

            const el = check();
            if (el) return resolve(el);

            const obs = new MutationObserver(() => {
                const el = check();
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
        const checkExist = () => {
            const selectors = waitSelector.split(',');
            for (const sel of selectors) {
                const el = document.querySelector(sel.trim());
                if (el) {
                    if ((el.id && el.id.includes('Msg')) || el.className.includes('errorMsgText')) {
                        if (el.textContent.trim()) return el;
                    } else {
                        return el;
                    }
                }
            }
            return null;
        };
        if (checkExist()) return;
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
    // 抓取門診日期
    function fetchOpdDates(currentDept) {
        // 從門診參考資料的區塊內搜尋所有的列
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory tr.tableText2'));
        const dates = [];
        for (const tr of rows) {
            // 讀取該列對應的科部名稱 (多層 fallback 確保相容性)
            let recordDept = '';
            const deptSpan = tr.querySelector('span[id*="lblHfDeptName"]');
            if (deptSpan && deptSpan.textContent.trim()) {
                recordDept = deptSpan.textContent.trim();
            } else {
                // Fallback 1: 從 lblDeptName 的 title 屬性中提取 (例如 "科別：家庭醫學部")
                const lblDept = tr.querySelector('span[id*="lblDeptName"]');
                if (lblDept) {
                    const title = lblDept.getAttribute('title') || '';
                    const match = title.match(/科別：\s*([^\s\n]+)/);
                    if (match) {
                        recordDept = match[1].trim();
                    } else if (lblDept.textContent.trim()) {
                        recordDept = lblDept.textContent.trim();
                    }
                }
            }

            // 比對是否與開立診斷書的科部相符
            let isMatch = false;
            const clean = s => s.replace(/(部|科|門診)$/, '').trim();
            const cleanCurrent = (currentDept && currentDept !== '[科別]' && currentDept !== '[請選擇]') ? clean(currentDept) : '';
            const cleanRecord = recordDept ? clean(recordDept) : '';

            if (!cleanCurrent) {
                // 若當前診斷書科別無效/空白，預設不過濾（相容舊邏輯，防止抓不到資料）
                isMatch = true;
            } else if (!cleanRecord) {
                // 若此列門診紀錄無法辨識科別，預設不過濾
                isMatch = true;
            } else {
                isMatch = cleanCurrent.includes(cleanRecord) || cleanRecord.includes(cleanCurrent);
            }

            console.log(`[DiagFiller] 門診科別比對: 診斷書科別="${currentDept}" (簡化: "${cleanCurrent}"), 此列科別="${recordDept}" (簡化: "${cleanRecord}") -> 結果: ${isMatch ? '符合' : '不符'}`);

            if (isMatch) {
                const matches = tr.textContent.match(/\d{4}\/\d{2}\/\d{2}/g);
                if (matches) {
                    dates.push(...matches);
                }
            }
        }
        const uniqueDates = [...new Set(dates)];
        // 由舊到新排序
        uniqueDates.sort((a, b) => new Date(a) - new Date(b));
        return uniqueDates;
    }

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

        // 依照模板組合門診文字
    function buildOpdText(dates, startDateStr, dept) {
        if (!dates || dates.length === 0) return '';
        let filtered = dates;
        if (startDateStr && startDateStr.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
            const start = new Date(startDateStr.replace(/-/g, '/'));
            filtered = dates.filter(d => new Date(d) >= start);
        }
        if (filtered.length === 0) return '';

        let dateStr = '';
        let currentYear = null;

        filtered.forEach((d, idx) => {
            const [y, m, day] = d.split('/');
            const mNum = parseInt(m, 10);
            const dNum = parseInt(day, 10);

            if (y !== currentYear) {
                if (idx !== 0) dateStr += '、';
                dateStr += `西元${y}年${mNum}月${dNum}日`;
                currentYear = y;
            } else {
                dateStr += `、${mNum}月${dNum}日`;
            }
        });

        const deptName = (dept.endsWith('科') || dept.endsWith('部')) ? dept : dept + '科';
        return `於${dateStr}至本院${deptName}門診追蹤`;
    }

    function buildText({
        hasInpat, hasOpd, hasOp,
        opdDates, opdStartDate,
        inpat, emg, dept,
        opDate, opName, dischargeDate
    }) {
        const events = [];

        // 1. 門診事件
        if (hasOpd && opdDates && opdDates.length > 0) {
            let filtered = opdDates;
            if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                const start = parseDate(opdStartDate);
                if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
            }
            if (filtered.length > 0) {
                const opdMinDateObj = parseDate(filtered[0]);
                const opdText = buildOpdText(opdDates, opdStartDate, dept);
                if (opdText) {
                    events.push({
                        type: 'opd',
                        date: opdMinDateObj,
                        text: opdText
                    });
                }
            }
        }

        // 2. 住院與手術事件合併判定
        const cleanInpatStart = inpat && inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
        const fromEmg = !!(emg && emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);
        const inpatStart = fromEmg && emg && emg.arrivalDT ? emg.arrivalDT : (inpat ? inpat.inpatStartDate : '');
        const inpatStartDateObj = parseDate(inpatStart);

        const opDateObj = parseDate(opDate);
        const dischargeDateObj = parseDate(dischargeDate);

        // 判斷手術是否在住院期間 (若是，則合併至住院事件中)
        let isOpMerged = false;
        if (hasInpat && hasOp && opDateObj && inpatStartDateObj && dischargeDateObj) {
            if (opDateObj >= inpatStartDateObj && opDateObj <= dischargeDateObj) {
                isOpMerged = true;
            }
        }

        // 3. 住院事件
        if (hasInpat && inpatStartDateObj && inpat) {
            let inpatText = '';
            if (fromEmg) {
                const aStr = emg.arrivalDT ? fmtDateTime(emg.arrivalDT) : fmtDate(inpat.inpatStartDate);
                const lStr = emg.leaveDT ? fmtDateTime(emg.leaveDT) : fmtDate(inpat.inpatStartDate);
                inpatText = `於${aStr}至本院急診就醫，於${lStr}轉至本院${dept}一般病房住院`;
            } else {
                inpatText = `於${fmtDate(inpat.inpatStartDate)}於本院${dept}一般病房住院`;
            }

            // 合併手術描述
            if (isOpMerged) {
                inpatText += `，於${fmtDate(opDate)}接受${opName ? opName + '手術' : '手術'}`;
            }

            // ICU 描述
            if (inpat.hasICU) {
                inpatText += `，於${fmtDate(inpat.icuStart)}轉入本院加護病房治療`;
                if (inpat.wardAfterICU) {
                    inpatText += `，於${fmtDate(inpat.wardAfterICU)}轉入本院${dept}一般病房`;
                }
            }

            // 出院描述
            if (dischargeDate) {
                const dp = dischargeDate.split('/');
                const dFmt = `西元${dp[0]}年${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
                inpatText += `，於${dFmt}出院`;
            }

            events.push({
                type: 'inpat',
                date: inpatStartDateObj,
                text: inpatText
            });
        }

        // 4. 獨立手術事件 (未被合併時)
        if (hasOp && opDateObj && !isOpMerged) {
            events.push({
                type: 'op',
                date: opDateObj,
                text: `於${fmtDate(opDate)}接受${opName ? opName + '手術' : '手術'}`
            });
        }

        // 5. 排序事件 (依據 date 由舊到新)
        events.sort((a, b) => a.date - b.date);

        if (events.length === 0) return '';

        // 6. 拼接文字
        if (events.length === 1) {
            const ev = events[0];
            let txt = `病人因上述原因，${ev.text}`;
            if (ev.type === 'inpat') {
                txt += `，出院後宜於門診持續追蹤治療。`;
            } else {
                txt += `。`;
            }
            return txt;
        }

        // 多個勾選
        let txt = '病人因上述原因，';
        events.forEach((ev, idx) => {
            if (idx > 0) txt += '，';
            txt += ev.text;
        });

        // 檢查住院事件後方是否有實質門診事件 (門診日期大於出院日期)
        const inpatIdx = events.findIndex(ev => ev.type === 'inpat');
        let hasOpdAfterInpat = false;
        if (inpatIdx !== -1 && hasOpd && opdDates && opdDates.length > 0) {
            const disDate = parseDate(dischargeDate);
            if (disDate) {
                hasOpdAfterInpat = opdDates.some(d => {
                    const parsedD = parseDate(d);
                    return parsedD && parsedD > disDate;
                });
            }
        }

        if (inpatIdx !== -1 && !hasOpdAfterInpat) {
            txt += `，出院後宜於門診持續追蹤治療。`;
        } else {
            txt += `。`;
        }

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
            const hasInpatUI = document.getElementById('ntuh-diag-has-inpat')?.checked;
            const hasOpdUI = document.getElementById('ntuh-diag-has-opd')?.checked;
            const hasOpUI = document.getElementById('ntuh-diag-has-op')?.checked;

            const dischargeDate = document.getElementById('ntuh-diag-discharge').value.trim();
            if (hasInpatUI && !dischargeDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) { setDiagStatus('⚠ 請輸入正確出院日期（YYYY/MM/DD）', 'err'); if (runBtn) runBtn.disabled = false; return; }
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();

            // 1. 展開門診資料 (有勾選門診才展開)
            let opdDates = [];
            let opdStartDate = '';
            if (hasOpdUI) {
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_divOutHistoryInfo', 5000);
                opdDates = fetchOpdDates(dept);
                opdStartDate = document.getElementById('ntuh-diag-opd-start-date').value.trim();
            }

            // 2. 住院與急診資料 (有勾選住院才展開)
            let inpat = { inpatStartDate: '', hasICU: false, icuStart: '', wardAfterICU: '' };
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            if (hasInpatUI) {
                setDiagStatus('展開住院資料…', 'warn');
                await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
                inpat = fetchInpatData();

                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try { emg = fetchEmgData(); } catch (e) { console.warn(e.message); }
            }

            // 3. 手術資料 (有勾選手術才展開)
            let opDate = '', opName = '';
            if (hasOpUI) {
                setDiagStatus('展開手術資料…', 'warn');
                await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_divOpScheduleInfo');
                const autoOp = fetchOpData();
                opDate = document.getElementById('ntuh-diag-op-date')?.value.trim() || autoOp.opDate;
                opName = document.getElementById('ntuh-diag-op-name')?.value.trim() || autoOp.opName;
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = !!(emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);

            const txt = buildText({
                hasInpat: hasInpatUI, hasOpd: hasOpdUI, hasOp: hasOpUI,
                opdDates, opdStartDate,
                inpat, emg, dept,
                opDate, opName, dischargeDate
            });

            fillField('NTUHWeb1_InstructionSetItem', txt);

            const sdEl = document.getElementById('NTUHWeb1_tbxStartDate');
            const edEl = document.getElementById('NTUHWeb1_tbxEndDate');
            const cbxI = document.getElementById('NTUHWeb1_cbxI');
            const cbxE = document.getElementById('NTUHWeb1_cbxE');

            let webStartDate = todayStr();
            let webEndDate = todayStr();

            if (hasInpatUI) {
                webStartDate = fromEmg && emg.arrivalDT ? emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/') : (cleanInpatStart || todayStr());
                webEndDate = dischargeDate;

                if (cbxI && !cbxI.checked) { cbxI.checked = true; cbxI.dispatchEvent(new Event('change', { bubbles: true })); }
                if (fromEmg && cbxE && !cbxE.checked) { cbxE.checked = true; cbxE.dispatchEvent(new Event('change', { bubbles: true })); }
            } else {
                if (cbxI && cbxI.checked) { cbxI.checked = false; cbxI.dispatchEvent(new Event('change', { bubbles: true })); }
                if (cbxE && cbxE.checked) { cbxE.checked = false; cbxE.dispatchEvent(new Event('change', { bubbles: true })); }

                if (hasOpdUI && opdDates.length > 0) {
                    let filtered = opdDates;
                    if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                        const start = parseDate(opdStartDate);
                        if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
                    }
                    if (filtered.length > 0) {
                        webStartDate = filtered[0];
                        webEndDate = filtered[filtered.length - 1];
                    }
                } else if (hasOpUI && opDate) {
                    webStartDate = opDate;
                    webEndDate = opDate;
                }
            }

            if (sdEl) sdEl.value = webStartDate;
            if (edEl) edEl.value = webEndDate;

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

                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <label><input type="checkbox" id="ntuh-diag-has-inpat" checked /> <span>住院</span></label>
                </div>

                <div id="ntuh-diag-discharge-row" style="display:flex;align-items:center;gap:8px;"><span>出院日期</span><input id="ntuh-diag-discharge" type="text" /></div>

                <div style="display:flex;align-items:center;gap:6px;">
                    <label><input type="checkbox" id="ntuh-diag-has-opd" /> <span>有門診</span></label>
                </div>
                <div id="ntuh-diag-opd-detail" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span>起始日期</span>
                    <input id="ntuh-diag-opd-start-date" type="text" placeholder="YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-op" /> <span>手術</span></label></div>
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

        // 住院區塊打勾與隱藏出院日期
        document.getElementById('ntuh-diag-has-inpat').addEventListener('change', function() {
            const dischargeRow = document.getElementById('ntuh-diag-discharge-row');
            if (dischargeRow) {
                dischargeRow.style.display = this.checked ? 'flex' : 'none';
            }
        });

        // 門診區塊：打勾後自動展開、讀取最早日期
        document.getElementById('ntuh-diag-has-opd').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-opd-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory [id*="Msg"], #NTUHWeb1_fieldsetOutHistory .errorMsgText', 5000);
                const opdDates = fetchOpdDates();
                if (opdDates.length > 0) {
                    document.getElementById('ntuh-diag-opd-start-date').value = opdDates[0];
                    setDiagStatus('已讀取門診日期', 'ok');
                } else {
                    setDiagStatus('未找到門診紀錄', 'warn');
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        // 初始化自動抓取並預填手術資料
        try {
            setDiagStatus('展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_lblOpScheduleMsg');

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

                // 產生唯一 token：時間戳 + 隨機字串，確保每次掃描獨立，防止多分頁混淆
                const token = 'ntuh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                currentScanToken = token;

                const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry.aspx` +
                                  `?SESSION=${session}&PatClass=I&AccountIDSE=${accountId}&PersonID=${personId}&Hosp=T0&ntuh_token=${token}`;

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
        // 從 URL 讀取 token（或 sessionStorage 作為備援）
        const token = new URLSearchParams(window.location.search).get('ntuh_token') ||
                      sessionStorage.getItem('ntuh_window_token') || '';
        try {
            await waitForEl('a[id*="ClickConsentShowList"]', 8000);
            await sleep(600);

            const links = Array.from(document.querySelectorAll('a[id*="ClickConsentShowList"]'));
            const consentList = [];
            const session = new URLSearchParams(window.location.search).get('SESSION') || '';

            links.forEach(link => {
                const id = link.id;
                const matchCtrl = id.match(/PatientConsentDataList_(ctl\d+)_ClickConsentShowList/);
                if (!matchCtrl) return;
                const controlName = matchCtrl[1];

                const emrCodeEl = document.getElementById(`PatientConsentDataList_${controlName}_EMRCode`);
                const emrIdseEl = document.getElementById(`PatientConsentDataList_${controlName}_EMRIDSE`);

                const emrCode = emrCodeEl ? emrCodeEl.value.trim() : '';
                const emrIdse = emrIdseEl ? emrIdseEl.value.trim() : '';

                if (!emrCode || !emrIdse) return;

                const fullTitle = link.textContent.trim();
                let title = fullTitle;
                let dateStr = '';
                let statusStr = '未簽';

                const bracketMatch = fullTitle.match(/^([\s\S]+?)\s*\(\s*(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})\s*(.*?)\s*\)$/);
                if (bracketMatch) {
                    title = bracketMatch[1].trim();
                    const rawDate = bracketMatch[2];
                    const rawTime = bracketMatch[3];
                    const extra = bracketMatch[4] || '';

                    const dateParts = rawDate.split('/');
                    if (dateParts[0].length === 2) {
                        dateParts[0] = '20' + dateParts[0];
                    }
                    dateStr = `${dateParts.join('/')} ${rawTime}`;

                    if (extra.includes('已簽') || extra.includes('已簽署')) {
                        statusStr = '已簽署';
                    }
                } else {
                    const simpleMatch = fullTitle.match(/^([\s\S]+?)\s*\(\s*(已簽署|已簽)\s*\)$/);
                    if (simpleMatch) {
                        title = simpleMatch[1].trim();
                        statusStr = '已簽署';
                    }
                }

                if (title.includes('同意書') && (title.includes('術') || title.includes('檢查'))) {
                    const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/PatientBasicInfoEdit/SimpleInfoShowUsingPlaceHolder.aspx` +
                                      `?SESSION=${session}&Func=EMRRecordSeries&EMRIDSE=${emrIdse}&EMRRecord=${emrCode}&AllowPrint=Y`;

                    consentList.push({
                        date: dateStr || todayStr(),
                        title: title,
                        status: statusStr,
                        url: targetUrl
                    });
                }
            });

            // 透過 postMessage 將資料回傳給主視窗（opener）
            if (window.opener) {
                window.opener.postMessage(
                    { ntuh: true, token, data: consentList },
                    'https://hisaw.ntuh.gov.tw'
                );
                console.log('[ConsentHelper] 資料已透過 postMessage 回傳，共', consentList.length, '筆');
            } else {
                console.warn('[ConsentHelper] 無法取得 opener，資料無法回傳');
            }

            await sleep(100);
            console.log('[DiagFiller] 資料發射完畢，準備自毀分頁...');
            window.close();

        } catch (e) {
            console.error('[ConsentHelper] 背景讀取新網頁失敗或逾時：', e.message);
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