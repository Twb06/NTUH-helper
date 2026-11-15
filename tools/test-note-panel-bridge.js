/* eslint-env node */
// Panel bridge contract/behaviour test. Synthetic only, no network, no PHI.
// Run: node tools/test-note-panel-bridge.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── fake document with real EventTarget semantics ────────────────────────
function makeDocument(elements = {}) {
    const listeners = new Map();
    const doc = {
        dispatched: [],
        readyState: 'complete',
        documentElement: { innerHTML: '' },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
        },
        removeEventListener(type, fn) {
            const set = listeners.get(type);
            if (set) set.delete(fn);
        },
        dispatchEvent(event) {
            doc.dispatched.push(event.type);
            const set = listeners.get(event.type);
            if (set) [...set].forEach((fn) => fn(event));
            return true;
        },
        listenerCount(type) {
            return (listeners.get(type) || new Set()).size;
        },
        getElementById: (id) => elements[id] || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => ({ style: {}, dataset: {}, appendChild() {}, addEventListener() {} }),
        head: { appendChild() {} },
        body: { appendChild() {} }
    };
    return doc;
}

const PAGE = 'https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Ward/InsertProgressNoteContent.aspx?SESSION=x';

function loadModule(rel, doc, exportNames) {
    const source = read(rel);
    const entry = source.indexOf("    if (document.readyState === 'loading')");
    assert.ok(entry > 0, rel + ': entry point not found');
    const context = vm.createContext({
        document: doc,
        window: { location: { href: PAGE, search: '?SESSION=x' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
        location: { href: PAGE, search: '?SESSION=x' },
        URLSearchParams,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
        MouseEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init || {}); } },
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        MutationObserver: class { observe() {} disconnect() {} },
        Event: class { constructor(type) { this.type = type; } },
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        fetch: async () => { throw new Error('no network in this test'); }
    });
    vm.runInContext(
        source.slice(0, entry) + '\nglobalThis.api = {' + exportNames.join(', ') + '};\n})();',
        context
    );
    return context.api;
}

async function main() {
    // ── shared document: both scripts see the same DOM/event bus ─────────
    const panel = { style: { display: '' }, dataset: {} };
    const fab = { style: { display: 'flex' }, dataset: {} };
    const left = { style: { display: '' }, dataset: { grabbed: '0' } };
    const procPanel = { style: { display: 'none' }, dataset: {} };
    const procFab = { style: { display: 'flex' }, dataset: {} };
    const doc = makeDocument({
        'ntuh-filler-panel': panel,
        'ntuh-filler-fab': fab,
        'ntuh-handover-left': left,
        'ntuh-procedure-panel': procPanel,
        'ntuh-procedure-fab': procFab
    });

    const readySeen = [];
    doc.addEventListener('ntuh-progress-ready', () => readySeen.push('progress'));
    doc.addEventListener('ntuh-procedure-ready', () => readySeen.push('procedure'));

    const P = loadModule('scripts/progress-note-filler.user.js', doc,
        ['NOTE_PANEL_BRIDGE', 'requestPeerPanel', 'showProgressPanel', 'dispatchBridge',
            'hideOwnFab', 'hidePeerFab', 'showOwnFab']);
    const R = loadModule('scripts/procedure-note-filler.user.js', doc,
        ['NOTE_PANEL_BRIDGE', 'requestPeerPanel', 'openProcedurePanelFromBridge', 'dispatchBridge',
            'hideOwnFab', 'restoreOwnFab']);

    // ── 1. contract: both scripts must use the exact same event names ────
    assert.deepEqual(JSON.parse(JSON.stringify(P.NOTE_PANEL_BRIDGE)), {
        openProgress: 'ntuh-open-progress-panel',
        progressState: 'ntuh-progress-panel-state',
        progressReady: 'ntuh-progress-ready',
        openProcedure: 'ntuh-open-procedure-panel',
        procedureState: 'ntuh-procedure-panel-state',
        procedureReady: 'ntuh-procedure-ready',
        showPanelFab: 'ntuh-show-panel-fab'
    }, 'progress side event names');
    assert.deepEqual(JSON.parse(JSON.stringify(R.NOTE_PANEL_BRIDGE)), JSON.parse(JSON.stringify(P.NOTE_PANEL_BRIDGE)),
        'procedure side must match the progress side byte for byte');

    // ── 2. both announce readiness at load (progress re-announces once for the
    //       FAB handshake, so duplicates are expected) ───────────────────
    assert.ok(readySeen.includes('progress') && readySeen.includes('procedure'),
        'each script broadcasts ready on load');
    assert.ok(doc.listenerCount('ntuh-open-procedure-panel') >= 1, 'procedure listens for open request');
    assert.ok(doc.listenerCount('ntuh-open-progress-panel') >= 1, 'progress listens for open request');
    assert.ok(doc.listenerCount('ntuh-show-panel-fab') >= 1, 'progress listens for the FAB hand-back');

    // ── 3. progress → procedure: opens the peer panel, acks, resolved true
    const openedForward = await P.requestPeerPanel(P.NOTE_PANEL_BRIDGE.openProcedure, P.NOTE_PANEL_BRIDGE.procedureState, 5, 5);
    assert.equal(openedForward, true, 'ack received → true');
    assert.equal(procPanel.style.display, 'flex', 'procedure panel shown');
    assert.equal(procFab.style.display, 'none', 'procedure FAB hidden while panel open');
    assert.ok(doc.dispatched.includes('ntuh-open-procedure-panel'));

    // ── 4. procedure → progress: reverse direction ──────────────────────
    panel.style.display = 'none';
    fab.style.display = 'flex';
    const openedBack = await R.requestPeerPanel(R.NOTE_PANEL_BRIDGE.openProgress, R.NOTE_PANEL_BRIDGE.progressState, 5, 5);
    assert.equal(openedBack, true, 'reverse ack received');
    assert.equal(panel.style.display, 'flex', 'progress panel shown');
    assert.equal(fab.style.display, 'none', 'progress FAB hidden when panel opened from bridge');

    // ── 5. peer missing → resolves false, no throw, no ack loop ─────────
    const lonelyDoc = makeDocument({ 'ntuh-filler-panel': { style: { display: '' }, dataset: {} } });
    const Lonely = loadModule('scripts/progress-note-filler.user.js', lonelyDoc,
        ['NOTE_PANEL_BRIDGE', 'requestPeerPanel']);
    const openedAlone = await Lonely.requestPeerPanel(Lonely.NOTE_PANEL_BRIDGE.openProcedure, Lonely.NOTE_PANEL_BRIDGE.procedureState, 5, 5);
    assert.equal(openedAlone, false, 'no listener → false after retries');
    assert.ok(lonelyDoc.dispatched.filter((t) => t === 'ntuh-open-procedure-panel').length === 3,
        'retries exactly 3 times before giving up');

    // ── 6. bridge ignores detail: always usable inside a sandboxed world ─
    assert.equal(doc.dispatched.every((type) => typeof type === 'string'), true);

    // ── 7. 只裝其中一支：另一邊頁籤淡化，本體照常可用 ───────────────────
    const makeEl = () => {
        const classes = new Set();
        return {
            style: { display: '' }, dataset: {}, title: '', classes,
            classList: {
                add: (c) => classes.add(c),
                remove: (c) => classes.delete(c),
                contains: (c) => classes.has(c)
            }
        };
    };

    const soloPanel = makeEl();
    const soloTab = makeEl();
    const soloDoc = makeDocument({
        'ntuh-filler-panel': soloPanel,
        'ntuh-filler-fab': makeEl(),
        'ntuh-handover-left': makeEl(),
        'ntuh-tab-procedure': soloTab
    });
    const Solo = loadModule('scripts/progress-note-filler.user.js', soloDoc,
        ['NOTE_PANEL_BRIDGE', 'requestPeerPanel', 'showProgressPanel', 'syncProcedureTabState']);

    Solo.syncProcedureTabState();
    assert.equal(soloTab.classes.has('is-missing'), true, 'no peer → tab dimmed');
    assert.ok(/未偵測到 procedure-note-filler/.test(soloTab.title), 'tooltip explains why');
    assert.equal(Solo.showProgressPanel(), true, 'progress panel still works with the peer absent');
    assert.equal(soloPanel.style.display, 'flex');

    soloDoc.dispatchEvent({ type: 'ntuh-procedure-ready' });   // peer loads later
    assert.equal(soloTab.classes.has('is-missing'), false, 'peer ready → tab back to normal');

    // 反向：procedure 單獨安裝
    const procSoloTab = makeEl();
    const procSoloPanel = makeEl();
    const procSoloDoc = makeDocument({
        'ntuh-procedure-panel': procSoloPanel,
        'ntuh-procedure-fab': makeEl(),
        'ntuh-procedure-tab-progress': procSoloTab
    });
    const ProcSolo = loadModule('scripts/procedure-note-filler.user.js', procSoloDoc,
        ['NOTE_PANEL_BRIDGE', 'requestPeerPanel', 'openProcedurePanelFromBridge', 'syncProgressTabState']);

    ProcSolo.syncProgressTabState();
    assert.equal(procSoloTab.classes.has('is-missing'), true, 'procedure alone → progress tab dimmed');
    assert.equal(ProcSolo.openProcedurePanelFromBridge(), true, 'procedure panel still works with the peer absent');
    assert.equal(procSoloPanel.style.display, 'flex');
    procSoloDoc.dispatchEvent({ type: 'ntuh-progress-ready' });
    assert.equal(procSoloTab.classes.has('is-missing'), false);

    // ── 8. FAB 統一：兩支都裝時只有一顆入口（progress），面板開時全部隱藏 ──
    const uniProgFab = { style: { display: 'flex' } };
    const uniProcFab = { style: { display: 'flex' } };
    const uniDoc = makeDocument({
        'ntuh-filler-fab': uniProgFab,
        'ntuh-procedure-fab': uniProcFab,
        'ntuh-filler-panel': makeEl(),
        'ntuh-procedure-panel': makeEl()
    });
    const UP = loadModule('scripts/progress-note-filler.user.js', uniDoc,
        ['NOTE_PANEL_BRIDGE', 'hideOwnFab', 'hidePeerFab', 'showOwnFab', 'showProgressPanel']);
    const UR = loadModule('scripts/procedure-note-filler.user.js', uniDoc,
        ['NOTE_PANEL_BRIDGE', 'hideOwnFab', 'restoreOwnFab']);

    // 兩支都在：procedure 的 FAB 不能露臉（會與 progress 那顆疊在同一格）
    uniDoc.dispatchEvent({ type: 'ntuh-progress-ready' });
    UR.restoreOwnFab();
    assert.equal(uniProcFab.style.display, 'none', 'peer present → procedure FAB stays hidden');

    // 只裝 procedure：自己的 FAB 就是唯一入口
    const soloProcFab = { style: { display: 'none' } };
    const soloOnlyDoc = makeDocument({ 'ntuh-procedure-fab': soloProcFab });
    const SoloR = loadModule('scripts/procedure-note-filler.user.js', soloOnlyDoc,
        ['NOTE_PANEL_BRIDGE', 'restoreOwnFab', 'hideOwnFab']);
    SoloR.restoreOwnFab();
    assert.equal(soloProcFab.style.display, 'flex', 'procedure alone → its FAB is the entry point');

    // 開面板 → 兩顆都收；關 procedure 面板 → 入口交回 progress 的 FAB
    uniProgFab.style.display = 'flex';
    UP.hideOwnFab();
    UP.hidePeerFab();
    assert.equal(uniProgFab.style.display, 'none', 'own FAB hidden while the panel is open');
    assert.equal(uniProcFab.style.display, 'none', 'peer FAB hidden while the panel is open');

    uniDoc.dispatchEvent({ type: 'ntuh-show-panel-fab' });
    assert.equal(uniProgFab.style.display, 'flex', 'closing the procedure panel hands the FAB back to progress');
    assert.equal(uniProcFab.style.display, 'none', 'and the procedure FAB still stays hidden');

    // 幾何：兩顆 FAB 共用同一個右下角位置（不再一高一低）
    const procSrc = read('scripts/procedure-note-filler.user.js');
    const fabRule = procSrc.slice(procSrc.indexOf('#ntuh-procedure-fab {'), procSrc.indexOf('#ntuh-procedure-fab:hover'));
    assert.ok(/bottom:\s*24px;\s*right:\s*24px/.test(fabRule),
        'procedure FAB must sit in the progress FAB slot (bottom/right 24px), got: ' + fabRule.split('\n')[1]);

    console.log('note panel bridge: all assertions passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
