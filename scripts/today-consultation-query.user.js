// ==UserScript==
// @name         NTUH Today's Consultation Query
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.2.0
// @description  在照會頁新增「今日照會查詢」按鈕；凌晨值班時自動查詢昨天至今天的照會
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

    addQuickButton();
})();