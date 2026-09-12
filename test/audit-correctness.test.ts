import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { CompressedTextureLowerer } from "../src/lowering/compressed-texture-lowerer.js";
import { writeKtx1 } from "../src/basis-transcode.js";
import { packageKtx1 } from "../src/compressed-texture-package.js";

const nativeTools = optionalNativeFixtureTools(false);

test("storage synchronization preserves live buffers and versions across failures", { skip: !nativeTools }, () => {
    runCpp("storage-record-sync", `
        #include "${resolve("native/src/pal_record_sync.hpp").replaceAll("\\", "/")}"
        #include <cassert>
        #include <string>
        struct Source { bool disposed = false; std::vector<unsigned char> bytes; std::uint64_t version = 0; };
        int main() {
            using Buffer = std::vector<unsigned char>;
            std::vector<Source> sources{{false, {1,2}, 1}};
            std::vector<bbl::pal::VersionedGpuBuffer<Buffer*>> targets;
            std::string events;
            int live = 0;
            bool fail_create = false, fail_update = false;
            const auto sync = [&] {
                bbl::pal::sync_storage_records(sources, targets,
                    [&] { events += 'i'; },
                    [&](Buffer* buffer) { events += 'r'; delete buffer; --live; },
                    [&](const unsigned char* bytes, std::size_t size) {
                        events += 'c'; if (fail_create) throw std::runtime_error("create");
                        ++live; return new Buffer(bytes, bytes + size);
                    },
                    [&](Buffer* buffer, const unsigned char* bytes, std::size_t size) {
                        events += 'u'; if (fail_update) throw std::runtime_error("update");
                        buffer->assign(bytes, bytes + size);
                    });
            };
            sync(); assert(events == "ic" && live == 1 && targets[0].version == 1);
            auto* first = targets[0].buffer;
            events.clear(); sync(); assert(events.empty());
            sources[0].bytes[0] = 7; ++sources[0].version;
            fail_update = true;
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(targets[0].version == 1 && (*first)[0] == 1);
            fail_update = false; sync(); assert(targets[0].version == 2 && (*first)[0] == 7);
            sources[0].bytes.push_back(3); fail_create = true;
            events.clear();
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(events == "ic" && targets[0].buffer == first && live == 1);
            fail_create = false; events.clear(); sync();
            assert(events == "icr" && targets[0].size == 3 && live == 1);
            sources[0].disposed = true; events.clear(); sync();
            assert(events == "ir" && !targets[0].buffer && live == 0);
            sources[0].disposed = false; sources[0].bytes.clear(); events.clear();
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(events.empty());
            sources[0].bytes.push_back(9); sync(); sources.clear(); events.clear(); sync();
            assert(events == "ir" && targets.empty() && live == 0);
        }
    `);
});

test("sprite membership preserves clocks and releases removed or failed new records", { skip: !nativeTools }, () => {
    runCpp("ordered-record-sync", `
        #include "${resolve("native/src/pal_record_sync.hpp").replaceAll("\\", "/")}"
        #include <cassert>
        #include <memory>
        struct Handle { unsigned value; };
        struct Resource { Handle layer; std::unique_ptr<int> clock; };
        int main() {
            std::vector<Resource> resources;
            resources.push_back({{1}, std::make_unique<int>(41)});
            resources.push_back({{2}, std::make_unique<int>(72)});
            int created = 0, released = 0;
            bool fail = false;
            const auto sync = [&](std::vector<Handle> handles) {
                bbl::pal::reconcile_ordered_records(handles, resources,
                    [](const Resource& resource) { return resource.layer; },
                    [&](Handle handle) {
                        if (fail && handle.value == 9) throw std::runtime_error("create");
                        ++created; return Resource{handle, std::make_unique<int>(0)};
                    },
                    [&](Resource& resource) { ++released; resource.clock.reset(); });
            };
            auto* first = resources[0].clock.get();
            auto* second = resources[1].clock.get();
            sync({{2},{1}});
            assert(created == 0 && released == 0 && resources[0].clock.get() == second && resources[1].clock.get() == first);
            fail = true;
            try { sync({{1},{3},{9}}); assert(false); } catch (const std::runtime_error&) {}
            assert(created == 1 && released == 1 && resources[0].clock.get() == second && resources[1].clock.get() == first);
            fail = false; sync({{1},{1},{3}});
            assert(created == 3 && released == 2 && resources.size() == 3);
            assert(resources[0].clock.get() == first && *resources[0].clock == 41);
            assert(resources[1].clock.get() != first && *resources[1].clock == 0);
            sync({}); assert(resources.empty() && released == 5);
            struct Texture { bool disposed; };
            std::vector<Texture> textures{{false},{true}};
            std::vector<unsigned> events;
            bool in_use = true;
            const auto textures_sync = [&] {
                bbl::pal::sync_retained_textures(textures, [](std::size_t) { return false; },
                    [&] { if (in_use) throw std::runtime_error("in use"); events.push_back(0); },
                    [&](std::size_t index) { events.push_back(10u + static_cast<unsigned>(index)); },
                    [&](std::size_t index, const Texture&) { events.push_back(20u + static_cast<unsigned>(index)); });
            };
            try { textures_sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(events.empty()); in_use = false; textures_sync();
            assert((events == std::vector<unsigned>{0,20,11}));
        }
    `);
});

test("VAT synchronization retains unchanged payloads and retries failed uploads", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    runCpp("vat-record-sync", `
        #define BBLITE_VAT_INSTANCES 1
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::pal {
            ${cppFunction(source, "struct VatTextureLayout {")};
            ${cppFunction(source, "inline VatTextureLayout vat_texture_layout(")}
            template<class Mesh, class Bake, class Settings, class Instances, class UploadInstances>
            ${cppFunction(source, "void sync_pinned_vat(")}
        }
        struct Gpu {
            unsigned pinned_vat_bones = 0, pinned_vat_frames = 0, pinned_vat_instance_texels = 0;
            std::uint64_t pinned_vat_instance_version = 0;
        };
        int main() {
            bbl::Engine engine;
            bbl::MeshRecord mesh;
            Gpu gpu;
            std::string events;
            bool fail = false;
            const auto sync = [&] {
                bbl::pal::sync_pinned_vat(gpu, mesh, engine,
                    [&](const bbl::VatBakeRecord&, const bbl::pal::VatTextureLayout& layout) {
                        assert(layout.width == 8 && layout.height == 3 && layout.bytes == 384); events += 'b';
                    }, [&](const bbl::VatData&) { events += 's'; },
                    [&](const bbl::VatData&) { events += 'c'; },
                    [&](const bbl::VatData&, const bbl::pal::VatTextureLayout& layout) {
                        assert(layout.width == 4 && layout.height == 1 && layout.bytes == 64);
                        events += 'u'; if (fail) throw std::runtime_error("upload");
                    });
            };
            sync(); assert(events.empty());
            engine.vat_bakes.emplace_back(); engine.vat_bakes[0].bone_count = 2; engine.vat_bakes[0].frame_count = 3;
            mesh.has_vat = true; mesh.vat.bake = 0; mesh.vat.instance_texels = 4; mesh.vat.instance_version = 1;
            fail = true;
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(events == "bscu" && gpu.pinned_vat_instance_version == 0);
            fail = false; events.clear(); sync(); assert(events == "su" && gpu.pinned_vat_instance_version == 1);
            events.clear(); sync(); assert(events == "s");
        }
    `);
});

test("target planning resolves pane sizes, scaled chains and format inheritance before allocation", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    runCpp("render-target-plan", `
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::pal {
            struct Pane { unsigned width, height; };
            std::optional<Pane> surface_canvas_pane(const Engine&, std::optional<UiElementHandle> canvas, unsigned, unsigned) {
                return canvas ? std::optional<Pane>{{301,201}} : std::nullopt;
            }
            ${cppFunction(source, "inline std::pair<std::uint32_t, std::uint32_t> surface_target_extent(")}
            ${cppFunction(source, "inline std::uint32_t scaled_target_extent(")}
            ${cppFunction(source, "struct ScaledExtents {")};
            ${cppFunction(source, "inline ScaledExtents scaled_target_extents(")}
            template<class Format> ${cppFunction(source, "struct RenderTargetPlan {")};
            template<class Format, class Convert> ${cppFunction(source, "std::vector<RenderTargetPlan<Format>> plan_render_targets(")}
        }
        int main() {
            bbl::Engine engine;
            engine.render_targets.resize(4);
            engine.render_targets[0].surface_canvas = bbl::UiElementHandle{0};
            engine.render_targets[0].has_format = true;
            engine.render_targets[1].scale_source = {0};
            engine.render_targets[1].width_ratio = 0.5; engine.render_targets[1].height_ratio = 0.25;
            engine.render_targets[2].scale_source = {1};
            engine.render_targets[2].width_ratio = 0.001; engine.render_targets[2].height_ratio = 2;
            engine.render_targets[2].swapchain = true;
            engine.render_targets[3].width = 77; engine.render_targets[3].height = 55;
            const auto plan = [&] { return bbl::pal::plan_render_targets(engine, 800, 600, 9, [](bbl::TextureFormatClass) { return 4; }); };
            const auto first = plan();
            assert(first[0].width == 301 && first[0].height == 201 && first[0].color_format == 4);
            assert(first[1].width == 150 && first[1].height == 50 && first[1].color_format == 4);
            assert(first[2].width == 1 && first[2].height == 100 && first[2].color_format == 9);
            assert(first[3].width == 77 && first[3].height == 55 && first[3].color_format == 9);
            engine.render_targets[1].scale_source = {2};
            bool refused = false;
            try { plan(); } catch (const std::runtime_error&) { refused = true; }
            assert(refused);
        }
    `);
});

test("clustered uploads use the pinned payload extents and publish a version only after success", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_clustered_shared.hpp", "utf8");
    runCpp("clustered-record-sync", `
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::upstream {
            int refreshes = 0;
            void refresh_clustered_lights(ClusteredLightContainer&, const std::array<float,16>&,
                const std::array<float,16>&, double near_plane, double far_plane) {
                assert(near_plane == 0.1 && far_plane == 100); ++refreshes;
            }
        }
        namespace bbl::pal {
            ${cppFunction(source, "enum class ClusteredTexture {")};
            template<class Params, class Texture> ${cppFunction(source, "void sync_clustered_payloads(")}
        }
        int main() {
            bbl::ClusteredLightContainer container;
            container.data_texture_width = 4;
            container.light_texels = 3; container.light_data.resize(12);
            container.slice_count = 8; container.slice_rows = 2; container.slice_data.resize(32);
            container.mask_texels = 2; container.mask_data.resize(2);
            container.upload_version = 1;
            std::uint64_t version = 0;
            std::string events;
            bool fail = true;
            const auto sync = [&] {
                bbl::pal::sync_clustered_payloads(container, version, {}, {}, 0.1, 100,
                    [&](const void* bytes, std::size_t size) { assert(bytes == container.params.data() && size == 32); events += 'p'; },
                    [&](bbl::pal::ClusteredTexture slot, const void* bytes, std::size_t size,
                        unsigned texel_bytes, unsigned width, unsigned height) {
                        using Slot = bbl::pal::ClusteredTexture;
                        if (slot == Slot::lights) {
                            assert(bytes == container.light_data.data() && size == 48 && texel_bytes == 16 && width == 3 && height == 1); events += 'l';
                        } else if (slot == Slot::cells) {
                            assert(bytes == container.slice_data.data() && size == 128 && texel_bytes == 16 && width == 4 && height == 2); events += 'c';
                        } else {
                            assert(bytes == container.mask_data.data() && size == 8 && texel_bytes == 4 && width == 2 && height == 1); events += 'i';
                            if (fail) throw std::runtime_error("upload");
                        }
                    });
            };
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(version == 0 && events == "plci");
            fail = false; events.clear(); sync(); assert(version == 1 && events == "plci");
            events.clear(); sync(); assert(events.empty() && bbl::upstream::refreshes == 3);
        }
    `);
});

test("backdrop sizing and screen-space recording preserve allocation retries and pass order", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    runCpp("effect-pass-plans", `
        #define BBLITE_HAS_UI 1
        #include <bblite/runtime.hpp>
        #include "${resolve("native/src/pal_ui_backdrop.hpp").replaceAll("\\", "/")}"
        #include <cassert>
        namespace bbl::pal {
            template<class Clear, class Stage, class PostProcess> ${cppFunction(source, "void record_screen_space_decision(")}
        }
        int main() {
            struct Pair { unsigned source_width = 0, source_height = 0, blur_width = 0, blur_height = 0; } pair;
            bbl::pal::UiBackdrop backdrop;
            backdrop.width = 90; backdrop.height = 60; backdrop.blur_width = 30; backdrop.blur_height = 20;
            backdrop.sample_index = 12; backdrop.kernel_index_count = 18; backdrop.composite_index_count = 6;
            bool fail = true; int snapshots = 0, blurs = 0;
            const auto sync = [&] {
                bbl::pal::sync_ui_backdrop_targets(pair, backdrop, snapshots > 0, blurs > 0,
                    [&](unsigned width, unsigned height) { assert(width == 90 && height == 60); ++snapshots; },
                    [&](unsigned width, unsigned height) { assert(width == 30 && height == 20); if (fail) throw std::runtime_error("blur"); ++blurs; });
            };
            try { sync(); assert(false); } catch (const std::runtime_error&) {}
            assert(pair.source_width == 90 && pair.blur_width == 0);
            fail = false; sync(); sync(); assert(snapshots == 1 && blurs == 1);
            const auto draws = bbl::pal::ui_backdrop_draw_plan(backdrop);
            using Surface = bbl::pal::UiBackdropSurface;
            assert(draws[0].input == Surface::snapshot && draws[0].output == Surface::first && draws[0].first == 12 && draws[0].count == 6);
            assert(draws[1].input == Surface::first && draws[1].output == Surface::second && draws[1].first == 18 && draws[1].count == 18);
            assert(draws[2].input == Surface::second && draws[2].output == Surface::first && draws[2].first == 36 && draws[2].count == 18);
            assert(draws[3].input == Surface::first && draws[3].output == Surface::target && draws[3].first == 54 && draws[3].count == 6);
            bbl::ScreenSpaceFrameDecision decision;
            std::string events;
            const auto record = [&](bool composite) {
                bbl::pal::record_screen_space_decision(decision, composite,
                    [&](bool history) { events += history ? 'h' : 'i'; },
                    [&](bool producer, const float* uniforms) {
                        assert(uniforms == (producer ? decision.producer_uniforms.data() : decision.temporal_uniforms.data()));
                        events += producer ? 'p' : 't';
                    }, [&](unsigned child) { events += child ? 'c' : 's'; });
            };
            decision.clear_identity = false; decision.run_effect = false;
            record(false); assert(events.empty()); record(true); assert(events == "c");
            events.clear(); decision.clear_identity = true; decision.run_effect = true;
            record(true); assert(events == "ihptsc");
        }
    `);
});

test("pick contributor admission follows the picked scene, visibility and source filter", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    for (const floating of [0, 1]) {
        runCpp(`pick-contributor-admission-${floating}`, `
            #define BBLITE_HAS_BILLBOARDS 1
            #define BBLITE_HAS_SPLATS 1
            #define BBLITE_FLOATING_ORIGIN ${floating}
            #include <bblite/runtime.hpp>
            #include <cassert>
            namespace bbl::pal {
                ${cppFunction(source, "inline bool billboard_pick_draws(")}
                ${cppFunction(source, "inline void validate_pick_contributors(")}
            }
            int main() {
                bbl::Engine engine;
                bbl::Scene scene, other;
                engine.billboard_systems.emplace_back();
                engine.splat_meshes.emplace_back();
                auto& billboard = engine.billboard_systems[0];
                billboard.visible = true; billboard.count = 3;
                billboard.depth_mode = bbl::BillboardDepthMode::cutout;
                engine.splat_meshes[0].vertex_count = 8;
                other.billboard_systems.push_back({0});
                other.splat_meshes.push_back({0});
                bbl::pal::validate_pick_contributors(engine, scene, true, true);
                scene.billboard_systems.push_back({0});
                scene.splat_meshes.push_back({0});
                bbl::pal::validate_pick_contributors(engine, scene, true, false);
                const auto refuses = [&](bool detailed, const char* message) {
                    try { bbl::pal::validate_pick_contributors(engine, scene, detailed, true); }
                    catch (const std::runtime_error& error) {
                        assert(std::string(error.what()).find(message) != std::string::npos); return;
                    }
                    assert(false);
                };
                refuses(true, "splat contributor");
                scene.splat_meshes.clear();
                refuses(false, "alpha-cutoff");
                billboard.visible = false;
                bbl::pal::validate_pick_contributors(engine, scene, true, true);
                billboard.visible = true; billboard.count = 0;
                bbl::pal::validate_pick_contributors(engine, scene, true, true);
                billboard.count = 3; billboard.depth_mode = bbl::BillboardDepthMode::transparent;
                ${floating ? `refuses(false, "eye-relative");` : `
                    bbl::pal::validate_pick_contributors(engine, scene, false, true);
                    refuses(true, "billboard contributor");
                    scene.splat_meshes.push_back({0});
                    refuses(false, "registration order");
                    engine.splat_meshes[0].vertex_count = 0;
                    bbl::pal::validate_pick_contributors(engine, scene, false, true);
                `}
            }
        `);
    }
});

test("detailed picking refuses only thin instances admitted by geometry and filter gates", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_gpu_shared.hpp", "utf8");
    const renderer = readFileSync("src/lowering/renderer-lowerer.ts", "utf8");
    const activeCount = "inline std::size_t thin_instance_active_count(";
    runCpp("detailed-pick-admission", `
        #define BBLITE_GPU_INSTANCING 1
        #define BBLITE_DEFORM_PICKING 0
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::upstream {
            struct Item { MeshHandle mesh; };
            struct RenderPlan { std::vector<Item> items; };
            ${cppFunction(renderer, "bool pick_candidate(const MeshRecord& mesh) {")}
        }
        namespace bbl::pal {
            ${["struct PickMeshUniforms {", "struct PickRange {", "struct PickMeshCandidate {"].map(signature => cppFunction(source, signature) + ";").join("\n")}
            ${cppFunction(source.slice(source.lastIndexOf(activeCount)), activeCount)}
            std::array<float,16> shader_draw_world(const Engine&, const MeshRecord&) { return {}; }
            std::array<float,16> instance_parent_draw_world(const MeshRecord&, const Scene&, const Engine&) { return {}; }
            template<class HasGeometry>
            ${cppFunction(source, "inline std::vector<PickMeshCandidate> collect_pick_mesh_candidates(")}
        }
        int main() {
            bbl::Engine engine;
            bbl::Scene scene;
            engine.meshes.emplace_back(); engine.meshes.emplace_back();
            auto& thin = engine.meshes[1];
            thin.thin_instanced = true; thin.instance_count = 2; thin.instance_matrices.resize(2);
            bbl::upstream::RenderPlan plan; plan.items.push_back({{0}});
            const auto collect = [&](bool detailed, bool geometry, const bbl::Engine::PickFilter* filter = nullptr) {
                std::vector<bbl::pal::PickRange> ranges;
                std::uint32_t next = 1;
                return bbl::pal::collect_pick_mesh_candidates(engine, scene, plan, plan.items.size(),
                    [&](std::size_t) { return geometry; }, ranges, next, filter, detailed);
            };
            assert(collect(true, true).size() == 1);
            plan.items.push_back({{1}});
            assert(collect(false, true).at(1).instance_count == 2);
            assert(collect(true, false).empty());
            bbl::Engine::PickFilter filter = [](bbl::MeshHandle handle) { return handle.value == 0; };
            assert(collect(true, true, &filter).size() == 1);
            thin.pickable = false; assert(collect(true, true).size() == 1); thin.pickable = true;
            thin.instance_count = 0; assert(collect(true, true).size() == 1); thin.instance_count = 2;
            // Hidden meshes remain pick candidates in the pin.
            thin.visible = false;
            bool refused = false;
            try { collect(true, true); }
            catch (const std::runtime_error& error) { refused = std::string(error.what()).find("thin-instance world matrix") != std::string::npos; }
            assert(refused);
        }
    `);
});

test("text admission checks attached scene records and permits unattached resources", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_text_scene.hpp", "utf8");
    runCpp("text-scene-admission", `
        #define BBLITE_HAS_TEXT 1
        #define BBLITE_FLOATING_ORIGIN 0
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::pal { ${cppFunction(source, "inline void validate_text_scene(")} }
        int main() {
            bbl::Engine engine;
            bbl::Scene scene, other;
            scene.engine = &engine;
            engine.cameras.emplace_back(); scene.camera = {0};
            engine.meshes.emplace_back(); other.meshes.push_back({0});
            engine.materials.emplace_back();
            scene.state->text_renderables.push_back({});
            bbl::pal::validate_text_scene(scene);
            const auto refuses = [&](const char* message) {
                try { bbl::pal::validate_text_scene(scene); }
                catch (const std::runtime_error& error) {
                    assert(std::string(error.what()).find(message) != std::string::npos); return;
                }
                assert(false);
            };
            scene.meshes.push_back({0}); refuses("merged ordering"); scene.meshes.clear();
            scene.tasks.push_back({0}); refuses("default render pass"); scene.tasks.clear();
            scene.environment.has_solid_skybox = true; refuses("merged ordering");
            scene.environment.has_solid_skybox = false;
            engine.cameras[0].orthographic = true; refuses("perspective");
            engine.cameras[0].orthographic = false;
            engine.cameras[0].kind = bbl::CameraKind::free;
            bbl::pal::validate_text_scene(scene);
            scene.state->text_renderables.clear();
            scene.tasks.push_back({0}); scene.meshes.push_back({0});
            bbl::pal::validate_text_scene(scene);
        }
    `);
});

test("temporal admission checks the prepared draw list and its camera and scene", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_temporal_shared.hpp", "utf8");
    const renderer = readFileSync("src/lowering/renderer-lowerer.ts", "utf8");
    runCpp("temporal-pass-admission", `
        #include <bblite/runtime.hpp>
        #include <cassert>
        namespace bbl::upstream {
            ${cppFunction(renderer, "enum class RenderMaterialKind {")};
            struct Item { RenderMaterialKind material_kind; };
            struct Command { Item item; };
            struct List { std::vector<Command> commands; };
            struct RenderDrawLists { List opaque, transparent; };
        }
        namespace bbl::pal { ${cppFunction(source, "inline void validate_temporal_source(")} }
        int main() {
            bbl::Engine engine;
            bbl::Scene scene, other;
            bbl::FrameTaskRecord task;
            task.source_scene = scene.state;
            bbl::CameraRecord camera;
            bbl::upstream::RenderDrawLists draws;
            using Kind = bbl::upstream::RenderMaterialKind;
            draws.opaque.commands.push_back({{Kind::standard}});
            engine.materials.emplace_back(); engine.cameras.emplace_back();
            engine.cameras[0].kind = bbl::CameraKind::free;
            other.transmission_enabled = true;
            bbl::pal::validate_temporal_source(engine, task, &camera, draws);
            const auto refuses = [&](const char* message) {
                try { bbl::pal::validate_temporal_source(engine, task, &camera, draws); }
                catch (const std::runtime_error& error) {
                    assert(std::string(error.what()).find(message) != std::string::npos); return;
                }
                assert(false);
            };
            for (auto kind : {Kind::pbr, Kind::grid, Kind::shader, Kind::node}) {
                draws.transparent.commands.push_back({{kind}});
                refuses("material draw adapter"); draws.transparent.commands.clear();
            }
            camera.kind = bbl::CameraKind::free; refuses("camera");
            camera.kind = bbl::CameraKind::arc_rotate;
            scene.transmission_enabled = true; refuses("transmission"); scene.transmission_enabled = false;
            task.render.scene_stages = true; refuses("explicit color pass"); task.render.scene_stages = false;
            engine.registered_sprite_renderers.push_back({0}); refuses("registered renderer");
            engine.registered_sprite_renderers.clear();
            bbl::pal::validate_temporal_source(engine, task, &camera, draws);
        }
    `);
});

test("returned record scalars share one allocation while preserving aliases and fresh calls", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createBox, type Mesh } from "@babylonjs/lite";
        function snapshot(mesh: Mesh) {
            return { mesh, x: mesh.position.x, y: mesh.position.y, enabled: true, label: "start" };
        }
        async function main() {
            const engine = await createEngine({});
            const mesh = createBox(engine);
            const first = snapshot(mesh);
            const alias = first;
            mesh.position.x = 10;
            const second = snapshot(mesh);
            alias.x = 4;
            first.enabled = false;
            alias.label = "changed";
            if (first.x !== 4 || first.y !== 0 || alias.enabled !== false || first.label !== "changed" ||
                second.x !== 10 || second.enabled !== true || second.label !== "start") {
                throw new Error("Packed record storage changed snapshots, aliases or call identity");
            }
            createBox(engine);
        }
    `);
    assert.doesNotMatch(result.cpp, /make_gc_shared<(?:double|bool|std::string)>/);
    runCpp("record-scalar-storage", `#define main generated_record_main\n${result.cpp}\n#undef main
        #include <cassert>
        namespace { std::size_t retained_nodes = 0; }
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) {
                const auto index = static_cast<std::uint32_t>(engine.meshes.size());
                if (index == 1) retained_nodes = js::managed_node_count();
                engine.meshes.emplace_back();
                return {index};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
        int main() {
            assert(generated_record_main() == 0);
            assert(retained_nodes == 2);
            assert(bbl::js::managed_node_count() == 0);
        }
    `);
});

test("packed record fields stay shared after their creating helper returns", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender, startEngine, type SceneContext } from "@babylonjs/lite";
        function make(scene: SceneContext) { return { scene, x: 1, y: 2, enabled: true }; }
        function install(scene: SceneContext) {
            const state = make(scene);
            const alias = state;
            onBeforeRender(scene, () => { state.x += 3; state.y += 4; state.enabled = false; });
            onBeforeRender(scene, () => {
                if (alias.x !== 4 || alias.y !== 6 || alias.enabled) throw new Error("Packed capture lost its fields");
            });
        }
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        install(scene);
        await startEngine(engine);
    `);
    runCpp("record-scalar-captures", result.cpp + `
        namespace bbl {
            static std::vector<js::Callback<void(float)>> callbacks;
            Engine create_engine(EngineOptions) { return {}; }
            Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
            void on_before_render(Scene&, js::Callback<void(float)> callback) { callbacks.push_back(std::move(callback)); }
            void start_engine(Engine&) { for (const auto& callback : callbacks) callback(16); callbacks.clear(); }
        }
    `);
});

function runCpp(name: string, cpp: string): void {
    assert.ok(nativeTools);
    const output = resolve("artifacts/audit-correctness", name);
    mkdirSync(output, { recursive: true });
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(nativeTools, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", source,
    ]);
    execFileSync(executable, { stdio: "pipe" });
}

test("checked handles preserve references and diagnose invalid and sentinel indices", { skip: !nativeTools }, () => {
    runCpp("checked-handles", `
        #define BBLITE_CHECKED_HANDLES 1
        #include <bblite/runtime.hpp>
        #include <cassert>
        int main() {
            std::vector<int> records{10, 20};
            bbl::handle_at(records, bbl::MeshHandle{1}) = 42;
            const auto& immutable = records;
            assert(&bbl::handle_at(immutable, bbl::MeshHandle{1}) == &records[1]);
            assert(records[1] == 42);
            std::vector<bool> bits{false};
            bbl::handle_at(bits, bbl::MeshHandle{0}) = true;
            assert(bits[0]);
            for (auto handle : {bbl::MeshHandle{2}, bbl::MeshHandle{}}) {
                bool refused = false;
                try { bbl::handle_at(records, handle); }
                catch (const std::out_of_range& error) {
                    const std::string text = error.what();
                    refused = text.find("record count 2") != std::string::npos && text.find("check.cpp:") != std::string::npos;
                }
                assert(refused);
            }
        }
    `);
});

test("compressed mips retain one container across moves and texture copies", { skip: !nativeTools }, async () => {
    const lowerer = new CompressedTextureLowerer(new LoweringContext());
    const lowered = lowerer.lower();
    const bytes = await packageKtx1(writeKtx1({ gpuFormat: "bc7-rgba-unorm", width: 8, height: 4, mips: [
        { width: 8, height: 4, bytes: new Uint8Array(32).fill(0xa5) },
        { width: 4, height: 2, bytes: new Uint8Array(16).fill(0x5a) },
    ] }, lowerer.magicBytes(), lowerer.glInternalFormat("bc7-rgba-unorm"), lowerer.headerLayout()));
    const output = resolve("artifacts/audit-correctness/compressed-mips");
    mkdirSync(output, { recursive: true });
    const header = join(output, "compressed_texture.hpp").replaceAll("\\", "/");
    writeFileSync(header, lowered.header);
    runCpp("compressed-mips", `
        #include <cassert>
        ${lowered.source.replace("#include <bblite/upstream/compressed_texture.hpp>", `#include "${header}"`)}
        namespace bbl::pal { std::vector<std::uint8_t> read_binary_file(const std::string&) { return {}; } }
        int main() {
            std::vector<std::uint8_t> bytes{${[...bytes].join(",")}};
            const auto* original = bytes.data();
            auto texture = bbl::upstream::read_compressed_texture(std::move(bytes));
            assert(texture.storage->data() == original);
            assert(texture.mips.size() == 2);
            assert(texture.mips[0].bytes.data() == original + 56);
            assert(texture.mips[1].bytes.data() == original + 88);
            auto retained = texture;
            assert(retained.storage == texture.storage);
            texture = {};
            assert(retained.mips[0].bytes.size() == 32 && retained.mips[0].bytes[31] == 0xa5);
            assert(retained.mips[1].width == 4 && retained.mips[1].height == 2);
            assert(retained.mips[1].bytes[15] == 0x5a);
            auto truncated = *retained.storage;
            truncated.pop_back();
            bool refused = false;
            try { bbl::upstream::read_compressed_texture(std::move(truncated)); }
            catch (const std::runtime_error&) { refused = true; }
            assert(refused);
        }
    `);
});

test("eye memoization reuses unchanged inputs and preserves F64 input bits", { skip: !nativeTools }, () => {
    const source = new CameraLowerer(new LoweringContext()).lowerArcRotateFactory(false, true).source;
    runCpp("eye-cache", `
        #include <bblite/runtime.hpp>
        #include <bit>
        #include <cassert>
        namespace bbl::upstream {
        int calls = 0;
        Vec3d arc_rotate_local_eye_position(const CameraRecord& camera) {
            ++calls;
            return {camera.alpha, camera.beta + camera.radius, camera.target.x + camera.target.y + camera.target.z};
        }
        ${cppFunction(source, "Vec3d arc_rotate_eye_position(")}
        }
        int main() {
            using namespace bbl;
            CameraRecord camera;
            camera.alpha = 0.0;
            for (int i = 0; i < 1000; ++i) upstream::arc_rotate_eye_position(camera);
            assert(upstream::calls == 1);
            camera.alpha = -0.0;
            assert(std::signbit(upstream::arc_rotate_eye_position(camera).x));
            assert(upstream::calls == 2);
            for (double* input : {&camera.alpha, &camera.beta, &camera.radius, &camera.target.x, &camera.target.y, &camera.target.z}) {
                *input += 1.0;
                upstream::arc_rotate_eye_position(camera);
            }
            assert(upstream::calls == 8);
            camera.kind = CameraKind::free;
            camera.position.x = 42;
            assert(upstream::arc_rotate_eye_position(camera).x == 42);
            camera.position.x = 99;
            assert(upstream::arc_rotate_eye_position(camera).x == 99);
            assert(upstream::calls == 8);
        }
    `);
});

test("stylesheet revisions track rules, text and attachment order independently of ordinary UI changes", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_ui_rml.cpp", "utf8");
    const functions = [
        "UiElementRecord& ui_element(", "void mark_ui_changed(Engine& engine)",
        "void mark_ui_changed(Engine& engine,", "void ui_set_text(", "void ui_set_inner_rml(",
        "void ui_clear_style_rules(", "void ui_add_style_rule(", "void ui_add_host_style_rule(",
        "UiElementHandle ui_append_child(", "UiElementHandle ui_append_to_root(", "void ui_replace_children(", "void ui_remove(",
    ].map((signature) => cppFunction(source, signature)).join("\n");
    runCpp("style-revision", `
        #define BBLITE_HAS_UI 1
        #include <bblite/pal_ui.hpp>
        #include <cassert>
        namespace bbl { ${functions} }
        int main() {
            using namespace bbl;
            Engine engine;
            engine.ui_elements.resize(3);
            const UiElementHandle label{0}, first{1}, second{2};
            engine.ui_elements[0].tag = "div";
            engine.ui_elements[1].tag = engine.ui_elements[2].tag = "style";
            for (int i = 0; i < 100; ++i) ui_set_text(engine, label, std::to_string(i));
            ui_append_to_root(engine, label);
            assert(engine.ui_style_revision == 0 && engine.ui_revision == 101);
            ui_set_text(engine, first, "@keyframes pulse{}");
            assert(engine.ui_style_revision == 1);
            ui_set_text(engine, first, "@keyframes pulse{}");
            assert(engine.ui_style_revision == 1);
            ui_set_inner_rml(engine, first, "");
            assert(engine.ui_style_revision == 2);
            ui_append_to_root(engine, first);
            ui_append_to_root(engine, second);
            ui_append_to_root(engine, first);
            assert(engine.ui_style_revision == 5);
            ui_append_to_root(engine, first);
            assert(engine.ui_style_revision == 5);
            ui_add_style_rule(engine, first, UiStyleSelectorKind::Class, "item", "", "", false, -1, "color:red;", UiScrollbarPart::None);
            assert(engine.ui_style_revision == 6);
            ui_clear_style_rules(engine, first);
            ui_clear_style_rules(engine, first);
            assert(engine.ui_style_revision == 7);
            ui_set_text(engine, first, "@keyframes pulse{}");
            const auto before_replace = engine.ui_style_revision;
            ui_replace_children(engine, first);
            assert(engine.ui_style_revision > before_replace);
            ui_remove(engine, first);
            const auto after_remove = engine.ui_style_revision;
            assert(after_remove > before_replace);
            ui_remove(engine, first);
            assert(engine.ui_style_revision == after_remove);
            ui_add_host_style_rule(engine, UiStyleSelectorKind::Class, "item", "", "", false, -1, "color:blue;", false, false, UiScrollbarPart::None);
            assert(engine.ui_style_revision == after_remove + 1);
        }
    `);
});

test("window document snapshots preserve stylesheet revisions across ordinary UI updates", { skip: !nativeTools }, () => {
    const source = readFileSync("native/src/pal_window_realm.cpp", "utf8");
    const declarations = ["struct WindowEvent final", "struct ListenerNames", "struct DocumentSnapshot"]
        .map(signature => `${cppFunction(source, signature)};`).join("\n");
    runCpp("window-style-revision", `
        #define BBLITE_HAS_UI 1
        #define BBLITE_WORKERS 1
        #include <bblite/runtime.hpp>
        #include <bblite/pal_event_loop.hpp>
        #include <cassert>
        namespace bbl::pal {
        ${declarations}
        ${cppFunction(source, "std::unique_ptr<DocumentSnapshot> snapshot_document(")}
        ${cppFunction(source, "void apply_document(")}
        }
        int main() {
            using namespace bbl;
            Engine source, target;
            source.ui_elements.resize(1);
            source.ui_elements[0].tag = "div";
            source.ui_style_revision = 7;
            auto inbox = std::make_shared<pal::EventLoop::Inbox>();
            pal::apply_document(target, std::move(*pal::snapshot_document(source)), inbox);
            assert(target.ui_style_revision == 7);
            for (int i = 0; i < 100; ++i) {
                source.ui_elements[0].text = std::to_string(i);
                pal::apply_document(target, std::move(*pal::snapshot_document(source)), inbox);
                assert(target.ui_style_revision == 7);
            }
            source.ui_style_revision = 8;
            pal::apply_document(target, std::move(*pal::snapshot_document(source)), inbox);
            assert(target.ui_style_revision == 8);
            assert(target.ui_elements[0].text == "99");
        }
    `);
});

test("nullable scalar conditions follow JavaScript truthiness and evaluate calls once", { skip: !nativeTools }, () => {
    const result = compileSource(`
        function text(value: string | null): boolean { return !!value; }
        function number(value: number | null): boolean { return !!value; }
        function flag(value: boolean | null): boolean { return !!value; }
        function choice(value: "" | "empty" | "first" | "second" | null): boolean { return !!value; }
        function nonempty(value: "first" | "second" | null): boolean { return !!value; }
        if (text(null) || text("") || !text("0")) throw new Error("nullable string");
        if (number(null) || number(0) || number(-0) || number(NaN) || !number(1) || !number(-2) || !number(Infinity)) throw new Error("nullable number");
        if (flag(null) || flag(false) || !flag(true)) throw new Error("nullable boolean");
        if (choice(null) || choice("") || !choice("empty") || !choice("first") || !choice("second")) throw new Error("nullable string union");
        if (nonempty(null) || !nonempty("first")) throw new Error("enum ordinal is not string truthiness");
        class Reader {
            calls = 0;
            next(): string | null { this.calls++; return this.calls === 1 ? "" : "ok"; }
        }
        const reader = new Reader();
        if (reader.next()) throw new Error("empty call result");
        if (!reader.next()) throw new Error("nonempty call result");
        if (reader.calls !== 2) throw new Error("condition evaluated more than once");
    `);
    runCpp("nullable", result.cpp);
});

test("material record fields refuse the wrong family through aliases and helpers", () => {
    const preamble = `
        import { createEngine, createPbrMaterial, createStandardMaterial } from "@babylonjs/lite";
        const engine = await createEngine({});
    `;
    for (const [property, value] of [
        ["diffuseColor", "[1, 0, 0]"], ["specularColor", "[1, 1, 1]"],
        ["emissiveColor", "[1, 0, 0]"], ["uvOffset", "[0, 0]"], ["uvScale", "[1, 1]"],
        ["specularPower", "8"], ["lightmapLevel", "1"], ["alphaCutOff", "0.2"],
        ["disableLighting", "true"], ["backFaceCulling", "false"],
    ]) {
        assert.throws(() => compileSource(`${preamble}
            const material = createPbrMaterial({});
            const alias = material;
            alias.${property} = ${value};
        `), new RegExp(`Material ${property} requires a standard material`));
    }
    assert.throws(() => compileSource(`${preamble}
        function update(material: ReturnType<typeof createStandardMaterial>): void {
            material.directIntensity = 2;
        }
        update(createStandardMaterial());
    `), /Material directIntensity requires a pbr material/);
    const valid = compileSource(`${preamble}
        const standard = createStandardMaterial();
        standard.diffuseColor = [1, 0, 0];
        standard.specularPower = 8;
        standard.alpha = 0.5;
        const pbr = createPbrMaterial({});
        pbr.directIntensity = 2;
        pbr.alpha = 0.5;
    `);
    assert.match(valid.cpp, /set_material_diffuse_color/);
    assert.match(valid.cpp, /\.direct_intensity = 2\.0f/);
});

test("GC counters separate live nodes from allocations across collection", { skip: !nativeTools }, () => {
    runCpp("gc-counters", `
        #include <bblite/js_gc.hpp>
        #include <cassert>
        int main() {
            using namespace bbl::js;
            const auto initial_nodes = gc::registry.size;
            const auto initial_allocations = gc::registry.total_allocations;
            {
                auto first = make_gc_shared<int>(1);
                auto second = make_gc_shared<int>(2);
                assert(gc::registry.size == initial_nodes + 2);
                first.reset();
                collect_cycles();
                assert(gc::registry.size == initial_nodes + 1);
                assert(gc::registry.allocations == 0);
                assert(gc::registry.total_allocations == initial_allocations + 2);
            }
            assert(gc::registry.size == initial_nodes);
            assert(gc::registry.total_allocations == initial_allocations + 2);
        }
    `);
});

test("counted frame waits preserve each drain and the pending capture barrier", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        scene.clearColor = { r: 0, g: 0, b: 1, a: 1 };
        await registerScene(scene);
        await startEngine(engine);
        for (let i = 0; i < 160; i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        scene.clearColor = { r: 1, g: 0, b: 0, a: 1 };
        for (let i = 0; i < 2; i++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        scene.clearColor = { r: 0, g: 1, b: 0, a: 1 };
    `);
    assert.match(result.cpp, /remaining = 161u/);
    assert.match(result.cpp, /remaining = 2u/);
    assert.equal((result.cpp.match(/bbl::defer_start_continuation_until\(/g) ?? []).length, 2);
    const pal = readFileSync("native/src/pal.cpp", "utf8");
    const start = pal.indexOf("void defer_callback(");
    const end = pal.indexOf("double set_timeout(", start);
    assert.ok(start >= 0 && end > start);
    // Compile the actual PAL queue and drain with a CPU frame host.
    runCpp("counted-frames", result.cpp + `
        #include <cassert>
        namespace bbl {
        ${pal.slice(start, end)}
        static Scene* active_scene = nullptr;
        Engine create_engine(EngineOptions) { return {}; }
        Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
        void register_scene(Scene& scene) { active_scene = &scene; }
        void start_engine(Engine& engine) {
            for (unsigned frame = 1; frame <= 163; ++frame) {
                assert(engine.pending_start_continuations == 1);
                assert(engine.deferred_callbacks.size() == 1);
                run_deferred_callbacks(engine);
                assert(active_scene->clear_color.b == (frame < 161 ? 1.0f : 0.0f));
                assert(active_scene->clear_color.r == (frame >= 161 && frame < 163 ? 1.0f : 0.0f));
                assert(active_scene->clear_color.g == (frame == 163 ? 1.0f : 0.0f));
            }
            assert(engine.pending_start_continuations == 0);
            assert(engine.deferred_callbacks.empty());
        }
        }
    `);
});

test("a static string switch selects its first matching body and empty-label fallthrough", { skip: !nativeTools }, () => {
    const result = compileSource(`
        let value = 0;
        switch ("second") {
            case "first": throw new Error("unreachable first");
            case "second":
            case "third": { value = 2; break; }
            default: throw new Error("unreachable default");
        }
        switch ("missing") {
            case "first": throw new Error("unreachable missing");
            default: value += 3; break;
        }
        switch ("absent") { case "first": throw new Error("unreachable absent"); }
        if (value !== 5) throw new Error("selected body");
    `);
    assert.doesNotMatch(result.cpp, /unreachable|std::string_view .*switch/);
    runCpp("static-switch", result.cpp);
});

test("continuation locals initialize on every entry invocation and survive later yields", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, startEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        await startEngine(engine);
        let calls = 0;
        function tick(): number { return ++calls; }
        const initialCalls = tick();
        const values = [4, 7];
        const first = values.pop();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (first !== 7 || values.length !== 1 || initialCalls !== 1 || tick() !== 2) throw new Error("first yield state");
        const second = values.pop();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (second !== 4 || values.length !== 0 || tick() !== 3) throw new Error("second yield state");
        const finalValue = 12;
        if (finalValue !== 12) throw new Error("final local");
    `);
    assert.doesNotMatch(result.cpp, /static [^\n;]*v_(values|first|second|finalValue)\b/);
    assert.doesNotMatch(result.cpp, /v_finalValue = [^\n]*->retain/);
    assert.match(result.cpp, /ContinuationStorage/);
    const pal = readFileSync("native/src/pal.cpp", "utf8");
    const start = pal.indexOf("void defer_callback(");
    const end = pal.indexOf("double set_timeout(", start);
    assert.ok(start >= 0 && end > start);
    runCpp("continuation-storage", `#define main generated_continuation_main\n${result.cpp}\n#undef main
        #include <cassert>
        namespace bbl {
            ${pal.slice(start, end)}
            Engine create_engine(EngineOptions) { return {}; }
            void start_engine(Engine& engine) {
                for (unsigned frame = 0; frame < 3; ++frame) run_deferred_callbacks(engine);
                assert(engine.pending_start_continuations == 0);
                assert(engine.deferred_callbacks.empty());
            }
        }
        int main() {
            for (int invocation = 0; invocation < 2; ++invocation) {
                assert(generated_continuation_main() == 0);
            }
        }
    `);
});

test("a callback installed after engine start owns its local cells", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender, startEngine } from "@babylonjs/lite";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        await startEngine(engine);
        let counter = 0;
        const values = [3, 8];
        onBeforeRender(scene, () => {
            counter++;
            const next = values.pop();
            if ((counter === 1 && next !== 8) || (counter === 2 && next !== 3)) {
                throw new Error("post-start capture lifetime");
            }
        });
    `);
    assert.doesNotMatch(result.cpp, /continuation_storage.hpp/);
    const pal = readFileSync("native/src/pal.cpp", "utf8");
    const start = pal.indexOf("void defer_callback(");
    const end = pal.indexOf("double set_timeout(", start);
    assert.ok(start >= 0 && end > start);
    runCpp("continuation-callback-cells", `#define main generated_continuation_main\n${result.cpp}\n#undef main
        #include <cassert>
        namespace bbl {
            ${pal.slice(start, end)}
            static std::vector<js::Callback<void(float)>> callbacks;
            Engine create_engine(EngineOptions) { return {}; }
            Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
            void on_before_render(Scene&, js::Callback<void(float)> callback) { callbacks.push_back(std::move(callback)); }
            void start_engine(Engine& engine) {
                run_deferred_callbacks(engine);
                for (const auto& callback : callbacks) { callback(16); callback(16); }
                callbacks.clear();
            }
        }
        int main() {
            for (int invocation = 0; invocation < 2; ++invocation) {
                assert(generated_continuation_main() == 0);
                bbl::js::collect_cycles();
                assert(bbl::js::managed_node_count() == 0);
            }
        }
    `);
});

test("direct mutual recursion uses automatic callables and preserves changing captures", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createBox, type Mesh } from "@babylonjs/lite";
        function even(mesh: Mesh, count: number): number {
            if (count <= 0) return mesh.position.x;
            return odd(mesh, count - 1) + 1;
        }
        function odd(mesh: Mesh, count: number): number {
            if (count <= 0) return mesh.position.x;
            return even(mesh, count - 1) + 1;
        }
        const engine = await createEngine({});
        const box = createBox(engine);
        if (even(box, 6) !== 6) throw new Error("initial recursion");
        box.position.x = 10;
        if (odd(box, 5) !== 15) throw new Error("changed recursion");
        createBox(engine);
    `);
    assert.match(result.cpp, /make_recursive_group/);
    assert.doesNotMatch(result.cpp, /Callback<double\(double\)>/);
    runCpp("automatic-recursive-group", result.cpp + `
        #include <cassert>
        namespace bbl {
            Engine create_engine(EngineOptions) { return {}; }
            MeshHandle create_box(Engine& engine, BoxOptions) {
                assert(js::managed_node_count() == 0);
                const auto index = static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();
                return {index};
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
    `);
});

test("hoisted Float32 tables keep target width, rounding and independent array identity", { skip: !nativeTools }, () => {
    const values = Array.from({length: 130}, (_, index) => index === 0 ? "16777217" : index === 1 ? "-0" : "0.1");
    const result = compileSource(`
        const first = new Float32Array([${values.join(",")}]);
        const second = new Float32Array([${values.join(",")}]);
        if (first[0] !== 16777216 || first[2] !== ${Math.fround(0.1)}) throw new Error("float rounding");
        if (1 / first[1]! !== -Infinity) throw new Error("signed zero");
        first[0] = 8;
        if (second[0] !== 16777216) throw new Error("array identity");
    `);
    assert.match(result.cpp, /std::array<float, 130>/);
    assert.equal((result.cpp.match(/std::array<float, 130>/g) ?? []).length, 1);
    runCpp("float-table", result.cpp);
});

test("frame callbacks retain block and helper locals with shared mutations", { skip: !nativeTools }, () => {
    const result = compileSource(`
        import { createEngine, createSceneContext, onBeforeRender, startEngine } from "@babylonjs/lite";
        import type { SceneContext } from "@babylonjs/lite";
        function install(scene: SceneContext): void {
            let counter = 0;
            onBeforeRender(scene, () => { counter++; });
            onBeforeRender(scene, () => { if (counter !== 1) throw new Error("shared helper counter"); });
        }
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        {
            let blockCounter = 0;
            const label = "retained";
            onBeforeRender(scene, () => { blockCounter++; });
            onBeforeRender(scene, () => {
                if (blockCounter !== 1 || label !== "retained") throw new Error("block capture");
            });
        }
        install(scene);
        await startEngine(engine);
    `);
    assert.doesNotMatch(result.cpp, /std::ref\(v_\w*(?:counter|blockCounter|label)\)/i);
    assert.match(result.cpp, /make_gc_shared<double>\(0\.0\)/);
    // A CPU host dispatches the actual emitted closures after both scopes end.
    // Only the platform/registration boundary is substituted.
    runCpp("frame-captures", result.cpp + `
        namespace bbl {
        static std::vector<js::Callback<void(float)>> callbacks;
        Engine create_engine(EngineOptions) { return {}; }
        Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
        void on_before_render(Scene&, js::Callback<void(float)> callback) { callbacks.push_back(std::move(callback)); }
        void start_engine(Engine&) { for (const auto& callback : callbacks) callback(16); callbacks.clear(); }
        }
    `);
});
