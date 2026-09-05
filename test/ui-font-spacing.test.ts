import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
const rml = resolve(process.env.BBLITE_RMLUI_DIR ?? "artifacts/tools/rmlui");

test("an explicit RmlUi root replaces a previously cached package location", () => {
    assert.match(readFileSync("native/CMakeLists.txt", "utf8"),
        /set\(\s*RmlUi_DIR "\$\{BBLITE_RMLUI_DIR\}\/lib\/cmake\/RmlUi"\s*CACHE PATH "[^"]*" FORCE\s*\)\s*find_package\(\s*RmlUi/);
});
test("RmlUi preserves fractional letter spacing until final line measurement", {
    skip: !tools || !existsSync(join(rml, "lib/rmlui.lib")),
}, () => {
    const output = resolve("artifacts/ui-font-spacing-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "ui-font-spacing-check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", "native/src",
        "/I", join(rml, "include"), "/DRMLUI_STATIC_LIB",
        "test/fixtures/ui-font-spacing-check.cpp", "native/src/pal_system_fonts.cpp",
        join(rml, "lib/rmlui.lib"), join(nativeFixtureVcpkgRoot, "lib/freetype.lib"),
        join(nativeFixtureVcpkgRoot, "lib/lunasvg.lib"), "dwrite.lib", "user32.lib",
    ]);
    assert.match(execFileSync(executable, [], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` },
    }), /ui-font-spacing-check: ok/);
});
