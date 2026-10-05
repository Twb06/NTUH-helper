---
id: "nursing-vital-sign-draw-chart"
title: "VitalSign_DrawChart.aspx：生命徵象表格與液體攝入／排出量摘要"
path: "/WebApplication/InPatient/Nursing/VitalSign_DrawChart.aspx"
verification: "observed"
last_verified: "2026-10-02"
verified_sites: []
source_pages:
  - "/WebApplication/InPatient/Nursing/VitalSign_TPR.aspx"
consumers: []
operations:
  - name: "DateIOData"
    method: "POST"
    selector: "DataInfo@DataType=DateIOData, mainMode=5, ActionType=1"
    effect: "unknown"
    verification: "observed"
  - name: "TableData"
    method: "POST"
    selector: "DataInfo@DataType=TableData, mainMode=0, ActionType=1"
    effect: "unknown"
    verification: "observed"
---

# VitalSign_DrawChart.aspx

## 用途與範圍

使用者提供由 `VitalSign_TPR.aspx` 發出的 POST 請求，body 為 `DataInfo` XML。`DataType='DateIOData'` 對應使用者確認的 I/O Summary 回應，記錄液體攝入與排出量摘要（**Fluid intake and output summary，I/O**），並顯示淨平衡（**net fluid balance**）。這些是本文採用的通用用語；原系統名稱與欄位拼法保留不變。

「液體」比「水」更能涵蓋此類紀錄的範圍。醫療上的 fluid balance monitoring 是記錄液體 intake 與 output 以評估平衡；output 可涵蓋尿液、嘔吐物與引流等，不能單純等同尿量。術語依據：[West Suffolk NHS 的 Fluid balance 說明](https://www.wsh.nhs.uk/CMS-Documents/Patient-leaflets/Nephrology/6738-1-Fluid-balance.pdf)。此來源支持通用術語，不證明院內 endpoint 的實際收錄項目。

另提供 `DataType=TableData`、`mainMode=0`、`ActionType=1` 的請求，並確認附件 XML 是該操作的回應。樣本含生命徵象與護理紀錄的表格定義及紀錄內容；兩個操作共用 endpoint，但回應契約分開記錄。

兩筆請求均指定 2026-09-26 00:00:00 至 2026-10-02 23:59:59，並帶 `DateTimeCount='7'`、`Unit='Day'` 與 `TableNumber='7'`。這些值與七個日曆日的範圍相符，但日期邊界是否包含、每日統計切點及各參數間的關係均未驗證。

## 證據與驗證環境

| 項目 | 紀錄 |
|---|---|
| 觀察日期／時區 | 2026-10-02，Asia/Taipei；來自提供的請求與兩種操作的回應附件，未重新執行 |
| Host／院區 | `ihisaw.ntuh.gov.tw`；未實測院區，`verified_sites` 留空 |
| 來源頁 | `/WebApplication/InPatient/Nursing/VitalSign_TPR.aspx` |
| 證據 | 使用者提供兩筆 `fetch` 與兩份 XML 附件，分別確認為 TableData 與 I/O Summary 回應；未提供 HTTP status 或 response headers |
| 登入環境 | 請求設定 `credentials: include`，同 origin；Cookie 與 SESSION 的必要性未測試 |
| 驗證程度 | `observed`；metadata 的 `last_verified` 記錄此次觀察日期，不代表成功查詢 |

範例已將真實 SESSION、住院帳號與病人識別替換成占位符；日期保留作為請求參數示例。附件只用來分析結構，不複製進 repo；回應範例使用合成日期、值與識別。

## 操作清單

| 操作 | HTTP／分派參數 | 業務效果 | 驗證程度 |
|---|---|---|---|
| `DateIOData` | POST；XML attributes `DataType=DateIOData`、`mainMode=5`、`ActionType=1` | 液體攝入／排出量摘要查詢；伺服器效果未直接驗證，metadata 使用 `unknown` | 使用者提供請求與 I/O Summary XML 回應，未直接實測 |
| `TableData` | POST；XML attributes `DataType=TableData`、`mainMode=0`、`ActionType=1` | 推測為表格資料查詢；metadata 使用 `unknown` | 使用者提供請求與確認配對的 XML 回應，未直接實測 |

這裡只記錄上述兩組參數組合，不推定此 `.aspx` 的其他操作或代碼定義。

## 請求與參數

```text
POST https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/VitalSign_DrawChart.aspx
Content-Type: text/plain;charset=UTF-8

來源頁：
https://ihisaw.ntuh.gov.tw/WebApplication/InPatient/Nursing/VitalSign_TPR.aspx?SESSION=<CURRENT_SESSION>&AccountIDSE=<INPATIENT_ACCOUNT_ID>&PersonID=<PERSON_ID>
```

請求 URL 本身沒有 query string。上述識別欄位出現在來源頁／referrer，沒有出現在 POST body；不能據此判定伺服器如何選定病人，也不能假設可直接切換 referrer 來查不同病人。

### DateIOData 完整 body 範例

下列保留提供的全部 attributes、大小寫、空字串與日期值，僅增加換行方便閱讀。

```xml
<DataInfo
  Check='Fri Oct 02 2026 18:31:45 GMT+0800 (Taiwan Standard Time)'
  DataType='DateIOData'
  mainMode='5'
  ActionType='1'
  DateTimeCount='7'
  Unit='Day'
  TableNumber='7'
  NumberOfChart=''
  ChartFieldOne=''
  ChartFieldTwo=''
  ChartFieldThree=''
  ChartFieldFour=''
  ChartColorOne=''
  ChartColorTwo=''
  ChartColorThree=''
  ChartColorFour=''
  EndYear='2026'
  EndMonth='10'
  EndDay='2'
  EndHour='23'
  EndMinute='59'
  EndSecond='59'
  StartYear='2026'
  StartMonth='9'
  StartDay='26'
  StartHour='00'
  StartMinute='00'
  StartSecond='00'
></DataInfo>
```

### TableData 完整 body 範例

與 `DateIOData` 的差異是 `DataType`、`mainMode`、`NumberOfChart` 及八個圖表欄位。`'null'` 是 XML attribute 中的字串，不是 JavaScript `null`，也不等於空字串。

```xml
<DataInfo
  Check='Fri Oct 02 2026 18:31:45 GMT+0800 (Taiwan Standard Time)'
  DataType='TableData'
  mainMode='0'
  ActionType='1'
  DateTimeCount='7'
  Unit='Day'
  TableNumber='7'
  NumberOfChart='0'
  ChartFieldOne='null'
  ChartFieldTwo='null'
  ChartFieldThree='null'
  ChartFieldFour='null'
  ChartColorOne='null'
  ChartColorTwo='null'
  ChartColorThree='null'
  ChartColorFour='null'
  EndYear='2026'
  EndMonth='10'
  EndDay='2'
  EndHour='23'
  EndMinute='59'
  EndSecond='59'
  StartYear='2026'
  StartMonth='9'
  StartDay='26'
  StartHour='00'
  StartMinute='00'
  StartSecond='00'
>
</DataInfo>
```

下表的觀察值以 `DateIOData` 為基準；`TableData` 的差異已列在上述完整範例。

Body 是 XML 文字，但原請求的 Content-Type 是 `text/plain;charset=UTF-8`，不是 `application/xml`；未測試改用其他 Content-Type。所有參數必要性均未知，空字串不等於可以省略 attribute。

| Attribute | 觀察值 | 意義／驗證限制 |
|---|---|---|
| `Check` | 上述日期時間字串 | 看似請求生成時間；用途、格式要求及是否影響快取未知 |
| `DataType` | `DateIOData` | 選擇 I/O Summary 資料（依使用者確認與回應標題）；另觀察 `TableData`，其餘值未知 |
| `mainMode` | `5` | `DateIOData` 使用 `5`，`TableData` 使用 `0`；完整定義未知 |
| `ActionType` | `1` | 動作碼；不能僅由 `1` 推定讀寫效果 |
| `DateTimeCount` | `7` | 看似期間數量；與起訖日期的優先關係未知 |
| `Unit` | `Day` | 看似以日為單位；其他單位與大小寫容忍度未知 |
| `TableNumber` | `7` | 看似表格數量；是否等於天數未知 |
| `NumberOfChart` | 空字串 | 圖表數量相關欄位；用途未知 |
| `ChartFieldOne`、`ChartFieldTwo`、`ChartFieldThree`、`ChartFieldFour` | 全為空字串 | 圖表欄位相關設定；空值預設行為未知 |
| `ChartColorOne`、`ChartColorTwo`、`ChartColorThree`、`ChartColorFour` | 全為空字串 | 圖表顏色相關設定；空值預設行為未知 |
| `StartYear`、`StartMonth`、`StartDay` | `2026`、`9`、`26` | 指定開始日期；月日原值未補零 |
| `StartHour`、`StartMinute`、`StartSecond` | `00`、`00`、`00` | 指定開始時間；是否包含此邊界未知 |
| `EndYear`、`EndMonth`、`EndDay` | `2026`、`10`、`2` | 指定結束日期；日原值未補零 |
| `EndHour`、`EndMinute`、`EndSecond` | `23`、`59`、`59` | 指定結束時間；是否包含此邊界未知 |

原請求另外設定 `method: POST`、`mode: cors`、`credentials: include`、`Accept: */*` 與 `Accept-Language: zh-TW,en-US;q=0.9,en;q=0.8`。提供的瀏覽器 headers 亦含 `User-Agent`、`Sec-GPC` 與 `Sec-Fetch-*`；此處記錄其存在，不將它們列為已確認必要的 API 參數，也未建立最小可執行 fetch 範例。

## 認證、Session 與前置狀態

已觀察同網域請求帶 `credentials: include`，來源頁 query 有 `SESSION`、`AccountIDSE`、`PersonID`。尚未確認伺服器是否依 Cookie、Session 中的目前病人、來源頁初始化或 referrer 取得病人資訊。

尚未測試能否從 `OpenWard.aspx` 直接呼叫、是否必須先載入 `VitalSign_TPR.aspx`，或不同病人請求是否會共享／改變 Session 狀態。

## 回應結構與判讀

### DateIOData

使用者確認第二份附件是 I/O Summary（液體攝入與排出量摘要）。依前述 `DateIOData` 請求記錄此操作的回應；未直接重播請求，HTTP status 與 Content-Type 仍未知。

此 XML 是供前端建立 SVG 的描述資料，不是 `TableData` 的紀錄表格，也不是原生 `<svg>` 文件。根節點為小寫 `root`，樣本包含以下結構：

| 路徑／節點 | 已觀察結構與判讀 |
|---|---|
| `root/SvgAreaElement` | 兩個區域描述；子元素 `objType`、`attId`、`attParentId`、`attEvent`、`attFunction`、`attClassName`；區域 ID 包含 `IO`、`IOSummery` |
| `root/IO` | attribute `appellation="I/O(Net)"`；包含摘要文字與圖形元素 |
| `IO/SvgTextElement` | 子元素 `objType`、`attArea`、`attX`、`attY`、`attValue`、`attEvent`、`attFunction`、`attClassName`；部分另有 `attCustomizeStyle` 或 `attTime`、`attTipValue`，並可帶 `parentID` attribute |
| `IO/SvgGraphElement` | 子元素 `objType`、`attArea`、`attX1`、`attY1`、`attX2`、`attY2`、`attEvent`、`attFunction`、`attClassName`；描述繪圖座標，不是另一筆攝入／排出量 |
| `root/Range` | 多個文字節點；樣本值含 `B1`、`DU`、`S1`、`C1`、`DS`、`IO`，語意未驗證 |

區域名稱原樣拼為 `IOSummery`。不要自行改成 `IOSummary`，也不要將所有 `SvgTextElement` 視為臨床資料：樣本同時含標題、`test` 與摘要字串。

樣本標題為 **`I/O(Net) 8AM-8AM`**。這顯示摘要標示早上 8 點至次日早上 8 點的時段，與請求的 `00:00:00–23:59:59` 不同；各欄對應哪一天、是否為完整 24 小時、未完成時段如何處理仍需前端／畫面對照，不能直接依 request 日期當成午夜切日的每日總量。

#### 摘要值與合成範例

樣本摘要文字形式為 `攝入量/排出量(淨平衡)`，可出現括號中的負數。液體淨平衡通常以攝入量減排出量表示；此處的值順序依 I/O 標題與使用者用途說明解讀，單位、計算明細及收錄項目尚未確認。原回應未顯示明確的體積單位，不能直接將數值標為 mL。

以下只示意摘要文字元素，數值皆為合成，不是完整 SVG 描述或可重播 fixture：

```xml
<root>
  <IO appellation="I/O(Net)">
    <SvgTextElement>
      <objType>text</objType>
      <attArea>IOSummery</attArea>
      <attX>100</attX>
      <attY>20</attY>
      <attValue>1200/1500(-300)</attValue>
      <attEvent>none</attEvent>
      <attFunction>none</attFunction>
      <attClassName>none</attClassName>
    </SvgTextElement>
  </IO>
</root>
```

解析需先辨識摘要區域及文字用途，再處理數值；日期映射可能涉及座標與原頁面欄位排列，未驗證前不以元素順序推定日期。樣本未提供明確的病人識別、完整 intake/output 細項、各數值單位或空值規則，也不能從摘要判定各類液體來源是否全數收錄。

### TableData：已確認配對的 XML 樣本

使用者確認附件是 `TableData` 請求的回應。附件可解析為 XML，根節點為小寫 `root`；HTTP status、Content-Type 與原頁面的解析程式仍未提供。這是回應結構的觀察，verification 保持 `observed`。

| 路徑／節點 | 已觀察結構與判讀 |
|---|---|
| `root/TableActionInfo` | attribute `isReload="True"`；如何影響前端重載未驗證 |
| `root/TreeView/Leave2` | 各項目的 `id`；節點名原樣為 `Leave2`，文字可為空白 |
| `root/TableRow` | attributes `kind`、`group`、`name`、`ChartColor`、`ChartIsShow`；定義表格列 |
| `TableRow/TableColumn` | 每日欄位；包含顯示設定、容器識別與日期，不是實際測量紀錄 |
| `root/MainInfo` | attributes `isCloseWin`、`MainStartTime`、`MainEndTime`；前端行為及時間語意未驗證 |
| `root/TableRecords` | attributes `Kind`、`Group`、`RecordAreaID`、`SerialNo`、`RestroeGroupFormat`、`AccessStates`、`GroupMembers`；可能沒有子紀錄 |
| `TableRecords/TableRecord` | attribute `RecordAreaID`；將紀錄放入某個表格日期容器 |
| `TableRecord/TableRecordContent` | 一筆紀錄的顯示值、時間、識別、人員及修改資訊；一個日期容器可有多筆 |

`TableRow` 使用小寫 `kind`、`group`，`TableRecords` 使用大寫 `Kind`、`Group`；`RestroeGroupFormat` 與 `attModifyDatetime` 也保留樣本拼法。XML parser 應保持大小寫與名稱。

依使用者補充，每個病人的欄位集合可能不同。較通用的群組包括 `TPR`、`BloodPressure`、`BloodSugar`、`PhysicalWeight`、`ComaIndex`、`SpO2`、`StoolFrequencyYesterday`；此清單無優先序，不代表每位病人都會回傳，也不是完整或固定 schema。

附件另觀察到 `PainIndex`、`PhysicalHeight`，以及 `CustomKind` 的身體清潔與腿圍。這些屬於此次樣本的項目，不應推定其他病人有相同欄位。

解析時應遍歷實際回傳的 `TableRow` 與 `TableRecords`，以 `kind/group`（紀錄側為 `Kind/Group`）對應類別，以 `RecordAreaID` 關聯日期容器。不要依固定列位置、上述列舉順序或自訂群組代碼取值。未知群組應保留其原始代碼與名稱；群組未出現、群組存在但沒有紀錄、紀錄值為 `0` 是不同情況，不能一律視為零。

#### 欄位清單

`TableColumn` 的子元素：

```text
objType, attClass, attWidth, attParentId, attContents, attId,
attTime, attRepresentationType, attEvent, attFunction
```

`TableRecordContent` 的子元素：

```text
objType, attClass, attWidth, attId, attValue, attTime,
attCurrentUser, attCreateEmpno, attCreateEmpName, attCreateDateTime,
attModifyEmpno, attModifyDatetime, attModifyEmpName,
attNote, attDeleteModifyReason, attStatus, attEvent, attFunction
```

`attId` 亦可帶 `RecordAreaID` attribute。容器 ID 與紀錄 ID 看似包含種類、群組、日期區間、紀錄時間與識別碼；未驗證完整編碼契約，應當作識別字串，優先用明確的 `RecordAreaID` 關聯，不依拆字串推定病人或業務識別。

#### 合成結構範例

以下是刪減過的示意 XML，日期、數值與 ID 皆為合成，省略人員、備註及多數顯示欄位。不是可直接重播的完整回應 fixture。

```xml
<root>
  <TableActionInfo isReload="True" />
  <TreeView><Leave2 id="SpO2_2"> </Leave2></TreeView>
  <TableRow kind="VitalSign" group="SpO2" name="血氧濃度"
            ChartColor="F08080" ChartIsShow="false">
    <TableColumn>
      <attParentId>SpO2_2</attParentId>
      <attContents>none</attContents>
      <attId>SYNTHETIC_DAY_CELL</attId>
      <attTime>2030/1/1</attTime>
    </TableColumn>
  </TableRow>
  <TableRecords Kind="VitalSign" Group="SpO2" RecordAreaID="none"
                SerialNo="none" RestroeGroupFormat=""
                AccessStates="none" GroupMembers="none">
    <TableRecord RecordAreaID="SYNTHETIC_DAY_CELL">
      <TableRecordContent>
        <attId RecordAreaID="SYNTHETIC_DAY_CELL">SYNTHETIC_RECORD_ID</attId>
        <attValue>98%</attValue>
        <attTime>2030/1/1 08:00:00</attTime>
        <attStatus>N</attStatus>
      </TableRecordContent>
    </TableRecord>
  </TableRecords>
</root>
```

#### 解析限制

- `attValue` 是顯示字串，可能含單位、組合值或格式標記；不能全部轉為單一數字。昏迷指數樣本含 `@~sub~@`、`@~/sub~@`，看似下標顯示標記，其轉換規則未驗證。
- 樣本有字串 `none`、`None`、`無`、空字串及數字字串 `0`。應按欄位判讀，不能一律當成零或無紀錄。
- `attTime` 與建立／修改時間是不同欄位；日期字串有補零與未補零形式，且不帶明確時區。不要只靠宿主環境的 `Date.parse()` 推定時間。
- 樣本 `attStatus` 包含 `N`；完整狀態碼表未知，不能直接解讀為有效、正常或未刪除。
- `attCurrentUser`、建立／修改人員與備註可能含識別或醫療資訊；文件與 fixture 需去識別化。
- 樣本未看到明確的 `PersonID`、`AccountIDSE` 或 `ChartNo` 元素；紀錄 ID 不能當作病人驗證。病人一致性仍需其他證據。

## 空結果與錯誤

未觀察正常空結果、登入失效、病人狀態缺失或參數錯誤的回應。日後驗證需同時檢查 status、Content-Type、body 及病人一致性，不能只以 HTTP 200 判定成功。

## 最小參數與驗證紀錄

目前有兩組完整請求與使用者提供的兩種操作 XML 樣本，沒有直接重播成功的回應基準，也沒有做刪減、空值或錯誤值測試。上述所有 attributes 均保留在範例中；沒有宣稱任何欄位可省略。

## 專案整合

本專案尚未使用 `VitalSign_DrawChart.aspx` 的這兩組操作，因此 `consumers` 留空。現有程式對 `VitalSign_TPR.aspx` 的連結不代表已整合這個 POST endpoint。

## 限制與待驗證

- `mainMode=5`、`ActionType=1` 的完整定義與業務效果。
- `DateIOData` 的 SVG 文字與日期對應、8AM–8AM 時段的日期歸屬與單位；`TableData` 的完整欄位語意、狀態碼與顯示標記轉換。
- 兩個操作的病人識別、各數值單位、每日統計切點、空結果與錯誤契約。
- Cookie／SESSION／來源頁／referrer 的必要性，以及直接查詢和多病人並行時的 Session 行為。
- 起訖邊界、時區、`DateTimeCount`／`Unit`／`TableNumber` 的關係與日期範圍限制。
- 最小參數、空 attribute 的預設行為、`Check` 的用途，以及不同院區與登入角色。

## 參考來源與更新紀錄

- 2026-10-02：依使用者提供的 fetch 記錄 `DateIOData` POST、完整 XML attributes 與來源頁；去識別化並標記為 `observed`，I/O Summary 用途仍為推論。

- 2026-10-02：補入 TableData 完整請求；使用者確認附件與此操作配對，記錄 XML 表格／紀錄結構、大小寫、空值標記與解析限制，提供合成範例；未將原始附件保存到 repo。
- 2026-10-02：依使用者補充，記錄病人間欄位集合可不同、較通用群組無優先序，並說明依實際回應辨識群組及區分缺欄位、空紀錄與零值。
- 2026-10-02：依使用者提供的 I/O Summary XML 補入 DateIOData 回應結構；採用液體攝入／排出量與液體淨平衡用語，記錄 `IOSummery` 原拼法及 8AM–8AM 標題，保留日期歸屬、單位與細項待驗證。
