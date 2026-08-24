import assert from "node:assert/strict";
import {
    readFileSync,
    readdirSync,
} from "node:fs";
import test from "node:test";

function source(path: string): string {
    return readFileSync(path, "utf8");
}

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
        5,
    );
    assert.equal(
        (compiler.match(/readProperty\(/g) ?? []).length,
        2,
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

test("captures splat renderables beside the render-plan draw lists", () => {
    const capture = source("native/src/pal_render_capture.hpp");
    assert.match(capture, /write_splat_draw_list/);
    assert.match(capture, /for \(const SplatMeshHandle handle : scene\.splat_meshes\)/);
    assert.match(capture, /upstream::write_splat_uniforms\(/);
    assert.match(capture, /json\.field\("indexCount", 6u\)/);
    assert.match(capture, /json\.field\("instanceCount", splat\.vertex_count\)/);
    assert.match(
        capture,
        /write_splat_draw_list\(json, scene, engine, camera, width, height\)/,
    );
});
