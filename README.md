# Hospital-helper

醫院自動化助手工具集，協助行政作業自動化。

## 📖 安裝教學

> 👉 **[點此開啟互動式安裝教學](https://daniel0128-tw.github.io/ntuh-helper-docs/tutorial.html)**（含 Tampermonkey 安裝、開啟使用者指令碼、腳本安裝、書籤工具安裝、**DevTools 模式**）

本專案提供三種使用方式（Tampermonkey／DevTools Snippet／Local Overrides），依環境擇一即可 👉 [三種安裝方式比較](#-三種安裝方式擇一即可)

## 專案內容

### 呈現資料型

從頁面擷取資料並整理成易讀格式。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `chart-medication` | 藥歷圖整理用藥為「商品名 起日-迄日」，區分進行中／已停用並顯示療程天數；支援 Progress Note Data Helper 背景抓取，自動選取全部病人類別以完整取得抗生素藥歷 | 通用 | 藥歷圖頁點右上角「整理藥物」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/chart-medication.user.js) |
| `prescription-viewer` | 處方頁整理目前用藥為「商品名 劑量 頻率 途徑 開始日 特殊事項」，院內／自備藥分組，供一眼檢視與複製；也支援背景抓取現行處方 | 通用 | 處方頁點右上角「整理處方」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/prescription-viewer.user.js) |
| `lab-summary` | 整理檢驗報告，自動分類並顯示日期與趨勢；結果可在「趨勢」段落與「表格」對齊兩種呈現間切換，並記住呈現與輸出疏密設定；支援 Culture／PCR、CSF 獨立分組、PCT、抗藥性標註、清單／橫式／綠單模式，以及背景抓取檢驗摘要 | 通用 | 報告頁點右下角「整理檢驗」，結果框標題列可切換趨勢／表格與輸出疏密 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js) |
| `morning-briefing` | 晨間簡報：病房列表一鍵在新分頁產生「昨夜狀態」總覽，依列表順序列出所有病人，一行並排兩人；每人附生命徵象圖、給氧／尿量變化、現行抗生素（藥歷頁院方分類）與管路天數、新檢驗與影像報告、昨夜醫囑變更（背景載入，有就亮「新醫囑」） | 通用 | 病房列表查詢區點「晨間簡報」（時間窗固定為前一日 17:00 起，週一回溯到週五） | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/morning-briefing.user.js) |
| `rounds-sheet` | 查房單：病房列表一鍵產生可編輯、可列印的 A4 查房單（一頁 11 位），自動帶入病人資料及「准」連結的預出院／已出院日期。頁首 CR／VS 分列，自動配對姓名、員編與簡碼，可新增人員或選擇僅此頁／所有頁面移除。右側抗生素、管路、生命徵象等資料塊可拖入同一病人欄位，手動填寫與人員增刪選擇自動暫存 | 通用 | 病房列表查詢區點「查房單」，頁首用「＋／−」增刪人員，填寫後按「列印」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/rounds-sheet.user.js) |

### 自動執行型

自動完成重複性行政操作。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `NTUH-diagcertificate-filler` | 自動填寫診斷書囑言：點擊浮動按鈕後讀取病歷，依手術流水號背景查詢同意書，優先採用同主治醫師的術名並解析 PDF 帶入參考病名；其他綁定同意書可點擊查閱。支援西元／民國日期，填入後不自動暫存 | 通用 | 診斷書建立區出現後點右下角 📋，確認病名、病歷與手術資料，選擇年制後點「自動填入囑言」，再自行暫存或開立 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js) |
| `op-automation` | 自動估當同工具：批次執行估、當、同（同＝同意書綁定，手術同意書＋麻醉同意書各綁一筆：同主治醫師、醫師確認日 3 個月內、未綁到其他刀，取最新）；支援多筆主治醫師或手術房執行，並分開記憶上次的手術房／主治醫師搜尋條件 | 通用 | 開啟手術排程頁面，可直接點擊右下角「批次執行 估・當・同」，或在批次搜尋面板輸入多筆主治醫師 / 手術房後依序執行；各模式會自動帶入上次輸入 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/op-automation.user.js) |
| `uro-performance` | 泌尿科績效填入工具：上傳刀表病人 CSV，自動填入主治醫師與 R （每月更新工作表） | 泌尿科 | 開啟績效頁面，點擊右下角「績」浮動按鈕，上傳 CSV 後點擊「開始全自動」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/uro-performance.user.js) |
| `zero-performance` | 掛 0% 績效工具：一鍵把指定員編以 0% 掛進當前病人的 R 角色 | 通用 | 開啟績效頁面，點擊右下角「0%」浮動按鈕，輸入員編後點擊「掛 0% 到當前病人」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/zero-performance.user.js) |
| `weekend-progress` | 病房列表一鍵對全病人處理例假日病程，三種模式：**週五預寫**（建立假日草稿並暫存，每天的覆核 VS 由主治班表自動帶入員編，復健科）、**當日確認**（把當天草稿帶入 TPR 與導管後送出）、**複製最新**（複製最新 progress、填 stable 並確認）。主治班表在開過排班頁（`NoticeDrScheduling.aspx`）後自動記下 | 通用（預寫為復健科流程） | 病房列表查詢區，「歷史」按鈕後面的「週末病程」（與「晨間簡報」並排，常駐），點開後選模式；批次進行中右下角顯示進度與終止鈕 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js) |
| `login-helper` | 整合驗證碼辨識、帳號記憶及快速登入，簡化 Portal 登入流程 | 通用 | Portal 登入頁面（Login.aspx）；點已記住的帳號即直接登入，可用帳號旁的 × 移除記錄 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-helper.user.js) |
| `patient-sync-disable` | 停用 Portal 原生 PatientSync，避免切回分頁時自動跟隨其他分頁的病人，讓各分頁保留各自的病人 | 台大／新竹 Portal（`ihisaw`、`hchihisaw`） | 安裝後重新載入已開啟的 Portal 分頁即自動生效；要恢復同步，停用腳本後重新載入各分頁 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/patient-sync-disable.user.js) |
| `notify-record-tab` | 照會紀錄查詢開窗修正：QueryNotifyRecordByDr 的「查」連結改以新分頁開啟查詢結果；NotifyOtherDoctor 的 popup 按鈕改以新分頁開啟正確目標頁面，避免一直開啟目前頁面 | 通用 | 安裝後自動生效，無需額外操作；於 `QueryNotifyRecordByDr.aspx` 點「查」即在新分頁開啟，於 `NotifyOtherDoctor.aspx` 點各 popup 按鈕即在新分頁開啟對應頁面 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/notify-record-tab.user.js) |
| `today-consultation-query` | 照會紀錄頁一鍵查詢今天的照會；凌晨 00:00–07:59 自動查詢昨天至今天。可開啟每 5 分鐘自動查詢及桌面通知，偵測新「待回覆」或「暫存」照會；依照會識別資料去重，通知紀錄保留 1 天 | 通用 | 開啟 `QueryNotifyRecordByDr.aspx` 後，點「今日照會查詢」可立即查詢；點「照會通知」開啟／關閉監控。首次啟用需允許瀏覽器通知 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/today-consultation-query.user.js) |
| `pacs-downloader` | PACS 全序列打包下載器：支援 NTUH PACS Web1／Web2，優先使用 PACS 原生 JPG API 下載完整檢查；`auto` 模式依序嘗試全檢查原生 ZIP、逐張原生下載與 Viewer／Canvas 備援，支援多序列、多影像、原生影像順序保留與檔名清理 | 通用 | 開啟 PACS 檢查頁後，點擊右下角 📦 按鈕。預設會自動選擇下載策略；輸出的 ZIP 檔名會依病歷資料、檢查名稱與檢查日期組成 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/pacs-downloader.user.js) |

### Note 撰寫相關

從 Primary Note 解析內容並自動填入對應欄位。**需要特殊的筆記格式**。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `admission-note-filler` | 自動入摘工具：自動填入紀錄各欄位（主訴、病史、身體診察等），並帶入檢驗結果。產出模板與撰寫規則見 [Admission Note 模板與規則](./scripts/template/admission-note-template.md) | 通用 | 開啟入院紀錄頁面，點擊右下角 🏥 浮動按鈕，貼入筆記後點擊「填入入院紀錄」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/admission-note-filler.user.js) |
| `discharge-note-filler` | 自動出摘工具：自動填入出院病摘各欄位（出院診斷、住院治療經過、併發症等），並帶入檢驗結果。所需筆記格式見 [Primary Note 格式範本](./scripts/template/primary-note-format.md) | 通用 | 開啟出院病摘頁面，點擊右下角 📄 浮動按鈕，貼入筆記後點擊「填入出院病摘」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler.user.js) |
| `discharge-note-filler-oph` | 眼科版出院病摘一鍵出摘：雙擊即完成「欄位預填（空白才寫）、入院紀錄 Ditto 檢查紀錄／影像報告、PAP 取病程 Assessment、R/VS 員編（WardSetVSRS，出院/住院列優先）、檢驗報告開窗＋解析資料、出院預設值（有隔離醫囑則不按）」。面板只顯示結果，按下按鈕前不讀任何 ID | OPH | 出院病摘頁右下角 📄 → 雙擊「🖱️ 雙擊自動填入出院病摘」；過程會有數次整頁重載，勿中途手動點擊 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler-oph.user.js) |
| `progress-note-filler` | 從 Primary note 一鍵自動填入 Progress Note / Weekly Summary / Duty Note（自動新增表單、貼上、暫存），並整合背景抓取的病人資料面板（各區塊標題可點跳轉對應頁面）。所需筆記格式見 [Primary Note 格式範本](./scripts/template/primary-note-format.md) | 通用 | 病程紀錄頁點右下角 📋；先在左上筆記區建立 Primary note，即可一鍵今日更新／填入 progress／Weekly／Duty note；「抓取全部data」整理 vitals、管路、照會、飲食、交班筆記、護理紀錄、影像、Rx、Abx、Lab，各區塊標題可點跳頁；面板上方「✂️ Procedure」頁籤可切到 procedure-note-filler 的面板（需另裝該腳本，未安裝只提示不報錯）；模板下拉下方的「📥 Ditto admission note」不需 Primary note，直接取入院紀錄（臆斷→Problem、O:→Assessment、最底下的 P:→Plan）新增 progress 貼入 PAP 後按確認 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-filler.user.js) |
| `progress-note-data-helper` | Progress Note Filler 的資料抓取引擎：從導管、照會、飲食、護理交班筆記、今日護理紀錄、OuterData、藥歷、處方、檢驗等來源背景抓資料並回傳給 filler。需搭配 `progress-note-filler` 使用 | 通用 | 安裝後無獨立按鈕；在 Progress Note Filler 點「抓取全部data」時自動執行 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-data-helper.user.js) |

## Bookmarklets

| 書籤 | 說明 | 適用範圍 | 使用頁面 | 原始碼 |
|------|------|----------|----------|--------|
| `chart-medication` | 在藥歷圖頁面按書籤，整理抗生素用藥成「商品名 起日-迄日」，自動區分進行中與已停用並顯示療程天數 | 通用 | Portal 藥歷圖（Chart.aspx） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/chart-medication.js) |
| `goto-nursing-handover` | 新開分頁跳轉到該病人的「護理交班」頁面 | 通用 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-handover.js) |
| `goto-nursing-notes` | 新開分頁跳轉到該病人的「護理紀錄」頁面 | 通用 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-notes.js) |
| `goto-emergency` | 新開分頁跳轉到「急診」頁面 | 通用 | Portal 任一網域 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-emergency.js) |
| `renew-orders` | 勾選目前全部 orders，隔離部分自動選擇繼續隔離 | 通用 | Portal renew 頁面 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/renew-orders.js) |
| `login-express` | 1. 首次使用：填寫帳號與密碼，工具會保存 Portal 處理後的雜湊密碼，辨識驗證碼並完成登入；2. 快速登入：後續登入時直接使用已儲存的登入資訊，辨識驗證碼並完成登入；3. 清除資訊：在驗證碼欄輸入 `remove` 後執行，即可刪除已保存的登入資訊。 | 通用 | Portal 登入頁面（Login.aspx） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/login-express.js) |

### 安裝方式

1. 點擊下方表格對應書籤的檔案連結，複製全部內容
2. 在瀏覽器書籤列上按右鍵 → 新增書籤
3. 名稱自訂，網址欄貼上複製的內容
4. 儲存後即可使用


## 🧩 三種安裝方式（擇一即可）

依你的環境選**一種**就好，三種都是同一套腳本：

| | 方法一：Tampermonkey | 方法二：DevTools Snippet | 方法三：Local Overrides |
|---|---|---|---|
| **適合環境** | **個人電腦**（可自行安裝擴充功能） | **醫院／受管理環境**（無法安裝擴充） | 醫院環境，但**不想每次手動執行** |
| 需要什麼 | Tampermonkey 擴充功能 | 只要瀏覽器內建的 DevTools | DevTools ＋ 一個本機資料夾 |
| 安裝次數 | 安裝腳本即可（支援自動更新） | 貼一次，之後就在 snippet 清單裡 | **設定一次**（每個網域各一次） |
| 每次開新分頁 | ✅ 全自動 | ❌ **必須手動執行一次**（DevTools 需開著） | ✅ 開頁自動執行 |
| 跨網域功能 | ✅ 完整（`GM_xmlhttpRequest` 不受 CORS 限制） | ❌ 跨來源被 CORS 阻擋 | ❌ 跨來源被 CORS 阻擋 |
| 設定難度 | ★ | ★★ | ★★★★ |

> 三種方式都使用同一批腳本；DevTools 版單檔**已內含 `GM_*` 相容層**（`localStorage` 版的值儲存、`window.open` 開分頁、`fetch` 版請求）。

## 方法一：Tampermonkey（建議：個人電腦）

最省事、功能最完整：安裝一次後**開頁自動執行**、支援自動更新、跨網域請求可用。

安裝步驟見下方 [安裝指南](#安裝指南)（六個步驟，約 3 分鐘）。

## 方法二：DevTools Snippet（建議：醫院環境）

**不需安裝任何擴充功能**，貼進瀏覽器內建的開發者工具即可使用。

### 使用方式

1. 在目標頁面按 **F12** 開啟 DevTools
2. 切到 **Sources → Snippets**（左側 `>>` 可展開）
3. 按 **＋ New snippet**，命名（例如 `diag`），把 `scripts/devtools-snippets/{script-name}.devtools.js` **整個內容貼進去**
4. 之後在該頁面只要點擊 snippet → **Ctrl + Enter** 執行（不必重新貼上）

### ⚠ 每次開新分頁／重新載入都要再做一次

- **Snippet 不會自動執行**（這是瀏覽器本身的限制，不是本專案的問題）：每次頁面載入——**開新分頁、重新整理、換病人、換頁籤**——都要**再手動按一次** `Ctrl + Enter`。
- 是「再執行一次」，不是「重新貼一次」：snippet 內容存在瀏覽器設定內，**DevTools 關掉再開、瀏覽器重開通常仍在**；但在**無痕模式、公用電腦、瀏覽器設定被清除或還原**時會消失，需要重新貼上。
- 想一次跑多支腳本 → 用下方 **Snippet 管理器**；想**完全不必手動** → 用 **方法三 Local Overrides**（文末）。

### 單檔清單（CI 自動同步）

<!-- DEVTOOLS-SYNC:START -->
> 以下內容由 CI 依 `scripts/devtools-snippets/manifest.json` 自動產生（共 27 支、合計約 1528.4 KB），請勿手動編輯本區塊。

| 單檔 | 大小 | 跨來源限制 |
|---|---|---|
| [`NTUH-diagcertificate-filler-oph.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/NTUH-diagcertificate-filler-oph.devtools.js) | 93.8 KB | — |
| [`NTUH-diagcertificate-filler.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/NTUH-diagcertificate-filler.devtools.js) | 120 KB | ⚠ github.com, raw.githubusercontent.com |
| [`admission-note-filler-oph.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/admission-note-filler-oph.devtools.js) | 99.4 KB | — |
| [`admission-note-filler.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/admission-note-filler.devtools.js) | 19.5 KB | — |
| [`autoext.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/autoext.devtools.js) | 19.6 KB | — |
| [`chart-medication.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/chart-medication.devtools.js) | 23.5 KB | — |
| [`check-pending-confirmation.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/check-pending-confirmation.devtools.js) | 21 KB | — |
| [`discharge-note-filler-oph.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/discharge-note-filler-oph.devtools.js) | 91.9 KB | — |
| [`discharge-note-filler.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/discharge-note-filler.devtools.js) | 19.2 KB | — |
| [`lab-summary.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/lab-summary.devtools.js) | 116.5 KB | — |
| [`login-helper.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/login-helper.devtools.js) | 28 KB | — |
| [`login-ocr.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/login-ocr.devtools.js) | 28 KB | — |
| [`morning-briefing.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/morning-briefing.devtools.js) | 68.5 KB | — |
| [`notify-record-tab.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/notify-record-tab.devtools.js) | 5.3 KB | — |
| [`op-automation.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/op-automation.devtools.js) | 68.5 KB | — |
| [`pacs-downloader.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/pacs-downloader.devtools.js) | 52.8 KB | ⚠ * |
| [`patient-sync-disable.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/patient-sync-disable.devtools.js) | 5.2 KB | — |
| [`prescription-viewer.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/prescription-viewer.devtools.js) | 15.7 KB | — |
| [`procedure-note-filler.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/procedure-note-filler.devtools.js) | 120.7 KB | — |
| [`progress-note-data-helper.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/progress-note-data-helper.devtools.js) | 71 KB | — |
| [`progress-note-filler.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/progress-note-filler.devtools.js) | 142.2 KB | — |
| [`rehab-forms.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/rehab-forms.devtools.js) | 30.2 KB | ⚠ eformaw.ntuh.gov.tw |
| [`rounds-sheet.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/rounds-sheet.devtools.js) | 119.6 KB | — |
| [`today-consultation-query.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/today-consultation-query.devtools.js) | 14.3 KB | — |
| [`uro-performance.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/uro-performance.devtools.js) | 39.7 KB | — |
| [`weekend-progress.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/weekend-progress.devtools.js) | 73.1 KB | ⚠ ehisaw.ntuh.gov.tw |
| [`zero-performance.devtools.js`](https://github.com/Twb06/NTUH-helper/blob/main/scripts/devtools-snippets/zero-performance.devtools.js) | 21.2 KB | — |

**在 DevTools 模式下會失去跨來源功能的腳本（4 支）**：

- `NTUH-diagcertificate-filler`（跨來源網域：github.com, raw.githubusercontent.com）
- `pacs-downloader`（跨來源網域：*）
- `rehab-forms`（跨來源網域：eformaw.ntuh.gov.tw）
- `weekend-progress`（跨來源網域：ehisaw.ntuh.gov.tw）

> 這些腳本在 DevTools 模式會跳過該部分功能並於畫面提示；若必須使用，請改用 Tampermonkey 模式。
<!-- DEVTOOLS-SYNC:END -->

### 已知限制

以下腳本在 DevTools 模式下會失去跨來源功能，但**其餘功能照常運作**（腳本會跳過該部分並在畫面提示）：

| 腳本 | 受影響功能 |
|---|---|
| `NTUH-diagcertificate-filler` | 手術同意書清單與 PDF 疾病名稱（術名仍由手術排程表帶入） |
| `pacs-downloader` | PACS 跨站下載 |
| `rehab-forms` | 復健表單資料 |
| `weekend-progress` | 假日病程所需的部分外部資料 |

### 可以自動執行嗎？

**Snippet 本身沒有自動執行機制**：每次頁面載入都要手動執行一次（點 snippet → `Ctrl + Enter`）。若不想每次手動，用文末的**方法三**。

### Snippet 管理器（統整所有腳本）

`scripts/devtools-snippets/_manager.devtools.js`（由 CI 產生）把**所有單檔打包成一支**，提供浮動面板：

- 列出全部腳本，可**個別啟用／停用**（狀態記在 `localStorage`，同網域下次開啟仍在）
- 「▶ 執行啟用中的腳本」一次跑完；每個項目也可單獨執行
- 「全部啟用／全部停用」快速切換
- 「**開頁自動執行**」開關：**只在自動注入情境有效**（方法三 Local Overrides；見下節）。手動執行 snippet 時不會自動跑，仍須按「▶ 執行啟用中」

> 使用方式與單檔相同（貼一次、之後 `Ctrl+Enter`）；因為 snippet 無法自動啟動，仍需在開頁後手動執行一次。若只要一兩支腳本，建議直接用個別單檔而不必載入管理器（檔案較小）。

## 方法三：DevTools Local Overrides（一次性設定、開頁自動執行）

**這是「設定一次就解決」的第三種方式**：把腳本掛進瀏覽器對該網域的回應覆寫，之後**每次開啟頁面就自動載入並執行**，不必再按任何按鍵。

### 可以搭配 `_manager` 嗎？可以，而且這是最推薦的組合

`_manager.devtools.js` 只是一段普通 JavaScript，透過 Local Overrides 自動注入時：

1. 每次頁面載入，管理器會**自動被執行**（不再需要手動按）
2. 面板會照你上次的設定**自動執行所有「啟用中」的腳本**
3. 若面板中的「**開頁自動執行**」已勾選，管理器會在頁面載入完成後 **1.2 秒自動跑完**這批腳本 —— 連一次點擊都不需要

換句話說：**Local Overrides ＋ `_manager`（勾選開頁自動執行）＝ 免擴充、免手動的一次性方案**。

### 詳細設定步驟

1. **準備資料夾**：在本機建立一個專用資料夾（例如 `C:\ntuh-overrides`），**不要**放在會被同步或清理的位置
2. **開啟覆寫功能**：在目標網站頁面按 **F12** → **Sources** → 左側 **Overrides** 分頁 → **Select folder for overrides** → 選擇步驟 1 的資料夾 → 瀏覽器詢問權限時按 **允許**
3. **選擇要覆寫的檔案**（兩種做法，選一）：
   - **做法 A（較簡單）**：在 **Sources → Page** 中找到該網站**每一頁都會載入**的 JS 檔（例如共用的 jQuery／站台共用腳本）→ 右鍵 → **Save for overrides** → 該檔案會出現在 Overrides 分頁
   - **做法 B（若找不到共用 JS）**：對**頁面本身（HTML 文件）**右鍵 → **Save for overrides** → 在覆寫的 HTML 中 `</body>` 前插入一行
     `<script src="https://<該站網域>/ntuh-manager.js"></script>`，並在 Overrides 分頁建立對應路徑的檔案 `ntuh-manager.js`，內容貼上 `_manager.devtools.js`
4. **貼上腳本**：打開該覆寫檔案，把 `scripts/devtools-snippets/_manager.devtools.js` 的內容**貼到檔案最後面**（原本的程式碼保留），存檔
5. **啟用**：確認 Overrides 分頁的 **Enable Local Overrides** 已勾選
6. **設定自動執行**：重新載入頁面一次 → 右下角出現管理器面板 → **勾選「開頁自動執行」**（狀態存於該網域的 `localStorage`），並用 checkbox 決定哪些腳本要啟用
7. **之後**：每次開啟該網域頁面（含換頁、新分頁），管理器與啟用中的腳本都會**自動執行**

### 範例：一次涵蓋整個網域的資料夾結構

```
C:\ntuh-overrides\
└── hisaw.ntuh.gov.tw\
    └── WebApplication\
        └── Common\
            └── site.js          ← 原始檔 ＋ 貼在結尾的 _manager 內容
```

### 注意事項與限制

- **DevTools 需保持開啟**（可獨立視窗、並可縮到最小）：關閉 DevTools 後覆寫即停止生效
- **每個網域要各自設定一次**：`hisaw`／`ihisaw`／`eformaw` 等不同主機需分別做
- **每台電腦、每個瀏覽器 profile 都要重做**：覆寫設定不會跟著帳號同步
- **院方更新網站時**：若被覆寫的檔案改名或改路徑，覆寫會失效，需要重新選檔
- **跨來源限制同方法二**：`fetch` 仍受 CORS 限制，跨來源功能（如手術同意書查詢）無法使用
- **政策風險**：覆寫頁面內容屬於較侵入性的操作，**請先確認院內資安／端點管理政策允許**；受管控的公用電腦可能停用 DevTools 或覆寫功能


## 環境需求

- 支援 Tampermonkey 的瀏覽器（Chrome / Firefox / Edge / Safari），或任一支援 DevTools Snippets 的 Chromium 系瀏覽器

## 安裝指南

> 以下步驟適用於本 repo 所有腳本，安裝時請使用上方表格各腳本對應的「安裝連結」URL。

### 步驟一：安裝 Tampermonkey 擴充功能

Tampermonkey 是一款瀏覽器擴充功能，讓你能執行 Userscript 以自動化或強化網頁功能。

請至 [https://www.tampermonkey.net/](https://www.tampermonkey.net/) 選擇對應瀏覽器版本安裝：

| 瀏覽器 | 安裝連結 |
|--------|----------|
| Chrome | [Tampermonkey for Chrome](https://www.tampermonkey.net/index.php?browser=chrome) |
| Firefox | [Tampermonkey for Firefox](https://www.tampermonkey.net/index.php?browser=firefox) |
| Edge | [Tampermonkey for Edge](https://www.tampermonkey.net/index.php?browser=edge) |
| Safari | [Tampermonkey for Safari](https://www.tampermonkey.net/index.php?browser=safari) |

### 步驟二：確認 Tampermonkey 圖示已釘選

安裝後，請確認瀏覽器工具列上有顯示 Tampermonkey 圖示。當腳本在目前頁面生效時，圖示上會出現紅色數字徽章。

### 步驟三：開啟 Tampermonkey 儀表板

點擊工具列上的 Tampermonkey 圖示，選擇「**儀表板（Dashboard）**」。

### 步驟四：前往 Utilities 頁籤

在儀表板上方的頁籤列，點選「**Utilities**」頁籤。

### 步驟五：從 URL 匯入腳本

在 Utilities 頁面底部找到「**Import from URL**」欄位，貼上上方表格中對應腳本的「安裝連結」URL，再點擊「**Install**」按鈕。接著在彈出的確認頁面再次點擊「**Install**」完成安裝。

### 步驟六：確認安裝成功

回到儀表板的「**Installed Userscripts**」頁籤，確認腳本出現在清單中，且啟用切換鈕顯示為綠色即表示安裝成功。

## 貢獻指南

歡迎提交新腳本或修正，請遵循以下開發流程：

### 1. Fork 本 Repo

點擊右上角「**Fork**」，將本 repo 複製至你的 GitHub 帳號。

### 2. Clone 至本地

將 Fork 後的 repo clone 到本機進行開發：

```bash
git clone https://github.com/<你的帳號>/NTUH-helper.git
cd NTUH-helper
```

加入原始 repo 為 upstream，方便日後同步最新變更：

```bash
git remote add upstream https://github.com/Twb06/NTUH-helper.git
```

開始開發前，先同步 upstream 最新狀態：

```bash
git fetch upstream
git merge upstream/main
```

### 3. 建立功能分支

```bash
git checkout -b feature/your-script-name
```

分支命名規則：

| 類型 | 前綴 | 範例 |
|------|------|------|
| 新腳本 | `feature/` | `feature/opd-autofill` |
| 修正錯誤 | `fix/` | `fix/diagcert-date-parse` |
| 文件更新 | `docs/` | `docs/update-readme` |

### 4. 開發與提交

- 腳本檔案統一放置於 `scripts/` 目錄下
- 檔名格式：`{script-name}.user.js`
- 每支腳本的 UserScript metadata 區塊須加入以下兩行，讓 Tampermonkey 能自動追蹤更新：
  ```js
  // @updateURL   https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/{script-name}.user.js
  // @downloadURL https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/{script-name}.user.js
  ```
- **Tampermonkey 腳本開發模板**：開發新腳本時，請直接複製並修改以下模板檔案，以確保 Tampermonkey 能自動追蹤更新：
  [**點此查看最新版本的開發模板 (template.user.js)**](./scripts/template.user.js)
- **GM API 使用限制（DevTools 模式相容性）**：本專案會將所有腳本自動轉成不需擴充的 DevTools 單檔（見 [DevTools Snippets 自動產生](#devtools-snippets-自動產生開發者注意事項)）。撰寫時請避免讓核心功能**只依賴跨來源 `GM_xmlhttpRequest`**；此類呼叫在 DevTools 模式會被 CORS 阻擋，請改為偵測能力後降級並提示使用者。
- Commit 訊息採用 [Conventional Commits](https://www.conventionalcommits.org/) 格式：
  ```
  feat: 新增門診自動填表腳本
  fix: 修正診斷書日期格式錯誤
  docs: 更新安裝說明
  ```

### 5. 發送 Pull Request

推送分支後，至原始 repo 發起 Pull Request，說明腳本用途、適用頁面與測試方式。

### 6. 更新 README 專案內容表格

PR 中請同步更新 `README.md` 的「專案內容」表格，補上新腳本的說明、使用方式與安裝連結。

## CI/CD（雲端自動檢查）

所有檢查集中在**單一 workflow** `.github/workflows/build-devtools.yml`（`CI & DevTools Bundles`），於 push / pull request 自動執行（**lint 只跑一次**）：

| Job | 內容 | 是否為關卡 |
|---|---|---|
| `Lint JS` | `npm ci` → `npm run lint`（`scripts/**/*.js`，`scripts/devtools-snippets/` 已排除） | ✅ |
| `Policy Checks` | `bash tools/policy-check.sh`：檢查每支 `scripts/*.user.js` 的 `@updateURL`／`@downloadURL` | ✅ |
| `build-devtools` | 回歸測試 → 建置單檔 → 建置管理器 → 同步 README → 靜態稽核 → 無頭 Chrome 實跑 → 自足性／語法檢核 → 提交回 repo | 需前兩者通過 |
| `build-devtools-ungated` | 關卡未通過時的**備援產物**：只建置＋稽核＋實跑，**不上傳正式 artifact、永不 commit** | 僅在關卡失敗時執行 |

### 兩個 artifact 的差別

| Artifact | 何時產生 | 是否已自動提交回 main |
|---|---|---|
| **`devtools-snippets`**（正式） | lint 與 policy **都通過** | ✅（僅 main 分支推送時） |
| **`devtools-snippets-ungated`**（備援） | 任一關卡**失敗**時仍會產生 | ❌ **永不提交** |

> 也就是說：**即使關卡沒過（例如 `pacs-downloader` 的既有 lint 錯誤尚未修復），你仍能從該次 run 下載 `devtools-snippets-ungated` 取得最新單檔**；但 main 不會收到未經審核的提交，真正的「合格產物」仍以關卡通過為前提。

> ℹ️ 觸發路徑為 `**/*.js`（排除 `scripts/devtools-snippets/**`）。自動提交的訊息含 `[skip ci]`，不會造成重複觸發。

## DevTools Snippets 自動產生（開發者注意事項）

`scripts/devtools-snippets/` 內的 `*.devtools.js` 由 CI **全自動產生**，流程如下：

```
修改 scripts/*.user.js → push
  → node tools/test-diagcertificate.js（回歸測試）
  → node tools/build-devtools-inject.js --all（重建全部單檔 + manifest.json）
  → node tools/build-snippet-manager.js（重建管理器）
  → node tools/sync-readme-devtools.js（重寫本 README 的單檔清單）
  → node tools/audit-snippets.js（靜態稽核）
  → node tools/smoke-devtools.js（無頭 Chrome 逐支實跑）
  → 檢核：不得殘留 @require、逐檔 node --check
  → 自動 commit & push 回 scripts/devtools-snippets/ 與 README.md（訊息含 [skip ci]）
  → 同步上傳 artifact「devtools-snippets」
```

### 自動化檢查（確保產物可用、沒有明顯 bug）

| 檢查 | 指令 | 抓得到的問題 |
|---|---|---|
| 回歸測試 | `node tools/test-diagcertificate.js` | 診斷書囑言邏輯錯誤（含住院刀／急診送刀逐字比對） |
| **靜態稽核** | `node tools/audit-snippets.js` | 語法錯誤、殘留 `==UserScript==`／`@require`、**使用了 shim 未實作的 `GM_*`（在 DevTools 模式會 ReferenceError）**、manifest 與目錄不一致（漏列／大小不符）、manager 打包支數或 id 重複 |
| **無頭瀏覽器實跑** | `node tools/smoke-devtools.js` | 以系統的 Chrome／Edge（`--headless=new`）逐支載入，抓取載入期例外與 console error。**框架層級錯誤（未定義的 `GM_*`、SyntaxError、shim 未載入、管理器面板未建立）判定失敗**；頁面情境造成的 TypeError 僅回報不判定失敗 |
| README 同步 | `node tools/sync-readme-devtools.js --check` | README 的單檔清單與 manifest.json 不同步（本機可用） |

限制（務必理解）：實跑用的是**內建 mock 頁面**，只能證明「腳本不會因為框架／相容層而爆掉」；**院內頁面的欄位與流程語意無法在 CI 驗證**，跨來源請求在 DevTools 模式仍受 CORS 限制。因此建議另用 `--fixture` 指向真實頁面存檔以獲得更高擬真度：

```bash
node tools/smoke-devtools.js --fixture tools/fixtures/his-op-schedule.html --only diagcertificate
```

### 開發者請注意

- **不要手動編輯或 commit `scripts/devtools-snippets/`**：會被下一次 CI 覆蓋；改動一律從 `scripts/*.user.js` 下手。
- **不必在 PR 內附上單檔**：push 到 `main` 後由 workflow 自動提交，無需人工介入。
- **新增或修改腳本時，請確保沒有 GM API 時仍能運作**：
  - 可用相容層替代：`GM_getValue/setValue/deleteValue`（→ localStorage）、`GM_addValueChangeListener`（→ CustomEvent）、`GM_openInTab`（→ window.open）、**同源** `GM_xmlhttpRequest`（→ fetch）
  - **無法替代**：**跨來源** `GM_xmlhttpRequest`（受 CORS 限制）、`GM_getResourceText` 的外部資源
  - 建議寫法：偵測不到對應能力時 **跳過該功能並在畫面明確提示**，不要靜默失敗（範例可參考 `NTUH-diagcertificate-filler` 的 `triggerConsentScan`）
- **本地預覽建置結果**：
  ```bash
  node tools/test-diagcertificate.js            # 回歸測試
  node tools/build-devtools-inject.js --all     # 產生全部單檔到 scripts/devtools-snippets/
  node tools/build-devtools-inject.js scripts/foo.user.js   # 只建單一腳本
  ```
- 相關檔案：`tools/devtools-shim.js`（執行期 GM_* 相容層）、`tools/build-devtools-inject.js`（建置工具）、`.github/workflows/build-devtools.yml`（CI）

## 授權

© NTUH 內部使用
