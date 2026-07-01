// ==UserScript==
// @name         NTUH 護理交班摘要
// @namespace    https://github.com/Twb06/NTUH-helper
// @version      0.1.0
// @description  在護理交班頁面 (OffDutyNurV2.aspx) 擷取飲食、管路、照會，整理成精簡 note 格式
// @match        *://*/*OffDutyNurV2.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/nursing-handover-summary.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/nursing-handover-summary.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ====== 等待表格載入 ======
    function waitForTable(cb) {
        const check = () => {
            const t = document.querySelectorAll('table.queryTableDisplay')[1];
            if (t && t.rows.length >= 8) return cb(t);
            setTimeout(check, 500);
        };
        check();
    }

    // ====== 擷取 cell 內容 ======
    function get(t, row, col) {
        return t.rows[row]?.cells[col]?.innerText?.trim() || '';
    }

    // ====== Diet ======
    function formatDiet(raw) {
        if (!raw) return '（無資料）';
        const s = raw.replace(/\s+/g, ' ');

        if (/管灌|濃度:|熱量:/.test(s)) {
            const supplement = (s.match(/營養品:([^;；]+)/)?.[1] || '').replace(/\s*備註:.*/g, '').trim();
            const details = [];
            const conc = s.match(/濃度:\s*([^熱禁營]+)/)?.[1]?.trim();
            const cal = s.match(/熱量:\s*(\d+)/)?.[1];
            const salt = s.match(/額外加鹽:\s*([^禁營;；]+)/)?.[1]?.trim();
            if (conc) details.push('濃度:' + conc);
            if (cal) details.push('熱量:' + cal);
            if (salt) details.push('加鹽:' + salt);
            let line = supplement || '';
            if (details.length) line += (line ? ', ' : '') + details.join(', ');
            return line || s;
        }

        const dietType = s.match(/^(.+?飲食)/)?.[1]
            || s.match(/^([^-：:]+)/)?.[1]?.trim()
            || s.split(/備註/)[0].trim();
        const allergy = s.match(/對\(\s*(.+?)\s*\)過敏/)?.[1];
        return (allergy ? dietType + ' (過敏: ' + allergy + ')' : dietType) || s;
    }

    // ====== Tubes ======
    const TUBE_SHORT = {
        '鼻胃管': 'NG',
        '導尿管': 'Foley',
        '尿路導管': 'Foley',
        '氣管內管': 'ETT',
        '氣切套管': 'Tracheostomy',
        '中心靜脈導管': 'CVC',
        '動脈導管': 'A-line',
        'PICC': 'PICC',
        'Port-A': 'Port-A',
        '胸管': 'Chest tube',
        '引流管': 'Drain',
        '腹膜透析導管': 'PD catheter',
    };

    // 外層分類名：去掉後讓內層種類名主導 split
    // 「氣切管路，種類：低壓套管」→「氣切:低壓套管，...」
    // 「腸胃道管路，種類：鼻胃管(...)」→「鼻胃管(...)，...」
    function normalizeTubeRaw(s) {
        return s
            .replace(/氣切管路，種類：/g, '氣切:')
            .replace(/腸胃道管路，種類：/g, '');
    }

    // 每條管路以「分類名，種類：」或「氣切:」開頭，用此 pattern split
    // normalizeTubeRaw 已將腸胃道管路/氣切管路預處理，剩下的外層分類名在這裡切
    const TUBE_SPLIT_RE = /(?=(?:血液導管|尿路導管|鼻胃管|導尿管|氣管內管|氣切套管|氣切:|引流管|胸管|腹膜透析導管|PICC|Port-A)[\s，])/;

    function formatTubes(raw) {
        if (!raw) return '（無資料）';
        const entries = normalizeTubeRaw(raw.replace(/\s+/g, ' ')).split(TUBE_SPLIT_RE);

        return entries
            .map(function (e) {
                const s = e.trim();
                if (!s) return null;

                if (/血液導管/.test(s)) {
                    const type = s.match(/種類：([^，]+)/)?.[1] || '';
                    if (/留置針|IV Catheter/i.test(type)) return null;
                    const mapped = /PICC/.test(type) ? 'PICC'
                        : /Port-A/i.test(type) ? 'Port-A'
                        : /中心靜脈|CVC/i.test(type) ? 'CVC'
                        : /動脈|A-line/i.test(type) ? 'A-line'
                        : type;
                    const dm = s.match(/最近更換：(\d{4})\/(\d{2})\/(\d{2})/);
                    const ds = dm ? parseInt(dm[2]) + '/' + parseInt(dm[3]) : '';
                    return mapped + (ds ? ' ' + ds : '');
                }

                const kindMatch = s.match(/^([^，(\s]+)/)?.[1] || '';
                const shortName = TUBE_SHORT[kindMatch] || kindMatch;
                const type = s.match(/種類：([^，]+)/)?.[1] || '';
                const dm = s.match(/最近更換：(\d{4})\/(\d{2})\/(\d{2})/);
                const ds = dm ? parseInt(dm[2]) + '/' + parseInt(dm[3]) : '';

                let line = shortName;

                // 氣切:XXX（已被 normalizeTubeRaw 處理過）
                if (/^氣切:/.test(kindMatch)) {
                    const trachType = kindMatch.replace('氣切:', '').replace(/\(.+?\)/g, '').trim();
                    line = '氣切:' + (trachType || type || '');
                // 尿路導管 / Foley
                } else if (shortName === 'Foley' || kindMatch === '尿路導管') {
                    const foleyType = type.match(/(Two|Three)\s*way/i)?.[0] || '';
                    if (foleyType) line = foleyType + ' ' + shortName;
                } else if (type && shortName !== 'NG') {
                    line += ' (' + type + ')';
                }

                if (ds) line += ' ' + ds;
                return line;
            })
            .filter(Boolean)
            .join('\n');
    }

    // ====== Consult ======
    function formatConsults(raw) {
        if (!raw) return '（無資料）';
        return raw
            .split(/(?=回覆時間:)/)
            .map(function (e) {
                const s = e.replace(/\s+/g, ' ').trim();
                if (!s) return null;
                const dm = s.match(/回覆時間:(\d{4})\/(\d{2})\/(\d{2})/);
                const dateStr = dm ? parseInt(dm[2]) + '/' + parseInt(dm[3]) : '';
                const deptFull = s.match(/回覆時間:\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+([^(（]+)/)?.[1]?.trim()
                    || s.match(/回覆時間:\S+\s+([^(（]+)/)?.[1]?.trim() || '';
                const dept = deptFull.replace(/\(.+?\)/g, '').trim();
                return dateStr + ' ' + dept;
            })
            .filter(Boolean)
            .join('\n');
    }

    // ====== 產生摘要文字 ======
    function buildSummary(t) {
        const dietRaw = get(t, 1, 2);
        const tubeRaw = get(t, 5, 0);
        const consultRaw = get(t, 7, 1);

        return [
            '[Diet]',
            formatDiet(dietRaw),
            '',
            '[Tubes]',
            formatTubes(tubeRaw),
            '',
            '[Consult]',
            formatConsults(consultRaw),
        ].join('\n');
    }

    // ====== UI：右下固定面板 ======
    function createPanel(t) {
        const summary = buildSummary(t);

        const panel = document.createElement('div');
        Object.assign(panel.style, {
            position: 'fixed',
            bottom: '12px',
            right: '12px',
            width: '170px',
            zIndex: '99999',
            background: '#fff',
            border: '2px solid #2563eb',
            borderRadius: '8px',
            boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
            fontFamily: 'monospace',
            fontSize: '12px',
            overflow: 'hidden',
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            padding: '6px 10px',
            background: '#2563eb',
            color: '#fff',
            fontWeight: 'bold',
            fontSize: '13px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
        });
        header.innerHTML = '<span>交班摘要</span>';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = '複製';
        Object.assign(copyBtn.style, {
            background: 'rgba(255,255,255,0.2)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.4)',
            borderRadius: '4px',
            padding: '1px 8px',
            cursor: 'pointer',
            fontSize: '11px',
        });
        copyBtn.addEventListener('click', function () {
            navigator.clipboard.writeText(summary).then(function () {
                copyBtn.textContent = '✅';
                setTimeout(function () { copyBtn.textContent = '複製'; }, 1200);
            });
        });
        header.appendChild(copyBtn);

        const content = document.createElement('pre');
        Object.assign(content.style, {
            margin: '0',
            padding: '8px 10px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: '1.5',
            color: '#1e293b',
            maxHeight: '300px',
            overflowY: 'auto',
        });
        content.textContent = summary;

        panel.appendChild(header);
        panel.appendChild(content);
        document.body.appendChild(panel);
    }

    // ====== 啟動 ======
    waitForTable(createPanel);
})();
