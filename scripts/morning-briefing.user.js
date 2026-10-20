// ==UserScript==
// @name         NTUH 晨間簡報
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.9.2
// @description  病房列表一鍵產生「昨夜狀態」簡報（新分頁）：生命徵象圖、給氧／尿量變化、新檢驗報告、新影像報告、昨夜醫囑變更；依列表順序列出所有病人，一行並排兩人
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-fetch.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/lab-rules.js
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2, NTUHFetch, NTUHLab */

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

    // ─── 共用 lib 的別名（lib/ntuh-fetch.js、lib/lab-rules.js；查房單共用同一份）────────
    // pageSession：SESSION 只放進連結的 href 與請求網址，不顯示、不存。
    // pageGate：管路與醫囑簽收頁共用、一律一次一位（原因見 lib 的 fetchTubes 註解；醫囑簽收頁也是帶 AccountIDSE 的病人頁面，
    // 可能同樣改到伺服器端的「目前病人」，不能插進管路的頁面→handler 之間）。
    const { pageSession, personIdFromPatientList, pageGate, fetchAbx, fetchTubes } = NTUHFetch;
    const { LAB_DC_RANGE, LAB_GROUPS, LAB_GROUP_OF, LAB_NONBLOOD_CAT_RE, parseLabList } = NTUHLab;
    // 影像報告：卡片只顯示壓成一行、前 1500 字，順序照頁面
    const parsePacs = (html, fromMs) => NTUHFetch.parsePacs(html, fromMs)
        .map(({ date, title, report }) => ({ date, title, report: report.replace(/\s+/g, ' ').slice(0, 1500) }));
    // ─── 共用 lib 別名結束

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

    async function fetchLab(p, win) {
        const pid = personIdFromPatientList(document.cookie, p.caseno);
        const html = await NTUHAsmx.outerData('lab', { context: { ...ctxOf(p), PersonId: pid }, timeoutMs: OUTER_TIMEOUT_MS });
        if (!html) return { items: [], skipped: 0, hidden: 0, empty: true };
        return parseLabList(html, win.refFromMs, '晨間簡報');
    }

    // ─── 醫囑變更（Nursing/WorkList_OrderCheck.aspx，醫囑簽收頁）──────────
    // 網址參數 SESSION、PatClass=I、AccountIDSE、PersonID、Hosp=T0、Seed、EMRPop=Y（使用者提供的樣本，2026-10-14）；
    // Seed 樣本有值、這裡留空（其他頁面留空皆可，此頁未實測）。PersonID 從病房 Cookie 取（只在記憶體內）。
    // 頁面上方有「未簽收／已簽收／全部」三選一（rbl_SignStatus = N／Y／A），預設不是「全部」：
    // 只讀預設畫面會漏掉另一種狀態的醫囑（例如護理師還沒簽收的夜間醫囑）。所以 GET 後若不是「全部」，
    // 就照頁面點選項的方式送一次 postback（__EVENTTARGET = 該選項），切到「全部」（僅含一個月內資料）再解析。
    // 表格 gv_OrderList：每列 <tr title="開立日：MM/DD HH:MM\n簽收日：yyyy/M/d 下午 hh:mm:ss\n紀錄日：…">，
    // 欄位依表頭文字對應（類別、狀態、起日、迄日、醫令名稱…），不寫死欄序：未簽收的列可能多一欄勾選框。
    // 只列「開立日」落在昨夜時間窗（前一日 START_HOUR 起）的醫囑。ReNew（定期續開）沿用原醫囑的開立日，自然不會列入。
    const orderCheckUrl = (p, personId) => location.origin + '/WebApplication/InPatient/Nursing/WorkList_OrderCheck.aspx'
        + `?SESSION=${encodeURIComponent(pageSession())}&PatClass=I&AccountIDSE=${encodeURIComponent(p.caseno)}`
        + `&PersonID=${encodeURIComponent(personId)}&Hosp=T0&Seed=&EMRPop=Y`;
    
    const orderStatusChecked = (doc) => {
        const el = doc.querySelector('input[type="radio"][name$="rbl_SignStatus"]:checked');
        return el ? el.value : '';
    };

    // 切到「全部」的 postback 內容：保留隱藏欄位與文字欄（含 VIEWSTATE），不帶任何按鈕（尤其「確認簽收時間」）與勾選框
    function orderCheckAllBody(doc, pageUrl) {
        const form = doc.querySelector('form');
        const all = doc.querySelector('input[type="radio"][name$="rbl_SignStatus"][value="A"]');
        if (!form || !all || !form.querySelector('input[name="__VIEWSTATE"]')) throw new Error('醫囑簽收頁讀不到「全部」選項');
        const body = new URLSearchParams();
        for (const el of form.querySelectorAll('input')) {
            if (!el.name || el.disabled || ['submit', 'button', 'image', 'checkbox', 'radio'].includes(el.type)) continue;
            body.append(el.name, el.value);
        }
        // 頁面上的 onclick：__doPostBack('NTUHWeb1$rbl_SignStatus$2','')＝選項的 name 加上 $序號（序號取 id 結尾數字）。
        // 不能把 id 的底線全換成 $：控制項名稱 rbl_SignStatus 本身就有底線
        const idx = (all.id.match(/_(\d+)$/) || [])[1];
        if (idx === undefined) throw new Error('醫囑簽收頁「全部」選項格式改變');
        body.set('__EVENTTARGET', `${all.name}$${idx}`);
        body.set('__EVENTARGUMENT', '');
        body.set(all.name, all.value);
        // form action 是相對路徑（./WorkList_OrderCheck.aspx?…），以回應網址為基準
        return { body, action: new URL(form.getAttribute('action') || '', pageUrl).href };
    }

    function parseOrderCheck(html, fromMs, now) {
        const doc = NTUHAsmx.parseHtml(html);
        const table = doc.querySelector('[id$="gv_OrderList"]');
        if (!table) {
            if (!doc.querySelector('input[name="__VIEWSTATE"]')) throw new Error('醫囑簽收頁讀不到（可能需要重新登入）');
            // 沒有醫囑的病人可能整張表不輸出；風險：若院方改版導致表格不見，每位病人都會顯示「—」，在 Console 留紀錄
            console.warn('[晨間簡報] 醫囑簽收頁沒有 gv_OrderList，視為沒有醫囑（HTML 長度 ' + html.length + '）');
            return { items: [], skipped: 0, paged: false };
        }
        const headRow = table.querySelector('thead tr') || table.rows[0];
        const heads = [...headRow.cells].map((c) => txt(c).replace(/\s+/g, ''));
        const col = (name) => heads.indexOf(name);
        const iType = col('類別'), iAct = col('狀態'), iStart = col('起日'), iEnd = col('迄日'), iName = col('醫令名稱');
        if ([iAct, iStart, iName].some((i) => i < 0)) throw new Error('醫囑簽收頁欄位格式改變');
        const items = [];
        let skipped = 0;
        for (const tr of table.querySelectorAll('tbody tr')) {
            if (tr === headRow || tr.querySelector('th')) continue;
            const c = tr.cells;
            const title = tr.getAttribute('title') || '';
            const om = title.match(/開立日\s*[:：]\s*(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
            if (!om || c.length !== heads.length) { skipped += 1; continue; }   // 不能靜默丟掉：回報有幾列沒顯示
            // 開立日沒有年份：用簽收日的年份；開立月份比簽收月份大＝跨年（12 月開、1 月簽）。沒有簽收日就用今年，不能落在未來
            const sm = title.match(/簽收日\s*[:：]\s*(\d{4})\/(\d{1,2})/);
            let year = sm ? +sm[1] - (+om[1] > +sm[2] ? 1 : 0) : new Date(now).getFullYear();
            const at = (y) => new Date(y, +om[1] - 1, +om[2], +om[3], +om[4]).getTime();
            if (!sm && at(year) > now) year -= 1;
            const ms = at(year);
            if (ms < fromMs) continue;
            // <b>(Specimen:BLO)</b> 前面補空白；「計價別」之後不顯示
            const cell = c[iName].cloneNode(true);
            for (const b of cell.querySelectorAll('b')) b.before(' ');
            const content = txt(cell).replace(/\s*計價別\s*[:：].*$/, '');
            // 迄日：「長期」或空白不顯示；有日期時間（刪除列＝刪除時間）就接在起日後面，寫成「起～迄」
            const start = txt(c[iStart]);
            const em = iEnd >= 0 ? txt(c[iEnd]).match(/^(?:\d{4}\/)?(\d{1,2})\/(\d{1,2})\s+(\d{1,2}:\d{2})$/) : null;
            const when = em ? `${start}～${two(+em[1])}/${two(+em[2])} ${em[3]}` : start;
            items.push({ ms, type: iType >= 0 ? txt(c[iType]) : '', action: txt(c[iAct]), detail: [when, content].filter(Boolean).join(' ') });
        }
        // WebForms 表格若有分頁，只讀得到第一頁
        const paged = !!doc.querySelector('a[href*="Page$"]');
        return { items: items.sort((a, b) => a.ms - b.ms), skipped, paged };
    }

    async function fetchOrders(p, win, now) {
        const pid = personIdFromPatientList(document.cookie, p.caseno);
        return pageGate(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 30000);
            try {
                const opt = { credentials: 'same-origin', signal: ctrl.signal };
                const res = await fetch(orderCheckUrl(p, pid), opt);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                if (/login/i.test(new URL(res.url).pathname)) throw new Error('被導向登入頁');
                let html = await res.text();
                let doc = NTUHAsmx.parseHtml(html);
                if (orderStatusChecked(doc) !== 'A') {
                    const { body, action } = orderCheckAllBody(doc, res.url);
                    const post = await fetch(action, { ...opt, method: 'POST', body });
                    if (!post.ok) throw new Error('切換「全部」HTTP ' + post.status);
                    html = await post.text();
                    doc = NTUHAsmx.parseHtml(html);
                    if (orderStatusChecked(doc) !== 'A') throw new Error('醫囑簽收頁沒有切到「全部」');
                }
                // 防呆：頁面上的住院帳號要是這位病人
                const acct = txt(doc.querySelector('[id$="lbl_CaseNo"]')) || txt(doc.querySelector('[id$="lblCaseNo"]'));
                if (acct && acct !== p.caseno) throw new Error('醫囑簽收頁與病人不符，已丟棄');
                return parseOrderCheck(html, win.fromMs, now);
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // 每位病人的結果容器。pending＝還沒回來的來源；頁面會依 pending 顯示「抓取中…」
    function newResult(p, win, now) {
        const res = { p, errors: [], vitals: null, pacs: [], lab: null, abx: null, tubes: null, orders: null, pending: new Set(['vitals', 'pacs', 'abx', 'tubes']) };
        const labMs = labTimeMs(p.labTitle, now);
        // 檢驗、影像的納入起點與圖表／TPR 一致：前一日 REF_HOUR（08:00）起，避免漏掉白天的新報告
        if (labMs !== null && labMs >= win.refFromMs) res.lab = { ms: labMs };
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
            }),
            job('pacs', '影像', async () => {
                res.pacs = parsePacs(await NTUHAsmx.outerData('pacs', { context: ctx, timeoutMs: OUTER_TIMEOUT_MS }), win.refFromMs);
            }),
        ]);
    }

    // 階段二（重）：抗生素（藥歷 GET/POST）、管路（頁面＋handler，必須一次一位）。醫囑簽收頁改成點擊才載入（見 loadOrders），不在這裡
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

    const TIP_G = '<g class="tt" display="none" pointer-events="none"><rect fill="yellow" stroke="black" rx="2" ry="2"/><text x="5" y="18"><tspan class="t1" x="5" font-family="Arial" font-weight="bold" font-size="15"> </tspan><tspan class="t2" x="5" dy="1.2em" font-weight="bold" font-size="17" fill="blue"> </tspan></text></g>';

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
        s += TIP_G + '</svg>';
        return s;
    }

    // ─── SpO2 一行（放在生命徵象圖與數據表之間，時間軸與上方圖完全對齊）──────────────
    // 每次量測一個數字，顏色依 SpO2 高低（≥96／94–95／92–93／≤91；這是常用切點，不是 NEWS 計分）；
    // 給氧期間整段加藍底，開頭標裝置與流量（流量有變就標 2→3L）；未量測的時間留空。滑過數字顯示時間與給氧。
    function spo2Row(series, win) {
        const pts = series.filter((o) => Number.isFinite(o.SpO2));
        if (!pts.length) return '';
        const span = win.toMs - win.fromMs;
        const X = (ms) => +(HV.X0 + ((ms - win.fromMs) / span) * (HV.X1 - HV.X0)).toFixed(2);
        const W = HV.W, H = 46, Y0 = 3, Y1 = 29;
        const color = (v) => (v >= 96 ? '#27500A' : v >= 94 ? '#854F0B' : v >= 92 ? '#b4531a' : '#a32d2d');
        const o2Text = (o) => { const x = NTUHNews2.oxygenInfo(o.inside); return [x.device, x.flow !== null ? x.flow + 'L' : ''].filter(Boolean).join(' ') || '給氧'; };
        const half = 40; // 給氧底色往前後延伸的上限（px），避免跨過很長的未量測空檔
        let s = `<svg class="hsvg sp" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="SpO2">`;
        s += `<rect width="${W}" height="${H}" fill="#fffffd"/>`
            + `<text x="4" y="21" style="fill:#444;font-size:13px">SpO₂ %</text>`
            + `<rect x="${HV.X0}" y="${Y0}" width="${HV.X1 - HV.X0}" height="${Y1 - Y0}" rx="3" fill="#fffffd" stroke="#c3c2b7" stroke-width="1"/>`;
        // 給氧期間：連續的「給氧中」量測合成一段，底色從第一點往前半格到最後一點往後半格
        for (let i = 0; i < pts.length; i++) {
            if (!pts[i].onOxygen) continue;
            let j = i;
            while (j + 1 < pts.length && pts[j + 1].onOxygen) j++;
            const left = Math.max(HV.X0, i > 0 ? Math.max((X(pts[i - 1].ms) + X(pts[i].ms)) / 2, X(pts[i].ms) - half) : X(pts[i].ms) - half);
            const right = Math.min(HV.X1, j + 1 < pts.length ? Math.min((X(pts[j].ms) + X(pts[j + 1].ms)) / 2, X(pts[j].ms) + half) : X(pts[j].ms) + half);
            s += `<rect x="${left.toFixed(1)}" y="${Y0}" width="${Math.max(2, right - left).toFixed(1)}" height="${Y1 - Y0}" fill="#b5d4f4" opacity=".65"/>`;
            const f0 = NTUHNews2.oxygenInfo(pts[i].inside), f1 = NTUHNews2.oxygenInfo(pts[j].inside);
            const label = (f0.flow !== null && f1.flow !== null && f0.flow !== f1.flow)
                ? `${f0.device || '給氧'} ${f0.flow}→${f1.flow}L` : o2Text(pts[i]);
            s += `<text x="${(left + 3).toFixed(1)}" y="${H - 6}" style="fill:#185FA5;font-size:12px">${esc(label)}</text>`;
            i = j;
        }
        // 數字：與前一個太近（< 26px）就只畫小圓點，避免重疊；每個點都有可滑過的感應區
        let lastX = -1e9;
        for (const o of pts) {
            const x = X(o.ms), c = color(o.SpO2), bold = o.SpO2 <= 93 ? 700 : 500;
            if (x - lastX >= 26) { s += `<text x="${x}" y="21" text-anchor="middle" style="fill:${c};font-size:14px;font-weight:${bold}">${o.SpO2}</text>`; lastX = x; }
            else s += `<circle cx="${x}" cy="${(Y0 + Y1) / 2}" r="2.5" fill="${c}"/>`;
            s += `<circle class="hit" cx="${x}" cy="${(Y0 + Y1) / 2}" r="10" data-t="${esc(hm(o.ms))}" data-v="${o.SpO2}%${o.onOxygen ? '（' + esc(o2Text(o)) + '）' : '（室內空氣）'}"/>`;
        }
        return s + TIP_G + '</svg>';
    }

    function chartsHtml(r, win) {
        const series = r.chartSeries;
        if (!series || !series.length) return '';
        // 圖固定顯示（不收合）；標題「生命徵象 ↗」在卡片骨架（cardShell）裡，數據表仍可展開
        const axis = { fromMs: win.refFromMs, toMs: win.toMs };
        return `<div class="charts">${hospVitals(series, axis)}
${spo2Row(series, axis)}
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
    const dayTag = (x, cls) => `<span class="tag${cls}"${x.prescription ? ` title="${esc(x.prescription)}"` : ''}>${esc(x.name)}${x.route ? ' ' + esc(x.route) : ''} D${x.day}<small class="muted"> ${new Date(x.startMs).getMonth() + 1}/${new Date(x.startMs).getDate()} 起</small></span>`;

    function renderVit(r, win) {
        if (r.pending.has('vitals')) return '';
        const uo = r.uo ? `<div class="muted nov">尿量 ${r.uo.val} mL${r.uo.ms ? '（' + esc(fmt(r.uo.ms)) + '）' : '（院內未標日期）'}</div>` : '';
        const noVitals = r.vitals && r.vitals.noData
            ? `<div class="muted nov">${r.chartSeries && r.chartSeries.length ? '昨夜（' + esc(fmt(win.fromMs)) + ' 起）沒有 vitals 量測，圖上為前一日的參考資料' : '時間窗內沒有 vitals 量測（沒量不等於正常）'}</div>` : '';
        return uo + noVitals;   // 氧氣提示已由 SpO2 列取代（給氧底色與流量標示）
    }
    const renderErr = (r) => (r.errors.length ? `<div class="err">⚠ ${esc(r.errors.join('；'))}（此病人結果不完整，請手動確認）</div>` : '');
    const renderAbx = (r) => (r.pending.has('abx') ? PENDING_HTML : r.abx ? (r.abx.length ? r.abx.map((x) => dayTag(x, ' new')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    const renderTubes = (r) => (r.pending.has('tubes') ? PENDING_HTML : r.tubes ? (r.tubes.length ? r.tubes.map((x) => dayTag(x, '')).join('') : '<span class="muted">—</span>') : '<span class="muted">未取得</span>');
    // 醫囑變更（展開後才載入）：類型｜動作｜開立時間。「新增」不寫動作，其他動作（刪除…）寫在最前面，刪除用紅字
    function renderOrdersBody(d) {
        const warn = (d.skipped ? `<div class="err">⚠ 有 ${d.skipped} 列格式不符、沒有顯示（請手動確認）</div>` : '')
            + (d.paged ? '<div class="err">⚠ 醫囑簽收頁有分頁，只讀到第一頁（請手動確認）</div>' : '');
        if (!d.items.length) return `${warn}<span class="muted">—</span>`;
        const rows = d.items.map((x) => {
            const act = x.action === '新增' ? '' : `<b${x.action === '刪除' ? ' class="odel"' : ''}>${esc(x.action)}</b> `;
            return `<tr><td>${esc(x.type || '一般')}</td><td>${act}${esc(x.detail)}</td><td>${esc(fmt(x.ms))}</td></tr>`;
        }).join('');
        return `${warn}<table class="ot"><thead><tr><th>類型</th><th>動作</th><th>開立時間</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    // 新報告提示：只當提示（檢驗標題本身已是連結），藍底沿用「新」的樣式。資料來自病房列表「報」連結的 tooltip，
    // 是載入列表當下的快照（列表之後才出的報告看不到）。
    const labHint = (r) => (r.lab ? ` <span class="tag new" title="病房列表顯示的最新檢驗時間（載入列表當下的快照）">新報告 ${esc(fmt(r.lab.ms))}</span>` : '');
    function renderPacs(r) {
        if (r.pending.has('pacs')) return PENDING_HTML;
        if (!r.pacs.length) return '<span class="muted">—</span>';
        return r.pacs.map((x) => {
            const tag = `<span class="tag new">${esc(x.date)} ${esc(x.title)}</span>`;
            return x.report ? `<details class="pc"><summary>${tag}</summary><div class="rep">${esc(x.report)}</div></details>` : `<div>${tag}</div>`;
        }).join('');
    }
    // 每張卡的快速連結（新分頁）。只用「SESSION＋AccountIDSE（或 ChartNo）」就能開的頁面（依 progress-note-data-helper
    // 現有網址）；SESSION 只放在 href，不顯示、不存。藥歷圖／影像列表需要 PersonID，不在這裡組（影像在點擊時才組）。
    // 管路頁（CatheterCare）的「目前病人」是伺服器端狀態：同時開兩位病人的頁面再回去操作，可能看到（甚至寫入）別人的資料。
    // 所以管路連結：① 固定開在同一個具名分頁（target=ntuh-catheter，同一時間只會有一個管路分頁）；
    // ② 簡報還在載入時點它會先擋下（我們串行讀管路，插進一個頁面載入會互相干擾）。
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
            cath: `${base}Nursing/CatheterCare.aspx?session=${ses}&AccountIDSE=${acct}&PatClass=I`,
        };
    }
    // 標題列放病程、護理紀錄、交班；檢驗、生命徵象圖、處方的連結分別放在各自區塊的標題裡（見 cardShell）
    // 病程要 PersonID，所以和影像一樣在「點擊時」才組網址（data-prog 由 run() 裡的委派處理）。
    function renderLinks(r, i) {
        const u = pageUrls(r.p);
        const prog = `<a class="tag" href="#" data-prog="${i}" title="開啟病程頁（新分頁；點擊時才取得這位病人的識別）">病程 ↗</a>`;
        return prog + [['護理紀錄', u.nursing], ['交班', u.handover]]
            .map(([t, url]) => `<a class="tag" href="${esc(url)}" target="_blank" rel="noopener">${t} ↗</a>`).join('');
    }
    // 病程頁（Ward/InsertProgressNoteContent.aspx）：網址參數 SESSION、PatClass=I、AccountIDSE、PersonID、Hosp=T0、Seed、EMRPop=Y
    // （使用者提供的樣本，2026-10）。PersonID 從病房 Cookie 取（只在記憶體內）。Seed 樣本有值、這裡留空（未實測，
    // 其他頁面 Seed 留空皆可）。這頁網址本身就帶了病人識別（SESSION／AccountIDSE／PersonID），不像管路頁靠伺服器端
    // 「目前病人」，且 HIS 從列表按「程」也是每位病人開一個新視窗，所以每次開新分頁，不用具名分頁。
    function openProgressNote(w, p) {
        try {
            const pid = personIdFromPatientList(document.cookie, p.caseno);
            const url = location.origin + '/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx'
                + `?SESSION=${encodeURIComponent(pageSession())}&PatClass=I&AccountIDSE=${encodeURIComponent(p.caseno)}`
                + `&PersonID=${encodeURIComponent(pid)}&Hosp=T0&Seed=&EMRPop=Y`;
            const tab = w.open(url, '_blank');
            if (!tab) alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。');
        } catch (e) {
            alert('無法開啟病程頁：' + e.message + '。請改從病房列表按「程」進入。');
        }
    }
    // 影像標題連結：點擊時從病房 Cookie 取得 PersonID，再開影像列表。
    // 醫囑簽收頁：和病程一樣需要 PersonID，點擊時才組網址；網址本身帶病人識別，每次開新分頁
    function openOrderCheck(w, p) {
        try {
            const tab = w.open(orderCheckUrl(p, personIdFromPatientList(document.cookie, p.caseno)), '_blank');
            if (!tab) alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。');
        } catch (e) {
            alert('無法開啟醫囑簽收頁：' + e.message + '。請改從病人頁面進入。');
        }
    }
    function openPacsList(w, p) {
        try {
            const pid = personIdFromPatientList(document.cookie, p.caseno);
            // 帶 SESSION：不帶時新分頁會被要求登入（與檢驗頁同樣的現象；實測帶上後正常，機制未確認）。
            // SESSION 只放在 href，不顯示、不存。
            const ses = pageSession();
            const url = location.origin + '/WebApplication/ElectronicMedicalReportViewer/PACSImageShowList.aspx'
                + `?${ses ? 'SESSION=' + encodeURIComponent(ses) + '&' : ''}PersonID=${encodeURIComponent(pid)}&Seed=`;
            const tab = w.open(url, '_blank');
            if (!tab) alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。');
        } catch (e) {
            alert('無法開啟影像列表：' + e.message + '。請改從病人頁面進入。');
        }
    }

    // 檢驗數值下拉的內容（呈現比照 lab-summary 的「表格」）：依類別分組；日期為列（舊→新）、項目為欄，
    // 等寬對齊、缺值填「-」；一張表最多 8 欄，超過就再開一段（只列該段真的有值的日期）。
    // 數值很長（例如培養結果）不放進表格，獨立列在「文字結果」。單位放在欄名的 tooltip。
    const LAB_MAX_COLS = 8;
    // 一組項目 → 表格區塊（日期為列、項目為欄）。order：欄位順序；單位放欄名 tooltip
    function labTableHtml(list, order, md) {
        const cols = order.filter((n) => list.some((it) => it.item === n));
        const unit = {};
        for (const it of list) if (it.unit && !unit[it.item]) unit[it.item] = it.unit;
        const dates = [...new Set(list.map((it) => it.dateMs))].sort((x, y) => x - y);
        const cell = new Map();   // `${dateMs}|${item}` → 值（同一天同一項目有多筆就用 / 串起來）
        for (const it of list) { const k = `${it.dateMs}|${it.item}`; cell.set(k, cell.has(k) ? `${cell.get(k)} / ${it.value}` : it.value); }
        const blocks = [];
        for (let st = 0; st < cols.length; st += LAB_MAX_COLS) {
            const cs = cols.slice(st, st + LAB_MAX_COLS);
            const rows = dates.filter((ms) => cs.some((c) => cell.has(`${ms}|${c}`)));
            if (!rows.length) continue;
            blocks.push(`<table class="lt"><thead><tr><th></th>${cs.map((c) => `<th title="${esc(unit[c] || '')}">${esc(c)}</th>`).join('')}</tr></thead><tbody>${
                rows.map((ms) => `<tr><th>${md(ms)}</th>${cs.map((c) => `<td>${esc(cell.get(`${ms}|${c}`) || '-')}</td>`).join('')}</tr>`).join('')
            }</tbody></table>`);
        }
        return blocks.join('');
    }

    // 檢驗數值下拉的內容（呈現與過濾比照 lab-summary 的「表格」）：
    // 血液項目依臨床分組（Hemogram／DC／Liver／Renal／Electrolytes…，欄位順序固定、Seg／MCV／eGFR 附在主項目旁）；
    // 分不進去的（類別看起來是尿液／體液／氣體，或名稱不在表內）維持依 HIS 類別各一張表；DC 差別計數只有異常才列。
    // 數值很長（例如培養結果）不放進表格，獨立列在「文字結果」。
    function renderLabBody(d, win) {
        const md = (ms) => { const x = new Date(ms); return `${x.getMonth() + 1}/${x.getDate()}`; };
        if (d.empty) return '<span class="muted">伺服器沒有回傳檢驗資料。</span>';
        if (d.noTable) return '<span class="muted">近期沒有檢驗報告。<small>（頁面沒有檢驗表；若每位病人都是這樣，可能是院方改版）</small></span>';
        const warn = d.skipped ? `<div class="err">⚠ 有 ${d.skipped} 列格式不符、沒有顯示（請手動確認）</div>` : '';
        const range = Number.isFinite(d.minMs) ? `資料窗口 ${md(d.minMs)}–${md(d.maxMs)}` : '';
        if (!d.items.length) return `${warn}<span class="muted">${md(win.refFromMs)} 起沒有檢驗數值。${d.hidden ? `（另有 ${d.hidden} 筆依 lab-summary 規則略過）` : ''}${range}</span>`;
        const LONG = 28;
        const texts = d.items.filter((it) => it.value.length > LONG);
        const nums = d.items.filter((it) => it.value.length <= LONG);
        const catOf = (it) => (!it.category || it.category === 'Yes' ? '其他' : it.category);   // HIS 偶爾把類別填成 "Yes"，沒有意義
        const groups = new Map(), rest = new Map();
        for (const it of nums) {
            const g = LAB_NONBLOOD_CAT_RE.test(it.category) ? null : LAB_GROUP_OF[it.item];
            const bucket = g ? groups : rest, key = g || catOf(it);
            if (!bucket.has(key)) bucket.set(key, []);
            bucket.get(key).push(it);
        }
        // DC：正常範圍內不列（有任何一個值超出範圍才列整個項目）；罕見細胞沒有範圍，有就列
        if (groups.has('DC')) {
            const byItem = new Map();
            for (const it of groups.get('DC')) { if (!byItem.has(it.item)) byItem.set(it.item, []); byItem.get(it.item).push(it); }
            const keep = [];
            for (const [name, list] of byItem) {
                const r = LAB_DC_RANGE[name];
                const abnormal = !r || list.some((it) => { const v = parseFloat(it.value); return Number.isNaN(v) || v < r[0] || v > r[1]; });
                if (abnormal) keep.push(...list);
            }
            if (keep.length) groups.set('DC', keep); else groups.delete('DC');
        }
        const blocks = [];
        for (const [g, names] of LAB_GROUPS) if (groups.has(g)) blocks.push(`<div class="lbh">${esc(g)}</div>${labTableHtml(groups.get(g), names, md)}`);
        for (const [cat, list] of rest) blocks.push(`<div class="lbh">${esc(cat)}</div>${labTableHtml(list, [...new Set(list.map((it) => it.item))], md)}`);
        const textHtml = texts.length
            ? `<div class="lbh">文字結果</div>${texts.sort((x, y) => x.dateMs - y.dateMs).map((it) => `<div class="lbl"><span class="muted">${md(it.dateMs)}</span> <b>${esc(it.item)}</b> ${esc(it.value)}</div>`).join('')}` : '';
        // 不再附說明文字（無異常標記／略過筆數／資料窗口）：使用者要求移除；格式不符的警告（warn）仍保留
        return `${warn}${blocks.join('')}${textHtml}`;
    }

    // 第一次展開才為該病人載入；失敗可收合再展開重試
    async function loadLab(w, i, r, win) {
        const body = w.document.getElementById(`c${i}-labbody`);
        const sum = body && body.parentNode.querySelector('summary');
        r.labState = 'loading';
        if (body) body.innerHTML = '<span class="muted">載入中…</span>';
        try {
            const d = await fetchLab(r.p, win);
            if (w.closed) return;
            body.innerHTML = renderLabBody(d, win);
            const lbs = sum && sum.querySelector('.lbs');
            if (lbs) lbs.textContent = `檢驗數值（${d.items.length} 項）`;
            r.labState = 'done';
        } catch (e) {
            r.labState = 'error';
            if (!w.closed && body) body.innerHTML = `<div class="err">⚠ 檢驗數值抓取失敗：${esc(e.name === 'AbortError' ? '逾時' : e.message)}（收合再展開可重試）</div>`;
        }
    }

    // 醫囑：第一次展開才為該病人載入（醫囑簽收頁很重：頁面＋切「全部」postback，且要與管路共用 pageGate 一次一位，
    // 所以不放進簡報載入流程）；失敗可收合再展開重試。簡報還在載入時點開，會排在管路後面。
    async function loadOrders(w, i, r, win) {
        const body = w.document.getElementById(`c${i}-ordbody`);
        const sum = body && body.parentNode.querySelector('summary');
        r.ordState = 'loading';
        if (body) body.innerHTML = '<span class="muted">載入中…</span>';
        try {
            const d = await fetchOrders(r.p, win, nowMs());
            if (w.closed) return;
            r.orders = d;
            body.innerHTML = renderOrdersBody(d);
            const lbs = sum && sum.querySelector('.lbs');
            const del = d.items.filter((x) => x.action === '刪除').length;
            if (lbs) lbs.textContent = d.items.length ? `昨夜醫囑變更（${d.items.length} 筆${del ? `，刪除 ${del}` : ''}）` : '昨夜醫囑變更（沒有）';
            r.ordState = 'done';
        } catch (e) {
            r.ordState = 'error';
            if (!w.closed && body) body.innerHTML = `<div class="err">⚠ 醫囑抓取失敗：${esc(e.name === 'AbortError' ? '逾時' : e.message)}（收合再展開可重試）</div>`;
        }
    }

    const titleLink = (text, url) => `<a href="${esc(url)}" target="_blank" rel="noopener" title="開啟${esc(text)}頁（新分頁）">${esc(text)} ↗</a>`;
    const renderCharts = (r, win) => (r.pending.has('vitals') ? '<div class="muted nov">生命徵象圖：抓取中…</div>' : chartsHtml(r, win));

    function cardShell(i, r, win) {
        const p = r.p;
        const u = pageUrls(p);
        return `<section class="card">
<div class="hd"><b>${esc(p.bed)}</b> ${esc(p.name)} <small class="muted">${esc(p.chartNo)} · ${esc(p.sex)} ${esc(p.age)}${p.hospDay ? ' · 住院 ' + esc(p.hospDay) + ' 天' : ''}</small> <span class="lk">${renderLinks(r, i)}</span></div>
<div id="c${i}-vit">${renderVit(r, win)}</div>
<div id="c${i}-err">${renderErr(r)}</div>
<div class="kv"><span class="k">${titleLink('抗生素', u.rx)}</span><div id="c${i}-abx">${renderAbx(r)}</div></div>
<div class="kv"><span class="k"><a href="${esc(u.cath)}" target="ntuh-catheter" data-cath="1" title="開啟管路頁（固定開在同一個分頁；簡報載入完成後才能開）">管路 ↗</a></span><div id="c${i}-tubes">${renderTubes(r)}</div></div>
<div class="kv"><span class="k"><a href="#" data-ord="${i}" title="開啟醫囑簽收頁（新分頁）">醫囑 ↗</a></span><div><details class="lb" data-ord-load="${i}"><summary><span class="lbs">昨夜醫囑變更（點擊載入）</span></summary><div id="c${i}-ordbody"></div></details></div></div>
<div class="kv"><span class="k">${titleLink('檢驗', u.lab)}</span><div><details class="lb" data-lab="${i}"><summary><span class="lbs">檢驗數值（點擊載入）</span>${labHint(r)}</summary><div id="c${i}-labbody"></div></details></div></div>
<div class="kv"><span class="k"><a href="#" data-pacs="${i}" title="開啟影像列表">影像 ↗</a></span><div id="c${i}-pacs">${renderPacs(r)}</div></div>
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
    function pageShell(states, win) {
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
.lb{margin-top:2px}.lb>summary{cursor:pointer;font-size:12px;color:var(--mut)}.lbh{margin:4px 0 1px;font-size:12px;color:var(--mut)}.lbl{margin:1px 0;font-size:12px}
.lt{border-collapse:collapse;width:auto;margin:0 0 4px 8px;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace}.lt th,.lt td{border:0;padding:0 14px 0 0;text-align:left;white-space:nowrap;font-weight:400}.lt thead th{color:var(--mut)}.lt tbody th{color:var(--mut)}
.od>summary{cursor:pointer;font-size:12px;color:var(--mut)}.ot{width:auto;font-size:12px}.ot th,.ot td{border:0;padding:0 10px 1px 0}.ot td:first-child,.ot td:last-child{white-space:nowrap}.odel{color:#b91c1c}
.pc>summary{cursor:pointer;list-style:none}.pc>summary::-webkit-details-marker{display:none}.pc>summary::before{content:'▸ ';color:var(--mut)}.pc[open]>summary::before{content:'▾ '}.pc .rep{margin:2px 0 4px 14px;white-space:pre-wrap}
.charts{margin-top:2px}
.mt{font-size:12px;color:var(--mut);margin:2px 0}.tv{margin-top:6px;font-size:12px}.tv table{width:auto}.tv th,.tv td{padding:2px 10px 2px 0}.tv summary{cursor:pointer;color:var(--mut)}
svg.hsvg{max-width:100%;height:auto;display:block;margin:2px 0 8px}svg.hsvg.sp{margin:-6px 0 8px;overflow:visible}
svg.hsvg .ax{cursor:pointer}svg.hsvg .ax text{stroke-width:.35;font-size:13px}svg.hsvg .ax line,svg.hsvg .ser line{stroke-width:1}
svg.hsvg .ax.off{fill:lightgray!important;stroke:lightgray!important}svg.hsvg .ser.off{visibility:hidden}
svg.hsvg .ser circle{stroke:none}svg.hsvg .ser text.na{font-size:12px;stroke-width:.4}
svg.hsvg .hit{fill:transparent;stroke:none}svg.hsvg .hitl{stroke:transparent;stroke-width:12}
@media print{body{padding:0;font-size:11px}.card{break-inside:avoid}}
</style></head><body>
<h1>晨間簡報</h1>
<div class="sub"><span id="prog">載入中 0/${states.length}</span></div>
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
        w.document.write(pageShell(states, win));
        w.document.close();
        // 檢驗數值、醫囑：第一次展開才為該病人載入（toggle 不會冒泡，要用 capture）
        w.document.addEventListener('toggle', (ev) => {
            const dt = ev.target;
            if (!dt.matches || !dt.open) return;
            if (dt.matches('details.lb[data-lab]')) {
                const i = +dt.getAttribute('data-lab'), r = states[i];
                if (r && r.labState !== 'loading' && r.labState !== 'done') loadLab(w, i, r, win);
            } else if (dt.matches('details.lb[data-ord-load]')) {
                const i = +dt.getAttribute('data-ord-load'), r = states[i];
                if (r && r.ordState !== 'loading' && r.ordState !== 'done') loadOrders(w, i, r, win);
            }
        }, true);
        let loading = true;   // 簡報載入中（finally 之後才會變 false）
        // 影像：點擊時為該病人開啟來源頁（邏輯在原頁）。管路：載入中先擋下，避免互相干擾。
        w.document.addEventListener('click', (ev) => {
            const c = ev.target.closest && ev.target.closest('a[data-cath]');
            if (c && loading) { ev.preventDefault(); alert('簡報還在載入管路，請等頁首顯示「完成」後再開管路頁（避免兩邊互相干擾）。'); return; }
            const o = ev.target.closest && ev.target.closest('a[data-ord]');
            if (o) { ev.preventDefault(); const ro = states[+o.getAttribute('data-ord')]; if (ro) openOrderCheck(w, ro.p); return; }
            const g = ev.target.closest && ev.target.closest('a[data-prog]');
            if (g) { ev.preventDefault(); const rg = states[+g.getAttribute('data-prog')]; if (rg) openProgressNote(w, rg.p); return; }
            const a = ev.target.closest && ev.target.closest('a[data-pacs]');
            if (!a) return;
            ev.preventDefault();
            const r = states[+a.getAttribute('data-pacs')];
            if (r) openPacsList(w, r.p);
        });

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

            // 階段二（重）：抗生素＋管路＋醫囑，依病人順序、一次 HEAVY_POOL 位；卡片會由上而下依序補完
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
            loading = false;
            btn.disabled = false;
            btn.style.background = idleBg;
            btn.style.cursor = 'pointer';
            btn.textContent = label;
        }

        setText(w, 'prog', `完成（${((nowMs() - wall0) / 1000).toFixed(1)} 秒）`);
    }

    // 共用右下角 dock：同頁多支腳本的浮動按鈕排進同一個容器，避免互相覆蓋（誰先載入誰建立）
    function getDock() {
        let d = document.getElementById('ntuh-dock');
        if (!d) {
            d = document.createElement('div');
            d.id = 'ntuh-dock';
            d.style.cssText = 'position:fixed;right:8px;bottom:64px;z-index:99999;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font:14px system-ui,sans-serif';
            document.body.appendChild(d);
        }
        return d;
    }

    function mount() {
        if (document.getElementById('ntuh-mb-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ntuh-mb-btn';
        btn.textContent = '晨間簡報';
        btn.onclick = () => run(btn);
        const anchor = document.getElementById('NTUHWeb1_QueryInPatientPersonAccountControl1_ButtonBedPatientHistory')
            || document.querySelector('[id$="QueryInPatientPersonAccountControl1_ButtonBedPatientHistory"]');
        if (anchor) {
            btn.className = anchor.className;
            btn.style.cssText = anchor.style.cssText;
            anchor.insertAdjacentElement('afterend', btn);
            btn.before(document.createTextNode(' '));
        } else {
            btn.style.cssText = 'pointer-events:auto;padding:8px 14px;border:0;border-radius:18px;background:#0f766e;color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
            getDock().appendChild(btn);
        }
    }

    mount();
}());
