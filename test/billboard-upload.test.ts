import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BillboardLowerer } from "../src/lowering/billboard-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { pinnedSurfaceHeader } from "../src/lowering/pinned-surface.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { SpriteLowerer } from "../src/lowering/sprite-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);

test(
    "billboard mutations invalidate uploads without discarding capacity or handle identity",
    { skip: !tools },
    () => {
        const output = resolve("artifacts/billboard-upload");
        mkdirSync(output, { recursive: true });
        const context = new LoweringContext();
        const core = new BillboardLowerer(context).lowerCore();
        const sprite = new SpriteLowerer(context).lowerCore();
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const anchorFloats = core.header.match(
            /inline constexpr std::uint32_t billboard_anchor_floats_per_sprite = \d+u;/,
        )?.[0];
        if (!anchorFloats)
            throw new Error(
                "The billboard header no longer states its anchor lanes.",
            );
        const uploads = [
            "inline Vec3d billboard_eye_relative_anchor(",
            "inline double billboard_sort_depth(",
            "inline double billboard_sort_compare(",
            "inline void billboard_sorted_instances(",
            "inline void billboard_unsorted_instances(",
            "inline void billboard_upload_instances(",
            "inline double billboard_system_order(",
        ]
            .map((signature) => cppFunction(core.header, signature))
            .join("\n");
        const definitions = [
            "static void write_billboard_position(",
            "BillboardSystemHandle create_billboard_system(",
            "double add_billboard_sprite_index(",
            "BillboardSpriteHandle add_billboard_sprite(",
            "void update_billboard_sprite(",
            "void set_billboard_sprite_frame(",
            "bool billboard_sprite_alive(",
            "void remove_billboard_sprite(",
            "void clear_billboard_sprites(",
        ]
            .map((signature) => cppFunction(core.source, signature))
            .join("\n");
        writeFileSync(
            file,
            `
        #include "pal_gpu_billboard_upload.hpp"
        #include <bblite/js_data.hpp>
        #include <algorithm>
        #include <cmath>
        #include <cassert>
        #include <numeric>
        namespace bbl::upstream {
            ${cppFunction(sprite.header, "inline std::uint32_t resolve_sprite_frame(")}
            ${anchorFloats}
            ${uploads}
        }
        namespace bbl {
            ${definitions}
        }
        int main() {
            bbl::Engine engine;
            engine.sprite_atlases.emplace_back();
            auto& atlas = engine.sprite_atlases[0];
            atlas.frames.resize(2);
            atlas.frames[0].uv_max = {1, 1};
            atlas.frames[1].uv_min = {.25f, .5f};
            atlas.frames[1].uv_max = {.75f, 1};
            bbl::BillboardSystemOptions options;
            options.capacity = 1;
            const auto handle = bbl::create_billboard_system(engine, {0}, bbl::BillboardOrientation::facing, {}, options);
            auto& system = engine.billboard_systems[handle.value];
            bbl::pal::BillboardUploadStamp stamp;
            std::array<float, 16> view{};
            bbl::Vec3d eye{};
            const auto dirty = [&] { return bbl::pal::billboard_needs_upload(system, stamp, view, eye); };
            const auto uploaded = [&] { bbl::pal::stamp_billboard_upload(stamp, system, view, eye); assert(!dirty()); };
            assert(!dirty());
            bbl::BillboardSpriteProps props;
            props.has_position = true;
            props.position = {1, 2, 3};
            const auto first = bbl::add_billboard_sprite(engine, handle, props);
            assert(dirty()); uploaded();
            const auto second = bbl::add_billboard_sprite(engine, handle, props);
            assert(dirty() && system.count == 2 && system.capacity >= 2); uploaded();
            props.position = {4, 5, 6};
            bbl::update_billboard_sprite(engine, first, props);
            assert(dirty() && system.count == 2 && system.instance_data[0] == 4); uploaded();
            bbl::set_billboard_sprite_frame(engine, second, 1);
            assert(dirty() && system.count == 2); uploaded();
            view[0] = 2;
            assert(dirty()); uploaded();
            system.depth_mode = bbl::BillboardDepthMode::cutout;
            view[0] = 3;
            assert(!dirty());
            eye.x = 1000000.125;
            assert(dirty() == static_cast<bool>(BBLITE_FLOATING_ORIGIN)); uploaded();
            bbl::remove_billboard_sprite(engine, first);
            assert(dirty() && system.count == 1 && !bbl::billboard_sprite_alive(engine, first)); uploaded();
            assert(bbl::billboard_sprite_alive(engine, second));
            props.position.x = 9;
            bbl::update_billboard_sprite(engine, second, props);
            assert(system.instance_data[0] == 9 && dirty()); uploaded();
            bbl::remove_billboard_sprite(engine, first);
            assert(!dirty());
            const auto capacity = system.instance_data.capacity();
            bbl::clear_billboard_sprites(engine, handle);
            assert(!dirty() && !bbl::billboard_sprite_alive(engine, second));
            assert(system.instance_data.capacity() == capacity);
            const auto version = system.instance_version;
            bbl::clear_billboard_sprites(engine, handle);
            assert(system.instance_version == version);
            bbl::add_billboard_sprite_index(engine, handle, props);
            assert(system.count == 1 && dirty() && system.instance_data[0] == 9);
            assert(system.instance_data.capacity() == capacity); uploaded();

            // The F64 anchor: at 5e6 the F32 lane has already rounded to
            // the half-unit grid, and the eye-relative upload subtracts the
            // camera offset from the number the scene wrote instead.
            bbl::clear_billboard_sprites(engine, handle);
            props.position = {5000000.3, 2, -7000000.3};
            const auto far = bbl::add_billboard_sprite(engine, handle, props);
            props.position = {5000001.3, 2, -7000000.3};
            bbl::add_billboard_sprite(engine, handle, props);
            assert(system.anchor[0] == 5000000.3 &&
                   system.instance_data[0] == static_cast<float>(5000000.3) &&
                   static_cast<double>(system.instance_data[0]) != 5000000.3);
            const bbl::Vec3d offset{5000000.0, 0.0, -7000000.0};
            std::vector<float> staged;
            for (const bool camera : {false, true}) {
                for (const auto mode : {bbl::BillboardDepthMode::cutout, bbl::BillboardDepthMode::transparent}) {
                    system.depth_mode = mode;
                    std::array<float, 16> facing{};
                    facing[10] = 1;
                    bbl::upstream::billboard_upload_instances(system, camera, facing, staged, offset);
                    assert(staged.size() == 2u * system.instance_floats_per_sprite);
                    // The sorted arm stages far to near; x = 1.3 is not
                    // nearer here, so both arms keep the insertion order.
                    assert(staged[0] == static_cast<float>(5000000.3 - 5000000.0));
                    assert(staged[2] == static_cast<float>(-7000000.3 + 7000000.0));
                    assert(staged[16] == static_cast<float>(5000001.3 - 5000000.0));
                }
            }
            // A zero offset uploads the lanes as stored.
            system.depth_mode = bbl::BillboardDepthMode::cutout;
            bbl::upstream::billboard_upload_instances(system, true, view, staged, bbl::Vec3d{});
            assert(staged[0] == system.instance_data[0]);
            // A removal moves the last anchor down and clears its old lanes.
            bbl::remove_billboard_sprite(engine, far);
            assert(system.count == 1 && system.anchor[0] == 5000001.3 && system.anchor[3] == 0.0);
        }
    `,
        );
        for (const floatingOrigin of [0, 1]) {
            runNativeFixtureCompiler(tools!, [
                `/DBBLITE_FLOATING_ORIGIN=${floatingOrigin}`,
                `/Fo:${output}\\`,
                `/Fe:${executable}`,
                "/I",
                "native/src",
                file,
            ]);
            execFileSync(executable, { stdio: "pipe" });
        }
    },
);

test(
    "billboard systems draw from their scene's next build, refuse after disposal, and only observable alpha-to-coverage changes refuse",
    { skip: !tools },
    () => {
        // addBillboardSystem registers the pick source at once and the
        // renderable through the scene's deferred builders, which run when
        // the scene builds (registerScene). The pin reads alpha-to-coverage
        // when a scene binds the renderable, for a cutout system on a
        // multisampled target only, and rebinds a registered scene's
        // renderables only on a later scene mutation the native passes do
        // not track: that one observable change refuses.
        const output = resolve("artifacts/billboard-alpha-to-coverage");
        mkdirSync(join(output, "bblite/upstream"), { recursive: true });
        const context = new LoweringContext();
        const core = new BillboardLowerer(context).lowerCore();
        writeFileSync(
            join(output, "bblite/upstream/pinned_surface.hpp"),
            pinnedSurfaceHeader(context),
        );
        const file = join(output, "check.cpp"),
            executable = join(output, "check.exe");
        const anchorFloats = core.header.match(
            /inline constexpr std::uint32_t billboard_anchor_floats_per_sprite = \d+u;/,
        )?.[0];
        if (!anchorFloats)
            throw new Error(
                "The billboard header no longer states its anchor lanes.",
            );
        const definitions = [
            "BillboardSystemHandle create_billboard_system(",
            "void set_billboard_alpha_to_coverage(",
            "void add_billboard_system(",
        ]
            .map((signature) => cppFunction(core.source, signature))
            .join("\n");
        // The scene's own lifecycle: registration drains the deferred
        // builders and advances the renderable version; disposal empties.
        const scene = new SceneLowerer(context).lowerCore().source;
        const lifecycle = [
            "void require_scene_engine(",
            "std::uint32_t material_family_bit(",
            "std::uint32_t scene_material_families(",
            "void drain_scene_deferred_builders(",
            "void register_scene(",
            "void unregister_scene(",
            "void retire_scene_shadow_states(",
            "void dispose_scene(",
        ]
            .map((signature) => cppFunction(scene, signature))
            .join("\n");
        writeFileSync(
            file,
            `
        #include <bblite/runtime.hpp>
        #include <bblite/upstream/pinned_surface.hpp>
        #include <algorithm>
        #include <cassert>
        #include <memory>
        #include <stdexcept>
        #include <string_view>
        #include <vector>
        namespace bbl::upstream {
            ${anchorFloats}
            ${cppFunction(core.header, "inline double billboard_system_order(")}
        }
        namespace bbl {
            ${lowerMeshMaterialSetter(context)}
            ${lifecycle}
            ${definitions}
        }
        int main() {
            bbl::Engine engine;
            engine.sprite_atlases.emplace_back();
            bbl::BillboardSystemOptions transparent;
            transparent.capacity = 1;
            bbl::BillboardSystemOptions cutout = transparent;
            cutout.blend.depth_mode = bbl::BillboardDepthMode::cutout;
            const auto create = [&](const bbl::BillboardSystemOptions& options) {
                return bbl::create_billboard_system(engine, {0}, bbl::BillboardOrientation::facing, {}, options);
            };
            const auto drawn = create(cutout), late = create(cutout), blended = create(transparent);
            bbl::Scene scene;
            scene.engine = &engine;
            const auto& pick_sources = scene.billboard_systems;
            const auto& renderables = scene.state->billboard_renderables;
            const auto& version = scene.state->renderable_version;
            const auto same = [](const std::vector<bbl::BillboardSystemHandle>& handles,
                                 std::vector<std::uint32_t> values) {
                return std::equal(handles.begin(), handles.end(), values.begin(), values.end(),
                                  [](bbl::BillboardSystemHandle handle, std::uint32_t value) { return handle.value == value; });
            };
            // registerScene on a registered scene returns at once; the pin
            // builds it again only through unregisterScene then registerScene.
            const auto build = [&] {
                bbl::unregister_scene(scene);
                bbl::register_scene(scene);
            };
            const auto set = [&](bbl::BillboardSystemHandle system, bool enabled) {
                try {
                    bbl::set_billboard_alpha_to_coverage(engine, system, enabled);
                } catch (const std::runtime_error& error) {
                    assert(std::string_view(error.what()).find("before registerScene") != std::string_view::npos);
                    return false;
                }
                assert(engine.billboard_systems[system.value].alpha_to_coverage == enabled);
                return true;
            };
            bbl::add_billboard_system(scene, drawn);
            // The pick source registers at once; the renderable waits for the build.
            assert(same(pick_sources, {drawn.value}) && renderables.empty() && version == 0);
            // Before registration the write is the one every binding reads.
            assert(set(drawn, true));
            bbl::register_scene(scene);
            assert(same(renderables, {drawn.value}) && version == 1);
            // A system added to the registered scene is pickable at once and
            // draws from its next registration, which moves the version the
            // renderers follow; until then its setting is still the one that
            // binding reads.
            bbl::add_billboard_system(scene, late);
            bbl::add_billboard_system(scene, blended);
            bbl::register_scene(scene);
            assert(same(pick_sources, {drawn.value, late.value, blended.value}));
            assert(same(renderables, {drawn.value}) && version == 1);
            assert(set(late, true));
            // The drawn cutout system at four samples is the observable change.
            assert(set(drawn, true));
            assert(!set(drawn, false) && engine.billboard_systems[drawn.value].alpha_to_coverage);
            build();
            assert(same(renderables, {drawn.value, late.value, blended.value}) && version == 2);
            assert(!set(late, false));
            // A transparent system never resolves coverage, and neither does a
            // single-sample surface.
            assert(set(blended, true) && set(blended, false));
            engine.options.msaa_samples = 1;
            assert(set(drawn, false) && set(late, false));
            // Disposal empties both lists and moves the version; a system
            // added afterwards refuses (the pin builds and disposes it only
            // through its async late cleanup), leaving the scene untouched.
            bbl::dispose_scene(scene);
            assert(pick_sources.empty() && renderables.empty() && version == 3);
            bool refused = false;
            try {
                bbl::add_billboard_system(scene, late);
            } catch (const std::runtime_error& error) {
                refused = std::string_view(error.what()).find("after disposeScene") != std::string_view::npos;
            }
            assert(refused && pick_sources.empty() && scene.deferred_builders.empty());
            // The queue holds its scene weakly: an abandoned scene publishes nothing.
            std::weak_ptr<bbl::SceneState> abandoned;
            {
                bbl::Scene transient;
                transient.engine = &engine;
                abandoned = transient.state;
                bbl::add_billboard_system(transient, late);
            }
            bbl::js::collect_cycles();
            assert(abandoned.expired());
        }
    `,
        );
        runNativeFixtureCompiler(tools!, [
            // Disposal empties the billboard lists only where sprites are reached.
            "/DBBLITE_HAS_SPRITES=1",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/src",
            "/I",
            output,
            file,
        ]);
        execFileSync(executable, { stdio: "pipe" });
    },
);
