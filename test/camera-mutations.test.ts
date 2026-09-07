import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { CameraMutationLowerer } from "../src/lowering/camera-mutation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface PinCamera {
    alpha: number; beta: number; radius: number; worldMatrixVersion: number;
    target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
    inertialAlphaOffset: number; inertialBetaOffset: number; inertialRadiusOffset: number;
    inertialPanningX: number; inertialPanningY: number;
}

function cameraSources(output: string, tracking = true): string[] {
    const context = new LoweringContext();
    const lowerer = new CameraLowerer(context, tracking);
    const headers = join(output, "include/bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const controls = lowerer.lowerControls();
    writeFileSync(join(headers, "camera_controls.hpp"), controls.header);
    writeFileSync(join(output, "controls.cpp"), controls.source);
    const camera = lowerer.lowerArcRotateFactory();
    writeFileSync(join(headers, "camera_math.hpp"), camera.header);
    // Keep the production factory itself; matrix functions are outside this
    // setter/owner fixture and require the renderer's generated matrix header.
    const start = camera.source.indexOf("CameraHandle create_arc_rotate_camera(");
    assert.ok(start >= 0);
    const end = camera.source.indexOf("\n}\n", start);
    assert.ok(end > start);
    writeFileSync(join(output, "factory.cpp"), `#include <bblite/runtime.hpp>\nnamespace bbl {\n${camera.source.slice(start, end + 3)}\n}`);
    return [join(output, "controls.cpp"), join(output, "factory.cpp")];
}

test("camera transform versions observe pinned setters, reentrant limits and input order", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const { createArcRotateCamera } = await importPinnedModule<{
        createArcRotateCamera(a: number, b: number, r: number, target: object): PinCamera;
    }>("camera/arc-rotate.js");
    const { setCameraLimits, attachControl } = await importPinnedModule<{
        setCameraLimits(camera: PinCamera, limits: object): () => void;
        attachControl(camera: PinCamera, canvas: object, scene: object): () => void;
    }>("camera/arc-rotate-controls.js");
    const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    const scene = { _beforeRender: [] as (() => void)[] };
    attachControl(camera, { addEventListener() {}, removeEventListener() {} }, scene);
    const expected: number[][] = [];
    const observe = () => expected.push([camera.worldMatrixVersion, camera.alpha, camera.beta, camera.radius,
        camera.target.x, camera.target.y, camera.target.z, camera.inertialAlphaOffset,
        camera.inertialBetaOffset, camera.inertialRadiusOffset, camera.inertialPanningX, camera.inertialPanningY]);
    observe();
    camera.alpha = 0; observe();
    camera.alpha = 2; camera.alpha = 0; observe();
    camera.target.x = 0; observe();
    camera.target.set(0, 0, 0); observe();
    camera.target.x = 3; camera.target.x = 0; observe();
    setCameraLimits(camera, { lowerRadiusLimit: 2, upperRadiusLimit: 5, lowerAlphaLimit: -0.1, upperAlphaLimit: 0.1 }); observe();
    camera.radius = 9; observe();
    camera.alpha = 4; observe();
    camera.inertialAlphaOffset = 0.3; camera.inertialBetaOffset = -1.5; camera.inertialRadiusOffset = 4;
    camera.inertialPanningX = 10; camera.inertialPanningY = -8;
    scene._beforeRender[0]!(); observe();
    scene._beforeRender[0]!(); observe();
    const nonFinite = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    const nonFiniteScene = { _beforeRender: [] as (() => void)[] };
    attachControl(nonFinite, { addEventListener() {}, removeEventListener() {} }, nonFiniteScene);
    nonFinite.beta = NaN; nonFinite.radius = NaN;
    nonFinite.inertialAlphaOffset = 1; nonFinite.inertialRadiusOffset = 1;
    nonFiniteScene._beforeRender[0]!();
    assert.ok(Number.isNaN(nonFinite.beta) && Number.isNaN(nonFinite.radius));
    const duplicate = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    const duplicateScene = { _beforeRender: [] as (() => void)[] };
    attachControl(duplicate, { addEventListener() {}, removeEventListener() {} }, duplicateScene);
    attachControl(duplicate, { addEventListener() {}, removeEventListener() {} }, duplicateScene);
    duplicate.inertialAlphaOffset = 0.2;
    for (const callback of duplicateScene._beforeRender) callback();
    assert.equal(duplicate.worldMatrixVersion, 2);
    assert.ok(Math.abs(duplicate.alpha - 0.38) < 1e-12);
    const output = resolve("artifacts/camera-mutations");
    const sources = cameraSources(output);
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include <bblite/runtime.hpp>
#include <bblite/upstream/camera_controls.hpp>
#include <cassert>
#include <cmath>
int main() {
    bbl::Engine engine;
    const auto handle = bbl::create_arc_rotate_camera(engine, 0, 1, 5, {});
    auto& camera = engine.cameras[handle.value];
    std::vector<std::array<double, 12>> actual;
    auto observe = [&] { actual.push_back({camera.world_matrix_version, camera.alpha, camera.beta, camera.radius,
        camera.target.x, camera.target.y, camera.target.z, camera.inertial_alpha_offset,
        camera.inertial_beta_offset, camera.inertial_radius_offset, camera.inertial_panning_x, camera.inertial_panning_y}); };
    auto scalar = [&](double bbl::CameraRecord::*field, double value) { bbl::write_camera_scalar(camera, field, value); };
    auto x = [&](double value) { bbl::write_camera_vector_component(camera, &bbl::CameraRecord::target, &bbl::Vec3d::x, value); };
    observe(); scalar(&bbl::CameraRecord::alpha, 0); observe();
    scalar(&bbl::CameraRecord::alpha, 2); scalar(&bbl::CameraRecord::alpha, 0); observe();
    x(0); observe(); bbl::set_camera_vector(camera, &bbl::CameraRecord::target, {}); observe();
    x(3); x(0); observe();
    bbl::set_camera_limits(engine, handle, 51u, {-0.1, 0.1, 0, 0, 2, 5}); observe();
    scalar(&bbl::CameraRecord::radius, 9); observe(); scalar(&bbl::CameraRecord::alpha, 4); observe();
    camera.inertial_alpha_offset = 0.3; camera.inertial_beta_offset = -1.5; camera.inertial_radius_offset = 4;
    camera.inertial_panning_x = 10; camera.inertial_panning_y = -8;
    bbl::upstream::apply_arc_rotate_inertia(camera); observe();
    bbl::upstream::apply_arc_rotate_inertia(camera); observe();
    const std::vector<std::array<double, 12>> expected{${expected.map((row) => `{${row.join(",")}}`).join(",")}};
    assert(actual.size() == expected.size());
    for (std::size_t i = 0; i < actual.size(); ++i) for (std::size_t j = 0; j < 12; ++j)
        assert(std::abs(actual[i][j] - expected[i][j]) < 1e-12);
    const double version = camera.world_matrix_version;
    scalar(&bbl::CameraRecord::alpha, std::numeric_limits<double>::quiet_NaN());
    scalar(&bbl::CameraRecord::alpha, std::numeric_limits<double>::quiet_NaN());
    assert(camera.world_matrix_version == version + 2);
    const auto non_finite_handle = bbl::create_arc_rotate_camera(engine, 0, 1, 5, {});
    auto& non_finite = engine.cameras[non_finite_handle.value];
    bbl::write_camera_scalar(non_finite, &bbl::CameraRecord::beta, std::numeric_limits<double>::quiet_NaN());
    bbl::write_camera_scalar(non_finite, &bbl::CameraRecord::radius, std::numeric_limits<double>::quiet_NaN());
    non_finite.inertial_alpha_offset = 1; non_finite.inertial_radius_offset = 1;
    bbl::upstream::apply_arc_rotate_inertia(non_finite);
    assert(std::isnan(non_finite.beta) && std::isnan(non_finite.radius));
    assert(non_finite.world_matrix_version == ${nonFinite.worldMatrixVersion});
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", join(output, "include"), fixture, ...sources]);
    execFileSync(executable);
});

test("camera compiler writes preserve the original owner, scalar snapshots and vector aliases", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const source = `import {createEngine,createArcRotateCamera,setCameraLimits} from "babylon-lite";
        import type { Camera } from "babylon-lite";
        const engine = await createEngine({});
        const first = createArcRotateCamera(0,1,5,{x:0,y:0,z:0});
        const second = createArcRotateCamera(1,1,5,{x:0,y:0,z:0});
        let current = first;
        const originalTarget = current.target;
        function switchCamera(): number { current = second; return 2; }
        current.alpha += switchCamera();
        if (first.alpha !== 2 || second.alpha !== 1) throw new Error("compound owner changed");
        originalTarget.x = 3;
        originalTarget.set(4,5,6);
        if (first.target.x !== 4 || second.target.x !== 0) throw new Error("vector alias retargeted");
        function write(camera: Camera): void { camera.target.y += 2; camera.radius = 6; }
        write(first);
        function returnedTarget(camera) { return camera.target; }
        const returned = returnedTarget(first);
        returned.z += 1;
        if (first.target.z !== 7) throw new Error("returned target alias lost");
        setCameraLimits(first, { upperRadiusLimit: 6 });
        const assigned = first.radius = 10;
        const postfix = first.radius++;
        const prefix = ++first.radius;
        if (assigned !== 10 || postfix !== 6 || prefix !== 7 || first.radius !== 6) throw new Error("assignment completion changed");
        if (first.target.y !== 7) throw new Error("helper write lost");
        let calls = 0;
        let setCurrent = first;
        function getCamera() { calls++; return setCurrent; }
        function switchSetCamera() { setCurrent = second; return 2; }
        getCamera().target.set(switchSetCamera(), first.target.x, first.target.y);
        if (calls !== 1 || first.target.x !== 2 || first.target.y !== 4 || first.target.z !== 7 || second.target.x !== 0)
            throw new Error("set receiver or argument order changed");
    `;
    const compiled = compileSource(source).cpp;
    const output = resolve("artifacts/camera-mutations-compiler");
    const sources = cameraSources(output);
    writeFileSync(join(output, "program.hpp"), compiled);
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include <bblite/runtime.hpp>
#define main generated_main
#include "program.hpp"
#undef main
namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
int main() { return generated_main(); }
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", join(output, "include"), fixture, ...sources]);
    execFileSync(executable);
});

test("camera setter lowering consumes pin changes and refuses unrepresented dirty behavior", () => {
    class EditedStore extends UpstreamSourceStore {
        constructor(private readonly module: string, private readonly edit: (source: string) => string) { super(); }
        override getSourceFile(module: string): ts.SourceFile {
            return module === this.module ? ts.createSourceFile(module, this.edit(super.getSource(module)), ts.ScriptTarget.Latest, true) : super.getSourceFile(module);
        }
    }
    const mutated = new CameraMutationLowerer(new LoweringContext(new EditedStore("src/math/observable-vec3.ts",
        (source) => source.replace("this._x = x;\n        this._y = y;\n        this._z = z;\n        this._onDirty();", "this._x = x + 2;\n        this._y = y;\n        this._z = z;\n        this._onDirty();")))).setters();
    assert.match(mutated, /value.x \+ 2.0/);
    assert.throws(() => new CameraMutationLowerer(new LoweringContext(new EditedStore("src/camera/arc-rotate.ts",
        (source) => source.replace("onDirty();", "onDirty(); unknownHook();")))).setters(), /unknownHook/);
});

test("native camera animation uses the pinned scalar setter and limit hook on each seek", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const { createArcRotateCamera } = await importPinnedModule<{
        createArcRotateCamera(a: number, b: number, r: number, target: object): PinCamera;
    }>("camera/arc-rotate.js");
    const { setCameraLimits } = await importPinnedModule<{
        setCameraLimits(camera: PinCamera, limits: object): () => void;
    }>("camera/arc-rotate-controls.js");
    const { createAnimationManager } = await importPinnedModule<{ createAnimationManager(): object }>("animation/animation-manager.js");
    const { createPropertyAnimationClip, createPropertyAnimationGroup } = await importPinnedModule<{
        createPropertyAnimationClip(name: string, tracks: object[], options: object): object;
        createPropertyAnimationGroup(manager: object, target: object, clip: object, options: object): object;
    }>("animation/property-animation.js");
    const { goToFrame } = await importPinnedModule<{ goToFrame(group: object, frame: number): void }>("animation/animation-group.js");
    const camera = createArcRotateCamera(0, 1, 5, { x: 0, y: 0, z: 0 });
    setCameraLimits(camera, { upperAlphaLimit: 1 });
    const clip = createPropertyAnimationClip("alpha", [{ path: "alpha", keys: [{ frame: 0, value: 0 }, { frame: 10, value: 4 }] }], { frameRate: 10 });
    const group = createPropertyAnimationGroup(createAnimationManager(), camera, clip, { loop: false });
    goToFrame(group, 5); goToFrame(group, 5);
    assert.equal(camera.worldMatrixVersion, 4);
    const program = compileSource(`import {createEngine,createArcRotateCamera,setCameraLimits,
        createAnimationManager,createPropertyAnimationClip,createPropertyAnimationGroup,goToFrame} from "babylon-lite";
        const engine=await createEngine({}); const camera=createArcRotateCamera(0,1,5,{x:0,y:0,z:0});
        setCameraLimits(camera,{upperAlphaLimit:1}); const manager=createAnimationManager({engine});
        const clip=createPropertyAnimationClip("alpha",[{path:"alpha",keys:[{frame:0,value:0},{frame:10,value:4}]}],{frameRate:10});
        const group=createPropertyAnimationGroup(manager,camera,clip,{loop:false}); goToFrame(group,5);goToFrame(group,5);
    `).cpp.replace("        return 0;", `        assert(v_engine.cameras[v_camera.value].world_matrix_version == ${camera.worldMatrixVersion});\n        assert(v_engine.cameras[v_camera.value].alpha == ${camera.alpha});\n        return 0;`);
    const output = resolve("artifacts/camera-mutations-animation");
    const sources = cameraSources(output);
    const animation = new AnimationLowerer(new LoweringContext()).lowerPropertyAnimation({ cameraVersions: true });
    writeFileSync(join(output, "include/bblite/upstream/property_animation.hpp"), animation.header);
    writeFileSync(join(output, "animation.cpp"), animation.source);
    writeFileSync(join(output, "program.hpp"), program);
    const fixture = join(output, "check.cpp");
    writeFileSync(fixture, `#include <bblite/runtime.hpp>\n#include <cassert>
#define main generated_main
#include "program.hpp"
#undef main
namespace bbl { Engine create_engine(EngineOptions) { return {}; } void mark_mesh_runtime_transform(Engine&, MeshHandle) {} }
int main() { return generated_main(); }
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", "/I", join(output, "include"), fixture, ...sources, join(output, "animation.cpp")]);
    execFileSync(executable);
});

test("TAA refuses lost camera ownership and late construction while preserving ordinary source shapes", () => {
    const prefix = `import {createEngine,createSceneContext,createArcRotateCamera,createFreeCamera,
        createRenderTarget,createRenderTask,createTaaPostProcessTask,registerScene,unregisterScene,startEngine,
        addTask,addTaskAtStart,rebuildSceneRenderables,registerSceneWithShadowSupport,attachControl} from "babylon-lite";
        const engine=await createEngine({}); const scene=createSceneContext(engine,{defaultRenderTask:false});
        const camera=createArcRotateCamera(0,1,5,{x:0,y:0,z:0}); scene.camera=camera;
        const rt=createRenderTarget({format:engine.format,size:engine,samples:1});
        const source=createRenderTask({rt},engine,scene);`;
    const taa = `const taa=createTaaPostProcessTask({sourceTexture:rt,sourceRenderTask:source,targetTexture:engine.scRT},engine,scene);`;
    for (const body of [
        `camera.target={x:1,y:0,z:0};`,
        `const alias=camera; alias.target={x:1,y:0,z:0};`,
        `function replace(c){c.target={x:1,y:0,z:0};}replace(camera);`,
        `const bag={t:camera.target};bag.t.x=3;`,
        `const t=camera.target;const bag={t};bag.t.x=3;`,
        `const target=camera.target;target.x %= 2;`,
        `const target=camera.target;target.x |= 1;`,
        `const bag={cam:camera};bag.cam.target.x %= 2;`,
        `const target=camera.target;target["x"]=2;`,
        `const target=camera.target;const k="x";target[k]=2;`,
        `Object.assign(camera,{alpha:2});`,
        `Object.assign(camera.target,{x:2});`,
        `const target=camera.target;Object.assign(target,{x:2});`,
        `attachControl(camera,engine.canvas,scene);const alias=camera;attachControl(alias,engine.canvas,scene);`,
    ]) {
        assert.doesNotThrow(() => compileSource(prefix + body));
        assert.throws(() => compileSource(prefix + body + taa), /input.ts:\d+:\d+: TAA requires tracked camera mutations:/);
        assert.throws(() => compileSource(prefix + taa + body), /TAA requires tracked camera mutations:/);
    }
    assert.throws(() => compileSource(prefix + `createFreeCamera([0,0,0],[0,0,1]);` + taa), /does not cover 'camera:free'/);
    assert.throws(() => compileSource(prefix + `await registerScene(scene);await startEngine(engine);` + taa), /TAA task creation after frame execution/);
    assert.throws(() => compileSource(prefix + `await registerScene(scene);` + taa), /TAA tasks must be constructed and attached before initial scene registration/);
    assert.throws(() => compileSource(prefix + `await registerSceneWithShadowSupport(scene);` + taa), /TAA tasks must be constructed and attached before initial scene registration/);
    assert.throws(() => compileSource(prefix + taa + `await registerSceneWithShadowSupport(scene);addTask(scene,taa);`), /TAA task record epochs.*addTask/);
    assert.throws(() => compileSource(prefix + taa + `await registerScene(scene);await startEngine(engine);attachControl(camera,engine.canvas,scene);`), /TAA supports one startup control attachment/);
    assert.throws(() => compileSource(prefix + taa + `await registerScene(scene);addTask(scene,taa);`), /TAA task record epochs.*addTask/);
    assert.throws(() => compileSource(prefix + `rebuildSceneRenderables(scene);` + taa), /TAA task record epochs.*rebuildSceneRenderables/);
    for (const operation of ["await registerScene(scene);", "unregisterScene(scene);", "addTask(scene,source);", "addTaskAtStart(scene,source);"]) {
        const startup = `addTask(scene,source);await registerScene(scene);await startEngine(engine);`;
        assert.doesNotThrow(() => compileSource(prefix + startup + operation));
        assert.throws(() => compileSource(prefix + taa + startup + operation), /input.ts:\d+:\d+: TAA task record epochs/);
    }
    assert.doesNotThrow(() => compileSource(prefix + taa + `addTask(scene,source);addTask(scene,taa);await registerScene(scene);await startEngine(engine);`));
    assert.doesNotThrow(() => compileSource(prefix + `function configuredScene() { ${taa} addTask(scene,taa); return scene; } await registerScene(configuredScene());`));
    assert.doesNotThrow(() => compileSource(prefix + `const target=camera.target; target.x=0; target.set(0,0,0);` + taa));
    assert.doesNotThrow(() => compileSource(prefix + `attachControl(camera,engine.canvas,scene);` + taa));
});
