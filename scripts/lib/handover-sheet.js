// ==============================================================
// 交班單（純函式，不碰 DOM／網路／localStorage）
// --------------------------------------------------------------
// 兩件事：
//   1. parseNoteFields：把 primary note 切成交班單各欄
//   2. buildXlsx：把多位病人輸出成 .xlsx（橫向 A4，每人一頁）
//
// 不用 ExcelJS：@require 會在每一個 progress 頁載入（約 1MB），而這裡只需要純文字格＋列印設定；
// 手寫的 xlsx 就是幾個 XML 打包成 zip（不壓縮），也避開 HIS 的 date.js 覆寫 Date 對第三方函式庫的影響。
//
// 用法（Tampermonkey）：
//   // @require https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lib/handover-sheet.js
//   之後用 window.NTUHHandover；node 測試則 require('./handover-sheet.js')。
//
// =============================================================

/* global module */
(function (root) {
    'use strict';

    // ─── primary note 切欄 ─────────────────────────────────────
    // Assessment 內的子標籤用白名單：[Lab] 的 Culture 有「[10/24] Influenza PCR +」這種列，
    // [Barthel index] 又把內容寫在同一行，靠形狀判斷都會切錯。
    const SUB_LABELS = ['NE', 'Cranial nerves', 'Motor status', 'Sensation', 'Coordination & Balance', 'Sphincter', 'Functional status', 'Barthel index', 'Lab', 'Image'];
    const LAB_KEEP_DAYS = 3;
    const MOTOR_END_RE = /^\s*\*?(Tendon reflex|Spasticity|Babinski|Hoffmann|Ankle clonus)/i;

    function getSection(text, label) {
        const escaped = label.replace(/['’]/g, "[’']");
        const m = text.match(new RegExp(`-*\\s*\\[${escaped}\\]\\s*-*\\n([\\s\\S]*?)(?=\\n*-{5,}\\[|$)`, 'i'));
        return m ? m[1].trim() : '';
    }

    function assessmentBlocks(assessment) {
        const blocks = {};
        let current = null;
        for (const line of assessment.split('\n')) {
            const label = line.match(/^\[([^\]]+)\]/)?.[1].trim().toLowerCase();
            const known = label && SUB_LABELS.find((l) => l.toLowerCase() === label);
            if (known) {
                current = known;
                blocks[current] = [line];
            } else if (current) {
                blocks[current].push(line);
            }
        }
        Object.keys(blocks).forEach((k) => { blocks[k] = blocks[k].join('\n').trim(); });
        return blocks;
    }

    // [Motor status] 只留 Brunnstrom／肌力，反射、痙攣、病理反射不進交班單
    function motorSummary(block) {
        const lines = block.split('\n');
        const end = lines.findIndex((l) => MOTOR_END_RE.test(l));
        return (end < 0 ? lines : lines.slice(0, end)).join('\n').trim();
    }

    // 每個 panel 留表頭＋最後 N 列（note 內由舊到新）；Culture 不是「日期開頭」的列，全留
    function trimLab(block, keep = LAB_KEEP_DAYS) {
        const lines = block.split('\n');
        const isRow = (l) => /^\d{1,2}\/\d{1,2}\s/.test(l);
        const out = [];
        for (let i = 0; i < lines.length;) {
            if (isRow(lines[i])) {
                let j = i;
                while (j < lines.length && isRow(lines[j])) j++;
                out.push(...lines.slice(Math.max(i, j - keep), j));
                i = j;
            } else {
                if (lines[i].trim()) out.push(lines[i]);
                i++;
            }
        }
        return out.join('\n');
    }

    // [Today's Events] 最後一天那段；沒有日期列就回整段
    function latestEvents(raw) {
        const lines = raw.split('\n');
        let start = -1;
        lines.forEach((l, i) => { if (/^\d{1,2}\/\d{1,2}\s*$/.test(l.trim())) start = i; });
        return (start < 0 ? raw : lines.slice(start).join('\n')).trim();
    }

    function parseNoteFields(text) {
        const note = String(text || '').replace(/\r\n?/g, '\n');
        const a = assessmentBlocks(getSection(note, 'Assessment'));
        const join = (parts) => parts.filter(Boolean).join('\n\n');
        return {
            diagnosis: getSection(note, 'Diagnosis'),
            events: latestEvents(getSection(note, "Today's Events")),
            labImage: join([a.Lab && trimLab(a.Lab), a.Image]),
            ne: join([a.NE, a['Motor status'] && motorSummary(a['Motor status']), a['Functional status'], a['Barthel index']]),
            plans: getSection(note, 'Plans'),
        };
    }

    // ─── 版面 ─────────────────────────────────────────────────
    // Excel 單列高度上限 409pt，所以每位病人佔 PATIENT_ROWS 列再垂直合併。
    // 不用「配合頁寬」：官方文件說 fit-to 模式可能忽略手動分頁，所以用固定 SCALE，欄寬總和要印得下橫向 A4。
    const SCALE = 72;
    const PATIENT_ROWS = 2;
    const ROW_HEIGHT = 345;       // pt；兩列 690pt × 72% ≈ 497pt，橫向 A4 可印高約 552pt（含表頭列）
    const HEADER_HEIGHT = 20;
    const MIN_SIZE = 6;
    const CELL_LIMIT = 32767;     // Excel 單格字數上限
    const COLUMNS = [
        { key: 'patient', title: '病人資訊', width: 11, size: 10 },
        { key: 'admit', title: '入院時間', width: 11, size: 10 },
        { key: 'diagnosis', title: 'Diagnosis', width: 25, size: 10 },
        { key: 'event', title: 'Event', width: 19, size: 10 },
        { key: 'labImage', title: 'Lab/Image', width: 44, size: 9, mono: true },
        { key: 'ne', title: 'NE', width: 30, size: 9, mono: true },
        { key: 'rx', title: 'Medications', width: 30, size: 9, mono: true },
        { key: 'plans', title: '特別交班', width: 30, size: 10 },
    ];
    const SHEET_FONT = 'Microsoft JhengHei';
    const MONO_FONT = 'Consolas';

    // 欄寬（字元）→ pt：Excel 以預設字型 Calibri 11 計，每字元 7px、另加 5px 內距
    const columnPt = (width) => (width * 7 + 5) * 0.75;

    function textWidth(line, size, mono) {
        let w = 0;
        for (const ch of line) {
            const wide = ch.codePointAt(0) > 0x2E7F;
            w += wide ? size : size * (mono ? 0.55 : 0.52);
        }
        return w;
    }

    // 估算需要的高度（pt），實際換行由 Excel 決定，所以估得保守一點
    function estimateHeight(text, col, size) {
        const usable = columnPt(col.width) * 0.94;
        const lines = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(textWidth(l, size, col.mono) / usable)), 0);
        return lines * size * 1.35;
    }

    // 超出一頁就逐步縮字；縮到底還放不下回 overflow，由呼叫端提醒使用者
    function fitCell(text, col) {
        const height = PATIENT_ROWS * ROW_HEIGHT;
        for (let size = col.size; size >= MIN_SIZE; size -= 0.5) {
            if (estimateHeight(text, col, size) <= height) return { size, overflow: false };
        }
        return { size: MIN_SIZE, overflow: true };
    }

    function patientCell(e) {
        return [e.banner, e.bed && `床 ${e.bed}`, e.chartNo && `病歷號 ${e.chartNo}`].filter(Boolean).join('\n');
    }

    function sortEntries(entries) {
        return [...entries].sort((a, b) => String(a.bed || '').localeCompare(String(b.bed || ''), 'en', { numeric: true }));
    }

    // ─── xlsx XML ─────────────────────────────────────────────
    const xmlEscape = (s) => String(s === null || s === undefined ? '' : s)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
        .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

    const colName = (i) => String.fromCharCode(65 + i);

    function stylesXml(fonts) {
        // fonts[0] 必須是 Calibri 11：Excel 用它決定欄寬單位。cellXfs 0 預設、1 表頭、2 起對應 fonts[2..]
        const fontXml = fonts.map((f) => `<font>${f.bold ? '<b/>' : ''}<sz val="${f.size}"/><name val="${xmlEscape(f.name)}"/></font>`).join('');
        const xfs = fonts.map((f, i) => {
            if (i === 0) return '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
            if (i === 1) return '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>';
            return `<xf numFmtId="0" fontId="${i}" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>`;
        }).join('');
        const side = (n) => `<${n} style="thin"><color rgb="FF888888"/></${n}>`;
        return XML_HEAD + `<styleSheet xmlns="${MAIN_NS}">`
            + `<fonts count="${fonts.length}">${fontXml}</fonts>`
            + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFDDE6F0"/></patternFill></fill></fills>'
            + `<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>${side('left')}${side('right')}${side('top')}${side('bottom')}<diagonal/></border></borders>`
            + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            + `<cellXfs count="${fonts.length}">${xfs}</cellXfs>`
            + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
            + '</styleSheet>';
    }

    function buildSheet(entries) {
        const fonts = [{ name: 'Calibri', size: 11 }, { name: SHEET_FONT, size: 10, bold: true }];
        const styleOf = (name, size) => {
            let i = fonts.findIndex((f, n) => n >= 2 && f.name === name && f.size === size);
            if (i < 0) i = fonts.push({ name, size }) - 1;
            return i;
        };
        const warnings = [];
        const cell = (ref, s, text) => (text === null
            ? `<c r="${ref}" s="${s}"/>`
            : `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`);

        const rows = [`<row r="1" ht="${HEADER_HEIGHT}" customHeight="1">${COLUMNS.map((c, i) => cell(`${colName(i)}1`, 1, c.title)).join('')}</row>`];
        const merges = [];
        const breaks = [];
        sortEntries(entries).forEach((e, n) => {
            const top = 2 + n * PATIENT_ROWS;
            const bottom = top + PATIENT_ROWS - 1;
            const who = e.bed || e.chartNo || `第 ${n + 1} 位`;
            const values = COLUMNS.map((c) => {
                let text = String((c.key === 'patient' ? patientCell(e) : e[c.key]) || '');
                if (text.length > CELL_LIMIT) {
                    text = text.slice(0, CELL_LIMIT);
                    warnings.push(`${who} 的 ${c.title} 太長，已截斷`);
                }
                const fit = fitCell(text, c);
                if (fit.overflow) warnings.push(`${who} 的 ${c.title} 可能超出一頁，請檢查`);
                return { text, s: styleOf(c.mono ? MONO_FONT : SHEET_FONT, fit.size) };
            });
            rows.push(`<row r="${top}" ht="${ROW_HEIGHT}" customHeight="1">${values.map((v, i) => cell(`${colName(i)}${top}`, v.s, v.text)).join('')}</row>`);
            for (let r = top + 1; r <= bottom; r++) {
                rows.push(`<row r="${r}" ht="${ROW_HEIGHT}" customHeight="1">${values.map((v, i) => cell(`${colName(i)}${r}`, v.s, null)).join('')}</row>`);
            }
            COLUMNS.forEach((c, i) => merges.push(`<mergeCell ref="${colName(i)}${top}:${colName(i)}${bottom}"/>`));
            if (n < entries.length - 1) breaks.push(`<brk id="${bottom}" max="16383" man="1"/>`);
        });

        const lastRow = 1 + entries.length * PATIENT_ROWS;
        const lastCol = colName(COLUMNS.length - 1);
        const xml = XML_HEAD + `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">`
            + `<dimension ref="A1:${lastCol}${lastRow}"/>`
            + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            + '<sheetFormatPr defaultRowHeight="15"/>'
            + `<cols>${COLUMNS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>`
            + `<sheetData>${rows.join('')}</sheetData>`
            + (merges.length ? `<mergeCells count="${merges.length}">${merges.join('')}</mergeCells>` : '')
            + '<pageMargins left="0.25" right="0.25" top="0.3" bottom="0.3" header="0.15" footer="0.15"/>'
            + `<pageSetup paperSize="9" scale="${SCALE}" orientation="landscape"/>`
            + (breaks.length ? `<rowBreaks count="${breaks.length}" manualBreakCount="${breaks.length}">${breaks.join('')}</rowBreaks>` : '')
            + '</worksheet>';
        return { xml, fonts, warnings };
    }

    // ─── zip（只打包不壓縮，xlsx 規格允許）───────────────────────
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    function zipStore(files) {
        const enc = new TextEncoder();
        const le = (v, n) => Array.from({ length: n }, (_, i) => (v >>> (8 * i)) & 0xFF);
        const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;  // 固定日期，內容相同就產生相同檔案
        const chunks = [];
        const central = [];
        let offset = 0;
        for (const { name, content } of files) {
            const nameBytes = enc.encode(name);
            const data = enc.encode(content);
            const crc = crc32(data);
            const common = [...le(20, 2), ...le(0x0800, 2), ...le(0, 2), ...le(0, 2), ...le(DOS_DATE, 2), ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(nameBytes.length, 2), ...le(0, 2)];
            const local = Uint8Array.from([...le(0x04034B50, 4), ...common, ...nameBytes]);
            chunks.push(local, data);
            central.push(Uint8Array.from([...le(0x02014B50, 4), ...le(20, 2), ...common, ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...nameBytes]));
            offset += local.length + data.length;
        }
        const centralSize = central.reduce((n, c) => n + c.length, 0);
        const end = Uint8Array.from([...le(0x06054B50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2), ...le(centralSize, 4), ...le(offset, 4), ...le(0, 2)]);
        const all = [...chunks, ...central, end];
        const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of all) { out.set(c, at); at += c.length; }
        return out;
    }

    function buildXlsx(entries) {
        const { xml, fonts, warnings } = buildSheet(entries);
        const printTitles = "'交班單'!$1:$1";
        const files = [
            { name: '[Content_Types].xml', content: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
            { name: '_rels/.rels', content: XML_HEAD + `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
            { name: 'xl/workbook.xml', content: XML_HEAD + `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="交班單" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">${printTitles}</definedName></definedNames></workbook>` },
            { name: 'xl/_rels/workbook.xml.rels', content: XML_HEAD + `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>` },
            { name: 'xl/styles.xml', content: stylesXml(fonts) },
            { name: 'xl/worksheets/sheet1.xml', content: xml },
        ];
        return { bytes: zipStore(files), warnings };
    }

    const api = { parseNoteFields, trimLab, buildXlsx, sortEntries };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.NTUHHandover = api;
})(typeof window !== 'undefined' ? window : this);
