// ==UserScript==
// @name         Better Portal - Disable PatientSync
// @namespace    better-portal-patient-sync
// @version      0.1.0
// @description  Keep each portal tab on its own patient by disabling native PatientSync.
// @match        *://ihisaw.ntuh.gov.tw/WebApplication/*
// @match        *://hchihisaw.ntuh.gov.tw/WebApplication/*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/patient-sync-disable.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/patient-sync-disable.user.js
// @run-at       document-start
// @sandbox      raw
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    if (!['ihisaw.ntuh.gov.tw', 'hchihisaw.ntuh.gov.tw'].includes(location.hostname)
        || !/^https?:$/.test(location.protocol)
        || !location.pathname.startsWith('/WebApplication/')) return;
    if (window.__bpPatientSyncDisabled) return;
    window.__bpPatientSyncDisabled = true;

    const nativeAddEventListener = window.addEventListener;
    const disabledSync = function PatientSyncDisabled() {};

    // TPR 直接註冊 PatientSync；Ward 則透過匿名函式呼叫。
    window.addEventListener = function (type, listener, options) {
        if (this === window && type === 'focus' && typeof listener === 'function'
            && /\bPatientSync\b/.test(Function.toString.call(listener))) return;
        return nativeAddEventListener.call(this, type, listener, options);
    };

    function disableSync() {
        const sync = window.PatientSync;
        if (typeof sync !== 'function' || sync === disabledSync) return;
        window.removeEventListener('focus', sync, false);
        window.removeEventListener('focus', sync, true);
        window.PatientSync = disabledSync;
    }

    // Capture 階段先停用同步，處理稍後載入的函式與 Ward 的全域查找。
    nativeAddEventListener.call(window, 'focus', disableSync, true);
    document.addEventListener('DOMContentLoaded', disableSync, true);
    nativeAddEventListener.call(window, 'load', disableSync, true);
    disableSync();
    console.info('[BP PatientSync] Automatic patient following disabled.');
})();
