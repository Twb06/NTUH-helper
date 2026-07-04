// ==UserScript==
// @name         NTUH 處方檢視工具
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.5.0
// @description  讀取處方醫令頁 (MedicationV2.aspx) 的 OrderBox(一般處方) 與 OrderDisplayBox(自備藥) 兩張 grid，整理目前在使用的藥物成「商品名 劑量 頻率 途徑 開始日 特殊事項」，院內/自備分組對齊輸出並可一鍵複製
// @match        *://*/*MedicationV2.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/prescription-viewer.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/prescription-viewer.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // 一般處方(可編輯) 與 自備藥(顯示)兩張 grid，欄位排法不同，靠讀表頭定位。
    const ORDER_BOX = 'NTUHWeb1_RegularEditorBox_OrderBox_dgrPhrOrder';
    const DISPLAY_BOX = 'NTUHWeb1_RegularEditorBox_OrderDisplayBox_dgrPhrOrder';

    // ====== 商品名抽取 ======
    // 對照表：真正無規則、抽不對的藥，用 regex 指定商品名；優先於下方邏輯。
    // brand 可為字串或 function(match)，後者可保留 capture（如點滴系列要保留 No.）。
    const BRAND_OVERRIDES = [
        { re: /Taita\s*No\.?\s*(\d+)/i, brand: m => `Taita ${m[1]}` }, // 點滴系列(Taita No.3/No.5)保留編號
        { re: /Xigduo/i, brand: 'Xigduo XR' },                          // 複方藥(商品名在前)，直接顯示商品名
    ];
    function applyOverride(name) {
        for (const o of BRAND_OVERRIDES) {
            const m = name.match(o.re);
            if (m) return typeof o.brand === 'function' ? o.brand(m) : o.brand;
        }
        return null;
    }

    // 一般處方格式「學名 (商品名 劑型 strength)」→ 取括號內第一個英文 token
    //   "Hydralazine HCl (10 Stable 10 mg/tab)"      → "Stable"
    //   "Tranexamic Acid (針 Transamin Inj ...)"      → "Transamin"
    //   "Atropine Sulfate (眼1% Antol Eye Drops ...)"  → "Antol"（開頭中文的劑型前綴跳過）
    // 管制藥標記 (管N) 可能在最前或巢狀括號內 → 抽取前一律全域移除，再取第一個英文 token
    //   "Alprazolam ((管4) 安柏寧 Alpraline 0.5 mg/tab)"  → "Alpraline"
    //   "[自備藥](管4) 安柏寧 Alpraline 0.5 mg/tab"        → "Alpraline"
    //   "(管1) 液 Morphine Sulfate Oral Soln ..."         → "Morphine"
    //   "(管4) Lexotan 3 mg/tab"                          → "Lexotan"
    // 學名帶鹽類註記「Metoclopramide (as HCl salt) (Promeran ...)」→ 先剝 (as ...) 再抽 → "Promeran"
    // 自備藥「[自備藥]商品名 strength 劑型」(無括號、手動輸入) → 剝前綴後取第一個英文 token → "Tagrisso"
    function extractBrand(fullName) {
        if (!fullName) return '';
        const ov = applyOverride(fullName);
        if (ov) return ov;
        let src = fullName.replace(/^\s*\[自備藥\]\s*/, '');
        // 先全域移除管制藥標記 (管N)：它可能在最前(自備藥手動輸入)或巢狀括號內
        src = src.replace(/[（(]\s*管\s*\d+\s*[）)]/g, ' ');
        // 去掉學名鹽類/型態註記 (as HCl salt)/(as sodium)/(as base)，避免抓到 "as"
        src = src.replace(/\(\s*as\b[^)]*\)/gi, ' ');
        // 若還有括號：商品名多在括號內(學名(商品名)格式)，丟掉第一個 '(' 前的學名前綴
        const p = src.indexOf('(');
        if (p >= 0) src = src.slice(p + 1);
        src = src.replace(/[()（）]/g, ' '); // 清殘留括號
        const tokens = src.trim().split(/\s+/);
        for (const tok of tokens) {
            if (!tok) continue;
            if (/^[一-鿿㐀-䶿]/.test(tok)) continue; // 開頭中文(針/栓/袋/液/眼/安柏寧…劑型或中文品名)
            if (/^\d/.test(tok)) continue;            // 數字開頭(劑量/strength)
            return tok.replace(/[,;]+$/, '');         // 去尾端標點
        }
        return tokens.find(Boolean) || src.trim();
    }

    // "20260614" → "06/14"
    function fmtDate(ymd) {
        const s = String(ymd || '').trim();
        return /^\d{8}$/.test(s) ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : s;
    }

    // 去掉「特殊醫囑:」前綴
    function cleanSpecial(txt) {
        return String(txt || '').replace(/^\s*特殊醫囑\s*[:：]\s*/, '').trim();
    }

    // ====== 讀取表格 ======
    // 讀表頭列，把「開始日/藥名/劑量/頻率/途徑/特殊」對到欄位 index（兩張表位置不同，故不寫死）
    function mapCols(headRow) {
        const c = { start: -1, name: -1, dose: -1, freq: -1, route: -1, special: -1 };
        [...headRow.cells].forEach((td, i) => {
            const h = td.innerText.replace(/\s+/g, '');
            if (c.start < 0 && h.includes('開始日')) c.start = i;
            if (c.name < 0 && h.includes('藥名')) c.name = i;
            if (c.dose < 0 && h.includes('劑量')) c.dose = i;
            if (c.freq < 0 && h.includes('頻率')) c.freq = i;
            if (c.route < 0 && h.includes('途徑')) c.route = i;
            if (c.special < 0 && (h.includes('特殊事項') || h.includes('特殊醫囑'))) c.special = i;
        });
        return c;
    }

    // ownOnly=true 時只收 [自備藥] 前綴列（避免 OrderDisplayBox 萬一鏡射一般處方造成重複收錄）
    function readGrid(id, ownOnly) {
        const t = document.getElementById(id);
        if (!t || t.rows.length < 2) return [];
        const cols = mapCols(t.rows[0]);
        if (cols.start < 0 || cols.name < 0) return [];

        const cell = (tr, i) => (i >= 0 && tr.cells[i]) ? tr.cells[i].innerText.replace(/\s+/g, ' ').trim() : '';
        const meds = [];
        for (let r = 1; r < t.rows.length; r++) {
            const tr = t.rows[r];
            const startRaw = cell(tr, cols.start);
            const rawName = cell(tr, cols.name);
            if (!/^\d{8}$/.test(startRaw) || !rawName) continue; // 資料列判定

            const own = /^\s*\[自備藥\]/.test(rawName);
            if (ownOnly && !own) continue;

            meds.push({
                brand: extractBrand(rawName),
                own,
                dose: cell(tr, cols.dose),
                freq: cell(tr, cols.freq),
                route: cell(tr, cols.route),
                start: fmtDate(startRaw),
                special: cleanSpecial(cell(tr, cols.special))
            });
        }
        return meds;
    }

    function buildResults() {
        const t = document.getElementById(ORDER_BOX) || document.getElementById(DISPLAY_BOX);
        if (!t) return null; // 兩張表都找不到 → 不在處方頁

        const regular = readGrid(ORDER_BOX, false).filter(m => !m.own);
        const own = readGrid(DISPLAY_BOX, true);
        return { regular, own };
    }

    // ====== 格式化(對齊) ======
    function formatOutput(res) {
        if (!res) return '(找不到處方表格，請確認在處方醫令頁)';
        const { regular, own } = res;
        const all = regular.concat(own);
        if (all.length === 0) return '(目前沒有在使用的藥物)';

        const w = key => Math.max(...all.map(m => m[key].length));
        const wBrand = w('brand'), wDose = w('dose'), wFreq = w('freq'), wRoute = w('route');

        // 持續處方在日期後加 '-'；單次處方(STAT/ONCE)不加
        const isSingle = freq => /^(STAT|ONCE)\b/i.test(freq);
        const line = m => {
            const dateField = m.start + (isSingle(m.freq) ? '' : '-');
            let s = [
                m.brand.padEnd(wBrand + 2),
                m.dose.padEnd(wDose + 2),
                m.freq.padEnd(wFreq + 2),
                m.route.padEnd(wRoute + 2),
                m.special ? dateField.padEnd(6) : dateField
            ].join('');
            if (m.special) s += '  ' + m.special;
            return s;
        };

        const blocks = [];
        if (regular.length) blocks.push(regular.map(line).join('\n'));
        if (own.length) {
            blocks.push('----- 自備藥 -----');
            blocks.push(own.map(line).join('\n'));
        }
        return blocks.join('\n');
    }

    // ====== UI ======
    function showResult(text) {
        const old = document.getElementById('rx-med-box');
        if (old) old.remove();

        const box = document.createElement('div');
        box.id = 'rx-med-box';
        box.style.cssText = `position:fixed;top:80px;right:20px;z-index:999999;
            background:#fff;border:2px solid #507CD1;border-radius:6px;
            box-shadow:0 4px 16px rgba(0,0,0,.25);padding:12px;width:380px;`;

        // 頂部一行：左標題、右邊複製/關閉按鈕
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;font-family:sans-serif;';

        const title = document.createElement('div');
        title.textContent = '目前處方用藥';
        title.style.cssText = 'font-weight:bold;color:#507CD1;';

        const btns = document.createElement('div');

        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'width:100%;height:240px;font-family:Consolas,monospace;font-size:13px;white-space:pre;box-sizing:border-box;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '複製';
        copyBtn.style.cssText = 'margin-right:8px;padding:4px 12px;cursor:pointer;';
        copyBtn.onclick = () => {
            ta.select();
            navigator.clipboard.writeText(ta.value).then(
                () => { copyBtn.textContent = '已複製 ✓'; setTimeout(() => copyBtn.textContent = '複製', 1500); },
                () => { document.execCommand('copy'); copyBtn.textContent = '已複製 ✓'; }
            );
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        closeBtn.style.cssText = 'padding:4px 12px;cursor:pointer;';
        closeBtn.onclick = () => box.remove();

        btns.appendChild(copyBtn);
        btns.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(btns);
        box.appendChild(header);
        box.appendChild(ta);
        document.body.appendChild(box);
    }

    function addButton() {
        if (!document.body) { setTimeout(addButton, 100); return; }
        const btn = document.createElement('button');
        btn.textContent = '整理處方';
        btn.style.cssText = 'position:fixed;top:50px;right:20px;z-index:999999;padding:6px 14px;background:#507CD1;color:#fff;border:none;border-radius:4px;cursor:pointer;font-family:sans-serif;font-weight:bold;';
        // toggle：面板已開就收合，否則重新整理顯示
        btn.onclick = () => {
            const open = document.getElementById('rx-med-box');
            if (open) { open.remove(); return; }
            showResult(formatOutput(buildResults()));
        };
        document.body.appendChild(btn);
    }

    addButton();
})();
