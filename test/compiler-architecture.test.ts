import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { declarationOwners, sourceFacts, sourcePaths } from "./source-facts.js";

function source(path: string): string {
    return readFileSync(path, "utf8");
}

test("resolves renamed imports through semantic symbols", () => {
    const body = (create: string, scene: string): string =>
        'async function main() { const engine = await ' + create + '({}); const scene = ' + scene + '(engine); }';
    const direct = compileSource('import {createEngine, createSceneContext} from "@babylonjs/lite"; ' + body("createEngine", "createSceneContext"));
    const renamed = compileSource('import {createEngine as boot, createSceneContext as world} from "@babylonjs/lite"; ' + body("boot", "world"));
    assert.equal(renamed.cpp, direct.cpp);
    assert.deepEqual(renamed.manifest, direct.manifest);
});

test("centralizes default-library identity and AST-driven upstream contracts", () => {
    const compilerPaths = sourcePaths.filter((path) => path === "src/compiler.ts" || path.startsWith("src/compiler/"));
    assert.deepEqual(compilerPaths.filter((path) => sourceFacts(path).members.has("hasNoDefaultLib")), ["src/compiler/symbols.ts"]);
    assert.deepEqual(compilerPaths.filter((path) => sourceFacts(path).members.has("isSourceFileDefaultLibrary")), []);
    const lowerers = sourcePaths.filter((path) =>
        path === "src/upstream-source.ts" || path.startsWith("src/lowering/gltf/") ||
        path.startsWith("src/lowering/factory/") ||
        (path.startsWith("src/lowering/") && path.endsWith("-lowerer.ts") && !path.endsWith("/renderer-lowerer.ts")));
    for (const path of lowerers) {
        const facts = sourceFacts(path);
        assert.ok(![...facts.calls].some((name) => name === "store.getSource" || name.endsWith(".store.getSource")), path);
        assert.ok(!facts.members.has("match"), path);
        assert.ok(!facts.calls.has("extractNumber") && !facts.constructs.has("RegExp"), path);
    }
    assert.ok(sourceFacts("src/lowering/renderer-lowerer.ts").members.has("getSource"));
});

test("entry points acquire the dist lock and only its owner sets the nesting marker", () => {
    for (const path of ["src/cli.ts", "src/scene-command.ts"]) {
        assert.ok(sourceFacts(path).calls.has("holdDistLock"), path);
    }
    assert.deepEqual(sourcePaths.filter((path) => sourceFacts(path).lockSetter), ["src/dist-lock.ts"]);
});

test("shared compiler helpers have one declaration owner", () => {
    for (const [name, path] of [
        ["pinnedLibraryRoot", "src/pinned-shader-composer.ts"],
        ["formatStatements", "src/shader-builtins-utility.ts"],
        ["isTrsVectorName", "src/scene-node-transform-descriptor.ts"],
        ["emitHandleCollectionLoop", "src/compiler/handle-collections.ts"],
        ["isRecursiveImportedMeshWalk", "src/compiler/handle-collections.ts"],
        ["propertyRules", "src/compiler/properties.ts"],
        ["StaticEvaluator", "src/compiler/static-evaluator.ts"],
        ["UserFunctionLowerer", "src/compiler/user-functions.ts"],
        ["StatementLowerer", "src/compiler/statements.ts"],
    ]) assert.deepEqual(declarationOwners(name!), [path], name);
    for (const member of ["readHandleCollection", "nativeLocation"]) {
        const callers = sourcePaths.filter((path) => sourceFacts(path).calls.has(member) || sourceFacts(path).declarations.has(member));
        assert.deepEqual(callers.sort(), ["src/compiler/handle-collections.ts", "src/compiler/properties.ts"], member);
    }
    assert.ok(sourceFacts("src/compiler/statements.ts").imports.has("./handle-collections.js"));
    assert.ok(sourceFacts("src/compiler/expressions.ts").members.has("compileFind"));
});

test("the compiler delegates intrinsic families and feature lowering", () => {
    const registry = sourceFacts("src/compiler/intrinsics/registry.ts");
    const imports = new Set([...registry.imports.values()].flatMap((names) => [...names]));
    for (const family of ["Animation", "Asset", "Camera", "Engine", "Light", "Material", "Mesh", "Scene"]) {
        assert.ok(imports.has('compile' + family + 'Intrinsic'), family);
    }
    const compiler = sourceFacts("src/compiler.ts");
    assert.ok(compiler.calls.has("compileRegisteredIntrinsic"));
    assert.ok(compiler.calls.has("emitPropertyAssignment"));
    assert.ok(compiler.calls.has("readProperty"));
    for (const name of ["StaticEvaluator", "UserFunctionLowerer", "StatementLowerer"]) {
        assert.ok(compiler.constructs.has(name), name);
    }
    for (const module of [
        "option-helpers", "intrinsics/mesh-options", "intrinsics/engine-options",
        "intrinsics/material-options", "intrinsics/asset-options", "shader-material",
        "property-animation", "adaptations", "assets", "output-projection", "scene-materials",
        "module-initializers", "sprite-atlas-record",
    ]) assert.ok(compiler.imports.has('./compiler/' + module + '.js'), module);
    assert.ok(sourceFacts("src/compiler/assignments.ts").calls.has("cameraRecordField"));
    assert.ok(sourceFacts("src/compiler/shader-material.ts").calls.has("lowerWgslShaderProgram"));
    for (const path of ["src/compiler.ts", "src/compiler/shader-material.ts"]) {
        assert.ok(!sourceFacts(path).calls.has("normalizeShaderSource"), path);
    }
});

test("split lowerer barrels contain exports and families own their declarations", () => {
    for (const barrel of ["src/lowering/gltf-lowerer.ts", "src/lowering/factory-lowerer.ts"]) {
        assert.ok(sourceFacts(barrel).barrel, barrel);
    }
    for (const [name, path] of [
        ["GltfLowerer", "gltf/loader"],
        ["lowerAnimationInterpolationCpp", "gltf/animation-interpolation"],
        ["lowerSamplerMappingCpp", "gltf/sampler-mapping"],
        ["lowerAccessorNormalizationCpp", "gltf/accessor-normalization"],
        ["lowerVertexColorCpp", "gltf/accessor-normalization"],
        ["lowerShPrescaleCpp", "gltf/sh-prescale"],
        ["lowerImageProcessingDefaultsCpp", "gltf/image-processing-defaults"],
        ["lowerMatrixComposeCpp", "gltf/matrix-leaves"],
        ["lowerLocalMatrixCpp", "gltf/local-matrix"],
        ["lowerMatrixNativeCpp", "gltf/matrix-leaves"],
        ["lowerIblPolynomialCpp", "gltf/ibl"],
        ["lowerIblEnvironmentScalarsCpp", "gltf/ibl"],
        ["lowerPunctualLightsCpp", "gltf/punctual-lights"],
        ["lowerGltfMaterialProperties", "gltf/material-properties"],
        ["lowerGltfFactorBake", "gltf/factor-bake"],
        ["MeshBuilderLowerer", "factory/mesh-builders"],
        ["FactoryLowerer", "factory/material-factories"],
        ["pinnedSampleCounts", "pinned-surface"],
    ]) assert.deepEqual(declarationOwners(name!), ['src/lowering/' + path + '.ts'], name);
});

test("preserves multisampling across the transmission scene-color copy", () => {
    const pal = source("native/src/pal_sdl_gpu.cpp");
    assert.match(
        pal,
        /const bool multisampled =\s*state\.sample_count != SDL_GPU_SAMPLECOUNT_1;/,
    );
    // The multisample colour is PRESERVED for two reasons now: a
    // transmission grab reads it back, and a swapchain overlay layer
    // composites onto it before the one resolve at the end. Either one
    // takes the same store op, so the predicate is what this asserts.
    assert.match(
        pal,
        /transmission_enabled \|\| !overlay_plans\.empty\(\)\s*\?\s*SDL_GPU_STOREOP_RESOLVE_AND_STORE/,
    );
    assert.match(
        pal,
        /capture_frame \|\| transmission_enabled\s*\?\s*state\.color/,
    );
});

test("composes registered sprite renderers over scene output", () => {
    const scene = source("native/src/pal_sdl_gpu.cpp");
    const sprites = source("native/src/pal_sdl_gpu_sprite.hpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(scene, /#include "pal_sdl_gpu_sprite\.hpp"/);
    assert.doesNotMatch(scene, /reject_uncomposed_sprites\(engine\)/);
    assert.match(
        scene,
        /sprite_target\.texture = renderer\.has_target[\s\S]{0,180}: visible_color;[\s\S]{0,180}SDL_GPU_LOADOP_LOAD/,
    );
    assert.match(
        scene,
        /for \(const SpriteRendererHandle handle :\s*engine\.registered_sprite_renderers\)[\s\S]{0,2600}record_sprite_pass\(/,
    );
    assert.match(
        sprites,
        /GpuBufferUploadBatch& buffer_uploads\) \{/,
    );
    assert.match(dawn, /#include "pal_dawn_sprite\.hpp"/);
    assert.doesNotMatch(dawn, /reject_uncomposed_sprites\(engine\)/);
    assert.match(
        dawn,
        /sprite_attachment\.view = renderer\.has_target[\s\S]{0,180}: surface_view;[\s\S]{0,180}WGPULoadOp_Load/,
    );
    assert.match(
        dawn,
        /for \(const SpriteRendererHandle handle :\s*engine\.registered_sprite_renderers\)[\s\S]{0,2600}record_dawn_sprite_pass\(/,
    );
});

test("wires reached sprite permutations and provenance into upstream emission", () => {
    const upstream = source("src/upstream-lower.ts");
    assert.match(
        upstream,
        /generated\.push\(\.\.\.spriteCoreAdditionalProvenance\)/,
    );
    assert.match(
        upstream,
        /for \(const permutation of spriteVertexPermutations\(\{[\s\S]{0,260}pure: needsPureVertex,[\s\S]{0,260}depthHosted: features\.includes\([\s\S]{0,500}composedShaders\.push\(\{[\s\S]{0,180}permutation\.output/,
    );
});

test("keeps Scene53's reached direct sprite bucket after opaque meshes", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");
    for (const backend of [sdl, dawn]) {
        assert.match(
            backend,
            /RenderStage::opaque:[\s\S]{0,120}draw_render_list\(render_plan\.draw_lists\.opaque\);[\s\S]{0,520}Sprite2DDepthMode::test_write/,
        );
        const transparentStage = backend.match(/case upstream::RenderStage::transparent:([\s\S]*?)\bbreak;/)?.[1];
        assert(transparentStage, "Missing default transparent stage");
        assert.match(transparentStage,
            /draw_render_list\(\s*render_plan\.draw_lists\.transparent\);[\s\S]*Sprite2DDepthMode::test/);
    }
});

test("forwards DOM-compatible application input through every native loop", () => {
    const events = source("native/src/pal_platform_events.hpp");
    assert.match(events, /case SDL_SCANCODE_SPACE: return "Space";/);
    assert.match(events, /case SDL_SCANCODE_F3: return "F3";/);
    assert.match(events, /if \(code == "Space"\) return " ";/);
    assert.match(events, /engine\.key_down_callbacks/);
    assert.match(events, /engine\.key_up_callbacks/);
    assert.match(events, /SDL_EVENT_MOUSE_MOTION/);
    assert.match(events, /SDL_EVENT_MOUSE_WHEEL/);
    assert.match(events, /engine\.mouse_move_callbacks/);
    assert.match(events, /engine\.mouse_wheel_callbacks/);
    assert.match(events, /engine\.window_resize_callbacks/);
    assert.match(
        events,
        /browser_pixels_per_scroll_increment = 100\.0/,
    );
    assert.match(events, /dom_wheel_delta_y\(event\.wheel\)/);
    assert.match(events, /code == "WheelUp" \? -100\.0 : 100\.0/);
    assert.match(events, /code == "MouseMoveRight"/);
    assert.match(
        events,
        /MouseMove@[\s\S]{0,420}\.buttons = static_cast<double>\(mouse_buttons_\)/,
    );
    assert.match(
        events,
        /if \(down\) \{[\s\S]{0,100}mouse_buttons_ \|= mask;[\s\S]{0,120}mouse_buttons_ &= ~mask;/,
    );
    assert.match(events, /code == "WindowClose"/);
    assert.match(events, /pointer_position\(code, "UiClick@"\)/);
    assert.match(
        events,
        /SDL_EVENT_MOUSE_MOTION[\s\S]{0,700}SDL_EVENT_MOUSE_BUTTON_DOWN[\s\S]{0,500}SDL_EVENT_MOUSE_BUTTON_UP/,
    );
    assert.match(
        events,
        /Unable to queue deterministic pointer input/,
    );
    assert.match(events, /is_replayed_ui_event\(event\)/);
    assert.match(events, /event_code == "MouseLeftOutsideCanvas"/);
    assert.match(events, /event_code\.starts_with\("Ctrl\+"\)/);
    assert.match(events, /\.movement_x = 100\.0/);
    assert.match(events, /SDL_SetWindowRelativeMouseMode/);
    assert.match(events, /SDL_HINT_MOUSE_AUTO_CAPTURE/);
    assert.match(events, /SDL_HINT_MOUSE_RELATIVE_SYSTEM_SCALE/);
    assert.match(events, /SDL_HINT_MOUSE_RELATIVE_SPEED_SCALE/);
    assert.match(events, /SDL_HINT_MOUSE_RELATIVE_CURSOR_VISIBLE/);
    assert.match(events, /SDL_HINT_OVERRIDE/);
    assert.match(events, /update_tracked_mouse_button\(event\.button\)/);
    assert.match(events, /engine\.pointer_down_callbacks/);
    assert.match(events, /engine\.canvas_click_callbacks/);
    assert.match(
        events,
        /canvas_contains_client_point\([\s\S]{0,260}event\.client_x >= 0\.0[\s\S]{0,120}event\.client_y >= 0\.0[\s\S]{0,180}engine\.canvas_client_width[\s\S]{0,100}engine\.canvas_client_height/,
    );
    assert.equal(
        (events.match(/dispatch_platform_pointer_down\(/g) ?? []).length,
        2,
        "the pointer-down helper is reached only through bounded mouse dispatch",
    );
    assert.equal(
        (events.match(/dispatch_canvas_click\(/g) ?? []).length,
        2,
        "click release is reached only through bounded mouse dispatch",
    );
    assert.equal(
        (events.match(/dispatch_platform_mouse_button\(/g) ?? []).length,
        3,
        "the shared mouse helper serves replay and live input",
    );
    assert.match(
        events,
        /event\.button != 0\.0[\s\S]{0,180}engine\.canvas_click_armed[\s\S]{0,160}engine\.canvas_click_armed = false/,
    );
    assert.match(
        events,
        /\.buttons = dom_mouse_buttons\(tracked_mouse_buttons\(\)\)/,
    );
    assert.doesNotMatch(
        events,
        /\.buttons = dom_mouse_buttons\(event\.motion\.state\)/,
    );
    assert.match(events, /SDL_HideCursor/);
    assert.match(events, /SDL_ShowCursor/);
    assert.match(events, /engine\.pointer_lock_change_callbacks/);
    assert.match(
        events,
        /release_pointer_lock_on_escape\([\s\S]{0,220}code != "Escape"[\s\S]{0,120}engine\.pointer_lock_requested = false;[\s\S]{0,120}sync_pointer_lock\(/,
    );
    assert.equal(
        (events.match(/release_pointer_lock_on_escape\(/g) ?? []).length,
        4,
        "the helper definition plus replay, direct and UI-aware keyboard dispatch stay in sync",
    );
    assert.match(events, /SDL_EVENT_WINDOW_RESIZED/);
    assert.match(events, /SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED/);
    assert.match(events, /SDL_GetWindowSizeInPixels/);
    assert.match(events, /engine\.options\.width = width;/);
    assert.match(events, /engine\.options\.height = height;/);
    assert.match(
        events,
        /engine\.window_resize_callbacks\.dispatch\(\)/,
    );

    // The shared drain carries the whole per-event contract — quit/close,
    // test-pass input filtering, an optional UI filter, the platform
    // dispatch, the per-event dispatched hook, and a canvas-cursor
    // refresh after a propagated mouse event — so a loop using
    // it cannot hold a partial copy of that contract (the cursor arm was
    // once per-driver, and one driver forgot it).
    const eventDrain = events.match(
        /inline void poll_platform_events\([\s\S]*?\n\}/,
    )?.[0];
    assert.ok(eventDrain, "the shared event drain is defined");
    assert.match(
        eventDrain,
        /while \(SDL_PollEvent\(&event\)\)[\s\S]{0,160}SDL_EVENT_QUIT \|\|[\s\S]{0,100}SDL_EVENT_WINDOW_CLOSE_REQUESTED[\s\S]{0,100}running = false;[\s\S]{0,180}is_platform_input_event\(event\) &&\s*!is_replayed_ui_event\(event\)/,
    );
    assert.match(
        events,
        /if \(!ui_filter\(event\)\) continue;\s*handle_platform_event\(event, engine\);\s*dispatched\(event\);\s*if \(event\.type == SDL_EVENT_MOUSE_MOTION \|\|[\s\S]{0,240}apply_canvas_cursor\(engine\);/,
    );

    // Every frame loop uses the shared helper — the two scene renderers
    // through the dispatched hook that carries their camera-controls
    // dispatch, so that contract lives once rather than in a hand-rolled
    // copy of the drain.
    for (const path of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
    ]) {
        const loop = source(path);
        assert.match(
            loop,
            /camera_pointer_hook = \[&\]\(const SDL_Event& event\) \{[\s\S]{0,120}dispatch_surface_camera_pointer\(engine, event, camera, pointer_state, surface_pointer_state\);/,
        );
        assert.match(
            loop,
            /poll_platform_events\([\s\S]{0,320}camera_pointer_hook\);/,
        );
        assert.doesNotMatch(loop, /SDL_PollEvent/);
        assert.match(
            loop,
            /input_replay\.dispatch\(frame, [^,]+, engine\);/,
        );
    }
    assert.match(
        source("native/src/pal_camera_controls.hpp"),
        /handle_camera_pointer_event\(event, primary, primary_state\);/,
    );
    for (const path of [
        "native/src/pal_sdl_gpu_sprite.cpp",
        "native/src/pal_dawn_sprite.cpp",
        "native/src/pal_sdl_gpu_effect.cpp",
        "native/src/pal_dawn_effect.cpp",
        "native/src/pal_sdl_gpu_frame_graph.cpp",
        "native/src/pal_dawn_frame_graph.cpp",
    ]) {
        const loop = source(path);
        assert.match(loop, /poll_platform_events\(/);
        assert.doesNotMatch(loop, /SDL_PollEvent/);
        assert.match(
            loop,
            /input_replay\.dispatch\(frame, [^,]+, engine\);/,
        );
    }
});

test("normalizes HTML named entities before retained markup reaches RmlUi", () => {
    const ui = source("native/src/pal_ui_rml.cpp");

    assert.match(ui, /normalize_html_entities_for_rml/);
    assert.match(ui, /\{"&rsquo;", "\\xE2\\x80\\x99"\}/);
    assert.match(ui, /\{"&mdash;", "\\xE2\\x80\\x94"\}/);
    assert.equal(
        (ui.match(/SetInnerRML\(\s*normalize_html_entities_for_rml\(/g) ?? [])
            .length,
        2,
    );
    // Raw text is escaped, not HTML-entity decoded; only its presentation
    // selectors are normalized when a color-emoji span is needed.
    assert.match(ui, /SetInnerRML\(ui_normalize_emoji_presentation\(ui_escape_rml\(text\)\)\)/);
});

test("uploads splats once per backend frame", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.equal(
        (sdl.match(/upload_splat_pass\(/g) ?? []).length,
        1,
    );
    assert.equal(
        (dawn.match(/upload_dawn_splat_pass\(/g) ?? []).length,
        1,
    );
});

test("replays billboard stages in compiler-owned frame-graph scene tasks", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(
        sdl,
        /draw_scene_billboard_stages[\s\S]{0,18000}BillboardDepthMode::cutout/,
    );
    assert.match(
        sdl,
        /draw_task_ground[\s\S]{0,900}BillboardDepthMode::transparent/,
    );
    assert.match(
        dawn,
        /task\.render\.scene_stages[\s\S]{0,12000}BillboardDepthMode::cutout/,
    );
    assert.match(
        dawn,
        /state\.ground_pipeline[\s\S]{0,3500}BillboardDepthMode::transparent/,
    );
});

test("shares parent and clone transforms with shadow caster fitting", () => {
    const shadows = source("src/lowering/shadow-lowerer.ts");
    const renderer = source("src/lowering/renderer-lowerer.ts");

    assert.match(
        shadows,
        /mesh\.transform_parent\.value < engine\.transform_nodes\.size\(\)[\s\S]{0,180}mesh_world_matrix\(engine, mesh\)/,
    );
    assert.match(
        shadows,
        /return apply_mesh_outer_transform\(mesh, local\);/,
    );
    // The outer transform is the pinned composition's double arm on the
    // left of the world, never a per-column rotation restated here.
    assert.match(
        renderer,
        /std::array<double, 16> apply_mesh_outer_transform\(\s*const MeshRecord& mesh,\s*std::array<double, 16> world\) \{\s*return outer_transform_product\(\s*mesh\.outer_position, mesh\.outer_rotation, world\);/,
    );
    assert.doesNotMatch(renderer, /std::sin\(static_cast<double>\(mesh\.outer_rotation/);
});

test("keys PBR instance colour from the stream binding predicate", () => {
    const generated = source("src/pinned-pbr-variant-cpp.ts");
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(
        generated,
        /const instanceColorBit = pinnedNumericConstant\([\s\S]{0,180}"MSH_HAS_INSTANCE_COLOR"/,
    );
    assert.match(
        generated,
        /pinned_msh_has_instance_color =\s*\$\{instanceColorBit\}u/,
    );
    assert.match(
        shared,
        /pinned_record_instanced\(record\)[\s\S]{0,500}pinned_record_instance_colored\(record\)[\s\S]{0,180}pinned_msh_has_instance_color/,
    );
    const pbrDrawStart = sdl.indexOf("void draw_pinned_variant(");
    const pbrDraw = sdl.slice(
        pbrDrawStart,
        sdl.indexOf("#if BBLITE_NODE_VARIANTS", pbrDrawStart),
    );
    assert.match(
        pbrDraw,
        /pinned_record_instance_colored\(pinned_record\)[\s\S]{0,180}pinned_colors = mesh\.instance_colors[\s\S]{0,260}bind_composed_mesh_vertex_buffers\(/,
    );
    assert.match(
        sdl,
        /void bind_composed_mesh_vertex_buffers[\s\S]{0,700}bindings\[2\] = SDL_GPUBufferBinding\{colors, 0\};[\s\S]{0,160}SDL_BindGPUVertexBuffers\(pass, 0, bindings\.data\(\), count\);/,
    );
    assert.match(
        dawn,
        /pinned_record_instance_colored\(record\)[\s\S]{0,180}streams\.colors = mesh\.instance_colors/,
    );
    assert.match(
        dawn,
        /if \(instances\.colors\)[\s\S]{0,220}VertexInputStream::instance_color[\s\S]{0,120}instances\.colors/,
    );
});

test("composes PBR thin-instance parent TRS before the root mirror", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");

    assert.match(
        shared,
        /pinned_instanced_world\([\s\S]{0,240}pinned_x_mirrored_world\(\s*instance_parent_draw_world\(record, scene, engine\)\)/,
    );
    assert.match(
        shared,
        /if \(pinned_record_instanced\(record\)\) \{\s*return pinned_instanced_world\(record, scene, engine\);/,
    );
    assert.doesNotMatch(
        shared,
        /draw_world\(\s*pinned_instanced_world/,
    );
});

test("restores wheel-local glTF vertices before live quaternion writes", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    const loader = source("src/lowering/templates/gltf-loader-cpp.ts");
    const shared = source("native/src/pal_gpu_shared.hpp");
    const scene = source("src/lowering/scene-lowerer.ts");

    assert.match(runtime, /bool live_imported_transform = false;/);
    assert.match(loader, /retains_live_wheel_vertices/);
    assert.match(loader, /geometry\.bind_vertices\[index\] = local_vertex/);
    assert.match(
        shared,
        /mesh\.gpu_deformation \|\| mesh\.live_imported_transform/,
    );
    assert.match(
        scene,
        /record\.name\.rfind\("wheel", 0\) != 0[\s\S]{0,900}record\.gpu_world_transform = true;/,
    );
    assert.match(
        scene,
        /void set_mesh_rotation_quaternion\([\s\S]{0,800}record\.live_imported_transform[\s\S]{0,500}quaternion\.y = -quaternion\.y;[\s\S]{0,120}quaternion\.z = -quaternion\.z;/,
    );
});

test("restores local glTF vertices for hierarchy instance pools", () => {
    const loader = source("src/lowering/templates/gltf-loader-cpp.ts");
    const shared = source("native/src/pal_gpu_shared.hpp");
    const upstream = source("src/upstream-lower.ts");

    assert.match(
        upstream,
        /dynamicThinInstances: features\.includes\(\s*"mesh:thin-instances-dynamic"/,
    );
    assert.match(
        loader,
        /retains_runtime_instance_vertices[\s\S]{0,300}retains_local_vertices[\s\S]{0,300}geometry\.bind_vertices\.resize/,
    );
    assert.match(
        loader,
        /flat_bind_vertices[\s\S]{0,900}geometry\.bind_vertices =\s*std::move\(flat_bind_vertices\)/,
    );
    assert.match(
        shared,
        /restores_runtime_instance_vertices =\s*mesh\.thin_instanced &&\s*geometry\.vertex_space == VertexSpace::world;[\s\S]{0,300}geometry\.bind_vertices/,
    );
});

test("does not idle either GPU backend for runtime scene topology updates", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(
        sdl,
        /scene\.render_topology_version !=[\s\S]{0,300}SDL releases GPU resources only when pending command/,
    );
    assert.doesNotMatch(sdl, /SDL_WaitForGPUIdle topology update/);
    assert.match(
        dawn,
        /std::vector<DawnMesh> updated_meshes =\s*rematch_render_meshes\(/,
    );
    for (const backend of [sdl, dawn]) {
        assert.match(backend, /if \(topology_updated \|\| engine\.draw_list_epoch != synced_draw_list_epoch\) \{\s*rebuild_task_draw_lists\(\);\s*\}\s*synced_draw_list_epoch = engine\.draw_list_epoch;/);
    }
    assert.doesNotMatch(dawn, /wgpuQueueOnSubmittedWorkDone/);
});

test("keeps dynamic shader geometry local and transforms it per draw", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");
    const capture = source("native/src/pal_render_capture.hpp");

    assert.match(shared, /inline std::vector<GpuVertex> local_vertices\(/);
    assert.match(shared, /rematch_render_meshes\(/);
    assert.match(shared, /inline std::array<float, 16> shader_draw_world\(/);
    // The per-draw world/world-view/world-view-projection lanes are one
    // shared record; both backends and the capture writer construct it
    // instead of composing their own products (capture-equivalence.test.ts
    // carries the full contract).
    assert.match(shared, /struct ShaderDrawMatrices \{/);
    assert.match(
        shared,
        /case upstream::ShaderSystemMatrix::world_view_projection:\s*(?:case upstream::ShaderSystemMatrix::\w+:\s*)*return false;/,
    );
    assert.match(shared, /upstream::matrix_product\(pass\.view_projection, world\)/);
    assert.doesNotMatch(shared, /shader_matrix_product\(/);

    for (const backend of [sdl, dawn]) {
        assert.match(
            backend,
            /shader_material\s*\?\s*local_vertices\(engine, geometry, &mesh_record\)/,
        );
        assert.match(backend, /shared_shader_geometries/);
        assert.match(backend, /shared_geometry->users/);
        assert.match(backend, /prune_shared_shader_geometries/);
        assert.match(backend, /shared_shader_material_textures/);
        assert.match(backend, /shared_shader_textures->users/);
        assert.match(backend, /prune_shared_shader_material_textures/);
        assert.match(backend, /ShaderDrawMatrices shader_matrices\(/);
        assert.match(backend, /shader_matrices\.apply\(/);
        assert.match(
            backend,
            /item\.material_kind ==\s*upstream::RenderMaterialKind::shader[\s\S]{0,300}transform_version = mesh\.transform_version;[\s\S]{0,80}continue;/,
        );
    }
    assert.match(capture, /shader_matrices\.apply\(pass_matrices\)/);
    // The capture packs the block through the same caller-owned-scratch
    // shape both backends' draw loops thread through the shared packer.
    assert.match(
        capture,
        /shader_stage_block_floats\(\s*block,\s*shader_pass_matrices,\s*material,\s*stage_block_floats\)/,
    );

    // Local/shared geometry does not make the per-draw instance streams
    // global geometry. A custom shader can consume the matrix and colour
    // lanes just like a composed material, so both backends must allocate
    // and bind those buffers for shader draws too.
    assert.doesNotMatch(
        sdl,
        /#if BBLITE_GPU_INSTANCING\s*if \(!shader_material\)/,
    );
    assert.doesNotMatch(
        sdl,
        /bind_mesh_vertex_buffers\([^;]{0,160}!shader_bucket/,
    );
    assert.doesNotMatch(
        sdl,
        /bind_mesh_vertex_buffers\([^;]{0,200}RenderMaterialKind::shader/,
    );

    // Generated PBR/Standard texture lanes are not per-mesh resources for a
    // custom shader family. Both backends retain inert shared bindings where
    // their API layout requires them and upload the lanes only for composed
    // material draws.
    for (const backend of [sdl, dawn]) {
        assert.match(
            backend,
            /const bool composed_material =/,
        );
        assert.match(
            backend,
            /if \(composed_material\) \{[\s\S]{0,4000}material_texture_slots/,
        );
    }
});

test("shares composed material textures and keeps physics geometry local", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");
    const runtime = source("native/include/bblite/runtime.hpp");
    const physics = source("src/lowering/physics-lowerer.ts");

    assert.match(runtime, /bool gpu_world_transform = false;/);
    assert.match(
        source("src/lowering/scene-lowerer.ts"),
        /void mark_mesh_runtime_transform[\s\S]*?record\.gpu_world_transform = true;[\s\S]*?mark_mesh_runtime_transform\(engine, child\);/,
    );
    assert.match(physics, /mark_mesh_runtime_transform\(engine, mesh\);/);
    assert.match(
        shared,
        /mesh\.thin_instanced \|\| mesh\.gpu_world_transform[\s\S]{0,100}\? identity_transform/,
    );
    assert.match(
        shared,
        /if \(record\.gpu_world_transform\)[\s\S]{0,220}upstream::mesh_world_matrix\(engine, record\)/,
    );
    assert.match(
        shared,
        /#if defined\(BBLITE_HAS_PBR_RENDERER\) && BBLITE_HAS_PBR_RENDERER\s+if \(record\.gpu_world_transform\)/,
    );

    for (const backend of [
        source("native/src/pal_sdl_gpu.cpp"),
        source("native/src/pal_dawn.cpp"),
    ]) {
        assert.match(backend, /SharedComposedMaterialTextures/);
        assert.match(backend, /shared_composed_material_textures/);
        assert.match(backend, /shared_composed_textures->users/);
        assert.match(backend, /prune_shared_composed_material_textures/);
        assert.match(
            backend,
            /gpu_world_transform[\s\S]{0,300}transform_version = mesh\.transform_version;[\s\S]{0,100}continue;/,
        );
    }
});

test("keeps reached Havok body defaults and convex mass frames in the Bullet PAL", () => {
    const contract = source("native/include/bblite/pal_physics.hpp");
    const bullet = source("native/src/pal_physics_bullet.cpp");

    assert.match(
        contract,
        /std::array<double, 4> inertia_orientation\{0\.0, 0\.0, 0\.0, 1\.0\};/,
    );
    assert.match(bullet, /calculatePrincipalAxisTransform/);
    assert.match(
        bullet,
        /world \*= entry\.node_from_body;[\s\S]{0,160}setWorldTransform/,
    );
    assert.match(bullet, /default_max_linear_speed = btScalar\(200\)/);
    assert.match(bullet, /default_max_angular_speed = btScalar\(100\)/);
    assert.match(bullet, /default_angular_damping = btScalar\(0\.1\)/);
    // Havok applies its ceiling as part of an impulse write rather than at
    // the step, so the clamp follows the impulse -- and it reads the WORLD's
    // limit, because the floating-origin module seeds each new region's from
    // the base world's rather than from these defaults. The by-entry
    // overload is what resolves that world, so naming it here is what keeps
    // the assertion about the limit's SOURCE rather than about a spelling.
    assert.match(
        bullet,
        /applyImpulse\([\s\S]{0,200}clamp_body_velocity\(entry\);/,
    );
    assert.match(
        bullet,
        /void clamp_body_velocity\(const PhysicsBodyState& entry\)[\s\S]{0,400}body_speed_limit\(entry\)/,
    );
    assert.match(
        bullet,
        /stabilize_contacting_bodies[\s\S]{0,4500}ISLAND_SLEEPING/,
    );
    assert.match(
        bullet,
        /has_custom_filter[\s\S]{0,900}addRigidBody\(entry\.body\.get\(\)\)/,
    );
    assert.match(
        bullet,
        /membership_mask != 0xffffffffu[\s\S]{0,100}collide_mask != 0xffffffffu/,
    );
});

test("releases Dawn mesh dependents before their owned resources", () => {
    const dawn = source("native/src/pal_dawn.cpp");
    const releaseMesh = dawn.slice(
        dawn.indexOf("    void release_gpu_resources(DawnMeshResources& mesh)"),
        dawn.indexOf("    void release_meshes()"),
    );
    const bindingRelease = releaseMesh.indexOf(
        "binding.textures.reset()",
    );
    const drawStateRelease = releaseMesh.indexOf(
        "mesh.pinned_states.clear()",
    );
    const textureRelease = releaseMesh.indexOf(
        "wgpuTextureViewRelease(mesh.owned_views[slot])",
    );
    assert.ok(bindingRelease >= 0);
    assert.ok(drawStateRelease > bindingRelease);
    assert.ok(textureRelease > drawStateRelease);
    assert.match(
        releaseMesh,
        /mesh\.owned_textures\[slot\] && mesh\.samplers\[slot\]/,
    );

    const destructor = dawn.slice(dawn.indexOf("    ~DawnState()"));
    assert.ok(
        destructor.indexOf("release_meshes();") <
            destructor.indexOf(
                "wgpuPipelineLayoutRelease(mesh_pipeline_layout)",
            ),
    );
});
