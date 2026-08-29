import assert from "node:assert/strict";
import {
    readFileSync,
    readdirSync,
} from "node:fs";
import test from "node:test";

function source(path: string): string {
    return readFileSync(path, "utf8");
}

test("keeps JavaScript array helpers compatible with generated native vectors", () => {
    const runtime = source("native/include/bblite/js_data.hpp");
    assert.match(
        runtime,
        /template <typename Values>\s+\[\[nodiscard\]\] inline double array_length\(const Values& values\)/,
    );
    for (const kind of ["u8", "u16", "f32", "u32"]) {
        assert.match(
            runtime,
            new RegExp(
                `template <typename Values>\\s+\\[\\[nodiscard\\]\\] inline [^\\n]+ ${kind}_array_from\\(const Values& values\\)`,
            ),
        );
    }
});

test("shares one binary-buffer runtime between generated and native code", () => {
    const runtime = source("native/include/bblite/ts_runtime.hpp");
    assert.match(runtime, /using ArrayBuffer = js::ArrayBuffer;/);
    assert.match(runtime, /using Uint8Array = js::U8Array;/);
    assert.match(runtime, /using DataView = js::DataView;/);
    assert.doesNotMatch(runtime, /class (?:ArrayBuffer|DataView)/);
});

test("accepts value and identity-backed records in native vector paths", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    assert.match(
        runtime,
        /if constexpr \(requires \{ point\.x; point\.y; point\.z; \}\)/,
    );
    assert.match(
        runtime,
        /Vec3d\{point->x, point->y, point->z\}/,
    );
});

test("uses TypeScript semantic symbols instead of import-name text matching", () => {
    const compiler = source("src/compiler.ts");
    assert.match(compiler, /createCompilerProgram/);
    assert.match(compiler, /CompilerSymbols/);
    assert.doesNotMatch(compiler, /collectImports/);
    assert.doesNotMatch(
        compiler,
        /this\.imports/,
    );
});

test("delegates default-library identity to the TypeScript program", () => {
    const compiler = source("src/compiler.ts");
    assert.match(
        compiler,
        /this\.program\.isSourceFileDefaultLibrary/,
    );
    assert.doesNotMatch(compiler, /hasNoDefaultLib/);
});

test("keeps migrated upstream contracts AST-driven", () => {
    const lowerers = readdirSync("src/lowering")
        .filter(
            (name) =>
                name.endsWith("-lowerer.ts") &&
                name !== "renderer-lowerer.ts",
        )
        .map((name) => `src/lowering/${name}`);
    // The split families under gltf/ and factory/ carry the same
    // contract as the barrels that re-export them.
    const families = ["gltf", "factory"].flatMap((dir) =>
        readdirSync(`src/lowering/${dir}`).map(
            (name) => `src/lowering/${dir}/${name}`,
        ),
    );
    for (const path of [
        ...lowerers,
        ...families,
        "src/upstream-source.ts",
    ]) {
        const content = source(path);
        assert.doesNotMatch(content, /store\.getSource/);
        assert.doesNotMatch(content, /extractNumber\(/);
        assert.doesNotMatch(content, /\.match\(/);
        assert.doesNotMatch(content, /new RegExp/);
    }
});

test("isolates remaining source-text contracts to the renderer", () => {
    const renderer = source(
        "src/lowering/renderer-lowerer.ts",
    );
    assert.match(renderer, /store\.getSource/);
});

test("keeps the pin-import family in the shader composer", () => {
    // The pinned-library resolution and the relative-specifier anchoring
    // each exist exactly once, in pinned-shader-composer.ts. A second copy
    // is how they drifted before: the mirror in pinned-material-input.ts
    // resolved the same path without the missing-install refusal.
    const files = readdirSync("src", { recursive: true })
        .map((name) => `src/${String(name).replace(/\\/g, "/")}`)
        .filter((path) => path.endsWith(".ts"));
    for (const marker of [
        "function pinnedLibraryRoot",
        // The specifier-anchoring character class, as spelled in the one
        // rewrite regex.
        "(\\.\\.?\\/",
    ]) {
        const owners = files.filter((path) =>
            source(path).includes(marker),
        );
        assert.deepEqual(
            owners,
            ["src/pinned-shader-composer.ts"],
            `'${marker}' must live only in pinned-shader-composer.ts`,
        );
    }
});

test("keeps handle-collection semantics in one module", () => {
    // The collection resolvers, the loop frame, the find, the pushes and
    // the imported-mesh walk proof all live in handle-collections.ts —
    // the concept a new collection shape extends instead of becoming
    // another exact-shape sibling in expressions/statements/compiler.
    const files = readdirSync("src", { recursive: true })
        .map((name) => `src/${String(name).replace(/\\/g, "/")}`)
        .filter((path) => path.endsWith(".ts"));
    for (const marker of [
        "readHandleCollection(",
        "function emitHandleCollectionLoop",
        "function isRecursiveImportedMeshWalk",
        "nativeLocation(",
    ]) {
        const owners = files
            .filter((path) => source(path).includes(marker))
            .filter(
                (path) =>
                    path !== "src/compiler/properties.ts",
            );
        assert.deepEqual(
            owners,
            ["src/compiler/handle-collections.ts"],
            `'${marker}' must live only in handle-collections.ts (and its table in properties.ts)`,
        );
    }
    // The statement and expression layers reach the concept, not local
    // re-derivations of it.
    assert.match(
        source("src/compiler/statements.ts"),
        /from "\.\/handle-collections\.js"/,
    );
    assert.match(
        source("src/compiler/expressions.ts"),
        /handleCollections\.compileFind/,
    );
});

test("routes extracted intrinsic families through the registry", () => {
    const registry = source(
        "src/compiler/intrinsics/registry.ts",
    );
    const compiler = source("src/compiler.ts");
    for (const family of [
        "Animation",
        "Asset",
        "Camera",
        "Engine",
        "Light",
        "Material",
        "Mesh",
        "Scene",
    ]) {
        assert.match(
            registry,
            new RegExp(`compile${family}Intrinsic`),
        );
    }
    assert.match(compiler, /compileRegisteredIntrinsic/);
    assert.doesNotMatch(compiler, /case "create/);
});

test("isolates static expression lowering from entry orchestration", () => {
    const compiler = source("src/compiler.ts");
    const evaluator = source(
        "src/compiler/static-evaluator.ts",
    );
    assert.match(compiler, /StaticEvaluator/);
    assert.match(evaluator, /resolveStaticExpression/);
    assert.match(evaluator, /compileNumber/);
    assert.match(evaluator, /compileColor3/);
    assert.doesNotMatch(
        compiler,
        /Only \+, -, \*, and \/ are supported/,
    );
    assert.doesNotMatch(
        compiler,
        /Expected a Color3 array/,
    );
});

test("lowers property assignments outside the entry orchestrator", () => {
    const compiler = source("src/compiler.ts");
    const assignments = source(
        "src/compiler/assignments.ts",
    );
    assert.match(compiler, /emitPropertyAssignment/);
    assert.match(assignments, /AssignmentContext/);
    assert.match(assignments, /directPropertyAssignment/);
    assert.doesNotMatch(
        compiler,
        /Unsupported property assignment/,
    );
});

test("resolves property reads from one declared table", () => {
    const compiler = source("src/compiler.ts");
    const assignments = source(
        "src/compiler/assignments.ts",
    );
    const properties = source(
        "src/compiler/properties.ts",
    );
    assert.match(compiler, /readProperty/);
    assert.match(properties, /propertyRules/);
    // Every read of a handle's property ends in one place. The general
    // property path, the static evaluator's lookup, the data lowerer's
    // plain-data property bridge and each nested link go through
    // `readOwnerProperty`, which is the only caller of the table besides
    // destructuring, and the writes take their field names from the table
    // too. Each of those was a separate copy once, and they had drifted
    // apart.
    assert.equal(
        (compiler.match(/readOwnerProperty\(/g) ?? [])
            .length,
        6,
    );
    assert.equal(
        (compiler.match(/readProperty\(/g) ?? []).length,
        3,
    );
    assert.match(assignments, /cameraRecordField/);
    for (const field of [
        "near_plane",
        "angular_sensibility",
        "ortho_half_height",
    ]) {
        assert.doesNotMatch(compiler, new RegExp(field));
    }
    assert.doesNotMatch(
        assignments,
        /angular_sensibility/,
    );
});

test("matches custom shaders through typed WGSL IR", () => {
    // The matching moved with the shader-material block: the compiler
    // delegates, and the module is the one that lowers through the IR.
    const shaderMaterial = source(
        "src/compiler/shader-material.ts",
    );
    assert.match(shaderMaterial, /lowerWgslShaderProgram/);
    for (const content of [
        source("src/compiler.ts"),
        shaderMaterial,
    ]) {
        assert.doesNotMatch(
            content,
            /normalizeShaderSource/,
        );
        assert.doesNotMatch(
            content,
            /vertexSource ===/,
        );
        assert.doesNotMatch(
            content,
            /fragmentSource ===/,
        );
    }
});

test("keeps extracted option and manifest blocks in their modules", () => {
    // Each entry pins one moved block by a string that lived in
    // compiler.ts before the extraction: the module must carry it and
    // the entry orchestrator must not grow it back.
    const compiler = source("src/compiler.ts");
    const blocks: ReadonlyArray<[string, RegExp[]]> = [
        [
            "src/compiler/option-helpers.ts",
            [
                /Expected a positive integer literal\./,
                /compileOptionalStaticBoolean/,
            ],
        ],
        [
            "src/compiler/intrinsics/mesh-options.ts",
            [
                /Sphere segments must be a positive static integer\./,
                /Torus options support diameter, thickness, and tessellation\./,
            ],
        ],
        [
            "src/compiler/intrinsics/engine-options.ts",
            [
                /Geometry textureDescriptions must contain 1-8 entries\./,
                /Copy task requires targetTexture or resolveTexture\./,
                /defaultRenderTask must be a static boolean\./,
            ],
        ],
        [
            "src/compiler/intrinsics/material-options.ts",
            [
                /Reached PBR lowering supports/,
                /Sheen albedoScaling must be a static boolean/,
            ],
        ],
        [
            "src/compiler/intrinsics/asset-options.ts",
            [
                /Reached DDS environment options support brdfUrl\./,
                /HDR faceSize must be a power of two/,
            ],
        ],
        [
            "src/compiler/shader-material.ts",
            [
                /collides with a predeclared variant/,
                /Shader uniform writes require a shader material\./,
            ],
        ],
        [
            "src/compiler/property-animation.ts",
            [
                /Unsupported property animation path/,
                /cannot specify both fromTime and fromFrame/,
            ],
        ],
        [
            "src/compiler/adaptations.ts",
            [
                /entry-main-wrapper-erasure/,
                /sdl-gpu-frame-graph/,
            ],
        ],
        [
            "src/compiler/assets.ts",
            [
                // The two kinds a scene module produces, and the refusal
                // they share when the call carries arguments.
                /drawn sprite atlas/,
                /pixel buffer/,
                /factory takes no arguments\./,
                /brdf-lut\.png/,
            ],
        ],
        [
            "src/compiler/output-projection.ts",
            [
                // The feature→sources authority and the two artifact
                // renders (main.cpp, features.cmake).
                /set\(BBLITE_RUNTIME_FEATURES/,
                /Generated by bblitec\. Do not edit\./,
                /"physics:world"/,
            ],
        ],
        [
            "src/compiler/scene-materials.ts",
            [
                /names no scene-code PBR material/,
                /creation-ordered across families/,
            ],
        ],
        [
            "src/compiler/module-initializers.ts",
            [
                /post-initializer identity/,
                /Module storage read or written/,
            ],
        ],
        [
            "src/compiler/sprite-atlas-record.ts",
            [
                /A data SpriteAtlas requires a file or pixels texture/,
                /SpriteAtlas frames require an array/,
            ],
        ],
    ];
    for (const [path, patterns] of blocks) {
        const moved = source(path);
        for (const pattern of patterns) {
            assert.match(moved, pattern);
            assert.doesNotMatch(compiler, pattern);
        }
        // The compiler still reaches every moved block through its
        // import, so the delegators cannot silently detach.
        const specifier = path
            .replace("src/", "./")
            .replace(".ts", ".js");
        assert.ok(
            compiler.includes(`from "${specifier}"`),
            `compiler.ts imports ${specifier}`,
        );
    }
    // Round 1 established every call-expression path returns before the
    // trailing canvas-lookup block; the dead remainder stays deleted.
    assert.doesNotMatch(
        source("src/compiler/browser-erasure.ts"),
        /isCanvasLookup|isPerformanceNow/,
    );
});

test("keeps local function lowering in its feature module", () => {
    const compiler = source("src/compiler.ts");
    const functions = source(
        "src/compiler/user-functions.ts",
    );
    assert.match(compiler, /UserFunctionLowerer/);
    assert.match(functions, /UserFunctionIr/);
    assert.match(functions, /isTypeAssignableTo/);
    assert.doesNotMatch(
        compiler,
        /Recursive call to/,
    );
    assert.doesNotMatch(
        compiler,
        /Generator functions are not supported/,
    );
});

test("keeps statement lowering in its feature module", () => {
    const compiler = source("src/compiler.ts");
    const statements = source(
        "src/compiler/statements.ts",
    );
    assert.match(compiler, /StatementLowerer/);
    assert.match(statements, /StatementLoweringContext/);
    assert.doesNotMatch(
        compiler,
        /Unsupported expression statement/,
    );
    assert.doesNotMatch(
        compiler,
        /Reached RenderTask\.addMesh requires/,
    );
});

test("keeps the split lowerer families in their modules", () => {
    // The three biggest lowerers were split along their measured seams
    // (gltf families, factory halves, render-plan methods). Each family
    // module owns its declarations and the old monolith files stay pure
    // barrels — a declaration growing back into a barrel is the
    // regression this pins against.
    const homes: ReadonlyArray<[string, RegExp[]]> = [
        [
            "src/lowering/gltf/loader.ts",
            [/export class GltfLowerer/],
        ],
        [
            "src/lowering/gltf/animation-interpolation.ts",
            [
                /function lowerAnimationInterpolationCpp/,
                /function renderCppExpression/,
            ],
        ],
        [
            "src/lowering/gltf/sampler-mapping.ts",
            [
                /function lowerSamplerMappingCpp/,
                /function evaluatePinExpression/,
            ],
        ],
        [
            "src/lowering/gltf/accessor-normalization.ts",
            [
                /function lowerAccessorNormalizationCpp/,
                /function lowerVertexColorCpp/,
            ],
        ],
        [
            "src/lowering/gltf/sh-prescale.ts",
            [/function lowerShPrescaleCpp/],
        ],
        [
            "src/lowering/gltf/image-processing-defaults.ts",
            [/function lowerImageProcessingDefaultsCpp/],
        ],
        [
            "src/lowering/gltf/extension-defaults.ts",
            [/function lowerGltfExtensionDefaults/],
        ],
        [
            "src/lowering/gltf/matrix-leaves.ts",
            [
                /function lowerMatrixMultiplyCpp/,
                /function lowerMatrixComposeCpp/,
                /function lowerLocalMatrixCpp/,
                /function lowerMatrixNativeCpp/,
            ],
        ],
        [
            "src/lowering/gltf/ibl.ts",
            [
                /function lowerIblPolynomialCpp/,
                /function lowerIblEnvironmentScalarsCpp/,
            ],
        ],
        [
            "src/lowering/gltf/punctual-lights.ts",
            [/function lowerPunctualLightsCpp/],
        ],
        [
            "src/lowering/gltf/material-defaults.ts",
            [/function lowerGltfMaterialDefaults/],
        ],
        [
            "src/lowering/gltf/factor-bake.ts",
            [/function lowerGltfFactorBake/],
        ],
        [
            "src/lowering/gltf/shared.ts",
            [/function refuseNode/, /function topLevelFunction/],
        ],
        [
            "src/lowering/factory/mesh-builders.ts",
            [/class MeshBuilderLowerer/, /lowerMeshFactories/],
        ],
        [
            "src/lowering/factory/material-factories.ts",
            [
                /class FactoryLowerer extends MeshBuilderLowerer/,
                /lowerNodeMaterialFactory/,
            ],
        ],
    ];
    for (const [path, patterns] of homes) {
        const moved = source(path);
        for (const pattern of patterns) {
            assert.match(moved, pattern);
        }
    }
    // The barrels re-export and declare nothing.
    for (const barrel of [
        "src/lowering/gltf-lowerer.ts",
        "src/lowering/factory-lowerer.ts",
    ]) {
        const content = source(barrel);
        assert.doesNotMatch(content, /function |class /);
        assert.match(content, /export \{/);
    }
    // The render-plan monolith stays one file (its content is tracked
    // for port-not-rederive replacement), but its seams stay named: the
    // header/source renders and the pinned proofs live behind their own
    // methods rather than inline in lowerRenderPlan.
    const renderer = source(
        "src/lowering/renderer-lowerer.ts",
    );
    for (const seam of [
        /private assertRenderPlanPins\(/,
        /private assertPinnedTransparentSort\(\)/,
        /private loweredShaderVariants\(/,
        /private provedOpaqueOrderStamp\(\)/,
        /private renderPlanHeaderCpp\(/,
        /private renderPlanSourceCpp\(/,
        /private assertPinnedShaderFormulas\(/,
    ]) {
        assert.match(renderer, seam);
    }
    // The surface sample-count proof moved behind its own module in the
    // wave-2 precision pass; the seam is the pinned-surface emitter now.
    assert.match(
        source("src/lowering/pinned-surface.ts"),
        /function pinnedSampleCount\(/,
    );
});

test("preserves multisampling across the transmission scene-color copy", () => {
    const pal = source("native/src/pal_sdl_gpu.cpp");
    assert.match(
        pal,
        /const bool multisampled =\s*state\.sample_count != SDL_GPU_SAMPLECOUNT_1;/,
    );
    assert.match(
        pal,
        /transmission_enabled\s*\?\s*SDL_GPU_STOREOP_RESOLVE_AND_STORE/,
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
        /GpuBufferUploadBatch\* buffer_uploads = nullptr/,
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

test("keeps scene-less sprite render targets and renderer registration live", () => {
    const sdl = source("native/src/pal_sdl_gpu_sprite.cpp");
    const dawn = source("native/src/pal_dawn_sprite.cpp");

    for (const backend of [sdl, dawn]) {
        assert.match(backend, /handle_platform_event\(event, engine\);/);
        assert.match(backend, /keyboard_replay\.dispatch\(frame, engine\);/);
        assert.match(backend, /const auto sync_render_textures = \[&\]\(\)/);
        assert.match(backend, /const auto sync_renderer_passes = \[&\]\(\)/);
        assert.match(
            backend,
            /advance_frame\([\s\S]{0,220}sync_render_textures\(\);\s*sync_renderer_passes\(\);/,
        );
        assert.match(
            backend,
            /for \(std::size_t first_index = 0;[\s\S]{0,900}first_renderer\.has_target/,
        );
    }
    assert.match(
        dawn,
        /WGPUTextureUsage_RenderAttachment \|\s*WGPUTextureUsage_TextureBinding/,
    );
    assert.match(dawn, /resize_dawn_surface\(state, engine\.options\)/);
});

test("forwards DOM-compatible application input through every native loop", () => {
    const events = source("native/src/pal_platform_events.hpp");
    assert.match(events, /case SDL_SCANCODE_SPACE: return "Space";/);
    assert.match(events, /if \(code == "Space"\) return " ";/);
    assert.match(events, /engine\.key_down_callbacks/);
    assert.match(events, /engine\.key_up_callbacks/);
    assert.match(events, /SDL_EVENT_WINDOW_RESIZED/);
    assert.match(events, /SDL_EVENT_WINDOW_PIXEL_SIZE_CHANGED/);
    assert.match(events, /SDL_GetWindowSizeInPixels/);
    assert.match(events, /engine\.options\.width = width;/);
    assert.match(events, /engine\.options\.height = height;/);

    for (const path of [
        "native/src/pal_sdl_gpu.cpp",
        "native/src/pal_dawn.cpp",
        "native/src/pal_sdl_gpu_sprite.cpp",
        "native/src/pal_dawn_sprite.cpp",
        "native/src/pal_sdl_gpu_effect.cpp",
        "native/src/pal_dawn_effect.cpp",
        "native/src/pal_sdl_gpu_frame_graph.cpp",
        "native/src/pal_dawn_frame_graph.cpp",
    ]) {
        const loop = source(path);
        assert.match(loop, /handle_platform_event\(event, engine\);/);
        assert.match(loop, /keyboard_replay\.dispatch\(frame, engine\);/);
    }
});

test("reports zero delta on the fixed clock's first frame", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");

    assert.match(shared, /const bool first_frame = previous_ == 0\.0;/);
    assert.match(
        shared,
        /fixed_delta_ms > 0\.0f && !first_frame\s*\? fixed_delta_ms\s*:\s*measured/,
    );
});

test("selects live shadow-receiver variants for runtime meshes", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");

    // Runtime-created meshes have no generated feature-table entry. Both
    // composed material families must therefore select this dynamic bit from
    // the live mesh record instead of silently choosing a non-shadow variant.
    assert.equal(
        (shared.match(/if \(record\.receives_shadows\) \{/g) ?? []).length,
        2,
    );
    assert.equal(
        (shared.match(/key\.mesh_features \|= receive_shadows;/g) ?? []).length,
        2,
    );
    assert.equal(
        (shared.match(/key\.mesh_features &= ~receive_shadows;/g) ?? []).length,
        3,
    );
});

test("runs post-start RAF callbacks only after the engine render", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(runtime, /post_render_animation_frame_callbacks/);
    assert.match(
        runtime,
        /std::vector<std::function<void\(double\)>> animation_frame_callbacks/,
    );
    assert.match(runtime, /double animation_frame_timestamp_ms = 0\.0;/);
    assert.match(
        shared,
        /inline void run_animation_frame_callbacks\(Engine& engine\)/,
    );
    assert.equal(
        (shared.match(/run_animation_frame_callbacks\(engine\);/g) ?? [])
            .length,
        3,
    );
    assert.match(
        shared,
        /inline void finish_frame\(Engine& engine\)[\s\S]{0,900}post_render_animation_frame_callbacks/,
    );
    assert.match(shared, /post_render_animation_frame_callbacks_armed = true/);
    assert.match(shared, /run_interval_callbacks\(engine\);/);
    for (const backend of [sdl, dawn]) {
        assert.match(backend, /finish_frame\(engine\);[\s\S]{0,220}\+\+frame/);
    }
});

test("keeps SpriteFx elapsed time at JavaScript number precision", () => {
    for (const path of [
        "native/src/pal_sdl_gpu_sprite.hpp",
        "native/src/pal_dawn_sprite.hpp",
        "native/src/pal_sdl_gpu_billboard.hpp",
        "native/src/pal_dawn_billboard.hpp",
    ]) {
        const backend = source(path);
        assert.match(backend, /double elapsed_ms = 0\.0;/);
        assert.match(
            backend,
            /static_cast<float>\([^)]*elapsed_ms \/ 1000\.0\)/,
        );
    }
});

test("invalidates billboard uploads when same-count instance data changes", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    const lowerer = source("src/lowering/billboard-lowerer.ts");
    const shared = source("native/src/pal_gpu_shared.hpp");

    assert.match(
        runtime,
        /struct BillboardSystemRecord[\s\S]{0,1200}std::uint64_t instance_version = 0;/,
    );
    assert.match(
        lowerer,
        /system\.count = index \+ 1u;\s*system\.instance_version \+= 1u;/,
    );
    assert.match(
        lowerer,
        /if \(system\.count != 0u\)[\s\S]{0,120}system\.instance_version \+= 1u;/,
    );
    assert.match(
        shared,
        /stamp\.instance_version != system\.instance_version/,
    );
    assert.match(
        shared,
        /stamp\.instance_version = system\.instance_version;/,
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

test("fits the single CSM map to the first clone-aware cascade", () => {
    const shadows = source("src/lowering/shadow-lowerer.ts");

    assert.match(
        shadows,
        /const double p = 1\.0 \/[\s\S]{0,100}csm_num_cascades/,
    );
    assert.match(
        shadows,
        /shadow_caster_world[\s\S]{0,3200}mesh\.outer_rotation[\s\S]{0,2500}mesh\.outer_position\.x/,
    );
});

test("reuploads dynamic thin-instance colors on both GPU backends", () => {
    for (const backend of [
        source("native/src/pal_sdl_gpu.cpp"),
        source("native/src/pal_dawn.cpp"),
    ]) {
        assert.match(
            backend,
            /instance_version !=[\s\S]{0,2200}instance_colors\.data\(\)/,
        );
    }
});

test("keeps looping buffer sources and playback rate on the audio PAL", () => {
    const contract = source("native/include/bblite/pal_audio.hpp");
    const pal = source("native/src/pal_audio_labsound.cpp");

    assert.match(contract, /AudioParamName[\s\S]{0,200}PlaybackRate/);
    assert.match(contract, /void audio_set_loop\(/);
    assert.match(pal, /AudioParamName::PlaybackRate: return "playbackRate"/);
    assert.match(
        pal,
        /sampled->start\(static_cast<float>\(when\), loop \? -1 : 0\);/,
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

test("does not idle either GPU backend for runtime scene topology updates", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(
        sdl,
        /scene\.mesh_membership_version !=[\s\S]{0,300}SDL releases GPU resources only when pending command/,
    );
    assert.doesNotMatch(sdl, /SDL_WaitForGPUIdle topology update/);
    assert.match(
        dawn,
        /std::vector<DawnMesh> updated_meshes =[\s\S]{0,1200}rematch_render_meshes\([\s\S]{0,1200}rebuild_task_draw_lists\(\);/,
    );
    assert.doesNotMatch(dawn, /wgpuQueueOnSubmittedWorkDone/);
});

test("instrumented draw census follows the submitted screenshot frame", () => {
    const capture = source("src/capture-instrumented.ts");

    assert.match(capture, /const bundleDraws = \{\}/);
    assert.match(capture, /let submittedPassDraws = \{\}/);
    assert.match(
        capture,
        /GPUQueue\.prototype\.submit = function[\s\S]{0,500}window\.__draws = \{ \.\.\.bundleDraws, \.\.\.submittedPassDraws \}/,
    );
    assert.doesNotMatch(
        capture,
        /window\.__draws\[key\] = \(window\.__draws\[key\]/,
    );
});

test("keeps dynamic shader geometry local and transforms it per draw", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");
    const capture = source("native/src/pal_render_capture.hpp");

    assert.match(shared, /inline std::vector<GpuVertex> local_vertices\(/);
    assert.match(shared, /rematch_render_meshes\(/);
    assert.match(shared, /inline std::array<float, 16> shader_draw_world\(/);
    assert.match(
        shared,
        /inline std::array<float, 16> shader_world_view_projection\(/,
    );
    assert.match(
        shared,
        /case upstream::ShaderSystemMatrix::world_view_projection:[\s\S]{0,180}return false;/,
    );

    for (const backend of [sdl, dawn]) {
        assert.match(
            backend,
            /shader_material\s*\?\s*local_vertices\(engine, geometry\)/,
        );
        assert.match(backend, /shared_shader_geometries/);
        assert.match(backend, /shared_geometry->users/);
        assert.match(backend, /prune_shared_shader_geometries/);
        assert.match(backend, /shared_shader_material_textures/);
        assert.match(backend, /shared_shader_textures->users/);
        assert.match(backend, /prune_shared_shader_material_textures/);
        assert.match(backend, /shader_draw_world\(/);
        assert.match(backend, /shader_world_view_projection\(/);
        assert.match(
            backend,
            /item\.material_kind ==\s*upstream::RenderMaterialKind::shader[\s\S]{0,300}transform_version = mesh\.transform_version;[\s\S]{0,80}continue;/,
        );
    }
    assert.match(capture, /shader_draw_world\(\s*engine,\s*engine\.meshes\[/);
    assert.match(capture, /shader_world_view\(\s*pass_matrices\.view/);
    assert.match(
        capture,
        /shader_stage_block_floats\(\s*block, shader_pass_matrices, material\)/,
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
        physics,
        /void mark_physics_gpu_world[\s\S]*?record\.gpu_world_transform = true;[\s\S]*?mark_physics_gpu_world\(engine, child\);/,
    );
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
    assert.match(
        bullet,
        /applyImpulse\([\s\S]{0,100}clamp_body_velocity/,
    );
    assert.match(
        bullet,
        /stabilize_contacting_bodies[\s\S]{0,4500}ISLAND_SLEEPING/,
    );
});

test("releases Dawn mesh dependents before their owned resources", () => {
    const dawn = source("native/src/pal_dawn.cpp");
    const releaseMesh = dawn.slice(
        dawn.indexOf("    void release_mesh(DawnMesh& mesh)"),
        dawn.indexOf("    void release_meshes()"),
    );
    const bindingRelease = releaseMesh.indexOf(
        "wgpuBindGroupRelease(binding.textures)",
    );
    const drawStateRelease = releaseMesh.indexOf(
        "release_dawn_draw_states(mesh.pinned_states)",
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

test("captures splat renderables beside the render-plan draw lists", () => {
    const capture = source("native/src/pal_render_capture.hpp");
    assert.match(capture, /write_splat_draw_list/);
    assert.match(capture, /for \(const SplatMeshHandle handle : scene\.splat_meshes\)/);
    assert.match(capture, /upstream::write_splat_uniforms\(/);
    assert.match(capture, /json\.field\("indexCount", 6u\)/);
    assert.match(capture, /json\.field\("instanceCount", splat\.vertex_count\)/);
    // The frame's view and projection are built once by the caller and
    // handed over, because the pin's splat UBO stores them separately and
    // three consumers read the same pair.
    assert.match(
        capture,
        /write_splat_draw_list\(\s*json, scene, engine, frame_view, frame_projection, width, height\)/,
    );
});
