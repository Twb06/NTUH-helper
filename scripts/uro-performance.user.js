// ==UserScript==
// @name         NTUH 績效填入工具 (全自動完整版 v1.8)
// @namespace    ntuh-perf
// @version      1.8.0
// @description  對照表CSV+刀表病人CSV+病歷號雙鍵+已填判斷+全自動寫入。巡檢:切病人→判已填→完全未填才填主治+R→新增→切下一位。嚴格病歷號比對。無對外連線。
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/EnterTakeCarePersonInfo.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/uro-performance.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/uro-performance.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ====================== 對照表 ======================
  const DEFAULT_TEAMS = [
    { professor: { name: '蒲永孝', id: '002856' }, attendings: [{ name: '陳忠信', id: '018113' }, { name: '黃政郁', id: '116459' }, { name: '邱士庭', id: '108965' }], r11c: { name: '吳政陽', id: '123944' }, r11d: { name: '陳聖凱', id: '128782' } },
    { professor: { name: '黃昭淵', id: '007381' }, attendings: [{ name: '洪健華', id: '102184' }, { name: '周博敏', id: '100393' }, { name: '謝宗頤', id: '112808' }, { name: '黃亮臻', id: '117194' }], r11c: { name: '洪國倫', id: '117446' }, r11d: { name: '陳宜慧', id: '122452' } },
    { professor: { name: '闕士傑', id: '003454' }, attendings: [{ name: '王碩盟', id: '004630' }, { name: '曾啟新', id: '104304' }, { name: '董牧喬', id: '128497' }], r11c: { name: '于仲揚', id: '119391' }, r11d: { name: '李睿博', id: '120896' } },
    { professor: { name: '黃國皓', id: '007769' }, attendings: [{ name: '李苑如', id: '010053' }, { name: '張尚仁', id: '018484' }, { name: '黃欣媚', id: '111207' }, { name: '趙梓辰', id: '122058' }], r11c: { name: '張凱威', id: '122386' }, r11d: { name: '郭鎮安', id: '124450' } },
  ];
  const LS_KEY = 'ptRosterTeams', LS_MONTH = 'ptRosterUpdatedMonth', LS_DATE = 'ptRosterUpdatedDate';
  function currentYM() { const d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2); }
  function currentDate() { const d = new Date(); return d.getFullYear() + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + ('0' + d.getDate()).slice(-2); }
  function loadTeams() { try { const s = localStorage.getItem(LS_KEY); if (s) { const t = JSON.parse(s); if (t && t.length === 4) return { teams: t, source: 'uploaded' }; } } catch (e) {} return { teams: DEFAULT_TEAMS, source: 'default' }; }
  function saveTeams(t) { try { localStorage.setItem(LS_KEY, JSON.stringify(t)); return true; } catch (e) { return false; } }
  function getUpdatedMonth() { try { return localStorage.getItem(LS_MONTH) || null; } catch (e) { return null; } }
  function setUpdatedMonth(m) { try { localStorage.setItem(LS_MONTH, m); } catch (e) {} }
  function getUpdatedDate() { try { return localStorage.getItem(LS_DATE) || null; } catch (e) { return null; } }
  function setUpdatedDate(d) { try { localStorage.setItem(LS_DATE, d); } catch (e) {} }
  function needRosterReminder() { if (loadTeams().source !== 'uploaded') return false; return getUpdatedMonth() !== currentYM(); }

  const NAME_ID = /([一-鿿]{2,4})\s*(\d{5,6})/;
  function pcell(c) { const m = (c || '').trim().match(NAME_ID); return m ? { name: m[1], id: m[2] } : null; }
  function parseRosterCSV(raw) {
    let lines = raw.split(/\r?\n/);
    let end = lines.length, seen = 0;
    for (let i = 0; i < lines.length; i++) { const c0 = (lines[i].split(',')[0] || '').trim(); if (/^\d{4}-\d{2}/.test(c0)) { seen++; if (seen === 2) { end = i; break; } } }
    lines = lines.slice(0, end);
    const teams = [0, 1, 2, 3].map(function () { return { professor: null, attendings: [], r11c: [], r11d: [] }; });
    let section = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const cells = line.split(','), label = (cells[0] || '').trim();
      if (label === '教授') { section = 'att'; teams.forEach(function (t, i) { const p = pcell(cells[i + 1]); if (p) { t.professor = p; t.attendings.push(p); } }); }
      else if (label === '主治醫師') { section = 'att'; teams.forEach(function (t, i) { const p = pcell(cells[i + 1]); if (p) t.attendings.push(p); }); }
      else if (/11C/.test(label) && /住院醫師/.test(label)) { section = '11c'; teams.forEach(function (t, i) { const p = pcell(cells[i + 1]); if (p) t.r11c.push(p); }); }
      else if (/11D/.test(label) && /住院醫師/.test(label)) { section = '11d'; teams.forEach(function (t, i) { const p = pcell(cells[i + 1]); if (p) t.r11d.push(p); }); }
      else if (label === '' && section) { teams.forEach(function (t, i) { const p = pcell(cells[i + 1]); if (p) { if (section === 'att') t.attendings.push(p); else if (section === '11c') t.r11c.push(p); else if (section === '11d') t.r11d.push(p); } }); }
    }
    const out = teams.map(function (t) { return { professor: t.professor, attendings: t.attendings, r11c: t.r11c.length ? t.r11c[t.r11c.length - 1] : null, r11d: t.r11d.length ? t.r11d[t.r11d.length - 1] : null }; });
    for (let i = 0; i < 4; i++) { if (!out[i].professor || !out[i].r11c || !out[i].r11d) return { ok: false, error: '團隊' + i + '資料不完整' }; }
    return { ok: true, teams: out };
  }
  function buildIndex(teams) {
    const idx = new Map(), names = [];
    teams.forEach(function (t, ti) { idx.set(t.professor.name, { teamIndex: ti, id: t.professor.id }); names.push(t.professor.name); t.attendings.forEach(function (a) { if (!idx.has(a.name)) idx.set(a.name, { teamIndex: ti, id: a.id }); names.push(a.name); }); });
    return { idx: idx, names: names };
  }
  function nameById(teams, id) {
    if (!id) return null;
    for (const t of teams) {
      const people = [t.professor].concat(t.attendings || [], [t.r11c, t.r11d]);
      for (const p of people) if (p && p.id === id) return p.name;
    }
    return null;
  }
  function rOf(teams, ti, ward) { const t = teams[ti]; return ward === '11C' ? t.r11c : (ward === '11D' ? t.r11d : null); }

  // ====================== 病人 CSV(雙鍵:病歷號+姓名) ======================
  const CSV_KEY = 'ptCsvLines', CSV_BACKUP_KEY = 'ptCsvLinesBackup';
  let CSV_LINES = [];
  function ingestCSV(text, fn) { text.split(/\r?\n/).forEach(function (l) { if (l.trim()) CSV_LINES.push({ text: l, file: fn }); }); }
  function saveCsvLines() {
    const s = JSON.stringify(CSV_LINES);
    try { sessionStorage.setItem(CSV_KEY, s); } catch (e) {}
    try { localStorage.setItem(CSV_BACKUP_KEY, s); } catch (e) {}
  }
  function loadCsvLines() {
    try {
      const s = sessionStorage.getItem(CSV_KEY) || localStorage.getItem(CSV_BACKUP_KEY);
      if (!s) return [];
      const rows = JSON.parse(s);
      return Array.isArray(rows) ? rows : [];
    } catch (e) { return []; }
  }
  function linesByChartNo(chartNo) {
    if (!chartNo) return [];
    return CSV_LINES.filter(function (row) { return row.text.split(',').map(function (c) { return c.trim(); }).indexOf(chartNo) >= 0; });
  }
  function linesByName(name) {
    const exact = [], loose = [];
    CSV_LINES.forEach(function (row) { const cells = row.text.split(',').map(function (c) { return c.trim(); }); if (cells.indexOf(name) >= 0) exact.push(row); else if (row.text.indexOf(name) >= 0) loose.push(row); });
    return exact.length ? exact : loose;
  }
  function attendingsInLine(text, names) {
    const cells = text.split(',').map(function (c) { return c.trim(); }), hits = [];
    cells.forEach(function (c) { names.forEach(function (n) { if (c === n && hits.indexOf(n) < 0) hits.push(n); }); });
    if (!hits.length) names.forEach(function (n) { if (text.indexOf(n) >= 0 && hits.indexOf(n) < 0) hits.push(n); });
    return hits;
  }
  function resolveAttending(chartNo, name, names) {
    let lines = linesByChartNo(chartNo), via = 'chartNo';
    if (!lines.length) { lines = linesByName(name); via = 'name'; }
    if (!lines.length) return { status: 'skip', reason: 'CSV查無(病歷號+姓名皆無)' };
    if (lines.length > 1) {
      const set = new Set(); lines.forEach(function (l) { attendingsInLine(l.text, names).forEach(function (a) { set.add(a); }); });
      if (set.size === 1) return { status: 'ok', attending: Array.from(set)[0], via: via };
      return { status: 'skip', reason: 'CSV找到多行且主治不一致(' + via + ',' + lines.length + '行)' };
    }
    const hits = attendingsInLine(lines[0].text, names);
    if (!hits.length) return { status: 'skip', reason: '該行找不到對照表主治(' + via + ')' };
    if (hits.length > 1) return { status: 'skip', reason: '該行命中多主治:' + hits.join('/') };
    return { status: 'ok', attending: hits[0], via: via };
  }
  function computeExpected(teams, index, attendingName, ward) {
    const att = index.idx.get(attendingName);
    if (!att) return { status: 'skip', reason: '主治查無:' + attendingName };
    const r = rOf(teams, att.teamIndex, ward);
    if (!r) return { status: 'skip', reason: ward + '無對應R' };
    return { status: 'ok', vsId: att.id, vsName: attendingName, rId: r.id, rName: r.name };
  }

  // ====================== 頁面讀取 ======================
  function getChartNo() { const el = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_lblChartNo'); return el ? (el.textContent || '').trim() : null; }
  function getCurrentPatientName() { const lbl = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_LabelAbstractInfo'); if (!lbl) return null; const m = (lbl.textContent || '').trim().match(/^([一-鿿]{2,4})\s*\(/); return m ? m[1] : null; }
  function getCurrentWard() { const el = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_HiddenFieldBedIDSE'); if (el && el.value) { const m = el.value.match(/(\d{2}[A-Z])/); if (m) return m[1]; } const lbl = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_LabelAbstractInfo'); if (lbl) { const m = (lbl.textContent || '').match(/(\d{2}[A-Z])\s*-/); if (m) return m[1]; } return null; }
  function readFilledRoles() {
    const r = { vsId: null, vsName: null, rId: null, rName: null };
    document.querySelectorAll('#NTUHWeb1_DataGridAccountList tr').forEach(function (tr) {
      const rs = tr.querySelector('span[id*="_RoleName"]'), es = tr.querySelector('span[id*="_EmpNo"]:not([id*="EmpNoName"])'), ns = tr.querySelector('span[id*="_EmpNoName"]');
      if (!rs || !es) return;
      const role = (rs.textContent || '').trim(), emp = (es.textContent || '').trim(), name = ns ? (ns.textContent || '').trim() : null;
      if (role === '主治醫師') { r.vsId = emp; r.vsName = name; } else if (role === 'R或NP') { r.rId = emp; r.rName = name; }
    });
    return r;
  }
  function findFilledRoleRow(roleText) {
    const rows = document.querySelectorAll('#NTUHWeb1_DataGridAccountList tr');
    for (const tr of rows) {
      const rs = tr.querySelector('span[id*="_RoleName"]');
      if (rs && (rs.textContent || '').trim() === roleText) return tr;
    }
    return null;
  }
  function clickDeleteFilledRole(roleText) {
    const tr = findFilledRoleRow(roleText);
    if (!tr) return '找不到已填的' + roleText + '列';
    const controls = tr.querySelectorAll('a,button,input[type="button"],input[type="submit"],input[type="image"]');
    for (const el of controls) {
      const label = ((el.textContent || '') + ' ' + (el.value || '') + ' ' + (el.title || '') + ' ' + (el.alt || '') + ' ' + (el.id || '') + ' ' + (el.name || '') + ' ' + (el.getAttribute('href') || '')).trim();
      if (/(刪除|删除|Delete|DELETE|Del|DEL)/.test(label)) { el.click(); return null; }
    }
    return '找不到' + roleText + '列的刪除按鈕';
  }
  function buildMenuIndex() {
    const list = [], seen = new Set();
    document.querySelectorAll('a[href*="MenuPatientList"]').forEach(function (a) {
      const txt = (a.textContent || '').trim(), m = txt.match(/^(\d{2}[A-Z])[_\s]*([\d_]+)_([一-鿿]+)$/);
      if (!m) return; if (seen.has(m[3])) return; seen.add(m[3]);
      const href = a.getAttribute('href') || '', tm = href.match(/Shift\\\\(T0_I_[^']+)/) || href.match(/Shift\\(T0_I_[^']+)/);
      list.push({ name: m[3], ward: m[1], token: tm ? tm[1] : null });
    });
    return list;
  }

  // ====================== 寫入 ======================
  function setInput(el, val) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  function findRoleInputs(roleText) {
    const links = document.querySelectorAll('a[id*="RoleCategoryList"][id$="LinkButtonRoleName"]');
    for (const link of links) {
      if ((link.textContent || '').trim() === roleText) {
        const m = link.id.match(/^(.*RoleCategoryList_ctl\d+)_LinkButtonRoleName$/); if (!m) continue;
        const p = m[1];
        return { empNo: document.querySelector('input[id^="' + p + '_RepeaterRoleEmpNo_"][id$="_EmpNoInput"]'), share: document.querySelector('input[id^="' + p + '_RepeaterRoleEmpNo_"][id$="_ShareInput"]') };
      }
    }
    return null;
  }
  function fillRoles(attId, rId) {
    const vs = findRoleInputs('主治醫師'); if (!vs || !vs.empNo) return '找不到主治醫師ID欄';
    setInput(vs.empNo, attId); if (vs.share && !vs.share.value) setInput(vs.share, '100');
    const r = findRoleInputs('R或NP'); if (!r || !r.empNo) return '找不到R或NP ID欄';
    setInput(r.empNo, rId); if (r.share && !r.share.value) setInput(r.share, '100');
    return null;
  }
  function fillRRole(rId) {
    const r = findRoleInputs('R或NP'); if (!r || !r.empNo) return '找不到R或NP ID欄';
    setInput(r.empNo, rId); if (r.share && !r.share.value) setInput(r.share, '100');
    return null;
  }
  const nativeAlert = window.alert;
  window.alert = function (msg) {
    try { sessionStorage.setItem('ptLastAlert', String(msg || '')); } catch (e) {}
    return nativeAlert.call(window, msg);
  };
  function getErrorMessage() { const el = document.getElementById('NTUHWeb1_ErrorMessage'); return el ? (el.textContent || '').trim() : ''; }
  function getLastAlert() { try { return sessionStorage.getItem('ptLastAlert') || ''; } catch (e) { return ''; } }
  function clearLastAlert() { try { sessionStorage.removeItem('ptLastAlert'); } catch (e) {} }
  function isFatalNotice(msg) {
    if (!msg) return false;
    if (/(錯誤|失敗|無法|不可|請|必須|重複|不存在|查無|異常|未輸入|不正確)/.test(msg)) return true;
    if (/(成功|完成|已新增|新增|儲存|通知資訊)/.test(msg)) return false;
    return false;
  }
  function clickInsert() { const b = document.getElementById('NTUHWeb1_InsertButton'); if (b) { b.click(); return true; } return false; }
  function switchTo(token) { if (!token) return false; try { __doPostBack('NTUHWeb1$PatientAbstractBasicInfo1$MenuPatientList', 'Shift\\' + token); return true; } catch (e) { return false; } }

  // ====================== 狀態機 ======================
  const SKEY = 'ptAutoFullState', SBACKUP_KEY = 'ptAutoFullStateBackup';
  function loadS() {
    try {
      const s = sessionStorage.getItem(SKEY) || localStorage.getItem(SBACKUP_KEY);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function saveS(s) {
    const raw = JSON.stringify(s);
    try { sessionStorage.setItem(SKEY, raw); } catch (e) {}
    try { localStorage.setItem(SBACKUP_KEY, raw); } catch (e) {}
  }
  function clearS() {
    try { sessionStorage.removeItem(SKEY); } catch (e) {}
    try { localStorage.removeItem(SBACKUP_KEY); } catch (e) {}
  }
  const DELAY = 600;
  const MAX_WAIT_TRIES = 8;

  // ====================== UI ======================
  const root = document.createElement('div'); root.id = 'perf-tool-root';
  root.innerHTML =
    '<div id="pt-fab" title="績效填入工具">績</div>' +
    '<div id="pt-panel" style="display:none">' +
      '<div id="pt-head"><span>績效填入 <span class="pt-tag">全自動 v1.8</span></span><span id="pt-close">✕</span></div>' +
      '<div id="pt-body">' +
        '<div id="pt-reminder" style="display:none"></div>' +
        '<div class="pt-sec">' +
          '<label>① 主治/住院醫師 對照表</label><div id="pt-roster-info"></div>' +
          '<div class="pt-hint">已存本機,平常直接使用、<b>不需重新上傳</b>。</div>' +
          '<a id="pt-show-roster" href="javascript:void(0)">顯示目前生效的對照表 ▾</a><div id="pt-roster-table" style="display:none"></div>' +
          '<a id="pt-toggle-update" href="javascript:void(0)" class="pt-subtle">⚙ 每月更新對照表</a>' +
          '<div id="pt-roster-actions" style="display:none"><label>上傳本月新值班表 CSV</label><input type="file" id="pt-roster" accept=".csv,text/csv" /></div>' +
        '</div>' +
        '<div class="pt-sec"><label>② 刀表病人 CSV(可多檔)</label><input type="file" id="pt-files" accept=".csv,text/csv" multiple /><div id="pt-files-info"></div></div>' +
        '<button type="button" id="pt-preview">解析並預覽佇列</button>' +
        '<div id="pt-queue"></div>' +
        '<div id="pt-controls" style="display:none"><button type="button" id="pt-start">▶ 開始全自動</button><button type="button" id="pt-stop" style="display:none">■ 停止</button></div>' +
        '<div id="pt-log"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  const style = document.createElement('style');
  style.textContent =
    '#perf-tool-root, #perf-tool-root * { box-sizing:border-box; font-family:"Segoe UI","Microsoft JhengHei",sans-serif; }' +
    '#pt-fab { position:fixed; right:20px; bottom:20px; width:46px; height:46px; border-radius:50%; background:#fff; color:#222; font-size:16px; font-weight:700; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:999999; box-shadow:0 2px 10px rgba(0,0,0,.25); border:1px solid #c9c9c9; }' +
    '#pt-panel { position:fixed; right:20px; bottom:76px; width:540px; max-height:84vh; overflow:auto; background:#fff; color:#222; border:1px solid #c9c9c9; border-radius:8px; z-index:999999; box-shadow:0 6px 28px rgba(0,0,0,.3); font-size:13px; }' +
    '#pt-head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f5f5f5; border-bottom:1px solid #ddd; font-weight:700; cursor:move; }' +
    '#pt-head .pt-tag { color:#888; font-weight:400; font-size:12px; } #pt-close { cursor:pointer; color:#888; }' +
    '#pt-body { padding:12px 14px; }' +
    '.pt-sec { padding:8px 0; border-bottom:1px dashed #e0e0e0; margin-bottom:6px; }' +
    '#pt-body label { display:block; margin:2px 0 6px; color:#333; font-size:12px; font-weight:600; }' +
    '#pt-body input[type=file] { width:100%; font-size:12px; padding:6px; border:1px solid #ccc; border-radius:5px; }' +
    '#pt-roster-info, #pt-files-info { margin-top:6px; font-size:11px; color:#555; }' +
    '#pt-body button#pt-preview, #pt-controls button { margin-top:10px; width:100%; padding:8px; border:none; border-radius:5px; font-weight:700; cursor:pointer; font-size:13px; }' +
    '#pt-preview { background:#333; color:#fff; } #pt-start { background:#1a7a1a; color:#fff; } #pt-stop { background:#b3331a; color:#fff; }' +
    '#pt-show-roster, #pt-toggle-update { display:inline-block; margin-top:8px; font-size:12px; text-decoration:none; }' +
    '#pt-show-roster { color:#555; } .pt-subtle { display:block; color:#aaa; font-size:11px; } .pt-subtle:hover { color:#777; }' +
    '.pt-hint { font-size:11px; color:#666; margin:4px 0 6px; line-height:1.5; }' +
    '.pt-upload-date { font-size:11px; color:#777; margin-top:3px; }' +
    '#pt-roster-actions { margin-top:8px; padding-top:8px; border-top:1px dotted #e0e0e0; }' +
    '#pt-roster-actions input[type=file] { margin-bottom:4px; }' +
    '#pt-queue h4, #pt-roster-table h4, #pt-log h4 { color:#333; margin:12px 0 6px; font-size:12px; border-bottom:1px solid #ddd; padding-bottom:3px; }' +
    '.pt-grid { width:100%; border-collapse:collapse; font-size:11px; } .pt-grid th,.pt-grid td { border:1px solid #ddd; padding:4px 6px; text-align:left; } .pt-grid th { background:#f5f5f5; } .pt-grid .rlabel td { background:#eee; font-weight:700; }' +
    '.pt-list { width:100%; border-collapse:collapse; font-size:11px; } .pt-list td { padding:3px 6px; border-bottom:1px solid #eee; }' +
    '.pt-ok { color:#1a7a1a; } .pt-done { color:#888; } .pt-warn2 { color:#c08a00; font-weight:600; } .pt-skip { color:#b34a2a; }' +
    '.pt-badge { display:inline-block; font-size:10px; padding:1px 6px; border-radius:8px; background:#eee; color:#555; margin-left:6px; }' +
    '.pt-note { background:#f5f5f5; border:1px solid #ddd; border-radius:5px; padding:8px; margin:8px 0; color:#444; font-size:11px; line-height:1.5; }' +
    '#pt-reminder { background:#fff4d0; border:1px solid #e0b34a; border-radius:5px; padding:8px 10px; margin-bottom:10px; color:#8a6a00; font-size:12px; line-height:1.5; }';
  document.head.appendChild(style);

  const $ = function (s) { return root.querySelector(s); };
  $('#pt-fab').onclick = function () { const p = $('#pt-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; if (p.style.display === 'block') refreshRosterInfo(); };
  $('#pt-close').onclick = function () { $('#pt-panel').style.display = 'none'; };
  (function () { const head = $('#pt-head'), panel = $('#pt-panel'); let dx, dy, drag = false; head.onmousedown = function (e) { if (e.target.id === 'pt-close') return; drag = true; const r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; }; document.onmousemove = function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; }; document.onmouseup = function () { drag = false; }; })();

  function refreshRosterInfo() {
    const t = loadTeams();
    let info = '目前生效:<b>' + (t.source === 'uploaded' ? '已上傳的對照表' : '內建預設') + '</b><span class="pt-badge">' + t.teams.map(function (x) { return x.professor.name; }).join('/') + '</span>';
    if (t.source === 'uploaded') info += '<div class="pt-upload-date">上傳日期:' + (getUpdatedDate() || '(未記錄)') + '</div>';
    $('#pt-roster-info').innerHTML = info;
    const rem = $('#pt-reminder');
    if (needRosterReminder()) { rem.innerHTML = '⚠ 本月（' + currentYM() + '）尚未更新對照表,目前仍使用 ' + (getUpdatedMonth() || '舊') + ' 的版本。'; rem.style.display = 'block'; const a = $('#pt-roster-actions'); if (a) a.style.display = 'block'; }
    else rem.style.display = 'none';
  }
  function renderRosterTable() {
    const t = loadTeams().teams;
    const prof = t.map(function (x) { return '<th>' + x.professor.name + '</th>'; }).join('');
    const maxA = Math.max.apply(null, t.map(function (x) { return x.attendings.length; }));
    let rows = '';
    for (let r = 1; r < maxA; r++) rows += '<tr>' + t.map(function (x) { return '<td>' + (x.attendings[r] ? x.attendings[r].name : '') + '</td>'; }).join('') + '</tr>';
    $('#pt-roster-table').innerHTML = '<h4>目前生效對照表</h4><table class="pt-grid"><tr>' + prof + '</tr>' + rows +
      '<tr class="rlabel"><td colspan="4">11C 資淺R</td></tr><tr>' + t.map(function (x) { return '<td>' + x.r11c.name + ' ' + x.r11c.id + '</td>'; }).join('') + '</tr>' +
      '<tr class="rlabel"><td colspan="4">11D 資淺R</td></tr><tr>' + t.map(function (x) { return '<td>' + x.r11d.name + ' ' + x.r11d.id + '</td>'; }).join('') + '</tr></table>';
  }
  $('#pt-show-roster').onclick = function () { const el = $('#pt-roster-table'); if (el.style.display === 'none') { renderRosterTable(); el.style.display = 'block'; $('#pt-show-roster').textContent = '隱藏對照表 ▴'; } else { el.style.display = 'none'; $('#pt-show-roster').textContent = '顯示目前生效的對照表 ▾'; } };
  $('#pt-toggle-update').onclick = function () { const el = $('#pt-roster-actions'); el.style.display = el.style.display === 'none' ? 'block' : 'none'; };
  $('#pt-roster').onchange = function (e) { const f = (e.target.files || [])[0]; if (!f) return; const reader = new FileReader(); reader.onload = function () { const res = parseRosterCSV(String(reader.result || '')); if (!res.ok) { $('#pt-roster-info').innerHTML = '<span class="pt-skip">解析失敗:' + res.error + '</span>'; return; } saveTeams(res.teams); setUpdatedMonth(currentYM()); setUpdatedDate(currentDate()); renderRosterTable(); $('#pt-roster-table').style.display = 'block'; refreshRosterInfo(); }; reader.readAsText(f, 'utf-8'); };
  function refreshCsvInfo(restored) {
    $('#pt-files-info').innerHTML = CSV_LINES.length ? (restored ? '已還原刀表 CSV,共 ' : '已讀取刀表 CSV,共 ') + CSV_LINES.length + ' 行。' : '';
  }
  $('#pt-files').onchange = function (e) { CSV_LINES = []; const files = Array.from(e.target.files || []); if (!files.length) { $('#pt-files-info').textContent = ''; return; } let done = 0; files.forEach(function (f) { const reader = new FileReader(); reader.onload = function () { ingestCSV(String(reader.result || ''), f.name); done++; if (done === files.length) { saveCsvLines(); refreshCsvInfo(false); } }; reader.readAsText(f, 'utf-8'); }); };
  CSV_LINES = loadCsvLines();
  refreshCsvInfo(true);

  function buildQueue() {
    const menu = buildMenuIndex();
    const queue = [];
    menu.forEach(function (mi) { if ((mi.ward === '11C' || mi.ward === '11D') && mi.token) queue.push(mi); });
    return queue;
  }
  $('#pt-preview').onclick = function (e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (!CSV_LINES.length) { $('#pt-queue').innerHTML = '<div class="pt-note">請先上傳刀表病人 CSV。</div>'; $('#pt-controls').style.display = 'none'; return false; }
    const teams = loadTeams().teams, index = buildIndex(teams);
    const menu = buildMenuIndex();
    let rows = '', n = 0;
    menu.forEach(function (mi) {
      if (mi.ward !== '11C' && mi.ward !== '11D') { rows += '<tr><td>' + mi.name + '</td><td class="pt-skip">病房' + mi.ward + '</td></tr>'; return; }
      const a = resolveAttending(null, mi.name, index.names);
      if (a.status !== 'ok') { rows += '<tr><td>' + mi.name + '</td><td>' + mi.ward + '</td><td class="pt-skip">' + a.reason + '</td></tr>'; return; }
      const exp = computeExpected(teams, index, a.attending, mi.ward);
      if (exp.status !== 'ok') { rows += '<tr><td>' + mi.name + '</td><td>' + mi.ward + '</td><td class="pt-skip">' + exp.reason + '</td></tr>'; return; }
      rows += '<tr><td>' + mi.name + '</td><td>' + mi.ward + '</td><td>主治 <b>' + exp.vsId + '</b> / R ' + exp.rName + ' <b>' + exp.rId + '</b></td></tr>'; n++;
    });
    $('#pt-queue').innerHTML = '<h4>當前選單病人預覽(' + menu.length + ' 位,可對到 ' + n + ' 位)</h4><div class="pt-note">實際執行時會逐一切換、用病歷號精確比對、並自動略過已填一致的病人。</div><table class="pt-list">' + rows + '</table>';
    $('#pt-controls').style.display = buildQueue().length ? 'block' : 'none';
    return false;
  };

  $('#pt-start').onclick = function (e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const queue = buildQueue();
    if (!queue.length) return false;
    if (!confirm('即將全自動巡檢 ' + queue.length + ' 位病人:完全未填的會自動填主治+R並新增,已填一致的跳過,不一致/半填的標記。\n過程請勿操作頁面。確定開始?')) return false;
    const S = { running: true, phase: 'AFTER_SWITCH', queue: queue, idx: 0, expectName: queue[0].name, expectChart: null, log: [] };
    saveS(S);
    $('#pt-start').style.display = 'none'; $('#pt-stop').style.display = 'block';
    switchTo(queue[0].token);
    return false;
  };
  $('#pt-stop').onclick = function (e) { if (e) { e.preventDefault(); e.stopPropagation(); } clearS(); $('#pt-stop').style.display = 'none'; $('#pt-start').style.display = 'block'; appendLog('⏹ 已停止(手動)', false); return false; };
  function appendLog(text, ok) { const box = $('#pt-log'); if (!box.querySelector('h4')) box.innerHTML = '<h4>執行紀錄</h4><div id="pt-logbody"></div>'; $('#pt-logbody').innerHTML += '<div class="' + (ok ? 'pt-ok' : 'pt-skip') + '">' + text + '</div>'; }
  function renderLog(S) { $('#pt-log').innerHTML = '<h4>執行紀錄(' + S.idx + '/' + S.queue.length + ')</h4><div>' + S.log.map(function (l) { return '<div class="' + l.cls + '">' + l.text + '</div>'; }).join('') + '</div>'; }
  function fmtPair(vsName, rName) { return '主治 ' + (vsName || '未知') + ' / R ' + (rName || '未知'); }
  function fmtPerson(name, id) { return (name || '未知') + (id ? ' ' + id : ''); }
  function fmtMismatchText(patientName, filled, exp, teams) {
    const currentVsName = filled.vsName || nameById(teams, filled.vsId);
    const currentRName = filled.rName || nameById(teams, filled.rId);
    const vsText = filled.vsId === exp.vsId ? fmtPerson(currentVsName, filled.vsId) : fmtPerson(currentVsName, filled.vsId) + '->' + fmtPerson(exp.vsName, exp.vsId);
    const rText = filled.rId === exp.rId ? fmtPerson(currentRName, filled.rId) : fmtPerson(currentRName, filled.rId) + '->' + fmtPerson(exp.rName, exp.rId);
    return '⚠ ' + patientName + ' 已填但與刀表不一致。目前->理論:主治 ' + vsText + ' / R ' + rText;
  }

  function halt(S, text) { S.running = false; S.log.push({ cls: 'pt-skip', text: text }); saveS(S); renderLog(S); $('#pt-stop').style.display = 'none'; $('#pt-start').style.display = 'block'; }
  function waitAndRetry(S, reason, finalText) {
    S.waitTries = (S.waitTries || 0) + 1;
    if (S.waitTries > MAX_WAIT_TRIES) { halt(S, finalText || reason); return true; }
    if (S.waitTries === 1 || S.waitTries === 4) S.log.push({ cls: 'pt-warn2', text: '… 等待頁面更新:' + reason });
    saveS(S);
    renderLog(S);
    setTimeout(tick, DELAY * 2);
    return true;
  }
  function resetWait(S) { S.waitTries = 0; }

  function tick() {
    const S = loadS(); if (!S || !S.running) return;
    $('#pt-panel').style.display = 'block'; $('#pt-start').style.display = 'none'; $('#pt-stop').style.display = 'block';
    renderLog(S);
    if (!CSV_LINES.length) {
      CSV_LINES = loadCsvLines();
      refreshCsvInfo(true);
      if (!CSV_LINES.length) { halt(S, '✗ 停止:刀表 CSV 暫存遺失,請重新上傳後再開始'); return; }
    }
    const teams = loadTeams().teams, index = buildIndex(teams);
    const it = S.queue[S.idx];

    if (S.phase === 'AFTER_SWITCH') {
      const curName = getCurrentPatientName(), curChart = getChartNo();
      if (curName !== it.name) {
        waitAndRetry(S, '切換到「' + it.name + '」中,目前畫面是「' + (curName || '無') + '」', '✗ 停止:預期「' + it.name + '」但畫面是「' + (curName || '無') + '」');
        return;
      }
      resetWait(S);
      S.expectChart = curChart;
      const ward = getCurrentWard() || it.ward;
      const filled = readFilledRoles();
      const a = resolveAttending(curChart, curName, index.names);
      let exp = null;
      if (a.status === 'ok') exp = computeExpected(teams, index, a.attending, ward);

      const hasVS = !!filled.vsId, hasR = !!filled.rId;
      if (hasVS && hasR) {
        if (exp && exp.status === 'ok' && filled.vsId === exp.vsId && filled.rId === exp.rId) S.log.push({ cls: 'pt-done', text: '○ ' + it.name + ' 已填且一致,跳過' });
        else {
          if (exp && exp.status === 'ok') {
            const mismatchText = fmtMismatchText(it.name, filled, exp, teams);
            if (filled.vsId === exp.vsId && filled.rId !== exp.rId && confirm(mismatchText + '\n\n主治相同但 R 不同，是否更新 R 為理論值？')) {
              const delErr = clickDeleteFilledRole('R或NP');
              if (delErr) { halt(S, '✗ 停止:' + it.name + ' 刪除原R失敗:' + delErr); return; }
              S._oldRId = filled.rId;
              S._oldRName = filled.rName || nameById(teams, filled.rId);
              S._pendingRId = exp.rId;
              S._pendingRName = exp.rName;
              S._pendingDesc = it.name + ' R ' + fmtPerson(S._oldRName, S._oldRId) + '->' + fmtPerson(exp.rName, exp.rId);
              S.phase = 'AFTER_R_DELETE'; saveS(S);
              clearLastAlert();
              setTimeout(tick, DELAY * 3);
              return;
            }
            S.log.push({ cls: 'pt-warn2', text: mismatchText });
          } else {
            S.log.push({ cls: 'pt-warn2', text: '⚠ ' + it.name + ' 已填但與刀表不一致。目前填入:' + fmtPair(filled.vsName || nameById(teams, filled.vsId), filled.rName || nameById(teams, filled.rId)) + '；理論上應填入:無法推算(' + (a && a.status !== 'ok' ? a.reason : (exp ? exp.reason : '主治解析失敗')) + ')' });
          }
        }
        advance(S); return;
      }
      if (hasVS || hasR) { S.log.push({ cls: 'pt-skip', text: '⚠ ' + it.name + ' 半填(缺主治或R),保留待手動' }); advance(S); return; }
      if (!a || a.status !== 'ok') { S.log.push({ cls: 'pt-skip', text: '— ' + it.name + ' 無法填:' + (a ? a.reason : '主治解析失敗') }); advance(S); return; }
      if (exp.status !== 'ok') { S.log.push({ cls: 'pt-skip', text: '— ' + it.name + ' 無法填:' + exp.reason }); advance(S); return; }
      const err = fillRoles(exp.vsId, exp.rId);
      if (err) { halt(S, '✗ 停止:' + it.name + ' 填入失敗:' + err); return; }
      S._pendingDesc = it.name + ' (' + ward + ') 主治 ' + exp.vsId + ' / R ' + exp.rName + ' ' + exp.rId;
      S._pendingVsId = exp.vsId;
      S._pendingRId = exp.rId;
      S.phase = 'AFTER_INSERT'; saveS(S);
      clearLastAlert();
      setTimeout(function () {
        if (clickInsert()) setTimeout(tick, DELAY * 3);
      }, DELAY);
      return;
    }

    if (S.phase === 'AFTER_INSERT') {
      const notice = getErrorMessage() || getLastAlert();
      const filledAfter = readFilledRoles();
      if (notice && isFatalNotice(notice)) { halt(S, '✗ 停止:' + it.name + ' 新增後錯誤:' + notice); return; }
      if (!notice && (!filledAfter.vsId || !filledAfter.rId)) {
        waitAndRetry(S, it.name + ' 新增後確認中', '✗ 停止:' + it.name + ' 新增後未看到成功通知或已填資料');
        return;
      }
      if (filledAfter.vsId && filledAfter.rId && S._pendingVsId && S._pendingRId && (filledAfter.vsId !== S._pendingVsId || filledAfter.rId !== S._pendingRId)) {
        halt(S, '✗ 停止:' + it.name + ' 新增後畫面資料不一致:主治 ' + filledAfter.vsId + ' / R ' + filledAfter.rId);
        return;
      }
      resetWait(S);
      S.log.push({ cls: 'pt-ok', text: '✓ ' + (S._pendingDesc || it.name) + (notice ? '；通知:' + notice : '') });
      clearLastAlert();
      advance(S); return;
    }

    if (S.phase === 'AFTER_R_DELETE') {
      const notice = getErrorMessage() || getLastAlert();
      const filledAfter = readFilledRoles();
      if (notice && isFatalNotice(notice)) { halt(S, '✗ 停止:' + it.name + ' 刪除原R後錯誤:' + notice); return; }
      if (filledAfter.rId) {
        waitAndRetry(S, it.name + ' 刪除原R後確認中', '✗ 停止:' + it.name + ' 刪除原R後仍看到R=' + filledAfter.rId);
        return;
      }
      resetWait(S);
      const rErr = fillRRole(S._pendingRId);
      if (rErr) { halt(S, '✗ 停止:' + it.name + ' 重新填R失敗:' + rErr); return; }
      S.phase = 'AFTER_R_UPDATE'; saveS(S);
      clearLastAlert();
      setTimeout(function () {
        if (clickInsert()) setTimeout(tick, DELAY * 3);
      }, DELAY);
      return;
    }

    if (S.phase === 'AFTER_R_UPDATE') {
      const notice = getErrorMessage() || getLastAlert();
      const filledAfter = readFilledRoles();
      if (notice && isFatalNotice(notice)) { halt(S, '✗ 停止:' + it.name + ' 更新R後錯誤:' + notice); return; }
      if (!filledAfter.rId || filledAfter.rId !== S._pendingRId) {
        waitAndRetry(S, it.name + ' 更新R後確認中', '✗ 停止:' + it.name + ' 更新R後未看到理論值,目前R=' + (filledAfter.rId || '空'));
        return;
      }
      resetWait(S);
      S.log.push({ cls: 'pt-ok', text: '✓ ' + (S._pendingDesc || (it.name + ' R已更新')) + (notice ? '；通知:' + notice : '') });
      clearLastAlert();
      advance(S); return;
    }
  }
  function advance(S) {
    S.idx += 1;
    if (S.idx >= S.queue.length) { S.running = false; S.log.push({ cls: 'pt-ok', text: '── 完成,共處理 ' + S.queue.length + ' 位 ──' }); saveS(S); renderLog(S); $('#pt-stop').style.display = 'none'; $('#pt-start').style.display = 'block'; clearS(); return; }
    const next = S.queue[S.idx];
    S.phase = 'AFTER_SWITCH'; S.expectName = next.name; saveS(S); renderLog(S);
    setTimeout(function () { switchTo(next.token); }, DELAY);
  }

  window.addEventListener('load', function () { setTimeout(function () { refreshRosterInfo(); tick(); }, 250); });
  refreshRosterInfo();
})();
