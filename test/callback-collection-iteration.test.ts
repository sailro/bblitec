import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import {
    runSelfCheckingProgram,
    runTranspiled,
} from "./self-checking-program.js";

test("retained callback collections observe registrations after empty iteration and settle waiters", async (t) => {
    const source = `
        const callbacks = new Set<() => void>();
        function publish(): void {
            for (const callback of callbacks) callback();
            callbacks.clear();
        }
        const retained: Array<() => void> = [publish];
        let calls = 0;
        retained[0]!();
        callbacks.add(() => { calls++; });
        retained[0]!();
        retained[0]!();
        if (calls !== 1) throw new Error('late registration or duplicate delivery');
        (async () => {
            const pending = new Promise<void>(resolve => callbacks.add(resolve));
            retained[0]!();
            await pending;
            globalThis.close();
        })();
    `;
    let closed = false;
    await runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText,
        {
            close: () => {
                closed = true;
            },
        },
    );
    assert.ok(closed);
    const compiled = compileSource(source);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(native, "callback-collection-iteration", compiled.cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
    });
});

test("retained callbacks iterate what code after their creation assigns or adds", (t) =>
    runSelfCheckingProgram(
        t,
        "callback-collection-iteration/filled-later",
        `
        interface Prepared { name: string; }
        const callbacks: Array<() => number> = [];
        const lengths = (names: Iterable<string>): number => {
            let total = 0;
            for (const name of names) total += name.length;
            return total;
        };
        function createOutline() {
            let pending: readonly Prepared[] = [];
            callbacks.push(() => {
                let total = 0;
                for (const prepared of pending) total += prepared.name.length;
                return total;
            });
            return {
                select(names: readonly string[]): void {
                    const views: Prepared[] = [];
                    for (const name of names) views.push({ name });
                    pending = views;
                },
            };
        }
        createOutline().select(['ab', 'cde']);
        let assigned: string[] = [];
        callbacks.push(() => { let total = 0; for (const name of assigned) total += name.length; return total; });
        assigned = ['four'];
        const pushed: string[] = [];
        callbacks.push(() => { let total = 0; for (const name of pushed) total += name.length; return total; });
        pushed.push('fives');
        const state = { items: [] as string[] };
        callbacks.push(() => { let total = 0; for (const name of state.items) total += name.length; return total; });
        state.items.push('sixsix');
        const sizes = new Map<string, number>();
        callbacks.push(() => { let total = 0; for (const [, size] of sizes) total += size; return total; });
        sizes.set('seven', 7);
        const seen = new Set<string>();
        callbacks.push(() => { let total = 0; for (const name of seen) total += name.length; return total; });
        seen.add('eight888');
        const built: string[] = [];
        built.push('nine99999');
        callbacks.push(() => lengths(built));
        const passed: string[] = [];
        callbacks.push(() => lengths(passed));
        passed.push('ten1010101');
        const totals = callbacks.map((callback) => callback());
        if (totals.join(',') !== '5,4,5,6,7,8,9,10')
            throw new Error('retained iteration ' + totals.join(','));
    `,
        { timeoutMs: 10000, expectedOutput: "" },
    ));

test("a frame callback iterates the list a method lowered after it assigns", async (t) => {
    const source = `
        import { createEngine, createSceneContext, onBeforeRender, startEngine, type SceneContext } from "@babylonjs/lite";
        interface Prepared { name: string; }
        let frames = 0;
        function createOutline(scene: SceneContext) {
            let pending: readonly Prepared[] = [];
            let drawn = 0;
            onBeforeRender(scene, () => {
                for (const prepared of pending) drawn += prepared.name.length;
                frames++;
                if (drawn !== 5 * frames) throw new Error('frame ' + frames + ' drew ' + drawn);
            });
            return {
                select(names: readonly string[]): void {
                    const views: Prepared[] = [];
                    for (const name of names) views.push({ name });
                    pending = views;
                },
            };
        }
        async function main(): Promise<void> {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            createOutline(scene).select(['ab', 'cde']);
            await startEngine(engine);
            if (frames !== 2) throw new Error('frames ' + frames);
        }
        main();
    `;
    // The engine runs two frames when it starts.
    const frameCallbacks: Array<(delta: number) => void> = [];
    await runTranspiled(
        source,
        {
            exports: {},
            require: () => ({
                createEngine: () => Promise.resolve({}),
                createSceneContext: () => ({}),
                onBeforeRender: (
                    _scene: unknown,
                    callback: (delta: number) => void,
                ) => frameCallbacks.push(callback),
                startEngine: () => {
                    for (let frame = 0; frame < 2; frame++)
                        for (const callback of frameCallbacks) callback(16);
                    return Promise.resolve();
                },
            }),
        },
        ts.ModuleKind.CommonJS,
    );
    const { cpp } = compileSource(source);
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        "callback-collection-iteration/frame-callback",
        `
#define main generated_main
${cpp}
#undef main
#include <functional>
#include <vector>
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
static std::vector<js::Callback<void(double)>> frame_callbacks;
static std::vector<std::function<void()>> continuations;
void on_before_render(Scene&, js::Callback<void(double)> callback) {
    frame_callbacks.push_back(callback);
}
void defer_start_continuation(Engine&, std::function<void()> callback) {
    continuations.push_back(std::move(callback));
}
void start_engine(Engine&) {
    for (int frame = 0; frame < 2; ++frame)
        for (auto& callback : frame_callbacks) callback(16.0);
    for (auto& continuation : continuations) continuation();
}
}
int main() { return generated_main(); }
`,
        { timeoutMs: 10000 },
    );
});
