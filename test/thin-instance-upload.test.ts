import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "draw and shadow worlds are the pinned worldMatrix over loaded, parented and edited roots",
    { skip: !tools },
    async () => {
        interface Vector {
            x: number;
            y: number;
            z: number;
        }
        interface Quaternion extends Vector {
            w: number;
        }
        const { composeTrsLocalMatrix } = await importPinnedModule<{
            composeTrsLocalMatrix(
                this: void,
                position: Vector,
                rotation: Quaternion,
                scaling: Vector,
            ): ArrayLike<number>;
        }>("scene/world-matrix-state.js");
        const { multiplyMat4IntoBuffer } = await importPinnedModule<{
            multiplyMat4IntoBuffer(
                this: void,
                out: Float32Array | Float64Array,
                offset: number,
                left: ArrayLike<number>,
                leftOffset: number,
                right: ArrayLike<number>,
                rightOffset: number,
            ): void;
        }>("math/multiply-mat4-into-buffer.js");
        const { composeMat4IntoBuffer } = await importPinnedModule<{
            composeMat4IntoBuffer(
                this: void,
                out: Float64Array,
                offset: number,
                tx: number,
                ty: number,
                tz: number,
                qx: number,
                qy: number,
                qz: number,
                qw: number,
                sx: number,
                sy: number,
                sz: number,
            ): void;
        }>("math/compose-mat4-into-buffer.js");
        const { eulerXYZToQuatTuple } = await importPinnedModule<{
            eulerXYZToQuatTuple(
                this: void,
                x: number,
                y: number,
                z: number,
            ): [number, number, number, number];
        }>("math/quat-euler.js");
        const composeWide = (
            position: Vector,
            rotation: Quaternion,
            scaling: Vector,
        ): Float64Array => {
            const result = new Float64Array(16);
            composeMat4IntoBuffer(
                result,
                0,
                position.x,
                position.y,
                position.z,
                rotation.x,
                rotation.y,
                rotation.z,
                rotation.w,
                scaling.x,
                scaling.y,
                scaling.z,
            );
            return result;
        };
        const multiply = (
            left: ArrayLike<number>,
            right: ArrayLike<number>,
        ): Float32Array => {
            const result = new Float32Array(16);
            multiplyMat4IntoBuffer(result, 0, left, 0, right, 0);
            return result;
        };
        const zero = { x: 0, y: 0, z: 0 },
            unit = { x: 1, y: 1, z: 1 },
            identity = { ...zero, w: 1 };
        const parent = new Float32Array(
            composeTrsLocalMatrix(
                { x: 7, y: -4, z: 3 },
                { x: 0, y: Math.fround(0.6), z: 0, w: Math.fround(0.8) },
                { x: -2, y: 3, z: 4 },
            ),
        );
        const float = (value: number): string => `static_cast<float>(${value})`;
        const matrix = (value: ArrayLike<number>): string =>
            `std::array<float, 16>{${Array.from(value, float).join(",")}}`;
        const rows: string[] = [];
        // A loaded record: its node's world as the parent world, its own TRS
        // and the imported root's edit on the left. A thin-instance pool
        // draws the same world; its matrices compose in the vertex stage.
        for (const pooled of [false, true])
            for (const moved of [false, true])
                for (const cloned of [false, true]) {
                    const position = moved ? { x: 11, y: 2, z: -5 } : zero;
                    const scaling = moved ? { x: 2, y: -3, z: 5 } : unit;
                    const rotation = moved
                        ? {
                              x: 0,
                              y: 0,
                              z: Math.fround(0.6),
                              w: Math.fround(0.8),
                          }
                        : identity;
                    const outer = cloned ? { x: 17, y: -19, z: 23 } : zero;
                    const local = composeTrsLocalMatrix(
                        position,
                        rotation,
                        scaling,
                    );
                    const root = cloned
                        ? multiply(
                              new Float32Array(
                                  composeTrsLocalMatrix(outer, identity, unit),
                              ),
                              parent,
                          )
                        : parent;
                    const expected = multiply(root, local);
                    rows.push(`{
            MeshRecord record;
            record.thin_instanced = ${pooled};
            record.instance_matrices.resize(1);
            record.parent_world = ${matrix(parent)};
            record.position = {${position.x}, ${position.y}, ${position.z}};
            record.scaling = {${scaling.x}, ${scaling.y}, ${scaling.z}};
            record.has_rotation_quaternion = true;
            record.rotation_quaternion = {${[rotation.x, rotation.y, rotation.z, rotation.w].map(float).join(",")}};
            record.outer_position = {${outer.x}, ${outer.y}, ${outer.z}};
            const auto expected = ${matrix(expected)};
            check(upstream::mesh_world_matrix(engine, record), expected);
            check(mesh_block_world(scene, engine, record), expected);
            record.outer_position.x += 5;
            auto updated = expected; updated[12] += 5;
            check(mesh_block_world(scene, engine, record), updated);
        }`);
                }
        // The double-width composition the shadow fit takes. A parented
        // record composes under its parent; the imported root's edit reaches
        // it through the chain's root record.
        for (const parentKind of ["none", "mesh", "transform"])
            for (const cloned of [false, true]) {
                const position = { x: 5000000.125, y: -7000000.0625, z: 11 };
                const rotation = {
                    x: 0,
                    y: 0,
                    z: Math.fround(0.6),
                    w: Math.fround(0.8),
                };
                const scaling = { x: 2, y: -3, z: 5 };
                const local = composeWide(position, rotation, scaling);
                const parentLocal = composeWide(
                    { x: 13, y: 17, z: -19 },
                    identity,
                    { x: -2, y: 3, z: 4 },
                );
                let expected =
                    parentKind === "none"
                        ? local
                        : new Float64Array(
                              multiply(
                                  new Float32Array(parentLocal),
                                  new Float32Array(local),
                              ),
                          );
                if (cloned && parentKind === "none") {
                    const [x, y, z, w] = eulerXYZToQuatTuple(0.25, -0.5, 0.75);
                    const outer = composeWide(
                        { x: -31, y: 37, z: 41 },
                        { x, y, z, w },
                        unit,
                    );
                    const product = new Float64Array(16);
                    multiplyMat4IntoBuffer(product, 0, outer, 0, expected, 0);
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
            const auto actual = upstream::mesh_world_matrix_f64(engine, record);
            for (std::size_t lane = 0; lane < 16; ++lane)
                assert(std::abs(actual[lane] - expected[lane]) <= 1e-12 * std::max(1.0, std::abs(expected[lane])));
        }`);
            }
        const output = resolve("artifacts/thin-instance-world");
        mkdirSync(output, { recursive: true });
        const context = new LoweringContext();
        const renderer = new RendererLowerer(context).lowerRenderPlan({
            gpuInstancing: true,
        }).source;
        const shared = sharedGpuSource();
        const upstream = [
            "std::array<float, 16> mesh_local_matrix(",
            "std::array<float, 16> transform_node_local_matrix(",
            "std::array<float, 16> transform_node_world(",
            "std::optional<std::array<float, 16>> mesh_root_world(",
            "std::array<float, 16> mesh_world_matrix(",
            "std::array<double, 16> mesh_world_matrix_f64(",
        ]
            .map((signature) => cppFunction(renderer, signature))
            .join("\n");
        writeFileSync(join(output, "matrix.hpp"), pinnedMatrixHeader(context));
        writeFileSync(
            join(output, "world.hpp"),
            pinnedWorldTransformHeader(context),
        );
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            `#define BBLITE_GPU_INSTANCING 1
#define BBLITE_FLOATING_ORIGIN 0
#include "matrix.hpp"
#include "world.hpp"
#include <cassert>
namespace bbl::upstream {
${upstream}
}
namespace bbl::pal {
${cppFunction(shared, "std::array<float, 16> mesh_block_world(")}
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
}`,
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/DBBLITE_HAS_PBR_RENDERER=1",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "/I",
            "native/include",
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);

test(
    "both backends resize instance streams and upload current matrices and colors",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/thin-instance-upload");
        mkdirSync(output, { recursive: true });
        const shared = sharedGpuSource().replaceAll("\r\n", "\n");
        const helpers = [
            "inline bool thin_instance_pool_grew(",
            "inline std::size_t thin_instance_active_count(\n",
            "std::vector<float> instance_colors_for_upload(",
        ]
            .map((signature) => cppFunction(shared, signature))
            .join("\n");
        // The pool's refresh is the shared row sync's (`sync_plan_mesh_rows`);
        // each backend supplies only the two writes it asks for.
        const synchronize = readFileSync(
            "native/src/pal_scene_synchronize.hpp",
            "utf8",
        );
        const condition = synchronize.indexOf("mesh.thin_instanced &&");
        const start = synchronize.lastIndexOf("if (", condition);
        assert.ok(condition >= 0 && start >= 0, "the shared pool refresh");
        const refresh = `template <class Rows>
        void refresh_pool(const MeshRecord& mesh, UploadedMesh& gpu, Rows& rows) {
            ${cppFunction(synchronize.slice(start), "if (")}
        }`;
        const updates = [
            ["sdl_gpu", "MeshRowUploads", "Uploads& uploads;"],
            ["dawn", "MeshRowWrites", "Engine* engine = nullptr;"],
        ].map(([backend, rows, member]) => {
            const source = readFileSync(
                `native/src/pal_${backend}.cpp`,
                "utf8",
            );
            const record = source.slice(source.indexOf(`struct ${rows} {`));
            const writes = [
                "void recreate_instances(",
                "void update_instances(",
            ]
                .map((signature) => cppFunction(record, signature))
                .join("\n");
            return `struct ${rows} {
            State& state;
            ${member}
            ${writes}
        };
        void update_${backend}(const MeshRecord& mesh, UploadedMesh& gpu) {
            State state;
            [[maybe_unused]] Uploads uploads;
            ${rows} rows{state, ${backend === "dawn" ? "nullptr" : "uploads"}};
            refresh_pool(mesh, gpu, rows);
        }`;
        });
        writeFileSync(
            join(output, "updates.hpp"),
            `namespace bbl { ${readFileSync("test/fixtures/gpu-writer-recorder.hpp", "utf8")}
${helpers}\n${refresh}\n${updates.join("\n")} }`,
        );
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        writeFileSync(
            file,
            readFileSync("test/fixtures/thin-instance-upload-check.cpp"),
        );
        runNativeFixtureCompiler(tools!, [
            "/nologo",
            "/std:c++20",
            "/DBBLITE_HAS_PICKING=1",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "/I",
            "native/include",
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
