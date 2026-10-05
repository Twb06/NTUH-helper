---
id: "ward-asynchronous-process"
title: "AsynchronousProcessHandler.ashx：給藥醫囑與給藥紀錄"
path: "/WebApplication/InPatient/Ward/AsynchronousProcessHandler.ashx"
verification: "partial"
last_verified: "2026-10-02"
verified_sites: ["T0"]
source_pages:
  - "/WebApplication/InPatient/Ward/DrugGivenNote.aspx"
  - "/WebApplication/InPatient/Ward/OpenWard.aspx"
consumers:
  - "scripts/morning-briefing.user.js"
  - "scripts/standalone/morning-briefing.standalone.user.js"
operations:
  - { name: "Query", method: "GET", selector: "Mode=Query", effect: "read", verification: "tested" }
  - { name: "Update", method: "POST", selector: "Mode=Update", effect: "write", verification: "observed" }
  - { name: "Delete", method: "POST", selector: "Mode=Delete", effect: "write", verification: "observed" }
  - { name: "Authentication", method: "POST", selector: "Mode=Authentication", effect: "unknown", verification: "observed" }
  - { name: "Cosign", method: "POST", selector: "Mode=Cosign", effect: "write", verification: "observed" }
  - { name: "EndTime", method: "POST", selector: "Mode=EndTime", effect: "write", verification: "observed" }
  - { name: "ExtravasationEvaluation", method: "POST", selector: "Mode=ExtravasationEvaluation", effect: "write", verification: "observed" }
  - { name: "CheckError", method: "POST", selector: "Mode=CheckError", effect: "write", verification: "observed" }
---

# AsynchronousProcessHandler.ashx

## 用途與結論

這是病房給藥頁 `DrugGivenNote.aspx` 的 AJAX 後端入口，同一個 path 用 `Mode` 分派不同操作。`Query` 取得指定住院帳號、指定日期的藥物醫囑與給藥紀錄 XML，可在已登入的 `OpenWard.aspx` 直接呼叫，不必先載入 `DrugGivenNote.aspx` 或藥歷頁。

2026-10-02 在總院 T0 實測：`Mode`、`AccountIDSE`、`Personid`、`Year`、`Month`、`Day` 六個參數足以取得同一份醫囑與給藥資料。專案依使用者要求另外保留 `SESSION`，目前共送七個參數。

這個「最小」集合是此次登入環境、病人與日期的刪減結果，不代表所有院區／登入環境的普遍契約。其他 Mode 僅從前端呼叫程式確認用途，沒有執行寫入測試，也沒有後端原始碼。

## 證據與驗證環境

| 項目 | 紀錄 |
|---|---|
| 驗證日期／時區 | 2026-10-02，Asia/Taipei |
| 院區／host | T0，`ihisaw.ntuh.gov.tw` |
| 登入環境 | 使用現有登入狀態，瀏覽器同網域請求；未測試匿名／無 Cookie |
| 原始入口 | `DrugGivenNote.aspx` 的「查詢／重整」及 `QueryServer()` |
| 直接查詢入口 | 已登入的 `OpenWard.aspx`，同 origin AJAX GET |
| 回應 | HTTP 200，`text/xml`，根節點 `ObjectSerializer` |
| 樣本 | 26 筆一般藥物醫囑、0 筆化療醫囑，XML 約 70 萬字元 |
| 比較方式 | 解析 XML，逐筆序列化 `ActiveDrugs` 後排序比較；不只比較 HTTP status 或筆數 |
| 目前使用版本 | `morning-briefing` 1.5.2；本文件記錄該版本的日期判讀 |

請求與回應中的真實病人識別、員編、IP、SESSION 都不保存於本文件。下列範例使用占位符或合成資料。

## 操作清單

| Mode | HTTP | 前端用途／呼叫者 | 回應處理／證據 |
|---|---|---|---|
| `Query` | GET | `QueryServer()` 查指定日期的一般／化療藥物與給藥紀錄 | `QueryDataReceived()` 解析 XML、建立表格；已實測 |
| `Update` | POST | `Update()` 送出新增／修改紀錄與相關記錄資料 | `OnUpdateCompleted()` 讀取 `root` 結果，再查詢；僅觀察 |
| `Delete` | POST | `Delete()` 刪除給藥紀錄，前端會打包相關複核與修改資料 | `OnDeleteCompleted()`；僅觀察，無法判定實體或邏輯刪除 |
| `Authentication` | POST | `CosignUpdate()` 或 `RestrainedDrugDisposeIDPWCheck()` 驗證複核者／管制藥銷毀複核者帳密 | XML `ID`、`PW`；callback 依 `root` 是否為 `OK` 繼續；僅觀察 |
| `Cosign` | POST | `CosignUpdate()` 儲存複核資料；另帶 `Type` | `OnCosignUpdateCompleted()`；僅觀察 |
| `EndTime` | POST | `EndTimeUpdate()` 更新結束時間 | `OnEndTimeUpdateCompleted()`；僅觀察 |
| `ExtravasationEvaluation` | POST | `SaveExtravasationB()` 儲存回血／外滲評估 | 可有 callback 或為 null；僅觀察 |
| `CheckError` | POST | `LogCheckError()` 記錄手圈／藥品條碼核對異常 | 傳 XML，callback 為 null；僅觀察 |

原頁面透過 `NewAjaxEvent(method, "AsynchronousProcessHandler.ashx", queryString, true, xmlBody, callback)` 呼叫。`Query` 無 request body；上述 POST 操作會打包 XML。不要把 Query 的最小參數集合套用到寫入操作；其完整 body、驗證及交易語意未測試。

頁面也使用 `DrugGivenNote.aspx/Cosign`、`GetSelfDiluInfo` 等另一組方法；同名用途不代表同一個 endpoint 或相同契約。

## Query 請求

### 目前專案使用的七個參數

```text
GET /WebApplication/InPatient/Ward/AsynchronousProcessHandler.ashx
    ?Mode=Query
    &AccountIDSE=<INPATIENT_ACCOUNT_ID>
    &Personid=<PERSON_ID>
    &Year=2026
    &Month=10
    &Day=2
    &SESSION=<CURRENT_SESSION>
```

上面換行只為閱讀；實際 URL 是一行，值須用 `URLSearchParams` 編碼。`Personid` 是原請求使用的拼法；網址常見的 `PersonID`、XML 的 `AccountIdse` 與 query 的 `AccountIDSE` 拼法不同，不要直接假設大小寫可互換。

### 原頁面的完整參數表

| 參數 | 意義／原頁面來源 | 刪減結果與實作選擇 |
|---|---|---|
| `Mode` | 固定 `Query` | 移除後 HTTP 200 空 body；保留 |
| `AccountIDSE` | 該次住院帳號；`PatientAccountIDSE`，列表 `NEWSLabel[caseno]` | 移除後 HTTP 500；保留，不以病歷號取代住院帳號 |
| `Personid` | 病人識別；`PersonId` | 移除後 HTTP 500；保留 |
| `ChartNo` | 病歷號；`ChartNo`，列表 `NEWSLabel[chartno]` | 此次可省略；若使用須保留前導零 |
| `Year` | 查詢年 | 移除後 200 XML，但沒有醫囑；保留 |
| `Month` | 查詢月，原頁面可傳不補零值 | 移除後 200 XML，但沒有醫囑；保留 |
| `Day` | 查詢日，原頁面可傳不補零值 | 移除後 200 XML，但沒有醫囑；保留 |
| `Chemo` | 原頁面一般藥物 `false`、化療 `true`；`Catergory_Normal` | 省略後本次仍是相同一般藥物；目前省略。化療／不同預設狀態未實測 |
| `WhichDay` | 原頁面分頁識別 `today`／`lastday`／`nextday` | 省略後醫囑相同，但回應不含此節點；自訂 parser 可省略，沿用原 callback 須保留 |
| `HospitalCode` | 院區；`HospitalCode`，頁面網址使用 `Hosp` | 此次可省略；跨院區解析規則未知 |
| `WardCode` | 病房；`txbWardCode` | 此次可省略，XML 仍回 `Ward`；是否由帳號或 Session 推導未知 |
| `IsBedICU` | ICU 床位標記；`IsBedICU` | 此次一般病房可省略；ICU 未實測 |
| `LoginEmpNo` | 登入者員編；`LoginEmpNo_Name` 以 `_` 分割取首項 | 此次可省略；不代表可繞過登入或權限 |
| `UserIP` | 原頁面提供的 `UserIP` 值 | 此次可省略；不以任意 IP 代替 |
| `SESSION` | 原頁面 `skSession` 或頁面網址 | 目前登入環境中可省略，但專案依使用者要求保留 |

來源頁網址的 `Seed`、`EMRPop`、`PatClass` 沒有出現在此次 Query AJAX 請求中。原頁面的 `QueryServer()` 依 `WhichDay` 選擇目標 div，並將它送往 handler；前／後一天的後端日期計算尚未獨立測試。

### 從 OpenWard 發送的範例

```js
// 在已登入的 OpenWard.aspx 同網域執行；identity 由目前病人清單提供。
async function queryDrugGiven(identity, date, session) {
    const url = new URL('AsynchronousProcessHandler.ashx', location.href);
    url.search = new URLSearchParams({
        Mode: 'Query',
        AccountIDSE: identity.accountId,
        Personid: identity.personId,
        Year: String(date.getFullYear()),
        Month: String(date.getMonth() + 1),
        Day: String(date.getDate()),
        SESSION: session,
    }).toString();
    const res = await fetch(url, {
        credentials: 'same-origin',
        cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/xml');
    if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'ObjectSerializer') {
        throw new Error('不是有效的給藥 XML');
    }
    const drugs = [...doc.querySelectorAll('Today > ActiveDrugs')];
    if (doc.querySelector('GeneralDrugsNo')?.textContent.trim() !== String(drugs.length)) {
        throw new Error('醫令數量不符');
    }
    if (drugs.some(node => node.querySelector('AccountIdse')?.textContent.trim() !== identity.accountId)) {
        throw new Error('病人不符');
    }
    return doc;
}
```

範例沒有呼叫任何寫入 Mode；實際程式另外加入逾時與併發限制。不可將真實 query URL 寫到公開 log。

## 認證、識別與 Session 依賴

- `AccountIDSE` 是住院事件識別，`Personid` 是病人識別，`ChartNo` 是病歷號。此次需要前兩者；一位病人的不同住院事件不能混用。
- 移除 query 中的 `SESSION` 仍成功，只證明同一個已登入瀏覽器中的這次請求成功。沒有測試無 Cookie、過期 session、不同使用者或不同權限。
- 此次從 `OpenWard` 可直接查，沒有先載入病人的 `DrugGivenNote`；不需利用「最近載入的病人」來定位此次資料。
- 不同病人、多分頁、高併發是否影響服務端 Session，尚未做全面測試。整合程式逐筆核對 `AccountIdse`；空清單則沒有逐筆識別可驗證。
- 直接導覽 handler URL 曾遇到 `ERR_BLOCKED_BY_CLIENT`。原頁面同 origin AJAX 仍可成功；這個 client 錯誤不能判定為參數錯誤、Session 失效或 endpoint 不可用。阻擋原因未確認。

`morning-briefing` 沿用原本的 `personIdFromPatientList()`：從目前病房病人清單 Cookie，以住院帳號配對 PersonID，處理舊式 `%uXXXX`／`%XX` 編碼，不以病人姓名或列表順序配對。Cookie 找不到或識別衝突時顯示錯誤，不查另一位病人。這是目前取得參數的方式，並非證明該 Cookie 是 handler 的認證必要條件。

## 回應結構

成功的 Query body 是 XML，不是 JSON，也不是已排版的藥物表格。

```text
ObjectSerializer
├─ NeedOrderCheck
├─ Today
│  └─ ActiveDrugs [每筆醫囑一個]
│     ├─ AccountIdse / PhrOrderIdse / OrderStatus
│     ├─ 藥名、劑量、途徑、頻率、起訖與其他欄位
│     ├─ MAR
│     │  └─ DrugGivenList [樣本每筆醫囑 24 個，Hour=0..23]
│     ├─ DrugATCCodes
│     │  └─ string [零到多個]
│     ├─ IsScanChemoAgreementCount
│     └─ IsSelfTake
├─ WhichDay [省略 query 參數後，此節點可能不存在]
├─ GeneralDrugsNo / ChemoDrugsNo / Ward
├─ NoGiveDrugList
├─ HasTodayChemoOrder
└─ LastInsulinInjSite / LastInsulinInjTime
```

`Today` 是原頁面讀取的集合名稱，不能只因它叫 Today 就認為資料日期固定是系統今天；查詢有自己的年月日。其他日期／化療的 schema 差異未全面驗證。

### 合成、節錄 XML

```xml
<?xml version="1.0"?>
<ObjectSerializer>
  <NeedOrderCheck>false</NeedOrderCheck>
  <Today>
    <ActiveDrugs>
      <AccountIdse>SYNTHETIC_ACCOUNT</AccountIdse>
      <PhrOrderIdse>12345678</PhrOrderIdse>
      <OrderStatus>A</OrderStatus>
      <DrugCode>SYNTHETIC_DRUG</DrugCode>
      <GenericName>範例學名</GenericName>
      <TradeEngName>Brosym</TradeEngName>
      <TradeEngNameComplex>範例藥物 1000 mg/vial</TradeEngNameComplex>
      <OrderDose>500</OrderDose>
      <DoseUnit>mg</DoseUnit>
      <RouteCode>IV</RouteCode>
      <RepeatPatternCode>Q12H</RepeatPatternCode>
      <StartDateTime>0001-01-01T00:00:00</StartDateTime>
      <EndDateTime>0001-01-01T00:00:00</EndDateTime>
      <StartDateTimeShowHH>起時:2025/01/01 21</StartDateTimeShowHH>
      <EndDateTimeShowHH>迄時:2025/01/04 09</EndDateTimeShowHH>
      <MAR>
        <DrugGivenList>
          <OrderIdse>0</OrderIdse>
          <IDSE>0</IDSE>
          <Hour>0</Hour>
          <Minute />
          <OrderDoseUsed>0</OrderDoseUsed>
          <Disposition />
          <GiveDrugDateTime>0001-01-01T00:00:00</GiveDrugDateTime>
        </DrugGivenList>
      </MAR>
      <DrugATCCodes>
        <string>J01CG01</string>
        <string>J01DD12</string>
        <string>J01DD62</string>
      </DrugATCCodes>
    </ActiveDrugs>
  </Today>
  <GeneralDrugsNo>1</GeneralDrugsNo>
  <ChemoDrugsNo>0</ChemoDrugsNo>
  <Ward>SYNTHETIC_WARD</Ward>
</ObjectSerializer>
```

這是結構示例，省略其他欄位與 23 個時段；不是可代表完整回應契約的 fixture，也不是實際病人紀錄。

### 主要欄位判讀

| 欄位／路徑 | 可用資訊與限制 |
|---|---|
| `GeneralDrugsNo`／`ChemoDrugsNo` | 醫囑計數；不是不同藥物種類數 |
| `ActiveDrugs/AccountIdse` | 可逐筆核對目標住院帳號 |
| `PhrOrderIdse` | 醫囑識別；勿直接與 MAR 的記錄 ID 混用 |
| `OrderStatus` | 樣本含 `A`、`D`；目前 parser 只收 `A`，完整狀態表未知 |
| `DrugCode` | 院內藥碼；部分自備／未對應項目出現特殊碼且 ATC 為空 |
| `GenericName` | 有的回傳「自備藥」，不一定是可用的學名 |
| `TradeEngName`／`TradeEngNameComplex` | 商品名／完整顯示名稱；晨間簡報用前者，缺漏再用後者 |
| `OrderDose`／`OrderDoseNumeral`／`DoseUnit` | 處方劑量相關欄位；各數值欄位差異尚未全面驗證 |
| `DoseAndUnit` | 顯示用字串，可能含 XML 跳脫後的 HTML，不宜直接當數值 |
| `RouteCode`／`RepeatPatternCode` | 給藥途徑／頻率，例如 IV、PO、Q12H；完整代碼表未知 |
| `SpecialOrder` | 特殊指示，可能含起訖時間與顯示文字 |
| `Pattern` | 原頁面時段相關資料；完整編碼語意未驗證 |
| `StartDateTime`／`EndDateTime` | 常出現 `0001-01-01T00:00:00`，不可當真實日期 |
| `StartDateTimeShowHH`／`EndDateTimeShowHH` | 帶「起時／迄時」的日期字串；樣本常只到小時，不能推定分鐘精度 |
| `DrugATCCodes/string` | 零至多個 ATC 碼；應以任一碼符合條件判斷 |
| `MAR/DrugGivenList` | 當日各時段槽位與紀錄；24 槽不等於 24 次實際給藥 |
| `DrugGivenList/IDSE` | 空槽樣本為 `0`；非零記錄仍需配合狀態判讀 |
| `Disposition` | 樣本含空值、`0`、`8`；沒有完成完整碼表驗證，不自行映射成已給／未給 |
| `Hour`／`Minute` | 槽位與時間相關資訊；不可未驗證就與其他時間欄位合成精確 timestamp |
| `OrderDoseUsed` | 記錄中的用量相關欄位，與處方 `OrderDose` 分開 |
| `GiveDrugDateTime` | 多筆非零 ID 的紀錄仍為 `0001`，不能只靠它取得實際給藥時刻 |
| `CdssInfo`／各種旗標 | 額外警示與顯示資訊，可能含文字／HTML；空值與完整旗標語意未驗證 |

### 已觀察的醫囑欄位清單

下列名稱來自實際 XML；拼字保持原樣，包括疑似拼字錯誤。只是欄位存在性清單，不是保證每個欄位有值／型別固定的 schema。

| 群組 | 欄位 |
|---|---|
| 識別、條碼與群組 | `GTIN`, `BarcodeRead`, `LabelBarcode`, `AccountIdse`, `PhrOrderIdse`, `MedicationOrderIdse`, `DrugCode`, `CompoundGroupCode`, `GroupOrder`, `OrderSeqNo`, `HospitalCode` |
| 狀態、排程與處方 | `OrderStatus`, `Pattern`, `Disable`, `New`, `OrderStage`, `VerifyStatus`, `EMARCheck`, `OrderChargeType`, `DoseBase`, `RepeatReason` |
| 藥物與顯示 | `GenericName`, `TradeEngName`, `TradeEngNameComplex`, `InjectionDescription`, `SpecialOrder`, `SpecialOrderDisplay`, `InfusionExtentionInfoDiv`, `CdssInfo`, `CdssInfoDisplay`, `PhrVerifyNote` |
| 劑量、頻率與輸注 | `DoseAndUnit`, `GiveDose`, `OrderDose`, `OrderDoseNumeral`, `DoseUnit`, `RouteCode`, `RepeatPatternCode`, `Concentration`, `MilliliterPerHour`, `Limitation`, `PackConvertionRate`, `DiluentAbbr`, `DiluentVolumn`, `Syringe` |
| 起訖、調劑與收藥 | `LastGiveDrugTime`, `CompleteDateTime`, `StartDateTime`, `EndDateTime`, `StartDateTimeShowHH`, `EndDateTimeShowHH`, `LatestDeliverDateTime`, `LatestPrintDateIime`, `LatestWardReceivedDateIime` |
| Pump／特殊劑量 | `IsSelfDiluDrug`, `SelfDiluPumpDose`, `IsPumpAcceptable`, `InjCalculatorJson`, `IsIgnorePumpCosign`, `IsTPNforPump`, `HasSpecificInstruction`, `HasSpecificDose`, `AsOrderJson`, `AsOrderRemark`, `IsRouteContinue` |
| 其他旗標 | `NeedExtravasation`, `IsFallCaution`, `IsDFI`, `IsADC`, `IsEmer`, `IsWardDispense`, `IsDiluent`, `IsChemoDrug`, `IsNoCrushing`, `IsInsulin`, `ShowNPO`, `IsWardDispenseRestrainedDrug`, `IsScanChemoAgreementCount`, `IsSelfTake` |
| 巢狀集合 | `MAR/DrugGivenList`, `DrugATCCodes/string` |

### 已觀察的 MAR 欄位清單

```text
OrderIdse, IDSE, Hour, Minute, OrderDoseUsed, Disposition,
GiveDrugEmpNo, GiveDrugEmpName,
BeforeCosignerEmpNo, BeforeCosignerEmpName, BeforeCosignTime,
AfterCosignerEmpNo, AfterCosignerEmpName, AfterCosignTime,
Concentration, MilliliterPerHour, Remark,
EndGiveDrugEmpNo, EndGiveDrugTime, EndGiveDrugEmpName,
SyringeUsed, DisposeTime, DisposeDose, DisposeEmpNo, DisposeEmpName,
AmpDisappear, DisposeWardCode, InsulinInjSite, GiveDrugDateTime
```

XML 元素可能是空元素 `<X />`。數字、日期、布林在 DOM 中皆先是字串；使用前需按語意驗證，不以空值或 `0001` 取代真實資料。回應包含未直接顯示在藥物表格上的人員、複核、銷毀等資訊。

## 用 ATC 篩選抗感染藥

目前晨間簡報使用以下前綴，任一碼符合就收錄：

| 前綴 | ATC 分類 |
|---|---|
| `J01` | 全身性抗細菌藥 |
| `J02` | 全身性抗黴菌藥 |
| `J04` | 抗分枝桿菌藥 |
| `J05` | 全身性抗病毒藥 |

不能直接用整個 `J` 代替上述集合：`J06` 包含免疫血清／免疫球蛋白，`J07` 包含疫苗。抗感染藥也可能位於其他 ATC 大類，例如腸道抗感染藥 `A07A`、抗寄生蟲藥 `P`；因此這是明確選定的四類集合，不是所有抗感染藥的完整分類。

依據：[WHO Collaborating Centre ATC/DDD 的 J 分類說明](https://atcddd.fhi.no/atc_ddd_index/?code=J&showdescription=yes)。

實際回應中 Brosym 有多個 `J01` 碼；眼用 Tetracycline 為 `S01AA09`，皮膚外用 Aclovir 為 `D06BB03`，不屬於上述集合。分類可查 [S01AA09](https://atcddd.fhi.no/atc_ddd_index/?code=S01AA09&showdescription=no)、[D06BB03](https://atcddd.fhi.no/atc_ddd_index/?code=D06BB03&showdescription=no)。

樣本 26 筆醫囑中有 2 筆沒有 ATC 碼。缺碼代表分類未知，不能宣稱是非抗感染藥；目前實作不以藥名推測，所以缺碼項目不列入。ATC 只決定藥物分類，不表示醫囑有效、已實際給藥、或已完成療程。

## 醫囑日期與晨間簡報的顯示規則

目前實作依序取有效的 `StartDateTime`／`EndDateTime`，預設值 `0001` 則改用 `StartDateTimeShowHH`／`EndDateTimeShowHH`，再 fallback 到 `SpecialOrder` 裡的「起／迄」。開始時間無法取得時報錯，不顯示虛構 D1；找不到結束時間則按沒有結束資料處理。

晨間簡報只列 `OrderStatus=A` 且符合所選四類 ATC 的醫囑。日期篩選沿用原版的日級規則：

```text
開始日期 <= 查詢日期
且（沒有結束資料，或結束日期 >= 查詢日期）
```

今天稍晚才開始，或今天早上已結束，只要狀態仍為 `A` 就仍列入。這是「當日醫囑」視角，不代表列出的每筆藥在查詢當下仍在執行。`D` 狀態的醫囑目前仍排除；日期規則與狀態判讀是兩個獨立條件。

D1 是這張醫囑的開始日期，`D = 查詢日期 - 開始日期 + 1`，以本地日曆日計算。改劑量／重開的新醫囑不會自動合併成同一療程，不能把 D 值直接解讀為連續實際給藥天數。

回歸案例：一筆 Brosym 醫囑 9/29 開始，10/2 09:00 結束、狀態仍為 `A`。若用「結束時間 <= 現在」會在 10/2 下午消失；目前按日期判斷，10/2 仍顯示 D4，10/3 不列入。這也說明不能只靠 `OrderStatus=A` 判定當下仍執行。

## 最小參數刪減測試

先確認完整 15 參數的 AJAX Query 成功，再依序移除。若醫囑與 MAR 的序列化內容相同，就保留刪減；失敗或資料變化就補回。原 callback 相容性另行檢查，不與藥物資料相同性混為一談。

| 順序 | 本次移除 | 結果 | 後續處理 |
|---|---|---|---|
| 基準 | 無 | 200 XML、26 筆 | 作為比較基準 |
| 1 | `IsBedICU` | 200、資料相同 | 保留刪減 |
| 2 | `UserIP` | 200、資料相同 | 保留刪減 |
| 3 | `LoginEmpNo` | 200、資料相同 | 保留刪減 |
| 4 | `Personid` | 500，識別輸入錯誤 | 補回 |
| 5 | `ChartNo` | 200、資料相同 | 保留刪減 |
| 6 | `WardCode` | 200、資料相同，`Ward` 仍為目標病房 | 保留刪減 |
| 7 | `HospitalCode` | 200、資料相同 | 保留刪減 |
| 8 | `Chemo` | 200、資料相同 | 保留刪減 |
| 9 | `WhichDay` | 200、醫囑相同，缺 `WhichDay` | 主測試暫保留以維持 callback 相容；最後再刪減複驗 |
| 10 | `AccountIDSE` | 500，欄位輸入不完整 | 補回 |
| 11 | `Year` | 200 XML、0 筆 | 補回 |
| 12 | `Month` | 200 XML、0 筆 | 補回 |
| 13 | `Day` | 200 XML、0 筆 | 補回 |
| 14 | `SESSION` | 200、資料相同 | 測試保留刪減；正式程式依要求補回 |
| 15 | `Mode` | 200、空 body | 補回 |
| 複驗 | 六參數集合／加 `WhichDay` 的七參數集合 | 兩者均 200、26 筆且醫囑／MAR 相同 | 差別是 `WhichDay` 節點 |

較早的對照：使用者指定的 11 參數集合本來就不含 `Personid`、`LoginEmpNo`、`IsBedICU`、`UserIP`，結果失敗；加入 `IsBedICU`＋`UserIP` 或單補 `LoginEmpNo` 仍失敗。完整基準刪減測試後才確認此次缺少 `Personid` 會觸發相同錯誤。

這些測試是「省略 query key」，不是傳空字串、null 或錯誤值。沒有測試所有排列組合，也不能由這個刪減順序推出每個 key 在所有環境中獨立不必要。

## 空結果與錯誤

| 情境 | 實際回應 | 判讀 |
|---|---|---|
| 成功查詢 | 200、`text/xml`、`ObjectSerializer` | 還須驗證識別與集合 |
| 缺 `Personid` | 500、HTML ASP.NET 錯誤；`請輸入身分證號或病歷號或姓名或員工代碼...` | 堆疊含 `Ward.AsynchronousProcess.Mode_Query()`；訊息未明示哪個參數，需對照測試 |
| 缺 `AccountIDSE` | 500、HTML 錯誤；`欄位輸入不完整` | 不能當作無醫囑 |
| 缺任何年月日 | 200 XML、0 筆 | 200 不證明日期正確；也不能推定病人真的沒有用藥 |
| 缺 `Mode` | 200、空 body | 不是有效 Query 回應 |
| client 導覽阻擋 | `ERR_BLOCKED_BY_CLIENT`，未取得服務端回應 | 與以上服務端結果分開 |

正常無醫囑的合成 XML（`GeneralDrugsNo=0`、空 `Today`）可由目前 parser 處理；尚未用真實無醫囑病人確認服務端是否永遠回相同結構。登入頁／HTML／格式損壞的 XML 會被拒絕，不顯示成「沒有抗感染藥」。

原頁面沿用 `QueryDataReceived()` 時會直接讀取 `WhichDay`；移除該參數後即使醫囑完整，這個 callback 仍可能失敗。專案自訂 parser 不需要此節點。

## 專案整合與驗證

使用程式：[morning-briefing.user.js](../../scripts/morning-briefing.user.js)，輸出版本：[standalone](../../scripts/standalone/morning-briefing.standalone.user.js)。

- `medicationQueryUrl()`：從 OpenWard URL 組相對 endpoint，取得當日年月日，送六參數＋SESSION。
- `fetchAbx()`：一次 GET、`credentials: same-origin`、`cache: no-store`、45 秒 AbortController 逾時。
- `parseMedicationQuery()`：XML 根／格式、醫令筆數、逐筆帳號驗證，再套用 ATC、狀態與日期條件，輸出商品名、途徑、處方提示及 D 值。
- 使用既有 `rxGate`（最多 3 個查詢任務），外層 `HEAVY_POOL=2`；保留原本兩階段簡報架構，管路仍有自己的序列化閘門。沒有為這個 endpoint 測得新的最佳併發數。
- UI 名稱改為「抗感染藥」，反映 J01/J02/J04/J05，不再經過 MedicationHistory GET／POST。

已完成：從 OpenWard 用實作的七個參數取得 26 筆醫囑；13 組合成案例驗證分類、複數 ATC、狀態、XML 格式、帳號與計數檢核等；日期規則恢復後另驗證「今天結束保留 D4、昨天結束排除、今天稍晚開始保留、明天開始排除」。語法、ESLint、既有 NEWS2 測試亦通過。

上述 parser 合成測試是在瀏覽器暫時執行，沒有提交持久化測試檔或真實回應 fixture；不應誤認為 repo 已有可直接重跑的完整 endpoint 測試套件。

## 限制與待驗證

- 化療 `Chemo=true`、省略 Chemo 的預設來源、ICU、其他院區（包括新竹 host）與跨院區識別。
- 無登入 Cookie、過期 SESSION、不同角色、權限不足與認證錯誤格式。
- 真實空醫囑、其他日期、前／後一天、空集合識別、頁面分頁與完整時間範圍語意。
- `OrderStatus`、`Disposition`、`Pattern` 等完整碼表；顯示迄時是否等於停用、排程結束或其他業務事件。
- 起訖分鐘精度、所有日期格式、時區及欄位間一致性；預設值不代表事件未發生。
- 多病人並行查詢的 Session 交互影響、伺服器速率限制與最佳併發。
- 寫入 Mode 的完整 request body、伺服器驗證、資料庫效果、冪等性與錯誤契約。
- ATC 缺碼、院內對應碼品質、複方多碼及不在 J01/J02/J04/J05 的抗感染藥。

不要從 endpoint 名稱推斷伺服器會建立背景工作／佇列；目前只確認前端以非同步 AJAX 呼叫，沒有後端排程實作的證據。

## 更新紀錄

- 2026-10-02：記錄 Query 完整／最小參數、總院實測、XML 已觀察欄位與非 Query 前端呼叫；morning-briefing 改用 OpenWard 直接查詢並保留 SESSION。
- 2026-10-02：日期顯示規則恢復日級起訖判斷，對應 morning-briefing 1.3.1；Brosym 在結束當天仍列 D4。
