import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { emitUpstreamGenerated } from "../src/upstream-lower.js";
import { runRmlUiFixture } from "./native-fixture.js";

const directory = resolve("artifacts/observer-constructor-values");

test("observer constructor aliases preserve guarded options and projected methods natively", (t) => {
    mkdirSync(directory, { recursive: true });
    const result = compileSource(`
        type ObserverLike = Pick<ResizeObserver, "observe" | "disconnect">;
        type ObserverConstructor = new (callback: ResizeObserverCallback) => ObserverLike;
        interface Options { resizeObserver?: ObserverConstructor | null; }
        const panel = document.createElement("div");
        document.body.appendChild(panel);
        const state = { resizes: 0, mutations: 0 };
        function watch(options: Options = {}): void {
            const Observer = options.resizeObserver === undefined
                ? (typeof ResizeObserver === "undefined" ? null : ResizeObserver)
                : options.resizeObserver;
            const observer = Observer ? new Observer(() => { state.resizes++; }) : null;
            observer?.observe(panel);
            setTimeout(() => { observer?.disconnect(); }, 0);
        }
        watch();
        watch({ resizeObserver: null });
        const constructors = { resize: window.ResizeObserver, mutation: globalThis.MutationObserver };
        watch({ resizeObserver: constructors.resize });
        const Alias = constructors.resize;
        if (typeof Alias !== "function") throw new Error("constructor alias type");
        setTimeout(() => {
            const observer = new constructors.resize(() => { throw new Error("disconnected observer"); });
            observer.observe(panel);
            observer.disconnect();
        }, 0);
        const Mutation = constructors.mutation;
        const observer = new Mutation(() => { state.mutations++; });
        observer.observe(panel, { attributes: true });
        panel.dataset.state = "changed";
        setTimeout(() => {
            if (state.resizes !== 2 || state.mutations !== 1) throw new Error("observer delivery");
            observer.disconnect();
            globalThis.close();
        }, 0);
    `);
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    emitUpstreamGenerated(directory, ["core", "backend:sdl"]);
    runRmlUiFixture(t, "observer-constructor-values", {
        macros: {
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_HAS_PBR_RENDERER: 0,
            BBLITE_HAS_SDL_GPU: 1,
            BBLITE_HAS_DAWN: 0,
        },
        includeDirectories: [join(directory, "upstream/include")],
    });
});

test("observer constructor values require new and refuse dynamic constructor storage", () => {
    assert.throws(
        () =>
            compileSource(
                `const Observer = ResizeObserver; Observer(() => {});`,
            ),
        /does not resolve to a supported Babylon intrinsic or local function declaration/,
    );
    assert.throws(
        () =>
            compileSource(`
            const constructors = [ResizeObserver, MutationObserver];
            const index = document.body.clientWidth > 10 ? 1 : 0;
            const Observer = constructors[index];
            new Observer(() => {});
        `),
        /Unsupported constructor expression/,
    );
    assert.throws(
        () =>
            compileSource(`
            const options = { observer: ResizeObserver };
            if (document.body.clientWidth > 10) options.observer = MutationObserver;
            const Observer = options.observer;
            new Observer(() => {});
        `),
        /Builtin constructor fields require an immutable generation-known binding/,
    );
});

test("a constructor alias selects its Window realm and refuses a worker value read", () => {
    const source = `const Observer = ResizeObserver; const observer = new Observer(() => {}); observer.disconnect(); globalThis.close();`;
    const result = compileSource(source);
    assert.match(result.cpp, /run_window_application/);
    assert.match(result.cpp, /create_resize_observer/);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), source);
    assert.throws(
        () =>
            compileSource(
                `new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});`,
                {
                    fileName: join(directory, "entry.ts"),
                },
            ),
        /Window API requires an application realm/,
    );
});
