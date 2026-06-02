// ==UserScript==
// @name         {腳本顯示名稱}
// @namespace    http://tampermonkey.net/
// @version      0.0.1
// @description  {腳本功能描述}
// @author       {作者名稱}
// @match        {腳本目標網站網址，例如: https://hisaw.ntuh.gov.tw/*}
// @updateURL    https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/{script-name}.user.js
// @downloadURL  https://raw.githubusercontent.com/Twb06/NTUH-helper/main/scripts/{script-name}.user.js
// @grant        none
// ==/UserScript==

// ==使用指南，完成後請刪除本欄位==
    // 檔案命名與存放：
    // 建立新檔案時，請命名為 {script-name}.user.js (例如：NTUH-test-tool.user.js)。
    // 請將寫好的腳本統一放置於 GitHub 儲存庫的 scripts/ 目錄下。

    // 替換 Metadata 變數：
    // {腳本顯示名稱}：顯示在 Tampermonkey 面板上的名稱（例如：NTUH Auto Filler）。
    // {腳本功能描述}：簡單描述這個腳本的作用。
    // {目標網站網址}：需要執行此腳本的 URL 規則（可使用 * 萬用字元，若有多個網址可新增多行 @match）。
    // {script-name}：非常重要，請務必替換成您實際的檔案名稱（不包含 .user.js 的部分），這樣 @updateURL 和 @downloadURL 才能正確抓取 GitHub 上的更新檔。

    // API 權限 (@grant)：
    // 模板預設為 none。若您後續需要使用特殊的 Tampermonkey API（例如跨網域請求 GM_xmlhttpRequest、開啟分頁 GM_openInTab、存取腳本儲存空間 GM_setValue 等），請記得修改這裡並加入對應的權限。
// ==/使用指南，完成後請刪除本欄位==

(function() {
    'use strict';

    // 請在這裡開始撰寫您的程式碼...
    console.log("{腳本顯示名稱} 已載入！");

})();