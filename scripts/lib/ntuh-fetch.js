// ==============================================================
// NTUH 抓取共用層（病房列表頁用）：PersonID、藥歷抗生素、管路、影像報告解析
// --------------------------------------------------------------
// 晨間簡報（morning-briefing）與查房單（rounds-sheet）原本各有一份，抽到這裡共用。
// 都在病房列表（OpenWard.aspx）這個分頁執行：要用它網址上的 SESSION 與病人清單 Cookie。
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-fetch.js
//   之後用全域的 NTUHFetch；node 測試則 require('./ntuh-fetch.js')（解析函式需要 DOMParser）。
//
// 注意：@require 會被 Tampermonkey 快取；改這支後要讓使用者更新外部資源，
//       兩支腳本也要各自 bump @version。
// ==============================================================

/* global module */
(function (root) {
    'use strict';

    // HIS 的 date.js 會覆寫 Date.now（回傳 Date 物件），一律用 new Date().getTime()
    const nowMs = () => new Date().getTime();
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const two = (n) => String(n).padStart(2, '0');
    const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');
    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const dayNo = (startMs, now) => Math.round((dayStart(now) - dayStart(startMs)) / 86400000) + 1;

    // SESSION：病房列表網址上帶著；只放進請求網址與連結，不顯示、不存
    function pageSession() {
        const m = location.search.match(/[?&]session=([^&]+)/i)
            || document.documentElement.innerHTML.match(/SESSION=([a-zA-Z0-9]{34})/i);
        return m ? m[1] : '';
    }

    // ─── 抗生素（MedicationHistory/Default.aspx）────────────────
    // 藥歷頁只需 SESSION＋PersonID；PersonID 從病房病人清單 Cookie 依 AccountIDSE 配對。
    // GET 取得 WebForms 表單，再 POST「抗生素」查詢；以院方分類為準，不再自行比對藥名。
    // 查詢所有病人類別以避免「全選」Changed handler 清掉住院勾選，解析時只保留「住」。
    // 只列已開始、停用日空白或 >= 今天的醫令；停用日只有日期，當天停用仍列入。
    // D1＝目前這張醫令的開始日，改劑量／重開醫令仍會重新起算。
    const medicationHistoryUrl = (personId) => location.origin
        + '/WebApplication/OtherIndependentProj/MedicationHistory/Default.aspx'
        + `?SESSION=${encodeURIComponent(pageSession())}&PersonID=${encodeURIComponent(personId)}`;

    // Cookie 的 PatN 值是舊式 escape 編碼（%uXXXX、%XX），不能直接 decodeURIComponent。
    // 只用中段「院區_類別_PersonID_AccountIDSE」配對，不依 PatN 順序或姓名判斷。
    function personIdFromPatientList(cookieText, accountId) {
        const prefix = 'Page_Session_InPatientPatientListSessionKey=';
        const cookie = cookieText.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        if (!cookie) throw new Error('找不到病房病人清單 Cookie');
        const decode = (value) => value.replace(/%u([0-9a-f]{4})|%([0-9a-f]{2})/gi,
            (_, unicode, byte) => String.fromCharCode(parseInt(unicode || byte, 16)));
        let value = cookie.slice(prefix.length);
        // 容許 Cookie 外層也經過 escape；PatN 值仍各自解碼。
        if (!/^Pat\d+=/.test(value)) value = decode(value);
        let personId = '';
        for (const entry of value.split('&')) {
            const match = entry.match(/^Pat\d+=(.*)$/);
            if (!match) continue;
            const identity = decode(match[1]).split('|')[1]?.split('_');
            if (!identity || identity.length !== 4 || identity[1] !== 'I'
                || !identity[2] || identity[3] !== accountId) continue;
            if (personId && personId !== identity[2]) throw new Error('病房 Cookie 的病人識別不一致');
            personId = identity[2];
        }
        if (!personId) throw new Error('病房 Cookie 找不到此住院帳號的 PersonID');
        return personId;
    }

    // 簡單併發閘門：同時最多 max 個任務（藥歷查詢與管路，避免一次灌爆院內主機）
    function makeGate(max) {
        let active = 0;
        const queue = [];
        return async (task) => {
            if (active >= max) await new Promise((release) => queue.push(release));
            active += 1;
            try { return await task(); } finally { active -= 1; const next = queue.shift(); if (next) next(); }
        };
    }
    const rxGate = makeGate(3);   // 藥歷表單查詢
    // 一律一次一位：管路 handler 靠「最近載入的病人」決定回誰（見 fetchTubes）。
    // 呼叫端其他「帶 AccountIDSE 的病人頁面」請求（晨間簡報的醫囑簽收頁、查房單的病程紀錄頁）也要走這道閘，
    // 不能插進管路的頁面→handler 之間。
    const pageGate = makeGate(1);

    function medicationHistoryQuery(doc, now) {
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
        // 查近 2 天的用藥紀錄（包含期間內持續使用、較早開始的醫令）。
        body.set(days.name, '2');
        for (const el of patientTypes) body.set(el.name, el.value);
        const all = doc.querySelector('[id$="_ckbPatientTypeAll"]');
        if (all) body.set(all.name, all.value);
        body.set(antibiotics.name, antibiotics.value);
        body.set(query.name, query.value);
        return body;
    }

    function parseMedicationHistory(doc, now) {
        const table = doc.querySelector('[id$="_grvData"]');
        if (!table) {
            const message = txt(doc.querySelector('[id$="_lblMessage"]'));
            if (message.includes('日期範圍查無勾選範圍的處方資料')) return [];
            throw new Error('藥歷結果表讀不到');
        }
        const headers = [...table.rows[0].cells].map(txt);
        const start = headers.indexOf('開始日'), stop = headers.indexOf('停用日');
        const nameCol = headers.indexOf('藥名'), content = headers.indexOf('處方內容');
        if ([start, stop, nameCol, content].some((i) => i < 0)) throw new Error('藥歷欄位格式改變');
        const dateMs = (text) => {
            const m = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
            if (!m) throw new Error('藥歷日期格式無法判讀');
            const d = new Date(+m[1], +m[2] - 1, +m[3]);
            if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new Error('藥歷日期無效');
            return d.getTime();
        };
        const today = dayStart(now), out = [];
        for (const tr of [...table.rows].slice(1)) {
            if (txt(tr.cells[0]) !== '住') continue;
            if (tr.cells.length !== headers.length) throw new Error('藥歷資料列格式改變');
            const startMs = dateMs(txt(tr.cells[start]));
            const stopText = txt(tr.cells[stop]);
            if (startMs > today || (stopText && dateMs(stopText) < today)) continue;
            const rawName = txt(tr.cells[nameCol]);
            if (!rawName) throw new Error('藥歷藥名缺漏');
            const prescription = txt(tr.cells[content]);
            const route = (prescription.match(/\b(IV|IF|PO|IM|SC|SQ|TOPIC|INHL)\b/i) || [])[1] || '';
            out.push({ name: rawName.split('(')[0].trim().slice(0, 40), route, prescription, startMs, day: dayNo(startMs, now) });
        }
        return out.sort((a, b) => a.startMs - b.startMs);
    }

    async function fetchAbx(p, now) {
        return rxGate(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 45000);
            try {
                const pid = personIdFromPatientList(document.cookie, p.caseno);
                const url = medicationHistoryUrl(pid);
                const initial = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
                if (!initial.ok) throw new Error('HTTP ' + initial.status);
                let doc = parseHtml(await initial.text());
                // 已保存的「全部藥物」選項若觸發 Changed handler，可能清掉抗生素勾選。
                // 使用回傳的新表單再送一次；仍未套用分類則報錯，不能把其他藥當抗生素。
                for (let attempt = 0; attempt < 2; attempt++) {
                    const body = medicationHistoryQuery(doc, now);
                    const res = await fetch(url, { method: 'POST', body, credentials: 'same-origin', signal: ctrl.signal });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    doc = parseHtml(await res.text());
                    const selected = [...doc.querySelectorAll('input[type="checkbox"]:checked')]
                        .filter((el) => /_ckb/.test(el.id) && !/_ckbPatientTypeAll$/.test(el.id));
                    if (selected.length === 1 && selected[0].id.endsWith('_ckbAntibiotics')) return parseMedicationHistory(doc, now);
                }
                throw new Error('藥歷未套用抗生素分類');
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // ─── 管路（CatheterCare_Handler.aspx）───────────────────────
    // 頁面的資料來自 GET CatheterCare_Handler.aspx?mode=getCatheterRecord&catherStatus=UnRemovedOnly（XML）。
    // 這個請求「不帶任何病人識別」：伺服器靠「最近載入 CatheterCare.aspx 的那位病人」決定回誰，
    // 額外參數一律被忽略（新竹實測 2026-09-30）。所以：
    //   1. 一律一次一位（pageGate=1），先載入該病人的頁面 HTML（不跑頁面 JS，約 0.5 秒）再立刻打 handler（約 0.1 秒）。
    //   2. 每條管路的 <decorate> 都帶 <caseno>（＝病房列表的 AccountIDSE），逐條驗證，對不上就整批丟棄。
    // 已知盲點：這位病人若一條管路都沒有，就沒有 caseno 可驗證；此時若有人在別的分頁操作 CatheterCare，
    // 理論上可能拿到別人的空結果。簡報執行期間不要同時操作 CatheterCare。
    const CATH_PERIPHERAL_RE = /留置針|IV\s*Catheter/i;   // 周邊留置針不列入（CVC／PICC／Port-A 等中央導管要留）
    const tubeText = (node, tag) => { const e = node.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const parseInsert = (t) => {
        const m = t.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
    };

    async function fetchTubes(p, now) {
        return pageGate(async () => {
            const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '').replace(/Ward\/$/, '') + 'Nursing/';
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            try {
                const opt = { credentials: 'same-origin', signal: ctrl.signal };
                const page = await fetch(`${dir}CatheterCare.aspx?session=${encodeURIComponent(pageSession())}&AccountIDSE=${encodeURIComponent(p.caseno)}&PatClass=I`, opt);
                if (!page.ok) throw new Error('管路頁 HTTP ' + page.status);
                await page.text();
                const res = await fetch(`${dir}CatheterCare_Handler.aspx?aa=${nowMs()}&mode=getCatheterRecord&catherStatus=UnRemovedOnly`, opt);
                if (!res.ok) throw new Error('管路資料 HTTP ' + res.status);
                const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
                if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('UnRemovedCatheter').length) throw new Error('管路資料格式不符');
                const decs = [...doc.getElementsByTagName('decorate')];
                const total = parseInt(tubeText(doc.getElementsByTagName('UnRemovedCatheter')[0], 'TotalCount'), 10);
                if (Number.isFinite(total) && total !== decs.length) throw new Error(`管路數量不符（${total}／${decs.length}）`);
                if (decs.some((d) => tubeText(d, 'caseno') !== p.caseno)) throw new Error('管路資料與病人不符，已丟棄');
                return decs.map((d) => {
                    const full = tubeText(d, 'CatheterName');
                    return { full, name: full.replace(/\(.*?\)/g, '').trim() || full, startMs: parseInsert(tubeText(d, 'CatheterInsertDateTime')) };
                }).filter((x) => x.full && !CATH_PERIPHERAL_RE.test(x.full) && Number.isFinite(x.startMs))
                    .map((x) => ({ name: x.name, startMs: x.startMs, day: dayNo(x.startMs, now) }))
                    .sort((a, b) => a.startMs - b.startMs);
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // ─── 醫囑變更（Nursing/WorkList_OrderCheck.aspx，醫囑簽收頁）──────────
    // 網址參數 SESSION、PatClass=I、AccountIDSE、PersonID、Hosp=T0、Seed、EMRPop=Y（使用者提供的樣本，2026-10-14）；
    // Seed 樣本有值、這裡留空（其他頁面留空皆可，此頁未實測）。PersonID 從病房 Cookie 取（只在記憶體內）。
    // 頁面上方有「未簽收／已簽收／全部」三選一（rbl_SignStatus = N／Y／A），預設不是「全部」：
    // 只讀預設畫面會漏掉另一種狀態的醫囑（例如護理師還沒簽收的夜間醫囑）。所以 GET 後若不是「全部」，
    // 就照頁面點選項的方式送一次 postback（__EVENTTARGET = 該選項），切到「全部」（僅含一個月內資料）再解析。
    // 表格 gv_OrderList：每列 <tr title="開立日：MM/DD HH:MM\n簽收日：yyyy/M/d 下午 hh:mm:ss\n紀錄日：…">，
    // 欄位依表頭文字對應（類別、狀態、起日、迄日、醫令名稱…），不寫死欄序：未簽收的列可能多一欄勾選框。

    // ─── 影像報告（OuterData pacs）───────────────────────────────
    // 每列有一格是「日期 標題 (Vn)@@@...@@@報告」。只有日期、沒有時間，所以起點以日為單位。
    // 報告保留換行（擷取 Impression 與 pre-wrap 顯示要用）、不截長度、不排序：由呼叫端決定。
    function parsePacs(html, fromMs) {
        const doc = parseHtml(html);
        const fromDay = dayStart(fromMs);
        const out = [];
        for (const tr of doc.querySelectorAll('tbody tr')) {
            const content = [...tr.querySelectorAll('td')].map((td) => td.textContent).find((t) => t.includes('@@@'));
            if (!content) continue;
            const segs = content.split('@@@').map((x) => x.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim());
            const head = (segs[0] || '').replace(/\s+/g, ' ');
            const dm = head.match(/(\d{4})\/(\d{2})\/(\d{2})/);
            if (!dm) continue;
            const ms = new Date(+dm[1], +dm[2] - 1, +dm[3]).getTime();
            if (ms < fromDay) continue;
            const title = head.replace(/^\d{4}\/\d{2}\/\d{2}\s*/, '').replace(/\s*\(V\d+\)\s*$/, '').trim();
            out.push({ ms, date: `${+dm[2]}/${+dm[3]}`, title, report: segs[2] || segs[1] || '' });
        }
        return out;
    }

    const api = {
        nowMs, dayStart, dayNo, parseHtml,
        pageSession, personIdFromPatientList,
        makeGate, rxGate, pageGate,
        medicationHistoryUrl, medicationHistoryQuery, parseMedicationHistory, fetchAbx,
        CATH_PERIPHERAL_RE, fetchTubes,
        parsePacs,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else if (!root.NTUHFetch) root.NTUHFetch = api;   // 已載入就不覆蓋（閘門要共用同一份）
}(typeof window !== 'undefined' ? window : globalThis));
