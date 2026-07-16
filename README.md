# Hospital-helper

醫院自動化助手工具集，協助行政作業自動化。

## 📖 安裝教學

> 👉 **[點此開啟互動式安裝教學](https://daniel0128-tw.github.io/ntuh-helper-docs/tutorial.html)**（含 Tampermonkey 安裝、開啟使用者指令碼、腳本安裝、書籤工具安裝）

## 專案內容

### 呈現資料型

從頁面擷取資料並整理成易讀格式。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `chart-medication` | 藥歷圖整理用藥為「商品名 起日-迄日」，區分進行中／已停用並顯示療程天數；也支援 Progress Note Data Helper 背景抓取抗生素藥歷 | 通用 | 藥歷圖頁點右上角「整理藥物」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/chart-medication.user.js) |
| `prescription-viewer` | 處方頁整理目前用藥為「商品名 劑量 頻率 途徑 開始日 特殊事項」，院內／自備藥分組，供一眼檢視與複製；也支援背景抓取現行處方 | 通用 | 處方頁點右上角「整理處方」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/prescription-viewer.user.js) |
| `lab-summary` | 整理檢驗報告，自動分類並顯示日期與趨勢；支援 Culture／PCR、抗藥性標註、清單／橫式／綠單模式；也支援背景抓取檢驗摘要 | 通用 | 報告頁點右下角「整理檢驗」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/lab-summary.user.js) |
| `nursing-handover-summary` | 護理交班頁擷取飲食、管路、照會等，整理成精簡 note | 通用 | 開啟護理交班頁右下角自動顯示 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/nursing-handover-summary.user.js) |

### 自動執行型

自動完成重複性行政操作。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `NTUH-diagcertificate-filler` | 自動填寫診斷書囑言：帶入住院起訖與手術名稱，手術可勾選要納入的項目 | 通用 | 診斷書頁點右下角 📋，輸入出院日期後填入 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js) |
| `op-automation` | 自動估當同工具：批次執行估、當、同；支援多筆主治醫師或手術房執行 | 通用 | 開啟手術排程頁面，可直接點擊右下角「批次執行 估・當・同」，或在批次搜尋面板輸入多筆主治醫師 / 手術房後依序執行 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/op-automation.user.js) |
| `uro-performance` | 泌尿科績效填入工具：上傳刀表病人 CSV，自動填入主治醫師與 R （每月更新工作表） | 泌尿科 | 開啟績效頁面，點擊右下角「績」浮動按鈕，上傳 CSV 後點擊「開始全自動」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/uro-performance.user.js) |
| `zero-performance` | 掛 0% 績效工具：一鍵把指定員編以 0% 掛進當前病人的 R 角色 | 通用 | 開啟績效頁面，點擊右下角「0%」浮動按鈕，輸入員編後點擊「掛 0% 到當前病人」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/zero-performance.user.js) |
| `weekend-progress` | 病房列表一鍵對全病人撰寫週末病程：複製最新 progress、填 stable 並確認 | 通用 | 病房列表頁點右下角「⚡ 週末病程」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/weekend-progress.user.js) |
| `login-ocr` | 登入頁面自動輸入驗證碼：透過連接物件標記與模板匹配演算法實作的零依賴驗證碼識別，輸入帳號密碼後按下 Enter 完成登入 | 通用 | Portal 登入頁面（Login.aspx）自動辨識並填入 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-ocr.user.js) |

### Note 撰寫相關

從 Primary Note 解析內容並自動填入對應欄位。**需要特殊的筆記格式**。

| 腳本 | 說明 | 適用範圍 | 使用方式 | 安裝連結 |
|------|------|----------|----------|----------|
| `admission-note-filler` | 自動入摘工具：自動填入紀錄各欄位（主訴、病史、身體診察等），並帶入檢驗結果。產出模板與撰寫規則見 [Admission Note 模板與規則](./scripts/template/admission-note-template.md) | 通用 | 開啟入院紀錄頁面，點擊右下角 🏥 浮動按鈕，貼入筆記後點擊「填入入院紀錄」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/admission-note-filler.user.js) |
| `discharge-note-filler` | 自動出摘工具：自動填入出院病摘各欄位（出院診斷、住院治療經過、併發症等），並帶入檢驗結果。所需筆記格式見 [Primary Note 格式範本](./scripts/template/primary-note-format.md) | 通用 | 開啟出院病摘頁面，點擊右下角 📄 浮動按鈕，貼入筆記後點擊「填入出院病摘」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/discharge-note-filler.user.js) |
| `progress-note-filler` | 從 Primary note 一鍵自動填入 Progress Note / Weekly Summary / Duty Note（自動新增表單、貼上、暫存），並整合背景抓取的病人資料面板（各區塊標題可點跳轉對應頁面）。所需筆記格式見 [Primary Note 格式範本](./scripts/template/primary-note-format.md) | 通用 | 病程紀錄頁點右下角 📋；先在左上筆記區建立 Primary note，即可一鍵今日更新／填入 progress／Weekly／Duty note；「抓取全部data」整理 vitals、管路、照會、飲食、交班筆記、護理紀錄、影像、Rx、Abx、Lab，各區塊標題可點跳頁 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-filler.user.js) |
| `progress-note-data-helper` | Progress Note Filler 的資料抓取引擎：從導管、照會、飲食、護理交班筆記、今日護理紀錄、OuterData、藥歷、處方、檢驗等來源背景抓資料並回傳給 filler。需搭配 `progress-note-filler` 使用 | 通用 | 安裝後無獨立按鈕；在 Progress Note Filler 點「抓取全部data」時自動執行 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/progress-note-data-helper.user.js) |

## Bookmarklets

| 書籤 | 說明 | 適用範圍 | 使用頁面 | 原始碼 |
|------|------|----------|----------|--------|
| `chart-medication` | 在藥歷圖頁面按書籤，整理抗生素用藥成「商品名 起日-迄日」，自動區分進行中與已停用並顯示療程天數 | 通用 | Portal 藥歷圖（Chart.aspx） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/chart-medication.js) |
| `goto-nursing-handover` | 新開分頁跳轉到該病人的「護理交班」頁面 | 通用 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-handover.js) |
| `goto-nursing-notes` | 新開分頁跳轉到該病人的「護理紀錄」頁面 | 通用 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-notes.js) |
| `goto-emergency` | 新開分頁跳轉到「急診」頁面 | 通用 | Portal 任一網域 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-emergency.js) |
| `renew-orders` | 勾選目前全部 orders，隔離部分自動選擇繼續隔離 | 通用 | Portal renew 頁面 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/renew-orders.js) |

### 安裝方式

1. 點擊下方表格對應書籤的檔案連結，複製全部內容
2. 在瀏覽器書籤列上按右鍵 → 新增書籤
3. 名稱自訂，網址欄貼上複製的內容
4. 儲存後即可使用


## 環境需求

- 支援 Tampermonkey 的瀏覽器（Chrome / Firefox / Edge / Safari）

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

本專案已在 GitHub Actions 上實作 CI/CD，於 push / pull request 自動執行：

- `Lint JS`：檢查 `scripts/**/*.js` 的 ESLint 規範
- `Policy Checks`：檢查每支 `scripts/*.user.js` 是否包含正確的 `@updateURL` 與 `@downloadURL`

## 授權

© NTUH 內部使用
