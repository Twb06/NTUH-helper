/* eslint-env node */

const fs = require("node:fs");
const path = require("node:path");
const { minify } = require("terser");

const usage = `Usage:
  node tools/build-bookmarklet.js <input.js> [output.js] [--iife]

Examples:
  node tools/build-bookmarklet.js src.js bookmarklet.js
  node tools/build-bookmarklet.js src.js bookmarklet.js --iife
  node tools/build-bookmarklet.js src.js > bookmarklet.js`;

function parseArguments(args) {
    const positional = [];
    let addIIFE = false;

    for (const arg of args) {
        if (arg === "--iife") {
            addIIFE = true;
        } else if (arg === "--help" || arg === "-h") {
            return null;
        } else {
            positional.push(arg);
        }
    }

    if (positional.length < 1 || positional.length > 2) {
        throw new Error(usage);
    }

    return {
        inputPath: positional[0],
        outputPath: positional[1],
        addIIFE
    };
}

function readSource(inputPath) {
    return inputPath === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(path.resolve(process.cwd(), inputPath), "utf8");
}

async function buildBookmarklet(code, addIIFE) {
    const trimmedCode = code.trim();
    const source = addIIFE
        ? `(function(){${trimmedCode}})();`
        : trimmedCode;

    const result = await minify(source, {
        compress: false,
        mangle: false,
        format: {
            comments: false,
            beautify: false
        }
    });

    if (!result.code) {
        throw new Error("Terser 沒有產生輸出內容");
    }

    return `javascript:${encodeURIComponent(result.code)}`;
}

async function main() {
    const options = parseArguments(process.argv.slice(2));

    if (!options) {
        console.log(usage);
        return;
    }

    const bookmarklet = await buildBookmarklet(
        readSource(options.inputPath),
        options.addIIFE
    );

    if (!options.outputPath || options.outputPath === "-") {
        process.stdout.write(`${bookmarklet}\n`);
        return;
    }

    const outputPath = path.resolve(process.cwd(), options.outputPath);
    fs.writeFileSync(outputPath, `${bookmarklet}\n`);
    console.error(
        `已產生 ${options.outputPath} (${Buffer.byteLength(bookmarklet)} bytes)`
    );
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
