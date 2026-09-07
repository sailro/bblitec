import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PostProcessLowerer } from "../src/lowering/post-process-lowerer.js";
import { composeComposite } from "../src/pinned-post-process.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const prefix = `
import { createEngine, createSceneContext, createRenderTarget, createRenderTask,
    createTaaPostProcessTask, createBlackAndWhitePostProcessTask } from "babylon-lite";
const engine = await createEngine({});
const scene = createSceneContext(engine, { defaultRenderTask: false });
const source = createRenderTarget({ format: engine.format, samples: 1, size: engine });
const sourceTask = createRenderTask({ rt: source }, engine, scene);
`;
const create = (sourceTask = "sourceTask") => `createTaaPostProcessTask({
    sourceTexture: source, sourceRenderTask: ${sourceTask},
    targetTexture: engine.scRT, factor: 0.125, samples: 8 }, engine, scene)`;

test("TAA descriptors preserve task aliases and refuse missing or non-render sources", () => {
    const result = compileSource(`${prefix}
        const alias = sourceTask;
        const taa = ${create("alias")};
        const output = taa.outputTexture;
    `);
    assert.deepEqual(result.manifest.postProcessComposites[0]?.options, { factor: 0.125, samples: 8 });
    assert.match(result.cpp, /PostProcessCompositeInputs\{[^\n]*\{v_alias\}\}/);
    assert.match(result.cpp, /\.post_process\.output_target/);
    assert.doesNotMatch(result.cpp, /passes\.back\(\)\.output_target/);
    assert.throws(() => compileSource(`${prefix} const taa = ${create().replace("sourceRenderTask: sourceTask,", "")};`), /requires 'sourceRenderTask'/);
    assert.throws(() => compileSource(`${prefix}
        const effect = createBlackAndWhitePostProcessTask({ sourceTexture: source }, engine, scene);
        const taa = ${create("effect")};
    `), /requires a proven scene render task/);
    assert.throws(() => compileSource(`${prefix} const taa = ${create("source")};`), /Expected task/);
    assert.throws(() => compileSource(`${prefix}
        let mutable = sourceTask;
        mutable = createBlackAndWhitePostProcessTask({ sourceTexture: source }, engine, scene);
        const taa = ${create("mutable")};
    `), /Assignment operator '=' is not supported for task/);
    // Public factor does not name the private live factor slot. It must not
    // be mistaken for a supported composite setter before execute is lowered.
    assert.throws(() => compileSource(`${prefix} const taa = ${create()}; taa.factor = 0.5;`), /setter on a composite/);
});

test("TAA observes presentation identity separately from history order and refuses missing UBO transport", async () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene261.ts";
    const result = compileSource(readFileSync(resolve(fileName), "utf8"), { fileName });
    const manifest = result.manifest.postProcessComposites[0]!;
    assert.equal(manifest.intrinsic, "createTaaPostProcessTask");
    assert.deepEqual(manifest.options, { factor: 0.05, samples: 8 });
    assert.ok(result.manifest.features.includes("renderer:post-process"));
    for (const hasTarget of [true, false]) {
        const composite = await composeComposite({ ...manifest, hasTarget });
        assert.deepEqual(composite.taa, { factor: 0.05, disableOnCameraMove: true });
        assert.equal(composite.outputPass, 1);
        assert.deepEqual(composite.passes.map((pass) => pass.name), [
            "bblitec-composite-blend", "bblitec-composite-present", "bblitec-composite-history-update",
        ]);
        assert.deepEqual(composite.intermediates.map((target) => [target.format, target.widthRatio, target.heightRatio]), [
            ["rgba16float", 1, 1], ["rgba16float", 1, 1],
        ]);
        assert.deepEqual(composite.passes.map((pass) => pass.target), [
            { kind: "intermediate", index: 1 },
            { kind: "input", option: hasTarget ? "targetTexture" : "swapchain" },
            { kind: "intermediate", index: 0 },
        ]);
        assert.deepEqual(composite.passes.map((pass) => pass.params), [[1], [], []]);
        assert.deepEqual(composite.passes[0]?.extraTextures, [{ kind: "intermediate", index: 0 }]);
        assert.throws(() => new PostProcessLowerer(new LoweringContext(), [], [composite],
            ` (reached from ${fileName}:100:17)`).lowerTaskRecords(),
            /camera projection jitter over a persistent source-task scene UBO.*scene261\.ts:100:17/);
    }
});

test("existing composites retain their observed final output with and without a target", async () => {
    for (const intrinsic of ["createBloomPostProcessTask", "createDepthOfFieldPostProcessTask", "createSmaaPostProcessTask"]) {
        for (const hasTarget of [true, false]) {
            const composite = await composeComposite({ intrinsic, hasTarget, options: {} });
            assert.equal(composite.outputPass, composite.passes.length - 1);
            const native = new PostProcessLowerer(new LoweringContext(), [], [composite]).lowerTaskRecords();
            assert.ok(native.source.includes(`options.output_pass = ${composite.outputPass}u;`));
        }
    }
});

interface PinTarget { _descriptor: { size: { width: number; height: number }; format: string } }
interface PinTask {
    outputTexture: PinTarget;
    factor: number;
    _factor: number;
    _sourceRenderTask: object;
    _blend: { _shader: { writeUniforms(data: Float32Array): void } };
    _present: { outputTexture: PinTarget };
    _historyUpdate: { outputTexture: PinTarget };
}

function definition(source: string, signature: string): string {
    const start = source.indexOf(signature);
    assert.ok(start >= 0, signature);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, signature);
    return source.slice(start, end + 3);
}

test("pinned private-factor writes and native facade identities stay live", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const pin = await importPinnedModule<{
        createTaaPostProcessTask(config: object, engine: object, scene: object): PinTask;
    }>("post-process/taa.js");
    const source: PinTarget = { _descriptor: { size: { width: 64, height: 32 }, format: "rgba16float" } };
    const target: PinTarget = { _descriptor: { ...source._descriptor } };
    const sourceTask = { scene: { camera: null } };
    const task = pin.createTaaPostProcessTask({ sourceTexture: source, sourceRenderTask: sourceTask,
        targetTexture: target, factor: 0.125 }, { scRT: target }, {});
    assert.equal(task._sourceRenderTask, sourceTask);
    assert.equal(task.outputTexture, target);
    assert.equal(task.outputTexture, task._present.outputTexture);
    assert.notEqual(task.outputTexture, task._historyUpdate.outputTexture);
    const buffer = new Float32Array(4);
    task._blend._shader.writeUniforms(buffer);
    assert.equal(buffer[0], 1);
    task.factor = 0.75;
    task._blend._shader.writeUniforms(buffer);
    assert.equal(buffer[0], 1, "public factor is not the private upload state");
    const values = [1, 0.125, 1 / 7, 0, -0, -3.75, 1e40];
    const bits = values.map((value) => {
        task._factor = value;
        buffer.fill(42);
        task._blend._shader.writeUniforms(buffer);
        assert.deepEqual([...buffer.slice(1)], [42, 42, 42]);
        return new Uint32Array(buffer.buffer)[0]!;
    });
    // Internal effect rows are only usable by the pinned composite; this
    // direct lowerer fixture exercises its writer without admitting TAA.
    const lowered = new PostProcessLowerer(new LoweringContext(), [{
        intrinsic: "createTaaBlendPostProcessTask", shaderIndex: 0, options: {},
    }]).lowerTaskRecords();
    const output = resolve("artifacts/temporal-post-process-contracts");
    mkdirSync(output, { recursive: true });
    const sourcePath = join(output, "check.cpp");
    writeFileSync(sourcePath, `#include <bblite/runtime.hpp>
#include <bit>
#include <cassert>
namespace bbl {
// Already-resolved render targets avoid graphics allocation in this fixture.
void resolve_post_process_pass_output(Engine&, PostProcessPassOptions& pass) {
    assert(pass.output_target.value != invalid_handle);
}
${definition(lowered.source, "TaskHandle create_post_process_task(")}
${definition(lowered.source, "void update_post_process_uniforms(")}
namespace upstream {
${definition(lowered.source, "void write_post_process_uniforms(")}
}
}
int main() {
    bbl::Engine engine;
    bbl::PostProcessTaskOptions leaf;
    leaf.passes.resize(1); leaf.passes[0].output_target = bbl::RenderTargetHandle{5};
    const auto leaf_handle = bbl::create_post_process_task(engine, std::move(leaf));
    assert(engine.frame_tasks[leaf_handle.value].post_process.output_target.value == 5);
    bbl::PostProcessTaskOptions options;
    options.passes.resize(3);
    for (std::uint32_t index = 0; index < 3; ++index) {
        options.passes[index].output_target = bbl::RenderTargetHandle{10 + index};
    }
    options.output_pass = 1;
    options.source_tasks = {bbl::TaskHandle{7}};
    const auto handle = bbl::create_post_process_task(engine, std::move(options));
    const auto alias = handle;
    engine.frame_tasks.resize(128); // Table growth must not change task identity.
    auto& record = engine.frame_tasks[alias.value].post_process;
    assert(record.output_target.value == 11);
    assert(record.output_target.value != record.passes.back().output_target.value);
    assert(record.source_tasks[0].value == 7);
    auto& pass = record.passes[0];
    pass.shader_index = 0; pass.params = {1.0}; pass.uniforms_dirty = false;
    const double values[] = {${values.map((value) => Object.is(value, -0) ? "-0.0" : String(value)).join(", ")}};
    const std::uint32_t expected[] = {${bits.map((value) => `${value}u`).join(", ")}};
    for (std::size_t index = 0; index < std::size(values); ++index) {
        pass.params[0] = values[index];
        assert(!pass.uniforms_dirty);
        bbl::update_post_process_uniforms(engine, alias);
        assert(pass.uniforms_dirty);
        float data[] = {42, 42, 42, 42};
        bbl::upstream::write_post_process_uniforms(engine, pass, 64, 32, 64, 32, data);
        assert(std::bit_cast<std::uint32_t>(data[0]) == expected[index]);
        assert(data[1] == 42 && data[2] == 42 && data[3] == 42);
        pass.uniforms_dirty = false;
    }
}
`);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", "native/include", sourcePath]);
    execFileSync(executable);
});
