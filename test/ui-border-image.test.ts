import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { reachedImageCodecs } from "../src/image-codecs.js";
import { parseUiBorderImage } from "../src/ui-border-image.js";
import { runRmlUiFixture } from "./native-fixture.js";

function compileStyle(style: string, direct = false) {
    return compileSource(
        `
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            ${direct ? `panel.style.borderImage = ${JSON.stringify(style)};` : `panel.style.cssText = ${JSON.stringify(style)};`}
            document.body.appendChild(panel);
            panel.addEventListener("click", () => { panel.style.border = "0"; });
        }
        void main();
    `,
        {
            fileName: resolve("artifacts/ui-border-image/main.ts"),
            publicDir: resolve("artifacts/ui-border-image/public"),
        },
    );
}

test("retained border images package through the shared asset and codec registry", () => {
    const style = "url('/frames/panel.png') 2 25% / 3px 2 auto / 0 stretch";
    const inline = compileStyle(
        `border: 3px solid red; border-image: ${style}; background: blue; background-clip: padding-box;`,
    );
    assert.equal(inline.manifest.assets.length, 1);
    assert.equal(
        inline.manifest.assets[0]!.source,
        resolve("artifacts/ui-border-image/public/frames/panel.png"),
    );
    assert.deepEqual(
        reachedImageCodecs(
            resolve("artifacts/ui-border-image"),
            inline.manifest.assets,
        ),
        ["png"],
    );
    assert.ok(
        inline.cpp.includes(
            `border-image:url(\\"${inline.manifest.assets[0]!.output}\\") 2 25% 2 25% / 3px 2 auto 2 / 0 0 0 0 stretch`,
        ),
    );
    assert.match(inline.cpp, /border-image:none;border:3px solid red/);
    // The shorthand write resets its omitted longhands, then sets its own.
    assert.match(
        inline.cpp,
        /"border-image", "none"\);\s*bbl::ui_set_style_property\([^\n]+"border", "0 none"/,
    );
    const direct = compileStyle(style, true);
    assert.deepEqual(direct.manifest.assets, inline.manifest.assets);
    assert.match(direct.cpp, /ui_set_style_property[^\n]+"border-image", "url/);
});

test("border image longhands lower to the native longhands and package their sources", () => {
    const result = compileStyle(
        "border: 6px solid red; border-image: url('/frames/panel.png') 6 / 6px; border-image-source: url('/frames/panel.png'); border-image-width: 4px 2; border-image-slice: 25%; border-image-outset: 0; border-image-repeat: stretch;",
    );
    assert.equal(result.manifest.assets.length, 1);
    const output = result.manifest.assets[0]!.output;
    assert.ok(result.cpp.includes(`border-image-source:url(\\"${output}\\")`));
    assert.match(result.cpp, /border-image-width:4px 2 4px 2/);
    assert.match(result.cpp, /border-image-slice:25% 25% 25% 25%/);
    assert.match(result.cpp, /border-image-outset:0 0 0 0/);
    assert.match(result.cpp, /border-image-repeat:stretch/);
    for (const declaration of [
        "border-image-source: url(/frames/panel.svg)",
        "border-image-slice: 25% fill",
        "border-image-outset: 2px",
        "border-image-repeat: round",
        "border-image-width: -1px",
    ])
        assert.throws(
            () => compileStyle(`${declaration};`),
            /border-image-\w+.*static raster URL/,
            declaration,
        );
});

test("border image shorthand expansion preserves widths and explicit unsupported boundaries", () => {
    assert.deepEqual(parseUiBorderImage("url(frame.png) 20% / 2PX AUTO"), {
        source: "frame.png",
        slices: ["20%", "20%", "20%", "20%"],
        widths: ["2px", "auto", "2px", "auto"],
    });
    assert.deepEqual(parseUiBorderImage("url(frame.png)"), {
        source: "frame.png",
        slices: ["100%", "100%", "100%", "100%"],
        widths: ["1", "1", "1", "1"],
    });
    for (const value of [
        "url(frame.svg) 2",
        "url(frame.png) 2 fill",
        "url(frame.png) 2 / 3px / 1px",
        "url(frame.png) 2 repeat",
        "url(frame.png) -2",
        "url(frame.png) 2 /",
        "url(frame.png) 2 / 2 /",
        "url(frame.png) 2 / calc(2px + 1px)",
        `url(frame.png) ${"9".repeat(50)}`,
    ]) {
        assert.throws(
            () => compileStyle(`border-image:${value};`),
            /border-image.*static raster URL/,
        );
    }
    assert.throws(
        () =>
            compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.borderImage = Math.random() > .5 ? "url(a.png) 2" : "none";
            document.body.appendChild(panel);
        }
        void main();
    `),
        /UI border-image requires a generation-known string\./,
    );
    assert.equal(compileStyle("border-image:none;").manifest.assets.length, 0);
    assert.throws(
        () =>
            compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText = \`border-image: url(\${Math.random()}.png) 2;\`;
            document.body.appendChild(panel);
        }
        void main();
    `),
        /border-image.*static raster URL/,
    );
});

test("native retained border images draw raster slices with live widths and an empty center", (t) => {
    const output = resolve("artifacts/ui-border-image");
    mkdirSync(output, { recursive: true });
    const raster = new PNG({ width: 12, height: 12 });
    for (let i = 0; i < raster.data.length; i += 4)
        raster.data.set([240, 120, 60, 128], i);
    writeFileSync(join(output, "frame4px.png"), PNG.sync.write(raster));
    runRmlUiFixture(t, "ui-border-image", { imageDecoder: true });
});
