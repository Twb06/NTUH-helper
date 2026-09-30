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
