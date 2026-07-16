// ==UserScript==
// @name         NTUH Progress Note Filler
// @namespace    http://tampermonkey.net/
// @version      1.37
// @description  從筆記區自動解析病程筆記並填入 Progress Note / Weekly Summary 欄位，並可一鍵填入 Duty Note 模板並暫存。今日更新／填入progress／填入weekly 三鍵按下時自動抓取 primary note（免先手動抓）；填入progress/weekly 並自動點「新增Progress/Weekly」開表單、確認 PAP 展開後填入。「抓取全部data」按鈕手動觸發 data-helper 引擎，取回十一來源（生命徵象/導管/照會/飲食/護理交班筆記/今日護理紀錄/影像/藥歷/處方/檢驗），以右側區塊＋左側兩區塊（交班筆記/今日護理紀錄）呈現。筆記須符合 primary note 格式（含 [Today's Events] / [Course] / [Assessment] / [Diagnosis] / [Plans] 區塊）。需搭配 progress-note-data-helper 使用。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
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

    function fillDutyNote(autoConfirm = true) {
        const contentId = 'NTUHWeb1_BlankNoteMainTab_txbBlankContnt';
        const titleId = 'NTUHWeb1_BlankNoteMainTab_txbBlankTitle';
        if (!document.getElementById(contentId)) {
            return { ok: false, reason: '找不到 Blank Note 欄位，請先切到該分頁' };
        }
        fillField(titleId, DUTY_TITLE);
        fillField(contentId, DUTY_TPL);
        document.getElementById(contentId).focus();
        if (autoConfirm) {
            setTimeout(() => {
                const saveBtn = document.getElementById('NTUHWeb1_BlankNoteMainTab_Button1');
                if (saveBtn) saveBtn.click();
            }, 300);
        }
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
    function fillProgressNote(noteText, autoConfirm = true) {
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

        if (autoConfirm) {
            setTimeout(() => {
                const saveBtn = document.getElementById('NTUHWeb1_ProgressNoteMainTab_btnConfirmProgressNote');
                if (saveBtn) saveBtn.click();
            }, 500);
        }

        return results;
    }

    // ─────────────────────────────────────────────
    // 填入 Weekly Summary
    // ─────────────────────────────────────────────
    function fillWeeklySummary(noteText, autoConfirm = true) {
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

        if (autoConfirm) {
            setTimeout(() => {
                const saveBtn = document.getElementById('NTUHWeb1_WeeklySummaryMainTab_btnSaveWeeklySummary');
                if (saveBtn) saveBtn.click();
            }, 500);
        }

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
                background: #2c5f54;
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
                width: 380px;
                background: #ffffff;
                border: 1px solid #9db98a;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                z-index: 99999;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 13px;
                color: #2b3a2b;
                overflow: hidden;
                display: none;
            }
            #ntuh-filler-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: #2c5f54;
                color: #fff;
                border-bottom: 1px solid #9db98a;
                cursor: move;
                user-select: none;
                font-size: 13px;
                font-weight: 600;
                letter-spacing: 0.03em;
            }
            #ntuh-filler-close {
                background: none;
                border: none;
                color: #dfe8d4;
                cursor: pointer;
                font-size: 16px;
                padding: 0 4px;
                line-height: 1;
            }
            #ntuh-filler-close:hover { color: #e05c5c; }
            #ntuh-filler-body {
                padding: 16px;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-height: 82vh;
                overflow-y: auto;
            }
            #ntuh-filler-notestatus {
                width: 100%;
                box-sizing: border-box;
                background: #ffffff;
                border: 1px solid #9db98a;
                border-left: 3px solid #4a5a72;
                border-radius: 6px;
                color: #5f6f57;
                font-size: 12px;
                padding: 9px 12px;
                line-height: 1.4;
            }
            #ntuh-filler-notestatus.ok   { border-left-color: #4caf7d; color: #4caf7d; }
            #ntuh-filler-notestatus.err  { border-left-color: #e05c5c; color: #e05c5c; }
            #ntuh-filler-notestatus.warn { border-left-color: #f0a030; color: #cf8a1e; }
            #ntuh-filler-body button {
                width: 100%;
                padding: 10px 0;
                border: none;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: opacity 0.15s;
            }
            #ntuh-filler-fillrow {
                display: flex;
                flex-direction: column;
                gap: 3px;
            }
            #ntuh-filler-fillrow button { width: 100%; margin-top: 5px; }
            #ntuh-filler-fillrow button:first-child { margin-top: 0; }
            .ntuh-hint {
                font-size: 10px;
                color: #6a7a62;
                line-height: 1.35;
                margin: 1px 2px 0;
            }
            .ntuh-hint-top {
                margin: 0 2px 2px;
                color: #b0692a;
            }
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
            #ntuh-filler-grab-outer {
                background: #e8862e;
                color: #fff;
            }
            #ntuh-filler-grab-outer:hover { opacity: 0.85; }
            #ntuh-filler-grab-outer:disabled { opacity: 0.5; cursor: wait; }
            #ntuh-filler-grabrow { display: flex; gap: 8px; }
            #ntuh-filler-grabrow button { flex: 1; width: auto; }
            #ntuh-filler-outer { display: flex; flex-direction: column; gap: 7px; }
            .ntuh-grp {
                font-size: 11px;
                color: #4a5a72;
                letter-spacing: 0.08em;
                margin-top: 4px;
            }
            .ntuh-blk {
                background: #ffffff;
                border: 1px solid #9db98a;
                border-radius: 8px;
                overflow: hidden;
            }
            .ntuh-blk-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 6px 10px;
                background: #2c5f54;
                font-size: 12px;
                font-weight: 600;
                cursor: pointer;
                user-select: none;
            }
            .ntuh-blk-copy {
                background: none;
                border: none;
                color: #cfe0d6;
                cursor: pointer;
                width: 34px !important;
                height: 34px;
                margin: -6px -4px -6px auto;
                font-size: 21px;
                padding: 0;
                line-height: 1;
                border-radius: 6px;
                display: flex;
                align-items: center;
                justify-content: center;
                flex: 0 0 auto;
            }
            .ntuh-blk-copy:hover { color: #2c5f54; background: #e3ecd9; }
            .ntuh-blk-body {
                margin: 0;
                padding: 8px 10px;
                white-space: pre-wrap;
                word-break: break-word;
                font-size: 12px;
                line-height: 1.55;
                max-height: 260px;
                overflow-y: auto;
            }
            .ntuh-blk-body-compact {
                font-size: 9.6px;
            }
            .ntuh-divider {
                border: none;
                border-top: 1px solid #9db98a;
                margin: 4px 0;
            }
            .ntuh-linkable { cursor: pointer; }
            .ntuh-linkable:hover { text-decoration: underline; }
            /* 左側面板（交班筆記，之後再塞護理紀錄）：寬 160px，高度貼滿與右側 UI 對齊，同開同關 */
            #ntuh-handover-left {
                position: fixed;
                top: 44px;
                bottom: 24px;
                left: 24px;
                width: 160px;
                background: #ffffff;
                border: 1px solid #9db98a;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                z-index: 99999;
                font-family: 'Consolas', 'Courier New', monospace;
                font-size: 12px;
                color: #2b3a2b;
                overflow: hidden;
                display: none;
                flex-direction: column;
            }
            #ntuh-handover-left .hl-head {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 12px;
                background: #2c5f54;
                border-bottom: 1px solid #9db98a;
                font-size: 12px;
                font-weight: 600;
                color: #7adba0;
                flex: 0 0 auto;
            }
            #ntuh-handover-left .hl-head2 {
                border-top: 1px solid #9db98a;
                color: #f0a860;
            }
            #ntuh-handover-left .hl-body {
                margin: 0;
                padding: 10px 12px;
                white-space: pre-wrap;
                word-break: break-word;
                font-size: 12px;
                line-height: 1.55;
                flex: 1;
                min-height: 0;
                overflow-y: auto;
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
                <div class="ntuh-hint ntuh-hint-top">＊需先在左上方筆記區新增 primary note 才能自動填寫</div>
                <div id="ntuh-filler-notestatus">尚未抓取 primary note（按下方按鍵時自動抓取）</div>
                <div id="ntuh-filler-fillrow">
                    <button id="ntuh-filler-today">📝 今日更新</button>
                    <div class="ntuh-hint">將舊的 today's event 內容移到最下方，日期換成今天</div>
                    <button id="ntuh-filler-fill">✨ 填入 progress</button>
                    <div class="ntuh-hint">自動新增 progress，將 primary note 內容依序貼上後確認</div>
                    <button id="ntuh-filler-weekly">📅 填入weekly</button>
                    <div class="ntuh-hint">自動新增 weekly，將 primary note 內容依序貼上後暫存</div>
                    <button id="ntuh-filler-duty">🌙 Duty note</button>
                    <div class="ntuh-hint">自動新增 free note，將模板內容貼上後暫存</div>
                </div>
                <hr class="ntuh-divider">
                <div id="ntuh-filler-grabrow">
                    <button id="ntuh-filler-grab-outer">🔄 抓取全部data</button>
                </div>
                <div id="ntuh-filler-outer"></div>
            </div>
        `;
        document.body.appendChild(panel);

        // 左側「交班筆記」面板（與右側 UI 同開同關）
        const hLeft = document.createElement('div');
        hLeft.id = 'ntuh-handover-left';
        hLeft.innerHTML = `
            <div class="hl-head"><span id="ntuh-hl-handover-title">🗒 交班筆記</span></div>
            <pre class="hl-body" id="ntuh-hl-handover">尚未抓取（按右側「抓取全部data」）</pre>
            <div class="hl-head hl-head2"><span id="ntuh-hl-nursing-title">📋 今日護理紀錄</span></div>
            <pre class="hl-body" id="ntuh-hl-nursing">尚未抓取</pre>`;
        document.body.appendChild(hLeft);

        fab.onclick = () => {
            fab.style.display = 'none';
            panel.style.display = 'block';
            // 左側面板只在抓過 data 後才顯示（重開面板時沿用已抓的內容）
            if (hLeft.dataset.grabbed === '1') hLeft.style.display = 'flex';
        };

        document.getElementById('ntuh-filler-close').onclick = () => {
            panel.style.display = 'none';
            hLeft.style.display = 'none';
            fab.style.display = 'flex';
        };

        makeDraggable(panel, document.getElementById('ntuh-filler-header'));

        // 今日更新：自動抓 primary note → 做今日紀錄
        document.getElementById('ntuh-filler-today').onclick = () => {
            const text = grabPrimaryNote();
            if (!text) { setStatus('⚠ 找不到 primary note，請先開啟筆記', 'err'); return; }
            const result = prepareToday(text);
            if (result.ok) {
                setStatus('✓ 成功更新今日', 'ok');
            } else {
                setStatus('✗ ' + result.reason, 'err');
            }
        };

        // 填入 progress：自動抓 primary note → 點「新增Progress」→ 確認 PAP 展開 → 填入
        document.getElementById('ntuh-filler-fill').onclick = async (e) => {
            const btn = e.currentTarget;
            const text = grabPrimaryNote();
            if (!text) { setStatus('⚠ 找不到 primary note，請先開啟筆記', 'err'); return; }
            btn.disabled = true;
            try {
                setStatus('💾 儲存 primary note…', 'warn');
                await savePrimaryNote();                                     // 先存 primary note，等存好再開表單
                await clickAndWaitPostback('NTUHWeb1_btnInsertProgressNote'); // 開新 Progress 表單，等 postback 完成
                if (!await waitForEl('NTUHWeb1_ProgressNoteMainTab_txbSubject')) {
                    setStatus('✗ Progress 表單未出現', 'err'); return;
                }
                await ensureProgressPAP();                                          // 確認 PAP 展開，缺則點「新增PAP」
                // 填入 → 驗證沒被後續重繪洗掉（sentinel: txbBSIBundle 恆為 'nil'）→ 穩住才確認
                {
                    const r = await fillStable(() => fillProgressNote(text, false),
                        'NTUHWeb1_ProgressNoteMainTab_txbBSIBundle');
                    if (r.ok) {
                        document.getElementById('NTUHWeb1_ProgressNoteMainTab_btnConfirmProgressNote')?.click();
                        setStatus('✓ 成功填入 progress', 'ok');
                    } else {
                        setStatus('⚠ 填入後被系統清空，未自動確認，請檢查後手動確認', 'warn');
                    }
                }
            } finally { btn.disabled = false; }
        };

        // 填入 weekly：自動抓 primary note → 點「新增Weekly」→ 填入
        document.getElementById('ntuh-filler-weekly').onclick = async (e) => {
            const btn = e.currentTarget;
            const text = grabPrimaryNote();
            if (!text) { setStatus('⚠ 找不到 primary note，請先開啟筆記', 'err'); return; }
            btn.disabled = true;
            try {
                setStatus('💾 儲存 primary note…', 'warn');
                await savePrimaryNote();                                            // 先存 primary note，等存好再開表單
                await clickAndWaitPostback('NTUHWeb1_btnInsertWeeklySummaryNote'); // 開新 Weekly 表單
                if (!await waitForEl('NTUHWeb1_WeeklySummaryMainTab_txbDiagnosis')) {
                    setStatus('✗ Weekly 表單未出現', 'err'); return;
                }
                await waitPostbacksSettle(); // 等第一次新增 weekly 的延遲重繪結束，再填才不會被清空
                // 填入 → 驗證沒被洗掉（sentinel: txbBriefSummary 恆有 prompt 前綴）→ 穩住才確認
                {
                    const r = await fillStable(() => fillWeeklySummary(text, false),
                        'NTUHWeb1_WeeklySummaryMainTab_txbBriefSummary');
                    if (r.ok) {
                        document.getElementById('NTUHWeb1_WeeklySummaryMainTab_btnSaveWeeklySummary')?.click();
                        setStatus('✓ 成功填入 weekly', 'ok');
                    } else {
                        setStatus('⚠ 填入後被系統清空，未自動確認，請檢查後手動確認', 'warn');
                    }
                }
            } finally { btn.disabled = false; }
        };

        // 「抓取全部data」：手動觸發 data-helper 引擎，結果進右側區塊＋左側面板
        document.getElementById('ntuh-filler-grab-outer').onclick = async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try { await grabAll(); } finally { btn.disabled = false; }
        };

        // Duty note：自動點「新增Note」開 free note → 貼模板 → 暫存
        document.getElementById('ntuh-filler-duty').onclick = async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
                await clickAndWaitPostback('NTUHWeb1_btnInsertBlankNote'); // 開新 free note
                if (!await waitForEl('NTUHWeb1_BlankNoteMainTab_txbBlankContnt')) {
                    setStatus('✗ Note 表單未出現', 'err'); return;
                }
                const r = await fillStable(() => fillDutyNote(false),
                    'NTUHWeb1_BlankNoteMainTab_txbBlankContnt');
                if (r.ok) {
                    document.getElementById('NTUHWeb1_BlankNoteMainTab_Button1')?.click();
                    setStatus('✓ 成功填入 duty note', 'ok');
                } else {
                    setStatus('⚠ 填入後被系統清空，未自動暫存，請檢查後手動暫存', 'warn');
                }
            } finally { btn.disabled = false; }
        };

        // 先畫出資料區骨架（群組＋分項標題，收合、顯示「尚未抓取」），不用等 data
        renderBlocks();
    }

    // 區塊分組：key → 群組（顏色對應面板卡標題）
    const BLOCK_GROUPS = [
        { title: '生命徵象',   keys: ['tprbp', 'resp', 'gcs', 'uo', 'pain'], color: '#6fd0e0' },
        { title: '管路 · 照護', keys: ['catheter', 'consult', 'diet'], color: '#7adba0' },
        { title: '藥物 · 報告', keys: ['rx', 'meds', 'lab', 'image'],  color: '#f0a860' },
    ];
    // key → 標題（供抓取前先畫骨架用；抓取後結果自帶 label 亦同）
    const KEY_LABELS = {
        tprbp: '[TPR+BP]', resp: '[Resp]', gcs: '[GCS]', uo: '[UO]', pain: '[Pain]',
        catheter: '[Tubes]', consult: '[Consult]', diet: '[Diet]',
        rx: '[Rx]', meds: '[Abx]', lab: '[Lab]', image: '[Image]',
    };

    function renderBlocks(results) {
        const wrap = document.getElementById('ntuh-filler-outer');
        if (!wrap) return;
        wrap.innerHTML = '';
        const byKey = {};
        (results || []).forEach((r) => { byKey[r.key] = r; });

        // 交班筆記 + 今日護理紀錄 → 灌進左側面板兩區塊（不進右側區塊）
        const setLeft = (id, r, emptyMsg) => {
            const el = document.getElementById(id);
            if (el && r) el.textContent = r.ok ? (r.text || emptyMsg) : ('抓取失敗：' + r.error);
        };
        setLeft('ntuh-hl-handover', byKey['handover'], '（無交班筆記）');
        setLeft('ntuh-hl-nursing', byKey['nursing'], '（今日無護理紀錄）');

        // 左側標題點擊跳轉對應頁面（交班 / 護理紀錄）
        const wireLeftTitle = (titleId, baseText, r) => {
            const el = document.getElementById(titleId);
            if (!el || !r || !r.url) return;
            el.textContent = baseText + ' ↗';
            el.classList.add('ntuh-linkable');
            el.title = '開啟對應頁面';
            el.onclick = () => window.open(r.url, '_blank');
        };
        wireLeftTitle('ntuh-hl-handover-title', '🗒 交班筆記', byKey['handover']);
        wireLeftTitle('ntuh-hl-nursing-title', '📋 今日護理紀錄', byKey['nursing']);

        // 抓過 data 後才顯示左側面板（並記住，重開面板時沿用）
        const hLeftEl = document.getElementById('ntuh-handover-left');
        if (hLeftEl && (byKey['handover'] || byKey['nursing'])) {
            hLeftEl.dataset.grabbed = '1';
            hLeftEl.style.display = 'flex';
        }

        BLOCK_GROUPS.forEach((g) => {
            // 永遠畫出全部群組與分項（骨架）；有抓到才展開填入，沒抓到收合顯示「尚未抓取」
            const grp = document.createElement('div');
            grp.className = 'ntuh-grp';
            grp.textContent = g.title;
            wrap.appendChild(grp);

            g.keys.forEach((k) => {
                const r = byKey[k];
                const label = KEY_LABELS[k] || k;
                const text = !r ? '尚未抓取'
                    : (r.ok ? (r.text || '（無資料）') : ('抓取失敗：' + r.error));

                const card = document.createElement('div');
                card.className = 'ntuh-blk';
                const head = document.createElement('div');
                head.className = 'ntuh-blk-head';
                const title = document.createElement('span');
                title.textContent = label + (r && !r.ok ? ' ✗' : '') + (r && r.url ? ' ↗' : '');
                title.style.color = !r ? '#8a9a80' : (r.ok ? g.color : '#e05c5c');
                if (r && r.url) {
                    title.classList.add('ntuh-linkable');
                    title.title = '開啟對應頁面';
                    title.onclick = (ev) => { ev.stopPropagation(); window.open(r.url, '_blank'); };
                }
                const copy = document.createElement('button');
                copy.className = 'ntuh-blk-copy';
                copy.textContent = '⧉';
                copy.title = '複製這段';
                head.appendChild(title);
                head.appendChild(copy);

                const body = document.createElement('pre');
                body.className = 'ntuh-blk-body';
                if (['rx', 'meds', 'lab', 'image'].includes(k)) {
                    body.classList.add('ntuh-blk-body-compact');
                }
                body.textContent = text;
                body.style.display = r ? 'block' : 'none'; // 抓到才展開，骨架先收合

                copy.onclick = (ev) => {
                    ev.stopPropagation();
                    navigator.clipboard.writeText(label + '\n' + text).then(() => {
                        copy.textContent = '✓';
                        setTimeout(() => { copy.textContent = '⧉'; }, 1200);
                    });
                };
                head.onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };

                card.appendChild(head);
                card.appendChild(body);
                wrap.appendChild(card);
            });
        });
    }

    // 抓 primary note，回傳內容（無則回 null）。狀態統一由 setStatus（上方狀態框）呈現
    function grabPrimaryNote() {
        return getNoteContent() || null;
    }

    // 儲存 primary note（blank note，存法同今日更新的 Button1），等 postback 完成再往下
    async function savePrimaryNote() {
        const btn = document.getElementById('NTUHWeb1_BlankNoteMainTab_Button1');
        if (!btn) return false;
        await clickAndWaitPostback('NTUHWeb1_BlankNoteMainTab_Button1');
        return true;
    }

    // 觸發 data-helper 背景抓取，回傳 Promise（結果進面板；逾時則略過續行不卡住）
    function grabAll() {
        return new Promise((resolve) => {
            setStatus('🔄 背景抓取中…（約需數秒）', 'warn');
            try { localStorage.removeItem('ntuh_datahelper_result'); } catch (e) { /* noop */ }
            let done = false;
            const finish = (results) => {
                if (done) return; done = true;
                document.removeEventListener('ntuh-datahelper-result', onResult);
                clearTimeout(to);
                resolve(results);
            };
            const onResult = () => {
                let results = [];
                try { results = JSON.parse(localStorage.getItem('ntuh_datahelper_result') || '[]'); } catch (e) { results = []; }
                try { localStorage.removeItem('ntuh_datahelper_result'); } catch (e) { /* noop */ }
                renderBlocks(results);
                const ok = results.filter((r) => r.ok).length;
                setStatus(ok === results.length ? '✓ 抓取完成' : `部分成功（${ok}/${results.length}）`,
                    ok === results.length ? 'ok' : 'warn');
                finish(results);
            };
            const to = setTimeout(() => {
                setStatus('⚠ data-helper 無回應，略過抓取續行', 'warn');
                finish(null);
            }, 45000);
            document.addEventListener('ntuh-datahelper-result', onResult);
            document.dispatchEvent(new CustomEvent('ntuh-datahelper-grab'));
        });
    }

    // 點 ASP.NET 按鈕並等其 UpdatePanel 非同步 postback 完成（否則會搶在新 note 建好前就填+存）
    function clickAndWaitPostback(btnId, timeout = 8000) {
        return new Promise((resolve) => {
            const btn = document.getElementById(btnId);
            if (!btn) return resolve(false);
            let settled = false;
            const done = (ok) => { if (settled) return; settled = true; resolve(ok); };
            try {
                const prm = window.Sys && window.Sys.WebForms && window.Sys.WebForms.PageRequestManager.getInstance();
                if (prm) {
                    const handler = () => { prm.remove_endRequest(handler); setTimeout(() => done(true), 150); };
                    prm.add_endRequest(handler);
                    btn.click();
                    setTimeout(() => done(true), timeout); // 保險：沒收到 endRequest 也放行
                } else {
                    btn.click();
                    setTimeout(() => done(true), 800);
                }
            } catch (e) { btn.click(); setTimeout(() => done(true), 800); }
        });
    }

    // 等所有 UpdatePanel postback 安靜下來（begin/endRequest 連續 quietMs 無動靜才放行）。
    // 用途：新增 Weekly 第一次會有「延遲重繪」，只等單一 endRequest 會搶在它之前填→被清空。
    function waitPostbacksSettle(quietMs = 1300, maxWait = 9000) {
        return new Promise((resolve) => {
            const prm = window.Sys && window.Sys.WebForms && window.Sys.WebForms.PageRequestManager.getInstance();
            if (!prm) return setTimeout(resolve, 400);
            let last = Date.now();
            const bump = () => { last = Date.now(); };
            prm.add_beginRequest(bump);
            prm.add_endRequest(bump);
            const start = Date.now();
            const iv = setInterval(() => {
                if (Date.now() - last >= quietMs || Date.now() - start > maxWait) {
                    clearInterval(iv);
                    prm.remove_beginRequest(bump);
                    prm.remove_endRequest(bump);
                    resolve();
                }
            }, 200);
        });
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // 填入後可能被「新增 note 的後續非同步重繪」洗掉 → 填→等→驗證 sentinel 欄位仍有值。
    // weekly 的重繪較晚，單次檢查會誤判「穩了」→要求**連續兩次**檢查都在才算真穩；
    // 被洗就重填，穩不住則回 ok:false 讓呼叫端別自動確認（避免存空表）。
    const stillHas = (id) => { const el = document.getElementById(id); return !!(el && (el.value || '').trim()); };
    async function fillStable(fillFn, sentinelId, tries = 5) {
        let results = fillFn();
        for (let i = 0; i < tries; i++) {
            await sleep(600);
            if (!stillHas(sentinelId)) { results = fillFn(); continue; } // 被洗→重填
            await sleep(600);
            if (stillHas(sentinelId)) return { results, ok: true };      // 連兩次都在＝真穩
            results = fillFn();                                          // 較晚被洗→重填
        }
        return { results, ok: false };
    }

    // 輪詢等某 id 元素出現（局部更新後表單/欄位是 async 塞進 DOM）
    function waitForEl(id, timeout = 6000) {
        return new Promise((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                const el = document.getElementById(id);
                if (el) return resolve(el);
                if (Date.now() - t0 > timeout) return resolve(null);
                setTimeout(tick, 150);
            };
            tick();
        });
    }

    // 確認 Progress 的 PAP 已「展開且可見」再填。
    // 注意：ucPAP_example 是隱藏的 PAP 模板（display:none），Problem1 恆存在但隱藏——
    // 只看「存在」會誤判已就緒，收合狀態下 fill 的值不會被存進去。故改看「可見(offsetParent)」，
    // 不可見就點「新增PAP」(Button1 / InsertPAPTab)展開，等它變可見再填。
    async function ensureProgressPAP() {
        const id = 'NTUHWeb1_ProgressNoteMainTab_ucPAP_txbProblem1';
        const visible = () => { const el = document.getElementById(id); return !!(el && el.offsetParent !== null); };
        if (visible()) return true;
        document.getElementById('Button1')?.click(); // InsertPAPTab('progress') → 展開成可見的真 PAP
        for (let i = 0; i < 40 && !visible(); i++) await sleep(150); // 等變可見（最多 ~6s）
        return visible();
    }

    // 狀態一律顯示在上方的 primary note 狀態框（class 控制左邊框顏色）
    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-filler-notestatus');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'ok' : type === 'err' ? 'err' : type === 'warn' ? 'warn' : '';
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
