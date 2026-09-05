import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("navigation releases independent plugins, crowds and failed builds", { skip: !tools }, () => {
    const output = resolve("artifacts/navigation-lifetime-check");
    mkdirSync(output, { recursive: true });
    const executable = join(output, "navigation-lifetime-check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_NAV_CROWD=1", "/DBBLITE_HAS_NAV_TILE_CACHE=1", `/Fo:${output}\\`, `/Fe:${executable}`,
        "/I", "native/src", "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include/recastnavigation")}`, "/external:W0",
        "test/fixtures/navigation-lifetime-check.cpp", "/link", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "Recast.lib", "Detour.lib", "DetourCrowd.lib", "DetourTileCache.lib", "RecastNavigationTileCache.lib"]);
    assert.match(execFileSync(executable, { encoding: "utf8", timeout: 30000,
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    }), /navigation-lifetime-check: ok/);
});
