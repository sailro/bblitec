import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("retained RmlUi creation and updates decode markup entities and preserve literal text", t => {
    const tools = optionalNativeFixtureTools();
    const rml = resolve(process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui");
    if (!tools || !existsSync(join(rml, "lib/rmlui.lib"))) {
        t.skip("The native compiler and pinned RmlUi library are required."); return;
    }
    const output = resolve("artifacts/ui-markup-runtime");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_UI=1", "/DBBLITE_HAS_IMAGE_DECODER=0", "/DRMLUI_STATIC_LIB", "/DRMLUI_SDL_VERSION_MAJOR=3",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        `/external:I${join(rml, "include")}`, `/external:I${join(rml, "Backends")}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0",
        "test/fixtures/ui-markup-runtime-check.cpp", "native/src/pal_system_fonts.cpp",
        join(rml, "Backends/RmlUi_Platform_SDL.cpp"), "/link", "/OPT:REF",
        join(rml, "lib/rmlui.lib"), join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"), join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
        "dwrite.lib", "user32.lib"]);
    assert.equal(execFileSync(executable, { encoding: "utf8",
        env: { ...tools.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}` },
    }), "");
});
