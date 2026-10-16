// ==UserScript==
// @name         NTUH 查房單
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.0.0
// @description  病房列表一鍵在新分頁產生可編輯的 A4 查房單（一頁 11 位）：自動帶入床號／姓名／病歷號／入院日／主治／住院醫師，頁首 VS 自動帶入主治姓名與員編、簡碼（來自主治班表），cc、#.、標籤與待辦可直接填寫並自動暫存，可直接列印
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://ehisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/DrScheduling/NoticeDrScheduling.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rounds-sheet.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rounds-sheet.user.js
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2 */

    const PER_PAGE = 11;                          // 一頁病人數（與紙本模板一致）
    const LABELS = ['Abx', 'Lab', 'Tubes'];        // 三行標籤的預設值（每位病人可各自改）
const RATIO = [2, 1, 1];                      // 三欄寬度比例預設（內容｜標籤＋填寫｜勾選＋待辦），頁面上可調
const TODO_PRESETS = ['Weekly', '診斷書', '病摘', '入摘', '出摘', 'Off-service', 'On-service'];  // 每行第一組待辦的快速填入選項
// 選到（或輸入）這些標籤時，同一行的填寫欄若是空的就自動帶入範本
const LABEL_TEMPLATES = { GCS: 'E.  V.  M.  ', MP: 'RU/LU/RL/LL:   /   /   /   ' };
const LABEL_OPTIONS = ['Abx', 'Lab', 'Tubes', 'GCS', 'MP', 'TPR', 'O2', 'IO', 'BW', 'Image'];  // 點標籤彈出的選項，也可自行輸入
    const DOCTORS_KEY = 'ntuh_rs_doctors';          // { 姓名: { n: 員編, c: 簡碼 } }（在主治班表頁自動記下）
    const STORE_KEY = 'ntuh-rounds-sheet:v1';
    const KEEP_DAYS = 30;                         // 超過幾天沒再出現在列表的病人，暫存內容自動清掉

    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

    // ═══════════════════════════════════════════════════════════
    // 主治班表 → 姓名／員編／簡碼 對照（排班頁每格：姓名<br>(簡碼:xxxxx)<br>…<font class=tooltiptext>員編</font>，員編是 6 碼字串）
    // ═══════════════════════════════════════════════════════════
    const nk = (name) => String(name || '').replace(/\s+/g, '');
    const loadDoctors = () => { try { return JSON.parse(GM_getValue(DOCTORS_KEY, '{}')) || {}; } catch (e) { return {}; } };

    function captureDoctors() {
        let tries = 0;
        const iv = setInterval(() => {
            tries++;
            const table = document.getElementById('tblContent');
            const found = {};
            if (table) {
                table.querySelectorAll('font.tooltip').forEach((el) => {
                    const n = ((el.querySelector('.tooltiptext') || {}).textContent || '').trim();
                    if (!n) return;
                    const first = [...el.childNodes].find((x) => x.nodeType === 3 && x.textContent.trim());
                    const name = first ? nk(first.textContent) : '';
                    const c = (el.textContent.replace(n, '').match(/簡碼\s*[:：]\s*([A-Za-z0-9]+)/) || [])[1] || '';
                    if (name) found[name] = { n, c };
                });
            }
            if (Object.keys(found).length) {
                clearInterval(iv);
                const all = Object.assign(loadDoctors(), found);
                try { GM_setValue(DOCTORS_KEY, JSON.stringify(all)); } catch (e) { /* */ }
                const t = document.createElement('div');
                t.textContent = `查房單：已記下 ${Object.keys(found).length} 位主治的員編／簡碼（共 ${Object.keys(all).length} 位）`;
                t.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:rgba(0,0,0,.85);color:#fff;padding:8px 14px;border-radius:8px;font:13px system-ui,sans-serif';
                document.body.appendChild(t);
                setTimeout(() => t.remove(), 4000);
            } else if (tries >= 20) clearInterval(iv);
        }, 500);
    }

    // 病房列表的 hover title 有時有值、有時空：看到有值就記進對照表（回傳最新對照表）
    function learnDoctors(patients) {
        const dir = loadDoctors();
        let learned = false;
        patients.forEach((p) => {
            const nm = nk(p.attending);
            if (!nm || !(p.attId || p.attCode)) return;
            const o = dir[nm] || {};
            const n = p.attId || o.n || '', c = p.attCode || o.c || '';
            if (n !== o.n || c !== o.c) { dir[nm] = { n, c }; learned = true; }
        });
        if (learned) { try { GM_setValue(DOCTORS_KEY, JSON.stringify(dir)); } catch (e) { /* */ } }
        return dir;
    }

    // ═══════════════════════════════════════════════════════════
    // 病房列表 → 病人清單（元素 id 前綴會變，一律用尾綴選取）
    // ═══════════════════════════════════════════════════════════
    function docTitle(td, label) {
        const el = td && td.querySelector('[title]');
        const m = el && el.title.match(new RegExp(label + '\\s*[:：]\\s*([A-Za-z0-9]+)'));
        return m ? m[1] : '';
    }

    function readPatients() {
        const table = document.querySelector('[id$="DataGridAccountList"]');
        if (!table) return [];
        const out = [];
        for (const tr of [...table.rows].slice(1)) {
            const news = tr.querySelector('[id$="NEWSLabel"]');
            const caseno = news && news.getAttribute('caseno');
            if (!caseno) continue;
            const cells = [...tr.cells];
            // 欄位順序：房、室、床、姓名、病歷號、性、齡、主治(7)、住院(8)、入院日(9)、EWS；
            // 入院日不靠固定欄位，從第 9 欄起找第一個長得像日期的
            const adm = cells.slice(9).map(txt).find((t) => /\d{2,4}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{1,2}/.test(t)) || '';
            out.push({
                caseno,
                chartNo: news.getAttribute('chartno') || txt(tr.querySelector('[id$="PatChartNo"]')),
                ward: news.getAttribute('wardcode') || txt(tr.querySelector('[id$="WardLabel"]')),
                name: txt(tr.querySelector('[id$="LinkPatientName"]')),
                bed: [txt(tr.querySelector('[id$="RoomLabel"]')), txt(tr.querySelector('[id$="BedLabel"]'))].filter(Boolean).join('-'),
                age: txt(tr.querySelector('[id$="PatientAge"]')),
                sex: txt(tr.querySelector('[id$="PatientSex"]')),
                attending: txt(cells[7]),
                // 醫師姓名是 <span title="員編：xxxxxx，簡碼：xxxxx">；實測 title 有時是空值（「員編： ，簡碼： 」），空的就留空，由主治班表對照補
                attId: docTitle(cells[7], '員編'),
                attCode: docTitle(cells[7], '簡碼'),
                resident: txt(cells[8]),
                adm,
                hospDay: (tr.innerHTML.match(/住院總天數\s*[:：]\s*(\d+)/) || [])[1] || '',
            });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 頁面
    // ═══════════════════════════════════════════════════════════
    const input = (key, cls, extra) => `<input class="${cls}" data-k="${esc(key)}" autocomplete="off" spellcheck="false"${extra || ''}>`;

    // docs：這一頁病人的主治（依出現順序、去重）→ 依序帶入 VS 格（姓名／員編／簡碼）；沒有的就留空白手填
    function headerHtml(pg, docs) {
        // 對應紙本頁首：  CR / VS  、  VS / VS   （每格：名稱 ____ ( ____ ) ( ____ )）
        const g = (name, n, three, d) => {
            const df = (v) => (v ? ` data-def="${esc(v)}"` : '');
            return `<span class="hf">${name}${input(`h:${pg}:${n}:a`, 'u w9', df(d && d.name))}(${input(`h:${pg}:${n}:b`, 'u w8', df(d && d.n))})${three ? `(${input(`h:${pg}:${n}:c`, 'u w7', df(d && d.c))})` : ''}</span>`;
        };
        return `<div class="hdr">
<div class="hr">${g('CR', 1, true)}${g('VS', 2, true, docs[0])}</div>
<div class="hr">${g('VS', 3, true, docs[1])}${g('VS', 4, true, docs[2])}</div>
</div>`;
    }

    // 住院第幾天：優先用列表上的「住院總天數」，沒有就由入院日算（入院當天算 Day 1；民國年自動換算）
    function dayOf(p) {
        if (p.hospDay) return p.hospDay;
        const m = p.adm.match(/(\d{2,4})\s*[\/.-]\s*(\d{1,2})\s*[\/.-]\s*(\d{1,2})/);
        if (!m) return '';
        const y = +m[1] < 1911 ? +m[1] + 1911 : +m[1];
        const a = new Date(y, +m[2] - 1, +m[3]), t = new Date();
        const diff = Math.round((new Date(t.getFullYear(), t.getMonth(), t.getDate()) - a) / 86400000) + 1;
        return diff > 0 ? String(diff) : '';
    }

    const bedLabel = (p) => [p.ward, p.bed].filter(Boolean).join(' ');   // 病房＋床號

    function blockHtml(p) {
        const id = p.chartNo || p.caseno;
        const k = (n) => `p:${id}:${n}`;
        const row = (r, tag) => `<div class="ln"><div class="c1"><span class="tg">${tag}</span>${input(k(`m${r}`), 'tx')}</div><div class="c2">${input(k(`l${r}`), 'lab')}${input(k(`f${r}`), 'tx')}</div><div class="c3">${[0, 1].map((n) => { const sx = n ? `_${n}` : ''; return `<div class="cell"><input type="checkbox" class="bx" data-k="${esc(k(`c${r}${sx}`))}">${input(k(`t${r}${sx}`), n ? 'tx td' : 'tx td pre')}</div>`; }).join('')}</div></div>`;
        const info = [
            bedLabel(p) && `<b>${esc(bedLabel(p))}</b>`,
            `<b>${esc(p.name)}</b>`,
            (p.sex || p.age) && esc([p.sex, p.age].filter(Boolean).join('/')),
            esc(p.chartNo),
            p.adm && `入 ${esc(p.adm)}${dayOf(p) ? `(Day ${esc(dayOf(p))})` : ''}`,
            `預出院${input(k('dc'), 'u w9')}`,
            p.attending && `VS ${esc(p.attending)}`,
            p.resident && `R ${esc(p.resident)}`,
        ].filter(Boolean).join('<span class="sep"></span>');
        return `<section class="pt" data-id="${esc(id)}">
<div class="ln info"><div class="il">${info}</div></div>
${row(0, 'cc')}
${row(1, '#.')}
${row(2, '#.')}
</section>`;
    }

    function pageDocs(pp, dir) {
        const seen = new Set(), out = [];
        pp.forEach((p) => {
            const nm = nk(p.attending);
            if (!nm || seen.has(nm)) return;
            seen.add(nm);
            const d = dir[nm] || {};
            out.push({ name: nm, n: p.attId || d.n || '', c: p.attCode || d.c || '' });
        });
        return out;
    }

    function sideHtml(patients) {
        // 每位病人一個區塊，高度與位置由頁面腳本對齊左邊該病人的區塊；2 欄 × 3 列：Abx|TPR、Tubes|O2、GCS|IO
        const rows = [['Abx', 'abx'], ['TPR', 'tpr'], ['Tubes', 'tubes'], ['O2', 'o2'], ['GCS', 'gcs'], ['IO', 'io']];
        return `<aside class="side"><div class="rz" id="rz" title="拖曳調整面板寬度"></div>
<div class="sdt"><div class="sdh"><b>資料</b><span id="sd-prog" class="mu"></span><button id="sd-re" type="button">重新抓取</button></div>
<div class="sdn">資料塊可拖進左邊同一位病人的欄位（需保持病房列表分頁開著）</div></div>
${patients.map((p, i) => `<div class="sp" data-id="${esc(p.chartNo || p.caseno)}"><div class="sh" title="點一下捲到左邊這位病人">${esc([bedLabel(p), p.name].filter(Boolean).join(' '))}</div>
<div class="sg">${rows.map(([l, k]) => `<div class="sr"><span class="sk">${l}</span><div class="sc" id="sd-${i}-${k}"><span class="mu">等待中…</span></div></div>`).join('')}</div>
</div>`).join('')}
</aside>`;
    }

    function pageShell(patients, today, stamp, dir) {
        const pages = [];
        for (let i = 0; i < patients.length; i += PER_PAGE) pages.push(patients.slice(i, i + PER_PAGE));
        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>查房單 ${esc(today)}</title>
<style>
@page{size:A4;margin:0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e5e7eb;color:#111;font:10.5pt/1 system-ui,"Noto Sans TC","PingFang TC",sans-serif}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;padding:8px 16px;background:#1f2937;color:#fff;font-size:13px}
.bar button{padding:5px 14px;border:0;border-radius:6px;background:#0f766e;color:#fff;font-size:13px;cursor:pointer}
.bar{height:37px}
.ruler{position:sticky;top:37px;z-index:4;width:210mm;height:20px;margin:6px auto 0;background:#fff;background-image:repeating-linear-gradient(90deg,#9ca3af 0 1px,transparent 1px 10mm);background-size:calc(100% - 18mm) 6px;background-position:9mm 14px;background-repeat:no-repeat;box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none}
.rl{position:absolute;left:9mm;right:9mm;top:0;bottom:0}
.hd{position:absolute;top:2px;width:14px;margin-left:-7px;height:16px;cursor:ew-resize;touch-action:none}
.hd::before{content:"";position:absolute;left:1px;top:2px;border:6px solid transparent;border-top:10px solid #0f766e;border-bottom:0}
.hd::after{content:"";display:none;position:absolute;left:6px;top:20px;height:100vh;border-left:1px dashed #0f766e;pointer-events:none}
.hd.on::after{display:block}
.bar button.g{background:#4b5563}
.bar .m{color:#9ca3af;margin-left:auto;font-size:12px}
.gen{position:absolute;left:9mm;top:2.5mm;font-size:6.5pt;color:#6b7280}
.page{position:relative;width:210mm;height:297mm;margin:14px auto;padding:7mm 9mm;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:hidden;break-after:page}
.hdr{height:15mm;font-size:10pt}
.hr{display:flex;align-items:center;height:7.5mm;gap:4mm;white-space:nowrap}
.hf{display:inline-flex;align-items:baseline}
input{font:inherit;color:inherit;background:transparent;border:0;outline:0;padding:0;margin:0}
input.u{border-bottom:.3mm solid #111;text-align:center;height:5.5mm}
.w9{width:17mm}.w8{width:14mm}.w7{width:12mm}
.pt{height:24mm;border-bottom:.2mm solid #9ca3af;display:flex;flex-direction:column}
.ln{display:flex;align-items:center;height:6mm;padding-right:1mm}
.info .il{flex:1;white-space:nowrap;overflow:hidden;font-size:10.5pt}
.il b{font-weight:700}.sep{display:inline-block;width:3.5mm}
.tg{width:7mm;font-weight:700;flex:none}
.tx{flex:1;min-width:0;height:5.5mm;font-size:10.5pt}
.c1,.c2,.c3{min-width:0;display:flex;align-items:center}
.c1{flex:var(--r1,2) 1 0}
.c2{flex:var(--r2,1) 1 0}
.c1>.tx,.c2>.tx{margin-right:2.5mm}
.c3{flex:var(--r3,1) 1 0;gap:2mm}
.cell{flex:1 1 0;min-width:0;display:flex;align-items:center}
.tx.td{margin-left:1.5mm}
.lab{flex:none;width:19mm;margin-right:1.5mm;text-align:center;font-size:8pt;font-weight:700;height:5mm;border:.25mm solid #111;border-radius:1mm}
.bx{-webkit-appearance:none;appearance:none;flex:none;width:3.4mm;height:3.4mm;margin:0 0 0 2mm;border:.3mm solid #111;border-radius:0;position:relative;cursor:pointer;background:#fff}
.bx:checked::after{content:"✓";position:absolute;left:-.1mm;top:-1.6mm;font-size:12pt;line-height:1}
.lmenu{position:absolute;z-index:9;display:flex;flex-wrap:wrap;gap:3px;width:62mm;padding:4px;background:#fff;border:1px solid #9ca3af;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.lmenu[hidden]{display:none}
.lmenu button{padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;font:12px system-ui,sans-serif;cursor:pointer}
.lmenu button:hover{background:#fef9c3}
#rs-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#b91c1c;color:#fff;padding:8px 16px;border-radius:8px;font:13px system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .15s;z-index:20}
#rs-toast.show{opacity:1}
@media screen{
 body.dragging .pt{opacity:.35}body.dragging .pt.mine{opacity:1;outline:2px solid #0f766e;outline-offset:-1px;background:#f0fdfa}
 .wrap{display:flex;align-items:stretch}
 .main{flex:1 1 auto;min-width:0}
 .side{flex:none;position:relative;width:var(--sw,620px);background:#f9fafb;border-left:1px solid #d1d5db;font:12px/1.4 system-ui,"Noto Sans TC",sans-serif}
 .sdt{position:sticky;top:37px;z-index:3;background:#f9fafb;padding:6px 10px;border-bottom:1px solid #e5e7eb}
 .sdh{display:flex;gap:8px;align-items:center}.sdh button{margin-left:auto;padding:2px 8px;font-size:12px;cursor:pointer}
 .sdn{color:#6b7280;margin-top:2px}.mu{color:#9ca3af}.er{color:#b91c1c}
 .sp{position:absolute;left:0;right:0;box-sizing:border-box;padding:2px 10px;border-top:1px solid #e5e7eb;overflow-x:hidden;overflow-y:auto}
 .sh{font-weight:700;font-size:11px;line-height:14px;cursor:pointer;white-space:nowrap}
 .sg{display:grid;grid-template-columns:1fr 1fr;column-gap:10px}
 .sr{display:flex;gap:4px;align-items:baseline;min-width:0;min-height:22px}.sk{flex:none;width:34px;color:#6b7280}
 .sc{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:2px 4px}.sc .mu,.sc .er{white-space:nowrap}
 .rz{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:ew-resize;touch-action:none;z-index:4}.rz:hover,.rz.on{background:rgba(15,118,110,.25)}
 .chip{display:inline-block;white-space:nowrap;padding:0 7px;border:1px solid #9ca3af;border-radius:10px;background:#fff;font-size:11px;line-height:17px;cursor:grab;user-select:none}
 .chip.all{border-style:dashed;color:#4b5563}
 input:hover,input:focus{background:#fef9c3}
 .tx{border-bottom:.2mm dotted #cbd5e1}
 .bx:hover{background:#fef9c3}
}
@media print{
 body{background:#fff}.bar,.lmenu,.ruler,.side{display:none}
 .page{margin:0;box-shadow:none}
 input:hover,input:focus{background:transparent}
}
</style></head><body>
<div class="bar"><button id="pr">列印</button><button class="g" id="clr">清除本頁填寫</button><button class="g" id="clrl" title="清除所有病人中間欄的標籤（回到預設）與填寫內容">清除標籤區</button><button class="g" id="clrc" title="清除所有病人右邊的勾選與待辦文字">清除勾選區</button><button class="g" id="rr">重設欄寬</button>
<span>${patients.length} 位病人・${pages.length} 頁</span><span class="m">自動暫存於此瀏覽器・點標籤、第一組待辦可選預設項目；右側資料塊可拖進同一位病人的填寫欄（放進標籤右邊那格會自動換標籤）</span></div>
<div class="wrap">
<main class="main">
<div class="ruler" title="拖曳三角形調整欄寬"><div class="rl" id="rl"><i class="hd" id="h1"></i><i class="hd" id="h2"></i></div></div>
${pages.map((pp, i) => `<div class="page"><div class="gen">生成 ${esc(stamp)}</div>${headerHtml(i + 1, pageDocs(pp, dir))}${pp.map(blockHtml).join('')}</div>`).join('')}
</main>
${sideHtml(patients)}
</div>
<script>(${pageScript.toString()})(${JSON.stringify({ key: STORE_KEY, keep: KEEP_DAYS, labels: LABELS, options: LABEL_OPTIONS, presets: TODO_PRESETS, templates: LABEL_TEMPLATES, ratio: RATIO })});<\/script></body></html>`;
    }

    // 在新分頁內執行（toString 後注入，不可引用外層變數）
    function pageScript(cfg) {
        const now = new Date().getTime();
        let store = {};
        try { store = JSON.parse(localStorage.getItem(cfg.key) || '{}') || {}; } catch (e) { store = {}; }
        const seen = store.__seen || (store.__seen = {});
        const ids = [...document.querySelectorAll('.pt')].map((e) => e.getAttribute('data-id'));
        ids.forEach((id) => { seen[id] = now; });
        // 清掉太久沒出現的病人暫存（已出院等）
        const limit = cfg.keep * 86400000;
        for (const id of Object.keys(seen)) {
            if (now - seen[id] <= limit) continue;
            delete seen[id];
            for (const k of Object.keys(store)) if (k.indexOf('p:' + id + ':') === 0) delete store[k];
        }
        const save = () => { try { localStorage.setItem(cfg.key, JSON.stringify(store)); } catch (e) { /* 無痕或被擋：只是不暫存 */ } };
        const fill = (el) => {
            const k = el.getAttribute('data-k');
            const v = store[k];
            if (el.type === 'checkbox') el.checked = !!v;
            else if (/:l\d$/.test(k)) el.value = v !== undefined ? v : cfg.labels[+k.slice(-1)] || '';
            else el.value = v || el.getAttribute('data-def') || '';
        };
        const all = [...document.querySelectorAll('[data-k]')];
        all.forEach(fill);
        save();
        document.addEventListener('input', (ev) => {
            const el = ev.target;
            const k = el.getAttribute && el.getAttribute('data-k');
            if (!k) return;
            store[k] = el.type === 'checkbox' ? el.checked : el.value;
            if (/:l\d$/.test(k)) {
                const tpl = cfg.templates[el.value.trim().toUpperCase()];
                const fk = k.replace(/:l(\d)$/, ':f$1');
                const f = tpl && all.find((o) => o.getAttribute('data-k') === fk);
                if (f && !f.value.trim()) { f.value = tpl; store[fk] = tpl; }
            }
            save();
        });
        // 標籤選單：點（或聚焦）標籤跳出選項；選項只是快速填入，也可以直接輸入任意文字
        const menu = document.createElement('div');
        menu.className = 'lmenu';
        menu.hidden = true;
        document.body.appendChild(menu);
        let target = null;
        const hide = () => { menu.hidden = true; target = null; };
        document.addEventListener('focusin', (ev) => {
            const el = ev.target;
            const isLab = el.classList && el.classList.contains('lab');
            if (!isLab && !(el.classList && el.classList.contains('pre'))) { if (!menu.contains(el)) hide(); return; }
            target = el;
            el.select();
            menu.textContent = '';
            (isLab ? cfg.options : cfg.presets).forEach((o) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = o; menu.appendChild(b); });
            menu.hidden = false;
            const r = el.getBoundingClientRect();
            const left = Math.min(r.left, document.documentElement.clientWidth - menu.offsetWidth - 8);
            menu.style.left = (Math.max(left, 4) + window.scrollX) + 'px';
            menu.style.top = (r.bottom + window.scrollY + 2) + 'px';
        });
        menu.addEventListener('mousedown', (ev) => ev.preventDefault());   // 點選項時不要讓輸入框失焦
        menu.addEventListener('click', (ev) => {
            const b = ev.target.closest('button');
            if (!b || !target) return;
            target.value = b.textContent;
            target.dispatchEvent(new Event('input', { bubbles: true }));
            hide();
            target.blur();
        });
        document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' || ev.key === 'Enter') { hide(); if (document.activeElement) document.activeElement.blur(); } });
        document.addEventListener('mousedown', (ev) => { if (!menu.contains(ev.target) && !(ev.target.classList && (ev.target.classList.contains('lab') || ev.target.classList.contains('pre')))) hide(); });
        // 欄寬比例（全域，存起來下次沿用）
        const rl = document.getElementById('rl');
        const hs = [document.getElementById('h1'), document.getElementById('h2')];
        const norm = (v) => (Array.isArray(v) && v.length === 3 && v.every((n) => n > 0) ? v : cfg.ratio);
        const applyRatio = (v) => {
            const t = v[0] + v[1] + v[2];
            v.forEach((n, i) => document.body.style.setProperty('--r' + (i + 1), n));
            hs[0].style.left = (v[0] / t * 100) + '%';
            hs[1].style.left = ((v[0] + v[1]) / t * 100) + '%';
        };
        applyRatio(norm(store['cfg:ratio']));
        hs.forEach((h, i) => {
            h.addEventListener('pointerdown', (ev) => { h.setPointerCapture(ev.pointerId); h.classList.add('on'); ev.preventDefault(); });
            h.addEventListener('pointermove', (ev) => {
                if (!h.classList.contains('on')) return;
                const rc = rl.getBoundingClientRect();
                const cur = norm(store['cfg:ratio']);
                const t = cur[0] + cur[1] + cur[2];
                let p1 = cur[0] / t, p2 = (cur[0] + cur[1]) / t;
                const x = Math.min(Math.max((ev.clientX - rc.left) / rc.width, 0), 1);
                const gap = 0.08;
                if (i === 0) p1 = Math.min(Math.max(x, 0.08), p2 - gap); else p2 = Math.max(Math.min(x, 0.95), p1 + gap);
                const v = [p1, p2 - p1, 1 - p2].map((n) => Math.round(n * 1000) / 1000);
                store['cfg:ratio'] = v;
                applyRatio(v);
            });
            const end = () => { if (h.classList.contains('on')) { h.classList.remove('on'); save(); } };
            h.addEventListener('pointerup', end);
            h.addEventListener('pointercancel', end);
        });
        document.getElementById('rr').onclick = () => { delete store['cfg:ratio']; applyRatio(cfg.ratio); save(); };
        // 右側資料塊：只能放進「同一位病人」的填寫欄（防呆）。
        //   放進該行的「填寫欄」（標籤右邊那格）→ 原內容整個換掉，標籤自動換成資料塊的類別；
        //   放進其他填寫欄（cc／#. 內容、待辦）→ 照一般文字放進去，不動標籤。
        let drag = null;
        const toast = (msg) => {
            let t = document.getElementById('rs-toast');
            if (!t) { t = document.createElement('div'); t.id = 'rs-toast'; document.body.appendChild(t); }
            t.textContent = msg; t.className = 'show';
            clearTimeout(t._h); t._h = setTimeout(() => { t.className = ''; }, 2600);
        };
        const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        const dropCheck = (ev) => {   // → { ok, input }；不是輸入框就 null（交給瀏覽器）
            const inp = ev.target.closest && ev.target.closest('input');
            if (!inp) return null;
            const pt = inp.closest('.pt');
            return { inp, ok: !!pt && pt.getAttribute('data-id') === drag.pid && inp.classList.contains('tx') };
        };
        document.addEventListener('dragstart', (ev) => {
            const c = ev.target.closest && ev.target.closest('.chip');
            if (!c) return;
            drag = { pid: c.closest('.sp').getAttribute('data-id'), cat: c.getAttribute('data-c') || '' };
            ev.dataTransfer.setData('text/plain', c.getAttribute('data-t'));
            ev.dataTransfer.effectAllowed = 'copy';
            document.body.classList.add('dragging');
            document.querySelectorAll('.pt').forEach((e) => e.classList.toggle('mine', e.getAttribute('data-id') === drag.pid));
        });
        document.addEventListener('dragend', () => {
            drag = null;
            document.body.classList.remove('dragging');
            document.querySelectorAll('.pt.mine').forEach((e) => e.classList.remove('mine'));
        });
        document.addEventListener('dragover', (ev) => {
            if (!drag) return;
            const r = dropCheck(ev);
            if (r && !r.ok) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'none'; }
        }, true);
        document.addEventListener('drop', (ev) => {
            if (!drag) return;
            const r = dropCheck(ev);
            if (!r) return;
            if (!r.ok) { ev.preventDefault(); ev.stopPropagation(); toast('這是另一位病人的資料，不能放在這裡（請放進同一位病人的欄位）'); return; }
            const k = r.inp.getAttribute('data-k') || '';
            if (!/:f\d$/.test(k)) return;   // 其他欄位：瀏覽器原生放入文字
            ev.preventDefault(); ev.stopPropagation();
            const text = ev.dataTransfer.getData('text/plain');
            setVal(r.inp, text);
            const lab = all.find((o) => o.getAttribute('data-k') === k.replace(/:f(\d)$/, ':l$1'));
            if (lab && drag.cat) setVal(lab, drag.cat);
        }, true);
        document.addEventListener('click', (ev) => {
            const h = ev.target.closest && ev.target.closest('.sh');
            if (!h) return;
            const id = h.parentElement.getAttribute('data-id');
            const t = [...document.querySelectorAll('.pt')].find((e) => e.getAttribute('data-id') === id);
            if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        // 右側面板：每位病人的區塊對齊左邊該病人的區塊（位置與高度）
        const align = () => {
            const side = document.querySelector('.side');
            if (!side) return;
            const top = side.getBoundingClientRect().top;
            const pts = {};
            document.querySelectorAll('.pt').forEach((e) => { pts[e.getAttribute('data-id')] = e; });
            document.querySelectorAll('.sp').forEach((sp) => {
                const pt = pts[sp.getAttribute('data-id')];
                if (!pt) return;
                const r = pt.getBoundingClientRect();
                sp.style.top = (r.top - top) + 'px';
                sp.style.height = r.height + 'px';
            });
        };
        align();
        setTimeout(align, 300);
        window.addEventListener('resize', align);
        window.addEventListener('load', align);
        // 右側面板寬度：拖左邊緣調整，存起來沿用
        const sw = document.getElementById('rz');
        const setSw = (px) => document.body.style.setProperty('--sw', px + 'px');
        if (Number.isFinite(store['cfg:side'])) setSw(store['cfg:side']);
        if (sw) {
            sw.addEventListener('pointerdown', (ev) => { sw.setPointerCapture(ev.pointerId); sw.classList.add('on'); ev.preventDefault(); });
            sw.addEventListener('pointermove', (ev) => {
                if (!sw.classList.contains('on')) return;
                const w = Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 320), 960));
                store['cfg:side'] = w; setSw(w);
            });
            const endSw = () => { if (sw.classList.contains('on')) { sw.classList.remove('on'); save(); } };
            sw.addEventListener('pointerup', endSw);
            sw.addEventListener('pointercancel', endSw);
        }
        const re = document.getElementById('sd-re');
        if (re) re.onclick = () => {
            if (!window.opener || window.opener.closed) { alert('病房列表分頁已關閉，無法重新抓取。請回病房列表重新按「查房單」。'); return; }
            window.opener.postMessage({ rs: 'refresh', token: document.documentElement.getAttribute('data-rs-token') }, location.origin);
        };
        document.getElementById('pr').onclick = () => window.print();
        // 分區清除：標籤區＝標籤（回預設）＋同行填寫欄；勾選區＝勾選格＋待辦文字
        const clearZone = (re, what) => {
            if (!confirm(`清除所有病人的${what}？`)) return;
            all.forEach((el) => {
                const k = el.getAttribute('data-k');
                if (!re.test(k)) return;
                delete store[k];
                fill(el);
            });
            save();
        };
        document.getElementById('clrl').onclick = () => clearZone(/^p:.*:[lf]\d$/, '標籤區（標籤回到預設、填寫內容清空）');
        document.getElementById('clrc').onclick = () => clearZone(/^p:.*:[ct]\d(_\d)?$/, '勾選區（勾選與待辦文字）');
        document.getElementById('clr').onclick = () => {
            if (!confirm('清除所有病人的填寫、待辦、勾選、標籤與頁首欄位？')) return;
            for (const k of Object.keys(store)) if (k.indexOf('p:') === 0 || k.indexOf('h:') === 0) delete store[k];
            all.forEach(fill);
            save();
        };
    }

    // ═══════════════════════════════════════════════════════════
    // 資料抓取：抗生素（藥歷頁）、管路（CatheterCare）
    // ═══════════════════════════════════════════════════════════
    // 邏輯與 morning-briefing 的 fetchAbx／fetchTubes 相同（實測過的做法，註解與坑見該檔）；兩邊要同步修改。
    // 抓取在病房列表這個分頁執行（要用它的 SESSION 與病人清單 Cookie），結果直接寫進查房單分頁的右側面板。
    const nowMs = () => new Date().getTime();   // HIS 的 date.js 會覆寫 Date.now
    const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const dayNo = (startMs, now) => Math.round((dayStart(now) - dayStart(startMs)) / 86400000) + 1;
    const two = (n) => String(n).padStart(2, '0');
    const parseHtml = (html) => new DOMParser().parseFromString(html || '', 'text/html');

    // SESSION：病房列表網址上帶著；只放進請求網址，不顯示、不存
    function pageSession() {
        const m = location.search.match(/[?&]session=([^&]+)/i)
            || document.documentElement.innerHTML.match(/SESSION=([a-zA-Z0-9]{34})/i);
        return m ? m[1] : '';
    }

    // Cookie 的 PatN 值是舊式 escape 編碼（%uXXXX、%XX），只用中段「院區_類別_PersonID_AccountIDSE」依 AccountIDSE 配對
    function personIdFromPatientList(cookieText, accountId) {
        const prefix = 'Page_Session_InPatientPatientListSessionKey=';
        const cookie = cookieText.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
        if (!cookie) throw new Error('找不到病房病人清單 Cookie');
        const decode = (value) => value.replace(/%u([0-9a-f]{4})|%([0-9a-f]{2})/gi,
            (_, unicode, byte) => String.fromCharCode(parseInt(unicode || byte, 16)));
        let value = cookie.slice(prefix.length);
        if (!/^Pat\d+=/.test(value)) value = decode(value);
        let personId = '';
        for (const entry of value.split('&')) {
            const match = entry.match(/^Pat\d+=(.*)$/);
            if (!match) continue;
            const identity = decode(match[1]).split('|')[1]?.split('_');
            if (!identity || identity.length !== 4 || identity[1] !== 'I'
                || !identity[2] || identity[3] !== accountId) continue;
            if (personId && personId !== identity[2]) throw new Error('病房 Cookie 的病人識別不一致');
            personId = identity[2];
        }
        if (!personId) throw new Error('病房 Cookie 找不到此住院帳號的 PersonID');
        return personId;
    }

    function makeGate(max) {
        let active = 0;
        const queue = [];
        return async (task) => {
            if (active >= max) await new Promise((release) => queue.push(release));
            active += 1;
            try { return await task(); } finally { active -= 1; const next = queue.shift(); if (next) next(); }
        };
    }
    const rxGate = makeGate(3);     // 藥歷表單查詢
    const pageGate = makeGate(1);   // 管路：handler 不帶病人識別、靠「最近載入的病人」決定回誰 → 一律一次一位

    // ─── 抗生素（MedicationHistory/Default.aspx）：GET 表單後 POST「抗生素」查詢，以院方分類為準，只留住院「住」
    const medicationHistoryUrl = (personId) => location.origin
        + '/WebApplication/OtherIndependentProj/MedicationHistory/Default.aspx'
        + `?SESSION=${encodeURIComponent(pageSession())}&PersonID=${encodeURIComponent(personId)}`;

    function medicationHistoryQuery(doc, now) {
        const form = doc.querySelector('form');
        const query = doc.querySelector('[id$="_btnQuery"]');
        const antibiotics = doc.querySelector('[id$="_ckbAntibiotics"]');
        const date = doc.querySelector('[id$="_txbStartDate"]');
        const days = doc.querySelector('[id$="_txbDays"]');
        const patientTypes = [...doc.querySelectorAll('input[id*="_cblPatientType_"]')];
        if (!form || !query || !antibiotics || !date || !days || !patientTypes.length
            || !form.querySelector('input[name="__VIEWSTATE"]')) throw new Error('藥歷查詢表單讀不到');
        const body = new URLSearchParams();
        for (const el of form.querySelectorAll('input')) {
            if (!el.name || el.disabled || ['submit', 'button', 'checkbox', 'radio'].includes(el.type)) continue;
            body.append(el.name, el.value);
        }
        body.set('__EVENTTARGET', '');
        body.set('__EVENTARGUMENT', '');
        const d = new Date(now);
        body.set(date.name, `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())}`);
        body.set(days.name, '2');
        for (const el of patientTypes) body.set(el.name, el.value);
        const all = doc.querySelector('[id$="_ckbPatientTypeAll"]');
        if (all) body.set(all.name, all.value);
        body.set(antibiotics.name, antibiotics.value);
        body.set(query.name, query.value);
        return body;
    }

    function parseMedicationHistory(doc, now) {
        const table = doc.querySelector('[id$="_grvData"]');
        if (!table) {
            const message = txt(doc.querySelector('[id$="_lblMessage"]'));
            if (message.includes('日期範圍查無勾選範圍的處方資料')) return [];
            throw new Error('藥歷結果表讀不到');
        }
        const headers = [...table.rows[0].cells].map(txt);
        const start = headers.indexOf('開始日'), stop = headers.indexOf('停用日');
        const nameCol = headers.indexOf('藥名'), content = headers.indexOf('處方內容');
        if ([start, stop, nameCol, content].some((i) => i < 0)) throw new Error('藥歷欄位格式改變');
        const dateMs = (text) => {
            const m = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
            if (!m) throw new Error('藥歷日期格式無法判讀');
            const d = new Date(+m[1], +m[2] - 1, +m[3]);
            if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) throw new Error('藥歷日期無效');
            return d.getTime();
        };
        const today = dayStart(now), out = [];
        for (const tr of [...table.rows].slice(1)) {
            if (txt(tr.cells[0]) !== '住') continue;
            if (tr.cells.length !== headers.length) throw new Error('藥歷資料列格式改變');
            const startMs = dateMs(txt(tr.cells[start]));
            const stopText = txt(tr.cells[stop]);
            if (startMs > today || (stopText && dateMs(stopText) < today)) continue;
            const rawName = txt(tr.cells[nameCol]);
            if (!rawName) throw new Error('藥歷藥名缺漏');
            const prescription = txt(tr.cells[content]);
            const route = (prescription.match(/\b(IV|IF|PO|IM|SC|SQ|TOPIC|INHL)\b/i) || [])[1] || '';
            out.push({ name: rawName.split('(')[0].trim().slice(0, 40), route, startMs, day: dayNo(startMs, now) });
        }
        return out.sort((a, b) => a.startMs - b.startMs);
    }

    async function fetchAbx(p, now) {
        return rxGate(async () => {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 45000);
            try {
                const pid = personIdFromPatientList(document.cookie, p.caseno);
                const url = medicationHistoryUrl(pid);
                const initial = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
                if (!initial.ok) throw new Error('HTTP ' + initial.status);
                let doc = parseHtml(await initial.text());
                // 已保存的「全部藥物」選項若觸發 Changed handler 可能清掉抗生素勾選：用回傳的新表單再送一次，仍未套用就報錯
                for (let attempt = 0; attempt < 2; attempt++) {
                    const body = medicationHistoryQuery(doc, now);
                    const res = await fetch(url, { method: 'POST', body, credentials: 'same-origin', signal: ctrl.signal });
                    if (!res.ok) throw new Error('HTTP ' + res.status);
                    doc = parseHtml(await res.text());
                    const selected = [...doc.querySelectorAll('input[type="checkbox"]:checked')]
                        .filter((el) => /_ckb/.test(el.id) && !/_ckbPatientTypeAll$/.test(el.id));
                    if (selected.length === 1 && selected[0].id.endsWith('_ckbAntibiotics')) return parseMedicationHistory(doc, now);
                }
                throw new Error('藥歷未套用抗生素分類');
            } catch (e) {
                throw new Error(e.name === 'AbortError' ? '逾時' : e.message);
            } finally { clearTimeout(timer); }
        });
    }

    // ─── 管路（CatheterCare_Handler.aspx）：先載入該病人的 CatheterCare 頁再立刻打 handler；每條管路帶 caseno，逐條驗證
    const CATH_PERIPHERAL_RE = /留置針|IV\s*Catheter/i;   // 周邊留置針不列入
    const tubeText = (node, tag) => { const e = node.getElementsByTagName(tag)[0]; return e ? e.textContent.trim() : ''; };
    const parseInsert = (t) => {
        const m = t.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : NaN;
    };

    async function fetchTubes(p, now) {
        return pageGate(async () => {
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

    // ─── 生命徵象（OuterData vitalsign；解析在 lib/news2.js，與晨間簡報同一套）→ TPR／O2／IO／GCS 資料塊
    const OUTER_TIMEOUT_MS = 30000;
    const ctxOf = (p) => ({ AccountIdse: p.caseno, PersonId: '', ChartNo: p.chartNo, DeptCode: '', EmpDeptCode: '' });

    async function fetchVitals(p) {
        const html = await NTUHAsmx.outerData('vitalsign', { context: ctxOf(p), timeoutMs: OUTER_TIMEOUT_MS });
        const doc = parseHtml(html);
        let texts = [...doc.querySelectorAll('[id$="_Content"]')].map(txt);
        if (!texts.length) texts = [...doc.querySelectorAll('tr')].map(txt);
        return { obs: NTUHNews2.parseVitalRows(texts), uo: NTUHNews2.parseUo(texts) };
    }

    // 每個資料塊 { t: 要填進欄位的文字, tip: 滑鼠停上去顯示的量測時間 }；超過 24 小時的舊資料會在文字後面註明日期，避免誤當成現在的值
    function vitalsChips(v, now) {
        const obs = v.obs;
        const mdhm = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}`; };
        const md = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
        const lastWith = (fn) => { for (let i = obs.length - 1; i >= 0; i--) if (fn(obs[i])) return obs[i]; return null; };
        const stamp = (t, ms) => (now - ms > 86400000 ? `${t} (${md(ms)})` : t);
        const mk = (t, ms) => ({ t: stamp(t, ms), tip: '量測 ' + mdhm(ms) });
        const out = { tpr: [], o2: [], io: [], gcs: [] };
        const isN = (x) => typeof x === 'number' && Number.isFinite(x);

        const tp = lastWith((o) => isN(o.T) || isN(o.P) || isN(o.R));
        const bp = lastWith((o) => isN(o.SBP));
        // BP 與 TPR 量測時間在 30 分鐘內就併成一顆，否則各自一顆（各自帶自己的量測時間）
        const joined = tp && bp && Math.abs(bp.ms - tp.ms) <= 30 * 60000;
        if (tp) {
            const parts = [isN(tp.T) && `T${tp.T}`, isN(tp.P) && `P${tp.P}`, isN(tp.R) && `R${tp.R}`].filter(Boolean);
            if (joined) parts.push(`BP${bp.SBP}/${bp.DBP}`);
            out.tpr.push(mk(parts.join(' '), tp.ms));
        }
        if (bp && !joined) out.tpr.push(mk(`BP${bp.SBP}/${bp.DBP}`, bp.ms));
        const last24 = obs.filter((o) => o.ms >= now - 86400000);
        const temps = last24.filter((o) => isN(o.T));
        if (temps.length) {
            const top = temps.reduce((a, b) => (b.T > a.T ? b : a));
            out.tpr.push({ t: `Tmax ${top.T} (24h)`, tip: '24 小時內最高體溫，量測 ' + mdhm(top.ms) });
        }

        const sp = lastWith((o) => isN(o.SpO2));
        if (sp) {
            const x = NTUHNews2.oxygenInfo(sp.inside);
            const how = sp.onOxygen ? [x.device, x.flow !== null ? x.flow + 'L' : ''].filter(Boolean).join(' ') || '給氧' : 'RA';
            out.o2.push(mk(`SpO2 ${sp.SpO2}% ${how}`, sp.ms));
            const chg = NTUHNews2.o2Change(last24.filter((o) => isN(o.SpO2)));
            if (chg) out.o2.push({ t: chg.text, tip: '近 24 小時給氧變化' });
        }

        if (v.uo) out.io.push({ t: `U/O ${v.uo.val}${v.uo.ms ? ` (${md(v.uo.ms)})` : ''}`, tip: v.uo.ms ? '尿量，時間 ' + mdhm(v.uo.ms) : '院內未標日期的尿量' });

        const g = lastWith((o) => o.gcs);
        if (g) {
            const m = g.gcs.match(/E(\d+)M(\d+)V(\w+)/i);
            out.gcs.push(mk(m ? `GCS E${m[1]}V${m[3]}M${m[2]}` : `GCS ${g.gcs}`, g.ms));
        }
        return out;
    }

    // ─── 右側面板：資料塊（可拖進任何填寫欄）──────────────────
    const abxText = (x) => `${x.name}${x.route ? ' ' + x.route : ''} D${x.day}`;
    const tubeTextOf = (x) => `${x.name} D${x.day}`;
    // cat＝資料塊的類別（對應標籤名稱），放進欄位時會把該行標籤自動換成它
    const chip = (t, cls, label, tip, cat) => `<span class="chip${cls || ''}" draggable="true" data-t="${esc(t)}" data-c="${esc(cat)}"${tip ? ` title="${esc(tip)}"` : ''}>${esc(label || t)}</span>`;
    const tipChips = (list, cat) => (list.length ? list.map((x) => chip(x.t, '', '', x.tip, cat)).join('') : '<span class="mu">—</span>');
    function chipsHtml(items, fmt, allLabel, cat) {
        if (!items.length) return '<span class="mu">—</span>';
        const texts = items.map(fmt);
        return texts.map((t) => chip(t, '', '', '', cat)).join('') + (texts.length > 1 ? chip(texts.join(', '), ' all', allLabel, '', cat) : '');
    }

    const HEAVY_POOL = 2;   // 同時處理的病人數（藥歷與管路各有自己的閘門）

    async function fetchPanel(w, patients, state) {
        if (state.running) return;
        state.running = true;
        const set = (id, html) => { if (!w.closed) { const el = w.document.getElementById(id); if (el) el.innerHTML = html; } };
        const prog = (t) => set('sd-prog', esc(t));
        const t0 = nowMs();
        const now = nowMs();
        const VIT = ['tpr', 'o2', 'io', 'gcs'];
        const CAT = { tpr: 'TPR', o2: 'O2', io: 'IO', gcs: 'GCS' };
        patients.forEach((_, i) => {
            set(`sd-${i}-abx`, '<span class="mu">等待中…</span>'); set(`sd-${i}-tubes`, '<span class="mu">等待中…</span>');
            VIT.forEach((k) => set(`sd-${i}-${k}`, '<span class="mu">抓取中…</span>'));
        });
        let done = 0, next = 0;
        const total = patients.length;
        prog('載入生命徵象…');
        // 階段一（輕）：所有病人的生命徵象一起發（併發由 lib 限制）；階段二（重）：抗生素＋管路依病人順序小批處理
        await Promise.all(patients.map(async (p, i) => {
            try {
                const ch = vitalsChips(await fetchVitals(p), nowMs());
                VIT.forEach((k) => set(`sd-${i}-${k}`, tipChips(ch[k], CAT[k])));
            } catch (e) {
                VIT.forEach((k) => set(`sd-${i}-${k}`, `<span class="er">未取得：${esc(e.message)}</span>`));
            }
        }));
        prog(`載入中 0/${total}`);
        const worker = async () => {
            while (next < patients.length && !w.closed) {
                const i = next++;
                const p = patients[i];
                const abx = fetchAbx(p, now).then((r) => set(`sd-${i}-abx`, chipsHtml(r, abxText, '全部抗生素', 'Abx')),
                    (e) => set(`sd-${i}-abx`, `<span class="er">未取得：${esc(e.message)}</span>`));
                set(`sd-${i}-tubes`, '<span class="mu">抓取中…</span>');
                const tubes = fetchTubes(p, now).then((r) => set(`sd-${i}-tubes`, chipsHtml(r, tubeTextOf, '全部管路', 'Tubes')),
                    (e) => set(`sd-${i}-tubes`, `<span class="er">未取得：${esc(e.message)}</span>`));
                await Promise.all([abx, tubes]);
                prog(`載入中 ${++done}/${total}`);
            }
        };
        try {
            await Promise.all(Array.from({ length: Math.min(HEAVY_POOL, patients.length) }, worker));
            prog(`完成（${((nowMs() - t0) / 1000).toFixed(1)} 秒）`);
        } finally { state.running = false; }
    }

    // ═══════════════════════════════════════════════════════════
    // 進入點
    // ═══════════════════════════════════════════════════════════
    function run() {
        const patients = readPatients();
        if (!patients.length) { alert('找不到病人清單'); return; }
        const w = window.open('', '_blank');
        if (!w) { alert('瀏覽器擋住了新分頁，請允許此網站的彈出視窗後再按一次。'); return; }
        const dir = learnDoctors(patients);
        const d = new Date();
        const two = (n) => String(n).padStart(2, '0');
        const today = `${d.getMonth() + 1}/${d.getDate()}`;
        const stamp = `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
        w.document.open();
        w.document.write(pageShell(patients, today, stamp, dir));
        w.document.close();
        // 抓取在這個分頁（病房列表）跑；面板的「重新抓取」按鈕用 postMessage 通知這裡（比對 token，不依賴 source 物件）
        const state = { running: false };
        const token = String(nowMs()) + Math.random().toString(36).slice(2);
        w.document.documentElement.setAttribute('data-rs-token', token);
        window.addEventListener('message', (ev) => {
            if (ev.origin === location.origin && ev.data && ev.data.rs === 'refresh' && ev.data.token === token) fetchPanel(w, patients, state);
        });
        fetchPanel(w, patients, state);
    }

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
        if (document.getElementById('ntuh-rs-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'ntuh-rs-btn';
        btn.textContent = '查房單';
        btn.onclick = run;
        // 與晨間簡報／週末病程同一做法：複製「歷史」按鈕的 class／style，接在已存在的同伴按鈕後面
        const anchor = document.querySelector('[id$="QueryInPatientPersonAccountControl1_ButtonBedPatientHistory"]');
        if (anchor) {
            btn.className = anchor.className;
            btn.style.cssText = anchor.style.cssText;
            const prev = document.getElementById('ntuh-batch-fab') || document.getElementById('ntuh-mb-btn') || anchor;
            prev.insertAdjacentElement('afterend', btn);
            btn.before(document.createTextNode(' '));
        } else {
            btn.style.cssText = 'pointer-events:auto;padding:8px 14px;border:0;border-radius:18px;background:#4f46e5;color:#fff;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.3)';
            getDock().appendChild(btn);
        }
    }

    if (location.pathname.indexOf('NoticeDrScheduling') >= 0) captureDoctors();
    else {
        mount();
        // 頁面載入後掃兩次（立刻一次、3 秒後一次）：title 有值的話先記下，不需要按按鈕
        learnDoctors(readPatients());
        setTimeout(() => learnDoctors(readPatients()), 3000);
    }
}());
