// ==UserScript==
// @name         NTUH DiagCertificate Filler
// @namespace    http://tampermonkey.net/
// @version      1.12.0
// @description  自動填入診斷書，利用背景分頁跨網域擷取手術中文名稱
// @author       YT / Twb06
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/ConfirmDiagnosisOrder*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/DREnterOPOrder.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// ==/UserScript==

(function () {
    'use strict';

    let activeOpScanTokens = {};
    let detectedOpList = [];

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function initRouter() {
        clearLegacyCookies();
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");
            setTimeout(createDiagUI, 1500);
        }
        else if (currentUrl.includes('DREnterOPOrder.aspx')) {
            const ntuhToken = new URLSearchParams(window.location.search).get('ntuh_token');
            const isOrchestratorWindow = !!ntuhToken;
            console.log('[DiagFiller] 偵測到 DREnterOPOrder.aspx 頁面');
            console.log('[DiagFiller] ntuh_token 狀態:', ntuhToken);
            if (isOrchestratorWindow) {
                sessionStorage.setItem('ntuh_window_token', ntuhToken);
                console.log("[DiagFiller] 偵測到背景手術醫令入帳頁面(DREnterOPOrder)，啟動手術名稱擷取並準備回傳...");
                runOpNameExtractorAndReturn();
            } else {
                console.warn("[DiagFiller] 未執行掃描：isOrchestratorWindow 判定為假。原因：網址無 token 參數。");
            }
        }
    }

    // =========================================================================
    // 共用工具函數與 UI 狀態
    // =========================================================================
    function clearLegacyCookies() {
        try {
            const cookies = document.cookie.split(';');
            for (let cookie of cookies) {
                const eqPos = cookie.indexOf('=');
                const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
                if (name.includes('ntuh_')) {
                    const domains = ['.ntuh.gov.tw', 'hisaw.ntuh.gov.tw', 'ihisaw.ntuh.gov.tw', ''];
                    const paths = ['/', '/WebApplication'];
                    for (let d of domains) {
                        for (let p of paths) {
                            const domainString = d ? `; domain=${d}` : '';
                            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${domainString}`;
                        }
                    }
                }
            }
            console.log('[DiagFiller] 已主動嘗試清理遺留之 ntuh_ 相關 Cookie，防範 HTTP 400 錯誤。');
        } catch (e) {
            console.error('[DiagFiller] 清理遺留 Cookie 失敗:', e);
        }
    }

    function setSharedData(name, value) {
        if (typeof GM_setValue !== 'undefined') {
            GM_setValue(name, value);
        } else {
            localStorage.setItem(name, value);
        }
    }

    function getSharedData(name) {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(name, '');
        }
        return localStorage.getItem(name) || '';
    }

    function deleteSharedData(name) {
        if (typeof GM_deleteValue !== 'undefined') {
            GM_deleteValue(name);
        } else {
            localStorage.removeItem(name);
        }
    }

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

    function tomorrowStr() {
        const d = new Date();
        d.setDate(d.getDate() + 1);
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

    function waitForElSafe(selector, timeout = 10000) {
        return waitForEl(selector, timeout).catch(() => null);
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    function fetchOpdDates(currentDept) {
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory tr.tableText2'));
        const dates = [];
        for (const tr of rows) {
            let recordDept = '';
            const deptSpan = tr.querySelector('span[id*="lblHfDeptName"]');
            if (deptSpan && deptSpan.textContent.trim()) {
                recordDept = deptSpan.textContent.trim();
            } else {
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

            let isMatch = false;
            const clean = s => s.replace(/(部|科|門診)$/, '').trim();
            const cleanCurrent = (currentDept && currentDept !== '[科別]' && currentDept !== '[請選擇]') ? clean(currentDept) : '';
            const cleanRecord = recordDept ? clean(recordDept) : '';

            if (!cleanCurrent) {
                isMatch = true;
            } else if (!cleanRecord) {
                isMatch = true;
            } else {
                isMatch = cleanCurrent.includes(cleanRecord) || cleanRecord.includes(cleanCurrent);
            }

            if (isMatch) {
                const matches = tr.textContent.match(/\d{4}\/\d{2}\/\d{2}/g);
                if (matches) {
                    dates.push(...matches);
                }
            }
        }
        const uniqueDates = [...new Set(dates)];
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
            const deptMatch = fullTitle.match(/科別：\s*([^\s\n]+)/);
            let dept = deptMatch ? deptMatch[1].trim() : '';
            if (!dept) {
                const hfDept = tds[0].querySelector('span[id*="lblHfDeptName"]');
                if (hfDept && hfDept.textContent.trim()) dept = hfDept.textContent.trim();
            }
            const wardMatch = fullTitle.match(/病房：\s*([^\s\n]+)/);
            const startMatch = fullTitle.match(/起日：\s*([^\s\n]+)/);
            const endMatch = fullTitle.match(/迄日：\s*([^\s\n]*)/);
            const bed = wardMatch ? wardMatch[1].trim() : '';
            const sd = startMatch ? startMatch[1].trim() : '';
            let ed = endMatch ? endMatch[1].trim() : '';
            if (ed === '0001/01/01') ed = '';
            if (sd) rows.push({ bed, start: sd, end: ed, dept });
        }
        if (rows.length === 0) return { inpatStartDate: '', timeline: [] };
        let inpatStartDate = rows[0].start;
        const validTimeline = [rows[0]];
        for (let i = 1; i < rows.length; i++) {
            const currentEvent = rows[i - 1]; const historicalEvent = rows[i];
            if (historicalEvent.end && historicalEvent.end === currentEvent.start) {
                inpatStartDate = historicalEvent.start; validTimeline.unshift(historicalEvent);
            } else { break; }
        }
        return { inpatStartDate, timeline: validTimeline };
    }

    function fetchOpDataList() {
        const opList = [];
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_dgOpScheduleData tr.tableText2'));
        for (const tr of rows) {
            const tds = tr.querySelectorAll('td'); if (tds.length < 5) continue;
            const classSpan = tds[0].querySelector('span[id*="PatClassCode"]'); if (!classSpan) continue;
            if (classSpan.hasAttribute('disabled')) continue; // 排除未執行/已取消的手術
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

            const opBtn = tds[0].querySelector('[id*="btnSetOpDateInfo_"]');
            let opScheduleIdse = '';
            if (opBtn) {
                const match = opBtn.id.match(/btnSetOpDateInfo_([\s\S]+)$/);
                opScheduleIdse = match ? match[1].trim() : '';
            }
            if (!opScheduleIdse) {
                // 備援方案：在整行 HTML 中搜尋符合流水號格式的字串 (例如 2026-T0-066998)
                const trHtml = tr.innerHTML || '';
                const match = trHtml.match(/([A-Za-z0-9]+[-–—][A-Za-z0-9]+[-–—][A-Za-z0-9]+)/);
                if (match) {
                    opScheduleIdse = match[1].trim();
                }
            }

            if (!opList.some(item => item.opDate === dateStr && item.opName === currentOpName)) {
                opList.push({ opDate: dateStr, opName: currentOpName, opScheduleIdse: opScheduleIdse });
            }
        }
        // 按日期從新到舊排序 (最新一筆在 list[0])
        opList.sort((a, b) => new Date(b.opDate) - new Date(a.opDate));
        return opList;
    }

    function fetchOpData() {
        const list = fetchOpDataList();
        if (list.length > 0) {
            return { opDate: list[0].opDate, opName: list[0].opName };
        }
        return { opDate: '', opName: '' };
    }

    function addOpRow(date = '', name = '', opScheduleIdse = '') {
        const container = document.getElementById('ntuh-diag-op-rows-container');
        if (!container) return;

        const isFirst = container.children.length === 0;
        const row = document.createElement('div');
        row.className = 'ntuh-diag-op-row';
        row.setAttribute('data-op-idse', opScheduleIdse);
        row.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid #2d3650; border-radius:6px; background:#141824; position:relative; margin-bottom:4px;';

        let removeBtnHtml = '';
        if (!isFirst) {
            removeBtnHtml = `<button class="ntuh-diag-remove-op-btn" type="button" style="background:none; border:none; color:#e05c5c; cursor:pointer; font-size:14px; padding:0 4px; line-height:1;">✕</button>`;
        }

        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:4px;">
                <input class="ntuh-diag-op-date-input" type="text" placeholder="手術日期 YYYY/MM/DD" value="${date}" style="flex:1; background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
                ${removeBtnHtml}
            </div>
            <input class="ntuh-diag-op-name-input" type="text" placeholder="手術名稱" value="${name}" style="background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
        `;

        if (!isFirst) {
            row.querySelector('.ntuh-diag-remove-op-btn').addEventListener('click', () => {
                row.remove();
            });
        }

        container.appendChild(row);
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
        hasInpat, hasOpd, hasOp, hasEmg,
        opdDates, opdStartDate,
        inpat, emg, dept,
        opEvents, dischargeDate
    }) {
        const events = [];

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

        const cleanInpatStart = inpat && inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
        const fromEmg = !!(emg && emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);
        const inpatStart = fromEmg && emg && emg.arrivalDT ? emg.arrivalDT : (inpat ? inpat.inpatStartDate : '');
        const inpatStartDateObj = parseDate(inpatStart);
        const dischargeDateObj = parseDate(dischargeDate);

        const mergedOps = [];
        const unmergedOps = [];

        if (opEvents && opEvents.length > 0) {
            opEvents.forEach(evt => {
                const evtDateObj = parseDate(evt.date);
                if (hasInpat && inpatStartDateObj && dischargeDateObj && evtDateObj && evtDateObj >= inpatStartDateObj && evtDateObj <= dischargeDateObj) {
                    mergedOps.push(evt);
                } else {
                    unmergedOps.push(evt);
                }
            });
        }

        if (hasInpat && inpatStartDateObj && inpat) {
            const inpatSubEvents = [];
            const timeline = inpat.timeline || [];
            const startDept = (timeline.length > 0 && timeline[0].dept) ? timeline[0].dept : dept;

            // 1. 住院開始子事件
            let startText = '';
            if (fromEmg) {
                const aStr = emg.arrivalDT ? fmtDateTime(emg.arrivalDT) : fmtDate(inpat.inpatStartDate);
                const lStr = emg.leaveDT ? fmtDateTime(emg.leaveDT) : fmtDate(inpat.inpatStartDate);
                startText = `於${aStr}至本院急診就醫，於${lStr}轉至本院${startDept}一般病房住院`;
            } else {
                startText = `於${fmtDate(inpat.inpatStartDate)}於本院${startDept}一般病房住院`;
            }
            inpatSubEvents.push({
                date: inpatStartDateObj,
                priority: 1,
                text: startText
            });

            // 2. 第一步如果是 ICU，補上轉入加護病房的敘述
            if (timeline.length > 0 && ICU_SET.has(timeline[0].bed)) {
                const icuDateObj = parseDate(timeline[0].start) || inpatStartDateObj;
                inpatSubEvents.push({
                    date: icuDateObj,
                    priority: 3,
                    text: `於${fmtDate(timeline[0].start)}轉入本院${timeline[0].dept}加護病房治療`
                });
            }

            // 3. 遍歷住院期間的其他病房/科別異動事件
            for (let i = 1; i < timeline.length; i++) {
                const current = timeline[i];
                const prev = timeline[i - 1];
                const isCurrentICU = ICU_SET.has(current.bed);
                const isPrevICU = ICU_SET.has(prev.bed);
                const currentDateObj = parseDate(current.start) || inpatStartDateObj;

                if (isCurrentICU && !isPrevICU) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}加護病房治療`
                    });
                } else if (!isCurrentICU && isPrevICU) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}一般病房`
                    });
                } else if (!isCurrentICU && !isPrevICU && current.dept && prev.dept && current.dept !== prev.dept) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}一般病房`
                    });
                }
            }

            // 4. 合併住院期間的手術/檢查
            if (mergedOps.length > 0) {
                mergedOps.forEach(evt => {
                    const evtDateObj = parseDate(evt.date) || inpatStartDateObj;
                    inpatSubEvents.push({
                        date: evtDateObj,
                        priority: 2,
                        text: `於${fmtDate(evt.date)}接受${evt.name || '手術'}`
                    });
                });
            }

            // 5. 出院子事件
            if (dischargeDate) {
                const dp = dischargeDate.split('/');
                const dFmt = `西元${dp[0]}年${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
                inpatSubEvents.push({
                    date: dischargeDateObj || inpatStartDateObj,
                    priority: 4,
                    text: `於${dFmt}出院`
                });
            }

            // 對所有住院子事件進行排序：先按日期，同天則按優先權：起點(1) -> 手術(2) -> 轉床(3) -> 出院(4)
            inpatSubEvents.sort((a, b) => {
                if (a.date.getTime() !== b.date.getTime()) {
                    return a.date - b.date;
                }
                return a.priority - b.priority;
            });

            // 拼接所有子事件文字
            let inpatText = '';
            inpatSubEvents.forEach((sev, sidx) => {
                if (sidx > 0) inpatText += '，';
                inpatText += sev.text;
            });

            events.push({
                type: 'inpat',
                date: inpatStartDateObj,
                text: inpatText
            });
        }

        if (hasEmg && emg && emg.arrivalDT && !(hasInpat && fromEmg)) {
            const emgArrivalDateObj = parseDate(emg.arrivalDT);
            if (emgArrivalDateObj) {
                events.push({
                    type: 'emg',
                    date: emgArrivalDateObj,
                    text: `於${fmtDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${fmtDateTime(emg.leaveDT || emg.arrivalDT)}離院`
                });
            }
        }

        // 獨立的手術事件，按日期排序
        if (unmergedOps.length > 0) {
            unmergedOps.forEach(evt => {
                const dObj = parseDate(evt.date);
                if (dObj) {
                    events.push({
                        type: 'op',
                        date: dObj,
                        text: `於${fmtDate(evt.date)}接受${evt.name || '手術'}`
                    });
                }
            });
        }

        events.sort((a, b) => a.date - b.date);

        if (events.length === 0) return '';

        if (events.length === 1) {
            const ev = events[0];
            if (ev.type === 'emg') {
                return `病人於${fmtDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${fmtDateTime(emg.leaveDT || emg.arrivalDT)}離院，宜於門診追蹤治療。`;
            }
            let txt = `病人因上述原因，${ev.text}`;
            if (ev.type === 'inpat') {
                txt += `，出院後宜於門診持續追蹤治療。`;
            } else {
                txt += `。`;
            }
            return txt;
        }

        let txt = '病人因上述原因，';
        events.forEach((ev, idx) => {
            if (idx > 0) txt += '，';
            txt += ev.text;
        });

        const lastEvent = events[events.length - 1];
        if (lastEvent.type === 'inpat') {
            txt += `，出院後宜於門診持續追蹤治療。`;
        } else if (lastEvent.type === 'emg') {
            txt += `，宜於門診追蹤治療。`;
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
            const hasEmgUI = document.getElementById('ntuh-diag-has-emg')?.checked;

            const dischargeDate = document.getElementById('ntuh-diag-discharge').value.trim();
            if (hasInpatUI && !dischargeDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) { setDiagStatus('⚠ 請輸入正確出院日期（YYYY/MM/DD）', 'err'); if (runBtn) runBtn.disabled = false; return; }
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();

            let opdDates = [];
            let opdStartDate = '';
            if (hasOpdUI) {
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_divOutHistoryInfo', 5000);
                opdDates = fetchOpdDates(dept);
                opdStartDate = document.getElementById('ntuh-diag-opd-start-date').value.trim();
            }

            let inpat = { inpatStartDate: '', hasICU: false, icuStart: '', wardAfterICU: '' };
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            if (hasInpatUI) {
                setDiagStatus('展開住院資料…', 'warn');
                await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
                inpat = fetchInpatData();
            }
            if (hasEmgUI || hasInpatUI) {
                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try {
                    const autoEmg = fetchEmgData();
                    const manualArrival = document.getElementById('ntuh-diag-emg-arrival')?.value.trim();
                    const manualLeave = document.getElementById('ntuh-diag-emg-leave')?.value.trim();
                    emg.arrivalDT = manualArrival || autoEmg.arrivalDT;
                    emg.leaveDT = manualLeave || autoEmg.leaveDT;
                    if (emg.leaveDT) emg.leaveDate = emg.leaveDT.substring(0, 10).trim().replace(/-/g, '/');
                } catch (e) {
                    console.warn(e.message);
                }
            }

            const opEvents = [];
            if (hasOpUI) {
                setDiagStatus('展開手術資料…', 'warn');
                await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_divOpScheduleInfo');
                const container = document.getElementById('ntuh-diag-op-rows-container');
                if (container) {
                    const rows = container.getElementsByClassName('ntuh-diag-op-row');
                    for (const row of rows) {
                        const dateInput = row.querySelector('.ntuh-diag-op-date-input');
                        const nameInput = row.querySelector('.ntuh-diag-op-name-input');
                        const dateVal = dateInput ? dateInput.value.trim() : '';
                        const nameVal = nameInput ? nameInput.value.trim() : '';
                        if (dateVal) {
                            opEvents.push({ date: dateVal, name: nameVal });
                        }
                    }
                }
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = !!(emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);

            const txt = buildText({
                hasInpat: hasInpatUI, hasOpd: hasOpdUI, hasOp: (opEvents.length > 0), hasEmg: hasEmgUI,
                opdDates, opdStartDate,
                inpat, emg, dept,
                opEvents, dischargeDate
            });

            fillField('NTUHWeb1_InstructionSetItem', txt);

            const sdEl = document.getElementById('NTUHWeb1_tbxStartDate');
            const edEl = document.getElementById('NTUHWeb1_tbxEndDate');
            const cbxI = document.getElementById('NTUHWeb1_cbxI');
            const cbxE = document.getElementById('NTUHWeb1_cbxE');

            let webStartDate = todayStr();
            let webEndDate = todayStr();

            let shouldCheckI = false;
            let shouldCheckE = false;

            if (hasInpatUI) {
                shouldCheckI = true;
            }
            if (hasEmgUI || (hasInpatUI && fromEmg)) {
                shouldCheckE = true;
            }

            const dateCandidates = [];

            if (hasInpatUI) {
                const start = (fromEmg && emg.arrivalDT)
                    ? emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/')
                    : (cleanInpatStart || todayStr());
                dateCandidates.push({ start, end: dischargeDate });
            }

            if (hasEmgUI && emg && emg.arrivalDT) {
                const start = emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/');
                const end = emg.leaveDate || start;
                dateCandidates.push({ start, end });
            }

            if (hasOpdUI && opdDates.length > 0) {
                let filtered = opdDates;
                if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                    const start = parseDate(opdStartDate);
                    if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
                }
                if (filtered.length > 0) {
                    dateCandidates.push({ start: filtered[0], end: filtered[filtered.length - 1] });
                }
            }

            opEvents.forEach(evt => {
                if (evt.date) {
                    dateCandidates.push({ start: evt.date, end: evt.date });
                }
            });

            if (dateCandidates.length > 0) {
                let minDateStr = null;
                let maxDateStr = null;
                for (const cand of dateCandidates) {
                    if (!minDateStr || new Date(cand.start) < new Date(minDateStr)) {
                        minDateStr = cand.start;
                    }
                    if (!maxDateStr || new Date(cand.end) > new Date(maxDateStr)) {
                        maxDateStr = cand.end;
                    }
                }
                webStartDate = minDateStr;
                webEndDate = maxDateStr;
            }

            if (cbxI) {
                if (cbxI.checked !== shouldCheckI) {
                    cbxI.checked = shouldCheckI;
                    cbxI.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            if (cbxE) {
                if (cbxE.checked !== shouldCheckE) {
                    cbxE.checked = shouldCheckE;
                    cbxE.dispatchEvent(new Event('change', { bubbles: true }));
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

    function handleReceivedOpName(opData) {
        const container = document.getElementById('ntuh-diag-op-rows-container');
        if (!container) return;

        let mainOpName = '';
        let mainIdse = '';
        let otherOpMaps = {};

        if (opData) {
            if (typeof opData === 'string') {
                if (opData.trim().startsWith('{')) {
                    try {
                        const parsed = JSON.parse(opData);
                        mainOpName = parsed.mainOpName || '';
                        mainIdse = parsed.opScheduleIdse || '';
                        otherOpMaps = parsed.otherOpMaps || {};
                    } catch (e) {
                        mainOpName = opData;
                    }
                } else {
                    mainOpName = opData;
                }
            } else if (typeof opData === 'object') {
                mainOpName = opData.mainOpName || '';
                mainIdse = opData.opScheduleIdse || '';
                otherOpMaps = opData.otherOpMaps || {};
            }
        }

        const normalizeIdse = s => s ? s.replace(/[^A-Za-z0-9]/g, '').toLowerCase().trim() : '';
        console.log('[DiagFiller] 收到手術名稱資料, mainIdse:', mainIdse, 'mainOpName:', mainOpName, 'otherOpMaps:', otherOpMaps);

        // 1. 更新 detectedOpList 中的手術名稱
        if (detectedOpList && detectedOpList.length > 0) {
            const normMainIdse = normalizeIdse(mainIdse);
            
            // 優先以流水號匹配更新 mainOpName
            let updatedMain = false;
            if (normMainIdse) {
                for (let i = 0; i < detectedOpList.length; i++) {
                    if (normalizeIdse(detectedOpList[i].opScheduleIdse) === normMainIdse) {
                        detectedOpList[i].opName = mainOpName;
                        updatedMain = true;
                        console.log(`[DiagFiller] 依流水號匹配，將第 ${i} 筆手術名稱更新為 mainOpName: ${mainOpName}`);
                        break;
                    }
                }
            }
            // 保底方案：若無匹配到流水號，則更新第一筆
            if (!updatedMain) {
                detectedOpList[0].opName = mainOpName;
                console.log(`[DiagFiller] 未匹配到流水號，保底更新第一筆手術名稱為 mainOpName: ${mainOpName}`);
            }

            const normOtherOpMaps = {};
            for (const key in otherOpMaps) {
                normOtherOpMaps[normalizeIdse(key)] = otherOpMaps[key];
            }
            console.log('[DiagFiller] 轉換後的 normOtherOpMaps:', normOtherOpMaps);

            // 更新其他在同意書表格中關聯的手術名稱
            for (let i = 0; i < detectedOpList.length; i++) {
                if (normMainIdse && normalizeIdse(detectedOpList[i].opScheduleIdse) === normMainIdse) {
                    continue; // 剛才已經更新過 mainOpName 的不重複更新
                }
                const idse = detectedOpList[i].opScheduleIdse;
                const normIdse = normalizeIdse(idse);
                console.log(`[DiagFiller] 檢查第 ${i} 筆手術: idse=${idse}, normIdse=${normIdse}`);
                if (normIdse && normOtherOpMaps[normIdse]) {
                    detectedOpList[i].opName = normOtherOpMaps[normIdse];
                    console.log(`[DiagFiller] 成功比對第 ${i} 筆手術名稱為: ${detectedOpList[i].opName}`);
                } else {
                    console.warn(`[DiagFiller] 第 ${i} 筆手術比對失敗，未在 normOtherOpMaps 中找到對應名稱`);
                }
            }
        }

        // 2. 確保至少有一個 row，並更新 UI 中所有已存在的 rows 的輸入值
        const rows = container.getElementsByClassName('ntuh-diag-op-row');
        if (rows.length === 0) {
            const firstOp = detectedOpList && detectedOpList[0] ? detectedOpList[0] : { opDate: todayStr(), opName: mainOpName, opScheduleIdse: '' };
            addOpRow(firstOp.opDate, mainOpName, firstOp.opScheduleIdse);
        } else {
            const opMapByIdse = {};
            if (detectedOpList) {
                detectedOpList.forEach(item => {
                    const norm = normalizeIdse(item.opScheduleIdse);
                    if (norm) opMapByIdse[norm] = item;
                });
            }

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const idse = row.getAttribute('data-op-idse') || '';
                const normIdse = normalizeIdse(idse);
                
                let targetName = '';
                if (normIdse && opMapByIdse[normIdse]) {
                    targetName = opMapByIdse[normIdse].opName;
                } else if (i === 0) {
                    targetName = mainOpName;
                } else if (detectedOpList && detectedOpList[i]) {
                    targetName = detectedOpList[i].opName;
                }

                if (targetName) {
                    const nameInput = row.querySelector('.ntuh-diag-op-name-input');
                    if (nameInput) {
                        nameInput.value = targetName;
                        nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                        nameInput.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
            }
        }

        const cbxOp = document.getElementById('ntuh-diag-has-op');
        if (cbxOp && !cbxOp.checked) {
            cbxOp.checked = true;
            const detailEl = document.getElementById('ntuh-diag-op-detail');
            if (detailEl) detailEl.style.display = 'flex';
        }

        setDiagStatus('✓ 手術名稱背景讀取成功！', 'ok');
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
            #ntuh-diag-panel { position: fixed; bottom: 80px; right: 24px; width: 320px; background: #1a1f2e; border: 1px solid #2d3650; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); z-index: 99999; font-family: 'Consolas',monospace; font-size: 12px; color: #c8d3e8; display: none; max-height: 85vh; flex-direction: column; overflow: hidden; }
            #ntuh-diag-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #2a1f3a; border-bottom: 1px solid #2d3650; cursor: move; user-select: none; font-size: 13px; font-weight: 600; flex-shrink: 0; }
            #ntuh-diag-close { background: none; border: none; color: #7a8aaa; cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; }
            #ntuh-diag-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1; }
            #ntuh-diag-footer { padding: 10px 12px; background: #151926; border-top: 1px solid #2d3650; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
            #ntuh-diag-discharge-row { display: none; align-items: center; gap: 8px; }
            #ntuh-diag-discharge { flex: 1; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8; font-size: 12px; padding: 5px 8px; }
            #ntuh-diag-run { padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #6a3cac; color: #fff; flex-shrink: 0; }
            #ntuh-diag-run:disabled { opacity: 0.5; cursor: not-allowed; }
            #ntuh-diag-preview { display: none; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; padding: 8px; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; color: #a8c0e8; }
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
                    <label><input type="checkbox" id="ntuh-diag-has-emg" /> <span>有急診</span></label>
                </div>
                <div id="ntuh-diag-emg-detail" style="display:none;flex-direction:column;gap:6px;margin-bottom:4px;">
                    <input id="ntuh-diag-emg-arrival" type="text" placeholder="急診入院 YYYY/MM/DD HH:mm" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                    <input id="ntuh-diag-emg-leave" type="text" placeholder="急診離院 YYYY/MM/DD HH:mm" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <label><input type="checkbox" id="ntuh-diag-has-inpat" /> <span>住院</span></label>
                </div>

                <div id="ntuh-diag-discharge-row" style="display:none;align-items:center;gap:8px;"><span>出院日期</span><input id="ntuh-diag-discharge" type="text" /></div>

                <div style="display:flex;align-items:center;gap:6px;">
                    <label><input type="checkbox" id="ntuh-diag-has-opd" /> <span>有門診</span></label>
                </div>
                <div id="ntuh-diag-opd-detail" style="display:none;align-items:center;gap:8px;margin-bottom:4px;"><span>起始日期</span>
                    <input id="ntuh-diag-opd-start-date" type="text" placeholder="YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-op" /> <span>手術</span></label></div>
                <div id="ntuh-diag-op-detail" style="display:none;flex-direction:column;gap:6px;">
                    <div id="ntuh-diag-op-rows-container" style="display:flex;flex-direction:column;gap:6px;"></div>
                    <button id="ntuh-diag-add-op-btn" type="button" style="padding:4px; border:1px dashed #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; margin-top:4px;">➕ 新增手術</button>
                </div>
            </div>
            <div id="ntuh-diag-footer">
                <button id="ntuh-diag-run">✨ 自動填入囑言</button>
                <button id="ntuh-diag-scan-opname" type="button" style="padding:6px 0; border:1px solid #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; font-weight:600; width:100%;">🔍 背景擷取手術中文名稱</button>
                <div id="ntuh-diag-status"></div>
                <div id="ntuh-diag-preview"></div>
            </div>
        `;

        document.body.appendChild(panel);
        document.getElementById('ntuh-diag-discharge').value = tomorrowStr();

        document.getElementById('ntuh-diag-has-emg').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-emg-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try {
                    const emg = fetchEmgData();
                    if (emg.arrivalDT) {
                        document.getElementById('ntuh-diag-emg-arrival').value = emg.arrivalDT;
                        document.getElementById('ntuh-diag-emg-leave').value = emg.leaveDT;
                        setDiagStatus('已讀取急診日期', 'ok');
                    } else {
                        setDiagStatus('未找到急診紀錄', 'warn');
                    }
                } catch (e) {
                    console.warn(e);
                    setDiagStatus('未找到急診紀錄', 'warn');
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        document.getElementById('ntuh-diag-has-inpat').addEventListener('change', function() {
            const dischargeRow = document.getElementById('ntuh-diag-discharge-row');
            if (dischargeRow) {
                dischargeRow.style.display = this.checked ? 'flex' : 'none';
            }
        });

        document.getElementById('ntuh-diag-has-opd').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-opd-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory [id*="Msg"], #NTUHWeb1_fieldsetOutHistory .errorMsgText', 5000);
                const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();
                const opdDates = fetchOpdDates(dept);
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

        document.getElementById('ntuh-diag-has-op').addEventListener('change', function() {
            const detailEl = document.getElementById('ntuh-diag-op-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                const container = document.getElementById('ntuh-diag-op-rows-container');
                if (container && container.children.length === 0) {
                    if (detectedOpList && detectedOpList.length > 0) {
                        addOpRow(detectedOpList[0].opDate, '', detectedOpList[0].opScheduleIdse);
                    } else {
                        addOpRow(todayStr(), '', '');
                    }
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        document.getElementById('ntuh-diag-add-op-btn').addEventListener('click', function() {
            const container = document.getElementById('ntuh-diag-op-rows-container');
            const nextIndex = container ? container.children.length : 0;
            if (detectedOpList && nextIndex < detectedOpList.length) {
                addOpRow(detectedOpList[nextIndex].opDate, '', detectedOpList[nextIndex].opScheduleIdse);
            } else {
                addOpRow(todayStr(), '', '');
            }
        });

        fab.onclick = () => { fab.style.display = 'none'; panel.style.display = 'flex'; };
        document.getElementById('ntuh-diag-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-diag-header'));
        document.getElementById('ntuh-diag-run').onclick = () => runDiagFiller();

        document.getElementById('ntuh-diag-scan-opname').onclick = () => {
            try {
                console.log('[DiagFiller] 點擊背景擷取手術名稱按鈕...');
                const currentUrlParams = new URLSearchParams(window.location.search);
                let session = currentUrlParams.get('SESSION') || '';
                if (!session) { const sEl = document.querySelector('input[name*="SESSION"], input[id*="SESSION"]'); if (sEl) session = sEl.value; }
                if (!session) { alert('無法取得 SESSION'); return; }

                const rows = Array.from(document.getElementById('ntuh-diag-op-rows-container').getElementsByClassName('ntuh-diag-op-row'));
                const scanTasks = [];

                rows.forEach((row, index) => {
                    const nameInput = row.querySelector('.ntuh-diag-op-name-input');
                    const opName = nameInput ? nameInput.value.trim() : '';
                    const opScheduleIdse = row.getAttribute('data-op-idse') || '';
                    const needsScan = !opName || /[A-Za-z]/.test(opName);

                    if (needsScan && opScheduleIdse) {
                        const opToken = 'ntuh_op_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_' + index;
                        scanTasks.push({ opScheduleIdse, opToken });
                    }
                });

                if (scanTasks.length === 0) {
                    setDiagStatus('⚠️ 沒有需要擷取的手術（已有中文名稱或無流水號）', 'warn');
                    return;
                }

                console.log('[DiagFiller] 規劃的手術背景掃描任務:', scanTasks);
                setDiagStatus('⏳ 正在背景擷取手術中文名稱...', 'warn');

                activeOpScanTokens = {};
                scanTasks.forEach(task => {
                    const opTargetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/OPManagement/DREnterOPOrder.aspx` +
                                       `?SESSION=${session}&OperationIDSE=${task.opScheduleIdse}&ntuh_token=${task.opToken}`;

                    activeOpScanTokens[task.opToken] = task.opScheduleIdse;

                    if (typeof GM_openInTab !== 'undefined') {
                        GM_openInTab(opTargetUrl, { active: false, insert: true, setParent: true });
                    } else {
                        window.open(opTargetUrl, '_blank');
                    }
                });

                const startTime = Date.now();
                const pollInterval = setInterval(() => {
                    if (Date.now() - startTime > 60000) {
                        clearInterval(pollInterval);
                        console.warn('[DiagFiller] 輪詢逾時 (60s)');
                        if (document.getElementById('ntuh-diag-status').textContent.includes('⏳')) {
                            setDiagStatus('⚠️ 擷取逾時，請手動確認或重新點擊。', 'warn');
                        }
                        return;
                    }

                    for (const opToken in activeOpScanTokens) {
                        const opNameData = getSharedData('ntuh_op_name_' + opToken);
                        if (opNameData) {
                            console.log(`[DiagFiller] 收到 Token ${opToken} 的手術名稱資料:`, opNameData);
                            handleReceivedOpName(opNameData);
                            deleteSharedData('ntuh_op_name_' + opToken);
                            delete activeOpScanTokens[opToken];
                        }
                    }

                    if (Object.keys(activeOpScanTokens).length === 0) {
                        clearInterval(pollInterval);
                        console.log('[DiagFiller] 所有手術名稱已成功接收，停止輪詢');
                    }
                }, 1000);

            } catch(e) {
                console.error('[DiagFiller] 背景擷取手術名稱異常:', e);
                setDiagStatus('✗ 開啟失敗: ' + e.message, 'err');
            }
        };

        // 啟動自動偵測與勾選
        setTimeout(autoDetectRecords, 100);
    }

    async function autoDetectRecords() {
        try {
            // 1. 手術
            setDiagStatus('自動偵測病歷中：展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_lblOpScheduleMsg');
            const opList = fetchOpDataList();
            detectedOpList = opList;
            const container = document.getElementById('ntuh-diag-op-rows-container');
            if (container) container.innerHTML = '';
            if (opList.length > 0) {
                document.getElementById('ntuh-diag-has-op').checked = true;
                document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                addOpRow(opList[0].opDate, '', opList[0].opScheduleIdse);
            } else {
                document.getElementById('ntuh-diag-has-op').checked = false;
                document.getElementById('ntuh-diag-op-detail').style.display = 'none';
            }

            // 2. 住院
            setDiagStatus('自動偵測病歷中：展開住院資料…', 'warn');
            await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
            const inpat = fetchInpatData();
            if (inpat.inpatStartDate) {
                document.getElementById('ntuh-diag-has-inpat').checked = true;
                document.getElementById('ntuh-diag-discharge-row').style.display = 'flex';
            } else {
                document.getElementById('ntuh-diag-has-inpat').checked = false;
                document.getElementById('ntuh-diag-discharge-row').style.display = 'none';
            }

            // 3. 急診
            setDiagStatus('自動偵測病歷中：展開急診資料…', 'warn');
            await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            try { emg = fetchEmgData(); } catch (e) { console.warn(e.message); }
            if (emg.arrivalDT) {
                document.getElementById('ntuh-diag-has-emg').checked = true;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'flex';
                document.getElementById('ntuh-diag-emg-arrival').value = emg.arrivalDT;
                document.getElementById('ntuh-diag-emg-leave').value = emg.leaveDT;
            } else {
                document.getElementById('ntuh-diag-has-emg').checked = false;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'none';
            }

            // 4. 門診
            setDiagStatus('自動偵測病歷中：展開門診資料…', 'warn');
            await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_divOutHistoryInfo', 5000);
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();
            const opdDates = fetchOpdDates(dept);
            if (opdDates.length > 0) {
                document.getElementById('ntuh-diag-has-opd').checked = true;
                document.getElementById('ntuh-diag-opd-detail').style.display = 'flex';
                document.getElementById('ntuh-diag-opd-start-date').value = opdDates[0];
            } else {
                document.getElementById('ntuh-diag-has-opd').checked = false;
                document.getElementById('ntuh-diag-opd-detail').style.display = 'none';
            }

            setDiagStatus('✓ 病歷自動偵測完成！', 'ok');

            // 自動觸發背景擷取手術中文名稱
            if (opList.length > 0) {
                const scanBtn = document.getElementById('ntuh-diag-scan-opname');
                if (scanBtn) scanBtn.click();
            }
        } catch (e) {
            console.warn('[DiagFiller] 自動偵測病歷失敗：', e);
            setDiagStatus('⚠️ 自動偵測病歷失敗', 'warn');
        }
    }

    // =========================================================================
    // 模組二：背景分頁自動擷取手術名稱，透過 GM_setValue 跨網域回傳
    // =========================================================================
    function extractOpNamesFromDOM() {
        const names = [];
        const spans = document.querySelectorAll('span[id*="InputOperationOrderCtrl1_OrderName"]');
        for (const span of spans) {
            const name = span.textContent.trim();
            if (name) names.push(name);
        }
        console.log('[OpNameExtractor] 從手術醫令入帳頁面擷取到', names.length, '筆手術名稱:', names);
        return names;
    }

    function formatCombinedOpName(items) {
        if (!items || items.length === 0) return '';
        const cleaned = items.map(s => s.replace(/[\r\n\t]+/g, ' ').trim()).filter(s => s.length > 0);
        if (cleaned.length === 0) return '';
        if (cleaned.length === 1) return cleaned[0];
        return cleaned.join('併');
    }

    async function runOpNameExtractorAndReturn() {
        const token = new URLSearchParams(window.location.search).get('ntuh_token') || '';
        const opScheduleIdse = new URLSearchParams(window.location.search).get('OperationIDSE') || '';
        try {
            await sleep(1200);
            const opNames = extractOpNamesFromDOM();
            const formatted = formatCombinedOpName(opNames);
            console.log('[OpNameExtractor] 格式化後的手術名稱:', formatted);

            const opResult = {
                opScheduleIdse: opScheduleIdse,
                mainOpName: formatted,
                otherOpMaps: {}
            };

            const resultString = JSON.stringify(opResult);

            if (token) {
                console.log('[OpNameExtractor] 寫入傳遞資料, token:', token);
                setSharedData('ntuh_op_name_' + token, resultString);
            }

            if (window.opener) {
                window.opener.postMessage(
                    { ntuh: true, token, type: 'opName', data: opResult },
                    'https://hisaw.ntuh.gov.tw'
                );
                console.log('[OpNameExtractor] 手術名稱已回傳:', opResult);
            } else {
                console.log('[OpNameExtractor] 無法取得 opener，改以全域資料通訊機制回傳');
            }

            await sleep(100);
            window.close();
        } catch (e) {
            console.error('[OpNameExtractor] 擷取失敗:', e.message);
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