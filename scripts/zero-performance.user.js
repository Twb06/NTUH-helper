// ==UserScript==
// @name         NTUH 掛0%績效工具 (半自動寫入版 v1.4.1)
// @namespace    ntuh-zero
// @version      1.4.1
// @description  一鍵把指定員編以0%掛進當前病人的R角色:讀現有R→設人數(VS0/成本0/R現有+1)→照抄舊R+自己0%→刪舊R→新增。狀態機跨postback接力。不切換病人。
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/EnterTakeCarePersonInfo.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/zero-performance.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/zero-performance.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const LS_SELF = 'ptZeroSelfEmp';
  const SKEY = 'ptZeroState';
  const DELAY = 600;
  const MAX_WAIT = 8;

  // 角色名稱常數（若系統改名請在此修改）
  const ROLE_VS   = '主治醫師';
  const ROLE_R    = 'R或NP';
  const ROLE_COST = '成本中心';

  function getSelfEmp() { try { return localStorage.getItem(LS_SELF) || ''; } catch (e) { return ''; } }
  function setSelfEmp(v) { try { localStorage.setItem(LS_SELF, v); } catch (e) {} }
  function loadS() { try { const s = sessionStorage.getItem(SKEY); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function saveS(s) { s._ts = Date.now(); try { sessionStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {} }
  function clearS() { try { sessionStorage.removeItem(SKEY); } catch (e) {} }

  // ---------- 頁面讀取 ----------
  function getCurrentPatientName() { const lbl = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_LabelAbstractInfo'); if (!lbl) return null; const m = (lbl.textContent || '').trim().match(/^([一-鿿]{2,4})\s*\(/); return m ? m[1] : null; }
  function getChartNo() { const el = document.getElementById('NTUHWeb1_PatientAbstractBasicInfo1_lblChartNo'); return el ? (el.textContent || '').trim() : null; }
  function readAllRoles() {
    const out = [];
    document.querySelectorAll('#NTUHWeb1_DataGridAccountList tr').forEach(function (tr) {
      const rs = tr.querySelector('span[id*="_RoleName"]'), es = tr.querySelector('span[id*="_EmpNo"]:not([id*="EmpNoName"])'), ns = tr.querySelector('span[id*="_EmpNoName"]'), ws = tr.querySelector('span[id*="_ShareWeight"]');
      if (!rs || !es) return;
      out.push({ role: (rs.textContent || '').trim(), emp: (es.textContent || '').trim(), name: ns ? (ns.textContent || '').trim() : '', weight: ws ? (ws.textContent || '').trim().replace('%', '') : '' });
    });
    return out;
  }
  function existingRs() { return readAllRoles().filter(function (r) { return r.role === ROLE_R; }); }

  // ---------- 人數下拉：從 CheckBoxRole 出發，讀夾在 checkbox 與 select 之間的文字定位角色 ----------
  function buildRoleSelectMap() {
    const map = {};
    const checkboxes = document.querySelectorAll('input[type="checkbox"][id*="RoleList_"][id*="_CheckBoxRole"]');
    checkboxes.forEach(function (cb) {
      const m = cb.id.match(/(.*RoleList_ctl\d+)_CheckBoxRole/);
      if (!m) return;
      const sel = document.getElementById(m[1] + '_VSAmount');
      if (!sel) return;
      // 讀 checkbox 到 select 之間的文字
      let text = '';
      let node = cb.nextSibling;
      while (node && !(node.nodeType === 1 && node.tagName === 'SELECT')) {
        text += (node.nodeType === 3 ? node.textContent : (node.textContent || ''));
        node = node.nextSibling;
      }
      const name = text.trim();
      if (name) map[name] = sel;
    });
    return map;
  }
  function amountSelectByRole(roleText) {
    const map = buildRoleSelectMap();
    // 先嘗試完全比對，再嘗試 includes（容錯空白差異）
    if (map[roleText]) return map[roleText];
    for (const key in map) { if (key.indexOf(roleText) !== -1 || roleText.indexOf(key) !== -1) return map[key]; }
    return null;
  }
  function getAmountByRole(roleText) { const s = amountSelectByRole(roleText); return s ? s.value : null; }
  function setAmountByRole(roleText, val) {
    const s = amountSelectByRole(roleText);
    if (!s) return false;
    if (s.value === String(val)) return 'nochange';
    s.value = String(val);
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  // 掃描頁面所有角色+目前人數（除錯用）
  function scanRoleAmounts() {
    const map = buildRoleSelectMap();
    return Object.keys(map).map(function (k) { return k + ':' + map[k].value; }).join(' / ') || '（無法掃描）';
  }

  // ---------- 輸入框(角色名稱定位) ----------
  function setInput(el, val) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
  function roleEmpRows(roleText) {
    const links = document.querySelectorAll('a[id*="RoleCategoryList"][id$="LinkButtonRoleName"]');
    for (const link of links) {
      if ((link.textContent || '').trim() === roleText) {
        const m = link.id.match(/^(.*RoleCategoryList_ctl\d+)_LinkButtonRoleName$/); if (!m) continue;
        const prefix = m[1];
        const emps = Array.prototype.slice.call(document.querySelectorAll('input[id^="' + prefix + '_RepeaterRoleEmpNo_"][id$="_EmpNoInput"]'));
        const rows = emps.map(function (e) {
          const share = document.getElementById(e.id.replace('_EmpNoInput', '_ShareInput'));
          return { emp: e, share: share };
        });
        return rows;
      }
    }
    return [];
  }

  // ---------- 刪除 DataGrid 的 R ----------
  function rDeleteLinks() {
    const links = [];
    document.querySelectorAll('#NTUHWeb1_DataGridAccountList tr').forEach(function (tr) {
      const rs = tr.querySelector('span[id*="_RoleName"]');
      if (!rs || (rs.textContent || '').trim() !== ROLE_R) return;
      const del = tr.querySelector('a[id*="DeleteLinkButton"]');
      if (del) links.push(del);
    });
    return links;
  }

  function clickInsert() { const b = document.getElementById('NTUHWeb1_InsertButton'); if (b) { b.click(); return true; } return false; }
  function getErrorMessage() { const el = document.getElementById('NTUHWeb1_ErrorMessage'); return el ? (el.textContent || '').trim() : ''; }
  function isFatalNotice(msg) {
    if (!msg) return false;
    if (/(成功|完成|已新增|新增成功|儲存|通知資訊)/.test(msg)) return false;
    if (/(錯誤|失敗|無法|不可|請|必須|重複|不存在|查無|異常|未輸入|不正確)/.test(msg)) return true;
    return false;
  }

  // ---------- UI ----------
  const root = document.createElement('div'); root.id = 'pt-zero-root';
  root.innerHTML =
    '<div id="ptz-fab" title="掛0%績效工具">0%</div>' +
    '<div id="ptz-panel" style="display:none">' +
      '<div id="ptz-head"><span>掛0%績效 <span class="ptz-tag">半自動寫入 v1.4.1</span></span><span id="ptz-close">✕</span></div>' +
      '<div id="ptz-body">' +
        '<label>要掛 0% 的員編(預設掛自己,可改)</label>' +
        '<input type="text" id="ptz-emp" placeholder="輸入員編" />' +
        '<button type="button" id="ptz-go">掛 0% 到當前病人</button>' +
        '<div id="ptz-log"></div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(root);

  const style = document.createElement('style');
  style.textContent =
    '#pt-zero-root, #pt-zero-root * { box-sizing:border-box; font-family:"Segoe UI","Microsoft JhengHei",sans-serif; }' +
    '#ptz-fab { position:fixed; right:80px; bottom:20px; width:46px; height:46px; border-radius:50%; background:#fff; color:#1a5; font-size:14px; font-weight:700; display:flex; align-items:center; justify-content:center; cursor:pointer; z-index:999998; box-shadow:0 2px 10px rgba(0,0,0,.25); border:1px solid #c9c9c9; }' +
    '#ptz-panel { position:fixed; right:80px; bottom:76px; width:440px; max-height:80vh; overflow:auto; background:#fff; color:#222; border:1px solid #c9c9c9; border-radius:8px; z-index:999998; box-shadow:0 6px 28px rgba(0,0,0,.3); font-size:13px; }' +
    '#ptz-head { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f5f5f5; border-bottom:1px solid #ddd; font-weight:700; cursor:move; }' +
    '#ptz-head .ptz-tag { color:#888; font-weight:400; font-size:12px; } #ptz-close { cursor:pointer; color:#888; }' +
    '#ptz-body { padding:12px 14px; }' +
    '#ptz-body label { display:block; margin:4px 0 4px; color:#333; font-size:12px; font-weight:600; }' +
    '#ptz-body input[type=text] { width:100%; padding:6px 8px; border:1px solid #ccc; border-radius:5px; font-size:13px; font-family:monospace; }' +
    '#ptz-body button { margin-top:10px; width:100%; padding:8px; border:none; border-radius:5px; font-weight:700; cursor:pointer; font-size:13px; background:#1a7a1a; color:#fff; }' +
    '#ptz-log h4 { color:#333; margin:12px 0 6px; font-size:12px; border-bottom:1px solid #ddd; padding-bottom:3px; }' +
    '#ptz-log div { font-size:11px; padding:2px 0; line-height:1.5; }' +
    '.ptz-ok { color:#1a7a1a; } .ptz-skip { color:#b34a2a; } .ptz-step { color:#555; } .ptz-warn { color:#c08a00; }';
  document.head.appendChild(style);

  const $ = function (s) { return root.querySelector(s); };
  $('#ptz-fab').onclick = function () { const p = $('#ptz-panel'); p.style.display = p.style.display === 'none' ? 'block' : 'none'; if (p.style.display === 'block') $('#ptz-emp').value = getSelfEmp(); };
  $('#ptz-close').onclick = function () { $('#ptz-panel').style.display = 'none'; };
  (function () { const head = $('#ptz-head'), panel = $('#ptz-panel'); let dx, dy, drag = false; head.onmousedown = function (e) { if (e.target.id === 'ptz-close') return; drag = true; const r = panel.getBoundingClientRect(); dx = e.clientX - r.left; dy = e.clientY - r.top; panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px'; }; document.addEventListener('mousemove', function (e) { if (!drag) return; panel.style.left = (e.clientX - dx) + 'px'; panel.style.top = (e.clientY - dy) + 'px'; }); document.addEventListener('mouseup', function () { drag = false; }); })();

  function renderLog(S) {
    const box = $('#ptz-log');
    box.innerHTML = '<h4>執行紀錄' + (S ? '(' + (S.patient || '') + ')' : '') + '</h4>' + (S && S.log ? S.log.map(function (l) { return '<div class="' + l.cls + '">' + l.text + '</div>'; }).join('') : '');
  }
  function log(S, text, cls) { S.log.push({ text: text, cls: cls || 'ptz-step' }); saveS(S); renderLog(S); }
  function halt(S, text) { S.running = false; S.log.push({ text: text, cls: 'ptz-skip' }); saveS(S); renderLog(S); }
  function done(S, text) { S.running = false; S.log.push({ text: text, cls: 'ptz-ok' }); saveS(S); renderLog(S); clearS(); }

  // 開始
  $('#ptz-go').onclick = function (e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    const emp = ($('#ptz-emp').value || '').trim();
    if (!emp) { alert('請先輸入要掛 0% 的員編'); return false; }
    setSelfEmp(emp);

    const patient = getCurrentPatientName(), chart = getChartNo();
    const rs = existingRs();
    if (!rs.length) { alert('讀不到現有的 R,無法掛 0%(掛0%需原本已有真正的R)。'); return false; }
    if (rs.some(function (r) { return r.emp === emp; })) { alert('員編 ' + emp + ' 已在現有 R 名單中,無需再掛。'); return false; }

    // 確認三個關鍵下拉都找得到
    const scanMsg = scanRoleAmounts();
    if (!amountSelectByRole(ROLE_VS))   { alert('找不到「' + ROLE_VS + '」人數下拉。\n頁面偵測到角色：' + scanMsg); return false; }
    if (!amountSelectByRole(ROLE_R))    { alert('找不到「' + ROLE_R + '」人數下拉。\n頁面偵測到角色：' + scanMsg); return false; }
    if (!amountSelectByRole(ROLE_COST)) { alert('找不到「' + ROLE_COST + '」人數下拉。\n頁面偵測到角色：' + scanMsg); return false; }

    const plan = rs.map(function (r) { return r.emp + ' ' + r.weight + '%'; }).join('、');

    const S = {
      running: true, phase: 'SET_VS0', patient: patient, chart: chart, emp: emp,
      oldRs: rs.map(function (r) { return { emp: r.emp, weight: r.weight || '100' }; }),
      targetRcount: rs.length + 1, waitTries: 0, log: [],
    };
    saveS(S);
    log(S, '頁面角色掃描：' + scanMsg, 'ptz-warn');
    log(S, '開始:現有 R ' + plan + ' → 加掛 ' + emp + ' 0%', 'ptz-step');
    tick();
    return false;
  };

  function waitRetry(S, reason) {
    S.waitTries = (S.waitTries || 0) + 1;
    if (S.waitTries > MAX_WAIT) { halt(S, '✗ 停止:' + reason + '(等待逾時)'); return; }
    saveS(S);
    setTimeout(tick, DELAY * 2);
  }
  function resetWait(S) { S.waitTries = 0; saveS(S); }

  // 狀態機
  function tick() {
    const S = loadS(); if (!S || !S.running) return;
    $('#ptz-panel').style.display = 'block';
    renderLog(S);

    const errMsg = getErrorMessage();

    if (S.phase === 'SET_VS0') {
      if (getAmountByRole(ROLE_VS) === '0') { S.phase = 'SET_COST0'; resetWait(S); tick(); return; }
      const r = setAmountByRole(ROLE_VS, 0);
      if (r === false) { halt(S, '✗ 找不到「' + ROLE_VS + '」人數下拉（頁面角色：' + scanRoleAmounts() + '）'); return; }
      if (r === 'nochange') { S.phase = 'SET_COST0'; saveS(S); tick(); return; }
      log(S, '① ' + ROLE_VS + ' 人數 → 0', 'ptz-step');
      S.phase = 'WAIT_VS0'; saveS(S);
      return;
    }
    if (S.phase === 'WAIT_VS0') {
      if (getAmountByRole(ROLE_VS) === '0') { S.phase = 'SET_COST0'; resetWait(S); tick(); return; }
      waitRetry(S, ROLE_VS + '人數設0未生效'); return;
    }

    if (S.phase === 'SET_COST0') {
      if (getAmountByRole(ROLE_COST) === '0') { S.phase = 'SET_RCOUNT'; resetWait(S); tick(); return; }
      const r = setAmountByRole(ROLE_COST, 0);
      if (r === false) { halt(S, '✗ 找不到「' + ROLE_COST + '」人數下拉（頁面角色：' + scanRoleAmounts() + '）'); return; }
      if (r === 'nochange') { S.phase = 'SET_RCOUNT'; saveS(S); tick(); return; }
      log(S, '② ' + ROLE_COST + ' 人數 → 0', 'ptz-step');
      S.phase = 'WAIT_COST0'; saveS(S);
      return;
    }
    if (S.phase === 'WAIT_COST0') {
      if (getAmountByRole(ROLE_COST) === '0') { S.phase = 'SET_RCOUNT'; resetWait(S); tick(); return; }
      waitRetry(S, ROLE_COST + '人數設0未生效'); return;
    }

    if (S.phase === 'SET_RCOUNT') {
      if (getAmountByRole(ROLE_R) === String(S.targetRcount)) { S.phase = 'FILL'; resetWait(S); tick(); return; }
      const r = setAmountByRole(ROLE_R, S.targetRcount);
      if (r === false) { halt(S, '✗ 找不到「' + ROLE_R + '」人數下拉（頁面角色：' + scanRoleAmounts() + '）'); return; }
      if (r === 'nochange') { S.phase = 'FILL'; saveS(S); tick(); return; }
      log(S, '③ ' + ROLE_R + ' 人數 → ' + S.targetRcount, 'ptz-step');
      S.phase = 'WAIT_RCOUNT'; saveS(S);
      return;
    }
    if (S.phase === 'WAIT_RCOUNT') {
      if (getAmountByRole(ROLE_R) === String(S.targetRcount)) { S.phase = 'FILL'; resetWait(S); tick(); return; }
      waitRetry(S, ROLE_R + '人數設定未生效'); return;
    }

    if (S.phase === 'FILL') {
      const rows = roleEmpRows(ROLE_R);
      if (rows.length < S.targetRcount) { waitRetry(S, 'R輸入格數不足(' + rows.length + '/' + S.targetRcount + ')'); return; }
      resetWait(S);
      for (let i = 0; i < S.oldRs.length; i++) {
        setInput(rows[i].emp, S.oldRs[i].emp);
        if (rows[i].share) setInput(rows[i].share, S.oldRs[i].weight);
      }
      const last = rows[S.oldRs.length];
      setInput(last.emp, S.emp);
      if (last.share) setInput(last.share, '0');
      log(S, '④ 已填入:' + S.oldRs.map(function (r) { return r.emp + '(' + r.weight + '%)'; }).join('、') + '、' + S.emp + '(0%)', 'ptz-step');
      S.phase = 'DELETE'; saveS(S);
      setTimeout(tick, 200);
      return;
    }

    if (S.phase === 'DELETE') {
      const dels = rDeleteLinks();
      if (dels.length === 0) { S.phase = 'INSERT'; resetWait(S); log(S, '⑤ 原有 R 已全部刪除', 'ptz-step'); saveS(S); setTimeout(tick, 200); return; }
      resetWait(S);
      log(S, '⑤ 刪除原有 R(剩 ' + dels.length + ' 筆)…', 'ptz-step');
      S.phase = 'WAIT_DELETE'; saveS(S);
      dels[0].click();
      return;
    }
    if (S.phase === 'WAIT_DELETE') {
      const dels = rDeleteLinks();
      if (dels.length > 0) { S.phase = 'DELETE'; resetWait(S); tick(); return; }
      S.phase = 'INSERT'; resetWait(S); log(S, '⑤ 原有 R 已全部刪除', 'ptz-step'); saveS(S); tick(); return;
    }

    if (S.phase === 'INSERT') {
      const rows = roleEmpRows(ROLE_R);
      const filledCount = rows.filter(function (r) { return (r.emp.value || '').trim(); }).length;
      if (filledCount < S.targetRcount) { waitRetry(S, '新增前輸入格遺失(' + filledCount + '/' + S.targetRcount + ')'); return; }
      resetWait(S);
      log(S, '⑥ 按新增…', 'ptz-step');
      S.phase = 'AFTER_INSERT'; saveS(S);
      clickInsert();
      return;
    }
    if (S.phase === 'AFTER_INSERT') {
      if (errMsg && isFatalNotice(errMsg)) { halt(S, '✗ 新增後錯誤:' + errMsg); return; }
      const nowRs = existingRs();
      const ok = nowRs.some(function (r) { return r.emp === S.emp; });
      if (!ok) { waitRetry(S, '新增後未見 ' + S.emp + ' 於R名單'); return; }
      done(S, '✓ 完成:已掛 ' + S.emp + ' 為 0%(R名單現 ' + nowRs.length + ' 位)' + (errMsg ? '；系統訊息:' + errMsg : ''));
      return;
    }
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      const S = loadS();
      if (!S) return;
      if (!S.running) { clearS(); return; }
      if (!S._ts || (Date.now() - S._ts > 30 * 1000)) { clearS(); renderLog({ patient: S.patient, log: (S.log || []).concat([{ text: '（偵測到中斷的舊任務,已清除,未繼續執行）', cls: 'ptz-warn' }]) }); return; }
      tick();
    }, 250);
  });

  $('#ptz-emp').value = getSelfEmp();

})();
