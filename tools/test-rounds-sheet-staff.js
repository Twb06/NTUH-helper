/* eslint-env node */
// Synthetic records only. Run: node tools/test-rounds-sheet-staff.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../scripts/rounds-sheet.user.js'), 'utf8');
const pending = [];
const context = vm.createContext({ Intl, Date, Map, Set, document: {}, GM_xmlhttpRequest: (request) => pending.push(request) });
vm.runInContext(source.slice(source.indexOf('    const PER_PAGE'), source.indexOf('    function sideHtml')) + '\nglobalThis.api = { getTaipeiDate, buildEboardBody, gmFetchEboardInfo, getStaffAssignments, selectCR, selectVS, resolveStaffBed, buildStaffHeaders, applyStaffHeaders, installStaffHeaders, staffHash, nk, headerHtml, pageDocs, physicianName, readPatients, patientName, blockHtml };', context);
const A = context.api;
const plain = (value) => JSON.parse(JSON.stringify(value));
const person = (name, id, beds, role = 'DRRS', phone = '00123') => ({ EmpName: name, EmpNo: id, PhoneCode: phone, TakeCareBedList: beds, RoleFilter: role });
const data = (...rows) => [rows, [person('Directory only', '00999', '01-01')]];
const patient = (bedToken, resident) => ({ bedToken, resident });
const target = patient('01-01', 'R');

async function main() {
    assert.equal(A.getTaipeiDate(new Date('2026-10-16T17:00:00Z')), '2026/10/17');
    assert.equal(A.patientName(' 病[禁]人[禁] '), '病人');
    assert.equal(A.nk(' 醫師[禁] '), '醫師[禁]', 'patient marker cleanup must not change physician matching');
    const patientHtml = A.blockHtml({ chartNo: 'FAKE', caseno: '26T00000001', name: '測試[禁]病人', age: '40', sex: '男', adm: '', attending: '主治甲', resident: '住院乙' });
    assert.ok(patientHtml.includes('測試病人'));
    assert.ok(!patientHtml.includes('[禁]'));
    assert.ok(patientHtml.includes('（M, 40y0m）'));
    assert.ok(patientHtml.includes('class="staff-vr"'));
    const payload = JSON.parse(A.buildEboardBody({ accountIdSe: '2026T10000002', wardCode: ' 06A ', date: '2026/10/17', mode: 'NurInfo' }));
    assert.deepStrictEqual(payload, { HospitalCode: 'T1', WardCode: '06A', StartDate: '2026/10/17', EndDate: '2026/10/17', ActiveFlag: 'Y', QueryNews2: 'N', Mode: 'DrInfo' });
    assert.throws(() => A.buildEboardBody({ accountIdSe: '1234', wardCode: '06A' }), /院區碼/);
    assert.throws(() => A.buildEboardBody({ accountIdSe: '26T00000001', wardCode: ' ' }), /病房/);
    const alpha = person('甲', '00001', '01-01,01-02,01-02, ,101-01');
    const beta = person('乙', '00002', '01-01,01-03,01-04,01-05');
    const original = data(alpha, beta);
    const before = JSON.stringify(original);
    const scoring = [target, patient('01-02', '乙'), patient('01-03', '乙')];
    const candidates = A.selectCR(original, [target], scoring).candidates;
    assert.deepStrictEqual(plain(candidates.map((r) => [r.EmpName, r.score, r.bedCount])), [['甲', 2, 3], ['乙', 1, 4]]);
    assert.equal(JSON.stringify(original), before, 'selectors leave raw JSON unchanged');
    assert.equal(A.selectCR(data(alpha), [target], [patient('01-01', '甲')]).candidates.length, 0, 'single candidate still requires positive score');
    assert.equal(A.selectCR(data(alpha), [target], [target]).candidates[0].EmpNo, '00001');
    assert.equal(A.selectCR(data(alpha), [patient('01-01N', 'R')], [target]).candidates.length, 0);
    assert.equal(A.selectCR(data(person('甲', '1', '101-01')), [target], [target]).candidates.length, 0);
    assert.equal(A.selectCR(data(alpha, person('乙', '2', '01-01,02-01,03-01')), [target], [target]).candidates.length, 2, 'equal score/bedCount keeps all');
    const tie = A.selectCR(original, [target], [target]).candidates;
    assert.equal(tie[0].EmpNo, '00002', 'score tie sorts full deduplicated bed count');
    assert.equal(A.selectCR(original, [target], [patient('01-01', '')]).status, 'insufficient-data');
    assert.equal(A.selectCR(original, [target], [patient('', '甲')]).status, 'insufficient-data');
    assert.equal(A.selectCR(data(alpha, person('甲', '00001', '99-99')), [target], [target]).candidates.length, 0, 'duplicate identity skipped, no silent merge');
    assert.equal(A.resolveStaffBed(data(alpha), '01-01'), '01-01');
    assert.equal(A.resolveStaffBed(data(person('甲', '1', '01-01N')), '01-01'), '01-01N');
    assert.equal(A.resolveStaffBed(data(alpha, person('乙', '2', '01-01N')), '01-01'), '');
    assert.equal(A.selectCR(original, [patient('', 'R')], scoring).status, 'insufficient-data');
    assert.equal(A.selectCR(data(person('甲', '1', '99-99')), [target], [patient('99-99', 'R')]).candidates.length, 0, 'positive score outside current page excluded');
    const vs = person('醫 師', '00003', '', 'DRVS');
    assert.equal(A.selectVS(data(vs, person('醫 師', '4', '', 'DRRS')), ' 醫 師 ').person.EmpNo, '00003');
    assert.equal(A.selectVS(data(vs), '醫師').status, 'not-found');
    assert.throws(() => A.selectVS(data(vs, vs), '醫 師'), /超過一筆/);
    assert.equal(A.selectVS(data({ ...vs, PhoneCode: undefined }), '醫 師').person.PhoneCode, null);

    const options = { accountIdSe: '26T00000001', wardCode: '06A', date: '2026/10/17' };
    const first = A.getStaffAssignments(options), shared = A.getStaffAssignments(options);
    assert.strictEqual(first, shared, 'same scope shares in-flight promise');
    let request = pending.shift();
    assert.equal(request.url, 'https://ihisaw.ntuh.gov.tw/WebApplication/EBoard/EBoardInfoHandler.ashx');
    assert.equal(request.method, 'POST');
    assert.equal(request.anonymous, false);
    assert.equal(request.timeout, 20000);
    assert.equal(request.headers['Content-Type'], 'application/json; charset=utf-8');
    request.onload({ status: 200, responseText: JSON.stringify(data(alpha, vs)) });
    await first;
    assert.strictEqual(A.getStaffAssignments(options), first, 'success cached in memory');
    const otherHospital = A.getStaffAssignments({ ...options, accountIdSe: '26T10000001' });
    request = pending.shift();
    assert.equal(JSON.parse(request.data).HospitalCode, 'T1');
    request.onload({ status: 200, responseText: '<html>login</html>' });
    await assert.rejects(otherHospital, /有效 JSON/);
    const retry = A.getStaffAssignments({ ...options, accountIdSe: '26T10000001' });
    pending.shift().ontimeout();
    await assert.rejects(retry, /逾時/);
    for (const [suffix, respond, pattern] of [
        ['B', (r) => r.onload({ status: 401 }), /HTTP 401/],
        ['C', (r) => r.onerror(), /網路/],
        ['D', (r) => r.onabort(), /取消/],
        ['E', (r) => r.onload({ status: 200, responseText: '{}' }), /格式/],
    ]) {
        const result = A.getStaffAssignments({ ...options, wardCode: '06' + suffix });
        respond(pending.shift());
        await assert.rejects(result, pattern);
    }
    const later = A.getStaffAssignments({ ...options, date: '2026/10/18' });
    assert.equal(pending.length, 1, 'new Taipei date gets distinct request');
    pending.shift().onload({ status: 200, responseText: '[[],[]]' });
    await later;

    vm.runInContext("staffCache.get('T0|06A|2026/10/17|DrInfo').at = 0", context);
    const expired = A.getStaffAssignments(options);
    assert.equal(pending.length, 1, 'expired scope refreshes after ten minutes');
    pending.shift().onload({ status: 200, responseText: JSON.stringify(data(alpha, vs)) });
    await expired;

    const patients = [{ caseno: '26T00000001', ward: '06A', bed: '01-01', attending: '醫 師', resident: '乙' }];
    const headers = await A.buildStaffHeaders(patients);
    assert.equal(headers[0].cr[0].person.EmpNo, '00001');
    assert.equal(headers[0].vs[0].person.EmpNo, '00003');
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...patients[0], caseno: '26T0' + i, bed: '01-' + String(i + 1).padStart(2, '0'), attending: 'VS' + i }));
    const next = A.buildStaffHeaders(twelve);
    // Scope already cached; candidates must still be limited to beds on each printed page.
    const paged = await next;
    assert.equal(paged[0].vs.length, 11, 'no hard limit on VS slots');
    assert.equal(paged[1].cr.length, 0, 'other-page beds do not qualify');
    assert.deepStrictEqual(plain(A.pageDocs([{ attending: ' 醫 師 ' }, { attending: '醫師' }])), ['醫 師', '醫師']);
    const html = A.headerHtml(1, patients);
    assert.match(html, /data-role="CR"/); assert.match(html, /data-role="VS"/);
    assert.ok(html.indexOf('data-role="CR"') < html.indexOf('data-role="VS"'));
    assert.ok(!html.includes('h:1:1'), 'legacy positional header keys are not reused');

    const cell = (textContent) => ({ textContent, cloneNode: () => ({ textContent, querySelectorAll: () => [] }) });
    const headerCells = ['入院日', '其他日期', '住院', '額外欄', '主治'].map(cell);
    let permitTitle = '2026/10/07 可出院';
    const row = { cells: ['2026/10/16', '1999/01/01', ' 住 院 ', 'irrelevant', ' 主 治 '].map(cell), innerHTML: '', querySelector(selector) {
        if (selector.includes('NEWSLabel')) return { getAttribute: (key) => key === 'caseno' ? '26T00000001' : key === 'wardcode' ? 'WRONG' : '' };
        if (selector.includes('LinkPermitDischarge')) return permitTitle === null ? null : { getAttribute: () => permitTitle };
        const labels = { WardLabel: '06A', RoomLabel: '01', BedLabel: '01' };
        const key = Object.keys(labels).find((key) => selector.includes(key));
        return key ? cell(labels[key]) : null;
    } };
    context.document = { querySelector: () => ({ rows: [{ cells: headerCells }, row] }) };
    const extracted = A.readPatients()[0];
    assert.equal(extracted.adm, '2026/10/16', 'admission comes from labeled column despite earlier dates');
    assert.equal(extracted.resident, '住 院'); assert.equal(extracted.attending, '主 治');
    assert.equal(extracted.ward, '06A'); assert.equal(extracted.staffBed, '01-01');
    assert.equal(extracted.dischargeDate, '2026/10/07');
    assert.equal(extracted.discharged, false);
    assert.match(A.blockHtml(extracted), /預出院<input[^>]*data-def="2026\/10\/07"/);
    permitTitle = '2026/10/08 已出院';
    const discharged = A.readPatients()[0];
    assert.equal(discharged.discharged, true);
    assert.match(A.blockHtml(discharged), /已出院<input[^>]*data-def="2026\/10\/08"/);
    for (const title of [null, '', '尚未確認', '已出院']) {
        permitTitle = title;
        const missing = A.readPatients()[0];
        assert.equal(missing.dischargeDate, '');
        assert.equal(missing.discharged, false);
    }
    headerCells[0].textContent = 'unknown';
    assert.equal(A.readPatients()[0].adm, '', 'unknown header never falls back to positional/date guesses');

    // Small DOM model exercises additions/removals and async results without external dependencies.
    class Element {
        constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.value = ''; }
        appendChild(child) { child.parent = this; this.children.push(child); return child; }
        remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
        setAttribute(name, value) { this.attrs[name] = value; }
        getAttribute(name) { return name === 'data-k' ? this.dataset.k : name === 'data-def' ? this.dataset.def : this.attrs[name]; }
        hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
        matches(selector) {
            const attr = selector.match(/\[data-([a-z]+)(?:="([^"\]]+)")?\]/);
            const cls = selector.match(/^\.([\w-]+)/);
            return (!attr || (this.dataset[attr[1]] !== undefined && (attr[2] === undefined || this.dataset[attr[1]] === attr[2]))) && (!cls || (this.className || '').split(' ').includes(cls[1])) && (attr || cls || this.tagName.toLowerCase() === selector);
        }
        querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); }
    }
    const doc = new Element(); doc.createElement = (tag) => new Element(tag); doc.createTextNode = () => new Element('#text');
    const header = doc.appendChild(new Element()); header.className = 'hdr'; header.dataset = { page: '1', scope: 'pagehash', names: '["醫 師"]' };
    ['CR', 'VS'].forEach((role) => {
        const row = header.appendChild(new Element()); row.dataset.role = role;
        const slots = row.appendChild(new Element()); slots.className = 'staff-slots';
        const button = row.appendChild(new Element('button')); button.className = 'staff-add';
    });
    const store = {}; let saves = 0;
    const fill = (el) => { const value = store[el.dataset.k]; el.value = value === undefined ? el.dataset.def || '' : value; if (value !== undefined) el.setAttribute('data-staff-manual', '1'); };
    const state = A.installStaffHeaders(doc, store, () => saves++, fill, () => {}, A.staffHash, A.nk);
    A.applyStaffHeaders(doc, headers, state);
    const crRow = header.querySelector('[data-role="CR"]');
    assert.equal(crRow.querySelectorAll('[data-slot]').length, 1);
    assert.deepStrictEqual(crRow.querySelectorAll('input').map((el) => el.value), ['甲', '00001', '00123']);
    const vsRow = header.querySelector('[data-role="VS"]');
    const vsName = vsRow.querySelector('input'); vsName.value = '手動姓名'; vsName.setAttribute('data-staff-manual', '1');
    vsRow.querySelectorAll('input')[1].value = '';
    A.applyStaffHeaders(doc, headers, state);
    assert.equal(vsRow.querySelectorAll('input')[1].value, '', 'manual identity prevents mismatched identifiers');
    crRow.querySelector('.staff-remove').onclick();
    assert.equal(crRow.querySelector('.staff-remove-menu').hidden, false);
    crRow.querySelector('.staff-remove-menu').querySelectorAll('button')[0].onclick();
    A.applyStaffHeaders(doc, headers, state);
    assert.equal(crRow.querySelectorAll('[data-slot]').length, 0, 'late response cannot recreate removed CR');
    crRow.querySelector('.staff-add').onclick();
    assert.equal(crRow.querySelectorAll('[data-slot]').length, 1);
    assert.equal(store.__staffV2.pagehash.added.length, 1);
    assert.equal(store.__staffV2.pagehash.removed.length, 1);
    assert.ok(saves >= 2);
    const manual = crRow.querySelector('input'); manual.value = ''; manual.setAttribute('data-staff-manual', '1');
    A.applyStaffHeaders(doc, headers, state);
    assert.equal(manual.value, '', 'late response preserves newly added/edited field');
    assert.ok(!JSON.stringify(store).includes('PhoneCode'), 'raw response/defaults are not persisted');
    const anotherId = 'CR-another';
    store['h:v2:pagehash:CR-another:a'] = '已儲存的別人';
    state.upsert(header, crRow, { id: anotherId, person: { EmpName: '甲', EmpNo: '00001', PhoneCode: '00123' }, title: 'match' });
    const restored = crRow.querySelectorAll('[data-slot]').find((slot) => slot.dataset.slot === anotherId);
    assert.deepStrictEqual(restored.querySelectorAll('input').map((el) => el.value), ['已儲存的別人', '', ''], 'saved different name blocks identifiers on newly created async slot');

    const header2 = doc.appendChild(new Element()); header2.className = 'hdr'; header2.dataset = { page: '2', scope: 'secondpage', names: '[]' };
    const row2 = header2.appendChild(new Element()); row2.dataset.role = 'CR';
    const slots2 = row2.appendChild(new Element()); slots2.className = 'staff-slots';
    const sharedPerson = { id: 'CR-shared', person: { EmpName: '跨頁醫師', EmpNo: '00009' }, title: '' };
    state.upsert(header, crRow, sharedPerson); state.upsert(header2, row2, sharedPerson);
    let sharedSlot = () => crRow.querySelectorAll('[data-slot]').find((slot) => slot.dataset.slot === sharedPerson.id);
    sharedSlot().querySelector('.staff-remove').onclick();
    sharedSlot().querySelector('.staff-remove-menu').querySelectorAll('button')[2].onclick();
    assert.ok(sharedSlot(), 'cancel leaves the person in place');
    sharedSlot().querySelector('.staff-remove').onclick();
    sharedSlot().querySelector('.staff-remove-menu').querySelectorAll('button')[0].onclick();
    assert.equal(row2.querySelectorAll('[data-slot]').length, 1, 'page-only removal preserves the other page');
    const otherSlot = row2.querySelector('[data-slot]');
    otherSlot.querySelector('.staff-remove').onclick();
    otherSlot.querySelector('.staff-remove-menu').querySelectorAll('button')[1].onclick();
    assert.equal(row2.querySelectorAll('[data-slot]').length, 0, 'all-pages removal removes the other occurrence');
    state.upsert(header, crRow, sharedPerson); state.upsert(header2, row2, sharedPerson);
    assert.ok(!sharedSlot(), 'all-pages removal blocks late results on the first page');
    assert.equal(row2.querySelectorAll('[data-slot]').length, 0, 'all-pages removal blocks late results on the second page');
    assert.ok(store.__staffV2.secondpage.removed.includes(sharedPerson.id), 'all-pages choice is persisted per page');
    assert.equal(pending.length, 0);
    console.log('rounds-sheet staff: all tests passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
