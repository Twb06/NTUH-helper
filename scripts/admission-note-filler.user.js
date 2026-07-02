// ==UserScript==
// @name         NTUH Admission Note Filler
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  自動填入入院紀錄各欄位，並自動帶入檢驗結果
// @author       YT
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertAdmissionNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/ExternalPage/DWHistoricalLabReport.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/admission-note-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/admission-note-filler.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const PREFIX = 'NTUHWeb1_AdmissionNoteTab_TabContainer1_';

    // ─────────────────────────────────────────────
    // 填入欄位
    // ─────────────────────────────────────────────
    function fillField(id, value) {
        const el = document.getElementById(id);
        if (!el) { console.warn('[AdmFiller] 找不到欄位：', id); return false; }
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    // ─────────────────────────────────────────────
    // 解析筆記
    // ─────────────────────────────────────────────
    function parseNote(text) {
        const getBlock = (chineseTitle) => {
            const re = new RegExp(
                `${chineseTitle}[^\\n]*\\n([\\s\\S]*?)(?=\\n[\\u4e00-\\u9fff]{2,}[（(\\s]|$)`
            );
            const m = text.match(re);
            return m ? m[1].trim() : '';
        };

        const pt = getBlock('醫療需求與治療計畫');

        let cc = '';
        const ccMatch = pt.match(/CC:\s*(.+)/);
        if (ccMatch) cc = ccMatch[1].trim();

        let diagnosis = '';
        const diagMatch = pt.match(/={3,}Diagnosis={3,}\n([\s\S]*?)(?=\n={3,}|$)/i);
        if (diagMatch) diagnosis = diagMatch[1].trim();

        return {
            cc,
            ph: getBlock('病史'),
            rs: getBlock('系統性回顧'),
            pe: getBlock('身體診察'),
            pt,
            diagnosis,
        };
    }

    // ─────────────────────────────────────────────
    // 填入入院紀錄
    // ─────────────────────────────────────────────
    function fillAdmissionNote(noteText) {
        const p = parseNote(noteText);
        const results = [];

        const f = (label, suffix, value) => {
            results.push({ field: label, ok: fillField(PREFIX + suffix, value) });
        };

        f('主訴',               'tplCC_txbCC', p.cc        || '');
        f('病史',               'tplPH_txbPH', p.ph        || '');
        f('系統性回顧',         'tplRS_txbRS', p.rs        || '');
        f('身體診察',           'tplPE_txbPE', p.pe        || '');

        const irEl = document.getElementById(PREFIX + 'tplIR_txbIR');
        if (irEl && !irEl.value.trim()) f('檢查紀錄', 'tplIR_txbIR', 'nil');
        const rrEl = document.getElementById(PREFIX + 'tplRR_txbRR');
        if (rrEl && !rrEl.value.trim()) f('影像報告', 'tplRR_txbRR', 'nil');
        const paEl = document.getElementById(PREFIX + 'tplPA_txbPA');
        if (paEl && !paEl.value.trim()) f('病理報告', 'tplPA_txbPA', 'nil');

        f('臆斷',               'tplTD_txbTD', p.diagnosis || '');
        f('醫療需求與治療計畫', 'tplPT_txbPT', p.pt       || '');
        // 檢驗結果：填完欄位後自動帶入
        setTimeout(() => autoImportLab(), 1000);
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
        if (!btn.includes('AdmissionNote')) return;

        const deptCbs = Array.from(document.querySelectorAll('input[type=checkbox][dept]'))
            .filter(cb => !cb.getAttribute('group') && !cb.getAttribute('key'));

        if (deptCbs.length === 0) {
            console.log('[AdmFiller] 找不到科別 checkbox');
            return;
        }

        deptCbs.forEach(cb => {
            cb.checked = true;
            cb.onclick();
        });

        setTimeout(() => {
            // eslint-disable-next-line no-undef
            if (typeof OnClientClick_GetSelectedLabData === 'function') {
                OnClientClick_GetSelectedLabData(); // eslint-disable-line no-undef
            }
            setTimeout(() => window.close(), 500);
        }, 1000);
    }

    // ─────────────────────────────────────────────
    // 入院紀錄頁面：點按鈕觸發查詢（開新頁面）
    // ─────────────────────────────────────────────
    function autoImportLab() {
        setLabStatus('⏳ 開啟檢驗結果頁面中…', 'warn');
        const queryBtn = document.getElementById(
            'NTUHWeb1_AdmissionNoteTab_TabContainer1_tplLR_btnGetDefaultLR_2W'
        );
        if (!queryBtn) {
            setLabStatus('⚠ 找不到查詢按鈕，請確認已開啟檢驗結果頁籤', 'err');
            return;
        }
        simulateClick(queryBtn);
        setLabStatus('⏳ 新頁面開啟中，自動勾選後會關閉…', 'warn');
        // 新頁面由 autoSelectAndImport 接手，完成後會自動關閉
        setTimeout(() => setLabStatus('✓ 完成，請確認檢驗結果已帶入', 'ok'), 6000);
    }

    // ─────────────────────────────────────────────
    // UI（入院紀錄頁面）
    // ─────────────────────────────────────────────
    function createUI() {
        if (document.getElementById('ntuh-adm-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            /* 收合狀態：圓形 FAB */
            #ntuh-adm-fab {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                background: #1e3a2f;
                border: 2px solid #3fb950;
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
            #ntuh-adm-fab:hover {
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(0,0,0,0.5);
            }

            /* 展開狀態：面板 */
            #ntuh-adm-panel {
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
            #ntuh-adm-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 10px 14px; background: #1e3a2f; border-bottom: 1px solid #2d3650;
                cursor: move; user-select: none; font-size: 13px; font-weight: 600;
            }
            #ntuh-adm-close {
                background: none; border: none; color: #7a8aaa;
                cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1;
            }
            #ntuh-adm-close:hover { color: #e05c5c; }
            #ntuh-adm-body {
                padding: 12px; display: flex; flex-direction: column; gap: 8px;
            }
            #ntuh-adm-input {
                width: 100%; height: 140px; background: #0f1420;
                border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8;
                font-family: 'Consolas',monospace; font-size: 11px; padding: 8px;
                resize: vertical; box-sizing: border-box; line-height: 1.5;
            }
            #ntuh-adm-input:focus { outline: none; border-color: #3fb950; }
            #ntuh-adm-fill {
                padding: 8px 0; border: none; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 600;
                background: #238636; color: #fff; transition: opacity 0.15s;
            }
            #ntuh-adm-fill:hover { opacity: 0.85; }
            #ntuh-adm-lab-btn {
                padding: 8px 0; border: none; border-radius: 6px;
                cursor: pointer; font-size: 12px; font-weight: 600;
                background: #2d4a6e; color: #8fa8d8; transition: opacity 0.15s;
            }
            #ntuh-adm-lab-btn:hover { opacity: 0.85; }
            #ntuh-adm-status { font-size: 11px; min-height: 16px; }
            #ntuh-adm-lab-status { font-size: 11px; min-height: 16px; }
            #ntuh-adm-preview {
                display: none; background: #0f1420; border: 1px solid #2d3650;
                border-radius: 6px; padding: 8px; font-size: 10.5px;
                line-height: 1.6; max-height: 200px; overflow-y: auto;
            }
            .adm-ok   { color: #3fb950; }
            .adm-err  { color: #e05c5c; }
            .adm-warn { color: #f0a030; }
            .adm-row  {
                display: flex; justify-content: space-between;
                padding: 2px 0; border-bottom: 1px solid #1e2638;
            }
            .adm-divider { border: none; border-top: 1px solid #2d3650; margin: 2px 0; }
        `;
        document.head.appendChild(style);

        // 圓形 FAB
        const fab = document.createElement('div');
        fab.id = 'ntuh-adm-fab';
        fab.textContent = '🏥';
        fab.title = '入院紀錄填入';
        document.body.appendChild(fab);

        // 展開面板
        const panel = document.createElement('div');
        panel.id = 'ntuh-adm-panel';
        panel.innerHTML = `
            <div id="ntuh-adm-header">
                <span>🏥 入院紀錄填入</span>
                <button id="ntuh-adm-close">✕</button>
            </div>
            <div id="ntuh-adm-body">
                <textarea id="ntuh-adm-input" placeholder="貼入入院筆記內容…"></textarea>
                <button id="ntuh-adm-fill">✨ 填入入院紀錄</button>
                <div id="ntuh-adm-status"></div>
                <div id="ntuh-adm-preview"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // FAB 點擊展開
        fab.onclick = () => {
            fab.style.display = 'none';
            panel.style.display = 'block';
        };

        // 關閉按鈕收合
        document.getElementById('ntuh-adm-close').onclick = () => {
            panel.style.display = 'none';
            fab.style.display = 'flex';
        };

        makeDraggable(panel, document.getElementById('ntuh-adm-header'));

        document.getElementById('ntuh-adm-fill').onclick = () => {
            const text = document.getElementById('ntuh-adm-input').value.trim();
            if (!text) { setStatus('⚠ 請先貼入筆記內容', 'err'); return; }
            showResults(fillAdmissionNote(text));
        };
    }

    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-adm-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'adm-ok' : type === 'err' ? 'adm-err' : 'adm-warn';
    }

    function setLabStatus(msg, type) {
        const el = document.getElementById('ntuh-adm-lab-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'adm-ok' : type === 'err' ? 'adm-err' : 'adm-warn';
    }

    function showResults(results) {
        const preview = document.getElementById('ntuh-adm-preview');
        if (!preview) return;
        preview.style.display = 'block';
        preview.innerHTML = results.map(r =>
            `<div class="adm-row">
                <span>${r.field}</span>
                <span class="${r.ok ? 'adm-ok' : 'adm-err'}">${r.ok ? '✓ 填入' : '✗ ' + (r.reason || '找不到欄位')}</span>
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
        if (window.location.href.includes('InsertAdmissionNoteContent.aspx')) {
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
