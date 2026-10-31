import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("an awaited erased browser promise suspends once and settles to its erased value in the application realm", async (t) => {
    // Erased browser state as an awaited statement, an awaited argument and
    // an async result: each await is one turn against the interleaved ticker.
    const source = `
        const order: string[] = [];
        async function query(): Promise<void> {
            order.push("q0");
            await navigator.storage.estimate();
            order.push("q1");
            console.log(await navigator.wakeLock.request("screen"));
            order.push("q2");
        }
        async function permission(): Promise<PermissionStatus> {
            order.push("p0");
            return await navigator.permissions.query({ name: "geolocation" });
        }
        async function tick(): Promise<void> {
            order.push("t0");
            await null;
            order.push("t1");
            await null;
            order.push("t2");
            await null;
            order.push("t3");
        }
        void (async () => {
            const both = [query(), tick()];
            order.push("caller");
            console.log(await permission());
            order.push("permitted");
            await Promise.all(both);
            if (order.join(",") !== "q0,t0,caller,p0,q1,t1,q2,t2,permitted,t3") throw new Error(order.join(","));
            globalThis.close();
        })();
    `;
    // The erased browser promises settle at once, made in the program's realm.
    let closed = false;
    const context = createContext({ close: () => (closed = true) });
    runInContext(
        `const settled = () => Promise.resolve({});
        globalThis.console = { log() {} };
        globalThis.navigator = { storage: { estimate: settled }, wakeLock: { request: settled }, permissions: { query: settled } };`,
        context,
    );
    runInContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
        context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, true);
    const result = compileSource(source);
    assert.ok(result.manifest.features.includes("platform:workers"));
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "async/erased-browser-awaits",
            result.cpp,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("an erased browser value an awaited declaration binds still suspends once per await in the application realm", async (t) => {
    // The declaration's initializer erases; its awaits still take their
    // turns, so the ticker interleaves as in JavaScript.
    const source = `
        const order: string[] = [];
        async function query(): Promise<void> {
            order.push("q0");
            const estimate = await navigator.storage.estimate();
            order.push("q1");
            const again = await navigator.storage.estimate();
            order.push("q2");
        }
        async function tick(): Promise<void> {
            order.push("t0");
            await null;
            order.push("t1");
            await null;
            order.push("t2");
        }
        void (async () => {
            const both = [query(), tick()];
            order.push("caller");
            await Promise.all(both);
            if (order.join(",") !== "q0,t0,caller,q1,t1,q2,t2") throw new Error(order.join(","));
            globalThis.close();
        })();
    `;
    let closed = false;
    const context = createContext({ close: () => (closed = true) });
    runInContext(
        `globalThis.navigator = { storage: { estimate: () => Promise.resolve({}) } };`,
        context,
    );
    runInContext(
        ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.None,
            },
        }).outputText,
        context,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(closed, true);
    const result = compileSource(source);
    assert.ok(result.manifest.features.includes("platform:workers"));
    const native = optionalNativeFixtureTools(false);
    await t.test("native assertions", { skip: !native }, () => {
        runGeneratedProgram(
            native!,
            "async/erased-awaited-declarations",
            result.cpp,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
});

test("an await under an erased browser-only guard refuses in the application realm", () => {
    // The browser decides whether the guarded branch runs, so how many
    // turns the activation takes is unknown to the native program.
    const source = `
        const order: string[] = [];
        async function query(): Promise<void> {
            order.push("q0");
            if (navigator.storage) {
                await navigator.storage.estimate();
            }
            order.push("q1");
        }
        async function tick(): Promise<void> {
            order.push("t0");
            await null;
            order.push("t1");
        }
        void (async () => {
            await Promise.all([query(), tick()]);
            globalThis.close();
        })();
    `;
    assert.throws(
        () => compileSource(source),
        /An await under a browser-only guard inside an asynchronous function is not supported/,
    );
});

test("an erased awaited declaration and `await null` take the same void suspension", () => {
    const result = compileSource(`
        const order: string[] = [];
        async function query(): Promise<void> {
            order.push("q0");
            const estimate = await navigator.storage.estimate();
            order.push("q1");
        }
        async function tick(): Promise<void> {
            order.push("t0");
            await null;
            order.push("t1");
        }
        void (async () => {
            const both = [query(), tick()];
            order.push("caller");
            await Promise.all(both);
            globalThis.close();
        })();
    `);
    const suspension =
        "= co_await bbl::js::Promise<bbl::js::PromiseVoid>::resolved(bbl::js::PromiseVoid{});";
    assert.equal(result.cpp.split(suspension).length - 1, 2);
    assert.match(
        result.cpp,
        /erased_await_\d+ = co_await bbl::js::Promise<bbl::js::PromiseVoid>/,
    );
});

test("an unread await of a non-thenable takes a void turn in the Window realm", () => {
    // `container.flowGraphRuntimes` is read under its await as the asset's
    // own list, which a promise cannot hold; an await nothing reads (a
    // statement, `void`, a comma's left) still takes its turn. A read of
    // the settled list keeps refusing.
    const source = (statement: string) => `
        import { createEngine, createSceneContext, enableFlowGraphPointerPicking, loadGltf } from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
            const scene = createSceneContext(engine);
            const asset = await loadGltf(engine, "model.glb");
            ${statement}
            await enableFlowGraphPointerPicking(scene);
        }
        void main();
        new MutationObserver(() => {}).disconnect();
    `;
    for (const statement of [
        "await asset.flowGraphRuntimes;",
        "void await asset.flowGraphRuntimes;",
        "await asset.flowGraphRuntimes, 0;",
    ]) {
        const result = compileSource(source(statement));
        assert.match(result.cpp, /run_window_application/);
        assert.match(
            result.cpp,
            /load_realm_gltf\([^\n]*\n[^\n]*\n[^\n]*= co_await bbl::js::Promise<bbl::js::PromiseVoid>::resolved\(bbl::js::PromiseVoid\{\}\);/,
        );
    }
    assert.throws(
        () =>
            compileSource(
                source(
                    "const runtimes = await asset.flowGraphRuntimes; console.log(runtimes.length);",
                ),
            ),
        /Promise result 'handle-collection' has no owned asynchronous representation/,
    );
});
