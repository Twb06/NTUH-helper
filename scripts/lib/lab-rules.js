// ==============================================================
// 檢驗數值規則與解析（OuterData lab 的 tblLabList）
// --------------------------------------------------------------
// 名稱正規化、略過規則、DC 參考範圍、臨床分組：取自 lab-summary（改動時要同步）。
// 晨間簡報（morning-briefing）與查房單（rounds-sheet）共用。純解析，不碰網路。
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/lab-rules.js
//   之後用全域的 NTUHLab；node 測試則 require('./lab-rules.js')（parseLabList 需要 DOMParser）。
// ==============================================================

/* global module */
(function (root) {
    'use strict';

    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');
    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

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

    // ─── 檢驗數值（OuterData lab）────────────────────────────
    // 需要 PersonId（從病房 Cookie 取，只在記憶體內用、不顯示、不存）。回傳一張 tblLabList，每列＝一個檢驗結果；
    // 畫面上只有 4 個可見欄（日期 MMDD、類別、項目、科室），數值在後面 5 個隱藏欄：
    // [4] 完整日期 yyyy/MM/dd　[5] 類別　[6] 數值　[7] 項目　[8] 單位（新竹實測 2026-10-05，lab-shape-probe）。
    // 日期只到「日」（沒有時分），所以起點以日為單位；資料沒有異常標記也沒有參考範圍 → 只顯示值，不自己判斷高低。
    // 同一筆可能重複出現（例如血液培養），以（日期、類別、項目、數值、單位）去重。
    // logTag：Console 警告的前綴（例如「晨間簡報」「查房單」），方便分辨是哪支腳本。
    function parseLabList(html, sinceMs, logTag = 'NTUHLab') {
        const doc = parseHtml(html);
        const table = doc.querySelector('[id$="tblLabList"]');
        if (!table) {
            // 這陣子沒有報告的病人，伺服器回傳的 HTML 不含檢驗表（使用者在 HIS 逐一確認過），視為「沒有資料」而不是錯誤。
            // 風險：若院方改版導致表格不見，每位病人都會顯示「沒有報告」——訊息裡提示，並在 Console 留紀錄。
            console.warn('[' + logTag + '] OuterData lab 沒有 tblLabList，視為近期沒有檢驗報告（HTML 長度 ' + html.length + '）');
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


    const api = {
        stripCJK, nameKey,
        LAB_NAME_MAP, LAB_NAME_BY_KEY, labDisplayName,
        LAB_IGNORE, LAB_SKIP_KEYWORDS, LAB_SKIP_EXACT, labShouldSkip,
        LAB_DC_RANGE, LAB_GROUPS, LAB_GROUP_OF, LAB_BLOOD_CAT_RE, LAB_NONBLOOD_CAT_RE,
        parseLabList,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else if (!root.NTUHLab) root.NTUHLab = api;
}(typeof window !== 'undefined' ? window : globalThis));
