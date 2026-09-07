import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { executeModuleGraph } from "../src/executed-module-graph.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { composeNodeMaterial } from "../src/pinned-node-material.js";
import { pinnedNodeVariantsHeader, nodeVariantStageStems } from "../src/pinned-node-material-cpp.js";
import { materialTextureSlotsHeader, pinnedSharedVariantDecls } from "../src/pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const prefix = `
import { createEngine, createSceneContext, parseNodeMaterialFromSnippet,
    loadNodeBlockEmitterWithGeometry, createSolidTexture2D, registerScene,
    onBeforeRender, addToScene, createBox, rebuildSceneRenderables, createTexture2DFromPixels,
    type NodeMaterial, type NodeInputHandle, type Texture2D } from "@babylonjs/lite";
import { SCENE149_NME_JSON } from "./corpus/babylon-lite/lab/lite/src/shared/scene149-nme";
const engine = await createEngine({});
const scene = createSceneContext(engine);
const texture = createSolidTexture2D(engine, 0.2, 0.4, 0.6, 1);
const material = await parseNodeMaterialFromSnippet(engine, "", {
    json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry });
`;

const ownershipSource = `${prefix}
        function input(owner: NodeMaterial): NodeInputHandle { return owner.inputs.albedo!; }
        function set(slot: NodeInputHandle, value: Texture2D): void { slot.texture = value; }
        const inputs = material.inputs;
        const alias = inputs.albedo!;
        set(alias, texture);
        if (input(material) !== alias || alias.texture !== texture) throw new Error("slot alias lost");
        const bounds = new Float32Array([2]);
        const materials: NodeMaterial[] = [];
        for (let i = 0; i < bounds[0]!; i++) {
            const next = await parseNodeMaterialFromSnippet(engine, "", {
                json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry });
            next.inputs.albedo!.texture = texture;
            materials.push(next);
        }
        if (materials[0] === materials[1] || input(materials[0]!) === input(materials[1]!)) throw new Error("owner merged");
        const retained = input(materials[0]!);
        let current = retained;
        let calls = 0;
        function owner(): NodeInputHandle { calls++; return current; }
        function replacement(): Texture2D { current = input(materials[1]!); return texture; }
        retained.texture = null;
        current.texture = null;
        owner().texture = replacement();
        if (calls !== 1 || retained.texture !== texture) throw new Error("input owner order lost");
        if (retained.type !== "texture2d") throw new Error("input type lost");
        const initialized = await parseNodeMaterialFromSnippet(engine, "", {
            json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry,
            textures: {albedo: texture} });
        if (initialized === material || input(initialized).texture !== texture) throw new Error("initialized owner merged");
    `;

test("node inputs retain owners through maps, helpers and repeated closed graph construction", () => {
    const result = compileSource(ownershipSource);
    mkdirSync("artifacts/node-input-surface", { recursive: true });
    writeFileSync("artifacts/node-input-surface/program.cpp", result.cpp);
    assert.equal(result.manifest.nodeMaterials.length, 1);
    assert.equal(result.manifest.runtimeMaterialProfiles?.length, 1);
    assert.match(result.cpp, /for \(/);
    assert.match(result.cpp, /set_node_input_texture/);
    assert.match(result.cpp, /node_material_inputs/);
    // A graph first reached inside the runtime loop has the same profile
    // semantics as a graph also constructed before that loop.
    const firstReach = compileSource(prefix.slice(0, prefix.indexOf("const material =")) + `
        const counts = new Float32Array([2]);
        const owners: NodeMaterial[] = [];
        for (let i = 0; i < counts[0]!; ++i) {
            const next = await parseNodeMaterialFromSnippet(engine, "", {
                json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry });
            next.inputs.albedo!.texture = texture;
            owners.push(next);
        }
        if (owners[0] === owners[1]) throw new Error("first graph owner merged");
    `);
    assert.equal(firstReach.manifest.nodeMaterials.length, 1);
    assert.equal(firstReach.manifest.runtimeMaterialProfiles?.length, 1);
});

const tools = optionalNativeFixtureTools(false);

test("actual pinned node builders retain private slots and start the complete failing batch", async () => {
    interface Input { type: string; texture?: object | null }
    interface Material { inputs: Record<string, Input> }
    const node = await importPinnedModule<{ parseNodeMaterialFromSnippet(engine: unknown, snippet: string, options: unknown): Promise<Material> }>("material/node/node-material.js");
    const loader = await importPinnedModule<{ loadNodeBlockEmitterWithGeometry(name: string): Promise<unknown> }>("material/node/node-geometry-block-loader.js");
    const core = await importPinnedModule<{
        createSceneContext(surface: unknown, options: unknown): { _deferredBuilders: unknown[]; _materialSwapQueue: unknown[] };
        addToScene(scene: unknown, entity: unknown): void;
        buildScene(scene: unknown): Promise<void>;
    }>("scene/scene-core.js");
    const bindings: Array<{ entries: Array<{ resource: unknown }> }> = [];
    const record = (descriptor: unknown) => ({ descriptor });
    const engine = { format: "bgra8unorm", msaaSamples: 4, _device: {
        createShaderModule: record, createBindGroupLayout: record, createPipelineLayout: record, createRenderPipeline: record,
        createBuffer: record, createBindGroup: (descriptor: { entries: Array<{ resource: unknown }> }) => { bindings.push(descriptor); return descriptor; },
        queue: { writeBuffer() {} },
    } };
    const json = await executeModuleGraph({ modulePath: "corpus/babylon-lite/lab/lite/src/shared/scene149-nme.ts", exportName: "SCENE149_NME_JSON" });
    const create = () => node.parseNodeMaterialFromSnippet(engine, "", { json, blockLoader: loader.loadNodeBlockEmitterWithGeometry });
    const scene = () => core.createSceneContext({ engine }, { defaultRenderTask: false });
    const mesh = (material: Material) => ({ material, _gpu: {}, worldMatrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), worldMatrixVersion: 0 });
    const a = await create(), b = await create();
    const first = { view: {}, sampler: {} }, second = { view: {}, sampler: {} };
    const slot = a.inputs.albedo!;
    assert.notEqual(slot, b.inputs.albedo);
    assert.equal(slot.texture, null);
    const ctx = scene();
    core.addToScene(ctx, mesh(a));
    slot.texture = first;
    b.inputs.albedo!.texture = second;
    a.inputs.albedo = b.inputs.albedo!;
    core.addToScene(ctx, mesh(b));
    assert.equal(ctx._deferredBuilders.length, 2);
    await core.buildScene(ctx);
    assert(bindings[0]!.entries.some((entry) => entry.resource === first.view));
    assert(bindings[1]!.entries.some((entry) => entry.resource === second.view));
    slot.texture = second;
    assert(bindings[0]!.entries.some((entry) => entry.resource === first.view));
    const missing = await create(), valid = await create();
    valid.inputs.albedo!.texture = second;
    const failing = scene();
    core.addToScene(failing, mesh(missing));
    core.addToScene(failing, mesh(valid));
    await assert.rejects(core.buildScene(failing), /albedo|243/);
    assert.equal(bindings.length, 3, "the valid second group still binds in the failing batch");
    assert(bindings[2]!.entries.some((entry) => entry.resource === second.view));
    // Options-only owners use the same deferred group lifecycle even when
    // source code never reads their public input map.
    const initialized = await node.parseNodeMaterialFromSnippet(engine, "", {
        json, blockLoader: loader.loadNodeBlockEmitterWithGeometry, textures: { albedo: first },
    });
    const built = scene();
    await core.buildScene(built);
    core.addToScene(built, mesh(initialized));
    assert.equal(built._deferredBuilders.length, 0);
    assert.equal(built._materialSwapQueue.length, 1, "late attachment uses the pin's material-swap lifecycle");
    assert.equal(bindings.length, 3, "late attachment cannot bind until its pending material swap runs");
    await core.buildScene(built);
    assert.equal(bindings.length, 4);
    assert(bindings[3]!.entries.some((entry) => entry.resource === first.view));
});

test("generated compiler and node factory preserve retained slots and deferred binding observations", { skip: !tools }, async () => {
    const output = resolve("artifacts/node-input-native");
    const includes = join(output, "bblite/upstream");
    mkdirSync(includes, { recursive: true });
    writeFileSync(join(output, "program.hpp"), compileSource(ownershipSource).cpp);
    const context = new LoweringContext();
    const factory = new FactoryLowerer(context);
    const graph = await executeModuleGraph({ modulePath: "corpus/babylon-lite/lab/lite/src/shared/scene149-nme.ts", exportName: "SCENE149_NME_JSON" });
    const composed = await composeNodeMaterial(graph, "input lifecycle", { pinnedBlockLoader: "geometry" });
    writeFileSync(join(includes, "node_variants.hpp"), pinnedNodeVariantsHeader("input lifecycle", [{ index: 0, ...nodeVariantStageStems(0), composed }], []));
    writeFileSync(join(includes, "pinned_variant_bindings.hpp"), pinnedSharedVariantDecls(context, "input lifecycle"));
    writeFileSync(join(includes, "material_texture_slots.hpp"), materialTextureSlotsHeader({ transmission: false, clearcoat: false, sheen: false, iridescence: false,
        lightmap: false, metallicReflectanceMap: false, reflectanceMap: false, specularGlossiness: false, occlusionUv2: false, standardBump: false,
        standardReflection: false, clusteredLights: false, vat: false, vatInstances: false }, [], "input lifecycle"));
    writeFileSync(join(output, "node_factory.hpp"), factory.lowerNodeMaterialFactory().source);
    const solid = factory.lowerFileTextureFactory().source;
    const scene = new SceneLowerer(context).lowerCore({ nodeMaterials: true }).source;
    writeFileSync(join(output, "lifecycle.hpp"), `namespace bbl {\n` + [
        cppFunction(solid, "SolidTexture create_solid_texture("), cppFunction(solid, "FileTexture solid_texture_file("),
        ...["void require_scene_engine(", "std::uint32_t material_family_bit(", "std::uint32_t scene_material_families(",
            "Scene create_scene_context(Engine&", "void add_to_scene(Scene& scene, MeshHandle", "void drain_scene_deferred_builders(",
            "void register_scene(", "void unregister_scene(", "void dispose_scene("].map((signature) => cppFunction(scene, signature)),
    ].join("\n") + "\n}");
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", "/fp:precise", `/Fo:${output}\\`, `/Fe:${executable}`,
        "/I", output, "/I", "native/include", "test/fixtures/node-input-lifecycle.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /node-input-lifecycle: ok/);
});

test("node input state refuses numeric, reflective and late binding mutation at its source", () => {
    for (const [body, expected] of [
        ["material.inputs.albedo!.value = 2;", /numeric uniforms/],
        ["const slot = material.inputs.albedo!; slot['texture'] = texture;", /computed mutation/],
        ["Object.assign(material.inputs.albedo!, {texture});", /Reflective node input/],
        ["const inputs = material.inputs; inputs.albedo = inputs.albedo!;", /input map replacement/],
        ["function replace(inputs: Record<string, NodeInputHandle>) { inputs['albedo'] = inputs.albedo!; } replace(material.inputs);", /input map replacement/],
        ["Object.assign(material.inputs, {albedo: material.inputs.albedo});", /Reflective node input/],
        ["Object.assign(material, {inputs: {}});", /Reflective node input/],
        ["delete material.inputs.albedo;", /input map replacement/],
        ["await registerScene(scene); material.inputs.albedo!.texture = texture;", /before scene registration/],
        ["onBeforeRender(scene, () => { material.inputs.albedo!.texture = texture; });", /before scene registration/],
        ["material.inputs.albedo!.texture = texture; rebuildSceneRenderables(scene);", /binding snapshots/],
        ["material.inputs.albedo!.texture = texture; await registerScene(scene); const mesh = createBox(engine); mesh.material = material;", /binding snapshots/],
        ["material.inputs.albedo!.texture = texture; const mesh = createBox(engine); await registerScene(scene); addToScene(scene, mesh);", /binding snapshots/],
        ["material.inputs.albedo!.texture = texture; const other = createSceneContext(engine); await registerScene(scene); await registerScene(other);", /one registered scene/],
        ["material.inputs.albedo!.texture = texture; Object.assign(texture, {uOffset: .5});", /reflective texture producer/],
        ["const pixels = createTexture2DFromPixels(engine, new Uint8Array([1,2,3,4]), 1, 1); material.inputs.albedo!.texture = texture; pixels.uOffset = .5;", /texture producer metadata/],
        ["const bytes = new Uint8Array([1,2,3,4]); const pixels = createTexture2DFromPixels(engine, bytes, 1, 1); material.inputs.albedo!.texture = texture; const device = engine._device; device.queue.writeTexture({texture: pixels.texture}, bytes, {bytesPerRow:4,rowsPerImage:1}, {width:1,height:1});", /later GPU writes/],
    ] as const) assert.throws(() => compileSource(prefix + body), expected);
});

test("options-only node materials enforce deferred binding boundaries without public input reads", () => {
    const setup = prefix.slice(0, prefix.indexOf("const material ="));
    const factory = `const material = await parseNodeMaterialFromSnippet(engine, "", {
        json: SCENE149_NME_JSON, blockLoader: loadNodeBlockEmitterWithGeometry,
        textures: { albedo: texture } });`;
    const result = compileSource(setup + factory + `
        const mesh = createBox(engine); mesh.material = material;
        addToScene(scene, mesh); await registerScene(scene);`);
    assert(result.manifest.features.includes("material:node"));
    assert(!result.manifest.features.includes("material:node-inputs"));
    for (const [before, after, expected] of [
        ["", "const mesh = createBox(engine); mesh.material = material; await registerScene(scene); const alias = scene; addToScene(alias, mesh);", /binding snapshots/],
        ["", "const mesh = createBox(engine); await registerScene(scene); mesh.material = material;", /binding snapshots/],
        ["", "const mesh = createBox(engine); mesh.material = material; onBeforeRender(scene, () => { addToScene(scene, mesh); });", /binding snapshots/],
        ["", "rebuildSceneRenderables(scene);", /binding snapshots/],
        ["rebuildSceneRenderables(scene);", "", /binding snapshots/],
        ["", "Object.assign(texture, {uOffset: .5});", /reflective texture producer/],
        ["Object.assign(texture, {uOffset: .5});", "", /reflective texture producer/],
        ["", "const pixels = createTexture2DFromPixels(engine, new Uint8Array([1,2,3,4]), 1, 1); pixels.uOffset = .5;", /texture producer metadata/],
        ["", "const bytes = new Uint8Array([1,2,3,4]); const pixels = createTexture2DFromPixels(engine, bytes, 1, 1); const device = engine._device; device.queue.writeTexture({texture: pixels.texture}, bytes, {bytesPerRow:4,rowsPerImage:1}, {width:1,height:1});", /later GPU writes/],
    ] as const) {
        assert.throws(() => compileSource(setup + before + factory + after, {
            fileName: resolve("options-only-node-boundary.ts"),
        }), (error: unknown) => {
            assert(error instanceof Error);
            assert.match(error.message, expected);
            assert.match(error.message, /options-only-node-boundary\.ts:\d+:\d+:/);
            return true;
        });
    }
    // Immutable options keep the existing multiple-scene setup available.
    assert.doesNotThrow(() => compileSource(setup + factory + `
        const other = createSceneContext(engine);
        const first = createBox(engine); const second = createBox(engine);
        first.material = material; second.material = material;
        addToScene(scene, first); addToScene(other, second);
        await registerScene(scene); await registerScene(other);`));
    // The deferred admission record must stay inert for ordinary materials.
    assert.doesNotThrow(() => compileSource(setup + `
        const mesh = createBox(engine); await registerScene(scene); addToScene(scene, mesh);`));
});
