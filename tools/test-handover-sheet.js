/* eslint-env node */
// node tools/test-handover-sheet.js — 交班單切欄與 xlsx 的自我檢查（無測試框架，失敗即 exit 1）
// 指定輸出路徑時另存一份合成資料的 xlsx：node tools/test-handover-sheet.js out.xlsx
const assert = require('assert');
const fs = require('fs');
const H = require('../scripts/lib/handover-sheet.js');

// 全部是合成資料，不放真實病歷
const NOTE = `----------------------[Today's Events]------------------------
11/4
older event
11/5
fell in the bathroom

--------------------------[Plans]-----------------------------
[Problem A]
- keep drug

[預]
- discharge 11/7

------------------------[Diagnosis]---------------------------
[Active]
#. Stroke

------------------------[Assessment]-------------------------
[NE]
Consciousness: E4M6V5

[Cranial nerves]
-CN 7: no facial palsy

[Motor status]
Brunnstrom’s stage:
 RUE: V
Muscle strength:
 RUE: 4/4

Tendon reflex:  R/L
*Elbow flexor:   +++/+++

Babinski’s sign: right/left = -/-,

[Sensation]
-intact

[Functional status]
-Transfer: S

[Barthel index] 65/100
Feeding: 10/10

[Lab]
#. Hemogram
       WBC   Hb
10/23  6.54  11.8
10/24  5.83  11.5
10/26  2.90  11.2
10/29  2.92  11.4
#. Thyroid
       TSH
10/24  0.2680

#. Culture:
[10/24] Influenza PCR +
[10/25] Spu/C: normal flora

[Image]
10/24 CT Brain
  stable

------------------------[Course]------------------------------

After admission stable.

11/4
course line`;

const f = H.parseNoteFields(NOTE);
assert.strictEqual(f.events, '11/5\nfell in the bathroom');
assert.ok(f.diagnosis.includes('#. Stroke') && !f.diagnosis.includes('[NE]'));
assert.ok(f.plans.includes('[預]') && f.plans.includes('discharge 11/7'));

// NE：只留四段，反射／病理反射／CN／感覺都不進來；Barthel 內容同一行
assert.ok(f.ne.includes('Consciousness') && f.ne.includes('Brunnstrom') && f.ne.includes('RUE: 4/4'));
assert.ok(f.ne.includes('-Transfer: S') && f.ne.includes('[Barthel index] 65/100') && f.ne.includes('Feeding'));
['Tendon', 'Babinski', 'Cranial', 'CN 7', 'Sensation'].forEach((w) => assert.ok(!f.ne.includes(w), 'NE 不該有 ' + w));

// Lab：每組留最後 3 列；Culture 的 [日期] 不能把 [Lab] 切斷；Image 接在後面
assert.ok(!f.labImage.includes('10/23  6.54'));
['10/24  5.83', '10/26  2.90', '10/29  2.92', '10/24  0.2680', '[10/24] Influenza', '[10/25] Spu/C', '[Image]', '  stable'].forEach((w) => assert.ok(f.labImage.includes(w), '缺 ' + w));
assert.ok(!f.labImage.includes('course line'));

// 舊 note 沒有子標籤、沒有日期列：不丟例外，Event 回整段
const bare = H.parseNoteFields("-----[Today's Events]-----\nno date here\n-----[Assessment]-----\nfree text\n");
assert.strictEqual(bare.events, 'no date here');
assert.strictEqual(bare.ne, '');
assert.strictEqual(bare.labImage, '');
assert.deepStrictEqual(Object.values(H.parseNoteFields('')).join(''), '');

// HIS 的 date.js 覆寫（LESSONS §0）：產生 xlsx 不可依賴 Date
const realNow = Date.now, realToString = Date.prototype.toString;
Date.now = () => new Date();
Date.prototype.toString = function () { throw new Error('date.js toString'); };
const entry = (bed, chartNo, extra = {}) => ({
    banner: `測試${bed} (女 50歲)`, bed, chartNo, admit: '2026/10/01', diagnosis: f.diagnosis, event: f.events,
    labImage: f.labImage, ne: f.ne, rx: 'DrugA  500mg  BID  PO  10/29-\nDrugB  2g     Q8H  IV  10/24-', plans: f.plans, ...extra,
});
const entries = [entry('08C-10-01', 'T000002'), entry('08C-02-01', 'T000001'), entry('08C-11-01', 'T000003', { plans: 'a<b & "c"\u0007' })];
const { bytes, warnings } = H.buildXlsx(entries);
Date.now = realNow; Date.prototype.toString = realToString;
assert.deepStrictEqual(warnings, []);
assert.strictEqual(String.fromCharCode(bytes[0], bytes[1]), 'PK');

// 床號自然排序：02 < 10 < 11
assert.deepStrictEqual(H.sortEntries(entries).map((e) => e.chartNo), ['T000001', 'T000002', 'T000003']);

// 放不下一定要回警告，不能靜默截斷
const huge = H.buildXlsx([entry('08C-01-01', 'T000009', { diagnosis: 'long line of text\n'.repeat(400) })]);
assert.ok(huge.warnings.some((w) => w.includes('Diagnosis')), JSON.stringify(huge.warnings));

const out = process.argv[2];
if (out) fs.writeFileSync(out, bytes);
console.log('test-handover-sheet: all passed');
