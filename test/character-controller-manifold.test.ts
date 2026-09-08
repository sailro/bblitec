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
type Body = ReturnType<typeof body>;
type ControllerNode = { position: { set(x: number, y: number, z: number): void } };
type WorldBody = Body | { _hkBody: number[]; node: ControllerNode };
type Hit = [number, null, [number[], null, null, number[], number[]]];
type Shape = { _hkShape: { height: number; radius: number; released: boolean } };
type ShapeOptions = { capsuleHeight?: number; capsuleRadius?: number };
type Contact = { body: Body | null; distance: number; fraction: number; allowedPenetration: number; position: Vector; normal: Vector };
interface World {
    _bodies: WorldBody[];
    dt: number;
    proximity: Hit[];
    casts: Hit[];
    events: number[];
    queries: number[];
    lifecycle: number[];
    collectors: Map<number, number>;
}
interface Kernel {
    _position: Vector;
    _velocity: Vector;
    _frameId: number;
    _manifold: Contact[];
    _shape: Shape;
    _startCollector: number;
    _castCollector: number;
    characterMass: number;
    up: Vector;
    onTriggerCollisionObservable: { add(callback: (event: { collider: WorldBody; impulsePosition: Vector; impulse: Vector }) => void): () => void };
    _updateManifold(displacement: Vector): number;
    _createSurfaceConstraint(deltaTime: number, contact: Contact, time: number): { priority: number; planeDistance: number; velocity: Vector };
    _resolveContacts(deltaTime: number, gravity: Vector): void;
    moveWithCollisions(displacement: Vector): void;
    checkSupport(deltaTime: number, direction: Vector): { supportedState: number; averageSurfaceNormal: Vector };
    getPosition(): Vector;
    getVelocity(): Vector;
    setPosition(value: Vector): void;
    setVelocity(value: Vector): void;
    setShapeOptions(options: ShapeOptions, preserveFootPosition?: boolean): void;
    dispose(): void;
}
const hit = (value: number, id: number, point: Vector, normal: Vector): Hit => [value, null, [[id], null, null, lanes(point), lanes(normal)]];
const cppHit = (value: number, id: number, point: Vector, normal: Vector) => `hit(${doubleLiteral(value)},${id},${cppVector(point)},${cppVector(normal)})`;

function pinned(initial = vector(), options: ShapeOptions = { capsuleHeight: 1.8, capsuleRadius: .6 }) {
    const store = new UpstreamSourceStore();
    const evaluate = (module: string, imports: object) => {
        const output = ts.transpileModule(store.getSource(module), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        const exports: Record<string, unknown> = {};
        new Function("exports", "require", output)(exports, () => imports);
        return exports;
    };
    const inverse = evaluate("src/math/mat4-invert.ts", { allocateMat4: () => new Float32Array(16) });
    const world: World = { _bodies: [], dt: 1 / 60, proximity: [], casts: [], events: [], queries: [], lifecycle: [], collectors: new Map() };
    const lookup = (id: number[]): Body => {
        const result = world._bodies.find(b => b._hkBody[0] === id[0]);
        assert(result && "mass" in result, "Collector body must have a mass and velocity transport record");
        return result;
    };
    const collectorCapacity = (id: number): number => {
        const capacity = world.collectors.get(id);
        assert.notEqual(capacity, undefined, "Collector must exist before release");
        return capacity!;
    };
    let collector = 0;
    Object.assign(world, { _hknp: {
        HP_QueryCollector_Create: (capacity: number) => { world.lifecycle.push(9, capacity); world.collectors.set(collector, capacity); return [0, collector++]; },
        HP_QueryCollector_Release: (id: number) => { world.lifecycle.push(10, collectorCapacity(id)); world.collectors.set(id, 0); },
        HP_Shape_Release: (shape: Shape["_hkShape"]) => { world.lifecycle.push(8, shape.height); shape.released = true; },
        HP_QueryCollector_GetNumHits: (id: number) => [0, (id === 0 ? world.proximity : world.casts).length],
        HP_QueryCollector_GetShapeProximityResult: (_id: number, i: number) => [0, world.proximity[i]],
        HP_QueryCollector_GetShapeCastResult: (_id: number, i: number) => [0, world.casts[i]],
        HP_World_ShapeProximityWithCollector: (_world: unknown, _collector: unknown, query: [unknown, number[], number[], number, boolean, ...unknown[]]) => world.queries.push(0, ...query[1], ...query[2], query[3], Number(query[4])),
        HP_World_ShapeCastWithCollector: (_world: unknown, _collector: unknown, query: [unknown, number[], number[], number[], boolean, ...unknown[]]) => world.queries.push(1, ...query[1], ...query[2], ...query[3], Number(query[4])),
        HP_Body_GetMassProperties: (id: number[]) => { const b = lookup(id); return [0, [b.com, b.mass, [1, 1, 1], [0, 0, 0, 1]]]; },
        HP_Body_GetAngularVelocity: (id: number[]) => [0, lookup(id).angular],
        HP_Body_GetLinearVelocity: (id: number[]) => [0, lookup(id).linear],
        HP_Body_ApplyImpulse: (id: number[], position: number[], impulse: number[]) => world.events.push(1, id[0]!, ...position, ...impulse),
    } });
    const position = vector();
    const exports = evaluate(characterControllerModule, {
        ...inverse, worldStepSeconds: () => world.dt,
        createTransformNode: (_name: string, x: number, y: number, z: number) => {
            world.lifecycle.push(2,x,y,z); Object.assign(position, { x,y,z });
            return { position: { set(x: number, y: number, z: number) { Object.assign(position, { x, y, z }); } } };
        },
        createPhysicsShape: (_world: unknown, shape: { parameters: { pointA: Vector; pointB: Vector; radius: number } }): Shape => {
            const p = shape.parameters, height = p.pointA.y - p.pointB.y + 2*p.radius;
            world.lifecycle.push(1,height,p.radius); return { _hkShape: { height, radius: p.radius, released: false } };
        },
        createPhysicsBody: (_world: unknown, node: ControllerNode, motion: number) => { world.lifecycle.push(3,motion); const result={ _hkBody:[0], node }; world._bodies.push(result); return result; },
        setPhysicsBodyShape(_world: unknown, _body: unknown, shape: Shape) { world.lifecycle.push(4,shape._hkShape.height); },
        setPhysicsBodyMassProperties(_world: unknown, _body: unknown, properties: { inertia: Vector }) { world.lifecycle.push(5,...lanes(properties.inertia)); },
        setPhysicsBodyPreStep(_body: unknown, enabled: boolean) { world.lifecycle.push(6,Number(enabled)); },
        removePhysicsBody(_world: unknown, body: WorldBody) { world.lifecycle.push(7); world._bodies.splice(world._bodies.indexOf(body), 1); },
        PhysicsShapeType: { CAPSULE: 3 }, PhysicsMotionType: { STATIC: 0, ANIMATED: 1, DYNAMIC: 2 },
    });
    assert.equal(typeof exports.PhysicsCharacterController, "function");
    const Controller = exports.PhysicsCharacterController as new (world: World, position: Vector, options: ShapeOptions) => Kernel;
    const kernel = new Controller(world, initial, options);
    kernel.onTriggerCollisionObservable.add(event => world.events.push(0, event.collider._hkBody[0]!, ...lanes(event.impulsePosition), ...lanes(event.impulse)));
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
            expected.push([status, ...kernel._manifold.flatMap(c => [c.body?._hkBody[0] ?? -1, c.distance, c.fraction, c.allowedPenetration, ...lanes(c.position), ...lanes(c.normal)])]);
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
    for (const options of [{}, { capsuleHeight: 2.4 }, { capsuleRadius: .35 }, { capsuleHeight: 2.2, capsuleRadius: .4 }]) {
        const initial = vector(3,4,5);
        const { kernel, world, position } = pinned(initial, options);
        const retainedPosition = kernel.getPosition(), retainedVelocity = kernel.getVelocity();
        const snapshot = () => expected.push([
            ...lanes(kernel.getPosition()), ...lanes(kernel.getVelocity()), ...lanes(position),
            kernel._shape._hkShape.height, kernel._shape._hkShape.radius, Number(kernel._shape._hkShape.released),
            world.collectors.get(kernel._startCollector)!, world.collectors.get(kernel._castCollector)!, world._bodies.length,
            Number(retainedPosition === kernel.getPosition()), Number(retainedVelocity === kernel.getVelocity()), ...world.lifecycle,
        ]);
        runs.push(`{Kernel kernel;auto options=js::make_ref<PhysicsCharacterControllerOptions>();
            ${"capsuleHeight" in options ? `options->capsuleHeight=${doubleLiteral(options.capsuleHeight!)};` : ""}
            ${"capsuleRadius" in options ? `options->capsuleRadius=${doubleLiteral(options.capsuleRadius!)};` : ""}
            auto initial=v(3,4,5);kernel.initialize(js::make_ref<PhysicsWorld>(),initial,options);
            auto retainedPosition=kernel.getPosition(),retainedVelocity=kernel.getVelocity();
            auto snapshot=[&](){js::Array<double> row;append(row,kernel.getPosition());append(row,kernel.getVelocity());append(row,kernel.node);
                for(double value:{kernel._shape->height,kernel._shape->radius,kernel._shape->released?1.0:0.0,kernel._startCollector->capacity,kernel._castCollector->capacity,static_cast<double>(kernel.bodies.size()),retainedPosition==kernel.getPosition()?1.0:0.0,retainedVelocity==kernel.getVelocity()?1.0:0.0})row.push_back(value);
                for(double value:kernel.lifecycle)row.push_back(value);print(row);};
            initial->x=99;snapshot();`);
        initial.x = 99; snapshot();
        kernel.setVelocity(vector(1,2,3)); kernel.setPosition(vector(-1,2,4));
        const oldShape = kernel._shape;
        kernel.setShapeOptions({ capsuleHeight: 1.2, capsuleRadius: .3 });
        assert.equal(oldShape._hkShape.released, true);
        snapshot();
        runs.push(`kernel.setVelocity(v(1,2,3));kernel.setPosition(v(-1,2,4));auto oldShape=kernel._shape;
            auto crouch=js::make_ref<PhysicsCharacterControllerOptions>();crouch->capsuleHeight=1.2;crouch->capsuleRadius=.3;kernel.setShapeOptions(crouch);
            if(!oldShape->released)throw std::runtime_error("Replaced capsule must be released.");snapshot();`);
        kernel.up = vector(.2,.7,-.4); kernel.setShapeOptions({ capsuleHeight: 2.4 }, false); snapshot();
        runs.push(`kernel.up=v(.2,.7,-.4);auto stand=js::make_ref<PhysicsCharacterControllerOptions>();stand->capsuleHeight=2.4;kernel.setShapeOptions(stand,false);snapshot();`);
        kernel.setShapeOptions({}); snapshot();
        runs.push("kernel.setShapeOptions(js::make_ref<PhysicsCharacterControllerOptions>());snapshot();");
        kernel.dispose(); snapshot();
        runs.push("kernel.dispose();snapshot();}");
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
    ]) assert.throws(() => lowerCharacterControllerKernel(new LoweringContext(new EditedStore(from!, to!)), true), { message: /.+/ }, from);
});
