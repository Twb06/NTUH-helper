/* eslint-env node */
// node tools/test-news2.js — NEWS2 核心的自我檢查（無測試框架，失敗即 exit 1）
const assert = require('assert');
const N = require('../scripts/lib/news2.js');

// 官方對照：全正常 = 0
assert.strictEqual(N.scoreNews2({ R: 16, SpO2: 98, onOxygen: false, SBP: 120, P: 70, T: 36.8, gcs: 'E4M6V5' }).total, 0);
// 邊界
assert.strictEqual(N.scoreRR(8), 3); assert.strictEqual(N.scoreRR(9), 1); assert.strictEqual(N.scoreRR(20), 0); assert.strictEqual(N.scoreRR(21), 2); assert.strictEqual(N.scoreRR(25), 3);
assert.strictEqual(N.scoreSpO2(91), 3); assert.strictEqual(N.scoreSpO2(93), 2); assert.strictEqual(N.scoreSpO2(95), 1); assert.strictEqual(N.scoreSpO2(96), 0);
assert.strictEqual(N.scoreSBP(90), 3); assert.strictEqual(N.scoreSBP(100), 2); assert.strictEqual(N.scoreSBP(110), 1); assert.strictEqual(N.scoreSBP(219), 0); assert.strictEqual(N.scoreSBP(220), 3);
assert.strictEqual(N.scoreHR(40), 3); assert.strictEqual(N.scoreHR(50), 1); assert.strictEqual(N.scoreHR(90), 0); assert.strictEqual(N.scoreHR(110), 1); assert.strictEqual(N.scoreHR(130), 2); assert.strictEqual(N.scoreHR(131), 3);
assert.strictEqual(N.scoreTemp(35.0), 3); assert.strictEqual(N.scoreTemp(35.5), 1); assert.strictEqual(N.scoreTemp(36.1), 0); assert.strictEqual(N.scoreTemp(38.0), 0); assert.strictEqual(N.scoreTemp(38.5), 1); assert.strictEqual(N.scoreTemp(39.1), 2);

// 等級：單項 3 分 → low-medium；>=5 medium；>=7 high
let r = N.scoreNews2({ R: 16, SpO2: 98, SBP: 85, P: 70, T: 36.8, gcs: 'E4M6V5' });
assert.strictEqual(r.total, 3); assert.strictEqual(r.level, 'low-medium');
r = N.scoreNews2({ R: 24, SpO2: 92, onOxygen: true, SBP: 100, P: 115, T: 38.5, gcs: 'E4M6V5' });
assert.strictEqual(r.total, 2 + 2 + 2 + 2 + 2 + 1); assert.strictEqual(r.level, 'high');
// 缺項不補零，標 partial
r = N.scoreNews2({ P: 70 });
assert.ok(r.partial && r.missing.includes('RR'));
// GCS 插管 (V=T) 保守判意識改變
assert.strictEqual(N.scoreNews2({ gcs: 'E4M6VT' }).parts.Consciousness, 3);

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
assert.ok(s.series.every((o) => o.news && typeof o.news.total === 'number'));
assert.strictEqual(s.worst.dt, '2026/09/30 02:00');
assert.ok(s.worst.news.total >= 7, 'worst NEWS ' + s.worst.news.total);
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
    const sc = N.scoreNews2(o[0]);
    assert.ok(sc.partial && sc.missing.includes('RR'), 'missing RR must be flagged, not scored 0');
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
