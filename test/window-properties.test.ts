import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Window extension callbacks retain identity and captures through replacement and deletion", (t) => {
    const directory = resolve("artifacts/window-properties-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        const target = globalThis as typeof globalThis & {snapshot?: () => number};
        let count = 1;
        const snapshot = () => count;
        target.snapshot = snapshot;
        const stored = target.snapshot;
        if (stored !== snapshot) throw new Error("callback identity");
        count = 2;
        if (stored!() !== 2) throw new Error("retained capture");
        delete target.snapshot;
        if (target.snapshot !== undefined) throw new Error("deleted extension");
        target.snapshot = () => 3;
        if (target.snapshot!() !== 3 || stored!() !== 2) throw new Error("replacement ownership");
        delete target.snapshot;
        const cleanups: Array<() => void> = [];
        const objectTarget = globalThis as typeof globalThis & {objectSnapshot?: () => unknown};
        async function install(value: number) {
            const snapshot = () => ({value});
            objectTarget.objectSnapshot = snapshot;
            cleanups.push(() => {
                if (objectTarget.objectSnapshot === snapshot) delete objectTarget.objectSnapshot;
            });
        }
        await install(4);
        await install(5);
        cleanups[0]!();
        if (objectTarget.objectSnapshot === undefined) throw new Error("old cleanup removed replacement");
        cleanups[1]!();
        if (objectTarget.objectSnapshot !== undefined) throw new Error("owned cleanup retained snapshot");
        globalThis.close();
    `,
        { fileName: resolve(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        result.cpp +
            `
namespace bbl::pal {
int run_window_application(WorkerEntry initialize, EngineOptions) {
    const js::RealmScope scope;
    EventLoop loop;
    WorkerRealm realm(loop);
    loop.run([&] { initialize(realm); });
    return 0;
}
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_UI=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
