# Endpoint 目錄

此目錄記錄實際觀察、測試與使用中的院內介面，不代表院方公開或保證相容的 API。驗證日期與院區是結論的一部分。

## 已記錄介面

| ID | 路徑／操作 | 用途 | 驗證狀態 | 院區／來源頁 | 最近驗證 | 使用程式 |
|---|---|---|---|---|---|---|
| `ward-asynchronous-process` | `Ward/AsynchronousProcessHandler.ashx?Mode=Query` | 指定住院帳號、指定日期的醫囑與給藥 XML | Query 已實測；其他 Mode 僅讀過呼叫程式 | 總院 T0／OpenWard、DrugGivenNote | 2026-10-02 | morning-briefing |
| `nursing-vital-sign-draw-chart` | `Nursing/VitalSign_DrawChart.aspx`；XML `DataType=TableData/DateIOData` | 生命徵象／護理表格；液體攝入／排出量摘要 | 兩種操作均有使用者提供的 XML 回應；未直接實測 | `ihisaw.ntuh.gov.tw`（院區未實測）／VitalSign_TPR | 2026-10-02（觀察） | 尚未整合 |

詳細內容：[AsynchronousProcessHandler.ashx](asynchronous-process-handler.md)。

詳細內容：[VitalSign_DrawChart.aspx](vital-sign-draw-chart.md)。

## 建議格式：Markdown＋YAML front matter

每個 handler／服務先寫一份 Markdown，在檔案開頭用 YAML front matter 記錄固定 metadata。本文用固定段落描述請求、回應、狀態依賴、證據與限制。新增文件可複製 [範本](_template.md)。

這種格式同時適合人、搜尋工具與程式讀取：

- Markdown 可直接在 GitHub 閱讀、審查 diff，容易記錄 XML、HTML、表單與實測過程。
- Front matter 提供穩定的 ID、路徑、院區、操作及驗證日期，日後可產生索引或搜尋介面。
- 文字保留「已實測」「僅觀察呼叫」「推論」「未知」的區別，避免把一次成功測試寫成普遍保證。
- Session 是否有效、是否需要先開某頁、回應是否依賴目前病人等條件，可比單純 method/path 更清楚地描述。

建議目錄：

```text
docs/
  README.md
  endpoints/
    README.md
    _template.md
    asynchronous-process-handler.md
    # 未來：outer-data.md、catheter-care-handler.md 等
    # 未來需要回歸測試時，再增加 fixtures/<endpoint-id>/
```

先用一份文件描述 handler 的多個 Mode；若某個操作很複雜，再拆成子目錄，保留原 handler 的索引。不要把同一份參數表同時人工維護在 Markdown、JSON 與 YAML 三處。

## Metadata 約定

| 欄位 | 意義 |
|---|---|
| `id` | 穩定且唯一的識別，使用小寫連字號 |
| `title` | 介面名稱 |
| `path` | 不含真實識別、Session 的路徑 |
| `verification` | `observed`、`tested`、`partial`、`stale`；整個文件的概況 |
| `last_verified` | `YYYY-MM-DD` 字串 |
| `verified_sites` | 已實測的院區，不是所有可能適用院區 |
| `source_pages` | 最初觀察或實測的來源頁路徑 |
| `consumers` | 專案中使用此介面的程式路徑 |
| `operations` | 每個 Mode／方法自己的 HTTP method、effect、verification |

`effect` 使用 `read`、`write`、`mixed` 或 `unknown`；`read` 表示業務上查詢資料，不保證伺服器不寫存取日誌或不更新 Session。

## 每次新增或更新應留下的資訊

1. 解決什麼問題、查詢範圍及是否改變業務資料。
2. 原頁面如何呼叫；直接呼叫是否可行；是否需要先載入其他頁面。
3. 參數名稱、大小寫、來源、意義與「必要」的測試證據。
4. 回應格式、識別欄位、空結果、錯誤與預設值的判讀。
5. 驗證日期、院區、登入環境、比較方式、刪減順序或測試組合。
6. 目前實作的選擇，以及仍未驗證的部分。

原始 URL、HAR、回應 XML 可能含登入憑證與醫療資訊。保留去識別化的摘要與合成範例；需要 fixture 時使用合成資料，且注明哪些欄位被刪除或替換。

## 何時再加 OpenAPI／結構化 catalog

當介面契約已穩定，且需要生成 client、驗證請求或接入 API 工具時，可以補 OpenAPI。現階段優先記錄事實：舊式 `.ashx` 的 Mode 分派、WebForms 隱藏欄位、XML 與 Session 中的目前病人狀態，不能只靠一份看似標準的 schema 說明。

Endpoint 累積到需要自動搜尋時，可由 front matter 產生 `catalog.json`，以 Markdown 為唯一維護來源。不要現在建立尚無使用者的生成工具。
