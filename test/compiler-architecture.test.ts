import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { declarationOwners, sourceFacts, sourcePaths } from "./source-facts.js";

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
        ["lowerGltfDefaultSampler", "gltf/sampler-mapping"],
        ["lowerAccessorNormalizationCpp", "gltf/accessor-normalization"],
        ["lowerShPrescaleCpp", "gltf/sh-prescale"],
        ["lowerMatrixComposeCpp", "gltf/matrix-leaves"],
        ["lowerMatrixNativeCpp", "gltf/matrix-leaves"],
        ["lowerGltfMaterialProperties", "gltf/material-properties"],
        ["lowerGltfFactorBake", "gltf/factor-bake"],
        ["MeshBuilderLowerer", "factory/mesh-builders"],
        ["FactoryLowerer", "factory/material-factories"],
        ["pinnedSampleCounts", "pinned-surface"],
    ]) assert.deepEqual(declarationOwners(name!), ['src/lowering/' + path + '.ts'], name);
});
