// ==UserScript==
// @name         NTUH Discharge Note Filler(OPH ver)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  自動填入出院病摘各欄位，並自動帶入檢驗結果；轉出日期帶今日、住院醫師／主治醫師員編自動帶入；以入院紀錄 Ditto 帶入檢查紀錄／影像報告；以 PAP.asmx 直接取最新病程 Assessment（不開視窗）
// @author       潘岳彤 modify for OPH
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertDisChargeNoteContent.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertDisChargeNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/ExternalPage/DWHistoricalLabReport.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/ElectronicMedicalReportViewer/ExternalPage/DWHistoricalLabReport.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler-oph.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler-oph.user.js
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const PREFIX = 'NTUHWeb1_DischargeNoteTab1_TabContainer1_';
    const PROGRESS_PREFIX = 'NTUHWeb1_ProgressNoteMainTab_';
    // 頁面上方（表頭）欄位：注意這批 id 沒有 TabContainer1
    const HEADER_PREFIX = 'NTUHWeb1_DischargeNoteTab1_';
    const TXB_TRANSFER_IN = HEADER_PREFIX + 'txbTransferInDate';
    const TXB_TRANSFER_OUT = HEADER_PREFIX + 'txbTransferOutDate';
    const TXB_CR = HEADER_PREFIX + 'txbCR';   // 住院醫師員編（onchange 會 __doPostBack）
    const LBL_CR = HEADER_PREFIX + 'lblCR';
    const TXB_VS = HEADER_PREFIX + 'txbVS';   // 主治醫師員編（onchange 會 __doPostBack）
    const LBL_VS = HEADER_PREFIX + 'lblVS';
    const CAPTURE_PARAM = 'ntuhDischargeAssessmentCapture';

    // 檢驗報告（A 案：開 DWHistoricalLabReport → 帶入 → 母頁「解析資料」）
    // 實測：btnPop4thReport 會 postback 開子視窗（hfdStartDate=入院日、hfdEndDate=今日、
    // hfdTextBox=NTUHWeb1_DischargeNote…）；子視窗帶入後資料落在 hdParsingLabData，
    // 需再按 btnParsingLabData 才寫進 tplGI_txbGI。
    const BTN_LAB_POP = PREFIX + 'tplGI_btnPop4thReport';
    const BTN_LAB_PARSE = PREFIX + 'tplGI_btnParsingLabData';
    const HD_LAB_DATA = PREFIX + 'tplGI_hdParsingLabData';
    const LS_LAB_JOB = 'ntuh_disch_lab_job';
    const LS_AFTER = 'ntuh_disch_after'; // 員編 postback 鏈跑完後要接什麼：'lab' | 'defaults'

    // 入院紀錄 Ditto：與 progress-note-filler 同一支後端服務
    const NOTE_TABLE_URL = '/WebApplication/InPatient/Ward/ProgressNoteControl/Service/Notes.asmx/GetNoteTableContent';
    const PAP_URL = '/WebApplication/InPatient/Ward/ProgressNoteControl/Service/PAP.asmx/GetProgressNotePAP';
    const ADMISSION_NOTE_TYPE = 'admission';
    const PROGRESS_NOTE_TYPE = 'progress';
    const ADMISSION_EMR_DOC_CODE = 'A00014'; // 入院紀錄的 EMR 文件代碼
    const EBOARD_URL = '/WebApplication/EBoard/EBoardInfoHandler.ashx';
    const VSR_URL = '/WebApplication/MedicalRecordManagement/WardSetVSRS.aspx';

    // localStorage：VS 姓名 → 員編（查過就記住）、員編欄位 id 對應
    const LS_VS_MAP = 'ntuh_disch_vs_empno_map';
    const LS_TARGETS = 'ntuh_disch_empno_targets';

    let pendingAssessmentImport = null;
    let dischargeDefaultsScheduled = false;

    // ─────────────────────────────────────────────
    // 欄位寫入
    // ─────────────────────────────────────────────
    function setValue(el, value) {
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        return true;
    }

    function fillField(id, value) {
        const el = document.getElementById(id);
        if (!el) { console.warn('[DischFiller] 找不到欄位：', id); return false; }
        return setValue(el, value);
    }

    // 只發 input、不發 change：給 onchange 會 __doPostBack 的欄位用，
    // 避免在讀取資料途中觸發 postback 打斷流程。
    function setQuiet(el, value) {
        if (!el) return false;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    function getEl(id) {
        return document.getElementById(id);
    }

    // 手術日期與術式寫在「手術」textarea 內，從標籤行解析。
    function getOperationDetails() {
        const operationField = getEl(PREFIX + 'tplOP_txbOP');
        const lines = operationField ? operationField.value.split(/\r?\n/) : [];

        const dateLine = lines.find(line => /^\s*Operation\s+Date\s*:/i.test(line)) || '';
        const dateMatch = dateLine.match(/Operation\s+Date\s*:\s*(\d{4}\/\d{2}\/\d{2})/i);

        const methodLineIndex = lines.findIndex(line => /^\s*Operative\s+Method\s*:/i.test(line));
        let method = '';
        if (methodLineIndex >= 0) {
            const firstLine = lines[methodLineIndex].replace(/^\s*Operative\s+Method\s*:\s*/i, '').trim();
            const methodLines = firstLine ? [firstLine] : [];
            for (let i = methodLineIndex + 1; i < lines.length; i++) {
                if (/^\s*Operative\s+Findings\s*:/i.test(lines[i])) break;
                if (lines[i].trim()) methodLines.push(lines[i].trim());
            }
            method = methodLines.join(' ').trim();
        }

        return { method, date: dateMatch ? dateMatch[1] : '' };
    }

    // ─────────────────────────────────────────────
    // 填入出院病摘（同步欄位）
    // ─────────────────────────────────────────────
    function fillDischargeNote() {
        const operation = getOperationDetails();
        const results = [];

        const f = (label, suffix, value) =>
            results.push({ field: label, ok: fillField(PREFIX + suffix, value) });

        const fNilIfEmpty = (label, suffix) => {
            const el = getEl(PREFIX + suffix);
            if (el && !el.value.trim()) {
                results.push({ field: label, ok: fillField(PREFIX + suffix, 'nil') });
            }
        };

        // 出院診斷：保留欄位原有預設診斷，並在最前方新增手術狀態句。
        const operationDiagnosis = operation.method
            ? `status post ${operation.method}${operation.date ? ` on ${operation.date}` : ''}`
            : '';
        const diagnosisField = getEl(PREFIX + 'tplCD_txbCD');
        const originalDiagnosis = diagnosisField ? diagnosisField.value.trim() : '';
        const diagnosisParts = [originalDiagnosis].filter(Boolean);

        // 出院診斷：同一手術日期已存在就不插入（以日期去重，不懂術式寫法差異）
        const operationDateKey = operation.date || '';
        const sameDateInDiagnosis = !!operationDateKey &&
            originalDiagnosis.indexOf(operationDateKey) >= 0;
        const hasSameSentence = !!operationDiagnosis &&
            originalDiagnosis.toLowerCase().includes(operationDiagnosis.toLowerCase());
        if (operationDiagnosis && !sameDateInDiagnosis && !hasSameSentence) {
            diagnosisParts.unshift(operationDiagnosis);
        }

        const diagnosis = diagnosisParts.join('\n');
        if (diagnosis) {
            f('出院診斷', 'tplCD_txbCD', diagnosis);
        }

        // 轉出加護病房診斷 ← 空白才填 nil
        fNilIfEmpty('轉出加護病房診斷', 'tplCI_txbCI');

        // 手術 ← 空白填 nil
        fNilIfEmpty('手術', 'tplOP_txbOP');

        // 住院治療經過 ← 空白才寫（已有內容一律不覆蓋）
        const courseEl = getEl(PREFIX + 'tplCM_txbCM');
        const courseCurrent = courseEl ? String(courseEl.value || '').trim() : '';
        if (courseEl && !courseCurrent) {
            const courseTemplate = operation.method
                ? `Upon admission, the patient underwent pre-operative survey. No absolute contraindication was noted, so the patient received ${operation.method}${operation.date ? ` on ${operation.date}` : ''} smoothly. Under relatively stable condition, the patient was discharged with further outpatient clinic follow-up.`
                : 'please write a course note according to the following data, with correct time sequence. Write like NEJM in 3 paragraphs, and use date format as YYYY/MM/DD';
            f('住院治療經過', 'tplCM_txbCM', courseTemplate);
        } else if (courseEl) {
            results.push({ field: '住院治療經過', ok: true, reason: '已有內容，未覆蓋' });
        }

        // 併發症 ← 空白才填 nil
        fNilIfEmpty('併發症', 'tplCO_txbCO');

        // 檢驗紀錄（GI）與檢查紀錄（SI）是不同欄位；檢查紀錄／影像報告稍後由入院紀錄 Ditto 帶入。
        // 檢驗紀錄不在此填 nil：等檢驗帶入流程結束（成功或略過）才補 nil，避免「nil + 正式資料」。
        fNilIfEmpty('檢查紀錄', 'tplSI_txbSI');
        fNilIfEmpty('影像報告', 'tplRR_txbRR');
        fNilIfEmpty('病理報告', 'tplPA_txbPA');

        // 轉入日期由系統帶入，不覆蓋；空白時提醒人工確認
        const transferIn = getEl(TXB_TRANSFER_IN);
        if (transferIn && !transferIn.value.trim()) {
            results.push({ field: '轉入日期', ok: false, reason: '頁面未帶入，請人工確認' });
        }
        // 轉出日期：帶入今日（已有值則保留）
        const transferOut = getEl(TXB_TRANSFER_OUT);
        if (transferOut) {
            if (!transferOut.value.trim()) {
                results.push({
                    field: '轉出日期',
                    ok: setQuiet(transferOut, todayTaipei()),
                    reason: todayTaipei()
                });
            } else {
                results.push({ field: '轉出日期', ok: true, reason: '已有 ' + transferOut.value.trim() });
            }
        }

        // 檢驗紀錄空白時已填入 nil，不自動開啟住院期間檢驗報告。
        return results;
    }

    // 入院紀錄 Ditto 寫入：空白或原為 nil → 覆蓋；已有內容 → 附加（不覆蓋人工文字）
    function fillFromAdmission(label, suffix, text) {
        const el = getEl(PREFIX + suffix);
        if (!el) return { field: label, ok: false, reason: '找不到欄位' };
        const value = String(text || '').trim();
        if (!value) return { field: label, ok: false, reason: '入院紀錄無此段內容' };
        if (value.toLowerCase() === 'nil') {
            return { field: label, ok: true, reason: '入院紀錄為 nil，維持 nil' };
        }

        const current = String(el.value || '').trim();
        // 系統已帶入正式報告時不覆蓋、也不附加
        if (current && current.toLowerCase() !== 'nil') {
            return { field: label, ok: true, reason: '已有正式報告，未覆蓋' };
        }
        setValue(el, value);
        return { field: label, ok: true, reason: '由入院紀錄帶入' };
    }

    // ─────────────────────────────────────────────
    // 入院紀錄 Ditto：頁面參數
    // ─────────────────────────────────────────────
    function pageHiddenValue(ids) {
        for (let i = 0; i < ids.length; i++) {
            const el = document.getElementById(ids[i]);
            if (el && String(el.value || '').trim()) return String(el.value).trim();
        }
        return '';
    }

    // 自己的員編：頁面 hidden → 病歷清單的 loginempno（實測該列有此屬性）
    async function getOwnEmpNo() {
        const fromHidden = pageHiddenValue([
            'hiddenSkEmpNO', 'hiddenSkEmpNo', 'hidLoginEmpNo', 'hidLoginEmpNO',
            'hidEmpNo', 'loginEmpNo', 'hidLoginEmpNoRunatServer'
        ]);
        if (fromHidden) return fromHidden;
        try {
            const rows = await getNoteRows();
            const withLogin = rows.find((row) => row.loginEmpNo);
            if (withLogin) return withLogin.loginEmpNo;
        } catch (e) { /* 清單拿不到就放棄 */ }
        return '';
    }

    function pageQueryValue(name) {
        try {
            return new URLSearchParams(window.location.search).get(name) || '';
        } catch (e) { return ''; }
    }

    function getQueryParamIgnoreCase(params, name) {
        const target = name.toLowerCase();
        for (const [key, value] of params.entries()) {
            if (key.toLowerCase() === target) return value;
        }
        return '';
    }

    // 院區碼：AccountIDSE 為數字後接兩碼院區，例：YYT0xxxxxx → T0
    function hospitalOfAccount(accountIdse) {
        const m = String(accountIdse || '').trim().match(/^\d*(\D.)/);
        return m ? m[1] : '';
    }

    function todayTaipei() {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
        }).formatToParts(new Date());
        const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        return `${v.year}/${v.month}/${v.day}`;
    }

    // 入院紀錄的 CaseSeqNo / Version：優先找頁面上的 Type=admission;…;Version=…
    function findAdmissionDescriptor() {
        let html = '';
        try { html = document.documentElement ? document.documentElement.innerHTML : ''; } catch (e) { return null; }
        const m = /Type=admission;CaseSeqNo=(\d+);[^'"<]*?Version=(\d+)/i.exec(html);
        return m ? { caseSeqNo: m[1], version: m[2] } : null;
    }

    // 候選請求：①病歷清單的入院紀錄（caseseqno／version／emrdoccode 都是實際值）
    //           ②頁面描述子／hidden ③由最新版往回試
    async function buildAdmissionRequests() {
        const accountIdse = pageQueryValue('AccountIDSE') || pageHiddenValue(['hidAccountNo', 'hiddenAccountNo']);
        const empNo = await getOwnEmpNo();
        if (!accountIdse || !empNo) return [];

        const completeFlag = pageHiddenValue(['hiddenCompleteFlag']) || 'V';
        const requests = [];
        const seen = {};
        const push = (caseSeqNo, version, emrDocCode) => {
            if (!caseSeqNo) return;
            const key = caseSeqNo + '/' + version;
            if (seen[key]) return;
            seen[key] = true;
            requests.push({
                accountIdse,
                empNo,
                completeFlag,
                emrDocCode: emrDocCode || ADMISSION_EMR_DOC_CODE,
                caseSeqNo,
                version
            });
        };

        // ① 病歷清單（最可靠）
        try {
            const rows = await getNoteRows();
            rows.filter((row) => row.noteType === 'admission')
                .sort((a, b) => (a.isLastVersion === b.isLastVersion ? 0 : a.isLastVersion ? -1 : 1) || newestFirst(a, b))
                .forEach((row) => push(row.seqNo, row.version, row.emrDocCode));
        } catch (e) {
            console.warn('[DischFiller] 病歷清單取得失敗，改用頁面參數猜測：', e && e.message);
        }

        // ② 頁面描述子
        let emrDocCode = ADMISSION_EMR_DOC_CODE;
        try {
            const m = /EmrDocCode=([A-Z0-9]{4,12})/i.exec(document.documentElement.innerHTML);
            if (m) emrDocCode = m[1];
        } catch (e) { /* noop */ }

        const descriptor = findAdmissionDescriptor();
        if (descriptor) push(descriptor.caseSeqNo, descriptor.version, emrDocCode);

        const fromPage = pageHiddenValue(['NTUHWeb1_hidCaseSeqNoRunatServer', 'hidCaseSeqNo']);
        if (fromPage) push(fromPage, '1', emrDocCode);

        // ③ 第一次入院 + 版本回推
        ['9', '8', '7', '6', '5', '4', '3', '2', '1'].forEach((version) => push('1', version, emrDocCode));

        return requests.slice(0, 12);
    }

    function buildNoteTableBody(req) {
        return JSON.stringify({
            jsonstring: JSON.stringify({
                AccountIdse: req.accountIdse,
                CaseSeqNo: req.caseSeqNo,
                Version: req.version,
                EmpNo: req.empNo,
                EmrDocCode: req.emrDocCode,
                CompleteFlag: req.completeFlag
            }),
            notetype: ADMISSION_NOTE_TYPE
        });
    }

    function noteHtmlToText(html) {
        const CR = new RegExp(String.fromCharCode(13), 'g');
        const decoded = String(html || '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<\s*br\s*\/?>/gi, '\n')
            .replace(/<\/(?:td|th)>/gi, ' ')
            .replace(/<\/(?:tr|div|p|li|table|h1|h2|h3)>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;|&apos;/gi, "'")
            .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (m, h2) => String.fromCharCode(parseInt(h2, 16)))
            .replace(/&amp;/gi, '&')
            .replace(CR, '')
            .replace(/\u00a0/g, ' ');
        return decoded
            .split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    async function requestNoteTable(req) {
        const res = await fetch(NOTE_TABLE_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: buildNoteTableBody(req)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const outer = await res.json();
        const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
        if (!inner) return { text: '', meta: null };
        const text = inner.HTMLTable ? noteHtmlToText(inner.HTMLTable) : String(inner.Content || '').trim();
        return { text, meta: inner };
    }

    // 入院日期比對：避免候選 CaseSeqNo 抓到「別次住院」的入院紀錄
    function admissionDateMatches(text, inDate) {
        const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(inDate || '').trim());
        if (!m) return true;
        const re = new RegExp('(^|\\D)' + m[1] + '\\/0?' + Number(m[2]) + '\\/0?' + Number(m[3]) + '(\\D|$)');
        return re.test(String(text || ''));
    }

    async function fetchAdmissionNote(onAttempt) {
        const requests = await buildAdmissionRequests();
        if (!requests.length) throw new Error('找不到病人參數（AccountIDSE／登入員編）');
        const inDate = pageHiddenValue(['hiddenInDate']) || pageQueryValue('InDate');
        for (let i = 0; i < requests.length; i++) {
            const req = requests[i];
            if (onAttempt) onAttempt(req, i + 1, requests.length);
            let got;
            try { got = await requestNoteTable(req); } catch (e) { continue; }
            if (!got || !got.text) continue;
            const meta = got.meta || {};
            // 回應會回帶 CaseSeqNo：不一致代表抓到別次住院
            if (meta.CaseSeqNo && String(meta.CaseSeqNo) !== String(req.caseSeqNo)) continue;
            if (!admissionDateMatches(got.text, inDate)) continue;
            const version = meta.Version ? String(meta.Version) : req.version;
            return { caseSeqNo: req.caseSeqNo, version, text: got.text };
        }
        throw new Error('取不到入院紀錄');
    }

    // ─────────────────────────────────────────────
    // 入院紀錄：段落擷取
    // ─────────────────────────────────────────────
    const ADMISSION_HEADERS = [
        /^Admission Note/i,
        /^主訴\s*[（(]?\s*Chief Complaint/i,
        /^病史\s*[（(]?\s*Brief History/i,
        /^社會心理相關評估/,
        /^系統性回顧\s*[（(]?\s*Review of Systems/i,
        /^身體診察\s*[（(]?\s*Physical Examination/i,
        /^檢驗紀錄/,
        /^檢查紀錄/,
        /^影像報告/,
        /^病理報告/,
        /^臆斷/,
        /^醫療需求與治療計畫/,
        /^出院規劃/,
        /^主治醫師評論/,
        /^醫師姓名/
    ];

    const EXAM_SECTION_RE = /^檢查紀錄\s*[（(]?\s*Examination Report/i;
    const EXAM_LOOSE_RE = /^檢查紀錄/;
    const IMAGING_SECTION_RE = /^影像報告\s*[（(]?\s*Imaging Report/i;
    const IMAGING_LOOSE_RE = /^影像報告/;

    function sectionCandidates(headerRe, looseRe) {
        return looseRe ? [headerRe, looseRe] : [headerRe];
    }

    // 段落清理：去掉 HTML→文字轉換殘留的孤立括號與英文標題
    function cleanSectionText(text) {
        const kept = [];
        String(text || '').split('\n').forEach((line) => {
            const trimmed = line.trim();
            if (!trimmed) { kept.push(''); return; }
            if (/^[)\]｝】＞>]+$/.test(trimmed)) return;                 // 只有右括號
            if (/^[（(\[｛【＜<]+$/.test(trimmed)) return;                // 只有左括號
            if (/^(Examination|Imaging|Laboratory|Pathology)\s+Report\s*[)）]?\s*(?:pending)?$/i.test(trimmed)) return;
            // 段落開頭孤立的 pending（多半是標題殘留，如 "…(Examination Report) pending"）
            if (kept.filter((l) => l.trim()).length === 0 && /^pending[)）]?$/i.test(trimmed)) return;
            kept.push(line.replace(/\s+$/, ''));
        });
        // 段落結尾孤立的 pending（同上，只是落在尾端）
        const nonEmpty = kept.map((line, index) => ({ line, index })).filter((item) => item.line.trim());
        if (nonEmpty.length > 1) {
            const last = nonEmpty[nonEmpty.length - 1];
            if (/^pending[)）]?$/i.test(last.line.trim())) kept[last.index] = '';
        }
        return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }

    function extractSection(text, headerRes) {
        const lines = String(text || '').split('\n');
        for (let h = 0; h < headerRes.length; h++) {
            const headerRe = headerRes[h];
            const start = lines.findIndex((line) => headerRe.test(line.trim()));
            if (start < 0) continue;
            const out = [];
            const rest = lines[start].trim()
                .replace(headerRe, '')
                .replace(/^[（(]\s*(?:Examination|Imaging|Laboratory|Pathology)\s+Report\s*[）)]/i, '')
                .replace(/^[\s:：]+/, '');
            if (rest) out.push(rest);
            for (let i = start + 1; i < lines.length; i++) {
                const trimmed = lines[i].trim();
                if (trimmed && ADMISSION_HEADERS.some((re) => re.test(trimmed))) break;
                out.push(lines[i]);
            }
            const body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
            if (body) return cleanSectionText(body);
        }
        return '';
    }

    // 「醫師姓名 何紹愷住院醫師, 魏以宣主治醫師 紀錄確認者:魏以宣 主治醫師」
    function parsePhysicians(text) {
        const lines = String(text || '').split('\n');
        const idx = lines.findIndex((line) => /^醫師姓名/.test(line.trim()));
        let block = '';
        if (idx >= 0) {
            const parts = [];
            const rest = lines[idx].trim().replace(/^醫師姓名\s*[:：]?\s*/, '');
            if (rest) parts.push(rest);
            for (let i = idx + 1; i < lines.length && i <= idx + 3; i++) {
                const trimmed = lines[i].trim();
                if (!trimmed) break;
                if (ADMISSION_HEADERS.some((re) => re.test(trimmed))) break;
                parts.push(trimmed);
            }
            block = parts.join(' ');
        }
        if (!block) block = String(text || '');

        const confirmed = block.match(/紀錄確認者\s*[:：]\s*([\u4e00-\u9fa5]{2,6})\s*主治醫師/);
        const anyVs = block.match(/([\u4e00-\u9fa5]{2,6})\s*主治醫師/);
        const resident = block.match(/([\u4e00-\u9fa5]{2,6})\s*住院醫師/);
        return {
            vs: confirmed ? confirmed[1] : (anyVs ? anyVs[1] : ''),
            resident: resident ? resident[1] : ''
        };
    }

    // ─────────────────────────────────────────────
    // 負責員編：欄位偵測與對應
    // ─────────────────────────────────────────────
    function lsGet(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) { return fallback; }
    }

    function lsSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* noop */ }
    }

    function elementLabelText(el) {
        const chunks = [];
        try {
            if (el.id) {
                const label = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
                if (label) chunks.push(label.textContent);
            }
            const wrap = el.closest('label');
            if (wrap) chunks.push(wrap.textContent);
            const cell = el.closest('td');
            if (cell) chunks.push(cell.textContent);
            const row = el.closest('tr');
            if (row) chunks.push(row.textContent);
        } catch (e) { /* noop */ }
        return chunks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    }

    // 只認「員編」語意的輸入框；role 用附近文字判斷
    function discoverEmpNoFields() {
        const inputs = Array.from(document.querySelectorAll(
            'input[type="text"], input[type="tel"], input[type="number"], input:not([type])'
        ));
        const found = [];
        inputs.forEach((el) => {
            if (el.readOnly || el.disabled) return;
            if (el.closest('#ntuh-disch-panel')) return;
            const id = el.id || '';
            const label = elementLabelText(el);
            const hay = (id + ' ' + (el.name || '') + ' ' + label + ' ' + (el.placeholder || '')).toLowerCase();
            const looksEmpNo = /empno|emp_no|empid|employee|員編|emp\w*no/.test(hay) || /atxb\w*emp/i.test(id);
            if (!looksEmpNo) return;
            let role = '';
            if (/主治|drvs|\bvs\b/.test(hay)) role = 'vs';
            else if (/住院|負責|記錄|紀錄|resident|\br1\b/.test(hay)) role = 'self';
            found.push({ el, id, label, role });
        });
        return found;
    }

    // 已儲存對應 → 唯一可判定 → 空
    function resolveTargetId(role) {
        const map = lsGet(LS_TARGETS, {});
        const saved = map[role];
        if (saved && document.getElementById(saved)) return saved;

        const matched = discoverEmpNoFields().filter((c) => c.role === role && c.id);
        if (matched.length === 1) {
            map[role] = matched[0].id;
            lsSet(LS_TARGETS, map);
            return matched[0].id;
        }
        return '';
    }

    // EBoard DrInfo（同源）依姓名反查 — 最後手段
    async function lookupVsEmpNoByEboard(name) {
        if (!name) return '';
        const map = lsGet(LS_VS_MAP, {});
        if (map[name]) return String(map[name]);

        const wardCode = pageQueryValue('WardCode') || pageQueryValue('wardCode') ||
            pageQueryValue('Ward') || pageHiddenValue(['hidWardCode', 'hiddenWardCode', 'hidWard', 'WardCode']);
        const accountIdse = pageHiddenValue(['hidAccountNo']) || pageQueryValue('AccountIDSE');
        const hospitalCode = hospitalOfAccount(accountIdse);
        if (!wardCode || !hospitalCode) return '';

        const dates = [];
        const inDate = pageHiddenValue(['hiddenInDate']);
        if (inDate) dates.push(inDate);
        dates.push(todayTaipei());

        for (const date of dates) {
            try {
                const res = await fetch(EBOARD_URL, {
                    method: 'POST',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Content-Type': 'application/json; charset=utf-8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    body: JSON.stringify({
                        HospitalCode: hospitalCode,
                        WardCode: String(wardCode).trim(),
                        StartDate: date,
                        EndDate: date,
                        ActiveFlag: 'Y',
                        QueryNews2: 'N',
                        Mode: 'DrInfo'
                    })
                });
                if (!res.ok) continue;
                const data = JSON.parse(await res.text());
                const rows = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
                const hit = rows.filter((r) => r && r.RoleFilter === 'DRVS' &&
                    String(r.EmpName || '').trim() === name);
                if (hit.length === 1) {
                    const empNo = String(hit[0].EmpNo || '').trim();
                    if (empNo) {
                        map[name] = empNo;
                        lsSet(LS_VS_MAP, map);
                        return empNo;
                    }
                }
            } catch (e) { /* 反查失敗就回空，由面板接手 */ }
        }
        return '';
    }

    // VS 員編：記憶 → 病歷清單（入院紀錄 vsempno） → EBoard
    async function resolveVsEmpNo(name) {
        // ① 病歷清單（院內即時資料）：入院紀錄列 vsempno → 病程列 vsempno
        try {
            const fromNote = await findVsEmpNoFromNotes();
            if (fromNote.empNo) {
                // 入院紀錄那列可直接對應姓名，寫回記憶；病程列未核對姓名則不寫
                if (name && fromNote.source === '入院紀錄 vsempno') {
                    const map = lsGet(LS_VS_MAP, {});
                    map[name] = fromNote.empNo;
                    lsSet(LS_VS_MAP, map);
                }
                return fromNote;
            }
        } catch (e) { /* 清單抓不到就往下 */ }

        // ② 上次記住的姓名→員編
        if (name) {
            const cached = lsGet(LS_VS_MAP, {});
            if (cached[name]) return { empNo: String(cached[name]), source: '記憶' };
        }

        // ③ EBoard DrInfo 依姓名反查
        const fromBoard = await lookupVsEmpNoByEboard(name);
        return { empNo: fromBoard, source: fromBoard ? 'EBoard' : '' };
    }

    function setEmpInfo(rText, vsName, vsEmpNo) {
        const selfEl = document.getElementById('ntuh-disch-emp-self');
        const vsEl = document.getElementById('ntuh-disch-emp-vs');
        if (selfEl) selfEl.textContent = rText || '—';
        if (vsEl) vsEl.textContent = vsName ? (vsName + (vsEmpNo ? ' (' + vsEmpNo + ')' : '')) : '—';
    }

    // 出錯時把關鍵狀態印到 console，回報問題時直接複製即可
    function dumpDiagnostics(reason) {
        try {
            const params = Array.from(new URLSearchParams(window.location.search).entries())
                .map(([key, value]) => key + '=' + (/session/i.test(key) ? '***' : value));
            const hidden = Array.from(document.querySelectorAll('input[type=hidden]'))
                .filter((el) => /hid|hidden|emp|account|caseseq|indate/i.test(el.id || ''))
                .map((el) => (el.id || el.name) + '(' + String(el.value || '').length + ')');
            console.log('[DischFiller][diag]', reason, {
                url: window.location.pathname,
                params,
                hidden,
                labButton: !!getEl(BTN_LAB_POP),
                labParseButton: !!getEl(BTN_LAB_PARSE),
                crField: !!getEl(TXB_CR),
                vsField: !!getEl(TXB_VS)
            });
            if (noteRowsPromise) {
                noteRowsPromise.then((rows) => console.log('[DischFiller][diag] rows', rows.map((row) => ({
                    t: row.noteType,
                    seq: row.seqNo ? 'Y' : '-',
                    v: row.version,
                    vs: row.vsEmpNo ? 'Y' : '-',
                    login: row.loginEmpNo ? 'Y' : '-',
                    doc: row.emrDocCode
                })))).catch((error) => console.log('[DischFiller][diag] rows error', error && error.message));
            }
            if (vsrPromise) {
                vsrPromise.then((vsr) => console.log('[DischFiller][diag] vsr',
                    vsr.rows.map((row) => ({
                        cat: row.category || '-',
                        r: row.rName || '-',
                        rNo: row.rEmpNo ? row.rEmpNo.length : 0,
                        vs: row.vsName || '-',
                        vsNo: row.vsEmpNo ? row.vsEmpNo.length : 0
                    })),
                    'picked:', vsr.picked && vsr.picked.category))
                    .catch((error) => console.log('[DischFiller][diag] vsr error', error && error.message));
            } else {
                console.log('[DischFiller][diag] vsr 未取得（未呼叫或失敗）');
            }
        } catch (e) { /* noop */ }
    }

    function labelText(id) {
        const el = getEl(id);
        return el ? String(el.textContent || el.innerText || '').trim() : '';
    }

    // 表頭固定欄位：住院醫師（自己）／主治醫師（VS）員編
    // 這兩個欄位的 onchange 會 __doPostBack，讓後端把姓名回填到 lblCR／lblVS，
    // 所以寫入時只發 input，postback 留到最後才觸發。
    function fillDoctorEmpNos(rEmpNo, vsEmpNo, vsName, vsSource, ownEmpNo, rName) {
        const out = [];
        const crEl = getEl(TXB_CR);
        const vsEl = getEl(TXB_VS);
        if (!crEl && !vsEl) return out;

        if (crEl) {
            if (rEmpNo) {
                setQuiet(crEl, rEmpNo);
                out.push({
                    field: '住院醫師員編（R）',
                    ok: true,
                    reason: (rName ? rName + ' ' : '') + rEmpNo +
                        (ownEmpNo && rEmpNo !== ownEmpNo ? '｜非本人' : '')
                });
            } else {
                out.push({ field: '住院醫師員編（R）', ok: false, reason: '取不到 R 員編' });
            }
        }

        if (vsEl) {
            if (vsEmpNo) {
                setQuiet(vsEl, vsEmpNo);
                out.push({
                    field: '主治醫師員編',
                    ok: true,
                    reason: vsName + ' ' + vsEmpNo + (vsSource ? '（' + vsSource + '）' : '')
                });
            } else {
                out.push({
                    field: '主治醫師員編',
                    ok: false,
                    reason: vsName ? '查不到 ' + vsName + ' 的員編，請在面板輸入' : '入院紀錄未取得主治醫師姓名'
                });
            }
        }
        return out;
    }

    // txbCR／txbVS 的 onchange 會 __doPostBack（整頁重載），所以用 sessionStorage
    // 記住「還有幾個員編要觸發」，重載後由 init() 接手，避免第二個 postback 被吃掉。
    const LS_EMPNO_JOB = 'ntuh_disch_empno_postback_job';
    let empNoPostbackStarted = false;

    function loadEmpNoJob() {
        try { return JSON.parse(sessionStorage.getItem(LS_EMPNO_JOB) || 'null'); } catch (e) { return null; }
    }

    function saveEmpNoJob(job) {
        try {
            if (!job || !job.steps || !job.steps.length) sessionStorage.removeItem(LS_EMPNO_JOB);
            else sessionStorage.setItem(LS_EMPNO_JOB, JSON.stringify(job));
        } catch (e) { /* noop */ }
    }

    function runEmpNoPostbackJob() {
        const job = loadEmpNoJob();
        if (!job || !job.steps || !job.steps.length) {
            // 員編鏈跑完（含跨 postback 重載後）：接手下一步
            if (readAfter()) runAfterStep();
            return;
        }
        const step = job.steps[0];
        const field = step === 'cr' ? getEl(TXB_CR) : getEl(TXB_VS);
        const label = step === 'cr' ? LBL_CR : LBL_VS;
        const empNo = (job.empNos || {})[step] || '';

        if (!field) {
            job.steps.shift();
            saveEmpNoJob(job);
            setTimeout(runEmpNoPostbackJob, 300);
            return;
        }
        if (!field.value.trim() && empNo) setQuiet(field, empNo);
        if (labelText(label) || !field.value.trim()) {
            job.steps.shift();
            saveEmpNoJob(job);
            setTimeout(runEmpNoPostbackJob, 300);
            return;
        }

        job.steps.shift();
        saveEmpNoJob(job);
        // 觸發 change → 頁面 __doPostBack → 重載；重載後 init() 由 sessionStorage 接手
        field.dispatchEvent(new Event('change', { bubbles: true }));
        // 若該 postback 其實是 UpdatePanel（不重載），這裡接著跑下一步
        setTimeout(runEmpNoPostbackJob, 2500);
    }

    function scheduleEmpNoPostback() {
        if (empNoPostbackStarted) return;
        const cr = getEl(TXB_CR);
        const vs = getEl(TXB_VS);
        const crValue = cr ? cr.value.trim() : '';
        const vsValue = vs ? vs.value.trim() : '';
        const steps = [];
        if (crValue && !labelText(LBL_CR)) steps.push('cr');
        if (vsValue && !labelText(LBL_VS)) steps.push('vs');
        if (!steps.length) {
            if (readAfter()) runAfterStep();
            return;
        }

        empNoPostbackStarted = true;
        saveEmpNoJob({ steps, empNos: { cr: crValue, vs: vsValue } });
        // 等出院預設值（3s／4s 兩個 postback）跑完再動員編，免互相打斷
        setTimeout(runEmpNoPostbackJob, 6500);
    }

    // ─────────────────────────────────────────────
    // 病摘負責醫師頁（WardSetVSRS）— VS/R 員編的權威來源
    //   GET WardSetVSRS.aspx?SESSION=…&PatClass=I&AccountIDSE=…&PersonID=…&Hosp=T0
    //   直接回傳表格：科別／帳號／日期／主治醫師ID(txbVSEmpNo)／病摘負責人員ID(txbRSEmpNo)／類別
    //   免 postback（實測 R rows 4 / VS rows 4）
    // ─────────────────────────────────────────────
    let vsrPromise = null;

    async function fetchVsrAssignment() {
        const accountIdse = pageQueryValue('AccountIDSE') || pageHiddenValue(['hidAccountNo']);
        if (!accountIdse) throw new Error('缺少 AccountIDSE');

        // SESSION 不一定在網址上（有頁面只靠 cookie）→ 找不到就不帶，仍照樣試
        let session = pageQueryValue('SESSION') ||
            pageHiddenValue(['hiddenSkSession', 'hidSession', 'hiddenSession', 'hidSessionKey']);
        if (!session) {
            try {
                const m = /SESSION=([A-Za-z0-9]{12,})/.exec(document.documentElement.innerHTML);
                if (m) session = m[1];
            } catch (e) { /* noop */ }
        }

        const personId = pageQueryValue('PersonID') || pageHiddenValue(['hidPersonId', 'hiddenPersonId']);
        const hospital = pageQueryValue('Hosp') || hospitalOfAccount(accountIdse);
        const patClass = pageQueryValue('PatClass') || 'I';
        const url = VSR_URL +
            '?PatClass=' + encodeURIComponent(patClass) +
            '&AccountIDSE=' + encodeURIComponent(accountIdse) +
            (personId ? '&PersonID=' + encodeURIComponent(personId) : '') +
            '&Hosp=' + encodeURIComponent(hospital) +
            (session ? '&SESSION=' + encodeURIComponent(session) : '');

        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error('WardSetVSRS HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

        const rows = [];
        Array.from(doc.querySelectorAll('input[id*="dgQueryResult_"][id$="_txbRSEmpNo"]')).forEach((rInput) => {
            const base = String(rInput.id || '').replace(/txbRSEmpNo$/, '');
            const vInput = doc.getElementById(base + 'txbVSEmpNo');
            const rNameEl = doc.getElementById(base + 'lblRSName');
            const vNameEl = doc.getElementById(base + 'lblVSName');
            const tr = rInput.closest('tr');
            const cells = tr
                ? Array.from(tr.querySelectorAll('td')).map((td) => td.textContent.replace(/\s+/g, ' ').trim())
                : [];
            rows.push({
                dept: cells[0] || '',
                date: cells[2] || '',
                vsEmpNo: vInput ? String(vInput.value || '').trim() : '',
                vsName: vNameEl ? vNameEl.textContent.trim() : '',
                rEmpNo: String(rInput.value || '').trim(),
                rName: rNameEl ? rNameEl.textContent.trim() : '',
                category: cells[5] || cells[cells.length - 1] || ''
            });
        });

        if (!rows.length) throw new Error('WardSetVSRS 沒有 VS/R 資料列');
        // 只用「出院／住院」這類病摘歸屬列，手術紀錄不採用（避免填到手術的 VS/R）
        const nonSurgery = rows.filter((row) => !/手術/.test(row.category));
        const pool = nonSurgery.length ? nonSurgery : rows;
        const picked = pool.find((row) => /出院/.test(row.category)) ||
            pool.find((row) => /住院/.test(row.category)) ||
            pool.find((row) => row.rEmpNo) ||
            pool[0];
        return { rows, picked, nonSurgery };
    }

    function getVsrAssignment() {
        if (!vsrPromise) {
            vsrPromise = fetchVsrAssignment().catch((error) => {
                vsrPromise = null;
                throw error;
            });
        }
        return vsrPromise;
    }

    // 自己＋VS 的員編寫入頁面欄位
    async function applyEmpNos(doctors) {
        const out = [];
        const ownEmpNo = await getOwnEmpNo();
        const vsName = (doctors && doctors.vs) || '';

        // 病摘負責醫師頁（權威來源）：一次拿到 VS 與 R
        let vsr = null;
        let vsrError = '';
        try {
            vsr = await getVsrAssignment();
        } catch (error) {
            vsrError = error && error.message ? error.message : String(error);
            console.warn('[DischFiller] WardSetVSRS 取得失敗：', vsrError);
        }
        const picked = vsr && vsr.picked ? vsr.picked : null;
        const rEmpNo = (picked && picked.rEmpNo) || ownEmpNo;
        const rName = picked && picked.rName ? picked.rName : '';

        // VS：與 R 同一列（出院／住院）優先；該列沒有才找其他非手術列
        const vsPool = (vsr && (vsr.nonSurgery || vsr.rows)) ? (vsr.nonSurgery || vsr.rows) : [];
        const vsrVs = (picked && picked.vsEmpNo)
            ? picked
            : (vsPool.find((row) => row.vsEmpNo && vsName && row.vsName === vsName) ||
               vsPool.find((row) => row.vsEmpNo) ||
               null);
        const vsFromVsr = vsrVs && vsrVs.vsEmpNo ? vsrVs.vsEmpNo : '';
        const effectiveVsName = vsName || (vsrVs && vsrVs.vsName ? vsrVs.vsName : '');

        // VSR 的 VS 姓名與入院紀錄一致才寫進「姓名→員編」記憶；不一致只提示不記憶
        let vsNameMismatch = '';
        if (vsFromVsr && vsrVs.vsName && vsName) {
            if (vsrVs.vsName === vsName) {
                const map = lsGet(LS_VS_MAP, {});
                if (map[vsName] !== vsFromVsr) {
                    map[vsName] = vsFromVsr;
                    lsSet(LS_VS_MAP, map);
                }
            } else {
                vsNameMismatch = vsrVs.vsName + '（病摘負責頁）≠ ' + vsName + '（入院紀錄）';
            }
        }

        const resolved = vsFromVsr
            ? { empNo: vsFromVsr, source: '病摘負責頁' + (vsrVs.category ? '／' + vsrVs.category : '') }
            : (effectiveVsName ? await resolveVsEmpNo(effectiveVsName) : { empNo: '', source: '' });
        const vsEmpNo = resolved.empNo;

        const headerRows = fillDoctorEmpNos(rEmpNo, vsEmpNo, effectiveVsName, resolved.source, ownEmpNo, rName);
        if (!vsEmpNo) dumpDiagnostics('vs empno missing' + (vsName ? ' (' + vsName + ')' : ''));
        if (headerRows.length) {
            headerRows.forEach((row) => out.push(row));
            if (vsr) {
                out.push({
                    field: 'VS/R 來源列',
                    ok: true,
                    reason: vsr.rows.length + ' 列：' + vsr.rows.map((row) =>
                        (row.category || '-') + ' ' + (row.rName || '-') + '/' + (row.vsName || '-')).join('、')
                });
            } else if (vsrError) {
                out.push({ field: '病摘負責頁', ok: false, reason: vsrError });
            }
            if (vsNameMismatch) {
                out.push({ field: 'VS 姓名不一致', ok: false, reason: vsNameMismatch });
            }
            setEmpInfo(rName ? rName + ' ' + rEmpNo : rEmpNo, vsName, vsEmpNo);
            scheduleEmpNoPostback();
            return out;
        }

        // 後備：頁面版本不同、找不到 txbCR／txbVS 時，改用偵測式欄位
        const selfTarget = resolveTargetId('self');
        const vsTarget = resolveTargetId('vs');

        if (!rEmpNo) {
            out.push({ field: '員編（R）', ok: false, reason: '頁面找不到自己的員編' });
        } else if (!selfTarget) {
            out.push({ field: '員編（R）', ok: false, reason: '找不到欄位' });
        } else {
            out.push({ field: '員編（R）', ok: setValue(document.getElementById(selfTarget), rEmpNo), reason: rEmpNo });
        }

        if (!vsName) {
            out.push({ field: '員編（VS）', ok: false, reason: '入院紀錄未取得主治醫師姓名' });
        } else if (!vsEmpNo) {
            out.push({ field: '員編（VS ' + vsName + '）', ok: false, reason: '查不到員編' });
        } else if (!vsTarget) {
            out.push({ field: '員編（VS）', ok: false, reason: '找不到欄位' });
        } else {
            out.push({ field: '員編（VS）', ok: setValue(document.getElementById(vsTarget), vsEmpNo), reason: vsName + ' ' + vsEmpNo });
        }

        setEmpInfo(rName ? rName + ' ' + rEmpNo : rEmpNo, vsName, vsEmpNo);
        return out;
    }

    // ─────────────────────────────────────────────
    // 入院紀錄 Ditto 主流程
    // ─────────────────────────────────────────────
    async function importAdmissionExtras() {
        const results = [];
        try {
            const note = await fetchAdmissionNote((req, n, total) => {
                setStatus('🔍 讀取入院紀錄…（CaseSeqNo ' + req.caseSeqNo + '／V' + req.version +
                    '，' + n + '/' + total + '）', 'warn');
            });
            results.push(fillFromAdmission('檢查紀錄', 'tplSI_txbSI',
                extractSection(note.text, sectionCandidates(EXAM_SECTION_RE, EXAM_LOOSE_RE))));
            results.push(fillFromAdmission('影像報告', 'tplRR_txbRR',
                extractSection(note.text, sectionCandidates(IMAGING_SECTION_RE, IMAGING_LOOSE_RE))));

            const doctors = parsePhysicians(note.text);
            const empRows = await applyEmpNos(doctors);
            empRows.forEach((row) => results.push(row));
            return { ok: true, results, note };
        } catch (e) {
            const message = e && e.message ? e.message : String(e);
            results.push({ field: '入院紀錄 Ditto', ok: false, reason: message });
            dumpDiagnostics('admission failed: ' + message);
            return { ok: false, results, error: message };
        }
    }

    // ─────────────────────────────────────────────
    // 出院預設值（其他／出院狀態）
    // ─────────────────────────────────────────────
    // 「其他」欄位若已有隔離醫囑，就不再按「帶入隔離醫囑」
    function isolationField() {
        const direct = getEl(PREFIX + 'tplOT_txbOT');
        if (direct) return direct;
        try {
            return document.querySelector('textarea[id^="' + PREFIX + 'tplOT"]');
        } catch (e) { return null; }
    }

    function hasIsolationOrder() {
        const el = isolationField();
        return el ? /隔離/.test(String(el.value || '')) : false;
    }

    function scheduleDischargeDefaults() {
        if (dischargeDefaultsScheduled) return;
        dischargeDefaultsScheduled = true;

        setTimeout(() => {
            const otherButton = document.getElementById(PREFIX + 'tplOT_btnDisDefaultValue_ANN');
            if (!otherButton) {
                pushLogRow({ field: '其他（隔離醫囑）', ok: false, reason: '找不到「帶入隔離醫囑」按鈕' });
            } else if (hasIsolationOrder()) {
                pushLogRow({ field: '其他（隔離醫囑）', ok: true, reason: '已有隔離醫囑，未按「帶入隔離醫囑」' });
            } else {
                otherButton.click();
            }

            setTimeout(() => {
                const dischargeButton = document.getElementById(PREFIX + 'tplDS_btnSetDischargeStatus');
                if (dischargeButton) {
                    dischargeButton.click();
                } else {
                    pushLogRow({ field: '轉出/出院情況', ok: false, reason: '找不到「帶入轉出/出院情況」按鈕' });
                }
            }, 1000);
        }, 3000);
    }

    // ─────────────────────────────────────────────
    // 病歷清單（progress 頁）列資料
    //   tr[notetype] 實測屬性：notetype／accountno／caseseqno／version／islastverion／
    //   insertdatetime／vsempno／crempno／emrdoccode／completeflag
    // ─────────────────────────────────────────────
    let noteRowsPromise = null;

    async function fetchProgressRows() {
        const params = new URLSearchParams(window.location.search);
        const accountId = getQueryParamIgnoreCase(params, 'AccountIDSE');
        if (!accountId) throw new Error('缺少 AccountIDSE');

        const progressUrl = new URL(window.location.href);
        progressUrl.pathname = progressUrl.pathname.replace(
            /InsertDisChargeNoteContent\.aspx$/i,
            'InsertProgressNoteContent.aspx'
        );
        for (const key of Array.from(progressUrl.searchParams.keys())) {
            const lower = key.toLowerCase();
            if (lower === 'seed' || lower === CAPTURE_PARAM.toLowerCase()) progressUrl.searchParams.delete(key);
        }

        const res = await fetch(progressUrl.toString(), { credentials: 'include' });
        if (!res.ok) throw new Error('progress 頁 HTTP ' + res.status);
        const doc = new DOMParser().parseFromString(await res.text(), 'text/html');

        const allRows = Array.from(doc.querySelectorAll('tr[notetype]')).map((row) => ({
            noteType: (row.getAttribute('notetype') || '').toLowerCase(),
            accountNo: (row.getAttribute('accountno') || '').trim(),
            seqNo: rowAttr(row, ['caseseqno']),
            version: rowAttr(row, ['version']) || '1',
            isLastVersion: (row.getAttribute('islastverion') || '').trim().toLowerCase() === 'true',
            insertDateTime: (row.getAttribute('insertdatetime') || '').trim(),
            vsEmpNo: (row.getAttribute('vsempno') || '').trim(),
            crEmpNo: (row.getAttribute('crempno') || '').trim(),
            loginEmpNo: (row.getAttribute('loginempno') || '').trim(),
            emrDocCode: (row.getAttribute('emrdoccode') || '').trim()
        }));

        const matched = allRows.filter((row) => !row.accountNo || row.accountNo === accountId);
        if (matched.length) return matched;
        // 帳號格式不同（或清單未帶 accountno）→ 整批保留，避免整個流程失效
        console.warn('[DischFiller] 病歷清單沒有符合 AccountIDSE 的列，改為全部採用（' + allRows.length + ' 列）');
        return allRows;
    }

    // 同一頁只抓一次清單
    function getNoteRows() {
        if (!noteRowsPromise) {
            noteRowsPromise = fetchProgressRows().catch((error) => {
                noteRowsPromise = null;
                throw error;
            });
        }
        return noteRowsPromise;
    }

    function newestFirst(a, b) {
        return Date.parse(b.insertDateTime || '') - Date.parse(a.insertDateTime || '');
    }

    // 入院紀錄那列的 vsempno 就是這次住院的 VS（最可靠來源）
    async function findVsEmpNoFromNotes() {
        const rows = await getNoteRows();
        const admissionRows = rows.filter((row) => row.noteType === 'admission' && row.vsEmpNo)
            .sort(newestFirst);
        if (admissionRows.length) return { empNo: admissionRows[0].vsEmpNo, source: '入院紀錄 vsempno' };

        const progressRows = rows.filter((row) => row.noteType === PROGRESS_NOTE_TYPE && row.vsEmpNo)
            .sort((a, b) => (a.isLastVersion === b.isLastVersion ? 0 : a.isLastVersion ? -1 : 1) || newestFirst(a, b));
        if (progressRows.length) return { empNo: progressRows[0].vsEmpNo, source: '病程 vsempno（未核對姓名）' };
        return { empNo: '', source: '' };
    }

    // ─────────────────────────────────────────────
    // 直接以 endpoint 取最新 Progress 的 Assessment（不開視窗）
    //   POST PAP.asmx/GetProgressNotePAP  body {jsonstring:{AccountNo,SeqNo,Version}, notetype:'progress'}
    //   回傳 [{ Problem:[], Assessment:[], Plan:[] }]，Assessment 為字串陣列
    // ─────────────────────────────────────────────
    function shortenDate(value) {
        const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? m[1] + '/' + m[2] + '/' + m[3] : '';
    }

    function rowAttr(row, names) {
        for (const name of names) {
            const value = row.getAttribute(name);
            if (value && String(value).trim()) return String(value).trim();
        }
        return '';
    }

    async function requestPAP(accountNo, seqNo, version) {
        const res = await fetch(PAP_URL, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/json; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify({
                jsonstring: JSON.stringify({
                    AccountNo: accountNo,
                    SeqNo: seqNo,
                    Version: version
                }),
                notetype: PROGRESS_NOTE_TYPE
            })
        });
        if (!res.ok) return '';
        const outer = await res.json();
        const inner = typeof outer.d === 'string' ? JSON.parse(outer.d) : outer.d;
        const rows = Array.isArray(inner) ? inner : (inner ? [inner] : []);
        const parts = [];
        rows.forEach((row) => {
            if (!row || !row.Assessment) return;
            const value = row.Assessment;
            if (Array.isArray(value)) {
                value.forEach((item) => {
                    const text = String(item || '').trim();
                    if (text) parts.push(text);
                });
            } else {
                const text = String(value).trim();
                if (text) parts.push(text);
            }
        });
        return parts.join('\n').trim();
    }

    async function fetchLatestProgressAssessmentDirect() {
        const params = new URLSearchParams(window.location.search);
        const accountId = getQueryParamIgnoreCase(params, 'AccountIDSE');
        if (!accountId) throw new Error('缺少 AccountIDSE');

        const rows = (await getNoteRows())
            .filter((row) => row.noteType === PROGRESS_NOTE_TYPE)
            .sort((a, b) => (a.isLastVersion === b.isLastVersion ? 0 : a.isLastVersion ? -1 : 1) || newestFirst(a, b));

        if (!rows.length) throw new Error('progress 清單沒有本次住院的紀錄');

        const tried = {};
        for (const row of rows.slice(0, 3)) {
            const key = row.seqNo + '/' + row.version;
            if (!row.seqNo || tried[key]) continue;
            tried[key] = true;
            let assessment = '';
            try { assessment = await requestPAP(accountId, row.seqNo, row.version); } catch (e) { continue; }
            if (assessment) {
                return { assessment, noteDate: shortenDate(row.insertDateTime) };
            }
        }
        throw new Error('PAP 未回傳 Assessment');
    }

    function applyAssessmentToNote(assessmentText, noteDate) {
        const assessment = String(assessmentText || '').trim();
        if (!assessment) return { ok: false, msg: '最新病程 Assessment 為空白' };
        const target = document.getElementById(PREFIX + 'tplEP_txbEP');
        if (!target) return { ok: false, msg: '找不到身體診察欄位' };

        const dateLabel = noteDate ? ` (${noteDate})` : '';
        const block = `Progress Note Assessment${dateLabel}\n${assessment}`;
        const value = String(target.value || '');
        const labelRe = /(Evident\s+Transfer\s*\/?\s*Discharge\s+Change\s+of\s+Physical\s+Findings[^\n]*|轉出\s*\/?\s*出院時明顯的身體檢查改變[^\n]*)/i;
        const hit = labelRe.exec(value);

        // ① 有「轉出/出院時明顯的身體檢查改變」標題 → 只看標題「底下」是否為空
        if (hit) {
            const after = value.slice(hit.index + hit[0].length);
            if (after.trim()) {
                return {
                    ok: true,
                    skipped: true,
                    msg: after.trim().includes(assessment) ? '標題下已含此段 Assessment' : '標題下已有內容，未插入'
                };
            }
            const insertAt = hit.index + hit[0].length;
            target.value = value.slice(0, insertAt) + '\n' + block + value.slice(insertAt);
            target.dispatchEvent(new Event('input', { bubbles: true }));
            target.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, msg: '已插入標題底下' };
        }

        // ② 沒有標題：整欄空白才插入
        if (value.trim()) {
            return {
                ok: true,
                skipped: true,
                msg: value.includes(assessment) ? '已含此段 Assessment' : '身體診察已有內容，未插入'
            };
        }
        target.value = block;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, msg: '' };
    }

    // 先走 endpoint（不開視窗），失敗才退回開視窗抓表單
    async function importAssessment() {
        try {
            const direct = await fetchLatestProgressAssessmentDirect();
            const applied = applyAssessmentToNote(direct.assessment, direct.noteDate);
            const row = {
                field: '身體診察',
                ok: !!applied.ok,
                reason: (applied.msg || '已帶入最新 Assessment') + (direct.noteDate ? '（' + direct.noteDate + '）' : '')
            };
            if (!applied.ok) return { ok: false, msg: applied.msg, row };
            if (applied.skipped) {
                setStatus('ℹ ' + applied.msg, 'warn');
                return { ok: true, msg: '', row };
            }
            setStatus('✓ 已由 PAP 帶入最新 Assessment（未開視窗）。', 'ok');
            return { ok: true, msg: '', row };
        } catch (directError) {
            const fallback = await importLatestAssessment();
            return {
                ok: fallback.ok,
                msg: fallback.ok ? '' : fallback.msg,
                row: {
                    field: '身體診察',
                    ok: !!fallback.ok,
                    reason: fallback.ok ? '已由視窗帶入 Assessment' : 'PAP 直取失敗，改開視窗：' +
                        (directError && directError.message ? directError.message : directError)
                }
            };
        }
    }

    // ─────────────────────────────────────────────
    // 檢驗報告帶入（A 案）
    //   母頁：btnPop4thReport → postback 開 DWHistoricalLabReport.aspx
    //   子頁：全選科別 → OnClientClick_GetSelectedLabData() → 關閉
    //   母頁：等 hdParsingLabData 有值 → 按「解析資料」→ tplGI_txbGI 才有文字
    //   每次 postback 都是整頁重載，故用 sessionStorage 記進度、由 init() 接手
    // ─────────────────────────────────────────────
    function pushLogRow(row) {
        const box = document.getElementById('ntuh-disch-log');
        if (!box) return;
        box.style.display = 'block';
        const line = document.createElement('div');
        line.className = 'disch-row';
        line.innerHTML = '<span>' + escapeHtml(row.field) + '</span>' +
            '<span class="' + (row.ok ? 'disch-ok' : 'disch-err') + '">' +
            (row.ok ? '✓ ' : '✗ ') + escapeHtml(row.reason || '') + '</span>';
        box.appendChild(line);
    }

    function labDataLength() {
        const el = getEl(HD_LAB_DATA);
        return el ? String(el.value || '').trim().length : 0;
    }

    function readLabJob() {
        try { return JSON.parse(sessionStorage.getItem(LS_LAB_JOB) || 'null'); } catch (e) { return null; }
    }

    function writeLabJob(job) {
        try {
            if (!job) sessionStorage.removeItem(LS_LAB_JOB);
            else sessionStorage.setItem(LS_LAB_JOB, JSON.stringify(job));
        } catch (e) { /* noop */ }
    }

    function fillLabNilIfEmpty() {
        const field = getEl(PREFIX + 'tplGI_txbGI');
        if (field && !String(field.value || '').trim()) {
            setQuiet(field, 'nil');
        }
    }

    function finishLabJob(message) {
        writeLabJob(null);
        fillLabNilIfEmpty();
        const ok = message.charAt(0) === '✓';
        setStatus(message, ok ? 'ok' : 'warn');
        pushLogRow({ field: '檢驗紀錄', ok, reason: message });
        scheduleDischargeDefaults();
    }

    function readAfter() {
        try { return sessionStorage.getItem(LS_AFTER) || ''; } catch (e) { return ''; }
    }

    function writeAfter(value) {
        try {
            if (!value) sessionStorage.removeItem(LS_AFTER);
            else sessionStorage.setItem(LS_AFTER, value);
        } catch (e) { /* noop */ }
    }

    // 員編 postback 鏈結束後接手：先帶檢驗報告，最後才按出院預設值
    function runAfterStep() {
        const next = readAfter();
        if (!next) return;
        writeAfter('');
        if (next === 'lab') {
            startLabImport();
            return;
        }
        // 沒有要做檢驗帶入 → 檢驗紀錄空白才補 nil
        fillLabNilIfEmpty();
        scheduleDischargeDefaults();
    }

    function startLabImport() {
        const btn = getEl(BTN_LAB_POP);
        if (!btn) {
            finishLabJob('✗ 找不到「查詢住院期間檢驗報告」按鈕（請先切到檢驗頁籤）');
            return;
        }
        writeLabJob({ stage: 'waitData', at: Date.now() });
        // 先把檢驗紀錄清空（先前可能被填成 nil），否則解析後會變成「nill + 正式資料」
        const giField = getEl(PREFIX + 'tplGI_txbGI');
        if (giField) {
            const current = String(giField.value || '').trim();
            if (!current || current.toLowerCase() === 'nil') setQuiet(giField, '');
        }
        setStatus('⏳ 開啟檢驗報告視窗，帶入後會自動按「解析資料」…', 'warn');
        pushLogRow({ field: '檢驗紀錄', ok: true, reason: '已開啟檢驗報告視窗' });
        try {
            btn.click();
        } catch (error) {
            finishLabJob('✗ 無法按下檢驗查詢按鈕：' + (error && error.message ? error.message : error));
            return;
        }
        // 若這個 click 是 UpdatePanel（不會整頁重載），init() 不會再被叫 → 自己接續輪詢
        setTimeout(resumeLabJob, 1200);
    }

    function resumeLabJob() {
        const job = readLabJob();
        if (!job) return;
        if (Date.now() - (job.at || 0) > 180000) { writeLabJob(null); return; }

        if (job.stage === 'waitData') {
            const started = Date.now();
            const timer = setInterval(() => {
                if (labDataLength() > 0) {
                    clearInterval(timer);
                    const parseBtn = getEl(BTN_LAB_PARSE);
                    if (!parseBtn) { finishLabJob('✗ 找不到「解析資料」按鈕'); return; }
                    writeLabJob({ stage: 'verify', at: Date.now() });
                    setStatus('⏳ 已取得檢驗資料，解析中…', 'warn');
                    parseBtn.click();
                    // 同樣處理 UpdatePanel 不重載的情況
                    setTimeout(resumeLabJob, 1500);
                    return;
                }
                if (Date.now() - started > 25000) {
                    clearInterval(timer);
                    finishLabJob('⚠ 25 秒內沒收到檢驗資料（視窗未按帶入？）');
                }
            }, 800);
            return;
        }

        if (job.stage === 'verify') {
            const field = getEl(PREFIX + 'tplGI_txbGI');
            const length = field ? String(field.value || '').trim().length : 0;
            finishLabJob(length
                ? '✓ 已帶入（' + length + ' 字）請核對'
                : '⚠ 解析後檢驗紀錄仍為空');
        }
    }

    // 子視窗（DWHistoricalLabReport.aspx）側：辨識來源後全選科別並帶入
    function autoSelectAndImportLab() {
        const params = new URLSearchParams(window.location.search);
        const target = (params.get('hfdTextBox') || '') + ' ' + (params.get('hfdbutton') || '');
        if (!/DischargeNote/i.test(target)) return; // 手動開報告頁時不動作

        const deptCheckboxes = Array.from(document.querySelectorAll('input[type=checkbox][dept]'))
            .filter((cb) => !cb.getAttribute('group') && !cb.getAttribute('key'));
        if (!deptCheckboxes.length) {
            console.log('[DischFiller] 找不到科別 checkbox，未自動帶入');
            return;
        }

        deptCheckboxes.forEach((cb) => {
            cb.checked = true;
            if (typeof cb.onclick === 'function') cb.onclick();
        });

        setTimeout(() => {
            if (typeof OnClientClick_GetSelectedLabData === 'function') {
                OnClientClick_GetSelectedLabData(); // eslint-disable-line no-undef
            }
            setTimeout(() => { try { window.close(); } catch (e) { /* noop */ } }, 1200);
        }, 1000);
    }

    // ─────────────────────────────────────────────
    // 病程 Assessment 匯入（開新視窗取回文字）— 後備路徑
    // ─────────────────────────────────────────────
    function importLatestAssessment() {
        return new Promise((resolve) => {
            if (pendingAssessmentImport) {
                setStatus('⏳ 正在匯入病程 Assessment，請稍候。', 'warn');
                resolve({ ok: false, msg: '正在匯入病程 Assessment' });
                return;
            }

            const currentParams = new URLSearchParams(window.location.search);
            const personId = getQueryParamIgnoreCase(currentParams, 'PersonID');
            const accountId = getQueryParamIgnoreCase(currentParams, 'AccountIDSE');

            if (!personId || !accountId) {
                resolve({ ok: false, msg: '⚠ 無法從目前網址確認病人與住院資料，已取消匯入。' });
                return;
            }

            const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const progressUrl = new URL(window.location.href);
            progressUrl.pathname = progressUrl.pathname.replace(
                /InsertDisChargeNoteContent\.aspx$/i,
                'InsertProgressNoteContent.aspx'
            );
            for (const key of Array.from(progressUrl.searchParams.keys())) {
                if (key.toLowerCase() === 'seed') progressUrl.searchParams.delete(key);
            }
            progressUrl.searchParams.set(CAPTURE_PARAM, token);

            const popup = window.open(progressUrl.toString(), '_blank');
            if (!popup) {
                resolve({ ok: false, msg: '⚠ 瀏覽器封鎖了病程記錄視窗，請允許此網站開啟視窗後重試。' });
                return;
            }

            const timer = window.setTimeout(() => {
                if (pendingAssessmentImport && pendingAssessmentImport.token === token) {
                    pendingAssessmentImport = null;
                    try { popup.close(); } catch (_) { /* noop */ }
                    resolve({ ok: false, msg: '⚠ 等待病程記錄逾時，未匯入內容。' });
                }
            }, 25000);

            pendingAssessmentImport = { token, personId, accountId, popup, resolve, timer };
        });
    }

    function handleAssessmentMessage(event) {
        const pending = pendingAssessmentImport;
        const data = event.data;
        if (!pending || event.origin !== window.location.origin ||
            event.source !== pending.popup || !data ||
            data.type !== 'NTUH_DISCHARGE_ASSESSMENT' || data.token !== pending.token) {
            return;
        }

        window.clearTimeout(pending.timer);
        pendingAssessmentImport = null;
        const done = pending.resolve;

        if (data.error) {
            setStatus(`⚠ ${data.error}`, 'err');
            done({ ok: false, msg: data.error });
            return;
        }

        if (data.personId !== pending.personId || data.accountId !== pending.accountId) {
            setStatus('⚠ 病人或住院資料不一致，已取消匯入。', 'err');
            done({ ok: false, msg: '病人或住院資料不一致' });
            return;
        }

        const assessment = (data.assessment || '').trim();
        if (!assessment) {
            setStatus('⚠ 最新病程記錄的 Assessment 為空白，未匯入。', 'err');
            done({ ok: false, msg: '最新病程 Assessment 為空白' });
            return;
        }

        const applied = applyAssessmentToNote(assessment, data.noteDate);
        if (!applied.ok) {
            pushLogRow({ field: '身體診察', ok: false, reason: applied.msg });
            setStatus('⚠ ' + applied.msg, 'err');
            done(applied);
            return;
        }
        if (applied.skipped) {
            pushLogRow({ field: '身體診察', ok: true, reason: applied.msg });
            setStatus('ℹ ' + applied.msg, 'warn');
            done({ ok: true, msg: '' });
            return;
        }
        pushLogRow({ field: '身體診察', ok: true, reason: '已由視窗帶入 Assessment' + (data.noteDate ? '（' + data.noteDate + '）' : '') });
        setStatus('✓ 已將最新病程 Assessment 附加至身體診察，請確認後儲存。', 'ok');
        done({ ok: true, msg: '' });
    }

    // ─────────────────────────────────────────────
    // 病程頁側：取出最新 Progress 的 Assessment
    // ─────────────────────────────────────────────
    function selectLatestProgressNote(accountId) {
        const progressRows = Array.from(
            document.querySelectorAll('tr[notetype]')
        ).filter((row) =>
            (row.getAttribute('notetype') || '').toLowerCase() === 'progress'
        );

        if (!progressRows.length) return { waiting: true };

        const matchingRows = progressRows.filter((row) => {
            const rowAccount = (row.getAttribute('accountno') || '').trim();
            return !rowAccount || rowAccount === accountId;
        });

        if (!matchingRows.length) {
            return { error: '病程清單中找不到符合本次住院資料的 Progress 記錄。' };
        }

        matchingRows.sort((a, b) =>
            Date.parse(b.getAttribute('insertdatetime') || '') -
            Date.parse(a.getAttribute('insertdatetime') || '')
        );

        const latestRow = matchingRows[0];
        const link = latestRow.querySelector('a.candidateNameTD, a[id*="_NoteName"]');

        if (!link) {
            return { error: '找到最新 Progress 記錄，但找不到可點選的筆記連結。' };
        }

        const dateTime = latestRow.getAttribute('insertdatetime') || '';
        const dateMatch = dateTime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
        const noteDate = dateMatch
            ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}`
            : '';

        link.click();
        return {
            selected: true,
            noteDate,
            expectedDateTime: dateMatch
                ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]} ${dateMatch[4]}:${dateMatch[5]}`
                : ''
        };
    }

    function progressFormMatchesDate(expectedDateTime) {
        if (!expectedDateTime) return true;

        const suffixes = [
            'ucInsertDateTime_YearInput',
            'ucInsertDateTime_MonthInput',
            'ucInsertDateTime_DayInput',
            'ucInsertDateTime_HourInput',
            'ucInsertDateTime_MinuteInput'
        ];
        const values = suffixes.map((suffix) => {
            const field = document.getElementById(PROGRESS_PREFIX + suffix);
            return field ? field.value.trim() : '';
        });

        if (values.some((value) => !value)) return false;

        const [year, month, day, hour, minute] = values;
        const expected = expectedDateTime.split(' ');
        const current =
            `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ` +
            `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

        return current === `${expected[0]} ${expected[1]}`;
    }

    function captureProgressAssessment() {
        const params = new URLSearchParams(window.location.search);
        const token = getQueryParamIgnoreCase(params, CAPTURE_PARAM);
        if (!token) return;

        const personId = getQueryParamIgnoreCase(params, 'PersonID');
        const accountId = getQueryParamIgnoreCase(params, 'AccountIDSE');
        const patientIdField = document.getElementById('hidPersonId');

        if (!personId || !accountId ||
            (patientIdField && patientIdField.value && patientIdField.value !== personId)) {
            window.opener?.postMessage({
                type: 'NTUH_DISCHARGE_ASSESSMENT',
                token,
                error: '病程頁的病人資料無法核對，已取消匯入。'
            }, window.location.origin);
            return;
        }

        const startedAt = Date.now();
        let selectedNote = null;

        const timer = window.setInterval(() => {
            if (!selectedNote) {
                const selection = selectLatestProgressNote(accountId);

                if (selection.error) {
                    window.clearInterval(timer);
                    window.opener?.postMessage({
                        type: 'NTUH_DISCHARGE_ASSESSMENT', token, error: selection.error
                    }, window.location.origin);
                    window.setTimeout(() => window.close(), 300);
                    return;
                }

                if (selection.selected) {
                    selectedNote = selection;
                } else if (Date.now() - startedAt > 10000) {
                    window.clearInterval(timer);
                    window.opener?.postMessage({
                        type: 'NTUH_DISCHARGE_ASSESSMENT', token,
                        error: '病程頁的 Progress 清單尚未載入，未匯入。'
                    }, window.location.origin);
                    window.setTimeout(() => window.close(), 300);
                }
                return;
            }

            const assessmentField = document.getElementById(PROGRESS_PREFIX + 'ucPAP_txbAssessment1');
            const assessment = assessmentField ? assessmentField.value.trim() : '';

            if (assessment && progressFormMatchesDate(selectedNote.expectedDateTime)) {
                window.clearInterval(timer);
                window.opener?.postMessage({
                    type: 'NTUH_DISCHARGE_ASSESSMENT',
                    token,
                    personId,
                    accountId,
                    noteDate: selectedNote.noteDate,
                    assessment
                }, window.location.origin);
                window.setTimeout(() => window.close(), 300);
            } else if (Date.now() - startedAt > 25000) {
                window.clearInterval(timer);
                window.opener?.postMessage({
                    type: 'NTUH_DISCHARGE_ASSESSMENT', token,
                    error: '最新 Progress 的 Assessment 未載入或為空白。'
                }, window.location.origin);
                window.setTimeout(() => window.close(), 300);
            }
        }, 500);
    }

    // ─────────────────────────────────────────────
    // UI
    // ─────────────────────────────────────────────
    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function setStatus(msg, type) {
        const el = document.getElementById('ntuh-disch-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'disch-ok' : type === 'err' ? 'disch-err' : 'disch-warn';
    }

    function renderResults(rows) {
        const box = document.getElementById('ntuh-disch-log');
        if (!box) return;
        box.innerHTML = (rows || []).map((row) =>
            '<div class="disch-row"><span>' + escapeHtml(row.field) + '</span>' +
            '<span class="' + (row.ok ? 'disch-ok' : 'disch-err') + '">' +
            (row.ok ? '✓ ' : '✗ ') + escapeHtml(row.reason || '') + '</span></div>'
        ).join('');
    }

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
                width: 260px;
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
            #ntuh-disch-import-all {
                width: 100%; padding: 12px 8px; border: 1px solid #9a7cdc;
                border-radius: 6px; cursor: pointer; font-size: 13px;
                font-weight: 600; white-space: normal;
                background: #6a3cac; color: #fff;
            }
            #ntuh-disch-status { font-size: 11px; min-height: 16px; }
            #ntuh-disch-log {
                font-size: 10.5px; line-height: 1.5; max-height: 170px; overflow-y: auto;
                background: #0f1420; border: 1px solid #2d3650; border-radius: 6px;
                padding: 6px; display: none;
            }
            #ntuh-disch-emp {
                border-top: 1px solid #2d3650; padding-top: 8px;
                display: flex; flex-direction: column; gap: 6px;
            }
            .disch-emp-row {
                display: flex; justify-content: space-between; gap: 6px;
                font-size: 11px; color: #8fa0c0;
            }
            .disch-emp-row b { color: #c8d3e8; font-weight: 600; text-align: right; }
            .disch-emp-line { display: flex; gap: 6px; }
            .disch-emp-line input, .disch-emp-line select {
                flex: 1; min-width: 0; background: #0f1420; color: #c8d3e8;
                border: 1px solid #2d3650; border-radius: 5px; font-size: 11px; padding: 4px;
                font-family: 'Consolas','Courier New',monospace;
            }
            .disch-emp-line button, #ntuh-disch-emp-apply {
                background: #2f3a52; color: #c8d3e8; border: 1px solid #3d4a68;
                border-radius: 5px; font-size: 11px; padding: 4px 8px; cursor: pointer;
                font-family: inherit;
            }
            .disch-emp-line button:hover, #ntuh-disch-emp-apply:hover { background: #3d4a68; }
            .disch-ok   { color: #3fb950; }
            .disch-err  { color: #e05c5c; }
            .disch-warn { color: #f0a030; }
            .disch-row {
                display: flex; justify-content: space-between; gap: 8px;
                padding: 2px 0; border-bottom: 1px solid #1e2638;
            }
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
                <button id="ntuh-disch-import-all">🖱️ 雙擊自動填入出院病摘</button>
                <div id="ntuh-disch-status"></div>
                <div id="ntuh-disch-log"></div>
                <div id="ntuh-disch-emp">
                    <div class="disch-emp-row"><span>R</span><b id="ntuh-disch-emp-self">—</b></div>
                    <div class="disch-emp-row"><span>VS</span><b id="ntuh-disch-emp-vs">—</b></div>
                </div>
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

        const runButton = document.getElementById('ntuh-disch-import-all');
        runButton.onclick = () => setStatus('請快速雙擊按鈕開始自動填入。', 'warn');
        runButton.ondblclick = () => { runAll(); };

        // 面板一打開不讀任何 ID（不發 request）；等按下「雙擊自動填入」才開始查
        setEmpInfo('', '', '');
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
                panel.style.top = (startTop + e.clientY - startY) + 'px';
            };
            document.onmouseup = () => {
                document.onmousemove = null;
                document.onmouseup = null;
            };
        };
    }

    // ─────────────────────────────────────────────
    // 主流程
    // ─────────────────────────────────────────────
    async function runAll() {
        const box = document.getElementById('ntuh-disch-log');
        if (box) box.style.display = 'block';

        const base = fillDischargeNote();
        renderResults(base);
        setStatus('⏳ 讀取入院紀錄與病程紀錄…', 'warn');

        const [admission, assessmentImport] = await Promise.all([
            importAdmissionExtras(),
            importAssessment()
        ]);
        renderResults(base
            .concat(admission.results)
            .concat(assessmentImport && assessmentImport.row ? [assessmentImport.row] : []));

        const problems = [];
        if (!admission.ok) problems.push('入院紀錄：' + admission.error);
        if (assessmentImport && !assessmentImport.ok && assessmentImport.msg) {
            problems.push(assessmentImport.msg);
        }
        setStatus(problems.length ? '⚠ ' + problems.join('；') : '✓ 已填入，請確認後儲存。',
            problems.length ? 'warn' : 'ok');

        // 後續動作全部會觸發整頁 postback，依序排隊：
        //   員編 CR → 員編 VS → 檢驗報告（開窗／解析）→ 出院預設值
        const labButton = getEl(BTN_LAB_POP);
        const giField = getEl(PREFIX + 'tplGI_txbGI');
        const giValue = giField ? String(giField.value || '').trim() : '';
        const giEmpty = !giValue || giValue.toLowerCase() === 'nil';
        writeAfter(labButton && giEmpty ? 'lab' : 'defaults');
        scheduleEmpNoPostback();
    }

    // ─────────────────────────────────────────────
    // 初始化
    // ─────────────────────────────────────────────
    function init() {
        window.addEventListener('message', handleAssessmentMessage);

        if (window.location.href.includes('InsertDisChargeNoteContent.aspx')) {
            setTimeout(() => {
                createUI();
                // 員編 postback 造成整頁重載時，由這裡接手剩下的步驟
                if (loadEmpNoJob() || readAfter()) setTimeout(runEmpNoPostbackJob, 4000);
                // 檢驗報告帶入流程（postback 鏈）續跑
                if (readLabJob()) setTimeout(resumeLabJob, 1500);
            }, 1500);
        } else if (window.location.href.includes('DWHistoricalLabReport.aspx')) {
            setTimeout(autoSelectAndImportLab, 1500);
        } else if (window.location.href.includes('InsertProgressNoteContent.aspx')) {
            const params = new URLSearchParams(window.location.search);
            if (getQueryParamIgnoreCase(params, CAPTURE_PARAM)) {
                setTimeout(captureProgressAssessment, 1500);
            }
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
