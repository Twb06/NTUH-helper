// ==UserScript==
// @name         NTUH DiagCertificate Filler
// @namespace    http://tampermonkey.net/
// @version      2.5.0
// @description  點擊 FAB 後自動擷取診斷書資料；背景解析手術同意書 PDF，依手術流水號配對並優先同主治醫師，確認後填入囑言。支援自費項目與常用字串。
// @author       YT / Twb06 / WeiJyun9008
// @match        https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @match        https://hchhisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @connect      ihisaw.ntuh.gov.tw
// @connect      hchihisaw.ntuh.gov.tw
// @connect      hchhisaw.ntuh.gov.tw
// @connect      github.com
// @connect      raw.githubusercontent.com
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/vendor/pdf.min.js
// @resource     pdfWorker https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/vendor/pdf.worker.min.js
// ==/UserScript==

(function () {
    'use strict';

    // 院區判定：新竹分院網域一律以 hch 開頭（門診 hchhisaw / 住院 hchihisaw），
    // 總院為 hisaw / ihisaw。本腳本跑在門診診斷書頁，需向住院系統請求同意書，
    // 故不能直接用 location.origin，需依院區對應到住院系統網域。
    const IS_HSINCHU = /^hch/i.test(location.hostname);
    const INPATIENT_ORIGIN = IS_HSINCHU ? 'https://hchihisaw.ntuh.gov.tw' : 'https://ihisaw.ntuh.gov.tw';

    let detectedOpList = [];

    // =====================================================================
    // 模組：手術同意書 PDF 解析（移植自 1.18.0；建議手術名稱＋診斷病名自動帶入）
    // =====================================================================
    let currentScanToken = null;
    let currentScanTimer = null;

    function diagnosticError(error) {
        return String(error?.message || error || '未知錯誤')
            .replace(/https?:\/\/[^\s)]+/gi, '[網址已隱藏]')
            .replace(/(?:SESSION|PersonID|AccountIDSE|EMRIDSE)\s*[=:]\s*[^\s&;,]+/gi, '[識別參數已隱藏]');
    }

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
        } else if (msg.warning) {

            setDiagStatus('⚠ ' + msg.warning, 'warn');
            currentScanToken = null;
        } else if (msg.kind === 'operation-name') {
            applyDiseaseName(msg.diseaseName, msg.sourceTitle);
            applySuggestedOperationName(msg.operationName, msg.sourceTitle);
            currentScanToken = null;
        } else if (msg.kind === 'operation-name-multi') {
            (msg.diseaseNames || []).forEach(dn => applyDiseaseName(dn, '手術同意書'));
            (msg.items || []).forEach(it => applySuggestedOperationNameByDate(it.opDate, it.operationName, it.rowKey));
            if (!msg.items || msg.items.length === 0) {
                setDiagStatus('⚠ 同意書已讀取，但未取得建議手術名稱。', 'warn');
            }
            currentScanToken = null;
        } else if (msg.data !== undefined) {
            handleReceivedConsent(msg.data);
            if (msg.awaitingOperationName) {
                setDiagStatus('⏳ 已找到同意書，正在讀取所選 PDF 的「疾病名稱」...', 'warn');
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

    function requestArrayBuffer(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                anonymous: false,
                headers: { 'Referer': INPATIENT_ORIGIN + '/WebApplication/InPatient/OPManagement/ConsentFormManagement.aspx' },
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
                            timeout: 15000,
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

    async function extractSuggestedOperationNameFromPdf(url, visited = new Set(), diseaseOnly = false) {
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
                    return await extractSuggestedOperationNameFromPdf(candidate, visited, diseaseOnly);
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

            pageTexts.push(pageText);
            if (!diseaseOnly && !operationName) {
                const found = extractSuggestedOperationNameFromText(pageText);
                if (found) { operationName = found; operationPage = pageNumber; }
            }
            if (!diseaseName) diseaseName = extractDiseaseNameFromText(pageText);
            if (diseaseName && (diseaseOnly || operationName)) break;
        }
        // 跨頁後備：標籤在前頁頁尾、值在次頁黑框內時，單頁各抓不到 → 全文串起來再抓一次
        if (!diseaseOnly && !operationName) {
            const crossPageName = extractSuggestedOperationNameFromText(pageTexts.join('\n'));
            if (crossPageName) {
                const compactHead = crossPageName.replace(/\s+/g, '').slice(0, 4);
                const matchedIndex = pageTexts.findIndex(t => t.replace(/\s+/g, '').includes(compactHead));

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

    // 單筆結果的相容處理
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

    // 以本次掃描的列識別碼及排程日期定位，避免同日多刀覆寫同一列
    function applySuggestedOperationNameByDate(opDate, operationName, rowKey) {
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
        const target = rowKey
            ? sameDate.find(r => r.dataset.scanRowKey === rowKey)
            : (sameDate.length === 1 ? sameDate[0] : null);
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

        const escape = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
        let html = `<div style="font-weight:bold; color:#ff7597; font-size:11px; margin-top:4px; border-top:1px dashed #2d3650; padding-top:6px;">📋 擷取到手術/術式同意書 (點擊開啟)：</div>`;
        html += `<ul style="margin:0; padding-left:14px; font-size:12px; line-height:1.6; max-height:150px; overflow-y:auto;">`;
        list.forEach(item => {
            let url;
            try { url = new URL(item.url, INPATIENT_ORIGIN); } catch (_error) { return; }
            if (url.origin !== INPATIENT_ORIGIN) return;
            html += `
                <li style="margin-bottom: 4px; list-style-type: square;">
                    <span style="color:#7a8aaa; font-size:11px;">[${escape(item.date)}]</span><br>
                    <a href="${escape(url.href)}" target="_blank" style="color:#63b3ed; font-weight:bold; text-decoration:underline;">
                        ${escape(item.title)}
                    </a>
                    <span style="color:#48bb78; font-size:11px;">(${escape(item.doctor)}／${item.selected ? '帶入' : '其他綁定，供參考'})</span>
                </li>`;
        });
        html += `</ul>`;
        container.innerHTML = html;
        setDiagStatus('✓ 同意書背景跨網讀取成功！', 'ok');
    }

    function normalizeEmpNo(value) {
        return String(value || '').trim().replace(/^0+(?=\d)/, '');
    }

    function selectBoundConsents(consents, op) {
        if (!op.opScheduleIdse) return { bound: [], chosen: null, doctorMatched: false };
        const bound = consents.filter(item => !item.IsDelete && String(item.OpScheduleIdse || '') === op.opScheduleIdse);
        const sameDoctor = item => op.vsName
            ? String(item.VSEmpName || '').trim() === op.vsName.trim()
            : !!(op.vsEmpNo && item.VSEmpNo && normalizeEmpNo(op.vsEmpNo) === normalizeEmpNo(item.VSEmpNo));
        bound.sort((a, b) => Number(sameDoctor(b)) - Number(sameDoctor(a)) ||
            String(b.SignDateString || b.CompleteDateString || '').localeCompare(String(a.SignDateString || a.CompleteDateString || '')));
        return { bound, chosen: bound[0] || null, doctorMatched: !!bound[0] && !!sameDoctor(bound[0]) };
    }

    function requestConsentInfos(query) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: `${INPATIENT_ORIGIN}/WebApplication/InPatient/OPManagement/handler/ConsentFormHandler.ashx?Mode=QueryConsnetFormByChartNo`,
                headers: { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest',
                    'Referer': INPATIENT_ORIGIN + '/WebApplication/InPatient/OPManagement/ConsentFormManagement.aspx' },
                data: encodeURIComponent(JSON.stringify(query)),
                anonymous: false,
                timeout: 15000,
                onload(response) {

                    if (response.status < 200 || response.status >= 300) { reject(new Error(`HTTP ${response.status}`)); return; }
                    try {
                        const result = JSON.parse(response.responseText);
                        if (result.IsVerified === false) throw new Error('住院系統登入已失效');
                        if (!result.IsSuccess) throw new Error(result.ErrorMessage || '同意書查詢失敗');
                        if (!Array.isArray(result.ConsentInfos)) throw new Error('同意書 API 未回傳清單');
                        const chart = value => String(value || '').replace(/^0+(?=\d)/, '');
                        resolve(result.ConsentInfos.filter(item => !item.ChartNo || chart(item.ChartNo) === chart(query.PatChartNo)));
                    } catch (error) { reject(error); }
                },
                onerror() { reject(new Error('無法查詢手術同意書 API')); },
                ontimeout() { reject(new Error('手術同意書 API 查詢逾時')); }
            });
        });
    }

    async function readBoundConsents(consents, ops, token) {
        const list = [];
        const selections = [];
        for (const op of ops) {
            const selection = selectBoundConsents(consents, op);

            if (selection.chosen) selections.push({ op, chosen: selection.chosen });
            for (const item of selection.bound) {
                list.push({ date: op.date, title: item.SurgeryName || item.ConsentName,
                    doctor: item.VSEmpName || '', selected: item === selection.chosen,
                    url: item.ConsentLink });
            }
        }
        if (currentScanToken !== token) return;
        handleConsentMessage({ ntuh: true, token, data: list, awaitingOperationName: selections.length > 0 });
        if (!selections.length) {

            setDiagStatus('⚠ 未找到本次手術綁定同意書；請確認排程流水號及綁定資料。', 'warn');
            return;
        }
        const items = [];
        const diseaseNames = [];
        const errors = [];
        const pdfCache = new Map();
        let missingDisease = 0;
        for (const { op, chosen } of selections) {
            if (currentScanToken !== token) return;
            // API 術名立即帶入；PDF 只讀取疾病名稱，失敗仍保留 API 術名。
            const operationName = String(chosen.SurgeryName || '').trim();
            if (operationName) applySuggestedOperationNameByDate(op.date, operationName, op.rowKey);
            let diseaseName = '';
            try {
                const url = new URL(chosen.ConsentLink, INPATIENT_ORIGIN);
                if (url.origin !== INPATIENT_ORIGIN) throw new Error('同意書網址院區不符');
                if (!pdfCache.has(url.href)) pdfCache.set(url.href, await extractSuggestedOperationNameFromPdf(url.href, new Set(), true));
                const parsed = pdfCache.get(url.href);
                diseaseName = parsed.diseaseName || '';
                if (!diseaseName) missingDisease += 1;
            } catch (error) {
                errors.push(diagnosticError(error));
            }
            items.push({ opDate: op.date, rowKey: op.rowKey, operationName, diseaseName });
            if (diseaseName && !diseaseNames.includes(diseaseName)) diseaseNames.push(diseaseName);
        }
        if (currentScanToken !== token) return;

        handleConsentMessage({ ntuh: true, token, kind: 'operation-name-multi', items, diseaseNames });
        const warnings = [];
        if (selections.length < ops.length) warnings.push(`${ops.length - selections.length} 筆未取得綁定同意書`);
        if (errors.length) warnings.push(`疾病名稱 PDF 讀取失敗：${errors[0]}`);
        if (missingDisease) warnings.push(`${missingDisease} 份 PDF 未取得疾病名稱`);
        if (warnings.length) setDiagStatus('⚠ 術名已由 API 帶入；' + warnings.join('；'), 'warn');
        else setDiagStatus(`✓ 已帶入 ${selections.length} 筆手術名稱與疾病名稱；其他綁定同意書可在清單查閱。`, 'ok');
    }

    function readQueryValue(name, params, doc = document) {
        for (const [key, value] of params.entries()) if (key.toLowerCase() === name.toLowerCase() && value) return value.trim();
        const info = doc.getElementById('lblPageInfo');
        const attributes = name === 'ChartNo' ? ['data-patchartno', 'data-chartno', 'chartno']
            : name === 'HospCode' ? ['HOSPCODE', 'data-hospitalcode'] : [name, `data-${name.toLowerCase()}`];
        for (const attribute of attributes) { const value = info?.getAttribute(attribute); if (value) return value.trim(); }
        const el = doc.querySelector(`span[id$="${name}"], [id$="lbl${name}"], [id$="tbx${name}"], input[name$="${name}"], input[id$="${name}"]`);
        return String(el?.value || el?.textContent || '').trim();
    }

    // =========================================================================
    // 路由分流控制中心
    // =========================================================================
    function mountDiagUIWhenReady() {
        // 標題與填寫欄位皆出現且建立區可見，才顯示助手；涵蓋 AJAX 載入。
        let observer;
        const check = () => {
            const title = document.getElementById('NTUHWeb1_pnlCreateCertificateTitle');
            const instruction = document.getElementById('NTUHWeb1_InstructionSetItem');
            if (!title || !instruction || title.hidden || !title.getClientRects().length ||
                getComputedStyle(title).visibility === 'hidden') return false;
            observer?.disconnect();
            createDiagUI();
            return true;
        };
        if (check()) return;
        observer = new MutationObserver(check);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['style', 'class', 'hidden'] });
        check();
    }

    function initRouter() {
        clearLegacyCookies();
        const currentUrl = window.location.href;

        if (currentUrl.includes('DiagCertificate')) {
            console.log("[DiagFiller] 偵測到診斷書頁面，啟動填入與連動模組...");
            mountDiagUIWhenReady();
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
                    const domains = ['.ntuh.gov.tw', 'hisaw.ntuh.gov.tw', 'ihisaw.ntuh.gov.tw',
                                     'hchhisaw.ntuh.gov.tw', 'hchihisaw.ntuh.gov.tw', ''];
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

    function fmtYear(year, calendar = 'gregorian') {
        return calendar === 'roc' ? `民國${Number(year) - 1911}年` : `西元${year}年`;
    }

    function fmtDate(s, calendar = 'gregorian') {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `${fmtYear(d.getFullYear(), calendar)}${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日`;
    }

    function fmtDateTime(s, calendar = 'gregorian') {
        if (!s || !s.trim()) return '';
        const d = new Date(s.trim().replace(/-/g, '/'));
        if (isNaN(d)) return s.trim();
        return `${fmtYear(d.getFullYear(), calendar)}${String(d.getMonth()+1).padStart(2,'0')}月${String(d.getDate()).padStart(2,'0')}日${String(d.getHours()).padStart(2,'0')}時${String(d.getMinutes()).padStart(2,'0')}分`;
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

            const vsNoEl = tr.querySelector('[id*="VSEmpNo"], [id*="VSDoctorNo"]');
            const vsNameEl = tr.querySelector('span[id$="_OpDoctorName"], [id*="VSEmpName"], [id*="VSDoctorName"]');
            const vsMatch = fullTitle.match(/(?:主治醫師|主刀醫師|主治)[:：]\s*([^\n]+)/);
            const table = tr.closest('table');
            const doctorHeader = Array.from(table?.querySelectorAll('th') || []).find(cell => /^(醫師|主治醫師|主刀醫師)$/.test(cell.textContent.trim()));
            const doctorCell = doctorHeader ? tr.cells[doctorHeader.cellIndex] : null;
            const vsText = vsNameEl?.textContent.trim() || doctorCell?.textContent.trim() || vsMatch?.[1].trim() || '';
            const vsNo = vsNoEl?.textContent.trim() || vsText.match(/(?:\(|（)\s*(\d+)\s*(?:\)|）)/)?.[1] || '';
            const vsName = vsText.replace(/(?:\(|（)\s*\d+\s*(?:\)|）)/g, '').trim();
            if (!opList.some(item => opScheduleIdse
                ? item.opScheduleIdse === opScheduleIdse
                : item.opDate === dateStr && item.opName === currentOpName)) {
                opList.push({ opDate: dateStr, opName: currentOpName, opScheduleIdse: opScheduleIdse, vsEmpNo: vsNo, vsName });
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

    function addFeeRow(date = '', name = '') {
        const container = document.getElementById('ntuh-diag-fee-rows-container');
        if (!container) return;

        const isFirst = container.children.length === 0;
        const row = document.createElement('div');
        row.className = 'ntuh-diag-fee-row';
        row.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:6px; border:1px solid #2d3650; border-radius:6px; background:#141824; position:relative; margin-bottom:4px;';

        let removeBtnHtml = '';
        if (!isFirst) {
            removeBtnHtml = `<button class="ntuh-diag-remove-fee-btn" type="button" style="background:none; border:none; color:#e05c5c; cursor:pointer; font-size:14px; padding:0 4px; line-height:1;">✕</button>`;
        }

        row.innerHTML = `
            <div style="display:flex; align-items:center; gap:4px;">
                <input class="ntuh-diag-fee-date-input" type="text" placeholder="自費日期 YYYY/MM/DD" value="${date}" style="flex:1; background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
                ${removeBtnHtml}
            </div>
            <input class="ntuh-diag-fee-name-input" type="text" placeholder="自費項目（如：吉舒達注射劑）" value="${name}" style="background:#0f1420; border:1px solid #2d3650; border-radius:6px; color:#c8d3e8; padding:4px 6px; font-size:11px;" />
        `;

        if (!isFirst) {
            row.querySelector('.ntuh-diag-remove-fee-btn').addEventListener('click', () => {
                row.remove();
            });
        }

        container.appendChild(row);
    }

    // 自費常用項目（可編輯、GM 儲存，換病人/重開仍記得）
    const FEE_PRESETS_KEY = 'ntuh_fee_presets';
    const FEE_PRESETS_DEFAULT = ['吉舒達注射劑', '癌思停注射劑'];
    function getFeePresets() {
        try {
            if (typeof GM_getValue !== 'undefined') {
                const v = GM_getValue(FEE_PRESETS_KEY, null);
                if (Array.isArray(v)) return v;
            } else {
                const v = JSON.parse(localStorage.getItem(FEE_PRESETS_KEY) || 'null');
                if (Array.isArray(v)) return v;
            }
        } catch (e) { /* ignore */ }
        return FEE_PRESETS_DEFAULT.slice();
    }
    function saveFeePresets(arr) {
        try {
            if (typeof GM_setValue !== 'undefined') GM_setValue(FEE_PRESETS_KEY, arr);
            else localStorage.setItem(FEE_PRESETS_KEY, JSON.stringify(arr));
        } catch (e) { /* ignore */ }
    }
    // 點常用 → 填進第一個名稱空著的自費列，沒有就新增一列
    function fillFeeFromPreset(text) {
        const container = document.getElementById('ntuh-diag-fee-rows-container');
        if (!container) return;
        let target = Array.from(container.getElementsByClassName('ntuh-diag-fee-row'))
            .find(r => !(r.querySelector('.ntuh-diag-fee-name-input')?.value.trim()));
        if (!target) { addFeeRow(todayStr(), ''); target = container.lastElementChild; }
        const nameInput = target ? target.querySelector('.ntuh-diag-fee-name-input') : null;
        if (nameInput) {
            nameInput.value = text;
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
    function renderFeePresets() {
        const box = document.getElementById('ntuh-diag-fee-presets');
        if (!box) return;
        box.innerHTML = '';
        const lbl = document.createElement('span');
        lbl.textContent = '常用：';
        lbl.style.cssText = 'color:#7a8aaa;font-size:10px;margin-right:2px;';
        box.appendChild(lbl);
        getFeePresets().forEach(p => {
            const chip = document.createElement('span');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#0f1420;border:1px solid #2d3650;border-radius:10px;padding:2px 7px;margin:2px;font-size:10px;color:#a8c0e8;';
            const label = document.createElement('span');
            label.textContent = p;
            label.style.cursor = 'pointer';
            label.title = '點擊填入自費列';
            label.addEventListener('click', () => fillFeeFromPreset(p));
            const del = document.createElement('span');
            del.textContent = '✕';
            del.style.cssText = 'color:#e05c5c;cursor:pointer;font-size:9px;';
            del.title = '移除常用';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                saveFeePresets(getFeePresets().filter(x => x !== p));
                renderFeePresets();
            });
            chip.appendChild(label);
            chip.appendChild(del);
            box.appendChild(chip);
        });
        const add = document.createElement('span');
        add.textContent = '＋';
        add.style.cssText = 'display:inline-block;background:transparent;border:1px dashed #9a7cdc;border-radius:10px;padding:2px 8px;margin:2px;font-size:10px;color:#9a7cdc;cursor:pointer;';
        add.title = '新增常用項目';
        add.addEventListener('click', () => {
            const v = prompt('新增常用自費項目：');
            if (v && v.trim()) {
                const arr = getFeePresets();
                if (!arr.includes(v.trim())) { arr.push(v.trim()); saveFeePresets(arr); renderFeePresets(); }
            }
        });
        box.appendChild(add);
    }

    // 常用字串（可編輯、GM 儲存）：點擊把字串接到醫師囑言後面
    const INSTR_PRESETS_KEY = 'ntuh_instr_presets';
    const INSTR_PRESETS_DEFAULT = ['宜休養一個月', '經醫師評估需使用背架'];
    function getInstrPresets() {
        try {
            if (typeof GM_getValue !== 'undefined') {
                const v = GM_getValue(INSTR_PRESETS_KEY, null);
                if (Array.isArray(v)) return v;
            } else {
                const v = JSON.parse(localStorage.getItem(INSTR_PRESETS_KEY) || 'null');
                if (Array.isArray(v)) return v;
            }
        } catch (e) { /* ignore */ }
        return INSTR_PRESETS_DEFAULT.slice();
    }
    function saveInstrPresets(arr) {
        try {
            if (typeof GM_setValue !== 'undefined') GM_setValue(INSTR_PRESETS_KEY, arr);
            else localStorage.setItem(INSTR_PRESETS_KEY, JSON.stringify(arr));
        } catch (e) { /* ignore */ }
    }
    // 把常用字串接到醫師囑言：去掉尾句號後以「，」接續，再補回句號
    function appendInstruction(str) {
        const el = document.getElementById('NTUHWeb1_InstructionSetItem');
        if (!el) { setDiagStatus('⚠ 找不到醫師囑言欄位', 'warn'); return; }
        let cur = (el.value || '').trim();
        cur = cur ? cur.replace(/[。\s]*$/, '') + '，' + str + '。' : str + '。';
        el.value = cur;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const pv = document.getElementById('ntuh-diag-preview');
        if (pv && pv.style.display !== 'none') pv.textContent = cur;
        setDiagStatus('✓ 已加入囑言：' + str, 'ok');
    }
    function renderInstrPresets() {
        const box = document.getElementById('ntuh-diag-instr-presets');
        if (!box) return;
        box.innerHTML = '';
        const lbl = document.createElement('span');
        lbl.textContent = '常用字串：';
        lbl.style.cssText = 'color:#7a8aaa;font-size:10px;margin-right:2px;';
        box.appendChild(lbl);
        getInstrPresets().forEach(p => {
            const chip = document.createElement('span');
            chip.style.cssText = 'display:inline-flex;align-items:center;gap:4px;background:#0f1420;border:1px solid #2d3650;border-radius:10px;padding:2px 7px;margin:2px;font-size:10px;color:#a8c0e8;';
            const label = document.createElement('span');
            label.textContent = p;
            label.style.cursor = 'pointer';
            label.title = '點擊加入醫師囑言';
            label.addEventListener('click', () => appendInstruction(p));
            const del = document.createElement('span');
            del.textContent = '✕';
            del.style.cssText = 'color:#e05c5c;cursor:pointer;font-size:9px;';
            del.title = '移除常用字串';
            del.addEventListener('click', (e) => {
                e.stopPropagation();
                saveInstrPresets(getInstrPresets().filter(x => x !== p));
                renderInstrPresets();
            });
            chip.appendChild(label);
            chip.appendChild(del);
            box.appendChild(chip);
        });
        const add = document.createElement('span');
        add.textContent = '＋';
        add.style.cssText = 'display:inline-block;background:transparent;border:1px dashed #9a7cdc;border-radius:10px;padding:2px 8px;margin:2px;font-size:10px;color:#9a7cdc;cursor:pointer;';
        add.title = '新增常用字串';
        add.addEventListener('click', () => {
            const v = prompt('新增常用字串（會接在醫師囑言後面）：');
            if (v && v.trim()) {
                const arr = getInstrPresets();
                if (!arr.includes(v.trim())) { arr.push(v.trim()); saveInstrPresets(arr); renderInstrPresets(); }
            }
        });
        box.appendChild(add);
    }

    function emgFeedsStay(emg, inpatStartDate) {
        const start = parseDate(inpatStartDate);
        const leave = parseDate(emg.leaveDate);
        return !!(start && leave && start.getTime() === leave.getTime() &&
            /住院|入院|轉病房/.test(emg.disposition || '') &&
            !/拒絕|未住院|不住院|取消/.test(emg.disposition || ''));
    }

    function fetchEmgData(inpatStartDate = '') {
        const empty = { arrivalDT: '', leaveDT: '', leaveDate: '', disposition: '' };
        const table = document.getElementById('NTUHWeb1_gvwEmgHistory');
        if (!table) return empty;
        const emgRows = Array.from(table.querySelectorAll('tr.tableText, tr.tableText2'));
        // 依實際欄名定位，避免把「離部時間」誤當成「離部動向」。
        let dispositionIndex = -1;
        for (const row of Array.from(table.rows)) {
            const index = Array.from(row.cells).findIndex(cell => cell.textContent.replace(/\s+/g, '') === '離部動向');
            if (index >= 0) { dispositionIndex = index; break; }
        }
        const pickDT = span => {
            if (!span) return '';
            const title = (span.getAttribute('title') || '').trim();
            if (/^\d{4}[/-]\d{2}[/-]\d{2}(\s+\d{2}:\d{2})?$/.test(title)) return title;
            return span.textContent.trim();
        };
        const records = emgRows.map(tr => {
            const arrivalDT = pickDT(tr.querySelector('span[id$="lblTriageDate"]'));
            const leaveDT = pickDT(tr.querySelector('span[id$="lblDischargeDate"]'));
            const disposition = dispositionIndex >= 0 ? (tr.cells[dispositionIndex]?.textContent || '').trim() : '';
            return { arrivalDT, leaveDT, leaveDate: leaveDT.substring(0, 10).trim().replace(/-/g, '/'), disposition };
        });
        return inpatStartDate
            ? records.find(emg => emgFeedsStay(emg, inpatStartDate)) || empty
            : records[0] || empty;
    }

    function buildOpdText(dates, startDateStr, dept, calendar = 'gregorian') {
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
                dateStr += `${fmtYear(y, calendar)}${mNum}月${dNum}日`;
                currentYear = y;
            } else {
                dateStr += `、${mNum}月${dNum}日`;
            }
        });

        const deptName = (dept.endsWith('科') || dept.endsWith('部')) ? dept : dept + '科';
        return `於${dateStr}至本院${deptName}門診追蹤`;
    }

    // 自費事件敘述：「於{日期}接受自費{項目}治療」（項目若已含「自費」開頭則去除避免重複）
    function feeEventText(evt, calendar = 'gregorian') {
        const item = String(evt.name || '').replace(/^自費/, '').trim();
        return `於${fmtDate(evt.date, calendar)}接受自費${item}治療`;
    }

    function buildText({
        hasInpat, hasOpd, hasOp, hasEmg,
        opdDates, opdStartDate,
        inpat, emg, dept,
        opEvents, feeEvents, dischargeDate, calendar = 'gregorian'
    }) {
        const formatDate = value => fmtDate(value, calendar);
        const formatDateTime = value => fmtDateTime(value, calendar);
        const events = [];

        if (hasOpd && opdDates && opdDates.length > 0) {
            let filtered = opdDates;
            if (opdStartDate && opdStartDate.match(/^\d{4}\/\d{2}\/\d{2}$/)) {
                const start = parseDate(opdStartDate);
                if (start) filtered = opdDates.filter(d => parseDate(d) >= start);
            }
            if (filtered.length > 0) {
                const opdMinDateObj = parseDate(filtered[0]);
                const opdText = buildOpdText(opdDates, opdStartDate, dept, calendar);
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
        const fromEmg = hasEmg && !!emg && emgFeedsStay(emg, cleanInpatStart);
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

        const mergedFees = [];
        const unmergedFees = [];

        if (feeEvents && feeEvents.length > 0) {
            feeEvents.forEach(evt => {
                const evtDateObj = parseDate(evt.date);
                if (hasInpat && inpatStartDateObj && dischargeDateObj && evtDateObj && evtDateObj >= inpatStartDateObj && evtDateObj <= dischargeDateObj) {
                    mergedFees.push(evt);
                } else {
                    unmergedFees.push(evt);
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
                const aStr = emg.arrivalDT ? formatDateTime(emg.arrivalDT) : formatDate(inpat.inpatStartDate);
                const lStr = emg.leaveDT ? formatDateTime(emg.leaveDT) : formatDate(inpat.inpatStartDate);
                startText = `於${aStr}至本院急診就醫，於${lStr}轉至本院${startDept}${startWard}住院`;
            } else {
                startText = `於${formatDate(inpat.inpatStartDate)}於本院${startDept}${startWard}住院`;
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
                        text: `於${formatDate(current.start)}轉入本院${current.dept}加護病房治療`
                    });
                } else if (!isCurrentICU && isPrevICU) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${formatDate(current.start)}轉入本院${current.dept}一般病房`
                    });
                } else if (!isCurrentICU && !isPrevICU && current.dept && prev.dept && current.dept !== prev.dept) {
                    inpatSubEvents.push({
                        date: currentDateObj,
                        priority: 3,
                        text: `於${formatDate(current.start)}轉入本院${current.dept}一般病房`
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
                        text: `於${formatDate(evt.date)}接受${ensureOpSuffix(evt.name) || '手術'}`
                    });
                });
            }

            // 4b. 合併住院期間的自費項目
            if (mergedFees.length > 0) {
                mergedFees.forEach(evt => {
                    const evtDateObj = parseDate(evt.date) || inpatStartDateObj;
                    inpatSubEvents.push({
                        date: evtDateObj,
                        priority: 2,
                        text: feeEventText(evt, calendar)
                    });
                });
            }

            // 5. 出院子事件
            if (dischargeDate) {
                const dp = dischargeDate.split('/');
                const dFmt = `${fmtYear(dp[0], calendar)}${String(dp[1]).padStart(2,'0')}月${String(dp[2]).padStart(2,'0')}日`;
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
                    text: `於${formatDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${formatDateTime(emg.leaveDT || emg.arrivalDT)}離院`
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
                        text: `於${formatDate(evt.date)}接受${ensureOpSuffix(evt.name) || '手術'}`
                    });
                }
            });
        }

        // 獨立的自費事件（不在住院區間內），按日期排序
        if (unmergedFees.length > 0) {
            unmergedFees.forEach(evt => {
                const dObj = parseDate(evt.date);
                if (dObj) {
                    events.push({
                        type: 'fee',
                        date: dObj,
                        text: feeEventText(evt, calendar)
                    });
                }
            });
        }

        events.sort((a, b) => a.date - b.date);

        if (events.length === 0) return '';

        if (events.length === 1) {
            const ev = events[0];
            if (ev.type === 'emg') {
                return `病人於${formatDateTime(emg.arrivalDT)}至本院急診，經診斷治療及留院觀察後，於${formatDateTime(emg.leaveDT || emg.arrivalDT)}離院，宜於門診追蹤治療。`;
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
                    const autoEmg = fetchEmgData(hasInpatUI ? inpat.inpatStartDate : '');
                    const manualArrival = document.getElementById('ntuh-diag-emg-arrival')?.value.trim();
                    const manualLeave = document.getElementById('ntuh-diag-emg-leave')?.value.trim();
                    emg = { ...autoEmg };
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

            const feeEvents = [];
            const hasFeeUI = document.getElementById('ntuh-diag-has-fee')?.checked;
            if (hasFeeUI) {
                const feeContainer = document.getElementById('ntuh-diag-fee-rows-container');
                if (feeContainer) {
                    for (const row of feeContainer.getElementsByClassName('ntuh-diag-fee-row')) {
                        const dateVal = row.querySelector('.ntuh-diag-fee-date-input')?.value.trim() || '';
                        const nameVal = row.querySelector('.ntuh-diag-fee-name-input')?.value.trim() || '';
                        if (dateVal && nameVal) feeEvents.push({ date: dateVal, name: nameVal });
                    }
                }
            }

            const cleanInpatStart = inpat.inpatStartDate ? inpat.inpatStartDate.substring(0, 10).trim().replace(/-/g, '/') : '';
            const fromEmg = hasEmgUI && emgFeedsStay(emg, cleanInpatStart);

            const txt = buildText({
                hasInpat: hasInpatUI, hasOpd: hasOpdUI, hasOp: (opEvents.length > 0), hasEmg: hasEmgUI,
                opdDates, opdStartDate,
                inpat, emg, dept,
                opEvents, feeEvents, dischargeDate,
                calendar: document.getElementById('ntuh-diag-calendar')?.value || 'gregorian'
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

            feeEvents.forEach(evt => {
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

            const previewEl = document.getElementById('ntuh-diag-preview'); if (previewEl) { previewEl.style.display = 'block'; previewEl.textContent = txt; }
            setDiagStatus('✓ 填入完成，尚未暫存。請確認後自行暫存或開立。', 'ok');
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

    async function triggerConsentScan() {

        try {
            const params = new URLSearchParams(window.location.search);
            const session = readQueryValue('SESSION', params);
            const chartNo = readQueryValue('ChartNo', params);
            let empNo = readQueryValue('EmpNo', params);
            let hospCode = readQueryValue('HospCode', params) || params.get('Hosp') || 'T0';
            if (!session || !chartNo) throw new Error('無法取得 SESSION 或病歷號，無法查詢同意書');
            // 診斷書若未提供操作者工號，只讀取排程頁的頁首參數，無須展開清單。
            if (!empNo) {
                const query = new URLSearchParams({ SESSION: session, ChartNo: chartNo });
                const response = await requestArrayBuffer(`${INPATIENT_ORIGIN}/WebApplication/InPatient/OPManagement/SimpleQueryOpSchedule_New.aspx?${query}`);
                const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(new Uint8Array(response.data)), 'text/html');
                empNo = readQueryValue('EmpNo', new URLSearchParams(), doc);
                hospCode = readQueryValue('HospCode', new URLSearchParams(), doc) || hospCode;
                if (!empNo) throw new Error('無法取得操作者工號，請確認住院系統已登入');
            }
            const schedules = fetchOpDataList();
            const opRows = Array.from(document.querySelectorAll('#ntuh-diag-op-rows-container .ntuh-diag-op-row'));
            const token = 'ntuh_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            const ops = opRows.map((r, index) => {
                r.dataset.scanRowKey = `${token}_${index}`;
                const opScheduleIdse = r.getAttribute('data-op-idse') || '';
                const doctor = schedules.find(item => item.opScheduleIdse === opScheduleIdse);
                return { date: r.querySelector('.ntuh-diag-op-date-input')?.value.trim() || '',
                    rowKey: r.dataset.scanRowKey, opScheduleIdse,
                    vsEmpNo: doctor?.vsEmpNo || '',
                    vsName: doctor?.vsName || '' };
            }).filter(op => op.date);
            currentScanToken = token;
            if (currentScanTimer) clearTimeout(currentScanTimer);
            // 多份 PDF 較慢，逾時隨刀數放大（每台約 30s，下限 45s、上限 180s）
            const timeoutMs = Math.min(180000, Math.max(45000, (ops.length || 1) * 30000));
            currentScanTimer = setTimeout(() => {
                if (currentScanToken !== token) return;
                currentScanToken = null; currentScanTimer = null;
                setDiagStatus('✗ 同意書背景讀取逾時。請確認住院系統已登入。', 'err');
            }, timeoutMs);

            setDiagStatus('⏳ 正在以手術流水號查詢綁定同意書…', 'warn');
            const consents = await requestConsentInfos({ Session: session, HospCode: hospCode, EmpNo: empNo, PatChartNo: chartNo });
            if (currentScanToken !== token) return;
            await readBoundConsents(consents, ops, token);
        } catch (e) {
            console.error('[DiagFiller]', diagnosticError(e));
            if (currentScanTimer) clearTimeout(currentScanTimer);
            currentScanTimer = null; currentScanToken = null;

            setDiagStatus('✗ 同意書背景讀取失敗: ' + diagnosticError(e), 'err');
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
            #ntuh-diag-run { flex: 1; padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; background: #6a3cac; color: #fff; flex-shrink: 0; }
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
                <div style="font-size:11px;color:#7a8aaa;">開啟面板後自動擷取病歷與同意書，確認後再填入囑言與日期。<span style="color:#f0a030;">病名將由手術同意書帶入供參考，請確認並修正；無同意書時請自行填寫。</span></div>

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

                <div style="display:flex;align-items:center;gap:6px;"><label><input type="checkbox" id="ntuh-diag-has-fee" /> <span>自費</span></label></div>
                <div id="ntuh-diag-fee-detail" style="display:none;flex-direction:column;gap:6px;">
                    <div id="ntuh-diag-fee-presets" style="display:flex;flex-wrap:wrap;align-items:center;"></div>
                    <div id="ntuh-diag-fee-rows-container" style="display:flex;flex-direction:column;gap:6px;"></div>
                    <button id="ntuh-diag-add-fee-btn" type="button" style="padding:4px; border:1px dashed #9a7cdc; border-radius:6px; background:transparent; color:#9a7cdc; cursor:pointer; font-size:11px; margin-top:4px;">➕ 新增自費</button>
                </div>

                <div style="border-top:1px dashed #2d3650; padding-top:6px; margin-top:2px;">
                    <div id="ntuh-diag-instr-presets" style="display:flex;flex-wrap:wrap;align-items:center;"></div>
                </div>
            </div>
            <div id="ntuh-diag-footer">
                <div style="display:flex;gap:6px;align-items:stretch;">
                    <select id="ntuh-diag-calendar" aria-label="囑言日期年制" style="background:#0f1420;color:#c8d3e8;border:1px solid #5a6a8a;border-radius:6px;padding:0 6px;font-size:12px;">
                        <option value="gregorian" selected>西元</option>
                        <option value="roc">民國</option>
                    </select>
                    <button id="ntuh-diag-run" type="button">✨ 自動填入囑言</button>
                </div>
                <div id="ntuh-diag-status"></div>
                <div id="ntuh-diag-consent-result-box" style="display:none;"></div>

                <div id="ntuh-diag-preview"></div>
            </div>
        `;

        document.body.appendChild(panel);
        document.getElementById('ntuh-diag-calendar').value = 'gregorian';
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

        document.getElementById('ntuh-diag-has-fee').addEventListener('change', function() {
            const detailEl = document.getElementById('ntuh-diag-fee-detail');
            if (this.checked) {
                detailEl.style.display = 'flex';
                renderFeePresets();
                const container = document.getElementById('ntuh-diag-fee-rows-container');
                if (container && container.children.length === 0) addFeeRow(todayStr(), '');
            } else {
                detailEl.style.display = 'none';
            }
        });

        document.getElementById('ntuh-diag-add-fee-btn').addEventListener('click', function() {
            addFeeRow(todayStr(), '');
        });

        let detectionStarted = false;
        fab.onclick = async () => {
            fab.style.display = 'none';
            panel.style.display = 'flex';
            if (detectionStarted) return;
            detectionStarted = true;
            if (await autoDetectRecords() === false) detectionStarted = false;
        };
        document.getElementById('ntuh-diag-close').onclick = () => { panel.style.display = 'none'; fab.style.display = 'flex'; };
        makeDraggable(panel, document.getElementById('ntuh-diag-header'));
        document.getElementById('ntuh-diag-run').onclick = () => runDiagFiller();

        // 常用字串（永遠可見）
        renderInstrPresets();

        setDiagStatus('開啟面板後將自動讀取病歷。', 'warn');
    }

    async function autoDetectRecords() {
        const runBtn = document.getElementById('ntuh-diag-run');
        runBtn.disabled = true;
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

            // 2. 手術：限定本次住院起日至實際離院日（尚住院則至今日）；無住院則帶最新一筆
            setDiagStatus('自動偵測病歷中：展開手術資料…', 'warn');
            await expandOne('NTUHWeb1_btnOpScheduleShowHide', '#NTUHWeb1_dgOpScheduleData tr.tableText, #NTUHWeb1_lblOpScheduleMsg');
            const opList = fetchOpDataList();
            const container = document.getElementById('ntuh-diag-op-rows-container');
            if (container) container.innerHTML = '';

            let autoOps = [];
            if (inpat.inpatStartDate) {
                const startObj = parseDate(inpat.inpatStartDate);
                const lastStay = inpat.timeline[inpat.timeline.length - 1];
                const endObj = parseDate(lastStay?.end) || new Date();
                endObj.setHours(23, 59, 59, 999);
                autoOps = opList.filter(o => {
                    const d = parseDate(o.opDate);
                    return d && startObj && d >= startObj && d <= endObj;
                }).sort((a, b) => parseDate(a.opDate) - parseDate(b.opDate)); // 由舊到新
            } else if (opList.length > 0) {
                autoOps = [opList[0]];
            }

            detectedOpList = autoOps;
            if (autoOps.length > 0) {
                document.getElementById('ntuh-diag-has-op').checked = true;
                document.getElementById('ntuh-diag-op-detail').style.display = 'flex';
                autoOps.forEach(o => addOpRow(o.opDate, o.opName, o.opScheduleIdse));
            } else {
                document.getElementById('ntuh-diag-has-op').checked = false;
                document.getElementById('ntuh-diag-op-detail').style.display = 'none';
            }

            // 3. 急診：離部動向為住院且離部日=本次住院起日，才自動勾；
            //    有住院但急診離部日對不上（舊的、不相關急診）→ 不勾，避免把上一次住院的急診塞進本次診斷書
            setDiagStatus('自動偵測病歷中：展開急診資料…', 'warn');
            await expandOne('NTUHWeb1_btnEmgHistoryShowHide', '#NTUHWeb1_gvwEmgHistory tr.tableText, #NTUHWeb1_divEmgHistoryInfo');
            let emg = { arrivalDT: '', leaveDT: '', leaveDate: '' };
            try { emg = fetchEmgData(inpat.inpatStartDate); } catch (e) { console.warn(e.message); }
            const emgFeedsThisStay = emgFeedsStay(emg, inpat.inpatStartDate);
            const shouldCheckEmg = !!emg.arrivalDT && (!inpat.inpatStartDate || emgFeedsThisStay);
            if (shouldCheckEmg) {
                document.getElementById('ntuh-diag-has-emg').checked = true;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'flex';
                document.getElementById('ntuh-diag-emg-arrival').value = emg.arrivalDT;
                document.getElementById('ntuh-diag-emg-leave').value = emg.leaveDT;
            } else {
                document.getElementById('ntuh-diag-has-emg').checked = false;
                document.getElementById('ntuh-diag-emg-detail').style.display = 'none';
                document.getElementById('ntuh-diag-emg-arrival').value = '';
                document.getElementById('ntuh-diag-emg-leave').value = '';
            }

            // 4. 門診：需開門診的案例極少，一律預設不勾；使用者手動勾選時會自動展開並帶入日期
            document.getElementById('ntuh-diag-has-opd').checked = false;
            document.getElementById('ntuh-diag-opd-detail').style.display = 'none';

            setDiagStatus('✓ 病歷自動偵測完成！', 'ok');

            // 本次住院期間有手術 → 自動觸發同意書 PDF 讀取
            if (autoOps.length > 0) {
                await triggerConsentScan();
            }
            return true;
        } catch (e) {
            console.warn('[DiagFiller] 自動偵測病歷失敗：', e);
            setDiagStatus('⚠️ 自動偵測病歷失敗', 'warn');
            return false;
        } finally {
            runBtn.disabled = false;
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
