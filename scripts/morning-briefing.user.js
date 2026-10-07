// ==UserScript==
// @name         NTUH 晨間簡報
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.6.1
// @description  病房列表一鍵產生「昨夜狀態」簡報（新分頁）：生命徵象圖、給氧／尿量變化、新檢驗報告、新影像報告；依列表順序列出所有病人，一行並排兩人
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2 */

    const START_HOUR = 17; // 昨夜時間窗起點（前一日幾點）
    // 為什麼分兩階段（新竹實測 2026-09-30，11 位病人）：處方頁＋管路單獨測時加起來約 28 秒，剛好等於不論同時數怎麼調
    // 的總時間（2 個、3 個、全部同時開跑都是 28～30 秒）→ 這兩個重頁面在伺服器端幾乎是一個接一個處理，
    // 同時發再多也不會變快，只會讓 vitals／影像這種輕請求排在後面（全部同時開跑時平均等 17～19 秒）。
    // 所以由我們決定順序：先抓完所有病人的輕請求（階段一），再抓重的（階段二，依病人順序小批處理）。
    const HEAVY_POOL = 2;   // 階段二同時處理的病人數
    // OuterData 逾時：請求要在瀏覽器／伺服器排隊，逾時計時包含排隊時間，所以放寬到 30 秒（lib 預設 12 秒）。
    const OUTER_TIMEOUT_MS = 30000;

    // HIS 的 date.js 會覆寫 Date.now，取毫秒一律走這個
    const nowMs = () => new Date().getTime();
    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const two = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

    // ═══════════════════════════════════════════════════════════
    // 病房列表 → 病人清單
    // ═══════════════════════════════════════════════════════════
    // 元素 id 前綴會變（NTUHWeb1／NTUHWeb9…），一律用尾綴選取

    function readPatients() {
        const table = document.querySelector('[id$="DataGridAccountList"]');
        if (!table) return [];
        const out = [];
        for (const tr of [...table.rows].slice(1)) {
            const news = tr.querySelector('[id$="NEWSLabel"]');
            const caseno = news && news.getAttribute('caseno');
            if (!caseno) continue;
            const cells = tr.cells;
            const labTitle = (tr.querySelector('[id$="LinkForthMedicalReport"]') || {}).title || '';
            out.push({
                caseno,                                            // = AccountIdse（已實測）
                chartNo: news.getAttribute('chartno') || txt(tr.querySelector('[id$="PatChartNo"]')),
                ward: news.getAttribute('wardcode') || txt(tr.querySelector('[id$="WardLabel"]')),
                name: txt(tr.querySelector('[id$="LinkPatientName"]')),
                bed: [txt(tr.querySelector('[id$="RoomLabel"]')), txt(tr.querySelector('[id$="BedLabel"]'))].filter(Boolean).join('-'),
                age: txt(tr.querySelector('[id$="PatientAge"]')),
                sex: txt(tr.querySelector('[id$="PatientSex"]')),
                attending: txt(cells[7]),
                resident: txt(cells[8]),
                hospDay: (tr.innerHTML.match(/住院總天數\s*[:：]\s*(\d+)/) || [])[1] || '',
                labTitle,
            });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 時間窗
    // ═══════════════════════════════════════════════════════════
    // 週一自動回溯到週五晚上，涵蓋整個週末

    const REF_HOUR = 8; // 圖表參考資料起點（前一日幾點）

    function briefingWindow(startHour) {
        const n = new Date(nowMs());
        const daysBack = n.getDay() === 1 ? 3 : 1;
        const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack, startHour, 0).getTime();
        // 圖表另外往前多看到前一日 08:00 當參考基準（異常判斷、給氧、抽血、影像仍用昨夜時間窗）
        const ref = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack, REF_HOUR, 0).getTime();
        return { fromMs: from, refFromMs: Math.min(ref, from), toMs: n.getTime(), daysBack };
    }

    // 列表 title「最新檢驗結果時間:HH:MM (N 小時內)」只有時分，往回推到最近的過去時間點
    function labTimeMs(title, now) {
        const m = title.match(/最新檢驗結果時間\s*[:：]\s*(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const d = new Date(now);
        d.setHours(+m[1], +m[2], 0, 0);
        let ms = d.getTime();
        if (ms > now) ms -= 86400000;
        return ms;
    }

    // ═══════════════════════════════════════════════════════════
    // 單一病人：抓資料 + 判讀
    // ═══════════════════════════════════════════════════════════

    // SESSION：病房列表網址上帶著（頁內每個連結都帶）。實測：不帶時點連結會跳到需要登入的頁面，
    // 帶上後可正常開啟（新竹分院）。只確認了這個結果，機制未確認，因此不在此推測原因。
    // 只放進連結的 href，不顯示、不寫入儲存空間。
    function pageSession() {
        const m = location.search.match(/[?&]session=([^&]+)/i)
            || document.documentElement.innerHTML.match(/SESSION=([a-zA-Z0-9]{34})/i);
        return m ? m[1] : '';
    }

    // 檢驗報告頁（與 progress-note-data-helper 的 [Lab] 同一頁）：靠 ChartNo 定位病人，
    // AccountIDSE/PersonID 都不需要；IntervalDay 為負數＝往前推幾天（-13 ≈ 兩週）。
    function labPageUrl(p) {
        const ses = pageSession();
        return location.origin + '/WebApplication/ElectronicMedicalReportViewer/MedicalReportContent.aspx'
            + `?${ses ? 'SESSION=' + encodeURIComponent(ses) + '&' : ''}PatClass=I&WardCode=${encodeURIComponent(p.ward || '')}&ChartNo=${encodeURIComponent(p.chartNo)}`
            + '&HospitalCode=T0&Seed=&IntervalDay=-13';
    }

    function ctxOf(p) {
        // 實測只需 AccountIdse（其餘可留空）；ChartNo 一併帶上
        return { AccountIdse: p.caseno, PersonId: '', ChartNo: p.chartNo, DeptCode: '', EmpDeptCode: '' };
    }

    function vitalTexts(html) {
        const doc = NTUHAsmx.parseHtml(html);
        const spans = [...doc.querySelectorAll('[id$="_Content"]')].map(txt);
        if (spans.length) return spans;
        return [...doc.querySelectorAll('tr')].map(txt);
    }

    function parsePacs(html, fromMs) {
        const doc = NTUHAsmx.parseHtml(html);
        const fromDay = new Date(fromMs); fromDay.setHours(0, 0, 0, 0);
        const out = [];
        for (const tr of doc.querySelectorAll('tbody tr')) {
            const content = [...tr.querySelectorAll('td')].map((td) => td.textContent).find((t) => t.includes('@@@'));
            if (!content) continue;
            const segs = content.split('@@@').map((s) => s.replace(/\s+/g, ' ').trim());
            const head = segs[0] || '';
            const dm = head.match(/(\d{4})\/(\d{2})\/(\d{2})/);
            if (!dm) continue;
            if (new Date(+dm[1], +dm[2] - 1, +dm[3]).getTime() < fromDay.getTime()) continue; // 影像只有日期，以日為單位
            const title = head.replace(/^\d{4}\/\d{2}\/\d{2}\s*/, '').replace(/\s*\(V\d+\)\s*$/, '').trim();
            const report = (segs[2] || segs[1] || '').slice(0, 1500);
            out.push({ date: `${+dm[2]}/${+dm[3]}`, title, report });
        }
        return out;
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
    // 管路一律一次一位（原因見下方 fetchTubes 的註解：handler 靠「最近載入的病人」決定回誰）
    const tubeGate = makeGate(1);

    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const dayNo = (startMs, now) => Math.round((dayStart(now) - dayStart(startMs)) / 86400000) + 1;

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
                let doc = NTUHAsmx.parseHtml(await initial.text());
                // 已保存的「全部藥物」選項若觸發 Changed handler，可能清掉抗生素勾選。
                // 使用回傳的新表單再送一次；仍未套用分類則報錯，不能把其他藥當抗生素。
                for (let attempt = 0; attempt < 2; attempt++) {
                    const body = medicationHistoryQuery(doc, now);
                    const res = await fetch(url, { method: 'POST', body, credentials: 'same-origin', signal: ctrl.signal });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    doc = NTUHAsmx.parseHtml(await res.text());
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

    // ─── 檢驗數值的過濾與分組規則：取自 lab-summary（改動時兩邊要同步）──────────────────
    // 新竹 LU 科室的項目名是中英混寫、空格不一致 → 用通則去中文＋正規化鍵查表，查不到就回傳去中文的原名（不丟資料）。
    const LAB_CJK_RE = /[⺀-⿟　-〿㐀-䶿一-鿿豈-﫿]+/g;
    const stripCJK = (x) => String(x || '').replace(LAB_CJK_RE, ' ').replace(/\s+/g, ' ').trim();
    const nameKey = (x) => stripCJK(String(x || '').replace(/\(.*?\)/g, ' ')).replace(/[\s.\-_]/g, '').toLowerCase();
    const LAB_NAME_MAP = {
        // CBC：HE 科室的短名 + LH 科室的中英混寫
        'HB': 'Hb', 'Hb': 'Hb', 'Hgb 血紅素': 'Hb',
        'PLT': 'Plt', 'Platelet 血小板': 'Plt',
        'WBC': 'WBC', 'W.B.C 白血球': 'WBC',
        'MCV': 'MCV', 'MCV平均血球體積': 'MCV',
        'R.B.C 紅血球': 'RBC', 'Hct 血球比容積': 'HCT',
        'MCH平均血球血紅素': 'MCH', 'MCHC平均血色素比容積': 'MCHC',
        // DC：HE 用縮寫、LH 用全名
        'Seg': 'Seg', 'Neutrophil': 'Seg',
        'Eos.': 'Eos.', 'Eosinophil': 'Eos.',
        'Baso.': 'Baso.', 'Basophil': 'Baso.',
        'Band': 'Band', 'Band neutrophil': 'Band',
        'Lym.': 'Lym.', 'Lymphocyte': 'Lym.',
        'Mono': 'Mono.', 'Mono.': 'Mono.', 'Monocyte': 'Mono.',
        'Promyl.': 'Promyl.', 'Promyelocyte': 'Promyl.',
        'Myelo.': 'Myelo.', 'Myelocyte': 'Myelo.',
        'Meta': 'Meta', 'Metamyelocyte': 'Meta',
        'Aty.Lym.': 'Aty.Lym.', 'Aty.Lymphocyte': 'Aty.Lym.',
        'PlasmaCell': 'PlasmaCell', 'Plasma Cell': 'PlasmaCell',
        'Normobl.': 'Normobl.', 'Normoblast': 'Normobl.',
        // 生化
        'Alb': 'Alb', 'ALB': 'Alb', 'Albumin': 'Alb',
        'T-BIL': 'T-Bil', 'D-BIL': 'D-Bil',
        'AST': 'AST', 'ALT': 'ALT', 'ALP': 'ALP',
        'UN': 'BUN', 'BUN': 'BUN', 'CRE': 'CRE', 'UA': 'UA',
        // LU 科室（新竹）用英文全名，非中文問題，需列舉
        'Creatinine': 'CRE', 'Uric Acid': 'UA', 'RDW-CV': 'RDW', 'RDW': 'RDW',
        'Na': 'Na', 'K': 'K', 'Mg': 'Mg', 'Ca': 'Ca', 'P': 'P', 'Cl': 'Cl',
        'CRP': 'CRP', 'hsCRP': 'CRP',
        'Procalcitonin': 'PCT',
        'LacticAcid': 'LA', 'Lactate': 'LA',
        'pH': 'pH', 'pCO2': 'PCO2', 'pO2': 'PO2',
        'HCO3-': 'HCO3', 'Base Excess': 'BE',
        'HbA1c': 'HbA1c', 'HbA1c糖化血色素': 'HbA1c',
        'GLU AC': 'Glucose', 'Glucose': 'Glucose', 'Sugar': 'Glucose',
        'NT-pro BNP': 'NT-proBNP', 'BNP': 'BNP',
        'PT': 'PT', 'PT INR': 'INR', 'PTT': 'PTT',
        'D-dimer': 'D-dimer', 'Fibrinogen': 'Fibrinogen',
        'aPTT': 'aPTT',
        'Ammonia N': 'NH3', 'Ammonia': 'NH3',
        'CK': 'CK', 'CK-MB': 'CK-MB', 'Troponin-T': 'TnT', 'Troponin-I': 'TnI',
        'TP': 'TP', 'LDH': 'LDH', 'AMY': 'AMY', 'Amylase': 'AMY',
        'Lipase': 'Lip', 'GGT': 'GGT',
        'T-CHO': 'T-CHO', 'TG': 'TG', 'LDL-C': 'LDL-C', 'HDL-C': 'HDL-C',
        // 腫瘤標記
        'Chromogranin A': 'CgA', 'CEA': 'CEA', 'AFP': 'AFP', 'PSA': 'PSA',
        'CA19-9': 'CA19-9', 'CA-125': 'CA-125', 'CA15-3': 'CA15-3',
        // 甲狀腺
        'hsTSH': 'TSH', 'TSH': 'TSH', 'Free T4': 'Free T4', 'T4': 'T4', 'T3': 'T3',
        // 血清學（B/C 肝、HIV、梅毒）
        'HBsAg': 'HBsAg', 'Anti-HBs': 'Anti-HBs', 'Anti-HCV Ab': 'Anti-HCV',
        'Anti-HCV': 'Anti-HCV',
        'HIV Ag/Ab Combo -for screening test': 'HIV', 'HIV Ag/Ab Combo': 'HIV',
        'S.T.S.': 'VDRL',
    };
    const LAB_NAME_BY_KEY = (() => {
        const idx = {};
        for (const [k, v] of Object.entries(LAB_NAME_MAP)) { const kk = nameKey(k); if (kk && !(kk in idx)) idx[kk] = v; }
        return idx;
    })();
    const labDisplayName = (raw) => {
        const clean = String(raw || '').replace(/\(.*?\)/g, '').trim();
        return LAB_NAME_MAP[raw] || LAB_NAME_MAP[clean] || LAB_NAME_BY_KEY[nameKey(raw)] || stripCJK(clean) || clean;
    };
    // 血液檢體不看的項目（只在血液套用：尿液的 RBC／WBC 有意義）
    const LAB_IGNORE = ['HCT', 'Hct', 'MCH', 'MCHC', 'RDW-CV', 'PS', 'RBC', 'Sugar', 'Auer body', 'Others', 'Reference Comment'];
    // 不是檢驗值的列（子字串比對），以及整列名稱剛好等於才濾掉的（'Others' 是 LU 科室 CBC 的末列註記）
    const LAB_SKIP_KEYWORDS = ['檢驗項目', '計算', '採檢', '登入', '最後', '本尿', 'High >', 'Low <', 'Average', '七日',
        'BLOOD', 'Peripheral', 'URINE', 'OTHER', 'Venous', 'Catheter', 'Random', 'RANDOM', 'Special Instructions',
        'RH', 'ABO Typing', 'antibody screen', 'Reference Comment'];
    const LAB_SKIP_EXACT = new Set(['Others']);
    const labShouldSkip = (raw) => {
        const n = String(raw || '').trim();
        return !n || LAB_SKIP_EXACT.has(n) || LAB_SKIP_KEYWORDS.some((kw) => n.indexOf(kw) > -1);
    };
    // 差別計數：正常範圍內就不顯示（只有異常才列）。罕見細胞（RARE_DIFF）有出現就列。
    const LAB_DC_RANGE = { 'Eos.': [0, 8], 'Baso.': [0, 2], 'Band': [0, 5], 'Lym.': [20, 45], 'Mono.': [2, 10] };
    // 臨床分組（順序即顯示順序，也是欄位順序）；Seg 附在 WBC 旁、MCV 附在 Hb 旁、eGFR 附在 CRE 旁
    const LAB_GROUPS = [
        ['Hemogram', ['WBC', 'Seg', 'Hb', 'MCV', 'Plt', 'CRP', 'PCT']],
        ['DC', ['Band', 'Eos.', 'Baso.', 'Lym.', 'Mono.', 'Blast', 'Promyl.', 'Myelo.', 'Meta', 'Aty.Lym.', 'PlasmaCell', 'Normobl.']],
        ['Liver', ['ALT', 'AST', 'ALP', 'T-Bil', 'D-Bil', 'GGT', 'Alb', 'TP', 'NH3']],
        ['Renal', ['BUN', 'CRE', 'eGFR', 'UA']],
        ['Electrolytes', ['Na', 'K', 'Cl', 'Ca', 'P', 'Mg']],
        ['Cardiac', ['CK', 'CK-MB', 'TnT', 'NT-proBNP', 'BNP']],
        ['Coagulation', ['PT', 'INR', 'aPTT', 'PTT', 'D-dimer', 'Fibrinogen']],
        ['Lipid', ['T-CHO', 'TG', 'LDL-C', 'HDL-C']],
        ['Tumor marker', ['CgA', 'CEA', 'CA19-9', 'AFP', 'PSA', 'CA-125', 'CA15-3', 'SCC', 'NSE']],
        ['Thyroid', ['TSH', 'Free T4', 'T4', 'T3']],
        ['Serology', ['HBsAg', 'Anti-HBs', 'Anti-HCV', 'HIV', 'VDRL']],
        ['Others', ['Glucose', 'HbA1c', 'LDH', 'AMY', 'Lip', 'VIT. B12', 'Folic Acid', 'LA']],
    ];
    const LAB_GROUP_OF = Object.fromEntries(LAB_GROUPS.flatMap(([g, names]) => names.map((n) => [n, g])));
    // OuterData 沒有檢體欄，只有 HIS 類別：類別看起來是血液才套用 IGNORE；看起來是尿液／體液／氣體／培養的，
    // 不歸進血液臨床分組（同名的 RBC／WBC／Glucose 在那些檢體意義不同）。類別不明就不丟、也照名稱分組。
    const LAB_BLOOD_CAT_RE = /CBC|hemato|biochem|chem|coag|immun|serolog|tumor|thyroid|endocr/i;
    const LAB_NONBLOOD_CAT_RE = /urin|csf|cerebro|stool|fecal|fluid|gas|culture|smear|cytolog|pathol/i;

    // ─── 檢驗數值（OuterData lab，點開下拉才為該病人載入）────────────────────────────
    // 需要 PersonId（從病房 Cookie 取，只在記憶體內用、不顯示、不存）。回傳一張 tblLabList，每列＝一個檢驗結果；
    // 畫面上只有 4 個可見欄（日期 MMDD、類別、項目、科室），數值在後面 5 個隱藏欄：
    // [4] 完整日期 yyyy/MM/dd　[5] 類別　[6] 數值　[7] 項目　[8] 單位（新竹實測 2026-10-05，lab-shape-probe）。
    // 日期只到「日」（沒有時分），所以起點以日為單位；資料沒有異常標記也沒有參考範圍 → 只顯示值，不自己判斷高低。
    // 同一筆可能重複出現（例如血液培養），以（日期、類別、項目、數值、單位）去重。
    function parseLabList(html, sinceMs) {
        const doc = NTUHAsmx.parseHtml(html);
        const table = doc.querySelector('[id$="tblLabList"]');
        if (!table) {
            // 這陣子沒有報告的病人，伺服器回傳的 HTML 不含檢驗表（使用者在 HIS 逐一確認過），視為「沒有資料」而不是錯誤。
            // 風險：若院方改版導致表格不見，每位病人都會顯示「沒有報告」——訊息裡提示，並在 Console 留紀錄。
            console.warn('[晨間簡報] OuterData lab 沒有 tblLabList，視為近期沒有檢驗報告（HTML 長度 ' + html.length + '）');
            return { items: [], skipped: 0, noTable: true, minMs: Infinity, maxMs: -Infinity, since: dayStart(sinceMs) };
        }
        const headers = [...table.rows[0].cells].map(txt);
        if (!['日期', '項目'].every((h) => headers.includes(h))) throw new Error('檢驗欄位格式改變');
        const since = dayStart(sinceMs);
        const seen = new Set(), items = [];
        let skipped = 0, hidden = 0, minMs = Infinity, maxMs = -Infinity;
        for (const tr of [...table.rows].slice(1)) {
            const c = tr.cells;
            const m = c.length >= 9 && txt(c[4]).match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
            if (!m) { skipped += 1; continue; }   // 不能靜默丟掉：回報有幾列沒顯示
            const dateMs = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
            minMs = Math.min(minMs, dateMs); maxMs = Math.max(maxMs, dateMs);
            const unit = txt(c[8]);
            const rawItem = txt(c[7]) || txt(c[2]);
            const category = txt(c[5]);
            const item = labDisplayName(rawItem);
            // lab-summary 的略過規則：非檢驗值的列、血液不看的項目；略過的筆數會在頁尾回報（不靜默）
            // IGNORE 要「原始名稱」與「正規化後名稱」都檢查（與 lab-summary 一致）：RDW-CV 會被正規化成 RDW、Sugar 會被正規化成 Glucose，
            // 只查正規化後的名稱會漏掉。
            const cleanRaw = rawItem.replace(/\(.*?\)/g, '').trim();
            const ignored = LAB_BLOOD_CAT_RE.test(category) && (LAB_IGNORE.includes(cleanRaw) || LAB_IGNORE.includes(item));
            if (labShouldSkip(rawItem) || ignored) { if (dateMs >= since) hidden += 1; continue; }
            const row = { dateMs, category, value: txt(c[6]), item, unit: unit === '*' ? '' : unit };
            const key = [dateMs, row.category, row.item, row.value, row.unit].join('|');
            if (seen.has(key)) continue;
            seen.add(key);
            if (dateMs >= since) items.push(row);
        }
        return { items, skipped, hidden, minMs, maxMs, since };
    }

    async function fetchLab(p, win) {
        const pid = personIdFromPatientList(document.cookie, p.caseno);
        const html = await NTUHAsmx.outerData('lab', { context: { ...ctxOf(p), PersonId: pid }, timeoutMs: OUTER_TIMEOUT_MS });
        if (!html) return { items: [], skipped: 0, hidden: 0, empty: true };
        return parseLabList(html, win.refFromMs);
    }

    // ─── 管路（CatheterCare_Handler.aspx）───────────────────────
    // 頁面的資料來自 GET CatheterCare_Handler.aspx?mode=getCatheterRecord&catherStatus=UnRemovedOnly（XML）。
    // 這個請求「不帶任何病人識別」：伺服器靠「最近載入 CatheterCare.aspx 的那位病人」決定回誰，
    // 額外參數一律被忽略（新竹實測 2026-09-30）。所以：
    //   1. 一律一次一位（tubeGate=1），先載入該病人的頁面 HTML（不跑頁面 JS，約 0.5 秒）再立刻打 handler（約 0.1 秒）。
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
        return tubeGate(async () => {
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

    // 每位病人的結果容器。pending＝還沒回來的來源；頁面會依 pending 顯示「抓取中…」
    function newResult(p, win, now) {
        const res = { p, errors: [], vitals: null, pacs: [], lab: null, abx: null, tubes: null, pending: new Set(['vitals', 'pacs', 'abx', 'tubes']) };
        const labMs = labTimeMs(p.labTitle, now);
        // 檢驗、影像的納入起點與圖表／TPR 一致：前一日 REF_HOUR（08:00）起，避免漏掉白天的新報告
        if (labMs !== null && labMs >= win.refFromMs) res.lab = { ms: labMs };
        return res;
    }

    // 來源回來（不論成功或失敗）就通知 onUpdate(src, res)，由呼叫端更新畫面；失敗只記在 res.errors，不丟出
    function jobRunner(res, onUpdate) {
        return async (src, label, work) => {
            try { await work(); } catch (e) { res.errors.push(`${label}抓取失敗：` + (e && e.message || e)); } finally {
                res.pending.delete(src);
                try { onUpdate(src, res); } catch (e) { console.warn('[晨間簡報] 更新畫面失敗', src, e); }
            }
        };
    }

    // 階段一（輕）：vitals、影像。單獨測各約 0.1～2 秒
    async function assessLight(res, win, onUpdate) {
        const p = res.p;
        const ctx = ctxOf(p);
        const job = jobRunner(res, onUpdate);
        await Promise.all([
            job('vitals', 'vitals ', async () => {
                const html = await NTUHAsmx.outerData('vitalsign', { context: ctx, timeoutMs: OUTER_TIMEOUT_MS });
                const texts = vitalTexts(html);
                const obs = NTUHNews2.parseVitalRows(texts);
                res.vitals = NTUHNews2.summarizeWindow(obs, win.fromMs, win.toMs);
                res.vitals.total = obs.length;
                res.chartSeries = obs.filter((o) => o.ms >= win.refFromMs && o.ms <= win.toMs);
                res.uo = NTUHNews2.parseUo(texts);
                res.o2 = NTUHNews2.o2Change(res.vitals.series);
            }),
            job('pacs', '影像', async () => {
                res.pacs = parsePacs(await NTUHAsmx.outerData('pacs', { context: ctx, timeoutMs: OUTER_TIMEOUT_MS }), win.refFromMs);
            }),
        ]);
    }

    // 階段二（重）：抗生素（藥歷 GET/POST）、管路（頁面＋handler，必須一次一位）
    async function assessHeavy(res, now, onUpdate) {
        const p = res.p;
        const job = jobRunner(res, onUpdate);
        await Promise.all([
            job('abx', '抗生素', async () => { res.abx = await fetchAbx(p, now); }),
            job('tubes', '管路', async () => { res.tubes = await fetchTubes(p, now); }),
        ]);
    }

    // ═══════════════════════════════════════════════════════════
    // 輸出：獨立新分頁
    // ═══════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // 共用：時間刻度與數據表
    // ═══════════════════════════════════════════════════════════

    function timeTicks(fromMs, toMs) {
        const H = 3600000, span = toMs - fromMs;
        const stepH = span <= 30 * H ? 6 : span <= 72 * H ? 12 : 24;
        const d = new Date(fromMs);
        d.setMinutes(0, 0, 0);
        const out = [];
        for (let t = d.getTime(); t <= toMs; t += H) {
            if (t < fromMs) continue;
            const dt = new Date(t);
            if (dt.getHours() % stepH !== 0) continue;
            out.push({ ms: t, label: dt.getHours() === 0 ? `${dt.getMonth() + 1}/${dt.getDate()}` : `${two(dt.getHours())}:00` });
        }
        return out;
    }

    function dataTable(series) {
        const c = (v) => (Number.isFinite(v) ? v : '—');
        return `<details class="tv"><summary>數據表（${series.length} 組）</summary><table><thead><tr><th>時間</th><th>T</th><th>HR</th><th>RR</th><th>SBP</th><th>SpO₂</th></tr></thead><tbody>${
            series.map((o) => `<tr><td>${esc(fmt(o.ms))}</td><td>${c(o.T)}</td><td>${c(o.P)}</td><td>${c(o.R)}</td><td>${c(o.SBP)}</td><td>${Number.isFinite(o.SpO2) ? o.SpO2 + '%' + (o.onOxygen ? ' 給氧' : '') : '—'}</td></tr>`).join('')
        }</tbody></table></details>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 院內樣式生命徵象圖（照院內的座標與配色重現）
    // ═══════════════════════════════════════════════════════════
    // 來源：院內 SVGDrawer 產生的生命徵象圖。幾何與規則照抄：
    //   繪圖區 x 140–975、y 25–235（五等分，每格 42）；四條軸由左至右 BP/R/P/T，各自同色；
    //   正常帶 = 中間 2/5（T 36–38、P 60–100、R 10–22、BP 50–150），其餘為異常區；
    //   NA（未量測）不連線；四項預設全部顯示（院內預設隱藏 BP，這裡改為顯示），點軸可切換。
    // 配色取自院內圖：異常 #ffd4d3、正常 #d3e7d0。

    const HV = { X0: 140, X1: 975, Y0: 25, Y1: 235, W: 990, H: 262 };
    const HV_AXES = [
        { k: 'BP', x: 32, color: 'green', lo: 0, hi: 250, step: 50 },
        { k: 'R', x: 68, color: 'black', lo: 4, hi: 34, step: 6, naY: 205 },
        { k: 'P', x: 104, color: 'red', lo: 40, hi: 140, step: 20, naY: 185 },
        { k: 'T', x: 140, color: 'blue', lo: 35, hi: 40, step: 1, naY: 225 },
    ];
    const hm = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

    const TIP_G = '<g class="tt" display="none" pointer-events="none"><rect fill="yellow" stroke="black" rx="2" ry="2"/><text x="5" y="18"><tspan class="t1" x="5" font-family="Arial" font-weight="bold" font-size="15"> </tspan><tspan class="t2" x="5" dy="1.2em" font-weight="bold" font-size="17" fill="blue"> </tspan></text></g>';

    function hospVitals(series, win) {
        const span = win.toMs - win.fromMs;
        const X = (ms) => +(HV.X0 + ((ms - win.fromMs) / span) * (HV.X1 - HV.X0)).toFixed(2);
        const Y = (a, v) => {
            const c = Math.min(a.hi, Math.max(a.lo, v));
            return +(HV.Y1 - ((c - a.lo) / (a.hi - a.lo)) * (HV.Y1 - HV.Y0)).toFixed(2);
        };
        const st = (a) => `fill:${a.color};stroke:${a.color}`;
        let s = `<svg class="hsvg" viewBox="0 0 ${HV.W} ${HV.H}" width="${HV.W}" height="${HV.H}" role="img" aria-label="生命徵象圖">`;
        s += `<rect width="${HV.W}" height="${HV.H}" fill="#fffffd"/>`;
        // 背景色帶：上方異常 / 正常 / 下方異常
        s += `<polygon points="${HV.X0},25 ${HV.X1},25 ${HV.X1},109 ${HV.X0},109" fill="#ffd4d3"/>`
            + `<polygon points="${HV.X0},109 ${HV.X1},109 ${HV.X1},193 ${HV.X0},193" fill="#d3e7d0"/>`
            + `<polygon points="${HV.X0},193 ${HV.X1},193 ${HV.X1},235 ${HV.X0},235" fill="#ffd4d3"/>`;
        s += `<line x1="${HV.X0}" x2="${HV.X1}" y1="109" y2="109" stroke="#000" stroke-opacity=".2" stroke-width="1"/><line x1="${HV.X0}" x2="${HV.X1}" y1="193" y2="193" stroke="#000" stroke-opacity=".2" stroke-width="1"/>`;
        // 日期：起點日 + 每個午夜（院內作法：日期標在上方，午夜畫深色垂直線）
        const lbl = (ms, x) => { const d = new Date(ms); return `<text x="${x}" y="15" style="fill:#000;stroke:#000;stroke-width:.6;font-size:13px">${d.getMonth() + 1}/${d.getDate()}</text>`; };
        s += lbl(win.fromMs, HV.X0);
        const d0 = new Date(win.fromMs); d0.setHours(24, 0, 0, 0);
        for (let m = d0.getTime(); m < win.toMs; m += 86400000) {
            const x = X(m);
            s += `<line x1="${x}" x2="${x}" y1="240" y2="25" stroke="#000" stroke-opacity=".2" stroke-width="1.5"/>${lbl(m, x)}`;
        }
        s += `<line x1="${HV.X1}" x2="${HV.X1}" y1="240" y2="25" stroke="#000" stroke-opacity=".2" stroke-width="1.5"/>`;
        // 下方每 6 小時一個小時間刻度（院內圖沒有，短時間窗需要）
        for (const t of timeTicks(win.fromMs, win.toMs)) {
            if (!/:00$/.test(t.label)) continue;
            s += `<text x="${X(t.ms)}" y="256" text-anchor="middle" style="fill:#898781;font-size:10px">${esc(t.label)}</text>`;
        }
        // 軸（可點擊切換該項顯示）
        for (const a of HV_AXES) {
            s += `<g class="ax${a.off ? ' off' : ''}" data-s="${a.k}" style="${st(a)}"><text x="${a.x - 30}" y="11">${a.k}</text><line x1="${a.x}" y1="235" x2="${a.x}" y2="25"/>`;
            for (let v = a.lo; v <= a.hi + 1e-9; v += a.step) {
                const y = Y(a, v);
                s += `<text x="${a.x - 30}" y="${y}">${v}</text><line x1="${a.x - 5}" y1="${y}" x2="${a.x}" y2="${y}"/>`;
            }
            s += '</g>';
        }
        // 資料：T/P/R 各自的點與線（NA 斷線）；BP 為收縮/舒張壓的誤差線
        for (const a of HV_AXES) {
            s += `<g class="ser${a.off ? ' off' : ''}" data-s="${a.k}" style="${st(a)}">`;
            if (a.k === 'BP') {
                for (const o of series) {
                    if (!Number.isFinite(o.SBP) || !Number.isFinite(o.DBP)) continue;
                    const x = X(o.ms), y1 = Y(a, o.SBP), y2 = Y(a, o.DBP);
                    s += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><line x1="${x - 5}" y1="${y1}" x2="${x + 5}" y2="${y1}"/><line x1="${x - 5}" y1="${y2}" x2="${x + 5}" y2="${y2}"/>`
                        + `<line class="hitl" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" data-t="${esc(hm(o.ms))}" data-v="${o.SBP}/${o.DBP}"/>`;
                }
            } else {
                let prev = null;
                for (const o of series) {
                    const v = o[a.k], x = X(o.ms);
                    if (Number.isFinite(v)) {
                        const y = Y(a, v);
                        if (prev) s += `<line x1="${prev.x}" y1="${prev.y}" x2="${x}" y2="${y}"/>`;
                        s += `<circle cx="${x}" cy="${y}" r="3"/><circle class="hit" cx="${x}" cy="${y}" r="9" data-t="${esc(hm(o.ms))}" data-v="${v}"/>`;
                        prev = { x, y };
                    } else if (o['na' + a.k]) {
                        s += `<text class="na" x="${x}" y="${a.naY}" data-t="${esc(hm(o.ms))}" data-v="未量測">NA</text>`;
                        prev = null; // 院內圖：未量測處斷線
                    }
                }
            }
            s += '</g>';
        }
        s += TIP_G + '</svg>';
        return s;
    }

    // ─── SpO2 一行（放在生命徵象圖與數據表之間，時間軸與上方圖完全對齊）──────────────
    // 每次量測一個數字，顏色依 SpO2 高低（≥96／94–95／92–93／≤91；這是常用切點，不是 NEWS 計分）；
    // 給氧期間整段加藍底，開頭標裝置與流量（流量有變就標 2→3L）；未量測的時間留空。滑過數字顯示時間與給氧。
    function spo2Row(series, win) {
        const pts = series.filter((o) => Number.isFinite(o.SpO2));
        if (!pts.length) return '';
        const span = win.toMs - win.fromMs;
        const X = (ms) => +(HV.X0 + ((ms - win.fromMs) / span) * (HV.X1 - HV.X0)).toFixed(2);
        const W = HV.W, H = 46, Y0 = 3, Y1 = 29;
        const color = (v) => (v >= 96 ? '#27500A' : v >= 94 ? '#854F0B' : v >= 92 ? '#b4531a' : '#a32d2d');
        const o2Text = (o) => { const x = NTUHNews2.oxygenInfo(o.inside); return [x.device, x.flow !== null ? x.flow + 'L' : ''].filter(Boolean).join(' ') || '給氧'; };
        const half = 40; // 給氧底色往前後延伸的上限（px），避免跨過很長的未量測空檔
        let s = `<svg class="hsvg sp" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="SpO2">`;
        s += `<rect width="${W}" height="${H}" fill="#fffffd"/>`
            + `<text x="4" y="21" style="fill:#444;font-size:13px">SpO₂ %</text>`
            + `<rect x="${HV.X0}" y="${Y0}" width="${HV.X1 - HV.X0}" height="${Y1 - Y0}" rx="3" fill="#fffffd" stroke="#c3c2b7" stroke-width="1"/>`;
        // 給氧期間：連續的「給氧中」量測合成一段，底色從第一點往前半格到最後一點往後半格
        for (let i = 0; i < pts.length; i++) {
            if (!pts[i].onOxygen) continue;
            let j = i;
            while (j + 1 < pts.length && pts[j + 1].onOxygen) j++;
            const left = Math.max(HV.X0, i > 0 ? Math.max((X(pts[i - 1].ms) + X(pts[i].ms)) / 2, X(pts[i].ms) - half) : X(pts[i].ms) - half);
            const right = Math.min(HV.X1, j + 1 < pts.length ? Math.min((X(pts[j].ms) + X(pts[j + 1].ms)) / 2, X(pts[j].ms) + half) : X(pts[j].ms) + half);
            s += `<rect x="${left.toFixed(1)}" y="${Y0}" width="${Math.max(2, right - left).toFixed(1)}" height="${Y1 - Y0}" fill="#b5d4f4" opacity=".65"/>`;
            const f0 = NTUHNews2.oxygenInfo(pts[i].inside), f1 = NTUHNews2.oxygenInfo(pts[j].inside);
            const label = (f0.flow !== null && f1.flow !== null && f0.flow !== f1.flow)
                ? `${f0.device || '給氧'} ${f0.flow}→${f1.flow}L` : o2Text(pts[i]);
            s += `<text x="${(left + 3).toFixed(1)}" y="${H - 6}" style="fill:#185FA5;font-size:12px">${esc(label)}</text>`;
            i = j;
        }
        // 數字：與前一個太近（< 26px）就只畫小圓點，避免重疊；每個點都有可滑過的感應區
        let lastX = -1e9;
        for (const o of pts) {
            const x = X(o.ms), c = color(o.SpO2), bold = o.SpO2 <= 93 ? 700 : 500;
            if (x - lastX >= 26) { s += `<text x="${x}" y="21" text-anchor="middle" style="fill:${c};font-size:14px;font-weight:${bold}">${o.SpO2}</text>`; lastX = x; }
            else s += `<circle cx="${x}" cy="${(Y0 + Y1) / 2}" r="2.5" fill="${c}"/>`;
            s += `<circle class="hit" cx="${x}" cy="${(Y0 + Y1) / 2}" r="10" data-t="${esc(hm(o.ms))}" data-v="${o.SpO2}%${o.onOxygen ? '（' + esc(o2Text(o)) + '）' : '（室內空氣）'}"/>`;
        }
        return s + TIP_G + '</svg>';
    }

    function chartsHtml(r, win) {
        const series = r.chartSeries;
        if (!series || !series.length) return '';
        // 圖固定顯示（不收合）；標題「生命徵象 ↗」在卡片骨架（cardShell）裡，數據表仍可展開
        const axis = { fromMs: win.refFromMs, toMs: win.toMs };
        return `<div class="charts">${hospVitals(series, axis)}
${spo2Row(series, axis)}
${dataTable(series)}</div>`;
    }

    // 頁面內互動（序列化後放進新分頁執行，不可引用外部變數）。
    // 卡片內容是「邊抓邊塞」進頁面的，所以一律用事件委派，不在載入時逐一綁定。
    function pageScript() {
        let tipSvg = null;
        const hideTip = () => {
            if (!tipSvg) return;
            const tt = tipSvg.querySelector('.tt');
            if (tt) tt.setAttribute('display', 'none');
            tipSvg = null;
        };
        document.addEventListener('click', (ev) => {
            const a = ev.target.closest && ev.target.closest('.ax');
            const svg = a && a.closest('svg.hsvg');
            if (!svg) return;
            const off = a.classList.toggle('off');
            const g = svg.querySelector('.ser[data-s="' + a.getAttribute('data-s') + '"]');
            if (g) g.classList.toggle('off', off);
        });
        document.addEventListener('pointermove', (ev) => {
            const h = ev.target.closest && ev.target.closest('.hit,.hitl');
            const svg = h && h.closest('svg.hsvg');
            if (!svg) { hideTip(); return; }
            if (tipSvg && tipSvg !== svg) hideTip();
            tipSvg = svg;
            const tt = svg.querySelector('.tt'), box = tt.querySelector('rect'), text = tt.querySelector('text');
            const t1 = tt.querySelector('.t1'), t2 = tt.querySelector('.t2'), vb = svg.viewBox.baseVal;
            t1.textContent = h.getAttribute('data-t');
            t2.textContent = h.getAttribute('data-v');
            const pt = svg.createSVGPoint();
            pt.x = ev.clientX; pt.y = ev.clientY;
            const p = pt.matrixTransform(svg.getScreenCTM().inverse());
            tt.setAttribute('display', 'inline');
            const bb = text.getBBox();
            const w = bb.x + bb.width + 6, hh = bb.y + bb.height + 6;
            box.setAttribute('width', w); box.setAttribute('height', hh);
            let x = p.x + 10, y = p.y + 10;
            if (x + w > vb.width) x = vb.width - w;
            if (y + hh > vb.height) y = p.y - hh - 6;
            tt.setAttribute('transform', 'translate(' + x + ',' + y + ')');
        });
    }

    // ─── 卡片各區塊（每個區塊有自己的 id，抓完一個來源就只更新那一格）──────────
    const PENDING_HTML = '<span class="muted">抓取中…</span>';
    const dayTag = (x, cls) => `<span class="tag${cls}"${x.prescription ? ` title="${esc(x.prescription)}"` : ''}>${esc(x.name)}${x.route ? ' ' + esc(x.route) : ''} D${x.day}<small class="muted"> ${new Date(x.startMs).getMonth() + 1}/${new Date(x.startMs).getDate()} 起</small></span>`;

    function renderVit(r, win) {
        if (r.pending.has('vitals')) return '';
        const o2Cls = r.o2 && (r.o2.kind === 'new' || r.o2.kind === 'up') ? ' warn' : '';
        const o2 = r.o2 ? `<div><span class="tag${o2Cls}">${esc(r.o2.text)}${r.o2.ms ? '（' + esc(fmt(r.o2.ms)) + '）' : ''}</span></div>` : '';
        const uo = r.uo ? `<div class="muted nov">尿量 ${r.uo.val} mL${r.uo.ms ? '（' + esc(fmt(r.uo.ms)) + '）' : '（院內未標日期）'}</div>` : '';
        const noVitals = r.vitals && r.vitals.noData
            ? `<div class="muted nov">${r.chartSeries && r.chartSeries.length ? '昨夜（' + esc(fmt(win.fromMs)) + ' 起）沒有 vitals 量測，圖上為前一日的參考資料' : '時間窗內沒有 vitals 量測（沒量不等於正常）'}</div>` : '';
        return o2 + uo + noVitals;
    }
    const renderErr = (r) => (r.errors.length ? `<div class="err">⚠ ${esc(r.errors.join('；'))}（此病人結果不完整，請手動確認）</div>` : '');
    const renderAbx = (r) => (r.pending.has('abx') ? PENDING_HTML : r.abx ? (r.abx.length ? r.abx.map((x) => dayTag(x, ' new')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    const renderTubes = (r) => (r.pending.has('tubes') ? PENDING_HTML : r.tubes ? (r.tubes.length ? r.tubes.map((x) => dayTag(x, '')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    // 新報告提示：只當提示（檢驗標題本身已是連結），藍底沿用「新」的樣式。資料來自病房列表「報」連結的 tooltip，
    // 是載入列表當下的快照（列表之後才出的報告看不到）。
    const labHint = (r) => (r.lab ? ` <span class="tag new" title="病房列表顯示的最新檢驗時間（載入列表當下的快照）">新報告 ${esc(fmt(r.lab.ms))}</span>` : '');
    function renderPacs(r) {
        if (r.pending.has('pacs')) return PENDING_HTML;
        if (!r.pacs.length) return '<span class="muted">—</span>';
        return r.pacs.map((x) => {
            const tag = `<span class="tag new">${esc(x.date)} ${esc(x.title)}</span>`;
            return x.report ? `<details class="pc"><summary>${tag}</summary><div class="rep">${esc(x.report)}</div></details>` : `<div>${tag}</div>`;
        }).join('');
    }
    // 每張卡的快速連結（新分頁）。只用「SESSION＋AccountIDSE（或 ChartNo）」就能開的頁面（依 progress-note-data-helper
    // 現有網址）；SESSION 只放在 href，不顯示、不存。藥歷圖／影像列表需要 PersonID，不在這裡組（影像在點擊時才組）。
    // 管路頁（CatheterCare）的「目前病人」是伺服器端狀態：同時開兩位病人的頁面再回去操作，可能看到（甚至寫入）別人的資料。
    // 所以管路連結：① 固定開在同一個具名分頁（target=ntuh-catheter，同一時間只會有一個管路分頁）；
    // ② 簡報還在載入時點它會先擋下（我們串行讀管路，插進一個頁面載入會互相干擾）。
    function pageUrls(p) {
        const ses = encodeURIComponent(pageSession());
        const acct = encodeURIComponent(p.caseno);
        const base = location.origin + '/WebApplication/InPatient/';
        return {
            lab: labPageUrl(p),
            vitals: `${base}Nursing/VitalSign_TPR.aspx?session=${ses}&AccountIDSE=${acct}`,
            nursing: `${base}Nursing/NursingProgressNote.aspx?SESSION=${ses}&AccountIDSE=${acct}`,
            handover: `${base}Ward/OffDutyNurV2.aspx?SESSION=${ses}&InQuerySortMode=QByEmp&AccountIDSE=${acct}&Type=Nur`,
            rx: `${base}Ward/MedicationV2.aspx?SESSION=${ses}&PatClass=I&AccountIDSE=${acct}&Hosp=T0&Seed=&EMRPop=Y`,
            cath: `${base}Nursing/CatheterCare.aspx?session=${ses}&AccountIDSE=${acct}&PatClass=I`,
        };
    }
    // 標題列只放護理紀錄、交班；檢驗、生命徵象圖、處方的連結分別放在各自區塊的標題裡（見 cardShell）
    function renderLinks(r) {
        const u = pageUrls(r.p);
        return [['護理紀錄', u.nursing], ['交班', u.handover]]
            .map(([t, url]) => `<a class="tag" href="${esc(url)}" target="_blank" rel="noopener">${t} ↗</a>`).join('');
    }
    // 影像標題連結：點擊時從病房 Cookie 取得 PersonID，再開影像列表。
    function openPacsList(w, p) {
        try {
            const pid = personIdFromPatientList(document.cookie, p.caseno);
            // 帶 SESSION：不帶時新分頁會被要求登入（與檢驗頁同樣的現象；實測帶上後正常，機制未確認）。
            // SESSION 只放在 href，不顯示、不存。
            const ses = pageSession();
            const url = location.origin + '/WebApplication/ElectronicMedicalReportViewer/PACSImageShowList.aspx'
                + `?${ses ? 'SESSION=' + encodeURIComponent(ses) + '&' : ''}PersonID=${encodeURIComponent(pid)}&Seed=`;
            const tab = w.open(url, '_blank');
            if (!tab) alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。');
        } catch (e) {
            alert('無法開啟影像列表：' + e.message + '。請改從病人頁面進入。');
        }
    }

    // 檢驗數值下拉的內容（呈現比照 lab-summary 的「表格」）：依類別分組；日期為列（舊→新）、項目為欄，
    // 等寬對齊、缺值填「-」；一張表最多 8 欄，超過就再開一段（只列該段真的有值的日期）。
    // 數值很長（例如培養結果）不放進表格，獨立列在「文字結果」。單位放在欄名的 tooltip。
    const LAB_MAX_COLS = 8;
    // 一組項目 → 表格區塊（日期為列、項目為欄）。order：欄位順序；單位放欄名 tooltip
    function labTableHtml(list, order, md) {
        const cols = order.filter((n) => list.some((it) => it.item === n));
        const unit = {};
        for (const it of list) if (it.unit && !unit[it.item]) unit[it.item] = it.unit;
        const dates = [...new Set(list.map((it) => it.dateMs))].sort((x, y) => x - y);
        const cell = new Map();   // `${dateMs}|${item}` → 值（同一天同一項目有多筆就用 / 串起來）
        for (const it of list) { const k = `${it.dateMs}|${it.item}`; cell.set(k, cell.has(k) ? `${cell.get(k)} / ${it.value}` : it.value); }
        const blocks = [];
        for (let st = 0; st < cols.length; st += LAB_MAX_COLS) {
            const cs = cols.slice(st, st + LAB_MAX_COLS);
            const rows = dates.filter((ms) => cs.some((c) => cell.has(`${ms}|${c}`)));
            if (!rows.length) continue;
            blocks.push(`<table class="lt"><thead><tr><th></th>${cs.map((c) => `<th title="${esc(unit[c] || '')}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
                rows.map((ms) => `<tr><th>${md(ms)}</th>${cs.map((c) => `<td>${esc(cell.get(`${ms}|${c}`) || '-')}</td>`).join('')}</tr>`).join('')
            }</tbody></table>`);
        }
        return blocks.join('');
    }

    // 檢驗數值下拉的內容（呈現與過濾比照 lab-summary 的「表格」）：
    // 血液項目依臨床分組（Hemogram／DC／Liver／Renal／Electrolytes…，欄位順序固定、Seg／MCV／eGFR 附在主項目旁）；
    // 分不進去的（類別看起來是尿液／體液／氣體，或名稱不在表內）維持依 HIS 類別各一張表；DC 差別計數只有異常才列。
    // 數值很長（例如培養結果）不放進表格，獨立列在「文字結果」。
    function renderLabBody(d, win) {
        const md = (ms) => { const x = new Date(ms); return `${x.getMonth() + 1}/${x.getDate()}`; };
        if (d.empty) return '<span class="muted">伺服器沒有回傳檢驗資料。</span>';
        if (d.noTable) return '<span class="muted">近期沒有檢驗報告。<small>（頁面沒有檢驗表；若每位病人都是這樣，可能是院方改版）</small></span>';
        const warn = d.skipped ? `<div class="err">⚠ 有 ${d.skipped} 列格式不符、沒有顯示（請手動確認）</div>` : '';
        const range = Number.isFinite(d.minMs) ? `資料窗口 ${md(d.minMs)}–${md(d.maxMs)}` : '';
        if (!d.items.length) return `${warn}<span class="muted">${md(win.refFromMs)} 起沒有檢驗數值。${d.hidden ? `（另有 ${d.hidden} 筆依 lab-summary 規則略過）` : ''}${range}</span>`;
        const LONG = 28;
        const texts = d.items.filter((it) => it.value.length > LONG);
        const nums = d.items.filter((it) => it.value.length <= LONG);
        const catOf = (it) => (!it.category || it.category === 'Yes' ? '其他' : it.category);   // HIS 偶爾把類別填成 "Yes"，沒有意義
        const groups = new Map(), rest = new Map();
        for (const it of nums) {
            const g = LAB_NONBLOOD_CAT_RE.test(it.category) ? null : LAB_GROUP_OF[it.item];
            const bucket = g ? groups : rest, key = g || catOf(it);
            if (!bucket.has(key)) bucket.set(key, []);
            bucket.get(key).push(it);
        }
        // DC：正常範圍內不列（有任何一個值超出範圍才列整個項目）；罕見細胞沒有範圍，有就列
        let dcHidden = 0;
        if (groups.has('DC')) {
            const byItem = new Map();
            for (const it of groups.get('DC')) { if (!byItem.has(it.item)) byItem.set(it.item, []); byItem.get(it.item).push(it); }
            const keep = [];
            for (const [name, list] of byItem) {
                const r = LAB_DC_RANGE[name];
                const abnormal = !r || list.some((it) => { const v = parseFloat(it.value); return Number.isNaN(v) || v < r[0] || v > r[1]; });
                if (abnormal) keep.push(...list); else dcHidden += list.length;
            }
            if (keep.length) groups.set('DC', keep); else groups.delete('DC');
        }
        const blocks = [];
        for (const [g, names] of LAB_GROUPS) if (groups.has(g)) blocks.push(`<div class="lbh">${esc(g)}</div>${labTableHtml(groups.get(g), names, md)}`);
        for (const [cat, list] of rest) blocks.push(`<div class="lbh">${esc(cat)}</div>${labTableHtml(list, [...new Set(list.map((it) => it.item))], md)}`);
        const textHtml = texts.length
            ? `<div class="lbh">文字結果</div>${texts.sort((x, y) => x.dateMs - y.dateMs).map((it) => `<div class="lbl"><span class="muted">${md(it.dateMs)}</span> <b>${esc(it.item)}</b> ${esc(it.value)}</div>`).join('')}` : '';
        const hiddenN = (d.hidden || 0) + dcHidden;
        const note = `資料來源未提供異常標記與參考範圍，僅顯示數值（欄名的 tooltip 是單位）。${hiddenN ? `已依 lab-summary 規則略過 ${hiddenN} 筆（HCT／MCH／MCHC／RBC 等血液不看的項目、非檢驗值的列、正常範圍內的差別計數）。` : ''}${range}。`;
        return `${warn}${blocks.join('')}${textHtml}<div class="muted nov">${note}</div>`;
    }

    // 第一次展開才為該病人載入；失敗可收合再展開重試
    async function loadLab(w, i, r, win) {
        const body = w.document.getElementById(`c${i}-labbody`);
        const sum = body && body.parentNode.querySelector('summary');
        r.labState = 'loading';
        if (body) body.innerHTML = '<span class="muted">載入中…</span>';
        try {
            const d = await fetchLab(r.p, win);
            if (w.closed) return;
            body.innerHTML = renderLabBody(d, win);
            const lbs = sum && sum.querySelector('.lbs');
            if (lbs) lbs.textContent = `檢驗數值（${d.items.length} 項）`;
            r.labState = 'done';
        } catch (e) {
            r.labState = 'error';
            if (!w.closed && body) body.innerHTML = `<div class="err">⚠ 檢驗數值抓取失敗：${esc(e.name === 'AbortError' ? '逾時' : e.message)}（收合再展開可重試）</div>`;
        }
    }

    const titleLink = (text, url) => `<a href="${esc(url)}" target="_blank" rel="noopener" title="開啟${esc(text)}頁（新分頁）">${esc(text)} ↗</a>`;
    const renderCharts = (r, win) => (r.pending.has('vitals') ? '<div class="muted nov">生命徵象圖：抓取中…</div>' : chartsHtml(r, win));

    function cardShell(i, r, win) {
        const p = r.p;
        const u = pageUrls(p);
        return `<section class="card">
<div class="hd"><b>${esc(p.bed)}</b> ${esc(p.name)} <small class="muted">${esc(p.chartNo)} · ${esc(p.sex)} ${esc(p.age)}${p.hospDay ? ' · 住院 ' + esc(p.hospDay) + ' 天' : ''}</small> <span class="lk">${renderLinks(r)}</span></div>
<div id="c${i}-vit">${renderVit(r, win)}</div>
<div id="c${i}-err">${renderErr(r)}</div>
<div class="kv"><span class="k">${titleLink('抗生素', u.rx)}</span><div id="c${i}-abx">${renderAbx(r)}</div></div>
<div class="kv"><span class="k"><a href="${esc(u.cath)}" target="ntuh-catheter" data-cath="1" title="開啟管路頁（固定開在同一個分頁；簡報載入完成後才能開）">管路 ↗</a></span><div id="c${i}-tubes">${renderTubes(r)}</div></div>
<div class="kv"><span class="k">${titleLink('檢驗', u.lab)}</span><div><details class="lb" data-lab="${i}"><summary><span class="lbs">檢驗數值（點擊載入）</span>${labHint(r)}</summary><div id="c${i}-labbody"></div></details></div></div>
<div class="kv"><span class="k"><a href="#" data-pacs="${i}" title="開啟影像列表">影像 ↗</a></span><div id="c${i}-pacs">${renderPacs(r)}</div></div>
<div class="mt ct">${titleLink('生命徵象', u.vitals)}</div>
<div id="c${i}-charts">${renderCharts(r, win)}</div></section>`;
    }

    // 某個來源回來 → 只更新卡片上對應的格子（不重畫整張卡，使用者展開的影像報告／收合的圖表不會被重設）
    function applyUpdate(w, i, src, r, win) {
        if (!w || w.closed) return;
        const set = (id, html) => { const el = w.document.getElementById(`c${i}-${id}`); if (el) el.innerHTML = html; };
        if (src === 'vitals') { set('vit', renderVit(r, win)); set('charts', renderCharts(r, win)); }
        if (src === 'pacs') set('pacs', renderPacs(r));
        if (src === 'abx') set('abx', renderAbx(r));
        if (src === 'tubes') set('tubes', renderTubes(r));
        set('err', renderErr(r));
    }
    const setText = (w, id, text) => { if (w && !w.closed) { const el = w.document.getElementById(id); if (el) el.textContent = text; } };

    // 頁面骨架：先把所有病人的空卡片（已知的床號、姓名、檢驗時間先填好）一次畫出來
    function pageShell(states, win) {
        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>晨間簡報 ${esc(fmt(win.toMs))}</title>
<style>
:root{--bg:#fff;--fg:#1c1f23;--mut:#6b7280;--line:#e5e7eb;--md:#ffedd5;--new:#dbeafe}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8ea;--mut:#9aa1a9;--line:#2a2f35;--md:#4a2c12;--new:#172a45}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Noto Sans TC",sans-serif}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:12px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:0 4px 2px 0;font-size:12px}.tag.new{background:var(--new)}.tag.warn{background:var(--md);border-color:#fdba74}a.tag{color:inherit;text-decoration:none}a.tag:hover{text-decoration:underline}
.muted{color:var(--mut)}small{font-size:12px}.err{color:#b91c1c;margin-top:4px;font-size:12px}.rep{font-size:12px;color:var(--mut);}.nov{font-size:12px;margin-top:2px}
:root{--series:#2a78d6;--serious:#ec835a;--critical:#d03b3b;--surf:#fff;--grid:#e1e0d9;--axis:#c3c2b7;--tk:#898781;--ok:rgba(137,135,129,.14);--bmed:rgba(250,178,25,.16);--bhigh:rgba(208,59,59,.14)}
@media (prefers-color-scheme:dark){:root{--series:#3987e5;--surf:#14171a;--grid:#2c2c2a;--axis:#383835;--ok:rgba(137,135,129,.18);--bmed:rgba(250,178,25,.18);--bhigh:rgba(208,59,59,.22)}}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}
@media (max-width:1000px){.grid{grid-template-columns:1fr}}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
.hd{font-size:15px;margin-bottom:2px}.hd .lk{margin-left:6px}.hd .lk .tag{margin:0 3px 0 0}
.kv{display:flex;gap:8px;margin-top:2px}.kv .k{flex:none;width:4.8em;font-size:12px;color:var(--mut)}
.k a,.mt a{color:inherit;text-decoration:none}.k a:hover,.mt a:hover{text-decoration:underline}
.lb{margin-top:2px}.lb>summary{cursor:pointer;font-size:12px;color:var(--mut)}.lbh{margin:4px 0 1px;font-size:12px;color:var(--mut)}.lbl{margin:1px 0;font-size:12px}
.lt{border-collapse:collapse;width:auto;margin:0 0 4px 8px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}.lt th,.lt td{border:0;padding:0 14px 0 0;text-align:left;white-space:nowrap;font-weight:400}.lt thead th{color:var(--mut)}.lt tbody th{color:var(--mut)}
.pc>summary{cursor:pointer;list-style:none}.pc>summary::-webkit-details-marker{display:none}.pc>summary::before{content:'▸ ';color:var(--mut)}.pc[open]>summary::before{content:'▾ '}.pc .rep{margin:2px 0 4px 14px;white-space:pre-wrap}
.charts{margin-top:2px}
.mt{font-size:12px;color:var(--mut);margin:2px 0}.tv{margin-top:6px;font-size:12px}.tv table{width:auto}.tv th,.tv td{padding:2px 10px 2px 0}.tv summary{cursor:pointer;color:var(--mut)}
svg.hsvg{max-width:100%;height:auto;display:block;margin:2px 0 8px}svg.hsvg.sp{margin:-6px 0 8px;overflow:visible}
svg.hsvg .ax{cursor:pointer}svg.hsvg .ax text{stroke-width:.35;font-size:13px}svg.hsvg .ax line,svg.hsvg .ser line{stroke-width:1}
svg.hsvg .ax.off{fill:lightgray!important;stroke:lightgray!important}svg.hsvg .ser.off{visibility:hidden}
svg.hsvg .ser circle{stroke:none}svg.hsvg .ser text.na{font-size:12px;stroke-width:.4}
svg.hsvg .hit{fill:transparent;stroke:none}svg.hsvg .hitl{stroke:transparent;stroke-width:12}
@media print{body{padding:0;font-size:11px}.card{break-inside:avoid}}
</style></head><body>
<h1>晨間簡報</h1>
<div class="sub"><span id="prog">載入中 0/${states.length}</span></div>
<div class="grid">${states.map((r, i) => cardShell(i, r, win)).join('')}</div>
<script>(${pageScript.toString()})();<\/script></body></html>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 進入點
    // ═══════════════════════════════════════════════════════════

    async function run(btn) {
        // 病房列表本來就只帶出登入者的病人，不再另外篩選
        const mine = readPatients();
        if (!mine.length) { alert('找不到病人清單'); return; }

        // 必須在「使用者點擊」的同一個動作裡先開分頁，否則抓完才開會被瀏覽器的彈出視窗封鎖擋下
        const w = window.open('', '_blank');
        if (!w) { alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。'); return; }

        const win = briefingWindow(START_HOUR);
        const now = nowMs();
        const states = mine.map((p) => newResult(p, win, now));
        w.document.open();
        w.document.write(pageShell(states, win));
        w.document.close();
        // 檢驗數值：第一次展開才為該病人載入（toggle 不會冒泡，要用 capture）
        w.document.addEventListener('toggle', (ev) => {
            const dt = ev.target;
            if (!dt.matches || !dt.matches('details.lb[data-lab]') || !dt.open) return;
            const i = +dt.getAttribute('data-lab'), r = states[i];
            if (r && r.labState !== 'loading' && r.labState !== 'done') loadLab(w, i, r, win);
        }, true);
        let loading = true;   // 簡報載入中（finally 之後才會變 false）
        // 影像：點擊時為該病人開啟來源頁（邏輯在原頁）。管路：載入中先擋下，避免互相干擾。
        w.document.addEventListener('click', (ev) => {
            const c = ev.target.closest && ev.target.closest('a[data-cath]');
            if (c && loading) { ev.preventDefault(); alert('簡報還在載入管路，請等頁首顯示「完成」後再開管路頁（避免兩邊互相干擾）。'); return; }
            const a = ev.target.closest && ev.target.closest('a[data-pacs]');
            if (!a) return;
            ev.preventDefault();
            const r = states[+a.getAttribute('data-pacs')];
            if (r) openPacsList(w, r.p);
        });

        const label = btn.textContent;
        const idleBg = btn.style.background;
        // 執行中：換色＋等待游標＋顯示進度，避免使用者以為當掉
        btn.disabled = true;
        btn.style.background = '#d97706';
        btn.style.cursor = 'wait';
        const setProg = (phase, done) => {
            const t = `${phase} ${done}/${mine.length}`;
            btn.textContent = `⏳ ${t}`;
            setText(w, 'prog', `載入中：${t}`);
        };
        // 程式錯誤的保險（正常情況 assess 不會丟出，來源失敗都記在 res.errors）
        const markFailed = (r, i, e) => {
            r.errors.push('判讀失敗：' + (e && e.message || e));
            r.pending.clear();
            for (const src of ['vitals', 'pacs', 'abx', 'tubes']) applyUpdate(w, i, src, r, win);
        };
        const wall0 = nowMs();
        try {
            // 階段一（輕）：所有病人的 vitals＋影像一起發，實際同時數由 lib 限制；畫面上生命徵象圖與影像先出現
            let d1 = 0;
            setProg('生命徵象與影像', 0);
            await Promise.all(states.map(async (r, i) => {
                try { await assessLight(r, win, (src, rr) => applyUpdate(w, i, src, rr, win)); } catch (e) { markFailed(r, i, e); }
                setProg('生命徵象與影像', ++d1);
            }));

            // 階段二（重）：抗生素＋管路，依病人順序、一次 HEAVY_POOL 位；卡片會由上而下依序補完
            let d2 = 0, next = 0;
            setProg('抗生素與管路', 0);
            const worker = async () => {
                while (next < states.length) {
                    const i = next++;
                    const r = states[i];
                    try { await assessHeavy(r, now, (src, rr) => applyUpdate(w, i, src, rr, win)); } catch (e) { markFailed(r, i, e); }
                    setProg('抗生素與管路', ++d2);
                }
            };
            await Promise.all(Array.from({ length: Math.min(HEAVY_POOL, states.length) }, worker));
        } finally {
            loading = false;
            btn.disabled = false;
            btn.style.background = idleBg;
            btn.style.cursor = 'pointer';
            btn.textContent = label;
        }

        setText(w, 'prog', `完成（${((nowMs() - wall0) / 1000).toFixed(1)} 秒）`);
    }

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

    function mount() {
        if (document.getElementById('ntuh-mb-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ntuh-mb-btn';
        btn.textContent = '晨間簡報';
        btn.onclick = () => run(btn);
        const anchor = document.getElementById('NTUHWeb1_QueryInPatientPersonAccountControl1_ButtonBedPatientHistory')
            || document.querySelector('[id$="QueryInPatientPersonAccountControl1_ButtonBedPatientHistory"]');
        if (anchor) {
            btn.className = anchor.className;
            btn.style.cssText = anchor.style.cssText;
            anchor.insertAdjacentElement('afterend', btn);
            btn.before(document.createTextNode(' '));
        } else {
            btn.style.cssText = 'pointer-events:auto;padding:8px 14px;border:0;border-radius:18px;background:#0f766e;color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
            getDock().appendChild(btn);
        }
    }

    mount();
}());
