// ==UserScript==
// @name         NTUH Rehab Forms Extractor
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0
// @description  在 EMR 病歷檢視頁一鍵擷取復健科治療師電子表單（OT/PT/ST 評估、進展、每日紀錄）。表單存於 eformaw 的靜態 HTML，直接 GM_xmlhttpRequest 抓取＋DOMParser 解析成 key-value，不開背景分頁。強制以檔名 ChartNo 過濾非本病人資料，並剝除頁首個資（姓名/生日/地址）。v0.1.0：獨立工具，同時支援 ntuh_token worker 模式供 progress-note-filler 併入。
// @author       潘岳彤
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/PatientBasicInfoEdit/SimpleShowiframePage.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/OtherIndependentProj/PatientBasicInfoEdit/SimpleShowiframePage.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rehab-forms.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rehab-forms.user.js
// @connect      eformaw.ntuh.gov.tw
// @connect      hchihisaw.ntuh.gov.tw
// @connect      hchhisaw.ntuh.gov.tw
// @connect      ihisaw.ntuh.gov.tw
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// ==/UserScript==

/* global GM_xmlhttpRequest, GM_setValue */

(function () {
    'use strict';

    const LOG = '[RehabForms]';

    // HIS 頁的 date.js 把 Date.now 覆寫成回傳 Date 物件（非數字）。取毫秒一律走這個。
    function nowMs() { return new Date().getTime(); }

    // ═══════════════════════════════════════════════
    // 1. 表單清單：從 TreeView 的 href 解析 eform URL
    // ═══════════════════════════════════════════════
    // TreeView 節點的 href 形如
    //   javascript:__doPostBack('TreeViewItem','s\\\\https://eformaw.../XXX.html')
    // 目標 URL 直接嵌在裡面 —— 不必模擬點擊、不必等 postback。
    // 一個 href 可能含兩個 URL（清單頁+內容頁），全抓後只留 eform 的。
    const EFORM_URL_RE = /https?:\/\/[^'"\\\s]*EFormStorage[^'"\\\s]*\.html/gi;

    // 檔名：HB14397_26T42539742_01400-4-600385_20260825084459.html
    //       └ChartNo┘└AccountIDSE┘└ 文件編號 ┘└   時間戳   ┘
    const EFORM_NAME_RE = /\/([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d{4,6}-\d-\d{4,8})_(\d{14})\.html$/;

    function parseEformName(url) {
        const m = EFORM_NAME_RE.exec(url);
        if (!m) return null;
        const ts = m[4];
        return {
            url,
            chartNo: m[1],
            accountIdSe: m[2],
            docCode: m[3],
            stamp: ts,
            date: `${ts.slice(0, 4)}/${ts.slice(4, 6)}/${ts.slice(6, 8)}`,
            time: `${ts.slice(8, 10)}:${ts.slice(10, 12)}`,
        };
    }

    const DATE_TXT_RE = /^\s*\d{4}\/\d{2}\/\d{2}/;

    /**
     * 掃 TreeView 取出本頁所有 eform 表單。
     * 日期節點的文字只有 "2026/09/03"，類別名在父節點；TreeView 是深度優先渲染，
     * 所以「最近一個非日期的節點文字」就是它的類別（best effort，抓回來後會用
     * <title> 覆蓋成正式表單名）。
     */
    function collectForms(root) {
        const seen = new Set();
        const forms = [];
        let category = '';
        for (const a of root.querySelectorAll('a')) {
            const txt = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
            const href = a.getAttribute('href') || '';
            const urls = href.match(EFORM_URL_RE);
            if (!urls) {
                if (txt && !DATE_TXT_RE.test(txt)) category = txt;
                continue;
            }
            for (const u of urls) {
                if (seen.has(u)) continue;
                seen.add(u);
                const meta = parseEformName(u);
                if (!meta) { console.warn(LOG, '檔名格式不認得，略過', u); continue; }
                meta.category = category;
                meta.nodeText = txt;
                forms.push(meta);
            }
        }
        return forms;
    }

    /** 當前病人的病歷號：TreeView 的報告 URL 帶 ChartNo= */
    function currentChartNo() {
        const m = /[?&]ChartNo=([A-Za-z0-9]+)/.exec(document.documentElement.innerHTML);
        return m ? m[1] : '';
    }

    // ═══════════════════════════════════════════════
    // 2. 抓取（跨網域 → GM_xmlhttpRequest；注意編碼）
    // ═══════════════════════════════════════════════
    // eform 是舊系統產出的靜態 HTML，charset 未必是 UTF-8（big5 會整份中文亂碼）。
    // 一律拿 arraybuffer，先探 meta charset 再決定用哪個 decoder。
    function decodeHtml(buf) {
        const bytes = new Uint8Array(buf);
        const probe = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 2048));
        const m = /charset\s*=\s*["']?([\w-]+)/i.exec(probe);
        const cs = (m ? m[1] : 'utf-8').toLowerCase();
        if (cs === 'utf-8' || cs === 'utf8') {
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
        try {
            return new TextDecoder(cs, { fatal: false }).decode(bytes);
        } catch (e) {
            console.warn(LOG, '不支援的編碼，退回 utf-8', cs);
            return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        }
    }

    function fetchEform(url, timeoutMs) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'arraybuffer',
                timeout: timeoutMs || 15000,
                onload: (r) => {
                    if (r.status < 200 || r.status >= 300) return reject(new Error('HTTP ' + r.status));
                    try { resolve(decodeHtml(r.response)); } catch (e) { reject(e); }
                },
                onerror: () => reject(new Error('網路錯誤')),
                ontimeout: () => reject(new Error('逾時')),
            });
        });
    }

    // ═══════════════════════════════════════════════
    // 3. 解析（版面是 33 欄的 colSpan grid，不是語意表格）
    // ═══════════════════════════════════════════════
    const HEADER_PATTERNS = [
        /^病歷號[:：]?$/, /^姓\s*名[:：]?$/, /^生\s*日[:：]?$/, /^身分證號[:：]?$/,
        /國立臺灣大學醫學院附設醫院/, /National Taiwan University/i, /^第$/, /^頁$/,
    ];
    const FOOTER_PATTERNS = [/病歷委員會修正通過電子病歷版本/, /^文件編號$/, /^版次$/];
    // 頁首個資即使漏網也不輸出：cell.innerText 會穿透頁面上的遮蔽（王Ｏ真 → 王素真）
    const PII_KEYS = [/^姓\s*名$/, /^生\s*日$/, /^Address$/i, /^身分證號$/, /^病歷號$/];

    const CHECKED = '■';
    const isBox = (s) => s === CHECKED || s === '□';
    const clean = (s) => String(s ?? '').replace(/　/g, ' ').replace(/\s+/g, ' ').trim();
    const isLabel = (s) => /[:：]\s*$/.test(s);
    const stripColon = (s) => s.replace(/[:：]\s*$/, '').trim();
    const isHeaderRow = (c) => c.some((x) => HEADER_PATTERNS.some((re) => re.test(x)));
    const isFooterRow = (c) => c.some((x) => FOOTER_PATTERNS.some((re) => re.test(x)));

    function parseRowItems(cells) {
        const items = [];

        if (cells.some(isBox)) {
            let prefix = '';
            const opts = [];
            let i = 0;
            while (i < cells.length && !isBox(cells[i])) {
                if (isLabel(cells[i])) prefix = stripColon(cells[i]);
                i++;
            }
            while (i < cells.length) {
                if (isBox(cells[i])) {
                    const checked = cells[i] === CHECKED;
                    const parts = [];
                    i++;
                    while (i < cells.length && !isBox(cells[i])) { parts.push(cells[i]); i++; }
                    const label = clean(parts.join(' '));
                    if (label) opts.push({ label: stripColon(label), checked });
                } else { i++; }
            }
            if (opts.length) items.push({ type: 'checkbox', key: prefix, options: opts });
            return items;
        }

        let i = 0;
        while (i < cells.length) {
            const c = cells[i];
            const next = cells[i + 1];
            if (isLabel(c)) {
                if (next !== undefined && !isLabel(next)) { items.push({ type: 'kv', key: stripColon(c), value: next }); i += 2; }
                else { items.push({ type: 'kv', key: stripColon(c), value: '' }); i += 1; }
            } else if (next !== undefined && !isLabel(next)) {
                items.push({ type: 'kv', key: c, value: next }); i += 2;
            } else {
                items.push({ type: 'text', value: c }); i += 1;
            }
        }
        return items;
    }

    function pickDocCode(rows) {
        for (const r of rows) {
            const cells = r.map(clean);
            const i = cells.findIndex((c) => /^文件編號$/.test(c));
            if (i >= 0) {
                for (let j = i + 1; j < cells.length; j++) {
                    if (/^\d{4,6}-\d-\d{4,8}$/.test(cells[j])) return cells[j];
                }
            }
            const direct = cells.find((c) => /^\d{5}-\d-\d{6}$/.test(c));
            if (direct) return direct;
        }
        return '';
    }

    function parseRows(rows) {
        const docCode = pickDocCode(rows);
        const sections = [];
        const titleParts = [];
        // 表單標題被 colSpan 切碎（"Occupational Therapy | Initial | Evaluation Note"）且整列無冒號。
        // 頁首之後、第一個含冒號的資料列之前的無冒號列 → 標題，不當欄位。
        let seenData = false;
        let cur = { name: '', items: [] };
        const push = () => { if (cur.items.length || cur.name) sections.push(cur); };

        for (const raw of rows) {
            const all = raw.map(clean);
            if (isHeaderRow(all) || isFooterRow(all)) continue;
            const cells = all.filter((c) => c !== '');
            if (cells.length === 0) continue;

            if (!seenData) {
                if (cells.some(isLabel) || cells.some(isBox)) seenData = true;
                else { titleParts.push(cells.join(' ')); continue; }
            }

            if (cells.length === 1 && !isLabel(cells[0]) && !isBox(cells[0])) {
                push();
                cur = { name: cells[0], items: [] };
                continue;
            }

            cur.items.push(...parseRowItems(cells).filter(
                (it) => !(it.type === 'kv' && PII_KEYS.some((re) => re.test(it.key)))
            ));
        }
        push();

        return {
            docCode,
            formTitle: clean(titleParts.join(' ')),
            sections: sections.filter((s) => s.name || s.items.length),
        };
    }

    function parseEformHtml(html) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const rows = [];
        for (const t of doc.querySelectorAll('table')) {
            for (const r of t.rows) rows.push([...r.cells].map((c) => c.innerText || c.textContent || ''));
        }
        const parsed = parseRows(rows);
        const title = clean(doc.title || '');
        if (title) parsed.formTitle = title;   // <title> 就是正式表單名，優先於版面切碎的標題
        return parsed;
    }

    // ═══════════════════════════════════════════════
    // 4. 輸出格式
    // ═══════════════════════════════════════════════
    function toBrief(parsed) {
        const out = [];
        for (const s of parsed.sections) {
            const lines = [];
            for (const it of s.items) {
                if (it.type === 'kv' && it.value) lines.push(`${it.key}: ${it.value}`);
                else if (it.type === 'checkbox') {
                    const on = it.options.filter((o) => o.checked).map((o) => o.label);
                    if (on.length) lines.push(`${it.key ? it.key + ': ' : ''}${on.join(', ')}`);
                } else if (it.type === 'text' && it.value) lines.push(it.value);
            }
            if (lines.length) out.push((s.name ? `【${s.name}】\n` : '') + lines.join('\n'));
        }
        return out.join('\n\n');
    }

    function toFull(parsed) {
        const out = [];
        for (const s of parsed.sections) {
            const lines = [];
            for (const it of s.items) {
                if (it.type === 'kv') lines.push(`${it.key}: ${it.value || '—'}`);
                else if (it.type === 'checkbox') {
                    lines.push((it.key ? it.key + ': ' : '') +
                        it.options.map((o) => `${o.checked ? '[v]' : '[ ]'}${o.label}`).join(' '));
                } else if (it.type === 'text') lines.push(it.value);
            }
            out.push((s.name ? `【${s.name}】\n` : '') + lines.join('\n'));
        }
        return out.join('\n\n');
    }

    function formatOne(meta, parsed, mode) {
        const head = `── ${parsed.formTitle || meta.category || meta.docCode} · ${meta.date} ${meta.time} ──`;
        return head + '\n' + (mode === 'full' ? toFull(parsed) : toBrief(parsed));
    }

    // ═══════════════════════════════════════════════
    // 5. 主流程：抓一批表單
    // ═══════════════════════════════════════════════
    /**
     * 硬性規則：檔名 ChartNo 必須等於當前病人，不符一律丟棄並回報數量。
     * 靜默丟會讓人以為表單不存在（假成功比 crash 難查十倍）。
     */
    function filterOwn(forms, chartNo) {
        if (!chartNo) return { kept: forms, dropped: 0, unchecked: true };
        const kept = forms.filter((f) => f.chartNo === chartNo);
        return { kept, dropped: forms.length - kept.length, unchecked: false };
    }

    async function extractForms(metas, mode, onProgress) {
        const parts = [];
        const errors = [];
        let done = 0;
        // eform 是靜態檔，可並行；壓成 4 條避免打爆舊主機
        const queue = metas.slice();
        async function worker() {
            for (;;) {
                const m = queue.shift();
                if (!m) return;
                try {
                    const html = await fetchEform(m.url);
                    const parsed = parseEformHtml(html);
                    parts.push({ meta: m, text: formatOne(m, parsed, mode) });
                } catch (e) {
                    errors.push(`${m.date} ${m.docCode}: ${e.message || e}`);
                }
                done++;
                if (onProgress) { try { onProgress(done, metas.length); } catch (e) { /* noop */ } }
            }
        }
        await Promise.all([worker(), worker(), worker(), worker()]);
        parts.sort((a, b) => a.meta.stamp.localeCompare(b.meta.stamp));
        return { text: parts.map((p) => p.text).join('\n\n'), errors };
    }

    // ═══════════════════════════════════════════════
    // 6. worker 模式（供 progress-note-filler 併入）
    // ═══════════════════════════════════════════════
    function setSharedData(name, value) {
        try { localStorage.setItem(name, value); } catch (e) { /* noop */ }
        if (typeof GM_setValue !== 'undefined') { try { GM_setValue(name, value); } catch (e) { /* noop */ } }
    }

    async function runWorker(token) {
        console.log(LOG, 'worker 模式', token);
        try {
            const chartNo = currentChartNo();
            const all = collectForms(document);
            const { kept, dropped } = filterOwn(all, chartNo);
            if (!kept.length) {
                setSharedData('ntuh_data_' + token, JSON.stringify({ ok: true, text: '（無復健治療表單）' }));
                return;
            }
            const params = new URLSearchParams(location.search);
            const limit = parseInt(params.get('ntuh_limit') || '6', 10);
            const picked = kept.sort((a, b) => b.stamp.localeCompare(a.stamp)).slice(0, limit);
            const { text, errors } = await extractForms(picked, params.get('ntuh_mode') || 'brief');
            const note = [
                dropped ? `（已濾除 ${dropped} 筆非本病人資料）` : '',
                errors.length ? `（${errors.length} 筆抓取失敗）` : '',
            ].filter(Boolean).join(' ');
            setSharedData('ntuh_data_' + token, JSON.stringify({ ok: true, text: (note ? note + '\n' : '') + text }));
        } catch (e) {
            setSharedData('ntuh_data_' + token, JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
    }

    // ═══════════════════════════════════════════════
    // 7. UI
    // ═══════════════════════════════════════════════
    // 事件 handler 內的例外會靜默吞掉 → 有 UI 回饋的一律包 guard
    function guard(fn) {
        return async function (...args) {
            try { await fn.apply(this, args); }
            catch (e) {
                console.error(LOG, e);
                const s = document.getElementById('rf-status');
                if (s) { s.textContent = '錯誤：' + (e.message || e); s.style.color = '#c00'; }
            }
        };
    }

    const CSS = `
#rf-panel{position:fixed;right:16px;top:80px;z-index:2147483000;width:380px;max-height:78vh;
 display:flex;flex-direction:column;background:#fff;border:1px solid #b8c4d0;border-radius:8px;
 box-shadow:0 4px 20px rgba(0,0,0,.18);font:13px/1.5 "Segoe UI","Microsoft JhengHei",sans-serif;color:#222}
#rf-panel header{padding:8px 12px;background:#2c5f8a;color:#fff;border-radius:7px 7px 0 0;
 display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none}
#rf-panel header b{font-size:13px;font-weight:600}
#rf-panel .rf-x{cursor:pointer;padding:0 4px;opacity:.85}
#rf-panel .rf-body{padding:8px 12px;overflow:auto;flex:1}
#rf-panel .rf-bar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 12px;border-top:1px solid #e3e8ee;background:#f7f9fb}
#rf-panel button{font:12px/1 inherit;padding:6px 10px;border:1px solid #b8c4d0;background:#fff;border-radius:4px;cursor:pointer}
#rf-panel button.rf-go{background:#2c5f8a;color:#fff;border-color:#2c5f8a;font-weight:600}
#rf-panel button:disabled{opacity:.5;cursor:default}
#rf-panel .rf-cat{margin:8px 0 3px;font-weight:600;color:#2c5f8a;font-size:12px}
#rf-panel label.rf-item{display:flex;gap:6px;align-items:baseline;padding:2px 0 2px 6px;cursor:pointer}
#rf-panel label.rf-item:hover{background:#eef4fa}
#rf-panel .rf-date{font-variant-numeric:tabular-nums}
#rf-panel .rf-code{color:#8a94a0;font-size:11px}
#rf-status{padding:4px 12px;font-size:12px;color:#555;min-height:18px}
#rf-out{width:100%;height:200px;font:12px/1.45 ui-monospace,Consolas,monospace;white-space:pre;
 border:1px solid #b8c4d0;border-radius:4px;padding:6px;box-sizing:border-box}
#rf-warn{margin:4px 0;padding:5px 8px;background:#fff4e5;border-left:3px solid #e8a33d;font-size:12px}
`;

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function buildPanel(forms, chartNo, dropped) {
        const el = document.createElement('div');
        el.id = 'rf-panel';

        const byCat = new Map();
        for (const f of forms) {
            const k = f.category || '(未分類)';
            if (!byCat.has(k)) byCat.set(k, []);
            byCat.get(k).push(f);
        }

        let list = '';
        for (const [cat, items] of byCat) {
            list += `<div class="rf-cat">${esc(cat)}</div>`;
            items.sort((a, b) => b.stamp.localeCompare(a.stamp));
            for (const f of items) {
                list += `<label class="rf-item"><input type="checkbox" data-url="${esc(f.url)}">` +
                    `<span class="rf-date">${f.date} ${f.time}</span>` +
                    `<span class="rf-code">${esc(f.docCode)}</span></label>`;
            }
        }

        el.innerHTML = `
<header><b>復健表單擷取</b><span class="rf-x" title="關閉">✕</span></header>
<div class="rf-body">
  ${dropped ? `<div id="rf-warn">已濾除 <b>${dropped}</b> 筆非本病人（${esc(chartNo)}）的表單</div>` : ''}
  ${chartNo ? '' : '<div id="rf-warn">⚠ 抓不到本頁 ChartNo，<b>未做病人過濾</b>，請自行核對</div>'}
  ${forms.length ? list : '<p>找不到復健電子表單。請先展開左側「電子表單」節點，再重開本面板。</p>'}
</div>
<div id="rf-status"></div>
<div class="rf-bar">
  <button id="rf-all">全選</button>
  <button id="rf-none">全不選</button>
  <button id="rf-latest">最近 3 筆</button>
  <label style="margin-left:auto"><input type="radio" name="rf-mode" value="brief" checked> 精簡</label>
  <label><input type="radio" name="rf-mode" value="full"> 完整</label>
</div>
<div class="rf-bar">
  <button id="rf-go" class="rf-go">擷取</button>
  <button id="rf-copy" disabled>複製</button>
</div>
<div class="rf-body" style="flex:0 0 auto"><textarea id="rf-out" readonly placeholder="擷取結果會出現在這裡"></textarea></div>`;
        return el;
    }

    function makeDraggable(panel, handle) {
        let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
        handle.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('rf-x')) return;
            on = true;
            const r = panel.getBoundingClientRect();
            sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!on) return;
            panel.style.left = ox + e.clientX - sx + 'px';
            panel.style.top = oy + e.clientY - sy + 'px';
            panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { on = false; });
    }

    function mountUI() {
        if (document.getElementById('rf-panel')) return;

        if (!document.getElementById('rf-style')) {
            const style = document.createElement('style');
            style.id = 'rf-style';
            style.textContent = CSS;
            document.head.appendChild(style);
        }

        const chartNo = currentChartNo();
        const all = collectForms(document);
        const { kept, dropped } = filterOwn(all, chartNo);
        console.log(LOG, `找到 ${all.length} 筆，本病人 ${kept.length} 筆，濾除 ${dropped} 筆`);

        const panel = buildPanel(kept, chartNo, dropped);
        document.body.appendChild(panel);
        makeDraggable(panel, panel.querySelector('header'));

        const boxes = () => [...panel.querySelectorAll('input[type=checkbox]')];
        const status = panel.querySelector('#rf-status');
        const out = panel.querySelector('#rf-out');

        panel.querySelector('.rf-x').addEventListener('click', () => panel.remove());
        panel.querySelector('#rf-all').addEventListener('click', () => boxes().forEach((b) => { b.checked = true; }));
        panel.querySelector('#rf-none').addEventListener('click', () => boxes().forEach((b) => { b.checked = false; }));
        panel.querySelector('#rf-latest').addEventListener('click', () => {
            const want = new Set(kept.slice().sort((a, b) => b.stamp.localeCompare(a.stamp)).slice(0, 3).map((f) => f.url));
            boxes().forEach((b) => { b.checked = want.has(b.dataset.url); });
        });

        panel.querySelector('#rf-copy').addEventListener('click', guard(async () => {
            await navigator.clipboard.writeText(out.value);
            status.textContent = '已複製';
            status.style.color = '#2a7';
        }));

        panel.querySelector('#rf-go').addEventListener('click', guard(async () => {
            const picked = boxes().filter((b) => b.checked).map((b) => b.dataset.url);
            if (!picked.length) { status.textContent = '請先勾選要擷取的表單'; status.style.color = '#c00'; return; }

            const byUrl = new Map(kept.map((f) => [f.url, f]));
            const metas = picked.map((u) => byUrl.get(u)).filter(Boolean);
            const mode = panel.querySelector('input[name=rf-mode]:checked').value;

            const go = panel.querySelector('#rf-go');
            go.disabled = true;
            status.style.color = '#555';
            status.textContent = `擷取中… 0/${metas.length}`;
            const t0 = nowMs();

            const { text, errors } = await extractForms(metas, mode, (d, n) => {
                status.textContent = `擷取中… ${d}/${n}`;
            });
            out.value = text || '(無內容)';
            panel.querySelector('#rf-copy').disabled = !text;
            go.disabled = false;

            const secs = ((nowMs() - t0) / 1000).toFixed(1);
            status.textContent = `完成 ${metas.length - errors.length}/${metas.length}（${secs}s）` +
                (errors.length ? ` · 失敗：${errors.join('；')}` : '');
            status.style.color = errors.length ? '#c60' : '#2a7';
        }));
    }

    // ═══════════════════════════════════════════════
    // 8. 進入點
    // ═══════════════════════════════════════════════
    const token = new URLSearchParams(location.search).get('ntuh_token');
    if (token) {
        // 背景頁：不畫 UI，抓完寫 localStorage 信封
        if (document.readyState === 'complete') runWorker(token);
        else window.addEventListener('load', () => runWorker(token));
    } else {
        const boot = () => {
            const btn = document.createElement('button');
            btn.id = 'rf-launch';
            btn.textContent = '復健表單';
            btn.style.cssText = 'position:fixed;right:16px;top:48px;z-index:2147483000;padding:6px 12px;' +
                'background:#2c5f8a;color:#fff;border:0;border-radius:4px;cursor:pointer;' +
                'font:12px/1 "Microsoft JhengHei",sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.2)';
            btn.addEventListener('click', guard(mountUI));
            document.body.appendChild(btn);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
        else boot();
    }
})();
