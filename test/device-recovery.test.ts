import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerDeviceRecovery } from "../src/lowering/device-recovery-lowerer.js";
import { lowerEngineDisposal } from "../src/lowering/engine-dispose-lowerer.js";
import { EngineLowerer } from "../src/lowering/engine-lowerer.js";
import { canvasDatasetSource } from "../src/lowering/canvas-dataset.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const sourcePath = "corpus/babylon-lite/lab/lite/src/lite/scene164.ts";
const source = readFileSync(sourcePath, "utf8");

test("unchanged device-loss scene retains polling predicates, GPU identities and recovery callbacks", () => {
    const result = compileSource(source, { fileName: sourcePath });
    assert.ok(result.manifest.features.includes("engine:device-recovery"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/device_recovery.cpp",
        ),
    );
    for (const name of [
        "gpu_device_identity",
        "environment_identity",
        "environment_texture_identity",
        "fallback_texture_identity",
        "shadow_texture_identity",
        "scene_renderable_count",
        "set_global_callback",
        "disable_device_recovery",
        "force_device_loss",
        "dispose_engine",
    ]) {
        assert.ok(result.cpp.includes(`bbl::${name}(`), name);
    }
    assert.equal(result.cpp.match(/bbl::add_gpu_error_listener\(/g)?.length, 2);
    assert.match(result.cpp, /->on_lost =/);
    assert.match(result.cpp, /->on_recovered =/);
    assert.match(result.cpp, /->on_failed =/);
    assert.match(
        result.cpp,
        /defer_capture_until\([^\n]+canvas_dataset\([^\n]+"ready"/,
    );
    // The poll predicate is a shared body; the deferred start calls it.
    const predicate = result.cpp.match(
        /defer_start_continuation_until\([^\n]+\[&\]\(\)[^\n]*bblscene::(bbl_recursive_fn\d+_group)\)\(\)/,
    )?.[1];
    assert.ok(predicate);
    assert.match(
        result.cpp,
        new RegExp(
            `\\n\\w+ ${predicate}\\([^\\n]*\\) \\{\\n[^}]*canvas_dataset\\([^\\n]+"preLossReady"`,
        ),
    );
    assert.ok(
        result.manifest.scenePbrMaterials?.some(
            (material) => material.shadowOnly?.opacity === 0.95,
        ),
    );
});

test("recovery declines unrepresented callbacks, listeners, options and poll scheduling", () => {
    for (const [from, to, expected] of [
        [
            "onLost() {",
            "onLost(info) {",
            /callback parameters are not represented/,
        ],
        [
            '"uncapturederror", recordGpuError',
            '"lost", recordGpuError',
            /Only GPU uncapturederror/,
        ],
        ["onLost() {", "unknown() {", /Unrepresented device recovery option/],
        [
            "requestAnimationFrame(poll);",
            "setTimeout(poll, 0);",
            /Promise|executor|constructor/,
        ],
    ] as const) {
        assert.notEqual(source.indexOf(from), -1, from);
        assert.throws(
            () =>
                compileSource(source.replace(from, to), {
                    fileName: sourcePath,
                }),
            expected,
        );
    }
});

test("recovery refuses pinned defaults, lifecycle, ownership and PAL contract drift", () => {
    class EditedStore extends UpstreamSourceStore {
        public constructor(
            private readonly module: string,
            private readonly from: string,
            private readonly to: string,
        ) {
            super();
        }
        public override getSourceFile(module: string): ts.SourceFile {
            const source = super.getSource(module);
            if (module === `src/engine/${this.module}.ts`)
                assert.ok(source.includes(this.from), this.from);
            const text =
                module === `src/engine/${this.module}.ts`
                    ? source.replace(this.from, this.to)
                    : source;
            return ts.createSourceFile(
                module,
                text,
                ts.ScriptTarget.Latest,
                true,
            );
        }
    }
    for (const [module, from, to] of [
        [
            "device-lost-recovery",
            "_forceNextLoss: false",
            "_forceNextLoss: true",
        ],
        ["device-lost-recovery", "let disabled = false", "let disabled = true"],
        [
            "device-lost-recovery",
            "registrations.splice(index, 1)",
            "registrations.splice(index, 2)",
        ],
        [
            "device-lost-recovery",
            "const registrations = [...state._registrations]",
            "const registrations = state._registrations",
        ],
        [
            "device-lost-recovery",
            "arm(engine, state);\n                    for",
            "arm(engine, getState(engine));\n                    for",
        ],
        [
            "device-lost-recovery-testing",
            "engine._device.destroy()",
            "engine._device.submit()",
        ],
        [
            "device-lost-scene-recovery",
            "options: DeviceLostRecoveryCallbacks = {}",
            "options: DeviceLostRecoveryCallbacks = { onLost() {} }",
        ],
        [
            "device-lost-scene-recovery",
            "_onRecovered: options.onRecovered",
            "_onRecovered: options.onLost",
        ],
        [
            "device-lost-recovery-run",
            "disposeGpuResourceRetirements(engine);",
            "otherRetirements(engine);",
        ],
        [
            "device-lost-recovery-run",
            "requiredFeatures: state._requiredFeatures",
            "requiredFeatures: []",
        ],
        [
            "device-lost-recovery-run",
            "(a._recoverOrder ?? 0) - (b._recoverOrder ?? 0)",
            "(b._recoverOrder ?? 0) - (a._recoverOrder ?? 0)",
        ],
        [
            "device-lost-recovery-run",
            "settleTextureOwnership?.();",
            "otherOwnership?.();",
        ],
        ["device-lost-recovery-run", "if (wasRunning)", "if (!wasRunning)"],
        [
            "device-lost-recovery-run",
            "Promise.allSettled(textures.map",
            "Promise.all(textures.map",
        ],
        [
            "device-lost-recovery-run",
            "settleRebuiltTextureOwnership(state);",
            "settleRebuiltTextureOwnership(engine);",
        ],
        [
            "recovery-rebuild",
            "engine._pbrFallbackTex = undefined",
            "engine._pbrFallbackTex = null",
        ],
        [
            "recovery-rebuild",
            'if (ctx._kind !== "scene")',
            'if (ctx._kind !== "sprite")',
        ],
        [
            "recovery-rebuild",
            "scene._renderables.filter((r) => !!r._rebuild)",
            "scene._renderables.filter((r) => !r._rebuild)",
        ],
        [
            "recovery-rebuild",
            "scene._renderables.sort((a, b) => a.order - b.order)",
            "scene._renderables.sort((a, b) => b.order - a.order)",
        ],
        [
            "recovery-rebuild",
            "rebuilt.push(await rebuild())",
            "rebuilt.push(rebuild())",
        ],
        ["recovery-rebuild", "rt._lastVersion = -1", "rt._lastVersion = 0"],
        ["recovery-rebuild", "indices.length", "positions.length"],
        [
            "device-lost-recovery-capture",
            "includeMeshes = false",
            "includeMeshes = true",
        ],
        [
            "device-lost-recovery-capture",
            "data.slice(0, tex.width * tex.height * 4)",
            "data.slice(0)",
        ],
        [
            "device-lost-recovery-capture",
            "state._captureRefs--",
            "state._captureRefs++",
        ],
        ["gpu-resource-retirement", "batch.splice(0)", "batch.slice(0)"],
        [
            "gpu-resource-retirement",
            "inFlight?.forEach(runBatch)",
            "inFlight?.forEach(() => undefined)",
        ],
    ] as const) {
        const store = new EditedStore(module, from, to);
        assert.throws(
            () => lowerDeviceRecovery(new LoweringContext(store)),
            /native recovery contract|Expected|Unsupported pinned|splices exactly one/,
            `${module}: ${from}`,
        );
    }
    // The coordinator's own bodies are lowered, so a pinned change to one
    // of them is followed rather than refused.
    const lowered = (from: string, to: string): string =>
        lowerDeviceRecovery(
            new LoweringContext(
                new EditedStore("device-lost-recovery", from, to),
            ),
        ).source;
    const pinned = lowerDeviceRecovery(new LoweringContext()).source;
    assert.match(pinned, /if \(!state\.requested\) \{\n\s*return;/);
    assert.match(
        lowered(
            'info.reason === "destroyed" && !state._forceNextLoss',
            'info.reason === "destroyed" && state._forceNextLoss',
        ),
        /if \(state\.requested\) \{\n\s*return;/,
    );
    assert.match(
        lowered(
            "registration._onRecoveryFailed?.(error)",
            "arm(engine, state); registration._onRecoveryFailed?.(error)",
        ),
        /arm_device_recovery\(engine, state\);\n\s*\(registration->on_failed/,
    );
    // The run's context-kind assertion is lowered too (RDN-28): every
    // registered context's pinned kind, checked against the in-flight
    // registrations' kinds, refused with the pin's own sorted message.
    assert.match(
        pinned,
        /kinds\.insert\(kinds\.end\(\), bbl::text_renderer_count\(engine\), std::string\("text-renderer"\)\);/,
    );
    assert.match(pinned, /registration->kind = "scene";/);
    assert.match(
        pinned,
        /if \(!std::ranges::any_of\(handlers, \[&\]\(const auto& registration\) \{ return registration->kind == context; \}\)\) \{\n\s*unrecoverable\.add\(context\);/,
    );
    assert.match(
        pinned,
        /std::string\("Device-lost recovery cannot rebuild registered rendering contexts of kind: "\) \+ bbl::js::array_join\(bbl::js::string_array_sort\(bbl::js::array_from_iterable<std::string>\(unrecoverable\)\), std::string\(", "\)\)/,
    );
    assert.match(
        pinned,
        /engine\.stopped = true;\n\s*assert_every_active_context_kind_is_recoverable\(engine, state\.in_flight\);/,
    );
    assert.match(
        lowerDeviceRecovery(
            new LoweringContext(
                new EditedStore(
                    "device-lost-recovery-run",
                    "if (!handlers.has(context._kind))",
                    "if (handlers.has(context._kind))",
                ),
            ),
        ).source,
        /if \(std::ranges::any_of\(handlers,/,
    );
});

test("whole-function recovery contracts ignore documentation but retain executable structure", () => {
    const context = new LoweringContext();
    const file = ts.createSourceFile(
        "contract.ts",
        "/** @internal A documented function. */ function recover(value = false) { return value; }",
        ts.ScriptTarget.Latest,
        true,
    );
    context.assertStatementShapes(
        file,
        file.statements,
        "function recover(value = false) { return value; }",
        "documentation-independent contract",
    );
    assert.throws(
        () =>
            context.assertStatementShapes(
                file,
                file.statements,
                "function recover(value = true) { return value; }",
                "default contract",
            ),
        /default contract statement 1 changed/,
    );
});

const nativeTools = optionalNativeFixtureTools(false);
test(
    "native recovery keeps callback snapshots, identities, failure and disposal state",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/device-recovery-native");
        mkdirSync(output, { recursive: true });
        const context = new LoweringContext();
        const core = new EngineLowerer(context).lowerCore().source;
        writeFileSync(
            join(output, "recovery.hpp"),
            lowerDeviceRecovery(context).source +
                lowerEngineDisposal(context).source +
                `namespace bbl { ${cppFunction(core, "void stop_engine(Engine& engine)")} }` +
                canvasDatasetSource,
        );
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            output,
            "/I",
            "native/include",
            "test/fixtures/device-recovery-check.cpp",
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /device-recovery: ok/,
        );
    },
);
