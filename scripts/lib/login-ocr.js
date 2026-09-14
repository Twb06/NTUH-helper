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

    let templates;

    function loadTemplates() {
        templates ??= Object.entries(TEMPLATE_PACKED).map(([char, [w, h, b64]]) => {
            const str = atob(b64), data = new Uint8Array(w * h);
            let cnt = 0, bit = 0;
            for (let i = 0; i < str.length; i++) {
                for (let b = 7; b >= 0 && bit < data.length; b--, bit++) {
                    if ((str.charCodeAt(i) >> b) & 1) {
                        data[bit] = 1;
                        cnt++;
                    }
                }
            }
            return { char, w, h, data, cnt };
        });
        return templates;
    }

    function trimSegment(segment) {
        let minX = segment.w, maxX = -1, minY = segment.h, maxY = -1;
        for (let y = 0; y < segment.h; y++) {
            for (let x = 0; x < segment.w; x++) {
                if (!segment.data[y * segment.w + x]) continue;
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
        if (maxX < 0) return null;

        const width = maxX - minX + 1;
        const height = maxY - minY + 1;
        const data = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                data[y * width + x] = segment.data[(y + minY) * segment.w + (x + minX)];
            }
        }
        return { left: segment.left + minX, w: width, h: height, data };
    }

    function splitMergedSegment(segments) {
        if (segments.length !== 5) return;

        const largestIndex = segments.reduce((max, segment, index, all) =>
            segment.w * segment.h > all[max].w * all[max].h ? index : max, 0);
        const segment = segments[largestIndex];
        let bestColumn = 1, minimumPixels = Infinity;

        for (let x = 1; x < segment.w - 1; x++) {
            let count = 0;
            for (let y = 0; y < segment.h; y++) {
                if (segment.data[y * segment.w + x]) count++;
            }
            if (count < minimumPixels) {
                minimumPixels = count;
                bestColumn = x;
            }
        }

        const leftData = new Uint8Array(segment.w * segment.h);
        const rightData = new Uint8Array(segment.w * segment.h);
        for (let y = 0; y < segment.h; y++) {
            for (let x = 0; x < segment.w; x++) {
                if (segment.data[y * segment.w + x]) {
                    (x < bestColumn ? leftData : rightData)[y * segment.w + x] = 1;
                }
            }
        }

        const left = trimSegment({ left: segment.left, w: segment.w, h: segment.h, data: leftData });
        const right = trimSegment({ left: segment.left, w: segment.w, h: segment.h, data: rightData });
        if (left && right) segments.splice(largestIndex, 1, left, right);
    }

    function extractSegments(binary, width, height) {
        const indexOf = (x, y) => y * width + x;

        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const index = indexOf(x, y);
                if (!binary[index]) continue;
                let neighbours = 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if ((dx || dy) && binary[indexOf(x + dx, y + dy)]) neighbours++;
                    }
                }
                if (neighbours <= 1) binary[index] = 0;
            }
        }

        const visited = new Uint8Array(width * height);
        const segments = [];
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const start = indexOf(x, y);
                if (visited[start] || !binary[start]) continue;

                const stack = [start], pixels = [];
                visited[start] = 1;
                while (stack.length) {
                    const pixel = stack.pop();
                    pixels.push(pixel);
                    const currentX = pixel % width;
                    const currentY = Math.floor(pixel / width);

                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            const nextX = currentX + dx, nextY = currentY + dy;
                            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
                            const next = indexOf(nextX, nextY);
                            if (!visited[next] && binary[next]) {
                                visited[next] = 1;
                                stack.push(next);
                            }
                        }
                    }
                }

                if (pixels.length < 25) continue;
                let minX = width, maxX = 0, minY = height, maxY = 0;
                for (const pixel of pixels) {
                    const currentX = pixel % width, currentY = Math.floor(pixel / width);
                    if (currentX < minX) minX = currentX;
                    if (currentX > maxX) maxX = currentX;
                    if (currentY < minY) minY = currentY;
                    if (currentY > maxY) maxY = currentY;
                }
                const segmentWidth = maxX - minX + 1;
                const segmentHeight = maxY - minY + 1;
                const data = new Uint8Array(segmentWidth * segmentHeight);
                for (const pixel of pixels) {
                    data[(Math.floor(pixel / width) - minY) * segmentWidth + (pixel % width - minX)] = 1;
                }
                segments.push({ left: minX, w: segmentWidth, h: segmentHeight, data });
            }
        }

        segments.sort((a, b) => a.left - b.left);
        splitMergedSegment(segments);
        return segments;
    }

    function matchSegment(segment) {
        let bestCharacter = "?", bestScore = -1;
        const segmentPixels = segment.data.reduce((sum, value) => sum + value, 0);

        for (const template of loadTemplates()) {
            const centerX = Math.round((segment.w - template.w) / 2);
            const centerY = Math.round((segment.h - template.h) / 2);
            for (let offsetY = centerY - 3; offsetY <= centerY + 3; offsetY++) {
                for (let offsetX = centerX - 3; offsetX <= centerX + 3; offsetX++) {
                    let intersection = 0;
                    for (let y = Math.max(0, offsetY), endY = Math.min(segment.h, offsetY + template.h); y < endY; y++) {
                        for (let x = Math.max(0, offsetX), endX = Math.min(segment.w, offsetX + template.w); x < endX; x++) {
                            if (segment.data[y * segment.w + x] && template.data[(y - offsetY) * template.w + (x - offsetX)]) {
                                intersection++;
                            }
                        }
                    }
                    const score = intersection / (segmentPixels + template.cnt - intersection);
                    if (score > bestScore) {
                        bestScore = score;
                        bestCharacter = template.char;
                    }
                }
            }
        }
        return bestCharacter;
    }

    function recognizeCaptcha(image) {
        const width = image.naturalWidth, height = image.naturalHeight;
        if (!width || !height) return null;

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(image, 0, 0);

        const pixels = context.getImageData(0, 0, width, height).data;
        const binary = new Uint8Array(width * height);
        for (let i = 0, pointer = 0; i < width * height; i++, pointer += 4) {
            const red = pixels[pointer], green = pixels[pointer + 1], blue = pixels[pointer + 2];
            binary[i] = red * 77 + green * 150 + blue * 29 < 32000 ? 1 : 0;
        }

        const text = extractSegments(binary, width, height).slice(0, 6).map(matchSegment).join("");
        return text.length === 6 && !text.includes("?") ? text : null;
    }

    globalThis.NTUHLoginOCR = Object.freeze({ recognizeCaptcha });
})();
