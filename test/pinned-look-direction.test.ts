import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { quatFromLookDirectionRH } from "@babylonjs/lite";

import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedLookDirectionHeader } from "../src/lowering/pinned-look-direction.js";
import { pinnedNormalizeVec3Header } from "../src/lowering/pinned-normalize-vec3.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const cases = [
    {
        forward: { x: 0, y: 0, z: 1 },
        up: { x: 0, y: 1, z: 0 },
    },
    {
        forward: { x: 3, y: -2, z: 8 },
        up: { x: 0.2, y: 4, z: -1 },
    },
    {
        forward: { x: 0, y: 0, z: 0 },
        up: { x: 0, y: 1, z: 0 },
    },
    {
        forward: { x: 0, y: 1, z: 0 },
        up: { x: 0, y: 2, z: 0 },
    },
    {
        forward: { x: 1e100, y: -2e100, z: 3e100 },
        up: { x: -4e99, y: 5e99, z: 6e99 },
    },
] as const;

test("look-direction quaternion is emitted from its pinned declarations", () => {
    const header = pinnedLookDirectionHeader(new LoweringContext());
    assert.match(header, /quat_from_rotation_basis\(/);
    assert.match(header, /quat_from_look_direction_rh\(/);
    assert.match(header, /bbl::js::hypot_js\(/);
    assert.match(header, /bbl::js::or_number\(/);

    const result = compileSource(`
        import { quatFromLookDirectionRH } from "@babylonjs/lite";
        const q = quatFromLookDirectionRH(
            { x: 3, y: -2, z: 8 },
            { x: 0.2, y: 4, z: -1 },
        );
        const used = q.x + q.y + q.z + q.w;
    `);
    assert.ok(result.manifest.features.includes("math:look-direction"));
    assert.match(
        result.cpp,
        /#include <bblite\/upstream\/pinned_look_direction\.hpp>/,
    );
    assert.match(
        result.cpp,
        /bbl::upstream::quat_from_look_direction_rh\(/,
    );

    const unused = compileSource("const untouched = 1;");
    assert.ok(!unused.manifest.features.includes("math:look-direction"));
    assert.doesNotMatch(
        unused.cpp,
        /bblite\/upstream\/pinned_look_direction\.hpp/,
    );
});

const nativeTools = optionalNativeFixtureTools();
test("generated math headers link across translation units and match the pinned runtime", {
    skip: !nativeTools,
}, () => {
    const output = resolve("artifacts/pinned-look-direction-check");
    const includeRoot = join(output, "include");
    const generatedHeader = join(
        includeRoot,
        "bblite/upstream/pinned_look_direction.hpp",
    );
    mkdirSync(dirname(generatedHeader), { recursive: true });
    writeFileSync(
        generatedHeader,
        pinnedLookDirectionHeader(new LoweringContext()),
        "utf8",
    );
    writeFileSync(
        join(dirname(generatedHeader), "pinned_normalize_vec3.hpp"),
        pinnedNormalizeVec3Header(new LoweringContext()),
        "utf8",
    );

    const executable = join(output, "pinned-look-direction-check.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        includeRoot,
        "/I",
        "native/include",
        "test/fixtures/pinned-look-direction-check.cpp",
        "test/fixtures/pinned-math-link-peer.cpp",
    ]);

    const rows = execFileSync(executable, [], { encoding: "utf8" })
        .trim()
        .split(/\r?\n/)
        .map((row) => row.split(",").map(Number));
    assert.equal(rows.length, cases.length);
    for (let index = 0; index < cases.length; index += 1) {
        const expected = quatFromLookDirectionRH(
            cases[index]!.forward,
            cases[index]!.up,
        );
        const expectedComponents = [
            expected.x,
            expected.y,
            expected.z,
            expected.w,
        ];
        assert.equal(rows[index]!.length, expectedComponents.length);
        for (
            let component = 0;
            component < expectedComponents.length;
            component += 1
        ) {
            const actual = rows[index]![component]!;
            const wanted = expectedComponents[component]!;
            assert.ok(
                Math.abs(actual - wanted) <=
                    1e-12 * Math.max(1, Math.abs(wanted)),
                `case ${index} component ${component}: ${actual} != ${wanted}`,
            );
        }
    }
});
