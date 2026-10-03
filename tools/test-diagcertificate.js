/* eslint-env node */
// Synthetic fixtures only: no patient data or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../scripts/NTUH-diagcertificate-filler.user.js'), 'utf8');
const elements = new Map();
const timers = [];
let table;
let opRows = [];
let scheduleFixture = [];
const readinessObservers = [];
const documentMock = {
    cookie: '',
    getElementById: id => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: selector => selector.includes('op-rows-container') ? opRows : selector.includes('dgOpScheduleData') ? scheduleFixture : []
};
const context = vm.createContext({
    document: documentMock,
    location: { hostname: 'hisaw.ntuh.gov.tw' },
    window: { location: { href: 'https://hisaw.ntuh.gov.tw/WebApplication/Clinics/DiagCertificate_New.aspx', search: '?SESSION=test&PersonID=synthetic&AccountIDSE=stay' } },
    MutationObserver: class { constructor(callback) { this.callback = callback; readinessObservers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    getComputedStyle: element => ({ visibility: element.hidden ? 'hidden' : 'visible' }),
    URL, URLSearchParams, TextDecoder, ArrayBuffer, Uint8Array, Event, console,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {}
});
const entryPoint = source.indexOf("    if (document.readyState === 'loading')");
vm.runInContext(source.slice(0, entryPoint) + `
    globalThis.api = { diagnosticError, handleConsentMessage, initRouter, mountDiagUIWhenReady, handleReceivedConsent, buildText, fetchEmgData, emgFeedsStay, fetchOpDataList,
        applySuggestedOperationNameByDate, selectBoundConsents, readBoundConsents, requestConsentInfos,
        triggerConsentScan, autoDetectRecords, runDiagFiller, createDiagUI, extractSuggestedOperationNameFromPdf,
        setMocks(mocks) {
            if (mocks.createDiagUI) createDiagUI = mocks.createDiagUI;
            if (mocks.autoDetectRecords) autoDetectRecords = mocks.autoDetectRecords;
            if (mocks.sleep) sleep = mocks.sleep;
            if (mocks.handleConsentMessage) handleConsentMessage = mocks.handleConsentMessage;
            if (mocks.extractPdf) extractSuggestedOperationNameFromPdf = mocks.extractPdf;
            if (mocks.token) currentScanToken = mocks.token;
            if (mocks.expandOne) expandOne = mocks.expandOne;
            if (mocks.fetchInpatData) fetchInpatData = mocks.fetchInpatData;
            if (mocks.fetchOpDataList) fetchOpDataList = mocks.fetchOpDataList;
            if (mocks.addOpRow) addOpRow = mocks.addOpRow;
            if (mocks.triggerConsentScan) triggerConsentScan = mocks.triggerConsentScan;
        }
    };
})();`, context);

context.api.initRouter();
assert.equal(timers.length, 0, 'No fixed delay for FAB creation');
assert.equal(readinessObservers.length, 1, 'Wait for the certificate creation section');
assert(!/setTimeout\(autoDetectRecords/.test(source));
assert(!source.includes('GM_openInTab'));

let readyMounts = 0;
context.api.setMocks({ createDiagUI: () => { readyMounts += 1; } });
readinessObservers[0].callback();
assert.equal(readyMounts, 0);
const titleFixture = { hidden: true, getClientRects: () => titleFixture.hidden ? [] : [{}] };
elements.set('NTUHWeb1_pnlCreateCertificateTitle', titleFixture);
elements.set('NTUHWeb1_InstructionSetItem', {});
readinessObservers[0].callback();
assert.equal(readyMounts, 0, 'Do not show FAB while the section is hidden');
titleFixture.hidden = false;
readinessObservers[0].callback();
assert.equal(readyMounts, 1, 'Show FAB when title and instruction field become visible/ready');
assert.equal(readinessObservers[0].disconnected, true);
context.api.setMocks({ createDiagUI: context.api.createDiagUI });
elements.clear();

const span = textContent => ({ textContent, getAttribute: () => '' });
const scheduleDoctor = '甲醫師';
const scheduleTitle = '日期：2026/09/11\n類別：住院\n診斷：fixture\n術式：fixture';
const scheduleClass = { textContent: '住', hasAttribute: () => false, getAttribute: () => scheduleTitle };
const scheduleCells = [
    { querySelector: () => scheduleClass }, { querySelector: () => span('2026/09/11') }, {},
    { querySelector: () => span('Fixture operation') }, { textContent: scheduleDoctor }
];
scheduleFixture = [{
    cells: scheduleCells, innerHTML: '',
    querySelectorAll: () => scheduleCells,
    closest: () => ({ querySelectorAll: () => [{ textContent: '醫師', cellIndex: 4 }] }),
    querySelector: selector => selector.includes('btnSetOpDateInfo') ? { id: 'btnSetOpDateInfo_fixture-one' }
        : selector.includes('OpDoctorName') ? span(scheduleDoctor) : null
}];
const parsedSchedule = context.api.fetchOpDataList()[0];
assert.equal(parsedSchedule.vsName, scheduleDoctor, 'Read the physician from the actual OpDoctorName span / 醫師 column');
assert.equal(context.api.selectBoundConsents([
    { OpScheduleIdse: parsedSchedule.opScheduleIdse, VSEmpName: '乙醫師', SurgeryName: 'wrong', SignDateString: '2026/09/10 16:00' },
    { OpScheduleIdse: parsedSchedule.opScheduleIdse, VSEmpName: scheduleDoctor, SurgeryName: 'correct', SignDateString: '2026/09/10 10:00' }
], parsedSchedule).chosen.SurgeryName, 'correct');
scheduleFixture = [];

const emgRow = (arrival, leave, disposition) => ({
    cells: [span(arrival), span(leave), span(disposition)],
    querySelector: selector => selector.includes('lblTriageDate') ? span(arrival) : span(leave)
});
const emgRows = [
    emgRow('2026/10/01 08:00', '2026/10/01 12:00', '返家'),
    emgRow('2026/09/10 08:00', '2026/09/10 12:00', '住院')
];
table = { rows: [{ cells: [span('檢傷時間'), span('離部時間'), span('離部動向')] }, ...emgRows], querySelectorAll: () => emgRows };
elements.set('NTUHWeb1_gvwEmgHistory', table);
assert.equal(context.api.fetchEmgData('2026/09/10').arrivalDT, '2026/09/10 08:00', 'Search all ED records');
assert.equal(context.api.fetchEmgData('2026/10/01').arrivalDT, '', 'Same-day discharge home does not feed admission');
assert.equal(context.api.fetchEmgData().arrivalDT, '2026/10/01 08:00');
assert.equal(context.api.emgFeedsStay({ leaveDate: '2026/09/10', disposition: '拒絕住院' }, '2026/09/10'), false);
table.rows[0].cells[2] = span('未知欄位');
assert.equal(context.api.fetchEmgData('2026/09/10').arrivalDT, '', 'Missing disposition must not imply admission');

function opRow(date, name, key) {
    const dateInput = { value: date };
    const nameInput = { value: name, dispatchEvent: () => {} };
    return { getAttribute: () => key, dataset: { scanRowKey: key }, querySelector: selector => selector.includes('date-input') ? dateInput : nameInput };
}
opRows = [opRow('2026/09/10', 'first', 'one'), opRow('2026/09/10', 'second', 'two'), opRow('2026/09/12', 'third', 'three')];
elements.set('ntuh-diag-op-rows-container', { getElementsByClassName: () => opRows });
context.api.applySuggestedOperationNameByDate('2026/09/10', '第二台手術', 'two');
assert.equal(opRows[0].querySelector('name-input').value, 'first');
assert.equal(opRows[1].querySelector('name-input').value, '第二台手術');
context.api.applySuggestedOperationNameByDate('2026/09/20', 'wrong', 'three');
assert.equal(opRows[2].querySelector('name-input').value, 'third', 'Never fall back to a different date');
const textOptions = {
    hasInpat: true, hasOpd: false, hasEmg: false,
    inpat: { inpatStartDate: '2026/09/10', timeline: [] },
    emg: { arrivalDT: '2026/09/09 08:00', leaveDT: '2026/09/10 12:00', leaveDate: '2026/09/10', disposition: '住院' },
    dept: '外科', opEvents: [{ date: '2026/09/10', name: '甲手術' }, { date: '2026/09/12', name: '乙手術' }],
    feeEvents: [], dischargeDate: '2026/09/12'
};
const instruction = context.api.buildText(textOptions);
assert(!instruction.includes('急診'), 'Unchecked ED must not be merged into the instruction');
assert(instruction.includes('西元2026年09月10日接受甲手術'));
assert(instruction.includes('西元2026年09月12日接受乙手術'));
const allDateOptions = { ...textOptions, hasEmg: true, hasOpd: true,
    opdDates: ['2026/09/01', '2027/01/02'], feeEvents: [{ date: '2026/09/11', name: '自費材料' }] };
const gregorianText = context.api.buildText(allDateOptions);
const rocText = context.api.buildText({ ...allDateOptions, calendar: 'roc' });
assert.equal(rocText, gregorianText.replace(/西元(\d{4})年/g, (_, year) => `民國${Number(year) - 1911}年`),
    'Convert all generated dates, including ED times, outpatient years, operations, fees and discharge');
assert.equal(context.api.buildText(allDateOptions), gregorianText, 'A previous ROC choice must not affect the default');

assert(context.api.buildText({ ...textOptions, hasEmg: true }).includes('急診'));
assert(!context.api.buildText({ ...textOptions, hasEmg: true, emg: { ...textOptions.emg, disposition: '返家' } }).includes('轉至本院'));

const results = [];
context.results = results;
context.api.setMocks({
    handleConsentMessage: msg => results.push(msg),
    extractPdf: async url => ({ operationName: url.includes('20260910') ? '甲手術' : '乙手術' }),
    token: 'test'
});
const consents = [
    { OpScheduleIdse: 'one', VSEmpNo: '00022', VSEmpName: '乙醫師', SurgeryName: '其他綁定甲', ConsentLink: 'https://ihisaw.ntuh.gov.tw/reference-one', SignDateString: '2026/09/09 16:00', IsBind: 'N' },
    { OpScheduleIdse: 'one', VSEmpNo: '00011', VSEmpName: '甲醫師', SurgeryName: 'API甲', ConsentLink: 'https://ihisaw.ntuh.gov.tw/main-one', SignDateString: '2026/09/08 16:00', IsBind: 'N' },
    { OpScheduleIdse: 'three', VSEmpNo: '00011', SurgeryName: 'API乙', ConsentLink: 'https://ihisaw.ntuh.gov.tw/main-three', IsBind: 'N' },
    { OpScheduleIdse: 'other', SurgeryName: 'wrong', ConsentLink: 'https://ihisaw.ntuh.gov.tw/other' },
    { OpScheduleIdse: 'one', VSEmpNo: '00011', SurgeryName: 'deleted', IsDelete: true },
    { OpScheduleIdse: '', SurgeryName: 'unbound' }
];
assert.equal(context.api.selectBoundConsents(consents, { opScheduleIdse: 'one', vsEmpNo: '11' }).chosen.SurgeryName, 'API甲', 'Same attending wins even if the other consent was signed later');
assert.equal(context.api.selectBoundConsents(consents, { opScheduleIdse: 'one', vsName: '甲醫師' }).chosen.SurgeryName, 'API甲');
assert.equal(context.api.selectBoundConsents(consents, { opScheduleIdse: '' }).bound.length, 0, 'Manual rows without an ID must never select unbound forms');
const listFixture = { style: {}, innerHTML: '' };
elements.set('ntuh-diag-consent-result-box', listFixture);
context.api.handleReceivedConsent([{ date: '2026/09/11', title: '測試術名', doctor: '甲醫師', selected: true,
    status: '病患已簽署 同意書已被手術流水號使用', url: 'https://ihisaw.ntuh.gov.tw/fixture' }]);
assert(!listFixture.innerHTML.includes('病患已簽署'));
assert(listFixture.innerHTML.includes('甲醫師／帶入'));
elements.delete('ntuh-diag-consent-result-box');
assert.equal(context.api.selectBoundConsents(consents, { opScheduleIdse: 'one', vsName: '甲醫師', vsEmpNo: '22' }).chosen.SurgeryName, 'API甲', 'Table physician name takes precedence over a conflicting fallback code');

const ops = [
    { date: '2026/09/10', rowKey: 'one', opScheduleIdse: 'one', vsEmpNo: '11' },
    { date: '2026/09/12', rowKey: 'three', opScheduleIdse: 'three', vsEmpNo: '11' }
];
(async () => {
    const pdfCalls = [];
    context.api.setMocks({ extractPdf: async url => { pdfCalls.push(url); return { operationName: 'PDF術名不可覆蓋API', diseaseName: '測試疾病' }; } });
    await context.api.readBoundConsents(consents, ops, 'test');
    const multi = results.find(msg => msg.kind === 'operation-name-multi');
    assert.equal(multi.items.length, 2);
    assert.equal(multi.items[0].operationName, 'API甲');
    assert.equal(multi.items[1].opDate, '2026/09/12');
    assert.equal(multi.diseaseNames.length, 1, 'Deduplicate disease names');
    const listed = results.find(msg => msg.data).data;
    assert.equal(listed.length, 3, 'Retain the second bound consent for reference');
    assert.equal(listed.filter(item => item.selected).length, 2);
    assert.equal(pdfCalls.length, 2, 'Read only the selected PDF for each operation');
    assert(!pdfCalls.includes('https://ihisaw.ntuh.gov.tw/reference-one'));
    assert.equal(opRows[0].querySelector('name-input').value, 'API甲');

    results.length = 0;
    elements.set('ntuh-diag-status', { textContent: '' });
    context.api.setMocks({ extractPdf: async () => { throw new Error('HTTP 403'); } });
    await context.api.readBoundConsents(consents, [ops[0]], 'test');
    assert.equal(opRows[0].querySelector('name-input').value, 'API甲', 'PDF failure retains the API name');
    assert(elements.get('ntuh-diag-status').textContent.includes('HTTP 403'));

    results.length = 0;
    context.api.setMocks({ extractPdf: async () => ({ diseaseName: '測試疾病' }) });
    await context.api.readBoundConsents([...consents, { ...consents[2], OpScheduleIdse: 'two', SurgeryName: 'API同日第二台' }],
        [ops[0], { date: '2026/09/10', rowKey: 'two', opScheduleIdse: 'two' }], 'test');
    assert.equal(opRows[0].querySelector('name-input').value, 'API甲');
    assert.equal(opRows[1].querySelector('name-input').value, 'API同日第二台', 'Same-day operations use their own schedule IDs and row keys');

    let request;
    context.GM_xmlhttpRequest = options => {
        request = options;
        options.onload({ status: 200, responseText: JSON.stringify({ IsVerified: true, IsSuccess: true, ConsentInfos: [] }) });
    };
    await context.api.requestConsentInfos({ Session: 'test', EmpNo: '123', PatChartNo: 'synthetic', HospCode: 'T0' });
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url).searchParams.get('Mode'), 'QueryConsnetFormByChartNo');
    assert.equal(JSON.parse(decodeURIComponent(request.data)).PatChartNo, 'synthetic');
    assert.equal(request.anonymous, false);
    assert.equal(new URL(request.headers.Referer).hostname, 'ihisaw.ntuh.gov.tw');
    assert.equal(new URL(request.headers.Referer).search, '', 'Do not copy the certificate session into Referer');
    context.GM_xmlhttpRequest = options => options.onload({ status: 200, responseText: JSON.stringify({ IsVerified: true, IsSuccess: true, ConsentInfos: [{ ChartNo: 'other' }, { ChartNo: 'synthetic' }] }) });
    assert.equal((await context.api.requestConsentInfos({ PatChartNo: 'synthetic' })).length, 1, 'Reject another patient data');
    context.GM_xmlhttpRequest = options => options.onload({ status: 200, responseText: JSON.stringify({ IsVerified: false, IsSuccess: false }) });
    await assert.rejects(context.api.requestConsentInfos({}), /登入已失效/);

    context.window.location.search = '?SESSION=test&ChartNo=synthetic&EmpNo=123';
    context.GM_xmlhttpRequest = options => {
        request = options;
        options.onload({ status: 200, responseText: JSON.stringify({ IsVerified: true, IsSuccess: true, ConsentInfos: [] }) });
    };
    await context.api.triggerConsentScan();
    assert.equal(request.method, 'POST', 'Use the direct API when page parameters are available');
    assert.equal(JSON.parse(decodeURIComponent(request.data)).EmpNo, '123');

    context.window.location.search = '?SESSION=test&ChartNo=synthetic';
    let fallbackGets = 0;
    let fallbackPost;
    context.DOMParser = class { parseFromString() { return { getElementById: () => ({ getAttribute: name => name.toUpperCase() === 'EMPNO' ? '123' : name.toUpperCase() === 'HOSPCODE' ? 'T0' : null }), querySelector: () => null }; } };
    context.GM_xmlhttpRequest = options => {
        if (options.method === 'GET') {
            fallbackGets += 1;
            options.onload({ status: 200, response: new TextEncoder().encode('<html>header only</html>').buffer });
        } else {
            fallbackPost = options;
            options.onload({ status: 200, responseText: JSON.stringify({ IsVerified: true, IsSuccess: true, ConsentInfos: [] }) });
        }
    };
    await context.api.triggerConsentScan();
    assert.equal(fallbackGets, 1, 'Use the schedule header to recover a missing operator number');
    assert.equal(JSON.parse(decodeURIComponent(fallbackPost.data)).EmpNo, '123');

    let pagesRead = 0;
    context.pdfjsLib = { GlobalWorkerOptions: { workerSrc: 'already-configured' }, getDocument: () => ({ promise: Promise.resolve({ numPages: 3,
        getPage: async () => { pagesRead += 1; return { getTextContent: async () => ({ items: [
            { str: '1.疾病名稱：測試疾病', transform: [0,0,0,0,0,700] },
            { str: '2.建議手術名稱：不需讀取的術名', transform: [0,0,0,0,0,680] }
        ] }) }; }
    }) }) };
    context.GM_xmlhttpRequest = options => options.onload({ status: 200, response: new TextEncoder().encode('%PDF-test').buffer });
    const diseaseOnly = await context.api.extractSuggestedOperationNameFromPdf('https://ihisaw.ntuh.gov.tw/test.pdf', new Set(), true);
    assert.equal(diseaseOnly.diseaseName, '測試疾病');
    assert.equal(diseaseOnly.operationName, '', 'Do not parse an unused operation name');
    assert.equal(pagesRead, 1, 'Stop scanning PDF once the disease name is found');

    for (const id of [ 'ntuh-diag-run', 'ntuh-diag-has-inpat', 'ntuh-diag-discharge-row', 'ntuh-diag-op-rows-container', 'ntuh-diag-has-op', 'ntuh-diag-op-detail', 'ntuh-diag-has-emg', 'ntuh-diag-emg-detail', 'ntuh-diag-emg-arrival', 'ntuh-diag-emg-leave', 'ntuh-diag-has-opd', 'ntuh-diag-opd-detail']) {
        elements.set(id, { style: {}, value: '', checked: false });
    }
    context.added = [];
    context.api.setMocks({
        expandOne: async () => {},
        fetchInpatData: () => ({ inpatStartDate: '2026/09/10', timeline: [{ end: '2026/09/12' }] }),
        fetchOpDataList: () => [
            { opDate: '2026/09/09', opName: 'before' }, { opDate: '2026/09/10', opName: 'first' },
            { opDate: '2026/09/12', opName: 'second' }, { opDate: '2026/09/13', opName: 'after' }
        ],
        addOpRow: (date, name) => context.added.push({ date, name }),
        triggerConsentScan: async () => {}
    });
    await context.api.autoDetectRecords();
    assert.equal(context.added.length, 2, 'Exclude operations outside the completed admission');
    assert.equal(context.added[0].date, '2026/09/10');
    assert.equal(context.added[1].date, '2026/09/12');
    assert.equal(elements.get('ntuh-diag-run').disabled, false);
    let saveClicks = 0;
    elements.set('NTUHWeb1_btnSaveTemp', { click: () => { saveClicks += 1; } });
    elements.set('ntuh-diag-discharge', { value: '2026/09/12' });
    elements.set('NTUHWeb1_InstructionSetItem', { value: '', dispatchEvent: () => {} });
    elements.get('ntuh-diag-has-inpat').checked = true;
    elements.get('ntuh-diag-has-op').checked = true;
    elements.set('ntuh-diag-op-rows-container', { getElementsByClassName: () => opRows });
    context.api.setMocks({ sleep: async () => {} });
    await context.api.runDiagFiller();
    assert(elements.get('NTUHWeb1_InstructionSetItem').value.includes('API甲'), 'Run still fills instructions');
    assert.equal(saveClicks, 0, 'Filling must not click temporary save');
    elements.set('ntuh-diag-calendar', { value: 'roc' });
    await context.api.runDiagFiller();
    assert(elements.get('NTUHWeb1_InstructionSetItem').value.includes('民國115年'));
    assert(!elements.get('NTUHWeb1_InstructionSetItem').value.includes('西元'));
    // Exercise the actual FAB handler without a browser or real hospital data.
    elements.clear();
    function makeElement() {
        const element = {
            style: {}, children: [], dataset: {}, value: '', textContent: '',
            appendChild(child) { this.children.push(child); if (child.id) elements.set(child.id, child); },
            addEventListener() {}, querySelector() { return null; }
        };
        Object.defineProperty(element, 'innerHTML', { set(html) {
            for (const match of html.matchAll(/id="([^"]+)"/g)) elements.set(match[1], makeElement());
        } });
        return element;
    }
    documentMock.createElement = makeElement;
    documentMock.head = makeElement();
    documentMock.body = makeElement();
    let fabRuns = 0;
    context.api.setMocks({ autoDetectRecords: async () => { fabRuns += 1; return true; } });
    await context.api.createDiagUI();
    assert.equal(elements.get('ntuh-diag-calendar').value, 'gregorian');
    assert.equal(fabRuns, 0, 'Creating the UI must not start automation');
    assert(!elements.has('ntuh-diag-detect'), 'Do not add a separate read button');
    await elements.get('ntuh-diag-fab').onclick();
    assert.equal(fabRuns, 1, 'Opening the FAB starts automation');
    elements.get('ntuh-diag-close').onclick();
    await elements.get('ntuh-diag-fab').onclick();
    assert.equal(fabRuns, 1, 'Reopening preserves the user edits');
    assert(!elements.has('ntuh-diag-debug'), 'Remove the diagnostic details block');
    assert(!elements.has('ntuh-diag-debug-output'));
    assert(!elements.has('ntuh-diag-open-consent'), 'Remove the outdated manual consent entry');
    assert.equal(context.api.diagnosticError('HTTP 403 https://ihisaw.ntuh.gov.tw/show?SESSION=secret PersonID=private'), 'HTTP 403 [網址已隱藏] [識別參數已隱藏]');
    context.api.setMocks({ token: 'test' });
    context.api.handleConsentMessage({ ntuh: true, token: 'test', warning: '未能唯一配對' });
    assert.equal(elements.get('ntuh-diag-status').className, 'diag-warn');
    console.log('DiagCertificate regression checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
