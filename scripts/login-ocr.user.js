// ==UserScript==
// @name         NTUH 自動輸入驗證碼
// @namespace    http://tampermonkey.net/
// @version      5.5
// @icon         https://www.ntuh.gov.tw/images/logo.ico
// @description  Fill the NTUH Portal login captcha using in-script template matching.
// @author       WeiJyun9008
// @match        https://portal.ntuh.gov.tw/General/Login.aspx*
// @updateURL    https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-ocr.user.js
// @downloadURL  https://github.com/Twb06/NTUH-helper/raw/refs/heads/main/scripts/login-ocr.user.js
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
    "use strict";

    const TEMPLATE_PACKED = {
        "1": [9, 22, "Dg8Pn8/n8/g8Hg8Hg8Hg8Hg8Hg8//////A=="],
        "2": [14, 21, "D+D/5/+/H/g/gPADwB4A+AfAfgPwPwDwB4A8APADwA//v////A=="],
        "3": [14, 23, "D4D/h/8f/nh5wOADgD4P+H/B/gP8AfgB4APAD+A/gP8H//5/8P+B/AA="],
        "4": [17, 22, "ADwAPgAfAB+AH8Af4A/wD7gPnAeOB4cHx4f/+/////7//wA+AA4ABwADgAHAAOA="],
        "5": [15, 23, "//3/+//3/88AHgA/+H/8//3/++D3gP4B4APAB4APAD3Ae8P3/8//D/wH4AA="],
        "6": [14, 22, "AcAPAHwD4B8A+AfAHwD/4//v/74f8D+AfgH4B/A/wPfP3/4/8H8A"],
        "7": [17, 23, "//9/////3//gA+AD4AHgAfAB8ADwAHgAeAA8AD4AHgAPAA8AB4AHwAPAAeAA4ABwAA=="],
        "8": [15, 23, "B/A/8P/x/+fDzwOeDz4+P/w/8P/x/+fH7wP8B/gH8B/wPfD7//P/w/8B+AA="],
        "9": [16, 23, "B+Af+D/8f/74PvAe8A/wD/AP+B78fn/+P/4f/gf8AHwA+AH4D/A/4H+AfgA4AA=="],
        "B": [16, 22, "f8D/8P/48PjwPPA88DzwfP/4//j/+P/88HzwPvAe8A/wHvB+8fz/+P/wfwA="],
        "D": [18, 23, "MAAfAAf4Af+Af/gcfwcH4cB8cA+cAecAOcAPcAPcAPcAPcAPcAf8A+8B+//8//4f/wH/AA=="],
        "F": [16, 23, "f/x//n//f/5wAHAAcABwAP/8f/x//H/4eABwAHAAcABwAHAAcABwAHAAcABgAA=="],
        "H": [19, 23, "cABuAB/AB/gA/wAf4AP8AH+AD/AB/h////////////8H/AB/gA7wAf4AP8AH8AD+AB/AA/gAcA=="],
        "J": [18, 24, "D/+D/+D//D/+AHwAHgAHgAHgAHgAHgAHgAHgAHgAHgAHgYHg8Hg8HA8HA/HAf/AP+AH+AB8A"],
        "L": [15, 23, "cADgAcADgAcADgAcADgAcADgAcADgAcAHgA8AHgA8AHgA8D3///////f+AA="],
        "N": [21, 24, "4AB3gAe+AD3wAe/AB38AO/wB3+AP/4B3PgP8+B3D4P4fh3h+O4Hx3AfO4B/3gH+4Af3gB+4AH3AAe4ABnAAA"],
        "P": [14, 22, "f4H/h/8efnB/wP8D/A/we+fv/z/4/8PADgA8APADwA4APADgA4AA"],
        "R": [16, 22, "/gD/wP/w8/jg+OA84D7gHuAe4B7gPPD8//j/4P/g//Dj+OD84H7gP+AP4A4="],
        "T": [20, 22, "f/////9///AfAADgAA8AAPAADwAA8AAPAADwAA8AAPAADwAA8AAPAADwAAcAAHAABwAAcAAHAA=="],
        "V": [18, 22, "cAO8AP8AfcAeeA8eA8eA8PB4PB4PD4HjwHjwHngHngD/gD/AD/AB+AB+AB+AA8AA4AA="],
        "X": [19, 23, "YAD+AD/gD74B8+B8Ph8Dx8B88Af+AH+AB+AA+AA/gAf4Af8AfPAfHwfB8fAefAPvAD/AA/AAMA=="],
        "Z": [20, 23, "f//H//9///f//gAPwAH4AD4AB8AA+AAPAAHwAD4AB8AAeAAPgAHwAB4AA8AAfAAH//7//+f//3//4A=="]
    };

    let templates; // Lazy cache

    function init() {
        // Submit listener
        document.querySelector("#txtPass")?.addEventListener("keydown", e => {
            if (e.key === "Enter") document.getElementById("imgBtnSubmitNew")?.click();
        });

        const img = document.querySelector("img#imgVerifyCode");
        const input = document.querySelector("input#txtVerifyCode");
        if (!img || !input) return;

        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                // 1. Lazy-parse templates once
                templates ??= Object.entries(TEMPLATE_PACKED).map(([char, [w, h, b64]]) => {
                    const str = atob(b64), data = new Uint8Array(w * h);
                    let cnt = 0, bit = 0;
                    for (let i = 0; i < str.length; i++) {
                        for (let b = 7; b >= 0 && bit < data.length; b--, bit++) {
                            if ((str.charCodeAt(i) >> b) & 1) { data[bit] = 1; cnt++; }
                        }
                    }
                    return { char, w, h, data, cnt };
                });

                // 2. Draw + threshold directly to 1D flat binary array
                const w = img.naturalWidth, h = img.naturalHeight;
                const cvs = document.createElement("canvas");
                cvs.width = w; cvs.height = h;
                const ctx = cvs.getContext("2d", { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);

                const imgData = ctx.getImageData(0, 0, w, h).data, bin = new Uint8Array(w * h);
                for (let i = 0, ptr = 0; i < w * h; i++, ptr += 4) {
                    const r = imgData[ptr], g = imgData[ptr + 1], b = imgData[ptr + 2];
                    bin[i] = (r * 77 + g * 150 + b * 29) < 32000 ? 1 : 0;
                }

                // 3. Clear isolated pixel noise
                const idx = (x, y) => y * w + x;
                for (let y = 1; y < h - 1; y++) {
                    for (let x = 1; x < w - 1; x++) {
                        const i = idx(x, y);
                        if (!bin[i]) continue;
                        let n = 0;
                        for (let dy = -1; dy <= 1; dy++)
                            for (let dx = -1; dx <= 1; dx++)
                                if ((dx || dy) && bin[idx(x + dx, y + dy)]) n++;
                        if (n <= 1) bin[i] = 0;
                    }
                }

                // 4. One-pass floodfill to extract connected components (bypassing blobs < 25 area)
                const visited = new Uint8Array(w * h), segments = [];
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const start = idx(x, y);
                        if (visited[start] || !bin[start]) continue;

                        const stack = [start], pixels = [];
                        visited[start] = 1;

                        while (stack.length) {
                            const p = stack.pop();
                            pixels.push(p);
                            const cx = p % w, cy = Math.floor(p / w);

                            for (let dy = -1; dy <= 1; dy++) {
                                for (let dx = -1; dx <= 1; dx++) {
                                    const nx = cx + dx, ny = cy + dy;
                                    if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                                        const ni = idx(nx, ny);
                                        if (!visited[ni] && bin[ni]) {
                                            visited[ni] = 1;
                                            stack.push(ni);
                                        }
                                    }
                                }
                            }
                        }

                        if (pixels.length >= 25) {
                            let minX = w, maxX = 0, minY = h, maxY = 0;
                            for (const p of pixels) {
                                const cx = p % w, cy = Math.floor(p / w);
                                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                            }
                            const sw = maxX - minX + 1, sh = maxY - minY + 1, sData = new Uint8Array(sw * sh);
                            for (const p of pixels) sData[(Math.floor(p / w) - minY) * sw + (p % w - minX)] = 1;
                            segments.push({ left: minX, w: sw, h: sh, data: sData });
                        }
                    }
                }

                segments.sort((a, b) => a.left - b.left);

                // 5. Hard split if 2 characters merged
                const trim = (s) => {
                    let minX = s.w, maxX = -1, minY = s.h, maxY = -1;
                    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.data[y * s.w + x]) {
                        if (x < minX) minX = x; if (x > maxX) maxX = x;
                        if (y < minY) minY = y; if (y > maxY) maxY = y;
                    }
                    if (maxX < 0) return null;
                    const nw = maxX - minX + 1, nh = maxY - minY + 1, nd = new Uint8Array(nw * nh);
                    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) nd[y * nw + x] = s.data[(y + minY) * s.w + (x + minX)];
                    return { left: s.left + minX, w: nw, h: nh, data: nd };
                };

                if (segments.length === 5) { // Assuming 6 chars total
                    const big = segments.reduce((max, s, i, arr) => s.w * s.h > arr[max].w * arr[max].h ? i : max, 0);
                    const seg = segments[big];
                    let bestCol = 1, minPx = 999;
                    for (let x = 1; x < seg.w - 1; x++) {
                        let cnt = 0;
                        for (let y = 0; y < seg.h; y++) if (seg.data[y * seg.w + x]) cnt++;
                        if (cnt < minPx) { minPx = cnt; bestCol = x; }
                    }

                    const lData = new Uint8Array(seg.w * seg.h), rData = new Uint8Array(seg.w * seg.h);
                    for (let y = 0; y < seg.h; y++) for (let x = 0; x < seg.w; x++) {
                        if (seg.data[y * seg.w + x]) (x < bestCol ? lData : rData)[y * seg.w + x] = 1;
                    }

                    const ls = trim({ left: seg.left, w: seg.w, h: seg.h, data: lData });
                    const rs = trim({ left: seg.left, w: seg.w, h: seg.h, data: rData });
                    if (ls && rs) segments.splice(big, 1, ls, rs);
                }

                // 6. Template match (IoU mapping)
                const text = segments.slice(0, 6).map(seg => {
                    let bestC = "?", bestSc = -1;
                    const sCnt = seg.data.reduce((a, b) => a + b, 0);

                    for (const tpl of templates) {
                        const cx = Math.round((seg.w - tpl.w) / 2), cy = Math.round((seg.h - tpl.h) / 2);
                        for (let oy = cy - 3; oy <= cy + 3; oy++) {
                            for (let ox = cx - 3; ox <= cx + 3; ox++) {
                                let inter = 0;
                                for (let y = Math.max(0, oy), y1 = Math.min(seg.h, oy + tpl.h); y < y1; y++) {
                                    for (let x = Math.max(0, ox), x1 = Math.min(seg.w, ox + tpl.w); x < x1; x++) {
                                        if (seg.data[y * seg.w + x] && tpl.data[(y - oy) * tpl.w + (x - ox)]) inter++;
                                    }
                                }
                                const sc = inter / (sCnt + tpl.cnt - inter);
                                if (sc > bestSc) { bestSc = sc; bestC = tpl.char; }
                            }
                        }
                    }
                    return bestC;
                }).join("");

                if (text.length === 6 && !text.includes("?")) input.value = text;
                else document.querySelector("#ibnRegenVerifyImg")?.click(); // Auto-regen if we flunk out

            } catch (e) {
                console.error("Template OCR error:", e);
            }
        };

        if (img.complete) img.onload();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
