// ==UserScript==
// @name         NTUH Discharge Note Filler
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  自動填入出院病摘各欄位，並自動帶入檢驗結果
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertDisChargeNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/ExternalPage/DWHistoricalLabReport.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const PREFIX = 'NTUHWeb1_DischargeNoteTab1_TabContainer1_';

    // ─────────────────────────────────────────────
    // 填入欄位
    // ─────────────────────────────────────────────
    function fillField(id, value) {
        const el = document.getElementById(id);
        if (!el) { console.warn('[DischFiller] 找不到欄位：', id); return false; }
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function appendField(id, appendText) {
        const el = document.getElementById(id);
        if (!el) { console.warn('[DischFiller] 找不到欄位：', id); return false; }
        el.value = el.value.trimEnd() + '\n\n' + appendText;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // ─────────────────────────────────────────────
    // 解析筆記（與 Progress Note 相同格式）
    // ─────────────────────────────────────────────
    function parseNote(text) {
        const getSection = (label) => {
            const escapedLabel = label.replace(/'/g, "[’']");
            const re = new RegExp(
                `-*\\s*\\[${escapedLabel}\\]\\s*-*\\n([\\s\\S]*?)(?=\\n-{5,}\\[|$)`, 'i'
            );
            const m = text.match(re);
            return m ? m[1].trim() : '';
        };

        return {
            diagnosis: getSection('Diagnosis'),
            course:    getSection('Course'),
        };
    }

    // ─────────────────────────────────────────────
    // 填入出院病摘
    // ─────────────────────────────────────────────
    function fillDischargeNote(noteText) {
        const p = parseNote(noteText);
        const results = [];

        const f = (label, suffix, value) =>
            results.push({ field: label, ok: fillField(PREFIX + suffix, value) });

        const fNilIfEmpty = (label, suffix) => {
            const el = document.getElementById(PREFIX + suffix);
            if (el && !el.value.trim()) {
                results.push({ field: label, ok: fillField(PREFIX + suffix, 'nil') });
            }
        };

        // 出院診斷 ← Diagnosis
        if (p.diagnosis) {
            f('出院診斷', 'tplCD_txbCD', p.diagnosis);
        }

        // 轉出加護病房診斷 ← nil
        f('轉出加護病房診斷', 'tplCI_txbCI', 'nil');

        // 手術 ← 空白填 nil
        fNilIfEmpty('手術', 'tplOP_txbOP');

        // 住院治療經過 ← prompt + Course 整段
        if (p.course) {
            const coursePrompt = 'please write a course note according to the following data, with correct time sequence. Write like NEJM in 3 paragraphs, and use date format as YYYY/MM/DD\n\n';
            f('住院治療經過', 'tplCM_txbCM', coursePrompt + p.course);
        }

        // 併發症 ← nil
        f('併發症', 'tplCO_txbCO', 'nil');

        // 檢查紀錄 ← 空白填 nil
        fNilIfEmpty('檢查紀錄', 'tplSI_txbSI');

        // 影像報告 ← 空白填 nil
        fNilIfEmpty('影像報告', 'tplRR_txbRR');

        // 病理報告 ← 空白填 nil
        fNilIfEmpty('病理報告', 'tplPA_txbPA');

        // 檢驗結果：填完欄位後自動帶入
        setTimeout(() => autoImportLab(), 1000);

        // 其他＋轉出：等 lab 頁面開出去後再點，postback 不影響 lab import
        setTimeout(() => {
            const otBtn = document.getElementById(PREFIX + 'tplOT_btnDisDefaultValue_ANN');
            if (otBtn) otBtn.click();
            setTimeout(() => {
                const dsBtn = document.getElementById(PREFIX + 'tplDS_btnSetDischargeStatus');
                if (dsBtn) dsBtn.click();
            }, 1000);
        }, 3000);

        return results;
    }

    // ─────────────────────────────────────────────
    // 模擬真實點擊
    // ─────────────────────────────────────────────
    function simulateClick(el) {
        ['mousedown', 'mouseup', 'click'].forEach(type => {
            el.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window
            }));
        });
    }

    // ─────────────────────────────────────────────
    // 檢驗結果自動帶入（在 DWHistoricalLabReport.aspx 頁面執行）
    // ─────────────────────────────────────────────
    function autoSelectAndImport() {
        const params = new URLSearchParams(window.location.search);
        const btn = params.get('hfdbutton') || '';
        if (!btn.includes('DischargeNote')) return;

        const deptCbs = Array.from(document.querySelectorAll('input[type=checkbox][dept]'))
            .filter(cb => !cb.getAttribute('group') && !cb.getAttribute('key'));

        if (deptCbs.length === 0) {
            console.log('[DischFiller] 找不到科別 checkbox');
            return;
        }

        deptCbs.forEach(cb => {
            cb.checked = true;
            cb.onclick();
        });

        setTimeout(() => {
            if (typeof OnClientClick_GetSelectedLabData === 'function') {
                OnClientClick_GetSelectedLabData();
            }
            setTimeout(() => window.close(), 500);
        }, 1000);
    }

    // ─────────────────────────────────────────────
    // 出院病摘頁面：點按鈕觸發查詢（開新頁面）
    // ─────────────────────────────────────────────
    function autoImportLab() {
        setLabStatus('⏳ 開啟檢驗結果頁面中…', 'warn');
        const queryBtn = document.getElementById(
            'NTUHWeb1_DischargeNoteTab1_TabContainer1_tplGI_btnPop4thReport'
        );
        if (!queryBtn) {
            setLabStatus('⚠ 找不到查詢按鈕，請確認已開啟檢驗紀錄頁籤', 'err');
            return;
        }
        simulateClick(queryBtn);
        setTimeout(() => setLabStatus('✓ 完成，請確認檢驗結果已帶入', 'ok'), 6000);
    }

    // ─────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────
    function createUI() {
        if (document.getElementById('ntuh-disch-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-disch-fab {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                background: #2a1f3a;
                border: 2px solid #9a7cdc;
                box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                z-index: 99999;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 20px;
                transition: transform 0.15s, box-shadow 0.15s;
                user-select: none;
            }
            #ntuh-disch-fab:hover {
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(0,0,0,0.5);
            }
            #ntuh-disch-panel {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 200px;
                background: #1a1f2e;
                border: 1px solid #2d3650;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                z-index: 99999;
                font-family: 'Consolas','Courier New',monospace;
                font-size: 12px;
                color: #c8d3e8;
                overflow: hidden;
                display: none;
            }
            #ntuh-disch-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 14px; background: #2a1f3a; border-bottom: 1px solid #2d3650;
                cursor: move; user-select: none; font-size: 13px; font-weight: 600;
            }
            #ntuh-disch-close {
                background: none; border: none; color: #7a8aaa;
                cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1;
            }
            #ntuh-disch-close:hover { color: #e05c5c; }
            #ntuh-disch-body {
                padding: 12px; display: flex; flex-direction: column; gap: 8px;
            }
            #ntuh-disch-input {
                width: 100%; height: 140px; background: #0f1420;
                border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8;
                font-family: 'Consolas',monospace; font-size: 11px; padding: 8px;
                resize: vertical; box-sizing: border-box; line-height: 1.5;
            }
            #ntuh-disch-input:focus { outline: none; border-color: #9a7cdc; }
            #ntuh-disch-fill {
                padding: 8px 0; border: none; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 600;
                background: #6a3cac; color: #fff; transition: opacity 0.15s;
            }
            #ntuh-disch-fill:hover { opacity: 0.85; }
            #ntuh-disch-status { font-size: 11px; min-height: 16px; }
            #ntuh-disch-lab-status { font-size: 11px; min-height: 16px; }
            #ntuh-disch-preview {
                display: none; background: #0f1420; border: 1px solid #2d3650;
                border-radius: 6px; padding: 8px; font-size: 10.5px;
                line-height: 1.6; max-height: 200px; overflow-y: auto;
            }
            .disch-ok   { color: #3fb950; }
            .disch-err  { color: #e05c5c; }
            .disch-warn { color: #f0a030; }
            .disch-row  {
                display: flex; justify-content: space-between;
                padding: 2px 0; border-bottom: 1px solid #1e2638;
            }
            .disch-divider { border: none; border-top: 1px solid #2d3650; margin: 2px 0; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-disch-fab';
        fab.textContent = '📄';
        fab.title = '出院病摘填入';
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-disch-panel';
        panel.innerHTML = `
            <div id="ntuh-disch-header">
                <span>📄 出院病摘填入</span>
                <button id="ntuh-disch-close">✕</button>
            </div>
            <div id="ntuh-disch-body">
                <textarea id="ntuh-disch-input" placeholder="貼入出院病摘筆記內容…"></textarea>
                <button id="ntuh-disch-fill">✨ 填入出院病摘</button>
                <div id="ntuh-disch-status"></div>
                <div id="ntuh-disch-preview"></div>
            </div>
        `;
        document.body.appendChild(panel);

        fab.onclick = () => {
            fab.style.display = 'none';
            panel.style.display = 'block';
        };

        document.getElementById('ntuh-disch-close').onclick = () => {
            panel.style.display = 'none';
            fab.style.display = 'flex';
        };

        makeDraggable(panel, document.getElementById('ntuh-disch-header'));

        document.getElementById('ntuh-disch-fill').onclick = () => {
            const text = document.getElementById('ntuh-disch-input').value.trim();
            if (!text) { setStatus('⚠ 請先貼入筆記內容', 'err'); return; }
            showResults(fillDischargeNote(text));
        };


    }

    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-disch-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'disch-ok' : type === 'err' ? 'disch-err' : 'disch-warn';
    }

    function setLabStatus(msg, type) {
        const el = document.getElementById('ntuh-disch-lab-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'disch-ok' : type === 'err' ? 'disch-err' : 'disch-warn';
    }

    function showResults(results) {
        const preview = document.getElementById('ntuh-disch-preview');
        if (!preview) return;
        preview.style.display = 'block';
        preview.innerHTML = results.map(r =>
            `<div class="disch-row">
                <span>${r.field}</span>
                <span class="${r.ok ? 'disch-ok' : 'disch-err'}">${r.ok ? '✓ 填入' : '✗ ' + (r.reason || '找不到欄位')}</span>
            </div>`
        ).join('');
        const allOk = results.every(r => r.ok);
        setStatus(
            allOk ? '✓ 全部填入完成！請確認後儲存。' : '部分欄位填入失敗',
            allOk ? 'ok' : 'warn'
        );
    }

    function makeDraggable(panel, handle) {
        let startX, startY, startLeft, startTop;
        handle.onmousedown = (e) => {
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = startLeft + 'px'; panel.style.top = startTop + 'px';
            document.onmousemove = (e) => {
                panel.style.left = (startLeft + e.clientX - startX) + 'px';
                panel.style.top  = (startTop  + e.clientY - startY) + 'px';
            };
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
            };
        };
    }

    // ─────────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────────
    function init() {
        if (window.location.href.includes('InsertDisChargeNoteContent.aspx')) {
            setTimeout(createUI, 1500);
        } else if (window.location.href.includes('DWHistoricalLabReport.aspx')) {
            setTimeout(autoSelectAndImport, 1500);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
