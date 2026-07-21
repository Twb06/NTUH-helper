// ==UserScript==
// @name         NTUH Progress Note Data Helper
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.9.9
// @description  在 Progress Note 頁一鍵從各權威專頁背景抓取即時資料：導管（CatheterCare，僅現存）、照會（NotifyOtherDoctor）、飲食（DoctorDietMain，現行供餐醫令）、護理交班筆記（OffDutyNurV2 筆記欄）、今日護理過程紀錄（NursingProgressNote，自動點顯示紀錄）、生命徵象/SpO2/GCS/UO/影像（OuterData 直抓）、抗生素藥歷（chart-medication worker 抗生素+1M）。整理進暫存預覽面板。與 progress-note-filler 分離，專責跨頁資料擷取。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/CatheterCare.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/DoctorDietMain.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OffDutyNurV2.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/NursingProgressNote.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-data-helper.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-data-helper.user.js
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const LOG = '[DataHelper]';

    // ═════════════════════════════════════════════
    // 跨分頁共享資料（GM，fallback localStorage）
    // ═════════════════════════════════════════════
    // 三頁同源 → localStorage 跨分頁即可通；GM 為備援
    function setSharedData(name, value) {
        try { localStorage.setItem(name, value); } catch (e) { /* noop */ }
        if (typeof GM_setValue !== 'undefined') { try { GM_setValue(name, value); } catch (e) { /* noop */ } }
    }
    function getSharedData(name) {
        const ls = localStorage.getItem(name);
        if (ls) return ls;
        if (typeof GM_getValue !== 'undefined') return GM_getValue(name, '');
        return '';
    }
    function deleteSharedData(name) {
        try { localStorage.removeItem(name); } catch (e) { /* noop */ }
        if (typeof GM_deleteValue !== 'undefined') { try { GM_deleteValue(name); } catch (e) { /* noop */ } }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ─────────────────────────────────────────────
    // fetch 來源的「點標題跳轉」網址（tab 來源直接用 buildUrl 去 token；fetch 來源沒有頁，另給）
    // 皆為 function 宣告（hoist），供下方 SOURCES 物件字面量引用
    // ─────────────────────────────────────────────
    function vitalsNavUrl(p) {
        return 'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/VitalSign_TPR.aspx'
            + `?session=${p.SESSION}&AccountIDSE=${p.AccountIDSE}`;
    }
    function pacsNavUrl(p) {
        return 'https://ihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/PACSImageShowList.aspx'
            + `?PersonID=${p.PersonID}&Seed=${p.Seed || ''}`;
    }

    // ═════════════════════════════════════════════
    // 資料來源定義：每個來源 = 一個權威專頁
    //   buildUrl(params, token) → 背景頁網址（帶 ntuh_token）
    //   match(url)              → 該頁是否為此來源
    //   extract()              → 背景頁擷取邏輯，回傳文字（背景端執行）
    //   label                  → 預覽面板標題
    // ═════════════════════════════════════════════
    const SOURCES = {
        catheter: {
            label: '[Tubes]',
            match: (u) => /\/Nursing\/CatheterCare\.aspx/i.test(u),
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/CatheterCare.aspx' +
                `?session=${p.SESSION}&AccountIDSE=${p.AccountIDSE}&PatClass=${p.PatClass || 'I'}` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractCatheter,
        },
        consult: {
            label: '[Consult]',
            match: (u) => /\/Ward\/NotifyOtherDoctor\.aspx/i.test(u),
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractConsult,
        },
        diet: {
            label: '[Diet]',
            match: (u) => /\/Ward\/DoctorDietMain\.aspx/i.test(u),
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/DoctorDietMain.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractDiet,
        },
        handover: {
            label: '[Handover]',
            match: (u) => /\/Ward\/OffDutyNurV2\.aspx/i.test(u),
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OffDutyNurV2.aspx' +
                `?SESSION=${p.SESSION}&InQuerySortMode=QByEmp&AccountIDSE=${p.AccountIDSE}&Type=Nur` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractHandover,
        },
        nursing: {
            label: '[Nursing]',
            match: (u) => /\/Nursing\/NursingProgressNote\.aspx/i.test(u),
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/NursingProgressNote.aspx' +
                `?SESSION=${p.SESSION}&AccountIDSE=${p.AccountIDSE}` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            prepare: prepareNursing,
            extract: extractNursing,
        },
        // vitalsign 拆成 5 個分項來源，共用同一份 fetch（datatype 快取），各自無值顯示（無）
        // navUrl：點標題跳轉 VitalSign_TPR.aspx（生命徵象圖）
        tprbp: { label: '[TPR+BP]', mode: 'fetch', datatype: 'vitalsign', format: formatTprBp, navUrl: vitalsNavUrl, match: () => false },
        resp:  { label: '[Resp]',   mode: 'fetch', datatype: 'vitalsign', format: formatResp,  navUrl: vitalsNavUrl, match: () => false },
        gcs:   { label: '[GCS]',    mode: 'fetch', datatype: 'vitalsign', format: formatGcs,   navUrl: vitalsNavUrl, match: () => false },
        uo:    { label: '[UO]',     mode: 'fetch', datatype: 'vitalsign', format: formatUo,    navUrl: vitalsNavUrl, match: () => false },
        pain:  { label: '[Pain]',   mode: 'fetch', datatype: 'vitalsign', format: formatPain,  navUrl: vitalsNavUrl, match: () => false },
        image: {
            label: '[Image]',
            mode: 'fetch',
            datatype: 'pacs',
            format: formatPacs,
            navUrl: pacsNavUrl,   // 點標題跳轉 PACSImageShowList.aspx
            match: () => false,
        },
        // 藥歷圖（抗生素）：worker 是 chart-medication.user.js（跑在 Chart.aspx，
        // 讀 ntuh_token → 自動抗生素+1M → 寫 localStorage['ntuh_data_'+token]）。
        // data-helper 只負責開頁＋輪詢，故只需 buildUrl。
        meds: {
            label: '[Abx]',
            match: () => false, // Chart.aspx 由 chart-medication 處理，data-helper 不 @match
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/MedicationHistory/Chart.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
        // 現行處方：worker 是 prescription-viewer.user.js（跑在 MedicationV2.aspx）
        rx: {
            label: '[Rx]',
            match: () => false, // MedicationV2.aspx 由 prescription-viewer 處理
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/MedicationV2.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
        // 檢驗報告：worker 是 lab-summary.user.js（跑在 MedicalReportContent.aspx，預設清單）
        // 注意此頁參數異於其他頁：無 SESSION，改用 ChartNo/WardCode/HospitalCode。
        lab: {
            label: '[Lab]',
            match: () => false, // MedicalReportContent.aspx 由 lab-summary 處理
            buildUrl: (p, token) =>
                'https://ihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/MedicalReportContent.aspx' +
                `?PatClass=${p.PatClass || 'I'}&WardCode=${p.WardCode}&ChartNo=${p.ChartNo}` +
                `&HospitalCode=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&IntervalDay=-1` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
    };

    // ═════════════════════════════════════════════
    // 背景端擷取邏輯（STUB：先抓最可能的資料表全文，DOM 確認後精修）
    // ═════════════════════════════════════════════
    // 導管觀察紀錄（非導管本體）判定，需濾掉
    const CATH_OBS_RE = /^(正常|異常|外移|移位|脫落|滑脫|阻塞|滲液|滲血|紅腫|鬆脫|自拔|更換|[\s,，]|\+)+$/;
    // 周邊留置針不列入（但 CVC/PICC/Port-A 等中央導管要留）
    const CATH_PERIPHERAL_RE = /留置針|IV\s*Catheter/i;

    function extractCatheter() {
        // catheterTimeLine 是頁面全域，須從 unsafeWindow 取（沙箱 window 沒有）
        const pw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        // SIMILE Timeline 尚未就緒 → 回 null（worker 會繼續輪詢）
        const tl = pw.catheterTimeLine;
        if (!tl || typeof tl.getBand !== 'function') return null;
        let src;
        try { src = tl.getBand(0).getEventSource(); } catch (e) { return null; }
        if (!src || typeof src.getAllEventIterator !== 'function') return null;

        const md = (d) => d && d.getMonth ? `${d.getMonth() + 1}/${d.getDate()}` : '';
        const lines = [];
        const it = src.getAllEventIterator();
        while (it.hasNext()) {
            const e = it.next();
            const t = (e.getText() || '').trim();
            if (!t || CATH_OBS_RE.test(t)) continue;          // 濾掉觀察紀錄
            if (CATH_PERIPHERAL_RE.test(t)) continue;         // 濾掉周邊留置針

            const removed = String(e._RemovedCatheter) === 'true'
                || (e.getProperty && e.getProperty('RemovedCatheter') === true);
            if (removed) continue;                             // 只留現存
            lines.push(t + '  ' + md(e.getStart()));
        }
        return lines.length ? lines.join('\n') : '（無現存導管）';
    }

    function extractConsult() {
        // 照會資料表：NTUHWeb1_NotifyDrRecord（fallback tblNotList）
        const table = document.getElementById('NTUHWeb1_NotifyDrRecord')
            || document.getElementById('tblNotList');
        // 頁面就緒但無照會表格（此病人無照會）→ 回空字串，避免 worker 空等到逾時
        const pageReady = document.getElementById('UpperBannerInfoTable')
            || /照會紀錄|照會開立/.test(document.body?.innerText || '');
        if (!table) return pageReady ? '（無照會記錄）' : null;

        const rows = [...table.rows];
        const out = [];
        for (const r of rows) {
            const cells = [...r.cells].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
            if (!cells.length) continue;
            // 以「申請時間」欄定位（日期時間格式），科部固定在其 +2 欄（時間→申請者→被照會科部）
            const timeIdx = cells.findIndex((c) => /\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/.test(c));
            if (timeIdx < 0) continue; // 非資料列（表頭/按鈕列）
            const date = cells[timeIdx].match(/(\d{1,2}\/\d{1,2})/)?.[1] || '';
            const dept = (cells[timeIdx + 2] || '').replace(/\(.*$/, '').trim(); // 去掉子單位括號
            const status = cells.find((c) => /^(完成|已回覆|未回覆|處理中|取消|待回覆|已確認)$/.test(c)) || '';
            const line = [date, dept, status].filter(Boolean).join(' ');
            if (line) out.push(line);
        }
        return out.length ? out.join('\n') : '（無照會記錄）';
    }

    function extractDiet() {
        // 飲食醫令表：NTUHWeb1_dgValidDietOrder，資料列 class=tableText，黃底=現行供餐
        const table = document.getElementById('NTUHWeb1_dgValidDietOrder');
        // 頁面就緒但無供餐醫令 → 回空字串（非 null，避免 worker 空等到逾時）
        const pageReady = document.getElementById('tblOwnDiet')
            || /供餐醫令/.test(document.body?.innerText || '');
        if (!table) return pageReady ? '（無供餐醫令）' : null;

        const dataRows = [...table.rows].filter((r) => /tableText/i.test(r.className));
        if (!dataRows.length) return '（無供餐醫令）';
        const yellow = dataRows.filter((r) => (r.style.backgroundColor || '').toLowerCase() === 'yellow');
        const use = yellow.length ? yellow : dataRows;

        const lines = use.map((r) => {
            const c = [...r.cells].map((x) => (x.innerText || '').replace(/\s+/g, ' ').trim());
            const category = (c[2] || '').replace(/\([^)]*管路[^)]*\)/, '').trim(); // 去掉(需具灌食管路)
            const sub = c[3] || '';
            const detail = c[11] || '';
            const parts = [];
            const supp = detail.match(/營養品:\s*([^;；]+)/)?.[1]?.trim();
            const conc = detail.match(/濃度:\s*([^熱禁營額]+)/)?.[1]?.trim();
            const cal = detail.match(/熱量:\s*(\d+)/)?.[1];
            const salt = detail.match(/額外加鹽:\s*([^禁營;；]+)/)?.[1]?.trim();
            const avoid = detail.match(/禁忌:\s*([^;；營]+)/)?.[1]?.trim();
            if (supp) parts.push(supp);
            if (conc) parts.push('濃度' + conc);
            if (cal) parts.push('熱量' + cal);
            if (salt) parts.push('加鹽' + salt);
            if (avoid) parts.push('禁' + avoid);
            let line = [category, sub].filter(Boolean).join(' ');
            if (parts.length) line += ' (' + parts.join(', ') + ')';
            return line;
        }).filter(Boolean);

        return lines.length ? lines.join('\n') : '（無供餐醫令）';
    }

    // 護理交班筆記欄：OffDutyNurV2.aspx 的 textarea#NTUHWeb1_txbMsgNote
    // （ASP.NET 伺服器渲染，元素存在即帶值 → 直接讀 .value）
    function extractHandover() {
        const el = document.getElementById('NTUHWeb1_txbMsgNote');
        if (!el) {
            // 頁面就緒（交班表已在）但無筆記欄 → 回空字串避免 worker 空等到逾時
            const pageReady = document.querySelector('table.queryTableDisplay');
            return pageReady ? '（無交班筆記）' : null;
        }
        // 壓掉連續 3+ 空行，保留段落結構
        const v = (el.value || '').replace(/\n{3,}/g, '\n\n').trim();
        return v || '（無交班筆記）';
    }

    // 今日護理過程紀錄：NursingProgressNote.aspx 的 GridView#NTUHWeb1_gv_List
    // 需先點「顯示紀錄」讓 grid 帶出資料。prepare 負責點；extract 篩今天日期的列。
    // ── prepare：worker 啟動時呼叫一次，點「顯示紀錄」 ──
    // 「顯示紀錄」可能是整頁 postback（reload 掉 token，靠 init 的 sessionStorage 救）
    // 或 UpdatePanel 局部更新（不 reload，continue poll 即可）。兩者皆處理。
    function prepareNursing() {
        const tbl = document.getElementById('NTUHWeb1_gv_List');
        // 已有資料列（postback reload 後 grid 會保留）→ 不必再點，避免無限迴圈
        if (tbl && tbl.rows.length > 1) return;
        const btn = [...document.querySelectorAll('input[type=button],input[type=submit],a,button')]
            .find((el) => /顯示紀錄/.test(el.value || el.innerText || ''));
        if (btn) { console.log(LOG, '點擊「顯示紀錄」'); btn.click(); }
    }

    function extractNursing() {
        const tbl = document.getElementById('NTUHWeb1_gv_List');
        if (!tbl || tbl.rows.length <= 1) return null; // 尚未載入/尚未點出資料
        const now = new Date();
        const today = `${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
        const lines = [];
        for (let i = 1; i < tbl.rows.length; i++) {          // 跳過表頭列
            const cells = [...tbl.rows[i].cells].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim());
            if (cells.length < 3) continue;
            const dtRaw = cells[0];                            // "07/07 17:58"
            const mmdd = dtRaw.match(/(\d{1,2}\/\d{1,2})/)?.[1] || '';
            if (mmdd !== today) continue;                      // 只留今天
            const time = dtRaw.match(/(\d{1,2}:\d{2})/)?.[1] || '';
            const name = cells[1] || '';
            const content = cells[2] || '';
            lines.push(`${time} ${name}\n${content}`.trim());
        }
        return lines.length ? lines.join('\n\n') : '（今日無護理紀錄）';
    }

    // ─────────────────────────────────────────────
    // fetch 模式來源：直接打 Progress 頁的 OuterData API（同源，不開分頁）
    // ─────────────────────────────────────────────
    function getOuterParams() {
        const v = (id) => document.getElementById(id)?.value || '';
        const q = new URLSearchParams(window.location.search);
        return {
            AccountIdse: v('hidAccountNo') || q.get('AccountIDSE') || '',
            PersonId:    v('hidPersonId')  || q.get('PersonID')   || '',
            ChartNo:     v('hidChartNo')   || '',
            DeptCode:    v('hidDeptCode')  || '',
            EmpDeptCode: v('hidEmpDeptCode') || '',
        };
    }

    // 同一次抓取內共用（多個 fetch 來源可能用同一 datatype，如 vitalsign）
    let outerCache = {};
    function fetchOuterData(datatype) {
        if (outerCache[datatype]) return outerCache[datatype];
        const p = (async () => {
            const url = window.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
                + 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 12000);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    body: JSON.stringify({ jsonstring: JSON.stringify(getOuterParams()), datatype }),
                    signal: ctrl.signal,
                    credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                return JSON.parse(j.d).Html || '';
            } finally {
                clearTimeout(timer);
            }
        })();
        outerCache[datatype] = p;
        return p;
    }

    // SpO2 值＋給氧裝置字串。inside 格式 "28%,5L,Mask"（FiO2,流量,裝置），空=room air
    function spo2Str(pct, inside) {
        const parts = (inside || '').split(',').map((s) => s.trim());
        let fio2 = '', flow = '', deviceRaw = '';
        if (parts.length >= 3) { [fio2, flow, deviceRaw] = parts; }
        else if (parts.length === 1) { deviceRaw = parts[0]; }
        let device;
        if (/cannula/i.test(deviceRaw)) device = 'NC';
        else if (/mask/i.test(deviceRaw)) device = 'Mask';
        else if (!deviceRaw || /room\s*air/i.test(deviceRaw)) device = 'Room air';
        else device = deviceRaw;
        const bits = [pct + '%'];
        const dev = device === 'Room air'
            ? 'Room air'
            : [device, (flow && flow.trim() ? flow : '')].filter(Boolean).join(' ');
        if (dev) bits.push(dev);
        if (fio2 && fio2 !== '' && fio2 !== '%') bits.push('FiO2 ' + fio2);
        return bits.join(' ');
    }

    // vitalsign 每列一項，各取最新一筆 → 供 5 個分項來源共用。
    //   TPR "T:36.4 P:103 R:20"、BP "BP:111/71"、SpO2 "SpO2:97%(...)"、Pain "Pain score:0"、
    //   GCS "GCS:E4M5V1"(V 可為 A)、U/O "U/O:250"（可能無日期，退回首見值）
    function scanVitals(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const dtRe = /(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/;
        const latest = {}; // key → { dt, val }
        let uoFallback = null;
        const consider = (key, dt, val) => {
            if (!dt) return;
            if (!latest[key] || dt > latest[key].dt) latest[key] = { dt, val };
        };
        doc.querySelectorAll('tr').forEach((tr) => {
            const t = tr.innerText.replace(/\s+/g, ' ').trim();
            const dt = t.match(dtRe)?.[1] || '';
            let m;
            if ((m = t.match(/T:\s*([\d.]+)\s*P:\s*(\d+)\s*R:\s*(\d+)/i))) consider('tpr', dt, { T: m[1], P: m[2], R: m[3] });
            else if ((m = t.match(/BP:\s*(\d+\/\d+)/i))) consider('bp', dt, m[1]);
            else if ((m = t.match(/SpO2:\s*(\d+)%\(([^)]*)\)/i))) consider('spo2', dt, { pct: m[1], inside: m[2] });
            else if ((m = t.match(/Pain(?:\s*score)?:\s*(\d+)/i))) consider('pain', dt, m[1]);
            else if ((m = t.match(/GCS:\s*(E\d+M\d+V\w+)/i))) consider('gcs', dt, m[1]);
            else if ((m = t.match(/U\/?O:\s*(\d+)/i))) { if (dt) consider('uo', dt, m[1]); else if (uoFallback === null) uoFallback = m[1]; }
        });
        if (!latest.uo && uoFallback !== null) latest.uo = { dt: '', val: uoFallback };
        return latest;
    }
    const vWhen = (dt) => (dt ? '  @' + dt.slice(5).replace(/^0/, '') : '');

    // 5 個分項格式器：各取最新，無值一律回「（無）」
    function formatTprBp(html) {
        const L = scanVitals(html);
        const parts = [];
        if (L.tpr) { const v = L.tpr.val; parts.push(`T ${v.T} P ${v.P} R ${v.R}`); }
        if (L.bp) parts.push('BP ' + L.bp.val);
        if (!parts.length) return '（無）';
        return parts.join('   ') + vWhen((L.tpr || L.bp).dt);
    }
    function formatResp(html) {
        const L = scanVitals(html);
        if (!L.spo2) return '（無）';
        return 'SpO2 ' + spo2Str(L.spo2.val.pct, L.spo2.val.inside) + vWhen(L.spo2.dt);
    }
    function formatGcs(html) {
        const L = scanVitals(html);
        return L.gcs ? 'GCS ' + L.gcs.val + vWhen(L.gcs.dt) : '（無）';
    }
    function formatUo(html) {
        const L = scanVitals(html);
        return L.uo ? 'U/O ' + L.uo.val + ' mL' + vWhen(L.uo.dt) : '（無）';
    }
    function formatPain(html) {
        const L = scanVitals(html);
        return L.pain ? 'Pain ' + L.pain.val + vWhen(L.pain.dt) : '（無）';
    }

    // 影像報告（pacs）：隱藏 Content 欄用 @@@ 分段 = 日期+檢查名 / findings / impression
    const PACS_MAX = 3; // 只取最近幾筆，避免過長
    const PACS_SKIP_RE = /Chest\s*:\s*(AP|PA)\s*View/i; // 常規胸部 X 光不列入
    function formatPacs(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const out = [];
        for (const tr of doc.querySelectorAll('tbody tr')) {
            const content = [...tr.querySelectorAll('td')].map((td) => td.textContent).find((t) => t.includes('@@@'));
            if (!content) continue;
            const segs = content.split('@@@').map((s) => s.replace(/\s+/g, ' ').trim());
            const head = segs[0] || '';
            const title = head.replace(/^\d{4}\/\d{2}\/\d{2}\s*/, '').replace(/\s*\(V\d+\)\s*$/, '').trim();
            if (PACS_SKIP_RE.test(title)) continue; // 略過常規胸部 X 光
            const dm = head.match(/(\d{4})\/(\d{2})\/(\d{2})/);
            const date = dm ? (+dm[2]) + '/' + (+dm[3]) : '';
            const report = (segs[2] && segs[2] !== '') ? segs[2] : (segs[1] || '');
            out.push(`${date} ${title}`.trim() + (report ? '\n  ' + report : ''));
            if (out.length >= PACS_MAX) break;
        }
        return out.length ? out.join('\n') : '（無影像報告）';
    }

    // ═════════════════════════════════════════════
    // 路由
    // ═════════════════════════════════════════════
    function init() {
        const url = window.location.href;
        const token = new URLSearchParams(window.location.search).get('ntuh_token');

        // 背景工作者模式：URL 帶 token → 抓完回傳關閉
        if (token) {
            const src = Object.values(SOURCES).find((s) => s.match(url));
            if (src) return runWorker(src, token);
            return;
        }

        // NursingProgressNote 特例：「顯示紀錄」若是整頁 postback，reload 後 URL 掉 token
        // → 從 sessionStorage 救回 pending token，讓 worker 繼續（教訓 #15）
        if (/NursingProgressNote\.aspx/i.test(url)) {
            const pending = sessionStorage.getItem('ntuh_nurse_pending');
            if (pending) return runWorker(SOURCES.nursing, pending);
        }

        // 專頁但沒 token → 一般開啟，不介入
        if (Object.values(SOURCES).some((s) => s.match(url))) return;

        // Progress Note 頁 → 只當「無介面引擎」：對外事件服務供 progress-note-filler 觸發。
        // （自己的 🩺 面板已收掉，統一由 filler 一個入口；createUI 保留但不啟用）
        if (/InsertProgressNoteContent\.aspx/i.test(url)) {
            registerGrabService();
        }
    }

    // 對外服務：filler 派 'ntuh-datahelper-grab' → 抓全部 → 寫 localStorage → 派 'ntuh-datahelper-result' ping。
    // （用 localStorage 傳 payload、DOM 事件只當 ping，避開跨 userscript sandbox 傳 detail 的限制）
    const ALL_SOURCE_KEYS = ['tprbp', 'resp', 'gcs', 'uo', 'pain', 'catheter', 'consult', 'diet', 'handover', 'nursing', 'image', 'meds', 'rx', 'lab'];
    let grabServiceBusy = false;
    function registerGrabService() {
        document.addEventListener('ntuh-datahelper-grab', async () => {
            if (grabServiceBusy) return;
            grabServiceBusy = true;
            try {
                const results = await grabSources(ALL_SOURCE_KEYS);
                try { localStorage.setItem('ntuh_datahelper_result', JSON.stringify(results)); } catch (e) { /* noop */ }
            } catch (e) {
                try { localStorage.setItem('ntuh_datahelper_result', JSON.stringify([{ key: 'err', label: '[Error]', ok: false, error: e.message || String(e) }])); } catch (e2) { /* noop */ }
            } finally {
                grabServiceBusy = false;
                document.dispatchEvent(new CustomEvent('ntuh-datahelper-result'));
            }
        });
    }

    // ═════════════════════════════════════════════
    // 背景工作者
    // ═════════════════════════════════════════════
    async function runWorker(src, token) {
        // Nursing：存 pending token，撐過「顯示紀錄」可能觸發的整頁 postback（reload 掉 URL token）
        const isNursing = src === SOURCES.nursing;
        if (isNursing) { try { sessionStorage.setItem('ntuh_nurse_pending', token); } catch (e) { /* noop */ } }
        try {
            console.log(LOG, '背景擷取啟動', src.label, token);
            // prepare：抓取前的一次性動作（如點「顯示紀錄」）
            if (typeof src.prepare === 'function') { try { src.prepare(); } catch (e) { console.warn(LOG, 'prepare 失敗', e); } }
            // 輪詢 extract：資料（timeline/table）為 async 載入，回 null 代表尚未就緒
            const t0 = Date.now();
            const TIMEOUT = 15000;
            let text = null;
            while (Date.now() - t0 < TIMEOUT) {
                text = src.extract();
                if (text !== null) break;
                await sleep(500);
            }
            if (text === null) throw new Error('資料載入逾時');
            setSharedData('ntuh_data_' + token, JSON.stringify({ ok: true, text }));
            console.log(LOG, '已回傳', src.label, text.length, 'chars');
        } catch (e) {
            setSharedData('ntuh_data_' + token, JSON.stringify({ ok: false, error: e.message || String(e) }));
            console.error(LOG, '擷取失敗', e);
        } finally {
            if (isNursing) { try { sessionStorage.removeItem('ntuh_nurse_pending'); } catch (e) { /* noop */ } }
            await sleep(150);
            window.close();
        }
    }

    // ═════════════════════════════════════════════
    // 協調器：從 Progress 頁 URL 取參數，開背景頁、輪詢、渲染
    // ═════════════════════════════════════════════
    function getPageParams() {
        const q = new URLSearchParams(window.location.search);
        const bedIdse = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_HiddenFieldBedIDSE')?.value || '';
        return {
            SESSION:     q.get('SESSION') || q.get('session') || '',
            AccountIDSE: q.get('AccountIDSE') || '',
            PatClass:    q.get('PatClass') || 'I',
            PersonID:    q.get('PersonID') || '',
            Hosp:        q.get('Hosp') || 'T0',
            Seed:        q.get('Seed') || '',
            // 檢驗報告頁(MedicalReportContent)專用：另一套參數，非 SESSION 系
            ChartNo:     document.getElementById('hidChartNo')?.value || '',
            WardCode:    bedIdse.split('-')[1]?.trim() || '', // "T0-08C -01-01" → 08C
        };
    }

    // 純英數 token（不用 Date：SimileAjax 在這些頁改寫了 Date.now，會回傳含空格的日期字串）
    function makeToken(key) {
        const rnd = () => Math.random().toString(36).slice(2, 10);
        return 'ntuh_' + key + '_' + rnd() + rnd();
    }

    function openTab(url) {
        if (typeof GM_openInTab !== 'undefined') GM_openInTab(url, { active: false, insert: true, setParent: true });
        else window.open(url, '_blank');
    }

    // lab 特例：第一次背景開常落在登入前院網（該子系統 session 尚未建立），但第一次開會把 session 建起來。
    // 故若失敗就重開一次（等同使用者手動先開一次的效果），給較短預算輪詢回傳。
    async function retryTab(key, params, results) {
        const src = SOURCES[key];
        const token = makeToken(key);
        console.log(LOG, '重試背景頁', key, token);
        deleteSharedData('ntuh_data_' + token);
        openTab(src.buildUrl(params, token));
        const start = Date.now();
        while (Date.now() - start < 20000) {
            const raw = getSharedData('ntuh_data_' + token);
            if (raw) {
                deleteSharedData('ntuh_data_' + token);
                let data; try { data = JSON.parse(raw); } catch { data = { ok: false, error: '解析回傳失敗' }; }
                results[key] = { label: src.label, ...data };
                console.log(LOG, '重試成功', key);
                return;
            }
            await sleep(800);
        }
        console.log(LOG, '重試仍逾時', key); // 保留原本的失敗結果
    }

    async function grabSources(keys) {
        const params = getPageParams();
        const results = {};
        outerCache = {}; // 清掉上一輪 OuterData 快取

        // ── fetch 模式：直接打 OuterData，同源、不開分頁 ──
        const fetchKeys = keys.filter((k) => SOURCES[k].mode === 'fetch');
        const fetchPromises = fetchKeys.map(async (key) => {
            const src = SOURCES[key];
            try {
                const html = await fetchOuterData(src.datatype);
                results[key] = { label: src.label, ok: true, text: src.format(html) };
            } catch (e) {
                results[key] = { label: src.label, ok: false, error: e.message || String(e) };
            }
        });

        // ── tab 模式：背景開權威專頁 → localStorage 回傳 ──
        const tabKeys = keys.filter((k) => SOURCES[k].mode !== 'fetch');
        // 清掉先前殘留（token 不符而未被刪除的）鍵
        Object.keys(localStorage).filter((k) => k.startsWith('ntuh_data_'))
            .forEach((k) => localStorage.removeItem(k));
        const tasks = tabKeys.map((key) => {
            const src = SOURCES[key];
            const token = makeToken(key);
            const url = src.buildUrl(params, token);
            console.log(LOG, '開背景頁', key, token, url);
            openTab(url);
            return { key, src, token };
        });

        const pollPromise = new Promise((resolve) => {
            if (!tasks.length) return resolve();
            const startTime = Date.now();
            const TIMEOUT = 30000; // 藥歷圖 worker 需 postback reload、lab 重頁背景節流（其自身 20s 逾時），給足時間
            const poll = setInterval(() => {
                for (const t of tasks) {
                    if (results[t.key]) continue;
                    const raw = getSharedData('ntuh_data_' + t.token);
                    if (raw) {
                        console.log(LOG, '收到回傳', t.key, raw.slice(0, 80));
                        deleteSharedData('ntuh_data_' + t.token);
                        let data;
                        try { data = JSON.parse(raw); } catch { data = { ok: false, error: '解析回傳失敗' }; }
                        results[t.key] = { label: t.src.label, ...data };
                    }
                }
                // 只剩 lab 沒回時提早收尾（12s），好早點觸發 lab 重試，不必空等到 30s
                const onlyLabLeft = tabKeys.includes('lab') && !results['lab']
                    && tasks.filter((t) => t.key !== 'lab').every((t) => results[t.key]);
                if (tasks.every((t) => results[t.key]) || Date.now() - startTime > TIMEOUT
                    || (onlyLabLeft && Date.now() - startTime > 12000)) {
                    clearInterval(poll);
                    for (const t of tasks) {
                        if (!results[t.key]) results[t.key] = { label: t.src.label, ok: false, error: '逾時' };
                    }
                    resolve();
                }
            }, 800);
        });

        await Promise.all([...fetchPromises, pollPromise]);
        // lab 第一次常落在登入前院網而失敗 → 重開一次（第一次開已把 session 建起來）
        if (keys.includes('lab') && (!results.lab || !results.lab.ok)) {
            await retryTab('lab', params, results);
        }
        // 每個結果掛上「點標題跳轉」網址：fetch 來源用 navUrl；tab 來源用 buildUrl 去掉 token
        keys.forEach((k) => {
            if (!results[k]) return;
            const s = SOURCES[k];
            const url = s.navUrl ? s.navUrl(params)
                : (s.buildUrl ? s.buildUrl(params, '').replace(/&ntuh_token=$/, '') : '');
            if (url) results[k].url = url;
        });
        return keys.map((k) => ({ key: k, ...results[k] }));
    }

    // ═════════════════════════════════════════════
    // UI（協調器面板）— 已停用，統一由 progress-note-filler 一個入口；保留供日後需要
    // ═════════════════════════════════════════════
    // eslint-disable-next-line no-unused-vars
    function createUI() {
        if (document.getElementById('ntuh-dh-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-dh-fab { position: fixed; bottom: 80px; right: 24px; width: 48px; height: 48px; border-radius: 50%; background: #1e3a3a; border: 2px solid #4ac0b0; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 99998; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; user-select: none; }
            #ntuh-dh-fab:hover { transform: scale(1.1); }
            #ntuh-dh-panel { position: fixed; bottom: 80px; right: 24px; width: 240px; background: #1a1f2e; border: 1px solid #2d3650; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); z-index: 99998; font-family: 'Consolas',monospace; font-size: 12px; color: #c8d3e8; display: none; flex-direction: column; overflow: hidden; }
            #ntuh-dh-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #1e3a3a; border-bottom: 1px solid #2d3650; cursor: move; user-select: none; font-size: 13px; font-weight: 600; }
            #ntuh-dh-close { background: none; border: none; color: #7a8aaa; cursor: pointer; font-size: 16px; }
            #ntuh-dh-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
            #ntuh-dh-grab { padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #2a8a7a; color: #fff; }
            #ntuh-dh-grab:hover { opacity: 0.85; }
            #ntuh-dh-grab:disabled { opacity: 0.5; cursor: wait; }
            #ntuh-dh-status { font-size: 11px; min-height: 16px; }
            #ntuh-dh-out { display: flex; flex-direction: column; gap: 6px; }
            .dh-sec { background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; overflow: hidden; }
            .dh-head { display: flex; align-items: center; justify-content: space-between; padding: 5px 8px; background: #1a2130; font-size: 11px; font-weight: 600; cursor: pointer; }
            .dh-copy { background: #2d3650; color: #8fa8d8; border: none; border-radius: 4px; padding: 1px 8px; font-size: 10px; cursor: pointer; }
            .dh-body { margin: 0; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; font-size: 10.5px; line-height: 1.5; max-height: 200px; overflow-y: auto; }
            .dh-ok { color: #4caf7d; } .dh-err { color: #e05c5c; } .dh-warn { color: #f0a030; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-dh-fab';
        fab.textContent = '🩺';
        fab.title = 'Progress 資料抓取';
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-dh-panel';
        panel.innerHTML = `
            <div id="ntuh-dh-header"><span>🩺 資料抓取</span><button id="ntuh-dh-close">✕</button></div>
            <div id="ntuh-dh-body">
                <button id="ntuh-dh-grab">🔄 抓取全部</button>
                <div id="ntuh-dh-status"></div>
                <div id="ntuh-dh-out"></div>
            </div>`;
        document.body.appendChild(panel);

        fab.onclick = () => { fab.style.display = 'none'; panel.style.display = 'flex'; };
        document.getElementById('ntuh-dh-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-dh-header'));

        document.getElementById('ntuh-dh-grab').onclick = async (e) => {
            const btn = e.currentTarget;
            const p = getPageParams();
            if (!p.SESSION || !p.AccountIDSE) {
                setStatus('⚠ 抓不到 SESSION / AccountIDSE', 'err');
                return;
            }
            btn.disabled = true;
            setStatus('🔄 背景開頁抓取中…', 'warn');
            try {
                const results = await grabSources(['tprbp', 'resp', 'gcs', 'uo', 'pain', 'catheter', 'consult', 'diet', 'handover', 'nursing', 'image', 'meds', 'rx', 'lab']);
                renderResults(results);
                const okCount = results.filter((r) => r.ok).length;
                setStatus(okCount === results.length ? '✓ 抓取完成' : `部分成功（${okCount}/${results.length}）`,
                    okCount === results.length ? 'ok' : 'warn');
            } catch (err) {
                setStatus('✗ ' + (err.message || err), 'err');
            } finally {
                btn.disabled = false;
            }
        };
    }

    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-dh-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'dh-ok' : type === 'err' ? 'dh-err' : 'dh-warn';
    }

    function renderResults(results) {
        const wrap = document.getElementById('ntuh-dh-out');
        if (!wrap) return;
        wrap.innerHTML = '';

        // 全部整成單一段落：各標題 [XXX]，項目間空一行
        const combined = results.map((r) => {
            const body = r.ok ? (r.text || '（無資料）') : ('抓取失敗：' + r.error);
            return r.label + '\n' + body;
        }).join('\n\n');

        const sec = document.createElement('div');
        sec.className = 'dh-sec';
        const head = document.createElement('div');
        head.className = 'dh-head';
        const title = document.createElement('span');
        title.textContent = '參考資料';
        const copy = document.createElement('button');
        copy.className = 'dh-copy';
        copy.textContent = '複製';
        head.appendChild(title);
        head.appendChild(copy);
        const body = document.createElement('pre');
        body.className = 'dh-body';
        body.textContent = combined;
        copy.onclick = () => {
            navigator.clipboard.writeText(combined).then(() => {
                copy.textContent = '✅';
                setTimeout(() => { copy.textContent = '複製'; }, 1200);
            });
        };
        sec.appendChild(head);
        sec.appendChild(body);
        wrap.appendChild(sec);
    }

    function makeDraggable(panel, handle) {
        handle.onmousedown = (e) => {
            const rect = panel.getBoundingClientRect();
            const sx = e.clientX, sy = e.clientY, sl = rect.left, st = rect.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = sl + 'px'; panel.style.top = st + 'px';
            document.onmousemove = (ev) => {
                panel.style.left = (sl + ev.clientX - sx) + 'px';
                panel.style.top = (st + ev.clientY - sy) + 'px';
            };
            document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; };
        };
    }

    // ═════════════════════════════════════════════
    init();

})();
