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
        if (g !== null) parts.Consciousness = scoreConsciousness(g < 15); else missing.push('Consciousness');

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

    // 由 SpO2 括號內字串判斷是否給氧。格式 "28%,5L,Mask"（FiO2,流量,裝置），空 = room air
    function isOnOxygen(inside) {
        const s = String(inside || '').trim();
        if (!s) return false;
        if (/room\s*air/i.test(s)) return false;
        return /cannula|mask|nasal|\bNC\b|hfnc|niv|bipap|cpap|vent|ventilator|trach|t-?piece|\d+\s*L/i.test(s)
            || /\d/.test(s); // 有 FiO2 或流量數字也視為給氧
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
            const dt = dtm[0];
            const ms = toMs(dt);
            let m;
            if ((m = t.match(/T:\s*([\d.]+)\s*P:\s*(\d+)\s*R:\s*(\d+)/i))) {
                singles.push({ dt, ms, kind: 'tpr', T: parseFloat(m[1]), P: +m[2], R: +m[3] });
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
            return { count: 0, worst: null, latest: latest && withScore(latest), flags: [], ranges: {}, noData: true };
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
