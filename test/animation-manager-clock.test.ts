import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { AnimationLowerer } from "../src/lowering/animation-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("exact standalone manager source retains both authored modes and live client dimensions", () => {
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene153.ts";
    for (const search of ["?seekTime=1", ""]) {
        const result = compileSource(readFileSync(fileName, "utf8"), { fileName, search });
        assert.ok(result.manifest.features.includes("renderer:canvas"));
        assert.match(result.cpp, /canvas_client_width/);
        assert.match(result.cpp, /canvas_client_height/);
        assert.match(result.cpp, /\.on_update = bbl::js::make_closure/);
        assert.equal(result.cpp.includes("bbl::start_animation_manager("), search === "");
    }
});

test("autonomous managers refuse persistent application RAF interleavings in both source orders", () => {
    const manager = "startAnimationManager(manager);";
    const recurring = "function tick() { requestAnimationFrame(tick); } requestAnimationFrame(tick);";
    for (const body of [manager + recurring, recurring + manager]) {
        assert.throws(() => compileSource(`
            import { createEngine, createAnimationManager, startAnimationManager } from "@babylonjs/lite";
            const engine = await createEngine({});
            const manager = createAnimationManager({ engine });
            ${body}
        `), /Autonomous animation managers cannot share a program with a persistent application RAF loop/);
    }
});

test("an engine-less manager requires a reached native presentation surface", () => {
    assert.throws(() => compileSource(`
        import { createAnimationManager, startAnimationManager } from "@babylonjs/lite";
        const manager = createAnimationManager();
        startAnimationManager(manager);
    `), /engine-less animation manager needs a reached primary Canvas2D surface/);
});

test("pinned manager distinguishes manual updates, first ticks, fixed steps and cancellation", async () => {
    const pin = await import("@babylonjs/lite");
    let next = 0;
    const queue = new Map<number, FrameRequestCallback>();
    const previousRaf = globalThis.requestAnimationFrame;
    const previousCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => { queue.set(++next, callback); return next; };
    globalThis.cancelAnimationFrame = (id) => { queue.delete(id); };
    const frame = (now: number): void => {
        for (const id of [...queue.keys()]) {
            const callback = queue.get(id);
            queue.delete(id);
            callback?.(now);
        }
    };
    try {
        const target = { value: 0 };
        const observations: Array<{ value: number; step: number }> = [];
        const manager = pin.createAnimationManager({ onUpdate: (step) => observations.push({ value: target.value, step }) });
        const clip = pin.createPropertyAnimationClip("clock", [{ path: "value", keys: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }] }], { frameRate: 10 });
        const group = pin.createPropertyAnimationGroup(manager, target, clip, { loop: false });
        pin.goToFrame(group, 5);
        assert.equal(target.value, 5);
        pin.playAnimation(group);
        pin.updateAnimationManager(manager, 100);
        assert.equal(observations.length, 0);
        pin.startAnimationManager(manager);
        pin.startAnimationManager(manager);
        assert.equal(queue.size, 1);
        frame(100); frame(125); frame(115);
        assert.deepEqual(observations.map((row) => row.step), [0, 25, -10]);
        assert(Math.abs(observations[0]!.value - 6) < 0.00001);
        assert(Math.abs(target.value - 6.25) < 0.00001);
        pin.stopAnimationManager(manager);
        frame(1000);
        assert.equal(observations.length, 3);
        pin.startAnimationManager(manager);
        frame(2000); frame(2250);
        assert.deepEqual(observations.slice(3).map((row) => row.step), [0, 250]);
        assert(Math.abs(target.value - 8.75) < 0.00001);
        pin.stopAnimationManager(manager);

        target.value = 0;
        observations.length = 0;
        const fixed = pin.createAnimationManager({ fixedDeltaMs: 100, onUpdate: (step) => observations.push({ value: target.value, step }) });
        pin.createPropertyAnimationGroup(fixed, target, clip, { loop: false });
        pin.startAnimationManager(fixed);
        frame(100);
        assert.equal(target.value, 1);
        pin.updateAnimationManager(fixed, -500);
        pin.updateAnimationManager(fixed, NaN);
        assert(Math.abs(target.value - 3) < 0.00001);
        assert.deepEqual(observations, [{ value: 1, step: 100 }]);
        pin.stopAnimationManager(fixed);
        let ordered = 0;
        const observing = pin.createAnimationManager({ onUpdate: () => assert.equal(ordered, 1) });
        requestAnimationFrame(() => { ordered = 1; });
        pin.startAnimationManager(observing);
        frame(4000);
        pin.stopAnimationManager(observing);
        let restartedCalls = 0;
        const restarting = pin.createAnimationManager({ onUpdate: () => {
            if (++restartedCalls === 1) {
                pin.stopAnimationManager(restarting);
                pin.startAnimationManager(restarting);
            }
        }});
        pin.startAnimationManager(restarting);
        frame(5000);
        assert.equal(restartedCalls, 1);
        assert.equal(queue.size, 2);
        frame(5100);
        assert.equal(restartedCalls, 3);
        pin.stopAnimationManager(restarting);
        frame(5200);
        assert.equal(restartedCalls, 3);
        assert.equal(queue.size, 0);
    } finally {
        globalThis.requestAnimationFrame = previousRaf;
        globalThis.cancelAnimationFrame = previousCancel;
    }
});

const tools = optionalNativeFixtureTools(false);
test("property-only scene registration seeks late managers and freezes their groups", { skip: !tools }, () => {
    const output = resolve("artifacts/animation-manager-seek-check");
    mkdirSync(output, { recursive: true });
    emitUpstreamGenerated(output, ["core", "renderer:scene", "animation:property"]);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", "/I", join(output, "upstream/include"), `/Fo:${output}\\`, `/Fe:${executable}`,
        join(output, "upstream/src/scene_core.cpp"), join(output, "upstream/src/animation_property.cpp"),
        "test/fixtures/animation-manager-seek-check.cpp", "/link", "/OPT:REF",
    ]);
    execFileSync(executable, { stdio: "pipe" });
});

test("autonomous notifications retain block-local objects for inline and named callbacks", { skip: !tools }, () => {
    const output = resolve("artifacts/animation-manager-capture-check");
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const lowered = new AnimationLowerer(new LoweringContext()).lowerPropertyAnimation();
    writeFileSync(join(headers, "property_animation.hpp"), lowered.header);
    writeFileSync(join(output, "property_animation.cpp"), lowered.source);
    const callback = "() => { record.value++; if (record.value !== 2) throw new Error('Notification lost its block-local object'); }";
    for (const named of [false, true]) {
        const program = `
            import { createEngine, createAnimationManager, startAnimationManager, startEngine } from "@babylonjs/lite";
            async function main() {
                const engine = await createEngine({});
                {
                    const record: { value: number } = { value: 1 };
                    ${named ? `const notify = ${callback};` : ""}
                    const manager = createAnimationManager({ engine, onUpdate: ${named ? "notify" : callback} });
                    startAnimationManager(manager);
                }
                await startEngine(engine);
            }
        `;
        writeFileSync(join(output, "program.hpp"), compileSource(program).cpp);
        const executable = join(output, `check-${named}.exe`);
        runNativeFixtureCompiler(tools!, [
            "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
            "/I", "native/include", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`,
            join(output, "property_animation.cpp"), "test/fixtures/animation-manager-capture-check.cpp", "/link", "/OPT:REF",
        ]);
        execFileSync(executable, { stdio: "pipe" });
    }
});

test("native manager follows clock, callback order, cancellation and restart contracts", { skip: !tools }, () => {
    const output = resolve("artifacts/animation-manager-clock-check");
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const lowered = new AnimationLowerer(new LoweringContext()).lowerPropertyAnimation();
    writeFileSync(join(headers, "property_animation.hpp"), lowered.header);
    writeFileSync(join(output, "property_animation.cpp"), lowered.source);
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(tools!, [
        "/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`,
        join(output, "property_animation.cpp"), "test/fixtures/animation-manager-clock-check.cpp", "/link", "/OPT:REF",
    ]);
    assert.match(execFileSync(executable, { encoding: "utf8" }), /animation-manager-clock-check: ok/);
});
