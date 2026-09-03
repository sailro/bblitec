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

test("stores reached scene-disposal callbacks in the native scene contract", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    assert.match(
        runtime,
        /struct Scene \{[\s\S]{0,5000}std::vector<std::function<void\(\)>> disposables;/,
    );
    assert.match(
        runtime,
        /void on_scene_dispose\(\s*Scene& scene,\s*std::function<void\(\)> callback\);/,
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

test("keeps the lifted-text helpers and pinned operator spellings single-copy", () => {
    // The guarded re-homing loop and the statement formatter live once, in
    // shader-builtins-utility.ts (the callers keep only their own error
    // voices); the glTF expression renderer sources its operator spellings
    // and Math-call matching from pinned-operators.ts instead of restating
    // the tables; assignments.ts spells its TRS discriminator and axis map
    // once. A regrown copy is how these drifted before.
    const files = readdirSync("src", { recursive: true })
        .map((name) => `src/${String(name).replace(/\\/g, "/")}`)
        .filter((path) => path.endsWith(".ts"));
    for (const marker of [
        "function formatStatements",
        "text.split(from).join(to)",
    ]) {
        const owners = files.filter((path) =>
            source(path).includes(marker),
        );
        assert.deepEqual(
            owners,
            ["src/shader-builtins-utility.ts"],
            `'${marker}' must live only in shader-builtins-utility.ts`,
        );
    }
    const interpolation = source(
        "src/lowering/gltf/animation-interpolation.ts",
    );
    assert.match(interpolation, /PINNED_BOOLEAN_OPERATORS\.get\(/);
    assert.match(interpolation, /pinnedMathCall\(/);
    assert.doesNotMatch(interpolation, /text: "&&"/);
    const assignments = source("src/compiler/assignments.ts");
    assert.equal(
        (assignments.match(/\{ x: 0, y: 1, z: 2, w: 3 \}/g) ?? []).length,
        1,
        "the TRS axis map must be spelled once in assignments.ts",
    );
    assert.equal(
        (assignments.match(/"position",\s*"rotation",\s*"rotationQuaternion",\s*"scaling"/g) ?? [])
            .length,
        1,
        "the TRS vector list must be spelled once in assignments.ts",
    );
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
                /DDS environment options support brdfUrl, skipSkybox, and skipGround\./,
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
        /function pinnedSampleCounts\(/,
    );
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

test("keeps depth-hosted sprite buffers growable, paused while hidden, and insertion ordered", () => {
    const sdl = source("native/src/pal_sdl_gpu_sprite.hpp");
    const dawn = source("native/src/pal_dawn_sprite.hpp");
    const runtime = source("native/include/bblite/runtime.hpp");
    const lowerer = source("src/lowering/sprite-lowerer.ts");
    const section = (text: string, start: string, end: string): string => {
        const from = text.indexOf(start);
        const to = text.indexOf(end, from + start.length);
        assert.notEqual(from, -1, `Missing ${start}`);
        assert.notEqual(to, -1, `Missing ${end}`);
        return text.slice(from, to);
    };

    const sdlUpload = section(
        sdl,
        "inline void upload_sprite_layer_gpu(",
        "inline void upload_sprite_pass(",
    );
    const dawnUpload = section(
        dawn,
        "inline void upload_dawn_sprite_layer(",
        "inline void upload_dawn_sprite_pass(",
    );
    for (const upload of [sdlUpload, dawnUpload]) {
        assert.match(
            upload,
            /if \(!layer\.visible \|\| layer\.count == 0\) return;[\s\S]*needed_bytes/,
        );
        assert.match(upload, /instance_buffer_bytes < needed_bytes/);
        assert.match(upload, /instance_buffer_bytes = needed_bytes/);
        assert.match(upload, /gpu\.uploaded = false/);
        assert.ok(
            upload.indexOf("if (!layer.visible || layer.count == 0) return;") <
                upload.indexOf("gpu.elapsed_ms += delta_ms"),
        );
    }
    assert.match(sdlUpload, /SDL_ReleaseGPUBuffer\(device, gpu\.instances\)/);
    assert.match(dawnUpload, /wgpuBufferRelease\(gpu\.instances\)/);
    assert.match(
        runtime,
        /dirty_sprite_begin = invalid_handle;[\s\S]{0,160}dirty_sprite_end = 0;[\s\S]{0,800}pipeline_version = 0;/,
    );
    assert.match(
        lowerer,
        /touch_sprite_instances\([\s\S]{0,320}layer\.dirty_sprite_begin = std::min/,
    );
    assert.equal(
        lowerer.match(
            /SpriteRenderer requires layers with depth == none\./g,
        )?.length,
        2,
    );
    assert.match(
        sdlUpload,
        /dirty_begin[\s\S]{0,900}buffer_uploads\.update\(\s*gpu\.instances,\s*offset,\s*data,\s*bytes\)/,
    );
    assert.match(
        dawnUpload,
        /dirty_begin[\s\S]{0,700}wgpuQueueWriteBuffer\([\s\S]{0,180}static_cast<std::uint64_t>\(dirty_begin\) \* stride_bytes/,
    );

    // Fixed/layout mutations rebuild before the next upload, and atlas GPU
    // resources are owned once by the pass rather than once per layer.
    assert.match(
        sdl,
        /gpu\.pipeline_version == layer\.pipeline_version[\s\S]{0,320}rebuild_sprite_layer_pipeline\(/,
    );
    assert.match(
        dawn,
        /sync_dawn_scene_sprite_pass_pipelines\([\s\S]{0,900}pipeline_version != layer\.pipeline_version[\s\S]{0,1200}release_dawn_sprite_layer\([\s\S]{0,1400}build_dawn_sprite_layer\(/,
    );
    assert.match(sdl, /struct SpriteAtlasGpu/);
    assert.match(sdl, /std::vector<SpriteAtlasGpu> atlases;/);
    assert.match(
        sdl,
        /renderer\.layers\.begin\(\)[\s\S]{0,420}release_sprite_atlas_gpu\(device, \*atlas\);[\s\S]{0,120}pass\.atlases\.erase\(atlas\)/,
    );
    assert.match(dawn, /struct DawnSpriteAtlasBinding/);
    assert.match(dawn, /std::vector<DawnSpriteAtlasBinding> atlases;/);

    const sdlRecord = section(
        sdl,
        "inline void record_scene_sprite_pass(",
        "inline void release_scene_sprite_pass(",
    );
    const dawnRecord = section(
        dawn,
        "inline void record_dawn_scene_sprite_pass(",
        "inline void release_dawn_scene_sprite_pass(",
    );
    for (const record of [sdlRecord, dawnRecord]) {
        assert.match(
            record,
            /for \(std::size_t index = 0; index < pass\.handles\.size\(\); \+\+index\)/,
        );
        assert.doesNotMatch(
            record,
            /stable_sort|engine\.sprite_layers\[[^\]]+\]\.order/,
        );
    }
});

test("shares compatible depth-hosted sprite pipelines within a scene pass", () => {
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu_sprite.hpp");
    const dawn = source("native/src/pal_dawn_sprite.hpp");

    assert.match(shared, /sprite_scene_pipeline_compatible\(/);
    assert.match(
        shared,
        /left_plan\.has_depth == right_plan\.has_depth[\s\S]{0,260}left_plan\.depth_write == right_plan\.depth_write[\s\S]{0,260}left_plan\.alpha_to_coverage == right_plan\.alpha_to_coverage[\s\S]{0,260}custom_shader == right\.custom_shader/,
    );
    assert.match(
        shared,
        /left_plan\.instance_stride_bytes ==\s*right_plan\.instance_stride_bytes/,
    );
    assert.match(sdl, /shared_pipeline = pass\.layers\[previous\]\.pipeline/);
    assert.match(sdl, /gpu\.owns_pipeline = shared_pipeline == nullptr/);
    assert.match(
        dawn,
        /shared_pipeline = pass\.layers\[previous\]\.pipeline/,
    );
    assert.match(
        dawn,
        /shared_group_layouts = pass\.layers\[previous\]\.group_layouts/,
    );
    assert.match(dawn, /gpu\.owns_pipeline = shared_pipeline == nullptr/);
    assert.match(dawn, /gpu\.owns_group_layouts = shared_pipeline == nullptr/);
    assert.match(
        dawn,
        /pass\.layers\.rbegin\(\)[\s\S]{0,180}release_dawn_sprite_layer\(\*layer\)/,
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
        assert.match(
            backend,
            /RenderStage::transparent:[\s\S]{0,180}draw_render_list\([\s\S]{0,80}render_plan\.draw_lists\.transparent\);[\s\S]{0,520}Sprite2DDepthMode::test/,
        );
    }
});

test("keeps scene-less sprite render targets and renderer registration live", () => {
    const sdl = source("native/src/pal_sdl_gpu_sprite.cpp");
    const dawn = source("native/src/pal_dawn_sprite.cpp");

    for (const backend of [sdl, dawn]) {
        assert.match(backend, /poll_platform_events\(/);
        assert.match(
            backend,
            /input_replay\.dispatch\(frame, [^,]+, engine\);/,
        );
        assert.match(backend, /const auto sync_render_textures = \[&\]\(\)/);
        assert.match(backend, /const auto sync_renderer_passes = \[&\]\(\)/);
        assert.match(
            backend,
            /advance_frame\([\s\S]{0,420}sync_render_textures\(\);\s*sync_renderer_passes\(\);/,
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

test("gates the scene-less offscreen readback arm on a requested capture", () => {
    const sdlSprite = source("native/src/pal_sdl_gpu_sprite.cpp");
    const sdlEffect = source("native/src/pal_sdl_gpu_effect.cpp");
    const dawnSprite = source("native/src/pal_dawn_sprite.cpp");
    const dawnEffect = source("native/src/pal_dawn_effect.cpp");

    // A swapchain texture cannot be read back, so a capture run renders
    // offscreen and blits; a run without a capture draws straight into
    // the swapchain and never pays for the readback texture or the blit.
    for (const driver of [sdlSprite, sdlEffect]) {
        assert.match(
            driver,
            /const bool capture_run = captures\.requested\(\);/,
        );
        assert.match(
            driver,
            /if \(capture_run\) \{\s*SDL_GPUBlitInfo blit\{\};/,
        );
    }
    assert.match(
        sdlSprite,
        /capture_run &&\s*\(color_width != width \|\| color_height != height\)/,
    );
    assert.match(
        sdlSprite,
        /SDL_GPUTexture\* target = capture_run \? color : swapchain;/,
    );
    assert.match(
        sdlEffect,
        /capture_run \? resolve : swapchain;/,
    );
    // The multisampled arm resolves into the frame's destination, which
    // is the swapchain itself on a live run -- the pin's own arm.
    assert.match(
        sdlEffect,
        /color_target\.resolve_texture = destination;/,
    );
    // The Dawn drivers never had the offscreen arm: they render into the
    // surface view and copy the surface texture out for a capture.
    assert.match(dawnSprite, /WGPUTextureView target_view = surface_view;/);
    assert.match(
        dawnEffect,
        /color_attachment\.view = samples > 1 \? msaa_view : surface_view;/,
    );
    for (const driver of [dawnSprite, dawnEffect]) {
        assert.match(driver, /begin_dawn_surface_capture\(/);
    }
});

test("batches the scene-less sprite driver's dirty-span uploads", () => {
    const driver = source("native/src/pal_sdl_gpu_sprite.cpp");
    const shared = source("native/src/pal_sdl_gpu_shared.hpp");
    const sprite = source("native/src/pal_sdl_gpu_sprite.hpp");

    // One run-lifetime batch: dirty spans stage into one copy pass and
    // one submit per frame, not a transfer buffer and submit per layer.
    assert.match(driver, /GpuBufferUploadBatch buffer_uploads\(device\);/);
    assert.match(
        driver,
        /upload_sprite_pass\(\s*device, engine, pass, delta_ms, buffer_uploads\);[\s\S]{0,80}buffer_uploads\.submit\(\);/,
    );
    // The batch's transfer buffer persists across submits (cycled on
    // map, released by the destructor), so a per-frame writer stops
    // paying a create/release per frame.
    assert.match(shared, /~GpuBufferUploadBatch\(\)/);
    assert.match(
        shared,
        /SDL_MapGPUTransferBuffer\(device_, transfer_, true\)/,
    );
    // Every caller stages into a run-lifetime batch: the parameter is a
    // reference, so a batch-less one-shot arm cannot quietly come back.
    assert.doesNotMatch(sprite, /GpuBufferUploadBatch immediate\(/);
    assert.doesNotMatch(sprite, /GpuBufferUploadBatch\*/);
});

test("projects offscreen sprite passes against the canvas extent", () => {
    const sdlScene = source("native/src/pal_sdl_gpu.cpp");
    const sdlSprite = source("native/src/pal_sdl_gpu_sprite.cpp");
    const dawnScene = source("native/src/pal_dawn.cpp");
    const dawnSprite = source("native/src/pal_dawn_sprite.cpp");

    for (const backend of [sdlScene, sdlSprite]) {
        assert.match(
            backend,
            /record_sprite_pass\([\s\S]{0,180}\bwidth,\s*height\);/,
        );
        assert.doesNotMatch(
            backend,
            /target_record\s*\?\s*target_record->(?:width|height)/,
        );
    }
    for (const backend of [dawnScene, dawnSprite]) {
        assert.match(
            backend,
            /upload_dawn_sprite_pass\([\s\S]{0,180}\bwidth,\s*height,\s*delta_ms\);/,
        );
        assert.doesNotMatch(
            backend,
            /target_record\s*\?\s*target_record->(?:width|height)/,
        );
    }
});

test("binds compacted sprite textures by shader resource name", () => {
    const shared = source("native/src/pal_sdl_gpu_shared.hpp");
    const sprite = source("native/src/pal_sdl_gpu_sprite.hpp");
    const billboard = source("native/src/pal_sdl_gpu_billboard.hpp");
    const intrinsics = source("src/compiler/intrinsics/sprite.ts");

    assert.match(shared, /select_sprite_fragment_textures\(/);
    assert.match(shared, /resource == name \+ "Tex"/);
    assert.match(shared, /for \(const std::string& resource : slots\.textures\)/);
    assert.match(intrinsics, /spriteCustomTextureNames: extraNames/);
    for (const backend of [sprite, billboard]) {
        assert.match(
            backend,
            /bound_textures = select_sprite_fragment_textures\(/,
        );
        assert.match(
            backend,
            /SDL_BindGPUFragmentSamplers\([\s\S]{0,140}bound_textures\.data\(\)/,
        );
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
        3,
        "the helper definition plus replay and live-event calls stay in sync",
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
    // dispatch, the per-event dispatched hook, and one canvas-cursor
    // refresh after a drain that dispatched anything — so a loop using
    // it cannot hold a partial copy of that contract (the cursor arm was
    // once per-driver, and one driver forgot it).
    assert.match(
        events,
        /inline void poll_platform_events\([\s\S]{0,320}SDL_PollEvent\(&event\)[\s\S]{0,160}SDL_EVENT_QUIT \|\|[\s\S]{0,100}SDL_EVENT_WINDOW_CLOSE_REQUESTED[\s\S]{0,100}running = false;[\s\S]{0,180}is_platform_input_event\(event\)[\s\S]{0,260}handle_platform_event\(event, engine\);\s*any_dispatched = true;\s*dispatched\(event\);\s*\}\s*if \(any_dispatched\) apply_canvas_cursor\(engine\);/,
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
            /camera_pointer_hook = \[&\]\(const SDL_Event& event\) \{[\s\S]{0,120}handle_camera_pointer_event\(event, camera, pointer_state\);/,
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

test("removeFromScene returns a retired mesh's geometry bytes", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    const scene = source("src/lowering/scene-lowerer.ts");
    // The release must swap, not assign: `= {}` keeps the capacity.
    assert.match(runtime, /std::vector<T>\(\)\.swap\(/);
    // Every vector member of ModelGeometry is released, read off the struct
    // itself so a new array cannot be retired without being freed.
    const struct = /struct ModelGeometry \{([\s\S]*?)\n\};/.exec(runtime);
    assert.ok(struct);
    const members = [...struct[1]!.matchAll(/std::vector<[^;]*> (\w+);/g)].map(
        (match) => match[1],
    );
    assert.ok(members.length >= 6);
    for (const member of members) {
        assert.match(
            runtime,
            new RegExp(`release_storage\\(geometry\\.${member}\\);`),
        );
    }
    assert.match(scene, /release_geometry_storage\(shared\);/);
    assert.doesNotMatch(scene, /\b\w+\.\w+ = \{\};\s*\n\s*\w+\.\w+ = \{\};/);
    // Sharing is counted where it is created (an imported-root clone), so
    // a removal does not scan every mesh record the engine ever made, and
    // a removed record is retired before its share is released, so a
    // remove/add/remove cycle cannot release a sharer's geometry twice.
    assert.match(scene, /\+\+engine\.geometries\[[^\]]+\]\.owners;/);
    assert.match(scene, /record\.retired = true;[\s\S]{0,200}--shared\.owners;/);
    assert.match(scene, /meshes\[mesh\.value\]\.retired\)/);
    assert.match(scene, /reclaim_unshared_geometry\(\*scene\.engine, mesh\);/);
});

test("routes voxel save and load through the host file-dialog PAL", () => {
    const compiler = source("src/compiler.ts");
    const runtime = source("native/include/bblite/js_voxel_file.hpp");
    const data = source("native/include/bblite/js_data.hpp");
    const projection = source("src/compiler/output-projection.ts");
    const palHeader = source("native/include/bblite/pal.hpp");
    const pal = source("native/src/pal_file.cpp");
    const cmake = source("native/CMakeLists.txt");

    assert.match(
        compiler,
        /save_voxel_world\(\$\{this\.requireDefaultEngine\(call\)\}/,
    );
    assert.match(
        compiler,
        /load_voxel_world<\$\{this\.dataTypes\.cppType\(stored\)\}>[\s\S]{0,100}this\.requireDefaultEngine\(call\)/,
    );
    // The boundary travels only with the scene that reaches it: the
    // plain-data header every scene includes carries no file or stream
    // headers for it.
    assert.match(projection, /voxelFileStorageReached[\s\S]{0,120}js_voxel_file\.hpp/);
    assert.doesNotMatch(data, /<filesystem>|<fstream>|save_voxel_world/);
    assert.match(runtime, /pal::choose_save_file\(/);
    assert.match(runtime, /pal::choose_open_file\(/);
    assert.match(runtime, /world\.voxelsave\.json/);
    assert.match(runtime, /pal::write_selected_file_atomically\(\*path, text\)/);
    assert.match(runtime, /std::string text\(file->bytes\.begin\(\), file->bytes\.end\(\)\)/);
    assert.doesNotMatch(runtime, /<filesystem>|<fstream>/);
    // Numbers are spelled by the one formatter every string coercion shares.
    assert.match(runtime, /NumberPart\(/);
    assert.doesNotMatch(runtime, /setprecision/);
    assert.match(palHeader, /struct FileDialogOptions/);
    assert.match(palHeader, /struct SelectedFileSnapshot/);
    assert.doesNotMatch(palHeader, /read_selected_file_text/);
    assert.match(pal, /SDL_ShowFileDialogWithProperties/);
    assert.match(pal, /SDL_FILEDIALOG_SAVEFILE/);
    assert.match(pal, /SDL_FILEDIALOG_OPENFILE/);
    // Leaving pointer lock for the dialog is the one transition every
    // other release takes.
    assert.match(
        pal,
        /release_pointer_lock_for_dialog\(Engine& engine\) \{[\s\S]{0,300}sync_pointer_lock\(window, engine\);/,
    );
    assert.match(pal, /BBLITE_FILE_DIALOG_SAVE_PATH/);
    assert.match(pal, /BBLITE_FILE_DIALOG_OPEN_PATH/);
    assert.match(pal, /SDL_PumpEvents\(\)/);
    assert.doesNotMatch(pal, /SDL_PollEvent|_WIN32|GetOpenFileName/);
    assert.match(
        cmake,
        /"browser:file" IN_LIST BBLITE_RUNTIME_FEATURES[\s\S]{0,120}BBLITE_HAS_BROWSER_FILE=1/,
    );
    assert.doesNotMatch(cmake, /comdlg32/);
});

test("keeps the JSON bridge and Web Storage generic and PAL-owned", () => {
    const bridge = source("src/compiler/json-bridge.ts");
    const storage = source("src/compiler/web-storage.ts");
    const runtime = source("native/include/bblite/js_json.hpp");
    const shim = source("native/include/bblite/js_storage.hpp");
    const data = source("native/include/bblite/js_data.hpp");
    const registry = source("src/compiler/data-types.ts");
    const pal = source("native/src/pal_storage.cpp");
    const fileIo = source("native/src/pal_file_io.hpp");

    // Both are recognized by the global the call reaches, not by a module
    // path, a scene name, or a function name a scene happens to declare.
    assert.doesNotMatch(bridge, /sandblox|world-io|demos\//i);
    assert.doesNotMatch(storage, /sandblox|world-io|demos\//i);
    assert.match(bridge, /isDefaultLibraryIdentifier/);
    assert.match(storage, /isDefaultLibraryIdentifier/);

    // Codecs are emitted for the records a stringify reaches and no others,
    // and a self-referential record refuses rather than recursing.
    assert.match(registry, /jsonSerializedStructs/);
    assert.match(registry, /reaches a cycle/);
    assert.match(
        registry,
        /renderJsonCodecs\(used\.structs\)/,
    );

    // The plain-data header every scene includes carries no parser.
    assert.doesNotMatch(data, /nlohmann|json_stringify|JsonWriter/);
    // The scene-facing storage header names no OS API.
    assert.doesNotMatch(shim, /filesystem|fstream|SDL_/);
    // The PAL owns the path and encodes the key so nothing can traverse.
    assert.match(pal, /SDL_GetPrefPath\(/);
    assert.match(pal, /encode_key\(/);
    assert.match(pal, /detail::write_file_atomically/);
    assert.match(fileIo, /MoveFileExW|std::filesystem::rename/);
    // Numbers are spelled by the one formatter every string coercion shares.
    assert.match(runtime, /format_number\(value, buffer\)/);
    assert.doesNotMatch(runtime, /setprecision/);
});

test("keeps image decoding available to standalone effect renderers", () => {
    const platform = source("native/src/pal_sdl.cpp");
    const decoderGuard =
        /#if BBLITE_HAS_PBR_RENDERER \|\| BBLITE_HAS_SPRITE_RENDERER \|\| \\\s+BBLITE_HAS_EFFECT_RENDERER/;

    assert.equal(platform.match(new RegExp(decoderGuard, "g"))?.length, 3);
    assert.match(platform, /pal::DecodedImage pal::decode_image/);
});

test("shares large texture payloads and preserves tuple reference identity", () => {
    const runtime = source("native/include/bblite/runtime.hpp");
    const data = source("native/include/bblite/js_data.hpp");
    const materials = source("src/lowering/factory/material-factories.ts");

    assert.match(runtime, /class SharedTextureBytes/);
    assert.match(runtime, /std::shared_ptr<Storage> storage_/);
    assert.match(runtime, /storage_\.use_count\(\) != 1/);
    assert.match(runtime, /struct TextureData \{\s*SharedTextureBytes bytes;/);
    assert.match(runtime, /struct PixelsTexture \{[\s\S]{0,300}SharedTextureBytes rgba;/);
    assert.match(materials, /normalized\.data\.bytes = texture\.rgba;/);

    assert.match(data, /class Tuple \{/);
    assert.match(data, /std::shared_ptr<Storage> values_/);
    assert.match(data, /inline Tuple<N> clone_tuple/);
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
    const pal = source("native/src/pal.cpp");
    const shared = source("native/src/pal_gpu_shared.hpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(runtime, /post_render_animation_frame_callbacks/);
    assert.match(
        runtime,
        /std::vector<std::function<void\(double\)>> animation_frame_callbacks/,
    );
    assert.match(runtime, /animation_frame_once_callbacks/);
    assert.match(runtime, /double animation_frame_timestamp_ms = 0\.0;/);
    assert.match(
        shared,
        /inline void run_animation_frame_callbacks\(Engine& engine\)/,
    );
    assert.match(
        shared,
        /std::move\(engine\.animation_frame_once_callbacks\)/,
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
    assert.match(runtime, /std::uint32_t pending_start_continuations = 0;/);
    assert.match(
        pal,
        /void defer_start_continuation[\s\S]{0,300}\+\+engine\.pending_start_continuations;[\s\S]{0,400}--engine\.pending_start_continuations;/,
    );
    assert.match(
        shared,
        /drains_resolved\(\) const[\s\S]{0,600}pending_start_continuations != 0\) return false;/,
    );
    assert.equal(
        (dawn.match(/captures\.drains_resolved\(\)/g) ?? []).length,
        1,
    );
    assert.match(
        dawn,
        /const bool capture_frame =\s*capture_ready &&\s*!captures\.screenshot_saved/,
    );
    for (const backend of [sdl, dawn]) {
        assert.match(backend, /finish_frame\(engine\);[\s\S]{0,220}\+\+frame/);
    }
});

test("parks a re-queued continuation for the next frame's drain", () => {
    const pal = source("native/src/pal.cpp");
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    // The queue is moved out before draining, so a nested
    // `defer_start_continuation` queued DURING a drain -- the emitted form
    // of a frame yield inside the hoisted continuation -- runs at the next
    // frame's boundary rather than in the same one. This is the boundary
    // that makes `firstSortReady` plus one yield a real barrier.
    assert.match(
        pal,
        /void run_deferred_callbacks\(Engine& engine\)[\s\S]{0,700}due\.swap\(engine\.deferred_callbacks\);/,
    );

    // Because the barrier is real, each cloud's sort has ONE writer per
    // backend: the frame loop's upload phase, which runs before the drain
    // a pick can arrive on. A second call site inside a pick path would be
    // the compensation this contract deleted growing back.
    assert.equal(
        (sdl.match(/upload_splat_pass\(/g) ?? []).length,
        1,
    );
    assert.equal(
        (dawn.match(/upload_dawn_splat_pass\(/g) ?? []).length,
        1,
    );
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

test("fits one cascade per CSM split", () => {
    const shadows = source("src/lowering/shadow-lowerer.ts");

    // The pin's split is `p = (i + 1) / N` over the cascade index, and each
    // slice runs from the PREVIOUS break to its own -- a body computing
    // `1 / N` alone would fit every cascade to the nearest one.
    assert.match(
        shadows,
        /const double p =\s*static_cast<double>\(index \+ 1\) \/ static_cast<double>\(count\);/,
    );
    assert.match(
        shadows,
        /const double previous_split =\s*cascade == 0 \? 0\.0 : break_distance\[cascade - 1\];/,
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
    assert.match(
        renderer,
        /std::array<double, 16> apply_mesh_outer_transform\([\s\S]{0,2500}mesh\.outer_position\.x/,
    );
});

test("reuploads dynamic thin-instance colors on both GPU backends", () => {
    for (const backend of [
        source("native/src/pal_sdl_gpu.cpp"),
        source("native/src/pal_dawn.cpp"),
    ]) {
        assert.match(
            backend,
            /instance_version !=[\s\S]{0,4600}instance_colors\.data\(\)/,
        );
        assert.match(
            backend,
            /instance_colors\.resize\([\s\S]{0,180}instance_matrices\.size\(\) \* 4[\s\S]{0,80}1\.0f\);/,
        );
    }
});

test("recreates outgrown thin-instance buffers on both GPU backends", () => {
    // `addThinInstance` doubles a full pool, so the buffers a registration
    // sized can be too small a frame later. Both backends ask the shared
    // rule, recreate all three streams at the new capacity, and stamp the
    // new row count -- a partial update into the old buffer would write
    // past its end.
    assert.match(
        source("native/src/pal_gpu_shared.hpp"),
        /inline bool thin_instance_pool_grew\([\s\S]{0,220}instance_matrices\.size\(\) >[\s\S]{0,80}allocated_rows\)/,
    );
    for (const [backend, release, create] of [
        [
            source("native/src/pal_sdl_gpu.cpp"),
            "SDL_ReleaseGPUBuffer",
            "frame_buffer_uploads.upload",
        ],
        [
            source("native/src/pal_dawn.cpp"),
            "wgpuBufferRelease",
            "create_buffer",
        ],
    ] as const) {
        assert.match(
            backend,
            new RegExp(
                `const bool recreated =[\\s\\S]{0,200}thin_instance_pool_grew\\(`,
            ),
        );
        // Matrices, the PBR mirror-conjugated copy and the colour lane are
        // all released and rebuilt, in that order, inside the same branch.
        // Ordered by position rather than by a character budget, because
        // the branch's prose is not part of its contract.
        const branch = backend.indexOf("if (recreated) {");
        assert.ok(branch >= 0, "no capacity-recreation branch");
        let cursor = branch;
        for (const marker of [
            `${release}(`,
            `${create}(`,
            "pinned_instances",
            "instance_colors",
            "instance_capacity =",
        ]) {
            const at = backend.indexOf(marker, cursor);
            assert.ok(
                at > cursor,
                `the recreation branch does not reach '${marker}' in order`,
            );
            cursor = at;
        }
        // The old handle is captured before the matrix stream is replaced,
        // so the aliasing test the release path makes stays answerable.
        assert.match(
            backend,
            /pinned_instances !=\s*\r?\n?\s*previous_instances/,
        );
        // A recreation is a full upload, so the dirty-range write is not
        // repeated over the same buffer that frame.
        assert.match(backend, /if \(!recreated && active_count > 0\)/);
        // Nothing may cache a buffer handle past the frame that recreated
        // it. Neither backend records render bundles, so every pass --
        // including the shadow and depth tasks encoded after this sync --
        // reads the mesh's live handles and its live instance count.
        assert.doesNotMatch(backend, /RenderBundle/);
        assert.match(backend, /mesh\.instance_count,/);
    }
});

test("shares one relative-index rule across the ranged array builtins", () => {
    const data = source("native/include/bblite/js_data.hpp");
    // `slice`, `fill(value, start, end)` and `copyWithin` resolve every
    // endpoint through ECMA-262's relative-index rule, stated once.
    assert.match(
        data,
        /inline std::size_t relative_index\(\s*\r?\n?\s*std::size_t length,\s*\r?\n?\s*double raw\)/,
    );
    assert.match(
        data,
        /relative_slice_bounds\([\s\S]{0,400}relative_index\(length, begin_value\)[\s\S]{0,400}relative_index\(length, end_value\)/,
    );
    assert.match(
        data,
        /array_fill_range\([\s\S]{0,300}relative_slice_bounds\(/,
    );
    // The spec copies as if through an intermediate list, so an overlapping
    // forward run must not read bytes it has already written.
    assert.match(
        data,
        /array_copy_within\([\s\S]{0,900}std::copy_backward\(/,
    );
    assert.match(
        data,
        /const auto count = std::min\(final - from, values\.size\(\) - to\);/,
    );
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
        /scene\.render_topology_version !=[\s\S]{0,300}SDL releases GPU resources only when pending command/,
    );
    assert.doesNotMatch(sdl, /SDL_WaitForGPUIdle topology update/);
    assert.match(
        dawn,
        /std::vector<DawnMesh> updated_meshes =[\s\S]{0,1200}rematch_render_meshes\([\s\S]{0,1200}rebuild_task_draw_lists\(\);/,
    );
    assert.doesNotMatch(dawn, /wgpuQueueOnSubmittedWorkDone/);
});

test("grows post-start shadow task state on both GPU backends", () => {
    const sdl = source("native/src/pal_sdl_gpu.cpp");
    const dawn = source("native/src/pal_dawn.cpp");

    assert.match(
        sdl,
        /const auto rebuild_task_draw_lists = \[&\] \{\s*task_draw_lists\.resize\(engine\.frame_tasks\.size\(\)\);/,
    );
    assert.match(
        dawn,
        /const auto rebuild_task_draw_lists = \[&\] \{\s*if \(state\.render_tasks\.size\(\) < engine\.frame_tasks\.size\(\)\) \{\s*state\.render_tasks\.resize\(engine\.frame_tasks\.size\(\)\);/,
    );
    assert.match(
        dawn,
        /DawnRenderTask& render_task =[\s\S]{0,120}if \(!render_task\.view_projection\) \{[\s\S]{0,180}WGPUBufferUsage_Uniform/,
    );
});

test("instrumented draw census follows the submitted screenshot frame", () => {
    const capture = source("src/capture-instrumented.ts");

    assert.match(capture, /const bundleDraws = \{\}/);
    assert.match(capture, /let submittedPassDraws = \{\}/);
    assert.match(
        capture,
        /requestAnimationFrame = function[\s\S]{0,220}submittedPassDraws = \{\}/,
    );
    assert.match(capture, /drawIndexedIndirect\(buffer#/);
    assert.match(
        capture,
        /const recordDraw =[\s\S]{0,120}target\[key\] = \(target\[key\] \|\| 0\) \+ 1/,
    );
    assert.match(
        capture,
        /GPUQueue\.prototype\.submit = function[\s\S]{0,180}!insideAnimationFrame[\s\S]{0,220}submittedPassDraws = \{\}/,
    );
});

test("canvas-only capture removes host focus chrome", () => {
    const harness = source("src/browser-harness.ts");
    assert.match(
        harness,
        /hideNonCanvasChrome[\s\S]{0,500}canvas\.style\.outline = "none"/,
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
    // The per-draw world/world-view/world-view-projection lanes are one
    // shared record; both backends and the capture writer construct it
    // instead of composing their own products (capture-equivalence.test.ts
    // carries the full contract).
    assert.match(shared, /struct ShaderDrawMatrices \{/);
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
        assert.match(backend, /ShaderDrawMatrices shader_matrices\(/);
        assert.match(backend, /shader_matrices\.apply\(/);
        assert.match(
            backend,
            /item\.material_kind ==\s*upstream::RenderMaterialKind::shader[\s\S]{0,300}transform_version = mesh\.transform_version;[\s\S]{0,80}continue;/,
        );
    }
    assert.match(
        capture,
        /ShaderDrawMatrices shader_matrices\(\s*engine,\s*engine\.meshes\[/,
    );
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
    assert.match(
        bullet,
        /applyImpulse\([\s\S]{0,100}clamp_body_velocity/,
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
    // The frame's view, projection and camera position are built once by
    // the caller and handed over, because the pin's splat UBO stores them
    // separately and three consumers read the same set.
    assert.match(
        capture,
        /write_splat_draw_list\(\s*json,\s*scene,\s*engine,\s*frame_view,\s*frame_projection,\s*frame_camera_position,\s*width,\s*height\)/,
    );
});
