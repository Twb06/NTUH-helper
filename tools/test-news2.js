/* eslint-env node */
// node tools/test-news2.js — vitalsign 解析的自我檢查（無測試框架，失敗即 exit 1）
const assert = require('assert');
const N = require('../scripts/lib/news2.js');

// 解析 + 合併：TPR 與 BP 差 5 分鐘 → 同一組；SpO2 room air vs NC
const rows = [
    '2026/09/30 02:00 T:38.6 P:118 R:24',
    '2026/09/30 02:05 BP:92/50',
    '2026/09/30 02:06 SpO2:93%(28%,3L,Nasal Cannula)',
    '2026/09/29 20:00 T:36.7 P:80 R:18',
    '2026/09/29 20:02 BP:128/76',
    '2026/09/29 20:02 SpO2:98%()',
    '2026/09/30 05:00 GCS: E4M6V5',
    '雜訊列沒有時間',
];
const obs = N.parseVitalRows(rows);
assert.strictEqual(obs.length, 3, 'clusters: ' + obs.length);
assert.strictEqual(obs[1].SBP, 92); assert.strictEqual(obs[1].onOxygen, true);
assert.strictEqual(obs[0].onOxygen, false);

const now = new Date(2026, 8, 30, 7, 0).getTime();
const w = N.overnightWindow(now);
const s = N.summarizeWindow(obs, w.fromMs, w.toMs);
assert.strictEqual(s.count, 3);
assert.strictEqual(s.series.length, 3);
assert.ok(s.flags.some((f) => f.startsWith('發燒')) && s.flags.some((f) => f.startsWith('低血壓')));

// 時間窗內完全無資料要明確標 noData，不能當成正常
assert.strictEqual(N.summarizeWindow(obs, now, now + 1).noData, true);
console.log('news2: all tests passed');

// ── 實測格式（來自真實回傳的 Content 欄，數值已改成合成）──
{
    const real = [
        '2026/09/30 06:40 SpO2:96%(%,L,)',            // room air 實測格式
        '2026/09/30 06:40 T:36.8 P:65 R:18',
        '2026/09/30 06:40 BP:111/56',
        '2026/09/29 13:23 T:37.1 P:84 R:',            // R 常缺，不能連 T/P 一起丟
        '2026/09/29 13:23 BP:112/74',
        '2026/09/29 09:04 Pain score:0',
        'U/O:0',                                      // 無日期
        '0001/01/01 00:00 T: P:80 R:',                // 佔位列
        '0001/01/01 00:00 T: P:73 R:',
    ];
    const o = N.parseVitalRows(real);
    assert.strictEqual(o.length, 2, 'placeholder/undated rows must be dropped, got ' + o.length);
    assert.strictEqual(o[0].T, 37.1); assert.strictEqual(o[0].P, 84); assert.strictEqual(o[0].R, undefined);
    assert.strictEqual(o[1].onOxygen, false, 'room air "%,L," must not count as oxygen');
    assert.strictEqual(N.isOnOxygen('28%,5L,Mask'), true);
    assert.strictEqual(N.isOnOxygen('%,3L,Nasal Cannula'), true);
    assert.strictEqual(N.isOnOxygen('%,L,'), false);
    assert.strictEqual(N.isOnOxygen(''), false);
}
console.log('news2: real-format tests passed');

// NA 標記：缺值要記下來；同組內補上值則作廢
{
    const o = N.parseVitalRows(['2026/09/29 13:23 T:37.1 P:84 R:', '2026/09/29 13:23 BP:112/74']);
    assert.strictEqual(o[0].naR, true); assert.strictEqual(o[0].naT, undefined); assert.strictEqual(o[0].DBP, 74);
    const m = N.parseVitalRows(['2026/09/29 13:23 T: P:80 R:', '2026/09/29 13:30 T:36.9 P:80 R:18']);
    assert.strictEqual(m.length, 1); assert.strictEqual(m[0].T, 36.9); assert.strictEqual(m[0].naT, undefined);
}
console.log('news2: NA-flag tests passed');

// 尿量：實測 U/O 列常無日期；有日期取最新
{
    assert.deepStrictEqual(N.parseUo(['U/O:0', '2026/09/29 13:23 T:37.1 P:84 R:']), { ms: null, val: 0 });
    const d = N.parseUo(['U/O:250', '2026/09/29 06:00 U/O:300', '2026/09/30 06:00 U/O:120']);
    assert.strictEqual(d.val, 120); assert.ok(d.ms > 0);
    assert.strictEqual(N.parseUo(['T:37 P:80 R:18']), null);
}
// 給氧變化
{
    const mk = (o) => N.parseVitalRows(o);
    const ser = (rows) => N.parseVitalRows(rows);
    const room = (t) => `2026/09/29 ${t} SpO2:97%(%,L,)`;
    const nc = (t, l) => `2026/09/29 ${t} SpO2:93%(28%,${l}L,Nasal Cannula)`;
    assert.strictEqual(N.o2Change(ser([room('18:00'), room('21:00')])), null);                      // 全程室內空氣
    let c = N.o2Change(ser([room('18:00'), nc('21:00', 3), nc('23:30', 3)]));
    assert.strictEqual(c.kind, 'new'); assert.ok(c.text.includes('NC 3L'));
    c = N.o2Change(ser([room('18:00'), nc('21:00', 3), room('23:30')])); assert.strictEqual(c.kind, 'transient');
    c = N.o2Change(ser([nc('18:00', 3), room('23:30')])); assert.strictEqual(c.kind, 'off');
    c = N.o2Change(ser([nc('18:00', 3), nc('23:30', 5)])); assert.strictEqual(c.kind, 'up'); assert.ok(c.text.includes('3→5'));
    c = N.o2Change(ser([nc('18:00', 5), nc('23:30', 3)])); assert.strictEqual(c.kind, 'down');
    c = N.o2Change(ser([nc('18:00', 3), nc('23:30', 3)])); assert.strictEqual(c.kind, 'on');
    assert.strictEqual(N.o2Change([]), null); assert.strictEqual(N.o2Change(mk(['2026/09/29 18:00 T:36.5 P:70 R:16'])), null); // 沒有 SpO2
    assert.strictEqual(N.oxygenInfo('%,L,').flow, null);
}
console.log('news2: UO / O2 tests passed');

