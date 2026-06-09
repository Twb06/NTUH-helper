# Hospital-helper

醫院自動化助手工具集，協助行政作業自動化。

## 專案內容

| 腳本 | 說明 | 使用方式 | 安裝連結 |
|------|------|----------|----------|
| `NTUH-diagcertificate-filler` | 自動填入診斷書，利用背景分頁與跨網域沙盒（GM_setValue）自動擷取手術同意書回傳 | 開啟診斷書頁面，點擊右下角 📋 浮動按鈕，輸入出院日期後點擊「自動填入囑言」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/NTUH-diagcertificate-filler.user.js) |
| `chart-antibiotic` | 讀取藥歷圖（Chart.aspx），整理抗生素用藥成「商品名 起日-迄日」，自動區分進行中與已停用，並顯示療程天數 | 開啟藥歷圖頁面，點擊右上角「整理抗生素」按鈕，複製結果 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/chart-antibiotic.user.js) |
| `admission-note-filler` | 自動填入入院紀錄各欄位（主訴、病史、身體診察等），並自動帶入檢驗結果 | 開啟入院紀錄頁面，點擊右下角 🏥 浮動按鈕，貼入筆記後點擊「填入入院紀錄」 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/admission-note-filler.user.js) |
| `op-automation` | 批次執行術前評估（估）、當日評估（當）、同意書綁定（同）；估頁面目前為無腦全填，call 入摘截取待開發 | 開啟手術排程頁面，點擊右下角「批次執行 估・當・同」按鈕 | [安裝](https://www.tampermonkey.net/script_installation.php#url=https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/op-automation.user.js) |

## Bookmarklets

| 書籤 | 說明 | 使用頁面 | 原始碼 |
|------|------|----------|--------|
| `lab-trend` | 框選「綠單」檢驗表格後按書籤，將多日資料以趨勢方式呈現（Hemogram / Liver/Renal / Electrolytes / Coagulation / Gas / Urine 等自動分組） | Portal 報告頁面的綠單 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/lab-trend.js) |
| `lab-summary` | 框選「清單」檢驗數值後按書籤，將數值依臨床分組整理成段落，自動標記異常值（↑↓），Culture 附採檢日期 | Portal 報告頁面的清單 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/lab-summary.js) |
| `goto-nursing-handover` | 新開分頁跳轉到該病人的「護理交班」頁面 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-handover.js) |
| `goto-nursing-notes` | 新開分頁跳轉到該病人的「護理紀錄」頁面 | Portal 病人專屬頁面（TPR、病程、處方、診療等） | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-nursing-notes.js) |
| `goto-emergency` | 新開分頁跳轉到「急診」頁面 | Portal 任一網域 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/goto-emergency.js) |
| `renew-orders` | 勾選目前全部 orders，隔離部分自動選擇繼續隔離 | Portal renew 頁面 | [raw](https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/bookmarklets/renew-orders.js) |

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
  // @updateURL   https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/{script-name}.user.js
  // @downloadURL https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/{script-name}.user.js
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
