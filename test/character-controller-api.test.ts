import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { characterControllerModule } from "../src/lowering/character-controller-lowerer.js";
import { characterCollisionObservableSource, characterControllerHeader } from "../src/lowering/character-controller-runtime.js";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("public character APIs transport collision values, vector aliases and disposer identity", () => {
    const result = compileSource(`
        import HavokPhysics from "@babylonjs/havok";
        import { createEngine, createSceneContext, createHavokWorld, createPhysicsCharacterController,
            getPhysicsCharacterControllerBody, onPhysicsAfterStep, setPhysicsBodyMassProperties } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene = createSceneContext(engine);
        const world = createHavokWorld(scene, await HavokPhysics());
        const controller = createPhysicsCharacterController(world, {x:1,y:2,z:3}, {});
        const observations: number[] = [];
        const names: string[] = [];
        const dispose = controller.onTriggerCollisionObservable.add(event => {
            observations.push(event.impulse.x + event.impulsePosition.y);
            names.push(event.collider.node.name);
        });
        setPhysicsBodyMassProperties(world, getPhysicsCharacterControllerBody(controller), {inertia:{x:0,y:0,z:0}});
        onPhysicsAfterStep(world, () => {
            controller.setShapeOptions({capsuleHeight:1.2});
            controller.setVelocity({x:1,y:0,z:0});
            controller.moveWithCollisions({x:.1,y:-.01,z:0});
            const position = controller.getPosition();
            controller.setPosition({x:position.x,y:position.y,z:position.z});
            observations.push(controller.getVelocity().x);
            dispose(); controller.dispose();
        });
    `);
    assert(result.manifest.features.includes("physics:character-controller"));
    assert.match(result.cpp, /CharacterCollisionEvent/);
    assert.match(result.cpp, /physics_body_node_name/);
    assert.match(result.cpp, /onTriggerCollisionObservable\.add/);
    assert.match(result.cpp, /setShapeOptions/);
    assert.match(result.cpp, /getPosition\(\)->x/);
    assert.match(result.cpp, /getVelocity\(\)->x/);
});

const tools = optionalNativeFixtureTools(false);
test("character observers match pinned live iteration and duplicate callback removal", { skip: !tools }, () => {
    const store = new UpstreamSourceStore();
    const source = store.getSource(characterControllerModule);
    const output = ts.transpileModule(source + "\nexport { CharacterCollisionObservable };", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const exports: Record<string, any> = {};
    new Function("exports", "require", output)(exports, () => ({}));
    const observable = new exports.CharacterCollisionObservable();
    const expected: number[] = [];
    let first = true;
    const removeA = observable.add(() => { expected.push(1); if (first) { first = false; observable.add(() => expected.push(4)); } });
    const removeB = observable.add(() => { expected.push(2); removeB(); });
    observable.add(() => expected.push(3));
    observable.notify({}); observable.notify({}); removeA(); removeA(); observable.notify({});
    const duplicate = () => expected.push(5);
    const removeDuplicate = observable.add(duplicate); observable.add(duplicate);
    removeDuplicate(); observable.notify({}); removeDuplicate(); observable.notify({});
    const directory = resolve("artifacts/character-controller-observable");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "check.cpp"), `#include <bblite/js_data.hpp>
        #include <iostream>
        namespace bbl::character {struct CharacterCollisionEvent{};
        ${characterCollisionObservableSource(new LoweringContext(store))}}
        int main(){using namespace bbl;character::CharacterCollisionObservable observable;js::Array<double> values;bool first=true;
        auto removeA=observable.add([&](const auto&){values.push_back(1);if(first){first=false;observable.add([&](const auto&){values.push_back(4);});}});
        js::Callback<void()> removeB;removeB=observable.add([&](const auto&){values.push_back(2);removeB();});
        observable.add([&](const auto&){values.push_back(3);});
        observable.notify({});observable.notify({});removeA();removeA();observable.notify({});
        js::Callback<void(const character::CharacterCollisionEvent&)> duplicate=[&](const auto&){values.push_back(5);};
        auto removeDuplicate=observable.add(duplicate);observable.add(duplicate);removeDuplicate();observable.notify({});removeDuplicate();observable.notify({});
        std::cout<<'[';for(std::size_t i=0;i<values.size();++i){if(i)std::cout<<',';std::cout<<values[i];}std::cout<<']';}`);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/I", "native/include", `/Fo:${directory}\\`, `/Fe:${executable}`, join(directory, "check.cpp")]);
    const actual = JSON.parse(execFileSync(executable, { encoding: "utf8", env: tools!.environment }));
    writeFileSync(join(directory, "report.json"), JSON.stringify({ actual, expected }, null, 2) + "\n");
    assert.deepEqual(actual, expected);
});

test("character lifecycle PAL substitutions and observable contracts reject unrepresented source drift", () => {
    class EditedStore extends UpstreamSourceStore {
        public constructor(private readonly from: string, private readonly to: string) { super(); }
        public override getSourceFile(module: string): ts.SourceFile {
            const original = super.getSource(module);
            if (module === characterControllerModule) assert(original.includes(this.from));
            return ts.createSourceFile(module, module === characterControllerModule ? original.replace(this.from, this.to) : original, ts.ScriptTarget.Latest, true);
        }
    }
    for (const [from, to] of [
        ["this._subs.push(cb);", "this._subs.unshift(cb);"],
        ["for (const s of this._subs)", "for (const s of [...this._subs])"],
        ["if (i >= 0)", "if (i > 0)"],
        ["hknp.HP_QueryCollector_Create(16)[1]", "hknp.HP_QueryCollector_Create(16)[0]"],
        ["hknp.HP_Shape_Release(this._shape._hkShape)", "hknp.HP_Shape_Release(this._body._hkBody)"],
        ["hknp.HP_QueryCollector_Release(this._startCollector)", "hknp.HP_QueryCollector_Release(this._body)"],
        ["return controller.getBody();", "return controller._body;"],
    ]) assert.throws(() => characterControllerHeader(new LoweringContext(new EditedStore(from!, to!))), { message: /.+/ }, from);
});
