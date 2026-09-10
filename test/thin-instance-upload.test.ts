import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { pinnedShadowHeader } from "../src/lowering/shadow-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test("draw and shadow worlds preserve hierarchy, clone transforms and root mirroring", { skip: !tools }, async () => {
    interface Vector { x: number; y: number; z: number }
    interface Quaternion extends Vector { w: number }
    const { composeTrsLocalMatrix } = await importPinnedModule<{
        composeTrsLocalMatrix(position: Vector, rotation: Quaternion, scaling: Vector): ArrayLike<number>;
    }>("scene/world-matrix-state.js");
    const { mat4MultiplyInto } = await importPinnedModule<{
        mat4MultiplyInto(out: Float32Array | Float64Array, offset: number, left: ArrayLike<number>, leftOffset: number,
            right: ArrayLike<number>, rightOffset: number): void;
    }>("math/mat4-multiply-into.js");
    const { mat4ComposeInto } = await importPinnedModule<{
        mat4ComposeInto(out: Float64Array, offset: number, tx: number, ty: number, tz: number,
            qx: number, qy: number, qz: number, qw: number, sx: number, sy: number, sz: number): void;
    }>("math/mat4-compose-into.js");
    const { eulerToQuat } = await importPinnedModule<{
        eulerToQuat(x: number, y: number, z: number): [number, number, number, number];
    }>("math/quat-euler.js");
    const composeWide = (position: Vector, rotation: Quaternion, scaling: Vector): Float64Array => {
        const result = new Float64Array(16);
        mat4ComposeInto(result, 0, position.x, position.y, position.z,
            rotation.x, rotation.y, rotation.z, rotation.w, scaling.x, scaling.y, scaling.z);
        return result;
    };
    const multiply = (left: ArrayLike<number>, right: ArrayLike<number>): Float32Array => {
        const result = new Float32Array(16);
        mat4MultiplyInto(result, 0, left, 0, right, 0);
        return result;
    };
    const zero = { x: 0, y: 0, z: 0 }, unit = { x: 1, y: 1, z: 1 }, identity = { ...zero, w: 1 };
    const parent = new Float32Array(composeTrsLocalMatrix({ x: 7, y: -4, z: 3 },
        { x: 0, y: Math.fround(.6), z: 0, w: Math.fround(.8) }, { x: -2, y: 3, z: 4 }));
    const float = (value: number): string => `static_cast<float>(${value})`;
    const matrix = (value: ArrayLike<number>): string => `std::array<float, 16>{${Array.from(value, float).join(",")}}`;
    const rows: string[] = [];
    for (const pooled of [false, true]) for (const moved of [false, true]) for (const cloned of [false, true]) {
        const position = moved ? { x: 11, y: 2, z: -5 } : zero;
        const scaling = moved ? { x: 2, y: -3, z: 5 } : unit;
        const rotation = moved ? { x: 0, y: 0, z: Math.fround(.6), w: Math.fround(.8) } : identity;
        const outer = cloned ? { x: 17, y: -19, z: 23 } : zero;
        const local = composeTrsLocalMatrix(position, rotation, scaling);
        let expected = pooled ? multiply(parent, local) : parent;
        if (cloned) expected = multiply(new Float32Array(composeTrsLocalMatrix(outer, identity, unit)), expected);
        expected = expected.slice();
        for (let lane = 0; lane < 4; ++lane) expected[lane] = -expected[lane]!;
        rows.push(`{
            MeshRecord record;
            record.thin_instanced = ${pooled};
            record.instance_matrices.resize(1);
            record.instance_parent_matrix = ${matrix(parent)};
            record.position = {${position.x}, ${position.y}, ${position.z}};
            record.scaling = {${scaling.x}, ${scaling.y}, ${scaling.z}};
            record.has_rotation_quaternion = true;
            record.rotation_quaternion = {${[rotation.x, rotation.y, rotation.z, rotation.w].map(float).join(",")}};
            record.outer_position = {${outer.x}, ${outer.y}, ${outer.z}};
            const auto expected = ${matrix(expected)};
            check(pinned_instanced_world(record, scene, engine), expected);
            for (bool local_position : {false, true})
                check(pinned_draw_world(false, false, local_position, record, scene, engine), expected);
            record.outer_position.x += 5;
            auto updated = expected; updated[12] += 5;
            check(pinned_draw_world(false, false, false, record, scene, engine), updated);
        }`);
    }
    for (const parentKind of ["none", "mesh", "transform"]) for (const cloned of [false, true]) {
        const position = { x: 5000000.125, y: -7000000.0625, z: 11 };
        const rotation = { x: 0, y: 0, z: Math.fround(.6), w: Math.fround(.8) };
        const scaling = { x: 2, y: -3, z: 5 };
        const local = composeWide(position, rotation, scaling);
        const parentLocal = composeWide({ x: 13, y: 17, z: -19 }, identity, { x: -2, y: 3, z: 4 });
        let expected = parentKind === "none" ? local : new Float64Array(multiply(new Float32Array(parentLocal), new Float32Array(local)));
        if (cloned) {
            const [x, y, z, w] = eulerToQuat(.25, -.5, .75);
            const outer = composeWide({ x: -31, y: 37, z: 41 }, { x, y, z, w }, unit);
            const product = new Float64Array(16);
            mat4MultiplyInto(product, 0, outer, 0, expected, 0);
            expected = product;
        }
        rows.push(`{
            MeshRecord record;
            record.position = {${position.x}, ${position.y}, ${position.z}};
            record.scaling = {2, -3, 5};
            record.has_rotation_quaternion = true;
            record.rotation_quaternion = {0, 0, ${float(rotation.z)}, ${float(rotation.w)}};
            ${parentKind === "none" ? "" : `record.${parentKind === "mesh" ? "parent = MeshHandle" : "transform_parent = TransformNodeHandle"}{0};`}
            ${cloned ? "record.outer_position = {-31,37,41}; record.outer_rotation = {.25f,-.5f,.75f};" : ""}
            const auto expected = std::array<double, 16>{${Array.from(expected).join(",")}};
            const auto actual = upstream::shadow_caster_world(engine, record);
            for (std::size_t lane = 0; lane < 16; ++lane)
                assert(std::abs(actual[lane] - expected[lane]) <= 1e-12 * std::max(1.0, std::abs(expected[lane])));
        }`);
    }
    const output = resolve("artifacts/thin-instance-world");
    mkdirSync(output, { recursive: true });
    const context = new LoweringContext();
    const renderer = new RendererLowerer(context).lowerRenderPlan({ gpuInstancing: true }).source;
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const upstream = ["std::array<float, 16> mesh_local_matrix(", "std::array<float, 16> transform_node_local_matrix(",
        "std::array<float, 16> transform_node_world(", "std::array<float, 16> mesh_world_matrix(",
        "std::array<float, 16> build_instance_parent_world(", "std::array<double, 16> apply_mesh_outer_transform("].map(signature => cppFunction(renderer, signature)).join("\n");
    const shadow = pinnedShadowHeader(context);
    const helpers = ["outer_draw_world", "draw_world", "scene_deformation_draw_world", "deformed_draw_world",
        "instance_parent_draw_world", "pinned_identity_world", "pinned_x_mirrored_world", "pinned_mesh_world",
        "pinned_instanced_world", "pinned_draw_world"].map(name => cppFunction(shared, `inline std::array<float, 16> ${name}(`));
    writeFileSync(join(output, "matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(output, "world.hpp"), pinnedWorldTransformHeader(context));
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, `#define BBLITE_HAS_PBR_RENDERER 1
#define BBLITE_GPU_INSTANCING 1
#define BBLITE_FLOATING_ORIGIN 0
#include "matrix.hpp"
#include "world.hpp"
#include <cassert>
namespace bbl::upstream {
${upstream}
${cppFunction(shadow, "inline std::array<double, 16> shadow_caster_local(")}
${cppFunction(shadow, "inline std::array<double, 16> shadow_caster_world(")}
}
namespace bbl::pal {
${cppFunction(shared, "inline bool pinned_record_instanced(")}
${helpers.join("\n")}
}
void check(const std::array<float, 16>& actual, const std::array<float, 16>& expected) {
    for (std::size_t lane = 0; lane < 16; ++lane)
        assert(std::abs(actual[lane] - expected[lane]) <= 1e-6f * std::max(1.0f, std::abs(expected[lane])));
}
int main() {
    using namespace bbl;
    using namespace bbl::pal;
    Engine engine; Scene scene;
    MeshRecord parent_mesh; parent_mesh.position = {13,17,-19}; parent_mesh.scaling = {-2,3,4};
    engine.meshes.push_back(parent_mesh);
    TransformNodeRecord parent_node; parent_node.position = {13,17,-19}; parent_node.scaling = {-2,3,4};
    engine.transform_nodes.push_back(parent_node);
    ${rows.join("\n")}
}`);
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    execFileSync(executable, { stdio: "pipe" });
});

test("both backends resize instance streams and upload current matrices and colors", { skip: !tools }, () => {
    const output = resolve("artifacts/thin-instance-upload");
    mkdirSync(output, { recursive: true });
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8").replaceAll("\r\n", "\n");
    const helpers = ["inline bool thin_instance_pool_grew(", "inline std::size_t thin_instance_active_count(\n",
        "inline void pinned_instance_matrices("].map(signature => cppFunction(shared, signature)).join("\n");
    const updates = ["sdl_gpu", "dawn"].map(backend => {
        const source = readFileSync(`native/src/pal_${backend}.cpp`, "utf8");
        const condition = source.indexOf("mesh.thin_instanced &&");
        const start = source.lastIndexOf("if (", condition);
        assert.ok(condition >= 0 && start >= 0, backend);
        const block = cppFunction(source.slice(start), "if (");
        return `void update_${backend}(const MeshRecord& mesh, UploadedMesh& ${backend === "dawn" ? "dawn_mesh" : "gpu_mesh"}) {
            [[maybe_unused]] State state;
            [[maybe_unused]] Uploads frame_buffer_uploads;
            std::vector<std::array<float, 16>> pinned_instance_scratch;
            ${block}
        }`;
    });
    writeFileSync(join(output, "updates.hpp"), `namespace bbl { ${helpers}\n${updates.join("\n")} }`);
    const file = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(file, readFileSync("test/fixtures/thin-instance-upload-check.cpp"));
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", file]);
    execFileSync(executable, { stdio: "pipe" });
});
