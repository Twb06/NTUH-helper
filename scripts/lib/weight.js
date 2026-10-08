// ==============================================================
// 體重（護理生命徵象頁的 VitalSign_getPopupWindowData.aspx）的請求參數與回傳解析（不碰網路）
// --------------------------------------------------------------
// 體重不在 OuterData vitalsign 裡。TPR 頁的體重清單是「點格子開輸入視窗」時，由
//   GET Nursing/VitalSign_getPopupWindowData.aspx?…&Kind=VitalSign&Group=PhysicalWeight&Type=init
// 的回傳 XML（TableRecords/TableRecord/TableRecordContent）建出來的（新竹 2026-10-08 實測）。
//
// ⚠️ 這個請求「不帶病人識別」：伺服器靠「最後載入 VitalSign_TPR.aspx 的病人」決定回誰，回傳裡也沒有可驗證病人的欄位。
//    所以呼叫端必須：一次一位（串行）、先 GET 該病人的 TPR 頁（只取內容、不跑 JS）再立刻呼叫。
//    本檔只負責「組參數」與「解析回傳」，網路與串行由呼叫端處理。
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/weight.js
//   之後用 window.NTUHWeight。注意 @require 會被 Tampermonkey 快取，改了這支要在「外部資源」手動更新。
//
//   NTUHWeight.popupQuery(fromDate, toDate, nowDate) → 查詢字串（不含 ?）
//   NTUHWeight.parsePopup(xmlText) → { rows: [{ ms, kg, note }]（依時間排序、已去重）, skipped }
// ==============================================================

/* global module */
(function (root) {
    'use strict';

    // 頁面用的日期格式：2026/10/3-00:00:00（月日不補零）
    const rangeStr = (d, hms) => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}-${hms}`;

    function popupQuery(fromDate, toDate, nowDate) {
        const start = rangeStr(fromDate, '00:00:00'), end = rangeStr(toDate, '23:59:59');
        const n = nowDate;
        const cur = `${n.getFullYear()}/${n.getMonth() + 1}/${n.getDate()} ${n.getHours()}:${n.getMinutes()}:${n.getSeconds()}`;
        return `check=${encodeURIComponent(n.toString())}&SerialNo=undefined`
            + `&RecordAreaID=${encodeURIComponent(`VitalSign_PhysicalWeight_${start}_${end}`)}&Kind=VitalSign&Group=PhysicalWeight`
            + `&StartDateTime=${encodeURIComponent(start)}&EndDateTime=${encodeURIComponent(end)}&CurrentDateTime=${encodeURIComponent(cur)}&Type=init`;
    }

    /**
     * @returns {{rows: Array<{ms:number, kg:string, note:string}>, skipped:number}}
     *   skipped＝沒採用的筆數：attStatus 不是 N（只見過 N，其他碼意義未知，可能是刪除／更改過）、或時間／數值格式讀不出來。
     *   呼叫端要把它如實回報，不能靜默丟掉。同一筆（同時間同數值）實測會重複出現，這裡去重。
     * @throws 回傳不是預期的 XML 時
     */
    function parsePopup(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
        if (doc.getElementsByTagName('parsererror').length || !doc.getElementsByTagName('MainInfo').length) {
            // 附上診斷：回的是什麼（長度、解析錯誤、開頭片段；數字換成 9，避免帶出識別碼）。看到「格式不符」時才知道是登入頁、錯誤頁還是別的 XML
            const pe = doc.getElementsByTagName('parsererror')[0];
            const shape = (t) => String(t).replace(/\s+/g, ' ').trim().replace(/\d/g, '9').slice(0, 70);
            throw new Error(`體重資料格式不符（長度 ${xmlText.length}；${pe ? '解析錯誤：' + shape(pe.textContent) : '根元素 ' + (doc.documentElement ? doc.documentElement.tagName : '無')}；開頭「${shape(xmlText.slice(0, 70))}」）`);
        }
        if (doc.getElementsByTagName('MainInfo')[0].getAttribute('FieldGroup') !== 'PhysicalWeight') throw new Error('體重資料欄位不符');
        const g = (rc, k) => { const e = rc.getElementsByTagName(k)[0]; return e ? e.textContent.trim() : ''; };
        const seen = new Set(), rows = [];
        let skipped = 0;
        for (const rc of doc.getElementsByTagName('TableRecordContent')) {
            if (g(rc, 'attStatus') !== 'N') { skipped += 1; continue; }
            const m = g(rc, 'attTime').match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/);
            const v = g(rc, 'attValue').match(/^([\d.]+)\s*kg$/i);
            if (!m || !v) { skipped += 1; continue; }
            const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
            const key = ms + '|' + v[1];
            if (seen.has(key)) continue;
            seen.add(key);
            const note = g(rc, 'attNote');
            rows.push({ ms, kg: v[1], note: /^none$/i.test(note) ? '' : note });
        }
        rows.sort((a, b) => a.ms - b.ms);
        return { rows, skipped };
    }

    const api = { popupQuery, parsePopup };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.NTUHWeight = api;
}(typeof window !== 'undefined' ? window : globalThis));
