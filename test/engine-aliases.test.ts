import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerGpuTaskTiming } from "../src/lowering/gpu-task-timing-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const source = `
    import { createEngine, createSceneContext, stopEngine } from "babylon-lite";
    async function makeEngine(canvas: HTMLCanvasElement) {
        const engine = await createEngine(canvas);
        createSceneContext(engine);
        return engine;
    }
    async function main() {
        const engine = await makeEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const alias = engine;
        const nestedAlias = alias;
        stopEngine(nestedAlias);
        stopEngine(engine);
    }
`;

test("retains an engine returned by a helper without copying or recreating it", () => {
    const result = compileSource(source);
    assert.equal(result.cpp.match(/bbl::create_engine\(/g)?.length, 1);
    const owner = /auto (\w+) = bbl::create_engine\(/.exec(result.cpp)?.[1];
    assert.ok(owner);
    assert.equal(
        result.cpp.match(new RegExp(`bbl::stop_engine\\(${owner}\\)`, "g"))
            ?.length,
        2,
    );
});

test("still refuses a second engine allocation", () => {
    assert.throws(
        () =>
            compileSource(`
        import { createEngine } from "babylon-lite";
        async function main() {
            const first = await createEngine({});
            const alias = first;
            const second = await createEngine({});
        }
    `),
        /supports one engine per entry point/,
    );
});

test("refuses an engine alias that would need rebinding storage", () => {
    assert.throws(
        () =>
            compileSource(`
        import { createEngine } from "babylon-lite";
        async function main() {
            const engine = await createEngine({});
            let alias = engine;
            alias = engine;
        }
    `),
        /Reassigning an engine alias is not supported/,
    );
});

test("compiled helper and alias operations address the scene's original engine", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/engine-alias-check");
    mkdirSync(directory, { recursive: true });
    const generated = resolve(directory, "main.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(generated, compileSource(source).cpp);
    runNativeFixtureCompiler(tools, [
        generated,
        resolve("test/fixtures/engine-alias-check.cpp"),
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});

test("realm engine parameters retain one owner in stored and suspended callbacks", (t) => {
    const result = compileSource(`
        import {createEngine,stopEngine,isRenderTaskGpuTimingSupported,type EngineContext} from "@babylonjs/lite";
        function retain(engine:EngineContext) {
            const alias=engine;
            return {
                stop:()=>stopEngine(alias),
                supported:()=>isRenderTaskGpuTimingSupported(alias),
                async delayedStop(){await Promise.resolve();stopEngine(alias);}
            };
        }
        const engine=await createEngine(new OffscreenCanvas(1,1));
        const callbacks=retain(engine);
        if(callbacks.supported())throw new Error("unexpected timestamp support");
        callbacks.stop();
        const pending=callbacks.delayedStop();
        callbacks.stop();
        await pending;
        globalThis.close();
    `);
    assert.doesNotMatch(result.cpp, /auto& \w+_engine = \(\*/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    const directory = resolve("artifacts/realm-engine-alias-check");
    mkdirSync(directory, { recursive: true });
    const generated = resolve(directory, "program.hpp");
    const fixture = resolve(directory, "check.cpp");
    const executable = resolve(directory, "check.exe");
    writeFileSync(generated, result.cpp);
    writeFileSync(
        fixture,
        `
#include <bblite/pal_async_engine.hpp>
#include <bblite/pal_gpu_task_timing.hpp>
namespace { std::shared_ptr<bbl::Engine> original; }
namespace bbl::pal {
std::shared_ptr<Engine> create_realm_engine(EngineOptions, const std::shared_ptr<OffscreenCanvas>&) {
    original = std::make_shared<Engine>();
    return original;
}
}
#define main generated_main
#include "program.hpp"
#undef main
${lowerGpuTaskTiming(new LoweringContext()).source}
namespace bbl {
void stop_engine(Engine& engine) {
    if (&engine != original.get() || !engine.gpu_task_timing)
        throw std::runtime_error("Callback did not retain its original engine.");
    ++engine.draw_call_count;
}
}
int main() {
    const int result = generated_main();
    if (!original || original->draw_call_count != 3)
        throw std::runtime_error("Original engine was not mutated.");
    original.reset();
    return result;
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        fixture,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, {
        stdio: "pipe",
        timeout: 10000,
        windowsHide: true,
    });
});

test("a realm entry engine keeps one identity from a constructor's scoped context to a stored callback", () => {
    // The manager learns its engine from the constructor's property targets;
    // the stored callback reads its groups through the entry engine.
    const result = compileSource(`
        import type { AnimationGroup, AnimationManager, TransformNode } from "@babylonjs/lite";
        import {
            createAnimationManager, createEngine, createPropertyAnimationClip, createPropertyAnimationGroup,
            createTransformNode, crossFadeAnimationGroups, updateAnimationManager,
        } from "@babylonjs/lite";
        class Fader {
            private readonly manager: AnimationManager = createAnimationManager();
            private readonly groups: Record<"low" | "high", AnimationGroup>;
            constructor(pivot: TransformNode) {
                const target = { hinge: { get angle(): number { return pivot.position.x; }, set angle(value: number) { pivot.position.x = value; } } };
                const clip = (name: string, value: number) =>
                    createPropertyAnimationClip(name, [{ path: "hinge.angle", frameRate: 30, keys: [{ frame: 0, value }, { frame: 30, value }] }]);
                this.groups = {
                    low: createPropertyAnimationGroup(this.manager, target, clip("low", 0), { loop: true }),
                    high: createPropertyAnimationGroup(this.manager, target, clip("high", 1), { loop: true }),
                };
            }
            fade(): void { crossFadeAnimationGroups(this.manager, this.groups.low, this.groups.high, { durationMs: 100 }); }
            tick(ms: number): void { updateAnimationManager(this.manager, ms); }
        }
        const handlers = new Set<() => void>();
        const engine = await createEngine(new OffscreenCanvas(1, 1));
        const fader = new Fader(createTransformNode("pivot"));
        handlers.add(() => fader.fade());
        await Promise.resolve();
        for (const handler of handlers) handler();
        fader.tick(16);
        globalThis.close();
    `);
    assert.ok(result.manifest.features.includes("platform:workers"));
    assert.match(result.cpp, /bbl::cross_fade_animation_groups\(/);
});
