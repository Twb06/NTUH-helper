# NTUH-helper

台大醫院（NTUH）自動化助手工具集，協助醫療行政作業自動化。

## 專案內容

| 子專案 | 說明 |
|--------|------|
| `NTUH/NTUH-diagcertificate-filler` | 診斷書自動填寫工具 |

## 環境需求

- Windows 作業系統
- 支援 Tampermonkey 的瀏覽器（Chrome / Firefox / Edge / Safari）

## 安裝指南

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

在 Utilities 頁面底部找到「**Import from URL**」欄位，貼上以下腳本 URL：

```
https://raw.githubusercontent.com/Twb06/NTUH-helper/main/NTUH/NTUH-diagcertificate-filler.user.js
```

貼上後點擊「**Install**」按鈕，接著在彈出的確認頁面再次點擊「**Install**」完成安裝。

### 步驟六：確認安裝成功

回到儀表板的「**Installed Userscripts**」頁籤，確認清單中出現 **NTUH DiagCertificate & Consent Integrated Filler**，且啟用切換鈕顯示為綠色即表示安裝成功。

## 使用方式

請參考各子專案目錄內的說明文件。

## 授權

© NTUH 內部使用
