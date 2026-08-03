// ==UserScript==
// @name         NTUH 檢驗整理
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.3.0
// @description  在檢驗報告頁 (MedicalReportContent.aspx) 自動讀取 DOM，整理成「趨勢」段落或「對齊表格」兩種呈現，可於結果框標題列切換並記住選擇（支援清單版與綠單趨勢版）
// @match        *://*/*MedicalReportContent.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ====== 分類定義 ======

    // 呈現方式：table＝日期為列的對齊表格，trend＝單行段落（值以 → 串接）。
    // 存 localStorage 讓下次開啟沿用；背景 worker 也讀同一把 key，
    // 兩者都跑在 MedicalReportContent.aspx 同源，不需另外傳遞。
    const VIEW_KEY = 'ntuh_lab_view_mode';
    const VIEW_TABLE = 'table';
    const VIEW_TREND = 'trend';

    function getViewPref() {
        try {
            return localStorage.getItem(VIEW_KEY) === VIEW_TREND ? VIEW_TREND : VIEW_TABLE;
        } catch (e) {
            return VIEW_TABLE;
        }
    }
    function setViewPref(v) {
        try { localStorage.setItem(VIEW_KEY, v); } catch (e) { /* noop */ }
    }

    const IGNORE = ['HCT', 'Hct', 'MCH', 'MCHC', 'RDW-CV', 'PS', 'RBC', 'Sugar'];

    const RARE_DIFF = ['Blast', 'Promyl.', 'Myelo.', 'Meta', 'Aty.Lym.', 'PlasmaCell', 'Normobl.'];

    const HEMOGRAM_MAIN = ['WBC', 'HB', 'PLT', 'Seg'];
    const HEMOGRAM_EXT = ['Eos.', 'Baso.', 'Band', 'Lym.', 'Mono.'];
    const LIVER_RENAL = ['ALT', 'AST', 'ALP', 'T-BIL', 'D-BIL', 'GGT', 'ALB', 'CRE', 'BUN', 'eGFR', 'Ammonia N', 'CK'];
    const ELECTROLYTES = ['Na', 'K', 'Mg', 'Ca', 'P', 'Cl'];
    const OTHERS = ['UA', 'CRP', 'hsCRP', 'Glucose', 'HbA1c', 'VIT. B12', 'Folic Acid', 'NT-pro BNP', 'BNP', 'LA', 'TP', 'LDH'];
    const GAS = ['pH', 'PCO2', 'PO2', 'HCO3', 'BE'];
    const COAG = ['PT', 'INR', 'aPTT', 'PTT', 'D-dimer', 'Fibrinogen'];

    const CULTURE_KEYS = ["Gram's", 'ID+DS', 'Anaerobic', 'ID C.', 'ID Campy.',
        'Blood Culture',
        'VRE screening', 'CRE screening', 'MRSA screening', 'CRAB screening',
        'CMV viral load', 'Aspergillus Ag', 'EBV viral load',
        'Fungus', 'AFS+Culture', 'AFS +Culture',
        'SARS-CoV-2 Antigen', 'Influenza A+B'];

    const SPECIAL_CULTURE_MAP = {
        'CMV': 'CMV', 'EBV': 'EBV', 'Aspergillus': 'Aspergillus Ag',
        'AFS': 'AFS', 'Fungus': 'Fungus',
        'SARS-CoV-2 Antigen': 'SARS-CoV-2', 'Influenza A+B': 'Influenza A+B',
    };

    const PCR_MAP = {
        'SARS-CoV-2 RNA PCR': 'COVID PCR',
        'Influenza A RT-PCR Detection': 'Influenza A PCR',
        'Influenza B RT-PCR Detection': 'Influenza B PCR',
        'RSV RT-PCR Detection': 'RSV PCR',
    };

    const ALL_KNOWN = [
        ...HEMOGRAM_MAIN, ...HEMOGRAM_EXT, ...RARE_DIFF,
        ...LIVER_RENAL, ...ELECTROLYTES, ...OTHERS,
        ...GAS, ...COAG, 'MCV', 'Seg', 'eGFR',
    ];

    const ATTACH = { WBC: 'Seg', HB: 'MCV', CRE: 'eGFR' };
    const ATTACHED = new Set(['Seg', 'MCV', 'eGFR']);

    const HEMO_EXT_RANGE = {
        'Eos.': [0, 8], 'Baso.': [0, 2], 'Band': [0, 5],
        'Lym.': [20, 45], 'Mono.': [2, 10],
    };

    const URINE_ALWAYS_SHOW = ['RBC', 'WBC', 'Bac'];

    // CSF：顯示順序（未列到的項目接在後面）
    const CSF_ORDER = ['WBC', 'L/N', 'RBC', 'TP', 'Glucose', 'Lactate', 'LDH', 'ADA'];
    const CSF_NAME_MAP = {
        'WBC': 'WBC', 'RBC': 'RBC', 'L/N': 'L/N',
        'TP(CSF)': 'TP', 'Glucose(CSF)': 'Glucose',
        'Lactate(CSF)': 'Lactate', 'LDH(CSF)': 'LDH', 'ADA(CSF)': 'ADA',
    };

    const NAME_MAP = {
        'Hb': 'HB', 'PLT': 'PLT', 'WBC': 'WBC', 'MCV': 'MCV',
        'Seg': 'Seg', 'Eos.': 'Eos.', 'Baso.': 'Baso.', 'Band': 'Band',
        'Lym.': 'Lym.', 'Mono': 'Mono.', 'Alb': 'ALB', 'T-BIL': 'T-BIL',
        'AST': 'AST', 'ALT': 'ALT', 'ALP': 'ALP', 'UN': 'BUN',
        'CRE': 'CRE', 'UA': 'UA', 'Na': 'Na', 'K': 'K', 'Mg': 'Mg',
        'Ca': 'Ca', 'P': 'P', 'Cl': 'Cl', 'CRP': 'CRP',
        'LacticAcid': 'LA', 'pH': 'pH', 'pCO2': 'PCO2', 'pO2': 'PO2',
        'HCO3-': 'HCO3', 'Base Excess': 'BE', 'HbA1c': 'HbA1c',
        'NT-pro BNP': 'NT-pro BNP', 'BNP': 'BNP',
        'PT': 'PT', 'PT INR': 'INR', 'PTT': 'PTT',
        'D-dimer': 'D-dimer', 'Fibrinogen': 'Fibrinogen',
        'aPTT': 'aPTT', 'Ammonia N': 'Ammonia N', 'CK': 'CK',
        'TP': 'TP', 'LDH': 'LDH',
    };

    const URINE_NAME_MAP = {
        'Protein(Dipstick)': 'Protein', 'Protein(C)': 'Protein',
        'Glu.(Dipstick)': 'Glucose', 'Glu.(C)': 'Glucose',
        'Ketone(Dipstick)': 'Ketone', 'Ketones(C)': 'Ketone',
        'O.B.(Dipstick)': 'OB', 'O.B.(C)': 'OB',
        'Urobil.(Dipstick)': 'Urobilinogen', 'Urobil.(C)': 'Urobilinogen',
        'Bil.(Dipstick)': 'Bilirubin', 'Bil.(C)': 'Bilirubin',
        'Nitrite(Dipstick)': 'Nitrite', 'Nitrite(C)': 'Nitrite',
        'WBC esterase (Dipstick)': 'WBC esterase', 'Leukocyte esterase': 'WBC esterase',
        'RBC (Sediment)': 'RBC', 'RBC(S)': 'RBC',
        'WBC (Sediment)': 'WBC', 'WBC(S)': 'WBC',
        'Epith. (Sediment)': 'Epi', 'EpithCell(S)': 'Epi',
        'Cast (Sediment)': 'Cast', 'Cast(S)': 'Cast',
        'Crystal (Sediment)': 'Crystal', 'Crystal(S)': 'Crystal',
        'Bacteria (Sediment)': 'Bac', 'Others (Sediment)': 'Others', 'Others(S)': 'Others',
        'Sp. Gr.(Dipstick)': 'Sp.Gr.', 'Sp. Gr.(C)': 'Sp.Gr.',
        'pH(Dipstick)': 'pH', 'pH(C)': 'pH',
        'Alb.(Dipstick)': 'Albumin', 'Albumin(Dipstick)': 'Albumin',
        'Creatinine(Dipstick)': 'Creatinine',
        'Alb./Cre.(Dipstick)': 'ACR', 'Albumin/Creatinine(Dipstick)': 'ACR',
    };

    const URINE_SKIP = ['Creatinine(Dipstick)', 'Albumin/Creatinine(Dipstick)', 'Albumin(Dipstick)', 'Alb.(Dipstick)', 'Alb./Cre.(Dipstick)'];

    const SKIP_KEYWORDS = [
        '檢驗項目', '計算', '採檢', '登入', '最後', '本尿',
        'High >', 'Low <', 'Average', '七日',
        'BLOOD', 'Peripheral', 'URINE', 'OTHER',
        'Venous', 'Catheter', 'Random', 'RANDOM',
        'Special Instructions',
        'RH', 'ABO Typing', 'antibody screen',
        'Reference Comment',
    ];

    const GENUS_ABBR = [
        'Enterococcus', 'Staphylococcus', 'Streptococcus', 'Klebsiella',
        'Pseudomonas', 'Escherichia', 'Acinetobacter', 'Stenotrophomonas',
        'Bacteroides', 'Eggerthella', 'Eubacterium', 'Clostridioides',
        'Candida', 'Serratia', 'Proteus', 'Citrobacter', 'Morganella',
    ];

    const COMPLEX_ABBR = { 'Enterobacter cloacae complex': 'ECC' };

    function abbrGenus(text) {
        for (const [full, abbr] of Object.entries(COMPLEX_ABBR)) {
            if (text.indexOf(full) > -1) text = text.split(full).join(abbr);
        }
        for (const g of GENUS_ABBR) {
            if (text.indexOf(g) > -1) text = text.split(g).join(g.charAt(0) + '.');
        }
        return text;
    }

    // ====== 工具函式 ======

    function normalizeName(raw) {
        if (raw.indexOf('eGFR (MDRD)') > -1) return '__SKIP__';
        if (raw.indexOf('eGFR (CKD-EPI)') > -1) return 'eGFR';
        const clean = raw.replace(/\(.*?\)/g, '').trim();
        return NAME_MAP[clean] || clean;
    }

    function parseGreenItemName(raw) {
        return raw.replace(/\(.*?\)/g, '').trim();
    }

    function cleanGreenValue(val) {
        return val.replace(/\(Manual\s*checked\)/i, '').replace(/\(Manual\)/i, '').trim();
    }

    function isUrineAbnormal(val) {
        if (!val || val === '-') return false;
        if (val.startsWith('≦') || val.startsWith('≤')) return false;
        if (val.toLowerCase().startsWith('normal')) return false;
        if (/\([0-9]+\+\)/.test(val)) return true;
        if (/^[0-9]*\+$/.test(val)) return true;
        if (val.startsWith('≧') || val.startsWith('>=')) return true;
        return false;
    }

    function displayUrineVal(val) {
        const pm = val.match(/\(([0-9]+\+)\)/);
        return pm ? pm[1] : val;
    }

    function flagValue(val, ref) {
        const xv = parseFloat(val);
        if (isNaN(xv) || !ref) return '';
        const m = ref.match(/([0-9.]+)[~\-+]([0-9.]+)/);
        if (!m) return '';
        if (xv < parseFloat(m[1])) return '↓';
        if (xv > parseFloat(m[2])) return '↑';
        return '';
    }

    function pushToStore(store, name, idx, val) {
        if (!store[name]) store[name] = [];
        while (store[name].length <= idx) store[name].push('');
        if (!store[name][idx]) store[name][idx] = val;
    }

    function padData(dataMap, len) {
        for (const nm of Object.keys(dataMap)) {
            while (dataMap[nm].length < len) dataMap[nm].push('');
        }
    }

    function sortByDate(dArr, dataMap) {
        if (dArr.length <= 1) return;
        const order = dArr.map((d, i) => i);
        order.sort((a, b) => {
            const [am, ad] = dArr[a].split('/').map(Number);
            const [bm, bd] = dArr[b].split('/').map(Number);
            return am !== bm ? am - bm : ad - bd;
        });
        const sortedDates = order.map(i => dArr[i]);
        for (let i = 0; i < sortedDates.length; i++) dArr[i] = sortedDates[i];
        for (const nm of Object.keys(dataMap)) {
            const old = dataMap[nm].slice();
            for (let i = 0; i < order.length; i++) dataMap[nm][i] = old[order[i]] || '';
        }
    }

    function specimenLabel(headerText) {
        if (/BLOOD/i.test(headerText)) {
            const srcM = headerText.match(/BLOOD\s+(\S+)\s+採檢/);
            return 'B/C (' + (srcM ? srcM[1].toLowerCase() : 'blood') + ')';
        }
        if (/URINE/i.test(headerText)) {
            const srcM = headerText.match(/URINE\s+(.*?)\s+採檢/);
            let src = 'urine';
            if (srcM) {
                const s = srcM[1].toLowerCase();
                if (s.indexOf('void') > -1) src = 'void';
                else if (s.indexOf('cath') > -1) src = 'cath';
                else src = s;
            }
            return 'U/C (' + src + ')';
        }
        if (/SPUTUM/i.test(headerText)) return 'Spu/C';
        const specM = headerText.match(/No:\S+\s+(.*?)\s*採檢/);
        let specDesc = '';
        if (specM) {
            const raw = specM[1].trim();
            if (/[一-鿿]/.test(raw)) {
                specDesc = raw.replace(/^[A-Z()\s\/]+/, '').trim() || raw;
            } else {
                const words = raw.split(/\s+/).filter(w => /^[A-Z]+$/.test(w));
                const last = words.length ? words[words.length - 1] : raw.split(/\s+/)[0];
                specDesc = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
            }
        }
        return specDesc ? specDesc + '/C' : 'Other/C';
    }

    function cultureKeysMatch(rawName) {
        const lower = rawName.toLowerCase();
        return CULTURE_KEYS.some(ck => lower.indexOf(ck.toLowerCase()) > -1);
    }

    // ====== 清單版 DOM 讀取 ======

    function readListView(view) {
        const tables = document.querySelectorAll('table.DetailedSheet');
        if (!tables.length) return null;

        const dates = [];
        const trendData = {};
        const urineData = {};
        const urineDates = [];
        const aGasData = {};
        const aGasDates = [];
        const vGasData = {};
        const vGasDates = [];
        const csfData = {};
        const csfDates = [];
        const cultureItems = [];
        const structuredCultures = [];
        let collectDate = '';
        let headerText = '';

        const AGAS_NAME_MAP = {
            'LacticAcid': 'LA', 'Hb': 'HB', 'Cl-': 'Cl',
            'K+': 'K', 'Na+': 'Na', 'Free Ca2+': 'iCa',
            'pH': 'pH', 'pCO2': 'PCO2', 'pO2': 'PO2',
            'HCO3-': 'HCO3', 'HCO3': 'HCO3', 'Base Excess': 'BE', 'BaseExcess': 'BE',
            'FiO2': 'FiO2', 'SO2': 'SO2', 'Glucose': 'Glucose',
        };
        const AGAS_SKIP = ['Hct'];

        tables.forEach(table => {
            let prev = table.previousElementSibling;
            while (prev && prev.tagName !== 'TABLE') {
                const txt = prev.textContent || '';
                const dm = txt.match(/採檢:(\d{4})\/(\d{2})\/(\d{2})/);
                if (dm) {
                    collectDate = dm[2] + '/' + dm[3];
                    headerText = txt;
                    break;
                }
                prev = prev.previousElementSibling;
            }

            const isArterialGas = /Arterial Blood/i.test(headerText);

            if (isArterialGas) {
                if (!aGasDates.includes(collectDate)) aGasDates.push(collectDate);
                const gDateIdx = aGasDates.indexOf(collectDate);

                const rows = table.querySelectorAll('tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length < 2) return;
                    const rawName = (cells[0].textContent || '').trim();
                    const rawVal = (cells[1].textContent || '').trim();
                    if (!rawName || !rawVal) return;
                    if (SKIP_KEYWORDS.some(kw => rawName.indexOf(kw) > -1)) return;
                    const cleanName = parseGreenItemName(rawName);
                    if (AGAS_SKIP.includes(cleanName) || IGNORE.includes(cleanName)) return;
                    const gasName = AGAS_NAME_MAP[cleanName] || cleanName;
                    pushToStore(aGasData, gasName, gDateIdx, cleanGreenValue(rawVal));
                });
                return;
            }

            if (collectDate && !dates.includes(collectDate)) dates.push(collectDate);
            const dateIdx = dates.indexOf(collectDate);

            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) return;

                const rawName = (cells[0].textContent || '').trim();
                const rawVal = (cells[1].textContent || '').trim();

                if (!rawName || !rawVal) return;
                if (/^\d{2}:\d{2}/.test(rawName)) return;
                if (SKIP_KEYWORDS.some(kw => rawName.indexOf(kw) > -1)) return;

                const cleanName = parseGreenItemName(rawName);

                // CSF 檢體：獨立分組，不套用 IGNORE / 血液項目對應
                if (/C\.\s*S\.\s*F\.|\bCSF\b/i.test(headerText) && !cultureKeysMatch(rawName)) {
                    const csfName = CSF_NAME_MAP[rawName]
                        || (/\(CSF\)/i.test(rawName) ? cleanName : null);
                    if (!csfName) return;
                    if (!csfDates.includes(collectDate)) csfDates.push(collectDate);
                    pushToStore(csfData, csfName, csfDates.indexOf(collectDate), cleanGreenValue(rawVal));
                    return;
                }

                if (IGNORE.includes(cleanName)) return;

                const val = cleanGreenValue(rawVal);

                if (cultureKeysMatch(rawName)) {
                    if (/Epithelial cell|PMN/i.test(val)) return;
                    if (/No bacteria visible/i.test(val)) return;
                    const isNeg = /no growth|no aerobic\s+pathogen|no anaerobic\s+pathogen|^Undetectable$|^Negative$|^No Fungus$/i.test(val);
                    const remark = cells[4] ? (cells[4].textContent || '').trim() : '';
                    let cResult = isNeg ? '-' : val.replace(/Multiple colonial morphotypes present[;,]\s*/i, '');
                    if (!isNeg && remark) {
                        const rMap = {
                            'Carbapenem-resistant': 'CR', 'ESBL': 'ESBL',
                            'MRSA': 'MRSA', 'VRE': 'VRE', 'MDR': 'MDR',
                        };
                        for (const [pattern, abbr] of Object.entries(rMap)) {
                            if (remark.indexOf(pattern) > -1) { cResult += ' (' + abbr + ')'; break; }
                        }
                    }
                    let specialMatched = false;
                    for (const [key, label] of Object.entries(SPECIAL_CULTURE_MAP)) {
                        if (rawName.toLowerCase().indexOf(key.toLowerCase()) > -1) {
                            structuredCultures.push({ date: collectDate, label: label, result: cResult });
                            specialMatched = true;
                            break;
                        }
                    }
                    if (specialMatched) {
                        // handled above
                    } else if (/screening/i.test(rawName)) {
                        const scrType = rawName.match(/^(\S+)\s+screening/i);
                        const scrName = scrType ? scrType[1].toUpperCase() : rawName;
                        const scrRef = cells[3] ? (cells[3].textContent || '').trim() : '';
                        const scrNeg = (scrRef && val.toLowerCase() === scrRef.toLowerCase()) || /^No\s/i.test(val);
                        const specM2 = headerText.match(/No:\S+\s+(.*?)\s*採檢/);
                        let scrLabel = 'Swab';
                        if (specM2) {
                            const raw2 = specM2[1].trim();
                            const words2 = raw2.split(/\s+/).filter(w => /^[A-Z]+$/.test(w));
                            if (words2.length) scrLabel = words2[words2.length - 1].charAt(0).toUpperCase() + words2[words2.length - 1].slice(1).toLowerCase();
                        }
                        structuredCultures.push({ date: collectDate, label: scrLabel, result: scrName + ' (' + (scrNeg ? '-' : '+') + ')' });
                    } else if (/ID\+DS|ID C\.|ID Campy\.|^Anaerobic|^Gram's|^Blood Culture/i.test(rawName)) {
                        structuredCultures.push({ date: collectDate, label: specimenLabel(headerText), result: cResult });
                    } else {
                        cultureItems.push((collectDate ? '[' + collectDate + '] ' : '') + rawName + ': ' + val);
                    }
                    return;
                }

                const pcrName = PCR_MAP[rawName];
                if (pcrName) {
                    const pcrResult = (val === 'Not Detected' || val === 'Negative') ? '-' : '+';
                    cultureItems.push((collectDate ? '[' + collectDate + '] ' : '') + pcrName + ' ' + pcrResult);
                    return;
                }

                const urineName = URINE_NAME_MAP[rawName];
                if (urineName !== undefined) {
                    if (!URINE_SKIP.includes(rawName)) {
                        if (!urineDates.includes(collectDate)) urineDates.push(collectDate);
                        const uDateIdx = urineDates.indexOf(collectDate);
                        pushToStore(urineData, urineName, uDateIdx, val);
                    }
                    return;
                }

                if (GAS.includes(rawName) || ['PH', 'PCO2', 'PO2', 'HCO3', 'BaseExcess'].includes(rawName)) {
                    const gasName = rawName === 'PH' ? 'pH'
                        : rawName === 'BaseExcess' ? 'BE'
                        : rawName;
                    if (!vGasDates.includes(collectDate)) vGasDates.push(collectDate);
                    const gDateIdx = vGasDates.indexOf(collectDate);
                    pushToStore(vGasData, gasName, gDateIdx, val);
                    return;
                }

                const nm = normalizeName(rawName);
                if (nm === '__SKIP__') return;

                const isG2 = RARE_DIFF.includes(nm);
                if (isG2 && (parseFloat(val) === 0 || !val)) return;

                pushToStore(trendData, nm, dateIdx, val);
            });
        });

        if (!dates.length && !aGasDates.length && !vGasDates.length && !cultureItems.length && !structuredCultures.length) return null;

        padData(trendData, dates.length);
        padData(urineData, urineDates.length);
        padData(csfData, csfDates.length);
        padData(aGasData, aGasDates.length);
        padData(vGasData, vGasDates.length);

        sortByDate(dates, trendData);
        sortByDate(aGasDates, aGasData);
        sortByDate(vGasDates, vGasData);
        sortByDate(urineDates, urineData);
        sortByDate(csfDates, csfData);

        const specialGroups = {};
        if (Object.keys(csfData).length) {
            specialGroups.CSF = { dates: csfDates, data: csfData };
        }
        if (Object.keys(urineData).length) {
            specialGroups.Urine = { dates: urineDates, data: urineData };
        }
        if (Object.keys(aGasData).length) {
            specialGroups['A gas'] = { dates: aGasDates, data: aGasData };
        }
        if (Object.keys(vGasData).length) {
            specialGroups['V gas'] = { dates: vGasDates, data: vGasData };
        }

        const cGroups = [];
        const cGroupMap = {};
        for (const c of structuredCultures) {
            const key = c.date + '||' + c.label;
            if (!cGroupMap[key]) {
                cGroupMap[key] = { date: c.date, label: c.label, results: [] };
                cGroups.push(cGroupMap[key]);
            }
            cGroupMap[key].results.push(c.result);
        }
        const cByDate = {};
        const cDateOrder = [];
        cGroups.sort((a, b) => {
            const [am, ad] = a.date.split('/').map(Number);
            const [bm, bd] = b.date.split('/').map(Number);
            return am !== bm ? am - bm : ad - bd;
        });
        for (const g of cGroups) {
            if (!cByDate[g.date]) { cByDate[g.date] = []; cDateOrder.push(g.date); }
            const allNeg = g.results.every(r => r === '-');
            const display = allNeg ? '-' : abbrGenus(g.results.filter(r => r !== '-').join('; '));
            cByDate[g.date].push(g.label + ': ' + display);
        }
        for (const dt of cDateOrder) {
            cultureItems.push('[' + dt + '] ' + cByDate[dt].join('\n[' + dt + '] '));
        }

        let result = formatTrend(dates, trendData, Object.keys(specialGroups).length ? specialGroups : null, view);
        if (cultureItems.length) {
            // 分隔符要跟著呈現方式走：表格模式各區塊之間空一行，趨勢模式維持單行
            // 換行（與 v0.2.3 相同）。之前固定用 \n\n，會讓趨勢模式多一個空白行。
            const sep = view === VIEW_TREND ? '\n' : '\n\n';
            result = (result || '') + (result ? sep : '') + '#. Culture:\n' + cultureItems.join('\n');
        }
        return result;
    }

    // ====== 單日格式化（summary 風格） ======

    function formatSingleDay(data, gasData, urineItems, cultureItems) {
        const fmt = (nm) => {
            const x = data[nm];
            if (!x) return null;
            const parts = [nm, ' ', x.v];
            if (x.u) parts.push(' ', x.u);
            if (x.f) parts.push(' (', x.f, ')');
            return parts.join('');
        };

        const buildGroup = (keys) => keys.map(fmt).filter(Boolean);

        const output = [];

        // Gas
        const gasOrder = ['pH', 'PCO2', 'PO2', 'HCO3', 'BE'];
        const gasParts = gasOrder
            .filter(k => gasData[k])
            .map(k => {
                const g = gasData[k];
                let s = k + ' ' + g.v;
                if (g.u) s += ' ' + g.u;
                if (g.f) s += ' (' + g.f + ')';
                return s;
            });
        if (gasParts.length) output.push('Gas: ' + gasParts.join(', '));

        // Hemogram
        const hemo = buildGroup(HEMOGRAM_MAIN);
        if (hemo.length) {
            const extActual = [...HEMOGRAM_EXT, ...RARE_DIFF]
                .filter(k => data[k] && data[k].f)
                .map(fmt)
                .filter(Boolean);
            const line = 'Hemogram: ' + hemo.join(', ');
            output.push(extActual.length ? line + '; ' + extActual.join(', ') : line);
        }

        // Liver/Renal
        const lr = buildGroup(LIVER_RENAL);
        if (lr.length) output.push('Liver/Renal: ' + lr.join(', '));

        // Electrolytes
        const el = buildGroup(ELECTROLYTES);
        if (el.length) output.push('Electrolytes: ' + el.join(', '));

        // Others + unknowns
        const ot = buildGroup(OTHERS);
        const unknowns = Object.keys(data)
            .filter(k => !ALL_KNOWN.includes(k) && !IGNORE.includes(k))
            .map(fmt)
            .filter(Boolean);
        const allOthers = [...ot, ...unknowns];
        if (allOthers.length) output.push('Others: ' + allOthers.join(', '));

        // Coagulation
        const coag = buildGroup(COAG);
        if (coag.length) output.push('Coagulation: ' + coag.join(', '));

        // Urine
        const abnUrine = urineItems
            .filter(u => URINE_ALWAYS_SHOW.includes(u.name) || isUrineAbnormal(u.val))
            .filter(u => {
                if (URINE_ALWAYS_SHOW.includes(u.name)) return true;
                if (u.val === '-' || u.val.startsWith('≦') || u.val.startsWith('≤') || u.val.toLowerCase().startsWith('normal')) return false;
                return true;
            })
            .map(u => u.name + ' ' + displayUrineVal(u.val));
        if (abnUrine.length) output.push('Urine: ' + abnUrine.join(', '));

        // Culture
        if (cultureItems.length) output.push('Culture:\n' + cultureItems.join('\n'));

        return output.length ? output.join('\n') : null;
    }

    // ====== 綠單版 DOM 讀取 ======

    const GREEN_SECTION_MAP = {
        'Complete Blood Cell Count': 'CBC',
        'Blood Biochemistry': 'Biochemistry',
        'General BioChemistry': 'Biochemistry',
        'Coagulation Profile': 'Coagulation',
        'Blood Gas': 'Gas',
        'Urine examination': 'Urine',
        'Stool examination': 'Stool',
        'Punctate examination': 'Punctate',
    };

    function readGreenSheetView(view) {
        const fieldsets = document.querySelectorAll('fieldset');
        if (!fieldsets.length) return null;

        const dates = [];
        const data = {};
        const specialGroups = {};
        const groupOrder = [];
        let datesCollected = false;

        fieldsets.forEach(fs => {
            const legend = fs.querySelector('legend');
            if (!legend) return;
            const legendText = legend.textContent.trim();

            let sectionType = null;
            let specialName = null;
            for (const [keyword, type] of Object.entries(GREEN_SECTION_MAP)) {
                if (legendText.indexOf(keyword) > -1) {
                    sectionType = type;
                    if (['Urine', 'Stool'].includes(type)) {
                        specialName = type;
                    } else if (type === 'Punctate') {
                        const pm = legendText.match(/Punctate examination\s+(.*)/);
                        specialName = pm ? pm[1].trim() : 'Punctate';
                        if (/C\.\s*S\.\s*F\.|\bCSF\b/i.test(specialName)) specialName = 'CSF';
                    }
                    break;
                }
            }
            if (!sectionType) sectionType = 'Other';

            const tables = fs.querySelectorAll('table');
            tables.forEach(table => {
                const rows = table.querySelectorAll('tr');
                if (rows.length < 2) return;

                const headerCells = rows[0].querySelectorAll('td, th');
                if (headerCells.length < 2) return;

                const sectionDates = [];
                for (let j = 1; j < headerCells.length; j++) {
                    const txt = headerCells[j].textContent.trim();
                    const dm = txt.match(/\d{4}\/(\d{2})\/(\d{2})/);
                    sectionDates.push(dm ? dm[1] + '/' + dm[2] : '');
                }

                const isSpecial = specialName !== null;
                if (isSpecial) {
                    if (!specialGroups[specialName]) {
                        specialGroups[specialName] = { dates: sectionDates, data: {} };
                        groupOrder.push(specialName);
                    }
                } else if (!datesCollected) {
                    for (const d of sectionDates) dates.push(d);
                    datesCollected = true;
                }

                const targetData = isSpecial ? specialGroups[specialName].data : data;
                const targetDates = isSpecial ? specialGroups[specialName].dates : dates;

                for (let i = 1; i < rows.length; i++) {
                    const cells = rows[i].querySelectorAll('td, th');
                    if (cells.length < 2) continue;

                    const rawName = (cells[0].textContent || '').trim();
                    if (!rawName) continue;

                    if (/^\d{2}:\d{2}/.test(rawName)) continue;
                    if (SKIP_KEYWORDS.some(kw => rawName.indexOf(kw) > -1)) continue;

                    const cleanName = parseGreenItemName(rawName);
                    if (IGNORE.includes(cleanName)) continue;

                    if (isSpecial && specialName === 'Urine') {
                        const uName = URINE_NAME_MAP[rawName] || URINE_NAME_MAP[cleanName] || null;
                        if (!uName) continue;
                        const vals = [];
                        for (let j = 1; j < cells.length && j <= targetDates.length; j++) {
                            vals.push(cleanGreenValue(cells[j].textContent.trim()));
                        }
                        while (vals.length < targetDates.length) vals.push('');
                        if (!targetData[uName]) {
                            targetData[uName] = vals;
                        } else {
                            for (let j = 0; j < targetDates.length; j++) {
                                if (!targetData[uName][j] && vals[j]) targetData[uName][j] = vals[j];
                            }
                        }
                        continue;
                    }

                    const nm = normalizeName(rawName);
                    if (nm === '__SKIP__') continue;

                    const isG2 = RARE_DIFF.includes(nm);

                    const vals = [];
                    for (let j = 1; j < cells.length && j <= targetDates.length; j++) {
                        vals.push(cleanGreenValue(cells[j].textContent.trim()));
                    }
                    while (vals.length < targetDates.length) vals.push('');

                    if (isG2) {
                        const hasNonZero = vals.some(v => v && parseFloat(v) !== 0);
                        if (!hasNonZero) continue;
                    }

                    if (!targetData[nm]) {
                        targetData[nm] = vals;
                    } else {
                        for (let j = 0; j < targetDates.length; j++) {
                            if (!targetData[nm][j] && vals[j]) targetData[nm][j] = vals[j];
                        }
                    }
                }
            });
        });

        if (!dates.length && !Object.keys(specialGroups).length) return null;

        return formatTrend(dates, data, specialGroups, view);
    }

    // ====== 表格式趨勢格式化 ======

    const COL_GAP = 2;    // 欄與欄之間的空格數
    const MAX_COLS = 8;   // 單一表格最多幾欄，超過就再開一段表格（避免過寬）
    const EMPTY = '-';    // 該日無此項目時填的符號

    // 以顯示寬度計（中文/全形算 2 格），純 ASCII 算 1 格
    function dispWidth(s) {
        let w = 0;
        for (const ch of String(s)) {
            w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
        }
        return w;
    }

    function padCell(s, w) {
        return s + ' '.repeat(Math.max(0, w - dispWidth(s)));
    }

    // 07/21 → 0721
    function fmtDateLabel(d) {
        return String(d || '').replace(/\//g, '');
    }

    // colNames: 欄位名陣列；rowLabels: 每列的日期；cells[列][欄]: 值
    function buildTable(title, colNames, rowLabels, cells) {
        if (!colNames.length || !rowLabels.length) return null;

        const labelW = Math.max(...rowLabels.map(dispWidth));
        const blocks = [];

        for (let start = 0; start < colNames.length; start += MAX_COLS) {
            const idx = [];
            for (let c = start; c < Math.min(start + MAX_COLS, colNames.length); c++) idx.push(c);

            const colW = idx.map(c => Math.max(
                dispWidth(colNames[c]),
                ...cells.map(row => dispWidth(row[c]))
            ));

            const line = (label, get) => (
                padCell(label, labelW) +
                idx.map((c, k) => ' '.repeat(COL_GAP) + padCell(get(c), colW[k])).join('')
            ).replace(/\s+$/, '');

            const lines = [line('', c => colNames[c])];
            rowLabels.forEach((lb, r) => lines.push(line(lb, c => cells[r][c])));
            blocks.push(lines.join('\n'));
        }

        return (title ? title + '\n' : '') + blocks.join('\n\n');
    }

    function findActiveIdx(refDates, allKeys, dd2) {
        const activeIdx = [];
        for (let i = 0; i < refDates.length; i++) {
            for (const nm of allKeys) {
                if (dd2[nm] && dd2[nm][i]) { activeIdx.push(i); break; }
            }
        }
        return activeIdx;
    }

    // 值以 → 串接；中間有沒抽的日期就多一個箭頭表示間隔（段落模式用）
    function compactTrend(vals) {
        const filled = vals.filter(x => x);
        if (filled.length === 0) return null;
        if (filled.length === 1) return filled[0];
        const parts = [];
        for (let i = 0; i < vals.length; i++) {
            if (!vals[i]) continue;
            if (parts.length > 0) {
                const prevIdx = vals.lastIndexOf(parts[parts.length - 1].val, i - 1);
                const gap = i - prevIdx - 1;
                parts.push({ val: vals[i], arrow: '→'.repeat(gap + 1) });
            } else {
                parts.push({ val: vals[i], arrow: '' });
            }
        }
        return parts.map((p, i) => i === 0 ? p.val : p.arrow + p.val).join('');
    }

    // 兩種呈現共用同一套分組流程，差別只在「單一群組怎麼畫」：
    //   VIEW_TABLE → 日期為列、檢驗項目為欄的等寬對齊表格
    //   VIEW_TREND → 單行段落（原作者格式）
    // 分組清單與 #. 前綴都只寫一次。先前前綴由各群組自帶時，上游新加的 CSF
    // 分組就漏掉了前綴，集中處理可避免再發生。
    function formatTrend(dates, data, specialGroups, view) {
        const isTable = view !== VIEW_TREND;

        function isAbnormal(nm, vals) {
            const range = HEMO_EXT_RANGE[nm];
            if (!range) return true;
            for (const v of vals) {
                if (!v) continue;
                const n = parseFloat(v);
                if (isNaN(n)) continue;
                if (n < range[0] || n > range[1]) return true;
            }
            return false;
        }

        function fmtItem(nm, dd2) {
            const v = dd2[nm];
            if (!v) return null;
            if (HEMO_EXT_RANGE[nm] && !isAbnormal(nm, v)) return null;
            const trend = compactTrend(v);
            if (!trend) return null;
            let s = nm + ' ' + trend;
            if (ATTACH[nm]) {
                const ank = ATTACH[nm];
                const av = dd2[ank];
                if (av) {
                    const aTrend = compactTrend(av);
                    if (aTrend) s += ' (' + ank + ' ' + aTrend + ')';
                }
            }
            return s;
        }

        function buildGroup(title, keys, extKeys, dt, customDates) {
            const dd2 = dt || data;
            const refDates = customDates || dates;
            const allKeys = [...keys, ...(extKeys || [])];
            const activeIdx = findActiveIdx(refDates, allKeys, dd2);
            if (!activeIdx.length) return null;

            if (!isTable) {
                const filtered = {};
                for (const nm of allKeys) {
                    if (!dd2[nm]) continue;
                    filtered[nm] = activeIdx.map(i => dd2[nm][i] || '');
                }
                const items = [];
                for (const nm of allKeys) {
                    if (ATTACHED.has(nm)) continue;
                    const s = fmtItem(nm, filtered);
                    if (s) items.push(s);
                }
                if (!items.length) return null;
                const gd = activeIdx.map(i => refDates[i]);
                return title + ' [' + gd.join(', ') + ']: ' + items.join(', ');
            }

            // 欄位順序：附屬項目（Seg / MCV / eGFR）緊接在主項目後面
            const colKeys = [];
            for (const nm of allKeys) {
                if (ATTACHED.has(nm)) continue;
                if (!colKeys.includes(nm)) colKeys.push(nm);
                const an = ATTACH[nm];
                if (an && !colKeys.includes(an)) colKeys.push(an);
            }

            const cols = colKeys.filter(nm => {
                const v = dd2[nm];
                if (!v) return false;
                if (!activeIdx.some(i => v[i])) return false;
                // Eos./Baso./Band/Lym./Mono. 全在正常範圍就不列
                if (HEMO_EXT_RANGE[nm] && !isAbnormal(nm, activeIdx.map(i => v[i]))) return false;
                return true;
            });
            if (!cols.length) return null;

            const rowLabels = activeIdx.map(i => fmtDateLabel(refDates[i]));
            const cells = activeIdx.map(i => cols.map(nm => dd2[nm][i] || EMPTY));
            return buildTable(title, cols, rowLabels, cells);
        }

        function buildUrine(sg) {
            const dt = sg.data;
            const uDates = sg.dates || [];
            const cols = [];
            const colVals = [];
            for (const k of Object.keys(dt)) {
                const always = URINE_ALWAYS_SHOW.includes(k);
                const pts = dt[k].map(v => {
                    if (always) return v || EMPTY;
                    return (v && isUrineAbnormal(v)) ? displayUrineVal(v) : EMPTY;
                });
                if (pts.every(p => p === EMPTY)) continue;
                cols.push(k);
                colVals.push(pts);
            }
            if (!cols.length) return null;
            if (!isTable) {
                return 'Urine [' + uDates.join(', ') + ']: '
                    + cols.map((k, c) => k + ' ' + colVals[c].join('→')).join(', ');
            }
            const rowLabels = uDates.map(d => fmtDateLabel(d));
            const cells = uDates.map((d, i) => colVals.map(v => v[i] || EMPTY));
            return buildTable('Urine', cols, rowLabels, cells);
        }

        // 未特別處理的特殊分組（例如各種體液）走通用路徑
        function buildOther(sgName, sgData) {
            const sDates = sgData.dates || [];
            const cols = Object.keys(sgData.data).filter(k => sgData.data[k].some(v => v));
            if (!cols.length) return null;
            if (!isTable) {
                const items = [];
                for (const k of cols) {
                    const trend = compactTrend(sgData.data[k]);
                    if (trend) items.push(k + ' ' + trend);
                }
                return items.length ? sgName + ' [' + sDates.join(', ') + ']: ' + items.join(', ') : null;
            }
            const rowLabels = sDates.map(d => fmtDateLabel(d));
            const cells = sDates.map((d, i) => cols.map(k => sgData.data[k][i] || EMPTY));
            return buildTable(sgName, cols, rowLabels, cells);
        }

        const groups = [];
        const push = (g) => { if (g) groups.push(g); };

        push(buildGroup('Hemogram', HEMOGRAM_MAIN, [...HEMOGRAM_EXT, ...RARE_DIFF]));
        push(buildGroup('Liver/Renal', LIVER_RENAL));
        push(buildGroup('Electrolytes', ELECTROLYTES));
        const unknowns = Object.keys(data).filter(k => !ALL_KNOWN.includes(k) && !IGNORE.includes(k));
        push(buildGroup('Others', OTHERS, unknowns));
        push(buildGroup('Coagulation', COAG));

        if (specialGroups) {
            for (const [sgName, sgData] of Object.entries(specialGroups)) {
                if (sgName === 'Urine') {
                    push(buildUrine(sgData));
                } else if (sgName === 'CSF') {
                    const extra = Object.keys(sgData.data).filter(k => !CSF_ORDER.includes(k));
                    push(buildGroup('CSF', CSF_ORDER, extra, sgData.data, sgData.dates));
                } else if (sgName === 'Gas' || sgName === 'A gas' || sgName === 'V gas') {
                    const gasKeys = sgName === 'Gas' ? GAS : Object.keys(sgData.data);
                    push(buildGroup(sgName, gasKeys, [], sgData.data, sgData.dates));
                } else {
                    push(buildOther(sgName, sgData));
                }
            }
        }

        if (!groups.length) return null;

        // #. 前綴集中在這裡加，兩種模式都吃得到
        return groups.map(g => '#. ' + g).join(isTable ? '\n\n' : '\n');
    }

    // ====== 橫式版 DOM 讀取 ======

    function readHorizontalView(view) {
        const allTables = document.querySelectorAll('table');
        if (!allTables.length) return null;

        const dates = [];
        const data = {};
        const datesSet = new Set();

        allTables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            if (rows.length < 2) return;

            const headerCells = rows[0].querySelectorAll('td, th');
            if (headerCells.length < 2) return;

            const firstHeader = (headerCells[0].textContent || '').trim();
            if (!firstHeader.match(/\(\d+\/\d+\)/)) return;

            const itemNames = [];
            for (let j = 1; j < headerCells.length; j++) {
                itemNames.push((headerCells[j].textContent || '').trim());
            }

            for (let i = 1; i < rows.length; i++) {
                const cells = rows[i].querySelectorAll('td, th');
                if (cells.length < 2) continue;

                const dateCell = (cells[0].textContent || '').trim();
                const dm = dateCell.match(/\d{4}\/(\d{2})\/(\d{2})/);
                if (!dm) continue;
                const dateLabel = dm[1] + '/' + dm[2];

                if (!datesSet.has(dateLabel)) {
                    datesSet.add(dateLabel);
                    dates.push(dateLabel);
                }
                const dateIdx = dates.indexOf(dateLabel);

                for (let j = 1; j < cells.length && j <= itemNames.length; j++) {
                    const rawItemName = itemNames[j - 1];
                    const val = cleanGreenValue((cells[j].textContent || '').trim());
                    if (!val) continue;

                    const cleanName = parseGreenItemName(rawItemName);
                    if (IGNORE.includes(cleanName)) continue;

                    const nm = normalizeName(rawItemName);
                    if (nm === '__SKIP__') continue;

                    pushToStore(data, nm, dateIdx, val);
                }
            }
        });

        if (!dates.length) return null;

        padData(data, dates.length);

        return formatTrend(dates, data, null, view);
    }

    // ====== 偵測目前的樣式（清單/橫式/直式/綠單） ======

    function detectViewMode() {
        const MODE_MAP = { '清單': 'list', '橫式': 'horizontal', '直式': 'vertical', '綠單': 'green' };
        const radios = document.querySelectorAll('input[type="radio"][id*="LabRangeSlider1_rbn"]');
        for (const r of radios) {
            if (!r.checked) continue;
            const label = document.querySelector('label[for="' + r.id + '"]');
            const txt = label ? label.textContent.trim() : (r.nextSibling?.textContent?.trim() || '');
            for (const [key, mode] of Object.entries(MODE_MAP)) {
                if (txt.indexOf(key) > -1) return mode;
            }
        }
        return 'list';
    }

    // ====== 主流程 ======

    // 依目前 view mode 讀出整理後文字（無資料回 null）。worker 與 run() 共用。
    // view：VIEW_TABLE / VIEW_TREND，決定輸出格式；mode 是頁面本身的檢視樣式，兩者無關
    function computeReport(view) {
        const mode = detectViewMode();
        if (mode === 'green') return readGreenSheetView(view);
        if (mode === 'list') return readListView(view);
        if (mode === 'horizontal') return readHorizontalView(view);
        return '（直式模式不支援，請切換至清單、橫式或綠單）';
    }

    function run() {
        // 兩種格式各算一次存起來，之後切換只換 textContent，不必重讀 DOM
        const texts = {};
        texts[VIEW_TABLE] = computeReport(VIEW_TABLE);
        texts[VIEW_TREND] = computeReport(VIEW_TREND);
        if (!texts[VIEW_TABLE] && !texts[VIEW_TREND]) {
            alert('未偵測到檢驗項目');
            return;
        }
        showResult(texts);
    }

    // ====== 背景 worker：被 progress-note-data-helper 以 ntuh_token 開頁時 ======
    // 頁面預設清單、開頁即有資料 → 輪詢 computeReport 到非空 →
    // 寫 localStorage['ntuh_data_'+token]（與 data-helper 同信封）→ 關頁。
    function runReportWorker(token) {
        const KEY = 'ntuh_data_' + token;
        const done = (obj) => {
            try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch (e) { /* noop */ }
            setTimeout(() => window.close(), 150);
        };
        const t0 = performance.now();
        const iv = setInterval(() => {
            let res = null;
            try { res = computeReport(getViewPref()); } catch (e) { /* 尚未就緒 */ }
            if (res) { clearInterval(iv); done({ ok: true, text: res }); return; }
            // 防呆：頁面就緒（view-mode radio 出現）但 computeReport 仍無資料 → 回「無檢驗資料」，避免空等逾時。
            // 就緒後給 8s 寬限（背景分頁被瀏覽器節流時，DetailedSheet 表格 render 可能 >3s，太短會誤判空）；最終 20s 也回無資料訊息而非 error。
            const pageReady = !!document.querySelector('input[type="radio"][id*="LabRangeSlider1_rbn"]');
            if ((pageReady && performance.now() - t0 > 8000) || performance.now() - t0 > 20000) {
                clearInterval(iv);
                done({ ok: true, text: '(無檢驗資料)' });
            }
        }, 400);
    }

    // ====== UI ======

    // texts: { table: '...', trend: '...' }
    function showResult(texts) {
        const old = document.getElementById('lab-summary-box');
        if (old) old.remove();

        // 記住的模式若剛好沒算出東西，就退到另一種，免得開出空白框
        let view = getViewPref();
        if (!texts[view]) view = view === VIEW_TABLE ? VIEW_TREND : VIEW_TABLE;

        const box = document.createElement('div');
        box.id = 'lab-summary-box';
        box.style.cssText = [
            'position:fixed', 'bottom:20px', 'right:20px', 'z-index:999999',
            'background:#fff', 'border:2px solid #1a6fa8', 'border-radius:6px',
            'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'padding:0',
            'max-width:calc(100vw - 40px)',
            'font-family:sans-serif', 'font-size:13px', 'overflow:hidden',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'background:#1a6fa8;color:#fff;padding:7px 10px 7px 12px;font-weight:500;display:flex;align-items:center;justify-content:space-between;gap:12px;';
        const title = document.createElement('span');
        title.textContent = '檢驗整理';

        // 呈現方式切換：放標題列，下方工具列留給「複製」「關閉」等動作
        const seg = document.createElement('span');
        seg.style.cssText = 'display:flex;background:#15537f;border-radius:4px;padding:2px;';
        const segBtns = {};
        [[VIEW_TREND, '趨勢'], [VIEW_TABLE, '表格']].forEach(([v, label]) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'padding:3px 12px;border:none;border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit;background:transparent;color:#bcd7ee;';
            b.onclick = () => { if (texts[v]) apply(v); };
            segBtns[v] = b;
            seg.appendChild(b);
        });

        header.appendChild(title);
        header.appendChild(seg);

        const content = document.createElement('div');
        content.id = 'lab-summary-text';

        // 表格靠等寬字型 + white-space:pre 對齊；段落版要能自動換行，兩者不可共用
        function apply(v) {
            view = v;
            setViewPref(v);
            const isTable = v === VIEW_TABLE;
            box.style.width = isTable ? 'min(46vw,760px)' : 'min(34vw,520px)';
            content.style.cssText = [
                'padding:10px 14px', 'background:#f7f7f7',
                'max-height:70vh', 'overflow:auto',
                isTable ? 'font-family:Consolas,"Courier New",monospace' : 'font-family:sans-serif',
                isTable ? 'font-size:12.5px' : 'font-size:13px',
                isTable ? 'line-height:1.5' : 'line-height:1.9',
                isTable ? 'white-space:pre' : 'white-space:pre-wrap',
                'tab-size:4',
            ].join(';');
            content.textContent = texts[v];
            Object.entries(segBtns).forEach(([k, b]) => {
                const on = k === v;
                b.style.background = on ? '#fff' : 'transparent';
                b.style.color = on ? '#1a6fa8' : '#bcd7ee';
                b.disabled = !texts[k];
                b.style.cursor = texts[k] ? 'pointer' : 'not-allowed';
            });
        }

        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'padding:6px 12px 10px;background:#f7f7f7;display:flex;gap:8px;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '複製';
        copyBtn.style.cssText = 'padding:3px 14px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;font-size:12px;';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(texts[view]).then(
                () => { copyBtn.textContent = '已複製 ✓'; setTimeout(() => copyBtn.textContent = '複製', 1500); },
                () => { copyBtn.textContent = '複製失敗'; }
            );
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        closeBtn.style.cssText = 'padding:3px 14px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;font-size:12px;';
        closeBtn.onclick = () => box.remove();

        toolbar.appendChild(copyBtn);
        toolbar.appendChild(closeBtn);
        box.appendChild(header);
        box.appendChild(content);
        box.appendChild(toolbar);
        apply(view);
        document.body.appendChild(box);
    }

    function addButton() {
        if (!document.body) { setTimeout(addButton, 100); return; }

        const btn = document.createElement('button');
        btn.id = 'lab-summary-btn';
        btn.textContent = '整理檢驗';
        btn.style.cssText = [
            'position:fixed', 'bottom:45px', 'right:60px', 'z-index:999999',
            'padding:6px 14px', 'background:#e67e22', 'color:#fff',
            'border:none', 'border-radius:4px', 'cursor:pointer',
            'font-family:sans-serif', 'font-weight:bold', 'font-size:13px',
        ].join(';');
        btn.onclick = run;
        document.body.appendChild(btn);
    }

    // 進入點：被 data-helper 帶 ntuh_token 開頁 → worker；否則原本「整理檢驗」按鈕
    const _labToken = new URLSearchParams(location.search).get('ntuh_token');
    if (_labToken) {
        runReportWorker(_labToken);
    } else {
        addButton();
    }
})();
