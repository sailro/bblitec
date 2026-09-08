import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GizmoLowerer } from "../src/lowering/gizmo-lowerer.js";
import { lowerPointerDrag } from "../src/lowering/pointer-drag-lowerer.js";
import { lowerRotationPointerDrag } from "../src/lowering/rotation-pointer-drag-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools();
test("rotation drags preserve the pinned quaternion update through a mirrored scaled parent", { skip: !tools }, async () => {
    const output = resolve("artifacts/rotation-pointer-drag");
    mkdirSync(output, { recursive: true });
    const context = new LoweringContext();
    const source = join(output, "rotation.cpp");
    const parent = [0, 0, -2, 0, 0, 3, 0, 0, -4, 0, 0, 0, 7, 8, 9, 1];
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
#include <iostream>
#include <iomanip>
namespace bbl {
${new GizmoLowerer(context, ["gizmo:plane-rotation"])["mathHelpers"]()}
${cppFunction(lowerPointerDrag(context), "double drag_dot(")}
namespace upstream {
std::array<float,16> mesh_world_matrix(Engine&, const MeshRecord&) { return {1,0,0,0,0,1,0,0,0,0,1,0,2,3,4,1}; }
std::array<float,16> transform_node_world(Engine&, TransformNodeHandle) { return {${parent.join(",")}}; }
}
void set_mesh_rotation_quaternion(Engine& engine, MeshHandle handle, Vec4 q, bool) { engine.meshes[handle.value].rotation_quaternion = q; }
${lowerRotationPointerDrag(context)}
}
int main() {
    bbl::Engine engine;
    engine.meshes.emplace_back();
    engine.transform_nodes.emplace_back();
    std::cout << std::setprecision(17);
    for (const bool parented : {false, true}) {
        engine.meshes[0].transform_parent = parented ? bbl::TransformNodeHandle{0} : bbl::TransformNodeHandle{};
        for (const double angle : {0.0, 0.2, -0.6, 1.1}) {
            engine.meshes[0].rotation_quaternion = {static_cast<float>(std::sin(.15)),0,0,static_cast<float>(std::cos(.15))};
            bbl::drag_rotate(engine, bbl::MeshHandle{0}, {3,3,4}, {2+std::cos(angle),3+std::sin(angle),4}, {0,0,1});
            const auto q = engine.meshes[0].rotation_quaternion;
            std::cout << q.x << ' ' << q.y << ' ' << q.z << ' ' << q.w << '\\n';
        }
    }
}
`);
    const executable = join(output, "rotation.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source]);
    const native = execFileSync(executable, { encoding: "utf8" }).trim().split(/\r?\n/).map(row => row.split(" ").map(Number));
    type Quaternion = [number, number, number, number];
    const pin = await importPinnedModule<{
        quatFromAxisAngle: (...values: number[]) => Quaternion;
        quatMul: (...values: number[]) => Quaternion;
        quatNormalize: (value: Quaternion) => Quaternion;
        worldRotationToLocal: (node: unknown, ...values: number[]) => Quaternion;
    }>("gizmo/gizmo-math.js");
    const initial: Quaternion = [Math.fround(Math.sin(.15)), 0, 0, Math.fround(Math.cos(.15))];
    const reference = [false, true].flatMap(parented => [0, .2, -.6, 1.1].map(angle => {
        if (angle === 0) return initial;
        const delta = pin.quatFromAxisAngle(0, 0, 1, angle);
        const local = pin.worldRotationToLocal({ parent: parented ? { worldMatrix: new Float32Array(parent) } : null }, ...delta);
        return pin.quatNormalize(pin.quatMul(...local, ...initial)).map(Math.fround);
    }));
    const errors = native.map((row, pose) => row.map((value, lane) => Math.abs(value - reference[pose]![lane]!)));
    writeFileSync(join(output, "comparison.json"), JSON.stringify({ native, reference, errors }, null, 2) + "\n");
    assert(Math.max(...errors.flat()) < 1e-12);
});
