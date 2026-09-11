import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { supportedUiFilter } from "../src/ui-filters.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("ordinary retained filters survive projection and refuse unsupported forms", () => {
    const filters = "brightness(50%) contrast(1.5) saturate(0.8) hue-rotate(-30deg) invert(20%) grayscale(1) sepia(.5) opacity(90%) blur(2px) drop-shadow(0 12px 26px rgba(10,20,30,.5))";
    assert.ok(supportedUiFilter(filters));
    assert.ok(supportedUiFilter("drop-shadow(red -4px 2px) drop-shadow(0 0 1px #abcd)"));
    for (const invalid of ["url(mask.svg)", "blur(-1px)", "blur(1em)", "brightness(NaN)", "drop-shadow(0 0 unknown)",
        "drop-shadow(0 0 #12345)", "drop-shadow(0 0 rgb(a,b,c))", "brightness(1)blur(2px)",
        "drop-shadow(0 0 rgba(20%,30%,40%,.5))", `brightness(${"9".repeat(50)})`])
        assert.equal(supportedUiFilter(invalid), false, invalid);
    const compile = (value: string) => compileSource(`
        import { createEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        const panel = document.createElement("div");
        panel.style.cssText = ${JSON.stringify(`filter:${filters};`)};
        document.body.appendChild(panel);
        panel.style.filter = ${JSON.stringify(value)};
    `);
    assert.ok(compile("none").cpp.includes(`filter:${filters}`));
    assert.throws(() => compile("url(mask.svg)"), /only color adjustments/);
});

test("native retained filters preserve nested layers, color parameters, shadows and backdrop order", t => {
    const tools = optionalNativeFixtureTools();
    const rml = resolve(process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui");
    if (!tools || !existsSync(join(rml, "lib/rmlui.lib"))) {
        t.skip("The native compiler and pinned RmlUi library are required."); return;
    }
    const output = resolve("artifacts/ui-filter");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_UI=1", "/DBBLITE_HAS_IMAGE_DECODER=0", "/DRMLUI_STATIC_LIB", "/DRMLUI_SDL_VERSION_MAJOR=3",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        `/external:I${join(rml, "include")}`, `/external:I${join(rml, "Backends")}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        "test/fixtures/ui-filter-check.cpp", "native/src/pal_system_fonts.cpp",
        join(rml, "Backends/RmlUi_Platform_SDL.cpp"), "/link", "/OPT:REF",
        join(rml, "lib/rmlui.lib"), join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"), join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        "dwrite.lib", "user32.lib"]);
    assert.equal(execFileSync(executable, { encoding: "utf8",
        env: { ...tools.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}` },
    }), "");
});
