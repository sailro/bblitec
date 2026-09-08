import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { fieldOffsets } from "../src/capture-uniforms.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { pinnedMaterialVertex, pinnedPbrVertexTemplate } from "../src/pinned-material-vertex.js";
import { extractWgslFunction, importPinnedModule } from "../src/pinned-shader-composer.js";
import { composePinnedPbrShader } from "./pinned-pbr-shader-fixture.js";
import { DEFORMATION_BONE_SLOTS, materialVertexWgsl } from "../src/shader-builtins-standard.js";
import {
    mapShaderStatements,
    parseWgslFunction,
    parseWgslModule,
    parseWgslStatements,
    parseWgslStructDeclarations,
    statementUsesPath,
    type ShaderExpression,
    type ShaderFunction,
    type ShaderStatement,
} from "../src/shader-ir.js";
import { emitWgslFunction, emitWgslModule, emitWgslStatements } from "../src/shader-wgsl-emitter.js";
import { findRepositoryRoot, sharedUpstreamStore } from "../src/upstream-source.js";

const root = findRepositoryRoot();
const store = sharedUpstreamStore();
const skeletonModule = "src/shader/fragments/skeleton-fragment.ts";
const morphModule = "src/shader/fragments/morph-fragment-core.ts";
const templateModule = "src/material/pbr/pbr-template.ts";
const instanceModule = "src/shader/fragments/thin-instance-fragment.ts";
const flags = [
    [false, false, false], [false, true, false],
    [true, false, false], [true, true, false],
    [true, false, true], [true, true, true],
] as const;

function nativeModule(source: string) {
    const helper = source.includes("fn bblReadBoneMatrix(")
        ? extractWgslFunction(source, "bblReadBoneMatrix") : "";
    return { module: parseWgslModule(helper ? source.replace(helper, "") : source, "vertex"), helper };
}

class EditedContext extends LoweringContext {
    public constructor(private readonly module: string, private readonly edit: (source: string) => string) { super(store); }
    public override sourceFile(module: string): ts.SourceFile {
        return module === this.module
            ? ts.createSourceFile(module, this.edit(store.getSource(module)), ts.ScriptTarget.Latest, true)
            : super.sourceFile(module);
    }
}

function changed(module: string, from: string, to: string): LoweringContext {
    assert.ok(store.getSource(module).includes(from), `fixture no longer matches ${module}: ${from}`);
    return new EditedContext(module, source => source.replace(from, to));
}

test("shared vertex projections preserve every PAL binding, varying and optional vertex stream", () => {
    for (const [deformation, instancing, morphStorage] of flags) {
        const source = materialVertexWgsl(deformation, instancing, morphStorage);
        const { module, helper } = nativeModule(source);
        assert.equal(module.entryPoint.name, "mainVertex");
        assert.deepEqual(module.entryPoint.parameters, [{ name: "input", type: "VertexInput" }]);
        assert.deepEqual(module.bindings, [
            { name: "uniforms", type: "VertexUniforms", group: 1, binding: 0, addressSpace: "uniform" },
            ...(deformation ? [{ name: "deformation", type: "DeformationUniforms", group: 1, binding: 1, addressSpace: "uniform" }] : []),
            ...(morphStorage ? [
                { name: "morphDeltas", type: "morphDeltasUniforms", group: 0, binding: 0, addressSpace: "storage, read" },
                { name: "morph", type: "morphUniforms", group: 0, binding: 1, addressSpace: "storage, read" },
            ] : []),
            ...(instancing ? [{ name: "instanceUniforms", type: "InstanceUniforms", group: 1,
                binding: deformation ? 2 : 1, addressSpace: "uniform" }] : []),
        ]);
        const structure = (name: string) => {
            const found = module.structs.find(value => value.name === name);
            assert.ok(found, name);
            return found;
        };
        const input = structure("VertexInput").members;
        assert.deepEqual(input.filter(member => member.attribute?.kind === "location").map(member => member.attribute?.value),
            [0, 1, 2, 3, 4, 5, 6, ...(deformation ? [8, 9, ...(!morphStorage ? [10, 11, 12, 13, 14, 15] : [])] : []),
                ...(instancing ? [16, 17, 18, 19] : [])]);
        assert.equal(input.some(member => member.attribute?.value === "vertex_index"), morphStorage);
        assert.deepEqual(structure("VertexOutput").members.map(member => [member.name, member.type, member.attribute?.value]), [
            ["position", "vec4<f32>", "position"], ["worldPosition", "vec3<f32>", 0], ["normal", "vec3<f32>", 1],
            ["tangent", "vec4<f32>", 2], ["uv", "vec2<f32>", 3], ["localPosition", "vec3<f32>", 4],
            ["uv2", "vec2<f32>", 5], ["color", "vec4<f32>", 6], ["bitangent", "vec3<f32>", 7],
        ]);
        assert.deepEqual(fieldOffsets(structure("VertexUniforms").members), { offsets: [0], size: 64 });
        if (deformation) {
            assert.deepEqual(fieldOffsets(structure("DeformationUniforms").members),
                { offsets: [0, DEFORMATION_BONE_SLOTS * 64, DEFORMATION_BONE_SLOTS * 64 + 16], size: DEFORMATION_BONE_SLOTS * 64 + 32 });
            assert.deepEqual(parseWgslFunction(emitWgslFunction(parseWgslFunction(helper))), parseWgslFunction(helper));
        }
        if (instancing) assert.deepEqual(fieldOffsets(structure("InstanceUniforms").members), { offsets: [0], size: 64 });
        if (morphStorage) {
            assert.deepEqual(fieldOffsets(structure("morphUniforms").members.slice(0, 4)), { offsets: [0, 4, 8, 12], size: 16 });
            assert.equal(structure("morphUniforms").members[4]?.type, "array<f32>");
        }
        assert.deepEqual(parseWgslModule(emitWgslModule(module), "vertex"), module);
        assert.ok(!module.entryPoint.statements.some(statement =>
            statementUsesPath(statement, parts => ["mesh", "scene", "boneSampler", "joints1", "weights1"].includes(parts[0]!))));
        assert.match(source, new RegExp(store.pin.sourceVersion));
    }
    const pal = readFileSync(join(root, "native", "src", "pal_gpu_shared.hpp"), "utf8");
    assert.match(pal, new RegExp(`struct DeformationUniforms \\{\\s*std::array<std::array<float, 16>, ${DEFORMATION_BONE_SLOTS}> bone_matrices\\{\\};\\s*float morph_weights\\[4\\]\\{\\};\\s*float options\\[4\\]\\{\\};`));
    assert.equal(materialVertexWgsl(false, false, true), materialVertexWgsl());
});

interface Fragment {
    _vertexSlots: { VR?: string; VW?: string };
    _vertexHelperFunctions?: string;
}
const pinned = Promise.all([
    importPinnedModule<{ createSkeletonFragment(eight: boolean): Fragment; makeSkinningCode(eight: boolean): string; SKELETON_HELPERS: string }>("shader/fragments/skeleton-fragment.js"),
    importPinnedModule<{ createMorphFragment(): Fragment }>("shader/fragments/morph-fragment-core.js"),
    importPinnedModule<{ createThinInstanceFragment(color: boolean): Fragment }>("shader/fragments/thin-instance-fragment.js"),
]);

test("the reusable PBR vertex template matches the executed pin before transport adaptation", async () => {
    const pinned = await importPinnedModule<{
        createPbrTemplate(config: { _normalMode: "tangent"; _hasMorph: boolean }): { _vertexTemplate: string };
    }>("material/pbr/pbr-template.js");
    for (const morph of [false, true]) {
        const template = pinnedPbrVertexTemplate(new LoweringContext(store), morph);
        const executed = pinned.createPbrTemplate({ _normalMode: "tangent", _hasMorph: morph });
        assert.deepEqual(template.module, parseWgslModule(executed._vertexTemplate, "vertex"));
        assert.equal(template.position, morph ? "morphedPos" : "position");
        assert.equal(template.normal, morph ? "morphedNorm" : "normal");
    }
});

test("storage morph statements and header are the executed pinned fragment, not a transcript", async () => {
    const [, morph] = await pinned;
    const fragment = morph.createMorphFragment();
    assert.ok(fragment._vertexSlots.VR);
    assert.ok(fragment._vertexHelperFunctions);
    const projected = pinnedMaterialVertex(new LoweringContext(store), { deformation: true, instancing: false, morphStorage: true });
    assert.deepEqual(parseWgslStructDeclarations(projected.morphStructs), parseWgslStructDeclarations(fragment._vertexHelperFunctions));
    const body = parseWgslStatements(projected.body);
    const deform = body.find(statement => statement.kind === "if");
    assert.ok(deform?.kind === "if");
    const expected = mapShaderStatements(parseWgslStatements(fragment._vertexSlots.VR), expression => {
        if (expression.kind !== "path") return expression;
        const replacements: Readonly<Record<string, string[]>> = {
            position: ["worldPosition"], normal: ["worldNormal"], vertexIndex: ["input", "vertexIndex"],
        };
        const parts = expression.parts.length === 1 ? replacements[expression.parts[0]!] : undefined;
        return parts ? { kind: "path", parts } : expression;
    });
    assert.deepEqual(deform.statements.slice(0, expected.length), expected);
    assert.deepEqual(parseWgslStatements(emitWgslStatements(expected)), expected);
});

// A small WGSL-IR evaluator checks buffer/address and matrix-order semantics,
// independently of the source-to-source projection. It implements WGSL values,
// not Babylon formulas; both the executed pin and the projected stage use it.
type Value = number | Value[] | ValueRecord;
interface ValueRecord { [name: string]: Value }
const scalar = (value: Value): number => { assert.ok(typeof value === "number"); return value; };
const array = (value: Value): Value[] => { assert.ok(Array.isArray(value)); return value; };
function field(value: Value, name: string): Value {
    if (Array.isArray(value)) {
        const selected = [...name].map(component => {
            const lane = value["xyzw".indexOf(component)];
            assert.notEqual(lane, undefined, `invalid swizzle ${name}`);
            return lane!;
        });
        return selected.length === 1 ? selected[0]! : selected;
    }
    assert.ok(typeof value === "object");
    assert.ok(name in value);
    return value[name]!;
}
function binary(operator: string, left: Value, right: Value): Value {
    if (operator === "*" && Array.isArray(left) && left.every(Array.isArray) && Array.isArray(right)) {
        if (right.every(Array.isArray)) return right.map(column => binary("*", left, column));
        return [0, 1, 2, 3].map(row => left.reduce<number>((sum, column, index) =>
            Math.fround(sum + Math.fround(scalar(array(column)[row]!) * scalar(right[index]!))), 0));
    }
    if (Array.isArray(left)) return left.map((value, index) => binary(operator, value, Array.isArray(right) ? right[index]! : right));
    if (Array.isArray(right)) return right.map(value => binary(operator, left, value));
    const a = scalar(left), b = scalar(right);
    switch (operator) {
        case "+": return Math.fround(a + b);
        case "-": return Math.fround(a - b);
        case "*": return Math.fround(a * b);
        case "/": return Math.fround(a / b);
        case "<": return Number(a < b);
        case ">": return Number(a > b);
        case ">=": return Number(a >= b);
        default: throw new Error(`Unhandled test operator ${operator}`);
    }
}
function execute(statements: ShaderStatement[], scope: Map<string, Value>, functions: ShaderFunction[] = []): Value | undefined {
    const evaluate = (expression: ShaderExpression): Value => {
        switch (expression.kind) {
            case "number": return Number(expression.value.replace(/[fui]$/, ""));
            case "path": {
                const root = scope.get(expression.parts[0]!);
                assert.notEqual(root, undefined, `unbound ${expression.parts.join(".")}`);
                return expression.parts.slice(1).reduce(field, root!);
            }
            case "member": return field(evaluate(expression.expression), expression.member);
            case "index": {
                const value = array(evaluate(expression.expression))[scalar(evaluate(expression.index))];
                assert.notEqual(value, undefined, "out-of-range transport index");
                return value!;
            }
            case "binary": return binary(expression.operator, evaluate(expression.left), evaluate(expression.right));
            case "construct": {
                const values = expression.arguments.map(evaluate);
                return expression.type === "mat4x4<f32>" ? values : values.flat();
            }
            case "call": {
                const args = expression.arguments.map(evaluate);
                if (expression.name === "f32") return Math.fround(scalar(args[0]!));
                if (expression.name === "i32" || expression.name === "u32") return Math.trunc(scalar(args[0]!));
                if (expression.name === "vec2<i32>") return args;
                if (expression.name === "textureLoad") return array(args[0]!)[scalar(array(args[1]!)[0]!)]!;
                if (expression.name === "normalize") {
                    const vector = array(args[0]!).map(scalar);
                    const length = Math.hypot(...vector);
                    return vector.map(component => Math.fround(component / length));
                }
                if (expression.name === "cross") {
                    const a = array(args[0]!).map(scalar), b = array(args[1]!).map(scalar);
                    return [0, 1, 2].map(i => Math.fround(a[(i + 1) % 3]! * b[(i + 2) % 3]! - a[(i + 2) % 3]! * b[(i + 1) % 3]!));
                }
                const fn = functions.find(fn => fn.name === expression.name);
                assert.ok(fn, `unhandled test call ${expression.name}`);
                const local = new Map(scope);
                fn.parameters.forEach((parameter, index) => local.set(parameter.name, args[index]!));
                const result = execute(fn.statements, local, functions);
                assert.notEqual(result, undefined);
                return result!;
            }
        }
    };
    for (const statement of statements) {
        switch (statement.kind) {
            case "let":
            case "var": scope.set(statement.name, statement.value ? evaluate(statement.value) : {}); break;
            case "assign": {
                assert.equal(statement.target.kind, "path");
                if (statement.target.kind !== "path") throw new Error("Expected a test path assignment.");
                const [name, property] = statement.target.parts;
                const value = evaluate(statement.value);
                if (property) {
                    const target = scope.get(name!);
                    assert.ok(target && !Array.isArray(target) && typeof target === "object");
                    target[property] = value;
                } else scope.set(name!, value);
                break;
            }
            case "if": if (scalar(evaluate(statement.condition))) execute(statement.statements, scope, functions); break;
            case "for":
                execute([statement.initializer], scope, functions);
                for (let trips = 0; scalar(evaluate(statement.condition)); ++trips) {
                    assert.ok(trips < 1024);
                    execute(statement.statements, scope, functions);
                    execute([statement.update], scope, functions);
                }
                break;
            case "return": return statement.value ? evaluate(statement.value) : undefined;
            default: throw new Error(`Unhandled test statement ${statement.kind}`);
        }
    }
    return undefined;
}

const identity: Value[] = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const world: Value[] = [[2, 1, 0, 0], [0, 3, 1, 0], [1, 0, 4, 0], [5, -2, 7, 1]];
const instance: Value[] = [[0, 2, 1, 0], [-1, 0, 0, 0], [0, 1, 1, 0], [3, 4, -6, 1]];
function equalLanes(actual: Value, expected: Value): void {
    if (Array.isArray(actual)) {
        const other = array(expected);
        assert.equal(actual.length, other.length);
        actual.forEach((lane, index) => equalLanes(lane, other[index]!));
    } else {
        // Eliminating the pre-baked identity world can retain a negative zero.
        assert.ok(scalar(actual) === scalar(expected), `${actual} != ${expected}`);
    }
}

test("uniform palette addressing preserves the pin's raw texture columns, including boundary joints", async () => {
    const [skeleton] = await pinned;
    const original = parseWgslFunction(skeleton.SKELETON_HELPERS);
    const projected = parseWgslFunction(nativeModule(materialVertexWgsl(true)).helper);
    const bones = Array.from({ length: DEFORMATION_BONE_SLOTS }, (_, bone) =>
        Array.from({ length: 4 }, (_, column) => Array.from({ length: 4 }, (_, row) => bone * 1000 + column * 100 + row + 0.5)));
    for (const index of [0, 1, 7, 63, 8.75]) {
        const expected = execute(original.statements, new Map<string, Value>([["smp", bones.flat()], ["index", index]]));
        const actual = execute(projected.statements, new Map<string, Value>([["deformation", { boneMatrices: bones }], ["index", index]]));
        assert.deepEqual(actual, expected);
    }
});

test("the executed pin and specialized stages agree on weighted positions and matrix composition", async () => {
    const [skeleton, morph, thin] = await pinned;
    const bones = [identity, world, instance, binary("*", world, instance)];
    for (const [deformation, instancing, morphStorage] of flags) {
        const targetCount = morphStorage ? 5 : 2;
        const vertexCount = 3, vertexIndex = 1;
        const weights = Array.from({ length: targetCount }, (_, i) => (i + 1) / 16);
        const deltas = Array.from({ length: targetCount * vertexCount * 6 }, (_, i) => i % 6 < 3 ? (i - 10) / 32 : 0);
        const input: ValueRecord = {
            position: [1, 2, 3], normal: [0, 1, 0], tangent: [1, 0, 0, -1], uv: [0.2, 0.8],
            localPosition: [-2, 3, 4], uv2: [0.6, 0.1], color: [0.25, 0.5, 0.75, 1],
            joints: [3, 1, 0, 2], weights: [0.125, 0.25, 0.375, 0.25], vertexIndex,
        };
        for (let target = 0; target < 2; ++target) {
            const base = (target * vertexCount + vertexIndex) * 6;
            input[`morphPosition${target}`] = deltas.slice(base, base + 3);
            input[`morphNormal${target}`] = deltas.slice(base + 3, base + 6);
            input[`morphTangent${target}`] = [0, 0, 0];
        }
        for (let column = 0; column < 4; ++column) input[`instanceColumn${column}`] = instance[column]!;
        const native = nativeModule(materialVertexWgsl(deformation, instancing, morphStorage));
        const scope = new Map<string, Value>([
            ["input", input], ["uniforms", { viewProjection: world }],
            ["instanceUniforms", { parentWorld: world }],
            ["deformation", { boneMatrices: bones, morphWeights: weights, options: [1, 0, 0, 0] }],
            ["morph", { count: targetCount, vertexCount, weights }], ["morphDeltas", { d: deltas }],
        ]);
        const actual = execute(native.module.entryPoint.statements, scope,
            native.helper ? [parseWgslFunction(native.helper)] : []);
        assert.ok(actual);
        if (deformation && !instancing) {
            for (const [enabled, flat] of [[0, 0], [1, 1]]) {
                const gated = new Map(scope);
                gated.set("deformation", { boneMatrices: bones, morphWeights: weights, options: [enabled!, flat!, 0, 0] });
                const result = execute(native.module.entryPoint.statements, gated, [parseWgslFunction(native.helper)]);
                assert.ok(result);
                equalLanes(field(result, "normal"), input.normal!);
                equalLanes(field(result, "worldPosition"), enabled ? field(actual, "worldPosition") : input.position!);
                if (!enabled) equalLanes(field(result, "tangent"), input.tangent!);
            }
        }
        const composed = await composePinnedPbrShader({ _normalMode: "tangent", _hasMorph: deformation },
            deformation ? [skeleton.createSkeletonFragment(false), morph.createMorphFragment()] : []);
        const helper = deformation ? extractWgslFunction(composed.vertexWgsl, "readMatrixFromRawSampler") : "";
        const original = parseWgslModule(helper ? composed.vertexWgsl.replace(helper, "") : composed.vertexWgsl, "vertex");
        const originalScope = new Map<string, Value>(Object.entries(input));
        originalScope.set("mesh", { world: identity });
        originalScope.set("scene", { viewProjection: world });
        originalScope.set("boneSampler", bones.flat());
        originalScope.set("morph", { count: targetCount, vertexCount, weights });
        originalScope.set("morphDeltas", { d: deltas });
        let expected = execute(original.entryPoint.statements, originalScope, helper ? [parseWgslFunction(helper)] : []);
        assert.ok(expected);
        if (instancing) {
            const instanceStage = await composePinnedPbrShader({ _normalMode: "tangent" }, [thin.createThinInstanceFragment(false)]);
            const instanced = parseWgslModule(instanceStage.vertexWgsl, "vertex");
            originalScope.set("position", field(expected, "worldPos"));
            originalScope.set("mesh", { world });
            for (let column = 0; column < 4; ++column) originalScope.set(`world${column}`, instance[column]!);
            expected = execute(instanced.entryPoint.statements, originalScope);
            assert.ok(expected);
        }
        equalLanes(field(actual, "worldPosition"), field(expected, "worldPos"));
        equalLanes(field(actual, "position"), field(expected, "clipPos"));
        for (const name of ["uv", "localPosition", "uv2", "color"]) assert.deepEqual(field(actual, name), input[name]);
        if (!instancing) {
            equalLanes(field(actual, "normal"), field(expected, "worldNormal"));
            equalLanes(array(field(actual, "tangent")).slice(0, 3), field(expected, "worldTangent"));
            equalLanes(field(actual, "bitangent"), field(expected, "worldBitangent"));
        }
    }
});

test("pin arithmetic changes flow through skinning, morphing, tangent frames and instance order", () => {
    const baseline = materialVertexWgsl(true, true, true);
    for (const [module, from, to, expected] of [
        [skeletonModule, "*weights[1]", "*weights[1]*0.375", /0\.375/],
        [skeletonModule, "mat4x4f(m0,m1,m2,m3)", "mat4x4f(m1,m0,m2,m3)", /mat4x4<f32>\(m1, m0, m2, m3\)/],
        [morphModule, "let w=morph.weights[i]", "let w=morph.weights[i]*0.625", /0\.625/],
        [templateModule, "cross(N_local,T_local)", "cross(T_local,N_local)", /cross\(normalize\(worldTangent\), normalize\(worldNormal\)\)/],
        [instanceModule, "mesh.world*instanceWorld", "instanceWorld*mesh.world", /instanceWorld \* instanceUniforms\.parentWorld/],
    ] as const) {
        const projected = materialVertexWgsl(true, true, true, changed(module, from, to));
        assert.notEqual(projected, baseline);
        assert.match(projected, expected);
    }
    const bounded = materialVertexWgsl(true, false, false,
        changed(morphModule, "let w=morph.weights[i]", "let w=morph.weights[i]*0.625"));
    assert.match(bounded, /0\.625/);
});

test("renderer specialization forwards the pinned lowering context instead of enforcing transcript markers", () => {
    const context = changed(skeletonModule, "*weights[1]", "*weights[1]*0.375");
    const shaders = new RendererLowerer(context).lowerShaders({
        ground: false, skybox: false, shaderPrograms: [], idDiagnostics: false,
        geometryOutputTasks: [], gpuDeformation: true, gpuInstancing: true, morphStorage: true,
    });
    const vertex = shaders.find(shader => shader.output.endsWith("pbr.vert.native.wgsl"));
    assert.ok(vertex);
    assert.equal(vertex.data, materialVertexWgsl(true, true, true, context));
    assert.match(String(vertex.data), /0\.375/);
});

test("unrepresentable pin drift refuses rather than retaining a transcript or emitting an unmapped input", () => {
    for (const [module, from, to, reason] of [
        [skeletonModule, "i32(index)*4", "i32(index)*8", /four-column bone texture address/],
        [skeletonModule, "f32(joints[3])", "f32(joints[4])", /four-influence vertex stream/],
        [morphModule, "vertexIndex)*6u", "vertexIndex)*7u", /six-float morph attribute address/],
        [morphModule, "_p1:u32", "_p1:vec4<f32>", /morph storage ABI/],
        [templateModule, "out.uv=uv", "out.uv=mesh.unsupportedUv", /unbound input 'mesh.unsupportedUv'/],
        [templateModule, "out.uv=uv", "out.uv=uv;out.extra=${normVar}", /template outputs/],
        [templateModule, "cross(N_local,T_local)", "newTangentHelper(N_local,T_local)", /unmapped function 'newTangentHelper'/],
        [templateModule, '_hasMorph ? "morphedPos" : "position"', '_hasMorph ? "morphedPos * 0.5" : "position"', /morph template inputs|unbound input/],
        [templateModule, "vec4<f32>(${posVar},1.0)", "vec4<f32>(${posVar}*2.0,1.0)", /homogeneous position transport/],
        [morphModule, "morphedNorm=morphedNorm+w*", "morphedNorm=morphedPos+w*", /bounded morph projection/],
    ] as const) {
        assert.throws(() => materialVertexWgsl(true, true, true, changed(module, from, to)), reason);
    }
});

test("pinned local renaming and WGSL formatting do not select shader behavior", () => {
    const baseline = nativeModule(materialVertexWgsl()).module;
    const renamed = new EditedContext(templateModule, source => source.replaceAll("N_local", "localNormalAlias")
        .replaceAll("worldPos4", "positionAlias").replaceAll("B_local", "localBitangentAlias"));
    assert.deepEqual(nativeModule(materialVertexWgsl(false, false, false, renamed)).module, baseline);
    const projected = pinnedMaterialVertex(new LoweringContext(store), { deformation: true, instancing: true, morphStorage: true });
    const formatted = projected.body.replace(/([{};,])/g, " /* outer /* nested */ */ $1 \n");
    assert.deepEqual(parseWgslStatements(formatted), parseWgslStatements(projected.body));
});

const tint = process.env["TINT_PATH"] ?? join(root, "artifacts", "tools", "tint", "tint.exe");
test("all shared vertex transports validate and compile with the installed pinned Tint", { skip: !existsSync(tint) }, () => {
    const directory = join("artifacts", `shader-builtins-standard-${process.pid}`);
    mkdirSync(directory, { recursive: true });
    try {
        for (const [deformation, instancing, morphStorage] of flags) {
            const source = join(directory, `${Number(deformation)}${Number(instancing)}${Number(morphStorage)}.wgsl`);
            writeFileSync(source, materialVertexWgsl(deformation, instancing, morphStorage));
            execFileSync(tint, ["--format", "hlsl", source, "-o", join(directory, "vertex.hlsl")], { cwd: root, stdio: "pipe" });
        }
    } finally {
        rmSync(resolve(directory), { recursive: true, force: true });
    }
});
