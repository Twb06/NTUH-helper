// ==UserScript==
// @name         NTUH 藥歷圖抗生素整理器
// @namespace    https://github.com/your-username/chart-antibiotic-extractor
// @version      1.2.5
// @description  讀取藥歷圖 (Chart.aspx) 的 TradeNameGroupsOfEachDrug，整理成「商品名 起日-迄日」，迄日為今天或未來則留破折號
// @match        *://*/*Chart.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/chart-antibiotic.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/chart-antibiotic.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ====== 攔截/取得藥物資料 ======
    // TradeNameGroupsOfEachDrug 是頁面全域，但要等 postback 後才有值。
    // 我們輪詢等它出現，再啟用按鈕。
    let capturedData = null;

    // eslint-disable-next-line no-unused-vars
    const poll = setInterval(() => {
        const d = window.TradeNameGroupsOfEachDrug;
        if (Array.isArray(d) && d.length > 0) {
            capturedData = d;
            // 不停掉輪詢——使用者可能切換時間範圍重新載入資料，
            // 每次都更新 capturedData 為最新。
        }
    }, 500);

    // ====== 日期工具 ======

    // 把 "05/23 23" 或 "05/23" 取出 {month, day}
    function parseMMDD(str) {
        if (!str) return null;
        const datePart = str.trim().split(' ')[0]; // 去掉時
        const parts = datePart.split('/');
        if (parts.length !== 2) return null;
        return { month: parseInt(parts[0], 10), day: parseInt(parts[1], 10), text: datePart };
    }

    // 依「今天」推測某個 MM/DD 屬於哪一年，回傳 Date 物件
    // 邏輯：若該月份比今天月份大很多(>6個月)，視為去年；否則今年。
    function inferDate(md) {
        if (!md) return null;
        const now = new Date();
        const curMonth = now.getMonth() + 1;
        let year = now.getFullYear();
        if (md.month - curMonth > 6) {
            year -= 1; // 例如今天1月、迄日12月 → 去年
        } else if (curMonth - md.month > 6) {
            year += 1; // 例如今天12月、迄日1月 → 明年(跨年住院)
        }
        return new Date(year, md.month - 1, md.day);
    }

    // 判斷迄日是否為今天或未來
    function isTodayOrFuture(md) {
        const d = inferDate(md);
        if (!d) return false;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        d.setHours(0, 0, 0, 0);
        return d.getTime() >= today.getTime();
    }

    // ====== 商品名清理：只留第一個字 ======
    // "Unasyn (based on ampicillin content) 1000 mg/vial" → "Unasyn"
    // "TARGOCID 200 mg/vial" → "TARGOCID"
    function cleanTradeName(complex) {
        if (!complex) return '';
        return complex.trim().split(/\s+/)[0];
    }

    // ====== 主整理邏輯 ======
    function buildResults() {
        if (!capturedData) return null;

        // 用 Map 以「清理後商品名」為 key 合併
        const merged = new Map();

        capturedData.forEach(group => {
            // group 是 [{ Key, Value }]
            group.forEach(item => {
                const orders = item.Value || [];
                orders.forEach(o => {
                    const trade = cleanTradeName(o.TradeEngNameComplex || item.Key);
                    let start = parseMMDD(o.StartTimeString);
                    let end = parseMMDD(o.EndTimeString);
                    if (!trade) return;

                    // 外院雲端藥(PatientClassName='雲')通常沒有 EndTimeString，
                    // 但有 StartTime 時間戳 + UseDays。
                    // 用這兩個推算出迄日：迄日 = 起日 + UseDays - 1。
                    if (!end && o.UseDays > 0 && o.StartTime) {
                        const tsMatch = String(o.StartTime).match(/\d+/);
                        if (tsMatch) {
                            const startTs = parseInt(tsMatch[0], 10);
                            const endTs = startTs + (o.UseDays - 1) * 86400000;
                            const endDate = new Date(endTs);
                            const mm = String(endDate.getMonth() + 1).padStart(2, '0');
                            const dd = String(endDate.getDate()).padStart(2, '0');
                            end = parseMMDD(`${mm}/${dd}`);
                        }
                    }

                    if (!merged.has(trade)) {
                        merged.set(trade, { trade, starts: [], ends: [], orders: [] });
                    }
                    const e = merged.get(trade);
                    if (start) e.starts.push(start);
                    if (end) e.ends.push(end);
                    // endOngoing：有推算迄日的就看迄日；真的沒迄日才視為進行中
                    const endOngoing = !end || isTodayOrFuture(end);
                    e.orders.push({
                        start,
                        end,
                        startKey: start ? inferDate(start).getTime() : 0,
                        endOngoing,
                        dose: o.OrderDose || '',
                        unit: o.DoseUnit || '',
                        route: o.RouteCode || '',
                        freq: o.RepeatPatternCode || '',
                        patientClass: (o.PatientClassName || '').trim()
                    });
                });
            });
        });

        // 整理每筆，分流成「進行中」與「已停用」兩組
        const ongoing = [];
        const stopped = [];
        merged.forEach(e => {
            // 起日取最早
            const earliest = e.starts.slice().sort((a, b) =>
                inferDate(a) - inferDate(b))[0];
            // 迄日取最晚
            const latest = e.ends.slice().sort((a, b) =>
                inferDate(b) - inferDate(a))[0];

            const startKey = earliest ? inferDate(earliest).getTime() : 0;
            const endKey = latest ? inferDate(latest).getTime() : 0;

            // 劑量頻率：優先取「仍進行中」的 order(迄日今天或未來)中起日最晚的，
            // 這樣可避免「STAT 起日比 Q6H 晚但已打完」搶到顯示位的問題。
            // 若沒有進行中的 order(整支藥已停)，才 fallback 到所有 order 中起日最晚的。
            const sortByStartDesc = (a, b) => b.startKey - a.startKey;
            const ongoingOrders = e.orders.filter(o => o.endOngoing).sort(sortByStartDesc);
            const newest = ongoingOrders[0] || e.orders.slice().sort(sortByStartDesc)[0];
            const regimen = newest
                ? [`${newest.dose}${newest.unit}`, newest.route, newest.freq]
                    .filter(Boolean).join(' ')
                : '';

            // 病人類別：彙整去重，保留出現順序
            const classes = [];
            e.orders.forEach(o => {
                if (o.patientClass && !classes.includes(o.patientClass)) {
                    classes.push(o.patientClass);
                }
            });
            const classLabel = classes.length ? `(${classes.join('/')})` : '';

            // 進行中條件：只要有任何一筆 order 的 endOngoing=true，整藥就算進行中。
            // 不靠 latest 判斷，因為空迄日不會進 e.ends，latest 可能是已停的那筆。
            const isOngoing = e.orders.some(o => o.endOngoing);

            if (isOngoing) {
                // 進行中：range 一律留破折號，並算療程天數(起日當天=Day 1，算到今天)
                let dayLabel = '';
                if (earliest) {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    const s = inferDate(earliest); s.setHours(0, 0, 0, 0);
                    const days = Math.floor((today - s) / 86400000) + 1;
                    if (days >= 1) dayLabel = `D${days}`;
                }
                ongoing.push({
                    trade: e.trade,
                    regimen,
                    classLabel,
                    range: `${earliest ? earliest.text : ''}-`,
                    dayLabel,
                    startKey,
                    endKey
                });
            } else {
                stopped.push({
                    trade: e.trade,
                    regimen,
                    classLabel,
                    range: `${earliest ? earliest.text : ''}-${latest ? latest.text : ''}`,
                    dayLabel: '', // 已停用不算天數
                    startKey,
                    endKey
                });
            }
        });

        // 進行中組：依起日(晚的在上)，起日相同再依迄日(晚的在上)
        ongoing.sort((a, b) => (b.startKey - a.startKey) || (b.endKey - a.endKey));
        // 已停用組：先依迄日(晚的在上)，迄日相同再依起日(晚的在上)
        stopped.sort((a, b) => (b.endKey - a.endKey) || (b.startKey - a.startKey));

        return { ongoing, stopped };
    }

    // ====== 格式化(對齊) ======
    function formatOutput(grouped) {
        if (!grouped) return '(未找到藥物資料，請先在頁面上載入藥歷圖)';
        const { ongoing, stopped } = grouped;
        if (ongoing.length === 0 && stopped.length === 0) {
            return '(未找到藥物資料，請先在頁面上載入藥歷圖)';
        }

        const all = ongoing.concat(stopped);
        // 各欄位分別算對齊寬度
        const wTrade = Math.max(...all.map(r => r.trade.length));
        const wRegimen = Math.max(...all.map(r => r.regimen.length));
        const wClass = Math.max(...all.map(r => r.classLabel.length));

        const line = r => {
            const parts = [
                r.trade.padEnd(wTrade + 2),
                r.regimen.padEnd(wRegimen + 2),
                r.classLabel.padEnd(wClass + 1),
                r.range
            ];
            let s = parts.join('');
            if (r.dayLabel) s += ' ' + r.dayLabel;
            return s;
        };

        const blocks = [];
        if (ongoing.length > 0) blocks.push(ongoing.map(line).join('\n'));
        if (ongoing.length > 0 && stopped.length > 0) blocks.push('-----------');
        if (stopped.length > 0) blocks.push(stopped.map(line).join('\n'));

        return blocks.join('\n');
    }

    // ====== UI ======
    function showResult(text) {
        const old = document.getElementById('chart-abx-box');
        if (old) old.remove();

        const box = document.createElement('div');
        box.id = 'chart-abx-box';
        box.style.cssText = `position:fixed;top:80px;right:20px;z-index:999999;
            background:#fff;border:2px solid #507CD1;border-radius:6px;
            box-shadow:0 4px 16px rgba(0,0,0,.25);padding:12px;width:340px;`;

        const title = document.createElement('div');
        title.textContent = '抗生素藥歷';
        title.style.cssText = 'font-weight:bold;margin-bottom:8px;color:#507CD1;font-family:sans-serif;';

        const ta = document.createElement('textarea');
        ta.value = text;
        ta.readOnly = true;
        ta.style.cssText = 'width:100%;height:180px;font-family:Consolas,monospace;font-size:13px;white-space:pre;box-sizing:border-box;';

        const row = document.createElement('div');
        row.style.cssText = 'margin-top:8px;text-align:right;font-family:sans-serif;';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '複製';
        copyBtn.style.cssText = 'margin-right:8px;padding:4px 12px;cursor:pointer;';
        copyBtn.onclick = () => {
            ta.select();
            navigator.clipboard.writeText(ta.value).then(
                () => { copyBtn.textContent = '已複製 ✓'; setTimeout(() => copyBtn.textContent = '複製', 1500); },
                () => { document.execCommand('copy'); copyBtn.textContent = '已複製 ✓'; }
            );
        };

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '關閉';
        closeBtn.style.cssText = 'padding:4px 12px;cursor:pointer;';
        closeBtn.onclick = () => box.remove();

        row.appendChild(copyBtn);
        row.appendChild(closeBtn);
        box.appendChild(title);
        box.appendChild(ta);
        box.appendChild(row);
        document.body.appendChild(box);
    }

    function addButton() {
        if (!document.body) { setTimeout(addButton, 100); return; }
        const btn = document.createElement('button');
        btn.textContent = '整理抗生素';
        btn.style.cssText = `position:fixed;top:50px;right:20px;z-index:999999;
            padding:6px 14px;background:#507CD1;color:#fff;border:none;
            border-radius:4px;cursor:pointer;font-family:sans-serif;font-weight:bold;`;
        btn.onclick = () => {
            const grouped = buildResults();
            showResult(formatOutput(grouped));
        };
        document.body.appendChild(btn);
    }

    addButton();
})();
