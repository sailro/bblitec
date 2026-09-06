import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
function runNavigationFixture(name: string): string {
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const executable = join(output, `${name}.exe`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        "/DBBLITE_HAS_NAV_CROWD=1", "/DBBLITE_HAS_NAV_TILE_CACHE=1", `/Fo:${output}\\`, `/Fe:${executable}`,
        "/I", "native/src", "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include/recastnavigation")}`, "/external:W0",
        `test/fixtures/${name}.cpp`, "/link", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "Recast.lib", "Detour.lib", "DetourCrowd.lib", "DetourTileCache.lib", "RecastNavigationTileCache.lib"]);
    return execFileSync(executable, { encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
        env: { ...tools!.environment, PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` },
    });
}

test("navigation releases independent plugins, crowds and failed builds", { skip: !tools }, () => {
    assert.match(runNavigationFixture("navigation-lifetime-check"), /navigation-lifetime-check: ok/);
});

test("navigation checks vector/query recovery and every allocation in the pinned solo-floor build", { skip: !tools }, () => {
    const output = runNavigationFixture("navigation-allocation-check");
    assert.match(output, /vector-allocation-check: ok/);
    assert.match(output, /query-reinitialization-check: ok \(10 initial, 6 growing allocation sites\)/);
    assert.match(output, /navigation-allocation-check: ok \(498 allocation sites\)/);
});
