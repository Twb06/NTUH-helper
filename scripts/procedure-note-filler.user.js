// ==UserScript==
// @name         Procedure Note 自動填寫
// @namespace    http://tampermonkey.net/
// @version      0.1.0
// @description  在 Procedure Note 頁面自動填寫處置前評估、Time-out、處置過程紀錄與處置後評估，支援主治醫師記憶、深色懸浮模板管理（含局部麻醉、途徑、處置部位、植入物、抗生素預設）與雲端同步。
// @author       Twb06
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/procedure-note-filler.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/procedure-note-filler.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// ==/UserScript==

/* global GM_getValue, GM_setValue */

(function () {
    'use strict';

    const PAGE_MATCH = 'InsertProgressNoteContent.aspx';
    const TPL_STORAGE_KEY = 'ntuh_procedure_note_templates';
    const LAST_ANESTHESIA_KEY = 'ntuh_procedure_note_last_anesthesia';
    const ATTENDING_STORAGE_KEY = 'ntuh_procedure_note_attending_doctors';
    const DEFAULT_ANESTHETIC = 'Xylocaine 1%';
    const DEFAULT_ROUTE = 'Local infiltration/Intralesion injection';

    const ANESTHETIC_OPTIONS = [
        'Xylocaine 1%',
        'Xylocaine 2%',
        'Xylestersin-A',
        'Articaine 4%',
        '其他'
    ];

    const ROUTE_OPTIONS = [
        'Subcutaneous',
        'Local infiltration/Intralesion injection',
        'Block anesthesia',
        '其他'
    ];

    const SIDE_OPTIONS = [
        { value: 'na', label: '不分側' },
        { value: 'left', label: '左' },
        { value: 'right', label: '右' },
        { value: 'both', label: '雙側' }
    ];

    // Procedure Note 的主治欄位（與覆核者 ucDoctorInfo_vsid 不同）
    const ATTENDING_FIELD_ID = 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler_tbxVSId';

    let currentOperationId = null;
    let isExecuting = false;

    // ─────────────────────────────────────────────
    // 安全時間與字串處理輔助函式
    // ─────────────────────────────────────────────

    function nowMs() {
        return new Date().getTime();
    }

    function escapeHtml(value) {
        return String(value || '').replace(/[&<>"']/g, function (ch) {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
            return map[ch] || ch;
        });
    }

    function normalizeText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function formatDateTime(dt) {
        const y = dt.getFullYear();
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const d = String(dt.getDate()).padStart(2, '0');
        const hh = String(dt.getHours()).padStart(2, '0');
        const mm = String(dt.getMinutes()).padStart(2, '0');
        return `${y}/${m}/${d} ${hh}:${mm}`;
    }

    // ─────────────────────────────────────────────
    // 儲存層：優先使用 Tampermonkey GM API（支援雲端同步），Fallback 到 localStorage
    // ─────────────────────────────────────────────

    function getStoredValue(key, fallback) {
        if (typeof GM_getValue === 'function') {
            try {
                const val = GM_getValue(key, undefined);
                if (val !== undefined && val !== null) {
                    return val;
                }
            } catch (e) {
                // fallback to localStorage
            }
        }
        try {
            const localVal = window.localStorage.getItem(key);
            return localVal === null ? fallback : localVal;
        } catch (e) {
            return fallback;
        }
    }

    function setStoredValue(key, value) {
        let saved = false;
        if (typeof GM_setValue === 'function') {
            try {
                GM_setValue(key, value);
                saved = true;
            } catch (e) {
                // continue to fallback
            }
        }
        try {
            const valToStore = typeof value === 'string' ? value : JSON.stringify(value);
            window.localStorage.setItem(key, valToStore);
            saved = true;
        } catch (e) {
            // ignore
        }
        return saved;
    }

    function readJsonStorage(key, fallback) {
        try {
            const raw = getStoredValue(key, null);
            if (raw === null || raw === undefined) return fallback;
            if (typeof raw === 'object') return raw;
            return JSON.parse(raw);
        } catch (e) {
            return fallback;
        }
    }

    function writeJsonStorage(key, value) {
        try {
            const rawStr = JSON.stringify(value);
            return setStoredValue(key, rawStr);
        } catch (e) {
            return false;
        }
    }

    // ─────────────────────────────────────────────
    // 模板與局部麻醉偏好管理
    // ─────────────────────────────────────────────

    function loadTemplates() {
        const parsed = readJsonStorage(TPL_STORAGE_KEY, []);
        return Array.isArray(parsed) ? parsed : [];
    }

    function saveTemplates(list) {
        try {
            const ok = writeJsonStorage(TPL_STORAGE_KEY, list);
            if (!ok) return '儲存資料失敗（無法寫入儲存空間）';
            return null;
        } catch (e) {
            return e && e.message ? e.message : '儲存模板發生錯誤';
        }
    }

    function ensureTemplateStorage() {
        return loadTemplates();
    }

    function loadLastAnesthesia() {
        const saved = readJsonStorage(LAST_ANESTHESIA_KEY, null);
        if (!saved || typeof saved !== 'object') {
            return {
                anestheticLabel: DEFAULT_ANESTHETIC,
                anestheticExtra: '',
                routeLabel: DEFAULT_ROUTE,
                routeExtra: ''
            };
        }
        return {
            anestheticLabel: saved.anestheticLabel || DEFAULT_ANESTHETIC,
            anestheticExtra: saved.anestheticExtra || '',
            routeLabel: saved.routeLabel || DEFAULT_ROUTE,
            routeExtra: saved.routeExtra || ''
        };
    }

    function saveLastAnesthesia(anestheticLabel, anestheticExtra, routeLabel, routeExtra) {
        writeJsonStorage(LAST_ANESTHESIA_KEY, {
            anestheticLabel: anestheticLabel || DEFAULT_ANESTHETIC,
            anestheticExtra: anestheticExtra || '',
            routeLabel: routeLabel || DEFAULT_ROUTE,
            routeExtra: routeExtra || ''
        });
    }

    function loadAttendingDoctors() {
        const saved = readJsonStorage(ATTENDING_STORAGE_KEY, []);
        if (!Array.isArray(saved)) return [];
        return saved.filter(function (doctor) {
            return doctor && /^\d+$/.test(String(doctor.id || ''));
        }).map(function (doctor) {
            return {
                id: String(doctor.id),
                name: normalizeText(doctor.name),
                updatedAt: doctor.updatedAt || ''
            };
        });
    }

    function saveAttendingDoctor(id, name) {
        const normalizedId = String(id || '').trim();
        const normalizedName = normalizeText(name);
        if (!/^\d+$/.test(normalizedId) || !normalizedName) return false;

        const doctors = loadAttendingDoctors();
        const existing = doctors.find(function (doctor) { return doctor.id === normalizedId; });
        if (existing) {
            existing.name = normalizedName;
            existing.updatedAt = new Date().toISOString();
        } else {
            doctors.push({ id: normalizedId, name: normalizedName, updatedAt: new Date().toISOString() });
        }
        doctors.sort(function (a, b) { return a.id.localeCompare(b.id); });
        return writeJsonStorage(ATTENDING_STORAGE_KEY, doctors);
    }

    function newTemplateId() {
        return 'tpl-' + nowMs() + '-' + String(Math.floor(Math.random() * 100000));
    }

    // ─────────────────────────────────────────────
    // 頁面偵測與 DOM 輔助函式
    // ─────────────────────────────────────────────

    function isProcedureNotePage() {
        try {
            const bodyUrl = window.location.href || '';
            if (!bodyUrl.includes(PAGE_MATCH)) return false;
            const mainTab = document.getElementById('NTUHWeb1_ProcedureNoteMainTab');
            if (mainTab) return true;
            const hidden = document.querySelector('#NTUHWeb1_ProcedureNoteMainTab_hidNoteType[value="procedure"]');
            return !!hidden;
        } catch (e) {
            return false;
        }
    }

    function waitForElement(selector, timeout, label) {
        return new Promise((resolve, reject) => {
            const start = nowMs();
            const check = function () {
                const el = document.querySelector(selector);
                if (el) {
                    cleanup();
                    resolve(el);
                    return true;
                }
                if (nowMs() - start > timeout) {
                    cleanup();
                    reject(new Error((label || '元素') + ' 等待逾時：' + selector));
                    return true;
                }
                return false;
            };

            const observer = new MutationObserver(function () {
                check();
            });
            observer.observe(document.body || document.documentElement, { childList: true, subtree: true, attributes: true });

            const timerId = setInterval(check, 200);
            function cleanup() {
                clearInterval(timerId);
                observer.disconnect();
            }

            if (check()) {
                return;
            }
        });
    }

    function waitForCondition(predicate, timeout, label) {
        return new Promise((resolve, reject) => {
            const start = nowMs();
            const check = function () {
                try {
                    if (predicate()) {
                        clearInterval(timerId);
                        resolve(true);
                        return true;
                    }
                    if (nowMs() - start > timeout) {
                        clearInterval(timerId);
                        reject(new Error((label || '條件') + ' 等待逾時'));
                        return true;
                    }
                    return false;
                } catch (e) {
                    clearInterval(timerId);
                    reject(e);
                    return true;
                }
            };

            const timerId = setInterval(check, 200);
            if (check()) {
                return;
            }
        });
    }

    function triggerAndWaitForPostback(trigger, label) {
        return new Promise((resolve, reject) => {
            const manager = window.Sys && window.Sys.WebForms && window.Sys.WebForms.PageRequestManager
                ? window.Sys.WebForms.PageRequestManager.getInstance()
                : null;
            if (!manager) {
                try {
                    trigger();
                    setTimeout(resolve, 500);
                } catch (error) {
                    reject(error);
                }
                return;
            }

            let requestStarted = false;
            let settled = false;
            let noRequestTimer = null;
            let timeoutTimer = null;

            const cleanup = function () {
                if (noRequestTimer) clearTimeout(noRequestTimer);
                if (timeoutTimer) clearTimeout(timeoutTimer);
                manager.remove_initializeRequest(onInitializeRequest);
                manager.remove_endRequest(onEndRequest);
            };
            const finish = function (error) {
                if (settled) return;
                settled = true;
                cleanup();
                if (error) reject(error);
                else resolve();
            };
            const onInitializeRequest = function () {
                requestStarted = true;
                if (noRequestTimer) clearTimeout(noRequestTimer);
            };
            const onEndRequest = function () {
                finish();
            };

            manager.add_initializeRequest(onInitializeRequest);
            manager.add_endRequest(onEndRequest);
            noRequestTimer = setTimeout(function () {
                if (!requestStarted) finish();
            }, 500);
            timeoutTimer = setTimeout(function () {
                finish(new Error((label || '頁面更新') + ' 等待逾時'));
            }, 20000);

            try {
                trigger();
            } catch (error) {
                finish(error);
            }
        });
    }

    function setFieldValue(element, value) {
        if (!element) return false;

        if (element.type === 'radio' || element.type === 'checkbox') {
            const shouldCheck = !!value;
            if (element.checked !== shouldCheck) {
                element.click();
            }
            return true;
        }

        if (element.tagName === 'SELECT') {
            const strVal = String(value);
            const option = Array.from(element.options).find(function (opt) {
                return String(opt.value) === strVal || normalizeText(opt.textContent) === normalizeText(strVal);
            });
            if (option) {
                element.value = option.value;
                element.dispatchEvent(new Event('change', { bubbles: true }));
                element.dispatchEvent(new Event('input', { bubbles: true }));
            }
            return true;
        }

        const val = String(value);
        if (element.value !== val) {
            element.value = val;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        try {
            element.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (e) {
            // noop
        }
        return true;
    }

    function chooseOptionByText(selectEl, targetText) {
        if (!selectEl) return false;
        const options = Array.from(selectEl.options || []);
        const exact = options.find(function (opt) {
            return normalizeText(opt.textContent) === normalizeText(targetText);
        });
        const partial = options.find(function (opt) {
            return normalizeText(opt.textContent).includes(normalizeText(targetText));
        });
        const target = exact || partial;
        if (!target) return false;
        if (selectEl.value !== String(target.value)) {
            selectEl.value = target.value;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            selectEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
    }

    // ─────────────────────────────────────────────
    // 面板 UI 狀態與控制
    // ─────────────────────────────────────────────

    function findTemplateSelect() {
        return document.getElementById('ntuh-procedure-template-select');
    }

    function findPageProcedureSelect() {
        return document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler_ddlProcedureName');
    }

    function getProcedureOptions() {
        const select = findPageProcedureSelect();
        const options = select ? Array.from(select.options || []).map(function (option) {
            return { value: String(option.value), label: normalizeText(option.textContent) };
        }).filter(function (option) { return option.value !== '' && option.label; }) : [];
        return options.length ? options : [{ value: '0', label: 'B-Table' }];
    }

    function getDefaultProcedureOption() {
        const options = getProcedureOptions();
        return options.find(function (option) { return /\bb\s*[-–—]?\s*table\b|btable/i.test(option.label); }) || options[0];
    }

    function resolveTemplateProcedure(template) {
        const options = getProcedureOptions();
        const savedValue = template && template.procedureTypeValue !== null && template.procedureTypeValue !== undefined
            ? String(template.procedureTypeValue) : '';
        const byValue = savedValue ? options.find(function (option) { return option.value === savedValue; }) : null;
        const savedLabel = normalizeText(template && (template.procedureTypeLabel || template.procedureName));
        const byLabel = savedLabel ? options.find(function (option) {
            return option.label.toLocaleLowerCase() === savedLabel.toLocaleLowerCase();
        }) : null;
        return byValue || byLabel || getDefaultProcedureOption();
    }

    function isBTableProcedure(label) {
        return /\bb\s*[-–—]?\s*table\b|btable/i.test(normalizeText(label));
    }

    function updateCustomProcedureNameVisibility(prefix = 'template') {
        const select = document.getElementById(`ntuh-procedure-${prefix}-procedure-type`);
        const nameField = document.getElementById(`ntuh-procedure-${prefix}-custom-name`);
        const nameLabel = document.getElementById(`ntuh-procedure-${prefix}-custom-name-wrap`);
        if (!select || !nameLabel) return;
        const selected = Array.from(select.options || []).find(function (option) { return option.value === select.value; });
        const showName = !!selected && isBTableProcedure(selected.textContent);
        nameLabel.style.display = showName ? 'flex' : 'none';
        if (nameField) nameField.required = showName;
    }

    function renderProcedureOptions() {
        return getProcedureOptions().map(function (option) {
            return '<option value="' + escapeHtml(option.value) + '">' + escapeHtml(option.label) + '</option>';
        }).join('');
    }

    function setPanelStatus(type, message) {
        const status = document.getElementById('ntuh-procedure-status');
        if (!status) return;
        status.textContent = message;
        status.className = type === 'ok' ? 'diag-ok' : type === 'err' ? 'diag-err' : type === 'warn' ? 'diag-warn' : '';
    }

    function updateProgress(stepText) {
        const line = document.getElementById('ntuh-procedure-progress');
        if (line) {
            line.textContent = stepText;
        }
    }

    function isUsableField(el) {
        return !!(el && !el.disabled && !el.readOnly);
    }

    function findAttendingDoctorField() {
        // 1. 院方固定 ID
        const direct = document.getElementById(ATTENDING_FIELD_ID);
        if (isUsableField(direct)) return direct;

        // 2. 任何 ucDoctorInfo_vsid（優先 Procedure 分頁、可見者）
        const candidates = Array.from(document.querySelectorAll('input[id$="ucProcedureHandler_tbxVSId"], input[id$="ucDoctorInfo_vsid"]')).filter(isUsableField);
        const procedureOne = candidates.find(function (el) { return /ucProcedureHandler_tbxVSId$/i.test(el.id); })
            || candidates.find(function (el) { return /ProcedureNote/i.test(el.id); });
        if (procedureOne) return procedureOne;
        const visibleOne = candidates.find(function (el) { return !!el.offsetParent; });
        if (visibleOne) return visibleOne;

        // 3. 後備：以文字啟發式搜尋
        return findAttendingDoctorFieldHeuristic();
    }

    function getDoctorInfoPrefix(field) {
        const id = field && field.id ? field.id : '';
        if (/_vsid$/i.test(id)) return id.replace(/_vsid$/i, '');
        if (/_tbxVSId$/i.test(id)) return id.replace(/_tbxVSId$/i, '');
        return '';
    }

    function readDoctorInfoName(field) {
        const prefix = getDoctorInfoPrefix(field);
        if (!prefix) return '';
        const sources = [prefix + '_lblVSName', prefix + '_lblEmpName', prefix + '_lblMessage'];
        for (const sid of sources) {
            const el = document.getElementById(sid);
            const text = normalizeText(el ? el.textContent : '');
            if (!text) continue;
            const matched = text.match(/[一-鿿]{2,6}/);
            if (matched && !/(錯誤|查無|不存在|請輸入|失敗)/.test(text)) return matched[0];
        }
        return '';
    }

    function findAttendingDoctorFieldHeuristic() {
        const root = document.getElementById('NTUHWeb1_ProcedureNoteMainTab') || document.body;
        if (!root) return null;
        const fields = Array.from(root.querySelectorAll('input[type="text"], input:not([type])'));
        let best = null;
        let bestScore = 0;

        fields.forEach(function (field) {
            if (field.closest('#ntuh-procedure-panel')) return;
            const attributes = [field.id, field.name, field.className, field.placeholder, field.title, field.getAttribute('aria-label')]
                .map(function (value) { return String(value || ''); })
                .join(' ');
            const row = field.closest('tr, .row, .fieldRow');
            const nearbyText = normalizeText((row ? row.textContent : field.parentElement?.textContent) || '');
            let score = 0;
            if (/主治醫師/.test(nearbyText)) score += 100;
            if (/attending/i.test(attributes)) score += 80;
            if (/doctor|physician/i.test(attributes)) score += 50;
            if (/emp(no|id)|員工.*(?:號|碼)|醫師.*(?:號|碼)/i.test(attributes + ' ' + nearbyText)) score += 20;
            if (field.disabled || field.readOnly) score -= 100;
            if (score > bestScore) {
                best = field;
                bestScore = score;
            }
        });
        return bestScore > 0 ? best : null;
    }

    function getAttendingDoctorName(id, field) {
        const fromLabel = readDoctorInfoName(field);
        if (fromLabel) return fromLabel;
        const escapedId = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const containers = [
            field && field.closest('tr, .row, .fieldRow, td'),
            field && field.parentElement,
            document.getElementById('NTUHWeb1_ProcedureNoteMainTab')
        ].filter(Boolean);

        for (const container of containers) {
            const fieldValues = Array.from(container.querySelectorAll('input, textarea, select')).map(function (element) {
                return element.value || '';
            });
            const text = normalizeText([container.textContent || ''].concat(fieldValues).join(' '));
            const matched = text.match(new RegExp(escapedId + '\\s*(?:[-:：]\\s*)?([一-鿿]{2,6})'));
            if (matched && !/^(主治醫師|醫師代碼|員工編號)$/.test(matched[1])) {
                return matched[1];
            }
        }
        const saved = loadAttendingDoctors().find(function (doctor) { return doctor.id === String(id); });
        return saved ? saved.name : '';
    }

    function setAttendingHint(message, type) {
        const hint = document.getElementById('ntuh-procedure-attending-hint');
        if (!hint) return;
        hint.textContent = message;
        hint.className = type === 'err' ? 'diag-err' : type === 'ok' ? 'diag-ok' : '';
    }

    function renderAttendingSuggestions() {
        const input = document.getElementById('ntuh-procedure-attending-id');
        const list = document.getElementById('ntuh-procedure-attending-suggestions');
        if (!input || !list) return;
        const term = input.value.trim();
        const matches = term ? loadAttendingDoctors().filter(function (doctor) {
            return doctor.id.startsWith(term);
        }).slice(0, 8) : [];
        list.innerHTML = matches.map(function (doctor) {
            return '<button type="button" class="ntuh-procedure-attending-option" data-id="' + escapeHtml(doctor.id) + '">' +
                '<strong>' + escapeHtml(doctor.id) + '</strong><span>' + escapeHtml(doctor.name) + '</span></button>';
        }).join('');
        list.style.display = matches.length ? 'flex' : 'none';
        list.querySelectorAll('.ntuh-procedure-attending-option').forEach(function (button) {
            button.onclick = async function () {
                input.value = button.getAttribute('data-id') || '';
                renderAttendingSuggestions();
                try {
                    await fillAttendingDoctor(input.value);
                } catch (error) {
                    setAttendingHint(error.message || '主治醫師 ID 套用失敗', 'err');
                }
            };
        });
    }

    async function fillAttendingDoctor(id) {
        const normalizedId = String(id || '').trim();
        if (!normalizedId) return;
        if (!/^\d+$/.test(normalizedId)) {
            throw new Error('主治醫師 ID 僅可包含數字。');
        }
        const field = findAttendingDoctorField();
        if (!field) {
            throw new Error('找不到網頁中的主治醫師 ID 欄位。');
        }

        await triggerAndWaitForPostback(function () {
            setFieldValue(field, normalizedId);
        }, '主治醫師資料查詢');

        let refreshedField = findAttendingDoctorField() || field;
        if (String(refreshedField.value || '').trim() !== normalizedId) {
            await triggerAndWaitForPostback(function () {
                refreshedField = findAttendingDoctorField() || refreshedField;
                setFieldValue(refreshedField, normalizedId);
            }, '主治醫師員編重填');
            refreshedField = findAttendingDoctorField() || refreshedField;
            if (String(refreshedField.value || '').trim() !== normalizedId) {
                throw new Error('主治醫師員編未保留在欄位中，請確認欄位與員編。');
            }
        }
        // lblEmpName 可能在 postback 結束後才由前端 JS 填入，稍候最多 3 秒
        if (getDoctorInfoPrefix(refreshedField)) {
            try {
                await waitForCondition(function () {
                    return !!readDoctorInfoName(findAttendingDoctorField() || refreshedField);
                }, 3000, '主治醫師姓名');
            } catch (e) {
                // 姓名未出現時改用其他來源
            }
        }
        const name = getAttendingDoctorName(normalizedId, findAttendingDoctorField() || refreshedField);
        if (name) {
            saveAttendingDoctor(normalizedId, name);
            setAttendingHint('已套用：' + normalizedId + ' ' + name, 'ok');
        } else {
            setAttendingHint('已套用 ID ' + normalizedId + '；請確認網頁顯示的姓名。');
        }
        renderAttendingSuggestions();
    }

    function setFormInteractive(enabled) {
        const panel = document.getElementById('ntuh-procedure-panel');
        if (!panel) return;
        const controls = panel.querySelectorAll('button, input, select, textarea');
        controls.forEach(function (ctrl) {
            if (ctrl.id === 'ntuh-procedure-close') return;
            ctrl.disabled = !enabled;
        });
    }

    function getSelectedTemplate() {
        const select = findTemplateSelect();
        if (!select) return null;
        const id = select.value;
        const list = loadTemplates();
        return list.find(function (item) { return item.id === id; }) || null;
    }

    function findTemplateWithName(list, name, excludingId) {
        const normalizedName = normalizeText(name).toLocaleLowerCase();
        if (!normalizedName) return null;
        return list.find(function (template) {
            const existingName = template.name || template.procedureName || '未命名模板';
            return template.id !== excludingId && normalizeText(existingName).toLocaleLowerCase() === normalizedName;
        }) || null;
    }

    function updateTemplateActionButtons() {
        const selected = getSelectedTemplate();
        const setDisabled = function (id, disabled) {
            const button = document.getElementById(id);
            if (button) button.disabled = disabled;
        };
        setDisabled('ntuh-procedure-template-copy', !selected);
        setDisabled('ntuh-procedure-template-edit', !selected);
        setDisabled('ntuh-procedure-template-delete', !selected);
    }

    function reorderTemplate(sourceId, targetId, insertAfter) {
        if (!sourceId || !targetId || sourceId === targetId) return;
        const list = ensureTemplateStorage();
        const sourceIndex = list.findIndex(function (template) { return template.id === sourceId; });
        const targetIndex = list.findIndex(function (template) { return template.id === targetId; });
        if (sourceIndex < 0 || targetIndex < 0) return;

        const moved = list.splice(sourceIndex, 1)[0];
        const adjustedTargetIndex = list.findIndex(function (template) { return template.id === targetId; });
        list.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, moved);
        const error = saveTemplates(list);
        if (error) {
            setPanelStatus('err', '儲存模板順序失敗：' + error);
            return;
        }
        renderTemplateOptions();
        setPanelStatus('ok', '已更新模板順序。');
    }

    function renderTemplateOptions() {
        const select = findTemplateSelect();
        if (!select) return;
        const list = ensureTemplateStorage();
        const prevSelected = select.value || '';
        select.innerHTML = '<option value="">-- 請選擇模板 --</option>' + list.map(function (tpl) {
            const safeName = escapeHtml(tpl.name || tpl.procedureName || '未命名模板');
            return '<option value="' + escapeHtml(tpl.id || '') + '">' + safeName + '</option>';
        }).join('');

        if (prevSelected && list.some(function (tpl) { return tpl.id === prevSelected; })) {
            select.value = prevSelected;
        }

        const templateList = document.getElementById('ntuh-procedure-template-list');
        if (templateList) {
            templateList.innerHTML = list.length ? list.map(function (tpl) {
                const id = escapeHtml(tpl.id || '');
                const name = escapeHtml(tpl.name || tpl.procedureName || '未命名模板');
                const selected = tpl.id === select.value;
                return '<div class="ntuh-procedure-template-item' + (selected ? ' is-selected' : '') + '" role="option" tabindex="0" aria-selected="' + selected + '" data-template-id="' + id + '">' +
                    '<span class="ntuh-procedure-template-drag-handle" draggable="true" tabindex="0" role="button" aria-label="拖曳以調整 ' + name + ' 的順序" title="拖曳調整順序">⠿</span>' +
                    '<span class="ntuh-procedure-template-item-name">' + name + '</span></div>';
            }).join('') : '<div class="ntuh-procedure-template-empty">尚無模板，請點擊「➕ 新增」</div>';

            templateList.querySelectorAll('.ntuh-procedure-template-item').forEach(function (item) {
                const id = item.getAttribute('data-template-id');
                const handle = item.querySelector('.ntuh-procedure-template-drag-handle');
                item.onclick = function (event) {
                    if (event.target.closest('.ntuh-procedure-template-drag-handle')) return;
                    select.value = id;
                    handleTemplateSelectChange();
                    updateTemplateActionButtons();
                    renderTemplateOptions();
                };
                item.onkeydown = function (event) {
                    if (event.target !== item || (event.key !== 'Enter' && event.key !== ' ')) return;
                    event.preventDefault();
                    select.value = id;
                    handleTemplateSelectChange();
                    updateTemplateActionButtons();
                    renderTemplateOptions();
                };
                item.ondragover = function (event) {
                    if (!draggedTemplateId || draggedTemplateId === id) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    templateList.querySelectorAll('.ntuh-procedure-template-item').forEach(function (row) {
                        row.classList.remove('drop-before', 'drop-after');
                    });
                    const rect = item.getBoundingClientRect();
                    const after = event.clientY > rect.top + rect.height / 2;
                    item.classList.add(after ? 'drop-after' : 'drop-before');
                };
                item.ondragleave = function (event) {
                    if (!item.contains(event.relatedTarget)) item.classList.remove('drop-before', 'drop-after');
                };
                item.ondrop = function (event) {
                    event.preventDefault();
                    if (!draggedTemplateId || draggedTemplateId === id) return;
                    const after = item.classList.contains('drop-after');
                    const sourceId = draggedTemplateId;
                    draggedTemplateId = '';
                    item.classList.remove('drop-before', 'drop-after');
                    reorderTemplate(sourceId, id, after);
                };
                handle.ondragstart = function (event) {
                    draggedTemplateId = id;
                    item.classList.add('is-dragging');
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', id);
                    }
                };
                handle.ondragend = function () {
                    draggedTemplateId = '';
                    templateList.querySelectorAll('.ntuh-procedure-template-item').forEach(function (row) {
                        row.classList.remove('is-dragging', 'drop-before', 'drop-after');
                    });
                };
                handle.onkeydown = function (event) {
                    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                    event.preventDefault();
                    const current = ensureTemplateStorage();
                    const from = current.findIndex(function (tpl) { return tpl.id === id; });
                    const to = from + (event.key === 'ArrowUp' ? -1 : 1);
                    if (to < 0 || to >= current.length) return;
                    const neighborId = current[to].id;
                    reorderTemplate(id, neighborId, event.key === 'ArrowDown');
                    const refreshedHandle = templateList.querySelector('[data-template-id="' + CSS.escape(id) + '"] .ntuh-procedure-template-drag-handle');
                    if (refreshedHandle) refreshedHandle.focus();
                };
            });
        }

        const startBtn = document.getElementById('ntuh-procedure-start-btn');
        if (startBtn && !isExecuting) {
            const disabled = list.length === 0 && !select.value;
            startBtn.disabled = disabled;
        }

        const templateEditor = document.getElementById('ntuh-procedure-template-editor');
        if (templateEditor) {
            templateEditor.style.display = 'none';
        }
        updateTemplateActionButtons();
    }

    let draggedTemplateId = '';

    function updateAnestheticExtraVisibility(prefix = '') {
        const select = document.getElementById(prefix ? `ntuh-procedure-${prefix}-anesthetic` : 'ntuh-procedure-anesthetic');
        const extra = document.getElementById(prefix ? `ntuh-procedure-${prefix}-anesthetic-extra` : 'ntuh-procedure-anesthetic-extra');
        if (!select || !extra) return;

        const val = select.value;
        if (val === 'Xylestersin-A') {
            extra.style.display = 'block';
            extra.placeholder = 'ml 數 (如 1.8)';
        } else if (val === '其他') {
            extra.style.display = 'block';
            extra.placeholder = '自訂藥品/ml 數';
        } else {
            extra.style.display = 'none';
        }
    }

    function updateRouteExtraVisibility(prefix = '') {
        const select = document.getElementById(prefix ? `ntuh-procedure-${prefix}-route` : 'ntuh-procedure-route');
        const extra = document.getElementById(prefix ? `ntuh-procedure-${prefix}-route-extra` : 'ntuh-procedure-route-extra');
        if (!select || !extra) return;

        if (select.value === '其他') {
            extra.style.display = 'block';
            extra.placeholder = '自訂途徑名稱';
        } else {
            extra.style.display = 'none';
        }
    }

    function handleTemplateSelectChange() {
        const template = getSelectedTemplate();
        const procedureNameField = document.getElementById('ntuh-procedure-procedure-name');
        const procedureNameWrap = document.getElementById('ntuh-procedure-procedure-name-wrap');
        const contentField = document.getElementById('ntuh-procedure-template-content-display');
        const anestheticSelect = document.getElementById('ntuh-procedure-anesthetic');
        const anestheticExtra = document.getElementById('ntuh-procedure-anesthetic-extra');
        const routeSelect = document.getElementById('ntuh-procedure-route');
        const routeExtra = document.getElementById('ntuh-procedure-route-extra');

        if (template) {
            const procedure = resolveTemplateProcedure(template);
            const needsCustomName = isBTableProcedure(procedure.label);
            if (procedureNameField) {
                procedureNameField.value = template.customProcedureName || (needsCustomName ? template.procedureName || '' : '');
                procedureNameField.placeholder = needsCustomName ? '必填：輸入 B-Table 自訂處置名稱' : '依所選處置自動套用';
                procedureNameField.required = needsCustomName;
            }
            if (procedureNameWrap) procedureNameWrap.style.display = needsCustomName ? 'flex' : 'none';
            if (procedureNameField) {
                procedureNameField.dataset.procedureTypeValue = procedure.value;
                procedureNameField.dataset.procedureTypeLabel = procedure.label;
            }
            if (contentField) contentField.value = template.content || '';
            if (template.anesthetic && anestheticSelect) {
                chooseOptionByText(anestheticSelect, template.anesthetic);
            }
            if (anestheticExtra) {
                anestheticExtra.value = template.anestheticExtra || '';
            }
            if (template.route && routeSelect) {
                chooseOptionByText(routeSelect, template.route);
            }
            if (routeExtra) {
                routeExtra.value = template.routeExtra || '';
            }
            applyTimeoutDefaults(template);
            updateAnestheticExtraVisibility();
            updateRouteExtraVisibility();
            setPanelStatus('ok', '已載入模板：' + (template.name || template.procedureName || '未命名模板'));
        } else {
            const defaultProcedure = getDefaultProcedureOption();
            const needsCustomName = isBTableProcedure(defaultProcedure.label);
            if (procedureNameField) {
                procedureNameField.value = '';
                procedureNameField.placeholder = needsCustomName ? '必填：輸入 B-Table 自訂處置名稱' : '依所選處置自動套用';
                procedureNameField.required = needsCustomName;
                procedureNameField.dataset.procedureTypeValue = defaultProcedure.value;
                procedureNameField.dataset.procedureTypeLabel = defaultProcedure.label;
            }
            if (procedureNameWrap) procedureNameWrap.style.display = needsCustomName ? 'flex' : 'none';
            if (contentField) contentField.value = '';
            updateAnestheticExtraVisibility();
            updateRouteExtraVisibility();
            setPanelStatus('', '請選擇模板或點擊「➕ 新增模板」');
        }
    }

    function getPanelTimeoutValues() {
        const checkedSide = document.querySelector('input[name="ntuh-procedure-side"]:checked');
        const implantEl = document.getElementById('ntuh-procedure-implant');
        const antibioticEl = document.getElementById('ntuh-procedure-antibiotic');
        return {
            side: checkedSide ? checkedSide.value : 'na',
            implant: !!(implantEl && implantEl.checked),
            antibiotic: !!(antibioticEl && antibioticEl.checked)
        };
    }

    function applyTimeoutDefaults(template) {
        const side = template && template.side ? template.side : 'na';
        const sideRadio = document.querySelector('input[name="ntuh-procedure-side"][value="' + side + '"]')
            || document.querySelector('input[name="ntuh-procedure-side"][value="na"]');
        if (sideRadio) sideRadio.checked = true;
        const implantEl = document.getElementById('ntuh-procedure-implant');
        if (implantEl) implantEl.checked = !!(template && template.implant);
        const antibioticEl = document.getElementById('ntuh-procedure-antibiotic');
        if (antibioticEl) antibioticEl.checked = !!(template && template.antibiotic);
    }

    function initializeProcedureSettings() {
        const memory = loadLastAnesthesia();
        const anestheticSelect = document.getElementById('ntuh-procedure-anesthetic');
        const anestheticExtra = document.getElementById('ntuh-procedure-anesthetic-extra');
        const routeSelect = document.getElementById('ntuh-procedure-route');
        const routeExtra = document.getElementById('ntuh-procedure-route-extra');

        if (anestheticSelect && !anestheticSelect.value) {
            const ok = chooseOptionByText(anestheticSelect, memory.anestheticLabel);
            if (!ok) {
                chooseOptionByText(anestheticSelect, DEFAULT_ANESTHETIC);
            }
        }
        if (anestheticExtra && !anestheticExtra.value) {
            anestheticExtra.value = memory.anestheticExtra || '';
        }
        if (routeSelect && !routeSelect.value) {
            const ok = chooseOptionByText(routeSelect, memory.routeLabel);
            if (!ok) {
                chooseOptionByText(routeSelect, DEFAULT_ROUTE);
            }
        }
        if (routeExtra && !routeExtra.value) {
            routeExtra.value = memory.routeExtra || '';
        }

        updateAnestheticExtraVisibility();
        updateRouteExtraVisibility();
    }

    function openTemplateEditor(templateToEdit = null, copyAsNew = false) {
        let block = document.getElementById('ntuh-procedure-template-editor');
        if (!block) {
            block = document.createElement('div');
            block.id = 'ntuh-procedure-template-editor';
            block.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid #9db98a; border-radius:8px; background:#f4f7f2; margin-top:4px;';
            block.innerHTML = [
                '<div id="ntuh-procedure-editor-title" style="font-weight:700; color:#2c5f54; font-size:12px;">➕ 新增 / 編輯模板</div>',
                '<label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">模板顯示名稱<input id="ntuh-procedure-template-name" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;" placeholder="如：CVC 置入術" /></label>',
                '<label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">處置類型（同步網頁選單）<select id="ntuh-procedure-template-procedure-type" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;">' + renderProcedureOptions() + '</select></label>',
                '<label id="ntuh-procedure-template-custom-name-wrap" style="display:none; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">B-Table 自訂處置名稱<input id="ntuh-procedure-template-custom-name" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;" placeholder="如：CVC 置入術" /></label>',
                '<div style="display:flex; gap:6px;">',
                '  <label style="flex:1; display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">局部麻醉',
                '    <select id="ntuh-procedure-template-anesthetic" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;">',
                ANESTHETIC_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join(''),
                '    </select>',
                '    <input id="ntuh-procedure-template-anesthetic-extra" style="display:none; margin-top:2px; background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;" placeholder="ml 數" />',
                '  </label>',
                '  <label style="flex:1; display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">麻醉途徑',
                '    <select id="ntuh-procedure-template-route" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;">',
                ROUTE_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join(''),
                '    </select>',
                '    <input id="ntuh-procedure-template-route-extra" style="display:none; margin-top:2px; background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;" placeholder="自訂途徑" />',
                '  </label>',
                '</div>',
                '<div style="display:flex; gap:6px; align-items:flex-end;">',
                '  <label style="flex:1; display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">處置部位',
                '    <select id="ntuh-procedure-template-side" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px;">',
                SIDE_OPTIONS.map(opt => `<option value="${escapeHtml(opt.value)}">${escapeHtml(opt.label)}</option>`).join(''),
                '    </select>',
                '  </label>',
                '  <label style="display:flex; flex-direction:row; align-items:center; gap:4px; font-size:11px; color:#2b3a2b; cursor:pointer; padding-bottom:4px;"><input id="ntuh-procedure-template-implant" type="checkbox" /> 植入物</label>',
                '  <label style="display:flex; flex-direction:row; align-items:center; gap:4px; font-size:11px; color:#2b3a2b; cursor:pointer; padding-bottom:4px;"><input id="ntuh-procedure-template-antibiotic" type="checkbox" /> 抗生素</label>',
                '</div>',
                '<label style="display:flex; flex-direction:column; gap:2px; font-size:11px; color:#4a5a72;">Procedure 模板內容<textarea id="ntuh-procedure-template-content" rows="4" style="background:#ffffff; border:1px solid #9db98a; border-radius:6px; color:#2b3a2b; padding:4px 6px; font-size:11px; resize:vertical; width:100%; box-sizing:border-box;" placeholder="處置過程紀錄內容..."></textarea></label>',
                '<div style="display:flex; gap:6px; margin-top:4px;">',
                '  <button id="ntuh-procedure-template-save" type="button" style="flex:1; padding:6px; border:none; border-radius:6px; background:#4caf7d; color:#fff; cursor:pointer; font-size:11px; font-weight:600;">儲存模板</button>',
                '  <button id="ntuh-procedure-template-cancel" type="button" style="flex:1; padding:6px; border:1px solid #9db98a; border-radius:6px; background:transparent; color:#5f6f57; cursor:pointer; font-size:11px;">取消</button>',
                '</div>'
            ].join('');

            const slot = document.getElementById('ntuh-procedure-editor-slot');
            if (slot) slot.appendChild(block);

            const procedureType = document.getElementById('ntuh-procedure-template-procedure-type');
            procedureType.onchange = () => updateCustomProcedureNameVisibility('template');
            document.getElementById('ntuh-procedure-template-anesthetic').onchange = () => updateAnestheticExtraVisibility('template');
            document.getElementById('ntuh-procedure-template-route').onchange = () => updateRouteExtraVisibility('template');

            document.getElementById('ntuh-procedure-template-save').onclick = function () {
                const enteredName = normalizeText(document.getElementById('ntuh-procedure-template-name').value);
                const procedureTypeValue = procedureType.value;
                const procedureTypeOption = Array.from(procedureType.options).find(function (option) { return option.value === procedureTypeValue; });
                const procedureTypeLabel = normalizeText(procedureTypeOption ? procedureTypeOption.textContent : '');
                const customProcedureName = normalizeText(document.getElementById('ntuh-procedure-template-custom-name').value);
                const needsCustomName = isBTableProcedure(procedureTypeLabel);
                const content = normalizeText(document.getElementById('ntuh-procedure-template-content').value);
                const anesthetic = document.getElementById('ntuh-procedure-template-anesthetic').value;
                const anestheticExtra = document.getElementById('ntuh-procedure-template-anesthetic-extra').value.trim();
                const route = document.getElementById('ntuh-procedure-template-route').value;
                const routeExtra = document.getElementById('ntuh-procedure-template-route-extra').value.trim();
                const side = document.getElementById('ntuh-procedure-template-side').value || 'na';
                const implant = !!document.getElementById('ntuh-procedure-template-implant').checked;
                const antibiotic = !!document.getElementById('ntuh-procedure-template-antibiotic').checked;

                if (!procedureTypeValue || (needsCustomName && !customProcedureName) || !content) {
                    setPanelStatus('err', needsCustomName ? '請選擇處置類型、填寫 B-Table 自訂名稱與模板內容。' : '請選擇處置類型並填寫模板內容。');
                    return;
                }

                const list = ensureTemplateStorage();
                const editingId = block.getAttribute('data-edit-id');
                const targetId = editingId || newTemplateId();
                const name = enteredName || customProcedureName || procedureTypeLabel;
                const duplicate = findTemplateWithName(list, name, editingId);
                if (duplicate) {
                    setPanelStatus('err', '模板名稱「' + name + '」已存在，請更換名稱後再儲存。');
                    return;
                }

                const item = {
                    id: targetId,
                    name: name,
                    procedureName: customProcedureName || procedureTypeLabel,
                    procedureTypeValue: procedureTypeValue,
                    procedureTypeLabel: procedureTypeLabel,
                    customProcedureName: customProcedureName,
                    anesthetic: anesthetic || DEFAULT_ANESTHETIC,
                    anestheticExtra: anestheticExtra || '',
                    route: route || DEFAULT_ROUTE,
                    routeExtra: routeExtra || '',
                    side: side,
                    implant: implant,
                    antibiotic: antibiotic,
                    content: document.getElementById('ntuh-procedure-template-content').value,
                    createdAt: (list.find(function (tpl) { return tpl.id === targetId; }) || {}).createdAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                const index = list.findIndex(function (tpl) { return tpl.id === targetId; });
                if (index >= 0) {
                    list[index] = item;
                } else {
                    list.push(item);
                }

                const err = saveTemplates(list);
                if (err) {
                    setPanelStatus('err', '儲存模板失敗：' + err);
                    return;
                }

                renderTemplateOptions();
                const select = findTemplateSelect();
                if (select) {
                    select.value = targetId;
                    handleTemplateSelectChange();
                    updateTemplateActionButtons();
                }
                block.style.display = 'none';
                block.removeAttribute('data-edit-id');
                setPanelStatus('ok', '✓ 模板「' + item.name + '」已儲存');
            };

            document.getElementById('ntuh-procedure-template-cancel').onclick = function () {
                block.style.display = 'none';
                block.removeAttribute('data-edit-id');
            };
        }

        const titleEl = document.getElementById('ntuh-procedure-editor-title');
        const inputName = document.getElementById('ntuh-procedure-template-name');
        const selectProcedureType = document.getElementById('ntuh-procedure-template-procedure-type');
        const inputCustomProcedureName = document.getElementById('ntuh-procedure-template-custom-name');
        const selectAnesthetic = document.getElementById('ntuh-procedure-template-anesthetic');
        const inputAnestheticExtra = document.getElementById('ntuh-procedure-template-anesthetic-extra');
        const selectRoute = document.getElementById('ntuh-procedure-template-route');
        const inputRouteExtra = document.getElementById('ntuh-procedure-template-route-extra');
        const inputContent = document.getElementById('ntuh-procedure-template-content');
        const selectSide = document.getElementById('ntuh-procedure-template-side');
        const inputImplant = document.getElementById('ntuh-procedure-template-implant');
        const inputAntibiotic = document.getElementById('ntuh-procedure-template-antibiotic');

        if (selectProcedureType) selectProcedureType.innerHTML = renderProcedureOptions();

        if (templateToEdit) {
            const procedure = resolveTemplateProcedure(templateToEdit);
            if (copyAsNew) {
                block.removeAttribute('data-edit-id');
                if (titleEl) titleEl.textContent = '📄 複製模板：' + (templateToEdit.name || templateToEdit.procedureName);
                if (inputName) inputName.value = (templateToEdit.name || templateToEdit.procedureName || '未命名模板') + ' - 副本';
            } else {
                block.setAttribute('data-edit-id', templateToEdit.id);
                if (titleEl) titleEl.textContent = '✏️ 編輯模板：' + (templateToEdit.name || templateToEdit.procedureName);
                if (inputName) inputName.value = templateToEdit.name || '';
            }
            if (selectProcedureType) selectProcedureType.value = procedure.value;
            if (inputCustomProcedureName) inputCustomProcedureName.value = templateToEdit.customProcedureName || (isBTableProcedure(procedure.label) ? templateToEdit.procedureName || '' : '');
            if (selectAnesthetic) chooseOptionByText(selectAnesthetic, templateToEdit.anesthetic || DEFAULT_ANESTHETIC);
            if (inputAnestheticExtra) inputAnestheticExtra.value = templateToEdit.anestheticExtra || '';
            if (selectRoute) chooseOptionByText(selectRoute, templateToEdit.route || DEFAULT_ROUTE);
            if (inputRouteExtra) inputRouteExtra.value = templateToEdit.routeExtra || '';
            if (inputContent) inputContent.value = templateToEdit.content || '';
            if (selectSide) selectSide.value = templateToEdit.side || 'na';
            if (inputImplant) inputImplant.checked = !!templateToEdit.implant;
            if (inputAntibiotic) inputAntibiotic.checked = !!templateToEdit.antibiotic;
        } else {
            block.removeAttribute('data-edit-id');
            if (titleEl) titleEl.textContent = '➕ 新增模板';
            const procedureNameField = document.getElementById('ntuh-procedure-procedure-name');
            const curProc = isBTableProcedure(procedureNameField?.dataset.procedureTypeLabel) ? (procedureNameField?.value || '') : '';
            const curAnes = document.getElementById('ntuh-procedure-anesthetic')?.value || DEFAULT_ANESTHETIC;
            const curAnesExtra = document.getElementById('ntuh-procedure-anesthetic-extra')?.value || '';
            const curRoute = document.getElementById('ntuh-procedure-route')?.value || DEFAULT_ROUTE;
            const curRouteExtra = document.getElementById('ntuh-procedure-route-extra')?.value || '';
            const currentProcedureValue = document.getElementById('ntuh-procedure-procedure-name')?.dataset.procedureTypeValue || getDefaultProcedureOption().value;
            if (inputName) inputName.value = curProc;
            if (selectProcedureType) selectProcedureType.value = currentProcedureValue;
            if (inputCustomProcedureName) inputCustomProcedureName.value = curProc;
            if (selectAnesthetic) chooseOptionByText(selectAnesthetic, curAnes);
            if (inputAnestheticExtra) inputAnestheticExtra.value = curAnesExtra;
            if (selectRoute) chooseOptionByText(selectRoute, curRoute);
            if (inputRouteExtra) inputRouteExtra.value = curRouteExtra;
            if (inputContent) inputContent.value = '';
            const curTimeout = getPanelTimeoutValues();
            if (selectSide) selectSide.value = curTimeout.side;
            if (inputImplant) inputImplant.checked = curTimeout.implant;
            if (inputAntibiotic) inputAntibiotic.checked = curTimeout.antibiotic;
        }

        updateAnestheticExtraVisibility('template');
        updateRouteExtraVisibility('template');
        updateCustomProcedureNameVisibility('template');
        block.style.display = 'flex';
    }

    function addTemplateControls() {
        const panel = document.getElementById('ntuh-procedure-template-panel');
        if (!panel) return;

        panel.innerHTML = `
            <div style="display:flex; gap:6px; align-items:center;">
                <select id="ntuh-procedure-template-select" aria-hidden="true" tabindex="-1"></select>
            </div>
            <div id="ntuh-procedure-template-list" role="listbox" aria-label="Procedure 模板清單"></div>
            <div style="display:flex; gap:4px; align-items:center;">
                <button id="ntuh-procedure-template-new" type="button" style="padding:4px 8px; border:1px dashed #4caf7d; border-radius:6px; background:transparent; color:#2c5f54; cursor:pointer; font-size:11px; white-space:nowrap;">➕ 新增</button>
                <button id="ntuh-procedure-template-copy" type="button" title="複製目前選擇的模板" style="padding:4px 8px; border:1px dashed #9db98a; border-radius:6px; background:transparent; color:#2c5f54; cursor:pointer; font-size:11px; white-space:nowrap;">📄 複製</button>
                <button id="ntuh-procedure-template-edit" type="button" style="padding:4px 8px; border:1px solid #9db98a; border-radius:6px; background:transparent; color:#2c5f54; cursor:pointer; font-size:11px; white-space:nowrap;">✏️ 編輯</button>
                <button id="ntuh-procedure-template-delete" type="button" title="刪除模板" style="padding:4px 7px; border:1px solid #e05c5c; border-radius:6px; background:transparent; color:#e05c5c; cursor:pointer; font-size:11px;">✕</button>
            </div>
            <div id="ntuh-procedure-editor-slot"></div>
        `;

        document.getElementById('ntuh-procedure-template-new').onclick = function () {
            openTemplateEditor(null);
        };

        document.getElementById('ntuh-procedure-template-copy').onclick = function () {
            const template = getSelectedTemplate();
            if (!template) {
                setPanelStatus('warn', '請先選擇要複製的模板。');
                return;
            }
            openTemplateEditor(template, true);
        };

        document.getElementById('ntuh-procedure-template-edit').onclick = function () {
            const template = getSelectedTemplate();
            if (!template) {
                setPanelStatus('warn', '請先選擇要編輯的模板');
                return;
            }
            openTemplateEditor(template);
        };

        document.getElementById('ntuh-procedure-template-delete').onclick = function () {
            const template = getSelectedTemplate();
            if (!template) {
                setPanelStatus('warn', '請先選擇要刪除的模板');
                return;
            }
            const confirmed = window.confirm('確定刪除模板「' + (template.name || template.procedureName || '未命名模板') + '」？');
            if (!confirmed) return;
            const list = ensureTemplateStorage().filter(function (tpl) { return tpl.id !== template.id; });
            const err = saveTemplates(list);
            if (err) {
                setPanelStatus('err', '刪除模板失敗：' + err);
                return;
            }
            renderTemplateOptions();
            handleTemplateSelectChange();
            setPanelStatus('ok', '✓ 模板已刪除');
        };

        const select = findTemplateSelect();
        if (select) {
            select.onchange = function () {
                handleTemplateSelectChange();
                updateTemplateActionButtons();
            };
        }
    }

    function buildPanel() {
        const existing = document.getElementById('ntuh-procedure-panel');
        if (existing) return existing;

        const style = document.createElement('style');
        style.textContent = `
            #ntuh-procedure-fab {
                position: fixed; bottom: 140px; right: 24px; width: 48px; height: 48px; border-radius: 50%;
                background: #2c5f54; border: 2px solid #4a7cdc; box-shadow: 0 4px 16px rgba(0,0,0,0.4);
                z-index: 99999; cursor: pointer; display: flex; align-items: center; justify-content: center;
                font-size: 20px; transition: transform 0.15s, box-shadow 0.15s; user-select: none; color: #fff;
            }
            #ntuh-procedure-fab:hover { transform: scale(1.1); box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
            #ntuh-procedure-panel {
                position: fixed; bottom: 24px; right: 46px; width: 265px; background: #ffffff;
                border: 1px solid #9db98a; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);
                z-index: 99999; font-family: 'Consolas', monospace, sans-serif; font-size: 12px; color: #2b3a2b;
                display:none; height:calc(100vh - 105px); max-height:calc(100vh - 105px);
                min-height:0; box-sizing:border-box; flex-direction:column; overflow:hidden;
            }
            #ntuh-procedure-header {
                display:flex; height:42px; box-sizing:border-box;
                align-items:flex-end; justify-content:space-between; gap:8px;
                padding:0 8px;
                background:#2c5f54; color:#ffffff;
                border-bottom:1px solid #9db98a;
                cursor:move; user-select:none; flex-shrink:0;
            }
            /* 頂部列：深綠單色（無漸層）；頁籤選中＝白底與內容區相連，未選中＝透明 */
            #ntuh-procedure-tabs {
                display:flex; align-items:flex-end; gap:4px; height:42px;
                min-width:0; flex:0 1 auto; margin:0; padding:6px 0 0; box-sizing:border-box; overflow:visible;
            }
            #ntuh-procedure-tabs .ntuh-procedure-tab {
                appearance:none !important;
                display:flex !important; align-items:center !important; justify-content:center !important;
                box-sizing:border-box !important;
                flex:0 1 auto !important; width:auto !important; min-width:0 !important; max-width:none !important;
                height:32px !important; min-height:32px !important; max-height:32px !important;
                padding:0 10px !important; margin:0 !important;
                line-height:1 !important; font-family:inherit !important; text-transform:none !important; letter-spacing:0 !important;
                border:1px solid transparent; border-radius:8px 8px 0 0;
                background:transparent; color:#cfe0d8; font-size:13px; font-weight:600;
                white-space:nowrap; cursor:pointer;
                transition:background .15s ease, color .15s ease, border-color .15s ease;
            }
            #ntuh-procedure-tabs .ntuh-procedure-tab-icon { display:block; flex:none; line-height:1; margin-right:4px; font-size:12px; }
            #ntuh-procedure-tabs .ntuh-procedure-tab-label { display:inline; min-width:0; max-width:78px; overflow:hidden; text-overflow:ellipsis; }
            #ntuh-procedure-tabs .ntuh-procedure-tab:hover { background:rgba(255,255,255,.12); color:#ffffff; }
            #ntuh-procedure-tabs .ntuh-procedure-tab.is-active {
                position:relative; z-index:1;
                height:36px !important; min-height:36px !important; max-height:36px !important;
                margin:0 0 -1px !important;
                background:#ffffff; color:#15332b; font-weight:700;
                border-color:#9db98a; border-bottom-color:#ffffff;
            }
            #ntuh-procedure-tabs .ntuh-procedure-tab.is-active:hover { background:#ffffff; color:#15332b; border-bottom-color:#ffffff; }
            #ntuh-procedure-tabs .ntuh-procedure-tab:focus-visible { outline:2px solid #8fe0b0; outline-offset:-2px; }
            #ntuh-procedure-tabs .ntuh-procedure-tab:disabled { opacity:.4; cursor:not-allowed; background:transparent; }
            #ntuh-procedure-tabs .ntuh-procedure-tab.is-missing:not(.is-active) {
                color:#8ea79b; border-style:dashed; border-color:rgba(255,255,255,.3); background:transparent;
            }
            #ntuh-procedure-close {
                background:none; border:none; color:#dfe8d4; cursor:pointer; font-size:15px; font-weight:600;
                appearance:none !important; box-sizing:border-box !important; flex:none !important;
                width:24px !important; min-width:24px !important; max-width:24px !important;
                height:24px !important; min-height:24px !important; max-height:24px !important;
                padding:0 !important; line-height:1 !important; align-self:center;
                border-radius:6px; transition:color .15s ease, background .15s ease;
            }
            #ntuh-procedure-close:hover { color:#ffd9d9; background:rgba(255,255,255,.14); }
            #ntuh-procedure-body {
                box-sizing:border-box; padding:16px; display:flex; flex-direction:column; gap:8px;
                min-height:0; overflow-y:auto; flex:1 1 auto; color:#2b3a2b;
            }
            #ntuh-procedure-footer {
                padding: 10px 12px; background: #f4f7f2; border-top: 1px solid #9db98a;
                display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
            }
            #ntuh-procedure-body label {
                display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: #4a5a72 !important;
            }
            #ntuh-procedure-body input[type="text"], #ntuh-procedure-body select, #ntuh-procedure-body textarea {
                background: #ffffff !important; border: 1px solid #9db98a !important; border-radius: 6px; color: #2b3a2b !important;
                font-size: 12px; padding: 5px 8px; box-sizing: border-box; width: 100%;
            }
            #ntuh-procedure-body textarea { resize: vertical; }
            .ntuh-procedure-radio-group { display: flex; gap: 12px; flex-wrap: wrap; color: #2b3a2b; }
            .ntuh-procedure-radio-group label { display: inline-flex; align-items: center; gap: 4px; flex-direction: row; cursor: pointer; color: #2b3a2b !important; font-size: 12px; }
            #ntuh-procedure-start-btn {
                padding: 8px 0; border: none; border-radius: 6px; cursor: pointer; font-size: 12px;
                font-weight: 600; background: #2c5f54; color: #fff; flex-shrink: 0; width: 100%;
                transition: background 0.15s;
            }
            #ntuh-procedure-start-btn:hover { background: #244f45; }
            #ntuh-procedure-start-btn:disabled { opacity: 0.5; cursor: not-allowed; }
            #ntuh-procedure-status { font-size: 11px; min-height: 16px; word-break: break-word; }
            .diag-ok { color: #3fb950; } .diag-err { color: #e05c5c; } .diag-warn { color: #f0a030; }
            #ntuh-procedure-progress { font-size: 11px; color: #2c5f54; font-weight: 600; }
            #ntuh-procedure-attending-suggestions { display:none; flex-direction:column; margin-top:2px; border:1px solid #9db98a; border-radius:6px; overflow:hidden; }
            .ntuh-procedure-attending-option { display:flex; gap:8px; align-items:center; border:0; border-bottom:1px solid #9db98a; background:#ffffff; color:#2b3a2b; padding:5px 7px; text-align:left; cursor:pointer; font:inherit; }
            .ntuh-procedure-attending-option:last-child { border-bottom:0; }
            .ntuh-procedure-attending-option:hover { background:#eef3e8; }
            .ntuh-procedure-attending-option strong { color:#2c5f54; min-width:54px; }
            #ntuh-procedure-attending-hint { min-height:13px; color:#5f6f57; font-size:10px; }
            #ntuh-procedure-template-select { display:none; }
            #ntuh-procedure-template-list { display:flex; flex-direction:column; gap:2px; max-height:126px; overflow-y:auto; padding:6px; border:1px solid #9db98a; border-radius:6px; background:#ffffff; }
            .ntuh-procedure-template-item { display:flex; align-items:center; min-height:30px; padding-right:9px; border-radius:6px; color:#2b3a2b; cursor:pointer; font-size:12px; user-select:none; }
            .ntuh-procedure-template-item:hover { background:#eef3e8; }
            .ntuh-procedure-template-item.is-selected { background:#2c5f54; color:#ffffff; }
            .ntuh-procedure-template-item.is-dragging { opacity:.4; }
            .ntuh-procedure-template-item.drop-before { box-shadow:inset 0 2px #4caf7d; }
            .ntuh-procedure-template-item.drop-after { box-shadow:inset 0 -2px #4caf7d; }
            .ntuh-procedure-template-drag-handle { display:flex; align-items:center; justify-content:center; width:24px; flex:none; color:#2c5f54; opacity:0; cursor:grab; font-size:17px; line-height:1; touch-action:none; }
            .ntuh-procedure-template-item:hover .ntuh-procedure-template-drag-handle,
            .ntuh-procedure-template-drag-handle:focus-visible { opacity:1; }
            .ntuh-procedure-template-drag-handle:active { cursor:grabbing; }
            .ntuh-procedure-template-item-name { overflow:hidden; padding:4px 6px 4px 2px; text-overflow:ellipsis; white-space:nowrap; }
            .ntuh-procedure-template-empty { padding:7px; color:#8a9a82; font-size:11px; }
            #ntuh-procedure-template-panel button { font-family:inherit; }
            #ntuh-procedure-template-new { border-color:#4caf7d !important; color:#2c5f54 !important; }
            #ntuh-procedure-template-copy, #ntuh-procedure-template-edit { border-color:#9db98a !important; color:#2c5f54 !important; }
            #ntuh-procedure-template-delete { border-color:#e05c5c !important; color:#b02a2a !important; }
            #ntuh-procedure-template-editor { border-color:#9db98a !important; background:#f4f7f2 !important; }
            #ntuh-procedure-template-editor label { color:#4a5a72 !important; }
            #ntuh-procedure-template-editor input,
            #ntuh-procedure-template-editor select,
            #ntuh-procedure-template-editor textarea { background:#ffffff !important; border-color:#9db98a !important; color:#2b3a2b !important; }
            #ntuh-procedure-template-editor #ntuh-procedure-editor-title { color:#2c5f54 !important; }
            #ntuh-procedure-template-save { background:#4caf7d !important; }
            #ntuh-procedure-template-cancel { border-color:#9db98a !important; color:#5f6f57 !important; }
        `;
        document.head.appendChild(style);

        const fab = document.createElement('div');
        fab.id = 'ntuh-procedure-fab';
        fab.textContent = '✂️';
        fab.title = 'Procedure Note 自動填寫';
        fab.onclick = function () {
            fab.style.display = 'none';
            panel.style.display = 'flex';
            renderTemplateOptions();
            initializeProcedureSettings();
        };
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'ntuh-procedure-panel';
        panel.innerHTML = `
            <div id="ntuh-procedure-header">
                <div id="ntuh-procedure-tabs">
                    <button type="button" class="ntuh-procedure-tab" id="ntuh-procedure-tab-progress" aria-label="Progress" aria-pressed="false" title="切換到 Progress 面板"><span class="ntuh-procedure-tab-icon">📋</span><span class="ntuh-procedure-tab-label">Progress</span></button>
                    <button type="button" class="ntuh-procedure-tab is-active" id="ntuh-procedure-tab-procedure" aria-label="Procedure" aria-pressed="true"><span class="ntuh-procedure-tab-icon">✂️</span><span class="ntuh-procedure-tab-label">Procedure</span></button>
                </div>
                <button id="ntuh-procedure-close" type="button" aria-label="關閉面板" title="關閉面板">✕</button>
            </div>
            <div id="ntuh-procedure-body">
                <div id="ntuh-procedure-progress">準備就緒</div>
                <div id="ntuh-procedure-template-panel"></div>

                <label id="ntuh-procedure-procedure-name-wrap">B-Table 自訂處置名稱
                    <input id="ntuh-procedure-procedure-name" type="text" placeholder="必填：輸入 B-Table 自訂處置名稱" />
                </label>

                <label>主治醫師 ID
                    <input id="ntuh-procedure-attending-id" type="text" inputmode="numeric" autocomplete="off" placeholder="輸入完整 ID，或輸入前綴選擇已記錄醫師" />
                    <div id="ntuh-procedure-attending-suggestions"></div>
                    <div id="ntuh-procedure-attending-hint">輸入完整 ID 後按 Enter 或離開欄位即可套用。</div>
                </label>

                <label>處置部位
                    <div class="ntuh-procedure-radio-group">
                        <label><input type="radio" name="ntuh-procedure-side" value="left" /> 左</label>
                        <label><input type="radio" name="ntuh-procedure-side" value="right" /> 右</label>
                        <label><input type="radio" name="ntuh-procedure-side" value="both" /> 雙側</label>
                        <label><input type="radio" name="ntuh-procedure-side" value="na" checked /> 不分側</label>
                    </div>
                </label>

                <div style="display:flex; align-items:center; gap:16px; margin:2px 0;">
                    <label style="display:flex; align-items:center; gap:6px; flex-direction:row; cursor:pointer; color:#2b3a2b; font-size:12px; margin:0;">
                        <input id="ntuh-procedure-implant" type="checkbox" /> <span>需要植入物</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; flex-direction:row; cursor:pointer; color:#2b3a2b; font-size:12px; margin:0;">
                        <input id="ntuh-procedure-antibiotic" type="checkbox" /> <span>需要抗生素</span>
                    </label>
                </div>

                <div style="display:flex; gap:6px;">
                    <label style="flex:1;">局部麻醉
                        <select id="ntuh-procedure-anesthetic">
                            ${ANESTHETIC_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')}
                        </select>
                        <input id="ntuh-procedure-anesthetic-extra" style="display:none; margin-top:2px;" placeholder="ml 數" />
                    </label>
                    <label style="flex:1;">麻醉途徑
                        <select id="ntuh-procedure-route">
                            ${ROUTE_OPTIONS.map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`).join('')}
                        </select>
                        <input id="ntuh-procedure-route-extra" style="display:none; margin-top:2px;" placeholder="自訂途徑" />
                    </label>
                </div>

                <label>處置過程模板內容（預覽）
                    <textarea id="ntuh-procedure-template-content-display" rows="4" placeholder="處置過程其他紀錄內容"></textarea>
                </label>
            </div>
            <div id="ntuh-procedure-footer">
                <button id="ntuh-procedure-start-btn" type="button">✨ 開始填寫</button>
                <button id="ntuh-procedure-post-confirm-btn" type="button" style="display:none; padding:7px 0; border:1px solid #d29922; border-radius:6px; cursor:pointer; font-size:11px; font-weight:600; background:#302514; color:#f0c674;">檢查後確認處置後評估</button>
                <div id="ntuh-procedure-status" class="diag-ok"></div>
            </div>
        `;
        document.body.appendChild(panel);

        document.getElementById('ntuh-procedure-close').onclick = function () {
            panel.style.display = 'none';
            fab.style.display = 'flex';
        };

        // 頁籤：切回 progress-note-filler 的面板（未安裝只提示，不報錯）
        const progressTab = document.getElementById('ntuh-procedure-tab-progress');
        if (progressTab) {
            syncProgressTabState();
            setTimeout(syncProgressTabState, 2500);
        }
        if (progressTab) progressTab.onclick = async function () {
            progressTab.disabled = true;
            try {
                const opened = await requestPeerPanel(NOTE_PANEL_BRIDGE.openProgress, NOTE_PANEL_BRIDGE.progressState);
                progressPanelInstalled = progressPanelInstalled || opened;
                syncProgressTabState();
                if (opened) {
                    panel.style.display = 'none';
                    fab.style.display = 'flex';
                } else {
                    setPanelStatus('warn', '⚠ 沒收到 progress-note-filler 回應：請確認已安裝／manager 有勾選');
                }
            } finally {
                progressTab.disabled = false;
            }
        };

        document.getElementById('ntuh-procedure-anesthetic').onchange = () => updateAnestheticExtraVisibility();
        document.getElementById('ntuh-procedure-route').onchange = () => updateRouteExtraVisibility();
        const attendingInput = document.getElementById('ntuh-procedure-attending-id');
        attendingInput.oninput = renderAttendingSuggestions;
        attendingInput.onchange = async function () {
            if (!/^\d{6,}$/.test(attendingInput.value.trim())) return;
            try {
                await fillAttendingDoctor(attendingInput.value);
            } catch (error) {
                setAttendingHint(error.message || '主治醫師 ID 套用失敗', 'err');
            }
        };
        attendingInput.onkeydown = async function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            try {
                await fillAttendingDoctor(attendingInput.value);
            } catch (error) {
                setAttendingHint(error.message || '主治醫師 ID 套用失敗', 'err');
            }
        };

        addTemplateControls();
        renderTemplateOptions();
        initializeProcedureSettings();
        renderAttendingSuggestions();

        document.getElementById('ntuh-procedure-template-content-display').value = '';
        document.getElementById('ntuh-procedure-start-btn').onclick = function () {
            startProcedureFill();
        };
        document.getElementById('ntuh-procedure-post-confirm-btn').onclick = async function () {
            const confirmButton = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_PostProcedureSave');
            if (!confirmButton || confirmButton.disabled) {
                setPanelStatus('err', '網頁的「確認處置後評估」目前尚未啟用，請先確認前一階段已完成。');
                return;
            }
            const confirmed = window.confirm('請先核對病人狀況、疼痛指數、X-Ray 與記錄時間。確認內容正確後，是否送出「確認處置後評估」？');
            if (!confirmed) return;
            const action = document.getElementById('ntuh-procedure-post-confirm-btn');
            action.disabled = true;
            try {
                await triggerAndWaitForPostback(function () { confirmButton.click(); }, '處置後評估確認');
                action.style.display = 'none';
                setPanelStatus('ok', '處置後評估已確認；主治醫師確認仍請由醫師本人操作。');
            } catch (error) {
                action.disabled = false;
                setPanelStatus('err', '處置後評估確認失敗：' + (error.message || error));
            }
        };

        const header = document.getElementById('ntuh-procedure-header');
        makeDraggable(panel, header);
        return panel;
    }

    function makeDraggable(panel, handle) {
        let startX = 0;
        let startY = 0;
        let startLeft = 0;
        let startTop = 0;

        handle.onmousedown = function (e) {
            if (e.target.closest('button')) return;
            const rect = panel.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.left = startLeft + 'px';
            panel.style.top = startTop + 'px';

            document.onmousemove = function (ev) {
                panel.style.left = (startLeft + ev.clientX - startX) + 'px';
                panel.style.top = (startTop + ev.clientY - startY) + 'px';
            };

            document.onmouseup = function () {
                document.onmousemove = null;
                document.onmouseup = null;
            };
        };
    }

    // ─────────────────────────────────────────────
    // 與 progress-note-filler 的面板協調（頁籤切換）
    //   兩支腳本各自獨立安裝/更新，只用事件協議互通，不互相載入程式碼。
    //   事件名稱是契約：兩支必須字串完全一致，tools/test-note-panel-bridge.js 會鎖住。
    //   payload 一律不放 CustomEvent.detail（Tampermonkey 沙箱可能清掉）。
    // ─────────────────────────────────────────────
    let progressPanelInstalled = false;

    const NOTE_PANEL_BRIDGE = {
        openProgress: 'ntuh-open-progress-panel',
        progressState: 'ntuh-progress-panel-state',
        progressReady: 'ntuh-progress-ready',
        openProcedure: 'ntuh-open-procedure-panel',
        procedureState: 'ntuh-procedure-panel-state',
        procedureReady: 'ntuh-procedure-ready'
    };

    function dispatchBridge(eventName) {
        if (!eventName) return false;
        try { document.dispatchEvent(new CustomEvent(eventName)); return true; }
        catch (e) { return false; }
    }

    function requestPeerPanel(openEvent, stateEvent, retryMs = 300, ackWaitMs = 400) {
        return new Promise((resolve) => {
            let settled = false;
            let attempts = 0;
            const finish = function (ok) {
                if (settled) return;
                settled = true;
                try { document.removeEventListener(stateEvent, onAck); } catch (e) { /* noop */ }
                resolve(ok);
            };
            const onAck = function () { finish(true); };
            try { document.addEventListener(stateEvent, onAck); }
            catch (e) { resolve(false); return; }
            const ping = function () {
                if (settled) return;
                dispatchBridge(openEvent);
                attempts += 1;
                if (attempts < 3) setTimeout(ping, retryMs);
                else setTimeout(function () { finish(false); }, ackWaitMs);
            };
            ping();
        });
    }

    // 對方沒載入時頁籤淡化（純視覺）
    function syncProgressTabState() {
        try {
            const tab = document.getElementById('ntuh-procedure-tab-progress');
            if (!tab || !tab.classList) return;
            if (progressPanelInstalled) {
                tab.classList.remove('is-missing');
                tab.title = '切換到 progress-note-filler 面板';
            } else {
                tab.classList.add('is-missing');
                tab.title = '未偵測到 progress-note-filler（點擊會顯示提示）';
            }
        } catch (e) { /* noop */ }
    }
    // 被 progress 面板叫過來時開自己的面板
    function openProcedurePanelFromBridge() {
        try {
            setupUi();
            const panel = document.getElementById('ntuh-procedure-panel');
            if (!panel) return false;
            const fab = document.getElementById('ntuh-procedure-fab');
            if (fab) fab.style.display = 'none';
            panel.style.display = 'flex';
            try { renderTemplateOptions(); } catch (e) { /* noop */ }
            try { initializeProcedureSettings(); } catch (e) { /* noop */ }
            return true;
        } catch (e) { return false; }
    }

    try {
        document.addEventListener(NOTE_PANEL_BRIDGE.openProcedure, function () {
            if (openProcedurePanelFromBridge()) dispatchBridge(NOTE_PANEL_BRIDGE.procedureState);
        });
        document.addEventListener(NOTE_PANEL_BRIDGE.progressReady, function () {
            progressPanelInstalled = true;
            syncProgressTabState();
        });
    } catch (e) { /* noop */ }
    if ((window.location && window.location.href || '').indexOf('InsertProgressNoteContent.aspx') >= 0) {
        dispatchBridge(NOTE_PANEL_BRIDGE.procedureReady);
    }
    function setupUi() {
        if (!isProcedureNotePage()) return;
        if (document.getElementById('ntuh-procedure-fab')) return;
        buildPanel();
    }

    // ─────────────────────────────────────────────
    // 處置名稱與各階段自動填寫核心邏輯
    // ─────────────────────────────────────────────

    function findProcedureNameSelect(procedureName) {
        const mainTab = document.getElementById('NTUHWeb1_ProcedureNoteMainTab');
        const handler = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler');
        const root = handler || mainTab || document;
        const wanted = normalizeText(procedureName).toLocaleLowerCase();
        const selects = Array.from(root.querySelectorAll('select'));
        const scored = selects.map(function (select) {
            const attributes = [select.id, select.name, select.getAttribute('aria-label')].join(' ');
            const nearby = normalizeText(select.closest('tr, .row, .fieldRow, td, div')?.textContent || '');
            const options = Array.from(select.options || []).map(function (option) {
                return normalizeText(option.textContent || option.value || '').toLocaleLowerCase();
            });
            let score = 0;
            if (/procedure|處置名稱|b.?table/i.test(attributes)) score += 100;
            if (/procedure|處置名稱|處置過程/i.test(nearby)) score += 40;
            if (options.includes(wanted)) score += 80;
            if (options.some(function (label) { return /\bb\s*[-–—]?\s*table\b|btable/i.test(label); })) score += 30;
            return { select: select, score: score };
        }).filter(function (item) { return item.score > 0; });
        scored.sort(function (a, b) { return b.score - a.score; });
        return scored.length ? scored[0].select : null;
    }

    function selectProcedureOption(select, procedureValue, procedureLabel) {
        if (!select) return false;
        const savedValue = String(procedureValue === null || procedureValue === undefined ? '' : procedureValue);
        const wanted = normalizeText(procedureLabel).toLocaleLowerCase();
        const option = Array.from(select.options || []).find(function (item) {
            return (savedValue && String(item.value) === savedValue) ||
                (wanted && normalizeText(item.textContent || item.value || '').toLocaleLowerCase() === wanted);
        });
        if (!option) return false;
        if (select.value === String(option.value)) return true;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        select.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    async function fillProcedureName(procedureValue, procedureLabel, customProcedureName) {
        const fieldId = 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler_txbBTableProcedureName';
        if (!findPageProcedureSelect() && !document.getElementById(fieldId)) {
            await waitForElement('#NTUHWeb1_ProcedureNoteMainTab select, #NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler_btnCustomProcedureName, #' + fieldId, 8000, 'Procedure 名稱選擇區');
        }

        const procedureSelect = findPageProcedureSelect() || findProcedureNameSelect(procedureLabel);
        if (procedureSelect) {
            const selected = Array.from(procedureSelect.options || []).find(function (option) {
                return String(option.value) === String(procedureValue) ||
                    normalizeText(option.textContent).toLocaleLowerCase() === normalizeText(procedureLabel).toLocaleLowerCase();
            });
            if (!selected) throw new Error('網頁處置選單找不到模板指定的處置：' + procedureLabel);
            const isBTable = isBTableProcedure(selected.textContent);
            if (isBTable && !normalizeText(customProcedureName)) {
                throw new Error('B-Table 必須先填寫自訂處置名稱。');
            }

            await triggerAndWaitForPostback(function () {
                selectProcedureOption(procedureSelect, selected.value, selected.textContent);
            }, '處置類型選取');

            if (isBTable) {
                await waitForCondition(function () {
                    const field = document.getElementById(fieldId);
                    return !!field && !field.disabled && field.getClientRects().length > 0;
                }, 10000, 'B-Table 自訂處置名稱欄位');
                const refreshedField = document.getElementById(fieldId);
                setFieldValue(refreshedField, customProcedureName);
                if (normalizeText(refreshedField.value) !== normalizeText(customProcedureName)) {
                    throw new Error('B-Table 自訂處置名稱未能填入，請檢查欄位。');
                }
            }

            await waitForProcessTable();
            return;
        }

        const customBtn = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureHandler_btnCustomProcedureName');
        if (customBtn) {
            await triggerAndWaitForPostback(function () { customBtn.click(); }, '開啟自訂 Procedure 名稱');
            await waitForCondition(function () {
                const field = document.getElementById(fieldId);
                return !!field && !field.disabled && field.getClientRects().length > 0;
            }, 10000, '自訂 Procedure 名稱欄位');
            setFieldValue(document.getElementById(fieldId), customProcedureName || procedureLabel);
            return;
        }

        throw new Error('找不到網頁上的處置選單或自訂名稱欄位。');
    }

    function findRowByLabel(container, labelText) {
        if (!container) return null;
        const rows = Array.from(container.querySelectorAll('tr, tbody > tr, .row, .fieldRow'));
        for (const row of rows) {
            const text = normalizeText(row.textContent || '');
            if (text.toLowerCase().includes(labelText.toLowerCase())) {
                return row;
            }
        }
        return null;
    }

    function findFieldInRow(row, optionText) {
        if (!row) return null;

        // 1. 嘗試找 select
        const select = row.querySelector('select');
        if (select) {
            const ok = chooseOptionByText(select, optionText);
            return { type: 'select', found: ok, element: select };
        }

        // 2. 嘗試找 label 伴隨的 radio / checkbox
        const labels = Array.from(row.querySelectorAll('label'));
        const matchedLabel = labels.find(function (lbl) {
            return normalizeText(lbl.textContent).includes(normalizeText(optionText));
        });

        if (matchedLabel) {
            const input = matchedLabel.querySelector('input') || document.getElementById(matchedLabel.htmlFor);
            if (input) {
                if (!input.checked) input.click();
                return { type: 'input', found: true, element: input };
            }
            matchedLabel.click();
            return { type: 'label', found: true, element: matchedLabel };
        }

        // 3. 嘗試找 textarea
        const textarea = row.querySelector('textarea');
        if (textarea) {
            setFieldValue(textarea, optionText);
            return { type: 'textarea', found: true, element: textarea };
        }

        // 4. 嘗試找一般 input
        const input = row.querySelector('input[type="text"], input:not([type])');
        if (input) {
            setFieldValue(input, optionText);
            return { type: 'input', found: true, element: input };
        }

        return null;
    }

    async function waitForProcessTable() {
        await waitForCondition(function () {
            return !!document.getElementById('ProcedureProcessRecordTable');
        }, 15000, 'ProcedureProcessRecordTable');
    }

    function selectProcedureRecordField({ labelContains, optionText, fallbackOptionText, optional }) {
        const table = document.getElementById('ProcedureProcessRecordTable');
        const row = findRowByLabel(table, labelContains);
        if (!row) {
            if (optional) return false;
            throw new Error('找不到 Procedure Process Record 欄位列：' + labelContains);
        }

        let res = findFieldInRow(row, optionText);
        if (!res || !res.found) {
            if (fallbackOptionText && fallbackOptionText !== optionText) {
                res = findFieldInRow(row, fallbackOptionText);
            }
        }

        if (!res || !res.found) {
            if (optional) return false;
            throw new Error('欄位「' + labelContains + '」找不到可選項目：' + optionText + (fallbackOptionText ? '（預設 ' + fallbackOptionText + ' 亦不存在）' : ''));
        }
        return true;
    }

    async function fillPreAssessment(preAndTimeoutTime) {
        await waitForCondition(function () {
            const button = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPre_PreProcedureSave');
            return !!button && !button.disabled;
        }, 15000, '處置前評估確認按鈕啟用');
        const stable = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPre_Stable');
        if (stable && !stable.checked) stable.click();
        const time = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPre_ExecutionDateTime');
        if (time) setFieldValue(time, preAndTimeoutTime);
        const save = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPre_PreProcedureSave');
        if (!save) throw new Error('找不到處置前評估確認按鈕。');
        await triggerAndWaitForPostback(function () { save.click(); }, '處置前評估儲存');
    }

    async function fillTimeout(preAndTimeoutTime, sideValue, implantChecked, antibioticChecked) {
        await waitForCondition(function () {
            const button = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_TimeOutSave');
            return !!button && !button.disabled;
        }, 15000, 'Time-out 確認按鈕啟用');
        const mapping = {
            patient: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckPatientTrue',
            opMode: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckOPModeTrue',
            document: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckDocumentTrue',
            equipment: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckEquipmentTrue',
            sideLeft: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckPositionLeft',
            sideRight: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckPositionRight',
            sideBoth: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckPositionBoth',
            sideNA: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckPositionNA',
            implantTrue: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckImplantationItemTrue',
            implantNA: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckImplantationItemNA',
            antibioticTrue: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckAntibioticsTrue',
            antibioticNA: 'NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_CheckAntibioticsNA'
        };

        const sideKey = sideValue === 'left' ? 'sideLeft' : sideValue === 'right' ? 'sideRight' : sideValue === 'both' ? 'sideBoth' : 'sideNA';
        const implantTarget = implantChecked ? mapping.implantTrue : mapping.implantNA;
        const antibioticTarget = antibioticChecked ? mapping.antibioticTrue : mapping.antibioticNA;

        const requiredItems = ['patient', 'opMode', 'document', 'equipment'].map(function (key) {
            return { id: mapping[key], label: key };
        }).concat([
            { id: mapping[sideKey], label: '處置部位' },
            { id: implantTarget, label: '植入物' },
            { id: antibioticTarget, label: '預防性抗生素' }
        ]);

        for (const item of requiredItems) {
            let confirmed = false;
            for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
                let field = document.getElementById(item.id);
                if (!field) throw new Error('找不到 Time-out 欄位：' + item.label);
                if (field.checked) {
                    confirmed = true;
                    break;
                }

                await triggerAndWaitForPostback(function () {
                    field = document.getElementById(item.id);
                    if (field && !field.checked) field.click();
                }, 'Time-out「' + item.label + '」更新');

                try {
                    await waitForCondition(function () {
                        const currentField = document.getElementById(item.id);
                        return !!(currentField && currentField.checked);
                    }, 2000, 'Time-out「' + item.label + '」勾選結果');
                    confirmed = true;
                } catch (e) {
                    // UpdatePanel 重繪後再次取得欄位並嘗試勾選，最多三次。
                }
            }
            if (!confirmed) throw new Error('Time-out「' + item.label + '」勾選未保留，請確認欄位狀態後重試。');
        }

        const incompleteItem = requiredItems.find(function (item) {
            const field = document.getElementById(item.id);
            return !field || !field.checked;
        });
        if (incompleteItem) {
            throw new Error('Time-out 欄位未成功保留：' + incompleteItem.label);
        }

        const time = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_ExecutionDateTime');
        if (time) setFieldValue(time, preAndTimeoutTime);
        const save = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_TimeOutSave');
        if (!save) throw new Error('找不到 Time-out 確認按鈕。');
        await triggerAndWaitForPostback(function () { save.click(); }, 'Time-out 儲存');
    }

    async function fillProcessRecord(processTime, anestheticLabel, anestheticExtra, routeLabel, routeExtra, templateContent) {
        await waitForProcessTable();
        await waitForCondition(function () {
            const button = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureProcessRecord_ProcedureProcessRecordSave2');
            return !!button && !button.disabled;
        }, 15000, '處置過程確認按鈕啟用');
        let matchedFields = 0;

        // 1. 局部麻醉: 有
        if (selectProcedureRecordField({ labelContains: '局部麻醉', optionText: '有', optional: true })) matchedFields++;

        // 2. 藥品選取
        if (selectProcedureRecordField({
            labelContains: '藥品',
            optionText: anestheticLabel,
            fallbackOptionText: DEFAULT_ANESTHETIC,
            optional: true
        })) matchedFields++;

        // 2.1 填入藥品 extra 輸入框 (elementidse=4 for Xylestersin-A, elementidse=6 for 其他)
        if (anestheticLabel === 'Xylestersin-A' && anestheticExtra) {
            const table = document.getElementById('ProcedureProcessRecordTable');
            const row = findRowByLabel(table, '藥品');
            const input = row && row.querySelector('input[type="text"]');
            if (input) setFieldValue(input, anestheticExtra);
        } else if (anestheticLabel === '其他' && anestheticExtra) {
            const table = document.getElementById('ProcedureProcessRecordTable');
            const row = findRowByLabel(table, '藥品');
            const inputs = row ? Array.from(row.querySelectorAll('input[type="text"]')) : [];
            const input = inputs[inputs.length - 1];
            if (input) setFieldValue(input, anestheticExtra);
        }

        // 3. 途徑選取
        if (selectProcedureRecordField({
            labelContains: '途徑',
            optionText: routeLabel,
            fallbackOptionText: DEFAULT_ROUTE,
            optional: true
        })) matchedFields++;

        // 3.1 填入途徑 extra 輸入框 (elementidse=5 for 其他)
        if (routeLabel === '其他' && routeExtra) {
            const table = document.getElementById('ProcedureProcessRecordTable');
            const row = findRowByLabel(table, '途徑');
            const inputs = row ? Array.from(row.querySelectorAll('input[type="text"]')) : [];
            const input = inputs[inputs.length - 1];
            if (input) setFieldValue(input, routeExtra);
        }

        // 4. 病人狀況
        if (selectProcedureRecordField({ labelContains: '病人狀況', optionText: '穩定', optional: true })) matchedFields++;

        // 5. 其他紀錄
        if (selectProcedureRecordField({ labelContains: '其他紀錄', optionText: templateContent, optional: true })) matchedFields++;

        if (!matchedFields) {
            throw new Error('此處置的過程紀錄欄位與目前支援的欄位不同，為避免送出空白紀錄，流程已停止；請勿手動確認，需先提供該處置的表單欄位供設定。');
        }

        const execTime = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureProcessRecord_ExecutionDateTime');
        if (execTime) setFieldValue(execTime, processTime);
        const save = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureProcessRecord_ProcedureProcessRecordSave2');
        if (!save) throw new Error('找不到處置過程紀錄確認按鈕。');
        await triggerAndWaitForPostback(function () { save.click(); }, '處置過程紀錄儲存');
    }

    async function fillPostAssessment(processAndPostTime) {
        const stable = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_Stable');
        if (stable && !stable.checked) stable.click();
        const pain = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_PainIndex');
        if (pain) setFieldValue(pain, '2');
        const noXray = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_NoNecessaryXray');
        if (noXray && !noXray.checked) noXray.click();
        const time = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_ExecutionDateTime');
        if (time) setFieldValue(time, processAndPostTime);
        // 依要求不自動點擊「確認處置後評估」
    }

    async function startProcedureFill() {
        if (isExecuting) return;

        const startBtn = document.getElementById('ntuh-procedure-start-btn');
        const panel = document.getElementById('ntuh-procedure-panel');
        if (!startBtn || !panel) return;

        const template = getSelectedTemplate();
        const procedureNameElement = document.getElementById('ntuh-procedure-procedure-name');
        const contentField = document.getElementById('ntuh-procedure-template-content-display');
        const attendingIdElement = document.getElementById('ntuh-procedure-attending-id');

        const selectedProcedureName = normalizeText(procedureNameElement ? procedureNameElement.value : (template ? template.procedureName : ''));
        const selectedProcedure = template ? resolveTemplateProcedure(template) : {
            value: procedureNameElement?.dataset.procedureTypeValue || getDefaultProcedureOption().value,
            label: procedureNameElement?.dataset.procedureTypeLabel || getDefaultProcedureOption().label
        };
        const customProcedureName = isBTableProcedure(selectedProcedure.label) ? selectedProcedureName : '';
        const selectedContent = contentField ? contentField.value : (template ? template.content : '');
        const selectedAttendingId = attendingIdElement ? attendingIdElement.value.trim() : '';

        if (!selectedProcedure.label || (isBTableProcedure(selectedProcedure.label) && !customProcedureName)) {
            setPanelStatus('err', isBTableProcedure(selectedProcedure.label) ? '請先填寫 B-Table 自訂處置名稱。' : '請先選擇處置類型。');
            return;
        }

        if (!selectedContent || !normalizeText(selectedContent)) {
            setPanelStatus('err', '處置模板內容不可為空白。');
            return;
        }

        if (!isBTableProcedure(selectedProcedure.label)) {
            setPanelStatus('err', '目前自動填寫欄位依 B-Table 表單設定；其他處置的欄位不同，尚未完成欄位對應，為避免填錯病歷，本次不會開始。');
            return;
        }

        // 鎖定操作並建立 operationId
        const opId = 'op-' + nowMs() + '-' + Math.floor(Math.random() * 10000);
        currentOperationId = opId;
        isExecuting = true;
        setFormInteractive(false);
        const postConfirmAction = document.getElementById('ntuh-procedure-post-confirm-btn');
        if (postConfirmAction) {
            postConfirmAction.style.display = 'none';
            postConfirmAction.disabled = false;
        }
        startBtn.textContent = '⏳ 填寫中...';
        setPanelStatus('warn', '開始執行自動填寫流程...');

        const currentTime = new Date();
        const preAndTimeoutTime = new Date(currentTime.getTime() - 30 * 60 * 1000);
        const processAndPostTime = new Date(currentTime.getTime());

        const formattedPreTimeout = formatDateTime(preAndTimeoutTime);
        const formattedProcessPost = formatDateTime(processAndPostTime);

        const sideValue = document.querySelector('input[name="ntuh-procedure-side"]:checked') ? document.querySelector('input[name="ntuh-procedure-side"]:checked').value : 'na';
        const implantEl = document.getElementById('ntuh-procedure-implant');
        const antibioticEl = document.getElementById('ntuh-procedure-antibiotic');
        const implantChecked = !!(implantEl && implantEl.checked);
        const antibioticChecked = !!(antibioticEl && antibioticEl.checked);

        const anestheticEl = document.getElementById('ntuh-procedure-anesthetic');
        const anestheticExtraEl = document.getElementById('ntuh-procedure-anesthetic-extra');
        const routeEl = document.getElementById('ntuh-procedure-route');
        const routeExtraEl = document.getElementById('ntuh-procedure-route-extra');

        const lastAnesthesia = loadLastAnesthesia();
        const selectedAnesthetic = anestheticEl ? anestheticEl.value : lastAnesthesia.anestheticLabel;
        const selectedAnestheticExtra = (anestheticExtraEl && anestheticExtraEl.style.display !== 'none') ? anestheticExtraEl.value.trim() : (template ? (template.anestheticExtra || '') : '');
        const selectedRoute = routeEl ? routeEl.value : lastAnesthesia.routeLabel;
        const selectedRouteExtra = (routeExtraEl && routeExtraEl.style.display !== 'none') ? routeExtraEl.value.trim() : (template ? (template.routeExtra || '') : '');

        try {
            // 步驟 1：處置名稱與處置前評估
            updateProgress('1/4 處置前評估');
            setPanelStatus('warn', '填寫中：處置名稱與處置前評估...');
            await fillProcedureName(selectedProcedure.value, selectedProcedure.label, customProcedureName);
            if (currentOperationId !== opId) return;

            // 處置名稱選擇可能觸發 UpdatePanel postback；之後再填主治，避免員編被該 postback 清掉。
            if (selectedAttendingId) {
                setPanelStatus('warn', '填寫中：主治醫師資料...');
                await fillAttendingDoctor(selectedAttendingId);
                if (currentOperationId !== opId) return;
            }

            await waitForCondition(function () {
                return !!document.getElementById('ProcedureProcessRecordTable');
            }, 15000, '處置過程表格重繪');
            if (currentOperationId !== opId) return;

            await fillPreAssessment(formattedPreTimeout);
            if (currentOperationId !== opId) return;

            // 等待 Time-out 區塊可互動
            await waitForCondition(function () {
                const button = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureTimeOut_TimeOutSave');
                return !!button && !button.disabled;
            }, 15000, 'Time-out 區塊可互動');
            if (currentOperationId !== opId) return;

            // 步驟 2：Time-out
            updateProgress('2/4 Time-out');
            setPanelStatus('warn', '填寫中：Time-out...');
            await fillTimeout(formattedPreTimeout, sideValue, implantChecked, antibioticChecked);
            if (currentOperationId !== opId) return;

            // 等待處置過程區塊可互動
            await waitForCondition(function () {
                const button = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureProcessRecord_ProcedureProcessRecordSave2');
                return !!button && !button.disabled;
            }, 15000, '處置過程區塊可互動');
            if (currentOperationId !== opId) return;

            // 步驟 3：處置過程紀錄
            updateProgress('3/4 處置過程紀錄');
            setPanelStatus('warn', '填寫中：處置過程紀錄...');
            await fillProcessRecord(formattedProcessPost, selectedAnesthetic, selectedAnestheticExtra, selectedRoute, selectedRouteExtra, selectedContent);
            if (currentOperationId !== opId) return;

            // 成功完成處置過程紀錄後，儲存局部麻醉記憶
            saveLastAnesthesia(selectedAnesthetic, selectedAnestheticExtra, selectedRoute, selectedRouteExtra);

            // 等待處置後評估區塊
            await waitForCondition(function () {
                const time = document.getElementById('NTUHWeb1_ProcedureNoteMainTab_ucProcedureAssessmentPost_ExecutionDateTime');
                return !!time && !time.disabled;
            }, 15000, '處置後評估區塊可輸入');
            if (currentOperationId !== opId) return;

            // 步驟 4：只填入處置後評估；確認前由使用者核對並明確觸發送出。
            updateProgress('4/4 處置後評估已填寫，待使用者核對');
            setPanelStatus('warn', '填寫中：處置後評估...');
            await fillPostAssessment(formattedProcessPost);

            const postConfirmAction = document.getElementById('ntuh-procedure-post-confirm-btn');
            if (postConfirmAction) {
                postConfirmAction.disabled = false;
                postConfirmAction.style.display = 'block';
            }
            setPanelStatus('ok', '✓ 前三階段已確認、處置後評估已填入。請核對後按下「檢查後確認處置後評估」。');
            updateProgress('4/4 待核對並確認處置後評估');
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            setPanelStatus('err', '填寫失敗：' + message);
            updateProgress('填寫中斷，請檢查目前表單狀態');
            console.warn('[ProcedureNoteFiller] fill failed:', message);
        } finally {
            // Time-out / 儲存等後續 postback 也可能重繪主治欄位；最後再套用一次，確保畫面保留員編。
            if (selectedAttendingId) {
                try {
                    await fillAttendingDoctor(selectedAttendingId);
                } catch (attendingError) {
                    console.warn('[ProcedureNoteFiller] attending ID restore failed:', attendingError.message || attendingError);
                }
            }
            isExecuting = false;
            setFormInteractive(true);
            startBtn.textContent = '✨ 開始填寫';
            if (panel) {
                panel.style.display = 'flex';
            }
        }
    }

    function bindEvents() {
        const select = findTemplateSelect();
        if (select) {
            select.onchange = function () {
                handleTemplateSelectChange();
                updateTemplateActionButtons();
            };
        }
    }

    function initializePage() {
        if (!isProcedureNotePage()) return;
        setupUi();
        const select = findTemplateSelect();
        if (select) {
            bindEvents();
            renderTemplateOptions();
            initializeProcedureSettings();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            setTimeout(initializePage, 1000);
        });
    } else {
        setTimeout(initializePage, 1000);
    }

    const observer = new MutationObserver(function () {
        if (!document.getElementById('ntuh-procedure-fab') && isProcedureNotePage()) {
            setTimeout(initializePage, 300);
        }
    });
    observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
})();
