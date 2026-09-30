// ==UserScript==
// @name         NTUH 晨間簡報
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0-standalone
// @description  病房列表一鍵產生「昨夜狀態」簡報（新分頁）：vitals 以 NEWS2 判讀昨夜最差值與異常、新檢驗報告、新影像報告；只列有異常或有新東西的病人
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// ── 內嵌：NEWS2 核心 ──
// ==============================================================
// NEWS2 — National Early Warning Score 2（純函式，不碰 DOM／網路）
// --------------------------------------------------------------
// 兩件事：
//   1. parseVitalRows：把 vitalsign OuterData 的「每列一項」文字，
//      整理成一組組同時間的觀察值（TPR / BP / SpO2 / GCS / U/O）
//   2. scoreNews2 / summarizeWindow：算 NEWS2、挑出時間窗內最差的一組
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
//   之後用 window.NTUHNews2；node 測試則 require('./news2.js')。
//
// 已知取捨：
//   - SpO2 一律用 Scale 1。COPD 等 Scale 2 病人請靠「逐人覆寫」處理（未實作）。
//   - GCS < 15 一律視為意識改變（NEWS2 的 CVPU = 3 分），無法區分本來就有的基線。
//   - 缺項不補零：分數只算有量到的項目，並標 partial，避免低估。
//     例外：意識沒有 GCS 記錄時視為清醒，不算缺項。
// ==============================================================

/* global module */
(function (root) {
    'use strict';

    // 同一組觀察值容許的量測時間差（分鐘）。TPR、BP、SpO2 在 HIS 是分開的列，
    // 護理師常隔幾分鐘才key 完，所以要合併。
    const CLUSTER_MINUTES = 15;

    // ─── 各參數計分 ────────────────────────────────────────────
        function scoreRR(r) {
        if (r <= 8) return 3;
        if (r <= 11) return 1;
        if (r <= 20) return 0;
        if (r <= 24) return 2;
        return 3;
    }
    function scoreSpO2(s) { // Scale 1
        if (s <= 91) return 3;
        if (s <= 93) return 2;
        if (s <= 95) return 1;
        return 0;
    }
    function scoreO2(onOxygen) { return onOxygen ? 2 : 0; }
    function scoreSBP(s) {
        if (s <= 90) return 3;
        if (s <= 100) return 2;
        if (s <= 110) return 1;
        if (s <= 219) return 0;
        return 3;
    }
    function scoreHR(p) {
        if (p <= 40) return 3;
        if (p <= 50) return 1;
        if (p <= 90) return 0;
        if (p <= 110) return 1;
        if (p <= 130) return 2;
        return 3;
    }
    function scoreConsciousness(altered) { return altered ? 3 : 0; }
    function scoreTemp(t) {
        if (t <= 35.0) return 3;
        if (t <= 36.0) return 1;
        if (t <= 38.0) return 0;
        if (t <= 39.0) return 1;
        return 2;
    }

    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

    /**
     * @param {object} o 一組觀察值
     *   { T, P, R, SBP, SpO2, onOxygen, gcs }  — 缺的欄位給 undefined/null
     *   gcs：'E4M5V5' 之類字串或總分數字皆可
     * @returns {{total:number, parts:object, hasRed:boolean, level:string,
     *            missing:string[], partial:boolean}}
     */
    function scoreNews2(o) {
        const parts = {};
        const missing = [];
        const put = (key, val, fn) => {
            if (isNum(val)) parts[key] = fn(val); else missing.push(key);
        };
        put('RR', o.R, scoreRR);
        put('SpO2', o.SpO2, scoreSpO2);
        put('SBP', o.SBP, scoreSBP);
        put('HR', o.P, scoreHR);
        put('Temp', o.T, scoreTemp);

        // 給氧：SpO2 有量到才判斷，沒量到就當缺項
        if (isNum(o.SpO2)) parts.O2 = scoreO2(!!o.onOxygen); else missing.push('O2');

        const g = gcsTotal(o.gcs);
        // 意識：病房 vitals 幾乎沒有 GCS 列，沒記錄就當作清醒（0 分），也不算缺項，避免每列都掛「缺」
        if (g !== null) parts.Consciousness = scoreConsciousness(g < 15);

        const vals = Object.values(parts);
        const total = vals.reduce((a, b) => a + b, 0);
        const hasRed = vals.some((v) => v === 3);
        let level = 'low';
        if (total >= 7) level = 'high';
        else if (total >= 5) level = 'medium';
        else if (hasRed) level = 'low-medium'; // 單項 3 分：仍需臨床評估
        return { total, parts, hasRed, level, missing, partial: missing.length > 0 };
    }

    function gcsTotal(g) {
        if (isNum(g)) return g;
        if (typeof g !== 'string') return null;
        const m = g.match(/E(\d)M(\d)V(\w)/i);
        if (!m) return null;
        // 插管（V = T / A）無法給 V 分，保守以 V=1 計 → 總分 < 15，落在「意識改變」
        const v = /^\d$/.test(m[3]) ? +m[3] : 1;
        return +m[1] + +m[2] + v;
    }

    // ─── 解析 vitalsign 列 ─────────────────────────────────────
    const DT_RE = /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/;

    function toMs(dtStr) {
        const m = dtStr.match(DT_RE);
        if (!m) return NaN;
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
    }

    // 由 SpO2 括號內字串判斷是否給氧。格式 "FiO2,流量,裝置"：
//   room air 實測為 "%,L,"（三欄皆空）；給氧例 "28%,5L,Mask"。只有一欄時視為裝置。
function isOnOxygen(inside) {
        const parts = String(inside || '').split(',').map((x) => x.trim());
        let fio2 = '', flow = '', device = '';
        if (parts.length >= 3) [fio2, flow, device] = parts; else device = parts[0] || '';
        if (device && !/^room\s*air$/i.test(device)) return true;
        if (/\d/.test(flow)) return true;
        const f = parseFloat(fio2);
        return Number.isFinite(f) && f > 21;
    }

    /**
     * @param {string[]} rowTexts 每個 <tr> 的純文字（空白已收斂）
     * @returns {Array<object>} 依時間排序、已合併的觀察值：
     *   { dt, ms, T, P, R, SBP, DBP, SpO2, inside, onOxygen, gcs, uo, sources }
     */
    function parseVitalRows(rowTexts) {
        const singles = [];
        for (const raw of rowTexts) {
            const t = String(raw).replace(/\s+/g, ' ').trim();
            const dtm = t.match(DT_RE);
            if (!dtm) continue;
            if (+dtm[1] < 2000) continue; // HIS 佔位用 0001/01/01
            const dt = dtm[0];
            const ms = toMs(dt);
            let m;
            if ((m = t.match(/\bT:\s*([\d.]*)\s*P:\s*(\d*)\s*R:\s*(\d*)/i))) {
                const rec = { dt, ms, kind: 'tpr' };
                if (m[1]) rec.T = parseFloat(m[1]); else rec.naT = true; // 缺值另外記下，畫圖時標 NA
                if (m[2]) rec.P = +m[2]; else rec.naP = true;
                if (m[3]) rec.R = +m[3]; else rec.naR = true;
                if (rec.T !== undefined || rec.P !== undefined || rec.R !== undefined) singles.push(rec);
            } else if ((m = t.match(/BP:\s*(\d+)\/(\d+)/i))) {
                singles.push({ dt, ms, kind: 'bp', SBP: +m[1], DBP: +m[2] });
            } else if ((m = t.match(/SpO2:\s*(\d+)%\(([^)]*)\)/i))) {
                singles.push({ dt, ms, kind: 'spo2', SpO2: +m[1], inside: m[2], onOxygen: isOnOxygen(m[2]) });
            } else if ((m = t.match(/GCS:\s*(E\d+M\d+V\w+)/i))) {
                singles.push({ dt, ms, kind: 'gcs', gcs: m[1] });
            } else if ((m = t.match(/U\/?O:\s*(\d+)/i))) {
                singles.push({ dt, ms, kind: 'uo', uo: +m[1] });
            }
        }
        singles.sort((a, b) => a.ms - b.ms);

        // 時間相近的列合併成一組；同種量測在同組內以較晚者為準
        const clusters = [];
        for (const s of singles) {
            const last = clusters[clusters.length - 1];
            if (last && s.ms - last.ms <= CLUSTER_MINUTES * 60000) {
                const { dt, ms, kind, ...rest } = s; // eslint-disable-line no-unused-vars
                Object.assign(last, rest);
                // 同組內後來的列若補上了值，先前的 NA 標記作廢
                for (const k of ['T', 'P', 'R']) if (last[k] !== undefined) delete last['na' + k];
                last.sources.push(kind);
                last.endMs = s.ms;
            } else {
                const { kind, ...rest } = s;
                clusters.push({ ...rest, sources: [kind], endMs: s.ms });
            }
        }
        return clusters;
    }

    /**
     * 時間窗內的摘要：最差一組 NEWS2、各參數極值、超出條件的個別項目
     * @param {Array<object>} obs parseVitalRows 的結果
     * @param {number} fromMs 時間窗起點（含）
     * @param {number} toMs   時間窗終點（含）
     */
    function summarizeWindow(obs, fromMs, toMs_) {
        const inWin = obs.filter((o) => o.ms >= fromMs && o.ms <= toMs_);
        const latest = obs.length ? obs[obs.length - 1] : null;
        if (!inWin.length) {
            return { count: 0, worst: null, latest: latest && withScore(latest), flags: [], ranges: {}, series: [], noData: true };
        }
        const scored = inWin.map(withScore);
        // 最差 = 分數最高；同分取較晚（較新）
        let worst = scored[0];
        for (const s of scored) if (s.news.total >= worst.news.total) worst = s;

        const ranges = {};
        const track = (key, val) => {
            if (!isNum(val)) return;
            const r = ranges[key] || (ranges[key] = { min: val, max: val });
            if (val < r.min) r.min = val;
            if (val > r.max) r.max = val;
        };
        for (const o of inWin) {
            track('T', o.T); track('P', o.P); track('R', o.R);
            track('SBP', o.SBP); track('SpO2', o.SpO2);
        }
        return {
            count: inWin.length,
            worst,
            latest: withScore(latest),
            series: scored,     // 時間窗內每組觀察值（含各自的 NEWS2），供畫圖用
            ranges,
            flags: flagsFor(ranges, inWin),
            noData: false,
        };
    }

    function withScore(o) { return { ...o, news: scoreNews2(o) }; }

    // 給人看的個別異常標記（不等於 NEWS 加分，而是「這段時間發生過」）
    function flagsFor(ranges, obs) {
        const f = [];
        if (ranges.T && ranges.T.max >= 38.0) f.push(`發燒 ${ranges.T.max}`);
        if (ranges.T && ranges.T.min <= 35.0) f.push(`低體溫 ${ranges.T.min}`);
        if (ranges.P && ranges.P.max >= 111) f.push(`心搏過速 ${ranges.P.max}`);
        if (ranges.P && ranges.P.min <= 50) f.push(`心搏過緩 ${ranges.P.min}`);
        if (ranges.SBP && ranges.SBP.min <= 100) f.push(`低血壓 SBP ${ranges.SBP.min}`);
        if (ranges.SBP && ranges.SBP.max >= 180) f.push(`高血壓 SBP ${ranges.SBP.max}`);
        if (ranges.SpO2 && ranges.SpO2.min <= 93) f.push(`SpO2 ${ranges.SpO2.min}%`);
        if (ranges.R && ranges.R.max >= 22) f.push(`呼吸急促 ${ranges.R.max}`);
        if (obs.some((o) => o.onOxygen)) f.push('給氧中');
        return f;
    }

    /**
     * 昨夜時間窗：預設「前一日 17:00 → now」。now 在假日／週一的加長由呼叫端決定。
     */
    function overnightWindow(now, startHour = 17) {
        const n = new Date(now);
        const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1, startHour, 0);
        return { fromMs: from.getTime(), toMs: n.getTime() };
    }

    const api = {
        CLUSTER_MINUTES,
        scoreNews2, scoreRR, scoreSpO2, scoreSBP, scoreHR, scoreTemp,
        gcsTotal, isOnOxygen,
        parseVitalRows, summarizeWindow, overnightWindow,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.NTUHNews2 = api;
}(typeof window !== 'undefined' ? window : globalThis));


// ── 內嵌：簡化版 OuterData 呼叫（同時最多 3 個請求、12 秒逾時）──
(function () {
    'use strict';
    if (window.NTUHAsmx) return;
    let active = 0;
    const queue = [];
    async function withSlot(task) {
        if (active >= 3) await new Promise((release) => queue.push(release));
        active += 1;
        try { return await task(); } finally { active -= 1; const next = queue.shift(); if (next) next(); }
    }
    async function outerData(datatype, options) {
        const context = (options && options.context) || {};
        const url = window.location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '')
            + 'ProgressNoteControl/Service/OuterData.asmx/GetOuterDataTable';
        return withSlot(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 12000);
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ jsonstring: JSON.stringify(context), datatype }),
                    signal: ctrl.signal,
                    credentials: 'same-origin',
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const j = await res.json();
                let v = j && j.d;
                if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* keep */ } }
                return (v && v.Html) || '';
            } finally { clearTimeout(timer); }
        });
    }
    const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');
    window.NTUHAsmx = { outerData, parseHtml };
})();

// ── 主程式 ──

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2, Chart */

    const OPT_KEY = 'ntuh_morning_briefing';
    const DEFAULTS = {
        startHour: 17,    // 昨夜時間窗起點（前一日幾點）
    };

    function loadOpts() {
        try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(OPT_KEY)) || {}); }
        catch { return Object.assign({}, DEFAULTS); }
    }
    function saveOpts(o) { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { /* noop */ } }

    // HIS 的 date.js 會覆寫 Date.now，取毫秒一律走這個
    const nowMs = () => new Date().getTime();
    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
    const two = (n) => String(n).padStart(2, '0');
    const fmt = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

    // ═══════════════════════════════════════════════════════════
    // 病房列表 → 病人清單
    // ═══════════════════════════════════════════════════════════
    // 元素 id 前綴會變（NTUHWeb1／NTUHWeb9…），一律用尾綴選取

    function readPatients() {
        const table = document.querySelector('[id$="DataGridAccountList"]');
        if (!table) return [];
        const out = [];
        for (const tr of [...table.rows].slice(1)) {
            const news = tr.querySelector('[id$="NEWSLabel"]');
            const caseno = news && news.getAttribute('caseno');
            if (!caseno) continue;
            const cells = tr.cells;
            const labTitle = (tr.querySelector('[id$="LinkForthMedicalReport"]') || {}).title || '';
            out.push({
                caseno,                                            // = AccountIdse（已實測）
                chartNo: news.getAttribute('chartno') || txt(tr.querySelector('[id$="PatChartNo"]')),
                ward: news.getAttribute('wardcode') || txt(tr.querySelector('[id$="WardLabel"]')),
                name: txt(tr.querySelector('[id$="LinkPatientName"]')),
                bed: [txt(tr.querySelector('[id$="RoomLabel"]')), txt(tr.querySelector('[id$="BedLabel"]'))].filter(Boolean).join('-'),
                age: txt(tr.querySelector('[id$="PatientAge"]')),
                sex: txt(tr.querySelector('[id$="PatientSex"]')),
                attending: txt(cells[7]),
                resident: txt(cells[8]),
                hisEws: parseInt(txt(news), 10),
                labTitle,
            });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 時間窗
    // ═══════════════════════════════════════════════════════════
    // 週一自動回溯到週五晚上，涵蓋整個週末

    function briefingWindow(startHour) {
        const n = new Date(nowMs());
        const daysBack = n.getDay() === 1 ? 3 : 1;
        const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack, startHour, 0).getTime();
        return { fromMs: from, toMs: n.getTime(), daysBack };
    }

    // 列表 title「最新檢驗結果時間:HH:MM (N 小時內)」只有時分，往回推到最近的過去時間點
    function labTimeMs(title, now) {
        const m = title.match(/最新檢驗結果時間\s*[:：]\s*(\d{1,2}):(\d{2})/);
        if (!m) return null;
        const d = new Date(now);
        d.setHours(+m[1], +m[2], 0, 0);
        let ms = d.getTime();
        if (ms > now) ms -= 86400000;
        return ms;
    }

    // ═══════════════════════════════════════════════════════════
    // 單一病人：抓資料 + 判讀
    // ═══════════════════════════════════════════════════════════

    // SESSION：病房列表網址上帶著（頁內每個連結都帶）。檢驗頁第一次開常落在「登入前院網」
    // （該子系統的 session 尚未建立），帶上 SESSION 可減少這種情況（與 progress-note-data-helper 一致）。
    // 只放進連結的 href，不顯示、不寫入儲存空間。
    function pageSession() {
        const m = location.search.match(/[?&]session=([^&]+)/i)
            || document.documentElement.innerHTML.match(/SESSION=([a-zA-Z0-9]{34})/i);
        return m ? m[1] : '';
    }

    // 檢驗報告頁（與 progress-note-data-helper 的 [Lab] 同一頁）：靠 ChartNo 定位病人，
    // AccountIDSE/PersonID 都不需要；IntervalDay 為負數＝往前推幾天（-13 ≈ 兩週）。
    function labPageUrl(p) {
        const ses = pageSession();
        return location.origin + '/WebApplication/ElectronicMedicalReportViewer/MedicalReportContent.aspx'
            + `?${ses ? 'SESSION=' + encodeURIComponent(ses) + '&' : ''}PatClass=I&WardCode=${encodeURIComponent(p.ward || '')}&ChartNo=${encodeURIComponent(p.chartNo)}`
            + '&HospitalCode=T0&Seed=&IntervalDay=-13';
    }

    function ctxOf(p) {
        // 實測只需 AccountIdse（其餘可留空）；ChartNo 一併帶上
        return { AccountIdse: p.caseno, PersonId: '', ChartNo: p.chartNo, DeptCode: '', EmpDeptCode: '' };
    }

    function vitalTexts(html) {
        const doc = NTUHAsmx.parseHtml(html);
        const spans = [...doc.querySelectorAll('[id$="_Content"]')].map(txt);
        if (spans.length) return spans;
        return [...doc.querySelectorAll('tr')].map(txt);
    }

    function parsePacs(html, fromMs) {
        const doc = NTUHAsmx.parseHtml(html);
        const fromDay = new Date(fromMs); fromDay.setHours(0, 0, 0, 0);
        const out = [];
        for (const tr of doc.querySelectorAll('tbody tr')) {
            const content = [...tr.querySelectorAll('td')].map((td) => td.textContent).find((t) => t.includes('@@@'));
            if (!content) continue;
            const segs = content.split('@@@').map((s) => s.replace(/\s+/g, ' ').trim());
            const head = segs[0] || '';
            const dm = head.match(/(\d{4})\/(\d{2})\/(\d{2})/);
            if (!dm) continue;
            if (new Date(+dm[1], +dm[2] - 1, +dm[3]).getTime() < fromDay.getTime()) continue; // 影像只有日期，以日為單位
            const title = head.replace(/^\d{4}\/\d{2}\/\d{2}\s*/, '').replace(/\s*\(V\d+\)\s*$/, '').trim();
            const report = (segs[2] || segs[1] || '').slice(0, 160);
            out.push({ date: `${+dm[2]}/${+dm[3]}`, title, report });
        }
        return out;
    }

    async function assess(p, win, now) {
        const res = { p, errors: [], vitals: null, pacs: [], lab: null };
        const ctx = ctxOf(p);

        const labMs = labTimeMs(p.labTitle, now);
        if (labMs !== null && labMs >= win.fromMs) res.lab = { ms: labMs };

        const [v, x] = await Promise.allSettled([
            NTUHAsmx.outerData('vitalsign', { context: ctx }),
            NTUHAsmx.outerData('pacs', { context: ctx }),
        ]);
        if (v.status === 'fulfilled') {
            const obs = NTUHNews2.parseVitalRows(vitalTexts(v.value));
            res.vitals = NTUHNews2.summarizeWindow(obs, win.fromMs, win.toMs);
            res.vitals.total = obs.length;
        } else res.errors.push('vitals 抓取失敗：' + (v.reason && v.reason.message || v.reason));
        if (x.status === 'fulfilled') res.pacs = parsePacs(x.value, win.fromMs);
        else res.errors.push('影像抓取失敗：' + (x.reason && x.reason.message || x.reason));

        const s = res.vitals;
        res.news = s && s.worst ? s.worst.news : null;
        const level = res.news ? res.news.level : 'none';
        const rank = { none: 0, low: 0, 'low-medium': 1, medium: 2, high: 3 }[level];
        res.severity = rank;
        res.flags = s ? s.flags.filter((f) => f !== '給氧中') : [];
        res.onO2 = !!(s && s.flags.includes('給氧中'));
        res.attention = res.errors.length > 0 || rank > 0 || res.flags.length > 0 || !!res.lab || res.pacs.length > 0;
        return res;
    }

    // ═══════════════════════════════════════════════════════════
    // 輸出：獨立新分頁
    // ═══════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════
    // 共用：時間刻度與數據表
    // ═══════════════════════════════════════════════════════════

    function timeTicks(fromMs, toMs) {
        const H = 3600000, span = toMs - fromMs;
        const stepH = span <= 30 * H ? 6 : span <= 72 * H ? 12 : 24;
        const d = new Date(fromMs);
        d.setMinutes(0, 0, 0);
        const out = [];
        for (let t = d.getTime(); t <= toMs; t += H) {
            if (t < fromMs) continue;
            const dt = new Date(t);
            if (dt.getHours() % stepH !== 0) continue;
            out.push({ ms: t, label: dt.getHours() === 0 ? `${dt.getMonth() + 1}/${dt.getDate()}` : `${two(dt.getHours())}:00` });
        }
        return out;
    }

    function dataTable(series) {
        const c = (v) => (Number.isFinite(v) ? v : '—');
        return `<details class="tv"><summary>數據表（${series.length} 組）</summary><table><thead><tr><th>時間</th><th>NEWS2</th><th>T</th><th>HR</th><th>RR</th><th>SBP</th><th>SpO₂</th></tr></thead><tbody>${
            series.map((o) => `<tr><td>${esc(fmt(o.ms))}</td><td>${o.news.total}${o.news.partial ? '*' : ''}</td><td>${c(o.T)}</td><td>${c(o.P)}</td><td>${c(o.R)}</td><td>${c(o.SBP)}</td><td>${Number.isFinite(o.SpO2) ? o.SpO2 + '%' + (o.onOxygen ? ' 給氧' : '') : '—'}</td></tr>`).join('')
        }</tbody></table><div class="muted">* 有缺項，分數可能低估</div></details>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 院內樣式圖表（照院內生命徵象圖／NEWS 圖的座標與配色重現）
    // ═══════════════════════════════════════════════════════════
    // 來源：院內 SVGDrawer 產生的生命徵象圖。幾何與規則照抄：
    //   繪圖區 x 140–975、y 25–235（五等分，每格 42）；四條軸由左至右 BP/R/P/T，各自同色；
    //   正常帶 = 中間 2/5（T 36–38、P 60–100、R 10–22、BP 50–150），其餘為異常區；
    //   NA（未量測）不連線；預設顯示 T/P/R，BP 預設隱藏，點軸可切換。
    // 配色取自院內圖：異常 #ffd4d3、正常 #d3e7d0、NEWS 折線 #f26080。

    const HV = { X0: 140, X1: 975, Y0: 25, Y1: 235, W: 990, H: 262 };
    const HV_AXES = [
        { k: 'BP', x: 32, color: 'green', lo: 0, hi: 250, step: 50, off: true },
        { k: 'R', x: 68, color: 'black', lo: 4, hi: 34, step: 6, naY: 205 },
        { k: 'P', x: 104, color: 'red', lo: 40, hi: 140, step: 20, naY: 185 },
        { k: 'T', x: 140, color: 'blue', lo: 35, hi: 40, step: 1, naY: 225 },
    ];
    const hm = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };

    function hospVitals(series, win) {
        const span = win.toMs - win.fromMs;
        const X = (ms) => +(HV.X0 + ((ms - win.fromMs) / span) * (HV.X1 - HV.X0)).toFixed(2);
        const Y = (a, v) => {
            const c = Math.min(a.hi, Math.max(a.lo, v));
            return +(HV.Y1 - ((c - a.lo) / (a.hi - a.lo)) * (HV.Y1 - HV.Y0)).toFixed(2);
        };
        const st = (a) => `fill:${a.color};stroke:${a.color}`;
        let s = `<svg class="hsvg" viewBox="0 0 ${HV.W} ${HV.H}" width="${HV.W}" height="${HV.H}" role="img" aria-label="生命徵象圖">`;
        s += `<rect width="${HV.W}" height="${HV.H}" fill="#fffffd"/>`;
        // 背景色帶：上方異常 / 正常 / 下方異常
        s += `<polygon points="${HV.X0},25 ${HV.X1},25 ${HV.X1},109 ${HV.X0},109" fill="#ffd4d3"/>`
            + `<polygon points="${HV.X0},109 ${HV.X1},109 ${HV.X1},193 ${HV.X0},193" fill="#d3e7d0"/>`
            + `<polygon points="${HV.X0},193 ${HV.X1},193 ${HV.X1},235 ${HV.X0},235" fill="#ffd4d3"/>`;
        s += `<line x1="${HV.X0}" x2="${HV.X1}" y1="109" y2="109" stroke="#000" stroke-opacity=".2" stroke-width="1"/><line x1="${HV.X0}" x2="${HV.X1}" y1="193" y2="193" stroke="#000" stroke-opacity=".2" stroke-width="1"/>`;
        // 日期：起點日 + 每個午夜（院內作法：日期標在上方，午夜畫深色垂直線）
        const lbl = (ms, x) => { const d = new Date(ms); return `<text x="${x}" y="15" style="fill:#000;stroke:#000;stroke-width:.6;font-size:13px">${d.getMonth() + 1}/${d.getDate()}</text>`; };
        s += lbl(win.fromMs, HV.X0);
        const d0 = new Date(win.fromMs); d0.setHours(24, 0, 0, 0);
        for (let m = d0.getTime(); m < win.toMs; m += 86400000) {
            const x = X(m);
            s += `<line x1="${x}" x2="${x}" y1="240" y2="25" stroke="#000" stroke-opacity=".2" stroke-width="1.5"/>${lbl(m, x)}`;
        }
        s += `<line x1="${HV.X1}" x2="${HV.X1}" y1="240" y2="25" stroke="#000" stroke-opacity=".2" stroke-width="1.5"/>`;
        // 下方每 6 小時一個小時間刻度（院內圖沒有，短時間窗需要）
        for (const t of timeTicks(win.fromMs, win.toMs)) {
            if (!/:00$/.test(t.label)) continue;
            s += `<text x="${X(t.ms)}" y="256" text-anchor="middle" style="fill:#898781;font-size:10px">${esc(t.label)}</text>`;
        }
        // 軸（可點擊切換該項顯示）
        for (const a of HV_AXES) {
            s += `<g class="ax${a.off ? ' off' : ''}" data-s="${a.k}" style="${st(a)}"><text x="${a.x - 30}" y="11">${a.k}</text><line x1="${a.x}" y1="235" x2="${a.x}" y2="25"/>`;
            for (let v = a.lo; v <= a.hi + 1e-9; v += a.step) {
                const y = Y(a, v);
                s += `<text x="${a.x - 30}" y="${y}">${v}</text><line x1="${a.x - 5}" y1="${y}" x2="${a.x}" y2="${y}"/>`;
            }
            s += '</g>';
        }
        // 資料：T/P/R 各自的點與線（NA 斷線）；BP 為收縮/舒張壓的誤差線
        for (const a of HV_AXES) {
            s += `<g class="ser${a.off ? ' off' : ''}" data-s="${a.k}" style="${st(a)}">`;
            if (a.k === 'BP') {
                for (const o of series) {
                    if (!Number.isFinite(o.SBP) || !Number.isFinite(o.DBP)) continue;
                    const x = X(o.ms), y1 = Y(a, o.SBP), y2 = Y(a, o.DBP);
                    s += `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}"/><line x1="${x - 5}" y1="${y1}" x2="${x + 5}" y2="${y1}"/><line x1="${x - 5}" y1="${y2}" x2="${x + 5}" y2="${y2}"/>`
                        + `<line class="hitl" x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" data-t="${esc(hm(o.ms))}" data-v="${o.SBP}/${o.DBP}"/>`;
                }
            } else {
                let prev = null;
                for (const o of series) {
                    const v = o[a.k], x = X(o.ms);
                    if (Number.isFinite(v)) {
                        const y = Y(a, v);
                        if (prev) s += `<line x1="${prev.x}" y1="${prev.y}" x2="${x}" y2="${y}"/>`;
                        s += `<circle cx="${x}" cy="${y}" r="3"/><circle class="hit" cx="${x}" cy="${y}" r="9" data-t="${esc(hm(o.ms))}" data-v="${v}"/>`;
                        prev = { x, y };
                    } else if (o['na' + a.k]) {
                        s += `<text class="na" x="${x}" y="${a.naY}" data-t="${esc(hm(o.ms))}" data-v="未量測">NA</text>`;
                        prev = null; // 院內圖：未量測處斷線
                    }
                }
            }
            s += '</g>';
        }
        s += `<g class="tt" display="none" pointer-events="none"><rect fill="yellow" stroke="black" rx="2" ry="2"/><text x="5" y="18"><tspan class="t1" x="5" font-family="Arial" font-weight="bold" font-size="15"> </tspan><tspan class="t2" x="5" dy="1.2em" font-weight="bold" font-size="17" fill="blue"> </tspan></text></g></svg>`;
        return s;
    }

    // NEWS 圖：院內為類別軸（每次量測等距）＋粉紅折線＋綠色面積。
    // Y 軸固定從 0 起算（院內為自動縮放，分數 3→5 會被放大成滿版起伏，容易誤讀）。
    function hospNews(series) {
        const W = 640, H = 230, L = 46, R = 40, T = 20, B = 40;
        const iw = W - L - R, ih = H - T - B;
        const top = Math.max(7, Math.ceil(Math.max(...series.map((o) => o.news.total)) / 1) + 1);
        const step = top > 12 ? 2 : 1;
        const n = series.length;
        const X = (i) => +(L + (n === 1 ? iw / 2 : (i * iw) / (n - 1))).toFixed(1);
        const Y = (v) => +(T + (1 - v / top) * ih).toFixed(1);
        const lab = (ms) => { const d = new Date(ms); return `${d.getDate()}日${d.getHours()}:${two(d.getMinutes())}`; };
        let s = `<svg class="hsvg news" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="NEWS2 圖">`;
        s += `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="14" fill="#fffffd" stroke="#536382" stroke-width="3"/>`;
        s += `<rect x="${L}" y="${T}" width="${iw}" height="${ih}" fill="#eeffec"/>`;
        const pts = series.map((o, i) => `${X(i)},${Y(o.news.total)}`);
        s += `<polygon points="${X(0)},${T + ih} ${pts.join(' ')} ${X(n - 1)},${T + ih}" fill="#d6e9d3"/>`;
        for (let v = 0; v <= top; v += step) {
            s += `<line x1="${L}" x2="${L + iw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#000" stroke-opacity=".12"/><text x="${L - 8}" y="${+Y(v) + 4}" text-anchor="end" style="fill:#666;font-size:12px">${v}</text>`;
        }
        // 風險參考線（院內圖沒有，加上細線並標字，避免只靠顏色）
        for (const [v, t] of [[5, '5 中'], [7, '7 高']]) {
            if (v > top) continue;
            s += `<line x1="${L}" x2="${L + iw}" y1="${Y(v)}" y2="${Y(v)}" stroke="#d03b3b" stroke-opacity=".55" stroke-width="1"/><text x="${L + iw - 3}" y="${+Y(v) - 3}" text-anchor="end" style="fill:#b91c1c;font-size:10px">${t}</text>`;
        }
        const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / 70))));
        series.forEach((o, i) => {
            s += `<line x1="${X(i)}" x2="${X(i)}" y1="${T}" y2="${T + ih}" stroke="#000" stroke-opacity=".1"/>`;
            if (i % every === 0 && (n - 1 - i >= every || i === n - 1)) s += `<text x="${X(i)}" y="${H - 16}" text-anchor="middle" style="fill:#666;font-size:12px">${esc(lab(o.ms))}</text>`;
        });
        if (n > 1) s += `<polyline points="${pts.join(' ')}" fill="none" stroke="#f26080" stroke-width="2.5" stroke-linejoin="round"/>`;
        series.forEach((o, i) => {
            const tip = `${o.news.total}${o.news.partial ? '（缺 ' + o.news.missing.join('/') + '）' : ''}`;
            s += `<circle cx="${X(i)}" cy="${Y(o.news.total)}" r="4.5" fill="${o.news.partial ? '#fffffd' : '#ffd0da'}" stroke="#f26080" stroke-width="2"${o.news.partial ? ' stroke-dasharray="2.5 2"' : ''}/>`
                + `<circle class="hit" cx="${X(i)}" cy="${Y(o.news.total)}" r="10" data-t="${esc(hm(o.ms))}" data-v="NEWS2 ${esc(tip)}"/>`;
        });
        s += `<g class="tt" display="none" pointer-events="none"><rect fill="yellow" stroke="black" rx="2" ry="2"/><text x="5" y="18"><tspan class="t1" x="5" font-family="Arial" font-weight="bold" font-size="15"> </tspan><tspan class="t2" x="5" dy="1.2em" font-weight="bold" font-size="17" fill="blue"> </tspan></text></g></svg>`;
        return s;
    }

    function chartsHtml(r, win) {
        const series = r.vitals && r.vitals.series;
        if (!series || !series.length) return '';
        return `<div class="charts"><div class="hrow">
<div class="hcol hv"><div class="mt">生命徵象<span class="muted"> · 綠色帶為正常範圍（T 36–38、P 60–100、R 10–22、BP 50–150），粉紅為異常；點左側軸名稱可顯示／隱藏該項（血壓預設隱藏）</span></div>
${hospVitals(series, win)}</div>
<div class="hcol hn"><div class="mt">NEWS2（每次量測，等距排列）<span class="muted"> · 空心點 = 有缺項，分數可能低估</span></div>
<div class="nwrap"><canvas class="newsc" width="862" height="258" data-news="${esc(JSON.stringify({
    labels: series.map((o) => { const d = new Date(o.ms); return `${d.getDate()}日${d.getHours()}:${two(d.getMinutes())}`; }),
    values: series.map((o) => o.news.total),
    partial: series.map((o) => o.news.partial),
    missing: series.map((o) => o.news.missing),
}))}"></canvas><div class="nfb">${hospNews(series)}</div></div></div>
</div>
${dataTable(series)}</div>`;
    }

    // 頁面內互動（序列化後放進新分頁執行，不可引用外部變數）
    function pageScript() {
        // NEWS 圖：使用院內同一份 Chart.js 2.9.4 + annotation 0.5.7，設定照院內（色帶、線、提示框）。
        // 載入失敗時保留 SVG 後備版。只在容器可見時建立，因為 display:none 下 Chart.js 量到的尺寸是 0。
        const ensureNews = () => {
            if (!window.Chart) return;
            document.querySelectorAll('canvas.newsc').forEach((cv) => {
                const wrap = cv.parentNode;
                if (cv.getAttribute('data-done') || wrap.offsetParent === null) return;
                cv.setAttribute('data-done', '1');
                const d = JSON.parse(cv.getAttribute('data-news'));
                const PINK = 'rgba(255, 99, 132, 1)';
                cv.style.display = 'block';
                wrap.querySelector('.nfb').style.display = 'none';
                const box = (id, yMin, yMax, border, bg) => {
                    const a = { type: 'box', drawTime: 'beforeDatasetsDraw', id, xScaleID: 'x-axis-0', yScaleID: 'y-axis-0', borderColor: border, borderWidth: 0, backgroundColor: bg };
                    if (yMin !== null) a.yMin = yMin;
                    if (yMax !== null) a.yMax = yMax;
                    return a;
                };
                new Chart(cv, {
                    type: 'line',
                    data: {
                        labels: d.labels,
                        datasets: [{
                            label: 'NEWS趨勢圖', data: d.values, borderColor: PINK, tension: 0, borderWidth: 2, pointHoverRadius: 5,
                            pointBorderColor: PINK,
                            pointBackgroundColor: d.partial.map((p) => (p ? '#ffffff' : 'rgba(255, 99, 132, 0.35)')),
                        }],
                    },
                    options: {
                        legend: { display: false },
                        animation: { duration: 400 },
                        tooltips: {
                            callbacks: {
                                label: (ti) => 'NEWS2 ' + ti.yLabel + (d.partial[ti.index] ? '（缺 ' + d.missing[ti.index].join('/') + '，分數可能低估）' : ''),
                            },
                        },
                        // 院內設定寫成 Chart.js 3 的語法（min:0、stepSize:1），2.9.4 讀不到而退回自動縮放；這裡用 2.x 的寫法實現原意
                        scales: { yAxes: [{ ticks: { min: 0, suggestedMax: 9, stepSize: 1 } }] },
                        annotation: {
                            drawTime: 'afterDatasetsDraw',
                            annotations: [
                                box('danger-box', 7, null, 'rgba(255, 99, 132, 0.2)', 'rgba(255, 99, 132, 0.2)'),
                                box('warrning-box', 5, 7, 'rgba(255, 165, 0, 0.2)', 'rgba(255, 165, 0, 0.2)'),
                                box('normal-box', 0, 5, 'rgba(0, 255, 0, 0.2)', 'rgba(0, 255, 0, 0.1)'),
                            ],
                        },
                    },
                });
            });
        };
        document.querySelectorAll('.btn-tg').forEach((b) => b.addEventListener('click', () => {
            const d = b.closest('tr').nextElementSibling;
            const open = d.classList.toggle('open');
            b.setAttribute('aria-expanded', String(open));
            ensureNews();
        }));
        ensureNews();
        document.querySelectorAll('svg.hsvg').forEach((svg) => {
            svg.querySelectorAll('.ax').forEach((a) => a.addEventListener('click', () => {
                const off = a.classList.toggle('off');
                const g = svg.querySelector('.ser[data-s="' + a.getAttribute('data-s') + '"]');
                if (g) g.classList.toggle('off', off);
            }));
            const tt = svg.querySelector('.tt'), box = tt.querySelector('rect'), text = tt.querySelector('text');
            const t1 = tt.querySelector('.t1'), t2 = tt.querySelector('.t2'), vb = svg.viewBox.baseVal;
            svg.querySelectorAll('.hit,.hitl').forEach((h) => {
                h.addEventListener('pointermove', (ev) => {
                    t1.textContent = h.getAttribute('data-t');
                    t2.textContent = h.getAttribute('data-v');
                    const pt = svg.createSVGPoint();
                    pt.x = ev.clientX; pt.y = ev.clientY;
                    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
                    tt.setAttribute('display', 'inline');
                    const bb = text.getBBox();
                    const w = bb.x + bb.width + 6, hh = bb.y + bb.height + 6;
                    box.setAttribute('width', w); box.setAttribute('height', hh);
                    let x = p.x + 10, y = p.y + 10;
                    if (x + w > vb.width) x = vb.width - w;
                    if (y + hh > vb.height) y = p.y - hh - 6;
                    tt.setAttribute('transform', 'translate(' + x + ',' + y + ')');
                });
                h.addEventListener('pointerleave', () => tt.setAttribute('display', 'none'));
            });
        });
    }

    function rowHtml(r, win) {
        const p = r.p;
        const lvl = r.news ? r.news.level : 'none';
        const lab = r.lab ? `<a class="tag new" href="${esc(labPageUrl(p))}" target="_blank" rel="noopener" title="開啟這位病人的檢驗報告頁（近兩週）。若跳到登入頁，請再點一次">新報告 ${esc(fmt(r.lab.ms))} ↗</a>` : '<span class="muted">—</span>';
        const pacs = r.pacs.length ? r.pacs.map((x) => `<div><span class="tag new">${esc(x.date)} ${esc(x.title)}</span>${x.report ? `<div class="rep">${esc(x.report)}</div>` : ''}</div>`).join('') : '<span class="muted">—</span>';
        const err = r.errors.length ? `<div class="err">⚠ ${esc(r.errors.join('；'))}（此病人結果不完整，請手動確認）</div>` : '';
        const charts = chartsHtml(r, win);
        const openByDefault = charts && (r.severity > 0 || r.flags.length > 0);
        const toggle = charts ? `<br><button class="btn-tg" aria-expanded="${openByDefault ? 'true' : 'false'}">圖表</button>` : '';
        const main = `<tr class="lv-${lvl}">
<td><b>${esc(p.bed)}</b>${toggle}</td>
<td>${esc(p.name)}<br><small class="muted">${esc(p.chartNo)} · ${esc(p.sex)} ${esc(p.age)}</small>${err}</td>
<td>${lab}</td><td>${pacs}</td></tr>`;
        return charts ? `${main}<tr class="detail${openByDefault ? ' open' : ''}"><td colspan="4">${charts}</td></tr>` : main;
    }

    function buildHtml(results, win, meta) {
        // 院內 NEWS 圖用的 Chart.js 與同目錄；簡報頁沿用同一份（失敗時退回 SVG 版）
        const chartBase = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'js/Chart.js-2.9.4/';
        const attention = results.filter((r) => r.attention)
            .sort((a, b) => (b.severity - a.severity) || ((b.news ? b.news.total : -1) - (a.news ? a.news.total : -1))
                || ((b.p.hisEws || 0) - (a.p.hisEws || 0)) || a.p.bed.localeCompare(b.p.bed));
        const quiet = results.filter((r) => !r.attention);
        const noData = quiet.filter((r) => r.vitals && r.vitals.noData);
        const stable = quiet.filter((r) => !(r.vitals && r.vitals.noData));
        const names = (arr) => arr.map((r) => `${esc(r.p.bed)} ${esc(r.p.name)}`).join('、') || '—';

        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>晨間簡報 ${esc(fmt(win.toMs))}</title>
<style>
:root{--bg:#fff;--fg:#1c1f23;--mut:#6b7280;--line:#e5e7eb;--hi:#fee2e2;--md:#ffedd5;--lm:#fef9c3;--new:#dbeafe}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8ea;--mut:#9aa1a9;--line:#2a2f35;--hi:#4c1d1d;--md:#4a2c12;--lm:#3f3a12;--new:#172a45}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Noto Sans TC",sans-serif}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:12px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{position:sticky;top:0;background:var(--bg);font-size:12px;color:var(--mut)}
.lv-high td{background:var(--hi)}.lv-medium td{background:var(--md)}.lv-low-medium td{background:var(--lm)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:0 4px 2px 0;font-size:12px}.tag.new{background:var(--new)}a.tag{color:inherit;text-decoration:none}a.tag:hover{text-decoration:underline}
.muted{color:var(--mut)}small{font-size:12px}.err{color:#b91c1c;margin-top:4px;font-size:12px}.rep{font-size:12px;color:var(--mut);max-width:320px}
.box{margin-top:16px;padding:10px 12px;border:1px solid var(--line);border-radius:6px}.box h2{font-size:14px;margin:0 0 4px}
.note{margin-top:16px;font-size:12px;color:var(--mut)}
@media print{body{padding:0;font-size:11px}th{position:static}}
:root{--series:#2a78d6;--serious:#ec835a;--critical:#d03b3b;--surf:#fff;--grid:#e1e0d9;--axis:#c3c2b7;--tk:#898781;--ok:rgba(137,135,129,.14);--bmed:rgba(250,178,25,.16);--bhigh:rgba(208,59,59,.14)}
@media (prefers-color-scheme:dark){:root{--series:#3987e5;--surf:#14171a;--grid:#2c2c2a;--axis:#383835;--ok:rgba(137,135,129,.18);--bmed:rgba(250,178,25,.18);--bhigh:rgba(208,59,59,.22)}}
.detail{display:none}.detail.open{display:table-row}.detail>td{background:transparent!important;padding:8px 8px 14px}
.btn-tg{margin-top:4px;font-size:12px;padding:1px 8px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);cursor:pointer}
.btn-tg[aria-expanded=true]{background:var(--new)}
.mt{font-size:12px;color:var(--mut);margin:2px 0}.tv{margin-top:6px;font-size:12px}.tv table{width:auto}.tv th,.tv td{padding:2px 10px 2px 0}.tv summary{cursor:pointer;color:var(--mut)}
svg.hsvg{max-width:100%;height:auto;display:block;margin:2px 0 8px}
.nwrap{position:relative;width:100%;max-width:862px}.newsc{display:none;width:100%}.nwrap .nfb{display:block}
.hrow{display:flex;gap:12px;align-items:flex-start}
.hcol{min-width:0}.hcol.hv{flex:990 1 0}.hcol.hn{flex:640 1 0}
.hrow svg.hsvg{width:100%}.hcol.hv svg.hsvg{max-width:990px}.hcol.hn svg.hsvg{max-width:640px}
@media (max-width:1000px){.hrow{flex-wrap:wrap}.hcol.hv,.hcol.hn{flex:1 1 100%}}
svg.hsvg .ax{cursor:pointer}svg.hsvg .ax text{stroke-width:.35;font-size:13px}svg.hsvg .ax line,svg.hsvg .ser line{stroke-width:1}
svg.hsvg .ax.off{fill:lightgray!important;stroke:lightgray!important}svg.hsvg .ser.off{visibility:hidden}
svg.hsvg .ser circle{stroke:none}svg.hsvg .ser text.na{font-size:12px;stroke-width:.4}
svg.hsvg .hit{fill:transparent;stroke:none}svg.hsvg .hitl{stroke:transparent;stroke-width:12}
@media print{.detail{display:table-row}.btn-tg,</style></head><body>
<h1>晨間簡報</h1>
<div class="sub">時間窗 ${esc(fmt(win.fromMs))} → ${esc(fmt(win.toMs))}${win.daysBack > 1 ? '（週一，回溯至週五）' : ''} · 範圍：${esc(meta.scope)} · 共 ${results.length} 人，需注意 ${attention.length} 人</div>
${attention.length ? `<table><thead><tr><th>床</th><th>病人</th><th>檢驗</th><th>影像</th></tr></thead><tbody>${attention.map((r) => rowHtml(r, win)).join('')}</tbody></table>` : '<p>沒有需要注意的病人。</p>'}
<div class="box"><h2>時間窗內沒有 vitals 量測（${noData.length}）</h2>${names(noData)}<div class="muted">「沒量」不等於「正常」，請視需要確認。</div></div>
<div class="box"><h2>無異常、無新報告（${stable.length}）</h2>${names(stable)}</div>
<div class="note">NEWS2 為 Scale 1；缺量項目不補零，標示於「缺」。第一版尚未納入護理紀錄／交班／照會 note，也未逐人調整基線（例如 COPD）。判讀僅供快速瀏覽，不取代臨床評估。資料僅存在本頁，不上傳。</div>
<script src="${chartBase}Chart.min.js"><\/script><script src="${chartBase}chartjs-plugin-annotation.min-0.5.7.js"><\/script><script>(${pageScript.toString()})();<\/script></body></html>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 進入點
    // ═══════════════════════════════════════════════════════════

    async function run(btn) {
        const opts = loadOpts();
        // 病房列表本來就只帶出登入者的病人，不再另外篩選
        const mine = readPatients();
        if (!mine.length) { alert('找不到病人清單'); return; }

        const win = briefingWindow(opts.startHour);
        const now = nowMs();
        const label = btn.textContent;
        let done = 0;
        btn.disabled = true;
        const results = await Promise.all(mine.map((p) => assess(p, win, now).catch((e) => ({
            p, errors: ['判讀失敗：' + (e && e.message || e)], vitals: null, pacs: [], lab: null,
            news: null, severity: 0, flags: [], onO2: false, attention: true,
        })).then((r) => { btn.textContent = `抓取中 ${++done}/${mine.length}`; return r; })));
        btn.disabled = false;
        btn.textContent = label;

        const html = buildHtml(results, win, { scope: '目前病房列表' });
        const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
        const w = window.open(url, '_blank');
        if (!w) alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。');
    }

    function mount() {
        if (document.getElementById('ntuh-mb-btn')) return;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:fixed;right:16px;bottom:64px;z-index:99999;display:flex;gap:6px;font:14px system-ui,sans-serif';
        const btn = document.createElement('button');
        btn.id = 'ntuh-mb-btn';
        btn.textContent = '☀ 晨間簡報';
        btn.style.cssText = 'padding:8px 14px;border:0;border-radius:18px;background:#0f766e;color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
        btn.onclick = () => run(btn);
        const cfg = document.createElement('button');
        cfg.textContent = '⚙';
        cfg.title = '設定昨夜時間窗起點';
        cfg.style.cssText = 'padding:8px 10px;border:0;border-radius:18px;background:#374151;color:#fff;cursor:pointer';
        cfg.onclick = () => {
            const o = loadOpts();
            const h = prompt('昨夜時間窗起點（前一日幾點，0–23）：', String(o.startHour));
            if (h !== null && /^\d{1,2}$/.test(h.trim()) && +h <= 23) o.startHour = +h;
            saveOpts(o);
        };
        wrap.append(btn, cfg);
        document.body.appendChild(wrap);
    }

    mount();
}());
