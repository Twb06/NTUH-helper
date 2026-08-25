// ==UserScript==
// @name         NTUH 檢驗整理
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.5.0
// @description  在檢驗報告頁 (MedicalReportContent.aspx) 自動讀取 DOM，整理成「趨勢」段落或「對齊表格」兩種呈現，可於結果框標題列切換並記住選擇（支援清單版與綠單趨勢版）。依檢體種類分流，血液/尿液/糞便/腹水/血氣各自成組，項目名一律用縮寫
// @match        *://*.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/MedicalReportContent.aspx*
// @match        *://*.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/MobileReportPage.aspx*
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
    const OUTPUT_KEY = 'ntuh_lab_output_spacing';
    const OUTPUT_COMPACT = 'compact';
    const OUTPUT_SPACIOUS = 'spacious';

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
    function getOutputPref() {
        try {
            return localStorage.getItem(OUTPUT_KEY) === OUTPUT_COMPACT ? OUTPUT_COMPACT : OUTPUT_SPACIOUS;
        } catch (e) {
            return OUTPUT_SPACIOUS;
        }
    }
    function setOutputPref(v) {
        try { localStorage.setItem(OUTPUT_KEY, v); } catch (e) { /* noop */ }
    }

    // 只在血液檢體套用（尿液 / 體液的同名項目走各自的對應表）
    const IGNORE = ['HCT', 'Hct', 'MCH', 'MCHC', 'RDW-CV', 'PS', 'RBC', 'Sugar',
        'Auer body', 'Others', 'Reference Comment'];

    const RARE_DIFF = ['Blast', 'Promyl.', 'Myelo.', 'Meta', 'Aty.Lym.', 'PlasmaCell', 'Normobl.'];

    // Hemogram 與感染指標一起看：WBC(Seg) Hb(MCV) Plt CRP PCT
    const HEMOGRAM_MAIN = ['WBC', 'Hb', 'Plt', 'CRP', 'PCT'];
    // 差別計數（Seg 已附在 WBC 後面，這裡放其餘的）獨立成一段
    const HEMOGRAM_EXT = ['Band', 'Eos.', 'Baso.', 'Lym.', 'Mono.'];
    const LIVER = ['ALT', 'AST', 'ALP', 'T-Bil', 'D-Bil', 'GGT', 'Alb', 'TP', 'NH3'];
    const RENAL = ['BUN', 'CRE', 'eGFR', 'UA'];
    const ELECTROLYTES = ['Na', 'K', 'Cl', 'Ca', 'P', 'Mg'];
    const CARDIAC = ['CK', 'CK-MB', 'TnT', 'NT-proBNP', 'BNP'];
    const LIPID = ['T-CHO', 'TG', 'LDL-C', 'HDL-C'];
    const TUMOR_MARKER = ['CgA', 'CEA', 'CA19-9', 'AFP', 'PSA', 'CA-125', 'CA15-3', 'SCC', 'NSE'];
    const SEROLOGY = ['HBsAg', 'Anti-HBs', 'Anti-HCV', 'HIV', 'VDRL'];
    const THYROID = ['TSH', 'Free T4', 'T4', 'T3'];
    const OTHERS = ['Glucose', 'HbA1c', 'LDH', 'AMY', 'Lip', 'VIT. B12', 'Folic Acid', 'LA'];
    const GAS = ['pH', 'PCO2', 'PO2', 'HCO3', 'BE'];
    // VBG 的 PO2 沒有臨床意義，只有 ABG 才看；LA 併進氣體分析一起呈現
    const VGAS_ORDER = ['pH', 'PCO2', 'HCO3', 'BE', 'LA'];
    const AGAS_ORDER = ['pH', 'PCO2', 'PO2', 'HCO3', 'BE', 'SO2', 'FiO2', 'LA'];
    const COAG = ['PT', 'INR', 'aPTT', 'PTT', 'D-dimer', 'Fibrinogen'];
    const STOOL_ORDER = ['WBC', 'RBC', 'OB'];

    // 只會出現在血氣報告的項目名（血液生化單不會有這些）
    const GAS_ITEM_NAMES = ['PH', 'pH', 'PCO2', 'pCO2', 'PO2', 'pO2',
        'HCO3', 'HCO3-', 'BaseExcess', 'Base Excess', 'BE'];

    // 血氧分析：動脈（機器直讀）與靜脈（生化機）項目名寫法不同
    const GAS_NAME_MAP = {
        'PH': 'pH', 'pH': 'pH', 'pCO2': 'PCO2', 'PCO2': 'PCO2',
        'pO2': 'PO2', 'PO2': 'PO2', 'HCO3-': 'HCO3', 'HCO3': 'HCO3',
        'Base Excess': 'BE', 'BaseExcess': 'BE', 'BE': 'BE',
        'LacticAcid': 'LA', 'Lactate': 'LA',
        'Cl-': 'Cl', 'K+': 'K', 'Na+': 'Na', 'Free Ca2+': 'iCa',
        'Hb': 'Hb', 'FiO2': 'FiO2', 'SO2': 'SO2', 'Glucose': 'Glucose',
    };
    const FLUID_ORDER = ['TNC', 'RBC', 'Neu%', 'Lym%', 'Meso%', 'Eos%', 'Alb', 'TP', 'Glucose', 'LDH', 'AMY', 'Adequacy', 'Cytology'];

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

    // 血液分組的唯一來源：formatTrend 依這張表產生段落，
    // 「有沒有被任何一組收走」也依這張表判斷，兩邊不會再各寫一份而走鐘。
    const BLOOD_GROUPS = [
        ['Hemogram', HEMOGRAM_MAIN, []],
        ['DC', HEMOGRAM_EXT, RARE_DIFF],
        ['Liver', LIVER, []],
        ['Renal', RENAL, []],
        ['Electrolytes', ELECTROLYTES, []],
        ['Cardiac', CARDIAC, []],
        ['Coagulation', COAG, []],
        ['Lipid', LIPID, []],
        ['Tumor marker', TUMOR_MARKER, []],
        ['Thyroid', THYROID, []],
        ['Serology', SEROLOGY, []],
    ];

    const ALL_KNOWN = [
        ...HEMOGRAM_MAIN, ...HEMOGRAM_EXT, ...RARE_DIFF,
        ...LIVER, ...RENAL, ...ELECTROLYTES, ...CARDIAC,
        ...LIPID, ...TUMOR_MARKER, ...SEROLOGY, ...THYROID, ...OTHERS,
        ...GAS, ...COAG, 'MCV', 'Seg', 'eGFR',
    ];

    const ATTACH = { WBC: 'Seg', Hb: 'MCV', CRE: 'eGFR' };
    const ATTACHED = new Set(['Seg', 'MCV', 'eGFR']);

    const HEMO_EXT_RANGE = {
        'Eos.': [0, 8], 'Baso.': [0, 2], 'Band': [0, 5],
        'Lym.': [20, 45], 'Mono.': [2, 10],
    };

    const URINE_ALWAYS_SHOW = ['RBC', 'WBC', 'Bac', 'U-Cre', 'U-UN', 'U-Na'];

    // CSF：顯示順序（未列到的項目接在後面）
    const CSF_ORDER = ['WBC', 'L/N', 'RBC', 'TP', 'Glucose', 'Lactate', 'LDH', 'ADA'];
    const CSF_NAME_MAP = {
        'WBC': 'WBC', 'RBC': 'RBC', 'L/N': 'L/N',
        'TP(CSF)': 'TP', 'Glucose(CSF)': 'Glucose',
        'Lactate(CSF)': 'Lactate', 'LDH(CSF)': 'LDH', 'ADA(CSF)': 'ADA',
    };

    // 同一個檢驗在不同科室（HE / LH / WB / RL…）名稱不同，一律正規化成同一個顯示名，
    // 名稱直接用縮寫，表格才不會被撐寬。
    const NAME_MAP = {
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

    const URINE_NAME_MAP = {
        'Protein(Dipstick)': 'Protein', 'Protein(C)': 'Protein',
        'Glu.(Dipstick)': 'Glucose', 'Glu.(C)': 'Glucose',
        'Ketone(Dipstick)': 'Ketone', 'Ketones(C)': 'Ketone',
        'O.B.(Dipstick)': 'OB', 'O.B.(C)': 'OB',
        'Urobil.(Dipstick)': 'Urobilinogen', 'Urobil.(C)': 'Urobilinogen',
        'Bil.(Dipstick)': 'Bilirubin', 'Bil.(C)': 'Bilirubin',
        'Nitrite(Dipstick)': 'Nitrite', 'Nitrite(C)': 'Nitrite',
        'WBC esterase (Dipstick)': 'Esterase', 'Leukocyte esterase': 'Esterase',
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

    // 舊式尿液鏡檢（M6 科室）：項目名沒有 (Dipstick)/(Sediment) 後綴，
    // 且 Protein / Glucose / Blood / Bacteria 這些名字和血液項目撞名，
    // 所以只在「檢體是尿液」時才套用這張表。
    const URINE_PLAIN_MAP = {
        'WBC/HPF': 'WBC', 'RBC/HPF': 'RBC', 'Epi Cell/HPF': 'Epi',
        'Bacteria': 'Bac', 'RBC(morphology)': 'RBC morph',
        'Urobilinogen': 'Urobilinogen', 'PH': 'pH', 'pH': 'pH',
        'Ketone': 'Ketone', 'Others': 'Others', 'Blood': 'OB',
        'Bilirubin': 'Bil', 'Crystals': 'Crystal', 'Crystal': 'Crystal',
        'Protein': 'Protein', 'Glucose': 'Glucose', 'Cast': 'Cast',
        'Nitrite': 'Nitrite', 'Sp. Gr.': 'Sp.Gr.',
    };

    // 尿液生化（算 FeNa / FeUrea 用），跟血中同名，一樣只在尿液檢體套用
    const URINE_CHEM_MAP = {
        'CRE(U)': 'U-Cre', 'UN(U)': 'U-UN', 'Na(U)': 'U-Na',
        'K(U)': 'U-K', 'Cl(U)': 'U-Cl', 'Osm(U)': 'U-Osm',
        'TP(U)': 'U-TP', 'Alb(U)': 'U-Alb',
    };

    const STOOL_NAME_MAP = {
        'Stool WBC': 'WBC', 'Stool RBC': 'RBC', 'Occult Blood': 'OB',
        'Occult blood': 'OB',
    };

    // 腹水 / 胸水 / 其他體液
    const FLUID_NAME_MAP = {
        'Total nucleated cells': 'TNC', 'RBC count': 'RBC',
        'Sediment-Neu': 'Neu%', 'Sediment-Lym': 'Lym%',
        'Sediment-Mesothelial cell & Histiocyte': 'Meso%',
        'Sediment-Eosin': 'Eos%', 'Sediment-Note': '__SKIP__',
        'ALB': 'Alb', 'Alb': 'Alb', 'TP': 'TP', 'Glucose': 'Glucose',
        'LDH': 'LDH', 'AMY': 'AMY', 'Amylase': 'AMY',
        'Specimen Adequacy': 'Adequacy',
    };

    // 文字結果的縮寫（不只項目名，值也要縮）
    const VALUE_ABBR = [
        [/^Negative$/i, 'Neg'],
        [/^Positive$/i, 'Pos'],
        [/^Non-Reactive$/i, 'NR'],
        [/^Reactive$/i, 'R'],
        [/^Not Detected$/i, 'Neg'],
        [/^Not found$/i, 'Neg'],
        [/^Satisfactory for evaluation$/i, 'Satisfactory'],
        [/^Negative for malignant cells$/i, 'Neg for malignancy'],
        [/^Suspicious for malignant cells$/i, 'Suspicious'],
        [/^Positive for malignant cells$/i, 'Malignant cells (+)'],
        [/^Normal$/i, 'Nl'],
        [/Yeast-like organism/i, 'Yeast'],
        [/Gram pos\. coccus/i, 'GPC'],
        [/Gram neg\. bacill(i|us)/i, 'GNB'],
        [/Gram pos\. bacill(i|us)/i, 'GPB'],
        [/Gram neg\. coccus/i, 'GNC'],
        [/Renal tubular epithelium/i, 'RTE'],
        [/Squamous epithelial cells?/i, 'Squam. epi'],
    ];

    function abbrValue(val) {
        if (!val) return val;
        let v = val;
        for (const [re, short] of VALUE_ABBR) {
            if (re.test(v)) v = v.replace(re, short);
        }
        return v;
    }

    // 檢體種類：決定這張表的每一列要走哪一組規則。
    // 舊版只看項目名，所以尿液的 PH 會被當成血氧分析的 pH、尿液 CRE(U) 會蓋掉血中 CRE。
    function specimenClass(headerText) {
        // 表頭的分隔可能是 &nbsp; 或連續空白，先壓成單一空格再比對，
        // 不然 /Venous Blood/ 這種字面空格會比不到
        const h = (headerText || '').replace(/\s+/g, ' ');
        if (/Arterial\s+Blood/i.test(h)) return 'agas';
        if (/Venous\s+Blood|Capillary\s+Blood/i.test(h)) return 'vgas';
        if (/C\.\s*S\.\s*F\.|\bCSF\b/i.test(h)) return 'csf';
        if (/URINE/i.test(h)) return 'urine';
        if (/STOOL|FECES/i.test(h)) return 'stool';
        if (/ASCITES|PLEURAL|PERICARDIAL|PERITONEAL|SYNOVIAL|EFFUSION|BILE|PUS|DRAINAGE/i.test(h)) return 'fluid';
        return 'blood';
    }

    // 體液的分組標題直接用檢體名（ASCITES → Ascites）
    function fluidGroupName(headerText) {
        const m = (headerText || '').replace(/\s+/g, ' ')
            .match(/(ASCITES|PLEURAL EFFUSION|PLEURAL|PERICARDIAL|PERITONEAL|SYNOVIAL|BILE|PUS|DRAINAGE)/i);
        if (!m) return 'Body fluid';
        const raw = m[1].toLowerCase();
        return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

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
        // WB 科室寫成 eGFR(MDRD)（沒空格），舊版只比對有空格的字串，
        // 結果 MDRD 值先卡位、CKD-EPI 就被丟掉了
        if (/eGFR\s*\(MDRD\)/i.test(raw)) return '__SKIP__';
        if (/eGFR\s*\(CKD-EPI\)/i.test(raw)) return 'eGFR';
        const clean = raw.replace(/\(.*?\)/g, '').trim();
        return NAME_MAP[raw] || NAME_MAP[clean] || clean;
    }

    function parseGreenItemName(raw) {
        return raw.replace(/\(.*?\)/g, '').trim();
    }

    function cleanGreenValue(val) {
        // 值裡面的換行/連續空白（例如 Ca 1.54 跟 (危) 分屬不同節點）壓成單一空格，
        // 不然整欄會被撐開
        return val.replace(/\(Manual\s*checked\)/i, '').replace(/\(Manual\)/i, '')
            .replace(/\s+/g, ' ').trim();
    }

    function isUrineAbnormal(val) {
        if (!val || val === '-') return false;
        if (val.startsWith('≦') || val.startsWith('≤')) return false;
        if (/^(normal|negative|neg|nil|none|0)$/i.test(val.trim())) return false;
        if (val.toLowerCase().startsWith('normal')) return false;
        if (/\([0-9]*\+*\)/.test(val.replace(/\s+/g, ''))) return true;   // (2+) / ( +++ )
        if (/^[0-9]*\+$/.test(val)) return true;
        if (/^\++$/.test(val.replace(/[\s()]/g, ''))) return true;
        if (val.startsWith('≧') || val.startsWith('>=')) return true;
        if (/numerous|many|packed|gross/i.test(val)) return true;
        // 「Gr(3-5)」「Yeast(2+)」「Renal tubular epithelium(+)」等文字描述
        if (/[A-Za-z]/.test(val) && !/^(neg|nl|nr)$/i.test(val)) return true;
        return false;
    }

    // ( +++ ) → 3+；Protein 100 (2+) → 2+
    function displayUrineVal(val) {
        const compact = val.replace(/\s+/g, '');
        const pm = compact.match(/\(([0-9]+\+)\)/);
        if (pm) return pm[1];
        const plus = compact.match(/^\(?(\++)\)?$/);
        if (plus) return plus[1].length + '+';
        const tail = compact.match(/^\((\++)\)-(.+)$/);   // ( + )-Granular / ( +++ )-300 mg/dl
        if (tail) {
            const grade = tail[1].length + '+';
            // 後面只是把 + 號換算成數值（300 mg/dl），沒有額外資訊就不留
            return /^[0-9.]+(mg\/d[lL]|mg\/L|\/HPF)?$/.test(tail[2]) ? grade : grade + ' ' + tail[2];
        }
        return val.replace(/\s+/g, ' ').trim();
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

    // 列的鍵是「MM/DD HH:MM」：同一天抽兩次以上時才分得開，
    // 只有日期的舊格式（沒有時間）也吃得下
    function dayPart(key) {
        return String(key || '').split(' ')[0];
    }
    function timeValue(key) {
        const m = String(key || '').match(/(\d{1,2}):(\d{2})/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
    }
    function dateKeyOrder(key) {
        const [mo, dd] = dayPart(key).split('/').map(Number);
        return [mo || 0, dd || 0, timeValue(key)];
    }

    function sortByDate(dArr, dataMap) {
        if (dArr.length <= 1) return;
        const order = dArr.map((d, i) => i);
        order.sort((a, b) => {
            const ka = dateKeyOrder(dArr[a]);
            const kb = dateKeyOrder(dArr[b]);
            for (let i = 0; i < ka.length; i++) {
                if (ka[i] !== kb[i]) return ka[i] - kb[i];
            }
            return 0;
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

    function getReportDocument() {
        const frame = document.getElementById('Reportifrm');
        if (!frame) return document;

        try {
            const reportDoc = frame.contentDocument;
            if (!reportDoc || reportDoc.readyState !== 'complete' || reportDoc.URL === 'about:blank' || !reportDoc.body) {
                return null;
            }
            return reportDoc;
        } catch (e) {
            return null;
        }
    }

    function readListView(reportDoc, view) {
        const tables = reportDoc.querySelectorAll('table.DetailedSheet');
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
        const stoolData = {};
        const stoolDates = [];
        const fluidGroups = {};
        const cultureItems = [];
        const structuredCultures = [];
        let collectDate = '';   // MM/DD HH:MM，同日多次抽血要分得開
        let collectDay = '';    // MM/DD，培養報告用
        let headerText = '';

        const AGAS_SKIP = ['Hct'];

        tables.forEach(table => {
            let prev = table.previousElementSibling;
            while (prev && prev.tagName !== 'TABLE') {
                const txt = prev.textContent || '';
                const dm = txt.match(/採檢:(\d{4})\/(\d{2})\/(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
                if (dm) {
                    collectDay = dm[2] + '/' + dm[3];
                    collectDate = collectDay + (dm[4] ? ' ' + ('0' + dm[4]).slice(-2) + ':' + dm[5] : '');
                    headerText = txt;
                    break;
                }
                prev = prev.previousElementSibling;
            }

            const sClass = specimenClass(headerText);

            if (sClass === 'agas') {
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
                    const gasName = GAS_NAME_MAP[rawName] || GAS_NAME_MAP[cleanName] || cleanName;
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
                if (sClass === 'csf' && !cultureKeysMatch(rawName)) {
                    const csfName = CSF_NAME_MAP[rawName] || cleanName;
                    if (!csfName) return;
                    if (!csfDates.includes(collectDate)) csfDates.push(collectDate);
                    pushToStore(csfData, csfName, csfDates.indexOf(collectDate), cleanGreenValue(rawVal));
                    return;
                }

                const val = cleanGreenValue(rawVal);

                if (cultureKeysMatch(rawName)) {
                    if (/Epithelial cell|PMN/i.test(val)) return;
                    if (/No bacteria visible/i.test(val)) return;
                    // 結果和參考值一樣（例：No Salmonella & Shigella）也算陰性
                    const refCell = cells[3] ? (cells[3].textContent || '').trim() : '';
                    const flat = (s) => s.replace(/\s+/g, '').toLowerCase();
                    const isNeg = /no growth|no aerobic\s+pathogen|no anaerobic\s+pathogen|^Undetectable$|^Negative$|^No Fungus$/i.test(val)
                        || /^No\s/i.test(val)
                        || (!!refCell && flat(val) === flat(refCell));
                    const remark = cells[4] ? (cells[4].textContent || '').trim() : '';
                    let cResult = isNeg ? '-' : abbrValue(val.replace(/Multiple colonial morphotypes present[;,]\s*/i, ''));
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
                            structuredCultures.push({ date: collectDay, label: label, result: cResult });
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
                        structuredCultures.push({ date: collectDay, label: scrLabel, result: scrName + ' (' + (scrNeg ? '-' : '+') + ')' });
                    } else if (/ID\+DS|ID C\.|ID Campy\.|^Anaerobic|^Gram's|^Blood Culture/i.test(rawName)) {
                        structuredCultures.push({ date: collectDay, label: specimenLabel(headerText), result: cResult });
                    } else {
                        cultureItems.push((collectDay ? '[' + collectDay + '] ' : '') + rawName + ': ' + val);
                    }
                    return;
                }

                const pcrName = PCR_MAP[rawName];
                if (pcrName) {
                    const pcrResult = (val === 'Not Detected' || val === 'Negative') ? '-' : '+';
                    cultureItems.push((collectDay ? '[' + collectDay + '] ' : '') + pcrName + ' ' + pcrResult);
                    return;
                }

                // 以下依「檢體種類」分流。舊版只看項目名，所以尿液的 PH 會被當成
                // 靜脈血氣的 pH、CRE(U)/UN(U) 會蓋掉血中 CRE/BUN。
                if (sClass === 'vgas') {
                    if (AGAS_SKIP.includes(cleanName)) return;
                    const gasName = GAS_NAME_MAP[rawName] || GAS_NAME_MAP[cleanName] || cleanName;
                    if (!vGasDates.includes(collectDate)) vGasDates.push(collectDate);
                    pushToStore(vGasData, gasName, vGasDates.indexOf(collectDate), val);
                    return;
                }

                if (sClass === 'urine') {
                    if (URINE_SKIP.includes(rawName)) return;
                    // 沒登錄過的項目就用原名，不要丟掉（不然會不知道漏了什麼）
                    const uName = URINE_NAME_MAP[rawName] || URINE_CHEM_MAP[rawName]
                        || URINE_PLAIN_MAP[rawName] || URINE_PLAIN_MAP[cleanName] || cleanName;
                    if (!uName) return;
                    if (!urineDates.includes(collectDate)) urineDates.push(collectDate);
                    pushToStore(urineData, uName, urineDates.indexOf(collectDate), abbrValue(val));
                    return;
                }

                if (sClass === 'stool') {
                    const sName = STOOL_NAME_MAP[rawName] || STOOL_NAME_MAP[cleanName] || cleanName;
                    if (!sName) return;
                    if (!stoolDates.includes(collectDate)) stoolDates.push(collectDate);
                    pushToStore(stoolData, sName, stoolDates.indexOf(collectDate), abbrValue(val));
                    return;
                }

                if (sClass === 'fluid') {
                    const fName = FLUID_NAME_MAP[rawName] || FLUID_NAME_MAP[cleanName]
                        || (/Cytology/i.test(rawName) ? 'Cytology' : cleanName);
                    if (!fName || fName === '__SKIP__') return;
                    if (fName === 'Adequacy' && /satisfactory/i.test(val)) return;
                    if (/^N\/A$/i.test(val)) return;
                    const gName = fluidGroupName(headerText);
                    if (!fluidGroups[gName]) fluidGroups[gName] = { dates: [], data: {} };
                    const g = fluidGroups[gName];
                    if (!g.dates.includes(collectDate)) g.dates.push(collectDate);
                    pushToStore(g.data, fName, g.dates.indexOf(collectDate), abbrValue(val));
                    return;
                }

                // 血液檢體。表頭寫法各院區不一致，萬一 Venous Blood 沒被認出來，
                // 就用項目名兜底當成靜脈血氣（尿液/糞便/體液前面已經分流掉，
                // 不會再發生尿液 PH 蓋掉血氣 pH 的事）；動脈血的表頭才會寫 Arterial。
                if (GAS_ITEM_NAMES.includes(rawName) || GAS_ITEM_NAMES.includes(cleanName)) {
                    const gasName = GAS_NAME_MAP[rawName] || GAS_NAME_MAP[cleanName] || cleanName;
                    if (!vGasDates.includes(collectDate)) vGasDates.push(collectDate);
                    pushToStore(vGasData, gasName, vGasDates.indexOf(collectDate), val);
                    return;
                }

                if (IGNORE.includes(cleanName)) return;
                const nm = normalizeName(rawName);
                if (nm === '__SKIP__' || IGNORE.includes(nm)) return;
                if (/^N\/A$/i.test(val)) return;

                const isG2 = RARE_DIFF.includes(nm);
                if (isG2 && (parseFloat(val) === 0 || !val)) return;

                pushToStore(trendData, nm, dateIdx, abbrValue(val));
            });
        });

        if (!dates.length && !aGasDates.length && !vGasDates.length && !cultureItems.length && !structuredCultures.length) return null;

        // Lactate 是生化機驗的（跟血氣不同單），但臨床上要跟酸鹼一起看，
        // 所以把血液欄位裡的 LA 併進氣體分析那張表（有動脈血就掛動脈）。
        // 血氣機自己驗的 LA 留在該張氣體分析表（動脈就在動脈）；
        // 另外送檢驗科的 LacticAcid 一律掛到 VBG 欄位。
        // 同一天已有靜脈血氣、採檢時間又相近（90 分鐘內）就併到同一列，不另開一列。
        if (trendData.LA) {
            trendData.LA.forEach((v, i) => {
                if (!v) return;
                const dt = dates[i];
                let best = null;
                let bestGap = Infinity;
                vGasDates.forEach((k, ki) => {
                    if (dayPart(k) !== dayPart(dt)) return;
                    if (vGasData.LA && vGasData.LA[ki]) return;   // 該列已經有 LA 了
                    const ta = timeValue(k);
                    const tb = timeValue(dt);
                    const gap = (ta < 0 || tb < 0) ? 0 : Math.abs(ta - tb);
                    if (gap <= 90 && gap < bestGap) { best = k; bestGap = gap; }
                });
                if (!best) { best = dt; vGasDates.push(best); }
                pushToStore(vGasData, 'LA', vGasDates.indexOf(best), v);
            });
            delete trendData.LA;
        }

        padData(trendData, dates.length);
        padData(urineData, urineDates.length);
        padData(csfData, csfDates.length);
        padData(stoolData, stoolDates.length);
        padData(aGasData, aGasDates.length);
        padData(vGasData, vGasDates.length);
        for (const g of Object.values(fluidGroups)) padData(g.data, g.dates.length);

        sortByDate(dates, trendData);
        sortByDate(aGasDates, aGasData);
        sortByDate(vGasDates, vGasData);
        sortByDate(urineDates, urineData);
        sortByDate(csfDates, csfData);
        sortByDate(stoolDates, stoolData);
        for (const g of Object.values(fluidGroups)) sortByDate(g.dates, g.data);

        const specialGroups = {};
        if (Object.keys(aGasData).length) {
            specialGroups['A gas'] = { dates: aGasDates, data: aGasData };
        }
        if (Object.keys(vGasData).length) {
            specialGroups['V gas'] = { dates: vGasDates, data: vGasData };
        }
        if (Object.keys(urineData).length) {
            specialGroups.Urine = { dates: urineDates, data: urineData };
        }
        if (Object.keys(stoolData).length) {
            specialGroups.Stool = { dates: stoolDates, data: stoolData };
        }
        for (const [gName, g] of Object.entries(fluidGroups)) {
            if (Object.keys(g.data).length) specialGroups[gName] = g;
        }
        if (Object.keys(csfData).length) {
            specialGroups.CSF = { dates: csfDates, data: csfData };
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
            const sectionSep = getOutputPref() === OUTPUT_SPACIOUS ? '\n\n' : '\n';
            result = (result || '') + (result ? sectionSep : '') + '#. Culture:\n' + cultureItems.join('\n');
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

        // Liver / Renal
        const lr = buildGroup(LIVER);
        if (lr.length) output.push('Liver: ' + lr.join(', '));
        const rn = buildGroup(RENAL);
        if (rn.length) output.push('Renal: ' + rn.join(', '));

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

    function readGreenSheetView(reportDoc, view) {
        const fieldsets = reportDoc.querySelectorAll('fieldset');
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
            w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
        }
        return w;
    }

    function padCell(s, w) {
        return s + ' '.repeat(Math.max(0, w - dispWidth(s)));
    }

    function fmtDateLabel(d) {
        return String(d || '');
    }

    // 該分組裡同一天只有一筆就只顯示 MM/DD，有兩筆以上才把時間帶出來，
    // 這樣常見的「一天抽一次」維持原本的緊湊樣子
    function rowLabelsFor(keys) {
        const perDay = {};
        for (const k of keys) {
            const d = dayPart(k);
            perDay[d] = (perDay[d] || 0) + 1;
        }
        return keys.map(k => (perDay[dayPart(k)] > 1 ? fmtDateLabel(k) : dayPart(k)));
    }

    // colNames: 欄位名陣列；rowLabels: 每列的日期；cells[列][欄]: 值
    function buildTable(title, colNames, rowLabels, cells) {
        if (!colNames.length || !rowLabels.length) return null;

        const labelW = Math.max(...rowLabels.map(dispWidth));
        const blocks = [];

        for (let start = 0; start < colNames.length; start += MAX_COLS) {
            const idx = [];
            for (let c = start; c < Math.min(start + MAX_COLS, colNames.length); c++) idx.push(c);

            // 欄位太多要換第二張表時，只列這幾欄真的有值的日期，
            // 不然第二張表會是一整片「-」
            const rowIdx = [];
            for (let r = 0; r < rowLabels.length; r++) {
                if (idx.some(c => cells[r][c] && cells[r][c] !== EMPTY)) rowIdx.push(r);
            }
            if (!rowIdx.length) continue;

            const colW = idx.map(c => Math.max(
                dispWidth(colNames[c]),
                ...rowIdx.map(r => dispWidth(cells[r][c]))
            ));

            const line = (label, get) => (
                padCell(label, labelW) +
                idx.map((c, k) => ' '.repeat(COL_GAP) + padCell(get(c), colW[k])).join('')
            ).replace(/\s+$/, '');

            const lines = [line('', c => colNames[c])];
            rowIdx.forEach(r => lines.push(line(rowLabels[r], c => cells[r][c])));
            blocks.push(lines.join('\n'));
        }
        if (!blocks.length) return null;

        const blockSep = getOutputPref() === OUTPUT_SPACIOUS ? '\n\n' : '\n';
        return (title ? title + '\n' : '') + blocks.join(blockSep);
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
        const spacious = getOutputPref() === OUTPUT_SPACIOUS;
        const headingSep = spacious ? ':\n' : ': ';
        const sectionSep = spacious ? '\n\n' : '\n';

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
                const gd = rowLabelsFor(activeIdx.map(i => refDates[i]));
                return title + ' [' + gd.join(', ') + ']' + headingSep + items.join(', ');
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

            const rowLabels = rowLabelsFor(activeIdx.map(i => refDates[i]));
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
                return 'Urine [' + rowLabelsFor(uDates).join(', ') + ']' + headingSep
                    + cols.map((k, c) => k + ' ' + colVals[c].join('→')).join(', ');
            }
            const rowLabels = rowLabelsFor(uDates);
            const cells = uDates.map((d, i) => colVals.map(v => v[i] || EMPTY));
            return buildTable('Urine', cols, rowLabels, cells);
        }

        const groups = [];
        const push = (g) => { if (g) groups.push(g); };

        // Hemogram 只放追感染/貧血會一起看的那幾項，其餘 DC 自成一段
        for (const [title, keys, ext] of BLOOD_GROUPS) push(buildGroup(title, keys, ext));

        // 沒被任何一組收走的項目一律進 Others。舊版是比對 ALL_KNOWN 清單，
        // 「在 ALL_KNOWN 裡但不屬於任何分組」的項目（例如血氣的 PCO2/HCO3
        // 落到血液欄位時）會兩邊都不收、無聲消失。改成只認實際分組。
        const claimed = new Set([...ATTACHED, ...OTHERS, ...IGNORE]);
        for (const [, keys, ext] of BLOOD_GROUPS) {
            for (const k of [...keys, ...ext]) claimed.add(k);
        }
        const leftover = Object.keys(data).filter(k => !claimed.has(k));
        push(buildGroup('Others', OTHERS, leftover));

        if (specialGroups) {
            for (const [sgName, sgData] of Object.entries(specialGroups)) {
                if (sgName === 'Urine') {
                    push(buildUrine(sgData));
                    continue;
                }
                // 各分組的欄位順序表；沒列到的項目接在後面
                const order = sgName === 'CSF' ? CSF_ORDER
                    : sgName === 'Stool' ? STOOL_ORDER
                    : sgName === 'V gas' ? VGAS_ORDER
                    : (sgName === 'A gas' || sgName === 'Gas') ? AGAS_ORDER
                    : FLUID_ORDER;
                const extra = Object.keys(sgData.data).filter(k => {
                    if (order.includes(k)) return false;
                    // VBG 的 PO2 沒有臨床意義（只有 ABG 才看），直接不列
                    if (sgName === 'V gas' && k === 'PO2') return false;
                    return true;
                });
                push(buildGroup(sgName, order, extra, sgData.data, sgData.dates));
            }
        }

        if (!groups.length) return null;

        // #. 前綴集中在這裡加，兩種模式都吃得到
        return groups.map(g => '#. ' + g).join(sectionSep);
    }

    // ====== 橫式版 DOM 讀取 ======

    function readHorizontalView(reportDoc, view) {
        const allTables = reportDoc.querySelectorAll('table');
        if (!allTables.length) return null;

        const dates = [];
        const data = {};
        const datesSet = new Set();

        allTables.forEach(table => {
            const rows = table.querySelectorAll('tr');
            if (rows.length < 2) return;

            let headerCells = rows[0].cells;
            if (!headerCells.length) return;

            const firstHeader = (headerCells[0].textContent || '').trim();
            if (!firstHeader.match(/\(\d+\/\d+\)/)) return;

            // 實際橫式頁的第一列表頭只有群組名，第二列才是檢驗項目。
            // 仍兼容群組名與項目位於同一列的舊格式。
            let itemStart = 1;
            let dataStart = 1;
            if (headerCells.length === 1) {
                headerCells = rows[1].cells;
                itemStart = 0;
                dataStart = 2;
            }
            if (headerCells.length <= itemStart) return;

            const itemNames = [];
            for (let j = itemStart; j < headerCells.length; j++) {
                itemNames.push((headerCells[j].textContent || '').trim());
            }

            for (let i = dataStart; i < rows.length; i++) {
                const cells = rows[i].cells;
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

    function detectViewMode(reportDoc) {
        const MODE_MAP = { '清單': 'list', '橫式': 'horizontal', '直式': 'vertical', '綠單': 'green' };
        const radios = reportDoc.querySelectorAll('input[type="radio"][id*="LabRangeSlider1_rbn"]');
        for (const r of radios) {
            if (!r.checked) continue;
            const label = reportDoc.querySelector('label[for="' + r.id + '"]');
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
    function computeReport(view, reportDoc) {
        const mode = detectViewMode(reportDoc);
        if (mode === 'green') return readGreenSheetView(reportDoc, view);
        if (mode === 'list') return readListView(reportDoc, view);
        if (mode === 'horizontal') return readHorizontalView(reportDoc, view);
        return '（直式模式不支援，請切換至清單、橫式或綠單）';
    }

    function run() {
        const reportDoc = getReportDocument();
        if (!reportDoc) {
            alert('報告尚未載入，請稍後再試');
            return;
        }

        // 兩種格式各算一次存起來，之後切換只換 textContent，不必重讀 DOM
        const texts = {};
        texts[VIEW_TABLE] = computeReport(VIEW_TABLE, reportDoc);
        texts[VIEW_TREND] = computeReport(VIEW_TREND, reportDoc);
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
            const reportDoc = getReportDocument();
            try { if (reportDoc) res = computeReport(getViewPref(), reportDoc); } catch (e) { /* 尚未就緒 */ }
            if (res) { clearInterval(iv); done({ ok: true, text: res }); return; }
            // 防呆：頁面就緒（view-mode radio 出現）但 computeReport 仍無資料 → 回「無檢驗資料」，避免空等逾時。
            // 就緒後給 8s 寬限（背景分頁被瀏覽器節流時，DetailedSheet 表格 render 可能 >3s，太短會誤判空）；最終 20s 也回無資料訊息而非 error。
            const pageReady = !!reportDoc?.querySelector('input[type="radio"][id*="LabRangeSlider1_rbn"]');
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
        const output = getOutputPref();

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
        const toggleButtonStyle = 'padding:3px 12px;border:none;border-radius:3px;cursor:pointer;font-size:12px;font-family:inherit;background:transparent;color:#bcd7ee;';
        const seg = document.createElement('span');
        seg.style.cssText = 'display:flex;background:#15537f;border-radius:4px;padding:2px;';
        const segBtns = {};
        [[VIEW_TREND, '趨勢'], [VIEW_TABLE, '表格']].forEach(([v, label]) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = toggleButtonStyle;
            b.onclick = () => { if (texts[v]) apply(v); };
            segBtns[v] = b;
            seg.appendChild(b);
        });

        const controls = document.createElement('span');
        controls.style.cssText = 'display:flex;align-items:center;gap:12px;';
        const outputSeg = document.createElement('span');
        outputSeg.style.cssText = 'display:flex;background:#15537f;border-radius:4px;padding:2px;';
        const outputBtns = {};
        [[OUTPUT_COMPACT, '緊湊'], [OUTPUT_SPACIOUS, '寬鬆']].forEach(([spacing, label]) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = toggleButtonStyle;
            b.onclick = () => {
                if (spacing === output) return;
                setOutputPref(spacing);
                run();
            };
            outputBtns[spacing] = b;
            outputSeg.appendChild(b);
        });
        controls.appendChild(outputSeg);
        controls.appendChild(seg);

        header.appendChild(title);
        header.appendChild(controls);

        const content = document.createElement('div');
        content.id = 'lab-summary-text';

        // 兩種呈現共用等寬字型，約 64 字後換行。
        function apply(v) {
            view = v;
            setViewPref(v);
            box.style.width = 'min(64ch,calc(100vw - 40px))';
            content.style.cssText = [
                'padding:10px 14px', 'background:#f7f7f7',
                'max-height:70vh', 'overflow:auto',
                'font-family:Consolas,"Courier New",monospace',
                'font-size:12.5px', 'line-height:1.5',
                'white-space:pre-wrap', 'overflow-wrap:anywhere',
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
            Object.entries(outputBtns).forEach(([k, b]) => {
                const on = k === output;
                b.style.background = on ? '#fff' : 'transparent';
                b.style.color = on ? '#1a6fa8' : '#bcd7ee';
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
