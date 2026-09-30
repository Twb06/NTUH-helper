// ==UserScript==
// @name         NTUH 晨間簡報
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.8.0-standalone
// @description  病房列表一鍵產生「昨夜狀態」簡報（新分頁）：生命徵象圖、給氧／尿量變化、新檢驗報告、新影像報告；依列表順序列出所有病人，一行並排兩人
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

// ── 內嵌：NEWS2 核心 ──
// ==============================================================
// vitalsign 解析（純函式，不碰 DOM／網路）；檔名沿用 news2.js 以免動到 @require 網址
// --------------------------------------------------------------
// 三件事：
//   1. parseVitalRows：把 vitalsign OuterData 的「每列一項」文字，
//      整理成一組組同時間的觀察值（TPR / BP / SpO2 / GCS / U/O）
//   2. parseUo / o2Change：尿量與給氧變化
//   3. summarizeWindow：整理時間窗內的觀察值、範圍與異常標記
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
//   之後用 window.NTUHNews2；node 測試則 require('./news2.js')。
//
// =============================================================

/* global module */
(function (root) {
    'use strict';

    // 同一組觀察值容許的量測時間差（分鐘）。TPR、BP、SpO2 在 HIS 是分開的列，
    // 護理師常隔幾分鐘才key 完，所以要合併。
    const CLUSTER_MINUTES = 15;

    const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

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


    // ─── 尿量（U/O）：院內的 U/O 列常常沒有日期（實測 "U/O:0"），含意（每班或每日）不明，
    //     所以有日期的取最新一筆，沒有日期的只當「院內未標日期」原樣呈現，不做任何推論。
    function parseUo(rowTexts) {
        let dated = null, undated = null;
        for (const raw of rowTexts) {
            const t = String(raw).replace(/\s+/g, ' ').trim();
            const m = t.match(/U\/?O:\s*(\d+)/i);
            if (!m || +m[1] === 0) continue; // 0 多半是尚未填寫的預設值，不當作尿量
            const dtm = t.match(DT_RE);
            if (dtm && +dtm[1] >= 2000) {
                const ms = toMs(dtm[0]);
                if (!dated || ms > dated.ms) dated = { ms, val: +m[1] };
            } else if (undated === null) {
                undated = { ms: null, val: +m[1] };
            }
        }
        return dated || undated;
    }

    // ─── 給氧變化：只看時間窗內有量到 SpO2 的觀察（SpO2 括號內才有給氧資訊）
    // inside 格式 "FiO2,流量,裝置"，例 "28%,3L,Nasal Cannula"
    function oxygenInfo(inside) {
        const parts = String(inside || '').split(',').map((x) => x.trim());
        let flow = '', device = '';
        if (parts.length >= 3) [, flow, device] = parts; else device = parts[0] || '';
        const f = parseFloat(String(flow).replace(/[^\d.]/g, ''));
        const dev = /cannula/i.test(device) ? 'NC' : /mask/i.test(device) ? 'Mask' : device;
        return { flow: Number.isFinite(f) ? f : null, device: dev };
    }

    /**
     * @returns {null | {kind:'new'|'transient'|'off'|'up'|'down'|'on', ms:number|null, text:string}}
     *   全程室內空氣、或時間窗內沒有 SpO2 → null（沒有值得標的變化）
     */
    function o2Change(series) {
        const obs = (series || []).filter((o) => Number.isFinite(o.SpO2));
        if (!obs.length) return null;
        const on = (o) => !!o.onOxygen;
        const desc = (o) => { const x = oxygenInfo(o.inside); return [x.device, x.flow !== null ? x.flow + 'L' : ''].filter(Boolean).join(' ') || '給氧'; };
        const first = obs[0], last = obs[obs.length - 1];
        if (!on(first) && obs.some(on)) {
            const t = obs.find(on);
            return on(last)
                ? { kind: 'new', ms: t.ms, text: '新增給氧 ' + desc(t) }
                : { kind: 'transient', ms: t.ms, text: '曾短暫給氧 ' + desc(t) };
        }
        if (on(first) && !on(last)) {
            const t = obs.find((o, i) => i > 0 && !on(o));
            return { kind: 'off', ms: t ? t.ms : last.ms, text: '脫離給氧' };
        }
        if (on(first) && on(last)) {
            const f0 = oxygenInfo(first.inside).flow, f1 = oxygenInfo(last.inside).flow;
            if (f0 !== null && f1 !== null && f1 > f0) return { kind: 'up', ms: last.ms, text: `給氧流量上升 ${f0}→${f1} L` };
            if (f0 !== null && f1 !== null && f1 < f0) return { kind: 'down', ms: last.ms, text: `給氧流量下降 ${f0}→${f1} L` };
            return { kind: 'on', ms: null, text: '持續給氧 ' + desc(last) };
        }
        return null;
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
            return { count: 0, latest, flags: [], ranges: {}, series: [], noData: true };
        }
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
            latest,
            series: inWin,      // 時間窗內每組觀察值，供畫圖用
            ranges,
            flags: flagsFor(ranges, inWin),
            noData: false,
        };
    }

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
        isOnOxygen,
        parseVitalRows, parseUo, oxygenInfo, o2Change, summarizeWindow, overnightWindow,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.NTUHNews2 = api;
}(typeof window !== 'undefined' ? window : globalThis));


// ── 內嵌：簡化版 OuterData 呼叫（同時最多 3 個請求、預設 12 秒逾時，可由 options.timeoutMs 覆寫）──
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
            const timer = setTimeout(() => ctrl.abort(), (options && options.timeoutMs) || 12000);
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

    /* global NTUHAsmx, NTUHNews2 */

    const START_HOUR = 17; // 昨夜時間窗起點（前一日幾點）
    // 為什麼分兩階段（新竹實測 2026-09-30，11 位病人）：處方頁＋管路單獨測時加起來約 28 秒，剛好等於不論同時數怎麼調
    // 的總時間（2 個、3 個、全部同時開跑都是 28～30 秒）→ 這兩個重頁面在伺服器端幾乎是一個接一個處理，
    // 同時發再多也不會變快，只會讓 vitals／影像這種輕請求排在後面（全部同時開跑時平均等 17～19 秒）。
    // 所以由我們決定順序：先抓完所有病人的輕請求（階段一），再抓重的（階段二，依病人順序小批處理）。
    const HEAVY_POOL = 2;   // 階段二同時處理的病人數
    // OuterData 逾時：請求要在瀏覽器／伺服器排隊，逾時計時包含排隊時間，所以放寬到 30 秒（lib 預設 12 秒）。
    const OUTER_TIMEOUT_MS = 30000;

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
                hospDay: (tr.innerHTML.match(/住院總天數\s*[:：]\s*(\d+)/) || [])[1] || '',
                labTitle,
            });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 時間窗
    // ═══════════════════════════════════════════════════════════
    // 週一自動回溯到週五晚上，涵蓋整個週末

    const REF_HOUR = 8; // 圖表參考資料起點（前一日幾點）

    function briefingWindow(startHour) {
        const n = new Date(nowMs());
        const daysBack = n.getDay() === 1 ? 3 : 1;
        const from = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack, startHour, 0).getTime();
        // 圖表另外往前多看到前一日 08:00 當參考基準（異常判斷、給氧、抽血、影像仍用昨夜時間窗）
        const ref = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysBack, REF_HOUR, 0).getTime();
        return { fromMs: from, refFromMs: Math.min(ref, from), toMs: n.getTime(), daysBack };
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

    // SESSION：病房列表網址上帶著（頁內每個連結都帶）。實測：不帶時點連結會跳到需要登入的頁面，
    // 帶上後可正常開啟（新竹分院）。只確認了這個結果，機制未確認，因此不在此推測原因。
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
            const report = (segs[2] || segs[1] || '').slice(0, 1500);
            out.push({ date: `${+dm[2]}/${+dm[3]}`, title, report });
        }
        return out;
    }

    // ─── 抗生素（現行處方頁 MedicationV2.aspx）─────────────────
    // 藥歷圖（Chart.aspx）需要 PersonID，病房列表取不到（不帶會 500）；處方頁只需 SESSION＋AccountIDSE。
    // 處方表沒有藥品類別欄，只能用學名比對。天數 = 這張醫令的開始日起算（D1＝開始當天）；
    // 中途改劑量或重開醫令會重新起算，天數可能低估。
    // 清單來自院內「抗感染藥」全表，已排除慢性／非急性用藥（結核、HIV、B/C 肝、抗瘧、寄生蟲、外用）。
    // 要增減藥：直接改下面的字串（不分大小寫、子字串比對）。
    const ABX_NAMES = [
        // 抗細菌
        'penicillin', 'amoxicillin', 'ampicillin', 'dicloxacillin', 'oxacillin', 'piperacillin', 'sulbactam', 'tazobactam',
        'avibactam', 'relebactam', 'cef', 'cephalexin', 'flomoxef', 'ertapenem', 'imipenem', 'meropenem', 'aztreonam',
        'amikacin', 'gentamicin', 'tobramycin', 'ciprofloxacin', 'levofloxacin', 'moxifloxacin', 'nemonoxacin',
        'pipemidic', 'azithromycin', 'clarithromycin', 'erythromycin', 'doxycycline', 'minocycline', 'tetracycline',
        'tigecycline', 'vancomycin', 'teicoplanin', 'daptomycin', 'linezolid', 'colistin', 'polymyxin', 'fosfomycin',
        'fusidate', 'clindamycin', 'metronidazole', 'co-trimoxazole', 'trimethoprim', 'sulfamethoxazole', 'fidaxomicin',
        // 抗黴菌（全身性）
        'fluconazole', 'itraconazole', 'voriconazole', 'posaconazole', 'isavuconazole', 'caspofungin', 'micafungin',
        'anidulafungin', 'amphotericin', 'flucytosine',
        // 急性抗病毒
        'acyclovir', 'ganciclovir', 'oseltamivir', 'peramivir', 'remdesivir', 'foscarnet', 'baloxavir', 'molnupiravir', 'nirmatrelvir',
    ];
    const ABX_RE = new RegExp(ABX_NAMES.map((n) => n.replace(/[-]/g, '\\-')).join('|'), 'i');

    // 簡單併發閘門：同時最多 max 個任務（晨間簡報每人要開處方頁與管路頁，避免一次灌爆院內主機）
    function makeGate(max) {
        let active = 0;
        const queue = [];
        return async (task) => {
            if (active >= max) await new Promise((release) => queue.push(release));
            active += 1;
            try { return await task(); } finally { active -= 1; const next = queue.shift(); if (next) next(); }
        };
    }
    const rxGate = makeGate(3);   // 處方頁（約 200KB，最重的請求）
    // 管路一律一次一位（原因見下方 fetchTubes 的註解：handler 靠「最近載入的病人」決定回誰）
    const tubeGate = makeGate(1);

    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const dayNo = (startMs, now) => Math.round((dayStart(now) - dayStart(startMs)) / 86400000) + 1;

    // 處方表：表頭對欄位（兩張表位置不同）。沿用 prescription-viewer 的判定，處理 DOMParser 文件（無 innerText）
    function readRxGrid(t, ownOnly) {
        if (!t || t.rows.length < 2) return [];
        const col = { start: -1, name: -1, route: -1 };
        [...t.rows[0].cells].forEach((td, i) => {
            const h = td.textContent.replace(/\s+/g, '');
            if (col.start < 0 && h.includes('開始日')) col.start = i;
            if (col.name < 0 && h.includes('藥名')) col.name = i;
            if (col.route < 0 && h.includes('途徑')) col.route = i;
        });
        if (col.start < 0 || col.name < 0) return [];
        const cell = (tr, i) => (i >= 0 && tr.cells[i] ? tr.cells[i].textContent.replace(/\s+/g, ' ').trim() : '');
        const out = [];
        for (const tr of [...t.rows].slice(1)) {
            const startRaw = cell(tr, col.start);
            const rawName = cell(tr, col.name);
            if (!/^\d{8}$/.test(startRaw) || !rawName) continue;
            if (ownOnly && !/^\s*\[自備藥\]/.test(rawName)) continue;
            out.push({ rawName, route: cell(tr, col.route), startMs: new Date(+startRaw.slice(0, 4), +startRaw.slice(4, 6) - 1, +startRaw.slice(6, 8)).getTime() });
        }
        return out;
    }

    async function fetchAbx(p, now) {
        return rxGate(async () => {
            const url = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'MedicationV2.aspx'
                + `?SESSION=${encodeURIComponent(pageSession())}&PatClass=I&AccountIDSE=${encodeURIComponent(p.caseno)}&Hosp=T0&Seed=&EMRPop=Y`;
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            try {
                const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const doc = NTUHAsmx.parseHtml(await res.text());
                // id 前綴會變（探測時是用尾綴找到的），一律用尾綴選取器
                const general = doc.querySelector('[id$="OrderBox_dgrPhrOrder"]');
                const own = doc.querySelector('[id$="OrderDisplayBox_dgrPhrOrder"]');
                if (!general && !own) throw new Error('處方表讀不到');
                const rows = readRxGrid(general, false).concat(readRxGrid(own, true));
                return rows.filter((r) => ABX_RE.test(r.rawName)).map((r) => {
                    const name = r.rawName.replace(/^\s*\[自備藥\]\s*/, '').split('(')[0].trim() || r.rawName.slice(0, 30);
                    return { name: name.slice(0, 40), route: r.route, startMs: r.startMs, day: dayNo(r.startMs, now) };
                }).sort((a, b) => a.startMs - b.startMs);
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // ─── 管路（CatheterCare_Handler.aspx）───────────────────────
    // 頁面的資料來自 GET CatheterCare_Handler.aspx?mode=getCatheterRecord&catherStatus=UnRemovedOnly（XML）。
    // 這個請求「不帶任何病人識別」：伺服器靠「最近載入 CatheterCare.aspx 的那位病人」決定回誰，
    // 額外參數一律被忽略（新竹實測 2026-09-30）。所以：
    //   1. 一律一次一位（tubeGate=1），先載入該病人的頁面 HTML（不跑頁面 JS，約 0.5 秒）再立刻打 handler（約 0.1 秒）。
    //   2. 每條管路的 <decorate> 都帶 <caseno>（＝病房列表的 AccountIDSE），逐條驗證，對不上就整批丟棄。
    // 已知盲點：這位病人若一條管路都沒有，就沒有 caseno 可驗證；此時若有人在別的分頁操作 CatheterCare，
    // 理論上可能拿到別人的空結果。簡報執行期間不要同時操作 CatheterCare。
    const CATH_PERIPHERAL_RE = /留置針|IV\s*Catheter/i;   // 周邊留置針不列入（CVC／PICC／Port-A 等中央導管要留）
    const tubeText = (node, tag) => { const e = node.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const parseInsert = (t) => {
        const m = t.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
    };

    async function fetchTubes(p, now) {
        return tubeGate(async () => {
            const dir = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '').replace(/Ward\/$/, '') + 'Nursing/';
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            try {
                const opt = { credentials: 'same-origin', signal: ctrl.signal };
                const page = await fetch(`${dir}CatheterCare.aspx?session=${encodeURIComponent(pageSession())}&AccountIDSE=${encodeURIComponent(p.caseno)}&PatClass=I`, opt);
                if (!page.ok) throw new Error('管路頁 HTTP ' + page.status);
                await page.text();
                const res = await fetch(`${dir}CatheterCare_Handler.aspx?aa=${nowMs()}&mode=getCatheterRecord&catherStatus=UnRemovedOnly`, opt);
                if (!res.ok) throw new Error('管路資料 HTTP ' + res.status);
                const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
                if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('UnRemovedCatheter').length) throw new Error('管路資料格式不符');
                const decs = [...doc.getElementsByTagName('decorate')];
                const total = parseInt(tubeText(doc.getElementsByTagName('UnRemovedCatheter')[0], 'TotalCount'), 10);
                if (Number.isFinite(total) && total !== decs.length) throw new Error(`管路數量不符（${total}／${decs.length}）`);
                if (decs.some((d) => tubeText(d, 'caseno') !== p.caseno)) throw new Error('管路資料與病人不符，已丟棄');
                return decs.map((d) => {
                    const full = tubeText(d, 'CatheterName');
                    return { full, name: full.replace(/\(.*?\)/g, '').trim() || full, startMs: parseInsert(tubeText(d, 'CatheterInsertDateTime')) };
                }).filter((x) => x.full && !CATH_PERIPHERAL_RE.test(x.full) && Number.isFinite(x.startMs))
                    .map((x) => ({ name: x.name, startMs: x.startMs, day: dayNo(x.startMs, now) }))
                    .sort((a, b) => a.startMs - b.startMs);
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // 每位病人的結果容器。pending＝還沒回來的來源；頁面會依 pending 顯示「抓取中…」
    function newResult(p, win, now) {
        const res = { p, errors: [], vitals: null, pacs: [], lab: null, abx: null, tubes: null, pending: new Set(['vitals', 'pacs', 'abx', 'tubes']) };
        const labMs = labTimeMs(p.labTitle, now);
        if (labMs !== null && labMs >= win.fromMs) res.lab = { ms: labMs };
        return res;
    }

    // 來源回來（不論成功或失敗）就通知 onUpdate(src, res)，由呼叫端更新畫面；失敗只記在 res.errors，不丟出
    function jobRunner(res, onUpdate) {
        return async (src, label, work) => {
            try { await work(); } catch (e) { res.errors.push(`${label}抓取失敗：` + (e && e.message || e)); } finally {
                res.pending.delete(src);
                try { onUpdate(src, res); } catch (e) { console.warn('[晨間簡報] 更新畫面失敗', src, e); }
            }
        };
    }

    // 階段一（輕）：vitals、影像。單獨測各約 0.1～2 秒
    async function assessLight(res, win, onUpdate) {
        const p = res.p;
        const ctx = ctxOf(p);
        const job = jobRunner(res, onUpdate);
        await Promise.all([
            job('vitals', 'vitals ', async () => {
                const html = await NTUHAsmx.outerData('vitalsign', { context: ctx, timeoutMs: OUTER_TIMEOUT_MS });
                const texts = vitalTexts(html);
                const obs = NTUHNews2.parseVitalRows(texts);
                res.vitals = NTUHNews2.summarizeWindow(obs, win.fromMs, win.toMs);
                res.vitals.total = obs.length;
                res.chartSeries = obs.filter((o) => o.ms >= win.refFromMs && o.ms <= win.toMs);
                res.uo = NTUHNews2.parseUo(texts);
                res.o2 = NTUHNews2.o2Change(res.vitals.series);
            }),
            job('pacs', '影像', async () => {
                res.pacs = parsePacs(await NTUHAsmx.outerData('pacs', { context: ctx, timeoutMs: OUTER_TIMEOUT_MS }), win.fromMs);
            }),
        ]);
    }

    // 階段二（重）：抗生素（處方頁約 1.8 秒、200KB）、管路（頁面＋handler 約 0.7 秒，且必須一次一位）
    async function assessHeavy(res, now, onUpdate) {
        const p = res.p;
        const job = jobRunner(res, onUpdate);
        await Promise.all([
            job('abx', '抗生素', async () => { res.abx = await fetchAbx(p, now); }),
            job('tubes', '管路', async () => { res.tubes = await fetchTubes(p, now); }),
        ]);
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
        return `<details class="tv"><summary>數據表（${series.length} 組）</summary><table><thead><tr><th>時間</th><th>T</th><th>HR</th><th>RR</th><th>SBP</th><th>SpO₂</th></tr></thead><tbody>${
            series.map((o) => `<tr><td>${esc(fmt(o.ms))}</td><td>${c(o.T)}</td><td>${c(o.P)}</td><td>${c(o.R)}</td><td>${c(o.SBP)}</td><td>${Number.isFinite(o.SpO2) ? o.SpO2 + '%' + (o.onOxygen ? ' 給氧' : '') : '—'}</td></tr>`).join('')
        }</tbody></table></details>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 院內樣式生命徵象圖（照院內的座標與配色重現）
    // ═══════════════════════════════════════════════════════════
    // 來源：院內 SVGDrawer 產生的生命徵象圖。幾何與規則照抄：
    //   繪圖區 x 140–975、y 25–235（五等分，每格 42）；四條軸由左至右 BP/R/P/T，各自同色；
    //   正常帶 = 中間 2/5（T 36–38、P 60–100、R 10–22、BP 50–150），其餘為異常區；
    //   NA（未量測）不連線；四項預設全部顯示（院內預設隱藏 BP，這裡改為顯示），點軸可切換。
    // 配色取自院內圖：異常 #ffd4d3、正常 #d3e7d0。

    const HV = { X0: 140, X1: 975, Y0: 25, Y1: 235, W: 990, H: 262 };
    const HV_AXES = [
        { k: 'BP', x: 32, color: 'green', lo: 0, hi: 250, step: 50 },
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

    function chartsHtml(r, win) {
        const series = r.chartSeries;
        if (!series || !series.length) return '';
        // 圖固定顯示（不收合）；標題「生命徵象 ↗」在卡片骨架（cardShell）裡，數據表仍可展開
        return `<div class="charts">${hospVitals(series, { fromMs: win.refFromMs, toMs: win.toMs })}
${dataTable(series)}</div>`;
    }

    // 頁面內互動（序列化後放進新分頁執行，不可引用外部變數）。
    // 卡片內容是「邊抓邊塞」進頁面的，所以一律用事件委派，不在載入時逐一綁定。
    function pageScript() {
        let tipSvg = null;
        const hideTip = () => {
            if (!tipSvg) return;
            const tt = tipSvg.querySelector('.tt');
            if (tt) tt.setAttribute('display', 'none');
            tipSvg = null;
        };
        document.addEventListener('click', (ev) => {
            const a = ev.target.closest && ev.target.closest('.ax');
            const svg = a && a.closest('svg.hsvg');
            if (!svg) return;
            const off = a.classList.toggle('off');
            const g = svg.querySelector('.ser[data-s="' + a.getAttribute('data-s') + '"]');
            if (g) g.classList.toggle('off', off);
        });
        document.addEventListener('pointermove', (ev) => {
            const h = ev.target.closest && ev.target.closest('.hit,.hitl');
            const svg = h && h.closest('svg.hsvg');
            if (!svg) { hideTip(); return; }
            if (tipSvg && tipSvg !== svg) hideTip();
            tipSvg = svg;
            const tt = svg.querySelector('.tt'), box = tt.querySelector('rect'), text = tt.querySelector('text');
            const t1 = tt.querySelector('.t1'), t2 = tt.querySelector('.t2'), vb = svg.viewBox.baseVal;
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
    }

    // ─── 卡片各區塊（每個區塊有自己的 id，抓完一個來源就只更新那一格）──────────
    const PENDING_HTML = '<span class="muted">抓取中…</span>';
    const dayTag = (x, cls) => `<span class="tag${cls}">${esc(x.name)}${x.route ? ' ' + esc(x.route) : ''} D${x.day}<small class="muted"> ${new Date(x.startMs).getMonth() + 1}/${new Date(x.startMs).getDate()} 起</small></span>`;

    function renderVit(r, win) {
        if (r.pending.has('vitals')) return '';
        const o2Cls = r.o2 && (r.o2.kind === 'new' || r.o2.kind === 'up') ? ' warn' : '';
        const o2 = r.o2 ? `<div><span class="tag${o2Cls}">${esc(r.o2.text)}${r.o2.ms ? '（' + esc(fmt(r.o2.ms)) + '）' : ''}</span></div>` : '';
        const uo = r.uo ? `<div class="muted nov">尿量 ${r.uo.val} mL${r.uo.ms ? '（' + esc(fmt(r.uo.ms)) + '）' : '（院內未標日期）'}</div>` : '';
        const noVitals = r.vitals && r.vitals.noData
            ? `<div class="muted nov">${r.chartSeries && r.chartSeries.length ? '昨夜（' + esc(fmt(win.fromMs)) + ' 起）沒有 vitals 量測，圖上為前一日的參考資料' : '時間窗內沒有 vitals 量測（沒量不等於正常）'}</div>` : '';
        return o2 + uo + noVitals;
    }
    const renderErr = (r) => (r.errors.length ? `<div class="err">⚠ ${esc(r.errors.join('；'))}（此病人結果不完整，請手動確認）</div>` : '');
    const renderAbx = (r) => (r.pending.has('abx') ? PENDING_HTML : r.abx ? (r.abx.length ? r.abx.map((x) => dayTag(x, ' new')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    const renderTubes = (r) => (r.pending.has('tubes') ? PENDING_HTML : r.tubes ? (r.tubes.length ? r.tubes.map((x) => dayTag(x, '')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    const renderLab = (r) => (r.lab ? `<a class="tag new" href="${esc(labPageUrl(r.p))}" target="_blank" rel="noopener" title="開啟這位病人的檢驗報告頁（近兩週）">新報告 ${esc(fmt(r.lab.ms))} ↗</a>` : '<span class="muted">—</span>');
    function renderPacs(r) {
        if (r.pending.has('pacs')) return PENDING_HTML;
        if (!r.pacs.length) return '<span class="muted">—</span>';
        return r.pacs.map((x) => {
            const tag = `<span class="tag new">${esc(x.date)} ${esc(x.title)}</span>`;
            return x.report ? `<details class="pc"><summary>${tag}</summary><div class="rep">${esc(x.report)}</div></details>` : `<div>${tag}</div>`;
        }).join('');
    }
    // 每張卡的快速連結（新分頁）。只用「SESSION＋AccountIDSE（或 ChartNo）」就能開的頁面（依 progress-note-data-helper
    // 現有網址）；SESSION 只放在 href，不顯示、不存。不放藥歷圖／PACS（需要 PersonID）與管路頁
    // （CatheterCare 的「目前病人」是伺服器端狀態，同時開兩位病人的頁面再操作，可能看到別人的資料）。
    function pageUrls(p) {
        const ses = encodeURIComponent(pageSession());
        const acct = encodeURIComponent(p.caseno);
        const base = location.origin + '/WebApplication/InPatient/';
        return {
            lab: labPageUrl(p),
            vitals: `${base}Nursing/VitalSign_TPR.aspx?session=${ses}&AccountIDSE=${acct}`,
            nursing: `${base}Nursing/NursingProgressNote.aspx?SESSION=${ses}&AccountIDSE=${acct}`,
            handover: `${base}Ward/OffDutyNurV2.aspx?SESSION=${ses}&InQuerySortMode=QByEmp&AccountIDSE=${acct}&Type=Nur`,
            rx: `${base}Ward/MedicationV2.aspx?SESSION=${ses}&PatClass=I&AccountIDSE=${acct}&Hosp=T0&Seed=&EMRPop=Y`,
        };
    }
    // 標題列只放護理紀錄、交班；檢驗、生命徵象圖、處方的連結分別放在各自區塊的標題裡（見 cardShell）
    function renderLinks(r) {
        const u = pageUrls(r.p);
        return [['護理紀錄', u.nursing], ['交班', u.handover]]
            .map(([t, url]) => `<a class="tag" href="${esc(url)}" target="_blank" rel="noopener">${t} ↗</a>`).join('');
    }
    const titleLink = (text, url) => `<a href="${esc(url)}" target="_blank" rel="noopener" title="開啟${esc(text)}頁（新分頁）">${esc(text)} ↗</a>`;
    const renderCharts = (r, win) => (r.pending.has('vitals') ? '<div class="muted nov">生命徵象圖：抓取中…</div>' : chartsHtml(r, win));

    function cardShell(i, r, win) {
        const p = r.p;
        const u = pageUrls(p);
        return `<section class="card">
<div class="hd"><b>${esc(p.bed)}</b> ${esc(p.name)} <small class="muted">${esc(p.chartNo)} · ${esc(p.sex)} ${esc(p.age)}${p.hospDay ? ' · 住院 ' + esc(p.hospDay) + ' 天' : ''}</small> <span class="lk">${renderLinks(r)}</span></div>
<div id="c${i}-vit">${renderVit(r, win)}</div>
<div id="c${i}-err">${renderErr(r)}</div>
<div class="kv"><span class="k">${titleLink('抗生素', u.rx)}</span><div id="c${i}-abx">${renderAbx(r)}</div></div>
<div class="kv"><span class="k">管路</span><div id="c${i}-tubes">${renderTubes(r)}</div></div>
<div class="kv"><span class="k">${titleLink('檢驗', u.lab)}</span><div id="c${i}-lab">${renderLab(r)}</div></div>
<div class="kv"><span class="k">影像</span><div id="c${i}-pacs">${renderPacs(r)}</div></div>
<div class="mt ct">${titleLink('生命徵象', u.vitals)}</div>
<div id="c${i}-charts">${renderCharts(r, win)}</div></section>`;
    }

    // 某個來源回來 → 只更新卡片上對應的格子（不重畫整張卡，使用者展開的影像報告／收合的圖表不會被重設）
    function applyUpdate(w, i, src, r, win) {
        if (!w || w.closed) return;
        const set = (id, html) => { const el = w.document.getElementById(`c${i}-${id}`); if (el) el.innerHTML = html; };
        if (src === 'vitals') { set('vit', renderVit(r, win)); set('charts', renderCharts(r, win)); }
        if (src === 'pacs') set('pacs', renderPacs(r));
        if (src === 'abx') set('abx', renderAbx(r));
        if (src === 'tubes') set('tubes', renderTubes(r));
        set('err', renderErr(r));
    }
    const setText = (w, id, text) => { if (w && !w.closed) { const el = w.document.getElementById(id); if (el) el.textContent = text; } };

    // 頁面骨架：先把所有病人的空卡片（已知的床號、姓名、檢驗時間先填好）一次畫出來
    function pageShell(states, win, scope) {
        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>晨間簡報 ${esc(fmt(win.toMs))}</title>
<style>
:root{--bg:#fff;--fg:#1c1f23;--mut:#6b7280;--line:#e5e7eb;--md:#ffedd5;--new:#dbeafe}
@media (prefers-color-scheme:dark){:root{--bg:#14171a;--fg:#e6e8ea;--mut:#9aa1a9;--line:#2a2f35;--md:#4a2c12;--new:#172a45}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,"Noto Sans TC",sans-serif}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:12px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:12px;color:var(--mut)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:0 4px 2px 0;font-size:12px}.tag.new{background:var(--new)}.tag.warn{background:var(--md);border-color:#fdba74}a.tag{color:inherit;text-decoration:none}a.tag:hover{text-decoration:underline}
.muted{color:var(--mut)}small{font-size:12px}.err{color:#b91c1c;margin-top:4px;font-size:12px}.rep{font-size:12px;color:var(--mut);}.nov{font-size:12px;margin-top:2px}
:root{--series:#2a78d6;--serious:#ec835a;--critical:#d03b3b;--surf:#fff;--grid:#e1e0d9;--axis:#c3c2b7;--tk:#898781;--ok:rgba(137,135,129,.14);--bmed:rgba(250,178,25,.16);--bhigh:rgba(208,59,59,.14)}
@media (prefers-color-scheme:dark){:root{--series:#3987e5;--surf:#14171a;--grid:#2c2c2a;--axis:#383835;--ok:rgba(137,135,129,.18);--bmed:rgba(250,178,25,.18);--bhigh:rgba(208,59,59,.22)}}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}
@media (max-width:1000px){.grid{grid-template-columns:1fr}}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}
.hd{font-size:15px;margin-bottom:2px}.hd .lk{margin-left:6px}.hd .lk .tag{margin:0 3px 0 0}
.kv{display:flex;gap:8px;margin-top:2px}.kv .k{flex:none;width:4.8em;font-size:12px;color:var(--mut)}
.k a,.mt a{color:inherit;text-decoration:none}.k a:hover,.mt a:hover{text-decoration:underline}
.pc>summary{cursor:pointer;list-style:none}.pc>summary::-webkit-details-marker{display:none}.pc>summary::before{content:'▸ ';color:var(--mut)}.pc[open]>summary::before{content:'▾ '}.pc .rep{margin:2px 0 4px 14px;white-space:pre-wrap}
.charts{margin-top:2px}
.mt{font-size:12px;color:var(--mut);margin:2px 0}.tv{margin-top:6px;font-size:12px}.tv table{width:auto}.tv th,.tv td{padding:2px 10px 2px 0}.tv summary{cursor:pointer;color:var(--mut)}
svg.hsvg{max-width:100%;height:auto;display:block;margin:2px 0 8px}
svg.hsvg .ax{cursor:pointer}svg.hsvg .ax text{stroke-width:.35;font-size:13px}svg.hsvg .ax line,svg.hsvg .ser line{stroke-width:1}
svg.hsvg .ax.off{fill:lightgray!important;stroke:lightgray!important}svg.hsvg .ser.off{visibility:hidden}
svg.hsvg .ser circle{stroke:none}svg.hsvg .ser text.na{font-size:12px;stroke-width:.4}
svg.hsvg .hit{fill:transparent;stroke:none}svg.hsvg .hitl{stroke:transparent;stroke-width:12}
@media print{body{padding:0;font-size:11px}.card{break-inside:avoid}}
</style></head><body>
<h1>晨間簡報</h1>
<div class="sub">時間窗 ${esc(fmt(win.fromMs))} → ${esc(fmt(win.toMs))}${win.daysBack > 1 ? '（週一，回溯至週五）' : ''} · 圖表參考資料自 ${esc(fmt(win.refFromMs))} 起 · 範圍：${esc(scope)} · 共 ${states.length} 人（依病房列表順序） · <span id="prog">載入中 0/${states.length}</span></div>
<div class="grid">${states.map((r, i) => cardShell(i, r, win)).join('')}</div>
<script>(${pageScript.toString()})();<\/script></body></html>`;
    }

    // ═══════════════════════════════════════════════════════════
    // 進入點
    // ═══════════════════════════════════════════════════════════

    async function run(btn) {
        // 病房列表本來就只帶出登入者的病人，不再另外篩選
        const mine = readPatients();
        if (!mine.length) { alert('找不到病人清單'); return; }

        // 必須在「使用者點擊」的同一個動作裡先開分頁，否則抓完才開會被瀏覽器的彈出視窗封鎖擋下
        const w = window.open('', '_blank');
        if (!w) { alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。'); return; }

        const win = briefingWindow(START_HOUR);
        const now = nowMs();
        const states = mine.map((p) => newResult(p, win, now));
        w.document.open();
        w.document.write(pageShell(states, win, '目前病房列表'));
        w.document.close();

        const label = btn.textContent;
        const idleBg = btn.style.background;
        // 執行中：換色＋等待游標＋顯示進度，避免使用者以為當掉
        btn.disabled = true;
        btn.style.background = '#d97706';
        btn.style.cursor = 'wait';
        const setProg = (phase, done) => {
            const t = `${phase} ${done}/${mine.length}`;
            btn.textContent = `⏳ ${t}`;
            setText(w, 'prog', `載入中：${t}`);
        };
        // 程式錯誤的保險（正常情況 assess 不會丟出，來源失敗都記在 res.errors）
        const markFailed = (r, i, e) => {
            r.errors.push('判讀失敗：' + (e && e.message || e));
            r.pending.clear();
            for (const src of ['vitals', 'pacs', 'abx', 'tubes']) applyUpdate(w, i, src, r, win);
        };
        const wall0 = nowMs();
        try {
            // 階段一（輕）：所有病人的 vitals＋影像一起發，實際同時數由 lib 限制；畫面上生命徵象圖與影像先出現
            let d1 = 0;
            setProg('生命徵象與影像', 0);
            await Promise.all(states.map(async (r, i) => {
                try { await assessLight(r, win, (src, rr) => applyUpdate(w, i, src, rr, win)); } catch (e) { markFailed(r, i, e); }
                setProg('生命徵象與影像', ++d1);
            }));

            // 階段二（重）：抗生素＋管路，依病人順序、一次 HEAVY_POOL 位；卡片會由上而下依序補完
            let d2 = 0, next = 0;
            setProg('抗生素與管路', 0);
            const worker = async () => {
                while (next < states.length) {
                    const i = next++;
                    const r = states[i];
                    try { await assessHeavy(r, now, (src, rr) => applyUpdate(w, i, src, rr, win)); } catch (e) { markFailed(r, i, e); }
                    setProg('抗生素與管路', ++d2);
                }
            };
            await Promise.all(Array.from({ length: Math.min(HEAVY_POOL, states.length) }, worker));
        } finally {
            btn.disabled = false;
            btn.style.background = idleBg;
            btn.style.cursor = 'pointer';
            btn.textContent = label;
        }

        setText(w, 'prog', `完成（${((nowMs() - wall0) / 1000).toFixed(1)} 秒）`);
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
        wrap.append(btn);
        document.body.appendChild(wrap);
    }

    mount();
}());
