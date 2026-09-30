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


    // ─── 尿量（U/O）：院內的 U/O 列常常沒有日期（實測 "U/O:0"），含意（每班或每日）不明，
    //     所以有日期的取最新一筆，沒有日期的只當「院內未標日期」原樣呈現，不做任何推論。
    function parseUo(rowTexts) {
        let dated = null, undated = null;
        for (const raw of rowTexts) {
            const t = String(raw).replace(/\s+/g, ' ').trim();
            const m = t.match(/U\/?O:\s*(\d+)/i);
            if (!m) continue;
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
        parseVitalRows, parseUo, oxygenInfo, o2Change, summarizeWindow, overnightWindow,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.NTUHNews2 = api;
}(typeof window !== 'undefined' ? window : globalThis));
