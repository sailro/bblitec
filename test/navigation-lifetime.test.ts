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
import { navigationBuildPlanDeclarations } from "../src/lowering/navigation-build-plan.js";
import { navigationLibraryHeader } from "../src/lowering/navigation-library.js";
import { navigationQueryDefaultsDeclaration } from "../src/lowering/navigation-lowerer.js";
import { pinnedHeader } from "../src/lowering/pinned-header.js";

const tools = optionalNativeFixtureTools();
function runNavigationFixture(name: string): string {
    const output = resolve("artifacts", name);
    mkdirSync(output, { recursive: true });
    const executable = join(output, `${name}.exe`);
    // The query defaults and both arms' build plans the generated
    // navigation header hands the PAL.
    writeFileSync(
        join(output, "navigation_build_plan.hpp"),
        pinnedHeader(
            [
                "<bblite/js_data.hpp>",
                "<bblite/pal_navigation.hpp>",
                "<bblite/pinned_records.hpp>",
                "<bblite/runtime.hpp>",
                "",
                "<cmath>",
                "<cstdint>",
                "<type_traits>",
                "<vector>",
            ],
            [
                navigationQueryDefaultsDeclaration(),
                navigationBuildPlanDeclarations(["solo", "tileCache"]),
            ].join("\n"),
        ),
    );
    // The templates the PAL instantiates, where it includes them from.
    mkdirSync(join(output, "bblite", "upstream"), { recursive: true });
    writeFileSync(
        join(output, "bblite", "upstream", "navigation_library.hpp"),
        navigationLibraryHeader(true),
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

test("navigation build plans are lowered from the recast-navigation packages", () => {
    const solo = navigationBuildPlanDeclarations(["solo"]);
    // Each rcConfig store narrows at the field's own width, as the wrapper's
    // setter does, and each comparison is JavaScript's: against the double
    // 0.9, which a float-width port would have spelled 0.9f.
    assert.match(
        solo,
        /rcConfig\.minRegionArea = bbl::js::numeric_store_value<std::remove_reference_t<decltype\(rcConfig\.minRegionArea\)>>/,
    );
    assert.match(
        solo,
        /static_cast<double>\(rcConfig\.detailSampleDist\) < 0\.9\)/,
    );
    // The spreads between the pinned cfg and createRcConfig resolve per
    // key: a key the scene may give falls back to the wrapper's default,
    // and one the solo arm's cfg never carries is that default alone.
    assert.match(solo, /params\.cs\.value_or\(0\.2\)/);
    assert.match(
        solo,
        /rcConfig\.tileSize = bbl::js::numeric_store_value<[^;]*>\(0\.0\);/,
    );
    assert.match(solo, /navMeshCreateParams\.buildBvTree = true;/);
    // Core's setOffMeshConnections packs the scene's connections with the
    // optional members' own defaults, and the generator calls it only when
    // the scene gives a non-empty list.
    assert.match(
        solo,
        /if \(!params\.off_mesh_connections\.empty\(\)\) \{\s*navMeshCreateParams\.offMeshConnections = set_off_mesh_connections\(params\.off_mesh_connections\);/,
    );
    assert.match(solo, /return bbl::pal::NavOffMeshPacking\{\};/);
    assert.match(
        solo,
        /userIds\.push_back\(\(!connection\.user_id\.has_value\(\) \? \(1000\.0 \+ i\) : \(\*connection\.user_id\)\)\);/,
    );
    const tile = navigationBuildPlanDeclarations(["tileCache"]);
    // The tile-cache arm's cfg always sets its own three, the pin's `?? N`
    // included.
    assert.match(tile, /params\.expected_layers_per_tile\.value_or\(1\.0\)/);
    assert.match(tile, /bbl::pinned::present\(params\.max_obstacles\)/);
    // The package's own tile/poly bit split, over its own dtIlog2.
    assert.match(tile, /inline double dt_ilog2\(\s*double v\)/);
    assert.match(tile, /dt_ilog2\(dt_next_pow2\(/);
    // The tile grid is the one pair of locals the rest of generateTileCache
    // reads out of its step.
    assert.match(
        tile,
        /return bbl::pal::NavTileGrid\{tileWidth, tileHeight\};/,
    );
    assert.match(tile, /build\.linear_allocator_capacity = 32000\.0;/);
});

test("the wrapper JavaScript over Recast/Detour objects is lowered as templates", () => {
    const library = navigationLibraryHeader(true);
    // Core's navmesh walk: each wrapper accessor is the raw member it
    // reads, and a null tile header is skipped as the wrapper's null.
    assert.match(
        library,
        /template <typename NavMesh>\s*inline bbl::pal::NavMeshPositionsAndIndices get_nav_mesh_positions_and_indices\(/,
    );
    assert.match(
        library,
        /navMesh->getTile\(bbl::js::NumberArgument\{static_cast<double>\(tileIndex\)\}\)/,
    );
    assert.match(library, /if \(tileHeader == nullptr\) \{\s*continue;/);
    assert.match(
        library,
        /indices\.push_back\(static_cast<double>\(tri\+\+\)\);/,
    );
    // The solo generator's normalization, over the glue's walkable area.
    assert.match(
        library,
        /solo_nav_mesh_poly_areas_and_flags\(\s*PolyMesh\* polyMesh,\s*double walkableArea\)/,
    );
    assert.match(library, /polyMesh->areas\[[^\]]*\]\) == walkableArea\)/);
    // The tile-cache default process, only where the scene has a cache.
    assert.match(library, /inline void default_tile_cache_mesh_process\(/);
    assert.doesNotMatch(
        navigationLibraryHeader(false),
        /default_tile_cache_mesh_process/,
    );
});
