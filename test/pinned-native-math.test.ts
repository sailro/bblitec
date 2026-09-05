import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { doubleLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { PickingLowerer } from "../src/lowering/picking-lowerer.js";
import { importPinnedModule, importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();

function floatArray(value: Float32Array): string {
    return `std::array<float, 16>{${[...new Uint32Array(value.buffer)].map(
        (bits) => `std::bit_cast<float>(${bits}u)`,
    ).join(", ")}}`;
}

function floatVector(value: readonly number[]): string {
    return `bbl::Vec3{${value.map((lane) => `static_cast<float>(${doubleLiteral(lane)})`).join(", ")}}`;
}

test("generated matrix and pick projections match the executed pin bit for bit", {
    skip: !tools,
}, async () => {
    const { mat4MultiplyInto } = await importPinnedModule<{
        mat4MultiplyInto: (out: Float32Array, d: number, left: Float32Array,
            i: number, right: Float64Array, j: number) => void;
    }>("math/mat4-multiply-into.js");
    const { computePickVP } = await importPinnedModuleWithExports<{
        computePickVP: (out: Float32Array, vp: Float32Array, x: number,
            y: number, width: number, height: number) => void;
    }>("picking/gpu-picker.js", ["computePickVP"]);
    const { computeGsPickMatrix } = await importPinnedModule<{
        computeGsPickMatrix: (out: Float32Array, x: number, y: number,
            width: number, height: number) => void;
    }>("picking/gs-picking-pipeline.js");
    const { eulerToQuat } = await importPinnedModule<{
        eulerToQuat: (x: number, y: number, z: number) => [number, number, number, number];
    }>("math/quat-euler.js");
    const { composeTrsLocalMatrix } = await importPinnedModule<{
        composeTrsLocalMatrix: (position: { x: number; y: number; z: number },
            rotation: { x: number; y: number; z: number; w: number },
            scaling: { x: number; y: number; z: number }) => Float32Array;
    }>("scene/world-matrix-state.js");
    const context = new LoweringContext();
    const output = resolve("artifacts/pinned-native-math-check");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "pinned_matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(output, "pinned_world_transform.hpp"), pinnedWorldTransformHeader(context));
    const picker = new PickingLowerer(context);
    writeFileSync(join(output, "picking_math.hpp"), picker.mathHeader(true));
    assert.doesNotMatch(picker.mathHeader(false), /compute_cloud_pick_matrix/);
    const cases: string[] = [];
    for (let sample = 0; sample < 12; ++sample) {
        const left = Float32Array.from({ length: 16 }, (_, lane) =>
            Math.sin(sample * 7 + lane) * (lane % 3 === 0 ? 1e5 : 0.2));
        if (sample === 1) {
            // Racer's back-left wheel under its imported root.
            left.set([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
                -0.5499999523162842, 0.30000001192092896, -0.6570000052452087, 1]);
        }
        const right = Float64Array.from({ length: 16 }, (_, lane) =>
            Math.cos(sample * 11 + lane) * (lane % 2 ? 1e-4 : 100));
        const product = new Float32Array(16);
        mat4MultiplyInto(product, 0, left, 0, right, 0);
        const rotation = (sample === 1
            ? [-0.000018417835235595703, 1.5707963705062866, -0.00016731875075493008]
            : [sample * 0.15, -sample * 0.2, sample * 0.33]
        ).map(Math.fround) as [number, number, number];
        const translation = (sample === 1
            ? [-10, 0.15000005066394806, -15]
            : [sample * 1e-6, sample * -100000.125, sample * 13.3]
        ).map(Math.fround);
        const [qx, qy, qz, qw] = eulerToQuat(...rotation);
        // SceneNode applies the pin's identity fast path, which also makes
        // an all-zero Euler tuple containing -0 produce canonical +0 lanes.
        const outer = composeTrsLocalMatrix(
            { x: translation[0]!, y: translation[1]!, z: translation[2]! },
            { x: qx, y: qy, z: qz, w: qw },
            { x: 1, y: 1, z: 1 },
        );
        const appliedOuter = new Float32Array(16);
        mat4MultiplyInto(appliedOuter, 0, outer, 0, Float64Array.from(left), 0);
        const x = sample * 123.125 - 17.5;
        const y = sample * 31.0625 + 0.5;
        const width = 1280 + sample;
        const height = 720 + sample;
        const projection = new Float32Array(16);
        const cloud = new Float32Array(16);
        computePickVP(projection, left, x, y, width, height);
        computeGsPickMatrix(cloud, x, y, width, height);
        const coordinates = [x, y, width, height].map(doubleLiteral).join(", ");
        cases.push(`{
    const auto left = ${floatArray(left)};
    const std::array<double, 16> right{${[...right].map(doubleLiteral).join(", ")}};
    const auto outer = bbl::upstream::outer_transform_matrix(${floatVector(translation)}, ${floatVector(rotation)});
    same(outer, ${floatArray(outer)});
    same(bbl::upstream::matrix_product(outer, left), ${floatArray(appliedOuter)});
    same(bbl::upstream::matrix_product(left, right), ${floatArray(product)});
    same(bbl::upstream::matrix_product(left.data(), right), ${floatArray(product)});
    std::array<float, 16> actual{};
    bbl::upstream::compute_pick_view_projection(actual, left, ${coordinates});
    same(actual, ${floatArray(projection)});
    bbl::upstream::compute_cloud_pick_matrix(actual, ${coordinates});
    same(actual, ${floatArray(cloud)});
}`);
    }
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include "pinned_matrix.hpp"
#include "picking_math.hpp"
#include "pinned_world_transform.hpp"
#include <bit>
#include <cassert>
#include <iostream>
void same(const std::array<float, 16>& actual, const std::array<float, 16>& expected) {
    for (std::size_t lane = 0; lane < 16; ++lane)
        assert(std::bit_cast<std::uint32_t>(actual[lane]) == std::bit_cast<std::uint32_t>(expected[lane]));
}
int main() {
${cases.join("\n")}
    std::cout << "pinned-native-math-check: ok\\n";
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", fixture,
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /pinned-native-math-check: ok/);
});
