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

test("keeps migrated upstream contracts AST-driven", () => {
    const lowerers = readdirSync("src/lowering")
        .filter(
            (name) =>
                name.endsWith("-lowerer.ts") &&
                name !== "renderer-lowerer.ts",
        )
        .map((name) => `src/lowering/${name}`);
    for (const path of [
        ...lowerers,
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
    // All three read sites -- the general property path, the one the
    // static evaluator calls, and destructuring, which names the same
    // properties -- consult the table rather than restating it, and the
    // writes take their field names from it too. Each of those was a
    // separate copy, and they had drifted apart.
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
    const compiler = source("src/compiler.ts");
    assert.match(compiler, /lowerWgslShaderProgram/);
    assert.doesNotMatch(
        compiler,
        /normalizeShaderSource/,
    );
    assert.doesNotMatch(
        compiler,
        /vertexSource ===/,
    );
    assert.doesNotMatch(
        compiler,
        /fragmentSource ===/,
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
