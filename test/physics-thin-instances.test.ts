import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { lowerPhysicsThinInstances } from "../src/lowering/physics-thin-instance-lowerer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("thin physics translates upstream arithmetic and both exact corpus entry paths", () => {
    const changed = lowerPhysicsThinInstances(
        doctoredContext(
            "src/physics/havok-thin-instances.ts",
            "const offset = index * 16;",
            "const offset = index * 32;",
        ),
        false,
    );
    assert.match(changed.helpers, /const double offset = \(index \* 32\.0\)/);
    for (const id of ["scene103", "scene290"]) {
        const fileName = `corpus/babylon-lite/lab/lite/src/lite/${id}.ts`;
        for (const search of [
            undefined,
            id === "scene103" ? "?captureFrame=5" : "?captureFrame=180",
        ]) {
            const compiled = compileSource(readFileSync(fileName, "utf8"), {
                fileName,
                ...(search ? { search } : {}),
            });
            assert(
                compiled.manifest.features.includes("physics:thin-instances"),
            );
            assert.match(compiled.cpp, /enable_havok_thin_instance_physics/);
            if (id === "scene290")
                assert.match(compiled.cpp, /get_physics_body_instance_count/);
        }
    }
});

const tools = optionalNativeFixtureTools();
test(
    "thin bodies preserve matrix transforms, fanout, ray indices and native lifetime",
    { skip: !tools },
    async () => {
        interface Quat {
            x: number;
            y: number;
            z: number;
            w: number;
        }
        const { thinInstanceTransform } = await importPinnedModuleWithExports<{
            thinInstanceTransform(
                this: void,
                matrices: Float32Array,
                index: number,
                transform: [number[], number[]],
                rotation: Quat,
            ): [number[], number[]];
        }>("physics/havok-thin-instances.js", ["thinInstanceTransform"]);
        const matrices = [
            [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1],
            [0, 0, -2, 0, 0, -3, 0, 0, 4, 0, 0, 0, -4, 2, -1, 1],
            [
                0.7, 0.4, -0.2, 0, -0.3, 1.2, 0.1, 0, 0.2, -0.1, 0.8, 0, 1.25,
                3.75, -2.5, 1,
            ],
            [0, 0, 0, 0, 0, 1e-10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        ].map((values) => Float32Array.from(values));
        const output = resolve("artifacts/physics-thin-instances");
        mkdirSync(output, { recursive: true });
        const checks = matrices.map((matrix) => {
            const result = thinInstanceTransform(
                matrix,
                0,
                [
                    [0, 0, 0],
                    [0, 0, 0, 1],
                ],
                { x: 0, y: 0, z: 0, w: 1 },
            );
            const bits = [...new Uint32Array(matrix.buffer)].map(
                (word) => `std::bit_cast<float>(${word}u)`,
            );
            return `check_transform({${bits.join(", ")}}, {{${result[0].join(", ")}}, {${result[1].join(", ")}}});`;
        });
        writeFileSync(join(output, "transforms.inc"), checks.join("\n"));
        emitUpstreamGenerated(output, [
            "core",
            "camera:free",
            "renderer:scene",
            "physics:world",
            "physics:thin-instances",
            "physics:floating-origin",
            "physics:character-controller",
        ]);
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/O2",
            "/Gy",
            "/DBBLITE_HAS_PHYSICS_FLOATING_ORIGIN=1",
            "/DBBLITE_HAS_PHYSICS_CHARACTER=1",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            "/I",
            "native/include",
            "/I",
            output,
            "/I",
            join(output, "upstream/include"),
            "/I",
            join(output, "upstream/src"),
            `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`,
            "/external:W0",
            "test/fixtures/physics-thin-instances-check.cpp",
            join(output, "upstream/src/scene_core.cpp"),
            "/link",
            "/OPT:REF",
            `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
            "BulletDynamics.lib",
            "BulletCollision.lib",
            "LinearMath.lib",
        ]);
        execFileSync(executable, {
            encoding: "utf8",
            env: {
                ...tools!.environment,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}`,
            },
        });
    },
);
