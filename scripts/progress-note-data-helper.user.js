// ==UserScript==
// @name         NTUH Progress Note Data Helper
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.7.0
// @description  在 Progress Note 頁一鍵從各權威專頁背景抓取即時資料：導管（CatheterCare，僅現存）、照會（NotifyOtherDoctor）、飲食（DoctorDietMain，現行供餐醫令）、護理交班筆記（OffDutyNurV2 筆記欄）、今日護理過程紀錄（NursingProgressNote，自動點顯示紀錄）、生命徵象/SpO2/GCS/UO/影像（OuterData 直抓）、抗生素藥歷（chart-medication worker 抗生素+1M）。整理進暫存預覽面板。與 progress-note-filler 分離，專責跨頁資料擷取。v1.0.0：病人識別（ChartNo/AccountIDSE/PersonID/SESSION/WardCode）改用多來源解析＋id 尾綴選取器，修正 Progress 頁抓不到 ChartNo 導致檢驗報告([Lab])開空白頁的問題；缺參數的來源不再空開分頁等逾時；檢驗報告呈現2週。v1.1.0：移除 [Lab] 的專屬提早收尾（12s）與失敗重開一次（retryTab）——「開空白頁」的根因是抓不到 ChartNo，v1.0.0/v1.0.1 已修，該鷹架已無作用；lab 改與其他背景來源同步，共用同一輪 30s 輪詢。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/DoctorDietMain.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/DoctorDietMain.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OffDutyNurV2.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OffDutyNurV2.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/NursingProgressNote.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/NursingProgressNote.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
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

    // HIS 頁的 date.js 把 Date.now 覆寫成回傳 Date 物件（非數字）。做減法時靠隱式
    // valueOf 還能僥倖過關，但一旦 JSON.stringify（SESSION 快取的 savedAt）就會變成
    // ISO 字串，讀回來相減得 NaN、快取永遠失效。取毫秒一律走這個安全版。
    function nowMs() { return new Date().getTime(); }

    // 院區網域：總院 ihisaw / 新竹分院 hchihisaw。一律取當前頁面 origin，跨院區自動對應。
    const HIS_ORIGIN = location.origin;

    // ─────────────────────────────────────────────
    // fetch 來源的「點標題跳轉」網址（tab 來源直接用 buildUrl 去 token；fetch 來源沒有頁，另給）
    // 皆為 function 宣告（hoist），供下方 SOURCES 物件字面量引用
    // ─────────────────────────────────────────────
    function vitalsNavUrl(p) {
        return HIS_ORIGIN + '/WebApplication/InPatient/Nursing/VitalSign_TPR.aspx'
            + `?session=${p.SESSION}&AccountIDSE=${p.AccountIDSE}`;
    }
    function catheterNavUrl(p) {
        return HIS_ORIGIN + '/WebApplication/InPatient/Nursing/CatheterCare.aspx'
            + `?session=${p.SESSION}&AccountIDSE=${p.AccountIDSE}&PatClass=${p.PatClass || 'I'}`;
    }
    function pacsNavUrl(p) {
        return HIS_ORIGIN + '/WebApplication/ElectronicMedicalReportViewer/PACSImageShowList.aspx'
            + `?PersonID=${p.PersonID}&Seed=${p.Seed || ''}`;
    }

    // 檢驗報告要往前多抓幾天（負數，MedicalReportContent.aspx 的 IntervalDay 參數）。
    // 語意是「往前多推 n 天」且含當日，所以拿到的是 n+1 天：-1 是兩天、-13 是 14 天。
    // 想要 14 天請填 -13 而不是 -14。改這裡就好，[Lab] 區塊與跳轉網址都吃這個值。
    const LAB_INTERVAL_DAY = -13;

    // ═════════════════════════════════════════════
    // 資料來源定義：每個來源 = 一個權威專頁
    //   buildUrl(params, token) → 背景頁網址（帶 ntuh_token）
    //   match(url)              → 該頁是否為此來源
    //   extract()              → 背景頁擷取邏輯，回傳文字（背景端執行）
    //   label                  → 預覽面板標題
    // ═════════════════════════════════════════════
    const SOURCES = {
        // 管路：不再開分頁，直接打 CatheterCare_Handler（同 morning-briefing），並逐條驗證病人（見 fetchTubes）
        catheter: { label: '[Tubes]', mode: 'fetch', run: fetchTubes, navUrl: catheterNavUrl, match: () => false },
        consult: {
            label: '[Consult]',
            match: (u) => /\/Ward\/NotifyOtherDoctor\.aspx/i.test(u),
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/InPatient/Ward/NotifyOtherDoctor.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractConsult,
        },
        diet: {
            label: '[Diet]',
            match: (u) => /\/Ward\/DoctorDietMain\.aspx/i.test(u),
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/InPatient/Ward/DoctorDietMain.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractDiet,
        },
        handover: {
            label: '[Handover]',
            match: (u) => /\/Ward\/OffDutyNurV2\.aspx/i.test(u),
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/InPatient/Ward/OffDutyNurV2.aspx' +
                `?SESSION=${p.SESSION}&InQuerySortMode=QByEmp&AccountIDSE=${p.AccountIDSE}&Type=Nur` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            extract: extractHandover,
        },
        nursing: {
            label: '[Nursing]',
            match: (u) => /\/Nursing\/NursingProgressNote\.aspx/i.test(u),
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/InPatient/Nursing/NursingProgressNote.aspx' +
                `?SESSION=${p.SESSION}&AccountIDSE=${p.AccountIDSE}` +
                `&ntuh_token=${encodeURIComponent(token)}`,
            prepare: prepareNursing,
            extract: extractNursing,
        },
        // vitalsign 拆成 2 個來源：tprbp（帶時序給圖與數據表）、uo（只為沒有日期的 U/O），共用同一份 fetch（datatype 快取），各自無值顯示（無）
        // navUrl：點標題跳轉 VitalSign_TPR.aspx（生命徵象圖）
        tprbp: { label: '[TPR+BP]', mode: 'fetch', datatype: 'vitalsign', format: formatTprBp, extra: vitalExtra, navUrl: vitalsNavUrl, match: () => false },
        uo:    { label: '[UO]',     mode: 'fetch', datatype: 'vitalsign', format: formatUo,    navUrl: vitalsNavUrl, match: () => false },
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
        // 優先 direct（直接 fetch 藥歷表，不開分頁、不依賴 chart-medication）；direct 失敗才退回開 Chart.aspx 的舊做法
        meds: {
            label: '[Abx]',
            direct: fetchAbx,
            match: () => false, // Chart.aspx 由 chart-medication 處理，data-helper 不 @match
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/OtherIndependentProj/MedicationHistory/Chart.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
        // 現行處方：worker 是 prescription-viewer.user.js（跑在 MedicationV2.aspx）
        rx: {
            label: '[Rx]',
            match: () => false, // MedicationV2.aspx 由 prescription-viewer 處理
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/InPatient/Ward/MedicationV2.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&AccountIDSE=${p.AccountIDSE}` +
                `&PersonID=${p.PersonID}&Hosp=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&EMRPop=Y` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
        // 檢驗報告：worker 是 lab-summary.user.js（跑在 MedicalReportContent.aspx，預設清單）
        // 此頁靠 ChartNo 定位病人，另帶 WardCode/HospitalCode。
        // SESSION 是選填不是必要：不帶它這頁一樣開得起來（手動貼不含 SESSION 的網址
        // 可正常帶出資料），有就帶上。因此 SOURCE_REQUIRES.lab 只要求 ChartNo。
        // v1.1.0 起 lab 不再有專屬的提早收尾＋重試：原本「開空白頁」的根因是
        // Progress 頁抓不到 ChartNo（v1.0.0/v1.0.1 已修多來源解析＋分院格式），
        // 不是 session 未建立，所以那套鷹架已無作用，移除後與其他 tab 來源同步。
        // IntervalDay 為負數＝往前多推幾天（-1 只有這兩天，-13 可帶出 14 天）。
        lab: {
            label: '[Lab]',
            match: () => false, // MedicalReportContent.aspx 由 lab-summary 處理
            buildUrl: (p, token) =>
                HIS_ORIGIN + '/WebApplication/ElectronicMedicalReportViewer/MedicalReportContent.aspx' +
                `?SESSION=${p.SESSION}&PatClass=${p.PatClass || 'I'}&WardCode=${p.WardCode}&ChartNo=${p.ChartNo}` +
                `&HospitalCode=${p.Hosp || 'T0'}&Seed=${p.Seed || ''}&IntervalDay=${LAB_INTERVAL_DAY}` +
                `&ntuh_token=${encodeURIComponent(token)}`,
        },
    };

    // ═════════════════════════════════════════════
    // 背景端擷取邏輯（STUB：先抓最可能的資料表全文，DOM 確認後精修）
    // ═════════════════════════════════════════════
    // 周邊留置針不列入（但 CVC/PICC/Port-A 等中央導管要留）
    const CATH_PERIPHERAL_RE = /留置針|IV\s*Catheter/i;

    // ─── 管路（CatheterCare_Handler.aspx）───────────────────────
    // 頁面的資料來自 GET CatheterCare_Handler.aspx?mode=getCatheterRecord&catherStatus=UnRemovedOnly（XML）。
    // 這個請求「不帶任何病人識別」：伺服器靠「最近載入 CatheterCare.aspx 的那位病人」決定回誰，
    // 額外參數一律被忽略（新竹實測 2026-09-30，見 morning-briefing）。所以：
    //   1. 一次一位（tubeChain 串行），先載入該病人的頁面 HTML（不跑頁面 JS）再立刻打 handler。
    //   2. 每條管路的 <decorate> 都帶 <caseno>（＝AccountIDSE），逐條驗證，對不上就整批丟棄。
    // 已知盲點：這位病人若一條管路都沒有，就沒有 caseno 可驗證；此時若有人在別的分頁操作 CatheterCare，
    // 理論上可能拿到別人的空結果。抓取期間不要同時操作 CatheterCare。
    const tubeText = (node, tag) => { const e = node.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const tubeInsertMs = (t) => {
        const m = t.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
    };
    let tubeChain = Promise.resolve();
    function fetchTubes(p) {
        const run = async () => {
            if (!p.SESSION || !p.AccountIDSE) throw new Error('缺少 SESSION/AccountIDSE');
            const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '').replace(/Ward\/$/, '') + 'Nursing/';
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            try {
                const opt = { credentials: 'same-origin', signal: ctrl.signal };
                const page = await fetch(`${dir}CatheterCare.aspx?session=${encodeURIComponent(p.SESSION)}&AccountIDSE=${encodeURIComponent(p.AccountIDSE)}&PatClass=${encodeURIComponent(p.PatClass || 'I')}`, opt);
                if (!page.ok) throw new Error('管路頁 HTTP ' + page.status);
                await page.text();
                const res = await fetch(`${dir}CatheterCare_Handler.aspx?aa=${nowMs()}&mode=getCatheterRecord&catherStatus=UnRemovedOnly`, opt);
                if (!res.ok) throw new Error('管路資料 HTTP ' + res.status);
                const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
                if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('UnRemovedCatheter').length) throw new Error('管路資料格式不符');
                const decs = [...doc.getElementsByTagName('decorate')];
                const total = parseInt(tubeText(doc.getElementsByTagName('UnRemovedCatheter')[0], 'TotalCount'), 10);
                if (Number.isFinite(total) && total !== decs.length) throw new Error(`管路數量不符（${total}／${decs.length}）`);
                if (decs.some((d) => tubeText(d, 'caseno') !== String(p.AccountIDSE))) throw new Error('管路資料與病人不符，已丟棄');
                const today = new Date(nowMs()); today.setHours(0, 0, 0, 0);
                const lines = decs.map((d) => ({ full: tubeText(d, 'CatheterName'), startMs: tubeInsertMs(tubeText(d, 'CatheterInsertDateTime')) }))
                    .filter((x) => x.full && !CATH_PERIPHERAL_RE.test(x.full) && Number.isFinite(x.startMs))
                    .sort((a, b) => a.startMs - b.startMs)
                    .map((x) => {
                        const d0 = new Date(x.startMs);
                        const day = Math.round((today.getTime() - new Date(d0.getFullYear(), d0.getMonth(), d0.getDate()).getTime()) / 86400000) + 1;
                        return `${x.full}  ${d0.getMonth() + 1}/${d0.getDate()}（Day ${day}）`;
                    });
                return { text: lines.length ? lines.join('\n') : '（無現存導管）' };
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        };
        const job = tubeChain.then(run, run);
        tubeChain = job.catch(() => {});
        return job;
    }

    // ─── 抗生素（MedicationHistory/Default.aspx，同 morning-briefing 的做法）───────────────
    // GET 取得 WebForms 表單，再 POST「抗生素」查詢；以院方分類為準，不自己比對藥名。
    // 查詢所有病人類別（避免「全選」Changed handler 清掉住院勾選），解析時只留第一欄「住」。
    // 與 morning-briefing 的差別：那邊只看近 2 天；這裡要「進行中＋近一個月已停用」（同 chart-medication 的 1M），所以 days 設 ABX_DAYS。
    // ⚠️ 未在實機驗證：days=31 伺服器是否照辦、「處方內容」欄的格式——失敗時 grabSources 會退回開 Chart.aspx 的舊做法。
    const ABX_DAYS = 31;

    // 藥名欄是「學名 (商品名 劑型 strength)」，抗生素要顯示商品名（對齊 chart-medication 的 TradeName）。
    // 邏輯同 prescription-viewer 的 extractBrand（改動時兩邊要同步；這裡不含 BRAND_OVERRIDES——點滴／Xigduo 與抗生素無關）：
    // 先清管制藥標記 (管N)、鹽類註記 (as HCl salt)，丟掉第一個 '(' 前的學名，再取第一個「非中文開頭、非數字開頭」的 token。
    function extractBrand(fullName) {
        if (!fullName) return '';
        let src = fullName.replace(/^\s*\[自備藥\]\s*/, '');
        src = src.replace(/[（(]\s*管\s*\d+\s*[）)]/g, ' ');
        src = src.replace(/\(\s*as\b[^)]*\)/gi, ' ');
        const q = src.indexOf('(');
        if (q >= 0) src = src.slice(q + 1);
        src = src.replace(/[()（）]/g, ' ');
        const tokens = src.trim().split(/\s+/);
        for (const tok of tokens) {
            if (!tok) continue;
            if (/^[一-鿿㐀-䶿]/.test(tok)) continue; // 開頭中文（劑型前綴或中文品名）
            if (/^\d/.test(tok)) continue;            // 數字開頭（劑量／strength）
            return tok.replace(/[,;]+$/, '');
        }
        return tokens.find(Boolean) || src.trim();
    }
    const dayStartMs = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

    function abxQuery(doc, now) {
        const form = doc.querySelector('form');
        const query = doc.querySelector('[id$="_btnQuery"]');
        const antibiotics = doc.querySelector('[id$="_ckbAntibiotics"]');
        const date = doc.querySelector('[id$="_txbStartDate"]');
        const days = doc.querySelector('[id$="_txbDays"]');
        const patientTypes = [...doc.querySelectorAll('input[id*="_cblPatientType_"]')];
        if (!form || !query || !antibiotics || !date || !days || !patientTypes.length
            || !form.querySelector('input[name="__VIEWSTATE"]')) throw new Error('藥歷查詢表單讀不到');
        const body = new URLSearchParams();
        // 保留隱藏欄位（包含分段 VIEWSTATE）；不帶預設藥物分類、保存選項或其他按鈕。
        for (const el of form.querySelectorAll('input')) {
            if (!el.name || el.disabled || ['submit', 'button', 'checkbox', 'radio'].includes(el.type)) continue;
            body.append(el.name, el.value);
        }
        body.set('__EVENTTARGET', '');
        body.set('__EVENTARGUMENT', '');
        const d = new Date(now);
        body.set(date.name, `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
        body.set(days.name, String(ABX_DAYS));
        for (const el of patientTypes) body.set(el.name, el.value);
        const all = doc.querySelector('[id$="_ckbPatientTypeAll"]');
        if (all) body.set(all.name, all.value);
        body.set(antibiotics.name, antibiotics.value);
        body.set(query.name, query.value);
        return body;
    }

    // 結果表 → 依藥名彙整成「進行中／已停用」，輸出格式對齊 chart-medication（進行中 → 分隔線 → 已停用；全部已停用則先標 free）
    function parseAbx(doc, now) {
        const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
        const table = doc.querySelector('[id$="_grvData"]');
        if (!table) {
            if (txt(doc.querySelector('[id$="_lblMessage"]')).includes('日期範圍查無勾選範圍的處方資料')) return '(no abx)';
            throw new Error('藥歷結果表讀不到');
        }
        const headers = [...table.rows[0].cells].map(txt);
        const start = headers.indexOf('開始日'), stop = headers.indexOf('停用日');
        const nameCol = headers.indexOf('藥名'), content = headers.indexOf('處方內容');
        if ([start, stop, nameCol, content].some((i) => i < 0)) throw new Error('藥歷欄位格式改變');
        const dateMs = (text) => {
            const m = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
            if (!m) throw new Error('藥歷日期格式無法判讀');
            return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
        };
        const today = dayStartMs(now);
        const groups = new Map();
        for (const tr of [...table.rows].slice(1)) {
            if (txt(tr.cells[0]) !== '住') continue;
            if (tr.cells.length !== headers.length) throw new Error('藥歷資料列格式改變');
            const startMs = dateMs(txt(tr.cells[start]));
            const stopText = txt(tr.cells[stop]);
            if (startMs > today) continue; // 還沒開始的醫令
            const stopMs = stopText ? dateMs(stopText) : null;
            const rawName = txt(tr.cells[nameCol]);
            if (!rawName) throw new Error('藥歷藥名缺漏');
            const brand = extractBrand(rawName); // 抽不到（或抽出劑量之類數字開頭的東西）就退回學名
            const name = (brand && !/^\d/.test(brand) ? brand : rawName.split('(')[0].trim()).slice(0, 40);
            if (!groups.has(name)) groups.set(name, []);
            groups.get(name).push({ startMs, stopMs, ongoing: stopMs === null || stopMs >= today, prescription: txt(tr.cells[content]) });
        }
        const md = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
        const ongoing = [], stopped = [];
        for (const [name, orders] of groups) {
            const earliest = Math.min(...orders.map((o) => o.startMs));
            const live = orders.filter((o) => o.ongoing);
            const newest = (live.length ? live : orders).slice().sort((a, b) => b.startMs - a.startMs)[0];
            const row = { name, regimen: newest.prescription.slice(0, 80), startKey: earliest };
            if (live.length) {
                ongoing.push({ ...row, range: md(earliest) + '-', day: 'D' + (Math.round((today - earliest) / 86400000) + 1), endKey: Infinity });
            } else {
                const last = Math.max(...orders.map((o) => o.stopMs));
                stopped.push({ ...row, range: md(earliest) + '-' + md(last), day: '', endKey: last });
            }
        }
        ongoing.sort((a, b) => b.startKey - a.startKey);
        stopped.sort((a, b) => (b.endKey - a.endKey) || (b.startKey - a.startKey));
        if (!ongoing.length && !stopped.length) return '(no abx)';
        const all = ongoing.concat(stopped);
        const wName = Math.max(...all.map((r) => r.name.length)), wReg = Math.max(...all.map((r) => r.regimen.length));
        const line = (r) => (r.name.padEnd(wName + 2) + r.regimen.padEnd(wReg + 2) + r.range + (r.day ? ' ' + r.day : ''));
        const blocks = [];
        if (ongoing.length) blocks.push(ongoing.map(line).join('\n'));
        if (ongoing.length && stopped.length) blocks.push('-----------');
        if (!ongoing.length && stopped.length) { blocks.push('free'); blocks.push('-----------'); }
        if (stopped.length) blocks.push(stopped.map(line).join('\n'));
        return blocks.join('\n');
    }

    async function fetchAbx(p) {
        if (!p.SESSION || !p.PersonID) throw new Error('缺少 SESSION/PersonID');
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 45000);
        try {
            const url = HIS_ORIGIN + '/WebApplication/OtherIndependentProj/MedicationHistory/Default.aspx'
                + `?SESSION=${encodeURIComponent(p.SESSION)}&PersonID=${encodeURIComponent(p.PersonID)}`;
            const initial = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
            if (!initial.ok) throw new Error('HTTP ' + initial.status);
            let doc = new DOMParser().parseFromString(await initial.text(), 'text/html');
            const now = nowMs();
            // 已保存的「全部藥物」選項若觸發 Changed handler，可能清掉抗生素勾選：
            // 用回傳的新表單再送一次；仍未套用抗生素分類就報錯，不能把其他藥當抗生素。
            for (let attempt = 0; attempt < 2; attempt++) {
                const res = await fetch(url, { method: 'POST', body: abxQuery(doc, now), credentials: 'same-origin', signal: ctrl.signal });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                doc = new DOMParser().parseFromString(await res.text(), 'text/html');
                const selected = [...doc.querySelectorAll('input[type="checkbox"]:checked')]
                    .filter((el) => /_ckb/.test(el.id) && !/_ckbPatientTypeAll$/.test(el.id));
                if (selected.length === 1 && selected[0].id.endsWith('_ckbAntibiotics')) return { text: parseAbx(doc, now) };
            }
            throw new Error('藥歷未套用抗生素分類');
        } catch (e) {
            throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
        } finally { clearTimeout(timer); }
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

    // ═════════════════════════════════════════════
    // 病人識別解析（參考 Better Portal 的 patient-page-context.js）
    // ─────────────────────────────────────────────
    // 舊版直接 getElementById('hidChartNo')。這頁是 ASP.NET WebForms，控制項 id 會被
    // naming container 加前綴（NTUHWeb1_…），精確比對抓不到 → ChartNo 空 → 檢驗報告頁
    // (MedicalReportContent.aspx) 開出空白/被導回登入頁。改成多來源解析＋尾綴選取器。
    // ═════════════════════════════════════════════

    // query 參數不分大小寫（各頁混用 SESSION/session、ChartNo/chartno）
    function qGet(name) {
        const want = name.toLowerCase();
        for (const [k, v] of new URLSearchParams(window.location.search)) {
            if (k.toLowerCase() === want && v) return v;
        }
        return '';
    }

    // 用「id 尾綴」比對，跳過 naming container 前綴；同時吃 input.value 與文字節點
    function readIdSuffix(suffix) {
        for (const el of document.querySelectorAll(`[id$="${suffix}" i]`)) {
            const raw = el.value ?? el.getAttribute('value') ?? el.textContent ?? '';
            const v = String(raw).trim();
            if (v) return v;
        }
        return '';
    }

    // 病歷號格式**依院區而異**：總院為 6–10 碼純數字；新竹分院帶英文前綴（如 HB14397）。
    // 別把總院格式當成 NTUH 格式——原本寫死 /^\d{6,10}$/，在新竹會把六層解析鏈撈到的
    // 正確值全部擋掉，然後回報「缺少 ChartNo」。前綴放寬到 0–3 碼英文。
    // 仍保留「不含分隔符」的限制，避免把 2026/07/29 這種日期當病歷號收進來；
    // 有英文前綴時數字段收緊到 4–8 碼，讓身分證形狀（1 碼英文 + 9 碼數字）落在範圍外。
    const CHART_NO_RE = /^(?:\d{6,10}|[A-Za-z]{1,3}\d{4,8})$/;
    function pickChartNo(raw, loose = false) {
        const s = String(raw || '').trim();
        if (!s) return '';
        if (CHART_NO_RE.test(s)) return s;
        if (!loose) return '';
        return s.replace(/\s+/g, ' ')
            .match(/(?:病歷號|病歷|ChartNo)[:：\s]*(\d{6,10}|[A-Za-z]{1,3}\d{4,8})/i)?.[1] || '';
    }

    // 檢驗報告頁的分頁 holder，其 name/param 形如 LabReport_{chartNo}_{accountIdSe}
    const LAB_CTX_SELECTORS = [
        '#lsvMenuGroup_ctrl0_lsvMenuItem_ctrl0_itemHolder',
        '#rReportTab_lsvReportTab_ctrl0_tabHolder',
    ];
    function getLabReportContext() {
        for (const attr of ['name', 'param']) {
            for (const sel of LAB_CTX_SELECTORS) {
                const m = document.querySelector(sel)?.getAttribute(attr)
                    ?.match(/^LabReport_(\d+)_([^_]+)$/i);
                if (m) return { chartNo: m[1], accountIdSe: m[2] };
            }
        }
        return { chartNo: '', accountIdSe: '' };
    }

    function resolveChartNo() {
        const labCtx = getLabReportContext();
        const strict = [
            qGet('ChartNo'),
            readIdSuffix('hidChartNo'),
            readIdSuffix('lblChartNo'),
            readIdSuffix('ChartNo'),      // 任何 id 以 ChartNo 結尾者
            labCtx.chartNo,
        ];
        for (const c of strict) {
            const v = pickChartNo(c);
            if (v) return v;
        }
        // 最後手段：病人資訊橫幅的文字（只收「病歷號 1234567」這種有標籤的）
        const banner = document.getElementById('UpperBannerInfoTable')
            || document.querySelector('[id*="PatientAbstractBasicInfo"]');
        return pickChartNo(banner?.innerText || banner?.textContent, true);
    }

    function resolveAccountIdSe() {
        return qGet('AccountIDSE') || qGet('AccountIDSEList')
            || readIdSuffix('hidAccountNo') || readIdSuffix('hidAccountIdse')
            || getLabReportContext().accountIdSe;
    }

    function resolvePersonId() {
        return qGet('PersonID') || readIdSuffix('hidPersonId');
    }

    // 病房代碼：BedIDSE 形如 "T0-08C -01-01" → 取第二段 08C；另留 hidWardCode 備援
    function resolveWardCode() {
        const bedIdse = readIdSuffix('HiddenFieldBedIDSE');
        return bedIdse.split('-')[1]?.trim() || qGet('WardCode') || readIdSuffix('hidWardCode');
    }

    // SESSION：URL 沒帶時從整頁 HTML 撈（頁內連結都帶著），再不行用 6 小時內的快取
    const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
    const SESSION_CACHE_KEY = 'ntuh_portal_session';

    // SESSION 是憑證，優先存進 userscript 專屬的 GM storage（同網域的其他腳本讀不到），
    // 沒有 GM API 時才退回 localStorage。刻意不沿用 setSharedData：那個會兩邊都寫，
    // 等於還是把 token 留在 localStorage，失去隔離的意義。
    function saveSession(session) {
        if (!session) return;
        const payload = JSON.stringify({
            origin: window.location.origin, session, savedAt: nowMs(),
        });
        if (typeof GM_setValue !== 'undefined') {
            try {
                GM_setValue(SESSION_CACHE_KEY, payload);
                // 清掉舊版留在 localStorage 的 token
                try { localStorage.removeItem(SESSION_CACHE_KEY); } catch (e) { /* noop */ }
                return;
            } catch (e) { /* 落到 localStorage */ }
        }
        try { localStorage.setItem(SESSION_CACHE_KEY, payload); } catch (e) { /* noop */ }
    }
    function getCachedSession() {
        let raw = '';
        if (typeof GM_getValue !== 'undefined') {
            try { raw = GM_getValue(SESSION_CACHE_KEY, '') || ''; } catch (e) { raw = ''; }
        }
        if (!raw) {
            try { raw = localStorage.getItem(SESSION_CACHE_KEY) || ''; } catch (e) { raw = ''; }
        }
        try {
            const o = JSON.parse(raw || 'null');
            if (o && o.origin === window.location.origin && typeof o.session === 'string'
                && nowMs() - o.savedAt < SESSION_TTL_MS) return o.session;
        } catch (e) { /* noop */ }
        return '';
    }
    function resolveSession() {
        const found = qGet('SESSION')
            || document.documentElement.innerHTML.match(/SESSION=([a-zA-Z0-9]{34})/i)?.[1] || '';
        if (found) { saveSession(found); return found; }
        return getCachedSession();
    }

    // ─────────────────────────────────────────────
    // fetch 模式來源：直接打 Progress 頁的 OuterData API（同源，不開分頁）
    // ─────────────────────────────────────────────
    function getOuterParams() {
        return {
            AccountIdse: resolveAccountIdSe(),
            PersonId:    resolvePersonId(),
            ChartNo:     resolveChartNo(),
            DeptCode:    readIdSuffix('hidDeptCode'),
            EmpDeptCode: readIdSuffix('hidEmpDeptCode'),
        };
    }

    // 同一次抓取內共用（多個 fetch 來源可能用同一 datatype，如 vitalsign）。
    // 請求本身走共用 lib NTUHAsmx（同 morning-briefing）：併發上限、進行中去重、逾時 30 秒
    // （計時含排隊時間，所以比單發請求寬鬆；原本自己寫的 fetch 是 12 秒、沒有排隊）。
    const OUTER_TIMEOUT_MS = 30000;
    let outerCache = {};
    function fetchOuterData(datatype) {
        if (!outerCache[datatype]) {
            outerCache[datatype] = window.NTUHAsmx.outerData(datatype, { context: getOuterParams(), timeoutMs: OUTER_TIMEOUT_MS });
        }
        return outerCache[datatype];
    }

    // vitalsign 解析一律走 lib/news2.js（與 morning-briefing 同一份）。
    // 之前自己寫的 scanVitals 要求 "R:" 後面一定有數字，但實測 R 常是空的（"T:37.1 P:84 R:"），
    // 那一整列 T/P 會被丟掉；也沒排除 0001/01/01 的佔位列。
    //   TPR "T:36.4 P:103 R:20"、BP "BP:111/71"、SpO2 "SpO2:97%(...)"、Pain "Pain score:0"、
    //   GCS "GCS:E4M5V1"(V 可為 A)、U/O "U/O:250"（可能無日期）
    let vitalParsed = null; // 單筆快取：5 個分項來源共用同一份 html，只解析一次
    function parseVitals(html) {
        if (vitalParsed && vitalParsed.html === html) return vitalParsed;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const txt = (el) => el.textContent.replace(/\s+/g, ' ').trim();
        let texts = [...doc.querySelectorAll('[id$="_Content"]')].map(txt);
        if (!texts.length) texts = [...doc.querySelectorAll('tr')].map(txt);
        const obs = window.NTUHNews2.parseVitalRows(texts);
        // Pain 在 news2 不算觀察值（會多出一組全空的列），所以單獨抓：[{ ms, v }]
        const pains = [];
        for (const t of texts) {
            const m = t.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}).*?Pain(?:\s*score)?:\s*(\d+)/i);
            if (m && +m[1] >= 2000) pains.push({ ms: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(), v: +m[6] });
        }
        pains.sort((a, b) => a.ms - b.ms);
        vitalParsed = { html, obs, pains, uo: window.NTUHNews2.parseUo(texts) };
        return vitalParsed;
    }
    // 圖用的時序：只留近 72 小時避免撐大 localStorage
    function vitalExtra(html) {
        const { obs, pains } = parseVitals(html);
        const last = obs.length ? obs[obs.length - 1].ms : 0;
        return { series: obs.filter((o) => o.ms >= last - 72 * 3600000), pains: pains.filter((o) => o.ms >= last - 72 * 3600000) };
    }
    const two = (n) => String(n).padStart(2, '0');
    const vWhen = (ms) => {
        if (!Number.isFinite(ms)) return '';
        const d = new Date(ms);
        return `  @${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`;
    };

    // tprbp 的文字不顯示（卡片已由生命徵象圖取代），只留一行摘要；真正的內容是 extra 帶出的 series
    function formatTprBp(html) {
        const { obs } = parseVitals(html);
        return obs.length ? `（${obs.length} 組量測，最新${vWhen(obs[obs.length - 1].ms)}）` : '（無）';
    }
    // 無值一律回「（無）」
    function formatUo(html) {
        const u = parseVitals(html).uo; // 有日期取最新；無日期原樣呈現；0 視為尚未填寫（news2 的規則，與 morning-briefing 一致）
        return u ? 'U/O ' + u.val + ' mL' + vWhen(u.ms) : '（無）';
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
    const ALL_SOURCE_KEYS = ['tprbp', 'uo', 'catheter', 'consult', 'diet', 'handover', 'nursing', 'image', 'meds', 'rx', 'lab'];
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
            const t0 = nowMs();
            const TIMEOUT = 15000;
            let text = null;
            while (nowMs() - t0 < TIMEOUT) {
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
        return {
            SESSION:     resolveSession(),
            AccountIDSE: resolveAccountIdSe(),
            PatClass:    qGet('PatClass') || 'I',
            PersonID:    resolvePersonId(),
            Hosp:        qGet('Hosp') || 'T0',
            Seed:        qGet('Seed') || '',
            // 檢驗報告頁(MedicalReportContent)專用
            ChartNo:     resolveChartNo(),
            WardCode:    resolveWardCode(),
        };
    }

    // 各來源開頁前的必要參數；缺就別開（開了也是空白頁或被導回登入，白等 30 秒再重試）
    const SOURCE_REQUIRES = {
        consult:  ['SESSION', 'AccountIDSE', 'PersonID'],
        diet:     ['SESSION', 'AccountIDSE', 'PersonID'],
        handover: ['SESSION', 'AccountIDSE'],
        nursing:  ['SESSION', 'AccountIDSE'],
        meds:     ['SESSION', 'AccountIDSE', 'PersonID'],
        rx:       ['SESSION', 'AccountIDSE', 'PersonID'],
        lab:      ['ChartNo'],
    };
    function missingParams(key, params) {
        return (SOURCE_REQUIRES[key] || []).filter((f) => !params[f]);
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

    async function grabSources(keys) {
        const params = getPageParams();
        const results = {};
        outerCache = {}; // 清掉上一輪 OuterData 快取
        // 抓不到某來源時，先看這行判斷是哪個識別參數沒解析到（SESSION 只印長度）
        console.log(LOG, '解析到的參數', {
            ...params, SESSION: params.SESSION ? `(${params.SESSION.length} 碼)` : '(無)',
        });

        // ── fetch 模式：直接打 OuterData，同源、不開分頁 ──
        const fetchKeys = keys.filter((k) => SOURCES[k].mode === 'fetch');
        const fetchPromises = fetchKeys.map(async (key) => {
            const src = SOURCES[key];
            try {
                if (src.run) { // 自帶抓取邏輯（不經 OuterData）
                    results[key] = { label: src.label, ok: true, ...(await src.run(params)) };
                } else {
                    const html = await fetchOuterData(src.datatype);
                    results[key] = { label: src.label, ok: true, text: src.format(html), ...(src.extra ? src.extra(html) : {}) };
                }
            } catch (e) {
                results[key] = { label: src.label, ok: false, error: e.message || String(e) };
            }
        });

        // ── tab 模式：背景開權威專頁 → localStorage 回傳 ──
        // 先擋掉缺參數的來源：開了也只會拿到空白頁或登入頁，還會白等到逾時
        // direct 來源（目前只有 meds）：先直接 fetch，失敗才退回開分頁（fallbackKeys，由下方輪詢區補開）
        const directKeys = keys.filter((k) => SOURCES[k].direct);
        const fallbackKeys = [];
        const directPromises = directKeys.map(async (key) => {
            const src = SOURCES[key];
            try {
                results[key] = { label: src.label, ok: true, ...(await src.direct(params)) };
            } catch (e) {
                console.warn(LOG, key, '直接抓取失敗，退回開分頁：', e.message || e);
                fallbackKeys.push(key);
            }
        });
        const tabKeys = [];
        keys.filter((k) => SOURCES[k].mode !== 'fetch' && !SOURCES[k].direct).forEach((key) => {
            const miss = missingParams(key, params);
            if (miss.length) {
                results[key] = { label: SOURCES[key].label, ok: false, error: '缺少 ' + miss.join('/') };
                console.warn(LOG, '略過', key, '缺少參數', miss);
            } else {
                tabKeys.push(key);
            }
        });
        // 清掉先前殘留（token 不符而未被刪除的）鍵
        Object.keys(localStorage).filter((k) => k.startsWith('ntuh_data_'))
            .forEach((k) => localStorage.removeItem(k));
        const openTask = (key) => {
            const src = SOURCES[key];
            const token = makeToken(key);
            const url = src.buildUrl(params, token);
            console.log(LOG, '開背景頁', key, token, url);
            openTab(url);
            return { key, src, token };
        };
        const tasks = tabKeys.map(openTask);

        const pollPromise = new Promise((resolve) => {
            (async () => {
                // direct 先跑完；失敗的來源這時才補開分頁（沒有 direct 來源時等於立刻往下）
                await Promise.all(directPromises);
                for (const key of fallbackKeys) {
                    const miss = missingParams(key, params);
                    if (miss.length) { results[key] = { label: SOURCES[key].label, ok: false, error: '缺少 ' + miss.join('/') }; continue; }
                    tasks.push(openTask(key));
                }
                startPoll();
            })();
            function startPoll() {
            if (!tasks.length) return resolve();
            const startTime = nowMs();
            const TIMEOUT = 30000; // 由最慢的來源決定：藥歷圖 worker 需 postback reload、lab 重頁（360KB）背景會被節流
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
                if (tasks.every((t) => results[t.key]) || nowMs() - startTime > TIMEOUT) {
                    clearInterval(poll);
                    for (const t of tasks) {
                        if (!results[t.key]) results[t.key] = { label: t.src.label, ok: false, error: '逾時' };
                    }
                    resolve();
                }
            }, 800);
            }
        });

        await Promise.all([...fetchPromises, pollPromise]);
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
                const results = await grabSources(['tprbp', 'uo', 'catheter', 'consult', 'diet', 'handover', 'nursing', 'image', 'meds', 'rx', 'lab']);
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
