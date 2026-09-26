import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PickingLowerer } from "../src/lowering/picking-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("CPU picking rays preserve pinned projection, nullability and live tuple storage", async (t) => {
    const compiled = compileSource(`
        import { createPickingRay } from "babylon-lite";
        import type { Mat4 } from "babylon-lite";
        const identity = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
        let order = 0;
        function argument(index:number, value:number):number {
            order = order * 10 + index; return value;
        }
        function matrix():Mat4 { order = order * 10 + 3; return identity; }
        const ray = createPickingRay(argument(1, 50), argument(2, 50), matrix(), argument(4, 100), argument(5, 100));
        if (order !== 12345 || !ray) throw new Error("ray arguments");
        if (ray.origin[0] !== 0 || ray.origin[2] !== 1 || ray.direction[2] !== -1 || ray.length !== 1) throw new Error("reverse Z ray");
        const alias = ray.origin;
        alias[0] = 9;
        if (ray.origin[0] !== 9) throw new Error("ray origin identity");
        const other = createPickingRay(50, 50, identity, 100, 100);
        if (!other || other.origin[0] !== 0) throw new Error("fresh ray storage");
        const rays = [ray, other];
        if (rays[0]!.origin[0] !== 9) throw new Error("stored ray");
        const miss = createPickingRay(0, 0, new Float32Array(16), 100, 100);
        if (miss !== null) throw new Error("singular ray");
    `);
    assert(compiled.manifest.features.includes("picking:ray"));
    assert(!compiled.manifest.features.includes("picking:gpu"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const { createPickingRay } = await importPinnedModule<{
        createPickingRay(
            this: void,
            x: number,
            y: number,
            matrix: Float32Array,
            width: number,
            height: number,
        ): { origin: number[]; direction: number[]; length: number } | null;
    }>("picking/ray.js");
    const matrices = [
        new Float32Array(16),
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
        new Float32Array([
            2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 7.1234567, -9.987654, 11, 1,
        ]),
        new Float32Array(3),
        ...Array.from({ length: 8 }, (_, sample) =>
            Float32Array.from(
                { length: 16 },
                (_, lane) =>
                    Math.sin(sample * 19 + lane) *
                    (lane % 5 === 0 ? 1000 : 0.13),
            ),
        ),
    ];
    const cppNumber = (value: number): string =>
        Number.isNaN(value)
            ? "std::numeric_limits<double>::quiet_NaN()"
            : Number.isFinite(value)
              ? String(value)
              : `${value < 0 ? "-" : ""}std::numeric_limits<double>::infinity()`;
    const checks = matrices
        .flatMap((matrix) =>
            [
                [0, 0, 800, 600],
                [417, 222, 800, 600],
                [1, 2, 0, 0],
            ].map(([x, y, width, height]) => {
                const expected = createPickingRay(
                    x!,
                    y!,
                    matrix,
                    width!,
                    height!,
                );
                const bits = [...new Uint32Array(matrix.buffer)]
                    .map((value) => `std::bit_cast<float>(${value}u)`)
                    .join(", ");
                return `{ const auto actual = bbl::upstream::picking_ray::create_picking_ray_array(${x},${y},bbl::js::F32Array{${bits}},${width},${height});
            assert(actual.has_value() == ${expected !== null});
            ${
                expected
                    ? [
                          ...expected.origin,
                          ...expected.direction,
                          expected.length,
                      ]
                          .map(
                              (value, lane) =>
                                  `same(${lane < 3 ? `actual->origin[${lane}]` : lane < 6 ? `actual->direction[${lane - 3}]` : "actual->length"}, ${cppNumber(value)});`,
                          )
                          .join("\n")
                    : ""
            }
        }`;
            }),
        )
        .join("\n");
    const output = resolve("artifacts/picking-ray-check");
    const include = join(output, "bblite/upstream");
    mkdirSync(include, { recursive: true });
    writeFileSync(
        join(include, "picking_ray.hpp"),
        new PickingLowerer(new LoweringContext()).rayHeader(),
    );
    writeFileSync(join(output, "program.hpp"), compiled.cpp);
    writeFileSync(
        join(output, "check.cpp"),
        `
        #define main generated_scene_main
        #include "program.hpp"
        #undef main
        #include <bit>
        #include <cassert>
        void same(double actual,double expected) {
            assert((std::isnan(actual)&&std::isnan(expected)) || actual == expected ||
                std::abs(actual-expected) <= std::max(1.0,std::abs(expected))*1e-13);
        }
        void peer();
        int main() { assert(generated_scene_main() == 0); ${checks} peer(); }
    `,
    );
    writeFileSync(
        join(output, "peer.cpp"),
        `#include <bblite/upstream/picking_ray.hpp>
        void peer() { static_cast<void>(bbl::upstream::picking_ray::create_picking_ray_array(0,0,bbl::js::F32Array(16),1,1)); }`,
    );
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/permissive-",
        "/fp:precise",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        "/I",
        output,
        join(output, "check.cpp"),
        join(output, "peer.cpp"),
    ]);
    execFileSync(executable, { encoding: "utf8" });
});
