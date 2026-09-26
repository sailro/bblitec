import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedSharedVariantDecls } from "../src/pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { pinnedInstanceAttributesCpp } from "../src/lowering/thin-instance-attributes.js";
import { composeNodeMaterial } from "../src/pinned-node-material.js";
import { isRecord } from "../src/json-fields.js";
import {
    cppDeclaration,
    cppFunction,
    cppRecord,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sceneBackendSource,
    sharedGpuSource,
} from "./native-fixture.js";

test("PBR feature keys and both backend stream bindings agree with pinned instance colors", async (t) => {
    const tools = optionalNativeFixtureTools(),
        dawnInclude = resolve("artifacts/tools/dawn/include");
    if (!tools || !existsSync(join(dawnInclude, "webgpu/webgpu.h"))) {
        t.skip("Native compiler and GPU headers are required.");
        return;
    }
    const output = resolve("artifacts/instance-stream-binding");
    mkdirSync(output, { recursive: true });
    const shared = sharedGpuSource();
    const sdl = sceneBackendSource("sdl"),
        dawn = sceneBackendSource("dawn");
    const key = cppFunction(shared, "PinnedVariantKey pinned_variant_key(");
    const start = key.indexOf(
        "if (draw.item.mesh.value < engine.meshes.size())",
    );
    assert.ok(start >= 0);
    const sdlDraw = cppFunction(sdl, "void draw_pinned_variant(");
    const nodeDraw = cppFunction(sdl, "void draw_node_variant(");
    const nodeBindStart = nodeDraw.indexOf("const bool instanced_draw =");
    const nodeBindEnd = nodeDraw.indexOf(
        "#if BBLITE_NODE_GEOMETRY_VARIANTS",
        nodeBindStart,
    );
    assert(nodeBindStart >= 0 && nodeBindEnd > nodeBindStart);
    const graph: unknown = JSON.parse(
        readFileSync(
            "corpus/babylon-lite/lab/public/playroom/shaders/domino.json",
            "utf8",
        ),
    );
    assert(isRecord(graph));
    const nodeGraph = await composeNodeMaterial(
        graph,
        "instance-binding-domino",
        { hasInstances: true },
    );
    const bindStart = sdlDraw.indexOf("const bool instanced_draw =");
    const bindEnd = sdlDraw.indexOf(
        "const SDL_GPUBufferBinding pinned_index_binding",
        bindStart,
    );
    assert.ok(bindStart >= 0 && bindEnd > bindStart);
    writeFileSync(
        join(output, "features.hpp"),
        pinnedSharedVariantDecls(
            new LoweringContext(),
            "Pinned instance feature constants",
        ) +
            `\nnamespace bbl::upstream {\n${pinnedInstanceAttributesCpp(new LoweringContext())}\nstruct NodeVariantAttribute {std::string_view name; unsigned location;};\nstruct NodeVariantEntry {std::size_t first_attribute; std::size_t attribute_count; bool uses_instance_index;};\nconstexpr std::array<NodeVariantAttribute, ${nodeGraph.attributes.length + 1}> node_variant_attributes{{{"position",0},${nodeGraph.attributes.map(({ name, location }) => `{"${name}",${location}}`).join(",")}}};\nconstexpr NodeVariantEntry node_plain{0,1,false};\nconstexpr NodeVariantEntry node_instanced{1,${nodeGraph.attributes.length},${nodeGraph.usesInstanceIndex}};\n}\n`,
    );
    writeFileSync(
        join(output, "bindings.hpp"),
        [
            cppRecord(shared, "struct GpuVertex {"),
            cppRecord(shared, "enum class VertexInputLane {"),
            cppRecord(shared, "struct PinnedVertexInput {"),
            cppFunction(shared, "inline bool pinned_record_instanced("),
            cppFunction(shared, "inline bool pinned_record_instance_colored("),
            cppFunction(
                shared,
                "inline constexpr std::uint32_t vertex_stream_slot(",
            ),
            cppFunction(
                shared,
                "inline constexpr std::string_view vertex_stream_group(",
            ),
            cppFunction(
                shared,
                "inline constexpr std::uint64_t vertex_stream_stride(",
            ),
            cppFunction(
                shared,
                "inline constexpr bool vertex_stream_is_instanced(",
            ),
            cppFunction(shared, "PinnedVertexInput pinned_vertex_input("),
            cppFunction(shared, "inline bool node_variant_instanced("),
            cppFunction(sdl, "bool append_variant_attribute("),
            cppFunction(sdl, "Uint32 fill_variant_vertex_buffers("),
            cppRecord(dawn, "struct VariantVertexAttributes {"),
            cppFunction(dawn, "bool append_variant_attribute("),
            cppFunction(dawn, "std::uint32_t\nfill_variant_vertex_layouts("),
            `std::size_t features(const Engine& engine) { const Scene scene{}; struct { struct { MeshHandle mesh{0}; } item; } draw;
            struct { std::size_t mesh_features = 0; unsigned material_view = 0; } key;
            ${cppFunction(key.slice(start), "if (")} return key.mesh_features; }`,
            cppFunction(sdl, "void bind_composed_mesh_vertex_buffers("),
            `void sdl_bind(const Engine& engine, const SdlMesh& mesh) {
            struct { MeshHandle mesh{0}; } item;
            const auto& pinned_record = engine.meshes[0];
            SDL_GPURenderPass* pass = nullptr;
            ${sdlDraw.slice(bindStart, bindEnd)} }`,
            `void node_sdl_draw(const Engine& engine, const SdlMesh& mesh, const upstream::NodeVariantEntry& view) {
                struct { struct { MeshHandle mesh{0}; } item; } draw; SDL_GPURenderPass* pass = nullptr;
                ${nodeDraw.slice(nodeBindStart, nodeBindEnd)} }`,
            cppRecord(dawn, "struct InstanceStreams {"),
            cppFunction(dawn, "InstanceStreams instance_streams_for("),
            // The scene header declares its default arguments.
            cppDeclaration(dawn, "void encode_variant_draw("),
            cppFunction(dawn, "void encode_variant_draw("),
        ].join("\n"),
    );
    const { _computeMeshFeatures } = await importPinnedModule<{
        _computeMeshFeatures(this: void, mesh: unknown): number;
    }>("material/mesh-features.js");
    const expected = [false, true].flatMap((pool) =>
        [false, true].map((colors) =>
            _computeMeshFeatures({
                _gpu: {},
                ...(pool
                    ? {
                          thinInstances: {
                              ...(colors
                                  ? {
                                        colors: new Float32Array([
                                            0.2, 0.3, 0.4, 1,
                                        ]),
                                    }
                                  : {}),
                          },
                      }
                    : {}),
            }),
        ),
    );
    writeFileSync(
        join(output, "expected.hpp"),
        `constexpr std::array<std::size_t, 4> expected_features{${expected.join(",")}};`,
    );
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/DSDL_STATIC_LIB",
        `/Fo:${output}/`,
        `/Fe:${executable}`,
        "/I",
        "native/include",
        "/I",
        output,
        `/external:I${dawnInclude}`,
        `/external:I${join(nativeFixtureVcpkgRoot, "include")}`,
        "/external:W0",
        "test/fixtures/instance-stream-binding-check.cpp",
    ]);
    assert.equal(execFileSync(executable, { encoding: "utf8" }), "");
});
