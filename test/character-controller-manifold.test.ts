import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { doubleLiteral } from "../src/cpp-literals.js";
import { characterControllerModule, lowerCharacterControllerKernel } from "../src/lowering/character-controller-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

type Vector = { x: number; y: number; z: number };
const vector = (x = 0, y = 0, z = 0): Vector => ({ x, y, z });
const lanes = (v: Vector): number[] => [v.x, v.y, v.z];
const cppVector = (v: Vector): string => `v(${lanes(v).map(doubleLiteral).join(",")})`;
const cppNumbers = (values: number[]): string => `{${values.map(doubleLiteral).join(",")}}`;
const matrix = (angle: number, x: number, y: number): Float32Array => new Float32Array([Math.cos(angle), 0, -Math.sin(angle), 0, 0, 1, 0, 0, Math.sin(angle), 0, Math.cos(angle), 0, x, y, 0, 1]);
const body = (id: number, motionType: number) => ({ _hkBody: [id], motionType, node: { worldMatrix: matrix(0, 0, 0) }, mass: 1, com: [0, 0, 0], linear: [0, 0, 0], angular: [0, 0, 0] });
const hit = (value: number, id: number, point: Vector, normal: Vector) => [value, null, [[id], null, null, lanes(point), lanes(normal)]];
const cppHit = (value: number, id: number, point: Vector, normal: Vector) => `hit(${doubleLiteral(value)},${id},${cppVector(point)},${cppVector(normal)})`;

function pinned() {
    const store = new UpstreamSourceStore();
    const evaluate = (module: string, imports: object) => {
        const output = ts.transpileModule(store.getSource(module), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const exports: Record<string, any> = {};
        new Function("exports", "require", output)(exports, () => imports);
        return exports;
    };
    const inverse = evaluate("src/math/mat4-invert.ts", { allocateMat4: () => new Float32Array(16) });
    const world: any = { _bodies: [], dt: 1 / 60, proximity: [], casts: [], events: [], queries: [] };
    const lookup = (id: number[]) => world._bodies.find((b: any) => b._hkBody[0] === id[0]);
    let collector = 0;
    world._hknp = {
        HP_QueryCollector_Create: () => [0, collector++],
        HP_QueryCollector_GetNumHits: (id: number) => [0, (id === 0 ? world.proximity : world.casts).length],
        HP_QueryCollector_GetShapeProximityResult: (_id: number, i: number) => [0, world.proximity[i]],
        HP_QueryCollector_GetShapeCastResult: (_id: number, i: number) => [0, world.casts[i]],
        HP_World_ShapeProximityWithCollector: (_world: any, _collector: any, query: any[]) => world.queries.push(0, ...query[1], ...query[2], query[3], Number(query[4])),
        HP_World_ShapeCastWithCollector: (_world: any, _collector: any, query: any[]) => world.queries.push(1, ...query[1], ...query[2], ...query[3], Number(query[4])),
        HP_Body_GetMassProperties: (id: number[]) => { const b = lookup(id); return [0, [b.com, b.mass, [1, 1, 1], [0, 0, 0, 1]]]; },
        HP_Body_GetAngularVelocity: (id: number[]) => [0, lookup(id).angular],
        HP_Body_GetLinearVelocity: (id: number[]) => [0, lookup(id).linear],
        HP_Body_ApplyImpulse: (id: number[], position: number[], impulse: number[]) => world.events.push(1, id[0], ...position, ...impulse),
    };
    const position = vector();
    const exports = evaluate(characterControllerModule, {
        ...inverse, worldStepSeconds: () => world.dt,
        createTransformNode: () => ({ position: { set(x: number, y: number, z: number) { Object.assign(position, { x, y, z }); } } }),
        createPhysicsShape: () => ({}), createPhysicsBody: () => ({ _hkBody: [0] }),
        setPhysicsBodyShape() {}, setPhysicsBodyMassProperties() {}, setPhysicsBodyPreStep() {},
        PhysicsShapeType: { CAPSULE: 3 }, PhysicsMotionType: { STATIC: 0, ANIMATED: 1, DYNAMIC: 2 },
    });
    const kernel = new exports.PhysicsCharacterController(world, vector(), { capsuleHeight: 1.8, capsuleRadius: .6 });
    kernel.onTriggerCollisionObservable.add((event: any) => world.events.push(0, event.collider._hkBody[0], ...lanes(event.impulsePosition), ...lanes(event.impulse)));
    return { kernel, world, position };
}

const tools = optionalNativeFixtureTools(false);
test("manifold updates, dynamic impulses, support and moving-body tracking match unchanged pinned methods", { skip: !tools }, () => {
    const output = resolve("artifacts/character-controller-manifold");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "full-kernel.hpp"), lowerCharacterControllerKernel(new LoweringContext(), true));
    const expected: number[][] = [], runs: string[] = [];
    for (let motion = 0; motion <= 2; motion++) {
        const { kernel, world } = pinned();
        world._bodies = [body(1, motion), body(2, 2)];
        runs.push(`{ Kernel kernel; auto first=body(1,${motion});auto second=body(2,2);kernel.bodies={first,second};`);
        for (let i = 0; i < 4; i++) {
            const distance = .08 - i * .04, point = vector(.5, .3, .1), normal = vector(-1, 0, 0);
            world.proximity = i === 3 ? [] : [hit(distance, 1, point, normal), hit(distance + .03, 2, vector(0, .2, .5), vector(0, 0, -1))];
            world.casts = i === 2 ? [hit(.2, 1, point, normal), hit(.3, 2, vector(0, .2, .5), vector(0, 0, -1))] : [];
            const status = kernel._updateManifold(vector(.1, -.03, .05));
            expected.push([status, ...kernel._manifold.flatMap((c: any) => [c.body?._hkBody[0] ?? -1, c.distance, c.fraction, c.allowedPenetration, ...lanes(c.position), ...lanes(c.normal)])]);
            runs.push(`kernel.proximity={${i === 3 ? "" : [cppHit(distance, 1, point, normal), cppHit(distance + .03, 2, vector(0, .2, .5), vector(0, 0, -1))].join(",")}};
                kernel.casts={${i === 2 ? [cppHit(.2, 1, point, normal), cppHit(.3, 2, vector(0, .2, .5), vector(0, 0, -1))].join(",") : ""}};
                print(manifold(kernel,kernel._updateManifold(v(.1,-.03,.05))));`);
        }
        runs.push("}");
    }
    {
        const { kernel, world } = pinned();
        const platform = body(1, 1); world._bodies = [platform]; kernel._position = vector(1, 1, 2);
        runs.push("{ Kernel kernel;auto platform=body(1,1);kernel.bodies={platform};kernel._position=v(1,1,2);");
        for (const frame of [1, 2, 3, 5, 6, 7]) {
            platform.node.worldMatrix = matrix(frame * .12, frame * .03, Math.sin(frame / 10)); kernel._frameId = frame;
            const c = { body: platform, position: vector(1, .2, 2), normal: vector(0, 1, 0), distance: .03, fraction: 0, allowedPenetration: .05 };
            const result = kernel._createSurfaceConstraint(1 / 60, c, .01);
            expected.push([result.priority, result.planeDistance, ...lanes(result.velocity), ...lanes(c.position)]);
            runs.push(`platform->matrix=${cppNumbers([...platform.node.worldMatrix])};kernel._frameId=${frame};{
                auto c=contact(platform,v(1,.2,2),v(0,1,0),.03);auto result=kernel._createSurfaceConstraint(1.0/60,c,.01);
                js::Array<double> row{result->priority,result->planeDistance};append(row,result->velocity);append(row,c->position);print(row);}`);
        }
        runs.push("}");
    }
    for (const distance of [0, -.02, .1]) {
        const { kernel, world } = pinned();
        const dynamic = body(1, 2); dynamic.mass = .3; dynamic.com = [.1, .2, -.1]; dynamic.linear = [.2, -.1, .3]; dynamic.angular = [.1, .2, .3];
        world._bodies = [dynamic]; kernel._velocity = vector(2, -1, .4); kernel.characterMass = .4;
        kernel._manifold = [{ body: dynamic, position: vector(.5, .2, .1), normal: vector(-1, 0, 0), distance, fraction: 0, allowedPenetration: .05 }];
        kernel._resolveContacts(1 / 60, vector(0, -9.81, 0)); expected.push(world.events);
        runs.push(`{Kernel kernel;auto dynamic=body(1,2);dynamic->mass=.3;dynamic->com={.1,.2,-.1};dynamic->linear={.2,-.1,.3};dynamic->angular={.1,.2,.3};kernel.bodies={dynamic};kernel._velocity=v(2,-1,.4);kernel.characterMass=.4;
            kernel._manifold={contact(dynamic,v(.5,.2,.1),v(-1,0,0),${doubleLiteral(distance)})};kernel._resolveContacts(1.0/60,v(0,-9.81,0));print(kernel.events);}`);
    }
    for (const collision of [false, true]) {
        const { kernel, world, position } = pinned();
        const floor = body(1, 0); world._bodies = [floor]; world.proximity = collision ? [hit(.02, 1, vector(), vector(0, 1, 0))] : [];
        runs.push(`{Kernel kernel;kernel.bodies={body(1,0)};kernel.proximity={${collision ? cppHit(.02, 1, vector(), vector(0, 1, 0)) : ""}};`);
        for (const dt of [0, 1 / 60, 1 / 30]) {
            world.dt = dt; kernel.moveWithCollisions(vector(.1, -.05, .03));
            const support = kernel.checkSupport(1 / 60, vector(0, -1, 0));
            expected.push([...lanes(kernel.getPosition()), ...lanes(kernel.getVelocity()), ...lanes(position), kernel._frameId, support.supportedState, ...lanes(support.averageSurfaceNormal), ...world.queries]);
            runs.push(`kernel.dt=${doubleLiteral(dt)};kernel.moveWithCollisions(v(.1,-.05,.03));{auto support=kernel.checkSupport(1.0/60,v(0,-1,0));js::Array<double> row;append(row,kernel.getPosition());append(row,kernel.getVelocity());append(row,kernel.node);row.push_back(kernel._frameId);row.push_back(support->supportedState);append(row,support->averageSurfaceNormal);for(double value:kernel.queries)row.push_back(value);print(row);}`);
        }
        runs.push("}");
    }
    writeFileSync(join(output, "check.cpp"), `#include "character-controller-kernel-check.hpp"\nint main(){std::cout<<std::setprecision(17)<<'[';\n${runs.join("\n")}\nstd::cout<<"]\\n";}\n`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/I", "native/include", "/I", "test/fixtures", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`, join(output, "check.cpp")]);
    const actual: number[][] = JSON.parse(execFileSync(executable, { encoding: "utf8", env: tools!.environment }));
    assert.deepEqual(actual.map(row => row.length), expected.map(row => row.length));
    const errors = actual.map((row, i) => row.map((value, lane) => Math.abs(value - expected[i]![lane]!)));
    const maxError = Math.max(...errors.flat());
    writeFileSync(join(output, "report.json"), JSON.stringify({ cases: expected.length, maxError, actual, expected }, null, 2) + "\n");
    assert(maxError < 1e-12, `Controller manifold error ${maxError}`);
});

test("character collector mappings reject changed ownership, result slots and query order", () => {
    class EditedStore extends UpstreamSourceStore {
        public constructor(private readonly from: string, private readonly to: string) { super(); }
        public override getSourceFile(module: string): ts.SourceFile {
            const source = super.getSource(module);
            return ts.createSourceFile(module, module === characterControllerModule ? source.replace(this.from, this.to) : source, ts.ScriptTarget.Latest, true);
        }
    }
    for (const [from, to] of [
        ["const ignoreSelf = [this._body._hkBody[0]];", "const ignoreSelf = [0];"],
        ["this.keepDistance + this.keepContactTolerance, false", "this.keepDistance + this.keepContactTolerance, true"],
        ["if (!castOnly) {", "if (castOnly) {"],
        ["v(cp[4][0], cp[4][1], cp[4][2])", "v(cp[2][0], cp[2][1], cp[2][2])"],
        ["const hknp = this._world._hknp;\n        const numProximityHits", "const hknp = this._world.otherSolver;\n        const numProximityHits"],
    ]) assert.throws(() => lowerCharacterControllerKernel(new LoweringContext(new EditedStore(from!, to!)), true), undefined, from);
});
