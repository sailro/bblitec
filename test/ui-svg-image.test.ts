import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { runRmlUiFixture } from "./native-fixture.js";

/** An RGBA PNG of one colour. */
function png(width: number, height: number, rgba: readonly number[]): Buffer {
    const raster = new PNG({ width, height });
    for (let offset = 0; offset < raster.data.length; offset += 4)
        raster.data.set(rgba, offset);
    return PNG.sync.write(raster);
}

const directory = resolve("artifacts/ui-svg-image");
const compile = (markup: string, options = {}) =>
    compileSource(
        `const host=document.createElement("div");host.innerHTML=${markup};document.body.append(host);globalThis.close();`,
        { fileName: join(directory, "entry.ts"), ...options },
    );

test("SVG images draw packaged rasters at their viewport rectangles", (t) => {
    mkdirSync(join(directory, "assets"), { recursive: true });
    writeFileSync(
        join(directory, "assets", "red.png"),
        png(2, 2, [255, 0, 0, 255]),
    );
    writeFileSync(
        join(directory, "assets", "green.png"),
        png(1, 1, [0, 255, 0, 255]),
    );
    const result = compileSource(
        `const host=document.createElement("div");host.id="host";
        host.style.cssText="position:absolute;left:0;top:0;width:40px;height:40px";
        host.innerHTML='<svg viewBox="0 0 40 40" width="40" height="40">' +
            '<image href="assets/red.png" x="10" y="5" width="20" height="10" preserveAspectRatio="none"/>' +
            '<image href="assets/green.png" x="10" y="20" width="20" height="10"/>' +
            '<rect x="0" y="32" width="5" height="5" fill="#0000ff"/></svg>';
        document.body.append(host);
        globalThis.close();`,
        {
            fileName: join(directory, "entry.ts"),
            deferredCapabilities: "runtime-throw",
        },
    );
    assert.equal(result.manifest.deferredCapabilities, undefined);
    assert.ok(result.manifest.features.includes("ui:svg-image"));
    assert.match(result.cpp, /<image data-bbl-href=\\"assets\/red\.png\\"/);
    assert.match(result.cpp, /preserveAspectRatio=\\"none\\"/);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    runRmlUiFixture(t, "ui-svg-image", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_UI_SVG_IMAGES: 1,
        },
    });
});

test("SVG images refuse unrepresented sources, attributes and tinting", () => {
    mkdirSync(join(directory, "assets"), { recursive: true });
    writeFileSync(
        join(directory, "assets", "red.png"),
        png(1, 1, [255, 0, 0, 255]),
    );
    for (const [markup, message] of [
        [
            '<svg><image href="assets/red.gif" width="1" height="1"/></svg>',
            /PNG or JPEG/,
        ],
        [
            '<svg><image href="https://example.com/a.png" width="1" height="1"/></svg>',
            /PNG or JPEG/,
        ],
        [
            '<svg><image href="assets/red.png" width="1"/></svg>',
            /static href, width and height/,
        ],
        [
            '<svg><image href="assets/red.png" width="-1" height="1"/></svg>',
            /nonnegative/,
        ],
        [
            '<svg><image href="assets/red.png" width="1" height="1" transform="rotate(4)"/></svg>',
            /attribute 'transform'/,
        ],
        [
            '<svg><image xlink:href="assets/red.png" width="1" height="1"/></svg>',
            /attribute 'xlink:href'/,
        ],
        [
            '<svg><image href="assets/red.png" width="1" height="1" preserveAspectRatio="xMidYMid crop"/></svg>',
            /preserveAspectRatio/,
        ],
        [
            '<svg fill="currentColor"><path d="M0 0L1 1"/><image href="assets/red.png" width="1" height="1"/></svg>',
            /currentColor/,
        ],
        // In HTML the parser reads <image> as <img>.
        [
            '<image href="assets/red.png" width="1" height="1"/>',
            /attribute 'href' is not supported on <img>/,
        ],
    ] as const)
        assert.throws(() => compile(JSON.stringify(markup)), message, markup);
    assert.throws(
        () =>
            compile(
                '`<svg><image href="${String(performance.now())}.png" width="1" height="1"/></svg>`',
            ),
        /requires static attribute 'href'/,
    );
});
