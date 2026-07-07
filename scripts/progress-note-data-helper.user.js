// ==UserScript==
// @name         NTUH Progress Note Data Helper
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.9.1
// @description  在 Progress Note 頁一鍵從各權威專頁背景抓取即時資料：導管（CatheterCare，僅現存）、照會（NotifyOtherDoctor）、飲食（DoctorDietMain，現行供餐醫令）、生命徵象/SpO2/GCS/UO/影像（OuterData 直抓）、抗生素藥歷（chart-medication worker 抗生素+1M）。整理進暫存預覽面板。與 progress-note-filler 分離，專責跨頁資料擷取。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/CatheterCare.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/DoctorDietMain.aspx*
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
        vitals: {
            label: '[Resp]',
            mode: 'fetch',            // 直接打 OuterData，不開分頁
            datatype: 'vitalsign',
            format: formatVitals,
            match: () => false,       // 非分頁來源，路由永不命中
        },
        neuro: {
            label: '[GCS/UO]',
            mode: 'fetch',
            datatype: 'vitalsign',    // 與 vitals 同一份，fetchOuterData 有快取
            format: formatGcsUo,
            match: () => false,
        },
        image: {
            label: '[Image]',
            mode: 'fetch',
            datatype: 'pacs',
            format: formatPacs,
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

    // SpO2 + 給氧裝置：取最新一筆。原始值格式 "SpO2:100%(28%,5L,Mask)"
    function formatVitals(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const recs = [];
        doc.querySelectorAll('tr').forEach((tr) => {
            const txt = tr.innerText.replace(/\s+/g, ' ').trim();
            const m = txt.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\s*SpO2:\s*(\d+)%\(([^)]*)\)/i);
            if (m) recs.push({ dt: m[1], spo2: m[2], inside: m[3] });
        });
        if (!recs.length) return '（無 SpO2 紀錄）';
        // 依日期時間字串排序取最新（YYYY/MM/DD HH:MM 可直接字典序）
        recs.sort((a, b) => (a.dt < b.dt ? 1 : -1));
        const r = recs[0];
        const parts = r.inside.split(',').map((s) => s.trim());
        let fio2 = '', flow = '', deviceRaw = '';
        if (parts.length >= 3) { [fio2, flow, deviceRaw] = parts; }
        else if (parts.length === 1) { deviceRaw = parts[0]; } // 例如 "room air"
        const device = /cannula/i.test(deviceRaw) ? 'NC'
            : /mask/i.test(deviceRaw) ? 'Mask'
            : (deviceRaw || '');
        const bits = ['SpO2 ' + r.spo2 + '%'];
        const dev = [device, (flow && flow !== '' ? flow : '')].filter(Boolean).join(' ');
        if (dev) bits.push(dev);
        if (fio2 && fio2 !== '' && fio2 !== '%') bits.push('FiO2 ' + fio2);
        const when = r.dt.slice(5).replace(/^0/, ''); // 7/03 02:09
        return bits.join(' ') + '  @' + when;
    }

    // GCS（最新一筆，格式 GCS:E4M5V1，V 可能為 A）+ U/O（累計值，無日期）
    function formatGcsUo(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = [...doc.querySelectorAll('tr')].map((tr) => tr.innerText.replace(/\s+/g, ' ').trim());
        const out = [];
        const gcs = [];
        rows.forEach((t) => {
            const m = t.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})\s*GCS:\s*(E\d+M\d+V\w+)/i);
            if (m) gcs.push({ dt: m[1], v: m[2] });
        });
        if (gcs.length) {
            gcs.sort((a, b) => (a.dt < b.dt ? 1 : -1));
            out.push('GCS ' + gcs[0].v + '  @' + gcs[0].dt.slice(5).replace(/^0/, ''));
        }
        let uo = null;
        rows.forEach((t) => { const m = t.match(/U\/O:\s*(\d+)/); if (m && uo === null) uo = m[1]; });
        if (uo !== null) out.push('U/O ' + uo + ' mL');
        return out.length ? out.join('\n') : '（無 GCS/UO）';
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
    const ALL_SOURCE_KEYS = ['vitals', 'neuro', 'catheter', 'consult', 'diet', 'image', 'meds', 'rx', 'lab'];
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
        try {
            console.log(LOG, '背景擷取啟動', src.label, token);
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
            if (typeof GM_openInTab !== 'undefined') {
                GM_openInTab(url, { active: false, insert: true, setParent: true });
            } else {
                window.open(url, '_blank');
            }
            return { key, src, token };
        });

        const pollPromise = new Promise((resolve) => {
            if (!tasks.length) return resolve();
            const startTime = Date.now();
            const TIMEOUT = 24000; // 藥歷圖 worker 需 postback reload，給足時間（其自身 18s 逾時）
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
                if (tasks.every((t) => results[t.key]) || Date.now() - startTime > TIMEOUT) {
                    clearInterval(poll);
                    for (const t of tasks) {
                        if (!results[t.key]) results[t.key] = { label: t.src.label, ok: false, error: '逾時' };
                    }
                    resolve();
                }
            }, 800);
        });

        await Promise.all([...fetchPromises, pollPromise]);
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
                const results = await grabSources(['vitals', 'neuro', 'catheter', 'consult', 'diet', 'image', 'meds', 'rx', 'lab']);
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
