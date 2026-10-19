/* NTUH-helper DevTools 相容層（由 tools/build-devtools-inject.js 自動前置，請勿手改）
 * 目的：讓 Tampermonkey 專用的 GM_* API 在「DevTools / 無使用者腳本管理器」環境下仍可運作。
 * 重要限制：GM_xmlhttpRequest 以 fetch 實作，因此
 *   - 同源請求：可正常運作
 *   - 跨來源請求：受瀏覽器 CORS 限制，會被阻擋（需 Tampermonkey 或伺服器開放 CORS）
 */
(function () {
    'use strict';
    if (typeof window === 'undefined') return;
    const store = window.localStorage;
    const read = key => {
        try { const raw = store.getItem('gm_' + key); return raw === null ? undefined : JSON.parse(raw); }
        catch (e) { return undefined; }
    };
    const write = (key, value) => {
        try {
            store.setItem('gm_' + key, JSON.stringify(value));
            window.dispatchEvent(new CustomEvent('gm-value-changed', { detail: { key, value } }));
        } catch (e) { /* 私密模式或配額問題：忽略 */ }
    };
    const shim = {
        GM_getValue(key, fallback) { const v = read(key); return v === undefined ? fallback : v; },
        GM_setValue(key, value) { write(key, value); },
        GM_deleteValue(key) { try { store.removeItem('gm_' + key); } catch (e) { /* ignore */ } },
        GM_addValueChangeListener(key, callback) {
            const handler = event => {
                if (event.detail && event.detail.key === key) callback(key, null, event.detail.value, false);
            };
            window.addEventListener('gm-value-changed', handler);
            return handler;
        },
        GM_removeValueChangeListener(handler) { window.removeEventListener('gm-value-changed', handler); },
        GM_openInTab(url, options) {
            const win = window.open(url, '_blank');
            if (options && options.active === false && win && win.blur) win.blur();
            return { close: () => win && win.close() };
        },
        GM_getResourceText() { return ''; },
        GM_xmlhttpRequest(options) {
            const opts = { method: options.method || 'GET', credentials: 'include', headers: options.headers || {} };
            if (options.data !== undefined) opts.body = options.data;
            fetch(options.url, opts).then(async response => {
                const buffer = await response.arrayBuffer();
                const text = new TextDecoder('utf-8').decode(buffer);
                if (options.onload) options.onload({
                    status: response.status,
                    responseText: text,
                    response: options.responseType === 'arraybuffer' ? buffer : text,
                    responseHeaders: [...response.headers].map(([k, v]) => k + ': ' + v).join('\r\n')
                });
            }).catch(error => {
                if (options.onerror) options.onerror(error);
                else console.warn('[DevTools shim] 請求失敗（跨來源會遭 CORS 阻擋）：', options.url, error.message);
            });
            return { abort() { } };
        }
    };
    for (const [name, fn] of Object.entries(shim)) {
        if (typeof window[name] !== 'function') window[name] = fn;
    }
    window.__NTUH_DEVTOOLS_SHIM__ = true;
})();
