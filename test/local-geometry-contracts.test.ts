import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { cppFunction, cppRecord, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("local geometry survives shader, physics, imported-wheel and hierarchy-pool transforms", t => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("A native fixture compiler is required."); return; }
    const output = resolve("artifacts/local-geometry-contracts"); mkdirSync(output, { recursive: true });
    const context = new LoweringContext(), plan = new RendererLowerer(context).lowerRenderPlan({ gpuInstancing: true }), renderer = plan.source;
    const scene = new SceneLowerer(context).lowerCore().source;
    const shared = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    writeFileSync(join(output, "matrix.hpp"), pinnedMatrixHeader(context));
    writeFileSync(join(output, "world.hpp"), pinnedWorldTransformHeader(context));
    writeFileSync(join(output, "geometry.hpp"), `namespace bbl::upstream {
        ${cppRecord(plan.header!, "enum class ShaderSystemMatrix")}
        ${cppRecord(plan.header!, "struct ShaderVariantStageBlock")}
        ${["mesh_local_matrix", "transform_node_local_matrix", "transform_node_world", "mesh_world_matrix"].map(name =>
            cppFunction(renderer, `std::array<float, 16> ${name}(`)).join("\n")}
    }
    namespace bbl {
        ${["mark_mesh_dirty", "mark_mesh_runtime_transform", "prepare_imported_mesh_quaternion_write", "set_mesh_rotation_quaternion"].map(name =>
            cppFunction(scene, `void ${name}(`)).join("\n")}
    }
    namespace bbl::pal {
        ${cppRecord(shared, "struct GpuVertex {")}
        ${["inline std::array<float, 16> outer_draw_world(", "inline std::vector<GpuVertex> transformed_vertices(",
            "inline std::vector<GpuVertex> local_vertices(", "inline std::array<float, 16> shader_draw_world(",
            "inline std::optional<std::array<float, 16>> shader_world_view("].map(signature => cppFunction(shared, signature)).join("\n")}
        ${cppRecord(shared, "struct ShaderPassMatrices {")}
        ${cppRecord(shared, "struct ShaderDrawMatrices {")}
        ${cppFunction(shared, "inline bool block_is_shared_scene_matrix(")}
        ${cppFunction(shared, "inline void shader_stage_block_floats(")}
        ${shared.slice(shared.indexOf("struct SharedGeometryIdentity {"), shared.indexOf("/** Drops one mesh's reference"))}
    }`);
    const consumers: string[] = [];
    for (const file of ["pal_sdl_gpu.cpp", "pal_dawn.cpp", "pal_render_capture.hpp"]) {
        const source = readFileSync(`native/src/${file}`, "utf8");
        let offset = 0;
        while (true) {
            const start = source.indexOf("const ShaderDrawMatrices shader_matrices(", offset);
            if (start < 0) break;
            const apply = source.indexOf("shader_matrices.apply(", start), end = source.indexOf(";", apply) + 1;
            assert.ok(apply > start && end > apply);
            consumers.push(`std::vector<float> pack_${consumers.length}(const Engine& engine, const ShaderPassMatrices& pass_matrices,
                const upstream::ShaderVariantStageBlock& block, const MaterialRecord& material) {
                struct Item { MeshHandle mesh{0}; };
                [[maybe_unused]] const Item item{}, draw_item{};
                [[maybe_unused]] const struct { Item item; } draw{};
                [[maybe_unused]] const auto& draw_pass_matrices = pass_matrices;
                [[maybe_unused]] const auto& frame_pass_matrices = pass_matrices;
                ${source.slice(start, end)}
                std::vector<float> values; shader_stage_block_floats(block, shader_pass_matrices, material, values); return values;
            }`);
            offset = end;
        }
    }
    writeFileSync(join(output, "shader-consumers.hpp"), consumers.join("\n") +
        `\nconst std::array packers{${consumers.map((_, index) => `pack_${index}`).join(",")}};`);
    for (const [backend, file, gpu] of [["Sdl", "pal_sdl_gpu.cpp", "gpu_mesh"], ["Dawn", "pal_dawn.cpp", "dawn_mesh"]] as const) {
        const synchronize = cppFunction(readFileSync(`native/src/${file}`, "utf8"), "void synchronize()");
        const condition = synchronize.indexOf("mesh.gpu_deformation &&");
        const start = synchronize.lastIndexOf("if (", condition), end = synchronize.indexOf("\n        };", start);
        assert.ok(condition >= 0 && start >= 0 && end > start);
        writeFileSync(join(output, `${backend}Transforms.hpp`), `void synchronize() {
            for (std::size_t index = 0; index < engine.meshes.size(); ++index) {
                const auto& mesh = engine.meshes[index]; auto& ${gpu} = uploaded[index]; const auto& item = items[index];
                ${synchronize.slice(start, end)}
        }`);
    }
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", output, "test/fixtures/local-geometry-contracts-check.cpp"]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
