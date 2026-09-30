// ==UserScript==
// @name         NTUH 晨間簡報
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0
// @description  病房列表一鍵產生「昨夜狀態」簡報（新分頁）：vitals 以 NEWS2 判讀昨夜最差值與異常、新檢驗報告、新影像報告；只列有異常或有新東西的病人
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2 */

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
    // 圖表（純 inline SVG，不依賴外部函式庫；醫院網路可能擋 CDN）
    // ═══════════════════════════════════════════════════════════
    // 設計：NEWS2 時間線 + 五張 vitals 小圖，時間軸一致、滑過任一張圖全部同步。
    // 標記：圓點 = 正常範圍內；菱形 + 狀態色 = 超出 NEWS 0 分範圍（形狀+顏色，不單靠顏色）；
    //       NEWS 空心點 = 有缺項、分數可能低估。

    const G = { l: 30, r: 10, t: 14, b: 20 };
    const NEWS_DIM = { w: 640, h: 140 };
    const MINI_DIM = { w: 204, h: 100 };

    // score：沿用 NEWS2 各參數計分，「超出範圍」= 該項分數 > 0，與 NEWS 判讀一致
    const PARAMS = [
        { key: 'T', title: '體溫 °C', y: [35, 40], ticks: [36, 37, 38, 39, 40], band: [36.1, 38.0], score: (v) => NTUHNews2.scoreTemp(v) },
        { key: 'P', title: '心跳 /min', y: [40, 140], ticks: [50, 90, 130], band: [51, 90], score: (v) => NTUHNews2.scoreHR(v) },
        { key: 'R', title: '呼吸 /min', y: [6, 30], ticks: [10, 20, 30], band: [12, 20], score: (v) => NTUHNews2.scoreRR(v) },
        { key: 'SBP', title: '收縮壓 mmHg', y: [70, 200], ticks: [90, 130, 170, 200], band: [111, 200], score: (v) => NTUHNews2.scoreSBP(v) },
        { key: 'SpO2', title: 'SpO₂ %', y: [86, 100], ticks: [88, 92, 96, 100], band: [96, 100], score: (v) => NTUHNews2.scoreSpO2(v) },
    ];

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

    // o: { dim, win, yr, yticks, bands:[{lo,hi,cls,label}], pts:[{ms,v,cls,hollow}], title, tag }
    function buildChart(o) {
        const w = o.dim.w, h = o.dim.h, iw = w - G.l - G.r, ih = h - G.t - G.b;
        const span = o.win.toMs - o.win.fromMs;
        const x = (ms) => +(G.l + ((ms - o.win.fromMs) / span) * iw).toFixed(1);
        const clamp = (v) => Math.min(o.yr[1], Math.max(o.yr[0], v));
        const y = (v) => +(G.t + (1 - (clamp(v) - o.yr[0]) / (o.yr[1] - o.yr[0])) * ih).toFixed(1);
        let s = `<svg class="ch" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(o.title)}" data-vw="${w}" data-l="${G.l}" data-w="${iw}">`;
        for (const b of o.bands || []) {
            if (b.hi <= o.yr[0] || b.lo >= o.yr[1]) continue;
            s += `<rect class="${b.cls}" x="${G.l}" y="${y(b.hi)}" width="${iw}" height="${+(y(b.lo) - y(b.hi)).toFixed(1)}"/>`;
            if (b.label) s += `<text class="band-lbl" x="${w - G.r - 3}" y="${+y(b.hi) + 10}" text-anchor="end">${esc(b.label)}</text>`;
        }
        for (const t of o.yticks) {
            s += `<line class="grid" x1="${G.l}" x2="${w - G.r}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${G.l - 5}" y="${+y(t) + 3}" text-anchor="end">${t}</text>`;
        }
        for (const t of timeTicks(o.win.fromMs, o.win.toMs)) {
            s += `<line class="grid v" x1="${x(t.ms)}" x2="${x(t.ms)}" y1="${G.t}" y2="${G.t + ih}"/><text class="tick" x="${x(t.ms)}" y="${h - 6}" text-anchor="middle">${esc(t.label)}</text>`;
        }
        s += `<line class="axis" x1="${G.l}" x2="${w - G.r}" y1="${G.t + ih}" y2="${G.t + ih}"/>`;
        if (o.pts.length > 1) s += `<polyline class="ln" points="${o.pts.map((p) => `${x(p.ms)},${y(p.v)}`).join(' ')}"/>`;
        for (const p of o.pts) {
            const cx = x(p.ms), cy = y(p.v);
            if (p.cls === 'flag-s' || p.cls === 'flag-c') s += `<path class="${p.cls}" d="M${cx} ${cy - 5.5}l5.5 5.5l-5.5 5.5l-5.5 -5.5z"/>`;
            else s += `<circle class="dot${p.hollow ? ' hollow' : ''}" cx="${cx}" cy="${cy}" r="4"/>`;
        }
        if (o.label) {
            const lx = x(o.label.ms), ly = y(o.label.v);
            const anchor = lx > w - G.r - 26 ? 'end' : lx < G.l + 20 ? 'start' : 'middle';
            const ty = ly < G.t + 14 ? ly + 16 : ly - 8;
            s += `<text class="lbl" x="${lx}" y="${+ty.toFixed(1)}" text-anchor="${anchor}">${esc(o.label.text)}</text>`;
        }
        s += `<line class="xh" y1="${G.t}" y2="${G.t + ih}" x1="0" x2="0" visibility="hidden"/></svg>`;
        return s;
    }

    function newsChart(series, win) {
        const maxT = Math.max(9, ...series.map((o) => o.news.total));
        const top = Math.ceil(maxT / 2) * 2 + 1;
        const worst = series.reduce((a, b) => (b.news.total >= a.news.total ? b : a), series[0]);
        return buildChart({
            dim: NEWS_DIM, win, yr: [0, top], yticks: [0, 3, 5, 7, 9].filter((t) => t <= top), title: 'NEWS2 時間線',
            bands: [
                { lo: 5, hi: 7, cls: 'bd-med', label: '5–6 中' },
                { lo: 7, hi: top, cls: 'bd-high', label: '≥7 高' },
            ],
            pts: series.map((o) => ({ ms: o.ms, v: o.news.total, hollow: o.news.partial })),
            label: { ms: worst.ms, v: worst.news.total, text: `最高 ${worst.news.total}` },
        });
    }

    function miniChart(param, series, win) {
        const vals = series.filter((o) => Number.isFinite(o[param.key])).map((o) => ({ ms: o.ms, v: o[param.key] }));
        if (!vals.length) return `<div class="mini"><div class="mt">${esc(param.title)}</div><div class="muted nodata">時間窗內無此項</div></div>`;
        const lo = Math.min(param.y[0], ...vals.map((p) => p.v) .map((v) => Math.floor(v - 1)));
        const hi = Math.max(param.y[1], ...vals.map((p) => p.v).map((v) => Math.ceil(v + 1)));
        const pts = vals.map((p) => {
            const sc = param.score(p.v);
            return { ms: p.ms, v: p.v, cls: sc >= 3 ? 'flag-c' : sc > 0 ? 'flag-s' : '' };
        });
        // 直接標示：有超出範圍就標最嚴重的那個點，否則標最後一筆
        const bad = pts.filter((p) => p.cls);
        const pick = bad.length ? bad.reduce((a, b) => (param.score(b.v) > param.score(a.v) ? b : a)) : pts[pts.length - 1];
        return `<div class="mini"><div class="mt">${esc(param.title)}</div>${buildChart({
            dim: MINI_DIM, win, yr: [lo, hi], yticks: param.ticks.filter((t) => t >= lo && t <= hi), title: param.title,
            bands: [{ lo: param.band[0], hi: param.band[1], cls: 'bd-ok' }],
            pts, label: { ms: pick.ms, v: pick.v, text: String(pick.v) },
        })}</div>`;
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
        const slim = series.map((o) => ({
            ms: o.ms, T: o.T, P: o.P, R: o.R, SBP: o.SBP, SpO2: o.SpO2, o2: !!o.onOxygen,
            n: o.news.total, lv: o.news.level, miss: o.news.missing,
        }));
        return `<div class="charts" data-view="hosp" data-from="${win.fromMs}" data-to="${win.toMs}" data-series="${esc(JSON.stringify(slim))}">
<div class="vbar"><span class="muted">圖表樣式</span><button class="btn-view on" data-view="hosp">院內樣式</button><button class="btn-view" data-view="split">分開顯示</button></div>
<div class="view view-hosp"><div class="hrow">
<div class="hcol hv"><div class="mt">生命徵象<span class="muted"> · 綠色帶為正常範圍（T 36–38、P 60–100、R 10–22、BP 50–150），粉紅為異常；點左側軸名稱可顯示／隱藏該項（血壓預設隱藏）</span></div>
${hospVitals(series, win)}</div>
<div class="hcol hn"><div class="mt">NEWS2（每次量測，等距排列）<span class="muted"> · 虛線圈 = 有缺項，分數可能低估</span></div>
${hospNews(series)}</div>
</div></div>
<div class="view view-split">
<div class="mt">NEWS2（每次量測）<span class="muted"> · 空心點 = 有缺項</span></div>${newsChart(series, win)}
<div class="minis">${PARAMS.map((p) => miniChart(p, series, win)).join('')}</div>
<div class="legend"><span class="k"><i class="sw ok"></i>NEWS 0 分範圍</span><span class="k"><i class="sw dot"></i>範圍內</span><span class="k"><i class="sw dia s"></i>超出（1–2 分）</span><span class="k"><i class="sw dia c"></i>超出（3 分）</span></div>
</div>
${dataTable(series)}</div>`;
    }

    // 頁面內互動（序列化後放進新分頁執行，不可引用外部變數）
    function pageScript() {
        const tip = document.createElement('div');
        tip.className = 'tip';
        tip.hidden = true;
        document.body.appendChild(tip);
        const two = (n) => String(n).padStart(2, '0');
        document.querySelectorAll('.btn-tg').forEach((b) => b.addEventListener('click', () => {
            const d = b.closest('tr').nextElementSibling;
            const open = d.classList.toggle('open');
            b.setAttribute('aria-expanded', String(open));
        }));
        document.querySelectorAll('.btn-view').forEach((b) => b.addEventListener('click', () => {
            const box = b.closest('.charts');
            box.setAttribute('data-view', b.getAttribute('data-view'));
            box.querySelectorAll('.btn-view').forEach((x) => x.classList.toggle('on', x === b));
        }));
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
        document.querySelectorAll('.charts').forEach((box) => {
            const data = JSON.parse(box.getAttribute('data-series'));
            const from = +box.getAttribute('data-from'), to = +box.getAttribute('data-to');
            const svgs = [...box.querySelectorAll('svg.ch')];
            const nearest = (f) => {
                const t = from + f * (to - from);
                let best = 0, bd = Infinity;
                data.forEach((d, i) => { const dd = Math.abs(d.ms - t); if (dd < bd) { bd = dd; best = i; } });
                return best;
            };
            const row = (name, val) => {
                const r = document.createElement('div');
                const v = document.createElement('b'); v.textContent = val;
                const n = document.createElement('span'); n.textContent = ' ' + name;
                r.append(v, n);
                return r;
            };
            const hide = () => { tip.hidden = true; svgs.forEach((s) => s.querySelector('.xh').setAttribute('visibility', 'hidden')); };
            svgs.forEach((svg) => {
                svg.addEventListener('pointermove', (ev) => {
                    const rc = svg.getBoundingClientRect();
                    const vw = +svg.getAttribute('data-vw');
                    const f = ((ev.clientX - rc.left) * (vw / rc.width) - +svg.getAttribute('data-l')) / +svg.getAttribute('data-w');
                    if (f < -0.02 || f > 1.02) return hide();
                    const d = data[nearest(Math.min(1, Math.max(0, f)))];
                    const ff = (d.ms - from) / (to - from);
                    svgs.forEach((s) => {
                        const x = +s.getAttribute('data-l') + ff * +s.getAttribute('data-w');
                        const l = s.querySelector('.xh');
                        l.setAttribute('x1', x); l.setAttribute('x2', x); l.setAttribute('visibility', 'visible');
                    });
                    const dt = new Date(d.ms);
                    tip.replaceChildren();
                    const head = document.createElement('div');
                    head.className = 'tip-h';
                    head.textContent = `${dt.getMonth() + 1}/${dt.getDate()} ${two(dt.getHours())}:${two(dt.getMinutes())}`;
                    tip.append(head, row('NEWS2' + (d.miss && d.miss.length ? '（缺 ' + d.miss.join('/') + '）' : ''), d.n));
                    const add = (name, v, u) => { if (v !== undefined && v !== null) tip.append(row(name, v + (u || ''))); };
                    add('體溫', d.T); add('心跳', d.P); add('呼吸', d.R); add('收縮壓', d.SBP);
                    add('SpO₂', d.SpO2, d.SpO2 !== undefined ? '%' + (d.o2 ? ' 給氧' : '') : '');
                    tip.hidden = false;
                    const tw = tip.offsetWidth;
                    tip.style.left = Math.min(ev.clientX + 14, window.innerWidth - tw - 8) + 'px';
                    tip.style.top = (ev.clientY + 14) + 'px';
                });
                svg.addEventListener('pointerleave', hide);
            });
        });
    }

    const LEVEL_LABEL = { high: '高', medium: '中', 'low-medium': '單項紅', low: '低', none: '—' };

    function rangeText(r, unit = '') {
        if (!r) return '—';
        return r.min === r.max ? `${r.min}${unit}` : `${r.min}–${r.max}${unit}`;
    }

    function rowHtml(r, win) {
        const p = r.p, s = r.vitals, n = r.news;
        const lvl = n ? n.level : 'none';
        const v = s && !s.noData ? `T ${rangeText(s.ranges.T)} · HR ${rangeText(s.ranges.P)} · RR ${rangeText(s.ranges.R)}<br>SBP ${rangeText(s.ranges.SBP)} · SpO₂ ${rangeText(s.ranges.SpO2, '%')}${r.onO2 ? ' · 給氧' : ''}` : '<span class="muted">' + (s ? '時間窗內無量測' : '—') + '</span>';
        const news = n ? `<b>${n.total}</b> <small>${LEVEL_LABEL[lvl]}${n.partial ? ' · 缺 ' + esc(n.missing.join('/')) : ''}</small>` : '<span class="muted">—</span>';
        const flags = r.flags.map((f) => `<span class="tag">${esc(f)}</span>`).join('') || '<span class="muted">—</span>';
        const lab = r.lab ? `<span class="tag new">新報告 ${esc(fmt(r.lab.ms))}</span>` : '<span class="muted">—</span>';
        const pacs = r.pacs.length ? r.pacs.map((x) => `<div><span class="tag new">${esc(x.date)} ${esc(x.title)}</span>${x.report ? `<div class="rep">${esc(x.report)}</div>` : ''}</div>`).join('') : '<span class="muted">—</span>';
        const err = r.errors.length ? `<div class="err">⚠ ${esc(r.errors.join('；'))}（此病人結果不完整，請手動確認）</div>` : '';
        const hisEws = Number.isFinite(p.hisEws) ? p.hisEws : '—';
        const charts = chartsHtml(r, win);
        const openByDefault = charts && (r.severity > 0 || r.flags.length > 0);
        const toggle = charts ? `<br><button class="btn-tg" aria-expanded="${openByDefault ? 'true' : 'false'}">圖表</button>` : '';
        const main = `<tr class="lv-${lvl}">
<td><b>${esc(p.bed)}</b>${toggle}</td>
<td>${esc(p.name)}<br><small class="muted">${esc(p.chartNo)} · ${esc(p.sex)} ${esc(p.age)}</small></td>
<td class="c">${hisEws}</td><td class="c">${news}</td>
<td>${flags}${err}</td><td>${v}</td><td>${lab}</td><td>${pacs}</td></tr>`;
        return charts ? `${main}<tr class="detail${openByDefault ? ' open' : ''}"><td colspan="8">${charts}</td></tr>` : main;
    }

    function buildHtml(results, win, meta) {
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
th{position:sticky;top:0;background:var(--bg);font-size:12px;color:var(--mut)}.c{text-align:center}
.lv-high td{background:var(--hi)}.lv-medium td{background:var(--md)}.lv-low-medium td{background:var(--lm)}
.tag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 6px;margin:0 4px 2px 0;font-size:12px}.tag.new{background:var(--new)}
.muted{color:var(--mut)}small{font-size:12px}.err{color:#b91c1c;margin-top:4px;font-size:12px}.rep{font-size:12px;color:var(--mut);max-width:320px}
.box{margin-top:16px;padding:10px 12px;border:1px solid var(--line);border-radius:6px}.box h2{font-size:14px;margin:0 0 4px}
.note{margin-top:16px;font-size:12px;color:var(--mut)}
@media print{body{padding:0;font-size:11px}th{position:static}}
:root{--series:#2a78d6;--serious:#ec835a;--critical:#d03b3b;--surf:#fff;--grid:#e1e0d9;--axis:#c3c2b7;--tk:#898781;--ok:rgba(137,135,129,.14);--bmed:rgba(250,178,25,.16);--bhigh:rgba(208,59,59,.14)}
@media (prefers-color-scheme:dark){:root{--series:#3987e5;--surf:#14171a;--grid:#2c2c2a;--axis:#383835;--ok:rgba(137,135,129,.18);--bmed:rgba(250,178,25,.18);--bhigh:rgba(208,59,59,.22)}}
.detail{display:none}.detail.open{display:table-row}.detail>td{background:transparent!important;padding:8px 8px 14px}
.btn-tg{margin-top:4px;font-size:12px;padding:1px 8px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);cursor:pointer}
.btn-tg[aria-expanded=true]{background:var(--new)}
.mt{font-size:12px;color:var(--mut);margin:2px 0}.minis{display:flex;flex-wrap:wrap;gap:6px 10px;margin-top:6px}.mini{min-width:0}.nodata{width:204px;padding:30px 0;text-align:center}
svg.ch{max-width:100%;height:auto;display:block;touch-action:pan-y}
svg.ch .grid{stroke:var(--grid);stroke-width:1}svg.ch .grid.v{stroke-opacity:.6}svg.ch .axis{stroke:var(--axis);stroke-width:1}
svg.ch .tick{fill:var(--tk);font-size:10px}svg.ch .lbl{fill:var(--fg);font-size:11px;font-weight:600}svg.ch .band-lbl{fill:var(--mut);font-size:10px}
svg.ch .bd-ok{fill:var(--ok)}svg.ch .bd-med{fill:var(--bmed)}svg.ch .bd-high{fill:var(--bhigh)}
svg.ch .ln{fill:none;stroke:var(--series);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
svg.ch .dot{fill:var(--series);stroke:var(--surf);stroke-width:2}svg.ch .dot.hollow{fill:var(--surf);stroke:var(--series);stroke-width:2}
svg.ch .flag-s{fill:var(--serious);stroke:var(--surf);stroke-width:2}svg.ch .flag-c{fill:var(--critical);stroke:var(--surf);stroke-width:2}
svg.ch .xh{stroke:var(--mut);stroke-width:1;pointer-events:none}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin-top:6px}.k{display:inline-flex;align-items:center;gap:5px}
.sw{display:inline-block;width:12px;height:12px}.sw.ok{background:var(--ok);border:1px solid var(--grid)}.sw.dot{border-radius:50%;background:var(--series);width:9px;height:9px}
.sw.dia{transform:rotate(45deg) scale(.7)}.sw.dia.s{background:var(--serious)}.sw.dia.c{background:var(--critical)}
.tv{margin-top:6px;font-size:12px}.tv table{width:auto}.tv th,.tv td{padding:2px 10px 2px 0}.tv summary{cursor:pointer;color:var(--mut)}
.tip{position:fixed;z-index:9;pointer-events:none;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.tip b{font-size:13px}.tip span{color:var(--mut)}.tip-h{color:var(--mut);margin-bottom:2px}
.charts[data-view=hosp] .view-split,.charts[data-view=split] .view-hosp{display:none}
.vbar{display:flex;gap:6px;align-items:center;font-size:12px;margin:2px 0 6px}
.btn-view{font-size:12px;padding:1px 10px;border:1px solid var(--line);border-radius:10px;background:transparent;color:var(--fg);cursor:pointer}
.btn-view.on{background:var(--new)}
svg.hsvg{max-width:100%;height:auto;display:block;margin:2px 0 8px}
.hrow{display:flex;gap:12px;align-items:flex-start}
.hcol{min-width:0}.hcol.hv{flex:990 1 0}.hcol.hn{flex:640 1 0}
.hrow svg.hsvg{width:100%}.hcol.hv svg.hsvg{max-width:990px}.hcol.hn svg.hsvg{max-width:640px}
@media (max-width:1000px){.hrow{flex-wrap:wrap}.hcol.hv,.hcol.hn{flex:1 1 100%}}
svg.hsvg .ax{cursor:pointer}svg.hsvg .ax text{stroke-width:.35;font-size:13px}svg.hsvg .ax line,svg.hsvg .ser line{stroke-width:1}
svg.hsvg .ax.off{fill:lightgray!important;stroke:lightgray!important}svg.hsvg .ser.off{visibility:hidden}
svg.hsvg .ser circle{stroke:none}svg.hsvg .ser text.na{font-size:12px;stroke-width:.4}
svg.hsvg .hit{fill:transparent;stroke:none}svg.hsvg .hitl{stroke:transparent;stroke-width:12}
@media print{.detail{display:table-row}.btn-tg,.vbar{display:none}}
</style></head><body>
<h1>晨間簡報</h1>
<div class="sub">時間窗 ${esc(fmt(win.fromMs))} → ${esc(fmt(win.toMs))}${win.daysBack > 1 ? '（週一，回溯至週五）' : ''} · 範圍：${esc(meta.scope)} · 共 ${results.length} 人，需注意 ${attention.length} 人</div>
${attention.length ? `<table><thead><tr><th>床</th><th>病人</th><th class="c">院內<br>EWS</th><th class="c">昨夜最高<br>NEWS2</th><th>異常</th><th>Vitals 範圍</th><th>檢驗</th><th>影像</th></tr></thead><tbody>${attention.map((r) => rowHtml(r, win)).join('')}</tbody></table>` : '<p>沒有需要注意的病人。</p>'}
<div class="box"><h2>時間窗內沒有 vitals 量測（${noData.length}）</h2>${names(noData)}<div class="muted">「沒量」不等於「正常」，請視需要確認。</div></div>
<div class="box"><h2>無異常、無新報告（${stable.length}）</h2>${names(stable)}</div>
<div class="note">NEWS2 為 Scale 1；缺量項目不補零，標示於「缺」。第一版尚未納入護理紀錄／交班／照會 note，也未逐人調整基線（例如 COPD）。判讀僅供快速瀏覽，不取代臨床評估。資料僅存在本頁，不上傳。</div>
<script>(${pageScript.toString()})();<\/script></body></html>`;
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
