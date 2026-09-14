// ==UserScript==
// @name         NTUH 登入助手
// @namespace    http://tampermonkey.net/
// @version      6.0
// @icon         https://www.ntuh.gov.tw/images/logo.ico
// @description  Recognize the NTUH Portal captcha and provide opt-in quick login for saved accounts.
// @author       WeiJyun9008
// @match        https://portal.ntuh.gov.tw/General/Login.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-helper.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-helper.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
    "use strict";

    const CREDENTIALS_KEY = "ntuh-login-credentials-v2";
    const LEGACY_CREDENTIAL_KEY = "ntuh-login-credential-v1";
    const OCR_FAILURES_KEY = "ntuh-login-ocr-failures-v1";
    const MAX_AUTO_REFRESHES = 3;

    let passwordHashToBypassOnce = null;
    let expressLoginPending = false;

    function isCredential(value) {
        return Boolean(value) && typeof value.user === "string" && value.user.length > 0 &&
            typeof value.passMD5 === "string" && value.passMD5.length > 0;
    }

    function loadCredentials() {
        let credentials = [];

        try {
            const saved = JSON.parse(localStorage.getItem(CREDENTIALS_KEY));
            if (Array.isArray(saved)) {
                credentials = saved.filter(isCredential).filter((credential, index, all) =>
                    all.findIndex(item => item.user === credential.user) === index);
            }
        } catch (error) {
            console.warn("Unable to load saved NTUH credentials:", error);
        }

        try {
            const legacy = JSON.parse(localStorage.getItem(LEGACY_CREDENTIAL_KEY));
            if (isCredential(legacy) && !credentials.some(item => item.user === legacy.user)) {
                credentials.push(legacy);
            }
            if (isCredential(legacy)) {
                localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
                localStorage.removeItem(LEGACY_CREDENTIAL_KEY);
            }
        } catch (error) {
            console.warn("Unable to migrate the legacy NTUH credential:", error);
        }

        return credentials;
    }

    function storeCredentials(credentials) {
        localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(credentials));
    }

    function saveCredential(user, passMD5) {
        const credentials = loadCredentials().filter(item => item.user !== user);
        storeCredentials([{ user, passMD5 }, ...credentials]);
    }

    function removeCredential(user) {
        storeCredentials(loadCredentials().filter(item => item.user !== user));
    }

    function injectStyles() {
        const style = document.createElement("style");
        style.textContent = `
            #ntuhQuickLoginAccounts {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 4px;
                width: 164px;
            }
            .ntuhQuickLoginCard {
                display: flex;
                min-width: 0;
                height: 24px;
                overflow: hidden;
                color: inherit;
                background: #f5f5f5;
                border: 1px solid #999;
            }
            .ntuhQuickLoginButton,
            .ntuhQuickLoginDelete {
                padding: 0;
                color: inherit;
                background: transparent;
                border: 0;
                cursor: pointer;
                font: inherit;
            }
            .ntuhQuickLoginButton {
                flex: 1;
                min-width: 0;
                padding-left: 5px;
                overflow: hidden;
                text-align: left;
                text-overflow: ellipsis;
            }
            .ntuhQuickLoginDelete {
                width: 20px;
                color: #777;
                border-left: 1px solid #bbb;
                font-size: 14px;
            }
            .ntuhQuickLoginButton:hover { background: #e8e8e8; }
            .ntuhQuickLoginDelete:hover { color: #a00000; background: #f2dddd; }
            #ntuhRememberLoginLabel { white-space: nowrap; }
            #ntuhCaptchaDetails { width: 164px; }
            #ntuhCaptchaDetails > summary {
                width: max-content;
                color: inherit;
                cursor: pointer;
            }
            #ntuhCaptchaManualContent { margin-top: 5px; }
            #ntuhCaptchaManualContent #lblVerifyMsg { display: none; }
            #ntuhCaptchaManualContent #txtVerifyCode {
                display: block;
                margin-top: 5px;
            }
        `;
        document.head.appendChild(style);
    }

    function createLoginRow(labelText, id) {
        const row = document.createElement("tr");
        const labelCell = document.createElement("td");
        const controlCell = document.createElement("td");

        row.id = id;
        labelCell.className = "LogIn";
        labelCell.align = "right";
        labelCell.style.whiteSpace = "nowrap";
        labelCell.textContent = labelText;
        controlCell.className = "LogIn";
        controlCell.align = "left";
        row.append(labelCell, controlCell);
        return { row, controlCell };
    }

    function addRememberCheckbox(passwordRow) {
        const { row, controlCell } = createLoginRow("", "ntuhRememberLoginRow");
        const label = document.createElement("label");
        const checkbox = document.createElement("input");

        label.id = "ntuhRememberLoginLabel";
        checkbox.id = "ntuhRememberLogin";
        checkbox.type = "checkbox";
        label.append(checkbox, " 記住我的帳號");
        controlCell.appendChild(label);
        passwordRow.insertAdjacentElement("afterend", row);
        return checkbox;
    }

    function renderQuickLoginCards(accountRow, onLogin) {
        document.getElementById("ntuhQuickLoginRow")?.remove();
        const credentials = loadCredentials();
        if (credentials.length === 0) return;

        const { row, controlCell } = createLoginRow("快速登入", "ntuhQuickLoginRow");
        const accounts = document.createElement("div");
        accounts.id = "ntuhQuickLoginAccounts";

        for (const credential of credentials) {
            const card = document.createElement("div");
            const login = document.createElement("button");
            const remove = document.createElement("button");

            card.className = "ntuhQuickLoginCard";
            login.type = "button";
            login.className = "ntuhQuickLoginButton";
            login.textContent = credential.user;
            login.title = `以 ${credential.user} 快速登入`;
            login.addEventListener("click", () => onLogin(credential));

            remove.type = "button";
            remove.className = "ntuhQuickLoginDelete";
            remove.textContent = "×";
            remove.title = `移除 ${credential.user}`;
            remove.setAttribute("aria-label", `移除 ${credential.user}`);
            remove.addEventListener("click", () => {
                if (!confirm(`確定移除帳號 ${credential.user}？`)) return;
                removeCredential(credential.user);
                renderQuickLoginCards(accountRow, onLogin);
            });

            card.append(login, remove);
            accounts.appendChild(card);
        }

        controlCell.appendChild(accounts);
        accountRow.insertAdjacentElement("beforebegin", row);
    }

    function addCaptchaDisclosure(captchaImageRow, captchaInputRow, input) {
        const { row, controlCell } = createLoginRow("驗證碼", "ntuhCaptchaDisclosureRow");
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        const content = document.createElement("div");
        const originalContent = captchaImageRow.querySelector("td > div");

        details.id = "ntuhCaptchaDetails";
        summary.textContent = "手動輸入";
        content.id = "ntuhCaptchaManualContent";
        if (originalContent) content.appendChild(originalContent);
        content.appendChild(input);
        details.append(summary, content);
        controlCell.appendChild(details);
        captchaImageRow.insertAdjacentElement("beforebegin", row);
        captchaImageRow.style.display = "none";
        captchaInputRow.style.display = "none";
        return { row, details };
    }

    function removeHiddenCapsLockSpacing(status) {
        if (!status) return;

        const syncDisplay = () => {
            status.toggleAttribute("hidden", status.style.visibility === "hidden");
        };

        new MutationObserver(syncDisplay).observe(status, {
            attributes: true,
            attributeFilter: ["style"]
        });
        syncDisplay();
    }

    function installCredentialCapture(rememberCheckbox, afterSave) {
        const original = window.CheckAndSetPassTextBox;
        if (typeof original !== "function") return false;

        window.CheckAndSetPassTextBox = function(textboxID) {
            if (textboxID === "txtPass" && passwordHashToBypassOnce !== null) {
                const currentPassword = document.querySelector("#txtPass")?.value;
                const shouldBypass = currentPassword === passwordHashToBypassOnce;
                passwordHashToBypassOnce = null;
                if (shouldBypass) return;
            }

            const result = original.apply(this, arguments);
            if (textboxID === "txtPass" && rememberCheckbox.checked) {
                const user = document.querySelector("#txtUserID")?.value.trim();
                const passMD5 = document.querySelector("#txtPass")?.value;
                if (user && passMD5) {
                    saveCredential(user, passMD5);
                    afterSave();
                }
            }
            return result;
        };
        return true;
    }

    function readFailureCount() {
        const value = Number.parseInt(sessionStorage.getItem(OCR_FAILURES_KEY), 10);
        return Number.isFinite(value) ? value : 0;
    }

    function init() {
        const ocr = globalThis.NTUHLoginOCR;
        const user = document.querySelector("#txtUserID");
        const pass = document.querySelector("#txtPass");
        const capsLockStatus = document.getElementById("capStatus");
        const accountRow = user?.closest("tr");
        const passwordRow = pass?.closest("tr");
        const captchaImageRow = document.getElementById("tr_p_2");
        const captchaInputRow = document.getElementById("tr_p_3");
        const image = document.querySelector("img#imgVerifyCode");
        const input = document.querySelector("input#txtVerifyCode");
        const refresh = document.querySelector("#ibnRegenVerifyImg");
        const submit = document.getElementById("imgBtnSubmitNew");

        if (!ocr || !user || !pass || !accountRow || !passwordRow ||
            !captchaImageRow || !captchaInputRow || !image || !input || !refresh || !submit) return;

        injectStyles();
        removeHiddenCapsLockSpacing(capsLockStatus);
        const rememberCheckbox = addRememberCheckbox(passwordRow);
        const captchaDisclosure = addCaptchaDisclosure(captchaImageRow, captchaInputRow, input);

        const submitExpressLogin = () => {
            if (!expressLoginPending || input.value.trim().length !== 6) return;
            expressLoginPending = false;
            submit.click();
        };

        const revealManualCaptcha = () => {
            captchaDisclosure.details.open = true;
            input.focus();
        };

        const handleRecognitionFailure = () => {
            const failures = readFailureCount() + 1;
            sessionStorage.setItem(OCR_FAILURES_KEY, String(failures));
            if (failures >= MAX_AUTO_REFRESHES) {
                revealManualCaptcha();
                return;
            }
            refresh.click();
        };

        const recognize = () => {
            try {
                const text = ocr.recognizeCaptcha(image);
                if (!text) {
                    handleRecognitionFailure();
                    return;
                }
                sessionStorage.removeItem(OCR_FAILURES_KEY);
                input.value = text;
                submitExpressLogin();
            } catch (error) {
                console.error("Template OCR error:", error);
                handleRecognitionFailure();
            }
        };

        const loginWithCredential = credential => {
            user.value = credential.user;
            pass.value = credential.passMD5;
            passwordHashToBypassOnce = credential.passMD5;
            expressLoginPending = true;
            if (input.value.trim().length === 6) submitExpressLogin();
            else if (image.complete && image.naturalWidth) recognize();
        };

        const renderAccounts = () => renderQuickLoginCards(accountRow, loginWithCredential);
        const passwordHookInstalled = installCredentialCapture(rememberCheckbox, renderAccounts);
        if (!passwordHookInstalled) console.warn("CheckAndSetPassTextBox() is unavailable; quick login is disabled.");
        else renderAccounts();

        pass.addEventListener("keydown", event => {
            if (event.key === "Enter") submit.click();
        });

        const verification = document.getElementById("ddl_verification");
        const updatePasswordOnlyRows = () => {
            const visible = !verification || verification.value === "P";
            document.getElementById("ntuhQuickLoginRow")?.toggleAttribute("hidden", !visible);
            document.getElementById("ntuhRememberLoginRow")?.toggleAttribute("hidden", !visible);
            captchaDisclosure.row.toggleAttribute("hidden", !visible);
            captchaImageRow.style.display = "none";
            captchaInputRow.style.display = "none";
        };
        verification?.addEventListener("change", () => setTimeout(updatePasswordOnlyRows));
        updatePasswordOnlyRows();

        if (readFailureCount() >= MAX_AUTO_REFRESHES) revealManualCaptcha();

        image.crossOrigin = "anonymous";
        image.onload = recognize;
        if (image.complete && image.naturalWidth) recognize();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
