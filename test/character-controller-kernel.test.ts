import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { doubleLiteral } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { characterControllerModule, lowerCharacterControllerKernel } from "../src/lowering/character-controller-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

type Vector = { x: number; y: number; z: number };
type Constraint = { planeNormal: Vector; planeDistance: number; velocity: Vector; angularVelocity: Vector; priority: number;
    staticFriction: number; dynamicFriction: number; extraUpStaticFriction: number; extraDownStaticFriction: number };
interface SolverOutput {
    position: Vector;
    velocity: Vector;
    deltaTime: number;
    planeInteractions: Array<{ touched: boolean; stopped: boolean; surfaceTime: number; penaltyDistance: number; status: number }>;
}
interface Kernel {
    _solve1d(constraint: Constraint, velocity: Vector, output: Vector): void;
    _simplexSolverSolve(constraints: Constraint[], velocity: Vector, deltaTime: number, minimumDeltaTime: number, maximumVelocity: Vector): SolverOutput;
    calculateMovement(deltaTime: number, forward: Vector, normal: Vector, velocity: Vector, surfaceVelocity: Vector, desiredVelocity: Vector, up: Vector): Vector;
}
const vector = (x = 0, y = 0, z = 0): Vector => ({ x, y, z });
const plane = (normal: Vector, options: Partial<Constraint> = {}): Constraint => ({ planeNormal: normal, planeDistance: 0,
    velocity: vector(), angularVelocity: vector(), priority: 0, staticFriction: 0, dynamicFriction: 1,
    extraUpStaticFriction: 0, extraDownStaticFriction: 0, ...options });

/** Only constructor transport is stubbed; every method under test executes the pinned JS body. */
function pinnedKernel() {
    const source = new UpstreamSourceStore().getSource(characterControllerModule);
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: { PhysicsCharacterController?: new (world: object, position: Vector, options: { capsuleHeight: number; capsuleRadius: number }) => Kernel } = {};
    const transport = {
        createTransformNode: () => ({ position: { set() {} } }),
        createPhysicsShape: () => ({}), createPhysicsBody: () => ({}),
        setPhysicsBodyShape() {}, setPhysicsBodyMassProperties() {}, setPhysicsBodyPreStep() {},
        PhysicsShapeType: { CAPSULE: 3 }, PhysicsMotionType: { STATIC: 0, ANIMATED: 1, DYNAMIC: 2 },
    };
    new Function("exports", "require", output)(exports, () => transport);
    assert(exports.PhysicsCharacterController);
    return new exports.PhysicsCharacterController({ _hknp: { HP_QueryCollector_Create: () => [0, {}] } }, vector(), { capsuleHeight: 1.8, capsuleRadius: 0.6 });
}

const nativeTools = optionalNativeFixtureTools(false);
test("controller arithmetic is read from the pin and unrepresented statements refuse", () => {
    class EditedStore extends UpstreamSourceStore {
        public constructor(private readonly from: string, private readonly to: string) { super(); }
        public override getSourceFile(module: string): ts.SourceFile {
            const source = super.getSource(module);
            return ts.createSourceFile(module, module === characterControllerModule ? source.replace(this.from, this.to) : source, ts.ScriptTarget.Latest, true);
        }
    }
    const original = lowerCharacterControllerKernel(new LoweringContext());
    const changed = lowerCharacterControllerKernel(new LoweringContext(new EditedStore("this.maxAcceleration * deltaTime", "this.maxAcceleration * deltaTime * 2")));
    assert.notEqual(original, changed);
    assert.match(changed, /maxAcceleration \* deltaTime\) \* 2\.0/);
    assert.throws(() => lowerCharacterControllerKernel(new LoweringContext(new EditedStore("const eps = 1e-6;", "throw new Error('new control flow'); const eps = 1e-6;"))), /Pinned reference statement has no native representation/);
});

test("reference-preserving simplex, friction and movement kernels match unchanged pinned TypeScript", { skip: !nativeTools }, () => {
    const directory = resolve("artifacts/character-controller-kernel");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "kernel.hpp"), lowerCharacterControllerKernel(new LoweringContext()));
    const kernel = pinnedKernel();
    const expected: number[][] = [];
    const runs: string[] = [];
    const cppVector = (value: Vector): string => `v(${[value.x, value.y, value.z].map(doubleLiteral).join(", ")})`;
    const cppPlane = (value: Constraint): string => `plane(${cppVector(value.planeNormal)}, ${cppVector(value.velocity)}, ${[value.priority, value.staticFriction, value.dynamicFriction, value.extraUpStaticFriction, value.extraDownStaticFriction].map(doubleLiteral).join(", ")})`;
    const normals = [vector(0, 1, 0), vector(1, 0, 0), vector(0, 0, 1), vector(0.6, 0.8, 0), vector(0, 0.8, 0.6)];
    for (let i = 0; i < 30; i++) {
        const constraint = plane(normals[i % normals.length]!, { velocity: vector(i % 3 / 5, 0, -0.2),
            staticFriction: i % 4 / 3, dynamicFriction: i % 5 / 4, extraUpStaticFriction: i % 2, extraDownStaticFriction: i % 3 / 2 });
        const velocity = vector((i % 7 - 3) * 0.7, (i % 4 - 2) * 1.3, i % 3 - 1);
        const output = vector();
        kernel._solve1d(constraint, velocity, output);
        expected.push([output.x, output.y, output.z]);
        runs.push(`{ auto output = v(); kernel._solve1d(${cppPlane(constraint)}, ${cppVector(velocity)}, output); print(output); }`);
    }
    const constraintSets = [[], [plane(vector(0, 1, 0))], [plane(vector(0, 1, 0)), plane(vector(1, 0, 0))],
        [plane(vector(0, 1, 0)), plane(vector(1, 0, 0)), plane(vector(0, 0, 1))],
        [plane(vector(0, 1, 0), { velocity: vector(1, 0, 0) }), plane(vector(1, 0, 0), { priority: 2 })],
        [plane(vector(0.6, 0.8, 0), { staticFriction: 0.5 }), plane(vector(0, 0, 1), { dynamicFriction: 0.25 })]];
    for (const constraints of constraintSets) {
        for (const velocity of [vector(1, -2, 3), vector(-2, -1, -0.5), vector(0, 0, 0), vector(0.2, 1, -2)]) {
            const output = kernel._simplexSolverSolve(constraints, velocity, 0.1, 0.03, vector(10, 10, 10));
            expected.push([output.position.x, output.position.y, output.position.z, output.velocity.x, output.velocity.y, output.velocity.z, output.deltaTime,
                ...output.planeInteractions.flatMap(interaction => [Number(interaction.touched), Number(interaction.stopped), interaction.surfaceTime, interaction.penaltyDistance, interaction.status])]);
            runs.push(`{ auto output = kernel._simplexSolverSolve({${constraints.map(cppPlane).join(", ")}}, ${cppVector(velocity)}, 0.1, 0.03, v(10, 10, 10)); print(output); }`);
        }
    }
    for (const normal of normals) {
        const output = kernel.calculateMovement(1 / 60, vector(0, 0, 1), normal, vector(1, 2, 3), vector(0.1, 0, 0.3), vector(1, 0, -1), vector(0, 1, 0));
        expected.push([output.x, output.y, output.z]);
        runs.push(`print(kernel.calculateMovement(${doubleLiteral(1 / 60)}, v(0, 0, 1), ${cppVector(normal)}, v(1, 2, 3), v(0.1, 0, 0.3), v(1, 0, -1), v(0, 1, 0)));`);
    }
    writeFileSync(join(directory, "check.cpp"), `
#include <iostream>
#include <iomanip>
namespace bbl::character { struct PhysicsBody {}; }
#include "kernel.hpp"
using namespace bbl::character;
using namespace bbl;
struct Kernel final : CharacterControllerKernel {
    js::Ref<Vec3> _getPointVelocity(js::Ref<PhysicsBody>, js::Ref<Vec3>) override { return v(); }
    js::Ref<SurfaceConstraint> _createSurfaceConstraint(double, js::Ref<Contact>, double) override { return js::make_ref<SurfaceConstraint>(); }
};
js::Ref<SurfaceConstraint> plane(js::Ref<Vec3> normal, js::Ref<Vec3> velocity, double priority, double sf, double df, double up, double down) {
    auto result = js::make_ref<SurfaceConstraint>(); result->planeNormal = normal; result->velocity = velocity; result->angularVelocity = v();
    result->priority = priority; result->staticFriction = sf; result->dynamicFriction = df;
    result->extraUpStaticFriction = up; result->extraDownStaticFriction = down; return result;
}
void lanes(js::Ref<Vec3> value) { std::cout << value->x << ' ' << value->y << ' ' << value->z << ' '; }
void print(js::Ref<Vec3> value) { lanes(value); std::cout << '\\n'; }
void print(js::Ref<SolverOutput> value) {
    lanes(value->position); lanes(value->velocity); std::cout << value->deltaTime << ' ';
    for (auto interaction : value->planeInteractions) std::cout << interaction->touched << ' ' << interaction->stopped << ' ' << interaction->surfaceTime << ' ' << interaction->penaltyDistance << ' ' << interaction->status << ' ';
    std::cout << '\\n';
}
int main() { std::cout << std::setprecision(17); Kernel kernel;
${runs.join("\n")}
}
`);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/I", "native/include", `/Fo:${directory}\\`, `/Fe:${executable}`, join(directory, "check.cpp")]);
    const actual = execFileSync(executable, { encoding: "utf8", timeout: 15000 }).trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number));
    assert.equal(actual.length, expected.length);
    let maximumError = 0;
    for (const [row, values] of expected.entries()) {
        assert.equal(actual[row]!.length, values.length, `case ${row} output shape`);
        for (const [column, value] of values.entries()) {
            const error = Math.abs(actual[row]![column]! - value);
            assert.ok(error <= 1e-12, `case ${row}, component ${column}: ${actual[row]![column]} != ${value}`);
            maximumError = Math.max(maximumError, error);
        }
    }
    writeFileSync(join(directory, "report.json"), JSON.stringify({ cases: expected.length, maximumError, expected, actual }, null, 2));
});
