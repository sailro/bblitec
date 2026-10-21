import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { declarationOwners, sourceFacts, sourcePaths } from "./source-facts.js";

test("resolves renamed imports through semantic symbols", () => {
    const body = (create: string, scene: string): string =>
        "async function main() { const engine = await " +
        create +
        "({}); const scene = " +
        scene +
        "(engine); }";
    const direct = compileSource(
        'import {createEngine, createSceneContext} from "@babylonjs/lite"; ' +
            body("createEngine", "createSceneContext"),
    );
    const renamed = compileSource(
        'import {createEngine as boot, createSceneContext as world} from "@babylonjs/lite"; ' +
            body("boot", "world"),
    );
    assert.equal(renamed.cpp, direct.cpp);
    assert.deepEqual(renamed.manifest, direct.manifest);
});

test("centralizes default-library identity and AST-driven upstream contracts", () => {
    const compilerPaths = sourcePaths.filter(
        (path) =>
            path === "src/compiler.ts" || path.startsWith("src/compiler/"),
    );
    assert.deepEqual(
        compilerPaths.filter((path) =>
            sourceFacts(path).members.has("hasNoDefaultLib"),
        ),
        ["src/compiler/symbols.ts"],
    );
    assert.deepEqual(
        compilerPaths.filter((path) =>
            sourceFacts(path).members.has("isSourceFileDefaultLibrary"),
        ),
        [],
    );
    const lowerers = sourcePaths.filter(
        (path) =>
            path === "src/upstream-source.ts" ||
            path.startsWith("src/lowering/gltf/") ||
            path.startsWith("src/lowering/factory/") ||
            (path.startsWith("src/lowering/") &&
                path.endsWith("-lowerer.ts") &&
                !path.endsWith("/renderer-lowerer.ts")),
    );
    for (const path of lowerers) {
        const facts = sourceFacts(path);
        assert.ok(
            ![...facts.calls].some(
                (name) =>
                    name === "store.getSource" ||
                    name.endsWith(".store.getSource"),
            ),
            path,
        );
        assert.ok(!facts.members.has("match"), path);
        assert.ok(
            !facts.calls.has("extractNumber") &&
                !facts.constructs.has("RegExp"),
            path,
        );
    }
    assert.ok(
        sourceFacts("src/lowering/renderer-lowerer.ts").members.has(
            "getSource",
        ),
    );
});

test("reads checker symbols through the named readers in symbols.ts alone", () => {
    // `declaredSymbol` (a name as written: identity, declarations, modules)
    // and `resolvedSymbol`/`aliasTarget` (the declaration a use stands for)
    // make each read say which it is; a raw read anywhere else decides it
    // silently, and differently for an imported name.
    const raw = [
        "getSymbolAtLocation",
        "getAliasedSymbol",
        "getShorthandAssignmentValueSymbol",
    ];
    assert.deepEqual(
        sourcePaths.filter((path) =>
            raw.some((member) => sourceFacts(path).members.has(member)),
        ),
        ["src/compiler/symbols.ts"],
    );
});

test("pinned readers share one lowering context rather than building their own", () => {
    // A `LoweringContext` holds nothing beyond its store: readers over the
    // process's store use `sharedPinnedContext()`, and a lowering over a
    // caller's store `pinnedContextOver(store)`; both live in context.ts.
    assert.deepEqual(
        sourcePaths.filter((path) =>
            sourceFacts(path).constructs.has("LoweringContext"),
        ),
        ["src/lowering/context.ts"],
    );
});

test("entry points acquire the dist lock and only its owner sets the nesting marker", () => {
    for (const path of [
        "src/cli.ts",
        "src/scene-command.ts",
        "src/shipping-demos.ts",
    ]) {
        assert.ok(sourceFacts(path).calls.has("holdDistLock"), path);
    }
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).lockSetter),
        ["src/dist-lock.ts"],
    );
});

test("shared compiler helpers have one declaration owner", () => {
    for (const [name, path] of [
        ["pinnedLibraryRoot", "src/pinned-shader-composer.ts"],
        ["isTrsVectorName", "src/scene-node-transform-descriptor.ts"],
        ["emitHandleCollectionLoop", "src/compiler/handle-collections.ts"],
        ["isRecursiveImportedMeshWalk", "src/compiler/handle-collections.ts"],
        ["propertyRules", "src/compiler/properties.ts"],
        ["StaticEvaluator", "src/compiler/static-evaluator.ts"],
        ["UserFunctionLowerer", "src/compiler/user-functions.ts"],
        ["StatementLowerer", "src/compiler/statements.ts"],
    ])
        assert.deepEqual(declarationOwners(name!), [path], name);
    for (const member of ["readHandleCollection", "nativeLocation"]) {
        const callers = sourcePaths.filter(
            (path) =>
                sourceFacts(path).calls.has(member) ||
                sourceFacts(path).declarations.has(member),
        );
        assert.deepEqual(
            callers.sort(),
            [
                "src/compiler/handle-collections.ts",
                "src/compiler/properties.ts",
            ],
            member,
        );
    }
    assert.ok(
        sourceFacts("src/compiler/statements.ts").imports.has(
            "./handle-collections.js",
        ),
    );
    assert.ok(
        sourceFacts("src/compiler/expressions.ts").members.has("compileFind"),
    );
});

test("the compiler delegates intrinsic families and feature lowering", () => {
    const registry = sourceFacts("src/compiler/intrinsics/registry.ts");
    const imports = new Set(
        [...registry.imports.values()].flatMap((names) => [...names]),
    );
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
        assert.ok(imports.has("compile" + family + "Intrinsic"), family);
    }
    const compiler = sourceFacts("src/compiler.ts");
    assert.ok(compiler.calls.has("compileRegisteredIntrinsic"));
    assert.ok(compiler.calls.has("emitPropertyAssignment"));
    assert.ok(
        sourceFacts("src/compiler/properties.ts").calls.has("readProperty"),
    );
    for (const name of [
        "StaticEvaluator",
        "UserFunctionLowerer",
        "StatementLowerer",
        "PropertyAccessLowerer",
        "IntrinsicOptions",
    ]) {
        assert.ok(compiler.constructs.has(name), name);
    }
    // The option adapters delegate each intrinsic family's options.
    const options = sourceFacts("src/compiler/intrinsic-options.ts");
    for (const module of [
        "intrinsics/mesh-options",
        "intrinsics/engine-options",
        "intrinsics/material-options",
        "intrinsics/asset-options",
        "shader-material",
        "property-animation",
    ])
        assert.ok(options.imports.has("./" + module + ".js"), module);
    for (const module of [
        "option-helpers",
        "adaptations",
        "assets",
        "output-projection",
        "scene-manifest",
        "module-initializers",
        "sprite-atlas-record",
    ])
        assert.ok(compiler.imports.has("./compiler/" + module + ".js"), module);
    assert.ok(
        sourceFacts("src/compiler/assignments.ts").calls.has(
            "cameraRecordField",
        ),
    );
    assert.ok(
        sourceFacts("src/compiler/shader-material.ts").calls.has(
            "lowerWgslShaderProgram",
        ),
    );
    for (const path of ["src/compiler.ts", "src/compiler/shader-material.ts"]) {
        assert.ok(!sourceFacts(path).calls.has("normalizeShaderSource"), path);
    }
});

test("split lowerer barrels contain exports and families own their declarations", () => {
    for (const barrel of [
        "src/lowering/gltf-lowerer.ts",
        "src/lowering/factory-lowerer.ts",
    ]) {
        assert.ok(sourceFacts(barrel).barrel, barrel);
    }
    for (const [name, path] of [
        ["GltfLowerer", "gltf/loader"],
        ["lowerGltfDefaultSampler", "gltf/sampler-mapping"],
        ["lowerAccessorNormalizationCpp", "gltf/accessor-normalization"],
        ["lowerShPrescaleCpp", "gltf/sh-prescale"],
        ["lowerMatrixComposeCpp", "gltf/matrix-leaves"],
        ["lowerRootedWorldCpp", "gltf/matrix-leaves"],
        ["lowerGltfMaterialProperties", "gltf/material-properties"],
        ["lowerGltfFactorBake", "gltf/factor-bake"],
        ["MeshBuilderLowerer", "factory/mesh-builders"],
        ["FactoryLowerer", "factory/material-factories"],
        ["pinnedSampleCounts", "pinned-surface"],
    ])
        assert.deepEqual(
            declarationOwners(name!),
            ["src/lowering/" + path + ".ts"],
            name,
        );
});

test("operand selection is read through syntax.ts", () => {
    // `?:`, `??`, `||`, `&&` and `,` yield one of their operands; syntax.ts
    // says which, and with which values (operandYield, yieldedOperands).
    // A pending file still inspects the operators itself and leaves this
    // list when it migrates; no other file may start.
    const inspects = (path: string): boolean => {
        const facts = sourceFacts(path);
        return (
            [
                "QuestionQuestionToken",
                "BarBarToken",
                "AmpersandAmpersandToken",
                "whenTrue",
                "whenFalse",
            ].some((member) => facts.members.has(member)) ||
            facts.calls.has("ts.isConditionalExpression")
        );
    };
    const pending = [
        "src/compiler.ts",
        "src/compiler/asset-url-domain.ts",
        "src/compiler/assignments.ts",
        "src/compiler/browser-erasure.ts",
        "src/compiler/canvas-instrumentation.ts",
        "src/compiler/classes.ts",
        "src/compiler/compressed-json.ts",
        "src/compiler/conditions.ts",
        "src/compiler/constructed-fields.ts",
        "src/compiler/data-lowering.ts",
        "src/compiler/data-methods.ts",
        "src/compiler/data-sinks/structures.ts",
        "src/compiler/declarations.ts",
        "src/compiler/expressions.ts",
        "src/compiler/handle-collections.ts",
        "src/compiler/intrinsics/asset.ts",
        "src/compiler/intrinsics/engine.ts",
        "src/compiler/intrinsics/material.ts",
        "src/compiler/intrinsics/particle.ts",
        "src/compiler/intrinsics/physics.ts",
        "src/compiler/intrinsics/sprite.ts",
        "src/compiler/material-plugin.ts",
        "src/compiler/option-helpers.ts",
        "src/compiler/parameter-effects.ts",
        "src/compiler/properties.ts",
        "src/compiler/resource-loops.ts",
        "src/compiler/runtime-case-split.ts",
        "src/compiler/statements.ts",
        "src/compiler/static-evaluator.ts",
        "src/compiler/ui-projection.ts",
        "src/lowering/animation-lowerer.ts",
        "src/lowering/animation-property-playback.ts",
        "src/lowering/babylon-camera.ts",
        "src/lowering/babylon-lowerer.ts",
        "src/lowering/babylon-mesh-construction.ts",
        "src/lowering/babylon-node-transforms.ts",
        "src/lowering/babylon-scene-data.ts",
        "src/lowering/babylon-submesh-indices.ts",
        "src/lowering/babylon-submesh-material.ts",
        "src/lowering/babylon-textures.ts",
        "src/lowering/camera-lowerer.ts",
        "src/lowering/character-kernel-lowerer.ts",
        "src/lowering/compressed-texture-lowerer.ts",
        "src/lowering/compute-binding-decl-lowerer.ts",
        "src/lowering/compute-buffer-binding-lowerer.ts",
        "src/lowering/compute-dispatch-descriptor.ts",
        "src/lowering/compute-shader-lowerer.ts",
        "src/lowering/compute-task-execution-lowerer.ts",
        "src/lowering/compute-task-recording.ts",
        "src/lowering/compute-texture-descriptor.ts",
        "src/lowering/compute-texture-lowerer.ts",
        "src/lowering/compute-uniform-arena-lowerer.ts",
        "src/lowering/configurable-camera-controls.ts",
        "src/lowering/context.ts",
        "src/lowering/deformed-vertex.ts",
        "src/lowering/environment-lowerer.ts",
        "src/lowering/factory/material-factories.ts",
        "src/lowering/geometry-output-lowerer.ts",
        "src/lowering/gizmo-lowerer.ts",
        "src/lowering/gltf/accessor-shape.ts",
        "src/lowering/gltf/animation-group-factory.ts",
        "src/lowering/gltf/animation-mask.ts",
        "src/lowering/gltf/animation-node-rest.ts",
        "src/lowering/gltf/animation-playback.ts",
        "src/lowering/gltf/animation-pose.ts",
        "src/lowering/gltf/cpp-expression.ts",
        "src/lowering/gltf/extension-images.ts",
        "src/lowering/gltf/flow-graph-lifecycle.ts",
        "src/lowering/gltf/hierarchy.ts",
        "src/lowering/gltf/loader.ts",
        "src/lowering/gltf/material-assembly.ts",
        "src/lowering/gltf/material-object-lowerer.ts",
        "src/lowering/gltf/material-textures.ts",
        "src/lowering/gltf/parser-json.ts",
        "src/lowering/gltf/shared.ts",
        "src/lowering/gltf/texture-cache.ts",
        "src/lowering/gltf/vat-playback.ts",
        "src/lowering/gltf/weighted-animation-runtime.ts",
        "src/lowering/gltf/weighted-animation-targets.ts",
        "src/lowering/gpu-retirement-lowerer.ts",
        "src/lowering/gpu-task-timing-lowerer.ts",
        "src/lowering/line-lowerer.ts",
        "src/lowering/linear-depth-lowerer.ts",
        "src/lowering/mesh-geometry-access.ts",
        "src/lowering/mesh-geometry-resize.ts",
        "src/lowering/mesh-geometry-updates.ts",
        "src/lowering/navigation-wrappers.ts",
        "src/lowering/particle-sprite-sync.ts",
        "src/lowering/pbr-scene-hooks.ts",
        "src/lowering/physics-constraint-lowerer.ts",
        "src/lowering/physics-container-lowerer.ts",
        "src/lowering/picking-lowerer.ts",
        "src/lowering/pinned-csm.ts",
        "src/lowering/pinned-depth-state.ts",
        "src/lowering/pinned-material-defaults.ts",
        "src/lowering/pinned-numeric-expression.ts",
        "src/lowering/pinned-numeric-lowerer.ts",
        "src/lowering/pinned-operators.ts",
        "src/lowering/pinned-partial-evaluator.ts",
        "src/lowering/pinned-record-literal.ts",
        "src/lowering/pinned-record-lowerer.ts",
        "src/lowering/pinned-surface.ts",
        "src/lowering/pinned-ubo-writer-lowerer.ts",
        "src/lowering/procedural-sky-loader.ts",
        "src/lowering/procedural-sky-update.ts",
        "src/lowering/render-bucket.ts",
        "src/lowering/render-target-lowerer.ts",
        "src/lowering/renderer-lowerer.ts",
        "src/lowering/shader-uniforms.ts",
        "src/lowering/shadow-lowerer.ts",
        "src/lowering/storage-buffer-lowerer.ts",
        "src/lowering/taa-post-process-lowerer.ts",
        "src/pinned-address-modes.ts",
        "src/pinned-mesh-defaults.ts",
        "src/pinned-standard-variants.ts",
        "src/shader-builtins-utility.ts",
    ];
    const inspecting = sourcePaths.filter(inspects);
    assert.deepEqual(
        inspecting.filter(
            (path) =>
                path !== "src/compiler/syntax.ts" && !pending.includes(path),
        ),
        [],
    );
    assert.deepEqual(
        pending.filter((path) => !inspecting.includes(path)),
        [],
    );
});

test("wrapper transparency is decided in syntax.ts", () => {
    // Which of `()`, `as`, `<T>`, `!` and `satisfies` keep a value, its
    // type, or neither is syntax.ts's (unwrapExpression, outermostWrapper,
    // isTypeAssertion, isTypePreservingWrapper, wrappersUnder/Around). The
    // files below test a wrapper kind for its own meaning (`!` asserts
    // presence, `satisfies` keeps the operand's type) or lower that node;
    // no other file may.
    const wrapperTests = [
        "ts.isParenthesizedExpression",
        "ts.isAsExpression",
        "ts.isSatisfiesExpression",
        "ts.isTypeAssertionExpression",
        "ts.isNonNullExpression",
    ];
    const ownMeaning = [
        "src/compiler/data-methods.ts",
        "src/compiler/expressions.ts",
        "src/compiler/home-object-methods.ts",
        "src/compiler/native-inert-calls.ts",
        "src/lowering/compute-shader-gpu-lowerer.ts",
        "src/lowering/gltf/weighted-animation-targets.ts",
        "src/lowering/pinned-numeric-lowerer.ts",
        "src/lowering/pinned-record-lowerer.ts",
        "src/lowering/renderer-lowerer.ts",
    ];
    assert.deepEqual(
        sourcePaths
            .filter(
                (path) =>
                    path !== "src/compiler/syntax.ts" &&
                    wrapperTests.some((call) =>
                        sourceFacts(path).calls.has(call),
                    ),
            )
            .sort(),
        ownMeaning,
    );
});

test("name roles are read through syntax.ts", () => {
    // Whether a name declares (declarationNamed), names a member
    // (namesMember) or reads a binding (isValueReference, referenceSite)
    // is syntax.ts's. The pending files test a shorthand `{ x }`'s value
    // slot by hand; each leaves the list when object literal slots get
    // their owner, and no other file may start.
    assert.deepEqual(
        sourcePaths
            .filter((path) => sourceFacts(path).nameRoleTests > 0)
            .sort(),
        [
            "src/compiler/absence-tag-storage.ts",
            "src/compiler/numeric-slot-storage.ts",
            "src/compiler/parameter-effects.ts",
            "src/compiler/symbols.ts",
            "src/compiler/syntax.ts",
        ],
    );
});

test("property keys are read through one owner per layer", () => {
    // The key a name spells is propertyKey / accessKey / literalKey
    // (syntax.ts), staticPropertyKey / staticAccessKey with the checker
    // (symbols.ts), and Compiler.propertyName at generation. The pinned
    // files test an expression's shape, not a name's key.
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).keyRuleTests > 0).sort(),
        [
            "src/compiler/data-lowering.ts",
            "src/compiler/syntax.ts",
            "src/lowering/pinned-ubo-writer-lowerer.ts",
            "src/unused-exports.ts",
        ],
    );
});

test("destructuring slots and specifier names are read through syntax.ts", () => {
    // What a pattern element reads is patternSlots / bindingElementKey, an
    // array literal element's index arrayLiteralSlots, and a specifier's
    // source-side name specifierSourceName.
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).propertyNameRules > 0),
        ["src/compiler/syntax.ts"],
    );
});

test("object literal members are read through syntax.ts", () => {
    // Which member decides a key is lastWriter / objectProperty /
    // plainDataMembers (a `__proto__:` setter is no own key). The pending
    // files match pinned upstream shapes by hand; they leave the list with
    // the text-matching unit (L5), and no other file may start.
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).memberScans > 0).sort(),
        [
            "src/gltf-mesh-plan.ts",
            "src/lowering/animation-property-playback.ts",
            "src/lowering/babylon-textures.ts",
            "src/lowering/camera-mutation-lowerer.ts",
            "src/lowering/flow-graph-lowerer.ts",
            "src/lowering/gltf/animation-playback.ts",
            "src/lowering/gltf/animation-pose.ts",
            "src/lowering/light-lowerer.ts",
            "src/lowering/light-parameters.ts",
            "src/lowering/mesh-recovery.ts",
            "src/lowering/node-particle-live-lowerer.ts",
            "src/lowering/physics-event-lowerer.ts",
            "src/lowering/physics-thin-advanced-lowerer.ts",
            "src/lowering/physics-thin-instance-lowerer.ts",
            "src/lowering/pinned-blend-table.ts",
            "src/lowering/pinned-euler-proxy.ts",
            "src/lowering/post-process-lowerer.ts",
            "src/lowering/shadow-enabled.ts",
            "src/lowering/storage-buffer-lowerer.ts",
            "src/lowering/vat-lowerer.ts",
            "src/pinned-standard-variants.ts",
        ],
    );
});

test("equality operators and nullish comparisons have one owner", () => {
    // equalityOperator (syntax.ts) reads `===`/`!==`/`==`/`!=`;
    // nullishLiteral / nullishComparison (symbols.ts) what a test compares
    // against. The pending files lower equality to C++ or match pinned
    // shapes; each leaves with the L4 equality or L5 text-matching unit.
    assert.deepEqual(
        sourcePaths
            .filter((path) => {
                const members = sourceFacts(path).members;
                return (
                    members.has("ExclamationEqualsEqualsToken") ||
                    members.has("ExclamationEqualsToken")
                );
            })
            .sort(),
        [
            "src/compiler/comparisons.ts",
            "src/compiler/compressed-json.ts",
            "src/compiler/intrinsics/material.ts",
            "src/compiler/particle-buffer.ts",
            "src/compiler/syntax.ts",
            "src/lowering/babylon-camera.ts",
            "src/lowering/babylon-material.ts",
            "src/lowering/babylon-mesh-construction.ts",
            "src/lowering/babylon-scene-data.ts",
            "src/lowering/babylon-textures.ts",
            "src/lowering/character-kernel-lowerer.ts",
            "src/lowering/compute-binding-decl-lowerer.ts",
            "src/lowering/gltf/loader.ts",
            "src/lowering/gltf/material-object-lowerer.ts",
            "src/lowering/gltf/material-textures.ts",
            "src/lowering/gltf/sampler-resolver.ts",
            "src/lowering/gltf/texture-cache.ts",
            "src/lowering/mesh-geometry-updates.ts",
            "src/lowering/pinned-csm.ts",
            "src/lowering/pinned-numeric-expression.ts",
            "src/lowering/pinned-numeric-lowerer.ts",
            "src/lowering/pinned-operators.ts",
            "src/lowering/pinned-partial-evaluator.ts",
            "src/lowering/pinned-record-lowerer.ts",
            "src/lowering/pinned-ubo-writer-lowerer.ts",
        ],
    );
});

test("write sites are read through syntax.ts", () => {
    // What a node writes (assignment and pattern leaves, compound, logical,
    // update, delete, loop targets) is writeSites/writeSiteOf. The
    // assignment-operator range belongs to syntax.ts; statements.ts reads
    // it only to class non-assignment operators.
    assert.deepEqual(
        sourcePaths.filter((path) => {
            const facts = sourceFacts(path);
            return (
                facts.members.has("FirstAssignment") ||
                facts.members.has("LastAssignment")
            );
        }),
        ["src/compiler/statements.ts", "src/compiler/syntax.ts"],
    );
    // These still test `delete`, `++` or `--` themselves, to lower those
    // forms or match a pinned shape; each leaves the list as its lowering
    // moves to one owner, and no other file may start.
    const pending = [
        "src/compiler.ts",
        "src/compiler/array-length-growth.ts",
        "src/compiler/bigint-values.ts",
        "src/compiler/data-lowering.ts",
        "src/compiler/integer-loops.ts",
        "src/compiler/node-input-surface.ts",
        "src/compiler/resource-loops.ts",
        "src/compiler/statements.ts",
        "src/compiler/static-evaluator.ts",
        "src/compiler/text-surface.ts",
        "src/lowering/factory/material-factories.ts",
        "src/lowering/gltf/material-object-lowerer.ts",
        "src/lowering/gltf/orm-composition.ts",
        "src/lowering/pbr-transmission-transaction.ts",
        "src/lowering/pinned-numeric-lowerer.ts",
        "src/lowering/pinned-record-lowerer.ts",
        "src/lowering/scene-lowerer.ts",
    ];
    assert.deepEqual(
        sourcePaths
            .filter((path) => {
                const facts = sourceFacts(path);
                return (
                    path !== "src/compiler/syntax.ts" &&
                    (facts.calls.has("ts.isDeleteExpression") ||
                        facts.members.has("PlusPlusToken") ||
                        facts.members.has("MinusMinusToken"))
                );
            })
            .sort(),
        pending,
    );
});
