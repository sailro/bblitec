import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { compileSource } from "../src/compiler.js";
import { reachedImageCodecs } from "../src/image-codecs.js";
import { parseUiBorderImage } from "../src/ui-border-image.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function compileStyle(style: string, direct = false) {
    return compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            ${direct ? `panel.style.borderImage = ${JSON.stringify(style)};` : `panel.style.cssText = ${JSON.stringify(style)};`}
            document.body.appendChild(panel);
            panel.addEventListener("click", () => { panel.style.border = "0"; });
        }
        void main();
    `, { fileName: resolve("artifacts/ui-border-image/main.ts"), publicDir: resolve("artifacts/ui-border-image/public") });
}

test("retained border images package through the shared asset and codec registry", () => {
    const style = "url('/frames/panel.png') 2 25% / 3px 2 auto / 0 stretch";
    const inline = compileStyle(`border: 3px solid red; border-image: ${style}; background: blue; background-clip: padding-box;`);
    assert.equal(inline.manifest.assets.length, 1);
    assert.equal(inline.manifest.assets[0]!.source, resolve("artifacts/ui-border-image/public/frames/panel.png"));
    assert.deepEqual(reachedImageCodecs(resolve("artifacts/ui-border-image"), inline.manifest.assets), ["png"]);
    assert.ok(inline.cpp.includes(`border-image:url(\\\"${inline.manifest.assets[0]!.output}\\\") 2 25% 2 25% / 3px 2 auto 2 / 0 0 0 0 stretch`));
    assert.match(inline.cpp, /border-image:none;border:3px red/);
    assert.match(inline.cpp, /"border", "0"\);\s*bbl::ui_set_style_property\([^\n]+"border-image", "none"/);
    const direct = compileStyle(style, true);
    assert.deepEqual(direct.manifest.assets, inline.manifest.assets);
    assert.match(direct.cpp, /ui_set_style_property[^\n]+"border-image", "url/);
});

test("border image shorthand expansion preserves widths and explicit unsupported boundaries", () => {
    assert.deepEqual(parseUiBorderImage('url(frame.png) 20% / 2PX AUTO'), {
        source: "frame.png", slices: ["20%", "20%", "20%", "20%"], widths: ["2px", "auto", "2px", "auto"],
    });
    assert.deepEqual(parseUiBorderImage('url(frame.png)'), {
        source: "frame.png", slices: ["100%", "100%", "100%", "100%"], widths: ["1", "1", "1", "1"],
    });
    for (const value of ["url(frame.svg) 2", "url(frame.png) 2 fill", "url(frame.png) 2 / 3px / 1px",
        "url(frame.png) 2 repeat", "url(frame.png) -2", "url(frame.png) 2 /", "url(frame.png) 2 / 2 /",
        "url(frame.png) 2 / calc(2px + 1px)", `url(frame.png) ${"9".repeat(50)}`]) {
        assert.throws(() => compileStyle(`border-image:${value};`), /border-image.*static raster URL/);
    }
    assert.throws(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.borderImage = Math.random() > .5 ? "url(a.png) 2" : "none";
            document.body.appendChild(panel);
        }
        void main();
    `), /Expected a string literal/);
    assert.equal(compileStyle("border-image:none;").manifest.assets.length, 0);
    assert.throws(() => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        async function main() {
            await createEngine({});
            const panel = document.createElement("div");
            panel.style.cssText = \`border-image: url(\${Math.random()}.png) 2;\`;
            document.body.appendChild(panel);
        }
        void main();
    `), /border-image.*static raster URL/);
});

test("native retained border images draw raster slices with live widths and an empty center", t => {
    const tools = optionalNativeFixtureTools();
    const rml = resolve(process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui");
    if (!tools || !existsSync(join(rml, "lib/rmlui.lib"))) {
        t.skip("The native compiler and pinned RmlUi library are required."); return;
    }
    const output = resolve("artifacts/ui-border-image");
    mkdirSync(output, { recursive: true });
    const raster = new PNG({ width: 12, height: 12 });
    for (let i = 0; i < raster.data.length; i += 4) raster.data.set([240, 120, 60, 128], i);
    writeFileSync(join(output, "frame4px.png"), PNG.sync.write(raster));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_UI=1", "/DBBLITE_HAS_IMAGE_DECODER=1", "/DRMLUI_STATIC_LIB", "/DRMLUI_SDL_VERSION_MAJOR=3",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        `/external:I${join(rml, "include")}`, `/external:I${join(rml, "Backends")}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        "test/fixtures/ui-border-image-check.cpp", "native/src/pal_system_fonts.cpp",
        join(rml, "Backends/RmlUi_Platform_SDL.cpp"), "/link", "/OPT:REF",
        join(rml, "lib/rmlui.lib"), join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"), join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib"), "dwrite.lib", "user32.lib"]);
    assert.equal(execFileSync(executable, { encoding: "utf8",
        env: { ...tools.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}` },
    }), "");
});
