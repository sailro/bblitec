import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { meshProfileBindingCpp } from "../src/lowering/resource-profiles.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

function scene(body: string, helpers = ""): string {
    return `
        import {
            createEngine, createSceneContext, createBox, createSphere, cloneTransformNode,
            createStandardMaterial, createPbrMaterial, addToScene,
            createShaderMaterial, setShaderFloat, onBeforeRender,
            createDirectionalLight, createPcfDirectionalShadowGenerator,
            registerScene, startEngine,
        } from "@babylonjs/lite";
        import type { EngineContext, Mesh, Material, ShaderMaterial } from "@babylonjs/lite";
        ${helpers}
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            ${body}
        }
    `;
}

function shaderChoiceSource(selection: string, tail = ""): string {
    return scene(`
        const a = createShaderMaterial({ name: "choice-a", vertexSource, fragmentSource,
            attributes: ["position"], uniforms: ["viewProjection", "world"] });
        const b = createShaderMaterial({ name: "choice-b", vertexSource, fragmentSource: otherFragmentSource,
            attributes: ["position"], uniforms: ["viewProjection", "world"] });
        const mesh = createBox(engine);
        setThinInstances(mesh, new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 3,0,0,1]), 1);
        const gate = new Float32Array([1]);
        const materials: ShaderMaterial[] = [a, b];
        mesh.material = ${selection};
        ${tail}
    `, `
        import { setThinInstances } from "@babylonjs/lite";
        const vertexSource = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            let instance = mat4x4<f32>(input.world0, input.world1, input.world2, input.world3);
            out.position = shaderSystem.viewProjection * (shaderSystem.world * instance) * vec4<f32>(input.position, 1.0);
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(1.0);
        }\`;
        const otherFragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(0.5);
        }\`;
    `);
}

test("native loops assign independent clone handles to one composition profile", () => {
    const result = compileSource(scene(`
        const source = createBox(engine);
        const count = new Float32Array([3]);
        const clones: Mesh[] = [];
        for (let i = 0; i < count[0]!; ++i) {
            const clone = cloneTransformNode(source) as Mesh;
            clone.position.x = i;
            clones.push(clone);
        }
    `));
    assert.equal(result.manifest.sceneMeshes.filter(mesh => mesh.kind === "mesh-clone" && mesh.runtimeInstances).length, 1);
    assert.match(result.cpp, /bind_scene_mesh_profile\([^\n]+clone_mesh_node\(/);
    assert.equal(result.cpp.match(/clone_mesh_node\(/g)?.length, 1);
});

test("live ShaderMaterial choices propagate instance lanes to every candidate", () => {
    for (const selection of ["gate[0]! > 0 ? a : b", "materials[gate[0]!]!"]) {
        const result = compileSource(shaderChoiceSource(selection));
        assert.deepEqual(result.manifest.sceneMeshes[0]?.shaderVariants, ["choice-a", "choice-b"]);
        assert.deepEqual(result.manifest.customShaderPrograms.map(program => [program.name, program.useThinInstances]),
            [["choice-a", true], ["choice-b", true]]);
    }
});

test("every candidate in a live shader choice retains the incompatible-lane refusal", () => {
    assert.throws(() => compileSource(shaderChoiceSource("gate[0]! > 0 ? a : b",
        "const other = createBox(engine); other.material = b;")), /disagree about thin instances/);
});

test("conditional shader writes retain earlier alternatives without retaining overwritten static ones", () => {
    const conditional = compileSource(shaderChoiceSource("a", "if (gate[0]! > 0) mesh.material = b;"));
    assert.deepEqual(conditional.manifest.sceneMeshes[0]?.shaderVariants, ["choice-a", "choice-b"]);
    assert.ok(conditional.manifest.customShaderPrograms.every(program => program.useThinInstances));
    const replaced = compileSource(shaderChoiceSource("a", "mesh.material = b;"));
    assert.equal(replaced.manifest.customShaderPrograms.find(program => program.name === "choice-a")?.useThinInstances, undefined);
    assert.equal(replaced.manifest.customShaderPrograms.find(program => program.name === "choice-b")?.useThinInstances, true);
});

const nativeLoop = scene(`
    const count = new Float32Array([6]);
    for (let i = 0; i < count[0]!; i++) {
        if (i === 1) continue;
        if (i === 4) break;
        const mesh = createBox(engine, i + 1);
        mesh.position.x = i;
        mesh.material = createStandardMaterial();
        addToScene(scene, mesh);
    }
`);

test("variable native construction records call-site profiles, not singleton allocations", () => {
    const result = compileSource(nativeLoop);
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.equal(result.manifest.sceneMeshes[0]?.runtimeInstances, true);
    assert.equal(result.manifest.sceneMeshes[0]?.standardMaterial, true);
    assert.deepEqual(result.manifest.runtimeMaterialProfiles, [0]);
    assert.match(result.cpp, /bind_scene_mesh_profile\(/);
    assert.match(result.cpp, /continue;/);
    assert.match(result.cpp, /break;/);
});

test("runtime mesh profiles do not invent a renderer for undrawn resources", () => {
    const result = compileSource(scene(`
        const count = new Float32Array([3]);
        for (let i = 0; i < count[0]!; i++) createBox(engine);
    `));
    assert.ok(!result.manifest.features.includes("renderer:scene"));
    assert.doesNotMatch(result.cpp, /#include <bblite\/upstream\/renderer_plan.hpp>/);
});

test("native material choices preserve fixed geometry counts and all PBR candidates", () => {
    const result = compileSource(scene(`
        const materials = [
            createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 }),
            createPbrMaterial({ metallicFactor: 1, roughnessFactor: 0.25 }),
        ];
        const meshes: Mesh[] = [];
        for (let i = 0; i < 2500; i++) {
            const mesh = createSphere(engine, { diameter: 2, segments: 32 });
            mesh.position.set(i, 0, 0);
            mesh.material = materials[i % 2]!;
            meshes.push(mesh);
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 2500);
    assert.equal(result.manifest.sceneMaterialCount, 2);
    assert.equal(result.cpp.match(/bbl::create_sphere\(/g)?.length, 1);
    assert.ok(Buffer.byteLength(result.cpp) < 10000);
    assert.deepEqual(result.manifest.scenePbrMaterials.map((material) => material.materialsBefore), [0, 1]);
    assert.ok(result.manifest.scenePbrMaterials.every((material) => material.unknownSceneMesh));
});

test("a runtime mesh profile keeps an earlier PBR material's physical slot", () => {
    const result = compileSource(scene(`
        createStandardMaterial();
        const pbr = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        const count = new Float32Array([3]);
        for (let i = 0; i < count[0]!; i++) {
            const mesh = createBox(engine);
            mesh.material = pbr;
            createStandardMaterial();
        }
    `));
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 1);
    assert.equal(result.manifest.scenePbrMaterials[0]?.unknownSceneMesh, true);
    assert.deepEqual(result.manifest.runtimeMaterialProfiles, [2]);
});

test("runtime branches and retained callbacks cannot allocate untracked PBR slots", () => {
    for (const body of [
        `if (Math.random() < 0.5) createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });`,
        `onBeforeRender(scene, () => { createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 }); });`,
    ]) {
        assert.throws(() => compileSource(scene(body)), /generation-known iteration count for PBR material slots/);
    }
});

test("mixed-family runtime selections do not borrow the Standard branch's identity", () => {
    const result = compileSource(scene(`
        const standard = createStandardMaterial();
        const pbr = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        const light = createDirectionalLight([-1, -1, -1], 1);
        addToScene(scene, light);
        createPcfDirectionalShadowGenerator(engine, light);
        for (let i = 0; i < 300; i++) {
            const material = i % 2 === 0 ? standard : pbr;
            const mesh = createBox(engine);
            mesh.material = material;
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 300);
    assert.equal(result.manifest.scenePbrMaterials[0]?.materialsBefore, 1);
    assert.equal(result.manifest.scenePbrMaterials[0]?.unknownSceneMesh, true);
    assert.ok(result.manifest.sceneMeshes.every((mesh) => mesh.standardMaterial));
    assert.equal(result.manifest.shadowGenerators[0]?.dynamicCasters, true);
});

test("runtime material collections withdraw a prototype's singleton PBR identity", () => {
    const result = compileSource(scene(`
        const first = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
        const second = createPbrMaterial({ metallicFactor: 1, roughnessFactor: 0.25 });
        const materials: Material[] = [first];
        const count = new Float32Array([3]);
        for (let i = 0; i < count[0]!; i++) materials.push(second);
        for (const material of materials) {
            const mesh = createBox(engine);
            mesh.material = material;
        }
    `));
    assert.ok(result.manifest.scenePbrMaterials.every((material) => material.unknownSceneMesh));
});

test("guarded helper construction uses a profile while specialization remains checked", () => {
    const result = compileSource(scene(`
        const count = new Float32Array([3]);
        for (let i = 0; i < count[0]!; i++) spawn(engine, i);
    `, `
        function spawn(engine: EngineContext, value: number): void {
            if (value < 1) return;
            createBox(engine, value);
        }
    `));
    assert.equal(result.manifest.sceneMeshes.length, 1);
    assert.equal(result.manifest.sceneMeshes[0]?.runtimeInstances, true);
    assert.throws(() => compileSource(scene(`
        const count = new Float32Array([3]);
        for (let i = 0; i < count[0]!; i++) createSphere(engine, { segments: i + 3 });
    `)), /segments|static|generation/);
});

test("runtime ShaderMaterial instances update their own handles rather than a shared slot", () => {
    const result = compileSource(scene(`
        const count = new Float32Array([3]);
        const materials: ShaderMaterial[] = [];
        for (let i = 0; i < count[0]!; i++) {
            const material = createShaderMaterial({
                name: "native-profile",
                vertexSource,
                fragmentSource,
                attributes: ["position"],
                uniforms: ["worldViewProjection", { name: "time", type: "f32", defaultValue: 0 }],
            });
            setShaderFloat(material, "time", i);
            materials.push(material);
        }
        for (const material of materials) setShaderFloat(material, "time", 7);
    `, `
        const vertexSource = \`struct VertexOutput { @builtin(position) position: vec4<f32>, };
        @vertex fn mainVertex(input: VertexInput) -> VertexOutput {
            var out: VertexOutput;
            out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0);
            return out;
        }\`;
        const fragmentSource = \`@fragment fn mainFragment() -> @location(0) vec4<f32> {
            return vec4<f32>(shaderUniforms.time);
        }\`;
    `));
    assert.deepEqual(result.manifest.shaderVariants, ["native-profile"]);
    assert.deepEqual(result.manifest.runtimeMaterialProfiles, [0]);
    assert.equal(result.cpp.match(/bbl::set_shader_uniform_value\(/g)?.length, 2);
    assert.doesNotMatch(result.cpp, /remember_scene_material|set_scene_shader_uniform_value/);
});

const listenerLoop = `
    const root = document.createElement("div");
    root.innerHTML = '<button class="action" id="start">Start</button><button class="action" id="other">Other</button>';
    document.body.appendChild(root);
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(".action"));
    for (const button of buttons) {
        button.addEventListener("click", () => {
            const light = createDirectionalLight([-1, -2, -1], 1);
            addToScene(scene, light);
            createPcfDirectionalShadowGenerator(engine, light);
            onBeforeRender(scene, () => {
                const nested = createDirectionalLight([1, -2, 1], 1);
                addToScene(scene, nested);
                createPcfDirectionalShadowGenerator(engine, nested);
            });
        });
    }
    await registerScene(scene);
    await startEngine(engine);
`;

test("listener registration does not execute nested retained construction in its loop", () => {
    const result = compileSource(scene(listenerLoop));
    assert.equal(result.manifest.shadowGenerators.length, 2);
    assert.match(result.cpp, /bbl::ui_on_click\(/);
});

test("retained construction cannot hide actual ordinal creation in the registering loop", () => {
    assert.throws(() => compileSource(scene(listenerLoop.replace(
        'button.addEventListener("click", () => {',
        `const direct = createDirectionalLight([-1, -1, -1], 1);
         addToScene(scene, direct);
         createPcfDirectionalShadowGenerator(engine, direct);
         button.addEventListener("click", () => {`,
    ))), /generation-known iteration count/);
});

const tools = optionalNativeFixtureTools();

test("native profile rows survive variable order, skipped profiles, clones and later allocation", { skip: !tools }, () => {
    const table = { sceneRows: [1, 3], staticRows: [0, 2], rowCount: 4 };
    const lowered = new RendererLowerer(new LoweringContext()).lowerRenderPlan({ meshProfiles: table });
    const from = lowered.source.indexOf("void initialize_composition_feature_rows");
    const through = lowered.source.indexOf("\nRenderPlan build_render_plan", from);
    assert.ok(from >= 0 && through > from);
    const output = resolve("artifacts", "runtime-resource-profile-check");
    mkdirSync(output, { recursive: true });
    const source = join(output, "profiles.cpp");
    writeFileSync(source, `#include <bblite/runtime.hpp>
#include <cassert>
#include <stdexcept>
namespace bbl::upstream {
${meshProfileBindingCpp(table)}
${lowered.source.slice(from, through)}
}
int main() {
    bbl::Engine engine;
    engine.meshes.resize(5);
    bbl::upstream::bind_scene_mesh_profile(engine, {1}, 1);
    bbl::upstream::bind_scene_mesh_profile(engine, {2}, 1);
    engine.meshes[4].feature_source_mesh = 2;
    bbl::upstream::initialize_composition_feature_rows(engine);
    const std::array<std::uint32_t, 5> expected{0, 3, 3, 2, 3};
    for (std::size_t i = 0; i < expected.size(); ++i) {
        assert(engine.meshes[i].composition_feature_row == expected[i]);
    }
    engine.meshes.emplace_back();
    bbl::upstream::bind_scene_mesh_profile(engine, {5}, 0);
    bbl::upstream::initialize_composition_feature_rows(engine);
    assert(engine.meshes[5].composition_feature_row == 1);
    bool refused = false;
    try { bbl::upstream::bind_scene_mesh_profile(engine, {5}, 2); }
    catch (const std::runtime_error&) { refused = true; }
    assert(refused);
}`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native\\include", source]);
    execFileSync(executable, { encoding: "utf8" });
});

test("native profile loops execute control flow and physical material allocation", { skip: !tools }, () => {
    const output = resolve("artifacts", "runtime-resource-profile-loop-check");
    const includes = join(output, "bblite", "upstream");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(nativeLoop).cpp);
    writeFileSync(join(includes, "renderer_plan.hpp"), `#pragma once
#include <bblite/runtime.hpp>
namespace bbl::upstream { MeshHandle bind_scene_mesh_profile(Engine&, MeshHandle, std::uint32_t); }
`);
    const source = join(output, "loop.cpp");
    writeFileSync(source, `#define main generated_profile_main
#include "program.hpp"
#undef main
#include <cassert>
namespace { std::size_t constructions = 0; std::size_t registrations = 0; }
namespace bbl {
${lowerMeshMaterialSetter(new LoweringContext())}
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) { Scene scene; scene.engine = &engine; return scene; }
MaterialHandle create_standard_material(Engine& engine) {
    const auto index = static_cast<std::uint32_t>(engine.materials.size());
    engine.materials.emplace_back();
    return {index};
}
MeshHandle create_box(Engine& engine, BoxOptions options) {
    const std::array<float, 3> widths{1, 3, 4};
    assert(constructions < widths.size() && options.width == widths[constructions]);
    ++constructions;
    const auto index = static_cast<std::uint32_t>(engine.meshes.size());
    engine.meshes.emplace_back();
    return {index};
}
void mark_mesh_dirty(Engine&, MeshHandle) {}
void add_to_scene(Scene& scene, MeshHandle mesh) {
    const std::array<float, 3> positions{0, 2, 3};
    assert(scene.engine && registrations < positions.size());
    const auto& record = scene.engine->meshes[mesh.value];
    assert(record.position.x == positions[registrations]);
    assert(record.material.value == registrations);
    assert(record.composition_feature_row == 0);
    ++registrations;
}
}
namespace bbl::upstream {
${meshProfileBindingCpp({ sceneRows: [0], staticRows: [], rowCount: 1 })}
}
int main() {
    assert(generated_profile_main() == 0);
    assert(constructions == 3 && registrations == 3);
}`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native\\include", source]);
    execFileSync(executable, { encoding: "utf8" });
});
