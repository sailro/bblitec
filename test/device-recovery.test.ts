import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerDeviceRecovery } from "../src/lowering/device-recovery-lowerer.js";
import { canvasDatasetSource } from "../src/lowering/canvas-dataset.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene164.ts";
const source = readFileSync(sourcePath, "utf8");

test("unchanged device-loss scene retains polling predicates, GPU identities and recovery callbacks", () => {
    const result = compileSource(source, { fileName: sourcePath });
    assert.ok(result.manifest.features.includes("engine:device-recovery"));
    assert.ok(result.manifest.generatedSources.includes("upstream/src/device_recovery.cpp"));
    for (const name of ["gpu_device_identity", "environment_identity", "environment_texture_identity", "fallback_texture_identity", "shadow_texture_identity", "scene_renderable_count", "set_global_callback", "disable_device_recovery", "force_device_loss", "dispose_engine"]) {
        assert.ok(result.cpp.includes(`bbl::${name}(`), name);
    }
    assert.equal(result.cpp.match(/bbl::add_gpu_error_listener\(/g)?.length, 2);
    assert.match(result.cpp, /->on_lost =/);
    assert.match(result.cpp, /->on_recovered =/);
    assert.match(result.cpp, /->on_failed =/);
    assert.match(result.cpp, /defer_capture_until\([^\n]+canvas_dataset\([^\n]+"ready"/);
    assert.match(result.cpp, /defer_start_continuation_until\([^\n]+\[&\]\(\).*canvas_dataset\([^\n]+"preLossReady"/);
    assert.ok(result.manifest.scenePbrMaterials?.some(material => material.shadowOnly?.opacity === 0.95));
});

test("recovery declines unrepresented callbacks, listeners, options and poll scheduling", () => {
    for (const [from, to, expected] of [
        ["onLost() {", "onLost(info) {", /callback parameters are not represented/],
        ['"uncapturederror", recordGpuError', '"lost", recordGpuError', /Only GPU uncapturederror/],
        ["onLost() {", "unknown() {", /Unrepresented device recovery option/],
        ["requestAnimationFrame(poll);", "setTimeout(poll, 0);", /Promise|executor|constructor/],
    ] as const) {
        assert.notEqual(source.indexOf(from), -1, from);
        assert.throws(() => compileSource(source.replace(from, to), { fileName: sourcePath }), expected);
    }
});

test("recovery refuses pinned force and retirement contract drift", () => {
    class EditedStore extends UpstreamSourceStore {
        public edit?: [string, string];
        public override getSourceFile(module: string): ts.SourceFile {
            const source = super.getSource(module);
            const text = this.edit ? source.replace(...this.edit) : source;
            return ts.createSourceFile(module, text, ts.ScriptTarget.Latest, true);
        }
    }
    for (const [from, to, error] of [
        ["engine._device.destroy()", "engine._device.submit()", /forced device destruction/],
        ["disposeGpuResourceRetirements(engine);", "otherRetirements(engine);", /Recovery no longer calls disposeGpuResourceRetirements/],
        ["settleTextureOwnership?.();", "otherOwnership?.();", /ownership settlement/],
    ] as const) {
        const store = new EditedStore();
        store.edit = [from, to];
        assert.throws(() => lowerDeviceRecovery(new LoweringContext(store)), error);
    }
});

const nativeTools = optionalNativeFixtureTools(false);
test("native recovery keeps callback snapshots, identities, failure and disposal state", { skip: !nativeTools }, () => {
    const output = resolve("artifacts/device-recovery-native");
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "recovery.hpp"), lowerDeviceRecovery(new LoweringContext()).source + canvasDatasetSource);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2",
        `/Fo:${output}\\`, `/Fe:${executable}`, "/I", output, "/I", "native/include", "test/fixtures/device-recovery-check.cpp"]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /device-recovery: ok/);
});
