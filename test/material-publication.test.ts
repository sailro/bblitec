import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { cppFunction, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { lowerPbrMaterialGroups } from "../src/lowering/pbr-material-groups.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { pinnedSurfaceHeader } from "../src/lowering/pinned-surface.js";

test("material output publication and captured draw identity follow source frame boundaries", async t => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable"); return; }
    const context = new LoweringContext();
    const directory = resolve("artifacts/test-material-publication");
    mkdirSync(directory, {recursive: true});
    const declaration = (module: string, name: string): string => context.functionDeclaration(module, name).declaration.getText().replace(/^export /, "");
    const swap = "src/scene/scene-material-swap.ts";
    const renderTask = "src/frame-graph/render-task.ts";
    const pbr = context.functionDeclaration("src/material/pbr/pbr-renderable.ts", "buildPbrRenderables").declaration;
    const draw = context.variableInitializer(pbr, "drawWith");
    assert.ok(ts.isArrowFunction(draw) && ts.isBlock(draw.body));
    const guard = draw.body.statements[0]!.getText();
    const moduleSource = (module: string, omitOrder = false): string => context.sourceFile(module).statements
        .filter(node => !ts.isImportDeclaration(node) && !(omitOrder && ts.isVariableStatement(node) && node.declarationList.declarations[0]?.name.getText() === "byOrder"))
        .map(node => node.getText().replace(/^export /, "")).join("\n");

    // Complete source renderFrame and task bundle body establish the actual synchronous
    // submit boundary and distinguish cached opaque replay from a direct draw callback.
    const runSource = new Function(transpileCommonJs(`
        const require = () => ({A, B, C, X, rebuildScenePbrPipelines});
        const _lateCleanup = undefined;
        const _vis = 0, _refreshScRT = () => {}, flushGpuResourceRetirements = () => {};
        const retireGpuResources = (_engine, callback) => callback();
        ${declaration(swap, "processMaterialSwaps")}
        ${moduleSource("src/scene/scene-runtime-mesh-build.ts")}
        ${moduleSource("src/scene/scene-rebuild.ts", true)}
        ${declaration("src/mesh/thin-instance.ts", "buildRuntimeThinMesh")}
        ${declaration("src/engine/engine.ts", "renderFrame")}
        ${declaration(renderTask, "executePassBody")}
        ${declaration(renderTask, "drawList")}
        let scene, task, draws, pending;
        const makeOutput = (mesh, isOverride = false) => {
            const mat = mesh.material;
            return {mesh, order: 0, mat, draw: () => { ${guard} draws.push(mat.id); return 1; }};
        };
        return async (kind, opaque, direct) => {
            const first = kind.startsWith('first');
            const materials = [{id: 0}, {id: 1}], mesh = {material: materials[0], visible: true};
            const builder = Object.assign(async (_scene, meshes) => {
                if (kind === 'failure' && meshes.some(mesh => mesh.material.id === 1)) throw new Error('builder');
                return {renderables: meshes.map(mesh => makeOutput(mesh)), rebuildSingle: (_scene, mesh) => makeOutput(mesh)};
            }, {_materialFamily: 'pbr'});
            const group = [mesh]; group.r = (_scene, mesh) => makeOutput(mesh); group.o = [];
            scene = {meshes: [mesh], _groups: new Map(), _materialSwapQueue: [], _meshDisposables: new Map(),
                _renderables: [], _renderableVersion: 0, _materialEpoch: 0, _drawCallsPre: 0, camera: null,
                _built: true, _disposables: [], _frameGraph: {build() {}}};
            materials.forEach(material => material._buildGroup = builder);
            scene._groups.set(builder, group);
            if (!first) { const output = makeOutput(mesh); scene._renderables.push(output); group.o.push(output); }
            const encoder = {finish: () => ({})};
            const engine = {_cbs: [], surfaces: [{_renderingContexts: [scene]}],
                _device: {createCommandEncoder: () => encoder, queue: {submit() {}},
                    createRenderBundleEncoder: () => {
                        const start = draws.length;
                        return {setBindGroup() {}, setPipeline() {}, finish() { const recorded = draws.splice(start); return recorded; }};
                    }}};
            scene.surface = {engine};
            task = {scene, engine, _config: {rt: {_descriptor: {}}}, _targetSignature: {}, _ob: [], _sceneBG: {},
                _lastVersion: -1, _lastVis: -1, _opaqueBindings: [], _directBindings: [], _transparentBindings: []};
            const pass = {setBindGroup() {}, setPipeline() {}, executeBundles(bundles) { for (const bundle of bundles) draws.push(...bundle); }};
            const record = () => {
                if (task._lastVersion !== scene._renderableVersion) {
                    const bindings = scene._renderables.map(output => ({renderable: output, pipeline: null, draw: output.draw}));
                    task._opaqueBindings = opaque ? bindings : [];
                    task._directBindings = direct ? bindings : [];
                    task._transparentBindings = opaque || direct ? [] : bindings;
                }
                return executePassBody(task, pass);
            };
            scene._update = () => {}; scene._record = record;
            draws = []; renderFrame(engine, 16); // Prime the old opaque bundle.
            if (first) group.r = undefined;
            else if (kind.startsWith('gamma') || kind === 'failure') group._w = () => true;
            else if (kind.startsWith('thin')) mesh._runtimeThinBuild = buildRuntimeThinMesh;
            if (!first) mesh.material = materials[1];
            scene._materialSwapQueue.push(mesh);
            scene._update = () => { pending = processMaterialSwaps(scene); };
            draws = []; renderFrame(engine, 16);
            const before = draws.slice(), outputsBefore = scene._renderables.map(output => output.mat.id);
            if (kind.endsWith('cancel')) mesh.material = materials[0];
            if (kind === 'first-changed') mesh.material = materials[1];
            if (kind === 'first-removed') scene.meshes.length = 0;
            if (kind === 'first-disposed') scene._z = true;
            await pending;
            scene._update = () => { for (const callback of scene._beforeRender ?? []) callback(); };
            draws = []; let failed = false;
            try { renderFrame(engine, 16); } catch { failed = true; }
            return {before, outputsBefore, after: draws.slice(), outputsAfter: scene._renderables.map(output => output.mat.id), failed};
        };
    `, "material-publication-source.ts"))() as (kind: string, opaque: boolean, direct: boolean) => Promise<unknown>;

    const scenarios = ["first", "gamma", "thin", "single", "gamma-cancel", "thin-cancel", "first-changed", "first-removed", "first-disposed", "failure"]
        .flatMap(kind => [false, true].map(opaque => ({kind, opaque, direct: false})));
    scenarios.push({kind: "thin", opaque: false, direct: true}, {kind: "gamma", opaque: false, direct: true});
    const expected = [];
    for (const scenario of scenarios) expected.push(await runSource(scenario.kind, scenario.opaque, scenario.direct));
    const runSharedSource = new Function(transpileCommonJs(`
        const require = () => ({A, B, C, X, rebuildScenePbrPipelines});
        const _lateCleanup = undefined;
        const retireGpuResources = (_engine, callback) => callback();
        ${declaration(swap, "processMaterialSwaps")}
        ${moduleSource("src/scene/scene-runtime-mesh-build.ts")}
        ${moduleSource("src/scene/scene-rebuild.ts", true)}
        return async () => {
            const material = {id: 0}, mesh = {material};
            const builder = async (_scene, meshes) => ({
                renderables: meshes.map(mesh => ({mesh, mat: mesh.material})), rebuildSingle: () => {},
            });
            material._buildGroup = builder;
            const engine = {};
            const scenes = [0, 1].map(() => ({
                meshes: [mesh], _groups: new Map([[builder, [mesh]]]),
                _materialSwapQueue: [mesh], _meshDisposables: new Map(),
                _renderables: [], _renderableVersion: 0, _materialEpoch: 0,
                _built: true, _disposables: [], _frameGraph: {build() {}}, surface: {engine},
            }));
            const pending = scenes.map(processMaterialSwaps);
            scenes[0]._z = true;
            await Promise.all(pending);
            return scenes.map(scene => scene._renderables.map(output => output.mat.id));
        };
    `, "material-publication-shared-source.ts"))() as () => Promise<number[][]>;
    const sharedExpected = await runSharedSource();
    writeFileSync(resolve(directory, "source.json"), JSON.stringify(expected, null, 2));

    const cases = expected as {before: number[]; after: number[]; outputsBefore: number[]; outputsAfter: number[]; failed: boolean}[];
    const vector = (values: readonly number[]) => `std::vector<unsigned>{${values.join(",")}}`;
    const renderer = new RendererLowerer(context).lowerRenderPlan();
    writeFileSync(resolve(directory, "renderer-plan.hpp"), renderer.header);
    const headers = resolve(directory, "include/bblite/upstream"); mkdirSync(headers, {recursive: true});
    writeFileSync(resolve(headers, "pinned_surface.hpp"), pinnedSurfaceHeader(context, 4));
    writeFileSync(resolve(headers, "camera_math.hpp"), new CameraLowerer(context).lowerArcRotateFactory().header);
    const integrated = resolve(directory, "integrated.cpp"), integratedExecutable = resolve(directory, "integrated.exe");
    writeFileSync(integrated, `#include "renderer-plan.hpp"
    #include <bblite/js_data.hpp>
    #include <cassert>
    #include <iostream>
    namespace bbl::upstream {
    RenderItem bind_render_item(RenderItem item, const Engine& engine, MaterialHandle material) {
        item.material = material;
        item.bucket = engine.materials.at(material.value).alpha_mode == MaterialAlphaMode::blend ? RenderBucket::alpha_blend : RenderBucket::opaque;
        return item;
    }
    RenderPipelineKind render_pipeline_kind(const RenderItem&) { return RenderPipelineKind::pbr_opaque_back; }
    double default_render_order(const RenderItem&) { return 0; }
    ${["bool mesh_draws(", "bool render_item_material_draws(", "bool render_item_draws_now(", "void append_draw(", "void order_draw_lists(", "RenderDrawLists build_render_draw_lists(", "RenderPlan build_render_plan("].map(name => cppFunction(renderer.source, name)).join("\n")}
    }
    namespace bbl {
    bool reject_material_build = false;
    void run_pbr_scene_hooks(Scene&, const std::vector<MeshHandle>&) { if (reject_material_build) throw std::runtime_error("builder"); }
    std::optional<bool> run_pbr_rebuild_transaction(Scene& scene, const std::vector<MeshHandle>& meshes, bool (*builder)(Scene&, const std::vector<MeshHandle>&)) {
        return builder(scene, meshes);
    }
    void rebuild_scene_renderables(Scene&) {}
    ${lowerPbrMaterialGroups(context)}
    std::vector<unsigned> material_ids(const Scene& scene) {
        std::vector<unsigned> result;
        for (const auto& output : scene.state->material_outputs) result.push_back(output->material.value);
        return result;
    }
    void integrated_phase(bool first, bool gamma, bool thin, bool opaque, bool direct, unsigned mutation, bool reject,
        const std::vector<unsigned>& before, const std::vector<unsigned>& after,
        const std::vector<unsigned>& outputs_before, const std::vector<unsigned>& outputs_after, bool expected_failure) {
        reject_material_build = false;
        Engine engine; engine.materials.resize(2);
        for (auto& material : engine.materials) { material.source_pbr_group_builder = true; material.alpha_mode = opaque || direct ? MaterialAlphaMode::opaque : MaterialAlphaMode::blend; }
        engine.materials[1].source_gamma_albedo = gamma;
        engine.meshes.emplace_back().material = MaterialHandle{0};
        engine.meshes[0].geometry = 0;
        engine.meshes[0].thin_instance_gpu_culling = direct;
        engine.geometries.emplace_back();
        Scene scene; scene.engine = &engine; scene.state->source_material_publication = true;
        const auto add = [&] { scene.meshes.push_back(MeshHandle{0}); queue_pbr_material_group(scene, MeshHandle{0}); };
        if (!first) add();
        prepare_pbr_scene_build(scene);
        while (!scene.deferred_builders.empty()) {
            auto builders = std::move(scene.deferred_builders); scene.deferred_builders.clear();
            for (const auto& build : builders) build();
        }
        finish_pbr_scene_build(scene);
        upstream::RenderPlan plan;
        std::uint64_t cached_version = ~std::uint64_t{0};
        const auto record = [&] {
            std::vector<unsigned> result;
            if (cached_version != scene.render_topology_version) plan = upstream::build_render_plan(scene, engine);
            const auto& commands = opaque || direct ? plan.draw_lists.opaque.commands : plan.draw_lists.transparent.visibility_candidates;
            for (const auto& command : commands) {
                if (upstream::render_item_draws_now(command.item, engine)) result.push_back(command.item.material.value);
            }
            cached_version = scene.render_topology_version;
            return result;
        };
        (void)record();
        if (first) add();
        else {
            engine.meshes[0].material = MaterialHandle{1};
            engine.meshes[0].source_runtime_thin_builder = thin;
            enqueue_pbr_material_swap(scene, MeshHandle{0});
        }
        reject_material_build = reject;
        process_pbr_material_swaps(scene);
        assert(record() == before); assert(material_ids(scene) == outputs_before);
        if (mutation == 1) engine.meshes[0].material = MaterialHandle{0};
        if (mutation == 2) engine.meshes[0].material = MaterialHandle{1};
        if (mutation == 3) scene.meshes.clear();
        if (mutation == 4) scene.disposed = true;
        drain_material_continuations(engine);
        bool failed = false;
        try { for (const auto& callback : scene.before_render) callback(16); } catch (const std::runtime_error&) { failed = true; }
        assert(failed == expected_failure);
        assert((failed ? std::vector<unsigned>{} : record()) == after); assert(material_ids(scene) == outputs_after);
    }
    void shared_scene_cancellation() {
        reject_material_build = false;
        Engine engine;
        engine.materials.emplace_back().source_pbr_group_builder = true;
        engine.meshes.emplace_back().material = MaterialHandle{0};
        Scene scenes[2];
        for (auto& scene : scenes) {
            scene.engine = &engine;
            prepare_pbr_scene_build(scene);
            finish_pbr_scene_build(scene);
        }
        for (auto& scene : scenes) {
            scene.meshes.push_back(MeshHandle{0});
            queue_pbr_material_group(scene, MeshHandle{0});
            process_pbr_material_swaps(scene);
        }
        scenes[0].disposed = true;
        drain_material_continuations(engine);
        assert(material_ids(scenes[0]) == ${vector(sharedExpected[0]!)});
        assert(material_ids(scenes[1]) == ${vector(sharedExpected[1]!)});
    }
    }
    int main() {
    ${scenarios.map((scenario, i) => `bbl::integrated_phase(${scenario.kind.startsWith("first")}, ${scenario.kind.startsWith("gamma") || scenario.kind === "failure"}, ${scenario.kind.startsWith("thin")}, ${scenario.opaque}, ${scenario.direct}, ${scenario.kind.endsWith("cancel") ? 1 : scenario.kind === "first-changed" ? 2 : scenario.kind === "first-removed" ? 3 : scenario.kind === "first-disposed" ? 4 : 0}, ${scenario.kind === "failure"}, ${vector(cases[i]!.before)}, ${vector(cases[i]!.after)}, ${vector(cases[i]!.outputsBefore)}, ${vector(cases[i]!.outputsAfter)}, ${cases[i]!.failed});`).join("\n")}
        bbl::shared_scene_cancellation();
        std::cout << "${scenarios.length + 1} source/native publication phases passed\\n";
    }
    `);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${directory}/`, `/Fe:${integratedExecutable}`, "/I", resolve(directory, "include"), "/I", "native/include", integrated]);
    console.log(execFileSync(integratedExecutable, {encoding: "utf8"}));

});
