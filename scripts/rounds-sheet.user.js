// ==UserScript==
// @name         NTUH 查房單
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      1.5.2
// @description  病房列表一鍵產生可編輯、可列印的 A4 查房單（一頁 11 位）：帶入病人資料及預出院／已出院日期，CR／VS 分列自動配對姓名、員編與簡碼，可新增或選擇僅此頁／所有頁面移除；右側資料塊可拖入同一病人欄位，手動填寫與人員增刪選擇自動暫存
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/OpenWard.aspx*
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-asmx.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/news2.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/ntuh-fetch.js
// @require      https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/lab-rules.js
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rounds-sheet.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rounds-sheet.user.js
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      ihisaw.ntuh.gov.tw
// ==/UserScript==

(function () {
    'use strict';

    /* global NTUHAsmx, NTUHNews2, NTUHFetch, NTUHLab */

    const VERSION = '1.5.2';                      // 與上方 @version 同步；顯示在查房單工具列，方便確認跑的是哪一版
    const PER_PAGE = 11;                          // 一頁病人數（預設；沒有人加行時的分頁，與紙本模板一致）
    const PAGE_LINES = 44;                        // 一頁可放幾「行」（資訊行＋每行文字，6mm 一行；11 位×4 行＝44，所以預設仍是每頁 11 位）
    const DEFAULT_ROWS = [0, 1, 2];               // 每位病人預設的行 id；最後一行右側的＋／−增減
    const MAX_ROWS = 8;
    const MIN_ROWS = 2;
    const LABELS = ['Abx', 'Lab', 'Tubes'];        // 各行標籤的預設值（依行 id）
    const RATIO = [2, 1, 1];                      // 三欄寬度比例預設（筆記｜標籤＋填寫｜勾選＋待辦），尺規可調
    // 選到（或輸入）這些標籤時，同一行的填寫欄若是空的就自動帶入範本
    const LABEL_TEMPLATES = { GCS: 'E.  V.  M.  ', MP: 'RU/LU/RL/LL:   /   /   /   ' };
    const NEW_MAX_DAY = 2;   // 住院第幾天以內算「新入院」（入院當天＝Day 1）
    const LABEL_OPTIONS = ['TPR', 'O2', 'IO', 'BW', 'GCS', 'Abx', 'Lab', 'Tubes', 'Image', 'MP'];  // 點標籤彈出的選項（兩排各 5 個），也可自行輸入
    const STORE_KEY = 'ntuh-rounds-sheet:v1';
    const KEEP_DAYS = 30;                         // 超過幾天沒再出現在列表的病人，暫存內容自動清掉

    const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

    const nk = (name) => String(name || '').trim();
    const patientName = (name) => String(name || '').replace(/\[禁\]/g, '').trim();

    // EBoard 請求／回應契約見 docs/endpoints/eboard.md；本腳本僅呼叫 DrInfo。
    // transport 保留原始 JSON；人員選取只讀 assignmentRecords，不合併 directory。
    const EBOARD_URL = 'https://ihisaw.ntuh.gov.tw/WebApplication/EBoard/EBoardInfoHandler.ashx';
    const EBOARD_HEADERS = {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Requested-With': 'XMLHttpRequest',
    };
    const staffCache = new Map();
    const STAFF_CACHE_MS = 10 * 60000;
    const hospitalOf = (account) => String(account || '').trim().match(/^\d*(\D.)/)?.[1] || '';
    const staffText = (value) => value === null || value === undefined ? '' : String(value).trim();
    const staffPerson = (record) => ({ EmpName: nk(record.EmpName), EmpNo: staffText(record.EmpNo), PhoneCode: record.PhoneCode === null || record.PhoneCode === undefined ? null : String(record.PhoneCode) });
    const staffBeds = (record) => new Set(staffText(record.TakeCareBedList).split(',').map((b) => b.trim()).filter(Boolean));

    function physicianName(cell) {
        if (!cell) return '';
        const copy = cell.cloneNode(true);
        copy.querySelectorAll('button,input,select,svg,img,[role="button"],script,style').forEach((el) => el.remove());
        // 保留姓名內的空白，僅移除前後空白；新增按鈕／圖示不屬於姓名。
        return nk(copy.textContent);
    }

    function getTaipeiDate(now = new Date()) {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
        const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
        return `${values.year}/${values.month}/${values.day}`;
    }

    function buildEboardBody({ accountIdSe, wardCode, date = getTaipeiDate() }) {
        const hospitalCode = hospitalOf(accountIdSe);
        if (!hospitalCode) throw new Error('AccountIDSE 缺少可擷取的院區碼');
        if (!staffText(wardCode)) throw new Error('缺少病房代碼');
        return JSON.stringify({ HospitalCode: hospitalCode, WardCode: wardCode.trim(), StartDate: date, EndDate: date, ActiveFlag: 'Y', QueryNews2: 'N', Mode: 'DrInfo' });
    }

    function gmFetchEboardInfo(options) {
        const body = buildEboardBody(options);
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST', url: EBOARD_URL, headers: EBOARD_HEADERS, data: body,
                responseType: 'text', anonymous: false, timeout: 20000,
                onload: (response) => {
                    if (response.status < 200 || response.status >= 300) { reject(new Error(`EBoard HTTP ${response.status}`)); return; }
                    try { resolve(JSON.parse(response.responseText)); }
                    catch { reject(new Error('EBoard 未回傳有效 JSON；請確認登入狀態與回應類型')); }
                },
                onerror: () => reject(new Error('EBoard 網路請求失敗')),
                ontimeout: () => reject(new Error('EBoard 請求逾時')),
                onabort: () => reject(new Error('EBoard 請求已取消')),
            });
        });
    }

    function getStaffAssignments(options) {
        options = { ...options, date: options.date || getTaipeiDate() };
        const body = JSON.parse(buildEboardBody(options));
        const key = [body.HospitalCode, body.WardCode, body.StartDate, body.Mode].join('|');
        const hit = staffCache.get(key);
        if (hit && (hit.pending || Date.now() - hit.at < STAFF_CACHE_MS)) return hit.promise;
        // 每次呼叫清除過期記憶體；不持久保存 response 或病人清單。
        for (const [k, entry] of staffCache) if (!entry.pending && Date.now() - entry.at >= STAFF_CACHE_MS) staffCache.delete(k);
        const entry = { pending: true, at: 0 };
        entry.promise = gmFetchEboardInfo(options).then((data) => {
            if (!Array.isArray(data) || !Array.isArray(data[0]) || data[0].some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('EBoard DrInfo 格式不符');
            entry.pending = false;
            entry.at = Date.now();
            return data;
        }).catch((error) => { staffCache.delete(key); throw error; });
        staffCache.set(key, entry);
        return entry.promise;
    }

    // VS 只按 DRVS 與 trim 後姓名精確配對，不檢查床位；多筆即報錯，不去重後選第一筆。
    function selectVS(data, name) {
        const matches = data[0].filter((r) => r.RoleFilter === 'DRVS' && nk(r.EmpName) === nk(name) && nk(name));
        if (matches.length > 1) throw new Error('VS 同名匹配超過一筆，無法判定');
        return matches.length ? { status: 'found', person: staffPerson(matches[0]) } : { status: 'not-found' };
    }

    function resolveStaffBed(data, baseBed) {
        if (!baseBed) return '';
        const beds = new Set(data[0].flatMap((r) => [...staffBeds(r)]));
        const variants = [baseBed, `${baseBed}N`].filter((b) => beds.has(b));
        // N 代表此床的新病人，非 N 可能是前一位或轉床病人，不能當作當日出院。
        // 本腳本尚未用 PlanCheckIn 核實歸屬；混合分配時留空，不猜測或去除 N。
        return variants.length > 1 ? '' : variants[0] || baseBed;
    }

    // CR 候選須為 DRRS 且覆蓋本列印頁至少一個完整床位 token。
    // scoringPatients 是同院區／病房「目前表格全部病人」，不只本列印頁；
    // score 計算其照護病人中，住院醫師姓名不是自己的筆數，僅保留 score > 0。
    // 依 score、完整去重照護床數遞減排序；同分保留所有人。清單外床位不能加分。
    // 缺床位／住院姓名會使該範圍計分不足；重複員編不自行合併。VS 可獨立繼續。
    // 回傳 { status: found|not-found|insufficient-data, candidates, warnings }；
    // 分頁／篩選可能限制計分範圍，不能宣稱已涵蓋完整病房。
    function selectCR(data, pagePatients, scoringPatients) {
        const warnings = [];
        if (pagePatients.some((p) => !p.bedToken)) warnings.push('本頁部分床位 N 歸屬未核實，未用於候選覆蓋判定');
        const pageBeds = new Set(pagePatients.map((p) => p.bedToken).filter(Boolean));
        const matches = data[0].filter((r) => r.RoleFilter === 'DRRS' && [...staffBeds(r)].some((bed) => pageBeds.has(bed)));
        const candidates = [];
        matches.forEach((r) => {
            const person = staffPerson(r), beds = staffBeds(r);
            if (!person.EmpName || !person.EmpNo) { warnings.push('CR 候選缺少姓名或員編'); return; }
            if (data[0].filter((other) => other.RoleFilter === 'DRRS' && staffText(other.EmpNo) === person.EmpNo).length > 1) { warnings.push('CR 員編重複，未確認合併規則，已略過'); return; }
            // 不完整資料可能影響排序，不把空姓名當作不同醫師，也不猜 N。
            if (!scoringPatients.length || scoringPatients.some((p) => !p.bedToken || !nk(p.resident))) { warnings.push('CR 計分資料不足（床號／住院醫師缺失或 N 歸屬未核實）'); return; }
            const score = scoringPatients.filter((p) => beds.has(p.bedToken) && nk(p.resident) !== person.EmpName).length;
            if (score > 0) candidates.push({ ...person, score, bedCount: beds.size });
        });
        candidates.sort((a, b) => b.score - a.score || b.bedCount - a.bedCount);
        return { status: candidates.length ? 'found' : warnings.length ? 'insufficient-data' : 'not-found', candidates, warnings: [...new Set(warnings)] };
    }

    // 分頁：沒人加行 → 每頁 PER_PAGE 位；有人加行 → 依實際行數（資訊行＋各行）由上往下排，放不下就換頁
    const rowsOfPatient = (p, rowsMap) => (rowsMap && rowsMap[p.chartNo || p.caseno]) || DEFAULT_ROWS;
    function paginate(patients, rowsMap) {
        if (!patients.some((p) => rowsOfPatient(p, rowsMap).length !== DEFAULT_ROWS.length)) {
            const out = [];
            for (let i = 0; i < patients.length; i += PER_PAGE) out.push(patients.slice(i, i + PER_PAGE));
            return out;
        }
        const out = [];
        let page = [], used = 0;
        patients.forEach((p) => {
            const lines = 1 + rowsOfPatient(p, rowsMap).length;
            if (page.length && used + lines > PAGE_LINES) { out.push(page); page = []; used = 0; }
            page.push(p); used += lines;
        });
        if (page.length) out.push(page);
        return out;
    }

    function staffStatus(result) {
        const messages = { 'not-found': '未找到符合條件的人員', 'insufficient-data': 'CR 計分資料不足', error: '無法取得人員' };
        return result.status === 'found' ? 'DrInfo 配對；CR 計分僅目前病房列表，可能受篩選／分頁限制' : result.reason || messages[result.status] || '無法判定';
    }

    async function buildStaffHeaders(patients, groups) {
        const pageGroups = groups || paginate(patients);
        const scopes = new Map(), loaded = new Map();
        const scopeKey = (p) => `${hospitalOf(p.caseno)}|${p.ward}`;
        patients.forEach((p) => { const key = scopeKey(p); if (!scopes.has(key)) scopes.set(key, []); scopes.get(key).push(p); });
        const date = getTaipeiDate();
        await Promise.all([...scopes].map(async ([key, scope]) => {
            try {
                const data = await getStaffAssignments({ accountIdSe: scope[0].caseno, wardCode: scope[0].ward, date });
                const scoring = scope.map((p) => ({ ...p, bedToken: resolveStaffBed(data, p.staffBed === undefined ? p.bed : p.staffBed) }));
                loaded.set(key, { data, scoring });
            } catch (error) { loaded.set(key, { error: error.message }); }
        }));
        const pages = [];
        for (const [gi, page] of pageGroups.entries()) {
            const cr = [], vs = [], warnings = [];
            for (const key of new Set(page.map(scopeKey))) {
                const group = loaded.get(key);
                if (group.error) { warnings.push(group.error); continue; }
                const pageScope = page.filter((p) => scopeKey(p) === key).map((p) => group.scoring.find((row) => row.caseno === p.caseno));
                const result = selectCR(group.data, pageScope, group.scoring);
                warnings.push(...result.warnings);
                result.candidates.forEach((person) => cr.push({ id: `CR-${staffHash(key + '|' + person.EmpNo)}`, person, title: `CR score ${person.score}；完整照護床數 ${person.bedCount}` }));
            }
            cr.sort((a, b) => b.person.score - a.person.score || b.person.bedCount - a.person.bedCount);
            pageDocs(page).forEach((name) => {
                const results = [];
                for (const key of new Set(page.filter((p) => nk(p.attending) === name).map(scopeKey))) {
                    const group = loaded.get(key);
                    try { results.push(group.error ? { status: 'error', reason: group.error } : selectVS(group.data, name)); }
                    catch (error) { results.push({ status: 'error', reason: error.message }); }
                }
                const first = results[0];
                const same = results.every((r) => JSON.stringify(r) === JSON.stringify(first));
                const result = same ? first : { status: 'error', reason: '跨病房 VS 資料不一致，請手動核對' };
                vs.push({ id: `VS-${staffHash(name)}`, person: result.status === 'found' ? result.person : { EmpName: name }, title: staffStatus(result) });
            });
            const title = [...new Set(warnings)].join('；') || 'CR 僅列 score > 0 且覆蓋本頁的候選；計分僅目前列表，可能受篩選／分頁限制';
            pages.push({ pg: gi + 1, cr, vs, title });
        }
        return pages;
    }

    function staffHash(value) {
        let hash = 2166136261;
        for (const c of value) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
        return (hash >>> 0).toString(36);
    }

    // 動態頁首第一排 CR、第二排 VS；各頁編輯與新增獨立，移除可選此頁／全部頁。
    // 自動配對值不持久保存；已修改／已暫存的姓名不能接上另一人的員編、簡碼。
    // h:v2 以頁面病人集合＋人員／院區病房識別，避免排序變動時誤套舊值；不讀舊版位置鍵。
    // __staffV2 僅記錄新增欄位與移除 ID；全頁移除也要標記尚未收到該人的頁面，防止延遲回應加回。
    function applyStaffHeaders(doc, pages, state) {
        pages.forEach(({ pg, cr, vs, title }) => {
            const header = doc.querySelector(`.hdr[data-page="${pg}"]`);
            if (!header) return;
            header.title = title;
            for (const [role, people] of [['CR', cr], ['VS', vs]]) {
                const row = header.querySelector(`[data-role="${role}"]`);
                row.title = title;
                people.forEach((person) => state.upsert(header, row, person));
            }
        });
        state.changed();
    }

    function installStaffHeaders(doc, store, save, fill, changed, staffHash, nk) {
        const metadata = store.__staffV2 || (store.__staffV2 = {});
        const pageState = (header) => metadata[header.dataset.scope] || (metadata[header.dataset.scope] = { removed: [], added: [] });
        const create = (header, row, id, person = {}, title = '') => {
            const slot = doc.createElement('span');
            slot.className = 'hf'; slot.dataset.slot = id; slot.title = title;
            const savedName = store[`h:v2:${header.dataset.scope}:${id}:a`];
            const changedIdentity = savedName !== undefined && nk(savedName) !== person.EmpName;
            if (changedIdentity) slot.title += '；保留手動姓名，未帶入其他人員資料';
            ['EmpName', 'EmpNo', 'PhoneCode'].forEach((field, i) => {
                if (i) slot.appendChild(doc.createTextNode('('));
                const el = doc.createElement('input');
                el.className = `u ${['w9', 'w8', 'w7'][i]}`;
                el.autocomplete = 'off'; el.spellcheck = false;
                el.dataset.k = `h:v2:${header.dataset.scope}:${id}:${['a', 'b', 'c'][i]}`;
                if ((!i || !changedIdentity) && person[field] !== null && person[field] !== undefined) el.dataset.def = person[field];
                slot.appendChild(el); fill(el);
                if (i) slot.appendChild(doc.createTextNode(')'));
            });
            const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'staff-remove'; remove.textContent = '−'; remove.title = '移除此人員';
            const menu = doc.createElement('span'); menu.className = 'staff-remove-menu'; menu.hidden = true;
            const removeFrom = (headers) => {
                headers.forEach((target) => {
                    const saved = pageState(target);
                    if (!saved.removed.includes(id)) saved.removed.push(id);
                    saved.added = saved.added.filter((item) => item.id !== id);
                    target.querySelectorAll('[data-slot]').forEach((item) => { if (item.dataset.slot === id) item.remove(); });
                });
                save(); changed();
            };
            [['僅此頁移除', () => removeFrom([header])], ['所有頁面移除', () => removeFrom([...doc.querySelectorAll('.hdr[data-page]')])], ['取消', () => { menu.hidden = true; }]].forEach(([label, action]) => {
                const button = doc.createElement('button'); button.type = 'button'; button.textContent = label; button.onclick = action; menu.appendChild(button);
            });
            remove.onclick = () => {
                const opening = menu.hidden;
                doc.querySelectorAll('.staff-remove-menu').forEach((item) => { item.hidden = true; });
                menu.hidden = !opening;
            };
            slot.appendChild(remove); slot.appendChild(menu); row.querySelector('.staff-slots').appendChild(slot);
            return slot;
        };
        doc.querySelectorAll('.hdr[data-page]').forEach((header) => {
            const saved = pageState(header);
            saved.added.forEach(({ role, id }) => create(header, header.querySelector(`[data-role="${role}"]`), id));
            header.querySelectorAll('.staff-add').forEach((button) => {
                button.onclick = () => {
                    const role = button.closest('[data-role]').dataset.role;
                    const id = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
                    saved.added.push({ role, id });
                    create(header, button.closest('[data-role]'), id); save(); changed();
                };
            });
            // VS 姓名先可見，與稍後配對使用同一穩定 id。
            JSON.parse(header.dataset.names).forEach((name) => {
                const id = `VS-${staffHash(name)}`;
                if (!saved.removed.includes(id)) create(header, header.querySelector('[data-role="VS"]'), id, { EmpName: name });
            });
        });
        return {
            changed,
            upsert(header, row, { id, person, title }) {
                if (pageState(header).removed.includes(id)) return;
                let slot = [...row.querySelectorAll('[data-slot]')].find((el) => el.dataset.slot === id);
                if (!slot) { create(header, row, id, person, title); return; }
                slot.title = title;
                const inputs = [...slot.querySelectorAll('input')];
                if (inputs[0].hasAttribute('data-staff-manual') && nk(inputs[0].value) !== person.EmpName) { slot.title += '；保留手動姓名，未帶入其他人員資料'; return; }
                ['EmpName', 'EmpNo', 'PhoneCode'].forEach((field, i) => {
                    if (!inputs[i].hasAttribute('data-staff-manual') && person[field] !== null && person[field] !== undefined) { inputs[i].dataset.def = person[field]; inputs[i].value = person[field]; }
                });
            },
        };
    }

    // ═══════════════════════════════════════════════════════════
    // 病房列表 → 病人清單（元素 id 前綴會變，一律用尾綴選取）
    // ═══════════════════════════════════════════════════════════
    function readPatients() {
        const table = document.querySelector('[id$="DataGridAccountList"]');
        if (!table) return [];
        const out = [];
        const headers = [...table.rows[0].cells].map(txt);
        const column = (labels) => headers.findIndex((label) => labels.includes(label));
        const attendingCol = column(['主治', '主治醫師']), residentCol = column(['住院', '住院醫師']), admissionCol = (() => { const exact = column(['入院日', '入院日期']); return exact >= 0 ? exact : headers.findIndex((label) => /入院/.test(label)); })();
        for (const tr of [...table.rows].slice(1)) {
            const news = tr.querySelector('[id$="NEWSLabel"]');
            const caseno = news && news.getAttribute('caseno');
            if (!caseno) continue;
            const cells = [...tr.cells];
            // 入院日：先看表頭對到的欄；表頭文字對不到（改版、帶排序符號等）或內容不像日期時，退回「第 9 欄起第一個長得像日期的格子」
            const dateRe = /\d{2,4}\s*[\/.-]\s*\d{1,2}\s*[\/.-]\s*\d{1,2}/;
            let adm = admissionCol >= 0 ? txt(cells[admissionCol]) : '';
            if (!dateRe.test(adm)) adm = cells.slice(9).map(txt).find((t) => dateRe.test(t)) || '';
            const permitTitle = tr.querySelector('[id$="LinkPermitDischarge"]')?.getAttribute('title') || '';
            const discharge = permitTitle.match(/^\s*(\d{4}\/\d{2}\/\d{2})\s+(可出院|已出院)\s*$/);
            const room = txt(tr.querySelector('[id$="RoomLabel"]')), bed = txt(tr.querySelector('[id$="BedLabel"]'));
            out.push({
                caseno,
                staffBed: room && bed ? `${room}-${bed}` : '',
                chartNo: news.getAttribute('chartno') || txt(tr.querySelector('[id$="PatChartNo"]')),
                ward: txt(tr.querySelector('[id$="WardLabel"]')),
                name: patientName(txt(tr.querySelector('[id$="LinkPatientName"]'))),
                bed: [txt(tr.querySelector('[id$="RoomLabel"]')), txt(tr.querySelector('[id$="BedLabel"]'))].filter(Boolean).join('-'),
                age: txt(tr.querySelector('[id$="PatientAge"]')),
                sex: txt(tr.querySelector('[id$="PatientSex"]')),
                attending: physicianName(cells[attendingCol]),
                resident: physicianName(cells[residentCol]),
                adm,
                dischargeDate: discharge ? discharge[1] : '',
                discharged: !!discharge && discharge[2] === '已出院',
                hospDay: (tr.innerHTML.match(/住院總天數\s*[:：]\s*(\d+)/) || [])[1] || '',
            });
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 頁面
    // ═══════════════════════════════════════════════════════════
    const NOTE_DEFAULT = '#.\n#.\n#.';              // 筆記區預設內容（三行 #.）
    const input = (key, cls, extra) => `<input class="${cls}" data-k="${esc(key)}" autocomplete="off" spellcheck="false"${extra || ''}>`;

    // 先帶入本頁主治姓名；DrInfo 配對完成後填入未編輯的姓名、員編與簡碼。
    function headerHtml(pg, patients) {
        const docs = pageDocs(patients);
        const scope = staffHash(patients.map((p) => p.caseno).join('|'));
        return `<div class="hdr" data-page="${pg}" data-scope="${scope}" data-names="${esc(JSON.stringify(docs))}">${['CR', 'VS'].map((role) => `<div class="hr" data-role="${role}"><b>${role}</b><div class="staff-slots"></div><button class="staff-add" type="button" title="新增 ${role} 人員">＋</button></div>`).join('')}</div>`;
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

    // 性別年齡：「F, 63y0m」「M, 41y3m」。性別男／女（或 M／F）→ M／F；年齡取「幾歲幾個月」，沒有月份就補 0m；認不得的格式原樣顯示
    function sexAge(p) {
        const sx = /^(男|m|male)/i.test(p.sex) ? 'M' : /^(女|f|female)/i.test(p.sex) ? 'F' : p.sex;
        const m = String(p.age).match(/(\d+)\s*(?:y|歲|岁)\s*(?:(\d+)\s*(?:m|月|個月|个月)?)?/i);
        const mo = !m && String(p.age).match(/^\s*(\d+)\s*(?:m|月|個月|个月)\s*$/i);   // 嬰兒只有月份
        const age = m ? `${m[1]}y${m[2] || 0}m` : mo ? `0y${mo[1]}m` : (/^\d+$/.test(p.age) ? `${p.age}y0m` : p.age);
        return [sx, age].filter(Boolean).join(', ');
    }
    // 預出院日：Portal 給 2026/10/21，欄位顯示成手寫習慣的「10/21」（月/日、不補零）；格式認不得就原樣
    const shortDate = (d) => { const m = String(d || '').match(/^\d{4}\/(\d{1,2})\/(\d{1,2})$/); return m ? `${+m[1]}/${+m[2]}` : String(d || ''); };
    const bedLabel = (p) => [p.ward, p.bed].filter(Boolean).join(' ');   // 病房＋床號

    // 病人資訊行左邊留白處的小圖示（NEW／抗生素藥瓶／管路／吹氣）：由資料自動亮起，也可以點一下手動開關；列印只印亮的
    const ICONS = {
        new: ['NEW', '新入院（入院第 1–' + NEW_MAX_DAY + ' 天）', '<span class="nw">NEW</span>'],
        abx: ['藥瓶', '使用中抗生素', '<svg viewBox="0 0 24 24"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M7 6h10v2l1 2v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V10l1-2z"/><path d="M9 13h6M9 16h6"/></svg>'],
        tube: ['管路', '有留置管路', '<svg viewBox="0 0 24 24"><path d="M5 19c0-7 7-3 8-9s4-6 6-6"/><circle cx="5" cy="19" r="2"/><path d="M17 2l4 4"/></svg>'],
        o2: ['吹氣', '給氧中（有給氧裝置）', '<svg viewBox="0 0 24 24"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h8"/></svg>'],
    };
    const iconsHtml = (isNew) => `<div class="ics">${Object.entries(ICONS).map(([k, [, tip, svg]]) => `<span class="ic" data-ic="${k}"${k === 'new' && isNew ? ' data-auto="1"' : ''} title="${esc(tip)}（點一下手動開關）">${svg}</span>`).join('')}</div>`;

    // 標籤區／勾選區的單元由頁面腳本產生（見 UNITS），這裡只留空的 .c2／.c3
    function blockHtml(p, rows = DEFAULT_ROWS) {
        const id = p.chartNo || p.caseno;
        const k = (n) => `p:${id}:${n}`;
        const row = (r, last) => `<div class="ln" data-r="${r}"><div class="c2"></div><div class="c3"></div>${last ? '<span class="rctl"><button type="button" class="radd" title="在最後新增一行">＋</button><button type="button" class="rdel" title="移除最後一行（至少保留 2 行）"' + (rows.length <= MIN_ROWS ? ' disabled' : '') + '>−</button></span>' : ''}</div>`;
        const info = [
            bedLabel(p) && `<b>${esc(bedLabel(p))}</b>`,
            `<b>${esc(patientName(p.name))}</b>`,
            sexAge(p) && `（${esc(sexAge(p))}）`,
            esc(p.chartNo),
            p.adm && `入 ${esc(p.adm)}${dayOf(p) ? ` (D${esc(dayOf(p))})` : ''}`,
        ].filter(Boolean).join('<span class="sep"></span>');
        const discharge = `<div class="discharge">${p.discharged ? '已出院' : '預出院'}${input(k('dc'), 'u w6', ` data-def="${esc(shortDate(p.dischargeDate))}"`)}</div>`;
        const doctors = `<div class="staff-vr"><span title="${esc(p.attending)}">${p.attending ? `VS ${esc(p.attending)}` : ''}</span><span title="${esc(p.resident)}">${p.resident ? `R ${esc(p.resident)}` : ''}</span></div>`;
        const dn = parseInt(dayOf(p), 10);
        return `<section class="pt" data-id="${esc(id)}" style="--rows:${rows.length}">${iconsHtml(dn >= 1 && dn <= NEW_MAX_DAY)}
<div class="ln info"><div class="il">${info}</div>${discharge}${doctors}</div>
<div class="pbody"><div class="c1">${`<textarea class="nt" data-k="${esc(k('n'))}" data-def="${esc(NOTE_DEFAULT).replace(/\n/g, '&#10;')}" rows="1" autocomplete="off" spellcheck="false"></textarea>`}</div><div class="prows">
${rows.map((r, ord) => row(r, ord === rows.length - 1)).join('\n')}
</div></div>
</section>`;
    }

    function pageDocs(pp) {
        const seen = new Set(), out = [];
        pp.forEach((p) => {
            const nm = nk(p.attending);
            if (!nm || seen.has(nm)) return;
            seen.add(nm);
            out.push(nm);
        });
        return out;
    }

    function sideHtml(patients) {
        // 每位病人一個區塊，高度與位置由頁面腳本對齊左邊該病人的區塊；2 欄 × 3 列：Abx|TPR、Tubes|O2、GCS|IO
        const rows = [['Abx', 'abx'], ['TPR', 'tpr'], ['Tubes', 'tubes'], ['O2', 'o2'], ['GCS', 'gcs'], ['IO', 'io']];
        return `<aside class="side"><div class="rz" id="rz" title="拖曳調整面板寬度"></div>
<div class="sdt"><div class="sdh"><b>資料</b><span id="sd-prog" class="mu"></span><button id="sd-re" type="button">重新抓取</button></div>
<div class="sdn">資料塊可拖進左邊同一位病人的欄位（需保持病房列表分頁開著）</div><div id="sd-warn" class="er" hidden>⚠ 病房列表分頁已重新整理、關閉或登入逾時，這裡無法再抓資料。請回病房列表重新按「查房單」。</div></div>
${patients.map((p, i) => `<div class="sp" data-id="${esc(p.chartNo || p.caseno)}"><div class="sh"><span class="shn" title="點一下捲到左邊這位病人">${esc([bedLabel(p), p.name].filter(Boolean).join(' '))}</span><span class="bt" data-kind="lab" data-i="${i}">Lab</span><span class="bt" data-kind="img" data-i="${i}">影像</span><span class="bt" data-kind="pn" data-i="${i}">病程</span></div>
<div class="sg">${rows.map(([l, k]) => `<div class="sr"><span class="sk">${l}</span><div class="sc" id="sd-${i}-${k}"><span class="mu">等待中…</span></div></div>`).join('')}</div>
</div>`).join('')}
</aside>
<div id="dlg" hidden data-seq="0"><div class="dh"><b id="dlg-t"></b><button type="button" id="dlg-c">複製全部</button><button type="button" id="dlg-x">✕</button></div><div id="dlg-body"></div></div>`;
    }

    function pageShell(patients, today, stamp, groups, rowsMap) {
        const pages = groups || paginate(patients, rowsMap);
        return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>查房單 ${esc(today)}</title>
<style>
@page{size:A4;margin:0}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;background:#e5e7eb;color:#111;font:10.5pt/1 system-ui,"Noto Sans TC","PingFang TC",sans-serif}
.bar{position:sticky;top:0;z-index:5;height:37px;display:flex;gap:10px;align-items:center;padding:8px 16px;background:#1f2937;color:#fff;font-size:13px}
.bar button{padding:5px 14px;border:0;border-radius:6px;background:#0f766e;color:#fff;font-size:13px;cursor:pointer}
.ruler{position:sticky;top:37px;z-index:4;width:210mm;height:20px;margin:6px 0 0 12px;background:#fff;background-image:repeating-linear-gradient(90deg,#9ca3af 0 1px,transparent 1px 10mm);background-size:calc(100% - 18mm) 6px;background-position:9mm 14px;background-repeat:no-repeat;box-shadow:0 1px 4px rgba(0,0,0,.25);user-select:none}
.rl{position:absolute;left:9mm;right:9mm;top:0;bottom:0}
.hd{position:absolute;top:2px;width:14px;margin-left:-7px;height:16px;cursor:ew-resize;touch-action:none}
.hd::before{content:"";position:absolute;left:1px;top:2px;border:6px solid transparent;border-top:10px solid #0f766e;border-bottom:0}
.hd::after{content:"";display:none;position:absolute;left:6px;top:20px;height:100vh;border-left:1px dashed #0f766e;pointer-events:none}
.hd.on::after{display:block}
.bar button.g{background:#4b5563}.bar .m{color:#9ca3af;margin-left:auto;font-size:12px}
.gen{position:absolute;left:9mm;top:2.5mm;font-size:6.5pt;color:#6b7280}
.page{position:relative;width:210mm;height:297mm;margin:14px 0 14px 12px;padding:7mm 9mm;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);overflow:visible;break-after:page}
.hdr{font-size:10pt;min-height:15mm}
.hr{display:flex;align-items:flex-start;gap:2mm;min-height:7.5mm;padding:1mm 0}
.hr>b{width:6mm;flex:none;line-height:5.5mm}.staff-slots{display:flex;flex:1;flex-wrap:wrap;gap:1mm 3mm;min-width:0}
.hf{position:relative;display:inline-flex;align-items:baseline;white-space:nowrap;max-width:100%}
.staff-remove-menu{position:absolute;top:100%;right:0;z-index:6;display:flex;gap:4px;padding:5px;background:#fff;border:1px solid #9ca3af;border-radius:4px;box-shadow:0 2px 6px #0003}
.staff-remove-menu[hidden]{display:none}
.staff-remove-menu button{white-space:nowrap;padding:4px 6px;cursor:pointer;font:12px system-ui}
.staff-add,.staff-remove{border:0;border-radius:3px;color:#4b5563;cursor:pointer;background:#f3f4f6;font:12px system-ui;padding:0 3px;line-height:5mm}
.staff-add{flex:none}.staff-remove{margin-left:1mm}
input,textarea{font:inherit;color:inherit;background:transparent;border:0;outline:0;padding:0;margin:0}
textarea{display:block;resize:none;overflow:hidden;line-height:1.05;overflow-wrap:anywhere;align-self:center}
input.u{border-bottom:.3mm solid #111;text-align:center;height:5.5mm}
.w6{width:11mm}.w9{width:17mm}.w8{width:14mm}.w7{width:12mm}
.pt{position:relative;height:calc(var(--lh,6mm) * (1 + var(--rows,3)));break-inside:avoid;border-bottom:.2mm solid #9ca3af;display:flex;flex-direction:column}
.ics{position:absolute;left:-8.2mm;top:.4mm;width:7.4mm;display:flex;flex-direction:column;gap:.7mm;align-items:center}
.ic{width:4.8mm;height:4.8mm;display:flex;align-items:center;justify-content:center;visibility:hidden;color:#111}
.ic.on{visibility:visible}
.ic svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.ic .nw{font:700 5.4pt/1 system-ui,sans-serif;border:.25mm solid #111;border-radius:1mm;padding:.35mm .5mm;letter-spacing:-.02em}
.ln{position:relative;display:flex;align-items:center;height:var(--lh,6mm);padding-right:1mm}
.info .il{flex:1;min-width:0;white-space:nowrap;overflow:hidden;font-size:10.5pt}
.discharge{flex:none;margin-left:3.5mm;white-space:nowrap}
.staff-vr{flex:none;margin-left:auto;padding-left:2mm;display:grid;grid-template-columns:auto auto;gap:3mm;text-align:right;white-space:nowrap}
.staff-vr span{max-width:25mm;overflow:hidden;text-overflow:ellipsis}
.il b{font-weight:700}.sep{display:inline-block;width:2.5mm}
.tx{flex:1;min-width:0;height:calc(var(--lh,6mm) - .4mm);font-size:10.5pt}
.c1,.c2,.c3{min-width:0;display:flex;align-items:center}
.c1{flex:calc(var(--r1,2) * 1000) 1 0;align-items:stretch;padding-right:2.5mm}
.pbody{display:flex;height:calc(var(--lh,6mm) * var(--rows,3))}
.prows{flex:calc((var(--r2,1) + var(--r3,1)) * 1000) 1 0;min-width:0}
.nt{flex:1;min-width:0;width:100%;height:100%;font-size:10.5pt;line-height:var(--lh,6mm);white-space:pre-wrap}
.c2{flex:calc(var(--r2,1) * 1000) 1 0}
.lunit>.tx{margin-right:2.5mm}
.c3{flex:calc(var(--r3,1) * 1000) 1 0;gap:2mm}
.cell{position:relative;flex:1 1 0;min-width:0;display:flex;align-items:center}
.lunit{position:relative;flex:1 1 0;min-width:0;height:calc(var(--span,1) * var(--lh,6mm));display:flex;align-items:flex-start}
.tx.tall{line-height:var(--lh,6mm);white-space:pre-wrap}
.lunit>.lab{margin-top:calc((var(--lh,6mm) - 5mm) / 2)}
.lunit>.tx{height:calc(var(--span,1) * var(--lh,6mm) - .4mm)}
.uh{position:absolute;left:-2.5mm;top:calc(var(--lh,6mm) / 2);transform:translateY(-50%);width:2.5mm;text-align:center;color:#cbd5e1;font:700 12px/1 system-ui,sans-serif;cursor:pointer;user-select:none;z-index:2}
.rctl{position:absolute;right:-8.6mm;top:50%;transform:translateY(-50%);display:flex;gap:.8mm;z-index:2}
.radd,.rdel{border:0;border-radius:3px;background:#f3f4f6;color:#9ca3af;cursor:pointer;font:12px system-ui;line-height:4mm;padding:0 3px}
.radd:hover,.rdel:hover{color:#4b5563;background:#e5e7eb}
.rdel:disabled{opacity:.35;cursor:not-allowed}
.uh:hover{color:#6b7280}
.cadd{display:none;flex:none;margin-top:calc((var(--lh,6mm) - 5mm) / 2);height:5mm;line-height:4.2mm;padding:0;border:1px dashed #9ca3af;border-radius:3px;background:transparent;color:#9ca3af;cursor:pointer;font:12px system-ui}
.none>.cadd,.cadd.cov{display:block}
.c2>.cadd{width:19mm}
.c3>.cadd{width:4.4mm;margin-left:1.5mm}
.cunit{position:relative;flex:1 1 0;min-width:0;height:calc(var(--span,1) * var(--lh,6mm));display:flex;gap:2mm;align-items:flex-start}
.cunit>.cell{align-items:flex-start;height:100%}
.cunit .tx{height:calc(var(--span,1) * var(--lh,6mm) - .4mm)}
.cunit .bx{margin-top:calc((var(--lh,6mm) - 3.4mm) / 2)}
.c2,.c3{position:relative;align-items:flex-start;align-self:flex-start}
.cadd.cov{position:absolute;z-index:3;top:var(--lh,6mm);left:0}
.c3>.cadd.cov{margin-left:0;left:1.5mm}
.cadd:hover{color:#0f766e;border-color:#0f766e;background:#f0fdfa}
.cgmenu{position:absolute;z-index:12;display:flex;flex-direction:column;gap:2px;padding:4px;background:#fff;border:1px solid #9ca3af;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.cgmenu[hidden]{display:none}.cgmenu button{text-align:left;white-space:nowrap;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;font:12px system-ui,sans-serif;cursor:pointer}.cgmenu button:hover{background:#fef9c3}
.tx.td{margin-left:1.5mm}
.lab{flex:none;width:19mm;margin-right:1.5mm;text-align:center;font-size:8pt;font-weight:700;height:5mm;border:.25mm solid #111;border-radius:1mm}
.bx{-webkit-appearance:none;appearance:none;flex:none;width:3.4mm;height:3.4mm;margin:0 0 0 2mm;border:.3mm solid #111;border-radius:0;position:relative;cursor:pointer;background:#fff}
.bx:checked::after{content:"✓";position:absolute;left:-.1mm;top:-1.6mm;font-size:12pt;line-height:1}
.lmenu{position:absolute;z-index:9;display:grid;grid-template-columns:repeat(5,auto);gap:3px;width:max-content;padding:4px;background:#fff;border:1px solid #9ca3af;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.lmenu[hidden]{display:none}
.lmenu button{padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f9fafb;font:12px system-ui,sans-serif;cursor:pointer}
.lmenu button:hover{background:#fef9c3}
#rs-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#b91c1c;color:#fff;padding:8px 16px;border-radius:8px;font:13px system-ui,sans-serif;opacity:0;pointer-events:none;transition:opacity .15s;z-index:20}
#rs-toast.show{opacity:1}
@media screen{
 .ic{visibility:visible;opacity:.18;cursor:pointer}.ic.on{opacity:1}
 .pt.viewing,.sp.viewing{outline:2px solid #d97706;outline-offset:-1px;background:#fffbeb}
 body.dragging .pt{opacity:.35}body.dragging .pt.mine{opacity:1;outline:2px solid #0f766e;outline-offset:-1px;background:#f0fdfa}
 .wrap{display:flex;align-items:stretch}
 .main{flex:none;width:calc(210mm + 24px)}
 .side{flex:none;position:relative;width:var(--sw,620px);background:#f9fafb;border-left:1px solid #d1d5db;font:12px/1.4 system-ui,"Noto Sans TC",sans-serif}
 .sdt{position:sticky;top:37px;z-index:3;background:#f9fafb;padding:6px 10px;border-bottom:1px solid #e5e7eb}
 .sdh{display:flex;gap:8px;align-items:center}.sdh button{margin-left:auto;padding:2px 8px;font-size:12px;cursor:pointer}
 .sdn{color:#6b7280;margin-top:2px}.mu{color:#9ca3af}.er{color:#b91c1c}
 .sp{position:absolute;left:0;right:0;box-sizing:border-box;padding:2px 10px;border-top:1px solid #e5e7eb;overflow-x:hidden;overflow-y:auto}
 .sh{display:flex;gap:6px;align-items:center;font-weight:700;font-size:11px;line-height:14px;white-space:nowrap}.shn{cursor:pointer;flex:none}
 .bt{margin-left:0;padding:0 7px;border:1px solid #0f766e;border-radius:9px;color:#0f766e;font-weight:400;cursor:pointer;background:#fff}.bt:hover{background:#ccfbf1}
 #dlg{flex:none;width:var(--dw,400px);position:sticky;top:37px;align-self:flex-start;height:calc(100vh - 37px);display:flex;flex-direction:column;background:#fff;border-left:1px solid #6b7280;border-right:1px solid #d1d5db;z-index:2;font:12px/1.5 system-ui,"Noto Sans TC",sans-serif}
 #dlg[hidden]{display:none}.dh{display:flex;gap:8px;align-items:center;padding:6px 10px;border-bottom:1px solid #e5e7eb;font-size:13px}.dh button{padding:2px 10px;cursor:pointer}#dlg-c{margin-left:auto}
 #dlg-body{overflow:auto;padding:8px 12px;user-select:text;-webkit-user-select:text;cursor:text}
 #dlg-body .lbh{margin:6px 0 1px;color:#6b7280}
 #dlg-body .tl{margin:0 0 8px;white-space:pre-wrap;line-height:1.6}#dlg-body .lbl{margin:1px 0}
  #dlg-body .pp{white-space:pre-wrap;margin:6px 0 10px}#dlg-body .im{margin:0 0 10px}.imp{white-space:pre-wrap;margin-top:2px}
 .sg{display:grid;grid-template-columns:1fr 1fr;column-gap:10px}
 .sr{display:flex;gap:4px;align-items:baseline;min-width:0;min-height:22px}.sk{flex:none;width:34px;color:#6b7280}
 .sc{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:2px 4px}.sc .mu,.sc .er{white-space:nowrap}
 .rz{position:absolute;left:0;top:0;bottom:0;width:7px;cursor:ew-resize;touch-action:none;z-index:4}.rz:hover,.rz.on{background:rgba(15,118,110,.25)}
 .chip{display:inline-block;white-space:nowrap;padding:0 7px;border:1px solid #9ca3af;border-radius:10px;background:#fff;font-size:11px;line-height:17px;cursor:grab;user-select:none}
 .chip.all{border-style:dashed;color:#4b5563}
 input:hover,input:focus,textarea:hover,textarea:focus{background:#fef9c3}
 .tx.over{outline:1px solid #dc2626;outline-offset:-1px}
 .tx,.nt{border-bottom:.2mm dotted #cbd5e1}
 .bx:hover{background:#fef9c3}
}
@media print{
 body{background:#fff}.bar,.lmenu,.ruler,.side,#dlg,.uh,.cadd,.rctl,.cgmenu,.staff-add,.staff-remove,.staff-remove-menu{display:none}
 .none>.cadd,.cadd.cov{display:none}   /* 螢幕上這兩種＋的 display:block 比上面的 .cadd 具體，列印要再蓋一次 */
 .page{margin:0;box-shadow:none}
 input:hover,input:focus,textarea:hover,textarea:focus{background:transparent}
}
</style></head><body>
<div class="bar"><button id="pr">列印</button><button class="g" id="clr">清除本頁填寫</button><button class="g" id="clrl" title="清除所有病人中間欄的標籤（回到預設）與填寫內容">清除標籤區</button><button class="g" id="clrc" title="清除所有病人右邊的勾選與待辦文字">清除勾選區</button><button class="g" id="rr">重設欄寬</button>
<span>${patients.length} 位病人・${pages.length} 頁</span><span style="color:#9ca3af">v${VERSION}</span><span class="m">自動暫存於此瀏覽器・點標籤可選預設項目；右側資料塊可拖進同一位病人的填寫欄（放進標籤右邊那格會自動換標籤）</span></div>
<div class="wrap">
<main class="main">
<div class="ruler" title="拖曳三角形調整欄寬"><div class="rl" id="rl"><i class="hd" id="h1"></i><i class="hd" id="h2"></i></div></div>
${pages.map((pp, i) => `<div class="page"><div class="gen">生成 ${esc(stamp)}</div>${headerHtml(i + 1, pp)}${pp.map((p) => blockHtml(p, rowsOfPatient(p, rowsMap))).join('')}</div>`).join('')}
</main>
${sideHtml(patients)}
</div>
<script>(${pageScript.toString()})(${JSON.stringify({ key: STORE_KEY, keep: KEEP_DAYS, labels: LABELS, options: LABEL_OPTIONS,templates: LABEL_TEMPLATES, ratio: RATIO, defaultRows: DEFAULT_ROWS, maxRows: MAX_ROWS, minRows: MIN_ROWS })}, ${applyStaffHeaders.toString()}, ${installStaffHeaders.toString()}, ${staffHash.toString()}, ${nk.toString()});<\/script></body></html>`;
    }

    // 在新分頁內執行（toString 後注入，不可引用外層變數）
    function pageScript(cfg, applyStaffHeaders, installStaffHeaders, staffHash, nk) {
        // 整張重新排版時文件會被重寫、這支腳本會再跑一次：先清掉上一輪留在 window 上的監聽與計時器
        (window.__rsWL || []).forEach(([t, f]) => window.removeEventListener(t, f));
        (window.__rsIV || []).forEach((h) => clearInterval(h));
        window.__rsWL = []; window.__rsIV = [];
        const wl = (t, f) => { window.addEventListener(t, f); window.__rsWL.push([t, f]); };
        // 世代：整張重新排版後，上一輪遺留的計時器（延遲更新、延遲排版）還會在新文件上跑；它們手上的 store 是舊的，
        // 若讓它們存檔就會把新的列數／內容蓋回舊值——所以只有最新一輪的腳本可以寫 localStorage。
        const gen = window.__rsGen = (window.__rsGen || 0) + 1;
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
            ['__rows', '__lu', '__cu'].forEach((m) => { if (store[m]) delete store[m][id]; });
        }
        const save = () => { if (window.__rsGen !== gen) return; try { localStorage.setItem(cfg.key, JSON.stringify(store)); } catch (e) { /* 無痕或被擋：只是不暫存 */ } };
        const fill = (el) => {
            const k = el.getAttribute('data-k');
            const v = store[k];
            if (el.type === 'checkbox') el.checked = !!v;
            else if (/:l\d$/.test(k)) el.value = v !== undefined ? v : cfg.labels[+k.slice(-1)] || '';
            else el.value = v !== undefined ? v : el.getAttribute('data-def') || '';
            if (k.startsWith('h:') && v !== undefined) el.setAttribute('data-staff-manual', '1');
        };
        const all = [...document.querySelectorAll('[data-k]')];
        all.forEach(fill);
        // 自動排版（放得下為原則）：單行輸入框超出就縮字；多行文字框各自找放得下的最大字級，
        // 再依「欄」統一（同一位病人的填寫欄共用、兩組待辦各自共用）。縮到 MIN_FS 仍放不下就標紅框。
        const MIN_FS = 7;
        const fits = (el, H) => el.scrollHeight <= H + 1 && el.scrollWidth <= el.clientWidth + 1;
        const fit = (el) => {   // 單行輸入框
            el.style.fontSize = '';
            if (!el.value) return;
            let size = parseFloat(getComputedStyle(el).fontSize);
            const min = el.classList.contains('lab') ? 4 : 5;
            while (el.scrollWidth > el.clientWidth + 1 && size > min) { size -= 0.5; el.style.fontSize = size + 'px'; }
        };
        // 內容實際高度（textarea 有固定高度時 scrollHeight 至少等於框高，量不到短文字的高度 → 暫時壓成 1px 再量）
        const contentH = (t) => {
            const prev = t.style.height;
            t.style.height = '1px';
            const h = t.scrollHeight;
            t.style.height = prev;
            return h;
        };
        const colOf = (t) => {
            const k = t.getAttribute('data-k') || '';
            return /:f\d(_\d+)?$/.test(k) ? 'f' + (t.getAttribute('data-ord') || '0') : 't' + (t.getAttribute('data-ord') || '0');
        };
        // 筆記區（一個大文字框）：先「對齊模式」（行高＝右邊每一行的高度，每行字對到每一行）；放不下就「緊縮模式」（行高 1.05、字級由大往小）
        const fitNote = (nt) => {
            nt.style.fontSize = ''; nt.style.lineHeight = ''; nt.classList.remove('over');
            if (!nt.value) return;
            const H = nt.clientHeight;
            if (fits(nt, H)) return;
            nt.style.lineHeight = '1.05';
            let size = parseFloat(getComputedStyle(nt).fontSize);
            for (; size >= MIN_FS; size -= 0.5) { nt.style.fontSize = size + 'px'; if (fits(nt, H)) return; }
            nt.style.fontSize = MIN_FS + 'px';
            nt.classList.add('over');
        };
        const fitBlock = (pt) => {
            pt.querySelectorAll('textarea.nt, textarea.tall').forEach(fitNote);
            const tas = [...pt.querySelectorAll('textarea.tx:not(.tall)')];
            if (!tas.length) return;
            tas.forEach((t) => { t.style.fontSize = ''; t.style.paddingTop = ''; t.style.lineHeight = ''; t.classList.remove('over'); });
            const groups = {};
            tas.forEach((t) => { (groups[colOf(t)] = groups[colOf(t)] || []).push(t); });
            Object.values(groups).forEach((g) => {
                const need = g.filter((t) => t.value).map((t) => {
                    const base = parseFloat(getComputedStyle(t).fontSize), H = t.clientHeight;
                    let size = base;
                    for (; size >= MIN_FS; size -= 0.5) { t.style.fontSize = size + 'px'; if (fits(t, H)) break; }
                    return Math.max(size, MIN_FS);
                });
                if (!need.length) { g.forEach((t) => { t.style.fontSize = ''; }); return; }
                const size = Math.min(...need);
                g.forEach((t) => {
                    const H = t.clientHeight;
                    t.style.fontSize = size + 'px';
                    if (t.value && !fits(t, H)) { t.classList.add('over'); return; }
                    // 垂直置中：單行 → 行高設成框高，由行框把字置中（比量測內容高度準）；多行 → 用上方留白置中
                    t.style.lineHeight = H + 'px';
                    if (t.scrollHeight > H + 1) {
                        t.style.lineHeight = '';
                        t.style.paddingTop = Math.max(0, (H - contentH(t)) / 2) + 'px';
                    }
                });
            });
        };
        let alignStaff = () => {};
        const fitAll = () => {
            document.querySelectorAll('.page').forEach((page) => {
                const header = page.querySelector('.hdr');
                // 這頁共幾行（每位病人＝資訊行＋各行）。沒人加行時＝4×病人數，結果與原本「依病人數縮排」相同；有加行時以實際行數算
                const lines = [...page.querySelectorAll('.pt')].reduce((n, pt) => n + 1 + pt.querySelectorAll('.ln:not(.info)').length, 0);
                const mm = 96 / 25.4;
                const available = 283 * mm - header.getBoundingClientRect().height;
                const lh = Math.max(12, Math.min(6 * mm, available / lines));
                page.style.setProperty('--lh', lh + 'px');
                page.style.height = Math.max(297 * mm, header.getBoundingClientRect().height + lh * lines + 14 * mm) + 'px';
            });
            document.querySelectorAll('.pt').forEach(fitBlock);
            document.querySelectorAll('input.lab,input.u').forEach(fit);
            // 病人資訊行（床號、姓名、性別年齡、病歷號、入院日）：右邊還有預出院與 VS／R，放不下時整行縮小字型而不是把入院日截掉
            document.querySelectorAll('.il').forEach((il) => {
                il.style.fontSize = '';
                let size = parseFloat(getComputedStyle(il).fontSize);
                while (il.scrollWidth > il.clientWidth + 1 && size > 7) { size -= 0.5; il.style.fontSize = size + 'px'; }
            });
            alignStaff();
        };
        let fitQueued = false;
        const fitSoon = () => { if (fitQueued) return; fitQueued = true; requestAnimationFrame(() => { fitQueued = false; fitAll(); }); };
        const staffState = installStaffHeaders(document, store, save, fill, fitSoon, staffHash, nk);
        fitAll();
        setTimeout(fitAll, 300);
        wl('load', fitAll);
        wl('beforeprint', fitAll);
        save();
        // ─── 單元（標籤區「標籤＋填寫」、勾選區「一對 ☐＋待辦」）───
        //   每位病人每區一份有順序的清單（存資料鍵 id，沿用行 id；標籤預設＝各行 id，勾選預設＝空），由上往下壓縮排列：
        //   第 j 個單元放在第 j 行，刪掉一個後面的往上遞補，最後一個延伸到最後一行；單元數不能超過行數。
        //   「⋮」點一下 → 移除（有內容先確認）；空位的虛線「＋」新增。HTML 只在這裡產生（伺服器端只給空的 .c2／.c3）。
        const tall = (span) => (span > 1 ? ' tall' : '');
        const sfx = (i) => (i ? `_${i}` : '');
        const UH = '<span class="uh" title="點一下可移除">⋮</span>';
        const taJs = (key, cls, ord) => `<textarea class="${cls}" data-k="${key}" data-ord="${ord}" rows="1" autocomplete="off" spellcheck="false"></textarea>`;
        const cellJs = (id, r, i, span) => `<div class="cell"><input type="checkbox" class="bx" data-k="p:${id}:c${r}${sfx(i)}">${taJs(`p:${id}:t${r}${sfx(i)}`, 'tx td' + tall(span), i)}</div>`;
        const cKeys = (id, k) => [0, 1].flatMap((i) => [`p:${id}:c${k}${sfx(i)}`, `p:${id}:t${k}${sfx(i)}`]);
        const UNITS = {
            l: { store: '__lu', sel: '.c2', html: (id, k, span, j) => `<div class="lunit" data-u="${j}" style="--span:${span}">${UH}<input class="lab" data-k="p:${id}:l${k}" autocomplete="off" spellcheck="false">${taJs(`p:${id}:f${k}`, 'tx' + tall(span), 0)}</div>`,
                keys: (id, k) => ['l', 'f', 'a'].map((c) => `p:${id}:${c}${k}`), used: (id, k) => !!(store[`p:${id}:f${k}`] || '').trim() },
            c: { store: '__cu', sel: '.c3', html: (id, k, span, j) => `<div class="cunit" data-u="${j}" style="--span:${span}">${UH}${cellJs(id, k, 0, span)}${cellJs(id, k, 1, span)}</div>`,
                keys: cKeys, used: (id, k) => cKeys(id, k).some((key) => (typeof store[key] === 'string' ? store[key].trim() : store[key])) },
        };
        const uMap = (kind) => store[UNITS[kind].store] || (store[UNITS[kind].store] = {});
        const uDefault = (kind, id) => (kind === 'l' ? [...rowIdsOf(id)] : []);
        const uList = (kind, id) => { const v = uMap(kind)[id]; return v ? [...v] : uDefault(kind, id); };
        const uSave = (kind, id, list) => {
            const m = uMap(kind), def = uDefault(kind, id);
            if (list.length === def.length && list.every((k, i) => k === def[i])) delete m[id]; else m[id] = list;
        };
        const refreshAll = () => all.splice(0, all.length, ...document.querySelectorAll('[data-k]'));
        const renderColumn = (kind, pt) => {
            const id = pt.getAttribute('data-id'), u = UNITS[kind], list = uList(kind, id);
            const rowsEls = [...pt.querySelectorAll('.ln:not(.info)')];
            rowsEls.forEach((ln, j) => {
                const box = ln.querySelector(u.sel);
                let html = '';
                if (j < list.length) {
                    const span = j === list.length - 1 ? rowsEls.length - j : 1;   // 最後一個單元延伸到最後一行
                    html += u.html(id, list[j], span, j);
                    if (span > 1) html += '<button type="button" class="cadd cov" title="新增一組">＋</button>';   // 在最後一個單元下面（第一個被蓋住的行）新增
                }
                box.innerHTML = html + '<button type="button" class="cadd" title="新增一組">＋</button>';
                box.classList.toggle('none', j === 0 && !list.length);
                box.querySelectorAll('[data-k]').forEach(fill);
            });
            refreshAll();
        };
        const uAdd = (kind, pt) => {
            const id = pt.getAttribute('data-id'), list = uList(kind, id);
            const cand = rowIdsOf(id).find((k) => !list.includes(k));
            if (cand === undefined) { toast('單元數不能超過行數（先用最後一行右側的＋加一行）'); return; }
            list.push(cand);
            uSave(kind, id, list); renderColumn(kind, pt);
            fitBlock(pt); save();
        };
        const uDelete = (kind, pt, ord) => {
            const id = pt.getAttribute('data-id'), u = UNITS[kind], list = uList(kind, id), k = list[ord];
            if (k === undefined) return;
            if (u.used(id, k) && !confirm('這一組有填寫（或勾選）的內容，刪除後無法復原，確定要刪除嗎？')) return;
            u.keys(id, k).forEach((key) => { delete store[key]; });
            list.splice(ord, 1);
            uSave(kind, id, list); renderColumn(kind, pt);
            fitBlock(pt); save();
        };
        const uMenu = document.createElement('div');
        uMenu.className = 'cgmenu';
        uMenu.hidden = true;
        document.body.appendChild(uMenu);
        const ctxOf = (box) => ({ pt: box.closest('.pt'), kind: box.classList.contains('c2') ? 'l' : 'c' });
        // 把手「⋮」：點一下 → 只有「移除」一個選項（有內容會再確認）
        const openMenu = (handle, label, act) => {
            uMenu.textContent = '';
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = label;
            b.onclick = () => { uMenu.hidden = true; act(); };
            uMenu.appendChild(b);
            uMenu.hidden = false;
            const rc = handle.getBoundingClientRect();
            uMenu.style.left = (Math.min(rc.left, document.documentElement.clientWidth - uMenu.offsetWidth - 8) + window.scrollX) + 'px';
            uMenu.style.top = (rc.bottom + window.scrollY + 2) + 'px';
        };
        const openUnitMenu = (handle) => {
            const unit = handle.parentElement, { pt, kind } = ctxOf(unit.parentElement), ord = +unit.getAttribute('data-u');
            openMenu(handle, '移除', () => uDelete(kind, pt, ord));
        };
        // ─── 行（cc／#.）增減：每位病人最後一行右側的「＋」「−」＝在最後新增一行／移除最後一行（至少保留 MIN_ROWS 行）。
        //   行以「行 id」（0–9，資料鍵用）記在 store.__rows[病人id]，順序＝畫面由上到下，預設 [0,1,2]；
        //   第一行標 cc、其餘標 #.。改完通知病房列表分頁整張重新排版（病人放不下就移到下一頁）。
        const rowsMap = () => store.__rows || (store.__rows = {});
        const rowIdsOf = (id) => rowsMap()[id] || cfg.defaultRows;
        const setRowIds = (id, list) => {
            const def = cfg.defaultRows;
            if (list.length === def.length && list.every((v, i) => v === def[i])) delete rowsMap()[id]; else rowsMap()[id] = list;
        };
        const askRepaginate = (revert) => {
            save();
            const fail = () => { revert(); save(); toast(DEAD); };
            if (!openerOk()) { fail(); return; }
            window.opener.postMessage({ rs: 'repaginate', token: tokenOf() }, location.origin);
            ackSeq = 'repag';
            clearTimeout(ackTimer);
            ackTimer = setTimeout(() => { if (ackSeq === 'repag') fail(); }, 2500);
        };
        const addRow = (pt, ord) => {
            const id = pt.getAttribute('data-id'), prev = [...rowIdsOf(id)];
            if (prev.length >= cfg.maxRows) { toast(`每位病人最多 ${cfg.maxRows} 行`); return; }
            const newId = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !prev.includes(n));
            const list = [...prev];
            list.splice(ord, 0, newId);
            setRowIds(id, list);
            askRepaginate(() => setRowIds(id, prev));
        };
        const delRow = (pt, ord) => {
            const id = pt.getAttribute('data-id'), prev = [...rowIdsOf(id)];
            if (prev.length <= cfg.minRows) { toast(`至少要保留 ${cfg.minRows} 行`); return; }
            const next = prev.filter((_, i) => i !== ord);
            // 單元數不能超過行數：行少一行後多出來的單元（標籤預設是每行一個；有自訂清單時是清單尾端）要拿掉，資料一起刪
            const plan = ['l', 'c'].map((kind) => {
                const had = uMap(kind)[id], before = uList(kind, id);
                const after = had ? before.slice(0, next.length) : (kind === 'l' ? [...next] : []);
                return { kind, had: had && [...had], after, drop: before.filter((k) => !after.includes(k)) };
            });
            const dropKeys = plan.flatMap((q) => q.drop.flatMap((k) => UNITS[q.kind].keys(id, k)));
            const used = plan.some((q) => q.drop.some((k) => UNITS[q.kind].used(id, k)));
            if (used && !confirm('這一行會一併拿掉最後的單元，其中有填寫（或勾選）的內容，刪除後無法復原，確定要刪除嗎？')) return;
            const removed = {};
            dropKeys.forEach((key) => { if (key in store) { removed[key] = store[key]; delete store[key]; } });
            setRowIds(id, next);
            plan.forEach((q) => uSave(q.kind, id, q.after));
            askRepaginate(() => {
                setRowIds(id, prev);
                Object.assign(store, removed);
                plan.forEach((q) => { const m = uMap(q.kind); if (q.had) m[id] = q.had; else delete m[id]; });
            });
        };
        document.addEventListener('click', (ev) => {
            const t = ev.target.closest ? ev.target : null;
            if (!t) return;
            const rowDel = t.closest('.rdel');
            if (rowDel) { uMenu.hidden = true; const pt = rowDel.closest('.pt'); delRow(pt, rowIdsOf(pt.getAttribute('data-id')).length - 1); return; }   // 最後一行右側的「−」＝移除最後一行（有內容會先確認）
            const rowAdd = t.closest('.radd');
            if (rowAdd) { uMenu.hidden = true; const pt = rowAdd.closest('.pt'); addRow(pt, rowIdsOf(pt.getAttribute('data-id')).length); return; }   // 最後一行右側的「＋」＝在最後新增一行
            const add = t.closest('.cadd');
            if (add) { const { pt, kind } = ctxOf(add.parentElement); uAdd(kind, pt); return; }   // 區域被移除光時的「＋」（讓移除可以復原）
            const h = t.closest('.uh');
            if (h) { openUnitMenu(h); return; }
            if (!t.closest('.cgmenu')) uMenu.hidden = true;
        });
        document.querySelectorAll('.pt').forEach((pt) => { renderColumn('l', pt); renderColumn('c', pt); });
        fitAll();
        ['l', 'c'].forEach((kind) => { const m = uMap(kind); Object.keys(m).forEach((id) => { if (!document.querySelector(`.pt[data-id="${CSS.escape(id)}"]`)) delete m[id]; }); });

        // ─── 標籤＝資料類別 → 自動帶入最新結果 ───
        // 標籤是 Abx／TPR／O2／Tubes／GCS 時，同一行的填寫欄自動放入右側面板抓到的該類最新資料（多筆時放「全部」那一顆）。
        // 防呆：只在填寫欄是空的、或內容仍是「上次自動帶入的原文」（store 的 a 鍵）時才換成新結果；使用者自己改過的不覆蓋。
        // 資料晚到或重新抓取時，符合條件的欄位也會自動更新（昨天自動帶入、今天沒人改過的舊結果會被今天的取代，不會殘留）。
        const AUTO_CATS = { ABX: 'abx', TPR: 'tpr', O2: 'o2', TUBES: 'tubes', GCS: 'gcs', IO: 'io' };
        const panelText = (pid, key) => {   // 字串＝有資料；''＝這類沒有資料；null＝還沒載入完或失敗
            const sp = [...document.querySelectorAll('.sp')].find((e) => e.getAttribute('data-id') === pid);
            const cell = sp && sp.querySelector('.sc[id$="-' + key + '"]');
            if (!cell) return null;
            const chips = cell.querySelectorAll('.chip');
            if (chips.length) { const all = cell.querySelector('.chip.all'); return (all || chips[0]).getAttribute('data-t'); }
            return cell.textContent.trim() === '—' ? '' : null;
        };
        let noAuto = false;   // 拖曳放入時暫停（拖進去的是使用者選的資料塊，不要被自動帶入蓋掉或誤報「已有內容」）
        const applyAuto = (f) => {
            applyAuto.changed = false; applyAuto.label = '';
            if (noAuto) return 'edited';
            const m = (f.getAttribute('data-k') || '').match(/^p:(.*):f(\d)(_\d+)?$/);
            if (!m) return 'nocat';
            const sfx = m[3] || '';
            const lab = all.find((o) => o.getAttribute('data-k') === `p:${m[1]}:l${m[2]}${sfx}`);
            const akey = `p:${m[1]}:a${m[2]}${sfx}`;
            const last = store[akey];
            const unedited = !f.value || f.value === last;
            const cat = lab && AUTO_CATS[lab.value.trim().toUpperCase()];
            const set = (v) => {
                f.value = v; store[f.getAttribute('data-k')] = v;
                if (v) store[akey] = v; else delete store[akey];
                fitBlock(f.closest('.pt'));
            };
            if (!cat) {   // 標籤換成別的類別：先前自動帶入、沒人改過的內容一起清掉
                if (last && f.value === last) { set(''); return 'cleared'; }
                return 'nocat';
            }
            const text = panelText(m[1], cat);
            if (text === null) return 'pending';
            if (!unedited) return 'edited';
            if (f.value !== text) { set(text); if (text) { applyAuto.changed = true; applyAuto.label = lab.value.trim(); } } else if (text) store[akey] = text;
            return text ? 'applied' : 'none';
        };
        // 自動更新完跳訊息：1.2 秒內的更新合併成一則（資料是分批到的），例如「已依最新資料更新：Abx、TPR（3 個欄位）」
        const updated = { labels: new Set(), n: 0, timer: null };
        const noteUpdate = (label) => {
            updated.labels.add(label); updated.n += 1;
            clearTimeout(updated.timer);
            updated.timer = setTimeout(() => {
                toast(`已依最新資料更新：${[...updated.labels].join('、')}（${updated.n} 個欄位）`, true);
                updated.labels.clear(); updated.n = 0;
            }, 1200);
        };
        const autoAll = () => {
            document.querySelectorAll('textarea[data-k]').forEach((f) => {
                if (!/:f\d(_\d+)?$/.test(f.getAttribute('data-k'))) return;
                applyAuto(f);
                if (applyAuto.changed) noteUpdate(applyAuto.label);
            });
            save();
        };
        // ─── 病人圖示：NEW（住院天數）、藥瓶（有抗生素）、管路（有管路）、吹氣（SpO2 有給氧裝置）；點一下手動開關（存在 p:<id>:ic:<名> ）
        const panelHas = (pid, key, sel) => {
            const sp = [...document.querySelectorAll('.sp')].find((e) => e.getAttribute('data-id') === pid);
            return !!(sp && sp.querySelector('.sc[id$="-' + key + '"] ' + sel));
        };
        const autoIcon = (pt, name) => {
            const pid = pt.getAttribute('data-id');
            if (name === 'new') return !!pt.querySelector('.ic[data-ic="new"][data-auto]');
            if (name === 'abx') return panelHas(pid, 'abx', '.chip');
            if (name === 'tube') return panelHas(pid, 'tubes', '.chip');
            return panelHas(pid, 'o2', '.chip[data-on="1"]');
        };
        const updateIcons = () => {
            document.querySelectorAll('.pt').forEach((pt) => {
                pt.querySelectorAll('.ic').forEach((ic) => {
                    const name = ic.getAttribute('data-ic');
                    const o = store[`p:${pt.getAttribute('data-id')}:ic:${name}`];
                    ic.classList.toggle('on', o === undefined ? autoIcon(pt, name) : o === '1');
                });
            });
        };
        document.addEventListener('click', (ev) => {
            const ic = ev.target.closest && ev.target.closest('.ic');
            if (!ic) return;
            const pt = ic.closest('.pt');
            store[`p:${pt.getAttribute('data-id')}:ic:${ic.getAttribute('data-ic')}`] = ic.classList.contains('on') ? '0' : '1';
            updateIcons();
            save();
        });
        let autoQueued = false;
        const side = document.querySelector('.side');
        if (side) {
            new MutationObserver(() => { if (autoQueued) return; autoQueued = true; setTimeout(() => { autoQueued = false; autoAll(); updateIcons(); }, 60); })   // setTimeout：分頁在背景時 rAF 會暫停，資料就不會更新
                .observe(side, { childList: true, subtree: true });
        }
        autoAll();
        updateIcons();

        document.addEventListener('input', (ev) => {
            const el = ev.target;
            const k = el.getAttribute && el.getAttribute('data-k');
            if (!k) return;
            store[k] = el.type === 'checkbox' ? el.checked : el.value;
            if (k.startsWith('h:')) el.setAttribute('data-staff-manual', '1');
            if (el.tagName === 'TEXTAREA' && !el.classList.contains('nt') && !el.classList.contains('tall') && /\n/.test(el.value)) { el.value = el.value.replace(/\s*\n+\s*/g, ' '); store[k] = el.value; }   // 貼上含換行的文字 → 換成空格
            if (el.tagName === 'TEXTAREA') fitBlock(el.closest('.pt'));
            else if (el.matches('.lab,.u')) fit(el);
            if (/:l\d(_\d+)?$/.test(k)) {
                const fk = k.replace(/:l(\d)(_\d+)?$/, ':f$1$2');
                const fEl = all.find((o) => o.getAttribute('data-k') === fk);
                const res = fEl ? applyAuto(fEl) : 'nocat';
                if (applyAuto.changed) noteUpdate(applyAuto.label);
                if (res === 'edited' && !noAuto) toast('填寫欄已有你自己的內容，沒有覆蓋（可拖曳右側資料塊取代）');
                // 沒有自動資料可帶時（標籤不是資料類別、或這類目前沒資料）→ GCS／MP 的範本
                const tpl = cfg.templates[el.value.trim().toUpperCase()];
                if (tpl && fEl && !fEl.value.trim()) { fEl.value = tpl; store[fk] = tpl; fitBlock(fEl.closest('.pt')); }
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
            if (!(el.classList && el.classList.contains('lab'))) { if (!menu.contains(el)) hide(); return; }
            target = el;
            el.select();
            menu.textContent = '';
            cfg.options.forEach((o) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = o; menu.appendChild(b); });
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
        // 中文輸入法：選字確認用的 Enter 不能攔（preventDefault／blur 會讓已確認的字重複插入一次）。
        // 判斷：isComposing、keyCode 229，或剛結束組字不久（Safari 的 compositionend 比 keydown 先發生，這時 isComposing 已是 false）。
        let imeUntil = 0;
        document.addEventListener('compositionend', () => { imeUntil = new Date().getTime() + 80; }, true);
        const isIme = (ev) => ev.isComposing || ev.keyCode === 229 || new Date().getTime() < imeUntil;
        document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !isIme(ev) && ev.target.tagName === 'TEXTAREA' && !ev.target.classList.contains('nt') && !ev.target.classList.contains('tall')) ev.preventDefault(); });
        document.addEventListener('keydown', (ev) => { if (isIme(ev)) return; if (ev.key === 'Enter' && ev.target.classList && (ev.target.classList.contains('nt') || ev.target.classList.contains('tall'))) return; if (ev.key === 'Escape' || ev.key === 'Enter') { hide(); if (document.activeElement) document.activeElement.blur(); } });
        document.addEventListener('mousedown', (ev) => { if (!menu.contains(ev.target) && !(ev.target.classList && ev.target.classList.contains('lab'))) hide(); });
        // 欄寬比例（全域，存起來下次沿用）
        const rl = document.getElementById('rl');
        const hs = [document.getElementById('h1'), document.getElementById('h2')];
        const norm = (v) => (Array.isArray(v) && v.length === 3 && v.every((n) => n > 0) ? v : cfg.ratio);
        const applyRatio = (v) => {
            const t = v[0] + v[1] + v[2];
            v.forEach((n, i) => document.body.style.setProperty('--r' + (i + 1), n));
            hs[0].style.left = (v[0] / t * 100) + '%';
            hs[1].style.left = ((v[0] + v[1]) / t * 100) + '%';
            fitSoon();
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
        const toast = (msg, good) => {
            let t = document.getElementById('rs-toast');
            if (!t) { t = document.createElement('div'); t.id = 'rs-toast'; document.body.appendChild(t); }
            t.textContent = msg; t.style.background = good ? '#0f766e' : '#b91c1c'; t.className = 'show';
            clearTimeout(t._h); t._h = setTimeout(() => { t.className = ''; }, 2600);
        };
        const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        const dropCheck = (ev) => {   // → { ok, input }；不是輸入框就 null（交給瀏覽器）
            const inp = ev.target.closest && ev.target.closest('input,textarea');
            if (!inp) return null;
            const pt = inp.closest('.pt');
            return { inp, ok: !!pt && pt.getAttribute('data-id') === drag.pid && (inp.classList.contains('tx') || inp.classList.contains('nt')) };
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
            if (!/:f\d(_\d+)?$/.test(k)) return;   // 其他欄位：瀏覽器原生放入文字
            ev.preventDefault(); ev.stopPropagation();
            const text = ev.dataTransfer.getData('text/plain');
            setVal(r.inp, text);
            const lab = all.find((o) => o.getAttribute('data-k') === k.replace(/:f(\d)(_\d+)?$/, ':l$1$2'));
            if (lab && drag.cat) { noAuto = true; setVal(lab, drag.cat); noAuto = false; }
        }, true);
        document.addEventListener('click', (ev) => {
            const h = ev.target.closest && ev.target.closest('.shn');
            if (!h) return;
            const id = h.closest('.sp').getAttribute('data-id');
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
        alignStaff = align;
        align();
        setTimeout(align, 300);
        wl('resize', align);
        wl('load', align);
        // 右側面板寬度：拖左邊緣調整，存起來沿用
        const sw = document.getElementById('rz');
        const setSw = (px) => document.body.style.setProperty('--sw', px + 'px');
        if (Number.isFinite(store['cfg:side'])) setSw(store['cfg:side']);
        if (sw) {
            sw.addEventListener('pointerdown', (ev) => { sw.setPointerCapture(ev.pointerId); sw.classList.add('on'); ev.preventDefault(); });
            sw.addEventListener('pointermove', (ev) => {
                if (!sw.classList.contains('on')) return;
                const w = Math.round(Math.min(Math.max(document.querySelector('.side').getBoundingClientRect().right - ev.clientX, 320), 960));
                store['cfg:side'] = w; setSw(w);
            });
            const endSw = () => { if (sw.classList.contains('on')) { sw.classList.remove('on'); save(); } };
            sw.addEventListener('pointerup', endSw);
            sw.addEventListener('pointercancel', endSw);
        }
        // 詳細視窗（Lab／影像）：按鈕 → 請病房列表分頁抓 → 內容寫回 #dlg-body（可直接選取複製）
        // 展開中的病人：左邊 A4 區塊與右邊資料格都框起來（防呆：看的是誰一眼就知道）
        const markViewing = (id) => {
            document.querySelectorAll('.pt.viewing,.sp.viewing').forEach((e) => e.classList.remove('viewing'));
            if (id) document.querySelectorAll('.pt,.sp').forEach((e) => { if (e.getAttribute('data-id') === id) e.classList.add('viewing'); });
        };
        const dlg = document.getElementById('dlg');
        let cur = null, seq = 0;
        const openerOk = () => window.opener && !window.opener.closed;
        // 失效偵測：病房列表分頁若被重新整理、導到登入頁或關閉，它裡面的抓取程式就不在了（請求會石沉大海）。
        //   ① 每 30 秒 ping 一次，3 秒內沒 pong → 面板上方顯示警告；② 按鈕請求 2.5 秒沒收到 ack → 視窗內顯示同樣說明。
        const warnEl = document.getElementById('sd-warn');
        const DEAD = '⚠ 病房列表分頁已重新整理、關閉或登入逾時，這裡無法再抓資料。請回病房列表重新按「查房單」。';
        const tokenOf = () => document.documentElement.getAttribute('data-rs-token');
        let pingN = 0, pongN = 0, ackSeq = null, ackTimer = null;
        wl('message', (ev) => {
            if (ev.origin !== location.origin || !ev.data) return;
            if (ev.data.rs === 'staff' && ev.data.token === tokenOf()) { applyStaffHeaders(document, ev.data.fields, staffState); }
            if (ev.data.rs === 'pong') { pongN = Math.max(pongN, ev.data.n); if (warnEl && pongN >= pingN) warnEl.hidden = true; }
            if (ev.data.rs === 'ack' && String(ev.data.seq) === String(ackSeq)) clearTimeout(ackTimer);
        });
        const ping = () => {
            if (!openerOk()) { if (warnEl) warnEl.hidden = false; return; }
            const n = ++pingN;
            window.opener.postMessage({ rs: 'ping', token: tokenOf(), n }, location.origin);
            setTimeout(() => { if (pongN < n && warnEl) warnEl.hidden = false; }, 3000);
        };
        setTimeout(ping, 3000);
        window.__rsIV.push(setInterval(ping, 30000));
        const request = () => {
            if (!cur) return;
            if (!openerOk()) { alert('病房列表分頁已關閉，無法抓取。請回病房列表重新按「查房單」。'); return; }
            seq += 1;
            dlg.setAttribute('data-seq', String(seq));
            document.getElementById('dlg-body').innerHTML = '<span class="mu">載入中…</span>';
            window.opener.postMessage({ rs: 'detail', token: tokenOf(), kind: cur.kind, idx: cur.idx, seq }, location.origin);
            ackSeq = seq;
            clearTimeout(ackTimer);
            ackTimer = setTimeout(() => { if (ackSeq === seq) document.getElementById('dlg-body').innerHTML = `<div class="er">${DEAD}</div>`; }, 2500);
        };
        document.addEventListener('click', (ev) => {
            const b = ev.target.closest && ev.target.closest('.bt');
            if (!b) return;
            const kind = b.getAttribute('data-kind');
            cur = { kind, idx: +b.getAttribute('data-i') };
            markViewing(b.closest('.sp').getAttribute('data-id'));
            const name = b.parentElement.querySelector('.shn').textContent;
            document.getElementById('dlg-t').textContent = name + (kind === 'lab' ? '　Lab' : kind === 'pn' ? '　最近病程 PAP' : '　影像報告');
            dlg.hidden = false;
            request();
        });
        document.getElementById('dlg-x').onclick = () => { dlg.hidden = true; cur = null; markViewing(null); };
        document.getElementById('dlg-c').onclick = () => {
            const t = document.getElementById('dlg-body').innerText;
            const done = () => toast('已複製', true);
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(done, () => toast('複製失敗，請直接選取文字複製'));
            else toast('複製失敗，請直接選取文字複製');
        };
        const re = document.getElementById('sd-re');
        if (re) re.onclick = () => {
            if (!window.opener || window.opener.closed) { alert('病房列表分頁已關閉，無法重新抓取。請回病房列表重新按「查房單」。'); return; }
            window.opener.postMessage({ rs: 'refresh', token: tokenOf() }, location.origin);
            ackSeq = 'refresh';
            clearTimeout(ackTimer);
            ackTimer = setTimeout(() => { if (ackSeq === 'refresh' && warnEl) warnEl.hidden = false; }, 2500);
        };
        document.getElementById('pr').onclick = () => window.print();
        // 分區清除：標籤區＝標籤（回預設）＋同行填寫欄；勾選區＝勾選格＋待辦文字
        const clearZone = (re, what) => {
            if (!confirm(`清除所有病人的${what}？`)) return;
            if (/\[lf\]/.test(re.source)) Object.keys(store).forEach((k) => { if (/^p:.*:a\d(_\d+)?$/.test(k)) delete store[k]; });
            all.forEach((el) => {
                const k = el.getAttribute('data-k');
                if (!re.test(k)) return;
                delete store[k];
                fill(el);
            });
            fitAll();
            save();
        };
        document.getElementById('clrl').onclick = () => clearZone(/^p:.*:[lf]\d(_\d+)?$/, '標籤區（標籤回到預設、填寫內容清空）');
        document.getElementById('clrc').onclick = () => clearZone(/^p:.*:[ct]\d(_\d+)?$/, '勾選區（勾選與待辦文字）');
        document.getElementById('clr').onclick = () => {
            if (!confirm('清除所有病人的填寫、待辦、勾選、標籤與頁首欄位？')) return;
            for (const k of Object.keys(store)) if (k.indexOf('p:') === 0 || k.indexOf('h:') === 0) delete store[k];
            document.querySelectorAll('[data-k]').forEach((el) => { el.removeAttribute('data-staff-manual'); fill(el); });
            fitAll();
            updateIcons();
            save();
        };
    }

    // ═══════════════════════════════════════════════════════════
    // 資料抓取：抗生素（藥歷頁）、管路（CatheterCare）
    // ═══════════════════════════════════════════════════════════
    // fetchAbx／fetchTubes 在 lib/ntuh-fetch.js，與 morning-briefing 共用同一份（實測過的做法，註解與坑見該檔）。
    // 抓取在病房列表這個分頁執行（要用它的 SESSION 與病人清單 Cookie），結果直接寫進查房單分頁的右側面板。
    // ─── 共用 lib 的別名（lib/ntuh-fetch.js、lib/lab-rules.js；晨間簡報共用同一份）────────
    // pageGate：管路與病程紀錄頁共用、一律一次一位（handler 不帶病人識別、靠「最近載入的病人」決定回誰）。
    const { nowMs, dayStart, parseHtml, pageSession, personIdFromPatientList, pageGate, fetchAbx, fetchTubes } = NTUHFetch;
    const { LAB_DC_RANGE, LAB_GROUPS, LAB_GROUP_OF, LAB_NONBLOOD_CAT_RE, parseLabList } = NTUHLab;
    const two = (n) => String(n).padStart(2, '0');
    // ─── 共用 lib 別名結束

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

        const sp = lastWith((o) => isN(o.SpO2));
        if (sp) {
            const x = NTUHNews2.oxygenInfo(sp.inside);
            const how = sp.onOxygen ? [x.device, x.flow !== null ? x.flow + 'L' : ''].filter(Boolean).join(' ') || '給氧' : 'RA';
            out.o2.push({ ...mk(`SpO2 ${sp.SpO2}% ${how}`, sp.ms), on: !!sp.onOxygen });
        }

        if (v.uo) out.io.push({ t: `U/O ${v.uo.val}${v.uo.ms ? ` (${md(v.uo.ms)})` : ''}`, tip: v.uo.ms ? '尿量，時間 ' + mdhm(v.uo.ms) : '院內未標日期的尿量' });

        const g = lastWith((o) => o.gcs);
        if (g) {
            const m = g.gcs.match(/E(\d+)M(\d+)V(\w+)/i);
            out.gcs.push(mk(m ? `E${m[1]}V${m[3]}M${m[2]}` : g.gcs, g.ms));
        }
        return out;
    }

    // ═══════════════════════════════════════════════════════════
    // 詳細視窗資料：Lab（檢驗數值表）、影像報告（Impression）
    // ═══════════════════════════════════════════════════════════
    // 檢驗的過濾／分組／解析在 lib/lab-rules.js（與 morning-briefing 共用，原出自 lab-summary）；表格呈現取自 morning-briefing。
    // 這兩種資料太長，不做成可拖的資料塊：點病人格子上的「Lab」「影像」按鈕才抓，內容在詳細視窗裡可直接選取複製。
    // 趨勢呈現（取自 lab-summary 的 compactTrend／formatTrend）：值以 → 串接，中間有沒抽的日期就多一個箭頭
    const LAB_ATTACH = { WBC: 'Seg', Hb: 'MCV', CRE: 'eGFR' };   // 附屬項目接在主項目後面的括號內
    const LAB_ATTACHED = new Set(Object.values(LAB_ATTACH));
    function compactTrend(vals) {
        const parts = [];
        let lastIdx = -1;
        vals.forEach((v, i) => {
            if (!v) return;
            parts.push((lastIdx < 0 ? '' : '→'.repeat(i - lastIdx)) + v);
            lastIdx = i;
        });
        return parts.join('');
    }
    // 一個分組 → 「名稱 [日期…]: 項目 趨勢, 項目 趨勢」一行
    function labTrendLine(title, list, order, md) {
        const dates = [...new Set(list.map((it) => it.dateMs))].sort((x, y) => x - y);
        const cell = new Map();   // `${dateMs}|${item}` → 值（同一天同一項目有多筆就用 / 串起來）
        for (const it of list) { const k = `${it.dateMs}|${it.item}`; cell.set(k, cell.has(k) ? `${cell.get(k)} / ${it.value}` : it.value); }
        const has = (n) => list.some((it) => it.item === n);
        const trendOf = (n) => compactTrend(dates.map((ms) => cell.get(`${ms}|${n}`) || ''));
        const names = order.filter(has);
        const parts = [];
        for (const n of names) {
            const main = Object.keys(LAB_ATTACH).find((m) => LAB_ATTACH[m] === n);
            if (LAB_ATTACHED.has(n) && main && names.includes(main)) continue;   // 已附在主項目後面
            let t = `${n} ${trendOf(n)}`;
            const att = LAB_ATTACH[n];
            if (att && names.includes(att)) t += ` (${att} ${trendOf(att)})`;
            parts.push(t);
        }
        const used = dates.filter((ms) => list.some((it) => it.dateMs === ms));
        return `<div class="tl"><b>${esc(title)}</b> [${used.map(md).join(', ')}]: ${esc(parts.join(', '))}</div>`;
    }

    async function fetchLabData(p, now) {
        const pid = personIdFromPatientList(document.cookie, p.caseno);
        const html = await NTUHAsmx.outerData('lab', { context: { ...ctxOf(p), PersonId: pid }, timeoutMs: OUTER_TIMEOUT_MS });
        if (!html) return { items: [], skipped: 0, hidden: 0, empty: true };
        return parseLabList(html, now - LAB_DAYS * 86400000, '查房單');
    }

    // 詳細視窗的 Lab 內容：血液項目依臨床分組成表（日期為列、項目為欄），其他類別各一張表；很長的值（培養結果等）列在「文字結果」
    const LAB_DAYS = 7;   // Lab 視窗固定顯示近幾天
    const IMG_DAYS = 14;  // 影像視窗固定顯示近幾天

    function renderLabBody(d, now) {
        const md = (ms) => { const x = new Date(ms); return `${x.getMonth() + 1}/${x.getDate()}`; };
        if (d.empty) return '<span class="mu">伺服器沒有回傳檢驗資料。</span>';
        if (d.noTable) return '<span class="mu">近期沒有檢驗報告。</span>';
        const warn = d.skipped ? `<div class="er">⚠ 有 ${d.skipped} 列格式不符、沒有顯示（請手動確認）</div>` : '';
        const since = dayStart(now) - (LAB_DAYS - 1) * 86400000;
        const items = d.items.filter((it) => it.dateMs >= since);
        if (!items.length) return `${warn}<span class="mu">近 ${LAB_DAYS} 天沒有檢驗數值。</span>`;
        const LONG = 28;
        const texts = items.filter((it) => it.value.length > LONG);
        const nums = items.filter((it) => it.value.length <= LONG);
        const catOf = (it) => (!it.category || it.category === 'Yes' ? '其他' : it.category);
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
        for (const [g, names] of LAB_GROUPS) if (groups.has(g)) blocks.push(labTrendLine(g, groups.get(g), names, md));
        for (const [cat, list] of rest) blocks.push(labTrendLine(cat, list, [...new Set(list.map((it) => it.item))], md));
        const textHtml = texts.length
            ? `<div class="lbh">文字結果</div>${texts.sort((x, y) => x.dateMs - y.dateMs).map((it) => `<div class="lbl"><span class="mu">${md(it.dateMs)}</span> <b>${esc(it.item)}</b> ${esc(it.value)}</div>`).join('')}` : '';
        return `${warn}${blocks.join('')}${textHtml}`;
    }

    // ─── 影像報告（OuterData pacs）：列出日期、檢查名稱與 Impression ───
    // lib 的 parsePacs 不排序、不截長度：這裡新到舊、每份報告最多 8000 字
    const parsePacsFull = (html, fromMs) => NTUHFetch.parsePacs(html, fromMs)
        .map((x) => ({ ...x, report: x.report.slice(0, 8000) })).sort((a, b) => b.ms - a.ms);
    // Impression：取「Impression／Conclusion／IMP」之後的文字；找不到就回 null（呼叫端改顯示報告全文）
    function impressionOf(report) {
        const m = report.match(/(?:impressions?|conclusions?|imp)\s*[:：]\s*([\s\S]*)/i);
        const t = m ? m[1].trim() : '';
        return t || null;
    }
    async function fetchImages(p, now) {
        const html = await NTUHAsmx.outerData('pacs', { context: ctxOf(p), timeoutMs: OUTER_TIMEOUT_MS });
        return parsePacsFull(html, now - IMG_DAYS * 86400000);
    }
    function renderImagesBody(items, now) {
        const since = dayStart(now) - (IMG_DAYS - 1) * 86400000;
        const list = items.filter((x) => x.ms >= since);
        if (!list.length) return `<span class="mu">近 ${IMG_DAYS} 天沒有影像報告。</span>`;
        return list.map((x) => {
            const imp = impressionOf(x.report);
            const body = imp ? `<div class="imp">${esc(imp)}</div>` : (x.report ? `<div class="imp"><span class="mu">（找不到 Impression，以下為報告全文）</span>\n${esc(x.report)}</div>` : '<div class="imp mu">（沒有報告內容）</div>');
            return `<div class="im"><b>${esc(x.date)} ${esc(x.title)}</b>${body}</div>`;
        }).join('');
    }

    // 登入逾時診斷：重抓目前這個病房列表網址，若被導到登入頁（或出現「非合法使用此網頁」）就是逾時。true／false／null（無法判斷）
    const SESSION_MSG = '⚠ Portal 登入可能已逾時（閒置太久）。請回病房列表重新登入，再重新按「查房單」。';
    async function sessionAlive() {
        try {
            const res = await fetch(location.href, { credentials: 'same-origin', cache: 'no-store' });
            if (res.status === 401 || res.status === 403) return false;
            if (res.redirected && /login/i.test(res.url)) return false;
            if (!res.ok) return null;
            return !/非合法使用此網頁/.test((await res.text()).slice(0, 30000));
        } catch (e) { return null; }
    }

    // ─── 最近一篇 progress note 的 PAP（Problem／Assessment／Plan）：唯讀 ───
    // 2026-10-16 探測（progress-note-list／content／pap-shape probe）：
    //   1. 病程頁 HTML（GET 同一個網址）裡就有清單 #tblNoteList tbody tr[notetype]，每列帶 caseseqno／accountno／version／
    //      loginhospcode／loginempno／insertdatetime／islastverion／completeflag；#hiddenInDate 是 StrInDate。
    //   2. 內容：POST Ward/ProgressNoteControl/Service/Notes.asmx/GetNoteContent  body { jsonstring: JSON{AccountIdse,CaseSeqNo,Version,StrInDate,HospCode,EmpNo,Status}, notetype }。
    //   3. PAP：POST Ward/ProgressNoteControl/Service/PAP.asmx/GetProgressNotePAP  body { jsonstring: JSON{AccountNo,SeqNo,Version}, notetype:'progress' }
    //      → 陣列，每筆 { ProblemNumber, Problem[0], Assessment[0], Plan[0] }（文字需用 DeCodingRecordValue 的規則解碼，見 decodeRec）。
    // 病程頁是「寫病程的地方」：這裡只 GET 頁面取清單、POST 讀取端點，不點任何病程、不送任何存檔類請求。
    // 兩個回傳都帶 AccountIdse／accountno，逐一與病房列表的 caseno 比對，對不上就整筆丟棄。
    const progressPageUrl = (p, personId) => location.origin + '/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx'
        + `?SESSION=${encodeURIComponent(pageSession())}&PatClass=I&AccountIDSE=${encodeURIComponent(p.caseno)}`
        + `&PersonID=${encodeURIComponent(personId)}&Hosp=T0&Seed=&EMRPop=Y`;
    // 解碼：伺服器把特殊字元存成「A + 8 位二進位」代碼，頁面顯示前用 DeCodingRecordValue 換回來（2026-10-16 取自頁面原始碼，
    // 原函式還有一行重複的 ReplaceAll("A0000 0001","+")，等同上面那條，不重複）。逗號被存成 A0000 0000。
    const REC_CODES = [['A0010 0111', "'"], ['A0011 1100', '<'], ['A0011 1110', '>'], ['A0010 0110', '&'], ['A0101 1111', '_'], ['A0000 0000', ','], ['A0000 0001', '+']];
    const decodeRec = (v) => REC_CODES.reduce((t, [code, ch]) => t.split(code).join(ch),
        String(Array.isArray(v) ? v[0] : (v === null || v === undefined ? '' : v))).replace(/\r\n?/g, '\n');

    async function fetchProgress(p) {
        return pageGate(async () => {
            const pid = personIdFromPatientList(document.cookie, p.caseno);
            const res = await fetch(progressPageUrl(p, pid), { credentials: 'same-origin' });
            if (!res.ok) throw new Error('病程頁 HTTP ' + res.status);
            const doc = parseHtml(await res.text());
            const rows = [...doc.querySelectorAll('#tblNoteList tbody tr[notetype]')]
                .filter((tr) => tr.getAttribute('notetype') === 'progress' && tr.getAttribute('islastverion') === 'true');
            if (!rows.length) return { none: true };
            rows.sort((a, b) => (b.getAttribute('insertdatetime') || '').localeCompare(a.getAttribute('insertdatetime') || ''));
            const tr = rows[0];
            const at = (n) => tr.getAttribute(n) || '';
            if (at('accountno') !== p.caseno) throw new Error('病程清單與病人不符，已丟棄');
            const note = await NTUHAsmx.call({
                url: NTUHAsmx.serviceUrl('ProgressNoteControl/Service/Notes.asmx/GetNoteContent'),
                body: {
                    jsonstring: JSON.stringify({ AccountIdse: at('accountno'), CaseSeqNo: at('caseseqno'), Version: at('version'), StrInDate: (doc.getElementById('hiddenInDate') || {}).value || '', HospCode: at('loginhospcode'), EmpNo: at('loginempno'), Status: at('status') }),
                    notetype: 'progress',
                },
                timeoutMs: OUTER_TIMEOUT_MS,
            });
            if (!note || String(note.AccountIdse) !== p.caseno) throw new Error('病程內容與病人不符，已丟棄');
            const pap = await NTUHAsmx.call({
                url: NTUHAsmx.serviceUrl('ProgressNoteControl/Service/PAP.asmx/GetProgressNotePAP'),
                body: { jsonstring: JSON.stringify({ AccountNo: at('accountno'), SeqNo: at('caseseqno'), Version: at('version') }), notetype: 'progress' },
                timeoutMs: OUTER_TIMEOUT_MS,
            });
            const items = (Array.isArray(pap) ? pap : []).map((it) => ({
                n: +it.ProblemNumber, problem: decodeRec(it.Problem), assessment: decodeRec(it.Assessment), plan: decodeRec(it.Plan),
            })).sort((a, b) => a.n - b.n);
            return { at: at('insertdatetime'), version: at('version'), complete: at('completeflag'), writer: note.NoteWriter || '', vs: note.VSName || '', items };
        });
    }
    function renderProgressBody(d) {
        const n = 1;   // 很少人寫超過一個 PAP，只看 #1
        if (d.none) return '<span class="mu">沒有 progress note。</span>';
        const m = String(d.at).match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
        const when = m ? `${+m[2]}/${+m[3]} ${m[4]}:${m[5]}` : d.at;
        const head = `<div class="mu">${esc([when, `版本 ${d.version}`, d.complete === 'V' || d.complete === 'R' ? '完成' : '暫存', d.writer, d.vs && `VS ${d.vs}`].filter(Boolean).join(' · '))}</div>`;
        const it = d.items.find((x) => x.n === n);
        if (!it) return `${head}<div class="pp mu">這篇病程沒有 #${n} 的 PAP（共 ${d.items.length} 個 problem）。</div>`;
        const part = (label, text) => `<div class="pp"><b>${esc(label)}</b>\n${esc(text || '（空）')}</div>`;
        return head + part(`#${n} Problem`, it.problem) + part('Assessment', it.assessment) + part('Plan', it.plan);
    }

    // ─── 右側面板：資料塊（可拖進任何填寫欄）──────────────────
    const abxText = (x) => `${x.name}${x.route ? ' ' + x.route : ''} D${x.day}`;
    const tubeTextOf = (x) => `${x.name} D${x.day}`;
    // cat＝資料塊的類別（對應標籤名稱），放進欄位時會把該行標籤自動換成它
    const chip = (t, cls, label, tip, cat, on) => `<span class="chip${cls || ''}" draggable="true" data-t="${esc(t)}" data-c="${esc(cat)}"${tip ? ` title="${esc(tip)}"` : ''}${on ? ' data-on="1"' : ''}>${esc(label || t)}</span>`;
    const tipChips = (list, cat) => (list.length ? list.map((x) => chip(x.t, '', '', x.tip, cat, x.on)).join('') : '<span class="mu">—</span>');
    function chipsHtml(items, fmt, allLabel, cat) {
        if (!items.length) return '<span class="mu">—</span>';
        const texts = items.map(fmt);
        return texts.map((t) => chip(t, '', '', '', cat)).join('') + (texts.length > 1 ? chip(texts.join(', '), ' all', allLabel, '', cat) : '');
    }

    const HEAVY_POOL = 2;   // 同時處理的病人數（藥歷與管路各有自己的閘門）

    async function fetchPanel(w, patients, state) {
        if (state.running) return;
        state.running = true;
        const set = (id, html) => { state.cache[id] = html; if (!w.closed) { const el = w.document.getElementById(id); if (el) el.innerHTML = html; } };
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
            // 有任何格子「未取得」時，確認是不是登入逾時（一次）
            if (!w.closed && w.document.querySelector('.sc .er') && (await sessionAlive()) === false) prog('⚠ 登入可能已逾時，請重新登入後重新按「查房單」');
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
        const d = new Date();
        const two = (n) => String(n).padStart(2, '0');
        const today = `${d.getMonth() + 1}/${d.getDate()}`;
        const stamp = `${d.getFullYear()}/${two(d.getMonth() + 1)}/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
        // 抓取在這個分頁（病房列表）跑；面板的「重新抓取」按鈕用 postMessage 通知這裡（比對 token，不依賴 source 物件）
        const state = { running: false, cache: {} };   // cache：右側面板各格的內容（整張重新排版後原樣放回，不重抓）
        const token = String(nowMs()) + Math.random().toString(36).slice(2);
        const reply = (m) => { try { if (!w.closed) w.postMessage(m, location.origin); } catch (e) { /* 對方視窗已關 */ } };
        // 整張排版：依「每位病人的行數」分頁（沒人加行＝每頁 11 位）。第一次開啟與每次加／刪行都走這裡；
        // 文件被重寫後頁面腳本會重新初始化，使用者填的內容都在 localStorage（輸入當下就存），所以不會掉。
        const render = () => {
            const y = w.scrollY || 0;
            let rowsMap = {};
            try { rowsMap = (JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}).__rows || {}; } catch (e) { rowsMap = {}; }
            const groups = paginate(patients, rowsMap);
            w.document.open();
            w.document.write(pageShell(patients, today, stamp, groups, rowsMap));
            w.document.close();
            w.document.documentElement.setAttribute('data-rs-token', token);
            Object.entries(state.cache).forEach(([id, html]) => { const el = w.document.getElementById(id); if (el) el.innerHTML = html; });
            w.scrollTo(0, y);
            buildStaffHeaders(patients, groups).then((fields) => reply({ rs: 'staff', token, fields }));
        };
        render();
        const cache = {};   // `${idx}|${kind}` → { at, data }：3 分鐘內重複點不再抓；空結果不快取（可能是登入逾時造成的假空）
        const CACHE_MS = 3 * 60000;
        const isEmpty = (kind, d) => (kind === 'lab' ? (d.empty || d.noTable || !d.items.length) : kind === 'pn' ? d.none : !d.length);
        const showDetail = async (d) => {
            const dlg = w.closed ? null : w.document.getElementById('dlg');
            const body = dlg && w.document.getElementById('dlg-body');
            const p = patients[d.idx];
            if (!body || !p) return;
            const stale = () => String(dlg.getAttribute('data-seq')) !== String(d.seq);
            const key = d.idx + '|' + d.kind;
            const now = nowMs();
            try {
                let hit = cache[key];
                if (!hit || now - hit.at > CACHE_MS) {
                    const data = d.kind === 'lab' ? await fetchLabData(p, now) : d.kind === 'pn' ? await fetchProgress(p) : await fetchImages(p, now);
                    hit = { at: now, data };
                    if (isEmpty(d.kind, data)) delete cache[key]; else cache[key] = hit;
                }
                if (stale()) return;
                const data = hit.data;
                body.innerHTML = d.kind === 'lab' ? renderLabBody(data, now) : d.kind === 'pn' ? renderProgressBody(data) : renderImagesBody(data, now);
                // 空結果可能只是登入逾時（伺服器回空頁面）：多查一次登入狀態，逾時就明講
                if (isEmpty(d.kind, data) && (await sessionAlive()) === false && !stale()) body.insertAdjacentHTML('afterbegin', `<div class="er">${SESSION_MSG}</div>`);
            } catch (e) {
                if (stale()) return;
                body.innerHTML = `<div class="er">未取得：${esc(e.name === 'AbortError' ? '逾時' : e.message)}</div>`;
                if ((await sessionAlive()) === false && !stale()) body.insertAdjacentHTML('afterbegin', `<div class="er">${SESSION_MSG}</div>`);
            }
        };
        window.addEventListener('message', (ev) => {
            if (ev.origin !== location.origin || !ev.data || ev.data.token !== token) return;
            if (ev.data.rs === 'ping') reply({ rs: 'pong', n: ev.data.n });
            else if (ev.data.rs === 'repaginate') { reply({ rs: 'ack', seq: 'repag' }); render(); }
            else if (ev.data.rs === 'refresh') { reply({ rs: 'ack', seq: 'refresh' }); fetchPanel(w, patients, state); }
            else if (ev.data.rs === 'detail') { reply({ rs: 'ack', seq: ev.data.seq }); showDetail(ev.data); }
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

    mount();
}());
