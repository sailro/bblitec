import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("function kinds and suspension points are read through syntax.ts", () => {
    // functionKind / isAsyncFunction / isGeneratorFunction read `async` and
    // `*`; isSuspensionPoint / containsSuspension what suspends an
    // activation (`await`, `for await`, `yield`). The others rebuild or strip
    // syntax: AST updates pass the tokens through, the browser transpile
    // drops `async` and `await` by span, and compiler.ts lowers `yield*`.
    assert.deepEqual(
        sourcePaths
            .filter((path) => {
                const members = sourceFacts(path).members;
                return (
                    members.has("AsyncKeyword") ||
                    members.has("Async") ||
                    members.has("asteriskToken") ||
                    members.has("awaitModifier")
                );
            })
            .sort(),
        [
            "src/compiler.ts",
            "src/compiler/syntax.ts",
            "src/gltf-animation-bindings.ts",
            "src/gltf-ibl-plan.ts",
            "src/gltf-mesh-plan.ts",
            "src/lowering/babylon-material-maps.ts",
            "src/lowering/pbr-material-groups.ts",
            "src/typescript-transpile.ts",
        ],
    );
});

test("a void result reads as undefined through one rule", () => {
    // readsErasedVoid / undefinedFromVoid (undefined-values.ts): a void
    // annotation alone does not make a result undefined. async.ts proves a
    // reaction's completion and forwards the mark; compiler.ts checks a
    // stored intrinsic callback's.
    assert.deepEqual(
        sourcePaths
            .filter((path) =>
                sourceFacts(path).calls.has("provenUndefinedValue"),
            )
            .sort(),
        ["src/compiler/async.ts", "src/compiler/undefined-values.ts"],
    );
    assert.deepEqual(
        sourcePaths
            .filter((path) =>
                sourceFacts(path).members.has("erasedVoidCompletion"),
            )
            .sort(),
        [
            "src/compiler.ts",
            "src/compiler/async.ts",
            "src/compiler/undefined-values.ts",
        ],
    );
});

test("a type's absent members are read through type-facts.ts", () => {
    // undefinedOnly, isVoid, holdsNoPayload, nullability, presentMembers
    // and isNullable read `void`; symbols.ts compares against a nullish
    // literal.
    assert.deepEqual(
        sourcePaths
            .filter((path) => sourceFacts(path).members.has("Void"))
            .sort(),
        ["src/compiler/symbols.ts", "src/compiler/type-facts.ts"],
    );
});

test("a type's value kinds are read through type-facts.ts", () => {
    // valueKindOf / valueKinds / holdsOnly classify a member once (a branded
    // primitive is its primitive); data-types.ts maps each kind to storage,
    // and symbols.ts sits below type-facts.ts.
    assert.deepEqual(
        sourcePaths
            .filter((path) => {
                const members = sourceFacts(path).members;
                return [
                    "NumberLike",
                    "StringLike",
                    "BooleanLike",
                    "BigIntLike",
                    "ESSymbolLike",
                ].some((flag) => members.has(flag));
            })
            .sort(),
        [
            "src/compiler/data-types.ts",
            "src/compiler/symbols.ts",
            "src/compiler/type-facts.ts",
        ],
    );
});

test("array element types are read through type-facts.ts", () => {
    // arrayElementType (present members' number index) and arrayShape
    // (element, mutable, tuple); data-types.ts maps them to storage, and the
    // other two read a dictionary's string index.
    assert.deepEqual(
        sourcePaths
            .filter((path) =>
                sourceFacts(path).members.has("getIndexTypeOfType"),
            )
            .sort(),
        [
            "src/compiler/data-lowering.ts",
            "src/compiler/data-types.ts",
            "src/compiler/record-components.ts",
            "src/compiler/type-facts.ts",
        ],
    );
});

test("library types are identified through symbols.ts", () => {
    // libraryName: a type's or symbol's name only when the default, DOM or
    // WebGPU library declares it, so a scene's own `File` or `Promise` is
    // never taken for the library one.
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).symbolNameTests > 0),
        [],
    );
});

test("pinned imports and type-only imports have one reader", () => {
    // CompilerSymbols.pinnedExport walks re-exports to the pinned package;
    // moduleImportKind decides a type-only import; syntax.ts reads an
    // export specifier's own type-only flag for a name's role.
    assert.deepEqual(
        sourcePaths
            .filter((path) => sourceFacts(path).members.has("isTypeOnly"))
            .sort(),
        [
            "src/compiler/symbols.ts",
            "src/compiler/syntax.ts",
            "src/module-imports.ts",
        ],
    );
});

test("enum constants are read through symbols.ts", () => {
    // enumMemberConstant reads a member access, computedEnumMember finds the
    // member that needs a run-time enum object; enum-objects.ts lays out an
    // enum object's members and the pinned record model reads const enums.
    assert.deepEqual(
        sourcePaths
            .filter((path) => sourceFacts(path).members.has("getConstantValue"))
            .sort(),
        [
            "src/compiler/enum-objects.ts",
            "src/compiler/symbols.ts",
            "src/lowering/pinned-record-lowerer.ts",
        ],
    );
});

test("jumps bind their targets through syntax.ts", () => {
    // jumpBinding (the language's rule), jumpsTo and labeledBody: a case's
    // final break ends it only when it jumps to that switch.
    for (const name of ["jumpBinding", "jumpsTo", "labeledBody"])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/syntax.ts"],
            name,
        );
});

test("what an expression's evaluation runs is read through syntax.ts", () => {
    // expressionHasEffects (calls, tags, constructions, suspensions, writes
    // and deletes; a nested function is a value) and expressionMayRunCode
    // (plus property reads); symbols.ts names the library number formatters
    // that run nothing of the program's.
    for (const name of [
        "containsEvaluatedCall",
        "expressionHasObservableEvaluation",
        "PURE_NUMBER_FORMATTERS",
    ])
        assert.deepEqual(declarationOwners(name), [], name);
});

test("whether an import runs its module has one reader", () => {
    // isRuntimeImport (module-imports.ts): TypeScript's elision, an import
    // used only as a type does not run its module. The executed graph's
    // package test and the bake's import test read the syntactic kind.
    assert.deepEqual(
        sourcePaths
            .filter((path) => sourceFacts(path).calls.has("moduleImportKind"))
            .sort(),
        [
            "src/compiler/browser-texture-function.ts",
            "src/executed-module-graph.ts",
            "src/module-imports.ts",
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
    // counted-loops.ts reads a loop's step: the counted-loop parser's own form.
    const pending = [
        "src/compiler.ts",
        "src/compiler/bigint-values.ts",
        "src/compiler/counted-loops.ts",
        "src/compiler/data-lowering.ts",
        "src/compiler/node-input-surface.ts",
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

test("a call's target is read through symbols.ts", () => {
    // calledDeclaration names the declaration a call resolves to and
    // calledFunction the authored body it runs (a `const` callee's literal
    // whatever annotates it); syntax.ts owns the function shapes.
    assert.deepEqual(
        sourcePaths.filter(
            (path) => sourceFacts(path).resolvedDeclarationReads > 0,
        ),
        ["src/compiler/symbols.ts"],
    );
    for (const name of ["calledDeclaration", "calledFunction"])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/symbols.ts"],
            name,
        );
    for (const name of [
        "SupportedFunction",
        "isSupportedFunction",
        "isFunctionWithBody",
        "functionOfDeclaration",
    ])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/syntax.ts"],
            name,
        );
    // The rest read a resolved signature's parameters, return type or type
    // arguments; no other file may start.
    assert.deepEqual(
        sourcePaths
            .filter((path) =>
                sourceFacts(path).members.has("getResolvedSignature"),
            )
            .sort(),
        [
            "src/api-usage.ts",
            "src/compiler.ts",
            "src/compiler/data-lowering.ts",
            "src/compiler/deferred-capabilities.ts",
            "src/compiler/intrinsics/physics.ts",
            "src/compiler/intrinsics/splat-stream.ts",
            "src/compiler/symbols.ts",
            "src/compiler/type-arguments.ts",
            "src/compiler/undefined-values.ts",
            "src/compiler/user-functions.ts",
            "src/lowering/pinned-record-lowerer.ts",
        ],
    );
});

test("a variable's keyword is read through syntax.ts", () => {
    // variableKind reads `var` / `let` / `const` (`using` binds like const)
    // off a declaration list, a declaration or a binding element of one;
    // namespace-declarations.ts reads a const enum's modifier.
    assert.deepEqual(
        sourcePaths
            .filter((path) => {
                const facts = sourceFacts(path);
                return (
                    facts.calls.has("ts.getCombinedNodeFlags") ||
                    ["Const", "Let", "BlockScoped", "Using"].some((flag) =>
                        facts.members.has(flag),
                    )
                );
            })
            .sort(),
        ["src/compiler/namespace-declarations.ts", "src/compiler/syntax.ts"],
    );
    assert.deepEqual(declarationOwners("variableKind"), [
        "src/compiler/syntax.ts",
    ]);
});

test("a binding's rebinds are read through binding-rebinds.ts", () => {
    // fileRebinds indexes every write that gives a name a new value, once
    // per file; bindingRebinds and isRebound read it for a binding (its
    // module, or every source for a global).
    for (const name of ["fileRebinds", "bindingRebinds", "isRebound"])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/binding-rebinds.ts"],
            name,
        );
    for (const name of [
        "collectReboundSymbols",
        "reboundSymbolsByFile",
        "writeBinding",
    ])
        assert.deepEqual(declarationOwners(name), [], name);
    // The evaluation order asks the index too, rather than walking its own.
    assert.ok(
        sourceFacts("src/compiler/evaluation-order.ts").calls.has("isRebound"),
    );
});

test("call signatures are read through type-facts.ts", () => {
    // callSignatures names each site's rule for an absent member: "present"
    // reads a value's signatures once present (an optional callback is
    // callable), "exact" gives a nullable type none.
    assert.deepEqual(
        sourcePaths.filter((path) => {
            const facts = sourceFacts(path);
            return (
                facts.members.has("getCallSignatures") ||
                facts.members.has("getSignaturesOfType")
            );
        }),
        ["src/compiler/type-facts.ts"],
    );
});

test("class instances and inheritance are read through type-facts.ts", () => {
    // classInstanceDeclaration: the class a type's instances belong to (not
    // `typeof C`, which shares its symbol); inheritsFrom: a type or anything
    // it extends, with each site's union rule.
    assert.deepEqual(
        sourcePaths.filter((path) =>
            sourceFacts(path).members.has("getBaseTypes"),
        ),
        ["src/compiler/type-facts.ts"],
    );
    for (const name of ["classInstanceDeclaration", "inheritsFrom"])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/type-facts.ts"],
            name,
        );
});

test("a union's members are read through type-facts.ts", () => {
    // unionMembers: a union's members, or the type itself.
    assert.deepEqual(
        sourcePaths.filter((path) => sourceFacts(path).unionMemberRules > 0),
        ["src/compiler/type-facts.ts"],
    );
});

test("what another owner keeps is read through kept-values.ts", () => {
    // literalHeldValues (a literal's values at any depth), keptArguments
    // (a construction, a storing call), callResultCanHoldReceiver (a
    // method's result keeping its receiver) and callResultHoldsArguments (a
    // library result keeping its arguments) serve every scan of what
    // another owner keeps: an object written after its initializer, a
    // callback that shares the bindings it captures.
    for (const name of [
        "literalHeldValues",
        "keptArguments",
        "constructionKeepsArguments",
        "callResultCanHoldReceiver",
        "callResultHoldsArguments",
    ])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/kept-values.ts"],
            name,
        );
});

test("a runtime index reads static storage through runtimeIndexedOwner", () => {
    // Static tables, constant arrays and compile-time tuples materialize
    // under a runtime index in one place, which the plain, guarded and
    // materialized element reads share: a second chain is how `T[i] ?? d`
    // lost its guard while `T[i]` read the table. The other two calls read
    // a constant array whole (for-of, spread). Ratchet: never more.
    const calls = sourcePaths.flatMap((path) =>
        [
            ...readFileSync(path, "utf8").matchAll(
                /this[.]materializeConstantArray[(]/g,
            ),
        ].map(() => path),
    );
    assert.equal(calls.length, 3, calls.join());
    assert.ok(
        calls.every((path) => path === "src/compiler/data-lowering.ts"),
        calls.join(),
    );
});

test("a library call's effect on an argument is read from one table", () => {
    // libraryArgumentEffect owns the language library's writers and readers
    // and the Web IDL rule; every argument-effect question asks it.
    const source = readFileSync("src/compiler/parameter-effects.ts", "utf8");
    for (const table of ["WRITING_LIBRARY_CALLS", "READING_LIBRARY_CALLS"])
        assert.equal(
            [...source.matchAll(new RegExp(`${table}[.]has[(]`, "g"))].length,
            1,
            table,
        );
    assert.deepEqual(declarationOwners("libraryArgumentEffect"), [
        "src/compiler/parameter-effects.ts",
    ]);
});

test("library schedulers are named in schedulers.ts", () => {
    // schedulerOf / cancelledSchedulerOf resolve a callee as a library global
    // (a user method named setTimeout is none). The worker realm's own list
    // names the functions it provides, schedulers among them.
    const lists = sourcePaths.filter((path) => {
        const text = readFileSync(path, "utf8");
        return text.includes('"setTimeout"') && text.includes('"setInterval"');
    });
    assert.deepEqual(lists, [
        "src/compiler/schedulers.ts",
        "src/compiler/workers.ts",
    ]);
});

test("a body's final return is read through loop-control.ts", () => {
    // finalReturn answers "the return a block body ends with" for every
    // inlining, outlining and shape question. The other last-statement reads
    // ask about a switch clause, a try block or a pinned body's shape.
    // Ratchet: never more.
    assert.deepEqual(declarationOwners("finalReturn"), [
        "src/compiler/loop-control.ts",
    ]);
    const reads = sourcePaths.reduce(
        (count, path) =>
            count +
            [...readFileSync(path, "utf8").matchAll(/statements[.]at[(]-1[)]/g)]
                .length,
        0,
    );
    assert.ok(reads <= 28, `statements.at(-1) reads: ${reads}`);
});

test("a counted loop's shape is parsed by counted-loops.ts", () => {
    // countedLoopShape reads `for (let i = start; i < bound; i++)` once; the
    // static unroller, the native integer counter, the bounds-check facts and
    // the length-growth proof each apply only their own policy to it.
    assert.deepEqual(declarationOwners("countedLoopShape"), [
        "src/compiler/counted-loops.ts",
    ]);
    for (const path of [
        "src/compiler/resource-loops.ts",
        "src/compiler/integer-loops.ts",
        "src/compiler/data-lowering.ts",
        "src/compiler/array-length-growth.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("countedLoopShape"), path);
});

test("a Promise static call is recognized by promises.ts", () => {
    // promiseStatic names Promise.all / allSettled / any / race / reject /
    // resolve with the callee resolved as the library global; the immediate
    // and the worker realm each lower the kinds they support.
    assert.deepEqual(declarationOwners("promiseStatic"), [
        "src/compiler/promises.ts",
    ]);
    assert.ok(sourceFacts("src/compiler/async.ts").calls.has("promiseStatic"));
});

test("Math is folded, spelled and resolved through math-intrinsics.ts", () => {
    // MATH_MEMBERS / MATH_CONSTANTS are the one table for scene code and
    // pinned bodies, foldMathCall the one generation-time fold, and a
    // pinned body resolves `Math` through pinnedLibraryGlobal.
    for (const name of [
        "MATH_MEMBERS",
        "MATH_CONSTANTS",
        "foldMathCall",
        "mathExtremeCall",
        "mathMemberIsImpure",
        "spelledMathCall",
    ])
        assert.deepEqual(
            declarationOwners(name),
            ["src/compiler/math-intrinsics.ts"],
            name,
        );
    assert.deepEqual(declarationOwners("pinnedLibraryGlobal"), [
        "src/pinned-program.ts",
    ]);
    for (const path of [
        "src/compiler/browser-erasure.ts",
        "src/compiler/data-lowering.ts",
        "src/compiler/expressions.ts",
        "src/compiler/option-helpers.ts",
        "src/lowering/flow-graph-lowerer.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("foldMathCall"), path);
    for (const path of [
        "src/compiler/canvas-readback.ts",
        "src/compiler/evaluation-order.ts",
        "src/compiler/native-functions.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("mathMemberIsImpure"), path);
    for (const path of [
        "src/lowering/context.ts",
        "src/lowering/gltf/cpp-expression.ts",
        "src/lowering/pinned-numeric-lowerer.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("pinnedLibraryGlobal"), path);
    for (const path of [
        "src/lowering/gltf/cpp-expression.ts",
        "src/lowering/navigation-build-plan.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("spelledMathCall"), path);
});

test("exponentiation, remainder and complement are spelled once", () => {
    // exponentiationCall (std::pow only under a finite static exponent,
    // else power_js), pinnedRemainderCall (fmod) and jsBitwiseNotCall are
    // the only places that spell these operators as C++.
    const spellers = (pattern: RegExp): string[] =>
        sourcePaths
            .filter((path) => pattern.test(readFileSync(path, "utf8")))
            .sort();
    assert.deepEqual(spellers(/std::pow[(]/), [
        "src/lowering/pinned-operators.ts",
    ]);
    // compoundAssignmentValue / compoundAssignmentStore are the one
    // compound-assignment rule for scene code and pinned bodies.
    for (const name of [
        "ASSIGNMENT_OPERATORS",
        "compoundAssignmentValue",
        "compoundAssignmentStore",
        "exponentiationCall",
    ])
        assert.deepEqual(
            declarationOwners(name),
            ["src/lowering/pinned-operators.ts"],
            name,
        );
    for (const path of [
        "src/lowering/pinned-numeric-lowerer.ts",
        "src/lowering/pinned-record-lowerer.ts",
        "src/lowering/pinned-ubo-writer-lowerer.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("compoundAssignmentStore"), path);
    assert.deepEqual(spellers(/std::fmod[(]/), [
        "src/lowering/pinned-operators.ts",
    ]);
    assert.deepEqual(spellers(/bitwise_not[(]/), [
        "src/lowering/pinned-operators.ts",
    ]);
});

test("ToUint32 / ToInt32 of a JavaScript number are spelled once", () => {
    // jsToUint32Call / jsToInt32Call wrap modulo 2^32 (NaN to 0); a bare
    // static_cast of a double is undefined outside the target range. The
    // sprite atlas helper's fixed text is the one other speller, and the
    // raw uint32 casts (indices and counts) may only shrink.
    assert.deepEqual(
        sourcePaths
            .filter((path) =>
                /bbl::js::to_u?int32[(]/.test(readFileSync(path, "utf8")),
            )
            .sort(),
        [
            "src/compiler/sprite-atlas-record.ts",
            "src/lowering/pinned-operators.ts",
        ],
    );
    const casts = sourcePaths.reduce(
        (count, path) =>
            count +
            [
                ...readFileSync(path, "utf8").matchAll(
                    /static_cast<std::uint32_t>[(]/g,
                ),
            ].length,
        0,
    );
    assert.ok(casts <= 163, `static_cast<std::uint32_t> casts: ${casts}`);
});

test("string concatenation operands and number formats are read once", () => {
    // stringPlusOperands keeps a numeric `+` one operand (`1 + 2 + "x"` is
    // "3x") for the runtime concatenation, the static string fold and UI
    // text; foldNumberFormat is the one toFixed / toPrecision /
    // toExponential fold.
    assert.deepEqual(declarationOwners("stringPlusOperands"), [
        "src/compiler/type-facts.ts",
    ]);
    for (const path of [
        "src/compiler/expressions.ts",
        "src/compiler/static-evaluator.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("stringPlusOperands"), path);
    assert.deepEqual(declarationOwners("foldNumberFormat"), [
        "src/compiler/number-intrinsics.ts",
    ]);
    for (const path of [
        "src/compiler/expressions.ts",
        "src/compiler/static-evaluator.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("foldNumberFormat"), path);
});

test("an intrinsic's conditional arms are selected by one rule", () => {
    // selectArms tests the condition by truthiness and runs each arm's
    // preparation only on its own branch; intrinsics that spell `c ? a : b`
    // over their own arm spellings use it.
    for (const path of [
        "src/compiler/assignments.ts",
        "src/compiler/intrinsics/asset.ts",
        "src/compiler/intrinsics/physics.ts",
        "src/compiler/intrinsics/sprite.ts",
    ])
        assert.ok(sourceFacts(path).members.has("selectArms"), path);
});

test("a Promise reaction call is recognized by promises.ts", () => {
    // promiseReactionOf reads then / catch / finally only on a receiver the
    // checker types as the library Promise: a class's own then is a method.
    assert.deepEqual(declarationOwners("promiseReactionOf"), [
        "src/compiler/promises.ts",
    ]);
    for (const path of [
        "src/compiler.ts",
        "src/compiler/async.ts",
        "src/compiler/compressed-json.ts",
        "src/compiler/pending-activations.ts",
        "src/compiler/shared-closure-analysis.ts",
    ])
        assert.ok(sourceFacts(path).calls.has("promiseReactionOf"), path);
});
