// ==UserScript==
// @name         NTUH Today's Consultation Query & Notification
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.3.2
// @description  在照會頁新增「今日照會查詢」及定時提醒待回覆與暫存照會通知
// @author       Twb06
// @match        https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/QueryNotifyRecordByDr.aspx*
// @match        https://hchihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/QueryNotifyRecordByDr.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/today-consultation-query.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/today-consultation-query.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    
    // 可自行設定查詢間隔與通知保留時間，預設每 5 分鐘重新查詢一次，通知新待回覆或暫存照會，並在 1 天後自動清除通知。
    const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
    const NOTIFIED_RETENTION_MS = 1 * 24 * 60 * 60 * 1000;

    const START_DATE_IDS = {
        year: 'NTUHWeb1_DateTextBoxYearMonthDayStart_YearInput',
        month: 'NTUHWeb1_DateTextBoxYearMonthDayStart_MonthInput',
        day: 'NTUHWeb1_DateTextBoxYearMonthDayStart_DayInput',
    };
    const END_DATE_IDS = {
        year: 'NTUHWeb1_DateTextBoxYearMonthDayEnd_YearInput',
        month: 'NTUHWeb1_DateTextBoxYearMonthDayEnd_MonthInput',
        day: 'NTUHWeb1_DateTextBoxYearMonthDayEnd_DayInput',
    };
    const QUERY_BUTTON_ID = 'NTUHWeb1_ButtonQueryByDept';
    const QUICK_BUTTON_ID = 'ntuh-query-today-button';
    const NOTIFICATION_TOGGLE_ID = 'ntuh-consult-notification-toggle';
    const POLLING_ENABLED_KEY = 'ntuh-consult-notification-enabled';
    const NOTIFIED_KEY = 'ntuh-consult-notified-items-v2';
    const NOTIFY_TABLE_ID = 'NTUHWeb1_NotifyDrRecord';
    

    function readSetting(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            return null;
        }
    }

    function writeSetting(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (error) {
            // 儲存空間不可用時仍允許本次頁面工作。
        }
    }

    function isPollingEnabled() {
        return readSetting(POLLING_ENABLED_KEY) === 'true';
    }

    function setInputValue(id, value) {
        const input = document.getElementById(id);
        if (!input) return false;

        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    function queryFromToday() {
        const today = new Date();
        const startDate = new Date(today);
        const isNightShift = today.getHours() < 8;
        if (isNightShift) startDate.setDate(startDate.getDate() - 1);

        const fillDate = (ids, date) => [
            setInputValue(ids.year, date.getFullYear()),
            setInputValue(ids.month, date.getMonth() + 1),
            setInputValue(ids.day, date.getDate()),
        ].every(Boolean);

        const filled = fillDate(START_DATE_IDS, startDate)
            && fillDate(END_DATE_IDS, today);
        const queryButton = document.getElementById(QUERY_BUTTON_ID);

        if (!filled || !queryButton) {
            window.alert('找不到照會查詢日期欄位或「被照會科部查詢」按鈕。');
            return;
        }

        queryButton.click();
    }

    function addQuickButton() {
        if (document.getElementById(QUICK_BUTTON_ID)) return;

        const queryButton = document.getElementById(QUERY_BUTTON_ID);
        if (!queryButton || !queryButton.parentNode) return;

        const button = document.createElement('input');
        button.type = 'button';
        button.id = QUICK_BUTTON_ID;
        button.value = '今日照會查詢';
        button.className = queryButton.className || 'button';
        button.style.cssText = queryButton.style.cssText;
        button.style.marginLeft = '6px';
        button.addEventListener('click', queryFromToday);

        queryButton.insertAdjacentElement('afterend', button);
    }

    function updateNotificationToggle(button) {
        const enabled = isPollingEnabled();
        const permission = 'Notification' in window ? Notification.permission : 'unsupported';
        const permissionHint = enabled && permission !== 'granted'
            ? '（瀏覽器通知未允許）'
            : '';
        button.value = `照會通知：${enabled ? '開啟' : '關閉'}${permissionHint}`;
        button.setAttribute('aria-pressed', String(enabled));
        button.title = permissionHint
            ? '監控設定已開啟，但瀏覽器通知權限不是「允許」；請檢查網站通知權限。'
            : '開啟後每 5 分鐘重新查詢；新待回覆或暫存照會會以瀏覽器通知提醒一次。';
    }

    function getRowText(row, suffix, preferTitle = false) {
        const element = row.querySelector(`span[id$="_${suffix}"]`);
        if (!element) return '';
        return (preferTitle && element.title ? element.title : element.textContent).trim();
    }

    function hashConsultationIdentity(value) {
        // 只保存識別碼雜湊，避免將病歷號直接寫入 localStorage。
        let hashA = 0x811c9dc5;
        let hashB = 0x27d4eb2d;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            hashA = Math.imul(hashA ^ code, 0x01000193);
            hashB = Math.imul(hashB ^ code, 0x5bd1e995);
        }
        return `${(hashA >>> 0).toString(16)}${(hashB >>> 0).toString(16)}`;
    }

    function findActiveConsultations() {
        const table = document.getElementById(NOTIFY_TABLE_ID);
        if (!table) return [];

        return Array.from(table.querySelectorAll('tr'))
            .map((row) => {
                const status = getRowText(row, 'NotifyStatus');
                if (status !== '待回覆' && status !== '暫存') return null;

                const chartNo = getRowText(row, 'PersonChartNo');
                const department = getRowText(row, 'DepartMentName');
                const ward = getRowText(row, 'WardCodeLabel');
                const dateTime = getRowText(row, 'NotifyDateTime', true);
                const creator = getRowText(row, 'CreateEmpNo');
                const type = getRowText(row, 'lblNotType', true);
                const identity = [chartNo, department, ward, dateTime || creator, type].join('|');

                return {
                    id: hashConsultationIdentity(identity),
                    status,
                    leftTime: getRowText(row, 'lblLeftTime'),
                };
            })
            .filter(Boolean);
    }

    function readNotifiedItems(now) {
        try {
            const saved = JSON.parse(readSetting(NOTIFIED_KEY) || '{}');
            return Object.fromEntries(Object.entries(saved)
                .filter(([, timestamp]) => Number.isFinite(timestamp)
                    && now - timestamp < NOTIFIED_RETENTION_MS));
        } catch (error) {
            return {};
        }
    }

    function checkPendingConsultation() {
        const now = Date.now();
        const notifiedItems = readNotifiedItems(now);
        const activeItems = findActiveConsultations();
        const newItems = activeItems.filter((item) => !notifiedItems[item.id]);

        if (newItems.length === 0 || !('Notification' in window)
            || Notification.permission !== 'granted') {
            writeSetting(NOTIFIED_KEY, JSON.stringify(notifiedItems));
            return;
        }

        newItems.forEach((item) => {
            notifiedItems[item.id] = now;
        });
        writeSetting(NOTIFIED_KEY, JSON.stringify(notifiedItems));

        const pendingCount = newItems.filter((item) => item.status === '待回覆').length;
        const draftCount = newItems.filter((item) => item.status === '暫存').length;
        const timeList = newItems
            .filter((item) => item.status === '待回覆' && item.leftTime && item.leftTime !== '-')
            .map((item) => item.leftTime);
        const summary = [
            pendingCount ? `待回覆 ${pendingCount} 筆` : '',
            draftCount ? `暫存 ${draftCount} 筆` : '',
        ].filter(Boolean).join('、');

        try {
            const notification = new Notification(`新照會：${summary}`, {
                body: timeList.length ? `剩餘時間：${timeList.join('、')}` : '請查看照會列表。',
                // 每批新照會用不同 tag，避免瀏覽器以固定 tag 靜默取代上一則通知。
                tag: `ntuh-pending-consultation-${hashConsultationIdentity(
                    newItems.map((item) => item.id).sort().join('|'),
                )}`,
                requireInteraction: true,
            });
            notification.onclick = () => window.focus();
        } catch (error) {
            newItems.forEach((item) => delete notifiedItems[item.id]);
            writeSetting(NOTIFIED_KEY, JSON.stringify(notifiedItems));
        }
    }

    function addNotificationToggle() {
        if (document.getElementById(NOTIFICATION_TOGGLE_ID)) return null;

        const quickButton = document.getElementById(QUICK_BUTTON_ID);
        if (!quickButton) return null;

        const button = document.createElement('input');
        button.type = 'button';
        button.id = NOTIFICATION_TOGGLE_ID;
        button.className = quickButton.className;
        button.style.cssText = quickButton.style.cssText;
        button.style.marginLeft = '6px';
        updateNotificationToggle(button);
        button.addEventListener('click', async () => {
            if (isPollingEnabled()) {
                writeSetting(POLLING_ENABLED_KEY, 'false');
                updateNotificationToggle(button);
                startPolling();
                return;
            }

            if (!('Notification' in window)) {
                window.alert('此瀏覽器不支援桌面通知。');
                return;
            }

            const permission = Notification.permission === 'granted'
                ? 'granted'
                : await Notification.requestPermission();
            if (permission !== 'granted') {
                window.alert('未取得瀏覽器通知權限，請允許此網站顯示通知後再開啟。');
                return;
            }

            writeSetting(POLLING_ENABLED_KEY, 'true');
            updateNotificationToggle(button);
            checkPendingConsultation();
            startPolling();
        });

        quickButton.insertAdjacentElement('afterend', button);
        return button;
    }

    let refreshTimer = null;
    function startPolling() {
        if (refreshTimer !== null) {
            window.clearInterval(refreshTimer);
            refreshTimer = null;
        }
        if (!isPollingEnabled()) return;

        refreshTimer = window.setInterval(() => {
            if (!isPollingEnabled()) return;
            checkPendingConsultation();
            queryFromToday();
        }, REFRESH_INTERVAL_MS);
    }

    addQuickButton();
    addNotificationToggle();
    if (isPollingEnabled()) {
        checkPendingConsultation();
        startPolling();
    }
})();