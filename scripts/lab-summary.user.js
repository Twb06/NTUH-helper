// ==UserScript==
// @name         NTUH 檢驗整理
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0
// @description  在檢驗報告頁 (MedicalReportContent.aspx) 自動讀取 DOM，整理成結構化文字（支援清單版與綠單趨勢版）
// @match        *://*/*MedicalReportContent.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ====== 分類定義 ======

    const IGNORE = ['HCT', 'Hct', 'MCH', 'MCHC', 'RDW-CV', 'PS', 'RBC', 'Sugar'];

    const RARE_DIFF = ['Blast', 'Promyl.', 'Myelo.', 'Meta', 'Aty.Lym.', 'PlasmaCell', 'Normobl.'];

    const HEMOGRAM_MAIN = ['WBC', 'HB', 'PLT', 'Seg'];
    const HEMOGRAM_EXT = ['Eos.', 'Baso.', 'Band', 'Lym.', 'Mono.'];
    const LIVER_RENAL = ['ALT', 'AST', 'ALP', 'T-BIL', 'D-BIL', 'GGT', 'ALB', 'CRE', 'BUN', 'eGFR', 'Ammonia N', 'CK'];
    const ELECTROLYTES = ['Na', 'K', 'Mg', 'Ca', 'P', 'Cl'];
    const OTHERS = ['UA', 'CRP', 'hsCRP', 'Glucose', 'HbA1c', 'VIT. B12', 'Folic Acid', 'NT-pro BNP', 'BNP', 'LA', 'TP', 'LDH'];
    const GAS = ['pH', 'PCO2', 'PO2', 'HCO3', 'BE'];
    const COAG = ['PT', 'INR', 'aPTT', 'PTT', 'D-dimer', 'Fibrinogen'];
    const CULTURE_KEYS = ["Gram's", 'ID+DS', 'Anaerobic', 'ID C.', 'ID Campy.', 'VRE screening', 'CRE screening', 'MRSA screening'];
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
    ];

    // ====== 工具函式 ======

    function normalizeName(raw) {
        if (raw.indexOf('eGFR (MDRD)') > -1) return '__SKIP__';
        if (raw.indexOf('eGFR (CKD-EPI)') > -1) return 'eGFR';
        const clean = raw.replace(/\(.*?\)/g, '').trim();
        return NAME_MAP[clean] || clean;
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

    // ====== 清單版 DOM 讀取 ======

    function readListView() {
        const tables = document.querySelectorAll('table.DetailedSheet');
        if (!tables.length) return null;

        const dates = [];
        const trendData = {};
        const urineData = {};
        const urineDates = [];
        const cultureItems = [];
        const structuredCultures = [];
        let collectDate = '';
        let headerText = '';

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

            if (collectDate && !dates.includes(collectDate)) {
                dates.push(collectDate);
            }
            const dateIdx = dates.indexOf(collectDate);

            const rows = table.querySelectorAll('tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length < 2) return;

                const rawName = (cells[0].textContent || '').trim();
                const rawVal = (cells[1].textContent || '').trim();

                if (!rawName || !rawVal) return;

                if (/^\d{2}:\d{2}/.test(rawName)) return;

                const shouldSkip = SKIP_KEYWORDS.some(kw => rawName.indexOf(kw) > -1);
                if (shouldSkip) return;

                const cleanName = parseGreenItemName(rawName);
                if (IGNORE.includes(cleanName)) return;

                const val = cleanGreenValue(rawVal);

                const isCulture = CULTURE_KEYS.some(ck => rawName.indexOf(ck) > -1);
                if (isCulture) {
                    if (/Epithelial cell|PMN/i.test(val)) return;
                    if (/No bacteria visible/i.test(val)) return;
                    const isNeg = /no growth|no aerobic\s+pathogen|no anaerobic\s+pathogen/i.test(val);
                    const remark = cells[4] ? (cells[4].textContent || '').trim() : '';
                    let cResult = isNeg ? '-' : val;
                    if (!isNeg && remark) {
                        const rMap = {
                            'Carbapenem-resistant': 'CR', 'ESBL': 'ESBL',
                            'MRSA': 'MRSA', 'VRE': 'VRE', 'MDR': 'MDR',
                        };
                        for (const [pattern, abbr] of Object.entries(rMap)) {
                            if (remark.indexOf(pattern) > -1) { cResult += ' (' + abbr + ')'; break; }
                        }
                    }
                    if (/screening/i.test(rawName)) {
                        const scrType = rawName.match(/^(\S+)\s+screening/i);
                        const scrName = scrType ? scrType[1].toUpperCase() : rawName;
                        const scrRef = cells[3] ? (cells[3].textContent || '').trim() : '';
                        const scrNeg = scrRef && val.toLowerCase() === scrRef.toLowerCase();
                        const specM2 = headerText.match(/No:\S+\s+(.*?)\s*採檢/);
                        let scrLabel = 'Swab';
                        if (specM2) {
                            const raw2 = specM2[1].trim();
                            const words2 = raw2.split(/\s+/).filter(w => /^[A-Z]+$/.test(w));
                            if (words2.length) scrLabel = words2[words2.length - 1].charAt(0).toUpperCase() + words2[words2.length - 1].slice(1).toLowerCase();
                        }
                        structuredCultures.push({ date: collectDate, label: scrLabel, result: scrName + ' (' + (scrNeg ? '-' : '+') + ')' });
                    } else if (/ID\+DS Blood/i.test(rawName)) {
                        const srcM = headerText.match(/BLOOD\s+(\S+)\s+採檢/);
                        const src = srcM ? srcM[1].toLowerCase() : 'blood';
                        structuredCultures.push({ date: collectDate, label: 'B/C (' + src + ')', result: cResult });
                    } else if (/ID\+DS Urine/i.test(rawName)) {
                        const srcM = headerText.match(/URINE\s+(.*?)\s+採檢/);
                        let src = 'urine';
                        if (srcM) {
                            const s = srcM[1].toLowerCase();
                            if (s.indexOf('void') > -1) src = 'void';
                            else if (s.indexOf('cath') > -1) src = 'cath';
                            else src = s;
                        }
                        structuredCultures.push({ date: collectDate, label: 'U/C (' + src + ')', result: cResult });
                    } else if (/ID\+DS Sputum/i.test(rawName)) {
                        structuredCultures.push({ date: collectDate, label: 'Spu/C', result: cResult });
                    } else if (/ID\+DS|ID C\.|ID Campy\.|^Anaerobic/i.test(rawName)) {
                        const specM = headerText.match(/No:\S+\s+(.*?)\s*採檢/);
                        let specDesc = '';
                        if (specM) {
                            const raw = specM[1].trim();
                            const hasChinese = /[一-鿿]/.test(raw);
                            if (hasChinese) {
                                specDesc = raw.replace(/^[A-Z()\s\/]+/, '').trim() || raw;
                            } else {
                                const words = raw.split(/\s+/).filter(w => /^[A-Z]+$/.test(w));
                                const last = words.length ? words[words.length - 1] : raw.split(/\s+/)[0];
                                specDesc = last.charAt(0).toUpperCase() + last.slice(1).toLowerCase();
                            }
                        }
                        const label = specDesc ? specDesc + '/C' : 'Other/C';
                        structuredCultures.push({ date: collectDate, label: label, result: cResult });
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
                        if (!urineData[urineName]) urineData[urineName] = [];
                        while (urineData[urineName].length <= uDateIdx) urineData[urineName].push('');
                        if (!urineData[urineName][uDateIdx]) urineData[urineName][uDateIdx] = val;
                    }
                    return;
                }

                if (GAS.includes(rawName) || ['PH', 'PCO2', 'PO2', 'HCO3', 'BaseExcess'].includes(rawName)) {
                    const gasName = rawName === 'PH' ? 'pH'
                        : rawName === 'BaseExcess' ? 'BE'
                        : rawName;
                    if (!trendData[gasName]) trendData[gasName] = [];
                    while (trendData[gasName].length <= dateIdx) trendData[gasName].push('');
                    if (!trendData[gasName][dateIdx]) trendData[gasName][dateIdx] = val;
                    return;
                }

                const nm = normalizeName(rawName);
                if (nm === '__SKIP__') return;

                const isG2 = RARE_DIFF.includes(nm);
                if (isG2 && (parseFloat(val) === 0 || !val)) return;

                if (!trendData[nm]) trendData[nm] = [];
                while (trendData[nm].length <= dateIdx) trendData[nm].push('');
                if (!trendData[nm][dateIdx]) trendData[nm][dateIdx] = val;
            });
        });

        if (!dates.length) return null;

        for (const nm of Object.keys(trendData)) {
            while (trendData[nm].length < dates.length) trendData[nm].push('');
        }
        for (const nm of Object.keys(urineData)) {
            while (urineData[nm].length < urineDates.length) urineData[nm].push('');
        }

        const specialGroups = {};
        if (Object.keys(urineData).length) {
            specialGroups.Urine = { dates: urineDates, data: urineData };
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
        for (const g of cGroups) {
            if (!cByDate[g.date]) { cByDate[g.date] = []; cDateOrder.push(g.date); }
            const allNeg = g.results.every(r => r === '-');
            const display = allNeg ? '-' : g.results.filter(r => r !== '-').join('; ');
            cByDate[g.date].push(g.label + ': ' + display);
        }
        for (const dt of cDateOrder) {
            cultureItems.push('[' + dt + '] ' + cByDate[dt].join(' ; '));
        }

        let result = formatTrendParagraph(dates, trendData, Object.keys(specialGroups).length ? specialGroups : null);
        if (cultureItems.length) {
            result = (result || '') + (result ? '\n' : '') + '#. Culture:\n' + cultureItems.join('\n');
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
            const ext = [...HEMOGRAM_EXT, ...RARE_DIFF]
                .map(fmt)
                .filter(s => s && data[s.split(' ')[0]]?.f);
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

    // ====== 橫式版 DOM 讀取 ======
    // 橫式：項目名當欄頭（含單位），日期當列
    // 每個 section 有自己的小表格，如 CBC+PLT(1/2), Biochemistry(1/1) 等

    function readHorizontalView() {
        const allTables = document.querySelectorAll('table');
        if (!allTables.length) return null;

        const dates = [];
        const data = {};
        const specialGroups = {};
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
                const raw = (headerCells[j].textContent || '').trim();
                itemNames.push(raw);
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

                    if (!data[nm]) data[nm] = [];
                    while (data[nm].length <= dateIdx) data[nm].push('');
                    if (!data[nm][dateIdx]) data[nm][dateIdx] = val;
                }
            }
        });

        if (!dates.length) return null;

        for (const nm of Object.keys(data)) {
            while (data[nm].length < dates.length) data[nm].push('');
        }

        return formatTrend(dates, data, Object.keys(specialGroups).length ? specialGroups : null);
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

    function parseGreenItemName(raw) {
        const clean = raw.replace(/\(.*?\)/g, '').trim();
        return clean;
    }

    function cleanGreenValue(val) {
        return val.replace(/\(Manual\s*checked\)/i, '').replace(/\(Manual\)/i, '').trim();
    }

    function readGreenSheetView() {
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

                    const shouldSkip = SKIP_KEYWORDS.some(kw => rawName.indexOf(kw) > -1);
                    if (shouldSkip) continue;

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

        return formatTrendParagraph(dates, data, specialGroups);
    }

    // ====== 多日趨勢格式化 ======

    function formatTrend(dates, data, specialGroups) {
        function buildBlock(title, keys, extKeys, dts, dt) {
            const dd = dts || dates;
            const dd2 = dt || data;
            const allKeys = extKeys ? keys.concat(extKeys) : keys;

            const activeIdx = [];
            for (let j = 0; j < dd.length; j++) {
                let hasAny = false;
                for (const k of allKeys) {
                    if (dd2[k] && dd2[k][j]) hasAny = true;
                }
                if (hasAny) activeIdx.push(j);
            }
            if (!activeIdx.length) return null;

            const rows = [];
            for (const nm of allKeys) {
                const v = dd2[nm];
                if (!v) continue;
                if (ATTACHED.has(nm)) continue;

                if (extKeys && extKeys.includes(nm)) {
                    let hasVal = false;
                    for (const idx of activeIdx) {
                        if (v[idx]) hasVal = true;
                    }
                    if (!hasVal) continue;
                }

                const pts = activeIdx.map(idx => v[idx] || '-');
                let row = '  ' + nm + ': ' + pts.join(' → ');

                if (ATTACH[nm]) {
                    const ank = ATTACH[nm];
                    const av = dd2[ank];
                    if (av) {
                        const apts = activeIdx.map(idx => av[idx] || '-');
                        row += ' (' + ank + ': ' + apts.join(' → ') + ')';
                    }
                }
                rows.push(row);
            }
            if (!rows.length) return null;

            const dateLabels = activeIdx.map(idx => dd[idx]);
            return title + ': [' + dateLabels.join(', ') + ']\n' + rows.join('\n');
        }

        function buildUrine(sg) {
            const dd = sg.dates;
            const dt = sg.data;
            if (!dd.length) return null;

            const activeIdx = [];
            for (let j = 0; j < dd.length; j++) {
                let hasAny = false;
                for (const k of Object.keys(dt)) {
                    if (dt[k] && dt[k][j]) hasAny = true;
                }
                if (hasAny) activeIdx.push(j);
            }
            if (!activeIdx.length) return null;

            const rows = [];
            for (const k of Object.keys(dt)) {
                const always = URINE_ALWAYS_SHOW.includes(k);
                const vals = dt[k];
                const pts = [];
                let hasAny = false;
                for (const idx of activeIdx) {
                    const v = vals[idx] || '';
                    if (always) {
                        pts.push(v || '-');
                        if (v) hasAny = true;
                    } else {
                        if (v && isUrineAbnormal(v)) {
                            pts.push(displayUrineVal(v));
                            hasAny = true;
                        } else {
                            pts.push('-');
                        }
                    }
                }
                if (!hasAny) continue;
                if (pts.every(p => p === '-')) continue;
                rows.push('  ' + k + ': ' + pts.join(' → '));
            }
            if (!rows.length) return null;

            const dateLabels = activeIdx.map(idx => dd[idx]);
            return 'Urine: [' + dateLabels.join(', ') + ']\n' + rows.join('\n');
        }

        function buildSpecial(name, sg) {
            const dd = sg.dates;
            const dt = sg.data;
            if (!dd.length) return null;

            const activeIdx = [];
            for (let j = 0; j < dd.length; j++) {
                let hasAny = false;
                for (const k of Object.keys(dt)) {
                    if (dt[k] && dt[k][j]) hasAny = true;
                }
                if (hasAny) activeIdx.push(j);
            }
            if (!activeIdx.length) return null;

            const rows = [];
            for (const k of Object.keys(dt)) {
                const vals = dt[k];
                const pts = activeIdx.map(idx => vals[idx] || '-');
                rows.push('  ' + k + ': ' + pts.join(' → '));
            }
            if (!rows.length) return null;

            const dateLabels = activeIdx.map(idx => dd[idx]);
            return name + ': [' + dateLabels.join(', ') + ']\n' + rows.join('\n');
        }

        const output = [];

        const hemo = buildBlock('Hemogram', HEMOGRAM_MAIN, [...HEMOGRAM_EXT, ...RARE_DIFF]);
        if (hemo) output.push(hemo);

        const lr = buildBlock('Liver/Renal', LIVER_RENAL);
        if (lr) output.push(lr);

        const el = buildBlock('Electrolytes', ELECTROLYTES);
        if (el) output.push(el);

        const unknowns = Object.keys(data).filter(k => !ALL_KNOWN.includes(k) && !IGNORE.includes(k));
        const ot = buildBlock('Others', OTHERS, unknowns);
        if (ot) output.push(ot);

        const coag = buildBlock('Coagulation', COAG);
        if (coag) output.push(coag);

        if (specialGroups) {
            for (const [sgName, sgData] of Object.entries(specialGroups)) {
                if (sgName === 'Urine') {
                    const u = buildUrine(sgData);
                    if (u) output.push(u);
                } else {
                    const sp = buildSpecial(sgName, sgData);
                    if (sp) output.push(sp);
                }
            }
        }

        const gas = buildBlock('Gas', GAS);
        if (gas) output.push(gas);

        return output.length ? output.join('\n\n') : null;
    }

    // ====== 段落式趨勢格式化（清單風格 + → 趨勢） ======

    function formatTrendParagraph(dates, data, specialGroups) {
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

        function buildGroup(title, keys, extKeys, dt) {
            const dd2 = dt || data;
            const allKeys = [...keys, ...(extKeys || [])];
            const activeIdx = [];
            for (let i = 0; i < dates.length; i++) {
                for (const nm of allKeys) {
                    if (dd2[nm] && dd2[nm][i]) { activeIdx.push(i); break; }
                }
            }
            if (!activeIdx.length) return null;

            const filtered = {};
            for (const nm of allKeys) {
                if (!dd2[nm]) continue;
                filtered[nm] = activeIdx.map(i => dd2[nm][i] || '');
            }

            const items = [];
            for (const nm of keys) {
                if (ATTACHED.has(nm)) continue;
                const s = fmtItem(nm, filtered);
                if (s) items.push(s);
            }
            if (extKeys) {
                for (const nm of extKeys) {
                    if (ATTACHED.has(nm)) continue;
                    const s = fmtItem(nm, filtered);
                    if (s) items.push(s);
                }
            }
            if (!items.length) return null;
            const gd = activeIdx.map(i => dates[i]);
            return title + ' [' + gd.join(', ') + ']: ' + items.join(', ');
        }

        function buildUrinePara(sg) {
            const dt = sg.data;
            const items = [];
            for (const k of Object.keys(dt)) {
                const always = URINE_ALWAYS_SHOW.includes(k);
                const vals = dt[k];
                const pts = vals.map(v => {
                    if (always) return v || '-';
                    return (v && isUrineAbnormal(v)) ? displayUrineVal(v) : '-';
                });
                if (pts.every(p => p === '-')) continue;
                items.push(k + ' ' + pts.join('→'));
            }
            if (!items.length) return null;
            const ud = sg.dates || [];
            return 'Urine [' + ud.join(', ') + ']: ' + items.join(', ');
        }

        const groups = [];

        const hemo = buildGroup('Hemogram', HEMOGRAM_MAIN, [...HEMOGRAM_EXT, ...RARE_DIFF]);
        if (hemo) groups.push(hemo);

        const lr = buildGroup('Liver/Renal', LIVER_RENAL);
        if (lr) groups.push(lr);

        const el = buildGroup('Electrolytes', ELECTROLYTES);
        if (el) groups.push(el);

        const unknowns = Object.keys(data).filter(k => !ALL_KNOWN.includes(k) && !IGNORE.includes(k));
        const ot = buildGroup('Others', OTHERS, unknowns);
        if (ot) groups.push(ot);

        const coag = buildGroup('Coagulation', COAG);
        if (coag) groups.push(coag);

        if (specialGroups) {
            for (const [sgName, sgData] of Object.entries(specialGroups)) {
                if (sgName === 'Urine') {
                    const u = buildUrinePara(sgData);
                    if (u) groups.push(u);
                } else {
                    const items = [];
                    for (const [k, vals] of Object.entries(sgData.data)) {
                        const trend = compactTrend(vals);
                        if (trend) items.push(k + ' ' + trend);
                    }
                    if (items.length) groups.push(sgName + ' [' + sgData.dates.join(', ') + ']: ' + items.join(', '));
                }
            }
        }

        const gas = buildGroup('Gas', GAS);
        if (gas) groups.push(gas);

        if (!groups.length) return null;

        const prefixed = groups.map(g => '#. ' + g);
        return prefixed.join('\n');
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

    function run() {
        const mode = detectViewMode();
        let result = null;

        if (mode === 'green') {
            result = readGreenSheetView();
        } else if (mode === 'list') {
            result = readListView();
        } else if (mode === 'horizontal') {
            result = readHorizontalView();
        } else {
            result = '（直式模式不支援，請切換至清單、橫式或綠單）';
        }

        if (!result) {
            alert('未偵測到檢驗項目');
            return;
        }

        showResult(result);
    }

    // ====== UI ======

    function showResult(text) {
        const old = document.getElementById('lab-summary-box');
        if (old) old.remove();

        const box = document.createElement('div');
        box.id = 'lab-summary-box';
        box.style.cssText = [
            'position:fixed', 'top:80px', 'right:20px', 'z-index:999999',
            'background:#fff', 'border:2px solid #1a6fa8', 'border-radius:6px',
            'box-shadow:0 4px 16px rgba(0,0,0,.25)', 'padding:0', 'width:500px',
            'font-family:sans-serif', 'font-size:13px', 'overflow:hidden',
        ].join(';');

        const header = document.createElement('div');
        header.style.cssText = 'background:#1a6fa8;color:#fff;padding:8px 12px;font-weight:500;';
        header.textContent = '檢驗整理';

        const content = document.createElement('div');
        content.id = 'lab-summary-text';
        content.style.cssText = 'padding:10px 14px;background:#f7f7f7;line-height:1.9;white-space:pre-wrap;max-height:70vh;overflow-y:auto;';
        content.textContent = text;

        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'padding:6px 12px 10px;background:#f7f7f7;display:flex;gap:8px;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '複製';
        copyBtn.style.cssText = 'padding:3px 14px;border:1px solid #ccc;border-radius:4px;cursor:pointer;background:#fff;font-size:12px;';
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(content.innerText).then(
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

    addButton();
})();
