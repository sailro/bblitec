import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    sharedGpuSource,
} from "./native-fixture.js";

test("sprite backend uploads preserve dirty rows, clocks, bindings and scene insertion order", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const read = (name: string) =>
        readFileSync(`native/src/${name}.hpp`, "utf8").replaceAll("\r\n", "\n");
    const shared = sharedGpuSource(),
        sdl = read("pal_sdl_gpu_sprite"),
        dawn = read("pal_dawn_sprite");
    const sdlBillboard = read("pal_sdl_gpu_billboard"),
        dawnBillboard = read("pal_dawn_billboard");
    const directory = resolve("artifacts/sprite-backend-contracts");
    mkdirSync(directory, { recursive: true });
    const lowered = new SpriteLowerer(new LoweringContext()).lowerCore();
    const core = lowered.source;
    // The pin's in-place layer sort and the comparator it calls, from the
    // generated header both backends and the capture read.
    writeFileSync(
        join(directory, "layer-sort.hpp"),
        `namespace bbl::upstream {\n${cppFunction(lowered.header, "inline double compare_sprite_layers(")}\n}\n` +
            `namespace bbl {\n${cppFunction(lowered.header, "inline void sort_sprite_renderer_layers(")}\n}\n`,
    );
    writeFileSync(
        join(directory, "mutations.hpp"),
        [
            "void touch_sprite_instances(",
            "SpriteRendererHandle create_sprite_renderer(",
            "void add_sprite_renderer_layer(",
        ]
            .map((signature) => cppFunction(core, signature))
            .join("\n"),
    );
    const records = [
        cppRecord(shared, "struct SpriteDirtyRange {"),
        cppRecord(shared, "struct SpriteLayerPipelinePlan {"),
        cppRecord(shared, "struct BillboardUploadStamp {"),
        cppRecord(shared, "struct BillboardDrawPlan {"),
        cppRecord(sdl, "struct SpriteLayerResources {"),
        "using SpriteLayerGpu = FixtureRecord<SpriteLayerResources>;",
        cppRecord(dawn, "struct DawnSpriteLayerResources {"),
        "using DawnSpriteLayer = FixtureRecord<DawnSpriteLayerResources>;",
        cppRecord(sdlBillboard, "struct BillboardResources {"),
        "using BillboardPass = BillboardResources;",
        cppRecord(dawnBillboard, "struct DawnBillboardScene {"),
        cppRecord(dawnBillboard, "struct DawnBillboardResources {"),
        "using DawnBillboardPass = DawnBillboardResources;",

        cppRecord(sdl, "struct SpriteAtlasGpuResources {"),
        "using SpriteAtlasGpu = FixtureRecord<SpriteAtlasGpuResources>;",
        cppRecord(dawn, "struct DawnSpriteAtlasBindingResources {"),
        "using DawnSpriteAtlasBinding = FixtureRecord<DawnSpriteAtlasBindingResources>;",
        cppRecord(sdl, "struct SceneSpritePassResources {"),
        "using SceneSpritePass = FixtureRecord<SceneSpritePassResources>;",
        cppRecord(dawn, "struct DawnSceneSpritePassResources {"),
        "using DawnSceneSpritePass = FixtureRecord<DawnSceneSpritePassResources>;",
    ].join("\n");
    const functions = [
        ...[
            "SpriteDirtyRange resolve_sprite_dirty_range(",
            "SpriteInstanceUpload resolve_sprite_instance_upload(",
            "bool sprite_blend_equal(",
            "SpriteLayerPipelinePlan sprite_layer_pipeline_plan(",
            "bool sprite_scene_pipeline_compatible(",
            "Vec3d frame_floating_origin_offset(",
            "inline CameraRecord* scene_camera(",
            "BillboardDrawPlan billboard_draw_plan(",
            "bool billboard_needs_upload(",
            "void stamp_billboard_upload(",
            "std::string sprite_program_stem(",
        ].map((signature) => cppFunction(shared, signature)),
        cppRecord(dawn, "struct DawnSpriteProgram {"),
        cppFunction(
            read("pal_sdl_gpu_shared"),
            "inline std::vector<SDL_GPUTextureSamplerBinding>\nselect_sprite_fragment_textures(",
        ),
        ...[
            "inline PinnedStageSlots read_sprite_layer_slots(",
            "inline SpriteLayerGpu build_sprite_layer_gpu(",
            "inline void release_sprite_layer_resources([[maybe_unused]]",
            "inline void rebuild_sprite_layer_pipeline(",
            "inline void upload_sprite_layer_gpu(",
            "inline void record_sprite_layer_gpu(",
            "inline SceneSpritePass create_scene_sprite_pass(",
            "inline void upload_scene_sprite_pass(",
            "inline void record_scene_sprite_pass(",
        ].map((signature) => cppFunction(sdl, signature)),
        ...[
            "inline DawnSpriteLayer build_dawn_sprite_layer(",
            "inline void release_dawn_sprite_layer_resources([[maybe_unused]]",
            "inline void upload_dawn_sprite_layer(",
            "inline void record_dawn_sprite_layer(",
            "inline DawnSceneSpritePass create_dawn_scene_sprite_pass(",
            "inline void sync_dawn_scene_sprite_pass_pipelines(",
            "inline void record_dawn_scene_sprite_pass(",
            "inline void release_dawn_scene_sprite_pass_resources([[maybe_unused]]",
        ].map((signature) => cppFunction(dawn, signature)),
        ...[
            "inline void upload_billboard_pass(",
            "inline void record_billboard_pass(",
        ].map((signature) => cppFunction(sdlBillboard, signature)),
        cppFunction(dawnBillboard, "inline void upload_dawn_billboard_pass("),
    ].join("\n");
    writeFileSync(join(directory, "records.hpp"), records);
    writeFileSync(join(directory, "functions.hpp"), functions);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        "/I",
        "native/include",
        "/I",
        directory,
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "test/fixtures/sprite-backend-contracts-check.cpp",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});
