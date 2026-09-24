import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import {
    navigationBuildDefaultsDeclaration,
    navigationConfigStepDeclaration,
} from "../src/lowering/navigation-lowerer.js";
import { pinnedHeader } from "../src/lowering/pinned-header.js";

const tools = optionalNativeFixtureTools();
function runNavigationFixture(name: string): string {
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const executable = join(output, `${name}.exe`);
    // The build defaults and the two build-config steps the generated
    // navigation header hands the PAL.
    writeFileSync(
        join(output, "navigation_build_defaults.hpp"),
        pinnedHeader(
            [
                "<bblite/js_data.hpp>",
                "<bblite/pal_navigation.hpp>",
                "",
                "<cmath>",
            ],
            [
                navigationBuildDefaultsDeclaration(),
                navigationConfigStepDeclaration("solo"),
                navigationConfigStepDeclaration("tileCache"),
            ].join("\n"),
        ),
    );
    runNativeFixtureCompiler(tools!, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/DBBLITE_HAS_NAV_CROWD=1",
        "/DBBLITE_HAS_NAV_TILE_CACHE=1",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        "/I",
        "native/include",
        "/I",
        output,
        `/external:I${join(nativeFixtureVcpkgRoot, "include/recastnavigation")}`,
        "/external:W0",
        `test/fixtures/${name}.cpp`,
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "Recast.lib",
        "Detour.lib",
        "DetourCrowd.lib",
        "DetourTileCache.lib",
        "RecastNavigationTileCache.lib",
    ]);
    return execFileSync(executable, {
        encoding: "utf8",
        timeout: 30000,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
            ...tools!.environment,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
        },
    });
}

test(
    "navigation releases independent plugins, crowds and failed builds",
    { skip: !tools },
    () => {
        assert.match(
            runNavigationFixture("navigation-lifetime-check"),
            /navigation-lifetime-check: ok/,
        );
    },
);

test(
    "navigation checks vector/query recovery and every allocation in the pinned solo-floor build",
    { skip: !tools },
    () => {
        const output = runNavigationFixture("navigation-allocation-check");
        assert.match(output, /vector-allocation-check: ok/);
        assert.match(
            output,
            /query-reinitialization-check: ok \(10 initial, 6 growing allocation sites\)/,
        );
        assert.match(
            output,
            /navigation-allocation-check: ok \(498 allocation sites\)/,
        );
    },
);

test("navigation build-config steps are lowered from the generators package", () => {
    // Each rcConfig store narrows at the field's own width, as the wrapper's
    // setter does, and each comparison is JavaScript's: against the double
    // 0.9, which a float-width port would have spelled 0.9f.
    const solo = navigationConfigStepDeclaration("solo");
    assert.match(
        solo,
        /rcConfig\.minRegionArea = bbl::js::numeric_store_value<decltype\(rcConfig\.minRegionArea\)>/,
    );
    assert.match(
        solo,
        /static_cast<double>\(rcConfig\.detailSampleDist\) < 0\.9\)/,
    );
    // The tile grid is the one pair of locals the rest of generateTileCache
    // reads out of its step.
    assert.match(
        navigationConfigStepDeclaration("tileCache"),
        /return bbl::pal::NavTileGrid\{tileWidth, tileHeight\};\n\}$/,
    );
});
