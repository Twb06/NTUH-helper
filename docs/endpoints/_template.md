---
id: "replace-me"
title: "Endpoint 名稱"
path: "/WebApplication/..."
verification: "observed"
last_verified: "YYYY-MM-DD"
verified_sites: []
source_pages: []
consumers: []
operations:
  - name: "查詢操作"
    method: "GET"
    selector: "Mode=..."
    effect: "unknown"
    verification: "observed"
---

# Endpoint 名稱

## 用途與範圍

說明要取得／修改什麼資料、病人與日期範圍、查詢或寫入。區分前端行為與尚未看到的後端實作。

## 證據與驗證環境

| 項目 | 紀錄 |
|---|---|
| 日期、院區 | 待填 |
| 來源頁 | 待填 |
| 登入環境 | 待填；不要填真實 SESSION／Cookie |
| 證據 | 前端程式／Network／直接請求／合成測試 |
| 未驗證項目 | 待填 |

## 操作清單

| 操作 | HTTP／分派參數 | 業務效果 | 驗證程度 |
|---|---|---|---|
| 待填 | 待填 | 查詢／寫入／未知 | 已實測／僅觀察／推論 |

## 請求與參數

| 參數 | 來源 | 意義 | 必要性／測試結果 |
|---|---|---|---|
| 待填 | 待填 | 待填 | 待填 |

提供占位符請求範例；注明 URL encoding、大小寫與前導零。若不同操作使用不同 body，分開說明。

## 認證、Session 與前置狀態

是否需要 Cookie、Session、特定 origin、先開某頁？有沒有伺服器端的目前病人狀態？哪些是已實測，哪些未知？

## 回應結構與判讀

提供合成 XML／JSON／HTML 範例。說明根節點、集合、識別欄位、空值、預設值、日期、狀態碼及不能直接推定的語意。

## 空結果與錯誤

說明 HTTP status、Content-Type、body；不要把 HTTP 200 當成查詢成功。

## 最小參數與驗證紀錄

記錄基準、刪減順序、成功標準及每次結果。注明只移除參數、傳空字串、傳 null 與錯誤值是不同測試。

## 專案整合

連到使用程式，說明逾時、併發、病人驗證、日期與其他業務篩選。

## 限制與待驗證

列出可能影響未來使用的未驗證條件，不以猜測填補。

## 參考來源與更新紀錄

本地程式連結、外部官方分類說明；日期＋具體變更。不放真實登入／病人資料。
