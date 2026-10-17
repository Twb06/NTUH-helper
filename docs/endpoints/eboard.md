# EBoardInfoHandler

`POST https://ihisaw.ntuh.gov.tw/WebApplication/EBoard/EBoardInfoHandler.ashx`

本文件提供三種已知 Mode 的請求與解析範例：`DrInfo`、`NurInfo`、`PlanCheckIn`。內容依已提供的請求、樣本及既有解析契約整理，尚未在院內登入環境實測；未列欄位不代表後端不存在。

## 請求

Body 為 JSON 字串，非表單或 URL query。三種 Mode 使用相同欄位，只切換 `Mode`；不傳 `ClinetIP`。

| Header | 值 |
| --- | --- |
| Accept | `application/json, text/javascript, */*; q=0.01` |
| Content-Type | `application/json; charset=utf-8` |
| X-Requested-With | `XMLHttpRequest` |

| Body 欄位 | 格式／已知用法 |
| --- | --- |
| HospitalCode | 院區碼，例如 `T0`、`T1`；不可在缺值時假設為 `T0` |
| WardCode | 病房代碼，例如 `06A` |
| StartDate | `YYYY/MM/DD` |
| EndDate | `YYYY/MM/DD`；目前已知用法與 StartDate 相同，多日區間語意未確認 |
| ActiveFlag | 已知請求使用 `Y`，後端定義未確認 |
| QueryNews2 | 已知請求使用 `N`，後端定義未確認 |
| Mode | `DrInfo`、`NurInfo` 或 `PlanCheckIn` |

虛構範例：

```json
{
  "HospitalCode": "T0",
  "WardCode": "06A",
  "StartDate": "2026/10/17",
  "EndDate": "2026/10/17",
  "ActiveFlag": "Y",
  "QueryNews2": "N",
  "Mode": "DrInfo"
}
```

Tampermonkey 使用 `GM_xmlhttpRequest`，`data: JSON.stringify(body)`、`responseType: "text"`、`anonymous: false`；metadata 需 `@grant GM_xmlhttpRequest` 及 `@connect ihisaw.ntuh.gov.tw`。需要有效登入工作階段；新竹來源對此主機的 cookie 相容性尚未驗證。同源 fetch 可使用 `credentials: "include"`，跨來源 fetch 仍受 CORS 限制。

先檢查 HTTP 為 2xx，再 `JSON.parse(responseText)`；200 也可能是登入 HTML，解析失敗不能當成空清單。此 endpoint 的已知 JSON 回應不使用 ASMX 的 `{ "d": ... }` 外殼。不要硬編碼 cookies、SESSION 或瀏覽器管理的 headers。

## DrInfo：醫師分配

已提供樣本為 `[assignmentRecords, staffDirectoryRecords]`。讀取前檢查外層及使用到的子陣列；這是一份樣本觀察，非完整後端 schema 保證。

| 位置 | 已觀察欄位 |
| --- | --- |
| `data[0]` 分配紀錄 | `EmpNo`、`EmpName`、`PhoneCode`、`TakeCareBedList`、`RoleFilter`、`CareShift`、`RoleCode`、`RoleName`、`SubWard`、`StockTake`、`StockTakeFromSchedule`、`FireFight`、`TakeNewPt`、`OtherTask` |
| `data[1]` 人員目錄 | `HospitalCode`、`WardCode`、`EmpNo`、`EmpName`、`EmpTitle`、`CostCenterName`、`PhoneCode`、`ModifyEmpNo`、`AdmDept`、`EmpInfoShow`、`ShowPriority` |

`RoleFilter` 樣本包含 `DRVS`、`DRRS`、`OTH` 及空值。分配資料取自 `data[0]`；`data[1]` 未提供 RoleFilter／TakeCareBedList，不能 flatten 後視為相同分配紀錄。

`EmpNo`、`PhoneCode` 保留字串及前導零；缺失值不自行補造。`TakeCareBedList` 為逗號分隔床位字串，split 後 trim、排除空值並去重，按完整 token 比對；`01-01` 與 `01-01N` 不同。姓名只 trim 頭尾空白。衍生解析不修改原始 JSON。

## NurInfo：護理分配

`data[0]` 為護理分配陣列，至少先驗證 `Array.isArray(data?.[0])`。其餘外層內容與完整欄位集合未由目前資料確認，不推定與 DrInfo 相同。

| 已使用欄位 | 解析 |
| --- | --- |
| EmpNo | 員編，保留字串 |
| EmpName | 護理師姓名，trim 頭尾空白 |
| CareShift | trim、轉大寫後：`A` 白班、`E` 小夜、`N` 大夜 |
| TakeCareBedList | 逗號分隔床位清單 |

可整理為「班別 → 完整床位 token → 人員陣列」。同班同床可有多位護理師，不應以單一物件覆蓋；未知班別或缺姓名的紀錄不能直接作為有效分配。床位尾碼 `N` 須保留，不能與一般床位合併。班別的 `N` 與床位尾碼的 `N` 是不同欄位的概念。

## PlanCheckIn：新病人清單

回應為完整 new-patient 陣列，**直接遍歷外層陣列，不讀取 `data[0]` 作為子陣列**。目前解析所需欄位：

| 欄位 | 解析 |
| --- | --- |
| AccountIDSE | 非空字串，住院帳號識別，保留字串 |
| BedIDSEShort | 非空字串，基本床位識別 |
| HospCode | 必須符合請求的 HospitalCode；注意回應欄名不同 |
| WardCode | 必須符合請求的 WardCode |

虛構的最小回應範例：

```json
[
  {
    "AccountIDSE": "26T00000001",
    "BedIDSEShort": "01-01",
    "HospCode": "T0",
    "WardCode": "06A"
  }
]
```

以院區／病房限定後，比對完整 `AccountIDSE` 與 `BedIDSEShort`。在一般／尾碼 N 床位分配衝突的核實情境中，帳號與床號匹配表示 new patient，可取尾碼 N；帳號不在**完整且有效**清單中才可取一般 token。不需要判斷 `IsCheckin`。

若同帳號出現互相衝突的床位、帳號存在但床號不符、院區／病房不符、必要欄位缺失、非陣列或請求失敗，不能當成「帳號不在清單」。只有完整成功解析的空陣列 `[]` 才表示此查詢沒有 new-patient 紀錄。

## 可直接使用的 JavaScript

將下列函式放進已登入院內頁面的 Tampermonkey userscript，並在 metadata 加上這兩行：

```javascript
// @grant GM_xmlhttpRequest
// @connect ihisaw.ntuh.gov.tw
```

`hospitalCode`、`wardCode`、`date` 由呼叫者指定，日期以台北日期為準。若只有 AccountIDSE，可用 `String(accountIdSe).trim().match(/^\d*(\D.)/)?.[1]` 擷取院區碼，例如虛構帳號 `26T00000001` 得到 `T0`；擷取失敗不可預設院區。

```javascript
function requestEboard({ hospitalCode, wardCode, date, mode }) {
    if (!['DrInfo', 'NurInfo', 'PlanCheckIn'].includes(mode)) {
        return Promise.reject(new Error('未知的 Mode'));
    }
    if (!hospitalCode?.trim() || !wardCode?.trim() || !/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
        return Promise.reject(new Error('請提供院區、病房及 YYYY/MM/DD 日期'));
    }
    return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
            method: 'POST',
            url: 'https://ihisaw.ntuh.gov.tw/WebApplication/EBoard/EBoardInfoHandler.ashx',
            headers: {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/json; charset=utf-8',
                'X-Requested-With': 'XMLHttpRequest',
            },
            data: JSON.stringify({
                HospitalCode: hospitalCode.trim(), WardCode: wardCode.trim(),
                StartDate: date, EndDate: date,
                ActiveFlag: 'Y', QueryNews2: 'N', Mode: mode,
            }),
            responseType: 'text', anonymous: false, timeout: 20000,
            onload(response) {
                if (response.status < 200 || response.status >= 300) {
                    reject(new Error(`EBoard HTTP ${response.status}`));
                    return;
                }
                try { resolve(JSON.parse(response.responseText)); }
                catch { reject(new Error('回應不是有效 JSON，請確認登入狀態')); }
            },
            onerror: () => reject(new Error('EBoard 網路請求失敗')),
            ontimeout: () => reject(new Error('EBoard 請求逾時')),
            onabort: () => reject(new Error('EBoard 請求已取消')),
        });
    });
}

const text = (value) => value == null ? '' : String(value).trim();
const bedTokens = (value) => [...new Set(text(value).split(',').map(text).filter(Boolean))];

function assignmentRows(data) {
    if (!Array.isArray(data) || !Array.isArray(data[0]) ||
        data[0].some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error('人員分配回應格式不符');
    }
    return data[0];
}

function parseDrInfo(data) {
    const assignments = assignmentRows(data);
    if (!Array.isArray(data[1])) throw new Error('DrInfo 人員目錄不是陣列');
    return { assignments, directory: data[1] }; // 保留原始人員欄位，不合併兩組陣列
}

function parseNurInfo(data) {
    return assignmentRows(data)
        .filter(row => ['A', 'E', 'N'].includes(text(row.CareShift).toUpperCase()) && text(row.EmpName))
        .map(row => ({
            EmpNo: row.EmpNo, EmpName: text(row.EmpName),
            CareShift: text(row.CareShift).toUpperCase(),
            beds: bedTokens(row.TakeCareBedList),
        })); // 保留多筆同班同床分配，不用床號作單一值的覆寫鍵
}

function parsePlanCheckIn(data, { hospitalCode, wardCode }) {
    if (!Array.isArray(data)) throw new Error('PlanCheckIn 不是陣列');
    const byAccount = new Map();
    for (const row of data) {
        if (!row || !['AccountIDSE', 'BedIDSEShort', 'HospCode', 'WardCode']
            .every(key => typeof row[key] === 'string' && row[key].trim())) {
            throw new Error('PlanCheckIn 缺少有效的帳號／床位／院區／病房');
        }
        if (row.HospCode.trim() !== hospitalCode.trim() || row.WardCode.trim() !== wardCode.trim()) {
            throw new Error('PlanCheckIn 院區／病房不符');
        }
        const account = row.AccountIDSE.trim(), bed = row.BedIDSEShort.trim();
        if (byAccount.has(account) && byAccount.get(account) !== bed) {
            throw new Error('PlanCheckIn 同帳號對應多個床位');
        }
        byAccount.set(account, bed);
    }
    return byAccount; // 只有完成整份驗證後，帳號缺席才有意義
}

function isNewPatient(byAccount, accountIdSe, baseBed) {
    const account = text(accountIdSe), bed = text(baseBed);
    if (!account || !bed) throw new Error('缺少待比對帳號／床位');
    if (!byAccount.has(account)) return false;
    if (byAccount.get(account) !== bed) throw new Error('帳號存在，但床號不符');
    return true;
}
```

呼叫三種 Mode 的範例（院區、病房、日期及帳號皆須改成目標查詢值；以下使用虛構資料）：

```javascript
async function loadEboard() {
    const scope = { hospitalCode: 'T0', wardCode: '06A', date: '2026/10/17' };
    const doctors = parseDrInfo(await requestEboard({ ...scope, mode: 'DrInfo' }));
    const vs = doctors.assignments.filter(row => row.RoleFilter === 'DRVS');
    const residents = doctors.assignments.filter(row => row.RoleFilter === 'DRRS');
    // 任一醫師的完整照護床位：bedTokens(residents[0]?.TakeCareBedList)

    const nurses = parseNurInfo(await requestEboard({ ...scope, mode: 'NurInfo' }));
    const dayNurses = nurses.filter(row => row.CareShift === 'A' && row.beds.includes('01-01'));

    const newPatients = parsePlanCheckIn(await requestEboard({ ...scope, mode: 'PlanCheckIn' }), scope);
    const token = isNewPatient(newPatients, '26T00000001', '01-01') ? '01-01N' : '01-01';
    return { vs, residents, dayNurses, token };
}
```

以上函式會將 HTTP、JSON 與 schema 錯誤向呼叫端拋出；呼叫端應顯示或處理失敗，不能以空清單替代，尤其不能因此判定病人不在新病人清單。
