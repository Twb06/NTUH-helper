// ==UserScript==
// @name         NTUH Progress Note Filler
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  從筆記區自動解析病程筆記並填入 Progress Note / Weekly Summary 欄位，並可一鍵填入 Duty Note 模板並暫存。筆記須符合 primary note 格式（含 [Today's Events] / [Course] / [Assessment] / [Diagnosis] / [Plans] 區塊）。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-filler.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ─────────────────────────────────────────────
    // Duty Note 模板
    // ─────────────────────────────────────────────
    const DUTY_TITLE = 'Duty Note';
    const DUTY_TPL = `I was informed around 00:00 that the patient experienced
Upon visiting, the patient was clear and oriented, with non-toxic looking. The vital signs were T/P/R:  , BP:  mmHg. The saturation was  % under ambient air, the blood sugar by one touch was   mg/dl.
------------------------[Assessment]---------------------------
[Hx]
The patient reported,
While denied
[PE]
#. HENNT: Pink conj. , anicteric sclera, thrush/palpible LN -/-
#. Heart: Regular rhythm, no murmurs
#. Chest: Clear BS,  crackles/wheezing/stridor (-/-/-)
#. Abd: No tenderness, rebound/guarding (-/-), Macburney/Murphy (-/-)
#. Uro: kncoking tenderness(-)
#. Soft tissue: bedsores(-), arthralgia(-), pitting edema(-)
#. Tubes: no turbid/bloody fluid in
[NE]
#. Conscious: Clear and oriented, E4V5M6
#. Speech: dysarthria/aphasia: -/-
#. CN2346: VA/VF/EOM intact, reflex +/+, nystagmus(-),  ptosis(-)
   CN57: sensory/motor intact, no facial palsy
   CN8: No obvious auditory impairment
   CN91012: uvula/tongue deviation(-/-), dystharia(-)
   CN11: SCM/Trapezius power: intact
#. Motor: MP(P/D): RUE 5/5, LUE 5/5, RLE 5/5, LLE 5/5
   Fasciculation(-), Pronator drift(-), Rigidity/Spasticity(-/-)
#. Sensory: Light touch: symmetric in four limbs and bil. face
#. Reflex: Biceps 2/2, brachioradialis 2/2 Knee 2/2, Ankle 2/2
   Barbinski sign -/-
#. Cerebellar: FNF -/-, RAM -/-, Gait/Romberg/Tandem intact
[POCUS]
#. Heart: EPSS<1cm, no pericardial effusions, good LV motion
#. Lung:
    Right: A pattern, barcode sign(-), pleural effusion(-)
    Left:   A pattern, barcode sign(-), pleural effusion(-)
#. Abd: IVC:  cm, no GB swelling, no obvious liver lesion, no hydronephrosis, no ascites (deepest  cm)
#. DVT: Femoral vein L/R (-/-), Popliteal vein (-/-)
----------------------[Tentative Ddx]-------------------------
#. Suspected
------------------------[Plan]---------------------------
[Workup]
#. Lab: CBC/DC, Renal/Liver/Coagulation function, Electrolytes
#. Image: CXR, KUB, NCCT
#. 12 lead EKG: showed NSR
#. Septic w/u: B/C*2, U/A, U/C, S/C, nasal swabs
[Initial Management]
#. Prescribed   for symptom control
#. Antibiotics was upgraded from  to  for
#. Component therapy: pRBC  U, Plt  U, FFP  U, Cryo  U
#. O2 support with  , keep SpO2 >95%
#. Levophed 2amp/250D5W run ml/hr to keep MAP>65mmHg
#. Close monitor vital signs, GCS
#. Informed senior R (#), and the doctor ordered
#. Consulted   specialist R (#), and the doctor ordered
-------------------------[Lab]---------------------------
------------------------[Image]----------------------------
#. CXR: no obvious new lesion, sharp CP angle, no cardiomegaly
#. KUB: prominent bowel gas, no ileus pattern, no ureter stone
#. Brain NCCT: no hemorrhage, no midline shift
------------------------[Afterward]---------------------------
I visited the patient again on 0/0 00:00,
I was informed relieved of symptoms around 0/0 00:00,
#. The fever subsided to  °C after Acetal was given.
#. The fever persisted despite Acetal administration, acetamol was given for better fever control
#. The O2 demend remains / was titrated / was tapered to NC?L / mask %L / BiPAP
#. The Levophed remains / was titrated / was tapered to ?? ml/hr
#. The duty CR visited and
#. The VS visited and
#. The nasal swab of COVID / Influenza revealed positive result, quarantine  was arranged`;

    function fillDutyNote() {
        const contentId = 'NTUHWeb1_BlankNoteMainTab_txbBlankContnt';
        const titleId = 'NTUHWeb1_BlankNoteMainTab_txbBlankTitle';
        if (!document.getElementById(contentId)) {
            return { ok: false, reason: '找不到 Blank Note 欄位，請先切到該分頁' };
        }
        fillField(titleId, DUTY_TITLE);
        fillField(contentId, DUTY_TPL);
        document.getElementById(contentId).focus();
        setTimeout(() => {
            const saveBtn = document.getElementById('NTUHWeb1_BlankNoteMainTab_Button1');
            if (saveBtn) saveBtn.click();
        }, 300);
        return { ok: true };
    }

    // ─────────────────────────────────────────────
    // 把 Today's Events 裡按日期分塊
    // ─────────────────────────────────────────────
    function parseDayBlocks(text) {
        const lines = text.split('\n');
        const blocks = [];
        let current = null;

        for (const line of lines) {
            if (/^\d{1,2}\/\d{1,2}\s*$/.test(line.trim())) {
                if (current) blocks.push(current);
                current = { date: line.trim(), content: line.trim() + '\n' };
            } else if (current) {
                current.content += line + '\n';
            }
        }
        if (current) blocks.push(current);
        return blocks;
    }

    // ─────────────────────────────────────────────
    // 解析筆記內容
    // ─────────────────────────────────────────────
    function parseNote(text) {
        const result = {
            todayEvents: '',
            plans: '',
            diagnosis: '',
            assessment: '',
            lastCourse: '',
            lastFourCourse: '',
        };

        const getSection = (label) => {
            const escapedLabel = label.replace(/['’]/g, "[’']");
            const re = new RegExp(
                `-*\\s*\\[${escapedLabel}\\]\\s*-*\\n([\\s\\S]*?)(?=\\n*-{5,}\\[|$)`, 'i'
            );
            const m = text.match(re);
            return m ? m[1].trim() : '';
        };

        const eventsRaw = getSection("Today's Events");
        const dayBlocks = parseDayBlocks(eventsRaw);
        if (dayBlocks.length >= 1) {
            result.todayEvents = dayBlocks[dayBlocks.length - 1].content.trim();
        }

        result.plans = getSection('Plans');
        result.diagnosis = getSection('Diagnosis');
        result.assessment = getSection('Assessment');

        const courseRaw = getSection('Course');
        const courseParas = courseRaw.split(/\n{2,}/);
        result.lastCourse = courseParas[courseParas.length - 1].trim();

        const lastFour = courseParas.slice(-4).map(p => p.trim()).filter(p => p);
        result.lastFourCourse = lastFour.join('\n\n');

        return result;
    }

    // ─────────────────────────────────────────────
    // 填入欄位
    // ─────────────────────────────────────────────
    function fillField(id, value) {
        const el = document.getElementById(id);
        if (!el) {
            console.warn('[NoteFiller] 找不到欄位：', id);
            return false;
        }
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('click', { bubbles: true }));
        return true;
    }

    // ─────────────────────────────────────────────
    // 填入 Progress Note
    // ─────────────────────────────────────────────
    function fillProgressNote(noteText) {
        const parsed = parseNote(noteText);
        const results = [];

        if (parsed.todayEvents) {
            results.push({
                field: 'Subjective',
                ok: fillField('NTUHWeb1_ProgressNoteMainTab_txbSubject', parsed.todayEvents)
            });
        } else {
            results.push({ field: 'Subjective', ok: false, reason: '找不到 Today\'s Events' });
        }

        if (parsed.lastCourse) {
            results.push({
                field: 'Brief Summary of Yesterday',
                ok: fillField('NTUHWeb1_ProgressNoteMainTab_tabBrifSummaryOfYesterday', parsed.lastCourse)
            });
        }

        results.push({
            field: 'Assessment of Catheterization',
            ok: fillField('NTUHWeb1_ProgressNoteMainTab_txbBSIBundle', 'nil')
        });

        if (parsed.diagnosis) {
            results.push({
                field: 'PAP 1 — Problem',
                ok: fillField('NTUHWeb1_ProgressNoteMainTab_ucPAP_txbProblem1', parsed.diagnosis)
            });
        }

        if (parsed.assessment) {
            results.push({
                field: 'PAP 1 — Assessment',
                ok: fillField('NTUHWeb1_ProgressNoteMainTab_ucPAP_txbAssessment1', parsed.assessment)
            });
        }

        if (parsed.plans) {
            results.push({
                field: 'PAP 1 — Plan',
                ok: fillField('NTUHWeb1_ProgressNoteMainTab_ucPAP_txbPlan1', parsed.plans)
            });
        }

        setTimeout(() => {
            const saveBtn = document.getElementById('NTUHWeb1_ProgressNoteMainTab_btnConfirmProgressNote');
            if (saveBtn) saveBtn.click();
        }, 500);

        return results;
    }

    // ─────────────────────────────────────────────
    // 填入 Weekly Summary
    // ─────────────────────────────────────────────
    function fillWeeklySummary(noteText) {
        const parsed = parseNote(noteText);
        const results = [];

        if (parsed.diagnosis) {
            results.push({
                field: 'Diagnosis',
                ok: fillField('NTUHWeb1_WeeklySummaryMainTab_txbDiagnosis', parsed.diagnosis)
            });
        } else {
            results.push({ field: 'Diagnosis', ok: false, reason: '找不到 Diagnosis' });
        }

        const weeklyPrompt = 'please concise the following content into 2 paragraphs of weekly summary';
        const briefContent = weeklyPrompt + '\n\n' + parsed.lastFourCourse + '\n\n' + parsed.todayEvents;
        results.push({
            field: 'Brief Summary of this week',
            ok: fillField('NTUHWeb1_WeeklySummaryMainTab_txbBriefSummary', briefContent)
        });

        setTimeout(() => {
            const saveBtn = document.getElementById('NTUHWeb1_WeeklySummaryMainTab_btnSaveWeeklySummary');
            if (saveBtn) saveBtn.click();
        }, 500);

        return results;
    }

    // ─────────────────────────────────────────────
    // 今日紀錄：把 Today's Events 移到 Course 底部，加上今天日期
    // ─────────────────────────────────────────────
    function prepareToday(noteText) {
        const el = document.getElementById('NTUHWeb1_BlankNoteMainTab_txbBlankContnt');
        if (!el) return { ok: false, reason: '找不到筆記欄位' };

        const getSection = (label) => {
            const escapedLabel = label.replace(/['’]/g, "[’']");
            const re = new RegExp(
                `-*\\s*\\[${escapedLabel}\\]\\s*-*\\n([\\s\\S]*?)(?=\\n*-{5,}\\[|$)`, 'i'
            );
            const m = noteText.match(re);
            return m ? m[1].trim() : '';
        };

        const todayContent = getSection("Today's Events");
        if (!todayContent) return { ok: false, reason: '找不到 Today\'s Events 內容' };

        // 今天日期 M/D
        const now = new Date();
        const dateStr = `${now.getMonth() + 1}/${now.getDate()}`;

        let newText = noteText;

        // 1. 把 Today's Events 內容 append 到 Course 底部
        newText = newText.replace(
            /(-*\s*\[Course\]\s*-*\n[\s\S]*?)(\n*-{5,}\[|$)/i,
            (match, courseBlock, ending) => {
                return courseBlock.trimEnd() + '\n\n' + todayContent + '\n' + ending;
            }
        );

        // 2. 清空 Today's Events，換成今天日期
        newText = newText.replace(
            /(-*\s*\[Today[’']s Events\]\s*-*\n)[\s\S]*?(?=\n*-{5,}\[|$)/i,
            (match, header) => header + dateStr + '\n'
        );

        el.value = newText;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        setTimeout(() => {
            const saveBtn = document.getElementById('NTUHWeb1_BlankNoteMainTab_Button1');
            if (saveBtn) saveBtn.click();
        }, 500);
        return { ok: true };
    }

    // ─────────────────────────────────────────────
    // 從筆記區抓內容
    // ─────────────────────────────────────────────
    function getNoteContent() {
        const el = document.getElementById('NTUHWeb1_BlankNoteMainTab_txbBlankContnt');
        if (el && el.value.trim()) return el.value;
        return null;
    }

    // ─────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────
    function createUI() {
        if (!window.location.href.includes('InsertProgressNoteContent.aspx')) return;
        if (document.getElementById('ntuh-filler-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-filler-fab {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                background: #252d42;
                border: 2px solid #4a7cdc;
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
            #ntuh-filler-fab:hover {
                transform: scale(1.1);
                box-shadow: 0 6px 20px rgba(0,0,0,0.5);
            }
            #ntuh-filler-panel {
                position: fixed;
                bottom: 24px;
                right: 24px;
                width: 170px;
                background: #1a1f2e;
                border: 1px solid #2d3650;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                z-index: 99999;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 12px;
                color: #c8d3e8;
                overflow: hidden;
                display: none;
            }
            #ntuh-filler-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #252d42;
                border-bottom: 1px solid #2d3650;
                cursor: move;
                user-select: none;
                font-size: 13px;
                font-weight: 600;
                letter-spacing: 0.03em;
            }
            #ntuh-filler-close {
                background: none;
                border: none;
                color: #7a8aaa;
                cursor: pointer;
                font-size: 16px;
                padding: 0 4px;
                line-height: 1;
            }
            #ntuh-filler-close:hover { color: #e05c5c; }
            #ntuh-filler-body {
                padding: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            #ntuh-filler-input {
                width: 100%;
                height: 120px;
                background: #0f1420;
                border: 1px solid #2d3650;
                border-radius: 6px;
                color: #c8d3e8;
                font-family: 'Consolas', monospace;
                font-size: 11px;
                padding: 8px;
                resize: vertical;
                box-sizing: border-box;
                line-height: 1.5;
            }
            #ntuh-filler-input:focus {
                outline: none;
                border-color: #4a7cdc;
            }
            #ntuh-filler-body button {
                width: 100%;
                padding: 8px 0;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 11px;
                font-weight: 600;
                transition: opacity 0.15s;
            }
            #ntuh-filler-grab {
                background: #2d3650;
                color: #8fa8d8;
            }
            #ntuh-filler-grab:hover { opacity: 0.8; }
            #ntuh-filler-fill {
                background: #4a7cdc;
                color: #fff;
            }
            #ntuh-filler-fill:hover { opacity: 0.85; }
            #ntuh-filler-weekly {
                background: #5a3a8a;
                color: #d0b8ff;
            }
            #ntuh-filler-weekly:hover { opacity: 0.85; }
            #ntuh-filler-today {
                background: #2a4a3a;
                color: #7adba0;
            }
            #ntuh-filler-today:hover { opacity: 0.85; }
            #ntuh-filler-duty {
                background: #3a2a4a;
                color: #c89adc;
            }
            #ntuh-filler-duty:hover { opacity: 0.85; }
            .ntuh-divider {
                border: none;
                border-top: 1px solid #2d3650;
                margin: 4px 0;
            }
            #ntuh-filler-status {
                font-size: 11px;
                min-height: 16px;
            }
            #ntuh-filler-preview {
                display: none;
                background: #0f1420;
                border: 1px solid #2d3650;
                border-radius: 6px;
                padding: 8px;
                font-size: 10.5px;
                line-height: 1.6;
                max-height: 160px;
                overflow-y: auto;
            }
            .ntuh-ok   { color: #4caf7d; }
            .ntuh-err  { color: #e05c5c; }
            .ntuh-warn { color: #f0a030; }
            .ntuh-row {
                display: flex;
                justify-content: space-between;
                padding: 2px 0;
                border-bottom: 1px solid #1e2638;
            }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-filler-fab';
        fab.textContent = '📋';
        fab.title = 'Progress區工具';
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-filler-panel';
        panel.innerHTML = `
            <div id="ntuh-filler-header">
                <span>📋 筆記→Progress</span>
                <button id="ntuh-filler-close">✕</button>
            </div>
            <div id="ntuh-filler-body">
                <textarea id="ntuh-filler-input" placeholder="在此貼入筆記內容，或點「抓取」…"></textarea>
                <button id="ntuh-filler-grab">📥 抓取</button>
                <button id="ntuh-filler-today">📝 今日紀錄</button>
                <button id="ntuh-filler-fill">✨ 填入病程</button>
                <button id="ntuh-filler-weekly">📅 填入Weekly</button>
                <hr class="ntuh-divider">
                <button id="ntuh-filler-duty">🌙 Duty Note</button>
                <div id="ntuh-filler-status"></div>
                <div id="ntuh-filler-preview"></div>
            </div>
        `;
        document.body.appendChild(panel);

        fab.onclick = () => {
            fab.style.display = 'none';
            panel.style.display = 'block';
        };

        document.getElementById('ntuh-filler-close').onclick = () => {
            panel.style.display = 'none';
            fab.style.display = 'flex';
        };

        makeDraggable(panel, document.getElementById('ntuh-filler-header'));

        document.getElementById('ntuh-filler-grab').onclick = () => {
            const content = getNoteContent();
            if (content) {
                document.getElementById('ntuh-filler-input').value = content;
                setStatus('✓ 已從筆記區抓取內容', 'ok');
            } else {
                setStatus('⚠ 找不到筆記，請先開啟 Primary note', 'err');
            }
        };

        document.getElementById('ntuh-filler-today').onclick = () => {
            const text = document.getElementById('ntuh-filler-input').value.trim();
            if (!text) { setStatus('⚠ 請先抓取筆記內容', 'err'); return; }
            const result = prepareToday(text);
            if (result.ok) {
                const updated = document.getElementById('NTUHWeb1_BlankNoteMainTab_txbBlankContnt')?.value;
                if (updated) document.getElementById('ntuh-filler-input').value = updated;
                setStatus('✓ 今日紀錄準備完成！', 'ok');
            } else {
                setStatus('✗ ' + result.reason, 'err');
            }
        };

        document.getElementById('ntuh-filler-fill').onclick = () => {
            const text = document.getElementById('ntuh-filler-input').value.trim();
            if (!text) { setStatus('⚠ 請先貼入或抓取筆記內容', 'err'); return; }
            if (!document.getElementById('NTUHWeb1_ProgressNoteMainTab_txbSubject')) {
                setStatus('⚠ 請先點「新增Progress」開啟表單', 'err');
                return;
            }
            showResults(fillProgressNote(text));
        };

        document.getElementById('ntuh-filler-weekly').onclick = () => {
            const text = document.getElementById('ntuh-filler-input').value.trim();
            if (!text) { setStatus('⚠ 請先貼入或抓取筆記內容', 'err'); return; }
            if (!document.getElementById('NTUHWeb1_WeeklySummaryMainTab_txbDiagnosis')) {
                setStatus('⚠ 請先點「新增Weekly」開啟表單', 'err');
                return;
            }
            showResults(fillWeeklySummary(text));
        };

        document.getElementById('ntuh-filler-duty').onclick = () => {
            const result = fillDutyNote();
            if (result.ok) {
                setStatus('✓ 已填入 Duty Note 模板', 'ok');
            } else {
                setStatus('✗ ' + result.reason, 'err');
            }
        };
    }

    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-filler-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'ntuh-ok' : type === 'err' ? 'ntuh-err' : 'ntuh-warn';
    }

    function showResults(results) {
        const preview = document.getElementById('ntuh-filler-preview');
        if (!preview) return;
        preview.style.display = 'block';
        preview.innerHTML = results.map(r =>
            `<div class="ntuh-row">
                <span>${r.field}</span>
                <span class="${r.ok ? 'ntuh-ok' : 'ntuh-err'}">${r.ok ? '✓ 填入' : '✗ ' + (r.reason || '找不到欄位')}</span>
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
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(createUI, 1500));
    } else {
        setTimeout(createUI, 1500);
    }

})();
