// ==UserScript==
// @name         NTUH DiagCertificate & Consent Integrated Filler
// @namespace    http://tampermonkey.net/
// @version      1.18.0
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @description  自動填入診斷書，利用背景分頁跨網域通訊自動擷取手術同意書回傳
// @author       YT / Twb06
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/ConfirmDiagnosisOrder*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/PatientBasicInfoEdit/SimpleInfoShowUsingPlaceHolder*
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @connect      ihisaw.ntuh.gov.tw
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @resource     pdfWorker https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// ==/UserScript==

(function () {
    'use strict';

    // 記錄目前觸發背景掃描的唯一 token，用於比對 postMessage 回傳
    const CONSENT_RESULT_KEY = 'ntuh_consent_scan_result';
    const CONSENT_DETAIL_TASK_KEY = 'ntuh_consent_detail_task';
    let currentScanToken = null;
    let currentScanTimer = null;

    function handleConsentMessage(msg) {
        if (!msg || msg.ntuh !== true) return;
        if (!currentScanToken || msg.token !== currentScanToken) {
            console.warn('[DiagFiller] 忽略 token 不符的同意書掃描結果', msg.token, '≠', currentScanToken);
            return;
        }
        if (currentScanTimer) {
            clearTimeout(currentScanTimer);
            currentScanTimer = null;
        }
        if (msg.error) {
            setDiagStatus('✗ 同意書背景讀取失敗：' + msg.error, 'err');
            currentScanToken = null;
        } else if (msg.kind === 'operation-name') {
            applyDiseaseName(msg.diseaseName, msg.sourceTitle);
            applySuggestedOperationName(msg.operationName, msg.sourceTitle);
            currentScanToken = null;
        } else if (msg.data !== undefined) {
            handleReceivedConsent(msg.data);
            if (msg.awaitingOperationName) {
                setDiagStatus('⏳ 已找到同意書，正在讀取「建議手術名稱」...', 'warn');
                currentScanTimer = setTimeout(() => {
                    currentScanToken = null;
                    currentScanTimer = null;
                    setDiagStatus('⚠ 同意書清單已讀取，但無法從最可能的同意書取得建議手術名稱。', 'warn');
                }, 40000);
            } else {
                currentScanToken = null;
            }
        }
    }

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function initRouter() {
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");

            // 初始化接收端：監聽子視窗以 postMessage 回傳的同意書資料
            window.addEventListener('message', function(event) {
                // 安全性：只接受來自 ihisaw.ntuh.gov.tw 的訊息
                if (event.origin !== 'https://ihisaw.ntuh.gov.tw') return;
                handleConsentMessage(event.data);
            });
            GM_addValueChangeListener(CONSENT_RESULT_KEY, function(_name, _oldValue, newValue) {
                handleConsentMessage(newValue);
            });
            setTimeout(createDiagUI, 1500);
        }
        else if (currentUrl.includes('PatientConsentOrderEntry')) {
            const ntuhToken = new URLSearchParams(window.location.search).get('ntuh_token');
            const isOrchestratorWindow = !!ntuhToken;
            if (isOrchestratorWindow) {
                // 儲存 token 至 sessionStorage，避免頁面內部跳轉後遺失
                sessionStorage.setItem('ntuh_window_token', ntuhToken);
                console.log("[DiagFiller] 偵測到背景掃描分頁(PatientConsentOrderEntry)，啟動同意書擷取並準備回傳...");
                runConsentExtractorAndReturn();
            }
            // 一般主畫面瀏覽：無掃描 token 時不執行任何動作
        }
        else if (currentUrl.includes('SimpleInfoShowUsingPlaceHolder')) {
            const params = new URLSearchParams(window.location.search);
            const pendingTask = GM_getValue(CONSENT_DETAIL_TASK_KEY, null);
            const ntuhToken = params.get('ntuh_token') ||
                              (pendingTask && pendingTask.expiresAt > Date.now() ? pendingTask.token : '');
            if (ntuhToken) runConsentDetailExtractor(pendingTask);
        }
    }

    // =========================================================================
    // 共用工具函數與 UI 狀態
    // =========================================================================
    // 加護病房代碼（2026-07-10 使用者確認整串皆為本院加護病房）
    const ICU_SET = new Set([
        '01A1','03A1','03A2','03B','03B1','03B2',
        '03C','03C1','03C2','04A1','04A2','04B1',
        '04B2','04C1','04C2','04D1','04FI','5CVI',
        '06E1','0PII','0PIM','0PIN','0PNI','0PNO'
    ]);
    const CONSENT_TITLE_HINTS = [
        { english: /\b(port-?a|port|catheter|central venous|cvp|cvc)\b/i, chinese: /中央靜脈|血管通路|人工血管|輸液港/ },
        { english: /\b(colon|colorectal|rectal|colectomy)\b/i, chinese: /大腸|直腸|結腸/ },
        { english: /\b(gastrectomy|gastric|stomach)\b/i, chinese: /胃/ },
        { english: /\b(appendectomy|appendix)\b/i, chinese: /闌尾/ },
        { english: /\b(cholecystectomy|gallbladder|biliary)\b/i, chinese: /膽囊|膽道/ },
        { english: /\b(orthopedic|arthroplasty|fracture|fixation)\b/i, chinese: /骨科|關節|骨折/ },
        { english: /\b(cardiac|heart|coronary)\b/i, chinese: /心臟|冠狀動脈/ }
    ];

    function sendConsentResult(result) {
        GM_setValue(CONSENT_RESULT_KEY, { ntuh: true, sentAt: Date.now(), ...result });
    }

    function requestArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                onload(response) {
                    if (response.status < 200 || response.status >= 400) {
                        reject(new Error(`HTTP ${response.status}`));
                        return;
                    }
                    const rawData = response.response;
                    if (!rawData) {
                        reject(new Error('同意書回應沒有可讀取的二進位內容'));
                        return;
                    }
                    resolve({
                        data: rawData,
                        contentType: String(response.responseHeaders || '').match(/content-type:\s*([^\r\n;]+)/i)?.[1] || ''
                    });
                },
                onerror() { reject(new Error('無法下載同意書 PDF')); },
                ontimeout() { reject(new Error('下載同意書 PDF 逾時')); },
                timeout: 15000
            });
        });
    }

    // 頁首/頁尾/浮水印等雜訊行——欄位值絕不會長這樣。值跨頁時，標籤（頁尾）與
    // 內容（次頁黑框）之間會夾著這些行，不剔除就會被誤當成值吸進去。
    // 註：比對時已先移除行內所有空白（PDF 文字列常以空白拼接）。
    const CONSENT_NOISE_PATTERNS = [
        /^西元\d{3,4}年.*(?:委員會|審核通過|電子病歷版本)/,
        /文件編號|MR\d{2}-\d{3}|^版次/,
        /^時間[:：]/,
        /^病歷號[:：]/,
        /^姓名[:：]/,
        /^生日[:：]/,
        /國立臺灣大學醫學院附設醫院|NationalTaiwanUniversityHospital/i,
        /^電子病歷$/,
        /說明暨同意書/,
        /請詳細閱讀內容/,
        /^第\d+頁$/,
        /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]+$/,
        /^\d{1,3}(?:\.\d{1,3}){3}$/,                  // 浮水印：IP
        /^\d{4}\/\d{1,2}\/\d{1,2}(?:\d{1,2}:\d{2})?/, // 浮水印：日期時間
        /^\d{5,8}$/                                   // 浮水印：工號/病歷號
    ];
    const isConsentNoiseLine = compact => CONSENT_NOISE_PATTERNS.some(re => re.test(compact));

    // 同意書文字的共用前處理與規則
    function consentTextLines(text) {
        return String(text || '')
            .replace(/\r/g, '')
            .split('\n')
            .map(line => line.replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .filter(line => !isConsentNoiseLine(line.replace(/\s+/g, '')));
    }
    const isConsentBoundaryLine = compact =>
        /^(?:\d+[.、]?\s*)?(?:建議手術原因|手術原因|疾病名稱|擬實施之手術)/.test(compact) ||
        /^\d+[.、]\s*[^：:]{1,20}[:：]/.test(compact) ||
        /醫師之聲明|病人之聲明|^[一二三四五六七八九][、.]/.test(compact);
    const cleanConsentValue = value => String(value || '')
        .replace(/^\d+[.、]\s*/, '')
        .replace(/([一-鿿])\s+(?=[一-鿿])/g, '$1')
        .trim();

    // 值可能跨多行（例：「微創腰椎第三第四第五節椎間」＋「盤切除減壓、融合、固定」），
    // 因此從標籤處往下累加，直到遇到下一個欄位/區塊標記才停止。
    function collectValueBelowLabel(lines, labelRe) {
        for (let i = 0; i < lines.length; i += 1) {
            const compactLine = lines[i].replace(/\s+/g, '');
            const labelMatch = compactLine.match(labelRe);
            if (!labelMatch) continue;
            const parts = [];
            const inlineValue = (labelMatch[1] || '').trim();
            if (inlineValue) parts.push(inlineValue);
            for (let j = i + 1; j < lines.length && j < i + 8; j += 1) {
                const compactCandidate = lines[j].replace(/\s+/g, '');
                if (isConsentBoundaryLine(compactCandidate)) break;
                parts.push(lines[j]);
                if (parts.join('').replace(/\s+/g, '').length >= 60) break;
            }
            const combined = cleanConsentValue(parts.join(''));
            if (combined) return combined;
        }
        return '';
    }

    function extractSuggestedOperationNameFromText(text) {
        const lines = consentTextLines(text);
        const direct = collectValueBelowLabel(lines, /(?:建議手術名稱|建議術式)[:：]?(.*)$/);
        if (direct) return direct;
        // 後備：從「建議手術原因」往上回頭收集——術名在黑框內、緊貼在「建議手術原因」
        // 上方；標籤行留在前一頁、後面接不到值時（跨頁），這條路徑仍能命中。
        for (let i = 0; i < lines.length; i += 1) {
            const compactLine = lines[i].replace(/\s+/g, '');
            if (!/^(?:\d+[.、]?\s*)?(?:建議手術原因|手術原因)/.test(compactLine)) continue;
            const parts = [];
            for (let j = i - 1; j >= 0 && parts.length < 4; j -= 1) {
                const compactCandidate = lines[j].replace(/\s+/g, '');
                if (/建議手術名稱|建議術式/.test(compactCandidate)) break;
                if (isConsentBoundaryLine(compactCandidate)) break;
                parts.unshift(lines[j]);
                if (parts.join('').replace(/\s+/g, '').length >= 60) break;
            }
            const combined = cleanConsentValue(parts.join(''));
            if (combined) return combined;
        }
        return '';
    }

    // 「1.疾病名稱：」下方文字 → 帶入診斷書「診斷病名」
    function extractDiseaseNameFromText(text) {
        return collectValueBelowLabel(consentTextLines(text), /疾病名稱[:：]?(.*)$/);
    }

    function resolveDocumentUrls(buffer, baseUrl) {
        const html = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
        const urls = new Set();
        const addUrl = value => {
            if (!value || /^(?:javascript:|#)/i.test(value)) return;
            try { urls.add(new URL(value.replace(/&amp;/g, '&'), baseUrl).toString()); } catch (_error) {}
        };
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            for (const element of Array.from(doc.querySelectorAll('iframe[src], embed[src], object[data], a[href]'))) {
                addUrl(element.getAttribute('src') || element.getAttribute('data') || element.getAttribute('href'));
            }
        } catch (_error) {}
        for (const match of html.matchAll(/(?:window\.location(?:\.href)?|location\.href|src|data|href)\s*=\s*["']([^"']+)["']/gi)) {
            addUrl(match[1]);
        }
        for (const match of html.matchAll(/https?:\\?\/\\?\/[^"'<>\\s]+/gi)) {
            addUrl(match[0].replace(/\\\//g, '/'));
        }
        return Array.from(urls).filter(candidate =>
            /\.pdf(?:$|[?#])/i.test(candidate) ||
            /EMR|Record|SimpleInfo|PDF|Print|Download|Show/i.test(candidate)
        );
    }

    // PDF.js v3 需要指定 GlobalWorkerOptions.workerSrc，否則 getDocument 會丟出
    // 'No "GlobalWorkerOptions.workerSrc" specified.'（disableWorker 在 v3 已無效）。
    // 用 @resource 於安裝時抓下的 worker 檔轉成同源 blob URL，可繞過頁面 CSP 的 script-src、
    // 並讓 new Worker(blob:) 正常啟動（已實測此網域允許 blob worker）。
    let __pdfWorkerReadyPromise = null;
    function ensurePdfWorker() {
        if (__pdfWorkerReadyPromise) return __pdfWorkerReadyPromise;
        __pdfWorkerReadyPromise = (async () => {
            if (typeof pdfjsLib === 'undefined') return;
            if (pdfjsLib.GlobalWorkerOptions.workerSrc) return;
            let workerText = '';
            try {
                if (typeof GM_getResourceText === 'function') {
                    workerText = GM_getResourceText('pdfWorker') || '';
                }
            } catch (e) {
                console.warn('[DiagFiller] GM_getResourceText 取 pdfWorker 失敗，改用網路後備', e);
            }
            if (!workerText) {
                // 後備：直接抓 CDN 上的 worker（需 @connect cdnjs.cloudflare.com）
                workerText = await new Promise((resolve) => {
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
                            onload: (r) => resolve((r && r.responseText) || ''),
                            onerror: () => resolve(''),
                            ontimeout: () => resolve('')
                        });
                    } catch (e) {
                        resolve('');
                    }
                });
            }
            if (workerText) {
                const blob = new Blob([workerText], { type: 'application/javascript' });
                pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
            }
        })();
        return __pdfWorkerReadyPromise;
    }

    async function extractSuggestedOperationNameFromPdf(url, visited = new Set()) {
        if (typeof pdfjsLib === 'undefined') throw new Error('PDF 文字讀取元件未載入');
        await ensurePdfWorker();
        if (visited.has(url) || visited.size >= 8) throw new Error('找不到實際 PDF 網址');
        visited.add(url);
        const downloaded = await requestArrayBuffer(url);
        const bytes = downloaded.data instanceof ArrayBuffer
            ? new Uint8Array(downloaded.data)
            : new Uint8Array(await downloaded.data.arrayBuffer());
        const header = new TextDecoder('ascii').decode(bytes.slice(0, 5));
        if (header !== '%PDF-') {
            const candidates = resolveDocumentUrls(downloaded.data, url);
            let lastError = new Error(`同意書網址未直接回傳 PDF（${downloaded.contentType || '未知格式'}）`);
            for (const candidate of candidates) {
                try {
                    return await extractSuggestedOperationNameFromPdf(candidate, visited);
                } catch (error) {
                    lastError = error;
                }
            }
            throw lastError;
        }

        const loadingTask = pdfjsLib.getDocument({
            data: bytes,
            isEvalSupported: false
        });
        const pdf = await loadingTask.promise;
        const pageTexts = [];
        let operationName = '';
        let operationPage = 0;
        let diseaseName = '';
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const content = await page.getTextContent();
            const rows = new Map();
            for (const item of content.items) {
                const y = Math.round(Number(item.transform?.[5] || 0) / 3) * 3;
                if (!rows.has(y)) rows.set(y, []);
                rows.get(y).push({ x: Number(item.transform?.[4] || 0), text: item.str || '' });
            }
            const pageText = Array.from(rows.entries())
                .sort((a, b) => b[0] - a[0])
                .map(([, items]) => items.sort((a, b) => a.x - b.x).map(item => item.text).join(' '))
                .join('\n');
            console.log(`[DiagFiller] PDF 第 ${pageNumber}/${pdf.numPages} 頁文字片段：`, pageText.slice(0, 500));
            pageTexts.push(pageText);
            if (!operationName) {
                const found = extractSuggestedOperationNameFromText(pageText);
                if (found) { operationName = found; operationPage = pageNumber; }
            }
            if (!diseaseName) diseaseName = extractDiseaseNameFromText(pageText);
            if (operationName && diseaseName) break;
        }
        // 跨頁後備：標籤在前頁頁尾、值在次頁黑框內時，單頁各抓不到 → 全文串起來再抓一次
        if (!operationName) {
            const crossPageName = extractSuggestedOperationNameFromText(pageTexts.join('\n'));
            if (crossPageName) {
                const compactHead = crossPageName.replace(/\s+/g, '').slice(0, 4);
                const matchedIndex = pageTexts.findIndex(t => t.replace(/\s+/g, '').includes(compactHead));
                console.log('[DiagFiller] 單頁未命中，跨頁串接後取得術名：', crossPageName);
                operationName = crossPageName;
                operationPage = matchedIndex >= 0 ? matchedIndex + 1 : 1;
            }
        }
        if (!diseaseName) diseaseName = extractDiseaseNameFromText(pageTexts.join('\n'));
        return { operationName, diseaseName, pageNumber: operationPage, pageCount: pdf.numPages };
    }

    // 「診斷病名」textarea 沒有事先確認過的 id：以「診斷病名」標籤鄰近位置定位，
    // 對每個 textarea 往上爬幾層祖先、看前面的兄弟元素文字是否含標籤字樣。
    function findDiagnosisTextarea() {
        for (const textarea of Array.from(document.querySelectorAll('textarea'))) {
            let node = textarea;
            for (let depth = 0; depth < 4 && node; depth += 1) {
                let sibling = node.previousElementSibling;
                let hops = 0;
                while (sibling && hops < 4) {
                    if (/診斷病名/.test(sibling.textContent || '')) return textarea;
                    sibling = sibling.previousElementSibling;
                    hops += 1;
                }
                node = node.parentElement;
            }
        }
        return null;
    }

    // 同意書「1.疾病名稱」的值 → 診斷書「診斷病名」。
    // 空欄直接填；已含相同病名不動；已有其他內容則換行附加（不覆蓋醫師手打的字）。
    function applyDiseaseName(diseaseName, sourceTitle) {
        const name = String(diseaseName || '').trim();
        if (!name) return;
        const textarea = findDiagnosisTextarea();
        if (!textarea) {
            setDiagStatus('⚠ 找不到「診斷病名」欄位，無法帶入：' + name, 'warn');
            return;
        }
        const existing = textarea.value.trim();
        if (existing.includes(name)) return;
        textarea.value = existing ? existing + '\n' + name : name;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        setDiagStatus(`✓ 已從「${sourceTitle || '手術同意書'}」帶入診斷病名：${name}`, 'ok');
    }

    function scoreConsentCandidate(item, opDate, opName) {
        let score = 0;
        const itemDate = String(item.date || '').substring(0, 10);
        if (opDate && itemDate === opDate) score += 100;
        if (item.status === '已簽署') score += 10;
        for (const hint of CONSENT_TITLE_HINTS) {
            if (hint.english.test(opName || '') && hint.chinese.test(item.title || '')) score += 50;
        }
        if (/手術說明暨同意書|術式同意書/.test(item.title || '')) score += 5;
        return score;
    }

    function applySuggestedOperationName(operationName, sourceTitle) {
        const chineseName = String(operationName || '').trim();
        if (!chineseName) {
            setDiagStatus('⚠ 已開啟同意書，但找不到「建議手術名稱」，保留原英文術式。', 'warn');
            return;
        }

        const opInput = document.getElementById('ntuh-diag-op-name');
        const oldName = opInput ? opInput.value.trim() : '';
        if (opInput) {
            opInput.value = chineseName;
            opInput.dispatchEvent(new Event('input', { bubbles: true }));
            opInput.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const instruction = document.getElementById('NTUHWeb1_InstructionSetItem');
        if (instruction && oldName && instruction.value.includes(oldName)) {
            fillField('NTUHWeb1_InstructionSetItem', instruction.value.split(oldName).join(chineseName));
        }
        const preview = document.getElementById('ntuh-diag-preview');
        if (preview && oldName && preview.textContent.includes(oldName)) {
            preview.textContent = preview.textContent.split(oldName).join(chineseName);
        }
        setDiagStatus(`✓ 已從「${sourceTitle || '手術同意書'}」帶入建議手術名稱：${chineseName}`, 'ok');
    }

    function fmtDate(s) {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `西元${d.getFullYear()}年${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日`;
    }

    function fmtDateTime(s) {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `西元${d.getFullYear()}年${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日${String(d.getHours()).padStart(2,'0')}時${String(d.getMinutes()).padStart(2,'0')}分`;
    }

    function parseDate(dateStr) {
        if (!dateStr) return null;
        const clean = dateStr.substring(0, 10).trim().replace(/-/g, '/');
        const d = new Date(clean);
        return isNaN(d.getTime()) ? null : d;
    }

    function todayStr() {
        const d = new Date();
        return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    }

    function tomorrowStr() {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    }

    function waitForEl(selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const check = () => {
                const selectors = selector.split(',');
                for (const sel of selectors) {
                    const el = document.querySelector(sel.trim());
                    if (el) {
                        if ((el.id && el.id.includes('Msg')) || el.className.includes('errorMsgText')) {
                            if (el.textContent.trim()) return el;
                        } else {
                            return el;
                        }
                    }
                }
                return null;
            };

            const el = check();
            if (el) return resolve(el);

            const obs = new MutationObserver(() => {
                const el = check();
                if (el) { obs.disconnect(); resolve(el); }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); reject(new Error('timeout: ' + selector)); }, timeout);
        });
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // 修正的 simulateClick：優先使用原生 click 以避開 Sandbox View 錯誤
    function simulateClick(el) {
        if (typeof el.click === 'function') {
            el.click();
            return;
        }
        ['mousedown','mouseup','click'].forEach(type =>
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
        );
    }

    async function expandOne(btnId, waitSelector, timeoutMs = 8000) {
        const checkExist = () => {
            const selectors = waitSelector.split(',');
            for (const sel of selectors) {
                const el = document.querySelector(sel.trim());
                if (el) {
                    if ((el.id && el.id.includes('Msg')) || el.className.includes('errorMsgText')) {
                        if (el.textContent.trim()) return el;
                    } else {
                        return el;
                    }
                }
            }
            return null;
        };
        if (checkExist()) return;
        const btn = document.getElementById(btnId);
        if (!btn) { console.warn('[DiagFiller] 找不到按鈕：', btnId); return; }
        simulateClick(btn);
        try { await waitForEl(waitSelector, timeoutMs); } catch(e) { console.warn('[DiagFiller] 展開逾時：', waitSelector); }
        await sleep(200);
    }

    function setDiagStatus(msg, type) {
        const el = document.getElementById('ntuh-diag-status');
        if (!el) return;
        el.textContent = msg;
        el.className = type === 'ok' ? 'diag-ok' : type === 'err' ? 'diag-err' : 'diag-warn';
    }

    // =========================================================================
    // 模組一：診斷書畫面核心邏輯與資料抓取
    // =========================================================================
    // 抓取門診日期
    function fetchOpdDates(currentDept) {
        // 從門診參考資料的區塊內搜尋所有的列
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory tr.tableText2'));
        const dates = [];
        for (const tr of rows) {
            // 讀取該列對應的科部名稱 (多層 fallback 確保相容性)
            let recordDept = '';
            const deptSpan = tr.querySelector('span[id*="lblHfDeptName"]');
            if (deptSpan && deptSpan.textContent.trim()) {
                recordDept = deptSpan.textContent.trim();
            } else {
                // Fallback 1: 從 lblDeptName 的 title 屬性中提取 (例如 "科別：家庭醫學部")
                const lblDept = tr.querySelector('span[id*="lblDeptName"]');
                if (lblDept) {
                    const title = lblDept.getAttribute('title') || '';
                    const match = title.match(/科別：\s*([^\s\n]+)/);
                    if (match) {
                        recordDept = match[1].trim();
                    } else if (lblDept.textContent.trim()) {
                        recordDept = lblDept.textContent.trim();
                    }
                }
            }

            // 比對是否與開立診斷書的科部相符
            let isMatch = false;
            const clean = s => s.replace(/(部|科|門診)$/, '').trim();
            const cleanCurrent = (currentDept && currentDept !== '[科別]' && currentDept !== '[請選擇]') ? clean(currentDept) : '';
            const cleanRecord = recordDept ? clean(recordDept) : '';

            if (!cleanCurrent) {
                // 若當前診斷書科別無效/空白，預設不過濾（相容舊邏輯，防止抓不到資料）
                isMatch = true;
            } else if (!cleanRecord) {
                // 若此列門診紀錄無法辨識科別，預設不過濾
                isMatch = true;
            } else {
                isMatch = cleanCurrent.includes(cleanRecord) || cleanRecord.includes(cleanCurrent);
            }

            console.log(`[DiagFiller] 門診科別比對: 診斷書科別="${currentDept}" (簡化: "${cleanCurrent}"), 此列科別="${recordDept}" (簡化: "${cleanRecord}") -> 結果: ${isMatch ? '符合' : '不符'}`);

            if (isMatch) {
                const matches = tr.textContent.match(/\d{4}\/\d{2}\/\d{2}/g);
                if (matches) {
                    dates.push(...matches);
                }
            }
        }
        const uniqueDates = [...new Set(dates)];
        // 由舊到新排序
        uniqueDates.sort((a, b) => new Date(a) - new Date(b));
        return uniqueDates;
    }

    function fetchInpatData() {
        const rows = [];
        const trs = Array.from(document.querySelectorAll('#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_gvwLogPatTransferBed tr.tableText2'));
        for (const tr of trs) {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 5) continue;
            const deptSpan = tds[0].querySelector('span[id*="lblDeptName"]');
            if (!deptSpan) continue;
            const fullTitle = deptSpan.getAttribute('title') || '';
            // 舊版 title 為「病房：08C」；新版（DiagCertificate_New）改為「床：T0-08C -10-02」，
            // 病房碼取院區前綴（T0-）後的第一段，供 ICU_SET 比對
            const wardMatch = fullTitle.match(/病房：\s*([^\s\n]+)/)
                || fullTitle.match(/床：\s*(?:T\d+\s*-\s*)?([0-9A-Z]+)/i);
            const startMatch = fullTitle.match(/起日：\s*([^\s\n]+)/);
            const endMatch = fullTitle.match(/迄日：\s*([^\s\n]*)/);
            const bed = wardMatch ? wardMatch[1].trim() : '';
            const sd = startMatch ? startMatch[1].trim() : '';
            let ed = endMatch ? endMatch[1].trim() : '';
            if (ed === '0001/01/01') ed = '';
            if (sd) rows.push({ bed, start: sd, end: ed });
        }
        return analyzeTransferRows(rows);
    }

    // 轉床列（新→舊排序）→ 本次住院的病房序列。
    // 先沿「迄日＝上一段起日」串出本次住院的連續時間線，再把同病房的換床合併，
    // 得到 stays（舊→新）：[{ ward, icu, start }]，供 buildText 寫「加護/一般病房住院（續治療）」。
    function analyzeTransferRows(rows) {
        if (rows.length === 0) return { inpatStartDate: '', stays: [] };
        let inpatStartDate = rows[0].start;
        const validTimeline = [rows[0]];
        for (let i = 1; i < rows.length; i++) {
            const currentEvent = rows[i - 1]; const historicalEvent = rows[i];
            if (historicalEvent.end && historicalEvent.end === currentEvent.start) {
                inpatStartDate = historicalEvent.start; validTimeline.unshift(historicalEvent);
            } else { break; }
        }
        const stays = [];
        for (const r of validTimeline) {
            const last = stays[stays.length - 1];
            if (last && last.ward === r.bed) continue; // 同病房換床不算轉病房
            stays.push({ ward: r.bed, icu: ICU_SET.has(r.bed), start: r.start });
        }
        return { inpatStartDate, stays };
    }

    function fetchOpData() {
        let opDate = '', opName = '', bestDate = null;
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_dgOpScheduleData tr.tableText2'));
        for (const tr of rows) {
            const tds = tr.querySelectorAll('td'); if (tds.length < 5) continue;
            const classSpan = tds[0].querySelector('span[id*="PatClassCode"]'); if (!classSpan) continue;
            const fullTitle = classSpan.getAttribute('title') || '';
            const catMatch = fullTitle.match(/類別：\s*([^\s\n]+)/);
            const catStr = catMatch ? catMatch[1].trim() : classSpan.textContent.trim();
            if (catStr !== '住院') continue;
            const dateSpan = tds[1].querySelector('span[id*="OPDateString"]'); if (!dateSpan) continue;
            const dateStr = dateSpan.textContent.trim(); if (!dateStr.match(/^\d{4}\/\d{2}\/\d{2}$/)) continue;
            let currentOpName = '';
            const hfOpSpan = tds[3].querySelector('span[id*="lblHfMainOpMode"]');
            if (hfOpSpan && hfOpSpan.textContent.trim()) { currentOpName = hfOpSpan.textContent.trim(); }
            else { const opModeMatch = fullTitle.match(/術式：\s*([\s\S]+)$/); currentOpName = opModeMatch ? opModeMatch[1].trim() : tds[3].textContent.trim(); }
            if (currentOpName.includes('\n')) { currentOpName = currentOpName.split('\n')[0].replace(/^\d+\.\s*/, '').trim(); }
            const d = new Date(dateStr.replace(/-/g, '/'));
            if (!bestDate || d > bestDate) { bestDate = d; opDate = dateStr; opName = currentOpName; }
        }
        return { opDate, opName };
    }

    function fetchEmgData() {
        let arrivalDT = '', leaveDT = '', leaveDate = '';
        const emgRows = Array.from(document.querySelectorAll('#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_gvwEmgHistory tr.tableText2'));
        if (emgRows.length === 0) return { arrivalDT, leaveDT, leaveDate };
        const latestRow = emgRows[0];
        // 新版（DiagCertificate_New）在最前面插了「查/帳號」欄，日期不再固定於第 0/1 格，
        // 改成整列依 id 尋找，且分兩輪：先要求含時分的完整時間，再退而求日期。
        // 新版來診時間藏在「日期帶入」鈕的 id 尾端（btnSetEmgDateInfo_帳號_YYYY/MM/DD HH:MM），
        // lblTriageDate（檢傷時間，隱藏欄）作為再後備；離部日期新版只有日期沒有時間。
        const findValue = (selectors, requireTime) => {
            const re = requireTime ? /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/ : /\d{4}\/\d{2}\/\d{2}(?: \d{2}:\d{2})?/;
            for (const selector of selectors) {
                for (const el of latestRow.querySelectorAll(selector)) {
                    for (const candidate of [el.getAttribute && el.getAttribute('title'), el.textContent, el.id]) {
                        const m = String(candidate || '').match(re);
                        if (m) return m[0].trim();
                    }
                }
            }
            return '';
        };
        arrivalDT = findValue(['span[id*="lblRegisterDate"]'], true)
            || findValue(['[id^="btnSetEmgDateInfo_"]'], true)
            || findValue(['span[id*="lblTriageDate"]'], true)
            || findValue(['span[id*="lblRegisterDate"], span[id*="lblTriageDate"]'], false);
        leaveDT = findValue(['span[id*="lblDischargeDate"]'], true)
            || findValue(['span[id*="lblDischargeDate"]'], false);
        if (leaveDT) leaveDate = leaveDT.substring(0, 10).trim().replace(/-/g, '/');
        return { arrivalDT, leaveDT, leaveDate };
    }

        // 依照模板組合門診文字
    function buildOpdText(dates, startDateStr, dept) {
        if (!dates || dates.length === 0) return '';
        let filtered = dates;
        if (startDateStr && startDateStr.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
            const start = new Date(startDateStr.replace(/-/g, '/'));
            filtered = dates.filter(d => new Date(d) >= start);
        }
        if (filtered.length === 0) return '';

        let dateStr = '';
        let currentYear = null;

        filtered.forEach((d, idx) => {
            const [y, m, day] = d.split('/');
            const mNum = parseInt(m, 10);
            const dNum = parseInt(day, 10);

            if (y !== currentYear) {
                if (idx !== 0) dateStr += '、';
                dateStr += `西元${y}年${mNum}月${dNum}日`;
                currentYear = y;
            } else {
                dateStr += `、${mNum}月${dNum}日`;
            }
        });

        const deptName = (dept.endsWith('科') || dept.endsWith('部')) ? dept : dept + '科';
        return `於${dateStr}至本院${deptName}門診追蹤`;
    }

    function buildText({
        hasInpat, hasOpd, hasOp,
        opdDates, opdStartDate,
        inpat, emg, dept,
        opDate, opName, dischargeDate
    }) {
        const events = [];

        // 1. 門診事件
        if (hasOpd && opdDates && opdDates.length > 0) {
            let filtered = opdDates;
            if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                const start = parseDate(opdStartDate);
                if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
            }
            if (filtered.length > 0) {
                const opdMinDateObj = parseDate(filtered[0]);
                const opdText = buildOpdText(opdDates, opdStartDate, dept);
                if (opdText) {
                    events.push({
                        type: 'opd',
                        date: opdMinDateObj,
                        text: opdText
                    });
                }
            }
        }

        // 2. 住院與手術事件合併判定
        const cleanInpatStart = inpat && inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
        const fromEmg = !!(emg && emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);
        const inpatStart = fromEmg && emg && emg.arrivalDT ? emg.arrivalDT : (inpat ? inpat.inpatStartDate : '');
        const inpatStartDateObj = parseDate(inpatStart);

        const opDateObj = parseDate(opDate);
        const dischargeDateObj = parseDate(dischargeDate);

        // 判斷手術是否在住院期間 (若是，則合併至住院事件中)
        let isOpMerged = false;
        if (hasInpat && hasOp && opDateObj && inpatStartDateObj && dischargeDateObj) {
            if (opDateObj >= inpatStartDateObj && opDateObj <= dischargeDateObj) {
                isOpMerged = true;
            }
        }

        // 3. 住院事件
        if (hasInpat && inpatStartDateObj && inpat) {
            // 病房序列：第一段決定入院寫「加護」或「一般」；之後每次轉病房都補一句「…住院續治療」。
            // 合併的手術句依日期插入正確位置（急診期間開刀→放在住院句前；住院中開刀→插在對應轉床之間）。
            const stays = (inpat.stays && inpat.stays.length) ? inpat.stays : [{ icu: false, start: inpat.inpatStartDate }];
            const wardLabel = stay => stay.icu ? '加護病房' : '一般病房';
            const clauses = [];
            const opClause = `於${fmtDate(opDate)}接受${opName ? opName + '手術' : '手術'}`;
            let opPlaced = !isOpMerged;
            const firstStayDateObj = parseDate(stays[0].start) || inpatStartDateObj;

            if (fromEmg) {
                const aStr = emg.arrivalDT ? fmtDateTime(emg.arrivalDT) : fmtDate(inpat.inpatStartDate);
                const lStr = emg.leaveDT ? fmtDateTime(emg.leaveDT) : fmtDate(inpat.inpatStartDate);
                clauses.push(`於${aStr}至本院急診就醫`);
                if (!opPlaced && opDateObj && firstStayDateObj && opDateObj < firstStayDateObj) {
                    clauses.push(opClause); opPlaced = true;
                }
                clauses.push(`於${lStr}轉至本院${dept}${wardLabel(stays[0])}住院`);
            } else {
                clauses.push(`於${fmtDate(inpat.inpatStartDate)}於本院${dept}${wardLabel(stays[0])}住院`);
            }

            // 轉病房描述（含加護↔一般、跨一般病房；同病房換床已在 analyzeTransferRows 合併）
            for (let i = 1; i < stays.length; i += 1) {
                const stayDateObj = parseDate(stays[i].start);
                if (!opPlaced && opDateObj && stayDateObj && stayDateObj > opDateObj) {
                    clauses.push(opClause); opPlaced = true;
                }
                clauses.push(`於${fmtDate(stays[i].start)}於本院${dept}${wardLabel(stays[i])}住院續治療`);
            }
            if (!opPlaced) clauses.push(opClause);

            let inpatText = clauses.join('，');

            // 出院描述
            if (dischargeDate) {
                const dp = dischargeDate.split('/');
                const dFmt = `西元${dp[0]}年${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
                inpatText += `，於${dFmt}出院`;
            }

            events.push({
                type: 'inpat',
                date: inpatStartDateObj,
                text: inpatText
            });
        }

        // 4. 獨立手術事件 (未被合併時)
        if (hasOp && opDateObj && !isOpMerged) {
            events.push({
                type: 'op',
                date: opDateObj,
                text: `於${fmtDate(opDate)}接受${opName ? opName + '手術' : '手術'}`
            });
        }

        // 5. 排序事件 (依據 date 由舊到新)
        events.sort((a, b) => a.date - b.date);

        if (events.length === 0) return '';

        // 6. 拼接文字
        if (events.length === 1) {
            const ev = events[0];
            let txt = `病人因上述原因，${ev.text}`;
            if (ev.type === 'inpat') {
                txt += `，出院後宜於門診持續追蹤治療。`;
            } else {
                txt += `。`;
            }
            return txt;
        }

        // 多個勾選
        let txt = '病人因上述原因，';
        events.forEach((ev, idx) => {
            if (idx > 0) txt += '，';
            txt += ev.text;
        });

        // 檢查住院事件後方是否有實質門診事件 (門診日期大於出院日期)
        const inpatIdx = events.findIndex(ev => ev.type === 'inpat');
        let hasOpdAfterInpat = false;
        if (inpatIdx !== -1 && hasOpd && opdDates && opdDates.length > 0) {
            const disDate = parseDate(dischargeDate);
            if (disDate) {
                hasOpdAfterInpat = opdDates.some(d => {
                    const parsedD = parseDate(d);
                    return parsedD && parsedD > disDate;
                });
            }
        }

        if (inpatIdx !== -1 && !hasOpdAfterInpat) {
            txt += `，出院後宜於門診持續追蹤治療。`;
        } else {
            txt += `。`;
        }

        return txt;
    }

    function fillField(id, value) {
        const el = document.getElementById(id); if (!el) return false;
        el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    async function runDiagFiller() {
        try {
            const runBtn = document.getElementById('ntuh-diag-run'); if (runBtn) runBtn.disabled = true;
            const hasInpatUI = document.getElementById('ntuh-diag-has-inpat')?.checked;
            const hasOpdUI = document.getElementById('ntuh-diag-has-opd')?.checked;
            const hasOpUI = document.getElementById('ntuh-diag-has-op')?.checked;

            const dischargeDate = document.getElementById('ntuh-diag-discharge').value.trim();
            if (hasInpatUI && !dischargeDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) { setDiagStatus('⚠ 請輸入正確出院日期（YYYY/MM/DD）', 'err'); if (runBtn) runBtn.disabled = false; return; }
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();

            // 1. 展開門診資料 (有勾選門診才展開)
            let opdDates = [];
            let opdStartDate = '';
            if (hasOpdUI) {
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_divOutHistoryInfo', 5000);
                opdDates = fetchOpdDates(dept);
                opdStartDate = document.getElementById('ntuh-diag-opd-start-date').value.trim();
            }

            // 2. 住院與急診資料 (有勾選住院才展開)
            let inpat = { inpatStartDate: '', stays: [] };
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            if (hasInpatUI) {
                setDiagStatus('展開住院資料…', 'warn');
                await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
                inpat = fetchInpatData();

                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try { emg = fetchEmgData(); } catch (e) { console.warn(e.message); }
            }

            // 3. 手術資料 (有勾選手術才展開)
            let opDate = '', opName = '';
            if (hasOpUI) {
                setDiagStatus('展開手術資料…', 'warn');
                await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_divOpScheduleInfo');
                const autoOp = fetchOpData();
                opDate = document.getElementById('ntuh-diag-op-date')?.value.trim() || autoOp.opDate;
                opName = document.getElementById('ntuh-diag-op-name')?.value.trim() || autoOp.opName;
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = !!(emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);

            const txt = buildText({
                hasInpat: hasInpatUI, hasOpd: hasOpdUI, hasOp: hasOpUI,
                opdDates, opdStartDate,
                inpat, emg, dept,
                opDate, opName, dischargeDate
            });

            fillField('NTUHWeb1_InstructionSetItem', txt);

            const sdEl = document.getElementById('NTUHWeb1_tbxStartDate');
            const edEl = document.getElementById('NTUHWeb1_tbxEndDate');
            const cbxI = document.getElementById('NTUHWeb1_cbxI');
            const cbxE = document.getElementById('NTUHWeb1_cbxE');

            let webStartDate = todayStr();
            let webEndDate = todayStr();

            if (hasInpatUI) {
                webStartDate = fromEmg && emg.arrivalDT ? emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/') : (cleanInpatStart || todayStr());
                webEndDate = dischargeDate;

                if (cbxI && !cbxI.checked) { cbxI.checked = true; cbxI.dispatchEvent(new Event('change', { bubbles: true })); }
                if (fromEmg && cbxE && !cbxE.checked) { cbxE.checked = true; cbxE.dispatchEvent(new Event('change', { bubbles: true })); }
            } else {
                if (cbxI && cbxI.checked) { cbxI.checked = false; cbxI.dispatchEvent(new Event('change', { bubbles: true })); }
                if (cbxE && cbxE.checked) { cbxE.checked = false; cbxE.dispatchEvent(new Event('change', { bubbles: true })); }

                if (hasOpdUI && opdDates.length > 0) {
                    let filtered = opdDates;
                    if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                        const start = parseDate(opdStartDate);
                        if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
                    }
                    if (filtered.length > 0) {
                        webStartDate = filtered[0];
                        webEndDate = filtered[filtered.length - 1];
                    }
                } else if (hasOpUI && opDate) {
                    webStartDate = opDate;
                    webEndDate = opDate;
                }
            }

            if (sdEl) sdEl.value = webStartDate;
            if (edEl) edEl.value = webEndDate;

            const rbnNotOri = document.getElementById('NTUHWeb1_rbnIsNotOriDoctor'); if (rbnNotOri && !rbnNotOri.checked) { rbnNotOri.checked = true; rbnNotOri.dispatchEvent(new Event('change', { bubbles: true })); }

            await sleep(300); const btnQueryDr = document.getElementById('NTUHWeb1_btnQueryDr'); if (btnQueryDr) simulateClick(btnQueryDr);
            await sleep(1500); const btnSaveTemp = document.getElementById('NTUHWeb1_btnSaveTemp'); if (btnSaveTemp) simulateClick(btnSaveTemp);

            const previewEl = document.getElementById('ntuh-diag-preview'); if (previewEl) { previewEl.style.display = 'block'; previewEl.textContent = txt; }
            setDiagStatus('✓ 填入完成！請確認後開立。', 'ok');
        } catch (e) { console.error(e); setDiagStatus('✗ 錯誤：' + e.message, 'err'); }
        const runBtn = document.getElementById('ntuh-diag-run'); if (runBtn) runBtn.disabled = false;
    }

    // =========================================================================
    // 跨網域通訊接收端：更新主畫面 UI
    // =========================================================================
    function handleReceivedConsent(list) {
        const container = document.getElementById('ntuh-diag-consent-result-box');
        if (!container) return;

        container.style.display = 'block';
        if (!list || list.length === 0) {
            container.innerHTML = `<div style="color:#a0aec0; font-size:11px; padding:4px 0;">⚠️ 未偵測到手術/術式相關同意書。</div>`;
            setDiagStatus('✓ 背景掃描完成，未發現手術/術式同意書', 'ok');
            return;
        }

        let html = `<div style="font-weight:bold; color:#ff7597; font-size:11px; margin-top:4px; border-top:1px dashed #2d3650; padding-top:6px;">📋 擷取到手術/術式同意書 (點擊開啟)：</div>`;
        html += `<ul style="margin:0; padding-left:14px; font-size:12px; line-height:1.6; max-height:150px; overflow-y:auto;">`;
        list.forEach(item => {
            html += `
                <li style="margin-bottom: 4px; list-style-type: square;">
                    <span style="color:#7a8aaa; font-size:11px;">[${item.date}]</span><br>
                    <a href="${item.url}" target="_blank" style="color:#63b3ed; font-weight:bold; text-decoration:underline;">
                        ${item.title}
                    </a>
                    <span style="color:#48bb78; font-size:11px;">(${item.status})</span>
                </li>`;
        });
        html += `</ul>`;
        container.innerHTML = html;
        setDiagStatus('✓ 同意書背景跨網讀取成功！', 'ok');
    }

    function makeDraggable(panel, handle) {
        let startX, startY, startLeft, startTop;
        handle.onmousedown = e => {
            const rect = panel.getBoundingClientRect();
            startX = e.clientX; startY = e.clientY;
            startLeft = rect.left; startTop = rect.top;
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = startLeft + 'px'; panel.style.top = startTop + 'px';
            document.onmousemove = e => {
                panel.style.left = (startLeft + e.clientX - startX) + 'px';
                panel.style.top = (startTop + e.clientY - startY) + 'px';
            };
            document.onmouseup = () => { document.onmousemove = null; document.onmouseup = null; };
        };
    }

    async function createDiagUI() {
        if (document.getElementById('ntuh-diag-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-diag-fab { position: fixed; bottom: 80px; right: 24px; width: 48px; height: 48px; border-radius: 50%; background: #2a1f3a; border: 2px solid #9a7cdc; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 99999; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: transform 0.15s, box-shadow 0.15s; user-select: none; }
            #ntuh-diag-fab:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
            #ntuh-diag-panel { position: fixed; bottom: 80px; right: 24px; width: 320px; background: #1a1f2e; border: 1px solid #2d3650; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); z-index: 99999; font-family: 'Consolas',monospace; font-size: 12px; color: #c8d3e8; overflow: hidden; display: none; }
            #ntuh-diag-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #2a1f3a; border-bottom: 1px solid #2d3650; cursor: move; user-select: none; font-size: 13px; font-weight: 600; }
            #ntuh-diag-close { background: none; border: none; color: #7a8aaa; cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; }
            #ntuh-diag-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
            #ntuh-diag-discharge-row { display: flex; align-items: center; gap: 8px; }
            #ntuh-diag-discharge { flex: 1; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8; font-size: 12px; padding: 5px 8px; }
            #ntuh-diag-run { padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #6a3cac; color: #fff; }
            #ntuh-diag-run:disabled { opacity: 0.5; cursor: not-allowed; }
            #ntuh-diag-preview { display: none; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; padding: 8px; font-size: 11px; max-height: 150px; overflow-y: auto; white-space: pre-wrap; color: #a8c0e8; }
            .diag-ok { color: #3fb950; } .diag-err { color: #e05c5c; } .diag-warn { color: #f0a030; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-diag-fab'; fab.textContent = '📋'; document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-diag-panel';
        panel.innerHTML = `
            <div id="ntuh-diag-header"><span>📋 診斷書囑言填入 v1.9.2</span><button id="ntuh-diag-close">✕</button></div>
            <div id="ntuh-diag-body">
                <div style="font-size:11px;color:#7a8aaa;">自動讀取病歷，填入囑言與日期。<span style="color:#f0a030;">病名請自行填寫。</span></div>

                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <label><input type="checkbox" id="ntuh-diag-has-inpat" checked /> <span>住院</span></label>
                </div>

                <div id="ntuh-diag-discharge-row" style="display:flex;align-items:center;gap:8px;"><span>出院日期</span><input id="ntuh-diag-discharge" type="text" /></div>

                <div style="display:flex;align-items:center;gap:6px;">
                    <label><input type="checkbox" id="ntuh-diag-has-opd" /> <span>有門診</span></label>
                </div>
                <div id="ntuh-diag-opd-detail" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span>起始日期</span>
                    <input id="ntuh-diag-opd-start-date" type="text" placeholder="YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-op" /> <span>手術</span></label></div>
                <div id="ntuh-diag-op-detail" style="display:none;flex-direction:column;gap:6px;">
                    <input id="ntuh-diag-op-date" type="text" placeholder="手術日期 YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                    <input id="ntuh-diag-op-name" type="text" placeholder="手術名稱" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <button id="ntuh-diag-run">✨ 自動填入囑言</button>
                <button id="ntuh-diag-open-consent" type="button" style="padding:6px 0; border:1px solid #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; font-weight:600; width:100%;">🔍 檢查同意書並帶入中文術名</button>
                <div id="ntuh-diag-status"></div>
                <div id="ntuh-diag-consent-result-box" style="display:none;"></div>
                <div id="ntuh-diag-preview"></div>
            </div>
        `;

        document.body.appendChild(panel);
        document.getElementById('ntuh-diag-discharge').value = tomorrowStr(); // 出院日期預設明日（診斷書多在出院前一天開）

        // 住院區塊打勾與隱藏出院日期
        document.getElementById('ntuh-diag-has-inpat').addEventListener('change', function() {
            const dischargeRow = document.getElementById('ntuh-diag-discharge-row');
            if (dischargeRow) {
                dischargeRow.style.display = this.checked ? 'flex' : 'none';
            }
        });

        // 門診區塊：打勾後自動展開、讀取最早日期
        document.getElementById('ntuh-diag-has-opd').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-opd-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory [id*="Msg"], #NTUHWeb1_fieldsetOutHistory .errorMsgText', 5000);
                const opdDates = fetchOpdDates();
                if (opdDates.length > 0) {
                    document.getElementById('ntuh-diag-opd-start-date').value = opdDates[0];
                    setDiagStatus('已讀取門診日期', 'ok');
                } else {
                    setDiagStatus('未找到門診紀錄', 'warn');
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        // 初始化自動抓取並預填手術資料
        try {
            setDiagStatus('展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_lblOpScheduleMsg');

            const initialOpData = fetchOpData();
            if (initialOpData.opDate || initialOpData.opName) {
                document.getElementById('ntuh-diag-has-op').checked = true;
                document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                if (initialOpData.opDate) document.getElementById('ntuh-diag-op-date').value = initialOpData.opDate;
                if (initialOpData.opName) document.getElementById('ntuh-diag-op-name').value = initialOpData.opName;
            }
        } catch (e) {
            console.warn('[DiagFiller] 初始化預填手術資料失敗：', e);
        }

        document.getElementById('ntuh-diag-has-op').addEventListener('change', function() {
            const detailEl = document.getElementById('ntuh-diag-op-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                if (!document.getElementById('ntuh-diag-op-date').value) document.getElementById('ntuh-diag-op-date').value = todayStr();
            } else { detailEl.style.display = 'none'; }
        });

        fab.onclick = () => { fab.style.display = 'none'; panel.style.display = 'block'; };
        document.getElementById('ntuh-diag-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-diag-header'));
        document.getElementById('ntuh-diag-run').onclick = () => runDiagFiller();

        // 啟動背景擷取任務
        document.getElementById('ntuh-diag-open-consent').onclick = () => {
            try {
                const currentUrlParams = new URLSearchParams(window.location.search);
                let session = currentUrlParams.get('SESSION') || '';
                let accountId = currentUrlParams.get('AccountIDSE') || '';

                if (!session) { const sEl = document.querySelector('input[name*="SESSION"], input[id*="SESSION"]'); if (sEl) session = sEl.value; }
                if (!accountId) { const aEl = document.querySelector('input[name*="AccountIDSE"], input[id*="AccountIDSE"]'); if (aEl) accountId = aEl.value; }

                let personId = currentUrlParams.get('PersonID') || '';
                if (!personId) {
                    const idEl = document.getElementById('NTUHWeb1_lblPersonID') || document.getElementById('NTUHWeb1_tbxPersonID');
                    if (idEl) personId = idEl.textContent.trim() || idEl.value.trim();
                }
                if (!personId) { alert('無法取得病人 ID'); return; }

                // 產生唯一 token：時間戳 + 隨機字串，確保每次掃描獨立，防止多分頁混淆
                const token = 'ntuh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                currentScanToken = token;
                if (currentScanTimer) clearTimeout(currentScanTimer);
                currentScanTimer = setTimeout(() => {
                    if (currentScanToken !== token) return;
                    currentScanToken = null;
                    currentScanTimer = null;
                    setDiagStatus('✗ 同意書背景讀取逾時。請確認背景分頁已登入，且 Tampermonkey 已更新至 1.9.2。', 'err');
                }, 40000);

                const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry.aspx` +
                                  `?SESSION=${session}&PatClass=I&AccountIDSE=${accountId}&PersonID=${personId}&Hosp=T0` +
                                  `&ntuh_token=${token}` +
                                  `&ntuh_op_date=${encodeURIComponent(document.getElementById('ntuh-diag-op-date')?.value.trim() || '')}` +
                                  `&ntuh_op_name=${encodeURIComponent(document.getElementById('ntuh-diag-op-name')?.value.trim() || '')}`;

                setDiagStatus('⏳ 正在跨網域背景開啟並撈取資料...', 'warn');

                GM_openInTab(targetUrl, { active: false, insert: true });
            } catch(e) {
                console.error('[DiagFiller]', e);
                if (currentScanTimer) clearTimeout(currentScanTimer);
                currentScanTimer = null;
                currentScanToken = null;
                setDiagStatus('✗ 開啟失敗: ' + e.message, 'err');
            }
        };
    }

    // =========================================================================
    // 模組二：新頁面自動擷取，並使用沙盒寫入進行跨網域傳輸
    // =========================================================================
    async function runConsentExtractorAndReturn() {
        // 從 URL 讀取 token（或 sessionStorage 作為備援）
        const token = new URLSearchParams(window.location.search).get('ntuh_token') ||
                      sessionStorage.getItem('ntuh_window_token') || '';
        try {
            await waitForEl('a[id*="ClickConsentShowList"]', 8000);
            await sleep(600);

            const links = Array.from(document.querySelectorAll('a[id*="ClickConsentShowList"]'));
            const consentList = [];
            const session = new URLSearchParams(window.location.search).get('SESSION') || '';

            links.forEach(link => {
                const id = link.id;
                const matchCtrl = id.match(/PatientConsentDataList_(ctl\d+)_ClickConsentShowList/);
                if (!matchCtrl) return;
                const controlName = matchCtrl[1];

                const emrCodeEl = document.getElementById(`PatientConsentDataList_${controlName}_EMRCode`);
                const emrIdseEl = document.getElementById(`PatientConsentDataList_${controlName}_EMRIDSE`);

                const emrCode = emrCodeEl ? emrCodeEl.value.trim() : '';
                const emrIdse = emrIdseEl ? emrIdseEl.value.trim() : '';

                if (!emrCode || !emrIdse) return;

                const fullTitle = link.textContent.trim();
                let title = fullTitle;
                let dateStr = '';
                let statusStr = '未簽';

                const bracketMatch = fullTitle.match(/^([\s\S]+?)\s*\(\s*(\d{2}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})\s*(.*?)\s*\)$/);
                if (bracketMatch) {
                    title = bracketMatch[1].trim();
                    const rawDate = bracketMatch[2];
                    const rawTime = bracketMatch[3];
                    const extra = bracketMatch[4] || '';

                    const dateParts = rawDate.split('/');
                    if (dateParts[0].length === 2) {
                        dateParts[0] = '20' + dateParts[0];
                    }
                    dateStr = `${dateParts.join('/')} ${rawTime}`;

                    if (extra.includes('已簽') || extra.includes('已簽署') || /\bsigned\b/i.test(extra)) {
                        statusStr = '已簽署';
                    }
                } else {
                    const simpleMatch = fullTitle.match(/^([\s\S]+?)\s*\(\s*(已簽署|已簽)\s*\)$/);
                    if (simpleMatch) {
                        title = simpleMatch[1].trim();
                        statusStr = '已簽署';
                    }
                }

                const isConsent = title.includes('同意書') || /\bconsent\b/i.test(title);
                const isProcedure = title.includes('術') || title.includes('檢查') ||
                                    /\b(surgery|surgical|operation|procedure|examination|exam)\b/i.test(title);
                if (isConsent && isProcedure) {
                    const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/PatientBasicInfoEdit/SimpleInfoShowUsingPlaceHolder.aspx` +
                                      `?SESSION=${session}&Func=EMRRecordSeries&EMRIDSE=${emrIdse}&EMRRecord=${emrCode}&AllowPrint=Y`;

                    consentList.push({
                        date: dateStr || todayStr(),
                        title: title,
                        status: statusStr,
                        url: targetUrl,
                        emrIdse,
                        emrCode
                    });
                }
            });

            const params = new URLSearchParams(window.location.search);
            const opDate = params.get('ntuh_op_date') || '';
            const opName = params.get('ntuh_op_name') || '';
            const ranked = consentList.slice().sort((a, b) =>
                scoreConsentCandidate(b, opDate, opName) - scoreConsentCandidate(a, opDate, opName)
            );
            const bestConsent = ranked[0] || null;
            const result = {
                ntuh: true,
                token,
                data: consentList,
                awaitingOperationName: !!bestConsent,
                sentAt: Date.now()
            };
            GM_setValue(CONSENT_RESULT_KEY, result);

            // 保留 postMessage 作為支援 window.opener 環境的備援。
            if (window.opener) {
                window.opener.postMessage(
                    result,
                    'https://hisaw.ntuh.gov.tw'
                );
                console.log('[ConsentHelper] 資料已透過 postMessage 回傳，共', consentList.length, '筆');
            } else {
                console.warn('[ConsentHelper] 無法取得 opener，資料無法回傳');
            }

            if (bestConsent) {
                try {
                    const pdfResult = await extractSuggestedOperationNameFromPdf(bestConsent.url);
                    if (pdfResult.operationName || pdfResult.diseaseName) {
                        sendConsentResult({
                            token,
                            kind: 'operation-name',
                            operationName: pdfResult.operationName,
                            diseaseName: pdfResult.diseaseName,
                            sourceTitle: `${bestConsent.title}（PDF 第 ${pdfResult.pageNumber || 1}/${pdfResult.pageCount} 頁）`
                        });
                    } else {
                        throw new Error(`已讀取 PDF 共 ${pdfResult.pageCount} 頁，但找不到建議手術名稱`);
                    }
                } catch (pdfError) {
                    console.error('[DiagFiller] 直接讀取整份 PDF 失敗：', pdfError);
                    sendConsentResult({
                        token,
                        error: `PDF 全頁解析失敗：${pdfError.message}`
                    });
                }
            }

            await sleep(300);
            console.log('[DiagFiller] 同意書清單處理完畢，準備關閉分頁...');
            window.close();

        } catch (e) {
            console.error('[ConsentHelper] 背景讀取新網頁失敗或逾時：', e.message);
            const result = { ntuh: true, token, error: e.message || '背景頁面讀取失敗', sentAt: Date.now() };
            GM_setValue(CONSENT_RESULT_KEY, result);
            if (window.opener) {
                window.opener.postMessage(
                    result,
                    'https://hisaw.ntuh.gov.tw'
                );
            }
            await sleep(100);
            window.close();
        }
    }

    async function runConsentDetailExtractor(pendingTask = null) {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('ntuh_token') || pendingTask?.token || '';
        const sourceTitle = params.get('ntuh_source_title') || pendingTask?.sourceTitle || '';

        function accessiblePageText(targetWindow, depth = 0) {
            if (!targetWindow || depth > 3) return '';
            let text = '';
            try {
                const targetDocument = targetWindow.document;
                text += '\n' + (targetDocument.body?.innerText || '');
                text += '\n' + (targetDocument.documentElement?.outerHTML || '');
                for (const element of Array.from(targetDocument.querySelectorAll('input, textarea, option, [aria-label], [title], svg text'))) {
                    text += '\n' + [
                        element.value,
                        element.textContent,
                        element.getAttribute?.('aria-label'),
                        element.getAttribute?.('title')
                    ].filter(Boolean).join('\n');
                }
                for (const frame of Array.from(targetWindow.frames || [])) {
                    text += accessiblePageText(frame, depth + 1);
                }
            } catch (_error) {
                // 無法存取的跨網域 frame 直接略過。
            }
            return text;
        }

        function detailPageLines() {
            return accessiblePageText(window)
                .replace(/\r/g, '')
                .replace(/&nbsp;|&#160;/gi, ' ')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(?:div|p|td|tr|span)>/gi, '\n')
                .replace(/<[^>]+>/g, ' ')
                .replace(/[ \t]+/g, ' ')
                .split('\n')
                .map(line => line.trim())
                .filter(Boolean)
                .filter(line => !isConsentNoiseLine(line.replace(/\s+/g, '')));
        }

        function findSuggestedOperationName() {
            const lines = detailPageLines();
            for (let i = 0; i < lines.length; i += 1) {
                const labelMatch = lines[i].match(/(?:建議手術名稱|建議術式)\s*[:：]?\s*(.*)$/);
                if (!labelMatch) continue;
                const inlineValue = labelMatch[1].trim();
                if (inlineValue) return inlineValue.replace(/^\d+[.、]\s*/, '').trim();
                for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
                    if (/^(?:\d+[.、]\s*)?建議手術原因|^手術原因/.test(lines[j])) break;
                    if (lines[j]) return lines[j].replace(/^\d+[.、]\s*/, '').trim();
                }
            }
            return '';
        }

        function findDiseaseName() {
            const lines = detailPageLines();
            for (let i = 0; i < lines.length; i += 1) {
                const labelMatch = lines[i].match(/疾病名稱\s*[:：]?\s*(.*)$/);
                if (!labelMatch) continue;
                const inlineValue = labelMatch[1].trim();
                if (inlineValue) return inlineValue.replace(/^\d+[.、]\s*/, '').trim();
                for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
                    if (/建議手術名稱|建議術式/.test(lines[j])) break;
                    if (lines[j]) return lines[j].replace(/^\d+[.、]\s*/, '').trim();
                }
            }
            return '';
        }

        try {
            let operationName = '';
            for (let i = 0; i < 24 && !operationName; i += 1) {
                await sleep(500);
                operationName = findSuggestedOperationName();
            }
            sendConsentResult({
                token,
                kind: 'operation-name',
                operationName,
                diseaseName: findDiseaseName(),
                sourceTitle
            });
            await sleep(300);
            window.close();
        } catch (e) {
            sendConsentResult({ token, error: '讀取建議手術名稱失敗：' + e.message });
            await sleep(300);
            window.close();
        }
    }

    // =========================================================================
    // 腳本進入點
    // =========================================================================
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initRouter);
    } else {
        initRouter();
    }

})();
