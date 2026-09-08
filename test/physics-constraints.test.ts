import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsConstraints } from "../src/lowering/physics-constraint-lowerer.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
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
    assert.match(result.cpp, /create_physics_hinge/);
});

const tools = optionalNativeFixtureTools();
test("native hinge preserves pivots, free rotation, mass frames, filtering and retained lifetime", { skip: !tools }, () => {
    const output = resolve("artifacts/physics-hinge");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "camera:free", "renderer:scene", "physics:world", "physics:constraints"]);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/src", "/I", "native/include", "/I", join(output, "upstream/include"), "/I", join(output, "upstream/src"),
        `/external:I${join(nativeFixtureVcpkgRoot, "include/bullet")}`, "/external:W0", "test/fixtures/physics-hinge-check.cpp", join(output, "upstream/src/scene_core.cpp"),
        "/link", "/OPT:REF", `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`, "BulletDynamics.lib", "BulletCollision.lib", "LinearMath.lib"]);
    const result = execFileSync(executable, { encoding: "utf8", env: { ...tools!.environment,
        PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools!.environment.PATH ?? ""}` } });
    assert.match(result, /physics-hinge: ok/);
});
