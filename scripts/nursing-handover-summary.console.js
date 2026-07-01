/* eslint-disable no-undef */
// NTUH 護理交班摘要 — console snippet (note 格式)
// 在 OffDutyNurV2.aspx 頁面執行，擷取飲食、管路、照會
(() => {
  const t = document.querySelectorAll('table.queryTableDisplay')[1];
  if (!t) { console.error('找不到交班表格'); return; }

  const get = (row, col) => t.rows[row]?.cells[col]?.innerText?.trim() || '';

  const dietRaw = get(1, 2);
  const tubeRaw = get(5, 0);
  const consultRaw = get(7, 1);

  function formatDiet(raw) {
    if (!raw) return '（無資料）';
    const s = raw.replace(/\s+/g, ' ');

    // 管灌飲食：有營養品/濃度/熱量
    if (/管灌|濃度:|熱量:/.test(s)) {
      const supplement = s.match(/營養品:([^;；]+)/)?.[1]?.trim() || '';
      const details = [];
      const conc = s.match(/濃度:\s*([^熱禁營]+)/)?.[1]?.trim();
      const cal = s.match(/熱量:\s*(\d+)/)?.[1];
      const salt = s.match(/額外加鹽:\s*([^禁營;；]+)/)?.[1]?.trim();
      const contra = s.match(/禁忌:\s*([^;；營]+)/)?.[1]?.trim();
      if (conc) details.push(`濃度:${conc}`);
      if (cal) details.push(`熱量:${cal}`);
      if (salt) details.push(`加鹽:${salt}`);
      if (contra) details.push(`禁忌:${contra}`);
      let line = supplement || '';
      if (details.length) line += (line ? ', ' : '') + details.join(', ');
      return line || s;
    }

    // 一般飲食：取飲食類型（第一個「-」之前），附過敏資訊
    const dietType = s.match(/^(.+?飲食)/)?.[1]
      || s.match(/^([^-：:]+)/)?.[1]?.trim()
      || s.split(/備註/)[0].trim();
    const allergy = s.match(/對\(\s*(.+?)\s*\)過敏/)?.[1];
    return (allergy ? `${dietType} (過敏: ${allergy})` : dietType) || s;
  }

  // ---- Tubes: 精簡格式，忽略 IV catheter ----
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

  function formatTubes(raw) {
    if (!raw) return '（無資料）';
    const entries = raw
      .replace(/\s+/g, ' ')
      .split(/(?=(?:血液導管|中心靜脈導管|動脈導管|尿路導管|鼻胃管|導尿管|尿管|氣管內管|氣切套管|引流管|胸管|腹膜透析導管|PICC|Port-A)[\s，(])/);

    return entries
      .map(e => {
        const s = e.trim();
        if (!s) return null;
        // 血液導管：依種類判斷，留置針忽略，PICC/CVC/Port-A 保留
        if (/血液導管/.test(s)) {
          const type = s.match(/種類：([^，]+)/)?.[1] || '';
          if (/留置針|IV Catheter/i.test(type)) return null;
          // PICC、CVC、Port-A 等從種類提取短名
          const mapped = /PICC/.test(type) ? 'PICC'
            : /Port-A/i.test(type) ? 'Port-A'
            : /中心靜脈|CVC/i.test(type) ? 'CVC'
            : /動脈|A-line/i.test(type) ? 'A-line'
            : type;
          const dateMatch = s.match(/最近更換：(\d{4})\/(\d{2})\/(\d{2})/);
          const dateStr = dateMatch ? `${parseInt(dateMatch[2])}/${parseInt(dateMatch[3])}` : '';
          return `${mapped}${dateStr ? ' ' + dateStr : ''}`;
        }

        const kindMatch = s.match(/^([^，(\s]+)/)?.[1] || '';
        const shortName = TUBE_SHORT[kindMatch] || kindMatch;
        const type = s.match(/種類：([^，]+)/)?.[1] || '';
        const dateMatch = s.match(/最近更換：(\d{4})\/(\d{2})\/(\d{2})/);
        const dateStr = dateMatch ? `${parseInt(dateMatch[2])}/${parseInt(dateMatch[3])}` : '';

        let line = shortName;
        if (type && (shortName === 'Foley' || kindMatch === '尿路導管')) {
          // 顯示 Two way / Three way
          const foleyType = type.match(/(Two|Three)\s*way/i)?.[0] || '';
          if (foleyType) line = `${foleyType} ${shortName}`;
        } else if (type && !['NG'].includes(shortName)) {
          line += ` (${type})`;
        }
        if (dateStr) line += ` ${dateStr}`;
        return line;
      })
      .filter(Boolean)
      .join('\n');
  }

  // ---- Consult: 日期 + 科別名稱（去括號細節）----
  function formatConsults(raw) {
    if (!raw) return '（無資料）';
    return raw
      .split(/(?=回覆時間:)/)
      .map(e => {
        const s = e.replace(/\s+/g, ' ').trim();
        if (!s) return null;
        const dm = s.match(/回覆時間:(\d{4})\/(\d{2})\/(\d{2})/);
        const dateStr = dm ? `${parseInt(dm[2])}/${parseInt(dm[3])}` : '';
        // 科別：跳過「回覆時間:YYYY/MM/DD HH:MM」後取中文科別名
        const deptFull = s.match(/回覆時間:\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}\s+([^(（]+)/)?.[1]?.trim()
          || s.match(/回覆時間:\S+\s+([^(（]+)/)?.[1]?.trim() || '';
        const dept = deptFull.replace(/\(.+?\)/g, '').trim();
        return `${dateStr} ${dept}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  // ---- 輸出 ----
  const output = [
    '[Diet]',
    formatDiet(dietRaw),
    '',
    '[Tubes]',
    formatTubes(tubeRaw),
    '',
    '[Consult]',
    formatConsults(consultRaw),
  ].join('\n');

  console.log(output);
  copy(output);
  console.log('✅ 已複製到剪貼簿');
})();
