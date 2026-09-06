import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { GizmoLowerer } from "../src/lowering/gizmo-lowerer.js";
import {
    pinnedGizmoBoundsGeometry,
    pinnedGizmoFollowGeometry,
    pinnedGizmoGeometry,
} from "../src/lowering/pinned-gizmo-geometry.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const CAMERA = "src/gizmo/camera-gizmo.ts";
const LIGHT = "src/gizmo/light-gizmo.ts";
const CORE = "src/gizmo/gizmo-core.ts";
const BOUNDS = "src/gizmo/bounding-box-gizmo.ts";
const store = new UpstreamSourceStore();

class GeometryContext extends LoweringContext {
    public constructor(private readonly edits = new Map<string, string>()) {
        super(store);
    }
    public override sourceFile(modulePath: string): ts.SourceFile {
        const source = this.edits.get(modulePath);
        return source === undefined ? super.sourceFile(modulePath)
            : ts.createSourceFile(modulePath, source, ts.ScriptTarget.Latest, true);
    }
}

function changed(modulePath: string, before: string, after: string): GeometryContext {
    const source = store.getSource(modulePath);
    assert.ok(source.includes(before), "The test mutation must affect the verified pin.");
    return new GeometryContext(new Map([[modulePath, source.replace(before, after)]]));
}

function object(value: unknown): Record<string, unknown> {
    assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
    return value as Record<string, unknown>;
}

function number(value: unknown): number {
    assert.equal(typeof value, "number");
    assert.ok(typeof value === "number");
    return value;
}

function list(value: unknown): unknown[] {
    assert.ok(Array.isArray(value));
    return value;
}

function vector(value: unknown): number[] {
    const record = object(value);
    return ["x", "y", "z"].map((lane) => number(record[lane]));
}

function quat(value: unknown): number[] {
    const record = object(value);
    return ["x", "y", "z", "w"].map((lane) => number(record[lane]));
}

function observable3(x = 0, y = 0, z = 0) {
    return { x, y, z, set(nx: number, ny: number, nz: number) {
        this.x = nx; this.y = ny; this.z = nz;
    } };
}

function observable4(x = 0, y = 0, z = 0, w = 1) {
    return { x, y, z, w, set(nx: number, ny: number, nz: number, nw: number) {
        this.x = nx; this.y = ny; this.z = nz; this.w = nw;
    } };
}

function node(
    name: string, x = 0, y = 0, z = 0,
    qx = 0, qy = 0, qz = 0, qw = 1, sx = 1, sy = 1, sz = 1,
) {
    return {
        name, position: observable3(x, y, z),
        rotationQuaternion: observable4(qx, qy, qz, qw), scaling: observable3(sx, sy, sz),
    };
}

interface PinMath {
    mat4Decompose: (matrix: Float32Array) => unknown;
    computeAabb: (positions: Float32Array, matrix?: Float32Array) => number[][];
    mat4Multiply: (a: Float32Array, b: Float32Array) => Float32Array;
}

/** Execute the actual mapped TS declarations, recording only the resource/observable seam. */
function execute(
    context: LoweringContext,
    modules: readonly string[],
    entry: string,
    args: readonly unknown[],
    math: Partial<PinMath> = {},
): unknown {
    const source = modules.map((modulePath) => {
        const file = context.sourceFile(modulePath);
        return file.statements.filter((statement) =>
            !ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
            .map((statement) => statement.getText(file)).join("\n");
    }).join("\n");
    const compiled = ts.transpileModule(`${source}\n${entry}`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const callbacks: (() => void)[] = [];
    return runInNewContext(compiled, {
        exports: {}, args, Float32Array, Uint32Array, Math, ...math,
        onBeforeRender: (_scene: unknown, callback: () => void) => callbacks.push(callback),
        tick: () => { for (const callback of callbacks) callback(); },
        addToScene: () => {},
        createStandardMaterial: () => ({}),
        createTransformNode: node,
        createBox: () => node("box"),
        createCylinder: (_engine: unknown, options: unknown) => ({ ...node("cylinder"), options }),
        createMeshFromData: (
            _engine: unknown, name: string, positions: Float32Array, normals: Float32Array,
            indices: Uint32Array, uvs: Float32Array,
        ) => ({ name, positions, normals, indices, uvs }),
    }, { timeout: 5000 });
}

function edge(value: unknown): number[] {
    const mesh = object(value);
    const options = object(mesh.options);
    return [
        ...["height", "diameterTop", "diameterBottom", "tessellation"].map((name) => number(options[name])),
        ...vector(mesh.position), ...vector(mesh.scaling), ...quat(mesh.rotationQuaternion),
    ];
}

interface GeometryCase {
    operation: string;
    input: readonly number[];
    expected: readonly number[];
    exact?: boolean;
}

async function cases(context: LoweringContext): Promise<GeometryCase[]> {
    const result: GeometryCase[] = [];
    for (const [segments, diameter] of [[1, 1], [10, 2], [3.5, 0.73123456789], [4, 0], [3, -2]]) {
        const mesh = object(execute(context, [LIGHT],
            "buildHemisphereMesh({}, args[0], args[1]);", [segments, diameter]));
        const arrays = ["positions", "normals", "indices", "uvs"].map((name) => {
            const value = mesh[name];
            assert.ok(value instanceof Float32Array || value instanceof Uint32Array);
            return [...value];
        });
        result.push({
            operation: "hemisphere", input: [segments!, diameter!],
            expected: [...arrays.map((values) => values.length), ...arrays.flat()], exact: true,
        });
    }
    for (const levels of [0, 2, 2.999, 3, 4, 5, 10]) {
        const definitions = list(execute(context, [LIGHT], "lineDefsForLevel(args[0]);", [levels]));
        result.push({
            operation: "lines", input: [levels],
            expected: [definitions.length, ...definitions.flatMap((value) =>
                ["pivotY", "pivotZ", "posY", "sx", "sy", "sz"].map((name) => number(object(value)[name])))],
        });
    }
    for (const input of [[0.8, 16 / 9, 0.1, 100], [1.31, 0.625, -2, -1], [0, 1, 0.01, 0.01]]) {
        const meshes = list(execute(context, [CAMERA],
            "buildFrustumWireframe({}, {}, {}, {}, ...args);", input));
        result.push({ operation: "frustum", input, expected: [meshes.length, ...meshes.flatMap(edge)] });
    }
    for (const direction of [[0, 0, 0], [0, 3, 0], [0, -2, 0], [1e-8, 1, 0], [1e-6, 1, 0], [3.1, -0.27, 2.6]]) {
        const input = [0.036, 0, 0, 0, ...direction];
        const value = execute(context, [CAMERA],
            "buildFrustumEdge({}, {}, {}, {}, args[0], {x:args[1],y:args[2],z:args[3]}, {x:args[4],y:args[5],z:args[6]});", input);
        result.push({ operation: "edge", input, expected: edge(value) });
    }
    const decomposition = await importPinnedModule<Pick<PinMath, "mat4Decompose">>("math/mat4-decompose.js");
    const camera = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0.1, -0.23, 0.973, 0, -7.123, 0.3125, 17.61, 1]);
    const target = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 16384.125, -3.75, 0.123456, 1]);
    for (const present of [false, true]) {
        const scale = execute(context, ["src/math/normalize-vec3-object.ts", "src/gizmo/gizmo-math.ts", CORE, CAMERA], `
const scene = {camera: args[0] ? {worldMatrix: args[1]} : null};
const gizmo = createCameraGizmo({}, {scene});
gizmo.attachedCamera = {worldMatrix: args[2]};
tick();
gizmo._bodyOuter.scaling;`, [present, camera, target], decomposition);
        result.push({
            operation: "camera", input: [Number(present), ...camera, ...target], expected: vector(scale),
        });
        const position = { x: 3.000000000001, y: -0.125, z: 83.123456789 };
        const lightScale = execute(context, [LIGHT], `
const gizmo = createLightGizmo({}, {scene:{camera:args[0] ? {worldMatrix:args[1]} : null}});
gizmo.attachedLight = {position:args[2]};
tick();
gizmo.root.scaling;`, [present, camera, position]);
        result.push({
            operation: "light", input: [Number(present), ...camera, ...vector(position)], expected: vector(lightScale),
        });
    }
    for (const ratio of [-0.333333333333, 0, 0.7312345678901]) {
        const scale = execute(context, [CORE], `
const root = createTransformNode("root");
attachFollowTarget({camera:{worldMatrix:args[0]}}, root, () => ({worldMatrix:args[1]}), args[2]);
tick();
root.scaling;`, [camera, target, ratio]);
        result.push({
            operation: "projected", input: [...target.slice(12, 15), ...camera, ratio], expected: vector(scale),
        });
    }
    const aabbMath = await importPinnedModule<Pick<PinMath, "computeAabb">>("math/compute-aabb.js");
    const multiply = await importPinnedModule<Pick<PinMath, "mat4Multiply">>("math/mat4-multiply.js");
    const geometrySets = [
        [],
        [new Float32Array([-1.1, -2.2, -3.3, 5.5, 6.6, 7.7])],
        [new Float32Array([-10, -20, -30, 10, 20, 30]), new Float32Array([0.003, 9, -0.004, 0.001, -0.2, 70])],
    ];
    for (const geometries of geometrySets) {
        const root = { children: geometries.map((positions) => ({
            _gpu: {}, _cpuPositions: positions, worldMatrix: target,
        })) };
        const expected = object(execute(context, [BOUNDS], "computeBoundsRecursive(args[0]);", [root], {
            ...aabbMath, ...multiply,
        }));
        result.push({
            operation: "bounds",
            input: [geometries.length, ...geometries.flatMap((positions) => aabbMath.computeAabb(positions, target).flat())],
            expected: ["min", "max", "centre", "size"].flatMap((name) => vector(expected[name])),
        });
    }
    return result;
}

function geometryHeader(context: LoweringContext): string {
    return `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
#include <limits>
namespace bbl {
${pinnedGizmoGeometry(context)}
${pinnedGizmoFollowGeometry(context, true)}
struct BoundingBoxBounds { Vec3d min, max, centre, size; };
${pinnedGizmoBoundsGeometry(context)}
}
`;
}

test("gizmo geometry carriers and resource boundaries reject incompatible pinned drift", () => {
    assert.throws(() => pinnedGizmoGeometry(changed(LIGHT,
        "pivotY: number;", "pivotY: [number, number];")), /numeric LineDef record/);
    assert.throws(() => pinnedGizmoGeometry(changed(CAMERA,
        "mesh.pickable = false;", "mesh.pickable = true;")), /camera-gizmo\.ts:\d+:\d+: Unsupported pinned frustum mesh attachment/);
    assert.throws(() => pinnedGizmoGeometry(changed(CAMERA,
        "{ x: -nw, y: -nh, z: +near }", "[-nw, -nh, +near]")), /camera-gizmo\.ts/);
    assert.throws(() => pinnedGizmoGeometry(changed(CAMERA,
        "for (const [i, j] of edgePairs)", "for (const [i, j] of corners)")), /index-pair range/);
    assert.throws(() => pinnedGizmoGeometry(changed(CAMERA,
        "a: { x: number; y: number; z: number }", "a: [number, number, number]")), /two pinned point records/);
    assert.throws(() => pinnedGizmoBoundsGeometry(changed(BOUNDS,
        "const isDescendantOfRoot", "minX -= 1;\n    const isDescendantOfRoot")), /arithmetic escaped/);
    assert.throws(() => pinnedGizmoFollowGeometry(changed(LIGHT,
        "const cw = camera.worldMatrix;", "const cw = light.worldMatrix;"), false), /utility camera's world matrix/);
    const display = new GizmoLowerer(new GeometryContext(), ["gizmo:camera", "gizmo:light"]).lower().source;
    assert.doesNotMatch(display, /gizmo_projected_scaling|gizmo_bounds_fold|bbox_place_anchor/);
    const editing = new GizmoLowerer(new GeometryContext(), ["gizmo:axis-drag"]).lower().source;
    assert.match(editing, /gizmo_projected_scaling/);
    assert.doesNotMatch(editing, /gizmo_bounds_fold/);
    const bounds = new GizmoLowerer(new GeometryContext(), ["gizmo:bounding-box"]).lower().source;
    assert.match(bounds, /gizmo_bounds_fold|bbox_place_anchor/);
    for (const symbol of ["buildHemisphereMesh", "lineDefsForLevel", "buildFrustumEdge", "buildFrustumWireframe"]) {
        assert.ok(display.includes(`#${symbol}.`));
    }
});

const nativeTools = optionalNativeFixtureTools();
test("AST-derived gizmo geometry and follow transforms match the executed pin, including semantic edits", {
    skip: !nativeTools,
}, async () => {
    const output = resolve("artifacts", "pinned-gizmo-geometry-check");
    mkdirSync(output, { recursive: true });
    const changes = new Map<string, string>([
        [LIGHT, store.getSource(LIGHT)
            .replace("const r = diameter / 2;", "const r = diameter / 3;")
            .replace("pivotZ: Math.PI / 4,", "pivotZ: Math.PI / 3,")
            .replace("* LIGHT_GIZMO_SCALE;", "* LIGHT_GIZMO_SCALE * 1.125;")],
        [CAMERA, store.getSource(CAMERA)
            .replace("(2 * far - nearP)", "(3 * far - nearP)")
            .replace("const angle = Math.atan2(cLen, dot);", "const angle = Math.atan2(cLen, dot) * 0.875;")
            .replace("* CAMERA_BODY_SCALE;", "* CAMERA_BODY_SCALE * 1.25;")],
        [CORE, store.getSource(CORE).replace("* scaleRatio;", "* scaleRatio * 1.0625;")],
        [BOUNDS, store.getSource(BOUNDS)
            .replace("(minX + maxX) * 0.5", "(minX + maxX) * 0.375")
            .replace("if (!Number.isFinite(minX))", "if (Number.isFinite(minX)) { minX -= 0.125; }\n    if (!Number.isFinite(minX))")],
    ]);
    const contexts = [new GeometryContext(), new GeometryContext(changes)];
    const expectations = await Promise.all(contexts.map(cases));
    assert.notDeepEqual(expectations[0]!.map((entry) => entry.expected), expectations[1]!.map((entry) => entry.expected));
    for (const [index, context] of contexts.entries()) {
        const rows = expectations[index]!;
        writeFileSync(join(output, "pinned_gizmo_geometry.hpp"), geometryHeader(context));
        const executable = join(output, `gizmo-geometry-${index}.exe`);
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
            `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include",
            "test\\fixtures\\pinned-gizmo-geometry-check.cpp",
        ]);
        const lines = execFileSync(executable, [], {
            encoding: "utf8",
            input: rows.map((row) => `${row.operation} ${row.input.join(" ")}`).join("\n") + "\n",
        }).trim().split(/\r?\n/);
        assert.equal(lines.length, rows.length);
        for (const [rowIndex, row] of rows.entries()) {
            const [operation, ...values] = lines[rowIndex]!.trim().split(/\s+/);
            assert.equal(operation, row.operation);
            const actual = values.map(Number);
            assert.equal(actual.length, row.expected.length, `${index}/${row.operation}/${rowIndex} length`);
            for (const [lane, expected] of row.expected.entries()) {
                const value = actual[lane]!;
                const label = `${index}/${row.operation}/${rowIndex}/${lane}: ${value} != ${expected}`;
                if (row.exact) assert.equal(value, expected, label);
                else assert.ok(Math.abs(value - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), label);
            }
        }
    }
});

test("complete display and bounding gizmo units remain warning-clean C++20", {
    skip: !nativeTools || !existsSync("generated\\scene224\\upstream\\include\\bblite\\upstream\\camera_math.hpp"),
}, async () => {
    const output = resolve("artifacts", "pinned-gizmo-unit-check");
    mkdirSync(output, { recursive: true });
    for (const [name, features] of [
        ["display", ["gizmo:camera", "gizmo:light"]],
        ["bounds", ["gizmo:bounding-box", "gizmo:axis-drag", "gizmo:axis-scale", "gizmo:plane-drag", "gizmo:plane-rotation"]],
    ] as const) {
        const source = join(output, `${name}.cpp`);
        writeFileSync(source, new GizmoLowerer(new GeometryContext(), features).lower().source);
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/c",
            `/Fo:${output}\\`, "/I", "native\\include", "/I", "generated\\scene224\\upstream\\include", source,
        ]);
    }
    writeFileSync(join(output, "math_helpers.hpp"), `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cmath>
namespace bbl {
${new GizmoLowerer(new GeometryContext())["mathHelpers"]()}
}
`);
    const fixture = join(output, "math.cpp");
    writeFileSync(fixture, `#include "math_helpers.hpp"
#include <iomanip>
#include <iostream>
int main() {
    bbl::Vec3 value{};
    std::cout << std::setprecision(17);
    while (std::cin >> value.x >> value.y >> value.z) {
        const auto rotation = bbl::direction_to_quat(value);
        const auto normal = bbl::normalize_vec3(value);
        for (const double lane : rotation) std::cout << lane << ' ';
        std::cout << normal.x << ' ' << normal.y << ' ' << normal.z << ' '
                  << bbl::length_vec3(value) << '\\n';
    }
}
`);
    const executable = join(output, "math.exe");
    runNativeFixtureCompiler(nativeTools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", fixture,
    ]);
    const input = [
        [0, 0, 0], [3.123456789, -1.23456789, 9.0000001],
        [1e-12, -3e-12, 2e-12], [1e21, -3e22, 5e23],
    ].map((value) => value.map(Math.fround));
    const outputRows = execFileSync(executable, [], {
        encoding: "utf8", input: input.map((row) => row.join(" ")).join("\n") + "\n",
    }).trim().split(/\r?\n/).map((row) => row.trim().split(/\s+/).map(Number));
    const { directionToQuat } = await importPinnedModule<{
        directionToQuat: (value: { x: number; y: number; z: number }) => number[];
    }>("gizmo/gizmo-math.js");
    const { normalizeVec3 } = await importPinnedModule<{
        normalizeVec3: (value: { x: number; y: number; z: number }) => { x: number; y: number; z: number };
    }>("math/normalize-vec3-object.js");
    const { lengthVec3 } = await importPinnedModule<{
        lengthVec3: (value: { x: number; y: number; z: number }) => number;
    }>("math/length-vec3.js");
    assert.equal(outputRows.length, input.length);
    for (const [index, row] of input.entries()) {
        const value = { x: row[0]!, y: row[1]!, z: row[2]! };
        const expected = [...directionToQuat(value), ...vector(normalizeVec3(value)), lengthVec3(value)];
        assert.equal(outputRows[index]!.length, expected.length);
        for (const [lane, expectedValue] of expected.entries()) {
            assert.ok(Math.abs(outputRows[index]![lane]! - expectedValue) <= 1e-12 * Math.max(1, Math.abs(expectedValue)),
                `float-record sample ${index}, lane ${lane} must evaluate as a JavaScript number`);
        }
    }
});
