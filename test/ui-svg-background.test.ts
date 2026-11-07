import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { parseDataUrl } from "../src/data-url.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/ui-svg-background");
// Percent-encoded SVG documents, as a stylesheet writes them inline.
const chevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 6'%3E%3Cpath d='M1 1.2 4 4.5 7 1.2' fill='none' stroke='%235a4630' stroke-width='2'/%3E%3C/svg%3E")`;
const square = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect width='10' height='10' fill='%23ff0000'/%3E%3C/svg%3E")`;

test("background shorthands draw SVG images at an explicit size and contained", (t) => {
    mkdirSync(directory, { recursive: true });
    const sheet = [
        `.chevron { position: absolute; left: 0; top: 0; width: 8px; height: 6px; background: center / 8px 6px no-repeat ${chevron}; }`,
        `.cursor { position: absolute; left: 20px; top: 0; width: 32px; height: 16px; background: no-repeat center / contain ${square}; }`,
    ].join(" ");
    const result = compileSource(
        `const sheet = document.createElement("style");
        sheet.textContent = ${JSON.stringify(sheet)};
        document.head.append(sheet);
        for (const name of ["chevron", "cursor"]) {
            const element = document.createElement("div");
            element.id = name;
            element.className = name;
            document.body.append(element);
        }
        globalThis.close();`,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("ui:inline-svg"));
    // The layer's components are the PAL's longhands, the image a packaged file.
    assert.match(
        result.cpp,
        /bbl-background-image:\\"[0-9a-f]+-inline\.svg\\";bbl-background-size:8px 6px;bbl-background-position:50% 50%;bbl-background-repeat:no-repeat;/,
    );
    assert.match(
        result.cpp,
        /bbl-background-size:contain;bbl-background-position:50% 50%;/,
    );
    const svgs = result.manifest.assets.filter((asset) =>
        asset.output.endsWith(".svg"),
    );
    assert.equal(svgs.length, 2);
    for (const asset of svgs) {
        const payload = parseDataUrl(result.assetPayloads.get(asset.source)!)!;
        assert.equal(payload.mediaType, "image/svg+xml");
        assert.match(Buffer.from(payload.bytes).toString("utf8"), /^<svg /);
        writeFileSync(join(directory, asset.output), payload.bytes);
    }
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-svg-background", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_UI_INLINE_SVG: 1,
        },
    });
});

test("a raster background shorthand refuses what its decorator cannot draw", () => {
    for (const [background, message] of [
        [
            `${square} padding-box`,
            /box clipping currently applies to solid backgrounds/,
        ],
        [`${square} 0 0 / 8px auto no-repeat`, /background-size 8px auto/],
        [`${square} left top / cover fixed`, /background-attachment fixed/],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `const sheet = document.createElement("style");
                    sheet.textContent = ${JSON.stringify(`.a { background: ${background}; }`)};
                    document.head.append(sheet);`,
                ),
            message,
        );
});
