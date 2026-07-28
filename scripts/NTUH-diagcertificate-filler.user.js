// ==UserScript==
// @name         NTUH DiagCertificate Filler
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  自動填入診斷書＋手術同意書 PDF 解析（住院期間有手術時自動帶入建議手術名稱與診斷病名）。pdf.js 由 GitHub 提供。※ 2.0.0：新增手術同意書 PDF 解析（自動帶入建議手術名稱與診斷病名、多台刀逐台配對）
// @author       YT / Twb06
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/ConfirmDiagnosisOrder*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @connect      ihisaw.ntuh.gov.tw
// @connect      github.com
// @connect      raw.githubusercontent.com
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/vendor/pdf.min.js
// @resource     pdfWorker https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/vendor/pdf.worker.min.js
// ==/UserScript==

(function () {
    'use strict';

    let detectedOpList = [];

    // =====================================================================
    // 模組：手術同意書 PDF 解析（移植自 1.18.0；建議手術名稱＋診斷病名自動帶入）
    // =====================================================================
    const CONSENT_RESULT_KEY = 'ntuh_consent_scan_result';
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
        } else if (msg.kind === 'operation-name-multi') {
            (msg.diseaseNames || []).forEach(dn => applyDiseaseName(dn, '手術同意書'));
            (msg.items || []).forEach(it => applySuggestedOperationNameByDate(it.opDate, it.operationName));
            if (!msg.items || msg.items.length === 0) {
                setDiagStatus('⚠ 同意書已讀取，但未取得建議手術名稱。', 'warn');
            }
            currentScanToken = null;
        } else if (msg.data !== undefined) {
            handleReceivedConsent(msg.data);
            if (msg.awaitingOperationName) {
                setDiagStatus('⏳ 已找到同意書，正在逐台讀取「建議手術名稱」...', 'warn');
                currentScanTimer = setTimeout(() => {
                    currentScanToken = null;
                    currentScanTimer = null;
                    setDiagStatus('⚠ 同意書清單已讀取，但無法解析出建議手術名稱。', 'warn');
                }, 180000);
            } else {
                currentScanToken = null;
            }
        }
    }

    const CONSENT_TITLE_HINTS = [
        { english: /\b(port-?a|port|catheter|central venous|cvp|cvc)\b/i, chinese: /中央靜脈|血管通路|人工血管|輸液港/ },
        { english: /\b(colon|colorectal|rectal|colectomy)\b/i, chinese: /大腸|直腸|結腸/ },
        { english: /\b(gastrectomy|gastric|stomach)\b/i, chinese: /胃/ },
        { english: /\b(appendectomy|appendix)\b/i, chinese: /闌尾/ },
        { english: /\b(cholecystectomy|gallbladder|biliary)\b/i, chinese: /膽囊|膽道/ },
        { english: /\b(orthopedic|arthroplasty|fracture|fixation)\b/i, chinese: /骨科|關節|骨折/ },
        { english: /\b(cardiac|heart|coronary)\b/i, chinese: /心臟|冠狀動脈/ }
    ];
    // 非「主手術」的同意書（影像/檢查/導管等），從候選中排除，避免誤配到這些
    // 註：若某病人的主手術本身就是中央靜脈導管置入(Port-A)，需把「中央靜脈導管」那段拿掉
    const CONSENT_EXCLUDE = /電腦斷層|磁振造影|磁振|超音波|核醫|核子醫學|正子|血管攝影|放射線|X\s*光|中央靜脈導管|靜脈導管置入|腰椎穿刺/;

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
                // 後備：直接抓 GitHub 上的 worker（需 @connect github.com / raw.githubusercontent.com）
                workerText = await new Promise((resolve) => {
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: 'https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/vendor/pdf.worker.min.js',
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

    // 建議手術名稱 → 帶入第一列手術名稱（PDF 為主，覆蓋背景掃描的備援名稱）
    function applySuggestedOperationName(operationName, sourceTitle) {
        const chineseName = String(operationName || '').trim();
        if (!chineseName) {
            setDiagStatus('⚠ 已開啟同意書，但找不到「建議手術名稱」，保留原術式。', 'warn');
            return;
        }
        const cbxOp = document.getElementById('ntuh-diag-has-op');
        const detailEl = document.getElementById('ntuh-diag-op-detail');
        const container = document.getElementById('ntuh-diag-op-rows-container');
        if (cbxOp && !cbxOp.checked) cbxOp.checked = true;
        if (detailEl) detailEl.style.display = 'flex';
        if (container && container.children.length === 0) addOpRow(todayStr(), '', '');
        const firstRow = container ? container.querySelector('.ntuh-diag-op-row') : null;
        const nameInput = firstRow ? firstRow.querySelector('.ntuh-diag-op-name-input') : null;
        const oldName = nameInput ? nameInput.value.trim() : '';
        if (nameInput) {
            nameInput.value = chineseName;
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new Event('change', { bubbles: true }));
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

    // 多台刀：按手術日期把建議手術名稱填進對應那一列（同日多刀優先填還空著的列）
    function applySuggestedOperationNameByDate(opDate, operationName) {
        const chineseName = String(operationName || '').trim();
        if (!chineseName) return;
        const container = document.getElementById('ntuh-diag-op-rows-container');
        if (!container) return;
        const cbxOp = document.getElementById('ntuh-diag-has-op');
        const detailEl = document.getElementById('ntuh-diag-op-detail');
        if (cbxOp && !cbxOp.checked) cbxOp.checked = true;
        if (detailEl) detailEl.style.display = 'flex';
        const rows = Array.from(container.getElementsByClassName('ntuh-diag-op-row'));
        const sameDate = rows.filter(r => (r.querySelector('.ntuh-diag-op-date-input')?.value.trim() || '') === opDate);
        const target = sameDate.find(r => !(r.querySelector('.ntuh-diag-op-name-input')?.value.trim())) || sameDate[0] || rows[0] || null;
        if (!target) return;
        const nameInput = target.querySelector('.ntuh-diag-op-name-input');
        if (nameInput) {
            nameInput.value = chineseName;
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        setDiagStatus(`✓ 已帶入建議手術名稱（${opDate}）：${chineseName}`, 'ok');
    }

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

                // 日期取用順序：綁定排程日期 > 簽署日期 > EMRIDSE 前8碼(建檔日)。
                // 讓「未簽署」的主手術同意書（無括號日期）也能靠 EMRIDSE 取得日期來配對。
                const schedMatch = fullTitle.match(/綁定排程日期\s*(\d{4})\/(\d{2})\/(\d{2})/);
                if (schedMatch) {
                    dateStr = `${schedMatch[1]}/${schedMatch[2]}/${schedMatch[3]}`;
                } else if (!dateStr && /^\d{8}/.test(emrIdse)) {
                    dateStr = `${emrIdse.slice(0, 4)}/${emrIdse.slice(4, 6)}/${emrIdse.slice(6, 8)}`;
                }

                const isConsent = title.includes('同意書') || /\bconsent\b/i.test(title);
                const isProcedure = title.includes('術') || title.includes('檢查') ||
                                    /\b(surgery|surgical|operation|procedure|examination|exam)\b/i.test(title);
                if (isConsent && isProcedure && !CONSENT_EXCLUDE.test(title)) {
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
            // 解析欲配對的手術清單（ntuh_ops JSON）；退回舊的單台參數
            const opDate = params.get('ntuh_op_date') || '';
            const opName = params.get('ntuh_op_name') || '';
            let ops = [];
            try { ops = JSON.parse(params.get('ntuh_ops') || '[]'); } catch (_e) { ops = []; }
            if (!Array.isArray(ops) || ops.length === 0) {
                ops = opDate ? [{ date: opDate, name: opName }] : [];
            }

            // 先把同意書清單回傳供顯示
            const result = {
                ntuh: true,
                token,
                data: consentList,
                awaitingOperationName: ops.length > 0 && consentList.length > 0,
                sentAt: Date.now()
            };
            GM_setValue(CONSENT_RESULT_KEY, result);
            if (window.opener) {
                window.opener.postMessage(result, 'https://hisaw.ntuh.gov.tw');
                console.log('[ConsentHelper] 資料已透過 postMessage 回傳，共', consentList.length, '筆');
            }

            // 每台刀各配一份同意書（貪婪：優先當日/標題吻合且未被指派者；同日多刀盡量分不同份）
            if (ops.length > 0 && consentList.length > 0) {
                const usedUrls = new Set();
                const pdfCache = {};
                const items = [];
                const diseaseNames = [];
                for (const op of ops) {
                    const ranked = consentList.slice().sort((a, b) =>
                        scoreConsentCandidate(b, op.date, op.name) - scoreConsentCandidate(a, op.date, op.name)
                    );
                    let pool = ranked.filter(c => !usedUrls.has(c.url));
                    if (pool.length === 0) pool = ranked;
                    let chosen = pool[0] || null;
                    // 多台刀時，分數為 0（日期/標題皆不吻合）就跳過，避免亂配；單台刀沿用舊行為取最高
                    if (chosen && ops.length > 1 && scoreConsentCandidate(chosen, op.date, op.name) === 0) chosen = null;
                    if (!chosen) continue;
                    usedUrls.add(chosen.url);
                    try {
                        let parsed = pdfCache[chosen.url];
                        if (!parsed) { parsed = await extractSuggestedOperationNameFromPdf(chosen.url); pdfCache[chosen.url] = parsed; }
                        if (parsed.operationName || parsed.diseaseName) {
                            items.push({
                                opDate: op.date,
                                operationName: parsed.operationName,
                                diseaseName: parsed.diseaseName,
                                sourceTitle: `${chosen.title}（PDF ${parsed.pageNumber || 1}/${parsed.pageCount}）`
                            });
                            if (parsed.diseaseName && !diseaseNames.includes(parsed.diseaseName)) diseaseNames.push(parsed.diseaseName);
                        }
                    } catch (pdfError) {
                        console.error('[DiagFiller] PDF 解析失敗（' + op.date + '）：', pdfError);
                    }
                }
                if (items.length > 0) {
                    sendConsentResult({ token, kind: 'operation-name-multi', items, diseaseNames });
                } else {
                    sendConsentResult({ token, error: '已找到同意書，但無法解析出建議手術名稱' });
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

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function initRouter() {
        clearLegacyCookies();
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");
            // 同意書 PDF 回傳的接收端：postMessage（有 opener 時）＋ GM 值變更（跨分頁）
            window.addEventListener('message', function(event) {
                if (event.origin !== 'https://ihisaw.ntuh.gov.tw') return;
                handleConsentMessage(event.data);
            });
            if (typeof GM_addValueChangeListener === 'function') {
                GM_addValueChangeListener(CONSENT_RESULT_KEY, function(_name, _oldValue, newValue) {
                    handleConsentMessage(newValue);
                });
            }
            setTimeout(createDiagUI, 1500);
        }
        else if (currentUrl.includes('PatientConsentOrderEntry')) {
            const ntuhToken = new URLSearchParams(window.location.search).get('ntuh_token');
            if (ntuhToken) {
                sessionStorage.setItem('ntuh_window_token', ntuhToken);
                console.log("[DiagFiller] 偵測到背景同意書清單頁(PatientConsentOrderEntry)，啟動擷取…");
                runConsentExtractorAndReturn();
            }
        }
    }

    // =========================================================================
    // 共用工具函數與 UI 狀態
    // =========================================================================
    function clearLegacyCookies() {
        try {
            const cookies = document.cookie.split(';');
            for (let cookie of cookies) {
                const eqPos = cookie.indexOf('=');
                const name = eqPos > -1 ? cookie.substr(0, eqPos).trim() : cookie.trim();
                if (name.includes('ntuh_')) {
                    const domains = ['.ntuh.gov.tw', 'hisaw.ntuh.gov.tw', 'ihisaw.ntuh.gov.tw', ''];
                    const paths = ['/', '/WebApplication'];
                    for (let d of domains) {
                        for (let p of paths) {
                            const domainString = d ? `; domain=${d}` : '';
                            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${domainString}`;
                        }
                    }
                }
            }
            console.log('[DiagFiller] 已主動嘗試清理遺留之 ntuh_ 相關 Cookie，防範 HTTP 400 錯誤。');
        } catch (e) {
            console.error('[DiagFiller] 清理遺留 Cookie 失敗:', e);
        }
    }

    const ICU_SET = new Set([
        '01A1','03A1','03A2','03B','03B1','03B2',
        '03C','03C1','03C2','04A1','04A2','04B1',
        '04B2','04C1','04C2','04D1','04FI','5CVI',
        '06E1','0PII','0PIM','0PIN','0PNI','0PNO'
    ]);

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

    // 手術名稱一律以「術」收尾：中文結尾但未以「術」結束者補上「術」；英文或已含「術/手術」者不動
    function ensureOpSuffix(name) {
        const s = (name || '').trim();
        if (!s) return s;
        if (/術$/.test(s)) return s;
        if (/[一-鿿]$/.test(s)) return s + '術';
        return s;
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

    function waitForElSafe(selector, timeout = 10000) {
        return waitForEl(selector, timeout).catch(() => null);
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    function fetchOpdDates(currentDept) {
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory tr.tableText2'));
        const dates = [];
        for (const tr of rows) {
            let recordDept = '';
            const deptSpan = tr.querySelector('span[id*="lblHfDeptName"]');
            if (deptSpan && deptSpan.textContent.trim()) {
                recordDept = deptSpan.textContent.trim();
            } else {
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

            let isMatch = false;
            const clean = s => s.replace(/(部|科|門診)$/, '').trim();
            const cleanCurrent = (currentDept && currentDept !== '[科別]' && currentDept !== '[請選擇]') ? clean(currentDept) : '';
            const cleanRecord = recordDept ? clean(recordDept) : '';

            if (!cleanCurrent) {
                isMatch = true;
            } else if (!cleanRecord) {
                isMatch = true;
            } else {
                isMatch = cleanCurrent.includes(cleanRecord) || cleanRecord.includes(cleanCurrent);
            }

            if (isMatch) {
                const matches = tr.textContent.match(/\d{4}\/\d{2}\/\d{2}/g);
                if (matches) {
                    dates.push(...matches);
                }
            }
        }
        const uniqueDates = [...new Set(dates)];
        uniqueDates.sort((a, b) => new Date(a) - new Date(b));
        return uniqueDates;
    }

    function fetchInpatData() {
        // 適配 DiagCertificate_New.aspx：床號在 lblRegisterDate、以 lblAccountID 分組本次住院
        const rows = [];
        const trs = Array.from(document.querySelectorAll('#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_gvwLogPatTransferBed tr.tableText2'));
        for (const tr of trs) {
            const deptSpan = tr.querySelector('span[id$="lblDeptName"]');
            const title = deptSpan ? (deptSpan.getAttribute('title') || '') : '';
            let dept = '';
            const hfDept = tr.querySelector('span[id$="lblHfDeptName"]');
            if (hfDept && hfDept.textContent.trim()) dept = hfDept.textContent.trim();
            else { const m = title.match(/科別：\s*([^\n]+)/); if (m) dept = m[1].trim(); }
            // 床號/病房：優先讀 lblRegisterDate（顯示 04A1、08C），退而解析 title 的「床：T0-XXXX-…」
            let ward = '';
            const bedSpan = tr.querySelector('span[id$="lblRegisterDate"]');
            if (bedSpan && bedSpan.textContent.trim()) ward = bedSpan.textContent.trim();
            if (!ward) { const m = title.match(/床：\s*([^\n]+)/); if (m) ward = (m[1].trim().split('-')[1] || '').trim(); }
            const sd = (tr.querySelector('span[id$="lblTranferInDate"]')?.textContent || '').trim();
            let ed = (tr.querySelector('span[id$="lblTranferOutDate"]')?.textContent || '').trim();
            if (ed === '0001/01/01') ed = '';
            const acct = (tr.querySelector('span[id$="lblAccountID"]')?.textContent || '').trim();
            if (sd) rows.push({ bed: ward, start: sd, end: ed, dept, acct });
        }
        if (rows.length === 0) return { inpatStartDate: '', timeline: [] };
        // 列為新→舊，以最新一列的帳號框出「本次住院」，再依起日由舊到新排序
        const latestAcct = rows[0].acct;
        const timeline = rows.filter(r => r.acct === latestAcct)
            .sort((a, b) => new Date(a.start.replace(/-/g, '/')) - new Date(b.start.replace(/-/g, '/')));
        return { inpatStartDate: timeline[0].start, timeline };
    }

    function fetchOpDataList() {
        const opList = [];
        const rows = Array.from(document.querySelectorAll('#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_dgOpScheduleData tr.tableText2'));
        for (const tr of rows) {
            const tds = tr.querySelectorAll('td'); if (tds.length < 5) continue;
            const classSpan = tds[0].querySelector('span[id*="PatClassCode"]'); if (!classSpan) continue;
            if (classSpan.hasAttribute('disabled')) continue; // 排除未執行/已取消的手術
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

            const opBtn = tr.querySelector('[id^="btnSetOpDateInfo_"]');
            let opScheduleIdse = '';
            if (opBtn) {
                const match = opBtn.id.match(/btnSetOpDateInfo_([\s\S]+)$/);
                opScheduleIdse = match ? match[1].trim() : '';
            }
            if (!opScheduleIdse) {
                // 備援方案：在整行 HTML 中搜尋符合流水號格式的字串 (例如 2026-T0-066998)
                const trHtml = tr.innerHTML || '';
                const match = trHtml.match(/([A-Za-z0-9]+[-–—][A-Za-z0-9]+[-–—][A-Za-z0-9]+)/);
                if (match) {
                    opScheduleIdse = match[1].trim();
                }
            }

            if (!opList.some(item => item.opDate === dateStr && item.opName === currentOpName)) {
                opList.push({ opDate: dateStr, opName: currentOpName, opScheduleIdse: opScheduleIdse });
            }
        }
        // 按日期從新到舊排序 (最新一筆在 list[0])
        opList.sort((a, b) => new Date(b.opDate) - new Date(a.opDate));
        return opList;
    }

    function fetchOpData() {
        const list = fetchOpDataList();
        if (list.length > 0) {
            return { opDate: list[0].opDate, opName: list[0].opName };
        }
        return { opDate: '', opName: '' };
    }

    function addOpRow(date = '', name = '', opScheduleIdse = '') {
        const container = document.getElementById('ntuh-diag-op-rows-container');
        if (!container) return;

        const isFirst = container.children.length === 0;
        const row = document.createElement('div');
        row.className = 'ntuh-diag-op-row';
        row.setAttribute('data-op-idse', opScheduleIdse);
        row.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid #2d3650; border-radius:6px; background:#141824; position:relative; margin-bottom:4px;';

        let removeBtnHtml = '';
        if (!isFirst) {
            removeBtnHtml = `<button class="ntuh-diag-remove-op-btn" type="button" style="background:none; border:none; color:#e05c5c; cursor:pointer; font-size:14px; padding:0 4px; line-height:1;">✕</button>`;
        }

        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:4px;">
                <input class="ntuh-diag-op-date-input" type="text" placeholder="手術日期 YYYY/MM/DD" value="${date}" style="flex:1; background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
                ${removeBtnHtml}
            </div>
            <input class="ntuh-diag-op-name-input" type="text" placeholder="手術名稱" value="${name}" style="background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
        `;

        if (!isFirst) {
            row.querySelector('.ntuh-diag-remove-op-btn').addEventListener('click', () => {
                row.remove();
            });
        }

        container.appendChild(row);
    }

    function fetchEmgData() {
        // 適配 DiagCertificate_New.aspx：檢傷=lblTriageDate、離部=lblDischargeDate（隱藏 span，text 含 HH:mm）
        let arrivalDT = '', leaveDT = '', leaveDate = '';
        const emgRows = Array.from(document.querySelectorAll('#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_gvwEmgHistory tr.tableText2'));
        if (emgRows.length === 0) return { arrivalDT, leaveDT, leaveDate };
        const tr = emgRows[0]; // 最新一筆急診
        const pickDT = (span) => {
            if (!span) return '';
            const t = (span.getAttribute('title') || '').trim();
            // title 為純日期(時間)才採用，避免抓到多行 tooltip；否則用 text（此頁完整時間在 text）
            if (/^\d{4}[/-]\d{2}[/-]\d{2}(\s+\d{2}:\d{2})?$/.test(t)) return t;
            return span.textContent.trim();
        };
        arrivalDT = pickDT(tr.querySelector('span[id$="lblTriageDate"]'));
        leaveDT   = pickDT(tr.querySelector('span[id$="lblDischargeDate"]'));
        if (leaveDT) leaveDate = leaveDT.substring(0, 10).trim().replace(/-/g, '/');
        return { arrivalDT, leaveDT, leaveDate };
    }

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
        hasInpat, hasOpd, hasOp, hasEmg,
        opdDates, opdStartDate,
        inpat, emg, dept,
        opEvents, dischargeDate
    }) {
        const events = [];

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

        const cleanInpatStart = inpat && inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
        const fromEmg = !!(emg && emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);
        const inpatStart = fromEmg && emg && emg.arrivalDT ? emg.arrivalDT : (inpat ? inpat.inpatStartDate : '');
        const inpatStartDateObj = parseDate(inpatStart);
        const dischargeDateObj = parseDate(dischargeDate);

        const mergedOps = [];
        const unmergedOps = [];

        if (opEvents && opEvents.length > 0) {
            opEvents.forEach(evt => {
                const evtDateObj = parseDate(evt.date);
                if (hasInpat && inpatStartDateObj && dischargeDateObj && evtDateObj && evtDateObj >= inpatStartDateObj && evtDateObj <= dischargeDateObj) {
                    mergedOps.push(evt);
                } else {
                    unmergedOps.push(evt);
                }
            });
        }

        if (hasInpat && inpatStartDateObj && inpat) {
            const inpatSubEvents = [];
            const timeline = inpat.timeline || [];
            const startDept = (timeline.length > 0 && timeline[0].dept) ? timeline[0].dept : dept;

            // 1. 住院開始子事件（若入院第一床即加護病房，直接寫「加護病房住院」，不再另補轉入 ICU）
            const startIsICU = timeline.length > 0 && ICU_SET.has(timeline[0].bed);
            const startWard = startIsICU ? '加護病房' : '一般病房';
            let startText = '';
            if (fromEmg) {
                const aStr = emg.arrivalDT ? fmtDateTime(emg.arrivalDT) : fmtDate(inpat.inpatStartDate);
                const lStr = emg.leaveDT ? fmtDateTime(emg.leaveDT) : fmtDate(inpat.inpatStartDate);
                startText = `於${aStr}至本院急診就醫，於${lStr}轉至本院${startDept}${startWard}住院`;
            } else {
                startText = `於${fmtDate(inpat.inpatStartDate)}於本院${startDept}${startWard}住院`;
            }
            inpatSubEvents.push({
                date: inpatStartDateObj,
                priority: 1,
                text: startText
            });

            // 3. 遍歷住院期間的其他病房/科別異動事件
            for (let i = 1; i < timeline.length; i++) {
                const current = timeline[i];
                const prev = timeline[i - 1];
                const isCurrentICU = ICU_SET.has(current.bed);
                const isPrevICU = ICU_SET.has(prev.bed);
                const currentDateObj = parseDate(current.start) || inpatStartDateObj;

                if (isCurrentICU && !isPrevICU) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}加護病房治療`
                    });
                } else if (!isCurrentICU && isPrevICU) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}一般病房`
                    });
                } else if (!isCurrentICU && !isPrevICU && current.dept && prev.dept && current.dept !== prev.dept) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${fmtDate(current.start)}轉入本院${current.dept}一般病房`
                    });
                }
            }

            // 4. 合併住院期間的手術/檢查
            if (mergedOps.length > 0) {
                mergedOps.forEach(evt => {
                    const evtDateObj = parseDate(evt.date) || inpatStartDateObj;
                    inpatSubEvents.push({
                        date: evtDateObj,
                        priority: 2,
                        text: `於${fmtDate(evt.date)}接受${ensureOpSuffix(evt.name) || '手術'}`
                    });
                });
            }

            // 5. 出院子事件
            if (dischargeDate) {
                const dp = dischargeDate.split('/');
                const dFmt = `西元${dp[0]}年${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
                inpatSubEvents.push({
                    date: dischargeDateObj || inpatStartDateObj,
                    priority: 4,
                    text: `於${dFmt}出院`
                });
            }

            // 對所有住院子事件進行排序：先按日期，同天則按優先權：起點(1) -> 手術(2) -> 轉床(3) -> 出院(4)
            inpatSubEvents.sort((a, b) => {
                if (a.date.getTime() !== b.date.getTime()) {
                    return a.date - b.date;
                }
                return a.priority - b.priority;
            });

            // 拼接所有子事件文字
            let inpatText = '';
            inpatSubEvents.forEach((sev, sidx) => {
                if (sidx > 0) inpatText += '，';
                inpatText += sev.text;
            });

            events.push({
                type: 'inpat',
                date: inpatStartDateObj,
                text: inpatText
            });
        }

        if (hasEmg && emg && emg.arrivalDT && !(hasInpat && fromEmg)) {
            const emgArrivalDateObj = parseDate(emg.arrivalDT);
            if (emgArrivalDateObj) {
                events.push({
                    type: 'emg',
                    date: emgArrivalDateObj,
                    text: `於${fmtDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${fmtDateTime(emg.leaveDT || emg.arrivalDT)}離院`
                });
            }
        }

        // 獨立的手術事件，按日期排序
        if (unmergedOps.length > 0) {
            unmergedOps.forEach(evt => {
                const dObj = parseDate(evt.date);
                if (dObj) {
                    events.push({
                        type: 'op',
                        date: dObj,
                        text: `於${fmtDate(evt.date)}接受${ensureOpSuffix(evt.name) || '手術'}`
                    });
                }
            });
        }

        events.sort((a, b) => a.date - b.date);

        if (events.length === 0) return '';

        if (events.length === 1) {
            const ev = events[0];
            if (ev.type === 'emg') {
                return `病人於${fmtDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${fmtDateTime(emg.leaveDT || emg.arrivalDT)}離院，宜於門診追蹤治療。`;
            }
            let txt = `病人因上述原因，${ev.text}`;
            if (ev.type === 'inpat') {
                txt += `，出院後宜於門診持續追蹤治療。`;
            } else {
                txt += `。`;
            }
            return txt;
        }

        let txt = '病人因上述原因，';
        events.forEach((ev, idx) => {
            if (idx > 0) txt += '，';
            txt += ev.text;
        });

        const lastEvent = events[events.length - 1];
        if (lastEvent.type === 'inpat') {
            txt += `，出院後宜於門診持續追蹤治療。`;
        } else if (lastEvent.type === 'emg') {
            txt += `，宜於門診追蹤治療。`;
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
            const hasEmgUI = document.getElementById('ntuh-diag-has-emg')?.checked;

            const dischargeDate = document.getElementById('ntuh-diag-discharge').value.trim();
            if (hasInpatUI && !dischargeDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) { setDiagStatus('⚠ 請輸入正確出院日期（YYYY/MM/DD）', 'err'); if (runBtn) runBtn.disabled = false; return; }
            const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();

            let opdDates = [];
            let opdStartDate = '';
            if (hasOpdUI) {
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_divOutHistoryInfo', 5000);
                opdDates = fetchOpdDates(dept);
                opdStartDate = document.getElementById('ntuh-diag-opd-start-date').value.trim();
            }

            let inpat = { inpatStartDate: '', hasICU: false, icuStart: '', wardAfterICU: '' };
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            if (hasInpatUI) {
                setDiagStatus('展開住院資料…', 'warn');
                await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
                inpat = fetchInpatData();
            }
            if (hasEmgUI || hasInpatUI) {
                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try {
                    const autoEmg = fetchEmgData();
                    const manualArrival = document.getElementById('ntuh-diag-emg-arrival')?.value.trim();
                    const manualLeave = document.getElementById('ntuh-diag-emg-leave')?.value.trim();
                    emg.arrivalDT = manualArrival || autoEmg.arrivalDT;
                    emg.leaveDT = manualLeave || autoEmg.leaveDT;
                    if (emg.leaveDT) emg.leaveDate = emg.leaveDT.substring(0, 10).trim().replace(/-/g, '/');
                } catch (e) {
                    console.warn(e.message);
                }
            }

            const opEvents = [];
            if (hasOpUI) {
                setDiagStatus('展開手術資料…', 'warn');
                await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_divOpScheduleInfo');
                const container = document.getElementById('ntuh-diag-op-rows-container');
                if (container) {
                    const rows = container.getElementsByClassName('ntuh-diag-op-row');
                    for (const row of rows) {
                        const dateInput = row.querySelector('.ntuh-diag-op-date-input');
                        const nameInput = row.querySelector('.ntuh-diag-op-name-input');
                        const dateVal = dateInput ? dateInput.value.trim() : '';
                        const nameVal = nameInput ? nameInput.value.trim() : '';
                        if (dateVal) {
                            opEvents.push({ date: dateVal, name: nameVal });
                        }
                    }
                }
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = !!(emg.leaveDate && cleanInpatStart && emg.leaveDate === cleanInpatStart);

            const txt = buildText({
                hasInpat: hasInpatUI, hasOpd: hasOpdUI, hasOp: (opEvents.length > 0), hasEmg: hasEmgUI,
                opdDates, opdStartDate,
                inpat, emg, dept,
                opEvents, dischargeDate
            });

            fillField('NTUHWeb1_InstructionSetItem', txt);

            const sdEl = document.getElementById('NTUHWeb1_tbxStartDate');
            const edEl = document.getElementById('NTUHWeb1_tbxEndDate');
            const cbxI = document.getElementById('NTUHWeb1_cbxI');
            const cbxE = document.getElementById('NTUHWeb1_cbxE');

            let webStartDate = todayStr();
            let webEndDate = todayStr();

            let shouldCheckI = false;
            let shouldCheckE = false;

            if (hasInpatUI) {
                shouldCheckI = true;
            }
            if (hasEmgUI || (hasInpatUI && fromEmg)) {
                shouldCheckE = true;
            }

            const dateCandidates = [];

            if (hasInpatUI) {
                const start = (fromEmg && emg.arrivalDT)
                    ? emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/')
                    : (cleanInpatStart || todayStr());
                dateCandidates.push({ start, end: dischargeDate });
            }

            if (hasEmgUI && emg && emg.arrivalDT) {
                const start = emg.arrivalDT.substring(0, 10).trim().replace(/-/g, '/');
                const end = emg.leaveDate || start;
                dateCandidates.push({ start, end });
            }

            if (hasOpdUI && opdDates.length > 0) {
                let filtered = opdDates;
                if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                    const start = parseDate(opdStartDate);
                    if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
                }
                if (filtered.length > 0) {
                    dateCandidates.push({ start: filtered[0], end: filtered[filtered.length - 1] });
                }
            }

            opEvents.forEach(evt => {
                if (evt.date) {
                    dateCandidates.push({ start: evt.date, end: evt.date });
                }
            });

            if (dateCandidates.length > 0) {
                let minDateStr = null;
                let maxDateStr = null;
                for (const cand of dateCandidates) {
                    if (!minDateStr || new Date(cand.start) < new Date(minDateStr)) {
                        minDateStr = cand.start;
                    }
                    if (!maxDateStr || new Date(cand.end) > new Date(maxDateStr)) {
                        maxDateStr = cand.end;
                    }
                }
                webStartDate = minDateStr;
                webEndDate = maxDateStr;
            }

            if (cbxI) {
                if (cbxI.checked !== shouldCheckI) {
                    cbxI.checked = shouldCheckI;
                    cbxI.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
            if (cbxE) {
                if (cbxE.checked !== shouldCheckE) {
                    cbxE.checked = shouldCheckE;
                    cbxE.dispatchEvent(new Event('change', { bubbles: true }));
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

    function triggerConsentScan() {
        try {
            const currentUrlParams = new URLSearchParams(window.location.search);
            let session = currentUrlParams.get('SESSION') || '';
            let accountId = currentUrlParams.get('AccountIDSE') || '';
            if (!session) { const sEl = document.querySelector('input[name*="SESSION"], input[id*="SESSION"]'); if (sEl) session = sEl.value; }
            if (!accountId) { const aEl = document.querySelector('input[name*="AccountIDSE"], input[id*="AccountIDSE"]'); if (aEl) accountId = aEl.value; }
            let personId = currentUrlParams.get('PersonID') || '';
            if (!personId) {
                const idEl = document.getElementById('NTUHWeb1_lblPersonID') || document.getElementById('NTUHWeb1_tbxPersonID');
                if (idEl) personId = (idEl.textContent || idEl.value || '').trim();
            }
            if (!personId) { setDiagStatus('⚠ 無法取得病人 ID，略過同意書自動掃描', 'warn'); return; }

            // 讀所有手術列的日期/名稱，供同意書「每台刀各配一份」評分
            const opRows = Array.from(document.querySelectorAll('#ntuh-diag-op-rows-container .ntuh-diag-op-row'));
            const ops = opRows.map(r => ({
                date: r.querySelector('.ntuh-diag-op-date-input')?.value.trim() || '',
                name: r.querySelector('.ntuh-diag-op-name-input')?.value.trim() || ''
            })).filter(o => o.date);
            const opDateVal = ops[0]?.date || '';
            const opNameVal = ops[0]?.name || '';

            const token = 'ntuh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            currentScanToken = token;
            if (currentScanTimer) clearTimeout(currentScanTimer);
            // 多份 PDF 較慢，逾時隨刀數放大（每台約 30s，下限 45s、上限 180s）
            const timeoutMs = Math.min(180000, Math.max(45000, (ops.length || 1) * 30000));
            currentScanTimer = setTimeout(() => {
                if (currentScanToken !== token) return;
                currentScanToken = null; currentScanTimer = null;
                setDiagStatus('✗ 同意書背景讀取逾時。請確認背景分頁已登入。', 'err');
            }, timeoutMs);

            const targetUrl = `https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry.aspx` +
                              `?SESSION=${session}&PatClass=I&AccountIDSE=${accountId}&PersonID=${personId}&Hosp=T0` +
                              `&ntuh_token=${token}` +
                              `&ntuh_op_date=${encodeURIComponent(opDateVal)}` +
                              `&ntuh_op_name=${encodeURIComponent(opNameVal)}` +
                              `&ntuh_ops=${encodeURIComponent(JSON.stringify(ops))}`;

            setDiagStatus('⏳ 正在跨網域背景開啟並撈取同意書…', 'warn');
            GM_openInTab(targetUrl, { active: false, insert: true });
        } catch (e) {
            console.error('[DiagFiller]', e);
            if (currentScanTimer) clearTimeout(currentScanTimer);
            currentScanTimer = null; currentScanToken = null;
            setDiagStatus('✗ 同意書掃描開啟失敗: ' + e.message, 'err');
        }
    }

    async function createDiagUI() {
        if (document.getElementById('ntuh-diag-fab')) return;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-diag-fab { position: fixed; bottom: 80px; right: 24px; width: 48px; height: 48px; border-radius: 50%; background: #2a1f3a; border: 2px solid #9a7cdc; box-shadow: 0 4px 16px rgba(0,0,0,0.4); z-index: 99999; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 20px; transition: transform 0.15s, box-shadow 0.15s; user-select: none; }
            #ntuh-diag-fab:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
            #ntuh-diag-panel { position: fixed; bottom: 80px; right: 24px; width: 320px; background: #1a1f2e; border: 1px solid #2d3650; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4); z-index: 99999; font-family: 'Consolas',monospace; font-size: 12px; color: #c8d3e8; display: none; max-height: 85vh; flex-direction: column; overflow: hidden; }
            #ntuh-diag-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #2a1f3a; border-bottom: 1px solid #2d3650; cursor: move; user-select: none; font-size: 13px; font-weight: 600; flex-shrink: 0; }
            #ntuh-diag-close { background: none; border: none; color: #7a8aaa; cursor: pointer; font-size: 16px; padding: 0 4px; line-height: 1; }
            #ntuh-diag-body { padding: 12px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1; }
            #ntuh-diag-footer { padding: 10px 12px; background: #151926; border-top: 1px solid #2d3650; display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
            #ntuh-diag-discharge-row { display: none; align-items: center; gap: 8px; }
            #ntuh-diag-discharge { flex: 1; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; color: #c8d3e8; font-size: 12px; padding: 5px 8px; }
            #ntuh-diag-run { padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #6a3cac; color: #fff; flex-shrink: 0; }
            #ntuh-diag-run:disabled { opacity: 0.5; cursor: not-allowed; }
            #ntuh-diag-preview { display: none; background: #0f1420; border: 1px solid #2d3650; border-radius: 6px; padding: 8px; font-size: 11px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; color: #a8c0e8; }
            .diag-ok { color: #3fb950; } .diag-err { color: #e05c5c; } .diag-warn { color: #f0a030; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-diag-fab'; fab.textContent = '📋'; document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-diag-panel';
        panel.innerHTML = `
            <div id="ntuh-diag-header"><span>📋 診斷書囑言填入</span><button id="ntuh-diag-close">✕</button></div>
            <div id="ntuh-diag-body">
                <div style="font-size:11px;color:#7a8aaa;">自動讀取病歷，填入囑言與日期。<span style="color:#f0a030;">病名請自行填寫。</span></div>

                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <label><input type="checkbox" id="ntuh-diag-has-emg" /> <span>有急診</span></label>
                </div>
                <div id="ntuh-diag-emg-detail" style="display:none;flex-direction:column;gap:6px;margin-bottom:4px;">
                    <input id="ntuh-diag-emg-arrival" type="text" placeholder="急診入院 YYYY/MM/DD HH:mm" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                    <input id="ntuh-diag-emg-leave" type="text" placeholder="急診離院 YYYY/MM/DD HH:mm" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
                    <label><input type="checkbox" id="ntuh-diag-has-inpat" /> <span>住院</span></label>
                </div>

                <div id="ntuh-diag-discharge-row" style="display:none;align-items:center;gap:8px;"><span>出院日期</span><input id="ntuh-diag-discharge" type="text" /></div>

                <div style="display:flex;align-items:center;gap:6px;">
                    <label><input type="checkbox" id="ntuh-diag-has-opd" /> <span>有門診</span></label>
                </div>
                <div id="ntuh-diag-opd-detail" style="display:none;align-items:center;gap:8px;margin-bottom:4px;"><span>起始日期</span>
                    <input id="ntuh-diag-opd-start-date" type="text" placeholder="YYYY/MM/DD" style="background:#0f1420;border:1px solid #2d3650;border-radius:6px;color:#c8d3e8;padding:5px 8px;" />
                </div>

                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-op" /> <span>手術</span></label></div>
                <div id="ntuh-diag-op-detail" style="display:none;flex-direction:column;gap:6px;">
                    <div id="ntuh-diag-op-rows-container" style="display:flex;flex-direction:column;gap:6px;"></div>
                    <button id="ntuh-diag-add-op-btn" type="button" style="padding:4px; border:1px dashed #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; margin-top:4px;">➕ 新增手術</button>
                </div>
            </div>
            <div id="ntuh-diag-footer">
                <button id="ntuh-diag-run">✨ 自動填入囑言</button>
                <button id="ntuh-diag-open-consent" type="button" style="padding:6px 0; border:1px solid #5a6a8a; border-radius:6px; background:transparent; color:#7a8aaa; cursor:pointer; font-size:11px; width:100%;">📄 開啟病患同意書（手動查閱）</button>
                <div id="ntuh-diag-status"></div>
                <div id="ntuh-diag-consent-result-box" style="display:none;"></div>
                <div id="ntuh-diag-preview"></div>
            </div>
        `;

        document.body.appendChild(panel);
        document.getElementById('ntuh-diag-discharge').value = tomorrowStr();

        document.getElementById('ntuh-diag-has-emg').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-emg-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開急診資料…', 'warn');
                await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
                try {
                    const emg = fetchEmgData();
                    if (emg.arrivalDT) {
                        document.getElementById('ntuh-diag-emg-arrival').value = emg.arrivalDT;
                        document.getElementById('ntuh-diag-emg-leave').value = emg.leaveDT;
                        setDiagStatus('已讀取急診日期', 'ok');
                    } else {
                        setDiagStatus('未找到急診紀錄', 'warn');
                    }
                } catch (e) {
                    console.warn(e);
                    setDiagStatus('未找到急診紀錄', 'warn');
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        document.getElementById('ntuh-diag-has-inpat').addEventListener('change', function() {
            const dischargeRow = document.getElementById('ntuh-diag-discharge-row');
            if (dischargeRow) {
                dischargeRow.style.display = this.checked ? 'flex' : 'none';
            }
        });

        document.getElementById('ntuh-diag-has-opd').addEventListener('change', async function() {
            const detailEl = document.getElementById('ntuh-diag-opd-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                setDiagStatus('展開門診資料…', 'warn');
                await expandOne('NTUHWeb1_btnOutHistoryShowHide', '#NTUHWeb1_fieldsetOutHistory tr.tableText, #NTUHWeb1_fieldsetOutHistory [id*="Msg"], #NTUHWeb1_fieldsetOutHistory .errorMsgText', 5000);
                const dept = (() => { const el = document.getElementById('NTUHWeb1_ddlDeptListForPatChiCertificate'); return el ? el.options[el.selectedIndex].text.trim() : '[科別]'; })();
                const opdDates = fetchOpdDates(dept);
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

        document.getElementById('ntuh-diag-has-op').addEventListener('change', function() {
            const detailEl = document.getElementById('ntuh-diag-op-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                const container = document.getElementById('ntuh-diag-op-rows-container');
                if (container && container.children.length === 0) {
                    if (detectedOpList && detectedOpList.length > 0) {
                        addOpRow(detectedOpList[0].opDate, '', detectedOpList[0].opScheduleIdse);
                    } else {
                        addOpRow(todayStr(), '', '');
                    }
                }
            } else {
                detailEl.style.display = 'none';
            }
        });

        document.getElementById('ntuh-diag-add-op-btn').addEventListener('click', function() {
            const container = document.getElementById('ntuh-diag-op-rows-container');
            const nextIndex = container ? container.children.length : 0;
            if (detectedOpList && nextIndex < detectedOpList.length) {
                addOpRow(detectedOpList[nextIndex].opDate, '', detectedOpList[nextIndex].opScheduleIdse);
            } else {
                addOpRow(todayStr(), '', '');
            }
        });

        fab.onclick = () => { fab.style.display = 'none'; panel.style.display = 'flex'; };
        document.getElementById('ntuh-diag-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-diag-header'));
        document.getElementById('ntuh-diag-run').onclick = () => runDiagFiller();

        document.getElementById('ntuh-diag-open-consent').onclick = () => {
            const params = new URLSearchParams(window.location.search);
            const session = params.get('SESSION') || '';
            const patClass = params.get('PatClass') || 'I';
            const accountIdse = params.get('AccountIDSE') || '';
            const personId = params.get('PersonID') || '';
            const hosp = params.get('Hosp') || 'T0';
            const seed = params.get('Seed') || '';
            if (!session) { alert('無法取得 SESSION'); return; }
            const url = `http://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/PatientConsentOrderEntry.aspx?SESSION=${session}&PatClass=${patClass}&AccountIDSE=${accountIdse}&PersonID=${personId}&Hosp=${hosp}&Seed=${seed}`;
            window.open(url, '_blank');
        };

        // 啟動自動偵測與勾選
        setTimeout(autoDetectRecords, 100);
    }

    async function autoDetectRecords() {
        try {
            // 1. 住院（先偵測以取得本次住院區間，供手術過濾用）
            setDiagStatus('自動偵測病歷中：展開住院資料…', 'warn');
            await expandOne('NTUHWeb1_btnLogPatTransferBedShowHide', '#NTUHWeb1_gvwLogPatTransferBed tr.tableText, #NTUHWeb1_divLogPatTransferBedInfo');
            const inpat = fetchInpatData();
            if (inpat.inpatStartDate) {
                document.getElementById('ntuh-diag-has-inpat').checked = true;
                document.getElementById('ntuh-diag-discharge-row').style.display = 'flex';
            } else {
                document.getElementById('ntuh-diag-has-inpat').checked = false;
                document.getElementById('ntuh-diag-discharge-row').style.display = 'none';
            }

            // 2. 手術：只自動帶入落在本次住院區間內（住院起日 ~ 今日）的刀；無住院則帶最新一筆
            setDiagStatus('自動偵測病歷中：展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_lblOpScheduleMsg');
            const opList = fetchOpDataList();
            detectedOpList = opList;
            const container = document.getElementById('ntuh-diag-op-rows-container');
            if (container) container.innerHTML = '';

            let autoOps = [];
            if (inpat.inpatStartDate) {
                const startObj = parseDate(inpat.inpatStartDate);
                const endObj = new Date(); endObj.setHours(23, 59, 59, 999); // 手術皆已完成，上界取今日
                autoOps = opList.filter(o => {
                    const d = parseDate(o.opDate);
                    return d && startObj && d >= startObj && d <= endObj;
                }).sort((a, b) => parseDate(a.opDate) - parseDate(b.opDate)); // 由舊到新
            } else if (opList.length > 0) {
                autoOps = [opList[0]];
            }

            if (autoOps.length > 0) {
                document.getElementById('ntuh-diag-has-op').checked = true;
                document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                autoOps.forEach(o => addOpRow(o.opDate, '', o.opScheduleIdse));
            } else {
                document.getElementById('ntuh-diag-has-op').checked = false;
                document.getElementById('ntuh-diag-op-detail').style.display = 'none';
            }

            // 3. 急診：只有「這次急診接著這次住院」(離部日=本次住院起日) 才自動勾；
            //    有住院但急診離部日對不上（舊的、不相關急診）→ 不勾，避免把上一次住院的急診塞進本次診斷書
            setDiagStatus('自動偵測病歷中：展開急診資料…', 'warn');
            await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            try { emg = fetchEmgData(); } catch (e) { console.warn(e.message); }
            const emgFeedsThisStay = !!(emg.leaveDate && inpat.inpatStartDate &&
                emg.leaveDate.substring(0, 10) === inpat.inpatStartDate.substring(0, 10));
            const shouldCheckEmg = !!emg.arrivalDT && (!inpat.inpatStartDate || emgFeedsThisStay);
            if (shouldCheckEmg) {
                document.getElementById('ntuh-diag-has-emg').checked = true;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'flex';
                document.getElementById('ntuh-diag-emg-arrival').value = emg.arrivalDT;
                document.getElementById('ntuh-diag-emg-leave').value = emg.leaveDT;
            } else {
                document.getElementById('ntuh-diag-has-emg').checked = false;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'none';
            }

            // 4. 門診：需開門診的案例極少，一律預設不勾；使用者手動勾選時會自動展開並帶入日期
            document.getElementById('ntuh-diag-has-opd').checked = false;
            document.getElementById('ntuh-diag-opd-detail').style.display = 'none';

            setDiagStatus('✓ 病歷自動偵測完成！', 'ok');

            // 本次住院期間有手術 → 自動觸發同意書 PDF 讀取
            if (autoOps.length > 0) {
                triggerConsentScan();
            }
        } catch (e) {
            console.warn('[DiagFiller] 自動偵測病歷失敗：', e);
            setDiagStatus('⚠️ 自動偵測病歷失敗', 'warn');
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