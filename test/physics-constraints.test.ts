import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsConstraints } from "../src/lowering/physics-constraint-lowerer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { importPinnedModuleWithExports } from "../src/pinned-shader-composer.js";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const store = new UpstreamSourceStore();
test("HINGE contracts retain anchor ordering, defaults, perpendicular math and axis locks", () => {
    lowerPhysicsConstraints(new LoweringContext(store));
    for (const [before, after] of [
        ["options.pivotA ?? ZERO_VEC3", "options.pivotB ?? ZERO_VEC3"],
        ["vec3Array(pivotA), vec3Array(axisA), vec3Array(perpAxisA)", "vec3Array(pivotA), vec3Array(perpAxisA), vec3Array(axisA)"],
        ["hknp.HP_Constraint_SetEnabled(joint, true)", "hknp.HP_Constraint_SetEnabled(joint, false)"],
        ["case PhysicsConstraintType.HINGE:\n            lock(axis.LINEAR_X);", "case PhysicsConstraintType.HINGE:\n            lock(axis.ANGULAR_X);"],
    ]) {
        class Changed extends LoweringContext {
            public override sourceFile(module: string): ts.SourceFile {
                const source = store.getSource(module);
                if (module !== "src/physics/havok.ts") return super.sourceFile(module);
                assert(source.includes(before!));
                return ts.createSourceFile(module, source.replace(before!, after!), ts.ScriptTarget.Latest, true);
            }
        }
        assert.throws(() => lowerPhysicsConstraints(new Changed(store)), /changed|exactly/);
    }
    const result = compileSource(`import Havok from "@babylonjs/havok"; import {createEngine, createSceneContext, createHavokWorld, createBox, createPhysicsAggregate, createPhysicsConstraint, PhysicsConstraintType, PhysicsShapeType} from "babylon-lite";
        async function main() {const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);const scene=createSceneContext(engine);const world=createHavokWorld(scene, await Havok());const mesh=createBox(engine,1);
        const a=createPhysicsAggregate(world,mesh,PhysicsShapeType.BOX,{mass:0});const b=createPhysicsAggregate(world,mesh,PhysicsShapeType.BOX,{mass:1});
        createPhysicsConstraint(world,a.body,b.body,PhysicsConstraintType.HINGE,{axisA:{x:0,y:0,z:-1},axisB:{x:0,y:0,z:1}});}main();`, { fileName: "hinge.ts" });
    assert.ok(result.manifest.features.includes("physics:constraints"));
    assert.match(result.cpp, /create_physics_constraint/);
});

const tools = optionalNativeFixtureTools();
test("constraint admission refuses untyped axes, partial bounds and unsupported springs", () => {
    const prefix = `import Havok from "@babylonjs/havok";
        import {createEngine,createSceneContext,createHavokWorld,createBox,createPhysicsAggregate,createPhysicsConstraint,PhysicsConstraintType,PhysicsConstraintAxis,PhysicsShapeType} from "babylon-lite";
        const engine=await createEngine({});const scene=createSceneContext(engine);const world=createHavokWorld(scene,await Havok());
        const a=createPhysicsAggregate(world,createBox(engine),PhysicsShapeType.BOX,{mass:0});
        const b=createPhysicsAggregate(world,createBox(engine),PhysicsShapeType.BOX,{mass:1});`;
    for (const [limits, error] of [
        ["[{axis:6,minLimit:1,maxLimit:2}]", /PhysicsConstraintAxis/],
        ["[{axis:PhysicsConstraintAxis.LINEAR_DISTANCE,minLimit:1}]", /minLimit and maxLimit/],
        ["[{axis:PhysicsConstraintAxis.LINEAR_DISTANCE,minLimit:1,maxLimit:2,stiffness:1}]", /stiffness and damping/],
    ] as const) {
        assert.throws(() => compileSource(`${prefix} createPhysicsConstraint(world,a.body,b.body,PhysicsConstraintType.SIX_DOF,{},${limits});`), error);
    }
});

test("native constraint configurations match all pinned factories and hinge lifetime stays valid", { skip: !tools }, async () => {
    const output = resolve("artifacts/physics-hinge");
    mkdirSync(output, { recursive: true });
    type Mode = "free" | "limited" | "locked";
    type Limit = { axis: number; minLimit: number; maxLimit: number };
    interface AxisApi {
        ConstraintAxis: Record<string, number>;
        ConstraintAxisLimitMode: { LOCKED: Mode; LIMITED: Mode };
        HP_Constraint_SetAxisMode(joint: object, axis: number, mode: Mode): void;
        HP_Constraint_SetAxisMinLimit(joint: object, axis: number, value: number): void;
        HP_Constraint_SetAxisMaxLimit(joint: object, axis: number, value: number): void;
    }
    const pin = await importPinnedModuleWithExports<{
        PhysicsConstraintType: Record<string, number>; PhysicsConstraintAxis: Record<string, number>;
        configureConstraintAxes(api: AxisApi, joint: object, type: number, options: { maxDistance?: number }, limits: Limit[]): void;
    }>("physics/havok.js", ["configureConstraintAxes"]);
    const names = ["LINEAR_X", "LINEAR_Y", "LINEAR_Z", "ANGULAR_X", "ANGULAR_Y", "ANGULAR_Z", "LINEAR_DISTANCE"];
    const cases: string[] = [`constexpr double hinge_type = ${pin.PhysicsConstraintType.HINGE};`];
    for (const type of Object.values(pin.PhysicsConstraintType)) for (const distance of [undefined, 2]) {
        const axes = names.map(() => ({ mode: "free" as Mode, minimum: 0, maximum: 0 }));
        const limits = names.map((name, index) => ({ axis: pin.PhysicsConstraintAxis[name]!, minLimit: index / 10, maxLimit: 1 + index / 10 }));
        pin.configureConstraintAxes({
            ConstraintAxis: Object.fromEntries(names.map((name, index) => [name, index])),
            ConstraintAxisLimitMode: { LOCKED: "locked", LIMITED: "limited" },
            HP_Constraint_SetAxisMode: (_joint, axis, mode) => { axes[axis]!.mode = mode; },
            HP_Constraint_SetAxisMinLimit: (_joint, axis, value) => { axes[axis]!.minimum = value; },
            HP_Constraint_SetAxisMaxLimit: (_joint, axis, value) => { axes[axis]!.maximum = value; },
        }, {}, type, distance === undefined ? {} : { maxDistance: distance }, limits);
        cases.push(`{ const auto axes = u::physics_constraint_axes(${type}, ${distance === undefined ? "{}" : "{.max_distance = 2.0}"}, {${limits.map(row => `{${row.axis},${row.minLimit},${row.maxLimit}}`).join(",")}});\n` +
            axes.map((row, index) => `assert(axes[${index}].mode == p::PhysicsConstraintAxisMode::${row.mode} && axes[${index}].minimum == ${row.minimum} && axes[${index}].maximum == ${row.maximum});`).join("\n") + "\n}");
    }
    writeFileSync(join(output, "constraint-axis-cases.inc"), cases.join("\n"));
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world", "physics:constraints"]);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/DBBLITE_HAS_PHYSICS_CONSTRAINTS=1",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include", "/I", output, "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0", "test/fixtures/physics-hinge-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const result = execFileSync(executable, { encoding: "utf8", env: { ...tools!.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` } });
    assert.match(result, /physics-hinge: ok/);
});
