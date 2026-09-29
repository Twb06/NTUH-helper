// ==UserScript==
// @name         NTUH 照會系統 PACS 全序列自動打包下載器 (含檢查名稱與日期版)
// @namespace    http://tampermonkey.net/
// @version      0.3.0
// @description  使用 PACS 原生影像下載 API 一次下載全檢查影像 ZIP
// @match        https://newpacsweb1.ntuh.gov.tw/*
// @match        https://newpacsweb2.ntuh.gov.tw/*
// @match        https://hchpacsweb.hch.gov.tw/*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/pacs-downloader.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/pacs-downloader.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

// PACS API 主機會輪替；getPacsApiBase() 只信任與目前頁面**同一個機構網域**的 HTTPS 主機。
// 注意：新竹分院 PACS 在 hch.gov.tw（hchpacsweb.hch.gov.tw），不是 ntuh.gov.tw——
// HIS 那套「hch 前綴 + ntuh.gov.tw」的慣例在 PACS 不適用。

(function() {
    'use strict';

    // 測試用：'auto'、'direct'（一次原生 ZIP）、'serial'（逐張原生 ZIP）、'viewer'（Viewer/Canvas）。
    // 強制模式不會在失敗時自動改走其他途徑，方便逐一驗證備援。
    const DOWNLOAD_STRATEGY = 'auto';
    const NATIVE_DOWNLOAD_CONCURRENCY = 3;

    /* =========================================================================
       內嵌微型 ZIP 引擎 (Store 模式極速輸出)
       ========================================================================= */
    class MiniZip {
        constructor() {
            this.files = [];
            this.crcTable = this.makeCrcTable();
        }

        makeCrcTable() {
            let c;
            const table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                c = n;
                for (let k = 0; k < 8; k++) {
                    c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
                }
                table[n] = c;
            }
            return table;
        }

        crc32(buf) {
            let crc = 0 ^ (-1);
            for (let i = 0; i < buf.length; i++) {
                crc = (crc >>> 8) ^ this.crcTable[(crc ^ buf[i]) & 0xFF];
            }
            return (crc ^ (-1)) >>> 0;
        }

        addFile(filename, uint8Data) {
            this.files.push({
                name: filename,
                data: uint8Data,
                crc: this.crc32(uint8Data),
                size: uint8Data.length,
                compressionMethod: 0
            });
        }

        addCompressedFile(filename, compressedData, crc, uncompressedSize, compressionMethod) {
            this.files.push({
                name: filename,
                data: compressedData,
                crc,
                size: uncompressedSize,
                compressionMethod
            });
        }

        buildBlob() {
            const encoder = new TextEncoder();
            const parts = [];
            const centralHeaders = [];
            let offset = 0;

            for (const file of this.files) {
                const nameBytes = encoder.encode(file.name);

                const localHeader = new Uint8Array(30 + nameBytes.length);
                const lView = new DataView(localHeader.buffer);
                lView.setUint32(0, 0x04034b50, true);
                lView.setUint16(4, 10, true);
                lView.setUint16(6, 0x0800, true);
                lView.setUint16(8, file.compressionMethod, true);
                lView.setUint16(10, 0, true);
                lView.setUint16(12, 0, true);
                lView.setUint32(14, file.crc, true);
                lView.setUint32(18, file.data.length, true);
                lView.setUint32(22, file.size, true);
                lView.setUint16(26, nameBytes.length, true);
                lView.setUint16(28, 0, true);
                localHeader.set(nameBytes, 30);

                parts.push(localHeader);
                parts.push(file.data);

                const cHeader = new Uint8Array(46 + nameBytes.length);
                const cView = new DataView(cHeader.buffer);
                cView.setUint32(0, 0x02014b50, true);
                cView.setUint16(4, 20, true);
                cView.setUint16(6, 10, true);
                cView.setUint16(8, 0x0800, true);
                cView.setUint16(10, file.compressionMethod, true);
                cView.setUint16(12, 0, true);
                cView.setUint16(14, 0, true);
                cView.setUint32(16, file.crc, true);
                cView.setUint32(20, file.data.length, true);
                cView.setUint32(24, file.size, true);
                cView.setUint16(28, nameBytes.length, true);
                cView.setUint16(30, 0, true);
                cView.setUint16(32, 0, true);
                cView.setUint16(34, 0, true);
                cView.setUint16(36, 0, true);
                cView.setUint32(38, 0, true);
                cView.setUint32(42, offset, true);
                cHeader.set(nameBytes, 46);

                centralHeaders.push(cHeader);
                offset += localHeader.length + file.data.length;
            }

            const centralDirStart = offset;
            let centralDirSize = 0;
            for (const ch of centralHeaders) {
                parts.push(ch);
                centralDirSize += ch.length;
            }

            const eocd = new Uint8Array(22);
            const eView = new DataView(eocd.buffer);
            eView.setUint32(0, 0x06054b50, true);
            eView.setUint16(4, 0, true);
            eView.setUint16(6, 0, true);
            eView.setUint16(8, this.files.length, true);
            eView.setUint16(10, this.files.length, true);
            eView.setUint32(12, centralDirSize, true);
            eView.setUint32(16, centralDirStart, true);
            eView.setUint16(20, 0, true);
            parts.push(eocd);

            return new Blob(parts, { type: 'application/zip' });
        }
    }

    function dataUrlToUint8Array(dataUrl) {
        const base64 = dataUrl.split(',')[1];
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function isUsableJwt(value) {
        if (typeof value !== 'string' || value.split('.').length !== 3) return false;

        try {
            const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return !payload.exp || payload.exp > Math.floor(Date.now() / 1000);
        } catch (_) {
            return false;
        }
    }

    function findTokenInStorage(storage) {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key || !/(^|[_-])(auth|authentication|token)([_-]|$)/i.test(key)) continue;

            const value = storage.getItem(key);
            if (isUsableJwt(value)) return value;

            try {
                const storedObject = JSON.parse(value);
                const token = storedObject.token || storedObject.Token || storedObject.authentication;
                if (isUsableJwt(token)) return token;
            } catch (_) {
                // Storage 值不是 JSON 時不需要處理。
            }
        }
        return '';
    }

    function getAuthenticationToken(vm) {
        const state = vm && vm.$store ? vm.$store.state : null;
        const candidates = [
            state && state.token,
            state && state.Token,
            state && state.auth && state.auth.token,
            state && state.user && state.user.token,
            state && state.login && state.login.token
        ];

        const token = candidates.find(isUsableJwt);
        if (token) return token;

        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        return findTokenInStorage(pageWindow.sessionStorage) ||
            findTokenInStorage(pageWindow.localStorage) ||
            findTokenInStorage(sessionStorage) ||
            findTokenInStorage(localStorage);
    }

    // 院區判定。總院 PACS：newpacsweb{n}.ntuh.gov.tw；新竹：hchpacsweb.hch.gov.tw。
    // 新竹用的是 hch.gov.tw 這個**不同的機構網域**，不是 ntuh 的子網域。
    const PACS_HOST_NTUH = /^newpacsweb\d+\.ntuh\.gov\.tw$/i;
    const PACS_HOST_HCH = /^hchpacsweb\.hch\.gov\.tw$/i;
    const isPacsHost = (h) => PACS_HOST_NTUH.test(h) || PACS_HOST_HCH.test(h);
    const siteDomain = () => (/\.hch\.gov\.tw$/i.test(location.hostname) ? 'hch.gov.tw' : 'ntuh.gov.tw');

    function getPacsApiBase() {
        // Tampermonkey 有隔離沙箱；PACS 的 config 存在於頁面本身的 window。
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const configuredApi = pageWindow.config && pageWindow.config.api;
        const domain = siteDomain();
        try {
            const url = new URL(configuredApi);
            // 總院維持原本刻意設的白名單（MWEB/SWEB 樣式），不放寬。
            // 新竹的 API 主機命名未知，只能退一步要求「與頁面同機構網域」——
            // 原本那串 ntuh 專用樣式會把新竹的 config 擋下，然後靜默退回總院端點。
            const ok = domain === 'ntuh.gov.tw'
                ? /^(?:sweb\d+-\d+|mweb\d+-\d+)\.ntuh\.gov\.tw$/i.test(url.hostname)
                : /(^|\.)hch\.gov\.tw$/i.test(url.hostname);
            if (url.protocol === 'https:' && ok) {
                return url.href.replace(/\/$/, '');
            }
        } catch (_) {
            // 舊版 PACS 未提供或提供無效 config。
        }
        // 相容端點只有總院有已知的一個。新竹拿不到 config 就明確失敗，
        // **不要靜默打到總院去**——那會接到別院的資料或直接失敗，而且看起來像「有在動」。
        if (domain === 'ntuh.gov.tw') return 'https://mweb05-20015.ntuh.gov.tw/html5server';
        throw new Error('PACS 未提供有效的 config.api，且本院區沒有已知的相容端點');
    }

    async function extractFirstZipFile(blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const view = new DataView(bytes.buffer);

        if (view.getUint32(0, true) !== 0x04034b50) {
            throw new Error('PACS API 回傳的不是 ZIP');
        }

        const compressionMethod = view.getUint16(8, true);
        let compressedSize = view.getUint32(18, true);
        const fileNameLength = view.getUint16(26, true);
        const extraLength = view.getUint16(28, true);
        const dataStart = 30 + fileNameLength + extraLength;
        let centralDirOffset = -1;
        let zip64UncompressedSize = null;

        // PACS 使用 ZIP64 extra field 填入實際大小，Local Header 的 32 位大小欄位為 0xFFFFFFFF。
        for (let offset = 30 + fileNameLength; offset + 4 <= dataStart;) {
            const headerId = view.getUint16(offset, true);
            const fieldSize = view.getUint16(offset + 2, true);
            const fieldDataStart = offset + 4;
            if (fieldDataStart + fieldSize > dataStart) break;

            if (headerId === 0x0001 && fieldSize >= 16) {
                zip64UncompressedSize = view.getUint32(fieldDataStart, true);
                if (compressedSize === 0xffffffff) {
                    compressedSize = view.getUint32(fieldDataStart + 8, true);
                }
                break;
            }
            offset = fieldDataStart + fieldSize;
        }

        // 從 ZIP 尾端尋找合法 Central Directory Header，取得 data descriptor 未提供的資訊。
        for (let i = bytes.length - 46; i >= dataStart; i--) {
            if (view.getUint32(i, true) !== 0x02014b50) continue;

            const centralNameLength = view.getUint16(i + 28, true);
            const centralExtraLength = view.getUint16(i + 30, true);
            const centralCommentLength = view.getUint16(i + 32, true);
            const centralEnd = i + 46 + centralNameLength + centralExtraLength + centralCommentLength;
            if (centralEnd > bytes.length) continue;

            centralDirOffset = i;
            if (compressedSize === 0xffffffff) compressedSize = view.getUint32(i + 20, true);
            break;
        }

        if (centralDirOffset === -1 || !Number.isFinite(compressedSize) || compressedSize < 0 || dataStart + compressedSize > bytes.length) {
            throw new Error('無法解析 PACS ZIP 的影像大小');
        }

        const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
        const crc = view.getUint32(centralDirOffset + 16, true);
        let uncompressedSize = view.getUint32(centralDirOffset + 24, true);
        if (uncompressedSize === 0xffffffff && zip64UncompressedSize !== null) {
            uncompressedSize = zip64UncompressedSize;
        }

        if (!Number.isFinite(uncompressedSize) || uncompressedSize < 0 ||
            (compressionMethod !== 0 && compressionMethod !== 8)) {
            throw new Error('不支援 PACS ZIP 的壓縮格式');
        }

        return { compressedData, crc, uncompressedSize, compressionMethod };
    }

    function getActiveImageInfo(vm) {
        const dcmObject = vm && (vm.DcmObject || vm);
        const activeImage = dcmObject && dcmObject.ActiveImage;
        if (!activeImage || !activeImage.InstanceUid) return null;

        const windowLevel = activeImage.StateManagement && activeImage.StateManagement.windowLevel;
        return {
            instanceUid: activeImage.InstanceUid,
            frameNumber: Number.isFinite(Number(activeImage.FrameNo)) ? Number(activeImage.FrameNo) : 0,
            windowCenter: windowLevel && Number.isFinite(Number(windowLevel.wc)) ? Number(windowLevel.wc) : 0,
            windowWidth: windowLevel && Number.isFinite(Number(windowLevel.ww)) ? Number(windowLevel.ww) : 0
        };
    }

    function getImageKey(imageInfo) {
        return imageInfo ? `${imageInfo.instanceUid}:${imageInfo.frameNumber}` : '';
    }

    function getCurrentActiveImageInfo(fallbackVm) {
        // dcm 元件本身的 ActiveImage 會隨右上角導航更新；其父層的 viewport 快取可能延遲。
        const fallbackImage = getActiveImageInfo(fallbackVm);
        if (fallbackImage) return fallbackImage;

        const context = typeof findViewerContext === 'function' && findViewerContext();
        const activeViewport = context && context.viewer && context.viewer.activeViewport;
        const viewports = context && context.viewer && context.viewer.viewports;
        const seriesData = activeViewport && viewports && viewports.viewport &&
            viewports.viewport[activeViewport.rowIndex] &&
            viewports.viewport[activeViewport.rowIndex][activeViewport.colIndex] &&
            viewports.viewport[activeViewport.rowIndex][activeViewport.colIndex].seriesData;
        return getActiveImageInfo(seriesData && seriesData.RefInstance && seriesData.RefInstance.DcmObject || fallbackVm);
    }

    function getCurrentSeriesKey() {
        const context = typeof findViewerContext === 'function' && findViewerContext();
        const activeViewport = context && context.viewer && context.viewer.activeViewport;
        const viewports = context && context.viewer && context.viewer.viewports;
        const seriesData = activeViewport && viewports && viewports.viewport &&
            viewports.viewport[activeViewport.rowIndex] &&
            viewports.viewport[activeViewport.rowIndex][activeViewport.colIndex] &&
            viewports.viewport[activeViewport.rowIndex][activeViewport.colIndex].seriesData;
        return seriesData && (seriesData.series_uid || seriesData.series_uid_id || seriesData.instanceuid) || '';
    }

    async function waitForNewSeries(previousKey, timeout = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const currentKey = getCurrentSeriesKey();
            if (currentKey && currentKey !== previousKey) return currentKey;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('PACS 序列計數已變更，但 active viewport 未載入下一個序列');
    }

    function getFrameNavigationButtons() {
        const toolbar = document.querySelector('header.appbar [studyuid], header.appbar');
        if (!toolbar) return { prevBtn: null, nextBtn: null };

        const buttons = Array.from(toolbar.querySelectorAll('button'));
        return {
            prevBtn: buttons.find(button => button.querySelector('.mdi-chevron-left')) || null,
            nextBtn: buttons.find(button => button.querySelector('.mdi-chevron-right')) || null
        };
    }

    function getSeriesPosition() {
        const navigation = document.querySelector('[studyuid]');
        const match = navigation && navigation.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        return match ? { current: Number(match[1]), total: Number(match[2]) } : null;
    }

    async function waitForSeriesPosition(previousPosition, timeout = 8000) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const position = getSeriesPosition();
            if (position && (!previousPosition || position.current !== previousPosition.current)) return position;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('PACS 未在預期時間內切換至下一個序列');
    }

    async function waitForNewImage(vm, previousKey, timeout = 1500) {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const imageInfo = getCurrentActiveImageInfo(vm);
            if (imageInfo && getImageKey(imageInfo) !== previousKey) return imageInfo;
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error('PACS 未在預期時間內切換至下一張影像');
    }

    async function requestNativeJpg(body, vm) {
        const token = getAuthenticationToken(vm);
        if (!token) throw new Error('找不到 PACS 登入認證');

        const apiUrl = `${getPacsApiBase()}/api/dicom/GetDicomJPG`;
        const requestBody = JSON.stringify(body);

        if (typeof GM_xmlhttpRequest === 'function') {
            const responseBlob = await new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: apiUrl,
                    timeout: 30000,
                    headers: {
                        'Content-Type': 'application/json',
                        'authentication': token
                    },
                    data: requestBody,
                    responseType: 'arraybuffer',
                    onload: response => {
                        if (response.status < 200 || response.status >= 300) {
                            reject(new Error(`PACS API HTTP ${response.status}`));
                            return;
                        }
                        resolve(new Blob([response.response], { type: 'application/zip' }));
                    },
                    onerror: () => reject(new Error('PACS API 跨來源請求失敗')),
                    ontimeout: () => reject(new Error('PACS API 請求逾時（30 秒）')),
                    onabort: () => reject(new Error('PACS API 請求被中止'))
                });
            });

            return responseBlob;
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'authentication': token
            },
            credentials: 'omit',
            body: requestBody
        });

        if (!response.ok) throw new Error(`PACS API HTTP ${response.status}`);
        return response.blob();
    }

    async function downloadNativeJpg(imageInfo, vm) {
        const responseBlob = await requestNativeJpg({
            InstanceUid: [imageInfo.instanceUid],
            FrameNumber: [imageInfo.frameNumber],
            windowCenter: imageInfo.windowCenter,
            windowWidth: imageInfo.windowWidth
        }, vm);
        return extractFirstZipFile(responseBlob);
    }

    async function mapWithConcurrency(items, worker, concurrency = NATIVE_DOWNLOAD_CONCURRENCY) {
        const results = new Array(items.length);
        let nextIndex = 0;
        const workerCount = Math.min(Math.max(1, concurrency), items.length);

        await Promise.all(Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index], index);
            }
        }));
        return results;
    }

    /* =========================================================================
       核心：GPU 繪圖攔截器
       ========================================================================= */
    let drawWaiters = [];

    function attachDrawHook(canvas) {
        if (!canvas || canvas._hasDrawHook) return;
        canvas._hasDrawHook = true;

        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl') || canvas.getContext('2d');
        if (!gl) return;

        function notifyDraw() {
            if (drawWaiters.length > 0) {
                const waiters = drawWaiters;
                drawWaiters = [];
                waiters.forEach(fn => fn());
            }
        }

        if (gl.drawArrays) {
            const origDrawArrays = gl.drawArrays;
            gl.drawArrays = function(...args) {
                const res = origDrawArrays.apply(this, args);
                notifyDraw();
                return res;
            };
        }
        if (gl.drawElements) {
            const origDrawElements = gl.drawElements;
            gl.drawElements = function(...args) {
                const res = origDrawElements.apply(this, args);
                notifyDraw();
                return res;
            };
        }
        if (gl.drawImage) {
            const origDrawImage = gl.drawImage;
            gl.drawImage = function(...args) {
                const res = origDrawImage.apply(this, args);
                notifyDraw();
                return res;
            };
        }
    }

    function waitForNextDraw(timeout = 3000) {
        return new Promise((resolve) => {
            let timer;
            const cb = () => {
                clearTimeout(timer);
                resolve(true);
            };
            drawWaiters.push(cb);
            timer = setTimeout(() => {
                const idx = drawWaiters.indexOf(cb);
                if (idx !== -1) drawWaiters.splice(idx, 1);
                resolve(false);
            }, timeout);
        });
    }

    /* =========================================================================
       輔助函式：解析並組合【病歷資料_檢查名稱_日期】檔名前綴
       ========================================================================= */
    function getCleanPrefix() {
        function cleanFilenamePart(value, fallback = '') {
            return String(value || fallback)
                .replace(/[\x00-\x1f\x7f\\/:*?"<>|]+/g, '_')
                .replace(/\s+/g, '_')
                .replace(/^[_\.]+|[_\.]+$/g, '');
        }

        // 1. 病患資料 (病歷號 + 姓名)
        const titleEl = document.querySelector('header.appbar strong.title, .v-toolbar__content .title');
        let patientInfo = cleanFilenamePart(titleEl ? titleEl.innerText.trim() : '', 'PACS');

        // 2. 檢查名稱 (如 Confocal)
        const examNameEl = document.querySelector('.v-select__selections span.font-weight-bold');
        let examName = cleanFilenamePart(examNameEl ? examNameEl.innerText.trim() : '');

        // 3. 檢查日期 (尋找 YYYY/MM/DD 並轉為 YYYYMMDD)
        let dateStr = '';
        const selectionsEl = document.querySelector('.v-select__selections');
        if (selectionsEl) {
            const match = selectionsEl.innerText.match(/(\d{4})[/-](\d{2})[/-](\d{2})/);
            if (match) {
                dateStr = `${match[1]}${match[2]}${match[3]}`; // 例如 20260909
            }
        }

        // 4. 依序串接組成前綴
        const parts = [patientInfo];
        if (examName) parts.push(examName);
        if (dateStr) parts.push(dateStr);

        return parts.join('_');
    }

    /* =========================================================================
       模組：PACS 影像檢視器
       ========================================================================= */
    if (isPacsHost(location.hostname)) {

        function createUI() {
            if (document.getElementById('ntuh-pacs-fab')) return;

            const style = document.createElement('style');
            style.textContent = `
                #ntuh-pacs-fab {
                    position: fixed !important;
                    bottom: 24px !important;
                    right: 24px !important;
                    width: 48px !important;
                    height: 48px !important;
                    min-width: 48px !important;
                    min-height: 48px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    border-radius: 50% !important;
                    background: #1e3a2f !important;
                    border: 2px solid #3fb950 !important;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.4) !important;
                    color: #ffffff !important;
                    z-index: 2147483647 !important;
                    cursor: pointer !important;
                    display: flex !important;
                    visibility: visible !important;
                    opacity: 1 !important;
                    align-items: center !important;
                    justify-content: center !important;
                    font-size: 20px !important;
                    line-height: 1 !important;
                    transition: transform 0.15s, box-shadow 0.15s;
                    user-select: none;
                }
                #ntuh-pacs-fab:hover {
                    transform: scale(1.1) !important;
                    box-shadow: 0 6px 20px rgba(0,0,0,0.5) !important;
                }
                #ntuh-pacs-badge {
                    position: absolute !important;
                    right: 56px !important;
                    background: #1a1f2e !important;
                    border: 1px solid #2d3650 !important;
                    color: #c8d3e8 !important;
                    font-family: 'Consolas','Courier New',monospace !important;
                    font-size: 11px !important;
                    padding: 4px 10px !important;
                    border-radius: 6px !important;
                    white-space: nowrap !important;
                    pointer-events: none !important;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
                    display: none;
                }
            `;
            document.head.appendChild(style);

            const fab = document.createElement('button');
            fab.type = 'button';
            fab.id = 'ntuh-pacs-fab';
            fab.title = '點擊打包全序列影像 (ZIP)';
            fab.setAttribute('aria-label', fab.title);

            const icon = document.createElement('span');
            icon.id = 'ntuh-pacs-icon';
            icon.textContent = '📦';
            fab.appendChild(icon);

            const badge = document.createElement('div');
            badge.id = 'ntuh-pacs-badge';
            fab.appendChild(badge);
            document.body.appendChild(fab);

            fab.onclick = () => runMasterZipExport();
        }

        function updateFabStatus(text, isBusy = true) {
            const fab = document.getElementById('ntuh-pacs-fab');
            const badge = document.getElementById('ntuh-pacs-badge');
            if (!fab || !badge) return;

            badge.style.display = 'block';
            badge.textContent = text;

            if (isBusy) {
                const icon = document.getElementById('ntuh-pacs-icon');
                if (icon) icon.textContent = '⏳';
                fab.style.pointerEvents = 'none';
            } else {
                const icon = document.getElementById('ntuh-pacs-icon');
                if (icon) icon.textContent = '📦';
                fab.style.pointerEvents = 'auto';
                setTimeout(() => { badge.style.display = 'none'; }, 3500);
            }
        }

        function waitForVueReady() {
            return new Promise((resolve) => {
                const timer = setInterval(() => {
                    const dcmEl = document.querySelector('div[refs="dcm"]');
                    if (dcmEl && dcmEl.querySelector('canvas')) {
                        clearInterval(timer);
                        attachDrawHook(dcmEl.querySelector('canvas'));
                        resolve(dcmEl);
                    }
                }, 300);
            });
        }

        function waitForViewerCanvas(timeout = 8000) {
            return new Promise((resolve, reject) => {
                const start = Date.now();
                const timer = setInterval(() => {
                    const dcmEl = document.querySelector('div[refs="dcm"]');
                    const canvas = dcmEl ? dcmEl.querySelector('canvas') : document.querySelector('canvas.image-canvas');
                    if (canvas && canvas.width > 0 && canvas.height > 0) {
                        clearInterval(timer);
                        resolve({ dcmEl, canvas });
                    } else if (Date.now() - start >= timeout) {
                        clearInterval(timer);
                        reject(new Error('PACS 切換後未建立可用的影像畫布'));
                    }
                }, 50);
            });
        }

        function findViewerContext() {
            const dcmEl = document.querySelector('div[refs="dcm"]');
            let vm = dcmEl && dcmEl.__vue__;
            const visited = new Set();

            while (vm && !visited.has(vm)) {
                visited.add(vm);
                const viewer = vm.viewer && vm.viewer.viewports ? vm.viewer : (vm.viewports ? vm : null);
                const referenceList = vm.referenceList || (vm.$store && vm.$store.state && vm.$store.state.referenceList);
                if (viewer && referenceList && Array.isArray(referenceList.studies)) {
                    return { vm, viewer, referenceList };
                }
                vm = vm.$parent;
            }
            return null;
        }

        function activateSeriesByIndex(seriesIndex) {
            // 由 DOM click 觸發 PACS 原本的 Vue click handler，避免跨沙箱呼叫私有方法失效。
            const seriesItems = document.querySelectorAll('aside.v-navigation-drawer .v-list-item');
            const item = seriesItems[seriesIndex];
            if (!item) throw new Error(`找不到第 ${seriesIndex + 1} 個 PACS 序列`);
            item.click();
        }

        async function waitForSeriesLoad(previousImageKey, expectedPosition, timeout = 8000) {
            const start = Date.now();
            while (Date.now() - start < timeout) {
                const imageInfo = getCurrentActiveImageInfo(null);
                const position = getSeriesPosition();
                const positionMatches = position && position.current === expectedPosition;
                if (imageInfo && (!previousImageKey || getImageKey(imageInfo) !== previousImageKey || positionMatches)) {
                    return imageInfo;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error(`PACS 未載入第 ${expectedPosition} 個序列`);
        }

        async function getNativeFrameCount(instanceUid, vm) {
            const token = getAuthenticationToken(vm);
            if (!token) throw new Error('找不到 PACS 登入認證');

            const params = new URLSearchParams({ instanceuid: instanceUid, frameno: '0', pieceid: '-1' });
            const apiUrl = `${getPacsApiBase()}/api/dicom/GetDicomPieces?${params}`;

            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: apiUrl,
                        timeout: 30000,
                        headers: { 'authentication': token },
                        responseType: 'arraybuffer',
                        onload: response => {
                            if (response.status < 200 || response.status >= 300) {
                                reject(new Error(`PACS 影像資訊 API HTTP ${response.status}`));
                                return;
                            }
                            const match = /(?:^|\r?\n)framecount:\s*(\d+)/i.exec(response.responseHeaders || '');
                            const frameCount = match ? Number(match[1]) : NaN;
                            if (!Number.isInteger(frameCount) || frameCount < 1) {
                                reject(new Error('PACS 影像資訊未包含有效的 framecount'));
                                return;
                            }
                            resolve(frameCount);
                        },
                        onerror: () => reject(new Error('PACS 影像資訊跨來源請求失敗')),
                        ontimeout: () => reject(new Error('PACS 影像資訊請求逾時（30 秒）'))
                    });
                });
            }

            const response = await fetch(apiUrl, {
                method: 'GET',
                headers: { 'authentication': token },
                credentials: 'omit'
            });
            if (!response.ok) throw new Error(`PACS 影像資訊 API HTTP ${response.status}`);
            const frameCount = Number(response.headers.get('framecount'));
            if (!Number.isInteger(frameCount) || frameCount < 1) {
                throw new Error('PACS 影像資訊未包含有效的 framecount');
            }
            return frameCount;
        }

        async function getSeriesImageInfos(series, vm) {
            if (!series || !series.RefInstance) return null;

            const instances = series.RefInstance.instance;
            // 部分 Web2 序列的 instanceuid 只是第一張代表影像；完整單幀清單在 RefInstance.instance。
            if (Array.isArray(instances) && instances.length > 1) {
                const images = [];
                for (const instance of instances) {
                    const instanceUid = typeof instance === 'string' ? instance : instance && instance.instanceuid;
                    if (!instanceUid) return null;
                    images.push({ instanceUid, frameNumber: 0, windowCenter: 0, windowWidth: 0 });
                }
                return images;
            }

            if (series.instanceuid) {
                const frameCount = await getNativeFrameCount(series.instanceuid, vm);
                return Array.from({ length: frameCount }, (_, frameNumber) => ({
                    instanceUid: series.instanceuid,
                    frameNumber,
                    windowCenter: 0,
                    windowWidth: 0
                }));
            }

            if (Array.isArray(instances) && instances.length > 0) {
                const images = [];
                for (const instance of instances) {
                    const instanceUid = typeof instance === 'string' ? instance : instance && instance.instanceuid;
                    if (!instanceUid) return null;
                    images.push({ instanceUid, frameNumber: 0, windowCenter: 0, windowWidth: 0 });
                }
                return images;
            }
            return null;
        }

        async function buildAllStudyImageRequest() {
            const context = findViewerContext();
            if (!context) return null;

            const { viewer, referenceList } = context;
            const study = referenceList.studies.find(item => item.study_uid === viewer.activeStudyUid);
            if (!study || !Array.isArray(study.seriesUids)) return null;

            const instanceUids = [];
            const frameNumbers = [];
            for (const series of study.seriesUids) {
                const images = await getSeriesImageInfos(series, context.vm);
                if (!images) return null;
                for (const image of images) {
                    instanceUids.push(image.instanceUid);
                    frameNumbers.push(image.frameNumber);
                }
            }

            if (instanceUids.length === 0) return null;
            return { vm: context.vm, InstanceUid: instanceUids, FrameNumber: frameNumbers };
        }

        async function tryDirectAllStudyDownload(prefix) {
            const request = await buildAllStudyImageRequest();
            if (!request) return false;

            console.info('[PACS-Master] 全檢查原生下載請求摘要', {
                apiBase: getPacsApiBase(),
                imageCount: request.InstanceUid.length,
                uniqueInstanceCount: new Set(request.InstanceUid).size,
                firstFrameNumber: request.FrameNumber[0],
                lastFrameNumber: request.FrameNumber[request.FrameNumber.length - 1]
            });
            updateFabStatus(`⚡ 原生 ZIP 下載中（${request.InstanceUid.length} 張）...`);
            const zipBlob = await requestNativeJpg({
                InstanceUid: request.InstanceUid,
                FrameNumber: request.FrameNumber
            }, request.vm);

            const downloadUrl = URL.createObjectURL(zipBlob);
            const anchor = document.createElement('a');
            anchor.href = downloadUrl;
            anchor.download = `${prefix}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
            return true;
        }

        async function trySerialNativeStudyDownload(prefix) {
            const context = findViewerContext();
            if (!context) return false;

            const { viewer, referenceList } = context;
            const study = referenceList.studies.find(item => item.study_uid === viewer.activeStudyUid);
            if (!study || !Array.isArray(study.seriesUids) || study.seriesUids.length === 0) return false;

            const zip = new MiniZip();
            for (let seriesIndex = 0; seriesIndex < study.seriesUids.length; seriesIndex++) {
                const series = study.seriesUids[seriesIndex];
                const images = await getSeriesImageInfos(series, context.vm);
                if (!images) return false;

                updateFabStatus(`📸 原生備援 S${seriesIndex + 1}/${study.seriesUids.length}（${images.length} 張）...`);
                const jpgs = await mapWithConcurrency(images, image => downloadNativeJpg(image, context.vm));
                for (let imageIndex = 0; imageIndex < images.length; imageIndex++) {
                    const jpg = jpgs[imageIndex];
                    const fileName = `${prefix}_S${String(seriesIndex + 1).padStart(2, '0')}_${String(imageIndex + 1).padStart(2, '0')}.jpg`;
                    zip.addCompressedFile(fileName, jpg.compressedData, jpg.crc, jpg.uncompressedSize, jpg.compressionMethod);
                }
            }

            const downloadUrl = URL.createObjectURL(zip.buildBlob());
            const anchor = document.createElement('a');
            anchor.href = downloadUrl;
            anchor.download = `${prefix}.zip`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(downloadUrl), 60000);
            return true;
        }

        async function runMasterZipExport() {
            try {
                // 1. 取得乾淨前綴 (病歷資料_檢查名稱_日期)
                const prefix = getCleanPrefix();

                if (DOWNLOAD_STRATEGY === 'auto' || DOWNLOAD_STRATEGY === 'direct') {
                    // Web 2 的官方 AllStudy 流程會把所有 UID 與影格編號交給一次 API 請求。
                    // 這避免切換 Viewer 影像所造成的漏圖、重複、順序錯誤及不必要等待。
                    try {
                        if (await tryDirectAllStudyDownload(prefix)) {
                            updateFabStatus('✅ 原生 ZIP 已開始下載！', false);
                            return;
                        }
                        if (DOWNLOAD_STRATEGY === 'direct') throw new Error('無法建立全檢查原生下載請求');
                    } catch (error) {
                        if (DOWNLOAD_STRATEGY === 'direct') throw error;
                        console.warn('[PACS-Master] 無法使用全檢查原生下載，改用逐張備援:', error);
                    }
                }

                if (DOWNLOAD_STRATEGY === 'auto' || DOWNLOAD_STRATEGY === 'serial') {
                    // 逐張原生備援只讀取 study metadata，不控制畫面上的 active viewport。
                    // 因此不會受 Web2 的序列計數器與 viewport 非同步影響。
                    try {
                        if (await trySerialNativeStudyDownload(prefix)) {
                            updateFabStatus('✅ 原生逐張 ZIP 已開始下載！', false);
                            return;
                        }
                        if (DOWNLOAD_STRATEGY === 'serial') throw new Error('無法建立逐張原生下載請求');
                    } catch (error) {
                        if (DOWNLOAD_STRATEGY === 'serial') throw error;
                        console.warn('[PACS-Master] 無法使用逐張原生下載，改用 Viewer/Canvas 備援:', error);
                    }
                }

                if (DOWNLOAD_STRATEGY !== 'auto' && DOWNLOAD_STRATEGY !== 'viewer') {
                    throw new Error(`不支援的下載模式：${DOWNLOAD_STRATEGY}`);
                }

                const { prevBtn } = getFrameNavigationButtons();
                const seriesList = document.querySelectorAll('aside.v-navigation-drawer .v-list-item');
                const totalSeries = seriesList.length > 0 ? seriesList.length : 1;

                console.log(`[PACS-Master] 開始打包【${prefix}】，共 ${totalSeries} 個序列`);

                // 右上角序列導航是此 Viewer 唯一已確認會切換目前 DICOM 元件的控制項。
                if (prevBtn) {
                    for (let i = 0; i < totalSeries + 1; i++) {
                        prevBtn.click();
                        await new Promise(resolve => setTimeout(resolve, 30));
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 300));

                const zip = new MiniZip();

                // 3. 外層迴圈：遍歷序列
                for (let s = 0; s < totalSeries; s++) {
                    updateFabStatus(`📂 序列 (${s + 1}/${totalSeries})...`);

                    const { dcmEl, canvas } = await waitForViewerCanvas();
                    const vm = dcmEl ? dcmEl.__vue__ : null;

                    attachDrawHook(canvas);

                    let sliceCount = dcmEl ? parseInt(dcmEl.getAttribute('instancecount'), 10) : 1;
                    if (!sliceCount || isNaN(sliceCount)) {
                        const totalSpan = document.querySelector('.totalCount');
                        sliceCount = totalSpan ? parseInt(totalSpan.innerText, 10) : 1;
                    }

                    // 切片歸位回第 1 張
                    if (sliceCount > 1 && vm && typeof vm.SynchPriorFrameClick === 'function') {
                        for (let r = 0; r < sliceCount; r++) {
                            vm.SynchPriorFrameClick();
                            await new Promise(r => setTimeout(r, 15));
                        }
                        await new Promise(r => setTimeout(r, 150));
                    }

                    // 內層迴圈：逐張確認影像完成後再下載，避免切換過快造成漏圖或重複圖。
                    const downloadedKeys = new Set();
                    let previousKey = '';
                    for (let f = 0; f < sliceCount; f++) {
                        updateFabStatus(`📸 S${s + 1} (${f + 1}/${sliceCount})...`);

                        if (f > 0) {
                            await waitForNextDraw(1200);
                            await new Promise(r => setTimeout(r, 20));
                        } else {
                            await new Promise(r => setTimeout(r, 100));
                        }

                        let imageInfo = f > 0
                            ? await waitForNewImage(vm, previousKey)
                            : getCurrentActiveImageInfo(vm);
                        let imageKey = getImageKey(imageInfo);

                        if (imageKey && downloadedKeys.has(imageKey)) {
                            throw new Error(`PACS 回傳重複影像，已停止以避免錯誤輸出：${imageKey}`);
                        }

                        let nativeJpg = null;
                        try {
                            if (imageInfo) {
                                nativeJpg = await downloadNativeJpg(imageInfo, vm);
                            }
                        } catch (error) {
                            console.warn('PACS 原生 JPG 下載失敗，使用 Canvas 備援:', error);
                        }

                        let imageSaved = false;
                        if (nativeJpg) {
                            const fileName = `${prefix}_S${String(s + 1).padStart(2, '0')}_${String(f + 1).padStart(2, '0')}.jpg`;
                            zip.addCompressedFile(
                                fileName,
                                nativeJpg.compressedData,
                                nativeJpg.crc,
                                nativeJpg.uncompressedSize,
                                nativeJpg.compressionMethod
                            );
                            imageSaved = true;
                        } else {
                            try {
                                const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
                                const uint8 = dataUrlToUint8Array(dataUrl);
                                const fileName = `${prefix}_S${String(s + 1).padStart(2, '0')}_${String(f + 1).padStart(2, '0')}.jpg`;
                                zip.addFile(fileName, uint8);
                                imageSaved = true;
                            } catch (fallbackError) {
                                console.error('影像擷取錯誤:', fallbackError);
                            }
                        }

                        if (imageSaved) {
                            if (imageKey) downloadedKeys.add(imageKey);
                            previousKey = imageKey;
                        }

                        if (f < sliceCount - 1 && vm && typeof vm.SynchNextFrameClick === 'function') {
                            vm.SynchNextFrameClick();
                        }
                    }

                    if (s < totalSeries - 1) {
                        const previousPosition = getSeriesPosition();
                        const { nextBtn } = getFrameNavigationButtons();
                        if (!nextBtn) throw new Error('找不到 PACS 下一個序列按鈕');
                        nextBtn.click();
                        await waitForSeriesPosition(previousPosition);
                        // Web2 跨序列時可能沿用相同 ActiveImage key，不能把它當載入完成訊號。
                        await new Promise(resolve => setTimeout(resolve, 200));
                    }
                }

                // 4. 瞬間封裝 ZIP 並下載
                updateFabStatus('⚡ 封裝 ZIP 中...');
                await new Promise(r => setTimeout(r, 80));

                const zipBlob = zip.buildBlob();
                const downloadUrl = URL.createObjectURL(zipBlob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                // 格式：病患資料_檢查名稱_日期.zip
                a.download = `${prefix}.zip`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(downloadUrl);

                updateFabStatus('✅ 打包完成！', false);

            } catch (err) {
                console.error('[PACS-Master] 執行過程發生錯誤:', err);
                updateFabStatus('❌ 發生錯誤，請看主控台', false);
            }
        }

        async function initializePacsDownloader() {
            // UI 不應依賴 Vue 的私有 __vue__ 欄位；Tampermonkey 沙箱下該欄位可能不可見。
            createUI();
            await waitForVueReady();
        }

        if (document.readyState === 'loading') {
            window.addEventListener('DOMContentLoaded', initializePacsDownloader, { once: true });
        } else {
            initializePacsDownloader();
        }
    }
})();